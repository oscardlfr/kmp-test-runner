param(
  [string]$ProfilePath = '',
  [string]$InputLockPath = '',
  [string]$GuestCredentialPath = '',
  [string]$CreatedInspectionReceiptPath = '',
  [string]$ReceiptPath = '',
  [ValidateRange(900, 6000)] [int]$TimeoutSeconds = 5400,
  [switch]$RecoveryOnly,
  [ValidateSet('', 'elevated_runner_child_timeout', 'elevated_runner_child_failure')]
  [string]$RecoveryReasonCode = '',
  [string]$AuthorizationPhrase = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ProfilePath)) {
  $ProfilePath = Join-Path $scriptRoot 'evidence1-windows-hyperv-e2e-v1.json'
}
Import-Module (Join-Path $scriptRoot 'Evidence1.Provisioning.psm1') -Force

$RequiredProfileId = 'evidence1-windows-hyperv-e2e-v1'

function Fail([string]$Code) { Write-Error "HARD STOP: $Code"; exit 1 }

function ConvertFrom-E1OfflineSecureString([Security.SecureString]$SecureValue) {
  $pointer = [IntPtr]::Zero
  try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  }
}

function ConvertTo-E1OfflineHiddenPassword([string]$Password) {
  return [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Password + 'Password'))
}

function Assert-E1OfflineDeadline([DateTime]$DeadlineUtc) {
  if ([DateTime]::UtcNow -ge $DeadlineUtc) { throw 'offline_apply_deadline_exceeded' }
}

function Assert-E1OfflineApplyAuthorization([string]$Candidate) {
  if ($Candidate -cne 'authorize exactly one evidence1 e2e windows offline apply') {
    throw 'exact_offline_apply_authorization_required'
  }
}

function Quote-E1OfflineNativeArgument([string]$Value) {
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Get-E1OfflineNativeStreamIdentity([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return [ordered]@{ sha256 = $null; bytes = 0 }
  }
  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
  return [ordered]@{ sha256 = $hash; bytes = [int64]$item.Length }
}

function Get-E1OfflineNativeTextIdentity([string]$Text) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $digest = $algorithm.ComputeHash($bytes) } finally { $algorithm.Dispose() }
  return [ordered]@{
    sha256 = ([BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant()
    bytes = [int64]$bytes.Length
  }
}

function Get-E1OfflineSanitizedFailureLines([string]$Text) {
  return @(
    ($Text -split "`r?`n") |
      Where-Object {
        $_ -match '(?i)(error|fail|invalid|not supported|not recognized|0x[0-9a-f]+)' -and
        $_ -notmatch '(?i)(password|credential|token|secret|product.?key|defaultpassword)'
      } |
      ForEach-Object {
        $line = ([string]$_) -replace '[A-Za-z]:\\[^\r\n]*', '[REDACTED_PATH]'
        if ($line.Length -gt 500) { $line = $line.Substring(0, 500) + '[TRUNCATED]' }
        $line
      } |
      Select-Object -Last 20
  )
}

function Invoke-E1OfflineBoundedNativeCommand(
  [string]$Executable,
  [string[]]$Arguments,
  [DateTime]$DeadlineUtc,
  [string]$WorkingDirectory,
  [string]$LogRoot,
  [string]$FailureCode,
  [switch]$CaptureStdoutText,
  [switch]$CaptureFailureDiagnostic
) {
  Assert-E1OfflineDeadline $DeadlineUtc
  $remainingMs = [Math]::Floor(($DeadlineUtc - [DateTime]::UtcNow).TotalMilliseconds)
  if ($remainingMs -lt 1) { throw 'offline_apply_deadline_exceeded' }
  $process = $null
  try {
    $argumentLine = (@($Arguments) | ForEach-Object { Quote-E1OfflineNativeArgument ([string]$_) }) -join ' '
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.Arguments = $argumentLine
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw $FailureCode }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    while (-not $process.HasExited) {
      if ([DateTime]::UtcNow -ge $DeadlineUtc) {
        try { $process.Kill() } catch { }
        throw 'offline_apply_deadline_exceeded'
      }
      Start-Sleep -Milliseconds 500
      $process.Refresh()
    }
    $process.WaitForExit()
    $process.Refresh()
    $nativeExitCode = [int]$process.ExitCode
    $stdoutText = [string]$stdoutTask.Result
    $stderrText = [string]$stderrTask.Result
    $stdoutIdentity = Get-E1OfflineNativeTextIdentity $stdoutText
    $stderrIdentity = Get-E1OfflineNativeTextIdentity $stderrText
    if ($stdoutIdentity.bytes -gt 1MB -or $stderrIdentity.bytes -gt 1MB) { throw 'native_output_too_large' }
    if ($nativeExitCode -ne 0) {
      $script:E1OfflineNativeFailure = [ordered]@{
        exit_code = $nativeExitCode
        stdout_sha256 = [string]$stdoutIdentity.sha256; stdout_bytes = [int64]$stdoutIdentity.bytes
        stderr_sha256 = [string]$stderrIdentity.sha256; stderr_bytes = [int64]$stderrIdentity.bytes
      }
      if ($CaptureFailureDiagnostic) {
        $script:E1OfflineNativeFailure.diagnostic_lines = @(
          Get-E1OfflineSanitizedFailureLines ($stdoutText + "`n" + $stderrText)
        )
      }
      $exception = [InvalidOperationException]::new($FailureCode)
      foreach ($entry in $script:E1OfflineNativeFailure.GetEnumerator()) {
        $exception.Data[$entry.Key] = $entry.Value
      }
      throw $exception
    }
    $result = [ordered]@{ exit_code = $nativeExitCode }
    if ($CaptureStdoutText) {
      $result.stdout_text = $stdoutText
    }
    return $result
  } finally {
    if ($process) { $process.Dispose() }
  }
}

function New-E1OfflineApplyUnattendXml($Profile, [string]$HiddenPassword) {
  $computerName = [Security.SecurityElement]::Escape([string]$Profile.guest.computer_name)
  $localUser = [Security.SecurityElement]::Escape([string]$Profile.guest.local_user)
  return @"
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <ComputerName>$computerName</ComputerName>
      <TimeZone>Romance Standard Time</TimeZone>
      <RegisteredOwner>Evidence1</RegisteredOwner>
      <RegisteredOrganization>Evidence1</RegisteredOrganization>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <InputLocale>0809:00000809</InputLocale>
      <SystemLocale>en-GB</SystemLocale>
      <UILanguage>en-GB</UILanguage>
      <UserLocale>en-GB</UserLocale>
    </component>
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <ProtectYourPC>3</ProtectYourPC>
      </OOBE>
      <AutoLogon>
        <Password><Value>$HiddenPassword</Value><PlainText>false</PlainText></Password>
        <Domain>$computerName</Domain><Enabled>true</Enabled><LogonCount>1</LogonCount><Username>$localUser</Username>
      </AutoLogon>
      <FirstLogonCommands><SynchronousCommand wcm:action="add">
        <Order>1</Order><Description>Prevent a second automatic logon and attest completion</Description>
        <CommandLine>cmd.exe /c reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoLogonCount /t REG_DWORD /d 0 /f &amp;&amp; mkdir C:\ProgramData\Evidence1 2&gt;nul &amp;&amp; type nul &gt; C:\ProgramData\Evidence1\offline-apply-complete.marker</CommandLine>
        <RequiresUserInput>false</RequiresUserInput>
      </SynchronousCommand></FirstLogonCommands>
    </component>
  </settings>
</unattend>
"@
}

function New-E1OfflineServicingAccountUnattendXml($Profile, [string]$HiddenPassword) {
  $localUser = [Security.SecurityElement]::Escape([string]$Profile.guest.local_user)
  return @"
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="offlineServicing">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <OfflineUserAccounts>
        <OfflineLocalAccounts>
          <LocalAccount wcm:action="add">
            <Password><Value>$HiddenPassword</Value><PlainText>false</PlainText></Password>
            <Description>Evidence1 isolated evaluation administrator</Description>
            <DisplayName>$localUser</DisplayName><Group>Administrators</Group><Name>$localUser</Name>
          </LocalAccount>
        </OfflineLocalAccounts>
      </OfflineUserAccounts>
    </component>
  </settings>
</unattend>
"@
}

function Get-E1OfflineDiskLayout([int64]$DiskBytes) {
  $efi = 300MB
  $msr = 16MB
  $recovery = 1024MB
  $alignmentReserve = 8MB
  $windows = $DiskBytes - $efi - $msr - $recovery - $alignmentReserve
  if ($windows -lt 64GB) { throw 'vm_disk_too_small_for_partition_contract' }
  return [ordered]@{
    style = 'GPT'
    efi = [ordered]@{ size_bytes = [int64]$efi; gpt_type = '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}'; filesystem = 'FAT32'; label = 'System' }
    msr = [ordered]@{ size_bytes = [int64]$msr; gpt_type = '{e3c9e316-0b5c-4db8-817d-f92df00215ae}'; filesystem = $null; label = $null }
    windows = [ordered]@{ size_bytes = [int64]$windows; gpt_type = '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}'; filesystem = 'NTFS'; label = 'Windows' }
    recovery = [ordered]@{ size_bytes = [int64]$recovery; gpt_type = '{de94bba4-06d1-4d40-a16a-bfd50179d6ac}'; filesystem = 'NTFS'; label = 'Recovery' }
  }
}

function Initialize-E1OfflineWindowsDisk($Disk, $Layout, [string]$MountRoot) {
  Initialize-Disk -Number $Disk.Number -PartitionStyle GPT -ErrorAction Stop | Out-Null
  $efi = New-Partition -DiskNumber $Disk.Number -Size $Layout.efi.size_bytes -GptType $Layout.efi.gpt_type -ErrorAction Stop
  $msr = New-Partition -DiskNumber $Disk.Number -Size $Layout.msr.size_bytes -GptType $Layout.msr.gpt_type -ErrorAction Stop
  $windows = New-Partition -DiskNumber $Disk.Number -Size $Layout.windows.size_bytes -GptType $Layout.windows.gpt_type -ErrorAction Stop
  $recovery = New-Partition -DiskNumber $Disk.Number -UseMaximumSize -GptType $Layout.recovery.gpt_type -ErrorAction Stop
  $efi | Format-Volume -FileSystem FAT32 -NewFileSystemLabel System -Confirm:$false -Force -ErrorAction Stop | Out-Null
  $windows | Format-Volume -FileSystem NTFS -NewFileSystemLabel Windows -Confirm:$false -Force -ErrorAction Stop | Out-Null
  $recovery | Format-Volume -FileSystem NTFS -NewFileSystemLabel Recovery -Confirm:$false -Force -ErrorAction Stop | Out-Null
  $paths = [ordered]@{
    efi = Join-Path $MountRoot 'efi'
    windows = Join-Path $MountRoot 'windows'
    recovery = Join-Path $MountRoot 'recovery'
  }
  New-Item -ItemType Directory -Force -Path $paths.efi,$paths.windows,$paths.recovery | Out-Null
  Add-PartitionAccessPath -DiskNumber $Disk.Number -PartitionNumber $efi.PartitionNumber -AccessPath ($paths.efi + '\') -ErrorAction Stop
  Add-PartitionAccessPath -DiskNumber $Disk.Number -PartitionNumber $windows.PartitionNumber -AccessPath ($paths.windows + '\') -ErrorAction Stop
  Add-PartitionAccessPath -DiskNumber $Disk.Number -PartitionNumber $recovery.PartitionNumber -AccessPath ($paths.recovery + '\') -ErrorAction Stop
  return [ordered]@{
    efi = $paths.efi; windows = $paths.windows; recovery = $paths.recovery
    msr_partition_number = $msr.PartitionNumber; recovery_partition_number = $recovery.PartitionNumber
  }
}

function Invoke-E1OfflineDiskInitialization($Disk, $Layout, [string]$MountRoot) {
  try {
    return Initialize-E1OfflineWindowsDisk $Disk $Layout $MountRoot
  } catch {
    throw [InvalidOperationException]::new('offline_partition_layout_failed', $_.Exception)
  }
}

function Set-E1OfflineRecoveryGptAttributes([int]$DiskNumber, [int]$PartitionNumber,
    [string]$AccessPath, [DateTime]$DeadlineUtc, [string]$LogRoot) {
  Remove-PartitionAccessPath -DiskNumber $DiskNumber -PartitionNumber $PartitionNumber `
    -AccessPath $AccessPath -ErrorAction Stop
  $scriptPath = Join-Path $LogRoot ('.diskpart-' + [guid]::NewGuid().ToString('N') + '.txt')
  try {
    [IO.File]::WriteAllLines($scriptPath, @(
      "select disk $DiskNumber",
      "select partition $PartitionNumber",
      'remove all',
      'gpt attributes=0x8000000000000001',
      'detail partition',
      'exit'
    ), [Text.Encoding]::ASCII)
    $result = Invoke-E1OfflineBoundedNativeCommand 'diskpart.exe' @('/s', $scriptPath) `
      $DeadlineUtc $LogRoot $LogRoot 'recovery_gpt_attributes_set_failed' -CaptureStdoutText
    $rawAttributesMatch = [regex]::Match([string]$result.stdout_text, '(?i)\b0x8000000000000001\b')
    if (-not $rawAttributesMatch.Success) {
      throw 'recovery_gpt_attributes_mismatch'
    }
    try { Update-HostStorageCache -ErrorAction SilentlyContinue } catch { }
    $partition = Get-Partition -DiskNumber $DiskNumber -PartitionNumber $PartitionNumber -ErrorAction Stop
    $accessPaths = @($partition.AccessPaths | ForEach-Object { [string]$_ } | Where-Object {
      -not [string]::IsNullOrWhiteSpace($_)
    })
    $volumeGuidAccessPaths = @($accessPaths | Where-Object {
      $_ -cmatch '^\\\\\?\\Volume\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}\\$'
    })
    $unexpectedAccessPaths = @($accessPaths | Where-Object {
      $_ -cnotmatch '^\\\\\?\\Volume\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}\\$'
    })
    $driveLetterText = if ($partition.PSObject.Properties.Name -contains 'DriveLetter') {
      [string]$partition.DriveLetter
    } else { '' }
    # MSFT_Partition exposes an absent DriveLetter as Char16 NUL on real Windows hosts.
    # Casting that value to string produces a one-character, non-whitespace string, so a
    # null/whitespace check alone falsely reports a drive letter. DiskPart's exact raw GPT
    # attribute readback above is authoritative for bit 63 because the Storage provider's
    # NoDefaultDriveLetter projection is also false on valid Windows recovery partitions.
    $driveLetterPresent = -not [string]::IsNullOrEmpty($driveLetterText) -and
      -not ($driveLetterText.Length -eq 1 -and [int][char]$driveLetterText[0] -eq 0)
    $noDefaultDriveLetter = $rawAttributesMatch.Success
    $script:E1OfflineRecoveryPartitionReadback = [ordered]@{
      gpt_type_matches = [string]$partition.GptType -ceq '{de94bba4-06d1-4d40-a16a-bfd50179d6ac}'
      hidden = [bool]$partition.IsHidden
      no_default_drive_letter = [bool]$noDefaultDriveLetter
      drive_letter_present = [bool]$driveLetterPresent
      access_path_count = $accessPaths.Count
      volume_guid_access_path_count = $volumeGuidAccessPaths.Count
      unexpected_access_path_count = $unexpectedAccessPaths.Count
    }
    if (-not $script:E1OfflineRecoveryPartitionReadback.gpt_type_matches -or
        -not $script:E1OfflineRecoveryPartitionReadback.hidden -or
        -not $script:E1OfflineRecoveryPartitionReadback.no_default_drive_letter -or
        $script:E1OfflineRecoveryPartitionReadback.drive_letter_present -or
        $script:E1OfflineRecoveryPartitionReadback.unexpected_access_path_count -ne 0) {
      throw 'recovery_gpt_attributes_mismatch'
    }
    return [ordered]@{
      attributes_hex = '0x8000000000000001'; hidden = $true; required = $true
      no_default_drive_letter = $true
      volume_guid_access_path_count = $volumeGuidAccessPaths.Count
      unexpected_access_path_count = $unexpectedAccessPaths.Count
    }
  } finally {
    Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-E1DismGetImageInfo([string]$DismPath, [string]$ImagePath, [int]$ImageIndex,
    $ExpectedImage, [DateTime]$DeadlineUtc, [string]$LogRoot) {
  $result = Invoke-E1OfflineBoundedNativeCommand $DismPath @(
    '/English', '/Get-ImageInfo', "/ImageFile:$ImagePath", "/Index:$ImageIndex"
  ) $DeadlineUtc (Split-Path -Parent $DismPath) $LogRoot 'dism_image_info_failed' -CaptureStdoutText
  return ConvertFrom-E1DismImageInfo ([string]$result.stdout_text) $ExpectedImage
}

function Invoke-E1DismApplyImage([string]$DismPath, [string]$ImagePath, [int]$ImageIndex, [string]$ApplyPath,
    [DateTime]$DeadlineUtc, [string]$LogRoot) {
  return Invoke-E1OfflineBoundedNativeCommand $DismPath @(
    '/English', '/Apply-Image', "/ImageFile:$ImagePath", "/Index:$ImageIndex", "/ApplyDir:$($ApplyPath.TrimEnd('\'))\",
    '/CheckIntegrity', '/Verify'
  ) $DeadlineUtc (Split-Path -Parent $DismPath) $LogRoot 'dism_apply_image_failed'
}

function Invoke-E1DismApplyUnattend([string]$DismPath, [string]$ImageRoot, [string]$AnswerPath,
    [DateTime]$DeadlineUtc, [string]$LogRoot) {
  return Invoke-E1OfflineBoundedNativeCommand $DismPath @(
    '/English', "/Image:$($ImageRoot.TrimEnd('\'))\", "/Apply-Unattend:$AnswerPath"
  ) $DeadlineUtc (Split-Path -Parent $DismPath) $LogRoot 'dism_apply_unattend_failed' -CaptureFailureDiagnostic
}

function Invoke-E1BcdBootFromAppliedImage([string]$WindowsPath, [string]$EfiPath,
    [DateTime]$DeadlineUtc, [string]$LogRoot) {
  $bcdBoot = Join-Path $WindowsPath 'Windows\System32\bcdboot.exe'
  if (-not (Test-Path -LiteralPath $bcdBoot -PathType Leaf)) { throw 'applied_bcdboot_missing' }
  return Invoke-E1OfflineBoundedNativeCommand $bcdBoot @(
    (Join-Path $WindowsPath 'Windows'), '/s', $EfiPath, '/f', 'UEFI'
  ) $DeadlineUtc $LogRoot $LogRoot 'bcdboot_failed'
}

function Invoke-E1ConfigureOfflineRecovery([string]$WindowsPath, [string]$RecoveryPath,
    [DateTime]$DeadlineUtc, [string]$LogRoot) {
  $reagentc = Join-Path $env:WINDIR 'System32\reagentc.exe'
  if (-not (Test-Path -LiteralPath $reagentc -PathType Leaf)) { throw 'host_reagentc_missing' }
  return Invoke-E1OfflineBoundedNativeCommand $reagentc @(
    '/Setreimage', '/Path', (Join-Path $RecoveryPath 'Recovery\WindowsRE'),
    '/Target', (Join-Path $WindowsPath 'Windows')
  ) $DeadlineUtc $LogRoot $LogRoot 'reagentc_setreimage_failed'
}

function Write-E1OfflineApplyMarkerAtomically([string]$Path, $Value) {
  $parent = Split-Path -Parent ([IO.Path]::GetFullPath($Path))
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 8))
  $stream = $null
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } catch [IO.IOException] {
    throw 'offline_apply_authorization_already_consumed'
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}

function Assert-E1OfflineApplyMarker($Marker, [string]$ExpectedProfileSha,
    [string]$ExpectedInputLockSha, [string]$ExpectedInspectionSha,
    [string]$ExpectedCredentialSha, [string]$ExpectedVmId, [DateTime]$NowUtc) {
  $required = @('schema','profile_id','vm_id','profile_sha256','input_lock_sha256',
    'created_inspection_receipt_sha256','guest_credential_sha256','consumed_at_utc','authorized_start_count')
  $actual = @($Marker.PSObject.Properties.Name)
  if ($actual.Count -ne $required.Count -or @($actual | Where-Object { $_ -cnotin $required }).Count -ne 0 -or
      -not (Test-E1StrictJsonInteger $Marker.schema 1) -or
      -not (Test-E1StrictJsonInteger $Marker.authorized_start_count 1) -or
      $Marker.profile_id -isnot [string] -or $Marker.profile_id -cne $RequiredProfileId -or
      $Marker.vm_id -isnot [string] -or ([string]$Marker.vm_id).ToLowerInvariant() -cne $ExpectedVmId.ToLowerInvariant() -or
      $Marker.profile_sha256 -isnot [string] -or $Marker.profile_sha256 -cne $ExpectedProfileSha -or
      $Marker.input_lock_sha256 -isnot [string] -or $Marker.input_lock_sha256 -cne $ExpectedInputLockSha -or
      $Marker.created_inspection_receipt_sha256 -isnot [string] -or $Marker.created_inspection_receipt_sha256 -cne $ExpectedInspectionSha -or
      $Marker.guest_credential_sha256 -isnot [string] -or $Marker.guest_credential_sha256 -cne $ExpectedCredentialSha -or
      $Marker.consumed_at_utc -isnot [string] -or [string]$Marker.consumed_at_utc -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') {
    throw 'offline_apply_marker_binding_mismatch'
  }
  try { $consumed = [DateTime]::Parse([string]$Marker.consumed_at_utc).ToUniversalTime() }
  catch { throw 'offline_apply_marker_time_invalid' }
  if ($consumed -gt $NowUtc.AddMinutes(1)) { throw 'offline_apply_marker_time_invalid' }
}

function Assert-E1CreatedInspectionReceipt($Receipt, [string]$ExpectedProfileSha,
    [string]$ExpectedInputLockSha, [string]$ExpectedVmId, [DateTime]$NowUtc,
    [bool]$RequireFresh) {
  if (-not (Test-E1StrictJsonInteger $Receipt.schema 1) -or
      $Receipt.verdict -isnot [string] -or $Receipt.verdict -cne 'PASS' -or
      $Receipt.mode -isnot [string] -or $Receipt.mode -cne 'InspectCreated' -or
      $Receipt.profile_id -isnot [string] -or $Receipt.profile_id -cne 'evidence1-windows-hyperv-e2e-v1' -or
      $Receipt.profile_sha256 -isnot [string] -or $Receipt.profile_sha256 -cne $ExpectedProfileSha -or
      $Receipt.input_lock_sha256 -isnot [string] -or $Receipt.input_lock_sha256 -cne $ExpectedInputLockSha -or
      $Receipt.vm_id -isnot [string] -or $Receipt.vm_id -cnotmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$' -or
      ([string]$Receipt.vm_id).ToLowerInvariant() -cne $ExpectedVmId.ToLowerInvariant() -or
      $Receipt.vm_state -isnot [string] -or $Receipt.vm_state -cne 'Off' -or
      $Receipt.vhd_partition_style -isnot [string] -or $Receipt.vhd_partition_style -cne 'RAW' -or
      $Receipt.network_state -isnot [string] -or $Receipt.network_state -cne 'disconnected' -or
      $Receipt.original_iso_is_only_dvd -isnot [bool] -or $Receipt.original_iso_is_only_dvd -ne $true -or
      $Receipt.generated_at_utc -isnot [string] -or
      [string]$Receipt.generated_at_utc -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' -or
      $Receipt.drift_fields -isnot [array] -or @($Receipt.drift_fields).Count -ne 0 -or
      $Receipt.mutation_performed -isnot [bool] -or $Receipt.mutation_performed -ne $false -or
      -not (Test-E1StrictJsonInteger $Receipt.inference_sessions_consumed 0)) {
    throw 'created_inspection_receipt_binding_mismatch'
  }
  try { $generated = [DateTime]::Parse([string]$Receipt.generated_at_utc).ToUniversalTime() }
  catch { throw 'created_inspection_receipt_time_invalid' }
  if ($generated -gt $NowUtc.AddMinutes(1)) { throw 'created_inspection_receipt_time_invalid' }
  if ($RequireFresh -and $generated -lt $NowUtc.AddMinutes(-15)) { throw 'created_inspection_receipt_stale' }
}

function Assert-E1OfflineVmTopology($VM, $Profile, $Plan, [string]$ExpectedVmId,
    [bool]$RequireOff, [bool]$RequireDetached) {
  if (([string]$VM.Id).ToLowerInvariant() -cne $ExpectedVmId.ToLowerInvariant() -or
      [string]$VM.Name -cne [string]$Profile.vm.name) { throw 'vm_identity_contract_invalid' }
  if ($RequireOff -and [string]$VM.State -cne 'Off') { throw 'vm_must_be_off' }
  if ([int]$VM.Generation -ne [int]$Profile.vm.generation) { throw 'vm_generation_contract_invalid' }
  $processor = Get-VMProcessor -VM $VM -ErrorAction Stop
  if ([int]$processor.Count -ne [int]$Profile.vm.processor_count) { throw 'vm_processor_contract_invalid' }
  $memory = Get-VMMemory -VM $VM -ErrorAction Stop
  if ([int64]$VM.MemoryStartup -ne [int64]$Profile.vm.startup_memory_bytes -or
      [bool]$memory.DynamicMemoryEnabled -ne [bool]$Profile.vm.dynamic_memory) { throw 'vm_memory_contract_invalid' }
  if ([bool]$VM.AutomaticCheckpointsEnabled -ne [bool]$Profile.vm.automatic_checkpoints -or
      [string]$VM.CheckpointType -cne [string]$Profile.vm.checkpoint_type -or
      @((Get-VMSnapshot -VM $VM -ErrorAction Stop)).Count -ne 0) { throw 'vm_checkpoint_contract_invalid' }
  $firmware = Get-VMFirmware -VM $VM -ErrorAction Stop
  if ([string]$firmware.SecureBoot -cne 'On' -or
      [string]$firmware.SecureBootTemplate -cne [string]$Profile.vm.secure_boot_template) {
    throw 'vm_firmware_contract_invalid'
  }
  $security = Get-VMSecurity -VM $VM -ErrorAction Stop
  if ([bool]$Profile.vm.v_tpm -and -not [bool]$security.TpmEnabled) { throw 'vm_security_contract_invalid' }
  $vmRoot = Join-Path ([IO.Path]::GetFullPath([string]$Profile.vm.root)) ([string]$Profile.vm.name)
  $vhdPath = Join-Path $vmRoot "$($Profile.vm.name).vhdx"
  $hardDisks = @(Get-VMHardDiskDrive -VM $VM -ErrorAction Stop)
  if ($hardDisks.Count -ne 1 -or
      [IO.Path]::GetFullPath([string]$hardDisks[0].Path) -cne [IO.Path]::GetFullPath($vhdPath)) {
    throw 'vm_vhd_contract_invalid'
  }
  $vhd = Get-VHD -Path $vhdPath -ErrorAction Stop
  if ([string]$vhd.VhdType -cne 'Dynamic' -or [int64]$vhd.Size -ne [int64]$Profile.vm.vhd_size_bytes -or
      ($RequireDetached -and [bool]$vhd.Attached)) { throw 'vm_vhd_contract_invalid' }
  $expectedIso = Join-Path (Join-Path $vmRoot 'media') 'windows.iso'
  $dvd = @(Get-VMDvdDrive -VM $VM -ErrorAction Stop)
  if ($dvd.Count -ne 1 -or -not $dvd[0].Path -or
      [IO.Path]::GetFullPath([string]$dvd[0].Path) -cne [IO.Path]::GetFullPath($expectedIso)) {
    throw 'original_iso_dvd_contract_invalid'
  }
  Get-E1FileIdentity $expectedIso $Plan.iso.sha256 ([int64]$Plan.iso.bytes) 'sealed_iso' | Out-Null
  $network = @(Get-VMNetworkAdapter -VM $VM -ErrorAction Stop)
  if ($network.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace([string]$network[0].SwitchName)) {
    throw 'network_must_be_disconnected'
  }
  return [ordered]@{ vm_root = $vmRoot; vhd_path = $vhdPath; iso_path = $expectedIso }
}

function Get-E1OfflineAnswerCacheFiles([string]$WindowsRoot) {
  $roots = @(
    (Join-Path $WindowsRoot 'Windows\Panther'),
    (Join-Path $WindowsRoot 'Windows\System32\Sysprep'),
    (Join-Path $WindowsRoot '$Windows.~BT\Sources\Panther')
  )
  $matches = @()
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
    $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'offline_answer_cache_reparse_point' }
    $items = @(Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction Stop)
    if ($items.Count -gt 8192) { throw 'offline_answer_cache_bounds_exceeded' }
    if (@($items | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) {
      throw 'offline_answer_cache_reparse_point'
    }
    $matches += @($items | Where-Object { -not $_.PSIsContainer -and $_.Name -like '*unattend*.xml' })
    if ($matches.Count -gt 128) { throw 'offline_answer_cache_bounds_exceeded' }
  }
  return $matches
}

function Remove-E1OfflineAnswerCacheFiles([string]$WindowsRoot) {
  foreach ($candidate in @(Get-E1OfflineAnswerCacheFiles $WindowsRoot)) {
    Remove-Item -LiteralPath $candidate.FullName -Force -ErrorAction Stop
  }
  if (@(Get-E1OfflineAnswerCacheFiles $WindowsRoot).Count -ne 0) { throw 'offline_answer_file_cleanup_failed' }
}

function Wait-E1OfflineVmOff([string]$VmId, [DateTime]$DeadlineUtc) {
  while ($true) {
    $current = Get-VM -Id $VmId -ErrorAction Stop
    if ([string]$current.State -ceq 'Off') { return $current }
    if ([DateTime]::UtcNow -ge $DeadlineUtc) { throw 'recovery_vm_stop_timeout' }
    Start-Sleep -Milliseconds 250
  }
}

function Stop-E1OfflineApplyVmBounded($VM, [int]$Seconds = 30) {
  if ([string]$VM.State -ceq 'Off') { return $VM }
  $deadlineUtc = [DateTime]::UtcNow.AddSeconds($Seconds)
  $job = Start-Job -ScriptBlock { param($Name) Stop-VM -Name $Name -TurnOff -Force -ErrorAction Stop } -ArgumentList ([string]$VM.Name)
  try {
    $waitSeconds = [Math]::Max(1, [int][Math]::Ceiling(($deadlineUtc - [DateTime]::UtcNow).TotalSeconds))
    if (-not (Wait-Job -Job $job -Timeout $waitSeconds)) {
      Stop-Job -Job $job -ErrorAction SilentlyContinue
      throw 'recovery_vm_stop_timeout'
    }
    Receive-Job -Job $job -ErrorAction Stop | Out-Null
  } finally { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
  return Wait-E1OfflineVmOff ([string]$VM.Id) $deadlineUtc
}

function Get-E1OfflineRecoveryVm($Profile, [string]$ExpectedVmId) {
  $expectedId = $ExpectedVmId.ToLowerInvariant()
  try {
    $registered = Get-VM -Id $ExpectedVmId -ErrorAction Stop
    if ([string]$registered.Name -cne [string]$Profile.vm.name -or
        ([string]$registered.Id).ToLowerInvariant() -cne $expectedId) {
      throw 'recovery_vm_registration_identity_mismatch'
    }
    return [ordered]@{ vm = $registered; registration_repaired = $false }
  } catch {
    if ([string]$_.Exception.Message -ceq 'recovery_vm_registration_identity_mismatch') { throw }
  }

  $vmDirectory = Join-Path ([IO.Path]::GetFullPath([string]$Profile.vm.root)) ([string]$Profile.vm.name)
  $configurationPath = Join-Path (Join-Path (Join-Path $vmDirectory ([string]$Profile.vm.name)) 'Virtual Machines') `
    ($expectedId + '.vmcx')
  if (-not (Test-Path -LiteralPath $configurationPath -PathType Leaf)) {
    throw 'recovery_vm_configuration_missing'
  }
  $configuration = Get-Item -LiteralPath $configurationPath -Force -ErrorAction Stop
  if (($configuration.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'recovery_vm_configuration_reparse_point'
  }
  try {
    $null = Import-VM -Path $configurationPath -Register -ErrorAction Stop
    $registered = Get-VM -Id $ExpectedVmId -ErrorAction Stop
  } catch {
    throw 'recovery_vm_registration_failed'
  }
  if ([string]$registered.Name -cne [string]$Profile.vm.name -or
      ([string]$registered.Id).ToLowerInvariant() -cne $expectedId) {
    throw 'recovery_vm_registration_identity_mismatch'
  }
  return [ordered]@{ vm = $registered; registration_repaired = $true }
}

function Clear-E1OfflineAnswerState([string]$WindowsRoot, [DateTime]$DeadlineUtc, [string]$LogRoot) {
  Remove-E1OfflineAnswerCacheFiles $WindowsRoot
  $hive = Join-Path $WindowsRoot 'Windows\System32\Config\SOFTWARE'
  if (-not (Test-Path -LiteralPath $hive -PathType Leaf)) {
    throw 'offline_registry_hive_missing'
  }
  $legacyHiveName = 'E1OfflineRecovery'
  if (Test-Path -LiteralPath "Registry::HKEY_LOCAL_MACHINE\$legacyHiveName") {
    $null = Invoke-E1OfflineBoundedNativeCommand 'reg.exe' @('unload', "HKLM\$legacyHiveName") `
      $DeadlineUtc $LogRoot $LogRoot 'offline_registry_unload_failed'
  }
  $hiveName = 'E1OfflineRecovery-' + [guid]::NewGuid().ToString('N')
  $null = Invoke-E1OfflineBoundedNativeCommand 'reg.exe' @('load', "HKLM\$hiveName", $hive) $DeadlineUtc $LogRoot $LogRoot 'offline_registry_load_failed'
  try {
    $key = "Registry::HKEY_LOCAL_MACHINE\$hiveName\Microsoft\Windows NT\CurrentVersion\Winlogon"
    foreach ($name in @('DefaultPassword','DefaultUserName','DefaultDomainName','AutoAdminLogon','AutoLogonCount')) {
      Remove-ItemProperty -LiteralPath $key -Name $name -Force -ErrorAction SilentlyContinue
    }
    $remaining = @('DefaultPassword','DefaultUserName','DefaultDomainName','AutoAdminLogon','AutoLogonCount' | Where-Object {
      $null -ne (Get-ItemProperty -LiteralPath $key -Name $_ -ErrorAction SilentlyContinue)
    })
    if ($remaining.Count -ne 0) { throw 'offline_registry_cleanup_failed' }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
  } finally {
    try {
      $null = Invoke-E1OfflineBoundedNativeCommand 'reg.exe' @('unload', "HKLM\$hiveName") $DeadlineUtc $LogRoot $LogRoot 'offline_registry_unload_failed'
    } catch {
      throw
    }
  }
  return [ordered]@{ answer_files_absent = $true; autologon_values_absent = $true }
}

function Invoke-E1OfflineApplyRecovery([string]$RequestedProfilePath, [string]$RequestedInputLockPath,
    [string]$RequestedCredentialPath, [string]$RequestedInspectionPath,
    [string]$RequestedReceiptPath, [string]$ReasonCode) {
  Assert-E1Administrator
  Import-Module Hyper-V -ErrorAction Stop
  $plan = Get-E1ProvisioningPlan $RequestedProfilePath $RequestedInputLockPath `
    -SkipHostDependencyFileIdentity -AllowSealedRuntimeCommitDrift
  $profile = $plan.profile
  if ([string]$profile.profile_id -cne $RequiredProfileId -or
      [string]$profile.os.installation_boundary -cne 'offline-apply') { throw 'offline_apply_profile_not_allowed' }
  $profileSha = Get-E1Sha256 $RequestedProfilePath
  $inputLockSha = Get-E1Sha256 $RequestedInputLockPath
  $inspection = Read-E1LockedJsonSnapshot $RequestedInspectionPath 'created_inspection_receipt'
  $inspectedVmId = [string]$inspection.document.vm_id
  if (-not (Test-Path -LiteralPath $RequestedCredentialPath -PathType Leaf)) { throw 'guest_credential_missing' }
  $credentialSha = Get-E1Sha256 $RequestedCredentialPath
  $credential = Import-Clixml -LiteralPath $RequestedCredentialPath
  if ($credential -isnot [pscredential] -or [string]$credential.UserName -cne [string]$profile.guest.local_user -or
      (Get-E1Sha256 $RequestedCredentialPath) -cne $credentialSha) { throw 'guest_credential_invalid' }
  $vmRoot = Join-Path ([IO.Path]::GetFullPath([string]$profile.vm.root)) $profile.vm.name
  $markerPath = Join-Path $vmRoot 'custody\windows-offline-apply-1.consumed.json'
  $marker = $null
  if (Test-Path -LiteralPath $markerPath) {
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { throw 'offline_apply_marker_invalid_type' }
    $marker = Read-E1LockedJsonSnapshot $markerPath 'offline_apply_marker'
  }
  Assert-E1CreatedInspectionReceipt $inspection.document $profileSha $inputLockSha $inspectedVmId `
    ([DateTime]::UtcNow) ($null -eq $marker)
  if ($marker) {
    Assert-E1OfflineApplyMarker $marker.document $profileSha $inputLockSha ([string]$inspection.sha256) `
      $credentialSha $inspectedVmId ([DateTime]::UtcNow)
  }
  $script:E1OfflineRecoveryCustody = [ordered]@{
    profile_sha256 = $profileSha; input_lock_sha256 = $inputLockSha
    created_inspection_receipt_sha256 = [string]$inspection.sha256
    guest_credential_sha256 = $credentialSha
    authorization_marker_sha256 = if ($marker) { [string]$marker.sha256 } else { $null }
    custody_source = if ($marker) { 'authorization-marker' } else { 'fresh-inspect-created' }
    vm_id = $inspectedVmId.ToLowerInvariant()
  }
  $vmResolution = Get-E1OfflineRecoveryVm $profile $inspectedVmId
  $vm = $vmResolution.vm
  $vmRegistrationRepaired = [bool]$vmResolution.registration_repaired
  $initial = Assert-E1OfflineVmTopology $vm $profile $plan $inspectedVmId ($null -eq $marker) $false
  Stop-E1OfflineApplyVmBounded $vm 30
  Dismount-VHD -Path $initial.vhd_path -ErrorAction SilentlyContinue
  Dismount-DiskImage -ImagePath $initial.iso_path -ErrorAction SilentlyContinue | Out-Null
  $vm = Get-VM -Id $inspectedVmId -ErrorAction Stop
  $contract = Assert-E1OfflineVmTopology $vm $profile $plan $inspectedVmId $true $true
  $cleanupRoot = Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath($RequestedCredentialPath))) ('.e1-offline-recovery-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $cleanupRoot | Out-Null
  $mounted = $null
  $answerFilesAbsent = $false
  $observedPartitionStyle = $null
  try {
    $mounted = Mount-VHD -Path $contract.vhd_path -Passthru -ErrorAction Stop
    $disk = Get-Disk -Number $mounted.DiskNumber -ErrorAction Stop
    $observedPartitionStyle = [string]$disk.PartitionStyle
    $partitions = @(Get-Partition -DiskNumber $disk.Number -ErrorAction SilentlyContinue)
    $windowsPartition = @($partitions | Where-Object {
      $volume = $_ | Get-Volume -ErrorAction SilentlyContinue
      $volume -and [string]$volume.FileSystemLabel -ceq 'Windows'
    })
    if ($windowsPartition.Count -eq 1) {
      $windowsRoot = Join-Path $cleanupRoot 'windows'
      New-Item -ItemType Directory -Path $windowsRoot | Out-Null
      Add-PartitionAccessPath -DiskNumber $disk.Number -PartitionNumber $windowsPartition[0].PartitionNumber -AccessPath ($windowsRoot + '\') -ErrorAction Stop
      $cleared = Clear-E1OfflineAnswerState $windowsRoot ([DateTime]::UtcNow.AddSeconds(120)) $cleanupRoot
      $answerFilesAbsent = $cleared.answer_files_absent -eq $true -and $cleared.autologon_values_absent -eq $true
    } elseif ($partitions.Count -eq 0 -and [string]$disk.PartitionStyle -in @('RAW','GPT')) {
      $answerFilesAbsent = $true
    } else {
      throw 'offline_apply_recovery_windows_partition_ambiguous'
    }
  } finally {
    if ($mounted) { Dismount-VHD -Path $contract.vhd_path -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $cleanupRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  $final = Get-VM -Id $inspectedVmId -ErrorAction Stop
  $null = Assert-E1OfflineVmTopology $final $profile $plan $inspectedVmId $true $true
  $finalIso = Get-DiskImage -ImagePath $contract.iso_path -ErrorAction Stop
  if (-not $answerFilesAbsent -or [bool]$finalIso.Attached -or
      (Get-E1Sha256 $RequestedProfilePath) -cne $profileSha -or
      (Get-E1Sha256 $RequestedInputLockPath) -cne $inputLockSha -or
      (Get-E1Sha256 $RequestedCredentialPath) -cne $credentialSha -or
      ($marker -and (Get-E1Sha256 $markerPath) -cne [string]$marker.sha256)) {
    throw 'offline_apply_recovery_invariant_failed'
  }
  if (-not (Test-Path -LiteralPath $RequestedReceiptPath)) {
    Write-E1ReceiptAtomically $RequestedReceiptPath ([ordered]@{
      schema = 1; verdict = 'FAIL'; mode = 'Recovery'
      reason_code = if ([string]::IsNullOrWhiteSpace($ReasonCode)) { 'operator_recovery' } else { $ReasonCode }
      generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      profile_id = $RequiredProfileId; profile_sha256 = $profileSha; input_lock_sha256 = $inputLockSha
      created_inspection_receipt_sha256 = [string]$inspection.sha256
      guest_credential_sha256 = $credentialSha
      approved_manifest_git_commit = [string]$plan.approved_manifest.git_commit
      recovery_runtime_source_git_commit = [string]$plan.approved_manifest.runtime_source_git_commit
      recovery_runtime_commit_drift_accepted = [bool]$plan.approved_manifest.runtime_commit_drift_accepted
      authorization_marker_sha256 = if ($marker) { [string]$marker.sha256 } else { $null }
      authorization_marker_sha256_reason = if ($marker) { $null } else { 'not_created_before_recovery' }
      custody_source = if ($marker) { 'authorization-marker' } else { 'fresh-inspect-created' }
      vm_id = ([string]$final.Id).ToLowerInvariant(); vm_state = 'Off'
      network_used = $false; network_state = 'disconnected'; vhd_partition_style = $observedPartitionStyle
      original_iso_is_only_dvd = $true; host_iso_mounted_after_operation = $false
      host_vhd_mounted_after_operation = $false; answer_files_absent = $answerFilesAbsent
      vm_registration_repaired = $vmRegistrationRepaired
      authorization_marker_created = [bool]($null -ne $marker)
      guest_credential_preserved = $true
      start_count = $null; start_count_reason = 'worker_start_telemetry_unavailable'
      mutation_performed = $null; mutation_reason = 'worker_mutation_telemetry_unavailable'
      private_paths_persisted = $false; credential_value_persisted_in_receipt = $false
      auth_material_read = $false; auth_material_copied = $false; inference_sessions_consumed = 0
      receipt_source = 'elevated-runner-recovery'
      native_failure = $script:E1OfflineNativeFailure
      recovery_partition_readback = $script:E1OfflineRecoveryPartitionReadback
    })
  }
}

$operationStartedAtUtc = [DateTime]::UtcNow
$deadlineUtc = $operationStartedAtUtc.AddSeconds($TimeoutSeconds)
$mutationPerformed = $false
$startPerformed = $false
$markerCreated = $false
$mountedVhd = $null
$mountedIso = $null
$workRoot = $null
$mountRoot = $null
$session = $null
$receiptFull = $null
$script:E1OfflineRecoveryCustody = $null
$script:E1OfflineNativeFailure = $null
$script:E1OfflineRecoveryPartitionReadback = $null
$hostDism = $null
$password = $null
$reason = $null

try {
  Assert-E1OfflineApplyAuthorization $AuthorizationPhrase
  $scratchRoots = @('C:\kmp-eval\scratch', [IO.Path]::GetTempPath())
  $inputLockFull = Assert-E1PathInside $InputLockPath $scratchRoots 'input_lock_path_outside_scratch'
  $credentialFull = Assert-E1PathInside $GuestCredentialPath $scratchRoots 'guest_credential_path_outside_scratch'
  $inspectionFull = Assert-E1PathInside $CreatedInspectionReceiptPath $scratchRoots 'created_inspection_receipt_path_outside_scratch'
  $receiptFull = if ($RecoveryOnly) {
    Assert-E1PathInside $ReceiptPath $scratchRoots 'receipt_path_outside_scratch'
  } else {
    New-E1ReceiptPath $ReceiptPath 'windows-offline-apply'
  }
  if ($RecoveryOnly) {
    Invoke-E1OfflineApplyRecovery $ProfilePath $inputLockFull $credentialFull $inspectionFull $receiptFull $RecoveryReasonCode
    Write-Host '[evidence1-apply-windows-offline] RECOVERY PASS'
    exit 0
  }
  if ([string]::IsNullOrWhiteSpace($RecoveryReasonCode) -eq $false) { throw 'recovery_reason_reserved' }
  Assert-E1Administrator
  Import-Module Hyper-V -ErrorAction Stop
  $plan = Get-E1ProvisioningPlan $ProfilePath $inputLockFull
  $profile = $plan.profile
  if ([string]$profile.profile_id -cne $RequiredProfileId -or
      [string]$profile.os.installation_boundary -cne 'offline-apply') { throw 'offline_apply_profile_not_allowed' }
  if (-not (Test-Path -LiteralPath $credentialFull -PathType Leaf)) { throw 'guest_credential_missing' }
  $credentialSha = Get-E1Sha256 $credentialFull
  $credential = Import-Clixml -LiteralPath $credentialFull
  if ($credential -isnot [pscredential] -or [string]$credential.UserName -cne [string]$profile.guest.local_user -or
      (Get-E1Sha256 $credentialFull) -cne $credentialSha) {
    throw 'guest_credential_invalid'
  }
  $hostDependencies = @($plan.host_dependencies)
  if ($hostDependencies.Count -ne 1 -or [string]$hostDependencies[0].id -cne 'windows-adk-dism') {
    throw 'host_dependency_missing'
  }
  $workRoot = Join-Path (Split-Path -Parent $credentialFull) ('.e1-offline-apply-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $workRoot | Out-Null
  # CBS still contains bounded Win32 path handling. Keep partition access paths
  # short even when the sealed runner and its private work root are deeply nested.
  $mountRoot = Join-Path 'C:\kmp-eval\scratch' ('.e1om-' + [guid]::NewGuid().ToString('N'))
  if ($mountRoot.Length -gt 96) { throw 'offline_mount_root_too_long' }
  New-Item -ItemType Directory -Path $mountRoot | Out-Null
  $hostDism = Expand-E1VerifiedHostDependency $hostDependencies[0] (Join-Path $workRoot 'host-dism')
  $profileSha = Get-E1Sha256 $ProfilePath
  $inputLockSha = Get-E1Sha256 $inputLockFull
  $inspection = Read-E1LockedJsonSnapshot $inspectionFull 'created_inspection_receipt'
  $inspectedVmId = [string]$inspection.document.vm_id
  Assert-E1CreatedInspectionReceipt $inspection.document $profileSha $inputLockSha $inspectedVmId `
    ([DateTime]::UtcNow) $true
  $vm = Get-VM -Id $inspectedVmId -ErrorAction Stop
  $topology = Assert-E1OfflineVmTopology $vm $profile $plan $inspectedVmId $true $true
  $vmRoot = $topology.vm_root
  $vhdPath = $topology.vhd_path
  $expectedIso = $topology.iso_path
  $markerPath = Join-Path $vmRoot 'custody\windows-offline-apply-1.consumed.json'
  if (Test-Path -LiteralPath $markerPath) { throw 'offline_apply_authorization_already_consumed' }
  $mountedVhd = Mount-VHD -Path $vhdPath -ReadOnly -Passthru -ErrorAction Stop
  $rawDisk = Get-Disk -Number $mountedVhd.DiskNumber -ErrorAction Stop
  if ([string]$rawDisk.PartitionStyle -cne 'RAW') { throw 'vhd_must_be_raw' }
  Dismount-VHD -Path $vhdPath -ErrorAction Stop
  $mountedVhd = $null
  Assert-E1OfflineDeadline $deadlineUtc

  $mountedIso = Mount-DiskImage -ImagePath $expectedIso -Access ReadOnly -PassThru -ErrorAction Stop
  $isoVolume = @($mountedIso | Get-Volume -ErrorAction Stop)
  if ($isoVolume.Count -ne 1 -or -not $isoVolume[0].DriveLetter) { throw 'iso_volume_missing' }
  $imagePath = @((Join-Path ($isoVolume[0].DriveLetter + ':\') 'sources\install.wim'), (Join-Path ($isoVolume[0].DriveLetter + ':\') 'sources\install.esd')) |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $imagePath) { throw 'iso_install_image_missing' }
  $imageIndex = [int]$plan.approved_manifest.iso_image.index
  if ($imageIndex -ne 6) { throw 'offline_apply_image_index_not_approved' }
  try {
    $image = Invoke-E1DismGetImageInfo $hostDism.executable_path $imagePath $imageIndex `
      $plan.approved_manifest.iso_image $deadlineUtc $workRoot
  } catch {
    if ([string]$_.Exception.Message -eq 'iso_image_metadata_mismatch') { throw 'offline_apply_image_metadata_mismatch' }
    throw
  }
  $null = Assert-E1ExpandedHostDependency $hostDependencies[0] $hostDism.root_path

  $vm = Get-VM -Id $inspectedVmId -ErrorAction Stop
  $null = Assert-E1OfflineVmTopology $vm $profile $plan $inspectedVmId $true $true
  if ((Get-E1Sha256 $credentialFull) -cne $credentialSha -or
      (Get-E1Sha256 $inputLockFull) -cne $inputLockSha -or
      (Get-E1Sha256 $ProfilePath) -cne $profileSha) { throw 'offline_apply_custody_changed' }

  Write-E1OfflineApplyMarkerAtomically $markerPath ([ordered]@{
    schema = 1; profile_id = $RequiredProfileId; vm_id = ([string]$vm.Id).ToLowerInvariant()
    profile_sha256 = $profileSha; input_lock_sha256 = $inputLockSha
    created_inspection_receipt_sha256 = [string]$inspection.sha256
    guest_credential_sha256 = $credentialSha
    consumed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    authorized_start_count = 1
  })
  $markerCreated = $true
  $marker = Read-E1LockedJsonSnapshot $markerPath 'offline_apply_marker'
  Assert-E1OfflineApplyMarker $marker.document $profileSha $inputLockSha ([string]$inspection.sha256) `
    $credentialSha $inspectedVmId ([DateTime]::UtcNow)
  $markerSha = [string]$marker.sha256

  $mountedVhd = Mount-VHD -Path $vhdPath -Passthru -ErrorAction Stop
  $disk = Get-Disk -Number $mountedVhd.DiskNumber -ErrorAction Stop
  if ([string]$disk.PartitionStyle -cne 'RAW') { throw 'vhd_must_be_raw' }
  $layout = Get-E1OfflineDiskLayout ([int64]$disk.Size)
  $mutationPerformed = $true
  $paths = Invoke-E1OfflineDiskInitialization $disk $layout $mountRoot
  $null = Assert-E1ExpandedHostDependency $hostDependencies[0] $hostDism.root_path
  $null = Invoke-E1DismApplyImage $hostDism.executable_path $imagePath $imageIndex $paths.windows $deadlineUtc $workRoot
  $hiddenPassword = ConvertTo-E1OfflineHiddenPassword (ConvertFrom-E1OfflineSecureString $credential.Password)
  $offlineAccountUnattendPath = Join-Path $workRoot 'offline-user-accounts.xml'
  $offlineAccountUnattend = New-E1OfflineServicingAccountUnattendXml $profile $hiddenPassword
  [xml]$parsedOfflineAccountUnattend = $offlineAccountUnattend
  $offlinePasses = @($parsedOfflineAccountUnattend.unattend.settings | ForEach-Object { [string]$_.pass })
  if ($offlinePasses.Count -ne 1 -or $offlinePasses[0] -cne 'offlineServicing') {
    throw 'offline_account_unattend_pass_contract_invalid'
  }
  [IO.File]::WriteAllText($offlineAccountUnattendPath, $offlineAccountUnattend, [Text.UTF8Encoding]::new($false))
  $null = Invoke-E1DismApplyUnattend $hostDism.executable_path $paths.windows $offlineAccountUnattendPath $deadlineUtc $workRoot
  $panther = Join-Path $paths.windows 'Windows\Panther'
  New-Item -ItemType Directory -Force -Path $panther | Out-Null
  $unattendPath = Join-Path $panther 'Unattend.xml'
  $unattend = New-E1OfflineApplyUnattendXml $profile $hiddenPassword
  [xml]$parsed = $unattend
  $passes = @($parsed.unattend.settings | ForEach-Object { [string]$_.pass })
  if ($passes.Count -ne 2 -or $passes -ccontains 'windowsPE' -or $passes -cnotcontains 'specialize' -or $passes -cnotcontains 'oobeSystem') {
    throw 'offline_unattend_pass_contract_invalid'
  }
  [IO.File]::WriteAllText($unattendPath, $unattend, [Text.UTF8Encoding]::new($false))
  $recoveryDir = Join-Path $paths.recovery 'Recovery\WindowsRE'
  New-Item -ItemType Directory -Force -Path $recoveryDir | Out-Null
  $winre = Join-Path $paths.windows 'Windows\System32\Recovery\Winre.wim'
  if (-not (Test-Path -LiteralPath $winre -PathType Leaf)) { throw 'applied_winre_missing' }
  Copy-Item -LiteralPath $winre -Destination (Join-Path $recoveryDir 'Winre.wim') -Force
  $null = Invoke-E1ConfigureOfflineRecovery $paths.windows $paths.recovery $deadlineUtc $workRoot
  $recoveryAttributes = Set-E1OfflineRecoveryGptAttributes $disk.Number $paths.recovery_partition_number `
    ($paths.recovery + '\') $deadlineUtc $workRoot
  $null = Invoke-E1BcdBootFromAppliedImage $paths.windows $paths.efi $deadlineUtc $workRoot
  Dismount-VHD -Path $vhdPath -ErrorAction Stop
  $mountedVhd = $null
  Dismount-DiskImage -ImagePath $expectedIso -ErrorAction Stop | Out-Null
  $mountedIso = $null
  Remove-Item -LiteralPath $mountRoot -Recurse -Force -ErrorAction Stop
  $mountRoot = $null
  Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction Stop
  $workRoot = $null

  $hardDisk = @(Get-VMHardDiskDrive -VM $vm -ErrorAction Stop)
  if ($hardDisk.Count -ne 1) { throw 'vm_vhd_contract_invalid' }
  Set-VMFirmware -VM $vm -FirstBootDevice $hardDisk[0] -ErrorAction Stop
  Start-VM -VM $vm -ErrorAction Stop | Out-Null
  $startPerformed = $true
  while ([DateTime]::UtcNow -lt $deadlineUtc -and -not $session) {
    $candidate = $null
    try {
      $directCredential = [pscredential]::new("$($profile.guest.computer_name)\$($profile.guest.local_user)", $credential.Password)
      $candidate = New-PSSession -VMId $vm.Id -Credential $directCredential -ErrorAction Stop
      $ready = Invoke-Command -Session $candidate -ScriptBlock {
        $state = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Setup\State' -ErrorAction Stop
        (Test-Path -LiteralPath 'C:\ProgramData\Evidence1\offline-apply-complete.marker') -and
          [string]$state.ImageState -ceq 'IMAGE_STATE_COMPLETE'
      } -ErrorAction Stop
      if ($ready -eq $true) { $session = $candidate; $candidate = $null }
    } catch { }
    finally { if ($candidate) { Remove-PSSession -Session $candidate -ErrorAction SilentlyContinue } }
    if (-not $session) { Start-Sleep -Seconds 5 }
  }
  if (-not $session) { throw 'powershell_direct_deadline_exceeded' }
  $cleanup = Invoke-Command -Session $session -ScriptBlock {
    $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    foreach ($name in @('DefaultPassword','DefaultUserName','DefaultDomainName','AutoAdminLogon','AutoLogonCount')) {
      Remove-ItemProperty -LiteralPath $winlogon -Name $name -Force -ErrorAction SilentlyContinue
    }
    $answerRoots = @('C:\Windows\Panther','C:\Windows\System32\Sysprep','C:\$Windows.~BT\Sources\Panther')
    function Get-AnswerFiles([string[]]$Roots) {
      $found = @()
      foreach ($root in $Roots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
        if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'guest_answer_cache_reparse_point' }
        $items = @(Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction Stop)
        if ($items.Count -gt 8192 -or
            @($items | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) {
          throw 'guest_answer_cache_bounds_or_reparse'
        }
        $found += @($items | Where-Object { -not $_.PSIsContainer -and $_.Name -like '*unattend*.xml' })
        if ($found.Count -gt 128) { throw 'guest_answer_cache_bounds_or_reparse' }
      }
      return $found
    }
    $answerFiles = @(Get-AnswerFiles $answerRoots)
    foreach ($path in $answerFiles) { Remove-Item -LiteralPath $path.FullName -Force -ErrorAction Stop }
    $answerFilesAfter = @(Get-AnswerFiles $answerRoots)
    [ordered]@{
      answer_files_absent = $answerFilesAfter.Count -eq 0
      autologon_values_absent = @('DefaultPassword','DefaultUserName','DefaultDomainName','AutoAdminLogon','AutoLogonCount' | Where-Object {
        $null -ne (Get-ItemProperty -LiteralPath $winlogon -Name $_ -ErrorAction SilentlyContinue)
      }).Count -eq 0
    }
  } -ErrorAction Stop
  if ($cleanup.answer_files_absent -ne $true -or $cleanup.autologon_values_absent -ne $true) { throw 'guest_setup_material_cleanup_failed' }
  Remove-PSSession -Session $session -ErrorAction SilentlyContinue
  $session = $null
  Stop-E1OfflineApplyVmBounded (Get-VM -Id $vm.Id -ErrorAction Stop) 30
  $finalVm = Get-VM -Id $vm.Id -ErrorAction Stop
  $finalDvd = @(Get-VMDvdDrive -VM $finalVm -ErrorAction Stop)
  $finalNetwork = @(Get-VMNetworkAdapter -VM $finalVm -ErrorAction Stop)
  $finalHostVhd = Get-VHD -Path $vhdPath -ErrorAction Stop
  $finalHostIso = Get-DiskImage -ImagePath $expectedIso -ErrorAction Stop
  if ([string]$finalVm.State -cne 'Off' -or $finalDvd.Count -ne 1 -or
      [IO.Path]::GetFullPath([string]$finalDvd[0].Path) -cne [IO.Path]::GetFullPath($expectedIso) -or
      $finalNetwork.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace([string]$finalNetwork[0].SwitchName) -or
      [bool]$finalHostVhd.Attached -or [bool]$finalHostIso.Attached -or
      (Get-E1Sha256 $ProfilePath) -cne $profileSha -or (Get-E1Sha256 $inputLockFull) -cne $inputLockSha -or
      (Get-E1Sha256 $credentialFull) -cne $credentialSha -or (Get-E1Sha256 $markerPath) -cne $markerSha) {
    throw 'offline_apply_final_invariant_failed'
  }
  Write-E1ReceiptAtomically $receiptFull ([ordered]@{
    schema = 1; verdict = 'PASS'; mode = 'Apply'; reason_code = $null
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    profile_id = $RequiredProfileId; profile_sha256 = $profileSha; input_lock_sha256 = $inputLockSha
    created_inspection_receipt_sha256 = [string]$inspection.sha256
    authorization_marker_sha256 = $markerSha
    vm_id = ([string]$vm.Id).ToLowerInvariant(); image_index = 6; image_name = 'Windows 11 Pro'
    partition_style = 'GPT'; efi_bytes = [int64]$layout.efi.size_bytes; msr_bytes = [int64]$layout.msr.size_bytes
    recovery_bytes_minimum = 1GB; winre_configured = $true
    recovery_partition_attributes = [string]$recoveryAttributes.attributes_hex
    recovery_partition_hidden = [bool]$recoveryAttributes.hidden
    recovery_partition_required = [bool]$recoveryAttributes.required
    recovery_partition_no_default_drive_letter = [bool]$recoveryAttributes.no_default_drive_letter
    dism_check_integrity = $true; dism_verify = $true
    host_dependency = [ordered]@{
      id = $hostDism.id; runtime_version = $hostDism.runtime_version
      archive_sha256 = $hostDism.archive_sha256; executable_sha256 = $hostDism.executable_sha256
      tree_sha256 = $hostDism.tree_sha256; tree_file_count = $hostDism.tree_file_count; tree_bytes = $hostDism.tree_bytes
    }
    bcdboot_source = 'applied-image'; firmware_first_boot = 'vhd'; authorization_marker_created = $true; start_count = 1
    powershell_direct_ready = $true; answer_files_absent = $true; autologon_values_absent = $true
    vm_state = 'Off'; network_used = $false; network_state = 'disconnected'
    original_iso_is_only_dvd = $true; host_iso_mounted_after_operation = $false; host_vhd_mounted_after_operation = $false
    guest_credential_storage = 'dpapi-current-user-clixml'; credential_value_persisted_in_receipt = $false
    private_paths_persisted = $false; auth_material_read = $false; auth_material_copied = $false
    dism_progress_percent = $null; dism_progress_reason = 'provider_metric_not_exposed'
    mutation_performed = $true; inference_sessions_consumed = 0; next_phase = 'verify-and-seal-post-os'
  })
  Write-Host '[evidence1-apply-windows-offline] PASS'
} catch {
  $candidateReason = [string]$_.Exception.Message
  $reason = Get-E1ClosedReason $candidateReason @(
    'exact_offline_apply_authorization_required','input_lock_path_outside_scratch','guest_credential_path_outside_scratch',
    'created_inspection_receipt_path_outside_scratch','receipt_path_outside_scratch','receipt_already_exists',
    'recovery_reason_reserved','profile_missing','profile_invalid_json','profile_identity_mismatch','input_lock_missing',
    'input_lock_invalid_json','input_lock_contract_mismatch','offline_apply_profile_not_allowed','guest_credential_missing',
    'guest_credential_invalid','created_inspection_receipt_missing','created_inspection_receipt_invalid_json',
    'created_inspection_receipt_binding_mismatch','created_inspection_receipt_time_invalid',
    'created_inspection_receipt_stale','offline_apply_marker_missing','offline_apply_marker_invalid_json',
    'offline_apply_marker_invalid_type','offline_apply_marker_binding_mismatch','offline_apply_marker_time_invalid','administrator_required',
    'vm_identity_contract_invalid','vm_must_be_off','vm_generation_contract_invalid','vm_processor_contract_invalid',
    'vm_memory_contract_invalid','vm_checkpoint_contract_invalid','vm_firmware_contract_invalid',
    'vm_security_contract_invalid','vm_vhd_contract_invalid',
    'original_iso_dvd_contract_invalid','network_must_be_disconnected','sealed_iso_missing','sealed_iso_size_mismatch',
    'sealed_iso_hash_mismatch','offline_apply_authorization_already_consumed','vhd_must_be_raw','iso_volume_missing',
    'iso_install_image_missing','offline_apply_image_index_not_approved','offline_apply_image_metadata_mismatch','iso_image_metadata_invalid',
    'dism_image_info_failed','host_dependency_missing','host_dependency_destination_exists','host_dependency_archive_missing',
    'host_dependency_archive_size_mismatch','host_dependency_archive_hash_mismatch','host_dependency_archive_bounds_invalid',
    'host_dependency_archive_path_invalid','host_dependency_tree_missing','host_dependency_tree_format_invalid','host_dependency_tree_mismatch',
    'host_dependency_reparse_rejected','host_dependency_command_path_invalid','host_dependency_executable_missing',
    'host_dependency_executable_size_mismatch','host_dependency_executable_hash_mismatch','host_dependency_version_mismatch',
    'host_dependency_architecture_invalid','host_dependency_signature_invalid','host_dependency_publisher_mismatch',
    'offline_apply_custody_changed','offline_mount_root_too_long','vm_disk_too_small_for_partition_contract','offline_partition_layout_failed','dism_apply_image_failed',
    'native_output_too_large','recovery_gpt_attributes_set_failed','recovery_gpt_attributes_mismatch',
    'offline_unattend_pass_contract_invalid','offline_account_unattend_pass_contract_invalid','dism_apply_unattend_failed',
    'applied_winre_missing','host_reagentc_missing','reagentc_setreimage_failed','applied_bcdboot_missing','bcdboot_failed',
    'offline_apply_deadline_exceeded','powershell_direct_deadline_exceeded',
    'guest_setup_material_cleanup_failed','recovery_vm_stop_timeout','offline_apply_final_invariant_failed',
    'offline_apply_recovery_invariant_failed','offline_apply_recovery_windows_partition_ambiguous',
    'recovery_vm_configuration_missing','recovery_vm_configuration_reparse_point',
    'recovery_vm_registration_failed','recovery_vm_registration_identity_mismatch',
    'approved_manifest_recovery_requires_sealed_runtime','approved_manifest_sealed_identity_mismatch',
    'offline_answer_cache_reparse_point','offline_answer_cache_bounds_exceeded','offline_answer_file_cleanup_failed',
    'offline_registry_hive_missing','offline_registry_load_failed',
    'offline_registry_cleanup_failed','offline_registry_unload_failed'
  ) 'offline_apply_failed'
  try {
    if ($session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
    if ($mountedVhd) { Dismount-VHD -Path $mountedVhd.Path -ErrorAction SilentlyContinue }
    if ($mountedIso) { Dismount-DiskImage -ImagePath $mountedIso.ImagePath -ErrorAction SilentlyContinue | Out-Null }
    if ($mountRoot -and (Test-Path -LiteralPath $mountRoot)) { Remove-Item -LiteralPath $mountRoot -Recurse -Force -ErrorAction SilentlyContinue }
    if ($workRoot -and (Test-Path -LiteralPath $workRoot)) { Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue }
    if (-not $RecoveryOnly -and (Get-Variable vm -ErrorAction SilentlyContinue)) {
      Stop-E1OfflineApplyVmBounded (Get-VM -Id $vm.Id -ErrorAction Stop) 30
    }
  } catch { }
  if (-not $RecoveryOnly -and ($markerCreated -or $mutationPerformed -or $startPerformed) -and
      (Get-Variable inputLockFull -ErrorAction SilentlyContinue) -and
      (Get-Variable credentialFull -ErrorAction SilentlyContinue) -and $receiptFull) {
    try {
      Invoke-E1OfflineApplyRecovery $ProfilePath $inputLockFull $credentialFull $inspectionFull $receiptFull $reason
    } catch { }
  }
  try {
    if (-not $receiptFull) { $receiptFull = New-E1ReceiptPath $ReceiptPath 'windows-offline-apply-failed' }
    if (-not (Test-Path -LiteralPath $receiptFull)) {
      Write-E1ReceiptAtomically $receiptFull ([ordered]@{
        schema = 1; verdict = 'FAIL'; mode = 'Apply'; reason_code = $reason
        generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        profile_id = $RequiredProfileId
        profile_sha256 = if (Get-Variable profileSha -ErrorAction SilentlyContinue) { $profileSha } elseif ($script:E1OfflineRecoveryCustody) { $script:E1OfflineRecoveryCustody.profile_sha256 } else { $null }
        input_lock_sha256 = if (Get-Variable inputLockSha -ErrorAction SilentlyContinue) { $inputLockSha } elseif ($script:E1OfflineRecoveryCustody) { $script:E1OfflineRecoveryCustody.input_lock_sha256 } else { $null }
        created_inspection_receipt_sha256 = if (Get-Variable inspection -ErrorAction SilentlyContinue) { [string]$inspection.sha256 } elseif ($script:E1OfflineRecoveryCustody) { $script:E1OfflineRecoveryCustody.created_inspection_receipt_sha256 } else { $null }
        guest_credential_sha256 = if (Get-Variable credentialSha -ErrorAction SilentlyContinue) { $credentialSha } elseif ($script:E1OfflineRecoveryCustody) { $script:E1OfflineRecoveryCustody.guest_credential_sha256 } else { $null }
        authorization_marker_sha256 = if (Get-Variable markerSha -ErrorAction SilentlyContinue) { $markerSha } elseif ($script:E1OfflineRecoveryCustody) { $script:E1OfflineRecoveryCustody.authorization_marker_sha256 } else { $null }
        custody_source = if ($script:E1OfflineRecoveryCustody) { $script:E1OfflineRecoveryCustody.custody_source } else { $null }
        custody_unavailable_reason = if ((Get-Variable profileSha -ErrorAction SilentlyContinue) -or $script:E1OfflineRecoveryCustody) { $null } else { 'failure_before_custody_validation' }
        vm_id = if (Get-Variable vm -ErrorAction SilentlyContinue) { ([string]$vm.Id).ToLowerInvariant() } elseif ($script:E1OfflineRecoveryCustody) { $script:E1OfflineRecoveryCustody.vm_id } else { $null }
        authorization_marker_created = [bool]$markerCreated
        start_count = if ($startPerformed) { 1 } else { 0 }; network_used = $false
        answer_files_absent = $null; answer_files_absent_reason = 'terminal_recovery_not_attested'
        guest_credential_preserved = if (Get-Variable credentialFull -ErrorAction SilentlyContinue) { [bool](Test-Path -LiteralPath $credentialFull -PathType Leaf) } else { $false }
        private_paths_persisted = $false; credential_value_persisted_in_receipt = $false
        auth_material_read = $false; auth_material_copied = $false
        native_failure = $script:E1OfflineNativeFailure
        recovery_partition_readback = $script:E1OfflineRecoveryPartitionReadback
        mutation_performed = [bool]$mutationPerformed; inference_sessions_consumed = 0
      })
    }
  } catch { }
  Fail $reason
} finally {
  $password = $null
}

#Requires -RunAsAdministrator

param(
  [string]$ProfilePath = '',
  [Parameter(Mandatory = $true)] [string]$InputLockPath,
  [Parameter(Mandatory = $true)] [string]$GuestCredentialPath,
  [Parameter(Mandatory = $true)] [string]$AnswerMediaPath,
  [string]$ReceiptPath = '',
  [string]$PriorFailureReceiptPath = '',
  [string]$PriorFailureCustodyPath = '',
  [string]$PriorInputLockPath = '',
  [string]$PriorCreatedInspectionReceiptPath = '',
  [string]$PriorRunnerRequestId = '',
  [ValidateRange(900, 7200)] [int]$TimeoutSeconds = 3600,
  [switch]$RecoveryOnly,
  [ValidateSet('', 'elevated_runner_child_timeout', 'elevated_runner_child_failure')]
  [string]$RecoveryReasonCode = '',
  [string]$AuthorizationPhrase = '',
  [string]$RetryAuthorizationPhrase = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RequiredProfileId = 'evidence1-windows-hyperv-e2e-v1'
$RequiredAuthorizationPhrase = 'authorize install evidence1 e2e windows unattended offline'
$RequiredRetryAuthorizationPhrase = 'authorize exactly one evidence1 e2e windows unattended retry'
$RequiredRunnerQueueRoot = 'C:\kmp-eval\scratch\host-elevated-runner-codex'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ProfilePath)) {
  $ProfilePath = Join-Path $scriptRoot 'evidence1-windows-hyperv-e2e-v1.json'
}
Import-Module (Join-Path $scriptRoot 'Evidence1.Provisioning.psm1') -Force

function Fail([string]$Code) { Write-Error "HARD STOP: $Code"; exit 1 }

function ConvertFrom-E1SecureString([Security.SecureString]$SecureValue) {
  $pointer = [IntPtr]::Zero
  try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    if ($pointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
  }
}

function Write-E1RetryMarkerAtomically([string]$Path, $Value) {
  $full = [IO.Path]::GetFullPath($Path)
  $temp = "$full.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temp, $full)
  } finally {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
  }
}

function Get-E1Sha256OrNull([string]$Path) {
  try {
    if (-not [string]::IsNullOrWhiteSpace($Path) -and (Test-Path -LiteralPath $Path -PathType Leaf)) {
      return Get-E1Sha256 $Path
    }
  } catch { }
  return $null
}

function Write-E1RecoveryReceiptIfNeeded(
    [string]$ReasonCode,
    [string]$RequestedReceiptPath,
    [string]$RequestedProfilePath,
    [string]$RequestedInputLockPath,
    [string]$RequestedCredentialPath,
    [bool]$RetryAttempt,
    $Recovery) {
  if ([string]::IsNullOrWhiteSpace($ReasonCode)) { return $false }
  if ($ReasonCode -cnotin @('elevated_runner_child_timeout','elevated_runner_child_failure')) {
    throw 'recovery_reason_code_invalid'
  }
  $recoveryReceiptFull = Assert-E1PathInside $RequestedReceiptPath @('C:\kmp-eval\scratch', [IO.Path]::GetTempPath()) `
    'receipt_path_outside_scratch'
  if (Test-Path -LiteralPath $recoveryReceiptFull) { return $false }
  if ($Recovery.vm_id -isnot [string] -or [string]$Recovery.vm_id -cnotmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
    throw 'recovery_vm_identity_invalid'
  }
  $markerPresent = $RetryAttempt -and
    (Test-Path -LiteralPath 'C:\kmp-eval\hyperv-e2e\Evidence1-Runner-E2E\custody\unattended-retry-1.consumed.json' -PathType Leaf)
  Write-E1ReceiptAtomically $recoveryReceiptFull ([ordered]@{
    schema = 1; verdict = 'FAIL'; reason_code = $ReasonCode
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    profile_id = $RequiredProfileId; profile_sha256 = Get-E1Sha256OrNull $RequestedProfilePath
    input_lock_sha256 = Get-E1Sha256OrNull $RequestedInputLockPath
    vm_id = ([string]$Recovery.vm_id).ToLowerInvariant()
    guest_credential_sha256 = Get-E1Sha256OrNull $RequestedCredentialPath
    attempt_number = if ($RetryAttempt) { 2 } else { 1 }
    start_count = $null; prior_failure_receipt_sha256 = $null; prior_failure_custody_sha256 = $null
    retry_authorization_consumed = [bool]($RetryAttempt -and $markerPresent)
    retry_consumption_marker_created = [bool]$markerPresent
    network_used = $false; vm_state = [string]$Recovery.vm_state
    answer_media_deleted = [bool]$Recovery.answer_media_deleted
    boot_key_attempts = $null; boot_key_successes = $null
    boot_key_last_return_code = $null; boot_key_exception_count = $null
    cached_answer_files_absent = $null; guest_cached_answer_state = 'unknown'
    host_cleanup_complete = $true; failure_cleanup_complete = $false
    cleanup_failure_codes = @(); guest_credential_preserved = [bool]$Recovery.guest_credential_preserved
    retry_authorized = $false; credential_value_persisted_in_receipt = $false
    private_paths_persisted = $false; mutation_performed = $null
    mutation_telemetry_reason = 'worker_mutation_telemetry_unavailable'
    inference_sessions_consumed = 0; receipt_source = 'elevated-runner-recovery'
  })
  return $true
}

function Read-E1RetryReceiptIdentity([string]$Path) {
  $snapshot = Read-E1LockedJsonSnapshot $Path 'prior_failure_receipt'
  $receipt = $snapshot.document
  if ($null -eq $receipt -or $receipt -isnot [psobject]) { throw 'prior_failure_receipt_invalid' }
  $required = @(
    'schema','verdict','reason_code','start_count','network_used','vm_state','answer_media_deleted',
    'host_cleanup_complete','guest_credential_preserved','retry_authorized','private_paths_persisted',
    'mutation_performed','inference_sessions_consumed','cleanup_failure_codes','guest_cached_answer_state'
  )
  foreach ($name in $required) {
    if ($receipt.PSObject.Properties.Name -cnotcontains $name) { throw 'prior_failure_receipt_invalid' }
  }
  if (-not (Test-E1StrictJsonInteger $receipt.schema 1) -or $receipt.verdict -isnot [string] -or
      $receipt.verdict -cne 'FAIL' -or $receipt.reason_code -isnot [string] -or
      $receipt.reason_code -cne 'vm_boot_key_injection_failed' -or
      -not (Test-E1StrictJsonInteger $receipt.start_count 1) -or $receipt.network_used -isnot [bool] -or
      $receipt.network_used -ne $false -or $receipt.vm_state -isnot [string] -or $receipt.vm_state -cne 'Off' -or
      $receipt.answer_media_deleted -isnot [bool] -or $receipt.answer_media_deleted -ne $true -or
      $receipt.host_cleanup_complete -isnot [bool] -or $receipt.host_cleanup_complete -ne $true -or
      $receipt.guest_credential_preserved -isnot [bool] -or $receipt.guest_credential_preserved -ne $true -or
      $receipt.retry_authorized -isnot [bool] -or $receipt.retry_authorized -ne $false -or
      $receipt.private_paths_persisted -isnot [bool] -or $receipt.private_paths_persisted -ne $false -or
      $receipt.mutation_performed -isnot [bool] -or $receipt.mutation_performed -ne $true -or
      -not (Test-E1StrictJsonInteger $receipt.inference_sessions_consumed 0) -or
      $receipt.cleanup_failure_codes -isnot [array] -or @($receipt.cleanup_failure_codes).Count -ne 0 -or
      $receipt.guest_cached_answer_state -isnot [string] -or $receipt.guest_cached_answer_state -cne 'unknown') {
    throw 'prior_failure_receipt_invalid'
  }
  return [ordered]@{ receipt = $receipt; sha256 = [string]$snapshot.sha256 }
}

function Read-E1RetryCustodyIdentity([string]$Path) {
  $snapshot = Read-E1LockedJsonSnapshot $Path 'prior_failure_custody'
  $custody = $snapshot.document
  $required = @(
    'schema','verdict','reason_code','generated_at_utc','profile_id','profile_sha256','current_input_lock_sha256',
    'prior_input_lock_sha256','created_inspection_receipt_sha256','vm_id','guest_credential_sha256','prior_failure_receipt_sha256',
    'runner_request_id','runner_request_sha256','runner_response_sha256','runner_log_sha256',
    'attempt_number','start_count','vm_state','vhd_partition_style','network_used','answer_media_deleted',
    'retry_consumption_marker_absent','host_cleanup_complete','runner_queue_acl_hardened','runner_artifact_acls_hardened',
    'guest_credential_preserved','authorization_value_copied_to_sidecar','raw_log_copied_to_sidecar',
    'source_artifact_paths_copied_to_sidecar',
    'vm_mutation_performed','custody_record_written','mutation_performed','inference_sessions_consumed'
  )
  Assert-E1ExactProperties $custody $required 'prior_failure_custody'
  Assert-E1RequiredProperties $custody $required 'prior_failure_custody'
  foreach ($field in @(
    'profile_sha256','current_input_lock_sha256','prior_input_lock_sha256','created_inspection_receipt_sha256',
    'guest_credential_sha256','prior_failure_receipt_sha256','runner_request_sha256',
    'runner_response_sha256','runner_log_sha256'
  )) {
    if ($custody.$field -isnot [string] -or [string]$custody.$field -cnotmatch '^[0-9a-f]{64}$') {
      throw 'prior_failure_custody_invalid'
    }
  }
  if (-not (Test-E1StrictJsonInteger $custody.schema 1) -or $custody.verdict -isnot [string] -or
      $custody.verdict -cne 'PASS' -or $custody.reason_code -isnot [string] -or
      $custody.reason_code -cne 'legacy_failure_custody_validated' -or
      $custody.generated_at_utc -isnot [string] -or [string]$custody.generated_at_utc -cnotmatch 'Z$' -or
      $custody.profile_id -isnot [string] -or $custody.profile_id -cne $RequiredProfileId -or
      $custody.vm_id -isnot [string] -or $custody.vm_id -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
      $custody.runner_request_id -isnot [string] -or $custody.runner_request_id -cnotmatch '^req-[A-Za-z0-9-]+$' -or
      -not (Test-E1StrictJsonInteger $custody.attempt_number 1) -or
      -not (Test-E1StrictJsonInteger $custody.start_count 1) -or
      $custody.vm_state -isnot [string] -or $custody.vm_state -cne 'Off' -or
      $custody.vhd_partition_style -isnot [string] -or $custody.vhd_partition_style -cne 'RAW' -or
      $custody.network_used -isnot [bool] -or $custody.network_used -ne $false -or
      $custody.answer_media_deleted -isnot [bool] -or $custody.answer_media_deleted -ne $true -or
      $custody.retry_consumption_marker_absent -isnot [bool] -or $custody.retry_consumption_marker_absent -ne $true -or
      $custody.host_cleanup_complete -isnot [bool] -or $custody.host_cleanup_complete -ne $true -or
      $custody.runner_queue_acl_hardened -isnot [bool] -or $custody.runner_queue_acl_hardened -ne $true -or
      $custody.runner_artifact_acls_hardened -isnot [bool] -or $custody.runner_artifact_acls_hardened -ne $true -or
      $custody.guest_credential_preserved -isnot [bool] -or $custody.guest_credential_preserved -ne $true -or
      $custody.authorization_value_copied_to_sidecar -isnot [bool] -or $custody.authorization_value_copied_to_sidecar -ne $false -or
      $custody.raw_log_copied_to_sidecar -isnot [bool] -or $custody.raw_log_copied_to_sidecar -ne $false -or
      $custody.source_artifact_paths_copied_to_sidecar -isnot [bool] -or $custody.source_artifact_paths_copied_to_sidecar -ne $false -or
      $custody.vm_mutation_performed -isnot [bool] -or $custody.vm_mutation_performed -ne $false -or
      $custody.custody_record_written -isnot [bool] -or $custody.custody_record_written -ne $true -or
      $custody.mutation_performed -isnot [bool] -or $custody.mutation_performed -ne $true -or
      -not (Test-E1StrictJsonInteger $custody.inference_sessions_consumed 0)) {
    throw 'prior_failure_custody_invalid'
  }
  return [ordered]@{ custody = $custody; sha256 = [string]$snapshot.sha256 }
}

function Set-E1PrivateDirectoryAcl([string]$Path) {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  foreach ($sidValue in @($currentSid, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique) {
    $principal = ([Security.Principal.SecurityIdentifier]::new($sidValue)).Translate([Security.Principal.NTAccount])
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $principal,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    $null = $acl.AddAccessRule($rule)
  }
  [IO.Directory]::SetAccessControl([IO.Path]::GetFullPath($Path), $acl)
}

function Assert-E1NoReparsePointAncestors([string]$Path) {
  $cursor = $Path
  while (-not [string]::IsNullOrWhiteSpace($cursor)) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'private_state_reparse_point'
      }
    }
    $parent = Split-Path -Parent $cursor
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -ceq $cursor) { break }
    $cursor = $parent
  }
}

function Invoke-E1UnattendedHostRecovery([string]$VMName, [string]$CredentialPath, [string]$MediaPath) {
  $recoveryFailures = @()
  $privateStateRoot = Split-Path -Parent $CredentialPath
  if ([IO.Path]::GetFullPath($privateStateRoot) -cne [IO.Path]::GetFullPath((Split-Path -Parent $MediaPath))) {
    throw 'private_state_root_mismatch'
  }
  Assert-E1NoReparsePointAncestors $privateStateRoot
  if ($VMName -cne 'Evidence1-Runner-E2E') { throw 'recovery_vm_identity_mismatch' }
  $targetVm = Get-VM -Name $VMName -ErrorAction SilentlyContinue
  if (-not $targetVm) { throw 'recovery_vm_missing' }
  $stopJob = $null
  try {
    if ([string]$targetVm.State -cne 'Off') {
      $stopJob = Stop-VM -VM $targetVm -TurnOff -Force -AsJob -ErrorAction Stop
      if (-not (Wait-Job -Job $stopJob -Timeout 30)) {
        Stop-Job -Job $stopJob -ErrorAction SilentlyContinue
        $recoveryFailures += 'vm_stop_timeout'
      } else {
        Receive-Job -Job $stopJob -ErrorAction Stop | Out-Null
      }
    }
  } catch {
    $recoveryFailures += 'vm_stop_command'
  } finally {
    if ($stopJob) { Remove-Job -Job $stopJob -Force -ErrorAction SilentlyContinue }
  }
  $stopDeadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $targetVm = Get-VM -Id $targetVm.Id -ErrorAction Stop
    if ([string]$targetVm.State -ceq 'Off') { break }
    Start-Sleep -Seconds 1
  } while ([DateTime]::UtcNow -lt $stopDeadline)
  if ([string]$targetVm.State -cne 'Off') { throw 'recovery_vm_stop_not_observed' }

  $attachedMedia = @(Get-VMDvdDrive -VM $targetVm -ErrorAction Stop | Where-Object {
    $_.Path -and [IO.Path]::GetFullPath([string]$_.Path) -ceq [IO.Path]::GetFullPath($MediaPath)
  })
  foreach ($drive in $attachedMedia) { Remove-VMDvdDrive -VMDvdDrive $drive -ErrorAction Stop }
  if (Test-Path -LiteralPath $MediaPath) { Remove-Item -LiteralPath $MediaPath -Force -ErrorAction Stop }

  if (Test-Path -LiteralPath $privateStateRoot -PathType Container) {
    foreach ($work in @(Get-ChildItem -LiteralPath $privateStateRoot -Directory -Filter '.e1-unattend-*' -Force -ErrorAction Stop)) {
      if (($work.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'private_state_reparse_point' }
      Remove-Item -LiteralPath $work.FullName -Recurse -Force -ErrorAction Stop
    }
  }
  if (Test-Path -LiteralPath $MediaPath) { throw 'recovery_answer_media_cleanup_failed' }
  if ($recoveryFailures.Count -ne 0) { throw 'recovery_vm_stop_uncertain' }
  return [ordered]@{
    vm_id = ([string]$targetVm.Id).ToLowerInvariant()
    vm_state = 'Off'
    answer_media_deleted = $true
    guest_credential_preserved = Test-Path -LiteralPath $CredentialPath -PathType Leaf
    guest_cached_answer_state = 'unknown'
    retry_authorized = $false
  }
}

function New-E1RandomPassword {
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%_-'
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $chars = New-Object char[] 36
  for ($index = 0; $index -lt 32; $index++) {
    $chars[$index] = $alphabet[$bytes[$index] % $alphabet.Length]
  }
  $chars[32] = 'A'
  $chars[33] = 'a'
  $chars[34] = '7'
  $chars[35] = '!'
  return -join $chars
}

function ConvertTo-E1HiddenLocalPassword([string]$Password) {
  return [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Password + 'Password'))
}

function Add-E1IsoWriterType {
  if ('Evidence1IsoWriter' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class Evidence1IsoWriter
{
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, PreserveSig = false)]
    private static extern void SHCreateStreamOnFileEx(
        string path,
        uint mode,
        uint attributes,
        bool create,
        IStream template,
        out IStream stream);

    public static void Save(object source, string destination)
    {
        IStream input = (IStream)source;
        IStream output;
        const uint STGM_CREATE_WRITE_EXCLUSIVE = 0x00001011;
        const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        SHCreateStreamOnFileEx(destination, STGM_CREATE_WRITE_EXCLUSIVE, FILE_ATTRIBUTE_NORMAL, true, null, out output);
        try
        {
            System.Runtime.InteropServices.ComTypes.STATSTG stat;
            input.Stat(out stat, 1);
            input.CopyTo(output, stat.cbSize, IntPtr.Zero, IntPtr.Zero);
            output.Commit(0);
        }
        finally
        {
            Marshal.FinalReleaseComObject(output);
        }
    }
}
'@
}

function New-E1AnswerIso([string]$SourceDirectory, [string]$Destination) {
  Add-E1IsoWriterType
  $image = $null
  $result = $null
  try {
    $image = New-Object -ComObject 'Imapi2Fs.MsftFileSystemImage'
    $image.ChooseImageDefaultsForMediaType(12)
    $image.FileSystemsToCreate = 1
    $image.VolumeName = 'E1Answer'
    $image.Root.AddTree($SourceDirectory, $false)
    $result = $image.CreateResultImage()
    [Evidence1IsoWriter]::Save($result.ImageStream, $Destination)
  } finally {
    if ($result) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($result) }
    if ($image) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($image) }
  }
}

function New-E1UnattendXml($Profile, $Plan, [string]$HiddenPassword) {
  $imageIndex = [int]$Plan.approved_manifest.iso_image.index
  $totalDiskMiB = [Math]::Floor(([int64]$Profile.vm.vhd_size_bytes) / 1MB)
  $windowsPartitionMiB = $totalDiskMiB - 300 - 16 - 1024 - 8
  if ($windowsPartitionMiB -lt 65536) { throw 'vm_disk_too_small_for_partition_contract' }
  $computerName = [Security.SecurityElement]::Escape([string]$Profile.guest.computer_name)
  $localUser = [Security.SecurityElement]::Escape([string]$Profile.guest.local_user)
  return @"
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <SetupUILanguage><UILanguage>en-GB</UILanguage></SetupUILanguage>
      <InputLocale>0809:00000809</InputLocale>
      <SystemLocale>en-GB</SystemLocale>
      <UILanguage>en-GB</UILanguage>
      <UserLocale>en-GB</UserLocale>
    </component>
    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <DiskConfiguration>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>300</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Size>$windowsPartitionMiB</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>4</Order><Type>Primary</Type><Size>1024</Size></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Label>System</Label><Format>FAT32</Format></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>3</PartitionID><Label>Windows</Label><Letter>C</Letter><Format>NTFS</Format></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>4</PartitionID><Label>Recovery</Label><Format>NTFS</Format><TypeID>de94bba4-06d1-4d40-a16a-bfd50179d6ac</TypeID></ModifyPartition>
          </ModifyPartitions>
        </Disk>
        <WillShowUI>OnError</WillShowUI>
      </DiskConfiguration>
      <ImageInstall>
        <OSImage>
          <InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>$imageIndex</Value></MetaData></InstallFrom>
          <InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>
          <WillShowUI>OnError</WillShowUI>
        </OSImage>
      </ImageInstall>
      <UserData>
        <AcceptEula>true</AcceptEula>
        <FullName>Evidence1</FullName>
        <Organization>Evidence1</Organization>
        <ProductKey><Key>VK7JG-NPHTM-C97JM-9MPGT-3V66T</Key><WillShowUI>Never</WillShowUI></ProductKey>
      </UserData>
    </component>
  </settings>
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
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Password><Value>$HiddenPassword</Value><PlainText>false</PlainText></Password>
            <Description>Evidence1 isolated evaluation administrator</Description>
            <DisplayName>$localUser</DisplayName>
            <Group>Administrators</Group>
            <Name>$localUser</Name>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <AutoLogon>
        <Password><Value>$HiddenPassword</Value><PlainText>false</PlainText></Password>
        <Enabled>true</Enabled>
        <LogonCount>1</LogonCount>
        <Username>$localUser</Username>
      </AutoLogon>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add">
          <Order>1</Order>
          <Description>Disable the documented extra automatic logon and attest OOBE completion</Description>
          <CommandLine>cmd.exe /c reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoLogonCount /t REG_DWORD /d 0 /f &amp;&amp; mkdir C:\ProgramData\Evidence1 2&gt;nul &amp;&amp; type nul &gt; C:\ProgramData\Evidence1\oobe-complete.marker</CommandLine>
          <RequiresUserInput>false</RequiresUserInput>
        </SynchronousCommand>
      </FirstLogonCommands>
    </component>
  </settings>
</unattend>
"@
}

function Invoke-E1BoundedBootKey($VM) {
  $script:E1BootKeyDiagnostics = [ordered]@{
    attempts = 0
    successes = 0
    last_return_code = $null
    exception_count = 0
  }
  $escapedName = ([string]$VM.Name).Replace("'", "''")
  $vmSystem = @(Get-CimInstance -Namespace 'root\virtualization\v2' -ClassName Msvm_ComputerSystem `
    -Filter "ElementName='$escapedName'" | Where-Object { [int]$_.EnabledState -ne 3 })
  if ($vmSystem.Count -ne 1) { throw 'vm_keyboard_system_not_found' }
  $keyboards = @(Get-CimAssociatedInstance -InputObject $vmSystem[0] -Association Msvm_SystemDevice `
    -ResultClassName Msvm_Keyboard)
  if ($keyboards.Count -ne 1) { throw 'vm_keyboard_not_found' }
  # Firmware can expose the virtual keyboard before it accepts input. Exercise a
  # fixed eight-second window and require at least one documented success (0);
  # transient CIM return codes and exceptions never become fabricated success.
  $bootKeySuccessCount = 0
  Start-Sleep -Milliseconds 500
  for ($attempt = 0; $attempt -lt 16; $attempt++) {
    $script:E1BootKeyDiagnostics.attempts++
    try {
      $result = Invoke-CimMethod -InputObject $keyboards[0] -MethodName TypeKey -Arguments @{ keyCode = [uint32]32 }
      $script:E1BootKeyDiagnostics.last_return_code = [uint32]$result.ReturnValue
      if ([uint32]$result.ReturnValue -eq 0) {
        $bootKeySuccessCount++
        $script:E1BootKeyDiagnostics.successes++
      }
    } catch {
      # Retry only inside this bounded boot window; the final invariant remains fail-closed.
      $script:E1BootKeyDiagnostics.exception_count++
    }
    if ($attempt -lt 15) { Start-Sleep -Milliseconds 500 }
  }
  if ($bootKeySuccessCount -eq 0) { throw 'vm_boot_key_injection_failed' }
}

$session = $null
$mountedVhd = $null
$answerDvd = $null
$mountedSourceIso = $null
$workDirectory = $null
$startPerformed = $false
$mutationPerformed = $false
$answerMediaDeleted = $false
$cachedAnswerFilesAbsent = $false
$failureCleanupComplete = $null
$privateRoot = $null
$guest = $null
$isRetry = -not [string]::IsNullOrWhiteSpace($PriorFailureReceiptPath) -or
  -not [string]::IsNullOrWhiteSpace($PriorFailureCustodyPath) -or
  -not [string]::IsNullOrWhiteSpace($PriorInputLockPath) -or
  -not [string]::IsNullOrWhiteSpace($PriorCreatedInspectionReceiptPath) -or
  -not [string]::IsNullOrWhiteSpace($PriorRunnerRequestId) -or
  -not [string]::IsNullOrWhiteSpace($RetryAuthorizationPhrase)
$priorFailureReceiptSha = $null
$priorFailureCustodySha = $null
$priorFailureCustody = $null
$priorStartCount = 0
$attemptNumber = 1
$retryMarkerPath = $null
$retryMarkerCreated = $false
$operationStartedAtUtc = [DateTime]::UtcNow
$deadlineUtc = $operationStartedAtUtc.AddSeconds($TimeoutSeconds)
try {
  if ($AuthorizationPhrase -cne $RequiredAuthorizationPhrase) { throw 'exact_unattended_install_authorization_required' }
  if ($isRetry -and ([string]::IsNullOrWhiteSpace($PriorFailureReceiptPath) -or
      [string]::IsNullOrWhiteSpace($PriorFailureCustodyPath) -or
      [string]::IsNullOrWhiteSpace($PriorInputLockPath) -or
      [string]::IsNullOrWhiteSpace($PriorCreatedInspectionReceiptPath) -or
      [string]::IsNullOrWhiteSpace($PriorRunnerRequestId) -or
      $RetryAuthorizationPhrase -cne $RequiredRetryAuthorizationPhrase)) {
    throw 'exact_unattended_retry_authorization_required'
  }
  $scratchRoots = @('C:\kmp-eval\scratch', [IO.Path]::GetTempPath())
  $credentialFull = Assert-E1PathInside $GuestCredentialPath $scratchRoots 'guest_credential_path_outside_scratch'
  $answerMediaFull = Assert-E1PathInside $AnswerMediaPath $scratchRoots 'answer_media_path_outside_scratch'
  if ($RecoveryOnly) {
    Assert-E1Administrator
    Import-Module Hyper-V -ErrorAction Stop
    $recovery = Invoke-E1UnattendedHostRecovery 'Evidence1-Runner-E2E' $credentialFull $answerMediaFull
    $null = Write-E1RecoveryReceiptIfNeeded $RecoveryReasonCode $ReceiptPath $ProfilePath $InputLockPath `
      $credentialFull ([bool]$isRetry) $recovery
    Write-Host "[evidence1-install-windows-unattended] RECOVERY PASS: vm_state=$($recovery.vm_state); answer_media_deleted=$($recovery.answer_media_deleted); guest_cached_answer_state=unknown; retry_authorized=false"
    exit 0
  }
  $receiptFull = New-E1ReceiptPath $ReceiptPath 'windows-unattended-install'
  if (Test-Path -LiteralPath $answerMediaFull) { throw 'answer_media_already_exists' }
  if ($isRetry) {
    $priorFailureFull = Assert-E1PathInside $PriorFailureReceiptPath $scratchRoots 'prior_failure_receipt_path_outside_scratch'
    $priorInputLockFull = Assert-E1PathInside $PriorInputLockPath $scratchRoots 'prior_input_lock_path_outside_scratch'
    $priorInspectionFull = Assert-E1PathInside $PriorCreatedInspectionReceiptPath $scratchRoots 'created_inspection_receipt_path_outside_scratch'
    if ($PriorRunnerRequestId -cnotmatch '^req-[A-Za-z0-9-]+$') { throw 'prior_runner_request_id_invalid' }
    $priorRunnerRequestFull = Join-Path $RequiredRunnerQueueRoot "done\$PriorRunnerRequestId.request.json"
    $priorRunnerResponseFull = Join-Path $RequiredRunnerQueueRoot "responses\$PriorRunnerRequestId.response.json"
    $priorRunnerLogFull = Join-Path $RequiredRunnerQueueRoot "logs\$PriorRunnerRequestId.log"
    if ([IO.Path]::GetFullPath($priorFailureFull) -ceq [IO.Path]::GetFullPath($receiptFull)) {
      throw 'prior_failure_receipt_invalid'
    }
    $priorFailureIdentity = Read-E1RetryReceiptIdentity $priorFailureFull
    $priorInputLockIdentity = Read-E1LockedJsonSnapshot $priorInputLockFull 'prior_input_lock'
    $priorInspectionIdentity = Read-E1LockedJsonSnapshot $priorInspectionFull 'created_inspection_receipt'
    $priorRunnerRequestIdentity = Read-E1LockedJsonSnapshot $priorRunnerRequestFull 'prior_runner_request'
    $priorRunnerResponseIdentity = Read-E1LockedJsonSnapshot $priorRunnerResponseFull 'prior_runner_response'
    $priorRunnerLogIdentity = Read-E1LockedTextSnapshot $priorRunnerLogFull 'prior_runner_log'
    if (-not (Test-Path -LiteralPath $credentialFull -PathType Leaf)) { throw 'retry_guest_credential_missing' }
    $priorFailureReceiptSha = [string]$priorFailureIdentity.sha256
    $priorStartCount = 1
    $attemptNumber = 2
  } elseif (Test-Path -LiteralPath $credentialFull) {
    throw 'guest_credential_already_exists'
  }
  $plan = Get-E1ProvisioningPlan $ProfilePath $InputLockPath
  $profile = $plan.profile
  if ([string]$profile.profile_id -cne $RequiredProfileId -or
      [string]$profile.os.installation_boundary -cne 'automated-unattended') {
    throw 'unattended_install_profile_not_allowed'
  }
  Assert-E1Administrator
  Import-Module Hyper-V -ErrorAction Stop
  $vm = Get-VM -Name $profile.vm.name -ErrorAction SilentlyContinue
  if (-not $vm) { throw 'vm_missing' }
  if ([string]$vm.State -cne 'Off') { throw 'vm_must_be_off' }
  $processor = Get-VMProcessor -VM $vm
  $memory = Get-VMMemory -VM $vm
  $firmware = Get-VMFirmware -VM $vm
  $security = Get-VMSecurity -VM $vm
  $profileDrift = @()
  if ($vm.Generation -ne $profile.vm.generation) { $profileDrift += 'generation' }
  if ($processor.Count -ne $profile.vm.processor_count) { $profileDrift += 'processor_count' }
  if ($vm.MemoryStartup -ne $profile.vm.startup_memory_bytes) { $profileDrift += 'startup_memory_bytes' }
  if ([bool]$memory.DynamicMemoryEnabled -ne [bool]$profile.vm.dynamic_memory) { $profileDrift += 'dynamic_memory' }
  if ([bool]$vm.AutomaticCheckpointsEnabled -ne [bool]$profile.vm.automatic_checkpoints) { $profileDrift += 'automatic_checkpoints' }
  if ([string]$vm.CheckpointType -cne [string]$profile.vm.checkpoint_type) { $profileDrift += 'checkpoint_type' }
  if ([string]$firmware.SecureBoot -cne 'On') { $profileDrift += 'secure_boot' }
  if ([bool]$profile.vm.v_tpm -and -not [bool]$security.TpmEnabled) { $profileDrift += 'v_tpm' }
  if ($profileDrift.Count -ne 0) { throw 'vm_profile_drift' }
  if (@(Get-VMSnapshot -VM $vm -ErrorAction Stop).Count -ne 0) { throw 'vm_unexpected_checkpoint' }
  $network = @(Get-VMNetworkAdapter -VM $vm)
  if ($network.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace([string]$network[0].SwitchName)) {
    throw 'vm_network_not_disconnected'
  }
  $disks = @(Get-VMHardDiskDrive -VM $vm)
  if ($disks.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$disks[0].Path)) { throw 'vm_disk_contract_mismatch' }
  $vmRoot = Join-Path ([IO.Path]::GetFullPath([string]$profile.vm.root)) ([string]$profile.vm.name)
  if ($isRetry) {
    $expectedCustodyFull = Join-Path $vmRoot 'custody\unattended-retry-1.custody.json'
    if ([IO.Path]::GetFullPath($PriorFailureCustodyPath) -cne [IO.Path]::GetFullPath($expectedCustodyFull)) {
      throw 'prior_failure_custody_path_invalid'
    }
    $priorCustodyIdentity = Read-E1RetryCustodyIdentity $expectedCustodyFull
    $priorFailureCustodySha = [string]$priorCustodyIdentity.sha256
    $priorFailureCustody = $priorCustodyIdentity.custody
    if ([string]$priorFailureCustody.profile_sha256 -cne (Get-E1Sha256 $ProfilePath) -or
        [string]$priorFailureCustody.current_input_lock_sha256 -cne (Get-E1Sha256 $InputLockPath) -or
        [string]$priorFailureCustody.prior_input_lock_sha256 -cne [string]$priorInputLockIdentity.sha256 -or
        [string]$priorFailureCustody.created_inspection_receipt_sha256 -cne [string]$priorInspectionIdentity.sha256 -or
        [string]$priorFailureCustody.prior_failure_receipt_sha256 -cne $priorFailureReceiptSha -or
        [string]$priorFailureCustody.runner_request_id -cne $PriorRunnerRequestId -or
        [string]$priorFailureCustody.runner_request_sha256 -cne [string]$priorRunnerRequestIdentity.sha256 -or
        [string]$priorFailureCustody.runner_response_sha256 -cne [string]$priorRunnerResponseIdentity.sha256 -or
        [string]$priorFailureCustody.runner_log_sha256 -cne [string]$priorRunnerLogIdentity.sha256 -or
        [string]$priorFailureCustody.guest_credential_sha256 -cne (Get-E1Sha256 $credentialFull) -or
        ([string]$priorFailureCustody.vm_id).ToLowerInvariant() -cne ([string]$vm.Id).ToLowerInvariant()) {
      throw 'prior_failure_custody_binding_mismatch'
    }
  }
  $retryMarkerPath = Join-Path $vmRoot 'custody\unattended-retry-1.consumed.json'
  if ($isRetry -and (Test-Path -LiteralPath $retryMarkerPath)) { throw 'unattended_retry_already_consumed' }
  $expectedVhd = Join-Path $vmRoot "$($profile.vm.name).vhdx"
  $vhdPath = Assert-E1PathInside $disks[0].Path @($vmRoot) 'vm_disk_outside_canonical_root'
  if ([IO.Path]::GetFullPath($vhdPath) -cne [IO.Path]::GetFullPath($expectedVhd)) { throw 'vm_disk_contract_mismatch' }
  $vhd = Get-VHD -Path $vhdPath
  if ($vhd.Size -ne [int64]$profile.vm.vhd_size_bytes -or [string]$vhd.VhdType -cne 'Dynamic') {
    throw 'vm_profile_drift'
  }
  $mountedVhd = Mount-VHD -Path $vhdPath -ReadOnly -Passthru -ErrorAction Stop
  $mountedDisk = $mountedVhd | Get-Disk
  if ([string]$mountedDisk.PartitionStyle -cne 'RAW') { throw 'vm_disk_not_blank' }
  Dismount-VHD -Path $vhdPath -ErrorAction Stop
  $mountedVhd = $null

  $dvdBefore = @(Get-VMDvdDrive -VM $vm)
  if ($dvdBefore.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$dvdBefore[0].Path)) {
    throw 'installation_media_contract_mismatch'
  }
  $expectedIso = Join-Path $vmRoot 'media\windows.iso'
  if ([IO.Path]::GetFullPath([string]$dvdBefore[0].Path) -cne [IO.Path]::GetFullPath($expectedIso)) {
    throw 'installation_media_contract_mismatch'
  }
  if ((Get-Item -LiteralPath $expectedIso).Length -ne [int64]$plan.iso.bytes -or
      (Get-E1Sha256 $expectedIso) -cne [string]$plan.iso.sha256) {
    throw 'installation_media_identity_mismatch'
  }
  $sourceIsoState = Get-DiskImage -ImagePath $expectedIso -ErrorAction Stop
  if ([bool]$sourceIsoState.Attached) { throw 'installation_media_host_mount_conflict' }
  $mountedSourceIso = Mount-DiskImage -ImagePath $expectedIso -Access ReadOnly -PassThru -ErrorAction Stop
  $sourceVolumes = @($mountedSourceIso | Get-Volume | Where-Object DriveLetter)
  if ($sourceVolumes.Count -ne 1) { throw 'installation_media_volume_contract_mismatch' }
  $sourceRoot = "$($sourceVolumes[0].DriveLetter):\"
  if ((Test-Path -LiteralPath (Join-Path $sourceRoot 'Autounattend.xml')) -or
      (Test-Path -LiteralPath (Join-Path $sourceRoot 'Unattend.xml'))) {
    throw 'installation_media_answer_file_conflict'
  }
  Dismount-DiskImage -ImagePath $expectedIso -ErrorAction Stop | Out-Null
  $mountedSourceIso = $null

  $privateRoot = Split-Path -Parent $credentialFull
  $answerParent = Split-Path -Parent $answerMediaFull
  if ([IO.Path]::GetFullPath($privateRoot) -cne [IO.Path]::GetFullPath($answerParent)) {
    throw 'private_state_root_mismatch'
  }
  if ($isRetry) {
    if (-not (Test-Path -LiteralPath $privateRoot -PathType Container)) { throw 'retry_private_state_root_missing' }
  } elseif (Test-Path -LiteralPath $privateRoot) {
    throw 'private_state_root_already_exists'
  } else {
    Assert-E1NoReparsePointAncestors $privateRoot
    New-Item -ItemType Directory -Path $privateRoot | Out-Null
  }
  Assert-E1NoReparsePointAncestors $privateRoot
  Set-E1PrivateDirectoryAcl $privateRoot
  $workDirectory = Join-Path $answerParent ('.e1-unattend-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $workDirectory | Out-Null
  Set-E1PrivateDirectoryAcl $workDirectory

  if ($isRetry) {
    $credential = Import-Clixml -LiteralPath $credentialFull
    if ($credential -isnot [pscredential] -or
        [string]$credential.UserName -cne [string]$profile.guest.local_user) {
      throw 'retry_guest_credential_invalid'
    }
    $securePassword = $credential.Password
    $password = ConvertFrom-E1SecureString $securePassword
  } else {
    $password = New-E1RandomPassword
    $securePassword = ConvertTo-SecureString $password -AsPlainText -Force
    $credential = [pscredential]::new([string]$profile.guest.local_user, $securePassword)
    $credential | Export-Clixml -LiteralPath $credentialFull
  }
  $hiddenPassword = ConvertTo-E1HiddenLocalPassword $password
  $answerXml = New-E1UnattendXml $profile $plan $hiddenPassword
  [xml]$parsedAnswer = $answerXml
  if ($parsedAnswer.DocumentElement.LocalName -cne 'unattend') { throw 'answer_file_invalid_xml' }
  [IO.File]::WriteAllText((Join-Path $workDirectory 'Autounattend.xml'), $answerXml, [Text.UTF8Encoding]::new($false))
  New-E1AnswerIso $workDirectory $answerMediaFull
  $password = $null
  $hiddenPassword = $null
  $answerXml = $null
  $parsedAnswer = $null
  if (-not (Test-Path -LiteralPath $answerMediaFull -PathType Leaf) -or (Get-Item -LiteralPath $answerMediaFull).Length -le 0) {
    throw 'answer_media_creation_failed'
  }

  $answerMediaSha = Get-E1Sha256 $answerMediaFull
  if ([DateTime]::UtcNow -ge $deadlineUtc) { throw 'unattended_install_timeout' }
  $answerDvd = Add-VMDvdDrive -VM $vm -Path $answerMediaFull -Passthru
  $mutationPerformed = $true
  $dvdAfterAttach = @(Get-VMDvdDrive -VM $vm)
  if ($dvdAfterAttach.Count -ne 2 -or @($dvdAfterAttach | Where-Object Path -eq $answerMediaFull).Count -ne 1) {
    throw 'answer_media_attach_failed'
  }
  Set-VMFirmware -VM $vm -FirstBootDevice $dvdBefore[0]
  if ($isRetry) {
    $retryMarkerRoot = Split-Path -Parent $retryMarkerPath
    Assert-E1NoReparsePointAncestors $retryMarkerRoot
    if (-not (Test-Path -LiteralPath $retryMarkerRoot -PathType Container)) {
      New-Item -ItemType Directory -Path $retryMarkerRoot | Out-Null
    }
    Assert-E1NoReparsePointAncestors $retryMarkerRoot
    Set-E1PrivateDirectoryAcl $retryMarkerRoot
    Write-E1RetryMarkerAtomically $retryMarkerPath ([ordered]@{
      schema = 1
      vm_id = ([string]$vm.Id).ToLowerInvariant()
      profile_id = [string]$profile.profile_id
      profile_sha256 = Get-E1Sha256 $ProfilePath
      input_lock_sha256 = Get-E1Sha256 $InputLockPath
      guest_credential_sha256 = Get-E1Sha256 $credentialFull
      prior_failure_receipt_sha256 = $priorFailureReceiptSha
      prior_failure_custody_sha256 = $priorFailureCustodySha
      consumed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      authorized_attempt_number = $attemptNumber
    })
    $retryMarkerCreated = $true
  }
  $startPerformed = $true
  Start-VM -VM $vm | Out-Null
  Invoke-E1BoundedBootKey $vm
  $sessionOptions = New-PSSessionOption -OpenTimeout 5000 -OperationTimeout 10000 -CancelTimeout 5000
  while ([DateTime]::UtcNow -lt $deadlineUtc -and -not $session) {
    $candidateSession = $null
    try {
      $directCredential = [pscredential]::new("$($profile.guest.computer_name)\$($profile.guest.local_user)", $securePassword)
      $candidateSession = New-PSSession -VMId $vm.Id -Credential $directCredential -SessionOption $sessionOptions -ErrorAction Stop
      $oobeComplete = Invoke-Command -Session $candidateSession -ScriptBlock {
        $setupState = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Setup\State' -ErrorAction Stop
        (Test-Path -LiteralPath 'C:\ProgramData\Evidence1\oobe-complete.marker') -and
          [string]$setupState.ImageState -ceq 'IMAGE_STATE_COMPLETE'
      }
      if ($oobeComplete) {
        $session = $candidateSession
        $candidateSession = $null
      } else {
        Remove-PSSession -Session $candidateSession -ErrorAction SilentlyContinue
        $candidateSession = $null
      }
    } catch {
      if ($candidateSession) { Remove-PSSession -Session $candidateSession -ErrorAction SilentlyContinue }
      $candidateSession = $null
    }
    if (-not $session) {
      Start-Sleep -Seconds 10
    }
  }
  if (-not $session) { throw 'unattended_install_timeout' }

  $guest = Invoke-Command -Session $session -ScriptBlock {
    param($Profile)
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    if ($env:COMPUTERNAME -cne [string]$Profile.guest.computer_name) { throw 'guest_computer_identity_mismatch' }
    if ($env:PROCESSOR_ARCHITECTURE -cne 'AMD64') { throw 'guest_os_architecture_mismatch' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.Name.Split('\')[-1] -cne [string]$Profile.guest.local_user) { throw 'guest_user_identity_mismatch' }
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'guest_administrator_required' }
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    if ([string]$os.Caption -notmatch '^Microsoft Windows 11 Pro$') { throw 'guest_os_edition_mismatch' }
    $setupState = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Setup\State' -ErrorAction Stop
    if ([string]$setupState.ImageState -cne 'IMAGE_STATE_COMPLETE' -or
        -not (Test-Path -LiteralPath 'C:\ProgramData\Evidence1\oobe-complete.marker')) {
      throw 'guest_oobe_not_complete'
    }
    $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    Set-ItemProperty -LiteralPath $winlogon -Name AutoAdminLogon -Value '0'
    foreach ($valueName in @('DefaultPassword','DefaultUserName','DefaultDomainName','AutoLogonCount')) {
      Remove-ItemProperty -LiteralPath $winlogon -Name $valueName -Force -ErrorAction SilentlyContinue
    }
    $winlogonAfter = Get-ItemProperty -LiteralPath $winlogon
    $residualAutoLogonValues = @(@('DefaultPassword','AutoLogonCount') | Where-Object {
      $winlogonAfter.PSObject.Properties.Name -contains $_
    })
    if ([string]$winlogonAfter.AutoAdminLogon -ne '0' -or $residualAutoLogonValues.Count -ne 0) {
      throw 'guest_autologon_cleanup_failed'
    }
    $answerCacheRoots = @(
      (Join-Path $env:SystemRoot 'Panther'),
      (Join-Path $env:SystemRoot 'System32\Sysprep'),
      'C:\$Windows.~BT\Sources\Panther'
    )
    $cachedAnswers = @($answerCacheRoots | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object {
      Get-ChildItem -LiteralPath $_ -Filter '*unattend*.xml' -File -Recurse -Force -ErrorAction SilentlyContinue
    })
    foreach ($candidate in $cachedAnswers) {
      Remove-Item -LiteralPath $candidate.FullName -Force -ErrorAction SilentlyContinue
    }
    $cachedAnswersAfter = @($answerCacheRoots | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object {
      Get-ChildItem -LiteralPath $_ -Filter '*unattend*.xml' -File -Recurse -Force -ErrorAction SilentlyContinue
    })
    if ($cachedAnswersAfter.Count -ne 0) {
      throw 'cached_answer_cleanup_failed'
    }
    Remove-Item -LiteralPath 'C:\ProgramData\Evidence1\oobe-complete.marker' -Force -ErrorAction Stop
    [ordered]@{
      computer_name = [string]$env:COMPUTERNAME
      local_user = [string]$Profile.guest.local_user
      user_sid = [string]$identity.User.Value
      os_caption = [string]$os.Caption
      os_version = [string]$os.Version
      os_build = [string]$os.BuildNumber
      architecture = 'x64'
      administrator = $true
      powershell_direct = $true
      cached_answer_files_absent = $true
      autologon_disabled = $true
    }
  } -ArgumentList $profile
  $cachedAnswerFilesAbsent = [bool]$guest.cached_answer_files_absent
  Remove-PSSession -Session $session
  $session = $null

  Remove-VMDvdDrive -VMDvdDrive $answerDvd
  $answerDvd = $null
  $dvdFinal = @(Get-VMDvdDrive -VM $vm)
  if ($dvdFinal.Count -ne 1 -or [IO.Path]::GetFullPath([string]$dvdFinal[0].Path) -cne [IO.Path]::GetFullPath($expectedIso)) {
    throw 'answer_media_detach_failed'
  }
  Remove-Item -LiteralPath $answerMediaFull -Force
  if ($workDirectory -and (Test-Path -LiteralPath $workDirectory)) {
    Remove-Item -LiteralPath $workDirectory -Recurse -Force
  }
  $workDirectory = $null
  $answerMediaDeleted = -not (Test-Path -LiteralPath $answerMediaFull)
  if (-not $answerMediaDeleted) { throw 'answer_media_cleanup_failed' }

  Write-E1ReceiptAtomically $receiptFull ([ordered]@{
    schema = 1; verdict = 'PASS'; profile_id = $profile.profile_id
    profile_sha256 = Get-E1Sha256 $ProfilePath; input_lock_sha256 = Get-E1Sha256 $InputLockPath
    vm_id = ([string]$vm.Id).ToLowerInvariant(); guest_identity = $guest
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    timeout_seconds = $TimeoutSeconds; attempt_number = $attemptNumber
    start_count = $priorStartCount + 1; prior_failure_receipt_sha256 = $priorFailureReceiptSha
    prior_failure_custody_sha256 = $priorFailureCustodySha
    retry_authorization_consumed = [bool]$isRetry; retry_consumption_marker_created = [bool]$retryMarkerCreated
    vm_state = [string](Get-VM -Id $vm.Id).State
    network_state = 'disconnected'; network_used = $false
    answer_media_sha256 = $answerMediaSha; answer_media_contains_reversible_password = $true
    answer_media_deleted = $answerMediaDeleted; cached_answer_files_absent = $cachedAnswerFilesAbsent
    boot_key_attempts = [int]$script:E1BootKeyDiagnostics.attempts
    boot_key_successes = [int]$script:E1BootKeyDiagnostics.successes
    boot_key_last_return_code = $script:E1BootKeyDiagnostics.last_return_code
    boot_key_exception_count = [int]$script:E1BootKeyDiagnostics.exception_count
    guest_credential_storage = 'dpapi-current-user-clixml'; plaintext_credential_persisted = $false
    windows_activation_attempted = $false; generic_edition_selection_key_used = $true
    mutation_performed = $mutationPerformed; private_paths_persisted = $false
    auth_material_copied = $false; auth_material_read = $false
    inference_sessions_consumed = 0; next_phase = 'verify-and-seal-post-os'
  })
  Write-Host "[evidence1-install-windows-unattended] PASS: $receiptFull"
} catch {
  if ($RecoveryOnly) { Fail 'unattended_recovery_failed' }
  $reason = Get-E1ClosedReason ([string]$_.Exception.Message) (@(
    'receipt_path_outside_scratch','receipt_already_exists','guest_credential_path_outside_scratch',
    'answer_media_path_outside_scratch','guest_credential_already_exists','answer_media_already_exists',
    'prior_failure_receipt_path_outside_scratch','prior_failure_receipt_missing','prior_failure_receipt_invalid_json',
    'prior_failure_receipt_invalid','prior_failure_custody_path_invalid','prior_failure_custody_missing',
    'prior_failure_custody_invalid_json','prior_failure_custody_missing_property','prior_failure_custody_invalid',
    'prior_failure_custody_binding_mismatch','prior_input_lock_path_outside_scratch','prior_input_lock_missing',
    'prior_input_lock_invalid_json','created_inspection_receipt_path_outside_scratch','created_inspection_receipt_missing',
    'created_inspection_receipt_invalid_json','prior_runner_request_id_invalid','prior_runner_request_missing',
    'prior_runner_request_invalid_json','prior_runner_response_missing',
    'prior_runner_response_invalid_json','prior_runner_log_missing',
    'prior_runner_log_invalid','retry_guest_credential_missing','retry_guest_credential_invalid',
    'retry_private_state_root_missing','unattended_retry_already_consumed','exact_unattended_install_authorization_required',
    'exact_unattended_retry_authorization_required','profile_missing','profile_invalid_json','profile_identity_mismatch',
    'profile_contract_mismatch','input_lock_missing','input_lock_invalid_json','input_lock_contract_mismatch',
    'iso_missing','iso_size_mismatch','iso_hash_mismatch','artifact_cardinality_mismatch','artifact_identity_mismatch',
    'unattended_install_profile_not_allowed','administrator_required','vm_missing','vm_must_be_off',
    'vm_profile_drift','vm_unexpected_checkpoint','vm_network_not_disconnected','vm_disk_contract_mismatch',
    'vm_disk_outside_canonical_root','vm_disk_not_blank','private_state_root_mismatch',
    'private_state_root_already_exists','private_state_reparse_point',
    'vm_disk_too_small_for_partition_contract','installation_media_contract_mismatch','installation_media_identity_mismatch',
    'installation_media_host_mount_conflict','installation_media_volume_contract_mismatch',
    'installation_media_answer_file_conflict','answer_file_invalid_xml',
    'answer_media_creation_failed','answer_media_attach_failed','unattended_install_timeout',
    'vm_keyboard_system_not_found','vm_keyboard_not_found','vm_boot_key_injection_failed',
    'guest_computer_identity_mismatch','guest_os_architecture_mismatch','guest_user_identity_mismatch',
    'guest_administrator_required','guest_os_edition_mismatch','guest_oobe_not_complete',
    'guest_autologon_cleanup_failed','cached_answer_cleanup_failed',
    'answer_media_detach_failed','answer_media_cleanup_failed'
  ) + @(Get-E1HostDependencyFailureCodes)) 'unattended_install_failed'
  $cleanupFailures = @()
  if ($session) {
    try { Remove-PSSession -Session $session -ErrorAction Stop } catch { $cleanupFailures += 'pssession' }
    $session = $null
  }
  $vmStopped = $true
  if (Get-Variable vm -ErrorAction SilentlyContinue) {
    $stopJob = $null
    try {
      $currentVm = Get-VM -Id $vm.Id -ErrorAction Stop
      if ([string]$currentVm.State -cne 'Off') {
        $stopJob = Stop-VM -VM $currentVm -TurnOff -Force -AsJob -ErrorAction Stop
        if (-not (Wait-Job -Job $stopJob -Timeout 30)) {
          Stop-Job -Job $stopJob -ErrorAction SilentlyContinue
          $cleanupFailures += 'vm_stop_timeout'
        } else {
          Receive-Job -Job $stopJob -ErrorAction Stop | Out-Null
        }
      }
    } catch {
      $cleanupFailures += 'vm_stop_command'
    } finally {
      if ($stopJob) { Remove-Job -Job $stopJob -Force -ErrorAction SilentlyContinue }
    }
    try {
      $stopDeadline = [DateTime]::UtcNow.AddSeconds(30)
      do {
        $currentVm = Get-VM -Id $vm.Id -ErrorAction Stop
        if ([string]$currentVm.State -ceq 'Off') { break }
        Start-Sleep -Seconds 1
      } while ([DateTime]::UtcNow -lt $stopDeadline)
      $vmStopped = [string]$currentVm.State -ceq 'Off'
      if (-not $vmStopped) { $cleanupFailures += 'vm_stop_not_observed' }
    } catch {
      $vmStopped = $false
      $cleanupFailures += 'vm_stop_observation'
    }
  }
  if ($vmStopped) {
    try {
      if ((Get-Variable vm -ErrorAction SilentlyContinue) -and (Get-Variable answerMediaFull -ErrorAction SilentlyContinue)) {
        $attachedAnswerMedia = @(Get-VMDvdDrive -VM $vm -ErrorAction Stop | Where-Object {
          $_.Path -and [IO.Path]::GetFullPath([string]$_.Path) -ceq [IO.Path]::GetFullPath($answerMediaFull)
        })
        foreach ($drive in $attachedAnswerMedia) { Remove-VMDvdDrive -VMDvdDrive $drive -ErrorAction Stop }
      }
      $answerDvd = $null
    } catch { $cleanupFailures += 'answer_media_detach' }
    try {
      if ((Get-Variable answerMediaFull -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $answerMediaFull)) {
        Remove-Item -LiteralPath $answerMediaFull -Force -ErrorAction Stop
      }
    } catch { $cleanupFailures += 'answer_media_delete' }
    try {
      if ($workDirectory -and (Test-Path -LiteralPath $workDirectory)) {
        Remove-Item -LiteralPath $workDirectory -Recurse -Force -ErrorAction Stop
      }
      $workDirectory = $null
    } catch { $cleanupFailures += 'answer_work_delete' }
    try {
      if (-not $isRetry -and -not $startPerformed -and (Get-Variable credentialFull -ErrorAction SilentlyContinue) -and
          (Test-Path -LiteralPath $credentialFull)) {
        Remove-Item -LiteralPath $credentialFull -Force -ErrorAction Stop
      }
    } catch { $cleanupFailures += 'credential_delete' }
    try {
      if (-not $isRetry -and -not $startPerformed -and $privateRoot -and (Test-Path -LiteralPath $privateRoot) -and
          @(Get-ChildItem -LiteralPath $privateRoot -Force -ErrorAction Stop).Count -eq 0) {
        Remove-Item -LiteralPath $privateRoot -Force -ErrorAction Stop
      }
    } catch { $cleanupFailures += 'private_root_delete' }
  }
  $answerMediaDeleted = if (Get-Variable answerMediaFull -ErrorAction SilentlyContinue) {
    -not (Test-Path -LiteralPath $answerMediaFull)
  } else { $true }
  $workDirectoryDeleted = -not $workDirectory -or -not (Test-Path -LiteralPath $workDirectory)
  if (-not $workDirectoryDeleted) { $cleanupFailures += 'answer_work_residual' }
  $guestCredentialPreserved = if ((Get-Variable credentialFull -ErrorAction SilentlyContinue)) {
    Test-Path -LiteralPath $credentialFull -PathType Leaf
  } else { $false }
  if (-not $isRetry -and -not $startPerformed -and $privateRoot -and (Test-Path -LiteralPath $privateRoot)) {
    $cleanupFailures += 'private_root_residual'
  }
  $cleanupAttestation = Get-E1FailureCleanupAttestation $startPerformed $vmStopped $answerMediaDeleted `
    $workDirectoryDeleted $cachedAnswerFilesAbsent $guestCredentialPreserved $cleanupFailures
  $hostCleanupComplete = [bool]$cleanupAttestation.host_cleanup_complete
  $failureCleanupComplete = [bool]$cleanupAttestation.failure_cleanup_complete
  try {
    $receiptFull = New-E1ReceiptPath $ReceiptPath 'windows-unattended-install-failed'
    Write-E1ReceiptAtomically $receiptFull ([ordered]@{
      schema = 1; verdict = 'FAIL'; reason_code = $reason
      generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      profile_id = if ((Get-Variable profile -ErrorAction SilentlyContinue)) { [string]$profile.profile_id } else { $null }
      profile_sha256 = Get-E1Sha256OrNull $ProfilePath
      input_lock_sha256 = Get-E1Sha256OrNull $InputLockPath
      vm_id = if ((Get-Variable vm -ErrorAction SilentlyContinue)) { ([string]$vm.Id).ToLowerInvariant() } else { $null }
      guest_credential_sha256 = if (Get-Variable credentialFull -ErrorAction SilentlyContinue) {
        Get-E1Sha256OrNull $credentialFull
      } else { $null }
      attempt_number = $attemptNumber
      start_count = $priorStartCount + $(if ($startPerformed) { 1 } else { 0 })
      prior_failure_receipt_sha256 = $priorFailureReceiptSha
      prior_failure_custody_sha256 = $priorFailureCustodySha
      retry_authorization_consumed = [bool]($isRetry -and $startPerformed)
      retry_consumption_marker_created = [bool]$retryMarkerCreated; network_used = $false
      vm_state = if ((Get-Variable vm -ErrorAction SilentlyContinue)) { [string](Get-VM -Id $vm.Id -ErrorAction SilentlyContinue).State } else { $null }
      answer_media_deleted = $answerMediaDeleted
      boot_key_attempts = if (Get-Variable E1BootKeyDiagnostics -Scope Script -ErrorAction SilentlyContinue) { [int]$script:E1BootKeyDiagnostics.attempts } else { 0 }
      boot_key_successes = if (Get-Variable E1BootKeyDiagnostics -Scope Script -ErrorAction SilentlyContinue) { [int]$script:E1BootKeyDiagnostics.successes } else { 0 }
      boot_key_last_return_code = if (Get-Variable E1BootKeyDiagnostics -Scope Script -ErrorAction SilentlyContinue) { $script:E1BootKeyDiagnostics.last_return_code } else { $null }
      boot_key_exception_count = if (Get-Variable E1BootKeyDiagnostics -Scope Script -ErrorAction SilentlyContinue) { [int]$script:E1BootKeyDiagnostics.exception_count } else { 0 }
      cached_answer_files_absent = if ($cachedAnswerFilesAbsent) { $true } else { $null }
      guest_cached_answer_state = [string]$cleanupAttestation.guest_cached_answer_state
      host_cleanup_complete = $hostCleanupComplete
      failure_cleanup_complete = $failureCleanupComplete
      cleanup_failure_codes = @($cleanupFailures)
      guest_credential_preserved = [bool]$cleanupAttestation.guest_credential_preserved
      retry_authorized = [bool]$cleanupAttestation.retry_authorized
      credential_value_persisted_in_receipt = $false; private_paths_persisted = $false
      mutation_performed = $mutationPerformed; inference_sessions_consumed = 0
    })
  } catch { }
  Fail $reason
} finally {
  if ($session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
  if ($mountedVhd) { Dismount-VHD -Path $mountedVhd.Path -ErrorAction SilentlyContinue }
  if ($mountedSourceIso) { Dismount-DiskImage -ImagePath $mountedSourceIso.ImagePath -ErrorAction SilentlyContinue | Out-Null }
}

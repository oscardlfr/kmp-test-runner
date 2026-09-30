param(
  [ValidateSet('Validate', 'Create', 'InspectCreated', 'InspectInstalled')]
  [string]$Mode = 'Validate',
  [string]$ProfilePath = '',
  [Parameter(Mandatory = $true)]
  [string]$InputLockPath,
  [string]$ReceiptPath = '',
  [string]$CreateAuthorizationPhrase = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RequiredCreatePhrase = 'authorize create evidence1 windows vm from verified inputs'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ProfilePath)) { $ProfilePath = Join-Path $scriptRoot 'evidence1-windows-hyperv-v1.json' }
Import-Module (Join-Path $scriptRoot 'Evidence1.Provisioning.psm1') -Force

function Fail($Code) { Write-Error "HARD STOP: $Code"; exit 1 }
$mutationPerformed = $false
$mountedIso = $null
$mountedVhdInspect = $null
$plan = $null
$hostDependencyRoot = $null
function Quote-E1VmNativeArgument([string]$Value) {
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}
function Invoke-E1VmDismImageInfo([string]$DismPath, [string]$ImagePath, [int]$Index, $ExpectedImage, [string]$LogRoot) {
  $process = $null
  try {
    $arguments = @('/English','/Get-ImageInfo',"/ImageFile:$ImagePath","/Index:$Index")
    $argumentLine = (@($arguments) | ForEach-Object { Quote-E1VmNativeArgument ([string]$_) }) -join ' '
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $DismPath
    $startInfo.Arguments = $argumentLine
    $startInfo.WorkingDirectory = Split-Path -Parent $DismPath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'dism_image_info_failed' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(180000)) {
      try { $process.Kill() } catch { }
      throw 'dism_image_info_deadline_exceeded'
    }
    $process.WaitForExit()
    $process.Refresh()
    $stdoutText = [string]$stdoutTask.Result
    $stderrText = [string]$stderrTask.Result
    $stdoutBytes = [Text.UTF8Encoding]::new($false).GetByteCount($stdoutText)
    $stderrBytes = [Text.UTF8Encoding]::new($false).GetByteCount($stderrText)
    if ($stdoutBytes -gt 1MB -or $stderrBytes -gt 1MB) { throw 'dism_image_info_output_too_large' }
    if ($process.ExitCode -ne 0) { throw 'dism_image_info_failed' }
    return ConvertFrom-E1DismImageInfo $stdoutText $ExpectedImage
  } finally {
    if ($process) { $process.Dispose() }
  }
}
function Inspect-WindowsIsoImage([string]$IsoPath, $ExpectedImage, $HostDependency) {
  Assert-E1ExactProperties $ExpectedImage @('index','name','edition','edition_id','architecture','languages','version','installation_type') 'approved_iso_image'
  Assert-E1RequiredProperties $ExpectedImage @('index','name','edition','edition_id','architecture','languages','version','installation_type') 'approved_iso_image'
  $resolvedHostDependency = $null
  if ($HostDependency) {
    $script:hostDependencyRoot = Join-Path 'C:\kmp-eval\scratch\evidence1-host-dependencies' ([guid]::NewGuid().ToString('N'))
    $resolvedHostDependency = Expand-E1VerifiedHostDependency $HostDependency $script:hostDependencyRoot
  } else {
    Import-Module Dism -ErrorAction Stop
  }
  $script:mountedIso = Mount-DiskImage -ImagePath $IsoPath -Access ReadOnly -PassThru -ErrorAction Stop
  $volume = $script:mountedIso | Get-Volume | Where-Object DriveLetter | Select-Object -First 1
  if (-not $volume) { throw 'iso_volume_missing' }
  $installImage = @(
    "$($volume.DriveLetter):\sources\install.wim",
    "$($volume.DriveLetter):\sources\install.esd"
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $installImage) { throw 'iso_install_image_missing' }
  if ($resolvedHostDependency) {
    $imageIdentity = Invoke-E1VmDismImageInfo $resolvedHostDependency.executable_path $installImage `
      ([int]$ExpectedImage.index) $ExpectedImage $script:hostDependencyRoot
    $null = Assert-E1ExpandedHostDependency $HostDependency $resolvedHostDependency.root_path
  } else {
    $image = Get-WindowsImage -ImagePath $installImage -Index ([int]$ExpectedImage.index) -ErrorAction Stop
    $architecture = [string]$image.Architecture
    $version = '{0}.{1}.{2}.{3}' -f ([uint32]$image.MajorVersion),([uint32]$image.MinorVersion),([uint32]$image.Build),([uint32]$image.SPBuild)
    $languageValues = @($image.Languages | ForEach-Object { [string]$_ } | Sort-Object)
    $expectedLanguages = @($ExpectedImage.languages | ForEach-Object { [string]$_ } | Sort-Object)
    if ([string]$ExpectedImage.edition -cne 'Windows 11 Pro' -or
        $image.ImageIndex -ne [int]$ExpectedImage.index -or [string]$image.ImageName -cne [string]$ExpectedImage.name -or
        [string]$image.EditionId -cne [string]$ExpectedImage.edition_id -or
        $architecture -notin @('9','x64','amd64') -or [string]$ExpectedImage.architecture -cne 'x64' -or
        $version -cne [string]$ExpectedImage.version -or
        [string]$image.InstallationType -cne [string]$ExpectedImage.installation_type -or
        (($languageValues -join "`n") -cne ($expectedLanguages -join "`n"))) {
      throw 'iso_image_metadata_mismatch'
    }
    $imageIdentity = [ordered]@{
      index = [int]$image.ImageIndex; name = [string]$image.ImageName; edition_id = [string]$image.EditionId
      architecture = 'x64'; languages = $languageValues; version = $version
      installation_type = [string]$image.InstallationType
    }
  }
  Dismount-DiskImage -ImagePath $IsoPath -ErrorAction Stop | Out-Null
  $script:mountedIso = $null
  if ($script:hostDependencyRoot -and (Test-Path -LiteralPath $script:hostDependencyRoot)) {
    Remove-Item -LiteralPath $script:hostDependencyRoot -Recurse -Force -ErrorAction Stop
    $script:hostDependencyRoot = $null
  }
  return $imageIdentity
}
try {
  $receiptFull = New-E1ReceiptPath $ReceiptPath ("vm-" + $Mode.ToLowerInvariant())
  $plan = Get-E1ProvisioningPlan $ProfilePath $InputLockPath
  $profile = $plan.profile
  $profileSha = Get-E1Sha256 $ProfilePath
  $inputLockSha = Get-E1Sha256 $InputLockPath
  $safeInputs = [ordered]@{
    input_lock_sha256 = $inputLockSha
    iso = [ordered]@{ sha256 = $plan.iso.sha256; bytes = $plan.iso.bytes }
    artifacts = @($plan.artifacts | ForEach-Object { [ordered]@{ id = $_.id; sha256 = $_.sha256; bytes = $_.bytes } })
    private_paths_persisted = $false
  }
  if (@($plan.host_dependencies).Count -gt 0) {
    $safeInputs.host_dependencies = @($plan.host_dependencies | ForEach-Object {
      [ordered]@{ id = $_.id; runtime_version = $_.runtime_version; archive_sha256 = $_.archive_sha256; archive_bytes = $_.archive_bytes; executable_sha256 = $_.executable_sha256; tree_sha256 = $_.tree_sha256 }
    })
  }
  if ($Mode -ceq 'Validate') {
    Write-E1ReceiptAtomically $receiptFull ([ordered]@{
      schema = 1; verdict = 'PASS'; mode = 'Validate'; profile_id = $profile.profile_id
      profile_sha256 = $profileSha
      generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      inputs = $safeInputs; mutation_performed = $false; inference_sessions_consumed = 0
    })
    Write-Host "[evidence1-windows-vm] VALIDATE PASS: $receiptFull"
    exit 0
  }

  Assert-E1Administrator
  Import-Module Hyper-V -ErrorAction Stop
  $vmName = [string]$profile.vm.name
  $existing = Get-VM -Name $vmName -ErrorAction SilentlyContinue
  if ($Mode -ceq 'Create') {
    if ($CreateAuthorizationPhrase -cne $RequiredCreatePhrase) { throw 'exact_create_authorization_required' }
    if ($existing) { throw 'vm_already_exists' }
    if ($profile.network.create_state -cne 'disconnected') { throw 'create_network_contract_invalid' }
    $vmRoot = [IO.Path]::GetFullPath([string]$profile.vm.root)
    $vmDir = Join-Path $vmRoot $vmName
    if (Test-Path -LiteralPath $vmDir) { throw 'vm_directory_already_exists' }
    $hostDependencies = @($plan.host_dependencies)
    if ($profile.os.installation_boundary -ceq 'offline-apply' -and $hostDependencies.Count -ne 1) { throw 'host_dependency_missing' }
    $hostDependency = if ($hostDependencies.Count -eq 1) { $hostDependencies[0] } else { $null }
    $inspectedImage = Inspect-WindowsIsoImage $plan.iso.source_path $plan.approved_manifest.iso_image $hostDependency
    New-Item -ItemType Directory -Path $vmDir | Out-Null
    $mutationPerformed = $true
    $mediaDir = Join-Path $vmDir 'media'
    New-Item -ItemType Directory -Path $mediaDir | Out-Null
    $sealedIsoPath = Join-Path $mediaDir 'windows.iso'
    Copy-Item -LiteralPath $plan.iso.source_path -Destination $sealedIsoPath
    Get-E1FileIdentity $sealedIsoPath $plan.iso.sha256 ([int64]$plan.iso.bytes) 'sealed_iso' | Out-Null
    $vhdPath = Join-Path $vmDir "$vmName.vhdx"
    $createdVhd = New-VHD -Path $vhdPath -Dynamic -SizeBytes ([int64]$profile.vm.vhd_size_bytes)
    $createdVm = New-VM -Name $vmName -Generation ([int]$profile.vm.generation) `
      -MemoryStartupBytes ([int64]$profile.vm.startup_memory_bytes) -VHDPath $createdVhd.Path -Path $vmDir
    Set-VM -VM $createdVm -AutomaticCheckpointsEnabled ([bool]$profile.vm.automatic_checkpoints) `
      -CheckpointType $profile.vm.checkpoint_type
    Set-VMMemory -VM $createdVm -DynamicMemoryEnabled ([bool]$profile.vm.dynamic_memory) `
      -StartupBytes ([int64]$profile.vm.startup_memory_bytes)
    Set-VMProcessor -VM $createdVm -Count ([int]$profile.vm.processor_count)
    Set-VMFirmware -VM $createdVm -EnableSecureBoot On -SecureBootTemplate $profile.vm.secure_boot_template
    if ($profile.vm.v_tpm) { Set-VMKeyProtector -VM $createdVm -NewLocalKeyProtector; Enable-VMTPM -VM $createdVm }
    $dvd = Add-VMDvdDrive -VM $createdVm -Path $sealedIsoPath -Passthru
    Set-VMFirmware -VM $createdVm -FirstBootDevice $dvd
    $createdAdapters = @(Get-VMNetworkAdapter -VM $createdVm)
    if ($createdAdapters.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace([string]$createdAdapters[0].SwitchName)) {
      throw 'created_vm_network_not_disconnected'
    }
    Write-E1ReceiptAtomically $receiptFull ([ordered]@{
      schema = 1; verdict = 'PASS'; mode = 'Create'; profile_id = $profile.profile_id
      profile_sha256 = $profileSha; input_lock_sha256 = $inputLockSha
      generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      vm = [ordered]@{
        id = ([string]$createdVm.Id).ToLowerInvariant(); name = $vmName; state = [string]$createdVm.State
        generation = $profile.vm.generation; processor_count = $profile.vm.processor_count
        startup_memory_bytes = $profile.vm.startup_memory_bytes; dynamic_memory = [bool]$profile.vm.dynamic_memory
        vhd_size_bytes = $profile.vm.vhd_size_bytes; vhd_type = 'Dynamic'
        secure_boot = $true; secure_boot_template = [string]$profile.vm.secure_boot_template
        v_tpm = [bool]$profile.vm.v_tpm; automatic_checkpoints = [bool]$profile.vm.automatic_checkpoints
        checkpoint_type = [string]$profile.vm.checkpoint_type; network_state = 'disconnected'; started = $false
      }
      inputs = $safeInputs; mutation_performed = $true; existing_vm_replaced = $false
      os_image = $inspectedImage; host_iso_mounted_after_operation = $false
      next_phase = if ([string]$profile.os.installation_boundary -ceq 'offline-apply') { 'apply-os-offline' } else { 'operator-install-os' }
      inference_sessions_consumed = 0
    })
    Write-Host "[evidence1-windows-vm] CREATE PASS: $receiptFull"
    exit 0
  }

  if (-not $existing) { throw 'vm_missing' }
  $firmware = Get-VMFirmware -VM $existing
  $processor = Get-VMProcessor -VM $existing
  $memory = Get-VMMemory -VM $existing
  $security = Get-VMSecurity -VM $existing
  $hardDisks = @(Get-VMHardDiskDrive -VM $existing)
  $dvdDrives = @(Get-VMDvdDrive -VM $existing)
  $networkAdapters = @(Get-VMNetworkAdapter -VM $existing)
  $drift = @()
  $vhdPartitionStyle = $null
  if ([string]$existing.State -cne 'Off') { $drift += 'vm_state' }
  if ($existing.Generation -ne $profile.vm.generation) { $drift += 'generation' }
  if ($processor.Count -ne $profile.vm.processor_count) { $drift += 'processor_count' }
  if ($existing.MemoryStartup -ne $profile.vm.startup_memory_bytes) { $drift += 'startup_memory_bytes' }
  if ([bool]$memory.DynamicMemoryEnabled -ne [bool]$profile.vm.dynamic_memory) { $drift += 'dynamic_memory' }
  if ([bool]$existing.AutomaticCheckpointsEnabled -ne [bool]$profile.vm.automatic_checkpoints) { $drift += 'automatic_checkpoints' }
  if ([string]$existing.CheckpointType -cne [string]$profile.vm.checkpoint_type) { $drift += 'checkpoint_type' }
  if ($firmware.SecureBoot -ne 'On') { $drift += 'secure_boot' }
  if ($profile.vm.v_tpm -and -not $security.TpmEnabled) { $drift += 'v_tpm' }
  if ($hardDisks.Count -ne 1) {
    $drift += 'hard_disk_count'
  } else {
    try {
      $expectedVhd = Join-Path (Join-Path ([IO.Path]::GetFullPath([string]$profile.vm.root)) $profile.vm.name) "$($profile.vm.name).vhdx"
      if ([IO.Path]::GetFullPath($hardDisks[0].Path) -cne $expectedVhd) { $drift += 'vhd_path' }
      $vhd = Get-VHD -Path $hardDisks[0].Path
      if ($vhd.Size -ne $profile.vm.vhd_size_bytes) { $drift += 'vhd_size_bytes' }
      if ([string]$vhd.VhdType -cne 'Dynamic') { $drift += 'vhd_type' }
      if ($Mode -ceq 'InspectCreated') {
        $mountedVhdInspect = Mount-VHD -Path $hardDisks[0].Path -ReadOnly -Passthru -ErrorAction Stop
        $inspectionDisk = Get-Disk -Number $mountedVhdInspect.DiskNumber -ErrorAction Stop
        $vhdPartitionStyle = [string]$inspectionDisk.PartitionStyle
        if ($vhdPartitionStyle -cne 'RAW') { $drift += 'vhd_partition_style' }
        Dismount-VHD -Path $hardDisks[0].Path -ErrorAction Stop
        $mountedVhdInspect = $null
      }
    } catch { $drift += 'vhd_inspection' }
  }
  if ($Mode -ceq 'InspectCreated') {
    if ($dvdDrives.Count -ne 1 -or -not $dvdDrives[0].Path) {
      $drift += 'installation_media'
    } else {
      try {
        $expectedIso = Join-Path (Join-Path (Join-Path ([IO.Path]::GetFullPath([string]$profile.vm.root)) $profile.vm.name) 'media') 'windows.iso'
        if ([IO.Path]::GetFullPath([string]$dvdDrives[0].Path) -cne $expectedIso) { $drift += 'installation_media_path' }
        Get-E1FileIdentity $dvdDrives[0].Path $plan.iso.sha256 ([int64]$plan.iso.bytes) 'mounted_iso' | Out-Null
      }
      catch { $drift += 'installation_media_identity' }
    }
  } elseif ($dvdDrives.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace([string]$dvdDrives[0].Path)) {
    $drift += 'installation_media_not_ejected'
  }
  if ($networkAdapters.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace([string]$networkAdapters[0].SwitchName)) {
    $drift += 'network_not_disconnected'
  }
  Write-E1ReceiptAtomically $receiptFull ([ordered]@{
    schema = 1; verdict = if ($drift.Count -eq 0) { 'PASS' } else { 'FAIL' }; mode = $Mode
    profile_id = $profile.profile_id; generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    profile_sha256 = $profileSha; input_lock_sha256 = $inputLockSha
    vm_id = ([string]$existing.Id).ToLowerInvariant()
    vm_state = [string]$existing.State
    vhd_partition_style = $vhdPartitionStyle
    network_state = if ($networkAdapters.Count -eq 1 -and [string]::IsNullOrWhiteSpace([string]$networkAdapters[0].SwitchName)) { 'disconnected' } else { 'connected-or-invalid' }
    original_iso_is_only_dvd = [bool]($Mode -ceq 'InspectCreated' -and $dvdDrives.Count -eq 1 -and -not [string]::IsNullOrWhiteSpace([string]$dvdDrives[0].Path))
    drift_fields = $drift; mutation_performed = $false; inputs = $safeInputs; inference_sessions_consumed = 0
  })
  if ($drift.Count -gt 0) { throw 'vm_profile_drift' }
  Write-Host "[evidence1-windows-vm] $Mode PASS: $receiptFull"
} catch {
  $candidate = [string]$_.Exception.Message
  $closedCodes = @(
    'profile_missing','profile_invalid_json','profile_identity_mismatch','input_lock_missing','input_lock_invalid_json',
    'input_lock_unknown_property','input_lock_missing_property',
    'profile_contract_mismatch','input_lock_contract_mismatch','iso_unknown_property','iso_identity_invalid','iso_missing',
    'iso_missing_property','iso_size_mismatch','iso_hash_mismatch','sealed_iso_missing','sealed_iso_size_mismatch',
    'sealed_iso_hash_mismatch','approved_manifest_unknown_property','approved_manifest_missing_property',
    'approved_manifest_identity_invalid','approved_manifest_path_invalid','approved_manifest_hash_mismatch',
    'approved_manifest_git_unavailable','approved_manifest_not_head_tracked_clean','approved_manifest_contract_mismatch',
    'approved_manifest_sealed_identity_mismatch',
    'approved_iso_unknown_property','approved_iso_missing_property','approved_iso_identity_invalid',
    'approved_iso_image_unknown_property','approved_iso_image_missing_property','iso_volume_missing',
    'iso_install_image_missing','iso_image_metadata_mismatch','approved_artifact_cardinality_mismatch',
    'approved_artifact_unknown_property','approved_artifact_missing_property','approved_artifact_identity_mismatch',
    'approved_artifact_source_unknown_property','approved_artifact_source_missing_property',
    'approved_artifact_source_identity_invalid','approved_artifact_verification_unknown_property',
    'approved_artifact_verification_missing_property',
    'artifact_cardinality_mismatch','artifact_unknown_property',
    'artifact_missing_property',
    'artifact_identity_mismatch','artifact_identity_invalid','host_dependency_contract_mismatch','host_dependency_cardinality_mismatch',
    'profile_host_dependency_unknown_property','profile_host_dependency_missing_property','host_dependency_lock_unknown_property',
    'host_dependency_lock_missing_property','host_dependency_identity_mismatch','approved_host_dependency_unknown_property',
    'approved_host_dependency_missing_property','approved_host_dependency_identity_mismatch',
    'approved_host_dependency_verification_unknown_property','approved_host_dependency_verification_missing_property',
    'approved_host_dependency_source_unknown_property','approved_host_dependency_source_missing_property',
    'approved_host_dependency_source_identity_invalid','host_dependency_missing','host_dependency_archive_missing',
    'host_dependency_archive_size_mismatch','host_dependency_archive_hash_mismatch','host_dependency_destination_exists',
    'host_dependency_archive_bounds_invalid','host_dependency_archive_path_invalid','host_dependency_tree_missing','host_dependency_tree_format_invalid',
    'host_dependency_tree_mismatch','host_dependency_reparse_rejected','host_dependency_command_path_invalid',
    'host_dependency_executable_missing','host_dependency_executable_size_mismatch','host_dependency_executable_hash_mismatch',
    'host_dependency_version_mismatch','host_dependency_architecture_invalid','host_dependency_signature_invalid',
    'host_dependency_publisher_mismatch','iso_image_metadata_invalid','dism_image_info_failed',
    'dism_image_info_deadline_exceeded','dism_image_info_output_too_large','administrator_required','exact_create_authorization_required',
    'vm_already_exists','vm_directory_already_exists','vm_missing','create_network_contract_invalid',
    'created_vm_network_not_disconnected','vm_profile_drift','receipt_path_outside_scratch','receipt_already_exists'
  )
  $reason = Get-E1ClosedReason $candidate $closedCodes 'provisioning_failed'
  try {
    $receiptFull = New-E1ReceiptPath $ReceiptPath ("vm-" + $Mode.ToLowerInvariant() + '-failed')
    Write-E1ReceiptAtomically $receiptFull ([ordered]@{
      schema = 1; verdict = 'FAIL'; mode = $Mode; reason_code = $reason
      generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      mutation_performed = $mutationPerformed; private_paths_persisted = $false; inference_sessions_consumed = 0
    })
  } catch { }
  Fail $reason
} finally {
  if ($mountedVhdInspect) {
    try { Dismount-VHD -Path $mountedVhdInspect.Path -ErrorAction Stop } catch { }
  }
  if ($mountedIso -and $plan) {
    try { Dismount-DiskImage -ImagePath $plan.iso.source_path -ErrorAction Stop | Out-Null } catch { }
  }
  if ($hostDependencyRoot -and (Test-Path -LiteralPath $hostDependencyRoot)) {
    try { Remove-Item -LiteralPath $hostDependencyRoot -Recurse -Force -ErrorAction Stop } catch { }
  }
}

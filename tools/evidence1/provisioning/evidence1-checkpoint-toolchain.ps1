param(
  [string]$ProfilePath = '',
  [Parameter(Mandatory = $true)] [string]$InputLockPath,
  [Parameter(Mandatory = $true)] [string]$ToolchainReceiptPath,
  [string]$ReceiptPath = '',
  [string]$AuthorizationPhrase = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RequiredAuthorizationPhrase = 'authorize checkpoint verified evidence1 toolchain without auth'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ProfilePath)) { $ProfilePath = Join-Path $scriptRoot 'evidence1-windows-hyperv-v1.json' }
Import-Module (Join-Path $scriptRoot 'Evidence1.Provisioning.psm1') -Force

function Fail([string]$Code) { Write-Error "HARD STOP: $Code"; exit 1 }
function Get-MountedGuestPath([string]$DriveRoot, [string]$GuestPath) {
  if ($GuestPath -notmatch '^[Cc]:\\') { throw 'guest_path_contract_mismatch' }
  return Join-Path $DriveRoot $GuestPath.Substring(3)
}

function Get-MountedTreeIdentity([string]$Root) {
  $files = @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File | Where-Object Name -ne '.evidence1-artifact.json' | Sort-Object FullName)
  $builder = [Text.StringBuilder]::new()
  [int64]$totalBytes = 0
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($Root.Length).TrimStart('\').Replace('\','/')
    $null = $builder.Append($relative).Append("`0").Append($file.Length).Append("`0").Append((Get-E1Sha256 $file.FullName)).Append("`n")
    $totalBytes += $file.Length
  }
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $digest = $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($builder.ToString())) }
  finally { $algorithm.Dispose() }
  return [ordered]@{
    sha256 = ([BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant()
    file_count = $files.Count
    bytes = $totalBytes
  }
}

$mounted = $null
$mutationPerformed = $false
try {
  $scratchRoots = @('C:\kmp-eval\scratch', [IO.Path]::GetTempPath())
  $receiptFull = New-E1ReceiptPath $ReceiptPath 'checkpoint-toolchain'
  $toolchainReceiptFull = Assert-E1PathInside $ToolchainReceiptPath $scratchRoots 'toolchain_receipt_path_outside_scratch'
  if ($AuthorizationPhrase -cne $RequiredAuthorizationPhrase) { throw 'exact_checkpoint_authorization_required' }
  Assert-E1Administrator
$plan = Get-E1ProvisioningPlan $ProfilePath $InputLockPath -AllowSealedRuntimeCommitDrift
  $profile = $plan.profile
  $profileSha = Get-E1Sha256 $ProfilePath
  $inputLockSha = Get-E1Sha256 $InputLockPath
  $toolchainReceipt = Read-E1Json $toolchainReceiptFull 'toolchain_receipt'

  Import-Module Hyper-V -ErrorAction Stop
  $vm = Get-VM -Name $profile.vm.name -ErrorAction SilentlyContinue
  if (-not $vm) { throw 'vm_missing' }
  $vmId = ([string]$vm.Id).ToLowerInvariant()
  $runtimeRows = @(Assert-E1ToolchainVerifyReceipt $toolchainReceipt $plan $profileSha $inputLockSha $vmId)
  if ([string]$vm.State -cne [string]$profile.checkpoint.required_vm_state) { throw 'vm_must_be_off' }
  $networkAdapters = @(Get-VMNetworkAdapter -VM $vm)
  if ($networkAdapters.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace([string]$networkAdapters[0].SwitchName)) {
    throw 'vm_network_not_disconnected'
  }
  $existing = Get-VMSnapshot -VMName $profile.vm.name -Name $profile.checkpoint.toolchain_name -ErrorAction SilentlyContinue
  if ($existing) { throw 'checkpoint_already_exists' }
  $disk = @(Get-VMHardDiskDrive -VM $vm)
  if ($disk.Count -ne 1 -or [string]::IsNullOrWhiteSpace($disk[0].Path)) { throw 'vm_disk_contract_mismatch' }
  $vhdPath = Assert-E1PathInside $disk[0].Path @([string]$profile.vm.root) 'vm_disk_outside_canonical_root'
  $mounted = Mount-VHD -Path $vhdPath -ReadOnly -Passthru -ErrorAction Stop
  $mountedDisk = $mounted | Get-Disk
  $windowsCandidates = @()
  foreach ($partition in @($mountedDisk | Get-Partition)) {
    $volume = $partition | Get-Volume -ErrorAction SilentlyContinue
    $volumeGuid = @($partition.AccessPaths | Where-Object {
      ([string]$_).StartsWith('\\?\Volume{', [StringComparison]::OrdinalIgnoreCase) -and ([string]$_).EndsWith('}\')
    } | Select-Object -First 1)
    $accessPath = if ($volume -and $volume.DriveLetter) {
      [string]$volume.DriveLetter + ':\'
    } elseif ($volumeGuid.Count -eq 1) {
      [string]$volumeGuid[0]
    } else { $null }
    if ($volume -and [string]$volume.FileSystem -ceq 'NTFS' -and $accessPath -and
        (Test-Path -LiteralPath (Join-Path $accessPath 'Windows\System32\Config\SYSTEM') -PathType Leaf)) {
      $windowsCandidates += [pscustomobject]@{ access_path = $accessPath }
    }
  }
  if ($windowsCandidates.Count -ne 1) { throw 'guest_windows_volume_missing' }
  $driveRoot = [string]$windowsCandidates[0].access_path
  $userRoot = Join-Path $driveRoot "Users\$($profile.guest.local_user)"
  if (-not (Test-Path -LiteralPath $userRoot -PathType Container)) { throw 'guest_user_profile_missing' }
  $authCandidates = @($profile.guest.known_auth_storage_paths | ForEach-Object {
    $guestPath = [string]$_
    $guestPath = $guestPath.Replace('%USERPROFILE%', "C:\Users\$($profile.guest.local_user)")
    $guestPath = $guestPath.Replace('%LOCALAPPDATA%', "C:\Users\$($profile.guest.local_user)\AppData\Local")
    $guestPath = $guestPath.Replace('%APPDATA%', "C:\Users\$($profile.guest.local_user)\AppData\Roaming")
    Get-MountedGuestPath $driveRoot $guestPath
  })
  foreach ($candidate in $authCandidates) {
    if (Test-Path -LiteralPath $candidate) {
      $item = Get-Item -LiteralPath $candidate -Force
      if (-not $item.PSIsContainer -or @(Get-ChildItem -LiteralPath $candidate -Force -ErrorAction Stop).Count -ne 0) {
        throw 'auth_material_present'
      }
    }
  }
  foreach ($runtime in @($profile.toolchain)) {
    $row = @($runtimeRows | Where-Object { $_.id -ceq $runtime.id })[0]
    $guestRuntimeRoot = "$($profile.guest.toolchain_root)\$($runtime.id)\$($runtime.version)"
    $mountedRuntimeRoot = Get-MountedGuestPath $driveRoot $guestRuntimeRoot
    $markerPath = Join-Path $mountedRuntimeRoot '.evidence1-artifact.json'
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { throw 'installed_runtime_marker_missing' }
    $marker = Read-E1Json $markerPath 'installed_runtime_marker'
    if ($marker.id -cne $runtime.id -or $marker.version -cne $runtime.version -or
        $marker.sha256 -cne $row.artifact_sha256 -or $marker.bytes -ne $row.artifact_bytes) {
      throw 'installed_runtime_marker_mismatch'
    }
    $tree = Get-MountedTreeIdentity $mountedRuntimeRoot
    if ($tree.sha256 -cne $row.installed_tree_sha256 -or $tree.file_count -ne $row.installed_file_count -or
        $tree.bytes -ne $row.installed_bytes -or $tree.sha256 -cne $marker.installed_tree_sha256) {
      throw 'installed_runtime_tree_drift'
    }
  }
  Dismount-VHD -Path $vhdPath -ErrorAction Stop
  $mounted = $null

  $snapshot = Checkpoint-VM -Name $profile.vm.name -SnapshotName $profile.checkpoint.toolchain_name -Passthru -ErrorAction Stop
  $mutationPerformed = $true
  Write-E1ReceiptAtomically $receiptFull ([ordered]@{
    schema = 2; verdict = 'PASS'; profile_id = $profile.profile_id
    profile_sha256 = $profileSha; input_lock_sha256 = $inputLockSha; vm_id = $vmId
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    checkpoint = [ordered]@{
      name = [string]$snapshot.Name
      creation_time_utc = $snapshot.CreationTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      vm_state = [string]$vm.State
    }
    toolchain_receipt_sha256 = Get-E1Sha256 $toolchainReceiptFull
    installed_runtime_trees_reverified = $true
    codex_home_empty = $true; known_auth_material_absent = $true
    auth_file_contents_read = $false; auth_material_copied = $false
    private_paths_persisted = $false; mutation_performed = $true
    inference_sessions_consumed = 0; next_phase = 'interactive-auth-after-restore'
  })
  Write-Host "[evidence1-checkpoint-toolchain] PASS: $receiptFull"
} catch {
  $reason = Get-E1ClosedReason ([string]$_.Exception.Message) (@(
    'receipt_path_outside_scratch','receipt_already_exists','toolchain_receipt_path_outside_scratch',
    'exact_checkpoint_authorization_required','administrator_required','profile_missing','profile_invalid_json',
    'profile_identity_mismatch','profile_contract_mismatch','input_lock_missing','input_lock_invalid_json',
    'toolchain_receipt_missing','toolchain_receipt_invalid_json','toolchain_receipt_not_verify_pass',
    'toolchain_receipt_binding_mismatch','toolchain_receipt_invariant_failed','toolchain_receipt_time_invalid',
    'toolchain_receipt_stale','toolchain_receipt_guest_identity_invalid','toolchain_receipt_environment_invalid',
    'toolchain_receipt_runtime_incomplete','toolchain_receipt_runtime_mismatch',
    'vm_missing','vm_must_be_off','vm_network_not_disconnected','checkpoint_already_exists','vm_disk_contract_mismatch',
    'vm_disk_outside_canonical_root','guest_windows_volume_missing','guest_path_contract_mismatch',
    'guest_user_profile_missing','auth_material_present','installed_runtime_marker_missing',
    'installed_runtime_marker_invalid_json','installed_runtime_marker_mismatch','installed_runtime_tree_drift'
  ) + @(Get-E1HostDependencyFailureCodes)) 'toolchain_checkpoint_failed'
  try {
    $receiptFull = New-E1ReceiptPath $ReceiptPath 'checkpoint-toolchain-failed'
    Write-E1ReceiptAtomically $receiptFull ([ordered]@{
      schema = 2; verdict = 'FAIL'; reason_code = $reason
      generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      auth_file_contents_read = $false; private_paths_persisted = $false
      mutation_performed = $mutationPerformed; inference_sessions_consumed = 0
    })
  } catch { }
  Fail $reason
} finally {
  if ($mounted) { Dismount-VHD -Path $mounted.Path -ErrorAction SilentlyContinue }
}

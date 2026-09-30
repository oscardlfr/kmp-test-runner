#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory = $true)] [string]$InputLockPath,
  [Parameter(Mandatory = $true)] [string]$FailedReceiptPath,
  [Parameter(Mandatory = $true)] [string]$ExpectedVmId,
  [Parameter(Mandatory = $true)] [string]$ReceiptPath,
  [string]$AuthorizationPhrase = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RequiredPhrase = 'authorize delete failed Evidence1-Runner-E2E'
$CanonicalVmName = 'Evidence1-Runner-E2E'
$CanonicalVmRoot = 'C:\kmp-eval\hyperv-e2e'
$AllowedFailureReasons = @(
  'offline_apply_failed','offline_apply_deadline_exceeded','dism_apply_image_failed','dism_apply_unattend_failed',
  'recovery_gpt_attributes_mismatch','powershell_direct_deadline_exceeded','operator_recovery'
)
$mutationPerformed = $false

function Assert-PathInside([string]$Candidate, [string]$Root) {
  $candidateFull = [IO.Path]::GetFullPath($Candidate)
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  if (-not $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'failed_vm_delete_private_path_outside_scratch'
  }
  return $candidateFull
}

function Assert-NoReparseTree([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'failed_vm_delete_reparse_rejected'
  }
  foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction Stop)) {
    if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'failed_vm_delete_reparse_rejected'
    }
  }
}

function Assert-E1FailedVmDeleteReceipt($Failed, [string]$ProfileId, [string]$InputLockSha,
    [string]$ExpectedVmIdNormalized) {
  $commonFields = @(
    'schema','verdict','mode','reason_code','profile_id','input_lock_sha256','vm_id','network_used',
    'private_paths_persisted','credential_value_persisted_in_receipt','auth_material_read','auth_material_copied',
    'inference_sessions_consumed'
  )
  foreach ($field in $commonFields) {
    if ($Failed.PSObject.Properties.Name -cnotcontains $field) { throw 'failed_vm_delete_prior_receipt_invalid' }
  }
  if ($Failed.schema -ne 1 -or $Failed.verdict -cne 'FAIL' -or
      [string]$Failed.reason_code -cnotin $AllowedFailureReasons -or $Failed.profile_id -cne $ProfileId -or
      [string]$Failed.input_lock_sha256 -cne $InputLockSha -or
      ([string]$Failed.vm_id).ToLowerInvariant() -cne $ExpectedVmIdNormalized -or
      [bool]$Failed.network_used -or [bool]$Failed.private_paths_persisted -or
      [bool]$Failed.credential_value_persisted_in_receipt -or [bool]$Failed.auth_material_read -or
      [bool]$Failed.auth_material_copied -or [int]$Failed.inference_sessions_consumed -ne 0) {
    throw 'failed_vm_delete_prior_receipt_not_authoritative'
  }

  if ($Failed.mode -ceq 'Apply') {
    foreach ($field in @('start_count','mutation_performed')) {
      if ($Failed.PSObject.Properties.Name -cnotcontains $field) { throw 'failed_vm_delete_prior_receipt_invalid' }
    }
    if ([int]$Failed.start_count -ne 0 -or -not [bool]$Failed.mutation_performed) {
      throw 'failed_vm_delete_prior_receipt_not_authoritative'
    }
    return
  }

  if ($Failed.mode -cne 'Recovery') { throw 'failed_vm_delete_prior_receipt_not_authoritative' }
  $recoveryFields = @(
    'vm_state','network_state','vhd_partition_style','original_iso_is_only_dvd',
    'host_iso_mounted_after_operation','host_vhd_mounted_after_operation','answer_files_absent',
    'authorization_marker_created','authorization_marker_sha256','custody_source','guest_credential_preserved',
    'start_count','start_count_reason','mutation_performed','mutation_reason','receipt_source'
  )
  foreach ($field in $recoveryFields) {
    if ($Failed.PSObject.Properties.Name -cnotcontains $field) { throw 'failed_vm_delete_prior_receipt_invalid' }
  }
  if ($Failed.vm_state -cne 'Off' -or $Failed.network_state -cne 'disconnected' -or
      [string]$Failed.vhd_partition_style -cnotin @('RAW','GPT') -or
      -not [bool]$Failed.original_iso_is_only_dvd -or [bool]$Failed.host_iso_mounted_after_operation -or
      [bool]$Failed.host_vhd_mounted_after_operation -or -not [bool]$Failed.answer_files_absent -or
      -not [bool]$Failed.authorization_marker_created -or
      [string]$Failed.authorization_marker_sha256 -cnotmatch '^[0-9a-f]{64}$' -or
      $Failed.custody_source -cne 'authorization-marker' -or -not [bool]$Failed.guest_credential_preserved -or
      $null -ne $Failed.start_count -or $Failed.start_count_reason -cne 'worker_start_telemetry_unavailable' -or
      $null -ne $Failed.mutation_performed -or $Failed.mutation_reason -cne 'worker_mutation_telemetry_unavailable' -or
      $Failed.receipt_source -cne 'elevated-runner-recovery') {
    throw 'failed_vm_delete_prior_receipt_not_authoritative'
  }
}

if ($AuthorizationPhrase -cne $RequiredPhrase) { throw 'exact_failed_vm_delete_authorization_required' }
if ($ExpectedVmId -cnotmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
  throw 'failed_vm_delete_id_invalid'
}
$expectedVmIdNormalized = ([guid]$ExpectedVmId).ToString('D').ToLowerInvariant()
$inputLockFull = Assert-PathInside $InputLockPath 'C:\kmp-eval\scratch\'
$failedReceiptFull = Assert-PathInside $FailedReceiptPath 'C:\kmp-eval\scratch\'
$receiptFull = Assert-PathInside $ReceiptPath 'C:\kmp-eval\scratch\'
if (-not (Test-Path -LiteralPath $inputLockFull -PathType Leaf)) { throw 'input_lock_missing' }
if (-not (Test-Path -LiteralPath $failedReceiptFull -PathType Leaf)) { throw 'failed_vm_delete_prior_receipt_missing' }
if (Test-Path -LiteralPath $receiptFull) { throw 'receipt_already_exists' }

$hostContract = Join-Path $PSScriptRoot 'evidence1-host-snapshot-contract.psm1'
if (-not (Test-Path -LiteralPath $hostContract -PathType Leaf)) { throw 'failed_vm_delete_snapshot_contract_missing' }
Import-Module $hostContract -Force -ErrorAction Stop
$trustedRuntimeFiles = @(
  'tools/evidence1/provisioning/Evidence1.Provisioning.psm1',
  'tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json',
  'tools/evidence1/provisioning/evidence1-windows-input-lock.schema.json',
  'tools/evidence1/provisioning/evidence1-windows-approved-inputs.schema.json'
)
$runtime = Resolve-E1HostTrustedRuntime -ScriptRoot $PSScriptRoot `
  -EntrypointName 'evidence1-host-delete-failed-canonical-windows-vm.ps1' `
  -TrustedRuntimeFiles $trustedRuntimeFiles
$repoRoot = [string]$runtime.Root
$modulePath = Join-Path $repoRoot 'tools\evidence1\provisioning\Evidence1.Provisioning.psm1'
$profilePath = Join-Path $repoRoot 'tools\evidence1\provisioning\evidence1-windows-hyperv-e2e-v1.json'
Import-Module $modulePath -Force -ErrorAction Stop

try {
  $plan = Get-E1ProvisioningPlan $profilePath $inputLockFull -AllowSealedRuntimeCommitDrift
  $inputLockSha = Get-E1Sha256 $inputLockFull
  $profile = $plan.profile
  $profileRoot = [IO.Path]::GetFullPath([string]$profile.vm.root).TrimEnd('\')
  if ([string]$profile.vm.name -cne $CanonicalVmName -or
      $profileRoot -cne ([IO.Path]::GetFullPath($CanonicalVmRoot).TrimEnd('\'))) {
    throw 'failed_vm_delete_profile_identity_mismatch'
  }

  try { $failed = Get-Content -LiteralPath $failedReceiptFull -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
  catch { throw 'failed_vm_delete_prior_receipt_invalid' }
  Assert-E1FailedVmDeleteReceipt $failed ([string]$profile.profile_id) $inputLockSha $expectedVmIdNormalized

  $vmDir = [IO.Path]::GetFullPath((Join-Path $profileRoot $CanonicalVmName))
  $expectedVmDir = [IO.Path]::GetFullPath('C:\kmp-eval\hyperv-e2e\Evidence1-Runner-E2E')
  if ($vmDir -cne $expectedVmDir -or -not (Test-Path -LiteralPath $vmDir -PathType Container)) {
    throw 'failed_vm_delete_directory_identity_mismatch'
  }
  Assert-NoReparseTree $vmDir
  $expectedVhdPath = Join-Path $vmDir "$CanonicalVmName.vhdx"
  $expectedIsoPath = Join-Path (Join-Path $vmDir 'media') 'windows.iso'
  $expectedConfigPath = Join-Path (Join-Path (Join-Path $vmDir $CanonicalVmName) 'Virtual Machines') ($expectedVmIdNormalized.ToUpperInvariant() + '.vmcx')
  if (-not (Test-Path -LiteralPath $expectedVhdPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $expectedConfigPath -PathType Leaf)) {
    throw 'failed_vm_delete_storage_identity_mismatch'
  }
  Get-E1FileIdentity $expectedIsoPath $plan.iso.sha256 ([int64]$plan.iso.bytes) 'failed_vm_delete_iso' | Out-Null

  Assert-E1Administrator
  Import-Module Hyper-V -ErrorAction Stop
  $vm = Get-VM -Name $CanonicalVmName -ErrorAction Stop
  if (([string]$vm.Id).ToLowerInvariant() -cne $expectedVmIdNormalized -or [string]$vm.State -cne 'Off') {
    throw 'failed_vm_delete_runtime_identity_mismatch'
  }
  $hardDisks = @(Get-VMHardDiskDrive -VM $vm -ErrorAction Stop)
  $dvdDrives = @(Get-VMDvdDrive -VM $vm -ErrorAction Stop)
  $snapshots = @(Get-VMSnapshot -VM $vm -ErrorAction Stop)
  if ($hardDisks.Count -ne 1 -or [IO.Path]::GetFullPath([string]$hardDisks[0].Path) -cne $expectedVhdPath -or
      $dvdDrives.Count -ne 1 -or [IO.Path]::GetFullPath([string]$dvdDrives[0].Path) -cne $expectedIsoPath -or
      $snapshots.Count -ne 0) {
    throw 'failed_vm_delete_topology_mismatch'
  }

  Remove-VM -VM $vm -Force -ErrorAction Stop
  $mutationPerformed = $true
  if (Get-VM -Id ([guid]$expectedVmIdNormalized) -ErrorAction SilentlyContinue) {
    throw 'failed_vm_delete_unregister_failed'
  }
  Remove-Item -LiteralPath $vmDir -Recurse -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $vmDir) { throw 'failed_vm_delete_storage_cleanup_failed' }

  Write-E1ReceiptAtomically $receiptFull ([ordered]@{
    schema = 1
    verdict = 'PASS'
    operation = 'delete-failed-canonical-windows-vm'
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    profile_id = [string]$profile.profile_id
    input_lock_sha256 = $inputLockSha
    approved_manifest_git_commit = [string]$plan.approved_manifest.git_commit
    cleanup_runtime_source_git_commit = [string]$plan.approved_manifest.runtime_source_git_commit
    cleanup_runtime_commit_drift_accepted = [bool]$plan.approved_manifest.runtime_commit_drift_accepted
    vm_name = $CanonicalVmName
    vm_id = $expectedVmIdNormalized
    vm_state_before = 'Off'
    failure_reason = [string]$failed.reason_code
    vm_unregistered = $true
    vm_storage_removed = $true
    mutation_performed = $true
    private_paths_persisted = $false
    auth_material_read = $false
    inference_sessions_consumed = 0
  })
  Write-Host "[evidence1-failed-vm-delete] PASS: $receiptFull"
} catch {
  $candidate = [string]$_.Exception.Message
  $closedCodes = @(
    'failed_vm_delete_profile_identity_mismatch','failed_vm_delete_prior_receipt_invalid',
    'failed_vm_delete_prior_receipt_not_authoritative','failed_vm_delete_directory_identity_mismatch',
    'failed_vm_delete_reparse_rejected','failed_vm_delete_storage_identity_mismatch',
    'approved_manifest_recovery_requires_sealed_runtime','approved_manifest_sealed_identity_mismatch',
    'failed_vm_delete_iso_missing','failed_vm_delete_iso_size_mismatch','failed_vm_delete_iso_hash_mismatch',
    'administrator_required','failed_vm_delete_runtime_identity_mismatch','failed_vm_delete_topology_mismatch',
    'failed_vm_delete_unregister_failed','failed_vm_delete_storage_cleanup_failed'
  )
  $reason = Get-E1ClosedReason $candidate $closedCodes 'failed_vm_delete_failed'
  try {
    Write-E1ReceiptAtomically $receiptFull ([ordered]@{
      schema = 1; verdict = 'FAIL'; operation = 'delete-failed-canonical-windows-vm'; reason_code = $reason
      generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      vm_name = $CanonicalVmName; vm_id = $expectedVmIdNormalized
      mutation_performed = $mutationPerformed; private_paths_persisted = $false
      auth_material_read = $false; inference_sessions_consumed = 0
    })
  } catch { }
  Write-Error "HARD STOP: $reason"
  exit 1
}

#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory = $true)] [string]$InputLockPath,
  [Parameter(Mandatory = $true)] [string]$GuestCredentialPath,
  [Parameter(Mandatory = $true)] [string]$ToolchainReceiptPath,
  [Parameter(Mandatory = $true)] [string]$PriorParentReceiptPath,
  [string]$PriorFailureReceiptPath = '',
  [Parameter(Mandatory = $true)] [string]$ReceiptPath,
  [ValidateRange(30,300)] [int]$ShutdownTimeoutSeconds = 120,
  [string]$AuthorizationPhrase = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RequiredCheckpointPhrase = 'authorize checkpoint verified evidence1 toolchain without auth'
$RequiredProfileId = 'evidence1-windows-hyperv-e2e-v1'
$RequiredVmName = 'Evidence1-Runner-E2E'

if ($AuthorizationPhrase -cne $RequiredCheckpointPhrase) { throw 'exact_checkpoint_authorization_required' }

$snapshotContract = Join-Path $PSScriptRoot 'evidence1-host-snapshot-contract.psm1'
$chainContract = Join-Path $PSScriptRoot 'evidence1-host-windows-provisioning-chain.psm1'
Import-Module $snapshotContract -Force -ErrorAction Stop
Import-Module $chainContract -Force -ErrorAction Stop
Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1') -Force -ErrorAction Stop
$trustedRuntimeFiles = @(
  'tools/evidence1/provisioning/evidence1-checkpoint-toolchain.ps1',
  'tools/evidence1/provisioning/Evidence1.Provisioning.psm1',
  'tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json',
  'tools/evidence1/provisioning/approved-inputs/evidence1-windows-25h2-en-gb-codex-01534-e2e-v1.json',
  'tools/evidence1/provisioning/approved-inputs/evidence1-windows-25h2-en-gb-codex-01534-e2e-v2.json'
)
$runtime = Resolve-E1HostTrustedRuntime -ScriptRoot $PSScriptRoot `
  -EntrypointName 'evidence1-host-checkpoint-canonical-windows-toolchain.ps1' -TrustedRuntimeFiles $trustedRuntimeFiles
$root = [string]$runtime.Root
$profilePath = Join-Path $root 'tools\evidence1\provisioning\evidence1-windows-hyperv-e2e-v1.json'
$corePath = Join-Path $root 'tools\evidence1\provisioning\evidence1-checkpoint-toolchain.ps1'
$inputLockFull = Assert-E1WindowsProvisioningScratchPath $InputLockPath 'input_lock_path_outside_scratch' -MustExist
$credentialFull = Assert-E1WindowsProvisioningScratchPath $GuestCredentialPath 'guest_credential_path_outside_scratch' -MustExist
$prior = Read-E1WindowsProvisioningReceipt $ToolchainReceiptPath 'toolchain_receipt'
$priorParent = Read-E1WindowsProvisioningReceipt $PriorParentReceiptPath 'prior_parent_receipt'
$priorFailure = if (-not [string]::IsNullOrEmpty($PriorFailureReceiptPath)) {
  Read-E1WindowsProvisioningReceipt $PriorFailureReceiptPath 'prior_failure_receipt'
} else { $null }
$childReceipt = New-E1WindowsProvisioningChildReceiptPath $ReceiptPath 'checkpoint-toolchain'
$profileSha = Get-E1WindowsProvisioningSha256 $profilePath
$inputLockSha = Get-E1WindowsProvisioningSha256 $inputLockFull
$null = Assert-E1CanonicalE2EProfile $profilePath

Import-Module Hyper-V -ErrorAction Stop
$vm = Get-VM -Name $RequiredVmName -ErrorAction SilentlyContinue
if (-not $vm -or [string]$vm.Name -cne $RequiredVmName) { throw 'vm_missing' }
$vmId = ([string]$vm.Id).ToLowerInvariant()
$null = Assert-E1CanonicalToolchainReceipt $prior.document 'Verify' $profileSha $inputLockSha $vmId $priorParent.sha256
$adapters = @(Get-VMNetworkAdapter -VM $vm)
if ($adapters.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace([string]$adapters[0].SwitchName)) { throw 'vm_network_not_disconnected' }
if ($priorFailure) {
  if ($priorFailure.document.schema -ne 2 -or $priorFailure.document.verdict -cne 'FAIL' -or
      $priorFailure.document.reason_code -cne 'guest_windows_volume_missing' -or
      $priorFailure.document.graceful_shutdown_requested -ne $true -or
      $priorFailure.document.graceful_shutdown_completed -ne $true -or
      $priorFailure.document.hard_power_fallback_used -ne $false -or
      [bool]$priorFailure.document.mutation_performed -or [bool]$priorFailure.document.network_used -or
      [bool]$priorFailure.document.auth_material_read -or [bool]$priorFailure.document.auth_material_copied -or
      [bool]$priorFailure.document.private_paths_persisted -or
      [int]$priorFailure.document.inference_sessions_consumed -ne 0 -or
      $priorFailure.document.receipt_chain.prior_receipt_sha256 -cne $prior.sha256) {
    throw 'prior_failure_receipt_not_recoverable'
  }
}
if ([string]$vm.State -ceq 'Running') {
  if ($priorFailure) { throw 'running_vm_with_prior_checkpoint_failure' }
  $shutdownScript = Join-Path $PSScriptRoot 'evidence1-host-windows-psdirect-operation.ps1'
  $shutdownExit = Invoke-E1WindowsProvisioningCore $shutdownScript @('-Mode','Shutdown','-GuestCredentialPath',$credentialFull) 60
  if ($shutdownExit -ne 0) { throw 'guest_graceful_shutdown_dispatch_failed' }
  $deadline = [DateTime]::UtcNow.AddSeconds($ShutdownTimeoutSeconds)
  do {
    $vm = Get-VM -Name $RequiredVmName -ErrorAction Stop
    if ([string]$vm.State -ceq 'Off') { break }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'guest_graceful_shutdown_timeout' }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  $vm = Get-VM -Name $RequiredVmName -ErrorAction Stop
  if ([string]$vm.State -cne 'Off') { throw 'guest_graceful_shutdown_timeout' }
} elseif ([string]$vm.State -ceq 'Off') {
  if (-not $priorFailure) { throw 'off_vm_requires_failed_checkpoint_receipt' }
} else { throw 'vm_must_be_running_or_recoverable_off' }

$arguments = @('-ProfilePath',$profilePath,'-InputLockPath',$inputLockFull,'-ToolchainReceiptPath',$prior.path,
  '-ReceiptPath',$childReceipt,'-AuthorizationPhrase',$AuthorizationPhrase)
$exitCode = Invoke-E1WindowsProvisioningCore $corePath $arguments 900
$core = Read-E1WindowsProvisioningReceipt $childReceipt 'checkpoint_core_receipt'
if ($exitCode -eq 0) {
  if ($core.document.verdict -cne 'PASS' -or $core.document.profile_id -cne $RequiredProfileId -or
      [string]$core.document.vm_id -cne $vmId -or $core.document.inference_sessions_consumed -ne 0 -or
      $core.document.auth_file_contents_read -ne $false -or $core.document.auth_material_copied -ne $false -or
      $core.document.private_paths_persisted -ne $false -or $core.document.toolchain_receipt_sha256 -cne $prior.sha256 -or
      $core.document.checkpoint.vm_state -cne 'Off') { throw 'checkpoint_core_receipt_binding_mismatch' }
} elseif ($core.document.verdict -cne 'FAIL') { throw 'checkpoint_core_exit_receipt_mismatch' }
$written = Write-E1WindowsProvisioningChainedReceipt $ReceiptPath $childReceipt $prior.path 'checkpoint-toolchain'
Remove-Item -LiteralPath $childReceipt -Force -ErrorAction Stop
if ($exitCode -ne 0) { exit $exitCode }
Write-Host '[evidence1-host-checkpoint-canonical-windows-toolchain] PASS'

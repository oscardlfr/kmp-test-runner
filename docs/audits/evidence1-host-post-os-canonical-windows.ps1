#Requires -RunAsAdministrator

param(
  [ValidateSet('StartAndVerify','Seal')] [string]$Mode = 'StartAndVerify',
  [Parameter(Mandatory = $true)] [string]$InputLockPath,
  [Parameter(Mandatory = $true)] [string]$GuestCredentialPath,
  [Parameter(Mandatory = $true)] [string]$PriorReceiptPath,
  [string]$PriorParentReceiptPath = '',
  [string]$PriorFailureReceiptPath = '',
  [Parameter(Mandatory = $true)] [string]$ReceiptPath,
  [string]$AuthorizationPhrase = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RequiredStartPhrase = 'authorize start evidence1 e2e post-os verification'
$RequiredSealPhrase = 'authorize seal evidence1 windows post-os boundary'
$RequiredProfileId = 'evidence1-windows-hyperv-e2e-v1'
$RequiredVmName = 'Evidence1-Runner-E2E'

if ($Mode -ceq 'StartAndVerify' -and $AuthorizationPhrase -cne $RequiredStartPhrase) { throw 'exact_post_os_start_authorization_required' }
if ($Mode -ceq 'Seal' -and $AuthorizationPhrase -cne $RequiredSealPhrase) { throw 'exact_post_os_seal_authorization_required' }

$snapshotContract = Join-Path $PSScriptRoot 'evidence1-host-snapshot-contract.psm1'
$chainContract = Join-Path $PSScriptRoot 'evidence1-host-windows-provisioning-chain.psm1'
Import-Module $snapshotContract -Force -ErrorAction Stop
Import-Module $chainContract -Force -ErrorAction Stop
Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1') -Force -ErrorAction Stop
$trustedRuntimeFiles = @(
  'tools/evidence1/provisioning/evidence1-post-os-transition.ps1',
  'tools/evidence1/provisioning/Evidence1.Provisioning.psm1',
  'tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json',
  'tools/evidence1/provisioning/approved-inputs/evidence1-windows-25h2-en-gb-codex-01534-e2e-v1.json',
  'tools/evidence1/provisioning/approved-inputs/evidence1-windows-25h2-en-gb-codex-01534-e2e-v2.json'
)
$runtime = Resolve-E1HostTrustedRuntime -ScriptRoot $PSScriptRoot `
  -EntrypointName 'evidence1-host-post-os-canonical-windows.ps1' -TrustedRuntimeFiles $trustedRuntimeFiles
$root = [string]$runtime.Root
$profilePath = Join-Path $root 'tools\evidence1\provisioning\evidence1-windows-hyperv-e2e-v1.json'
$corePath = Join-Path $root 'tools\evidence1\provisioning\evidence1-post-os-transition.ps1'
$inputLockFull = Assert-E1WindowsProvisioningScratchPath $InputLockPath 'input_lock_path_outside_scratch' -MustExist
$credentialFull = Assert-E1WindowsProvisioningScratchPath $GuestCredentialPath 'guest_credential_path_outside_scratch' -MustExist
$prior = Read-E1WindowsProvisioningReceipt $PriorReceiptPath 'prior_receipt'
$priorFailure = if (-not [string]::IsNullOrEmpty($PriorFailureReceiptPath)) {
  Read-E1WindowsProvisioningReceipt $PriorFailureReceiptPath 'prior_failure_receipt'
} else { $null }
$priorParent = if ($Mode -ceq 'Seal') {
  if ($priorFailure) { throw 'prior_failure_receipt_must_be_empty' }
  Read-E1WindowsProvisioningReceipt $PriorParentReceiptPath 'prior_parent_receipt'
} else {
  if (-not [string]::IsNullOrEmpty($PriorParentReceiptPath)) { throw 'prior_parent_receipt_must_be_empty' }
  $null
}
$childReceipt = New-E1WindowsProvisioningChildReceiptPath $ReceiptPath ('post-os-' + $Mode.ToLowerInvariant())
$profileSha = Get-E1WindowsProvisioningSha256 $profilePath
$inputLockSha = Get-E1WindowsProvisioningSha256 $inputLockFull
$null = Assert-E1CanonicalE2EProfile $profilePath

Import-Module Hyper-V -ErrorAction Stop
$vm = Get-VM -Name $RequiredVmName -ErrorAction SilentlyContinue
if (-not $vm -or [string]$vm.Name -cne $RequiredVmName) { throw 'vm_missing' }
$vmId = ([string]$vm.Id).ToLowerInvariant()
$adapters = @(Get-VMNetworkAdapter -VM $vm)
if ($adapters.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace([string]$adapters[0].SwitchName)) { throw 'vm_network_not_disconnected' }

if ($Mode -ceq 'StartAndVerify') {
  $null = Assert-E1CanonicalApplyReceipt $prior.document $profileSha $inputLockSha $vmId
  if ($priorFailure) {
    if ($priorFailure.document.schema -ne 1 -or $priorFailure.document.verdict -cne 'FAIL' -or
        $priorFailure.document.mode -cne 'Verify' -or
        $priorFailure.document.reason_code -cne 'guest_computer_identity_mismatch' -or
        [bool]$priorFailure.document.mutation_performed -or [bool]$priorFailure.document.auth_material_copied -or
        [bool]$priorFailure.document.auth_material_read -or [bool]$priorFailure.document.private_paths_persisted -or
        [int]$priorFailure.document.inference_sessions_consumed -ne 0 -or
        $priorFailure.document.receipt_chain.prior_receipt_sha256 -cne $prior.sha256) {
      throw 'prior_failure_receipt_not_recoverable'
    }
  }
  if ([string]$vm.State -ceq 'Off') {
    Start-VM -VM $vm -ErrorAction Stop | Out-Null
  } elseif ([string]$vm.State -ceq 'Running') {
    if (-not $priorFailure) { throw 'running_vm_requires_failed_verify_receipt' }
  } else { throw 'vm_must_be_off_or_recoverable_running' }
  $coreMode = 'Verify'
  $coreAuthorization = ''
} else {
  $null = Assert-E1CanonicalPostOsReceipt $prior.document 'Verify' $profileSha $inputLockSha $vmId $priorParent.sha256
  if ([string]$vm.State -cne 'Running') { throw 'vm_must_be_running' }
  $coreMode = 'Seal'
  $coreAuthorization = $AuthorizationPhrase
}

$arguments = @('-Mode',$coreMode,'-ProfilePath',$profilePath,'-InputLockPath',$inputLockFull,
  '-GuestCredentialPath',$credentialFull,'-ReceiptPath',$childReceipt,'-AuthorizationPhrase',$coreAuthorization)
$exitCode = Invoke-E1WindowsProvisioningCore $corePath $arguments 600
$core = Read-E1WindowsProvisioningReceipt $childReceipt 'post_os_core_receipt'
if ($exitCode -eq 0) {
  $null = Assert-E1CanonicalPostOsCoreReceipt $core.document $coreMode $profileSha $inputLockSha $vmId
} elseif ($core.document.verdict -cne 'FAIL') { throw 'post_os_core_exit_receipt_mismatch' }
$written = Write-E1WindowsProvisioningChainedReceipt $ReceiptPath $childReceipt $prior.path ('post-os-' + $coreMode.ToLowerInvariant())
if ($exitCode -eq 0) {
  $null = Assert-E1CanonicalPostOsReceipt $written.document $coreMode $profileSha $inputLockSha $vmId $prior.sha256
}
Remove-Item -LiteralPath $childReceipt -Force -ErrorAction Stop
if ($exitCode -ne 0) { exit $exitCode }
Write-Host "[evidence1-host-post-os-canonical-windows] $Mode PASS"

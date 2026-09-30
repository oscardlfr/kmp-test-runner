#Requires -RunAsAdministrator

param(
  [ValidateSet('Bootstrap','Verify')] [string]$Mode = 'Bootstrap',
  [Parameter(Mandatory = $true)] [string]$InputLockPath,
  [Parameter(Mandatory = $true)] [string]$GuestCredentialPath,
  [Parameter(Mandatory = $true)] [string]$PriorReceiptPath,
  [Parameter(Mandatory = $true)] [string]$PriorParentReceiptPath,
  [string]$PriorFailureReceiptPath = '',
  [Parameter(Mandatory = $true)] [string]$ReceiptPath,
  [string]$AuthorizationPhrase = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RequiredBootstrapPhrase = 'authorize bootstrap evidence1 e2e windows toolchain without auth'
$RequiredProfileId = 'evidence1-windows-hyperv-e2e-v1'
$RequiredVmName = 'Evidence1-Runner-E2E'

if ($Mode -ceq 'Bootstrap' -and $AuthorizationPhrase -cne $RequiredBootstrapPhrase) { throw 'exact_toolchain_bootstrap_authorization_required' }
if ($Mode -ceq 'Verify' -and -not [string]::IsNullOrEmpty($AuthorizationPhrase)) { throw 'toolchain_verify_authorization_must_be_empty' }

$snapshotContract = Join-Path $PSScriptRoot 'evidence1-host-snapshot-contract.psm1'
$chainContract = Join-Path $PSScriptRoot 'evidence1-host-windows-provisioning-chain.psm1'
Import-Module $snapshotContract -Force -ErrorAction Stop
Import-Module $chainContract -Force -ErrorAction Stop
Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1') -Force -ErrorAction Stop
$trustedRuntimeFiles = @(
  'tools/evidence1/provisioning/evidence1-bootstrap-toolchain.ps1',
  'tools/evidence1/provisioning/Evidence1.Provisioning.psm1',
  'tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json',
  'tools/evidence1/provisioning/approved-inputs/evidence1-windows-25h2-en-gb-codex-01534-e2e-v1.json',
  'tools/evidence1/provisioning/approved-inputs/evidence1-windows-25h2-en-gb-codex-01534-e2e-v2.json'
)
$runtime = Resolve-E1HostTrustedRuntime -ScriptRoot $PSScriptRoot `
  -EntrypointName 'evidence1-host-bootstrap-canonical-windows-toolchain.ps1' -TrustedRuntimeFiles $trustedRuntimeFiles
$root = [string]$runtime.Root
$profilePath = Join-Path $root 'tools\evidence1\provisioning\evidence1-windows-hyperv-e2e-v1.json'
$corePath = Join-Path $root 'tools\evidence1\provisioning\evidence1-bootstrap-toolchain.ps1'
$inputLockFull = Assert-E1WindowsProvisioningScratchPath $InputLockPath 'input_lock_path_outside_scratch' -MustExist
$credentialFull = Assert-E1WindowsProvisioningScratchPath $GuestCredentialPath 'guest_credential_path_outside_scratch' -MustExist
$prior = Read-E1WindowsProvisioningReceipt $PriorReceiptPath 'prior_receipt'
$priorParent = Read-E1WindowsProvisioningReceipt $PriorParentReceiptPath 'prior_parent_receipt'
$priorFailure = if (-not [string]::IsNullOrEmpty($PriorFailureReceiptPath)) {
  Read-E1WindowsProvisioningReceipt $PriorFailureReceiptPath 'prior_failure_receipt'
} else { $null }
$childReceipt = New-E1WindowsProvisioningChildReceiptPath $ReceiptPath ('toolchain-' + $Mode.ToLowerInvariant())
$profileSha = Get-E1WindowsProvisioningSha256 $profilePath
$inputLockSha = Get-E1WindowsProvisioningSha256 $inputLockFull
$null = Assert-E1CanonicalE2EProfile $profilePath
$profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json -ErrorAction Stop

Import-Module Hyper-V -ErrorAction Stop
$vm = Get-VM -Name $RequiredVmName -ErrorAction SilentlyContinue
if (-not $vm -or [string]$vm.Name -cne $RequiredVmName) { throw 'vm_missing' }
$vmId = ([string]$vm.Id).ToLowerInvariant()
if ([string]$vm.State -cne 'Running') { throw 'vm_must_be_running' }
$adapters = @(Get-VMNetworkAdapter -VM $vm)
if ($adapters.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace([string]$adapters[0].SwitchName)) { throw 'vm_network_not_disconnected' }
if ($Mode -ceq 'Bootstrap') {
  $null = Assert-E1CanonicalPostOsReceipt $prior.document 'Seal' $profileSha $inputLockSha $vmId $priorParent.sha256
  if ($priorFailure) {
    $completed = @($priorFailure.document.completed_runtime_ids | ForEach-Object { [string]$_ } | Sort-Object)
    $expected = @($profile.toolchain | ForEach-Object { [string]$_.id } | Sort-Object)
    if ($priorFailure.document.schema -ne 2 -or $priorFailure.document.verdict -cne 'FAIL' -or
        $priorFailure.document.mode -cne 'Bootstrap' -or
        $priorFailure.document.reason_code -cne 'codex_home_not_empty' -or
        [bool]$priorFailure.document.auth_material_copied -or [bool]$priorFailure.document.auth_material_read -or
        [bool]$priorFailure.document.network_used -or [bool]$priorFailure.document.private_paths_persisted -or
        [bool]$priorFailure.document.guest_windows_credential_value_persisted -or
        [int]$priorFailure.document.inference_sessions_consumed -ne 0 -or
        $priorFailure.document.rollback_complete -ne $true -or
        $priorFailure.document.mutation_state_complete -ne $true -or
        @(Compare-Object $completed $expected).Count -ne 0 -or
        $priorFailure.document.receipt_chain.prior_receipt_sha256 -cne $prior.sha256) {
      throw 'prior_failure_receipt_not_recoverable'
    }
  }
} else {
  if ($priorFailure) { throw 'prior_failure_receipt_must_be_empty' }
  $null = Assert-E1CanonicalToolchainReceipt $prior.document 'Bootstrap' $profileSha $inputLockSha $vmId $priorParent.sha256
}

$arguments = @('-Mode',$Mode,'-ProfilePath',$profilePath,'-InputLockPath',$inputLockFull,
  '-GuestCredentialPath',$credentialFull,'-ReceiptPath',$childReceipt)
if ($priorFailure) { $arguments += @('-RecoverUnauthenticatedProbeState','true') }
$exitCode = Invoke-E1WindowsProvisioningCore $corePath $arguments 3600
$core = Read-E1WindowsProvisioningReceipt $childReceipt 'toolchain_core_receipt'
if ($exitCode -eq 0) {
  $null = Assert-E1CanonicalToolchainCoreReceipt $core.document $Mode $profileSha $inputLockSha $vmId
} elseif ($core.document.verdict -cne 'FAIL') { throw 'toolchain_core_exit_receipt_mismatch' }
$written = Write-E1WindowsProvisioningChainedReceipt $ReceiptPath $childReceipt $prior.path ('toolchain-' + $Mode.ToLowerInvariant())
if ($exitCode -eq 0) {
  $null = Assert-E1CanonicalToolchainReceipt $written.document $Mode $profileSha $inputLockSha $vmId $prior.sha256
}
Remove-Item -LiteralPath $childReceipt -Force -ErrorAction Stop
if ($exitCode -ne 0) { exit $exitCode }
Write-Host "[evidence1-host-bootstrap-canonical-windows-toolchain] $Mode PASS"

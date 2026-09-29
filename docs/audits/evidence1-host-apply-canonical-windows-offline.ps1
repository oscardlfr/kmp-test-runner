#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory = $true)] [string]$InputLockPath,
  [Parameter(Mandatory = $true)] [string]$GuestCredentialPath,
  [Parameter(Mandatory = $true)] [string]$CreatedInspectionReceiptPath,
  [Parameter(Mandatory = $true)] [string]$ReceiptPath,
  [ValidateRange(900, 6000)] [int]$TimeoutSeconds = 5400,
  [switch]$RecoveryOnly,
  [ValidateSet('', 'elevated_runner_child_timeout', 'elevated_runner_child_failure')]
  [string]$RecoveryReasonCode = '',
  [string]$AuthorizationPhrase = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RequiredPhrase = 'authorize exactly one evidence1 e2e windows offline apply'

function Assert-PathInside([string]$Candidate, [string]$Root) {
  $candidateFull = [IO.Path]::GetFullPath($Candidate)
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  if (-not $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'canonical_offline_apply_private_path_outside_scratch'
  }
  return $candidateFull
}

if ($AuthorizationPhrase -cne $RequiredPhrase) { throw 'exact_offline_apply_authorization_required' }
$inputLockFull = Assert-PathInside $InputLockPath 'C:\kmp-eval\scratch\'
$credentialFull = Assert-PathInside $GuestCredentialPath 'C:\kmp-eval\scratch\'
$inspectionFull = Assert-PathInside $CreatedInspectionReceiptPath 'C:\kmp-eval\scratch\'
$receiptFull = Assert-PathInside $ReceiptPath 'C:\kmp-eval\scratch\'
foreach ($required in @($inputLockFull,$credentialFull,$inspectionFull)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'canonical_offline_apply_required_input_missing' }
}
if (-not $RecoveryOnly -and (Test-Path -LiteralPath $receiptFull)) { throw 'receipt_already_exists' }
if (-not $RecoveryOnly -and -not [string]::IsNullOrWhiteSpace($RecoveryReasonCode)) { throw 'recovery_reason_reserved' }

$hostContract = Join-Path $PSScriptRoot 'evidence1-host-snapshot-contract.psm1'
if (-not (Test-Path -LiteralPath $hostContract -PathType Leaf)) { throw 'canonical_offline_apply_snapshot_contract_missing' }
Import-Module $hostContract -Force -ErrorAction Stop
$trustedRuntimeFiles = @(
  'tools/evidence1/provisioning/evidence1-apply-windows-offline.ps1',
  'tools/evidence1/provisioning/evidence1-windows-vm.ps1',
  'tools/evidence1/provisioning/Evidence1.Provisioning.psm1',
  'tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json',
  'tools/evidence1/provisioning/evidence1-windows-input-lock.schema.json',
  'tools/evidence1/provisioning/evidence1-windows-approved-inputs.schema.json'
)
$runtime = Resolve-E1HostTrustedRuntime -ScriptRoot $PSScriptRoot `
  -EntrypointName 'evidence1-host-apply-canonical-windows-offline.ps1' `
  -TrustedRuntimeFiles $trustedRuntimeFiles
$repoRoot = [string]$runtime.Root
$implementation = Join-Path $repoRoot 'tools\evidence1\provisioning\evidence1-apply-windows-offline.ps1'
$profile = Join-Path $repoRoot 'tools\evidence1\provisioning\evidence1-windows-hyperv-e2e-v1.json'

$arguments = @{
  ProfilePath = $profile
  InputLockPath = $inputLockFull
  GuestCredentialPath = $credentialFull
  CreatedInspectionReceiptPath = $inspectionFull
  ReceiptPath = $receiptFull
  TimeoutSeconds = $TimeoutSeconds
  AuthorizationPhrase = $AuthorizationPhrase
}
if ($RecoveryOnly) {
  $arguments.RecoveryOnly = $true
  $arguments.RecoveryReasonCode = $RecoveryReasonCode
}
& $implementation @arguments
if (-not $?) { exit 1 }

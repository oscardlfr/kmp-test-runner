#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory = $true)] [string]$InputLockPath,
  [Parameter(Mandatory = $true)] [string]$GuestCredentialPath,
  [Parameter(Mandatory = $true)] [string]$AnswerMediaPath,
  [Parameter(Mandatory = $true)] [string]$ReceiptPath,
  [string]$PriorFailureReceiptPath = '',
  [string]$PriorFailureCustodyPath = '',
  [string]$PriorInputLockPath = '',
  [string]$PriorCreatedInspectionReceiptPath = '',
  [string]$PriorRunnerRequestId = '',
  [ValidateRange(900, 7200)] [int]$TimeoutSeconds = 5400,
  [switch]$RecoveryOnly,
  [ValidateSet('', 'elevated_runner_child_timeout', 'elevated_runner_child_failure')]
  [string]$RecoveryReasonCode = '',
  [string]$AuthorizationPhrase = '',
  [string]$RetryAuthorizationPhrase = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RequiredPhrase = 'authorize install evidence1 e2e windows unattended offline'
$RequiredRetryPhrase = 'authorize exactly one evidence1 e2e windows unattended retry'

function Assert-PathInside([string]$Candidate, [string]$Root) {
  $candidateFull = [IO.Path]::GetFullPath($Candidate)
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  if (-not $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'canonical_unattended_private_path_outside_scratch'
  }
  return $candidateFull
}

if ($AuthorizationPhrase -cne $RequiredPhrase) { throw 'exact_unattended_install_authorization_required' }
$isRetry = -not [string]::IsNullOrWhiteSpace($PriorFailureReceiptPath) -or
  -not [string]::IsNullOrWhiteSpace($PriorFailureCustodyPath) -or
  -not [string]::IsNullOrWhiteSpace($PriorInputLockPath) -or
  -not [string]::IsNullOrWhiteSpace($PriorCreatedInspectionReceiptPath) -or
  -not [string]::IsNullOrWhiteSpace($PriorRunnerRequestId) -or
  -not [string]::IsNullOrWhiteSpace($RetryAuthorizationPhrase)
if ($isRetry -and ([string]::IsNullOrWhiteSpace($PriorFailureReceiptPath) -or
    [string]::IsNullOrWhiteSpace($PriorFailureCustodyPath) -or
    [string]::IsNullOrWhiteSpace($PriorInputLockPath) -or
    [string]::IsNullOrWhiteSpace($PriorCreatedInspectionReceiptPath) -or
    [string]::IsNullOrWhiteSpace($PriorRunnerRequestId) -or
    $RetryAuthorizationPhrase -cne $RequiredRetryPhrase)) {
  throw 'exact_unattended_retry_authorization_required'
}
$credentialFull = Assert-PathInside $GuestCredentialPath 'C:\kmp-eval\scratch\'
$answerMediaFull = Assert-PathInside $AnswerMediaPath 'C:\kmp-eval\scratch\'
$privateRoot = Split-Path -Parent $credentialFull
if ([IO.Path]::GetFullPath($privateRoot) -cne [IO.Path]::GetFullPath((Split-Path -Parent $answerMediaFull))) {
  throw 'canonical_unattended_private_root_mismatch'
}
$hostContract = Join-Path $PSScriptRoot 'evidence1-host-snapshot-contract.psm1'
if (-not (Test-Path -LiteralPath $hostContract -PathType Leaf)) { throw 'canonical_unattended_snapshot_contract_missing' }
Import-Module $hostContract -Force -ErrorAction Stop
$trustedRuntimeFiles = @(
  'tools/evidence1/provisioning/evidence1-install-windows-unattended.ps1',
  'tools/evidence1/provisioning/Evidence1.Provisioning.psm1',
  'tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json',
  'tools/evidence1/provisioning/evidence1-windows-input-lock.schema.json',
  'tools/evidence1/provisioning/evidence1-windows-approved-inputs.schema.json'
)
$runtime = Resolve-E1HostTrustedRuntime -ScriptRoot $PSScriptRoot `
  -EntrypointName 'evidence1-host-install-canonical-windows-unattended.ps1' `
  -TrustedRuntimeFiles $trustedRuntimeFiles
$repoRoot = [string]$runtime.Root
$implementation = Join-Path $repoRoot 'tools\evidence1\provisioning\evidence1-install-windows-unattended.ps1'
if ($RecoveryOnly) {
  & $implementation -InputLockPath $InputLockPath -GuestCredentialPath $credentialFull `
    -AnswerMediaPath $answerMediaFull -ReceiptPath $ReceiptPath -RecoveryOnly `
    -PriorFailureReceiptPath $PriorFailureReceiptPath -AuthorizationPhrase $AuthorizationPhrase `
    -PriorFailureCustodyPath $PriorFailureCustodyPath `
    -PriorInputLockPath $PriorInputLockPath -PriorCreatedInspectionReceiptPath $PriorCreatedInspectionReceiptPath `
    -PriorRunnerRequestId $PriorRunnerRequestId `
    -RetryAuthorizationPhrase $RetryAuthorizationPhrase -RecoveryReasonCode $RecoveryReasonCode
  if (-not $?) { exit 1 }
  exit 0
}

$inputLockFull = Assert-PathInside $InputLockPath 'C:\kmp-eval\scratch\'
$receiptFull = Assert-PathInside $ReceiptPath 'C:\kmp-eval\scratch\'
if (-not (Test-Path -LiteralPath $inputLockFull -PathType Leaf)) { throw 'input_lock_missing' }
if (Test-Path -LiteralPath $answerMediaFull) { throw 'answer_media_already_exists' }
if (Test-Path -LiteralPath $receiptFull) { throw 'receipt_already_exists' }
if ($isRetry) {
  $priorFailureFull = Assert-PathInside $PriorFailureReceiptPath 'C:\kmp-eval\scratch\'
  $priorCustodyFull = [IO.Path]::GetFullPath($PriorFailureCustodyPath)
  $priorInputLockFull = Assert-PathInside $PriorInputLockPath 'C:\kmp-eval\scratch\'
  $priorInspectionFull = Assert-PathInside $PriorCreatedInspectionReceiptPath 'C:\kmp-eval\scratch\'
  if (-not (Test-Path -LiteralPath $priorFailureFull -PathType Leaf)) { throw 'prior_failure_receipt_missing' }
  if (-not (Test-Path -LiteralPath $priorCustodyFull -PathType Leaf)) { throw 'prior_failure_custody_missing' }
  foreach ($requiredRetryFile in @($priorInputLockFull,$priorInspectionFull)) {
    if (-not (Test-Path -LiteralPath $requiredRetryFile -PathType Leaf)) { throw 'prior_retry_artifact_missing' }
  }
  if (-not (Test-Path -LiteralPath $credentialFull -PathType Leaf)) { throw 'retry_guest_credential_missing' }
  if (-not (Test-Path -LiteralPath $privateRoot -PathType Container)) { throw 'retry_private_state_root_missing' }
} else {
  if (Test-Path -LiteralPath $credentialFull) { throw 'guest_credential_already_exists' }
  if (Test-Path -LiteralPath $privateRoot) { throw 'canonical_unattended_private_root_already_exists' }
}

$profile = Join-Path $repoRoot 'tools\evidence1\provisioning\evidence1-windows-hyperv-e2e-v1.json'

$implementationArgs = @{
  ProfilePath = $profile
  InputLockPath = $inputLockFull
  GuestCredentialPath = $credentialFull
  AnswerMediaPath = $answerMediaFull
  ReceiptPath = $receiptFull
  TimeoutSeconds = $TimeoutSeconds
  AuthorizationPhrase = $AuthorizationPhrase
}
if ($isRetry) {
  $implementationArgs.PriorFailureReceiptPath = $priorFailureFull
  $implementationArgs.PriorFailureCustodyPath = $priorCustodyFull
  $implementationArgs.PriorInputLockPath = $priorInputLockFull
  $implementationArgs.PriorCreatedInspectionReceiptPath = $priorInspectionFull
  $implementationArgs.PriorRunnerRequestId = $PriorRunnerRequestId
  $implementationArgs.RetryAuthorizationPhrase = $RetryAuthorizationPhrase
}
& $implementation @implementationArgs

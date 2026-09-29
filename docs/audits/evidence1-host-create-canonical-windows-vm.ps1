#Requires -RunAsAdministrator

param(
  [ValidateSet('Create', 'InspectCreated')] [string]$Mode = 'Create',
  [Parameter(Mandatory = $true)] [string]$InputLockPath,
  [Parameter(Mandatory = $true)] [string]$ReceiptPath,
  [string]$CreateAuthorizationPhrase = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RequiredPhrase = 'authorize create evidence1 windows vm from verified inputs'

function Assert-PathInside([string]$Candidate, [string]$Root) {
  $candidateFull = [IO.Path]::GetFullPath($Candidate)
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  if (-not $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'canonical_vm_private_path_outside_scratch'
  }
  return $candidateFull
}

if ($Mode -ceq 'Create' -and $CreateAuthorizationPhrase -cne $RequiredPhrase) { throw 'exact_create_authorization_required' }
if ($Mode -ceq 'InspectCreated' -and -not [string]::IsNullOrEmpty($CreateAuthorizationPhrase)) { throw 'inspect_authorization_must_be_empty' }
$inputLockFull = Assert-PathInside $InputLockPath 'C:\kmp-eval\scratch\'
$receiptFull = Assert-PathInside $ReceiptPath 'C:\kmp-eval\scratch\'
if (-not (Test-Path -LiteralPath $inputLockFull -PathType Leaf)) { throw 'input_lock_missing' }
if (Test-Path -LiteralPath $receiptFull) { throw 'receipt_already_exists' }

$hostContract = Join-Path $PSScriptRoot 'evidence1-host-snapshot-contract.psm1'
if (-not (Test-Path -LiteralPath $hostContract -PathType Leaf)) { throw 'canonical_vm_snapshot_contract_missing' }
Import-Module $hostContract -Force -ErrorAction Stop
$trustedRuntimeFiles = @(
  'tools/evidence1/provisioning/evidence1-windows-vm.ps1',
  'tools/evidence1/provisioning/Evidence1.Provisioning.psm1',
  'tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json',
  'tools/evidence1/provisioning/evidence1-windows-input-lock.schema.json',
  'tools/evidence1/provisioning/evidence1-windows-approved-inputs.schema.json'
)
$runtime = Resolve-E1HostTrustedRuntime -ScriptRoot $PSScriptRoot `
  -EntrypointName 'evidence1-host-create-canonical-windows-vm.ps1' `
  -TrustedRuntimeFiles $trustedRuntimeFiles
$repoRoot = [string]$runtime.Root
$creator = Join-Path $repoRoot 'tools\evidence1\provisioning\evidence1-windows-vm.ps1'
$profile = Join-Path $repoRoot 'tools\evidence1\provisioning\evidence1-windows-hyperv-e2e-v1.json'

if ($Mode -ceq 'Create') {
  & $creator -Mode Create -ProfilePath $profile -InputLockPath $inputLockFull `
    -ReceiptPath $receiptFull -CreateAuthorizationPhrase $CreateAuthorizationPhrase
} else {
  & $creator -Mode InspectCreated -ProfilePath $profile -InputLockPath $inputLockFull -ReceiptPath $receiptFull
}

#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory = $true)] [string]$InputLockPath,
  [Parameter(Mandatory = $true)] [string]$PriorInputLockPath,
  [Parameter(Mandatory = $true)] [string]$PriorFailureReceiptPath,
  [Parameter(Mandatory = $true)] [string]$CreatedInspectionReceiptPath,
  [Parameter(Mandatory = $true)] [string]$RunnerRequestId,
  [Parameter(Mandatory = $true)] [string]$GuestCredentialPath,
  [Parameter(Mandatory = $true)] [string]$PriorAnswerMediaPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$hostContract = Join-Path $PSScriptRoot 'evidence1-host-snapshot-contract.psm1'
if (-not (Test-Path -LiteralPath $hostContract -PathType Leaf)) { throw 'retry custody snapshot contract missing' }
Import-Module $hostContract -Force -ErrorAction Stop
$trustedRuntimeFiles = @(
  'tools/evidence1/provisioning/evidence1-new-unattended-retry-custody.ps1',
  'tools/evidence1/provisioning/Evidence1.Provisioning.psm1',
  'tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json'
)
$runtime = Resolve-E1HostTrustedRuntime -ScriptRoot $PSScriptRoot `
  -EntrypointName 'evidence1-host-new-unattended-retry-custody.ps1' `
  -TrustedRuntimeFiles $trustedRuntimeFiles
$repoRoot = [string]$runtime.Root
$implementation = Join-Path $repoRoot 'tools\evidence1\provisioning\evidence1-new-unattended-retry-custody.ps1'
$profile = Join-Path $repoRoot 'tools\evidence1\provisioning\evidence1-windows-hyperv-e2e-v1.json'

function Assert-PathInside([string]$Candidate, [string]$Root) {
  $full = [IO.Path]::GetFullPath($Candidate)
  $base = ([IO.Path]::GetFullPath($Root)).TrimEnd('\') + '\'
  if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
    throw "private path is outside expected root: $full"
  }
  return $full
}

$scratch = 'C:\kmp-eval\scratch'
$arguments = @{
  ProfilePath = $profile
  InputLockPath = Assert-PathInside $InputLockPath $scratch
  PriorInputLockPath = Assert-PathInside $PriorInputLockPath $scratch
  PriorFailureReceiptPath = Assert-PathInside $PriorFailureReceiptPath $scratch
  CreatedInspectionReceiptPath = Assert-PathInside $CreatedInspectionReceiptPath $scratch
  RunnerRequestId = $RunnerRequestId
  GuestCredentialPath = Assert-PathInside $GuestCredentialPath $scratch
  PriorAnswerMediaPath = Assert-PathInside $PriorAnswerMediaPath $scratch
}
& $implementation @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

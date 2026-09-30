param(
  [Parameter(Mandatory)][string]$ModulePath,
  [Parameter(Mandatory)][string]$TargetPath,
  [Parameter(Mandatory)][string]$TrustedRoot,
  [Parameter(Mandatory)][string]$ValuePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module $ModulePath -Force
$value=Get-Content -LiteralPath $ValuePath -Raw|ConvertFrom-Json -ErrorAction Stop
$null=Write-Evidence1DualConditionAtomicJson -Path $TargetPath -Value $value -TrustedRoot $TrustedRoot -TestCrashDuringWrite
throw 'dual_condition_expected_test_crash'

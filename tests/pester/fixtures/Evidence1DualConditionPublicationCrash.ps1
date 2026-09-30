param(
  [Parameter(Mandatory)][string]$ModulePath,
  [Parameter(Mandatory)][string]$SourceRoot,
  [Parameter(Mandatory)][string]$DestinationRoot,
  [Parameter(Mandatory)][string]$TrustedRoot,
  [Parameter(Mandatory)][string]$ManifestPath,
  [ValidateSet('after-first-file','transaction','ready')][string]$CrashPoint='after-first-file'
)

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module $ModulePath -Force
$artifacts=@(Get-Content -LiteralPath $ManifestPath -Raw|ConvertFrom-Json -ErrorAction Stop)
$arguments=@{SourceRoot=$SourceRoot;DestinationRoot=$DestinationRoot;TrustedRoot=$TrustedRoot;Tier='public';Artifacts=$artifacts}
if($CrashPoint-ceq'after-first-file'){$arguments.TestCrashAfterFiles=1}else{$arguments.TestCrashPoint=$CrashPoint}
$null=Publish-Evidence1DualConditionArtifactSet @arguments
throw 'dual_condition_expected_test_crash'

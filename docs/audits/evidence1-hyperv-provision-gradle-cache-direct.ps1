#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$TargetCommit,
    [Parameter(Mandatory=$true)][string]$TargetTree,
    [Parameter(Mandatory=$true)][string]$ExpectedReportSha256,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$ProvisionId,
    [switch]$ReadDiagnostics
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$result=@{schema=1;operation='gradle-cache-provision';state='failed';failure_code='module_import_failed';subject=$null;module_sha256=$null;warm=$null;certify=$null;network=$null}
$stream=$null
try {
    foreach($name in @('evidence1-validation-ops.psm1','evidence1-validation-forensics.psm1','evidence1-gradle-offline-probe.psm1','evidence1-gradle-cache-provision.psm1','evidence1-cache-provision-host.psm1')) {
        Import-Module (Join-Path $PSScriptRoot $name) -Force -DisableNameChecking
    }
    $root=Resolve-E1Path 'C:\kmp-eval\scratch\hyperv-cache-provision-direct'
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $fileName=if($ReadDiagnostics){$ProvisionId+'.read-'+[guid]::NewGuid().ToString('N')+'.json'}else{$ProvisionId+'.json'}
    $path=Resolve-E1Path (Join-Path $root $fileName)
    $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    Write-E1Record $stream $result
    $result=Invoke-E1CacheProvisionDirect $TargetCommit $TargetTree $ExpectedReportSha256 $ProvisionId -ReadDiagnostics:$ReadDiagnostics
    Write-E1Record $stream $result
} catch {$result.state='failed';$result.failure_code='report_write_failed'}
finally {if($stream) {$stream.Dispose()}}
Write-Output ($result | ConvertTo-Json -Depth 12 -Compress)
if($result.state -ceq 'passed') {exit 0}
exit 1

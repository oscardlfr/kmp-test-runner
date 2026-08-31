#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$TargetCommit,
    [Parameter(Mandatory=$true)][string]$TargetTree,
    [Parameter(Mandatory=$true)][string]$ExpectedReportSha256,
    [switch]$AuditNetwork,
    [switch]$DisconnectNetwork,
    [switch]$RestoreNetwork
)
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$result=@{schema=1;operation='gradle-offline-cache-probe';state='failed';failure_code='module_import_failed';receipt=$null;subject=$null;module_sha256=$null}
if($AuditNetwork) {$result.operation='gradle-offline-network-audit'}
$stream=$null
try {
    Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1') -Force -DisableNameChecking
    Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-forensics.psm1') -Force -DisableNameChecking
    Import-Module (Join-Path $PSScriptRoot 'evidence1-gradle-offline-probe.psm1') -Force -DisableNameChecking
    $root=Resolve-E1Path 'C:\kmp-eval\scratch\hyperv-probe-gradle-offline-direct'
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $path=Resolve-E1Path (Join-Path $root ('PROBE-' + [guid]::NewGuid().ToString('N') + '.json'))
    $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    Write-E1Record $stream $result
    $result=Invoke-E1OfflineDirect $TargetCommit $TargetTree $ExpectedReportSha256 -AuditNetwork:$AuditNetwork -DisconnectNetwork:$DisconnectNetwork -RestoreNetwork:$RestoreNetwork
    Write-E1Record $stream $result
} catch {$result.state='failed';$result.failure_code='report_write_failed'}
finally {if($stream) {$stream.Dispose()}}
Write-Output ($result | ConvertTo-Json -Depth 12 -Compress)
if($result.state -ceq 'passed') {exit 0}
exit 1

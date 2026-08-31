[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$TargetCommit,
    [Parameter(Mandatory=$true)][string]$TargetTree
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$result=@{schema=1;operation='source-artifact-inventory';state='failed';failure_code='module_import_failed'
    target_commit=$null;target_tree=$null;inventory=$null;hashes=@{}
    agent_calls=0;product_invocations=0;guest_writes=0;source_file_contents_read=$false;validation_pass=$false}
$stream=$null
try {
    Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1') -Force -DisableNameChecking
    Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-forensics.psm1') -Force -DisableNameChecking
    $directory=Resolve-E1Path 'C:\kmp-eval\scratch\hyperv-read-source-inventory-direct'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $path=Resolve-E1Path (Join-Path $directory ('INVENTORY-' + [guid]::NewGuid().ToString('N') + '.json'))
    $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    Write-E1Record $stream $result
    $result=Invoke-E1ForensicSourceRead $TargetCommit $TargetTree
    Write-E1Record $stream $result
} catch {
    $result.state='failed'; $result.failure_code='collector_failed'; $result.validation_pass=$false
    if ($stream) { try { Write-E1Record $stream $result } catch {} }
} finally { if ($stream) { $stream.Dispose() } }
Write-Output ($result | ConvertTo-Json -Depth 10 -Compress)
if ($result.state -ceq 'passed') { exit 0 }
exit 1

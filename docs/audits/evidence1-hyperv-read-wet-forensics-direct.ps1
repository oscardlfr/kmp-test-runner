[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$TargetCommit,
    [Parameter(Mandatory=$true)][string]$TargetTree,
    [Parameter(Mandatory=$true)][string]$ExpectedReportSha256
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$result = @{ schema=1; operation='wet-v2-forensic-read'; state='failed'; failure_code='module_import_failed' }
$stream = $null
try {
    Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1') -Force -DisableNameChecking
    Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-forensics.psm1') -Force -DisableNameChecking
    $directory = Resolve-E1Path 'C:\kmp-eval\scratch\hyperv-read-wet-forensics-direct'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $path = Resolve-E1Path (Join-Path $directory ('FORENSIC-' + [guid]::NewGuid().ToString('N') + '.json'))
    $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    Write-E1Record $stream $result
    $result = Invoke-E1ForensicRead $TargetCommit $TargetTree $ExpectedReportSha256
    Write-E1Record $stream $result
} catch { $result = @{ schema=1; operation='wet-v2-forensic-read'; state='failed'; failure_code='collector_failed' } }
finally { if ($stream) { $stream.Dispose() } }
Write-Output ($result | ConvertTo-Json -Depth 14 -Compress)
if ($result.state -ceq 'passed') { exit 0 }
exit 1

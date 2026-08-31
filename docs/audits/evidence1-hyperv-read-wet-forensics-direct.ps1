[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$TargetCommit,
    [Parameter(Mandatory=$true)][string]$TargetTree,
    [Parameter(Mandatory=$true)][string]$ExpectedReportSha256,
    [switch]$IncludeGradleDiagnostics
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$result = @{ schema=1; operation='wet-v2-forensic-read'; state='failed'; failure_code='module_import_failed' }
if ($IncludeGradleDiagnostics) {
    $result.schema=2; $result.gradle_stderr_read_requested=$true; $result.stderr_read=$false
    $result.gradle_diagnostics=$null; $result.raw_transcript_read=$false
    $result.agent_calls=0; $result.product_invocations=0; $result.guest_writes=0
}
$stream = $null
$phase = 'bootstrap'
try {
    Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1') -Force -DisableNameChecking
    Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-forensics.psm1') -Force -DisableNameChecking
    $directory = Resolve-E1Path 'C:\kmp-eval\scratch\hyperv-read-wet-forensics-direct'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $path = Resolve-E1Path (Join-Path $directory ('FORENSIC-' + [guid]::NewGuid().ToString('N') + '.json'))
    $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $phase = 'report-write'
    Write-E1Record $stream $result
    $phase = 'collect'
    $result = Invoke-E1ForensicRead $TargetCommit $TargetTree $ExpectedReportSha256 -IncludeGradleDiagnostics:$IncludeGradleDiagnostics
    $phase = 'report-write'
    Write-E1Record $stream $result
} catch {
    $result.state='failed'
    $result.failure_code=$(if ($phase -ceq 'report-write') { 'report_write_failed' } else { 'collector_failed' })
    if ($stream) { try { Write-E1Record $stream $result } catch {} }
}
finally { if ($stream) { $stream.Dispose() } }
Write-Output ($result | ConvertTo-Json -Depth 14 -Compress)
if ($result.state -ceq 'passed') { exit 0 }
exit 1

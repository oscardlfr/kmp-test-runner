[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TargetCommit,
    [Parameter(Mandatory = $true)][string]$TargetTree,
    [string]$VMName = 'Evidence1-Runner',
    [string]$GuestComputerName = 'Evidence1Runner',
    [string]$GuestCredentialPath = 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml',
    [string]$HarnessDir = 'C:\kmp-eval\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1',
    [string]$NowInAndroidDir = 'C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1',
    [string]$AttestationFile = 'C:\kmp-eval\measurement-scopes\evidence1-claude-windows-isolation-attestation-stageb-v1.json',
    [string]$ReportPath = 'C:\kmp-eval\scratch\hyperv-verify-wet-gate-v2-direct\HYPERV-VERIFY-WET-GATE-V2-DIRECT.json'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$result = [ordered]@{
    schema = 1; operation = 'wet-v2'; state = 'failed'; failure_code = 'module_import_failed'; stage = 'bootstrap'
    target_commit = $(if ($TargetCommit -cmatch '^[a-f0-9]{40}$') { $TargetCommit } else { $null })
    target_tree = $(if ($TargetTree -cmatch '^[a-f0-9]{40}$') { $TargetTree } else { $null })
    agent_calls = 0; live_records_created = $null
}
# Publish a fresh bounded failure before loading the module, so a missing/corrupt module
# cannot leave an earlier PASS as the current host report. This guard has no module dependency.
try {
    $path = $ReportPath.Replace('/', '\')
    $root = 'C:\kmp-eval\scratch\hyperv-verify-wet-gate-v2-direct\'
    if ($path -notmatch '^C:\\[A-Za-z0-9 _.-]+(?:\\[A-Za-z0-9 _.-]+)*\.json$' -or
        -not $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'bootstrap_path' }
    foreach ($part in $path.Substring(3).Split('\')) {
        if ($part -in @('.', '..') -or $part.EndsWith('.') -or $part.EndsWith(' ')) { throw 'bootstrap_path' }
    }
    $ancestor = $path
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            $link = $item.PSObject.Properties['LinkType']
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                ($link -and $link.Value -eq 'HardLink')) { throw 'bootstrap_path' }
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
    [IO.File]::WriteAllText($path, ($result | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
} catch {
    $result.failure_code = 'report_write_failed'
    Write-Output ($result | ConvertTo-Json -Compress)
    exit 1
}
try {
    Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1') -Force -DisableNameChecking
    $parameters = @{}
    foreach ($name in @('TargetCommit','TargetTree','VMName','GuestComputerName','GuestCredentialPath','HarnessDir','NowInAndroidDir','AttestationFile','ReportPath')) {
        $parameters[$name] = Get-Variable -Name $name -ValueOnly
    }
    $result = Invoke-E1ValidationDirect -Operation 'wet-v2' @parameters
} catch { }
Write-Output ($result | ConvertTo-Json -Depth 12 -Compress)
if ($result.state -ceq 'passed') { exit 0 }
exit 1

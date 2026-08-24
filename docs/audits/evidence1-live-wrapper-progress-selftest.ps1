Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$contract = Join-Path $root 'evidence1-live-run-contract.psm1'
$wrapper = Join-Path $root 'evidence1-stageb-live-wrapper.ps1'
$progress = Join-Path $root 'evidence1-hyperv-read-live-progress.ps1'
$copy = Join-Path $root 'evidence1-hyperv-copy-live-artifacts.ps1'

foreach ($path in @($contract, $wrapper, $progress, $copy)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Error "required Evidence 1 live file missing: $path"
        exit 1
    }
}

Import-Module $contract -Force

$runId = '00000000-0000-0000-0000-000000000001'
$validTerminal = [pscustomobject]@{
    schema = 1
    run_id = $runId
    state = 'exited'
    exit_code = 0
    exit_code_source = 'launcher_record'
}
$terminalResult = Test-Evidence1TerminalRecordObject -Record $validTerminal -Source 'selftest' -ExpectedRunId $runId
if (-not $terminalResult.valid -or $terminalResult.exit_code -ne 0) {
    Write-Error 'valid terminal record did not validate'
    exit 1
}

$wrongRunTerminal = [pscustomobject]@{
    schema = 1
    run_id = '00000000-0000-0000-0000-000000000002'
    state = 'exited'
    exit_code = 0
    exit_code_source = 'launcher_record'
}
$wrongRunResult = Test-Evidence1TerminalRecordObject -Record $wrongRunTerminal -Source 'selftest' -ExpectedRunId $runId
if ($wrongRunResult.valid -or $wrongRunResult.reason -ne 'run_id_mismatch') {
    Write-Error 'terminal run_id mismatch was not rejected'
    exit 1
}

$wrapperText = Get-Content -LiteralPath $wrapper -Raw
$terminalBreak = $wrapperText.IndexOf('$launcherRecord = Read-Evidence1TerminalRecord -Path $launcherTerminalPath -ExpectedRunId $RunId', [StringComparison]::Ordinal)
$firstKill = $wrapperText.IndexOf('Stop-Evidence1ProcessTree -ProcessId $process.Id', [StringComparison]::Ordinal)
$boundedWait = $wrapperText.IndexOf('$process.WaitForExit($StopTimeoutMilliseconds)', [StringComparison]::Ordinal)
if ($terminalBreak -lt 0 -or $boundedWait -lt 0 -or $firstKill -lt 0) {
    Write-Error 'wrapper terminal/kill anchors are missing'
    exit 1
}
if (-not ($terminalBreak -lt $boundedWait -and $boundedWait -lt $firstKill)) {
    Write-Error 'wrapper must wait for natural launcher exit before bounded process-tree termination'
    exit 1
}

$progressText = Get-Content -LiteralPath $progress -Raw
foreach ($fragment in @(
    'Test-Evidence1TerminalRecordObject -Record $guest.terminal',
    'Test-Evidence1TerminalRecordObject -Record $guest.launcher_terminal',
    '$direct.terminal.valid',
    '$direct.launcher_terminal.valid'
)) {
    if (-not $progressText.Contains($fragment)) {
        Write-Error "progress reader missing terminal precedence fragment: $fragment"
        exit 1
    }
}

$copyText = Get-Content -LiteralPath $copy -Raw
$wrapperTerminalIndex = $copyText.IndexOf("Read-TerminalExitCandidate (Join-Path `$OutDir 'STAGE-B-live.exit.json')", [StringComparison]::Ordinal)
$launcherTerminalIndex = $copyText.IndexOf("Read-TerminalExitCandidate (Join-Path `$OutDir 'STAGE-B-live.launcher-exit.json')", [StringComparison]::Ordinal)
$legacyMarkerIndex = $copyText.IndexOf("'legacy_exit_txt'", [StringComparison]::Ordinal)
if ($wrapperTerminalIndex -lt 0 -or $launcherTerminalIndex -lt 0 -or $legacyMarkerIndex -lt 0) {
    Write-Error 'copy script exit-resolution anchors are missing'
    exit 1
}
if (-not ($wrapperTerminalIndex -lt $launcherTerminalIndex -and $launcherTerminalIndex -lt $legacyMarkerIndex)) {
    Write-Error 'copy script must prefer terminal records before legacy exit.txt'
    exit 1
}

Write-Host 'PASS_EVIDENCE1_LIVE_WRAPPER_PROGRESS_CONTRACT'

param(
    [Parameter(Mandatory)]
    [string]$RunId,

    [string]$LauncherPath = 'C:\Evidence1Ops\evidence1-stageb-live-launch.ps1',
    [string]$OpsDir = 'C:\Evidence1Ops',
    [string]$HarnessDir = 'C:\kmp-eval\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1',
    [ValidateRange(1, 60)]
    [int]$HeartbeatSeconds = 15,
    [ValidateRange(1000, 60000)]
    [int]$StopTimeoutMilliseconds = 10000,
    [switch]$ShutdownOnExit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$contractPath = Join-Path $PSScriptRoot 'evidence1-live-run-contract.psm1'
Import-Module $contractPath -Force

$parsedRunId = [guid]::Empty
if (-not [guid]::TryParseExact($RunId, 'D', [ref]$parsedRunId)) {
    throw 'RunId must be a canonical D-format GUID'
}
if (-not (Test-Path -LiteralPath $LauncherPath -PathType Leaf)) {
    throw 'live launcher is missing'
}

New-Item -ItemType Directory -Force -Path $OpsDir | Out-Null
$statusPath = Join-Path $OpsDir 'STAGE-B-live.status.json'
$terminalPath = Join-Path $OpsDir 'STAGE-B-live.exit.json'
$launcherTerminalPath = Join-Path $OpsDir 'STAGE-B-live.launcher-exit.json'
$stdoutPath = Join-Path $OpsDir 'STAGE-B-live.stdout.log'
$stderrPath = Join-Path $OpsDir 'STAGE-B-live.stderr.log'
$started = [DateTime]::UtcNow
$process = $null
$processExitCode = $null
$exitCode = 997
$exitCodeSource = 'wrapper_error'
$state = 'wrapper_error'
$wrapperErrorType = $null
$wrapperErrorStage = $null
$currentStage = 'initializing'
$stdoutStream = $null
$stderrStream = $null
$stdoutCopy = $null
$stderrCopy = $null

function ConvertTo-ProcessArgument([string]$Value) {
    if ($Value -match '["\r\n]') {
        throw 'process arguments cannot contain quotes or line breaks'
    }
    return '"' + $Value + '"'
}

function Complete-RedirectedStreams {
    foreach ($copy in @($stdoutCopy, $stderrCopy)) {
        if ($null -ne $copy) { $copy.GetAwaiter().GetResult() }
    }
    foreach ($stream in @($stdoutStream, $stderrStream)) {
        if ($null -ne $stream) { $stream.Dispose() }
    }
    $script:stdoutCopy = $null
    $script:stderrCopy = $null
    $script:stdoutStream = $null
    $script:stderrStream = $null
}

function Get-JournalProgress {
    $journalRoot = Join-Path $HarnessDir 'tools\runs\agentic-eval-journal'
    if (-not (Test-Path -LiteralPath $journalRoot)) {
        return [ordered]@{ journal_id = $null; event_count = 0; latest_event = $null; transition_counts = @{} }
    }
    $journal = Get-ChildItem -LiteralPath $journalRoot -Directory -Force -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if ($null -eq $journal) {
        return [ordered]@{ journal_id = $null; event_count = 0; latest_event = $null; transition_counts = @{} }
    }

    $eventsDir = Join-Path $journal.FullName 'events'
    $events = if (Test-Path -LiteralPath $eventsDir) {
        @(Get-ChildItem -LiteralPath $eventsDir -Filter '*.json' -File -Force -ErrorAction SilentlyContinue | Sort-Object Name)
    } else {
        @()
    }
    $counts = [ordered]@{}
    foreach ($event in $events) {
        if ($event.Name -match '^[0-9]+-[0-9]+-(.+)\.json$') {
            $transition = $Matches[1]
            if (-not $counts.Contains($transition)) { $counts[$transition] = 0 }
            $counts[$transition] += 1
        }
    }

    return [ordered]@{
        journal_id = $journal.Name
        event_count = $events.Count
        latest_event = if ($events.Count -gt 0) { $events[-1].Name } else { $null }
        transition_counts = $counts
    }
}

function Write-Status([string]$CurrentState, [int]$CurrentExitCode) {
    $snapshot = [ordered]@{
        schema = 1
        run_id = $RunId
        state = $CurrentState
        ts_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        elapsed_seconds = [int]([DateTime]::UtcNow - $started).TotalSeconds
        launcher_pid = if ($process) { $process.Id } else { $null }
        process_exit_code = $processExitCode
        exit_code = $CurrentExitCode
        exit_code_source = $exitCodeSource
        wrapper_error_type = $wrapperErrorType
        wrapper_error_stage = $wrapperErrorStage
        stdout_bytes = if (Test-Path -LiteralPath $stdoutPath) { (Get-Item -LiteralPath $stdoutPath).Length } else { 0 }
        stderr_bytes = if (Test-Path -LiteralPath $stderrPath) { (Get-Item -LiteralPath $stderrPath).Length } else { 0 }
        journal = Get-JournalProgress
    }
    Write-Evidence1JsonAtomically -Path $statusPath -Value $snapshot
    try {
        $regPath = 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest'
        New-Item -Path $regPath -Force | Out-Null
        New-ItemProperty -Path $regPath -Name 'Evidence1StageBProgress' -Value ($snapshot | ConvertTo-Json -Depth 8 -Compress) -PropertyType String -Force | Out-Null
    } catch {
        # The on-disk status remains authoritative; KVP is best-effort transport only.
    }
}

try {
    $currentStage = 'write_starting_status'
    Write-Status 'starting' $exitCode
    $currentStage = 'start_launcher'
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $argumentValues = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $LauncherPath,
        '-RunId', $RunId,
        '-TerminalRecordPath', $launcherTerminalPath
    )
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $powershell
    $startInfo.Arguments = ($argumentValues | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $stdoutStream = [IO.FileStream]::new($stdoutPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    $stderrStream = [IO.FileStream]::new($stderrPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    if (-not $process.Start()) { throw 'launcher process could not be started' }
    $stdoutCopy = $process.StandardOutput.BaseStream.CopyToAsync($stdoutStream)
    $stderrCopy = $process.StandardError.BaseStream.CopyToAsync($stderrStream)

    while (-not $process.HasExited) {
        $currentStage = 'monitor_launcher'
        $process.Refresh()
        Write-Status 'running' $exitCode
        $launcherRecord = Read-Evidence1TerminalRecord -Path $launcherTerminalPath -ExpectedRunId $RunId
        if ($launcherRecord.valid) {
            $exitCode = $launcherRecord.exit_code
            $exitCodeSource = 'launcher_record'
            break
        }
        Start-Sleep -Seconds $HeartbeatSeconds
    }

    $currentStage = 'wait_for_launcher_exit'
    if (-not $process.WaitForExit($StopTimeoutMilliseconds)) {
        $launcherRecord = Read-Evidence1TerminalRecord -Path $launcherTerminalPath -ExpectedRunId $RunId
        if ($launcherRecord.valid) {
            $exitCode = $launcherRecord.exit_code
            $exitCodeSource = 'launcher_record'
            $stop = Stop-Evidence1ProcessTree -ProcessId $process.Id -TimeoutMilliseconds $StopTimeoutMilliseconds
            if (-not $stop.stopped) {
                throw 'launcher process tree did not terminate after publishing its terminal record'
            }
            $state = 'terminated_after_launcher_exit'
        } else {
            throw 'launcher process did not exit within the bounded wait'
        }
    }
    $process.WaitForExit()
    Complete-RedirectedStreams
    $currentStage = 'read_launcher_exit_code'
    $process.Refresh()
    if ($null -ne $process.ExitCode) { $processExitCode = [int]($process.ExitCode) }

    $launcherRecord = Read-Evidence1TerminalRecord -Path $launcherTerminalPath -ExpectedRunId $RunId
    if ($launcherRecord.valid) {
        $exitCode = $launcherRecord.exit_code
        $exitCodeSource = 'launcher_record'
    } elseif ($null -ne $processExitCode) {
        $exitCode = $processExitCode
        $exitCodeSource = 'process_exit_code'
    } else {
        throw 'launcher ended without a usable terminal record or process exit code'
    }
    if ($state -ne 'terminated_after_launcher_exit') { $state = 'exited' }
} catch {
    $exitCode = 997
    $exitCodeSource = 'wrapper_error'
    $state = 'wrapper_error'
    $wrapperErrorType = $_.Exception.GetType().Name
    $wrapperErrorStage = $currentStage
    if ($process -and -not $process.HasExited) {
        [void](Stop-Evidence1ProcessTree -ProcessId $process.Id -TimeoutMilliseconds $StopTimeoutMilliseconds)
    }
    try { Complete-RedirectedStreams } catch { }
} finally {
    $terminal = [ordered]@{
        schema = 1
        run_id = $RunId
        state = $state
        ts_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        exit_code = $exitCode
        exit_code_source = $exitCodeSource
        wrapper_error_type = $wrapperErrorType
        wrapper_error_stage = $wrapperErrorStage
    }
    Write-Evidence1JsonAtomically -Path $terminalPath -Value $terminal
    Write-Status $state $exitCode
    if ($ShutdownOnExit) {
        & (Join-Path $env:SystemRoot 'System32\shutdown.exe') /s /t 10 /f | Out-Null
    }
}

exit $exitCode

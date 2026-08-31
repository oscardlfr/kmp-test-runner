param(
    [Parameter(Mandatory)]
    [string]$RunId,
    [string]$CanaryArm = '',
    [string]$CanaryBindingSha256 = '',

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

$canary = $null
$script:CanaryJournalSnapshot = $null
$script:CanaryLauncherDiagnostics = $null
$script:CanaryOperation = $null
$script:CanaryOperationJoined = $false
$script:CanaryObservationFailed = $false
$canaryDirectory = Join-Path $OpsDir "canary\$RunId"
if ($CanaryArm -or $CanaryBindingSha256) {
    Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1') -ErrorAction Stop
    if ($CanaryArm -cnotin @('product','free-baseline') -or -not $CanaryBindingSha256) { throw 'canary_wrapper_parameters' }
    $canary = Read-Evidence1CanaryBundle $canaryDirectory $RunId $CanaryArm $CanaryBindingSha256
    if ((Get-FileHash -LiteralPath $LauncherPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $canary.binding.scripts['evidence1-stageb-live-launch.ps1']) { throw 'canary_launcher_drift' }
    # Claim before opening shared operational logs: replay must not overwrite the first attempt.
    $null = New-Evidence1CanaryClaim $canaryDirectory $RunId $CanaryBindingSha256 'wrapper'
    $journalRoot = Join-Path $HarnessDir 'tools\runs\agentic-eval-journal'
    $baseline = @(if (Test-Path -LiteralPath $journalRoot) { Get-ChildItem -LiteralPath $journalRoot -Directory -Force | ForEach-Object Name })
    Write-Evidence1JsonAtomically (Join-Path $canaryDirectory 'journal-baseline.json') @{ run_id = $RunId; binding_sha256 = $CanaryBindingSha256; journal_ids = $baseline }
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
    if ($canary) {
        $path = Join-Path $canaryDirectory 'journal.json'
        # The launcher is the only journal observer; the wrapper transports its safe snapshot.
        if (-not $script:CanaryObservationFailed -and (Test-Path -LiteralPath $path)) {
            $snapshot = ConvertTo-Evidence1CanaryJournalSnapshot (Read-Evidence1CanaryJson $path).value $RunId
            $script:CanaryJournalSnapshot = $snapshot
        }
        return $script:CanaryJournalSnapshot
    }
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
    if ($canary) { $snapshot.canary = @{ arm = $CanaryArm; planned_sessions = 1; binding_sha256 = $CanaryBindingSha256 } }
    Write-Evidence1JsonAtomically -Path $statusPath -Value $snapshot
    try {
        $regPath = 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest'
        New-Item -Path $regPath -Force | Out-Null
        New-ItemProperty -Path $regPath -Name 'Evidence1StageBProgress' -Value ($snapshot | ConvertTo-Json -Depth 8 -Compress) -PropertyType String -Force | Out-Null
    } catch {
        # The on-disk status remains authoritative; KVP is best-effort transport only.
    }
}

function Invoke-Evidence1CanaryWrapper([string]$Executable, [string[]]$Arguments) {
    $script:currentStage = 'start_launcher'
    $script:CanaryOperation = Start-E1OwnedProcess $Executable $Arguments $HarnessDir $stdoutPath $stderrPath 2400
    while (-not $script:CanaryOperation.Task.IsCompleted) {
        $script:currentStage = 'monitor_launcher'
        Write-Status 'running' 997
        Start-Sleep -Milliseconds 200
    }
    $script:currentStage = 'wait_for_launcher_exit'
    $result = Wait-E1OwnedProcess $script:CanaryOperation
    $script:CanaryOperationJoined = $true
    $script:processExitCode = [int]$result.ExitCode
    if ($result.TimedOut -or $result.Cancelled -or -not $result.CleanupOk) { throw 'canary_process_cleanup' }
    $script:currentStage = 'read_launcher_exit_code'
    $record = Read-Evidence1TerminalRecord -Path $launcherTerminalPath -ExpectedRunId $RunId
    if (-not $record.valid) { throw 'canary_terminal_required' }
    Assert-Evidence1CanaryTerminalBinding $record.record $RunId $CanaryArm $CanaryBindingSha256
    $script:CanaryLauncherDiagnostics = ConvertTo-Evidence1CanaryDiagnostics $record.record.diagnostics
    $script:exitCode = $record.exit_code
    $script:exitCodeSource = 'launcher_record'
    $script:state = 'exited'
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
    if ($canary) { $argumentValues += @('-CanaryArm', $CanaryArm, '-CanaryBindingSha256', $CanaryBindingSha256) }
    if ($canary) {
        Invoke-Evidence1CanaryWrapper $powershell $argumentValues
    } else {
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
        Start-Sleep -Seconds $(if ($canary) { 1 } else { $HeartbeatSeconds })
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
    }
} catch {
    $primaryFailure = $_
    $exitCode = 997
    $exitCodeSource = 'wrapper_error'
    $state = 'wrapper_error'
    $wrapperErrorType = $_.Exception.GetType().Name
    $wrapperErrorStage = $currentStage
    $script:CanaryObservationFailed = $true
    if ($canary) {
        if (-not $script:CanaryLauncherDiagnostics) { $script:CanaryLauncherDiagnostics = New-Evidence1CanaryDiagnostics }
        $phase = if ($currentStage -eq 'monitor_launcher') { 'journal' } else { 'live' }
        Set-Evidence1CanaryFailure $script:CanaryLauncherDiagnostics 'primary' $phase $primaryFailure
    }
    if ($canary -and $script:CanaryOperation -and -not $script:CanaryOperationJoined) {
        try {
            Stop-E1OwnedProcess $script:CanaryOperation
            $cleanup = Wait-E1OwnedProcess $script:CanaryOperation
            if (-not $cleanup.CleanupOk) { throw 'canary_process_cleanup' }
        } catch { Set-Evidence1CanaryFailure $script:CanaryLauncherDiagnostics 'cleanup' 'live' $_ }
    }
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
    if ($canary) {
        $terminal.canary = @{ arm = $CanaryArm; planned_sessions = 1; binding_sha256 = $CanaryBindingSha256 }
        $terminal.diagnostics = $script:CanaryLauncherDiagnostics
    }
    if ($canary) {
        try {
            try { Write-Status $state $exitCode }
            catch {
                Set-Evidence1CanaryFailure $script:CanaryLauncherDiagnostics 'persistence' 'terminal_write' $_
                $exitCode = 997; $terminal.exit_code = 997; $terminal.state = 'wrapper_error'
            }
            Write-Evidence1JsonAtomically -Path $terminalPath -Value $terminal
        } finally {
            if ($ShutdownOnExit) { & (Join-Path $env:SystemRoot 'System32\shutdown.exe') /s /t 10 /f | Out-Null }
        }
    } else {
        Write-Evidence1JsonAtomically -Path $terminalPath -Value $terminal
        Write-Status $state $exitCode
        if ($ShutdownOnExit) {
            & (Join-Path $env:SystemRoot 'System32\shutdown.exe') /s /t 10 /f | Out-Null
        }
    }
}

exit $exitCode

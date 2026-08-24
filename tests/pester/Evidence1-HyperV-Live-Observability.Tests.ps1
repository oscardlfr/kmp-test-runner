#Requires -Modules Pester

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:AuditRoot = Join-Path $script:RepoRoot 'docs\audits'
    $script:ContractPath = Join-Path $script:AuditRoot 'evidence1-live-run-contract.psm1'
    $script:WrapperPath = Join-Path $script:AuditRoot 'evidence1-stageb-live-wrapper.ps1'
    $script:PlacePath = Join-Path $script:AuditRoot 'evidence1-hyperv-place-live-autorun.ps1'
    $script:ProgressPath = Join-Path $script:AuditRoot 'evidence1-hyperv-read-live-progress.ps1'
}

Describe 'Evidence1 Hyper-V live observability scripts' {
    It 'ships the reusable run contract and standalone wrapper' {
        $script:ContractPath | Should -Exist
        $script:WrapperPath | Should -Exist
    }

    It 'parses every shipped PowerShell artifact' {
        $paths = @(
            $script:ContractPath
            $script:WrapperPath
            $script:PlacePath
            $script:ProgressPath
            (Join-Path $script:AuditRoot 'evidence1-stageb-live-launch.ps1')
        )
        foreach ($path in $paths) {
            $tokens = $null
            $errors = $null
            [void][System.Management.Automation.Language.Parser]::ParseFile(
                $path,
                [ref]$tokens,
                [ref]$errors
            )
            $errors | Should -HaveCount 0 -Because $path
        }
    }

    It 'contains no maintainer-specific host checkout path' {
        $content = Get-Content -LiteralPath $script:PlacePath -Raw
        $content | Should -Not -Match 'Users\\[0-9]+\\AndroidStudioProjects'
        $content | Should -Match '\$PSScriptRoot'
    }

    It 'does not delete the Startup entry before invoking the live wrapper' {
        $content = Get-Content -LiteralPath $script:PlacePath -Raw
        $deleteIndex = $content.IndexOf('del "%SELF%"', [StringComparison]::Ordinal)
        $invokeIndex = $content.IndexOf('-File "$wrapperGuestPath"', [StringComparison]::Ordinal)
        $deleteIndex | Should -BeGreaterOrEqual 0
        $invokeIndex | Should -BeGreaterOrEqual 0
        $deleteIndex | Should -BeGreaterThan $invokeIndex
        $content | Should -Match 'set "WRAPPER_EXIT=%ERRORLEVEL%"'
        $content | Should -Match 'exit /b %WRAPPER_EXIT%'
    }

    It 'does not collect process command lines or inspect operational logs' {
        $content = Get-Content -LiteralPath $script:ProgressPath -Raw
        $content | Should -Not -Match '\bCommandLine\b'
        $content | Should -Not -Match 'Get-Content.+(?:stdout|stderr|STAGE-B-live\.log)'
    }
}

Describe 'Evidence1 live run contract' {
    BeforeAll {
        Import-Module $script:ContractPath -Force
    }

    It 'writes and validates a run-scoped terminal record atomically' {
        $path = Join-Path $TestDrive 'terminal.json'
        $runId = [guid]::NewGuid().ToString('D')
        $record = [ordered]@{
            schema = 1
            run_id = $runId
            state = 'exited'
            ts_utc = '2026-08-23T00:00:00.000Z'
            exit_code = 7
            exit_code_source = 'launcher_record'
        }

        Write-Evidence1JsonAtomically -Path $path -Value $record
        $actual = Read-Evidence1TerminalRecord -Path $path -ExpectedRunId $runId

        $actual.valid | Should -BeTrue
        $actual.exit_code | Should -Be 7
        Get-ChildItem -LiteralPath $TestDrive -Filter '*.tmp' | Should -HaveCount 0

        $record.exit_code = 8
        Write-Evidence1JsonAtomically -Path $path -Value $record
        (Read-Evidence1TerminalRecord -Path $path -ExpectedRunId $runId).exit_code | Should -Be 8
    }

    It 'rejects stale and malformed terminal records' {
        $path = Join-Path $TestDrive 'stale.json'
        $runId = [guid]::NewGuid().ToString('D')
        Write-Evidence1JsonAtomically -Path $path -Value ([ordered]@{
            schema = 1
            run_id = [guid]::NewGuid().ToString('D')
            state = 'exited'
            ts_utc = '2026-08-23T00:00:00.000Z'
            exit_code = 0
            exit_code_source = 'launcher_record'
        })

        (Read-Evidence1TerminalRecord -Path $path -ExpectedRunId $runId).reason | Should -Be 'run_id_mismatch'
        Set-Content -LiteralPath $path -Value '{not-json' -Encoding UTF8
        (Read-Evidence1TerminalRecord -Path $path -ExpectedRunId $runId).reason | Should -Be 'invalid_json'

        Set-Content -LiteralPath $path -Value '{"schema":1}' -Encoding UTF8
        (Read-Evidence1TerminalRecord -Path $path -ExpectedRunId $runId).reason | Should -Be 'invalid_shape'
    }

    It 'rejects stale progress and accepts only the expected run identity' {
        $runId = [guid]::NewGuid().ToString('D')
        $progress = [pscustomobject]@{
            schema = 1
            run_id = $runId
            state = 'running'
            elapsed_seconds = 12
            exit_code = 997
            exit_code_source = 'wrapper_error'
            journal = [pscustomobject]@{ event_count = 3 }
        }

        (Test-Evidence1ProgressRecord -Record $progress -Source 'test' -ExpectedRunId $runId).valid | Should -BeTrue
        $progress.run_id = [guid]::NewGuid().ToString('D')
        (Test-Evidence1ProgressRecord -Record $progress -Source 'test' -ExpectedRunId $runId).reason | Should -Be 'run_id_mismatch'
    }

    It 'terminates a process tree within a bounded wait' {
        $child = Start-Process -FilePath powershell.exe -ArgumentList @(
            '-NoProfile',
            '-Command',
            'Start-Sleep -Seconds 300'
        ) -WindowStyle Hidden -PassThru
        try {
            $result = Stop-Evidence1ProcessTree -ProcessId $child.Id -TimeoutMilliseconds 5000
            $result.stopped | Should -BeTrue
            Get-Process -Id $child.Id -ErrorAction SilentlyContinue | Should -BeNullOrEmpty
        } finally {
            Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

Describe 'Evidence1 live wrapper process lifecycle' {
    BeforeEach {
        $script:OpsDir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $script:OpsDir | Out-Null
    }

    It 'trusts a matching terminal record and terminates a lingering launcher tree' {
        $runId = [guid]::NewGuid().ToString('D')
        $launcher = Join-Path $script:OpsDir 'fake-launcher.ps1'
        Set-Content -LiteralPath $launcher -Encoding UTF8 -Value @'
param([string]$RunId, [string]$TerminalRecordPath)
$record = [ordered]@{
    schema = 1
    run_id = $RunId
    state = 'exited'
    ts_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    exit_code = 7
    exit_code_source = 'launcher_record'
}
[System.IO.File]::WriteAllText($TerminalRecordPath, ($record | ConvertTo-Json -Compress))
Start-Sleep -Seconds 300
'@

        $watch = [Diagnostics.Stopwatch]::StartNew()
        $process = Start-Process -FilePath powershell.exe -ArgumentList @(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', $script:WrapperPath,
            '-RunId', $runId,
            '-LauncherPath', $launcher,
            '-OpsDir', $script:OpsDir,
            '-HarnessDir', $script:OpsDir,
            '-HeartbeatSeconds', '1',
            '-StopTimeoutMilliseconds', '5000'
        ) -WindowStyle Hidden -PassThru -Wait
        $watch.Stop()

        $process.ExitCode | Should -Be 7
        $watch.Elapsed.TotalSeconds | Should -BeLessThan 15
        $terminal = Get-Content -LiteralPath (Join-Path $script:OpsDir 'STAGE-B-live.exit.json') -Raw | ConvertFrom-Json
        $terminal.run_id | Should -Be $runId
        $terminal.state | Should -Be 'terminated_after_launcher_exit'
        $terminal.exit_code_source | Should -Be 'launcher_record'
    }

    It 'ignores a stale terminal record and falls back to the launcher process exit code' {
        $runId = [guid]::NewGuid().ToString('D')
        $launcher = Join-Path $script:OpsDir 'fake-stale-launcher.ps1'
        Set-Content -LiteralPath $launcher -Encoding UTF8 -Value @'
param([string]$RunId, [string]$TerminalRecordPath)
$record = [ordered]@{
    schema = 1
    run_id = [guid]::NewGuid().ToString('D')
    state = 'exited'
    ts_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    exit_code = 0
    exit_code_source = 'launcher_record'
}
[System.IO.File]::WriteAllText($TerminalRecordPath, ($record | ConvertTo-Json -Compress))
exit 9
'@

        $process = Start-Process -FilePath powershell.exe -ArgumentList @(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', $script:WrapperPath,
            '-RunId', $runId,
            '-LauncherPath', $launcher,
            '-OpsDir', $script:OpsDir,
            '-HarnessDir', $script:OpsDir,
            '-HeartbeatSeconds', '1',
            '-StopTimeoutMilliseconds', '5000'
        ) -WindowStyle Hidden -PassThru -Wait

        $terminal = Get-Content -LiteralPath (Join-Path $script:OpsDir 'STAGE-B-live.exit.json') -Raw | ConvertFrom-Json
        $process.ExitCode | Should -Be 9 -Because "wrapper_error_type=$($terminal.wrapper_error_type), stage=$($terminal.wrapper_error_stage)"
        $terminal.run_id | Should -Be $runId
        $terminal.state | Should -Be 'exited'
        $terminal.exit_code_source | Should -Be 'process_exit_code'
    }
}

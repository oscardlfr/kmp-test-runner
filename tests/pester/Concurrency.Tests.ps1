#Requires -Modules Pester
# Tests for the v0.3.8 Tier 1 concurrency hardening:
#   - advisory lockfile at <projectRoot>\.kmp-test-runner.lock
#   - --force flag (bypass live lock)
#   - stale lock reclamation (dead PID)
#
# Runs on windows-latest CI. Windows PIDs are real kernel PIDs (PowerShell's
# automatic $PID) so process.kill(pid, 0) checks in cli.js work correctly —
# no MSYS-style PID translation gotchas.

BeforeAll {
    # A PID well outside any Windows PID range — process.kill(pid, 0)
    # reliably throws ESRCH, giving a deterministic "dead PID" without
    # forking + killing.
    $script:DeadPid = 999999999
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:CliPath = Join-Path $script:RepoRoot 'bin\kmp-test.js'

    function New-FakeGradleProject {
        param([string]$Path)
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
        Set-Content -Path (Join-Path $Path 'settings.gradle.kts') -Value 'rootProject.name = "fake"'
        # Stub gradlew.bat — exit 0 so the pre-flight gradlew check passes.
        Set-Content -Path (Join-Path $Path 'gradlew.bat') -Value "@echo off`r`nexit /b 0"
        Set-Content -Path (Join-Path $Path 'gradlew') -Value "#!/usr/bin/env bash`nexit 0"
    }

    function Write-FakeLock {
        param(
            [string]$ProjectRoot,
            [int]$LockPid,
            [string]$Subcommand = 'parallel'
        )
        $lock = [ordered]@{
            schema       = 1
            pid          = $LockPid
            start_time   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
            subcommand   = $Subcommand
            project_root = $ProjectRoot
            version      = '0.3.8'
        }
        $lockPath = Join-Path $ProjectRoot '.kmp-test-runner.lock'
        $lock | ConvertTo-Json | Set-Content -Path $lockPath -Encoding UTF8
        return $lockPath
    }
}

Describe 'Concurrency: lockfile + --force (cli.js)' {

    BeforeEach {
        $script:WorkDir = Join-Path $TestDrive ("proj-" + [guid]::NewGuid().ToString('N').Substring(0,8))
        New-FakeGradleProject -Path $script:WorkDir
        $script:LockPath = Join-Path $script:WorkDir '.kmp-test-runner.lock'
    }

    It 'live-PID lock blocks second invocation with exit 3' {
        Write-FakeLock -ProjectRoot $script:WorkDir -LockPid $PID -Subcommand 'parallel' | Out-Null

        # Run cli.js — must refuse with ENV_ERROR.
        $output = & node $script:CliPath parallel --project-root $script:WorkDir 2>&1
        $LASTEXITCODE | Should -Be 3
        ($output -join "`n") | Should -Match 'lock|already running'

        # Original lock untouched.
        $script:LockPath | Should -Exist
        $onDisk = Get-Content $script:LockPath -Raw | ConvertFrom-Json
        $onDisk.pid | Should -Be $PID
    }

    It 'live-PID lock + --force bypasses and proceeds' {
        Write-FakeLock -ProjectRoot $script:WorkDir -LockPid $PID -Subcommand 'parallel' | Out-Null

        # --force lets the second invocation proceed; we do not assert script
        # exit code (script may exit non-zero on no modules) — only that the
        # cleanup happened.
        & node $script:CliPath parallel --force --project-root $script:WorkDir 2>&1 | Out-Null
        $script:LockPath | Should -Not -Exist
    }

    It 'stale lock (dead PID) is reclaimed without --force' {
        Write-FakeLock -ProjectRoot $script:WorkDir -LockPid $script:DeadPid -Subcommand 'parallel' | Out-Null

        & node $script:CliPath parallel --project-root $script:WorkDir 2>&1 | Out-Null
        # Lockfile cleaned up after run regardless of script exit code.
        $script:LockPath | Should -Not -Exist
    }

    It '--json mode emits errors[].code = lock_held on collision' {
        Write-FakeLock -ProjectRoot $script:WorkDir -LockPid $PID -Subcommand 'parallel' | Out-Null

        $output = & node $script:CliPath parallel --json --project-root $script:WorkDir 2>&1
        $LASTEXITCODE | Should -Be 3
        $jsonLine = ($output | Where-Object { $_ -match '^\s*\{' } | Select-Object -First 1)
        $jsonLine | Should -Not -BeNullOrEmpty
        $obj = $jsonLine | ConvertFrom-Json
        $obj.exit_code | Should -Be 3
        $obj.errors[0].code | Should -Be 'lock_held'
    }

    It 'corrupt lockfile is reclaimed silently' {
        Set-Content -Path $script:LockPath -Value 'not-json{' -Encoding UTF8

        & node $script:CliPath parallel --project-root $script:WorkDir 2>&1 | Out-Null
        $script:LockPath | Should -Not -Exist
    }

    It '--dry-run does NOT acquire a lock' {
        & node $script:CliPath parallel --dry-run --project-root $script:WorkDir 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
        $script:LockPath | Should -Not -Exist
    }

    It '--dry-run does NOT block on existing live lock' {
        Write-FakeLock -ProjectRoot $script:WorkDir -LockPid $PID -Subcommand 'parallel' | Out-Null
        & node $script:CliPath parallel --dry-run --project-root $script:WorkDir 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
        $script:LockPath | Should -Exist
        $onDisk = Get-Content $script:LockPath -Raw | ConvertFrom-Json
        $onDisk.pid | Should -Be $PID
    }

    It 'doctor does NOT acquire a lock even with one present' {
        Write-FakeLock -ProjectRoot $script:WorkDir -LockPid $PID -Subcommand 'parallel' | Out-Null
        & node $script:CliPath doctor --project-root $script:WorkDir 2>&1 | Out-Null
        # Doctor exit code can be 0 or 3 depending on JDK/ADB env. Either is
        # acceptable — we only assert that we did not steal/remove the lock.
        $script:LockPath | Should -Exist
        $onDisk = Get-Content $script:LockPath -Raw | ConvertFrom-Json
        $onDisk.subcommand | Should -Be 'parallel'
    }
}

Describe 'Concurrency: run-id format' {

    It 'format is YYYYMMDD-HHMMSS-PID6 (zero-padded, exactly 22 chars)' {
        $runId = '{0}-{1:D6}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), ($PID % 1000000)
        $runId | Should -Match '^\d{8}-\d{6}-\d{6}$'
        $runId.Length | Should -Be 22
    }

    It 'PID6 is exactly 6 digits even for small PIDs' {
        $small = '{0:D6}' -f 42
        $small | Should -Be '000042'
    }
}

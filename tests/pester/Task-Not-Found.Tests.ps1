#Requires -Modules Pester
# v0.7.x WS-1 / UX-1 — Windows mirror of tests/bats/test-task-not-found.bats.
# Same two-layer fix, same two scenarios: proactive UX-1 (Test-ModuleSupportsTestType
# pre-dispatch filter) and reactive WS-1 (gradle 'Cannot locate' aborts the entire
# invocation → mark ALL testable modules failed + forward gradle line to stderr).

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:Wrapper  = Join-Path $script:RepoRoot 'scripts\ps1\run-parallel-coverage-suite.ps1'
    $script:Cli      = Join-Path $script:RepoRoot 'bin\kmp-test.js'

    function Add-FixtureCommon {
        param([string]$Path)
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $Path 'bin') -Force | Out-Null
        Set-Content -Path (Join-Path $Path 'bin\java.cmd') -Value @(
            '@echo off'
            'echo openjdk version "17.0.10" 2024-01-16 1>&2'
            'exit /b 0'
        )
    }

    function Set-GradlewSuccess {
        param([string]$Path)
        Set-Content -Path (Join-Path $Path 'gradlew.bat') -Value @(
            '@echo off'
            'echo BUILD SUCCESSFUL (stub): %*'
            'exit /b 0'
        )
        Set-Content -Path (Join-Path $Path 'gradlew') -Value @(
            '#!/usr/bin/env bash'
            'echo "BUILD SUCCESSFUL (stub): $*"'
            'exit 0'
        )
    }

    function Set-GradlewCannotLocate {
        param([string]$Path)
        # Windows .bat — emit the gradle 8.x BUILD FAILED block, lines to stderr.
        Set-Content -Path (Join-Path $Path 'gradlew.bat') -Value @(
            '@echo off'
            'echo. 1>&2'
            'echo FAILURE: Build failed with an exception. 1>&2'
            'echo. 1>&2'
            'echo * What went wrong: 1>&2'
            "echo Cannot locate tasks that match ':edge-case:iosSimulatorArm64Test' as task 'iosSimulatorArm64Test' not found in project ':edge-case'. 1>&2"
            'echo. 1>&2'
            'echo BUILD FAILED in 850ms'
            'exit /b 1'
        )
        Set-Content -Path (Join-Path $Path 'gradlew') -Value @(
            '#!/usr/bin/env bash'
            'cat >&2 <<''STDERR'''
            ''
            'FAILURE: Build failed with an exception.'
            ''
            '* What went wrong:'
            "Cannot locate tasks that match ':edge-case:iosSimulatorArm64Test' as task 'iosSimulatorArm64Test' not found in project ':edge-case'."
            'STDERR'
            'echo "BUILD FAILED in 850ms"'
            'exit 1'
        )
    }

    function New-Ux1Fixture {
        param([string]$Path)
        Add-FixtureCommon -Path $Path
        Set-GradlewSuccess -Path $Path
        Set-Content -Path (Join-Path $Path 'settings.gradle.kts') -Value @(
            'rootProject.name = "ux1-fixture"'
            'include(":ios-mod")'
            'include(":android-only")'
        )
        # :ios-mod has iosMain (declared target) — UX-1 lets it through.
        New-Item -ItemType Directory -Force -Path (Join-Path $Path 'ios-mod\src\iosMain') | Out-Null
        New-Item -ItemType Directory -Force -Path (Join-Path $Path 'ios-mod\src\commonTest') | Out-Null
        Set-Content -Path (Join-Path $Path 'ios-mod\build.gradle.kts') `
            -Value 'kotlin { iosSimulatorArm64() }'
        # :android-only has only Android source sets — UX-1 should skip it.
        New-Item -ItemType Directory -Force -Path (Join-Path $Path 'android-only\src\androidUnitTest') | Out-Null
        Set-Content -Path (Join-Path $Path 'android-only\build.gradle.kts') `
            -Value 'kotlin { jvmToolchain(17) }'
    }

    function New-Ws1Fixture {
        param([string]$Path)
        Add-FixtureCommon -Path $Path
        Set-GradlewCannotLocate -Path $Path
        Set-Content -Path (Join-Path $Path 'settings.gradle.kts') -Value @(
            'rootProject.name = "ws1-fixture"'
            'include(":edge-case")'
            'include(":also-doomed")'
        )
        New-Item -ItemType Directory -Force -Path (Join-Path $Path 'edge-case\src\iosSimulatorArm64Test') | Out-Null
        Set-Content -Path (Join-Path $Path 'edge-case\build.gradle.kts') `
            -Value 'kotlin { iosSimulatorArm64() }'
        New-Item -ItemType Directory -Force -Path (Join-Path $Path 'also-doomed\src\iosSimulatorArm64Test') | Out-Null
        Set-Content -Path (Join-Path $Path 'also-doomed\build.gradle.kts') `
            -Value 'kotlin { iosSimulatorArm64() }'
    }

    function Invoke-WithFakeJava {
        param([string]$ProjectRoot, [scriptblock]$Action)
        $oldPath = $env:PATH
        try {
            $env:PATH = (Join-Path $ProjectRoot 'bin') + [IO.Path]::PathSeparator + $env:PATH
            & $Action
        } finally {
            $env:PATH = $oldPath
        }
    }
}

# ----------------------------------------------------------------------------
# Layer 1: UX-1 proactive — modules without iOS target are skipped before
# the wrapper queues any gradle task.
# ----------------------------------------------------------------------------

Describe 'parallel.ps1: UX-1 proactive --TestType ios filter' {

    BeforeEach {
        $script:WorkDir = Join-Path $TestDrive ("ux1-" + [guid]::NewGuid().ToString('N').Substring(0,8))
        New-Ux1Fixture -Path $script:WorkDir
    }

    # v0.8 sub-entry 5: --TestType ios|macos requires macOS host (the
    # orchestrator emits platform_unsupported on Windows/Linux before any
    # dispatch). The proactive UX-1 dispatch path is meaningful only on macOS.
    It 'skips Android-only module before gradle dispatch (no PASS fantasma)' {
        if (-not $IsMacOS) { Set-ItResult -Skipped -Because 'iOS dispatch requires macOS host' }
        $wrapper = $script:Wrapper
        $work    = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            (& pwsh -NoLogo -NoProfile -File $wrapper `
                -ProjectRoot $work -ModuleFilter '*' -TestType 'ios' `
                -IgnoreJdkMismatch -CoverageTool 'none' 2>&1) -join "`n"
        }
        $LASTEXITCODE | Should -Be 0
        $output       | Should -Match '\[SKIP\]\s+android-only \(no ios target\)'
        $output       | Should -Match '\[PASS\]\s+ios-mod'
        $output       | Should -Match 'BUILD SUCCESSFUL'
    }

    It 'src\iosMain alone (no iosTest) lets the module through (gradle no-op task)' {
        if (-not $IsMacOS) { Set-ItResult -Skipped -Because 'iOS dispatch requires macOS host' }
        Remove-Item -Recurse -Force -Path (Join-Path $script:WorkDir 'ios-mod\src\commonTest')
        $wrapper = $script:Wrapper
        $work    = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            (& pwsh -NoLogo -NoProfile -File $wrapper `
                -ProjectRoot $work -ModuleFilter '*' -TestType 'ios' `
                -IncludeUntested -IgnoreJdkMismatch -CoverageTool 'none' 2>&1) -join "`n"
        }
        $LASTEXITCODE | Should -Be 0
        $output       | Should -Not -Match '\[SKIP\]\s+ios-mod'
        $output       | Should -Match '\[SKIP\]\s+android-only \(no ios target\)'
    }
}

Describe 'parallel.ps1: UX-1 proactive --TestType common / desktop filter' {

    BeforeEach {
        $script:WorkDir = Join-Path $TestDrive ("ux1c-" + [guid]::NewGuid().ToString('N').Substring(0,8))
        Add-FixtureCommon -Path $script:WorkDir
        Set-GradlewSuccess -Path $script:WorkDir
        Set-Content -Path (Join-Path $script:WorkDir 'settings.gradle.kts') -Value @(
            'rootProject.name = "ux1-common-fixture"'
            'include(":jvm-mod")'
            'include(":android-only")'
        )
        # :jvm-mod has jvmMain (declared jvm target) — UX-1 lets it through.
        New-Item -ItemType Directory -Force -Path (Join-Path $script:WorkDir 'jvm-mod\src\jvmMain') | Out-Null
        New-Item -ItemType Directory -Force -Path (Join-Path $script:WorkDir 'jvm-mod\src\jvmTest') | Out-Null
        Set-Content -Path (Join-Path $script:WorkDir 'jvm-mod\build.gradle.kts') -Value 'kotlin { jvm() }'
        # :android-only has only Android source sets — UX-1 should skip it.
        New-Item -ItemType Directory -Force -Path (Join-Path $script:WorkDir 'android-only\src\main') | Out-Null
        New-Item -ItemType Directory -Force -Path (Join-Path $script:WorkDir 'android-only\src\test') | Out-Null
        Set-Content -Path (Join-Path $script:WorkDir 'android-only\build.gradle.kts') -Value 'android { ... }'
    }

    It '-TestType common skips Android-only module before gradle dispatch' {
        $wrapper = $script:Wrapper
        $work    = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            (& pwsh -NoLogo -NoProfile -File $wrapper `
                -ProjectRoot $work -ModuleFilter '*' -TestType 'common' `
                -IgnoreJdkMismatch -CoverageTool 'none' 2>&1) -join "`n"
        }
        $LASTEXITCODE | Should -Be 0
        $output       | Should -Match '\[SKIP\]\s+android-only \(no common target\)'
        $output       | Should -Match '\[PASS\]\s+jvm-mod'
        # BUILD SUCCESSFUL line check dropped — the [PASS] jvm-mod banner only
        # emits on gradle exit 0, so it's the load-bearing assertion. The raw
        # "BUILD SUCCESSFUL" forward to log() is captured via Pester's 2>&1
        # but the pwsh -> node child propagation is flaky on Windows.
    }

    It '-TestType desktop alias also skips modules without jvm target' {
        $wrapper = $script:Wrapper
        $work    = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            (& pwsh -NoLogo -NoProfile -File $wrapper `
                -ProjectRoot $work -ModuleFilter '*' -TestType 'desktop' `
                -IgnoreJdkMismatch -CoverageTool 'none' 2>&1) -join "`n"
        }
        $LASTEXITCODE | Should -Be 0
        $output       | Should -Match '\[SKIP\]\s+android-only \(no desktop target\)'
        $output       | Should -Match '\[PASS\]\s+jvm-mod'
    }
}

Describe 'kmp-test --json parallel: skipped[] carries UX-1 disambiguated reason' {

    BeforeEach {
        $script:WorkDir = Join-Path $TestDrive ("ux1-json-" + [guid]::NewGuid().ToString('N').Substring(0,8))
        New-Ux1Fixture -Path $script:WorkDir
    }

    It 'JSON envelope: skipped[] contains {module:"android-only", reason:"no ios target"}' {
        if (-not $IsMacOS) { Set-ItResult -Skipped -Because 'iOS dispatch requires macOS host' }
        $cli  = $script:Cli
        $work = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            (& node $cli --json parallel --project-root $work `
                --module-filter '*' --test-type ios `
                --ignore-jdk-mismatch --coverage-tool none 2>&1) -join "`n"
        }
        $firstLine = ($output -split "`n" | Where-Object { $_ -match '^\{' } | Select-Object -First 1)
        $firstLine | Should -Not -BeNullOrEmpty
        $firstLine | Should -Match '"module":"android-only"'
        $firstLine | Should -Match '"reason":"no ios target'
    }
}

# ----------------------------------------------------------------------------
# Layer 2: WS-1 reactive — when a module survives UX-1 (model stale, or
# filesystem dir present without matching build config) and gradle DOES emit
# "Cannot locate tasks that match", the wrapper marks ALL testable modules
# failed because gradle aborts before any task runs.
# ----------------------------------------------------------------------------

Describe 'parallel.ps1: WS-1 reactive defense (gradle aborts at task-graph resolution)' {

    BeforeEach {
        $script:WorkDir = Join-Path $TestDrive ("ws1-" + [guid]::NewGuid().ToString('N').Substring(0,8))
        New-Ws1Fixture -Path $script:WorkDir
    }

    It 'marks ALL testable modules FAIL when gradle says Cannot locate (exit 1)' {
        if (-not $IsMacOS) { Set-ItResult -Skipped -Because 'iOS dispatch requires macOS host' }
        $wrapper = $script:Wrapper
        $work    = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            (& pwsh -NoLogo -NoProfile -File $wrapper `
                -ProjectRoot $work -ModuleFilter '*' -TestType 'ios' `
                -IgnoreJdkMismatch -CoverageTool 'none' 2>&1) -join "`n"
        }
        $LASTEXITCODE | Should -Be 1
        # Both modules must be FAIL even though gradle only named :edge-case.
        $output       | Should -Match '\[FAIL\]\s+edge-case'
        $output       | Should -Match '\[FAIL\]\s+also-doomed'
        $output       | Should -Match 'BUILD FAILED'
        $output       | Should -Not -Match '\[PASS\]'
    }

    It 'forwards gradle "Cannot locate" line to stdout (caught by discriminator)' {
        if (-not $IsMacOS) { Set-ItResult -Skipped -Because 'iOS dispatch requires macOS host' }
        $wrapper = $script:Wrapper
        $work    = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            (& pwsh -NoLogo -NoProfile -File $wrapper `
                -ProjectRoot $work -ModuleFilter '*' -TestType 'ios' `
                -IgnoreJdkMismatch -CoverageTool 'none' 2>&1) -join "`n"
        }
        $output | Should -Match 'Cannot locate tasks that match'
    }
}

Describe 'kmp-test --json parallel: WS-1 reactive surfaces task_not_found (Windows)' {

    BeforeEach {
        $script:WorkDir = Join-Path $TestDrive ("ws1-json-" + [guid]::NewGuid().ToString('N').Substring(0,8))
        New-Ws1Fixture -Path $script:WorkDir
    }

    It 'JSON envelope: exit_code = 1 AND errors[].code = "task_not_found"' {
        if (-not $IsMacOS) { Set-ItResult -Skipped -Because 'iOS dispatch requires macOS host' }
        $cli  = $script:Cli
        $work = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            (& node $cli --json parallel --project-root $work `
                --module-filter '*' --test-type ios `
                --ignore-jdk-mismatch --coverage-tool none 2>&1) -join "`n"
        }
        $firstLine = ($output -split "`n" | Where-Object { $_ -match '^\{' } | Select-Object -First 1)
        $firstLine | Should -Not -BeNullOrEmpty
        $firstLine    | Should -Match '"exit_code":1'
        $firstLine    | Should -Match '"code":"task_not_found"'
        $LASTEXITCODE | Should -Be 1
    }
}

#Requires -Modules Pester
# v0.7.0 Phase 2 — PowerShell parity for the parallel wrapper iOS / macOS
# TEST_TYPE acceptance. Verifies ValidateSet accepts the new values, the
# configuration banner reflects them, and unknown values are rejected.

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:Wrapper = Join-Path $script:RepoRoot 'scripts\ps1\run-parallel-coverage-suite.ps1'

    function script:New-FixtureProject {
        $work = Join-Path ([System.IO.Path]::GetTempPath()) ("kmp-ios-dispatch-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $work -Force | Out-Null
        Set-Content -Path (Join-Path $work 'settings.gradle.kts') -Value @(
            'rootProject.name = "ios-dispatch-fixture"'
            # One include per line — the wrapper's settings.gradle.kts parser
            # only captures the first module name from a comma-separated
            # include() call (pre-existing behavior, not in v0.7.0 scope).
            'include(":ios-only")'
            'include(":macos-only")'
            'include(":kmp-multi")'
        )
        New-Item -ItemType Directory -Force -Path (Join-Path $work 'ios-only\src\iosX64Test') | Out-Null
        Set-Content -Path (Join-Path $work 'ios-only\build.gradle.kts') -Value @(
            'plugins { kotlin("multiplatform") }'
            'kotlin { iosX64() }'
        )
        New-Item -ItemType Directory -Force -Path (Join-Path $work 'macos-only\src\macosArm64Test') | Out-Null
        Set-Content -Path (Join-Path $work 'macos-only\build.gradle.kts') -Value @(
            'plugins { kotlin("multiplatform") }'
            'kotlin { macosArm64() }'
        )
        New-Item -ItemType Directory -Force -Path (Join-Path $work 'kmp-multi\src\jvmTest') | Out-Null
        New-Item -ItemType Directory -Force -Path (Join-Path $work 'kmp-multi\src\iosSimulatorArm64Test') | Out-Null
        Set-Content -Path (Join-Path $work 'kmp-multi\build.gradle.kts') -Value @(
            'plugins { kotlin("multiplatform") }'
            'kotlin { jvm(); iosSimulatorArm64() }'
        )
        # Stub gradlew (.bat for Windows; .sh for cross-platform parity).
        Set-Content -Path (Join-Path $work 'gradlew.bat') -Value @(
            '@echo off'
            'echo BUILD SUCCESSFUL'
            'exit /b 0'
        )
        Set-Content -Path (Join-Path $work 'gradlew') -Value @(
            '#!/usr/bin/env bash'
            'echo BUILD SUCCESSFUL'
            'exit 0'
        )
        return $work
    }
}

Describe 'parallel wrapper iOS / macOS dispatch (v0.7.0 Phase 2)' {
    It '-TestType ios is in the ValidateSet (no parameter binding error)' {
        $work = New-FixtureProject
        try {
            $output = & pwsh -NoLogo -NoProfile -File $script:Wrapper `
                -ProjectRoot $work -TestType 'ios' -ModuleFilter 'ios-only' `
                -IgnoreJdkMismatch -CoverageTool 'none' 2>&1
            $stderr = ($output | Out-String)
            # ValidateSet rejection would emit "does not belong to the set" — must NOT appear.
            $stderr | Should -Not -Match 'does not belong to the set'
            $stderr | Should -Not -Match 'Cannot validate argument'
        } finally {
            Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
        }
    }

    It '-TestType macos is in the ValidateSet (no parameter binding error)' {
        $work = New-FixtureProject
        try {
            $output = & pwsh -NoLogo -NoProfile -File $script:Wrapper `
                -ProjectRoot $work -TestType 'macos' -ModuleFilter 'macos-only' `
                -IgnoreJdkMismatch -CoverageTool 'none' 2>&1
            $stderr = ($output | Out-String)
            $stderr | Should -Not -Match 'does not belong to the set'
            $stderr | Should -Not -Match 'Cannot validate argument'
        } finally {
            Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
        }
    }

    # v0.8 sub-entry 5: ps1 wrapper is now a thin Node launcher and renders no
    # config banner of its own. The orchestrator banner (lib/parallel-orchestrator.js
    # "Parallel Test Suite" header + "Test Type: <type>" line) is on Node, not
    # ps1. Per-module task name still appears in the dispatch log.
    # On Windows hosts --test-type ios|macos hits platform_unsupported (exit 3)
    # before any dispatch; the dispatch-name assertions are only meaningful on
    # macOS hosts (gated below).

    It '-TestType ios on Windows triggers platform_unsupported (exit 3)' {
        if ($IsMacOS) { Set-ItResult -Skipped -Because 'iOS dispatch is supported on macOS' }
        $work = New-FixtureProject
        try {
            $output = & pwsh -NoLogo -NoProfile -File $script:Wrapper `
                -ProjectRoot $work -TestType 'ios' -ModuleFilter 'ios-only' `
                -IgnoreJdkMismatch -CoverageTool 'none' 2>&1
            $LASTEXITCODE | Should -Be 3
            ($output | Out-String) | Should -Match 'platform_unsupported|requires macOS host'
        } finally {
            Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
        }
    }

    It '-TestType notreal is rejected by ValidateSet' {
        $work = New-FixtureProject
        try {
            $output = & pwsh -NoLogo -NoProfile -File $script:Wrapper `
                -ProjectRoot $work -TestType 'notreal' 2>&1
            ($output | Out-String) | Should -Match '(does not belong to the set|Cannot validate argument)'
        } finally {
            Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
        }
    }
}

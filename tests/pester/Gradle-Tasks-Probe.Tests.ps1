#Requires -Modules Pester
# Tests for scripts/ps1/lib/Gradle-Tasks-Probe.ps1 — content-keyed task-set
# probe used by Bug B'' (coverage skip), Bug B' (android task selection),
# and the eventual Phase 4 ProjectModel refactor.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:ProbeLib   = Join-Path $script:RepoRoot 'scripts\ps1\lib\Gradle-Tasks-Probe.ps1'

    . $script:ProbeLib

    # Fixture builder: creates a temp project root with a stub gradlew.bat
    # that emits a canned `tasks --all --quiet` task list.
    function script:New-ProbeFixture {
        param(
            # Format mirrors REAL `gradlew tasks --all --quiet` output:
            # `module:task - description` (NO leading colon at column 0). An
            # earlier fixture used `:core-foo:test` with a synthetic leading
            # colon, which paired with a probe regex that never matched real
            # gradle output — see the cache-format fix in this PR.
            [string[]]$Tasks = @(
                'core-foo:test - Runs the unit tests.',
                'core-foo:jacocoTestReport - Generates code coverage report for the test task.',
                'core-bar:test - Runs the unit tests.',
                'core-bar:connectedAndroidTest - Installs and runs instrumentation tests on connected devices.',
                'core-bar:androidConnectedCheck - Runs all device checks on currently connected devices.',
                'legacy-only:connectedDebugAndroidTest - Installs and runs the tests for debug on connected devices.'
            )
        )
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("probe-fixture-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Set-Content -Path (Join-Path $dir 'settings.gradle.kts') -Value 'rootProject.name = "probe-test"'

        $taskOutput = $Tasks -join "`n"
        $stub = @"
@echo off
echo $taskOutput
exit /b 0
"@
        # Multi-line literal echo isn't possible in batch — write task lines as Set-Content,
        # then build a stub that cats it.
        $taskFile = Join-Path $dir 'tasks-output.txt'
        Set-Content -Path $taskFile -Value $taskOutput -Encoding ASCII
        $stubBat = @"
@echo off
type "$taskFile"
exit /b 0
"@
        Set-Content -Path (Join-Path $dir 'gradlew.bat') -Value $stubBat -Encoding ASCII
        return $dir
    }
}

Describe 'Gradle-Tasks-Probe.ps1: function exposure' {

    It 'all expected functions are defined' {
        Get-Command Invoke-GradleTasksProbe   -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
        Get-Command Test-ModuleHasTask        -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
        Get-Command Get-ModuleFirstExistingTask -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
        Get-Command Clear-GradleTasksCache    -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
    }
}

Describe 'Invoke-GradleTasksProbe: cache behavior' {

    It 'cold run populates cache; warm run reuses it' {
        $dir = New-ProbeFixture
        try {
            $cache1 = Invoke-GradleTasksProbe -ProjectRoot $dir
            $cache1 | Should -Not -BeNullOrEmpty
            (Test-Path $cache1) | Should -BeTrue
            $cache2 = Invoke-GradleTasksProbe -ProjectRoot $dir
            $cache2 | Should -Be $cache1
        } finally {
            Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        }
    }

    It 'cache invalidates when settings.gradle.kts content changes' {
        $dir = New-ProbeFixture
        try {
            $cache1 = Invoke-GradleTasksProbe -ProjectRoot $dir
            Add-Content -Path (Join-Path $dir 'settings.gradle.kts') -Value 'include(":new")'
            $cache2 = Invoke-GradleTasksProbe -ProjectRoot $dir
            $cache2 | Should -Not -Be $cache1
        } finally {
            Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        }
    }

    It 'returns $null when gradlew is missing' {
        $emptyDir = Join-Path ([System.IO.Path]::GetTempPath()) ("empty-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
        New-Item -ItemType Directory -Path $emptyDir -Force | Out-Null
        try {
            $r = Invoke-GradleTasksProbe -ProjectRoot $emptyDir
            $r | Should -BeNullOrEmpty
        } finally {
            Remove-Item -Recurse -Force $emptyDir -ErrorAction SilentlyContinue
        }
    }
}

Describe 'Test-ModuleHasTask: tristate result ($true / $false / $null)' {

    It 'returns $true when task confirmed present in cache' {
        $dir = New-ProbeFixture
        try {
            (Test-ModuleHasTask -ProjectRoot $dir -Module 'core-foo' -Task 'jacocoTestReport') | Should -Be $true
        } finally {
            Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        }
    }

    It 'returns $false when cache present but task absent (Bug B'' skip case)' {
        $dir = New-ProbeFixture
        try {
            (Test-ModuleHasTask -ProjectRoot $dir -Module 'core-foo' -Task 'doesNotExist') | Should -Be $false
        } finally {
            Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        }
    }

    It 'returns $null when probe unavailable (legacy fallback signal)' {
        $emptyDir = Join-Path ([System.IO.Path]::GetTempPath()) ("empty-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
        New-Item -ItemType Directory -Path $emptyDir -Force | Out-Null
        try {
            $r = Test-ModuleHasTask -ProjectRoot $emptyDir -Module 'x' -Task 'x'
            $r | Should -BeNullOrEmpty
        } finally {
            Remove-Item -Recurse -Force $emptyDir -ErrorAction SilentlyContinue
        }
    }
}

Describe 'Get-ModuleFirstExistingTask: candidate priority' {

    It 'picks earliest matching candidate (Bug B'' / Bug B'' priority list)' {
        $dir = New-ProbeFixture
        try {
            $r = Get-ModuleFirstExistingTask -ProjectRoot $dir -Module 'core-bar' `
                -Candidates @('connectedDebugAndroidTest', 'connectedAndroidTest', 'androidConnectedCheck')
            $r.Status | Should -Be 'found'
            $r.Task   | Should -Be 'connectedAndroidTest'
        } finally {
            Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        }
    }

    It "picks androidConnectedCheck for KMP-DSL-only module (Bug B' real-world repro)" {
        $dir = New-ProbeFixture
        try {
            $r = Get-ModuleFirstExistingTask -ProjectRoot $dir -Module 'core-bar' `
                -Candidates @('connectedDebugAndroidTest', 'androidConnectedCheck')
            $r.Status | Should -Be 'found'
            $r.Task   | Should -Be 'androidConnectedCheck'
        } finally {
            Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        }
    }

    It 'returns Status no_match when probe healthy but no candidate present' {
        $dir = New-ProbeFixture
        try {
            $r = Get-ModuleFirstExistingTask -ProjectRoot $dir -Module 'core-foo' `
                -Candidates @('neverHeardOfThis', 'norThis')
            $r.Status | Should -Be 'no_match'
            $r.Task   | Should -BeNullOrEmpty
        } finally {
            Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        }
    }

    It 'returns Status probe_unavailable when probe cannot run' {
        $emptyDir = Join-Path ([System.IO.Path]::GetTempPath()) ("empty-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
        New-Item -ItemType Directory -Path $emptyDir -Force | Out-Null
        try {
            $r = Get-ModuleFirstExistingTask -ProjectRoot $emptyDir -Module 'x' -Candidates @('anything')
            $r.Status | Should -Be 'probe_unavailable'
            $r.Task   | Should -BeNullOrEmpty
        } finally {
            Remove-Item -Recurse -Force $emptyDir -ErrorAction SilentlyContinue
        }
    }
}

Describe 'Cache format regression — module:task without leading colon' {

    It 'Test-ModuleHasTask returns $true for androidConnectedCheck (KMP umbrella)' {
        # Bug observed against shared-kmp-libs: probe rc=$false even though
        # `core-bar:androidConnectedCheck` was in the cache. Cause: needle
        # was `:core-bar:androidConnectedCheck` but cache emitted no leading
        # colon. Fixed by aligning the needle to real gradle output format.
        $dir = New-ProbeFixture
        try {
            Test-ModuleHasTask -ProjectRoot $dir -Module 'core-bar' -Task 'androidConnectedCheck' | Should -BeTrue
        } finally {
            Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        }
    }

    It 'Test-ModuleHasTask: caller-supplied leading colon is stripped' {
        # Some callers in the codebase pass `:module` (gradle invocation
        # syntax). Verify both `:module` and bare `module` work.
        $dir = New-ProbeFixture
        try {
            Test-ModuleHasTask -ProjectRoot $dir -Module ':core-foo' -Task 'jacocoTestReport' | Should -BeTrue
            Test-ModuleHasTask -ProjectRoot $dir -Module 'core-foo' -Task 'jacocoTestReport' | Should -BeTrue
        } finally {
            Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        }
    }

    It 'Get-ModuleFirstExistingTask: picks androidConnectedCheck on KMP-only modules' {
        # Real-world repro: a fresh KMP module with `androidLibrary { }` DSL
        # only exposes `androidConnectedCheck`. Probe must walk the candidate
        # list and pick that umbrella task.
        $kmpFixture = New-ProbeFixture -Tasks @(
            'kmp-only:androidConnectedCheck - Runs all device checks on currently connected devices.'
        )
        try {
            $r = Get-ModuleFirstExistingTask -ProjectRoot $kmpFixture -Module 'kmp-only' `
                -Candidates @('connectedDebugAndroidTest', 'connectedAndroidTest', 'androidConnectedCheck')
            $r.Status | Should -Be 'found'
            $r.Task   | Should -Be 'androidConnectedCheck'
        } finally {
            Remove-Item -Recurse -Force $kmpFixture -ErrorAction SilentlyContinue
        }
    }
}

# Pipeline-collapse tests for run-android-tests.ps1 deleted in v0.8 sub-entry 3.
# The bash counter-loop in the wrapper no longer exists — orchestrator lives in
# lib/android-orchestrator.js (Node) and counts via JS arrays. The collapse bug
# class is structurally impossible in JS.

Describe 'Clear-GradleTasksCache: cleans up tasks-*.txt files' {

    It 'removes all cache files under .kmp-test-runner-cache' {
        $dir = New-ProbeFixture
        try {
            Invoke-GradleTasksProbe -ProjectRoot $dir | Out-Null
            $cacheDir = Join-Path $dir '.kmp-test-runner-cache'
            (Get-ChildItem $cacheDir -Filter 'tasks-*.txt').Count | Should -BeGreaterThan 0
            Clear-GradleTasksCache -ProjectRoot $dir
            (Get-ChildItem $cacheDir -Filter 'tasks-*.txt' -ErrorAction SilentlyContinue).Count | Should -Be 0
        } finally {
            Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        }
    }
}

Describe 'parallel.ps1 (Bug B'') and run-android-tests.ps1 (Bug B'') wiring' {

    It "parallel.ps1 sources Gradle-Tasks-Probe.ps1" {
        $parallel = Join-Path $script:RepoRoot 'scripts\ps1\run-parallel-coverage-suite.ps1'
        (Get-Content $parallel -Raw) | Should -Match 'Gradle-Tasks-Probe\.ps1'
    }

    # v0.8 sub-entry 4: the per-module Test-ModuleHasTask probe + [SKIP coverage]
    # banner lived only in the coverage-task selection block, which was lifted
    # into lib/coverage-orchestrator.js. The parallel codepath retains the
    # tasks-probe library for non-coverage probing; the coverage-specific
    # contracts moved to tests/vitest/coverage-orchestrator.test.js.
    It "parallel.ps1 retains the tasks-probe sourcing for non-coverage probing" {
        $parallel = Join-Path $script:RepoRoot 'scripts\ps1\run-parallel-coverage-suite.ps1'
        (Get-Content $parallel -Raw) | Should -Match 'Gradle-Tasks-Probe\.ps1'
    }

    # run-android-tests.ps1 wiring tests deleted in v0.8 sub-entry 3 — the
    # ps1 wrapper is now thin (`& node lib\runner.js android @args`) and no
    # longer sources Gradle-Tasks-Probe.ps1 / declares -DeviceTask / calls
    # Get-ModuleFirstExistingTask. Equivalent contracts are now exercised
    # in tests/vitest/android-orchestrator.test.js via the Node orchestrator.
}

Describe 'parallel.ps1 (Bug E): no-coverage-data banner + machine marker' {

    BeforeAll {
        $script:Parallel = Join-Path $script:RepoRoot 'scripts\ps1\run-parallel-coverage-suite.ps1'
        $script:ParallelText = Get-Content $script:Parallel -Raw
    }

    It 'computes $modulesContributing from moduleSummaries.Total > 0' {
        $script:ParallelText | Should -Match '\$modulesContributing\s*='
        $script:ParallelText | Should -Match '\$_\.Total\s+-gt\s+0'
    }

    It 'gates the [OK] banner on $modulesContributing -gt 0' {
        $script:ParallelText | Should -Match 'if\s*\(\s*\$modulesContributing\s+-gt\s+0\s*\)'
    }

    It 'emits [!] No coverage data ... when $modulesContributing -eq 0' {
        $script:ParallelText | Should -Match '\[!\] No coverage data collected from any module'
        $script:ParallelText | Should -Match 'kmp-test-runner#coverage-setup'
    }

    It 'emits machine-readable COVERAGE_MODULES_CONTRIBUTING marker' {
        $script:ParallelText | Should -Match 'COVERAGE_MODULES_CONTRIBUTING:'
    }
}

# ----------------------------------------------------------------------------
# v0.5.2 Gap C — cross-platform cache-key SHA byte parity
# ----------------------------------------------------------------------------
# These fixtures + expected SHAs are the canonical reference for ALL three
# walkers (JS lib/project-model.js#computeCacheKey, bash
# scripts/sh/lib/gradle-tasks-probe.sh:_kmp_compute_cache_key, and this
# file's Get-KmpCacheKey). Sibling vitest + bats tests assert the same hex
# strings - any divergence breaks one of the three suites.
# ----------------------------------------------------------------------------

Describe 'Get-KmpCacheKey: cross-platform parity (Gap C)' {
    # Strategy: all three walkers (JS / bash / PS1) normalize content by
    # stripping ALL `\r` then trailing `\n+` before hashing, so files with
    # identical logical content but different line endings (CRLF vs LF)
    # hash to the SAME SHA on every platform. Fixtures + expected SHAs
    # mirrored in tests/vitest/project-model.test.js and
    # tests/bats/test-gradle-tasks-probe.bats.

    BeforeEach {
        $script:WorkDir = Join-Path $TestDrive ("ck-parity-" + [guid]::NewGuid().ToString('N').Substring(0,8))
        New-Item -ItemType Directory -Path $script:WorkDir -Force | Out-Null
        # gradlew stub so any consumer of the probe doesn't bail early on missing wrapper.
        New-Item -ItemType File -Path (Join-Path $script:WorkDir 'gradlew') -Force | Out-Null
    }

    It 'LF fixture produces canonical SHA 0939412...' {
        # Use [IO.File]::WriteAllText to control bytes exactly (Set-Content
        # would re-encode and may add a BOM/CRLF).
        [IO.File]::WriteAllText((Join-Path $script:WorkDir 'settings.gradle.kts'), "rootProject.name = `"x`"`nplugins { kotlin(`"jvm`") }`n")
        [IO.File]::WriteAllText((Join-Path $script:WorkDir 'build.gradle.kts'), "plugins { kotlin(`"jvm`") }`n")
        $sha = Get-KmpCacheKey -ProjectRoot $script:WorkDir
        $sha | Should -Be '0939412f62e3d3480919e52e477d01063d948cdd'
    }

    It 'CRLF fixture produces SAME canonical SHA (cross-platform parity)' {
        [IO.File]::WriteAllText((Join-Path $script:WorkDir 'settings.gradle.kts'), "rootProject.name = `"x`"`r`nplugins { kotlin(`"jvm`") }`r`n")
        [IO.File]::WriteAllText((Join-Path $script:WorkDir 'build.gradle.kts'), "plugins { kotlin(`"jvm`") }`r`n")
        # Same logical content as LF case but with \r\n line endings -- must
        # hash identically. Pre-fix Get-Content -Raw preserved \r and PS1
        # diverged from bash on Linux; post-fix `-replace '\r', ''` then
        # `-replace '\n+$', ''` aligns with bash `tr -d '\r'` + subshell.
        $sha = Get-KmpCacheKey -ProjectRoot $script:WorkDir
        $sha | Should -Be '0939412f62e3d3480919e52e477d01063d948cdd'
    }

    It 'mixed CRLF + LF fixture produces SAME canonical SHA' {
        [IO.File]::WriteAllText((Join-Path $script:WorkDir 'settings.gradle.kts'), "rootProject.name = `"x`"`r`nplugins { kotlin(`"jvm`") }`r`n")
        [IO.File]::WriteAllText((Join-Path $script:WorkDir 'build.gradle.kts'), "plugins { kotlin(`"jvm`") }`n")
        $sha = Get-KmpCacheKey -ProjectRoot $script:WorkDir
        $sha | Should -Be '0939412f62e3d3480919e52e477d01063d948cdd'
    }

    It 'multiple trailing newlines fold to same SHA' {
        $other = Join-Path $TestDrive ("ck-parity-multi-" + [guid]::NewGuid().ToString('N').Substring(0,8))
        New-Item -ItemType Directory -Path $other -Force | Out-Null
        New-Item -ItemType File -Path (Join-Path $other 'gradlew') -Force | Out-Null

        [IO.File]::WriteAllText((Join-Path $script:WorkDir 'settings.gradle.kts'), "rootProject.name = `"x`"`nplugins { kotlin(`"jvm`") }`n")
        [IO.File]::WriteAllText((Join-Path $script:WorkDir 'build.gradle.kts'), "plugins { kotlin(`"jvm`") }`n")
        [IO.File]::WriteAllText((Join-Path $other 'settings.gradle.kts'), "rootProject.name = `"x`"`nplugins { kotlin(`"jvm`") }`n`n`n")
        [IO.File]::WriteAllText((Join-Path $other 'build.gradle.kts'), "plugins { kotlin(`"jvm`") }`n`n")

        $shaA = Get-KmpCacheKey -ProjectRoot $script:WorkDir
        $shaB = Get-KmpCacheKey -ProjectRoot $other
        $shaA | Should -Be $shaB
    }

    It 'bare trailing CR is stripped (matches `tr -d \r` semantics)' {
        [IO.File]::WriteAllText((Join-Path $script:WorkDir 'settings.gradle.kts'), "rootProject.name = `"x`"`r")
        $withCR = Get-KmpCacheKey -ProjectRoot $script:WorkDir
        [IO.File]::WriteAllText((Join-Path $script:WorkDir 'settings.gradle.kts'), "rootProject.name = `"x`"")
        $withoutCR = Get-KmpCacheKey -ProjectRoot $script:WorkDir
        $withCR | Should -Be $withoutCR
    }
}

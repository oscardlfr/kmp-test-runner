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

Describe 'run-android-tests.ps1 — single-item pipeline collapse (summary.json counts)' {

    BeforeAll {
        $script:RunAndroid = Join-Path $script:RepoRoot 'scripts\ps1\run-android-tests.ps1'
        $script:RunAndroidText = Get-Content $script:RunAndroid -Raw
    }

    It 'wraps $modules filter result in @(...) so .Count is the array length' {
        # Without @(...) the single-item Where-Object pipeline collapses to a
        # hashtable and $modules.Count returned the number of HASHTABLE KEYS
        # (5: Name, Path, HasFlavor, IsKmp, Description) instead of array
        # length 1, propagating into summary.json as `totalModules: 5` for
        # single-module runs.
        $script:RunAndroidText | Should -Match '\$modules\s*=\s*@\(\s*\$modules\s*\|\s*Where-Object'
    }

    It 'wraps $totalSuccess and $totalFailure in @(...) for the same reason' {
        # Single-result runs would otherwise report `passedModules: 11` (the
        # 11 keys in the per-module result hashtable: Module, Status, Duration,
        # Success, TestsPassed, TestsFailed, TestsSkipped, LogFile, LogcatFile,
        # ErrorsFile, Retried).
        $script:RunAndroidText | Should -Match '\$totalSuccess\s*=\s*@\(\$results\s*\|\s*Where-Object'
        $script:RunAndroidText | Should -Match '\$totalFailure\s*=\s*@\(\$results\s*\|\s*Where-Object'
    }
}

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

    It "parallel.ps1 module-classification calls Test-ModuleHasTask" {
        $parallel = Join-Path $script:RepoRoot 'scripts\ps1\run-parallel-coverage-suite.ps1'
        (Get-Content $parallel -Raw) | Should -Match 'Test-ModuleHasTask'
    }

    It "parallel.ps1 emits [SKIP coverage] when probe says task missing" {
        $parallel = Join-Path $script:RepoRoot 'scripts\ps1\run-parallel-coverage-suite.ps1'
        (Get-Content $parallel -Raw) | Should -Match '\[SKIP coverage\]'
        (Get-Content $parallel -Raw) | Should -Match 'no coverage plugin applied'
    }

    It "run-android-tests.ps1 sources Gradle-Tasks-Probe.ps1" {
        $android = Join-Path $script:RepoRoot 'scripts\ps1\run-android-tests.ps1'
        (Get-Content $android -Raw) | Should -Match 'Gradle-Tasks-Probe\.ps1'
    }

    It "run-android-tests.ps1 has -DeviceTask param + Get-ModuleFirstExistingTask call" {
        $android = Join-Path $script:RepoRoot 'scripts\ps1\run-android-tests.ps1'
        (Get-Content $android -Raw) | Should -Match '\$DeviceTask\s*='
        (Get-Content $android -Raw) | Should -Match 'Get-ModuleFirstExistingTask'
        (Get-Content $android -Raw) | Should -Match 'androidConnectedCheck'
    }
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

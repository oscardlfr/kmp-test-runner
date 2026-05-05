#Requires -Modules Pester
# Tests for scripts/ps1/lib/ProjectModel.ps1 — PowerShell readers over the
# ProjectModel JSON written by lib/project-model.js (v0.5.1 Phase 4).

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:ProbeLib   = Join-Path $script:RepoRoot 'scripts\ps1\lib\Gradle-Tasks-Probe.ps1'
    $script:ModelLib   = Join-Path $script:RepoRoot 'scripts\ps1\lib\ProjectModel.ps1'

    . $script:ProbeLib
    . $script:ModelLib

    # Builds a temp project root, computes the canonical cache key the same
    # way lib/project-model.js does, and pre-writes a model-<sha>.json with
    # two example modules (KMP androidLibrary + pure JVM with jacoco).
    function script:New-PmFixture {
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("pm-fixture-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Set-Content -Path (Join-Path $dir 'settings.gradle.kts') -Value 'rootProject.name = "pm-test"'
        # gradlew.bat stub so the cache-key probe doesn't bail.
        Set-Content -Path (Join-Path $dir 'gradlew.bat') -Value '@echo off' -Encoding ASCII

        $sha = Get-KmpCacheKey -ProjectRoot $dir
        $cacheDir = Join-Path $dir '.kmp-test-runner-cache'
        New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null

        $modelObject = @{
            schemaVersion    = 1
            projectRoot      = $dir
            generatedAt      = '2026-04-29T00:00:00Z'
            cacheKey         = $sha
            jdkRequirement   = @{ min = 21; signals = @() }
            settingsIncludes = @(':core-encryption', ':core-jvm-only')
            modules          = @{
                ':core-encryption' = @{
                    type            = 'kmp'
                    androidDsl      = 'androidLibrary'
                    hasFlavor       = $false
                    sourceSets      = @{
                        test = $false; commonTest = $true; jvmTest = $false; desktopTest = $false
                        androidUnitTest = $false; androidInstrumentedTest = $true; androidTest = $false
                        iosTest = $false; nativeTest = $false
                    }
                    coveragePlugin  = $null
                    gradleTasks     = @('desktopTest', 'androidConnectedCheck')
                    resolved        = @{ unitTestTask = 'desktopTest'; deviceTestTask = 'androidConnectedCheck'; coverageTask = $null }
                }
                ':core-jvm-only' = @{
                    type            = 'jvm'
                    androidDsl      = $null
                    hasFlavor       = $false
                    sourceSets      = @{
                        test = $true; commonTest = $false; jvmTest = $false; desktopTest = $false
                        androidUnitTest = $false; androidInstrumentedTest = $false; androidTest = $false
                        iosTest = $false; nativeTest = $false
                    }
                    coveragePlugin  = 'jacoco'
                    gradleTasks     = @('test', 'jacocoTestReport')
                    resolved        = @{ unitTestTask = 'test'; deviceTestTask = $null; coverageTask = 'jacocoTestReport' }
                }
            }
        }

        $json = ConvertTo-Json $modelObject -Depth 10
        Set-Content -Path (Join-Path $cacheDir "model-$sha.json") -Value $json -Encoding UTF8
        return $dir
    }
}

Describe 'ProjectModel.ps1: function exposure' {
    It 'all expected readers are defined' {
        Get-Command Get-PmJdkRequirement -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
        Get-Command Get-PmUnitTestTask   -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
        Get-Command Get-PmDeviceTestTask -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
        Get-Command Get-PmCoverageTask   -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
        Get-Command Get-PmModuleType     -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
        Get-Command Get-PmModuleHasTests -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
    }
}

Describe 'Get-PmJdkRequirement' {
    It 'returns 21 from the fixture model' {
        $dir = New-PmFixture
        try {
            (Get-PmJdkRequirement -ProjectRoot $dir) | Should -Be 21
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }

    It 'returns $null when the model JSON is absent (caller falls back to legacy)' {
        $dir = New-PmFixture
        try {
            Remove-Item -Recurse -Force (Join-Path $dir '.kmp-test-runner-cache') -ErrorAction SilentlyContinue
            (Get-PmJdkRequirement -ProjectRoot $dir) | Should -BeNullOrEmpty
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }
}

Describe 'Get-PmUnitTestTask' {
    It 'resolves to desktopTest for the KMP module' {
        $dir = New-PmFixture
        try {
            (Get-PmUnitTestTask -ProjectRoot $dir -Module 'core-encryption') | Should -Be 'desktopTest'
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }

    It 'accepts both :module and bare module names' {
        $dir = New-PmFixture
        try {
            (Get-PmUnitTestTask -ProjectRoot $dir -Module 'core-jvm-only')   | Should -Be 'test'
            (Get-PmUnitTestTask -ProjectRoot $dir -Module ':core-jvm-only')  | Should -Be 'test'
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }
}

Describe 'Get-PmDeviceTestTask' {
    It 'resolves to androidConnectedCheck for KMP androidLibrary{} module' {
        $dir = New-PmFixture
        try {
            (Get-PmDeviceTestTask -ProjectRoot $dir -Module 'core-encryption') | Should -Be 'androidConnectedCheck'
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }

    It 'returns $null when module has no device-test task' {
        $dir = New-PmFixture
        try {
            (Get-PmDeviceTestTask -ProjectRoot $dir -Module 'core-jvm-only') | Should -BeNullOrEmpty
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }
}

Describe 'Get-PmCoverageTask' {
    It 'returns jacocoTestReport when plugin applied' {
        $dir = New-PmFixture
        try {
            (Get-PmCoverageTask -ProjectRoot $dir -Module 'core-jvm-only') | Should -Be 'jacocoTestReport'
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }

    It 'returns $null when no plugin applied to module' {
        $dir = New-PmFixture
        try {
            (Get-PmCoverageTask -ProjectRoot $dir -Module 'core-encryption') | Should -BeNullOrEmpty
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }
}

Describe 'Get-PmModuleType' {
    It 'reports kmp / jvm correctly' {
        $dir = New-PmFixture
        try {
            (Get-PmModuleType -ProjectRoot $dir -Module 'core-encryption') | Should -Be 'kmp'
            (Get-PmModuleType -ProjectRoot $dir -Module 'core-jvm-only')   | Should -Be 'jvm'
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }
}

Describe 'Get-PmModuleHasTests' {
    It 'returns $true when at least one source set is present' {
        $dir = New-PmFixture
        try {
            (Get-PmModuleHasTests -ProjectRoot $dir -Module 'core-encryption') | Should -BeTrue
            (Get-PmModuleHasTests -ProjectRoot $dir -Module 'core-jvm-only')   | Should -BeTrue
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }

    It 'returns $false when all sourceSets are false' {
        $dir = New-PmFixture
        try {
            # Patch in a third module with all-false sourceSets.
            $cacheDir = Join-Path $dir '.kmp-test-runner-cache'
            $modelFiles = Get-ChildItem $cacheDir -Filter 'model-*.json'
            $file = $modelFiles[0].FullName
            $obj = ConvertFrom-Json (Get-Content $file -Raw)
            $obj.modules | Add-Member -NotePropertyName ':api-only' -NotePropertyValue ([PSCustomObject]@{
                type = 'jvm'; androidDsl = $null; hasFlavor = $false
                sourceSets = [PSCustomObject]@{
                    test = $false; commonTest = $false; jvmTest = $false; desktopTest = $false
                    androidUnitTest = $false; androidInstrumentedTest = $false; androidTest = $false
                    iosTest = $false; nativeTest = $false
                }
                coveragePlugin = $null
                gradleTasks = @()
                resolved = [PSCustomObject]@{ unitTestTask = $null; deviceTestTask = $null; coverageTask = $null }
            })
            Set-Content -Path $file -Value (ConvertTo-Json $obj -Depth 10) -Encoding UTF8
            (Get-PmModuleHasTests -ProjectRoot $dir -Module 'api-only') | Should -BeFalse
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }

    It 'returns $null when the module is not in the model' {
        $dir = New-PmFixture
        try {
            (Get-PmModuleHasTests -ProjectRoot $dir -Module 'no-such-module') | Should -BeNullOrEmpty
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }
}

Describe 'Fail-soft on malformed JSON' {
    It 'returns $null without throwing when model JSON is corrupt' {
        $dir = New-PmFixture
        try {
            $cacheDir = Join-Path $dir '.kmp-test-runner-cache'
            $file = (Get-ChildItem $cacheDir -Filter 'model-*.json')[0].FullName
            Set-Content -Path $file -Value '{ not valid json' -Encoding UTF8
            (Get-PmJdkRequirement -ProjectRoot $dir) | Should -BeNullOrEmpty
            (Get-PmUnitTestTask -ProjectRoot $dir -Module 'core-encryption') | Should -BeNullOrEmpty
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }
}

# Phase 4 step 4 — Test-ModuleHasTestSources lives in lib/Script-Utils.ps1
# now and supports two parameter sets: ByPath (legacy filesystem walk) and
# ByModelName (prefers the ProjectModel JSON, falls back to FS walk).
Describe 'Test-ModuleHasTestSources (Phase 4 step 4 — model fast-path)' {

    BeforeAll {
        . (Join-Path $script:RepoRoot 'scripts\ps1\lib\Script-Utils.ps1')
    }

    It 'returns $true when model says module has tests' {
        $dir = New-PmFixture
        try {
            # Filesystem has NO src/* dirs — so a $true answer proves the
            # model path was taken (fixture sets commonTest = $true).
            (Test-ModuleHasTestSources -ProjectRoot $dir -Module 'core-encryption') | Should -BeTrue
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }

    It 'returns $false when model says no test sources' {
        $dir = New-PmFixture
        try {
            # Patch the model to flip all sourceSets to $false.
            $cacheDir = Join-Path $dir '.kmp-test-runner-cache'
            $file = (Get-ChildItem $cacheDir -Filter 'model-*.json')[0].FullName
            $obj = ConvertFrom-Json (Get-Content $file -Raw)
            foreach ($prop in $obj.modules.':core-encryption'.sourceSets.PSObject.Properties) {
                $prop.Value = $false
            }
            Set-Content -Path $file -Value (ConvertTo-Json $obj -Depth 10) -Encoding UTF8
            (Test-ModuleHasTestSources -ProjectRoot $dir -Module 'core-encryption') | Should -BeFalse
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }

    It 'falls back to filesystem walk when model absent' {
        $dir = New-PmFixture
        try {
            Remove-Item -Recurse -Force (Join-Path $dir '.kmp-test-runner-cache') -ErrorAction SilentlyContinue
            New-Item -ItemType Directory -Path (Join-Path $dir 'core-encryption\src\commonTest') -Force | Out-Null
            (Test-ModuleHasTestSources -ProjectRoot $dir -Module 'core-encryption') | Should -BeTrue
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }

    It 'legacy -ModulePath form still works (filesystem walk only)' {
        $dir = New-PmFixture
        try {
            $modPath = Join-Path $dir 'legacy-mod'
            New-Item -ItemType Directory -Path (Join-Path $modPath 'src\jvmTest') -Force | Out-Null
            (Test-ModuleHasTestSources -ModulePath $modPath) | Should -BeTrue
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }
}

# Phase 4 step 5 — run-android-tests.ps1 wiring tests deleted in v0.8
# sub-entry 3. The ps1 wrapper is now a thin node-launcher; tier ordering
# (--device-task override > project-model deviceTestTask > static fallback)
# moved to lib/android-orchestrator.js#pickGradleTaskFor and is covered by
# tests/vitest/android-orchestrator.test.js cases 1 (WS-3) + 4 (--device-task
# escape hatch).

# v0.8 sub-entry 5: run-parallel-coverage-suite.ps1 wrapper is now a thin
# Node launcher. ProjectModel coverage discrimination + Get-PmCoverageTask
# logic moved entirely into lib/parallel-orchestrator.js +
# lib/coverage-orchestrator.js (which call the JS project-model directly).
# The wrapper has no Get-PmCoverageTask reference; the absence check below
# verifies the migration removed the old call sites.
Describe 'run-parallel-coverage-suite.ps1 — sub-entry 5 thin Node launcher' {

    BeforeAll {
        $script:Parallel = Join-Path $script:RepoRoot 'scripts\ps1\run-parallel-coverage-suite.ps1'
        $script:ParallelText = Get-Content $script:Parallel -Raw
    }

    It 'forwards to node lib/runner.js parallel|coverage' {
        $script:ParallelText | Should -Match 'node.*runner\.js'
        $script:ParallelText | Should -Match '(parallel|coverage)'
    }

    It 'no longer references Get-PmCoverageTask / Detect-CoverageTool / Get-CoverageGradleTask' {
        foreach ($pattern in 'Detect-CoverageTool', 'Get-CoverageGradleTask', 'Get-PmCoverageTask') {
            $execLines = ($script:ParallelText -split "`n") |
                Where-Object { $_ -match $pattern -and $_ -notmatch '^\s*#' }
            $execLines.Count | Should -Be 0
        }
    }
}

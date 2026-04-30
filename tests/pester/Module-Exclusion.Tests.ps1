#Requires -Modules Pester
# Tests for module exclusion + auto-skip-untested (v0.5.0 — Bug B).
# Verifies scripts/ps1/run-parallel-coverage-suite.ps1 Test-ModuleHasTestSources +
# Find-Modules filtering.

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:Parallel = Join-Path $script:RepoRoot 'scripts\ps1\run-parallel-coverage-suite.ps1'

    function New-FakeMultiModuleProject {
        param([string]$Path)
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $Path 'bin') -Force | Out-Null

        # Stub gradlew + java so the script doesn't try to talk to gradle.
        Set-Content -Path (Join-Path $Path 'gradlew.bat') -Value "@echo off`r`nexit /b 0"
        Set-Content -Path (Join-Path $Path 'gradlew') -Value "#!/usr/bin/env bash`nexit 0"
        Set-Content -Path (Join-Path $Path 'bin\java.cmd') -Value @"
@echo off
echo openjdk version "17.0.10" 2024-01-16 1>&2
exit /b 0
"@

        $settings = @'
rootProject.name = "test-project"
include(":core-domain")
include(":feature-home")
include(":api")
include(":build-logic")
'@
        Set-Content -Path (Join-Path $Path 'settings.gradle.kts') -Value $settings

        foreach ($mod in @('core-domain', 'feature-home', 'api', 'build-logic')) {
            $modPath = Join-Path $Path $mod
            New-Item -ItemType Directory -Path $modPath -Force | Out-Null
            Set-Content -Path (Join-Path $modPath 'build.gradle.kts') `
                -Value 'kotlin { jvmToolchain(17) }'
        }

        # Only core-domain + feature-home have test source sets.
        New-Item -ItemType Directory -Force `
            -Path (Join-Path $Path 'core-domain\src\commonTest') | Out-Null
        New-Item -ItemType Directory -Force `
            -Path (Join-Path $Path 'feature-home\src\test') | Out-Null
    }

    function Invoke-WithFakeJava {
        param([string]$ProjectRoot, [scriptblock]$Action)
        $oldPath = $env:PATH
        try {
            $env:PATH = (Join-Path $ProjectRoot 'bin') + ';' + $env:PATH
            & $Action
        } finally {
            $env:PATH = $oldPath
        }
    }

    # Extract "Modules found: N" from script output for test assertions.
    function Get-ModulesFoundCount {
        param([string]$Output)
        if ($Output -match 'Modules found:\s+(\d+)') { return [int]$Matches[1] }
        return -1
    }
}

# ----------------------------------------------------------------------------
# Helper unit tests: dot-source the parallel script as text, scrape the
# Test-ModuleHasTestSources function, and exec it in an isolated session.
# (The parallel script's param() block requires -ProjectRoot so we can't
# dot-source it whole.)
# ----------------------------------------------------------------------------

Describe 'Test-ModuleHasTestSources (lib/Script-Utils.ps1)' {

    BeforeAll {
        # Phase 4 step 4 (v0.5.1): Test-ModuleHasTestSources moved from
        # run-parallel-coverage-suite.ps1 to scripts/ps1/lib/Script-Utils.ps1
        # to mirror the sh layout. Dot-source the lib directly so this test
        # exercises the shipping function (not a regex-extracted copy).
        $scriptUtils = Join-Path $script:RepoRoot 'scripts\ps1\lib\Script-Utils.ps1'
        if (-not (Test-Path $scriptUtils)) {
            throw "Script-Utils.ps1 not found at $scriptUtils"
        }
        . $scriptUtils
    }

    BeforeEach {
        $script:WorkDir = Join-Path $TestDrive ("mod-" + [guid]::NewGuid().ToString('N').Substring(0,8))
        New-Item -ItemType Directory -Path $script:WorkDir -Force | Out-Null
    }

    It 'returns $true when src/test exists' {
        New-Item -ItemType Directory -Force -Path (Join-Path $script:WorkDir 'src\test') | Out-Null
        Test-ModuleHasTestSources -ModulePath $script:WorkDir | Should -BeTrue
    }

    It 'returns $true when src/commonTest exists' {
        New-Item -ItemType Directory -Force -Path (Join-Path $script:WorkDir 'src\commonTest') | Out-Null
        Test-ModuleHasTestSources -ModulePath $script:WorkDir | Should -BeTrue
    }

    It 'returns $false when no test source set exists' {
        New-Item -ItemType Directory -Force -Path (Join-Path $script:WorkDir 'src\main') | Out-Null
        Test-ModuleHasTestSources -ModulePath $script:WorkDir | Should -BeFalse
    }

    It 'detects each KMP/Android test source set variant' {
        foreach ($sd in @('jvmTest','desktopTest','androidUnitTest','androidInstrumentedTest','androidTest','iosTest','nativeTest')) {
            $modPath = Join-Path $TestDrive ("variant-$sd-" + [guid]::NewGuid().ToString('N').Substring(0,4))
            New-Item -ItemType Directory -Force -Path (Join-Path $modPath "src\$sd") | Out-Null
            Test-ModuleHasTestSources -ModulePath $modPath | Should -BeTrue -Because "src/$sd should be detected"
        }
    }
}

# ----------------------------------------------------------------------------
# End-to-end: invoke the parallel script and assert on the discovery output
# ----------------------------------------------------------------------------

Describe 'parallel.ps1: Find-Modules filtering (end-to-end)' {

    BeforeEach {
        $script:WorkDir = Join-Path $TestDrive ("proj-" + [guid]::NewGuid().ToString('N').Substring(0,8))
        New-FakeMultiModuleProject -Path $script:WorkDir
    }

    It 'auto-skips :api and :build-logic (no test source set) by default' {
        $script = $script:Parallel
        $work = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            (& pwsh -NoLogo -NoProfile -File $script -ProjectRoot $work -ModuleFilter '*' 2>&1) -join "`n"
        }
        (Get-ModulesFoundCount -Output $output) | Should -Be 2
        $output | Should -Match '\[SKIP\]\s+api'
        $output | Should -Match '\[SKIP\]\s+build-logic'
        $output | Should -Match 'no test source set'
    }

    It '-IncludeUntested re-includes untested modules' {
        $script = $script:Parallel
        $work = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            (& pwsh -NoLogo -NoProfile -File $script -ProjectRoot $work -ModuleFilter '*' -IncludeUntested 2>&1) -join "`n"
        }
        (Get-ModulesFoundCount -Output $output) | Should -Be 4
    }

    It '-ExcludeModules removes matching modules with [SKIP] reason' {
        $script = $script:Parallel
        $work = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            (& pwsh -NoLogo -NoProfile -File $script -ProjectRoot $work -ModuleFilter '*' `
                -ExcludeModules 'feature-*' 2>&1) -join "`n"
        }
        # core-domain only: feature-* excluded explicitly, api/build-logic auto-skipped.
        (Get-ModulesFoundCount -Output $output) | Should -Be 1
        $output | Should -Match '\[SKIP\]\s+feature-home \(excluded by -ExcludeModules\)'
    }

    It '-ExcludeModules accepts comma-separated globs' {
        $script = $script:Parallel
        $work = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            (& pwsh -NoLogo -NoProfile -File $script -ProjectRoot $work -ModuleFilter '*' `
                -ExcludeModules 'api,build-logic' -IncludeUntested 2>&1) -join "`n"
        }
        # api + build-logic explicitly excluded; -IncludeUntested doesn't undo
        # the explicit exclusion → core-domain + feature-home remain.
        (Get-ModulesFoundCount -Output $output) | Should -Be 2
    }

    It 'when no modules survive filtering → exits 3' {
        $script = $script:Parallel
        $work = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            (& pwsh -NoLogo -NoProfile -File $script -ProjectRoot $work -ModuleFilter '*' `
                -ExcludeModules 'core-*,feature-*' 2>&1) -join "`n"
        }
        $LASTEXITCODE | Should -Be 3
        $output | Should -Match 'No modules found'
    }
}

# ----------------------------------------------------------------------------
# v0.6.2 Gap 1.2: --json envelope surfaces state.skipped[] from [SKIP] lines
# v0.6.2 Gap 1.1: --json envelope carries code:"no_test_modules" discriminator
# ----------------------------------------------------------------------------

Describe 'kmp-test --json: skipped[] and no_test_modules envelope' {

    BeforeEach {
        $script:WorkDir = Join-Path $TestDrive ("envelope-" + [guid]::NewGuid().ToString('N').Substring(0,8))
        New-FakeMultiModuleProject -Path $script:WorkDir
    }

    It 'skipped[] populated for auto-skipped untested modules' {
        $cli = Join-Path $script:RepoRoot 'bin\kmp-test.js'
        $work = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            (& node $cli --json parallel --project-root $work --module-filter '*' 2>&1) -join "`n"
        }
        $firstLine = ($output -split "`n" | Where-Object { $_ -match '^\{' } | Select-Object -First 1)
        $firstLine | Should -Not -BeNullOrEmpty
        $firstLine | Should -Match '"skipped":'
        $firstLine | Should -Match '"module":"api"'
        $firstLine | Should -Match '"module":"build-logic"'
        $firstLine | Should -Match '"reason":"no test source set'
    }

    It 'no_test_modules code fires when filter excludes all' {
        $cli = Join-Path $script:RepoRoot 'bin\kmp-test.js'
        $work = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            (& node $cli --json parallel --project-root $work --module-filter '*' `
                --exclude-modules 'core-*,feature-*' 2>&1) -join "`n"
        }
        $LASTEXITCODE | Should -Be 3
        $firstLine = ($output -split "`n" | Where-Object { $_ -match '^\{' } | Select-Object -First 1)
        $firstLine | Should -Not -BeNullOrEmpty
        $firstLine | Should -Match '"code":"no_test_modules"'
        $firstLine | Should -Not -Match '"code":"no_summary"'
    }
}

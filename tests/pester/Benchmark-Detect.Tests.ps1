#Requires -Modules Pester
# Tests for scripts/ps1/lib/Benchmark-Detect.ps1 helpers
#   - Get-ModuleBenchmarkPlatforms (categorize a module's benchmark capability)
#   - Test-ModuleSupportsPlatform (predicate used by run-benchmarks.ps1)
#   - Get-BenchmarkGradleTask (task name resolution)

BeforeAll {
    $script:LibPath = Join-Path $PSScriptRoot '..\..\scripts\ps1\lib\Benchmark-Detect.ps1'
    . $script:LibPath
}

Describe 'Get-ModuleBenchmarkPlatforms' {
    BeforeEach {
        $script:ProjRoot = New-Item -ItemType Directory -Path (Join-Path $TestDrive ([Guid]::NewGuid().ToString()))
    }

    It 'returns "android" for an androidx.benchmark-only module' {
        $modDir = New-Item -ItemType Directory -Path (Join-Path $script:ProjRoot 'benchmark')
        Set-Content -Path (Join-Path $modDir 'build.gradle.kts') -Value @'
plugins { id("com.android.library") }
android {
    defaultConfig {
        testInstrumentationRunner = "androidx.benchmark.junit4.AndroidBenchmarkRunner"
    }
}
'@
        $platforms = Get-ModuleBenchmarkPlatforms -ProjectRoot $script:ProjRoot -Module 'benchmark'
        $platforms | Should -Contain 'android'
        $platforms | Should -Not -Contain 'jvm'
    }

    It 'returns "jvm" for a kotlinx.benchmark-only module' {
        $modDir = New-Item -ItemType Directory -Path (Join-Path $script:ProjRoot 'perf')
        Set-Content -Path (Join-Path $modDir 'build.gradle.kts') -Value @'
plugins { id("org.jetbrains.kotlinx.benchmark") version "0.4.10" }
benchmark { targets { register("jvm") } }
'@
        $platforms = Get-ModuleBenchmarkPlatforms -ProjectRoot $script:ProjRoot -Module 'perf'
        $platforms | Should -Contain 'jvm'
        $platforms | Should -Not -Contain 'android'
    }

    It 'returns both for a KMP module declaring both benchmark plugins' {
        $modDir = New-Item -ItemType Directory -Path (Join-Path $script:ProjRoot 'multi')
        Set-Content -Path (Join-Path $modDir 'build.gradle.kts') -Value @'
plugins {
    id("org.jetbrains.kotlinx.benchmark")
    id("com.android.library")
}
android {
    defaultConfig {
        testInstrumentationRunner = "androidx.benchmark.junit4.AndroidBenchmarkRunner"
    }
}
'@
        $platforms = Get-ModuleBenchmarkPlatforms -ProjectRoot $script:ProjRoot -Module 'multi'
        $platforms | Should -Contain 'jvm'
        $platforms | Should -Contain 'android'
        $platforms.Count | Should -Be 2
    }

    It 'returns empty array when no recognized benchmark plugin' {
        $modDir = New-Item -ItemType Directory -Path (Join-Path $script:ProjRoot 'plain')
        Set-Content -Path (Join-Path $modDir 'build.gradle.kts') -Value '// no benchmark plugin'
        $platforms = @(Get-ModuleBenchmarkPlatforms -ProjectRoot $script:ProjRoot -Module 'plain')
        $platforms.Count | Should -Be 0
    }

    It 'returns empty array when module dir does not exist' {
        $platforms = @(Get-ModuleBenchmarkPlatforms -ProjectRoot $script:ProjRoot -Module 'nonexistent')
        $platforms.Count | Should -Be 0
    }

    It 'returns empty array for an empty build.gradle.kts' {
        $modDir = New-Item -ItemType Directory -Path (Join-Path $script:ProjRoot 'empty')
        Set-Content -Path (Join-Path $modDir 'build.gradle.kts') -Value ''
        $platforms = @(Get-ModuleBenchmarkPlatforms -ProjectRoot $script:ProjRoot -Module 'empty')
        $platforms.Count | Should -Be 0
    }

    It 'resolves nested-colon module path (sdk:wiring-e) correctly' {
        $modDir = New-Item -ItemType Directory -Path (Join-Path $script:ProjRoot 'sdk\wiring-e') -Force
        Set-Content -Path (Join-Path $modDir 'build.gradle.kts') -Value @'
plugins { id("org.jetbrains.kotlinx.benchmark") }
'@
        $platforms = @(Get-ModuleBenchmarkPlatforms -ProjectRoot $script:ProjRoot -Module 'sdk:wiring-e')
        $platforms | Should -Contain 'jvm'
    }
}

Describe 'Test-ModuleSupportsPlatform' {
    BeforeEach {
        $script:ProjRoot = New-Item -ItemType Directory -Path (Join-Path $TestDrive ([Guid]::NewGuid().ToString()))
    }

    It 'returns $true for jvm on a kotlinx.benchmark module' {
        $modDir = New-Item -ItemType Directory -Path (Join-Path $script:ProjRoot 'perf')
        Set-Content -Path (Join-Path $modDir 'build.gradle.kts') -Value 'id("org.jetbrains.kotlinx.benchmark")'
        Test-ModuleSupportsPlatform -ProjectRoot $script:ProjRoot -Module 'perf' -Platform 'jvm' | Should -BeTrue
    }

    It 'returns $false for jvm on an androidx.benchmark-only module' {
        $modDir = New-Item -ItemType Directory -Path (Join-Path $script:ProjRoot 'bench')
        Set-Content -Path (Join-Path $modDir 'build.gradle.kts') -Value 'androidx.benchmark.junit4.AndroidBenchmarkRunner'
        Test-ModuleSupportsPlatform -ProjectRoot $script:ProjRoot -Module 'bench' -Platform 'jvm' | Should -BeFalse
    }

    It 'returns $true for android on an androidx.benchmark-only module' {
        $modDir = New-Item -ItemType Directory -Path (Join-Path $script:ProjRoot 'bench')
        Set-Content -Path (Join-Path $modDir 'build.gradle.kts') -Value 'androidx.benchmark.junit4.AndroidBenchmarkRunner'
        Test-ModuleSupportsPlatform -ProjectRoot $script:ProjRoot -Module 'bench' -Platform 'android' | Should -BeTrue
    }

    It 'is permissive ($true) when no benchmark plugin detected (preserves non-standard setups)' {
        $modDir = New-Item -ItemType Directory -Path (Join-Path $script:ProjRoot 'plain')
        Set-Content -Path (Join-Path $modDir 'build.gradle.kts') -Value '// no benchmark plugin'
        Test-ModuleSupportsPlatform -ProjectRoot $script:ProjRoot -Module 'plain' -Platform 'jvm' | Should -BeTrue
        Test-ModuleSupportsPlatform -ProjectRoot $script:ProjRoot -Module 'plain' -Platform 'android' | Should -BeTrue
    }

    It 'is permissive ($true) when module dir does not exist' {
        Test-ModuleSupportsPlatform -ProjectRoot $script:ProjRoot -Module 'nonexistent' -Platform 'jvm' | Should -BeTrue
    }
}

Describe 'Get-BenchmarkGradleTask' {
    It 'maps jvm/smoke to :module:desktopSmokeBenchmark' {
        Get-BenchmarkGradleTask -Module 'foo' -Platform 'jvm' -Config 'smoke' | Should -Be ':foo:desktopSmokeBenchmark'
    }
    It 'maps jvm/stress to :module:desktopStressBenchmark' {
        Get-BenchmarkGradleTask -Module 'foo' -Platform 'jvm' -Config 'stress' | Should -Be ':foo:desktopStressBenchmark'
    }
    It 'maps jvm/main to :module:desktopBenchmark' {
        Get-BenchmarkGradleTask -Module 'foo' -Platform 'jvm' -Config 'main' | Should -Be ':foo:desktopBenchmark'
    }
    It 'maps android (any config) to :module:connectedAndroidTest' {
        Get-BenchmarkGradleTask -Module 'foo' -Platform 'android' -Config 'smoke' | Should -Be ':foo:connectedAndroidTest'
        Get-BenchmarkGradleTask -Module 'foo' -Platform 'android' -Config 'main' | Should -Be ':foo:connectedAndroidTest'
        Get-BenchmarkGradleTask -Module 'foo' -Platform 'android' -Config 'stress' | Should -Be ':foo:connectedAndroidTest'
    }
}

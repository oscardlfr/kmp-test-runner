#Requires -Modules Pester
# v0.7.0 — fixture-driven verification of iOS / macOS source-set + task
# resolution against tests/fixtures/kmp-with-ios/ (PowerShell parity to
# tests/bats/test-ios-macos-support.bats).
#
# Strategy: mirror Js-Wasm-Support.Tests.ps1. Each test pre-writes the
# `tasks-<sha>.txt` cache so the probe layer reads from cache and never
# spawns gradle.

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:Fixture = Join-Path $script:RepoRoot 'tests\fixtures\kmp-with-ios'
    $script:ProbeLib = Join-Path $script:RepoRoot 'scripts\ps1\lib\Gradle-Tasks-Probe.ps1'
    $script:ModelLib = Join-Path $script:RepoRoot 'scripts\ps1\lib\ProjectModel.ps1'

    . $script:ProbeLib
    . $script:ModelLib

    function script:Reset-FixtureCache {
        $cache = Join-Path $script:Fixture '.kmp-test-runner-cache'
        if (Test-Path $cache) { Remove-Item -Recurse -Force $cache }

        Push-Location $script:RepoRoot
        try {
            $sha = & node --input-type=module -e "
                import { computeCacheKey } from './lib/project-model.js';
                process.stdout.write(computeCacheKey('$($script:Fixture -replace '\\', '/')'));
            "
        } finally {
            Pop-Location
        }

        New-Item -ItemType Directory -Force -Path $cache | Out-Null
        $tasksFile = Join-Path $cache "tasks-$sha.txt"
        Set-Content -Path $tasksFile -Value @(
            'ios-only:iosX64Test - Runs the tests for iosX64 target'
            'macos-only:macosArm64Test - Runs the tests for macosArm64 target'
            'kmp-multi:jvmTest - Runs the tests for jvm target'
            'kmp-multi:iosSimulatorArm64Test - Runs the tests for iosSimulatorArm64 target'
        )
    }

    function script:Build-FixtureModel {
        Push-Location $script:RepoRoot
        try {
            $json = & node --input-type=module -e "
                import { buildProjectModel } from './lib/project-model.js';
                process.stdout.write(JSON.stringify(buildProjectModel('$($script:Fixture -replace '\\', '/')', { skipProbe: true })));
            "
        } finally {
            Pop-Location
        }
        return $json | ConvertFrom-Json
    }
}

AfterAll {
    $cache = Join-Path $script:Fixture '.kmp-test-runner-cache'
    if (Test-Path $cache) { Remove-Item -Recurse -Force $cache }
}

Describe 'iOS / macOS support (v0.7.0)' {
    BeforeEach { Reset-FixtureCache }

    It 'ios-only KMP module: iosTestTask is iosX64Test, unitTestTask stays null' {
        $m = Build-FixtureModel
        $mod = $m.modules.':ios-only'
        $mod.type | Should -Be 'kmp'
        $mod.resolved.unitTestTask | Should -BeNullOrEmpty
        $mod.resolved.iosTestTask | Should -Be 'iosX64Test'
        $mod.resolved.macosTestTask | Should -BeNullOrEmpty
        $mod.sourceSets.iosX64Test | Should -Be $true
    }

    It 'macos-only KMP module: macosTestTask is macosArm64Test, unitTestTask stays null' {
        $m = Build-FixtureModel
        $mod = $m.modules.':macos-only'
        $mod.type | Should -Be 'kmp'
        $mod.resolved.unitTestTask | Should -BeNullOrEmpty
        $mod.resolved.iosTestTask | Should -BeNullOrEmpty
        $mod.resolved.macosTestTask | Should -Be 'macosArm64Test'
        $mod.sourceSets.macosArm64Test | Should -Be $true
    }

    It 'kmp-multi (KMP+iOS): unitTestTask still picks jvmTest, iosTestTask exposes iosSimulatorArm64Test' {
        $m = Build-FixtureModel
        $mod = $m.modules.':kmp-multi'
        $mod.resolved.unitTestTask | Should -Be 'jvmTest'
        $mod.resolved.iosTestTask | Should -Be 'iosSimulatorArm64Test'
        $mod.resolved.macosTestTask | Should -BeNullOrEmpty
        $mod.sourceSets.jvmTest | Should -Be $true
        $mod.sourceSets.iosSimulatorArm64Test | Should -Be $true
    }

    It 'Get-PmIosTestTask reads iosTestTask from the model' {
        Build-FixtureModel | Out-Null
        Get-PmIosTestTask -ProjectRoot $script:Fixture -Module 'ios-only' | Should -Be 'iosX64Test'
        Get-PmIosTestTask -ProjectRoot $script:Fixture -Module 'kmp-multi' | Should -Be 'iosSimulatorArm64Test'
    }

    It 'Get-PmMacosTestTask reads macosTestTask from the model' {
        Build-FixtureModel | Out-Null
        Get-PmMacosTestTask -ProjectRoot $script:Fixture -Module 'macos-only' | Should -Be 'macosArm64Test'
    }

    It 'Get-PmIosTestTask returns null when model is absent' {
        $cache = Join-Path $script:Fixture '.kmp-test-runner-cache'
        if (Test-Path $cache) { Remove-Item -Recurse -Force $cache }
        (Get-PmIosTestTask -ProjectRoot $script:Fixture -Module 'kmp-multi') | Should -BeNullOrEmpty
        (Get-PmMacosTestTask -ProjectRoot $script:Fixture -Module 'macos-only') | Should -BeNullOrEmpty
    }
}

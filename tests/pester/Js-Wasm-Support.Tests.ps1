#Requires -Modules Pester
# v0.6 Bug 3 — fixture-driven verification of JS / Wasm source-set + task
# resolution against tests/fixtures/kmp-with-js/ (PowerShell parity to
# tests/bats/test-js-wasm-support.bats).
#
# Strategy: avoid relying on `gradlew tasks --all --quiet` execution from JS
# (Windows spawnSync EINVAL with .bat files). Each test pre-writes the
# `tasks-<sha>.txt` cache so the probe layer reads from cache and never spawns.

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:Fixture = Join-Path $script:RepoRoot 'tests\fixtures\kmp-with-js'
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
            'web-only:jsTest - Runs the tests for js target'
            'kmp-multi:jvmTest - Runs the tests for jvm target'
            'kmp-multi:jsTest - Runs the tests for js target'
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

Describe 'JS / Wasm support (v0.6 Bug 3)' {
    BeforeEach { Reset-FixtureCache }

    It 'web-only KMP module: unitTestTask falls back to jsTest, webTestTask is jsTest' {
        $m = Build-FixtureModel
        $mod = $m.modules.':web-only'
        $mod.type | Should -Be 'kmp'
        $mod.resolved.unitTestTask | Should -Be 'jsTest'
        $mod.resolved.webTestTask | Should -Be 'jsTest'
        $mod.sourceSets.jsTest | Should -Be $true
    }

    It 'kmp-multi (KMP+JS): unitTestTask still picks jvmTest, webTestTask exposes jsTest' {
        $m = Build-FixtureModel
        $mod = $m.modules.':kmp-multi'
        $mod.resolved.unitTestTask | Should -Be 'jvmTest'
        $mod.resolved.webTestTask | Should -Be 'jsTest'
        $mod.sourceSets.jvmTest | Should -Be $true
        $mod.sourceSets.jsTest | Should -Be $true
    }

    It 'Get-PmWebTestTask reads webTestTask from the model' {
        Build-FixtureModel | Out-Null
        Get-PmWebTestTask -ProjectRoot $script:Fixture -Module 'web-only' | Should -Be 'jsTest'
        Get-PmWebTestTask -ProjectRoot $script:Fixture -Module 'kmp-multi' | Should -Be 'jsTest'
    }

    It 'Get-PmWebTestTask returns null when model is absent' {
        $cache = Join-Path $script:Fixture '.kmp-test-runner-cache'
        if (Test-Path $cache) { Remove-Item -Recurse -Force $cache }
        (Get-PmWebTestTask -ProjectRoot $script:Fixture -Module 'kmp-multi') | Should -BeNullOrEmpty
    }
}

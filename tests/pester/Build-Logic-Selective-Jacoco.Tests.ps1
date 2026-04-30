#Requires -Modules Pester
# v0.6.x Gap 4 — Pester parity to tests/bats/test-build-logic-selective-jacoco.bats.
# Verifies per-module convention-plugin coverage detection against the
# tests/fixtures/build-logic-selective-jacoco/ fixture.

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:Fixture = Join-Path $script:RepoRoot 'tests\fixtures\build-logic-selective-jacoco'

    function script:Reset-FixtureCache {
        $cache = Join-Path $script:Fixture '.kmp-test-runner-cache'
        if (Test-Path $cache) { Remove-Item -Recurse -Force $cache }
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

Describe 'Per-module convention-plugin coverage detection (v0.6.x Gap 4)' {
    BeforeEach { Reset-FixtureCache }

    It 'module that applies jacoco-adding convention plugin inherits coveragePlugin=jacoco' {
        $m = Build-FixtureModel
        $m.modules.':app-with-jacoco'.coveragePlugin | Should -Be 'jacoco'
    }

    It 'module that applies non-coverage convention plugin → coveragePlugin=null (no over-predict)' {
        $m = Build-FixtureModel
        $m.modules.':app-with-noop'.coveragePlugin | Should -BeNullOrEmpty
    }

    It 'module with no convention plugin → coveragePlugin=null' {
        $m = Build-FixtureModel
        $m.modules.':app-no-convention'.coveragePlugin | Should -BeNullOrEmpty
    }

    It 'exactly 1 of 3 modules has coveragePlugin=jacoco (selective inheritance)' {
        $m = Build-FixtureModel
        $jacocoCount = ($m.modules.PSObject.Properties.Value | Where-Object { $_.coveragePlugin -eq 'jacoco' }).Count
        $jacocoCount | Should -Be 1
    }
}

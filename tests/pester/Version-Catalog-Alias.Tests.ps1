#Requires -Modules Pester
# v0.6.x Gap 3 — fixture-driven verification of alias(libs.plugins.<X>)
# module-type detection against tests/fixtures/version-catalog-alias-plugins/
# (PowerShell parity to tests/bats/test-version-catalog-alias.bats).

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:Fixture = Join-Path $script:RepoRoot 'tests\fixtures\version-catalog-alias-plugins'

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

Describe 'Version catalog alias() module-type detection (v0.6.x Gap 3)' {
    BeforeEach { Reset-FixtureCache }

    It 'alias(libs.plugins.android.application) classifies :app as android (TOML resolved)' {
        $m = Build-FixtureModel
        $m.modules.':app'.type | Should -Be 'android'
    }

    It 'alias(libs.plugins.kotlin.multiplatform) classifies :shared as kmp (TOML resolved)' {
        $m = Build-FixtureModel
        $m.modules.':shared'.type | Should -Be 'kmp'
    }

    It 'alias(libs.plugins.kotlin.jvm) classifies :jvm-lib as jvm (TOML string-form resolved)' {
        $m = Build-FixtureModel
        $m.modules.':jvm-lib'.type | Should -Be 'jvm'
    }

    It 'namespaced alias key (libs.plugins.nowinandroid.android.application) resolves heuristically to android' {
        $m = Build-FixtureModel
        $m.modules.':namespaced-app'.type | Should -Be 'android'
    }
}

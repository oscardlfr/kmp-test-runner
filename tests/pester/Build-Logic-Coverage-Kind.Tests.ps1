#Requires -Modules Pester
# v0.6 Bug 6 — fixture-driven verification of detectBuildLogicCoverageHints
# convention-vs-self discrimination (PowerShell parity to
# tests/bats/test-build-logic-coverage-kind.bats).
#
# Loads each fixture under tests/fixtures/build-logic-*-jacoco/ via the JS
# canonical builder and asserts the per-module `coveragePlugin` value reflects
# the discrimination rule:
#   - Convention plugin (under build-logic/<X>/src/main/...) → consumer module
#     inherits coveragePlugin.
#   - Self-buildscript plugin (in build-logic/build.gradle.kts plugins {})  →
#     consumer module does NOT inherit.
#   - Plugin-registration noise (register("...Jacoco..."), implementationClass,
#     id = libs.plugins.<...>) → no signal at all.

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

    # Build the model JSON for a fixture directory and return a hashtable of
    # `<module>` → `<coveragePlugin or '<null>'>`. Spawns node from RepoRoot.
    function script:Get-FixtureModuleCoverage {
        param([string]$FixtureRelPath)
        $fixtureFull = Join-Path $script:RepoRoot $FixtureRelPath
        # Clean any stale cache before the build so each run is deterministic.
        $cacheDir = Join-Path $fixtureFull '.kmp-test-runner-cache'
        if (Test-Path $cacheDir) { Remove-Item -Recurse -Force $cacheDir }

        $script = @"
import { buildProjectModel } from './lib/project-model.js';
const m = buildProjectModel('$($fixtureFull -replace '\\', '/')', { skipProbe: true });
const out = {};
for (const [name, mod] of Object.entries(m.modules)) {
  out[name] = mod.coveragePlugin === null ? '<null>' : mod.coveragePlugin;
}
process.stdout.write(JSON.stringify(out));
"@
        $tmpFile = New-TemporaryFile
        try {
            Set-Content -Path $tmpFile -Value $script -Encoding ASCII
            Push-Location $script:RepoRoot
            try {
                $json = & node --input-type=module -e (Get-Content -Raw $tmpFile)
                if ($LASTEXITCODE -ne 0) { throw "node failed: $json" }
            } finally {
                Pop-Location
            }
        } finally {
            Remove-Item -Force $tmpFile -ErrorAction SilentlyContinue
            if (Test-Path $cacheDir) { Remove-Item -Recurse -Force $cacheDir }
        }
        return $json | ConvertFrom-Json -AsHashtable
    }
}

Describe 'detectBuildLogicCoverageHints kind discrimination (v0.6 Bug 6)' {

    It 'convention fixture: consumer module inherits jacoco from src/main/ Plugin<Project> source' {
        $coverage = Get-FixtureModuleCoverage -FixtureRelPath 'tests\fixtures\build-logic-convention-jacoco'
        $coverage[':core-foo'] | Should -Be 'jacoco'
    }

    It 'self fixture: consumer module does NOT inherit jacoco from build-logic root buildscript' {
        $coverage = Get-FixtureModuleCoverage -FixtureRelPath 'tests\fixtures\build-logic-self-jacoco'
        $coverage[':core-bar'] | Should -Be '<null>'
    }

    It 'noise fixture: consumer module does NOT inherit jacoco from registration-only references' {
        $coverage = Get-FixtureModuleCoverage -FixtureRelPath 'tests\fixtures\build-logic-noise-jacoco'
        $coverage[':core-baz'] | Should -Be '<null>'
    }

    # Parameterized regression guard — re-runs each fixture to confirm the
    # classification is stable across repeated invocations (no caching state
    # leaks between Pester examples).
    It 'fixture <Name> produces deterministic result across repeated builds' -ForEach @(
        @{ Name = 'convention'; Path = 'tests\fixtures\build-logic-convention-jacoco'; Module = ':core-foo'; Expected = 'jacoco' }
        @{ Name = 'self';       Path = 'tests\fixtures\build-logic-self-jacoco';       Module = ':core-bar'; Expected = '<null>' }
        @{ Name = 'noise';      Path = 'tests\fixtures\build-logic-noise-jacoco';      Module = ':core-baz'; Expected = '<null>' }
    ) {
        $first  = Get-FixtureModuleCoverage -FixtureRelPath $Path
        $second = Get-FixtureModuleCoverage -FixtureRelPath $Path
        $first[$Module]  | Should -Be $Expected
        $second[$Module] | Should -Be $Expected
    }
}

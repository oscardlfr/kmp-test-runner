#Requires -Modules Pester
# v0.10.2 Bug 1 — root-convention JaCoCo classification (PowerShell parity to
# tests/bats/test-root-convention-jacoco.bats).
#
# The root-convention-jacoco fixture applies JaCoCo via a ROOT build.gradle.kts
# `subprojects { apply(plugin = "jacoco") }` block — neither module references
# jacoco in its own build file. So static detection alone sees nothing
# (coveragePlugin: null), but the `gradlew tasks --all` probe (a fake gradlew.bat
# emitting canned jacocoTestReport lines) lets effectiveCoveragePlugin upgrade
# the classification to jacoco, which `describe` aggregates project-wide.

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:Fixture  = 'tests\fixtures\root-convention-jacoco'

    # Run a node ESM snippet from RepoRoot, returning trimmed stdout. The caller
    # supplies a snippet referencing the absolute fixture path via $FixtureJsPath.
    function script:Invoke-FixtureNode {
        param([string]$Snippet)
        $fixtureFull = Join-Path $script:RepoRoot $script:Fixture
        $FixtureJsPath = $fixtureFull -replace '\\', '/'
        # Clean stale caches (new + legacy dir names) so each run is deterministic.
        foreach ($d in @('.kmp-test-runner', '.kmp-test-runner-cache')) {
            $p = Join-Path $fixtureFull $d
            if (Test-Path $p) { Remove-Item -Recurse -Force $p }
        }
        $full = $Snippet.Replace('@@FIXTURE@@', $FixtureJsPath)
        $tmpFile = New-TemporaryFile
        try {
            Set-Content -Path $tmpFile -Value $full -Encoding ASCII
            Push-Location $script:RepoRoot
            try {
                $out = & node --input-type=module -e (Get-Content -Raw $tmpFile)
                if ($LASTEXITCODE -ne 0) { throw "node failed: $out" }
            } finally {
                Pop-Location
            }
        } finally {
            Remove-Item -Force $tmpFile -ErrorAction SilentlyContinue
            foreach ($d in @('.kmp-test-runner', '.kmp-test-runner-cache')) {
                $p = Join-Path $fixtureFull $d
                if (Test-Path $p) { Remove-Item -Recurse -Force $p }
            }
        }
        return ($out -join "`n").Trim()
    }
}

Describe 'root-convention JaCoCo classification (v0.10.2 Bug 1)' {

    It 'static detection alone sees no coverage (coveragePlugin null)' {
        $out = Invoke-FixtureNode @'
import { buildProjectModel } from './lib/project-model.js';
const m = buildProjectModel('@@FIXTURE@@', { skipProbe: true });
const o = {};
for (const [name, mod] of Object.entries(m.modules)) o[name] = mod.coveragePlugin ?? '<null>';
process.stdout.write(JSON.stringify(o));
'@
        $cov = $out | ConvertFrom-Json -AsHashtable
        $cov[':core-foo'] | Should -Be '<null>'
        $cov[':core-bar'] | Should -Be '<null>'
    }

    It 'probe-backed effectiveCoveragePlugin classifies jacoco' {
        $out = Invoke-FixtureNode @'
import { buildProjectModel } from './lib/project-model.js';
import { effectiveCoveragePlugin } from './lib/orchestrators/orchestrator-utils.js';
const m = buildProjectModel('@@FIXTURE@@', { skipProbe: false, useCache: false });
const o = {};
for (const [name, mod] of Object.entries(m.modules)) o[name] = effectiveCoveragePlugin(mod) ?? '<null>';
process.stdout.write(JSON.stringify(o));
'@
        $cov = $out | ConvertFrom-Json -AsHashtable
        $cov[':core-foo'] | Should -Be 'jacoco'
        $cov[':core-bar'] | Should -Be 'jacoco'
    }

    It 'describe envelope reports project-wide coverage_tool jacoco' {
        $out = Invoke-FixtureNode @'
import { runDescribe } from './lib/orchestrators/describe-orchestrator.js';
const { envelope } = runDescribe({ projectRoot: '@@FIXTURE@@', args: [] });
process.stdout.write(envelope.describe.coverage_tool);
'@
        $out | Should -Be 'jacoco'
    }
}

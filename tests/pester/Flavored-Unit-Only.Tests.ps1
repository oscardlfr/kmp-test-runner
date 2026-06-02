#Requires -Modules Pester
# Flavored unit-test source-set gap (PowerShell parity to
# tests/bats/test-flavored-unit-only.bats).
#
# The flavored-unit-only fixture's :app keeps its unit tests in src/testDemo/ +
# src/testProd/ with no bare src/test/ and no androidTest/. Static detection
# alone is blind (no tracked unit-test source set); the `gradlew tasks --all`
# probe (a fake gradlew.bat emitting flavored unit tasks) reveals
# resolved.flavors and resolves the umbrella `test`, which describe surfaces as
# unit=test (matching the dispatch umbrella :app:test).

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:Fixture  = 'tests\fixtures\flavored-unit-only'

    function script:Invoke-FixtureNode {
        param([string]$Snippet)
        $fixtureFull = Join-Path $script:RepoRoot $script:Fixture
        $FixtureJsPath = $fixtureFull -replace '\\', '/'
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

Describe 'flavored-unit-only flavored unit-test source-set gap' {

    It 'static detection alone is blind (:app no flavors, no unit source set)' {
        $out = Invoke-FixtureNode @'
import { buildProjectModel } from './lib/project-model.js';
const app = buildProjectModel('@@FIXTURE@@', { skipProbe: true }).modules[':app'];
process.stdout.write(JSON.stringify({ hasFlavor: app.hasFlavor, test: app.sourceSets.test, androidUnitTest: app.sourceSets.androidUnitTest }));
'@
        $r = $out | ConvertFrom-Json -AsHashtable
        $r.hasFlavor | Should -Be $false
        $r.test | Should -Be $false
        $r.androidUnitTest | Should -Be $false
    }

    It 'probe recovers flavors + resolves umbrella unit task on :app' {
        $out = Invoke-FixtureNode @'
import { buildProjectModel } from './lib/project-model.js';
const app = buildProjectModel('@@FIXTURE@@', { skipProbe: false, useCache: false }).modules[':app'];
process.stdout.write(JSON.stringify({ unit: app.resolved.unitTestTask, flavors: app.resolved.flavors.join('+') }));
'@
        $r = $out | ConvertFrom-Json -AsHashtable
        $r.unit | Should -Be 'test'
        $r.flavors | Should -Be 'demo+prod'
    }

    It 'describe reports unit=test on :app (matches dispatch umbrella)' {
        $out = Invoke-FixtureNode @'
import { runDescribe } from './lib/orchestrators/describe-orchestrator.js';
const { envelope } = runDescribe({ projectRoot: '@@FIXTURE@@', args: [] });
const app = envelope.describe.modules.find(x => x.name === ':app');
process.stdout.write(JSON.stringify({ unit: app.test_tasks.unit, has_flavor: app.has_flavor }));
'@
        $r = $out | ConvertFrom-Json -AsHashtable
        $r.unit | Should -Be 'test'
        $r.has_flavor | Should -Be $true
    }

    It 'true-negative :instrumented-only has no flavored unit task' {
        $out = Invoke-FixtureNode @'
import { buildProjectModel } from './lib/project-model.js';
const instr = buildProjectModel('@@FIXTURE@@', { skipProbe: false, useCache: false }).modules[':instrumented-only'];
process.stdout.write(JSON.stringify({ unit: instr.resolved.unitTestTask, flavors: instr.resolved.flavors.length }));
'@
        $r = $out | ConvertFrom-Json -AsHashtable
        $r.unit | Should -Be $null
        $r.flavors | Should -Be 0
    }
}

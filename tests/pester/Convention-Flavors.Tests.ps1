#Requires -Modules Pester
# Finding #2 — flavored androidUnit + jacoco classification (PowerShell parity to
# tests/bats/test-convention-flavors.bats).
#
# The convention-flavors fixture applies product flavors (demo/prod) + jacoco
# unit-test coverage via a ROOT build.gradle.kts `subprojects {}` convention.
# Static detection alone is blind (hasFlavor false); the `gradlew tasks --all`
# probe (a fake gradlew.bat emitting flavored unit + per-variant AGP coverage
# tasks) lets effectiveHasFlavor / effectiveCoveragePlugin recover flavors +
# jacoco, which `describe` surfaces.

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:Fixture  = 'tests\fixtures\convention-flavors'

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

Describe 'convention-flavors flavored androidUnit + jacoco (Finding #2)' {

    It 'static detection alone is blind (hasFlavor false)' {
        $out = Invoke-FixtureNode @'
import { buildProjectModel } from './lib/project-model.js';
const m = buildProjectModel('@@FIXTURE@@', { skipProbe: true });
const o = {};
for (const [name, mod] of Object.entries(m.modules)) o[name] = mod.hasFlavor ? 'flavored' : 'blind';
process.stdout.write(JSON.stringify(o));
'@
        $r = $out | ConvertFrom-Json -AsHashtable
        $r[':app'] | Should -Be 'blind'
        $r[':core-foo'] | Should -Be 'blind'
    }

    It 'probe recovers flavors + classifies jacoco' {
        $out = Invoke-FixtureNode @'
import { buildProjectModel } from './lib/project-model.js';
import { effectiveHasFlavor, effectiveCoveragePlugin, effectiveFlavors } from './lib/orchestrators/orchestrator-utils.js';
const m = buildProjectModel('@@FIXTURE@@', { skipProbe: false, useCache: false });
const o = {};
for (const [name, mod] of Object.entries(m.modules)) o[name] = `${effectiveFlavors(mod).join('+')}:${effectiveHasFlavor(mod)}:${effectiveCoveragePlugin(mod) ?? 'null'}`;
process.stdout.write(JSON.stringify(o));
'@
        $r = $out | ConvertFrom-Json -AsHashtable
        $r[':app'] | Should -Be 'demo+prod:true:jacoco'
        $r[':core-foo'] | Should -Be 'demo+prod:true:jacoco'
    }

    It 'describe reports has_flavor true + flavors' {
        $out = Invoke-FixtureNode @'
import { runDescribe } from './lib/orchestrators/describe-orchestrator.js';
const { envelope } = runDescribe({ projectRoot: '@@FIXTURE@@', args: [] });
const app = envelope.describe.modules.find(x => x.name === ':app');
process.stdout.write(JSON.stringify({ has_flavor: app.has_flavor, flavors: app.flavors.join('+') }));
'@
        $r = $out | ConvertFrom-Json -AsHashtable
        $r.has_flavor | Should -Be $true
        $r.flavors | Should -Be 'demo+prod'
    }
}

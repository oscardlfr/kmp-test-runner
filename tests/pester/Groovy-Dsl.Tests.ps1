#Requires -Modules Pester
# Groovy Gradle DSL support — PowerShell parity to tests/bats/test-groovy-dsl.bats.
#
# The groovy-dsl fixture uses Groovy settings.gradle (include ':app' plus the
# multi-arg include ':core-lib', ':data') and Groovy module build.gradle files:
# legacy apply plugin, a plugins{} kotlin.jvm block, and a short-id
# kotlin-android. The tool must discover all three modules and classify
# android / jvm / android.

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:Fixture  = 'tests\fixtures\groovy-dsl'

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

Describe 'groovy-dsl discovery + type classification' {

    It 'discovers Groovy modules and classifies types' {
        $out = Invoke-FixtureNode @'
import { buildProjectModel } from './lib/project-model.js';
const m = buildProjectModel('@@FIXTURE@@', { skipProbe: true, useCache: false });
const o = {};
for (const [name, mod] of Object.entries(m.modules)) o[name] = mod.type;
process.stdout.write(JSON.stringify(o));
'@
        $r = $out | ConvertFrom-Json -AsHashtable
        $r[':app'] | Should -Be 'android'
        $r[':core-lib'] | Should -Be 'jvm'
        $r[':data'] | Should -Be 'android'
    }

    It 'describe enumerates all three Groovy modules' {
        $out = Invoke-FixtureNode @'
import { runDescribe } from './lib/orchestrators/describe-orchestrator.js';
const { envelope } = runDescribe({ projectRoot: '@@FIXTURE@@', args: [] });
process.stdout.write(envelope.describe.modules.map(x => x.name).sort().join(','));
'@
        $out | Should -Be ':app,:core-lib,:data'
    }
}

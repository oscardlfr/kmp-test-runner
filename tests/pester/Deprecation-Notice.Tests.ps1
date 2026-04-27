#Requires -Modules Pester
# Tests for the Gradle 9 deprecation notice handling (v0.5.0 — Bug C fix).
# Verifies parallel.ps1 has the 3-branch post-test exit logic (JVM error vs
# deprecation vs per-module failures) and uses [NOTICE] Cyan for the benign
# deprecation case so cli.js parses it into warnings[] not errors[].

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:Parallel = Join-Path $script:RepoRoot 'scripts\ps1\run-parallel-coverage-suite.ps1'
    $script:ScriptText = Get-Content -Path $script:Parallel -Raw
}

Describe 'parallel.ps1: post-test exit-code 3-branch handling' {

    It 'has a JVM-level error branch (testExitCode -ne 0 -and successCount -eq 0)' {
        $script:ScriptText | Should -Match 'testExitCode -ne 0[^\n]*successCount -eq 0'
    }

    It 'JVM-level error branch uses [!] Yellow + JAVA_HOME hint' {
        $jvmBranch = ($script:ScriptText -split "elseif|^\s*if")[1]
        # The first branch (the if) covers JVM errors. Match the canonical line.
        $script:ScriptText | Should -Match '\[!\] Gradle exited with code .* and no task results found'
        $script:ScriptText | Should -Match 'JAVA_HOME, OOM, daemon crash'
    }

    It 'has a deprecation branch (testExitCode -ne 0 -and successCount -gt 0)' {
        $script:ScriptText | Should -Match 'testExitCode -ne 0[^\n]*successCount -gt 0'
    }

    It 'deprecation branch uses [NOTICE] Cyan, NOT [!] Yellow' {
        $script:ScriptText | Should -Match '\[NOTICE\] Gradle exited with code .* but all .* tasks passed individually'
        $script:ScriptText | Should -Match '\[NOTICE\][^\n]*ForegroundColor Cyan'
        # Must not contain the legacy [!] form for the deprecation message.
        $script:ScriptText | Should -Not -Match '\[!\] Gradle exited with code .* tasks passed individually'
    }

    It 'mentions Gradle 9 in the deprecation explanation' {
        $script:ScriptText | Should -Match 'Gradle 9'
    }
}

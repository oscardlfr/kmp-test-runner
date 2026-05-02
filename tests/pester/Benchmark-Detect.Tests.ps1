#Requires -Modules Pester
# Wrapper-invocation contracts for scripts/ps1/run-benchmarks.ps1.
#
# Behavioral coverage moved to tests/vitest/benchmark-orchestrator.test.js
# in v0.8 (PRODUCT.md "logic in Node, plumbing in shell"). This file's job
# is to lock the wrapper shape so the benchmark feature never re-grows
# powershell plumbing.
#
# (Filename retained for git history; the prior Get-ModuleBenchmarkPlatforms
# / Test-ModuleSupportsPlatform / Get-BenchmarkGradleTask helpers were
# deleted alongside scripts/ps1/lib/Benchmark-Detect.ps1.)

BeforeAll {
    $script:WrapperPath = Join-Path $PSScriptRoot '..\..\scripts\ps1\run-benchmarks.ps1'
    $script:Content = Get-Content -Raw -Path $script:WrapperPath
    $script:LineCount = (Get-Content -Path $script:WrapperPath).Count
}

Describe 'benchmark wrapper contract' {
    It "exec's into node lib/runner.js benchmark" {
        $script:Content | Should -Match 'node.*lib[\\/]runner\.js.*benchmark'
    }

    It "stays under 50 LOC (PRODUCT.md cap, target ~10)" {
        $script:LineCount | Should -BeLessOrEqual 50
    }

    It "uses no associative arrays (no @{}-keyed lookup patterns for state)" {
        $script:Content | Should -Not -Match '\$MODULE_STATUS|\$MODULE_BENCHMARK_COUNT|\$MODULE_AVG_SCORE'
    }

    It "passes argv through verbatim (uses @args splat)" {
        $script:Content | Should -Match '@args'
    }

    It "uses ErrorActionPreference = Stop (safe default)" {
        $script:Content | Should -Match "ErrorActionPreference\s*=\s*'Stop'"
    }

    It "propagates LASTEXITCODE so kmp-test sees the orchestrator's status" {
        $script:Content | Should -Match 'exit\s+\$LASTEXITCODE'
    }

    It "no output parsing (no Select-String / -match on gradle output piped in)" {
        $script:Content | Should -Not -Match '\| (Select-String|Where-Object|ForEach-Object)'
    }
}

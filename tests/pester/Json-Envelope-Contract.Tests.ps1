#Requires -Modules Pester
# Tests for the v0.5.1 Bug G fix: cli.js dispatches per-subcommand parsers
# that key off specific stdout markers emitted by the ps1 scripts. This file
# pins those static contracts on the Windows side — sh/ps1 parity.

BeforeAll {
    $script:RepoRoot      = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:AndroidScript = Join-Path $script:RepoRoot 'scripts\ps1\run-android-tests.ps1'
    # benchmark banners now live in lib/benchmark-orchestrator.js (Node-side
    # since v0.8 sub-entry 1). Asserting on the .ps1 wrapper would fail —
    # it's a 7-line node-launcher with no banner emission.
    $script:BenchOrchestrator = Join-Path $script:RepoRoot 'lib\benchmark-orchestrator.js'
    $script:AndroidText   = Get-Content -Path $script:AndroidScript -Raw
    $script:BenchText     = Get-Content -Path $script:BenchOrchestrator -Raw
}

Describe 'run-android-tests.ps1: parseAndroidSummary contract (Bug G)' {

    It 'emits the === JSON SUMMARY === delimiter parseAndroidSummary keys off' {
        $script:AndroidText | Should -Match '=== JSON SUMMARY ==='
    }
}

Describe 'lib/benchmark-orchestrator.js: parseBenchmarkSummary contract (Bug G)' {

    It "emits 'Result: <pass> passed, <fail> failed' tally (sh parity)" {
        # parseBenchmarkSummary in cli.js matches
        # /Result:\s*(\d+)\s+passed,\s+(\d+)\s+failed/ on stdout.
        $script:BenchText | Should -Match 'Result: \$\{totalPass\} passed, \$\{totalFail\} failed'
    }

    It "emits '[OK|FAIL] <module> (<platform>) completed|failed' per-task lines (sh parity)" {
        # parseBenchmarkSummary matches
        # /\[(OK|FAIL)\]\s+(\S+)\s+\(([\w-]+)\)\s+(completed|failed)/.
        $script:BenchText | Should -Match '\[OK\][^`]*\$\{mod\.name\} \(\$\{plat\}\) completed successfully'
        $script:BenchText | Should -Match '\[FAIL\][^`]*\$\{mod\.name\} \(\$\{plat\}\) failed with exit code'
    }
}

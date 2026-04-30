#Requires -Modules Pester
# v0.6.x Gap 2 — verify `kmp-test doctor` surfaces installed JDKs from the
# catalogue (parity to tests/bats/test-doctor.bats Gap 2 additions).

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:Cli = Join-Path $script:RepoRoot 'bin\kmp-test.js'
}

Describe 'doctor: JDK catalogue surface (v0.6.x Gap 2)' {
    It 'doctor (human) includes a "JDK catalogue" check row' {
        $output = & node $script:Cli doctor 2>&1
        # Allow exit 0 (all OK/WARN) or 3 (FAIL) — we only assert presence.
        ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 3) | Should -BeTrue
        ($output -join "`n") | Should -Match 'JDK catalogue'
    }

    It 'doctor --json: checks[] includes a "JDK catalogue" entry' {
        $raw = & node $script:Cli doctor --json 2>&1
        $jsonLine = ($raw -split "`n") | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -First 1
        $jsonLine | Should -Not -BeNullOrEmpty
        $jsonLine | Should -Match '"name":"JDK catalogue"'
    }
}

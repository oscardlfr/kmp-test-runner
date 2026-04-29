#Requires -Modules Pester
# Tests for the Gradle 9 deprecation notice handling.
# v0.5.0 (Bug C): coverage script uses [NOTICE] (not [!]) for the benign
# "gradle exited 1 but all tasks passed" case.
# v0.5.1 (Bug C'): logic extracted to Script-Utils.ps1::Invoke-GradleExitDeprecationGate
# and reused by both the test-execution AND coverage-generation passes.

BeforeAll {
    $script:RepoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:Parallel   = Join-Path $script:RepoRoot 'scripts\ps1\run-parallel-coverage-suite.ps1'
    $script:HelperPath = Join-Path $script:RepoRoot 'scripts\ps1\lib\Script-Utils.ps1'
    $script:ScriptText = Get-Content -Path $script:Parallel -Raw
    $script:HelperText = Get-Content -Path $script:HelperPath -Raw

    # Dot-source the helper for direct invocation
    . $script:HelperPath
}

Describe 'Script-Utils.ps1: Invoke-GradleExitDeprecationGate' {

    It 'is defined as a function' {
        Get-Command Invoke-GradleExitDeprecationGate -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
    }

    It 'exit 0 -> Verdict success, no Lines emitted' {
        $r = Invoke-GradleExitDeprecationGate -ExitCode 0 -SuccessCount 5 -FailureCount 0 -TotalCount 5 -Context 'tests'
        $r.Verdict | Should -Be 'success'
        $r.Lines.Count | Should -Be 0
    }

    It 'exit non-zero, all tasks passed -> Verdict success + [NOTICE] lines (deprecation)' {
        $r = Invoke-GradleExitDeprecationGate -ExitCode 1 -SuccessCount 5 -FailureCount 0 -TotalCount 5 -Context 'tests'
        $r.Verdict | Should -Be 'success'
        ($r.Lines -join "`n") | Should -Match '\[NOTICE\]'
        ($r.Lines -join "`n") | Should -Match 'tasks passed individually'
        ($r.Lines -join "`n") | Should -Match '\(tests\)'
    }

    It 'exit non-zero, zero results -> Verdict env_error + [!] lines' {
        $r = Invoke-GradleExitDeprecationGate -ExitCode 1 -SuccessCount 0 -FailureCount 0 -TotalCount 5 -Context 'tests'
        $r.Verdict | Should -Be 'env_error'
        ($r.Lines -join "`n") | Should -Match '\[!\]'
        ($r.Lines -join "`n") | Should -Match 'no task results found'
    }

    It 'exit non-zero, mixed pass/fail -> Verdict partial, no Lines' {
        $r = Invoke-GradleExitDeprecationGate -ExitCode 1 -SuccessCount 3 -FailureCount 2 -TotalCount 5 -Context 'tests'
        $r.Verdict | Should -Be 'partial'
        $r.Lines.Count | Should -Be 0
    }

    It 'context label appears in both message variants' {
        $r1 = Invoke-GradleExitDeprecationGate -ExitCode 1 -SuccessCount 4 -FailureCount 0 -TotalCount 4 -Context 'coverage'
        ($r1.Lines -join ' ') | Should -Match '\(coverage\)'
        $r2 = Invoke-GradleExitDeprecationGate -ExitCode 1 -SuccessCount 0 -FailureCount 0 -TotalCount 4 -Context 'shared coverage'
        ($r2.Lines -join ' ') | Should -Match '\(shared coverage\)'
    }
}

Describe 'parallel.ps1: gate is invoked from both test-exec AND coverage-gen passes' {

    It 'sources the Script-Utils.ps1 helper' {
        $script:ScriptText | Should -Match '\.\s+["'']?[^"'']*Script-Utils\.ps1["'']?'
    }

    It 'test-execution pass calls the gate with -Context tests' {
        $script:ScriptText | Should -Match "Invoke-GradleExitDeprecationGate[\s\S]{0,400}?-Context\s+'tests'"
    }

    It "coverage-gen (Bug C') calls the gate with -Context coverage for main project" {
        $script:ScriptText | Should -Match "Invoke-GradleExitDeprecationGate[\s\S]{0,400}?-Context\s+'coverage'"
    }

    It "coverage-gen (Bug C') calls the gate with -Context 'shared coverage' for shared-libs" {
        $script:ScriptText | Should -Match "Invoke-GradleExitDeprecationGate[\s\S]{0,400}?-Context\s+'shared coverage'"
    }

    It 'mentions Gradle 9 in the helper deprecation explanation' {
        $script:HelperText | Should -Match 'Gradle 9'
    }
}

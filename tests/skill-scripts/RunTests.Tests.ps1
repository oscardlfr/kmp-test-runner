#Requires -Modules Pester
# Smoke tests for .skills/kmp-test-runner/scripts/run-tests.ps1.
#
# Mirrors run-tests.bats: dispatcher tests cover --help short-circuit,
# unknown -Type rejection, default + custom -Type subcommand mapping, and
# the env-preamble distinction between android (fires) and unit (silent).
# kmp-test is mocked via a stub on PATH so we assert on the forwarded
# argv shape, not the orchestrator's behavior.

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot '..\..\.skills\kmp-test-runner\scripts\run-tests.ps1'
}

Describe 'run-tests.ps1 — syntax + structure' {
    It 'parses without error' {
        { [System.Management.Automation.Language.Parser]::ParseFile(
              $script:ScriptPath, [ref]$null, [ref]$null) } | Should -Not -Throw
    }

    It 'exists at the expected path' {
        Test-Path $script:ScriptPath | Should -BeTrue
    }

    It 'does not invoke npx' {
        $content = Get-Content $script:ScriptPath -Raw
        $content | Should -Not -Match '\bnpx\b'
    }
}

Describe 'run-tests.ps1 — --help / -h short-circuit' {
    It 'prints usage and exits 0 when invoked with --help' {
        $out = & pwsh -NoLogo -NoProfile -File $script:ScriptPath --help
        $LASTEXITCODE | Should -Be 0
        ($out -join "`n") | Should -Match 'Usage:'
        ($out -join "`n") | Should -Match 'unit'
        ($out -join "`n") | Should -Match 'android'
        ($out -join "`n") | Should -Match '--json'
    }

    It 'prints usage and exits 0 when invoked with -h' {
        $out = & pwsh -NoLogo -NoProfile -File $script:ScriptPath -h
        $LASTEXITCODE | Should -Be 0
        ($out -join "`n") | Should -Match 'Usage:'
    }
}

Describe 'run-tests.ps1 — argument validation' {
    It 'exits 2 with usage on stderr when -Type is unknown' {
        # Capture stderr by redirecting via *>&1 — pwsh merges streams.
        $combined = & pwsh -NoLogo -NoProfile -File $script:ScriptPath bogus 2>&1
        $LASTEXITCODE | Should -Be 2
        ($combined -join "`n") | Should -Match "unknown -Type 'bogus'"
    }
}

Describe 'run-tests.ps1 — dispatch + arg forwarding' {
    BeforeAll {
        # Stub kmp-test.cmd that echoes its argv verbatim via %*.
        # run-tests.ps1 resolves it via Get-Command 'kmp-test' -CommandType Application,
        # which finds the .cmd through PATHEXT when the temp dir is on PATH.
        $script:TmpBin = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "kmp-run-tests-$(Get-Random)")
        $script:KmpShim = Join-Path $script:TmpBin.FullName 'kmp-test.cmd'
        Set-Content -Path $script:KmpShim -Value @'
@echo off
echo STUB_KMP_TEST_ARGS: %*
exit /b 0
'@ -Encoding ASCII
        $script:OldPath = $env:PATH
        $env:PATH = "$($script:TmpBin.FullName);$($script:OldPath)"
    }

    AfterAll {
        $env:PATH = $script:OldPath
        Remove-Item -Recurse -Force $script:TmpBin.FullName -ErrorAction SilentlyContinue
    }

    It 'default -Type dispatches kmp-test parallel --json --project-root .' {
        $out = & pwsh -NoLogo -NoProfile -File $script:ScriptPath
        $LASTEXITCODE | Should -Be 0
        ($out -join "`n") | Should -Match 'STUB_KMP_TEST_ARGS: parallel --json --project-root \.'
    }

    It '-Type coverage forwards extra args verbatim after --json --project-root .' {
        $out = & pwsh -NoLogo -NoProfile -File $script:ScriptPath coverage --dry-run
        $LASTEXITCODE | Should -Be 0
        ($out -join "`n") | Should -Match 'STUB_KMP_TEST_ARGS: coverage --json --project-root \. --dry-run'
    }

    It '-Type android emits the env preamble on stderr' {
        # Pester captures the merged stream via *>&1. The [INFO] env: line
        # comes out of the script's [Console]::Error.WriteLine call.
        $combined = & pwsh -NoLogo -NoProfile -File $script:ScriptPath android 2>&1
        $LASTEXITCODE | Should -Be 0
        ($combined -join "`n") | Should -Match '\[INFO\] env:'
    }

    It '-Type unit does NOT emit the env preamble' {
        $combined = & pwsh -NoLogo -NoProfile -File $script:ScriptPath unit 2>&1
        $LASTEXITCODE | Should -Be 0
        ($combined -join "`n") | Should -Not -Match '\[INFO\] env:'
    }
}

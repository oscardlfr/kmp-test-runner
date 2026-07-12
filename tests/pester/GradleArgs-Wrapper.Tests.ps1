#Requires -Modules Pester
# PR-10 — contextual argument schema: PowerShell wrapper gradle-args handling
# and unknown-parameter robustness.
#
# Only run-parallel-coverage-suite.ps1 has a typed param() block; the other
# three wrappers (android, benchmark, changed) use bare @args passthrough and
# need no tests here.
#
# All invocations use a child pwsh process (& pwsh -NoLogo -NoProfile -File ...)
# so that $LASTEXITCODE reflects the wrapper's exit code rather than Pester's
# own process exit code.

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:Wrapper  = Join-Path $script:RepoRoot 'scripts\ps1\run-parallel-coverage-suite.ps1'

    function script:New-MinimalFixture {
        $work = Join-Path ([System.IO.Path]::GetTempPath()) ("kmp-ga-wrapper-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $work -Force | Out-Null
        Set-Content -Path (Join-Path $work 'settings.gradle.kts') -Value 'rootProject.name = "ga-wrapper-fixture"'
        # Stub gradlew.bat so no real Gradle is invoked.
        Set-Content -Path (Join-Path $work 'gradlew.bat') -Value "@echo off`r`necho BUILD SUCCESSFUL`r`nexit /b 0"
        return $work
    }
}

Describe 'GradleArgs wrapper — flag-shaped and special-char values (PR-10)' {

    It '-GradleArgs accepts a flag-shaped value (--no-parallel) without PS binding error' {
        # --no-parallel looks like a PS switch but is a Gradle arg value.
        # The wrapper receives it as the string value of -GradleArgs, not as a PS flag.
        $work = New-MinimalFixture
        try {
            $output = & pwsh -NoLogo -NoProfile -File $script:Wrapper `
                -ProjectRoot $work -GradleArgs '--no-parallel' -DryRun 2>&1
            ($output | Out-String) | Should -Not -Match 'Cannot bind argument|parameter cannot be found|ParameterBindingException'
        } finally {
            Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
        }
    }

    It '-GradleArgs preserves percent literal without expansion' {
        # PowerShell does NOT expand %VAR% syntax (unlike cmd.exe).
        # Verifies the value reaches Node intact — the string 'KMP_SHOULD_NOT_EXPAND'
        # must appear in the dry-run output, not whatever that env var might hold.
        $work = New-MinimalFixture
        try {
            $env:KMP_SHOULD_NOT_EXPAND = 'EXPANDED'
            $output = & pwsh -NoLogo -NoProfile -File $script:Wrapper `
                -ProjectRoot $work `
                -GradleArgs '-Pkmp.test.literal=%KMP_SHOULD_NOT_EXPAND%' `
                -DryRun 2>&1
            $text = $output | Out-String
            # The literal percent form must be present (not the expanded value).
            $text | Should -Match '%KMP_SHOULD_NOT_EXPAND%'
            $text | Should -Not -Match 'KMP_SHOULD_NOT_EXPAND%.*EXPANDED|EXPANDED.*%'
        } finally {
            $env:KMP_SHOULD_NOT_EXPAND = $null
            Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
        }
    }

    It '-GradleArgs with equals inside value is preserved' {
        $work = New-MinimalFixture
        try {
            $output = & pwsh -NoLogo -NoProfile -File $script:Wrapper `
                -ProjectRoot $work -GradleArgs '-Pfoo=bar=baz' -DryRun 2>&1
            ($output | Out-String) | Should -Not -Match 'Cannot bind argument|parameter cannot be found'
        } finally {
            Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
        }
    }
}

Describe 'GradleArgs wrapper — unknown parameter robustness (PR-10 $RemainingArgs)' {

    It 'absorbs unknown PS flag without "parameter cannot be found" binding error' {
        # cli.js Layer-1 gate rejects unknown flags before the wrapper is spawned in
        # normal usage. $RemainingArgs provides a safety net when the wrapper is
        # invoked directly (e.g. from runner.js or test harnesses).
        $work = New-MinimalFixture
        try {
            $output = & pwsh -NoLogo -NoProfile -File $script:Wrapper `
                -ProjectRoot $work '--no-such-wrapper-flag' -DryRun 2>&1
            ($output | Out-String) | Should -Not -Match 'parameter cannot be found|ParameterBindingException|Cannot find a parameter'
        } finally {
            Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
        }
    }
}

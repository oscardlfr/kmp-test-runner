#Requires -Modules Pester
# Smoke tests for .skills/kmp-test-runner/scripts/detect-env.ps1.
#
# Mirrors detect-env.bats: probe-only script, always exits 0, the value
# is the sentinel printed on stdout. Branches covered by mocking the
# `android` resolution via PATH manipulation.

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot '..\..\.skills\kmp-test-runner\scripts\detect-env.ps1'
}

Describe 'detect-env.ps1 — syntax + structure' {
    It 'parses without error' {
        { [System.Management.Automation.Language.Parser]::ParseFile(
              $script:ScriptPath, [ref]$null, [ref]$null) } | Should -Not -Throw
    }

    It 'exists at the expected path' {
        Test-Path $script:ScriptPath | Should -BeTrue
    }
}

Describe 'detect-env.ps1 — runtime behavior' {
    It 'exits 0 and prints one of the two sentinel values' {
        $out = & pwsh -NoLogo -NoProfile -File $script:ScriptPath
        $LASTEXITCODE | Should -Be 0
        $out | Should -BeIn @('HAS_ANDROID_CLI', 'NO_ANDROID_CLI')
    }

    It 'prints NO_ANDROID_CLI when android is not on PATH' {
        # Run in a child PowerShell with PATH limited to a temp dir that
        # has no android binary. The script's `Get-Command android` then
        # returns $null and the script takes the NO_ANDROID_CLI branch.
        # pwsh itself is invoked via its absolute path so it doesn't need
        # the (intentionally android-free) PATH to find itself.
        $tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "kmp-detect-env-$(Get-Random)")
        $pwshBin = (Get-Command pwsh).Source
        try {
            $oldPath = $env:PATH
            try {
                $env:PATH = $tmp.FullName
                $out = & $pwshBin -NoLogo -NoProfile -File $script:ScriptPath
                $LASTEXITCODE | Should -Be 0
                $out | Should -Be 'NO_ANDROID_CLI'
            } finally {
                $env:PATH = $oldPath
            }
        } finally {
            Remove-Item -Recurse -Force $tmp.FullName -ErrorAction SilentlyContinue
        }
    }

    It 'prints HAS_ANDROID_CLI when a stub android shim on PATH succeeds' {
        $tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "kmp-detect-env-$(Get-Random)")
        try {
            # Stub android.cmd: any args, exit 0 silently. .cmd is what
            # Get-Command resolves on Windows when PATHEXT includes it
            # (default on every supported Windows install).
            $stub = Join-Path $tmp.FullName 'android.cmd'
            Set-Content -Path $stub -Value "@echo off`r`nexit /b 0"
            $oldPath = $env:PATH
            try {
                $env:PATH = "$($tmp.FullName);$oldPath"
                $out = & pwsh -NoLogo -NoProfile -File $script:ScriptPath
                $LASTEXITCODE | Should -Be 0
                $out | Should -Be 'HAS_ANDROID_CLI'
            } finally {
                $env:PATH = $oldPath
            }
        } finally {
            Remove-Item -Recurse -Force $tmp.FullName -ErrorAction SilentlyContinue
        }
    }

    It 'prints NO_ANDROID_CLI when android is on PATH but `android info` fails' {
        $tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "kmp-detect-env-$(Get-Random)")
        try {
            # Stub that simulates an unconfigured android CLI: binary
            # present, info subcommand exits 1.
            $stub = Join-Path $tmp.FullName 'android.cmd'
            Set-Content -Path $stub -Value "@echo off`r`nexit /b 1"
            $oldPath = $env:PATH
            try {
                $env:PATH = "$($tmp.FullName);$oldPath"
                $out = & pwsh -NoLogo -NoProfile -File $script:ScriptPath
                $LASTEXITCODE | Should -Be 0
                $out | Should -Be 'NO_ANDROID_CLI'
            } finally {
                $env:PATH = $oldPath
            }
        } finally {
            Remove-Item -Recurse -Force $tmp.FullName -ErrorAction SilentlyContinue
        }
    }
}

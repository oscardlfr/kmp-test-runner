BeforeAll {
    # Import inside BeforeAll, not bare top-level -- see
    # Evidence1-Network-Backend-Contract.Tests.ps1's BeforeAll comment for
    # why (Pester 5 runs every file's top-level code during discovery,
    # before any file's It blocks run).
    $script:ModulePath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits/evidence1-trusted-root-config.psm1'
    Import-Module $script:ModulePath -Force
}

Describe 'Evidence1 shared trusted-root config: Get-E1DefaultTrustedRoot' {
    # This module exists so the env-var-else-historical-default decision
    # lives in exactly ONE place (output_roots trust-root portability
    # follow-up) -- evidence1-run-manifest-contract.psm1,
    # evidence1-artifact-copy-fake.psm1, and evidence1-artifact-store-fake.psm1
    # each delegate their own like-named default-resolution function to this
    # one. These tests pin the ONE underlying decision directly.

    It 'resolves to the historical C:\kmp-eval\scratch\ when EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT is not set' {
        $original = $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT
        try {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = $null
            (Get-E1DefaultTrustedRoot) | Should -BeExactly 'C:\kmp-eval\scratch\'
        } finally {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = $original
        }
    }

    It 'resolves to the historical default when the env var is set but whitespace-only' {
        $original = $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT
        try {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = '   '
            (Get-E1DefaultTrustedRoot) | Should -BeExactly 'C:\kmp-eval\scratch\'
        } finally {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = $original
        }
    }

    It 'resolves to EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT when a deployment has set it' {
        $original = $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT
        try {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = 'D:\some-other-installation\scratch\'
            (Get-E1DefaultTrustedRoot) | Should -BeExactly 'D:\some-other-installation\scratch\'
        } finally {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = $original
        }
    }

    It 'exports exactly two functions -- a pure, dependency-free leaf module, no I/O beyond reading one env var' {
        # [System.IO.Path]::GetFileNameWithoutExtension, NOT Split-Path
        # -LeafBase -- that parameter is PowerShell 6.1+ only and does not
        # exist in Windows PowerShell 5.1, this codebase's standing
        # constraint (see evidence1-phase3c-architecture-note.md section
        # 12.3 for the exact same mistake caught once already this
        # engagement).
        #
        # Grew from one export to two (real-security-property round,
        # Task 1): Get-E1HistoricalScratchRootLiteral is the new, ONE place
        # the 'C:\kmp-eval\scratch\' literal is written -- Get-E1DefaultTrustedRoot
        # (env-var-overridable) delegates to it, and so does
        # evidence1-artifact-copy-hyperv.psm1's own sealed-only
        # Get-E1ArtifactCopyRealTrustedRoot, which deliberately must NEVER
        # read $env: -- it needs a way to reach the historical literal
        # without going through the env-var-aware function at all.
        $moduleName = [System.IO.Path]::GetFileNameWithoutExtension($script:ModulePath)
        $module = Get-Module -Name $moduleName
        @($module.ExportedCommands.Keys | Sort-Object) | Should -BeExactly @('Get-E1DefaultTrustedRoot', 'Get-E1HistoricalScratchRootLiteral' | Sort-Object)
    }

    It 'Get-E1HistoricalScratchRootLiteral returns the bare historical literal, unaffected by the env var -- the sealed-path resolver''s own dependency' {
        $original = $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT
        try {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = 'D:\attacker-controlled\widen-me\'
            (Get-E1HistoricalScratchRootLiteral) | Should -BeExactly 'C:\kmp-eval\scratch\'
        } finally {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = $original
        }
    }

    It 'imports no other module in this repo (a true leaf -- consumers reach it, it reaches nothing)' {
        # Anchored to actual line-start (ignoring leading whitespace), NOT a
        # bare substring match -- a bare 'Import-Module' substring check
        # false-positives on this module's OWN header comment, which
        # legitimately talks ABOUT not importing anything (caught by
        # actually running this test, not by review: it failed against my
        # own first draft for exactly this reason).
        $source = Get-Content -LiteralPath $script:ModulePath -Raw
        $source | Should -Not -Match '(?m)^\s*Import-Module'
    }
}

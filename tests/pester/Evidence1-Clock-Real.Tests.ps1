BeforeAll {
    $script:AuditsRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits'
    $script:ModulePath = Join-Path $script:AuditsRoot 'evidence1-clock-real.psm1'
    Import-Module $script:ModulePath -Force

    # Comment-stripped source-text scan, same technique every other
    # structural-safety test in this repo uses (e.g.
    # Evidence1-Provider-Runtime-Fake.Tests.ps1) -- strips '#'-to-end-of-line
    # comments first so a file's own documentation of a forbidden token (like
    # this module's header prose) is never mistaken for the token appearing
    # in executable code.
    function Get-E1TestSourceWithoutComments([string]$Path) {
        # -ErrorAction Stop: without it, Get-Content on a missing path writes
        # a non-terminating error and returns $null under this file's
        # default $ErrorActionPreference, and `foreach ($line in $null)` is
        # a silent no-op in PowerShell -- so a missing/misnamed module would
        # make every "-Not -Match" scan below trivially, falsely PASS
        # against an empty string, rather than failing loudly. Caught by
        # actually running the RED phase and noticing 2 of 5 tests passed
        # when the module did not exist yet, not by inspection.
        $lines = Get-Content -LiteralPath $Path -ErrorAction Stop
        $stripped = foreach ($line in $lines) { ($line -replace '#.*$', '') }
        return ($stripped -join "`n")
    }
}

Describe 'Evidence1 Clock real: wraps [DateTime]::UtcNow, nothing else (overnight work order item 3)' {
    It 'returns genuine current UTC time, within a generous tolerance' {
        $before = [DateTime]::UtcNow
        $reported = Get-E1CurrentUtc
        $after = [DateTime]::UtcNow
        $reported.Kind | Should -Be ([DateTimeKind]::Utc)
        $reported | Should -BeGreaterOrEqual $before
        $reported | Should -BeLessOrEqual $after
    }

    It 'returns a fresh value on every call, never a value pinned from an earlier call' {
        $first = Get-E1CurrentUtc
        Start-Sleep -Milliseconds 20
        $second = Get-E1CurrentUtc
        $second | Should -BeGreaterThan $first
    }

    It 'exports Get-E1CurrentUtc only -- no pin/advance/reset/seed function exists in this module at all' {
        # [System.IO.Path]::GetFileNameWithoutExtension, not Split-Path
        # -LeafBase -- that parameter is PowerShell 6.1+ only and does not
        # exist in Windows PowerShell 5.1, this codebase's standing
        # constraint.
        $moduleName = [System.IO.Path]::GetFileNameWithoutExtension($script:ModulePath)
        $exported = @(Get-Command -Module $moduleName | Select-Object -ExpandProperty Name)
        $exported | Should -BeExactly @('Get-E1CurrentUtc')
    }

    It 'never calls Start-Sleep to simulate time passing' {
        $source = Get-E1TestSourceWithoutComments $script:ModulePath
        $source | Should -Not -Match 'Start-Sleep'
    }

    It 'never calls Set-Date or otherwise changes the system clock' {
        $source = Get-E1TestSourceWithoutComments $script:ModulePath
        $source | Should -Not -Match 'Set-Date'
    }
}

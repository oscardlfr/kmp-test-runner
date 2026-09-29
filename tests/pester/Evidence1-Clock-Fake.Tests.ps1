BeforeAll {
    $script:ModulePath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits/evidence1-clock-fake.psm1'
    Import-Module $script:ModulePath -Force

    # Same technique as Evidence1-Clock-Real.Tests.ps1 -- -ErrorAction Stop
    # is load-bearing (see that file's comment: without it, a missing/
    # misnamed path silently produces an empty string that trivially passes
    # every "-Not -Match" scan below).
    function Get-E1TestSourceWithoutComments([string]$Path) {
        $lines = Get-Content -LiteralPath $Path -ErrorAction Stop
        $stripped = foreach ($line in $lines) { ($line -replace '#.*$', '') }
        return ($stripped -join "`n")
    }
}

Describe 'Evidence1 fake clock' {
    AfterEach { Reset-E1FakeClockState }

    It 'returns real current time by default, within a generous tolerance' {
        $before = [DateTime]::UtcNow
        $reported = Get-E1CurrentUtc
        $after = [DateTime]::UtcNow
        $reported | Should -BeGreaterOrEqual $before
        $reported | Should -BeLessOrEqual $after
    }

    It 'returns a pinned time once set, and advances deterministically' {
        $pinned = [DateTime]::new(2026, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
        Set-E1FakeClockUtc -Utc $pinned
        (Get-E1CurrentUtc) | Should -Be $pinned
        (Get-E1CurrentUtc) | Should -Be $pinned  # still pinned, not advancing on its own

        Add-E1FakeClockDays -Days 20
        (Get-E1CurrentUtc) | Should -Be $pinned.AddDays(20)
    }

    It 'rejects a non-UTC-kind DateTime and refuses to advance before pinning' {
        { Set-E1FakeClockUtc -Utc ([DateTime]::Now) } | Should -Throw '*fake_clock_value_must_be_utc_kind*'
        { Add-E1FakeClockDays -Days 1 } | Should -Throw '*fake_clock_not_pinned_yet*'
    }

    It 'returns to real time after Reset-E1FakeClockState' {
        Set-E1FakeClockUtc -Utc ([DateTime]::new(2020, 1, 1, 0, 0, 0, [DateTimeKind]::Utc))
        Reset-E1FakeClockState
        (Get-E1CurrentUtc) | Should -BeGreaterThan ([DateTime]::new(2025, 1, 1, 0, 0, 0, [DateTimeKind]::Utc))
    }

    It 'advancing by a large number of days stays exact -- the twenty-day-equivalent rehearsal case' {
        # Regression pin, unchanged from before this round's contract
        # formalization: Phase 4 rehearsal 8 ("twenty-day-equivalent
        # fake-clock expiry/resume test") needs this to still hold exactly
        # once Get-E1CurrentUtc/Set-E1FakeClockUtc route through the new
        # contract module.
        $pinned = [DateTime]::new(2026, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
        Set-E1FakeClockUtc -Utc $pinned
        Add-E1FakeClockDays -Days 20
        (Get-E1CurrentUtc) | Should -Be ([DateTime]::new(2026, 1, 21, 0, 0, 0, [DateTimeKind]::Utc))
    }
}

Describe 'Evidence1 fake clock structural safety (overnight work order item 3)' {
    It 'never calls Start-Sleep to simulate time passing' {
        $source = Get-E1TestSourceWithoutComments $script:ModulePath
        $source | Should -Not -Match 'Start-Sleep'
    }

    It 'never calls Set-Date or otherwise changes the system clock' {
        $source = Get-E1TestSourceWithoutComments $script:ModulePath
        $source | Should -Not -Match 'Set-Date'
    }
}

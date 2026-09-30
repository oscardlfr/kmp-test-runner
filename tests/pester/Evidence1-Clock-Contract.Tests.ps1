BeforeAll {
    $script:AuditsRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits'
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-clock-contract.psm1') -Force
}

Describe 'Evidence1 Clock contract (overnight work order item 3)' {
    # ADR-S4's Clock interface has no multi-field "result" the way
    # BrokerStatus/VmState/NetworkMode/ProviderRuntimeSession do -- a single
    # value, which must always be a UTC-kind DateTime. This is the whole of
    # its contract.

    It 'accepts a genuine UTC-kind DateTime' {
        { Assert-E1ClockUtcValue ([DateTime]::UtcNow) } | Should -Not -Throw
    }

    It 'rejects $null' {
        { Assert-E1ClockUtcValue $null } | Should -Throw '*clock_value_missing*'
    }

    It 'rejects a non-DateTime value' {
        { Assert-E1ClockUtcValue '2026-01-01T00:00:00.000Z' } | Should -Throw '*clock_value_not_datetime*'
    }

    It 'rejects a Local-kind DateTime' {
        { Assert-E1ClockUtcValue ([DateTime]::Now) } | Should -Throw '*clock_value_must_be_utc_kind*'
    }

    It 'rejects an Unspecified-kind DateTime' {
        { Assert-E1ClockUtcValue ([DateTime]::new(2026, 1, 1, 0, 0, 0, [DateTimeKind]::Unspecified)) } | Should -Throw '*clock_value_must_be_utc_kind*'
    }

    It 'ConvertTo-E1ClockUtcString produces the exact shape every other *_utc field in this codebase requires' {
        $value = [DateTime]::new(2026, 3, 4, 5, 6, 7, 891, [DateTimeKind]::Utc)
        $formatted = ConvertTo-E1ClockUtcString $value
        $formatted | Should -BeExactly '2026-03-04T05:06:07.891Z'
        # Matches the same shape evidence1-run-manifest-contract.psm1's own
        # (private, unexported) Test-E1RunManifestUtcTimestamp checks --
        # written independently here rather than importing that helper,
        # since it is not part of that module's public surface and adding an
        # export there is out of scope for this item (one contract's
        # production code at a time).
        $formatted | Should -Match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    }

    It 'ConvertTo-E1ClockUtcString rejects a non-UTC value the same way Assert-E1ClockUtcValue does' {
        { ConvertTo-E1ClockUtcString ([DateTime]::Now) } | Should -Throw '*clock_value_must_be_utc_kind*'
    }
}

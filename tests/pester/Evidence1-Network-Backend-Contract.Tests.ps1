BeforeAll {
    # Import inside BeforeAll, not bare top-level. Pester 5 runs every test
    # FILE's top-level script code during its DISCOVERY pass, across ALL
    # files, before ANY file's It blocks run (confirmed empirically). Since
    # evidence1-network-backend-fake.psm1 and -hyperv.psm1 export identically
    # named functions (Get-E1NetworkState, Invoke-E1NetworkEnsureMode) -- by
    # design, so a caller can swap backends without changing call sites --
    # whichever file's top-level Import-Module happened to run LAST during
    # discovery would otherwise win globally for the entire Pester run,
    # regardless of which file's test is currently executing. BeforeAll runs
    # scoped to immediately before ITS OWN file's tests (also confirmed
    # empirically), so re-importing here reclaims the correct module right
    # before this file's own Describe blocks need it.
    $script:ContractPath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits/evidence1-network-backend-contract.psm1'
    $script:FakePath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits/evidence1-network-backend-fake.psm1'
    Import-Module $script:ContractPath -Force
    Import-Module $script:FakePath -Force
}

Describe 'Evidence1 NetworkBackend mode-result shape accepts raw hashtables, not only PSCustomObject' {
    # Regression for the same bug class as evidence1-run.ps1's own receipt shape:
    # New-E1NetworkModeResult returns a raw [ordered]@{} hashtable, and every
    # fake-mode result is exactly that, never JSON-round-tripped, before
    # Assert-E1NetworkModeResult sees it.

    It 'accepts a result exactly as New-E1NetworkModeResult returns it' {
        $result = New-E1NetworkModeResult -Mode 'offline' -VMName 'FakeVM' -VMId ([guid]::NewGuid().ToString()) `
          -AdapterConnected $false -FirewallDefaultOutbound 'Block'
        $result | Should -BeOfType [Collections.IDictionary]
        { Assert-E1NetworkModeResult $result } | Should -Not -Throw
    }

    It 'accepts a hand-built hashtable literal for each of the three real modes' {
        # [ordered]@{} is an OrderedDictionary, which has no .Clone() method
        # (unlike Hashtable) -- confirmed empirically (RuntimeException:
        # "no contiene ningun metodo llamado 'Clone'"). Each mode is built as
        # its own literal instead of copy-and-mutate.
        $offline = [ordered]@{
            schema = 1; mode = 'offline'; vm_name = 'FakeVM'; vm_id = ([guid]::NewGuid().ToString())
            adapter_connected = $false; switch_name = $null; firewall_default_outbound = 'Block'
            pinned_hosts = @(); watchdog_armed = $false; watchdog_expires_at_utc = $null
            generated_at_utc = '2026-01-01T00:00:00.000Z'; verdict = 'PASS'; reason_code = $null
        }
        { Assert-E1NetworkModeResult $offline } | Should -Not -Throw

        $authOpen = [ordered]@{
            schema = 1; mode = 'auth-open'; vm_name = 'FakeVM'; vm_id = $offline.vm_id
            adapter_connected = $true; switch_name = 'Default Switch'; firewall_default_outbound = 'Allow'
            pinned_hosts = @(); watchdog_armed = $true; watchdog_expires_at_utc = '2026-01-01T00:15:00.000Z'
            generated_at_utc = '2026-01-01T00:00:00.000Z'; verdict = 'PASS'; reason_code = $null
        }
        { Assert-E1NetworkModeResult $authOpen } | Should -Not -Throw

        $restricted = [ordered]@{
            schema = 1; mode = 'restricted'; vm_name = 'FakeVM'; vm_id = $offline.vm_id
            adapter_connected = $true; switch_name = 'Default Switch'; firewall_default_outbound = 'Block'
            pinned_hosts = @('api.anthropic.com'); watchdog_armed = $false; watchdog_expires_at_utc = $null
            generated_at_utc = '2026-01-01T00:00:00.000Z'; verdict = 'PASS'; reason_code = $null
        }
        { Assert-E1NetworkModeResult $restricted } | Should -Not -Throw
    }

    It 'still rejects a genuinely wrong shape' {
        { Assert-E1NetworkModeResult ([ordered]@{ schema = 1; mode = 'offline' }) } | Should -Throw '*network_mode_result_shape_invalid*'
    }
}

Describe 'Evidence1 NetworkBackend has exactly three modes -- closed removed' {
    # Maintainer-answered open question 2: 'closed' is not a NetworkBackend-level
    # mode. It is evidence1-run.ps1's own orchestrator state.

    It 'names exactly offline, auth-open, restricted' {
        (Get-E1NetworkModeNames | Sort-Object) -join ',' | Should -BeExactly 'auth-open,offline,restricted'
        Get-E1NetworkModeNames | Should -Not -Contain 'closed'
    }

    It 'rejects closed as an invalid mode name everywhere a mode name is validated' {
        { Get-E1NetworkTransitionPath -From 'offline' -To 'closed' } | Should -Throw '*network_mode_name_invalid*'
        { Get-E1NetworkTransitionPath -From 'closed' -To 'offline' } | Should -Throw '*network_mode_name_invalid*'
    }

    It 'computes correct hop paths across the reduced three-node graph' {
        (Get-E1NetworkTransitionPath -From 'offline' -To 'restricted') -join ',' | Should -BeExactly 'offline,restricted'
        (Get-E1NetworkTransitionPath -From 'restricted' -To 'offline') -join ',' | Should -BeExactly 'restricted,auth-open,offline'
        (Get-E1NetworkTransitionPath -From 'auth-open' -To 'restricted') -join ',' | Should -BeExactly 'auth-open,offline,restricted'
        (Get-E1NetworkTransitionPath -From 'restricted' -To 'restricted') -join ',' | Should -BeExactly 'restricted'
    }

    # Named without the literal "<->" sequence: that exact three-character
    # combination inside a Pester 5.7.1 It-block NAME (independent of the
    # test BODY -- reproduced with a trivial "1 | Should -Be 1" body) throws
    # "CommandNotFoundException: '$-' is not recognized" during test
    # execution. Confirmed minimal, isolated repro before renaming; this is a
    # Pester/tokenizer quirk around the test name string, not a bug in this
    # module or in PowerShell string interpolation generally.
    It 'no longer has a closed-adjacent edge in the allowed edge set' {
        $edges = @(Get-E1NetworkAllowedEdges | ForEach-Object { "$($_.from)->$($_.to)" })
        $edges | Should -Not -Contain 'restricted->closed'
        $edges | Should -Not -Contain 'closed->restricted'
        $edges.Count | Should -Be 4
    }
}

Describe 'Evidence1 NetworkBackend fake/hyperv signature parity' {
    # Discovered Phase 3c (architecture note open question 8): the hyperv
    # implementation always required -GuestCredentialPath; the fake did not
    # accept it at all, forcing evidence1-run.ps1 to special-case which backend
    # was active. Fixed by widening the fake to accept-and-ignore it, matching
    # evidence1-guest-bundle-fake.psm1's existing pattern for the same parameter.

    BeforeEach {
        Reset-E1FakeNetworkState
    }

    It 'accepts -GuestCredentialPath on Get-E1NetworkState without needing the file to exist' {
        Set-E1FakeNetworkInitialMode -VMName 'FakeVM' -Mode 'offline' | Out-Null
        { Get-E1NetworkState -VMName 'FakeVM' -GuestCredentialPath 'C:\does\not\exist.xml' } | Should -Not -Throw
    }

    It 'accepts -GuestCredentialPath on Invoke-E1NetworkEnsureMode and still drives the correct transition' {
        Set-E1FakeNetworkInitialMode -VMName 'FakeVM' -Mode 'offline' | Out-Null
        $result = Invoke-E1NetworkEnsureMode -VMName 'FakeVM' -GuestCredentialPath 'unused-in-fake-mode' -TargetMode 'restricted'
        $result.mode | Should -BeExactly 'restricted'
        $result.verdict | Should -BeExactly 'PASS'
    }

    It 'accepts an empty string for -GuestCredentialPath, matching how evidence1-run.ps1 calls it in fake mode' {
        # evidence1-run.ps1's $Context.GuestCredentialPath defaults to '' when
        # -UseRealBackends is not set, and Invoke-E1RunRestrictedReadyState
        # passes it through unconditionally. A Mandatory [string] parameter
        # rejects an empty-string argument by DEFAULT (Mandatory only
        # guarantees non-null/present, not non-empty) -- confirmed
        # empirically; this is why Get-E1NetworkState/Invoke-E1NetworkEnsureMode's
        # -GuestCredentialPath now carries [AllowEmptyString()].
        Set-E1FakeNetworkInitialMode -VMName 'FakeVM' -Mode 'offline' | Out-Null
        { Get-E1NetworkState -VMName 'FakeVM' -GuestCredentialPath '' } | Should -Not -Throw
    }
}

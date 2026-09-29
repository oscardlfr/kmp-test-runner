BeforeAll {
    # Import inside BeforeAll, not bare top-level -- see
    # Evidence1-Network-Backend-Contract.Tests.ps1's BeforeAll comment for
    # why (Pester 5 runs every file's top-level code during discovery,
    # before any file's It blocks; used uniformly across all Evidence1 test
    # files for consistency even where no identically-named sibling module
    # makes cross-file shadowing an active risk).
    $script:ModulePath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits/evidence1-run-state-contract.psm1'
    Import-Module $script:ModulePath -Force

    # Defined here, not bare inside the Describe block below -- a bare
    # function inside a Describe is discovery-phase-only, same as bare
    # top-level file code, and is invisible to It blocks in the run phase
    # (confirmed empirically the first time this exact mistake was made in
    # this file, this round: every It using it failed with
    # CommandNotFoundException: New-TestCampaignDescriptor, not the intended
    # RED reason -- fixed by moving it here before trusting any RED result).
    function New-TestCampaignDescriptor([hashtable]$Override = @{}) {
        $descriptor = [ordered]@{
            schema               = 1
            campaign_id          = '33333333-3333-3333-3333-333333333333'
            vm_name              = 'Evidence1FakeVM'
            vm_id                = '44444444-4444-4444-4444-444444444444'
            use_real_backends    = $false
            manifest_path        = 'C:\kmp-eval\scratch\manifest.json'
            output_roots_private = 'C:\kmp-eval\scratch\private'
            output_roots_public  = 'C:\kmp-eval\scratch\public'
            created_at_utc       = '2026-01-01T00:00:00.000Z'
        }
        foreach ($key in $Override.Keys) { $descriptor[$key] = $Override[$key] }
        return $descriptor
    }
}

Describe 'Evidence1 run-state receipt shape accepts raw hashtables, not only PSCustomObject' {
    # Regression for the bug the maintainer's first real run of evidence1-run.ps1
    # caught: New-E1RunStateReceipt returns a raw [ordered]@{} hashtable, and
    # every fake-mode capability result feeding it is ALSO a raw hashtable --
    # none of it is ever JSON-round-tripped before Assert-E1RunStateReceiptShape
    # sees it. The old implementation compared $Receipt.PSObject.Properties.Name
    # against the expected key set, which reflects a Hashtable/OrderedDictionary's
    # own .NET type members (Count, Keys, IsFixedSize, ...) rather than its
    # entries, so it rejected every receipt New-E1RunStateReceipt itself produced.

    It 'accepts a receipt exactly as New-E1RunStateReceipt returns it (never touching JSON)' {
        $receipt = New-E1RunStateReceipt -CampaignId ([guid]::NewGuid().ToString()) -StateName 'BrokerReady' -Verdict 'PASS' -Detail ([ordered]@{ ok = $true })
        $receipt | Should -BeOfType [Collections.IDictionary]
        { Assert-E1RunStateReceiptShape $receipt } | Should -Not -Throw
    }

    It 'accepts a hand-built hashtable literal with exactly the right keys' {
        $handBuilt = [ordered]@{
            schema = 1; campaign_id = ([guid]::NewGuid().ToString()); state = 'VmReady'
            verdict = 'PASS'; reason_code = $null; detail = @{ note = 'hand-built' }
            generated_at_utc = '2026-01-01T00:00:00.000Z'
        }
        { Assert-E1RunStateReceiptShape $handBuilt } | Should -Not -Throw
    }

    It 'still accepts a receipt round-tripped through JSON (PSCustomObject path)' {
        $receipt = New-E1RunStateReceipt -CampaignId ([guid]::NewGuid().ToString()) -StateName 'AuthReady' -Verdict 'FAIL' -ReasonCode 'not_authenticated'
        $roundTripped = ($receipt | ConvertTo-Json -Depth 10) | ConvertFrom-Json
        $roundTripped | Should -BeOfType [PSCustomObject]
        { Assert-E1RunStateReceiptShape $roundTripped } | Should -Not -Throw
    }

    It 'still rejects a genuinely wrong shape from either representation' {
        { Assert-E1RunStateReceiptShape ([ordered]@{ schema = 1; state = 'VmReady' }) } | Should -Throw '*run_state_receipt_shape_invalid*'
        { Assert-E1RunStateReceiptShape (([pscustomobject]@{ schema = 1; state = 'VmReady' })) } | Should -Throw '*run_state_receipt_shape_invalid*'
        { Assert-E1RunStateReceiptShape $null } | Should -Throw '*run_state_receipt_missing*'
    }

    It 'requires a reason_code on FAIL and rejects an invalid state name' {
        { New-E1RunStateReceipt -CampaignId ([guid]::NewGuid().ToString()) -StateName 'VmReady' -Verdict 'FAIL' } | Should -Throw '*run_state_receipt_fail_missing_reason*'
        { New-E1RunStateReceipt -CampaignId ([guid]::NewGuid().ToString()) -StateName 'NotARealState' -Verdict 'PASS' } | Should -Throw '*run_state_name_invalid*'
    }
}

Describe 'Evidence1 run-state graph and receipt persistence' {
    It 'names exactly the eleven ADR-S2 states with the four live-adjacent ones as a subset' {
        (Get-E1RunStateNames).Count | Should -Be 11
        Get-E1RunStateNames | Should -Contain 'DryRunPassed'
        foreach ($liveState in Get-E1RunLiveAdjacentStateNames) {
            Get-E1RunStateNames | Should -Contain $liveState
        }
        (Get-E1RunLiveAdjacentStateNames) -join ',' | Should -BeExactly 'LiveAuthorized,LiveRunning,EvidenceCopied,Closed'
    }

    It 'throws immediately and unconditionally for every live-adjacent state name' {
        foreach ($liveState in Get-E1RunLiveAdjacentStateNames) {
            { Invoke-E1RunNotYetImplementedState $liveState } | Should -Throw "*evidence1_run_state_not_yet_implemented: $liveState*"
        }
    }

    It 'writes a receipt atomically and reads it back with the shape intact' {
        $campaignRoot = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $null = New-Item -ItemType Directory -Path $campaignRoot
        $receipt = New-E1RunStateReceipt -CampaignId ([guid]::NewGuid().ToString()) -StateName 'ToolchainReady' -Verdict 'PASS' -Detail ([ordered]@{ runtimes = @('codex', 'claude') })
        Write-E1RunStateReceiptAtomically $campaignRoot $receipt
        $path = Get-E1RunStateReceiptPath $campaignRoot 'ToolchainReady'
        Test-Path -LiteralPath $path | Should -BeTrue
        (Get-ChildItem -LiteralPath $campaignRoot -Filter '*.tmp').Count | Should -Be 0

        $readBack = Read-E1RunStateReceipt $campaignRoot 'ToolchainReady'
        $readBack.state | Should -BeExactly 'ToolchainReady'
        $readBack.verdict | Should -BeExactly 'PASS'
    }

    It 'returns $null for a receipt that does not exist yet, without throwing' {
        $campaignRoot = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $null = New-Item -ItemType Directory -Path $campaignRoot
        Read-E1RunStateReceipt $campaignRoot 'VmReady' | Should -BeNullOrEmpty
    }
}

Describe 'Evidence1 campaign-identity resume matching (overnight work order item 1)' {
    # Extracted out of evidence1-run.ps1's own top-level campaign.json
    # resume-identity check (previously an inline $identityMatches boolean
    # comparing only vm_name/vm_id/use_real_backends) so it is independently
    # testable via real Pester execution against the SAME function
    # evidence1-run.ps1 now calls, not just a replica of its logic -- the
    # same extraction rationale this module's own header already states for
    # the state graph and receipt envelope. Confirmed divergence this fixes:
    # a campaign resumed (same CampaignId) against a manifest with DIFFERENT
    # output_roots than the first invocation was previously accepted
    # silently; Closed would then publish to whichever output_roots the
    # second invocation happened to supply, not the first's.

    It 'matches two identical descriptors' {
        Test-E1RunCampaignIdentityMatches (New-TestCampaignDescriptor) (New-TestCampaignDescriptor) | Should -BeTrue
    }

    It 'still rejects a vm_name/vm_id/use_real_backends mismatch (pre-existing behavior, unchanged)' {
        Test-E1RunCampaignIdentityMatches (New-TestCampaignDescriptor) (New-TestCampaignDescriptor -Override @{ vm_name = 'Other' }) | Should -BeFalse
        Test-E1RunCampaignIdentityMatches (New-TestCampaignDescriptor) (New-TestCampaignDescriptor -Override @{ vm_id = '99999999-9999-9999-9999-999999999999' }) | Should -BeFalse
        Test-E1RunCampaignIdentityMatches (New-TestCampaignDescriptor) (New-TestCampaignDescriptor -Override @{ use_real_backends = $true }) | Should -BeFalse
    }

    It 'rejects a resume whose output_roots.private differs from the first invocation' {
        Test-E1RunCampaignIdentityMatches (New-TestCampaignDescriptor) (New-TestCampaignDescriptor -Override @{ output_roots_private = 'C:\kmp-eval\scratch\different-private' }) | Should -BeFalse
    }

    It 'rejects a resume whose output_roots.public differs from the first invocation' {
        Test-E1RunCampaignIdentityMatches (New-TestCampaignDescriptor) (New-TestCampaignDescriptor -Override @{ output_roots_public = 'C:\kmp-eval\scratch\different-public' }) | Should -BeFalse
    }

    It 'matches when both descriptors have no manifest at all (output_roots both $null)' {
        Test-E1RunCampaignIdentityMatches (New-TestCampaignDescriptor -Override @{ output_roots_private = $null; output_roots_public = $null }) (New-TestCampaignDescriptor -Override @{ output_roots_private = $null; output_roots_public = $null }) | Should -BeTrue
    }

    It 'still matches after a real JSON round-trip (PSCustomObject path, the actual on-disk shape)' {
        $existing = (New-TestCampaignDescriptor | ConvertTo-Json -Depth 10) | ConvertFrom-Json
        Test-E1RunCampaignIdentityMatches $existing (New-TestCampaignDescriptor) | Should -BeTrue
    }
}

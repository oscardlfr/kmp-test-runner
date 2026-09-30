# Replicates Invoke-E1RunBrokerReadyState and Invoke-E1RunVmReadyState (evidence1-run.ps1) exactly
# for their disk-guard behavior only -- same "replicate byte-for-byte with a line-number citation"
# convention Evidence1-Run-Full-Campaign-Integration.Tests.ps1 already established for this file
# (evidence1-run.ps1 is a top-level script, not an importable module, so there is nothing to
# Import-Module here). Both real functions take an optional -GetHostDiskFreeBytes scriptblock
# specifically so this seam is testable without touching the real host disk.
#
# All real-source reads in this file resolve relative to $PSScriptRoot (repo root two levels up)
# rather than a hardcoded checkout path. A hardcoded main-checkout path would silently verify
# nothing about a work-order worktree's own copy of evidence1-run.ps1 until merge -- the
# $PSScriptRoot-relative form is correct in both worlds: it reads whichever checkout this copy of
# the test file itself is running from today, and the identical relative path keeps working once a
# worktree branch merges and the worktree itself is gone.
BeforeAll {
    New-Item -ItemType Directory -Force -Path 'TestDrive:\' | Out-Null

    $script:RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $script:RunScriptPath = Join-Path $script:RepoRoot 'evidence1-run.ps1'

    function script:Invoke-TestE1RunBrokerReadyState($Status, [scriptblock]$GetHostDiskFreeBytes, [scriptblock]$GetLocalGitCommit, [bool]$UseRealBackends = $true) {
        # evidence1-run.ps1 (P0 #1, publication hardening: broker<->HEAD coherence guard; fake-mode
        # bypass added 2026-09-30, auditor-directed -- see the real function's own updated comment)
        $status = $Status
        $hostFreeBytes = [int64](& $GetHostDiskFreeBytes)
        $hostDiskOk = $hostFreeBytes -ge 16106127360
        $localCommit = & $GetLocalGitCommit 'C:\fake-repo-root'
        $deployedCommit = [string]$status.source_git_commit
        $coherent = (-not $UseRealBackends) -or ($deployedCommit -ceq $localCommit)
        $ok = $status.task_exists -and $status.readable -and $status.self_update_capable -and $hostDiskOk -and $coherent
        $verdict = if ($ok) { 'PASS' } else { 'FAIL' }
        $reasonCode = $null
        if (-not $ok) {
            if (-not $status.task_exists) { $reasonCode = 'broker_task_not_installed' }
            elseif (-not $status.readable) { $reasonCode = 'broker_deployment_unreadable' }
            elseif (-not $status.self_update_capable) { $reasonCode = 'broker_not_self_update_capable' }
            elseif (-not $hostDiskOk) { $reasonCode = "host_disk_space_insufficient:$hostFreeBytes" }
            else { $reasonCode = 'broker_harness_incoherent' }
        }
        [ordered]@{ verdict = $verdict; reason_code = $reasonCode; host_free_bytes = $hostFreeBytes; local_git_commit = $localCommit }
    }

    # evidence1-run.ps1:540-586 (P0 #4, publication hardening: formula-based disk guard, replacing
    # the old flat 15GiB floor). -GetRequiredBytes stands in for the real function's own
    # "& $GetVhdChainInspection $Context, then Get-E1RunVmReadyRequiredDiskBytes" pair -- both
    # wrapped there in the same single try/catch, so a scriptblock that throws exercises exactly the
    # same fail-closed path regardless of which of the two real calls actually failed. The formula's
    # own arithmetic (floor/leaf-slack/Save-reservation) has exhaustive dedicated coverage in
    # Evidence1-Run-Vhd-Chain-Disk-Guard.Tests.ps1, so this replica only needs to exercise the
    # surrounding fail-closed/comparison/gate wiring, not re-derive the formula a third time.
    function script:Invoke-TestE1RunVmReadyState([scriptblock]$GetHostDiskFreeBytes, [scriptblock]$GetRequiredBytes, [scriptblock]$OnDiskOk) {
        $hostFreeBytes = [int64](& $GetHostDiskFreeBytes)
        try {
            $requiredBytes = [int64](& $GetRequiredBytes)
        } catch {
            return [ordered]@{ verdict = 'FAIL'; reason_code = 'vhd_chain_inspection_unavailable'; host_free_bytes = $hostFreeBytes; required_bytes = $null }
        }
        if ($hostFreeBytes -lt $requiredBytes) {
            return [ordered]@{ verdict = 'FAIL'; reason_code = "host_disk_space_insufficient:$hostFreeBytes"; host_free_bytes = $hostFreeBytes; required_bytes = $requiredBytes }
        }
        & $OnDiskOk
        [ordered]@{ verdict = 'PASS'; reason_code = $null; host_free_bytes = $hostFreeBytes; required_bytes = $requiredBytes }
    }

    # evidence1-run.ps1:579-585 -- the result-copy half of Invoke-E1RunVmReadyState, replicated
    # separately from Invoke-TestE1RunVmReadyState above (which only covers the disk-guard
    # decision) because this is a genuinely different bug class: $result.Keys/[$key] alone only
    # works when $result is a real Hashtable/IDictionary. The fake backend's Invoke-E1VmEnsureState
    # (evidence1-vm-state-fake.psm1) returns one in-process, never serialized -- but the real one
    # (evidence1-vm-state-queue-client.psm1) crosses the broker queue's own JSON round trip, so
    # $result comes back as a PSCustomObject. Confirmed live: the first real campaign run through
    # this state failed with "property 'Keys' not found" -- this function was never exercised
    # against that shape before, only ever tested (and only ever run for real) against the fake
    # backend's own Hashtable result. Uses the real Get-E1RunPropertyNames (imported below, not
    # reimplemented) for the dual-shape-safe key-name half, matching the actual fix exactly.
    Import-Module (Join-Path $script:RepoRoot 'docs\audits\evidence1-run-state-contract.psm1') -Force -DisableNameChecking

    function script:Invoke-TestE1RunVmReadyStateResultCopy($Result, [int64]$HostFreeBytes, [int64]$RequiredBytes) {
        # evidence1-run.ps1:579-585
        $detail = [ordered]@{}
        foreach ($key in (Get-E1RunPropertyNames $Result)) {
            $detail[$key] = if ($Result -is [Collections.IDictionary]) { $Result[$key] } else { $Result.$key }
        }
        $detail['host_free_bytes'] = $HostFreeBytes
        $detail['required_bytes'] = $RequiredBytes
        [ordered]@{ verdict = [string]$Result.verdict; reason_code = [string]$Result.reason_code; detail = $detail }
    }
}

Describe 'Invoke-E1RunBrokerReadyState disk guard' {
    It 'PASSes when the broker is healthy, coherent with HEAD, and host free space is at the 15GiB floor' {
        $status = [ordered]@{ task_exists = $true; readable = $true; self_update_capable = $true; source_git_commit = ('a' * 40) }
        $result = Invoke-TestE1RunBrokerReadyState -Status $status -GetHostDiskFreeBytes { 16106127360 } -GetLocalGitCommit { 'a' * 40 }
        $result.verdict | Should -BeExactly 'PASS'
    }

    It 'FAILs with host_disk_space_insufficient:<free> when free space is 1 byte under the floor, even though the broker itself is healthy and coherent' {
        $status = [ordered]@{ task_exists = $true; readable = $true; self_update_capable = $true; source_git_commit = ('a' * 40) }
        $result = Invoke-TestE1RunBrokerReadyState -Status $status -GetHostDiskFreeBytes { 16106127359 } -GetLocalGitCommit { 'a' * 40 }
        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -BeExactly 'host_disk_space_insufficient:16106127359'
    }

    It 'still reports the broker''s own reason first when the broker, disk, and coherence are all unhealthy' {
        $status = [ordered]@{ task_exists = $false; readable = $false; self_update_capable = $false; source_git_commit = ('a' * 40) }
        $result = Invoke-TestE1RunBrokerReadyState -Status $status -GetHostDiskFreeBytes { 0 } -GetLocalGitCommit { 'b' * 40 }
        $result.reason_code | Should -BeExactly 'broker_task_not_installed'
    }
}

# P0 #1 (publication hardening, auditor-directed): a deployed broker whose own manifest
# source_git_commit does not match this checkout's local HEAD means every later state's "verified
# against HEAD" claim (ToolchainReady's coherence check, DryRunPassed's expected-version derivation,
# and ultimately this whole closure's own SHA citation) is unearned -- -UpdateBroker simply not
# having been re-run after the last commit is exactly the gap this closes, fail-closed.
Describe 'Invoke-E1RunBrokerReadyState broker-vs-HEAD coherence guard' {
    It 'FAILs with broker_harness_incoherent when the deployed commit does not match local HEAD, even though the broker itself is healthy and disk is fine' {
        $status = [ordered]@{ task_exists = $true; readable = $true; self_update_capable = $true; source_git_commit = ('a' * 40) }
        $result = Invoke-TestE1RunBrokerReadyState -Status $status -GetHostDiskFreeBytes { 99999999999 } -GetLocalGitCommit { 'b' * 40 }
        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -BeExactly 'broker_harness_incoherent'
    }

    It 'reports disk insufficiency before coherence when both are unhealthy' {
        $status = [ordered]@{ task_exists = $true; readable = $true; self_update_capable = $true; source_git_commit = ('a' * 40) }
        $result = Invoke-TestE1RunBrokerReadyState -Status $status -GetHostDiskFreeBytes { 0 } -GetLocalGitCommit { 'b' * 40 }
        $result.reason_code | Should -BeExactly 'host_disk_space_insufficient:0'
    }

    It 'is case-sensitively exact -- an uppercase-differing commit string does not count as coherent' {
        $status = [ordered]@{ task_exists = $true; readable = $true; self_update_capable = $true; source_git_commit = ('A' * 40) }
        $result = Invoke-TestE1RunBrokerReadyState -Status $status -GetHostDiskFreeBytes { 99999999999 } -GetLocalGitCommit { 'a' * 40 }
        $result.reason_code | Should -BeExactly 'broker_harness_incoherent'
    }

    # Found live, 2026-09-30 (auditor-directed WO-A13 step 4): the first-ever fake-mode
    # evidence1-run.ps1 dispatch after this guard landed failed BrokerReady unconditionally --
    # evidence1-broker-status-fake.psm1's own default result hardcodes SourceGitCommit as
    # ('0' * 40), by explicit documented design (fake mode "must not depend on this host's real,
    # already-installed broker"), which can never equal a real local HEAD. Real mode is completely
    # unaffected -- this coherence guard's whole reason to exist only applies there.
    It 'never gates on coherence in fake mode (-UseRealBackends:$false) -- the fake broker''s placeholder commit never has to match local HEAD' {
        $status = [ordered]@{ task_exists = $true; readable = $true; self_update_capable = $true; source_git_commit = ('0' * 40) }
        $result = Invoke-TestE1RunBrokerReadyState -Status $status -GetHostDiskFreeBytes { 99999999999 } -GetLocalGitCommit { 'a' * 40 } -UseRealBackends $false
        $result.verdict | Should -BeExactly 'PASS'
    }

    It 'still gates on coherence in real mode even when explicitly passed -UseRealBackends $true' {
        $status = [ordered]@{ task_exists = $true; readable = $true; self_update_capable = $true; source_git_commit = ('0' * 40) }
        $result = Invoke-TestE1RunBrokerReadyState -Status $status -GetHostDiskFreeBytes { 99999999999 } -GetLocalGitCommit { 'a' * 40 } -UseRealBackends $true
        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -BeExactly 'broker_harness_incoherent'
    }
}

# P0 #4 (publication hardening, auditor-directed): the flat 15GiB floor never predicted Amendment
# A6's own canary-1 root cause (guest disk exhaustion from a differencing disk's real worst-case
# growth, plus an unaccounted Save-state memory reservation) -- Get-E1RunVmReadyRequiredDiskBytes
# replaces it with the principled formula, and VmReady now fails closed on top when the VHD chain
# inspection itself is unavailable rather than silently falling back to the old floor.
Describe 'Invoke-E1RunVmReadyState disk guard' {
    It 'never attempts to start the VM when host free bytes is below the required bytes' {
        $script:vmEnsureCalled = $false
        $result = Invoke-TestE1RunVmReadyState -GetHostDiskFreeBytes { 10737418240 } -GetRequiredBytes { 16106127360 } -OnDiskOk { $script:vmEnsureCalled = $true }
        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -BeExactly 'host_disk_space_insufficient:10737418240'
        $script:vmEnsureCalled | Should -BeFalse
    }

    It 'fails closed with vhd_chain_inspection_unavailable and never attempts to start the VM when the required-bytes computation throws' {
        $script:vmEnsureCalled = $false
        $result = Invoke-TestE1RunVmReadyState -GetHostDiskFreeBytes { 999999999999 } -GetRequiredBytes { throw 'vhd_chain_inspection_unavailable' } -OnDiskOk { $script:vmEnsureCalled = $true }
        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -BeExactly 'vhd_chain_inspection_unavailable'
        $script:vmEnsureCalled | Should -BeFalse
    }

    It 'proceeds to the normal VM-ensure-state path once host free bytes clears the required threshold' {
        $script:vmEnsureCalled = $false
        $result = Invoke-TestE1RunVmReadyState -GetHostDiskFreeBytes { 20000000000 } -GetRequiredBytes { 16106127360 } -OnDiskOk { $script:vmEnsureCalled = $true }
        $result.verdict | Should -BeExactly 'PASS'
        $script:vmEnsureCalled | Should -BeTrue
    }
}

Describe 'Invoke-E1RunVmReadyState result-copy (real vs. fake Invoke-E1VmEnsureState shape)' {
    It 'copies a Hashtable result (the fake backend''s own shape) without error' {
        $result = [ordered]@{ verdict = 'PASS'; reason_code = ''; vm_name = 'Evidence1-Runner-E2E'; state = 'Running' }
        $copied = Invoke-TestE1RunVmReadyStateResultCopy -Result $result -HostFreeBytes 20000000000 -RequiredBytes 16106127360
        $copied.verdict | Should -BeExactly 'PASS'
        $copied.detail.vm_name | Should -BeExactly 'Evidence1-Runner-E2E'
        $copied.detail.state | Should -BeExactly 'Running'
        $copied.detail.host_free_bytes | Should -Be 20000000000
        $copied.detail.required_bytes | Should -Be 16106127360
    }

    It 'copies a PSCustomObject result (the real queue-client backend''s own shape, after its JSON round trip) without error' {
        # Confirmed live: this is the exact shape Invoke-E1VmEnsureState returned on the first real
        # campaign run through VmReady -- ConvertFrom-Json always produces PSCustomObject, never a
        # Hashtable, regardless of what the far side originally returned.
        $result = ('{"verdict":"PASS","reason_code":"","vm_name":"Evidence1-Runner-E2E","state":"Running"}' | ConvertFrom-Json)
        $copied = Invoke-TestE1RunVmReadyStateResultCopy -Result $result -HostFreeBytes 20000000000 -RequiredBytes 16106127360
        $copied.verdict | Should -BeExactly 'PASS'
        $copied.detail.vm_name | Should -BeExactly 'Evidence1-Runner-E2E'
        $copied.detail.state | Should -BeExactly 'Running'
        $copied.detail.host_free_bytes | Should -Be 20000000000
        $copied.detail.required_bytes | Should -Be 16106127360
    }
}

Describe 'Get-E1RunHostDiskFreeBytes (real function, real evidence1-run.ps1 source)' {
    It 'is defined with the exact 16106127360-byte (15GiB) floor at exactly two real comparisons' {
        # Get-E1RunHostDiskFreeBytes itself carries no threshold -- it is a pure query. The floor is
        # compared at BrokerReady's own check and re-used as Get-E1RunVmReadyRequiredDiskBytes's own
        # Math.Max baseline (P0 #4) -- two real code occurrences. VmReady's own P0 #4 explanatory
        # comment also mentions the historical flat-floor value in prose; comments are stripped
        # before counting so this assertion stays about real comparisons, not comment wording.
        $source = Get-Content -LiteralPath $script:RunScriptPath -Raw
        $codeOnly = (($source -split "`r?`n") | ForEach-Object { $_ -replace '#.*$', '' }) -join "`n"
        $matches = [regex]::Matches($codeOnly, '16106127360')
        $matches.Count | Should -Be 2
    }

    It 'defines Get-E1RunHostDiskFreeBytes as a pure query, never a throw' {
        $source = Get-Content -LiteralPath $script:RunScriptPath -Raw
        $start = $source.IndexOf('function Get-E1RunHostDiskFreeBytes')
        $start | Should -BeGreaterThan 0
        $end = $source.IndexOf("`n}`n", $start)
        $end | Should -BeGreaterThan $start
        $body = $source.Substring($start, $end - $start)
        $body | Should -Not -Match 'throw'
        $body | Should -Match 'AvailableFreeSpace'
    }
}

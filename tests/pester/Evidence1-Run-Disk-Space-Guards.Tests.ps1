# Replicates Invoke-E1RunBrokerReadyState and Invoke-E1RunVmReadyState (evidence1-run.ps1) exactly
# for their disk-guard behavior only -- same "replicate byte-for-byte with a line-number citation"
# convention Evidence1-Run-Full-Campaign-Integration.Tests.ps1 already established for this file
# (evidence1-run.ps1 is a top-level script, not an importable module, so there is nothing to
# Import-Module here). Both real functions take an optional -GetHostDiskFreeBytes scriptblock
# specifically so this seam is testable without touching the real host disk.
BeforeAll {
    New-Item -ItemType Directory -Force -Path 'TestDrive:\' | Out-Null

    function script:Invoke-TestE1RunBrokerReadyState($Status, [scriptblock]$GetHostDiskFreeBytes) {
        # evidence1-run.ps1:423-440
        $status = $Status
        $hostFreeBytes = [int64](& $GetHostDiskFreeBytes)
        $hostDiskOk = $hostFreeBytes -ge 16106127360
        $ok = $status.task_exists -and $status.readable -and $status.self_update_capable -and $hostDiskOk
        $verdict = if ($ok) { 'PASS' } else { 'FAIL' }
        $reasonCode = $null
        if (-not $ok) {
            if (-not $status.task_exists) { $reasonCode = 'broker_task_not_installed' }
            elseif (-not $status.readable) { $reasonCode = 'broker_deployment_unreadable' }
            elseif (-not $status.self_update_capable) { $reasonCode = 'broker_not_self_update_capable' }
            else { $reasonCode = "host_disk_space_insufficient:$hostFreeBytes" }
        }
        [ordered]@{ verdict = $verdict; reason_code = $reasonCode; host_free_bytes = $hostFreeBytes }
    }

    function script:Invoke-TestE1RunVmReadyState([scriptblock]$GetHostDiskFreeBytes, [scriptblock]$OnDiskOk) {
        # evidence1-run.ps1:447-465
        $hostFreeBytes = [int64](& $GetHostDiskFreeBytes)
        if ($hostFreeBytes -lt 16106127360) {
            return [ordered]@{ verdict = 'FAIL'; reason_code = "host_disk_space_insufficient:$hostFreeBytes"; host_free_bytes = $hostFreeBytes }
        }
        & $OnDiskOk
        [ordered]@{ verdict = 'PASS'; reason_code = $null; host_free_bytes = $hostFreeBytes }
    }

    # evidence1-run.ps1:462-471 -- the result-copy half of Invoke-E1RunVmReadyState, replicated
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
    Import-Module (Join-Path 'C:\kmp-eval\agentic-eval-codex-runtime\docs\audits' 'evidence1-run-state-contract.psm1') -Force -DisableNameChecking

    function script:Invoke-TestE1RunVmReadyStateResultCopy($Result, [int64]$HostFreeBytes) {
        # evidence1-run.ps1:462-471
        $detail = [ordered]@{}
        foreach ($key in (Get-E1RunPropertyNames $Result)) {
            $detail[$key] = if ($Result -is [Collections.IDictionary]) { $Result[$key] } else { $Result.$key }
        }
        $detail['host_free_bytes'] = $HostFreeBytes
        [ordered]@{ verdict = [string]$Result.verdict; reason_code = [string]$Result.reason_code; detail = $detail }
    }
}

Describe 'Invoke-E1RunBrokerReadyState disk guard' {
    It 'PASSes when the broker is healthy and host free space is at the 15GiB floor' {
        $status = [ordered]@{ task_exists = $true; readable = $true; self_update_capable = $true }
        $result = Invoke-TestE1RunBrokerReadyState -Status $status -GetHostDiskFreeBytes { 16106127360 }
        $result.verdict | Should -BeExactly 'PASS'
    }

    It 'FAILs with host_disk_space_insufficient:<free> when free space is 1 byte under the floor, even though the broker itself is healthy' {
        $status = [ordered]@{ task_exists = $true; readable = $true; self_update_capable = $true }
        $result = Invoke-TestE1RunBrokerReadyState -Status $status -GetHostDiskFreeBytes { 16106127359 }
        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -BeExactly 'host_disk_space_insufficient:16106127359'
    }

    It 'still reports the broker''s own reason first when both the broker and disk are unhealthy' {
        $status = [ordered]@{ task_exists = $false; readable = $false; self_update_capable = $false }
        $result = Invoke-TestE1RunBrokerReadyState -Status $status -GetHostDiskFreeBytes { 0 }
        $result.reason_code | Should -BeExactly 'broker_task_not_installed'
    }
}

Describe 'Invoke-E1RunVmReadyState disk guard' {
    It 'never attempts to start the VM when host free space is below the floor' {
        $script:vmEnsureCalled = $false
        $result = Invoke-TestE1RunVmReadyState -GetHostDiskFreeBytes { 10737418240 } -OnDiskOk { $script:vmEnsureCalled = $true }
        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -BeExactly 'host_disk_space_insufficient:10737418240'
        $script:vmEnsureCalled | Should -BeFalse
    }

    It 'proceeds to the normal VM-ensure-state path once free space clears the floor' {
        $script:vmEnsureCalled = $false
        $result = Invoke-TestE1RunVmReadyState -GetHostDiskFreeBytes { 20000000000 } -OnDiskOk { $script:vmEnsureCalled = $true }
        $result.verdict | Should -BeExactly 'PASS'
        $script:vmEnsureCalled | Should -BeTrue
    }
}

Describe 'Invoke-E1RunVmReadyState result-copy (real vs. fake Invoke-E1VmEnsureState shape)' {
    It 'copies a Hashtable result (the fake backend''s own shape) without error' {
        $result = [ordered]@{ verdict = 'PASS'; reason_code = ''; vm_name = 'Evidence1-Runner-E2E'; state = 'Running' }
        $copied = Invoke-TestE1RunVmReadyStateResultCopy -Result $result -HostFreeBytes 20000000000
        $copied.verdict | Should -BeExactly 'PASS'
        $copied.detail.vm_name | Should -BeExactly 'Evidence1-Runner-E2E'
        $copied.detail.state | Should -BeExactly 'Running'
        $copied.detail.host_free_bytes | Should -Be 20000000000
    }

    It 'copies a PSCustomObject result (the real queue-client backend''s own shape, after its JSON round trip) without error' {
        # Confirmed live: this is the exact shape Invoke-E1VmEnsureState returned on the first real
        # campaign run through VmReady -- ConvertFrom-Json always produces PSCustomObject, never a
        # Hashtable, regardless of what the far side originally returned.
        $result = ('{"verdict":"PASS","reason_code":"","vm_name":"Evidence1-Runner-E2E","state":"Running"}' | ConvertFrom-Json)
        $copied = Invoke-TestE1RunVmReadyStateResultCopy -Result $result -HostFreeBytes 20000000000
        $copied.verdict | Should -BeExactly 'PASS'
        $copied.detail.vm_name | Should -BeExactly 'Evidence1-Runner-E2E'
        $copied.detail.state | Should -BeExactly 'Running'
        $copied.detail.host_free_bytes | Should -Be 20000000000
    }
}

Describe 'Get-E1RunHostDiskFreeBytes (real function, real evidence1-run.ps1 source)' {
    It 'is defined with the exact 16106127360-byte (15GiB) floor at both BrokerReady and VmReady call sites' {
        # Get-E1RunHostDiskFreeBytes itself carries no threshold -- it is a pure query; the 15GiB
        # floor is compared at each of its two callers, so exactly two occurrences, not three.
        $source = Get-Content -LiteralPath 'C:\kmp-eval\agentic-eval-codex-runtime\evidence1-run.ps1' -Raw
        $matches = [regex]::Matches($source, '16106127360')
        $matches.Count | Should -Be 2
    }

    It 'defines Get-E1RunHostDiskFreeBytes as a pure query, never a throw' {
        $source = Get-Content -LiteralPath 'C:\kmp-eval\agentic-eval-codex-runtime\evidence1-run.ps1' -Raw
        $start = $source.IndexOf('function Get-E1RunHostDiskFreeBytes')
        $start | Should -BeGreaterThan 0
        $end = $source.IndexOf('function Get-E1RunRealTransportArguments', $start)
        $body = $source.Substring($start, $end - $start)
        $body | Should -Not -Match 'throw'
        $body | Should -Match 'AvailableFreeSpace'
    }
}

# Exercises evidence1-network-backend-queue-client.psm1 end to end against a
# fake trigger playing the elevated dispatcher's part -- see
# Evidence1-Vm-State-Queue-Client.Tests.ps1's header for the shared pattern.
BeforeAll {
    $script:AuditsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\docs\audits')).Path
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-broker-capability-contract.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-broker-capability-client.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-network-backend-contract.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-network-backend-queue-client.psm1') -Force

    $script:PesterScratchRoot = 'C:\kmp-eval\scratch\pester-network-backend-queue-client-tests'
    function New-TestQueueRoot { return Join-Path $script:PesterScratchRoot ([guid]::NewGuid().ToString('N')) }

    function New-RecordingTrigger([hashtable]$Captured, [string]$Verdict, [string]$ReasonCode, $Result) {
        return {
            param($TaskName, $CapabilityRequestPath, $ResponsePath)
            $Captured.request = Get-Content -LiteralPath $CapabilityRequestPath -Raw | ConvertFrom-Json
            $response = if ($Verdict -ceq 'PASS') {
                New-E1BrokerCapabilityResponse -OperationId ([string]$Captured.request.operation_id) -Capability ([string]$Captured.request.capability) -Verdict 'PASS' -Result $Result
            } else {
                New-E1BrokerCapabilityResponse -OperationId ([string]$Captured.request.operation_id) -Capability ([string]$Captured.request.capability) -Verdict 'FAIL' -ReasonCode $ReasonCode
            }
            Write-E1BrokerCapabilityCreateNewJson $ResponsePath $response
        }.GetNewClosure()
    }
}

Describe 'evidence1-network-backend-queue-client: Get-E1NetworkState' {
    It 'submits capability network.inspect with VMName/GuestCredentialPath and returns the shaped result' {
        $queueRoot = New-TestQueueRoot
        $fakeResult = New-E1NetworkModeResult -Mode 'offline' -VMName 'Evidence1E2E' -AdapterConnected $false -FirewallDefaultOutbound 'Block'
        $captured = @{}
        $trigger = New-RecordingTrigger $captured 'PASS' $null $fakeResult
        $result = Get-E1NetworkState -VMName 'Evidence1E2E' -GuestCredentialPath 'C:\kmp-eval\scratch\cred.xml' -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $trigger
        $result.mode | Should -BeExactly 'offline'
        $captured.request.capability | Should -BeExactly 'network.inspect'
        $captured.request.arguments.GuestCredentialPath | Should -BeExactly 'C:\kmp-eval\scratch\cred.xml'
    }
}

Describe 'evidence1-network-backend-queue-client: Invoke-E1NetworkEnsureMode' {
    It 'submits capability network.ensure_mode with TargetMode and returns a fail-closed FAIL-shaped result as-is (never throws for it)' {
        $queueRoot = New-TestQueueRoot
        # A fail-closed result IS a non-null, normally-returned result from
        # evidence1-network-backend-hyperv.psm1's own Invoke-E1NetworkEnsureMode
        # (its own catch block returns a FAIL-verdict New-E1NetworkModeResult
        # rather than throwing) -- the queue-client must return it as-is, not
        # translate it into a thrown exception the way vm.ensure_state does.
        $failClosedResult = New-E1NetworkModeResult -Mode 'offline' -VMName 'Evidence1E2E' -AdapterConnected $false `
            -FirewallDefaultOutbound 'Block' -Verdict 'FAIL' -ReasonCode 'network_backend_resolve_failed: api.anthropic.com'
        $captured = @{}
        $trigger = New-RecordingTrigger $captured 'PASS' $null $failClosedResult
        $result = Invoke-E1NetworkEnsureMode -VMName 'Evidence1E2E' -GuestCredentialPath 'C:\kmp-eval\scratch\cred.xml' -TargetMode 'restricted' `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $trigger
        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -BeExactly 'network_backend_resolve_failed: api.anthropic.com'
        $captured.request.capability | Should -BeExactly 'network.ensure_mode'
        $captured.request.arguments.TargetMode | Should -BeExactly 'restricted'
    }

    It 'throws when the underlying capability genuinely could not dispatch (null result)' {
        $queueRoot = New-TestQueueRoot
        $trigger = New-RecordingTrigger @{} 'FAIL' 'network_backend_vm_must_be_running' $null
        { Invoke-E1NetworkEnsureMode -VMName 'Evidence1E2E' -GuestCredentialPath 'C:\kmp-eval\scratch\cred.xml' -TargetMode 'restricted' `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $trigger } | Should -Throw '*network_backend_vm_must_be_running*'
    }
}

AfterAll {
    if (Test-Path -LiteralPath $script:PesterScratchRoot) {
        Remove-Item -LiteralPath $script:PesterScratchRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

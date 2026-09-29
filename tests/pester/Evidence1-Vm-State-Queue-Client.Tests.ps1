# Exercises evidence1-vm-state-queue-client.psm1 end to end against a fake
# trigger that plays the elevated dispatcher's part (reads the capability
# request the client wrote, returns a scripted capability response) -- real
# request construction, real capability-name/argument mapping, and real
# response-to-result translation, with zero Hyper-V and zero real
# elevation/scheduling.
BeforeAll {
    $script:AuditsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\docs\audits')).Path
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-broker-capability-contract.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-broker-capability-client.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-vm-state-contract.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-vm-state-queue-client.psm1') -Force

    # QueueRoot must be confined under C:\kmp-eval\scratch\ (hardcoded,
    # non-overridable -- see evidence1-broker-capability-contract.psm1's own
    # header), so this uses real, uniquely-named subdirectories rather than
    # $TestDrive, cleaned up in AfterAll.
    $script:PesterScratchRoot = 'C:\kmp-eval\scratch\pester-vm-state-queue-client-tests'
    function New-TestQueueRoot { return Join-Path $script:PesterScratchRoot ([guid]::NewGuid().ToString('N')) }

    # Returns a [scriptblock] trigger that (a) records the exact capability
    # request it was handed into $CapturedRequest and (b) answers with the
    # given verdict/reason/result -- both closed over by value via
    # GetNewClosure(), so each test's trigger is independent even though
    # several tests run in the same file/session.
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

Describe 'evidence1-vm-state-queue-client: Get-E1VmState' {
    It 'submits capability vm.inspect with VMName/ExpectedVMId and returns the shaped result on PASS' {
        $queueRoot = New-TestQueueRoot
        $fakeResult = New-E1VmStateResult -VMName 'Evidence1E2E' -VMId ([guid]::NewGuid().ToString()) -State 'Off'
        $captured = @{}
        $trigger = New-RecordingTrigger $captured 'PASS' $null $fakeResult
        $result = Get-E1VmState -VMName 'Evidence1E2E' -ExpectedVMId '' -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $trigger
        $result.state | Should -BeExactly 'Off'
        $captured.request.capability | Should -BeExactly 'vm.inspect'
        $captured.request.arguments.VMName | Should -BeExactly 'Evidence1E2E'
    }

    It 'throws the reason_code when the dispatch-level result is null (the function threw broker-side)' {
        $queueRoot = New-TestQueueRoot
        $trigger = New-RecordingTrigger @{} 'FAIL' 'vm_state_identity_mismatch' $null
        { Get-E1VmState -VMName 'Evidence1E2E' -ExpectedVMId ([guid]::NewGuid().ToString()) -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $trigger } |
            Should -Throw '*vm_state_identity_mismatch*'
    }
}

Describe 'evidence1-vm-state-queue-client: Invoke-E1VmEnsureState' {
    It 'submits capability vm.ensure_state with all five declared arguments' {
        $queueRoot = New-TestQueueRoot
        $vmId = [guid]::NewGuid().ToString()
        $fakeResult = New-E1VmStateResult -VMName 'Evidence1E2E' -VMId $vmId -State 'Running'
        $captured = @{}
        $trigger = New-RecordingTrigger $captured 'PASS' $null $fakeResult
        $result = Invoke-E1VmEnsureState -VMName 'Evidence1E2E' -ExpectedVMId $vmId -TargetState 'Running' `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $trigger
        $result.state | Should -BeExactly 'Running'
        $captured.request.capability | Should -BeExactly 'vm.ensure_state'
        $captured.request.arguments.TargetState | Should -BeExactly 'Running'
        $captured.request.arguments.StopTimeoutSeconds | Should -Be 180
        $captured.request.arguments.StartTimeoutSeconds | Should -Be 120
    }

    It 'throws (never returns a FAIL-shaped result) on dispatch failure -- matching evidence1-vm-state-hyperv.psm1''s own contract' {
        $queueRoot = New-TestQueueRoot
        $trigger = New-RecordingTrigger @{} 'FAIL' 'vm_state_start_timeout' $null
        { Invoke-E1VmEnsureState -VMName 'Evidence1E2E' -ExpectedVMId ([guid]::NewGuid().ToString()) -TargetState 'Running' `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $trigger } | Should -Throw '*vm_state_start_timeout*'
    }
}

AfterAll {
    if (Test-Path -LiteralPath $script:PesterScratchRoot) {
        Remove-Item -LiteralPath $script:PesterScratchRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

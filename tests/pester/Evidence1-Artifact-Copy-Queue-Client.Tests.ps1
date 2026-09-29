# Exercises evidence1-artifact-copy-queue-client.psm1 (this round's Task 3)
# end to end against a fake trigger playing the elevated dispatcher's part --
# see Evidence1-Vm-State-Queue-Client.Tests.ps1's header for the shared
# pattern. The property unique to this file: -TrustedRoot is accepted for
# call-site compatibility but structurally cannot influence the submitted
# capability request.
BeforeAll {
    $script:AuditsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\docs\audits')).Path
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-broker-capability-contract.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-broker-capability-client.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-artifact-copy-contract.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-artifact-copy-queue-client.psm1') -Force

    $script:PesterScratchRoot = 'C:\kmp-eval\scratch\pester-artifact-copy-queue-client-tests'
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

Describe 'evidence1-artifact-copy-queue-client: Copy-E1ArtifactsReadOnly' {
    It 'validates the spec name/arguments locally before ever submitting' {
        { Copy-E1ArtifactsReadOnly -VMName 'x' -ExpectedVMId ([guid]::NewGuid().ToString()) -SpecName 'not-a-real-spec' `
            -Arguments @{} -DestinationDir 'C:\kmp-eval\scratch\out' } | Should -Throw '*artifact_copy_spec_name_invalid*'
    }

    It 'submits capability artifacts.copy_read_only WITHOUT a TrustedRoot key, regardless of what -TrustedRoot was called with' {
        $queueRoot = New-TestQueueRoot
        $fakeResult = [ordered]@{ files_copied = @('evidence1-claude-windows-isolation-attestation-stageb-v1.json') }
        $captured = @{}
        $trigger = New-RecordingTrigger $captured 'PASS' $null $fakeResult
        $vmId = [guid]::NewGuid().ToString()
        $result = Copy-E1ArtifactsReadOnly -VMName 'Evidence1E2E' -ExpectedVMId $vmId -SpecName 'final-codex-attestation' `
            -Arguments @{} -DestinationDir 'C:\kmp-eval\scratch\pester-artifact-copy-out' `
            -TrustedRoot 'C:\some\attacker\controlled\path\' `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $trigger

        @($result.files_copied).Count | Should -Be 1
        $captured.request.capability | Should -BeExactly 'artifacts.copy_read_only'
        # Structural proof, not just "it didn't obviously break": the
        # ACTUAL wire request this function submitted has no TrustedRoot
        # key at all -- Get-E1BrokerCapabilityPropertyNames enumerates
        # exactly what the request's own "arguments" object contains.
        $argumentKeys = @((Get-E1BrokerCapabilityPropertyNames $captured.request.arguments) | Sort-Object)
        $argumentKeys | Should -Not -Contain 'TrustedRoot'
        $argumentKeys | Should -Be @('Arguments', 'DestinationDir', 'ExpectedVMId', 'SpecName', 'VMName')
    }

    It 'produces the IDENTICAL wire request whether -TrustedRoot is supplied, omitted, or wildly different (true no-op, not just unused-by-convention)' {
        $queueRoot1 = New-TestQueueRoot
        $queueRoot2 = New-TestQueueRoot
        $fakeResult = [ordered]@{ files_copied = @() }
        $capturedA = @{}
        $capturedB = @{}
        $vmId = [guid]::NewGuid().ToString()

        Copy-E1ArtifactsReadOnly -VMName 'Evidence1E2E' -ExpectedVMId $vmId -SpecName 'final-codex-attestation' `
            -Arguments @{} -DestinationDir 'C:\kmp-eval\scratch\pester-artifact-copy-out-a' `
            -QueueRoot $queueRoot1 -AllowedRoot $TestDrive -TriggerTask (New-RecordingTrigger $capturedA 'PASS' $null $fakeResult) | Out-Null
        Copy-E1ArtifactsReadOnly -VMName 'Evidence1E2E' -ExpectedVMId $vmId -SpecName 'final-codex-attestation' `
            -Arguments @{} -DestinationDir 'C:\kmp-eval\scratch\pester-artifact-copy-out-a' `
            -TrustedRoot 'C:\totally\different\root\' `
            -QueueRoot $queueRoot2 -AllowedRoot $TestDrive -TriggerTask (New-RecordingTrigger $capturedB 'PASS' $null $fakeResult) | Out-Null

        ($capturedA.request.arguments | ConvertTo-Json -Depth 10) | Should -BeExactly ($capturedB.request.arguments | ConvertTo-Json -Depth 10)
    }

    It 'throws when the dispatch-level result is null (matching evidence1-artifact-copy-hyperv.psm1''s own always-throw-on-failure contract)' {
        $queueRoot = New-TestQueueRoot
        $trigger = New-RecordingTrigger @{} 'FAIL' 'artifact_copy_required_source_missing: evidence1-claude-windows-isolation-attestation-stageb-v1.json' $null
        { Copy-E1ArtifactsReadOnly -VMName 'Evidence1E2E' -ExpectedVMId ([guid]::NewGuid().ToString()) -SpecName 'final-codex-attestation' `
            -Arguments @{} -DestinationDir 'C:\kmp-eval\scratch\pester-artifact-copy-out-b' `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $trigger } | Should -Throw '*artifact_copy_required_source_missing*'
    }
}

AfterAll {
    if (Test-Path -LiteralPath $script:PesterScratchRoot) {
        Remove-Item -LiteralPath $script:PesterScratchRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

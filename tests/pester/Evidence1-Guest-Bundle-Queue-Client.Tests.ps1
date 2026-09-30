# Exercises evidence1-guest-bundle-queue-client.psm1 end to end against a
# fake trigger playing the elevated dispatcher's part -- see
# Evidence1-Vm-State-Queue-Client.Tests.ps1's header for the shared pattern.
BeforeAll {
    $script:AuditsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\docs\audits')).Path
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-broker-capability-contract.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-broker-capability-client.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-guest-bundle-contract.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-guest-bundle-queue-client.psm1') -Force

    $script:PesterScratchRoot = 'C:\kmp-eval\scratch\pester-guest-bundle-queue-client-tests'
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

Describe 'evidence1-guest-bundle-queue-client: Invoke-E1GuestBundle' {
    It 'validates the bundle name/arguments locally before ever submitting (fails fast, same contract as the hyperv sibling)' {
        { Invoke-E1GuestBundle -VMName 'x' -GuestCredentialPath 'C:\kmp-eval\scratch\cred.xml' -BundleName 'not-a-real-bundle' -Arguments @{} } |
            Should -Throw '*guest_bundle_name_invalid*'
    }

    It 'submits capability guest.invoke_bundle with the bundle name/arguments/timeout and returns the shaped result' {
        $queueRoot = New-TestQueueRoot
        $fakeOutput = [ordered]@{ command_found = $true; version_text = 'codex 0.154.0'; login_status_exit_code = 0 }
        $fakeResult = [ordered]@{
            schema = 1; bundle_name = 'get-cli-version-and-login-status'; vm_name = 'Evidence1E2E'; vm_id = $null
            logon_name_used = $null; verdict = 'PASS'; reason_code = $null; output = $fakeOutput
            generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        }
        $captured = @{}
        $trigger = New-RecordingTrigger $captured 'PASS' $null $fakeResult
        $bundleArguments = @{ CommandPath = 'C:\Evidence1Toolchain\codex-cli\0.154.0\bin\codex.exe'; LoginStatusArgs = [string[]]@('login', 'status') }
        $result = Invoke-E1GuestBundle -VMName 'Evidence1E2E' -GuestCredentialPath 'C:\kmp-eval\scratch\cred.xml' `
            -BundleName 'get-cli-version-and-login-status' -Arguments $bundleArguments `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $trigger
        $result.output.command_found | Should -BeTrue
        $captured.request.capability | Should -BeExactly 'guest.invoke_bundle'
        $captured.request.arguments.BundleName | Should -BeExactly 'get-cli-version-and-login-status'
        $captured.request.arguments.Arguments.CommandPath | Should -BeExactly 'C:\Evidence1Toolchain\codex-cli\0.154.0\bin\codex.exe'
    }

    It 'throws when the dispatch-level result is null' {
        $queueRoot = New-TestQueueRoot
        $trigger = New-RecordingTrigger @{} 'FAIL' 'guest_bundle_timed_out' $null
        { Invoke-E1GuestBundle -VMName 'Evidence1E2E' -GuestCredentialPath 'C:\kmp-eval\scratch\cred.xml' `
            -BundleName 'get-firewall-sealed-state' -Arguments @{} `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $trigger } | Should -Throw '*guest_bundle_timed_out*'
    }

    It 'carries a manifest-scale guest transport timeout under the broker queue ceiling' {
        $queueRoot = New-TestQueueRoot
        $fakeResult = [ordered]@{ schema = 1; bundle_name = 'get-firewall-sealed-state'; vm_name = 'Evidence1E2E'; vm_id = $null; logon_name_used = $null; verdict = 'PASS'; reason_code = $null; output = [ordered]@{ sealed = $true }; generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
        $captured = @{}
        $trigger = New-RecordingTrigger $captured 'PASS' $null $fakeResult
        $result = Invoke-E1GuestBundle -VMName 'Evidence1E2E' -GuestCredentialPath 'C:\\kmp-eval\\scratch\\cred.xml' -BundleName 'get-firewall-sealed-state' -Arguments @{} -TimeoutSeconds 1020 -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $trigger
        $result.verdict | Should -BeExactly 'PASS'
        $captured.request.arguments.TimeoutSeconds | Should -Be 1020
        1020 | Should -BeLessThan ((Get-E1BrokerCapabilityDefaultTimeoutMinutes) * 60)
    }
}

AfterAll {
    if (Test-Path -LiteralPath $script:PesterScratchRoot) {
        Remove-Item -LiteralPath $script:PesterScratchRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

BeforeAll {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    $auditsRoot = Join-Path $repoRoot 'docs/audits'
    Import-Module (Join-Path $auditsRoot 'evidence1-provider-runtime-contract.psm1') -Force
    Import-Module (Join-Path $auditsRoot 'evidence1-run-state-contract.psm1') -Force

    # The script has a top-level state walk and cannot be dot-sourced in a unit
    # test. Extract its production handler without running any VM operation.
    $source = (Get-Content -LiteralPath (Join-Path $repoRoot 'evidence1-run.ps1') -Raw) -replace "`r`n", "`n"
    $start = $source.IndexOf('function Invoke-E1RunLiveRunningState')
    if ($start -lt 0) { throw 'LiveRunning handler not found' }
    $end = $source.IndexOf("`n}`n", $start)
    if ($end -lt 0) { throw 'LiveRunning handler terminator not found' }
    Invoke-Expression ($source.Substring($start, $end - $start + 2))
    foreach ($name in @('Invoke-E1RunFailureSafeClosureAttempt', 'Invoke-E1RunFailureSafeEvidenceCopyAttempt')) {
        $start = $source.IndexOf("function $name")
        if ($start -lt 0) { throw "$name not found" }
        $end = $source.IndexOf("`n}`n", $start)
        if ($end -lt 0) { throw "$name terminator not found" }
        Invoke-Expression ($source.Substring($start, $end - $start + 2))
    }

    function Get-E1RunManifestExpectedCells($Manifest) {
        return @(
            [ordered]@{runtime_id='codex-cli';model_id='model';round_index=0;campaign_cell_index=0;condition='product'}
            [ordered]@{runtime_id='codex-cli';model_id='model';round_index=1;campaign_cell_index=1;condition='free'}
            [ordered]@{runtime_id='codex-cli';model_id='model';round_index=2;campaign_cell_index=2;condition='product'}
        )
    }
    function Get-E1RunRealTransportArguments { return @{} }
    function Get-E1SafeBenchmarkStatus($OutputSummary) { return [string]$OutputSummary.benchmark_status }
    function New-TestSession([int]$RoundIndex, [string]$ReasonCode, $OutputSummary) {
        $verdict = if ($ReasonCode) { 'FAIL' } else { 'PASS' }
        return New-E1ProviderRuntimeSessionResult -RuntimeId 'codex-cli' -ModelId 'model' -RoundIndex $RoundIndex `
            -SessionId "session-$RoundIndex" -StartedAtUtc '2026-01-01T00:00:00.000Z' `
            -CompletedAtUtc '2026-01-01T00:00:01.000Z' -ExitCode $(if ($ReasonCode) { 1 } else { 0 }) `
            -Verdict $verdict -ReasonCode $ReasonCode -OutputSummary $OutputSummary
    }
}

Describe 'post-dispatch transport loss aborts a live block' {
    It 'returns a failed partial receipt before dispatching the next cell' {
        $script:dispatchCalls = 0
        function Invoke-E1ProviderRuntimeSession {
            param($CurrentCampaignInputs,$Cell,$VMName,$GuestCredentialPath)
            $script:dispatchCalls++
            if ($script:dispatchCalls -gt 1) { throw 'unsafe_second_dispatch' }
            return New-TestSession 0 'post_dispatch_transport_phase_unknown' ([ordered]@{
                transport_boundary = 'job_issued'; inference_phase = 'unknown'; worker_output_present = $false
            })
        }
        $context = [ordered]@{ UseRealBackends=$true; Manifest=@{}; CampaignId='11111111-1111-1111-1111-111111111111';
            CurrentCampaignInputs=@{}; VMName='test-vm'; GuestCredentialPath='C:\fake.xml' }
        $receipt = Invoke-E1RunLiveRunningState $context
        $receipt.verdict | Should -BeExactly 'FAIL'
        $receipt.reason_code | Should -BeExactly 'post_dispatch_transport_phase_unknown'
        $receipt.detail.cell_count | Should -Be 3
        @($receipt.detail.sessions).Count | Should -Be 1
        $receipt.detail.next_cell_not_dispatched | Should -BeTrue
        $script:dispatchCalls | Should -Be 1
    }

    It 'does not use the early-abort path for an ordinary worker failure' {
        $script:dispatchCalls = 0
        function Invoke-E1ProviderRuntimeSession {
            param($CurrentCampaignInputs,$Cell,$VMName,$GuestCredentialPath)
            $script:dispatchCalls++
            if ($script:dispatchCalls -eq 1) { return New-TestSession 0 'provider_runtime_real_worker_failed' ([ordered]@{worker_output_present=$false}) }
            return New-TestSession ([int]$Cell.round_index) $null ([ordered]@{benchmark_status='accepted'})
        }
        $context = [ordered]@{ UseRealBackends=$true; Manifest=@{}; CampaignId='11111111-1111-1111-1111-111111111111';
            CurrentCampaignInputs=@{}; VMName='test-vm'; GuestCredentialPath='C:\fake.xml' }
        $receipt = Invoke-E1RunLiveRunningState $context
        $receipt.verdict | Should -BeExactly 'FAIL'
        $receipt.reason_code | Should -BeExactly 'one_or_more_provider_sessions_failed'
        @($receipt.detail.sessions).Count | Should -Be 3
        $script:dispatchCalls | Should -Be 3
    }

    It 'closes network and VM then copies completed evidence from a failed partial block' {
        $script:dispatchCalls = 0
        function Invoke-E1ProviderRuntimeSession {
            param($CurrentCampaignInputs,$Cell,$VMName,$GuestCredentialPath)
            $script:dispatchCalls++
            if ($script:dispatchCalls -eq 1) { return New-TestSession 0 $null ([ordered]@{benchmark_status='accepted'}) }
            if ($script:dispatchCalls -eq 2) {
                return New-TestSession 1 'post_dispatch_transport_phase_unknown' ([ordered]@{
                    transport_boundary='job_issued'; inference_phase='unknown'; worker_output_present=$false
                })
            }
            throw 'unsafe_third_dispatch'
        }
        $context = [ordered]@{ UseRealBackends=$true; Manifest=([ordered]@{private_root='C:\Evidence1Private\campaigns';campaign_id='11111111-1111-1111-1111-111111111111'});
            CampaignId='11111111-1111-1111-1111-111111111111'; CampaignRoot=(Join-Path $TestDrive 'campaign');
            CurrentCampaignInputs=@{}; VMName='test-vm'; VMId='11111111-1111-1111-1111-111111111111';
            GuestCredentialPath='C:\fake.xml'; OutputRootsTrustedRoot=$TestDrive }
        $script:partialReceipt = Invoke-E1RunLiveRunningState $context
        $script:partialReceipt.verdict | Should -BeExactly 'FAIL'
        @($script:partialReceipt.detail.sessions).Count | Should -Be 2
        $script:dispatchCalls | Should -Be 2

        $script:closureCalls = @()
        function Invoke-E1NetworkEnsureMode {
            param($VMName,$GuestCredentialPath,$TargetMode,$TimeoutMinutes)
            $script:closureCalls += "network:$TargetMode"
            return [ordered]@{verdict='PASS'}
        }
        function Invoke-E1VmEnsureState {
            param($VMName,$ExpectedVMId,$TargetState,$TimeoutMinutes)
            $script:closureCalls += "vm:$TargetState"
            return [ordered]@{verdict='PASS'}
        }
        function Read-E1RunStateReceipt { param($CampaignRoot,$StateName) return $script:partialReceipt }
        function ConvertTo-E1RunGuestRelativePath { param($Path) return 'private/campaign' }
        function Assert-E1ArtifactCopyResultShape { param($SpecName,$Result) }
        function Copy-E1ArtifactsReadOnly {
            param($VMName,$ExpectedVMId,$SpecName,$Arguments,$DestinationDir,$TrustedRoot,$TimeoutMinutes)
            $script:closureCalls += "copy:$($Arguments.CellKey)"
            if ([string]$Arguments.CellKey -cne 'codex-cli-0') { throw 'record_not_present' }
            return [ordered]@{files_copied=@('record.json','audit.json')}
        }
        $closure = Invoke-E1RunFailureSafeClosureAttempt $context
        $script:closureCalls[0] | Should -BeExactly 'network:offline'
        $script:closureCalls[1] | Should -BeExactly 'vm:Off'
        $closure.vm_result.verdict | Should -BeExactly 'PASS'
        $closure.evidence_copy.tier | Should -BeExactly 'best_effort_session_record_only'
        @($closure.evidence_copy.results | Where-Object verdict -EQ 'PASS').Count | Should -Be 1
        @($closure.evidence_copy.results | Where-Object verdict -EQ 'FAIL').Count | Should -Be 2
        $closure.evidence_copy.results[0].cell_key | Should -BeExactly 'codex-cli-0'
        $script:closureCalls | Should -Contain 'copy:codex-cli-0'
        $script:closureCalls | Should -Contain 'copy:codex-cli-1'
        $script:closureCalls | Should -Contain 'copy:codex-cli-2'
        $source = Get-Content -LiteralPath (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'evidence1-run.ps1') -Raw
        $source | Should -Match '\$Report\.failure_safe_closure = Invoke-E1RunFailureSafeClosureAttempt \$Context'
    }
}

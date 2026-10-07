BeforeAll {
  $script:Docs = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits'
  Import-Module (Join-Path $script:Docs 'evidence1-provider-runtime-contract.psm1') -Force
  Import-Module (Join-Path $script:Docs 'evidence1-provider-runtime-real.psm1') -Force
  function New-TestInputs { [ordered]@{ campaign_id='11111111-1111-1111-1111-111111111111'; scenario_id='coverage-threshold-failure-v2'; seed=-17; provider_timeout_seconds=900; worker_timeout_seconds=960; guest_transport_timeout_seconds=1020; provider_mode='fake'; harness_dir='C:\kmp-eval\harness'; source_template_dir='C:\kmp-eval\source'; runtimes=@([ordered]@{runtime_id='codex-cli';model_id='gpt-5.6-terra';campaign_design_id='codex-product-vs-free-baseline-v1';campaign_cell_indices=@(5);max_budget_usd=$null}) } }
  function New-TestCell { [ordered]@{runtime_id='codex-cli';model_id='gpt-5.6-terra';campaign_design_id='codex-product-vs-free-baseline-v1';campaign_cell_index=5;round_index=0;condition='product'} }
  function New-TestSession { New-E1ProviderRuntimeSessionResult -RuntimeId 'codex-cli' -ModelId 'gpt-5.6-terra' -RoundIndex 0 -SessionId 'session' -StartedAtUtc '2026-01-01T00:00:00.000Z' -CompletedAtUtc '2026-01-01T00:00:00.001Z' -ExitCode 0 -Verdict PASS -OutputSummary ([ordered]@{record_count=1}) }
}
Describe 'Evidence1 ProviderRuntime real canonical worker dispatch' {
  It 'binds the production default to the explicitly imported queue-client module' {
    InModuleScope evidence1-provider-runtime-real {
      $script:E1ProviderRuntimeGuestBundleModule.Name | Should -BeExactly 'evidence1-guest-bundle-queue-client'
      $script:E1ProviderRuntimeDefaultGuestBundle | Should -BeOfType ([scriptblock])
    }
  }
  It 'serializes current inputs and the explicit cell into the closed internal bundle' {
    $captured=@{};$session=New-TestSession
    $fake={param($VMName,$GuestCredentialPath,$BundleName,$Arguments,$TimeoutSeconds,$QueueRoot,$AllowedRoot,$TaskName,$TimeoutMinutes,$PollIntervalSeconds,$TriggerTask,$GetUtcNow);$captured.bundle=$BundleName;$captured.arguments=$Arguments;$captured.timeout=$TimeoutSeconds;[ordered]@{verdict='PASS';output=$session}}.GetNewClosure()
    $result=Invoke-E1ProviderRuntimeSession -CurrentCampaignInputs (New-TestInputs) -Cell (New-TestCell) -VMName 'Evidence1E2E' -GuestCredentialPath 'C:\fake.xml' -QueueRoot 'C:\queue' -AllowedRoot 'C:\allowed' -TriggerTask {} -InvokeGuestBundle $fake
    $result.session_id|Should -BeExactly 'session';$captured.bundle|Should -BeExactly 'run-agentic-eval-session';$captured.timeout|Should -Be 1020
    ($captured.arguments.CurrentCampaignInputsJson|ConvertFrom-Json).seed|Should -Be -17
    ($captured.arguments.CellJson|ConvertFrom-Json).campaign_cell_index|Should -Be 5
  }
  It 'returns a shaped FAIL when the bundle envelope fails, so LiveRunning can continue' {
    $fake={ [ordered]@{verdict='FAIL';output=$null} }
    $result=Invoke-E1ProviderRuntimeSession -CurrentCampaignInputs (New-TestInputs) -Cell (New-TestCell) -VMName 'Evidence1E2E' -GuestCredentialPath 'C:\fake.xml' -QueueRoot 'C:\queue' -AllowedRoot 'C:\allowed' -TriggerTask {} -InvokeGuestBundle $fake
    $result.verdict|Should -BeExactly 'FAIL';$result.reason_code|Should -BeExactly 'provider_runtime_real_worker_failed'
    {Assert-E1ProviderRuntimeSessionResult $result}|Should -Not -Throw
  }
  It 'propagates the guest bundle''s own verdict, reason_code and output instead of discarding them' {
    # 2026-09-29 (WO-A2 auditor finding): confirmed live -- 4/4 real LiveRunning
    # sessions FAILed with reason_code provider_runtime_real_worker_failed and
    # nothing else, because this branch used to hard-code worker_output_present
    # = $false and nothing more. This asserts the specific fields that finding
    # required; it fails under the pre-fix code (that shape never existed).
    $fake={ [ordered]@{verdict='FAIL';reason_code='guest_worker_specific_reason';output=[ordered]@{diagnostic_detail='xyz'}} }
    $result=Invoke-E1ProviderRuntimeSession -CurrentCampaignInputs (New-TestInputs) -Cell (New-TestCell) -VMName 'Evidence1E2E' -GuestCredentialPath 'C:\fake.xml' -QueueRoot 'C:\queue' -AllowedRoot 'C:\allowed' -TriggerTask {} -InvokeGuestBundle $fake
    $result.reason_code|Should -BeExactly 'provider_runtime_real_worker_failed'
    $result.output_summary.guest_bundle_result_present|Should -BeTrue
    $result.output_summary.guest_bundle_verdict|Should -BeExactly 'FAIL'
    $result.output_summary.guest_bundle_reason_code|Should -BeExactly 'guest_worker_specific_reason'
    ($result.output_summary.guest_bundle_output_json|ConvertFrom-Json).diagnostic_detail|Should -BeExactly 'xyz'
  }
  It 'classifies the post-job transport loss as a failed session with unknown phase' {
    $fake={ [ordered]@{verdict='FAIL';reason_code='guest_bundle_transport_unknown_after_dispatch: socket lost';output=$null} }
    $result=Invoke-E1ProviderRuntimeSession -CurrentCampaignInputs (New-TestInputs) -Cell (New-TestCell) -VMName 'Evidence1E2E' -GuestCredentialPath 'C:\fake.xml' -QueueRoot 'C:\queue' -AllowedRoot 'C:\allowed' -TriggerTask {} -InvokeGuestBundle $fake
    $result.reason_code|Should -BeExactly 'post_dispatch_transport_phase_unknown'
    $result.output_summary.transport_boundary|Should -BeExactly 'job_issued'
    $result.output_summary.inference_phase|Should -BeExactly 'unknown'
    $result.output_summary.worker_output_present|Should -BeFalse
  }
  It 'stamps real elapsed start/complete times for a worker-failed result, not two identical UtcNow calls' {
    $fake={ Start-Sleep -Milliseconds 30; [ordered]@{verdict='FAIL';output=$null} }
    $result=Invoke-E1ProviderRuntimeSession -CurrentCampaignInputs (New-TestInputs) -Cell (New-TestCell) -VMName 'Evidence1E2E' -GuestCredentialPath 'C:\fake.xml' -QueueRoot 'C:\queue' -AllowedRoot 'C:\allowed' -TriggerTask {} -InvokeGuestBundle $fake
    ([DateTime]$result.completed_at_utc)|Should -BeGreaterThan ([DateTime]$result.started_at_utc)
  }
  It 'returns a shaped FAIL when the guest-bundle seam throws' {
    $fake={ throw 'queue_transport_unavailable' }
    $result=Invoke-E1ProviderRuntimeSession -CurrentCampaignInputs (New-TestInputs) -Cell (New-TestCell) -VMName 'Evidence1E2E' -GuestCredentialPath 'C:\fake.xml' -QueueRoot 'C:\queue' -AllowedRoot 'C:\allowed' -TriggerTask {} -InvokeGuestBundle $fake
    $result.verdict|Should -BeExactly 'FAIL';$result.reason_code|Should -BeExactly 'provider_runtime_real_guest_bundle_call_failed'
    {Assert-E1ProviderRuntimeSessionResult $result}|Should -Not -Throw
    $result.output_summary.guest_bundle_call_exception_message|Should -BeExactly 'queue_transport_unavailable'
  }
  It 'stamps real elapsed start/complete times when the guest-bundle seam throws' {
    $fake={ Start-Sleep -Milliseconds 30; throw 'queue_transport_unavailable' }
    $result=Invoke-E1ProviderRuntimeSession -CurrentCampaignInputs (New-TestInputs) -Cell (New-TestCell) -VMName 'Evidence1E2E' -GuestCredentialPath 'C:\fake.xml' -QueueRoot 'C:\queue' -AllowedRoot 'C:\allowed' -TriggerTask {} -InvokeGuestBundle $fake
    ([DateTime]$result.completed_at_utc)|Should -BeGreaterThan ([DateTime]$result.started_at_utc)
  }
  It 'rejects a worker result whose identity does not match the requested cell' {
    $wrong=New-E1ProviderRuntimeSessionResult -RuntimeId 'claude-code' -ModelId 'claude-sonnet-5' -RoundIndex 0 -SessionId 'wrong' -StartedAtUtc '2026-01-01T00:00:00.000Z' -CompletedAtUtc '2026-01-01T00:00:00.001Z' -ExitCode 0 -Verdict PASS -OutputSummary ([ordered]@{record_count=1})
    $fake={ [ordered]@{verdict='PASS';output=$wrong} }.GetNewClosure()
    { Invoke-E1ProviderRuntimeSession -CurrentCampaignInputs (New-TestInputs) -Cell (New-TestCell) -VMName 'Evidence1E2E' -GuestCredentialPath 'C:\fake.xml' -QueueRoot 'C:\queue' -AllowedRoot 'C:\allowed' -TriggerTask {} -InvokeGuestBundle $fake } | Should -Throw '*provider_runtime_real_worker_identity_mismatch*'
  }
  It 'fails before the guest seam when queue root or trigger task is absent' {
    $notCalled={ throw 'guest_seam_must_not_be_called' }
    { Invoke-E1ProviderRuntimeSession -CurrentCampaignInputs (New-TestInputs) -Cell (New-TestCell) -VMName 'Evidence1E2E' -GuestCredentialPath 'C:\fake.xml' -AllowedRoot 'C:\allowed' -TriggerTask {} -InvokeGuestBundle $notCalled } | Should -Throw '*provider_runtime_real_queue_root_required*'
    { Invoke-E1ProviderRuntimeSession -CurrentCampaignInputs (New-TestInputs) -Cell (New-TestCell) -VMName 'Evidence1E2E' -GuestCredentialPath 'C:\fake.xml' -QueueRoot 'C:\queue' -AllowedRoot 'C:\allowed' -InvokeGuestBundle $notCalled } | Should -Throw '*provider_runtime_real_trigger_task_required*'
  }
  It 'contains no host-side CLI process-launch primitive' {
    $source=Get-Content -LiteralPath (Join-Path $script:Docs 'evidence1-provider-runtime-real.psm1') -Raw
    $source|Should -Not -Match '(?m)^\s*(Start-Process|Invoke-Expression|Invoke-Command|New-PSSession)\b'
    $source|Should -Not -Match '(?m)^\s*&\s*\$(?:script:)?(?:E1NodeCommand|node|E1ClaudeCommand|E1CodexCommand)\b'
  }
}

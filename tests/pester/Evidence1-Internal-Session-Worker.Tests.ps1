BeforeAll {
  $script:Launcher = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits/evidence1-dual-condition-canary-launch.ps1'
  $script:RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  . $script:Launcher -InternalLibrary
  # 2026-09-29 (WO-A2 auditor finding): Set-E1AgenticEvalSourceOrigin now also asserts the
  # scenario's own pinned commit/tree via three rev-parse calls -- an obviously-synthetic 40-hex
  # value, not a real project's SHA, built programmatically to avoid a hand-counted-hex-string
  # length mistake (confirmed the hard way earlier tonight in a sibling test file).
  $script:TestProjectCommit = 'a1' * 20
  $script:TestProjectTree = 'f2' * 20
}
Describe 'Evidence1 internal session worker' {
  BeforeEach {
    $script:PriorClaudeConfigDir = $env:CLAUDE_CONFIG_DIR
    $env:CLAUDE_CONFIG_DIR = 'C:\Evidence1RuntimeState\claude'
    $scenarioDir = Join-Path $TestDrive 'tools\agentic-eval\corpus\scenarios'
    New-Item -ItemType Directory -Force -Path $scenarioDir | Out-Null
    ([ordered]@{ project_url = 'https://github.com/android/nowinandroid'; project_commit = $script:TestProjectCommit } | ConvertTo-Json) |
        Set-Content -LiteralPath (Join-Path $scenarioDir 'coverage-threshold-failure-v2.json')
  }
  AfterEach {
    $env:CLAUDE_CONFIG_DIR = $script:PriorClaudeConfigDir
  }
  It 'binds the production process default to the explicit dual-condition contract module' {
    $script:E1InternalDualConditionContractModule.Name | Should -BeExactly 'evidence1-dual-condition-canary-contract'
    $script:E1InternalBoundedProcess | Should -BeOfType ([scriptblock])
  }
  It 'passes literal seed, provider timeout, worker timeout, budget, and deterministic runs root to its injected process' {
    $captured=@{};$private=Join-Path $TestDrive 'private'
    $inputs=[ordered]@{campaign_id='11111111-1111-1111-1111-111111111111';scenario_id='coverage-threshold-failure-v2';seed=-17;execution_profile_id='sandboxed-unrestricted-v1';harness_dir=$TestDrive;source_template_dir=$TestDrive;private_root=$private;provider_timeout_seconds=900;worker_timeout_seconds=960;provider_mode='live';runtimes=@([ordered]@{runtime_id='claude-code';model_id='claude-sonnet-5';campaign_design_id='claude-product-vs-free-baseline-v1';campaign_cell_indices=@(3);max_budget_usd=2.0});claude_attestation_file='C:\a.json';codex_attestation_file='C:\c.json'}
    $cell=[ordered]@{runtime_id='claude-code';model_id='claude-sonnet-5';campaign_design_id='claude-product-vs-free-baseline-v1';campaign_cell_index=3;round_index=0;condition='product'}
    $fake={param($FileName,$Arguments,$WorkingDirectory,$EnvironmentVariables,$TimeoutSeconds);if($FileName -like '*git.exe'){if($Arguments -contains 'get-url'){return [ordered]@{exit_code=0;cleanup_ok=$true;stdout='https://github.com/android/nowinandroid';stderr=''}};if($Arguments -contains 'rev-parse'){$lastArg=[string](@($Arguments)|Select-Object -Last 1);return [ordered]@{exit_code=0;cleanup_ok=$true;stdout=$(if($lastArg -ceq 'HEAD'){'a1'*20}else{'f2'*20});stderr=''}};return [ordered]@{exit_code=0;cleanup_ok=$true;stdout='';stderr=''}};$captured.args=$Arguments;$captured.env=$EnvironmentVariables;$captured.timeout=$TimeoutSeconds;if($Arguments -contains '--dry-run'){return [ordered]@{exit_code=0;cleanup_ok=$true;stdout='{ "dry_run":true,"planned_sessions":1,"runtime_id":"claude-code","model_id":"claude-sonnet-5","campaign_design_id":"claude-product-vs-free-baseline-v1","plan":[{"order_index":3,"condition":"current-skill","execution_profile_id":"sandboxed-unrestricted-v1"}] }';stderr=''}};$out=Join-Path $EnvironmentVariables.KMP_EVAL_RUNS_ROOT 'agentic-eval-scenario';$audit=Join-Path $out 'audit';New-Item -ItemType Directory -Force -Path $audit|Out-Null;'{}'|Set-Content -LiteralPath (Join-Path $out 'accepted.json');'{}'|Set-Content -LiteralPath (Join-Path $audit 'accepted.json');[ordered]@{exit_code=0;cleanup_ok=$true;stdout='{}';stderr=''}}.GetNewClosure()
    $result=Invoke-E1DualConditionCanarySession -CurrentCampaignInputs $inputs -Cell $cell -InvokeBoundedProcess $fake
    $result.verdict|Should -BeExactly 'PASS';$captured.timeout|Should -Be 960;$captured.args|Should -Contain '-17';$captured.args|Should -Contain '900000';$captured.args|Should -Contain '--max-budget-usd';$captured.env.KMP_EVAL_RUNS_ROOT|Should -Match 'claude-code-0$';Test-Path -LiteralPath (Join-Path $captured.env.KMP_EVAL_RUNS_ROOT 'record.json')|Should -BeTrue;Test-Path -LiteralPath (Join-Path $captured.env.KMP_EVAL_RUNS_ROOT 'audit.json')|Should -BeTrue
  }
  It 'rejects an overflowing cell index before invoking the process seam' {
    $inputs=[ordered]@{campaign_id='22222222-2222-2222-2222-222222222222';scenario_id='coverage-threshold-failure-v2';seed=-17;execution_profile_id='sandboxed-unrestricted-v1';harness_dir=$TestDrive;source_template_dir=$TestDrive;private_root=(Join-Path $TestDrive 'private-overflow');provider_timeout_seconds=900;worker_timeout_seconds=960;provider_mode='live';runtimes=@([ordered]@{runtime_id='codex-cli';model_id='gpt-5.6-terra';campaign_design_id='codex-product-vs-free-baseline-v1';campaign_cell_indices=@(0);max_budget_usd=$null});claude_attestation_file='C:\a.json';codex_attestation_file='C:\c.json'}
    $cell=[ordered]@{runtime_id='codex-cli';model_id='gpt-5.6-terra';campaign_design_id='codex-product-vs-free-baseline-v1';campaign_cell_index=0;round_index=[int64]::MaxValue;condition='product'}
    $notInvoked={throw 'process_must_not_be_invoked'}
    { Invoke-E1DualConditionCanarySession -CurrentCampaignInputs $inputs -Cell $cell -InvokeBoundedProcess $notInvoked } | Should -Throw '*agentic_eval_session_cell_invalid*'
  }
  It 'rejects a dry-run plan whose selected condition does not match the manifest cell before creating a session directory' {
    $private=Join-Path $TestDrive 'private-plan-mismatch';$captured=@{calls=0}
    $inputs=[ordered]@{campaign_id='33333333-3333-3333-3333-333333333333';scenario_id='coverage-threshold-failure-v2';seed=-17;execution_profile_id='sandboxed-unrestricted-v1';harness_dir=$TestDrive;source_template_dir=$TestDrive;private_root=$private;provider_timeout_seconds=900;worker_timeout_seconds=960;provider_mode='live';runtimes=@([ordered]@{runtime_id='codex-cli';model_id='gpt-5.6-terra';campaign_design_id='codex-product-vs-free-baseline-v1';campaign_cell_indices=@(0);max_budget_usd=$null});claude_attestation_file='C:\a.json';codex_attestation_file='C:\c.json'}
    $cell=[ordered]@{runtime_id='codex-cli';model_id='gpt-5.6-terra';campaign_design_id='codex-product-vs-free-baseline-v1';campaign_cell_index=0;round_index=0;condition='product'}
    $fake={param($FileName,$Arguments,$WorkingDirectory,$EnvironmentVariables,$TimeoutSeconds);if($FileName -like '*git.exe'){if($Arguments -contains 'get-url'){return [ordered]@{exit_code=0;cleanup_ok=$true;stdout='https://github.com/android/nowinandroid';stderr=''}};if($Arguments -contains 'rev-parse'){$lastArg=[string](@($Arguments)|Select-Object -Last 1);return [ordered]@{exit_code=0;cleanup_ok=$true;stdout=$(if($lastArg -ceq 'HEAD'){'a1'*20}else{'f2'*20});stderr=''}};return [ordered]@{exit_code=0;cleanup_ok=$true;stdout='';stderr=''}};$captured.calls++;$plan=[ordered]@{dry_run=$true;planned_sessions=1;runtime_id='codex-cli';model_id='gpt-5.6-terra';campaign_design_id='codex-product-vs-free-baseline-v1';plan=@([ordered]@{order_index=0;condition='no-skill';execution_profile_id='sandboxed-unrestricted-v1'})};[ordered]@{exit_code=0;cleanup_ok=$true;stdout=($plan|ConvertTo-Json -Compress);stderr=''}}.GetNewClosure()
    { Invoke-E1DualConditionCanarySession -CurrentCampaignInputs $inputs -Cell $cell -InvokeBoundedProcess $fake } | Should -Throw '*agentic_eval_session_plan_selection_invalid*'
    $captured.calls | Should -Be 1
    Test-Path -LiteralPath (Join-Path $private '33333333-3333-3333-3333-333333333333\codex-cli-0') | Should -BeFalse
  }
  It 'returns a sanitized failure classification without exposing provider output' {
    $private=Join-Path $TestDrive 'private-failure'
    $inputs=[ordered]@{campaign_id='44444444-4444-4444-4444-444444444444';scenario_id='coverage-threshold-failure-v2';seed=-17;execution_profile_id='sandboxed-unrestricted-v1';harness_dir=$TestDrive;source_template_dir=$TestDrive;private_root=$private;provider_timeout_seconds=900;worker_timeout_seconds=960;provider_mode='live';runtimes=@([ordered]@{runtime_id='codex-cli';model_id='gpt-5.6-terra';campaign_design_id='codex-product-vs-free-baseline-v1';campaign_cell_indices=@(0);max_budget_usd=$null});claude_attestation_file='C:\a.json';codex_attestation_file='C:\c.json'}
    $cell=[ordered]@{runtime_id='codex-cli';model_id='gpt-5.6-terra';campaign_design_id='codex-product-vs-free-baseline-v1';campaign_cell_index=0;round_index=0;condition='product'}
    $fake={param($FileName,$Arguments,$WorkingDirectory,$EnvironmentVariables,$TimeoutSeconds);if($FileName -like '*git.exe'){if($Arguments -contains 'get-url'){return [ordered]@{exit_code=0;cleanup_ok=$true;stdout='https://github.com/android/nowinandroid';stderr=''}};if($Arguments -contains 'rev-parse'){$lastArg=[string](@($Arguments)|Select-Object -Last 1);return [ordered]@{exit_code=0;cleanup_ok=$true;stdout=$(if($lastArg -ceq 'HEAD'){'a1'*20}else{'f2'*20});stderr=''}};return [ordered]@{exit_code=0;cleanup_ok=$true;stdout='';stderr=''}};if($Arguments -contains '--dry-run'){return [ordered]@{exit_code=0;cleanup_ok=$true;stdout='{ "dry_run":true,"planned_sessions":1,"runtime_id":"codex-cli","model_id":"gpt-5.6-terra","campaign_design_id":"codex-product-vs-free-baseline-v1","plan":[{"order_index":0,"condition":"current-skill","execution_profile_id":"sandboxed-unrestricted-v1"}] }';stderr=''}};[ordered]@{exit_code=1;cleanup_ok=$true;stdout='';stderr='spawn error: ENOENT secret-provider-output'}}
    $result=Invoke-E1DualConditionCanarySession -CurrentCampaignInputs $inputs -Cell $cell -InvokeBoundedProcess $fake
    $result.verdict|Should -BeExactly 'FAIL'
    $result.output_summary.failure_reason|Should -BeExactly 'dual_condition_runtime_command_missing'
    ($result|ConvertTo-Json -Depth 8)|Should -Not -Match 'secret-provider-output'
  }
  It 'treats a structured harness rejection as a completed session while keeping it benchmark-ineligible' {
    $private=Join-Path $TestDrive 'private-rejection'
    $rejectionId='05e140fa-6caf-413a-af6e-5df9fd78267a'
    $inputs=[ordered]@{campaign_id='55555555-5555-5555-5555-555555555555';scenario_id='coverage-threshold-failure-v2';seed=-17;execution_profile_id='sandboxed-unrestricted-v1';harness_dir=$TestDrive;source_template_dir=$TestDrive;private_root=$private;provider_timeout_seconds=900;worker_timeout_seconds=960;provider_mode='live';runtimes=@([ordered]@{runtime_id='claude-code';model_id='claude-sonnet-5';campaign_design_id='claude-product-vs-free-baseline-v1';campaign_cell_indices=@(0);max_budget_usd=2.0});claude_attestation_file='C:\a.json';codex_attestation_file='C:\c.json'}
    $cell=[ordered]@{runtime_id='claude-code';model_id='claude-sonnet-5';campaign_design_id='claude-product-vs-free-baseline-v1';campaign_cell_index=0;round_index=0;condition='product'}
    $fake={param($FileName,$Arguments,$WorkingDirectory,$EnvironmentVariables,$TimeoutSeconds);if($FileName -like '*git.exe'){if($Arguments -contains 'get-url'){return [ordered]@{exit_code=0;cleanup_ok=$true;stdout='https://github.com/android/nowinandroid';stderr=''}};if($Arguments -contains 'rev-parse'){$lastArg=[string](@($Arguments)|Select-Object -Last 1);return [ordered]@{exit_code=0;cleanup_ok=$true;stdout=$(if($lastArg -ceq 'HEAD'){'a1'*20}else{'f2'*20});stderr=''}};return [ordered]@{exit_code=0;cleanup_ok=$true;stdout='';stderr=''}};if($Arguments -contains '--dry-run'){return [ordered]@{exit_code=0;cleanup_ok=$true;stdout='{ "dry_run":true,"planned_sessions":1,"runtime_id":"claude-code","model_id":"claude-sonnet-5","campaign_design_id":"claude-product-vs-free-baseline-v1","plan":[{"order_index":0,"condition":"current-skill","execution_profile_id":"sandboxed-unrestricted-v1"}] }';stderr=''}};$rejected=Join-Path $EnvironmentVariables.KMP_EVAL_RUNS_ROOT 'agentic-eval-rejected';New-Item -ItemType Directory -Force -Path $rejected|Out-Null;([ordered]@{rejection_id=$rejectionId;privacy_status='public'}|ConvertTo-Json)|Set-Content -LiteralPath (Join-Path $rejected "$rejectionId.json");[ordered]@{exit_code=1;cleanup_ok=$true;stdout='';stderr="RUN FAILED: semantic gate rejection; rejection_id $rejectionId"}}.GetNewClosure()
    $result=Invoke-E1DualConditionCanarySession -CurrentCampaignInputs $inputs -Cell $cell -InvokeBoundedProcess $fake
    $result.verdict|Should -BeExactly 'PASS'
    $result.exit_code|Should -Be 1
    $result.output_summary.benchmark_status|Should -BeExactly 'rejected'
    $result.output_summary.rejection_id|Should -BeExactly $rejectionId
    $result.output_summary.failure_reason|Should -BeNullOrEmpty
    Test-Path -LiteralPath (Join-Path $private '55555555-5555-5555-5555-555555555555\claude-code-0\record.json')|Should -BeFalse
  }
  It 'reduces an unmapped typed exception to a bounded safe diagnostic code' {
    $reason=Get-E1SanitizedProcessFailureReason ([ordered]@{stdout='';stderr="TypeError: Cannot read properties of undefined (reading 'status')`n    at secret-path.js:42"})
    $reason|Should -BeExactly 'dual_condition_runtime_error_cannot_read_properties_of_undefined_reading_status'
    $reason|Should -Not -Match 'secret-path'
  }
  It 'reports only the closed set of false hard-gate checks' {
    $reason=Get-E1SanitizedProcessFailureReason ([ordered]@{stdout='';stderr='scenario hard gate -- availabilityOk:true noSkillSafetyOk:false cleanTranscriptOk:false secret detail'})
    $reason|Should -BeExactly 'dual_condition_runtime_hard_gate_noskillsafetyok_cleantranscriptok'
    $reason|Should -Not -Match 'secret'
  }
  It 'sanitizes diagnostic lines and removes absolute paths' {
    $lines=@(Get-E1SanitizedProcessDiagnosticLines ([ordered]@{stdout='';stderr="failure at C:\\secret\\token.txt`nSecond: useful detail!"}))
    $lines.Count|Should -Be 2
    $lines[0]|Should -BeExactly 'failure_at_<path>'
    $lines[1]|Should -BeExactly 'second_useful_detail'
    ($lines -join '|')|Should -Not -Match 'secret|token'
  }
  It 'removes only product CLI path entries for the free baseline' {
    $productDir=Join-Path $TestDrive 'product-bin';$safeDir=Join-Path $TestDrive 'safe-bin'
    New-Item -ItemType Directory -Force -Path $productDir,$safeDir|Out-Null
    ''|Set-Content -LiteralPath (Join-Path $productDir 'kmp-test.cmd')
    ''|Set-Content -LiteralPath (Join-Path $safeDir 'node.exe')
    $filtered=Remove-E1AgenticEvalProductCliPathEntries "$productDir;$safeDir"
    $filtered|Should -BeExactly $safeDir
    Test-Path -LiteralPath (Join-Path $safeDir 'node.exe')|Should -BeTrue
  }
  It 'uses only the fixed CLI fixtures through an ephemeral shim for fake Claude and Codex sessions' {
    foreach($case in @(
      [ordered]@{runtime_id='claude-code';model_id='claude-sonnet-5';design='claude-product-vs-free-baseline-v1';budget=2.0;executable='claude';wrapper=$true;condition='product';cli_condition='current-skill'},
      [ordered]@{runtime_id='codex-cli';model_id='gpt-5.6-terra';design='codex-product-vs-free-baseline-v1';budget=$null;executable='codex';wrapper=$false;condition='free';cli_condition='no-skill'}
    )){
      $captured=@{};$private=Join-Path $TestDrive ("private-" + $case.runtime_id)
      $inputs=[ordered]@{campaign_id=([guid]::NewGuid().ToString());scenario_id='coverage-threshold-failure-v2';seed=-17;execution_profile_id='sandboxed-unrestricted-v1';harness_dir=$script:RepoRoot;source_template_dir=$TestDrive;private_root=$private;provider_timeout_seconds=900;worker_timeout_seconds=960;provider_mode='fake';runtimes=@([ordered]@{runtime_id=$case.runtime_id;model_id=$case.model_id;campaign_design_id=$case.design;campaign_cell_indices=@(0);max_budget_usd=$case.budget});claude_attestation_file='C:\a.json';codex_attestation_file='C:\c.json'}
      $cell=[ordered]@{runtime_id=$case.runtime_id;model_id=$case.model_id;campaign_design_id=$case.design;campaign_cell_index=0;round_index=0;condition=$case.condition}
      # harness_dir is the REAL repo root below (not $TestDrive), so Set-E1AgenticEvalSourceOrigin
      # reads the REAL, committed tools/agentic-eval/corpus/scenarios/coverage-threshold-failure-v2.json
      # -- its own project_commit (7d45eae...) is what the source-identity check compares against here,
      # not this file's synthetic 'a1'*20 fixture used everywhere $TestDrive is the (fake) harness_dir.
      $fake={param($FileName,$Arguments,$WorkingDirectory,$EnvironmentVariables,$TimeoutSeconds);if($FileName -like '*git.exe'){if($Arguments -contains 'get-url'){return [ordered]@{exit_code=0;cleanup_ok=$true;stdout='https://github.com/android/nowinandroid';stderr=''}};if($Arguments -contains 'rev-parse'){$lastArg=[string](@($Arguments)|Select-Object -Last 1);return [ordered]@{exit_code=0;cleanup_ok=$true;stdout=$(if($lastArg -ceq 'HEAD'){'7d45eae4f8720a0c77f507712ba2437ff974b6ed'}else{'f2'*20});stderr=''}};return [ordered]@{exit_code=0;cleanup_ok=$true;stdout='';stderr=''}};$captured.file=$FileName;$captured.env=$EnvironmentVariables;if($Arguments -contains '--dry-run'){ $plan=[ordered]@{dry_run=$true;planned_sessions=1;runtime_id=$case.runtime_id;model_id=$case.model_id;campaign_design_id=$case.design;plan=@([ordered]@{order_index=0;condition=$case.cli_condition;execution_profile_id='sandboxed-unrestricted-v1'})};return [ordered]@{exit_code=0;cleanup_ok=$true;stdout=($plan|ConvertTo-Json -Compress);stderr=''}};$out=Join-Path $EnvironmentVariables.KMP_EVAL_RUNS_ROOT 'agentic-eval-scenario';$audit=Join-Path $out 'audit';New-Item -ItemType Directory -Force -Path $audit|Out-Null;'{}'|Set-Content -LiteralPath (Join-Path $out 'accepted.json');'{}'|Set-Content -LiteralPath (Join-Path $audit 'accepted.json');[ordered]@{exit_code=0;cleanup_ok=$true;stdout='{}';stderr=''}}.GetNewClosure()
      $result=Invoke-E1DualConditionCanarySession -CurrentCampaignInputs $inputs -Cell $cell -InvokeBoundedProcess $fake
      $shimDir=($captured.env.Path -split ';')[0]
      $result.verdict|Should -BeExactly 'PASS'
      $captured.file|Should -BeExactly 'C:\Evidence1Toolchain\node\24.19.0\node.exe'
      Test-Path -LiteralPath (Join-Path $shimDir $case.executable)|Should -BeTrue
      if($case.wrapper){
        $wrapper=Get-Content -LiteralPath (Join-Path $shimDir 'claude.cmd') -Raw
        $wrapper|Should -Match ([regex]::Escape('%CLAUDE_CODE_GIT_BASH_PATH%'))
        (Get-Content -LiteralPath (Join-Path $shimDir 'claude') -Raw)|Should -Match ([regex]::Escape('\"model\":\"claude-sonnet-5\"'))
        (Get-Content -LiteralPath (Join-Path $shimDir 'claude') -Raw)|Should -Match ([regex]::Escape('\"claude_code_version\":\"2.1.238\"'))
      } else {
        (Get-Content -LiteralPath (Join-Path $shimDir 'codex') -Raw)|Should -Match '#!/usr/bin/env bash'
      }
    }
  }
}

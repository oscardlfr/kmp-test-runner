# Invoke-E1DualConditionCanarySession is dot-sourced via -InternalLibrary --
# the exact same mechanism evidence1-guest-bundle-contract.psm1's own
# run-agentic-eval-session bundle scriptblock uses in production
# (". $worker -InternalLibrary" then calls the function directly), not an
# ad-hoc test-only load path. -InternalLibrary gates off the $Mode-based
# CLI dispatch entirely (see the script's own line 113 "if ($InternalLibrary)
# { ... return }"), so this is safe: only script-scoped variable assignments
# and function definitions run, no real process/VM/network action.
BeforeAll {
    $script:AuditsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\docs\audits')).Path
    $script:LaunchScript = Join-Path $script:AuditsRoot 'evidence1-dual-condition-canary-launch.ps1'
    # New-E1DualConditionCanaryRuntimeEnvironment requires this exact value (real guest-side
    # precondition, unrelated to what this file tests) -- User-scope is confirmed empty on this
    # host, so only the process-level fallback needs setting, and only for this process.
    $script:PreviousClaudeConfigDirEnv = $env:CLAUDE_CONFIG_DIR
    $env:CLAUDE_CONFIG_DIR = 'C:\Evidence1RuntimeState\claude'
    . $script:LaunchScript -InternalLibrary

    $script:ScratchRoot = Join-Path 'C:\kmp-eval\scratch\pester-dual-condition-session-tests' ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $script:ScratchRoot | Out-Null

    # Set-E1AgenticEvalSourceOrigin (called before the real invocation) requires this exact
    # scenario file to exist under harness_dir, with a project_url it then round-trips through
    # two more -InvokeBoundedProcess calls (git remote set-url / get-url), and (WO-A2 auditor
    # finding, source-identity assertion) a project_commit it verifies via three more
    # rev-parse calls -- an obviously-synthetic 40-hex value, not a real project's SHA.
    $script:TestProjectUrl = 'https://example.invalid/test-repo.git'
    $script:TestProjectCommit = 'a1' * 20
    $script:TestProjectTree = 'f2' * 20
    $scenarioDir = Join-Path $script:ScratchRoot 'tools\agentic-eval\corpus\scenarios'
    New-Item -ItemType Directory -Force -Path $scenarioDir | Out-Null
    ([ordered]@{ project_url = $script:TestProjectUrl; project_commit = $script:TestProjectCommit } | ConvertTo-Json) |
        Set-Content -LiteralPath (Join-Path $scenarioDir 'coverage-threshold-failure-v2.json') -Encoding UTF8

    function New-TestCampaignInputs([string]$PrivateRoot) {
        return [ordered]@{
            campaign_id             = 'test-campaign-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
            scenario_id             = 'coverage-threshold-failure-v2'
            seed                    = 20260928
            execution_profile_id    = 'sandboxed-unrestricted-v1'
            harness_dir             = $script:ScratchRoot
            source_template_dir     = $script:ScratchRoot
            provider_timeout_seconds = 1800
            worker_timeout_seconds   = 1860
            provider_mode            = 'live'
            private_root              = $PrivateRoot
            claude_attestation_file    = Join-Path $script:ScratchRoot 'claude-attestation.json'
            codex_attestation_file      = Join-Path $script:ScratchRoot 'codex-attestation.json'
            runtimes                     = @(
                [ordered]@{ runtime_id = 'codex-cli'; model_id = 'gpt-5.6-terra'; campaign_design_id = 'codex-product-vs-free-baseline-v2'; campaign_cell_indices = @(0, 1); max_budget_usd = $null }
            )
        }
    }

    function New-TestCell {
        return [ordered]@{ runtime_id = 'codex-cli'; model_id = 'gpt-5.6-terra'; campaign_design_id = 'codex-product-vs-free-baseline-v2'; campaign_cell_index = 0; round_index = 0; condition = 'product' }
    }

    # Call-shape-aware, not call-counter-based: Set-E1AgenticEvalSourceOrigin makes two more
    # -InvokeBoundedProcess calls (git remote set-url / get-url) between the dry-run and the
    # real invocation, so a fixed "2nd call = real" position would be wrong and fragile against
    # any future call this codepath adds. $OnRealCall receives no arguments and returns
    # whatever the real (non-dry-run, non-git) invocation should return -- a hashtable to
    # simulate a clean process result, or it may itself throw to simulate a bounded-process
    # exception.
    function New-FakeInvokeBoundedProcess($CurrentCampaignInputs, $Cell, [scriptblock]$OnRealCall, [string]$ObservedCommitOverride = '', [string]$ObservedTreeOverride = '') {
        # $projectUrl captured as a genuine local (GetNewClosure's own reliable capture
        # mechanism), NOT referenced as $script:TestProjectUrl inside the closure -- confirmed
        # earlier tonight (Evidence1-Broker-Capability-Client.Tests.ps1's own comment) that a
        # $script:-qualified reference inside a closure resolves dynamically against whatever
        # scope is active at INVOCATION time, not capture time, and this call chain's actual
        # invocation-time scope is not reliably this file's own script scope.
        $projectUrl = $script:TestProjectUrl
        # 2026-09-29 (WO-A2 auditor finding): same dynamic-resolution gotcha for the source-
        # identity assertion's own three new rev-parse calls -- Observed defaults to Test's own
        # fixture values, so every EXISTING test (none of which care about this new check) keeps
        # passing transparently; only a test that explicitly wants a mismatch overrides one.
        $observedCommit = if ($ObservedCommitOverride) { $ObservedCommitOverride } else { $script:TestProjectCommit }
        $observedTree = if ($ObservedTreeOverride) { $ObservedTreeOverride } else { $script:TestProjectTree }
        $expectedTree = $script:TestProjectTree
        # Inlined rather than calling New-FakeDryRunPlanJson: the same dynamic-resolution
        # gotcha as the $script: variable above applies equally to a function call made from
        # inside a closure invoked via a call stack that doesn't reliably include this file's
        # own scope.
        $dryRunStdout = ([ordered]@{
            dry_run = $true; planned_sessions = 1
            runtime_id = $Cell.runtime_id; model_id = $Cell.model_id; campaign_design_id = $Cell.campaign_design_id
            plan = @([ordered]@{ order_index = $Cell.campaign_cell_index; condition = 'current-skill'; execution_profile_id = $CurrentCampaignInputs.execution_profile_id })
        } | ConvertTo-Json -Depth 6 -Compress)
        return {
            param($FileName, $Arguments, $WorkingDirectory, $EnvironmentVariables, $TimeoutSeconds)
            if (@($Arguments) -contains 'remote') {
                if (@($Arguments) -contains 'set-url') { return [ordered]@{ exit_code = 0; cleanup_ok = $true; stdout = ''; stderr = '' } }
                if (@($Arguments) -contains 'get-url') { return [ordered]@{ exit_code = 0; cleanup_ok = $true; stdout = "$projectUrl`n"; stderr = '' } }
            }
            if (@($Arguments) -contains 'rev-parse') {
                $lastArgument = [string](@($Arguments) | Select-Object -Last 1)
                if ($lastArgument -ceq 'HEAD') { return [ordered]@{ exit_code = 0; cleanup_ok = $true; stdout = "$observedCommit`n"; stderr = '' } }
                if ($lastArgument -ceq 'HEAD^{tree}') { return [ordered]@{ exit_code = 0; cleanup_ok = $true; stdout = "$observedTree`n"; stderr = '' } }
                return [ordered]@{ exit_code = 0; cleanup_ok = $true; stdout = "$expectedTree`n"; stderr = '' }
            }
            if (@($Arguments) -contains '--dry-run') {
                return [ordered]@{ exit_code = 0; cleanup_ok = $true; stdout = $dryRunStdout; stderr = '' }
            }
            & $OnRealCall
        }.GetNewClosure()
    }
}

AfterAll {
    if (Test-Path -LiteralPath $script:ScratchRoot) {
        Remove-Item -LiteralPath $script:ScratchRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    $env:CLAUDE_CONFIG_DIR = $script:PreviousClaudeConfigDirEnv
}

Describe 'Invoke-E1DualConditionCanarySession: bounded-process exception handling (2026-09-28 incident, F2)' {
    It '(RED on the pre-fix shape / GREEN after) a cleanup_failed exception after runs_root exists returns a proper FAIL session result, not a thrown exception' {
        $private = Join-Path $script:ScratchRoot ('private-' + [guid]::NewGuid().ToString('N'))
        $inputs = New-TestCampaignInputs $private
        $cell = New-TestCell
        $fakeInvoke = New-FakeInvokeBoundedProcess $inputs $cell { throw 'dual_condition_process_cleanup_failed' }

        # Direct assignment, not `{ $result = ... } | Should -Not -Throw` -- that idiom invokes
        # the scriptblock in its own child scope, so the assignment never reaches this $result
        # (the exact bug already found and fixed earlier tonight in this repo's own
        # Evidence1-Run-Full-Campaign-Integration.Tests.ps1). An unexpected throw here fails
        # this It block on its own, which already proves the same "does not throw" property.
        $result = Invoke-E1DualConditionCanarySession -CurrentCampaignInputs $inputs -Cell $cell -InvokeBoundedProcess $fakeInvoke

        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -BeExactly 'agentic_eval_session_process_failed'
        $result.output_summary.benchmark_status | Should -BeExactly 'transport-failed'
        $result.output_summary.failure_reason | Should -BeExactly 'dual_condition_process_cleanup_failed'
        $expectedRunsRoot = Join-Path $private (Join-Path $inputs.campaign_id 'codex-cli-0')
        $result.output_summary.runs_root | Should -BeExactly $expectedRunsRoot
        # Never accepted when cleanup is unproven -- the containment invariant.
        $result.output_summary.benchmark_status | Should -Not -BeExactly 'accepted'
    }

    It 'a timeout exception after runs_root exists also returns a proper FAIL result with that exact reason preserved' {
        $private = Join-Path $script:ScratchRoot ('private-' + [guid]::NewGuid().ToString('N'))
        $inputs = New-TestCampaignInputs $private
        $cell = New-TestCell
        $fakeInvoke = New-FakeInvokeBoundedProcess $inputs $cell { throw 'dual_condition_process_timeout' }

        $result = Invoke-E1DualConditionCanarySession -CurrentCampaignInputs $inputs -Cell $cell -InvokeBoundedProcess $fakeInvoke

        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -BeExactly 'agentic_eval_session_process_failed'
        $result.output_summary.failure_reason | Should -BeExactly 'dual_condition_process_timeout'
    }

    It '(M1) a path-bearing exception message is not preserved verbatim -- collapses to the closed-vocabulary fallback, with no path anywhere in the result' {
        $private = Join-Path $script:ScratchRoot ('private-' + [guid]::NewGuid().ToString('N'))
        $inputs = New-TestCampaignInputs $private
        $cell = New-TestCell
        $leakyPath = 'C:\Users\SomeRealUser\AppData\Local\leaked-secret-looking-path\node.exe'
        $fakeInvoke = New-FakeInvokeBoundedProcess $inputs $cell { throw "The system cannot find the file specified: '$leakyPath'" }

        $result = Invoke-E1DualConditionCanarySession -CurrentCampaignInputs $inputs -Cell $cell -InvokeBoundedProcess $fakeInvoke

        $result.verdict | Should -BeExactly 'FAIL'
        $result.output_summary.failure_reason | Should -BeExactly 'agentic_eval_session_process_unexpected_error'
        ($result | ConvertTo-Json -Depth 10) | Should -Not -Match ([regex]::Escape($leakyPath))
        ($result | ConvertTo-Json -Depth 10) | Should -Not -Match 'SomeRealUser'
    }

    It 'the real (non-exceptional) path is unaffected: a clean process failure without an exception still produces the pre-existing transport-failed shape' {
        $private = Join-Path $script:ScratchRoot ('private-' + [guid]::NewGuid().ToString('N'))
        $inputs = New-TestCampaignInputs $private
        $cell = New-TestCell
        # No exception: the process itself completed and cleanup succeeded (cleanup_ok true),
        # but with a genuine non-zero exit -- the ORIGINAL, still-intact FAIL path.
        $fakeInvoke = New-FakeInvokeBoundedProcess $inputs $cell {
            [ordered]@{ exit_code = 1; cleanup_ok = $true; stdout = ''; stderr = 'a genuine provider failure, not a transport exception' }
        }

        $result = Invoke-E1DualConditionCanarySession -CurrentCampaignInputs $inputs -Cell $cell -InvokeBoundedProcess $fakeInvoke

        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -BeExactly 'agentic_eval_session_failed'
        $result.output_summary.benchmark_status | Should -BeExactly 'transport-failed'
    }
}

Describe 'Invoke-E1DualConditionCanarySession: source-identity assertion (WO-A2 auditor finding, 2026-09-29)' {
    # The dot-source clobbering bug (bc7dd6a) meant a guest bundle could silently substitute a
    # DIFFERENT source checkout for months without this session path ever noticing -- this path
    # itself was traced and found safe (it always reads $CurrentCampaignInputs.source_template_dir,
    # never a bare clobbered variable), but "safe today" is not "asserted." These tests prove the
    # NEW assertion actually fails closed, not just that it exists in source text.
    It 'throws a source-identity mismatch, naming both observed values, before any real session dispatch' {
        $private = Join-Path $script:ScratchRoot ('private-' + [guid]::NewGuid().ToString('N'))
        $inputs = New-TestCampaignInputs $private
        $cell = New-TestCell
        $wrongCommit = 'b3' * 20
        $notCalled = New-FakeInvokeBoundedProcess $inputs $cell { throw 'source_identity_check_must_short_circuit_before_this' } -ObservedCommitOverride $wrongCommit

        { Invoke-E1DualConditionCanarySession -CurrentCampaignInputs $inputs -Cell $cell -InvokeBoundedProcess $notCalled } |
            Should -Throw "*agentic_eval_session_source_identity_mismatch:commit=$wrongCommit*expected_commit=$($script:TestProjectCommit)*"
    }

    It 'throws a source-identity mismatch on a tree drift even when the commit SHA itself matches (a corrupted or hand-edited checkout)' {
        $private = Join-Path $script:ScratchRoot ('private-' + [guid]::NewGuid().ToString('N'))
        $inputs = New-TestCampaignInputs $private
        $cell = New-TestCell
        $wrongTree = 'c4' * 20
        $notCalled = New-FakeInvokeBoundedProcess $inputs $cell { throw 'source_identity_check_must_short_circuit_before_this' } -ObservedTreeOverride $wrongTree

        { Invoke-E1DualConditionCanarySession -CurrentCampaignInputs $inputs -Cell $cell -InvokeBoundedProcess $notCalled } |
            Should -Throw "*agentic_eval_session_source_identity_mismatch:*tree=$wrongTree*"
    }

    It 'does not throw when the observed commit and tree both match the scenario''s own pinned identity' {
        $private = Join-Path $script:ScratchRoot ('private-' + [guid]::NewGuid().ToString('N'))
        $inputs = New-TestCampaignInputs $private
        $cell = New-TestCell
        $fakeInvoke = New-FakeInvokeBoundedProcess $inputs $cell {
            [ordered]@{ exit_code = 1; cleanup_ok = $true; stdout = ''; stderr = 'reached past the identity check' }
        }

        { Invoke-E1DualConditionCanarySession -CurrentCampaignInputs $inputs -Cell $cell -InvokeBoundedProcess $fakeInvoke } | Should -Not -Throw
    }
}


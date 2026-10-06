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

Describe 'Dual-condition runtime timeout boundary' {
    It 'sets only the outer kmp-test watchdog for broad campaigns' {
        $runtime = New-E1DualConditionCanaryRuntimeEnvironment
        $runtime.KMP_TEST_OUTER_TIMEOUT_MS | Should -BeExactly '3240000'
        $runtime.ContainsKey('KMP_GRADLE_TIMEOUT_MS') | Should -BeFalse
    }
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


Describe 'New-E1FakeAgenticEvalRuntimeShim: the multi-module-tests family variables (WO-07)' {
    BeforeAll {
        $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
        $script:MmFixtureDir = Join-Path $script:RepoRoot 'tests\fixtures\agentic-eval-multi-module'
        $script:MmScenarioText = [IO.File]::ReadAllText((Join-Path $script:MmFixtureDir 'scenario-draft.json'))
        $script:MmExpectedText = [IO.File]::ReadAllText((Join-Path $script:MmFixtureDir 'expected-draft.json'))

        # A harness directory holding just what the shim generator reads: the two fixtures, and the scenario
        # file and (when given) the expected file of the scenario id under corpus/. Returns the shim text.
        function New-MmShimText([string]$RuntimeId, [string]$ScenarioId, [string]$ScenarioText, [string]$ExpectedText) {
            $harness = Join-Path $script:ScratchRoot ('mm-harness-' + [guid]::NewGuid().ToString('N'))
            foreach ($relative in @('fake-claude-campaign-success\claude', 'fake-codex-campaign-success\codex')) {
                $destination = Join-Path $harness (Join-Path 'tests\fixtures' $relative)
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
                Copy-Item -LiteralPath (Join-Path $script:RepoRoot (Join-Path 'tests\fixtures' $relative)) -Destination $destination
            }
            $corpus = Join-Path $harness 'tools\agentic-eval\corpus'
            New-Item -ItemType Directory -Force -Path (Join-Path $corpus 'scenarios'), (Join-Path $corpus 'expected') | Out-Null
            [IO.File]::WriteAllText((Join-Path $corpus "scenarios\$ScenarioId.json"), $ScenarioText, [Text.UTF8Encoding]::new($false))
            if ($ExpectedText) { [IO.File]::WriteAllText((Join-Path $corpus "expected\$ScenarioId.json"), $ExpectedText, [Text.UTF8Encoding]::new($false)) }
            $runsRoot = Join-Path $script:ScratchRoot ('mm-runs-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Force -Path $runsRoot | Out-Null
            $inputs = [pscustomobject]@{ harness_dir = $harness; scenario_id = $ScenarioId }
            $cell = [pscustomobject]@{ runtime_id = $RuntimeId; model_id = 'model-under-test' }
            $shimDir = New-E1FakeAgenticEvalRuntimeShim $inputs $cell $runsRoot
            $executable = if ($RuntimeId -ceq 'claude-code') { 'claude' } else { 'codex' }
            return [IO.File]::ReadAllText((Join-Path $shimDir $executable))
        }
        $script:MmExpectedExports = @(
            "export KMP_FAKE_SCENARIO_FAMILY='multi-module-tests'",
            "export KMP_FAKE_SCENARIO_PROJECT_NAME='nowinandroid'",
            "export KMP_FAKE_SCENARIO_INCLUDE_MARKER='include("":core:data"")'",
            "export KMP_FAKE_SCENARIO_KMP_TEST_ARGS='parallel --flavor demo --exclude-modules app,core:designsystem,feature:foryou:impl,feature:interests:impl --json'",
            "export KMP_FAKE_SCENARIO_GRADLE_TASKS=':core:common:test'",
            "export KMP_FAKE_SCENARIO_EXPECTED_JSON='{""outcome_kind"":""tests_failed"",""failing_modules"":["":core:data"","":core:domain"","":feature:bookmarks:impl""],""failed_test_classes"":[""BookmarksViewModelTest"",""CompositeUserNewsResourceRepositoryTest"",""GetFollowableTopicsUseCaseTest""],""failed_count"":6}'"
        )
        # A v2-style scenario: no family branch applies, so the shim must stay exactly what it always was.
        $script:MmV2ScenarioText = '{ "schema": 1, "id": "coverage-threshold-failure-v2", "family": "coverage", "project_alias": "nowinandroid" }'
    }

    It 'writes the family variables as export lines right after the shebang of the Claude shim, in a fixed order' {
        $text = New-MmShimText 'claude-code' 'multi-module-test-failures' $script:MmScenarioText $script:MmExpectedText
        $lines = $text -split "`n"
        $lines[0] | Should -BeExactly '#!/usr/bin/env bash'
        $lines[1..6] | Should -BeExactly $script:MmExpectedExports
    }

    It 'writes the same export lines for the Codex shim' {
        $text = New-MmShimText 'codex-cli' 'multi-module-test-failures' $script:MmScenarioText $script:MmExpectedText
        $lines = $text -split "`n"
        $lines[0] | Should -BeExactly '#!/usr/bin/env bash'
        $lines[1..6] | Should -BeExactly $script:MmExpectedExports
    }

    It 'changes nothing else in either shim: the rest of the text equals the shim of a scenario without the family' {
        foreach ($runtime in @('claude-code', 'codex-cli')) {
            $withFamily = (New-MmShimText $runtime 'multi-module-test-failures' $script:MmScenarioText $script:MmExpectedText) -split "`n"
            $without = (New-MmShimText $runtime 'coverage-threshold-failure-v2' $script:MmV2ScenarioText '') -split "`n"
            ($withFamily[7..($withFamily.Count - 1)] -join "`n") | Should -BeExactly (($without[1..($without.Count - 1)]) -join "`n")
        }
    }

    It 'leaves the shims of a scenario of another family without any KMP_FAKE_SCENARIO export' {
        foreach ($runtime in @('claude-code', 'codex-cli')) {
            $text = New-MmShimText $runtime 'coverage-threshold-failure-v2' $script:MmV2ScenarioText ''
            $text | Should -Not -Match 'export KMP_FAKE_SCENARIO'
        }
    }

    It 'keeps the line endings LF, so bash reads the shebang and every export' {
        $text = New-MmShimText 'claude-code' 'multi-module-test-failures' $script:MmScenarioText $script:MmExpectedText
        $text | Should -Not -Match "`r"
    }

    It 'quotes a single quote inside a value for bash single quotes' {
        $edited = $script:MmExpectedText.Replace('"parallel"', '"par''allel"')
        $edited | Should -Not -BeExactly $script:MmExpectedText
        $text = New-MmShimText 'claude-code' 'multi-module-test-failures' $script:MmScenarioText $edited
        $text | Should -Match ([regex]::Escape("export KMP_FAKE_SCENARIO_KMP_TEST_ARGS='par'\''allel --flavor demo"))
    }

    It 'picks the first allowed Gradle test task, not the first allowed task' {
        $text = New-MmShimText 'claude-code' 'multi-module-test-failures' $script:MmScenarioText $script:MmExpectedText
        $script:MmScenarioText | Should -Match '":core:common:tasks",\s*":core:common:test"'
        $text | Should -Match ([regex]::Escape("export KMP_FAKE_SCENARIO_GRADLE_TASKS=':core:common:test'"))
    }

    It 'fails closed when the expected file of a multi-module scenario is missing' {
        { New-MmShimText 'claude-code' 'multi-module-test-failures' $script:MmScenarioText '' } | Should -Throw '*agentic_eval_fake_expected_missing*'
    }

    It 'fails closed when the expected file is not valid JSON or has no smoke block' {
        { New-MmShimText 'claude-code' 'multi-module-test-failures' $script:MmScenarioText '{ not json' } | Should -Throw '*agentic_eval_fake_expected_invalid*'
        $noSmoke = ($script:MmExpectedText | ConvertFrom-Json) | Select-Object -Property * -ExcludeProperty smoke | ConvertTo-Json -Depth 8
        { New-MmShimText 'claude-code' 'multi-module-test-failures' $script:MmScenarioText $noSmoke } | Should -Throw '*agentic_eval_fake_expected_invalid*'
    }

    It 'fails closed when the scenario file of the campaign is not valid JSON' {
        { New-MmShimText 'claude-code' 'multi-module-test-failures' '{ not json' $script:MmExpectedText } | Should -Throw '*agentic_eval_fake_scenario_invalid*'
    }

    It 'fails closed when a multi-module scenario allows no Gradle test task for the free arm to run' {
        $scenario = $script:MmScenarioText | ConvertFrom-Json
        $scenario.policy.allowed_gradle_tasks = @(':core:common:tasks', ':core:data:tasks')
        { New-MmShimText 'claude-code' 'multi-module-test-failures' ($scenario | ConvertTo-Json -Depth 8) $script:MmExpectedText } | Should -Throw '*agentic_eval_fake_scenario_invalid*'
    }
}

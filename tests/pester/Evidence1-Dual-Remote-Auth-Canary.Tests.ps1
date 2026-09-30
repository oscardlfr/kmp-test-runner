#Requires -Modules Pester

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:AuditRoot = Join-Path $script:RepoRoot 'docs\audits'
    Import-Module (Join-Path $script:AuditRoot 'evidence1-live-handoff-contract.psm1') -Force
    $script:Now = [DateTime]::Parse('2026-09-11T12:00:00.000Z').ToUniversalTime()
    $script:VMName = 'Evidence1-Runner-E2E'
    $script:VMId = '00000000-0000-4000-8000-000000000001'

    function New-ProviderPrivacy {
        [ordered]@{
            raw_content_persisted = $false
            raw_content_printed = $false
            raw_content_read_in_memory_for_sanitization = $true
            error_text_persisted = $false
        }
    }

    function New-DualAuthHostReportFixture([hashtable]$Override = @{}) {
        $auth = [ordered]@{
            schema = 2; verdict = 'PASS'; generated_at_utc = '2026-09-11T11:56:00.000Z'
            operation_id = '11111111-1111-4111-8111-111111111111'
            vm_name = $script:VMName; vm_id = $script:VMId; vm_state = 'Running'
            readiness_sha256 = 'a' * 64; account_binding_sha256 = '9' * 64
            remote_auth_canary = New-DualCanary
            model_pair = [ordered]@{ campaign_kind = 'canonical-auth-canary'; claude_model = 'claude-sonnet-5'; codex_model = 'gpt-5.6-terra' }
            privacy = [ordered]@{ raw_content_persisted = $false; raw_content_printed = $false; error_text_persisted = $false }
        }
        foreach ($key in $Override.Keys) { $auth[$key] = $Override[$key] }
        return $auth
    }

    # Task 2 (dual-auth FAIL-report schema) helpers -- defined here, in the
    # root BeforeAll, NOT bare inside their own Describe blocks: a bare
    # function inside a Describe is discovery-phase-only and invisible to
    # It blocks in the run phase (this file's own comment on
    # New-DualAuthHostReportFixture, above, already documents this exact
    # mistake being made and caught twice elsewhere this engagement --
    # caught a third time here, in this same file, by actually running
    # this round's first draft and seeing CommandNotFoundException rather
    # than trusting it).

    function New-DualAuthFailureReportFixture([hashtable]$Override = @{}) {
        $failure = [ordered]@{
            schema = 2; verdict = 'FAIL'; reason_code = 'dual_auth_failed_before_account_binding_loaded'
            generated_at_utc = '2026-09-11T11:56:00.000Z'
            operation_id = '11111111-1111-4111-8111-111111111111'
            vm_name = $script:VMName; vm_id = $script:VMId
            readiness_sha256 = $null; account_binding_sha256 = $null
            model_pair = [ordered]@{ campaign_kind = 'canonical-auth-canary'; claude_model = 'claude-sonnet-5'; codex_model = 'gpt-5.6-terra' }
            privacy = [ordered]@{ raw_content_persisted = $false; raw_content_printed = $false; error_text_persisted = $false }
        }
        foreach ($key in $Override.Keys) { $failure[$key] = $Override[$key] }
        return $failure
    }

    function Get-TestDualAuthFailureReasonCode([string]$Stage) {
        # Byte-for-byte replica of
        # evidence1-hyperv-verify-guest-dual-auth-direct.ps1's catch block
        # switch ($stage) { ... } (see that file's own catch block for the
        # authoritative copy).
        switch ($Stage) {
            'before_account_binding_loaded' { 'dual_auth_failed_before_account_binding_loaded' }
            'account_binding_loaded'        { 'dual_auth_failed_after_account_binding_before_readiness' }
            'readiness_obtained'            { 'dual_auth_failed_after_readiness_before_guest_operation' }
            'guest_operation_dispatched'    { 'dual_auth_failed_during_guest_execution' }
            'guest_execution_completed'     { 'dual_auth_failed_reading_guest_result' }
            'guest_result_read'             { 'dual_auth_failed_writing_completed_report' }
            'writing_completed_report'      { 'dual_auth_failed_writing_completed_report' }
            default                         { 'dual_auth_failed_before_account_binding_loaded' }
        }
    }

    function New-TestDualAuthFailureReport([string]$Stage, $ReadinessSha256, $AccountBindingSha256) {
        # Byte-for-byte replica of the catch block's own
        # Write-CreateNewJson $hostFinalPath ([ordered]@{ ... }) literal.
        [ordered]@{
            schema = 2; verdict = 'FAIL'; reason_code = (Get-TestDualAuthFailureReasonCode $Stage)
            generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
            operation_id = '11111111-1111-4111-8111-111111111111'; vm_name = $script:VMName; vm_id = $script:VMId
            readiness_sha256 = $ReadinessSha256; account_binding_sha256 = $AccountBindingSha256
            model_pair = [ordered]@{ campaign_kind = 'canonical-auth-canary'; claude_model = 'claude-sonnet-5'; codex_model = 'gpt-5.6-terra' }
            privacy = [ordered]@{ raw_content_persisted = $false; raw_content_printed = $false; error_text_persisted = $false }
        }
    }

    function Write-TestCreateNewJson([string]$Path, $Value) {
        # Byte-for-byte replica of Write-CreateNewJson in
        # evidence1-hyperv-verify-guest-dual-auth-direct.ps1.
        [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path))
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 20 -Compress))
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
        finally { $stream.Dispose() }
    }

    function New-DualCanary {
        $completed = '2026-09-11T11:55:00.000Z'
        [ordered]@{
            schema = 2
            state = 'passed'
            operation_id = '11111111-1111-4111-8111-111111111111'
            completed_at_utc = $completed
            context = [ordered]@{
                vm_name = $script:VMName; vm_id = $script:VMId
                codex_model = 'gpt-5.6-terra'; host_readiness_sha256 = 'a' * 64
                host_readiness_generated_at_utc = '2026-09-11T11:50:00.000Z'
                guest_readiness_sha256 = 'b' * 64; guest_readiness_generated_at_utc = '2026-09-11T11:51:00.000Z'
            }
            authorization_scope = [ordered]@{
                authorized_sessions = 2
                claimed_sessions = 2
                dispatched_sessions = 2
                providers = @('claude-code', 'codex-cli')
                retry_count = 0
                replacement_count = 0
                respawn_count = 0
            }
            providers = @(
                [ordered]@{
                    runtime_id = 'claude-code'; dispatch_ordinal = 1; state = 'passed'; claimed_at_utc = '2026-09-11T11:54:00.000Z'; completed_at_utc = $completed
                    elapsed_milliseconds = 10
                    cli_version = '2.1.238 (Claude Code)'; local_auth_status_exit_code = 0; process_started = $true; process_exit_code = 0; timed_out = $false
                    process_tree_cleanup_confirmed = $true; reason_code = $null
                    event_type_counts = [ordered]@{ system = 1; assistant = 0; user = 0; result = 1; rate_limit_event = 1; unknown = 0 }; parse_error_count = 0
                    agent_message_count = 1; response_matched = $true; tool_invocation_count = 0
                    tools_disabled = $true; tool_observation = 'tools_disabled_and_observed_zero_tool_use'
                    http_statuses = @(); http_status_reason = $null
                    terminal = [ordered]@{ present = $true; is_error = $false }
                    credential_override_names = @(); privacy = New-ProviderPrivacy
                },
                [ordered]@{
                    runtime_id = 'codex-cli'; dispatch_ordinal = 2; state = 'passed'; claimed_at_utc = '2026-09-11T11:54:30.000Z'; completed_at_utc = $completed
                    elapsed_milliseconds = 10
                    cli_version = 'codex-cli 0.154.0'; model = 'gpt-5.6-terra'
                    local_auth_status_exit_code = 0; process_started = $true; process_exit_code = 0; timed_out = $false
                    process_tree_cleanup_confirmed = $true; reason_code = $null
                    event_type_counts = [ordered]@{
                        thread_started = 1; turn_started = 1; turn_completed = 1; turn_failed = 0
                        item_started = 1; item_updated = 0; item_completed = 1; error = 0; unknown = 0
                    }
                    parse_error_count = 0; agent_message_count = 1; response_matched = $true; tool_invocation_count = 0
                    tools_disabled = $null; tool_observation = 'observed_zero_tool_items'
                    http_statuses = $null; http_status_reason = 'runtime_does_not_expose_http_status'
                    terminal = [ordered]@{ thread_started_count = 1; turn_completed_count = 1; turn_failed_count = 0; error_event_count = 0 }
                    credential_override_names = @(); privacy = New-ProviderPrivacy
                }
            )
            credential_override_names = @()
            privacy = New-ProviderPrivacy
        }
    }

    function New-ModelPairDualCanary {
        $canary = New-DualCanary
        $canary.schema = 3
        $canary.context['claude_model'] = 'claude-sonnet-5'
        $canary.context['campaign_kind'] = 'paired-model-availability-canary'
        $canary.providers[0]['model'] = 'claude-sonnet-5'
        $canary.providers[0]['model_resolved'] = 'claude-sonnet-5'
        return $canary
    }
}

Describe 'Evidence1 dual-runtime remote-auth canary contract' {
    It 'accepts exactly one passing Claude dispatch and one passing Codex dispatch' {
        $result = Assert-Evidence1DualRemoteAuthCanary -Canary (New-DualCanary) `
            -ExpectedClaudeVersion '2.1.238' -ExpectedCodexVersion '0.154.0' `
            -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId -NowUtc $script:Now
        $result.ok | Should -BeTrue
        $result.schema | Should -Be 2
        $result.authorized_sessions | Should -Be 2
        $result.claimed_sessions | Should -Be 2
        $result.dispatched_sessions | Should -Be 2
        @($result.providers) | Should -Be @('claude-code', 'codex-cli')
    }

    It 'accepts the schema 3 paired-model record emitted by the official producer' {
        $result = Assert-Evidence1DualRemoteAuthCanary -Canary (New-ModelPairDualCanary) `
            -ExpectedClaudeVersion '2.1.238' -ExpectedCodexVersion '0.154.0' `
            -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -ExpectedClaudeModel 'claude-sonnet-5' -ExpectedCodexModel 'gpt-5.6-terra' -NowUtc $script:Now
        $result.ok | Should -BeTrue
        $result.schema | Should -Be 3
    }

    It 'rejects schema 3 when the bound Claude model drifts' {
        { Assert-Evidence1DualRemoteAuthCanary -Canary (New-ModelPairDualCanary) `
            -ExpectedClaudeVersion '2.1.238' -ExpectedCodexVersion '0.154.0' `
            -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -ExpectedClaudeModel 'claude-opus-5' -ExpectedCodexModel 'gpt-5.6-terra' -NowUtc $script:Now } |
            Should -Throw '*Claude model pair mismatch*'
    }

    It 'rejects accounting that is not exactly two dispatches' {
        $canary = New-DualCanary
        $canary.authorization_scope.dispatched_sessions = 1
        { Assert-Evidence1DualRemoteAuthCanary -Canary $canary -ExpectedClaudeVersion '2.1.238' `
            -ExpectedCodexVersion '0.154.0' -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -NowUtc $script:Now } | Should -Throw '*dispatched_sessions*'
    }

    It 'rejects a claimed slot count that differs from the two consumed ordinals' {
        $canary = New-DualCanary
        $canary.authorization_scope.claimed_sessions = 1
        { Assert-Evidence1DualRemoteAuthCanary -Canary $canary -ExpectedClaudeVersion '2.1.238' `
            -ExpectedCodexVersion '0.154.0' -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -NowUtc $script:Now } | Should -Throw '*claimed_sessions*'
    }

    It 'rejects retry replacement and respawn accounting' -ForEach @('retry_count', 'replacement_count', 'respawn_count') {
        $canary = New-DualCanary
        $canary.authorization_scope.$_ = 1
        { Assert-Evidence1DualRemoteAuthCanary -Canary $canary -ExpectedClaudeVersion '2.1.238' `
            -ExpectedCodexVersion '0.154.0' -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -NowUtc $script:Now } | Should -Throw '*invalid integer*'
    }

    It 'rejects fabricated Codex HTTP telemetry' {
        $canary = New-DualCanary
        $canary.providers[1].http_statuses = @(200)
        { Assert-Evidence1DualRemoteAuthCanary -Canary $canary -ExpectedClaudeVersion '2.1.238' `
            -ExpectedCodexVersion '0.154.0' -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -NowUtc $script:Now } | Should -Throw '*Codex HTTP telemetry contract mismatch*'
    }

    It 'rejects adulterated Claude HTTP telemetry' -ForEach @(
        @{ Statuses = @('429') },
        @{ Statuses = @(429, 429) },
        @{ Statuses = @(99) },
        @{ Statuses = @(418) }
    ) {
        $canary = New-DualCanary
        $canary.providers[0].http_statuses = $Statuses
        { Assert-Evidence1DualRemoteAuthCanary -Canary $canary -ExpectedClaudeVersion '2.1.238' `
            -ExpectedCodexVersion '0.154.0' -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -NowUtc $script:Now } | Should -Throw '*HTTP statuses*'
    }

    It 'rejects a Codex claim that tools were disabled instead of only observed unused' {
        $canary = New-DualCanary
        $canary.providers[1].tools_disabled = $true
        { Assert-Evidence1DualRemoteAuthCanary -Canary $canary -ExpectedClaudeVersion '2.1.238' `
            -ExpectedCodexVersion '0.154.0' -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -NowUtc $script:Now } | Should -Throw '*tools_disabled must remain null*'
    }

    It 'rejects closed-shape extras and model drift' -ForEach @('top', 'provider', 'terminal', 'privacy', 'events', 'model') {
        $canary = New-DualCanary
        switch ($_) {
            'top' { $canary.extra_raw = 'forbidden' }
            'provider' { $canary.providers[1].raw_jsonl = 'forbidden' }
            'terminal' { $canary.providers[1].terminal.raw = 'forbidden' }
            'privacy' { $canary.privacy.prompt = 'forbidden' }
            'events' { $canary.providers[1].event_type_counts.'raw.event' = 1 }
            'model' { $canary.providers[1].model = 'gpt-5' }
        }
        { Assert-Evidence1DualRemoteAuthCanary -Canary $canary -ExpectedClaudeVersion '2.1.238' `
            -ExpectedCodexVersion '0.154.0' -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -NowUtc $script:Now } | Should -Throw
    }

    It 'rejects parse errors tool use response mismatch and failed terminal events' -ForEach @(
        @{ Provider = 0; Field = 'parse_error_count'; Value = 1 },
        @{ Provider = 1; Field = 'tool_invocation_count'; Value = 1 },
        @{ Provider = 1; Field = 'response_matched'; Value = $false },
        @{ Provider = 1; Field = 'process_exit_code'; Value = 1 },
        @{ Provider = 0; Field = 'process_started'; Value = $false }
    ) {
        $canary = New-DualCanary
        $canary.providers[$Provider].$Field = $Value
        { Assert-Evidence1DualRemoteAuthCanary -Canary $canary -ExpectedClaudeVersion '2.1.238' `
            -ExpectedCodexVersion '0.154.0' -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -NowUtc $script:Now } | Should -Throw
    }

    It 'rejects stale and pre-readiness provider evidence' {
        $canary = New-DualCanary
        { Assert-Evidence1DualRemoteAuthCanary -Canary $canary -ExpectedClaudeVersion '2.1.238' `
            -ExpectedCodexVersion '0.154.0' -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -NowUtc $script:Now -MaxAgeMinutes 4 } | Should -Throw '*stale*'
        { Assert-Evidence1DualRemoteAuthCanary -Canary $canary -ExpectedClaudeVersion '2.1.238' `
            -ExpectedCodexVersion '0.154.0' -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -NowUtc $script:Now -NotBeforeUtc ([DateTime]::Parse('2026-09-11T11:56:00Z')) } |
            Should -Throw '*predates readiness*'
    }

    It 'binds the canary to the supplied readiness hashes and E2E identity' {
        $canary = New-DualCanary
        { Assert-Evidence1DualRemoteAuthCanary -Canary $canary -ExpectedClaudeVersion '2.1.238' `
            -ExpectedCodexVersion '0.154.0' -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -ExpectedHostReadinessSha256 ('f' * 64) -NowUtc $script:Now } |
            Should -Throw '*host readiness hash mismatch*'
        $canary.context.vm_id = '00000000-0000-0000-0000-000000000001'
        { Assert-Evidence1DualRemoteAuthCanary -Canary $canary -ExpectedClaudeVersion '2.1.238' `
            -ExpectedCodexVersion '0.154.0' -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -NowUtc $script:Now } | Should -Throw '*VM binding mismatch*'
    }
}

Describe 'Evidence1 dual-runtime live handoff gate' {
    # Overnight work order item A: the maintainer's decided fix. When an
    # expected Codex version is supplied, the dual auth host report MUST be
    # schema=2 and carry the full 12-key shape (account_binding_sha256,
    # model_pair, in addition to the 10 this fixture previously had).
    # schema=1 remains valid ONLY for the legacy, single-runtime,
    # no-Codex-expected shape -- a structurally DIFFERENT $AuthReport shape
    # entirely (verdict/vm_name/vm_state/guest_report, no top-level schema
    # field at all), not merely a different value of the same field. The
    # assertion's own strictness (Assert-Evidence1ExactKeys,
    # Assert-Evidence1ExactInteger) is correct and untouched here -- only
    # the producer (this file's own fixture, and separately
    # evidence1-hyperv-verify-guest-dual-auth-direct.ps1) was wrong.
    # (New-DualAuthHostReportFixture itself lives in the root BeforeAll --
    # a bare function inside a Describe is discovery-phase-only and
    # invisible to It blocks in the run phase, the same mistake already
    # made and documented twice elsewhere in this file's sibling test
    # files this engagement; caught here the same way, by running.)

    It 'requires schema 2 when an expected Codex version is supplied' {
        $commit = 'a' * 40
        $tree = 'b' * 40
        $source = 'c' * 40
        $attestation = 'C:\kmp-eval\measurement-scopes\evidence1-attestation.json'
        $readiness = [ordered]@{
            verdict = 'PASS'; generated_at_utc = '2026-09-11T11:50:00.000Z'
            vm_name = $script:VMName; vm_id = $script:VMId; vm_state = 'Running'; target_commit = $commit; target_tree = $tree
            guest = [ordered]@{
                verdict = 'PASS'; harness_head = $commit; harness_tree = $tree; source_head = $source
                planned_sessions = 8; attestation_path = $attestation; attestation_sha256 = 'd' * 64
                tools = [ordered]@{ claude = '2.1.238'; codex = 'codex-cli 0.154.0' }
            }
            privacy = [ordered]@{
                raw_transcript_content_read = $false; stderr_content_read = $false
                attestation_content_printed = $false; dry_run_stdout_printed = $false
            }
        }
        $auth = New-DualAuthHostReportFixture

        $result = Assert-Evidence1LiveHandoffEvidence -ReadinessReport $readiness -AuthReport $auth `
            -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -ExpectedReadinessSha256 ('a' * 64) -ExpectedCodexModel 'gpt-5.6-terra' -ExpectedTargetCommit $commit -ExpectedTargetTree $tree `
            -ExpectedSourceCommit $source -ExpectedClaudeVersion '2.1.238' -ExpectedCodexVersion '0.154.0' `
            -ExpectedAttestationPath $attestation -NowUtc $script:Now
        $result.ok | Should -BeTrue

        # The NESTED canary's own schema (a distinct field, always
        # schema=2-by-default from New-DualCanary) reverting to 1 must
        # still throw -- unchanged property, not this round's fix.
        $nestedMutated = New-DualAuthHostReportFixture
        $nestedMutated.remote_auth_canary.schema = 1
        { Assert-Evidence1LiveHandoffEvidence -ReadinessReport $readiness -AuthReport $nestedMutated `
            -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -ExpectedReadinessSha256 ('a' * 64) -ExpectedCodexModel 'gpt-5.6-terra' -ExpectedTargetCommit $commit -ExpectedTargetTree $tree `
            -ExpectedSourceCommit $source -ExpectedClaudeVersion '2.1.238' -ExpectedCodexVersion '0.154.0' `
            -ExpectedAttestationPath $attestation -NowUtc $script:Now } | Should -Throw

        # The OUTER report's own schema (this round's actual fix) reverting
        # to 1, with Codex still expected, must throw -- this is the direct,
        # unambiguous proof of the test's own name: "requires schema 2 when
        # an expected Codex version is supplied."
        $outerMutated = New-DualAuthHostReportFixture -Override @{ schema = 1 }
        { Assert-Evidence1LiveHandoffEvidence -ReadinessReport $readiness -AuthReport $outerMutated `
            -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -ExpectedReadinessSha256 ('a' * 64) -ExpectedCodexModel 'gpt-5.6-terra' -ExpectedTargetCommit $commit -ExpectedTargetTree $tree `
            -ExpectedSourceCommit $source -ExpectedClaudeVersion '2.1.238' -ExpectedCodexVersion '0.154.0' `
            -ExpectedAttestationPath $attestation -NowUtc $script:Now } | Should -Throw '*dual auth host report.schema has an invalid integer*'
    }

    It 'still accepts schema 1 for the legacy, single-runtime, no-Codex-expected shape (a structurally different report, not just a different schema value)' {
        # Mirrors Evidence1-HyperV-Live-Handoff.Tests.ps1's own
        # already-proven New-AuthReport/New-ReadinessReport fixtures (that
        # file's "Evidence1 live handoff evidence contract" Describe is
        # reconfirmed passing unchanged by this same round, see the
        # architecture note) -- reproduced compactly here, local to this
        # file, since this file is what the maintainer specifically asked
        # about. Deliberately calls WITHOUT -ExpectedCodexVersion, so
        # $expectedCodexCanonical is falsy and the LEGACY branch
        # (evidence1-live-handoff-contract.psm1:610+) runs instead of the
        # dual-auth 12-key branch this round's fix touches.
        $commit = 'a' * 40; $tree = 'b' * 40; $source = 'c' * 40
        $attestation = 'C:\kmp-eval\measurement-scopes\evidence1-attestation.json'
        $completedAt = '2026-09-11T11:56:00.000Z'
        $readiness = [ordered]@{
            verdict = 'PASS'; generated_at_utc = '2026-09-11T11:50:00.000Z'
            vm_name = $script:VMName; vm_state = 'Running'; target_commit = $commit; target_tree = $tree
            guest = [ordered]@{
                verdict = 'PASS'; harness_head = $commit; harness_tree = $tree; source_head = $source
                planned_sessions = 8; attestation_path = $attestation; attestation_sha256 = 'd' * 64
                tools = [ordered]@{ claude = '2.1.238' }
            }
            privacy = [ordered]@{
                raw_transcript_content_read = $false; stderr_content_read = $false
                attestation_content_printed = $false; dry_run_stdout_printed = $false
            }
        }
        $auth = [ordered]@{
            verdict = 'PASS'; generated_at_utc = $completedAt; vm_name = $script:VMName; vm_state = 'Running'
            guest_report = [ordered]@{
                verdict = 'PASS'; claude_version = '2.1.238'; credential_override_names = @()
                ssh_dir_present = $false; git_credentials_present = $false; gh_hosts_present = $false
                identity_fields_logged = $false
                remote_auth_canary = [ordered]@{
                    schema = 1; state = 'passed'; completed_at_utc = $completedAt
                    local_auth_status_exit_code = 0; process_exit_code = 0; claude_version = '2.1.238'
                    parse_error_count = 0; http_statuses = @(); credential_override_names = @()
                    terminal = [ordered]@{ present = $true; is_error = $false }
                    privacy = [ordered]@{
                        raw_content_persisted = $false; raw_content_printed = $false
                        raw_content_read_in_memory_for_sanitization = $true; error_text_persisted = $false
                    }
                }
            }
        }
        { Assert-Evidence1LiveHandoffEvidence -ReadinessReport $readiness -AuthReport $auth `
            -ExpectedVMName $script:VMName -ExpectedTargetCommit $commit -ExpectedTargetTree $tree `
            -ExpectedSourceCommit $source -ExpectedClaudeVersion '2.1.238' `
            -ExpectedAttestationPath $attestation -NowUtc $script:Now } | Should -Not -Throw
    }

    It 'the schema-2 shape carries no unhashed account identifiers, tokens, or credentials -- every identity field is already a hash or fingerprint' {
        # Operationalizes the maintainer's explicit requirement: enumerate
        # the exact 12 keys this round's fixture (and the real producer)
        # uses, and confirm none of them are raw-identifier-shaped. Every
        # identity-relevant field here is either a SHA-256 hex string
        # (readiness_sha256, account_binding_sha256), a non-secret GUID
        # (operation_id, vm_id), a non-secret label (vm_name, vm_state,
        # model names), a nested object whose OWN privacy sub-object this
        # same contract independently asserts is all-false
        # (remote_auth_canary, privacy), or model_pair (model NAMES only,
        # never an account).
        $auth = New-DualAuthHostReportFixture
        $forbiddenLookingKeys = @('email', 'username', 'user_name', 'password', 'token', 'api_key', 'apikey', 'account_id', 'user_id', 'oauth', 'bearer', 'secret', 'credential')
        foreach ($key in $auth.Keys) {
            foreach ($forbidden in $forbiddenLookingKeys) {
                $key.ToLowerInvariant() | Should -Not -Match $forbidden -Because "top-level key '$key' looks like it could carry an unhashed identifier"
            }
        }
        $auth.account_binding_sha256 | Should -Match '^[0-9a-f]{64}$' -Because 'account_binding_sha256 must already be a hash, never a raw account identifier'
        @($auth.model_pair.Keys | Sort-Object) -join ',' | Should -BeExactly 'campaign_kind,claude_model,codex_model' -Because 'model_pair carries only model NAMES, never an account or credential'
    }
}

Describe 'Evidence1 dual-auth producer (overnight work order item A): schema=2 with the full 12-key shape' {
    # evidence1-hyperv-verify-guest-dual-auth-direct.ps1 is #Requires
    # -RunAsAdministrator, real-Hyper-V-touching code -- never executed in
    # this engagement, not now either. Source-text proof only, the same
    # technique every other never-executed script's own test in this repo
    # already uses. Anchored to the SUCCESS-path $hostReport construction
    # specifically (the literal text immediately preceding
    # 'verdict = $(if ($canary.state -ceq ''passed'')'), not merely "does
    # the file contain 'schema = 2' anywhere" -- the catch-block's own
    # failure-path report is a separate, pre-existing, out-of-scope shape
    # issue (flagged in the architecture note, not fixed this round) and
    # deliberately not asserted on here.
    It 'the success-path $hostReport is schema=2, not schema=1' {
        $source = Get-Content -LiteralPath (Join-Path $script:AuditRoot 'evidence1-hyperv-verify-guest-dual-auth-direct.ps1') -Raw
        $source | Should -Match ([regex]::Escape('schema = 2; verdict = $(if ($canary.state -ceq ''passed'')'))
        $source | Should -Not -Match ([regex]::Escape('schema = 1; verdict = $(if ($canary.state -ceq ''passed'')'))
    }

    It 'the success-path $hostReport still carries account_binding_sha256 and model_pair (unchanged by this round, verified not assumed)' {
        $source = Get-Content -LiteralPath (Join-Path $script:AuditRoot 'evidence1-hyperv-verify-guest-dual-auth-direct.ps1') -Raw
        $source | Should -Match ([regex]::Escape('account_binding_sha256 = $accountBindingSha'))
        $source | Should -Match ([regex]::Escape('model_pair = [ordered]@{'))
    }
}

Describe 'Evidence1 dual-auth failure report contract (Task 2): Assert-Evidence1LiveHandoffFailureReport' {
    # The producer's CATCH block used to write a completely ad hoc,
    # schema=1, 9-key shape on failure. Task 2's design: the producer NEVER
    # emits schema=1 again (PASS or FAIL); FAIL gets its own explicit,
    # MINIMAL, schema=2 shape -- 11 keys, not the PASS shape's 12 -- since
    # PASS assumes data (vm_state, remote_auth_canary) that may not exist
    # yet when a failure happens. This Describe genuinely executes
    # Assert-Evidence1LiveHandoffFailureReport (a real .psm1 function, not a
    # replica) -- the strongest test surface available for this engagement.
    # (New-DualAuthFailureReportFixture itself lives in the root BeforeAll,
    # alongside New-DualAuthHostReportFixture -- see that function's own
    # comment there for why.)

    It 'accepts a well-formed FAIL report with null readiness/account_binding hashes (earliest failure point -- neither computed yet)' {
        $result = Assert-Evidence1LiveHandoffFailureReport -FailureReport (New-DualAuthFailureReportFixture) `
            -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId
        $result.ok | Should -BeTrue
        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -BeExactly 'dual_auth_failed_before_account_binding_loaded'
    }

    It 'accepts a well-formed FAIL report with real readiness/account_binding hashes (a later failure point -- both already computed)' {
        $failure = New-DualAuthFailureReportFixture -Override @{
            reason_code = 'dual_auth_failed_during_guest_execution'
            readiness_sha256 = ('a' * 64); account_binding_sha256 = ('b' * 64)
        }
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $failure -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } | Should -Not -Throw
    }

    It 'accepts every one of the 6 enumerated reason codes' -ForEach @(
        'dual_auth_failed_before_account_binding_loaded',
        'dual_auth_failed_after_account_binding_before_readiness',
        'dual_auth_failed_after_readiness_before_guest_operation',
        'dual_auth_failed_during_guest_execution',
        'dual_auth_failed_reading_guest_result',
        'dual_auth_failed_writing_completed_report'
    ) {
        $failure = New-DualAuthFailureReportFixture -Override @{ reason_code = $_ }
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $failure -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } | Should -Not -Throw
    }

    It 'rejects an unrecognized reason_code -- the enum is closed, not free text' {
        $failure = New-DualAuthFailureReportFixture -Override @{ reason_code = 'something_made_up' }
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $failure -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*reason_code is not a recognized enumerated value*'
    }

    It 'rejects schema 1 -- the FAIL shape is always schema 2, the producer never emits schema 1 again' {
        $failure = New-DualAuthFailureReportFixture -Override @{ schema = 1 }
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $failure -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*schema*'
    }

    It 'rejects a verdict other than FAIL' {
        $failure = New-DualAuthFailureReportFixture -Override @{ verdict = 'PASS' }
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $failure -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*verdict is not FAIL*'
    }

    It 'rejects the 12-key PASS shape outright -- proving this is a genuinely different, minimal shape, not the same one with a different verdict' {
        $passShape = New-DualAuthHostReportFixture -Override @{ verdict = 'FAIL' }
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $passShape -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*invalid shape*'
    }

    It 'rejects a non-hash-shaped value for a present readiness_sha256/account_binding_sha256 -- never a fabricated or placeholder-that-looks-real value' -ForEach @('readiness_sha256', 'account_binding_sha256') {
        $failure = New-DualAuthFailureReportFixture -Override @{ $_ = 'not-a-real-hash' }
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $failure -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*not a lowercase SHA-256*'
    }

    It 'rejects a VM identity mismatch' {
        $failure = New-DualAuthFailureReportFixture -Override @{ vm_id = '00000000-0000-0000-0000-000000000099' }
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $failure -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*VM identity mismatch*'
    }

    It 'rejects a non-canonical operation_id' {
        $failure = New-DualAuthFailureReportFixture -Override @{ operation_id = 'not-a-guid' }
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $failure -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*operation id is invalid*'
    }

    It 'rejects a model_pair claiming a different Codex model than expected' {
        $failure = New-DualAuthFailureReportFixture
        $failure.model_pair.codex_model = 'gpt-5.6-luna'
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $failure -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*model pair mismatch*'
    }

    It 'rejects a privacy section that is not all-false' -ForEach @('raw_content_persisted', 'raw_content_printed', 'error_text_persisted') {
        $failure = New-DualAuthFailureReportFixture
        $failure.privacy.$_ = $true
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $failure -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } | Should -Throw
    }

    It 'the FAIL shape carries no raw exception text, token, or other free-text field -- every key is an identifier, a hash, a closed enum, or a static/parameter-derived value' {
        $failure = New-DualAuthFailureReportFixture
        $forbiddenLookingKeys = @('message', 'exception', 'error_text', 'detail', 'stack', 'trace', 'email', 'token', 'api_key', 'oauth', 'bearer', 'secret', 'credential')
        foreach ($key in $failure.Keys) {
            foreach ($forbidden in $forbiddenLookingKeys) {
                $key.ToLowerInvariant() | Should -Not -Match $forbidden -Because "top-level key '$key' looks like it could carry free-text exception content"
            }
        }
    }
}

Describe 'Evidence1 dual-auth producer (Task 2): FAIL report shape per failure-injection point' {
    # evidence1-hyperv-verify-guest-dual-auth-direct.ps1 cannot be executed
    # (#Requires -RunAsAdministrator, real Get-VM/Invoke-Command -VMId
    # calls) -- same standing boundary as every other never-executed script
    # in this engagement. This replicates the catch block's own $stage ->
    # reason_code switch and FAIL-report hashtable construction BYTE-FOR-BYTE
    # (cited by file:line below so the correspondence can be checked by
    # reading, the same technique and the same caveat as every other
    # replicated-logic test in this repo -- e.g.
    # Evidence1-Run-Full-Campaign-Integration.Tests.ps1's own
    # Get-TestResumeIndex). Each resulting report is then validated through
    # the REAL, genuinely-executed Assert-Evidence1LiveHandoffFailureReport
    # -- so this is integration-level proof the replicated LOGIC produces a
    # contract-valid report at every one of the five distinct failure points
    # the task asked for, plus a sixth (writing the completed report) this
    # round added beyond the minimum for precision.
    # (Get-TestDualAuthFailureReasonCode/New-TestDualAuthFailureReport
    # themselves live in the root BeforeAll -- see
    # New-DualAuthFailureReportFixture's own comment there for why.)

    It 'failure before account binding is loaded: neither hash computed yet' {
        $report = New-TestDualAuthFailureReport 'before_account_binding_loaded' $null $null
        $report.reason_code | Should -BeExactly 'dual_auth_failed_before_account_binding_loaded'
        $report.readiness_sha256 | Should -BeNullOrEmpty
        $report.account_binding_sha256 | Should -BeNullOrEmpty
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } | Should -Not -Throw
    }

    It 'failure after account binding is loaded but before readiness: account_binding hash real, readiness still not computed' {
        $report = New-TestDualAuthFailureReport 'account_binding_loaded' $null ('c' * 64)
        $report.reason_code | Should -BeExactly 'dual_auth_failed_after_account_binding_before_readiness'
        $report.readiness_sha256 | Should -BeNullOrEmpty
        $report.account_binding_sha256 | Should -BeExactly ('c' * 64)
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } | Should -Not -Throw
    }

    It 'failure after readiness is obtained but before the guest operation: both hashes real' {
        $report = New-TestDualAuthFailureReport 'readiness_obtained' ('d' * 64) ('c' * 64)
        $report.reason_code | Should -BeExactly 'dual_auth_failed_after_readiness_before_guest_operation'
        $report.readiness_sha256 | Should -BeExactly ('d' * 64)
        $report.account_binding_sha256 | Should -BeExactly ('c' * 64)
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } | Should -Not -Throw
    }

    It 'failure during guest execution (Wait-Job timeout or abort/cleanup dance): both hashes real' {
        $report = New-TestDualAuthFailureReport 'guest_operation_dispatched' ('d' * 64) ('c' * 64)
        $report.reason_code | Should -BeExactly 'dual_auth_failed_during_guest_execution'
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } | Should -Not -Throw
    }

    It 'failure while reading back the guest result (Receive-Job or ConvertFrom-Json): both hashes real' {
        $report = New-TestDualAuthFailureReport 'guest_execution_completed' ('d' * 64) ('c' * 64)
        $report.reason_code | Should -BeExactly 'dual_auth_failed_reading_guest_result'
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } | Should -Not -Throw
    }

    It 'failure while writing the completed report (beyond the 5 named points -- this round''s own added precision): both hashes real' {
        $report = New-TestDualAuthFailureReport 'writing_completed_report' ('d' * 64) ('c' * 64)
        $report.reason_code | Should -BeExactly 'dual_auth_failed_writing_completed_report'
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } | Should -Not -Throw
    }

    It 'an unrecognized stage value falls back to the earliest, most conservative reason code rather than throwing or fabricating one -- defensive, should never actually occur' {
        (Get-TestDualAuthFailureReasonCode 'some_future_stage_not_yet_mapped') | Should -BeExactly 'dual_auth_failed_before_account_binding_loaded'
    }
}

Describe 'Evidence1 dual-auth producer (Task 2): source wiring for the FAIL report shape' {
    # Source-scan proof the fix landed in the right place -- same technique
    # the "overnight work order item A" Describe above already established
    # for the success-path schema=2 fix.

    BeforeAll {
        $script:ProducerSource = (Get-Content -LiteralPath (Join-Path $script:AuditRoot 'evidence1-hyperv-verify-guest-dual-auth-direct.ps1') -Raw) -replace "`r`n", "`n"
    }

    It 'the catch block builds its FAIL report through the shared New-Evidence1DualAuthFailureReport builder (Task 3), passing the mapped reason code through -- not hand-building the hashtable inline anymore' {
        $script:ProducerSource | Should -Match ([regex]::Escape('New-Evidence1DualAuthFailureReport -ReasonCode $failureReasonCode'))
        $script:ProducerSource | Should -Not -Match ([regex]::Escape('schema = 2; verdict = ''FAIL''; reason_code = $failureReasonCode'))
    }

    It 'the catch block imports evidence1-live-handoff-contract.psm1 so New-Evidence1DualAuthFailureReport is actually resolvable at the call site' {
        $script:ProducerSource | Should -Match ([regex]::Escape("Import-Module (Join-Path `$PSScriptRoot 'evidence1-live-handoff-contract.psm1')"))
    }

    It 'every one of the 6 enumerated reason codes appears in the catch block''s switch statement' -ForEach @(
        'dual_auth_failed_before_account_binding_loaded',
        'dual_auth_failed_after_account_binding_before_readiness',
        'dual_auth_failed_after_readiness_before_guest_operation',
        'dual_auth_failed_during_guest_execution',
        'dual_auth_failed_reading_guest_result',
        'dual_auth_failed_writing_completed_report'
    ) {
        $script:ProducerSource | Should -Match ([regex]::Escape("'$_'"))
    }

    It 'the catch block still guards against writing over already-present evidence -- the null-hostReport-and-no-existing-file check is unchanged' {
        $script:ProducerSource | Should -Match ([regex]::Escape('if ($null -eq $hostReport -and -not (Test-Path -LiteralPath $hostFinalPath)) {'))
    }

    It 'the try block now starts before account-binding validation, not after it (Task 2''s restructuring landed in the right place)' {
        $tryIndex = $script:ProducerSource.IndexOf("`ntry {`n")
        $accountBindingCheckIndex = $script:ProducerSource.IndexOf('account_binding_report_missing')
        $tryIndex | Should -BeGreaterThan 0
        $tryIndex | Should -BeLessThan $accountBindingCheckIndex -Because 'account-binding validation must now be INSIDE the try, not before it'
    }

    It 'the FAIL report never includes vm_state or remote_auth_canary -- the two PASS-only fields that assume data which may not exist yet when a failure happens' {
        # Anchored on the catch block's own unique comment marker, NOT the
        # bare '} catch {' substring -- Stop-E1JobBounded (near the top of
        # this file) has its own, unrelated '} catch { return $false }',
        # which would make IndexOf('} catch {') find THAT one first and
        # sweep the intervening success-path $hostReport construction
        # (which legitimately DOES set vm_state) into the "catch block"
        # substring, false-failing this exact test. Caught by checking
        # Select-String for the literal token before trusting IndexOf here.
        $catchIndex = $script:ProducerSource.IndexOf('# FAIL report design (Task 2')
        $catchIndex | Should -BeGreaterThan 0 -Because 'the catch block''s own design-rationale comment must be present'
        $catchBlockSource = $script:ProducerSource.Substring($catchIndex)
        $catchBlockSource | Should -Not -Match 'vm_state\s*='
        $catchBlockSource | Should -Not -Match 'remote_auth_canary\s*='
    }

    It 'the catch block never references the caught exception''s own message or $Error -- the reason_code can never leak free-text exception content' {
        $catchIndex = $script:ProducerSource.IndexOf('# FAIL report design (Task 2')
        $catchIndex | Should -BeGreaterThan 0
        $catchBlockSource = $script:ProducerSource.Substring($catchIndex)
        $catchBlockSource | Should -Not -Match '\$_\.'
        $catchBlockSource | Should -Not -Match '\$Error\['
        $catchBlockSource | Should -Not -Match '\.Exception\.Message'
    }
}

Describe 'Evidence1 dual-auth producer (Task 2): write-failure fail-closed properties (failure-injection point 5)' {
    # "failure while trying to WRITE the failure report itself -- confirm
    # there is always a terminal, machine-readable outcome ... and confirm
    # nothing ever silently overwrites evidence already present on disk."
    # Write-CreateNewJson (evidence1-hyperv-verify-guest-dual-auth-direct.ps1's
    # own helper) is small and self-contained enough to replicate exactly
    # and exercise directly, rather than only reasoning about it -- this
    # proves both properties concretely against the SAME mechanism
    # (IO.FileMode.CreateNew) the real code relies on, not a restatement of
    # the claim. (Write-TestCreateNewJson itself lives in the root
    # BeforeAll -- see New-DualAuthFailureReportFixture's own comment
    # there for why.)

    It 'throws (a terminal, machine-readable outcome) when the destination already exists, rather than silently succeeding' {
        $path = Join-Path $TestDrive 'write-failure-test\host-final.json'
        Write-TestCreateNewJson $path ([ordered]@{ marker = 'original' })
        { Write-TestCreateNewJson $path ([ordered]@{ marker = 'a second, different write attempt' }) } | Should -Throw
    }

    It 'never overwrites the original content when a second write to the same path is attempted' {
        $path = Join-Path $TestDrive 'write-failure-test-2\host-final.json'
        Write-TestCreateNewJson $path ([ordered]@{ marker = 'original-evidence' })
        try { Write-TestCreateNewJson $path ([ordered]@{ marker = 'a torn or replacement write' }) } catch { }
        (Get-Content -LiteralPath $path -Raw) | Should -Match 'original-evidence'
        (Get-Content -LiteralPath $path -Raw) | Should -Not -Match 'torn or replacement'
    }
}

Describe 'Evidence1 dual-auth failure report builder (Task 3): New-Evidence1DualAuthFailureReport is real, callable, pure' {
    # Unlike every prior round's verification of the FAIL path (source-scan
    # and hand-replicated logic only, per this whole engagement's standing
    # never-execute-the-producer boundary), this Describe calls the REAL,
    # exported New-Evidence1DualAuthFailureReport function directly and
    # asserts on its actual return value -- genuinely executed production
    # code, not a replica, while still never touching the producer script
    # itself (which remains #Requires -RunAsAdministrator, real-Hyper-V
    # code, never executed in this engagement).

    It 'builds a valid, self-consistent FAIL report from explicit data, accepted by the existing Assert-Evidence1LiveHandoffFailureReport unchanged' {
        $now = [DateTime]::Parse('2026-09-19T10:00:00.000Z').ToUniversalTime()
        $report = New-Evidence1DualAuthFailureReport -ReasonCode 'dual_auth_failed_during_guest_execution' `
            -OperationId '22222222-2222-4222-8222-222222222222' -VMName $script:VMName -VMId $script:VMId `
            -ReadinessSha256 ('d' * 64) -AccountBindingSha256 ('c' * 64) `
            -ModelPairCanary:$false -ClaudeModel 'claude-sonnet-5' -CodexModel 'gpt-5.6-terra' -NowUtc $now

        $report.schema | Should -Be 2
        $report.verdict | Should -BeExactly 'FAIL'
        $report.reason_code | Should -BeExactly 'dual_auth_failed_during_guest_execution'
        $report.generated_at_utc | Should -BeExactly '2026-09-19T10:00:00.000Z'
        $report.operation_id | Should -BeExactly '22222222-2222-4222-8222-222222222222'
        $report.vm_name | Should -BeExactly $script:VMName
        $report.vm_id | Should -BeExactly $script:VMId
        $report.readiness_sha256 | Should -BeExactly ('d' * 64)
        $report.account_binding_sha256 | Should -BeExactly ('c' * 64)
        $report.model_pair.campaign_kind | Should -BeExactly 'canonical-auth-canary'
        $report.model_pair.claude_model | Should -BeExactly 'claude-sonnet-5'
        $report.model_pair.codex_model | Should -BeExactly 'gpt-5.6-terra'
        @($report.Keys).Count | Should -Be 11

        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } | Should -Not -Throw
    }

    It 'builds the paired-model-availability-canary campaign_kind when -ModelPairCanary is set' {
        # ClaudeModel stays 'claude-sonnet-5' here -- Assert-Evidence1LiveHandoffFailureReport's
        # own claude_model check is hardcoded to that one value (pre-existing,
        # not something this task touches; confirmed by reading its source),
        # so only CodexModel is varied to prove the campaign_kind mapping
        # without tripping that unrelated, already-existing constraint.
        $report = New-Evidence1DualAuthFailureReport -ReasonCode 'dual_auth_failed_before_account_binding_loaded' `
            -OperationId '22222222-2222-4222-8222-222222222222' -VMName $script:VMName -VMId $script:VMId `
            -ModelPairCanary $true -ClaudeModel 'claude-sonnet-5' -CodexModel 'gpt-5.6-luna'
        $report.model_pair.campaign_kind | Should -BeExactly 'paired-model-availability-canary'
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId -ExpectedCodexModel 'gpt-5.6-luna' } | Should -Not -Throw
    }

    It 'leaves readiness_sha256/account_binding_sha256 explicit $null when neither was supplied -- never a fabricated hash' {
        $report = New-Evidence1DualAuthFailureReport -ReasonCode 'dual_auth_failed_before_account_binding_loaded' `
            -OperationId '22222222-2222-4222-8222-222222222222' -VMName $script:VMName -VMId $script:VMId `
            -ClaudeModel 'claude-sonnet-5' -CodexModel 'gpt-5.6-terra'
        $report.readiness_sha256 | Should -BeNullOrEmpty
        $report.account_binding_sha256 | Should -BeNullOrEmpty
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } | Should -Not -Throw
    }

    It 'rejects an unrecognized reason_code -- the enum is closed inside the builder too, not just the validator' {
        { New-Evidence1DualAuthFailureReport -ReasonCode 'something_made_up_by_a_caller' `
            -OperationId '22222222-2222-4222-8222-222222222222' -VMName $script:VMName -VMId $script:VMId `
            -ClaudeModel 'claude-sonnet-5' -CodexModel 'gpt-5.6-terra' } |
            Should -Throw '*reason_code is not a recognized enumerated value*'
    }

    It 'rejects a non-canonical operation_id' {
        { New-Evidence1DualAuthFailureReport -ReasonCode 'dual_auth_failed_before_account_binding_loaded' `
            -OperationId 'not-a-guid' -VMName $script:VMName -VMId $script:VMId `
            -ClaudeModel 'claude-sonnet-5' -CodexModel 'gpt-5.6-terra' } |
            Should -Throw '*operation id is invalid*'
    }

    It 'rejects a non-hash-shaped readiness_sha256/account_binding_sha256 -- never a fabricated or placeholder-that-looks-real value' -ForEach @('ReadinessSha256', 'AccountBindingSha256') {
        $params = @{
            ReasonCode = 'dual_auth_failed_during_guest_execution'
            OperationId = '22222222-2222-4222-8222-222222222222'; VMName = $script:VMName; VMId = $script:VMId
            ClaudeModel = 'claude-sonnet-5'; CodexModel = 'gpt-5.6-terra'
        }
        $params[$_] = 'not-a-real-hash'
        { New-Evidence1DualAuthFailureReport @params } | Should -Throw '*not a lowercase SHA-256*'
    }

    It 'rejects an empty vm_name / vm_id / claude_model / codex_model' -ForEach @('VMName', 'VMId', 'ClaudeModel', 'CodexModel') {
        $params = @{
            ReasonCode = 'dual_auth_failed_before_account_binding_loaded'
            OperationId = '22222222-2222-4222-8222-222222222222'; VMName = $script:VMName; VMId = $script:VMId
            ClaudeModel = 'claude-sonnet-5'; CodexModel = 'gpt-5.6-terra'
        }
        $params[$_] = ''
        { New-Evidence1DualAuthFailureReport @params } | Should -Throw
    }
}

Describe 'Evidence1 dual-auth failure report builder (Task 3): refuses an exception/error-record value for any data parameter -- a real, structural rejection' {
    # This is the concrete demonstration of the type-level/validation-level
    # guarantee: a careless future caller passing $_ or $_.Exception instead
    # of an already-computed hash/identity string must be rejected outright,
    # never silently .ToString()'d into the persisted report. Produced by
    # actually throwing and catching a real exception, not a hand-built
    # ErrorRecord-shaped stand-in.

    BeforeAll {
        try { throw 'a genuinely thrown test exception, never persisted' }
        catch { $script:CaughtError = $_ }
    }

    It 'rejects a caught ErrorRecord ($_) supplied as ReadinessSha256' {
        { New-Evidence1DualAuthFailureReport -ReasonCode 'dual_auth_failed_during_guest_execution' `
            -OperationId '22222222-2222-4222-8222-222222222222' -VMName $script:VMName -VMId $script:VMId `
            -ReadinessSha256 $script:CaughtError -ClaudeModel 'claude-sonnet-5' -CodexModel 'gpt-5.6-terra' } |
            Should -Throw '*refuses an exception or error-record value*'
    }

    It 'rejects the underlying .Exception object supplied as AccountBindingSha256' {
        { New-Evidence1DualAuthFailureReport -ReasonCode 'dual_auth_failed_during_guest_execution' `
            -OperationId '22222222-2222-4222-8222-222222222222' -VMName $script:VMName -VMId $script:VMId `
            -AccountBindingSha256 $script:CaughtError.Exception -ClaudeModel 'claude-sonnet-5' -CodexModel 'gpt-5.6-terra' } |
            Should -Throw '*refuses an exception or error-record value*'
    }

    It 'rejects an ErrorRecord supplied as ReasonCode, OperationId, VMName, VMId, ClaudeModel, or CodexModel' -ForEach @('ReasonCode', 'OperationId', 'VMName', 'VMId', 'ClaudeModel', 'CodexModel') {
        $params = @{
            ReasonCode = 'dual_auth_failed_before_account_binding_loaded'
            OperationId = '22222222-2222-4222-8222-222222222222'; VMName = $script:VMName; VMId = $script:VMId
            ClaudeModel = 'claude-sonnet-5'; CodexModel = 'gpt-5.6-terra'
        }
        $params[$_] = $script:CaughtError
        { New-Evidence1DualAuthFailureReport @params } | Should -Throw '*refuses an exception or error-record value*'
    }

    It 'the resulting rejection message never contains the original exception''s own text -- proving the guard fires on TYPE, not on inspecting/reformatting the message' {
        try {
            New-Evidence1DualAuthFailureReport -ReasonCode 'dual_auth_failed_during_guest_execution' `
                -OperationId '22222222-2222-4222-8222-222222222222' -VMName $script:VMName -VMId $script:VMId `
                -ReadinessSha256 $script:CaughtError -ClaudeModel 'claude-sonnet-5' -CodexModel 'gpt-5.6-terra'
            throw 'expected New-Evidence1DualAuthFailureReport to throw'
        } catch {
            $_.Exception.Message | Should -Not -Match 'a genuinely thrown test exception'
        }
    }
}

Describe 'Evidence1 dual-auth failure report builder (Task 3): create-new atomic write behavior' {
    # "Test ... the create-new atomic write behavior using $TestDrive (write
    # once, confirm a second write to the same path throws without touching
    # the first file's content)" -- exercised against the BUILDER's own real
    # output (not a hand-built fixture), through the same
    # Write-CreateNewJson-shaped mechanism the real producer relies on
    # (Write-TestCreateNewJson, defined in the root BeforeAll -- byte-for-byte
    # replica of the producer's own helper, same technique this file already
    # established for Describe 'Evidence1 dual-auth producer (Task 2):
    # write-failure fail-closed properties').

    It 'writes the builder''s output once, and a second write to the same path throws without touching the first file''s content -- the meta failure-injection point: the FAIL report''s own publication failing' {
        $path = Join-Path $TestDrive 'builder-atomic-write-test\host-final.json'
        $firstReport = New-Evidence1DualAuthFailureReport -ReasonCode 'dual_auth_failed_writing_completed_report' `
            -OperationId '33333333-3333-4333-8333-333333333333' -VMName $script:VMName -VMId $script:VMId `
            -ReadinessSha256 ('d' * 64) -AccountBindingSha256 ('c' * 64) `
            -ClaudeModel 'claude-sonnet-5' -CodexModel 'gpt-5.6-terra'
        Write-TestCreateNewJson $path $firstReport

        $secondReport = New-Evidence1DualAuthFailureReport -ReasonCode 'dual_auth_failed_reading_guest_result' `
            -OperationId '33333333-3333-4333-8333-333333333333' -VMName $script:VMName -VMId $script:VMId `
            -ReadinessSha256 ('d' * 64) -AccountBindingSha256 ('c' * 64) `
            -ClaudeModel 'claude-sonnet-5' -CodexModel 'gpt-5.6-terra'
        { Write-TestCreateNewJson $path $secondReport } | Should -Throw

        $persisted = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        $persisted.reason_code | Should -BeExactly 'dual_auth_failed_writing_completed_report' -Because 'the first, already-durable report must never be silently replaced by a later write attempt'
    }
}

Describe 'Evidence1 dual-auth failure report builder (Task 3): simulated failure at each of the five named injection points, using the builder directly' {
    # "Simulate failure at each of: account-binding load, readiness load,
    # guest invocation, result parsing, and failure-report publication
    # itself ... using the builder function directly, not by trying to
    # execute the whole privileged script." Each It below stands in for one
    # named checkpoint failing -- the same $stage -> reason_code mapping the
    # producer's own catch block computes (Get-TestDualAuthFailureReasonCode,
    # root BeforeAll) is used to pick the reason_code, then the builder is
    # called with exactly the data that checkpoint would genuinely have on
    # hand at that point in the real script (readiness/account-binding
    # hashes real only once actually computed). The fifth point (failure
    # publishing the FAIL report itself) is covered by the dedicated
    # create-new atomic-write Describe above, which is the same property
    # restated precisely rather than a sixth copy of it here.

    It '1: account-binding load fails -- neither hash exists yet' {
        $report = New-Evidence1DualAuthFailureReport -ReasonCode (Get-TestDualAuthFailureReasonCode 'before_account_binding_loaded') `
            -OperationId '44444444-4444-4444-8444-444444444444' -VMName $script:VMName -VMId $script:VMId `
            -ClaudeModel 'claude-sonnet-5' -CodexModel 'gpt-5.6-terra'
        $report.reason_code | Should -BeExactly 'dual_auth_failed_before_account_binding_loaded'
        $report.readiness_sha256 | Should -BeNullOrEmpty
        $report.account_binding_sha256 | Should -BeNullOrEmpty
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } | Should -Not -Throw
    }

    It '2: readiness load fails -- account_binding hash real, readiness hash still not computed' {
        $report = New-Evidence1DualAuthFailureReport -ReasonCode (Get-TestDualAuthFailureReasonCode 'account_binding_loaded') `
            -OperationId '44444444-4444-4444-8444-444444444444' -VMName $script:VMName -VMId $script:VMId `
            -AccountBindingSha256 ('c' * 64) -ClaudeModel 'claude-sonnet-5' -CodexModel 'gpt-5.6-terra'
        $report.reason_code | Should -BeExactly 'dual_auth_failed_after_account_binding_before_readiness'
        $report.readiness_sha256 | Should -BeNullOrEmpty
        $report.account_binding_sha256 | Should -BeExactly ('c' * 64)
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } | Should -Not -Throw
    }

    It '3: guest invocation fails -- both hashes real, the guest operation itself never completed' {
        $report = New-Evidence1DualAuthFailureReport -ReasonCode (Get-TestDualAuthFailureReasonCode 'guest_operation_dispatched') `
            -OperationId '44444444-4444-4444-8444-444444444444' -VMName $script:VMName -VMId $script:VMId `
            -ReadinessSha256 ('d' * 64) -AccountBindingSha256 ('c' * 64) -ClaudeModel 'claude-sonnet-5' -CodexModel 'gpt-5.6-terra'
        $report.reason_code | Should -BeExactly 'dual_auth_failed_during_guest_execution'
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } | Should -Not -Throw
    }

    It '4: result parsing fails -- guest execution completed but Receive-Job/ConvertFrom-Json on the result did not' {
        $report = New-Evidence1DualAuthFailureReport -ReasonCode (Get-TestDualAuthFailureReasonCode 'guest_execution_completed') `
            -OperationId '44444444-4444-4444-8444-444444444444' -VMName $script:VMName -VMId $script:VMId `
            -ReadinessSha256 ('d' * 64) -AccountBindingSha256 ('c' * 64) -ClaudeModel 'claude-sonnet-5' -CodexModel 'gpt-5.6-terra'
        $report.reason_code | Should -BeExactly 'dual_auth_failed_reading_guest_result'
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } | Should -Not -Throw
    }

    It '5: failure-report publication itself fails -- see the dedicated create-new atomic-write Describe above for the concrete meta-case proof' {
        $report = New-Evidence1DualAuthFailureReport -ReasonCode (Get-TestDualAuthFailureReasonCode 'guest_result_read') `
            -OperationId '44444444-4444-4444-8444-444444444444' -VMName $script:VMName -VMId $script:VMId `
            -ReadinessSha256 ('d' * 64) -AccountBindingSha256 ('c' * 64) -ClaudeModel 'claude-sonnet-5' -CodexModel 'gpt-5.6-terra'
        $report.reason_code | Should -BeExactly 'dual_auth_failed_writing_completed_report'
        { Assert-Evidence1LiveHandoffFailureReport -FailureReport $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } | Should -Not -Throw
    }
}

Describe 'Evidence1 dual-auth centralized report parser (Task 2): Resolve-Evidence1DualAuthHostReportVerdict -- envelope and schema/verdict discrimination' {
    # "Validates the common envelope first ... Reads schema and verdict ONLY,
    # before anything else ... Rejects any unrecognized schema, verdict, or
    # key outright." This codebase's own established Assert-* idiom throws
    # rather than returning a boolean -- every genuinely malformed/
    # unrecognized input case below is proven by Should -Throw with the
    # exact, stable reason code, never a silently-returned false.

    It 'rejects $null outright' {
        { Resolve-Evidence1DualAuthHostReportVerdict -Report $null -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*dual_auth_host_report_envelope_unrecognized*'
    }

    It 'rejects a value that is not a dictionary or object at all (a bare string)' {
        { Resolve-Evidence1DualAuthHostReportVerdict -Report 'not even an object' -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*dual_auth_host_report_envelope_unrecognized*'
    }

    It 'rejects an object missing the schema key entirely' {
        $report = New-DualAuthHostReportFixture
        $report.Remove('schema')
        { Resolve-Evidence1DualAuthHostReportVerdict -Report $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*dual_auth_host_report_envelope_unrecognized*'
    }

    It 'rejects an object missing the verdict key entirely' {
        $report = New-DualAuthHostReportFixture
        $report.Remove('verdict')
        { Resolve-Evidence1DualAuthHostReportVerdict -Report $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*dual_auth_host_report_envelope_unrecognized*'
    }

    It 'rejects an unsupported schema value' -ForEach @(1, 3, 0) {
        $report = New-DualAuthFailureReportFixture -Override @{ schema = $_ }
        { Resolve-Evidence1DualAuthHostReportVerdict -Report $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*dual_auth_host_report_schema_unsupported*'
    }

    It 'rejects a non-integer schema value' {
        $report = New-DualAuthFailureReportFixture -Override @{ schema = '2' }
        { Resolve-Evidence1DualAuthHostReportVerdict -Report $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*dual_auth_host_report_schema_unsupported*'
    }

    It 'rejects an unrecognized verdict value' {
        $report = New-DualAuthFailureReportFixture -Override @{ verdict = 'MAYBE' }
        { Resolve-Evidence1DualAuthHostReportVerdict -Report $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*dual_auth_host_report_verdict_unrecognized*'
    }

    It 'rejects a lowercase verdict -- case-sensitive, "pass"/"fail" are not "PASS"/"FAIL"' -ForEach @('pass', 'fail') {
        $report = New-DualAuthFailureReportFixture -Override @{ verdict = $_ }
        { Resolve-Evidence1DualAuthHostReportVerdict -Report $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*dual_auth_host_report_verdict_unrecognized*'
    }
}

Describe 'Evidence1 dual-auth centralized report parser (Task 2): FAIL branch -- reuses Assert-Evidence1LiveHandoffFailureReport, never touches PASS-only fields' {
    It 'accepts a real, well-formed FAIL report and returns a discriminated result with the reason_code' {
        $report = New-DualAuthFailureReportFixture
        $result = Resolve-Evidence1DualAuthHostReportVerdict -Report $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId
        $result.ok | Should -BeTrue
        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -BeExactly 'dual_auth_failed_before_account_binding_loaded'
        $result.operation_id | Should -BeExactly '11111111-1111-4111-8111-111111111111'
        $result.vm_name | Should -BeExactly $script:VMName
        $result.vm_id | Should -BeExactly $script:VMId
    }

    It 'the FAIL branch result contains ONLY ok/verdict/reason_code/operation_id/vm_name/vm_id -- no PASS-only key is present, enforced by the return shape itself, not caller discipline' {
        $report = New-DualAuthFailureReportFixture
        $result = Resolve-Evidence1DualAuthHostReportVerdict -Report $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId
        $expectedFailKeys = @('ok', 'verdict', 'reason_code', 'operation_id', 'vm_name', 'vm_id')
        @($result.Keys | Sort-Object) | Should -Be @($expectedFailKeys | Sort-Object)
        $result.Keys | Should -Not -Contain 'vm_state'
        $result.Keys | Should -Not -Contain 'remote_auth_canary'
        $result.Keys | Should -Not -Contain 'readiness_sha256'
        $result.Keys | Should -Not -Contain 'account_binding_sha256'
        $result.Keys | Should -Not -Contain 'model_pair'
    }

    It 'works for every one of the 6 enumerated reason codes' -ForEach @(
        'dual_auth_failed_before_account_binding_loaded',
        'dual_auth_failed_after_account_binding_before_readiness',
        'dual_auth_failed_after_readiness_before_guest_operation',
        'dual_auth_failed_during_guest_execution',
        'dual_auth_failed_reading_guest_result',
        'dual_auth_failed_writing_completed_report'
    ) {
        $report = New-DualAuthFailureReportFixture -Override @{ reason_code = $_ }
        $result = Resolve-Evidence1DualAuthHostReportVerdict -Report $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId
        $result.reason_code | Should -BeExactly $_
    }

    It 'genuinely reuses Assert-Evidence1LiveHandoffFailureReport -- a malformed FAIL report (bad VM identity) is rejected the exact same way that function rejects it directly' {
        $report = New-DualAuthFailureReportFixture -Override @{ vm_id = '00000000-0000-0000-0000-000000000099' }
        { Resolve-Evidence1DualAuthHostReportVerdict -Report $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*VM identity mismatch*'
    }

    It 'genuinely reuses Assert-Evidence1LiveHandoffFailureReport -- an unrecognized reason_code is rejected' {
        $report = New-DualAuthFailureReportFixture -Override @{ reason_code = 'something_made_up' }
        { Resolve-Evidence1DualAuthHostReportVerdict -Report $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId } |
            Should -Throw '*reason_code is not a recognized enumerated value*'
    }

    It 'threads -ExpectedClaudeModel/-ExpectedCodexModel through, working for a non-balanced model-availability tier (the multi-tier consumer''s real need)' {
        $report = New-DualAuthFailureReportFixture -Override @{
            model_pair = [ordered]@{ campaign_kind = 'paired-model-availability-canary'; claude_model = 'claude-opus-5'; codex_model = 'gpt-5.6-sol' }
        }
        $result = Resolve-Evidence1DualAuthHostReportVerdict -Report $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
            -ExpectedClaudeModel 'claude-opus-5' -ExpectedCodexModel 'gpt-5.6-sol'
        $result.ok | Should -BeTrue
        $result.verdict | Should -BeExactly 'FAIL'
    }
}

Describe 'Evidence1 dual-auth centralized report parser (Task 2): PASS branch -- reuses the shared shape assert, fully populated only once confirmed' {
    BeforeAll {
        $script:PassResultExpectedKeys = @(
            'ok', 'verdict', 'reason_code', 'operation_id', 'vm_name', 'vm_id', 'vm_state',
            'readiness_sha256', 'account_binding_sha256', 'remote_auth_canary', 'model_pair'
        )
    }

    It 'accepts a real, well-formed PASS report when the correct -ExpectedReadinessSha256 is supplied' {
        $report = New-DualAuthHostReportFixture
        $result = Resolve-Evidence1DualAuthHostReportVerdict -Report $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId -ExpectedReadinessSha256 ('a' * 64)
        $result.ok | Should -BeTrue
        $result.verdict | Should -BeExactly 'PASS'
        $result.reason_code | Should -BeNullOrEmpty
        $result.vm_state | Should -BeExactly 'Running'
        $result.readiness_sha256 | Should -BeExactly ('a' * 64)
        $result.account_binding_sha256 | Should -BeExactly ('9' * 64)
        $result.remote_auth_canary | Should -Not -BeNullOrEmpty
        $result.model_pair.claude_model | Should -BeExactly 'claude-sonnet-5'
        @($result.Keys | Sort-Object) | Should -Be @($script:PassResultExpectedKeys | Sort-Object)
    }

    It 'accepts a current PASS report without binding it to mutable readiness bytes' {
        $report = New-DualAuthHostReportFixture
        $result = Resolve-Evidence1DualAuthHostReportVerdict -Report $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId
        $result.verdict | Should -BeExactly 'PASS'
    }

    It 'still honors an explicit readiness comparison for legacy callers' {
        $report = New-DualAuthHostReportFixture
        { Resolve-Evidence1DualAuthHostReportVerdict -Report $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId -ExpectedReadinessSha256 ('b' * 64) } |
            Should -Throw '*dual auth host report binding mismatch*'
    }

    It 'genuinely reuses the shared shape assert -- a malformed PASS report (12-key shape violated) is rejected' {
        $report = New-DualAuthHostReportFixture
        $report.Remove('vm_state')
        { Resolve-Evidence1DualAuthHostReportVerdict -Report $report -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId -ExpectedReadinessSha256 ('a' * 64) } |
            Should -Throw
    }

    It 'never returns a PASS-shaped result for a FAIL report, and never returns a FAIL-shaped result for a PASS report -- the two branches are genuinely distinct, not the same object with an ignored extra field' {
        $failReport = New-DualAuthFailureReportFixture
        $failResult = Resolve-Evidence1DualAuthHostReportVerdict -Report $failReport -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId
        $failResult.Keys | Should -Not -Contain 'vm_state'

        $passReport = New-DualAuthHostReportFixture
        $passResult = Resolve-Evidence1DualAuthHostReportVerdict -Report $passReport -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId -ExpectedReadinessSha256 ('a' * 64)
        $passResult.Keys | Should -Contain 'vm_state'
    }
}

Describe 'Evidence1 dual-auth centralized report parser (Task 2): never exposes exception content, OAuth material, tokens, or remote content' {
    It 'a malformed report''s rejection never leaks .Exception.Message-shaped free text -- only the stable, closed reason codes this function itself defines' {
        try {
            Resolve-Evidence1DualAuthHostReportVerdict -Report ([ordered]@{ schema = 2; verdict = 'FAIL'; extra_unexpected_field = 'forbidden' }) `
                -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId
            throw 'expected a throw'
        } catch {
            $_.Exception.Message | Should -Match '^(dual_auth_host_report_|dual auth failure report)'
        }
    }

    It 'the function source never references $_.  $Error[ or .Exception.Message -- it cannot leak caught-exception content because it never reads any' {
        $source = Get-Content -LiteralPath (Join-Path $script:AuditRoot 'evidence1-live-handoff-contract.psm1') -Raw
        $bodyStart = $source.IndexOf('function Resolve-Evidence1DualAuthHostReportVerdict')
        $bodyEnd = $source.IndexOf('function Get-Evidence1ObjectKeys')
        $bodyStart | Should -BeGreaterThan 0
        $bodyEnd | Should -BeGreaterThan $bodyStart
        $body = $source.Substring($bodyStart, $bodyEnd - $bodyStart)
        $body | Should -Not -Match '\$_\.'
        $body | Should -Not -Match '\$Error\['
        $body | Should -Not -Match '\.Exception\.Message'
    }
}

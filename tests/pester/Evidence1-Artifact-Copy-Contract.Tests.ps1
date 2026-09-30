BeforeAll {
    # Import inside BeforeAll, not bare top-level -- see
    # Evidence1-Network-Backend-Contract.Tests.ps1's BeforeAll comment for
    # why (Pester 5 runs every file's top-level code during discovery,
    # before any file's It blocks; used uniformly across all Evidence1 test
    # files for consistency even where no identically-named sibling module
    # makes cross-file shadowing an active risk).
    $script:ModulePath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits/evidence1-artifact-copy-contract.psm1'
    Import-Module $script:ModulePath -Force
    Import-Module (Join-Path (Split-Path -Parent $script:ModulePath) 'evidence1-run-manifest-contract.psm1') -Force
    function Write-TestSessionPair([string]$Directory, [string]$RuntimeId = 'codex-cli', [string]$ModelId = 'gpt-5.6-terra', [int]$OrderIndex = 0, [string]$Condition = 'current-skill') {
        New-Item -ItemType Directory -Force -Path $Directory | Out-Null
        ([ordered]@{ run_id='run-1';scenario_id='coverage-threshold-failure-v2';seed=-17;order_index=$OrderIndex;condition=$Condition;agent_runtime = [ordered]@{ runtime_id = $RuntimeId; model_requested = $ModelId } } | ConvertTo-Json -Compress) |
            Set-Content -LiteralPath (Join-Path $Directory 'record.json') -Encoding UTF8
        '{"run_id":"run-1"}' | Set-Content -LiteralPath (Join-Path $Directory 'audit.json') -Encoding UTF8
    }
}

Describe 'Evidence1 artifact-copy result shape accepts raw hashtables, not only PSCustomObject' {
    # Regression for the same bug class caught the first time evidence1-run.ps1
    # was actually run: both Copy-E1ArtifactsReadOnly implementations
    # (-fake and -hyperv) build and return a raw [ordered]@{} result, never
    # JSON-round-tripped, before Assert-E1ArtifactCopyResultShape sees it. Not
    # currently reached by evidence1-run.ps1 (EvidenceCopied is a
    # NOT_YET_IMPLEMENTED live-adjacent stub this round), but the coordinator's
    # instruction was to check and fix every new module's shape-assert, not
    # only the ones this round's orchestrator happens to call.

    It 'accepts a hand-built hashtable literal for the single-file spec' {
        { Assert-E1ArtifactCopyResultShape 'final-codex-attestation' ([ordered]@{ files_copied = @('evidence1-claude-windows-isolation-attestation-stageb-v1.json') }) } | Should -Not -Throw
    }

    It 'accepts a hand-built hashtable literal for the multi-field diagnostic spec' {
        $result = [ordered]@{ files_copied = @('terminal.json', 'terminal.claim.json'); terminal_state = 'functional_failed' }
        { Assert-E1ArtifactCopyResultShape 'final-codex-failure-diagnostic' $result } | Should -Not -Throw
    }

    It 'still accepts the same shape as a PSCustomObject' {
        $result = [ordered]@{ files_copied = @('a.json'); terminal_state = $null }
        $roundTripped = ($result | ConvertTo-Json) | ConvertFrom-Json
        { Assert-E1ArtifactCopyResultShape 'final-codex-failure-diagnostic' $roundTripped } | Should -Not -Throw
    }

    It 'still rejects a result with an extra or missing key' {
        { Assert-E1ArtifactCopyResultShape 'final-codex-attestation' ([ordered]@{ files_copied = @(); unexpected = $true }) } | Should -Throw '*artifact_copy_result_shape_invalid*'
        { Assert-E1ArtifactCopyResultShape 'final-codex-attestation' $null } | Should -Throw '*artifact_copy_result_missing*'
    }
}

Describe 'Evidence1 agentic-eval session record copy specification' {
    It 'reuses one complete prior cell and deletes only a partial sibling before recopy' {
        $outputRoot = Join-Path $TestDrive 'resume-output'
        $complete = Join-Path $outputRoot 'codex-cli-0'
        $partial = Join-Path $outputRoot 'claude-code-0'
        Write-TestSessionPair $complete
        New-Item -ItemType Directory -Force -Path $partial | Out-Null
        '{}' | Set-Content -LiteralPath (Join-Path $partial 'record.json') -Encoding UTF8

        (Resolve-E1ArtifactCopyResumeDestination -DestinationDir $complete -RuntimeId 'codex-cli' -ModelId 'gpt-5.6-terra' -ScenarioId 'coverage-threshold-failure-v2' -Seed -17 -Condition product -CampaignCellIndex 0) | Should -BeExactly 'reuse'
        (Resolve-E1ArtifactCopyResumeDestination -DestinationDir $partial -RuntimeId 'claude-code' -ModelId 'claude-sonnet-5' -ScenarioId 'coverage-threshold-failure-v2' -Seed -17 -Condition product -CampaignCellIndex 0) | Should -BeExactly 'copy'
        Test-Path -LiteralPath $complete | Should -BeTrue
        Test-Path -LiteralPath $partial | Should -BeFalse
    }

    It 'fails closed instead of reusing or deleting a complete pair for another identity' {
        $destination = Join-Path $TestDrive 'wrong-identity'
        Write-TestSessionPair $destination -RuntimeId 'claude-code' -ModelId 'claude-sonnet-5'
        { Resolve-E1ArtifactCopyResumeDestination -DestinationDir $destination -RuntimeId 'codex-cli' -ModelId 'gpt-5.6-terra' -ScenarioId 'coverage-threshold-failure-v2' -Seed -17 -Condition product -CampaignCellIndex 0 } |
            Should -Throw '*evidence_copied_existing_cell_identity_mismatch*'
        Test-Path -LiteralPath $destination | Should -BeTrue
    }

    It 'rejects a complete pair from another campaign cell even with the same runtime and model' {
        $destination = Join-Path $TestDrive 'wrong-round'; Write-TestSessionPair $destination -OrderIndex 1
        { Resolve-E1ArtifactCopyResumeDestination -DestinationDir $destination -RuntimeId 'codex-cli' -ModelId 'gpt-5.6-terra' -ScenarioId 'coverage-threshold-failure-v2' -Seed -17 -Condition product -CampaignCellIndex 0 } |
            Should -Throw '*evidence_copied_existing_cell_identity_mismatch*'
    }

    It 'converts a C-volume campaign root with ordinal round-trip equality' {
        $relative = ConvertTo-E1RunGuestRelativePath 'C:\Evidence1Private\campaigns\11111111-1111-1111-1111-111111111111'

        $relative | Should -BeExactly 'Evidence1Private\campaigns\11111111-1111-1111-1111-111111111111'
    }

    It 'rejects a non-C guest campaign volume' {
        { ConvertTo-E1RunGuestRelativePath 'D:\Evidence1Private\campaigns\11111111-1111-1111-1111-111111111111' } |
            Should -Throw '*run_manifest_guest_root_volume_invalid*'
    }

    It 'resolves exactly the normalized record and audit sidecar for one cell' {
        $arguments = [ordered]@{
            PrivateRootRelative = 'runs\campaign-01'
            CellKey = 'codex-cli-3'
        }

        $sources = @(Resolve-E1ArtifactCopySources 'agentic-eval-session-record' $arguments)

        $sources.Count | Should -Be 2
        $sources[0].guest_relative | Should -Be 'runs\campaign-01\codex-cli-3\record.json'
        $sources[0].destination_name | Should -Be 'record.json'
        $sources[0].required | Should -BeTrue
        $sources[1].guest_relative | Should -Be 'runs\campaign-01\codex-cli-3\audit.json'
        $sources[1].destination_name | Should -Be 'audit.json'
        $sources[1].required | Should -BeTrue
    }

    It 'resolves the same worker output directory that EvidenceCopied copies' {
        $privateRoot = 'C:\Evidence1Private'
        $campaignId = '11111111-1111-1111-1111-111111111111'
        $cellKey = 'codex-cli-0'
        # Mirrors the worker's deterministic $runsRoot construction.
        $workerRunRoot = Join-Path (Join-Path $privateRoot $campaignId) $cellKey
        $campaignRelative = ConvertTo-E1RunGuestRelativePath (Join-Path $privateRoot $campaignId)
        $sources = @(Resolve-E1ArtifactCopySources 'agentic-eval-session-record' ([ordered]@{
            PrivateRootRelative = $campaignRelative
            CellKey = $cellKey
        }))

        $resolvedRecord = [IO.Path]::GetFullPath((Join-Path 'C:\' $sources[0].guest_relative))
        $resolvedAudit = [IO.Path]::GetFullPath((Join-Path 'C:\' $sources[1].guest_relative))
        $resolvedRecord.Equals((Join-Path $workerRunRoot 'record.json'), [StringComparison]::OrdinalIgnoreCase) | Should -BeTrue
        $resolvedAudit.Equals((Join-Path $workerRunRoot 'audit.json'), [StringComparison]::OrdinalIgnoreCase) | Should -BeTrue
    }

    It 'rejects rooted or traversal-capable private-root arguments' {
        foreach ($privateRoot in @('C:\runs\campaign', '\runs\campaign', 'runs\..\campaign', 'runs/campaign')) {
            { Assert-E1ArtifactCopyArguments 'agentic-eval-session-record' ([ordered]@{
                PrivateRootRelative = $privateRoot
                CellKey = 'codex-cli-3'
            }) } | Should -Throw '*artifact_copy_argument_invalid: agentic-eval-session-record.PrivateRootRelative*'
        }
    }

    It 'rejects a cell key that could introduce another path segment' {
        { Assert-E1ArtifactCopyArguments 'agentic-eval-session-record' ([ordered]@{
            PrivateRootRelative = 'runs\campaign-01'
            CellKey = 'codex-cli/3'
        }) } | Should -Throw '*artifact_copy_argument_invalid: agentic-eval-session-record.CellKey*'
    }

    It 'resolves accepted and rejected transcript forensics without an arbitrary guest path' {
        $accepted = @(Resolve-E1ArtifactCopySources 'agentic-eval-accepted-raw-transcript' ([ordered]@{
            PrivateRootRelative = 'Evidence1Private\live-product-free\11111111-1111-1111-1111-111111111111'
            CellKey = 'codex-cli-0'
            FileName = 'scenario-current-skill-e6ef6fbc.jsonl'
        }))
        $accepted[0].guest_relative | Should -BeExactly 'Evidence1Private\live-product-free\11111111-1111-1111-1111-111111111111\codex-cli-0\agentic-eval-scenario\raw\scenario-current-skill-e6ef6fbc.jsonl'

        $rejected = @(Resolve-E1ArtifactCopySources 'agentic-eval-rejected-raw-transcript' ([ordered]@{
            PrivateRootRelative = 'Evidence1Private\live-product-free\11111111-1111-1111-1111-111111111111'
            CellKey = 'claude-code-3'
            RejectionId = '05e140fa-6caf-413a-af6e-5df9fd78267a'
            FileName = ('0-' + ('a' * 64) + '.jsonl')
        }))
        $rejected[0].guest_relative | Should -BeExactly ('Evidence1Private\live-product-free\11111111-1111-1111-1111-111111111111\claude-code-3\agentic-eval-rejected\raw\transcripts\05e140fa-6caf-413a-af6e-5df9fd78267a\0-' + ('a' * 64) + '.jsonl')

        $stderr = @(Resolve-E1ArtifactCopySources 'agentic-eval-rejected-raw-stderr' ([ordered]@{
            PrivateRootRelative = 'Evidence1Private\live-product-free\11111111-1111-1111-1111-111111111111'
            CellKey = 'claude-code-3'
            RejectionId = '05e140fa-6caf-413a-af6e-5df9fd78267a'
            FileName = ('0-' + ('a' * 64) + '.stderr.txt')
        }))
        $stderr[0].guest_relative | Should -BeExactly ('Evidence1Private\live-product-free\11111111-1111-1111-1111-111111111111\claude-code-3\agentic-eval-rejected\raw\stderr\05e140fa-6caf-413a-af6e-5df9fd78267a\0-' + ('a' * 64) + '.stderr.txt')
    }

    It 'resolves one structured rejection diagnostic and rejects traversal-shaped forensic names' {
        $sources = @(Resolve-E1ArtifactCopySources 'agentic-eval-rejection-diagnostic' ([ordered]@{
            PrivateRootRelative = 'Evidence1Private\live-product-free\11111111-1111-1111-1111-111111111111'
            CellKey = 'claude-code-3'
            RejectionId = '05e140fa-6caf-413a-af6e-5df9fd78267a'
        }))
        $sources[0].guest_relative | Should -BeExactly 'Evidence1Private\live-product-free\11111111-1111-1111-1111-111111111111\claude-code-3\agentic-eval-rejected\05e140fa-6caf-413a-af6e-5df9fd78267a.json'

        { Assert-E1ArtifactCopyArguments 'agentic-eval-accepted-raw-transcript' ([ordered]@{
            PrivateRootRelative = 'runs\campaign-01'; CellKey = 'codex-cli-0'; FileName = '..\secret.jsonl'
        }) } | Should -Throw '*artifact_copy_argument_invalid*'
    }

    It 'resolves one incident diagnostic at the exact path finalizeIncident writes it to (WO-A2 auditor finding, 2026-09-29)' {
        # Path independently confirmed against tools/agentic-eval/incident-diagnostics.mjs
        # (join(runsRootOverride, 'agentic-eval-incident', `${incidentId}.json`)) and
        # evidence-io.mjs's RUNS_ROOT (process.env.KMP_EVAL_RUNS_ROOT), which
        # New-E1DualConditionCanaryRuntimeEnvironment -RunsRoot sets to exactly
        # {private_root}\{campaign_id}\{runtime_id}-{round_index} -- the same
        # PrivateRootRelative\CellKey split every sibling spec here already uses.
        $sources = @(Resolve-E1ArtifactCopySources 'agentic-eval-incident-diagnostic' ([ordered]@{
            PrivateRootRelative = 'Evidence1Private\eval-v2-gate\583a708d-82dd-4e19-b88f-368aa66015cb'
            CellKey = 'claude-code-0'
            IncidentId = 'ccc5fdb2-e583-46f4-b0d2-03c13af4aae0'
        }))
        $sources[0].guest_relative | Should -BeExactly 'Evidence1Private\eval-v2-gate\583a708d-82dd-4e19-b88f-368aa66015cb\claude-code-0\agentic-eval-incident\ccc5fdb2-e583-46f4-b0d2-03c13af4aae0.json'
        $sources[0].required | Should -BeTrue

        { Assert-E1ArtifactCopyArguments 'agentic-eval-incident-diagnostic' ([ordered]@{
            PrivateRootRelative = 'Evidence1Private\eval-v2-gate\583a708d-82dd-4e19-b88f-368aa66015cb'
            CellKey = 'claude-code-0'
            IncidentId = 'not-a-guid'
        }) } | Should -Throw '*artifact_copy_argument_invalid: agentic-eval-incident-diagnostic.IncidentId*'
    }
}

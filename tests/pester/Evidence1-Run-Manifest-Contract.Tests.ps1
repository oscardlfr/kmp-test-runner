BeforeAll {
    # Both the module import AND the New-TestManifest helper live in this
    # root-level BeforeAll, not bare top-level script code. Confirmed
    # empirically: Pester 5's It blocks do NOT see functions defined at a
    # test file's bare top level at all (CommandNotFoundException:
    # 'New-TestManifest' not recognized) -- only Describe/Context/It block
    # DISCOVERY happens by executing top-level code; the functions/variables
    # it would have defined are not retained into the later RUN phase where
    # It bodies actually execute. A root-level BeforeAll runs once, in the
    # RUN phase, before this file's Describe blocks, and its definitions ARE
    # visible to every It below -- matching the pattern
    # Evidence1DualConditionCanaryContract.Tests.ps1 already establishes for
    # its own test helpers.
    $script:ModulePath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits/evidence1-run-manifest-contract.psm1'
    Import-Module $script:ModulePath -Force

    function New-TestManifest {
        param([hashtable]$Override = @{})
        $manifest = [ordered]@{
            schema = 1
            campaign_id = '11111111-1111-1111-1111-111111111111'
            runtimes = @(
                [ordered]@{ runtime_id = 'codex-cli'; model_id = 'gpt-5.6-terra'; campaign_design_id = 'codex-product-vs-free-baseline-v1'; campaign_cell_indices = @(7, 1, 6, 0); max_budget_usd = $null }
                [ordered]@{ runtime_id = 'claude-code'; model_id = 'claude-sonnet-5'; campaign_design_id = 'claude-product-vs-free-baseline-v1'; campaign_cell_indices = @(12, 3, 9, 0); max_budget_usd = 2.0 }
            )
            scenario_id = 'coverage-threshold-failure-v2'
            seed = -1717
            execution_profile_id = 'sandboxed-unrestricted-v1'
            conditions = @('product', 'free')
            round_order = @('product', 'free', 'free', 'product')
            max_session_count = 12
            vm_name = 'Evidence1CanonicalWindows'
            guest_credential_path = 'C:\kmp-eval\credentials\guest.clixml'
            harness_dir = 'C:\kmp-eval\harness'
            source_template_dir = 'C:\kmp-eval\source'
            claude_attestation_file = 'C:\kmp-eval\attestations\claude.json'
            codex_attestation_file = 'C:\kmp-eval\attestations\codex.json'
            readiness_path = 'C:\kmp-eval\readiness.json'
            private_root = 'C:\kmp-eval\scratch\private-runtime'
            provider_timeout_seconds = 900
            worker_timeout_seconds = 960
            guest_transport_timeout_seconds = 1020
            provider_mode = 'fake'
            output_roots = [ordered]@{ private = 'C:\kmp-eval\scratch\private'; public = 'C:\kmp-eval\scratch\public' }
            no_automatic_provider_retry = $true
            generated_at_utc = '2026-01-01T00:00:00.000Z'
        }
        foreach ($key in $Override.Keys) { $manifest[$key] = $Override[$key] }
        return $manifest
    }
}

Describe 'Evidence1 run-manifest shape accepts raw hashtables, not only PSCustomObject' {
    # Regression for the same bug class caught the first time evidence1-run.ps1
    # was actually run -- this module has five separate .PSObject.Properties.Name
    # call sites (top-level manifest, per-runtime entry, accounts, per-fingerprint
    # entry, output_roots), each fixed. Read-E1RunManifest always produces a
    # PSCustomObject (via ConvertFrom-Json), so these hashtable-literal cases
    # were never exercised by evidence1-run.ps1's own normal flow -- but they are
    # exactly what a hand-built test manifest looks like, which is the point.

    It 'accepts a fully hand-built hashtable-literal manifest end to end' {
        { Assert-E1RunManifestShape (New-TestManifest) } | Should -Not -Throw
    }

    It 'still accepts the same manifest round-tripped through JSON (the real Read-E1RunManifest path)' {
        $manifestPath = Join-Path $TestDrive 'manifest.json'
        (New-TestManifest | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $manifestPath -Encoding UTF8
        { Read-E1RunManifest $manifestPath } | Should -Not -Throw
        (Read-E1RunManifest $manifestPath).campaign_id | Should -BeExactly '11111111-1111-1111-1111-111111111111'
    }

    It 'rejects a hashtable-literal runtimes entry with an extra key (the second .PSObject.Properties.Name site)' {
        $manifest = New-TestManifest
        $manifest.runtimes = @([ordered]@{ runtime_id = 'codex'; model_id = 'gpt-5.6-terra'; campaign_design_id = 'codex-product-vs-free-baseline-v1'; campaign_cell_indices = @(0, 1, 2, 3); extra = 'nope' })
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_runtime_entry_invalid*'
    }

    It 'rejects a manifest with a missing operational reference' {
        $manifest = New-TestManifest
        $manifest.harness_dir = ''
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_harness_dir_invalid*'
    }

    It 'rejects a manifest with a relative operational reference' {
        $manifest = New-TestManifest
        $manifest.readiness_path = 'relative.json'
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_readiness_path_invalid*'
    }

    It 'rejects a hashtable-literal output_roots with an extra key (the fifth .PSObject.Properties.Name site)' {
        $manifest = New-TestManifest
        $manifest.output_roots = [ordered]@{ private = 'C:\a'; public = 'C:\b'; extra = 'C:\c' }
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_output_roots_invalid*'
    }
}

Describe 'Evidence1 run-manifest field validation' {
    It 'requires no_automatic_provider_retry to be literally true' {
        $manifest = New-TestManifest -Override @{ no_automatic_provider_retry = $false }
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_automatic_retry_statement_invalid*'
    }

    It 'rejects a max_session_count below the declared round_order length' {
        $manifest = New-TestManifest -Override @{ max_session_count = 2 }
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_max_session_count_below_round_order*'
    }

    It 'rejects a round_order entry outside the declared conditions' {
        $manifest = New-TestManifest -Override @{ round_order = @('product', 'free', 'baseline') }
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_round_order_invalid*'
    }

    It 'rejects a non-positive provider timeout' {
        $manifest = New-TestManifest -Override @{ provider_timeout_seconds = 0 }
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_provider_timeout_seconds_invalid*'
    }

    It 'requires a JSON-safe integer campaign seed without changing its sign' {
        $valid = New-TestManifest
        { Assert-E1RunManifestShape $valid } | Should -Not -Throw
        $valid.seed | Should -Be -1717
        $missing = New-TestManifest
        $missing.Remove('seed')
        { Assert-E1RunManifestShape $missing } | Should -Throw '*run_manifest_shape_invalid*'
        $nonInteger = New-TestManifest -Override @{ seed = 'one' }
        { Assert-E1RunManifestShape $nonInteger } | Should -Throw '*run_manifest_seed_invalid*'
        $outOfRange = New-TestManifest -Override @{ seed = [int64]9007199254740992 }
        { Assert-E1RunManifestShape $outOfRange } | Should -Throw '*run_manifest_seed_invalid*'
    }

    It 'rejects runtime campaign-cell indices whose length does not match round_order' {
        $manifest = New-TestManifest
        $manifest.runtimes[0].campaign_cell_indices = @(7, 1)
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_campaign_cell_indices_length_invalid*'
    }

    It 'rejects negative, non-integer, and duplicate runtime campaign-cell indices' {
        $manifest = New-TestManifest
        $manifest.runtimes[0].campaign_cell_indices = @(7, -1, 6, 0)
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_campaign_cell_indices_value_invalid*'
        $manifest.runtimes[0].campaign_cell_indices = @(7, 'one', 6, 0)
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_campaign_cell_indices_value_invalid*'
        $manifest.runtimes[0].campaign_cell_indices = @(7, 7, 6, 0)
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_campaign_cell_indices_duplicate*'
    }

    It 'throws run_manifest_missing for a file that does not exist' {
        { Read-E1RunManifest (Join-Path $TestDrive 'nope.json')} | Should -Throw '*run_manifest_missing*'
    }
}

Describe 'Evidence1 run-manifest output_roots confinement (overnight work order item 1)' {
    # Confirmed divergence: evidence1-run.ps1's Invoke-E1RunClosedState/
    # Invoke-E1RunEvidenceCopiedState previously hardcoded
    # <CampaignRoot>\private-evidence / public-evidence and never read
    # output_roots at all, even though this module already validated its
    # presence/shape. These tests cover the NEW confinement/distinctness
    # validation that makes it safe to actually wire output_roots in:
    # rooted (absolute), canonicalized under the trusted root, and
    # non-overlapping. Trusted root is C:\kmp-eval\scratch\, not the wider
    # C:\kmp-eval\ the manifest FILE path itself is confined to (evidence1-run.ps1:565)
    # -- output_roots are runtime OUTPUT artifact locations, the same category
    # as -ReportPath (evidence1-run.ps1:651), the campaign root (:623), and
    # every other module that actually writes campaign evidence
    # (evidence1-artifact-store-fake.psm1's own Assert-E1ArtifactStoreScratchScoped,
    # evidence1-artifact-copy-fake.psm1's own Assert-E1FakeArtifactCopyDestination),
    # all of which confine specifically to scratch, not the wider repo root.

    It 'accepts a manifest whose output_roots are distinct, non-nested, and under C:\kmp-eval\scratch\' {
        { Assert-E1RunManifestShape (New-TestManifest) } | Should -Not -Throw
    }

    It 'rejects a relative output_roots.private (no leading drive/UNC root)' {
        $manifest = New-TestManifest
        $manifest.output_roots = [ordered]@{ private = 'scratch\private'; public = 'C:\kmp-eval\scratch\public' }
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_output_roots_not_absolute*'
    }

    It 'rejects a relative output_roots.public the same way' {
        $manifest = New-TestManifest
        $manifest.output_roots = [ordered]@{ private = 'C:\kmp-eval\scratch\private'; public = '..\public' }
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_output_roots_not_absolute*'
    }

    It 'rejects an absolute output_roots.private that resolves outside C:\kmp-eval\scratch\ via .. traversal' {
        $manifest = New-TestManifest
        $manifest.output_roots = [ordered]@{ private = 'C:\kmp-eval\scratch\..\..\Windows\System32'; public = 'C:\kmp-eval\scratch\public' }
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_output_roots_outside_trusted_root*'
    }

    It 'rejects an output_roots.public that is simply outside C:\kmp-eval\scratch\ altogether' {
        $manifest = New-TestManifest
        $manifest.output_roots = [ordered]@{ private = 'C:\kmp-eval\scratch\private'; public = 'C:\Users\Public\evidence' }
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_output_roots_outside_trusted_root*'
    }

    It 'rejects output_roots.private and .public being identical' {
        $manifest = New-TestManifest
        $manifest.output_roots = [ordered]@{ private = 'C:\kmp-eval\scratch\shared'; public = 'C:\kmp-eval\scratch\shared' }
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_output_roots_not_distinct*'
    }

    It 'rejects output_roots.private and .public being identical after canonicalization even if spelled differently' {
        $manifest = New-TestManifest
        $manifest.output_roots = [ordered]@{ private = 'C:\kmp-eval\scratch\shared\'; public = 'C:\kmp-eval\scratch\.\shared' }
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_output_roots_not_distinct*'
    }

    It 'rejects output_roots.public nested under output_roots.private' {
        $manifest = New-TestManifest
        $manifest.output_roots = [ordered]@{ private = 'C:\kmp-eval\scratch\evidence'; public = 'C:\kmp-eval\scratch\evidence\public' }
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_output_roots_nested*'
    }

    It 'rejects output_roots.private nested under output_roots.public (the other direction)' {
        $manifest = New-TestManifest
        $manifest.output_roots = [ordered]@{ private = 'C:\kmp-eval\scratch\evidence\private'; public = 'C:\kmp-eval\scratch\evidence' }
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_output_roots_nested*'
    }

    It 'does not false-positive nested on sibling directories sharing a common string prefix' {
        $manifest = New-TestManifest
        $manifest.output_roots = [ordered]@{ private = 'C:\kmp-eval\scratch\evidence-private'; public = 'C:\kmp-eval\scratch\evidence-public' }
        { Assert-E1RunManifestShape $manifest } | Should -Not -Throw
    }

    It 'exposes Assert-E1RunManifestOutputRootsConfined standalone, callable without a full manifest' {
        { Assert-E1RunManifestOutputRootsConfined ([ordered]@{ private = 'C:\kmp-eval\scratch\a'; public = 'C:\kmp-eval\scratch\b' }) } | Should -Not -Throw
        { Assert-E1RunManifestOutputRootsConfined ([ordered]@{ private = 'C:\Elsewhere\a'; public = 'C:\kmp-eval\scratch\b' }) } | Should -Throw '*run_manifest_output_roots_outside_trusted_root*'
    }
}

Describe 'Evidence1 run-manifest output_roots trust-root portability (overnight work order item B)' {
    # Confirmed divergence: Assert-E1RunManifestOutputRootsConfined
    # hardcoded C:\kmp-eval\scratch\ as a module-level constant
    # ($script:E1RunOutputRootsTrustedRoot) with no way to override it --
    # meaning this module was itself the only source of trust for its own
    # confinement root, and every test exercising the "outside the trusted
    # root" rejection path was forced to hardcode C:\kmp-eval\scratch\-
    # relative paths rather than use Pester's own $TestDrive. The manifest
    # itself must NEVER be able to supply or widen this root -- these tests
    # confirm the new -TrustedRoot parameter is caller-injected only, never
    # read from $OutputRoots/$Manifest content.

    It 'accepts an injected trust root different from the historical hardcoded default -- proving the root is genuinely pluggable, not still secretly hardcoded' {
        $customRoot = Join-Path $TestDrive 'custom-trusted-root'
        $outputRoots = [ordered]@{ private = (Join-Path $customRoot 'private'); public = (Join-Path $customRoot 'public') }
        { Assert-E1RunManifestOutputRootsConfined $outputRoots -TrustedRoot $customRoot } | Should -Not -Throw
    }

    It 'the SAME output_roots pair is rejected under the historical default when no trust root is injected -- proving the check is genuinely responsive, not vacuously accepting everything now' {
        $customRoot = Join-Path $TestDrive 'custom-trusted-root'
        $outputRoots = [ordered]@{ private = (Join-Path $customRoot 'private'); public = (Join-Path $customRoot 'public') }
        { Assert-E1RunManifestOutputRootsConfined $outputRoots } | Should -Throw '*run_manifest_output_roots_outside_trusted_root*'
    }

    It 'traversal/escape rejection is preserved under an injected custom trust root (regression pin, not just the default)' {
        $customRoot = Join-Path $TestDrive 'custom-trusted-root'
        $escaping = Join-Path $customRoot '..\..\Windows\System32'
        $outputRoots = [ordered]@{ private = $escaping; public = (Join-Path $customRoot 'public') }
        { Assert-E1RunManifestOutputRootsConfined $outputRoots -TrustedRoot $customRoot } | Should -Throw '*run_manifest_output_roots_outside_trusted_root*'
    }

    It 'relative-path rejection is preserved under an injected custom trust root (regression pin)' {
        $customRoot = Join-Path $TestDrive 'custom-trusted-root'
        $outputRoots = [ordered]@{ private = 'relative\private'; public = (Join-Path $customRoot 'public') }
        { Assert-E1RunManifestOutputRootsConfined $outputRoots -TrustedRoot $customRoot } | Should -Throw '*run_manifest_output_roots_not_absolute*'
    }

    It 'distinctness/non-nesting rejection is preserved under an injected custom trust root (regression pin)' {
        $customRoot = Join-Path $TestDrive 'custom-trusted-root'
        $shared = Join-Path $customRoot 'shared'
        $outputRoots = [ordered]@{ private = $shared; public = $shared }
        { Assert-E1RunManifestOutputRootsConfined $outputRoots -TrustedRoot $customRoot } | Should -Throw '*run_manifest_output_roots_not_distinct*'
    }

    It 'Assert-E1RunManifestShape accepts an injected -TrustedRoot end to end, using $TestDrive instead of C:\kmp-eval\scratch\' {
        $customRoot = Join-Path $TestDrive 'custom-trusted-root-full-manifest'
        $manifest = New-TestManifest -Override @{
            output_roots = [ordered]@{ private = (Join-Path $customRoot 'private'); public = (Join-Path $customRoot 'public') }
        }
        { Assert-E1RunManifestShape $manifest -TrustedRoot $customRoot } | Should -Not -Throw
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_output_roots_outside_trusted_root*' -Because 'the manifest''s own output_roots must not be trusted without the caller explicitly injecting a matching root'
    }

    It 'Get-E1RunManifestDefaultTrustedRoot resolves from EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT when set, else the historical C:\kmp-eval\scratch\ default' {
        $original = $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT
        try {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = $null
            (Get-E1RunManifestDefaultTrustedRoot) | Should -BeExactly 'C:\kmp-eval\scratch\'

            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = 'D:\some-other-installation\scratch\'
            (Get-E1RunManifestDefaultTrustedRoot) | Should -BeExactly 'D:\some-other-installation\scratch\'
        } finally {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = $original
        }
    }

    It 'the manifest content itself cannot influence which trust root is used -- two manifests differing only in output_roots validate against the SAME injected root' {
        $customRoot = Join-Path $TestDrive 'custom-trusted-root-no-manifest-influence'
        # A manifest has no field named anything like trust_root/scratch_root/
        # output_roots_trusted_root at all (Get-E1RunManifestRequiredKeys is
        # the exhaustive, exact key list; Assert-E1RunManifestShape rejects
        # any manifest with an extra key) -- so this is also a structural
        # guarantee, not just a runtime observation, confirmed directly here.
        (Get-E1RunManifestRequiredKeys) | Should -Not -Contain 'trusted_root'
        (Get-E1RunManifestRequiredKeys) | Should -Not -Contain 'output_roots_trusted_root'
        (Get-E1RunManifestRequiredKeys) | Should -Not -Contain 'scratch_root'
        $manifest = New-TestManifest -Override @{
            output_roots = [ordered]@{ private = (Join-Path $customRoot 'private'); public = (Join-Path $customRoot 'public') }
        }
        { Assert-E1RunManifestShape $manifest -TrustedRoot $customRoot } | Should -Not -Throw
    }

    It 'Get-E1RunManifestDefaultTrustedRoot genuinely delegates to the shared evidence1-trusted-root-config.psm1 implementation, not a second independent copy (follow-up: shared config module)' {
        # This module's own default-resolution function used to be the ONLY
        # implementation of the env-var-else-historical-default decision.
        # Once evidence1-artifact-copy-fake.psm1 and
        # evidence1-artifact-store-fake.psm1 needed the identical logic for
        # their own separate scratch-confinement checks, the logic moved to
        # a new shared leaf module (evidence1-trusted-root-config.psm1) and
        # this function became a one-line delegator -- this test proves the
        # delegation is genuine (same value, including a non-default
        # override), not a second, coincidentally-matching implementation
        # that could drift.
        Import-Module (Join-Path (Split-Path -Parent $script:ModulePath) 'evidence1-trusted-root-config.psm1') -Force
        $original = $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT
        try {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = $null
            (Get-E1RunManifestDefaultTrustedRoot) | Should -BeExactly (Get-E1DefaultTrustedRoot)
            (Get-E1RunManifestDefaultTrustedRoot) | Should -BeExactly 'C:\kmp-eval\scratch\'

            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = 'D:\yet-another-installation\scratch\'
            (Get-E1RunManifestDefaultTrustedRoot) | Should -BeExactly (Get-E1DefaultTrustedRoot)
            (Get-E1RunManifestDefaultTrustedRoot) | Should -BeExactly 'D:\yet-another-installation\scratch\'
        } finally {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = $original
        }
    }
}

Describe 'Evidence1 run-manifest cell cardinality (overnight work order item 2)' {
    # Confirmed divergence: this module's max_session_count check only
    # validated max_session_count >= round_order.Count, but
    # Invoke-E1RunLiveRunningState (evidence1-run.ps1) dispatches one fake
    # session per (round, runtime) PAIR -- round_order.Count * runtimes.Count
    # sessions total. A manifest could set max_session_count exactly equal
    # to round_order.Count and still pass the old check while actually
    # dispatching far more sessions than that budget field was supposed to
    # cap. Settled against ADR-S6 + plan section 6.2 (re-read this round):
    # section 6.2's own diagram --
    #   round 1: product, free / round 2: free, product / round 3: product, free
    # -- is 3 rounds of TWO condition-slots each, i.e. round_order has 6
    # entries for a canonical 3-round campaign (one entry per condition-slot,
    # not one entry per round-number); combined with 2 runtimes that is 12
    # cells, matching the plan's own "12 sessions for the Claude/Codex
    # product-vs-free benchmark" (line 29-31) and "Claude and Codex each have
    # six accepted product/free records" (line 671) exactly. So
    # round_order.Count * runtimes.Count was already the CORRECT dispatch
    # formula (Invoke-E1RunLiveRunningState's own prior-round comment said as
    # much) -- the bug was only ever in the VALIDATION lagging behind it.
    #
    # Root-cause fix, not a patched multiplier: Get-E1RunManifestExpectedCells
    # is now the SINGLE source of truth for "how many cells exist" and
    # "which ones", used by BOTH this module's max_session_count check AND
    # evidence1-run.ps1's LiveRunning dispatch loop -- so the two can never
    # again silently disagree the way they did before this fix.

    It 'derives zero cells for an empty round_order, without throwing' {
        (Get-E1RunManifestExpectedCells ([ordered]@{ round_order = @(); runtimes = @([ordered]@{ runtime_id = 'codex'; model_id = 'm'; campaign_design_id = 'design'; campaign_cell_indices = @() }) })).Count | Should -Be 0
    }

    It 'derives zero cells for an empty runtimes list, without throwing' {
        (Get-E1RunManifestExpectedCells ([ordered]@{ round_order = @('product'); runtimes = @() })).Count | Should -Be 0
    }

    It 'derives exactly one cell for one round_order entry and one runtime' {
        $cells = @(Get-E1RunManifestExpectedCells ([ordered]@{ round_order = @('product'); runtimes = @([ordered]@{ runtime_id = 'codex'; model_id = 'm'; campaign_design_id = 'design'; campaign_cell_indices = @(17) }) }))
        $cells.Count | Should -Be 1
        $cells[0].runtime_id | Should -BeExactly 'codex'
        $cells[0].round_index | Should -Be 0
        $cells[0].campaign_cell_index | Should -Be 17
    }

    It 'accepts a one-cell manifest whose session budget is exactly one' {
        $manifest = New-TestManifest -Override @{
            runtimes = @([ordered]@{ runtime_id = 'claude-code'; model_id = 'claude-sonnet-5'; campaign_design_id = 'claude-product-canary-v1'; campaign_cell_indices = @(0); max_budget_usd = 2.0 })
            round_order = @('product')
            max_session_count = 1
        }
        { Assert-E1RunManifestShape $manifest } | Should -Not -Throw
    }

    It 'derives round_order.Count * runtimes.Count cells for a 3-runtime manifest, proving nothing is hardcoded to exactly two runtimes' {
        $manifest = New-TestManifest -Override @{
            runtimes = @(
                [ordered]@{ runtime_id = 'codex'; model_id = 'gpt-5.6-terra'; campaign_design_id = 'codex-product-vs-free-baseline-v1'; campaign_cell_indices = @(0, 1, 2, 3) }
                [ordered]@{ runtime_id = 'claude'; model_id = 'claude-sonnet-5'; campaign_design_id = 'claude-product-vs-free-baseline-v1'; campaign_cell_indices = @(4, 5, 6, 7) }
                [ordered]@{ runtime_id = 'gemini'; model_id = 'gemini-3'; campaign_design_id = 'gemini-product-vs-free-baseline-v1'; campaign_cell_indices = @(8, 9, 10, 11) }
            )
            round_order = @('product', 'free', 'free', 'product')
            max_session_count = 12
            accounts = [ordered]@{ codex = 'codex-account@evidence1.example'; claude = 'claude-account@evidence1.example'; gemini = 'gemini-account@evidence1.example' }
            credential_fingerprints = @(
                [ordered]@{ runtime_id = 'codex'; fingerprint_sha256 = ('d' * 64); expires_at_utc = '2026-06-01T00:00:00.000Z' }
                [ordered]@{ runtime_id = 'claude'; fingerprint_sha256 = ('e' * 64); expires_at_utc = '2026-06-01T00:00:00.000Z' }
                [ordered]@{ runtime_id = 'gemini'; fingerprint_sha256 = ('9' * 64); expires_at_utc = '2026-06-01T00:00:00.000Z' }
            )
        }
        $cells = @(Get-E1RunManifestExpectedCells $manifest)
        $cells.Count | Should -Be 12
        # $cells entries are [ordered]@{} hashtables, not PSCustomObjects --
        # Select-Object -ExpandProperty does not resolve a dictionary KEY as
        # a member (same class of gotcha as .PSObject.Properties.Name
        # elsewhere in this codebase); $_.runtime_id dot-access inside
        # ForEach-Object does, and is what evidence1-run.ps1 itself will use.
        (@($cells | ForEach-Object { $_.runtime_id } | Sort-Object -Unique)) -join ',' | Should -BeExactly 'claude,codex,gemini'
    }

    It 'derives one cell per (round_index, runtime) pair even when round_order repeats the same condition label at different positions -- no accidental dedup by label' {
        $manifest = New-TestManifest -Override @{ round_order = @('product', 'free', 'product', 'free') }
        $cells = @(Get-E1RunManifestExpectedCells $manifest)
        $cells.Count | Should -Be 8
        (@($cells | Where-Object { $_.runtime_id -ceq 'codex-cli' } | ForEach-Object { $_.round_index } | Sort-Object)) -join ',' | Should -BeExactly '0,1,2,3'
    }

    # D7 (eval-v2 order fix, design.md (h)): RED before this fix -- every prior campaign,
    # including Evidence1's own, dispatched $runtimes[0] (codex-cli, New-TestManifest's own
    # fixture order) first in EVERY round without exception. GREEN after: the first-dispatched
    # runtime now alternates by round_index parity, deterministically from the manifest alone.
    It 'alternates which runtime dispatches FIRST per round -- round 0 codex-cli, round 1 claude-code, round 2 codex-cli, round 3 claude-code' {
        $manifest = New-TestManifest -Override @{ round_order = @('product', 'free', 'product', 'free') }
        $cells = @(Get-E1RunManifestExpectedCells $manifest)
        $firstPerRound = @(0, 1, 2, 3 | ForEach-Object {
            $roundIndex = $_
            (@($cells | Where-Object { $_.round_index -eq $roundIndex }))[0].runtime_id
        })
        $firstPerRound -join ',' | Should -BeExactly 'codex-cli,claude-code,codex-cli,claude-code'
    }

    It 'preserves the arm order within each runtime own repetition sequence -- alternation only changes WHICH RUNTIME dispatches first, never the pre-registered condition sequence itself' {
        $manifest = New-TestManifest -Override @{ round_order = @('product', 'free', 'product', 'free') }
        $cells = @(Get-E1RunManifestExpectedCells $manifest)
        foreach ($rid in @('codex-cli', 'claude-code')) {
            $conditionsForRuntime = @($cells | Where-Object { $_.runtime_id -ceq $rid } | Sort-Object round_index | ForEach-Object { $_.condition })
            ($conditionsForRuntime -join ',') | Should -BeExactly 'product,free,product,free'
        }
    }

    It 'reduces to the pre-fix (always-same-order) dispatch for a single-runtime manifest -- alternation is a no-op with nothing to reorder' {
        $manifest = New-TestManifest -Override @{
            runtimes = @([ordered]@{ runtime_id = 'claude-code'; model_id = 'claude-sonnet-5'; campaign_design_id = 'claude-product-canary-v1'; campaign_cell_indices = @(0, 1, 2, 3) })
            round_order = @('product', 'free', 'product', 'free')
        }
        $cells = @(Get-E1RunManifestExpectedCells $manifest)
        (@($cells | ForEach-Object { $_.runtime_id } | Sort-Object -Unique)) -join ',' | Should -BeExactly 'claude-code'
        $cells.Count | Should -Be 4
    }

    It 'accepts a max_session_count that exactly matches the derived cell count' {
        $manifest = New-TestManifest -Override @{ round_order = @('product', 'free', 'free', 'product'); max_session_count = 8 }
        { Assert-E1RunManifestShape $manifest } | Should -Not -Throw
    }

    It 'rejects a max_session_count that satisfies the OLD (round_order.Count-only) check but is too low for round_order.Count * runtimes.Count' {
        # 4 round_order entries * 2 runtimes = 8 cells needed; max_session_count=4
        # would have PASSED the old (>= round_order.Count) check.
        $manifest = New-TestManifest -Override @{ round_order = @('product', 'free', 'free', 'product'); max_session_count = 4 }
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_max_session_count_below_round_order*'
    }

    It 'still rejects a max_session_count below round_order.Count outright (pre-existing behavior, unchanged)' {
        $manifest = New-TestManifest -Override @{ max_session_count = 1 }
        { Assert-E1RunManifestShape $manifest } | Should -Throw '*run_manifest_max_session_count_below_round_order*'
    }
}

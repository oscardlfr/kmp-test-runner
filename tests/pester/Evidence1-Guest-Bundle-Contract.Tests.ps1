BeforeAll {
    # Import inside BeforeAll, not bare top-level -- see
    # Evidence1-Network-Backend-Contract.Tests.ps1's BeforeAll comment for
    # why (Pester 5 runs every file's top-level code during discovery,
    # before any file's It blocks; used uniformly across all Evidence1 test
    # files for consistency even where no identically-named sibling module
    # makes cross-file shadowing an active risk).
    $script:ModulePath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits/evidence1-guest-bundle-contract.psm1'
    Import-Module $script:ModulePath -Force

    # 2026-09-29 (WO-A2 auditor decision, Amendment A5, round 2 -- round 1 found broken live):
    # shared TEST-file helper (never a bundle-body function -- those stay independently duplicated
    # per this module's own established "self-contained scriptblock" architecture; this is plain
    # test infrastructure, a different concern). Defined inside BeforeAll for the same discovery-
    # vs-run-phase reason as the module import above -- a bare top-level function definition is not
    # reliably visible inside It blocks under Pester 5/6's own scoping model (confirmed live: a
    # top-level definition here threw CommandNotFoundException from inside It). Round 1
    # unconditionally overwrote gradle.properties with ONLY the memory-cap lines, silently dropping
    # the certified seed's own org.gradle.daemon=false/
    # org.gradle.java.installations.auto-download=false (written at warm time,
    # evidence1-hyperv-warm-canonical-gradle-cache-direct.ps1:41) -- the daemon then stayed alive
    # after each build (MORE memory held, the opposite of the goal), and toolchain auto-download
    # stopped being disabled in this offline-network VM. Checked identically for all three bundles
    # that write this file, so a future regression in any one of them is caught the same way.
    function script:Assert-E1GradleUserHomeCanonicalPropertiesWrite([string]$Source) {
        # Isolate the actual WRITTEN content specifically (never the surrounding source, which
        # legitimately discusses "-Xms"/key names in its own explanatory comments around this write).
        $contentMatch = [regex]::Match($Source, '\$gradleMemoryOverrideContent\s*=\s*"((?:[^"\\]|\\.)*)"')
        $contentMatch.Success | Should -Be $true
        $content = $contentMatch.Groups[1].Value
        $content | Should -Match '^org\.gradle\.daemon=false`n'
        $content | Should -Match '`norg\.gradle\.java\.installations\.auto-download=false`n'
        $content | Should -Match '`norg\.gradle\.configuration-cache=false`n'
        $content | Should -Match '`norg\.gradle\.jvmargs=.*-Xmx3g`n'
        $content | Should -Match '`nkotlin\.daemon\.jvmargs=.*-Xmx2g`n$'
        $content | Should -Not -Match '-Xms'
        # `n only (never `r`n) -- this PowerShell literal is what the cross-language vitest test
        # (agentic-eval-materialize.test.js) unescapes and hashes against node's own
        # GRADLE_USER_HOME_CANONICAL_PROPERTIES, proving byte-identical, not assumed.
        $content | Should -Not -Match '`r'
        $Source | Should -Match 'Get-FileHash\s+-LiteralPath\s+\$gradleMemoryOverridePath\s+-Algorithm\s+SHA256'
        # The fail-closed guard: every canonical key named, and the exact error code a future caller
        # (or a live receipt) would see -- never a silent drop of an unrecognized one.
        $Source | Should -Match "'org\.gradle\.daemon',\s*'org\.gradle\.java\.installations\.auto-download',\s*'org\.gradle\.configuration-cache',\s*'org\.gradle\.jvmargs',\s*'kotlin\.daemon\.jvmargs'"
        $Source | Should -Match 'throw\s+"gradle_user_home_properties_unexpected_key:\$existingKey"'
        $Source | Should -Match '-cnotcontains\s+\$existingKey'
    }
}

Describe 'Evidence1 guest-bundle result shape accepts raw hashtables, not only PSCustomObject' {
    # Regression for the same bug class caught the first time evidence1-run.ps1
    # was actually run: evidence1-guest-bundle-fake.psm1's Invoke-E1GuestBundle
    # returns a raw [ordered]@{} result, and Set-E1FakeGuestBundleResult (called
    # by evidence1-run.ps1's ToolchainReady/AuthReady handlers) validates a
    # caller-seeded raw hashtable output through this exact function before it
    # is ever JSON-round-tripped.

    It 'accepts a hand-built hashtable literal matching a real bundle''s declared result_keys' {
        $output = [ordered]@{ command_found = $true; version_text = 'codex-cli 0.154.0'; login_status_exit_code = 0 }
        { Assert-E1GuestBundleResultShape 'get-cli-version-and-login-status' $output } | Should -Not -Throw
    }

    It 'still accepts the same shape as a PSCustomObject (e.g. round-tripped through JSON)' {
        $output = [ordered]@{ command_found = $true; version_text = 'claude-code 2.1.238'; login_status_exit_code = 0 }
        $roundTripped = ($output | ConvertTo-Json) | ConvertFrom-Json
        { Assert-E1GuestBundleResultShape 'get-cli-version-and-login-status' $roundTripped } | Should -Not -Throw
    }

    It 'still accepts the simpler sealed-state bundle''s single-key result as a hashtable' {
        { Assert-E1GuestBundleResultShape 'get-firewall-sealed-state' ([ordered]@{ sealed = $true }) } | Should -Not -Throw
    }

    It 'still rejects a result missing a declared key, from either representation' {
        { Assert-E1GuestBundleResultShape 'get-cli-version-and-login-status' ([ordered]@{ command_found = $true }) } | Should -Throw '*guest_bundle_result_shape_invalid*'
        { Assert-E1GuestBundleResultShape 'get-cli-version-and-login-status' $null } | Should -Throw '*guest_bundle_result_missing*'
    }

    It 'rejects an unknown bundle name outright' {
        { Assert-E1GuestBundleResultShape 'not-a-real-bundle' ([ordered]@{}) } | Should -Throw '*guest_bundle_name_invalid*'
    }

    It 'declares a closed non-inference Claude binding refresh contract' {
        $registry = Get-E1GuestBundleRegistry
        $registry.Keys | Should -Contain 'refresh-claude-account-binding'
        {
            Assert-E1GuestBundleArguments 'refresh-claude-account-binding' ([ordered]@{
                ExpectedAccount = 'oscar.dlfr'
                ExpectedSubscription = 'max'
                ExpectedTier = 'default_claude_max_20x'
            })
        } | Should -Not -Throw
        {
            Assert-E1GuestBundleResultShape 'refresh-claude-account-binding' ([ordered]@{
                binding_refreshed = $true
                identity_matched = $true
                subscription_matched = $true
                tier_matched = $true
                required_scopes_present = $true
                expiry_valid = $true
                login_status_exit_code = 0
                credential_sha256 = ('a' * 64)
            })
        } | Should -Not -Throw
    }

    It 'rejects a downgraded Claude subscription or tier for binding refresh' {
        {
            Assert-E1GuestBundleArguments 'refresh-claude-account-binding' ([ordered]@{
                ExpectedAccount = 'oscar.dlfr'
                ExpectedSubscription = 'pro'
                ExpectedTier = 'default_claude_pro'
            })
        } | Should -Throw '*guest_bundle_argument_invalid*'
    }

    It 'accepts injected operational references and reports them without using hashes as inputs' {
        $arguments = [ordered]@{
            HarnessDir = 'C:\kmp-eval\harness'
            SourceTemplateDir = 'C:\kmp-eval\source'
            ClaudeAttestationFile = 'C:\kmp-eval\attestations\claude.json'
            CodexAttestationFile = 'C:\kmp-eval\attestations\codex.json'
            ReadinessPath = 'C:\kmp-eval\readiness.json'
            PrivateRoot = 'C:\kmp-eval\scratch\private-runtime'
            ProviderTimeoutSeconds = 900
        }
        { Assert-E1GuestBundleArguments 'get-dual-condition-plan-bindings' $arguments } | Should -Not -Throw
        { Assert-E1GuestBundleResultShape 'get-dual-condition-plan-bindings' ([ordered]@{
            harness_dir = $arguments.HarnessDir; source_template_dir = $arguments.SourceTemplateDir
            claude_attestation_file = $arguments.ClaudeAttestationFile; codex_attestation_file = $arguments.CodexAttestationFile
            readiness_path = $arguments.ReadinessPath; private_root = $arguments.PrivateRoot; provider_timeout_seconds = 900
            observed_provenance = [ordered]@{ harness_commit = $null; harness_tree = $null; source_commit = $null; source_tree = $null }
            inference_sessions_consumed = 0
        }) } | Should -Not -Throw
    }

    It 'rejects a historical empty binding request for the injected plan-binding bundle' {
        { Assert-E1GuestBundleArguments 'get-dual-condition-plan-bindings' @{} } | Should -Throw '*guest_bundle_argument_shape_invalid*'
    }

    It 'declares the one internal manifest-cell session worker with no executable-path argument' {
        $arguments = [ordered]@{
            CurrentCampaignInputsJson = '{"campaign_id":"11111111-1111-1111-1111-111111111111","harness_dir":"C:\\kmp-eval\\harness"}'
            CellJson = '{"runtime_id":"codex","round_index":0}'
        }
        { Assert-E1GuestBundleArguments 'run-agentic-eval-session' $arguments } | Should -Not -Throw
        (Get-E1GuestBundleRegistry)['run-agentic-eval-session'].argument_schema.Keys | Should -Be @('CurrentCampaignInputsJson', 'CellJson')
        { Assert-E1GuestBundleResultShape 'run-agentic-eval-session' ([ordered]@{
            schema = 1; runtime_id = 'codex'; model_id = 'gpt-5.6-terra'; round_index = 0; session_id = 'abc'
            started_at_utc = '2026-01-01T00:00:00.000Z'; completed_at_utc = '2026-01-01T00:00:00.001Z'
            exit_code = 0; verdict = 'PASS'; reason_code = $null; output_summary = [ordered]@{ record_count = 1 }
        }) } | Should -Not -Throw
        $workerSource = (Get-E1GuestBundleRegistry)['run-agentic-eval-session'].scriptblock.ToString()
        $workerSource | Should -Match 'Set-ExecutionPolicy\s+-Scope\s+Process\s+-ExecutionPolicy\s+Bypass\s+-Force'
        $workerSource.IndexOf('Set-ExecutionPolicy', [StringComparison]::Ordinal) |
            Should -BeLessThan $workerSource.IndexOf('. $worker -InternalLibrary', [StringComparison]::Ordinal)
    }

    It 'declares a provider-free semantic product smoke with injected roots' {
        $fortyHex = '0123456789abcdef0123456789abcdef01234567'.Substring(0, 40)
        $sixtyFourHex = ('0123456789abcdef' * 4)
        $arguments = [ordered]@{
            HarnessDir = 'C:\kmp-eval\harness'
            SourceTemplateDir = 'C:\kmp-eval\source'
            SmokeRoot = 'C:\Evidence1Private\campaign\provider-free-product-smoke'
            ExpectedProductCommit = $fortyHex
            ExpectedProductVersion = '0.16.0'
            ExpectedLibTreeHash = $fortyHex
            ExpectedBinTreeHash = $fortyHex
            ExpectedSkillsTreeHash = $fortyHex
            ExpectedSourceCommit = $fortyHex
            ScenarioId = 'coverage-threshold-failure-v2'
        }
        { Assert-E1GuestBundleArguments 'run-agentic-eval-product-smoke' $arguments } | Should -Not -Throw
        # A caller that still supplies only the pre-WO-A2 three arguments must be rejected --
        # this is the actual fail-closed proof that ExpectedProductCommit/Version/tree hashes
        # are not optional bolt-ons a caller can silently omit.
        $legacyArguments = [ordered]@{
            HarnessDir = 'C:\kmp-eval\harness'
            SourceTemplateDir = 'C:\kmp-eval\source'
            SmokeRoot = 'C:\Evidence1Private\campaign\provider-free-product-smoke'
        }
        { Assert-E1GuestBundleArguments 'run-agentic-eval-product-smoke' $legacyArguments } | Should -Throw
        $bundle = (Get-E1GuestBundleRegistry)['run-agentic-eval-product-smoke']
        $bundle.argument_schema.Keys | Should -Be @('HarnessDir', 'SourceTemplateDir', 'SmokeRoot', 'ExpectedProductCommit', 'ExpectedProductVersion', 'ExpectedLibTreeHash', 'ExpectedBinTreeHash', 'ExpectedSkillsTreeHash', 'ExpectedSourceCommit', 'ScenarioId')
        $source = $bundle.scriptblock.ToString()
        $source | Should -Match "'parallel'.*'--module-filter'.*':core:domain'.*'--min-missed-lines'.*'15'"
        $source | Should -Match 'E1GradleUserHomeSeedDir'
        $source | Should -Match "cpSync\(process\.argv\[1\],process\.argv\[2\],\{recursive:true\}\)"
        $source | Should -Match 'GRADLE_USER_HOME\s*=\s*\$gradleHome'
        $source | Should -Not -Match 'product_smoke_replay'
        $source | Should -Not -Match "'--color'"
        $source | Should -Match "'coverage_threshold_exceeded'"
        $source | Should -Match 'inference_sessions_consumed\s*=\s*0'
        $source | Should -Not -Match 'claude\.cmd|codex\.exe'
        # Auditor finding: a PARSED envelope object crosses PS-remoting serialization and then
        # this module's own ConvertTo-Json -Depth 5 re-encoding (confirmed real in this exact
        # file, docs/audits/evidence1-guest-bundle-contract.psm1 lines ~780/858) -- a real kmp-test
        # envelope nests past depth 5 (e.g. parallel.legs[0].execution.fresh), which would silently
        # flatten into an opaque string. The receipt must carry the trimmed stdout TEXT, never a
        # parsed object, so it survives that same round-trip byte-identical (see the dedicated
        # round-trip test below).
        $source | Should -Match 'raw_envelope_json'
        $source | Should -Not -Match 'raw_envelope\s*=\s*\$report\b'
        # 2026-09-29 wedge fix (WO-A2 auditor finding, proven live): PowerShell 5.1's own
        # Remove-Item -Recurse -Force hits MAX_PATH on a leftover long Gradle accessor tree from
        # a prior successful run -- SmokeRoot's own pre-clean must route through the guest-node
        # long-path-safe delete, never a direct Remove-Item -Recurse call on $SmokeRoot.
        $source | Should -Not -Match 'Remove-Item\s+-LiteralPath\s+\$SmokeRoot\s+-Recurse\s+-Force'
        $source | Should -Match 'Remove-E1GuestBundleLongPathTree\b'
        $source | Should -Match 'fs\.rmSync\(targetPath,\{recursive:true,force:true,maxRetries:3\}\)'
        $source | Should -Match "guest_long_path_delete_failed"
        # An uncaught exception anywhere in the body must return a structured FAIL, not bubble to
        # the host's own generic "guest_bundle_failed: <raw message>" wrapper.
        $source | Should -Match "reason_code\s*=\s*'bundle_exception'"
        $source | Should -Match '\$_\.Exception\.GetType\(\)\.FullName'
        $source | Should -Match '\$_\.ScriptStackTrace'

        # 2026-09-29 (WO-A2 auditor finding): a bare "product_smoke_input_missing" gave no way to
        # tell which of five inputs was absent without a second diagnostic round -- confirmed live,
        # first run after bc7dd6a, when SourceTemplateDir turned out to be the culprit. The throw
        # must name the specific missing key, not just the bundle-level reason code.
        $source | Should -Match 'throw\s+"product_smoke_input_missing:\$inputName"'
        $source | Should -Match 'SourceTemplateDir\s*=\s*\$SourceTemplateDir'
        $source | Should -Match 'GradleUserHomeSeedDir\s*=\s*\$script:E1GradleUserHomeSeedDir'

        # 2026-09-29 (WO-A2 auditor finding, proven live): a checkout git-verified correct at
        # ToolchainReady sync time was still observed running a stale kmp-test moments later
        # (envelope version 0.15.0 against an expected/checked-out 0.16.0). Two independent
        # checks, neither able to substitute for the other -- the early one alone would have
        # PASSED on the night this happened.
        $earlyCheckIndex = $source.IndexOf('rev-parse HEAD', [StringComparison]::Ordinal)
        $earlyCheckIndex | Should -BeGreaterThan 0
        $source | Should -Match "rev-parse\s+'HEAD:lib'"
        $source | Should -Match "rev-parse\s+'HEAD:bin'"
        $source | Should -Match "rev-parse\s+'HEAD:\.skills'"
        $source | Should -Match "reason_code\s*=\s*'product_identity_mismatch'"
        # The early check must run, and fail closed, BEFORE the expensive pre-clean/seed/clone/
        # Gradle run -- not after -- so a wrong checkout never pays for the ~3.5 minute test.
        # Searches for the CALL site specifically (the assignment), not the bare function name --
        # that also matches its own definition, which sits above everything in this scriptblock.
        $preCleanIndex = $source.IndexOf('$longPathDeleteMaxLength = Remove-E1GuestBundleLongPathTree', [StringComparison]::Ordinal)
        $preCleanIndex | Should -BeGreaterThan 0
        $earlyCheckIndex | Should -BeLessThan $preCleanIndex
        # The late check compares kmp-test's OWN reported envelope version -- this is the one
        # that actually would have caught the real anomaly above, since the early git-level
        # check already passed it that night. Searches for the actual COMPARISON, not the bare
        # variable name -- $observedProductVersion is (deliberately) declared $null at the very
        # top of the try block already, so every guest-bundle catch branch can reference it
        # safely regardless of where an exception fires; that earlier declaration is not the
        # check this assertion cares about ordering.
        $reportParseIndex = $source.IndexOf('ConvertFrom-Json -ErrorAction Stop', [StringComparison]::Ordinal)
        $lateVersionCheckIndex = $source.IndexOf('$observedProductVersion -cne $ExpectedProductVersion', [StringComparison]::Ordinal)
        $lateVersionCheckIndex | Should -BeGreaterThan $reportParseIndex
        $source | Should -Match '\$observedProductVersion\s+-cne\s+\$ExpectedProductVersion'
        $source | Should -Match '\$productIdentityVerified\s+-and\s+\$sourceIdentityVerified\s+-and\s+\$process\.cleanup_ok'
        # Diagnostic capture explaining a version mismatch, not just detecting one -- the
        # auditor's leading hypothesis is a reparse point making Node's ESM loader resolve
        # import.meta.url into a different tree than the one actually checked out.
        $source | Should -Match 'fs\.realpathSync'
        $source | Should -Match "'--version'.*'--json'"
        $source | Should -Match '\(Get-Item\s+-LiteralPath\s+\$subdirPath\s+-Force\)\.Attributes'
        $source | Should -Match "-match\s+'\(\?i\)node\|kmp-test'"

        # 2026-09-29 (WO-A2 auditor finding): a plain `git clone` preserves whatever commit
        # SourceTemplateDir's own HEAD happened to be at -- correct only because that checkout is
        # verified independently, never because the clone itself pins anything. Assert the clone's
        # own identity too, fail-closed, before the expensive kmp-test run -- and derive the
        # expected tree from $ExpectedSourceCommit inside the clone's own repo, never a second
        # externally-supplied tree value to keep in sync.
        $cloneIndex = $source.IndexOf('product_smoke_clone_failed', [StringComparison]::Ordinal)
        $cloneIndex | Should -BeGreaterThan 0
        $sourceIdentityCheckIndex = $source.IndexOf('product_smoke_source_identity_unreadable', [StringComparison]::Ordinal)
        $sourceIdentityCheckIndex | Should -BeGreaterThan $cloneIndex
        $kmpTestRunIndex = $source.IndexOf("'--project-root'", [StringComparison]::Ordinal)
        $sourceIdentityCheckIndex | Should -BeLessThan $kmpTestRunIndex
        $source | Should -Match "rev-parse',\s*`"\`$ExpectedSourceCommit\^\{tree\}`""
        $source | Should -Match '\$sourceIdentityVerified\s*=\s*\(\$observedSourceCommit\s+-ceq\s+\$ExpectedSourceCommit\s+-and\s+\$observedSourceTree\s+-ceq\s+\$expectedSourceTree\)'
        $source | Should -Match "'product_smoke_source_identity_mismatch'"

        # 2026-09-29 (WO-A2 auditor decision, Amendment A5): the GRADLE_USER_HOME-level memory
        # override -- written AFTER the seed copy (into the fresh per-run $gradleHome, never the
        # certified seed itself) and BEFORE the clone/kmp-test run, so it is always in effect for
        # the actual build. Lower caps than NiA's own project-level gradle.properties, and
        # critically NO -Xms commitment on either daemon (that up-front commitment, 4g+4g against
        # this VM's fixed 8g RAM, is the root cause the two live daemon deaths trace to).
        $gradleMemoryWriteIndex = $source.IndexOf('$gradleMemoryOverridePath', [StringComparison]::Ordinal)
        $gradleMemoryWriteIndex | Should -BeGreaterThan $source.IndexOf('$environment.GRADLE_USER_HOME = $gradleHome', [StringComparison]::Ordinal)
        $gradleMemoryWriteIndex | Should -BeLessThan $cloneIndex
        Assert-E1GradleUserHomeCanonicalPropertiesWrite $source
        # 2026-09-29 (WO-A2 auditor decision, Amendment A5): direct, post-build evidence that
        # org.gradle.daemon=false actually took effect -- gradlew --status against the SAME
        # GRADLE_USER_HOME right after the build, checked for any still-alive "<PID> IDLE|BUSY" row.
        $daemonStatusIndex = $source.IndexOf("'--status'", [StringComparison]::Ordinal)
        $daemonStatusIndex | Should -BeGreaterThan $source.IndexOf('$process = & $script:E1InternalBoundedProcess @processParameters', [StringComparison]::Ordinal)
        $source | Should -Match 'GRADLE_USER_HOME the build just used'
        $source | Should -Match "-notmatch\s+'\(\?im\)"
        $source | Should -Match '\(IDLE\|BUSY\)'

        { Assert-E1GuestBundleResultShape 'run-agentic-eval-product-smoke' ([ordered]@{
            verdict = 'PASS'; reason_code = $null; exit_code = 1; error_codes = @('coverage_threshold_exceeded')
            tests_total = 1; tests_passed = 1; coverage_missed_lines = 23; individual_total = 4
            inference_sessions_consumed = 0; raw_envelope_json = '{}'; stdout_tail = @(); stderr_tail = @()
            exception_type = $null; exception_message = $null; exception_stack_trace = $null
            long_path_delete_entries_removed = 2
            product_identity_verified = $true; product_identity_mismatches = @()
            observed_product_commit = $fortyHex; observed_product_version = '0.16.0'
            observed_lib_tree_hash = $fortyHex; observed_bin_tree_hash = $fortyHex; observed_skills_tree_hash = $fortyHex
            identity_diagnostics = [ordered]@{ version_command_stdout = @() }
            source_identity_verified = $true; observed_source_commit = $fortyHex
            observed_source_tree = $fortyHex; expected_source_tree = $fortyHex
            gradle_memory_override_sha256 = $sixtyFourHex; no_gradle_daemon_survived = $true
            kmp_test_duration_ms = 93000
        }) } | Should -Not -Throw
        { Assert-E1GuestBundleResultShape 'run-agentic-eval-product-smoke' ([ordered]@{
            verdict = 'FAIL'; reason_code = 'product_identity_mismatch'; exit_code = $null; error_codes = @()
            tests_total = 0; tests_passed = 0; coverage_missed_lines = 0; individual_total = 0
            inference_sessions_consumed = 0; raw_envelope_json = $null; stdout_tail = @(); stderr_tail = @()
            exception_type = $null; exception_message = $null; exception_stack_trace = $null
            long_path_delete_entries_removed = $null
            product_identity_verified = $false; product_identity_mismatches = @("commit: expected $fortyHex, observed 'deadbeef'")
            observed_product_commit = 'deadbeef'; observed_product_version = $null
            observed_lib_tree_hash = $null; observed_bin_tree_hash = $null; observed_skills_tree_hash = $null
            identity_diagnostics = $null
            source_identity_verified = $false; observed_source_commit = $null
            observed_source_tree = $null; expected_source_tree = $null
            gradle_memory_override_sha256 = $null; no_gradle_daemon_survived = $false
            kmp_test_duration_ms = 93000
        }) } | Should -Not -Throw
        { Assert-E1GuestBundleResultShape 'run-agentic-eval-product-smoke' ([ordered]@{
            verdict = 'FAIL'; reason_code = 'product_smoke_source_identity_mismatch'; exit_code = $null; error_codes = @()
            tests_total = 0; tests_passed = 0; coverage_missed_lines = 0; individual_total = 0
            inference_sessions_consumed = 0; raw_envelope_json = $null; stdout_tail = @(); stderr_tail = @()
            exception_type = $null; exception_message = $null; exception_stack_trace = $null
            long_path_delete_entries_removed = 2
            product_identity_verified = $true; product_identity_mismatches = @()
            observed_product_commit = $fortyHex; observed_product_version = '0.16.0'
            observed_lib_tree_hash = $fortyHex; observed_bin_tree_hash = $fortyHex; observed_skills_tree_hash = $fortyHex
            identity_diagnostics = $null
            source_identity_verified = $false; observed_source_commit = 'deadbeef'
            observed_source_tree = 'deadbeef'; expected_source_tree = $fortyHex
            gradle_memory_override_sha256 = $sixtyFourHex; no_gradle_daemon_survived = $true
            kmp_test_duration_ms = 93000
        }) } | Should -Not -Throw
    }

    It 'raw_envelope_json survives a depth-5 JSON round-trip byte-identical; the equivalent parsed object does not (WO-A2 D3 auditor finding)' {
        # A deliberately deep (8-level) kmp-test-envelope-shaped structure, mirroring where a real
        # envelope actually nests this far: tool -> parallel -> legs[0] -> execution -> counts ->
        # fresh (6 levels) plus two more wrapping levels this test adds on top, so the loss is
        # provoked at a depth a real envelope can genuinely reach, not an artificially deep fixture.
        $deepEnvelope = [ordered]@{
            tool = 'kmp-test'
            parallel = [ordered]@{
                legs = @(
                    [ordered]@{
                        execution = [ordered]@{
                            counts = [ordered]@{
                                detail = [ordered]@{
                                    fresh = 1
                                    marker = 'depth-8-leaf-value'
                                }
                            }
                        }
                    }
                )
            }
        }
        # Fully faithful (no depth loss) -- this is what a real `node ... --json` call would print
        # to stdout, which is exactly what raw_envelope_json stores verbatim.
        $envelopeJsonText = $deepEnvelope | ConvertTo-Json -Depth 20 -Compress

        # RED: embedding the PARSED OBJECT (not the string) as a property, then round-tripping the
        # OUTER object through the same -Depth 5 this module actually uses, loses the deep leaf --
        # proving the bug this fix replaces is real, not hypothetical.
        $viaObject = [ordered]@{ raw_envelope = $deepEnvelope } | ConvertTo-Json -Depth 5 | ConvertFrom-Json
        $viaObject.raw_envelope.parallel.legs[0].execution.counts.detail.marker | Should -Not -Be 'depth-8-leaf-value'

        # GREEN: embedding the pre-serialized STRING survives the identical -Depth 5 round-trip
        # byte-identical -- a string is a scalar to ConvertTo-Json regardless of what it contains.
        $viaString = [ordered]@{ raw_envelope_json = $envelopeJsonText } | ConvertTo-Json -Depth 5 | ConvertFrom-Json
        $viaString.raw_envelope_json | Should -Be $envelopeJsonText
        ($viaString.raw_envelope_json | ConvertFrom-Json).parallel.legs[0].execution.counts.detail.marker | Should -Be 'depth-8-leaf-value'
    }

    It 'declares a provider-free offline Gradle task probe, scenario-parameterized (not hardcoded to core:domain), with bounded diagnostics' {
        $arguments = [ordered]@{
            HarnessDir        = 'C:\kmp-eval\harness'
            SourceTemplateDir = 'C:\kmp-eval\source'
            GradleTask        = ':core:common:test'
            ProbeRoot         = 'C:\Evidence1Private\campaign\gradle-offline-probe'
        }
        { Assert-E1GuestBundleArguments 'run-gradle-task-offline' $arguments } | Should -Not -Throw
        $bundle = (Get-E1GuestBundleRegistry)['run-gradle-task-offline']
        $bundle.argument_schema.Keys | Should -Be @('HarnessDir', 'SourceTemplateDir', 'GradleTask', 'ProbeRoot')
        $source = $bundle.scriptblock.ToString()
        # Must dot-source the launch script in library mode BEFORE using any of
        # $script:E1GradleUserHomeSeedDir / $script:E1InternalBoundedProcess /
        # New-E1DualConditionCanaryRuntimeEnvironment -- the exact bug this
        # bundle's first draft had (confirmed live against the real guest: a
        # "$script:E1GradleUserHomeSeedDir ... has not been set" failure).
        $source | Should -Match '\. \$worker -InternalLibrary'
        $dotSourceIndex = $source.IndexOf('. $worker -InternalLibrary', [StringComparison]::Ordinal)
        $dotSourceIndex | Should -BeGreaterThan 0
        # Search for the real CODE usage strictly after the dot-source point --
        # not the first textual occurrence of the variable name, which also
        # appears earlier in this test's own explanatory comment above the
        # dot-source line (the same self-referential-scan gotcha the Round C
        # rehearsal test's own header already documents for this codebase).
        $seedDirUseIndex = $source.IndexOf('$script:E1GradleUserHomeSeedDir', $dotSourceIndex, [StringComparison]::Ordinal)
        $seedDirUseIndex | Should -BeGreaterThan $dotSourceIndex
        # Scenario-parameterized: the task comes from the caller's own $GradleTask,
        # never a literal ':core:domain' the way run-agentic-eval-product-smoke's
        # kmp-test invocation is -- this is what makes the bundle usable for ANY
        # scenario's own Gradle task, not just the anchor.
        $source | Should -Match '\$GradleTask'
        $source | Should -Not -Match "':core:domain'"
        $source | Should -Match "'--offline'"
        $source | Should -Not -Match 'kmp-test\.js|''parallel'''
        $source | Should -Match 'E1GradleUserHomeSeedDir'
        $source | Should -Match "cpSync\(process\.argv\[1\],process\.argv\[2\],\{recursive:true\}\)"
        $source | Should -Match 'GRADLE_USER_HOME\s*=\s*\$gradleHome'
        # 2026-09-29 (WO-A2 auditor decision, Amendment A5): same symmetric memory override as
        # run-agentic-eval-product-smoke's own identical write -- see its comment for the full
        # rationale (two live daemon deaths traced to NiA's own committed heap against this VM's
        # fixed 8g RAM).
        Assert-E1GradleUserHomeCanonicalPropertiesWrite $source
        # Never a schtasks/elevated/network-adapter touch -- this bundle relies
        # entirely on the --offline flag, never on disconnecting anything itself.
        $source | Should -Not -Match 'schtasks|Get-VMNetworkAdapter|Disconnect-VMNetworkAdapter|Set-VMNetworkAdapter'
        # 2026-09-29 (WO-A2 auditor finding): same named-input-missing treatment as
        # run-agentic-eval-product-smoke's own identical guard -- see its comment.
        $source | Should -Match 'throw\s+"gradle_offline_probe_input_missing:\$inputName"'
        $source | Should -Match 'SourceTemplateDir\s*=\s*\$SourceTemplateDir'
        # Bounded diagnostics, not a raw/unbounded dump.
        $source | Should -Match '\.Length\s+-gt\s+2000'
        $source | Should -Match '-replace'
        $source | Should -Match '\$task\.stdout'
        $source | Should -Match '\$task\.stderr'
        # 2026-09-29 wedge fix (WO-A2 auditor finding, proven live): same long-path-safe
        # ProbeRoot pre-clean and whole-body exception capture as the other two bundles.
        $source | Should -Not -Match 'Remove-Item\s+-LiteralPath\s+\$ProbeRoot\s+-Recurse\s+-Force'
        $source | Should -Match 'Remove-E1GuestBundleLongPathTree\b'
        $source | Should -Match 'fs\.rmSync\(targetPath,\{recursive:true,force:true,maxRetries:3\}\)'
        $source | Should -Match "reason_code\s*=\s*'bundle_exception'"
        $source | Should -Match '\$_\.Exception\.GetType\(\)\.FullName'
        $source | Should -Match '\$_\.ScriptStackTrace'
        { Assert-E1GuestBundleResultShape 'run-gradle-task-offline' ([ordered]@{
            verdict = 'PASS'; reason_code = $null; exit_code = 0; offline_resolved = $true; diagnostic_tail = $null
            exception_type = $null; exception_message = $null; exception_stack_trace = $null
            long_path_delete_entries_removed = 42
            gradle_memory_override_sha256 = $sixtyFourHex
        }) } | Should -Not -Throw
        { Assert-E1GuestBundleResultShape 'run-gradle-task-offline' ([ordered]@{
            verdict = 'FAIL'; reason_code = 'gradle_offline_probe_task_failed'; exit_code = 1; offline_resolved = $false; diagnostic_tail = 'Could not resolve dependency'
            exception_type = $null; exception_message = $null; exception_stack_trace = $null
            long_path_delete_entries_removed = 42
            gradle_memory_override_sha256 = $sixtyFourHex
        }) } | Should -Not -Throw
        { Assert-E1GuestBundleResultShape 'run-gradle-task-offline' ([ordered]@{
            verdict = 'FAIL'; reason_code = 'bundle_exception'; exit_code = $null; offline_resolved = $false; diagnostic_tail = $null
            exception_type = 'System.IO.DirectoryNotFoundException'; exception_message = 'Could not find a part of the path.'
            exception_stack_trace = 'at <ScriptBlock>, <No file>: line 1'
            long_path_delete_entries_removed = $null
            gradle_memory_override_sha256 = $null
        }) } | Should -Not -Throw
    }

    It 'declares a closed-enum Gradle diagnostic probe (WO-A2 D3), never a free-form args channel' {
        $sixtyFourHex = ('0123456789abcdef' * 4)
        $bundle = (Get-E1GuestBundleRegistry)['run-gradle-diagnostic-probe']
        $bundle.argument_schema.Keys | Should -Be @('HarnessDir', 'SourceTemplateDir', 'ProbeMode', 'ProbeRoot')
        # ProbeMode must be a closed enum, exactly the three modes the auditor's own work order
        # named -- this is what keeps the bundle "reviewed code changes only" (this module's own
        # header) rather than a new caller-args-become-command-line channel.
        $probeModeValidator = $bundle.argument_schema['ProbeMode']
        & $probeModeValidator 'tasks-probe' | Should -Be $true
        & $probeModeValidator 'tasks-probe-offline' | Should -Be $true
        & $probeModeValidator 'core-domain-test' | Should -Be $true
        & $probeModeValidator 'anything-else' | Should -Be $false
        & $probeModeValidator '; rm -rf C:\' | Should -Be $false

        $source = $bundle.scriptblock.ToString()
        $source | Should -Match '\. \$worker -InternalLibrary'
        $dotSourceIndex = $source.IndexOf('. $worker -InternalLibrary', [StringComparison]::Ordinal)
        $dotSourceIndex | Should -BeGreaterThan 0
        $seedDirUseIndex = $source.IndexOf('$script:E1GradleUserHomeSeedDir', $dotSourceIndex, [StringComparison]::Ordinal)
        $seedDirUseIndex | Should -BeGreaterThan $dotSourceIndex
        # P1/P3 must genuinely omit --offline (that absence is the entire point of the
        # diagnosis); only P2 (tasks-probe-offline) adds it.
        $source | Should -Match "'tasks-probe'\s*\{\s*@\('tasks', '--all', '--quiet'\)\s*\}"
        $source | Should -Match "'tasks-probe-offline'\s*\{\s*@\('tasks', '--all', '--quiet', '--offline'\)\s*\}"
        $source | Should -Match "'core-domain-test'\s*\{\s*@\(':core:domain:test'\)\s*\}"
        # gradlew --stop after the probe, same GRADLE_USER_HOME -- never a different one.
        $source | Should -Match "'--stop'"
        $source | Should -Match 'GRADLE_USER_HOME\s*=\s*\$gradleHome'
        # 2026-09-29 (WO-A2 auditor decision, Amendment A5): same symmetric memory override as
        # run-agentic-eval-product-smoke's own identical write -- see its comment for the full
        # rationale.
        Assert-E1GradleUserHomeCanonicalPropertiesWrite $source
        # 2026-09-29 (WO-A2 auditor finding): same named-input-missing treatment as
        # run-agentic-eval-product-smoke's own identical guard -- see its comment.
        $source | Should -Match 'throw\s+"gradle_diagnostic_probe_input_missing:\$inputName"'
        $source | Should -Match 'SourceTemplateDir\s*=\s*\$SourceTemplateDir'
        # Wall time genuinely measured around the probe call, not hardcoded/omitted.
        $source | Should -Match '\$started\s*=\s*Get-Date'
        $source | Should -Match 'TotalMilliseconds'
        # Never a schtasks/elevated/network-adapter touch.
        $source | Should -Not -Match 'schtasks|Get-VMNetworkAdapter|Disconnect-VMNetworkAdapter|Set-VMNetworkAdapter'
        # H-flake work order item 2 (auditor, 2026-09-29): a tail-only capture drops the
        # exception HEAD once a crash's stack trace pushes it past the last 60 lines. The
        # head search is bounded (fixed MaxLines, no unbounded text) and version capture
        # uses gradlew's own --version banner, never a caller-supplied argument.
        $source | Should -Match "'Exception\|Caused by'"
        $source | Should -Match 'Get-E1GuestBundleDiagnosticHeadLines'
        $source | Should -Match "-Arguments @\('--version'\)"
        # 2026-09-29 wedge fix (WO-A2 auditor finding, proven live): same long-path-safe
        # ProbeRoot pre-clean as the smoke bundle, and the same whole-body exception capture.
        $source | Should -Not -Match 'Remove-Item\s+-LiteralPath\s+\$ProbeRoot\s+-Recurse\s+-Force'
        $source | Should -Match 'Remove-E1GuestBundleLongPathTree\b'
        $source | Should -Match 'fs\.rmSync\(targetPath,\{recursive:true,force:true,maxRetries:3\}\)'
        $source | Should -Match "reason_code\s*=\s*'bundle_exception'"
        $source | Should -Match '\$_\.Exception\.GetType\(\)\.FullName'
        $source | Should -Match '\$_\.ScriptStackTrace'
        { Assert-E1GuestBundleResultShape 'run-gradle-diagnostic-probe' ([ordered]@{
            verdict = 'PASS'; reason_code = $null; exit_code = 0; wall_time_ms = 4200; output_tail = @('BUILD SUCCESSFUL')
            output_head = @(); gradle_version_output = 'Gradle 9.0.0'
            exception_type = $null; exception_message = $null; exception_stack_trace = $null
            long_path_delete_entries_removed = 42
            gradle_memory_override_sha256 = $sixtyFourHex
        }) } | Should -Not -Throw
        { Assert-E1GuestBundleResultShape 'run-gradle-diagnostic-probe' ([ordered]@{
            verdict = 'FAIL'; reason_code = 'gradle_diagnostic_probe_task_failed'; exit_code = 1; wall_time_ms = 61000; output_tail = @('Cannot locate tasks that match')
            output_head = @('e: Script compilation error'); gradle_version_output = 'Gradle 9.0.0'
            exception_type = $null; exception_message = $null; exception_stack_trace = $null
            long_path_delete_entries_removed = 42
            gradle_memory_override_sha256 = $sixtyFourHex
        }) } | Should -Not -Throw
        { Assert-E1GuestBundleResultShape 'run-gradle-diagnostic-probe' ([ordered]@{
            verdict = 'FAIL'; reason_code = 'bundle_exception'; exit_code = $null; wall_time_ms = $null; output_tail = @()
            output_head = @(); gradle_version_output = $null
            exception_type = 'System.IO.DirectoryNotFoundException'; exception_message = 'Could not find a part of the path.'
            exception_stack_trace = 'at <ScriptBlock>, <No file>: line 1'
            long_path_delete_entries_removed = $null
            gradle_memory_override_sha256 = $null
        }) } | Should -Not -Throw
    }

    It 'exception-head capture finds a crash a tail-only window would drop (H-flake work order item 2)' {
        # A faithful port of Get-E1GuestBundleDiagnosticHeadLines/TailLines from the bundle's
        # own scriptblock -- kept here, not invoked there, because the scriptblock only runs
        # inside the guest session; parity with the real source is enforced by the sibling
        # 'declares a closed-enum...' test's regex assertions on the actual function bodies.
        function Test-TailLines([string]$Text, [int]$MaxLines = 60) {
            if ([string]::IsNullOrEmpty($Text)) { return @() }
            $lines = $Text -split '\r?\n'
            if ($lines.Count -le $MaxLines) { return $lines }
            return $lines[-$MaxLines..-1]
        }
        function Test-HeadLines([string]$Text, [int]$MaxLines = 40) {
            if ([string]::IsNullOrEmpty($Text)) { return @() }
            $lines = $Text -split '\r?\n'
            $matchIndex = -1
            for ($i = 0; $i -lt $lines.Count; $i++) {
                if ($lines[$i] -match 'Exception|Caused by') { $matchIndex = $i; break }
            }
            if ($matchIndex -lt 0) { return @() }
            $endIndex = [Math]::Min($lines.Count - 1, $matchIndex + $MaxLines - 1)
            return $lines[$matchIndex..$endIndex]
        }

        # 150 lines total: the crash signature sits at line 50, followed by 100 more lines
        # of stack trace / Gradle's own failure footer -- mirroring the real P2 shape, where
        # a compiler crash is buried well before Gradle's trailing "BUILD FAILED" noise.
        $before = 1..49 | ForEach-Object { "build output line $_" }
        $crashLine = 'Caused by: java.lang.ClassCastException: ByteArrayCharSequence cannot be cast to ZipEntryDescription'
        $after = 1..100 | ForEach-Object { "trailer line $_" }
        $combined = (@($before) + @($crashLine) + @($after)) -join "`n"

        # RED: proves the bug is real, not hypothetical -- the last-60-lines window this
        # bundle shipped with (WO-A2 D3) never reaches back to line 50 of 150.
        $tail = Test-TailLines $combined 60
        ($tail -join "`n") | Should -Not -Match 'ClassCastException'

        # GREEN: the head window starts at the first Exception/Caused by match, so it
        # captures the crash line whether the surrounding transcript is 150 lines or 1500.
        $head = Test-HeadLines $combined 40
        ($head -join "`n") | Should -Match 'ClassCastException'
        $head[0] | Should -Match '^Caused by:'
        $head.Count | Should -Be 40
    }

    It 'declares injected zero-inference attestations for the synchronized harness commit' {
        $arguments = [ordered]@{
            HarnessCommit = ('a' * 40)
            CampaignId = '11111111-1111-1111-1111-111111111111'
            ClaudeAttestationFile = 'C:\kmp-eval\measurement-scopes\claude.json'
            CodexAttestationFile = 'C:\kmp-eval\measurement-scopes\codex.json'
        }
        { Assert-E1GuestBundleArguments 'prepare-agentic-eval-isolation-attestations' $arguments } | Should -Not -Throw
        (Get-E1GuestBundleRegistry)['prepare-agentic-eval-isolation-attestations'].argument_schema.Keys |
            Should -Be @('HarnessCommit', 'CampaignId', 'ClaudeAttestationFile', 'CodexAttestationFile')
        { Assert-E1GuestBundleResultShape 'prepare-agentic-eval-isolation-attestations' ([ordered]@{
            harness_commit = ('a' * 40)
            expires_at = '2026-09-21T20:00:00Z'
            inference_sessions_consumed = 0
        }) } | Should -Not -Throw
    }

    It 'builds both runtime attestations from the injected campaign and harness commit' {
        $claudePath = Join-Path $TestDrive 'claude.json'
        $codexPath = Join-Path $TestDrive 'codex.json'
        $bundle = (Get-E1GuestBundleRegistry)['prepare-agentic-eval-isolation-attestations']
        $result = & $bundle.scriptblock ('b' * 40) '22222222-2222-2222-2222-222222222222' $claudePath $codexPath
        $claude = Get-Content -LiteralPath $claudePath -Raw | ConvertFrom-Json
        $codex = Get-Content -LiteralPath $codexPath -Raw | ConvertFrom-Json

        $result.inference_sessions_consumed | Should -Be 0
        $result.harness_commit | Should -BeExactly ('b' * 40)
        $claude.runtime_id | Should -BeExactly 'claude-code'
        $codex.runtime_id | Should -BeExactly 'codex-cli'
        $claude.campaign_id | Should -BeExactly '22222222-2222-2222-2222-222222222222'
        $codex.harness_sha | Should -BeExactly ('b' * 40)
        $claude.expires_at | Should -BeExactly $codex.expires_at
    }

    It 'declares a zero-inference Codex attestation refresh result' {
        { Assert-E1GuestBundleArguments 'refresh-codex-isolation-attestation' @{} } | Should -Not -Throw
        { Assert-E1GuestBundleResultShape 'refresh-codex-isolation-attestation' ([ordered]@{
            attestation_refreshed = $true; harness_sha = ('a' * 40)
            attestation_sha256 = ('b' * 64); expires_at = '2026-09-20T20:00:00Z'
            inference_sessions_consumed = 0
        }) } | Should -Not -Throw
    }
}

Describe 'Long-path guest delete (WO-A2 auditor finding, 2026-09-29): PowerShell 5.1 Remove-Item -Recurse fails past MAX_PATH, the Node helper does not' {
    # Real platform behavior, not the scriptblock -- same precedent as the raw_envelope_json
    # round-trip test above: the scriptblock only runs inside the guest session, so what's
    # provable here is the underlying mechanism the fix actually depends on, executed for real.
    #
    # Mirrors the real accessor layout that triggered this live (docs/audits/
    # evidence2-preregistration.md Amendment A2 §5): gradle-home\caches\<ver>\
    # dependencies-accessors\<hash>\classes\org\gradle\accessors\dm\<Name>.class. Built with
    # Node's own mkdirSync/writeFileSync (not New-Item), because creation must not hit the same
    # limit this test is trying to prove about DELETION specifically.
    BeforeAll {
        function New-E1LongPathFixture([string]$Root) {
            $node = (Get-Command node -ErrorAction Stop).Source
            $deepPath = Join-Path $Root 'gradle-home\caches\9.4.0\dependencies-accessors\0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd\classes\org\gradle\accessors\dm\nested\deeper\evenmorenesting'
            $filePath = Join-Path $deepPath 'Core_DatastoreProtoProjectDependency.class'
            $script = 'const fs=require("node:fs");const p=process.argv[1];const f=process.argv[2];fs.mkdirSync(p,{recursive:true});fs.writeFileSync(f,"stub class bytes");process.stdout.write(String(f.length))'
            $create = & $node '-e' $script $deepPath $filePath 2>&1
            if ($LASTEXITCODE -ne 0) { throw "fixture_creation_failed: $create" }
            return @{ FilePath = $filePath; Length = [int]$create }
        }
    }

    It 'RED: real powershell.exe (5.1) Remove-Item -Recurse -Force fails on a path past 260 characters, with .NET''s MAX_PATH message class -- UNLESS this host has Windows long-path support enabled, which changes the failure mode itself, not just this test' {
        # Checked, not assumed: HKLM's LongPathsEnabled is an OS-level Win32 setting that
        # changes what Remove-Item -Recurse can do regardless of PowerShell version, and is a
        # real, observed difference between hosts -- not something this test may silently paper
        # over by asserting a failure that this specific host does not actually produce.
        # Confirmed empirically before writing this guard: on a host with this key set to 1,
        # neither -Recurse alone nor forcing COMPLUS_LegacyPathHandling=1 on the child process
        # reproduces the legacy failure (the OS-level flag wins over the process-level one) --
        # and flipping the machine-wide registry key is out of scope for a test to do. The GREEN
        # test below, and item 4's real in-situ guest run, are what actually prove the fix on a
        # host where the failure mode is real.
        $longPathsEnabled = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name 'LongPathsEnabled' -ErrorAction SilentlyContinue).LongPathsEnabled
        $root = Join-Path $env:TEMP ("e1-longpath-red-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
        try {
            $fixture = New-E1LongPathFixture $root
            $fixture.Length | Should -BeGreaterThan 260

            $ps51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            Test-Path -LiteralPath $ps51 | Should -BeTrue
            $result = & $ps51 '-NoProfile' '-NonInteractive' '-Command' "Remove-Item -LiteralPath '$root' -Recurse -Force -ErrorAction Stop" 2>&1
            $exitCode = $LASTEXITCODE

            if ($longPathsEnabled -eq 1) {
                # Honest report, not a fabricated pass: on THIS host the classic MAX_PATH
                # failure this fix targets does not reproduce, because long paths are enabled
                # at the OS level. Assert what is actually true here instead of what the guest
                # (long paths NOT enabled there, per the real failure this fix responds to) does.
                Set-ItResult -Inconclusive -Because 'this host has HKLM FileSystem\LongPathsEnabled=1, so PowerShell 5.1''s Remove-Item -Recurse does not hit the classic MAX_PATH failure here; the guest that produced the real failure does not have this set. See the GREEN test below and item 4''s real in-situ guest run for the actual proof.'
            } else {
                $exitCode | Should -Not -Be 0
                ($result | Out-String) | Should -Match 'Could not find a part of the path|PathTooLongException|already exists'
                # Proves the failure is real, not merely reported: the tree is still there.
                Test-Path -LiteralPath $fixture.FilePath | Should -BeTrue
            }
        } finally {
            # Cleanup uses the SAME long-path-safe mechanism as the fix itself -- a plain
            # Remove-Item here would hit the identical RED failure this test just proved.
            $node = (Get-Command node -ErrorAction SilentlyContinue).Source
            if ($node -and (Test-Path -LiteralPath $root)) {
                & $node '-e' 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:true,maxRetries:3})' $root 2>&1 | Out-Null
            }
        }
    }

    It 'GREEN: the Node fs.rmSync mechanism the fix uses deletes the same tree completely' {
        $root = Join-Path $env:TEMP ("e1-longpath-green-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
        try {
            $fixture = New-E1LongPathFixture $root
            $fixture.Length | Should -BeGreaterThan 260
            Test-Path -LiteralPath $fixture.FilePath | Should -BeTrue

            $node = (Get-Command node -ErrorAction Stop).Source
            # Byte-identical to Remove-E1GuestBundleLongPathTree's own script, modulo the
            # max-path-length reporting this test doesn't need.
            & $node '-e' 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:true,maxRetries:3})' $root 2>&1 | Out-Null
            $LASTEXITCODE | Should -Be 0

            Test-Path -LiteralPath $fixture.FilePath | Should -BeFalse
            Test-Path -LiteralPath $root | Should -BeFalse
        } finally {
            if (Test-Path -LiteralPath $root) {
                $node = (Get-Command node -ErrorAction SilentlyContinue).Source
                if ($node) { & $node '-e' 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:true,maxRetries:3})' $root 2>&1 | Out-Null }
            }
        }
    }
}

Describe 'Dot-sourced worker param clobbering (WO-A2 auditor root cause, 2026-09-29): a bare ". $worker" silently rebinds overlapping caller variables to the worker''s own defaults' {
    # Confirmed live: run-agentic-eval-product-smoke's own identity check (added earlier
    # the same night) observed guest HEAD 2c177c0 -- the Evidence1 stage-B harness commit
    # -- 80 seconds after ToolchainReady had verified ee6d82b in the SAME directory.
    # evidence1-dual-condition-canary-launch.ps1:5-6 declares $HarnessDir/$SourceTemplateDir
    # with its own Evidence1 defaults; dot-sourcing it with ". $worker -InternalLibrary" and
    # no matching -HarnessDir/-SourceTemplateDir silently rebinds those names, in the
    # CALLER's own scope, to those defaults. The directory never changed; the variable did.
    #
    # This guard is deliberately generic -- it AST-scans every registry scriptblock for ANY
    # dot-source of a param()-having script and fails on ANY overlapping name the caller
    # already held that isn't passed back explicitly, not just the two names this incident
    # happened to catch. A future worker param, or a future bundle, trips the same guard.
    BeforeAll {
        $script:WorkerScriptPath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits/evidence1-dual-condition-canary-launch.ps1'
        $script:WorkerParamNames = @(
            ([System.Management.Automation.Language.Parser]::ParseFile($script:WorkerScriptPath, [ref]$null, [ref]$null)).ParamBlock.Parameters |
            ForEach-Object { $_.Name.VariablePath.UserPath }
        )
        $script:WorkerParamNames.Count | Should -BeGreaterThan 0

        function Find-E1DotSourceParamClobberViolations([System.Management.Automation.Language.ScriptBlockAst]$SbAst, [string[]]$WorkerParamNames) {
            $violations = @()
            $dotSources = $SbAst.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.CommandAst] -and
                $node.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Dot
            }, $true)
            foreach ($dotSource in $dotSources) {
                $ownParamNames = @($SbAst.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
                $priorAssignedNames = @(
                    $SbAst.FindAll({
                        param($node)
                        $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
                        $node.Left -is [System.Management.Automation.Language.VariableExpressionAst]
                    }, $true) |
                    Where-Object { $_.Extent.StartOffset -lt $dotSource.Extent.StartOffset } |
                    ForEach-Object { $_.Left.VariablePath.UserPath }
                )
                $inScopeNames = @($ownParamNames + $priorAssignedNames | Select-Object -Unique)
                $passedNames = @(
                    $dotSource.CommandElements |
                    Where-Object { $_ -is [System.Management.Automation.Language.CommandParameterAst] } |
                    ForEach-Object { $_.ParameterName }
                )
                $overlap = @($inScopeNames | Where-Object { $_ -in $WorkerParamNames })
                $missing = @($overlap | Where-Object { $_ -notin $passedNames })
                foreach ($name in $missing) {
                    $violations += "dot-source `"$($dotSource.Extent.Text)`" at offset $($dotSource.Extent.StartOffset) does not pass -$name explicitly"
                }
            }
            return $violations
        }
    }

    It 'RED: a synthetic scriptblock that dot-sources the worker without passing its own pre-existing $HarnessDir is flagged' {
        $redSource = @'
param($HarnessDir, $SourceTemplateDir)
$worker = Join-Path $HarnessDir "docs\audits\evidence1-dual-condition-canary-launch.ps1"
. $worker -InternalLibrary
'@
        $redAst = [System.Management.Automation.Language.Parser]::ParseInput($redSource, [ref]$null, [ref]$null)
        $violations = Find-E1DotSourceParamClobberViolations $redAst $script:WorkerParamNames
        $violations.Count | Should -BeGreaterThan 0
        ($violations -join ';') | Should -Match 'HarnessDir'
        ($violations -join ';') | Should -Match 'SourceTemplateDir'
    }

    It 'GREEN: the same synthetic scriptblock passing both explicitly is not flagged' {
        $greenSource = @'
param($HarnessDir, $SourceTemplateDir)
$worker = Join-Path $HarnessDir "docs\audits\evidence1-dual-condition-canary-launch.ps1"
. $worker -InternalLibrary -HarnessDir $HarnessDir -SourceTemplateDir $SourceTemplateDir
'@
        $greenAst = [System.Management.Automation.Language.Parser]::ParseInput($greenSource, [ref]$null, [ref]$null)
        $violations = Find-E1DotSourceParamClobberViolations $greenAst $script:WorkerParamNames
        $violations | Should -BeNullOrEmpty
    }

    It 'GREEN: every registry scriptblock''s own dot-source(s) of the worker pass all overlapping names explicitly' {
        $registry = Get-E1GuestBundleRegistry
        $allViolations = @()
        foreach ($bundleName in $registry.Keys) {
            $sbAst = $registry[$bundleName].scriptblock.Ast
            $violations = Find-E1DotSourceParamClobberViolations $sbAst $script:WorkerParamNames
            foreach ($violation in $violations) { $allViolations += "${bundleName}: $violation" }
        }
        $allViolations | Should -BeNullOrEmpty -Because ($allViolations -join '; ')
    }
}

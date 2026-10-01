# WO-08: the provider-free product smoke (run-agentic-eval-product-smoke) is driven by the campaign's scenario
# instead of being written for coverage-threshold-failure-v2 alone. The guest runs the scriptblock's own
# helper functions, so these tests lift them out of the bundle's AST and call them directly (the smoke itself
# needs a guest with Git, Node, the NowInAndroid clone and the Gradle seed, and is exercised by WO-10).
BeforeAll {
    $script:RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    Import-Module (Join-Path $script:RepoRoot 'docs/audits/evidence1-guest-bundle-contract.psm1') -Force
    $script:Bundle = (Get-E1GuestBundleRegistry)['run-agentic-eval-product-smoke']
    $script:SmokeAst = $script:Bundle.scriptblock.Ast
    $script:FixtureDir = Join-Path $script:RepoRoot 'tests/fixtures/agentic-eval-multi-module'
    $script:SmokeSource = $script:Bundle.scriptblock.ToString()

    # Defines the named function of the smoke scriptblock in this scope, from its own text.
    $script:SmokeFunctionNames = @('Resolve-E1SmokeScenario', 'Get-E1SmokeMultiModuleObservation', 'Test-E1SmokeMultiModuleMatches', 'Test-E1SmokePatchPostcondition')
    foreach ($name in $script:SmokeFunctionNames) {
        $definition = @($script:SmokeAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $true))
        if ($definition.Count -eq 1) { . ([scriptblock]::Create($definition[0].Extent.Text)) }
    }

    $script:FortyHex = '0123456789abcdef0123456789abcdef01234567'
    $script:SixtyFourHex = ('0123456789abcdef' * 4)

    # A harness checkout holding the multi-module scenario's files (the WO-06 drafts), the way the guest's
    # checkout would once the scenario is in the corpus.
    function script:New-TestHarness([string]$ScenarioId, [switch]$WithScenario, [switch]$WithExpected, [scriptblock]$EditScenario = $null, [scriptblock]$EditExpected = $null) {
        $harness = Join-Path $TestDrive ('harness-' + [guid]::NewGuid().ToString('N'))
        $corpus = Join-Path $harness 'tools\agentic-eval\corpus'
        New-Item -ItemType Directory -Force -Path (Join-Path $corpus 'scenarios'), (Join-Path $corpus 'expected') | Out-Null
        if ($WithScenario) {
            $scenario = [IO.File]::ReadAllText((Join-Path $script:FixtureDir 'scenario-draft.json')) | ConvertFrom-Json
            if ($null -ne $EditScenario) { & $EditScenario $scenario }
            [IO.File]::WriteAllText((Join-Path $corpus "scenarios\$ScenarioId.json"), ($scenario | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
        }
        if ($WithExpected) {
            $truth = [IO.File]::ReadAllText((Join-Path $script:FixtureDir 'expected-draft.json')) | ConvertFrom-Json
            if ($null -ne $EditExpected) { & $EditExpected $truth }
            [IO.File]::WriteAllText((Join-Path $corpus "expected\$ScenarioId.json"), ($truth | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
        }
        return $harness
    }

    function script:New-TestSmokeResult([switch]$WithObserved) {
        $result = [ordered]@{
            verdict = 'PASS'; reason_code = $null; exit_code = 1; error_codes = @('module_failed')
            tests_total = 27; tests_passed = 24; coverage_missed_lines = 0; individual_total = 93
            inference_sessions_consumed = 0; raw_envelope_json = '{}'; stdout_tail = @(); stderr_tail = @()
            exception_type = $null; exception_message = $null; exception_stack_trace = $null
            long_path_delete_entries_removed = 2
            product_identity_verified = $true; product_identity_mismatches = @()
            observed_product_commit = $script:FortyHex; observed_product_version = '0.16.0'
            observed_lib_tree_hash = $script:FortyHex; observed_bin_tree_hash = $script:FortyHex; observed_skills_tree_hash = $script:FortyHex
            identity_diagnostics = [ordered]@{ version_command_stdout = @() }
            source_identity_verified = $true; observed_source_commit = $script:FortyHex
            observed_source_tree = $script:FortyHex; expected_source_tree = $script:FortyHex
            gradle_memory_override_sha256 = $script:SixtyFourHex; no_gradle_daemon_survived = $true
            kmp_test_duration_ms = 93000
        }
        if ($WithObserved) {
            $result['observed_failing_modules'] = @(':core:data', ':core:domain', ':feature:bookmarks:impl')
            $result['observed_failed_test_classes'] = @('BookmarksViewModelTest', 'CompositeUserNewsResourceRepositoryTest', 'GetFollowableTopicsUseCaseTest')
            $result['observed_failed_count'] = 6
        }
        return $result
    }

    $script:Envelope = [IO.File]::ReadAllText((Join-Path $script:FixtureDir 'kmp-test-envelope-failing.json')) | ConvertFrom-Json
    $script:Expected = ([IO.File]::ReadAllText((Join-Path $script:FixtureDir 'expected-draft.json')) | ConvertFrom-Json).expected
}

Describe 'the smoke bundle declares the scenario it runs' {
    It 'takes ScenarioId as the last argument of its closed schema' {
        @($script:Bundle.argument_schema.Keys)[-1] | Should -BeExactly 'ScenarioId'
        @($script:Bundle.argument_schema.Keys).Count | Should -Be 10
    }

    It 'binds ScenarioId through the scriptblock''s own param() block, last, in the schema''s order' {
        $parameters = @($script:SmokeAst.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
        $parameters | Should -Be @($script:Bundle.argument_schema.Keys)
    }

    It 'accepts a kebab-case scenario id with the nine existing arguments' {
        foreach ($id in @('coverage-threshold-failure-v2', 'multi-module-test-failures')) {
            $arguments = [ordered]@{
                HarnessDir = 'C:\kmp-eval\harness'; SourceTemplateDir = 'C:\kmp-eval\source'
                SmokeRoot = 'C:\Evidence1Private\campaign\provider-free-product-smoke'
                ExpectedProductCommit = $script:FortyHex; ExpectedProductVersion = '0.16.0'
                ExpectedLibTreeHash = $script:FortyHex; ExpectedBinTreeHash = $script:FortyHex
                ExpectedSkillsTreeHash = $script:FortyHex; ExpectedSourceCommit = $script:FortyHex
                ScenarioId = $id
            }
            { Assert-E1GuestBundleArguments 'run-agentic-eval-product-smoke' $arguments } | Should -Not -Throw
        }
    }

    It 'rejects a caller that still sends only the nine arguments of the v2-only smoke' {
        $legacy = [ordered]@{
            HarnessDir = 'C:\kmp-eval\harness'; SourceTemplateDir = 'C:\kmp-eval\source'
            SmokeRoot = 'C:\Evidence1Private\campaign\provider-free-product-smoke'
            ExpectedProductCommit = $script:FortyHex; ExpectedProductVersion = '0.16.0'
            ExpectedLibTreeHash = $script:FortyHex; ExpectedBinTreeHash = $script:FortyHex
            ExpectedSkillsTreeHash = $script:FortyHex; ExpectedSourceCommit = $script:FortyHex
        }
        { Assert-E1GuestBundleArguments 'run-agentic-eval-product-smoke' $legacy } | Should -Throw '*guest_bundle_argument_shape_invalid*'
    }

    It 'rejects a scenario id that is not a bare kebab-case name' {
        foreach ($bad in @('', 'Coverage-Threshold', '..\evil', 'a/b', 'a.b', 'a b', 'scenario;x', $null, 7)) {
            $arguments = [ordered]@{
                HarnessDir = 'C:\kmp-eval\harness'; SourceTemplateDir = 'C:\kmp-eval\source'
                SmokeRoot = 'C:\Evidence1Private\campaign\provider-free-product-smoke'
                ExpectedProductCommit = $script:FortyHex; ExpectedProductVersion = '0.16.0'
                ExpectedLibTreeHash = $script:FortyHex; ExpectedBinTreeHash = $script:FortyHex
                ExpectedSkillsTreeHash = $script:FortyHex; ExpectedSourceCommit = $script:FortyHex
                ScenarioId = $bad
            }
            { Assert-E1GuestBundleArguments 'run-agentic-eval-product-smoke' $arguments } | Should -Throw '*guest_bundle_argument_invalid*' -Because "id: $bad"
        }
    }
}

Describe 'the smoke result shape: kmp_test_duration_ms for both families, observed_* for the multi-module one' {
    It 'declares kmp_test_duration_ms among the required result keys' {
        @($script:Bundle.result_keys) | Should -Contain 'kmp_test_duration_ms'
    }

    It 'declares the three observed_* keys as one optional group, not as required keys' {
        @($script:Bundle.result_keys) | Should -Not -Contain 'observed_failing_modules'
        @($script:Bundle.optional_result_keys) | Should -Be @('observed_failing_modules', 'observed_failed_test_classes', 'observed_failed_count')
    }

    It 'accepts the v2 receipt shape: the old keys plus kmp_test_duration_ms only' {
        { Assert-E1GuestBundleResultShape 'run-agentic-eval-product-smoke' (New-TestSmokeResult) } | Should -Not -Throw
    }

    It 'accepts the multi-module receipt shape: the v2 shape plus the three observed_* keys' {
        { Assert-E1GuestBundleResultShape 'run-agentic-eval-product-smoke' (New-TestSmokeResult -WithObserved) } | Should -Not -Throw
    }

    It 'accepts either shape after a JSON round trip (a PSCustomObject)' {
        $v2 = ((New-TestSmokeResult) | ConvertTo-Json -Depth 6) | ConvertFrom-Json
        $multi = ((New-TestSmokeResult -WithObserved) | ConvertTo-Json -Depth 6) | ConvertFrom-Json
        { Assert-E1GuestBundleResultShape 'run-agentic-eval-product-smoke' $v2 } | Should -Not -Throw
        { Assert-E1GuestBundleResultShape 'run-agentic-eval-product-smoke' $multi } | Should -Not -Throw
    }

    It 'rejects a result without kmp_test_duration_ms' {
        $result = New-TestSmokeResult
        $result.Remove('kmp_test_duration_ms')
        { Assert-E1GuestBundleResultShape 'run-agentic-eval-product-smoke' $result } | Should -Throw '*guest_bundle_result_shape_invalid*'
    }

    It 'rejects one or two of the observed_* keys without the others' {
        foreach ($keep in @(@('observed_failing_modules'), @('observed_failed_count'), @('observed_failing_modules', 'observed_failed_test_classes'))) {
            $result = New-TestSmokeResult
            foreach ($key in $keep) { $result[$key] = @() }
            { Assert-E1GuestBundleResultShape 'run-agentic-eval-product-smoke' $result } | Should -Throw '*guest_bundle_result_shape_invalid*' -Because ($keep -join ',')
        }
    }

    It 'still rejects a key outside both groups' {
        $result = New-TestSmokeResult -WithObserved
        $result['surprise'] = 1
        { Assert-E1GuestBundleResultShape 'run-agentic-eval-product-smoke' $result } | Should -Throw '*guest_bundle_result_shape_invalid*'
    }

    It 'leaves every other bundle''s shape check exact: no optional keys, no extras' {
        { Assert-E1GuestBundleResultShape 'get-firewall-sealed-state' ([ordered]@{ sealed = $true; observed_failed_count = 1 }) } | Should -Throw '*guest_bundle_result_shape_invalid*'
        { Assert-E1GuestBundleResultShape 'get-firewall-sealed-state' ([ordered]@{ sealed = $true }) } | Should -Not -Throw
    }

    It 'gives every result literal of the scriptblock the complete required key set, so no FAIL receipt fails the shape check' {
        $required = @($script:Bundle.result_keys)
        $literals = @($script:SmokeAst.FindAll({ param($node)
            $node -is [Management.Automation.Language.HashtableAst] -and
            (@($node.KeyValuePairs | ForEach-Object { $_.Item1.Extent.Text }) -contains 'verdict') -and
            (@($node.KeyValuePairs | ForEach-Object { $_.Item1.Extent.Text }) -contains 'tests_total')
        }, $true))
        # the identity mismatch return, the unsupported scenario return, the result itself and the bundle_exception return
        $literals.Count | Should -Be 4
        foreach ($literal in $literals) {
            $keys = @($literal.KeyValuePairs | ForEach-Object { $_.Item1.Extent.Text })
            @($required | Where-Object { $_ -cnotin $keys }) | Should -BeNullOrEmpty -Because "the literal at line $($literal.Extent.StartLineNumber)"
        }
    }
}

Describe 'Resolve-E1SmokeScenario' {
    # The guest runs the helpers under strict mode (the scriptblock sets it before it calls them).
    BeforeEach { Set-StrictMode -Version Latest }

    It 'gives the coverage scenario its v2 smoke without reading any file' {
        $resolved = Resolve-E1SmokeScenario (Join-Path $TestDrive 'no-such-harness') 'coverage-threshold-failure-v2'
        $resolved.supported | Should -BeTrue
        $resolved.mode | Should -BeExactly 'coverage-v2'
    }

    It 'describes a multi-module-tests scenario from its own files' {
        $harness = New-TestHarness 'multi-module-test-failures' -WithScenario -WithExpected
        $resolved = Resolve-E1SmokeScenario $harness 'multi-module-test-failures'
        $resolved.supported | Should -BeTrue
        $resolved.mode | Should -BeExactly 'multi-module-tests'
        $resolved.patch_file | Should -BeExactly 'multi-module-test-failures.patch'
        @($resolved.expected_paths).Count | Should -Be 2
        @($resolved.expected_paths)[0] | Should -Match '^core/data/src/main/kotlin/.+/CompositeUserNewsResourceRepository\.kt$'
        @($resolved.kmp_test_args)[0] | Should -BeExactly 'parallel'
        @($resolved.kmp_test_args) | Should -Contain '--json'
        $resolved.expected.outcome_kind | Should -BeExactly 'tests_failed'
        @($resolved.expected.failing_modules) | Should -Be @(':core:data', ':core:domain', ':feature:bookmarks:impl')
        @($resolved.expected.failed_test_classes) | Should -Be @('BookmarksViewModelTest', 'CompositeUserNewsResourceRepositoryTest', 'GetFollowableTopicsUseCaseTest')
        $resolved.expected.failed_count | Should -Be 6
    }

    It 'refuses an id with no scenario file' {
        $harness = New-TestHarness 'multi-module-test-failures' -WithExpected
        (Resolve-E1SmokeScenario $harness 'multi-module-test-failures').supported | Should -BeFalse
        (Resolve-E1SmokeScenario $harness 'no-such-scenario').supported | Should -BeFalse
    }

    It 'refuses a scenario whose ground-truth file is missing' {
        $harness = New-TestHarness 'multi-module-test-failures' -WithScenario
        (Resolve-E1SmokeScenario $harness 'multi-module-test-failures').supported | Should -BeFalse
    }

    It 'refuses a scenario of another family' {
        $harness = New-TestHarness 'multi-module-test-failures' -WithScenario -WithExpected -EditScenario { param($s) $s.family = 'test-only' }
        (Resolve-E1SmokeScenario $harness 'multi-module-test-failures').supported | Should -BeFalse
    }

    It 'refuses a scenario file that is not valid JSON, without throwing' {
        $harness = New-TestHarness 'multi-module-test-failures' -WithScenario -WithExpected
        [IO.File]::WriteAllText((Join-Path $harness 'tools\agentic-eval\corpus\scenarios\multi-module-test-failures.json'), '{ not json')
        { Resolve-E1SmokeScenario $harness 'multi-module-test-failures' } | Should -Not -Throw
        (Resolve-E1SmokeScenario $harness 'multi-module-test-failures').supported | Should -BeFalse
    }

    It 'refuses a file whose own id is not the requested one' {
        $harness = New-TestHarness 'multi-module-test-failures' -WithScenario -WithExpected -EditScenario { param($s) $s.id = 'another-scenario' }
        (Resolve-E1SmokeScenario $harness 'multi-module-test-failures').supported | Should -BeFalse
    }

    It 'refuses a multi-module scenario whose fixture_setup is not an apply_patch of a bare patch name' {
        $badFixtures = @(
            { param($s) $s.fixture_setup.operation = 'append_comment' },
            { param($s) $s.fixture_setup.patch_file = '..\other.patch' },
            { param($s) $s.fixture_setup.patch_file = 'Upper.patch' },
            { param($s) $s.fixture_setup.expected_paths = @() },
            { param($s) $s.fixture_setup.expected_paths = @('..\escape.kt') }
        )
        foreach ($edit in $badFixtures) {
            $harness = New-TestHarness 'multi-module-test-failures' -WithScenario -WithExpected -EditScenario $edit
            (Resolve-E1SmokeScenario $harness 'multi-module-test-failures').supported | Should -BeFalse -Because $edit.ToString()
        }
    }

    It 'refuses a multi-module scenario whose ground truth or smoke block is incomplete' {
        $badTruths = @(
            { param($t) $t.PSObject.Properties.Remove('smoke') },
            { param($t) $t.smoke.kmp_test_args = @() },
            { param($t) $t.expected.PSObject.Properties.Remove('failed_count') },
            { param($t) $t.expected.failing_modules = @() },
            { param($t) $t.expected.outcome_kind = 'something_else' }
        )
        foreach ($edit in $badTruths) {
            $harness = New-TestHarness 'multi-module-test-failures' -WithScenario -WithExpected -EditExpected $edit
            (Resolve-E1SmokeScenario $harness 'multi-module-test-failures').supported | Should -BeFalse -Because $edit.ToString()
        }
    }
}

Describe 'the smoke refuses a scenario it does not support before any guest work' {
    It 'returns a complete FAIL result with smoke_scenario_unsupported and creates nothing' {
        $harness = Join-Path $TestDrive 'harness-without-scenario'
        New-Item -ItemType Directory -Force -Path $harness | Out-Null
        $smokeRoot = Join-Path $TestDrive 'smoke-root'
        $result = & $script:Bundle.scriptblock -HarnessDir $harness -SourceTemplateDir $harness -SmokeRoot $smokeRoot `
            -ExpectedProductCommit $script:FortyHex -ExpectedProductVersion '0.16.0' -ExpectedLibTreeHash $script:FortyHex `
            -ExpectedBinTreeHash $script:FortyHex -ExpectedSkillsTreeHash $script:FortyHex -ExpectedSourceCommit $script:FortyHex `
            -ScenarioId 'no-such-scenario'
        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -BeExactly 'smoke_scenario_unsupported'
        $result.inference_sessions_consumed | Should -Be 0
        $result.kmp_test_duration_ms | Should -BeNullOrEmpty
        { Assert-E1GuestBundleResultShape 'run-agentic-eval-product-smoke' $result } | Should -Not -Throw
        Test-Path -LiteralPath $smokeRoot | Should -BeFalse
    }
}

Describe 'Get-E1SmokeMultiModuleObservation' {
    BeforeEach { Set-StrictMode -Version Latest }

    It 'reads the failing modules, simple class names and distinct failing tests from a real-shaped envelope' {
        $observed = Get-E1SmokeMultiModuleObservation $script:Envelope
        @($observed.failing_modules) | Should -Be @(':core:data', ':core:domain', ':feature:bookmarks:impl')
        @($observed.failed_test_classes) | Should -Be @('BookmarksViewModelTest', 'CompositeUserNewsResourceRepositoryTest', 'GetFollowableTopicsUseCaseTest')
        $observed.failed_count | Should -Be 6
    }

    It 'treats a module name with or without its leading colon the same way' {
        $withColons = [pscustomobject]@{ modules = @([pscustomobject]@{ name = ':core:data'; test_failures = @([pscustomobject]@{ test = 'a.b.FooTest.bar' }) }) }
        $without = [pscustomobject]@{ modules = @([pscustomobject]@{ name = 'core:data'; test_failures = @([pscustomobject]@{ test = 'a.b.FooTest.bar' }) }) }
        @((Get-E1SmokeMultiModuleObservation $withColons).failing_modules) | Should -Be @(':core:data')
        @((Get-E1SmokeMultiModuleObservation $without).failing_modules) | Should -Be @(':core:data')
    }

    It 'ignores a module without test_failures and a module with an empty list' {
        $report = [pscustomobject]@{ modules = @(
            [pscustomobject]@{ name = 'core:common' },
            [pscustomobject]@{ name = 'core:network'; test_failures = @() }) }
        $observed = Get-E1SmokeMultiModuleObservation $report
        @($observed.failing_modules).Count | Should -Be 0
        $observed.failed_count | Should -Be 0
    }

    It 'counts a test name that appears twice once' {
        $failure = [pscustomobject]@{ test = 'a.b.FooTest.bar' }
        $report = [pscustomobject]@{ modules = @(
            [pscustomobject]@{ name = 'm1'; test_failures = @($failure, $failure) },
            [pscustomobject]@{ name = 'm2'; test_failures = @([pscustomobject]@{ test = 'a.b.FooTest.baz' }) }) }
        (Get-E1SmokeMultiModuleObservation $report).failed_count | Should -Be 2
    }

    It 'takes the class from before the method, whatever a parameterized name carries in brackets' {
        $report = [pscustomobject]@{ modules = @([pscustomobject]@{ name = 'm'; test_failures = @(
            [pscustomobject]@{ test = 'com.x.ParamTest.check[1.5]' },
            [pscustomobject]@{ test = 'com.x.ParamTest.check[a.b.c]' },
            [pscustomobject]@{ test = 'com.x.Outer$Inner.nested' }) }) }
        $observed = Get-E1SmokeMultiModuleObservation $report
        @($observed.failed_test_classes) | Should -Be @('Outer$Inner', 'ParamTest')
        $observed.failed_count | Should -Be 3
    }

    It 'counts a failure whose class cannot be resolved but names no class for it' {
        $report = [pscustomobject]@{ modules = @([pscustomobject]@{ name = 'm'; test_failures = @([pscustomobject]@{ test = 'justAMethod' }) }) }
        $observed = Get-E1SmokeMultiModuleObservation $report
        $observed.failed_count | Should -Be 1
        @($observed.failed_test_classes).Count | Should -Be 0
    }

    It 'ignores a failure entry without a test name' {
        $report = [pscustomobject]@{ modules = @([pscustomobject]@{ name = 'm'; test_failures = @([pscustomobject]@{ cause = 'x' }, [pscustomobject]@{ test = '' }) }) }
        $observed = Get-E1SmokeMultiModuleObservation $report
        $observed.failed_count | Should -Be 0
        @($observed.failing_modules).Count | Should -Be 0
    }

    It 'gives an empty observation for no report, an empty report or a report without modules, and never throws' {
        foreach ($report in @($null, [pscustomobject]@{}, [pscustomobject]@{ modules = $null }, 'not an object', 42)) {
            { Get-E1SmokeMultiModuleObservation $report } | Should -Not -Throw
            $observed = Get-E1SmokeMultiModuleObservation $report
            @($observed.failing_modules).Count | Should -Be 0
            @($observed.failed_test_classes).Count | Should -Be 0
            $observed.failed_count | Should -Be 0
        }
    }

    It 'sorts both sets ordinally so a receipt is stable' {
        $report = [pscustomobject]@{ modules = @(
            [pscustomobject]@{ name = 'z'; test_failures = @([pscustomobject]@{ test = 'p.ZTest.m' }) },
            [pscustomobject]@{ name = 'a'; test_failures = @([pscustomobject]@{ test = 'p.ATest.m' }) }) }
        $observed = Get-E1SmokeMultiModuleObservation $report
        @($observed.failing_modules) | Should -Be @(':a', ':z')
        @($observed.failed_test_classes) | Should -Be @('ATest', 'ZTest')
    }
}

Describe 'Test-E1SmokeMultiModuleMatches' {
    BeforeEach {
        Set-StrictMode -Version Latest
        $script:Observed = Get-E1SmokeMultiModuleObservation $script:Envelope
    }

    It 'passes when modules, classes and the failing count all equal the ground truth' {
        Test-E1SmokeMultiModuleMatches $script:Observed $script:Expected | Should -BeTrue
    }

    It 'fails when a failing module is missing from the envelope' {
        $observed = [ordered]@{ failing_modules = @(':core:data', ':core:domain'); failed_test_classes = @($script:Observed.failed_test_classes); failed_count = 6 }
        Test-E1SmokeMultiModuleMatches $observed $script:Expected | Should -BeFalse
    }

    It 'fails when the envelope has one failing module too many' {
        $observed = [ordered]@{ failing_modules = @($script:Observed.failing_modules) + ':lint'; failed_test_classes = @($script:Observed.failed_test_classes); failed_count = 6 }
        Test-E1SmokeMultiModuleMatches $observed $script:Expected | Should -BeFalse
    }

    It 'fails when a failing test class differs, and compares class names with exact case' {
        $wrong = [ordered]@{ failing_modules = @($script:Observed.failing_modules); failed_test_classes = @('BookmarksViewModelTest', 'CompositeUserNewsResourceRepositoryTest', 'GetFollowableTopicsUseCaseTest2'); failed_count = 6 }
        Test-E1SmokeMultiModuleMatches $wrong $script:Expected | Should -BeFalse
        $cased = [ordered]@{ failing_modules = @($script:Observed.failing_modules); failed_test_classes = @('bookmarksviewmodeltest', 'CompositeUserNewsResourceRepositoryTest', 'GetFollowableTopicsUseCaseTest'); failed_count = 6 }
        Test-E1SmokeMultiModuleMatches $cased $script:Expected | Should -BeFalse
    }

    It 'fails when the failing test count differs by one in either direction' {
        foreach ($count in @(5, 7, 0)) {
            $observed = [ordered]@{ failing_modules = @($script:Observed.failing_modules); failed_test_classes = @($script:Observed.failed_test_classes); failed_count = $count }
            Test-E1SmokeMultiModuleMatches $observed $script:Expected | Should -BeFalse -Because "count $count"
        }
    }

    It 'does not depend on the order of either set' {
        $observed = [ordered]@{ failing_modules = @(':feature:bookmarks:impl', ':core:data', ':core:domain'); failed_test_classes = @('GetFollowableTopicsUseCaseTest', 'BookmarksViewModelTest', 'CompositeUserNewsResourceRepositoryTest'); failed_count = 6 }
        Test-E1SmokeMultiModuleMatches $observed $script:Expected | Should -BeTrue
    }

    It 'fails an envelope with no failures against a tests_failed ground truth' {
        $observed = Get-E1SmokeMultiModuleObservation ([pscustomobject]@{ modules = @() })
        Test-E1SmokeMultiModuleMatches $observed $script:Expected | Should -BeFalse
    }

    It 'matches an empty observation to a tests_passed ground truth' {
        $passed = [pscustomobject]@{ outcome_kind = 'tests_passed'; failing_modules = @(); failed_test_classes = @(); failed_count = 0 }
        Test-E1SmokeMultiModuleMatches (Get-E1SmokeMultiModuleObservation ([pscustomobject]@{ modules = @() })) $passed | Should -BeTrue
        Test-E1SmokeMultiModuleMatches $script:Observed $passed | Should -BeFalse
    }
}

Describe 'Test-E1SmokePatchPostcondition' {
    BeforeEach { Set-StrictMode -Version Latest }

    It 'accepts exactly one unstaged modification at each expected path, in any order' {
        $paths = @('core/data/A.kt', 'core/domain/B.kt')
        Test-E1SmokePatchPostcondition " M core/domain/B.kt`n M core/data/A.kt`n" $paths | Should -BeTrue
        Test-E1SmokePatchPostcondition " M core/data/A.kt`r`n M core/domain/B.kt`r`n" $paths | Should -BeTrue
    }

    It 'rejects an extra, a missing, a staged, an untracked and a deleted entry, and an empty status' {
        $paths = @('core/data/A.kt', 'core/domain/B.kt')
        Test-E1SmokePatchPostcondition " M core/data/A.kt`n M core/domain/B.kt`n M other.kt`n" $paths | Should -BeFalse
        Test-E1SmokePatchPostcondition " M core/data/A.kt`n" $paths | Should -BeFalse
        Test-E1SmokePatchPostcondition "M  core/data/A.kt`n M core/domain/B.kt`n" $paths | Should -BeFalse
        Test-E1SmokePatchPostcondition " M core/data/A.kt`n?? core/domain/B.kt`n" $paths | Should -BeFalse
        Test-E1SmokePatchPostcondition " M core/data/A.kt`n D core/domain/B.kt`n" $paths | Should -BeFalse
        Test-E1SmokePatchPostcondition '' $paths | Should -BeFalse
    }
}

Describe 'the v2 smoke is unchanged, and the multi-module smoke is a separate branch' {
    It 'keeps the v2 kmp-test command, its 900 s bound and its assertion exactly' {
        $script:SmokeSource | Should -Match "'parallel', '--module-filter', ':core:domain', '--min-missed-lines', '15', '--json', '--project-root', \`$cloneRoot"
        $script:SmokeSource | Should -Match '\[int\]900'
        $script:SmokeSource | Should -Match '\$errorCodes -contains ''coverage_threshold_exceeded'' -and\s+\$testsTotal -eq 1 -and \$testsPassed -eq 1 -and \$missedLines -eq 23 -and \$individualTotal -eq 4'
    }

    It 'runs the multi-module command from the scenario''s smoke arguments with a 3300 s bound' {
        $script:SmokeSource | Should -Match '\[int\]3300'
        $script:SmokeSource | Should -Match 'kmp_test_args'
        $script:SmokeSource | Should -Match "'--project-root', \`$cloneRoot"
    }

    It 'applies the scenario''s patch with git apply in the disposable clone, after the source identity check and before kmp-test' {
        $identityIndex = $script:SmokeSource.IndexOf('$sourceIdentityVerified = (', [StringComparison]::Ordinal)
        $applyIndex = $script:SmokeSource.IndexOf("'apply'", [StringComparison]::Ordinal)
        $runIndex = $script:SmokeSource.IndexOf('$process = & $script:E1InternalBoundedProcess @processParameters', [StringComparison]::Ordinal)
        $applyIndex | Should -BeGreaterThan $identityIndex
        $applyIndex | Should -BeLessThan $runIndex
        $script:SmokeSource | Should -Match 'corpus\\fixtures'
    }

    It 'measures the kmp-test process wall time around the one call that runs it' {
        $script:SmokeSource | Should -Match '\$kmpTestWatch = \[Diagnostics\.Stopwatch\]::StartNew\(\)'
        $script:SmokeSource | Should -Match 'kmp_test_duration_ms = \$kmpTestDurationMs'
        $watchStart = $script:SmokeSource.IndexOf('$kmpTestWatch = [Diagnostics.Stopwatch]::StartNew()', [StringComparison]::Ordinal)
        $run = $script:SmokeSource.IndexOf('$process = & $script:E1InternalBoundedProcess @processParameters', [StringComparison]::Ordinal)
        $watchStart | Should -BeLessThan $run
    }

    It 'adds the observed_* keys to the result only for the multi-module family' {
        $script:SmokeSource | Should -Match "\`$smokeResult\['observed_failing_modules'\]"
        $script:SmokeSource | Should -Match "\`$smokeResult\['observed_failed_count'\]"
    }
}

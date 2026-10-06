# WO-08: evidence1-run.ps1's DryRunPassed state hands the campaign's scenario to the provider-free smoke and
# sizes the bundle call for it. The handler is the real one, lifted out of the script by AST; the guest
# bundle call is replaced by a recorder, the receipts and the "source repository" are real files and a real
# git repository in a temporary directory.
BeforeAll {
    $script:RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    Import-Module (Join-Path $script:RepoRoot 'docs/audits/evidence1-run-state-contract.psm1') -Force -DisableNameChecking
    Import-Module (Join-Path $script:RepoRoot 'docs/audits/evidence1-guest-bundle-contract.psm1') -Force -DisableNameChecking

    $script:RunScriptAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $script:RepoRoot 'evidence1-run.ps1'), [ref]$null, [ref]$null)
    $handler = @($script:RunScriptAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-E1RunDryRunPassedState' }, $true))
    $script:HandlerSource = if ($handler.Count -eq 1) { $handler[0].Extent.Text } else { '' }
    if ($handler.Count -eq 1) { . ([scriptblock]::Create($script:HandlerSource)) }

    $script:GitCommit = $null
    $script:BundleCalls = [Collections.Generic.List[object]]::new()
    $script:BundleResult = $null

    # The two collaborators the handler reaches outside this file for, in the shape evidence1-run.ps1 gives them.
    function script:Get-E1RunRealTransportArguments { return @{} }
    function script:Invoke-E1GuestBundle {
        param($VMName, $GuestCredentialPath, $BundleName, $Arguments, $TimeoutSeconds)
        $script:BundleCalls.Add([pscustomobject]@{ VMName = $VMName; BundleName = $BundleName; Arguments = $Arguments; TimeoutSeconds = $TimeoutSeconds })
        return $script:BundleResult
    }

    # A git repository shaped like the harness source the ToolchainReady receipt points at: package.json,
    # lib, bin, .skills, and the scenario file the handler reads project_commit and family from.
    function script:New-TestSourceRepo([string]$ScenarioId, [string]$Family, [string]$ProjectCommit) {
        $repo = Join-Path $TestDrive ('source-' + [guid]::NewGuid().ToString('N'))
        foreach ($dir in @('lib', 'bin', '.skills', 'tools\agentic-eval\corpus\scenarios')) { New-Item -ItemType Directory -Force -Path (Join-Path $repo $dir) | Out-Null }
        [IO.File]::WriteAllText((Join-Path $repo 'package.json'), '{ "name": "kmp-test-runner", "version": "0.16.0" }')
        [IO.File]::WriteAllText((Join-Path $repo 'lib\a.js'), 'export const a = 1;')
        [IO.File]::WriteAllText((Join-Path $repo 'bin\b.js'), 'export const b = 1;')
        [IO.File]::WriteAllText((Join-Path $repo '.skills\c.md'), '# skill')
        [IO.File]::WriteAllText((Join-Path $repo "tools\agentic-eval\corpus\scenarios\$ScenarioId.json"), (@{ id = $ScenarioId; family = $Family; project_commit = $ProjectCommit } | ConvertTo-Json))
        & git -C $repo init --quiet
        & git -C $repo add .
        & git -C $repo -c user.name=Fixture -c user.email=fixture@example.invalid -c core.hooksPath=NUL commit --quiet -m fixture
        $script:GitCommit = (& git -C $repo rev-parse HEAD).Trim()
        return $repo
    }

    # A campaign directory holding the five PASS receipts DryRunPassed re-verifies, and the context the handler takes.
    function script:New-TestContext([string]$ScenarioId, [string]$Family, [bool]$UseRealBackends = $true) {
        $projectCommit = '7d45eae4f8720a0c77f507712ba2437ff974b6ed'
        $repo = New-TestSourceRepo $ScenarioId $Family $projectCommit
        $campaignId = [guid]::NewGuid().ToString()
        $root = Join-Path $TestDrive ('campaign-' + $campaignId)
        New-Item -ItemType Directory -Force -Path $root | Out-Null
        foreach ($state in @('BrokerReady', 'VmReady', 'ToolchainReady', 'AuthReady', 'RestrictedReady')) {
            $detail = if ($state -ceq 'ToolchainReady') { [ordered]@{ prepare_harness = [ordered]@{ target_commit = $script:GitCommit; source_repo_dir = $repo } } } else { [ordered]@{} }
            Write-E1RunStateReceiptAtomically $root (New-E1RunStateReceipt -CampaignId $campaignId -StateName $state -Verdict 'PASS' -ReasonCode $null -Detail $detail)
        }
        # Receipts are read back as JSON objects, exactly as the real run reads them.
        $context = [pscustomobject]@{
            CampaignRoot = $root; CampaignId = $campaignId; VMName = 'Evidence1-Runner-E2E'; VMId = [guid]::NewGuid().ToString()
            UseRealBackends = $UseRealBackends; GuestCredentialPath = 'C:\kmp-eval\scratch\guest-credential.clixml'
            Manifest = [pscustomobject]@{
                scenario_id = $ScenarioId; private_root = 'C:\Evidence1Private\evidence3-fake-v2'
                harness_dir = 'C:\kmp-eval\agentic-evidence2-harness-checkout-v1'; source_template_dir = 'C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1'
            }
        }
        return [pscustomobject]@{ Context = $context; ProjectCommit = $projectCommit }
    }

    function script:New-TestSmokeOutput([switch]$WithObserved, [string]$Verdict = 'PASS') {
        $output = [ordered]@{ verdict = $Verdict; inference_sessions_consumed = 0; kmp_test_duration_ms = 93000 }
        if ($WithObserved) {
            $output['observed_failing_modules'] = @(':core:data'); $output['observed_failed_test_classes'] = @('FooTest'); $output['observed_failed_count'] = 1
        }
        return [pscustomobject]@{ verdict = 'PASS'; output = [pscustomobject]$output }
    }
}

Describe 'Invoke-E1RunDryRunPassedState hands the scenario to the smoke' {
    BeforeEach {
        $script:BundleCalls.Clear()
        $script:BundleResult = New-TestSmokeOutput
    }

    It 'is found in evidence1-run.ps1' {
        $script:HandlerSource | Should -Not -BeNullOrEmpty
    }

    It 'passes the v2 scenario id and keeps the 1200 s bundle timeout for the coverage scenario' {
        $setup = New-TestContext 'coverage-threshold-failure-v2' 'coverage'
        $receipt = Invoke-E1RunDryRunPassedState $setup.Context
        $receipt.verdict | Should -BeExactly 'PASS'
        $script:BundleCalls.Count | Should -Be 1
        $script:BundleCalls[0].BundleName | Should -BeExactly 'run-agentic-eval-product-smoke'
        $script:BundleCalls[0].Arguments.ScenarioId | Should -BeExactly 'coverage-threshold-failure-v2'
        $script:BundleCalls[0].TimeoutSeconds | Should -Be 1200
    }

    It 'passes the multi-module scenario id and gives the bundle call 3600 s' {
        $script:BundleResult = New-TestSmokeOutput -WithObserved
        $setup = New-TestContext 'multi-module-test-failures' 'multi-module-tests'
        $receipt = Invoke-E1RunDryRunPassedState $setup.Context
        $receipt.verdict | Should -BeExactly 'PASS'
        $script:BundleCalls[0].Arguments.ScenarioId | Should -BeExactly 'multi-module-test-failures'
        $script:BundleCalls[0].TimeoutSeconds | Should -Be 3600
    }

    It 'gives each new milestone family a 3600 s outer smoke timeout' -TestCases @(
        @{ ScenarioId = 'multi-module-line-coverage'; Family = 'multi-module-coverage' }
        @{ ScenarioId = 'changed-dependents-network-topic'; Family = 'changed-dependents' }
        @{ ScenarioId = 'compile-failure-data-repository'; Family = 'compile-failure' }
    ) {
        param($ScenarioId, $Family)
        $setup = New-TestContext $ScenarioId $Family
        $receipt = Invoke-E1RunDryRunPassedState $setup.Context
        $receipt.verdict | Should -BeExactly 'PASS'
        $script:BundleCalls[0].TimeoutSeconds | Should -Be 3600
    }

    It 'hands the bundle arguments its own closed schema accepts, in the schema''s order' {
        $setup = New-TestContext 'multi-module-test-failures' 'multi-module-tests'
        $script:BundleResult = New-TestSmokeOutput -WithObserved
        $null = Invoke-E1RunDryRunPassedState $setup.Context
        $arguments = $script:BundleCalls[0].Arguments
        { Assert-E1GuestBundleArguments 'run-agentic-eval-product-smoke' $arguments } | Should -Not -Throw
        @($arguments.Keys) | Should -Be @((Get-E1GuestBundleRegistry)['run-agentic-eval-product-smoke'].argument_schema.Keys)
    }

    It 'still takes the source commit from the scenario file and the product identity from the ToolchainReady receipt' {
        $setup = New-TestContext 'multi-module-test-failures' 'multi-module-tests'
        $script:BundleResult = New-TestSmokeOutput -WithObserved
        $null = Invoke-E1RunDryRunPassedState $setup.Context
        $arguments = $script:BundleCalls[0].Arguments
        $arguments.ExpectedSourceCommit | Should -BeExactly $setup.ProjectCommit
        $arguments.ExpectedProductCommit | Should -BeExactly $script:GitCommit
        $arguments.ExpectedProductVersion | Should -BeExactly '0.16.0'
        $arguments.HarnessDir | Should -BeExactly $setup.Context.Manifest.harness_dir
        $arguments.SourceTemplateDir | Should -BeExactly $setup.Context.Manifest.source_template_dir
        $arguments.SmokeRoot | Should -BeExactly (Join-Path 'C:\Evidence1Private\evidence3-fake-v2' (Join-Path $setup.Context.CampaignId 'provider-free-product-smoke'))
    }

    It 'carries the smoke output, kmp_test_duration_ms included, in the PASS receipt' {
        $setup = New-TestContext 'coverage-threshold-failure-v2' 'coverage'
        $receipt = Invoke-E1RunDryRunPassedState $setup.Context
        $receipt.detail.provider_free_product_smoke.output.kmp_test_duration_ms | Should -Be 93000
    }

    It 'fails a multi-module smoke that did not report what it observed' {
        $script:BundleResult = New-TestSmokeOutput
        $setup = New-TestContext 'multi-module-test-failures' 'multi-module-tests'
        $receipt = Invoke-E1RunDryRunPassedState $setup.Context
        $receipt.verdict | Should -BeExactly 'FAIL'
        $receipt.reason_code | Should -BeExactly 'dry_run_product_smoke_failed'
    }

    It 'does not ask the coverage smoke for observed values it never reports' {
        $script:BundleResult = New-TestSmokeOutput
        $setup = New-TestContext 'coverage-threshold-failure-v2' 'coverage'
        (Invoke-E1RunDryRunPassedState $setup.Context).verdict | Should -BeExactly 'PASS'
    }

    It 'fails the state when the smoke itself fails, as before' {
        $script:BundleResult = New-TestSmokeOutput -Verdict 'FAIL'
        $setup = New-TestContext 'coverage-threshold-failure-v2' 'coverage'
        $receipt = Invoke-E1RunDryRunPassedState $setup.Context
        $receipt.verdict | Should -BeExactly 'FAIL'
        $receipt.reason_code | Should -BeExactly 'dry_run_product_smoke_failed'
    }

    It 'fails the state when the scenario file is missing, as before' {
        $setup = New-TestContext 'coverage-threshold-failure-v2' 'coverage'
        $setup.Context.Manifest.scenario_id = 'no-such-scenario'
        { Invoke-E1RunDryRunPassedState $setup.Context } | Should -Throw '*dry_run_passed_scenario_missing*'
        $script:BundleCalls.Count | Should -Be 0
    }

    It 'calls no bundle at all in a fully fake run' {
        $setup = New-TestContext 'multi-module-test-failures' 'multi-module-tests' -UseRealBackends $false
        $receipt = Invoke-E1RunDryRunPassedState $setup.Context
        $receipt.verdict | Should -BeExactly 'PASS'
        $script:BundleCalls.Count | Should -Be 0
    }
}

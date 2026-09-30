# P0 #2 (publication hardening, auditor-directed): host-side round_order pre-registration guard.
# Replicates Get-E1RunPreregisteredRoundOrder and Invoke-E1RunLiveAuthorizedState (evidence1-run.ps1,
# lines 752-814) exactly -- same "replicate byte-for-byte with a line-number citation" convention
# Evidence1-Run-Disk-Space-Guards.Tests.ps1 already established. evidence1-run.ps1 is a top-level
# script, not an importable module, so there is nothing to Import-Module for the logic itself.
#
# (auditor review, second round) Indexes by campaign_cell_indices into the design's own full
# pre-registered plan rather than inferring a repeat count -- expected[i] =
# label(fullPlan.cells.find(c => c.order_index === campaign_cell_indices[i]).condition). Any valid
# index subset works the same way, not just "1 rep or the full count"; a missing index fails closed.
BeforeAll {
    function script:Invoke-TestE1RunLiveAuthorizedState($Manifest, [scriptblock]$GetExpectedCells, [scriptblock]$GetPreregisteredRoundOrder) {
        # evidence1-run.ps1:762-814
        $expectedCells = @(& $GetExpectedCells $Manifest)
        $budgetOk = [bool]$Manifest.no_automatic_provider_retry -and ([int]$Manifest.max_session_count -eq $expectedCells.Count)

        $declaredRoundOrder = @($Manifest.round_order)
        $roundOrderOk = $true
        $roundOrderDetail = @()
        foreach ($runtime in @($Manifest.runtimes)) {
            $cellIndices = @($runtime.campaign_cell_indices)
            $entry = [ordered]@{ runtime_id = [string]$runtime.runtime_id; campaign_design_id = [string]$runtime.campaign_design_id; campaign_cell_indices = $cellIndices }
            try {
                $preregistered = @(& $GetPreregisteredRoundOrder ([string]$runtime.campaign_design_id) $cellIndices ([string]$Manifest.execution_profile_id) 'C:\fake-repo-root')
            } catch {
                $roundOrderOk = $false
                $entry['matched'] = $false
                $entry['error'] = [string]$_.Exception.Message
                $roundOrderDetail += $entry
                continue
            }
            $matches = ($preregistered.Count -eq $declaredRoundOrder.Count)
            if ($matches) {
                for ($i = 0; $i -lt $preregistered.Count; $i++) {
                    if ([string]$preregistered[$i] -cne [string]$declaredRoundOrder[$i]) { $matches = $false; break }
                }
            }
            if (-not $matches) { $roundOrderOk = $false }
            $entry['matched'] = $matches
            $entry['preregistered_round_order'] = $preregistered
            $roundOrderDetail += $entry
        }

        $ok = $budgetOk -and $roundOrderOk
        $verdict = if ($ok) { 'PASS' } else { 'FAIL' }
        $reasonCode = if ($ok) { $null }
            elseif (-not $budgetOk) { 'live_authorized_budget_or_retry_statement_invalid' }
            else { 'run_manifest_round_order_not_preregistered' }
        [ordered]@{ verdict = $verdict; reason_code = $reasonCode; round_order_verification = $roundOrderDetail }
    }

    # A minimal two-runtime manifest shape matching real campaign 48458826's own fields. The
    # FULL 8-cell pre-registered order (buildScenarioCampaignPlan, repeats:4, verified live this
    # session by direct execution) is the single source every per-index expectation below is
    # sliced from by hand, so each test's own expected value is traceable to that one real
    # derivation rather than independently asserted.
    function script:New-TestManifest([string[]]$RoundOrder, [int[]]$CellIndices) {
        [ordered]@{
            conditions = @('product', 'free')
            round_order = $RoundOrder
            execution_profile_id = 'sandboxed-unrestricted-v1'
            no_automatic_provider_retry = $true
            max_session_count = $RoundOrder.Count
            runtimes = @(
                [ordered]@{ runtime_id = 'claude-code'; campaign_design_id = 'claude-product-vs-free-baseline-v1'; campaign_cell_indices = $CellIndices }
                [ordered]@{ runtime_id = 'codex-cli'; campaign_design_id = 'codex-product-vs-free-baseline-v2'; campaign_cell_indices = $CellIndices }
            )
        }
    }

    # order_index: 0=product 1=free 2=free 3=product 4=free 5=product 6=product 7=free
    $script:FullPreregisteredOrder = @('product', 'free', 'free', 'product', 'free', 'product', 'product', 'free')
    $script:GetRealPreregistered = {
        param($designId, $cellIndices, $profile, $root)
        @($cellIndices | ForEach-Object { $script:FullPreregisteredOrder[$_] })
    }
}

Describe 'Invoke-E1RunLiveAuthorizedState round_order pre-registration guard' {
    It 'indices [0,1] (a canary) PASS against [product, free]' {
        $manifest = New-TestManifest -RoundOrder @('product', 'free') -CellIndices @(0, 1)
        $result = Invoke-TestE1RunLiveAuthorizedState -Manifest $manifest -GetExpectedCells { param($m) 1..2 } -GetPreregisteredRoundOrder $script:GetRealPreregistered
        $result.verdict | Should -BeExactly 'PASS'
    }

    It 'indices [2,3] PASS against [free, product] -- a non-first, non-canary subset indexes correctly' {
        $manifest = New-TestManifest -RoundOrder @('free', 'product') -CellIndices @(2, 3)
        $result = Invoke-TestE1RunLiveAuthorizedState -Manifest $manifest -GetExpectedCells { param($m) 1..2 } -GetPreregisteredRoundOrder $script:GetRealPreregistered
        $result.verdict | Should -BeExactly 'PASS'
    }

    It 'the full [0..7] PASSes against the complete pre-registered 8-cell campaign order' {
        $manifest = New-TestManifest -RoundOrder $script:FullPreregisteredOrder -CellIndices @(0, 1, 2, 3, 4, 5, 6, 7)
        $result = Invoke-TestE1RunLiveAuthorizedState -Manifest $manifest -GetExpectedCells { param($m) 1..8 } -GetPreregisteredRoundOrder $script:GetRealPreregistered
        $result.verdict | Should -BeExactly 'PASS'
    }

    It 'a missing index FAILs closed via the thrown-error path, never silently PASSing or skipping it' {
        $manifest = New-TestManifest -RoundOrder @('product', 'free') -CellIndices @(0, 99)
        $getPreregistered = {
            param($designId, $cellIndices, $profile, $root)
            if (99 -in $cellIndices) { throw 'run_manifest_round_order_derivation_failed: derive_round_order_cell_index_not_in_plan: 99' }
            @($cellIndices | ForEach-Object { $script:FullPreregisteredOrder[$_] })
        }
        $result = Invoke-TestE1RunLiveAuthorizedState -Manifest $manifest -GetExpectedCells { param($m) 1..2 } -GetPreregisteredRoundOrder $getPreregistered
        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -BeExactly 'run_manifest_round_order_not_preregistered'
        $result.round_order_verification[0].error | Should -Match 'derive_round_order_cell_index_not_in_plan: 99'
    }

    It '(RED-proof-in-spirit) FAILs with run_manifest_round_order_not_preregistered on a hand-invented ABAB sequence -- the exact mistake this session made once and the auditor caught' {
        $invented = @('product', 'free', 'product', 'free', 'product', 'free', 'product', 'free')
        $manifest = New-TestManifest -RoundOrder $invented -CellIndices @(0, 1, 2, 3, 4, 5, 6, 7)
        $result = Invoke-TestE1RunLiveAuthorizedState -Manifest $manifest -GetExpectedCells { param($m) 1..8 } -GetPreregisteredRoundOrder $script:GetRealPreregistered
        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -BeExactly 'run_manifest_round_order_not_preregistered'
        $result.round_order_verification[0].matched | Should -BeFalse
    }

    It 'FAILs when only ONE runtime disagrees with its own pre-registered order, even if the other matches' {
        $manifest = New-TestManifest -RoundOrder $script:FullPreregisteredOrder -CellIndices @(0, 1, 2, 3, 4, 5, 6, 7)
        $getPreregistered = {
            param($designId, $cellIndices, $profile, $root)
            if ($designId -ceq 'codex-product-vs-free-baseline-v2') { return @('free', 'product', 'product', 'free', 'product', 'free', 'free', 'product') }
            return @($cellIndices | ForEach-Object { $script:FullPreregisteredOrder[$_] })
        }
        $result = Invoke-TestE1RunLiveAuthorizedState -Manifest $manifest -GetExpectedCells { param($m) 1..8 } -GetPreregisteredRoundOrder $getPreregistered
        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -BeExactly 'run_manifest_round_order_not_preregistered'
        ($result.round_order_verification | Where-Object { $_.runtime_id -eq 'claude-code' }).matched | Should -BeTrue
        ($result.round_order_verification | Where-Object { $_.runtime_id -eq 'codex-cli' }).matched | Should -BeFalse
    }

    It 'still reports the budget/retry reason first when both the budget and round_order are invalid' {
        $manifest = New-TestManifest -RoundOrder @('product', 'free', 'product', 'free', 'product', 'free', 'product', 'free') -CellIndices @(0, 1, 2, 3, 4, 5, 6, 7)
        $manifest.no_automatic_provider_retry = $false
        $result = Invoke-TestE1RunLiveAuthorizedState -Manifest $manifest -GetExpectedCells { param($m) 1..8 } -GetPreregisteredRoundOrder $script:GetRealPreregistered
        $result.reason_code | Should -BeExactly 'live_authorized_budget_or_retry_statement_invalid'
    }
}

# Real subprocess wiring: proves Get-E1RunPreregisteredRoundOrder's own node.exe invocation (not
# just the logic around it) genuinely reaches derive-round-order-cli.mjs and gets back the real,
# live-verified campaign round_order -- the replica above injects this away entirely, so this is
# the one test that would catch a broken path, a missing node.exe, or a CLI contract drift.
Describe 'Get-E1RunPreregisteredRoundOrder real subprocess' {
    BeforeAll {
        $script:RunScriptSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\evidence1-run.ps1') -Raw
        $start = $script:RunScriptSource.IndexOf('function Get-E1RunPreregisteredRoundOrder')
        if ($start -lt 0) { throw 'Get-E1RunPreregisteredRoundOrder not found -- P0 #2 fix not applied' }
        $end = $script:RunScriptSource.IndexOf("`n}`n", $start)
        Invoke-Expression ($script:RunScriptSource.Substring($start, $end - $start + 2))
    }

    It 'derives [product, free] for indices [0,1] -- the real canary shape' {
        $result = Get-E1RunPreregisteredRoundOrder -DesignId 'claude-product-vs-free-baseline-v1' -CampaignCellIndices @(0, 1) -ExecutionProfileId 'sandboxed-unrestricted-v1' -SourceRepoDir (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
        $result | Should -Be @('product', 'free')
    }

    It 'derives [free, product] for indices [2,3]' {
        $result = Get-E1RunPreregisteredRoundOrder -DesignId 'claude-product-vs-free-baseline-v1' -CampaignCellIndices @(2, 3) -ExecutionProfileId 'sandboxed-unrestricted-v1' -SourceRepoDir (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
        $result | Should -Be @('free', 'product')
    }

    It 'derives the real, verified full 8-cell campaign round_order for indices [0..7]' {
        $result = Get-E1RunPreregisteredRoundOrder -DesignId 'claude-product-vs-free-baseline-v1' -CampaignCellIndices @(0, 1, 2, 3, 4, 5, 6, 7) -ExecutionProfileId 'sandboxed-unrestricted-v1' -SourceRepoDir (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
        $result | Should -Be @('product', 'free', 'free', 'product', 'free', 'product', 'product', 'free')
    }

    It 'throws run_manifest_round_order_derivation_failed with the missing index named, for an index the real plan does not contain' {
        { Get-E1RunPreregisteredRoundOrder -DesignId 'claude-product-vs-free-baseline-v1' -CampaignCellIndices @(0, 99) -ExecutionProfileId 'sandboxed-unrestricted-v1' -SourceRepoDir (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path } |
            Should -Throw '*derive_round_order_cell_index_not_in_plan: 99*'
    }

    It 'throws run_manifest_round_order_derivation_failed for an unknown design id, never silently returning an empty order' {
        { Get-E1RunPreregisteredRoundOrder -DesignId 'not-a-real-design' -CampaignCellIndices @(0, 1) -ExecutionProfileId 'sandboxed-unrestricted-v1' -SourceRepoDir (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path } |
            Should -Throw '*run_manifest_round_order_derivation_failed*'
    }
}

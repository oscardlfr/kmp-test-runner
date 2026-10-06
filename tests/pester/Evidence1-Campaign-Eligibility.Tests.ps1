BeforeAll {
  Import-Module (Join-Path $PSScriptRoot '../../docs/audits/evidence1-campaign-eligibility.psm1') -Force

  function New-E1EligibilityRuntimeCells([string]$Root, [string]$RuntimeId, [string[]]$Order = @('product','free','free','product'), [int]$StartIndex = 0) {
    $cells = @()
    for ($index = 0; $index -lt $Order.Count; $index++) {
      $globalIndex = $StartIndex + $index
      $condition = if ($Order[$index] -ceq 'product') { 'current-skill' } else { 'no-skill' }
      $access = if ($condition -ceq 'current-skill') { 'product-assisted' } else { 'free-baseline-no-product' }
      $cell = [ordered]@{ runtime_id=$RuntimeId; model_id='model-under-test'; campaign_design_id='codex-product-vs-free-baseline-v2'; campaign_cell_index=$globalIndex; round_index=$index; condition=$Order[$index] }
      $cells += $cell
      $dir = Join-Path $Root "$RuntimeId-$globalIndex"
      New-Item -ItemType Directory -Path $dir | Out-Null
      $audit = [ordered]@{ schema=10; run_schema=8; run_id="run-$RuntimeId-$globalIndex"; run_kind='scenario'; condition=$condition; scenario_id='scenario-under-test' }
      $auditPath = Join-Path $dir 'audit.json'
      $audit | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $auditPath -Encoding utf8
      $auditSha = (Get-FileHash -LiteralPath $auditPath -Algorithm SHA256).Hash.ToLowerInvariant()
      $record = [ordered]@{
        schema=8; run_id="run-$RuntimeId-$globalIndex"; run_kind='scenario'; condition=$condition; scenario_id='scenario-under-test'; seed=42
        order_index=$globalIndex; repetition_index=[math]::Floor($globalIndex / 2); product_access_mode=$access
        agent_runtime=[ordered]@{ runtime_id=$RuntimeId; model_requested='model-under-test'; model_resolved='model-under-test' }
        grading_checks=[ordered]@{ value=@([ordered]@{ name='graded'; passed=$false; detail='negative outcome remains valid'; evidence_event_indices=@() }); reason=$null }
        success=[ordered]@{ value=$false; reason=$null }
        expected_outcome_matched=[ordered]@{ value=$false; reason=$null }
        benchmark_eligible=$false
        accepted_audit=[ordered]@{ schema=10; relative_path="audit/run-$RuntimeId-$globalIndex.json"; sha256=$auditSha }
      }
      $record | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $dir 'record.json') -Encoding utf8
    }
    return $cells
  }

  function New-E1EligibilityFixture([string[]]$Order = @('product','free','free','product'), [int]$StartIndex = 0) {
    $root = Join-Path $TestDrive ([guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $root | Out-Null
    $cells = New-E1EligibilityRuntimeCells -Root $root -RuntimeId 'codex-cli' -Order $Order -StartIndex $StartIndex
    return [ordered]@{ Root=$root; Cells=$cells }
  }

  # H20: a second, independent runtime group sharing the same evidence root -- proves one
  # runtime's rejection cannot cross into the other's promotion decision.
  function New-E1EligibilityTwoRuntimeFixture {
    $root = Join-Path $TestDrive ([guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $root | Out-Null
    $claudeCells = New-E1EligibilityRuntimeCells -Root $root -RuntimeId 'claude-code'
    $codexCells = New-E1EligibilityRuntimeCells -Root $root -RuntimeId 'codex-cli'
    return [ordered]@{ Root=$root; Cells=@($claudeCells + $codexCells) }
  }

  # Reproduces a real rejected cell's on-disk shape: no record.json/audit.json pair at all (a
  # genuine rejection produces rejection.json instead, which this function never reads). The
  # caller is expected to pass this cell's key via -RejectedCellKeys, matching how
  # evidence1-run.ps1's own live-session loop already knows which cells were rejected.
  function ConvertTo-E1EligibilityRejectedCell([string]$Root, [string]$CellKey) {
    $dir = Join-Path $Root $CellKey
    Remove-Item -LiteralPath (Join-Path $dir 'record.json') -Force
    Remove-Item -LiteralPath (Join-Path $dir 'audit.json') -Force
    '{"schema":1,"rejection_id":"00000000-0000-0000-0000-000000000000"}' | Set-Content -LiteralPath (Join-Path $dir 'rejection.json') -Encoding utf8
  }

  function Get-E1EligibilityRuntimeResult($Result, [string]$RuntimeId) {
    return @($Result.runtimes | Where-Object { $_.runtime_id -ceq $RuntimeId })[0]
  }
}

Describe 'Invoke-E1CampaignEligibilityFinalization' {
  It 'promotes a complete balanced campaign even when every semantic outcome is false' {
    $fixture = New-E1EligibilityFixture
    $result = Invoke-E1CampaignEligibilityFinalization -PrivateEvidenceRoot $fixture.Root -ExpectedCells $fixture.Cells -ScenarioId 'scenario-under-test' -Seed 42 -ProviderMode 'live'
    $result.verdict | Should -BeExactly 'PASS'
    $result.eligible | Should -BeTrue
    $result.promoted_count | Should -Be 4
    (Get-E1EligibilityRuntimeResult $result 'codex-cli').eligible | Should -BeTrue
    (Get-E1EligibilityRuntimeResult $result 'codex-cli').promoted_count | Should -Be 4
    foreach ($index in 0..3) {
      $record = Get-Content -LiteralPath (Join-Path $fixture.Root "codex-cli-$index/record.json") -Raw | ConvertFrom-Json
      $record.benchmark_eligible | Should -BeTrue
      $record.success.value | Should -BeFalse
    }
  }

  It 'promotes a balanced non-initial block while keeping global campaign indices' {
    $fixture = New-E1EligibilityFixture -Order @('free','product','product','free') -StartIndex 4
    $result = Invoke-E1CampaignEligibilityFinalization -PrivateEvidenceRoot $fixture.Root -ExpectedCells $fixture.Cells -ScenarioId 'scenario-under-test' -Seed 42 -ProviderMode 'live'
    $result.verdict | Should -BeExactly 'PASS'
    $result.promoted_count | Should -Be 4
    foreach ($index in 4..7) {
      $record = Get-Content -LiteralPath (Join-Path $fixture.Root "codex-cli-$index/record.json") -Raw | ConvertFrom-Json
      $record.order_index | Should -Be $index
      $record.benchmark_eligible | Should -BeTrue
    }
  }

  # H20 (was 'rejects an unbalanced campaign without mutating any record', asserting Should -Throw):
  # adapted on purpose -- finalization is now scoped per runtime, so a single-runtime campaign's own
  # imbalance excludes that runtime (via the returned result) rather than throwing to the caller. The
  # no-mutation guarantee this test exists to prove is unchanged. Top-level PASS requires EVERY
  # runtime to promote, so a single-runtime campaign's own exclusion is also a top-level FAIL.
  It 'excludes only the unbalanced runtime, promoting nothing for it, without mutating its records' {
    $fixture = New-E1EligibilityFixture -Order @('product','free','product')
    $result = Invoke-E1CampaignEligibilityFinalization -PrivateEvidenceRoot $fixture.Root -ExpectedCells $fixture.Cells -ScenarioId 'scenario-under-test' -Seed 42 -ProviderMode 'live'
    (Get-E1EligibilityRuntimeResult $result 'codex-cli').eligible | Should -BeFalse
    (Get-E1EligibilityRuntimeResult $result 'codex-cli').reason_code | Should -BeExactly 'campaign_eligibility_order_unbalanced'
    $result.promoted_count | Should -Be 0
    $result.verdict | Should -BeExactly 'FAIL'
    $result.reason_code | Should -BeExactly 'runtime_ineligible'
    foreach ($index in 0..2) {
      (Get-Content -LiteralPath (Join-Path $fixture.Root "codex-cli-$index/record.json") -Raw | ConvertFrom-Json).benchmark_eligible | Should -BeFalse
    }
  }

  # H20 (was 'rejects a missing record/audit pair without mutating the remaining records', Should -Throw)
  # -- this is still a genuine anomaly (missing pair, NOT in -RejectedCellKeys), so it still surfaces
  # as a real validation failure excluding the runtime, not the new runtime_has_rejected_cells reason.
  It 'excludes only the runtime with a missing record/audit pair (and no matching rejection) it never mutates its remaining records' {
    $fixture = New-E1EligibilityFixture
    Remove-Item -LiteralPath (Join-Path $fixture.Root 'codex-cli-3/audit.json')
    $result = Invoke-E1CampaignEligibilityFinalization -PrivateEvidenceRoot $fixture.Root -ExpectedCells $fixture.Cells -ScenarioId 'scenario-under-test' -Seed 42 -ProviderMode 'live'
    (Get-E1EligibilityRuntimeResult $result 'codex-cli').reason_code | Should -BeExactly 'campaign_eligibility_pair_incomplete'
    $result.promoted_count | Should -Be 0
    foreach ($index in 0..2) {
      (Get-Content -LiteralPath (Join-Path $fixture.Root "codex-cli-$index/record.json") -Raw | ConvertFrom-Json).benchmark_eligible | Should -BeFalse
    }
  }

  # H20 (was 'rejects an audit digest mismatch without mutating records', Should -Throw)
  It 'excludes only the runtime with an audit digest mismatch, without mutating records' {
    $fixture = New-E1EligibilityFixture
    Add-Content -LiteralPath (Join-Path $fixture.Root 'codex-cli-1/audit.json') -Value ' '
    $result = Invoke-E1CampaignEligibilityFinalization -PrivateEvidenceRoot $fixture.Root -ExpectedCells $fixture.Cells -ScenarioId 'scenario-under-test' -Seed 42 -ProviderMode 'live'
    (Get-E1EligibilityRuntimeResult $result 'codex-cli').reason_code | Should -BeExactly 'campaign_eligibility_audit_digest_mismatch'
    (Get-Content -LiteralPath (Join-Path $fixture.Root 'codex-cli-0/record.json') -Raw | ConvertFrom-Json).benchmark_eligible | Should -BeFalse
  }

  # Preserved as a hard throw on purpose: a missing evidence root is a campaign-wide precondition,
  # not a single runtime's problem -- there is nothing to scope the failure to.
  It 'still throws for a genuinely missing private evidence root (a precondition, not a per-runtime concern)' {
    $cells = @([ordered]@{ runtime_id='codex-cli'; round_index=0 }, [ordered]@{ runtime_id='codex-cli'; round_index=1 })
    { Invoke-E1CampaignEligibilityFinalization -PrivateEvidenceRoot (Join-Path $TestDrive 'does-not-exist') -ExpectedCells $cells -ScenarioId 's' -Seed 1 -ProviderMode 'live' } |
      Should -Throw '*campaign_eligibility_private_root_missing*'
  }

  # H21: fake/dry-run campaigns (1b15e760's rehearsal was the real incident) must never promote,
  # however clean their evidence looks. Points PrivateEvidenceRoot at a directory that was never
  # created, proving the check runs before any filesystem access.
  It 'a non-live provider_mode promotes nothing, without reading the evidence directory at all' {
    $cells = @([ordered]@{ runtime_id='codex-cli'; round_index=0 })
    $result = Invoke-E1CampaignEligibilityFinalization -PrivateEvidenceRoot (Join-Path $TestDrive 'never-created') -ExpectedCells $cells -ScenarioId 'scenario-under-test' -Seed 42 -ProviderMode 'fake'
    $result.verdict | Should -BeExactly 'FAIL'
    $result.eligible | Should -BeFalse
    $result.promoted_count | Should -Be 0
    $result.reason_code | Should -BeExactly 'campaign_not_live'
    $result.runtimes | Should -BeNullOrEmpty
  }

  # H21 / no-default-for-weak-mechanism: an omitted -ProviderMode must be a hard parameter error,
  # never silently treated as 'live'.
  It 'a call omitting -ProviderMode fails with a parameter error, not a silent live default' {
    $cells = @([ordered]@{ runtime_id='codex-cli'; round_index=0 })
    { Invoke-E1CampaignEligibilityFinalization -PrivateEvidenceRoot (Join-Path $TestDrive 'never-created-2') -ExpectedCells $cells -ScenarioId 'scenario-under-test' -Seed 42 } |
      Should -Throw
  }

  # H20: the plan's own named case -- "rechazo en Codex -> Claude promovido y Codex no" -- using a
  # GENUINELY rejected cell (RejectedCellKeys), not a validation failure.
  It 'a rejected cell isolated to one runtime (Codex) excludes only that runtime; the other runtime (Claude) still promotes fully' {
    $fixture = New-E1EligibilityTwoRuntimeFixture
    ConvertTo-E1EligibilityRejectedCell -Root $fixture.Root -CellKey 'codex-cli-2'
    $result = Invoke-E1CampaignEligibilityFinalization -PrivateEvidenceRoot $fixture.Root -ExpectedCells $fixture.Cells -ScenarioId 'scenario-under-test' -Seed 42 -ProviderMode 'live' -RejectedCellKeys @('codex-cli-2')
    (Get-E1EligibilityRuntimeResult $result 'codex-cli').eligible | Should -BeFalse
    (Get-E1EligibilityRuntimeResult $result 'codex-cli').reason_code | Should -BeExactly 'runtime_has_rejected_cells'
    (Get-E1EligibilityRuntimeResult $result 'claude-code').eligible | Should -BeTrue
    (Get-E1EligibilityRuntimeResult $result 'claude-code').promoted_count | Should -Be 4
    $result.promoted_count | Should -Be 4
    $result.verdict | Should -BeExactly 'FAIL'
    $result.reason_code | Should -BeExactly 'runtime_ineligible'
    foreach ($index in 0..3) {
      (Get-Content -LiteralPath (Join-Path $fixture.Root "claude-code-$index/record.json") -Raw | ConvertFrom-Json).benchmark_eligible | Should -BeTrue
    }
    (Get-Content -LiteralPath (Join-Path $fixture.Root 'codex-cli-0/record.json') -Raw | ConvertFrom-Json).benchmark_eligible | Should -BeFalse
  }

  # H20: the plan's own named case -- "sin rechazos -> ambos promovidos".
  It 'no rejected cells in either runtime promotes both fully, and the campaign is eligible overall' {
    $fixture = New-E1EligibilityTwoRuntimeFixture
    $result = Invoke-E1CampaignEligibilityFinalization -PrivateEvidenceRoot $fixture.Root -ExpectedCells $fixture.Cells -ScenarioId 'scenario-under-test' -Seed 42 -ProviderMode 'live'
    $result.verdict | Should -BeExactly 'PASS'
    $result.eligible | Should -BeTrue
    (Get-E1EligibilityRuntimeResult $result 'codex-cli').eligible | Should -BeTrue
    (Get-E1EligibilityRuntimeResult $result 'claude-code').eligible | Should -BeTrue
    $result.promoted_count | Should -Be 8
  }
}

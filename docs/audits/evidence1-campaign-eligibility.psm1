Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-E1CampaignEligibilityBalance([object[]]$ExpectedCells) {
  foreach ($group in @($ExpectedCells | Group-Object { [string]$_.runtime_id })) {
    $cells = @($group.Group)
    $productCount = @($cells | Where-Object { [string]$_.condition -ceq 'product' }).Count
    $freeCount = @($cells | Where-Object { [string]$_.condition -ceq 'free' }).Count
    if ($productCount -lt 1 -or $productCount -ne $freeCount) {
      throw 'campaign_eligibility_order_unbalanced'
    }
    $indices = @($cells | ForEach-Object { [int]$_.campaign_cell_index } | Sort-Object)
    $expectedIndices = @(0..($cells.Count - 1))
    if (@(Compare-Object $indices $expectedIndices).Count -ne 0) {
      throw 'campaign_eligibility_cell_indices_invalid'
    }
  }
}

function Invoke-E1CampaignEligibilityFinalization {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$PrivateEvidenceRoot,
    [Parameter(Mandatory)][object[]]$ExpectedCells,
    [Parameter(Mandatory)][string]$ScenarioId,
    [Parameter(Mandatory)][int64]$Seed,
    # No default. An omitted flag is NOT "assume the weak mechanism" -- same principle
    # cell-integrity.mjs already applies. A default of 'live' would fail OPEN exactly where this
    # check exists to fail closed: a fake campaign promoted because a caller forgot to pass the mode.
    [Parameter(Mandatory)][string]$ProviderMode,
    # Cell keys ("<runtime_id>-<round_index>") the CALLER already knows were rejected at
    # integrity time, from its own live-session loop -- never inferred here from what the
    # filesystem happens to contain (a rejected cell's directory holds rejection.json, not a
    # record/audit pair, and this function has no way to tell "legitimately rejected" apart from
    # "genuinely broken" by directory contents alone).
    [string[]]$RejectedCellKeys = @()
  )

  $cellCount = $ExpectedCells.Count

  # A non-live manifest (fake rehearsal, dry-run gate) must never promote its records as
  # benchmark-eligible, however clean its evidence looks. Checked first, before touching the
  # filesystem at all -- a fake/dry-run campaign's evidence directory may not even exist yet.
  if ($ProviderMode -cne 'live') {
    return [ordered]@{
      verdict = 'FAIL'; reason_code = 'campaign_not_live'
      eligible = $false; promoted_count = 0; cell_count = $cellCount; runtimes = @()
    }
  }

  if (-not (Test-Path -LiteralPath $PrivateEvidenceRoot -PathType Container)) {
    throw 'campaign_eligibility_private_root_missing'
  }
  if ($cellCount -lt 2) { throw 'campaign_eligibility_cell_set_incomplete' }

  $expectedKeys = @($ExpectedCells | ForEach-Object { "$([string]$_.runtime_id)-$([int]$_.round_index)" } | Sort-Object)
  if (@($expectedKeys | Select-Object -Unique).Count -ne $expectedKeys.Count) {
    throw 'campaign_eligibility_cell_key_duplicate'
  }
  $actualKeys = @(Get-ChildItem -LiteralPath $PrivateEvidenceRoot -Directory | ForEach-Object Name | Sort-Object)
  if (@(Compare-Object $expectedKeys $actualKeys).Count -ne 0) {
    throw 'campaign_eligibility_evidence_set_mismatch'
  }

  # Finalize PER RUNTIME from here on -- one runtime's rejection (an imbalanced design, or
  # any single one of its own cells failing validation) must never block a DIFFERENT runtime's
  # otherwise-complete, balanced cells from being promoted. The two runtimes' evidence
  # directories are already disjoint by construction ($expectedKeys is
  # "<runtime_id>-<round_index>"), so nothing here crosses that boundary.
  $runtimeResults = @()
  $preparedAll = @()
  foreach ($group in @($ExpectedCells | Group-Object { [string]$_.runtime_id })) {
    $runtimeId = [string]$group.Name
    $runtimeCells = @($group.Group)
    $runtimeCellKeys = @($runtimeCells | ForEach-Object { "$([string]$_.runtime_id)-$([int]$_.round_index)" })
    # Any one of this runtime's OWN cells already known-rejected excludes the whole runtime,
    # without attempting to validate its other cells as record/audit pairs -- a rejected cell's
    # directory legitimately holds rejection.json, not the pair this loop otherwise expects, so
    # trying to validate it here would misreport a real rejection as campaign_eligibility_pair_incomplete.
    $ownRejectedKeys = @($runtimeCellKeys | Where-Object { $RejectedCellKeys -ccontains $_ })
    if ($ownRejectedKeys.Count -gt 0) {
      $runtimeResults += [ordered]@{ runtime_id = $runtimeId; eligible = $false; promoted_count = 0; reason_code = 'runtime_has_rejected_cells' }
      continue
    }
    try {
      Assert-E1CampaignEligibilityBalance $runtimeCells

      $prepared = @()
      foreach ($cell in $runtimeCells) {
        $cellKey = "$([string]$cell.runtime_id)-$([int]$cell.round_index)"
        $cellRoot = Join-Path $PrivateEvidenceRoot $cellKey
        $entries = @(Get-ChildItem -LiteralPath $cellRoot -Force)
        $entryNames = @($entries | ForEach-Object Name | Sort-Object)
        if ($entries.Count -ne 2 -or @(Compare-Object $entryNames @('audit.json','record.json')).Count -ne 0) {
          throw 'campaign_eligibility_pair_incomplete'
        }

        $recordPath = Join-Path $cellRoot 'record.json'
        $auditPath = Join-Path $cellRoot 'audit.json'
        try {
          $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json -ErrorAction Stop
          $audit = Get-Content -LiteralPath $auditPath -Raw | ConvertFrom-Json -ErrorAction Stop
        } catch {
          throw 'campaign_eligibility_pair_json_invalid'
        }

        $expectedCondition = if ([string]$cell.condition -ceq 'product') { 'current-skill' } else { 'no-skill' }
        $expectedAccessMode = if ($expectedCondition -ceq 'current-skill') { 'product-assisted' } else { 'free-baseline-no-product' }
        if ([string]$record.agent_runtime.runtime_id -cne [string]$cell.runtime_id -or
            [string]$record.agent_runtime.model_requested -cne [string]$cell.model_id -or
            [string]$record.scenario_id -cne $ScenarioId -or [int64]$record.seed -ne $Seed -or
            [int]$record.order_index -ne [int]$cell.campaign_cell_index -or
            [int]$record.repetition_index -ne [math]::Floor(([int]$cell.campaign_cell_index) / 2) -or
            [string]$record.condition -cne $expectedCondition -or
            [string]$record.product_access_mode -cne $expectedAccessMode) {
          throw 'campaign_eligibility_record_identity_mismatch'
        }
        if ($null -eq $record.grading_checks.value -or
            $record.success.value -isnot [bool] -or
            $record.expected_outcome_matched.value -isnot [bool]) {
          throw 'campaign_eligibility_grading_incomplete'
        }
        if ($record.benchmark_eligible -isnot [bool]) {
          throw 'campaign_eligibility_flag_invalid'
        }
        if ([string]$audit.run_id -cne [string]$record.run_id -or
            [int]$audit.schema -ne [int]$record.accepted_audit.schema -or
            [int]$audit.run_schema -ne [int]$record.schema -or
            [string]$audit.condition -cne [string]$record.condition -or
            [string]$audit.scenario_id -cne [string]$record.scenario_id) {
          throw 'campaign_eligibility_audit_identity_mismatch'
        }
        $auditSha = (Get-FileHash -LiteralPath $auditPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($auditSha -cne [string]$record.accepted_audit.sha256) {
          throw 'campaign_eligibility_audit_digest_mismatch'
        }

        $originalBytes = [IO.File]::ReadAllBytes($recordPath)
        $record.benchmark_eligible = $true
        $prepared += [ordered]@{ Path=$recordPath; OriginalBytes=$originalBytes; Json=($record | ConvertTo-Json -Depth 100) }
      }

      $runtimeResults += [ordered]@{ runtime_id = $runtimeId; eligible = $true; promoted_count = $prepared.Count; reason_code = $null }
      $preparedAll += $prepared
    } catch {
      # A failure anywhere in this runtime's own balance/pair/identity/digest checks excludes
      # only this runtime -- $prepared (this runtime's own staged records) is discarded here and
      # never reaches $preparedAll, so none of its records are mutated, exactly like the
      # pre-existing all-or-nothing guarantee, just scoped to this runtime instead of the campaign.
      $runtimeResults += [ordered]@{ runtime_id = $runtimeId; eligible = $false; promoted_count = 0; reason_code = [string]$_.Exception.Message }
    }
  }

  $encoding = [Text.UTF8Encoding]::new($false)
  $staged = @()
  try {
    foreach ($item in $preparedAll) {
      $temporaryPath = "$($item.Path).e1-finalize-$([guid]::NewGuid().ToString('N')).tmp"
      [IO.File]::WriteAllText($temporaryPath, "$($item.Json)`n", $encoding)
      $staged += [ordered]@{ TemporaryPath=$temporaryPath; DestinationPath=$item.Path }
    }
    foreach ($item in $staged) {
      Move-Item -LiteralPath $item.TemporaryPath -Destination $item.DestinationPath -Force
    }
  } catch {
    foreach ($item in $preparedAll) { [IO.File]::WriteAllBytes([string]$item.Path, [byte[]]$item.OriginalBytes) }
    foreach ($item in $staged) {
      if (Test-Path -LiteralPath $item.TemporaryPath) { Remove-Item -LiteralPath $item.TemporaryPath -Force }
    }
    throw 'campaign_eligibility_promotion_failed'
  }

  # Top-level eligible/verdict is campaign-wide: PASS only if EVERY runtime promoted. A partial
  # promotion (one runtime eligible, another not) is still FAIL at this level -- the per-runtime
  # detail (and each runtime's own promoted_count) lives in `runtimes`, for a caller (e.g.
  # campaign-summary.mjs) that needs to know WHICH runtime(s) actually promoted.
  $allRuntimesEligible = $runtimeResults.Count -gt 0 -and @($runtimeResults | Where-Object { -not $_.eligible }).Count -eq 0
  return [ordered]@{
    verdict = if ($allRuntimesEligible) { 'PASS' } else { 'FAIL' }
    reason_code = if ($allRuntimesEligible) { $null } else { 'runtime_ineligible' }
    eligible = $allRuntimesEligible
    promoted_count = $preparedAll.Count
    cell_count = $cellCount
    runtimes = $runtimeResults
  }
}

Export-ModuleMember -Function Invoke-E1CampaignEligibilityFinalization

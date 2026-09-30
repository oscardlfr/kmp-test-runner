# evidence1-run-manifest-contract.psm1
#
# ADR-S6's immutable experiment manifest, translated from the plan's prose field
# list into a concrete JSON schema. This is a NEW schema -- there is no existing
# manifest file in the repo to port field-for-field, unlike every *-contract.psm1
# module before this one in Phase 2/3a/3b, which all ported an already-working
# shape. Treat the exact field names here as this round's proposal for the
# maintainer to adjust, not as an already-reviewed contract -- see
# docs/audits/evidence1-phase3c-architecture-note.md section 3.
#
# ADR-S6 (evidence1-stabilization-plan.md section 5): "Before live execution, the
# orchestrator SHALL produce one human-readable manifest containing: runtime and
# model IDs; model-registry hash; scenario and prompt hashes; product/free
# conditions; round ordering; exact maximum session count; accounts as non-secret
# labels; credential fingerprints and expiry timestamps, never credential values;
# VM identity; execution-profile hashes; output roots; campaign ID; explicit
# statement that no automatic provider retry exists." Every field below maps to
# exactly one clause of that sentence; none were added beyond it.
#
# Not consumed for anything live this round -- evidence1-run.ps1 only reaches
# DryRunPassed, and a manifest is optional up to and including that state (see
# the architecture note section 4). This module exists so the schema is designed
# and validated now, per this round's explicit instruction, even though nothing
# can approve or act on a live manifest yet.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# -Global: matches every other *-{fake,real,hyperv}.psm1 self-reimport in this
# codebase (see Phase 3c fix-forward round's module-shadowing fix) -- without
# it, a nested Import-Module from inside another already-imported module can
# silently steal the target module's exported functions away from the
# caller's scope rather than merely failing to add them.
Import-Module (Join-Path $PSScriptRoot 'evidence1-trusted-root-config.psm1') -Force -DisableNameChecking -Global

function Get-E1RunManifestRequiredKeys {
  return @(
    'schema', 'campaign_id', 'runtimes', 'scenario_id', 'seed', 'execution_profile_id',
    'conditions', 'round_order', 'max_session_count', 'vm_name',
    'guest_credential_path', 'harness_dir', 'source_template_dir',
    'claude_attestation_file', 'codex_attestation_file', 'readiness_path',
    'private_root', 'provider_timeout_seconds', 'worker_timeout_seconds', 'guest_transport_timeout_seconds', 'provider_mode', 'output_roots',
    'no_automatic_provider_retry', 'generated_at_utc'
  )
}

function Test-E1RunManifestSha256($Value) { return $Value -is [string] -and $Value -cmatch '^[0-9a-f]{64}$' }
function Test-E1RunManifestGuid($Value) { return $Value -is [string] -and $Value -cmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$' }
function Test-E1RunManifestUtcTimestamp($Value) {
  if ($Value -is [datetime]) { return $Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' }
  return $Value -is [string] -and $Value -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
}

# Returns the property/key NAMES of $Value regardless of whether it is a raw
# dictionary ([ordered]@{}, e.g. a hand-built manifest in a test) or a
# PSCustomObject (e.g. from Read-E1RunManifest's own ConvertFrom-Json).
# Needed because .PSObject.Properties.Name on a Hashtable/OrderedDictionary
# reflects the .NET TYPE's own members (Count, Keys, IsFixedSize, ...), not
# the dictionary's actual entries -- the exact bug this project's
# shape-asserts hit the first time evidence1-run.ps1 was actually run against
# the fake backends. Same idiom evidence1-validation-forensics.psm1:98
# already uses -- copied, not reinvented.
function Get-E1RunManifestPropertyNames($Value) {
  if ($Value -is [Collections.IDictionary]) { return @($Value.Keys) }
  return @($Value.PSObject.Properties.Name)
}

# Fails closed with a specific reason_code rather than a bare boolean -- a
# manifest is exactly the kind of artifact where "which field, why" matters far
# more than a plain yes/no, since a human has to act on the answer eventually.
#
# -TrustedRoot: the output_roots confinement
# root, injected by the CALLER -- defaults to Get-E1RunManifestDefaultTrustedRoot
# (below) so the common case needs no new configuration, but is never read
# from $Manifest itself. See Assert-E1RunManifestOutputRootsConfined's own
# header for the full rationale.
function Assert-E1RunManifestShape($Manifest, [string]$TrustedRoot = (Get-E1RunManifestDefaultTrustedRoot)) {
  if ($null -eq $Manifest) { throw 'run_manifest_missing' }
  $actual = @(Get-E1RunManifestPropertyNames $Manifest | Sort-Object)
  $expected = @(Get-E1RunManifestRequiredKeys | Sort-Object)
  if (@(Compare-Object $actual $expected).Count -ne 0) { throw 'run_manifest_shape_invalid' }

  if ([int]$Manifest.schema -ne 1) { throw 'run_manifest_schema_invalid' }
  if (-not (Test-E1RunManifestGuid $Manifest.campaign_id)) { throw 'run_manifest_campaign_id_invalid' }

  $runtimes = @($Manifest.runtimes)
  if ($runtimes.Count -lt 1) { throw 'run_manifest_runtimes_empty' }
  foreach ($runtime in $runtimes) {
    $keys = @(Get-E1RunManifestPropertyNames $runtime | Sort-Object)
    if (@(Compare-Object $keys @('runtime_id', 'model_id', 'campaign_design_id', 'campaign_cell_indices', 'max_budget_usd')).Count -ne 0) { throw 'run_manifest_runtime_entry_invalid' }
    if ([string]::IsNullOrWhiteSpace([string]$runtime.runtime_id) -or [string]::IsNullOrWhiteSpace([string]$runtime.model_id) -or
        [string]::IsNullOrWhiteSpace([string]$runtime.campaign_design_id)) {
      throw 'run_manifest_runtime_entry_invalid'
    }
    if ($null -ne $runtime.max_budget_usd -and (($runtime.max_budget_usd -isnot [double]) -and ($runtime.max_budget_usd -isnot [decimal]) -and ($runtime.max_budget_usd -isnot [int]) -and ($runtime.max_budget_usd -isnot [long]) -or [double]$runtime.max_budget_usd -le 0)) { throw 'run_manifest_runtime_max_budget_invalid' }
  }
  $runtimeIds = @($runtimes | ForEach-Object { [string]$_.runtime_id })

  foreach ($field in @('scenario_id','execution_profile_id','vm_name','guest_credential_path','harness_dir','source_template_dir',
      'claude_attestation_file','codex_attestation_file','readiness_path','private_root')) {
    if ([string]::IsNullOrWhiteSpace([string]$Manifest.$field)) { throw ('run_manifest_' + $field + '_invalid') }
  }
  if (($Manifest.seed -isnot [int]) -and ($Manifest.seed -isnot [long])) { throw 'run_manifest_seed_invalid' }
  if ([int64]$Manifest.seed -lt -9007199254740991 -or [int64]$Manifest.seed -gt 9007199254740991) { throw 'run_manifest_seed_invalid' }
  foreach ($field in @('guest_credential_path','harness_dir','source_template_dir','claude_attestation_file',
      'codex_attestation_file','readiness_path','private_root')) {
    if (-not [IO.Path]::IsPathRooted([string]$Manifest.$field)) { throw ('run_manifest_' + $field + '_invalid') }
  }

  $conditions = @($Manifest.conditions | ForEach-Object { [string]$_ })
  if (@(Compare-Object @($conditions | Sort-Object -Unique) @('free', 'product')).Count -ne 0) {
    throw 'run_manifest_conditions_invalid'
  }
  $roundOrder = @($Manifest.round_order | ForEach-Object { [string]$_ })
  if ($roundOrder.Count -lt 1 -or @($roundOrder | Where-Object { $_ -cnotin $conditions }).Count -ne 0) {
    throw 'run_manifest_round_order_invalid'
  }
  foreach ($runtime in $runtimes) {
    $cellIndices = @($runtime.campaign_cell_indices)
    if ($cellIndices.Count -ne $roundOrder.Count) { throw 'run_manifest_campaign_cell_indices_length_invalid' }
    if (@($cellIndices | Where-Object { ($_ -isnot [int]) -and ($_ -isnot [long]) -or $_ -lt 0 }).Count -ne 0) {
      throw 'run_manifest_campaign_cell_indices_value_invalid'
    }
    if (@($cellIndices | Select-Object -Unique).Count -ne $cellIndices.Count) { throw 'run_manifest_campaign_cell_indices_duplicate' }
  }

  if (-not (Test-E1StrictPositiveInt $Manifest.max_session_count) -or [int]$Manifest.max_session_count -gt 96) {
    throw 'run_manifest_max_session_count_invalid'
  }
  # Compared against the derived CELL count (round_order.Count * runtimes.Count
  # -- Get-E1RunManifestExpectedCells), not round_order.Count alone: this is
  # the fix for a confirmed round/cell-count divergence (see that
  # function's own header). The reason_code string is kept as-is
  # (run_manifest_max_session_count_below_round_order) even though the
  # right-hand side is no longer just round_order.Count -- it is still
  # fundamentally the same check family ("max_session_count is too low for
  # what this manifest actually describes"), and changing the reason_code
  # would be an unrelated, unasked-for API change to every caller already
  # matching on it.
  if ([int]$Manifest.max_session_count -lt @(Get-E1RunManifestExpectedCells $Manifest).Count) { throw 'run_manifest_max_session_count_below_round_order' }

  foreach ($field in @('provider_timeout_seconds','worker_timeout_seconds','guest_transport_timeout_seconds')) {
    if (-not (Test-E1StrictPositiveInt $Manifest.$field)) { throw ('run_manifest_' + $field + '_invalid') }
  }
  if (-not ([int]$Manifest.provider_timeout_seconds -lt [int]$Manifest.worker_timeout_seconds -and [int]$Manifest.worker_timeout_seconds -lt [int]$Manifest.guest_transport_timeout_seconds)) { throw 'run_manifest_timeout_order_invalid' }
  if ([string]$Manifest.provider_mode -cnotin @('fake','live')) { throw 'run_manifest_provider_mode_invalid' }

  $outputRootKeys = @(Get-E1RunManifestPropertyNames $Manifest.output_roots | Sort-Object)
  if (@(Compare-Object $outputRootKeys @('private', 'public')).Count -ne 0) { throw 'run_manifest_output_roots_invalid' }
  if ([string]::IsNullOrWhiteSpace([string]$Manifest.output_roots.private) -or [string]::IsNullOrWhiteSpace([string]$Manifest.output_roots.public)) {
    throw 'run_manifest_output_roots_invalid'
  }
  Assert-E1RunManifestOutputRootsConfined $Manifest.output_roots -TrustedRoot $TrustedRoot

  # The one field that exists purely to be asserted, never merely recorded:
  # ADR-S6 requires the manifest to carry an "explicit statement that no
  # automatic provider retry exists" -- so this must literally be true, not
  # just present, or the manifest itself is contradicting the plan's own
  # zero-automatic-retry budget (section 4).
  if ($Manifest.no_automatic_provider_retry -ne $true) { throw 'run_manifest_automatic_retry_statement_invalid' }

  if (-not (Test-E1RunManifestUtcTimestamp $Manifest.generated_at_utc)) { throw 'run_manifest_generated_at_invalid' }
}

# Trusted confinement root for output_roots.private/.public specifically --
# NOT the wider C:\kmp-eval\ the manifest FILE's own path is confined to
# (evidence1-run.ps1:565, Assert-PathInside $Manifest 'C:\kmp-eval\'
# 'manifest'). output_roots are runtime OUTPUT artifact locations, the same
# category as -ReportPath (evidence1-run.ps1:651) and the campaign root
# (:623), both confined to C:\kmp-eval\scratch\ specifically -- and the same
# root evidence1-artifact-store-fake.psm1's Assert-E1ArtifactStoreScratchScoped
# and evidence1-artifact-copy-fake.psm1's Assert-E1FakeArtifactCopyDestination
# already independently enforce on whatever path is actually handed to them.
# This check exists to fail CLOSED at manifest-validation time (matching this
# module's own eager max_session_count-vs-round_order check, not deferred to
# whichever state first touches the filesystem) rather than relying solely on
# those two downstream asserts to catch a bad manifest days later.
#
# This used to be a hardcoded module-level
# constant ($script:E1RunOutputRootsTrustedRoot) with no way to override it
# -- portability gap, fixed here. The trust root is now ALWAYS caller-
# injected (an explicit -TrustedRoot parameter on every function below that
# needs it), never a baked-in constant, and NEVER read from the manifest
# itself -- Get-E1RunManifestRequiredKeys has no field resembling a trust
# root at all (pinned by this module's own test), so there is no way for
# manifest CONTENT to ever reach this decision, even indirectly.
#
# Follow-up round: the env-var-else-historical-default LOGIC itself moved to
# the shared, dependency-free evidence1-trusted-root-config.psm1 (imported
# above) once evidence1-artifact-copy-fake.psm1 and
# evidence1-artifact-store-fake.psm1 needed the identical resolution for
# their own, separate scratch-confinement checks -- see that module's header
# for the full reasoning. This function is now a one-line delegator, kept
# under its own established name (not renamed to the shared one) so every
# existing caller and test (evidence1-run.ps1, this module's own
# Assert-E1RunManifestShape/Assert-E1RunManifestOutputRootsConfined/
# Read-E1RunManifest default parameter values) keeps working unchanged --
# this module's own public API is unaffected, only its internal
# implementation is no longer a second copy of the decision.
function Get-E1RunManifestDefaultTrustedRoot {
  return Get-E1DefaultTrustedRoot
}

# PUBLIC, standalone (callable without a full manifest) so this property can
# be tested in isolation. Requires both paths to be rooted (absolute) BEFORE
# canonicalizing -- [System.IO.Path]::GetFullPath() silently resolves a
# relative path against the CURRENT process's working directory, which is
# ambient, unpredictable state this check must never depend on. Only once
# both are confirmed rooted does GetFullPath() get used, to collapse any `..`
# traversal so a rooted-looking-but-escaping path (e.g.
# C:\kmp-eval\scratch\..\..\Windows\System32) is still caught.
function Assert-E1RunManifestOutputRootsConfined($OutputRoots, [string]$TrustedRoot = (Get-E1RunManifestDefaultTrustedRoot)) {
  $privateRaw = [string]$OutputRoots.private
  $publicRaw = [string]$OutputRoots.public

  if (-not [System.IO.Path]::IsPathRooted($privateRaw)) { throw 'run_manifest_output_roots_not_absolute: private' }
  if (-not [System.IO.Path]::IsPathRooted($publicRaw)) { throw 'run_manifest_output_roots_not_absolute: public' }

  $privateFull = [System.IO.Path]::GetFullPath($privateRaw)
  $publicFull = [System.IO.Path]::GetFullPath($publicRaw)
  $trustedFull = ([System.IO.Path]::GetFullPath($TrustedRoot)).TrimEnd('\') + '\'

  if (-not $privateFull.StartsWith($trustedFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "run_manifest_output_roots_outside_trusted_root: private ($privateFull)"
  }
  if (-not $publicFull.StartsWith($trustedFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "run_manifest_output_roots_outside_trusted_root: public ($publicFull)"
  }

  # Trailing-backslash-normalized before comparing, both for equality and for
  # the nesting StartsWith checks below -- without it, 'scratch\evidence' and
  # 'scratch\evidence-public' would wrongly look "nested" by bare string
  # prefix alone.
  $privateNorm = $privateFull.TrimEnd('\') + '\'
  $publicNorm = $publicFull.TrimEnd('\') + '\'

  if ([string]::Equals($privateNorm, $publicNorm, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'run_manifest_output_roots_not_distinct'
  }
  if ($publicNorm.StartsWith($privateNorm, [StringComparison]::OrdinalIgnoreCase) -or
      $privateNorm.StartsWith($publicNorm, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'run_manifest_output_roots_nested'
  }
}

# PUBLIC. Single source of truth for "how many LiveRunning cells does this
# manifest describe, and which ones".
# round_order.Count * runtimes.Count, enumerated as one cell per
# (round_index, runtime) PAIR, matching plan section 6.2's own diagram (round
# 1: product, free / round 2: free, product / round 3: product, free -- 6
# round_order entries for 3 rounds, each entry already one condition-slot,
# not one entry per round-number) times however many runtimes.runtimes[]
# actually lists -- never a hardcoded count of 2. Used by BOTH this module's
# own max_session_count validation below AND evidence1-run.ps1's
# Invoke-E1RunLiveRunningState dispatch loop, so the two structurally cannot
# drift apart again the way they did before this fix (validation previously
# checked only >= round_order.Count while dispatch already multiplied by
# runtimes.Count). Iterates round_order BY INDEX (not grouped/deduped by
# condition label) so a repeated label at different positions (e.g.
# ['product','free','product','free']) still yields one distinct cell per
# position, never collapsed.
function Get-E1RunManifestExpectedCells($Manifest) {
  $runtimes = @($Manifest.runtimes)
  $roundOrder = @($Manifest.round_order)
  $cells = @()
  for ($roundIndex = 0; $roundIndex -lt $roundOrder.Count; $roundIndex++) {
    # D7 (eval-v2 order fix, design.md (h)): alternates which runtime dispatches FIRST per round --
    # every prior campaign, including Evidence1's own, ran $runtimes[0] first every single round
    # without exception (confirmed from real campaign timestamps, not merely from reading this
    # code). Reversed only, never reshuffled: an odd round_index walks $runtimes back-to-front, an
    # even one keeps the manifest's own literal order -- fully deterministic from the manifest
    # alone (no new randomness source), so a 2-runtime manifest alternates strictly
    # A,B / B,A / A,B / B,A across consecutive rounds. This is a genuinely separate axis from
    # scenario-campaign-plan.mjs's own A/B skill-condition order (design.md (h) item 1) -- that one
    # is pre-registered per campaign design and resolved entirely guest-side as an opaque cell
    # index; this one is resolved here, host-side, before any guest-side plan is ever consulted.
    $roundRuntimes = if ($roundIndex % 2 -eq 1) { $runtimes[($runtimes.Count - 1)..0] } else { $runtimes }
    foreach ($runtime in $roundRuntimes) {
      $cells += [ordered]@{
        runtime_id  = [string]$runtime.runtime_id
        model_id    = [string]$runtime.model_id
        campaign_design_id = [string]$runtime.campaign_design_id
        campaign_cell_index = [int]@($runtime.campaign_cell_indices)[$roundIndex]
        round_index = $roundIndex
        condition   = [string]$roundOrder[$roundIndex]
      }
    }
  }
  return $cells
}

# PUBLIC. Converts the absolute guest directory that contains all records for
# one campaign into the relative path accepted by the closed read-only copy
# capability.  Keep this beside the manifest contract rather than duplicating
# path arithmetic in evidence1-run.ps1: its caller can execute the conversion
# in a directed test without invoking the orchestrator or a real broker.
#
# The guest copy capability is intentionally C:-volume-only.  A manifest's
# private_root is the base used by the internal worker, but records live under
# private_root\\campaign_id\\<runtime>-<round>; callers pass that campaign
# directory here, never private_root by itself.
function ConvertTo-E1RunGuestRelativePath([Parameter(Mandatory)][string]$Path) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  $volumeRoot = [IO.Path]::GetPathRoot($fullPath)
  if ([string]::IsNullOrWhiteSpace($volumeRoot) -or
      -not $volumeRoot.Equals('C:\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'run_manifest_guest_root_volume_invalid'
  }

  $relativePath = $fullPath.Substring($volumeRoot.Length).TrimStart('\\')
  if ([string]::IsNullOrWhiteSpace($relativePath) -or
      [IO.Path]::IsPathRooted($relativePath) -or
      $relativePath -match '(^|\\\\)\.\.(\\\\|$)') {
    throw 'run_manifest_guest_root_relative_invalid'
  }

  $roundTrip = [IO.Path]::GetFullPath((Join-Path $volumeRoot $relativePath))
  if (-not $roundTrip.Equals($fullPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'run_manifest_guest_root_relative_invalid'
  }
  return $relativePath
}

function Test-E1StrictPositiveInt($Value) {
  if ($Value -isnot [int] -and $Value -isnot [int64] -and $Value -isnot [double]) { return $false }
  if ($Value -is [double] -and $Value -ne [Math]::Floor($Value)) { return $false }
  return [int64]$Value -gt 0
}

function Read-E1RunManifest([string]$Path, [string]$TrustedRoot = (Get-E1RunManifestDefaultTrustedRoot)) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'run_manifest_missing' }
  $bytes = [IO.File]::ReadAllBytes($Path)
  # .TrimStart([char]0xfeff): strips a leading UTF-8 byte-order-mark if
  # present. Same idiom evidence1-validation-forensics.psm1 already uses for
  # the identical reason -- Set-Content -Encoding UTF8 / Out-File -Encoding
  # UTF8 in Windows PowerShell 5.1 always writes a BOM (unlike PowerShell 7+),
  # and GetString() decodes those three bytes into a literal leading U+FEFF
  # character rather than stripping them, which ConvertFrom-Json then rejects
  # as invalid JSON. Found via Evidence1-Run-Manifest-Contract.Tests.ps1's own
  # round-trip test, which writes through Set-Content -Encoding UTF8 exactly
  # as a real caller would -- a genuine, previously-undiscovered bug: any
  # manifest authored with ordinary Windows PowerShell 5.1 tooling would have
  # failed to parse.
  $manifest = [Text.UTF8Encoding]::new($false, $true).GetString($bytes).TrimStart([char]0xfeff) | ConvertFrom-Json -ErrorAction Stop
  Assert-E1RunManifestShape $manifest -TrustedRoot $TrustedRoot
  return $manifest
}

Export-ModuleMember -Function `
  Get-E1RunManifestRequiredKeys, `
  Assert-E1RunManifestShape, `
  Assert-E1RunManifestOutputRootsConfined, `
  Get-E1RunManifestDefaultTrustedRoot, `
  Get-E1RunManifestExpectedCells, `
  ConvertTo-E1RunGuestRelativePath, `
  Read-E1RunManifest

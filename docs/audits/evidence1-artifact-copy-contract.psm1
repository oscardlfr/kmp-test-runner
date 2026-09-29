# evidence1-artifact-copy-contract.psm1
#
# ADR-S1's artifacts.copy_read_only capability. Same closed-registry philosophy as
# evidence1-guest-bundle-contract.psm1, applied to file copying instead of guest
# code execution: a caller selects a NAMED, reviewed copy spec and supplies a
# destination directory, never an arbitrary guest source path. A generic "copy any
# caller-named guest path to any caller-named host path" primitive would itself be
# an arbitrary-file-exfiltration tool -- exactly the kind of caller-controlled
# operation ADR-S1's "host paths, VM identity, destination roots, and operation
# schemas remain validated by the broker" sentence is written to prevent, even
# though that sentence names guest.invoke_bundle explicitly and artifacts.copy_read_only
# only implicitly. See docs/audits/evidence1-phase3b-architecture-note.md section 2.
#
# Mechanism, confirmed by reading all seven named copy scripts plus
# evidence1-hyperv-copy-live-artifacts.ps1: EVERY one of them requires the VM to
# be Off and reads via Mount-VHD -ReadOnly -- none use PowerShell Direct for the
# actual copy. (evidence1-hyperv-copy-live-artifacts.ps1 additionally supports an
# optional "gracefully stop first if currently Running" path using the exact
# Stop-VM -AsJob/Wait-Job pattern evidence1-vm-state-hyperv.psm1 also implements --
# composition, not a third mechanism: a caller that wants that convenience calls
# Invoke-E1VmEnsureState('Off') first, then this module.)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-E1ArtifactCopySpecNames {
  return @((Get-E1ArtifactCopySpecRegistry).Keys | Sort-Object)
}

function Assert-E1ArtifactCopySpecName([string]$Name) {
  if ($Name -cnotin (Get-E1ArtifactCopySpecNames)) { throw "artifact_copy_spec_name_invalid: $Name" }
}

# The closed copy-spec registry. Every guest_relative value below is a fixed,
# reviewed literal (or a literal with an already-validated {ArgName} placeholder
# substituted in, never raw caller input) -- see Resolve-E1ArtifactCopySources.
# Each entry:
#   description        -- human-readable
#   argument_schema      -- ORDERED map of argument name -> validator scriptblock
#                            (same ordering contract as evidence1-guest-bundle-contract.psm1:
#                            argument_schema.Keys order must match how
#                            evidence1-artifact-copy-hyperv.psm1 resolves guest
#                            source paths for this spec).
#   sources               -- ordered list of { guest_relative, destination_name,
#                             required, max_bytes } describing exactly which
#                             files get copied and nothing else. guest_relative
#                             may reference {ArgName} placeholders resolved from
#                             the (already-validated) arguments.
#   result_keys            -- exact expected key set of the copy result
#
# Two worked examples, deliberately modest for this groundwork round -- see the
# architecture note section 4 for what's not ported yet (the campaign-evidence
# hash-chain validation several of the read scripts layer on top of the copy
# itself, which is a caller-side concern built on this primitive, not part of
# the primitive -- same separation Phase 3a drew between guest.invoke_bundle and
# the full OAuth flows built on it).
function Get-E1ArtifactCopySpecRegistry {
  return [ordered]@{

    # Ported from evidence1-hyperv-copy-final-codex-attestation.ps1: one fixed
    # file, no arguments, exact canonical destination name.
    'final-codex-attestation' = [ordered]@{
      description     = 'Copies the single sandboxed-isolation attestation file from a closed E2E VM.'
      argument_schema  = [ordered]@{}
      sources           = @(
        [ordered]@{
          guest_relative   = 'kmp-eval\measurement-scopes\evidence1-claude-windows-isolation-attestation-stageb-v1.json'
          destination_name = 'evidence1-claude-windows-isolation-attestation-stageb-v1.json'
          required         = $true
          max_bytes        = 1048576
        }
      )
      result_keys       = @('files_copied')
    }

    # Generalizes evidence1-hyperv-copy-final-codex-failure-diagnostic.ps1: a
    # fixed small set of campaign-scoped diagnostic files, named by CampaignId.
    'final-codex-failure-diagnostic' = [ordered]@{
      description     = 'Copies terminal/claim/stdout/stderr diagnostic files for one failed campaign.'
      argument_schema  = [ordered]@{
        CampaignId = { param($v) $v -is [string] -and $v -cmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$' }
      }
      sources           = @(
        [ordered]@{ guest_relative = 'Evidence1Ops\final-codex\{CampaignId}.terminal.json'; destination_name = 'terminal.json'; required = $true; max_bytes = 1048576 }
        [ordered]@{ guest_relative = 'Evidence1Ops\final-codex\{CampaignId}.terminal.claim.json'; destination_name = 'terminal.claim.json'; required = $false; max_bytes = 1048576 }
        [ordered]@{ guest_relative = 'Evidence1Ops\final-codex\{CampaignId}.stdout.log'; destination_name = 'wrapper.stdout.log'; required = $false; max_bytes = 4194304 }
        [ordered]@{ guest_relative = 'Evidence1Ops\final-codex\{CampaignId}.stderr.log'; destination_name = 'wrapper.stderr.log'; required = $false; max_bytes = 4194304 }
      )
      result_keys       = @('files_copied', 'terminal_state')
    }

    'agentic-eval-session-record' = [ordered]@{
      description = 'Copies the normalized accepted record and audit sidecar for one Evidence1 manifest cell.'
      argument_schema = [ordered]@{
        PrivateRootRelative = { param($v) $v -is [string] -and $v -cmatch '^[A-Za-z0-9_-]+(?:\\[A-Za-z0-9_-]+)*$' }
        CellKey = { param($v) $v -is [string] -and $v -cmatch '^[a-z0-9][a-z0-9_-]{0,95}$' }
      }
      sources = @(
        [ordered]@{ guest_relative = '{PrivateRootRelative}\{CellKey}\record.json'; destination_name = 'record.json'; required = $true; max_bytes = 10485760 }
        [ordered]@{ guest_relative = '{PrivateRootRelative}\{CellKey}\audit.json'; destination_name = 'audit.json'; required = $true; max_bytes = 10485760 }
      )
      result_keys = @('files_copied')
    }

    # Private, local-only forensics used when a live cell completed but the
    # harness rejected it before promotion.  These specs expose only the
    # harness' canonical evidence locations and validated filenames; they do
    # not provide a caller-selected guest path.
    'agentic-eval-rejection-diagnostic' = [ordered]@{
      description = 'Copies one structured rejection diagnostic for a completed Evidence1 cell.'
      argument_schema = [ordered]@{
        PrivateRootRelative = { param($v) $v -is [string] -and $v -cmatch '^[A-Za-z0-9_-]+(?:\\[A-Za-z0-9_-]+)*$' }
        CellKey = { param($v) $v -is [string] -and $v -cmatch '^[a-z0-9][a-z0-9_-]{0,95}$' }
        RejectionId = { param($v) $v -is [string] -and $v -cmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$' }
      }
      sources = @(
        [ordered]@{ guest_relative = '{PrivateRootRelative}\{CellKey}\agentic-eval-rejected\{RejectionId}.json'; destination_name = 'rejection.json'; required = $true; max_bytes = 10485760 }
      )
      result_keys = @('files_copied')
    }

    # 2026-09-29 (WO-A2 auditor finding): the ONLY diagnostic evidence a session that failed
    # BEFORE producing record.json/audit.json leaves behind (finalizeIncident,
    # tools/agentic-eval/incident-diagnostics.mjs) -- already PII-redacted before it's ever written
    # (assertCleanOrThrowObject), so read-only-copying it off the guest carries no exposure this
    # capability's own design doesn't already accept for every other spec here.
    'agentic-eval-incident-diagnostic' = [ordered]@{
      description = 'Copies one structured incident diagnostic for a session that failed before any record/audit pair existed.'
      argument_schema = [ordered]@{
        PrivateRootRelative = { param($v) $v -is [string] -and $v -cmatch '^[A-Za-z0-9_-]+(?:\\[A-Za-z0-9_-]+)*$' }
        CellKey = { param($v) $v -is [string] -and $v -cmatch '^[a-z0-9][a-z0-9_-]{0,95}$' }
        IncidentId = { param($v) $v -is [string] -and $v -cmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$' }
      }
      sources = @(
        [ordered]@{ guest_relative = '{PrivateRootRelative}\{CellKey}\agentic-eval-incident\{IncidentId}.json'; destination_name = 'incident.json'; required = $true; max_bytes = 10485760 }
      )
      result_keys = @('files_copied')
    }

    'agentic-eval-accepted-raw-transcript' = [ordered]@{
      description = 'Copies one accepted cell raw transcript into private local forensic storage.'
      argument_schema = [ordered]@{
        PrivateRootRelative = { param($v) $v -is [string] -and $v -cmatch '^[A-Za-z0-9_-]+(?:\\[A-Za-z0-9_-]+)*$' }
        CellKey = { param($v) $v -is [string] -and $v -cmatch '^[a-z0-9][a-z0-9_-]{0,95}$' }
        FileName = { param($v) $v -is [string] -and $v -cmatch '^scenario-(?:current-skill|no-skill)-[0-9a-f]{8}\.jsonl$' }
      }
      sources = @(
        [ordered]@{ guest_relative = '{PrivateRootRelative}\{CellKey}\agentic-eval-scenario\raw\{FileName}'; destination_name = 'transcript.jsonl'; required = $true; max_bytes = 52428800 }
      )
      result_keys = @('files_copied')
    }

    'agentic-eval-rejected-raw-transcript' = [ordered]@{
      description = 'Copies one rejected cell raw transcript into private local forensic storage.'
      argument_schema = [ordered]@{
        PrivateRootRelative = { param($v) $v -is [string] -and $v -cmatch '^[A-Za-z0-9_-]+(?:\\[A-Za-z0-9_-]+)*$' }
        CellKey = { param($v) $v -is [string] -and $v -cmatch '^[a-z0-9][a-z0-9_-]{0,95}$' }
        RejectionId = { param($v) $v -is [string] -and $v -cmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$' }
        FileName = { param($v) $v -is [string] -and $v -cmatch '^[0-9]+-[0-9a-f]{64}\.jsonl$' }
      }
      sources = @(
        [ordered]@{ guest_relative = '{PrivateRootRelative}\{CellKey}\agentic-eval-rejected\raw\transcripts\{RejectionId}\{FileName}'; destination_name = 'transcript.jsonl'; required = $true; max_bytes = 52428800 }
      )
      result_keys = @('files_copied')
    }

    'agentic-eval-rejected-raw-stderr' = [ordered]@{
      description = 'Copies one rejected cell raw provider stderr into private local forensic storage.'
      argument_schema = [ordered]@{
        PrivateRootRelative = { param($v) $v -is [string] -and $v -cmatch '^[A-Za-z0-9_-]+(?:\\[A-Za-z0-9_-]+)*$' }
        CellKey = { param($v) $v -is [string] -and $v -cmatch '^[a-z0-9][a-z0-9_-]{0,95}$' }
        RejectionId = { param($v) $v -is [string] -and $v -cmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$' }
        FileName = { param($v) $v -is [string] -and $v -cmatch '^[0-9]+-[0-9a-f]{64}\.stderr\.txt$' }
      }
      sources = @(
        [ordered]@{ guest_relative = '{PrivateRootRelative}\{CellKey}\agentic-eval-rejected\raw\stderr\{RejectionId}\{FileName}'; destination_name = 'stderr.txt'; required = $true; max_bytes = 10485760 }
      )
      result_keys = @('files_copied')
    }
  }
}

function Assert-E1ArtifactCopyArguments([string]$Name, $Arguments) {
  Assert-E1ArtifactCopySpecName $Name
  $spec = (Get-E1ArtifactCopySpecRegistry)[$Name]
  if ($null -eq $Arguments) { $Arguments = @{} }
  $suppliedKeys = @($Arguments.Keys | Sort-Object)
  $declaredKeys = @($spec.argument_schema.Keys | Sort-Object)
  if (@(Compare-Object $suppliedKeys $declaredKeys).Count -ne 0) {
    throw "artifact_copy_argument_shape_invalid: $Name expects exactly [$($declaredKeys -join ', ')]"
  }
  foreach ($key in $declaredKeys) {
    $ok = & $spec.argument_schema[$key] $Arguments[$key]
    if ($ok -ne $true) { throw "artifact_copy_argument_invalid: $Name.$key" }
  }
}

# Resolves a spec's {ArgName} placeholders against already-validated arguments,
# returning the concrete guest-relative source list. Called by
# evidence1-artifact-copy-hyperv.psm1 (and the fake) after
# Assert-E1ArtifactCopyArguments has already accepted $Arguments -- never
# resolves placeholders from unvalidated input.
function Resolve-E1ArtifactCopySources([string]$Name, $Arguments) {
  Assert-E1ArtifactCopyArguments $Name $Arguments
  $spec = (Get-E1ArtifactCopySpecRegistry)[$Name]
  $resolved = @()
  foreach ($source in $spec.sources) {
    $relative = [string]$source.guest_relative
    foreach ($key in $spec.argument_schema.Keys) {
      $relative = $relative.Replace("{$key}", [string]$Arguments[$key])
    }
    $resolved += [ordered]@{
      guest_relative   = $relative
      destination_name = [string]$source.destination_name
      required         = [bool]$source.required
      max_bytes        = [int64]$source.max_bytes
    }
  }
  return $resolved
}

# Returns the property/key NAMES of $Value regardless of whether it is a raw
# dictionary ([ordered]@{}, e.g. straight from Copy-E1ArtifactsReadOnly, never
# serialized) or a PSCustomObject (e.g. from ConvertFrom-Json). Needed because
# .PSObject.Properties.Name on a Hashtable/OrderedDictionary reflects the .NET
# TYPE's own members (Count, Keys, IsFixedSize, ...), not the dictionary's
# actual entries -- the exact bug this project's shape-asserts hit the first
# time evidence1-run.ps1 was actually run against the fake backends. Same
# idiom evidence1-validation-forensics.psm1:98 already uses -- copied, not
# reinvented.
function Get-E1ArtifactCopyPropertyNames($Value) {
  if ($Value -is [Collections.IDictionary]) { return @($Value.Keys) }
  return @($Value.PSObject.Properties.Name)
}

function Assert-E1ArtifactCopyResultShape([string]$Name, $Result) {
  Assert-E1ArtifactCopySpecName $Name
  $spec = (Get-E1ArtifactCopySpecRegistry)[$Name]
  if ($null -eq $Result) { throw "artifact_copy_result_missing: $Name" }
  $actual = @(Get-E1ArtifactCopyPropertyNames $Result | Sort-Object)
  $expected = @($spec.result_keys | Sort-Object)
  if (@(Compare-Object $actual $expected).Count -ne 0) { throw "artifact_copy_result_shape_invalid: $Name" }
}

# PUBLIC. Makes EvidenceCopied retry-safe per cell without ever deleting a
# campaign output root. A prior complete pair is reusable only when the record
# still names the runtime/model of that cell. An incomplete cell directory is
# disposable staging and is removed so the create-new copy capability can run
# again. A complete but contradictory record is evidence corruption, not a
# partial copy, and fails closed without deletion.
function Resolve-E1ArtifactCopyResumeDestination(
  [Parameter(Mandatory)][string]$DestinationDir,
  [Parameter(Mandatory)][string]$RuntimeId,
  [Parameter(Mandatory)][string]$ModelId,
  [Parameter(Mandatory)][string]$ScenarioId,
  [Parameter(Mandatory)][int64]$Seed,
  [Parameter(Mandatory)][ValidateSet('product','free')][string]$Condition,
  [Parameter(Mandatory)][int]$CampaignCellIndex
) {
  if (-not (Test-Path -LiteralPath $DestinationDir)) { return 'copy' }
  if (-not (Test-Path -LiteralPath $DestinationDir -PathType Container)) { throw 'evidence_copied_existing_cell_destination_invalid' }

  $entries = @(Get-ChildItem -LiteralPath $DestinationDir -Force)
  $entryNames = @($entries | ForEach-Object { [string]$_.Name } | Sort-Object)
  $fileEntries = @($entries | Where-Object { -not $_.PSIsContainer })
  $entryDifferences = @(Compare-Object $entryNames @('audit.json','record.json'))
  $isExactPair = $entries.Count -eq 2 -and $fileEntries.Count -eq 2 -and $entryDifferences.Count -eq 0
  if (-not $isExactPair) {
    Remove-Item -LiteralPath $DestinationDir -Recurse -Force
    return 'copy'
  }

  try {
    $record = Get-Content -LiteralPath (Join-Path $DestinationDir 'record.json') -Raw | ConvertFrom-Json -ErrorAction Stop
    $audit = Get-Content -LiteralPath (Join-Path $DestinationDir 'audit.json') -Raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw 'evidence_copied_existing_cell_identity_mismatch'
  }
  $expectedCliCondition = if ($Condition -ceq 'product') { 'current-skill' } else { 'no-skill' }
  if ($null -eq $record.agent_runtime -or
      [string]$record.agent_runtime.runtime_id -cne $RuntimeId -or
      [string]$record.agent_runtime.model_requested -cne $ModelId -or
      [string]$record.scenario_id -cne $ScenarioId -or [int64]$record.seed -ne $Seed -or
      [int]$record.order_index -ne $CampaignCellIndex -or [string]$record.condition -cne $expectedCliCondition -or
      [string]$audit.run_id -cne [string]$record.run_id) {
    throw 'evidence_copied_existing_cell_identity_mismatch'
  }
  return 'reuse'
}

Export-ModuleMember -Function `
  Get-E1ArtifactCopySpecNames, `
  Assert-E1ArtifactCopySpecName, `
  Get-E1ArtifactCopySpecRegistry, `
  Assert-E1ArtifactCopyArguments, `
  Resolve-E1ArtifactCopySources, `
  Assert-E1ArtifactCopyResultShape, `
  Resolve-E1ArtifactCopyResumeDestination

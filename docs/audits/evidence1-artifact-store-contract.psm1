# evidence1-artifact-store-contract.psm1
#
# ADR-S4's ArtifactStore interface (production: filesystem create-new store;
# test: temporary in-memory/filesystem store).
#
# Distinct from ADR-S1's artifacts.copy_read_only (Phase 3b, already built):
# that capability pulls files OUT of the guest VM via VHD mount into a host
# destination -- it is a broker capability, part of the six ADR-S1 families.
# ArtifactStore is a different concern entirely: the orchestrator's own
# private-to-public PUBLICATION store for campaign evidence already sitting
# on the host, matching plan section 7 Phase 4's own required rehearsal #7,
# "crash between private/public artifact publication and recovery" -- a
# scenario about publication atomicity, not about guest access. Checked
# directly rather than assumed: artifacts.copy_read_only's own contract
# module (evidence1-artifact-copy-contract.psm1) has no notion of a private/
# public split or a staging/transaction/ready sequence anywhere in it; this
# is new. The atomic staging pattern below is modeled on
# evidence1-dual-condition-canary-contract.psm1's own already-proven
# Publish-Evidence1DualConditionArtifactSet (`.staging`, `.publication.
# transaction.json`, `.publication.ready.json`) rather than invented fresh.
#
# EvidenceCopied (the state before Closed) is where artifacts.copy_read_only
# runs, pulling evidence from the guest into this campaign's PRIVATE staging
# area. Closed is where ArtifactStore then publishes from that private area
# to a public one, atomically.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-E1ArtifactStorePropertyNames($Value) {
  if ($Value -is [Collections.IDictionary]) { return @($Value.Keys) }
  return @($Value.PSObject.Properties.Name)
}

function New-E1ArtifactStorePublicationResult {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$PrivateRoot,
    [Parameter(Mandatory)][string]$PublicRoot,
    [Parameter(Mandatory)][ValidateSet('committed', 'already-committed')][string]$State,
    [Parameter(Mandatory)][int]$ArtifactCount,
    [Parameter(Mandatory)][bool]$RecoveredTornState,
    [Parameter(Mandatory)][ValidateSet('PASS', 'FAIL')][string]$Verdict,
    [string]$ReasonCode = $null
  )
  return [ordered]@{
    schema                = 1
    private_root           = $PrivateRoot
    public_root              = $PublicRoot
    state                     = $State
    artifact_count             = $ArtifactCount
    recovered_torn_state         = $RecoveredTornState
    verdict                       = $Verdict
    reason_code                    = $ReasonCode
    generated_at_utc                = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
}

function Assert-E1ArtifactStorePublicationResult($Result) {
  if ($null -eq $Result) { throw 'artifact_store_publication_result_missing' }
  $required = @(
    'schema', 'private_root', 'public_root', 'state', 'artifact_count',
    'recovered_torn_state', 'verdict', 'reason_code', 'generated_at_utc'
  )
  $actual = @(Get-E1ArtifactStorePropertyNames $Result | Sort-Object)
  if (@(Compare-Object $actual @($required | Sort-Object)).Count -ne 0) {
    throw 'artifact_store_publication_result_shape_invalid'
  }
  if ([int]$Result.schema -ne 1) { throw 'artifact_store_publication_result_schema_invalid' }
  if ([string]$Result.verdict -cnotin @('PASS', 'FAIL')) { throw 'artifact_store_publication_result_verdict_invalid' }
  if ([string]$Result.verdict -ceq 'FAIL' -and [string]::IsNullOrWhiteSpace([string]$Result.reason_code)) {
    throw 'artifact_store_publication_result_fail_missing_reason'
  }
}

Export-ModuleMember -Function `
  New-E1ArtifactStorePublicationResult, `
  Assert-E1ArtifactStorePublicationResult

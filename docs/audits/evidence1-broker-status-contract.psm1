# evidence1-broker-status-contract.psm1
#
# ADR-S1's broker.status capability, now split into the established
# contract/real/fake three-way shape every other capability family already
# has (evidence1-vm-state-*.psm1, evidence1-network-backend-*.psm1, etc.).
#
# Phase 3c fix-forward addendum: the maintainer made the architectural catch
# that motivated this split -- broker.status was the one capability family
# that never got a fake, so even a fully-fake evidence1-run.ps1 rehearsal
# still depended on THIS host's real, already-installed broker at
# BrokerReady. That was an inconsistency in the earlier design (Phase 3a),
# not an intentional gap. This file now holds ONLY the pure, zero-I/O pieces:
# the five canonical deployment-identity constants (unchanged from Phase 3a)
# and the broker.status RESULT shape (new). The real, host-touching
# implementation moved verbatim (no behavior change) to
# evidence1-broker-status-real.psm1; the new deterministic test double is
# evidence1-broker-status-fake.psm1. evidence1-install.ps1 and
# evidence1-run.ps1 both updated to import the real/contract pair they
# actually need -- see each file's own header.
#
# Naming: "-real.psm1", not "-hyperv.psm1" -- deliberately, unlike every
# other capability's real-implementation file. broker.status never touches
# Hyper-V, a VM, an adapter, or PowerShell Direct at all; it is pure
# host-side ScheduledTasks/filesystem/ACL inspection. Calling it "-hyperv"
# would claim a dependency that does not exist.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-E1BrokerRequiredTaskName { return 'Evidence1CodexElevatedRunner' }
function Get-E1BrokerRequiredManifestSchema { return 2 }
function Get-E1BrokerRunnerScriptName { return 'evidence1-host-elevated-runner.ps1' }
function Get-E1BrokerProcessModuleName { return 'evidence1-validation-ops.psm1' }
function Get-E1BrokerSelfInstallScriptName { return 'evidence1-host-elevated-runner-install.ps1' }

# Returns the property/key NAMES of $Value regardless of whether it is a raw
# dictionary ([ordered]@{}, e.g. straight from New-E1BrokerStatusResult,
# never serialized) or a PSCustomObject (e.g. from ConvertFrom-Json). Same
# idiom evidence1-validation-forensics.psm1:98 already uses, applied from the
# start here rather than retrofitted after a real failure -- see
# docs/audits/evidence1-phase3c-architecture-note.md section 10.3 for why
# every other *-contract.psm1 module in this repo needed this fix reactively.
function Get-E1BrokerStatusPropertyNames($Value) {
  if ($Value -is [Collections.IDictionary]) { return @($Value.Keys) }
  return @($Value.PSObject.Properties.Name)
}

# The one result shape both implementations (real and fake) must produce, so
# a caller written against one behaves identically against the other --
# mirrors New-E1NetworkModeResult/New-E1VmStateResult's role for their own
# capability families. Ten keys, matching Get-E1BrokerStatus's own
# already-established shape exactly (unchanged): callers may dot-access any
# field without first checking it exists, regardless of which branch
# produced it.
function New-E1BrokerStatusResult {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][bool]$TaskExists,
    [Parameter(Mandatory)][bool]$Readable,
    [string]$DeploymentRoot = $null,
    [Nullable[int]]$ManifestSchema = $null,
    [string]$SourceGitCommit = $null,
    [string]$PrincipalSid = $null,
    [Nullable[int]]$ScriptCount = $null,
    [Parameter(Mandatory)][bool]$HashesValid,
    [Parameter(Mandatory)][bool]$AclValid,
    [Parameter(Mandatory)][bool]$SelfUpdateCapable
  )
  return [ordered]@{
    task_exists         = $TaskExists
    readable            = $Readable
    deployment_root     = $DeploymentRoot
    manifest_schema     = $ManifestSchema
    source_git_commit   = $SourceGitCommit
    principal_sid       = $PrincipalSid
    script_count        = $ScriptCount
    hashes_valid        = $HashesValid
    acl_valid           = $AclValid
    self_update_capable = $SelfUpdateCapable
  }
}

function Assert-E1BrokerStatusResult($Result) {
  if ($null -eq $Result) { throw 'broker_status_result_missing' }
  $required = @(
    'task_exists', 'readable', 'deployment_root', 'manifest_schema', 'source_git_commit',
    'principal_sid', 'script_count', 'hashes_valid', 'acl_valid', 'self_update_capable'
  )
  $actual = @(Get-E1BrokerStatusPropertyNames $Result | Sort-Object)
  if (@(Compare-Object $actual @($required | Sort-Object)).Count -ne 0) {
    throw 'broker_status_result_shape_invalid'
  }
  # Invariants ported directly from Get-E1BrokerStatus's own two "not found /
  # not readable" branches (unchanged from before the split): task missing
  # implies not readable and every dependent field null/false; task present
  # but unreadable implies the same for everything past deployment_root.
  if (-not $Result.task_exists -and $Result.readable) { throw 'broker_status_result_task_missing_but_readable' }
  if (-not $Result.readable) {
    if ($Result.hashes_valid -or $Result.acl_valid -or $Result.self_update_capable) {
      throw 'broker_status_result_unreadable_but_claims_validity'
    }
  }
}

Export-ModuleMember -Function `
  Get-E1BrokerRequiredTaskName, `
  Get-E1BrokerRequiredManifestSchema, `
  Get-E1BrokerRunnerScriptName, `
  Get-E1BrokerProcessModuleName, `
  Get-E1BrokerSelfInstallScriptName, `
  New-E1BrokerStatusResult, `
  Assert-E1BrokerStatusResult

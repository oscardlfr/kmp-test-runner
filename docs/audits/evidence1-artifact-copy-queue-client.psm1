# evidence1-artifact-copy-queue-client.psm1
#
# Non-elevated artifacts.copy_read_only caller (ADR-S1, this round's Task 3),
# dispatched through the elevated broker's queue instead of importing/
# calling evidence1-artifact-copy-hyperv.psm1 in-process -- see
# evidence1-vm-state-queue-client.psm1's header for the general pattern this
# module repeats, and evidence1-artifact-copy-hyperv.psm1's own header for
# why its -TrustedRoot is Mandatory-with-no-default there.
#
# TrustedRoot, precisely (this round's explicit requirement):
#   - resolved ONLY inside evidence1-host-broker-capability-dispatch.ps1,
#     from a freshly-computed, verified BrokerStatus, via
#     Get-E1ArtifactCopyRealTrustedRoot -- never here;
#   - never accepted from this module's caller as something that reaches the
#     capability request: -TrustedRoot on Copy-E1ArtifactsReadOnly below is
#     accepted-and-IGNORED, the exact template
#     evidence1-guest-bundle-fake.psm1's Invoke-E1GuestBundle already
#     established for -GuestCredentialPath
#     (docs/audits/evidence1-phase3c-architecture-note.md section 6) --
#     kept as a parameter ONLY so evidence1-run.ps1's existing
#     Invoke-E1RunEvidenceCopiedState call site
#     (-TrustedRoot $Context.OutputRootsTrustedRoot) does not hard-fail on a
#     "parameter cannot be found" binding error on the day EvidenceCopied is
#     eventually unblocked for real backends -- a future round's work, not
#     this one's, but this module should not need editing again just to
#     accept a call shape that already exists today;
#   - structurally cannot leak into the request even if a caller tried: this
#     capability's own argument_schema
#     (evidence1-broker-capability-contract.psm1) has no TrustedRoot key at
#     all, so Assert-E1BrokerCapabilityArguments would reject an attempt to
#     add one as an undeclared argument. This module never attempts to add
#     one in the first place -- see the function body below, which never
#     reads $TrustedRoot for any purpose.
#
# Translation rule (see evidence1-broker-capability-dispatch-core.psm1):
# response.result is $null iff Copy-E1ArtifactsReadOnly threw --
# evidence1-artifact-copy-hyperv.psm1 has NO FAIL-shaped return path at all
# (every failure, confirmed by reading that module in full, is a throw), so
# "null result -> re-throw; non-null result -> return as-is" is the only
# rule this capability ever needs.
#
# DRAFTED, NEVER EXECUTED CODE -- same standing notice as every -hyperv.psm1
# sibling.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-artifact-copy-contract.psm1') -Force -DisableNameChecking -Global
Import-Module (Join-Path $PSScriptRoot 'evidence1-broker-capability-client.psm1') -Force -DisableNameChecking -Global

function Copy-E1ArtifactsReadOnly {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$ExpectedVMId,
    [Parameter(Mandatory)][string]$SpecName,
    [hashtable]$Arguments = @{},
    [Parameter(Mandatory)][string]$DestinationDir,
    # Accepted, deliberately never read -- see this file's own header.
    [string]$TrustedRoot = '',
    # No real-infrastructure default -- see evidence1-broker-capability-client.psm1's
    # own header for why this is an explicit empty default + guard-clause
    # throw, never [Parameter(Mandatory)] (prompts/hangs non-interactively).
    [string]$QueueRoot = '',
    [string]$AllowedRoot = '',
    [string]$TaskName = (Get-E1BrokerCapabilityDefaultTaskName),
    [int]$TimeoutMinutes = 120,
    [int]$PollIntervalSeconds = 2,
    [scriptblock]$TriggerTask = $null,
    [scriptblock]$GetUtcNow = { [DateTime]::UtcNow }
  )
  Assert-E1ArtifactCopySpecName $SpecName
  Assert-E1ArtifactCopyArguments $SpecName $Arguments
  if ([string]::IsNullOrWhiteSpace($QueueRoot)) { throw 'artifact_copy_queue_client_queue_root_required' }
  if ($null -eq $TriggerTask) { throw 'artifact_copy_queue_client_trigger_task_required' }
  $capabilityArguments = [ordered]@{
    VMName         = $VMName
    ExpectedVMId   = $ExpectedVMId
    SpecName       = $SpecName
    Arguments      = $Arguments
    DestinationDir = $DestinationDir
  }
  $response = Submit-E1BrokerCapabilityOperation -Capability 'artifacts.copy_read_only' -Arguments $capabilityArguments `
    -QueueRoot $QueueRoot -AllowedRoot $AllowedRoot -TaskName $TaskName -TimeoutMinutes $TimeoutMinutes `
    -PollIntervalSeconds $PollIntervalSeconds -TriggerTask $TriggerTask -GetUtcNow $GetUtcNow
  if ($null -eq $response.result) { throw ([string]$response.reason_code) }
  Assert-E1ArtifactCopyResultShape $SpecName $response.result
  return $response.result
}

Export-ModuleMember -Function Copy-E1ArtifactsReadOnly

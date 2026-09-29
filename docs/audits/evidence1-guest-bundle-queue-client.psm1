# evidence1-guest-bundle-queue-client.psm1
#
# Non-elevated guest.invoke_bundle caller (ADR-S1), dispatched through the
# elevated broker's queue instead of importing/calling
# evidence1-guest-bundle-hyperv.psm1 in-process -- see
# evidence1-vm-state-queue-client.psm1's header for the full pattern this
# module repeats.
#
# -Arguments here is the SAME nested, bundle-specific hashtable
# Invoke-E1GuestBundle itself takes (e.g. {CommandPath; LoginStatusArgs} for
# 'get-cli-version-and-login-status') -- it travels inside this capability's
# own "Arguments" request field
# (evidence1-broker-capability-contract.psm1's guest.invoke_bundle registry
# entry) and is converted back to a real [hashtable] with
# ConvertTo-E1BrokerCapabilityHashtable by
# evidence1-broker-capability-dispatch-core.psm1 before
# Invoke-E1GuestBundle ever sees it -- including the [string[]] coercion
# that closes the exact LoginStatusArgs bug class
# docs/audits/evidence1-phase3c-architecture-note.md section 10.5 already
# found once in evidence1-run.ps1 itself.
#
# Translation rule (see evidence1-broker-capability-dispatch-core.psm1):
# response.result is $null iff Invoke-E1GuestBundle threw (a genuine
# programming-contract violation -- unknown bundle name, malformed
# arguments, an out-of-range timeout -- all of which this capability's own
# argument_schema already rejects before ever reaching the function for a
# well-formed request); non-null for the ordinary PASS/FAIL bundle outcome,
# which Invoke-E1GuestBundle always returns as a shaped result rather than
# throwing (see that module's own header).
#
# DRAFTED, NEVER EXECUTED CODE -- same standing notice as every -hyperv.psm1
# sibling.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-guest-bundle-contract.psm1') -Force -DisableNameChecking -Global
Import-Module (Join-Path $PSScriptRoot 'evidence1-broker-capability-client.psm1') -Force -DisableNameChecking -Global

function Invoke-E1GuestBundle {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$GuestCredentialPath,
    [Parameter(Mandatory)][string]$BundleName,
    [hashtable]$Arguments = @{},
    [int]$TimeoutSeconds = 60,
    # No real-infrastructure default -- see evidence1-broker-capability-client.psm1's
    # own header for why this is an explicit empty default + guard-clause
    # throw, never [Parameter(Mandatory)] (prompts/hangs non-interactively).
    [string]$QueueRoot = '',
    [string]$AllowedRoot = '',
    [string]$TaskName = (Get-E1BrokerCapabilityDefaultTaskName),
    [int]$TimeoutMinutes = (Get-E1BrokerCapabilityDefaultTimeoutMinutes),
    [int]$PollIntervalSeconds = 2,
    [scriptblock]$TriggerTask = $null,
    [scriptblock]$GetUtcNow = { [DateTime]::UtcNow }
  )
  Assert-E1GuestBundleName $BundleName
  Assert-E1GuestBundleArguments $BundleName $Arguments
  if ([string]::IsNullOrWhiteSpace($QueueRoot)) { throw 'guest_bundle_queue_client_queue_root_required' }
  if ($null -eq $TriggerTask) { throw 'guest_bundle_queue_client_trigger_task_required' }
  $capabilityArguments = [ordered]@{
    VMName              = $VMName
    GuestCredentialPath = $GuestCredentialPath
    BundleName          = $BundleName
    Arguments           = $Arguments
    TimeoutSeconds       = $TimeoutSeconds
  }
  $response = Submit-E1BrokerCapabilityOperation -Capability 'guest.invoke_bundle' -Arguments $capabilityArguments `
    -QueueRoot $QueueRoot -AllowedRoot $AllowedRoot -TaskName $TaskName -TimeoutMinutes $TimeoutMinutes `
    -PollIntervalSeconds $PollIntervalSeconds -TriggerTask $TriggerTask -GetUtcNow $GetUtcNow
  if ($null -eq $response.result) { throw ([string]$response.reason_code) }
  # Assert-E1GuestBundleResultShape validates the INNER .output shape
  # against the bundle's own declared result_keys (confirmed by reading
  # evidence1-guest-bundle-hyperv.psm1: it calls this assert on the raw
  # guest scriptblock's return value BEFORE wrapping it into
  # New-E1GuestBundleInvocationResult's outer 9-key envelope) -- NOT the
  # outer envelope $response.result actually is. That inner shape is
  # already guaranteed by the real/fake Invoke-E1GuestBundle itself before
  # it ever returns, so it is not re-validated a second time here (there is
  # no exported assert for the outer envelope shape to call instead -- only
  # the constructor, New-E1GuestBundleInvocationResult, and it is not
  # exported either). A call to Assert-E1GuestBundleResultShape on the
  # OUTER envelope here would always fail (wrong key set) regardless of
  # whether the underlying call actually succeeded -- confirmed by real
  # Pester execution before this comment was written.
  return $response.result
}

Export-ModuleMember -Function Invoke-E1GuestBundle

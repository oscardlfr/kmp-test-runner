# evidence1-network-backend-queue-client.psm1
#
# Non-elevated network.inspect / network.ensure_mode caller (ADR-S1),
# dispatched through the elevated broker's queue instead of importing/
# calling evidence1-network-backend-hyperv.psm1 in-process -- see
# evidence1-vm-state-queue-client.psm1's header for the full pattern this
# module repeats.
#
# Translation rule (see evidence1-broker-capability-dispatch-core.psm1):
# response.result is $null iff the underlying function threw; non-null
# whenever it returned normally. evidence1-network-backend-hyperv.psm1's
# Invoke-E1NetworkEnsureMode sometimes returns a FAIL-shaped
# New-E1NetworkModeResult on purpose (its own fail-closed handling) rather
# than throwing -- "null result -> re-throw; non-null result -> return
# as-is" reproduces that distinction correctly with no capability-specific
# branch: a fail-closed FAIL-shaped result is non-null and is returned
# as-is, exactly matching what a direct in-process call would have returned.
#
# DRAFTED, NEVER EXECUTED CODE -- same standing notice as every -hyperv.psm1
# sibling.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-network-backend-contract.psm1') -Force -DisableNameChecking -Global
Import-Module (Join-Path $PSScriptRoot 'evidence1-broker-capability-client.psm1') -Force -DisableNameChecking -Global

function Get-E1NetworkState {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$GuestCredentialPath,
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
  if ([string]::IsNullOrWhiteSpace($QueueRoot)) { throw 'network_backend_queue_client_queue_root_required' }
  if ($null -eq $TriggerTask) { throw 'network_backend_queue_client_trigger_task_required' }
  $arguments = [ordered]@{ VMName = $VMName; GuestCredentialPath = $GuestCredentialPath }
  $response = Submit-E1BrokerCapabilityOperation -Capability 'network.inspect' -Arguments $arguments `
    -QueueRoot $QueueRoot -AllowedRoot $AllowedRoot -TaskName $TaskName -TimeoutMinutes $TimeoutMinutes `
    -PollIntervalSeconds $PollIntervalSeconds -TriggerTask $TriggerTask -GetUtcNow $GetUtcNow
  if ($null -eq $response.result) { throw ([string]$response.reason_code) }
  Assert-E1NetworkModeResult $response.result
  return $response.result
}

function Invoke-E1NetworkEnsureMode {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$GuestCredentialPath,
    [Parameter(Mandatory)][string]$TargetMode,
    [string]$QueueRoot = '',
    [string]$AllowedRoot = '',
    [string]$TaskName = (Get-E1BrokerCapabilityDefaultTaskName),
    [int]$TimeoutMinutes = 120,
    [int]$PollIntervalSeconds = 2,
    [scriptblock]$TriggerTask = $null,
    [scriptblock]$GetUtcNow = { [DateTime]::UtcNow }
  )
  if ([string]::IsNullOrWhiteSpace($QueueRoot)) { throw 'network_backend_queue_client_queue_root_required' }
  if ($null -eq $TriggerTask) { throw 'network_backend_queue_client_trigger_task_required' }
  $arguments = [ordered]@{ VMName = $VMName; GuestCredentialPath = $GuestCredentialPath; TargetMode = $TargetMode }
  $response = Submit-E1BrokerCapabilityOperation -Capability 'network.ensure_mode' -Arguments $arguments `
    -QueueRoot $QueueRoot -AllowedRoot $AllowedRoot -TaskName $TaskName -TimeoutMinutes $TimeoutMinutes `
    -PollIntervalSeconds $PollIntervalSeconds -TriggerTask $TriggerTask -GetUtcNow $GetUtcNow
  if ($null -eq $response.result) { throw ([string]$response.reason_code) }
  Assert-E1NetworkModeResult $response.result
  return $response.result
}

Export-ModuleMember -Function Get-E1NetworkState, Invoke-E1NetworkEnsureMode

# evidence1-vm-state-queue-client.psm1
#
# Non-elevated vm.inspect / vm.ensure_state caller (ADR-S1), dispatched
# through the elevated broker's queue (evidence1-broker-capability-client.psm1
# -> evidence1-host-broker-capability-dispatch.ps1 ->
# evidence1-broker-capability-dispatch-core.psm1 ->
# evidence1-vm-state-hyperv.psm1) instead of importing/calling
# evidence1-vm-state-hyperv.psm1 in-process. This is the module
# evidence1-run.ps1 imports under -UseRealBackends now, in
# evidence1-vm-state-hyperv.psm1's place -- see that file's own header for
# why direct in-process calls were the gap this round closes.
#
# Exports the SAME two function names, with the SAME parameter shapes, as
# both evidence1-vm-state-hyperv.psm1 and evidence1-vm-state-fake.psm1 --
# evidence1-run.ps1's handler bodies (Invoke-E1RunVmReadyState,
# Invoke-E1RunClosedState) need zero changes beyond which sibling module
# gets imported, exactly the same parity property every other fake/hyperv
# pair in this repo already has (confirmed for this trio too, see this
# round's Pester coverage).
#
# Translation rule from a capability response back to this capability's own
# result shape (see evidence1-broker-capability-dispatch-core.psm1's own
# contract: response.result is $null if-and-only-if the underlying function
# call THREW; non-null whenever it returned normally, regardless of that
# returned value's own nested verdict):
#   - Get-E1VmState:        hyperv throws for an identity mismatch, but
#                            returns a FAIL-shaped result for an unrecognized
#                            power state -- both are covered correctly by
#                            "null result -> re-throw; non-null result ->
#                            return as-is", with no capability-specific
#                            branch needed here.
#   - Invoke-E1VmEnsureState: hyperv NEVER returns a FAIL-shaped result (see
#                            that module's own header: it deliberately does
#                            NOT auto-recover on a hop failure) -- it always
#                            either returns PASS or throws. The same rule
#                            reproduces that exactly: result is non-null only
#                            on the PASS path.
# DRAFTED, NEVER EXECUTED CODE -- same standing notice as every -hyperv.psm1
# sibling; Submit-E1BrokerCapabilityOperation's own real trigger
# (schtasks.exe /Run) is never invoked by anything in this engagement.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-vm-state-contract.psm1') -Force -DisableNameChecking -Global
Import-Module (Join-Path $PSScriptRoot 'evidence1-broker-capability-client.psm1') -Force -DisableNameChecking -Global

# Every Submit-E1BrokerCapabilityOperation optional parameter
# (-QueueRoot/-AllowedRoot/-TaskName/-TimeoutMinutes/-PollIntervalSeconds/
# -TriggerTask/-GetUtcNow) is exposed here too, forwarded as-is -- this lets
# a test inject a fake -TriggerTask/-GetUtcNow through the SAME public
# surface evidence1-run.ps1 itself calls, without this module hardcoding
# anything the client doesn't already default sanely.
function Get-E1VmState {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [string]$ExpectedVMId = $null,
    # No real-infrastructure default -- see evidence1-broker-capability-client.psm1's
    # own header for why this is an explicit empty default + guard-clause
    # throw below, never [Parameter(Mandatory)] (which prompts, and hangs,
    # in a non-interactive host instead of failing immediately).
    [string]$QueueRoot = '',
    [string]$AllowedRoot = '',
    [string]$TaskName = (Get-E1BrokerCapabilityDefaultTaskName),
    [int]$TimeoutMinutes = 120,
    [int]$PollIntervalSeconds = 2,
    [scriptblock]$TriggerTask = $null,
    [scriptblock]$GetUtcNow = { [DateTime]::UtcNow }
  )
  if ([string]::IsNullOrWhiteSpace($QueueRoot)) { throw 'vm_state_queue_client_queue_root_required' }
  if ($null -eq $TriggerTask) { throw 'vm_state_queue_client_trigger_task_required' }
  $arguments = [ordered]@{ VMName = $VMName; ExpectedVMId = [string]$ExpectedVMId }
  $response = Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' -Arguments $arguments `
    -QueueRoot $QueueRoot -AllowedRoot $AllowedRoot -TaskName $TaskName -TimeoutMinutes $TimeoutMinutes `
    -PollIntervalSeconds $PollIntervalSeconds -TriggerTask $TriggerTask -GetUtcNow $GetUtcNow
  if ($null -eq $response.result) { throw ([string]$response.reason_code) }
  Assert-E1VmStateResult $response.result
  return $response.result
}

function Invoke-E1VmEnsureState {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$ExpectedVMId,
    [Parameter(Mandatory)][string]$TargetState,
    [int]$StopTimeoutSeconds = 180,
    [int]$StartTimeoutSeconds = 120,
    [string]$QueueRoot = '',
    [string]$AllowedRoot = '',
    [string]$TaskName = (Get-E1BrokerCapabilityDefaultTaskName),
    [int]$TimeoutMinutes = 120,
    [int]$PollIntervalSeconds = 2,
    [scriptblock]$TriggerTask = $null,
    [scriptblock]$GetUtcNow = { [DateTime]::UtcNow }
  )
  if ([string]::IsNullOrWhiteSpace($QueueRoot)) { throw 'vm_state_queue_client_queue_root_required' }
  if ($null -eq $TriggerTask) { throw 'vm_state_queue_client_trigger_task_required' }
  $arguments = [ordered]@{
    VMName              = $VMName
    ExpectedVMId        = $ExpectedVMId
    TargetState         = $TargetState
    StopTimeoutSeconds  = $StopTimeoutSeconds
    StartTimeoutSeconds = $StartTimeoutSeconds
  }
  $response = Submit-E1BrokerCapabilityOperation -Capability 'vm.ensure_state' -Arguments $arguments `
    -QueueRoot $QueueRoot -AllowedRoot $AllowedRoot -TaskName $TaskName -TimeoutMinutes $TimeoutMinutes `
    -PollIntervalSeconds $PollIntervalSeconds -TriggerTask $TriggerTask -GetUtcNow $GetUtcNow
  if ($null -eq $response.result) { throw ([string]$response.reason_code) }
  Assert-E1VmStateResult $response.result
  return $response.result
}

Export-ModuleMember -Function Get-E1VmState, Invoke-E1VmEnsureState

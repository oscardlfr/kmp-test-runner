# evidence1-vm-state-hyperv.psm1
#
# Production vm.inspect / vm.ensure_state (ADR-S1). No PowerShell Direct, no guest
# credential -- everything here is host-side Hyper-V cmdlets only
# (Get-VM/Get-VMIntegrationService/Get-VMHardDiskDrive/Get-VHD/Start-VM/Stop-VM).
#
# DRAFTED, NEVER EXECUTED CODE -- see evidence1-network-backend-hyperv.psm1 and
# evidence1-guest-bundle-hyperv.psm1's identical notice.
#
# The Off-ensuring direction is a direct, evidenced port: every read script that
# stops the VM (evidence1-hyperv-stop-for-final-codex-auth-capture.ps1, and
# evidence1-hyperv-copy-live-artifacts.ps1's own optional -GracefulShutdown path)
# uses the identical Stop-VM -AsJob + Wait-Job -Timeout pattern with NO hard-power
# fallback -- a timeout throws, it never escalates to -TurnOff or -Force. That
# matches the plan's own evidence1-hyperv-live-state-machine-adr.md invariant table
# ("No hard power cut in normal flow"). The Running-ensuring direction has NO
# clean existing model to port: the one Start-VM call I found
# (evidence1-hyperv-start-final-codex.ps1 line 108) is a single ungated line
# buried inside ~150 lines of campaign-evidence validation, with no timeout and no
# re-verification that the VM actually reached Running before the script moves on.
# I designed that half fresh rather than porting a weak example, using the same
# "always re-verify via a fresh read, never trust the mutation succeeded" discipline
# as the Off direction and as Phase 2's NetworkBackend -- see the architecture
# note's PASS-criteria table for what that means for confidence level.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-vm-state-contract.psm1') -Force -DisableNameChecking -Global

$script:E1VmDefaultStopTimeoutSeconds = 180
$script:E1VmDefaultStartTimeoutSeconds = 120

# READ-ONLY. Ported from evidence1-hyperv-inspect-vm-boot-state.ps1's own report
# shape almost verbatim -- that script was already a clean vm.inspect in
# miniature. Never calls Start-VM/Stop-VM.
function Get-E1VmState {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [string]$ExpectedVMId = $null
  )
  $vm = Get-VM -Name $VMName -ErrorAction Stop
  $vmId = ([string]$vm.Id).ToLowerInvariant()
  if ($ExpectedVMId -and $vmId -cne $ExpectedVMId.ToLowerInvariant()) { throw 'vm_state_identity_mismatch' }

  $services = @(Get-VMIntegrationService -VMName $VMName -ErrorAction SilentlyContinue | ForEach-Object {
    [ordered]@{
      name             = [string]$_.Name
      enabled          = [bool]$_.Enabled
      primary_status   = [string]$_.PrimaryStatusDescription
      secondary_status = [string]$_.SecondaryStatusDescription
    }
  })
  $vhdAttached = $false
  try {
    $diskPath = (Get-VMHardDiskDrive -VMName $VMName -ErrorAction Stop | Select-Object -First 1).Path
    if ($diskPath) { $vhdAttached = [bool](Get-VHD -Path $diskPath -ErrorAction Stop).Attached }
  } catch {
    # No disk, or the disk couldn't be queried -- vhd_attached stays false rather
    # than failing the whole inspection over a secondary fact.
  }

  $state = [string]$vm.State
  if ($state -cnotin (Get-E1VmStateNames)) {
    # Hyper-V has more power states than this capability's two (Paused, Saved,
    # Starting, Stopping, ...). None appeared in any read script -- this is a
    # disposable eval VM that is only ever Off or Running by design (see the
    # architecture note) -- but report it honestly as FAIL rather than forcing
    # an unrecognized live state into the two-value enum.
    return New-E1VmStateResult -VMName $VMName -VMId $vmId -State 'Off' -Status $state `
      -UptimeSeconds 0 -MemoryAssignedBytes 0 -ProcessorLoadPercent 0 -VhdAttached $vhdAttached `
      -IntegrationServices $services -Verdict 'FAIL' -ReasonCode "vm_state_unrecognized: $state"
  }

  return New-E1VmStateResult -VMName $VMName -VMId $vmId -State $state -Status ([string]$vm.Status) `
    -UptimeSeconds ([math]::Round($vm.Uptime.TotalSeconds, 3)) -MemoryAssignedBytes ([int64]$vm.MemoryAssigned) `
    -ProcessorLoadPercent ([int]$vm.CPUUsage) -VhdAttached $vhdAttached -IntegrationServices $services
}

# One hop: Off -> Running (Start-VM, then poll for Running) or Running -> Off
# (Stop-VM -AsJob + Wait-Job -Timeout, no hard-power fallback -- see the module
# header). Both directions re-verify via a fresh Get-E1VmState before returning.
function Invoke-E1VmHop([string]$VMName, [string]$ExpectedVMId, [string]$ToState, [int]$TimeoutSeconds) {
  if ($ToState -ceq 'Off') {
    $vm = Get-VM -Name $VMName -ErrorAction Stop
    if ([string]$vm.State -cne 'Off') {
      $job = Stop-VM -Name $VMName -Confirm:$false -AsJob -ErrorAction Stop
      try {
        if (-not (Wait-Job -Job $job -Timeout $TimeoutSeconds)) {
          throw 'vm_state_stop_timeout_no_hard_power_fallback'
        }
        Receive-Job -Job $job -ErrorAction Stop | Out-Null
      } finally {
        Stop-Job -Job $job -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
      }
    }
  } else {
    $vm = Get-VM -Name $VMName -ErrorAction Stop
    if ([string]$vm.State -cne 'Running') {
      Start-VM -Name $VMName -ErrorAction Stop
      $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
      $reached = $false
      while ((Get-Date) -lt $deadline) {
        if ([string](Get-VM -Name $VMName -ErrorAction Stop).State -ceq 'Running') { $reached = $true; break }
        Start-Sleep -Seconds 2
      }
      if (-not $reached) { throw 'vm_state_start_timeout' }
    }
  }

  $observed = Get-E1VmState -VMName $VMName -ExpectedVMId $ExpectedVMId
  if ([string]$observed.state -cne $ToState -or [string]$observed.verdict -cne 'PASS') {
    throw "vm_state_hop_verification_failed: expected $ToState observed $([string]$observed.state)"
  }
  return $observed
}

# PUBLIC. Inspects current state, computes the hop path via the shared contract
# graph, and mutates + re-verifies one hop at a time -- same idempotent,
# never-trust-prior-state shape as Phase 2's Invoke-E1NetworkEnsureMode.
#
# Deliberately does NOT attempt any fail-closed auto-recovery on a hop failure
# the way Invoke-E1NetworkEnsureMode does (which retreats to 'offline' and
# reports FAIL). For network state that's safe and correct -- locking down
# guest egress on failure is safety-positive with no campaign-state cost. For
# VM power state it is not: the plan's own live-state-machine ADR
# (evidence1-hyperv-live-state-machine-adr.md) is explicit that a failure
# "leaves a privacy-safe handoff record with the last phase" and that
# "operators must not rerun automatically," and that a hard shutdown is
# "an explicit incident response... never an automatic continuation of the
# live workflow." Auto-intervening here (forcing a stop after a failed start,
# or restarting after a failed stop) risks exactly the automatic retry/
# replacement/respawn the plan's budget table fixes at zero. On failure this
# throws and leaves the VM exactly as the failure left it, for the operator to
# inspect -- a deliberate difference from NetworkBackend, not an omission.
function Invoke-E1VmEnsureState {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$ExpectedVMId,
    [Parameter(Mandatory)][string]$TargetState,
    [int]$StopTimeoutSeconds = $script:E1VmDefaultStopTimeoutSeconds,
    [int]$StartTimeoutSeconds = $script:E1VmDefaultStartTimeoutSeconds
  )
  $current = Get-E1VmState -VMName $VMName -ExpectedVMId $ExpectedVMId
  if ([string]$current.verdict -cne 'PASS') { throw "vm_state_ensure_precondition_failed: $($current.reason_code)" }

  $path = @(Get-E1VmTransitionPath -From ([string]$current.state) -To $TargetState)
  if ($path.Count -eq 1) { return Get-E1VmState -VMName $VMName -ExpectedVMId $ExpectedVMId }

  $result = $null
  for ($hopIndex = 1; $hopIndex -lt $path.Count; $hopIndex++) {
    $hopState = [string]$path[$hopIndex]
    $timeout = if ($hopState -ceq 'Off') { $StopTimeoutSeconds } else { $StartTimeoutSeconds }
    $result = Invoke-E1VmHop -VMName $VMName -ExpectedVMId $ExpectedVMId -ToState $hopState -TimeoutSeconds $timeout
  }
  return $result
}

Export-ModuleMember -Function Get-E1VmState, Invoke-E1VmEnsureState

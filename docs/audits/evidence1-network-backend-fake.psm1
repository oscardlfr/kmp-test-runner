# evidence1-network-backend-fake.psm1
#
# ADR-S4's deterministic NetworkBackend test double. Exports the exact same function
# names as evidence1-network-backend-hyperv.psm1 (Get-E1NetworkState,
# Invoke-E1NetworkEnsureMode) so a caller written against one behaves identically
# against the other -- see docs/audits/evidence1-phase2-architecture-note.md section 5.
# Zero VM, adapter, firewall, or network I/O of any kind. State lives only in this
# module's own in-memory table for the lifetime of the importing process; nothing
# persists across sessions, which is deliberate for a deterministic fake.
#
# Not meant to be imported into the same session as evidence1-network-backend-hyperv.psm1
# (both export the same names; the second Import-Module would win). A caller/test
# picks one.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-network-backend-contract.psm1') -Force -DisableNameChecking -Global

$script:E1FakeNetworkStates = @{}

# Test setup only -- a real backend has no equivalent, because a real VM's starting
# mode is whatever Hyper-V and the guest firewall already show, not something a test
# seeds. Must be called for a VM name before Get-E1NetworkState/Invoke-E1NetworkEnsureMode
# will recognize it, which is deliberate: an unseeded VM name is a test-authoring bug,
# not a state this fake should silently default.
function Set-E1FakeNetworkInitialMode {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$Mode,
    [string]$VMId = ([guid]::NewGuid().ToString())
  )
  $result = New-E1FakeNetworkResultForMode -VMName $VMName -VMId $VMId -Mode $Mode
  $script:E1FakeNetworkStates[$VMName] = $result
  return $result
}

function Reset-E1FakeNetworkState {
  [CmdletBinding()]
  param([string]$VMName)
  if ($VMName) {
    $null = $script:E1FakeNetworkStates.Remove($VMName)
  } else {
    $script:E1FakeNetworkStates = @{}
  }
}

# Builds the exact physical shape ADR-S3 requires for a mode (same values
# evidence1-network-backend-hyperv.psm1's per-mode mutators aim to actually produce
# on real hardware), via the shared New-E1NetworkModeResult constructor so both
# implementations' results pass the same Assert-E1NetworkModeResult check.
function New-E1FakeNetworkResultForMode {
  param([Parameter(Mandatory)][string]$VMName, [Parameter(Mandatory)][string]$VMId, [Parameter(Mandatory)][string]$Mode)
  switch ($Mode) {
    'offline' {
      return New-E1NetworkModeResult -Mode $Mode -VMName $VMName -VMId $VMId `
        -AdapterConnected $false -SwitchName $null -FirewallDefaultOutbound 'Block' `
        -PinnedHosts @() -WatchdogArmed $false -WatchdogExpiresAtUtc $null
    }
    'auth-open' {
      $expiresAtUtc = (Get-Date).ToUniversalTime().AddMinutes(15).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      return New-E1NetworkModeResult -Mode $Mode -VMName $VMName -VMId $VMId `
        -AdapterConnected $true -SwitchName 'Default Switch' -FirewallDefaultOutbound 'Allow' `
        -PinnedHosts @() -WatchdogArmed $true -WatchdogExpiresAtUtc $expiresAtUtc
    }
    'restricted' {
      return New-E1NetworkModeResult -Mode $Mode -VMName $VMName -VMId $VMId `
        -AdapterConnected $true -SwitchName 'Default Switch' -FirewallDefaultOutbound 'Block' `
        -PinnedHosts @('api.anthropic.com', 'claude.ai', 'auth.openai.com', 'chatgpt.com') `
        -WatchdogArmed $false -WatchdogExpiresAtUtc $null
    }
    default { throw "network_mode_name_invalid: $Mode" }
  }
}

# -GuestCredentialPath is accepted-and-ignored, not omitted, so a caller written
# against this fake needs no different argument set than one written against
# evidence1-network-backend-hyperv.psm1 -- true signature parity, matching how
# evidence1-guest-bundle-fake.psm1 already accepts-and-ignores the same parameter
# for the same reason. An earlier draft of this fake omitted the parameter
# entirely; that was a real signature mismatch (found and fixed Phase 3c) that
# forced evidence1-run.ps1 to special-case which backend it was calling.
#
# [AllowEmptyString()]: a Mandatory [string] parameter rejects an empty-string
# argument by default (Mandatory only guarantees non-null/present, not
# non-empty) -- confirmed empirically when evidence1-run.ps1's own fake-mode
# call (Invoke-E1RunRestrictedReadyState passes -GuestCredentialPath
# $Context.GuestCredentialPath, which is '' whenever -UseRealBackends is not
# set) failed parameter binding against this function without it. '' is a
# legitimate, meaningful value here specifically: the fake never reads
# GuestCredentialPath at all, so there is no real path to require. The hyperv
# implementation deliberately does NOT get the same attribute -- there, an
# empty path is a genuine caller bug (Assert-E1NetworkGuestCredentialPath
# would fail it at Test-Path regardless), worth rejecting as early as
# possible via parameter binding rather than one step later.
function Get-E1NetworkState {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][AllowEmptyString()][string]$GuestCredentialPath
  )
  if (-not $script:E1FakeNetworkStates.ContainsKey($VMName)) {
    throw "fake_network_vm_not_seeded: $VMName (call Set-E1FakeNetworkInitialMode first)"
  }
  $current = $script:E1FakeNetworkStates[$VMName]
  Assert-E1NetworkModeResult $current
  return $current
}

# Same contract as the Hyper-V implementation: inspect current mode, compute the
# required hop sequence via the shared transition graph, mutate one hop at a time,
# and re-verify after every hop (Assert-E1NetworkModeResult) rather than only at the
# end -- exercising a caller against this fake proves it correctly drives ensure_mode
# through every intermediate mode of a multi-hop transition, not just the final one.
function Invoke-E1NetworkEnsureMode {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][AllowEmptyString()][string]$GuestCredentialPath,
    [Parameter(Mandatory)][string]$TargetMode
  )
  $current = Get-E1NetworkState -VMName $VMName -GuestCredentialPath $GuestCredentialPath
  $path = @(Get-E1NetworkTransitionPath -From ([string]$current.mode) -To $TargetMode)

  if ($path.Count -eq 1) {
    # Already at the target mode -- idempotent no-op. Still re-verified below.
    $result = Get-E1NetworkState -VMName $VMName -GuestCredentialPath $GuestCredentialPath
  } else {
    for ($hopIndex = 1; $hopIndex -lt $path.Count; $hopIndex++) {
      $hopMode = [string]$path[$hopIndex]
      $result = New-E1FakeNetworkResultForMode -VMName $VMName -VMId ([string]$current.vm_id) -Mode $hopMode
      $script:E1FakeNetworkStates[$VMName] = $result
      Assert-E1NetworkModeResult $result
    }
  }
  return $result
}

Export-ModuleMember -Function `
  Set-E1FakeNetworkInitialMode, `
  Reset-E1FakeNetworkState, `
  Get-E1NetworkState, `
  Invoke-E1NetworkEnsureMode

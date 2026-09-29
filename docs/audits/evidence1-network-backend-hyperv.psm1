# evidence1-network-backend-hyperv.psm1
#
# Production NetworkBackend (ADR-S4): the same Get-E1NetworkState /
# Invoke-E1NetworkEnsureMode names evidence1-network-backend-fake.psm1 exports, backed
# by real Hyper-V adapter state and real guest firewall/hosts-file/watchdog state over
# PowerShell Direct. See docs/audits/evidence1-phase2-architecture-note.md sections
# 1-5 for what this ports from and why.
#
# This is DRAFTED, NEVER EXECUTED CODE -- see that architecture note's header. Every
# function below that mutates anything (Connect-/Disconnect-VMNetworkAdapter,
# Set-NetFirewallProfile, New-/Remove-NetFirewallRule, hosts-file writes,
# Register-/Unregister-ScheduledTask inside the guest) is real, working-if-run Hyper-V
# automation -- and it has not been run.
#
# The property this module exists to guarantee, closing the defect in section 2 of
# the architecture note: Invoke-E1NetworkEnsureMode NEVER trusts that a caller (or a
# prior caller) left the adapter/firewall in any particular state. It inspects via
# Get-E1NetworkState before every hop of a transition and re-verifies via the same
# function after every hop -- not only the last one. A caller can no longer skip the
# adapter check the way evidence1-hyperv-seal-final-codex-network.ps1 does today,
# because the check is not the caller's to skip.
#
# Requires -RunAsAdministrator is deliberately NOT declared here: this is a library
# module, not an entrypoint. Whatever script imports it owns that declaration, exactly
# as evidence1-vm-identity-contract.psm1 and evidence1-host-snapshot-contract.psm1
# (also plain, non-#Requires modules) are imported only by scripts that already
# declare it.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-network-backend-contract.psm1') -Force -DisableNameChecking -Global

# Restricted-mode pinned endpoints -- the union of evidence1-stageb-network-seal.ps1's
# $AllowedInferenceHosts (Claude + Codex, that script's current list) with nothing
# added or removed; a real reconciliation against that script's exact list belongs to
# the implementation phase, not this draft.
$script:E1RestrictedAllowedHosts = @(
  'api.anthropic.com', 'platform.claude.com', 'claude.ai', 'claude.com',
  'auth.openai.com', 'chatgpt.com', 'ab.chatgpt.com'
)
$script:E1FirewallRulePrefix = 'Evidence1 NetworkBackend'
$script:E1HostsMarker = '# Evidence1 NetworkBackend pinned host'
# One watchdog name for auth-open regardless of which provider's auth window is
# open -- collapsing evidence1-hyperv-open-temporary-auth-egress.ps1's
# Evidence1AuthEgressExpiry and evidence1-hyperv-open-codex-auth-window-direct.ps1's
# Evidence1CodexAuthEgressExpiry into the one duplicated-logic problem the
# architecture note (section 4) says this interface should fix.
$script:E1AuthWatchdogTaskName = 'Evidence1NetworkBackendAuthEgressExpiry'
$script:E1DefaultAuthWindowMinutes = 15

function Resolve-E1NetworkFullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-E1NetworkGuestCredentialPath([string]$Path) {
  $full = Resolve-E1NetworkFullPath $Path
  $rootFull = (Resolve-E1NetworkFullPath 'C:\kmp-eval\scratch\').TrimEnd('\') + '\'
  if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'network_backend_guest_credential_path_outside_scratch'
  }
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
    throw 'network_backend_guest_credential_missing'
  }
  return $full
}

# READ-ONLY. Get-VMNetworkAdapter never mutates anything; this function must never
# grow a call to Connect-/Disconnect-VMNetworkAdapter.
function Get-E1NetworkHyperVAdapterState($VM) {
  $adapters = @(Get-VMNetworkAdapter -VM $VM)
  if ($adapters.Count -ne 1) { throw 'network_backend_adapter_count_unexpected' }
  $adapter = $adapters[0]
  $switchName = [string]$adapter.SwitchName
  return [ordered]@{
    connected   = [bool]$adapter.Connected -and -not [string]::IsNullOrWhiteSpace($switchName)
    switch_name = if ([string]::IsNullOrWhiteSpace($switchName)) { $null } else { $switchName }
  }
}

# Every value the guest scriptblock needs travels through -ArgumentList and a
# matching param() block inside the scriptblock -- never $using:, which resolves
# against the scope the scriptblock literal was WRITTEN in and behaves unreliably
# once a scriptblock is built in one function and invoked from another, which is
# exactly this module's shape (guest scriptblocks are module-level private
# functions, invoked through this shared transport helper). Tries the same
# candidate logon-name forms every existing script in this family tries (see
# docs/audits/evidence1-phase2-architecture-note.md section 1), in the same order.
#
# Bounded execution (Phase 3c, maintainer-answered open question 4): runs the
# guest scriptblock via Invoke-Command -AsJob + Wait-Job -Timeout, with
# Stop-Job/Remove-Job cleanup in a finally block, instead of the previous
# unbounded synchronous Invoke-Command call -- matching
# evidence1-guest-bundle-hyperv.psm1's Invoke-E1GuestBundle, which already had
# this and was this fix's model, copied not reinvented. A hung guest call used
# to hang this function (and therefore Get-E1NetworkState/Invoke-E1NetworkEnsureMode)
# indefinitely; now it throws the stable, dynamic-content-free
# 'network_backend_guest_transport_timeout' after -TimeoutSeconds and the job is
# cancelled (Stop-Job) rather than left running server-side. Non-timeout failures
# keep the previous "network_backend_guest_transport_failed: <dynamic detail>"
# shape -- only the timeout case is newly stable/parseable on its own, which is
# the specific gap the maintainer's answer named.
function Invoke-E1NetworkHyperVGuestCommand($VM, [string]$GuestCredentialPath, [scriptblock]$ScriptBlock, [object[]]$ArgumentList, [int]$TimeoutSeconds = 60) {
  if ($TimeoutSeconds -lt 5 -or $TimeoutSeconds -gt 600) { throw 'network_backend_guest_transport_timeout_out_of_range' }
  $stored = Import-Clixml -LiteralPath $GuestCredentialPath
  $simple = [string]$stored.UserName
  $candidates = @("$($VM.Name)\$simple", ".\$simple", $simple, "localhost\$simple")
  $lastFailureReason = 'network_backend_guest_transport_no_candidate_logon_name_attempted'
  foreach ($logon in $candidates) {
    $session = $null
    $job = $null
    try {
      $credential = [pscredential]::new($logon, $stored.Password)
      $session = New-PSSession -VMName $VM.Name -Credential $credential -ErrorAction Stop
      $job = Invoke-Command -Session $session -ScriptBlock $ScriptBlock -ArgumentList $ArgumentList -AsJob
      $completed = Wait-Job -Job $job -Timeout $TimeoutSeconds
      if (-not $completed) {
        $lastFailureReason = 'network_backend_guest_transport_timeout'
        continue
      }
      return Receive-Job -Job $job -ErrorAction Stop
    } catch {
      $lastFailureReason = "network_backend_guest_transport_failed: $($_.Exception.Message)"
    } finally {
      # Each cleanup call is its own try/catch, not just -ErrorAction
      # SilentlyContinue: -ErrorAction only suppresses errors a cmdlet's own
      # engine writes to the error stream, never a parameter-BINDING failure
      # (e.g. $job/$session holding something that can't bind to a cmdlet's
      # typed parameter) -- that kind of exception is terminating and
      # bypasses -ErrorAction entirely, and unlike a catch on the outer try,
      # an exception raised inside finally is not caught by the catch block
      # that precedes it in the same statement. Confirmed empirically:
      # Remove-PSSession -Session <value not assignable to PSSession[]>
      # throws straight through -ErrorAction SilentlyContinue. Cleanup must
      # never be able to replace or mask whatever error is already
      # propagating.
      if ($job) {
        try { Stop-Job -Job $job -ErrorAction SilentlyContinue } catch { }
        try { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue } catch { }
      }
      if ($session) {
        try { Remove-PSSession -Session $session -ErrorAction SilentlyContinue } catch { }
      }
    }
  }
  throw $lastFailureReason
}

# READ-ONLY guest probe. Reads Get-NetFirewallProfile and counts hosts-file lines
# carrying this module's own marker; never calls Set-NetFirewallProfile, New-/
# Remove-NetFirewallRule, or writes the hosts file. Watchdog presence is read via
# Get-ScheduledTask only.
function Get-E1NetworkHyperVGuestFirewallState($VM, [string]$GuestCredentialPath) {
  $raw = Invoke-E1NetworkHyperVGuestCommand $VM $GuestCredentialPath {
    param($HostsMarker, $WatchdogTaskName)
    $ErrorActionPreference = 'Stop'
    $profiles = @(Get-NetFirewallProfile -Profile Domain, Private, Public)
    $blocked = $profiles.Count -eq 3 -and @($profiles | Where-Object {
      $_.Enabled.ToString() -ne 'True' -or $_.DefaultOutboundAction.ToString() -ne 'Block'
    }).Count -eq 0
    $allowed = $profiles.Count -eq 3 -and @($profiles | Where-Object {
      $_.Enabled.ToString() -ne 'True' -or $_.DefaultOutboundAction.ToString() -ne 'Allow'
    }).Count -eq 0
    $hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    $pinnedLines = @(Get-Content -LiteralPath $hostsPath -ErrorAction SilentlyContinue |
      Where-Object { $_ -match [regex]::Escape($HostsMarker) })
    $watchdog = Get-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction SilentlyContinue
    $watchdogInfo = if ($watchdog) { $watchdog | Get-ScheduledTaskInfo } else { $null }
    [ordered]@{
      default_outbound   = if ($blocked) { 'Block' } elseif ($allowed) { 'Allow' } else { 'Mixed' }
      pinned_host_count  = $pinnedLines.Count
      watchdog_present   = $null -ne $watchdog
      watchdog_next_run  = if ($watchdogInfo) { $watchdogInfo.NextRunTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } else { $null }
    }
  } -ArgumentList @($script:E1HostsMarker, $script:E1AuthWatchdogTaskName)
  return $raw
}

# Full read-only inspection: PUBLIC. Never mutates the adapter or the guest.
function Get-E1NetworkState {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$GuestCredentialPath
  )
  $credentialFull = Assert-E1NetworkGuestCredentialPath $GuestCredentialPath
  $vm = Get-VM -Name $VMName -ErrorAction Stop
  $vmId = ([string]$vm.Id).ToLowerInvariant()
  $adapterState = Get-E1NetworkHyperVAdapterState $vm

  if (-not $adapterState.connected) {
    # Disconnected adapter: PowerShell Direct still works (VMBus, not the virtual
    # NIC), so the guest firewall could in principle still be probed here -- but an
    # adapter-disconnected VM reporting an "Allow" or pinned-host guest firewall
    # would itself be a contract violation (auth-open/restricted both require the
    # adapter connected). Report offline directly rather than spending a guest
    # round trip to confirm a state the adapter alone already rules the other two
    # modes out for.
    return New-E1NetworkModeResult -Mode 'offline' -VMName $VMName -VMId $vmId `
      -AdapterConnected $false -SwitchName $null -FirewallDefaultOutbound 'Block' `
      -PinnedHosts @() -WatchdogArmed $false -WatchdogExpiresAtUtc $null
  }

  $guestState = Get-E1NetworkHyperVGuestFirewallState $vm $credentialFull
  if ([string]$guestState.default_outbound -ceq 'Allow') {
    $watchdogExpiry = [string]$guestState.watchdog_next_run
    return New-E1NetworkModeResult -Mode 'auth-open' -VMName $VMName -VMId $vmId `
      -AdapterConnected $true -SwitchName $adapterState.switch_name -FirewallDefaultOutbound 'Allow' `
      -PinnedHosts @() -WatchdogArmed ([bool]$guestState.watchdog_present) -WatchdogExpiresAtUtc $watchdogExpiry
  }
  if ([string]$guestState.default_outbound -ceq 'Block' -and [int]$guestState.pinned_host_count -gt 0) {
    return New-E1NetworkModeResult -Mode 'restricted' -VMName $VMName -VMId $vmId `
      -AdapterConnected $true -SwitchName $adapterState.switch_name -FirewallDefaultOutbound 'Block' `
      -PinnedHosts @($script:E1RestrictedAllowedHosts) -WatchdogArmed $false -WatchdogExpiresAtUtc $null
  }
  # Connected adapter but neither a recognized auth-open nor restricted firewall
  # shape (e.g. mid-transition, or a 'Mixed' profile state) -- fail closed and
  # honest rather than guessing a mode.
  $fallbackOutbound = if ([string]$guestState.default_outbound -ceq 'Allow') { 'Allow' } else { 'Block' }
  return New-E1NetworkModeResult -Mode 'offline' -VMName $VMName -VMId $vmId `
    -AdapterConnected $true -SwitchName $adapterState.switch_name -FirewallDefaultOutbound $fallbackOutbound `
    -PinnedHosts @() -WatchdogArmed ([bool]$guestState.watchdog_present) -WatchdogExpiresAtUtc $null `
    -Verdict 'FAIL' -ReasonCode 'network_backend_state_unrecognized'
}

# Host-side adapter mutation -- the one piece of this module that is not a guest
# PowerShell Direct call. Ported from evidence1-hyperv-run-network-seal-direct.ps1
# lines 91-103 (the connect side) and its cleanup finally block (the disconnect
# side), ported into one idempotent function instead of scattered across callers.
function Set-E1NetworkHyperVAdapterConnected($VM, [bool]$Connected) {
  $adapters = @(Get-VMNetworkAdapter -VM $VM)
  if ($adapters.Count -ne 1) { throw 'network_backend_adapter_count_unexpected' }
  $adapter = $adapters[0]
  if ($Connected) {
    if (-not $adapter.Connected -or [string]::IsNullOrWhiteSpace([string]$adapter.SwitchName)) {
      Connect-VMNetworkAdapter -VMNetworkAdapter $adapter -SwitchName 'Default Switch' -Confirm:$false
      Start-Sleep -Seconds 5
    }
  } else {
    if ($adapter.Connected) {
      Disconnect-VMNetworkAdapter -VMNetworkAdapter $adapter -Confirm:$false
    }
  }
  $after = Get-E1NetworkHyperVAdapterState $VM
  if ($Connected -and (-not $after.connected -or $after.switch_name -cne 'Default Switch')) {
    throw 'network_backend_adapter_connect_failed'
  }
  if (-not $Connected -and $after.connected) {
    throw 'network_backend_adapter_disconnect_failed'
  }
}

# Guest-side mutation for the restricted mode. Ports evidence1-stageb-network-seal.ps1's
# open-resolve-pin-block-verify ordering exactly (see architecture note section 1):
# open outbound first, clear old pins, resolve DNS only once already open, pin
# resolved IPs to hosts + one allow rule per host, verify allowed hosts reachable
# while still open, THEN flip to default-block, then re-verify allowed hosts still
# reachable and a probe host is not.
function Invoke-E1NetworkHyperVGuestSealRestricted($VM, [string]$GuestCredentialPath) {
  $null = Invoke-E1NetworkHyperVGuestCommand $VM $GuestCredentialPath {
    param($AllowedHosts, $RulePrefix, $HostsMarker, $WatchdogTaskName)
    $ErrorActionPreference = 'Stop'
    Unregister-ScheduledTask -TaskName $WatchdogTaskName -Confirm:$false -ErrorAction SilentlyContinue

    Set-NetFirewallProfile -Profile Domain, Private, Public -Enabled True `
      -DefaultInboundAction Block -DefaultOutboundAction Allow
    Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue |
      Remove-NetFirewallRule -ErrorAction SilentlyContinue
    $hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    $kept = @(Get-Content -LiteralPath $hostsPath -ErrorAction Stop | Where-Object { $_ -notmatch [regex]::Escape($HostsMarker) })
    Set-Content -LiteralPath $hostsPath -Encoding ASCII -Value $kept
    Clear-DnsClientCache

    $resolvedByHost = [ordered]@{}
    foreach ($hostName in $AllowedHosts) {
      $resolved = @(Resolve-DnsName -Name $hostName -ErrorAction Stop |
        Where-Object { $_.Type -in @('A', 'AAAA') -and $_.IPAddress } | Select-Object -ExpandProperty IPAddress -Unique)
      if ($resolved.Count -eq 0) { throw "network_backend_resolve_failed: $hostName" }
      $resolvedByHost[$hostName] = $resolved
    }
    $hostsLines = @(Get-Content -LiteralPath $hostsPath -ErrorAction Stop)
    foreach ($hostName in $resolvedByHost.Keys) {
      $hostsLines += @($resolvedByHost[$hostName] | ForEach-Object { "$_ $hostName $HostsMarker" })
    }
    Set-Content -LiteralPath $hostsPath -Encoding ASCII -Value $hostsLines
    foreach ($hostName in $AllowedHosts) {
      New-NetFirewallRule -DisplayName "$RulePrefix allow $hostName HTTPS" -Direction Outbound `
        -Action Allow -Protocol TCP -RemotePort 443 -RemoteAddress $resolvedByHost[$hostName] | Out-Null
    }
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    foreach ($hostName in $AllowedHosts) {
      $ErrorActionPreference = 'Continue'
      & $curl -IsS --max-time 12 "https://$hostName" *> $null
      $ok = $LASTEXITCODE -eq 0
      $ErrorActionPreference = 'Stop'
      if (-not $ok) { throw "network_backend_preseal_probe_failed: $hostName" }
    }

    Set-NetFirewallProfile -Profile Domain, Private, Public -DefaultInboundAction Block -DefaultOutboundAction Block

    foreach ($hostName in $AllowedHosts) {
      $ErrorActionPreference = 'Continue'
      & $curl -IsS --max-time 12 "https://$hostName" *> $null
      $ok = $LASTEXITCODE -eq 0
      $ErrorActionPreference = 'Stop'
      if (-not $ok) { throw "network_backend_postseal_probe_failed: $hostName" }
    }
    # -TimeoutSeconds 240: this scriptblock runs up to 2 * AllowedHosts.Count curl
    # probes at --max-time 12 each (pre-seal and post-seal) -- with today's 7-host
    # list that is up to 168 seconds of probing alone, before DNS resolution and
    # firewall-rule churn. The shared 60-second default (right for the other three
    # guest calls in this file, all fast) would be a real regression here.
  } -ArgumentList @($script:E1RestrictedAllowedHosts, $script:E1FirewallRulePrefix, $script:E1HostsMarker, $script:E1AuthWatchdogTaskName) -TimeoutSeconds 240
}

# Guest-side mutation for auth-open. Ports the watchdog-arm / broad-allow / probe
# shape shared by evidence1-hyperv-open-temporary-auth-egress.ps1 and
# evidence1-hyperv-open-codex-auth-window-direct.ps1, collapsed into the one
# provider-agnostic implementation the architecture note (section 4/7) calls for.
# Provider-specific preconditions (e.g. the Codex canonical-toolchain hash/signature
# check) are deliberately NOT here -- those are a caller's precondition before
# calling ensure_mode('auth-open'), not a network-mode concern; see the open
# question in the architecture note.
function Invoke-E1NetworkHyperVGuestOpenAuthWindow($VM, [string]$GuestCredentialPath, [int]$WindowMinutes) {
  $null = Invoke-E1NetworkHyperVGuestCommand $VM $GuestCredentialPath {
    param($WindowMinutes, $WatchdogTaskName, $RulePrefix, $HostsMarker)
    $ErrorActionPreference = 'Stop'
    Unregister-ScheduledTask -TaskName $WatchdogTaskName -Confirm:$false -ErrorAction SilentlyContinue
    $emergencyCommand = @'
$ErrorActionPreference = 'Stop'
Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Block
$profiles = @(Get-NetFirewallProfile -Profile Domain,Private,Public)
$invalid = @($profiles | Where-Object { $_.Enabled.ToString() -ne 'True' -or $_.DefaultOutboundAction.ToString() -ne 'Block' }).Count
if ($profiles.Count -ne 3 -or $invalid -ne 0) { exit 1 }
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($emergencyCommand))
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
      -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes($WindowMinutes))
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName $WatchdogTaskName -Action $action -Trigger $trigger `
      -Principal $principal -Settings $settings -Force | Out-Null
    $watchdog = Get-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction Stop
    if ($watchdog.State.ToString() -notin @('Ready', 'Running')) { throw 'network_backend_watchdog_not_armed' }

    Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    $hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    $kept = @(Get-Content -LiteralPath $hostsPath -ErrorAction Stop | Where-Object { $_ -notmatch [regex]::Escape($HostsMarker) })
    Set-Content -LiteralPath $hostsPath -Encoding ASCII -Value $kept
    Set-NetFirewallProfile -Profile Domain, Private, Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Allow
    $profiles = @(Get-NetFirewallProfile -Profile Domain, Private, Public)
    $openCount = @($profiles | Where-Object { $_.Enabled.ToString() -eq 'True' -and $_.DefaultOutboundAction.ToString() -eq 'Allow' }).Count
    if ($profiles.Count -ne 3 -or $openCount -ne 3) { throw 'network_backend_firewall_open_failed' }
  } -ArgumentList @($WindowMinutes, $script:E1AuthWatchdogTaskName, $script:E1FirewallRulePrefix, $script:E1HostsMarker)
}

# Guest-side mutation for offline: disarm the watchdog, clear pinned rules and hosts
# entries, and default-block outbound. The host-side adapter is disconnected by the
# caller in Invoke-E1NetworkEnsureMode, not here.
function Invoke-E1NetworkHyperVGuestSealOffline($VM, [string]$GuestCredentialPath) {
  $null = Invoke-E1NetworkHyperVGuestCommand $VM $GuestCredentialPath {
    param($RulePrefix, $HostsMarker, $WatchdogTaskName)
    $ErrorActionPreference = 'Stop'
    Unregister-ScheduledTask -TaskName $WatchdogTaskName -Confirm:$false -ErrorAction SilentlyContinue
    Set-NetFirewallProfile -Profile Domain, Private, Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Block
    Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    $hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    $kept = @(Get-Content -LiteralPath $hostsPath -ErrorAction Stop | Where-Object { $_ -notmatch [regex]::Escape($HostsMarker) })
    Set-Content -LiteralPath $hostsPath -Encoding ASCII -Value $kept
    $profiles = @(Get-NetFirewallProfile -Profile Domain, Private, Public)
    $stillOpen = @($profiles | Where-Object { $_.Enabled.ToString() -ne 'True' -or $_.DefaultOutboundAction.ToString() -ne 'Block' }).Count -gt 0
    if ($profiles.Count -ne 3 -or $stillOpen) { throw 'network_backend_seal_offline_failed' }
  } -ArgumentList @($script:E1FirewallRulePrefix, $script:E1HostsMarker, $script:E1AuthWatchdogTaskName)
}

# One hop of a transition: adapter first (connect before any guest call that needs
# it, disconnect only after the guest side is already sealed), then the guest-side
# mutation for whichever mode this hop is moving TO. This ordering is what makes
# "connect and validate the adapter before resolving allowed endpoints" (ADR-S3)
# true unconditionally instead of caller-dependent.
function Invoke-E1NetworkHyperVHop($VM, [string]$GuestCredentialPath, [string]$ToMode) {
  switch ($ToMode) {
    'offline' {
      # PowerShell Direct uses the VMBus, not the virtual NIC -- it needs no
      # adapter connectivity (evidence1-post-os-transition.ps1 and
      # evidence1-bootstrap-toolchain.ps1 both rely on exactly this: they use
      # PowerShell Direct while asserting the adapter stays disconnected). So
      # this hop never connects the adapter at all: seal the guest over
      # PSDirect first, then make sure the adapter ends up disconnected --
      # whether it's coming from a connected mode (auth-open/restricted) or
      # was already disconnected. Never transiently connects an adapter whose
      # target state is "disconnected and locked down".
      Invoke-E1NetworkHyperVGuestSealOffline $VM $GuestCredentialPath
      Set-E1NetworkHyperVAdapterConnected $VM $false
    }
    'auth-open' {
      Set-E1NetworkHyperVAdapterConnected $VM $true
      Invoke-E1NetworkHyperVGuestOpenAuthWindow $VM $GuestCredentialPath $script:E1DefaultAuthWindowMinutes
    }
    'restricted' {
      Set-E1NetworkHyperVAdapterConnected $VM $true
      Invoke-E1NetworkHyperVGuestSealRestricted $VM $GuestCredentialPath
    }
    default { throw "network_mode_name_invalid: $ToMode" }
  }
}

# PUBLIC. Inspects current mode, computes the hop sequence through the shared
# transition graph, and mutates + re-verifies one hop at a time. On any hop failure,
# attempts one best-effort fail-closed seal (mirrors every existing script's catch
# block: always try to re-lock the firewall before propagating) and reports FAIL with
# whatever Get-E1NetworkState observes afterward, rather than leaving the caller to
# guess.
function Invoke-E1NetworkEnsureMode {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$GuestCredentialPath,
    [Parameter(Mandatory)][string]$TargetMode
  )
  $credentialFull = Assert-E1NetworkGuestCredentialPath $GuestCredentialPath
  $vm = Get-VM -Name $VMName -ErrorAction Stop
  if ($vm.State -ne 'Running') {
    if ($TargetMode -cne 'offline') { throw 'network_backend_vm_must_be_running' }
    # A stopped VM cannot run the guest-side firewall cleanup, but it also
    # cannot emit traffic. Converge the host-side boundary by disconnecting
    # its adapter and return the ordinary inspected offline result. This
    # makes cleanup resumable after a prior attempt already stopped the VM.
    Set-E1NetworkHyperVAdapterConnected $vm $false
    return Get-E1NetworkState -VMName $VMName -GuestCredentialPath $credentialFull
  }

  $current = Get-E1NetworkState -VMName $VMName -GuestCredentialPath $credentialFull
  $path = @(Get-E1NetworkTransitionPath -From ([string]$current.mode) -To $TargetMode)
  if ($path.Count -eq 1) {
    return Get-E1NetworkState -VMName $VMName -GuestCredentialPath $credentialFull
  }

  try {
    for ($hopIndex = 1; $hopIndex -lt $path.Count; $hopIndex++) {
      $hopMode = [string]$path[$hopIndex]
      Invoke-E1NetworkHyperVHop $vm $credentialFull $hopMode
      $observed = Get-E1NetworkState -VMName $VMName -GuestCredentialPath $credentialFull
      Assert-E1NetworkModeResult $observed
      if ([string]$observed.mode -cne $hopMode) {
        throw "network_backend_hop_verification_failed: expected $hopMode observed $([string]$observed.mode)"
      }
    }
  } catch {
    $failureMessage = $_.Exception.Message
    try { Invoke-E1NetworkHyperVGuestSealOffline $vm $credentialFull } catch { }
    try { Set-E1NetworkHyperVAdapterConnected $vm $false } catch { }
    $failClosedState = $null
    try { $failClosedState = Get-E1NetworkState -VMName $VMName -GuestCredentialPath $credentialFull } catch { }
    if ($failClosedState -and [string]$failClosedState.mode -ceq 'offline' -and [string]$failClosedState.verdict -ceq 'PASS') {
      $failClosedState.verdict = 'FAIL'
      $failClosedState.reason_code = $failureMessage
      return $failClosedState
    }
    throw "network_backend_ensure_mode_failed_and_fail_closed_unverified: $failureMessage"
  }

  return Get-E1NetworkState -VMName $VMName -GuestCredentialPath $credentialFull
}

Export-ModuleMember -Function Get-E1NetworkState, Invoke-E1NetworkEnsureMode

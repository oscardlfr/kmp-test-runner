# evidence1-network-backend-contract.psm1
#
# The NetworkBackend "interface" (ADR-S4) as this codebase already does interfaces
# elsewhere (see evidence1-vm-identity-contract.psm1, evidence1-host-snapshot-contract.psm1):
# a small, focused, zero-I/O module that owns the shared rules, and one or more sibling
# modules that export the SAME function names against real infrastructure or a fake.
# Nothing in this file touches a VM, an adapter, a firewall, or the network. It exists
# so evidence1-network-backend-hyperv.psm1 and evidence1-network-backend-fake.psm1 can
# never disagree about what a mode transition is allowed to do or what a valid result
# looks like -- see docs/audits/evidence1-phase2-architecture-note.md section 5.
#
# NetworkBackend has exactly three real modes and the directed transition graph
# below (never a direct auth-open -> restricted hop -- resealing always passes
# back through offline first):
#   offline -> auth-open
#   auth-open -> offline
#   offline -> restricted
#   restricted -> auth-open
#
# Addendum (Phase 3c, maintainer-answered open question 2): an earlier draft of
# this module also carried a fourth mode, 'closed', on the theory that it was
# physically identical to 'offline' and only the mode LABEL differed. The
# maintainer's direct answer: 'closed' is not a NetworkBackend-level concept at
# all -- it is evidence1-run.ps1's own orchestrator STATE (network offline, plus
# VM/processes/mounts/queue all closed -- a composite of several capabilities,
# not a single NetworkBackend mode). This module now speaks only in terms of the
# three modes above; the orchestrator's `Closed` state remains a separate,
# NOT_YET_IMPLEMENTED concern -- see evidence1-run.ps1 and
# evidence1-run-state-contract.psm1.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-E1NetworkModeNames {
  return @('offline', 'auth-open', 'restricted')
}

function Get-E1NetworkAllowedEdges {
  # Each edge is a { from; to } record, not a positional [a, b] pair -- hashtables
  # are never unrolled when PowerShell collects multiple statement outputs into an
  # array (unlike nested arrays, which can be), so this is the unambiguous choice,
  # and it matches how every other evidence1-*.psm1 contract module represents a
  # record (named properties, not tuples). Directed: presence of {offline;auth-open}
  # does not imply {auth-open;offline} is also allowed -- see the module header.
  return @(
    [ordered]@{ from = 'offline'; to = 'auth-open' }
    [ordered]@{ from = 'auth-open'; to = 'offline' }
    [ordered]@{ from = 'offline'; to = 'restricted' }
    [ordered]@{ from = 'restricted'; to = 'auth-open' }
  )
}

function Assert-E1NetworkModeName([string]$Mode) {
  if ($Mode -cnotin (Get-E1NetworkModeNames)) {
    throw "network_mode_name_invalid: $Mode"
  }
}

# Breadth-first shortest path over Get-E1NetworkAllowedEdges. Returns an ordered
# array of mode names from $From to $To inclusive, e.g. @('offline','restricted')
# for offline -> restricted. A $From equal to $To returns a single-element array
# (the no-op case -- callers should treat a one-element result as "already there,
# do nothing"). Throws network_mode_transition_unreachable if the graph (as
# currently defined) has no path -- with only three nodes and the edges above
# every pair is reachable, so this should never fire unless the edge set itself is
# changed; it is not a defensive no-op, it is a real contract violation if it ever
# does.
function Get-E1NetworkTransitionPath([string]$From, [string]$To) {
  Assert-E1NetworkModeName $From
  Assert-E1NetworkModeName $To
  if ($From -ceq $To) { return @($From) }

  $edges = @(Get-E1NetworkAllowedEdges)
  $adjacency = @{}
  foreach ($name in Get-E1NetworkModeNames) { $adjacency[$name] = @() }
  foreach ($edge in $edges) { $adjacency[[string]$edge.from] += [string]$edge.to }

  $visited = @{ $From = $true }
  $queue = [Collections.Generic.Queue[string]]::new()
  $queue.Enqueue($From)
  $cameFrom = @{}
  $found = $false
  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    if ($current -ceq $To) { $found = $true; break }
    foreach ($next in $adjacency[$current]) {
      if (-not $visited.ContainsKey($next)) {
        $visited[$next] = $true
        $cameFrom[$next] = $current
        $queue.Enqueue($next)
      }
    }
  }
  if (-not $found) { throw "network_mode_transition_unreachable: $From -> $To" }

  $path = [Collections.Generic.List[string]]::new()
  $cursor = $To
  while ($true) {
    $path.Insert(0, $cursor)
    if ($cursor -ceq $From) { break }
    $cursor = $cameFrom[$cursor]
  }
  return @($path.ToArray())
}

# The one result shape both implementations (real and fake) must produce, so a
# caller written against one behaves identically against the other. Modeled on the
# schema/verdict/generated_at_utc convention used by every evidence1-*.ps1 receipt.
function New-E1NetworkModeResult {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Mode,
    [Parameter(Mandatory)][string]$VMName,
    [string]$VMId = $null,
    [Parameter(Mandatory)][bool]$AdapterConnected,
    [string]$SwitchName = $null,
    [Parameter(Mandatory)][ValidateSet('Allow', 'Block')][string]$FirewallDefaultOutbound,
    [string[]]$PinnedHosts = @(),
    [bool]$WatchdogArmed = $false,
    [string]$WatchdogExpiresAtUtc = $null,
    [ValidateSet('PASS', 'FAIL')][string]$Verdict = 'PASS',
    [string]$ReasonCode = $null
  )
  Assert-E1NetworkModeName $Mode
  return [ordered]@{
    schema = 1
    mode = $Mode
    vm_name = $VMName
    vm_id = $VMId
    adapter_connected = $AdapterConnected
    switch_name = $SwitchName
    firewall_default_outbound = $FirewallDefaultOutbound
    pinned_hosts = @($PinnedHosts)
    watchdog_armed = $WatchdogArmed
    watchdog_expires_at_utc = $WatchdogExpiresAtUtc
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    verdict = $Verdict
    reason_code = $ReasonCode
  }
}

# Returns the property/key NAMES of $Value regardless of whether it is a raw
# dictionary ([ordered]@{}, e.g. straight from New-E1NetworkModeResult, never
# serialized) or a PSCustomObject (e.g. from ConvertFrom-Json). Needed because
# .PSObject.Properties.Name on a Hashtable/OrderedDictionary reflects the .NET
# TYPE's own members (Count, Keys, IsFixedSize, ...), not the dictionary's
# actual entries -- the exact bug this project's shape-asserts hit the first
# time evidence1-run.ps1 was actually run against the fake backends (every
# fake-mode result is exactly this kind of raw hashtable, never round-tripped
# through JSON before being asserted). Same idiom
# evidence1-validation-forensics.psm1:98 already uses -- copied, not reinvented.
function Get-E1NetworkPropertyNames($Value) {
  if ($Value -is [Collections.IDictionary]) { return @($Value.Keys) }
  return @($Value.PSObject.Properties.Name)
}

# Shape/invariant validation for a result this contract's own callers (either
# implementation, or a caller of ensure_mode) should run before trusting a result --
# mirrors how e.g. Assert-E1VmIdentityExactKeys is used elsewhere.
function Assert-E1NetworkModeResult($Result) {
  if ($null -eq $Result) { throw 'network_mode_result_missing' }
  $required = @(
    'schema', 'mode', 'vm_name', 'vm_id', 'adapter_connected', 'switch_name',
    'firewall_default_outbound', 'pinned_hosts', 'watchdog_armed',
    'watchdog_expires_at_utc', 'generated_at_utc', 'verdict', 'reason_code'
  )
  $actual = @(Get-E1NetworkPropertyNames $Result | Sort-Object)
  if (@(Compare-Object $actual @($required | Sort-Object)).Count -ne 0) {
    throw 'network_mode_result_shape_invalid'
  }
  if ([int]$Result.schema -ne 1) { throw 'network_mode_result_schema_invalid' }
  Assert-E1NetworkModeName ([string]$Result.mode)
  if ([string]$Result.verdict -cnotin @('PASS', 'FAIL')) { throw 'network_mode_result_verdict_invalid' }
  if ([string]$Result.verdict -ceq 'FAIL') {
    if ([string]::IsNullOrWhiteSpace([string]$Result.reason_code)) { throw 'network_mode_result_fail_missing_reason' }
    return
  }
  # PASS: enforce the exact per-mode physical shape from ADR-S3's table.
  switch ([string]$Result.mode) {
    'offline' {
      if ($Result.adapter_connected -ne $false) { throw 'network_mode_result_adapter_should_be_disconnected' }
      if ([string]$Result.firewall_default_outbound -cne 'Block') { throw 'network_mode_result_firewall_should_be_block' }
      if (@($Result.pinned_hosts).Count -ne 0) { throw 'network_mode_result_pinned_hosts_should_be_empty' }
      if ($Result.watchdog_armed -ne $false) { throw 'network_mode_result_watchdog_should_be_disarmed' }
    }
    'auth-open' {
      if ($Result.adapter_connected -ne $true) { throw 'network_mode_result_adapter_should_be_connected' }
      if ([string]::IsNullOrWhiteSpace([string]$Result.switch_name)) { throw 'network_mode_result_switch_name_missing' }
      if ([string]$Result.firewall_default_outbound -cne 'Allow') { throw 'network_mode_result_firewall_should_be_allow' }
      if ($Result.watchdog_armed -ne $true) { throw 'network_mode_result_watchdog_should_be_armed' }
      if ([string]::IsNullOrWhiteSpace([string]$Result.watchdog_expires_at_utc)) { throw 'network_mode_result_watchdog_expiry_missing' }
    }
    'restricted' {
      if ($Result.adapter_connected -ne $true) { throw 'network_mode_result_adapter_should_be_connected' }
      if ([string]::IsNullOrWhiteSpace([string]$Result.switch_name)) { throw 'network_mode_result_switch_name_missing' }
      if ([string]$Result.firewall_default_outbound -cne 'Block') { throw 'network_mode_result_firewall_should_be_block' }
      if (@($Result.pinned_hosts).Count -eq 0) { throw 'network_mode_result_pinned_hosts_should_be_nonempty' }
      if ($Result.watchdog_armed -ne $false) { throw 'network_mode_result_watchdog_should_be_disarmed' }
    }
  }
}

Export-ModuleMember -Function `
  Get-E1NetworkModeNames, `
  Get-E1NetworkAllowedEdges, `
  Get-E1NetworkTransitionPath, `
  New-E1NetworkModeResult, `
  Assert-E1NetworkModeResult

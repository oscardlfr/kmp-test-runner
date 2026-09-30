# evidence1-vm-state-contract.psm1
#
# ADR-S1's vm.inspect / vm.ensure_state capability family. Same three-file split
# and design philosophy as Phase 2's NetworkBackend (evidence1-network-backend-*.psm1):
# this module owns the shared, zero-I/O state graph and result shape; sibling
# modules provide the real Hyper-V implementation and a deterministic fake.
#
# The state set is deliberately just two: Off, Running. See
# docs/audits/evidence1-phase3b-architecture-note.md section 1 for the evidence --
# every vm-lifecycle script read this round (~7, covering inspection, start, stop,
# and two campaign-retirement scripts) targets exactly these two as the only power
# states anything transitions to or asserts as a precondition. The various
# "boot-state"/"live-state"/"closed-state" *inspection* scripts read richer facts
# WHILE in one of these two states (via three different mechanisms depending on
# which -- see the architecture note); they are not additional states themselves,
# and this module does not pretend otherwise.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-E1VmStateNames {
  return @('Off', 'Running')
}

function Get-E1VmAllowedEdges {
  return @(
    [ordered]@{ from = 'Off'; to = 'Running' }
    [ordered]@{ from = 'Running'; to = 'Off' }
  )
}

function Assert-E1VmStateName([string]$State) {
  if ($State -cnotin (Get-E1VmStateNames)) { throw "vm_state_name_invalid: $State" }
}

# Same breadth-first-shortest-path shape as
# evidence1-network-backend-contract.psm1's Get-E1NetworkTransitionPath, kept
# even though today's graph is trivial (two nodes, one edge each way) --
# consistency with the established pattern, and it generalizes correctly if a
# third state is ever added instead of needing a rewrite.
function Get-E1VmTransitionPath([string]$From, [string]$To) {
  Assert-E1VmStateName $From
  Assert-E1VmStateName $To
  if ($From -ceq $To) { return @($From) }

  $edges = @(Get-E1VmAllowedEdges)
  $adjacency = @{}
  foreach ($name in Get-E1VmStateNames) { $adjacency[$name] = @() }
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
  if (-not $found) { throw "vm_state_transition_unreachable: $From -> $To" }

  $path = [Collections.Generic.List[string]]::new()
  $cursor = $To
  while ($true) {
    $path.Insert(0, $cursor)
    if ($cursor -ceq $From) { break }
    $cursor = $cameFrom[$cursor]
  }
  return @($path.ToArray())
}

# The one result shape both implementations must produce -- modeled directly on
# evidence1-hyperv-inspect-vm-boot-state.ps1's own report (schema/verdict/state/
# status/uptime/memory/cpu/vhd_attached/integration_services), which is already a
# clean, working vm.inspect in miniature.
function New-E1VmStateResult {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$VMId,
    [Parameter(Mandatory)][ValidateSet('Off', 'Running')][string]$State,
    [string]$Status = $null,
    [double]$UptimeSeconds = 0,
    [int64]$MemoryAssignedBytes = 0,
    [int]$ProcessorLoadPercent = 0,
    [bool]$VhdAttached = $false,
    [object[]]$IntegrationServices = @(),
    [ValidateSet('PASS', 'FAIL')][string]$Verdict = 'PASS',
    [string]$ReasonCode = $null
  )
  return [ordered]@{
    schema                = 1
    vm_name                = $VMName
    vm_id                   = $VMId
    state                    = $State
    status                    = $Status
    uptime_seconds             = $UptimeSeconds
    memory_assigned_bytes        = $MemoryAssignedBytes
    processor_load_percent         = $ProcessorLoadPercent
    vhd_attached                     = $VhdAttached
    integration_services               = @($IntegrationServices)
    verdict                              = $Verdict
    reason_code                            = $ReasonCode
    generated_at_utc                         = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
}

# Returns the property/key NAMES of $Value regardless of whether it is a raw
# dictionary ([ordered]@{}, e.g. straight from New-E1VmStateResult, never
# serialized) or a PSCustomObject (e.g. from ConvertFrom-Json). Needed because
# .PSObject.Properties.Name on a Hashtable/OrderedDictionary reflects the .NET
# TYPE's own members (Count, Keys, IsFixedSize, ...), not the dictionary's
# actual entries -- the exact bug this project's shape-asserts hit the first
# time evidence1-run.ps1 was actually run against the fake backends. Same
# idiom evidence1-validation-forensics.psm1:98 already uses -- copied, not
# reinvented.
function Get-E1VmStatePropertyNames($Value) {
  if ($Value -is [Collections.IDictionary]) { return @($Value.Keys) }
  return @($Value.PSObject.Properties.Name)
}

function Assert-E1VmStateResult($Result) {
  if ($null -eq $Result) { throw 'vm_state_result_missing' }
  $required = @(
    'schema', 'vm_name', 'vm_id', 'state', 'status', 'uptime_seconds',
    'memory_assigned_bytes', 'processor_load_percent', 'vhd_attached',
    'integration_services', 'verdict', 'reason_code', 'generated_at_utc'
  )
  $actual = @(Get-E1VmStatePropertyNames $Result | Sort-Object)
  if (@(Compare-Object $actual @($required | Sort-Object)).Count -ne 0) {
    throw 'vm_state_result_shape_invalid'
  }
  if ([int]$Result.schema -ne 1) { throw 'vm_state_result_schema_invalid' }
  Assert-E1VmStateName ([string]$Result.state)
  if ([string]$Result.verdict -cnotin @('PASS', 'FAIL')) { throw 'vm_state_result_verdict_invalid' }
  if ([string]$Result.verdict -ceq 'FAIL' -and [string]::IsNullOrWhiteSpace([string]$Result.reason_code)) {
    throw 'vm_state_result_fail_missing_reason'
  }
}

Export-ModuleMember -Function `
  Get-E1VmStateNames, `
  Get-E1VmAllowedEdges, `
  Get-E1VmTransitionPath, `
  New-E1VmStateResult, `
  Assert-E1VmStateResult

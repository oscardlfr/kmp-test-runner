# evidence1-vm-state-fake.psm1
#
# ADR-S4's deterministic fake for vm.inspect / vm.ensure_state, mirroring
# evidence1-network-backend-fake.psm1's shape exactly. Zero Hyper-V I/O of any
# kind -- no Get-VM, no Start-VM/Stop-VM. Same not-imported-alongside-the-real-
# module caveat as the other fakes in this repo (both export the same names).

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-vm-state-contract.psm1') -Force -DisableNameChecking -Global

$script:E1FakeVmStates = @{}

function Set-E1FakeVmInitialState {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$State,
    [string]$VMId = ([guid]::NewGuid().ToString())
  )
  $result = New-E1FakeVmResultForState -VMName $VMName -VMId $VMId -State $State
  $script:E1FakeVmStates[$VMName] = $result
  return $result
}

function Reset-E1FakeVmState {
  [CmdletBinding()]
  param([string]$VMName)
  if ($VMName) {
    $null = $script:E1FakeVmStates.Remove($VMName)
  } else {
    $script:E1FakeVmStates = @{}
  }
}

function New-E1FakeVmResultForState {
  param([Parameter(Mandatory)][string]$VMName, [Parameter(Mandatory)][string]$VMId, [Parameter(Mandatory)][string]$State)
  if ($State -ceq 'Running') {
    return New-E1VmStateResult -VMName $VMName -VMId $VMId -State 'Running' -Status 'Operating normally' `
      -UptimeSeconds 1.0 -MemoryAssignedBytes 4294967296 -ProcessorLoadPercent 1 -VhdAttached $true -IntegrationServices @()
  }
  return New-E1VmStateResult -VMName $VMName -VMId $VMId -State 'Off' -Status 'Operating normally' `
    -UptimeSeconds 0 -MemoryAssignedBytes 0 -ProcessorLoadPercent 0 -VhdAttached $false -IntegrationServices @()
}

function Get-E1VmState {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [string]$ExpectedVMId = $null
  )
  if (-not $script:E1FakeVmStates.ContainsKey($VMName)) {
    throw "fake_vm_not_seeded: $VMName (call Set-E1FakeVmInitialState first)"
  }
  $current = $script:E1FakeVmStates[$VMName]
  if ($ExpectedVMId -and [string]$current.vm_id -cne $ExpectedVMId.ToLowerInvariant() -and [string]$current.vm_id -cne $ExpectedVMId) {
    throw 'vm_state_identity_mismatch'
  }
  Assert-E1VmStateResult $current
  return $current
}

function Invoke-E1VmEnsureState {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$ExpectedVMId,
    [Parameter(Mandatory)][string]$TargetState,
    [int]$StopTimeoutSeconds = 180,
    [int]$StartTimeoutSeconds = 120
  )
  $current = Get-E1VmState -VMName $VMName -ExpectedVMId $ExpectedVMId
  $path = @(Get-E1VmTransitionPath -From ([string]$current.state) -To $TargetState)
  if ($path.Count -eq 1) { return $current }

  $result = $null
  for ($hopIndex = 1; $hopIndex -lt $path.Count; $hopIndex++) {
    $hopState = [string]$path[$hopIndex]
    $result = New-E1FakeVmResultForState -VMName $VMName -VMId ([string]$current.vm_id) -State $hopState
    $script:E1FakeVmStates[$VMName] = $result
    Assert-E1VmStateResult $result
  }
  return $result
}

Export-ModuleMember -Function `
  Set-E1FakeVmInitialState, `
  Reset-E1FakeVmState, `
  Get-E1VmState, `
  Invoke-E1VmEnsureState

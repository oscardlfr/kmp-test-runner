# evidence1-run-state-contract.psm1
#
# ADR-S2's state graph and the per-state receipt envelope, extracted from
# evidence1-run.ps1 into its own module -- same one-concern-per-file shape
# every other capability in this codebase already uses (compare
# evidence1-vm-state-contract.psm1, evidence1-network-backend-contract.psm1).
# No -fake/-hyperv siblings: like broker.status, there is no "swap" story for
# the orchestrator's own state graph -- it is the same graph regardless of
# which capability backends are active.
#
# Extracted specifically so this logic is independently testable. evidence1-run.ps1
# is a full script, not a module: dot-sourcing it to reach a helper function
# would execute its entire top-level body (imports, parameter resolution, the
# main state walk) -- exactly what this whole task's standing boundary
# forbids. A plain Import-Module of this file has no such problem; nothing
# below does any I/O, touches a VM, or has a side effect on import.
#
# History: evidence1-run.ps1 originally defined this inline. Its shape-assert
# function had a real bug, found the first time the orchestrator was actually
# run (fake mode, non-live): Assert-E1RunStateReceiptShape compared
# $Receipt.PSObject.Properties.Name against the expected key set. That works
# for a PSCustomObject (what ConvertFrom-Json produces, e.g. a receipt read
# back off disk) but NOT for a raw [ordered]@{} hashtable (what
# New-E1RunStateReceipt itself returns, before ever touching disk) --
# .PSObject.Properties.Name on a Hashtable/OrderedDictionary reflects the
# .NET TYPE's own members (Count, Keys, IsFixedSize, ...), not the
# dictionary's actual entries. Every state's receipt went through this
# exact path before ever being written, so the bug blocked all forward
# progress from BrokerReady on. Fixed here using this codebase's own existing
# idiom for exactly this problem (evidence1-validation-forensics.psm1:98):
# branch on [Collections.IDictionary] and read .Keys directly instead of
# going through .PSObject.Properties at all.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-E1RunStateNames {
  return @(
    'Uninitialized', 'BrokerReady', 'VmReady', 'ToolchainReady', 'AuthReady',
    'RestrictedReady', 'DryRunPassed', 'LiveAuthorized', 'LiveRunning',
    'EvidenceCopied', 'Closed'
  )
}

# The live-adjacent half evidence1-run.ps1 must not implement this round --
# see Invoke-E1RunNotYetImplementedState below.
function Get-E1RunLiveAdjacentStateNames {
  return @('LiveAuthorized', 'LiveRunning', 'EvidenceCopied', 'Closed')
}

function Assert-E1RunStateName([string]$StateName) {
  if ($StateName -cnotin (Get-E1RunStateNames)) { throw "run_state_name_invalid: $StateName" }
}

# The one and only place the live-adjacent boundary is enforced. Callers
# (evidence1-run.ps1's main loop) check membership in
# Get-E1RunLiveAdjacentStateNames and call this BEFORE any handler lookup --
# structurally, not by a handler declining to act, so there is no code path
# from "the loop reaches LiveAuthorized" to a provider dispatch.
function Invoke-E1RunNotYetImplementedState([string]$StateName) {
  throw "evidence1_run_state_not_yet_implemented: $StateName (live-adjacent states are out of scope until the ADR-S6 manifest is consumed for real and two consecutive full Phase 4 rehearsal passes exist; neither does yet)"
}

# Returns the property/key NAMES of $Value regardless of whether it is a raw
# dictionary ([ordered]@{}/@{}, never serialized) or a PSCustomObject (e.g.
# from ConvertFrom-Json). This is the exact branch
# evidence1-validation-forensics.psm1:98 already uses for the same problem --
# copied, not reinvented, per the maintainer's explicit instruction.
function Get-E1RunPropertyNames($Value) {
  if ($Value -is [Collections.IDictionary]) { return @($Value.Keys) }
  return @($Value.PSObject.Properties.Name)
}

# Wraps whatever a capability call returned (each already has its OWN
# schema/verdict shape -- New-E1NetworkModeResult, New-E1VmStateResult,
# New-E1GuestBundleInvocationResult, or broker.status's plain hashtable,
# which has no verdict field at all) under one consistent outer shape, so
# evidence1-run.ps1's resumability logic only ever needs to check ONE place
# (receipt.verdict) regardless of which capability produced it.
function New-E1RunStateReceipt {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$CampaignId,
    [Parameter(Mandatory)][string]$StateName,
    [Parameter(Mandatory)][ValidateSet('PASS', 'FAIL')][string]$Verdict,
    [string]$ReasonCode = $null,
    $Detail = $null
  )
  Assert-E1RunStateName $StateName
  if ($Verdict -ceq 'FAIL' -and [string]::IsNullOrWhiteSpace($ReasonCode)) { throw 'run_state_receipt_fail_missing_reason' }
  return [ordered]@{
    schema           = 1
    campaign_id      = $CampaignId
    state            = $StateName
    verdict          = $Verdict
    reason_code      = $ReasonCode
    detail           = $Detail
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
}

function Assert-E1RunStateReceiptShape($Receipt) {
  if ($null -eq $Receipt) { throw 'run_state_receipt_missing' }
  $required = @('schema', 'campaign_id', 'state', 'verdict', 'reason_code', 'detail', 'generated_at_utc')
  $actual = @(Get-E1RunPropertyNames $Receipt | Sort-Object)
  if (@(Compare-Object $actual @($required | Sort-Object)).Count -ne 0) { throw 'run_state_receipt_shape_invalid' }
  if ([int]$Receipt.schema -ne 1) { throw 'run_state_receipt_schema_invalid' }
  Assert-E1RunStateName ([string]$Receipt.state)
  if ([string]$Receipt.verdict -cnotin @('PASS', 'FAIL')) { throw 'run_state_receipt_verdict_invalid' }
}

function Get-E1RunStateReceiptPath([string]$CampaignRoot, [string]$StateName) {
  return Join-Path $CampaignRoot "$StateName.receipt.json"
}

# Generic atomic JSON writer (temp file + rename), shared by receipts,
# campaign.json, and the top-level run report -- one copy, used from all
# three call sites in evidence1-run.ps1 instead of three near-identical ones.
function Write-E1RunJsonAtomically([string]$Path, $Value) {
  $full = [System.IO.Path]::GetFullPath($Path)
  $parent = Split-Path -Parent $full
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $temp = "$full.$([guid]::NewGuid().ToString('N')).tmp"
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 20))
  try {
    [IO.File]::WriteAllBytes($temp, $bytes)
    if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Force }
    [IO.File]::Move($temp, $full)
  } finally {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
  }
}

function Write-E1RunStateReceiptAtomically([string]$CampaignRoot, $Receipt) {
  Write-E1RunJsonAtomically (Get-E1RunStateReceiptPath $CampaignRoot ([string]$Receipt.state)) $Receipt
}

# Returns $null (never throws) if the receipt is absent -- "no receipt yet"
# is an ordinary, expected state for a fresh or partway campaign, not an
# error.
function Read-E1RunStateReceipt([string]$CampaignRoot, [string]$StateName) {
  $path = Get-E1RunStateReceiptPath $CampaignRoot $StateName
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  $receipt = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -ErrorAction Stop
  Assert-E1RunStateReceiptShape $receipt
  return $receipt
}

# PUBLIC. Extracted out of evidence1-run.ps1's own top-level campaign.json
# resume-identity check (overnight work order item 1) so it is independently
# testable -- same extraction rationale as everything else in this file.
# Pure comparison, no I/O. $ExistingDescriptor is whatever
# campaign.json round-trips to (a PSCustomObject from ConvertFrom-Json);
# $ExpectedDescriptor is the freshly-resolved descriptor for THIS invocation
# (a raw [ordered]@{} before ever touching disk) -- both representations
# must work, matching every other shape-check in this codebase (see this
# file's own header on why .PSObject.Properties.Name alone is not enough).
# [string] casts throughout (not [bool]-only) so a $null output_roots_private/
# _public (the no-manifest case, both sides $null) compares equal via
# [string]$null -> '' on both sides, rather than needing a special case.
function Test-E1RunCampaignIdentityMatches($ExistingDescriptor, $ExpectedDescriptor) {
  if ($null -eq $ExistingDescriptor -or $null -eq $ExpectedDescriptor) { throw 'run_campaign_identity_descriptor_missing' }
  return ([string]$ExistingDescriptor.vm_name -ceq [string]$ExpectedDescriptor.vm_name) -and
         ([string]$ExistingDescriptor.vm_id -ceq [string]$ExpectedDescriptor.vm_id) -and
         ([bool]$ExistingDescriptor.use_real_backends -eq [bool]$ExpectedDescriptor.use_real_backends) -and
         ([string]$ExistingDescriptor.output_roots_private -ceq [string]$ExpectedDescriptor.output_roots_private) -and
         ([string]$ExistingDescriptor.output_roots_public -ceq [string]$ExpectedDescriptor.output_roots_public)
}

Export-ModuleMember -Function `
  Get-E1RunStateNames, `
  Get-E1RunLiveAdjacentStateNames, `
  Assert-E1RunStateName, `
  Invoke-E1RunNotYetImplementedState, `
  Get-E1RunPropertyNames, `
  New-E1RunStateReceipt, `
  Assert-E1RunStateReceiptShape, `
  Get-E1RunStateReceiptPath, `
  Write-E1RunJsonAtomically, `
  Write-E1RunStateReceiptAtomically, `
  Read-E1RunStateReceipt, `
  Test-E1RunCampaignIdentityMatches

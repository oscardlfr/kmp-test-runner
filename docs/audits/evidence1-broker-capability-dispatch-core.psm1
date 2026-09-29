# evidence1-broker-capability-dispatch-core.psm1
#
# The ROUTING half of the new capability-dispatch protocol
# (evidence1-broker-capability-contract.psm1 is the SCHEMA half). Given one
# already-shape-validated capability request, calls the ALREADY-BUILT,
# ALREADY-REVIEWED real/hyperv function that capability's own registry entry
# names (evidence1-broker-capability-contract.psm1's Get-E1BrokerCapabilityRegistry)
# and wraps whatever it returns (or however it fails) into one closed
# response envelope (New-E1BrokerCapabilityResponse).
#
# Deliberately does NOT Import-Module any of the five capability
# implementation modules (evidence1-broker-status-real.psm1,
# evidence1-vm-state-hyperv.psm1, evidence1-network-backend-hyperv.psm1,
# evidence1-guest-bundle-hyperv.psm1, evidence1-artifact-copy-hyperv.psm1)
# itself. It resolves each capability's function by NAME **and** by an
# EXPLICIT, VERIFIED module of provenance -- never a request-supplied string
# used as a module path, and never an Import-Module call this file makes on
# the caller's behalf (see Get-E1BrokerCapabilityFunction's own header for
# why bare by-name resolution was the incident's own root cause, and is no
# longer how this module works). This is what makes the ROUTING logic
# genuinely testable without Hyper-V: a caller that wants to route against
# the *-fake.psm1 siblings (which export IDENTICAL function names -- an
# already-verified parity property, see
# docs/audits/evidence1-phase3c-architecture-note.md section 13.3) passes an
# explicit -ModuleNameOverrides map naming them; the elevated dispatcher
# passes nothing and gets the registry's own real/hyperv module_file values
# instead. Both profiles are explicit; neither is inferred from session
# state.
#
# artifacts.copy_read_only's TrustedRoot (Task 3 of this round) is the one
# capability-specific exception to "every argument comes from the request":
# it is never read from $Request.arguments (there is no such key in that
# capability's argument_schema -- see the contract module's own comment) and
# never defaulted here. The caller (the elevated script) must resolve it via
# Get-E1ArtifactCopyRealTrustedRoot against a freshly-computed BrokerStatus
# and pass it explicitly as -ArtifactCopyTrustedRoot; this module refuses to
# route artifacts.copy_read_only at all without it.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-broker-capability-contract.psm1') -Force -DisableNameChecking -Global

# Builds the exact named-parameter splat for one capability call: every
# key in that capability's own argument_schema, mapped 1:1 to the target
# function's OWN parameter of the identical name (the registry was
# authored so these always match -- see evidence1-broker-capability-contract.psm1's
# Get-E1BrokerCapabilityRegistry, each entry's argument_schema key list).
# "Arguments" is the one key that needs a shape conversion before use (a
# [hashtable]-typed parameter on both Invoke-E1GuestBundle and
# Copy-E1ArtifactsReadOnly) -- every other value passes through unchanged,
# already primitive-typed by Assert-E1BrokerCapabilityArguments.
function Get-E1BrokerCapabilityCallSplat([string]$Capability, $Arguments) {
  $entry = (Get-E1BrokerCapabilityRegistry)[$Capability]
  $splat = [ordered]@{}
  foreach ($key in $entry.argument_schema.Keys) {
    $value = Get-E1BrokerCapabilityValue $Arguments $key
    if ($key -ceq 'Arguments') {
      $splat[$key] = ConvertTo-E1BrokerCapabilityHashtable $value
    } else {
      $splat[$key] = $value
    }
  }
  return $splat
}

# Resolves the target function with EXPLICIT, VERIFIED PROVENANCE -- by name
# AND by the specific module it must come from -- never by name alone.
#
# INCIDENT-DRIVEN FIX (see docs/audits/evidence1-incident-2026-09-19-real-queue-trigger.md):
# the prior version of this function resolved purely by
# `Get-Command -Name $FunctionName` -- against "whatever the caller already
# imported." When a caller's session had BOTH a capability's *-fake.psm1 AND
# its *-queue-client.psm1 sibling loaded at once (identical function names,
# by design, for the drop-in-swap property every fake/hyperv/queue-client
# trio in this repo relies on), that resolution silently picked whichever
# module was imported LAST -- with no verification it was the one the caller
# actually intended. That ambiguity is what let a simulator's "route to the
# fake" call silently re-enter the real queue-client instead, triggering the
# real Scheduled Task for real. A same-process runspace-isolation workaround
# was tried first and rejected as insufficient -- it hides the ambiguity for
# one specific caller shape rather than removing it from this function itself.
#
# Neither `-Module $ModuleName` nor `-Module ... -All` is actually
# scope-independent -- confirmed by direct testing, not assumed, and the
# opposite of what PowerShell's own documentation implies. Both were tried
# first and both FAIL from exactly the context this function actually runs
# in (a function's own body, defined inside a DIFFERENT module -- this one):
#   - `-Module Y` alone filters the CALLING SESSION'S OWN currently-
#     resolvable command for that name first, THEN checks its module --
#     i.e. it re-introduces the exact ambiguity this fix exists to remove,
#     because "the session's own resolvable command" is precisely the
#     import-order-dependent value that caused the incident.
#   - `-Module Y -All`, called from top-level script scope, correctly finds
#     a colliding function in EITHER module regardless of import order
#     (verified). Called from INSIDE another module's own function body --
#     confirmed via a throwaway test module reproducing this file's own
#     shape -- `-All` itself only surfaces ONE of the two colliding
#     commands (module-visibility boundaries apply to `-All` too, not only
#     to the unqualified lookup), so it is no more reliable here than the
#     unqualified lookup was.
# The one form confirmed reliable from inside a module's own function body,
# in both collision orders, is PowerShell's own module-qualified command
# name syntax: `Get-Command -Name "<Module>\<Function>"`. Verified directly:
# resolves each of two identically-named functions from two different
# modules to its own distinct ModuleName, correctly, regardless of which was
# imported last.
#
# $ExpectedModuleName is never a caller-supplied string reaching this
# function via untrusted input -- every call site resolves it from either
# the closed registry's own `module_file` (Invoke-E1BrokerCapabilityRoute's
# production default, below) or a closed override map a caller passes
# in-process (never from a request field; the capability request schema has
# no module-name concept at all).
function Get-E1BrokerCapabilityFunction([string]$FunctionName, [string]$ExpectedModuleName) {
  if ([string]::IsNullOrWhiteSpace($ExpectedModuleName)) {
    throw "broker_capability_function_module_name_required: $FunctionName"
  }
  $command = Get-Command -Name "$ExpectedModuleName\$FunctionName" -CommandType Function -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "broker_capability_function_not_available: $FunctionName in module $ExpectedModuleName"
  }
  if ($command.ModuleName -cne $ExpectedModuleName) {
    # Defense in depth: the qualified-name lookup should structurally never
    # return a command from a DIFFERENT module than the one named in the
    # query, but this is verified explicitly rather than trusted implicitly
    # -- matching this fix's own "reject on collision, never guess"
    # requirement.
    throw "broker_capability_function_provenance_mismatch: $FunctionName expected module $ExpectedModuleName, got $($command.ModuleName)"
  }
  return $command
}

# Strips a registry module_file literal ('evidence1-vm-state-hyperv.psm1')
# down to the module NAME PowerShell actually assigns on import
# ('evidence1-vm-state-hyperv') -- confirmed directly, not assumed: a .psm1
# file imported via Import-Module gets a ModuleName equal to its own base
# file name, no extension. Pure string manipulation, no I/O.
function Get-E1BrokerCapabilityModuleNameFromFile([string]$ModuleFile) {
  return [IO.Path]::GetFileNameWithoutExtension($ModuleFile)
}

# Does the returned value from a capability function carry its own
# verdict/reason_code (BrokerStatus/ArtifactCopy results do not; VmState/
# NetworkBackend/GuestBundle results do) -- mirrors evidence1-run.ps1's own
# per-state handling (e.g. Invoke-E1RunVmReadyState mirrors
# $result.verdict/$result.reason_code into its own receipt;
# Invoke-E1RunBrokerReadyState instead computes its OWN derived verdict from
# BrokerStatus's raw facts), generalized here into one rule every capability
# follows the same way rather than one bespoke branch per capability.
function Test-E1BrokerCapabilityResultCarriesVerdict($Result) {
  if ($null -eq $Result) { return $false }
  $names = @(Get-E1BrokerCapabilityPropertyNames $Result)
  return ($names -ccontains 'verdict')
}

# PUBLIC. $Request must already satisfy Assert-E1BrokerCapabilityRequestShape
# (re-checked here too, defensively -- cheap, and this function must be safe
# to call directly, exactly as Copy-E1ArtifactsReadOnly itself re-validates
# even though evidence1-run.ps1 may already have checked upstream).
# $ArtifactCopyTrustedRoot is REQUIRED (and only meaningful) for
# artifacts.copy_read_only -- see this file's own header.
#
# $ModuleNameOverrides (production vs. simulator PROFILES, both explicit):
# a closed capability-name -> module-name map. Defaults to $null, meaning
# "use the registry's own module_file for every capability" -- the
# PRODUCTION profile, changing NOTHING about this function's real-dispatcher
# behavior from before this fix (evidence1-host-broker-capability-dispatch.ps1
# never passes this parameter at all). A caller that needs a DIFFERENT,
# explicit profile -- e.g. a non-privileged simulator that must resolve every
# capability to its *-fake.psm1 sibling instead -- passes its own closed map
# here; there is no other way to change which module this function trusts,
# and nothing about that map can come from $Request itself.
function Invoke-E1BrokerCapabilityRoute {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]$Request,
    [string]$ArtifactCopyTrustedRoot = '',
    [hashtable]$ModuleNameOverrides = $null
  )
  Assert-E1BrokerCapabilityRequestShape $Request
  $capability = [string](Get-E1BrokerCapabilityValue $Request 'capability')
  $operationId = [string](Get-E1BrokerCapabilityValue $Request 'operation_id')
  $arguments = Get-E1BrokerCapabilityValue $Request 'arguments'
  Assert-E1BrokerCapabilityPathArguments $capability $arguments

  $entry = (Get-E1BrokerCapabilityRegistry)[$capability]
  if ([bool]$entry.requires_broker_trusted_root -and [string]::IsNullOrWhiteSpace($ArtifactCopyTrustedRoot)) {
    return New-E1BrokerCapabilityResponse -OperationId $operationId -Capability $capability `
      -Verdict 'FAIL' -ReasonCode 'broker_capability_trusted_root_required' -Result $null
  }

  $splat = Get-E1BrokerCapabilityCallSplat $capability $arguments
  if ([bool]$entry.requires_broker_trusted_root) {
    $splat['TrustedRoot'] = $ArtifactCopyTrustedRoot
  }

  try {
    $expectedModuleName = if ($ModuleNameOverrides -and $ModuleNameOverrides.ContainsKey($capability)) {
      $ModuleNameOverrides[$capability]
    } else {
      Get-E1BrokerCapabilityModuleNameFromFile $entry.module_file
    }
    $function = Get-E1BrokerCapabilityFunction $entry.function_name $expectedModuleName
    $returned = & $function @splat
  } catch {
    $reasonCode = Get-E1BrokerCapabilityReasonCodePrefix $_.Exception.Message
    return New-E1BrokerCapabilityResponse -OperationId $operationId -Capability $capability `
      -Verdict 'FAIL' -ReasonCode $reasonCode -Result $null
  }

  if (Test-E1BrokerCapabilityResultCarriesVerdict $returned) {
    $innerVerdict = [string](Get-E1BrokerCapabilityValue $returned 'verdict')
    $innerReason = [string](Get-E1BrokerCapabilityValue $returned 'reason_code')
    if ($innerVerdict -cnotin @('PASS', 'FAIL')) { $innerVerdict = 'FAIL'; $innerReason = 'broker_capability_inner_result_verdict_invalid' }
    if ($innerVerdict -ceq 'FAIL' -and [string]::IsNullOrWhiteSpace($innerReason)) { $innerReason = 'broker_capability_function_failed' }
    return New-E1BrokerCapabilityResponse -OperationId $operationId -Capability $capability `
      -Verdict $innerVerdict -ReasonCode $innerReason -Result $returned
  }

  return New-E1BrokerCapabilityResponse -OperationId $operationId -Capability $capability `
    -Verdict 'PASS' -ReasonCode $null -Result $returned
}

Export-ModuleMember -Function `
  Get-E1BrokerCapabilityCallSplat, `
  Get-E1BrokerCapabilityFunction, `
  Get-E1BrokerCapabilityModuleNameFromFile, `
  Test-E1BrokerCapabilityResultCarriesVerdict, `
  Invoke-E1BrokerCapabilityRoute

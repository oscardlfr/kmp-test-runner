# evidence1-broker-capability-contract.psm1
#
# ADR-S1's missing piece: a single typed, closed capability-dispatch protocol
# so the four real-capable capability families (VmState, NetworkBackend,
# GuestBundle, ArtifactCopy) plus broker.status can be reached through the
# elevated broker's OWN queue instead of being called in-process by the
# non-elevated orchestrator (evidence1-run.ps1 today, for the first three
# under -UseRealBackends) -- see
# docs/audits/evidence1-overnight-execution-report-2026-09-18.md's final
# "PRE-BOOTSTRAP READINESS" section, gap #2, and
# docs/audits/evidence1-phase3c-architecture-note.md section 9.4 item 6 (the
# maintainer's own prior-round answer: vm.ensure_state/network.ensure_mode/
# guest.invoke_bundle -- now four, with artifacts.copy_read_only --  MUST
# dispatch through the queue for the real path; this module and its siblings
# are that dispatch-layer rework, previously flagged as "the single
# highest-priority piece of remaining architecture").
#
# ADR-S1 explicitly REJECTS "continuing to add one allowlisted privileged
# script per operation" -- the root cause of 83+ historical installations
# (plan section 5, ADR-S1 "Rejected"). This module is the alternative: ONE
# small, typed, closed request/response schema naming exactly one of a fixed
# 7-capability registry, validated here, routed by
# evidence1-broker-capability-dispatch-core.psm1, and reached through exactly
# ONE new allowlisted elevated entrypoint,
# evidence1-host-broker-capability-dispatch.ps1 -- registered ONCE in
# evidence1-host-elevated-runner.ps1's $AllowedScripts, never once per
# capability and never again as capabilities are added or changed. A NEW
# capability is a change to the CLOSED REGISTRY below plus routing in
# evidence1-broker-capability-dispatch-core.psm1 -- reviewed code changes,
# exactly as adding a bundle to evidence1-guest-bundle-contract.psm1's own
# closed registry already is -- never a new allowlisted script or a new
# Scheduled Task action.
#
# Same three-way split discipline as every other capability in this repo:
# this file is the PURE, zero-I/O contract (registry, request/response shape,
# validation) that both the elevated dispatcher script and the non-elevated
# client-side queue-client modules import and agree on. It imports NOTHING
# from this repo's other modules (a dependency-free leaf, like
# evidence1-trusted-root-config.psm1) so it can be trusted by both sides of
# the elevation boundary without pulling in Hyper-V-touching code merely to
# validate a request's SHAPE. Scratch-root confinement below is therefore a
# HARDCODED 'C:\kmp-eval\scratch\' literal, deliberately NOT resolved through
# evidence1-trusted-root-config.psm1's env-var-overridable
# Get-E1DefaultTrustedRoot -- matching evidence1-network-backend-hyperv.psm1's
# Assert-E1NetworkGuestCredentialPath and
# evidence1-guest-bundle-hyperv.psm1's Assert-E1GuestBundleCredentialPath,
# which hardcode the identical literal directly for the identical reason: an
# unprivileged environment variable must never be able to widen where a real,
# elevated capability request is allowed to point.
#
# Deliberately EXCLUDED from the registry: broker.update. See
# Get-E1BrokerCapabilityRegistry's own header comment for the decision and
# its reasoning -- short version: it already has a working, reviewed,
# independently-tested dispatch path
# (evidence1-host-elevated-runner-install.ps1, allowlisted directly,
# argument-pinned by evidence1-host-elevated-runner.ps1's own
# Assert-E1SelfInstallRunnerArguments) that this round's instructions say not
# to rebuild.
#
# Structural guarantees this module exists to make true, not just
# conventional (mirrors evidence1-guest-bundle-contract.psm1's own header):
#   - no arbitrary script path, ScriptBlock, or command-string parameter
#     anywhere in the request schema -- every argument_schema entry below is
#     a fixed, authored-in-this-file literal; nothing here accepts a
#     caller-supplied path to ANOTHER script or a [scriptblock]/code-string
#     value of any kind;
#   - no undeclared argument accepted for any capability -- exact-key
#     matching (Assert-E1BrokerCapabilityArguments), same discipline as
#     Assert-E1GuestBundleArguments;
#   - the manifest (ADR-S6, evidence1-run-manifest-contract.psm1) can never
#     reach or widen a capability's trusted configuration through this
#     schema -- artifacts.copy_read_only's own argument_schema has no
#     TrustedRoot key at all (see that entry's own comment); a request
#     supplying one is rejected outright as an undeclared argument, the same
#     closed-set rejection every other undeclared key gets.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-E1BrokerCapabilityDefaultTimeoutMinutes {
  # One shared queue ceiling. Guest transport is permitted to consume any
  # positive whole-second duration below this broker-owned deadline; callers
  # must not independently invent a smaller cap.
  return 120
}

function Get-E1BrokerCapabilitySchemaVersion { return 1 }

# Fixed request-freshness window. 900 seconds (15 minutes) -- NOT invented
# for this round, matching this codebase's own established "bounded
# operation" convention: evidence1-network-backend-hyperv.psm1's
# $script:E1DefaultAuthWindowMinutes (= 15) is the auth-open network window
# every existing guest network operation already uses, and
# evidence1-host-elevated-runner.ps1's own Invoke-UnattendedRecovery uses a
# 900-second timeout for its slowest recovery class
# ($recoveryTimeoutSeconds for evidence1-host-apply-canonical-windows-offline.ps1).
# A capability request is expected to be dispatched within seconds of being
# written (the client writes the request then immediately triggers
# schtasks /Run, exactly like evidence1-host-elevated-runner-client.ps1's own
# established flow) -- 900 seconds is generous headroom for scheduler/queue
# latency while still being a real, bounded window a stale or corrupted
# request cannot silently survive forever. This is NOT the same concept as a
# capability's own operation timeout (guest.invoke_bundle's -TimeoutSeconds,
# vm.ensure_state's -StopTimeoutSeconds/-StartTimeoutSeconds) -- this is "how
# old may the REQUEST be before dispatch even begins", not "how long may the
# operation itself run once started".
function Get-E1BrokerCapabilityRequestExpirySeconds { return 900 }

# The trusted confinement root for any path-shaped capability argument
# (GuestCredentialPath, DestinationDir). Hardcoded, not env-var-overridable
# -- see this file's own header for why.
function Get-E1BrokerCapabilityTrustedRootLiteral { return 'C:\kmp-eval\scratch\' }

# The closed capability registry. See this file's own header for what
# "closed" structurally guarantees.
#
# Each entry:
#   description                   -- human-readable
#   module_file                     -- the ALREADY-BUILT module this
#                                       capability's function lives in (a
#                                       fixed literal filename under
#                                       docs/audits/, never a caller-supplied
#                                       path)
#   function_name                     -- the ALREADY-BUILT, exported function
#                                         name this capability calls
#                                         (evidence1-broker-capability-dispatch-core.psm1
#                                         resolves this via Get-Command
#                                         against an ALREADY-IMPORTED module
#                                         -- it never Import-Modules using a
#                                         request-supplied string, and never
#                                         treats this value as a path)
#   argument_schema                     -- ORDERED map of argument name ->
#                                           validator scriptblock, exactly
#                                           like
#                                           evidence1-guest-bundle-contract.psm1's
#                                           own per-bundle schema. Every
#                                           value here is a fixed,
#                                           authored-in-this-file literal.
#                                           Order carries no positional
#                                           meaning here (unlike a guest
#                                           bundle's own argument_schema) --
#                                           evidence1-broker-capability-dispatch-core.psm1
#                                           resolves each named argument
#                                           explicitly by key, never
#                                           positionally.
#   path_arguments                        -- subset of argument_schema keys
#                                             that name a filesystem path and
#                                             must additionally pass
#                                             Assert-E1BrokerCapabilityPathArgument
#                                             (confined under
#                                             Get-E1BrokerCapabilityTrustedRootLiteral)
#   requires_broker_trusted_root             -- $true only for
#                                                artifacts.copy_read_only:
#                                                signals to the dispatcher
#                                                (NOT expressed as an
#                                                argument_schema entry at all
#                                                -- see that entry's own
#                                                comment) that TrustedRoot
#                                                must be resolved
#                                                broker-side via
#                                                Get-E1ArtifactCopyRealTrustedRoot
#                                                and passed out-of-band,
#                                                never accepted from the
#                                                request.
#
# broker.update is deliberately absent -- decision recorded here, not
# silently omitted. evidence1-host-elevated-runner-install.ps1 already is a
# directly allowlisted script (evidence1-host-elevated-runner.ps1's own
# $AllowedScripts) with its own dedicated, already-reviewed, already-tested
# argument-pinning function (Assert-E1SelfInstallRunnerArguments) that
# validates its exact six arguments (-TaskName/-RunnerPath/-QueueRoot/
# -AllowedRoot/-ExecutionIdentity/-ReportPath) against the one true
# deployment identity. Routing broker.update THROUGH this new capability
# envelope would mean either (a) re-encoding that same six-argument shape a
# SECOND time inside a generic "arguments" JSON object with no benefit --
# Assert-E1SelfInstallRunnerArguments would still need to run against
# whatever came out the other side, since it is what the elevated runner
# already trusts -- or (b) teaching this new dispatcher script to shell out
# to evidence1-host-elevated-runner-install.ps1 as a NESTED child process
# from inside an already-elevated child process, adding a layer of
# indirection with no safety property the direct route lacks. Both are pure
# cost with no reduction in privileged-script count (the self-install script
# stays allowlisted either way) and no closing of any gap this round's
# instructions identify. broker.update keeps its existing, working dispatch
# path unchanged.
function Get-E1BrokerCapabilityRegistry {
  return [ordered]@{

    'broker.status' = [ordered]@{
      description                  = 'Read-only broker deployment identity/integrity status.'
      module_file                  = 'evidence1-broker-status-real.psm1'
      function_name                = 'Get-E1BrokerStatus'
      argument_schema               = [ordered]@{}
      path_arguments                 = @()
      requires_broker_trusted_root      = $false
    }

    'vm.inspect' = [ordered]@{
      description                  = 'Read-only VM power-state inspection.'
      module_file                  = 'evidence1-vm-state-hyperv.psm1'
      function_name                = 'Get-E1VmState'
      argument_schema               = [ordered]@{
        VMName       = { param($v) $v -is [string] -and -not [string]::IsNullOrWhiteSpace($v) }
        ExpectedVMId = { param($v) $v -is [string] }
      }
      path_arguments                 = @()
      requires_broker_trusted_root      = $false
    }

    'vm.ensure_state' = [ordered]@{
      description                  = 'Idempotent VM power-state transition (Off/Running), always re-verified.'
      module_file                  = 'evidence1-vm-state-hyperv.psm1'
      function_name                = 'Invoke-E1VmEnsureState'
      argument_schema               = [ordered]@{
        VMName              = { param($v) $v -is [string] -and -not [string]::IsNullOrWhiteSpace($v) }
        ExpectedVMId        = { param($v) $v -is [string] -and -not [string]::IsNullOrWhiteSpace($v) }
        TargetState         = { param($v) $v -is [string] -and $v -cin @('Off', 'Running') }
        StopTimeoutSeconds  = { param($v) Test-E1BrokerCapabilityIntInRange $v 1 3600 }
        StartTimeoutSeconds = { param($v) Test-E1BrokerCapabilityIntInRange $v 1 3600 }
      }
      path_arguments                 = @()
      requires_broker_trusted_root      = $false
    }

    # P0 #4 (publication hardening): closed, read-only VHD/AVHDX chain inspection -- the VmReady
    # disk guard's own single source of truth for leaf virtual_size/file_size, automatic_stop_action,
    # memory_startup_bytes and vm_state. No caller-supplied path of any kind: VMName/ExpectedVMId are
    # the same closed E2E identity every other VM capability already takes, and the function itself
    # (Get-E1VmVhdChain, evidence1-vm-state-hyperv.psm1) resolves the attached disk from
    # Get-VMHardDiskDrive and walks its own parent chain -- never a caller-chosen VHD path.
    'vhd.inspect_chain' = [ordered]@{
      description                  = 'Read-only VHD/AVHDX parent-chain inspection: leaf virtual/file size, VM power-state fields.'
      module_file                  = 'evidence1-vm-state-hyperv.psm1'
      function_name                = 'Get-E1VmVhdChain'
      argument_schema               = [ordered]@{
        VMName       = { param($v) $v -is [string] -and -not [string]::IsNullOrWhiteSpace($v) }
        ExpectedVMId = { param($v) $v -is [string] -and -not [string]::IsNullOrWhiteSpace($v) }
      }
      path_arguments                 = @()
      requires_broker_trusted_root      = $false
    }

    'network.inspect' = [ordered]@{
      description                  = 'Read-only network mode inspection (adapter + guest firewall).'
      module_file                  = 'evidence1-network-backend-hyperv.psm1'
      function_name                = 'Get-E1NetworkState'
      argument_schema               = [ordered]@{
        VMName              = { param($v) $v -is [string] -and -not [string]::IsNullOrWhiteSpace($v) }
        GuestCredentialPath = { param($v) $v -is [string] -and -not [string]::IsNullOrWhiteSpace($v) }
      }
      path_arguments                 = @('GuestCredentialPath')
      requires_broker_trusted_root      = $false
    }

    'network.ensure_mode' = [ordered]@{
      description                  = 'Idempotent network mode transition (offline/auth-open/restricted), always re-verified.'
      module_file                  = 'evidence1-network-backend-hyperv.psm1'
      function_name                = 'Invoke-E1NetworkEnsureMode'
      argument_schema               = [ordered]@{
        VMName              = { param($v) $v -is [string] -and -not [string]::IsNullOrWhiteSpace($v) }
        GuestCredentialPath = { param($v) $v -is [string] -and -not [string]::IsNullOrWhiteSpace($v) }
        TargetMode          = { param($v) $v -is [string] -and $v -cin @('offline', 'auth-open', 'restricted') }
      }
      path_arguments                 = @('GuestCredentialPath')
      requires_broker_trusted_root      = $false
    }

    'guest.invoke_bundle' = [ordered]@{
      description                  = 'Runs one closed-registry PowerShell Direct bundle inside the guest.'
      module_file                  = 'evidence1-guest-bundle-hyperv.psm1'
      function_name                = 'Invoke-E1GuestBundle'
      argument_schema               = [ordered]@{
        VMName              = { param($v) $v -is [string] -and -not [string]::IsNullOrWhiteSpace($v) }
        GuestCredentialPath = { param($v) $v -is [string] -and -not [string]::IsNullOrWhiteSpace($v) }
        BundleName          = { param($v) $v -is [string] -and -not [string]::IsNullOrWhiteSpace($v) }
        Arguments           = { param($v) Test-E1BrokerCapabilityArgumentsContainer $v }
        TimeoutSeconds      = { param($v) Test-E1BrokerCapabilityIntInRange $v 5 ((Get-E1BrokerCapabilityDefaultTimeoutMinutes) * 60) }
      }
      path_arguments                 = @('GuestCredentialPath')
      requires_broker_trusted_root      = $false
    }

    # NOTE: no TrustedRoot key. Deliberately absent, not merely undocumented
    # -- see this file's own header and Get-E1ArtifactCopyRealTrustedRoot's
    # own header (evidence1-artifact-copy-hyperv.psm1) for why the broker
    # resolves this itself, from a verified BrokerStatus, and passes it
    # out-of-band. A request supplying TrustedRoot is rejected by
    # Assert-E1BrokerCapabilityArguments as an undeclared argument, exactly
    # like any other unrecognized key -- structurally, not by convention.
    'artifacts.copy_read_only' = [ordered]@{
      description                  = 'Read-only, create-new copy of one closed-registry evidence spec out of an Off VM''s disk.'
      module_file                  = 'evidence1-artifact-copy-hyperv.psm1'
      function_name                = 'Copy-E1ArtifactsReadOnly'
      argument_schema               = [ordered]@{
        VMName         = { param($v) $v -is [string] -and -not [string]::IsNullOrWhiteSpace($v) }
        ExpectedVMId   = { param($v) $v -is [string] -and -not [string]::IsNullOrWhiteSpace($v) }
        SpecName       = { param($v) $v -is [string] -and -not [string]::IsNullOrWhiteSpace($v) }
        Arguments      = { param($v) Test-E1BrokerCapabilityArgumentsContainer $v }
        DestinationDir = { param($v) $v -is [string] -and -not [string]::IsNullOrWhiteSpace($v) }
      }
      path_arguments                 = @('DestinationDir')
      requires_broker_trusted_root      = $true
    }
  }
}

function Get-E1BrokerCapabilityNames {
  return @((Get-E1BrokerCapabilityRegistry).Keys | Sort-Object)
}

function Assert-E1BrokerCapabilityName([string]$Capability) {
  if ($Capability -cnotin (Get-E1BrokerCapabilityNames)) { throw "broker_capability_name_invalid: $Capability" }
}

# int-in-range validator shared by several argument_schema entries above.
# Accepts any numeric type ConvertFrom-Json may have produced for a JSON
# number (Int32/Int64/Double, depending on magnitude and PowerShell version)
# -- never a numeric-looking STRING (a caller sending "60" instead of 60 has
# a malformed request, not an equivalent one -- JSON numbers are never
# strings).
function Test-E1BrokerCapabilityIntInRange($Value, [int]$Minimum, [int]$Maximum) {
  if ($Value -isnot [int] -and $Value -isnot [long] -and $Value -isnot [double]) { return $false }
  if ($Value -is [double] -and $Value -ne [math]::Floor($Value)) { return $false }
  $intValue = [int]$Value
  return $intValue -ge $Minimum -and $intValue -le $Maximum
}

# "A dictionary of primitive-shaped values" -- the OUTER shape check only.
# Deliberately shallow: guest.invoke_bundle's BundleName-specific argument
# schema (evidence1-guest-bundle-contract.psm1's own
# Assert-E1GuestBundleArguments) and artifacts.copy_read_only's SpecName-
# specific argument schema (evidence1-artifact-copy-contract.psm1's own
# Assert-E1ArtifactCopyArguments) each already validate their OWN nested
# argument shape once evidence1-broker-capability-dispatch-core.psm1 calls
# into them -- this function does not re-implement either, it only confirms
# "Arguments" is dictionary-or-JSON-object-shaped at all.
function Test-E1BrokerCapabilityArgumentsContainer($Value) {
  if ($null -eq $Value) { return $true }
  return ($Value -is [Collections.IDictionary]) -or ($Value -is [System.Management.Automation.PSCustomObject])
}

# Returns the property/key NAMES of $Value regardless of whether it is a raw
# dictionary ([ordered]@{}, e.g. a request built in-memory by a test or a
# queue-client module before ever touching JSON) or a PSCustomObject (e.g.
# the SAME request after a real ConvertFrom-Json round-trip, which is what
# evidence1-host-broker-capability-dispatch.ps1 actually reads off disk).
# Same idiom evidence1-validation-forensics.psm1:98 already uses, and every
# *-contract.psm1 module in this repo already needed once its own
# shape-assert was actually exercised against both shapes (see
# docs/audits/evidence1-phase3c-architecture-note.md section 10.3) -- applied
# here from the start, not retrofitted after a real failure.
#
# `.PSObject.Properties.Name` (member-enumeration shorthand) throws
# PropertyNotFoundStrict under Set-StrictMode -Version Latest when
# .Properties is a genuinely EMPTY collection -- confirmed by direct
# execution, not reasoned about: a real request for a zero-argument
# capability (broker.status, get-firewall-sealed-state; arguments = {})
# produces exactly this shape after ConvertFrom-Json and would throw here,
# uncaught by the caller's own intent, during real dispatch. Piping through
# ForEach-Object instead of dotting into .Name directly avoids the
# member-enumeration path entirely -- confirmed fixed by direct execution
# against the same empty-PSCustomObject repro. Found during Round C's own
# verification of this round's (Round A's) already-committed code; fixed
# here rather than deferred, per this engagement's own "verify a scanner's
# real read surface" / fix-what-you-find discipline. The same general
# .PSObject.Properties.Name pattern exists in roughly 30 other files in this
# repo; NOT audited or touched here -- flagged as a separate, dedicated
# follow-up (this fix is scoped to the one instance confirmed to affect real
# capability dispatch today).
function Get-E1BrokerCapabilityPropertyNames($Value) {
  if ($null -eq $Value) { return @() }
  if ($Value -is [Collections.IDictionary]) { return @($Value.Keys) }
  return @($Value.PSObject.Properties | ForEach-Object { $_.Name })
}

# Reads one named value out of $Container regardless of whether it is a
# dictionary (['key'] indexing) or a PSCustomObject (only .key /
# .PSObject.Properties[key].Value works). A real, easy-to-hit mistake this
# function exists to prevent every call site from repeating independently.
function Get-E1BrokerCapabilityValue($Container, [string]$Key) {
  if ($null -eq $Container) { return $null }
  if ($Container -is [Collections.IDictionary]) {
    if (-not $Container.Contains($Key)) { return $null }
    return $Container[$Key]
  }
  $property = $Container.PSObject.Properties[$Key]
  if ($null -eq $property) { return $null }
  return $property.Value
}

# Converts a dictionary-or-PSCustomObject "Arguments" container into a real
# [ordered] dictionary suitable for a [hashtable]-typed parameter
# (Invoke-E1GuestBundle -Arguments, Copy-E1ArtifactsReadOnly -Arguments both
# require this). Also fixes the EXACT bug class
# docs/audits/evidence1-phase3c-architecture-note.md section 10.5 already
# found and fixed once in evidence1-run.ps1 itself: a JSON array becomes a
# plain System.Object[] after ConvertFrom-Json, never [string[]], but
# evidence1-guest-bundle-contract.psm1's own argument validators (e.g.
# LoginStatusArgs) require -is [string[]] exactly. Any all-string
# object[]/array value is cast to [string[]] here, once, so every capability
# that carries a nested string-array bundle/spec argument gets this fix for
# free instead of re-discovering it. Never guesses at other type coercions --
# an array containing anything other than strings is left as-is and will
# fail the deeper bundle/spec validator honestly, the same as it would have
# before this function existed.
function ConvertTo-E1BrokerCapabilityHashtable($Container) {
  $result = [ordered]@{}
  if ($null -eq $Container) { return $result }
  foreach ($key in (Get-E1BrokerCapabilityPropertyNames $Container)) {
    $value = Get-E1BrokerCapabilityValue $Container $key
    if ($value -is [array] -and $value.Count -gt 0 -and (@($value | Where-Object { $_ -isnot [string] }).Count -eq 0)) {
      $result[$key] = [string[]]$value
    } else {
      $result[$key] = $value
    }
  }
  return $result
}

# Validates $Arguments against $Capability's own declared argument_schema:
# every declared key must be present, no undeclared key may be present, and
# each value must pass that argument's own validator -- identical discipline
# to Assert-E1GuestBundleArguments, one layer up (capability-level, not
# bundle-level).
function Assert-E1BrokerCapabilityArguments([string]$Capability, $Arguments) {
  Assert-E1BrokerCapabilityName $Capability
  $entry = (Get-E1BrokerCapabilityRegistry)[$Capability]
  if ($null -eq $Arguments) { $Arguments = [ordered]@{} }
  $suppliedKeys = @(Get-E1BrokerCapabilityPropertyNames $Arguments | Sort-Object)
  $declaredKeys = @($entry.argument_schema.Keys | Sort-Object)
  if (@(Compare-Object $suppliedKeys $declaredKeys).Count -ne 0) {
    throw "broker_capability_arguments_shape_invalid: $Capability expects exactly [$($declaredKeys -join ', ')]"
  }
  foreach ($key in $declaredKeys) {
    $validator = $entry.argument_schema[$key]
    $value = Get-E1BrokerCapabilityValue $Arguments $key
    $ok = & $validator $value
    if ($ok -ne $true) { throw "broker_capability_argument_invalid: $Capability.$key" }
  }
}

# Canonical-GUID 'D' format, case-sensitive round trip, reject Empty -- the
# exact idiom already used throughout this codebase (confirmed by grep
# across docs/audits, e.g. evidence1-hyperv-verify-guest-dual-auth-direct.ps1:93,
# evidence1-live-run-contract.psm1:251) -- copied, not reinvented.
function Assert-E1BrokerCapabilityOperationId([string]$OperationId) {
  $parsed = [guid]::Empty
  if ([string]::IsNullOrEmpty($OperationId) -or
      -not [guid]::TryParseExact($OperationId, 'D', [ref]$parsed) -or
      $parsed -eq [guid]::Empty -or
      $OperationId -cne $parsed.ToString('D')) {
    throw 'broker_capability_operation_id_invalid'
  }
}

# 'yyyy-MM-ddTHH:mm:ss.fffZ' shape check -- the same UTC-timestamp string
# shape every receipt/result in this codebase already uses (compare
# evidence1-run-manifest-contract.psm1's own private Test-E1RunManifestUtcTimestamp).
# A small, independent, per-file copy rather than importing another
# contract's private helper -- this module stays a dependency-free leaf (see
# this file's own header) and the maintainer's standing instruction is not
# to consolidate this class of duplication right now (Phase 3c architecture
# note, open question 5).
function Test-E1BrokerCapabilityUtcTimestampString($Value) {
  if ($Value -is [DateTime]) {
    $Value = $Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
  }
  if ($Value -isnot [string]) { return $false }
  if ($Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') { return $false }
  $parsed = [DateTime]::MinValue
  return [DateTime]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture,
    ([Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal), [ref]$parsed)
}

function Get-E1BrokerCapabilityRequestRequiredKeys {
  return @('schema', 'operation_id', 'capability', 'requested_at_utc', 'arguments')
}

# PUBLIC constructor. Validates eagerly (same discipline as
# New-E1RunStateReceipt/New-E1NetworkModeResult -- a caller cannot construct
# a request this module would itself reject as malformed).
function New-E1BrokerCapabilityRequest {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Capability,
    [Parameter(Mandatory)][string]$OperationId,
    [Parameter(Mandatory)][string]$RequestedAtUtc,
    $Arguments = $null
  )
  Assert-E1BrokerCapabilityName $Capability
  Assert-E1BrokerCapabilityOperationId $OperationId
  if (-not (Test-E1BrokerCapabilityUtcTimestampString $RequestedAtUtc)) { throw 'broker_capability_requested_at_utc_invalid' }
  $argumentsHashtable = ConvertTo-E1BrokerCapabilityHashtable $Arguments
  Assert-E1BrokerCapabilityArguments $Capability $argumentsHashtable
  return [ordered]@{
    schema           = Get-E1BrokerCapabilitySchemaVersion
    operation_id     = $OperationId
    capability       = $Capability
    requested_at_utc = $RequestedAtUtc
    arguments        = $argumentsHashtable
  }
}

# Closed outer-envelope shape check: exact 5 keys, schema pinned, capability
# in the closed registry, operation_id a canonical GUID, requested_at_utc a
# valid UTC timestamp string, and arguments valid for that specific
# capability -- composed from the smaller asserts above, mirroring how
# Assert-E1RunManifestShape composes its own sub-asserts.
function Assert-E1BrokerCapabilityRequestShape($Request) {
  if ($null -eq $Request) { throw 'broker_capability_request_missing' }
  $actual = @(Get-E1BrokerCapabilityPropertyNames $Request | Sort-Object)
  $expected = @(Get-E1BrokerCapabilityRequestRequiredKeys | Sort-Object)
  if (@(Compare-Object $actual $expected).Count -ne 0) { throw 'broker_capability_request_shape_invalid' }
  if ([int](Get-E1BrokerCapabilityValue $Request 'schema') -ne (Get-E1BrokerCapabilitySchemaVersion)) {
    throw 'broker_capability_request_schema_invalid'
  }
  $capability = [string](Get-E1BrokerCapabilityValue $Request 'capability')
  Assert-E1BrokerCapabilityName $capability
  Assert-E1BrokerCapabilityOperationId ([string](Get-E1BrokerCapabilityValue $Request 'operation_id'))
  if (-not (Test-E1BrokerCapabilityUtcTimestampString (Get-E1BrokerCapabilityValue $Request 'requested_at_utc'))) {
    throw 'broker_capability_requested_at_utc_invalid'
  }
  Assert-E1BrokerCapabilityArguments $capability (Get-E1BrokerCapabilityValue $Request 'arguments')
}

# A request older than Get-E1BrokerCapabilityRequestExpirySeconds (or
# timestamped after $NowUtc at all -- these run on one host, so a
# request "from the future" indicates a corrupted or malicious timestamp,
# not benign clock skew across machines) is rejected. $NowUtc is always
# caller-injected (never [DateTime]::UtcNow read directly in here) so this
# is deterministically testable without a real clock -- the same DI
# discipline ADR-S4's Clock boundary already established elsewhere in this
# codebase.
function Assert-E1BrokerCapabilityRequestFresh($Request, [DateTime]$NowUtc) {
  if ($NowUtc.Kind -ne [DateTimeKind]::Utc) { throw 'broker_capability_now_utc_must_be_utc_kind' }
  $requestedAtText = [string](Get-E1BrokerCapabilityValue $Request 'requested_at_utc')
  $requestedAt = [DateTime]::Parse($requestedAtText, [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
  $ageSeconds = ($NowUtc - $requestedAt).TotalSeconds
  if ($ageSeconds -lt 0 -or $ageSeconds -gt (Get-E1BrokerCapabilityRequestExpirySeconds)) {
    throw 'broker_capability_request_expired'
  }
}

# The closed set of DISPATCH-LEVEL reason codes -- i.e. reasons the envelope
# itself rejects a request BEFORE (or instead of) ever calling the
# capability's own already-built function. Distinct from each capability's
# OWN reason-code vocabulary (vm_state_*, network_backend_*, guest_bundle_*,
# artifact_copy_*), which continues to live inside that capability's own
# result, carried through verbatim in the response's "result" field -- this
# envelope does not re-encode or replace them.
function Get-E1BrokerCapabilityReasonCodes {
  return @(
    'broker_capability_request_shape_invalid',
    'broker_capability_request_schema_invalid',
    'broker_capability_name_invalid',
    'broker_capability_operation_id_invalid',
    'broker_capability_requested_at_utc_invalid',
    'broker_capability_arguments_shape_invalid',
    'broker_capability_argument_invalid',
    'broker_capability_request_expired',
    'broker_capability_replay_rejected',
    'broker_capability_path_argument_outside_root',
    'broker_capability_function_failed'
  )
}

# Splits a thrown exception's Message on the FIRST ':' and returns the
# trimmed prefix -- this codebase's own established "stable_identifier:
# $dynamic_detail" convention (confirmed by direct audit,
# docs/audits/evidence1-phase3c-architecture-note.md section 13.3), applied
# here so a capability's own dynamic failure detail never leaks into this
# envelope's reason_code field, which callers may reasonably match on.
function Get-E1BrokerCapabilityReasonCodePrefix([string]$ExceptionMessage) {
  if ([string]::IsNullOrWhiteSpace($ExceptionMessage)) { return 'broker_capability_function_failed' }
  $colonIndex = $ExceptionMessage.IndexOf(':')
  if ($colonIndex -lt 0) { return $ExceptionMessage.Trim() }
  return $ExceptionMessage.Substring(0, $colonIndex).Trim()
}

function Get-E1BrokerCapabilityResponseRequiredKeys {
  return @('schema', 'operation_id', 'capability', 'verdict', 'reason_code', 'result', 'generated_at_utc')
}

# PUBLIC constructor for the one terminal response every dispatched
# operation produces -- mirrors New-E1RunStateReceipt's role of wrapping
# whatever a capability call returned under one consistent outer shape.
function New-E1BrokerCapabilityResponse {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$OperationId,
    [Parameter(Mandatory)][string]$Capability,
    [Parameter(Mandatory)][ValidateSet('PASS', 'FAIL')][string]$Verdict,
    [string]$ReasonCode = $null,
    $Result = $null
  )
  Assert-E1BrokerCapabilityOperationId $OperationId
  Assert-E1BrokerCapabilityName $Capability
  if ($Verdict -ceq 'FAIL' -and [string]::IsNullOrWhiteSpace($ReasonCode)) { throw 'broker_capability_response_fail_missing_reason' }
  return [ordered]@{
    schema           = Get-E1BrokerCapabilitySchemaVersion
    operation_id     = $OperationId
    capability       = $Capability
    verdict          = $Verdict
    reason_code      = $ReasonCode
    result           = $Result
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
}

function Assert-E1BrokerCapabilityResponseShape($Response) {
  if ($null -eq $Response) { throw 'broker_capability_response_missing' }
  $actual = @(Get-E1BrokerCapabilityPropertyNames $Response | Sort-Object)
  $expected = @(Get-E1BrokerCapabilityResponseRequiredKeys | Sort-Object)
  if (@(Compare-Object $actual $expected).Count -ne 0) { throw 'broker_capability_response_shape_invalid' }
  if ([int](Get-E1BrokerCapabilityValue $Response 'schema') -ne (Get-E1BrokerCapabilitySchemaVersion)) {
    throw 'broker_capability_response_schema_invalid'
  }
  Assert-E1BrokerCapabilityOperationId ([string](Get-E1BrokerCapabilityValue $Response 'operation_id'))
  Assert-E1BrokerCapabilityName ([string](Get-E1BrokerCapabilityValue $Response 'capability'))
  $verdict = [string](Get-E1BrokerCapabilityValue $Response 'verdict')
  if ($verdict -cnotin @('PASS', 'FAIL')) { throw 'broker_capability_response_verdict_invalid' }
  if ($verdict -ceq 'FAIL' -and [string]::IsNullOrWhiteSpace([string](Get-E1BrokerCapabilityValue $Response 'reason_code'))) {
    throw 'broker_capability_response_fail_missing_reason'
  }
}

# Local copy of this codebase's established Assert-PathInside idiom
# (evidence1-host-elevated-runner.ps1, evidence1-host-elevated-runner-client.ps1,
# evidence1-host-elevated-runner-install.ps1, evidence1-run.ps1 all carry
# their own copy already -- see evidence1-phase3c-architecture-note.md open
# question 5 on why this duplication is deliberate, not an oversight).
# Deliberately named with this module's own prefix, not the bare
# "Assert-PathInside" every script-level copy uses -- this is the one place
# in this engagement such a helper is EXPORTED from a module rather than
# staying a script-local function, so it needs a collision-proof name: two
# modules imported together into the same Pester session that both exported
# a generic "Assert-PathInside" would silently shadow one another, exactly
# the module-shadowing bug class this codebase already hit once (Phase 3c
# architecture note section 10.1) and fixed with -Global imports -- avoided
# here structurally by never creating the collision in the first place.
function Assert-E1BrokerCapabilityPathInside([string]$Candidate, [string]$Root) {
  $candidateFull = [System.IO.Path]::GetFullPath($Candidate)
  $rootFull = ([System.IO.Path]::GetFullPath($Root)).TrimEnd('\') + '\'
  if (-not $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'broker_capability_path_argument_outside_root'
  }
  return $candidateFull
}

function Assert-E1BrokerCapabilityPathArgument([string]$Path) {
  return Assert-E1BrokerCapabilityPathInside $Path (Get-E1BrokerCapabilityTrustedRootLiteral)
}

# Every path-shaped argument this capability declares (registry's own
# path_arguments list), confined -- called by the dispatcher BEFORE the
# underlying capability function is ever invoked, structural step 4 of the
# validation order this round's task specifies.
function Assert-E1BrokerCapabilityPathArguments([string]$Capability, $Arguments) {
  Assert-E1BrokerCapabilityName $Capability
  $entry = (Get-E1BrokerCapabilityRegistry)[$Capability]
  foreach ($key in @($entry.path_arguments)) {
    $null = Assert-E1BrokerCapabilityPathArgument ([string](Get-E1BrokerCapabilityValue $Arguments $key))
  }
}

# Pure, no I/O: derives the three sibling queue directories both the client
# and the elevated dispatcher agree on, from one shared QueueRoot -- so
# layout can never drift between the two sides of the elevation boundary.
# Siblings of the pre-existing requests/responses/in-progress/done/logs
# directories evidence1-host-elevated-runner.ps1 already owns under the same
# QueueRoot -- a new, separate, capability-scoped namespace, not a
# repurposing of the generic transport directories those five already are.
function Get-E1BrokerCapabilityQueuePaths([string]$QueueRoot) {
  $root = [System.IO.Path]::GetFullPath($QueueRoot)
  return [ordered]@{
    requests_dir   = Join-Path $root 'capability-requests'
    responses_dir  = Join-Path $root 'capability-responses'
    operations_dir = Join-Path $root 'capability-operations'
  }
}

Export-ModuleMember -Function `
  Get-E1BrokerCapabilitySchemaVersion, `
  Get-E1BrokerCapabilityDefaultTimeoutMinutes, `
  Get-E1BrokerCapabilityRequestExpirySeconds, `
  Get-E1BrokerCapabilityTrustedRootLiteral, `
  Get-E1BrokerCapabilityRegistry, `
  Get-E1BrokerCapabilityNames, `
  Assert-E1BrokerCapabilityName, `
  Test-E1BrokerCapabilityIntInRange, `
  Test-E1BrokerCapabilityArgumentsContainer, `
  Get-E1BrokerCapabilityPropertyNames, `
  Get-E1BrokerCapabilityValue, `
  ConvertTo-E1BrokerCapabilityHashtable, `
  Assert-E1BrokerCapabilityArguments, `
  Assert-E1BrokerCapabilityOperationId, `
  Test-E1BrokerCapabilityUtcTimestampString, `
  Get-E1BrokerCapabilityRequestRequiredKeys, `
  New-E1BrokerCapabilityRequest, `
  Assert-E1BrokerCapabilityRequestShape, `
  Assert-E1BrokerCapabilityRequestFresh, `
  Get-E1BrokerCapabilityReasonCodes, `
  Get-E1BrokerCapabilityReasonCodePrefix, `
  Get-E1BrokerCapabilityResponseRequiredKeys, `
  New-E1BrokerCapabilityResponse, `
  Assert-E1BrokerCapabilityResponseShape, `
  Assert-E1BrokerCapabilityPathInside, `
  Assert-E1BrokerCapabilityPathArgument, `
  Assert-E1BrokerCapabilityPathArguments, `
  Get-E1BrokerCapabilityQueuePaths

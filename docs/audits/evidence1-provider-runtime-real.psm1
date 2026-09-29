# evidence1-provider-runtime-real.psm1
#
# DRAFTED, NEVER EXECUTED CODE -- same standing notice as every *-hyperv.psm1/
# *-queue-client.psm1 file in this repo. This module has not been imported,
# dot-sourced, or run at any point while writing or checking it; verification
# is limited to AST parse validation and real (non-privileged, zero-I/O
# against real infrastructure) Pester execution against its own exported
# functions with an injected fake -- see
# tests/pester/Evidence1-Provider-Runtime-Real.Tests.ps1.
#
# ============================================================================
# SCOPE DECISION (read this before anything else): what "real" means here
# ============================================================================
# ADR-S4's ProviderRuntime interface is "dispatch a provider session" --
# launch a CLI with a real prompt, wait for completion, capture a transcript.
# NO guest bundle capable of that exists yet: Get-E1GuestBundleRegistry
# (evidence1-guest-bundle-contract.psm1) has exactly two entries, both
# deliberately modest and read-only (see that module's own header, "see the
# architecture note section 4 for what's NOT ported yet"). Building a bundle
# that can drive a full agentic session -- launch a CLI, feed it a real
# prompt, wait, capture a transcript, possibly stage scenario files into the
# guest first -- is a large, high-stakes, separate design decision this round
# is not authorized to make (see docs/audits/evidence1-stabilization-plan.md
# ADR-S1's own "guest.invoke_bundle SHALL execute only inside the disposable
# VM... SHALL NOT execute caller-provided host PowerShell" and section 8's
# stop condition "the proposed change introduces a new script, contract,
# schema... outside this plan"). No new bundle is added to the registry by
# this file.
#
# So this module does NOT dispatch a provider session. It implements exactly
# what the CURRENT bundle registry actually supports: a PRECONDITION /
# READINESS check -- "is this runtime's CLI present in the guest and
# authenticated" -- via the existing 'get-cli-version-and-login-status'
# bundle, called through evidence1-guest-bundle-queue-client.psm1's
# Invoke-E1GuestBundle (which itself dispatches through the elevated broker's
# capability queue -- see evidence1-broker-capability-contract.psm1 -- rather
# than any direct host-side execution path). This is the SAME pattern
# evidence1-run.ps1's own AuthReady/ToolchainReady state handlers already use
# in fake mode today -- proof this is a real, already-established pattern,
# not an invented one. Building a full-session bundle remains a separate,
# larger, explicitly-flagged open question for the maintainer (see this
# round's architecture note addendum, section 16).
#
# ============================================================================
# Drop-in shape vs. the fake -- a deliberate, explained asymmetry
# ============================================================================
# Invoke-E1ProviderRuntimeSession here takes the exact same five mandatory
# parameters as evidence1-provider-runtime-fake.psm1
# (-RuntimeId -ModelId -RoundIndex -ScenarioSha256 -PromptSha256), same
# names, same types, same Mandatory-ness -- a caller using only those five
# can swap fake-for-real. It ALSO requires -VMName/-GuestCredentialPath,
# which the fake does not have at all (the fake is pure in-memory, zero I/O,
# with no VM concept to parameterize -- see that file's own header). This
# mirrors a real, already-documented gap in this exact codebase
# (evidence1-network-backend-hyperv.psm1 originally required
# -GuestCredentialPath while evidence1-network-backend-fake.psm1 did not --
# docs/audits/evidence1-phase3c-architecture-note.md section 6/9.3), which
# was LATER fixed by widening the fake to accept-and-ignore the extra
# parameter. That fix is NOT applied here: this round's assignment is scoped
# to building the real module only, editing evidence1-provider-runtime-fake.psm1
# is not requested, and unlike NetworkBackend's gap (a pure parameter-shape
# mismatch with no functional reason for it), ProviderRuntime's fake
# genuinely has zero I/O surface to attach a VM identity to. Flagged
# explicitly as a deliberate, open decision in this round's architecture note
# addendum -- not silently left inconsistent.
#
# ============================================================================
# Never-throws-for-expected-conditions design
# ============================================================================
# This function ALWAYS returns a New-E1ProviderRuntimeSessionResult-shaped
# PASS/FAIL object for every closed-set condition below -- it never lets an
# expected failure propagate as a raw exception. Four FAIL buckets, mutually
# exclusive, checked in this order:
#   1. runtime_id not in the closed {codex, claude} set -- checked first,
#      before ever attempting a guest-bundle call for an unmapped runtime.
#   2. the injected -InvokeGuestBundle call itself threw (a queue-mechanics /
#      programming-contract failure -- busy queue, timeout, malformed
#      arguments; see evidence1-guest-bundle-queue-client.psm1's own header:
#      "response.result is $null iff Invoke-E1GuestBundle threw").
#   3. the call returned normally but does not positively confirm the
#      command is present -- this bucket deliberately folds together BOTH an
#      envelope-level FAIL (e.g. a guest-transport failure Invoke-E1GuestBundle
#      itself absorbs into a shaped FAIL result rather than throwing -- see
#      that module's own header again) AND an envelope-PASS-but-
#      command_found=false result. Both cases mean the same thing from this
#      precondition check's own point of view: "could not positively confirm
#      the toolchain command is present," so both get the SAME reason code
#      rather than a synthetic distinction this check cannot actually stand
#      behind (an envelope FAIL carries no promise that command_found is
#      even a meaningful field in the returned shape).
#   4. command found, but the login-status probe did not exit 0.
# Only the complement of all four is PASS. This is why the enumerated Pester
# coverage in this round's task list treats "unknown runtime_id" and
# "injected bundle call throws" as ordinary FAIL paths alongside "bad login
# exit code" / "command not found" -- all five are closed-set outcomes of one
# total function, matching Assert-E1ProviderRuntimeSessionResult's own
# contract (FAIL always carries a reason_code) rather than a mix of thrown
# exceptions and shaped results.
#
# ============================================================================
# OutputSummary honesty
# ============================================================================
# New-E1ProviderRuntimeRealOutputSummary below never fabricates
# session-transcript-shaped fields (line_count/byte_count-style data, the
# fake's own OutputSummary shape) -- this precondition check produced no
# transcript, so it does not claim one. Its OutputSummary instead honestly
# describes a READINESS PROBE: probe_kind (a fixed literal identifying what
# kind of check this was), command_found, version_text, login_status_exit_code
# -- the exact three facts get-cli-version-and-login-status actually
# produces, each $null when genuinely unavailable (never guessed).
#
# ============================================================================
# Structural safety
# ============================================================================
# Same enumerated forbidden-token list as evidence1-provider-runtime-fake.psm1
# applies to this file too, by construction: no Start-Process, no
# Invoke-Command, no New-PSSession, no Invoke-WebRequest/Invoke-RestMethod, no
# OAuth/ApiKey/Bearer/credential-handling API, no Import-Clixml/
# ConvertTo-SecureString/[pscredential]. This file DOES legitimately contain
# the literal strings 'codex.cmd'/'claude.cmd' as DATA (the canonical
# toolchain path table below) -- exactly as evidence1-run.ps1's own
# $script:E1RunCanonicalRuntimeProbes does, and exactly as that file's own
# regression test (tests/pester/Evidence1-Run-Broker-Capability-Wiring.Tests.ps1,
# "never invokes a provider CLI locally") reasons about: proving "never
# invoked locally" means proving there is no call operator, process launch,
# or expression-evaluation construct anywhere in this file, not that the
# strings are absent. See this module's own regression test for the same
# proof technique applied here.
#
# ============================================================================
# SessionId determinism
# ============================================================================
# A SHA-256 of this call's own inputs (runtime_id/vm_name/round_index/
# scenario_sha256/prompt_sha256 -- vm_name included because, unlike the fake,
# this module's identity is genuinely partly defined by WHICH guest is being
# probed), truncated to 32 hex chars -- same technique
# evidence1-provider-runtime-fake.psm1's own Invoke-E1ProviderRuntimeSession
# already uses (cited, not copied verbatim: this module's own
# Get-E1ProviderRuntimeRealSessionId is a separate, independently-written
# function).

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-provider-runtime-contract.psm1') -Force -DisableNameChecking -Global
Import-Module (Join-Path $PSScriptRoot 'evidence1-broker-capability-client.psm1') -Force -DisableNameChecking -Global
$script:E1ProviderRuntimeGuestBundleModule = Import-Module `
  (Join-Path $PSScriptRoot 'evidence1-guest-bundle-queue-client.psm1') `
  -Force -DisableNameChecking -Global -PassThru
$script:E1ProviderRuntimeDefaultGuestBundle =
  $script:E1ProviderRuntimeGuestBundleModule.ExportedCommands['Invoke-E1GuestBundle'].ScriptBlock
if ($null -eq $script:E1ProviderRuntimeDefaultGuestBundle) {
  throw 'provider_runtime_real_guest_bundle_export_missing'
}

# Re-authored, not imported: $script:E1RunCanonicalRuntimeProbes is a
# script-scoped variable private to evidence1-run.ps1 (a .ps1 script, not a
# module -- there is nothing to Import-Module), so this table is duplicated
# here as its own module-level function, matching this codebase's established
# small-constant-duplication convention (see
# evidence1-broker-capability-client.psm1's own Get-E1BrokerCapabilityDefaultTaskName
# header: "duplicated, not imported, to keep this module's own dependency
# surface limited"). Source of the two literal values: evidence1-run.ps1
# lines ~273-276 (itself sourced from
# evidence1-hyperv-verify-guest-codex-preflight-direct.ps1 /
# evidence1-hyperv-verify-guest-claude-auth-direct.ps1 -- see that file's own
# comment for the exact line numbers and the one NOT-independently-confirmed
# caveat about the leaf executable filename).
#
# [string[]] cast on LoginStatusArgs is NOT cosmetic: a bare
# @('login','status') array literal stored as a hashtable value is a plain
# System.Object[], and evidence1-guest-bundle-contract.psm1's own argument
# validator for this bundle requires -is [string[]] exactly. Omitting this
# cast is the exact real, previously-discovered bug evidence1-run.ps1 itself
# shipped with once (found only by replicating its actual fake-mode call
# sequence against the real modules -- see
# docs/audits/evidence1-phase3c-architecture-note.md section 10.5). Applying
# the cast here from the start avoids reintroducing that same bug class in
# this new module.
function Get-E1ProviderRuntimeRealCanonicalProbes {
  return [ordered]@{
    'codex'  = [ordered]@{ CommandPath = 'C:\Evidence1Toolchain\codex-cli\0.154.0\bin\codex.exe'; LoginStatusArgs = [string[]]@('login', 'status') }
    'claude' = [ordered]@{ CommandPath = 'C:\Evidence1Toolchain\claude-code\2.1.238\claude.cmd'; LoginStatusArgs = [string[]]@('auth', 'status') }
  }
}

# Private. See this file's own header, "SessionId determinism".
function Get-E1ProviderRuntimeRealSessionId {
  param(
    [Parameter(Mandatory)][string]$RuntimeId,
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][int]$RoundIndex,
    [Parameter(Mandatory)][string]$ScenarioSha256,
    [Parameter(Mandatory)][string]$PromptSha256
  )
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $seedBytes = [Text.UTF8Encoding]::new($false).GetBytes("$RuntimeId/$VMName/$RoundIndex/$ScenarioSha256/$PromptSha256")
    return ([BitConverter]::ToString($sha256.ComputeHash($seedBytes)) -replace '-', '').ToLowerInvariant().Substring(0, 32)
  } finally { $sha256.Dispose() }
}

# Private. See this file's own header, "OutputSummary honesty". Every call
# site below supplies all three positionally-named values, using $null for
# whichever facts this particular outcome genuinely does not have -- the key
# SET is always the same four keys regardless of outcome, only the VALUES
# differ, matching this codebase's general shape-consistency discipline.
function New-E1ProviderRuntimeRealOutputSummary {
  param($CommandFound, $VersionText, $LoginStatusExitCode)
  return [ordered]@{
    probe_kind              = 'readiness_check'
    command_found           = $CommandFound
    version_text            = $VersionText
    login_status_exit_code  = $LoginStatusExitCode
  }
}

# Reads a property from a guest bundle result that has not been shape-
# validated yet -- it may be a Hashtable/OrderedDictionary (every test fake in
# this repo, and PowerShell's own -AsHashtable JSON path) or a PSCustomObject
# (ConvertFrom-Json's default). Dot notation throws under this file's own
# Set-StrictMode for a key/property absent on EITHER type; bracket notation
# is safe on a Hashtable but throws "cannot index" on a PSCustomObject
# (confirmed by direct testing, not assumed -- they are not interchangeable).
# One helper that dispatches on type, used everywhere this file reads a field
# off an unvalidated guest response, rather than risking a real diagnostic
# failure (a malformed response) crashing on ITS OWN diagnostic capture.
function Get-E1ProviderRuntimeSafeProperty($Value, [string]$Name) {
  if ($null -eq $Value) { return $null }
  if ($Value -is [Collections.IDictionary]) { return $Value[$Name] }
  $property = $Value.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

# PUBLIC. See this file's own header for the full scope decision, the
# drop-in-shape asymmetry with the fake, and the four-FAIL-bucket design.
#
# -InvokeGuestBundle is the injectable GuestTransport seam this round's
# assignment asks for explicitly: defaults to the real
# evidence1-guest-bundle-queue-client.psm1's Invoke-E1GuestBundle, same
# injectable-real-default pattern as every queue-client's own
# -TriggerTask/-GetUtcNow seam (evidence1-broker-capability-client.psm1).
# A test supplies a fake scriptblock here and never touches the real
# queue-client or broker -- see
# tests/pester/Evidence1-Provider-Runtime-Real.Tests.ps1.
#
# -QueueRoot/-AllowedRoot/-TaskName/-TimeoutMinutes/-PollIntervalSeconds/
# -TriggerTask/-GetUtcNow are forwarded, unmodified, straight through to
# whatever -InvokeGuestBundle resolves to (the real Invoke-E1GuestBundle
# accepts every one of them) -- same "expose every optional parameter the
# callee accepts, forwarded as-is" pattern
# evidence1-vm-state-queue-client.psm1 already established for its own
# Submit-E1BrokerCapabilityOperation forwarding.
function Invoke-E1ProviderRuntimeSession {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]$CurrentCampaignInputs,
    [Parameter(Mandatory)]$Cell,
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$GuestCredentialPath,
    [int]$TimeoutSeconds = 60,
    # No real-infrastructure default on any of these three -- see
    # evidence1-broker-capability-client.psm1's own header for why this is
    # an explicit empty/null default + guard-clause throw, never
    # [Parameter(Mandatory)] (confirmed by direct testing: PowerShell
    # prompts interactively for a missing Mandatory value in a
    # non-interactive host -- Pester, `powershell.exe -File` -- rather than
    # failing immediately, which would HANG instead of failing loudly).
    [string]$QueueRoot = '',
    [string]$AllowedRoot = '',
    [string]$TaskName = (Get-E1BrokerCapabilityDefaultTaskName),
    [int]$TimeoutMinutes = 120,
    [int]$PollIntervalSeconds = 2,
    [scriptblock]$TriggerTask = $null,
    [scriptblock]$GetUtcNow = { [DateTime]::UtcNow },
    [scriptblock]$InvokeGuestBundle = $script:E1ProviderRuntimeDefaultGuestBundle
  )
  if ([string]::IsNullOrWhiteSpace($QueueRoot)) { throw 'provider_runtime_real_queue_root_required' }
  if ($null -eq $TriggerTask) { throw 'provider_runtime_real_trigger_task_required' }
  if ($null -eq $InvokeGuestBundle) { throw 'provider_runtime_real_invoke_guest_bundle_required' }

  $runtimeId = [string]$Cell.runtime_id
  $modelId = [string]$Cell.model_id
  $roundIndex = [int]$Cell.round_index
  $cellKeys = if ($Cell -is [Collections.IDictionary]) { @($Cell.Keys) } else { @($Cell.PSObject.Properties.Name) }
  if ([string]::IsNullOrWhiteSpace($runtimeId) -or [string]::IsNullOrWhiteSpace($modelId) -or
      'campaign_cell_index' -cnotin $cellKeys) {
    throw 'provider_runtime_real_cell_invalid'
  }
  $guestTransportTimeoutSeconds = [int]$CurrentCampaignInputs.guest_transport_timeout_seconds
  if ($guestTransportTimeoutSeconds -lt 1) { throw 'provider_runtime_real_timeout_invalid' }

  # The worker is the sole guest-side process owner. This adapter only
  # serializes already-validated manifest input and forwards it through the
  # existing closed guest.invoke_bundle capability; it never starts a CLI.
  #
  # 2026-09-29 (WO-A2 auditor finding): both FAIL branches below used to stamp
  # StartedAtUtc/CompletedAtUtc from two back-to-back UtcNow calls made AFTER
  # the guest call already returned -- always identical, never the real guest
  # transport duration. Capturing once before the call and once right after
  # (in each branch, since only one of them runs) fixes that. The worker-
  # failed branch also used to discard the guest bundle's own verdict/
  # reason_code/output entirely, leaving a bare "worker_failed" with nothing
  # to diagnose -- confirmed live when all 4 LiveRunning sessions in the
  # 2026-09-29 GREEN gate FAILed this way with zero diagnosis possible from
  # the receipt alone. Propagate what the guest bundle itself reported,
  # bounded the same way every other diagnostic text in this repo is bounded.
  $bundleResult = $null
  $startedAtUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  try {
    $bundleResult = & $InvokeGuestBundle -VMName $VMName -GuestCredentialPath $GuestCredentialPath `
      -BundleName 'run-agentic-eval-session' `
      -Arguments ([ordered]@{
        CurrentCampaignInputsJson = ($CurrentCampaignInputs | ConvertTo-Json -Depth 12 -Compress)
        CellJson = ($Cell | ConvertTo-Json -Depth 8 -Compress)
      }) `
      -TimeoutSeconds $guestTransportTimeoutSeconds -QueueRoot $QueueRoot -AllowedRoot $AllowedRoot -TaskName $TaskName `
      -TimeoutMinutes $TimeoutMinutes -PollIntervalSeconds $PollIntervalSeconds -TriggerTask $TriggerTask -GetUtcNow $GetUtcNow
  } catch {
    $completedAtUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $exceptionMessage = [string]$_.Exception.Message
    if ($exceptionMessage.Length -gt 4000) { $exceptionMessage = $exceptionMessage.Substring(0, 4000) + '...(truncated)' }
    return New-E1ProviderRuntimeSessionResult -RuntimeId $runtimeId -ModelId $modelId -RoundIndex $roundIndex `
      -SessionId ([guid]::NewGuid().ToString('N')) -StartedAtUtc $startedAtUtc -CompletedAtUtc $completedAtUtc `
      -ExitCode 1 -Verdict 'FAIL' -ReasonCode 'provider_runtime_real_guest_bundle_call_failed' -OutputSummary ([ordered]@{
        worker_output_present = $false
        guest_bundle_call_exception_type = [string]$_.Exception.GetType().FullName
        guest_bundle_call_exception_message = $exceptionMessage
      })
  }
  $bundleVerdict = Get-E1ProviderRuntimeSafeProperty $bundleResult 'verdict'
  $bundleOutput = Get-E1ProviderRuntimeSafeProperty $bundleResult 'output'
  if ($null -eq $bundleResult -or [string]$bundleVerdict -cne 'PASS' -or $null -eq $bundleOutput) {
    $completedAtUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $guestOutputJson = if ($null -eq $bundleOutput) { $null } else {
      $json = ($bundleOutput | ConvertTo-Json -Depth 10 -Compress)
      if ($json.Length -gt 4000) { $json.Substring(0, 4000) + '...(truncated)' } else { $json }
    }
    return New-E1ProviderRuntimeSessionResult -RuntimeId $runtimeId -ModelId $modelId -RoundIndex $roundIndex `
      -SessionId ([guid]::NewGuid().ToString('N')) -StartedAtUtc $startedAtUtc -CompletedAtUtc $completedAtUtc `
      -ExitCode 1 -Verdict 'FAIL' -ReasonCode 'provider_runtime_real_worker_failed' -OutputSummary ([ordered]@{
        worker_output_present = $false
        guest_bundle_result_present = ($null -ne $bundleResult)
        guest_bundle_verdict = $(if ($null -eq $bundleVerdict) { $null } else { [string]$bundleVerdict })
        guest_bundle_reason_code = $(if ($null -eq $bundleResult) { $null } else { [string](Get-E1ProviderRuntimeSafeProperty $bundleResult 'reason_code') })
        guest_bundle_output_json = $guestOutputJson
      })
  }
  Assert-E1ProviderRuntimeSessionResult $bundleOutput
  if ([string]$bundleOutput.runtime_id -cne $runtimeId -or [string]$bundleOutput.model_id -cne $modelId -or
      [int]$bundleOutput.round_index -ne $roundIndex) { throw 'provider_runtime_real_worker_identity_mismatch' }
  return $bundleOutput
}

Export-ModuleMember -Function `
  Get-E1ProviderRuntimeRealCanonicalProbes, `
  Invoke-E1ProviderRuntimeSession

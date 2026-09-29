# evidence1-provider-runtime-fake.psm1
#
# ADR-S4's fake JSONL/stream ProviderRuntime test double. This is the single
# most safety-sensitive new file this round: LiveRunning's whole job is
# dispatching a provider session, and Phase 5's entire live-budget gate
# exists specifically to control when that becomes real. This file's only
# purpose is to make LiveRunning REACHABLE and testable with fake backends
# without that gate existing yet.
#
# Structural safety property (maintainer's explicit requirement, same bar as
# every other fake in this repo): architecturally incapable of starting a
# real provider, not just "doesn't happen to." The following do not appear
# anywhere below, and the regression tests for this file assert that
# absence directly (see tests/pester/Evidence1-Provider-Runtime-Fake.Tests.ps1):
#   codex.cmd, codex.exe, codex-cli, claude.cmd, claude.exe, claude-code,
#   Start-Process, Invoke-Command, New-PSSession, Invoke-WebRequest,
#   Invoke-RestMethod, System.Net, HttpClient, OAuth, ApiKey, Bearer,
#   Import-Clixml, ConvertTo-SecureString, [pscredential].
# This file spawns no process of any kind (no Start-Process, no Start-Job,
# no & operator invoking an external executable), opens no network
# connection, and reads no credential material. Every "session" it produces
# is computed entirely in memory from its own caller-supplied arguments.
#
# No real implementation exists, or is being built, this round --
# deliberately. Actual provider dispatch is Phase 5, still gated behind the
# ADR-S6 manifest being consumed for real and two consecutive full Phase 4
# rehearsal passes, neither of which exists yet. Building a real
# evidence1-provider-runtime-real.psm1 now, even if evidence1-run.ps1 never
# called it, would still be getting ahead of that gate -- so it does not
# exist. If -UseRealBackends is ever combined with a target state at or past
# LiveAuthorized, evidence1-run.ps1's own guard throws
# Invoke-E1RunNotYetImplementedState before any capability module for this
# interface would even need to be imported; there is intentionally nothing
# for that path to import.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-provider-runtime-contract.psm1') -Force -DisableNameChecking -Global

$script:E1FakeProviderRuntimeInvocations = [Collections.Generic.List[object]]::new()
$script:E1FakeProviderRuntimeSeededResults = @{}

function Reset-E1FakeProviderRuntimeState {
  [CmdletBinding()]
  param()
  $script:E1FakeProviderRuntimeInvocations = [Collections.Generic.List[object]]::new()
  $script:E1FakeProviderRuntimeSeededResults = @{}
}

# Test setup: what the NEXT session for this (RuntimeId, RoundIndex) pair
# should report. Keyed the same way evidence1-guest-bundle-fake.psm1 keys
# its own seeded results -- if nothing was seeded, a session synthesizes a
# deterministic PASS itself (see Invoke-E1ProviderRuntimeSession), so a
# caller-side test that only cares about dispatch/ordering does not need to
# seed anything.
function Set-E1FakeProviderRuntimeResult {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$RuntimeId,
    [Parameter(Mandatory)][int]$RoundIndex,
    [Parameter(Mandatory)][ValidateSet('PASS', 'FAIL')][string]$Verdict,
    [string]$ReasonCode = $null,
    [int]$ExitCode = 0
  )
  $script:E1FakeProviderRuntimeSeededResults["$RuntimeId/$RoundIndex"] = [ordered]@{
    verdict = $Verdict; reason_code = $ReasonCode; exit_code = $ExitCode
  }
}

function Get-E1FakeProviderRuntimeInvocations {
  [CmdletBinding()]
  param()
  return @($script:E1FakeProviderRuntimeInvocations)
}

# The one and only dispatch entry point. Computes a deterministic session_id
# from its own inputs (a SHA-256 of runtime_id/round_index/scenario hash --
# never randomness, so two fake runs with identical manifests produce
# identical session identities), records the call for test assertions, and
# returns a PASS/FAIL session result entirely in memory. No parameter here
# accepts a scriptblock, a command name, or a path to an executable -- unlike
# guest.invoke_bundle's closed-registry design (which structurally prevents
# arbitrary CODE), this prevents arbitrary PROCESS DISPATCH the same way, by
# simply never constructing a process-launch of any kind from any input.
function Invoke-E1ProviderRuntimeSession {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$RuntimeId,
    [Parameter(Mandatory)][string]$ModelId,
    [Parameter(Mandatory)][int]$RoundIndex,
    [Parameter(Mandatory)][string]$ScenarioSha256,
    [Parameter(Mandatory)][string]$PromptSha256
  )
  $startedAtUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  $script:E1FakeProviderRuntimeInvocations.Add([ordered]@{
    runtime_id      = $RuntimeId
    model_id        = $ModelId
    round_index     = $RoundIndex
    scenario_sha256 = $ScenarioSha256
    prompt_sha256   = $PromptSha256
    recorded_at_utc = $startedAtUtc
  })

  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $seedBytes = [Text.UTF8Encoding]::new($false).GetBytes("$RuntimeId/$RoundIndex/$ScenarioSha256/$PromptSha256")
    $sessionId = ([BitConverter]::ToString($sha256.ComputeHash($seedBytes)) -replace '-', '').ToLowerInvariant().Substring(0, 32)
  } finally { $sha256.Dispose() }

  $seedKey = "$RuntimeId/$RoundIndex"
  $seeded = $script:E1FakeProviderRuntimeSeededResults[$seedKey]
  $verdict = if ($seeded) { $seeded.verdict } else { 'PASS' }
  $reasonCode = if ($seeded) { $seeded.reason_code } else { $null }
  $exitCode = if ($seeded) { $seeded.exit_code } else { 0 }
  $completedAtUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')

  return New-E1ProviderRuntimeSessionResult -RuntimeId $RuntimeId -ModelId $ModelId -RoundIndex $RoundIndex `
    -SessionId $sessionId -StartedAtUtc $startedAtUtc -CompletedAtUtc $completedAtUtc -ExitCode $exitCode `
    -Verdict $verdict -ReasonCode $reasonCode -OutputSummary ([ordered]@{ fake = $true; line_count = 1; byte_count = 0 })
}

Export-ModuleMember -Function `
  Reset-E1FakeProviderRuntimeState, `
  Set-E1FakeProviderRuntimeResult, `
  Get-E1FakeProviderRuntimeInvocations, `
  Invoke-E1ProviderRuntimeSession

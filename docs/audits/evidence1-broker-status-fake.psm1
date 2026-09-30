# evidence1-broker-status-fake.psm1
#
# ADR-S4's deterministic broker.status test double. Exports the exact same
# Get-E1BrokerStatus name evidence1-broker-status-real.psm1 exports, so a
# caller written against one behaves identically against the other -- same
# pattern as every other evidence1-*-fake.psm1 in this repo.
#
# Structural safety property (Phase 3c fix-forward round, maintainer's
# explicit requirement): this file must be architecturally incapable of
# touching the real host broker, full stop -- not "doesn't happen to call
# it today." The following tokens do not appear anywhere below, and the
# regression tests for this file assert that absence directly (see
# tests/pester/Evidence1-Broker-Status-Fake.Tests.ps1):
#   Get-ScheduledTask, ScheduledTasks (the module), C:\ProgramData,
#   C:\kmp-eval\scratch\host-elevated-runner-codex (the real queue root),
#   any Hyper-V cmdlet (Get-VM, New-PSSession, etc.), Start-Process,
#   RunAs, codex, claude, Get-Acl, Get-Content, Test-Path, [IO.File].
# This file does no I/O of any kind. Its only dependency is
# evidence1-broker-status-contract.psm1's pure New-E1BrokerStatusResult
# constructor. State lives only in this module's own in-memory variable for
# the lifetime of the importing process -- nothing persists across sessions,
# deliberate for a deterministic fake, matching every sibling fake's own
# documented behavior.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-broker-status-contract.psm1') -Force -DisableNameChecking -Global

# Default state: always a fully-healthy, self-update-capable broker. This is
# the specific property the maintainer's architectural catch was about --
# BrokerReady must not depend on this host's real, already-installed broker
# for a fully-fake rehearsal to reach DryRunPassed. Field values are
# plausible-looking placeholders (never validated against anything real by
# this fake): a 40-hex-char fake commit, a well-formed-looking SID, a schema
# at or above what Get-E1BrokerRequiredManifestSchema requires.
function New-E1FakeBrokerStatusDefaultResult {
  return New-E1BrokerStatusResult -TaskExists $true -Readable $true `
    -DeploymentRoot 'C:\kmp-eval\scratch\fake-broker-deployment' `
    -ManifestSchema (Get-E1BrokerRequiredManifestSchema) `
    -SourceGitCommit ('0' * 40) `
    -PrincipalSid 'S-1-5-21-0000000000-0000000000-0000000000-1001' `
    -ScriptCount 10 `
    -HashesValid $true -AclValid $true -SelfUpdateCapable $true
}

$script:E1FakeBrokerStatusOverride = $null

# Test setup: inject a specific result (e.g. to simulate a degraded/rolled-
# back broker for a failure-drill test) for the NEXT Get-E1BrokerStatus call
# and every one after it until Reset-E1FakeBrokerStatusState is called. The
# injected value is validated through the same Assert-E1BrokerStatusResult
# every real result passes, so a malformed override fails here, not silently
# inside a caller.
function Set-E1FakeBrokerStatusResult($Result) {
  Assert-E1BrokerStatusResult $Result
  $script:E1FakeBrokerStatusOverride = $Result
}

function Reset-E1FakeBrokerStatusState {
  [CmdletBinding()]
  param()
  $script:E1FakeBrokerStatusOverride = $null
}

function Get-E1BrokerStatus {
  [CmdletBinding()]
  param()
  if ($null -ne $script:E1FakeBrokerStatusOverride) { return $script:E1FakeBrokerStatusOverride }
  return New-E1FakeBrokerStatusDefaultResult
}

Export-ModuleMember -Function `
  Set-E1FakeBrokerStatusResult, `
  Reset-E1FakeBrokerStatusState, `
  Get-E1BrokerStatus

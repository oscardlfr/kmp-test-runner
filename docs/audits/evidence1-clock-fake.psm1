# evidence1-clock-fake.psm1
#
# ADR-S4's fake Clock test double. Formalized to route
# through evidence1-clock-contract.psm1, matching the
# same contract/real/fake three-way pattern every other ADR-S4 capability in
# this repo already uses -- see evidence1-clock-contract.psm1 and
# evidence1-clock-real.psm1's own headers for what changed and why. Pinnable/
# advanceable behavior is UNCHANGED from before this round: by DEFAULT
# (nothing seeded), Get-E1CurrentUtc returns genuine real time; ONLY when a
# test calls Set-E1FakeClockUtc does it diverge.
#
# Needed for LiveAuthorized's credential-fingerprint-expiry check and for
# plan section 7 Phase 4's "expired-auth detection without provider
# inference" and "twenty-day-equivalent fake-clock expiry/resume" rehearsals
# -- both require moving time forward deterministically, never by actually
# waiting or by inferring expiry from a live provider call.
#
# Structural safety property, same bar as every other fake in this repo:
# never calls Start-Sleep to simulate time passing, never calls Set-Date or
# otherwise touches the real system clock -- confirmed by this file's own
# comment-stripped source-text scan (Evidence1-Clock-Fake.Tests.ps1), not
# just asserted here.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-clock-contract.psm1') -Force -DisableNameChecking -Global

$script:E1FakeClockOverrideUtc = $null

function Get-E1CurrentUtc {
  [CmdletBinding()]
  param()
  $value = if ($null -ne $script:E1FakeClockOverrideUtc) { $script:E1FakeClockOverrideUtc } else { [DateTime]::UtcNow }
  Assert-E1ClockUtcValue $value
  return $value
}

# Test setup: pin the clock to an exact UTC DateTime. Keeps its own,
# already-established 'fake_clock_value_must_be_utc_kind' reason code
# (rather than delegating to Assert-E1ClockUtcValue's generic
# 'clock_value_must_be_utc_kind') so the existing regression test pinned to
# that exact string keeps passing unchanged -- the contract module is used
# for Get-E1CurrentUtc's own return-value check below, where no such
# pre-existing reason-code test constrains it.
function Set-E1FakeClockUtc {
  [CmdletBinding()]
  param([Parameter(Mandatory)][DateTime]$Utc)
  if ($Utc.Kind -ne [DateTimeKind]::Utc) { throw 'fake_clock_value_must_be_utc_kind' }
  $script:E1FakeClockOverrideUtc = $Utc
}

# Test convenience: move the (already-pinned) fake clock forward by N days,
# without needing the caller to recompute an absolute DateTime each time --
# exactly what a "twenty-day-equivalent" rehearsal needs to express as
# `1..20 | ForEach-Object { Add-E1FakeClockDays 1 }` or a single `Add-E1FakeClockDays 20`.
# Pure arithmetic on the already-pinned value -- never Start-Sleep, never a
# real wait.
function Add-E1FakeClockDays {
  [CmdletBinding()]
  param([Parameter(Mandatory)][double]$Days)
  if ($null -eq $script:E1FakeClockOverrideUtc) { throw 'fake_clock_not_pinned_yet: call Set-E1FakeClockUtc first' }
  $script:E1FakeClockOverrideUtc = $script:E1FakeClockOverrideUtc.AddDays($Days)
}

function Reset-E1FakeClockState {
  [CmdletBinding()]
  param()
  $script:E1FakeClockOverrideUtc = $null
}

Export-ModuleMember -Function `
  Get-E1CurrentUtc, `
  Set-E1FakeClockUtc, `
  Add-E1FakeClockDays, `
  Reset-E1FakeClockState

# evidence1-clock-real.psm1
#
# ADR-S4's real Clock: wraps [DateTime]::UtcNow, nothing else.
# Previously evidence1-clock-fake.psm1 alone played
# both roles (its own prior header explained why); this file is the "real"
# half now split out to match the contract/real/fake pattern every other
# ADR-S4 capability in this repo already uses.
#
# Structural safety property, same bar as every other -real/-hyperv module:
# no Set-/pin-/advance-style function exists anywhere in this file. There is
# no seam here for a caller to ever make this module report anything other
# than genuine current time -- not a convention this module happens to
# follow, but a structural fact checked directly by this file's own tests
# (Evidence1-Clock-Real.Tests.ps1 asserts this module's exported command set
# is exactly @('Get-E1CurrentUtc'), nothing else).

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-clock-contract.psm1') -Force -DisableNameChecking -Global

function Get-E1CurrentUtc {
  [CmdletBinding()]
  param()
  $value = [DateTime]::UtcNow
  Assert-E1ClockUtcValue $value
  return $value
}

Export-ModuleMember -Function Get-E1CurrentUtc

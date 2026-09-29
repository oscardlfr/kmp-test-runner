# evidence1-clock-contract.psm1
#
# ADR-S4's Clock interface (production: system UTC; test: fake clock),
# formalized -- overnight work order item 3. Previously
# evidence1-clock-fake.psm1 alone folded both the "production" and "test"
# roles together (its own header explained why: a real Clock has no I/O and
# nothing that could meaningfully disagree between a real and fake
# implementation). That simplification is now split into the same
# three-way contract/real/fake pattern every other ADR-S4 capability in this
# repo already uses, per the maintainer's explicit request, while keeping
# evidence1-clock-fake.psm1's pinnable/advanceable behavior unchanged.
#
# Unlike BrokerStatus/VmState/NetworkMode/ProviderRuntimeSession, Clock has
# no multi-field "result" to assert a shape over -- Get-E1CurrentUtc returns
# a single value, which must always be a UTC-kind [DateTime], never
# local/unspecified. Assert-E1ClockUtcValue is the whole of this contract.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-E1ClockUtcValue($Value) {
  if ($null -eq $Value) { throw 'clock_value_missing' }
  if ($Value -isnot [DateTime]) { throw 'clock_value_not_datetime' }
  if ($Value.Kind -ne [DateTimeKind]::Utc) { throw 'clock_value_must_be_utc_kind' }
}

# The exact UTC string shape used everywhere else in this codebase
# (evidence1-run-state-contract.psm1's New-E1RunStateReceipt,
# evidence1-run-manifest-contract.psm1's Test-E1RunManifestUtcTimestamp /
# every *_utc manifest field, evidence1-run.ps1's own LiveAuthorized /
# campaign-descriptor / top-level report timestamps) -- centralized here so
# a caller formatting a Clock value never needs to spell the format string
# out again, and so it cannot silently drift from what the rest of this
# codebase already expects.
function ConvertTo-E1ClockUtcString([DateTime]$Value) {
  Assert-E1ClockUtcValue $Value
  return $Value.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

Export-ModuleMember -Function Assert-E1ClockUtcValue, ConvertTo-E1ClockUtcString

# evidence1-provider-runtime-contract.psm1
#
# ADR-S4's ProviderRuntime interface (production: Claude / Codex; test: fake
# JSONL/stream runtime). Neither implementation existed before this round.
# Only the fake is built now -- see evidence1-provider-runtime-fake.psm1's
# header for why a real implementation is deliberately not attempted this
# round, even unused.
#
# This is the LiveRunning state's own capability, distinct from every
# ADR-S1 broker capability: dispatching a provider session is never a broker
# operation (the broker's six families stop at guest.invoke_bundle/
# artifacts.copy_read_only -- see ADR-S1). ProviderRuntime is the
# orchestrator's own direct concern.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-E1ProviderRuntimePropertyNames($Value) {
  if ($Value -is [Collections.IDictionary]) { return @($Value.Keys) }
  # PowerShell remoting decorates otherwise valid objects with these transport
  # note properties.  They are not part of the provider result contract and
  # must not make the same result invalid solely because it crossed the VM
  # boundary.
  return @($Value.PSObject.Properties.Name | Where-Object {
    $_ -cnotin @('PSComputerName', 'RunspaceId', 'PSShowComputerName')
  })
}

# One result per dispatched session. Deliberately does NOT carry any prompt
# or completion CONTENT -- output_summary is a small, fixed-shape record
# (line_count/byte_count-style facts only), matching this codebase's
# existing privacy convention of recording facts about evidence rather than
# the evidence's own content (compare evidence1-dual-condition-canary-contract.psm1's
# raw_prompt/raw_content_read=false fields, cited elsewhere in this repo).
function New-E1ProviderRuntimeSessionResult {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$RuntimeId,
    [Parameter(Mandatory)][string]$ModelId,
    [Parameter(Mandatory)][int]$RoundIndex,
    [Parameter(Mandatory)][string]$SessionId,
    [Parameter(Mandatory)][string]$StartedAtUtc,
    [Parameter(Mandatory)][string]$CompletedAtUtc,
    [Parameter(Mandatory)][int]$ExitCode,
    [Parameter(Mandatory)][ValidateSet('PASS', 'FAIL')][string]$Verdict,
    [string]$ReasonCode = $null,
    [Parameter(Mandatory)]$OutputSummary
  )
  return [ordered]@{
    schema           = 1
    runtime_id       = $RuntimeId
    model_id         = $ModelId
    round_index      = $RoundIndex
    session_id       = $SessionId
    started_at_utc   = $StartedAtUtc
    completed_at_utc = $CompletedAtUtc
    exit_code        = $ExitCode
    verdict          = $Verdict
    reason_code      = $ReasonCode
    output_summary   = $OutputSummary
  }
}

function Assert-E1ProviderRuntimeSessionResult($Result) {
  if ($null -eq $Result) { throw 'provider_runtime_session_result_missing' }
  $required = @(
    'schema', 'runtime_id', 'model_id', 'round_index', 'session_id', 'started_at_utc',
    'completed_at_utc', 'exit_code', 'verdict', 'reason_code', 'output_summary'
  )
  $actual = @(Get-E1ProviderRuntimePropertyNames $Result | Sort-Object)
  if (@(Compare-Object $actual @($required | Sort-Object)).Count -ne 0) {
    throw 'provider_runtime_session_result_shape_invalid'
  }
  if ([int]$Result.schema -ne 1) { throw 'provider_runtime_session_result_schema_invalid' }
  if ([string]$Result.verdict -cnotin @('PASS', 'FAIL')) { throw 'provider_runtime_session_result_verdict_invalid' }
  if ([string]$Result.verdict -ceq 'FAIL' -and [string]::IsNullOrWhiteSpace([string]$Result.reason_code)) {
    throw 'provider_runtime_session_result_fail_missing_reason'
  }
}

Export-ModuleMember -Function `
  New-E1ProviderRuntimeSessionResult, `
  Assert-E1ProviderRuntimeSessionResult

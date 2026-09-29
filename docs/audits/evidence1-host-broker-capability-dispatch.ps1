#Requires -RunAsAdministrator

# evidence1-host-broker-capability-dispatch.ps1
#
# The ONE new elevated entrypoint this round adds to
# evidence1-host-elevated-runner.ps1's $AllowedScripts -- ADR-S1's "stable
# privileged broker" made real for vm.ensure_state/network.ensure_mode/
# guest.invoke_bundle/artifacts.copy_read_only (plus vm.inspect/
# network.inspect/broker.status), instead of the rejected "one allowlisted
# script per operation" pattern (plan ADR-S1 "Rejected"; see
# docs/audits/evidence1-broker-capability-contract.psm1's own header for the
# full architectural account).
#
# This script is deliberately thin: it does exactly the validation order
# this round's task specifies, then hands off to
# evidence1-broker-capability-dispatch-core.psm1's Invoke-E1BrokerCapabilityRoute
# for the actual call. It never itself contains capability LOGIC (no VM/
# network/guest/artifact-copy behavior lives here) -- that already exists,
# reviewed, in the five real/hyperv/real modules this script imports.
#
# Validation order (this round's task, in the order given):
#   1. schema version + capability name (closed registry)      -- step A
#   2. operation_id (canonical GUID 'D', matching this          -- step A
#      codebase's [guid]::TryParseExact idiom)                     (composed
#                                                                     into
#                                                                     Assert-E1BrokerCapabilityRequestShape)
#   3. exact declared arguments for that capability             -- step A
#   4. confined paths (path-shaped arguments only)               -- step B
#   5. deployed snapshot's own hashes                            -- ALREADY
#      SATISFIED before this script's body ever runs: this          TRUE BY
#      script is itself one of evidence1-host-elevated-runner.ps1's CONSTRUCTION
#      hash-verified $AllowedScripts entries, and everything it
#      imports below is registered in that same file's
#      $TrustedSupportFiles, re-hash-verified at broker startup AND
#      on every single dispatch (Assert-E1RunnerDirectFile +
#      Get-E1RunnerSha256, evidence1-host-elevated-runner.ps1) --
#      this script does not (and structurally cannot, from inside
#      its own body) re-implement that check; it inherits it.
#   6. ACL/integrity of anything touched                          -- SAME AS
#                                                                      #5:
#                                                                      Assert-E1RunnerProtectedAcl
#                                                                      already
#                                                                      ran
#                                                                      against
#                                                                      the
#                                                                      whole
#                                                                      deployment
#                                                                      tree
#                                                                      before
#                                                                      this
#                                                                      script
#                                                                      was
#                                                                      launched.
#   7. expiration                                                -- step C
#   8. replay (durable per-operation_id claim)                    -- step D
#
# DRAFTED, NEVER EXECUTED CODE -- same standing notice as every
# *-hyperv.psm1 file and evidence1-run.ps1 itself. This script can only ever
# run inside the elevated Scheduled Task's own child process, dispatched
# through the existing queue; nothing in this engagement has triggered that.

param(
  [Parameter(Mandatory = $true)][string]$CapabilityRequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-broker-capability-contract.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'evidence1-broker-capability-dispatch-core.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'evidence1-broker-status-real.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'evidence1-vm-state-hyperv.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'evidence1-network-backend-hyperv.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'evidence1-guest-bundle-hyperv.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'evidence1-artifact-copy-hyperv.psm1') -Force -DisableNameChecking

function Fail([string]$Code) {
  Write-Error "HARD STOP: $Code"
  exit 1
}

function Resolve-FullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-E1CapabilityDispatchNoReparse([string]$Path) {
  $cursor = Resolve-FullPath $Path
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'broker_capability_reparse_rejected' }
    }
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or $parent -ceq $cursor) { break }
    $cursor = $parent
  }
}

# Same create-new idiom this codebase already uses throughout (e.g.
# evidence1-hyperv-verify-guest-dual-auth-direct.ps1's own Write-CreateNewJson)
# -- copied, not reinvented. [IO.FileMode]::CreateNew throws IOException if
# the target already exists, which is the exact property both the replay
# claim and the terminal response below depend on.
function Write-E1CapabilityCreateNewJson([string]$Path, $Value) {
  [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path))
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 20))
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
  finally { $stream.Dispose() }
}

# --- Path confinement + request-directory shape ---------------------------
# Broad C:\kmp-eval\scratch\ confinement -- matching
# evidence1-host-elevated-runner.ps1's own Assert-PathInside $QueueRoot
# 'C:\kmp-eval\scratch\' 'queue' precedent for the identical concept (this
# script has no more specific queue-root convention to pin to than the
# runner it is dispatched by already uses).
$requestFull = Resolve-FullPath $CapabilityRequestPath
try {
  $null = Assert-E1BrokerCapabilityPathInside $requestFull 'C:\kmp-eval\scratch\'
} catch {
  Fail (Get-E1BrokerCapabilityReasonCodePrefix $_.Exception.Message)
}
Assert-E1CapabilityDispatchNoReparse $requestFull
if (-not (Test-Path -LiteralPath $requestFull -PathType Leaf)) { Fail 'broker_capability_request_missing' }
$requestItem = Get-Item -LiteralPath $requestFull -Force
if ($requestItem.PSIsContainer) { Fail 'broker_capability_request_invalid' }

$requestsDir = Split-Path -Parent $requestFull
if ((Split-Path -Leaf $requestsDir) -cne 'capability-requests') { Fail 'broker_capability_request_path_shape_invalid' }
$queueRoot = Split-Path -Parent $requestsDir
$queuePaths = Get-E1BrokerCapabilityQueuePaths $queueRoot
if ((Resolve-FullPath $queuePaths.requests_dir) -cne $requestsDir) { Fail 'broker_capability_request_path_shape_invalid' }

# --- Step A: parse (BOM-safe, matching this codebase's established idiom --
# evidence1-validation-forensics.psm1:98-class .TrimStart([char]0xfeff)),
# then schema + capability + operation_id + declared arguments ------------
try {
  $bytes = [IO.File]::ReadAllBytes($requestFull)
  $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes).TrimStart([char]0xfeff)
  $parsedRequest = $text | ConvertFrom-Json -ErrorAction Stop
} catch {
  Fail 'broker_capability_request_unparseable'
}

try {
  Assert-E1BrokerCapabilityRequestShape $parsedRequest
} catch {
  Fail (Get-E1BrokerCapabilityReasonCodePrefix $_.Exception.Message)
}

$capability = [string]$parsedRequest.capability
$operationId = [string]$parsedRequest.operation_id

# Filename integrity: the request file's own name must name the same
# operation_id its JSON content claims -- closes a class of confusion where
# one file's path and its own declared identity could disagree.
$expectedFileName = "$operationId.request.json"
if ((Split-Path -Leaf $requestFull) -cne $expectedFileName) { Fail 'broker_capability_request_filename_mismatch' }

# --- Step B: confined paths (path-shaped declared arguments only) --------
try {
  Assert-E1BrokerCapabilityPathArguments $capability $parsedRequest.arguments
} catch {
  Fail (Get-E1BrokerCapabilityReasonCodePrefix $_.Exception.Message)
}

# Steps 5/6 (deployed snapshot hashes, ACL): already true by construction --
# see this file's own header. Nothing to do here.

# --- Step C: expiration -----------------------------------------------------
try {
  Assert-E1BrokerCapabilityRequestFresh $parsedRequest ([DateTime]::UtcNow)
} catch {
  Fail (Get-E1BrokerCapabilityReasonCodePrefix $_.Exception.Message)
}

# --- Step D: replay prevention -- durable per-operation_id claim, CreateNew
# A request that fails ANY check above (steps A-C) never reaches this claim
# -- deliberately: "replay" means "this operation_id was already ACCEPTED
# and dispatched", not "this operation_id string was ever seen in any
# request, even a malformed or rejected one". A caller may correct a
# rejected request and resubmit it under the SAME operation_id; only a
# request that reaches this point and successfully claims is protected
# against being dispatched a second time.
$claimPath = Join-Path $queuePaths.operations_dir "$operationId.claim.json"
$claim = [ordered]@{
  schema         = 1
  operation_id   = $operationId
  capability     = $capability
  claimed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}
try {
  Write-E1CapabilityCreateNewJson $claimPath $claim
} catch [IO.IOException] {
  Fail 'broker_capability_replay_rejected'
}

# --- Route + exactly one terminal response, CreateNew ----------------------
# From here on, this operation_id is claimed: exactly one response is
# written below, on every code path (PASS, capability-level FAIL, or an
# unexpected exception while routing) -- never a second write for the same
# operation_id, and never silently skipped.
try {
  $artifactCopyTrustedRoot = ''
  if ($capability -ceq 'artifacts.copy_read_only') {
    # TrustedRoot resolved ONLY here, from a freshly-computed, verified
    # BrokerStatus -- never from $parsedRequest.arguments (that key does not
    # exist in this capability's argument_schema at all), never from
    # $env:, never defaulted. See evidence1-artifact-copy-hyperv.psm1's own
    # Get-E1ArtifactCopyRealTrustedRoot header for the full reasoning.
    $status = Get-E1BrokerStatus
    $artifactCopyTrustedRoot = Get-E1ArtifactCopyRealTrustedRoot $status
  }
  $response = Invoke-E1BrokerCapabilityRoute -Request $parsedRequest -ArtifactCopyTrustedRoot $artifactCopyTrustedRoot
  Assert-E1BrokerCapabilityResponseShape $response
} catch {
  $reasonCode = Get-E1BrokerCapabilityReasonCodePrefix $_.Exception.Message
  $response = New-E1BrokerCapabilityResponse -OperationId $operationId -Capability $capability `
    -Verdict 'FAIL' -ReasonCode $reasonCode -Result $null
}

$responsePath = Join-Path $queuePaths.responses_dir "$operationId.response.json"
Write-E1CapabilityCreateNewJson $responsePath $response

if ([string]$response.verdict -cne 'PASS') { exit 1 }
exit 0

# evidence1-guest-bundle-hyperv.psm1
#
# Production guest.invoke_bundle (ADR-S1): opens one PowerShell Direct session
# against the named VM, runs exactly one registry bundle from
# evidence1-guest-bundle-contract.psm1 with validated arguments, captures a
# schema-checked structured result, and always closes the session -- the shared
# transport every evidence1-hyperv-*-direct.ps1 script currently hand-rolls (see
# docs/audits/evidence1-phase3a-architecture-note.md section 2).
#
# DRAFTED, NEVER EXECUTED CODE -- see that architecture note's header, and
# evidence1-network-backend-hyperv.psm1's identical notice (same author, same
# session, same rule).
#
# Bounded execution: unlike evidence1-network-backend-hyperv.psm1's guest
# transport helper (Phase 2, no independent timeout), this one runs the guest
# scriptblock via Invoke-Command -AsJob + Wait-Job -Timeout, matching the
# intent of most of the read -direct.ps1 scripts' own Start-Job+Wait-Job
# wrapping (e.g. evidence1-hyperv-verify-guest-claude-auth-direct.ps1,
# evidence1-hyperv-verify-guest-codex-preflight-direct.ps1). It deliberately
# does NOT wrap New-PSSession itself in Start-Job the way those scripts wrap
# the whole Invoke-Command -VMName call: Start-Job spawns a separate local
# PowerShell process, and whether a SecureString/PSCredential survives that
# cross-process argument marshaling intact is not something I can verify
# without running it. Invoke-Command -AsJob instead creates its job over an
# already-open session in THIS process -- the credential and session never
# cross a process boundary, only the remote command's job does, which is a
# well-established, documented PowerShell Remoting pattern. Now that this is
# the one shared primitive, Phase 2's own transport helper arguably has the
# same missing-timeout gap this closes -- flagged rather than silently
# patching already-verified Phase 2 code; see the architecture note's open
# questions.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-guest-bundle-contract.psm1') -Force -DisableNameChecking -Global
Import-Module (Join-Path $PSScriptRoot 'evidence1-broker-capability-contract.psm1') -Force -DisableNameChecking -Global

$script:E1GuestBundleDefaultTimeoutSeconds = 60

function Resolve-E1GuestBundleFullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-E1GuestBundleCredentialPath([string]$Path) {
  $full = Resolve-E1GuestBundleFullPath $Path
  $rootFull = (Resolve-E1GuestBundleFullPath 'C:\kmp-eval\scratch\').TrimEnd('\') + '\'
  if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'guest_bundle_credential_path_outside_scratch'
  }
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw 'guest_bundle_credential_missing' }
  return $full
}

# The standard result shape every Invoke-E1GuestBundle call returns, regardless
# of which bundle ran -- mirrors New-E1NetworkModeResult's role in Phase 2.
# 2026-09-28 incident: once a job was issued, a Receive-Job/shape-assertion
# failure fell into the SAME generic catch as an auth failure, so the loop
# silently replayed a REAL, already-run session on the next logon candidate
# -- discarding the first candidate's own real (possibly successful) result
# entirely, with only a generic string surviving. The replay then hit
# evidence1-dual-condition-canary-launch.ps1's own slot guard
# (runs_root already exists) and returned indeterminate_prior_attempt,
# which is the only reason the loss was ever noticed. Collapsed to one
# line and length-capped before being embedded in a reason_code/report:
# not because remoting errors carry secrets (they don't -- no credential
# material flows through Receive-Job/Wait-Job/shape-assertion exceptions),
# but because an unbounded multi-line stack trace inside a single JSON
# string field is not a text a caller can practically show.
function Get-E1GuestBundleSanitizedErrorText([string]$Message) {
  if ([string]::IsNullOrEmpty($Message)) { return '(no message)' }
  $singleLine = ($Message -replace '[\r\n]+', ' ').Trim()
  if ($singleLine.Length -gt 500) { $singleLine = $singleLine.Substring(0, 500) + '...(truncated)' }
  return $singleLine
}

# A broken remoting socket after Invoke-Command -AsJob was issued does not
# establish whether the guest process reached inference or completed. Keep
# this narrow: shape/validation errors and ordinary worker failures are not
# transport losses and must retain their historical FAIL path.
function Test-E1GuestBundleTransportException($Exception) {
  for ($current = $Exception; $null -ne $current; $current = $current.InnerException) {
    if ([string]$current.GetType().Name -ceq 'PSRemotingTransportException') { return $true }
  }
  return $false
}

function New-E1GuestBundleInvocationResult {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$BundleName,
    [Parameter(Mandatory)][string]$VMName,
    [string]$VMId = $null,
    [string]$LogonNameUsed = $null,
    [Parameter(Mandatory)][ValidateSet('PASS', 'FAIL')][string]$Verdict,
    [string]$ReasonCode = $null,
    $Output = $null
  )
  return [ordered]@{
    schema          = 1
    bundle_name     = $BundleName
    vm_name         = $VMName
    vm_id           = $VMId
    logon_name_used = $LogonNameUsed
    verdict         = $Verdict
    reason_code     = $ReasonCode
    output          = $Output
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
}

# PUBLIC. The one and only way anything in this codebase should open a
# PowerShell Direct session going forward. $BundleName must be one of the
# closed registry names; $Arguments must satisfy that bundle's own declared
# schema (both enforced via the contract module before a session is even
# attempted) -- see evidence1-guest-bundle-contract.psm1's header for why this
# is a structural enforcement of ADR-S1's "SHALL NOT execute caller-provided
# host PowerShell", not a convention this function trusts callers to follow.
function Invoke-E1GuestBundle {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$GuestCredentialPath,
    [Parameter(Mandatory)][string]$BundleName,
    [hashtable]$Arguments = @{},
    [int]$TimeoutSeconds = $script:E1GuestBundleDefaultTimeoutSeconds
  )
  Assert-E1GuestBundleName $BundleName
  Assert-E1GuestBundleArguments $BundleName $Arguments
  if ($TimeoutSeconds -lt 5 -or $TimeoutSeconds -gt ((Get-E1BrokerCapabilityDefaultTimeoutMinutes) * 60)) { throw 'guest_bundle_timeout_out_of_range' }

  $credentialFull = Assert-E1GuestBundleCredentialPath $GuestCredentialPath
  $vm = Get-VM -Name $VMName -ErrorAction Stop
  if ($vm.State -ne 'Running') { throw 'guest_bundle_vm_must_be_running' }
  $vmId = ([string]$vm.Id).ToLowerInvariant()

  $bundle = (Get-E1GuestBundleRegistry)[$BundleName]
  # Build the top-level ArgumentList without a pipeline. PowerShell pipelines
  # enumerate nested arrays, so a bundle value such as [string[]]@('login',
  # 'status') previously became two positional parameters and the guest ran
  # only `codex login` (exit 2) instead of `codex login status`.
  $orderedArgumentValues = [Collections.ArrayList]::new()
  foreach ($key in $bundle.argument_schema.Keys) {
    $null = $orderedArgumentValues.Add($Arguments[$key])
  }

  $stored = Import-Clixml -LiteralPath $credentialFull
  $simple = [string]$stored.UserName
  $candidates = @("$VMName\$simple", ".\$simple", $simple, "localhost\$simple")

  # Invoke-Command -AsJob + Wait-Job -Timeout, on an already-open session in
  # THIS process, rather than wrapping New-PSSession itself in Start-Job (a
  # separate child process). The credential/session never cross a process
  # boundary this way -- only the job does, over the existing remoting
  # connection -- which avoids relying on SecureString/PSCredential surviving
  # Start-Job's own cross-process argument marshaling, something that cannot
  # be verified without running it. This also means the bundle's live
  # [scriptblock] object can be passed to Invoke-Command directly; no
  # ToString()/[scriptblock]::Create() round-trip needed.
  # Fallback across logon candidates is for auth/connection failures ONLY --
  # i.e. failures strictly before a job is actually issued against the guest.
  # Once Invoke-Command -AsJob has been called, the bundle may already be
  # doing real, non-idempotent work (this is exactly how a real ~30-minute
  # codex-cli session got silently discarded on 2026-09-28: candidate 1's
  # job completed for real, Receive-Job/the shape assertion threw, and the
  # loop replayed candidate 2 into what the slot guard then correctly
  # refused as indeterminate_prior_attempt -- the real result was gone by
  # construction). $jobIssued marks that boundary precisely: any failure
  # from here on returns FAIL immediately, with the real error text, and
  # never reaches another candidate.
  $lastFailureReason = 'no_candidate_logon_name_attempted'
  foreach ($logon in $candidates) {
    $session = $null
    $job = $null
    $jobIssued = $false
    try {
      $credential = [pscredential]::new($logon, $stored.Password)
      $session = New-PSSession -VMId ([guid]$vmId) -Credential $credential -ErrorAction Stop
      # M2: set BEFORE the call, not after it returns. If Invoke-Command itself throws, we
      # cannot prove the remote scriptblock didn't already start -- the exception could
      # legitimately come from anywhere in that call's own network round-trip, not only from
      # validating arguments before anything is sent. Losing one fallback candidate on a false
      # positive is cheap; replaying a live, possibly-already-started session is not. Never
      # replay under that uncertainty.
      $jobIssued = $true
      $job = Invoke-Command -Session $session -ScriptBlock $bundle.scriptblock -ArgumentList $orderedArgumentValues.ToArray() -AsJob
      $completed = Wait-Job -Job $job -Timeout $TimeoutSeconds
      if (-not $completed) { throw 'guest_bundle_timed_out' }
      $result = Receive-Job -Job $job -ErrorAction Stop
      Assert-E1GuestBundleResultShape $BundleName $result
      return New-E1GuestBundleInvocationResult -BundleName $BundleName -VMName $VMName -VMId $vmId `
        -LogonNameUsed $logon -Verdict 'PASS' -Output $result
    } catch {
      $errorText = Get-E1GuestBundleSanitizedErrorText $_.Exception.Message
      if ($jobIssued) {
        $reason = if (Test-E1GuestBundleTransportException $_.Exception) {
          "guest_bundle_transport_unknown_after_dispatch: $errorText"
        } else { "guest_bundle_failed: $errorText" }
        return New-E1GuestBundleInvocationResult -BundleName $BundleName -VMName $VMName -VMId $vmId `
          -LogonNameUsed $logon -Verdict 'FAIL' -ReasonCode $reason
      }
      $lastFailureReason = "guest_bundle_auth_failed: $errorText"
    } finally {
      # Each cleanup call is its own try/catch, not just -ErrorAction
      # SilentlyContinue -- found via Phase 3c's guest-transport tests
      # (evidence1-network-backend-hyperv.psm1, same pattern, same fix):
      # -ErrorAction only suppresses errors a cmdlet's own engine writes to
      # the error stream, never a parameter-BINDING failure, and an
      # exception raised inside finally is not caught by the catch block
      # that precedes it in the same statement. Cleanup must never be able
      # to replace or mask whatever error is already propagating.
      if ($job) {
        try { Stop-Job -Job $job -ErrorAction SilentlyContinue } catch { }
        try { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue } catch { }
      }
      if ($session) {
        try { Remove-PSSession -Session $session -ErrorAction SilentlyContinue } catch { }
      }
    }
  }

  return New-E1GuestBundleInvocationResult -BundleName $BundleName -VMName $VMName -VMId $vmId `
    -Verdict 'FAIL' -ReasonCode $lastFailureReason
}

Export-ModuleMember -Function Invoke-E1GuestBundle

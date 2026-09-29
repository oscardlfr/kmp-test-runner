# evidence1-guest-bundle-fake.psm1
#
# ADR-S4's "recording fake" for GuestTransport, applied to ADR-S1's
# guest.invoke_bundle. Exports the same Invoke-E1GuestBundle name as
# evidence1-guest-bundle-hyperv.psm1 so a caller behaves identically against
# either. Zero VM/session/network I/O. Unlike evidence1-network-backend-fake.psm1
# (which only needs to fake a small enum of states), this fake's main job is to
# RECORD every invocation (bundle name + arguments) so a test can assert "the
# caller invoked bundle X with exactly these arguments" -- which is what ADR-S4
# means by "recording fake" for this specific interface: proving the caller
# drives guest.invoke_bundle correctly matters as much here as proving it
# reacts correctly to a result.
#
# Still validates bundle name and arguments against the real, shared
# evidence1-guest-bundle-contract.psm1 registry -- a test using this fake with
# an unknown bundle name or a malformed argument still fails the same way it
# would against the real implementation, it just never opens a session to find
# out.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-guest-bundle-contract.psm1') -Force -DisableNameChecking -Global

$script:E1FakeGuestBundleInvocations = [Collections.Generic.List[object]]::new()
$script:E1FakeGuestBundleSeededResults = @{}

function Reset-E1FakeGuestBundleState {
  [CmdletBinding()]
  param()
  $script:E1FakeGuestBundleInvocations = [Collections.Generic.List[object]]::new()
  $script:E1FakeGuestBundleSeededResults = @{}
}

# Test setup: what Invoke-E1GuestBundle should return the NEXT time this
# bundle name is invoked for this VM. Keyed "VMName/BundleName" so different
# VMs (or repeat calls, once consumed) can be seeded independently. If nothing
# was seeded for a given call, Invoke-E1GuestBundle below returns a synthesized
# PASS with an empty output matching the bundle's declared result_keys (all
# $null) -- good enough for a caller-side test that only cares whether
# ensure_mode-style orchestration invoked the right bundle with the right
# arguments, not what a specific guest state would produce.
function Set-E1FakeGuestBundleResult {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$BundleName,
    [Parameter(Mandatory)][ValidateSet('PASS', 'FAIL')][string]$Verdict,
    [string]$ReasonCode = $null,
    $Output = $null
  )
  Assert-E1GuestBundleName $BundleName
  if ($Verdict -ceq 'PASS' -and $null -ne $Output) {
    Assert-E1GuestBundleResultShape $BundleName $Output
  }
  $script:E1FakeGuestBundleSeededResults["$VMName/$BundleName"] = [ordered]@{
    verdict     = $Verdict
    reason_code = $ReasonCode
    output      = $Output
  }
}

# Test assertion helper: every invocation this fake has seen since the last
# Reset-E1FakeGuestBundleState, in call order.
function Get-E1FakeGuestBundleInvocations {
  [CmdletBinding()]
  param()
  return @($script:E1FakeGuestBundleInvocations)
}

# [AllowEmptyString()] on -GuestCredentialPath (Phase 3c fix-forward round):
# found via an end-to-end replication of evidence1-run.ps1's exact fake-mode
# call sequence (never executing evidence1-run.ps1 itself) -- ToolchainReady
# and AuthReady both call this function with -GuestCredentialPath
# $Context.GuestCredentialPath, which is '' whenever -UseRealBackends is not
# set. A Mandatory [string] parameter rejects an empty-string argument by
# default (Mandatory only guarantees non-null/present, not non-empty), so
# every fake-mode ToolchainReady/AuthReady call would have failed parameter
# binding -- the identical bug class, and identical fix, as
# evidence1-network-backend-fake.psm1's -GuestCredentialPath (see that
# file). The value is never read in fake mode, so '' is legitimate here.
function Invoke-E1GuestBundle {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][AllowEmptyString()][string]$GuestCredentialPath,
    [Parameter(Mandatory)][string]$BundleName,
    [hashtable]$Arguments = @{},
    [int]$TimeoutSeconds = 60
  )
  Assert-E1GuestBundleName $BundleName
  Assert-E1GuestBundleArguments $BundleName $Arguments

  $script:E1FakeGuestBundleInvocations.Add([ordered]@{
    vm_name             = $VMName
    bundle_name         = $BundleName
    arguments           = $Arguments.Clone()
    recorded_at_utc     = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  })

  $seedKey = "$VMName/$BundleName"
  $bundle = (Get-E1GuestBundleRegistry)[$BundleName]

  if ($script:E1FakeGuestBundleSeededResults.ContainsKey($seedKey)) {
    $seeded = $script:E1FakeGuestBundleSeededResults[$seedKey]
    return [ordered]@{
      schema           = 1
      bundle_name      = $BundleName
      vm_name          = $VMName
      vm_id            = $null
      logon_name_used  = $null
      verdict          = $seeded.verdict
      reason_code      = $seeded.reason_code
      output           = $seeded.output
      generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    }
  }

  $syntheticOutput = [ordered]@{}
  foreach ($key in $bundle.result_keys) { $syntheticOutput[$key] = $null }
  return [ordered]@{
    schema           = 1
    bundle_name      = $BundleName
    vm_name          = $VMName
    vm_id            = $null
    logon_name_used  = $null
    verdict          = 'PASS'
    reason_code      = $null
    output           = $syntheticOutput
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
}

Export-ModuleMember -Function `
  Reset-E1FakeGuestBundleState, `
  Set-E1FakeGuestBundleResult, `
  Get-E1FakeGuestBundleInvocations, `
  Invoke-E1GuestBundle

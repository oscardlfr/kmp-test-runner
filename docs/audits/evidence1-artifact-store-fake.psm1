# evidence1-artifact-store-fake.psm1
#
# ADR-S4's temporary filesystem ArtifactStore test double. Real filesystem
# I/O (unlike most other fakes in this repo, which do none at all) -- the
# thing worth testing here is atomicity and crash-recovery, which only a
# real create-new-directory-then-atomic-rename sequence can actually prove.
# Never touches Hyper-V, a VM, the guest, or the broker; every path it
# touches is caller-supplied and scoped under C:\kmp-eval\scratch\ (same
# convention as evidence1-artifact-copy-fake.psm1/evidence1-guest-bundle-hyperv.psm1's
# own scratch-scoping).
#
# Protocol (inspired by, not copied from -- I do not have that module's own
# source, only a Pester test's black-box observations of it --
# evidence1-dual-condition-canary-contract.psm1's already-proven
# staging/transaction/ready shape):
#   1. If <PublicRoot>.publication.ready.json exists AND <PublicRoot> itself
#      exists: already committed. Return immediately, no changes -- the
#      idempotent no-op case.
#   2. Otherwise, detect and clean up any TORN state left by a prior crash:
#      a leftover <PublicRoot>.staging directory (crashed before the atomic
#      rename) or a <PublicRoot>.publication.transaction.json without a
#      matching .ready.json (crashed after starting the transaction record
#      but before finishing) both count, and both set
#      recovered_torn_state=$true on the eventual result.
#   3. Copy PrivateRoot's contents into a fresh <PublicRoot>.staging.
#   4. Write the transaction record.
#   5. [IO.Directory]::Move staging -> PublicRoot -- atomic on the same
#      volume (a rename, not a copy).
#   6. Write the ready marker. Return committed/PASS.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-artifact-store-contract.psm1') -Force -DisableNameChecking -Global
Import-Module (Join-Path $PSScriptRoot 'evidence1-trusted-root-config.psm1') -Force -DisableNameChecking -Global

function Resolve-E1ArtifactStoreFullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

# PUBLIC, standalone default-resolution wrapper (output_roots trust-root
# portability follow-up): delegates to the ONE shared implementation in
# evidence1-trusted-root-config.psm1 -- see that module's header. Kept under
# this module's own name, matching evidence1-run-manifest-contract.psm1's
# and evidence1-artifact-copy-fake.psm1's identical per-module wrapper
# convention for the same shared decision.
function Get-E1ArtifactStoreDefaultTrustedRoot {
  return Get-E1DefaultTrustedRoot
}

# -TrustedRoot is now ALWAYS caller-injected rather than a hardcoded
# module-level literal, defaulting to Get-E1ArtifactStoreDefaultTrustedRoot
# so the common case (no caller override) needs no new configuration.
# Exported so this confinement property can be tested in isolation.
function Assert-E1ArtifactStoreScratchScoped([string]$Path, [string]$Label, [string]$TrustedRoot = (Get-E1ArtifactStoreDefaultTrustedRoot)) {
  $full = Resolve-E1ArtifactStoreFullPath $Path
  $rootFull = (Resolve-E1ArtifactStoreFullPath $TrustedRoot).TrimEnd('\') + '\'
  if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "artifact_store_$($Label)_outside_scratch"
  }
  return $full
}

# PUBLIC. Publishes every file under $PrivateRoot into $PublicRoot,
# atomically, recovering any torn state left by a prior crash first. Both
# roots must resolve under the SAME trust root (the historical
# C:\kmp-eval\scratch\ by default, or an explicitly injected -TrustedRoot) --
# this is a fake, but the path-scoping discipline is real and matches every
# other module that touches the filesystem in this repo.
function Publish-E1ArtifactStoreSet {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$PrivateRoot,
    [Parameter(Mandatory)][string]$PublicRoot,
    # Same caller-injected default as Assert-E1ArtifactStoreScratchScoped
    # above -- evidence1-run.ps1 resolves ONE trust root and passes it
    # explicitly here (and to ArtifactCopy, and to the manifest contract),
    # so all three never drift to different roots for the same campaign.
    [string]$TrustedRoot = (Get-E1ArtifactStoreDefaultTrustedRoot)
  )
  $privateFull = Assert-E1ArtifactStoreScratchScoped $PrivateRoot 'private_root' -TrustedRoot $TrustedRoot
  $publicFull = Assert-E1ArtifactStoreScratchScoped $PublicRoot 'public_root' -TrustedRoot $TrustedRoot
  if (-not (Test-Path -LiteralPath $privateFull -PathType Container)) { throw 'artifact_store_private_root_missing' }

  $stagingPath = "$publicFull.staging"
  $transactionPath = "$publicFull.publication.transaction.json"
  $readyPath = "$publicFull.publication.ready.json"

  if ((Test-Path -LiteralPath $readyPath -PathType Leaf) -and (Test-Path -LiteralPath $publicFull -PathType Container)) {
    $artifactCount = @(Get-ChildItem -LiteralPath $publicFull -Recurse -File).Count
    return New-E1ArtifactStorePublicationResult -PrivateRoot $privateFull -PublicRoot $publicFull `
      -State 'already-committed' -ArtifactCount $artifactCount -RecoveredTornState $false -Verdict 'PASS'
  }

  $recoveredTornState = $false
  if (Test-Path -LiteralPath $stagingPath) {
    Remove-Item -LiteralPath $stagingPath -Recurse -Force
    $recoveredTornState = $true
  }
  if ((Test-Path -LiteralPath $transactionPath -PathType Leaf) -and -not (Test-Path -LiteralPath $readyPath -PathType Leaf)) {
    Remove-Item -LiteralPath $transactionPath -Force
    $recoveredTornState = $true
  }

  $sourceFiles = @(Get-ChildItem -LiteralPath $privateFull -Recurse -File)
  New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null
  foreach ($file in $sourceFiles) {
    $relative = $file.FullName.Substring($privateFull.TrimEnd('\').Length + 1)
    $destination = Join-Path $stagingPath $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
  }

  $transaction = [ordered]@{
    schema = 1; artifact_count = $sourceFiles.Count; created_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
  ($transaction | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $transactionPath -Encoding UTF8

  if (Test-Path -LiteralPath $publicFull) { Remove-Item -LiteralPath $publicFull -Recurse -Force }
  [IO.Directory]::Move($stagingPath, $publicFull)

  ([ordered]@{ schema = 1; committed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } | ConvertTo-Json) |
    Set-Content -LiteralPath $readyPath -Encoding UTF8

  return New-E1ArtifactStorePublicationResult -PrivateRoot $privateFull -PublicRoot $publicFull `
    -State 'committed' -ArtifactCount $sourceFiles.Count -RecoveredTornState $recoveredTornState -Verdict 'PASS'
}

Export-ModuleMember -Function `
  Get-E1ArtifactStoreDefaultTrustedRoot, `
  Assert-E1ArtifactStoreScratchScoped, `
  Publish-E1ArtifactStoreSet

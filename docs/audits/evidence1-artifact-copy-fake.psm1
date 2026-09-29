# evidence1-artifact-copy-fake.psm1
#
# ADR-S4's test double for the ArtifactStore-adjacent side of artifacts.copy_read_only:
# "temporary in-memory/filesystem store". Unlike the other fakes in this repo
# (evidence1-network-backend-fake.psm1, evidence1-guest-bundle-fake.psm1,
# evidence1-vm-state-fake.psm1), this one does real local file I/O -- it copies
# from a caller-seeded temporary directory standing in for "the mounted VHD root"
# instead of faking the bytes entirely, because the thing worth testing here is
# largely file-shaped (does the caller handle a missing-but-optional source, an
# oversized source, exact destination naming) rather than state-shaped. It never
# touches Hyper-V: no Get-VM, no Mount-VHD/Dismount-VHD, no VM identity of any
# kind.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-artifact-copy-contract.psm1') -Force -DisableNameChecking -Global
Import-Module (Join-Path $PSScriptRoot 'evidence1-trusted-root-config.psm1') -Force -DisableNameChecking -Global

$script:E1FakeArtifactCopyRoots = @{}

# PUBLIC, standalone default-resolution wrapper (output_roots trust-root
# portability follow-up): delegates to the ONE shared implementation in
# evidence1-trusted-root-config.psm1 rather than re-implementing the
# env-var-else-historical-default decision here a second time. Kept under
# this module's own name (not the shared one) so callers/tests can reference
# "ArtifactCopy's default trust root" explicitly, matching
# evidence1-run-manifest-contract.psm1's own Get-E1RunManifestDefaultTrustedRoot
# naming convention for the identical role.
function Get-E1ArtifactCopyDefaultTrustedRoot {
  return Get-E1DefaultTrustedRoot
}

# Test setup: register a local directory standing in for the mounted VHD's
# Windows volume root for this VM name. The caller populates it with whatever
# guest_relative-shaped files a test scenario needs before calling
# Copy-E1ArtifactsReadOnly.
function Set-E1FakeArtifactCopyMountRoot {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$MountRootPath
  )
  if (-not (Test-Path -LiteralPath $MountRootPath -PathType Container)) { throw 'fake_artifact_copy_mount_root_missing' }
  $script:E1FakeArtifactCopyRoots[$VMName] = [System.IO.Path]::GetFullPath($MountRootPath)
}

function Reset-E1FakeArtifactCopyState {
  [CmdletBinding()]
  param([string]$VMName)
  if ($VMName) {
    $null = $script:E1FakeArtifactCopyRoots.Remove($VMName)
  } else {
    $script:E1FakeArtifactCopyRoots = @{}
  }
}

# PUBLIC (output_roots trust-root portability follow-up, matching
# evidence1-run-manifest-contract.psm1's own Assert-E1RunManifestOutputRootsConfined):
# -TrustedRoot is now ALWAYS caller-injected rather than a hardcoded
# module-level literal, defaulting to Get-E1ArtifactCopyDefaultTrustedRoot so
# the common case (no caller override) needs no new configuration. Exported
# so this confinement property can be tested in isolation, without needing a
# full Copy-E1ArtifactsReadOnly call (VM mount root, spec resolution, etc.).
function Assert-E1FakeArtifactCopyDestination([string]$DestinationDir, [string]$TrustedRoot = (Get-E1ArtifactCopyDefaultTrustedRoot)) {
  $full = [System.IO.Path]::GetFullPath($DestinationDir)
  $rootFull = ([System.IO.Path]::GetFullPath($TrustedRoot)).TrimEnd('\') + '\'
  if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) { throw 'artifact_copy_destination_outside_scratch' }
  if (Test-Path -LiteralPath $full) { throw 'artifact_copy_destination_must_be_create_new' }
  return $full
}

function Copy-E1ArtifactsReadOnly {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$ExpectedVMId,
    [Parameter(Mandatory)][string]$SpecName,
    [hashtable]$Arguments = @{},
    [Parameter(Mandatory)][string]$DestinationDir,
    # Same caller-injected default as Assert-E1FakeArtifactCopyDestination
    # above -- evidence1-run.ps1 resolves ONE trust root and passes it
    # explicitly here (and to ArtifactStore, and to the manifest contract),
    # so all three never drift to different roots for the same campaign.
    [string]$TrustedRoot = (Get-E1ArtifactCopyDefaultTrustedRoot)
  )
  $sources = Resolve-E1ArtifactCopySources $SpecName $Arguments
  $destinationFull = Assert-E1FakeArtifactCopyDestination $DestinationDir -TrustedRoot $TrustedRoot
  if (-not $script:E1FakeArtifactCopyRoots.ContainsKey($VMName)) {
    throw "fake_artifact_copy_vm_not_seeded: $VMName (call Set-E1FakeArtifactCopyMountRoot first)"
  }
  $root = $script:E1FakeArtifactCopyRoots[$VMName]

  foreach ($source in $sources) {
    $sourcePath = Join-Path $root ([string]$source.guest_relative)
    $exists = Test-Path -LiteralPath $sourcePath -PathType Leaf
    if (-not $exists) {
      if ([bool]$source.required) { throw "artifact_copy_required_source_missing: $($source.destination_name)" }
      continue
    }
    $item = Get-Item -LiteralPath $sourcePath -Force
    if ([int64]$item.Length -gt [int64]$source.max_bytes) { throw "artifact_copy_source_too_large: $($source.destination_name)" }
  }

  New-Item -ItemType Directory -Path $destinationFull -ErrorAction Stop | Out-Null
  $filesCopied = @()
  foreach ($source in $sources) {
    $sourcePath = Join-Path $root ([string]$source.guest_relative)
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { continue }
    $destinationPath = Join-Path $destinationFull ([string]$source.destination_name)
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -ErrorAction Stop
    $filesCopied += [string]$source.destination_name
  }

  $result = [ordered]@{ files_copied = @($filesCopied | Sort-Object) }
  if ($SpecName -ceq 'final-codex-failure-diagnostic') {
    $terminalPath = Join-Path $destinationFull 'terminal.json'
    $result.terminal_state = if (Test-Path -LiteralPath $terminalPath -PathType Leaf) {
      [string](Get-Content -LiteralPath $terminalPath -Raw | ConvertFrom-Json -ErrorAction Stop).state
    } else { $null }
  }
  Assert-E1ArtifactCopyResultShape $SpecName $result
  return $result
}

Export-ModuleMember -Function `
  Set-E1FakeArtifactCopyMountRoot, `
  Reset-E1FakeArtifactCopyState, `
  Get-E1ArtifactCopyDefaultTrustedRoot, `
  Assert-E1FakeArtifactCopyDestination, `
  Copy-E1ArtifactsReadOnly

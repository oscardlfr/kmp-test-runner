# evidence1-artifact-copy-hyperv.psm1
#
# Production artifacts.copy_read_only (ADR-S1). VHD-mount based -- see
# evidence1-artifact-copy-contract.psm1's header for why this, not PowerShell
# Direct, is the correct transport (confirmed by reading all seven named copy
# scripts: every one requires the VM Off and uses Mount-VHD -ReadOnly).
#
# DRAFTED, NEVER EXECUTED CODE -- same notice as every other *-hyperv.psm1 this
# round and Phase 2. In particular: Mount-VHD, Get-VMHardDiskDrive, and
# Dismount-VHD calls below are real, working-if-run Hyper-V storage automation
# that has not been run -- mounting a VHD is exactly the kind of "Hyper-V
# VM/adapter/switch cmdlet" this round's hard boundaries name explicitly, and I
# did not execute any of them while writing or checking this file.
#
# Trusted-root fix (real-security-property round): -TrustedRoot is now a
# caller-injected parameter on Assert-E1ArtifactCopyDestination/
# Copy-E1ArtifactsReadOnly, same shape as every other portability-fixed
# confinement check in this codebase (evidence1-run-manifest-contract.psm1,
# evidence1-artifact-copy-fake.psm1, evidence1-artifact-store-fake.psm1) --
# but, unlike those, it has NO env-var-or-literal default. This module is the
# REAL backend: an unprivileged environment variable or an unvetted caller
# argument must never be able to widen or redirect where real Hyper-V VHD
# evidence gets written on this host, so -TrustedRoot is Mandatory here and
# the module provides exactly one sealed, non-overridable resolution path
# instead -- Get-E1ArtifactCopyRealTrustedRoot, below. See that function's own
# header for the full reasoning.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-artifact-copy-contract.psm1') -Force -DisableNameChecking -Global
Import-Module (Join-Path $PSScriptRoot 'evidence1-trusted-root-config.psm1') -Force -DisableNameChecking -Global
Import-Module (Join-Path $PSScriptRoot 'evidence1-broker-status-real.psm1') -Force -DisableNameChecking -Global

# Every read copy script pins the source VHD to this root
# (evidence1-hyperv-copy-final-codex-attestation.ps1 line 27,
# evidence1-hyperv-copy-final-codex.ps1 line 97, and others identically) --
# the dedicated E2E VM family's storage root, never an arbitrary VHD path.
$script:E1ArtifactCopyAllowedVhdRoot = 'C:\kmp-eval\hyperv-e2e\'

# PUBLIC. The ONE real, authorized resolution path for the trusted root a live
# artifacts.copy_read_only call must confine its -DestinationDir to.
#
# This is a REAL security distinction from the fake-path fix
# (evidence1-artifact-copy-fake.psm1's Get-E1ArtifactCopyDefaultTrustedRoot),
# not the same fix copy-pasted here: the fake path is happy to let
# EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT be caller-configurable because it has no
# real privilege boundary to protect. This module does. A non-privileged
# request must not be able to choose or widen the trusted root via an
# arbitrary caller argument or environment variable, so this function:
#   - never reads $env: (confirmed by grep -- no $env: token anywhere below);
#   - accepts no override string parameter of any kind -- the only input is a
#     BrokerStatus result, so there is no argument shape through which a
#     caller-supplied path could reach the returned value at all;
#   - never derives anything from the artifact-copy operation's own request
#     content (VMName/SpecName/Arguments/DestinationDir never flow in here).
#
# "Sealed configuration" here means exactly what it means everywhere else in
# this codebase's already-reviewed real/elevated surface
# (evidence1-broker-status-real.psm1's Get-E1BrokerDeploymentState, the same
# hash-pinned/ACL-protected manifest independently re-verified by
# evidence1-host-elevated-runner.ps1 on every single dispatch): a real
# resource is trusted only once its current integrity has been positively
# re-checked, not merely because it was correct at install time. This
# function requires the caller to supply an ALREADY-COMPUTED BrokerStatus
# (Get-E1BrokerStatus, evidence1-broker-status-real.psm1) and only returns the
# trusted root when that status shows the installed broker deployment's own
# hashes and ACLs are genuinely intact right now (task_exists/readable/
# hashes_valid/acl_valid all $true) -- otherwise it throws. The returned value
# itself is still the fixed historical literal (Get-E1HistoricalScratchRootLiteral,
# evidence1-trusted-root-config.psm1) -- this function changes HOW a caller is
# allowed to obtain that value for the real path, never widens WHAT it is.
function Get-E1ArtifactCopyRealTrustedRoot($BrokerStatus) {
  if ($null -eq $BrokerStatus) { throw 'artifact_copy_real_trusted_root_broker_status_required' }
  if ($BrokerStatus.task_exists -ne $true -or $BrokerStatus.readable -ne $true -or
      $BrokerStatus.hashes_valid -ne $true -or $BrokerStatus.acl_valid -ne $true) {
    throw 'artifact_copy_real_trusted_root_broker_not_sealed'
  }
  return Get-E1HistoricalScratchRootLiteral
}

function Resolve-E1ArtifactCopyFullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

# -TrustedRoot is Mandatory -- deliberately NO default value of any kind (not
# even Get-E1ArtifactCopyRealTrustedRoot itself, which requires a BrokerStatus
# argument this function has no business resolving on a caller's behalf). A
# caller must always be explicit; the one real, authorized production caller
# is expected to pass Get-E1ArtifactCopyRealTrustedRoot's own return value,
# and a test may inject any other root it needs to exercise. The hardcoded
# 'C:\kmp-eval\scratch\' literal that used to live directly in this
# confinement check is gone -- it now exists in exactly one place,
# evidence1-trusted-root-config.psm1's Get-E1HistoricalScratchRootLiteral.
function Assert-E1ArtifactCopyDestination([string]$DestinationDir, [Parameter(Mandatory)][string]$TrustedRoot) {
  $full = Resolve-E1ArtifactCopyFullPath $DestinationDir
  $rootFull = (Resolve-E1ArtifactCopyFullPath $TrustedRoot).TrimEnd('\') + '\'
  if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'artifact_copy_destination_outside_scratch'
  }
  if (Test-Path -LiteralPath $full) { throw 'artifact_copy_destination_must_be_create_new' }
  return $full
}

# A read-only VHD mount is not guaranteed to receive a drive letter. Resolve
# the Windows partition from either its drive letter or its stable volume
# access path, matching the already-proven Get-E1FinalMountedWindowsRoot
# behavior used by the historical copy scripts. PartitionProvider is an
# internal test seam; production always uses the default storage cmdlets.
function Get-E1ArtifactCopyMountedWindowsRoot {
  param(
    $Mount,
    [scriptblock]$PartitionProvider = {
      param($MountedVhd)
      @($MountedVhd | Get-Disk -ErrorAction Stop | Get-Partition -ErrorAction Stop)
    }
  )
  $roots = @()
  foreach ($partition in @(& $PartitionProvider $Mount)) {
    $candidates = @()
    if ($partition.DriveLetter) { $candidates += ([string]$partition.DriveLetter + ':\') }
    foreach ($accessPath in @($partition.AccessPaths)) {
      $value = [string]$accessPath
      if ($value.StartsWith('\\?\Volume{', [StringComparison]::OrdinalIgnoreCase) -and
          $value.EndsWith('}\', [StringComparison]::Ordinal)) {
        $candidates += $value
      }
    }
    foreach ($candidate in @($candidates | Select-Object -Unique)) {
      if (Test-Path -LiteralPath (Join-Path $candidate 'Windows\System32\Config\SYSTEM') -PathType Leaf) {
        $roots += $candidate
      }
    }
  }
  $roots = @($roots | Select-Object -Unique)
  if ($roots.Count -ne 1) { throw 'artifact_copy_windows_volume_missing' }
  return [string]$roots[0]
}

# PUBLIC. Copies exactly the named spec's closed file set from a closed
# (Off) VM's disk into a new destination directory, read-only, and always
# dismounts. $VMName/$ExpectedVMId identify the VM; $SpecName selects a
# registry entry (never a caller-supplied path); $Arguments fills that spec's
# declared placeholders (validated before any mount is attempted).
function Copy-E1ArtifactsReadOnly {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$VMName,
    [Parameter(Mandatory)][string]$ExpectedVMId,
    [Parameter(Mandatory)][string]$SpecName,
    [hashtable]$Arguments = @{},
    [Parameter(Mandatory)][string]$DestinationDir,
    # Same caller-injected, no-default contract as Assert-E1ArtifactCopyDestination
    # above -- the one real, authorized caller resolves this via
    # Get-E1ArtifactCopyRealTrustedRoot, never from $env: or a bare literal.
    [Parameter(Mandatory)][string]$TrustedRoot
  )
  $sources = Resolve-E1ArtifactCopySources $SpecName $Arguments
  $destinationFull = Assert-E1ArtifactCopyDestination $DestinationDir -TrustedRoot $TrustedRoot

  $vm = Get-VM -Name $VMName -ErrorAction Stop
  if (([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant() -or [string]$vm.State -cne 'Off') {
    throw 'artifact_copy_requires_exact_vm_off'
  }
  $disk = (Get-VMHardDiskDrive -VMName $VMName -ErrorAction Stop | Select-Object -First 1).Path
  if (-not $disk -or -not (Resolve-E1ArtifactCopyFullPath $disk).StartsWith($script:E1ArtifactCopyAllowedVhdRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'artifact_copy_vhd_scope_invalid'
  }

  $mount = $null
  $filesCopied = @()
  try {
    $mount = Mount-VHD -Path $disk -ReadOnly -Passthru -ErrorAction Stop
    $root = Get-E1ArtifactCopyMountedWindowsRoot $mount

    # Verify the complete closed set before copying anything -- a required
    # source missing, oversized, or a reparse point fails the whole operation
    # rather than partially populating the destination.
    foreach ($source in $sources) {
      $sourcePath = Join-Path $root ([string]$source.guest_relative)
      $exists = Test-Path -LiteralPath $sourcePath -PathType Leaf
      if (-not $exists) {
        if ([bool]$source.required) { throw "artifact_copy_required_source_missing: $($source.destination_name)" }
        continue
      }
      $item = Get-Item -LiteralPath $sourcePath -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "artifact_copy_source_reparse_rejected: $($source.destination_name)" }
      if ([int64]$item.Length -gt [int64]$source.max_bytes) { throw "artifact_copy_source_too_large: $($source.destination_name)" }
    }

    New-Item -ItemType Directory -Path $destinationFull -ErrorAction Stop | Out-Null
    foreach ($source in $sources) {
      $sourcePath = Join-Path $root ([string]$source.guest_relative)
      if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { continue }
      $destinationPath = Join-Path $destinationFull ([string]$source.destination_name)
      Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -ErrorAction Stop
      $filesCopied += [string]$source.destination_name
    }
  } finally {
    if ($mount) { Dismount-VHD -Path $disk -ErrorAction SilentlyContinue }
  }

  # Per-spec extra result fields are hardcoded by spec name here rather than
  # generalized into the registry (e.g. a declared "post-copy fact extraction"
  # schema) -- reasonable for two worked examples, but a registry with many
  # specs each wanting different extra facts would want that generalized
  # properly rather than an ever-growing if/elseif chain here.
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
  Get-E1ArtifactCopyRealTrustedRoot, `
  Assert-E1ArtifactCopyDestination, `
  Copy-E1ArtifactsReadOnly

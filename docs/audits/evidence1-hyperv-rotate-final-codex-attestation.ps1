#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [string]$SourceAttestationPath = 'C:\kmp-eval\measurement-scopes\evidence1-claude-windows-isolation-attestation-stageb-v1.json',
  [string]$OutPath = 'C:\kmp-eval\measurement-scopes\evidence1-codex-windows-isolation-attestation.json',
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedHarnessCommit,
  [Parameter(Mandatory)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-Attestation([string]$Path, [string]$FailureCode) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or
      ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw $FailureCode
  }
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw $FailureCode
  }
}

function Assert-CodexAttestation($Value, [string]$FailureCode) {
  if ($Value.schema -ne 1 -or
      [string]$Value.runtime_id -cne 'codex-cli' -or
      [string]$Value.profile_id -cne 'sandboxed-unrestricted-v1' -or
      [string]$Value.platform -cne 'windows' -or
      [string]$Value.network_mode -cne 'restricted') {
    throw $FailureCode
  }
  try {
    $null = [datetime]::Parse([string]$Value.expires_at).ToUniversalTime()
  } catch {
    throw $FailureCode
  }
}

function Write-BytesCreateNew([string]$Path, [byte[]]$Bytes) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try {
    $stream.Write($Bytes, 0, $Bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
}

function Restore-Attestation([string]$Destination, [string]$Backup, [bool]$DestinationExisted, [bool]$Replaced) {
  if (-not $Replaced) { return }
  if ($DestinationExisted) {
    if (-not (Test-Path -LiteralPath $Backup -PathType Leaf)) { throw 'attestation_rollback_backup_missing' }
    Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $Backup -Destination $Destination -Force -ErrorAction Stop
  } else {
    Remove-Item -LiteralPath $Destination -Force -ErrorAction Stop
  }
}

$canonicalSource = 'C:\kmp-eval\measurement-scopes\evidence1-claude-windows-isolation-attestation-stageb-v1.json'
$canonicalOut = 'C:\kmp-eval\measurement-scopes\evidence1-codex-windows-isolation-attestation.json'
$reportRoot = [IO.Path]::GetFullPath('C:\kmp-eval\scratch\evidence1-final-codex-auth').TrimEnd('\') + '\'
$sourceFull = [IO.Path]::GetFullPath($SourceAttestationPath)
$outFull = [IO.Path]::GetFullPath($OutPath)
$reportFull = [IO.Path]::GetFullPath($ReportPath)
if ($sourceFull -cne $canonicalSource -or $outFull -cne $canonicalOut) { throw 'attestation_paths_not_canonical' }
if (-not $reportFull.StartsWith($reportRoot, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($reportFull) -cnotmatch '^attestation-rotation-[A-Za-z0-9_.-]+\.json$' -or
    (Test-Path -LiteralPath $reportFull)) { throw 'attestation_rotation_report_invalid' }

$source = Read-Attestation $sourceFull 'source_attestation_invalid'
$now = [datetime]::UtcNow
try { $sourceExpiry = [datetime]::Parse([string]$source.expires_at).ToUniversalTime() } catch { throw 'source_attestation_invalid' }
if ($source.schema -ne 1 -or
    [string]$source.profile_id -cne 'sandboxed-unrestricted-v1' -or
    [string]$source.runtime_id -cne 'claude-code' -or
    [string]$source.platform -cne 'windows' -or
    [string]$source.network_mode -cne 'restricted' -or
    [string]$source.harness_sha -cne $ExpectedHarnessCommit -or
    $sourceExpiry -le $now.AddMinutes(5)) { throw 'source_attestation_invalid' }

$vm = Get-VM -Name $VMName -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant() -or [string]$vm.State -cne 'Off') {
  throw 'exact_vm_must_be_off'
}
$disk = (Get-VMHardDiskDrive -VMName $VMName -ErrorAction Stop | Select-Object -First 1).Path
if (-not ([IO.Path]::GetFullPath($disk)).StartsWith('C:\kmp-eval\hyperv-e2e\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'attestation_vhd_scope_invalid'
}

$value = [ordered]@{
  schema = 1
  profile_id = 'sandboxed-unrestricted-v1'
  runtime_id = 'codex-cli'
  campaign_id = 'evidence1-codex-product-free-final'
  platform = 'windows'
  boundary_kind = [string]$source.boundary_kind
  network_mode = 'restricted'
  workspace_scope = [string]$source.workspace_scope
  runtime_credential_scope = [string]$source.runtime_credential_scope
  normal_maintainer_home_mounted = $false
  ambient_secrets_present = $false
  disposable_home = $true
  rollback_or_destroy_required = $true
  harness_sha = [string]$source.harness_sha
  created_at = $now.ToString('yyyy-MM-ddTHH:mm:ssZ')
  expires_at = $now.AddHours(23).ToString('yyyy-MM-ddTHH:mm:ssZ')
}
$bytes = [Text.UTF8Encoding]::new($false).GetBytes(($value | ConvertTo-Json -Depth 5))
$newHashAlgorithm = [Security.Cryptography.SHA256]::Create()
try { $newHash = ([BitConverter]::ToString($newHashAlgorithm.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() }
finally { $newHashAlgorithm.Dispose() }

$mount = $null
$guestTemp = $null
$guestBackup = $null
$hostTemp = $outFull + '.rotation-' + [guid]::NewGuid().ToString('N') + '.tmp'
$hostBackup = $outFull + '.rotation-' + [guid]::NewGuid().ToString('N') + '.bak'
$guestReplaced = $false
$hostReplaced = $false
$cleanupBackups = $false
$hostExisted = Test-Path -LiteralPath $outFull -PathType Leaf
$oldHostHash = $null
$oldGuestHash = $null
$oldGuestValid = $false
$invalidGuestArchiveHash = $null
$rotationReason = $null
try {
  $mount = Mount-VHD -Path $disk -Passthru -ErrorAction Stop
  $root = Get-E1FinalMountedWindowsRoot $mount
  $guest = Join-Path $root 'kmp-eval\measurement-scopes\evidence1-codex-windows-isolation-attestation.json'
  if (-not (Test-Path -LiteralPath $guest -PathType Leaf) -or
      ((Get-Item -LiteralPath $guest -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'guest_attestation_missing_or_invalid'
  }
  $guestItem = Get-Item -LiteralPath $guest -Force
  if ([long]$guestItem.Length -gt 65536) { throw 'guest_attestation_invalid_oversize' }
  $oldGuestHash = Get-Sha256 $guest
  try {
    $oldGuest = Read-Attestation $guest 'guest_attestation_missing_or_invalid'
    Assert-CodexAttestation $oldGuest 'guest_attestation_missing_or_invalid'
    $oldGuestValid = $true
  } catch {
    $oldGuestValid = $false
  }
  if ($oldGuestValid) {
    $oldGuestExpiry = [datetime]::Parse([string]$oldGuest.expires_at).ToUniversalTime()
    $harnessStale = [string]$oldGuest.harness_sha -cne $ExpectedHarnessCommit
    $expiryStale = $oldGuestExpiry -le $now.AddMinutes(5)
    if (-not $harnessStale -and -not $expiryStale) { throw 'guest_attestation_not_stale' }
    $rotationReason = if ($harnessStale -and $expiryStale) { 'harness_and_expiry_stale' } elseif ($harnessStale) { 'harness_stale' } else { 'expiry_stale' }
  } else {
    $rotationReason = 'invalid_existing_attestation'
    $archiveRoot = 'C:\kmp-eval\scratch\evidence1-final-codex-auth\prior-attestations'
    New-Item -ItemType Directory -Force -Path $archiveRoot | Out-Null
    $invalidGuestArchive = Join-Path $archiveRoot ("guest-codex-attestation-invalid-$($oldGuestHash.Substring(0, 12)).bin")
    if (Test-Path -LiteralPath $invalidGuestArchive) {
      if ((Get-Sha256 $invalidGuestArchive) -cne $oldGuestHash) { throw 'invalid_guest_archive_collision' }
    } else {
      [IO.File]::Copy($guest, $invalidGuestArchive, $false)
    }
    $invalidGuestArchiveHash = Get-Sha256 $invalidGuestArchive
    if ($invalidGuestArchiveHash -cne $oldGuestHash) { throw 'invalid_guest_archive_hash_mismatch' }
  }

  if ($hostExisted) {
    $oldHost = Read-Attestation $outFull 'host_attestation_invalid'
    Assert-CodexAttestation $oldHost 'host_attestation_invalid'
    $oldHostHash = Get-Sha256 $outFull
  }

  $guestTemp = $guest + '.rotation-' + [guid]::NewGuid().ToString('N') + '.tmp'
  $guestBackup = $guest + '.rotation-' + [guid]::NewGuid().ToString('N') + '.bak'
  Write-BytesCreateNew $guestTemp $bytes
  Write-BytesCreateNew $hostTemp $bytes

  [IO.File]::Replace($guestTemp, $guest, $guestBackup, $true)
  $guestReplaced = $true
  if ($hostExisted) {
    [IO.File]::Replace($hostTemp, $outFull, $hostBackup, $true)
  } else {
    [IO.File]::Move($hostTemp, $outFull)
  }
  $hostReplaced = $true

  $guestBytes = [IO.File]::ReadAllBytes($guest)
  $hostBytes = [IO.File]::ReadAllBytes($outFull)
  $byteDifferenceCount = @(
    Compare-Object -ReferenceObject $guestBytes -DifferenceObject $hostBytes -SyncWindow 0
  ).Count
  if ((Get-Sha256 $guest) -cne $newHash -or (Get-Sha256 $outFull) -cne $newHash -or $byteDifferenceCount -ne 0) {
    throw 'rotated_attestation_verification_failed'
  }

  Remove-Item -LiteralPath $guestBackup -Force -ErrorAction SilentlyContinue
  if ($hostExisted) { Remove-Item -LiteralPath $hostBackup -Force -ErrorAction SilentlyContinue }
  $cleanupBackups = $true
} catch {
  $failure = $_
  $rollbackErrors = [Collections.Generic.List[string]]::new()
  try { Restore-Attestation $outFull $hostBackup $hostExisted $hostReplaced } catch { $rollbackErrors.Add([string]$_.Exception.Message) }
  try {
    if ($guestReplaced) { Restore-Attestation $guest $guestBackup $true $true }
  } catch { $rollbackErrors.Add([string]$_.Exception.Message) }
  if ($rollbackErrors.Count -gt 0) {
    throw ('attestation_rotation_rollback_incomplete: ' + ($rollbackErrors -join '; '))
  }
  $cleanupBackups = $true
  throw $failure
} finally {
  foreach ($temporary in @($guestTemp, $hostTemp)) {
    if ($temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
  }
  if ($cleanupBackups) {
    foreach ($backup in @($guestBackup, $hostBackup)) {
      if ($backup) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
    }
  }
  if ($mount) { Dismount-VHD -Path $disk -ErrorAction SilentlyContinue }
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportFull) | Out-Null
$report = [ordered]@{
  schema = 1
  verdict = 'PASS'
  runtime_id = 'codex-cli'
  rotation_reason = $rotationReason
  prior_guest_sha256 = $oldGuestHash
  prior_guest_valid = $oldGuestValid
  invalid_guest_archived = (-not $oldGuestValid)
  invalid_guest_archive_sha256 = $invalidGuestArchiveHash
  prior_host_present = $hostExisted
  prior_host_sha256 = $oldHostHash
  attestation_sha256 = $newHash
  host_guest_exact_bytes = $true
  vm_state = 'Off'
  raw_content_printed = $false
  generated_at_utc = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}
[IO.File]::WriteAllText($reportFull, ($report | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
Write-Host "[evidence1-rotate-final-codex-attestation] PASS: $reportFull"

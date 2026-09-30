#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory = $true)] [string]$IsoPath,
  [Parameter(Mandatory = $true)] [ValidatePattern('^[0-9a-f]{64}$')] [string]$ExpectedSha256,
  [Parameter(Mandatory = $true)] [ValidateRange(1, [long]::MaxValue)] [long]$ExpectedBytes,
  [Parameter(Mandatory = $true)] [string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$mountedByScript = $false
$temporaryMountPerformed = $false
$reportFull = $null
$phase = 'initializing'

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
  } finally { $stream.Dispose() }
}

function Assert-PathInside([string]$Candidate, [string[]]$Roots, [string]$Code) {
  $full = [IO.Path]::GetFullPath($Candidate)
  foreach ($root in $Roots) {
    $base = ([IO.Path]::GetFullPath($root)).TrimEnd('\')
    if ($full -eq $base -or $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { return $full }
  }
  throw $Code
}

function Write-Report($Value) {
  $parent = Split-Path -Parent $script:reportFull
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  if (Test-Path -LiteralPath $script:reportFull) { throw 'report_already_exists' }
  [IO.File]::WriteAllText($script:reportFull, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}

try {
  $phase = 'validating_paths'
  $reportFull = Assert-PathInside $ReportPath @('C:\kmp-eval\scratch', [IO.Path]::GetTempPath()) 'report_path_outside_scratch'
  if (Test-Path -LiteralPath $reportFull) { throw 'report_already_exists' }
  $isoFull = [IO.Path]::GetFullPath($IsoPath)
  if ([IO.Path]::GetExtension($isoFull) -cne '.iso' -or -not (Test-Path -LiteralPath $isoFull -PathType Leaf)) {
    throw 'iso_missing_or_invalid'
  }
  $item = Get-Item -LiteralPath $isoFull
  if ([long]$item.Length -ne $ExpectedBytes) { throw 'iso_size_mismatch' }
  $phase = 'hashing_iso'
  $sha256 = Get-Sha256 $isoFull
  if ($sha256 -cne $ExpectedSha256) { throw 'iso_hash_mismatch' }

  $phase = 'mounting_iso'
  Import-Module Dism -ErrorAction Stop
  $disk = Get-DiskImage -ImagePath $isoFull -ErrorAction Stop
  if (-not [bool]$disk.Attached) {
    $disk = Mount-DiskImage -ImagePath $isoFull -Access ReadOnly -PassThru -ErrorAction Stop
    $mountedByScript = $true
    $temporaryMountPerformed = $true
  }
  $volumes = @($disk | Get-Volume -ErrorAction Stop | Where-Object DriveLetter)
  if ($volumes.Count -ne 1) { throw 'iso_volume_cardinality_invalid' }
  $root = "$($volumes[0].DriveLetter):\"
  $imagePaths = @(@(
      (Join-Path $root 'sources\install.wim'),
      (Join-Path $root 'sources\install.esd')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
  if ($imagePaths.Count -ne 1) { throw 'iso_install_image_cardinality_invalid' }
  $phase = 'reading_image_summaries'
  $imageSummaries = @(Get-WindowsImage -ImagePath $imagePaths[0] -ErrorAction Stop)
  $phase = 'reading_image_details'
  $images = @($imageSummaries | ForEach-Object {
    Get-WindowsImage -ImagePath $imagePaths[0] -Index ([int]$_.ImageIndex) -ErrorAction Stop
  })
  $phase = 'normalizing_image_metadata'
  $safeImages = @($images | ForEach-Object {
    $architecture = [string]$_.Architecture
    $version = '{0}.{1}.{2}.{3}' -f ([uint32]$_.MajorVersion),([uint32]$_.MinorVersion),([uint32]$_.Build),([uint32]$_.SPBuild)
    [ordered]@{
      index = [int]$_.ImageIndex
      name = [string]$_.ImageName
      edition_id = [string]$_.EditionId
      architecture = if ($architecture -in @('9','x64','amd64')) { 'x64' } else { 'unsupported' }
      languages = @($_.Languages | ForEach-Object { [string]$_ } | Sort-Object)
      version = $version
      installation_type = [string]$_.InstallationType
    }
  })
  $pro = @($safeImages | Where-Object { $_.name -ceq 'Windows 11 Pro' -and $_.edition_id -ceq 'Professional' -and $_.architecture -ceq 'x64' })
  if ($pro.Count -ne 1) { throw 'windows_11_pro_image_cardinality_invalid' }
  $phase = 'dismounting_iso'
  if ($mountedByScript) {
    Dismount-DiskImage -ImagePath $isoFull -ErrorAction Stop | Out-Null
    $mountedByScript = $false
  }
  $phase = 'writing_report'
  Write-Report ([ordered]@{
    schema = 1; verdict = 'PASS'; generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    iso = [ordered]@{ sha256 = $sha256; bytes = [long]$item.Length; private_path_persisted = $false }
    install_image_format = [IO.Path]::GetExtension($imagePaths[0]).TrimStart('.').ToLowerInvariant()
    image_count = $safeImages.Count; images = $safeImages; windows_11_pro = $pro[0]
    iso_mounted_before_operation = -not $temporaryMountPerformed; iso_left_mounted_by_operation = $false
    temporary_mount_performed = $temporaryMountPerformed; persistent_mutation_performed = $false
    network_used = $false; inference_sessions_consumed = 0
  })
  Write-Host "[evidence1-host-inspect-windows-iso] PASS: $reportFull"
} catch {
  $candidate = [string]$_.Exception.Message
  $allowed = @(
    'report_path_outside_scratch','report_already_exists','iso_missing_or_invalid','iso_size_mismatch','iso_hash_mismatch',
    'iso_volume_cardinality_invalid','iso_install_image_cardinality_invalid','windows_11_pro_image_cardinality_invalid'
  )
  $reason = if ($candidate -cin $allowed) { $candidate } else { "iso_inspection_failed_$phase" }
  try {
    if ($reportFull -and -not (Test-Path -LiteralPath $reportFull)) {
      Write-Report ([ordered]@{
        schema = 1; verdict = 'FAIL'; reason_code = $reason
        generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        private_path_persisted = $false; temporary_mount_performed = $temporaryMountPerformed
        persistent_mutation_performed = $false
        network_used = $false; inference_sessions_consumed = 0
      })
    }
  } catch { }
  Write-Error "HARD STOP: $reason"
  exit 1
} finally {
  if ($mountedByScript) {
    Dismount-DiskImage -ImagePath $IsoPath -ErrorAction SilentlyContinue | Out-Null
  }
}

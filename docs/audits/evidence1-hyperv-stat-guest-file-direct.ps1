#Requires -RunAsAdministrator

# Read-only, host-only, content-free file
# metadata via the same VHD-mount mechanism (VM must be exactly Off, mounts read-only, always
# dismounts). Exists for exactly one question: is the Claude OAuth credential file fresh, without
# ever reading its content -- the explicit constraint ("NEVER read its content") is
# enforced structurally here, not just by convention: this script calls Get-Item only, never
# Get-Content, and the guest path is a single fixed literal, never a caller-supplied path. Reports
# LastWriteTimeUtc and Length only.
param(
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [Parameter(Mandatory)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$reportFull = [IO.Path]::GetFullPath($ReportPath)
$reportRoot = [IO.Path]::GetFullPath('C:\kmp-eval\scratch\evidence1-guest-file-stat').TrimEnd('\') + '\'
if (-not $reportFull.StartsWith($reportRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'guest_file_stat_report_outside_canonical_root'
}
if (Test-Path -LiteralPath $reportFull) { throw 'guest_file_stat_report_must_be_create_new' }

if ($VMName -cne 'Evidence1-Runner-E2E') { throw 'guest_file_stat_vm_name_not_e2e_profile' }

$vm = Get-VM -Name $VMName -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant() -or [string]$vm.State -cne 'Off') {
  throw 'guest_file_stat_requires_exact_vm_off'
}

$allowedVhdRoot = 'C:\kmp-eval\hyperv-e2e\'
$disk = (Get-VMHardDiskDrive -VMName $VMName -ErrorAction Stop | Select-Object -First 1).Path
if (-not $disk -or -not ([IO.Path]::GetFullPath($disk)).StartsWith($allowedVhdRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'guest_file_stat_vhd_scope_invalid'
}

# Fixed, single target -- never a parameter. Only the Claude OAuth credential file this
# investigation needs freshness evidence for.
$guestRelativeFile = 'Evidence1RuntimeState\claude\.credentials.json'

$mount = $null
try {
  $mount = Mount-VHD -Path $disk -ReadOnly -Passthru -ErrorAction Stop
  $partitions = @($mount | Get-Disk -ErrorAction Stop | Get-Partition -ErrorAction Stop)
  $root = $null
  foreach ($partition in $partitions) {
    $candidates = @()
    if ($partition.DriveLetter) { $candidates += ([string]$partition.DriveLetter + ':\') }
    foreach ($accessPath in @($partition.AccessPaths)) {
      $value = [string]$accessPath
      if ($value.StartsWith('\\?\Volume{', [StringComparison]::OrdinalIgnoreCase) -and $value.EndsWith('}\', [StringComparison]::Ordinal)) {
        $candidates += $value
      }
    }
    foreach ($candidate in @($candidates | Select-Object -Unique)) {
      if (Test-Path -LiteralPath (Join-Path $candidate 'Windows\System32\Config\SYSTEM') -PathType Leaf) { $root = $candidate }
    }
  }
  if ($null -eq $root) { throw 'guest_file_stat_windows_volume_missing' }

  $targetFull = Join-Path $root $guestRelativeFile
  $exists = Test-Path -LiteralPath $targetFull -PathType Leaf
  $lastWriteTimeUtc = $null
  $lengthBytes = $null
  if ($exists) {
    $item = Get-Item -LiteralPath $targetFull -Force
    $lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $lengthBytes = [int64]$item.Length
  }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportFull) | Out-Null
  [ordered]@{
    schema              = 1
    verdict             = 'PASS'
    exists              = $exists
    last_write_time_utc = $lastWriteTimeUtc
    length_bytes        = $lengthBytes
    generated_at_utc     = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $reportFull -Encoding UTF8
  Write-Host "[evidence1-stat-guest-file] PASS: $reportFull"
} finally {
  if ($mount) { Dismount-VHD -Path $disk -ErrorAction SilentlyContinue }
}

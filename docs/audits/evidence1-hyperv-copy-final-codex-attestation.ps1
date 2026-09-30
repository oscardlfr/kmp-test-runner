#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [string]$OutPath = 'C:\kmp-eval\measurement-scopes\evidence1-claude-windows-isolation-attestation-stageb-v1.json',
  [string]$ReportPath = 'C:\kmp-eval\scratch\evidence1-final-codex-auth\attestation-copy.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking

$expectedOut = 'C:\kmp-eval\measurement-scopes\evidence1-claude-windows-isolation-attestation-stageb-v1.json'
$outFull = [IO.Path]::GetFullPath($OutPath)
$reportFull = [IO.Path]::GetFullPath($ReportPath)
$reportRoot = [IO.Path]::GetFullPath('C:\kmp-eval\scratch\evidence1-final-codex-auth').TrimEnd('\') + '\'
if (-not $outFull.Equals($expectedOut, [StringComparison]::OrdinalIgnoreCase)) { throw 'attestation_destination_not_canonical' }
if (-not $reportFull.StartsWith($reportRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'attestation_report_not_canonical' }
if ((Test-Path -LiteralPath $outFull) -or (Test-Path -LiteralPath $reportFull)) { throw 'attestation_copy_destination_must_be_create_new' }

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ([string]$vm.Name -cne 'Evidence1-Runner-E2E' -or
    ([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant() -or
    [string]$vm.State -cne 'Off') { throw 'attestation_copy_requires_exact_vm_off' }
$disk = (Get-VMHardDiskDrive -VMName $VMName | Select-Object -First 1).Path
if (-not ([IO.Path]::GetFullPath($disk)).StartsWith('C:\kmp-eval\hyperv-e2e\', [StringComparison]::OrdinalIgnoreCase)) { throw 'attestation_vhd_scope_invalid' }

$mount = $null
try {
  $mount = Mount-VHD -Path $disk -ReadOnly -Passthru
  $root = Get-E1FinalMountedWindowsRoot $mount
  $source = Join-Path $root 'kmp-eval\measurement-scopes\evidence1-claude-windows-isolation-attestation-stageb-v1.json'
  if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or
      ((Get-Item -LiteralPath $source -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'guest_attestation_missing_or_reparse' }
  $bytes = [IO.File]::ReadAllBytes($source)
  $parsed = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) | ConvertFrom-Json -ErrorAction Stop
  if ([string]$parsed.profile_id -cne 'sandboxed-unrestricted-v1' -or [string]$parsed.platform -cne 'windows') { throw 'guest_attestation_identity_invalid' }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outFull) | Out-Null
  $stream = [IO.File]::Open($outFull, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  $hash = (Get-FileHash -LiteralPath $outFull -Algorithm SHA256).Hash.ToLowerInvariant()
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportFull) | Out-Null
  [ordered]@{schema=1;verdict='PASS';vm_name=[string]$vm.Name;vm_id=([string]$vm.Id).ToLowerInvariant();attestation_sha256=$hash;exact_bytes_copied=$true;raw_content_printed=$false;generated_at_utc=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')} |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $reportFull -Encoding UTF8
  Write-Host "[evidence1-final-codex-attestation-copy] PASS: $reportFull"
} finally {
  if ($mount) { Dismount-VHD -Path $disk -ErrorAction SilentlyContinue }
}

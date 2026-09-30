#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory)][string]$OperationId,
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [Parameter(Mandatory)][string]$OutDir,
  [Parameter(Mandatory)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking

if ($OperationId -cnotmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$') { throw 'operation_id_invalid' }
$expectedOut = "C:\kmp-eval\scratch\evidence1-dual-auth-canary-diagnostics\$OperationId"
$expectedReport = "C:\kmp-eval\scratch\evidence1-dual-auth-canary-diagnostics\$OperationId.report.json"
if (-not ([IO.Path]::GetFullPath($OutDir).Equals($expectedOut, [StringComparison]::OrdinalIgnoreCase)) -or
    -not ([IO.Path]::GetFullPath($ReportPath).Equals($expectedReport, [StringComparison]::OrdinalIgnoreCase))) { throw 'diagnostic_destination_not_canonical' }
if ((Test-Path -LiteralPath $OutDir) -or (Test-Path -LiteralPath $ReportPath)) { throw 'diagnostic_destination_must_be_create_new' }

$vm = Get-VM -Name $VMName -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant() -or $vm.State -ne 'Off') { throw 'exact_vm_must_be_off' }
$disk = (Get-VMHardDiskDrive -VMName $vm.Name | Select-Object -First 1).Path
if (-not ([IO.Path]::GetFullPath($disk)).StartsWith('C:\kmp-eval\hyperv-e2e\', [StringComparison]::OrdinalIgnoreCase)) { throw 'vhd_scope_invalid' }

$mount = $null
try {
  $mount = Mount-VHD -Path $disk -ReadOnly -Passthru
  $root = Get-E1FinalMountedWindowsRoot $mount
  $operationRoot = Join-Path $root "Evidence1Ops\remote-auth-canary-v2\$OperationId"
  if (-not (Test-Path -LiteralPath $operationRoot -PathType Container)) { throw 'canary_operation_missing' }

  # Closed set: only sanitized metadata/claim/result files at the top level are
  # ever read or copied. Directories are never descended into or copied,
  # regardless of name, since any of them may hold raw CLI stdout/stderr;
  # their names alone are reported for visibility.
  $allowedNames = @(
    'slot-1.claim.json', 'slot-1.result.json', 'slot-1.process.json',
    'slot-2.claim.json', 'slot-2.result.json', 'slot-2.process.json',
    'terminal-incomplete.json'
  )
  $topLevel = @(Get-ChildItem -LiteralPath $operationRoot -Force)
  $observedDirs = @($topLevel | Where-Object { $_.PSIsContainer } | ForEach-Object { $_.Name } | Sort-Object)
  $allFiles = @($topLevel | Where-Object { -not $_.PSIsContainer })
  $files = @($allFiles | Where-Object {
      $_.Name -in $allowedNames -and
      ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and
      [long]$_.Length -le 1048576
    })
  $skippedFiles = @($allFiles | Where-Object { $_.Name -notin @($files | ForEach-Object { $_.Name }) } | ForEach-Object { $_.Name } | Sort-Object)

  New-Item -ItemType Directory -Path $OutDir -ErrorAction Stop | Out-Null
  foreach ($file in $files) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $OutDir $file.Name) -ErrorAction Stop }

  $report = [ordered]@{
    schema = 1; verdict = 'PASS'; operation_id = $OperationId
    files_copied = @($files | ForEach-Object { $_.Name } | Sort-Object)
    files_observed_not_copied = $skippedFiles
    directories_observed_not_copied = $observedDirs
    raw_content_read = $false; raw_workspace_copied = $false
    generated_at_utc = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
  Write-Host "[evidence1-copy-dual-auth-canary-diagnostic] PASS: $ReportPath"
} finally {
  if ($mount) { Dismount-VHD -Path $disk -ErrorAction SilentlyContinue }
}

#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [Parameter(Mandatory)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$expectedReport = 'C:\kmp-eval\scratch\evidence1-final-codex-preflight-diagnostics\readonly-mount-recovery.json'
if (-not ([IO.Path]::GetFullPath($ReportPath).Equals($expectedReport, [StringComparison]::OrdinalIgnoreCase))) {
  throw 'recovery_report_path_not_canonical'
}
if (Test-Path -LiteralPath $ReportPath) { throw 'recovery_report_must_be_create_new' }
$vm = Get-VM -Name $VMName -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant() -or [string]$vm.State -cne 'Off') {
  throw 'exact_vm_must_be_off'
}
$disk = (Get-VMHardDiskDrive -VMName $vm.Name -ErrorAction Stop | Select-Object -First 1).Path
$fullDisk = [IO.Path]::GetFullPath($disk)
if (-not $fullDisk.StartsWith('C:\kmp-eval\hyperv-e2e\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'vhd_scope_invalid'
}
$vhd = Get-VHD -Path $fullDisk -ErrorAction Stop
$wasAttached = [bool]$vhd.Attached
if ($wasAttached) { Dismount-VHD -Path $fullDisk -ErrorAction Stop }
$after = Get-VHD -Path $fullDisk -ErrorAction Stop
if ($after.Attached) { throw 'readonly_mount_recovery_failed' }
$report = [ordered]@{
  schema = 1
  verdict = 'PASS'
  vm_name = $VMName
  vm_id = $ExpectedVMId
  vhd_path = $fullDisk
  was_attached = $wasAttached
  attached_after = [bool]$after.Attached
  generated_at_utc = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath) | Out-Null
[IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 5 -Compress), [Text.UTF8Encoding]::new($false))
Write-Host "[evidence1-recover-readonly-diagnostic-mount] PASS: $ReportPath"

#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [Parameter(Mandatory)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$full = [IO.Path]::GetFullPath($ReportPath)
if (-not $full.StartsWith('C:\kmp-eval\scratch\evidence1-vm-boot-state\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'report_path_invalid'
}
if (Test-Path -LiteralPath $full) { throw 'report_must_be_create_new' }
$vm = Get-VM -Name $VMName -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant()) { throw 'vm_identity_mismatch' }
$services = @(Get-VMIntegrationService -VMName $VMName -ErrorAction SilentlyContinue | ForEach-Object {
  [ordered]@{ name = [string]$_.Name; enabled = [bool]$_.Enabled; primary_status = [string]$_.PrimaryStatusDescription; secondary_status = [string]$_.SecondaryStatusDescription }
})
$diskPath = (Get-VMHardDiskDrive -VMName $VMName -ErrorAction Stop | Select-Object -First 1).Path
$vhd = Get-VHD -Path $diskPath -ErrorAction Stop
$report = [ordered]@{
  schema = 1; verdict = 'PASS'; vm_name = $VMName; vm_id = $ExpectedVMId
  state = [string]$vm.State; status = [string]$vm.Status; uptime_seconds = [math]::Round($vm.Uptime.TotalSeconds, 3)
  memory_assigned_bytes = [int64]$vm.MemoryAssigned; processor_load_percent = [int]$vm.CPUUsage
  vhd_attached = [bool]$vhd.Attached
  integration_services = $services
  generated_at_utc = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $full) | Out-Null
[IO.File]::WriteAllText($full, ($report | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
Write-Host "[evidence1-inspect-vm-boot-state] PASS: $full"

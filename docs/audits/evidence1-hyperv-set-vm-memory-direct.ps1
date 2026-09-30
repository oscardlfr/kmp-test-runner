#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [Parameter(Mandatory)][int]$StartupMemoryGiB,
  [Parameter(Mandatory)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($StartupMemoryGiB -notin @(8, 12, 16)) { throw 'vm_memory_startup_gib_invalid' }

$reportFull = [IO.Path]::GetFullPath($ReportPath)
$reportRoot = [IO.Path]::GetFullPath('C:\kmp-eval\scratch\evidence1-vm-memory').TrimEnd('\') + '\'
if (-not $reportFull.StartsWith($reportRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'vm_memory_report_outside_canonical_root'
}
if (Test-Path -LiteralPath $reportFull) { throw 'vm_memory_report_must_be_create_new' }

if ($VMName -cne 'Evidence1-Runner-E2E') { throw 'vm_memory_vm_name_not_e2e_profile' }

$vm = Get-VM -Name $VMName -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant()) {
  throw 'vm_memory_vm_identity_mismatch'
}
if ([string]$vm.State -cne 'Off') {
  throw 'vm_memory_vm_must_be_off'
}

$beforeMemory = Get-VMMemory -VM $vm
$before = [ordered]@{
  dynamic_memory_enabled = [bool]$beforeMemory.DynamicMemoryEnabled
  startup_bytes           = [int64]$vm.MemoryStartup
}

$startupBytes = [int64]$StartupMemoryGiB * 1GB
Set-VMMemory -VM $vm -DynamicMemoryEnabled $false -StartupBytes $startupBytes

$vmAfter = Get-VM -Name $VMName -ErrorAction Stop
if (([string]$vmAfter.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant()) {
  throw 'vm_memory_vm_identity_mismatch_after_set'
}
$afterMemory = Get-VMMemory -VM $vmAfter
$after = [ordered]@{
  dynamic_memory_enabled = [bool]$afterMemory.DynamicMemoryEnabled
  startup_bytes           = [int64]$vmAfter.MemoryStartup
}
if ($after.dynamic_memory_enabled -ne $false -or $after.startup_bytes -ne $startupBytes) {
  throw 'vm_memory_readback_mismatch'
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportFull) | Out-Null
[ordered]@{
  schema                       = 1
  verdict                      = 'PASS'
  vm_name                      = [string]$vmAfter.Name
  vm_id                        = ([string]$vmAfter.Id).ToLowerInvariant()
  requested_startup_memory_gib = $StartupMemoryGiB
  before                       = $before
  after                        = $after
  generated_at_utc             = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $reportFull -Encoding UTF8

Write-Host "[evidence1-set-vm-memory] PASS: $reportFull"

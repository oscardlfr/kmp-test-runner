#Requires -RunAsAdministrator

# 2026-09-29 (Amendment A6 follow-up, auditor-directed): read-only, host-only VHD/AVHDX chain
# inspection. Walks the E2E VM's currently-attached disk back through every parent to the root base
# disk via Get-VHD (never Get-VHD without elevation -- confirmed live, throws a permission error
# from this session's own non-elevated context), reporting each link's virtual size, allocated file
# size, block size, and logical sector size, plus every Get-VMHardDiskDrive path, VM state, and
# host C:/D: free/total bytes. Exists to answer one question with evidence instead of an assumed
# number: how much further can the guest's own differencing disk grow on the HOST before more
# disk-consuming guest activity (a fresh GREEN gate run) is safe, given the host's own free space is
# critically low (12.42 GB at the time this was written, auditor-confirmed worst-case growth is
# VirtualSize - avhdx FileSize, not a base+diff sum against one virtual size). Never mutates
# anything -- same closed-VMName, confined-create-new-ReportPath shape as
# evidence1-hyperv-set-vm-memory-direct.ps1, minus any write action at all.
#
# 2026-09-30 (auditor-directed revert): P0 #4 briefly made this script Import-Module
# evidence1-vm-state-hyperv.psm1 to reuse the walk via Get-E1VmVhdChain. Reverted -- the repo's own
# architectural invariant (Evidence1-Run-Broker-Capability-Wiring.Tests.ps1's "Global sweep: a
# *-hyperv.psm1 is importable only from evidence1-host-broker-capability-dispatch.ps1") reserves
# direct *-hyperv.psm1 imports for the one elevated dispatch entry point; every standalone
# "-direct.ps1" forensic script (this one, evidence1-hyperv-set-vm-memory-direct.ps1, etc.) stays
# fully self-contained instead, dispatched via the simpler host-elevated-runner-client, never the
# broker-capability queue. Get-E1VmVhdChain remains in evidence1-vm-state-hyperv.psm1, unchanged,
# for the vhd.inspect_chain capability the VmReady disk guard actually uses -- this script's own
# walk below is independently maintained, by design, not a shared implementation.
param(
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [Parameter(Mandatory)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$reportFull = [IO.Path]::GetFullPath($ReportPath)
$reportRoot = [IO.Path]::GetFullPath('C:\kmp-eval\scratch\evidence1-vhd-chain').TrimEnd('\') + '\'
if (-not $reportFull.StartsWith($reportRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'vhd_chain_report_outside_canonical_root'
}
if (Test-Path -LiteralPath $reportFull) { throw 'vhd_chain_report_must_be_create_new' }

if ($VMName -cne 'Evidence1-Runner-E2E') { throw 'vhd_chain_vm_name_not_e2e_profile' }

$vm = Get-VM -Name $VMName -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant()) {
  throw 'vhd_chain_vm_identity_mismatch'
}

$hardDiskDrives = @(Get-VMHardDiskDrive -VMName $VMName -ErrorAction Stop)
if (@($hardDiskDrives).Count -eq 0) { throw 'vhd_chain_disk_path_missing' }
$diskPath = $hardDiskDrives[0].Path
if ([string]::IsNullOrWhiteSpace($diskPath)) { throw 'vhd_chain_disk_path_missing' }

# Depth-guarded, not recursive: a chain is normally 1-3 links (base + one or two checkpoints) --
# 20 is generous headroom against ever spinning on a malformed/circular ParentPath, not an
# expected real depth.
$chain = @()
$currentPath = $diskPath
$depthGuard = 0
while (-not [string]::IsNullOrWhiteSpace($currentPath)) {
  $depthGuard++
  if ($depthGuard -gt 20) { throw 'vhd_chain_depth_exceeded' }
  $vhd = Get-VHD -Path $currentPath -ErrorAction Stop
  $isDifferencing = [string]$vhd.VhdType -ceq 'Differencing'
  $chain += [ordered]@{
    path                 = [string]$vhd.Path
    vhd_type             = [string]$vhd.VhdType
    virtual_size         = [int64]$vhd.Size
    file_size            = [int64]$vhd.FileSize
    parent_path          = if ($isDifferencing) { [string]$vhd.ParentPath } else { $null }
    block_size           = [int64]$vhd.BlockSize
    logical_sector_size  = [int64]$vhd.LogicalSectorSize
  }
  $currentPath = if ($isDifferencing) { [string]$vhd.ParentPath } else { $null }
}

# Host free space -- read-only WMI, needs no elevation on its own, but reported from here anyway
# so the auditor's whole requested receipt comes from one coherent source rather than splitting
# evidence across an elevated and a non-elevated call.
$hostVolumes = @(Get-CimInstance -ClassName Win32_LogicalDisk -ErrorAction Stop |
  Where-Object { $_.DeviceID -cin @('C:', 'D:') } |
  ForEach-Object { [ordered]@{ device_id = [string]$_.DeviceID; free_bytes = [int64]$_.FreeSpace; total_bytes = [int64]$_.Size } })

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportFull) | Out-Null
[ordered]@{
  schema                  = 1
  verdict                 = 'PASS'
  vm_name                 = [string]$vm.Name
  vm_id                   = ([string]$vm.Id).ToLowerInvariant()
  vm_state                = [string]$vm.State
  automatic_stop_action   = [string]$vm.AutomaticStopAction
  memory_startup_bytes    = [int64]$vm.MemoryStartup
  hard_disk_drive_paths   = @($hardDiskDrives | ForEach-Object { [string]$_.Path })
  attached_path           = [string]$diskPath
  chain                   = $chain
  host_volumes            = $hostVolumes
  generated_at_utc        = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportFull -Encoding UTF8

Write-Host "[evidence1-inspect-vhd-chain] PASS: $reportFull"

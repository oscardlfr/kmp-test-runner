#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory = $true)] [string]$InputLockPath,
  [Parameter(Mandatory = $true)] [string]$RecoveryReceiptPath,
  [Parameter(Mandatory = $true)] [string]$ReceiptPath,
  [Parameter(Mandatory = $true)] [string]$AuthorizationPhrase
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RequiredPhrase = 'authorize diagnose evidence1 recovered first boot without auth'
$RequiredProfileId = 'evidence1-windows-hyperv-e2e-v1'
$RequiredVmName = 'Evidence1-Runner-E2E'

if ($AuthorizationPhrase -cne $RequiredPhrase) { throw 'exact_first_boot_diagnostic_authorization_required' }

$snapshotContract = Join-Path $PSScriptRoot 'evidence1-host-snapshot-contract.psm1'
$chainContract = Join-Path $PSScriptRoot 'evidence1-host-windows-provisioning-chain.psm1'
Import-Module $snapshotContract -Force -ErrorAction Stop
Import-Module $chainContract -Force -ErrorAction Stop
$trustedRuntimeFiles = @(
  'tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json'
)
$runtime = Resolve-E1HostTrustedRuntime -ScriptRoot $PSScriptRoot `
  -EntrypointName 'evidence1-host-diagnose-windows-first-boot.ps1' -TrustedRuntimeFiles $trustedRuntimeFiles
$root = [string]$runtime.Root
$profilePath = Join-Path $root 'tools\evidence1\provisioning\evidence1-windows-hyperv-e2e-v1.json'
$profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
if ([string]$profile.profile_id -cne $RequiredProfileId -or [string]$profile.vm.name -cne $RequiredVmName) {
  throw 'canonical_e2e_profile_invalid'
}

$inputLockFull = Assert-E1WindowsProvisioningScratchPath $InputLockPath 'input_lock_path_outside_scratch' -MustExist
$prior = Read-E1WindowsProvisioningReceipt $RecoveryReceiptPath 'recovery_receipt'
$receiptFull = Assert-E1WindowsProvisioningScratchPath $ReceiptPath 'receipt_path_outside_scratch'
if (Test-Path -LiteralPath $receiptFull) { throw 'receipt_already_exists' }
$profileSha = Get-E1WindowsProvisioningSha256 $profilePath
$inputLockSha = Get-E1WindowsProvisioningSha256 $inputLockFull
if ([string]$prior.document.verdict -cne 'FAIL' -or [string]$prior.document.mode -cne 'Recovery' -or
    [string]$prior.document.reason_code -cne 'powershell_direct_deadline_exceeded' -or
    [string]$prior.document.profile_id -cne $RequiredProfileId -or
    [string]$prior.document.profile_sha256 -cne $profileSha -or
    [string]$prior.document.input_lock_sha256 -cne $inputLockSha -or
    [string]$prior.document.vm_state -cne 'Off' -or [string]$prior.document.network_state -cne 'disconnected' -or
    $prior.document.network_used -ne $false -or $prior.document.auth_material_read -ne $false -or
    $prior.document.auth_material_copied -ne $false -or [int]$prior.document.inference_sessions_consumed -ne 0) {
  throw 'recovery_receipt_not_eligible_for_first_boot_diagnostic'
}

function Get-E1DiagnosticTail([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 33554432) {
    throw 'first_boot_diagnostic_log_contract_invalid'
  }
  $selected = @(
    Get-Content -LiteralPath $Path -Tail 4000 -ErrorAction Stop |
      Where-Object {
        $_ -match '(?i)(error|fail|warning|unattend|oobe|specialize|image_state|0x[0-9a-f]{6,})' -and
        $_ -notmatch '(?i)(password|credential|token|secret|product.?key|defaultpassword)'
      } |
      ForEach-Object {
        $line = [string]$_
        if ($line.Length -gt 1000) { $line = $line.Substring(0, 1000) + '[TRUNCATED]' }
        $line
      } |
      Select-Object -Last 120
  )
  return [ordered]@{
    size_bytes = [int64]$item.Length
    sha256 = Get-E1WindowsProvisioningSha256 $Path
    selected_lines = $selected
  }
}

Import-Module Hyper-V -ErrorAction Stop
$vm = Get-VM -Id ([guid][string]$prior.document.vm_id) -ErrorAction Stop
if ([string]$vm.Name -cne $RequiredVmName -or [string]$vm.State -cne 'Off') { throw 'diagnostic_vm_identity_or_state_invalid' }
$adapters = @(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)
if ($adapters.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace([string]$adapters[0].SwitchName)) {
  throw 'diagnostic_vm_network_not_disconnected'
}
$hardDisks = @(Get-VMHardDiskDrive -VM $vm -ErrorAction Stop)
if ($hardDisks.Count -ne 1) { throw 'diagnostic_vm_vhd_contract_invalid' }
$vhdPath = [IO.Path]::GetFullPath([string]$hardDisks[0].Path)
$vmRoot = [IO.Path]::GetFullPath((Join-Path ([string]$profile.vm.root) $RequiredVmName)).TrimEnd('\') + '\'
if (-not $vhdPath.StartsWith($vmRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'diagnostic_vm_vhd_contract_invalid' }

$mounted = $null
try {
  $mounted = Mount-VHD -Path $vhdPath -ReadOnly -Passthru -ErrorAction Stop
  $disk = Get-Disk -Number $mounted.DiskNumber -ErrorAction Stop
  if ([string]$disk.PartitionStyle -cne 'GPT') { throw 'diagnostic_vhd_not_gpt' }
  $candidates = @()
  foreach ($partition in @(Get-Partition -DiskNumber $disk.Number -ErrorAction Stop)) {
    if ([int64]$partition.Size -lt 32GB) { continue }
    $volume = $partition | Get-Volume -ErrorAction SilentlyContinue
    $volumeGuid = @($partition.AccessPaths | Where-Object {
      ([string]$_).StartsWith('\\?\Volume{', [StringComparison]::OrdinalIgnoreCase) -and ([string]$_).EndsWith('}\')
    } | Select-Object -First 1)
    $accessPath = if ($volume -and $volume.DriveLetter) {
      [string]$volume.DriveLetter + ':\'
    } elseif ($volumeGuid.Count -eq 1) {
      [string]$volumeGuid[0]
    } else { $null }
    if ($volume -and [string]$volume.FileSystem -ceq 'NTFS' -and $accessPath) {
      $candidates += [pscustomobject]@{ partition = $partition; volume = $volume; access_path = $accessPath }
    }
  }
  if ($candidates.Count -ne 1) { throw 'diagnostic_windows_partition_ambiguous' }
  $windowsRoot = [string]$candidates[0].access_path
  if (-not (Test-Path -LiteralPath (Join-Path $windowsRoot 'Windows\System32\Config\SYSTEM') -PathType Leaf)) {
    throw 'diagnostic_windows_partition_invalid'
  }
  $markerPresent = Test-Path -LiteralPath (Join-Path $windowsRoot 'ProgramData\Evidence1\offline-apply-complete.marker') -PathType Leaf
  $targets = [ordered]@{
    panther_setupact = 'Windows\Panther\setupact.log'
    panther_setuperr = 'Windows\Panther\setuperr.log'
    unattendgc_setupact = 'Windows\Panther\UnattendGC\setupact.log'
    unattendgc_setuperr = 'Windows\Panther\UnattendGC\setuperr.log'
    sysprep_setupact = 'Windows\System32\Sysprep\Panther\setupact.log'
    sysprep_setuperr = 'Windows\System32\Sysprep\Panther\setuperr.log'
    setup_state = 'Windows\Setup\State\State.ini'
  }
  $logs = [ordered]@{}
  foreach ($label in $targets.Keys) {
    $candidate = Join-Path $windowsRoot $targets[$label]
    $logs[$label] = if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      Get-E1DiagnosticTail $candidate
    } else {
      [ordered]@{ missing = $true }
    }
  }
  $payload = [ordered]@{
    schema = 1; verdict = 'PASS'; mode = 'DiagnoseFirstBoot'; reason_code = $null
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    profile_id = $RequiredProfileId; profile_sha256 = $profileSha; input_lock_sha256 = $inputLockSha
    recovery_receipt_sha256 = [string]$prior.sha256; vm_id = ([string]$vm.Id).ToLowerInvariant()
    vm_state = 'Off'; network_used = $false; network_state = 'disconnected'; vhd_mounted_read_only = $true
    marker_present = [bool]$markerPresent; logs = $logs
    private_paths_persisted = $false; auth_material_read = $false; auth_material_copied = $false
    inference_sessions_consumed = 0
  }
  $parent = Split-Path -Parent $receiptFull
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $temporary = $receiptFull + '.tmp-' + [guid]::NewGuid().ToString('N')
  [IO.File]::WriteAllText($temporary, (($payload | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $receiptFull -ErrorAction Stop
} finally {
  if ($mounted) { Dismount-VHD -Path $vhdPath -ErrorAction SilentlyContinue }
}

Write-Host '[evidence1-host-diagnose-windows-first-boot] PASS'

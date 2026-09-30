#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [string]$SourcePath = 'C:\kmp-eval\source-fixtures\kmp-test-runner',
  [string]$ExpectedCommit = '7d45eae4f8720a0c77f507712ba2437ff974b6ed',
  [string]$ExpectedTree = '42c35b4f46f4fe5dfa23d2e3bf739cb487abb985',
  [Parameter(Mandatory)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking
$canonicalSource = 'C:\kmp-eval\source-fixtures\kmp-test-runner'
if (-not ([IO.Path]::GetFullPath($SourcePath).TrimEnd('\').Equals($canonicalSource, [StringComparison]::OrdinalIgnoreCase))) { throw 'source_path_not_canonical' }
if ($ExpectedCommit -cne '7d45eae4f8720a0c77f507712ba2437ff974b6ed' -or $ExpectedTree -cne '42c35b4f46f4fe5dfa23d2e3bf739cb487abb985') { throw 'source_pin_mismatch' }
$fullReport = [IO.Path]::GetFullPath($ReportPath)
if (-not $fullReport.StartsWith('C:\kmp-eval\scratch\evidence1-final-codex-source-sync\', [StringComparison]::OrdinalIgnoreCase)) { throw 'report_path_invalid' }
if (Test-Path -LiteralPath $fullReport) { throw 'report_must_be_create_new' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $fullReport) | Out-Null
$git = (Get-Command git.exe -ErrorAction Stop).Source
$hostGitArgs = @('-c', "safe.directory=$SourcePath", '-C', $SourcePath)
$head = (& $git @hostGitArgs rev-parse HEAD).Trim()
$tree = (& $git @hostGitArgs rev-parse 'HEAD^{tree}').Trim()
$dirty = @(& $git @hostGitArgs status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0 -or $head -cne $ExpectedCommit -or $tree -cne $ExpectedTree -or $dirty.Count -ne 0) { throw 'host_source_not_clean_or_pinned' }
$vm = Get-VM -Name $VMName -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant() -or [string]$vm.State -cne 'Off') { throw 'exact_vm_must_be_off' }
$disk = (Get-VMHardDiskDrive -VMName $VMName -ErrorAction Stop | Select-Object -First 1).Path
if (-not ([IO.Path]::GetFullPath($disk)).StartsWith('C:\kmp-eval\hyperv-e2e\', [StringComparison]::OrdinalIgnoreCase)) { throw 'vhd_scope_invalid' }
$mount = $null
$assignedAccessPath = $null
$mountAccessAdded = $false
try {
  $mount = Mount-VHD -Path $disk -Passthru -ErrorAction Stop
  $initialRoot = Get-E1FinalMountedWindowsRoot $mount
  $diskObject = $mount | Get-Disk -ErrorAction Stop
  $windowsPartitions = @($diskObject | Get-Partition -ErrorAction Stop | Where-Object {
    $paths = @($_.AccessPaths)
    @($paths | Where-Object { [string]$_ -ceq $initialRoot }).Count -eq 1
  })
  if ($windowsPartitions.Count -ne 1) { throw 'guest_windows_partition_not_unique' }
  $partition = $windowsPartitions[0]
  if ($partition.DriveLetter) {
    $root = ([string]$partition.DriveLetter) + ':\'
  } else {
    Add-PartitionAccessPath -DiskNumber $diskObject.Number -PartitionNumber $partition.PartitionNumber -AssignDriveLetter -ErrorAction Stop
    $partition = Get-Partition -DiskNumber $diskObject.Number -PartitionNumber $partition.PartitionNumber -ErrorAction Stop
    if (-not $partition.DriveLetter) { throw 'temporary_drive_letter_assignment_failed' }
    $assignedAccessPath = ([string]$partition.DriveLetter) + ':\'
    $mountAccessAdded = $true
    $root = $assignedAccessPath
  }
  $destination = Join-Path $root 'kmp-eval\source-fixtures\kmp-test-runner'
  $expectedParent = [IO.Path]::GetFullPath((Join-Path $root 'kmp-eval\source-fixtures')).TrimEnd('\')
  if (-not ([IO.Path]::GetFullPath($destination)).StartsWith($expectedParent + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'guest_source_destination_scope_invalid' }
  $reuseExisting = $false
  if (Test-Path -LiteralPath $destination) {
    try {
      $existingGitDir = Join-Path $destination '.git'
      $existingHead = ([string]::Join('', @(& $git --git-dir=$existingGitDir rev-parse HEAD))).Trim()
      $existingTree = ([string]::Join('', @(& $git --git-dir=$existingGitDir rev-parse 'HEAD^{tree}'))).Trim()
      $existingDirty = @(& $git --git-dir=$existingGitDir --work-tree=$destination status --porcelain=v1 --untracked-files=all)
      $reuseExisting = $LASTEXITCODE -eq 0 -and $existingHead -ceq $ExpectedCommit -and $existingTree -ceq $ExpectedTree -and $existingDirty.Count -eq 0
    } catch { $reuseExisting = $false }
  }
  if (-not $reuseExisting) {
    if (Test-Path -LiteralPath $destination) {
      $failedName = 'kmp-test-runner.failed-' + [guid]::NewGuid().ToString('N')
      Rename-Item -LiteralPath $destination -NewName $failedName -ErrorAction Stop
    }
    $staging = $destination + '.staging-' + [guid]::NewGuid().ToString('N')
    & $git init $staging | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'guest_source_git_init_failed' }
    & $git -C $staging config core.autocrlf false
    if ($LASTEXITCODE -ne 0) { throw 'guest_source_git_config_failed' }
    & $git -C $staging -c protocol.file.allow=always -c "safe.directory=$SourcePath" fetch --depth=1 $SourcePath $ExpectedCommit | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'guest_source_git_fetch_failed' }
    & $git -C $staging checkout --detach FETCH_HEAD | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'guest_source_git_checkout_failed' }
    Rename-Item -LiteralPath $staging -NewName 'kmp-test-runner' -ErrorAction Stop
  }
  $gitMetadata = Join-Path $destination '.git'
  $gitMetadataItem = Get-Item -LiteralPath $gitMetadata -Force -ErrorAction SilentlyContinue
  $precheck = [ordered]@{
    destination_exists = Test-Path -LiteralPath $destination -PathType Container
    git_metadata_exists = $null -ne $gitMetadataItem
    git_metadata_is_directory = $null -ne $gitMetadataItem -and $gitMetadataItem.PSIsContainer
    git_head_exists = Test-Path -LiteralPath (Join-Path $gitMetadata 'HEAD') -PathType Leaf
    git_config_exists = Test-Path -LiteralPath (Join-Path $gitMetadata 'config') -PathType Leaf
  }
  [IO.File]::WriteAllText(($fullReport + '.precheck.json'), ($precheck | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  if (-not $precheck.git_metadata_exists -or -not $precheck.git_head_exists -or -not $precheck.git_config_exists) { throw 'guest_source_git_metadata_incomplete' }
  $guestHead = ([string]::Join('', @(& $git --git-dir=$gitMetadata rev-parse HEAD))).Trim()
  $guestTree = ([string]::Join('', @(& $git --git-dir=$gitMetadata rev-parse 'HEAD^{tree}'))).Trim()
  $guestDirty = @(& $git --git-dir=$gitMetadata --work-tree=$destination status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $guestHead -cne $ExpectedCommit -or $guestTree -cne $ExpectedTree -or $guestDirty.Count -ne 0) { throw 'guest_source_not_clean_or_pinned' }
  & icacls.exe $destination /grant '*S-1-5-32-545:(OI)(CI)M' /T /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'source_acl_failed' }
  $fileCount = @(Get-ChildItem -LiteralPath $destination -File -Recurse -Force -ErrorAction Stop).Count
  $report = [ordered]@{
    schema = 1; verdict = 'PASS'; vm_name = $VMName; vm_id = $ExpectedVMId
    guest_source_path = 'C:\kmp-eval\source-fixtures\kmp-test-runner'
    source_commit = $guestHead; source_tree = $guestTree; clean = $true; file_count = $fileCount
    vhd_write_mount_dismounted = $true; generated_at_utc = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
  [IO.File]::WriteAllText($fullReport, ($report | ConvertTo-Json -Depth 6 -Compress), [Text.UTF8Encoding]::new($false))
  Write-Host "[evidence1-sync-final-codex-source] PASS: $fullReport"
} finally {
  if ($mountAccessAdded -and $assignedAccessPath) {
    Remove-PartitionAccessPath -DiskNumber $diskObject.Number -PartitionNumber $windowsPartitions[0].PartitionNumber -AccessPath $assignedAccessPath -ErrorAction SilentlyContinue
  }
  if ($mount) { Dismount-VHD -Path $disk -ErrorAction SilentlyContinue }
}

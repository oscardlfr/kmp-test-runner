#Requires -RunAsAdministrator

param(
  [string]$VMName='Evidence1-Runner-E2E',
  [string]$ExpectedVMId='fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [string]$ArtifactPath='C:\kmp-eval\scratch\evidence1-canonical-inputs\artifacts\android-sdk-platform36-buildtools36.normalized.zip',
  [string]$ReportPath='C:\kmp-eval\scratch\evidence1-final-codex-auth\android-sdk-restore.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking
$ExpectedArtifactSha256='e7a01612ebd0d37f7c183a4ed9a748ea490d65bab7145c50aae2c76982d2c579'
function ShaFile([string]$Path){return(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function ShaText([string]$Text){$a=[Security.Cryptography.SHA256]::Create();try{return([BitConverter]::ToString($a.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))-replace'-','').ToLowerInvariant()}finally{$a.Dispose()}}
function Tree([string]$Root){$files=@(Get-ChildItem -LiteralPath $Root -Recurse -Force -File|Where-Object Name -ne '.evidence1-artifact.json'|Sort-Object FullName);$b=[Text.StringBuilder]::new();[int64]$bytes=0;foreach($file in $files){$relative=$file.FullName.Substring($Root.Length).TrimStart('\').Replace('\','/');$null=$b.Append($relative).Append("`0").Append($file.Length).Append("`0").Append((ShaFile $file.FullName)).Append("`n");$bytes+=$file.Length};return [ordered]@{sha256=ShaText $b.ToString();file_count=$files.Count;bytes=$bytes}}
$artifact=[IO.Path]::GetFullPath($ArtifactPath);$canonicalArtifact=[IO.Path]::GetFullPath('C:\kmp-eval\scratch\evidence1-canonical-inputs\artifacts\android-sdk-platform36-buildtools36.normalized.zip')
$report=[IO.Path]::GetFullPath($ReportPath);$reportRoot=[IO.Path]::GetFullPath('C:\kmp-eval\scratch\evidence1-final-codex-auth').TrimEnd('\')+'\'
if(-not$artifact.Equals($canonicalArtifact,[StringComparison]::OrdinalIgnoreCase)-or(ShaFile $artifact)-cne$ExpectedArtifactSha256){throw 'android_sdk_artifact_identity_mismatch'}
if(-not$report.StartsWith($reportRoot,[StringComparison]::OrdinalIgnoreCase)-or(Test-Path -LiteralPath $report)){throw 'android_sdk_restore_report_invalid'}
$vm=Get-VM -Name $VMName -ErrorAction Stop;if([string]$vm.Name-cne'Evidence1-Runner-E2E'-or([string]$vm.Id).ToLowerInvariant()-cne$ExpectedVMId.ToLowerInvariant()-or[string]$vm.State-cne'Off'){throw 'android_sdk_restore_requires_exact_vm_off'}
$disk=(Get-VMHardDiskDrive -VMName $VMName|Select-Object -First 1).Path;if(-not([IO.Path]::GetFullPath($disk)).StartsWith('C:\kmp-eval\hyperv-e2e\',[StringComparison]::OrdinalIgnoreCase)){throw 'android_sdk_restore_vhd_scope_invalid'}
$mount=$null
try{
 $mount=Mount-VHD -Path $disk -Passthru;$root=Get-E1FinalMountedWindowsRoot $mount;$parent=Join-Path $root 'Evidence1Toolchain\android-sdk';$target=Join-Path $parent 'platform-36-build-tools-36.0.0';$stage=Join-Path $parent 'platform-36-build-tools-36.0.0.restore-stage';$backup=Join-Path $parent ('platform-36-build-tools-36.0.0.drifted-'+[DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))
 foreach($path in @($parent,$target,$stage,$backup)){if(-not([IO.Path]::GetFullPath($path)).StartsWith(([IO.Path]::GetFullPath($parent).TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)-and-not([IO.Path]::GetFullPath($path)).Equals([IO.Path]::GetFullPath($parent),[StringComparison]::OrdinalIgnoreCase)){throw 'android_sdk_restore_path_escape'}}
 if(-not(Test-Path -LiteralPath $target -PathType Container)-or(Test-Path -LiteralPath $backup)){throw 'android_sdk_restore_path_state_invalid'}
 $markerPath=Join-Path $target '.evidence1-artifact.json';$marker=Get-Content -LiteralPath $markerPath -Raw|ConvertFrom-Json -ErrorAction Stop
 if(-not(Test-Path -LiteralPath $stage -PathType Container)){New-Item -ItemType Directory -Path $stage -ErrorAction Stop|Out-Null;$tar=& tar.exe -xf $artifact -C $stage 2>&1;if($LASTEXITCODE-ne0){throw "android_sdk_restore_extract_failed:$($tar-join' ')"};Copy-Item -LiteralPath $markerPath -Destination (Join-Path $stage '.evidence1-artifact.json') -ErrorAction Stop}
 $tree=Tree $stage;if([string]$marker.id-cne'android-sdk'-or[string]$marker.version-cne'platform-36-build-tools-36.0.0'-or[string]$marker.installed_tree_sha256-cne$tree.sha256-or[long]$marker.installed_file_count-ne$tree.file_count-or[long]$marker.installed_bytes-ne$tree.bytes){throw 'android_sdk_verified_artifact_tree_mismatch'}
 Rename-Item -LiteralPath $target -NewName (Split-Path -Leaf $backup) -ErrorAction Stop
 try{Rename-Item -LiteralPath $stage -NewName (Split-Path -Leaf $target) -ErrorAction Stop}catch{Rename-Item -LiteralPath $backup -NewName (Split-Path -Leaf $target) -ErrorAction SilentlyContinue;throw}
 $post=Tree $target;if($post.sha256-cne$tree.sha256-or$post.file_count-ne$tree.file_count-or$post.bytes-ne$tree.bytes){throw 'android_sdk_post_restore_tree_mismatch'}
 New-Item -ItemType Directory -Force -Path (Split-Path -Parent $report)|Out-Null
 [ordered]@{schema=1;verdict='PASS';vm_name=[string]$vm.Name;vm_id=([string]$vm.Id).ToLowerInvariant();artifact_sha256=$ExpectedArtifactSha256;installed_tree_sha256=$post.sha256;installed_file_count=$post.file_count;installed_bytes=$post.bytes;drifted_tree_preserved=$true;backup_path=$backup;network_used=$false;generated_at_utc=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $report -Encoding UTF8
 Write-Host "[evidence1-restore-android-sdk] PASS: $report"
}finally{if($mount){Dismount-VHD -Path $disk -ErrorAction SilentlyContinue}}

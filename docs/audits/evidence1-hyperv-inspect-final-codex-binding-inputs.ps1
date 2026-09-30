#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [string]$ReportPath = 'C:\kmp-eval\scratch\evidence1-final-codex-auth\binding-inputs.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking

function ShaFile([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function ShaText([string]$Text) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))) -replace '-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}
function Tree([string]$Root) {
  $files = @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File | Where-Object Name -ne '.evidence1-artifact.json' | Sort-Object FullName)
  $builder = [Text.StringBuilder]::new(); [int64]$bytes = 0
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($Root.Length).TrimStart('\').Replace('\','/')
    $null = $builder.Append($relative).Append("`0").Append($file.Length).Append("`0").Append((ShaFile $file.FullName)).Append("`n")
    $bytes += $file.Length
  }
  return [ordered]@{sha256=ShaText $builder.ToString();file_count=$files.Count;bytes=$bytes}
}

$reportFull=[IO.Path]::GetFullPath($ReportPath);$reportRoot=[IO.Path]::GetFullPath('C:\kmp-eval\scratch\evidence1-final-codex-auth').TrimEnd('\')+'\'
if(-not$reportFull.StartsWith($reportRoot,[StringComparison]::OrdinalIgnoreCase)-or(Test-Path -LiteralPath $reportFull)){throw 'binding_inputs_report_invalid'}
$vm=Get-VM -Name $VMName -ErrorAction Stop
if([string]$vm.Name-cne'Evidence1-Runner-E2E'-or([string]$vm.Id).ToLowerInvariant()-cne$ExpectedVMId.ToLowerInvariant()-or[string]$vm.State-cne'Off'){throw 'binding_inputs_require_exact_vm_off'}
$disk=(Get-VMHardDiskDrive -VMName $VMName|Select-Object -First 1).Path
if(-not([IO.Path]::GetFullPath($disk)).StartsWith('C:\kmp-eval\hyperv-e2e\',[StringComparison]::OrdinalIgnoreCase)){throw 'binding_inputs_vhd_scope_invalid'}
$specs=@(@('git','2.55.0.windows.5'),@('git-bash','2.55.0.windows.5'),@('node','24.19.0'),@('jdk','21.0.12.1+1'),@('android-sdk','platform-36-build-tools-36.0.0'),@('claude-code','2.1.238'),@('codex-cli','0.154.0'))
$mount=$null
try{
  $mount=Mount-VHD -Path $disk -ReadOnly -Passthru;$root=Get-E1FinalMountedWindowsRoot $mount;$trees=[ordered]@{}
  foreach($spec in $specs){$id=$spec[0];$version=$spec[1];$runtime=Join-Path $root "Evidence1Toolchain\$id\$version";$markerPath=Join-Path $runtime '.evidence1-artifact.json';if(-not(Test-Path -LiteralPath $markerPath -PathType Leaf)){throw "binding_inputs_marker_missing:$id"};$marker=Get-Content -LiteralPath $markerPath -Raw|ConvertFrom-Json;$actual=Tree $runtime;if([string]$marker.id-cne$id-or[string]$marker.version-cne$version-or[string]$marker.installed_tree_sha256-cne$actual.sha256-or[long]$marker.installed_file_count-ne$actual.file_count-or[long]$marker.installed_bytes-ne$actual.bytes){throw "binding_inputs_tree_drift:$id"};$trees[$id]=$actual.sha256}
  $projection=@($trees.Keys|Sort-Object|ForEach-Object{"$_=$($trees[$_])"})-join"`n";$toolchain=ShaText $projection
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportFull)|Out-Null
  [ordered]@{schema=1;verdict='PASS';vm_name=[string]$vm.Name;vm_id=([string]$vm.Id).ToLowerInvariant();toolchain_sha256=$toolchain;runtime_tree_sha256=$trees;raw_content_printed=$false;generated_at_utc=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $reportFull -Encoding UTF8
  Write-Host "[evidence1-final-codex-binding-inputs] PASS: $reportFull"
}finally{if($mount){Dismount-VHD -Path $disk -ErrorAction SilentlyContinue}}

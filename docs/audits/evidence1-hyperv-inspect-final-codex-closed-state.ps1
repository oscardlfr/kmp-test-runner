#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory)][string]$CampaignId,
  [string]$VMName='Evidence1-Runner-E2E',
  [string]$ExpectedVMId='fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [Parameter(Mandatory)][string]$ReportPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking
if($CampaignId-cnotmatch'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'){throw 'campaign_id_invalid'}
$expected="C:\kmp-eval\scratch\evidence1-final-codex-recovery-inspection\$CampaignId.json"
if(-not([IO.Path]::GetFullPath($ReportPath).Equals($expected,[StringComparison]::OrdinalIgnoreCase))-or(Test-Path -LiteralPath $ReportPath)){throw 'report_path_invalid'}
$vm=Get-VM -Name $VMName -ErrorAction Stop
if(([string]$vm.Id).ToLowerInvariant()-cne$ExpectedVMId.ToLowerInvariant()-or[string]$vm.State-cne'Off'){throw 'exact_vm_must_be_off'}
$disk=(Get-VMHardDiskDrive -VMName $VMName|Select-Object -First 1).Path
$mount=$null
try{
 $mount=Mount-VHD -Path $disk -ReadOnly -Passthru -ErrorAction Stop;$root=Get-E1FinalMountedWindowsRoot $mount
 $ops=Join-Path $root 'Evidence1Ops\final-codex';$runDir=Join-Path $ops $CampaignId
 $terminalPath=Join-Path $ops "$CampaignId.terminal.json";$claimPath=Join-Path $ops "$CampaignId.terminal.claim.json"
 $private=Join-Path $root "Evidence1Custody\$CampaignId";$public=Join-Path $root "kmp-eval\agentic-eval-codex-runtime\tools\runs\evidence1-codex-pilot-$CampaignId"
 $terminal=$null;if(Test-Path -LiteralPath $terminalPath -PathType Leaf){$terminal=Get-Content -LiteralPath $terminalPath -Raw|ConvertFrom-Json -ErrorAction Stop}
 $slotClaims=@();$slots=Join-Path $runDir 'slots';if(Test-Path -LiteralPath $slots){$slotClaims=@(Get-ChildItem -LiteralPath $slots -File -Recurse -Filter '*.claim.json' -ErrorAction Stop)}
 $privateFiles=@();if(Test-Path -LiteralPath $private){$privateFiles=@(Get-ChildItem -LiteralPath $private -File -Recurse -ErrorAction Stop)}
 $publicFiles=@();if(Test-Path -LiteralPath $public){$publicFiles=@(Get-ChildItem -LiteralPath $public -File -Recurse -ErrorAction Stop)}
 $value=[ordered]@{schema=1;verdict='PASS';campaign_id=$CampaignId;vm_state='Off';terminal_present=$null-ne$terminal;terminal_claim_present=(Test-Path -LiteralPath $claimPath -PathType Leaf);terminal=$(if($terminal){[ordered]@{state=[string]$terminal.state;exit_code=[int]$terminal.exit_code;reason_code=[string]$terminal.reason_code;retry_count=[int]$terminal.retry_count;replacement_or_respawn_used=[bool]$terminal.replacement_or_respawn_used;publication_manifest_bound=-not[string]::IsNullOrWhiteSpace([string]$terminal.publication_manifest_sha256);campaign_custody_bound=-not[string]::IsNullOrWhiteSpace([string]$terminal.campaign_custody_sha256)}}else{$null});run_dir_present=(Test-Path -LiteralPath $runDir -PathType Container);group_claim_present=(Test-Path -LiteralPath (Join-Path $runDir 'group.claim.json') -PathType Leaf);slot_claim_file_count=$slotClaims.Count;private_custody_present=(Test-Path -LiteralPath $private -PathType Container);private_file_count=$privateFiles.Count;private_manifest_present=(Test-Path -LiteralPath (Join-Path $private 'publication-manifest.json') -PathType Leaf);private_custody_record_present=(Test-Path -LiteralPath (Join-Path $private 'campaign-custody.json') -PathType Leaf);public_result_present=(Test-Path -LiteralPath $public -PathType Container);public_file_count=$publicFiles.Count;public_summary_present=(Test-Path -LiteralPath (Join-Path $public 'summary.json') -PathType Leaf);raw_provider_content_read=$false;generated_at_utc=[datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
 New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath)|Out-Null
 [IO.File]::WriteAllText($ReportPath,($value|ConvertTo-Json -Depth 8 -Compress),[Text.UTF8Encoding]::new($false))
 Write-Host "[evidence1-inspect-final-codex-closed-state] PASS: $ReportPath"
}finally{if($mount){Dismount-VHD -Path $disk -ErrorAction SilentlyContinue}}

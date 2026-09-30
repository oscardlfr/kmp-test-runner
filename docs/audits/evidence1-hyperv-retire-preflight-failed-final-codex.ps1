#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory)][string]$BindingPath,
  [Parameter(Mandatory)][string]$BindingSha256,
  [Parameter(Mandatory)][string]$PlacementReportPath,
  [Parameter(Mandatory)][string]$PlacementReportSha256,
  [Parameter(Mandatory)][string]$GlobalAuthorizationClaimPath,
  [Parameter(Mandatory)][string]$GlobalAuthorizationClaimSha256,
  [ValidateSet(
    'source_dir_missing_before_provider_spawn',
    'attestation_file_missing_before_provider_spawn',
    'readiness_vm_binding_missing_before_provider_spawn',
    'runtime_dependency_missing_before_provider_spawn',
    'offline_runtime_preflight_failed_before_provider_spawn'
  )][string]$FailureReasonCode='source_dir_missing_before_provider_spawn',
  [Parameter(Mandatory)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking
function Assert-Hash([string]$Path,[string]$Expected,[string]$Code) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Expected) { throw $Code }
}
Assert-Hash $BindingPath $BindingSha256 'binding_hash_mismatch'
Assert-Hash $PlacementReportPath $PlacementReportSha256 'placement_hash_mismatch'
Assert-Hash $GlobalAuthorizationClaimPath $GlobalAuthorizationClaimSha256 'global_claim_hash_mismatch'
$binding = Get-Content -LiteralPath $BindingPath -Raw | ConvertFrom-Json -ErrorAction Stop
$placement = Get-Content -LiteralPath $PlacementReportPath -Raw | ConvertFrom-Json -ErrorAction Stop
$campaignId = [string]$binding.campaign_id
if ($campaignId -cnotmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$' -or $placement.campaign_id -cne $campaignId -or
  $placement.verdict -cne 'PASS' -or $placement.binding_sha256 -cne $BindingSha256 -or
  $binding.global_authorization_claim_sha256 -cne $GlobalAuthorizationClaimSha256) { throw 'retire_identity_chain_invalid' }
$reportRoot = 'C:\kmp-eval\scratch\evidence1-final-codex-abandoned'
$expectedReport = Join-Path $reportRoot ($campaignId + '.preflight-failed.json')
if (-not ([IO.Path]::GetFullPath($ReportPath).Equals($expectedReport,[StringComparison]::OrdinalIgnoreCase))) { throw 'report_path_not_canonical' }
if (Test-Path -LiteralPath $ReportPath) { throw 'report_must_be_create_new' }
$startReservation = "C:\kmp-eval\scratch\evidence1-final-codex-start\$campaignId.reserved.json"
$startTerminal = "C:\kmp-eval\scratch\evidence1-final-codex-start\$campaignId.terminal.json"
foreach ($path in @($startReservation,$startTerminal)) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'expected_host_start_evidence_missing' } }
$vm = Get-VM -Name ([string]$binding.vm_name) -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne ([string]$binding.vm_id).ToLowerInvariant() -or [string]$vm.State -cne 'Off') { throw 'exact_vm_must_be_off' }
$disk = (Get-VMHardDiskDrive -VMName $vm.Name -ErrorAction Stop | Select-Object -First 1).Path
if (-not ([IO.Path]::GetFullPath($disk)).StartsWith('C:\kmp-eval\hyperv-e2e\',[StringComparison]::OrdinalIgnoreCase)) { throw 'vhd_scope_invalid' }
$mount = $null
$offlineReceiptValid=$false
$custodyRelative=@()
try {
  $mount = Mount-VHD -Path $disk -Passthru -ErrorAction Stop
  $root = Get-E1FinalMountedWindowsRoot $mount
  $ops = Join-Path $root 'Evidence1Ops\final-codex'
  $runDir = Join-Path $ops $campaignId
  $runtimeDir = Join-Path $root "ProgramData\KmpEval\Evidence1FinalCodexRuntime\$campaignId"
  $terminalPath = Join-Path $ops "$campaignId.terminal.json"
  $terminalClaimPath = Join-Path $ops "$campaignId.terminal.claim.json"
  $runArchive = Join-Path $ops "$campaignId.preflight-failed"
  $runtimeArchive = Join-Path (Split-Path -Parent $runtimeDir) "$campaignId.preflight-failed"
  $artifactArchive = Join-Path $root "Evidence1Ops\abandoned-final-codex\$campaignId-preflight-failed"
  $archivedTerminalPath=Join-Path $artifactArchive (Split-Path -Leaf $terminalPath)
  $archivedTerminalClaimPath=Join-Path $artifactArchive (Split-Path -Leaf $terminalClaimPath)
  foreach($pair in @(@($runDir,$runArchive),@($runtimeDir,$runtimeArchive))){
    $active=Test-Path -LiteralPath $pair[0] -PathType Container;$archived=Test-Path -LiteralPath $pair[1] -PathType Container
    if($active-eq$archived){throw 'preflight_failure_directory_state_invalid'}
  }
  $runEvidenceDir=if(Test-Path -LiteralPath $runDir -PathType Container){$runDir}else{$runArchive}
  $terminalEvidencePath=if(Test-Path -LiteralPath $terminalPath -PathType Leaf){$terminalPath}else{$archivedTerminalPath}
  if(-not(Test-Path -LiteralPath $terminalEvidencePath -PathType Leaf)-or
     -not((Test-Path -LiteralPath $terminalClaimPath -PathType Leaf)-or(Test-Path -LiteralPath $archivedTerminalClaimPath -PathType Leaf))){throw 'preflight_failure_evidence_missing'}
  $terminal = Get-Content -LiteralPath $terminalEvidencePath -Raw | ConvertFrom-Json -ErrorAction Stop
  if ($terminal.state -cne 'failed' -or $terminal.reason_code -cne 'launcher_failed_no_retry' -or [int]$terminal.retry_count -ne 0 -or $terminal.replacement_or_respawn_used -ne $false) { throw 'unexpected_preflight_terminal' }
  $groupClaim = Join-Path $runEvidenceDir 'group.claim.json'
  $slotClaims = @()
  $slotRoot = Join-Path $runEvidenceDir 'slots'
  if (Test-Path -LiteralPath $slotRoot) { $slotClaims = @(Get-ChildItem -LiteralPath $slotRoot -File -Recurse -ErrorAction Stop) }
  $custody = Join-Path $root "Evidence1Custody\$campaignId"
  $custodyArchive=Join-Path $artifactArchive 'preflight-custody'
  $custodyFiles=@(if(Test-Path -LiteralPath $custody -PathType Container){Get-ChildItem -LiteralPath $custody -File -Recurse -ErrorAction Stop})
  $archivedCustodyFiles=@(if(Test-Path -LiteralPath $custodyArchive -PathType Container){Get-ChildItem -LiteralPath $custodyArchive -File -Recurse -ErrorAction Stop})
  $allowedCustodyFiles=@('offline-runtime-preflight.json','offline-runtime-preflight.stderr.log','dry-run.stdout.json','dry-run.stderr.log')
  $custodyRelative=@(@($custodyFiles|ForEach-Object{$_.FullName.Substring($custody.Length+1).Replace('\','/')})+@($archivedCustodyFiles|ForEach-Object{$_.FullName.Substring($custodyArchive.Length+1).Replace('\','/')}))|Select-Object -Unique
  if ((Test-Path -LiteralPath $groupClaim) -or $slotClaims.Count -ne 0 -or
      @($custodyRelative|Where-Object{$_ -cnotin $allowedCustodyFiles}).Count-ne 0) { throw 'provider_boundary_crossed' }
  $offlineReceiptPath=if(Test-Path -LiteralPath (Join-Path $custody 'offline-runtime-preflight.json') -PathType Leaf){Join-Path $custody 'offline-runtime-preflight.json'}else{Join-Path $custodyArchive 'offline-runtime-preflight.json'}
  if((Test-Path -LiteralPath $offlineReceiptPath -PathType Leaf)-and(Get-Item -LiteralPath $offlineReceiptPath).Length-gt 0){
    try{$offlineReceipt=Get-Content -LiteralPath $offlineReceiptPath -Raw|ConvertFrom-Json -ErrorAction Stop;$offlineReceiptValid=[int]$offlineReceipt.inference_sessions_consumed-eq 0}catch{throw 'offline_preflight_receipt_invalid'}
    if(-not$offlineReceiptValid){throw 'provider_boundary_crossed'}
  }
  if(Test-Path -LiteralPath $runDir -PathType Container){Rename-Item -LiteralPath $runDir -NewName "$campaignId.preflight-failed" -ErrorAction Stop}
  if(Test-Path -LiteralPath $runtimeDir -PathType Container){Rename-Item -LiteralPath $runtimeDir -NewName "$campaignId.preflight-failed" -ErrorAction Stop}
  New-Item -ItemType Directory -Path $artifactArchive -Force -ErrorAction Stop | Out-Null
  Complete-E1FinalFileMove $terminalPath $archivedTerminalPath $true
  Complete-E1FinalFileMove $terminalClaimPath $archivedTerminalClaimPath $true
  foreach($path in @((Join-Path $ops "$campaignId.stdout.log"),(Join-Path $ops "$campaignId.stderr.log"))){Complete-E1FinalFileMove $path (Join-Path $artifactArchive (Split-Path -Leaf $path)) $false}
  if($custodyFiles.Count-gt 0){New-Item -ItemType Directory -Path $custodyArchive -Force -ErrorAction Stop|Out-Null}
  foreach($file in $custodyFiles){Copy-E1FinalVerifiedThenRemove $file.FullName (Join-Path $custodyArchive $file.Name)}
  if(Test-Path -LiteralPath $custody -PathType Container){
    if(@(Get-ChildItem -LiteralPath $custody -Force).Count-ne 0){throw 'retirement_custody_source_not_empty'}
    Remove-Item -LiteralPath $custody -Force -ErrorAction Stop
  }
} finally {
  if ($mount) { Dismount-VHD -Path $disk -ErrorAction SilentlyContinue }
}
$hostArchive = Join-Path $reportRoot "$campaignId-preflight-failed"
$archivedClaim = Join-Path $hostArchive 'global.authorization.claim.json'
if((Test-Path -LiteralPath $GlobalAuthorizationClaimPath -PathType Leaf)-and(Test-Path -LiteralPath $archivedClaim -PathType Leaf)){throw 'retirement_split_global_claim_state'}
if(-not(Test-Path -LiteralPath $archivedClaim -PathType Leaf)){
  New-Item -ItemType Directory -Path $hostArchive -Force -ErrorAction Stop | Out-Null
  Move-Item -LiteralPath $GlobalAuthorizationClaimPath -Destination $archivedClaim -ErrorAction Stop
}
Assert-Hash $archivedClaim $GlobalAuthorizationClaimSha256 'archived_claim_hash_mismatch'
$value = [ordered]@{
  schema=1;kind='evidence1-final-codex-preflight-failed-retirement';verdict='PASS';campaign_id=$campaignId
  binding_sha256=$BindingSha256;placement_report_sha256=$PlacementReportSha256;global_authorization_claim_sha256=$GlobalAuthorizationClaimSha256
  start_boundary_crossed=$true;provider_spawn_boundary_crossed=$false;provider_sessions_consumed=0
  offline_preflight_receipt_valid=$offlineReceiptValid;offline_preflight_files=@($custodyRelative)
  retry_count=0;replacement_or_respawn_used=$false;reason_code=$FailureReasonCode
  archived_global_claim_path=$archivedClaim;retired_at_utc=[datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}
New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
[IO.File]::WriteAllText($ReportPath,(($value|ConvertTo-Json -Depth 8 -Compress)+"`n"),[Text.UTF8Encoding]::new($false))
Write-Host "[evidence1-final-codex-retire-preflight-failed] PASS: $ReportPath"

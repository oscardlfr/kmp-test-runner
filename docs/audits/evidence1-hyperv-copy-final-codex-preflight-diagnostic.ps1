#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory)][string]$CampaignId,
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [Parameter(Mandatory)][string]$OutDir,
  [Parameter(Mandatory)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking
if ($CampaignId -cnotmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$') { throw 'campaign_id_invalid' }
$expectedOut = "C:\kmp-eval\scratch\evidence1-final-codex-preflight-diagnostics\$CampaignId"
$expectedReport = "C:\kmp-eval\scratch\evidence1-final-codex-preflight-diagnostics\$CampaignId.report.json"
if (-not ([IO.Path]::GetFullPath($OutDir).Equals($expectedOut,[StringComparison]::OrdinalIgnoreCase)) -or
    -not ([IO.Path]::GetFullPath($ReportPath).Equals($expectedReport,[StringComparison]::OrdinalIgnoreCase))) { throw 'diagnostic_destination_not_canonical' }
if ((Test-Path -LiteralPath $OutDir) -or (Test-Path -LiteralPath $ReportPath)) { throw 'diagnostic_destination_must_be_create_new' }
$vm = Get-VM -Name $VMName -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant() -or $vm.State -ne 'Off') { throw 'exact_vm_must_be_off' }
$disk = (Get-VMHardDiskDrive -VMName $vm.Name | Select-Object -First 1).Path
if (-not ([IO.Path]::GetFullPath($disk)).StartsWith('C:\kmp-eval\hyperv-e2e\',[StringComparison]::OrdinalIgnoreCase)) { throw 'vhd_scope_invalid' }
$mount=$null
try {
  $mount=Mount-VHD -Path $disk -ReadOnly -Passthru
  $root=Get-E1FinalMountedWindowsRoot $mount
  $ops=Join-Path $root 'Evidence1Ops\final-codex'
  $campaign=Join-Path $ops $CampaignId
  $custody=Join-Path $root "Evidence1Custody\$CampaignId"
  $terminal=Join-Path $ops "$CampaignId.terminal.json"
  $terminalClaim=Join-Path $ops "$CampaignId.terminal.claim.json"
  $stdout=Join-Path $ops "$CampaignId.stdout.log"
  $stderr=Join-Path $ops "$CampaignId.stderr.log"
  if(-not(Test-Path -LiteralPath $terminal -PathType Leaf)){throw 'preflight_terminal_missing'}
  $slotFiles=@(Get-ChildItem -LiteralPath (Join-Path $campaign 'slots') -File -Recurse -ErrorAction SilentlyContinue)
  $groupClaim=Join-Path $campaign 'group.claim.json'
  $custodyFiles=@()
  if(Test-Path -LiteralPath $custody){$custodyFiles=@(Get-ChildItem -LiteralPath $custody -File -Recurse -ErrorAction SilentlyContinue)}
  $allowedCustodyFiles=@(
    'offline-runtime-preflight.json','offline-runtime-preflight.stderr.log',
    'dry-run.stdout.json','dry-run.stderr.log'
  )
  $custodyRelative=@($custodyFiles|ForEach-Object{$_.FullName.Substring($custody.Length+1).Replace('\','/')})
  if((Test-Path -LiteralPath $groupClaim)-or$slotFiles.Count-ne 0-or@($custodyRelative|Where-Object{$_ -cnotin $allowedCustodyFiles}).Count-ne 0){throw 'provider_boundary_crossed_not_preflight_only'}
  foreach($file in $custodyFiles){
    if(($file.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0-or[long]$file.Length-gt 1048576){
      throw 'preflight_diagnostic_file_invalid'
    }
  }
  $offlineReceiptPath=Join-Path $custody 'offline-runtime-preflight.json'
  $offlineReceiptValid=$false
  if((Test-Path -LiteralPath $offlineReceiptPath -PathType Leaf)-and(Get-Item -LiteralPath $offlineReceiptPath).Length-gt 0){
    try{$offlineReceipt=Get-Content -LiteralPath $offlineReceiptPath -Raw|ConvertFrom-Json -ErrorAction Stop;$offlineReceiptValid=[int]$offlineReceipt.inference_sessions_consumed-eq 0}catch{throw 'offline_preflight_receipt_invalid'}
    if(-not$offlineReceiptValid){throw 'provider_boundary_crossed_not_preflight_only'}
  }
  $terminalValue=Get-Content -LiteralPath $terminal -Raw|ConvertFrom-Json -ErrorAction Stop
  if($terminalValue.state-cne'failed'-or$terminalValue.reason_code-notin@('launcher_failed_no_retry','wrapper_preflight_failed_no_retry')){throw 'unexpected_terminal_for_preflight_diagnostic'}
  New-Item -ItemType Directory -Path $OutDir -ErrorAction Stop|Out-Null
  foreach($entry in @(@($terminal,'terminal.json'),@($terminalClaim,'terminal.claim.json'),@($stdout,'wrapper.stdout.log'),@($stderr,'wrapper.stderr.log'))){if(Test-Path -LiteralPath $entry[0] -PathType Leaf){Copy-Item -LiteralPath $entry[0] -Destination (Join-Path $OutDir $entry[1]) -ErrorAction Stop}}
  foreach($file in $custodyFiles){Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $OutDir $file.Name) -ErrorAction Stop}
  $stderrLines=if(Test-Path -LiteralPath $stderr -PathType Leaf){@(Get-Content -LiteralPath $stderr -ErrorAction Stop)}else{@()}
  $report=[ordered]@{schema=1;verdict='PASS';campaign_id=$CampaignId;terminal_state=$terminalValue.state;terminal_reason_code=$terminalValue.reason_code;terminal_exit_code=[int]$terminalValue.exit_code;terminal_claim_present=(Test-Path -LiteralPath $terminalClaim -PathType Leaf);wrapper_stdout_present=(Test-Path -LiteralPath $stdout -PathType Leaf);wrapper_stderr_present=(Test-Path -LiteralPath $stderr -PathType Leaf);group_claim_present=$false;slot_claim_count=0;custody_file_count=$custodyFiles.Count;offline_preflight_receipt_valid=$offlineReceiptValid;pre_provider_diagnostic_files=@($custodyRelative);provider_sessions_consumed=0;stderr_lines=@($stderrLines|Select-Object -Last 20);raw_provider_content_read=$false;out_dir=$OutDir;generated_at_utc=[datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
  $report|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $ReportPath -Encoding UTF8
  Write-Host "[evidence1-final-codex-preflight-diagnostic] PASS: $ReportPath"
}finally{if($mount){Dismount-VHD -Path $disk -ErrorAction SilentlyContinue}}

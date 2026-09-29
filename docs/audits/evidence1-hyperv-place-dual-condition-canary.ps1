#Requires -RunAsAdministrator
param(
  [ValidateSet('Prepare','Arm')][string]$Mode = 'Prepare',
  [Parameter(Mandatory)][ValidateSet('product','free-baseline')][string]$Arm,
  [Parameter(Mandatory)][string]$PairId,
  [Parameter(Mandatory)][string]$GroupRunId,
  [Parameter(Mandatory)][string]$ProfilePath,
  [Parameter(Mandatory)][string]$CreatedInspectionReceiptPath,
  [Parameter(Mandatory)][string]$GuestCredentialPath,
  [string]$HostBundleDir = '',
  [string]$AuthorizationPhrase = '',
  [Parameter(Mandatory)][string]$RemoteAuthCanaryOperationId,
  [string]$CurrentInputsJson = '',
  [ValidateRange(1,10080)][int]$RemoteAuthMaxAgeMinutes = 10080,
  [ValidateRange(1,86400)][int]$ProcessTimeoutSeconds = 1800,
  [string]$ReportPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$GuestLedgerRoot = 'C:\Evidence1Ops\dual-condition-ledger'
$GuestOpsRoot = 'C:\Evidence1Ops'
Import-Module (Join-Path $PSScriptRoot 'evidence1-dual-condition-canary-contract.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'evidence1-vm-identity-contract.psm1') -Force -DisableNameChecking
$vmIdentity=Get-Evidence1CanonicalE2EVmIdentity -ProfilePath $ProfilePath -CreatedInspectionReceiptPath $CreatedInspectionReceiptPath -GuestCredentialPath $GuestCredentialPath
$VMName=$vmIdentity.vm_name;$ExpectedVMId=$vmIdentity.vm_id;$VMRoot=$vmIdentity.vm_root;$GuestUser=$vmIdentity.guest_user

function Assert-E1Inside([string]$Candidate,[string]$Root,[string]$Code) {
  $candidateFull=[IO.Path]::GetFullPath($Candidate); $rootFull=[IO.Path]::GetFullPath($Root).TrimEnd('\')+'\'
  if (-not $candidateFull.StartsWith($rootFull,[StringComparison]::OrdinalIgnoreCase)) { throw $Code }
}
function Write-E1CreateNew([string]$Path,$Value) {
  $null=New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 20 -Compress))
  $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
}
function Get-E1TextHash([string]$Text) {
  $sha=[Security.Cryptography.SHA256]::Create(); try {return -join ($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text))|ForEach-Object {$_.ToString('x2')})} finally {$sha.Dispose()}
}
function Get-E1FileHash([string]$Path){$s=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{$h=[Security.Cryptography.SHA256]::Create();try{return -join($h.ComputeHash($s)|ForEach-Object{$_.ToString('x2')})}finally{$h.Dispose()}}finally{$s.Dispose()}}
function Get-E1CurrentInputs([string]$Json) {
  if ([string]::IsNullOrWhiteSpace($Json)) { throw 'dual_condition_current_inputs_required' }
  try { $currentInputs = $Json | ConvertFrom-Json -ErrorAction Stop } catch { throw 'dual_condition_current_inputs_invalid' }
  $expected=@('harness_commit','harness_tree','source_commit','source_tree','claude_product_plan_sha256','claude_free_plan_sha256',
    'codex_product_plan_sha256','codex_free_plan_sha256','claude_attestation_sha256','codex_attestation_sha256',
    'skill_snapshot_sha256','inference_sessions_consumed')
  $actual=@($currentInputs.PSObject.Properties.Name)
  if(@(Compare-Object ($actual|Sort-Object) ($expected|Sort-Object)).Count-ne0-or[int]$currentInputs.inference_sessions_consumed-ne0){
    throw 'dual_condition_current_inputs_invalid'
  }
  foreach($name in @('harness_commit','harness_tree','source_commit','source_tree')){if([string]$currentInputs.$name-cnotmatch'^[a-f0-9]{40,64}$'){throw 'dual_condition_current_inputs_invalid'}}
  foreach($name in @($expected|Where-Object{$_-like'*sha256'})){if([string]$currentInputs.$name-cnotmatch'^[a-f0-9]{64}$'){throw 'dual_condition_current_inputs_invalid'}}
  return $currentInputs
}

if (-not $HostBundleDir) { $HostBundleDir=Join-Path 'C:\kmp-eval\scratch\dual-condition-canary' "$PairId\$GroupRunId" }
if (-not $ReportPath) { $ReportPath=Join-Path 'C:\kmp-eval\scratch\dual-condition-canary\reports' "$PairId\$GroupRunId\PLACE-$Mode.json" }
Assert-E1Inside $HostBundleDir 'C:\kmp-eval\scratch\dual-condition-canary' 'dual_condition_host_bundle_root'
Assert-E1Inside $ReportPath 'C:\kmp-eval\scratch\dual-condition-canary' 'dual_condition_report_root'
$guestOperation=Get-Evidence1DualConditionCanaryOperationRoot $GuestLedgerRoot $PairId $GroupRunId
$deployedHarnessRoot=Join-Path $PSScriptRoot 'node-runtime'
$repositoryHarnessRoot=[IO.Path]::GetFullPath((Join-Path (Join-Path $PSScriptRoot '..') '..'))
$harnessRoot=$(if(Test-Path -LiteralPath (Join-Path $deployedHarnessRoot 'package.json') -PathType Leaf){
  [IO.Path]::GetFullPath($deployedHarnessRoot)
}else{
  $repositoryHarnessRoot
})
$validatorManifest=Get-Evidence1DualConditionValidatorBundleManifest $harnessRoot
$null=Assert-Evidence1DualConditionValidatorBundle $harnessRoot $validatorManifest
$evidenceId='Evidence'+'1'

if ($Mode -ceq 'Prepare') {
  $currentInputs = Get-E1CurrentInputs $CurrentInputsJson
  $claudePlanName=$(if($Arm-ceq'product'){'claude_product_plan_sha256'}else{'claude_free_plan_sha256'})
  $codexPlanName=$(if($Arm-ceq'product'){'codex_product_plan_sha256'}else{'codex_free_plan_sha256'})
  $bindingArgs=@{Arm=$Arm;LedgerRoot=$GuestLedgerRoot;PairId=$PairId;GroupRunId=$GroupRunId;HarnessCommit=[string]$currentInputs.harness_commit;HarnessTree=[string]$currentInputs.harness_tree;
    SourceCommit=[string]$currentInputs.source_commit;SourceTree=[string]$currentInputs.source_tree;
    ClaudePlanSha256=[string]$currentInputs.$claudePlanName;CodexPlanSha256=[string]$currentInputs.$codexPlanName;ClaudeAttestationSha256=[string]$currentInputs.claude_attestation_sha256;
    CodexAttestationSha256=[string]$currentInputs.codex_attestation_sha256;ValidatorBundleManifest=$validatorManifest;
    RemoteAuthMaxAgeMinutes=$RemoteAuthMaxAgeMinutes;ProcessTimeoutSeconds=$ProcessTimeoutSeconds}
  if ($Arm -ceq 'product') { $bindingArgs.SkillSnapshotSha256=[string]$currentInputs.skill_snapshot_sha256 }
  $binding=New-Evidence1DualConditionCanaryBinding @bindingArgs
  if (Test-Path -LiteralPath $HostBundleDir) { throw 'dual_condition_prepare_replay' }
  foreach($path in @($HostBundleDir,(Join-Path $HostBundleDir 'slots'),(Join-Path $HostBundleDir 'slots\0'),(Join-Path $HostBundleDir 'slots\0\audit'),(Join-Path $HostBundleDir 'slots\1'),(Join-Path $HostBundleDir 'slots\1\audit'))){$null=New-Item -ItemType Directory -Path $path}
  Write-E1CreateNew (Join-Path $HostBundleDir 'binding.json') $binding
  $bindingHash=Get-E1FileHash (Join-Path $HostBundleDir 'binding.json')
  $literal="AUTORIZO EXACTAMENTE 2 SESIONES LIVE NUEVAS DEL $evidenceId DUAL-RUNTIME WINDOWS CANARY $(if($Arm -ceq 'product'){'PRODUCT'}else{'FREE-BASELINE'}) PARA PAIR $PairId, GROUP $GroupRunId, EN ORDEN $(@($binding.runtime_order) -join ' -> '); SIN REINTENTOS, REEMPLAZOS NI RESPAWNS"
  Write-E1CreateNew $ReportPath ([ordered]@{schema=1;state='prepared';arm=$Arm;pair_id=$PairId;group_run_id=$GroupRunId;binding_sha256=$bindingHash;
    required_authorization_phrase=$literal;planned_sessions=2;runtime_order=@($binding.runtime_order);vm_mutated=$false;inference_sessions_consumed=0})
  Write-Output $literal
  exit 0
}

if (-not (Test-Path -LiteralPath (Join-Path $HostBundleDir 'binding.json') -PathType Leaf)) { throw 'dual_condition_binding_missing' }
$staged=Get-Content -LiteralPath (Join-Path $HostBundleDir 'binding.json') -Raw|ConvertFrom-Json -ErrorAction Stop
$null=Assert-Evidence1DualConditionCanaryBinding $staged
if($staged.arm-cne$Arm-or$staged.pair_id-cne$PairId-or$staged.group_run_id-cne$GroupRunId){throw 'dual_condition_staged_binding_identity'}
$bindingHash=Get-E1FileHash (Join-Path $HostBundleDir 'binding.json')
$literal="AUTORIZO EXACTAMENTE 2 SESIONES LIVE NUEVAS DEL $evidenceId DUAL-RUNTIME WINDOWS CANARY $(if($Arm -ceq 'product'){'PRODUCT'}else{'FREE-BASELINE'}) PARA PAIR $PairId, GROUP $GroupRunId, EN ORDEN $(@($staged.runtime_order) -join ' -> '); SIN REINTENTOS, REEMPLAZOS NI RESPAWNS"
if ($AuthorizationPhrase -cne $literal) { throw 'dual_condition_authorization_required' }

$claim=[ordered]@{schema=1;kind='dual-condition-authorization-claim';pair_id=$PairId;group_run_id=$GroupRunId;binding_sha256=$bindingHash;
  authorization_scope_id=$staged.authorization_scope_id;authorization_sha256=Get-E1TextHash $literal;planned_sessions=2;retry_limit=0}
$vm=Get-VM -Name $VMName -ErrorAction Stop
if ([string]$vm.Id -cne $ExpectedVMId -or [string]$vm.State -cne 'Off') { throw 'dual_condition_vm_not_off' }
$drive=Get-VMHardDiskDrive -VMName $VMName|Select-Object -First 1
if (-not $drive){throw 'dual_condition_vhd_missing'}; Assert-E1Inside $drive.Path $VMRoot 'dual_condition_vhd_root'
$mount=$null
try {
  $mount=Mount-VHD -Path $drive.Path -Passthru
  $disk=$mount|Get-Disk
  $windowsCandidates=@()
  foreach($partition in @($disk|Get-Partition -ErrorAction Stop)){
    $volume=$partition|Get-Volume -ErrorAction SilentlyContinue
    $volumeGuid=@($partition.AccessPaths|Where-Object{([string]$_).StartsWith('\\?\Volume{',[StringComparison]::OrdinalIgnoreCase)-and([string]$_).EndsWith('}\')}|Select-Object -First 1)
    $accessPath=$(if($volume-and$volume.DriveLetter){([string]$volume.DriveLetter)+':\'}elseif($volumeGuid.Count-eq1){[string]$volumeGuid[0]}else{$null})
    if($volume-and[string]$volume.FileSystem-ceq'NTFS'-and$accessPath-and
      (Test-Path -LiteralPath (Join-Path $accessPath 'Windows\System32\Config\SYSTEM') -PathType Leaf)){
      $windowsCandidates+=[pscustomobject]@{access_path=$accessPath}
    }
  }
  if($windowsCandidates.Count-ne1){throw 'dual_condition_windows_volume_missing'}
  $root=[string]$windowsCandidates[0].access_path; $ops=Join-Path $root 'Evidence1Ops'; $guestOnHost=Join-Path $root ($guestOperation.Substring(3))
  if(Test-Path -LiteralPath $guestOnHost){throw 'dual_condition_guest_operation_replay'}
  foreach($path in @($guestOnHost,(Join-Path $guestOnHost 'slots'),(Join-Path $guestOnHost 'slots\0'),(Join-Path $guestOnHost 'slots\0\audit'),(Join-Path $guestOnHost 'slots\1'),(Join-Path $guestOnHost 'slots\1\audit'))){$null=New-Item -ItemType Directory -Path $path -Force}
  $bindingBytes=[IO.File]::ReadAllBytes((Join-Path $HostBundleDir 'binding.json'))
  $bindingStream=[IO.File]::Open((Join-Path $guestOnHost 'binding.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{$bindingStream.Write($bindingBytes,0,$bindingBytes.Length);$bindingStream.Flush($true)}finally{$bindingStream.Dispose()}
  if((Get-E1FileHash (Join-Path $guestOnHost 'binding.json')) -cne $bindingHash){throw 'dual_condition_guest_binding_copy_hash'}
  Write-E1CreateNew (Join-Path $guestOnHost 'authorization.claim.json') $claim
  $validatorRoot=Join-Path $ops 'dual-condition-validator\current'
  $validatorPreviouslyPresent=Test-Path -LiteralPath $validatorRoot -PathType Container
  $null=New-Item -ItemType Directory -Path $validatorRoot -Force
  foreach($file in @($validatorManifest.files)){
    $sourceFile=Join-Path $harnessRoot ([string]$file.relative_path).Replace('/','\')
    $destinationFile=Join-Path $validatorRoot ([string]$file.relative_path).Replace('/','\')
    $null=New-Item -ItemType Directory -Path (Split-Path -Parent $destinationFile) -Force
    $bytes=[IO.File]::ReadAllBytes($sourceFile);$stream=[IO.File]::Open($destinationFile,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
  }
  $startup=Join-Path $root "Users\$GuestUser\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Evidence1DualCondition.cmd"
  if(Test-Path -LiteralPath $startup){throw 'dual_condition_startup_replay'}
  $guestWrapper='C:\Evidence1Ops\dual-condition-validator\current\docs\audits\evidence1-dual-condition-canary-wrapper.ps1'
  [IO.File]::WriteAllText($startup,"@echo off`r`nC:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$guestWrapper`" -OperationRoot `"$guestOperation`" -RemoteAuthCanaryOperationId `"$RemoteAuthCanaryOperationId`" -ShutdownOnExit`r`ndel `"%~f0`" >nul 2>nul`r`n",[Text.Encoding]::ASCII)
  Write-E1CreateNew $ReportPath ([ordered]@{schema=1;state='armed';arm=$Arm;pair_id=$PairId;group_run_id=$GroupRunId;binding_sha256=$bindingHash;
    validator_bundle_sha256=$validatorManifest.bundle_sha256;validator_destination_verified=$true;validator_overwrite_used=[bool]$validatorPreviouslyPresent;
    vm_name=$VMName;vm_id=$ExpectedVMId;guest_operation_root=$guestOperation;planned_sessions=2;retry_count=0;replacement_or_respawn_used=$false;authorization_phrase_persisted_in_guest=$false})
} finally {if($mount){Dismount-VHD -Path $drive.Path -ErrorAction SilentlyContinue}}

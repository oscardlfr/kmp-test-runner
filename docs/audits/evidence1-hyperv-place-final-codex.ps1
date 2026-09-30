#Requires -RunAsAdministrator
param(
 [Parameter(Mandatory)][string]$BindingPath,[Parameter(Mandatory)][string]$BindingSha256,
 [Parameter(Mandatory)][string]$AuthorizationClaimPath,[Parameter(Mandatory)][string]$AuthorizationClaimSha256,
 [Parameter(Mandatory)][string]$GlobalAuthorizationClaimPath,[Parameter(Mandatory)][string]$GlobalAuthorizationClaimSha256,
 [Parameter(Mandatory)][string]$RemoteAuthCanaryPath,[Parameter(Mandatory)][string]$RemoteAuthCanarySha256,
 [Parameter(Mandatory)][string]$CanonicalRepositoryRoot,
 [Parameter(Mandatory)][string]$ReportPath
)
Set-StrictMode -Version Latest; $ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking
$bindingRoot=[IO.Path]::GetFullPath((Split-Path -Parent $BindingPath)).TrimEnd('\')
$canonicalGlobalRoot='C:\kmp-eval\scratch\evidence1-final-codex-authorization-claims'
if(-not ([IO.Path]::GetFullPath($AuthorizationClaimPath)).Equals((Join-Path $bindingRoot 'authorization.claim.json'),[StringComparison]::OrdinalIgnoreCase) -or
   -not ([IO.Path]::GetFullPath($RemoteAuthCanaryPath)).Equals((Join-Path $bindingRoot 'remote-auth-canary.json'),[StringComparison]::OrdinalIgnoreCase) -or
   -not ([IO.Path]::GetFullPath((Split-Path -Parent $GlobalAuthorizationClaimPath))).TrimEnd('\').Equals($canonicalGlobalRoot,[StringComparison]::OrdinalIgnoreCase)){
 throw 'final_campaign_input_path_binding_invalid'
}
foreach($path in @($BindingPath,$AuthorizationClaimPath,$GlobalAuthorizationClaimPath,$RemoteAuthCanaryPath)){Assert-E1FinalNoReparseAncestors $path}
if((Get-FileHash $BindingPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $BindingSha256 -or (Get-FileHash $AuthorizationClaimPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $AuthorizationClaimSha256 -or (Get-FileHash $GlobalAuthorizationClaimPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $GlobalAuthorizationClaimSha256 -or (Get-FileHash $RemoteAuthCanaryPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $RemoteAuthCanarySha256){throw 'binding_hash_mismatch'}
$binding=Get-Content $BindingPath -Raw|ConvertFrom-Json
$repositoryRoot=Assert-E1FinalCanonicalRepository $CanonicalRepositoryRoot $binding.harness_commit $binding.harness_tree
$claim=Get-Content $AuthorizationClaimPath -Raw|ConvertFrom-Json
$globalClaim=Get-Content $GlobalAuthorizationClaimPath -Raw|ConvertFrom-Json
if($binding.runtime_id -cne 'codex-cli' -or $binding.cli_version -cne '0.154.0' -or $binding.model_requested -cne 'gpt-5.6-terra' -or $binding.model_resolved -cne 'gpt-5.6-terra' -or [int]$binding.authorized_sessions -ne 6 -or $binding.harness_tree-cnotmatch'^[0-9a-f]{40}$' -or [string]$binding.guest_readiness_sha256-cnotmatch'^[0-9a-f]{64}$' -or $binding.remote_auth_sha256 -cne $RemoteAuthCanarySha256 -or $binding.global_authorization_claim_sha256 -cne $GlobalAuthorizationClaimSha256){throw 'binding_contract_invalid'}
if($claim.binding_sha256 -cne $BindingSha256 -or $claim.global_authorization_claim_sha256 -cne $GlobalAuthorizationClaimSha256 -or [int]$claim.retry_count -ne 0 -or $claim.replacement_authorized -ne $false -or $claim.respawn_authorized -ne $false){throw 'authorization_claim_contract_invalid'}
if($globalClaim.remote_auth_sha256 -cne $RemoteAuthCanarySha256 -or $globalClaim.readiness_sha256 -cne $binding.readiness_sha256 -or
   [string]$globalClaim.vm_name-cne[string]$binding.vm_name-or([string]$globalClaim.vm_id).ToLowerInvariant()-cne([string]$binding.vm_id).ToLowerInvariant()-or
   [int]$globalClaim.authorized_sessions -ne 6 -or $globalClaim.authorization_scope-cne'exactly-six-codex-sessions' -or [int]$globalClaim.retry_count-ne 0 -or $globalClaim.replacement_authorized-ne$false -or $globalClaim.respawn_authorized-ne$false){throw 'global_authorization_claim_contract_invalid'}
$boundVmName=[string]$binding.vm_name;$boundVmId=([string]$binding.vm_id).ToLowerInvariant()
if([string]::IsNullOrWhiteSpace($boundVmName)-or$boundVmId-cnotmatch'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'){throw 'binding_vm_identity_invalid'}
$vm=Get-VM -Name $boundVmName -ErrorAction Stop
if(([string]$vm.Id).ToLowerInvariant() -cne $boundVmId -or $vm.State -ne 'Off'){throw 'exact_e2e_vm_must_be_off'}
$scriptMap=[ordered]@{launcher='docs/audits/evidence1-codex-live-launch.ps1';wrapper='docs/audits/evidence1-final-codex-guest-wrapper.ps1';validation_helper='docs/audits/evidence1-validation-ops.psm1';campaign_control='tools/agentic-eval/final-campaign-control.mjs';pilot_describe='docs/audits/evidence1-codex-pilot-describe.mjs';publication_scan='docs/audits/evidence1-codex-publication-scan.mjs'}
if(@($binding.script_sha256.PSObject.Properties.Name).Count-ne 6){throw 'bound_script_map_invalid'}
foreach($name in $scriptMap.Keys){if(-not($binding.script_sha256.PSObject.Properties.Name-ccontains$name)){throw 'bound_script_map_invalid'};$source=Join-Path $repositoryRoot $scriptMap[$name];if((Get-FileHash $source -Algorithm SHA256).Hash.ToLowerInvariant()-cne $binding.script_sha256.$name){throw 'bound_script_hash_mismatch'}}
$snapshotManifestPath=Join-Path $PSScriptRoot 'evidence1-host-elevated-runner-manifest.json';Assert-E1FinalNoReparseAncestors $snapshotManifestPath
$snapshotManifest=Get-Content -LiteralPath $snapshotManifestPath -Raw|ConvertFrom-Json -ErrorAction Stop
$snapshotManifestSha256=(Get-FileHash $snapshotManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
$null=Assert-E1FinalRunnerManifest $snapshotManifest $binding.harness_commit
$supportName='evidence1-live-handoff-contract.psm1'
$supportEntries=@($snapshotManifest.support_files|Where-Object{[string]$_.name-ceq$supportName})
if($supportEntries.Count-ne 1-or[string]$supportEntries[0].sha256-cnotmatch'^[0-9a-f]{64}$'){throw 'snapshot_support_binding_invalid'}
$supportSha256=[string]$supportEntries[0].sha256
$supportSource=Join-Path $PSScriptRoot $supportName
if(-not(Test-Path -LiteralPath $supportSource -PathType Leaf)-or(Get-FileHash $supportSource -Algorithm SHA256).Hash.ToLowerInvariant()-cne$supportSha256){throw 'snapshot_support_hash_mismatch'}
$snapshotNodeRoot=Join-Path $PSScriptRoot 'node-runtime';$snapshotNodeMap=Assert-E1FinalNodeSnapshotBinding $snapshotManifest $snapshotNodeRoot $repositoryRoot
foreach($pair in @(@('docs/audits/evidence1-codex-pilot-describe.mjs','pilot_describe'),@('docs/audits/evidence1-codex-publication-scan.mjs','publication_scan'))){if(-not$snapshotNodeMap.ContainsKey($pair[0])-or$snapshotNodeMap[$pair[0]]-cne$binding.script_sha256.($pair[1])){throw 'snapshot_bound_node_hash_mismatch'}}
$reportRoot='C:\kmp-eval\scratch\evidence1-final-codex-place';$expectedReport=Join-Path $reportRoot ($binding.campaign_id+'.json')
if(-not([IO.Path]::GetFullPath($ReportPath).Equals($expectedReport,[StringComparison]::OrdinalIgnoreCase))){throw 'final_report_path_not_canonical_scratch'}
$reservationPrerequisites=[ordered]@{binding_sha256=$BindingSha256;global_authorization_claim_sha256=$GlobalAuthorizationClaimSha256;remote_auth_sha256=$RemoteAuthCanarySha256;script_sha256=$binding.script_sha256}
$reservationPath=$ReportPath+'.claim.json'
if(Test-Path -LiteralPath $reservationPath){
 $reservation=Get-Content -LiteralPath $reservationPath -Raw|ConvertFrom-Json -ErrorAction Stop
 $expectedReservationKeys=@('schema','kind','campaign_id','report_path_sha256','prerequisites','reserved_at_utc')
 $expectedPrerequisiteKeys=@('binding_sha256','global_authorization_claim_sha256','remote_auth_sha256','script_sha256')
 if(@(Compare-Object @($reservation.PSObject.Properties.Name|Sort-Object) @($expectedReservationKeys|Sort-Object)).Count-ne 0-or
    @(Compare-Object @($reservation.prerequisites.PSObject.Properties.Name|Sort-Object) @($expectedPrerequisiteKeys|Sort-Object)).Count-ne 0-or
    [int]$reservation.schema-ne 1-or$reservation.kind-cne'evidence1-final-codex-place-reservation'-or$reservation.campaign_id-cne$binding.campaign_id-or
    $reservation.report_path_sha256-cne(Get-E1TextSha256 ([IO.Path]::GetFullPath($ReportPath)))-or
    $reservation.prerequisites.binding_sha256-cne$BindingSha256-or$reservation.prerequisites.global_authorization_claim_sha256-cne$GlobalAuthorizationClaimSha256-or
    $reservation.prerequisites.remote_auth_sha256-cne$RemoteAuthCanarySha256-or
    (($reservation.prerequisites.script_sha256|ConvertTo-Json -Compress)-cne($binding.script_sha256|ConvertTo-Json -Compress))){throw 'placement_reservation_invalid'}
}else{
 $null=New-E1FinalOperationReservation -ReportPath $ReportPath -ReportRoot $reportRoot -Kind 'evidence1-final-codex-place-reservation' -CampaignId $binding.campaign_id -Prerequisites $reservationPrerequisites
}
$disk=(Get-VMHardDiskDrive -VMName $vm.Name|Select-Object -First 1).Path
if(-not $disk.StartsWith('C:\kmp-eval\hyperv-e2e\',[StringComparison]::OrdinalIgnoreCase)){throw 'vhd_scope_invalid'}
$mount=$null
$diskObject=$null
$windowsPartition=$null
$assignedAccessPath=$null
$mountAccessAdded=$false
try{
 $mount=Mount-VHD -Path $disk -Passthru
 $initialRoot=Get-E1FinalMountedWindowsRoot $mount
 $diskObject=$mount|Get-Disk -ErrorAction Stop
 $windowsPartitions=@($diskObject|Get-Partition -ErrorAction Stop|Where-Object{
   $paths=@($_.AccessPaths)
   @($paths|Where-Object{[string]$_ -ceq $initialRoot}).Count-eq 1
 })
 if($windowsPartitions.Count-ne 1){throw 'guest_windows_partition_not_unique'}
 $windowsPartition=$windowsPartitions[0]
 if($windowsPartition.DriveLetter){
   $root=([string]$windowsPartition.DriveLetter)+':\'
 }else{
   Add-PartitionAccessPath -DiskNumber $diskObject.Number -PartitionNumber $windowsPartition.PartitionNumber -AssignDriveLetter -ErrorAction Stop
   $windowsPartition=Get-Partition -DiskNumber $diskObject.Number -PartitionNumber $windowsPartition.PartitionNumber -ErrorAction Stop
   if(-not$windowsPartition.DriveLetter){throw 'temporary_drive_letter_assignment_failed'}
   $assignedAccessPath=([string]$windowsPartition.DriveLetter)+':\'
   $mountAccessAdded=$true
   $root=$assignedAccessPath
 }
 $guestRepository=Join-Path $root 'kmp-eval\agentic-eval-codex-runtime'
 $guestGitMetadata=Join-Path $guestRepository '.git'
 if(-not(Test-Path -LiteralPath $guestRepository -PathType Container)-or-not(Test-Path -LiteralPath $guestGitMetadata)){throw 'guest_canonical_repository_missing'}
 $gitExe=(Get-Command git.exe -ErrorAction Stop).Source
 $guestGitArgs=@('-c',"safe.directory=$guestRepository",'-C',$guestRepository)
 $guestHead=([string]::Join('',@(& $gitExe @guestGitArgs rev-parse HEAD))).Trim()
 $guestTree=([string]::Join('',@(& $gitExe @guestGitArgs rev-parse 'HEAD^{tree}'))).Trim()
 $guestDirty=@(& $gitExe @guestGitArgs status --porcelain=v1 --untracked-files=all)
 if($LASTEXITCODE-ne 0-or$guestHead-cne[string]$binding.harness_commit-or$guestTree-cne[string]$binding.harness_tree-or$guestDirty.Count-ne 0){throw 'guest_canonical_repository_not_clean_or_pinned'}
 $ops=Join-Path $root 'Evidence1Ops\final-codex'; if(-not(Test-Path -LiteralPath $ops)){New-Item -ItemType Directory -Path $ops -ErrorAction Stop|Out-Null}
 $runId=$binding.campaign_id; $runDir=Join-Path $ops $runId; New-Item -ItemType Directory -Path $runDir -ErrorAction Stop|Out-Null
 $runtimeBase=Join-Path $root 'ProgramData\KmpEval\Evidence1FinalCodexRuntime';Assert-E1FinalNoReparseAncestors $runtimeBase;if(-not(Test-Path -LiteralPath $runtimeBase)){New-Item -ItemType Directory -Path $runtimeBase -Force -ErrorAction Stop|Out-Null};Set-E1FinalGuestRuntimeAcl $runtimeBase $true;Assert-E1FinalGuestRuntimeAcl $runtimeBase $true
 $runtimeDir=Join-Path $runtimeBase $runId;if(Test-Path -LiteralPath $runtimeDir){throw 'guest_runtime_must_be_create_new'};New-Item -ItemType Directory -Path $runtimeDir -ErrorAction Stop|Out-Null
 $assets=@('evidence1-codex-live-launch.ps1','evidence1-final-codex-guest-wrapper.ps1','evidence1-validation-ops.psm1',$supportName)
 foreach($name in $assets){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $runtimeDir $name) -ErrorAction Stop}
 Copy-Item -LiteralPath $snapshotNodeRoot -Destination $runtimeDir -Recurse -ErrorAction Stop
 Copy-Item -LiteralPath $snapshotManifestPath -Destination (Join-Path $runtimeDir 'node-runtime.manifest.json') -ErrorAction Stop
 Copy-Item $BindingPath (Join-Path $runDir 'binding.json') -ErrorAction Stop; Copy-Item $AuthorizationClaimPath (Join-Path $runDir 'authorization.claim.json') -ErrorAction Stop
 Copy-Item $GlobalAuthorizationClaimPath (Join-Path $runDir 'global.authorization.claim.json') -ErrorAction Stop;Copy-Item $RemoteAuthCanaryPath (Join-Path $runDir 'remote-auth-canary.json') -ErrorAction Stop
 foreach($pair in @(@('binding.json',$BindingSha256),@('authorization.claim.json',$AuthorizationClaimSha256),@('global.authorization.claim.json',$GlobalAuthorizationClaimSha256),@('remote-auth-canary.json',$RemoteAuthCanarySha256))){if((Get-FileHash (Join-Path $runDir $pair[0]) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pair[1]){throw 'staged_blob_hash_mismatch'}}
 foreach($name in @('launcher','wrapper','validation_helper')){$leaf=Split-Path -Leaf $scriptMap[$name];if((Get-FileHash (Join-Path $runtimeDir $leaf) -Algorithm SHA256).Hash.ToLowerInvariant()-cne $binding.script_sha256.$name){throw 'staged_script_hash_mismatch'}}
 if((Get-FileHash (Join-Path $runtimeDir $supportName) -Algorithm SHA256).Hash.ToLowerInvariant()-cne$supportSha256){throw 'staged_support_hash_mismatch'}
 $guestNodeRoot=Join-Path $runtimeDir 'node-runtime';$guestExpectedFiles=@{};$guestExpectedDirs=@{};foreach($entry in @($snapshotManifest.node_files)){$relative=[string]$entry.name;$path=Join-Path $guestNodeRoot $relative.Replace('/','\');Assert-E1FinalNoReparseAncestors $path;if(-not(Test-Path -LiteralPath $path -PathType Leaf)-or(Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()-cne[string]$entry.sha256){throw 'staged_node_hash_mismatch'};$guestExpectedFiles[$relative]=$true;$parent=Split-Path -Parent $relative.Replace('/','\');while($parent){$guestExpectedDirs[$parent.Replace('\','/')]=$true;$next=Split-Path -Parent $parent;if($next-ceq$parent){break};$parent=$next}}
 $guestActualFiles=@(Get-ChildItem -LiteralPath $guestNodeRoot -File -Force -Recurse|ForEach-Object{$_.FullName.Substring($guestNodeRoot.Length+1).Replace('\','/')}|Sort-Object);$guestActualDirs=@(Get-ChildItem -LiteralPath $guestNodeRoot -Directory -Force -Recurse|ForEach-Object{if(($_.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'staged_node_reparse_rejected'};$_.FullName.Substring($guestNodeRoot.Length+1).Replace('\','/')}|Sort-Object)
 if(@(Compare-Object $guestActualFiles @($guestExpectedFiles.Keys|Sort-Object)).Count-ne 0-or@(Compare-Object $guestActualDirs @($guestExpectedDirs.Keys|Sort-Object)).Count-ne 0){throw 'staged_node_closed_set_invalid'}
 if((Get-FileHash (Join-Path $runtimeDir 'node-runtime.manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()-cne$snapshotManifestSha256){throw 'staged_node_manifest_hash_mismatch'}
 foreach($directory in @((Get-Item -LiteralPath $runtimeDir -Force))+@(Get-ChildItem -LiteralPath $runtimeDir -Directory -Force -Recurse)){Set-E1FinalGuestRuntimeAcl $directory.FullName $true;Assert-E1FinalGuestRuntimeAcl $directory.FullName $true};foreach($file in @(Get-ChildItem -LiteralPath $runtimeDir -File -Force -Recurse)){Set-E1FinalGuestRuntimeAcl $file.FullName $false;Assert-E1FinalGuestRuntimeAcl $file.FullName $false}
 foreach($name in @('launcher','wrapper','validation_helper')){$leaf=Split-Path -Leaf $scriptMap[$name];if((Get-FileHash (Join-Path $runtimeDir $leaf) -Algorithm SHA256).Hash.ToLowerInvariant()-cne $binding.script_sha256.$name){throw 'protected_guest_script_hash_mismatch'}};foreach($entry in @($snapshotManifest.node_files)){if((Get-FileHash (Join-Path $guestNodeRoot ([string]$entry.name).Replace('/','\')) -Algorithm SHA256).Hash.ToLowerInvariant()-cne[string]$entry.sha256){throw 'protected_guest_node_hash_mismatch'}}
 if((Get-FileHash (Join-Path $runtimeDir $supportName) -Algorithm SHA256).Hash.ToLowerInvariant()-cne$supportSha256){throw 'protected_guest_support_hash_mismatch'}
 if((Get-FileHash (Join-Path $runtimeDir 'node-runtime.manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()-cne$snapshotManifestSha256){throw 'protected_guest_node_manifest_hash_mismatch'}
 $guestControl=Join-Path $root 'kmp-eval\agentic-eval-codex-runtime\tools\agentic-eval\final-campaign-control.mjs'
 if(-not(Test-Path -LiteralPath $guestControl -PathType Leaf)-or(Get-FileHash $guestControl -Algorithm SHA256).Hash.ToLowerInvariant()-cne$binding.script_sha256.campaign_control){throw 'guest_campaign_control_hash_mismatch'}
 $startup=Join-Path $root 'Users\Evidence1E2E\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Evidence1FinalCodex.vbs'
 if(Test-Path $startup){throw 'existing_final_campaign_no_replacement'}
 $startupText="Set fso = CreateObject(`"Scripting.FileSystemObject`")`r`nself = WScript.ScriptFullName`r`nfso.DeleteFile self, True`r`nIf fso.FileExists(self) Then WScript.Quit 91`r`nCreateObject(`"WScript.Shell`").Run `"powershell.exe -WindowStyle Hidden -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\KmpEval\Evidence1FinalCodexRuntime\$runId\evidence1-final-codex-guest-wrapper.ps1 -RunId $runId -BindingPath C:\Evidence1Ops\final-codex\$runId\binding.json -BindingSha256 $BindingSha256 -AuthorizationClaimPath C:\Evidence1Ops\final-codex\$runId\authorization.claim.json -AuthorizationClaimSha256 $AuthorizationClaimSha256 -GlobalAuthorizationClaimPath C:\Evidence1Ops\final-codex\$runId\global.authorization.claim.json -GlobalAuthorizationClaimSha256 $GlobalAuthorizationClaimSha256 -RemoteAuthCanaryPath C:\Evidence1Ops\final-codex\$runId\remote-auth-canary.json -RemoteAuthCanarySha256 $RemoteAuthCanarySha256 -NodeRuntimeManifestPath C:\ProgramData\KmpEval\Evidence1FinalCodexRuntime\$runId\node-runtime.manifest.json -NodeRuntimeManifestSha256 $snapshotManifestSha256`", 0, False`r`n"
 $startupBytes=[Text.Encoding]::ASCII.GetBytes($startupText)
 $startupStream=[IO.File]::Open($startup,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);try{$startupStream.Write($startupBytes,0,$startupBytes.Length);$startupStream.Flush($true)}finally{$startupStream.Dispose()}
 $reportValue=[ordered]@{schema=1;kind='evidence1-final-codex-placement-report';verdict='PASS';campaign_id=$runId;vm_name=$vm.Name;vm_id=([string]$vm.Id).ToLowerInvariant();binding_sha256=$BindingSha256;authorization_claim_sha256=$AuthorizationClaimSha256;global_authorization_claim_sha256=$GlobalAuthorizationClaimSha256;remote_auth_blob_sha256=$RemoteAuthCanarySha256;node_runtime_manifest_sha256=$snapshotManifestSha256;script_sha256=$binding.script_sha256;startup_create_new=$true;window_style='hidden';retry_count=0;replacement_authorized=$false;respawn_authorized=$false}
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($reportValue|ConvertTo-Json)+"`n");$s=[IO.File]::Open($ReportPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);try{$s.Write($bytes,0,$bytes.Length);$s.Flush($true)}finally{$s.Dispose()}
}finally{
 if($mountAccessAdded-and$assignedAccessPath-and$diskObject-and$windowsPartition){
  Remove-PartitionAccessPath -DiskNumber $diskObject.Number -PartitionNumber $windowsPartition.PartitionNumber -AccessPath $assignedAccessPath -ErrorAction SilentlyContinue
 }
 if($mount){Dismount-VHD -Path $disk -ErrorAction SilentlyContinue}
}

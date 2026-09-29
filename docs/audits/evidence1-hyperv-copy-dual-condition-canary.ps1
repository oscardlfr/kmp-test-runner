#Requires -RunAsAdministrator
param(
  [Parameter(Mandatory)][string]$PairId,
  [Parameter(Mandatory)][string]$GroupRunId,
  [Parameter(Mandatory)][string]$ProfilePath,
  [Parameter(Mandatory)][string]$CreatedInspectionReceiptPath,
  [Parameter(Mandatory)][string]$GuestCredentialPath,
  [string]$HarnessDir = 'C:\kmp-eval\agentic-eval-codex-runtime',
  [string]$OutDir = '',
  [string]$ReportPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$CanonicalHarnessDir='C:\kmp-eval\agentic-eval-codex-runtime'
$ScratchRoot='C:\kmp-eval\scratch';$PublicTrustedRoot=Join-Path $ScratchRoot 'dual-condition-canary\copied'
$DiagnosticTrustedRoot=Join-Path $ScratchRoot 'dual-condition-canary\diagnostic';$ReportTrustedRoot=Join-Path $ScratchRoot 'dual-condition-canary\reports'
if(-not $OutDir){$OutDir=Join-Path $PublicTrustedRoot "$PairId\$GroupRunId"}
$DiagnosticOutDir=Join-Path $DiagnosticTrustedRoot "$PairId\$GroupRunId"
if(-not $ReportPath){$ReportPath=Join-Path $ReportTrustedRoot "$PairId\$GroupRunId\COPY.json"}
$deployedValidatorRoot=Join-Path $PSScriptRoot 'node-runtime'
$deployedMode=Test-Path -LiteralPath (Join-Path $deployedValidatorRoot 'package.json') -PathType Leaf
if($deployedMode){
  $moduleRoot=$PSScriptRoot
  $validatorRoot=$deployedValidatorRoot
}else{
  if([IO.Path]::GetFullPath($HarnessDir) -cne $CanonicalHarnessDir){throw 'dual_condition_harness_path'}
  $moduleRoot=Join-Path $HarnessDir 'docs\audits'
  $validatorRoot=$HarnessDir
}
Import-Module (Join-Path $moduleRoot 'evidence1-dual-condition-canary-contract.psm1') -Force
Import-Module (Join-Path $moduleRoot 'evidence1-vm-identity-contract.psm1') -Force -DisableNameChecking
$vmIdentity=Get-Evidence1CanonicalE2EVmIdentity -ProfilePath $ProfilePath -CreatedInspectionReceiptPath $CreatedInspectionReceiptPath -GuestCredentialPath $GuestCredentialPath
$VMName=$vmIdentity.vm_name;$ExpectedVMId=$vmIdentity.vm_id;$VMRoot=$vmIdentity.vm_root
function Assert-E1Inside([string]$Candidate,[string]$Root,[string]$Code){$c=[IO.Path]::GetFullPath($Candidate);$r=[IO.Path]::GetFullPath($Root).TrimEnd('\')+'\';if(-not $c.StartsWith($r,[StringComparison]::OrdinalIgnoreCase)){throw $Code}}
function Get-E1FileHash([string]$Path){$s=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{$h=[Security.Cryptography.SHA256]::Create();try{return -join($h.ComputeHash($s)|ForEach-Object{$_.ToString('x2')})}finally{$h.Dispose()}}finally{$s.Dispose()}}
Assert-E1Inside $OutDir 'C:\kmp-eval\scratch\dual-condition-canary\copied' 'dual_condition_copy_root'
Assert-E1Inside $DiagnosticOutDir 'C:\kmp-eval\scratch\dual-condition-canary\diagnostic' 'dual_condition_diagnostic_root'
Assert-E1Inside $ReportPath 'C:\kmp-eval\scratch\dual-condition-canary' 'dual_condition_report_root'
foreach($root in @($PublicTrustedRoot,$DiagnosticTrustedRoot,$ReportTrustedRoot)){
  $null=Assert-Evidence1DualConditionTrustedPath $root $ScratchRoot
  $null=New-Item -ItemType Directory -Path $root -Force
  $null=Assert-Evidence1DualConditionTrustedPath $root $root
}
$null=Assert-Evidence1DualConditionTrustedPath $OutDir $PublicTrustedRoot
$null=Assert-Evidence1DualConditionTrustedPath $DiagnosticOutDir $DiagnosticTrustedRoot
$null=Assert-Evidence1DualConditionTrustedPath $ReportPath $ReportTrustedRoot
$vm=Get-VM -Name $VMName -ErrorAction Stop
if([string]$vm.Id -cne $ExpectedVMId -or [string]$vm.State -cne 'Off'){throw 'dual_condition_copy_requires_off'}
$drive=Get-VMHardDiskDrive -VMName $VMName|Select-Object -First 1;if(-not $drive){throw 'dual_condition_vhd_missing'};Assert-E1Inside $drive.Path $VMRoot 'dual_condition_vhd_root'
$mount=$null;$priorValidatorRoot=$null;$validatorRootChanged=$false;$priorCanonicalLedgerRoot=$null;$canonicalLedgerRootChanged=$false
try{
  $mount=Mount-VHD -Path $drive.Path -ReadOnly -Passthru;$disk=$mount|Get-Disk
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
  if(Test-Path -LiteralPath $ReportPath -PathType Leaf){
    $existingReport=Get-Content -LiteralPath $ReportPath -Raw|ConvertFrom-Json -ErrorAction Stop
    if([string]$existingReport.state-cne'diagnostic_safety_incomplete'){throw 'dual_condition_copy_report_replay'}
    $privateRoot=Join-Path ([string]$windowsCandidates[0].access_path) "Evidence1Private\dual-condition-canary\$GroupRunId"
    $privateFiles=@(Get-ChildItem -LiteralPath $privateRoot -Recurse -File -Force -ErrorAction SilentlyContinue |
      ForEach-Object{$_.FullName.Substring($privateRoot.Length).TrimStart('\').Replace('\','/')} | Sort-Object)
    $controlRoot=Join-Path ([string]$windowsCandidates[0].access_path) "Evidence1Ops\dual-condition-control\$PairId\$GroupRunId"
    $terminalPath=Join-Path $controlRoot 'terminal.json'
    $statusPath=Join-Path $controlRoot 'status.json'
    $terminal=$(if(Test-Path -LiteralPath $terminalPath -PathType Leaf){Get-Content -LiteralPath $terminalPath -Raw|ConvertFrom-Json -ErrorAction SilentlyContinue}else{$null})
    $status=$(if(Test-Path -LiteralPath $statusPath -PathType Leaf){Get-Content -LiteralPath $statusPath -Raw|ConvertFrom-Json -ErrorAction SilentlyContinue}else{$null})
    $incidentFiles=@(Get-ChildItem -LiteralPath $privateRoot -Recurse -File -Filter '*.json' -Force -ErrorAction SilentlyContinue |
      Where-Object{$_.DirectoryName-like'*\agentic-eval-incident'})
    $incidentSummary=$null
    if($incidentFiles.Count-eq1){
      $incident=Get-Content -LiteralPath $incidentFiles[0].FullName -Raw|ConvertFrom-Json -ErrorAction SilentlyContinue
      if($incident-and$incident.PSObject.Properties['phase']-and$incident.PSObject.Properties['reason']-and$incident.PSObject.Properties['counts']){
        $incidentSummary=[ordered]@{phase=[string]$incident.phase;reason=[string]$incident.reason;
          planned=[int]$incident.counts.planned;spawn_started=[int]$incident.counts.spawn_started;
          spawn_completed=[int]$incident.counts.spawn_completed;spawn_failed=[int]$incident.counts.spawn_failed;
          raw_persisted=[int]$incident.counts.raw_persisted;evaluated=[int]$incident.counts.evaluated}
      }
    }
    # The top-level rejection record is the harness's committed/privacy-safe
    # diagnostic tier. Surface it on replay so a provider failure is actionable
    # without reading raw transcripts or stderr from the private raw tier.
    $rejectionFiles=@(Get-ChildItem -LiteralPath $privateRoot -Recurse -File -Filter '*.json' -Force -ErrorAction SilentlyContinue |
      Where-Object{$_.DirectoryName-like'*\agentic-eval-rejected'})
    $rejectionSummary=$null
    if($rejectionFiles.Count-eq1){
      $rejectionSummary=Get-Content -LiteralPath $rejectionFiles[0].FullName -Raw|ConvertFrom-Json -ErrorAction SilentlyContinue
    }
    $transcriptFiles=@(Get-ChildItem -LiteralPath $privateRoot -Recurse -File -Filter '*.jsonl' -Force -ErrorAction SilentlyContinue |
      Where-Object{$_.DirectoryName-like'*\agentic-eval-rejected\raw\transcripts\*'})
    $transcriptSummary=$null
    $rawContentRead=$false
    if($transcriptFiles.Count-eq1){
      $rawContentRead=$true
      $events=@(Get-Content -LiteralPath $transcriptFiles[0].FullName | ForEach-Object{
        try{$_|ConvertFrom-Json -ErrorAction Stop}catch{$null}
      }|Where-Object{$null-ne$_})
      $initEvents=@($events|Where-Object{[string]$_.type-ceq'system'-and[string]$_.subtype-ceq'init'})
      $resultEvents=@($events|Where-Object{[string]$_.type-ceq'result'})
      $initIndex=$null;$resultIndex=$null
      for($eventIndex=0;$eventIndex-lt$events.Count;$eventIndex++){
        $event=$events[$eventIndex]
        if($event.PSObject.Properties['type']-and[string]$event.type-ceq'result'){$resultIndex=$eventIndex}
        if($event.PSObject.Properties['type']-and[string]$event.type-ceq'system'-and
          $event.PSObject.Properties['subtype']-and[string]$event.subtype-ceq'init'){$initIndex=$eventIndex}
      }
      $toolUses=@();$toolResults=@()
      foreach($event in $events){
        if($event.PSObject.Properties['message']-and$event.message-and$event.message.PSObject.Properties['content']){
          foreach($item in @($event.message.content)){
            if([string]$item.type-ceq'tool_use'){$toolUses+=$item}
            elseif([string]$item.type-ceq'tool_result'){$toolResults+=$item}
          }
        }
      }
      $init=$(if($initEvents.Count-eq1){$initEvents[0]}else{$null})
      $firstEvent=$(if($events.Count-gt0){$events[0]}else{$null})
      $transcriptSummary=[ordered]@{
        line_count=$events.Count
        first_event_type=$(if($firstEvent-and$firstEvent.PSObject.Properties['type']){[string]$firstEvent.type}else{$null})
        first_event_subtype=$(if($firstEvent-and$firstEvent.PSObject.Properties['subtype']){[string]$firstEvent.subtype}else{$null})
        init_count=$initEvents.Count
        init_index=$initIndex
        result_count=$resultEvents.Count
        result_index=$resultIndex
        init_tools=$(if($init-and$init.PSObject.Properties['tools']){@($init.tools)}else{@()})
        init_permission_mode=$(if($init-and$init.PSObject.Properties['permissionMode']){[string]$init.permissionMode}else{$null})
        init_mcp_server_count=$(if($init-and$init.PSObject.Properties['mcp_servers']){@($init.mcp_servers).Count}else{$null})
        tool_use_count=$toolUses.Count
        tool_use_names=@($toolUses|ForEach-Object{[string]$_.name})
        tool_use_ids=@($toolUses|ForEach-Object{[string]$_.id})
        tool_result_count=$toolResults.Count
        tool_result_ids=@($toolResults|ForEach-Object{[string]$_.tool_use_id})
      }
    }
    Write-Output ('E1_COPY_REPLAY_DIAGNOSTIC:'+(ConvertTo-Json -InputObject ([ordered]@{schema=1;kind='dual-condition-copy-replay-diagnostic';
      pair_id=$PairId;group_run_id=$GroupRunId;private_files=$privateFiles;
      wrapper_terminal_state=$(if($terminal){[string]$terminal.state}else{$null});
      wrapper_exit_code=$(if($terminal){$terminal.exit_code}else{$null});
      wrapper_reason_code=$(if($terminal-and$terminal.PSObject.Properties['reason_code']){[string]$terminal.reason_code}else{$null});
      wrapper_status_state=$(if($status){[string]$status.state}else{$null});incident_summary=$incidentSummary;
      rejection_summary=$rejectionSummary;transcript_summary=$transcriptSummary;raw_content_read=$rawContentRead}) -Depth 20 -Compress))
    return
  }
  $source=Join-Path ([string]$windowsCandidates[0].access_path) "Evidence1Ops\dual-condition-ledger\operations\$PairId\$GroupRunId"
  $bindingPath=Join-Path $source 'binding.json';$custodyPath=Join-Path $source 'custody.json'
  $bindingHash=Get-E1FileHash $bindingPath
  $priorValidatorRoot=$env:E1_DUAL_VALIDATOR_ROOT;$env:E1_DUAL_VALIDATOR_ROOT=$validatorRoot;$validatorRootChanged=$true
  $priorCanonicalLedgerRoot=$env:E1_DUAL_CANONICAL_LEDGER_ROOT;$env:E1_DUAL_CANONICAL_LEDGER_ROOT='C:\Evidence1Ops\dual-condition-ledger';$canonicalLedgerRootChanged=$true
  try {
    $validated=Assert-Evidence1DualConditionCanaryOperation $source
  } catch {
    $operationFiles=@(Get-ChildItem -LiteralPath $source -Recurse -File -Force -ErrorAction SilentlyContinue |
      ForEach-Object{$_.FullName.Substring($source.Length).TrimStart('\').Replace('\','/')} | Sort-Object)
    $ledgerRoot=[IO.DirectoryInfo]::new($source).Parent.Parent.Parent.FullName
    $pairRoot=Join-Path (Join-Path $ledgerRoot 'pairs') $PairId
    $pairFiles=@(Get-ChildItem -LiteralPath $pairRoot -File -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name | Sort-Object)
    $controlRoot=Join-Path ([string]$windowsCandidates[0].access_path) "Evidence1Ops\dual-condition-control\$PairId\$GroupRunId"
    $terminalPath=Join-Path $controlRoot 'terminal.json'
    $statusPath=Join-Path $controlRoot 'status.json'
    $terminal=$(if(Test-Path -LiteralPath $terminalPath -PathType Leaf){Get-Content -LiteralPath $terminalPath -Raw|ConvertFrom-Json -ErrorAction SilentlyContinue}else{$null})
    $status=$(if(Test-Path -LiteralPath $statusPath -PathType Leaf){Get-Content -LiteralPath $statusPath -Raw|ConvertFrom-Json -ErrorAction SilentlyContinue}else{$null})
    $diagnostic=[ordered]@{schema=1;kind='dual-condition-copy-diagnostic';error_code=$_.Exception.Message;
      operation_files=$operationFiles;pair_files=$pairFiles;wrapper_terminal_state=$(if($terminal){[string]$terminal.state}else{$null});
      wrapper_exit_code=$(if($terminal){$terminal.exit_code}else{$null});wrapper_reason_code=$(if($terminal-and$terminal.PSObject.Properties['reason_code']){[string]$terminal.reason_code}else{$null});
      wrapper_status_state=$(if($status){[string]$status.state}else{$null})}
    Write-Output ('E1_COPY_DIAGNOSTIC:'+(ConvertTo-Json -InputObject $diagnostic -Depth 5 -Compress))
    throw
  }
  if(-not $validated.validated){throw 'dual_condition_official_validation_failed'}
  $binding=Get-Content -LiteralPath $bindingPath -Raw|ConvertFrom-Json -ErrorAction Stop
  $custody=Get-Content -LiteralPath $custodyPath -Raw|ConvertFrom-Json -ErrorAction Stop
  if($binding.pair_id -cne $PairId -or $binding.group_run_id -cne $GroupRunId -or
    $custody.state-cnotin@('closed_pass','closed_failed','closed_incomplete_safety_stop')-or
    $custody.benchmark_eligible -ne $false -or $custody.aggregated_across_runtimes -ne $false){throw 'dual_condition_custody_invalid'}
  $publishable=$custody.state-cin@('closed_pass','closed_failed')
  if($publishable){
    if($custody.complete-ne$true-or[int]$custody.sessions_consumed-ne2-or[int]$custody.records_validated-ne2-or[int]$custody.sidecars_validated-ne2){throw 'dual_condition_custody_invalid'}
    if($validated.privacy_validated-ne$true){throw 'dual_condition_privacy_validation_failed'}
  }elseif($custody.complete-ne$false-or[int]$custody.sessions_consumed-lt1-or[int]$custody.sessions_consumed-gt2){throw 'dual_condition_custody_invalid'}
  $actualFiles=@(Get-ChildItem -LiteralPath $source -Recurse -File|ForEach-Object{$_.FullName.Substring($source.Length).TrimStart('\').Replace('\','/')})
  $recordCount=0;$sidecarCount=0
  $journalHashes=@{}
  if($publishable){
    foreach($custodySlot in @($custody.slots)){
      if($custodySlot.record_status-cne'valid'-or$custodySlot.sidecar_status-cne'valid'){throw 'dual_condition_invalid_evidence_publication'}
      $ordinal=[int]$custodySlot.ordinal;$slot=Join-Path (Join-Path $source 'slots') ([string]$ordinal)
      $transactionPath=Join-Path $slot 'copy.transaction.json'
      if($null-eq$custodySlot.copy_transaction_sha256-or(Get-E1FileHash $transactionPath)-cne$custodySlot.copy_transaction_sha256){throw 'dual_condition_copy_transaction_hash'}
      $records=@(Get-ChildItem -LiteralPath $slot -File -Filter '*.json'|Where-Object Name -NotIn @('claim.json','plan.claim.json','dispatch.started.json','copy.transaction.json','copy.recovery.json','terminal.json'))
      $sidecars=@(Get-ChildItem -LiteralPath (Join-Path $slot 'audit') -File -Filter '*.json')
      if($records.Count-ne1-or$sidecars.Count-ne1-or$records[0].Name-cne$sidecars[0].Name){throw 'dual_condition_evidence_layout'}
      $record=Get-Content -LiteralPath $records[0].FullName -Raw|ConvertFrom-Json -ErrorAction Stop
      if($record.benchmark_eligible-ne$false-or$record.agent_runtime.runtime_id-cne$binding.slots[$ordinal].runtime_id){throw 'dual_condition_record_identity'}
      $recordCount++;$sidecarCount++
    }
    foreach($artifact in @($validated.publication_artifacts)){
      if($artifact.relative_path-isnot[string]-or$artifact.kind-cnotin@('record','sidecar')-or
        $artifact.sha256-isnot[string]-or$artifact.sha256-cnotmatch'^[a-f0-9]{64}$'-or$journalHashes.ContainsKey($artifact.relative_path)){
        throw 'dual_condition_publication_manifest'
      }
      $journalHashes[$artifact.relative_path]=$artifact.sha256
    }
    if($journalHashes.Count-ne4){throw 'dual_condition_publication_manifest'}
    if($recordCount-ne2-or$sidecarCount-ne2){throw 'dual_condition_invalid_evidence_publication'}
    $relative=@($actualFiles|Where-Object{$_-cnotmatch'^slots/[01]/copy\.(transaction|recovery)\.json$'})
    if(@($relative|Where-Object{$_-cmatch'^slots/[01]/copy\.(transaction|recovery)\.json$'}).Count-ne0){throw 'dual_condition_transaction_publication'}
    $destinationRoot=$OutDir;$destinationTier='public'
  }else{
    $relative=@($actualFiles|Where-Object{$_-cmatch'^(binding\.json|authorization\.claim\.json|group\.claim\.json|inter-slot\.integrity\.json|custody\.json|slots/[01]/(claim\.json|plan\.claim\.json|dispatch\.started\.json|terminal\.json))$'})
    if($relative.Count-eq0-or$relative.Count-ge$actualFiles.Count-and@($actualFiles|Where-Object{$_-cmatch'^slots/[01]/audit/'}).Count-gt0){throw 'dual_condition_diagnostic_filter'}
    $destinationRoot=$DiagnosticOutDir;$destinationTier='diagnostic'
  }
  $publicationArtifacts=@()
  foreach($name in $relative){
    if($name-match '(^|/)(raw|stderr|journal)(/|$)'){throw 'dual_condition_copy_raw_forbidden'}
    $sourcePath=Join-Path $source ($name-replace'/','\')
    $expectedHash=$(if($journalHashes.ContainsKey($name)){$journalHashes[$name]}else{Get-E1FileHash $sourcePath})
    $sourceItem=Get-Item -LiteralPath $sourcePath -Force
    $publicationArtifacts+=[ordered]@{relative_path=$name;sha256=$expectedHash;size_bytes=[int64]$sourceItem.Length}
  }
  $destinationTrustedRoot=$(if($publishable){$PublicTrustedRoot}else{$DiagnosticTrustedRoot})
  $publication=Publish-Evidence1DualConditionArtifactSet -SourceRoot $source -DestinationRoot $destinationRoot -TrustedRoot $destinationTrustedRoot -Tier $destinationTier -Artifacts $publicationArtifacts
  $copyState=$(if($custody.state-ceq'closed_pass'){'passed'}elseif($custody.state-ceq'closed_failed'){'failed'}else{'diagnostic_safety_incomplete'})
  $reportValue=[ordered]@{schema=1;state=$copyState;custody_state=$custody.state;destination_tier=$destinationTier;privacy_validated=[bool]$validated.privacy_validated;
    public_evidence_copied=[bool]$publishable;pair_id=$PairId;group_run_id=$GroupRunId;binding_sha256=$bindingHash;
    vm_name=$VMName;vm_id=$ExpectedVMId;files_copied=$relative.Count;records_copied=$recordCount;sidecars_copied=$sidecarCount;raw_content_read=$false;
    raw_artifacts_copied=$false;publication_state='committed';publication_manifest_sha256=$publication.manifest_sha256;
    publication_torn_json_recovery_supported=$true;
    aggregated_across_runtimes=$false;benchmark_eligible=$false;retry_count=0}
  $null=Write-Evidence1DualConditionAtomicJson -Path $ReportPath -Value $reportValue -TrustedRoot $ReportTrustedRoot
}finally{
  if($validatorRootChanged){if($null-eq$priorValidatorRoot){Remove-Item Env:E1_DUAL_VALIDATOR_ROOT -ErrorAction SilentlyContinue}else{$env:E1_DUAL_VALIDATOR_ROOT=$priorValidatorRoot}}
  if($canonicalLedgerRootChanged){if($null-eq$priorCanonicalLedgerRoot){Remove-Item Env:E1_DUAL_CANONICAL_LEDGER_ROOT -ErrorAction SilentlyContinue}else{$env:E1_DUAL_CANONICAL_LEDGER_ROOT=$priorCanonicalLedgerRoot}}
  if($mount){Dismount-VHD -Path $drive.Path -ErrorAction SilentlyContinue}
}

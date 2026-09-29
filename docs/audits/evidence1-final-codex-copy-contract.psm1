Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-E1CanonicalFullPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) { throw 'copy_path_not_absolute' }
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}
function Assert-E1PathUnder([string]$Path,[string]$Root,[string]$Code) {
    $full=Get-E1CanonicalFullPath $Path;$rootFull=Get-E1CanonicalFullPath $Root
    if(-not $full.StartsWith($rootFull+'\',[StringComparison]::OrdinalIgnoreCase)){throw $Code};return $full
}
function Assert-E1NoReparseAncestors([string]$Path) {
    $full=Get-E1CanonicalFullPath $Path;$cursor=$full
    while($cursor){if(Test-Path -LiteralPath $cursor){$item=Get-Item -LiteralPath $cursor -Force;if(($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'copy_reparse_path_rejected'}};$parent=Split-Path -Parent $cursor;if([string]::IsNullOrEmpty($parent)-or$parent-ceq$cursor){break};$cursor=$parent};return $full
}
function Assert-E1NoReparseTree([string]$Path) {
    $full=Assert-E1NoReparseAncestors $Path;if(-not(Test-Path -LiteralPath $full -PathType Container)){throw 'copy_source_directory_missing'}
    foreach($item in @(Get-ChildItem -LiteralPath $full -Force -Recurse)){if(($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'copy_reparse_tree_rejected'}};return $full
}
function Write-E1TxnJson([string]$Path,$Value){$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 20 -Compress)+"`n");$s=[IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough);try{$s.Write($bytes,0,$bytes.Length);$s.Flush($true)}finally{$s.Dispose()}}
function Read-E1TxnJson([string]$Path){if(-not(Test-Path -LiteralPath $Path -PathType Leaf)-or((Get-Item -LiteralPath $Path -Force).Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'copy_transaction_file_reparse_rejected'};$bytes=[IO.File]::ReadAllBytes($Path);$options=@{InputObject=[Text.UTF8Encoding]::new($false,$true).GetString($bytes);ErrorAction='Stop'};if((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')){$options.DateKind='String'};return ConvertFrom-Json @options}
function Get-E1TxnFileSha([string]$Path){$stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{$hash=[Security.Cryptography.SHA256]::Create();try{return([BitConverter]::ToString($hash.ComputeHash($stream))-replace'-','').ToLowerInvariant()}finally{$hash.Dispose()}}finally{$stream.Dispose()}}
function Get-E1TxnTextSha([string]$Text){$hash=[Security.Cryptography.SHA256]::Create();try{return([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))-replace'-','').ToLowerInvariant()}finally{$hash.Dispose()}}
function Get-E1TxnTreeSha([string]$Path){$full=Assert-E1NoReparseTree $Path;$rows=@();foreach($file in @(Get-ChildItem -LiteralPath $full -File -Force -Recurse|Where-Object{$_.Name-cne'.evidence1-copy-transaction.json'}|Sort-Object FullName)){$relative=$file.FullName.Substring($full.Length).TrimStart('\').Replace('\','/');$rows+=$relative+"`0"+(Get-E1TxnFileSha $file.FullName)};$hash=[Security.Cryptography.SHA256]::Create();try{return([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]::Join("`n",$rows))))-replace'-','').ToLowerInvariant()}finally{$hash.Dispose()}}
function Test-E1TxnOwned([string]$Path,[string]$TransactionId){if(-not(Test-Path -LiteralPath $Path -PathType Container)){return $false};$marker=Join-Path $Path '.evidence1-copy-transaction.json';if(-not(Test-Path -LiteralPath $marker -PathType Leaf)){return $false};try{return (Read-E1TxnJson $marker).transaction_id-ceq$TransactionId}catch{return $false}}
function Write-E1TxnState([string]$JournalPath,[string]$State,$Prepared){Write-E1TxnJson ($JournalPath+".$State.json") ([ordered]@{schema=1;kind='evidence1-final-codex-copy-transaction-state';transaction_id=$Prepared.transaction_id;state=$State;at_utc=[datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')})}
function Test-E1ExactKeys($Value,[string[]]$Keys){return $null-ne$Value-and@(Compare-Object @($Value.PSObject.Properties.Name|Sort-Object) @($Keys|Sort-Object)).Count-eq 0}
function Read-E1TxnState([string]$JournalPath,[string]$State,[string]$TransactionId){$path=$JournalPath+".$State.json";if(-not(Test-Path -LiteralPath $path -PathType Leaf)){return $null};try{$value=Read-E1TxnJson $path}catch{throw 'copy_transaction_state_invalid'};$keys=@('schema','kind','transaction_id','state','at_utc');$time=[datetime]::MinValue;if(-not(Test-E1ExactKeys $value $keys)-or$value.schema-ne 1-or$value.kind-cne'evidence1-final-codex-copy-transaction-state'-or$value.transaction_id-cne$TransactionId-or$value.state-cne$State-or-not[datetime]::TryParse([string]$value.at_utc,[ref]$time)){throw 'copy_transaction_state_invalid'};return $value}

function Assert-E1CopyRecoveryReservation {
 [CmdletBinding()]param([Parameter(Mandatory)][string]$ReportPath,[Parameter(Mandatory)][string]$ExpectedSha256,[Parameter(Mandatory)][string]$CampaignId,[Parameter(Mandatory)][string]$PrivateDestination,[Parameter(Mandatory)][string]$PublicDestination,[Parameter(Mandatory)][string]$JournalPath,[Parameter(Mandatory)][string]$CompletionReportPath,[Parameter(Mandatory)][string]$ExpectedHarnessCommit,[Parameter(Mandatory)][string]$ExpectedHarnessTree,[Parameter(Mandatory)][string]$ExpectedBindingSha256)
 if($ExpectedSha256-cnotmatch'^[0-9a-f]{64}$'-or-not(Test-Path -LiteralPath $ReportPath -PathType Leaf)-or(Get-E1TxnFileSha $ReportPath)-cne$ExpectedSha256){throw 'copy_recovery_reservation_hash_mismatch'}
 if(((Get-Item -LiteralPath $ReportPath -Force).Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'copy_recovery_reservation_invalid'}
 try{$value=Read-E1TxnJson $ReportPath}catch{throw 'copy_recovery_reservation_invalid'}
 $keys=@('schema','kind','campaign_id','harness_commit','harness_tree','binding_sha256','private_destination_sha256','public_destination_sha256','journal_path_sha256','completion_report_path_sha256','retry_count','replacement_authorized','respawn_authorized','reserved_at_utc');$time=[datetime]::MinValue
 if(-not(Test-E1ExactKeys $value $keys)-or$value.schema-ne 1-or$value.kind-cne'evidence1-final-codex-copy-reservation'-or$value.campaign_id-cne$CampaignId-or
    $ExpectedHarnessCommit-cnotmatch'^[0-9a-f]{40}$'-or$ExpectedHarnessTree-cnotmatch'^[0-9a-f]{40}$'-or$ExpectedBindingSha256-cnotmatch'^[0-9a-f]{64}$'-or$value.harness_commit-cne$ExpectedHarnessCommit-or$value.harness_tree-cne$ExpectedHarnessTree-or$value.binding_sha256-cne$ExpectedBindingSha256-or
    $value.private_destination_sha256-cne(Get-E1TxnTextSha (Get-E1CanonicalFullPath $PrivateDestination))-or$value.public_destination_sha256-cne(Get-E1TxnTextSha (Get-E1CanonicalFullPath $PublicDestination))-or
    $value.journal_path_sha256-cne(Get-E1TxnTextSha (Get-E1CanonicalFullPath $JournalPath))-or$value.completion_report_path_sha256-cne(Get-E1TxnTextSha (Get-E1CanonicalFullPath $CompletionReportPath))-or
    [int]$value.retry_count-ne 0-or$value.replacement_authorized-ne$false-or$value.respawn_authorized-ne$false-or-not[datetime]::TryParse([string]$value.reserved_at_utc,[ref]$time)){throw 'copy_recovery_reservation_invalid'}
 return $value
}

function Assert-E1CopyCompletionReport {
 [CmdletBinding()]param([Parameter(Mandatory)][string]$CompletionReportPath,[Parameter(Mandatory)][string]$CampaignId,[Parameter(Mandatory)][string]$ReservationSha256,[Parameter(Mandatory)][string]$JournalCompleteSha256,[Parameter(Mandatory)][string]$ExpectedBindingSha256)
 if(-not(Test-Path -LiteralPath $CompletionReportPath -PathType Leaf)-or((Get-Item -LiteralPath $CompletionReportPath -Force).Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'copy_completion_report_invalid'}
 try{$value=Read-E1TxnJson $CompletionReportPath}catch{throw 'copy_completion_report_invalid'}
 $keys=@('schema','kind','verdict','campaign_id','binding_sha256','reservation_sha256','journal_complete_sha256','recovered','private_custody_outside_repo','public_destination_inside_repo','create_new_rename','public_files','raw_published','sidecars_published')
 if(-not(Test-E1ExactKeys $value $keys)-or$value.schema-ne 1-or$value.kind-cne'evidence1-final-codex-copy-terminal'-or$value.verdict-cne'PASS'-or$value.campaign_id-cne$CampaignId-or$ExpectedBindingSha256-cnotmatch'^[0-9a-f]{64}$'-or$value.binding_sha256-cne$ExpectedBindingSha256-or$value.reservation_sha256-cne$ReservationSha256-or$value.journal_complete_sha256-cne$JournalCompleteSha256-or
    $value.recovered-isnot[bool]-or$value.private_custody_outside_repo-ne$true-or$value.public_destination_inside_repo-ne$true-or$value.create_new_rename-ne$true-or[int]$value.public_files-ne 8-or$value.raw_published-ne$false-or$value.sidecars_published-ne$false){throw 'copy_completion_report_invalid'}
 return $value
}

function Assert-E1GuestTerminalChain {
 [CmdletBinding()]param([Parameter(Mandatory)]$Terminal,[Parameter(Mandatory)]$TerminalClaim,[Parameter(Mandatory)]$CampaignCustody,[Parameter(Mandatory)][string]$CampaignId,[Parameter(Mandatory)][string]$TerminalClaimSha256,[Parameter(Mandatory)][string]$CampaignCustodySha256,[Parameter(Mandatory)][string]$PublicationManifestSha256,[Parameter(Mandatory)][string]$ExpectedBindingSha256)
 $claimKeys=@('schema','kind','run_id','binding_sha256','authorization_claim_sha256','global_authorization_claim_sha256','remote_auth_canary_sha256','state','retry_count','replacement_or_respawn_authorized','claimed_at_utc')
 $terminalKeys=@('schema','run_id','terminal_claim_sha256','state','exit_code','reason_code','retry_count','replacement_or_respawn_used','process_tree_cleanup','publication_manifest_sha256','campaign_custody_sha256')
 $custodyKeys=@('schema','kind','identity','binding_sha256','authorization_claim_sha256','global_authorization_claim_sha256','remote_auth_sha256','group_claim_sha256','slot_and_plan_claims','artifacts','exact_session_count_evidence','retry_count','replacement_or_respawn_used','benchmark_eligible')
 $identityKeys=@('schema','campaign_id','campaign_design_id','sessions_executed','retry_count','slot_order')
 $claimArtifactKeys=@('order_index','name','sha256');$artifactKeys=@('order_index','record_path','record_sha256','sidecar_path','sidecar_sha256')
 $claimTime=[datetime]::MinValue
 if($TerminalClaimSha256-cnotmatch'^[0-9a-f]{64}$'-or$CampaignCustodySha256-cnotmatch'^[0-9a-f]{64}$'-or$PublicationManifestSha256-cnotmatch'^[0-9a-f]{64}$'-or$ExpectedBindingSha256-cnotmatch'^[0-9a-f]{64}$'-or
    -not(Test-E1ExactKeys $TerminalClaim $claimKeys)-or$TerminalClaim.schema-ne 1-or$TerminalClaim.kind-cne'evidence1-final-codex-terminal-claim'-or$TerminalClaim.run_id-cne$CampaignId-or
    $TerminalClaim.binding_sha256-cnotmatch'^[0-9a-f]{64}$'-or$TerminalClaim.authorization_claim_sha256-cnotmatch'^[0-9a-f]{64}$'-or$TerminalClaim.global_authorization_claim_sha256-cnotmatch'^[0-9a-f]{64}$'-or$TerminalClaim.remote_auth_canary_sha256-cnotmatch'^[0-9a-f]{64}$'-or
    $TerminalClaim.state-cne'claimed-before-provider-spawn'-or[int]$TerminalClaim.retry_count-ne 0-or$TerminalClaim.replacement_or_respawn_authorized-ne$false-or-not[datetime]::TryParse([string]$TerminalClaim.claimed_at_utc,[ref]$claimTime)){throw 'campaign_terminal_claim_invalid'}
 if(-not(Test-E1ExactKeys $Terminal $terminalKeys)-or$Terminal.schema-ne 1-or$Terminal.run_id-cne$CampaignId-or$Terminal.terminal_claim_sha256-cne$TerminalClaimSha256-or$Terminal.state-cne'complete'-or[int]$Terminal.exit_code-ne 0-or$Terminal.reason_code-cne'complete'-or
    [int]$Terminal.retry_count-ne 0-or$Terminal.replacement_or_respawn_used-ne$false-or$Terminal.process_tree_cleanup-cne'job-object-kill-on-close'-or$Terminal.publication_manifest_sha256-cne$PublicationManifestSha256-or$Terminal.campaign_custody_sha256-cne$CampaignCustodySha256){throw 'campaign_terminal_invalid'}
 $slotOrder=@($CampaignCustody.identity.slot_order)
 if(-not(Test-E1ExactKeys $CampaignCustody $custodyKeys)-or$CampaignCustody.schema-isnot[int]-or$CampaignCustody.schema-ne 1-or$CampaignCustody.kind-cne'evidence1-final-codex-campaign-custody'-or
    -not(Test-E1ExactKeys $CampaignCustody.identity $identityKeys)-or$CampaignCustody.identity.schema-ne 1-or$CampaignCustody.identity.campaign_id-cne$CampaignId-or$CampaignCustody.identity.campaign_design_id-cne'codex-product-vs-free-baseline-v1'-or
    $CampaignCustody.identity.schema-isnot[int]-or$CampaignCustody.identity.sessions_executed-isnot[int]-or$CampaignCustody.identity.sessions_executed-ne 6-or$CampaignCustody.identity.retry_count-isnot[int]-or$CampaignCustody.identity.retry_count-ne 0-or$slotOrder.Count-ne 6-or([string]::Join(',',$slotOrder))-cne'A,B,B,A,A,B'-or
    $CampaignCustody.group_claim_sha256-cnotmatch'^[0-9a-f]{64}$'-or$CampaignCustody.exact_session_count_evidence-cne'six durable pre-spawn slot claims and six unique accepted records'-or
    $CampaignCustody.retry_count-isnot[int]-or$CampaignCustody.retry_count-ne 0-or$CampaignCustody.replacement_or_respawn_used-ne$false-or$CampaignCustody.benchmark_eligible-ne$false){throw 'campaign_custody_invalid'}
 $slotClaims=@($CampaignCustody.slot_and_plan_claims);if($slotClaims.Count-ne 12){throw 'campaign_custody_slot_claims_invalid'}
 $slotHashes=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
 for($i=0;$i-lt 6;$i++){foreach($offset in 0..1){$name=@('slot.claim.json','plan.claim.json')[$offset];$entry=$slotClaims[($i*2)+$offset];if(-not(Test-E1ExactKeys $entry $claimArtifactKeys)-or$entry.order_index-isnot[int]-or$entry.order_index-ne$i-or$entry.name-cne$name-or$entry.sha256-cnotmatch'^[0-9a-f]{64}$'-or-not$slotHashes.Add([string]$entry.sha256)){throw 'campaign_custody_slot_claims_invalid'}}}
 $artifacts=@($CampaignCustody.artifacts);if($artifacts.Count-ne 6){throw 'campaign_custody_artifacts_invalid'}
 $recordPaths=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);$sidecarPaths=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 for($i=0;$i-lt 6;$i++){$entry=$artifacts[$i];if(-not(Test-E1ExactKeys $entry $artifactKeys)-or$entry.order_index-isnot[int]-or$entry.order_index-ne$i-or$entry.record_sha256-cnotmatch'^[0-9a-f]{64}$'-or$entry.sidecar_sha256-cnotmatch'^[0-9a-f]{64}$'){throw 'campaign_custody_artifacts_invalid'};foreach($name in @('record_path','sidecar_path')){$path=[string]$entry.$name;if([string]::IsNullOrWhiteSpace($path)-or-not[IO.Path]::IsPathRooted($path)-or-not([IO.Path]::GetFullPath($path).Equals($path,[StringComparison]::OrdinalIgnoreCase))){throw 'campaign_custody_artifacts_invalid'}};if(-not$recordPaths.Add([string]$entry.record_path)-or-not$sidecarPaths.Add([string]$entry.sidecar_path)-or$recordPaths.Contains([string]$entry.sidecar_path)-or$sidecarPaths.Contains([string]$entry.record_path)){throw 'campaign_custody_artifacts_invalid'}}
 if($TerminalClaim.binding_sha256-cne$ExpectedBindingSha256-or$CampaignCustody.binding_sha256-cne$ExpectedBindingSha256-or
    $TerminalClaim.authorization_claim_sha256-cne$CampaignCustody.authorization_claim_sha256-or$TerminalClaim.global_authorization_claim_sha256-cne$CampaignCustody.global_authorization_claim_sha256-or$TerminalClaim.remote_auth_canary_sha256-cne$CampaignCustody.remote_auth_sha256){throw 'campaign_terminal_claim_cross_binding'}
 return $true
}

function Assert-E1GuestClaimTree {
 [CmdletBinding()]param([Parameter(Mandatory)][string]$GuestRunDir,[Parameter(Mandatory)]$CampaignCustody)
 $runDir=Assert-E1NoReparseTree $GuestRunDir
 $groupPath=Join-Path $runDir 'group.claim.json'
 if(-not(Test-Path -LiteralPath $groupPath -PathType Leaf)-or((Get-Item -LiteralPath $groupPath -Force).Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0-or(Get-E1TxnFileSha $groupPath)-cne$CampaignCustody.group_claim_sha256){throw 'campaign_custody_group_claim_hash_mismatch'}
 foreach($claimEntry in @($CampaignCustody.slot_and_plan_claims)){$claimPath=Join-Path $runDir ("slots\"+[int]$claimEntry.order_index+'\'+[string]$claimEntry.name);if(-not(Test-Path -LiteralPath $claimPath -PathType Leaf)-or((Get-Item -LiteralPath $claimPath -Force).Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0-or(Get-E1TxnFileSha $claimPath)-cne$claimEntry.sha256){throw 'campaign_custody_slot_claim_hash_mismatch'}}
 return [ordered]@{run_dir=$runDir;group_claim=$groupPath}
}

function Get-E1TwoDirectoryRecoveryScope {
 [CmdletBinding()]param([Parameter(Mandatory)][string]$JournalPath,[Parameter(Mandatory)][string]$ExpectedPrivateDestination,[Parameter(Mandatory)][string]$ExpectedPublicDestination)
 $journal=Get-E1CanonicalFullPath $JournalPath;$preparedPath=$journal+'.prepared.json'
 if(-not(Test-Path -LiteralPath $preparedPath -PathType Leaf)){throw 'copy_transaction_journal_missing'}
 $p=Read-E1TxnJson $preparedPath
 $keys=@('schema','kind','transaction_id','private_stage','private_destination','private_tree_sha256','public_stage','public_destination','public_tree_sha256','prepared_at_utc')
 $preparedAt=[datetime]::MinValue
 if(@(Compare-Object @($p.PSObject.Properties.Name|Sort-Object) @($keys|Sort-Object)).Count-ne 0-or$p.schema-ne 1-or$p.kind-cne'evidence1-final-codex-copy-transaction'-or
    [string]$p.transaction_id-cnotmatch'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'-or[string]$p.private_tree_sha256-cnotmatch'^[0-9a-f]{64}$'-or[string]$p.public_tree_sha256-cnotmatch'^[0-9a-f]{64}$'-or-not[datetime]::TryParse([string]$p.prepared_at_utc,[ref]$preparedAt)){throw 'copy_transaction_journal_invalid'}
 foreach($name in @('private_stage','private_destination','public_stage','public_destination')){$p.$name=Get-E1CanonicalFullPath $p.$name;Assert-E1NoReparseAncestors (Split-Path -Parent $p.$name)|Out-Null}
 $expectedPrivate=Get-E1CanonicalFullPath $ExpectedPrivateDestination;$expectedPublic=Get-E1CanonicalFullPath $ExpectedPublicDestination
 if(-not $p.private_destination.Equals($expectedPrivate,[StringComparison]::OrdinalIgnoreCase)-or-not $p.public_destination.Equals($expectedPublic,[StringComparison]::OrdinalIgnoreCase)-or
    $p.private_stage-cnotmatch('^'+[regex]::Escape($expectedPrivate)+'\.staging-[0-9a-f]{32}$')-or$p.public_stage-cnotmatch('^'+[regex]::Escape($expectedPublic)+'\.staging-[0-9a-f]{32}$')){throw 'copy_transaction_journal_scope_invalid'}
 return $p
}

function Invoke-E1TwoDirectoryRecovery {
 [CmdletBinding()]param([Parameter(Mandatory)][string]$JournalPath,[Parameter(Mandatory)][string]$ExpectedPrivateDestination,[Parameter(Mandatory)][string]$ExpectedPublicDestination,[string]$TestPauseAfterPublicRenamePath='')
 $journal=Get-E1CanonicalFullPath $JournalPath;$p=Get-E1TwoDirectoryRecoveryScope -JournalPath $journal -ExpectedPrivateDestination $ExpectedPrivateDestination -ExpectedPublicDestination $ExpectedPublicDestination
 if($null-ne(Read-E1TxnState $journal 'rolled-back' $p.transaction_id)){throw 'copy_transaction_already_rolled_back'}
 $null=Read-E1TxnState $journal 'private-renamed' $p.transaction_id;$null=Read-E1TxnState $journal 'public-renamed' $p.transaction_id
 if($null-ne(Read-E1TxnState $journal 'complete' $p.transaction_id)){
   if(-not(Test-Path -LiteralPath $p.private_destination -PathType Container)-or-not(Test-Path -LiteralPath $p.public_destination -PathType Container)-or
      (Get-E1TxnTreeSha $p.private_destination)-cne$p.private_tree_sha256-or(Get-E1TxnTreeSha $p.public_destination)-cne$p.public_tree_sha256){throw 'copy_completed_destination_changed'}
   return [ordered]@{private=$p.private_destination;public=$p.public_destination;recovered=$true;state='complete'}
 }
 try {
   $privateAtDestination=Test-Path -LiteralPath $p.private_destination -PathType Container
   $publicAtDestination=Test-Path -LiteralPath $p.public_destination -PathType Container
   if($privateAtDestination-and-not(Test-E1TxnOwned $p.private_destination $p.transaction_id)-and((Get-E1TxnTreeSha $p.private_destination)-cne$p.private_tree_sha256)){throw 'copy_destination_not_owned'}
   if($publicAtDestination-and-not(Test-E1TxnOwned $p.public_destination $p.transaction_id)-and((Get-E1TxnTreeSha $p.public_destination)-cne$p.public_tree_sha256)){throw 'copy_destination_not_owned'}
   if(-not $privateAtDestination){if(-not(Test-E1TxnOwned $p.private_stage $p.transaction_id)-or(Get-E1TxnTreeSha $p.private_stage)-cne$p.private_tree_sha256){throw 'copy_private_stage_not_owned'};[IO.Directory]::Move($p.private_stage,$p.private_destination);$privateAtDestination=$true}
   if(-not(Test-Path -LiteralPath ($journal+'.private-renamed.json'))){Write-E1TxnState $journal 'private-renamed' $p}
   if(-not $publicAtDestination){if(-not(Test-E1TxnOwned $p.public_stage $p.transaction_id)-or(Get-E1TxnTreeSha $p.public_stage)-cne$p.public_tree_sha256){throw 'copy_public_stage_not_owned'};[IO.Directory]::Move($p.public_stage,$p.public_destination);$publicAtDestination=$true}
   if(-not(Test-Path -LiteralPath ($journal+'.public-renamed.json'))){Write-E1TxnState $journal 'public-renamed' $p}
   if($TestPauseAfterPublicRenamePath){Write-E1TxnJson $TestPauseAfterPublicRenamePath ([ordered]@{state='paused'});while($true){Start-Sleep -Seconds 1}}
   foreach($path in @($p.private_destination,$p.public_destination)){$marker=Join-Path $path '.evidence1-copy-transaction.json';if(Test-Path -LiteralPath $marker){Remove-Item -LiteralPath $marker -Force}}
   if((Get-E1TxnTreeSha $p.private_destination)-cne$p.private_tree_sha256-or(Get-E1TxnTreeSha $p.public_destination)-cne$p.public_tree_sha256){throw 'copy_destination_hash_changed'}
   Write-E1TxnState $journal 'complete' $p
   return [ordered]@{private=$p.private_destination;public=$p.public_destination;create_new_rename=$true;recovered=$true;state='complete'}
 } catch {
   $original=$_
   foreach($path in @($p.public_destination,$p.public_stage,$p.private_destination,$p.private_stage)){if(Test-E1TxnOwned $path $p.transaction_id){Remove-Item -LiteralPath $path -Recurse -Force}}
   if(-not(Test-Path -LiteralPath ($journal+'.rolled-back.json'))){Write-E1TxnState $journal 'rolled-back' $p}
   throw $original
 }
}

function Complete-E1TwoDirectoryTransaction {
 [CmdletBinding()]param(
  [Parameter(Mandatory)][string]$PrivateStage,[Parameter(Mandatory)][string]$PrivateDestination,
  [Parameter(Mandatory)][string]$PublicStage,[Parameter(Mandatory)][string]$PublicDestination,
  [Parameter(Mandatory)][string]$JournalPath,[string]$TestPauseAfterPrivateRenamePath='',[string]$TestPauseAfterPublicRenamePath=''
 )
 $privateStageFull=Get-E1CanonicalFullPath $PrivateStage;$privateFull=Get-E1CanonicalFullPath $PrivateDestination
 $publicStageFull=Get-E1CanonicalFullPath $PublicStage;$publicFull=Get-E1CanonicalFullPath $PublicDestination;$journal=Get-E1CanonicalFullPath $JournalPath
 foreach($path in @($privateStageFull,$publicStageFull)){Assert-E1NoReparseTree $path|Out-Null}
 foreach($path in @($privateFull,$publicFull)){Assert-E1NoReparseAncestors (Split-Path -Parent $path)|Out-Null;if(Test-Path -LiteralPath $path){throw 'copy_destination_must_be_create_new'}}
 if(Test-Path -LiteralPath ($journal+'.prepared.json')){throw 'copy_transaction_journal_already_exists'}
 $privateTreeSha=Get-E1TxnTreeSha $privateStageFull;$publicTreeSha=Get-E1TxnTreeSha $publicStageFull
 $transactionId=[guid]::NewGuid().ToString('D');$marker=[ordered]@{schema=1;transaction_id=$transactionId}
 foreach($path in @($privateStageFull,$publicStageFull)){Write-E1TxnJson (Join-Path $path '.evidence1-copy-transaction.json') $marker}
 $prepared=[ordered]@{schema=1;kind='evidence1-final-codex-copy-transaction';transaction_id=$transactionId;private_stage=$privateStageFull;private_destination=$privateFull;private_tree_sha256=$privateTreeSha;public_stage=$publicStageFull;public_destination=$publicFull;public_tree_sha256=$publicTreeSha;prepared_at_utc=[datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
 Write-E1TxnJson ($journal+'.prepared.json') $prepared
 [IO.Directory]::Move($privateStageFull,$privateFull)
 Write-E1TxnState $journal 'private-renamed' $prepared
 if($TestPauseAfterPrivateRenamePath){Write-E1TxnJson $TestPauseAfterPrivateRenamePath ([ordered]@{state='paused'});while($true){Start-Sleep -Seconds 1}}
 return Invoke-E1TwoDirectoryRecovery -JournalPath $journal -ExpectedPrivateDestination $privateFull -ExpectedPublicDestination $publicFull -TestPauseAfterPublicRenamePath $TestPauseAfterPublicRenamePath
}

Export-ModuleMember -Function @('Get-E1CanonicalFullPath','Assert-E1PathUnder','Assert-E1NoReparseAncestors','Assert-E1NoReparseTree','Complete-E1TwoDirectoryTransaction','Invoke-E1TwoDirectoryRecovery','Get-E1TwoDirectoryRecoveryScope','Assert-E1CopyRecoveryReservation','Assert-E1CopyCompletionReport','Assert-E1GuestTerminalChain','Assert-E1GuestClaimTree')

#Requires -RunAsAdministrator
param(
    [Parameter(Mandatory)][string]$CampaignId,
    [Parameter(Mandatory)][string]$PrivateOutDir,
    [Parameter(Mandatory)][string]$PublicOutDir,
    [Parameter(Mandatory)][string]$ReportPath,
    [Parameter(Mandatory)][string]$CompletionReportPath,
    [Parameter(Mandatory)][string]$JournalPath,
    [Parameter(Mandatory)][string]$HarnessCommit,
    [Parameter(Mandatory)][string]$HarnessTree,
    [string]$BindingPath = '',
    [Parameter(Mandatory)][string]$BindingSha256,
    [Parameter(Mandatory)][string]$CanonicalRepositoryRoot,
    [string]$PrivatePatternsFile = '',
    [string]$RecoveryReservationSha256 = '',
    [switch]$RecoveryOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-copy-contract.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking

if ($CampaignId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'campaign_id_invalid' }
if ($BindingSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'binding_sha256_invalid' }
$repositoryRoot = 'C:\kmp-eval\agentic-eval-codex-runtime'
$privateRoot = 'C:\kmp-eval\scratch\evidence1-final-codex-private'
$publicRoot = 'C:\kmp-eval\agentic-eval-codex-runtime\tools\runs'
$reportRoot = 'C:\kmp-eval\scratch\evidence1-final-codex-copy-reports'
$journalRoot = 'C:\kmp-eval\scratch\evidence1-final-codex-copy-journals'
$privateFull = Get-E1CanonicalFullPath $PrivateOutDir
$publicFull = Get-E1CanonicalFullPath $PublicOutDir
if (-not $privateFull.Equals((Get-E1CanonicalFullPath (Join-Path $privateRoot $CampaignId)), [StringComparison]::OrdinalIgnoreCase)) { throw 'private_destination_not_canonical_outside_repo' }
if (-not $publicFull.Equals((Get-E1CanonicalFullPath (Join-Path $publicRoot "evidence1-codex-pilot-$CampaignId")), [StringComparison]::OrdinalIgnoreCase)) { throw 'public_destination_not_canonical_inside_repo' }
if (-not ([IO.Path]::GetFullPath($ReportPath)).Equals((Join-Path $reportRoot "$CampaignId.reserved.json"), [StringComparison]::OrdinalIgnoreCase) -or
    -not ([IO.Path]::GetFullPath($CompletionReportPath)).Equals((Join-Path $reportRoot "$CampaignId.terminal.json"), [StringComparison]::OrdinalIgnoreCase) -or
    -not ([IO.Path]::GetFullPath($JournalPath)).Equals((Join-Path $journalRoot $CampaignId), [StringComparison]::OrdinalIgnoreCase)) { throw 'final_report_path_not_canonical_scratch' }
$null = Assert-E1PathUnder $privateFull $privateRoot 'private_destination_not_canonical_outside_repo'
$null = Assert-E1PathUnder $publicFull $publicRoot 'public_destination_not_canonical_inside_repo'
if ($privateFull.StartsWith($repositoryRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'private_destination_inside_repo' }
if ($privateFull.StartsWith($publicFull + '\', [StringComparison]::OrdinalIgnoreCase) -or $publicFull.StartsWith($privateFull + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'copy_destinations_overlap' }
foreach ($path in @($privateRoot, $publicRoot, $reportRoot, $journalRoot)) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw 'copy_destination_parent_missing' }
    Assert-E1NoReparseAncestors $path | Out-Null
}
function Get-Sha([string]$Path) {
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{$hasher=[Security.Cryptography.SHA256]::Create();try{return([BitConverter]::ToString($hasher.ComputeHash($stream))-replace'-','').ToLowerInvariant()}finally{$hasher.Dispose()}}finally{$stream.Dispose()}
}
function Read-Json([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'copy_json_file_reparse_rejected' }
    $bytes = [IO.File]::ReadAllBytes($Path)
    return [Text.UTF8Encoding]::new($false, $true).GetString($bytes) | ConvertFrom-Json -ErrorAction Stop
}
if ($RecoveryOnly) {
    $reservation=Assert-E1CopyRecoveryReservation -ReportPath $ReportPath -ExpectedSha256 $RecoveryReservationSha256 -CampaignId $CampaignId -PrivateDestination $privateFull -PublicDestination $publicFull -JournalPath $JournalPath -CompletionReportPath $CompletionReportPath -ExpectedHarnessCommit $HarnessCommit -ExpectedHarnessTree $HarnessTree -ExpectedBindingSha256 $BindingSha256
    $recoveryScope=Get-E1TwoDirectoryRecoveryScope -JournalPath $JournalPath -ExpectedPrivateDestination $privateFull -ExpectedPublicDestination $publicFull
    $repositoryRoot=Assert-E1FinalCanonicalRepository $CanonicalRepositoryRoot $HarnessCommit $HarnessTree -AllowedDirtyPaths @($recoveryScope.public_stage,$recoveryScope.public_destination)
    $result=Invoke-E1TwoDirectoryRecovery -JournalPath $JournalPath -ExpectedPrivateDestination $privateFull -ExpectedPublicDestination $publicFull
    $completeJournalPath=$JournalPath+'.complete.json';$completeJournalSha=Get-Sha $completeJournalPath
    if(Test-Path -LiteralPath $CompletionReportPath){$null=Assert-E1CopyCompletionReport -CompletionReportPath $CompletionReportPath -CampaignId $CampaignId -ReservationSha256 $RecoveryReservationSha256 -JournalCompleteSha256 $completeJournalSha -ExpectedBindingSha256 $BindingSha256}
    else{Write-E1FinalCreateNewJson $CompletionReportPath ([ordered]@{schema=1;kind='evidence1-final-codex-copy-terminal';verdict='PASS';campaign_id=$CampaignId;binding_sha256=$BindingSha256;reservation_sha256=$RecoveryReservationSha256;journal_complete_sha256=$completeJournalSha;recovered=$true;private_custody_outside_repo=$true;public_destination_inside_repo=$true;create_new_rename=$true;public_files=8;raw_published=$false;sidecars_published=$false})}
    $result; return
}
if (-not (Test-Path -LiteralPath $BindingPath -PathType Leaf) -or (Get-Sha $BindingPath) -cne $BindingSha256) { throw 'copy_binding_hash_mismatch' }
$binding = Read-Json $BindingPath
$vmName = [string]$binding.vm_name
$vmId = ([string]$binding.vm_id).ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($vmName) -or $vmId -cnotmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$' -or
    [string]$binding.harness_commit -cne $HarnessCommit -or [string]$binding.harness_tree -cne $HarnessTree) { throw 'copy_binding_identity_invalid' }
$repositoryRoot = Assert-E1FinalCanonicalRepository $CanonicalRepositoryRoot $HarnessCommit $HarnessTree
$snapshotManifestPath=Join-Path $PSScriptRoot 'evidence1-host-elevated-runner-manifest.json';Assert-E1FinalNoReparseAncestors $snapshotManifestPath
$snapshotManifest=Read-Json $snapshotManifestPath
$null=Assert-E1FinalRunnerManifest $snapshotManifest $HarnessCommit
$null=Assert-E1FinalNodeSnapshotBinding $snapshotManifest (Join-Path $PSScriptRoot 'node-runtime') $repositoryRoot
foreach ($path in @($privateFull, $publicFull, $CompletionReportPath)) { if (Test-Path -LiteralPath $path) { throw 'copy_destination_must_be_create_new' } }
$reservation=[ordered]@{schema=1;kind='evidence1-final-codex-copy-reservation';campaign_id=$CampaignId;harness_commit=$HarnessCommit;harness_tree=$HarnessTree;binding_sha256=$BindingSha256;private_destination_sha256=Get-E1TextSha256 $privateFull;public_destination_sha256=Get-E1TextSha256 $publicFull;journal_path_sha256=Get-E1TextSha256 ([IO.Path]::GetFullPath($JournalPath));completion_report_path_sha256=Get-E1TextSha256 ([IO.Path]::GetFullPath($CompletionReportPath));retry_count=0;replacement_authorized=$false;respawn_authorized=$false;reserved_at_utc=[datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
Write-E1FinalCreateNewJson $ReportPath $reservation
function Assert-PublicClosedSet([string]$Directory, $Manifest, [string]$ManifestSha256, [string]$Prefix) {
    $files = @(Get-ChildItem -LiteralPath $Directory -File -Force)
    if ($files.Count -ne 8 -or @(Get-ChildItem -LiteralPath $Directory -Directory -Force).Count -ne 0) { throw "${Prefix}_closed_set_invalid" }
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $null = $expected.Add('summary.json')
    $null = $expected.Add('manifest.json')
    foreach ($entry in @($Manifest.records)) { $null = $expected.Add([string]$entry.name) }
    if ($expected.Count -ne 8 -or @($files | Where-Object { -not $expected.Contains($_.Name) }).Count -ne 0) { throw "${Prefix}_closed_set_invalid" }
    foreach ($entry in @($Manifest.records)) {
        if ((Get-Sha (Join-Path $Directory $entry.name)) -cne $entry.sha256) { throw "${Prefix}_record_hash_mismatch" }
    }
    if ((Get-Sha (Join-Path $Directory 'summary.json')) -cne $Manifest.summary_sha256) { throw "${Prefix}_summary_hash_mismatch" }
    if ((Get-Sha (Join-Path $Directory 'manifest.json')) -cne $ManifestSha256) { throw "${Prefix}_manifest_hash_mismatch" }
}

$vm = Get-VM -Name $vmName -ErrorAction Stop
if ($vm.State -ne 'Off' -or ([string]$vm.Id).ToLowerInvariant() -cne $vmId) { throw 'copy_requires_exact_vm_off' }
$disk = (Get-VMHardDiskDrive -VMName $vm.Name | Select-Object -First 1).Path
if (-not ([IO.Path]::GetFullPath($disk)).StartsWith('C:\kmp-eval\hyperv-e2e\', [StringComparison]::OrdinalIgnoreCase)) { throw 'vhd_scope_invalid' }
$mount = $null
$privateStage = $privateFull + '.staging-' + [guid]::NewGuid().ToString('N')
$publicStage = $publicFull + '.staging-' + [guid]::NewGuid().ToString('N')
try {
    $mount = Mount-VHD -Path $disk -ReadOnly -Passthru
    $root = Get-E1FinalMountedWindowsRoot $mount
    $guestPrivate = Join-Path $root "Evidence1Custody\$CampaignId"
    $guestPublic = Join-Path $root "kmp-eval\agentic-eval-codex-runtime\tools\runs\evidence1-codex-pilot-$CampaignId"
    $terminalPath = Join-Path $root "Evidence1Ops\final-codex\$CampaignId.terminal.json"
    $terminalClaimPath = Join-Path $root "Evidence1Ops\final-codex\$CampaignId.terminal.claim.json"
    foreach ($path in @($guestPrivate, $guestPublic)) { Assert-E1NoReparseTree $path | Out-Null }
    Assert-E1NoReparseAncestors $terminalPath | Out-Null
    foreach ($path in @($terminalPath, $terminalClaimPath, (Join-Path $guestPrivate 'campaign-custody.json'), (Join-Path $guestPrivate 'publication-manifest.json'), (Join-Path $guestPublic 'summary.json'))) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'campaign_not_closed' }
    }

    # Validate the complete guest closed set before either host staging directory exists.
    $terminal = Read-Json $terminalPath
    $terminalClaim = Read-Json $terminalClaimPath
    $manifestPath = Join-Path $guestPrivate 'publication-manifest.json'
    $custodyPath = Join-Path $guestPrivate 'campaign-custody.json'
    $manifest = Read-Json $manifestPath
    $custody = Read-Json $custodyPath
    $null=Assert-E1GuestTerminalChain -Terminal $terminal -TerminalClaim $terminalClaim -CampaignCustody $custody -CampaignId $CampaignId -TerminalClaimSha256 (Get-Sha $terminalClaimPath) -CampaignCustodySha256 (Get-Sha $custodyPath) -PublicationManifestSha256 (Get-Sha $manifestPath) -ExpectedBindingSha256 $BindingSha256
    $manifestKeys=@('schema','kind','campaign_id','binding_sha256','campaign_custody_sha256','summary_sha256','records','public_file_count','sidecars_published','raw_published')
    if (@(Compare-Object @($manifest.PSObject.Properties.Name|Sort-Object) @($manifestKeys|Sort-Object)).Count-ne 0-or$manifest.schema-ne 1-or$manifest.kind -cne 'evidence1-final-codex-publication-manifest' -or $manifest.campaign_id -cne $CampaignId -or $manifest.binding_sha256-cne$BindingSha256-or$manifest.campaign_custody_sha256-cne(Get-Sha $custodyPath)-or [int]$manifest.public_file_count -ne 8 -or @($manifest.records).Count -ne 6 -or $manifest.sidecars_published -ne $false -or $manifest.raw_published -ne $false) { throw 'publication_manifest_invalid' }
    if ((Get-Sha $manifestPath) -cne $terminal.publication_manifest_sha256 -or (Get-Sha $custodyPath) -cne $terminal.campaign_custody_sha256) { throw 'terminal_custody_hash_mismatch' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $manifestRecordKeys=@('order_index','name','sha256')
    $logicalCustodyRoot="C:\Evidence1Custody\$CampaignId";$guestRunDir=Join-Path $root "Evidence1Ops\final-codex\$CampaignId"
    $claimTree=Assert-E1GuestClaimTree -GuestRunDir $guestRunDir -CampaignCustody $custody;$guestRunDir=$claimTree.run_dir;$groupClaimPath=$claimTree.group_claim
    for ($i = 0; $i -lt 6; $i++) {
        $entry = $manifest.records[$i]
        $artifact=$custody.artifacts[$i]
        if (@(Compare-Object @($entry.PSObject.Properties.Name|Sort-Object) @($manifestRecordKeys|Sort-Object)).Count-ne 0-or[int]$entry.order_index -ne $i -or [string]$entry.name -cnotmatch '^[0-9a-f-]{36}\.json$' -or -not $seen.Add([string]$entry.name) -or [string]$entry.sha256 -cnotmatch '^[0-9a-f]{64}$'-or$entry.order_index-ne$artifact.order_index-or$entry.name-cne(Split-Path -Leaf $artifact.record_path)-or$entry.sha256-cne$artifact.record_sha256) { throw 'publication_manifest_record_invalid' }
        foreach($axis in @(@('record_path','record_sha256'),@('sidecar_path','sidecar_sha256'))){$logical=[string]$artifact.($axis[0]);if(-not$logical.StartsWith($logicalCustodyRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'campaign_custody_artifact_scope_invalid'};$relative=$logical.Substring($logicalCustodyRoot.Length).TrimStart('\');$mounted=Join-Path $guestPrivate $relative;if(-not(Test-Path -LiteralPath $mounted -PathType Leaf)-or((Get-Item -LiteralPath $mounted -Force).Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0-or(Get-Sha $mounted)-cne$artifact.($axis[1])){throw 'campaign_custody_artifact_hash_mismatch'}}
    }
$manifestSha256=Get-Sha $manifestPath
Assert-PublicClosedSet $guestPublic $manifest $manifestSha256 'guest_public'

    New-Item -ItemType Directory -Path $privateStage -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path $publicStage -ErrorAction Stop | Out-Null
    foreach ($item in @(Get-ChildItem -LiteralPath $guestPrivate -Force)) { Copy-Item -LiteralPath $item.FullName -Destination $privateStage -Recurse -Force -ErrorAction Stop }
    $claimStage=Join-Path $privateStage 'operational-claims';New-Item -ItemType Directory -Path $claimStage -ErrorAction Stop|Out-Null
    Copy-Item -LiteralPath $groupClaimPath -Destination (Join-Path $claimStage 'group.claim.json') -ErrorAction Stop
    foreach($claimEntry in @($custody.slot_and_plan_claims)){$slotStage=Join-Path $claimStage ('slots\'+[int]$claimEntry.order_index);if(-not(Test-Path -LiteralPath $slotStage)){New-Item -ItemType Directory -Path $slotStage -ErrorAction Stop|Out-Null};$source=Join-Path $guestRunDir ("slots\"+[int]$claimEntry.order_index+'\'+[string]$claimEntry.name);$destination=Join-Path $slotStage ([string]$claimEntry.name);Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop;if((Get-Sha $destination)-cne$claimEntry.sha256){throw 'copied_operational_claim_hash_mismatch'}}
    if((Get-Sha (Join-Path $claimStage 'group.claim.json'))-cne$custody.group_claim_sha256){throw 'copied_operational_claim_hash_mismatch'}
    foreach($control in @(@($terminalClaimPath,'guest-terminal.claim.json'),@($terminalPath,'guest-terminal.json'))){$destination=Join-Path $privateStage $control[1];if(Test-Path -LiteralPath $destination){throw 'guest_terminal_custody_collision'};Copy-Item -LiteralPath $control[0] -Destination $destination -ErrorAction Stop;if((Get-Sha $destination)-cne(Get-Sha $control[0])){throw 'guest_terminal_custody_hash_mismatch'}}
    foreach ($item in @(Get-ChildItem -LiteralPath $guestPublic -Force)) { Copy-Item -LiteralPath $item.FullName -Destination $publicStage -Recurse -Force -ErrorAction Stop }
    Assert-E1NoReparseTree $privateStage | Out-Null
    Assert-E1NoReparseTree $publicStage | Out-Null
    if ((Get-Sha (Join-Path $privateStage 'publication-manifest.json')) -cne (Get-Sha $manifestPath) -or (Get-Sha (Join-Path $privateStage 'campaign-custody.json')) -cne (Get-Sha $custodyPath)) { throw 'copied_private_custody_hash_mismatch' }
Assert-PublicClosedSet $publicStage $manifest $manifestSha256 'copied_public'

    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $scanArgs = @((Join-Path $PSScriptRoot 'node-runtime\docs\audits\evidence1-codex-publication-scan.mjs'))
    foreach ($file in @(Get-ChildItem -LiteralPath $publicStage -File | Sort-Object Name)) { $scanArgs += @('--file', $file.FullName) }
    if ($PrivatePatternsFile) { $scanArgs += @('--private-patterns-file', (Get-E1CanonicalFullPath $PrivatePatternsFile)) }
    $scanStdout = Join-Path $privateStage 'host-publication-scan.stdout.json'
    $scanStderr = Join-Path $privateStage 'host-publication-scan.stderr.log'
    $scan = Invoke-E1OwnedProcess $node $scanArgs $repositoryRoot $scanStdout $scanStderr 120
    if ($scan.ExitCode -ne 0 -or $scan.TimedOut -or -not $scan.CleanupOk) { throw 'host_publication_privacy_scan_failed' }

    $null = Complete-E1TwoDirectoryTransaction -PrivateStage $privateStage -PrivateDestination $privateFull -PublicStage $publicStage -PublicDestination $publicFull -JournalPath $JournalPath
    $privateStage = $null; $publicStage = $null
    try {
        $value = [ordered]@{ schema=1; kind='evidence1-final-codex-copy-terminal'; verdict='PASS'; campaign_id=$CampaignId; binding_sha256=$BindingSha256; reservation_sha256=Get-Sha $ReportPath; journal_complete_sha256=Get-Sha ($JournalPath+'.complete.json'); recovered=$false; private_custody_outside_repo=$true; public_destination_inside_repo=$true; create_new_rename=$true; public_files=8; raw_published=$false; sidecars_published=$false }
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($value | ConvertTo-Json -Compress) + "`n")
        $stream = [IO.File]::Open($CompletionReportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    } catch {
        # The durable journal owns recovery; never delete a successfully renamed
        # custody/publication directory merely because terminal report I/O failed.
        throw
    }
} finally {
    if ($mount) { Dismount-VHD -Path $disk -ErrorAction SilentlyContinue }
    foreach ($stage in @($privateStage, $publicStage)) {
        if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

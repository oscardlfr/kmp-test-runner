Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-E1FinalCanonicalPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) { throw 'final_host_path_not_absolute' }
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Assert-E1FinalNoReparseAncestors([string]$Path) {
    $cursor = Get-E1FinalCanonicalPath $Path
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'final_host_reparse_path_rejected' }
        }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrEmpty($parent) -or $parent -ceq $cursor) { break }
        $cursor = $parent
    }
}

function Assert-E1FinalPathUnder([string]$Path, [string]$Root, [string]$Code) {
    $full = Get-E1FinalCanonicalPath $Path; $rootFull = Get-E1FinalCanonicalPath $Root
    if (-not $full.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) { throw $Code }
    Assert-E1FinalNoReparseAncestors (Split-Path -Parent $full)
    return $full
}

function Assert-E1FinalCanonicalRepository {
    param([string]$RepositoryRoot,[string]$ExpectedHead,[string]$ExpectedTree,[string[]]$AllowedDirtyPaths=@())
    $expected = 'C:\kmp-eval\agentic-eval-codex-runtime'
    $actual = Get-E1FinalCanonicalPath $RepositoryRoot
    if (-not $actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'canonical_main_worktree_required' }
    Assert-E1FinalNoReparseAncestors $actual
    $gitMetadata=Join-Path $actual '.git'
    if(-not(Test-Path -LiteralPath $gitMetadata)){throw 'canonical_main_worktree_required'}
    Assert-E1FinalNoReparseAncestors $gitMetadata
    $git=(Get-Command git.exe -ErrorAction Stop).Source
    $gitArgs=@('-c', "safe.directory=$actual", '-C', $actual)
    $top=(& $git @gitArgs rev-parse --show-toplevel).Trim();$head=(& $git @gitArgs rev-parse HEAD).Trim();$tree=(& $git @gitArgs rev-parse 'HEAD^{tree}').Trim();$dirty=@(& $git @gitArgs status --porcelain=v1 --untracked-files=all)
    $allowedPrefixes=@();foreach($path in @($AllowedDirtyPaths)){
        $full=Get-E1FinalCanonicalPath $path
        if(-not $full.StartsWith($actual+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'canonical_recovery_dirty_scope_invalid'}
        Assert-E1FinalNoReparseAncestors $full
        $relative=$full.Substring($actual.Length).TrimStart('\').Replace('\','/').TrimEnd('/')
        if([string]::IsNullOrWhiteSpace($relative)){throw 'canonical_recovery_dirty_scope_invalid'}
        $allowedPrefixes+=($relative+'/')
    }
    $unexpected=@($dirty|Where-Object{
        $line=[string]$_
        if(-not $line.StartsWith('?? ',[StringComparison]::Ordinal)){return $true}
        $relative=$line.Substring(3).Replace('\','/')
        return -not @($allowedPrefixes|Where-Object{$relative.StartsWith($_,[StringComparison]::OrdinalIgnoreCase)}).Count
    })
    if($LASTEXITCODE-ne 0-or$ExpectedHead-cnotmatch'^[0-9a-f]{40}$'-or$ExpectedTree-cnotmatch'^[0-9a-f]{40}$'-or
       -not([IO.Path]::GetFullPath($top).TrimEnd('\').Equals($actual,[StringComparison]::OrdinalIgnoreCase))-or
       $head-cne$ExpectedHead-or$tree-cne$ExpectedTree-or$unexpected.Count-ne 0){throw 'canonical_main_worktree_not_clean_or_pinned'}
    return $actual
}

function Write-E1FinalCreateNewJson([string]$Path, $Value) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 30 -Compress) + "`n")
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read,
        4096, [IO.FileOptions]::WriteThrough)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function New-E1FinalOperationReservation {
    param([string]$ReportPath,[string]$ReportRoot,[string]$Kind,[string]$CampaignId,$Prerequisites)
    $full = Assert-E1FinalPathUnder $ReportPath $ReportRoot 'final_report_path_not_canonical_scratch'
    if (Test-Path -LiteralPath $full) { throw 'final_operation_report_already_exists' }
    $claimPath = $full + '.claim.json'
    $value = [ordered]@{schema=1;kind=$Kind;campaign_id=$CampaignId;report_path_sha256=(Get-E1TextSha256 $full);prerequisites=$Prerequisites;reserved_at_utc=[datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
    Write-E1FinalCreateNewJson $claimPath $value
    return $claimPath
}

function Get-E1TextSha256([string]$Text) {
    $hash=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))-replace'-','').ToLowerInvariant()}finally{$hash.Dispose()}
}

function Get-E1FinalFileSha256([string]$Path) {
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{$hash=[Security.Cryptography.SHA256]::Create();try{return([BitConverter]::ToString($hash.ComputeHash($stream))-replace'-','').ToLowerInvariant()}finally{$hash.Dispose()}}finally{$stream.Dispose()}
}

function Get-E1FinalMountedWindowsRoot {
    param($MountedVhd,[string]$MissingCode='guest_volume_missing')
    $disk=$MountedVhd|Get-Disk -ErrorAction Stop
    $roots=@()
    foreach($partition in @($disk|Get-Partition -ErrorAction Stop)){
        $candidates=@()
        if($partition.DriveLetter){$candidates+=([string]$partition.DriveLetter+':\')}
        foreach($accessPath in @($partition.AccessPaths)){
            $value=[string]$accessPath
            if($value.StartsWith('\\?\Volume{',[StringComparison]::OrdinalIgnoreCase)-and$value.EndsWith('}\',[StringComparison]::Ordinal)){$candidates+=$value}
        }
        foreach($candidate in @($candidates|Select-Object -Unique)){
            if(Test-Path -LiteralPath (Join-Path $candidate 'Windows\System32\Config\SYSTEM') -PathType Leaf){$roots+=$candidate}
        }
    }
    $roots=@($roots|Select-Object -Unique)
    if($roots.Count-ne 1){throw $MissingCode}
    return [string]$roots[0]
}

function Assert-E1FinalRunnerManifest($Manifest,[string]$ExpectedSourceCommit='') {
    if($null-eq$Manifest-or-not($Manifest.PSObject.Properties.Name-ccontains'schema')){throw 'snapshot_node_manifest_invalid'}
    $manifestKeys=if($Manifest.schema-eq 2){@('kind','node_files','principal_sid','process_module_sha256','runner_sha256','schema','scripts','source_git_commit','support_files')}else{@('kind','node_files','principal_sid','process_module_sha256','runner_sha256','schema','scripts','support_files')}
    if($Manifest.schema-notin@(1,2)-or@($Manifest.PSObject.Properties.Name).Count-ne$manifestKeys.Count-or@(Compare-Object @($Manifest.PSObject.Properties.Name|Sort-Object) @($manifestKeys|Sort-Object)).Count-ne 0-or$Manifest.kind-cne'evidence1-host-elevated-runner-manifest'-or($Manifest.schema-eq 2-and[string]$Manifest.source_git_commit-cnotmatch'^[0-9a-f]{40,64}$')-or@($Manifest.node_files).Count-eq 0){throw 'snapshot_node_manifest_invalid'}
    if(-not[string]::IsNullOrWhiteSpace($ExpectedSourceCommit)-and($ExpectedSourceCommit-cnotmatch'^[0-9a-f]{40,64}$'-or$Manifest.schema-ne 2-or[string]$Manifest.source_git_commit-cne$ExpectedSourceCommit)){throw 'snapshot_source_commit_mismatch'}
    $seen=@{};foreach($entry in @($Manifest.node_files)){$entryKeys=if($Manifest.schema-eq 2){@('blob_oid','name','sha256')}else{@('name','sha256')};if(@(Compare-Object @($entry.PSObject.Properties.Name|Sort-Object) @($entryKeys|Sort-Object)).Count-ne 0-or[string]$entry.name-cnotmatch'^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$'-or[string]$entry.sha256-cnotmatch'^[0-9a-f]{64}$'-or($Manifest.schema-eq 2-and[string]$entry.blob_oid-cnotmatch'^[0-9a-f]{40,64}$')-or$seen.ContainsKey([string]$entry.name)){throw 'snapshot_node_manifest_invalid'};$seen[[string]$entry.name]=$true}
    return $true
}

function Assert-E1FinalNodeSnapshotBinding($Manifest,[string]$SnapshotNodeRoot,[string]$RepositoryRoot) {
    $snapshotRoot=[IO.Path]::GetFullPath($SnapshotNodeRoot).TrimEnd('\');$repoRoot=[IO.Path]::GetFullPath($RepositoryRoot).TrimEnd('\');$map=@{}
    Assert-E1FinalNoReparseAncestors $snapshotRoot;Assert-E1FinalNoReparseAncestors $repoRoot
    $manifestV2=$Manifest.PSObject.Properties.Name-ccontains'schema'-and$Manifest.schema-eq 2
    foreach($entry in @($Manifest.node_files)){
        $entryKeys=if($manifestV2){@('blob_oid','name','sha256')}else{@('name','sha256')}
        if(@(Compare-Object @($entry.PSObject.Properties.Name|Sort-Object) @($entryKeys|Sort-Object)).Count-ne 0-or[string]$entry.name-cnotmatch'^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$'-or[string]$entry.sha256-cnotmatch'^[0-9a-f]{64}$'-or($manifestV2-and[string]$entry.blob_oid-cnotmatch'^[0-9a-f]{40,64}$')-or$map.ContainsKey([string]$entry.name)){throw 'snapshot_node_manifest_invalid'}
        $relative=([string]$entry.name).Replace('/','\');$snapshotPath=[IO.Path]::GetFullPath((Join-Path $snapshotRoot $relative));$repoPath=[IO.Path]::GetFullPath((Join-Path $repoRoot $relative))
        if(-not$snapshotPath.StartsWith($snapshotRoot+'\',[StringComparison]::OrdinalIgnoreCase)-or-not$repoPath.StartsWith($repoRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'snapshot_node_manifest_invalid'}
        Assert-E1FinalNoReparseAncestors $snapshotPath;Assert-E1FinalNoReparseAncestors $repoPath
        if(-not(Test-Path -LiteralPath $snapshotPath -PathType Leaf)-or-not(Test-Path -LiteralPath $repoPath -PathType Leaf)){throw 'snapshot_node_file_missing'}
        $snapshotHash=Get-E1FinalFileSha256 $snapshotPath;$repoHash=Get-E1FinalFileSha256 $repoPath
        if($snapshotHash-cne[string]$entry.sha256){throw 'snapshot_node_hash_mismatch'}
        if($repoHash-cne[string]$entry.sha256){throw 'snapshot_node_not_bound_to_canonical_repository'}
        $map[[string]$entry.name]=[string]$entry.sha256
    }
    return $map
}

function Complete-E1FinalFileMove([string]$Source,[string]$Destination,[bool]$Required=$false) {
    $sourceExists=Test-Path -LiteralPath $Source -PathType Leaf;$destinationExists=Test-Path -LiteralPath $Destination -PathType Leaf
    if($sourceExists-and$destinationExists){throw 'retirement_split_file_state'}
    if($sourceExists){Move-Item -LiteralPath $Source -Destination $Destination -ErrorAction Stop;return}
    if($Required-and-not$destinationExists){throw 'preflight_failure_evidence_missing'}
}

function Copy-E1FinalVerifiedThenRemove([string]$Source,[string]$Destination) {
    $sourceHash=Get-E1FinalFileSha256 $Source
    if(Test-Path -LiteralPath $Destination -PathType Leaf){
        if((Get-E1FinalFileSha256 $Destination)-cne$sourceHash){throw 'retirement_custody_copy_hash_mismatch'}
    }else{
        Copy-Item -LiteralPath $Source -Destination $Destination -ErrorAction Stop
        if((Get-E1FinalFileSha256 $Destination)-cne$sourceHash){throw 'retirement_custody_copy_hash_mismatch'}
    }
    Remove-Item -LiteralPath $Source -Force -ErrorAction Stop
}

function Set-E1FinalGuestRuntimeAcl([string]$Path,[bool]$Directory) {
    $security=if($Directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
    $security.SetAccessRuleProtection($true,$false);$admin=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544');$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18');$users=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-545');$security.SetOwner($admin)
    $inherit=if($Directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
    foreach($rule in @(
        [Security.AccessControl.FileSystemAccessRule]::new($system,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow),
        [Security.AccessControl.FileSystemAccessRule]::new($admin,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow),
        [Security.AccessControl.FileSystemAccessRule]::new($users,[Security.AccessControl.FileSystemRights]::ReadAndExecute,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    )){$security.AddAccessRule($rule)|Out-Null}
    Set-Acl -LiteralPath $Path -AclObject $security
}

function Assert-E1FinalGuestRuntimeAcl([string]$Path,[bool]$Directory) {
    $acl=Get-Acl -LiteralPath $Path;if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value-cne'S-1-5-32-544'-or-not$acl.AreAccessRulesProtected){throw 'guest_runtime_acl_invalid'}
    $rules=@($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]));if($rules.Count-ne 3){throw 'guest_runtime_acl_invalid'}
    $readExecute=[int]([Security.AccessControl.FileSystemRights]::ReadAndExecute-bor[Security.AccessControl.FileSystemRights]::Synchronize);$expected=@{'S-1-5-18'=[int][Security.AccessControl.FileSystemRights]::FullControl;'S-1-5-32-544'=[int][Security.AccessControl.FileSystemRights]::FullControl;'S-1-5-32-545'=$readExecute}
    foreach($rule in $rules){$sid=$rule.IdentityReference.Value;$inherit=if($Directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None};if(-not$expected.ContainsKey($sid)-or$rule.AccessControlType-ne[Security.AccessControl.AccessControlType]::Allow-or[int]$rule.FileSystemRights-ne$expected[$sid]-or$rule.InheritanceFlags-ne$inherit-or$rule.PropagationFlags-ne[Security.AccessControl.PropagationFlags]::None){throw 'guest_runtime_acl_invalid'}}
}

Export-ModuleMember -Function @('Get-E1FinalCanonicalPath','Assert-E1FinalNoReparseAncestors','Assert-E1FinalPathUnder',
    'Assert-E1FinalCanonicalRepository','Write-E1FinalCreateNewJson','New-E1FinalOperationReservation','Get-E1TextSha256',
    'Get-E1FinalMountedWindowsRoot','Assert-E1FinalRunnerManifest','Assert-E1FinalNodeSnapshotBinding','Complete-E1FinalFileMove',
    'Copy-E1FinalVerifiedThenRemove','Set-E1FinalGuestRuntimeAcl','Assert-E1FinalGuestRuntimeAcl')

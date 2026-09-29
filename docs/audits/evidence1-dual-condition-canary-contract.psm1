Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:BindingKeys = @(
    'schema','kind','pair_id','group_run_id','arm','condition','product_access_mode','scenario_id','seed',
    'execution_profile_id','harness_commit','harness_tree','source_commit','source_tree','ledger_root_sha256','planned_sessions',
    'runtime_order','authorization_scope_id',
    'skill_snapshot_sha256','skill_snapshot_reason','common_process_timeout_seconds','remote_auth_max_age_minutes','retry_limit',
    'benchmark_eligible','validator_bundle','slots'
)
$script:ValidatorBundleKeys = @('schema','bundle_sha256','files')
$script:ValidatorFileKeys = @('relative_path','sha256','size_bytes')
$script:SlotKeys = @(
    'ordinal','slot_id','runtime_id','cli_version','model_requested','model_resolved','campaign_design_id','condition','product_access_mode',
    'scenario_id','seed','execution_profile_id','source_commit','source_tree','process_timeout_seconds',
    'session_budget_usd','session_budget_reason','plan_sha256','isolation_attestation_sha256',
    'expected_skill_available','expected_snapshot_binding'
)
$script:AuthorizationKeys = @(
    'schema','kind','pair_id','group_run_id','binding_sha256','authorization_scope_id',
    'authorization_sha256','planned_sessions','retry_limit'
)
$script:GroupClaimKeys = @(
    'schema','kind','pair_id','group_run_id','binding_sha256','authorization_claim_sha256',
    'authorization_scope_id','state','planned_sessions','retry_limit'
)
$script:SlotClaimKeys = @(
    'schema','kind','pair_id','group_run_id','binding_sha256','slot_id','ordinal','runtime_id',
    'prerequisite_kind','prerequisite_sha256','attempt_number','retry_authorized'
)
$script:PlanClaimKeys = @(
    'schema','kind','pair_id','group_run_id','binding_sha256','slot_claim_sha256','slot_id','ordinal',
    'runtime_id','plan_sha256','run_id','run_id_binding_policy','state','retry_authorized'
)
$script:DispatchKeys=@('schema','kind','pair_id','group_run_id','binding_sha256','slot_claim_sha256','plan_claim_sha256',
  'slot_id','ordinal','runtime_id','state','sessions_consumed','contained_before_release','retry_authorized')
$script:CopyTransactionKeys=@('schema','kind','pair_id','group_run_id','binding_sha256','dispatch_started_sha256','slot_id','ordinal',
  'runtime_id','run_id','record_relative_path','record_sha256','sidecar_relative_path','sidecar_sha256','state','retry_authorized')
$script:CopyRecoveryKeys=@('schema','kind','pair_id','group_run_id','binding_sha256','copy_transaction_sha256','slot_id','ordinal',
  'runtime_id','state','reason_code','retry_authorized')
$script:TerminalKeys = @(
    'schema','kind','pair_id','group_run_id','binding_sha256','slot_claim_sha256','plan_claim_sha256','dispatch_started_sha256','copy_transaction_sha256','slot_id','ordinal',
    'runtime_id','state','failure_class','process_exit_code','timed_out','cleanup_ok','record_status',
    'run_id','record_sha256','sidecar_status','sidecar_sha256','integrity_status','reason_code',
    'benchmark_eligible',
    'sessions_consumed','retry_authorized'
)
$script:IntegrityKeys = @(
    'schema','kind','pair_id','group_run_id','binding_sha256','slot_terminal_sha256',
    'slot_id','ordinal','runtime_id','terminal_state','integrity_status','dispatch_next_slot',
    'decision','reason_code','retry_authorized'
)
$script:CustodyKeys = @(
    'schema','kind','pair_id','group_run_id','binding_sha256','group_claim_sha256',
    'inter_slot_integrity_sha256','state','complete','planned_sessions','sessions_consumed',
    'records_validated','sidecars_validated','retry_count','retry_authorized','benchmark_eligible',
    'aggregated_across_runtimes','slots'
)
$script:CustodySlotKeys = @(
    'ordinal','slot_id','runtime_id','slot_claim_sha256','plan_claim_sha256','dispatch_started_sha256','copy_transaction_sha256','slot_terminal_sha256','sessions_consumed',
    'terminal_state','failure_class','reason_code','record_status','record_sha256',
    'run_id','sidecar_status','sidecar_sha256','integrity_status'
)
$script:PairArmClaimKeys=@('schema','kind','pair_id','arm','group_run_id','binding_sha256','comparison_sha256',
  'claude_attestation_sha256','codex_attestation_sha256','validator_bundle_sha256','state','retry_authorized')
$script:PublicationFileKeys=@('relative_path','sha256','size_bytes')
$script:PublicationTransactionKeys=@('schema','kind','destination_root_sha256','tier','manifest_sha256','files','state','resume_authorized')
$script:PublicationReadyKeys=@('schema','kind','transaction_sha256','manifest_sha256','state')

function Get-E1Keys($Value) {
    if ($Value -is [Collections.IDictionary]) { return @($Value.Keys | ForEach-Object { [string]$_ }) }
    if ($Value -is [pscustomobject]) { return @($Value.PSObject.Properties | ForEach-Object { $_.Name }) }
    throw 'dual_condition_shape'
}

function Get-E1Field($Value, [string]$Name) {
    if ($Value -is [Collections.IDictionary]) {
        if (-not $Value.Contains($Name)) { throw 'dual_condition_shape' }
        return $Value[$Name]
    }
    if ($Value -is [pscustomobject]) {
        $property = $Value.PSObject.Properties[$Name]
        if ($null -eq $property) { throw 'dual_condition_shape' }
        return $property.Value
    }
    throw 'dual_condition_shape'
}

function Assert-E1ExactKeys($Value, [string[]]$Expected) {
    $actual = @(Get-E1Keys $Value)
    if ($actual.Count -ne $Expected.Count) { throw 'dual_condition_shape' }
    foreach ($name in $actual) { if ($name -cnotin $Expected) { throw 'dual_condition_shape' } }
    foreach ($name in $Expected) { if ($name -cnotin $actual) { throw 'dual_condition_shape' } }
}

function Assert-E1String($Value, [string]$Expected = '') {
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) { throw 'dual_condition_shape' }
    if ($Expected -and $Value -cne $Expected) { throw 'dual_condition_shape' }
}

function Assert-E1Bool($Value, [bool]$Expected) {
    if ($Value -isnot [bool] -or $Value -ne $Expected) { throw 'dual_condition_shape' }
}

function Assert-E1Integer($Value, [long]$Expected) {
    if (($Value -isnot [int]) -and ($Value -isnot [long])) { throw 'dual_condition_shape' }
    if ([long]$Value -ne $Expected) { throw 'dual_condition_shape' }
}

function Assert-E1Hash($Value) {
    if ($Value -isnot [string] -or $Value -cnotmatch '^[a-f0-9]{64}$') { throw 'dual_condition_shape' }
}

function Assert-E1GitSha($Value) {
    if ($Value -isnot [string] -or $Value -cnotmatch '^[a-f0-9]{40}$') { throw 'dual_condition_shape' }
}

function Assert-E1Guid($Value) {
    if ($Value -isnot [string]) { throw 'dual_condition_shape' }
    $parsed = [guid]::Empty
    if (-not [guid]::TryParseExact($Value, 'D', [ref]$parsed) -or $parsed -eq [guid]::Empty -or
        $Value -cne $parsed.ToString('D')) { throw 'dual_condition_shape' }
}

function Get-E1Sha256Bytes([byte[]]$Bytes) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return -join ($hasher.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) }
    finally { $hasher.Dispose() }
}

function Get-E1Sha256String([string]$Value) {
    return Get-E1Sha256Bytes ([Text.UTF8Encoding]::new($false).GetBytes($Value))
}

function Get-E1FileSha256([string]$Path) {
    $stream = [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        $hasher=[Security.Cryptography.SHA256]::Create()
        try { return -join($hasher.ComputeHash($stream)|ForEach-Object{$_.ToString('x2')}) }
        finally{$hasher.Dispose()}
    } finally{$stream.Dispose()}
}

function Copy-Evidence1DualConditionPublicArtifact {
    param(
        [Parameter(Mandatory)][string]$SourcePath,
        [Parameter(Mandatory)][string]$DestinationPath,
        [Parameter(Mandatory)][string]$ExpectedSha256
    )
    Assert-E1Hash $ExpectedSha256
    $source = Get-Item -LiteralPath $SourcePath -Force
    if ($source.PSIsContainer -or ($source.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'dual_condition_publication_source'
    }
    $bytes = [IO.File]::ReadAllBytes($source.FullName)
    if ((Get-E1Sha256Bytes $bytes) -cne $ExpectedSha256) { throw 'dual_condition_publication_source_hash' }
    $parent = Split-Path -Parent $DestinationPath
    $null = New-Item -ItemType Directory -Path $parent -Force
    $stream = [IO.File]::Open($DestinationPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
    if ((Get-E1FileSha256 $DestinationPath) -cne $ExpectedSha256) { throw 'dual_condition_publication_destination_hash' }
    return [ordered]@{ sha256 = $ExpectedSha256; size_bytes = [int64]$bytes.Length }
}

function Get-Evidence1DualConditionValidatorBundleManifest {
    param([Parameter(Mandatory)][string]$HarnessRoot)
    $root=[IO.Path]::GetFullPath($HarnessRoot).TrimEnd('\')
    $selected=@(Get-Item -LiteralPath (Join-Path $root 'package.json'))
    $selected+=@(Get-ChildItem -LiteralPath (Join-Path $root 'tools\agentic-eval') -Recurse -File |
      Where-Object { $_.Extension -cin @('.mjs','.json') })
    $selected+=@(Get-ChildItem -LiteralPath (Join-Path $root 'tools\lib') -Recurse -File |
      Where-Object { $_.Extension -cin @('.mjs','.json') })
    $selected+=@(Get-ChildItem -LiteralPath (Join-Path $root 'lib') -Recurse -File -Filter '*.js')
    foreach($name in @('evidence1-dual-condition-canary-launch.ps1','evidence1-dual-condition-canary-wrapper.ps1',
      'evidence1-dual-condition-canary-contract.psm1','evidence1-live-handoff-contract.psm1',
      'evidence1-validation-ops.psm1','evidence1-validation-forensics.psm1','evidence1-gradle-offline-probe.psm1')) {
        $selected+=Get-Item -LiteralPath (Join-Path $root "docs\audits\$name")
    }
    $selectedByPath=@{}
    foreach($item in $selected){
      $relative=$item.FullName.Substring($root.Length).TrimStart('\').Replace('\','/')
      if($selectedByPath.ContainsKey($relative)){throw 'dual_condition_validator_manifest'}
      $selectedByPath[$relative]=$item
    }
    [string[]]$relativePaths=@($selectedByPath.Keys)
    [Array]::Sort($relativePaths,[StringComparer]::Ordinal)
    $files=@($relativePaths|ForEach-Object {
      $item=$selectedByPath[$_]
      [ordered]@{relative_path=$_;sha256=Get-E1FileSha256 $item.FullName;size_bytes=[int64]$item.Length}
    })
    $bundleHash=Get-E1Sha256String (ConvertTo-Json -InputObject $files -Depth 5 -Compress)
    $manifest=[ordered]@{schema=1;bundle_sha256=$bundleHash;files=$files}
    $null=Assert-Evidence1DualConditionValidatorBundleManifest $manifest
    return $manifest
}

function Assert-Evidence1DualConditionValidatorBundleManifest($Manifest) {
    Assert-E1ExactKeys $Manifest $script:ValidatorBundleKeys
    Assert-E1Integer $Manifest.schema 1;Assert-E1Hash $Manifest.bundle_sha256
    $files=@($Manifest.files);if($files.Count-lt10-or$files.Count-gt500){throw 'dual_condition_validator_manifest'}
    $last='';$seen=@{}
    foreach($file in $files){
      Assert-E1ExactKeys $file $script:ValidatorFileKeys
      Assert-E1String $file.relative_path;Assert-E1Hash $file.sha256
      if((($file.size_bytes-isnot[int])-and($file.size_bytes-isnot[long]))-or$file.size_bytes-lt0){throw 'dual_condition_validator_manifest'}
      $path=[string]$file.relative_path
      if($path-match'(^|/)\.\.(/|$)'-or$path-match'^[\\/]'-or$path-match':'-or
        ($path-cne'package.json'-and$path-cnotmatch'^(tools/(agentic-eval|lib)/.+\.(mjs|json)|lib/.+\.js|docs/audits/evidence1-[a-z0-9-]+\.(ps1|psm1))$')){throw 'dual_condition_validator_manifest'}
      if($seen.ContainsKey($path)-or($last-and[string]::CompareOrdinal($last,$path)-ge0)){throw 'dual_condition_validator_manifest'}
      $seen[$path]=$true;$last=$path
    }
    foreach($required in @('package.json','tools/agentic-eval/run-record-loader.mjs','tools/agentic-eval/schemas.mjs',
      'tools/agentic-eval/scenario-campaign-plan.mjs','docs/audits/evidence1-dual-condition-canary-contract.psm1',
      'docs/audits/evidence1-dual-condition-canary-launch.ps1','docs/audits/evidence1-dual-condition-canary-wrapper.ps1')){
      if(-not$seen.ContainsKey($required)){throw 'dual_condition_validator_manifest'}
    }
    $expected=Get-E1Sha256String (ConvertTo-Json -InputObject $files -Depth 5 -Compress)
    if($expected-cne$Manifest.bundle_sha256){throw 'dual_condition_validator_bundle_hash'}
    return $true
}

function Assert-Evidence1DualConditionValidatorBundle {
    param([Parameter(Mandatory)][string]$Root,[Parameter(Mandatory)]$Manifest,[switch]$ExactInventory)
    $null=Assert-Evidence1DualConditionValidatorBundleManifest $Manifest
    $rootFull=[IO.Path]::GetFullPath($Root).TrimEnd('\')
    $rootItem=Get-Item -LiteralPath $rootFull -Force
    if(($rootItem.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'dual_condition_validator_reparse'}
    foreach($file in @($Manifest.files)){
      $candidate=Join-Path $rootFull ([string]$file.relative_path).Replace('/','\')
      $full=[IO.Path]::GetFullPath($candidate)
      if(-not$full.StartsWith($rootFull+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'dual_condition_validator_path'}
      $item=Get-Item -LiteralPath $full -Force
      if(($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0-or$item.PSIsContainer-or[int64]$item.Length-ne[int64]$file.size_bytes-or
        (Get-E1FileSha256 $full)-cne$file.sha256){throw 'dual_condition_validator_bytes'}
    }
    if($ExactInventory){
      $actual=@(Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force|ForEach-Object{$_.FullName.Substring($rootFull.Length).TrimStart('\').Replace('\','/')})
      if($actual.Count-ne@($Manifest.files).Count-or@($actual|Where-Object{$_-cnotin@($Manifest.files.relative_path)}).Count-ne0){throw 'dual_condition_validator_inventory'}
    }
    return $true
}

function Get-E1Paths([string]$OperationRoot) {
    $root = [IO.Path]::GetFullPath($OperationRoot)
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'dual_condition_operation_root_missing' }
    return [ordered]@{
        root = $root; binding = Join-Path $root 'binding.json'
        authorization = Join-Path $root 'authorization.claim.json'; group_claim = Join-Path $root 'group.claim.json'
        integrity = Join-Path $root 'inter-slot.integrity.json'; custody = Join-Path $root 'custody.json'
    }
}

function Get-E1NormalizedPathHash([string]$Path) {
    $normalized = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).ToLowerInvariant()
    return Get-E1Sha256String $normalized
}

function Assert-Evidence1DualConditionTrustedPath{
    param([Parameter(Mandatory)][string]$CandidatePath,[Parameter(Mandatory)][string]$TrustedRoot)
    $root=[IO.Path]::GetFullPath($TrustedRoot).TrimEnd('\','/');$candidate=[IO.Path]::GetFullPath($CandidatePath).TrimEnd('\','/')
    if(-not(Test-Path -LiteralPath $root -PathType Container)){throw 'dual_condition_trusted_root_missing'}
    if($candidate-cne$root-and-not$candidate.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'dual_condition_path_escape'}
    foreach($path in @($root,$candidate)){
      $cursor=$path
      while(-not[string]::IsNullOrWhiteSpace($cursor)){
        if(Test-Path -LiteralPath $cursor){
          $item=Get-Item -LiteralPath $cursor -Force
          if(($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'dual_condition_reparse_point'}
        }
        $parent=Split-Path -Parent $cursor
        if([string]::IsNullOrWhiteSpace($parent)-or$parent-ceq$cursor){break}
        $cursor=$parent
      }
    }
    return $candidate
}

function Get-Evidence1DualConditionCanaryOperationRoot {
    param(
        [Parameter(Mandatory)][string]$LedgerRoot,
        [Parameter(Mandatory)][string]$PairId,
        [Parameter(Mandatory)][string]$GroupRunId
    )
    Assert-E1Guid $PairId; Assert-E1Guid $GroupRunId
    return [IO.Path]::GetFullPath((Join-Path (Join-Path (Join-Path $LedgerRoot 'operations') $PairId) $GroupRunId))
}

function Assert-E1OperationRootBinding([string]$OperationRoot, $Binding) {
    $root = [IO.Path]::GetFullPath($OperationRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $groupDirectory = [IO.DirectoryInfo]::new($root)
    $pairDirectory = $groupDirectory.Parent
    $operationsDirectory = $(if ($null -ne $pairDirectory) { $pairDirectory.Parent } else { $null })
    $ledgerDirectory = $(if ($null -ne $operationsDirectory) { $operationsDirectory.Parent } else { $null })
    foreach ($directory in @($groupDirectory,$pairDirectory,$operationsDirectory,$ledgerDirectory)) {
        if ($null -ne $directory -and ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'dual_condition_reparse_point'
        }
    }
    $ledgerIdentityRoot=$(if([string]::IsNullOrWhiteSpace([string]$env:E1_DUAL_CANONICAL_LEDGER_ROOT)){
        $(if($null-ne$ledgerDirectory){$ledgerDirectory.FullName}else{$null})
    }else{
        $canonical=[IO.Path]::GetFullPath([string]$env:E1_DUAL_CANONICAL_LEDGER_ROOT).TrimEnd('\')
        if($canonical-cne'C:\Evidence1Ops\dual-condition-ledger'){throw 'dual_condition_canonical_ledger_override'}
        $canonical
    })
    if ($null -eq $ledgerDirectory -or $groupDirectory.Name -cne $Binding.group_run_id -or
        $pairDirectory.Name -cne $Binding.pair_id -or $operationsDirectory.Name -cne 'operations' -or
        (Get-E1NormalizedPathHash $ledgerIdentityRoot) -cne $Binding.ledger_root_sha256) {
        throw 'dual_condition_noncanonical_operation_root'
    }
}

function Assert-E1Inventory($Paths, [string[]]$ExpectedFiles) {
    $expectedDirectories = @('slots','slots/0','slots/0/audit','slots/1','slots/1/audit')
    $rootItem = Get-Item -LiteralPath $Paths.root -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'dual_condition_reparse_point' }
    $actualFiles = @(); $actualDirectories = @()
    foreach ($item in @(Get-ChildItem -LiteralPath $Paths.root -Force -Recurse)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'dual_condition_reparse_point' }
        $relative = $item.FullName.Substring($Paths.root.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).Replace('\','/')
        if ($item.PSIsContainer) { $actualDirectories += $relative } else { $actualFiles += $relative }
    }
    if ($actualDirectories.Count -ne $expectedDirectories.Count -or $actualFiles.Count -ne $ExpectedFiles.Count) { throw 'dual_condition_inventory' }
    foreach ($directory in $actualDirectories) { if ($directory -cnotin $expectedDirectories) { throw 'dual_condition_inventory' } }
    foreach ($file in $actualFiles) { if ($file -cnotin $ExpectedFiles) { throw 'dual_condition_inventory' } }
}

function Get-E1EvidencePaths($Paths, [int]$Ordinal) {
    $slotRoot = Get-E1SlotPath $Paths $Ordinal ''
    $auditRoot = Join-Path $slotRoot 'audit'
    $records = @(Get-ChildItem -LiteralPath $slotRoot -Force -File -Filter '*.json' |
        Where-Object { $_.Name -cnotin @('claim.json','plan.claim.json','dispatch.started.json','copy.transaction.json','copy.recovery.json','terminal.json') })
    $sidecars = @(Get-ChildItem -LiteralPath $auditRoot -Force -File -Filter '*.json')
    if ($records.Count -ne 1 -or $sidecars.Count -ne 1) { throw 'dual_condition_evidence_layout' }
    if (($records[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        ($sidecars[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'dual_condition_reparse_point' }
    if ($records[0].BaseName -cne $sidecars[0].BaseName) { throw 'dual_condition_evidence_layout' }
    return [ordered]@{ run_id = $records[0].BaseName; record = $records[0].FullName; sidecar = $sidecars[0].FullName }
}

function Get-E1EvidenceInventory($Paths, [int]$Ordinal) {
    $evidence = Get-E1EvidencePaths $Paths $Ordinal
    return @("slots/$Ordinal/$($evidence.run_id).json", "slots/$Ordinal/audit/$($evidence.run_id).json")
}

function Get-E1InventoryFiles([string]$Stage, $Paths = $null) {
    $files = @('binding.json')
    if ($Stage -ceq 'binding') { return $files }
    $files += 'authorization.claim.json'
    if ($Stage -ceq 'authorization') { return $files }
    $files += 'group.claim.json'
    if ($Stage -ceq 'group') { return $files }
    $files += 'slots/0/claim.json'
    if ($Stage -ceq 'slot0_claim') { return $files }
    $files += 'slots/0/plan.claim.json'
    if ($Stage -ceq 'slot0_plan') { return $files }
    $files += 'slots/0/dispatch.started.json'
    if($Stage-ceq'slot0_dispatch'){return $files}
    if($Stage-ceq'slot0_copy_transaction'){$files+='slots/0/copy.transaction.json';return $files}
    if($null-ne$Paths){
      if(Test-Path -LiteralPath (Get-E1SlotPath $Paths 0 'copy.transaction.json')){$files+='slots/0/copy.transaction.json'}
      if(Test-Path -LiteralPath (Get-E1SlotPath $Paths 0 'copy.recovery.json')){$files+='slots/0/copy.recovery.json'}
    }
    if($Stage-ceq'slot0_incomplete_preterminal'){return $files}
    if($Stage-ceq'slot0_incomplete_terminal'){$files+='slots/0/terminal.json';return $files}
    if ($Stage -cin @('slot0_evidence','slot0_terminal','integrity','slot1_claim','slot1_plan','slot1_dispatch','slot1_copy_transaction','slot1_incomplete_terminal','slot1_evidence','slot1_terminal','custody')) {
        if ($null -eq $Paths) { throw 'dual_condition_inventory_state' }
        $files += Get-E1EvidenceInventory $Paths 0
    }
    if ($Stage -ceq 'slot0_evidence') { return $files }
    $files += 'slots/0/terminal.json'
    if ($Stage -ceq 'slot0_terminal') { return $files }
    $files += 'inter-slot.integrity.json'
    if ($Stage -ceq 'integrity') { return $files }
    $files += 'slots/1/claim.json'
    if ($Stage -ceq 'slot1_claim') { return $files }
    $files += 'slots/1/plan.claim.json'
    if ($Stage -ceq 'slot1_plan') { return $files }
    $files += 'slots/1/dispatch.started.json'
    if($Stage-ceq'slot1_dispatch'){return $files}
    if($Stage-ceq'slot1_copy_transaction'){$files+='slots/1/copy.transaction.json';return $files}
    if($null-ne$Paths){
      if(Test-Path -LiteralPath (Get-E1SlotPath $Paths 1 'copy.transaction.json')){$files+='slots/1/copy.transaction.json'}
      if(Test-Path -LiteralPath (Get-E1SlotPath $Paths 1 'copy.recovery.json')){$files+='slots/1/copy.recovery.json'}
    }
    if($Stage-ceq'slot1_incomplete_preterminal'){return $files}
    if($Stage-ceq'slot1_incomplete_terminal'){$files+='slots/1/terminal.json';return $files}
    if ($Stage -cin @('slot1_evidence','slot1_terminal','custody')) {
        if ($null -eq $Paths) { throw 'dual_condition_inventory_state' }
        $files += Get-E1EvidenceInventory $Paths 1
    }
    if ($Stage -ceq 'slot1_evidence') { return $files }
    $files += 'slots/1/terminal.json'
    if ($Stage -ceq 'slot1_terminal') { return $files }
    $files += 'custody.json'
    if ($Stage -ceq 'custody') { return $files }
    throw 'dual_condition_inventory_state'
}

function Get-E1SlotPath($Paths, [int]$Ordinal, [string]$Name) {
    if ($Ordinal -notin @(0,1)) { throw 'dual_condition_ordinal' }
    return Join-Path (Join-Path (Join-Path $Paths.root 'slots') ([string]$Ordinal)) $Name
}

function Write-E1ImmutableJson([string]$Path, $Value) {
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'dual_condition_parent_missing' }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 16 -Compress))
    $stream = $null
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
    } finally { if ($null -ne $stream) { $stream.Dispose() } }
    return [ordered]@{ value = $Value; sha256 = Get-E1Sha256Bytes $bytes; bytes = $bytes.Length; path = $Path }
}

function Read-E1Json([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'dual_condition_prerequisite_missing' }
    $bytes = [IO.File]::ReadAllBytes($Path)
    try {
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        $value = $text | ConvertFrom-Json -ErrorAction Stop
    } catch { throw 'dual_condition_artifact_json' }
    if ($null -eq $value -or $value -isnot [pscustomobject]) { throw 'dual_condition_artifact_json' }
    return [ordered]@{ value = $value; sha256 = Get-E1Sha256Bytes $bytes; bytes = $bytes.Length; path = $Path }
}

function Write-Evidence1DualConditionAtomicJson{
    param(
      [Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)]$Value,
      [Parameter(Mandatory)][string]$TrustedRoot,[switch]$TestCrashDuringWrite
    )
    $final=[IO.Path]::GetFullPath($Path);$pending="$final.pending"
    foreach($candidate in @($final,$pending)){$null=Assert-Evidence1DualConditionTrustedPath $candidate $TrustedRoot}
    $parent=Split-Path -Parent $final;$null=New-Item -ItemType Directory -Path $parent -Force
    foreach($candidate in @($parent,$final,$pending)){$null=Assert-Evidence1DualConditionTrustedPath $candidate $TrustedRoot}
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 16 -Compress));$expectedSha=Get-E1Sha256Bytes $bytes
    $recoveredTorn=$false
    if(Test-Path -LiteralPath $final){
      if((Get-E1FileSha256 $final)-cne$expectedSha){throw 'dual_condition_atomic_json_final_corrupt'}
      if(Test-Path -LiteralPath $pending){[IO.File]::Delete($pending);$recoveredTorn=$true}
      return [ordered]@{value=$Value;sha256=$expectedSha;bytes=$bytes.Length;path=$final;state='already-committed';recovered_torn_temp=$recoveredTorn}
    }
    if(Test-Path -LiteralPath $pending){
      if((Get-E1FileSha256 $pending)-cne$expectedSha){[IO.File]::Delete($pending);$recoveredTorn=$true}
    }
    if(-not(Test-Path -LiteralPath $pending)){
      $stream=[IO.FileStream]::new($pending,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough)
      try{
        if($TestCrashDuringWrite){
          $partial=[Math]::Max(1,[Math]::Floor($bytes.Length/2));$stream.Write($bytes,0,$partial);$stream.Flush($true)
          [Diagnostics.Process]::GetCurrentProcess().Kill();throw 'dual_condition_test_crash_failed'
        }
        $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)
      }finally{$stream.Dispose()}
    }
    if((Get-E1FileSha256 $pending)-cne$expectedSha){throw 'dual_condition_atomic_json_pending_hash'}
    try{[IO.File]::Move($pending,$final)}catch{
      if(-not(Test-Path -LiteralPath $final)-or(Get-E1FileSha256 $final)-cne$expectedSha){throw 'dual_condition_atomic_json_claim'}
      if(Test-Path -LiteralPath $pending){[IO.File]::Delete($pending)}
    }
    $null=Assert-Evidence1DualConditionTrustedPath $final $TrustedRoot
    if((Get-E1FileSha256 $final)-cne$expectedSha){throw 'dual_condition_atomic_json_final_hash'}
    return [ordered]@{value=$Value;sha256=$expectedSha;bytes=$bytes.Length;path=$final;state='committed';recovered_torn_temp=$recoveredTorn}
}

function Assert-E1PublicationFiles([object[]]$Files){
    if($Files.Count-lt1-or$Files.Count-gt500){throw 'dual_condition_publication_manifest'}
    $last='';$seen=@{}
    foreach($file in $Files){
      Assert-E1ExactKeys $file $script:PublicationFileKeys
      Assert-E1String $file.relative_path;Assert-E1Hash $file.sha256
      if($file.relative_path-cmatch'(^[\\/]|\\|(^|/)\.\.(/|$)|(^|/)\.(/|$)|:)' -or $file.relative_path-cmatch'(^|/)\.publication\.'){
        throw 'dual_condition_publication_manifest'
      }
      if((($file.size_bytes-isnot[int])-and($file.size_bytes-isnot[long]))-or[long]$file.size_bytes-lt0){throw 'dual_condition_publication_manifest'}
      if($last-and[StringComparer]::Ordinal.Compare($last,$file.relative_path)-ge0){throw 'dual_condition_publication_manifest'}
      if($seen.ContainsKey($file.relative_path)){throw 'dual_condition_publication_manifest'}
      $seen[$file.relative_path]=$true;$last=$file.relative_path
    }
}

function Get-E1PublicationCanonical([string]$DestinationRoot,[string]$Tier,[object[]]$Artifacts){
    if($Tier-cnotin@('public','diagnostic')){throw 'dual_condition_publication_tier'}
    $expanded=@()
    foreach($candidate in @($Artifacts)){if($candidate-is[Array]){$expanded+=@($candidate)}else{$expanded+=,$candidate}}
    $files=@()
    foreach($artifact in $expanded){
      $files+=,[pscustomobject][ordered]@{relative_path=[string]$artifact.relative_path;sha256=[string]$artifact.sha256;size_bytes=[int64]$artifact.size_bytes}
    }
    $files=@($files|Sort-Object -Property relative_path)
    Assert-E1PublicationFiles $files
    $manifestSha=Get-E1Sha256String (ConvertTo-Json -InputObject $files -Depth 6 -Compress)
    $value=[ordered]@{schema=1;kind='dual-condition-publication-transaction';destination_root_sha256=Get-E1NormalizedPathHash $DestinationRoot;
      tier=$Tier;manifest_sha256=$manifestSha;files=$files;state='staging';resume_authorized=$true}
    return [ordered]@{value=$value;manifest_sha256=$manifestSha;files=$files}
}

function Assert-E1PublicationTransaction($Receipt,$Expected){
    Assert-E1ExactKeys $Receipt.value $script:PublicationTransactionKeys
    Assert-E1Integer $Receipt.value.schema 1;Assert-E1String $Receipt.value.kind 'dual-condition-publication-transaction'
    Assert-E1Hash $Receipt.value.destination_root_sha256;Assert-E1Hash $Receipt.value.manifest_sha256
    Assert-E1String $Receipt.value.tier $Expected.value.tier;Assert-E1String $Receipt.value.state 'staging';Assert-E1Bool $Receipt.value.resume_authorized $true
    if($Receipt.value.destination_root_sha256-cne$Expected.value.destination_root_sha256-or$Receipt.value.manifest_sha256-cne$Expected.manifest_sha256){throw 'dual_condition_publication_transaction'}
    $actualFiles=@($Receipt.value.files);Assert-E1PublicationFiles $actualFiles
    if($actualFiles.Count-ne$Expected.files.Count){throw 'dual_condition_publication_transaction'}
    for($i=0;$i-lt$actualFiles.Count;$i++){foreach($name in $script:PublicationFileKeys){if($actualFiles[$i].$name-cne$Expected.files[$i].$name){throw 'dual_condition_publication_transaction'}}}
    $canonicalBytes=[Text.UTF8Encoding]::new($false).GetBytes(($Expected.value|ConvertTo-Json -Depth 16 -Compress))
    if($Receipt.sha256-cne(Get-E1Sha256Bytes $canonicalBytes)){throw 'dual_condition_publication_transaction'}
}

function Assert-E1PublishedTree([string]$Root,[object[]]$Files,[bool]$AllowPartial){
    if(-not(Test-Path -LiteralPath $Root -PathType Container)){throw 'dual_condition_publication_stage_missing'}
    $rootItem=Get-Item -LiteralPath $Root -Force
    if(($rootItem.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'dual_condition_reparse_point'}
    $expected=@{};foreach($file in $Files){$expected[$file.relative_path]=$file}
    $actual=@()
    foreach($item in @(Get-ChildItem -LiteralPath $Root -Recurse -Force)){
      if(($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'dual_condition_reparse_point'}
      if($item.PSIsContainer){continue}
      $relative=$item.FullName.Substring($Root.Length).TrimStart('\','/').Replace('\','/')
      if(-not$expected.ContainsKey($relative)){throw 'dual_condition_publication_inventory'}
      $actual+=$relative
      if((Get-E1FileSha256 $item.FullName)-cne$expected[$relative].sha256){
        if(-not$AllowPartial){throw 'dual_condition_publication_destination_hash'}
        [IO.File]::Delete($item.FullName);$actual=@($actual|Where-Object{$_-cne$relative})
      }
    }
    if(-not$AllowPartial-and$actual.Count-ne$Files.Count){throw 'dual_condition_publication_inventory'}
    return @($actual)
}

function Publish-Evidence1DualConditionArtifactSet{
    param(
      [Parameter(Mandatory)][string]$SourceRoot,[Parameter(Mandatory)][string]$DestinationRoot,
      [Parameter(Mandatory)][string]$TrustedRoot,
      [Parameter(Mandatory)][ValidateSet('public','diagnostic')][string]$Tier,
      [Parameter(Mandatory)][object[]]$Artifacts,[ValidateRange(0,500)][int]$TestCrashAfterFiles=0,
      [ValidateSet('none','transaction','ready')][string]$TestCrashPoint='none'
    )
    $source=[IO.Path]::GetFullPath($SourceRoot).TrimEnd('\','/');$destination=[IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\','/')
    if(-not(Test-Path -LiteralPath $source -PathType Container)-or[string]::IsNullOrWhiteSpace((Split-Path -Leaf $destination))){throw 'dual_condition_publication_root'}
    $stage="$destination.staging";$transactionPath="$destination.publication.transaction.json";$readyPath="$destination.publication.ready.json"
    foreach($path in @($destination,$stage,$transactionPath,$readyPath)){$null=Assert-Evidence1DualConditionTrustedPath $path $TrustedRoot}
    $parent=Split-Path -Parent $destination;$null=New-Item -ItemType Directory -Path $parent -Force
    foreach($path in @($parent,$destination,$stage,$transactionPath,$readyPath)){$null=Assert-Evidence1DualConditionTrustedPath $path $TrustedRoot}
    $expected=Get-E1PublicationCanonical $destination $Tier $Artifacts
    $transaction=Write-Evidence1DualConditionAtomicJson -Path $transactionPath -Value $expected.value -TrustedRoot $TrustedRoot -TestCrashDuringWrite:($TestCrashPoint-ceq'transaction')
    Assert-E1PublicationTransaction $transaction $expected
    $recoveredTornCount=$(if($transaction.recovered_torn_temp){1}else{0})
    $readyValue=[ordered]@{schema=1;kind='dual-condition-publication-ready';transaction_sha256=$transaction.sha256;
      manifest_sha256=$expected.manifest_sha256;state='ready-for-atomic-rename'}
    $ready=$null
    if(Test-Path -LiteralPath $readyPath){
      $ready=Write-Evidence1DualConditionAtomicJson -Path $readyPath -Value $readyValue -TrustedRoot $TrustedRoot
      if($ready.recovered_torn_temp){$recoveredTornCount++}
      Assert-E1ExactKeys $ready.value $script:PublicationReadyKeys
      Assert-E1Integer $ready.value.schema 1;Assert-E1String $ready.value.kind 'dual-condition-publication-ready'
      if($ready.value.transaction_sha256-cne$transaction.sha256-or$ready.value.manifest_sha256-cne$expected.manifest_sha256){throw 'dual_condition_publication_ready'}
      Assert-E1String $ready.value.state 'ready-for-atomic-rename'
    }
    if(Test-Path -LiteralPath $destination){
      if(Test-Path -LiteralPath $stage){throw 'dual_condition_publication_state'}
      if($null-eq$ready){throw 'dual_condition_publication_ready'}
      $null=Assert-E1PublishedTree $destination $expected.files $false
      return [ordered]@{state='already-committed';files=$expected.files.Count;manifest_sha256=$expected.manifest_sha256;transaction_sha256=$transaction.sha256;recovered_torn_json_count=$recoveredTornCount}
    }
    if(-not(Test-Path -LiteralPath $stage)){$null=New-Item -ItemType Directory -Path $stage}
    $null=Assert-Evidence1DualConditionTrustedPath $stage $TrustedRoot
    $null=Assert-E1PublishedTree $stage $expected.files $true
    $copied=0
    foreach($file in $expected.files){
      $sourcePath=Join-Path $source ($file.relative_path-replace'/','\');$destinationPath=Join-Path $stage ($file.relative_path-replace'/','\')
      if(-not(Test-Path -LiteralPath $sourcePath -PathType Leaf)-or(Get-E1FileSha256 $sourcePath)-cne$file.sha256-or(Get-Item -LiteralPath $sourcePath -Force).Length-ne$file.size_bytes){throw 'dual_condition_publication_source_hash'}
      if(Test-Path -LiteralPath $destinationPath){continue}
      $null=Copy-Evidence1DualConditionPublicArtifact $sourcePath $destinationPath $file.sha256;$copied++
      if($TestCrashAfterFiles-gt0-and$copied-ge$TestCrashAfterFiles){[Diagnostics.Process]::GetCurrentProcess().Kill();throw 'dual_condition_test_crash_failed'}
    }
    $null=Assert-E1PublishedTree $stage $expected.files $false
    if($null-eq$ready){
      $ready=Write-Evidence1DualConditionAtomicJson -Path $readyPath -Value $readyValue -TrustedRoot $TrustedRoot -TestCrashDuringWrite:($TestCrashPoint-ceq'ready')
      if($ready.recovered_torn_temp){$recoveredTornCount++}
    }
    [IO.Directory]::Move($stage,$destination)
    $null=Assert-Evidence1DualConditionTrustedPath $destination $TrustedRoot
    $null=Assert-E1PublishedTree $destination $expected.files $false
    return [ordered]@{state='committed';files=$expected.files.Count;manifest_sha256=$expected.manifest_sha256;transaction_sha256=$transaction.sha256;recovered_torn_json_count=$recoveredTornCount}
}

function Get-E1ArmContract([string]$Arm) {
    if ($Arm -ceq 'product') {
        return [ordered]@{
            condition = 'current-skill'; product_access_mode = 'product-assisted'; runtime_order = @('claude-code','codex-cli')
            authorization_scope_id = 'evidence1-dual-runtime-windows-canary-product-v1'
            expected_skill_available = $true; expected_snapshot_binding = $true
            claude_design = 'claude-product-canary-v1'; codex_design = 'codex-product-canary-v1'
        }
    }
    if ($Arm -ceq 'free-baseline') {
        return [ordered]@{
            condition = 'no-skill'; product_access_mode = 'free-baseline-no-product'; runtime_order = @('codex-cli','claude-code')
            authorization_scope_id = 'evidence1-dual-runtime-windows-canary-free-baseline-v1'
            expected_skill_available = $false; expected_snapshot_binding = $false
            claude_design = 'claude-free-baseline-canary-v1'; codex_design = 'codex-free-baseline-canary-v1'
        }
    }
    throw 'dual_condition_arm'
}

function New-E1Slot($Contract, [string]$GroupRunId, [int]$Ordinal, [string]$RuntimeId,
    [string]$SourceCommit, [string]$SourceTree, [int]$Timeout,
    [string]$ClaudePlan, [string]$CodexPlan, [string]$ClaudeAttestation, [string]$CodexAttestation) {
    $claude = $RuntimeId -ceq 'claude-code'
    return [ordered]@{
        ordinal = $Ordinal; slot_id = "$GroupRunId-$Ordinal-$RuntimeId"; runtime_id = $RuntimeId
        cli_version = $(if ($claude) { '2.1.238' } else { '0.154.0' })
        model_requested = $(if ($claude) { 'claude-sonnet-5' } else { 'gpt-5.6-terra' })
        model_resolved = $(if ($claude) { 'claude-sonnet-5' } else { 'gpt-5.6-terra' })
        campaign_design_id = $(if ($claude) { $Contract.claude_design } else { $Contract.codex_design })
        condition = $Contract.condition; product_access_mode = $Contract.product_access_mode
        scenario_id = 'coverage-threshold-failure-v2'; seed = 20260821
        execution_profile_id = 'sandboxed-unrestricted-v1'; source_commit = $SourceCommit; source_tree = $SourceTree
        process_timeout_seconds = $Timeout; session_budget_usd = $(if ($claude) { 2 } else { $null })
        session_budget_reason = $(if ($claude) { $null } else { 'runtime_does_not_support_session_budget' })
        plan_sha256 = $(if ($claude) { $ClaudePlan } else { $CodexPlan })
        isolation_attestation_sha256 = $(if ($claude) { $ClaudeAttestation } else { $CodexAttestation })
        expected_skill_available = $Contract.expected_skill_available; expected_snapshot_binding = $Contract.expected_snapshot_binding
    }
}

function New-Evidence1DualConditionCanaryBinding {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('product','free-baseline')][string]$Arm,
        [Parameter(Mandatory)][string]$LedgerRoot,
        [Parameter(Mandatory)][string]$PairId, [Parameter(Mandatory)][string]$GroupRunId,
        [Parameter(Mandatory)][string]$HarnessCommit, [Parameter(Mandatory)][string]$HarnessTree,
        [Parameter(Mandatory)][string]$SourceCommit, [Parameter(Mandatory)][string]$SourceTree,
        [AllowNull()][string]$SkillSnapshotSha256 = $null,
        [Parameter(Mandatory)][string]$ClaudePlanSha256, [Parameter(Mandatory)][string]$CodexPlanSha256,
        [Parameter(Mandatory)][string]$ClaudeAttestationSha256, [Parameter(Mandatory)][string]$CodexAttestationSha256,
        $ValidatorBundleManifest = $null,
        [Parameter(Mandatory)][ValidateRange(1,10080)][int]$RemoteAuthMaxAgeMinutes,
        [ValidateRange(1,86400)][int]$ProcessTimeoutSeconds = 1800
    )
    Assert-E1Guid $PairId; Assert-E1Guid $GroupRunId
    if ($PairId -ceq $GroupRunId) { throw 'dual_condition_identity' }
    foreach ($sha in @($HarnessCommit,$HarnessTree,$SourceCommit,$SourceTree)) { Assert-E1GitSha $sha }
    foreach ($hash in @($ClaudePlanSha256,$CodexPlanSha256,
        $ClaudeAttestationSha256,$CodexAttestationSha256)) { Assert-E1Hash $hash }
    $contract = Get-E1ArmContract $Arm
    if($null-eq$ValidatorBundleManifest){
      $defaultHarnessRoot=[IO.Path]::GetFullPath((Join-Path (Join-Path $PSScriptRoot '..') '..'))
      $ValidatorBundleManifest=Get-Evidence1DualConditionValidatorBundleManifest $defaultHarnessRoot
    }
    $null=Assert-Evidence1DualConditionValidatorBundleManifest $ValidatorBundleManifest
    $snapshot = $(if ($PSBoundParameters.ContainsKey('SkillSnapshotSha256')) { $SkillSnapshotSha256 } else { $null })
    if ($Arm -ceq 'product') { Assert-E1Hash $snapshot } elseif ($null -ne $snapshot) { throw 'dual_condition_skill_snapshot' }
    $slots = @()
    for ($ordinal = 0; $ordinal -lt 2; $ordinal++) {
        $slots += New-E1Slot $contract $GroupRunId $ordinal $contract.runtime_order[$ordinal] $SourceCommit $SourceTree `
            $ProcessTimeoutSeconds $ClaudePlanSha256 $CodexPlanSha256 $ClaudeAttestationSha256 $CodexAttestationSha256
    }
    $binding = [ordered]@{
        schema = 2; kind = 'dual-runtime-condition-canary'; pair_id = $PairId; group_run_id = $GroupRunId
        arm = $Arm; condition = $contract.condition; product_access_mode = $contract.product_access_mode
        scenario_id = 'coverage-threshold-failure-v2'; seed = 20260821; execution_profile_id = 'sandboxed-unrestricted-v1'
        harness_commit = $HarnessCommit; harness_tree = $HarnessTree; source_commit = $SourceCommit; source_tree = $SourceTree
        ledger_root_sha256 = Get-E1NormalizedPathHash $LedgerRoot
        planned_sessions = 2; runtime_order = @($contract.runtime_order); authorization_scope_id = $contract.authorization_scope_id
        skill_snapshot_sha256 = $(if ($Arm -ceq 'product') { $snapshot } else { $null })
        skill_snapshot_reason = $(if ($Arm -ceq 'product') { $null } else { 'condition-no-skill' })
        common_process_timeout_seconds = $ProcessTimeoutSeconds; remote_auth_max_age_minutes = $RemoteAuthMaxAgeMinutes
        retry_limit = 0; benchmark_eligible = $false
        validator_bundle = $ValidatorBundleManifest; slots = $slots
    }
    $null = Assert-Evidence1DualConditionCanaryBinding $binding
    return $binding
}

function Assert-Evidence1DualConditionCanaryBinding {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Binding)
    Assert-E1ExactKeys $Binding $script:BindingKeys
    Assert-E1Integer (Get-E1Field $Binding 'schema') 2; Assert-E1String (Get-E1Field $Binding 'kind') 'dual-runtime-condition-canary'
    $pairId = Get-E1Field $Binding 'pair_id'; Assert-E1Guid $pairId
    $groupId = Get-E1Field $Binding 'group_run_id'; Assert-E1Guid $groupId
    if ($pairId -ceq $groupId) { throw 'dual_condition_identity' }
    $arm = Get-E1Field $Binding 'arm'; $contract = Get-E1ArmContract $arm
    foreach ($pair in @(
        @('condition',$contract.condition), @('product_access_mode',$contract.product_access_mode),
        @('scenario_id','coverage-threshold-failure-v2'), @('execution_profile_id','sandboxed-unrestricted-v1'),
        @('authorization_scope_id',$contract.authorization_scope_id)
    )) { Assert-E1String (Get-E1Field $Binding $pair[0]) $pair[1] }
    Assert-E1Integer (Get-E1Field $Binding 'seed') 20260821
    foreach ($name in @('harness_commit','harness_tree','source_commit','source_tree')) { Assert-E1GitSha (Get-E1Field $Binding $name) }
    Assert-E1Hash (Get-E1Field $Binding 'ledger_root_sha256')
    Assert-E1Integer (Get-E1Field $Binding 'planned_sessions') 2; Assert-E1Integer (Get-E1Field $Binding 'retry_limit') 0
    Assert-E1Bool (Get-E1Field $Binding 'benchmark_eligible') $false
    $null=Assert-Evidence1DualConditionValidatorBundleManifest (Get-E1Field $Binding 'validator_bundle')
    $timeout = Get-E1Field $Binding 'common_process_timeout_seconds'
    if ((($timeout -isnot [int]) -and ($timeout -isnot [long])) -or $timeout -lt 1 -or $timeout -gt 86400) { throw 'dual_condition_shape' }
    $authMaxAge = Get-E1Field $Binding 'remote_auth_max_age_minutes'
    if ((($authMaxAge -isnot [int]) -and ($authMaxAge -isnot [long])) -or $authMaxAge -lt 1 -or $authMaxAge -gt 10080) { throw 'dual_condition_shape' }
    $order = @(Get-E1Field $Binding 'runtime_order')
    if ($order.Count -ne 2 -or $order[0] -cne $contract.runtime_order[0] -or $order[1] -cne $contract.runtime_order[1]) { throw 'dual_condition_runtime_order' }
    $snapshot = Get-E1Field $Binding 'skill_snapshot_sha256'; $snapshotReason = Get-E1Field $Binding 'skill_snapshot_reason'
    if ($arm -ceq 'product') { Assert-E1Hash $snapshot; if ($null -ne $snapshotReason) { throw 'dual_condition_skill_snapshot' } }
    elseif ($null -ne $snapshot -or $snapshotReason -cne 'condition-no-skill') { throw 'dual_condition_skill_snapshot' }
    $slots = @(Get-E1Field $Binding 'slots'); if ($slots.Count -ne 2) { throw 'dual_condition_slots' }
    $seen = @{}
    for ($ordinal = 0; $ordinal -lt 2; $ordinal++) {
        $slot = $slots[$ordinal]; Assert-E1ExactKeys $slot $script:SlotKeys
        Assert-E1Integer (Get-E1Field $slot 'ordinal') $ordinal
        $runtime = Get-E1Field $slot 'runtime_id'; Assert-E1String $runtime $order[$ordinal]
        if ($seen.ContainsKey($runtime)) { throw 'dual_condition_slots' }; $seen[$runtime] = $true
        Assert-E1String (Get-E1Field $slot 'slot_id') "$groupId-$ordinal-$runtime"
        $claude = $runtime -ceq 'claude-code'
        Assert-E1String (Get-E1Field $slot 'cli_version') $(if ($claude) { '2.1.238' } else { '0.154.0' })
        Assert-E1String (Get-E1Field $slot 'model_requested') $(if ($claude) { 'claude-sonnet-5' } else { 'gpt-5.6-terra' })
        Assert-E1String (Get-E1Field $slot 'model_resolved') $(if ($claude) { 'claude-sonnet-5' } else { 'gpt-5.6-terra' })
        Assert-E1String (Get-E1Field $slot 'campaign_design_id') $(if ($claude) { $contract.claude_design } else { $contract.codex_design })
        foreach ($name in @('condition','product_access_mode','scenario_id','seed','execution_profile_id','source_commit','source_tree')) {
            if ((Get-E1Field $slot $name) -cne (Get-E1Field $Binding $name)) { throw 'dual_condition_common_axes' }
        }
        if ((Get-E1Field $slot 'process_timeout_seconds') -cne $timeout) { throw 'dual_condition_common_axes' }
        if ($claude) {
            Assert-E1Integer (Get-E1Field $slot 'session_budget_usd') 2
            if ($null -ne (Get-E1Field $slot 'session_budget_reason')) { throw 'dual_condition_budget' }
        } elseif ($null -ne (Get-E1Field $slot 'session_budget_usd') -or
            (Get-E1Field $slot 'session_budget_reason') -cne 'runtime_does_not_support_session_budget') { throw 'dual_condition_budget' }
        Assert-E1Hash (Get-E1Field $slot 'plan_sha256'); Assert-E1Hash (Get-E1Field $slot 'isolation_attestation_sha256')
        Assert-E1Bool (Get-E1Field $slot 'expected_skill_available') $contract.expected_skill_available
        Assert-E1Bool (Get-E1Field $slot 'expected_snapshot_binding') $contract.expected_snapshot_binding
    }
    if ($seen.Count -ne 2 -or -not $seen.ContainsKey('claude-code') -or -not $seen.ContainsKey('codex-cli')) { throw 'dual_condition_slots' }
    return $true
}

function Read-E1Binding([string]$OperationRoot) {
    $paths = Get-E1Paths $OperationRoot; $receipt = Read-E1Json $paths.binding
    $null = Assert-Evidence1DualConditionCanaryBinding $receipt.value
    Assert-E1OperationRootBinding $paths.root $receipt.value
    return $receipt
}

function Write-Evidence1DualConditionCanaryBinding {
    param([Parameter(Mandatory)][string]$OperationRoot, [Parameter(Mandatory)]$Binding)
    $null = Assert-Evidence1DualConditionCanaryBinding $Binding; $paths = Get-E1Paths $OperationRoot
    if (@(Get-ChildItem -LiteralPath $paths.root -Force).Count -ne 0) { throw 'dual_condition_operation_root_not_empty' }
    $null = [IO.Directory]::CreateDirectory((Join-Path $paths.root 'slots'))
    $null = [IO.Directory]::CreateDirectory((Join-Path (Join-Path $paths.root 'slots') '0'))
    $null = [IO.Directory]::CreateDirectory((Join-Path (Join-Path $paths.root 'slots') '1'))
    $null = [IO.Directory]::CreateDirectory((Join-Path (Join-Path (Join-Path $paths.root 'slots') '0') 'audit'))
    $null = [IO.Directory]::CreateDirectory((Join-Path (Join-Path (Join-Path $paths.root 'slots') '1') 'audit'))
    Assert-E1OperationRootBinding $paths.root $Binding
    $receipt = Write-E1ImmutableJson $paths.binding $Binding
    Assert-E1Inventory $paths @('binding.json')
    return $receipt
}

function Get-E1PairComparison($Binding){
    $claude=@($Binding.slots|Where-Object runtime_id -CEQ 'claude-code');$codex=@($Binding.slots|Where-Object runtime_id -CEQ 'codex-cli')
    if($claude.Count-ne1-or$codex.Count-ne1){throw 'dual_condition_pair'}
    $value=[ordered]@{pair_id=$Binding.pair_id;harness_commit=$Binding.harness_commit;harness_tree=$Binding.harness_tree;
      source_commit=$Binding.source_commit;source_tree=$Binding.source_tree;common_process_timeout_seconds=$Binding.common_process_timeout_seconds;
      remote_auth_max_age_minutes=$Binding.remote_auth_max_age_minutes;
      scenario_id=$Binding.scenario_id;seed=$Binding.seed;execution_profile_id=$Binding.execution_profile_id;
      ledger_root_sha256=$Binding.ledger_root_sha256;claude_attestation_sha256=$claude[0].isolation_attestation_sha256;
      codex_attestation_sha256=$codex[0].isolation_attestation_sha256;validator_bundle_sha256=$Binding.validator_bundle.bundle_sha256}
    return [ordered]@{value=$value;sha256=Get-E1Sha256String ($value|ConvertTo-Json -Depth 5 -Compress)}
}

function Get-E1PairClaimRoot([string]$OperationRoot,$Binding){
    $group=[IO.DirectoryInfo]::new([IO.Path]::GetFullPath($OperationRoot));$ledger=$group.Parent.Parent.Parent
    if($null-eq$ledger-or(Get-E1NormalizedPathHash $ledger.FullName)-cne$Binding.ledger_root_sha256){throw 'dual_condition_pair'}
    return Join-Path (Join-Path $ledger.FullName 'pairs') $Binding.pair_id
}

function Assert-E1PairArmClaim($Claim,$BindingReceipt){
    Assert-E1ExactKeys $Claim $script:PairArmClaimKeys;Assert-E1Integer $Claim.schema 1;Assert-E1String $Claim.kind 'dual-condition-pair-arm-claim'
    foreach($name in @('pair_id','arm','group_run_id')){Assert-E1String $Claim.$name $BindingReceipt.value.$name}
    if($Claim.binding_sha256-cne$BindingReceipt.sha256){throw 'dual_condition_pair'}
    $comparison=Get-E1PairComparison $BindingReceipt.value
    foreach($name in @('comparison_sha256','claude_attestation_sha256','codex_attestation_sha256','validator_bundle_sha256')){Assert-E1Hash $Claim.$name}
    if($Claim.comparison_sha256-cne$comparison.sha256-or$Claim.claude_attestation_sha256-cne$comparison.value.claude_attestation_sha256-or
      $Claim.codex_attestation_sha256-cne$comparison.value.codex_attestation_sha256-or$Claim.validator_bundle_sha256-cne$comparison.value.validator_bundle_sha256){throw 'dual_condition_pair_drift'}
    Assert-E1String $Claim.state 'claimed';Assert-E1Bool $Claim.retry_authorized $false
}

function New-Evidence1DualConditionCanaryPairArmClaim{
    param([Parameter(Mandatory)][string]$OperationRoot)
    $paths=Get-E1Paths $OperationRoot
    $stage=$(if(Test-Path -LiteralPath $paths.authorization){'authorization'}else{'binding'})
    Assert-E1Inventory $paths (Get-E1InventoryFiles $stage)
    $binding=Read-E1Binding $OperationRoot;$comparison=Get-E1PairComparison $binding.value
    $pairRoot=Get-E1PairClaimRoot $OperationRoot $binding.value
    $null=[IO.Directory]::CreateDirectory($pairRoot)
    $item=Get-Item -LiteralPath $pairRoot -Force
    if(($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'dual_condition_reparse_point'}
    $claim=[ordered]@{schema=1;kind='dual-condition-pair-arm-claim';pair_id=$binding.value.pair_id;arm=$binding.value.arm;
      group_run_id=$binding.value.group_run_id;binding_sha256=$binding.sha256;comparison_sha256=$comparison.sha256;
      claude_attestation_sha256=$comparison.value.claude_attestation_sha256;codex_attestation_sha256=$comparison.value.codex_attestation_sha256;
      validator_bundle_sha256=$comparison.value.validator_bundle_sha256;state='claimed';retry_authorized=$false}
    Assert-E1PairArmClaim $claim $binding
    return Write-E1ImmutableJson (Join-Path $pairRoot "$($binding.value.arm).claim.json") $claim
}

function Assert-Evidence1DualConditionCanaryPair {
    param([string]$ProductOperationRoot='',[string]$BaselineOperationRoot='',[string]$OperationRoot='')
    if($OperationRoot){
      $binding=Read-E1Binding $OperationRoot;$pairRoot=Get-E1PairClaimRoot $OperationRoot $binding.value
      $files=@(Get-ChildItem -LiteralPath $pairRoot -File -Filter '*.claim.json' -Force)
      if($files.Count-lt1-or$files.Count-gt2-or@($files|Where-Object{$_.Name-cnotin@('product.claim.json','free-baseline.claim.json')}).Count-ne0){throw 'dual_condition_pair_cardinality'}
      $claims=@{}
      foreach($file in $files){$receipt=Read-E1Json $file.FullName;$arm=[string]$receipt.value.arm;if($claims.ContainsKey($arm)){throw 'dual_condition_pair_cardinality'};$claims[$arm]=$receipt}
      if(-not$claims.ContainsKey($binding.value.arm)){throw 'dual_condition_pair'}
      Assert-E1PairArmClaim $claims[$binding.value.arm].value $binding
      if($claims.Count-eq2){
        if(-not$claims.ContainsKey('product')-or-not$claims.ContainsKey('free-baseline')){throw 'dual_condition_pair_cardinality'}
        if($claims.product.value.comparison_sha256-cne$claims.'free-baseline'.value.comparison_sha256){throw 'dual_condition_pair_drift'}
      }
      return [ordered]@{pair_id=$binding.value.pair_id;current_arm=$binding.value.arm;claimed_arms=@($claims.Keys|Sort-Object);complete=$claims.Count-eq2;validated=$true}
    }
    if(-not$ProductOperationRoot-or-not$BaselineOperationRoot){throw 'dual_condition_pair'}
    Assert-E1Inventory (Get-E1Paths $ProductOperationRoot) (Get-E1InventoryFiles 'binding')
    Assert-E1Inventory (Get-E1Paths $BaselineOperationRoot) (Get-E1InventoryFiles 'binding')
    $productReceipt = Read-E1Binding $ProductOperationRoot; $baselineReceipt = Read-E1Binding $BaselineOperationRoot
    $product = $productReceipt.value; $baseline = $baselineReceipt.value
    if ($product.arm -cne 'product' -or $baseline.arm -cne 'free-baseline' -or $product.pair_id -cne $baseline.pair_id -or
        $product.group_run_id -ceq $baseline.group_run_id) { throw 'dual_condition_pair' }
    foreach ($name in @('harness_commit','harness_tree','source_commit','source_tree',
        'common_process_timeout_seconds','remote_auth_max_age_minutes','scenario_id','seed','execution_profile_id','ledger_root_sha256')) {
        if ((Get-E1Field $product $name) -cne (Get-E1Field $baseline $name)) { throw 'dual_condition_pair_drift' }
    }
    if((Get-E1PairComparison $product).sha256-cne(Get-E1PairComparison $baseline).sha256){throw 'dual_condition_pair_drift'}
    return [ordered]@{
        pair_id = $product.pair_id; product_group_run_id = $product.group_run_id; baseline_group_run_id = $baseline.group_run_id
        product_binding_sha256 = $productReceipt.sha256; baseline_binding_sha256 = $baselineReceipt.sha256; validated = $true
    }
}

function Get-E1AuthorizationLiteral($Binding, [string]$BindingSha256) {
    $order = @($Binding.runtime_order) -join ' -> '; $armLabel = $(if ($Binding.arm -ceq 'product') { 'PRODUCT' } else { 'FREE-BASELINE' })
    return "AUTORIZO EXACTAMENTE 2 SESIONES LIVE NUEVAS DEL Evidence1 DUAL-RUNTIME WINDOWS CANARY $armLabel PARA PAIR $($Binding.pair_id), GROUP $($Binding.group_run_id), EN ORDEN $order; SIN REINTENTOS, REEMPLAZOS NI RESPAWNS"
}

function Get-Evidence1DualConditionCanaryAuthorizationLiteral {
    param([Parameter(Mandatory)][string]$OperationRoot)
    $paths = Get-E1Paths $OperationRoot; Assert-E1Inventory $paths (Get-E1InventoryFiles 'binding')
    $binding = Read-E1Binding $OperationRoot
    return Get-E1AuthorizationLiteral $binding.value $binding.sha256
}

function Assert-E1Authorization($Value, $BindingReceipt) {
    Assert-E1ExactKeys $Value $script:AuthorizationKeys
    Assert-E1Integer $Value.schema 1; Assert-E1String $Value.kind 'dual-condition-authorization-claim'
    Assert-E1String $Value.pair_id $BindingReceipt.value.pair_id; Assert-E1String $Value.group_run_id $BindingReceipt.value.group_run_id
    Assert-E1Hash $Value.binding_sha256
    if ($Value.binding_sha256 -cne $BindingReceipt.sha256) { throw 'dual_condition_binding_hash_mismatch' }
    Assert-E1String $Value.authorization_scope_id $BindingReceipt.value.authorization_scope_id; Assert-E1Hash $Value.authorization_sha256
    $expected = Get-E1Sha256String (Get-E1AuthorizationLiteral $BindingReceipt.value $BindingReceipt.sha256)
    if ($Value.authorization_sha256 -cne $expected) { throw 'dual_condition_authorization_replay' }
    Assert-E1Integer $Value.planned_sessions 2; Assert-E1Integer $Value.retry_limit 0
}

function Read-E1Authorization([string]$OperationRoot, $BindingReceipt) {
    $paths = Get-E1Paths $OperationRoot; $receipt = Read-E1Json $paths.authorization
    Assert-E1Authorization $receipt.value $BindingReceipt
    return $receipt
}

function New-Evidence1DualConditionCanaryAuthorizationClaim {
    param([Parameter(Mandatory)][string]$OperationRoot, [Parameter(Mandatory)][string]$Phrase)
    $paths = Get-E1Paths $OperationRoot; Assert-E1Inventory $paths (Get-E1InventoryFiles 'binding')
    $binding = Read-E1Binding $OperationRoot
    $expected = Get-E1AuthorizationLiteral $binding.value $binding.sha256
    if ($Phrase -cne $expected) { throw 'dual_condition_authorization_required' }
    $claim = [ordered]@{
        schema = 1; kind = 'dual-condition-authorization-claim'; pair_id = $binding.value.pair_id
        group_run_id = $binding.value.group_run_id; binding_sha256 = $binding.sha256
        authorization_scope_id = $binding.value.authorization_scope_id; authorization_sha256 = Get-E1Sha256String $Phrase
        planned_sessions = 2; retry_limit = 0
    }
    Assert-E1Authorization $claim $binding
    $receipt = Write-E1ImmutableJson $paths.authorization $claim
    Assert-E1Inventory $paths (Get-E1InventoryFiles 'authorization')
    return $receipt
}

function Assert-E1GroupClaim($Value, $BindingReceipt, $AuthorizationReceipt) {
    Assert-E1ExactKeys $Value $script:GroupClaimKeys
    Assert-E1Integer $Value.schema 1; Assert-E1String $Value.kind 'dual-condition-group-claim'
    Assert-E1String $Value.pair_id $BindingReceipt.value.pair_id; Assert-E1String $Value.group_run_id $BindingReceipt.value.group_run_id
    Assert-E1Hash $Value.binding_sha256; Assert-E1Hash $Value.authorization_claim_sha256
    if ($Value.binding_sha256 -cne $BindingReceipt.sha256 -or $Value.authorization_claim_sha256 -cne $AuthorizationReceipt.sha256) { throw 'dual_condition_claim_chain' }
    Assert-E1String $Value.authorization_scope_id $BindingReceipt.value.authorization_scope_id
    Assert-E1String $Value.state 'group_claimed'; Assert-E1Integer $Value.planned_sessions 2; Assert-E1Integer $Value.retry_limit 0
}

function Read-E1GroupClaim([string]$OperationRoot, $BindingReceipt) {
    $paths = Get-E1Paths $OperationRoot; $authorization = Read-E1Authorization $OperationRoot $BindingReceipt
    $receipt = Read-E1Json $paths.group_claim; Assert-E1GroupClaim $receipt.value $BindingReceipt $authorization
    return $receipt
}

function New-Evidence1DualConditionCanaryGroupClaim {
    param([Parameter(Mandatory)][string]$OperationRoot)
    $paths = Get-E1Paths $OperationRoot; Assert-E1Inventory $paths (Get-E1InventoryFiles 'authorization')
    $binding = Read-E1Binding $OperationRoot; $authorization = Read-E1Authorization $OperationRoot $binding
    $claim = [ordered]@{
        schema = 1; kind = 'dual-condition-group-claim'; pair_id = $binding.value.pair_id
        group_run_id = $binding.value.group_run_id; binding_sha256 = $binding.sha256
        authorization_claim_sha256 = $authorization.sha256; authorization_scope_id = $binding.value.authorization_scope_id
        state = 'group_claimed'; planned_sessions = 2; retry_limit = 0
    }
    Assert-E1GroupClaim $claim $binding $authorization
    $receipt = Write-E1ImmutableJson $paths.group_claim $claim
    Assert-E1Inventory $paths (Get-E1InventoryFiles 'group')
    return $receipt
}

function Assert-E1Integrity($Value, $BindingReceipt, $TerminalReceipt) {
    Assert-E1ExactKeys $Value $script:IntegrityKeys
    Assert-E1Integer $Value.schema 1; Assert-E1String $Value.kind 'dual-condition-inter-slot-integrity'
    Assert-E1String $Value.pair_id $BindingReceipt.value.pair_id; Assert-E1String $Value.group_run_id $BindingReceipt.value.group_run_id
    if ($Value.binding_sha256 -cne $BindingReceipt.sha256 -or $Value.slot_terminal_sha256 -cne $TerminalReceipt.sha256) { throw 'dual_condition_claim_chain' }
    foreach ($name in @('slot_id','ordinal','runtime_id')) { if ($Value.$name -cne $TerminalReceipt.value.$name) { throw 'dual_condition_claim_chain' } }
    Assert-E1String $Value.terminal_state $TerminalReceipt.value.state
    $dispatch = $TerminalReceipt.value.integrity_status -ceq 'passed' -and $TerminalReceipt.value.state -cin @('completed','functional_failed')
    if ($Value.dispatch_next_slot -isnot [bool] -or $Value.dispatch_next_slot -ne $dispatch) { throw 'dual_condition_integrity_decision' }
    Assert-E1String $Value.integrity_status $TerminalReceipt.value.integrity_status
    Assert-E1String $Value.decision $(if ($dispatch) { 'continue_once' } else { 'safety_stop' })
    if ($dispatch) { if ($null -ne $Value.reason_code) { throw 'dual_condition_integrity_decision' } }
    else { Assert-E1String $Value.reason_code $TerminalReceipt.value.reason_code }
    Assert-E1Bool $Value.retry_authorized $false
}

function Assert-E1SlotClaim($Value, $BindingReceipt, [int]$Ordinal, [string]$PrerequisiteKind, $PrerequisiteReceipt) {
    Assert-E1ExactKeys $Value $script:SlotClaimKeys; $slot = @($BindingReceipt.value.slots)[$Ordinal]
    Assert-E1Integer $Value.schema 1; Assert-E1String $Value.kind 'dual-condition-slot-claim'
    Assert-E1String $Value.pair_id $BindingReceipt.value.pair_id; Assert-E1String $Value.group_run_id $BindingReceipt.value.group_run_id
    if ($Value.binding_sha256 -cne $BindingReceipt.sha256) { throw 'dual_condition_binding_hash_mismatch' }
    Assert-E1String $Value.slot_id $slot.slot_id; Assert-E1Integer $Value.ordinal $Ordinal; Assert-E1String $Value.runtime_id $slot.runtime_id
    Assert-E1String $Value.prerequisite_kind $PrerequisiteKind
    if ($Value.prerequisite_sha256 -cne $PrerequisiteReceipt.sha256) { throw 'dual_condition_claim_chain' }
    Assert-E1Integer $Value.attempt_number 1; Assert-E1Bool $Value.retry_authorized $false
}

function Read-E1Integrity([string]$OperationRoot, $BindingReceipt, $TerminalReceipt) {
    $paths = Get-E1Paths $OperationRoot; $receipt = Read-E1Json $paths.integrity
    Assert-E1Integrity $receipt.value $BindingReceipt $TerminalReceipt
    return $receipt
}

function Read-E1SlotClaim([string]$OperationRoot, $BindingReceipt, [int]$Ordinal) {
    $paths = Get-E1Paths $OperationRoot
    if ($Ordinal -eq 0) { $prerequisite = Read-E1GroupClaim $OperationRoot $BindingReceipt; $kind = 'group-claim' }
    else {
        $terminal0 = Read-E1Terminal $OperationRoot $BindingReceipt 0
        $prerequisite = Read-E1Integrity $OperationRoot $BindingReceipt $terminal0; $kind = 'inter-slot-integrity'
        if (-not $prerequisite.value.dispatch_next_slot) { throw 'dual_condition_safety_stop' }
    }
    $receipt = Read-E1Json (Get-E1SlotPath $paths $Ordinal 'claim.json')
    Assert-E1SlotClaim $receipt.value $BindingReceipt $Ordinal $kind $prerequisite
    return $receipt
}

function New-Evidence1DualConditionCanarySlotClaim {
    param([Parameter(Mandatory)][string]$OperationRoot, [Parameter(Mandatory)][ValidateRange(0,1)][int]$Ordinal)
    $paths = Get-E1Paths $OperationRoot
    Assert-E1Inventory $paths (Get-E1InventoryFiles $(if ($Ordinal -eq 0) { 'group' } else { 'integrity' }) $paths)
    $binding = Read-E1Binding $OperationRoot
    if ($Ordinal -eq 0) { $prerequisite = Read-E1GroupClaim $OperationRoot $binding; $kind = 'group-claim' }
    else {
        $terminal0 = Read-E1Terminal $OperationRoot $binding 0
        $prerequisite = Read-E1Integrity $OperationRoot $binding $terminal0; $kind = 'inter-slot-integrity'
        if (-not $prerequisite.value.dispatch_next_slot) { throw 'dual_condition_safety_stop' }
    }
    $slot = @($binding.value.slots)[$Ordinal]
    $claim = [ordered]@{
        schema = 1; kind = 'dual-condition-slot-claim'; pair_id = $binding.value.pair_id; group_run_id = $binding.value.group_run_id
        binding_sha256 = $binding.sha256; slot_id = $slot.slot_id; ordinal = $Ordinal; runtime_id = $slot.runtime_id
        prerequisite_kind = $kind; prerequisite_sha256 = $prerequisite.sha256; attempt_number = 1; retry_authorized = $false
    }
    Assert-E1SlotClaim $claim $binding $Ordinal $kind $prerequisite
    $receipt = Write-E1ImmutableJson (Get-E1SlotPath $paths $Ordinal 'claim.json') $claim
    Assert-E1Inventory $paths (Get-E1InventoryFiles $(if ($Ordinal -eq 0) { 'slot0_claim' } else { 'slot1_claim' }) $paths)
    return $receipt
}

function Assert-E1PlanClaim($Value, $BindingReceipt, $SlotClaimReceipt, [int]$Ordinal) {
    Assert-E1ExactKeys $Value $script:PlanClaimKeys
    $slot = @($BindingReceipt.value.slots)[$Ordinal]
    Assert-E1Integer $Value.schema 1; Assert-E1String $Value.kind 'dual-condition-plan-claim'
    Assert-E1String $Value.pair_id $BindingReceipt.value.pair_id; Assert-E1String $Value.group_run_id $BindingReceipt.value.group_run_id
    if ($Value.binding_sha256 -cne $BindingReceipt.sha256 -or $Value.slot_claim_sha256 -cne $SlotClaimReceipt.sha256) {
        throw 'dual_condition_claim_chain'
    }
    Assert-E1String $Value.slot_id $slot.slot_id; Assert-E1Integer $Value.ordinal $Ordinal; Assert-E1String $Value.runtime_id $slot.runtime_id
    if ($Value.plan_sha256 -cne $slot.plan_sha256) { throw 'dual_condition_plan_mismatch' }
    # cli.mjs assigns its run_id while finalizing the record and exposes no preallocation input.
    # Preserve that limitation explicitly: this pre-spawn claim binds the immutable plan and slot;
    # the terminal later binds the runtime-assigned run_id to this claim and the validated evidence.
    if ($null -ne $Value.run_id -or $Value.run_id_binding_policy -cne 'runtime-assigned-at-record-finalization; terminal-binds-exact-run-id') {
        throw 'dual_condition_plan_run_id_policy'
    }
    Assert-E1String $Value.state 'claimed-before-spawn'; Assert-E1Bool $Value.retry_authorized $false
}

function Read-E1PlanClaim([string]$OperationRoot, $BindingReceipt, $SlotClaimReceipt, [int]$Ordinal) {
    $paths = Get-E1Paths $OperationRoot
    $receipt = Read-E1Json (Get-E1SlotPath $paths $Ordinal 'plan.claim.json')
    Assert-E1PlanClaim $receipt.value $BindingReceipt $SlotClaimReceipt $Ordinal
    return $receipt
}

# Public pre-spawn boundary. Operational launchers must call this API and durably
# receive the returned receipt before starting the provider. This pure contract
# intentionally does not claim that any legacy StageB launcher is integrated.
function New-Evidence1DualConditionCanaryPlanClaim {
    param([Parameter(Mandatory)][string]$OperationRoot, [Parameter(Mandatory)][ValidateRange(0,1)][int]$Ordinal)
    $paths = Get-E1Paths $OperationRoot
    Assert-E1Inventory $paths (Get-E1InventoryFiles $(if ($Ordinal -eq 0) { 'slot0_claim' } else { 'slot1_claim' }) $paths)
    $binding = Read-E1Binding $OperationRoot
    $slotClaim = Read-E1SlotClaim $OperationRoot $binding $Ordinal
    $slot = @($binding.value.slots)[$Ordinal]
    $claim = [ordered]@{
        schema = 1; kind = 'dual-condition-plan-claim'; pair_id = $binding.value.pair_id; group_run_id = $binding.value.group_run_id
        binding_sha256 = $binding.sha256; slot_claim_sha256 = $slotClaim.sha256; slot_id = $slot.slot_id; ordinal = $Ordinal
        runtime_id = $slot.runtime_id; plan_sha256 = $slot.plan_sha256; run_id = $null
        run_id_binding_policy = 'runtime-assigned-at-record-finalization; terminal-binds-exact-run-id'
        state = 'claimed-before-spawn'; retry_authorized = $false
    }
    Assert-E1PlanClaim $claim $binding $slotClaim $Ordinal
    $receipt = Write-E1ImmutableJson (Get-E1SlotPath $paths $Ordinal 'plan.claim.json') $claim
    Assert-E1Inventory $paths (Get-E1InventoryFiles $(if ($Ordinal -eq 0) { 'slot0_plan' } else { 'slot1_plan' }) $paths)
    return $receipt
}

function Assert-E1DispatchStarted($Value,$BindingReceipt,$SlotClaimReceipt,$PlanClaimReceipt,[int]$Ordinal){
    Assert-E1ExactKeys $Value $script:DispatchKeys;$slot=@($BindingReceipt.value.slots)[$Ordinal]
    Assert-E1Integer $Value.schema 1;Assert-E1String $Value.kind 'dual-condition-dispatch-started'
    foreach($name in @('pair_id','group_run_id')){Assert-E1String $Value.$name $BindingReceipt.value.$name}
    if($Value.binding_sha256-cne$BindingReceipt.sha256-or$Value.slot_claim_sha256-cne$SlotClaimReceipt.sha256-or
      $Value.plan_claim_sha256-cne$PlanClaimReceipt.sha256){throw 'dual_condition_claim_chain'}
    Assert-E1String $Value.slot_id $slot.slot_id;Assert-E1Integer $Value.ordinal $Ordinal;Assert-E1String $Value.runtime_id $slot.runtime_id
    Assert-E1String $Value.state 'started-contained';Assert-E1Integer $Value.sessions_consumed 1
    Assert-E1Bool $Value.contained_before_release $true;Assert-E1Bool $Value.retry_authorized $false
}

function Read-E1DispatchStarted([string]$OperationRoot,$BindingReceipt,$SlotClaimReceipt,$PlanClaimReceipt,[int]$Ordinal){
    $paths=Get-E1Paths $OperationRoot;$receipt=Read-E1Json (Get-E1SlotPath $paths $Ordinal 'dispatch.started.json')
    Assert-E1DispatchStarted $receipt.value $BindingReceipt $SlotClaimReceipt $PlanClaimReceipt $Ordinal
    return $receipt
}

function New-Evidence1DualConditionCanaryDispatchStarted{
    param([Parameter(Mandatory)][string]$OperationRoot,[Parameter(Mandatory)][ValidateRange(0,1)][int]$Ordinal)
    $paths=Get-E1Paths $OperationRoot;Assert-E1Inventory $paths (Get-E1InventoryFiles $(if($Ordinal-eq0){'slot0_plan'}else{'slot1_plan'}) $paths)
    $binding=Read-E1Binding $OperationRoot;$claim=Read-E1SlotClaim $OperationRoot $binding $Ordinal
    $plan=Read-E1PlanClaim $OperationRoot $binding $claim $Ordinal;$slot=@($binding.value.slots)[$Ordinal]
    $value=[ordered]@{schema=1;kind='dual-condition-dispatch-started';pair_id=$binding.value.pair_id;group_run_id=$binding.value.group_run_id;
      binding_sha256=$binding.sha256;slot_claim_sha256=$claim.sha256;plan_claim_sha256=$plan.sha256;slot_id=$slot.slot_id;
      ordinal=$Ordinal;runtime_id=$slot.runtime_id;state='started-contained';sessions_consumed=1;contained_before_release=$true;retry_authorized=$false}
    Assert-E1DispatchStarted $value $binding $claim $plan $Ordinal
    $receipt=Write-E1ImmutableJson (Get-E1SlotPath $paths $Ordinal 'dispatch.started.json') $value
    Assert-E1Inventory $paths (Get-E1InventoryFiles $(if($Ordinal-eq0){'slot0_dispatch'}else{'slot1_dispatch'}) $paths)
    return $receipt
}

function Assert-E1CopyTransaction($Value,$BindingReceipt,$DispatchReceipt,[int]$Ordinal){
    Assert-E1ExactKeys $Value $script:CopyTransactionKeys;$slot=@($BindingReceipt.value.slots)[$Ordinal]
    Assert-E1Integer $Value.schema 1;Assert-E1String $Value.kind 'dual-condition-evidence-copy-transaction'
    foreach($name in @('pair_id','group_run_id')){Assert-E1String $Value.$name $BindingReceipt.value.$name}
    if($Value.binding_sha256-cne$BindingReceipt.sha256-or$Value.dispatch_started_sha256-cne$DispatchReceipt.sha256){throw 'dual_condition_claim_chain'}
    Assert-E1String $Value.slot_id $slot.slot_id;Assert-E1Integer $Value.ordinal $Ordinal;Assert-E1String $Value.runtime_id $slot.runtime_id
    Assert-E1String $Value.run_id;if($Value.run_id-cnotmatch'^[A-Za-z0-9._-]+$'){throw 'dual_condition_evidence_layout'}
    Assert-E1String $Value.record_relative_path "slots/$Ordinal/$($Value.run_id).json"
    Assert-E1String $Value.sidecar_relative_path "slots/$Ordinal/audit/$($Value.run_id).json"
    Assert-E1Hash $Value.record_sha256;Assert-E1Hash $Value.sidecar_sha256
    Assert-E1String $Value.state 'prepared-before-copy';Assert-E1Bool $Value.retry_authorized $false
}

function Read-E1CopyTransaction([string]$OperationRoot,$BindingReceipt,$DispatchReceipt,[int]$Ordinal){
    $paths=Get-E1Paths $OperationRoot;$receipt=Read-E1Json (Get-E1SlotPath $paths $Ordinal 'copy.transaction.json')
    Assert-E1CopyTransaction $receipt.value $BindingReceipt $DispatchReceipt $Ordinal
    return $receipt
}

function Get-E1OptionalCopyTransaction([string]$OperationRoot,$BindingReceipt,$DispatchReceipt,[int]$Ordinal){
    $paths=Get-E1Paths $OperationRoot
    if(-not(Test-Path -LiteralPath (Get-E1SlotPath $paths $Ordinal 'copy.transaction.json'))){return $null}
    return Read-E1CopyTransaction $OperationRoot $BindingReceipt $DispatchReceipt $Ordinal
}

function New-Evidence1DualConditionCanaryCopyTransaction{
    param([Parameter(Mandatory)][string]$OperationRoot,[Parameter(Mandatory)][ValidateRange(0,1)][int]$Ordinal,
      [Parameter(Mandatory)][string]$RunId,[Parameter(Mandatory)][string]$RecordSha256,[Parameter(Mandatory)][string]$SidecarSha256)
    $paths=Get-E1Paths $OperationRoot;Assert-E1Inventory $paths (Get-E1InventoryFiles $(if($Ordinal-eq0){'slot0_dispatch'}else{'slot1_dispatch'}) $paths)
    $binding=Read-E1Binding $OperationRoot;$claim=Read-E1SlotClaim $OperationRoot $binding $Ordinal
    $plan=Read-E1PlanClaim $OperationRoot $binding $claim $Ordinal;$dispatch=Read-E1DispatchStarted $OperationRoot $binding $claim $plan $Ordinal
    $slot=@($binding.value.slots)[$Ordinal]
    $value=[ordered]@{schema=1;kind='dual-condition-evidence-copy-transaction';pair_id=$binding.value.pair_id;group_run_id=$binding.value.group_run_id;
      binding_sha256=$binding.sha256;dispatch_started_sha256=$dispatch.sha256;slot_id=$slot.slot_id;ordinal=$Ordinal;runtime_id=$slot.runtime_id;
      run_id=$RunId;record_relative_path="slots/$Ordinal/$RunId.json";record_sha256=$RecordSha256;
      sidecar_relative_path="slots/$Ordinal/audit/$RunId.json";sidecar_sha256=$SidecarSha256;state='prepared-before-copy';retry_authorized=$false}
    Assert-E1CopyTransaction $value $binding $dispatch $Ordinal
    $receipt=Write-E1ImmutableJson (Get-E1SlotPath $paths $Ordinal 'copy.transaction.json') $value
    Assert-E1Inventory $paths (Get-E1InventoryFiles $(if($Ordinal-eq0){'slot0_copy_transaction'}else{'slot1_copy_transaction'}) $paths)
    return $receipt
}

function Assert-E1CopyRecovery($Value,$BindingReceipt,$TransactionReceipt,[int]$Ordinal){
    Assert-E1ExactKeys $Value $script:CopyRecoveryKeys;$slot=@($BindingReceipt.value.slots)[$Ordinal]
    Assert-E1Integer $Value.schema 1;Assert-E1String $Value.kind 'dual-condition-evidence-copy-recovery'
    foreach($name in @('pair_id','group_run_id')){Assert-E1String $Value.$name $BindingReceipt.value.$name}
    if($Value.binding_sha256-cne$BindingReceipt.sha256-or$Value.copy_transaction_sha256-cne$TransactionReceipt.sha256){throw 'dual_condition_claim_chain'}
    Assert-E1String $Value.slot_id $slot.slot_id;Assert-E1Integer $Value.ordinal $Ordinal;Assert-E1String $Value.runtime_id $slot.runtime_id
    Assert-E1String $Value.state 'rollback-authorized';Assert-E1String $Value.reason_code 'crash_during_evidence_copy';Assert-E1Bool $Value.retry_authorized $false
}

function Invoke-Evidence1DualConditionCanaryCopyRecovery{
    param([Parameter(Mandatory)][string]$OperationRoot,[Parameter(Mandatory)][ValidateRange(0,1)][int]$Ordinal)
    $paths=Get-E1Paths $OperationRoot;$binding=Read-E1Binding $OperationRoot;$claim=Read-E1SlotClaim $OperationRoot $binding $Ordinal
    $plan=Read-E1PlanClaim $OperationRoot $binding $claim $Ordinal;$dispatch=Read-E1DispatchStarted $OperationRoot $binding $claim $plan $Ordinal
    $transaction=Read-E1CopyTransaction $OperationRoot $binding $dispatch $Ordinal
    $relative=@($transaction.value.record_relative_path,$transaction.value.sidecar_relative_path)
    $expected=@(Get-E1InventoryFiles $(if($Ordinal-eq0){'slot0_copy_transaction'}else{'slot1_copy_transaction'}) $paths)
    foreach($name in $relative){$candidate=Join-Path $paths.root ($name-replace'/','\');if(Test-Path -LiteralPath $candidate){if((Get-E1FileSha256 $candidate)-cne$(if($name-ceq$relative[0]){$transaction.value.record_sha256}else{$transaction.value.sidecar_sha256})){throw 'dual_condition_copy_hash'};$expected+=$name}}
    $recoveryPath=Get-E1SlotPath $paths $Ordinal 'copy.recovery.json'
    if(Test-Path -LiteralPath $recoveryPath){$recovery=Read-E1Json $recoveryPath;Assert-E1CopyRecovery $recovery.value $binding $transaction $Ordinal}
    else{
      Assert-E1Inventory $paths $expected
      $value=[ordered]@{schema=1;kind='dual-condition-evidence-copy-recovery';pair_id=$binding.value.pair_id;group_run_id=$binding.value.group_run_id;
        binding_sha256=$binding.sha256;copy_transaction_sha256=$transaction.sha256;slot_id=@($binding.value.slots)[$Ordinal].slot_id;ordinal=$Ordinal;
        runtime_id=@($binding.value.slots)[$Ordinal].runtime_id;state='rollback-authorized';reason_code='crash_during_evidence_copy';retry_authorized=$false}
      Assert-E1CopyRecovery $value $binding $transaction $Ordinal;$recovery=Write-E1ImmutableJson $recoveryPath $value
    }
    foreach($name in $relative){$candidate=Join-Path $paths.root ($name-replace'/','\');if(Test-Path -LiteralPath $candidate){$expectedHash=$(if($name-ceq$relative[0]){$transaction.value.record_sha256}else{$transaction.value.sidecar_sha256});if((Get-E1FileSha256 $candidate)-cne$expectedHash){throw 'dual_condition_copy_hash'};[IO.File]::Delete($candidate)}}
    $expected=@(Get-E1InventoryFiles $(if($Ordinal-eq0){'slot0_copy_transaction'}else{'slot1_copy_transaction'}) $paths)+@("slots/$Ordinal/copy.recovery.json")
    Assert-E1Inventory $paths $expected
    return $recovery
}

function Initialize-E1DualConditionJobObject {
    if ('Evidence1.DualConditionJob' -as [type]) { return }
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'dual_condition_job_object_required' }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Evidence1 {
  [StructLayout(LayoutKind.Sequential)] public struct DualJobBasicLimit {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct DualIoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] public struct DualJobExtendedLimit {
    public DualJobBasicLimit BasicLimitInformation; public DualIoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] public struct DualJobAccounting {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  public static class DualConditionJob {
    const uint KillOnClose = 0x00002000; const int BasicAccounting = 1, ExtendedLimits = 9;
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
    public static IntPtr CreateKillOnClose(out int error) {
      IntPtr job=CreateJobObject(IntPtr.Zero,null); error=Marshal.GetLastWin32Error();
      if(job==IntPtr.Zero) return IntPtr.Zero;
      var limits=new DualJobExtendedLimit(); limits.BasicLimitInformation.LimitFlags=KillOnClose;
      int size=Marshal.SizeOf(typeof(DualJobExtendedLimit)); IntPtr buffer=Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(limits,buffer,false);
        if(!SetInformationJobObject(job,ExtendedLimits,buffer,(uint)size)) {
          error=Marshal.GetLastWin32Error(); CloseHandle(job); return IntPtr.Zero;
        }
      } finally { Marshal.FreeHGlobal(buffer); }
      error=0; return job;
    }
    public static bool TryGetActiveCount(IntPtr job,out uint active,out int error) {
      active=0; error=0; int size=Marshal.SizeOf(typeof(DualJobAccounting)); IntPtr buffer=Marshal.AllocHGlobal(size);
      try {
        uint returned;
        if(!QueryInformationJobObject(job,BasicAccounting,buffer,(uint)size,out returned)) { error=Marshal.GetLastWin32Error(); return false; }
        active=((DualJobAccounting)Marshal.PtrToStructure(buffer,typeof(DualJobAccounting))).ActiveProcesses; return true;
      } finally { Marshal.FreeHGlobal(buffer); }
    }
  }
}
'@
}

function Close-E1DualConditionJobObject([IntPtr]$Handle, [int]$TimeoutMilliseconds = 10000) {
    if ($Handle -eq [IntPtr]::Zero) { return $false }
    $clean = $false; $closed = $false
    try {
        $active = [uint32]0; $nativeError = 0
        if ([Evidence1.DualConditionJob]::TryGetActiveCount($Handle, [ref]$active, [ref]$nativeError)) {
            $terminated = $active -eq 0 -or [Evidence1.DualConditionJob]::TerminateJobObject($Handle, 124)
            if ($terminated) {
                $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
                do {
                    if (-not [Evidence1.DualConditionJob]::TryGetActiveCount($Handle, [ref]$active, [ref]$nativeError)) { break }
                    if ($active -eq 0) { $clean = $true; break }
                    Start-Sleep -Milliseconds 20
                } while ([DateTime]::UtcNow -lt $deadline)
            }
        }
    } finally { $closed = [Evidence1.DualConditionJob]::CloseHandle($Handle) }
    return [bool]($clean -and $closed)
}

function Invoke-E1BoundedProcess {
    param(
        [Parameter(Mandatory)][string]$FileName, [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory, [hashtable]$EnvironmentVariables = @{},
        [Parameter(Mandatory)][ValidateRange(1,86400)][int]$TimeoutSeconds,[scriptblock]$OnStarted=$null
    )
    Initialize-E1DualConditionJobObject
    $payload = [ordered]@{ executable = $FileName; arguments = @($Arguments) }
    $payloadB64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes(($payload | ConvertTo-Json -Depth 4 -Compress)))
    $gateName = "Local\Evidence1DualConditionGate-$PID-$([guid]::NewGuid().ToString('N'))"
    $systemModulePath="$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules"
    $launcherSource = @"
`$payload = [Text.UTF8Encoding]::new(`$false).GetString([Convert]::FromBase64String('$payloadB64')) | ConvertFrom-Json
`$gate = [Threading.EventWaitHandle]::OpenExisting('$gateName')
try {
  if (-not `$gate.WaitOne(30000)) { exit 124 }
  `$env:PSModulePath = '$systemModulePath'
  `$targetArguments = @(`$payload.arguments | ForEach-Object { [string]`$_ })
  & ([string]`$payload.executable) @targetArguments
  if (`$null -eq `$LASTEXITCODE) { exit 0 }
  exit `$LASTEXITCODE
} finally { `$gate.Dispose() }
"@
    $encodedLauncher = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launcherSource))
    $launcher = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'dual_condition_job_launcher_missing' }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $launcher
    $start.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encodedLauncher"
    $start.WorkingDirectory = $WorkingDirectory; $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true; $start.CreateNoWindow = $true
    $start.EnvironmentVariables['PSModulePath'] = $systemModulePath
    foreach ($key in $EnvironmentVariables.Keys) { $start.EnvironmentVariables[[string]$key] = [string]$EnvironmentVariables[$key] }
    $process = New-Object Diagnostics.Process; $process.StartInfo = $start
    $job = [IntPtr]::Zero; $gate = $null; $jobClosed = $false; $released = $false; $wrapperStarted = $false; $assigned = $false
    $cleanup = $false
    try {
        $gateCreated = $false
        $gate = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, $gateName, [ref]$gateCreated)
        if (-not $gateCreated) { throw 'dual_condition_process_gate_replay' }
        $nativeError = 0; $job = [Evidence1.DualConditionJob]::CreateKillOnClose([ref]$nativeError)
        if ($job -eq [IntPtr]::Zero) { throw 'dual_condition_process_job_create_failed' }
        if (-not $process.Start()) { throw 'dual_condition_process_start_failed' }
        $wrapperStarted = $true
        if (-not [Evidence1.DualConditionJob]::AssignProcessToJobObject($job, $process.Handle)) {
            throw 'dual_condition_process_job_assign_failed'
        }
        $assigned = $true
        if($null-ne$OnStarted){& $OnStarted}
        # The provider cannot spawn until its wrapper is confirmed inside the kill-on-close job.
        if (-not $gate.Set()) { throw 'dual_condition_process_gate_release_failed' }
        $released = $true
        $stdoutTask = $process.StandardOutput.ReadToEndAsync(); $stderrTask = $process.StandardError.ReadToEndAsync()
        $timedOut = -not $process.WaitForExit($TimeoutSeconds * 1000)
        $exitCode = $(if ($timedOut) { $null } else { [int]$process.ExitCode })
        $cleanup = Close-E1DualConditionJobObject $job; $jobClosed = $true
        $rootExited = $process.WaitForExit(2000)
        try { $streamsClosed = [Threading.Tasks.Task]::WaitAll(@($stdoutTask,$stderrTask), 5000) } catch { $streamsClosed = $false }
        if (-not $cleanup -or -not $rootExited -or -not $streamsClosed) { throw 'dual_condition_process_cleanup_failed' }
        if ($timedOut) { throw 'dual_condition_process_timeout' }
        return [ordered]@{ exit_code = $exitCode; stdout = $stdoutTask.Result; stderr = $stderrTask.Result; cleanup_ok = $true }
    } catch {
        $original = $_.Exception.Message
        if ($job -ne [IntPtr]::Zero -and -not $jobClosed) { $cleanup = Close-E1DualConditionJobObject $job; $jobClosed = $true }
        elseif (-not $wrapperStarted) { $cleanup = $true }
        if ($wrapperStarted -and -not $assigned) {
            try { if (-not $process.HasExited) { $process.Kill() } } catch {}
            try { $cleanup = [bool]$process.WaitForExit(2000) } catch { $cleanup = $false }
        }
        if (-not $cleanup) { throw 'dual_condition_process_cleanup_failed' }
        if (-not $released -and $original -notmatch '^dual_condition_process_') { throw 'dual_condition_process_containment_failed' }
        throw $original
    } finally {
        if ($job -ne [IntPtr]::Zero -and -not $jobClosed) {
            if (-not (Close-E1DualConditionJobObject $job)) { $jobClosed = $true; throw 'dual_condition_process_cleanup_failed' }
            $jobClosed = $true
        }
        if ($null -ne $gate) { $gate.Dispose() }
        $process.Dispose()
    }
}

function Invoke-E1OfficialEvidenceValidation($Paths, $BindingReceipt, [int]$Ordinal) {
    $evidence = Get-E1EvidencePaths $Paths $Ordinal
    $slot = @($BindingReceipt.value.slots)[$Ordinal]
    $harnessRoot = [string]$env:E1_DUAL_VALIDATOR_ROOT
    if([string]::IsNullOrWhiteSpace($harnessRoot)){throw 'dual_condition_validator_root_missing'}
    $harnessRoot=[IO.Path]::GetFullPath($harnessRoot)
    $null=Assert-Evidence1DualConditionValidatorBundle $harnessRoot $BindingReceipt.value.validator_bundle
    $expected = [ordered]@{
        run_id = $evidence.run_id; runtime_id = $slot.runtime_id; cli_version = $slot.cli_version
        model_requested = $slot.model_requested; model_resolved = $slot.model_resolved
        campaign_design_id = $slot.campaign_design_id; condition = $slot.condition
        product_access_mode = $slot.product_access_mode; scenario_id = $slot.scenario_id; seed = $slot.seed
        execution_profile_id = $slot.execution_profile_id; source_commit = $slot.source_commit
        harness_commit = $BindingReceipt.value.harness_commit; harness_tree = $BindingReceipt.value.harness_tree
        plan_sha256 = $slot.plan_sha256
        isolation_attestation_sha256 = $slot.isolation_attestation_sha256
        expected_skill_available = $slot.expected_skill_available
        skill_snapshot_sha256 = $BindingReceipt.value.skill_snapshot_sha256
        process_timeout_seconds = $slot.process_timeout_seconds
    }
    $validatorScript = @'
const { createHash } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
const { dirname, join } = await import('node:path');
const { pathToFileURL } = await import('node:url');
const root = process.env.KMP_E1_HARNESS_ROOT;
const runPath = process.env.KMP_E1_RECORD_PATH;
const expected = JSON.parse(Buffer.from(process.env.KMP_E1_EXPECTED_B64, 'base64').toString('utf8'));
const loader = await import(pathToFileURL(join(root, 'tools', 'agentic-eval', 'run-record-loader.mjs')).href);
const schemas = await import(pathToFileURL(join(root, 'tools', 'agentic-eval', 'schemas.mjs')).href);
const audits = await import(pathToFileURL(join(root, 'tools', 'agentic-eval', 'accepted-run-audit.mjs')).href);
const plans = await import(pathToFileURL(join(root, 'tools', 'agentic-eval', 'scenario-campaign-plan.mjs')).href);
const privacy = await import(pathToFileURL(join(root, 'tools', 'agentic-eval', 'privacy.mjs')).href);
const loaded = loader.validateRunRecordFile(runPath);
const record = loaded.record;
const recordErrors = record == null ? [{ field: '(root)' }] : [...schemas.validateRun(record).errors];
const recordPrivacy = record == null ? { ok: false } : privacy.redactObjectAndVerify(record);
const recordPrivacySafe = recordPrivacy.ok === true && JSON.stringify(recordPrivacy.redactedObj) === JSON.stringify(record);
if (!recordPrivacySafe) recordErrors.push({ field: 'privacy' });
const recordSchemaClean = recordErrors.length === 0;
let sidecar = null;
let sidecarErrors = [{ field: '(root)' }];
let crossErrors = [{ field: '(root)' }];
if (record != null && recordSchemaClean && record.accepted_audit != null) {
  const disk = loader.validateAcceptedAuditOnDisk(runPath, record);
  sidecar = disk.sidecar;
  sidecarErrors = [...disk.errors];
  crossErrors = sidecar == null ? [{ field: '(root)' }] : audits.crossValidateAcceptedRunAuditAgainstRecord(sidecar, record);
}
const eq = (actual, wanted, field, errors) => { if (actual !== wanted) errors.push({ field }); };
if (record != null) {
  eq(record.run_id, expected.run_id, 'run_id', recordErrors);
  eq(record.run_kind, 'scenario', 'run_kind', recordErrors);
  eq(record.benchmark_eligible, false, 'benchmark_eligible', recordErrors);
  eq(record.scenario_id, expected.scenario_id, 'scenario_id', recordErrors);
  eq(record.condition, expected.condition, 'condition', recordErrors);
  eq(record.product_access_mode, expected.product_access_mode, 'product_access_mode', recordErrors);
  eq(record.seed, expected.seed, 'seed', recordErrors);
  eq(record.order_index, 0, 'order_index', recordErrors);
  eq(record.repetition_index, 0, 'repetition_index', recordErrors);
  eq(record.agent_runtime?.runtime_id, expected.runtime_id, 'agent_runtime.runtime_id', recordErrors);
  eq(record.agent_runtime?.cli_version, expected.cli_version, 'agent_runtime.cli_version', recordErrors);
  eq(record.agent_runtime?.model_requested, expected.model_requested, 'agent_runtime.model_requested', recordErrors);
  eq(record.agent_runtime?.model_resolved, expected.model_resolved, 'agent_runtime.model_resolved', recordErrors);
  eq(record.model_requested, expected.model_requested, 'model_requested', recordErrors);
  eq(record.model_resolved, expected.model_resolved, 'model_resolved', recordErrors);
  eq(record.claude_code_version, expected.runtime_id === 'claude-code' ? expected.cli_version : null, 'claude_code_version', recordErrors);
  eq(record.execution_profile?.id, expected.execution_profile_id, 'execution_profile.id', recordErrors);
  eq(record.execution_profile?.isolation_attestation_sha256, expected.isolation_attestation_sha256, 'execution_profile.isolation_attestation_sha256', recordErrors);
  eq(record.project_commit, expected.source_commit, 'project_commit', recordErrors);
  eq(record.repo_commit, expected.harness_commit, 'repo_commit', recordErrors);
  eq(record.kmp_test_cli_source_sha, expected.harness_commit, 'kmp_test_cli_source_sha', recordErrors);
  eq(record.skill_available?.value, expected.expected_skill_available, 'skill_available.value', recordErrors);
  const availability = expected.expected_skill_available ? 'observed-present' : 'observed-absent';
  eq(record.skill_observation?.availability?.status, availability, 'skill_observation.availability.status', recordErrors);
  if (expected.expected_skill_available) {
    eq(record.skill_observation?.treatment_size?.snapshot_sha256, expected.skill_snapshot_sha256, 'skill_observation.treatment_size.snapshot_sha256', recordErrors);
  } else {
    eq(record.skill_observation?.treatment_size?.snapshot_sha256, null, 'skill_observation.treatment_size.snapshot_sha256', recordErrors);
  }
  const design = plans.resolveScenarioCampaignDesign(expected.campaign_design_id);
  if (!design.ok || design.design.runtime_id !== expected.runtime_id || design.design.scenario_id !== expected.scenario_id ||
      design.design.repeats !== 1 || design.design.order.length !== 1 || design.design.order[0].length !== 1) {
    recordErrors.push({ field: 'campaign_design_id' });
  } else {
    const cell = design.design.cellDefinitions[design.design.order[0][0]];
    if (cell?.condition !== expected.condition || cell?.product_access_mode !== expected.product_access_mode ||
        cell?.execution_profile_id !== expected.execution_profile_id) recordErrors.push({ field: 'campaign_design_id' });
    const builtPlan = plans.buildScenarioCampaignPlan({
      designId: expected.campaign_design_id, repeats: 1, executionProfiles: [expected.execution_profile_id],
    });
    const planSha = builtPlan.ok ? createHash('sha256').update(JSON.stringify(builtPlan.plan)).digest('hex') : null;
    if (planSha !== expected.plan_sha256) recordErrors.push({ field: 'plan_sha256' });
  }
}
if (sidecar != null) {
  eq(sidecar.run_id, expected.run_id, 'sidecar.run_id', sidecarErrors);
  eq(sidecar.condition, expected.condition, 'sidecar.condition', sidecarErrors);
  eq(sidecar.scenario_id, expected.scenario_id, 'sidecar.scenario_id', sidecarErrors);
  eq(sidecar.execution_profile_id, expected.execution_profile_id, 'sidecar.execution_profile_id', sidecarErrors);
  eq(sidecar.isolation_attestation_sha256, expected.isolation_attestation_sha256, 'sidecar.isolation_attestation_sha256', sidecarErrors);
}
const sidecarPrivacy = sidecar == null ? { ok: false } : privacy.redactObjectAndVerify(sidecar);
const sidecarPrivacySafe = sidecarPrivacy.ok === true && JSON.stringify(sidecarPrivacy.redactedObj) === JSON.stringify(sidecar);
if (!sidecarPrivacySafe) sidecarErrors.push({ field: 'privacy' });
const expectedRelative = `audit/${expected.run_id}.json`;
if (record != null) eq(record.accepted_audit?.relative_path, expectedRelative, 'accepted_audit.relative_path', recordErrors);
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const sidecarPath = join(dirname(runPath), 'audit', `${expected.run_id}.json`);
process.stdout.write(JSON.stringify({
  run_id: expected.run_id,
  record_status: recordErrors.length === 0 ? 'valid' : 'invalid',
  sidecar_status: sidecarErrors.length === 0 && crossErrors.length === 0 && loaded.errors.length === 0 ? 'valid' : 'invalid',
  record_privacy_status: recordPrivacySafe ? 'safe' : 'unsafe',
  sidecar_privacy_status: sidecarPrivacySafe ? 'safe' : 'unsafe',
  record_sha256: sha(runPath), sidecar_sha256: sha(sidecarPath),
}));
'@
    $validatorScript = "(async()=>{`n$validatorScript`n})().catch(()=>process.exit(1));"
    $environment = @{
        KMP_E1_HARNESS_ROOT = $harnessRoot
        KMP_E1_RECORD_PATH = $evidence.record
        KMP_E1_EXPECTED_B64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes(($expected | ConvertTo-Json -Depth 8 -Compress)))
        KMP_E1_VALIDATOR_SCRIPT_B64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($validatorScript))
    }
    try {
        $validation = Invoke-E1BoundedProcess 'node' @('-e', "eval(Buffer.from(process.env.KMP_E1_VALIDATOR_SCRIPT_B64,'base64').toString('utf8'))") `
            $harnessRoot $environment ([int]$slot.process_timeout_seconds)
    } catch {
        if ($_.Exception.Message -ceq 'dual_condition_process_timeout' -or $_.Exception.Message -ceq 'dual_condition_process_cleanup_failed') { throw }
        throw 'dual_condition_validator_unavailable'
    }
    if (-not $validation.cleanup_ok -or $validation.exit_code -ne 0) { throw 'dual_condition_validator_failed' }
    try { $result = $validation.stdout | ConvertFrom-Json -ErrorAction Stop } catch { throw 'dual_condition_validator_failed' }
    Assert-E1ExactKeys $result @('run_id','record_status','sidecar_status','record_privacy_status','sidecar_privacy_status','record_sha256','sidecar_sha256')
    Assert-E1String $result.run_id $evidence.run_id
    if ($result.record_status -cnotin @('valid','invalid') -or $result.sidecar_status -cnotin @('valid','invalid')) { throw 'dual_condition_validator_failed' }
    if($result.record_privacy_status-cnotin@('safe','unsafe')-or$result.sidecar_privacy_status-cnotin@('safe','unsafe')){throw 'dual_condition_validator_failed'}
    if(($result.record_status-ceq'valid'-and$result.record_privacy_status-cne'safe')-or($result.sidecar_status-ceq'valid'-and$result.sidecar_privacy_status-cne'safe')){throw 'dual_condition_validator_failed'}
    Assert-E1Hash $result.record_sha256; Assert-E1Hash $result.sidecar_sha256
    return $result
}

function Get-E1TerminalDerivation($Value) {
    $recordOk = $Value.record_status -ceq 'valid'; $sidecarOk = $Value.sidecar_status -ceq 'valid'
    if (-not $Value.cleanup_ok -or -not $recordOk -or -not $sidecarOk) {
        $reason = $(if (-not $Value.cleanup_ok) { 'cleanup_failed' } elseif (-not $recordOk) { 'record_invalid' } else { 'sidecar_invalid' })
        return [ordered]@{ state = 'safety_stopped'; failure_class = 'safety'; integrity_status = 'failed'; reason_code = $reason }
    }
    if ($Value.sessions_consumed -ne 1) { throw 'dual_condition_terminal' }
    if ($Value.timed_out) { return [ordered]@{ state = 'functional_failed'; failure_class = 'functional'; integrity_status = 'passed'; reason_code = 'runtime_timeout' } }
    if ($null -eq $Value.process_exit_code) { return [ordered]@{ state = 'safety_stopped'; failure_class = 'safety'; integrity_status = 'failed'; reason_code = 'process_exit_missing' } }
    if ([long]$Value.process_exit_code -eq 0) { return [ordered]@{ state = 'completed'; failure_class = 'none'; integrity_status = 'passed'; reason_code = $null } }
    return [ordered]@{ state = 'functional_failed'; failure_class = 'functional'; integrity_status = 'passed'; reason_code = 'runtime_nonzero_exit' }
}

function Assert-E1Terminal($Value, $BindingReceipt, $SlotClaimReceipt, $PlanClaimReceipt, $DispatchReceipt, $CopyTransactionReceipt, [int]$Ordinal, $Paths) {
    Assert-E1ExactKeys $Value $script:TerminalKeys; $slot = @($BindingReceipt.value.slots)[$Ordinal]
    Assert-E1Integer $Value.schema 1; Assert-E1String $Value.kind 'dual-condition-slot-terminal'
    Assert-E1String $Value.pair_id $BindingReceipt.value.pair_id; Assert-E1String $Value.group_run_id $BindingReceipt.value.group_run_id
    if ($Value.binding_sha256 -cne $BindingReceipt.sha256 -or $Value.slot_claim_sha256 -cne $SlotClaimReceipt.sha256 -or
        $Value.plan_claim_sha256 -cne $PlanClaimReceipt.sha256 -or $Value.dispatch_started_sha256 -cne $DispatchReceipt.sha256) { throw 'dual_condition_claim_chain' }
    if($null-eq$CopyTransactionReceipt){if($null-ne$Value.copy_transaction_sha256){throw 'dual_condition_claim_chain'}}
    else{Assert-E1Hash $Value.copy_transaction_sha256;if($Value.copy_transaction_sha256-cne$CopyTransactionReceipt.sha256){throw 'dual_condition_claim_chain'}}
    Assert-E1String $Value.slot_id $slot.slot_id; Assert-E1Integer $Value.ordinal $Ordinal; Assert-E1String $Value.runtime_id $slot.runtime_id
    if ($Value.timed_out -isnot [bool] -or $Value.cleanup_ok -isnot [bool]) { throw 'dual_condition_shape' }
    if ($null -ne $Value.process_exit_code -and ($Value.process_exit_code -isnot [int]) -and ($Value.process_exit_code -isnot [long])) { throw 'dual_condition_shape' }
    Assert-E1Integer $Value.sessions_consumed 1
    if($Value.record_status-ceq'missing'){
      $recoveryPath=Get-E1SlotPath $Paths $Ordinal 'copy.recovery.json'
      $hasRecovery=Test-Path -LiteralPath $recoveryPath
      if($hasRecovery-ne($null-ne$CopyTransactionReceipt)){throw 'dual_condition_incomplete_terminal'}
      if($hasRecovery){$recovery=Read-E1Json $recoveryPath;Assert-E1CopyRecovery $recovery.value $BindingReceipt $CopyTransactionReceipt $Ordinal}
      $expectedReason=$(if($hasRecovery){'crash_during_evidence_copy'}else{'crash_after_dispatch'})
      if($Value.state-cne'safety_stopped'-or$Value.failure_class-cne'safety'-or$Value.integrity_status-cne'failed'-or
        $Value.reason_code-cne$expectedReason-or$Value.cleanup_ok-ne$false-or$Value.timed_out-ne$false-or
        $null-ne$Value.process_exit_code-or$null-ne$Value.run_id-or$null-ne$Value.record_sha256-or
        $Value.sidecar_status-cne'missing'-or$null-ne$Value.sidecar_sha256){throw 'dual_condition_incomplete_terminal'}
      Assert-E1Bool $Value.benchmark_eligible $false;Assert-E1Bool $Value.retry_authorized $false
      return
    }
    if(Test-Path -LiteralPath (Get-E1SlotPath $Paths $Ordinal 'copy.recovery.json')){throw 'dual_condition_copy_recovery_unexpected'}
    if($null-eq$CopyTransactionReceipt){throw 'dual_condition_copy_transaction_missing'}
    # The terminal was created only after the official validator passed.  From that point onward,
    # its immutable receipt and the copy transaction bind the exact evidence bytes.  Re-running
    # the validator here would reinterpret a sealed record under the copy host's paths/runtime and
    # can turn a valid terminal into a false failure.  Verify the immutable identity and bytes;
    # do not re-evaluate already-sealed provider evidence during read/copy operations.
    $evidence = Get-E1EvidencePaths $Paths $Ordinal
    $recordSha256 = Get-E1FileSha256 $evidence.record
    $sidecarSha256 = Get-E1FileSha256 $evidence.sidecar
    if($Value.run_id-cne$evidence.run_id){throw 'dual_condition_evidence_run_id'}
    if($Value.record_sha256-cne$recordSha256){throw 'dual_condition_evidence_record_hash'}
    if($Value.sidecar_sha256-cne$sidecarSha256){throw 'dual_condition_evidence_sidecar_hash'}
    if($CopyTransactionReceipt.value.run_id-cne$evidence.run_id-or
       $CopyTransactionReceipt.value.record_sha256-cne$recordSha256-or
       $CopyTransactionReceipt.value.sidecar_sha256-cne$sidecarSha256){throw 'dual_condition_copy_hash'}
    $derived = Get-E1TerminalDerivation $Value
    foreach ($name in @('state','failure_class','integrity_status')) { Assert-E1String $Value.$name $derived.$name }
    if ($null -eq $derived.reason_code) { if ($null -ne $Value.reason_code) { throw 'dual_condition_terminal' } }
    else { Assert-E1String $Value.reason_code $derived.reason_code }
    if ($Value.state -ceq 'completed' -and [long]$Value.process_exit_code -ne 0) { throw 'dual_condition_terminal' }
    Assert-E1Bool $Value.benchmark_eligible $false; Assert-E1Bool $Value.retry_authorized $false
}

function Read-E1Terminal([string]$OperationRoot, $BindingReceipt, [int]$Ordinal) {
    $paths = Get-E1Paths $OperationRoot; $claim = Read-E1SlotClaim $OperationRoot $BindingReceipt $Ordinal
    $planClaim = Read-E1PlanClaim $OperationRoot $BindingReceipt $claim $Ordinal
    $dispatch=Read-E1DispatchStarted $OperationRoot $BindingReceipt $claim $planClaim $Ordinal
    $copyTransaction=Get-E1OptionalCopyTransaction $OperationRoot $BindingReceipt $dispatch $Ordinal
    $receipt = Read-E1Json (Get-E1SlotPath $paths $Ordinal 'terminal.json')
    Assert-E1Terminal $receipt.value $BindingReceipt $claim $planClaim $dispatch $copyTransaction $Ordinal $paths
    return $receipt
}

function New-Evidence1DualConditionCanarySlotTerminal {
    param(
        [Parameter(Mandatory)][string]$OperationRoot, [Parameter(Mandatory)][ValidateRange(0,1)][int]$Ordinal,
        [AllowNull()]$ProcessExitCode, [Parameter(Mandatory)][bool]$TimedOut, [Parameter(Mandatory)][bool]$CleanupOk,
        [Parameter(Mandatory)][ValidateRange(1,1)][int]$SessionsConsumed
    )
    if ($null -ne $ProcessExitCode -and ($ProcessExitCode -isnot [int]) -and ($ProcessExitCode -isnot [long])) { throw 'dual_condition_shape' }
    $paths = Get-E1Paths $OperationRoot; $binding = Read-E1Binding $OperationRoot
    $claim = Read-E1SlotClaim $OperationRoot $binding $Ordinal; $slot = @($binding.value.slots)[$Ordinal]
    $planClaim = Read-E1PlanClaim $OperationRoot $binding $claim $Ordinal
    $dispatch=Read-E1DispatchStarted $OperationRoot $binding $claim $planClaim $Ordinal
    $copyTransaction=Get-E1OptionalCopyTransaction $OperationRoot $binding $dispatch $Ordinal
    if($null-eq$copyTransaction){throw 'dual_condition_copy_transaction_missing'}
    $baseStage = $(if ($Ordinal -eq 0) { 'slot0_evidence' } else { 'slot1_evidence' })
    Assert-E1Inventory $paths (Get-E1InventoryFiles $baseStage $paths)
    $evidence = Invoke-E1OfficialEvidenceValidation $paths $binding $Ordinal
    $observed = [ordered]@{ record_status = $evidence.record_status; sidecar_status = $evidence.sidecar_status; cleanup_ok = $CleanupOk
        sessions_consumed = $SessionsConsumed; timed_out = $TimedOut; process_exit_code = $ProcessExitCode }
    $derived = Get-E1TerminalDerivation $observed
    $terminal = [ordered]@{
        schema = 1; kind = 'dual-condition-slot-terminal'; pair_id = $binding.value.pair_id; group_run_id = $binding.value.group_run_id
        binding_sha256 = $binding.sha256; slot_claim_sha256 = $claim.sha256; plan_claim_sha256 = $planClaim.sha256;dispatch_started_sha256=$dispatch.sha256
        copy_transaction_sha256=$copyTransaction.sha256
        slot_id = $slot.slot_id; ordinal = $Ordinal
        runtime_id = $slot.runtime_id; state = $derived.state; failure_class = $derived.failure_class; process_exit_code = $ProcessExitCode
        timed_out = $TimedOut; cleanup_ok = $CleanupOk; record_status = $evidence.record_status; run_id = $evidence.run_id
        record_sha256 = $evidence.record_sha256; sidecar_status = $evidence.sidecar_status; sidecar_sha256 = $evidence.sidecar_sha256
        integrity_status = $derived.integrity_status; reason_code = $derived.reason_code
        benchmark_eligible = $false; sessions_consumed = $SessionsConsumed; retry_authorized = $false
    }
    Assert-E1Terminal $terminal $binding $claim $planClaim $dispatch $copyTransaction $Ordinal $paths
    $receipt = Write-E1ImmutableJson (Get-E1SlotPath $paths $Ordinal 'terminal.json') $terminal
    Assert-E1Inventory $paths (Get-E1InventoryFiles $(if ($Ordinal -eq 0) { 'slot0_terminal' } else { 'slot1_terminal' }) $paths)
    return $receipt
}

function New-Evidence1DualConditionCanaryIncompleteSlotTerminal{
    param([Parameter(Mandatory)][string]$OperationRoot,[Parameter(Mandatory)][ValidateRange(0,1)][int]$Ordinal)
    $paths=Get-E1Paths $OperationRoot;Assert-E1Inventory $paths (Get-E1InventoryFiles $(if($Ordinal-eq0){'slot0_incomplete_preterminal'}else{'slot1_incomplete_preterminal'}) $paths)
    $binding=Read-E1Binding $OperationRoot;$claim=Read-E1SlotClaim $OperationRoot $binding $Ordinal
    $plan=Read-E1PlanClaim $OperationRoot $binding $claim $Ordinal;$dispatch=Read-E1DispatchStarted $OperationRoot $binding $claim $plan $Ordinal
    $copyTransaction=Get-E1OptionalCopyTransaction $OperationRoot $binding $dispatch $Ordinal
    $slot=@($binding.value.slots)[$Ordinal]
    $reason=$(if(Test-Path -LiteralPath (Get-E1SlotPath $paths $Ordinal 'copy.recovery.json')){'crash_during_evidence_copy'}else{'crash_after_dispatch'})
    $terminal=[ordered]@{schema=1;kind='dual-condition-slot-terminal';pair_id=$binding.value.pair_id;group_run_id=$binding.value.group_run_id;
      binding_sha256=$binding.sha256;slot_claim_sha256=$claim.sha256;plan_claim_sha256=$plan.sha256;dispatch_started_sha256=$dispatch.sha256;
      copy_transaction_sha256=$(if($null-ne$copyTransaction){$copyTransaction.sha256}else{$null});
      slot_id=$slot.slot_id;ordinal=$Ordinal;runtime_id=$slot.runtime_id;state='safety_stopped';failure_class='safety';process_exit_code=$null;
      timed_out=$false;cleanup_ok=$false;record_status='missing';run_id=$null;record_sha256=$null;sidecar_status='missing';sidecar_sha256=$null;
      integrity_status='failed';reason_code=$reason;benchmark_eligible=$false;sessions_consumed=1;retry_authorized=$false}
    Assert-E1Terminal $terminal $binding $claim $plan $dispatch $copyTransaction $Ordinal $paths
    $receipt=Write-E1ImmutableJson (Get-E1SlotPath $paths $Ordinal 'terminal.json') $terminal
    Assert-E1Inventory $paths (Get-E1InventoryFiles $(if($Ordinal-eq0){'slot0_incomplete_terminal'}else{'slot1_incomplete_terminal'}) $paths)
    return $receipt
}

function New-Evidence1DualConditionInterSlotIntegrity {
    param([Parameter(Mandatory)][string]$OperationRoot)
    $paths = Get-E1Paths $OperationRoot
    $binding = Read-E1Binding $OperationRoot; $terminal = Read-E1Terminal $OperationRoot $binding 0
    $terminalStage=$(if($terminal.value.record_status-ceq'missing'){'slot0_incomplete_terminal'}else{'slot0_terminal'})
    Assert-E1Inventory $paths (Get-E1InventoryFiles $terminalStage $paths)
    $dispatch = $terminal.value.integrity_status -ceq 'passed' -and $terminal.value.state -cin @('completed','functional_failed')
    $decision = [ordered]@{
        schema = 1; kind = 'dual-condition-inter-slot-integrity'; pair_id = $binding.value.pair_id; group_run_id = $binding.value.group_run_id
        binding_sha256 = $binding.sha256; slot_terminal_sha256 = $terminal.sha256; slot_id = $terminal.value.slot_id
        ordinal = 0; runtime_id = $terminal.value.runtime_id; terminal_state = $terminal.value.state
        integrity_status = $terminal.value.integrity_status; dispatch_next_slot = $dispatch
        decision = $(if ($dispatch) { 'continue_once' } else { 'safety_stop' })
        reason_code = $(if ($dispatch) { $null } else { $terminal.value.reason_code }); retry_authorized = $false
    }
    Assert-E1Integrity $decision $binding $terminal
    $receipt = Write-E1ImmutableJson $paths.integrity $decision
    Assert-E1Inventory $paths (@(Get-E1InventoryFiles $terminalStage $paths)+@('inter-slot.integrity.json'))
    return $receipt
}

function Get-Evidence1DualConditionCanaryNextState {
    param([Parameter(Mandatory)][string]$CurrentState, [Parameter(Mandatory)][string]$Event)
    $transitions = @{
        'bound|authorization_claimed' = 'authorized'; 'authorized|group_claimed' = 'group_claimed'
        'group_claimed|slot_0_claimed' = 'slot_0_claimed'; 'slot_0_claimed|slot_0_plan_claimed' = 'slot_0_plan_claimed'
        'slot_0_plan_claimed|slot_0_terminal' = 'slot_0_terminal'
        'slot_0_terminal|integrity_continue' = 'inter_slot_integrity_checked'
        'slot_0_terminal|integrity_safety_stop' = 'closed_incomplete_safety_stop'
        'inter_slot_integrity_checked|slot_1_claimed' = 'slot_1_claimed'; 'slot_1_claimed|slot_1_plan_claimed' = 'slot_1_plan_claimed'
        'slot_1_plan_claimed|slot_1_terminal' = 'slot_1_terminal'
        'slot_1_terminal|custody_pass' = 'closed_pass'; 'slot_1_terminal|custody_functional_failed' = 'closed_failed'
        'slot_1_terminal|custody_safety_stop' = 'closed_incomplete_safety_stop'
    }
    $key = "$CurrentState|$Event"
    if (-not $transitions.ContainsKey($key)) { throw 'dual_condition_state_transition' }
    return $transitions[$key]
}

function Get-E1CustodySlot($ClaimReceipt, $PlanClaimReceipt, $TerminalReceipt) {
    return [ordered]@{
        ordinal = $TerminalReceipt.value.ordinal; slot_id = $TerminalReceipt.value.slot_id; runtime_id = $TerminalReceipt.value.runtime_id
        slot_claim_sha256 = $ClaimReceipt.sha256; plan_claim_sha256 = $PlanClaimReceipt.sha256; slot_terminal_sha256 = $TerminalReceipt.sha256
        dispatch_started_sha256=$TerminalReceipt.value.dispatch_started_sha256;copy_transaction_sha256=$TerminalReceipt.value.copy_transaction_sha256
        sessions_consumed = $TerminalReceipt.value.sessions_consumed; record_status = $TerminalReceipt.value.record_status
        terminal_state = $TerminalReceipt.value.state; failure_class = $TerminalReceipt.value.failure_class
        reason_code = $TerminalReceipt.value.reason_code; record_sha256 = $TerminalReceipt.value.record_sha256
        run_id = $TerminalReceipt.value.run_id
        sidecar_status = $TerminalReceipt.value.sidecar_status; sidecar_sha256 = $TerminalReceipt.value.sidecar_sha256
        integrity_status = $TerminalReceipt.value.integrity_status
    }
}

function Assert-E1UniqueCustodyHashes([object[]]$Slots) {
    $hashes = @()
    foreach ($slot in $Slots) {
        $hashes += @($slot.slot_claim_sha256,$slot.plan_claim_sha256,$slot.dispatch_started_sha256,$slot.slot_terminal_sha256)
        if ($null -ne $slot.copy_transaction_sha256) { $hashes += $slot.copy_transaction_sha256 }
        if ($null -ne $slot.record_sha256) { $hashes += $slot.record_sha256 }
        if ($null -ne $slot.sidecar_sha256) { $hashes += $slot.sidecar_sha256 }
    }
    $seen = @{}
    foreach ($hash in $hashes) {
        Assert-E1Hash $hash
        if ($seen.ContainsKey($hash)) { throw 'dual_condition_duplicate_hash' }
        $seen[$hash] = $true
    }
}

function Assert-E1Custody($Value, $BindingReceipt, $GroupReceipt, $IntegrityReceipt, [object[]]$ExpectedSlots) {
    Assert-E1ExactKeys $Value $script:CustodyKeys
    Assert-E1Integer $Value.schema 1; Assert-E1String $Value.kind 'dual-condition-group-custody'
    Assert-E1String $Value.pair_id $BindingReceipt.value.pair_id; Assert-E1String $Value.group_run_id $BindingReceipt.value.group_run_id
    if ($Value.binding_sha256 -cne $BindingReceipt.sha256 -or $Value.group_claim_sha256 -cne $GroupReceipt.sha256 -or
        $Value.inter_slot_integrity_sha256 -cne $IntegrityReceipt.sha256) { throw 'dual_condition_claim_chain' }
    $slots = @($Value.slots); if ($slots.Count -ne $ExpectedSlots.Count) { throw 'dual_condition_custody' }
    for ($i = 0; $i -lt $slots.Count; $i++) {
        Assert-E1ExactKeys $slots[$i] $script:CustodySlotKeys
        foreach ($name in $script:CustodySlotKeys) { if ($slots[$i].$name -cne $ExpectedSlots[$i].$name) { throw 'dual_condition_custody' } }
    }
    Assert-E1UniqueCustodyHashes $slots
    $sessions = 0
    foreach ($slot in $slots) { $sessions += [int]$slot.sessions_consumed }
    $records = @($slots | Where-Object { $_.record_status -ceq 'valid' }).Count
    $sidecars = @($slots | Where-Object { $_.sidecar_status -ceq 'valid' }).Count
    $complete = $slots.Count -eq 2 -and $sessions -eq 2 -and $records -eq 2 -and $sidecars -eq 2 -and
        @($slots | Where-Object { $_.integrity_status -cne 'passed' }).Count -eq 0
    $expectedState = $(if (-not $complete) { 'closed_incomplete_safety_stop' }
        elseif (@($slots | Where-Object { $_.terminal_state -ceq 'functional_failed' }).Count -gt 0) { 'closed_failed' }
        else { 'closed_pass' })
    Assert-E1String $Value.state $expectedState
    Assert-E1Bool $Value.complete $complete; Assert-E1Integer $Value.planned_sessions 2; Assert-E1Integer $Value.sessions_consumed $sessions
    Assert-E1Integer $Value.records_validated $records; Assert-E1Integer $Value.sidecars_validated $sidecars; Assert-E1Integer $Value.retry_count 0
    Assert-E1Bool $Value.retry_authorized $false; Assert-E1Bool $Value.benchmark_eligible $false
    Assert-E1Bool $Value.aggregated_across_runtimes $false
}

function Get-E1CustodyPrerequisites([string]$OperationRoot) {
    $paths = Get-E1Paths $OperationRoot; $binding = Read-E1Binding $OperationRoot
    $group = Read-E1GroupClaim $OperationRoot $binding; $claim0 = Read-E1SlotClaim $OperationRoot $binding 0
    $plan0 = Read-E1PlanClaim $OperationRoot $binding $claim0 0
    $terminal0 = Read-E1Terminal $OperationRoot $binding 0; $integrity = Read-E1Integrity $OperationRoot $binding $terminal0
    $slots = @(Get-E1CustodySlot $claim0 $plan0 $terminal0)
    if ($integrity.value.dispatch_next_slot) {
        $claim1 = Read-E1SlotClaim $OperationRoot $binding 1; $plan1 = Read-E1PlanClaim $OperationRoot $binding $claim1 1
        $terminal1 = Read-E1Terminal $OperationRoot $binding 1
        $slots += Get-E1CustodySlot $claim1 $plan1 $terminal1
    } else {
        foreach ($name in @('claim.json','plan.claim.json','dispatch.started.json','terminal.json')) {
            if (Test-Path -LiteralPath (Get-E1SlotPath $paths 1 $name)) { throw 'dual_condition_safety_stop_violation' }
        }
    }
    Assert-E1UniqueCustodyHashes $slots
    return [ordered]@{ paths = $paths; binding = $binding; group = $group; integrity = $integrity; slots = @($slots) }
}

function Get-E1PreCustodyInventory($Paths,[object[]]$Slots){
    if($Slots.Count-eq1-and$Slots[0].record_status-ceq'missing'){
      return @(Get-E1InventoryFiles 'slot0_incomplete_terminal' $Paths)+@('inter-slot.integrity.json')
    }
    if($Slots.Count-eq2-and$Slots[1].record_status-ceq'missing'){return Get-E1InventoryFiles 'slot1_incomplete_terminal' $Paths}
    return Get-E1InventoryFiles $(if($Slots.Count-eq1){'integrity'}else{'slot1_terminal'}) $Paths
}

function New-Evidence1DualConditionCanaryGroupCustody {
    param([Parameter(Mandatory)][string]$OperationRoot)
    $p = Get-E1CustodyPrerequisites $OperationRoot
    $slots = @($p.slots)
    $preCustody=@(Get-E1PreCustodyInventory $p.paths $slots)
    Assert-E1Inventory $p.paths $preCustody
    $sessions = 0
    foreach ($slot in $slots) { $sessions += [int]$slot.sessions_consumed }
    $records = @($slots | Where-Object { $_.record_status -ceq 'valid' }).Count
    $sidecars = @($slots | Where-Object { $_.sidecar_status -ceq 'valid' }).Count
    $complete = $slots.Count -eq 2 -and $sessions -eq 2 -and $records -eq 2 -and $sidecars -eq 2 -and
        @($slots | Where-Object { $_.integrity_status -cne 'passed' }).Count -eq 0
    $state = $(if (-not $complete) { 'closed_incomplete_safety_stop' }
        elseif (@($slots | Where-Object { $_.terminal_state -ceq 'functional_failed' }).Count -gt 0) { 'closed_failed' }
        else { 'closed_pass' })
    $custody = [ordered]@{
        schema = 1; kind = 'dual-condition-group-custody'; pair_id = $p.binding.value.pair_id; group_run_id = $p.binding.value.group_run_id
        binding_sha256 = $p.binding.sha256; group_claim_sha256 = $p.group.sha256; inter_slot_integrity_sha256 = $p.integrity.sha256
        state = $state; complete = $complete
        planned_sessions = 2; sessions_consumed = $sessions; records_validated = $records; sidecars_validated = $sidecars
        retry_count = 0; retry_authorized = $false; benchmark_eligible = $false; aggregated_across_runtimes = $false; slots = $slots
    }
    Assert-E1Custody $custody $p.binding $p.group $p.integrity $slots
    $receipt = Write-E1ImmutableJson $p.paths.custody $custody
    Assert-E1Inventory $p.paths ($preCustody + @('custody.json'))
    return $receipt
}

function Assert-Evidence1DualConditionCanaryOperation {
    param([Parameter(Mandatory)][string]$OperationRoot)
    $p = Get-E1CustodyPrerequisites $OperationRoot
    $preCustody=@(Get-E1PreCustodyInventory $p.paths @($p.slots))
    Assert-E1Inventory $p.paths ($preCustody + @('custody.json'))
    $receipt = Read-E1Json $p.paths.custody
    Assert-E1Custody $receipt.value $p.binding $p.group $p.integrity $p.slots
    $privacyValidated=@($p.slots).Count-eq2-and@($p.slots|Where-Object{
      $_.record_status-cne'valid'-or$_.sidecar_status-cne'valid'-or$null-eq$_.copy_transaction_sha256
    }).Count-eq0
    $publicationArtifacts=@()
    if($privacyValidated){
      foreach($slot in @($p.slots)){
        $ordinal=[int]$slot.ordinal
        $claim=Read-E1SlotClaim $OperationRoot $p.binding $ordinal
        $plan=Read-E1PlanClaim $OperationRoot $p.binding $claim $ordinal
        $dispatch=Read-E1DispatchStarted $OperationRoot $p.binding $claim $plan $ordinal
        $transaction=Read-E1CopyTransaction $OperationRoot $p.binding $dispatch $ordinal
        if($transaction.sha256-cne$slot.copy_transaction_sha256){throw 'dual_condition_claim_chain'}
        $publicationArtifacts+=@(
          [ordered]@{relative_path=$transaction.value.record_relative_path;sha256=$transaction.value.record_sha256;kind='record';ordinal=$ordinal},
          [ordered]@{relative_path=$transaction.value.sidecar_relative_path;sha256=$transaction.value.sidecar_sha256;kind='sidecar';ordinal=$ordinal}
        )
      }
    }
    return [ordered]@{ validated = $true; privacy_validated = $privacyValidated; custody_sha256 = $receipt.sha256;
      state = $receipt.value.state; publication_artifacts = @($publicationArtifacts) }
}

Export-ModuleMember -Function @(
    'New-Evidence1DualConditionCanaryBinding','Assert-Evidence1DualConditionCanaryBinding',
    'Get-Evidence1DualConditionValidatorBundleManifest','Assert-Evidence1DualConditionValidatorBundleManifest','Assert-Evidence1DualConditionValidatorBundle',
    'Get-Evidence1DualConditionCanaryOperationRoot',
    'Write-Evidence1DualConditionCanaryBinding','New-Evidence1DualConditionCanaryPairArmClaim','Assert-Evidence1DualConditionCanaryPair',
    'Get-Evidence1DualConditionCanaryAuthorizationLiteral','New-Evidence1DualConditionCanaryAuthorizationClaim',
    'New-Evidence1DualConditionCanaryGroupClaim','New-Evidence1DualConditionCanarySlotClaim','New-Evidence1DualConditionCanaryPlanClaim',
    'New-Evidence1DualConditionCanaryDispatchStarted','New-Evidence1DualConditionCanaryCopyTransaction','Invoke-Evidence1DualConditionCanaryCopyRecovery',
    'New-Evidence1DualConditionCanarySlotTerminal','New-Evidence1DualConditionCanaryIncompleteSlotTerminal','New-Evidence1DualConditionInterSlotIntegrity',
    'New-Evidence1DualConditionCanaryGroupCustody','Assert-Evidence1DualConditionCanaryOperation',
    'Get-Evidence1DualConditionCanaryNextState','Invoke-E1BoundedProcess','Copy-Evidence1DualConditionPublicArtifact',
    'Publish-Evidence1DualConditionArtifactSet','Assert-Evidence1DualConditionTrustedPath','Write-Evidence1DualConditionAtomicJson'
)

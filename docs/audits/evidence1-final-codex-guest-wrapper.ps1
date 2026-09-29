param(
    [Parameter(Mandatory)][string]$RunId,
    [Parameter(Mandatory)][string]$BindingPath,
    [Parameter(Mandatory)][string]$BindingSha256,
    [Parameter(Mandatory)][string]$AuthorizationClaimPath,
    [Parameter(Mandatory)][string]$AuthorizationClaimSha256,
    [Parameter(Mandatory)][string]$GlobalAuthorizationClaimPath,
    [Parameter(Mandatory)][string]$GlobalAuthorizationClaimSha256,
    [Parameter(Mandatory)][string]$RemoteAuthCanaryPath,
    [Parameter(Mandatory)][string]$RemoteAuthCanarySha256,
    [Parameter(Mandatory)][string]$NodeRuntimeManifestPath,
    [Parameter(Mandatory)][string]$NodeRuntimeManifestSha256,
    [ValidateRange(60,14400)][int]$TimeoutSeconds = 7200
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Get-E1WrapperSha256([string]$Path){$stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{$sha=[Security.Cryptography.SHA256]::Create();try{return([BitConverter]::ToString($sha.ComputeHash($stream))-replace'-','').ToLowerInvariant()}finally{$sha.Dispose()}}finally{$stream.Dispose()}}
function Assert-E1WrapperRuntimeAcl([string]$Path,[bool]$Directory) {
    $acl=Get-Acl -LiteralPath $Path;if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value-cne'S-1-5-32-544'-or-not$acl.AreAccessRulesProtected){throw 'guest_runtime_acl_invalid'}
    $rules=@($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]));if($rules.Count-ne 3){throw 'guest_runtime_acl_invalid'}
    $readExecute=[int]([Security.AccessControl.FileSystemRights]::ReadAndExecute-bor[Security.AccessControl.FileSystemRights]::Synchronize);$expected=@{'S-1-5-18'=[int][Security.AccessControl.FileSystemRights]::FullControl;'S-1-5-32-544'=[int][Security.AccessControl.FileSystemRights]::FullControl;'S-1-5-32-545'=$readExecute}
    foreach($rule in $rules){$sid=$rule.IdentityReference.Value;$inherit=if($Directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None};if(-not$expected.ContainsKey($sid)-or$rule.AccessControlType-ne[Security.AccessControl.AccessControlType]::Allow-or[int]$rule.FileSystemRights-ne$expected[$sid]-or$rule.InheritanceFlags-ne$inherit-or$rule.PropagationFlags-ne[Security.AccessControl.PropagationFlags]::None){throw 'guest_runtime_acl_invalid'}}
}
function Assert-E1WrapperRuntimePath([string]$Path,[string]$RuntimeBase,[bool]$Directory) {
    $full=[IO.Path]::GetFullPath($Path);$base=[IO.Path]::GetFullPath($RuntimeBase).TrimEnd('\')
    if(-not($full.Equals($base,[StringComparison]::OrdinalIgnoreCase)-or$full.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase))-or-not(Test-Path -LiteralPath $full -PathType $(if($Directory){'Container'}else{'Leaf'}))){throw 'guest_runtime_path_invalid'}
    $cursor=$full;while($true){$item=Get-Item -LiteralPath $cursor -Force;if(($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'guest_runtime_reparse_rejected'};Assert-E1WrapperRuntimeAcl $cursor ([bool]$item.PSIsContainer);if($cursor.Equals($base,[StringComparison]::OrdinalIgnoreCase)){break};$cursor=Split-Path -Parent $cursor}
}
if ($RunId -notmatch '^[0-9a-f-]{36}$') { throw 'run_id_invalid' }
$ops = 'C:\Evidence1Ops\final-codex'
$terminal = Join-Path $ops "$RunId.terminal.json"
$terminalClaim = Join-Path $ops "$RunId.terminal.claim.json"

$stdout = Join-Path $ops "$RunId.stdout.log"
$stderr = Join-Path $ops "$RunId.stderr.log"
$custodyDir = "C:\Evidence1Custody\$RunId"
$state='failed'; $code=97; $reason='wrapper_interrupted'
if((Test-Path -LiteralPath $terminal)-or(Test-Path -LiteralPath $terminalClaim)){throw 'run_terminal_or_claim_already_exists_no_respawn'}
$terminalClaimSha256=$null
try {
$runDir=Split-Path -Parent $PSCommandPath
$runtimeBase=Split-Path -Parent $runDir
$expectedNodeManifest=Join-Path $runDir 'node-runtime.manifest.json'
if(-not([IO.Path]::GetFullPath($NodeRuntimeManifestPath).Equals([IO.Path]::GetFullPath($expectedNodeManifest),[StringComparison]::OrdinalIgnoreCase))-or$NodeRuntimeManifestSha256-cnotmatch'^[0-9a-f]{64}$'-or-not(Test-Path -LiteralPath $NodeRuntimeManifestPath -PathType Leaf)-or(Get-E1WrapperSha256 $NodeRuntimeManifestPath)-cne$NodeRuntimeManifestSha256){throw 'node_runtime_manifest_invalid'}
$launcher = Join-Path $runDir 'evidence1-codex-live-launch.ps1'
$validationModule=Join-Path $runDir 'evidence1-validation-ops.psm1'
foreach($runtimePath in @($runDir,$PSCommandPath,$NodeRuntimeManifestPath,$launcher,$validationModule,(Join-Path $runDir 'evidence1-live-handoff-contract.psm1'),(Join-Path $runDir 'node-runtime\docs\audits\evidence1-codex-pilot-describe.mjs'),(Join-Path $runDir 'node-runtime\docs\audits\evidence1-codex-publication-scan.mjs'))){Assert-E1WrapperRuntimePath $runtimePath $runtimeBase ([IO.Directory]::Exists($runtimePath))}
$binding=Get-Content $BindingPath -Raw|ConvertFrom-Json
$bound=[ordered]@{launcher=$launcher;wrapper=$PSCommandPath;validation_helper=(Join-Path $runDir 'evidence1-validation-ops.psm1');campaign_control='C:\kmp-eval\agentic-eval-codex-runtime\tools\agentic-eval\final-campaign-control.mjs';pilot_describe=(Join-Path $runDir 'node-runtime\docs\audits\evidence1-codex-pilot-describe.mjs');publication_scan=(Join-Path $runDir 'node-runtime\docs\audits\evidence1-codex-publication-scan.mjs')}
foreach($name in $bound.Keys){if(-not($binding.script_sha256.PSObject.Properties.Name-ccontains$name)-or(Get-E1WrapperSha256 $bound[$name])-cne $binding.script_sha256.$name){throw 'bound_script_hash_mismatch'}}
$args = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$launcher,'-Mode','Live',
    '-HarnessDir','C:\kmp-eval\agentic-eval-codex-runtime','-SourceDir','C:\kmp-eval\source-fixtures\kmp-test-runner',
    '-AttestationFile','C:\kmp-eval\measurement-scopes\evidence1-codex-windows-isolation-attestation.json',
    '-CustodyDir',$custodyDir,'-PublicDir',"C:\kmp-eval\agentic-eval-codex-runtime\tools\runs\evidence1-codex-pilot-$RunId",
    '-CampaignBindingPath',$BindingPath,'-CampaignBindingSha256',$BindingSha256,
    '-AuthorizationClaimPath',$AuthorizationClaimPath,'-AuthorizationClaimSha256',$AuthorizationClaimSha256,
    '-GlobalAuthorizationClaimPath',$GlobalAuthorizationClaimPath,'-GlobalAuthorizationClaimSha256',$GlobalAuthorizationClaimSha256,
    '-RemoteAuthCanaryPath',$RemoteAuthCanaryPath,'-RemoteAuthCanarySha256',$RemoteAuthCanarySha256,
    '-NodeRuntimeManifestPath',$NodeRuntimeManifestPath,'-NodeRuntimeManifestSha256',$NodeRuntimeManifestSha256,
    '-RemoteAuthCanaryOperationId',((Get-Content $BindingPath -Raw | ConvertFrom-Json).remote_auth_operation_id),
    '-Authorization','AUTORIZO EXACTAMENTE 6 SESIONES CODEX: 3 PRODUCT Y 3 FREE-BASELINE; SIN REINTENTOS, REEMPLAZOS NI RESPAWNS.')
Import-Module $validationModule -Force -DisableNameChecking
    # All provider-independent checks are complete. Burn this exact run immediately
    # before the only call that can create the paid provider process.
    $terminalClaimValue=[ordered]@{schema=1;kind='evidence1-final-codex-terminal-claim';run_id=$RunId;binding_sha256=$BindingSha256;authorization_claim_sha256=$AuthorizationClaimSha256;global_authorization_claim_sha256=$GlobalAuthorizationClaimSha256;remote_auth_canary_sha256=$RemoteAuthCanarySha256;state='claimed-before-provider-spawn';retry_count=0;replacement_or_respawn_authorized=$false;claimed_at_utc=[datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
    $terminalClaimBytes=[Text.UTF8Encoding]::new($false).GetBytes(($terminalClaimValue|ConvertTo-Json -Compress)+"`n")
    $terminalClaimStream=[IO.FileStream]::new($terminalClaim,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough)
    try{$terminalClaimStream.Write($terminalClaimBytes,0,$terminalClaimBytes.Length);$terminalClaimStream.Flush($true)}finally{$terminalClaimStream.Dispose()}
    $terminalClaimHasher=[Security.Cryptography.SHA256]::Create();try{$terminalClaimSha256=([BitConverter]::ToString($terminalClaimHasher.ComputeHash($terminalClaimBytes))-replace'-','').ToLowerInvariant()}finally{$terminalClaimHasher.Dispose()}
    # Invoke-E1OwnedProcess uses PROC_THREAD_ATTRIBUTE_JOB_LIST and HANDLE_LIST: membership is
    # established by CreateProcess itself before the primary thread can execute. There is no
    # Start->Assign race and the PS5.1 caller never depends on the newer argument-list property.
    $result=Invoke-E1OwnedProcess 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' $args 'C:\kmp-eval\agentic-eval-codex-runtime' $stdout $stderr $TimeoutSeconds
    $code=[int]$result.ExitCode
    if(-not $result.CleanupOk){$reason='job_tree_cleanup_not_confirmed';$code=125}
    elseif($result.TimedOut){$reason='timeout_job_tree_terminated';$code=124}
    else{$reason=if($code -eq 0){'complete'}else{'launcher_failed_no_retry'};$state=if($code -eq 0){'complete'}else{'failed'}}
} catch {
    $state='failed';if($reason-ceq'wrapper_interrupted'){$reason='wrapper_preflight_failed_no_retry'};$code=97
} finally {
    $publicationManifestPath=Join-Path $custodyDir 'publication-manifest.json';$campaignCustodyPath=Join-Path $custodyDir 'campaign-custody.json'
    $value=[ordered]@{schema=1;run_id=$RunId;terminal_claim_sha256=$terminalClaimSha256;state=$state;exit_code=$code;reason_code=$reason;retry_count=0;replacement_or_respawn_used=$false;process_tree_cleanup='job-object-kill-on-close';publication_manifest_sha256=if($state -eq 'complete' -and (Test-Path $publicationManifestPath)){(Get-FileHash $publicationManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()}else{$null};campaign_custody_sha256=if($state -eq 'complete' -and (Test-Path $campaignCustodyPath)){(Get-FileHash $campaignCustodyPath -Algorithm SHA256).Hash.ToLowerInvariant()}else{$null}}
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($value|ConvertTo-Json)+"`n")
    try {
        $s=[IO.File]::Open($terminal,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read); try{$s.Write($bytes,0,$bytes.Length);$s.Flush($true)}finally{$s.Dispose()}
    } finally {
        # The terminal is durable before the bounded graceful shutdown request. The host
        # coordinator waits for Off and then performs the allowlisted copy automatically.
        & "$env:SystemRoot\System32\shutdown.exe" /s /t 0 /d p:0:0 /c 'Evidence1 final Codex terminal closed' | Out-Null
    }
}
exit $code

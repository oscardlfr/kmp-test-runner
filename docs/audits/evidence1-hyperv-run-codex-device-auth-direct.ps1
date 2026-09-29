#Requires -RunAsAdministrator
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ProfilePath,
  [Parameter(Mandatory)][string]$CreatedInspectionReceiptPath,
  [Parameter(Mandatory)][string]$GuestCredentialPath,
  [Parameter(Mandatory)][string]$OperationId,
  [Parameter(Mandatory)][string]$AuthorizationPhrase,
  [Parameter(Mandatory)][string]$ExpectedCodexAccount,
  [string]$ExpectedCodexPlan='pro',
  [string]$PriorFailedOperationId='',
  [string]$PrivateStatusRoot='C:\kmp-eval\scratch\evidence1-codex-device-auth',
  [int]$TimeoutMinutes=15
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-vm-identity-contract.psm1') -Force -DisableNameChecking

function Get-E1CodexAccountBinding($Session){
  Invoke-Command -Session $Session -ScriptBlock {param($ExpectedAccount,$ExpectedPlan)
    function ConvertFrom-JwtPayload([string]$Value){
      if($Value-cnotmatch'^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$'){return $null}
      try{$payload=$Matches[1].Replace('-','+').Replace('_','/');switch($payload.Length%4){2{$payload+='=='}3{$payload+='='}1{return $null}};[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))|ConvertFrom-Json -ErrorAction Stop}catch{return $null}
    }
    $path='C:\Evidence1RuntimeState\codex\auth.json'
    if(-not(Test-Path -LiteralPath $path -PathType Leaf)){return [ordered]@{identity_matched=$false;plan_matched=$false;expiry_valid=$false;credential_sha256=$null}}
    try{
      $auth=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json -ErrorAction Stop;$payload=ConvertFrom-JwtPayload ([string]$auth.tokens.id_token);if($null-eq$payload){throw 'invalid_token'}
      $email=[string]$payload.email;$localPart=if($email-match'^([^@]+)@'){$Matches[1]}else{$email}
      $authClaimName='https://api.openai.com/auth';$legacyPlanClaim='https://api.openai.com/auth.chatgpt_plan_type';$authClaims=$payload.PSObject.Properties[$authClaimName].Value
      $plan=if($null-ne$authClaims-and$null-ne$authClaims.PSObject.Properties['chatgpt_plan_type']){[string]$authClaims.PSObject.Properties['chatgpt_plan_type'].Value}else{[string]$payload.PSObject.Properties[$legacyPlanClaim].Value}
      $expires=[DateTimeOffset]::FromUnixTimeSeconds([int64]$payload.exp).UtcDateTime
      [ordered]@{identity_matched=$localPart.Equals($ExpectedAccount,[StringComparison]::OrdinalIgnoreCase);plan_matched=$plan-ceq$ExpectedPlan;expiry_valid=$expires-gt[datetime]::UtcNow.AddMinutes(5);plan_type=$plan;expires_at_utc=$expires.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');credential_sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
    }catch{[ordered]@{identity_matched=$false;plan_matched=$false;expiry_valid=$false;credential_sha256=$(if(Test-Path -LiteralPath $path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}else{$null})}}
  } -ArgumentList $ExpectedCodexAccount,$ExpectedCodexPlan -ErrorAction Stop
}

if($OperationId-cnotmatch'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'){throw 'codex_device_auth_operation_id_invalid'}
if($PriorFailedOperationId-and($PriorFailedOperationId-cnotmatch'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'-or$PriorFailedOperationId-ceq$OperationId)){throw 'codex_device_auth_prior_operation_invalid'}
if($AuthorizationPhrase-cne'authorize bounded codex authentication egress for canonical toolchain'){throw 'codex_device_auth_authorization_required'}
if($ExpectedCodexPlan-cne'pro'){throw 'codex_device_auth_account_contract_mismatch'}
if($TimeoutMinutes-lt5-or$TimeoutMinutes-gt30){throw 'codex_device_auth_timeout_invalid'}
$identity=Get-Evidence1CanonicalE2EVmIdentity -ProfilePath $ProfilePath -CreatedInspectionReceiptPath $CreatedInspectionReceiptPath -GuestCredentialPath $GuestCredentialPath
$root=[IO.Path]::GetFullPath($PrivateStatusRoot).TrimEnd('\');if(-not$root.Equals('C:\kmp-eval\scratch\evidence1-codex-device-auth',[StringComparison]::OrdinalIgnoreCase)){throw 'codex_device_auth_private_root_invalid'}
$operationRoot=Join-Path $root $OperationId;if(Test-Path -LiteralPath $operationRoot){throw 'codex_device_auth_replay'};New-Item -ItemType Directory -Path $operationRoot -ErrorAction Stop|Out-Null
$stdoutHost=Join-Path $operationRoot 'device-auth.stdout.private.txt';$stderrHost=Join-Path $operationRoot 'device-auth.stderr.private.txt';$reportPath=Join-Path $operationRoot 'terminal.json'
$vm=Get-VM -Name $identity.vm_name -ErrorAction Stop;if(([string]$vm.Id).ToLowerInvariant()-cne$identity.vm_id-or$vm.State-cne'Running'){throw 'codex_device_auth_vm_identity'}
$adapters=@(Get-VMNetworkAdapter -VM $vm);if($adapters.Count-ne1){throw 'codex_device_auth_adapter_count_invalid'}
$adapterInitiallyIsolated=@($adapters|Where-Object{$_.Connected-or(-not[string]::IsNullOrWhiteSpace([string]$_.SwitchId)-and[guid]$_.SwitchId-ne[guid]::Empty)}).Count-eq0
$adapterInitiallyCanonical=$adapters[0].Connected-and[string]$adapters[0].SwitchName-ceq'Default Switch'
if(-not$adapterInitiallyIsolated-and-not$adapterInitiallyCanonical){throw 'codex_device_auth_initial_network_topology_invalid'}
$stored=Import-Clixml -LiteralPath $GuestCredentialPath;if($stored-isnot[pscredential]-or$stored.UserName-cne$identity.guest_user){throw 'codex_device_auth_credential_identity'}
$credential=[pscredential]::new(($identity.guest_computer_name+'\'+$identity.guest_user),$stored.Password)
$watchdogName='Evidence1CodexDeviceAuthHostExpiry';$session=$null;$networkOpened=$adapterInitiallyCanonical;$watchdogRegistered=$false;$terminal=$null;$launch=$null;$backupPath=$null;$finalBinding=$null
try{
  $session=New-PSSession -VMId ([guid]$identity.vm_id) -Credential $credential -ErrorAction Stop
  $guestFirewallSealed=Invoke-Command -Session $session -ScriptBlock {$profiles=@(Get-NetFirewallProfile -Profile Domain,Private,Public);$profiles.Count-eq3-and@($profiles|Where-Object{$_.Enabled.ToString()-ne'True'-or$_.DefaultOutboundAction.ToString()-ne'Block'}).Count-eq0}
  if(-not[bool]$guestFirewallSealed){throw 'codex_device_auth_initial_guest_firewall_not_sealed'}
  $existingAuth=Invoke-Command -Session $session -ScriptBlock {param($codex,$state)$env:CODEX_HOME=$state;$previousPreference=$ErrorActionPreference;try{$ErrorActionPreference='Continue';& $codex login status *> $null;return $LASTEXITCODE}finally{$ErrorActionPreference=$previousPreference}} -ArgumentList 'C:\Evidence1Toolchain\codex-cli\0.154.0\bin\codex.exe','C:\Evidence1RuntimeState\codex'
  $existingBinding=Get-E1CodexAccountBinding $session
  if([int]$existingAuth-eq0-and$existingBinding.identity_matched -and $existingBinding.plan_matched-and$existingBinding.expiry_valid){$finalBinding=$existingBinding;$terminal='PASS'}else{
    if(Get-ScheduledTask -TaskName $watchdogName -ErrorAction SilentlyContinue){throw 'codex_device_auth_watchdog_collision'}
  $disconnect="Import-Module Hyper-V;Get-VMNetworkAdapter -VMName '$($identity.vm_name)'|Disconnect-VMNetworkAdapter -Confirm:`$false"
  $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($disconnect));$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded";$trigger=New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes($TimeoutMinutes));$principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $watchdogName -Action $action -Trigger $trigger -Principal $principal|Out-Null;$watchdogRegistered=$true
  if($adapterInitiallyIsolated){Connect-VMNetworkAdapter -VMNetworkAdapter $adapters[0] -SwitchName 'Default Switch' -Confirm:$false|Out-Null;$networkOpened=$true;Start-Sleep -Seconds 5}
  if($PriorFailedOperationId){
    $priorHost=Join-Path $root $PriorFailedOperationId;if(-not(Test-Path -LiteralPath $priorHost -PathType Container)-or(Test-Path -LiteralPath (Join-Path $priorHost 'terminal.json'))){throw 'codex_device_auth_prior_operation_invalid'}
    Invoke-Command -Session $session -ScriptBlock {param($prior)
      $needle="C:\Evidence1Ops\codex-device-auth\$prior\run.ps1";$matches=@(Get-CimInstance Win32_Process|Where-Object{[string]$_.CommandLine -like ('*'+$needle+'*')})
      if($matches.Count-gt1){throw 'codex_device_auth_prior_process_ambiguous'};foreach($match in $matches){taskkill.exe /PID $match.ProcessId /T /F *> $null}
    } -ArgumentList $PriorFailedOperationId
  }
  $backupPath=Invoke-Command -Session $session -ScriptBlock {param($OperationId)
    $state='C:\Evidence1RuntimeState\codex';$auth=Join-Path $state 'auth.json';$backup=Join-Path $state ("auth.pre-$OperationId.json")
    if(Test-Path -LiteralPath $backup){throw 'codex_device_auth_backup_collision'}
    if(Test-Path -LiteralPath $auth -PathType Leaf){Copy-Item -LiteralPath $auth -Destination $backup -ErrorAction Stop}
    $codex='C:\Evidence1Toolchain\codex-cli\0.154.0\bin\codex.exe';$env:CODEX_HOME=$state;& $codex logout *> $null
    return $backup
  } -ArgumentList $OperationId
  $launch=Invoke-Command -Session $session -ScriptBlock {param($OperationId,$TimeoutMinutes)
    $ErrorActionPreference='Stop';$dir=Join-Path 'C:\Evidence1Ops\codex-device-auth' $OperationId;if(Test-Path -LiteralPath $dir){throw 'codex_device_auth_guest_replay'};New-Item -ItemType Directory -Path $dir -Force|Out-Null
    $codex='C:\Evidence1Toolchain\codex-cli\0.154.0\bin\codex.exe';$state='C:\Evidence1RuntimeState\codex';if(-not(Test-Path -LiteralPath $codex -PathType Leaf)-or-not(Test-Path -LiteralPath $state -PathType Container)){throw 'codex_device_auth_toolchain_missing'}
    Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Allow
    $wrapper=Join-Path $dir 'run.ps1';$out=Join-Path $dir 'stdout.txt';$err=Join-Path $dir 'stderr.txt';$exit=Join-Path $dir 'exit.txt'
    $body=@"
`$ErrorActionPreference='Continue'
`$env:CODEX_HOME='$state'
& '$codex' login --device-auth 1> '$out' 2> '$err'
`$code=`$LASTEXITCODE
[IO.File]::WriteAllText('$exit',[string]`$code,[Text.UTF8Encoding]::new(`$false))
"@
    [IO.File]::WriteAllText($wrapper,$body,[Text.UTF8Encoding]::new($false));$process=Start-Process powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$wrapper) -WindowStyle Hidden -PassThru
    [ordered]@{dir=$dir;stdout=$out;stderr=$err;exit=$exit;wrapper_pid=$process.Id}
  } -ArgumentList $OperationId,$TimeoutMinutes
  $deadline=[DateTime]::UtcNow.AddMinutes($TimeoutMinutes)
  while([DateTime]::UtcNow-lt$deadline){
    foreach($pair in @(@($launch.stdout,$stdoutHost),@($launch.stderr,$stderrHost))){$encoded=Invoke-Command -Session $session -ScriptBlock {param($p)if(Test-Path -LiteralPath $p -PathType Leaf){$stream=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]'ReadWrite,Delete');try{$bytes=New-Object byte[] $stream.Length;$null=$stream.Read($bytes,0,$bytes.Length);[Convert]::ToBase64String($bytes)}finally{$stream.Dispose()}}} -ArgumentList $pair[0];if($null-ne$encoded){[IO.File]::WriteAllBytes($pair[1],[Convert]::FromBase64String([string]$encoded))}}
    $done=Invoke-Command -Session $session -ScriptBlock {param($p)Test-Path -LiteralPath $p -PathType Leaf} -ArgumentList $launch.exit
    if($done){$exitText=Invoke-Command -Session $session -ScriptBlock {param($p)[IO.File]::ReadAllText($p)} -ArgumentList $launch.exit;$exitCode=0;if(-not[int]::TryParse(([string]$exitText).Trim(),[ref]$exitCode)){throw 'codex_device_auth_exit_invalid'}
      $auth=Invoke-Command -Session $session -ScriptBlock {param($codex,$state)$env:CODEX_HOME=$state;$previousPreference=$ErrorActionPreference;try{$ErrorActionPreference='Continue';& $codex login status *> $null;return $LASTEXITCODE}finally{$ErrorActionPreference=$previousPreference}} -ArgumentList 'C:\Evidence1Toolchain\codex-cli\0.154.0\bin\codex.exe','C:\Evidence1RuntimeState\codex'
      if($exitCode-ne0-or[int]$auth-ne0){throw 'codex_device_auth_login_failed'}
      $finalBinding=Get-E1CodexAccountBinding $session
      if(-not$finalBinding.identity_matched-or-not$finalBinding.plan_matched-or-not$finalBinding.expiry_valid){throw 'codex_device_auth_account_binding_failed'}
      if($backupPath){Invoke-Command -Session $session -ScriptBlock {param($backup)Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue} -ArgumentList $backupPath;$backupPath=$null}
      $terminal='PASS';break}
    Start-Sleep -Seconds 2
  }
  if($terminal-cne'PASS'){Invoke-Command -Session $session -ScriptBlock {param($wrapperPid)taskkill.exe /PID $wrapperPid /T /F *> $null} -ArgumentList ([int]$launch.wrapper_pid);throw 'codex_device_auth_timeout'}
  }
}finally{
  if($session-and$launch-and$terminal-cne'PASS'){try{Invoke-Command -Session $session -ScriptBlock {param($wrapperPid)taskkill.exe /PID $wrapperPid /T /F *> $null} -ArgumentList ([int]$launch.wrapper_pid)}catch{}}
  if($session-and$backupPath-and$terminal-cne'PASS'){try{Invoke-Command -Session $session -ScriptBlock {param($backup)$auth='C:\Evidence1RuntimeState\codex\auth.json';if(Test-Path -LiteralPath $backup -PathType Leaf){Copy-Item -LiteralPath $backup -Destination $auth -Force;Remove-Item -LiteralPath $backup -Force}} -ArgumentList $backupPath}catch{}}
  if($session){try{Invoke-Command -Session $session -ScriptBlock {Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Block} -ErrorAction Stop}catch{};Remove-PSSession $session -ErrorAction SilentlyContinue}
  if($networkOpened){Get-VMNetworkAdapter -VM $vm|Disconnect-VMNetworkAdapter -Confirm:$false -ErrorAction SilentlyContinue|Out-Null}
  if($watchdogRegistered){Unregister-ScheduledTask -TaskName $watchdogName -Confirm:$false -ErrorAction SilentlyContinue}
}
$networkSealed=@(Get-VMNetworkAdapter -VM $vm|Where-Object{$_.Connected-or(-not[string]::IsNullOrWhiteSpace([string]$_.SwitchId)-and[guid]$_.SwitchId-ne[guid]::Empty)}).Count-eq0
$report=[ordered]@{schema=2;kind='evidence1-codex-device-auth-terminal';verdict=if($terminal-ceq'PASS'-and$networkSealed){'PASS'}else{'FAIL'};operation_id=$OperationId;vm_name=$identity.vm_name;vm_id=$identity.vm_id;expected_account=$ExpectedCodexAccount;expected_plan=$ExpectedCodexPlan;account_binding_verified=$null-ne$finalBinding-and$finalBinding.identity_matched-and$finalBinding.plan_matched-and$finalBinding.expiry_valid;network_sealed=$networkSealed;inference_sessions_consumed=0;auth_flow_output_private=$true}
[IO.File]::WriteAllText($reportPath,($report|ConvertTo-Json -Depth 5)+"`n",[Text.UTF8Encoding]::new($false));if($report.verdict-cne'PASS'){throw 'codex_device_auth_terminal_failed'}

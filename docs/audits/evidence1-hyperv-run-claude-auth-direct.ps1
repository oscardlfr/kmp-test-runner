#Requires -RunAsAdministrator
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ProfilePath,
  [Parameter(Mandatory)][string]$CreatedInspectionReceiptPath,
  [Parameter(Mandatory)][string]$GuestCredentialPath,
  [Parameter(Mandatory)][string]$OperationId,
  [Parameter(Mandatory)][string]$AuthorizationPhrase,
  [Parameter(Mandatory)][string]$ExpectedClaudeAccount,
  [string]$PrivateStatusRoot='C:\kmp-eval\scratch\evidence1-claude-auth',
  [int]$TimeoutMinutes=20
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-vm-identity-contract.psm1') -Force -DisableNameChecking

if($OperationId-cnotmatch'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'){throw 'claude_auth_operation_id_invalid'}
if($AuthorizationPhrase-cne'authorize bounded claude authentication egress for canonical toolchain'){throw 'claude_auth_authorization_required'}
if($TimeoutMinutes-lt5-or$TimeoutMinutes-gt30){throw 'claude_auth_timeout_invalid'}
$identity=Get-Evidence1CanonicalE2EVmIdentity -ProfilePath $ProfilePath -CreatedInspectionReceiptPath $CreatedInspectionReceiptPath -GuestCredentialPath $GuestCredentialPath
$root=[IO.Path]::GetFullPath($PrivateStatusRoot).TrimEnd('\');if(-not$root.Equals('C:\kmp-eval\scratch\evidence1-claude-auth',[StringComparison]::OrdinalIgnoreCase)){throw 'claude_auth_private_root_invalid'}
$operationRoot=Join-Path $root $OperationId;if(Test-Path -LiteralPath $operationRoot){throw 'claude_auth_replay'};New-Item -ItemType Directory -Path $operationRoot -ErrorAction Stop|Out-Null
$stdoutHost=Join-Path $operationRoot 'claude-auth.stdout.private.txt';$stderrHost=Join-Path $operationRoot 'claude-auth.stderr.private.txt';$codeHost=Join-Path $operationRoot 'auth-code.private.txt';$reportPath=Join-Path $operationRoot 'terminal.json'
$vm=Get-VM -Name $identity.vm_name -ErrorAction Stop;if(([string]$vm.Id).ToLowerInvariant()-cne$identity.vm_id-or$vm.State-cne'Running'){throw 'claude_auth_vm_identity'}
$adapters=@(Get-VMNetworkAdapter -VM $vm);if($adapters.Count-ne1){throw 'claude_auth_adapter_count_invalid'}
$adapterInitiallyIsolated=@($adapters|Where-Object{$_.Connected-or(-not[string]::IsNullOrWhiteSpace([string]$_.SwitchId)-and[guid]$_.SwitchId-ne[guid]::Empty)}).Count-eq0
$adapterInitiallyCanonical=$adapters[0].Connected-and[string]$adapters[0].SwitchName-ceq'Default Switch'
if(-not$adapterInitiallyIsolated-and-not$adapterInitiallyCanonical){throw 'claude_auth_initial_network_topology_invalid'}
$stored=Import-Clixml -LiteralPath $GuestCredentialPath;if($stored-isnot[pscredential]-or$stored.UserName-cne$identity.guest_user){throw 'claude_auth_credential_identity'}
$credential=[pscredential]::new(($identity.guest_computer_name+'\'+$identity.guest_user),$stored.Password)
$watchdogName='Evidence1ClaudeAuthHostExpiry';$session=$null;$networkOpened=$adapterInitiallyCanonical;$watchdogRegistered=$false;$terminal=$null;$launch=$null;$codeForwarded=$false
try{
  $session=New-PSSession -VMId ([guid]$identity.vm_id) -Credential $credential -ErrorAction Stop
  $guestFirewallSealed=Invoke-Command -Session $session -ScriptBlock {$profiles=@(Get-NetFirewallProfile -Profile Domain,Private,Public);$profiles.Count-eq3-and@($profiles|Where-Object{$_.Enabled.ToString()-ne'True'-or$_.DefaultOutboundAction.ToString()-ne'Block'}).Count-eq0}
  if(-not[bool]$guestFirewallSealed){throw 'claude_auth_initial_guest_firewall_not_sealed'}
  if(Get-ScheduledTask -TaskName $watchdogName -ErrorAction SilentlyContinue){throw 'claude_auth_watchdog_collision'}
  $disconnect="Import-Module Hyper-V;Get-VMNetworkAdapter -VMName '$($identity.vm_name)'|Disconnect-VMNetworkAdapter -Confirm:`$false"
  $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($disconnect));$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded";$trigger=New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes($TimeoutMinutes));$principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $watchdogName -Action $action -Trigger $trigger -Principal $principal|Out-Null;$watchdogRegistered=$true
  if($adapterInitiallyIsolated){Connect-VMNetworkAdapter -VMNetworkAdapter $adapters[0] -SwitchName 'Default Switch' -Confirm:$false|Out-Null;$networkOpened=$true;Start-Sleep -Seconds 5}
  $launch=Invoke-Command -Session $session -ScriptBlock {param($OperationId)
    $ErrorActionPreference='Stop';$dir=Join-Path 'C:\Evidence1Ops\claude-auth' $OperationId;if(Test-Path -LiteralPath $dir){throw 'claude_auth_guest_replay'};New-Item -ItemType Directory -Path $dir -Force|Out-Null
    $claude='C:\Evidence1Toolchain\claude-code\2.1.238\claude.cmd';$node='C:\Evidence1Toolchain\node\24.19.0';if(-not(Test-Path -LiteralPath $claude -PathType Leaf)-or-not(Test-Path -LiteralPath $node -PathType Container)){throw 'claude_auth_toolchain_missing'}
    Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Allow
    $wrapper=Join-Path $dir 'run.ps1';$out=Join-Path $dir 'stdout.txt';$err=Join-Path $dir 'stderr.txt';$input=Join-Path $dir 'input.txt';$exit=Join-Path $dir 'exit.txt'
    $body=@"
`$ErrorActionPreference='Stop'
foreach(`$name in @('ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY')){[Environment]::SetEnvironmentVariable(`$name,`$null,'Process')}
`$env:Path='$node;'+`$env:Path
`$psi=[Diagnostics.ProcessStartInfo]::new();`$psi.FileName='cmd.exe';`$psi.Arguments='/d /s /c ""$claude" auth login --claudeai"';`$psi.UseShellExecute=`$false;`$psi.CreateNoWindow=`$true;`$psi.RedirectStandardInput=`$true;`$psi.RedirectStandardOutput=`$true;`$psi.RedirectStandardError=`$true
`$process=[Diagnostics.Process]::new();`$process.StartInfo=`$psi
`$outEvent=Register-ObjectEvent -InputObject `$process -EventName OutputDataReceived -MessageData '$out' -Action {if(`$null-ne`$EventArgs.Data){[IO.File]::AppendAllText([string]`$Event.MessageData,`$EventArgs.Data+"`n",[Text.UTF8Encoding]::new(`$false))}}
`$errEvent=Register-ObjectEvent -InputObject `$process -EventName ErrorDataReceived -MessageData '$err' -Action {if(`$null-ne`$EventArgs.Data){[IO.File]::AppendAllText([string]`$Event.MessageData,`$EventArgs.Data+"`n",[Text.UTF8Encoding]::new(`$false))}}
try{
  if(-not`$process.Start()){throw 'claude_auth_process_start_failed'};`$process.BeginOutputReadLine();`$process.BeginErrorReadLine();`$sent=`$false
  while(-not`$process.HasExited){if(-not`$sent-and(Test-Path -LiteralPath '$input' -PathType Leaf)){`$code=[IO.File]::ReadAllText('$input').Trim();if(`$code.Length-lt8-or`$code.Length-gt4096-or`$code-match'[\r\n\x00-\x08\x0B\x0C\x0E-\x1F]'-or`$code-cnotmatch'^[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$'){throw 'claude_auth_code_invalid'};`$process.StandardInput.WriteLine(`$code);`$process.StandardInput.Flush();`$process.StandardInput.Close();`$sent=`$true};Start-Sleep -Milliseconds 250}
  `$process.WaitForExit();`$code=`$process.ExitCode
}finally{Unregister-Event -SourceIdentifier `$outEvent.Name -ErrorAction SilentlyContinue;Unregister-Event -SourceIdentifier `$errEvent.Name -ErrorAction SilentlyContinue;Remove-Job -Id `$outEvent.Id -Force -ErrorAction SilentlyContinue;Remove-Job -Id `$errEvent.Id -Force -ErrorAction SilentlyContinue}
[IO.File]::WriteAllText('$exit',[string]`$code,[Text.UTF8Encoding]::new(`$false))
"@
    [IO.File]::WriteAllText($wrapper,$body,[Text.UTF8Encoding]::new($false));$process=Start-Process powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$wrapper) -WindowStyle Hidden -PassThru
    [ordered]@{dir=$dir;stdout=$out;stderr=$err;input=$input;exit=$exit;wrapper_pid=$process.Id}
  } -ArgumentList $OperationId
  $deadline=[DateTime]::UtcNow.AddMinutes($TimeoutMinutes)
  while([DateTime]::UtcNow-lt$deadline){
    foreach($pair in @(@($launch.stdout,$stdoutHost),@($launch.stderr,$stderrHost))){$encoded=Invoke-Command -Session $session -ScriptBlock {param($p)if(Test-Path -LiteralPath $p -PathType Leaf){$stream=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]'ReadWrite,Delete');try{$bytes=New-Object byte[] $stream.Length;$null=$stream.Read($bytes,0,$bytes.Length);[Convert]::ToBase64String($bytes)}finally{$stream.Dispose()}}} -ArgumentList $pair[0];if($null-ne$encoded){[IO.File]::WriteAllBytes($pair[1],[Convert]::FromBase64String([string]$encoded))}}
    if(-not$codeForwarded-and(Test-Path -LiteralPath $codeHost -PathType Leaf)){$code=[IO.File]::ReadAllText($codeHost).Trim();if($code.Length-lt8-or$code.Length-gt4096-or$code-match'[\r\n\x00-\x08\x0B\x0C\x0E-\x1F]'-or$code-cnotmatch'^[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$'){throw 'claude_auth_code_invalid'};$encodedCode=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($code));Invoke-Command -Session $session -ScriptBlock {param($p,$b)[IO.File]::WriteAllBytes($p,[Convert]::FromBase64String($b))} -ArgumentList $launch.input,$encodedCode;Remove-Item -LiteralPath $codeHost -Force;$code=$null;$encodedCode=$null;$codeForwarded=$true}
    $done=Invoke-Command -Session $session -ScriptBlock {param($p)Test-Path -LiteralPath $p -PathType Leaf} -ArgumentList $launch.exit
    if($done){$exitText=Invoke-Command -Session $session -ScriptBlock {param($p)[IO.File]::ReadAllText($p)} -ArgumentList $launch.exit;$exitCode=0;if(-not[int]::TryParse(([string]$exitText).Trim(),[ref]$exitCode)){throw 'claude_auth_exit_invalid'}
      $auth=Invoke-Command -Session $session -ScriptBlock {param($claude,$node)$env:Path=$node+';'+$env:Path;foreach($name in @('ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN')){[Environment]::SetEnvironmentVariable($name,$null,'Process')};$previousPreference=$ErrorActionPreference;try{$ErrorActionPreference='Continue';& $claude auth status *> $null;return $LASTEXITCODE}finally{$ErrorActionPreference=$previousPreference}} -ArgumentList 'C:\Evidence1Toolchain\claude-code\2.1.238\claude.cmd','C:\Evidence1Toolchain\node\24.19.0'
      if($exitCode-ne0-or[int]$auth-ne0){throw 'claude_auth_login_failed'}
      $binding=Invoke-Command -Session $session -ScriptBlock {param($ExpectedAccount)
        $config=[Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR','Machine')
        if([string]::IsNullOrWhiteSpace($config)){$config=$env:CLAUDE_CONFIG_DIR}
        if([string]::IsNullOrWhiteSpace($config)){throw 'claude_auth_config_dir_missing'}
        $credentialPath=Join-Path $config '.credentials.json'
        if(-not(Test-Path -LiteralPath $credentialPath -PathType Leaf)){throw 'claude_auth_credential_missing'}
        $credentialSha=(Get-FileHash -LiteralPath $credentialPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $marker=[ordered]@{schema=1;account=$ExpectedAccount;credential_sha256=$credentialSha;created_at_utc=[datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');identity_method='fresh_oauth_label_and_credential_fingerprint'}
        $markerPath=Join-Path $config 'account-binding.json';$temporary=$markerPath+'.tmp'
        [IO.File]::WriteAllText($temporary,($marker|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $temporary -Destination $markerPath -Force
        [ordered]@{account=[string]$marker.account;credential_sha256=[string]$marker.credential_sha256}
      } -ArgumentList $ExpectedClaudeAccount
      if($binding.account-cne$ExpectedClaudeAccount-or[string]::IsNullOrWhiteSpace([string]$binding.credential_sha256)){throw 'claude_auth_account_binding_failed'}
      $terminal='PASS';break}
    Start-Sleep -Seconds 2
  }
  if($terminal-cne'PASS'){Invoke-Command -Session $session -ScriptBlock {param($wrapperPid)taskkill.exe /PID $wrapperPid /T /F *> $null} -ArgumentList ([int]$launch.wrapper_pid);throw 'claude_auth_timeout'}
}finally{
  if(Test-Path -LiteralPath $codeHost){Remove-Item -LiteralPath $codeHost -Force -ErrorAction SilentlyContinue}
  if($session-and$launch-and$terminal-cne'PASS'){try{Invoke-Command -Session $session -ScriptBlock {param($wrapperPid)taskkill.exe /PID $wrapperPid /T /F *> $null} -ArgumentList ([int]$launch.wrapper_pid)}catch{}}
  if($session){try{Invoke-Command -Session $session -ScriptBlock {Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Block} -ErrorAction Stop}catch{};Remove-PSSession $session -ErrorAction SilentlyContinue}
  if($networkOpened){Get-VMNetworkAdapter -VM $vm|Disconnect-VMNetworkAdapter -Confirm:$false -ErrorAction SilentlyContinue|Out-Null}
  if($watchdogRegistered){Unregister-ScheduledTask -TaskName $watchdogName -Confirm:$false -ErrorAction SilentlyContinue}
}
$networkSealed=@(Get-VMNetworkAdapter -VM $vm|Where-Object{$_.Connected-or(-not[string]::IsNullOrWhiteSpace([string]$_.SwitchId)-and[guid]$_.SwitchId-ne[guid]::Empty)}).Count-eq0
$report=[ordered]@{schema=2;kind='evidence1-claude-auth-terminal';verdict=if($terminal-ceq'PASS'-and$networkSealed){'PASS'}else{'FAIL'};operation_id=$OperationId;vm_name=$identity.vm_name;vm_id=$identity.vm_id;expected_account=$ExpectedClaudeAccount;account_binding_created=$terminal-ceq'PASS';network_sealed=$networkSealed;inference_sessions_consumed=0;auth_flow_output_private=$true;auth_code_persisted=$false}
[IO.File]::WriteAllText($reportPath,($report|ConvertTo-Json -Depth 5)+"`n",[Text.UTF8Encoding]::new($false));if($report.verdict-cne'PASS'){throw 'claude_auth_terminal_failed'}

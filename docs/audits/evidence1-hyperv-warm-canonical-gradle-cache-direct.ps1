#Requires -RunAsAdministrator
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ProfilePath,
  [Parameter(Mandatory)][string]$CreatedInspectionReceiptPath,
  [Parameter(Mandatory)][string]$GuestCredentialPath,
  [Parameter(Mandatory)][string]$OperationId,
  [Parameter(Mandatory)][string]$AuthorizationPhrase,
  [string]$SourceDir='C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1',
  [string]$PrivateStatusRoot='C:\kmp-eval\scratch\evidence1-gradle-cache',
  [int]$TimeoutMinutes=20,
  [string]$TaskList=''
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-vm-identity-contract.psm1') -Force -DisableNameChecking

$sourceCommit='7d45eae4f8720a0c77f507712ba2437ff974b6ed'
$tasks=@(':core:domain:test',':core:domain:createDemoDebugUnitTestCoverageReport',':core:domain:createProdDebugUnitTestCoverageReport')
# A scenario brings its own warm list as ONE comma-separated string (a single string avoids the array-binding problem of powershell -File).
if($TaskList){$tasks=@($TaskList-split','|ForEach-Object{$_.Trim()}|Where-Object{$_});if($tasks.Count-eq0-or@($tasks|Where-Object{$_-cnotmatch'^(:[A-Za-z0-9_-]+)+$'}).Count-ne0){throw 'gradle_cache_task_list_invalid'}}
if($OperationId-cnotmatch'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'){throw 'gradle_cache_operation_id_invalid'}
if($AuthorizationPhrase-cne'authorize bounded canonical gradle cache warm and offline certification'){throw 'gradle_cache_authorization_required'}
if($TimeoutMinutes-lt10-or$TimeoutMinutes-gt50){throw 'gradle_cache_timeout_invalid'}
if(-not[IO.Path]::GetFullPath($SourceDir).Equals('C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1',[StringComparison]::OrdinalIgnoreCase)){throw 'gradle_cache_source_path_invalid'}
$identity=Get-Evidence1CanonicalE2EVmIdentity -ProfilePath $ProfilePath -CreatedInspectionReceiptPath $CreatedInspectionReceiptPath -GuestCredentialPath $GuestCredentialPath
$root=[IO.Path]::GetFullPath($PrivateStatusRoot).TrimEnd('\');if(-not$root.Equals('C:\kmp-eval\scratch\evidence1-gradle-cache',[StringComparison]::OrdinalIgnoreCase)){throw 'gradle_cache_private_root_invalid'}
$operationRoot=Join-Path $root $OperationId;if(Test-Path -LiteralPath $operationRoot){throw 'gradle_cache_replay'};New-Item -ItemType Directory -Path $operationRoot -ErrorAction Stop|Out-Null
$reportPath=Join-Path $operationRoot 'terminal.json';$vm=Get-VM -Name $identity.vm_name -ErrorAction Stop
if(([string]$vm.Id).ToLowerInvariant()-cne$identity.vm_id-or$vm.State-cne'Running'){throw 'gradle_cache_vm_identity'}
$adapters=@(Get-VMNetworkAdapter -VM $vm);if($adapters.Count-ne1-or@($adapters|Where-Object{$_.Connected-or(-not[string]::IsNullOrWhiteSpace([string]$_.SwitchId)-and[guid]$_.SwitchId-ne[guid]::Empty)}).Count-ne0){throw 'gradle_cache_initial_network_not_isolated'}
$stored=Import-Clixml -LiteralPath $GuestCredentialPath;if($stored-isnot[pscredential]-or$stored.UserName-cne$identity.guest_user){throw 'gradle_cache_credential_identity'}
$credential=[pscredential]::new(($identity.guest_computer_name+'\'+$identity.guest_user),$stored.Password)
$watchdogName='Evidence1GradleCacheHostExpiry';$session=$null;$networkOpened=$false;$watchdogRegistered=$false;$state='failed';$failure='preflight_failed';$warm=$null;$certify=$null
$runPhase={param($OperationId,$Phase,$Offline,$SourceDir,$SourceCommit,$Tasks,$TimeoutMinutes)
  $ErrorActionPreference='Stop';$root=Join-Path 'C:\Evidence1Ops\gradle-cache' $OperationId;$dir=Join-Path $root $Phase;$copy=Join-Path $dir 'source';New-Item -ItemType Directory -Path $dir -Force|Out-Null
  $git='C:\Evidence1Toolchain\git\2.55.0.windows.5\cmd\git.exe';$java='C:\Evidence1Toolchain\jdk\21.0.12.1+1\bin\java.exe';$android='C:\Evidence1Toolchain\android-sdk\platform-36-build-tools-36.0.0';$gradleHome=Join-Path $env:USERPROFILE '.gradle'
  foreach($path in @($git,$java,(Join-Path $SourceDir '.git'))){if(-not(Test-Path -LiteralPath $path)){throw 'gradle_cache_toolchain_or_source_missing'}}
  $previousErrorActionPreference=$ErrorActionPreference;try{$ErrorActionPreference='Continue';$head=(& $git -C $SourceDir rev-parse HEAD).Trim();$gitExit=$LASTEXITCODE}finally{$ErrorActionPreference=$previousErrorActionPreference};if($gitExit-ne0-or$head-cne$SourceCommit){throw 'gradle_cache_source_identity'}
  $previousErrorActionPreference=$ErrorActionPreference;try{$ErrorActionPreference='Continue';$status=@(& $git -C $SourceDir status --porcelain=v1);$gitExit=$LASTEXITCODE}finally{$ErrorActionPreference=$previousErrorActionPreference};if($gitExit-ne0-or$status.Count-ne0){throw 'gradle_cache_source_dirty'}
  if(Test-Path -LiteralPath $copy){throw 'gradle_cache_phase_replay'}
  $previousErrorActionPreference=$ErrorActionPreference;try{$ErrorActionPreference='Continue';& $git clone --no-local --no-checkout -- $SourceDir $copy *> $null;$gitExit=$LASTEXITCODE}finally{$ErrorActionPreference=$previousErrorActionPreference};if($gitExit-ne0){throw 'gradle_cache_clone_failed'}
  $previousErrorActionPreference=$ErrorActionPreference;try{$ErrorActionPreference='Continue';& $git -C $copy checkout --detach $SourceCommit *> $null;$gitExit=$LASTEXITCODE}finally{$ErrorActionPreference=$previousErrorActionPreference};if($gitExit-ne0){throw 'gradle_cache_checkout_failed'}
  New-Item -ItemType Directory -Path $gradleHome -Force|Out-Null;[IO.File]::WriteAllText((Join-Path $gradleHome 'gradle.properties'),"org.gradle.daemon=false`norg.gradle.java.installations.auto-download=false`n",[Text.UTF8Encoding]::new($false))
  $env:GRADLE_USER_HOME=$gradleHome;$env:GRADLE_OPTS='-Dorg.gradle.daemon=false';$env:JAVA_HOME=Split-Path -Parent (Split-Path -Parent $java);$env:ANDROID_HOME=$android;$env:ANDROID_SDK_ROOT=$android
  $jar=Join-Path $copy 'gradle\wrapper\gradle-wrapper.jar';if(-not(Test-Path -LiteralPath $jar -PathType Leaf)){throw 'gradle_cache_wrapper_missing'}
  $gradleArgs=@('-Dorg.gradle.daemon=false','-Dorg.gradle.java.installations.auto-download=false',('-Dorg.gradle.java.home='+$env:JAVA_HOME),'-classpath',$jar,'org.gradle.wrapper.GradleWrapperMain')+$Tasks+@('--no-daemon','--no-build-cache','--no-configuration-cache','--console=plain','--stacktrace','--rerun-tasks');if($Offline){$gradleArgs+='--offline'}
  $quote={param([string]$value)if($value-notmatch'[\s"]'){return $value};return ('"'+($value-replace'"','\"')+'"')};$line=($gradleArgs|ForEach-Object{&$quote ([string]$_)})-join' '
  $stdout=Join-Path $dir 'gradle.stdout.private.txt';$stderr=Join-Path $dir 'gradle.stderr.private.txt';$psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$java;$psi.Arguments=$line;$psi.WorkingDirectory=$copy;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
  $p=[Diagnostics.Process]::new();$p.StartInfo=$psi;$out=[IO.File]::Open($stdout,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);$err=[IO.File]::Open($stderr,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try{if(-not$p.Start()){throw 'gradle_cache_process_start_failed'};$ot=$p.StandardOutput.BaseStream.CopyToAsync($out);$et=$p.StandardError.BaseStream.CopyToAsync($err);if(-not$p.WaitForExit($TimeoutMinutes*60*1000)){taskkill.exe /PID $p.Id /T /F *> $null;throw 'gradle_cache_process_timeout'};[Threading.Tasks.Task]::WaitAll(@($ot,$et));$exit=[int]$p.ExitCode}finally{$out.Dispose();$err.Dispose();$p.Dispose()}
  if($exit-ne0){throw ('gradle_cache_'+$Phase+'_failed')}
  $extendedCopy='\\?\'+$copy;$previousErrorActionPreference=$ErrorActionPreference;try{$ErrorActionPreference='Continue';& cmd.exe /d /c rd /s /q $extendedCopy *> $null;$cleanupExit=$LASTEXITCODE}finally{$ErrorActionPreference=$previousErrorActionPreference};if($cleanupExit-ne0-or(Test-Path -LiteralPath $copy)){throw 'gradle_cache_cleanup_failed'}
  [ordered]@{phase=$Phase;offline=[bool]$Offline;exit_code=$exit;task_count=$Tasks.Count;stdout_size=(Get-Item -LiteralPath $stdout).Length;stderr_size=(Get-Item -LiteralPath $stderr).Length}
}
try{
  if(Get-ScheduledTask -TaskName $watchdogName -ErrorAction SilentlyContinue){throw 'gradle_cache_watchdog_collision'}
  $disconnect="Import-Module Hyper-V;Get-VMNetworkAdapter -VMName '$($identity.vm_name)'|Disconnect-VMNetworkAdapter -Confirm:`$false";$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($disconnect));$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded";$trigger=New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes($TimeoutMinutes));$principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $watchdogName -Action $action -Trigger $trigger -Principal $principal|Out-Null;$watchdogRegistered=$true
  Connect-VMNetworkAdapter -VMNetworkAdapter $adapters[0] -SwitchName 'Default Switch' -Confirm:$false|Out-Null;$networkOpened=$true;Start-Sleep -Seconds 5;$session=New-PSSession -VMId ([guid]$identity.vm_id) -Credential $credential -ErrorAction Stop
  Invoke-Command -Session $session -ScriptBlock {Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Allow}
  $warm=Invoke-Command -Session $session -ScriptBlock $runPhase -ArgumentList $OperationId,'warm',$false,$SourceDir,$sourceCommit,$tasks,$TimeoutMinutes
  Invoke-Command -Session $session -ScriptBlock {Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Block}
  Get-VMNetworkAdapter -VM $vm|Disconnect-VMNetworkAdapter -Confirm:$false|Out-Null;$networkOpened=$false
  $certify=Invoke-Command -Session $session -ScriptBlock $runPhase -ArgumentList $OperationId,'certify',$true,$SourceDir,$sourceCommit,$tasks,$TimeoutMinutes
  $certification=Invoke-Command -Session $session -ScriptBlock {param($OperationId,$SourceCommit,$Tasks)
    $path='C:\Evidence1RuntimeState\gradle-cache-certification.json';$value=[ordered]@{schema=1;kind='evidence1-gradle-cache-certification';operation_id=$OperationId;source_commit=$SourceCommit;tasks=@($Tasks);offline_certified=$true;generated_at_utc=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')};$temp=$path+'.tmp-'+[guid]::NewGuid().ToString('N');[IO.File]::WriteAllText($temp,($value|ConvertTo-Json -Depth 4)+"`n",[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $temp -Destination $path -Force;$value
  } -ArgumentList $OperationId,$sourceCommit,$tasks
  if($certification.offline_certified-ne$true){throw 'gradle_cache_certification_failed'};$state='passed';$failure='none'
}catch{$failure=[string]$_.Exception.Message}
finally{
  if($session){try{Invoke-Command -Session $session -ScriptBlock {Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Block}}catch{};Remove-PSSession $session -ErrorAction SilentlyContinue}
  Get-VMNetworkAdapter -VM $vm|Disconnect-VMNetworkAdapter -Confirm:$false -ErrorAction SilentlyContinue|Out-Null
  if($watchdogRegistered){Unregister-ScheduledTask -TaskName $watchdogName -Confirm:$false -ErrorAction SilentlyContinue}
}
$networkSealed=@(Get-VMNetworkAdapter -VM $vm|Where-Object{$_.Connected-or(-not[string]::IsNullOrWhiteSpace([string]$_.SwitchId)-and[guid]$_.SwitchId-ne[guid]::Empty)}).Count-eq0
$report=[ordered]@{schema=1;kind='evidence1-gradle-cache-terminal';verdict=if($state-ceq'passed'-and$networkSealed){'PASS'}else{'FAIL'};operation_id=$OperationId;vm_name=$identity.vm_name;vm_id=$identity.vm_id;source_commit=$sourceCommit;tasks=$tasks;warm=$warm;certify=$certify;network_sealed=$networkSealed;failure_code=$failure;inference_sessions_consumed=0;diagnostic_content_private=$true}
[IO.File]::WriteAllText($reportPath,($report|ConvertTo-Json -Depth 6)+"`n",[Text.UTF8Encoding]::new($false));if($report.verdict-cne'PASS'){throw ('gradle_cache_terminal_failed:'+$failure)}

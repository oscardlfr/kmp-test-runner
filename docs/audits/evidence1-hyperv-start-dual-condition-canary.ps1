#Requires -RunAsAdministrator
param(
  [Parameter(Mandatory)][ValidateSet('product','free-baseline')][string]$Arm,
  [Parameter(Mandatory)][string]$PairId,
  [Parameter(Mandatory)][string]$GroupRunId,
  [Parameter(Mandatory)][string]$ProfilePath,
  [Parameter(Mandatory)][string]$CreatedInspectionReceiptPath,
  [Parameter(Mandatory)][string]$GuestCredentialPath,
  [Parameter(Mandatory)][string]$HostBundleDir,
  [Parameter(Mandatory)][string]$AuthorizationPhrase,
  [Parameter(Mandatory)][string]$RemoteAuthCanaryOperationId,
  [string]$ReadinessReportPath = 'C:\kmp-eval\scratch\hyperv-e2e-regenerate-readiness-direct\HYPERV-REGENERATE-READINESS-DIRECT.json',
  [string]$ReportPath = '',
  [ValidateRange(30,900)][int]$GracefulShutdownTimeoutSeconds = 300,
  [ValidateRange(15,300)][int]$StartTimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$AuthReportPath=Join-Path 'C:\kmp-eval\scratch\evidence1-dual-auth-canary-e2e' "$RemoteAuthCanaryOperationId\host-final.json"
$PlaceScript=Join-Path $PSScriptRoot 'evidence1-hyperv-place-dual-condition-canary.ps1'
Import-Module (Join-Path $PSScriptRoot 'evidence1-live-handoff-contract.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'evidence1-dual-condition-canary-contract.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'evidence1-vm-identity-contract.psm1') -Force -DisableNameChecking
$vmIdentity=Get-Evidence1CanonicalE2EVmIdentity -ProfilePath $ProfilePath -CreatedInspectionReceiptPath $CreatedInspectionReceiptPath -GuestCredentialPath $GuestCredentialPath
$VMName=$vmIdentity.vm_name;$ExpectedVMId=$vmIdentity.vm_id

function Wait-E1VM([string]$State,[int]$Seconds){$deadline=[DateTime]::UtcNow.AddSeconds($Seconds);do{$vm=Get-VM -Name $VMName -ErrorAction Stop;if([string]$vm.State -ceq $State){return};Start-Sleep -Seconds 2}while([DateTime]::UtcNow-lt$deadline);throw 'dual_condition_vm_state_timeout'}
function Get-E1FileHash([string]$Path){$sha=[Security.Cryptography.SHA256]::Create();$stream=[IO.File]::OpenRead($Path);try{return -join($sha.ComputeHash($stream)|ForEach-Object{$_.ToString('x2')})}finally{$stream.Dispose();$sha.Dispose()}}
function Write-E1CreateNew([string]$Path,$Value){$null=New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force;$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 12 -Compress));$s=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);try{$s.Write($bytes,0,$bytes.Length);$s.Flush($true)}finally{$s.Dispose()}}
function Assert-E1Inside([string]$Candidate,[string]$Root,[string]$Code){$c=[IO.Path]::GetFullPath($Candidate);$r=[IO.Path]::GetFullPath($Root).TrimEnd('\')+'\';if(-not $c.StartsWith($r,[StringComparison]::OrdinalIgnoreCase)){throw $Code}}

if(-not $ReportPath){$ReportPath=Join-Path 'C:\kmp-eval\scratch\dual-condition-canary\reports' "$PairId\$GroupRunId\START.json"}
Assert-E1Inside $HostBundleDir 'C:\kmp-eval\scratch\dual-condition-canary' 'dual_condition_host_bundle_root'
Assert-E1Inside $ReportPath 'C:\kmp-eval\scratch\dual-condition-canary' 'dual_condition_report_root'
if([IO.Path]::GetFullPath($ReadinessReportPath) -cne 'C:\kmp-eval\scratch\hyperv-e2e-regenerate-readiness-direct\HYPERV-REGENERATE-READINESS-DIRECT.json'){throw 'dual_condition_readiness_path'}
if(Test-Path -LiteralPath $ReportPath){throw 'dual_condition_start_replay'}
$bindingPath=Join-Path $HostBundleDir 'binding.json'
$binding=Get-Content -LiteralPath $bindingPath -Raw|ConvertFrom-Json -ErrorAction Stop
$null=Assert-Evidence1DualConditionCanaryBinding $binding
if($binding.arm -cne $Arm -or $binding.pair_id -cne $PairId -or $binding.group_run_id -cne $GroupRunId){throw 'dual_condition_start_binding'}
$readiness=Get-Content -LiteralPath $ReadinessReportPath -Raw|ConvertFrom-Json -ErrorAction Stop
if([string]$readiness.vm_name-cne$VMName-or([string]$readiness.vm_id).ToLowerInvariant()-cne$ExpectedVMId){throw 'dual_condition_vm_identity_binding_mismatch'}
$readinessAt=[DateTime]::MinValue
if(-not [DateTime]::TryParse([string]$readiness.generated_at_utc,[ref]$readinessAt)){throw 'dual_condition_readiness_invalid'}
$auth=Get-Content -LiteralPath $AuthReportPath -Raw|ConvertFrom-Json -ErrorAction Stop
# Task 2 (centralize dual-auth report parsing): verdict discriminated FIRST,
# through the one shared parser -- this used to check remote_auth_canary's
# mere PRESENCE directly, which mistook a genuine FAIL report (no
# remote_auth_canary key at all, by design) for a hash-mismatch, never
# reading $auth.verdict at all.
$hostVerdict = Resolve-Evidence1DualAuthHostReportVerdict -Report $auth -ExpectedVMName $VMName -ExpectedVMId $ExpectedVMId `
  -ExpectedCodexModel 'gpt-5.6-terra'
if ($hostVerdict.verdict -cne 'PASS') { throw "operation failed: $($hostVerdict.reason_code)" }
$null=Assert-Evidence1DualRemoteAuthCanary -Canary $auth.remote_auth_canary -ExpectedClaudeVersion '2.1.238' -ExpectedCodexVersion '0.154.0' `
  -ExpectedVMName $VMName -ExpectedVMId $ExpectedVMId -ExpectedClaudeModel 'claude-sonnet-5' -ExpectedCodexModel 'gpt-5.6-terra' `
  -NotBeforeUtc $readinessAt -MaxAgeMinutes $binding.remote_auth_max_age_minutes
$vm=Get-VM -Name $VMName -ErrorAction Stop
if([string]$vm.Id -cne $ExpectedVMId -or [string]$vm.State -cne 'Running'){throw 'dual_condition_start_requires_verified_running_vm'}
$stop=Stop-VM -Name $VMName -Confirm:$false -AsJob
if(-not (Wait-Job -Job $stop -Timeout $GracefulShutdownTimeoutSeconds)){throw 'dual_condition_graceful_shutdown_timeout'}
Receive-Job -Job $stop -ErrorAction Stop|Out-Null;Remove-Job -Job $stop -Force
Wait-E1VM 'Off' $GracefulShutdownTimeoutSeconds
$placeArgs=@{Mode='Arm';Arm=$Arm;PairId=$PairId;GroupRunId=$GroupRunId;HostBundleDir=$HostBundleDir;AuthorizationPhrase=$AuthorizationPhrase;
  ProfilePath=$ProfilePath;CreatedInspectionReceiptPath=$CreatedInspectionReceiptPath;GuestCredentialPath=$GuestCredentialPath;
  RemoteAuthCanaryOperationId=$RemoteAuthCanaryOperationId;
  ReportPath=(Join-Path (Split-Path -Parent $ReportPath) 'PLACE-ARM.json')}
& $PlaceScript @placeArgs
Start-VM -Name $VMName|Out-Null
Wait-E1VM 'Running' $StartTimeoutSeconds
Write-E1CreateNew $ReportPath ([ordered]@{schema=1;state='started';arm=$Arm;pair_id=$PairId;group_run_id=$GroupRunId;
  binding_sha256=(Get-E1FileHash $bindingPath);vm_name=$VMName;vm_id=$ExpectedVMId;
  state_transition=@('Running','Off','Armed','Running');planned_sessions=2;retry_count=0;replacement_or_respawn_used=$false;raw_content_read=$false})

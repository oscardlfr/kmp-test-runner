#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory)][string]$CampaignId,
  [Parameter(Mandatory)][string]$BindingSha256,
  [Parameter(Mandatory)][string]$AuthorizationClaimSha256,
  [Parameter(Mandatory)][string]$GlobalAuthorizationClaimSha256,
  [Parameter(Mandatory)][string]$RemoteAuthCanarySha256,
  [Parameter(Mandatory)][string]$NodeRuntimeManifestSha256,
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [string]$GuestComputerName = 'Evidence1E2E',
  [Parameter(Mandatory)][string]$GuestCredentialPath,
  [Parameter(Mandatory)][string]$ReportPath,
  [ValidateRange(60,7200)][int]$TimeoutSeconds = 7200
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($CampaignId -cnotmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$') { throw 'campaign_id_invalid' }
foreach ($sha in @($BindingSha256,$AuthorizationClaimSha256,$GlobalAuthorizationClaimSha256,$RemoteAuthCanarySha256,$NodeRuntimeManifestSha256)) {
  if ($sha -cnotmatch '^[0-9a-f]{64}$') { throw 'input_hash_invalid' }
}
$reportFull = [IO.Path]::GetFullPath($ReportPath)
$reportRoot = [IO.Path]::GetFullPath('C:\kmp-eval\scratch\evidence1-final-codex-direct-trigger').TrimEnd('\') + '\'
if (-not $reportFull.StartsWith($reportRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'report_path_not_canonical' }
if (Test-Path -LiteralPath $reportFull) { throw 'report_must_be_create_new' }
if (-not (Test-Path -LiteralPath $GuestCredentialPath -PathType Leaf)) { throw 'guest_credential_missing' }
$vm = Get-VM -Name $VMName -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant() -or $vm.State -ne 'Running') { throw 'exact_vm_must_be_running' }

$stored = Import-Clixml -LiteralPath $GuestCredentialPath
$simple = [string]$stored.UserName
$session = $null
$attempts = @()
$sessionDeadline = [datetime]::UtcNow.AddSeconds([math]::Min(300,$TimeoutSeconds))
do {
  foreach ($logon in @("$GuestComputerName\$simple", "$VMName\$simple", ".\$simple", $simple, "localhost\$simple")) {
    try {
      $credential = [pscredential]::new($logon,$stored.Password)
      $session = New-PSSession -VMName $VMName -Credential $credential -ErrorAction Stop
      $attempts += [ordered]@{logon=$logon;ok=$true}
      break
    } catch { $attempts += [ordered]@{logon=$logon;ok=$false;reason=$_.Exception.GetType().Name} }
  }
  if (-not $session) { Start-Sleep -Seconds 2 }
} while (-not $session -and [datetime]::UtcNow -lt $sessionDeadline)
if (-not $session) { throw 'powershell_direct_session_failed' }

$job = $null
$dispatchAt = [datetime]::UtcNow
try {
  $preflight = Invoke-Command -Session $session -ScriptBlock {
    param($CampaignId)
    $ops = 'C:\Evidence1Ops\final-codex'
    $campaign = Join-Path $ops $CampaignId
    $runtime = "C:\ProgramData\KmpEval\Evidence1FinalCodexRuntime\$CampaignId"
    $startup = 'C:\Users\Evidence1E2E\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Evidence1FinalCodex.vbs'
    $required = @(
      (Join-Path $campaign 'binding.json'),(Join-Path $campaign 'authorization.claim.json'),
      (Join-Path $campaign 'global.authorization.claim.json'),(Join-Path $campaign 'remote-auth-canary.json'),
      (Join-Path $runtime 'evidence1-final-codex-guest-wrapper.ps1'),(Join-Path $runtime 'node-runtime.manifest.json'),$startup)
    foreach($path in $required){if(-not(Test-Path -LiteralPath $path -PathType Leaf)){throw 'direct_trigger_staged_input_missing'}}
    foreach($path in @(
      (Join-Path $ops "$CampaignId.terminal.claim.json"),(Join-Path $ops "$CampaignId.terminal.json"),
      (Join-Path $ops "$CampaignId.stdout.log"),(Join-Path $ops "$CampaignId.stderr.log"),
      "C:\Evidence1Custody\$CampaignId",(Join-Path $campaign 'group.claim.json'),(Join-Path $campaign 'slots'))){
      if(Test-Path -LiteralPath $path){throw 'direct_trigger_already_started'}
    }
    Remove-Item -LiteralPath $startup -Force -ErrorAction Stop
    if(Test-Path -LiteralPath $startup){throw 'direct_trigger_startup_not_retired'}
    [ordered]@{ok=$true;startup_retired=$true}
  } -ArgumentList $CampaignId -ErrorAction Stop
  if ($preflight.ok -ne $true -or $preflight.startup_retired -ne $true) { throw 'direct_trigger_preflight_failed' }

  $job = Invoke-Command -Session $session -AsJob -ScriptBlock {
    param($CampaignId,$BindingSha256,$AuthorizationClaimSha256,$GlobalAuthorizationClaimSha256,$RemoteAuthCanarySha256,$NodeRuntimeManifestSha256,$TimeoutSeconds)
    $runtime = "C:\ProgramData\KmpEval\Evidence1FinalCodexRuntime\$CampaignId"
    $campaign = "C:\Evidence1Ops\final-codex\$CampaignId"
    $wrapper = Join-Path $runtime 'evidence1-final-codex-guest-wrapper.ps1'
    & 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $wrapper `
      -RunId $CampaignId `
      -BindingPath (Join-Path $campaign 'binding.json') -BindingSha256 $BindingSha256 `
      -AuthorizationClaimPath (Join-Path $campaign 'authorization.claim.json') -AuthorizationClaimSha256 $AuthorizationClaimSha256 `
      -GlobalAuthorizationClaimPath (Join-Path $campaign 'global.authorization.claim.json') -GlobalAuthorizationClaimSha256 $GlobalAuthorizationClaimSha256 `
      -RemoteAuthCanaryPath (Join-Path $campaign 'remote-auth-canary.json') -RemoteAuthCanarySha256 $RemoteAuthCanarySha256 `
      -NodeRuntimeManifestPath (Join-Path $runtime 'node-runtime.manifest.json') -NodeRuntimeManifestSha256 $NodeRuntimeManifestSha256 `
      -TimeoutSeconds $TimeoutSeconds
    exit $LASTEXITCODE
  } -ArgumentList $CampaignId,$BindingSha256,$AuthorizationClaimSha256,$GlobalAuthorizationClaimSha256,$RemoteAuthCanarySha256,$NodeRuntimeManifestSha256,$TimeoutSeconds

  $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds + 120)
  do {
    $state = (Get-VM -Name $VMName -ErrorAction Stop).State
    if ($state -eq 'Off') { break }
    if ($job.State -in @('Completed','Failed','Stopped','Disconnected')) {
      Start-Sleep -Seconds 10
      $state = (Get-VM -Name $VMName -ErrorAction Stop).State
      if ($state -eq 'Off') { break }
      throw "direct_trigger_job_terminal_before_vm_shutdown:$($job.State)"
    }
    Start-Sleep -Seconds 5
  } while ([datetime]::UtcNow -lt $deadline)
  if ($state -ne 'Off') { throw 'direct_trigger_vm_shutdown_timeout_no_hard_power' }

  $value = [ordered]@{
    schema=1;kind='evidence1-final-codex-direct-trigger';verdict='PASS';campaign_id=$CampaignId
    vm_name=$VMName;vm_id=$ExpectedVMId.ToLowerInvariant();dispatch_transport='powershell-direct'
    startup_retired_before_dispatch=$true;provider_spawn_evidence_not_read=$true
    vm_state='Off';hard_power_fallback_used=$false;retry_count=0;replacement_or_respawn_used=$false
    dispatched_at_utc=$dispatchAt.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');completed_at_utc=[datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportFull) | Out-Null
  $value | ConvertTo-Json -Compress | Set-Content -LiteralPath $reportFull -Encoding UTF8
  Write-Host "[evidence1-final-codex-direct-trigger] PASS: $reportFull"
} finally {
  if ($job) { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
  if ($session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
}

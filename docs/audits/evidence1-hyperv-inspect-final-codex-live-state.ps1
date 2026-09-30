#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory)][string]$CampaignId,
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [string]$GuestComputerName = 'Evidence1E2E',
  [Parameter(Mandatory)][string]$GuestCredentialPath,
  [Parameter(Mandatory)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($CampaignId -cnotmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$') { throw 'campaign_id_invalid' }
$reportFull = [IO.Path]::GetFullPath($ReportPath)
$reportRoot = [IO.Path]::GetFullPath('C:\kmp-eval\scratch\evidence1-final-codex-live-state').TrimEnd('\') + '\'
if (-not $reportFull.StartsWith($reportRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'report_path_not_canonical' }
if (-not (Test-Path -LiteralPath $GuestCredentialPath -PathType Leaf)) { throw 'guest_credential_missing' }
$vm = Get-VM -Name $VMName -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant()) { throw 'vm_identity_mismatch' }

$result = $null
$attempts = @()
if ($vm.State -eq 'Running') {
  $stored = Import-Clixml -LiteralPath $GuestCredentialPath
  $simple = [string]$stored.UserName
  foreach ($logon in @("$GuestComputerName\$simple", "$VMName\$simple", ".\$simple", $simple, "localhost\$simple")) {
    try {
      $credential = [pscredential]::new($logon, $stored.Password)
      $session = New-PSSession -VMName $VMName -Credential $credential -ErrorAction Stop
      try {
        $result = Invoke-Command -Session $session -ScriptBlock {
          param($CampaignId)
          function Fact([string]$Path) {
            if (-not (Test-Path -LiteralPath $Path)) { return [ordered]@{exists=$false} }
            $item = Get-Item -LiteralPath $Path -Force
            return [ordered]@{exists=$true;directory=[bool]$item.PSIsContainer;length=if($item.PSIsContainer){$null}else{[int64]$item.Length};last_write_time_utc=$item.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
          }
          $ops = "C:\Evidence1Ops\final-codex"
          $campaign = Join-Path $ops $CampaignId
          $custody = "C:\Evidence1Custody\$CampaignId"
          $startup = 'C:\Users\Evidence1E2E\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Evidence1FinalCodex.vbs'
          $slots = @()
          foreach ($i in 0..5) {
            $slot = Join-Path $campaign "slots\$i"
            $slots += [ordered]@{index=$i;slot_claim=Fact (Join-Path $slot 'slot.claim.json');plan_claim=Fact (Join-Path $slot 'plan.claim.json')}
          }
          $custodyFiles = if (Test-Path -LiteralPath $custody -PathType Container) {
            @(Get-ChildItem -LiteralPath $custody -File -Force -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
                [ordered]@{relative_path=$_.FullName.Substring($custody.Length + 1).Replace('\','/');length=[int64]$_.Length;last_write_time_utc=$_.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
              } | Sort-Object relative_path)
          } else { @() }
          $processes = @(Get-Process -Name powershell,node,codex,java -ErrorAction SilentlyContinue | ForEach-Object {
              [ordered]@{name=$_.ProcessName;id=$_.Id;start_time_utc=try{$_.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}catch{$null};cpu_seconds=try{[math]::Round($_.CPU,3)}catch{$null}}
            })
          [ordered]@{
            startup = Fact $startup
            terminal_claim = Fact (Join-Path $ops "$CampaignId.terminal.claim.json")
            terminal = Fact (Join-Path $ops "$CampaignId.terminal.json")
            wrapper_stdout = Fact (Join-Path $ops "$CampaignId.stdout.log")
            wrapper_stderr = Fact (Join-Path $ops "$CampaignId.stderr.log")
            group_claim = Fact (Join-Path $campaign 'group.claim.json')
            slots = $slots
            custody = Fact $custody
            custody_files = $custodyFiles
            processes = $processes
          }
        } -ArgumentList $CampaignId
        $attempts += [ordered]@{logon=$logon;ok=$true}
        break
      } finally { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
    } catch { $attempts += [ordered]@{logon=$logon;ok=$false;reason=$_.Exception.GetType().Name} }
  }
}
$report = [ordered]@{schema=1;verdict=if($result){'PASS'}else{'NO_DIRECT_SESSION'};generated_at_utc=[datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');campaign_id=$CampaignId;vm_name=$vm.Name;vm_id=([string]$vm.Id).ToLowerInvariant();vm_state=[string]$vm.State;attempts=$attempts;result=$result;raw_transcript_content_read=$false}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportFull) | Out-Null
if (Test-Path -LiteralPath $reportFull) { throw 'report_must_be_create_new' }
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportFull -Encoding UTF8
Write-Host "[evidence1-final-codex-live-state] $($report.verdict): $reportFull"

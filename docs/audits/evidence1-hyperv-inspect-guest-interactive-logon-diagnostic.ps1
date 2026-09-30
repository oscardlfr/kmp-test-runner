#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [string]$GuestComputerName = 'Evidence1E2E',
  [Parameter(Mandatory)][string]$GuestCredentialPath,
  [Parameter(Mandatory)][string]$ReportPath,
  [ValidateRange(30, 570)][int]$MaxWaitSeconds = 300
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$reportFull = [IO.Path]::GetFullPath($ReportPath)
$reportRoot = [IO.Path]::GetFullPath('C:\kmp-eval\scratch\evidence1-guest-interactive-logon-diagnostic').TrimEnd('\') + '\'
if (-not $reportFull.StartsWith($reportRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'report_path_not_canonical' }
if (-not (Test-Path -LiteralPath $GuestCredentialPath -PathType Leaf)) { throw 'guest_credential_missing' }
$vm = Get-VM -Name $VMName -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant()) { throw 'vm_identity_mismatch' }
if ($vm.State -ne 'Running') { throw 'vm_must_already_be_running' }

$result = $null
$attempts = @()
$stored = Import-Clixml -LiteralPath $GuestCredentialPath
$simple = [string]$stored.UserName
foreach ($logon in @("$GuestComputerName\$simple", "$VMName\$simple", ".\$simple", $simple, "localhost\$simple")) {
  try {
    $credential = [pscredential]::new($logon, $stored.Password)
    $session = New-PSSession -VMName $VMName -Credential $credential -ErrorAction Stop
    try {
      $result = Invoke-Command -Session $session -ScriptBlock {
        param($MaxWaitSeconds)
        $deadline = (Get-Date).ToUniversalTime().AddSeconds($MaxWaitSeconds)
        $explorerSeenAtUtc = $null
        $pollCount = 0
        do {
          $pollCount++
          if (Get-Process -Name explorer -ErrorAction SilentlyContinue) {
            $explorerSeenAtUtc = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
            break
          }
          Start-Sleep -Seconds 5
        } while ([datetime]::UtcNow -lt $deadline)
        $winlogonPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
        $winlogon = Get-ItemProperty -LiteralPath $winlogonPath -ErrorAction SilentlyContinue
        $computerSystem = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue
        $quserOutput = $null
        try { $quserOutput = (& quser.exe 2>&1 | Out-String).Trim() } catch { $quserOutput = "quser_failed: $($_.Exception.Message)" }
        [ordered]@{
          poll_count = $pollCount
          max_wait_seconds = $MaxWaitSeconds
          explorer_seen_at_utc = $explorerSeenAtUtc
          explorer_running_now = [bool](Get-Process -Name explorer -ErrorAction SilentlyContinue)
          logged_on_user_name = [string]$computerSystem.UserName
          winlogon_auto_admin_logon = if ($winlogon) { [string]$winlogon.AutoAdminLogon } else { $null }
          winlogon_default_user_name = if ($winlogon -and $winlogon.PSObject.Properties['DefaultUserName']) { [string]$winlogon.DefaultUserName } else { $null }
          winlogon_auto_logon_count = if ($winlogon -and $winlogon.PSObject.Properties['AutoLogonCount']) { [string]$winlogon.AutoLogonCount } else { $null }
          winlogon_force_auto_logon = if ($winlogon -and $winlogon.PSObject.Properties['ForceAutoLogon']) { [string]$winlogon.ForceAutoLogon } else { $null }
          quser_output = $quserOutput
        }
      } -ArgumentList $MaxWaitSeconds
      $attempts += [ordered]@{logon=$logon;ok=$true}
      break
    } finally { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
  } catch { $attempts += [ordered]@{logon=$logon;ok=$false;reason=$_.Exception.GetType().Name} }
}
$report = [ordered]@{
  schema = 1
  verdict = if ($result) { 'PASS' } else { 'NO_DIRECT_SESSION' }
  generated_at_utc = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  vm_name = $vm.Name
  vm_id = ([string]$vm.Id).ToLowerInvariant()
  attempts = $attempts
  result = $result
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportFull) | Out-Null
if (Test-Path -LiteralPath $reportFull) { throw 'report_must_be_create_new' }
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportFull -Encoding UTF8
Write-Host "[evidence1-guest-interactive-logon-diagnostic] $($report.verdict): $reportFull"

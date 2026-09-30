#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [string]$GuestComputerName = 'Evidence1E2E',
  [Parameter(Mandatory)][string]$GuestCredentialPath,
  [Parameter(Mandatory)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$reportFull = [IO.Path]::GetFullPath($ReportPath)
$reportRoot = [IO.Path]::GetFullPath('C:\kmp-eval\scratch\evidence1-guest-auto-logon').TrimEnd('\') + '\'
if (-not $reportFull.StartsWith($reportRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'report_path_not_canonical' }
if (Test-Path -LiteralPath $reportFull) { throw 'report_must_be_create_new' }
if (-not (Test-Path -LiteralPath $GuestCredentialPath -PathType Leaf)) { throw 'guest_credential_missing' }
$vm = Get-VM -Name $VMName -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant()) { throw 'vm_identity_mismatch' }
if ($vm.State -ne 'Running') { throw 'vm_must_already_be_running' }

$stored = Import-Clixml -LiteralPath $GuestCredentialPath
$simple = [string]$stored.UserName
$result = $null
$attempts = @()
foreach ($logon in @("$GuestComputerName\$simple", "$VMName\$simple", ".\$simple", $simple, "localhost\$simple")) {
  try {
    $credential = [pscredential]::new($logon, $stored.Password)
    $session = New-PSSession -VMName $VMName -Credential $credential -ErrorAction Stop
    try {
      # The plaintext password is materialized only inside this remote scriptblock and is
      # written directly into the guest's own registry; only booleans and non-secret
      # strings ever cross back out to the host side of the PowerShell Direct channel.
      $result = Invoke-Command -Session $session -ScriptBlock {
        param($Credential, $DomainName)
        $networkCredential = $Credential.GetNetworkCredential()
        $winlogonPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
        Set-ItemProperty -LiteralPath $winlogonPath -Name 'AutoAdminLogon' -Value '1' -Type String -Force
        Set-ItemProperty -LiteralPath $winlogonPath -Name 'DefaultUserName' -Value $networkCredential.UserName -Type String -Force
        Set-ItemProperty -LiteralPath $winlogonPath -Name 'DefaultDomainName' -Value $DomainName -Type String -Force
        Set-ItemProperty -LiteralPath $winlogonPath -Name 'DefaultPassword' -Value $networkCredential.Password -Type String -Force
        Remove-ItemProperty -LiteralPath $winlogonPath -Name 'AutoLogonCount' -ErrorAction SilentlyContinue
        $verify = Get-ItemProperty -LiteralPath $winlogonPath
        [ordered]@{
          auto_admin_logon = [string]$verify.AutoAdminLogon
          default_user_name = [string]$verify.DefaultUserName
          default_domain_name = [string]$verify.DefaultDomainName
          auto_logon_count_present = [bool]$verify.PSObject.Properties['AutoLogonCount']
          password_written = ($verify.PSObject.Properties['DefaultPassword'] -and [string]$verify.DefaultPassword -ceq $networkCredential.Password)
        }
      } -ArgumentList $credential, $GuestComputerName
      $attempts += [ordered]@{logon = $logon; ok = $true}
      break
    } finally { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
  } catch { $attempts += [ordered]@{logon = $logon; ok = $false; reason = $_.Exception.GetType().Name} }
}
if (-not $result) { throw 'no_direct_session_established' }
if ($result.auto_admin_logon -cne '1' -or $result.default_user_name -cne $simple -or
    $result.auto_logon_count_present -or -not $result.password_written) { throw 'auto_logon_verification_failed' }

$report = [ordered]@{
  schema = 1
  verdict = 'PASS'
  vm_name = $vm.Name
  vm_id = ([string]$vm.Id).ToLowerInvariant()
  attempts = $attempts
  auto_admin_logon = $result.auto_admin_logon
  default_user_name = $result.default_user_name
  default_domain_name = $result.default_domain_name
  auto_logon_count_present = $result.auto_logon_count_present
  password_confirmed_written = [bool]$result.password_written
  password_value_read_by_host = $false
  generated_at_utc = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportFull) | Out-Null
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportFull -Encoding UTF8
Write-Host "[evidence1-enable-guest-auto-logon] PASS: $reportFull"

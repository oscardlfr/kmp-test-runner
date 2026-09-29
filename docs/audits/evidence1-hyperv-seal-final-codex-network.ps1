#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [Parameter(Mandatory)][string]$GuestCredentialPath,
  [Parameter(Mandatory)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$reportFull = [IO.Path]::GetFullPath($ReportPath)
$reportRoot = [IO.Path]::GetFullPath('C:\kmp-eval\scratch\evidence1-final-codex-network-egress').TrimEnd('\') + '\'
if (-not $reportFull.StartsWith($reportRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'report_path_not_canonical' }
if (Test-Path -LiteralPath $reportFull) { throw 'report_must_be_create_new' }
if (-not (Test-Path -LiteralPath $GuestCredentialPath -PathType Leaf)) { throw 'guest_credential_missing' }
$vm = Get-VM -Name $VMName -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant()) { throw 'vm_identity_mismatch' }
if ($vm.State -ne 'Running') { throw 'vm_must_already_be_running' }
# evidence1-stageb-network-seal.ps1 is a manifest-pinned TrustedSupportFile: the elevated
# runner already verified its hash before this script could even start executing.
$sealScript = Join-Path $PSScriptRoot 'evidence1-stageb-network-seal.ps1'
if (-not (Test-Path -LiteralPath $sealScript -PathType Leaf)) { throw 'network_seal_script_missing' }

$stored = Import-Clixml -LiteralPath $GuestCredentialPath
$simple = [string]$stored.UserName
$guestReportPath = 'C:\Evidence1Ops\final-codex-network-seal.json'
$verified = $null
$isAdmin = $null
$sealErrorMessage = $null
$attempts = @()
foreach ($logon in @("Evidence1E2E\$simple", "$VMName\$simple", ".\$simple", $simple, "localhost\$simple")) {
  try {
    $credential = [pscredential]::new($logon, $stored.Password)
    $session = New-PSSession -VMName $VMName -Credential $credential -ErrorAction Stop
    try {
      $isAdmin = Invoke-Command -Session $session -ScriptBlock {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        [bool]$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
      }
      Invoke-Command -Session $session -ScriptBlock {
        param($Path)
        if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
      } -ArgumentList $guestReportPath
      # Captured explicitly (instead of letting it propagate) so a genuine failure inside
      # the trusted seal script produces an actionable message here rather than being
      # indistinguishable from an unrelated logon-candidate failure below.
      try {
        Invoke-Command -Session $session -FilePath $sealScript -ArgumentList $guestReportPath -ErrorAction Stop
      } catch {
        $sealErrorMessage = $_.Exception.Message
      }
      $verified = Invoke-Command -Session $session -ScriptBlock {
        param($Path)
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
        Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -ErrorAction Stop
      } -ArgumentList $guestReportPath
      $attempts += [ordered]@{logon = $logon; ok = $true}
      break
    } finally { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
  } catch { $attempts += [ordered]@{logon = $logon; ok = $false; reason = $_.Exception.GetType().Name} }
}
if (-not $verified) { throw "network_seal_report_missing: is_admin=$isAdmin seal_error=$sealErrorMessage" }
if ($verified.verdict -cne 'PASS' -or $verified.network_mode -cne 'restricted') { throw 'network_seal_verification_failed' }

$report = [ordered]@{
  schema = 1
  verdict = 'PASS'
  vm_name = $vm.Name
  vm_id = ([string]$vm.Id).ToLowerInvariant()
  attempts = $attempts
  guest_report = $verified
  generated_at_utc = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportFull) | Out-Null
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportFull -Encoding UTF8
Write-Host "[evidence1-seal-final-codex-network] PASS: $reportFull"

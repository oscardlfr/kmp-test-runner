#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [string]$ReportPath = 'C:\kmp-eval\scratch\evidence1-final-codex-auth\graceful-stop.json',
  [ValidateRange(30, 300)][int]$TimeoutSeconds = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$reportFull = [IO.Path]::GetFullPath($ReportPath)
$reportRoot = [IO.Path]::GetFullPath('C:\kmp-eval\scratch\evidence1-final-codex-auth').TrimEnd('\') + '\'
if (-not $reportFull.StartsWith($reportRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'graceful_stop_report_outside_canonical_root'
}

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ([string]$vm.Name -cne 'Evidence1-Runner-E2E' -or
    ([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant()) {
  throw 'graceful_stop_vm_identity_mismatch'
}

$requested = $false
if ([string]$vm.State -cne 'Off') {
  $requested = $true
  $job = Stop-VM -Name $VMName -Confirm:$false -AsJob -ErrorAction Stop
  if (-not (Wait-Job -Job $job -Timeout $TimeoutSeconds)) {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    throw 'graceful_stop_timeout_no_hard_power_fallback'
  }
  Receive-Job -Job $job -ErrorAction Stop | Out-Null
  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
}

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ([string]$vm.State -cne 'Off' -or ([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant()) {
  throw 'graceful_stop_not_confirmed'
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportFull) | Out-Null
if (Test-Path -LiteralPath $reportFull) { throw 'graceful_stop_report_must_be_create_new' }
[ordered]@{
  schema = 1
  verdict = 'PASS'
  vm_name = [string]$vm.Name
  vm_id = ([string]$vm.Id).ToLowerInvariant()
  vm_state = [string]$vm.State
  graceful_stop_requested = $requested
  hard_power_fallback_used = $false
  generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $reportFull -Encoding UTF8

Write-Host "[evidence1-final-codex-auth-stop] PASS: $reportFull"

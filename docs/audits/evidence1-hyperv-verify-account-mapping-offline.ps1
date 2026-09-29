#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner-E2E',
  [string]$ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
  [Parameter(Mandatory)][string]$ReportPath,
  [Parameter(Mandatory)][string]$ExpectedClaudeAccount,
  [Parameter(Mandatory)][string]$ExpectedCodexAccount
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking
$fullReport = [IO.Path]::GetFullPath($ReportPath)
if (-not $fullReport.StartsWith('C:\kmp-eval\scratch\evidence1-account-mapping\', [StringComparison]::OrdinalIgnoreCase)) { throw 'report_path_invalid' }
if (Test-Path -LiteralPath $fullReport) { throw 'report_must_be_create_new' }

function Test-Identity([string]$Value, [string]$Expected) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
  $candidate = $Value.Trim()
  if ($candidate.Equals($Expected, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  if ($candidate -match '^([^@]+)@[^@]+$') { return $Matches[1].Equals($Expected, [StringComparison]::OrdinalIgnoreCase) }
  return $false
}
function ConvertFrom-Jwt([string]$Value) {
  if ($Value -notmatch '^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$') { return $null }
  try {
    $payload = $Matches[1].Replace('-', '+').Replace('_', '/')
    switch ($payload.Length % 4) { 2 { $payload += '==' } 3 { $payload += '=' } 1 { return $null } }
    return ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json -ErrorAction Stop)
  } catch { return $null }
}
function Find-Identity($Value, [string]$Expected, [int]$Depth = 0) {
  if ($null -eq $Value -or $Depth -gt 20) { return $false }
  if ($Value -is [string]) {
    if (Test-Identity $Value $Expected) { return $true }
    $jwt = ConvertFrom-Jwt $Value
    return $null -ne $jwt -and (Find-Identity $jwt $Expected ($Depth + 1))
  }
  if ($Value -is [System.Collections.IDictionary]) {
    foreach ($key in $Value.Keys) { if (Find-Identity $Value[$key] $Expected ($Depth + 1)) { return $true } }
    return $false
  }
  if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [pscustomobject]) {
    foreach ($entry in $Value) { if (Find-Identity $entry $Expected ($Depth + 1)) { return $true } }
    return $false
  }
  if ($Value -is [pscustomobject]) {
    foreach ($property in $Value.PSObject.Properties) { if (Find-Identity $property.Value $Expected ($Depth + 1)) { return $true } }
  }
  return $false
}
function Test-JsonFiles([string[]]$Paths, [string]$Expected) {
  $existing = @($Paths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -Unique)
  foreach ($path in $existing) {
    try {
      $value = Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      if (Find-Identity $value $Expected) { return [ordered]@{ matched = $true; files_checked = $existing.Count } }
    } catch { }
  }
  return [ordered]@{ matched = $false; files_checked = $existing.Count }
}

$vm = Get-VM -Name $VMName -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant()) { throw 'vm_identity_mismatch' }
if ([string]$vm.State -cne 'Off') {
  Stop-VM -VM $vm -Force -TurnOff -ErrorAction Stop | Out-Null
  $vm = Get-VM -Name $VMName -ErrorAction Stop
}
if ([string]$vm.State -cne 'Off') { throw 'vm_stop_not_confirmed' }
$disk = (Get-VMHardDiskDrive -VMName $VMName -ErrorAction Stop | Select-Object -First 1).Path
if (-not ([IO.Path]::GetFullPath($disk)).StartsWith('C:\kmp-eval\hyperv-e2e\', [StringComparison]::OrdinalIgnoreCase)) { throw 'vhd_scope_invalid' }
$mount = $null
try {
  $mount = Mount-VHD -Path $disk -ReadOnly -Passthru -ErrorAction Stop
  $root = Get-E1FinalMountedWindowsRoot $mount
  $codexFiles = @((Join-Path $root 'Evidence1RuntimeState\codex\auth.json'), (Join-Path $root 'Users\Evidence1E2E\.codex\auth.json'))
  $claudeFiles = @(
    (Join-Path $root 'Evidence1RuntimeState\claude\.credentials.json'),
    (Join-Path $root 'Evidence1RuntimeState\claude\credentials.json'),
    (Join-Path $root 'Users\Evidence1E2E\.claude\.credentials.json'),
    (Join-Path $root 'Users\Evidence1E2E\.claude.json')
  )
  $codexExpected = Test-JsonFiles $codexFiles $ExpectedCodexAccount
  $claudeExpected = Test-JsonFiles $claudeFiles $ExpectedClaudeAccount
  $report = [ordered]@{
    schema = 1; verdict = $(if ($codexExpected.matched -and $claudeExpected.matched) { 'PASS' } else { 'FAIL' })
    expected_mapping = [ordered]@{ claude = $ExpectedClaudeAccount; codex = $ExpectedCodexAccount }
    checks = [ordered]@{
      codex = $codexExpected; claude = $claudeExpected
      crossed_identity_check = [ordered]@{
        codex_matches_claude_account = [bool](Test-JsonFiles $codexFiles $ExpectedClaudeAccount).matched
        claude_matches_codex_account = [bool](Test-JsonFiles $claudeFiles $ExpectedCodexAccount).matched
      }
    }
    vm_state = [string]$vm.State; vhd_read_only = $true; provider_process_started = $false
    final_provider_sessions_consumed = 0; raw_tokens_persisted = $false; raw_tokens_printed = $false
    generated_at_utc = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $fullReport) | Out-Null
  [IO.File]::WriteAllText($fullReport, ($report | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
  Write-Host "[evidence1-verify-account-mapping-offline] $($report.verdict): $fullReport"
} finally {
  if ($mount) { Dismount-VHD -Path $disk -ErrorAction SilentlyContinue }
}

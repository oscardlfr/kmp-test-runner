#Requires -RunAsAdministrator

param(
  [string]$TaskName = 'Evidence1HostElevatedRunner',
  [string]$RunnerPath = '',
  [string]$QueueRoot = 'C:\kmp-eval\scratch\host-elevated-runner',
  [string]$AllowedRoot = '',
  [string]$ReportPath = 'C:\kmp-eval\scratch\host-elevated-runner\INSTALL.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail($Message) {
  Write-Error "HARD STOP: $Message"
  exit 1
}

function Resolve-FullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-PathInside([string]$Candidate, [string]$Root, [string]$Label) {
  $candidateFull = Resolve-FullPath $Candidate
  $rootFull = (Resolve-FullPath $Root).TrimEnd('\') + '\'
  if (-not $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "$Label path is outside expected root: $candidateFull"
  }
}

$AllowedRoot = if ([string]::IsNullOrWhiteSpace($AllowedRoot)) {
  Resolve-FullPath $PSScriptRoot
} else {
  Resolve-FullPath $AllowedRoot
}
$RunnerPath = if ([string]::IsNullOrWhiteSpace($RunnerPath)) {
  Resolve-FullPath (Join-Path $AllowedRoot 'evidence1-host-elevated-runner.ps1')
} else {
  Resolve-FullPath $RunnerPath
}
$QueueRoot = Resolve-FullPath $QueueRoot
$ReportPath = Resolve-FullPath $ReportPath
Assert-PathInside $RunnerPath $AllowedRoot 'runner'
Assert-PathInside $QueueRoot 'C:\kmp-eval\scratch\' 'queue'
Assert-PathInside $ReportPath 'C:\kmp-eval\scratch\' 'report'

if (-not (Test-Path -LiteralPath $RunnerPath)) {
  Fail "runner script does not exist: $RunnerPath"
}

New-Item -ItemType Directory -Force -Path $QueueRoot,(Split-Path -Parent $ReportPath) | Out-Null

$actionArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$RunnerPath`" -QueueRoot `"$QueueRoot`" -AllowedRoot `"$AllowedRoot`" -Once"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $actionArgs
$principal = New-ScheduledTaskPrincipal `
  -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 8) `
  -MultipleInstances IgnoreNew

$task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

$report = [ordered]@{
  verdict = 'PASS'
  generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  task_name = $TaskName
  runner_path = $RunnerPath
  allowed_root = $AllowedRoot
  queue_root = $QueueRoot
  run_level = 'Highest'
  logon_type = 'Interactive'
}

($report | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $ReportPath -Encoding UTF8
Write-Host "[host-elevated-runner-install] PASS: $TaskName"

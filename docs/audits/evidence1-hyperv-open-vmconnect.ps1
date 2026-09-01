#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner',
  [string]$HostReportPath = 'C:\kmp-eval\scratch\hyperv-open-vmconnect\HYPERV-OPEN-VMCONNECT.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
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

Assert-PathInside $HostReportPath 'C:\kmp-eval\scratch\' 'host report'
if ($VMName -cne 'Evidence1-Runner') {
  Fail 'VMName is fixed to the dedicated Evidence1 runner'
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $HostReportPath) | Out-Null

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ($vm.State -ne 'Running') {
  Fail "$VMName must be running before opening VMConnect"
}

$vmconnect = Join-Path $env:WINDIR 'System32\vmconnect.exe'
if (-not (Test-Path -LiteralPath $vmconnect -PathType Leaf)) {
  Fail 'vmconnect.exe was not found at the expected system path'
}

$process = Start-Process -FilePath $vmconnect -ArgumentList @('localhost', $VMName) -PassThru
Start-Sleep -Seconds 2
$report = [ordered]@{
  schema = 1
  verdict = if ($process -and -not $process.HasExited) { 'PASS' } else { 'FAIL' }
  generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  vm_name = $VMName
  vm_state = $vm.State.ToString()
  process_started = $null -ne $process
  input_injected = $false
}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $HostReportPath -Encoding UTF8
if ($report.verdict -ne 'PASS') {
  Fail "VMConnect did not remain open; see $HostReportPath"
}
Write-Host "[hyperv-open-vmconnect] PASS: $HostReportPath"

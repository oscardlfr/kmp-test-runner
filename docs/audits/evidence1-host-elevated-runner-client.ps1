param(
  [Parameter(Mandatory = $true)]
  [string]$ScriptPath,
  [string[]]$ScriptArguments = @(),
  [string]$ScriptArgumentsJson = '',
  [string]$TaskName = 'Evidence1HostElevatedRunner',
  [string]$QueueRoot = 'C:\kmp-eval\scratch\host-elevated-runner',
  [string]$AllowedRoot = '',
  [int]$TimeoutMinutes = 120
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

$QueueRoot = Resolve-FullPath $QueueRoot
$AllowedRoot = if ([string]::IsNullOrWhiteSpace($AllowedRoot)) {
  Resolve-FullPath $PSScriptRoot
} else {
  Resolve-FullPath $AllowedRoot
}
Assert-PathInside $QueueRoot 'C:\kmp-eval\scratch\' 'queue'
$RequestDir = Join-Path $QueueRoot 'requests'
$InProgressDir = Join-Path $QueueRoot 'in-progress'
$ResponseDir = Join-Path $QueueRoot 'responses'
$StaleDir = Join-Path $QueueRoot 'stale'
New-Item -ItemType Directory -Force -Path $RequestDir,$InProgressDir,$ResponseDir,$StaleDir | Out-Null

foreach ($queueDir in @($RequestDir, $InProgressDir)) {
  Get-ChildItem -LiteralPath $queueDir -Filter '*.request.json' -File -ErrorAction SilentlyContinue |
    ForEach-Object {
      $staleName = '{0}.{1}.{2}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), (Split-Path -Leaf $queueDir), $_.Name
      Move-Item -LiteralPath $_.FullName -Destination (Join-Path $StaleDir $staleName) -Force
    }
  }

$scriptFull = Resolve-FullPath $ScriptPath
Assert-PathInside $scriptFull $AllowedRoot 'script'

if ($ScriptArgumentsJson) {
  $parsedArguments = $ScriptArgumentsJson | ConvertFrom-Json
  $ScriptArguments = @($parsedArguments | ForEach-Object { [string]$_ })
}

$id = 'req-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + ([Guid]::NewGuid().ToString('N').Substring(0, 8))
$requestPath = Join-Path $RequestDir "$id.request.json"
$responsePath = Join-Path $ResponseDir "$id.response.json"

$request = [ordered]@{
  id = $id
  created_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  script_path = $scriptFull
  arguments = @($ScriptArguments)
}
($request | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $requestPath -Encoding UTF8

$run = & schtasks.exe /Run /TN $TaskName 2>&1
if ($LASTEXITCODE -ne 0) {
  Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
  Fail "failed to start scheduled task $TaskName`: $($run -join ' ')"
}

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath $responsePath) {
    $response = Get-Content -LiteralPath $responsePath -Raw | ConvertFrom-Json
    $response | ConvertTo-Json -Depth 5
    if ($response.log_path -and (Test-Path -LiteralPath $response.log_path)) {
      Write-Host "[host-elevated-runner-client] log tail: $($response.log_path)"
      Get-Content -LiteralPath $response.log_path -Tail 80
    }
    exit ([int]$response.exit_code)
  }
  Start-Sleep -Seconds 2
}

Fail "timed out waiting for elevated runner response: $responsePath"

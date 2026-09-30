param(
  [Parameter(Mandatory = $true)]
  [string]$ScriptPath,
  [string[]]$ScriptArguments = @(),
  [string]$ScriptArgumentsJson = '',
  [string]$ScriptArgumentsBase64 = '',
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

$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $queueIdentity = [BitConverter]::ToString(
    $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($QueueRoot.ToLowerInvariant()))
  ).Replace('-', '').Substring(0, 24)
} finally { $sha256.Dispose() }
$clientMutex = [Threading.Mutex]::new($false, "Local\Evidence1RunnerClient-$queueIdentity")
try {
  $ownsClientMutex = $clientMutex.WaitOne(0)
} catch [Threading.AbandonedMutexException] {
  $ownsClientMutex = $true
}
if (-not $ownsClientMutex) { Fail 'runner_queue_busy: another client owns this queue' }

$queuedRequests = @(Get-ChildItem -LiteralPath $RequestDir -Filter '*.request.json' -File -ErrorAction SilentlyContinue)
$activeRequests = @(Get-ChildItem -LiteralPath $InProgressDir -Filter '*.request.json' -File -ErrorAction SilentlyContinue)
if ($queuedRequests.Count -ne 0 -or $activeRequests.Count -ne 0) {
  Fail "runner_queue_busy: queued=$($queuedRequests.Count); in_progress=$($activeRequests.Count)"
}

$scriptFull = Resolve-FullPath $ScriptPath
Assert-PathInside $scriptFull $AllowedRoot 'script'

if ($ScriptArgumentsJson -and $ScriptArgumentsBase64) {
  Fail 'script arguments must use exactly one encoded transport'
}
if ($ScriptArgumentsBase64) {
  try {
    $argumentBytes = [Convert]::FromBase64String($ScriptArgumentsBase64)
    $ScriptArgumentsJson = [Text.UTF8Encoding]::new($false, $true).GetString($argumentBytes)
  } catch {
    Fail 'script arguments base64 is invalid'
  }
}
if ($ScriptArgumentsJson) {
  $parsedArguments = $ScriptArgumentsJson | ConvertFrom-Json -ErrorAction Stop
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

# $deadline is computed here, BEFORE the retry loop below, specifically so
# that loop can be bounded by the same -TimeoutMinutes contract as the
# response wait -- see that loop's own comment for why (a task stuck
# Running forever must still fail at
# TimeoutMinutes, the same as it always has, not spin unbounded).
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)

# Wedge fix (flake investigation): schtasks /Run can report
# success while silently dropping the actual start when it races a
# still-tearing-down -Once instance (MultipleInstances=IgnoreNew) -- confirmed
# live against the real broker. A dropped trigger with no retry orphans
# $requestPath forever, wedging this queue for every later caller. Re-trigger,
# bounded, while the request is still unclaimed (still sitting in
# $RequestDir) and the task isn't already Running. Safe: the runner claims
# via Move-Item, so a redundant trigger can never cause double-processing.
#
# Bounded by BOTH -MaxTriggerAttempts AND $deadline: a task that reports
# Running forever (genuinely hung, not just mid-teardown) would otherwise
# never increment $triggerAttempts at all (the Running branch below
# `continue`s without touching it), which -- before this review fix -- left
# this loop's only other exit condition, "request claimed," never satisfied
# either, spinning unbounded instead of failing at -TimeoutMinutes like every
# other wait in this script always has.
$triggerAttempts = 1
$maxTriggerAttempts = 6
$retriggerIntervalSeconds = 5
$lastTriggerAt = Get-Date
while ($triggerAttempts -lt $maxTriggerAttempts -and (Get-Date) -lt $deadline -and
       (Test-Path -LiteralPath $requestPath -PathType Leaf)) {
  Start-Sleep -Seconds 1
  if (-not (Test-Path -LiteralPath $requestPath -PathType Leaf)) { break }
  if (((Get-Date) - $lastTriggerAt).TotalSeconds -lt $retriggerIntervalSeconds) { continue }
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -ne $task -and [string]$task.State -ceq 'Running') { continue }
  $run = & schtasks.exe /Run /TN $TaskName 2>&1
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
    Fail "failed to re-trigger scheduled task $TaskName`: $($run -join ' ')"
  }
  $triggerAttempts++
  $lastTriggerAt = Get-Date
}

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

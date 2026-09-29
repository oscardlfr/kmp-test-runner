param(
  [Parameter(Mandatory)][string]$OperationRoot,
  [Parameter(Mandatory)][string]$RemoteAuthCanaryOperationId,
  [ValidateSet('DryRun','Live','FakeRuntime')][string]$Mode = 'Live',
  [string]$LauncherPath = '',
  [string]$StatusPath = '',
  [string]$TerminalPath = '',
  [string]$FakeRuntimeScript = '',
  [switch]$TestMode,
  [switch]$ShutdownOnExit,
  [ValidateRange(30,86400)][int]$TimeoutSeconds = 4000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1') -Force
if(-not $LauncherPath){$LauncherPath=Join-Path $PSScriptRoot 'evidence1-dual-condition-canary-launch.ps1'}

function Write-E1AtomicJson([string]$Path, $Value) {
  $parent = Split-Path -Parent $Path
  $null = New-Item -ItemType Directory -Path $parent -Force
  $temporary = Join-Path $parent ((Split-Path -Leaf $Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [IO.File]::WriteAllText($temporary,($Value | ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
  } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

$binding = Get-Content -LiteralPath (Join-Path $OperationRoot 'binding.json') -Raw | ConvertFrom-Json -ErrorAction Stop
$controlRoot=Join-Path 'C:\Evidence1Ops\dual-condition-control' "$($binding.pair_id)\$($binding.group_run_id)"
if(-not $StatusPath){$StatusPath=Join-Path $controlRoot 'status.json'}
if(-not $TerminalPath){$TerminalPath=Join-Path $controlRoot 'terminal.json'}
if((Test-Path -LiteralPath $StatusPath) -or (Test-Path -LiteralPath $TerminalPath)){throw 'dual_condition_wrapper_replay'}
$started = [DateTime]::UtcNow
$status = [ordered]@{ schema=1; pair_id=$binding.pair_id; group_run_id=$binding.group_run_id; arm=$binding.arm;
  state='starting'; started_at_utc=$started.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); planned_sessions=2;
  runtime_order=@($binding.runtime_order); process_tree_cleanup_confirmed=$false; raw_content_persisted=$false }
Write-E1AtomicJson $StatusPath $status
$terminal = $null; $operation = $null; $joined = $false; $cleanup = $null
try {
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if ($TestMode) { $powershell = (Get-Process -Id $PID).Path }
  $arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$LauncherPath,'-Mode',$Mode,
    '-OperationRoot',$OperationRoot,'-RemoteAuthCanaryOperationId',$RemoteAuthCanaryOperationId)
  if ($TestMode) { $arguments += '-TestMode' }
  if ($FakeRuntimeScript) { $arguments += @('-FakeRuntimeScript',$FakeRuntimeScript) }
  $stdoutPath=Join-Path (Split-Path -Parent $StatusPath) 'dual-condition.stdout.tmp'
  $stderrPath=Join-Path (Split-Path -Parent $StatusPath) 'dual-condition.stderr.tmp'
  $operation = Start-E1OwnedProcess $powershell $arguments $PSScriptRoot $stdoutPath $stderrPath $TimeoutSeconds
  while (-not $operation.Task.IsCompleted) {
    $status.state='running'; $status.elapsed_seconds=[int]([DateTime]::UtcNow-$started).TotalSeconds
    Write-E1AtomicJson $StatusPath $status
    Start-Sleep -Milliseconds 250
  }
  $result = Wait-E1OwnedProcess $operation; $joined=$true
  if ($result.TimedOut -or $result.Cancelled -or -not $result.CleanupOk) { throw 'dual_condition_wrapper_cleanup' }
  $launcherReason=$null
  if([int]$result.ExitCode-ne0){
    $stderrText=$(if(Test-Path -LiteralPath $stderrPath -PathType Leaf){[IO.File]::ReadAllText($stderrPath)}else{''})
    $match=[regex]::Match($stderrText,'dual_condition_[a-z0-9_.:-]{1,112}')
    $launcherReason=$(if($match.Success){$match.Value}else{'launcher_failed'})
  }
  $terminal = [ordered]@{ schema=1; pair_id=$binding.pair_id; group_run_id=$binding.group_run_id; arm=$binding.arm;
    state=$(if ($result.ExitCode -eq 0) {'completed'} else {'failed'}); exit_code=[int]$result.ExitCode;
    completed_at_utc=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); process_tree_cleanup_confirmed=$true;
    planned_sessions=2; retry_count=0; retry_authorized=$false; replacement_or_respawn_used=$false; raw_content_persisted=$false;
    reason_code=$launcherReason }
} catch {
  $reasonCode=[string]$_.Exception.Message
  if($reasonCode-cnotmatch'^dual_condition_[a-z0-9_.:-]{1,112}$'){$reasonCode='wrapper_failure'}
  if ($operation -and -not $joined) {
    try { Stop-E1OwnedProcess $operation; $cleanup=Wait-E1OwnedProcess $operation } catch { $cleanup=$null }
  }
  $terminal = [ordered]@{ schema=1; pair_id=$binding.pair_id; group_run_id=$binding.group_run_id; arm=$binding.arm;
    state='safety_stopped'; exit_code=997; completed_at_utc=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');
    process_tree_cleanup_confirmed=[bool]($cleanup -and $cleanup.CleanupOk); planned_sessions=2; retry_count=0;
    retry_authorized=$false; replacement_or_respawn_used=$false; raw_content_persisted=$false; reason_code=$reasonCode }
} finally {
  Write-E1AtomicJson $TerminalPath $terminal
  $status.state=$terminal.state; $status.process_tree_cleanup_confirmed=$terminal.process_tree_cleanup_confirmed
  Write-E1AtomicJson $StatusPath $status
  Remove-Item -LiteralPath (Join-Path (Split-Path -Parent $StatusPath) 'dual-condition.stdout.tmp'),(Join-Path (Split-Path -Parent $StatusPath) 'dual-condition.stderr.tmp') -Force -ErrorAction SilentlyContinue
  if ($ShutdownOnExit) { & (Join-Path $env:SystemRoot 'System32\shutdown.exe') /s /t 10 /f | Out-Null }
}
exit [int]$terminal.exit_code

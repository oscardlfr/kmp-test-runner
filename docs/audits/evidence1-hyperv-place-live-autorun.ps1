#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner',
  [string]$GuestUserName = 'Evidence1',
  [Parameter(Mandatory = $true)]
  [string]$LiveLauncherSourcePath,
  [string]$GuestOpsDir = 'C:\Evidence1Ops',
  [string]$GuestHarnessDir = 'C:\kmp-eval\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1',
  [string]$GuestScratchDir = 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1',
  [string]$ReportPath = 'C:\kmp-eval\scratch\hyperv-place-live-autorun\HYPERV-PLACE-LIVE-AUTORUN.json',
  [string]$LiveAuthorizationPhrase = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RequiredLivePhrase = (
  'AUTORIZO HASTA 16 SESIONES LIVE NUEVAS DEL EVIDENCE' +
  '1 CLAUDE WINDOWS 2X2 COVERAGE-THRESHOLD POST-CAMPAIGN EN ESTE ENTORNO AISLADO, SIN REINTENTOS, REEMPLAZOS NI RESPAWNS'
)

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

Assert-PathInside $ReportPath 'C:\kmp-eval\scratch\' 'report'
if ($GuestOpsDir -ne 'C:\Evidence1Ops') {
  Fail "GuestOpsDir must stay exactly C:\Evidence1Ops for this evidence runner"
}
Assert-PathInside $GuestHarnessDir 'C:\kmp-eval\' 'guest harness'
Assert-PathInside $GuestScratchDir 'C:\kmp-eval\scratch\' 'guest scratch'
if ($LiveAuthorizationPhrase -ne $RequiredLivePhrase) {
  Fail 'exact Stage B live authorization phrase is required before placing live autorun'
}
if (-not (Test-Path -LiteralPath $LiveLauncherSourcePath)) {
  Fail "live launcher source missing: $LiveLauncherSourcePath"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath) | Out-Null

$launcherHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $LiveLauncherSourcePath).Hash.ToLowerInvariant()
$launcherLength = (Get-Item -LiteralPath $LiveLauncherSourcePath).Length

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ($vm.State -ne 'Off') {
  Fail "placing live autorun requires $VMName to be Off, got $($vm.State)"
}

$activeDisk = Get-VMHardDiskDrive -VMName $VMName | Select-Object -First 1
if (-not $activeDisk -or -not $activeDisk.Path) {
  Fail "could not resolve active VM disk for $VMName"
}
$vhdPath = Resolve-FullPath $activeDisk.Path
Assert-PathInside $vhdPath 'C:\kmp-eval\hyperv\' 'active VHD'

$mount = $null
try {
  $mount = Mount-VHD -Path $vhdPath -Passthru
  $disk = $mount | Get-Disk
  $volume = $disk | Get-Partition | Get-Volume | Where-Object {
    $_.DriveLetter -and (Test-Path "$($_.DriveLetter):\Windows")
  } | Select-Object -First 1
  if (-not $volume) {
    Fail 'could not find mounted Windows volume in VHD'
  }

  $driveRoot = "$($volume.DriveLetter):\"
  $guestOpsOnHost = Join-Path $driveRoot ($GuestOpsDir.Substring(3))
  New-Item -ItemType Directory -Force -Path $guestOpsOnHost | Out-Null

  $launcherGuestPath = Join-Path $GuestOpsDir 'evidence1-stageb-live-launch.ps1'
  $launcherOnHost = Join-Path $guestOpsOnHost 'evidence1-stageb-live-launch.ps1'
  Copy-Item -LiteralPath $LiveLauncherSourcePath -Destination $launcherOnHost -Force

  $startupDir = Join-Path $driveRoot "Users\$GuestUserName\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup"
  if (-not (Test-Path -LiteralPath $startupDir)) {
    Fail "guest Startup directory not found: $startupDir"
  }

  foreach ($startupFile in @(
    'Evidence1RunReadiness.cmd',
    'Evidence1RunLive.cmd',
    'Evidence1OpenClaude.cmd',
    'Evidence1AuthVerify.cmd'
  )) {
    Remove-Item -LiteralPath (Join-Path $startupDir $startupFile) -Force -ErrorAction SilentlyContinue
  }
  foreach ($opsFile in @(
    'run-stageb-live.ps1',
    'STAGE-B-live.exit.txt',
    'STAGE-B-live-wrapper.log',
    'STAGE-B-live.stdout.log',
    'STAGE-B-live.stderr.log',
    'STAGE-B-live.status.json'
  )) {
    Remove-Item -LiteralPath (Join-Path $guestOpsOnHost $opsFile) -Force -ErrorAction SilentlyContinue
  }

  $runnerGuestPath = Join-Path $GuestOpsDir 'run-stageb-live.ps1'
  $runnerOnHost = Join-Path $guestOpsOnHost 'run-stageb-live.ps1'
  Set-Content -LiteralPath $runnerOnHost -Encoding UTF8 -Value @"
`$ErrorActionPreference = 'Continue'
`$launcherPath = '$launcherGuestPath'
`$opsDir = '$GuestOpsDir'
`$harnessDir = '$GuestHarnessDir'
`$liveLogPath = '$GuestScratchDir\STAGE-B-live.log'
`$exitPath = Join-Path `$opsDir 'STAGE-B-live.exit.txt'
`$wrapperLogPath = Join-Path `$opsDir 'STAGE-B-live-wrapper.log'
`$stdoutPath = Join-Path `$opsDir 'STAGE-B-live.stdout.log'
`$stderrPath = Join-Path `$opsDir 'STAGE-B-live.stderr.log'
`$statusPath = Join-Path `$opsDir 'STAGE-B-live.status.json'
`$shutdownExe = Join-Path `$env:SystemRoot 'System32\shutdown.exe'
function Get-JournalProgress {
  `$journalRoot = Join-Path `$harnessDir 'tools\runs\agentic-eval-journal'
  if (-not (Test-Path -LiteralPath `$journalRoot)) {
    return [ordered]@{ journal_id = `$null; event_count = 0; latest_event = `$null; latest_event_utc = `$null; transition_counts = @{}; raw_files = 0; stderr_files = 0 }
  }
  `$journal = Get-ChildItem -LiteralPath `$journalRoot -Directory -Force -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (`$null -eq `$journal) {
    return [ordered]@{ journal_id = `$null; event_count = 0; latest_event = `$null; latest_event_utc = `$null; transition_counts = @{}; raw_files = 0; stderr_files = 0 }
  }
  `$eventsDir = Join-Path `$journal.FullName 'events'
  `$events = if (Test-Path -LiteralPath `$eventsDir) { @(Get-ChildItem -LiteralPath `$eventsDir -Filter '*.json' -File -Force -ErrorAction SilentlyContinue | Sort-Object Name) } else { @() }
  `$transitionCounts = [ordered]@{}
  foreach (`$event in `$events) {
    if (`$event.Name -match '^[0-9]+-[0-9]+-(.+)\.json$') {
      `$transition = `$matches[1]
      if (-not `$transitionCounts.Contains(`$transition)) { `$transitionCounts[`$transition] = 0 }
      `$transitionCounts[`$transition] += 1
    }
  }
  `$latest = `$events | Select-Object -Last 1
  return [ordered]@{
    journal_id = `$journal.Name
    event_count = `$events.Count
    latest_event = if (`$latest) { `$latest.Name } else { `$null }
    latest_event_utc = if (`$latest) { `$latest.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } else { `$null }
    transition_counts = `$transitionCounts
    raw_files = if (Test-Path -LiteralPath (Join-Path `$journal.FullName 'raw')) { @(Get-ChildItem -LiteralPath (Join-Path `$journal.FullName 'raw') -File -Force -ErrorAction SilentlyContinue).Count } else { 0 }
    stderr_files = if (Test-Path -LiteralPath (Join-Path `$journal.FullName 'stderr')) { @(Get-ChildItem -LiteralPath (Join-Path `$journal.FullName 'stderr') -File -Force -ErrorAction SilentlyContinue).Count } else { 0 }
  }
}
function Read-ExitCodeMarker {
  param(
    [int]`$Retries = 10,
    [int]`$DelayMilliseconds = 500
  )

  `$paths = @(`$liveLogPath, `$stdoutPath) | Select-Object -Unique
  for (`$attempt = 0; `$attempt -le `$Retries; `$attempt++) {
    foreach (`$path in `$paths) {
      if (-not (Test-Path -LiteralPath `$path)) {
        continue
      }
      try {
        `$exitLine = Get-Content -LiteralPath `$path -Tail 200 -ErrorAction Stop |
          Where-Object { `$_ -match '^EXITCODE:(-?\d+)\s*$' } |
          Select-Object -Last 1
        if (`$exitLine -match '^EXITCODE:(-?\d+)\s*$') {
          return [ordered]@{
            found = `$true
            exit_code = [int]`$Matches[1]
            source = `$path
            line = `$exitLine
          }
        }
      } catch {
        # The launcher may have just exited while redirected streams are still flushing.
      }
    }
    if (`$attempt -lt `$Retries) {
      Start-Sleep -Milliseconds `$DelayMilliseconds
    }
  }

  return [ordered]@{
    found = `$false
    exit_code = `$null
    source = `$null
    line = `$null
  }
}
function Write-ProgressSnapshot([string]`$state, [int]`$exitCode = 125) {
  `$snapshot = [ordered]@{
    schema = 1
    state = `$state
    ts_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    launcher_pid = if (`$script:proc) { `$script:proc.Id } else { `$null }
    elapsed_seconds = if (`$script:started) { [int]((Get-Date) - `$script:started).TotalSeconds } else { 0 }
    exit_code = `$exitCode
    process_exit_code = `$script:processExitCode
    exit_code_source = `$script:exitCodeSource
    exit_marker_source = `$script:exitMarkerSource
    exit_marker_line = `$script:exitMarkerLine
    stdout_bytes = if (Test-Path -LiteralPath `$stdoutPath) { (Get-Item -LiteralPath `$stdoutPath).Length } else { 0 }
    stderr_bytes = if (Test-Path -LiteralPath `$stderrPath) { (Get-Item -LiteralPath `$stderrPath).Length } else { 0 }
    stage_b_live_log_bytes = if (Test-Path -LiteralPath `$liveLogPath) { (Get-Item -LiteralPath `$liveLogPath).Length } else { 0 }
    journal = Get-JournalProgress
  }
  `$json = (`$snapshot | ConvertTo-Json -Depth 8 -Compress)
  Set-Content -LiteralPath `$statusPath -Encoding UTF8 -Value `$json
  try {
    `$regPath = 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest'
    New-Item -Path `$regPath -Force | Out-Null
    New-ItemProperty -Path `$regPath -Name 'Evidence1StageBProgress' -Value `$json -PropertyType String -Force | Out-Null
  } catch {
    # KVP heartbeat is best-effort; the file heartbeat remains authoritative after shutdown.
  }
}
New-Item -ItemType Directory -Force -Path `$opsDir | Out-Null
'[stageb-live-autorun] START ' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') | Set-Content -LiteralPath `$wrapperLogPath -Encoding UTF8
`$exitCode = 125
`$script:proc = `$null
`$script:started = `$null
`$script:processExitCode = `$null
`$script:exitCodeSource = 'default'
`$script:exitMarkerSource = `$null
`$script:exitMarkerLine = `$null
try {
  `$script:started = Get-Date
  Write-ProgressSnapshot 'starting' `$exitCode
  `$script:proc = Start-Process -FilePath (Join-Path `$env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',`$launcherPath) -RedirectStandardOutput `$stdoutPath -RedirectStandardError `$stderrPath -NoNewWindow -PassThru
  while (-not `$script:proc.HasExited) {
    `$script:proc.Refresh()
    Write-ProgressSnapshot 'running' `$exitCode
    Start-Sleep -Seconds 15
  }
  try { `$script:proc.WaitForExit() } catch {}
  `$script:proc.Refresh()
  `$script:processExitCode = if (`$null -ne `$script:proc.ExitCode) { [int]`$script:proc.ExitCode } else { 125 }
  `$marker = Read-ExitCodeMarker
  if (`$marker.found) {
    `$exitCode = [int]`$marker.exit_code
    `$script:exitCodeSource = 'launcher_marker'
    `$script:exitMarkerSource = `$marker.source
    `$script:exitMarkerLine = `$marker.line
  } else {
    `$exitCode = `$script:processExitCode
    `$script:exitCodeSource = 'process_exit_code'
  }
  Write-ProgressSnapshot 'exited' `$exitCode
  '[stageb-live-autorun] EXIT ' + `$exitCode | Add-Content -LiteralPath `$wrapperLogPath -Encoding UTF8
} catch {
  `$_ | Out-String | Add-Content -LiteralPath `$wrapperLogPath -Encoding UTF8
  `$exitCode = 997
  Write-ProgressSnapshot 'wrapper_error' `$exitCode
} finally {
  Set-Content -LiteralPath `$exitPath -Value `$exitCode -Encoding ASCII
  Write-ProgressSnapshot 'shutdown' `$exitCode
  '[stageb-live-autorun] SHUTDOWN ' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') | Add-Content -LiteralPath `$wrapperLogPath -Encoding UTF8
  & `$shutdownExe /s /t 10 /f
  exit `$exitCode
}
"@

  $startupPath = Join-Path $startupDir 'Evidence1RunLive.cmd'
  $exitMarkerGuestPath = Join-Path $GuestOpsDir 'STAGE-B-live.exit.txt'
  $wrapperLogGuestPath = Join-Path $GuestOpsDir 'STAGE-B-live-wrapper.log'
  Set-Content -LiteralPath $startupPath -Encoding ASCII -Value @"
@echo off
set "SELF=%~f0"
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$runnerGuestPath"
del "%SELF%" >nul 2>nul
C:\Windows\System32\shutdown.exe /s /t 10 /f
"@

  $report = [ordered]@{
    verdict = 'PASS'
    generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    vm_name = $VMName
    vhd_path = $vhdPath
    mounted_drive = $driveRoot
    launcher_guest_path = $launcherGuestPath
    runner_guest_path = $runnerGuestPath
    launcher_source_sha256 = $launcherHash
    launcher_source_bytes = $launcherLength
    startup_launcher_relative_path = $startupPath.Substring($driveRoot.Length)
    exit_marker_guest_path = $exitMarkerGuestPath
    wrapper_log_guest_path = $wrapperLogGuestPath
    launch_policy = 'autorun will execute exactly one Stage B live launcher on next guest logon, then remove itself and shut down'
  }
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
  Write-Host "[hyperv-place-live-autorun] PASS: $ReportPath"
} finally {
  if ($mount) {
    Dismount-VHD -Path $vhdPath -ErrorAction SilentlyContinue
  }
}

#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner',
  [string]$GuestComputerName = 'Evidence1Runner',
  [string]$GuestCredentialPath = 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml',
  [string]$GuestOpsDir = 'C:\Evidence1Ops',
  [string]$OutDir = 'C:\kmp-eval\scratch\hyperv-copy-live-artifacts',
  [string]$ExpectedRunId = '',
  [switch]$GracefulShutdown,
  [ValidateRange(30, 900)][int]$GracefulShutdownTimeoutSeconds = 300
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$contractPath = Join-Path $PSScriptRoot 'evidence1-live-run-contract.psm1'
Import-Module $contractPath -Force

function Fail([string]$Code) {
  $known = @(
    'path_outside_root','copy_raw_forbidden','vm_not_off','vm_disk_missing','vm_mount_invalid',
    'vm_volume_missing','vm_shutdown_custody','vm_shutdown_failed','canary_copy_scope',
    'canary_copy_hash','canary_custody_invalid','copy_failed'
  )
  $script:CopyFailureCode = if ($Code -cin $known) { $Code } else { 'copy_failed' }
  throw 'copy_failed'
}

function Resolve-FullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-PathInside([string]$Candidate, [string]$Root, [string]$Label) {
  $candidateFull = Resolve-FullPath $Candidate
  $rootFull = (Resolve-FullPath $Root).TrimEnd('\') + '\'
  if (-not $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    Fail 'path_outside_root'
  }
}

function File-Fact([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return [ordered]@{ exists = $false }
  }
  $item = Get-Item -LiteralPath $Path
  return [ordered]@{
    exists = $true
    length = $item.Length
    last_write_time_utc = $item.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  }
}

function Copy-IfPresent([string]$Source, [string]$Destination) {
  if (Test-Path -LiteralPath $Source) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
  } else {
    Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
  }
  return File-Fact $Destination
}

function Read-ExitCodeFromOperationalLogs([string[]]$Paths) {
  foreach ($path in $Paths) {
    if (-not (Test-Path -LiteralPath $path)) {
      continue
    }
    try {
      $line = Get-Content -LiteralPath $path -Tail 200 -ErrorAction Stop |
        Where-Object { $_ -match '^EXITCODE:(-?\d+)\s*$' } |
        Select-Object -Last 1
      if ($line -match '^EXITCODE:(-?\d+)\s*$') {
        return [string]$Matches[1]
      }
    } catch {
      # Operational logs are best-effort fallbacks; keep the metadata copy robust.
    }
  }
  return $null
}

function Read-TerminalExitCandidate([string]$Path, [string]$Source, [string]$ExpectedRunId) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return [ordered]@{ valid = $false; source = $Source; reason = 'not_found'; exit_code = $null; record = $null }
  }
  try {
    $record = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return [ordered]@{ valid = $false; source = $Source; reason = 'invalid_json'; exit_code = $null; record = $null }
  }

  if ($ExpectedRunId) {
    return Test-Evidence1TerminalRecordObject -Record $record -Source $Source -ExpectedRunId $ExpectedRunId
  }

  $required = @('schema', 'run_id', 'state', 'exit_code', 'exit_code_source')
  $propertyNames = @($record.PSObject.Properties.Name)
  if (@($required | Where-Object { $_ -notin $propertyNames }).Count -gt 0) {
    return [ordered]@{ valid = $false; source = $Source; reason = 'invalid_shape'; exit_code = $null; record = $record }
  }
  if ($record.schema -ne 1 -or
      $record.state -notin @('exited', 'wrapper_error', 'terminated_after_launcher_exit') -or
      ($record.exit_code -isnot [int] -and $record.exit_code -isnot [long])) {
    return [ordered]@{ valid = $false; source = $Source; reason = 'invalid_terminal_record'; exit_code = $null; record = $record }
  }

  return [ordered]@{
    valid = $true
    source = $Source
    reason = $null
    exit_code = [int]$record.exit_code
    record = $record
  }
}

function Resolve-StageBExit {
  $wrapperTerminal = Read-TerminalExitCandidate (Join-Path $OutDir 'STAGE-B-live.exit.json') 'wrapper_terminal' $ExpectedRunId
  if ($wrapperTerminal.valid) { return $wrapperTerminal }

  $launcherTerminal = Read-TerminalExitCandidate (Join-Path $OutDir 'STAGE-B-live.launcher-exit.json') 'launcher_terminal' $ExpectedRunId
  if ($launcherTerminal.valid) { return $launcherTerminal }

  $logExitCode = Read-ExitCodeFromOperationalLogs @(
    (Join-Path $OutDir 'STAGE-B-live.stdout.log'),
    (Join-Path $OutDir 'STAGE-B-live.log')
  )
  if ($null -ne $logExitCode) {
    return [ordered]@{ valid = $true; source = 'operational_log_exitcode'; reason = $null; exit_code = [int]$logExitCode; record = $null }
  }

  $exitMarkerPath = Join-Path $OutDir 'STAGE-B-live.exit.txt'
  if (Test-Path -LiteralPath $exitMarkerPath -PathType Leaf) {
    $exitMarker = (Get-Content -LiteralPath $exitMarkerPath -Raw).Trim()
    if ($exitMarker -match '^-?\d+$') {
      return [ordered]@{ valid = $true; source = 'legacy_exit_txt'; reason = $null; exit_code = [int]$exitMarker; record = $null }
    }
  }

  return [ordered]@{ valid = $false; source = $null; reason = 'no_exit_candidate'; exit_code = $null; record = $null }
}

function Copy-RunFileMetadataOnly([string]$SourceRoot, [string]$LocalRoot, [string]$RelativePath) {
  if ($RelativePath -match '(^|/)raw(/|$)' -or $RelativePath -match '(^|/)stderr(/|$)') {
    Fail 'copy_raw_forbidden'
  }
  $source = Join-Path $SourceRoot ($RelativePath -replace '/', '\')
  $destination = Join-Path $LocalRoot ($RelativePath -replace '/', '\')
  if (Test-Path -LiteralPath $source) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
  }
  return File-Fact $destination
}

function Get-JsonObjectKeys($Value) {
  if ($null -eq $Value) {
    return @()
  }
  if ($Value -is [System.Collections.IDictionary]) {
    return @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object)
  }
  if ($Value -is [pscustomobject]) {
    return @($Value.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
  }
  return @()
}

function Preserve-InterruptedCopyCheckpoint([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
  try { $existing = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
  catch { throw 'copy_checkpoint_invalid' }

  $historicalTerminalKeys = @(
    'verdict','generated_at_utc','vm_name','vm_state','vhd_path','mounted_drive','out_dir',
    'copied','stage_b_exit','stage_b_exit_text','journal_dirs','journal_event_summaries',
    'journal_event_copies','scenario_files','scenario_copies','incident_diagnostics',
    'rejection_diagnostics','local_structured_rejection_details','runs_inventory',
    'raw_content_read','note'
  )
  $actualKeys = @(Get-JsonObjectKeys $existing)
  $matchesHistoricalTerminal = $actualKeys.Count -eq $historicalTerminalKeys.Count -and
    @($actualKeys | Where-Object { $_ -cnotin $historicalTerminalKeys }).Count -eq 0
  $archiveCode = $null
  $archiveIdentity = $null

  if ($matchesHistoricalTerminal) {
    $stageExitKeys = @(Get-JsonObjectKeys $existing.stage_b_exit)
    $terminal = Test-Evidence1TerminalRecordObject `
      -Record $existing.stage_b_exit.record `
      -Source ([string]$existing.stage_b_exit.source) `
      -ExpectedRunId ([string]$existing.stage_b_exit.record.run_id)
    $generatedAtValid = ($existing.generated_at_utc -is [DateTime] -and
        $existing.generated_at_utc.Kind -eq [DateTimeKind]::Utc) -or
      ($existing.generated_at_utc -is [string] -and
        $existing.generated_at_utc -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
    if ([string]$existing.verdict -cne 'PASS' -or
        -not $generatedAtValid -or
        [string]$existing.vm_name -cne $VMName -or [string]$existing.vm_state -cne 'Off' -or
        $existing.raw_content_read -isnot [bool] -or $existing.raw_content_read -or
        $stageExitKeys.Count -ne 5 -or
        @($stageExitKeys | Where-Object { $_ -cnotin @('valid','source','reason','exit_code','record') }).Count -ne 0 -or
        $existing.stage_b_exit.valid -isnot [bool] -or -not $existing.stage_b_exit.valid -or
        $null -ne $existing.stage_b_exit.reason -or -not $terminal.valid -or
        [int]$existing.stage_b_exit.exit_code -ne [int]$terminal.exit_code -or
        [string]$existing.stage_b_exit_text -cne [string]$terminal.exit_code) {
      throw 'copy_checkpoint_invalid'
    }
    $archiveCode = 'terminal'
    $archiveIdentity = 'legacy-' + (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  } else {
    $existingState = [string]$existing.state
    if ($existingState -cin @('passed','failed')) {
    if (($existing.schema -isnot [int] -and $existing.schema -isnot [long]) -or [long]$existing.schema -ne 1 -or
        $existing.raw_content_read -isnot [bool] -or $existing.raw_content_read -or
        ($existingState -ceq 'passed' -and [string]$existing.verdict -cne 'PASS') -or
        ($existingState -ceq 'failed' -and [string]$existing.verdict -cne 'FAIL')) {
      throw 'copy_checkpoint_invalid'
    }
    $archiveCode = 'terminal'
    } elseif ($existingState -cne 'started') {
      throw 'copy_checkpoint_invalid'
    }

    if ($existingState -ceq 'started') {
      $code = [string]$existing.failure_code
      if ($code -cnotin @('copy_interrupted','vm_shutdown_dispatch_pending','vm_shutdown_interrupted')) {
        throw 'copy_checkpoint_invalid'
      }
      $archiveCode = $code
      $baseKeys = @(
        'schema','invocation_id','state','verdict','generated_at_utc','expected_run_id',
        'failure_phase','failure_code','failure_subreason','graceful_shutdown_intent_recorded',
        'graceful_shutdown_requested','graceful_shutdown_completed','raw_content_read'
      )
      $expectedKeys = if ($code -ceq 'copy_interrupted') { $baseKeys } else { @($baseKeys + 'hard_power_fallback_used') }
      if ($actualKeys.Count -ne $expectedKeys.Count -or
          @($actualKeys | Where-Object { $_ -cnotin $expectedKeys }).Count -ne 0 -or
          ($existing.schema -isnot [int] -and $existing.schema -isnot [long]) -or [long]$existing.schema -ne 1 -or
          [string]$existing.verdict -cne 'FAIL' -or [string]$existing.expected_run_id -cne $ExpectedRunId -or
          $existing.raw_content_read -isnot [bool] -or $existing.raw_content_read -or
          $existing.graceful_shutdown_intent_recorded -isnot [bool] -or
          $existing.graceful_shutdown_requested -isnot [bool] -or
          $existing.graceful_shutdown_completed -isnot [bool] -or $existing.graceful_shutdown_completed) {
        throw 'copy_checkpoint_invalid'
      }
      if ($code -ceq 'copy_interrupted') {
        if ($existing.graceful_shutdown_intent_recorded -or $existing.graceful_shutdown_requested) { throw 'copy_checkpoint_invalid' }
      } else {
        if (-not $existing.graceful_shutdown_intent_recorded -or
            ($code -ceq 'vm_shutdown_dispatch_pending' -and $existing.graceful_shutdown_requested) -or
            ($code -ceq 'vm_shutdown_interrupted' -and -not $existing.graceful_shutdown_requested) -or
            $existing.hard_power_fallback_used -isnot [bool] -or $existing.hard_power_fallback_used) {
          throw 'copy_checkpoint_invalid'
        }
      }
    }
    $previousInvocation = [guid]::Empty
    if (-not [guid]::TryParseExact([string]$existing.invocation_id, 'D', [ref]$previousInvocation)) {
      throw 'copy_checkpoint_invalid'
    }
    $archiveIdentity = $previousInvocation.ToString('D')
  }

  $archivePath = Join-Path (Split-Path -Parent $Path) `
    ('HYPERV-COPY-LIVE-ARTIFACTS.{0}.{1}.checkpoint.json' -f $archiveIdentity, $archiveCode)
  if (Test-Path -LiteralPath $archivePath) { throw 'copy_checkpoint_collision' }
  Move-Item -LiteralPath $Path -Destination $archivePath -ErrorAction Stop
}

function Read-RunningTerminal {
  if ($GuestOpsDir -cne 'C:\Evidence1Ops') { Fail 'vm_shutdown_custody' }
  Assert-PathInside $GuestCredentialPath 'C:\kmp-eval\scratch\' 'guest credential'
  if (-not (Test-Path -LiteralPath $GuestCredentialPath -PathType Leaf)) { Fail 'vm_shutdown_custody' }

  $storedCredential = Import-Clixml -LiteralPath $GuestCredentialPath
  $simpleUser = $storedCredential.UserName
  $candidates = @(
    "$GuestComputerName\$simpleUser",
    "$VMName\$simpleUser",
    ".\$simpleUser",
    $simpleUser,
    "localhost\$simpleUser"
  )
  $session = $null
  foreach ($logonName in $candidates) {
    try {
      $credential = [pscredential]::new($logonName, $storedCredential.Password)
      $session = New-PSSession -VMName $VMName -Credential $credential -ErrorAction Stop
      break
    } catch {
      $session = $null
    }
  }
  if (-not $session) { Fail 'vm_shutdown_custody' }

  try {
    $records = Invoke-Command -Session $session -ScriptBlock {
      param($OpsDir)
      $result = [ordered]@{ wrapper = $null; launcher = $null }
      foreach ($entry in @(
        @{ key = 'wrapper'; name = 'STAGE-B-live.exit.json' },
        @{ key = 'launcher'; name = 'STAGE-B-live.launcher-exit.json' }
      )) {
        $path = Join-Path $OpsDir $entry.name
        if (Test-Path -LiteralPath $path -PathType Leaf) {
          try {
            $record = Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            $canary = $null
            if ($record.PSObject.Properties['canary']) {
              $canary = [ordered]@{
                arm = $record.canary.arm
                planned_sessions = $record.canary.planned_sessions
                binding_sha256 = $record.canary.binding_sha256
              }
            }
            $result[$entry.key] = [pscustomobject][ordered]@{
              schema = $record.schema
              run_id = $record.run_id
              state = $record.state
              exit_code = $record.exit_code
              exit_code_source = $record.exit_code_source
              canary = $canary
            }
          } catch { $result[$entry.key] = $null }
        }
      }
      [pscustomobject]$result
    } -ArgumentList $GuestOpsDir
    $wrapper = Test-Evidence1TerminalRecordObject -Record $records.wrapper -Source 'powershell_direct_terminal' -ExpectedRunId $ExpectedRunId
    if ($wrapper.valid) { return $wrapper.record }
    $launcher = Test-Evidence1TerminalRecordObject -Record $records.launcher -Source 'powershell_direct_launcher_terminal' -ExpectedRunId $ExpectedRunId
    if ($launcher.valid) { return $launcher.record }
    Fail 'vm_shutdown_custody'
  } catch {
    if ($script:CopyFailureCode -cne 'vm_shutdown_custody') { Fail 'vm_shutdown_custody' }
    throw
  } finally {
    Remove-PSSession -Session $session -ErrorAction SilentlyContinue
  }
}

Assert-PathInside $OutDir 'C:\kmp-eval\scratch\' 'out dir'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$copyReportPath = Join-Path $OutDir 'HYPERV-COPY-LIVE-ARTIFACTS.json'
$copyInvocationId = [guid]::NewGuid().ToString('D')
$copyExitCode = 0
$script:CopyFailureCode = 'copy_failed'
$currentStage = 'initialize'
$terminalReport = $null
try { Preserve-InterruptedCopyCheckpoint $copyReportPath }
catch {
  Write-Error 'HARD STOP: copy_checkpoint_preserve_failed'
  exit 1
}
$startedReport = [ordered]@{
  schema = 1
  invocation_id = $copyInvocationId
  state = 'started'
  verdict = 'FAIL'
  generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  expected_run_id = if ($ExpectedRunId) { $ExpectedRunId } else { $null }
  failure_phase = 'copy'
  failure_code = 'copy_interrupted'
  failure_subreason = $null
  graceful_shutdown_intent_recorded = $false
  graceful_shutdown_requested = $false
  graceful_shutdown_completed = $false
  raw_content_read = $false
}
Write-Evidence1JsonAtomically -Path $copyReportPath -Value $startedReport

$vm = $null
$vhdPath = $null
$mount = $null
$shutdownIntentRecorded = $false
$shutdownRequested = $false
$shutdownCompleted = $false
try {
  $currentStage = 'hyperv_preflight'
  $vm = Get-VM -Name $VMName -ErrorAction Stop
  if ($vm.State -ne 'Off') {
    if (-not $GracefulShutdown -or $vm.State -ne 'Running') { Fail 'vm_not_off' }
    $currentStage = 'graceful_shutdown_custody'
    try {
      $placement = (Read-Evidence1CanaryJson 'C:\kmp-eval\scratch\hyperv-place-live-autorun\HYPERV-PLACE-LIVE-AUTORUN.json').value
      $handoff = (Read-Evidence1CanaryJson 'C:\kmp-eval\scratch\hyperv-start-authorized-live\HYPERV-START-AUTHORIZED-LIVE.json').value
      $runningTerminal = Read-RunningTerminal
      if ($placement.PSObject.Properties['canary']) {
        $null = Assert-Evidence1CanaryShutdownCustody $placement $handoff $runningTerminal $ExpectedRunId $VMName
      } else {
        $null = Assert-Evidence1MatrixShutdownCustody $placement $handoff $runningTerminal $ExpectedRunId $VMName
      }
    } catch {
      Fail 'vm_shutdown_custody'
    }

    $currentStage = 'graceful_shutdown'
    $stopJob = $null
    try {
      $shutdownIntentRecorded = $true
      $shutdownCheckpoint = [ordered]@{
        schema = 1
        invocation_id = $copyInvocationId
        state = 'started'
        verdict = 'FAIL'
        generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        expected_run_id = $ExpectedRunId
        failure_phase = 'graceful_shutdown'
        failure_code = 'vm_shutdown_dispatch_pending'
        failure_subreason = $null
        graceful_shutdown_intent_recorded = $shutdownIntentRecorded
        graceful_shutdown_requested = $false
        graceful_shutdown_completed = $false
        hard_power_fallback_used = $false
        raw_content_read = $false
      }
      Write-Evidence1JsonAtomically -Path $copyReportPath -Value $shutdownCheckpoint
      $stopJob = Stop-VM -Name $VMName -Confirm:$false -AsJob -ErrorAction Stop
      $shutdownRequested = $true
      $shutdownCheckpoint = [ordered]@{
        schema = 1
        invocation_id = $copyInvocationId
        state = 'started'
        verdict = 'FAIL'
        generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        expected_run_id = $ExpectedRunId
        failure_phase = 'graceful_shutdown'
        failure_code = 'vm_shutdown_interrupted'
        failure_subreason = $null
        graceful_shutdown_intent_recorded = $shutdownIntentRecorded
        graceful_shutdown_requested = $shutdownRequested
        graceful_shutdown_completed = $false
        hard_power_fallback_used = $false
        raw_content_read = $false
      }
      Write-Evidence1JsonAtomically -Path $copyReportPath -Value $shutdownCheckpoint
      $completed = Wait-Job -Job $stopJob -Timeout $GracefulShutdownTimeoutSeconds
      if (-not $completed) { Fail 'vm_shutdown_failed' }
      Receive-Job -Job $stopJob -ErrorAction Stop | Out-Null
      $deadline = [DateTime]::UtcNow.AddSeconds(30)
      do {
        $vm = Get-VM -Name $VMName -ErrorAction Stop
        if ($vm.State -eq 'Off') { break }
        Start-Sleep -Seconds 2
      } while ([DateTime]::UtcNow -lt $deadline)
      if ($vm.State -ne 'Off') { Fail 'vm_shutdown_failed' }
      $shutdownCompleted = $true
    } catch {
      if ($script:CopyFailureCode -cne 'vm_shutdown_failed') { Fail 'vm_shutdown_failed' }
      throw
    } finally {
      if ($stopJob) { Remove-Job -Job $stopJob -Force -ErrorAction SilentlyContinue }
    }
  }

  $activeDisk = Get-VMHardDiskDrive -VMName $VMName | Select-Object -First 1
  if (-not $activeDisk -or -not $activeDisk.Path) { Fail 'vm_disk_missing' }
  $vhdPath = Resolve-FullPath $activeDisk.Path
  Assert-PathInside $vhdPath 'C:\kmp-eval\hyperv\' 'active VHD'

  $currentStage = 'mount'
  $mount = Mount-VHD -Path $vhdPath -ReadOnly -Passthru
  $image = Get-DiskImage -ImagePath $vhdPath -ErrorAction Stop
  if ($null -eq $image.Number) { Fail 'vm_mount_invalid' }

  $partitions = @(Get-Partition -DiskNumber $image.Number -ErrorAction Stop | Where-Object DriveLetter)
  $driveRoot = $null
  foreach ($partition in $partitions) {
    $candidateRoot = "$($partition.DriveLetter):\"
    if (Test-Path -LiteralPath (Join-Path $candidateRoot 'Windows')) {
      $driveRoot = $candidateRoot
      break
    }
  }
  if (-not $driveRoot) { Fail 'vm_volume_missing' }

  $currentStage = 'copy_artifacts'
  $guestScratch = Join-Path $driveRoot 'kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1'
  $guestOps = Join-Path $driveRoot 'Evidence1Ops'
  $guestHarness = Join-Path $driveRoot 'kmp-eval\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1'
  $guestRuns = Join-Path $guestHarness 'tools\runs'

  $copied = [ordered]@{
    stage_b_live_log = Copy-IfPresent (Join-Path $guestScratch 'STAGE-B-live.log') (Join-Path $OutDir 'STAGE-B-live.log')
    wrapper_log = Copy-IfPresent (Join-Path $guestOps 'STAGE-B-live-wrapper.log') (Join-Path $OutDir 'STAGE-B-live-wrapper.log')
    wrapper_stdout = Copy-IfPresent (Join-Path $guestOps 'STAGE-B-live.stdout.log') (Join-Path $OutDir 'STAGE-B-live.stdout.log')
    wrapper_stderr = Copy-IfPresent (Join-Path $guestOps 'STAGE-B-live.stderr.log') (Join-Path $OutDir 'STAGE-B-live.stderr.log')
    wrapper_status = Copy-IfPresent (Join-Path $guestOps 'STAGE-B-live.status.json') (Join-Path $OutDir 'STAGE-B-live.status.json')
    wrapper_terminal = Copy-IfPresent (Join-Path $guestOps 'STAGE-B-live.exit.json') (Join-Path $OutDir 'STAGE-B-live.exit.json')
    launcher_terminal = Copy-IfPresent (Join-Path $guestOps 'STAGE-B-live.launcher-exit.json') (Join-Path $OutDir 'STAGE-B-live.launcher-exit.json')
    exit_marker = Copy-IfPresent (Join-Path $guestOps 'STAGE-B-live.exit.txt') (Join-Path $OutDir 'STAGE-B-live.exit.txt')
    progress_smoke_log = Copy-IfPresent (Join-Path $guestOps 'STAGE-B-progress-smoke.log') (Join-Path $OutDir 'STAGE-B-progress-smoke.log')
    progress_smoke_status = Copy-IfPresent (Join-Path $guestOps 'STAGE-B-progress-smoke.status.json') (Join-Path $OutDir 'STAGE-B-progress-smoke.status.json')
    progress_smoke_exit_marker = Copy-IfPresent (Join-Path $guestOps 'STAGE-B-progress-smoke.exit.txt') (Join-Path $OutDir 'STAGE-B-progress-smoke.exit.txt')
    readiness_ledger = Copy-IfPresent (Join-Path $guestScratch 'READINESS.json') (Join-Path $OutDir 'READINESS.json')
  }

  $runsInventory = @()
  if (Test-Path -LiteralPath $guestRuns) {
    $runsInventory = @(Get-ChildItem -LiteralPath $guestRuns -Recurse -File -Force -ErrorAction SilentlyContinue |
      ForEach-Object {
        $relative = $_.FullName.Substring($guestRuns.Length).TrimStart('\') -replace '\\','/'
        [ordered]@{
          path = $relative
          length = $_.Length
          last_write_time_utc = $_.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
          sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
          content_read = $false
        }
      } |
      Sort-Object path)
  }

  $rejectionDiagnosticsDir = Join-Path $OutDir 'agentic-eval-rejected'
  New-Item -ItemType Directory -Force -Path $rejectionDiagnosticsDir | Out-Null
  $localRejectionDetailsDir = Join-Path $rejectionDiagnosticsDir 'raw'
  New-Item -ItemType Directory -Force -Path $localRejectionDetailsDir | Out-Null
  $rejectionDiagnostics = @()
  $localStructuredRejectionDetails = @()
  $guestRejectedRoot = Join-Path $guestRuns 'agentic-eval-rejected'
  if (Test-Path -LiteralPath $guestRejectedRoot) {
    $rejectionDiagnostics = @(Get-ChildItem -LiteralPath $guestRejectedRoot -Filter '*.json' -File -Force -ErrorAction SilentlyContinue |
      ForEach-Object {
        $destination = Join-Path $rejectionDiagnosticsDir $_.Name
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
        $fact = File-Fact $destination
        [ordered]@{
          path = ('agentic-eval-rejected/' + $_.Name)
          copied_to = $destination
          length = $fact.length
          last_write_time_utc = $fact.last_write_time_utc
          sha256 = $fact.sha256
          content_read = $false
          raw = $false
        }
      } |
      Sort-Object path)

    $guestRejectedRawRoot = Join-Path $guestRejectedRoot 'raw'
    if (Test-Path -LiteralPath $guestRejectedRawRoot) {
      $localStructuredRejectionDetails = @(Get-ChildItem -LiteralPath $guestRejectedRawRoot -Filter '*.json' -File -Force -ErrorAction SilentlyContinue |
        ForEach-Object {
          $destination = Join-Path $localRejectionDetailsDir $_.Name
          Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
          $fact = File-Fact $destination
          [ordered]@{
            path = ('agentic-eval-rejected/raw/' + $_.Name)
            copied_to = $destination
            length = $fact.length
            last_write_time_utc = $fact.last_write_time_utc
            sha256 = $fact.sha256
            content_read = $false
            raw_transcript_content = $false
            raw_stderr_content = $false
          }
        } |
        Sort-Object path)
    }
  }

  $incidentDiagnosticsDir = Join-Path $OutDir 'agentic-eval-incident'
  New-Item -ItemType Directory -Force -Path $incidentDiagnosticsDir | Out-Null
  $incidentDiagnostics = @()
  $guestIncidentRoot = Join-Path $guestRuns 'agentic-eval-incident'
  if (Test-Path -LiteralPath $guestIncidentRoot) {
    $incidentDiagnostics = @(Get-ChildItem -LiteralPath $guestIncidentRoot -Filter '*.json' -File -Force -ErrorAction SilentlyContinue |
      ForEach-Object {
        $destination = Join-Path $incidentDiagnosticsDir $_.Name
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
        $fact = File-Fact $destination
        [ordered]@{
          path = ('agentic-eval-incident/' + $_.Name)
          copied_to = $destination
          length = $fact.length
          last_write_time_utc = $fact.last_write_time_utc
          sha256 = $fact.sha256
          content_read = $false
          raw = $false
        }
      } |
      Sort-Object path)
  }

  $journalDirs = @()
  $journalEventSummaries = @()
  $journalEventCopies = @()
  $journalRoot = Join-Path $guestRuns 'agentic-eval-journal'
  if (Test-Path -LiteralPath $journalRoot) {
    $journalDirs = @(Get-ChildItem -LiteralPath $journalRoot -Directory -Force -ErrorAction SilentlyContinue |
      ForEach-Object {
        $files = @(Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue)
        [ordered]@{
          name = $_.Name
          last_write_time_utc = $_.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
          file_count = $files.Count
          total_bytes = [int64](($files | Measure-Object -Property Length -Sum).Sum)
        }
      } |
      Sort-Object last_write_time_utc)

    $journalEventSummaries = @(Get-ChildItem -LiteralPath $journalRoot -Directory -Force -ErrorAction SilentlyContinue |
      ForEach-Object {
        $journalId = $_.Name
        $eventDir = Join-Path $_.FullName 'events'
        if (Test-Path -LiteralPath $eventDir) {
          Get-ChildItem -LiteralPath $eventDir -Filter '*.json' -File -Force -ErrorAction SilentlyContinue |
            Sort-Object Name |
            ForEach-Object {
              $eventFile = $_
              try {
                $event = Get-Content -LiteralPath $eventFile.FullName -Raw | ConvertFrom-Json
                $metaProperty = $event.PSObject.Properties['meta']
                $meta = if ($null -ne $metaProperty) { $metaProperty.Value } else { $null }
                [ordered]@{
                  journal_id = $journalId
                  file = $eventFile.Name
                  seq = if ($event.PSObject.Properties['seq']) { $event.seq } else { $null }
                  ts = if ($event.PSObject.Properties['ts']) { $event.ts } else { $null }
                  cell_ordinal = if ($event.PSObject.Properties['cellOrdinal']) { $event.cellOrdinal } else { $null }
                  transition = if ($event.PSObject.Properties['transition']) { $event.transition } else { $null }
                  has_meta = $null -ne $meta
                  meta_keys = Get-JsonObjectKeys $meta
                }
              } catch {
                [ordered]@{
                  journal_id = $journalId
                  file = $eventFile.Name
                  parse_error = 'invalid_json'
                }
              }
            }
        }
      })

    $journalEventCopies = @(Get-ChildItem -LiteralPath $journalRoot -Directory -Force -ErrorAction SilentlyContinue |
      ForEach-Object {
        $journalId = $_.Name
        $eventDir = Join-Path $_.FullName 'events'
        if (Test-Path -LiteralPath $eventDir) {
          Get-ChildItem -LiteralPath $eventDir -Filter '*.json' -File -Force -ErrorAction SilentlyContinue |
            Sort-Object Name |
            ForEach-Object {
              $relative = ('agentic-eval-journal/{0}/events/{1}' -f $journalId, $_.Name)
              Copy-RunFileMetadataOnly $guestRuns $OutDir $relative
              $destination = Join-Path $OutDir ($relative -replace '/', '\')
              $fact = File-Fact $destination
              [ordered]@{
                path = $relative
                length = $fact.length
                last_write_time_utc = $fact.last_write_time_utc
                sha256 = $fact.sha256
                content_read = $false
              }
            }
        }
      })
  }

  $scenarioFiles = @()
  $scenarioCopies = @()
  $scenarioRoot = Join-Path $guestRuns 'agentic-eval-scenario'
  if (Test-Path -LiteralPath $scenarioRoot) {
    $scenarioFiles = @(Get-ChildItem -LiteralPath $scenarioRoot -Recurse -File -Force -ErrorAction SilentlyContinue |
      ForEach-Object {
        [ordered]@{
          path = ($_.FullName.Substring($scenarioRoot.Length).TrimStart('\') -replace '\\','/')
          length = $_.Length
          last_write_time_utc = $_.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
          sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
          content_read = $false
        }
      } |
      Sort-Object path)

    $scenarioCopies = @($scenarioFiles |
      Where-Object { $_.path -notmatch '(^|/)raw(/|$)' -and $_.path -notmatch '(^|/)stderr(/|$)' } |
      ForEach-Object {
        $relative = 'agentic-eval-scenario/' + $_.path
        Copy-RunFileMetadataOnly $guestRuns $OutDir $relative
        $destination = Join-Path $OutDir ($relative -replace '/', '\')
        $fact = File-Fact $destination
        [ordered]@{
          path = $relative
          length = $fact.length
          last_write_time_utc = $fact.last_write_time_utc
          sha256 = $fact.sha256
          content_read = $false
        }
      } |
      Sort-Object path)
  }

  $stageBExit = Resolve-StageBExit
  $canaryCustody = $null
  $placementPath = 'C:\kmp-eval\scratch\hyperv-place-live-autorun\HYPERV-PLACE-LIVE-AUTORUN.json'
  if (Test-Path -LiteralPath $placementPath) {
    $placement = (Read-Evidence1CanaryJson $placementPath).value
    if ($placement.PSObject.Properties['canary']) {
      if (-not $ExpectedRunId -or $ExpectedRunId -cne $placement.run_id -or -not $stageBExit.valid) { Fail 'canary_copy_scope' }
      $canarySource = Join-Path $guestOps "canary\$ExpectedRunId"
      $currentStage = 'canary_custody'
      try {
        $canaryCustody = Get-Evidence1CanaryCustody $canarySource $ExpectedRunId $placement.canary.binding_sha256 $stageBExit.record
      } catch {
        Fail 'canary_custody_invalid'
      }
      $canaryDestination = Join-Path $OutDir "canary\$ExpectedRunId"
      foreach ($name in $canaryCustody.files.Keys) {
        $destination = Join-Path $canaryDestination $name
        if (Test-Path -LiteralPath $destination) {
          if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -cne $canaryCustody.files[$name]) { Fail 'canary_copy_hash' }
        } else {
          New-Item -ItemType Directory -Path $canaryDestination -Force | Out-Null
          Copy-Item -LiteralPath (Join-Path $canarySource $name) -Destination $destination -ErrorAction Stop
          if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -cne $canaryCustody.files[$name]) { Fail 'canary_copy_hash' }
        }
      }
    }
  }

  $report = [ordered]@{
    schema = 1
    invocation_id = $copyInvocationId
    state = if ($canaryCustody -and -not $canaryCustody.complete) { 'failed' } else { 'passed' }
    verdict = if ($canaryCustody -and -not $canaryCustody.complete) { 'FAIL' } else { 'PASS' }
    generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    expected_run_id = if ($ExpectedRunId) { $ExpectedRunId } else { $null }
    failure_phase = if ($canaryCustody -and -not $canaryCustody.complete) { 'canary_custody' } else { $null }
    failure_code = if ($canaryCustody -and -not $canaryCustody.complete) { 'canary_custody_incomplete' } else { $null }
    failure_subreason = if ($canaryCustody -and -not $canaryCustody.complete) { $canaryCustody.failure_code } else { $null }
    graceful_shutdown_intent_recorded = $shutdownIntentRecorded
    graceful_shutdown_requested = $shutdownRequested
    graceful_shutdown_completed = $shutdownCompleted
    hard_power_fallback_used = $false
    vm_name = $VMName
    vm_state = [string]$vm.State
    vhd_path = $vhdPath
    mounted_drive = $driveRoot
    out_dir = $OutDir
    copied = $copied
    stage_b_exit = $stageBExit
    stage_b_exit_text = if ($stageBExit.valid) { [string]$stageBExit.exit_code } else { $null }
    journal_dirs = $journalDirs
    journal_event_summaries = $journalEventSummaries
    journal_event_copies = $journalEventCopies
    scenario_files = $scenarioFiles
    scenario_copies = $scenarioCopies
    incident_diagnostics = $incidentDiagnostics
    rejection_diagnostics = $rejectionDiagnostics
    local_structured_rejection_details = $localStructuredRejectionDetails
    runs_inventory = $runsInventory
    raw_content_read = $false
    note = 'Inventory uses file names, sizes and hashes only. Raw transcript/stderr contents are not read.'
  }
  if ($canaryCustody) { $report.canary = $canaryCustody }
  if ($canaryCustody -and -not $canaryCustody.complete) { $copyExitCode = 1 }
  $terminalReport = $report
} catch {
  $copyExitCode = 1
  $terminalReport = [ordered]@{
    schema = 1
    invocation_id = $copyInvocationId
    state = 'failed'
    verdict = 'FAIL'
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    expected_run_id = if ($ExpectedRunId) { $ExpectedRunId } else { $null }
    failure_phase = $currentStage
    failure_code = $script:CopyFailureCode
    failure_subreason = $null
    graceful_shutdown_intent_recorded = $shutdownIntentRecorded
    graceful_shutdown_requested = $shutdownRequested
    graceful_shutdown_completed = $shutdownCompleted
    hard_power_fallback_used = $false
    raw_content_read = $false
  }
} finally {
  if ($mount) {
    Dismount-VHD -Path $vhdPath -ErrorAction SilentlyContinue
  }
}

try {
  Write-Evidence1JsonAtomically -Path $copyReportPath -Value $terminalReport
} catch {
  Write-Error 'HARD STOP: copy_report_write_failed'
  exit 1
}
if ($copyExitCode -ne 0) {
  Write-Error "HARD STOP: $($terminalReport.failure_code)"
  exit $copyExitCode
}
Write-Host "[hyperv-copy-live-artifacts] PASS: $OutDir"

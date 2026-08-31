#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner',
  [string]$OutDir = 'C:\kmp-eval\scratch\hyperv-copy-live-artifacts',
  [string]$ExpectedRunId = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$contractPath = Join-Path $PSScriptRoot 'evidence1-live-run-contract.psm1'
Import-Module $contractPath -Force

function Fail([string]$Code) {
  $known = @(
    'path_outside_root','copy_raw_forbidden','vm_not_off','vm_disk_missing','vm_mount_invalid',
    'vm_volume_missing','canary_copy_scope','canary_copy_hash','canary_custody_invalid','copy_failed'
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

Assert-PathInside $OutDir 'C:\kmp-eval\scratch\' 'out dir'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$copyReportPath = Join-Path $OutDir 'HYPERV-COPY-LIVE-ARTIFACTS.json'
$copyInvocationId = [guid]::NewGuid().ToString('D')
$copyExitCode = 0
$script:CopyFailureCode = 'copy_failed'
$currentStage = 'initialize'
$terminalReport = $null
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
  raw_content_read = $false
}
Write-Evidence1JsonAtomically -Path $copyReportPath -Value $startedReport

$vm = $null
$vhdPath = $null
$mount = $null
try {
  $currentStage = 'hyperv_preflight'
  $vm = Get-VM -Name $VMName -ErrorAction Stop
  if ($vm.State -ne 'Off') { Fail 'vm_not_off' }

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

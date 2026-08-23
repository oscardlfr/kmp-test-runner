#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner',
  [string]$OutDir = 'C:\kmp-eval\scratch\hyperv-copy-live-artifacts',
  [string]$GuestHarnessDir = 'C:\kmp-eval\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1',
  [string]$GuestScratchDir = 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1',
  [string]$GuestOpsDir = 'C:\Evidence1Ops'
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
  }
  return File-Fact $Destination
}

function Copy-RunFileMetadataOnly([string]$SourceRoot, [string]$LocalRoot, [string]$RelativePath) {
  if ($RelativePath -match '(^|/)raw(/|$)' -or $RelativePath -match '(^|/)stderr(/|$)') {
    Fail "refusing to copy raw/stderr run content through metadata-only copier: $RelativePath"
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
Assert-PathInside $GuestHarnessDir 'C:\kmp-eval\' 'guest harness'
Assert-PathInside $GuestScratchDir 'C:\kmp-eval\scratch\' 'guest scratch'
if ($GuestOpsDir -ne 'C:\Evidence1Ops') {
  Fail "GuestOpsDir must stay exactly C:\Evidence1Ops for this evidence runner"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ($vm.State -ne 'Off') {
  Fail "copying live artifacts requires $VMName to be Off, got $($vm.State)"
}

$activeDisk = Get-VMHardDiskDrive -VMName $VMName | Select-Object -First 1
if (-not $activeDisk -or -not $activeDisk.Path) {
  Fail "could not resolve active VM disk for $VMName"
}
$vhdPath = Resolve-FullPath $activeDisk.Path
Assert-PathInside $vhdPath 'C:\kmp-eval\hyperv\' 'active VHD'

$mount = $null
try {
  $mount = Mount-VHD -Path $vhdPath -ReadOnly -Passthru
  $image = Get-DiskImage -ImagePath $vhdPath -ErrorAction Stop
  if ($null -eq $image.Number) {
    Fail 'mounted disk image did not expose a disk number'
  }

  $partitions = @(Get-Partition -DiskNumber $image.Number -ErrorAction Stop | Where-Object DriveLetter)
  $driveRoot = $null
  foreach ($partition in $partitions) {
    $candidateRoot = "$($partition.DriveLetter):\"
    if (Test-Path -LiteralPath (Join-Path $candidateRoot 'Windows')) {
      $driveRoot = $candidateRoot
      break
    }
  }
  if (-not $driveRoot) {
    Fail 'could not find mounted Windows volume in VHD'
  }

  $guestScratch = Join-Path $driveRoot ($GuestScratchDir.Substring(3))
  $guestOps = Join-Path $driveRoot ($GuestOpsDir.Substring(3))
  $guestHarness = Join-Path $driveRoot ($GuestHarnessDir.Substring(3))
  $guestRuns = Join-Path $guestHarness 'tools\runs'

  $copied = [ordered]@{
    stage_b_live_log = Copy-IfPresent (Join-Path $guestScratch 'STAGE-B-live.log') (Join-Path $OutDir 'STAGE-B-live.log')
    wrapper_log = Copy-IfPresent (Join-Path $guestOps 'STAGE-B-live-wrapper.log') (Join-Path $OutDir 'STAGE-B-live-wrapper.log')
    wrapper_stdout = Copy-IfPresent (Join-Path $guestOps 'STAGE-B-live.stdout.log') (Join-Path $OutDir 'STAGE-B-live.stdout.log')
    wrapper_stderr = Copy-IfPresent (Join-Path $guestOps 'STAGE-B-live.stderr.log') (Join-Path $OutDir 'STAGE-B-live.stderr.log')
    wrapper_status = Copy-IfPresent (Join-Path $guestOps 'STAGE-B-live.status.json') (Join-Path $OutDir 'STAGE-B-live.status.json')
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
                  parse_error = $_.Exception.Message
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

  $exitText = if (Test-Path -LiteralPath (Join-Path $OutDir 'STAGE-B-live.exit.txt')) {
    (Get-Content -LiteralPath (Join-Path $OutDir 'STAGE-B-live.exit.txt') -Raw).Trim()
  } else {
    $null
  }

  $report = [ordered]@{
    verdict = 'PASS'
    generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    vm_name = $VMName
    vm_state = [string]$vm.State
    vhd_path = $vhdPath
    mounted_drive = $driveRoot
    out_dir = $OutDir
    copied = $copied
    stage_b_exit_text = $exitText
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
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutDir 'HYPERV-COPY-LIVE-ARTIFACTS.json') -Encoding UTF8
  Write-Host "[hyperv-copy-live-artifacts] PASS: $OutDir"
} finally {
  if ($mount) {
    Dismount-VHD -Path $vhdPath -ErrorAction SilentlyContinue
  }
}

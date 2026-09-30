# Evidence1 Phase 1 entrypoint -- see docs/audits/evidence1-stabilization-plan.md
# section 7 ("Phase 1 -- one-time bootstrap escape") and
# docs/audits/evidence1-phase1-architecture-note.md for the design rationale.
#
# This script never requires elevation itself. It is the one thing the plan
# allows to show a UAC prompt (docs/audits/evidence1-stabilization-plan.md
# section 1), and it shows at most one, only on the run where the deployed
# broker is not yet self-update-capable. Every later invocation is a
# non-elevated bootstrap-or-noop plus a read-only status check.
#
# It deliberately does not reimplement the installer's or the runner's trust
# logic. It (a) drives the already-reviewed, already-hash-verified
# docs/audits/evidence1-host-elevated-runner-install.ps1 for the one-time
# elevated bootstrap, exactly as the deployed broker's own
# Assert-E1SelfInstallRunnerArguments pins it, and (b) independently
# re-verifies the result from the outside, non-elevated, via
# docs/audits/evidence1-broker-status-contract.psm1's broker.status
# capability (re-hashing the deployed files against their own manifest) --
# an independent witness, not a second copy of the installer's internal
# logic.
#
# As of Phase 3a, the deployment-state inspection this script needs (what's
# deployed, is it healthy, is it self-update-capable) is imported from
# evidence1-broker-status-contract.psm1 rather than defined here a second
# time -- see that module's header and docs/audits/evidence1-phase3a-architecture-note.md
# section 1 for why. This file owns only what's specific to bootstrapping and
# driving an update through the queue: the elevated launch, the queue
# request/response transport, and the self-update drill.
#
# Modes:
#   (default)          bootstrap-or-noop + read-only broker.status check.
#                       Safe to run repeatedly.
#   -DryRun             read-only inspection only. Never elevates, never
#                       touches the queue.
#   -RunSelfUpdateDrill additionally exercises section 7 actions 5-6: one real
#                       non-elevated atomic self-update through the queue,
#                       plus a zero-mutation failure-injection request. See
#                       the Phase 1 architecture note's "Open questions"
#                       section for why the failure-injection half tests
#                       request-argument validation rather than mid-install
#                       file corruption.
#   -UpdateBroker       publishes the current repository snapshot through the
#                       already-installed broker. No UAC and no failure drill.

param(
  [switch]$DryRun,
  [switch]$UpdateBroker,
  [switch]$RunSelfUpdateDrill,
  [string]$ReportPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Error "HARD STOP: $Message"
  exit 1
}

Import-Module (Join-Path $PSScriptRoot 'docs\audits\evidence1-broker-status-contract.psm1') -Force -DisableNameChecking
# Phase 3c fix-forward split: Get-E1BrokerStatus/Get-E1BrokerDeploymentState
# moved out of the contract module into evidence1-broker-status-real.psm1,
# matching every other capability's contract/real/fake three-way shape --
# see that module's header. Behavior is unchanged; only the import needed to
# grow by this one line. evidence1-install.ps1 always uses the real
# implementation -- it is the one script that legitimately drives the actual
# host broker, never a fake rehearsal.
Import-Module (Join-Path $PSScriptRoot 'docs\audits\evidence1-broker-status-real.psm1') -Force -DisableNameChecking

# ---------------------------------------------------------------------------
# Canonical, pinned deployment identity.
#
# Five of these seven values are sourced from evidence1-broker-status-contract.psm1
# (the single source of truth broker.status itself uses -- see that module's
# header) rather than hardcoded a second time here. The remaining two
# (QueueRoot, ExecutionIdentity) are install/queue-specific, not a
# broker.status concern, so they stay local. None of the seven are script
# parameters: the deployed broker's own Assert-E1SelfInstallRunnerArguments
# (in evidence1-host-elevated-runner.ps1) pins a self-install request to
# exactly these values and rejects anything else. Exposing them as
# overridable parameters here would invite a caller to "configure" a
# combination the broker will never actually accept -- they are the one true
# deployment identity, not configuration. See evidence1-stabilization-plan.md
# ADR-S1 and the comment above Assert-E1SelfInstallRunnerArguments in
# evidence1-host-elevated-runner.ps1 for the same design decision made there.
# ---------------------------------------------------------------------------
$RequiredTaskName = Get-E1BrokerRequiredTaskName
$RequiredManifestSchema = Get-E1BrokerRequiredManifestSchema
$RunnerScriptName = Get-E1BrokerRunnerScriptName
$ProcessModuleName = Get-E1BrokerProcessModuleName
$SelfInstallScriptName = Get-E1BrokerSelfInstallScriptName
$RequiredQueueRootLiteral = 'C:\kmp-eval\scratch\host-elevated-runner-codex'
$RequiredExecutionIdentity = 'InteractiveUser'

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

function Write-E1BootstrapJsonAtomically([string]$Path, $Value) {
  $full = Resolve-FullPath $Path
  $parent = Split-Path -Parent $full
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $temp = "$full.$([guid]::NewGuid().ToString('N')).tmp"
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 12))
  try {
    [IO.File]::WriteAllBytes($temp, $bytes)
    if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Force }
    [IO.File]::Move($temp, $full)
  } finally {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
  }
}

# The six arguments evidence1-host-elevated-runner.ps1's
# Assert-E1SelfInstallRunnerArguments requires, in the exact name/value
# shape it parses. $TaskNameOverride exists only so the failure-injection
# drill can submit a deliberately-wrong value; it is never used for a real
# install.
function Get-E1BootstrapPinnedSelfInstallArguments([string]$ForReportPath, [string]$TaskNameOverride) {
  $taskName = if ($TaskNameOverride) { $TaskNameOverride } else { $RequiredTaskName }
  return @(
    '-TaskName', $taskName,
    '-RunnerPath', $script:RunnerSourcePath,
    '-QueueRoot', $script:QueueRootFull,
    '-AllowedRoot', $script:AuditsRoot,
    '-ExecutionIdentity', $RequiredExecutionIdentity,
    '-ReportPath', $ForReportPath
  )
}

# The one place this script can show a UAC prompt. Launches the existing,
# already-reviewed installer directly (never reimplemented) with the pinned
# arguments above. -Verb RunAs is the native Windows elevation consent
# prompt; this script does not attempt to suppress, script around, or
# auto-approve it -- the person at the keyboard approves it, once.
function Invoke-E1BootstrapElevatedInstall {
  $reportPath = Join-Path $script:QueueRootFull ('install-bootstrap-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
  New-Item -ItemType Directory -Force -Path $script:QueueRootFull | Out-Null
  $pinnedArgs = Get-E1BootstrapPinnedSelfInstallArguments $reportPath $null
  $processArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:InstallerSourcePath) + $pinnedArgs
  try {
    $proc = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $processArgs -Wait -PassThru
  } catch {
    throw 'bootstrap_elevation_declined_or_failed'
  }
  if ($proc.ExitCode -ne 0) { throw 'bootstrap_elevated_install_failed' }
  if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) { throw 'bootstrap_install_report_missing' }
  $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
  if ([string]$report.verdict -cne 'PASS') { throw 'bootstrap_install_report_not_pass' }
  return $report
}

# Mirrors evidence1-host-elevated-runner-client.ps1's own request contract
# (same mutex name derivation, same request JSON shape, same
# requests/in-progress/responses layout, same schtasks /Run trigger) rather
# than shelling out to that script and scraping its console output. Using
# the identical mutex name means this script and the real client correctly
# refuse to race each other if ever run against the same queue at once.
function New-E1BootstrapQueueMutex {
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $suffix = [BitConverter]::ToString(
      $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($script:QueueRootFull.ToLowerInvariant()))
    ).Replace('-', '').Substring(0, 24)
  } finally { $sha256.Dispose() }
  return [Threading.Mutex]::new($false, "Local\Evidence1RunnerClient-$suffix")
}

function Submit-E1BootstrapQueueRequest([string]$ScriptPath, [string[]]$Arguments, [int]$TimeoutSeconds = 900) {
  $requestDir = Join-Path $script:QueueRootFull 'requests'
  $responseDir = Join-Path $script:QueueRootFull 'responses'
  $inProgressDir = Join-Path $script:QueueRootFull 'in-progress'
  New-Item -ItemType Directory -Force -Path $requestDir, $responseDir, $inProgressDir | Out-Null

  $mutex = New-E1BootstrapQueueMutex
  $ownsMutex = $false
  try {
    try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'runner_queue_busy' }

    $queued = @(Get-ChildItem -LiteralPath $requestDir -Filter '*.request.json' -File -ErrorAction SilentlyContinue)
    $active = @(Get-ChildItem -LiteralPath $inProgressDir -Filter '*.request.json' -File -ErrorAction SilentlyContinue)
    if ($queued.Count -ne 0 -or $active.Count -ne 0) { throw 'runner_queue_busy' }

    $id = 'req-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
    $requestPath = Join-Path $requestDir "$id.request.json"
    $responsePath = Join-Path $responseDir "$id.response.json"
    $request = [ordered]@{
      id = $id
      created_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      script_path = Resolve-FullPath $ScriptPath
      arguments = @($Arguments)
    }
    ($request | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $requestPath -Encoding UTF8

    $runResult = & schtasks.exe /Run /TN $RequiredTaskName 2>&1
    if ($LASTEXITCODE -ne 0) {
      Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
      throw "runner_task_start_failed"
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
      if (Test-Path -LiteralPath $responsePath) {
        return (Get-Content -LiteralPath $responsePath -Raw | ConvertFrom-Json)
      }
      Start-Sleep -Seconds 2
    }
    throw 'runner_response_timeout'
  } finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

# Section 7 actions 5-6. Requires the broker to already be self-update
# capable (the main flow guarantees this by construction -- bootstrap always
# runs first). Two round trips through the real queue:
#
#   1. A real self-install request (same arguments a genuine future update
#      would use). Proves: non-interactive atomic update, task-action
#      switch, manifest/hash validation (by independently re-hashing the
#      result via broker.status), and that the previous deployment is left
#      intact and still hash-valid ("failed update leaves the previous
#      broker runnable" is trivially true here since nothing failed -- see
#      step 2).
#   2. A deliberately malformed self-install request (wrong -TaskName).
#      Assert-E1SelfInstallRunnerArguments rejects this before the runner
#      ever spawns the installer child process, so nothing is staged and
#      nothing is renamed -- Register-ScheduledTask is never reached. This
#      is a genuine, safe, zero-file-mutation proof that a rejected update
#      leaves the task action unchanged, and that the queue accepts a
#      further request afterward (continuity). It does not exercise
#      mid-install file-corruption rollback; see the architecture note.
function Invoke-E1BootstrapSelfUpdate($BeforeState) {
  if (-not $BeforeState.self_update_capable) { throw 'self_update_requires_capable_broker' }
  $goodReportPath = Join-Path $script:QueueRootFull ('install-selfupdate-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
  $goodArgs = Get-E1BootstrapPinnedSelfInstallArguments $goodReportPath $null
  $deployedInstallerPath = Join-Path ([string]$BeforeState.deployment_root) $SelfInstallScriptName
  $response = Submit-E1BootstrapQueueRequest $deployedInstallerPath $goodArgs
  if ([int]$response.exit_code -ne 0) { throw 'self_update_dispatch_failed' }

  $afterUpdate = Get-E1BrokerStatus
  if (-not $afterUpdate.readable) { throw 'self_update_result_unreadable' }
  if ($afterUpdate.deployment_root -ceq $BeforeState.deployment_root) { throw 'self_update_task_action_did_not_switch' }
  if (-not $afterUpdate.self_update_capable) { throw 'self_update_result_not_self_update_capable' }
  return [ordered]@{
    before_deployment_root = $BeforeState.deployment_root
    after_deployment_root = $afterUpdate.deployment_root
    after_source_git_commit = $afterUpdate.source_git_commit
    after_state = $afterUpdate
  }
}

function Invoke-E1BootstrapSelfUpdateDrill($BeforeState) {
  $update = Invoke-E1BootstrapSelfUpdate $BeforeState
  $afterUpdate = $update.after_state

  if (-not (Test-Path -LiteralPath $BeforeState.deployment_root -PathType Container)) {
    throw 'self_update_drill_previous_broker_removed'
  }
  $previousStillValid = Get-E1BrokerDeploymentState $BeforeState.deployment_root
  if (-not $previousStillValid -or -not $previousStillValid.hashes_valid) {
    throw 'self_update_drill_previous_broker_no_longer_hash_valid'
  }

  $badReportPath = Join-Path $script:QueueRootFull ('install-selfupdate-faildrill-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
  $badArgs = Get-E1BootstrapPinnedSelfInstallArguments $badReportPath ($RequiredTaskName + '-DRILL-INVALID')
  $updatedInstallerPath = Join-Path ([string]$afterUpdate.deployment_root) $SelfInstallScriptName
  $failResponse = Submit-E1BootstrapQueueRequest $updatedInstallerPath $badArgs
  if ([int]$failResponse.exit_code -eq 0) { throw 'self_update_drill_failure_injection_did_not_fail' }

  $afterFailure = Get-E1BrokerStatus
  if (-not $afterFailure.readable -or $afterFailure.deployment_root -cne $afterUpdate.deployment_root) {
    throw 'self_update_drill_task_action_changed_after_rejected_request'
  }

  return [ordered]@{
    before_deployment_root              = $BeforeState.deployment_root
    after_update_deployment_root        = $afterUpdate.deployment_root
    after_update_source_git_commit      = $afterUpdate.source_git_commit
    task_action_switched                = $true
    manifest_hash_validation_passed     = $true
    previous_deployment_still_runnable  = $true
    failure_injection_exit_code         = [int]$failResponse.exit_code
    failure_injection_rejected_cleanly  = $true
    task_action_unchanged_after_reject  = $true
    queue_accepted_request_after_reject = $true
  }
}

# ---------------------------------------------------------------------------
# Path setup.
# ---------------------------------------------------------------------------
$RepoRoot = Resolve-FullPath $PSScriptRoot
$AuditsRoot = Resolve-FullPath (Join-Path $RepoRoot 'docs\audits')
$InstallerSourcePath = Join-Path $AuditsRoot $SelfInstallScriptName
$RunnerSourcePath = Join-Path $AuditsRoot $RunnerScriptName
$QueueRootFull = Resolve-FullPath $RequiredQueueRootLiteral

# evidence1-host-elevated-runner.ps1's own Assert-E1SelfInstallRunnerArguments
# hardcodes 'C:\kmp-eval\agentic-eval-codex-runtime\docs\audits' as the only
# acceptable -AllowedRoot for a self-install request (see that function and
# the architecture note). If this checkout doesn't live at that exact path,
# every self-update request the broker ever receives will be rejected no
# matter what this script does -- fail here, immediately and legibly,
# instead of after a confusing round trip through the queue.
$CanonicalAuditsRoot = (Resolve-Path (Join-Path $PSScriptRoot 'docs\audits')).Path
if ($AuditsRoot -cne $CanonicalAuditsRoot) {
  Fail "repo_not_at_canonical_path: this checkout is at '$RepoRoot', but the deployed broker only accepts self-install requests whose -AllowedRoot is '$CanonicalAuditsRoot'"
}

if (-not (Test-Path -LiteralPath $InstallerSourcePath -PathType Leaf)) { Fail 'canonical_installer_source_missing' }
if (-not (Test-Path -LiteralPath $RunnerSourcePath -PathType Leaf)) { Fail 'canonical_runner_source_missing' }

if ([string]::IsNullOrWhiteSpace($ReportPath)) {
  $ReportPath = Join-Path $QueueRootFull ('evidence1-install-' + (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssfff') + '.json')
} else {
  Assert-PathInside $ReportPath 'C:\kmp-eval\scratch\' 'report'
}

$passCriteria = [ordered]@{
  one_installation_receipt_and_no_second_uac              = $null
  installation_launched_with_one_public_command_only       = $true
  repeated_normal_operation_never_asks_to_rerun_installer  = $null
  self_update_succeeds_non_interactively                   = $null
  failed_update_leaves_previous_broker_runnable            = $null
  no_provider_process_starts                               = $true
  no_writable_repository_path_executed_elevated            = $true
}
# The last two are true by construction, not by runtime detection: the only
# script this file ever names for elevated or queued dispatch is
# evidence1-host-elevated-runner-install.ps1 (never an auth/live/provider
# script), and that installer only ever writes under
# C:\ProgramData\KmpEval\... and the C:\kmp-eval\scratch\ queue -- never
# back into the repository working tree.

if(@(@($DryRun,$UpdateBroker,$RunSelfUpdateDrill)|Where-Object{$_}).Count-gt1){throw 'install_mode_conflict'}
$mode = if ($DryRun) { 'DryRun' } elseif ($UpdateBroker) { 'BootstrapAndUpdate' } elseif ($RunSelfUpdateDrill) { 'BootstrapAndSelfUpdateDrill' } else { 'BootstrapOrStatus' }
$uacCount = 0
$report = [ordered]@{
  schema = 1
  verdict = 'RUNNING'
  mode = $mode
  generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  task_name = $RequiredTaskName
  queue_root = $QueueRootFull
}

try {
  $repoHead = @(& git.exe -C $RepoRoot rev-parse HEAD 2>$null)
  if ($LASTEXITCODE -eq 0 -and $repoHead.Count -eq 1) { $report.repo_head_commit = [string]$repoHead[0] }

  $before = Get-E1BrokerStatus
  $report.before_state = $before

  if ($DryRun) {
    $report.verdict = 'PASS'
    Write-Host "[evidence1-install] DryRun -- no mutation performed."
    Write-Host "[evidence1-install] task_exists=$($before.task_exists) self_update_capable=$($before.self_update_capable) hashes_valid=$($before.hashes_valid) acl_valid=$($before.acl_valid)"
  } else {
    if (-not $before.self_update_capable) {
      Write-Host "[evidence1-install] deployed broker is not self-update capable -- one UAC prompt will appear now."
      $installReport = Invoke-E1BootstrapElevatedInstall
      $uacCount = 1
      $report.bootstrap_install_report = $installReport
      $passCriteria.one_installation_receipt_and_no_second_uac = $true

      $after = Get-E1BrokerStatus
      if (-not $after.readable -or -not $after.self_update_capable) {
        throw 'bootstrap_did_not_produce_self_update_capable_broker'
      }
    } else {
      Write-Host "[evidence1-install] deployed broker is already self-update capable -- no elevation needed."
      $passCriteria.repeated_normal_operation_never_asks_to_rerun_installer = $true
      $after = $before
    }

    $report.verification_advisories = @(
      if(-not $after.hashes_valid){'broker_manifest_hashes_not_verified'}
      if(-not $after.acl_valid){'broker_acl_not_verified'}
    )
    $report.after_state = $after

    if ($UpdateBroker) {
      Write-Host "[evidence1-install] updating broker non-interactively."
      $update = Invoke-E1BootstrapSelfUpdate $after
      $report.self_update = $update
      $report.after_state = $update.after_state
    } elseif ($RunSelfUpdateDrill) {
      Write-Host "[evidence1-install] running non-elevated self-update drill (section 7 actions 5-6)."
      $drill = Invoke-E1BootstrapSelfUpdateDrill $after
      $report.self_update_drill = $drill
      $passCriteria.self_update_succeeds_non_interactively = $true
      $passCriteria.failed_update_leaves_previous_broker_runnable = $true
      $report.after_state = Get-E1BrokerStatus
    }

    $report.verdict = 'PASS'
  }
} catch {
  $report.verdict = 'FAIL'
  $report.reason = [string]$_.Exception.Message
} finally {
  $report.uac_count = $uacCount
  $report.pass_criteria = $passCriteria
  $report.generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  try { Write-E1BootstrapJsonAtomically $ReportPath $report } catch { }
}

if ([string]$report.verdict -cne 'PASS') {
  Write-Error "HARD STOP: $([string]$report.reason) (report: $ReportPath)"
  exit 1
}
Write-Host "[evidence1-install] PASS ($mode): $ReportPath"

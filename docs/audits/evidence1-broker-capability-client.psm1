# evidence1-broker-capability-client.psm1
#
# Non-elevated submission side of the new capability-dispatch protocol (see
# evidence1-broker-capability-contract.psm1's header for the full
# architectural account, and evidence1-host-broker-capability-dispatch.ps1
# for the elevated side this submits to).
#
# Deliberately does NOT invoke evidence1-host-elevated-runner-client.ps1 as a
# subprocess. evidence1-install.ps1 already established the precedent for
# this: its own header states it "Mirrors evidence1-host-elevated-runner-client.ps1's
# own request contract" with an INLINE reimplementation (same mutex-name
# derivation, same requests/in-progress/responses layout, same
# schtasks.exe /Run trigger) rather than shelling out to the generic client
# script, because it needs to build its OWN specific request payload. This
# module does the same, for the same reason -- it needs to write BOTH the
# capability-scoped request (evidence1-broker-capability-contract.psm1's own
# schema) AND the outer generic queue request the elevated runner already
# understands, in that order, atomically enough that a caller only ever
# calls one function.
#
# Reuses the EXACT mutex-name derivation
# evidence1-host-elevated-runner-client.ps1 and evidence1-install.ps1 both
# already use (SHA256 of the lowercased QueueRoot, first 24 hex chars,
# "Local\Evidence1RunnerClient-<hash>") -- not a new, parallel lock. A
# capability submission and a self-install submission against the SAME
# QueueRoot correctly contend for the SAME system mutex and can never run
# concurrently against the one real Scheduled Task, exactly as any two
# existing callers of that queue already cannot.
#
# The one deliberately injectable seam is -TriggerTask: the REAL default
# (Invoke-E1BrokerCapabilityTriggerTask) calls schtasks.exe /Run, the exact
# never-executed-by-this-engagement action every *-client.ps1/install.ps1 in
# this repo already guards behind the same standing boundary. Everything
# else in this module (mutex acquire/release, busy-check, request
# construction and CreateNew writes, response polling/parsing/shape
# assertion) is genuinely safe to execute in a test against a
# $TestDrive-scoped QueueRoot and a fake trigger -- and is exercised for
# real, not only traced, by this round's Pester coverage.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-broker-capability-contract.psm1') -Force -DisableNameChecking -Global

# The one real, currently-deployed queue this entire engagement already uses
# -- same literal as evidence1-install.ps1's own $RequiredQueueRootLiteral
# and evidence1-host-elevated-runner-install.ps1's own pinned -QueueRoot for
# the self-install request (Assert-E1SelfInstallRunnerArguments). Overridable
# per call (e.g. for tests) via -QueueRoot; this is only the default.
function Get-E1BrokerCapabilityDefaultQueueRoot { return 'C:\kmp-eval\scratch\host-elevated-runner-codex' }

# Same literal as evidence1-broker-status-contract.psm1's own
# Get-E1BrokerRequiredTaskName -- duplicated, not imported, to keep this
# module's own dependency surface limited to the one contract module it
# genuinely needs (matching this codebase's established per-file small-
# constant duplication convention rather than a cross-module import for one
# string).
function Get-E1BrokerCapabilityDefaultTaskName { return 'Evidence1CodexElevatedRunner' }

# Byte-for-byte the same derivation as
# evidence1-host-elevated-runner-client.ps1's own inline mutex-name logic --
# copied, not reinvented, so the two are guaranteed to agree for the same
# QueueRoot.
function Get-E1BrokerCapabilityClientMutexName([string]$QueueRoot) {
  $full = ([System.IO.Path]::GetFullPath($QueueRoot)).ToLowerInvariant()
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = [BitConverter]::ToString($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($full))).Replace('-', '').Substring(0, 24)
  } finally { $sha256.Dispose() }
  return "Local\Evidence1RunnerClient-$hash"
}

# Same create-new idiom every other write in this protocol uses.
function Write-E1BrokerCapabilityCreateNewJson([string]$Path, $Value) {
  [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path))
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 20))
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
  finally { $stream.Dispose() }
}

# REAL default trigger -- the one line in this whole module that would
# actually touch the live Scheduled Task if ever executed. Never called by
# any test in this round except with -TriggerTask overridden to a fake.
function Invoke-E1BrokerCapabilityTriggerTask([string]$TaskName) {
  $run = & schtasks.exe /Run /TN $TaskName 2>&1
  if ($LASTEXITCODE -ne 0) { throw "broker_capability_trigger_failed: $($run -join ' ')" }
}

# REAL default task-state reader (wedge fix from a flake
# investigation): schtasks.exe /Run can report success while silently
# dropping the actual start when it races a still-tearing-down -Once
# instance (MultipleInstances=IgnoreNew) -- confirmed live against the real
# broker, a single un-retried trigger orphaned a request and wedged this
# queue for every later caller until a manual re-trigger recovered it.
# Read-only, no side effects -- Get-ScheduledTask's own .State enum, never
# schtasks.exe's localized text output (same reasoning as
# Invoke-E1BrokerCapabilityEndTask's own note below: confirmed localized on
# this host, "Listo" not "Ready"). Safe to leave at its real default even in
# a test: unlike -TriggerTask, this has no side effect to guard against --
# the -GetTaskState seam exists for deterministic trigger-count assertions,
# not because this call is unsafe to make for real.
function Get-E1BrokerCapabilityRealTaskState([string]$TaskName) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) { return $null }
  return [string]$task.State
}

# REAL default End action (2026-09-28 stall recovery) -- the SECOND, and
# only other, line in this module that would actually touch the live
# Scheduled Task if ever executed. Never called by any test in this round
# except with -EndTask overridden to a fake. /End is not a UAC action: the
# task's own SDDL grants this user SID execute rights (the same right that
# already makes /Run work non-elevated) -- MS-TSCH SchRpcStop honors execute
# access for any caller, not just Administrators.
#
# Bundles the /End call and its own bounded confirmation wait into ONE seam
# rather than exposing a separate status-check seam: the caller
# (evidence1-run.ps1's stall-recovery attempt) only ever needs one answer,
# "did this end within the bound," and giving it that directly here keeps
# the recovery attempt from needing its own polling loop or its own
# schtasks.exe reference. Status is read via Get-ScheduledTask's .State
# enum (Ready/Running/Queued/...), NOT by parsing schtasks.exe's own text
# output -- that output is localized (confirmed on this host: "Listo", not
# "Ready"), so a text match for a specific status word would silently
# never match here. The enum's names are stable regardless of system
# locale. Never throws on a still-Running task past the bound: that is the
# honest "did not confirm" outcome the caller must be able to record and
# move on from, not a hard failure.
function Invoke-E1BrokerCapabilityEndTask {
  param([string]$TaskName, [int]$TimeoutSeconds = 30)
  $run = & schtasks.exe /End /TN $TaskName 2>&1
  $endExitCode = $LASTEXITCODE
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $stopped = $false
  do {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task -or [string]$task.State -cne 'Running') { $stopped = $true; break }
    Start-Sleep -Seconds 1
  } while ([DateTime]::UtcNow -lt $deadline)
  return [ordered]@{
    end_exit_code = $endExitCode
    end_output    = ($run -join ' ')
    stopped       = $stopped
  }
}

# Generic outer-queue submission for an already-allowlisted deployment script.
# It reuses this module's queue layout, create-new writer, mutex derivation and
# injectable trigger; the elevated runner remains the sole authority that
# verifies the deployment manifest/hash and accepts the script name.
function Submit-E1BrokerElevatedScript {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$ScriptPath,
    [string[]]$ScriptArguments = @(),
    [string]$QueueRoot = '', [string]$AllowedRoot = '',
    [string]$TaskName = (Get-E1BrokerCapabilityDefaultTaskName),
    [int]$TimeoutMinutes = (Get-E1BrokerCapabilityDefaultTimeoutMinutes),
    [int]$PollIntervalSeconds = 2,
    [scriptblock]$TriggerTask = $null,
    [scriptblock]$GetUtcNow = { [DateTime]::UtcNow }
  )
  if ([string]::IsNullOrWhiteSpace($QueueRoot)) { throw 'broker_outer_queue_root_required' }
  if ([string]::IsNullOrWhiteSpace($AllowedRoot)) { throw 'broker_outer_allowed_root_required' }
  if ($null -eq $TriggerTask) { throw 'broker_outer_trigger_task_required' }
  $queueRootFull = [IO.Path]::GetFullPath($QueueRoot)
  $null = Assert-E1BrokerCapabilityPathInside $queueRootFull 'C:\kmp-eval\scratch\'
  $allowedRootFull = ([IO.Path]::GetFullPath($AllowedRoot)).TrimEnd('\') + '\'
  $scriptFull = [IO.Path]::GetFullPath($ScriptPath)
  if (-not $scriptFull.StartsWith($allowedRootFull, [StringComparison]::OrdinalIgnoreCase)) { throw 'broker_outer_script_outside_allowed_root' }
  $now = & $GetUtcNow
  if ($now.Kind -ne [DateTimeKind]::Utc) { throw 'broker_outer_now_utc_must_be_utc_kind' }
  $requestsDir = Join-Path $queueRootFull 'requests'; $inProgressDir = Join-Path $queueRootFull 'in-progress'; $responsesDir = Join-Path $queueRootFull 'responses'
  New-Item -ItemType Directory -Force -Path $requestsDir,$inProgressDir,$responsesDir | Out-Null
  $mutex = [Threading.Mutex]::new($false, (Get-E1BrokerCapabilityClientMutexName $queueRootFull)); $ownsMutex = $false
  try {
    try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'broker_outer_queue_busy' }
    if (@(Get-ChildItem -LiteralPath $requestsDir -Filter '*.request.json' -File).Count -ne 0 -or @(Get-ChildItem -LiteralPath $inProgressDir -Filter '*.request.json' -File).Count -ne 0) { throw 'broker_outer_queue_busy' }
    $id = 'req-' + $now.ToString('yyyyMMdd-HHmmss') + '-' + ([Guid]::NewGuid().ToString('N').Substring(0,8))
    $requestPath = Join-Path $requestsDir "$id.request.json"; $responsePath = Join-Path $responsesDir "$id.response.json"
    Write-E1BrokerCapabilityCreateNewJson $requestPath ([ordered]@{ id=$id; created_at_utc=$now.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); script_path=$scriptFull; arguments=@($ScriptArguments) })
    & $TriggerTask $TaskName $requestPath $responsePath
    $deadline = (& $GetUtcNow).AddMinutes($TimeoutMinutes)
    while ((& $GetUtcNow) -lt $deadline) { if(Test-Path -LiteralPath $responsePath -PathType Leaf){ return (Get-Content -LiteralPath $responsePath -Raw | ConvertFrom-Json -ErrorAction Stop) }; Start-Sleep -Seconds $PollIntervalSeconds }
    throw "broker_outer_await_timeout: $responsePath"
  } finally { if($ownsMutex){try{$mutex.ReleaseMutex()}catch{}}; $mutex.Dispose() }
}

# Reads the closed guest-bundle registry from one deployed broker snapshot
# without importing it into the caller's module table.  The temporary dynamic
# module prevents the deployed contract (which has the same filename/module
# name as the checkout contract) from replacing commands already loaded by
# evidence1-run.ps1.
function Get-E1BrokerDeployedGuestBundleNames {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$DeploymentRoot)

  $contractPath = Join-Path ([IO.Path]::GetFullPath($DeploymentRoot)) 'evidence1-guest-bundle-contract.psm1'
  if (-not (Test-Path -LiteralPath $contractPath -PathType Leaf)) {
    throw 'broker_deployed_guest_bundle_contract_missing'
  }

  $module = $null
  try {
    $source = [IO.File]::ReadAllText($contractPath)
    $module = New-Module -Name ('E1DeployedGuestBundle-' + [Guid]::NewGuid().ToString('N')) `
      -ScriptBlock ([ScriptBlock]::Create($source))
    return @(& $module { Get-E1GuestBundleNames })
  } finally {
    if ($null -ne $module) { Remove-Module $module -Force -ErrorAction SilentlyContinue }
  }
}

# Performs the one-time, non-elevating broker migration needed to install the
# stable session and attestation-preparation bundles. Once both exist, ordinary
# harness revisions are synchronized into the guest by commit/tree and this
# function is a no-op; they never cause another broker update.
function Ensure-E1BrokerSessionBundle {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][bool]$UseRealBackends,
    [Parameter(Mandatory)][string]$CampaignRoot,
    [Parameter(Mandatory)][string]$InstallerPath,
    [Parameter(Mandatory)][scriptblock]$GetBrokerStatus,
    [scriptblock]$GetDeployedBundleNames = $null,
    [scriptblock]$InvokeBrokerUpdate = $null
  )

  if (-not $UseRealBackends) { return [ordered]@{ migrated = $false; bundle_present = $true } }
  if ($null -eq $GetDeployedBundleNames) {
    $GetDeployedBundleNames = { param($Root) Get-E1BrokerDeployedGuestBundleNames -DeploymentRoot $Root }
  }
  if ($null -eq $InvokeBrokerUpdate) {
    $InvokeBrokerUpdate = {
      param($Path, $ReceiptPath)
      # The installer force-imports its broker-status modules. Running it in
      # this process would replace this orchestrator's import and then remove
      # the replacement when the installer's script scope exits. Keep the
      # one-time update in an isolated child PowerShell process so the caller's
      # module graph remains intact after a successful migration.
      $hostExecutable = (Get-Process -Id $PID -ErrorAction Stop).Path
      & $hostExecutable -NoProfile -NonInteractive -File $Path -UpdateBroker -ReportPath $ReceiptPath
      if ($LASTEXITCODE -ne 0) { throw 'broker_session_bundle_migration_invocation_failed' }
    }
  }

  $requiredBundles = @('run-agentic-eval-session', 'prepare-agentic-eval-isolation-attestations')
  $status = & $GetBrokerStatus
  if ($null -eq $status -or -not [bool]$status.readable -or
      [string]::IsNullOrWhiteSpace([string]$status.deployment_root)) {
    throw 'broker_session_bundle_deployment_unavailable'
  }
  $names = @(& $GetDeployedBundleNames ([string]$status.deployment_root))
  if (@($requiredBundles | Where-Object { $_ -cnotin $names }).Count -eq 0) {
    return [ordered]@{ migrated = $false; bundle_present = $true; deployment_root = [string]$status.deployment_root }
  }
  if (-not [bool]$status.self_update_capable) {
    throw 'broker_session_bundle_missing_self_update_unavailable'
  }

  $reportPath = Join-Path $CampaignRoot 'broker-session-bundle-migration.json'
  try { [void](& $InvokeBrokerUpdate $InstallerPath $reportPath) }
  catch { throw 'broker_session_bundle_migration_failed' }
  if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
    throw 'broker_session_bundle_migration_failed'
  }
  try { $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json -ErrorAction Stop }
  catch { throw 'broker_session_bundle_migration_receipt_invalid' }
  if ([string]$report.verdict -cne 'PASS' -or [int]$report.uac_count -ne 0) {
    throw 'broker_session_bundle_migration_receipt_invalid'
  }

  $after = & $GetBrokerStatus
  $afterNames = if ($null -ne $after -and -not [string]::IsNullOrWhiteSpace([string]$after.deployment_root)) {
    @(& $GetDeployedBundleNames ([string]$after.deployment_root))
  } else { @() }
  if ($null -eq $after -or -not [bool]$after.readable -or
      [string]::IsNullOrWhiteSpace([string]$after.deployment_root) -or
      @($requiredBundles | Where-Object { $_ -cnotin $afterNames }).Count -ne 0) {
    throw 'broker_session_bundle_missing_after_migration'
  }
  return [ordered]@{ migrated = $true; bundle_present = $true; deployment_root = [string]$after.deployment_root }
}

# PUBLIC. Builds a closed capability request, writes it (create-new) into
# this QueueRoot's own capability-requests directory, writes the matching
# outer transport request the elevated runner already understands (naming
# evidence1-host-broker-capability-dispatch.ps1 as the ONE allowlisted
# script to run, with -CapabilityRequestPath as its only argument), triggers
# the Scheduled Task, and polls for the TYPED capability response (not the
# generic transport ack) until -TimeoutMinutes elapses.
#
# -GetUtcNow (default real [DateTime]::UtcNow) and -TriggerTask (default the
# real schtasks.exe call above) are both injectable so this entire function
# is exercisable end-to-end in a test with zero real elevation, zero real
# scheduled-task interaction, and zero real Start-Sleep waiting (a
# synchronous fake trigger that writes the response file itself makes the
# very first poll succeed).
function Submit-E1BrokerCapabilityOperation {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Capability,
    $Arguments = $null,
    # -QueueRoot/-TriggerTask have NO real-infrastructure default -- incident
    # fix, see docs/audits/evidence1-incident-2026-09-19-real-queue-trigger.md
    # and evidence1-broker-capability-dispatch-core.psm1's own header. Before
    # this fix, both silently defaulted to the REAL queue
    # (Get-E1BrokerCapabilityDefaultQueueRoot) and the REAL
    # schtasks.exe-driven trigger (Invoke-E1BrokerCapabilityTriggerTask) --
    # so any caller (test or production) that forgot to override them
    # reached real infrastructure without ever intending to.
    #
    # Deliberately NOT [Parameter(Mandatory)]: confirmed by direct testing,
    # not assumed, that PowerShell's own Mandatory-parameter handling PROMPTS
    # interactively for a missing value in a non-interactive host (Pester,
    # `powershell.exe -File`) rather than failing immediately -- which would
    # HANG a test or a real run forever instead of failing loudly, the exact
    # opposite of this fix's own requirement ("fails before writing any file
    # or starting any task"). An explicit empty-string/null default plus an
    # immediate guard-clause throw at the top of this function's own body,
    # below, is host-independent: it throws the same way whether this
    # function is called interactively, from Pester, or from
    # `powershell.exe -File` -- never a prompt, never a hang.
    # evidence1-run.ps1 is the one place that explicitly constructs the real
    # values today (its own Get-E1RunRealTransportArguments), and only when
    # -UseRealBackends is set.
    [string]$QueueRoot = '',
    [string]$AllowedRoot = '',
    [string]$TaskName = (Get-E1BrokerCapabilityDefaultTaskName),
    [int]$TimeoutMinutes = (Get-E1BrokerCapabilityDefaultTimeoutMinutes),
    [int]$PollIntervalSeconds = 2,
    # 2026-09-28 incident: a runner instance hung between claiming an outer
    # request and writing its own logs/<id>.log, orphaning it for the rest of
    # the night. Every real dispatch this engagement has produced (3885,
    # done/*.request.json + logs/*.log timestamps) was picked up and had its
    # log appear within max=10.9s (median 2.4s, p99 3.3s). 120s default is
    # roughly 11x that observed max -- generous, but bounded in minutes
    # rather than -TimeoutMinutes's own 120-MINUTE ceiling, which a hung
    # runner would otherwise force every caller to wait out in full.
    [int]$PickupTimeoutSeconds = 120,
    # 2026-09-29 wedge fix: bounds how many times a still-unclaimed request may
    # be re-triggered, and how often. 6 attempts * 5s = 30s worst case, well
    # inside the 120s PickupTimeoutSeconds default -- PickupTimeoutSeconds
    # remains the one real ceiling; these just decide how many /Run attempts
    # happen inside it.
    [int]$MaxTriggerAttempts = 6,
    [int]$RetriggerIntervalSeconds = 5,
    [scriptblock]$TriggerTask = $null,
    [scriptblock]$GetTaskState = { param($tn) Get-E1BrokerCapabilityRealTaskState $tn },
    [scriptblock]$GetUtcNow = { [DateTime]::UtcNow }
  )
  if ([string]::IsNullOrWhiteSpace($QueueRoot)) { throw 'broker_capability_client_queue_root_required' }
  if ($null -eq $TriggerTask) { throw 'broker_capability_client_trigger_task_required' }

  $queueRootFull = [System.IO.Path]::GetFullPath($QueueRoot)
  $null = Assert-E1BrokerCapabilityPathInside $queueRootFull 'C:\kmp-eval\scratch\'
  $allowedRootFull = if ([string]::IsNullOrWhiteSpace($AllowedRoot)) {
    [System.IO.Path]::GetFullPath($PSScriptRoot)
  } else {
    [System.IO.Path]::GetFullPath($AllowedRoot)
  }

  $now = & $GetUtcNow
  if ($now.Kind -ne [DateTimeKind]::Utc) { throw 'broker_capability_client_now_utc_must_be_utc_kind' }
  $operationId = [guid]::NewGuid().ToString('D')
  $request = New-E1BrokerCapabilityRequest -Capability $Capability -OperationId $operationId `
    -RequestedAtUtc ($now.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) -Arguments $Arguments

  $queuePaths = Get-E1BrokerCapabilityQueuePaths $queueRootFull
  $requestsOuterDir = Join-Path $queueRootFull 'requests'
  $inProgressOuterDir = Join-Path $queueRootFull 'in-progress'
  New-Item -ItemType Directory -Force -Path @(
    $queuePaths.requests_dir, $queuePaths.responses_dir, $queuePaths.operations_dir,
    $requestsOuterDir, $inProgressOuterDir
  ) | Out-Null

  $mutexName = Get-E1BrokerCapabilityClientMutexName $queueRootFull
  $mutex = [Threading.Mutex]::new($false, $mutexName)
  $ownsMutex = $false
  try {
    try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'broker_capability_queue_busy' }

    $queuedOuter = @(Get-ChildItem -LiteralPath $requestsOuterDir -Filter '*.request.json' -File -ErrorAction SilentlyContinue)
    $activeOuter = @(Get-ChildItem -LiteralPath $inProgressOuterDir -Filter '*.request.json' -File -ErrorAction SilentlyContinue)
    if ($queuedOuter.Count -ne 0 -or $activeOuter.Count -ne 0) {
      throw "broker_capability_queue_busy: queued=$($queuedOuter.Count); in_progress=$($activeOuter.Count)"
    }

    $capabilityRequestPath = Join-Path $queuePaths.requests_dir "$operationId.request.json"
    Write-E1BrokerCapabilityCreateNewJson $capabilityRequestPath $request

    $dispatcherScriptPath = Join-Path $allowedRootFull 'evidence1-host-broker-capability-dispatch.ps1'
    $outerId = 'req-' + $now.ToString('yyyyMMdd-HHmmss') + '-' + ([Guid]::NewGuid().ToString('N').Substring(0, 8))
    $outerRequestPath = Join-Path $requestsOuterDir "$outerId.request.json"
    $outerRequest = [ordered]@{
      id             = $outerId
      created_at_utc = $now.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      script_path    = $dispatcherScriptPath
      arguments      = @('-CapabilityRequestPath', $capabilityRequestPath)
    }
    Write-E1BrokerCapabilityCreateNewJson $outerRequestPath $outerRequest

    $responsePath = Join-Path $queuePaths.responses_dir "$operationId.response.json"
    $activeOuterRequestPath = Join-Path $inProgressOuterDir "$outerId.request.json"
    # logs/<outerId>.log (evidence1-host-elevated-runner.ps1:625/713, read-only reference --
    # this module never writes or depends on that file existing, it only checks for it) is the
    # runner's own proof of life for this specific dispatch: it opens the log handle immediately
    # after claiming the request (Move-Item into in-progress/), before doing any of the actual
    # work. Its absence past -PickupTimeoutSeconds means either the request was never claimed at
    # all (still sitting in requests/) or the runner claimed it and then died/hung before writing
    # anything -- the exact 2026-09-28 shape. Once the log exists, the runner is definitely alive
    # and working; from then on the normal -TimeoutMinutes wait applies completely unchanged,
    # since a real dispatch can legitimately run long.
    $logPath = Join-Path $queueRootFull ('logs\' + $outerId + '.log')
    # Three positional arguments, not just -TaskName: the real
    # Invoke-E1BrokerCapabilityTriggerTask (a plain, non-CmdletBinding
    # function -- deliberately, see its own definition) only reads the
    # first and silently absorbs the rest into its own $args, so this is a
    # no-op widening for the real path. It exists so a TEST's fake trigger
    # can know exactly which capability request it is being asked to
    # dispatch and where its response belongs, without the fake having to
    # predict this call's randomly-generated $operationId in advance.
    $triggerAttempts = 1
    & $TriggerTask $TaskName $capabilityRequestPath $responsePath
    $lastTriggerAt = & $GetUtcNow

    $pickupDeadline = (& $GetUtcNow).AddSeconds($PickupTimeoutSeconds)
    $deadline = (& $GetUtcNow).AddMinutes($TimeoutMinutes)
    $response = $null
    while ((& $GetUtcNow) -lt $deadline) {
      if (Test-Path -LiteralPath $responsePath -PathType Leaf) {
        $response = Get-Content -LiteralPath $responsePath -Raw | ConvertFrom-Json -ErrorAction Stop
        break
      }
      $now = & $GetUtcNow
      $logExists = Test-Path -LiteralPath $logPath -PathType Leaf
      if (-not $logExists -and $now -ge $pickupDeadline) {
        if (Test-Path -LiteralPath $outerRequestPath -PathType Leaf) { throw "broker_request_not_picked_up: $outerRequestPath" }
        throw "broker_request_stalled: $activeOuterRequestPath"
      }
      # Wedge fix (flake investigation): schtasks /Run can
      # report success while silently dropping the actual start when it races
      # a still-tearing-down -Once instance (MultipleInstances=IgnoreNew) --
      # confirmed live, a single un-retried trigger orphaned a request and
      # wedged this queue for every later caller until a manual re-trigger
      # recovered it. Re-trigger only while genuinely unclaimed -- broader
      # than $logExists above: the outer request having left requests/ at all
      # (claimed, even if the runner then stalls before logging) is already
      # proof /Run worked and a re-trigger would be pointless, not just proof
      # it finished -- and the task isn't already Running (a redundant
      # trigger while it IS running would just be a no-op, not worth spending
      # one of the bounded attempts on). Safe to retrigger regardless: the
      # runner claims via Move-Item, so a redundant trigger can never cause
      # double-processing.
      $claimed = $logExists -or -not (Test-Path -LiteralPath $outerRequestPath -PathType Leaf)
      if (-not $claimed -and $triggerAttempts -lt $MaxTriggerAttempts -and
          ($now - $lastTriggerAt).TotalSeconds -ge $RetriggerIntervalSeconds -and
          [string](& $GetTaskState $TaskName) -cne 'Running') {
        & $TriggerTask $TaskName $capabilityRequestPath $responsePath
        $triggerAttempts++
        $lastTriggerAt = $now
      }
      Start-Sleep -Seconds $PollIntervalSeconds
    }
    if ($null -eq $response) { throw "broker_capability_await_timeout: $responsePath" }
    Assert-E1BrokerCapabilityResponseShape $response
    if ([string]$response.operation_id -cne $operationId) { throw 'broker_capability_response_operation_id_mismatch' }

    while ((& $GetUtcNow) -lt $deadline -and (Test-Path -LiteralPath $activeOuterRequestPath -PathType Leaf)) {
      Start-Sleep -Seconds $PollIntervalSeconds
    }
    if (Test-Path -LiteralPath $activeOuterRequestPath -PathType Leaf) {
      throw "broker_capability_transport_await_timeout: $activeOuterRequestPath"
    }
    return $response
  } finally {
    if ($ownsMutex) { try { $mutex.ReleaseMutex() } catch { } }
    $mutex.Dispose()
  }
}

Export-ModuleMember -Function `
  Get-E1BrokerCapabilityDefaultQueueRoot, `
  Get-E1BrokerCapabilityDefaultTaskName, `
  Get-E1BrokerCapabilityClientMutexName, `
  Write-E1BrokerCapabilityCreateNewJson, `
  Invoke-E1BrokerCapabilityTriggerTask, `
  Get-E1BrokerCapabilityRealTaskState, `
  Invoke-E1BrokerCapabilityEndTask, `
  Submit-E1BrokerElevatedScript, `
  Get-E1BrokerDeployedGuestBundleNames, `
  Ensure-E1BrokerSessionBundle, `
  Submit-E1BrokerCapabilityOperation

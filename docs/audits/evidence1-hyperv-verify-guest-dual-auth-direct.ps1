#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory = $true)][string]$OperationId,
  [Parameter(Mandatory = $true)][string]$RemoteAuthCanaryAuthorizationPhrase,
  [Parameter(Mandatory = $true)][string]$ProfilePath,
  [Parameter(Mandatory = $true)][string]$CreatedInspectionReceiptPath,
  [Parameter(Mandatory = $true)][string]$GuestCredentialPath,
  [Parameter(Mandatory = $true)][string]$ReadinessReportPath,
  [Parameter(Mandatory = $true)][string]$AccountBindingReportPath,
  [Parameter(Mandatory = $true)][string]$ExpectedClaudeAccount,
  [Parameter(Mandatory = $true)][string]$ExpectedCodexAccount,
  [string]$GuestReadinessPath = 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1\READINESS.json',
  [string]$ClaudeModel = 'claude-sonnet-5',
  [string]$CodexModel = 'gpt-5.6-terra',
  [switch]$ModelPairCanary,
  [ValidateRange(60, 900)][int]$OuterTimeoutSeconds = 480
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-vm-identity-contract.psm1') -Force -DisableNameChecking
# Task 3: the catch block's own FAIL report is now built through the shared,
# independently-testable New-Evidence1DualAuthFailureReport rather than a
# hand-built inline hashtable -- see that function's own header
# (evidence1-live-handoff-contract.psm1) for why.
Import-Module (Join-Path $PSScriptRoot 'evidence1-live-handoff-contract.psm1') -Force -DisableNameChecking
$vmIdentity = Get-Evidence1CanonicalE2EVmIdentity -ProfilePath $ProfilePath `
  -CreatedInspectionReceiptPath $CreatedInspectionReceiptPath -GuestCredentialPath $GuestCredentialPath
$VMName = $vmIdentity.vm_name
$VMId = $vmIdentity.vm_id
$GuestComputerName = $vmIdentity.guest_computer_name
$GuestUser = $vmIdentity.guest_user
$ClaudeVersion = '2.1.238'
$CodexVersion = '0.154.0'
$GuestOperationRoot = 'C:\Evidence1Ops\remote-auth-canary-v2'
$HostOperationRoot = 'C:\kmp-eval\scratch\evidence1-dual-auth-canary-e2e'
$GuestScriptPath = Join-Path $PSScriptRoot 'evidence1-guest-dual-auth-canary.ps1'
$CredentialOverrideNames = @(
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'AZURE_OPENAI_API_KEY', 'GOOGLE_API_KEY',
  'GH_TOKEN', 'GITHUB_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'
)
$RequiredPhrase = 'AUTORIZO EXACTAMENTE 2 SESIONES REMOTE-AUTH CANARY PARA ' + ('EVIDENCE' + '1') + ': 1 CLAUDE-CODE Y 1 CODEX-CLI; SIN REINTENTOS, REEMPLAZOS NI RESPAWNS.'
$CanonicalGuestReadinessPath = 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1\READINESS.json'
$AllowedModelPairs = [ordered]@{
  'claude-fable-5' = 'gpt-6-astra'
  'claude-opus-5' = 'gpt-5.6-sol'
  'claude-sonnet-5' = 'gpt-5.6-terra'
  'claude-haiku-4-5-20251001' = 'gpt-5.6-luna'
}

function Fail([string]$Code) { throw "HARD STOP: $Code" }

function Assert-PathInside([string]$Path, [string]$Root, [string]$Code) {
  $full = [IO.Path]::GetFullPath($Path)
  $base = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  if (-not $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { Fail $Code }
  return $full
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

function Write-CreateNewJson([string]$Path, $Value) {
  [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path))
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 20 -Compress))
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
  finally { $stream.Dispose() }
}

function Stop-E1JobBounded($Job, [int]$TimeoutMilliseconds) {
  if ($Job.State -in @('Stopped', 'Completed', 'Failed')) { return $true }
  $child = @($Job.ChildJobs)[0]
  if ($null -eq $child) { return $false }
  $method = $child.GetType().GetMethod('StopJob', [Type]::EmptyTypes)
  if ($null -eq $method) { return $false }
  $action = [Delegate]::CreateDelegate([Action], $child, $method)
  $stopTask = [Threading.Tasks.Task]::Factory.StartNew($action)
  try {
    if (-not $stopTask.Wait($TimeoutMilliseconds)) { return $false }
  } catch { return $false }
  return $Job.State -in @('Stopped', 'Completed', 'Failed')
}

$parsedOperation = [guid]::Empty
if (-not [guid]::TryParseExact($OperationId, 'D', [ref]$parsedOperation) -or $parsedOperation -eq [guid]::Empty -or
  $OperationId -cne $parsedOperation.ToString('D')) { Fail 'operation_id_invalid' }
if ($RemoteAuthCanaryAuthorizationPhrase -cne $RequiredPhrase) { Fail 'dual_canary_authorization_required' }
if ($ModelPairCanary) {
  if (-not $AllowedModelPairs.Contains($ClaudeModel) -or [string]$AllowedModelPairs[$ClaudeModel] -cne $CodexModel) {
    Fail 'model_pair_mismatch'
  }
} elseif ($ClaudeModel -cne 'claude-sonnet-5' -or $CodexModel -cne 'gpt-5.6-terra') {
  Fail 'noncanonical_default_model_pair'
}
# Task 2 (dual-auth FAIL-report schema -- real design work, not a blind
# number swap): $hostOperationPath/$hostFinalPath only depend on
# $HostOperationRoot (static) and $OperationId (already validated as a
# canonical GUID string above) -- hoisted here, before any other
# operational work, so the catch block below always has a valid, safe
# destination to write to no matter how early inside the try a failure
# occurs. $stage/$readinessSha/$accountBindingSha/$hostReport are
# pre-declared for the same reason: Set-StrictMode -Version Latest (line
# 18) means the catch block cannot reference a variable that was never
# assigned on the failing path.
#
# The try block now starts HERE, immediately after argument/authorization
# validation -- not at the old, narrower 'try {' this replaces. Account-
# binding loading/validation and the operation claim are real operational
# work whose failure deserves the same terminal FAIL report every later
# failure already got; previously a failure in either of those produced NO
# report at all (this file had no try/catch covering them), silently
# violating "an ambiguous or partially-written state must never be reported
# as anything but a clear failure." Argument/authorization validation
# itself (above: Fail 'operation_id_invalid' / 'dual_canary_authorization_required'
# / 'model_pair_mismatch' / 'noncanonical_default_model_pair') stays OUTSIDE
# this try on purpose: an unvalidated $OperationId cannot safely key a
# report path at all (path injection risk), and a caller-argument violation
# is not an attempted-and-failed OPERATION in the sense the catch block
# below reports on -- the caller's own error stream is where that feedback
# belongs, matching how this codebase's other orchestration scripts (e.g.
# evidence1-run.ps1's own Fail() calls for -TargetState/-CampaignId) never
# write a durable artifact for pure argument validation either.
#
# $stage is a coarse, CLOSED checkpoint enum (never derived from exception
# text) read only by the catch block below to pick a stable reason_code and
# decide which hash fields have real values yet -- mirrors
# evidence1-hyperv-start-authorized-live.ps1's own $phase/Write-HandoffState
# 'failed' $phase pattern for the identical "which stage were we in when
# this failed" problem, not a new idiom invented here.
$hostOperationPath = Join-Path $HostOperationRoot $OperationId
$hostFinalPath = Join-Path $hostOperationPath 'host-final.json'
$stage = 'before_account_binding_loaded'
$readinessSha = $null
$accountBindingSha = $null
$hostReport = $null

try {
  $GuestCredentialPath = Assert-PathInside $GuestCredentialPath 'C:\kmp-eval\scratch' 'guest_credential_path_invalid'
  $ReadinessReportPath = Assert-PathInside $ReadinessReportPath 'C:\kmp-eval\scratch' 'readiness_report_path_invalid'
  $AccountBindingReportPath = Assert-PathInside $AccountBindingReportPath 'C:\kmp-eval\scratch\evidence1-account-mapping' 'account_binding_report_path_invalid'
  if ([IO.Path]::GetFullPath($GuestCredentialPath) -cne $vmIdentity.guest_credential_path -or
    [IO.Path]::GetFullPath($GuestReadinessPath) -cne $CanonicalGuestReadinessPath) {
    Fail 'e2e_operational_path_mismatch'
  }
  if (-not (Test-Path -LiteralPath $GuestScriptPath -PathType Leaf)) { Fail 'guest_script_missing' }
  if (-not (Test-Path -LiteralPath $AccountBindingReportPath -PathType Leaf)) { Fail 'account_binding_report_missing' }
  try { $accountBinding = Get-Content -LiteralPath $AccountBindingReportPath -Raw | ConvertFrom-Json -ErrorAction Stop }
  catch { Fail 'account_binding_report_invalid' }
  foreach ($field in @('verdict', 'generated_at_utc', 'vm_id', 'expected_mapping', 'checks', 'provider_process_started', 'final_provider_sessions_consumed')) {
    if (-not $accountBinding.PSObject.Properties[$field]) { Fail 'account_binding_report_invalid' }
  }
  $bindingAt = [DateTime]::MinValue
  if (-not [DateTime]::TryParse([string]$accountBinding.generated_at_utc, [ref]$bindingAt)) { Fail 'account_binding_report_invalid' }
  if ([DateTime]::UtcNow - $bindingAt.ToUniversalTime() -gt [TimeSpan]::FromMinutes(60)) { Fail 'account_binding_report_stale' }
  if ($accountBinding.verdict -cne 'PASS' -or ([string]$accountBinding.vm_id).ToLowerInvariant() -cne $VMId -or
      $accountBinding.expected_mapping.claude -cne $ExpectedClaudeAccount -or $accountBinding.expected_mapping.codex -cne $ExpectedCodexAccount -or
    $accountBinding.checks.claude.subscription_type -cne 'max' -or
    $accountBinding.checks.claude.rate_limit_tier -cne 'default_claude_max_20x' -or
    $accountBinding.checks.claude.binding_valid -ne $true -or
    $accountBinding.checks.codex.plan_type -cne 'pro' -or $accountBinding.checks.codex.binding_valid -ne $true -or
    $accountBinding.provider_process_started -ne $false -or [int]$accountBinding.final_provider_sessions_consumed -ne 0) {
    Fail 'account_binding_report_invalid'
  }
  $accountBindingSha = Get-Sha256 $AccountBindingReportPath
  $stage = 'account_binding_loaded'

  if (Test-Path -LiteralPath $hostOperationPath) { Fail 'operation_already_claimed_on_host' }
  [void](New-Item -ItemType Directory -Path $hostOperationPath)

  if (-not (Test-Path -LiteralPath $ReadinessReportPath -PathType Leaf)) { Fail 'readiness_report_missing' }
  $readiness = Get-Content -LiteralPath $ReadinessReportPath -Raw | ConvertFrom-Json -ErrorAction Stop
  foreach ($field in @('verdict', 'generated_at_utc', 'vm_name', 'vm_id')) {
    if (-not $readiness.PSObject.Properties[$field]) { Fail 'readiness_report_shape_invalid' }
  }
  if ($readiness.verdict -cne 'PASS' -or $readiness.vm_name -cne $VMName -or
    ([string]$readiness.vm_id).ToLowerInvariant() -cne $VMId) { Fail 'readiness_e2e_identity_mismatch' }
  if (-not $readiness.PSObject.Properties['vm_identity'] -or
    $readiness.vm_identity.profile_sha256 -cne $vmIdentity.profile_sha256 -or
    $readiness.vm_identity.created_inspection_receipt_sha256 -cne $vmIdentity.created_inspection_receipt_sha256 -or
    $readiness.vm_identity.custody_marker_sha256 -cne $vmIdentity.custody_marker_sha256 -or
    $readiness.vm_identity.input_lock_sha256 -cne $vmIdentity.input_lock_sha256) {
    Fail 'readiness_vm_identity_binding_mismatch'
  }
  $readinessAt = [DateTime]::MinValue
  if (-not [DateTime]::TryParse([string]$readiness.generated_at_utc, [ref]$readinessAt)) { Fail 'readiness_timestamp_invalid' }
  $readinessSha = Get-Sha256 $ReadinessReportPath
  $stage = 'readiness_obtained'

  $vm = Get-VM -Name $VMName -ErrorAction Stop
  if ([string]$vm.State -cne 'Running' -or ([string]$vm.Id).ToLowerInvariant() -cne $VMId) { Fail 'e2e_vm_identity_mismatch' }
  if (-not (Test-Path -LiteralPath $GuestCredentialPath -PathType Leaf)) { Fail 'guest_credential_missing' }
  $stored = Import-Clixml -LiteralPath $GuestCredentialPath
  if ($stored.UserName -cne $GuestUser) { Fail 'guest_credential_identity_mismatch' }
  $credential = [pscredential]::new("$GuestComputerName\$GuestUser", $stored.Password)

  $invocationJson = ([ordered]@{
      operation_id = $OperationId; operation_root = $GuestOperationRoot; guest_readiness_path = $GuestReadinessPath
      host_readiness_sha256 = $readinessSha
      host_readiness_generated_at_utc = $readinessAt.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      authorization = $RemoteAuthCanaryAuthorizationPhrase; vm_name = $VMName; vm_id = $VMId
      claude_version = $ClaudeVersion; codex_version = $CodexVersion; claude_model = $ClaudeModel; codex_model = $CodexModel
      model_pair_canary = [bool]$ModelPairCanary
      claude_command = 'C:\Evidence1Toolchain\claude-code\2.1.238\claude.cmd'
    codex_command = 'C:\Evidence1Toolchain\codex-cli\0.154.0\bin\codex.exe'
      credential_names = [string]::Join(',', $CredentialOverrideNames)
    } | ConvertTo-Json -Compress)
  $job = Start-Job -ScriptBlock {
    param($VMId, $Credential, $GuestScriptPath, $InvocationJson)
    $a = $InvocationJson | ConvertFrom-Json
    if ($a.model_pair_canary -eq $true) {
      Invoke-Command -VMId ([guid]$VMId) -Credential $Credential -ScriptBlock {
        param($OperationId, $ClaudeModel, $CodexModel)
        $requestDir = 'C:\Evidence1Ops\remote-auth-canary-v2\model-pair-requests'
        [void](New-Item -ItemType Directory -Force -Path $requestDir)
        $requestPath = Join-Path $requestDir "$OperationId.json"
        $request = [ordered]@{
          schema = 1; operation_id = $OperationId; claude_model = $ClaudeModel; codex_model = $CodexModel
          campaign_kind = 'paired-model-availability-canary'
        }
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($request | ConvertTo-Json -Compress))
        $stream = [IO.File]::Open($requestPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
      } -ArgumentList $a.operation_id, $a.claude_model, $a.codex_model -ErrorAction Stop
    }
    $arguments = @(
      $a.operation_id, $a.operation_root, $a.guest_readiness_path, $a.host_readiness_sha256,
      $a.host_readiness_generated_at_utc, $a.authorization, $a.vm_name, $a.vm_id,
      $a.claude_version, $a.codex_version, $a.codex_model, $a.claude_command, $a.codex_command, $a.credential_names
    )
    Invoke-Command -VMId ([guid]$VMId) -Credential $Credential -FilePath $GuestScriptPath -ArgumentList $arguments -ErrorAction Stop
  } -ArgumentList $VMId, $credential, $GuestScriptPath, $invocationJson
  $stage = 'guest_operation_dispatched'
  try {
    $completed = Wait-Job -Job $job -Timeout $OuterTimeoutSeconds
    if (-not $completed) {
      # Persist an abort in the guest while the origin is still reachable. The origin
      # acknowledges only after its active Job Object is empty; the durable marker
      # prevents every later preflight/provider spawn.
      $abortJob = Start-Job -ScriptBlock {
        param($VMId, $Credential, $GuestScriptPath, $InvocationJson)
        $a = $InvocationJson | ConvertFrom-Json
        $arguments = @(
          $a.operation_id, $a.operation_root, $a.guest_readiness_path, $a.host_readiness_sha256,
          $a.host_readiness_generated_at_utc, $a.authorization, $a.vm_name, $a.vm_id,
          $a.claude_version, $a.codex_version, $a.codex_model, $a.claude_command, $a.codex_command, $a.credential_names,
          $false, $false, $true
        )
        Invoke-Command -VMId ([guid]$VMId) -Credential $Credential -FilePath $GuestScriptPath -ArgumentList $arguments -ErrorAction Stop
      } -ArgumentList $VMId, $credential, $GuestScriptPath, $invocationJson
      try {
        $abortCompleted = Wait-Job -Job $abortJob -Timeout 45
        $abortResult = if ($abortCompleted) { Receive-Job -Job $abortJob -ErrorAction Stop } else { $null }
        $abortAcknowledged = $null -ne $abortResult -and $abortResult.abort_claimed -eq $true -and
          $abortResult.abort_acknowledged -eq $true -and $abortResult.cleanup_confirmed -eq $true
      } finally {
        [void](Stop-E1JobBounded $abortJob 15000)
        Remove-Job -Job $abortJob -Force -ErrorAction SilentlyContinue
      }
      $originStopped = Stop-E1JobBounded $job 135000
      if (-not $originStopped) { Fail 'outer_timeout_origin_stop_not_confirmed' }
      $cleanupJob = Start-Job -ScriptBlock {
        param($VMId, $Credential, $GuestScriptPath, $InvocationJson)
        $a = $InvocationJson | ConvertFrom-Json
        $arguments = @(
          $a.operation_id, $a.operation_root, $a.guest_readiness_path, $a.host_readiness_sha256,
          $a.host_readiness_generated_at_utc, $a.authorization, $a.vm_name, $a.vm_id,
          $a.claude_version, $a.codex_version, $a.codex_model, $a.claude_command, $a.codex_command, $a.credential_names, $true, $true
        )
        Invoke-Command -VMId ([guid]$VMId) -Credential $Credential -FilePath $GuestScriptPath -ArgumentList $arguments -ErrorAction Stop
      } -ArgumentList $VMId, $credential, $GuestScriptPath, $invocationJson
      try {
        $cleanupCompleted = Wait-Job -Job $cleanupJob -Timeout 45
        $cleanup = if ($cleanupCompleted) { Receive-Job -Job $cleanupJob -ErrorAction Stop } else { $null }
        if (-not $abortAcknowledged -or -not $originStopped -or -not $cleanup -or $cleanup.cleanup_confirmed -ne $true -or
          $cleanup.quiescence_confirmed -ne $true) { Fail 'outer_timeout_cleanup_not_confirmed' }
      } finally {
        [void](Stop-E1JobBounded $cleanupJob 15000)
        Remove-Job -Job $cleanupJob -Force -ErrorAction SilentlyContinue
      }
      Fail 'outer_timeout_attempt_consumed'
    }
    $stage = 'guest_execution_completed'
    $canaryWire = @(Receive-Job -Job $job -ErrorAction Stop)
    if ($canaryWire.Count -ne 1 -or $canaryWire[0] -isnot [string]) { Fail 'guest_canary_transport_shape_invalid' }
    $canary = [string]$canaryWire[0] | ConvertFrom-Json -ErrorAction Stop
    $stage = 'guest_result_read'
  } finally {
    [void](Stop-E1JobBounded $job 15000)
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }

  # schema=2: this
  # producer always sets $CodexVersion (line 28, unconditional) -- there is
  # no code path in this file where Codex is NOT expected -- so its report
  # must always satisfy evidence1-live-handoff-contract.psm1's dual-auth,
  # Codex-expected branch, which now requires schema=2 with this exact
  # 12-key shape (account_binding_sha256/model_pair already present below,
  # unchanged). schema=1 remains valid only for the OTHER, single-runtime
  # legacy producer/shape this file has never emitted.
  $hostReport = [ordered]@{
    schema = 2; verdict = $(if ($canary.state -ceq 'passed') { 'PASS' } else { 'FAIL' })
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    operation_id = $OperationId; vm_name = $VMName; vm_id = $VMId; vm_state = [string]$vm.State
    readiness_sha256 = $readinessSha; account_binding_sha256 = $accountBindingSha; remote_auth_canary = $canary
    model_pair = [ordered]@{
      campaign_kind = $(if ($ModelPairCanary) { 'paired-model-availability-canary' } else { 'canonical-auth-canary' })
      claude_model = $ClaudeModel; codex_model = $CodexModel
    }
    privacy = [ordered]@{ raw_content_persisted = $false; raw_content_printed = $false; error_text_persisted = $false }
  }
  $stage = 'writing_completed_report'
  Write-CreateNewJson $hostFinalPath $hostReport
  if ($hostReport.verdict -cne 'PASS') { Fail 'dual_auth_canary_failed' }
  Write-Host "[hyperv-verify-guest-dual-auth-direct] PASS: $hostFinalPath"
} catch {
  # FAIL report design (Task 2, maintainer's decided fix): schema=2 always
  # (never schema=1 -- the producer never emits schema=1 again, matching
  # the success path above), but its own explicit, MINIMAL shape, distinct
  # from the 12-key PASS shape above -- PASS assumes data (vm_state,
  # remote_auth_canary) that may not exist yet when a failure happens.
  # Always includes: operation identity (operation_id), VM identity
  # (vm_name/vm_id -- both resolved at the very top of this file, before
  # even argument validation, so always real here), model_pair and privacy
  # (both static/parameter-derived, never dependent on how far execution
  # got), and a stable, CLOSED-ENUM reason_code -- never the caught
  # exception's own message, a token, an OAuth code, or any remote/guest
  # content. readiness_sha256/account_binding_sha256 carry their REAL
  # value once actually computed ($readinessSha/$accountBindingSha,
  # hoisted above the try and set at their own checkpoints) and stay
  # explicit $null otherwise -- never a fabricated or placeholder-shaped
  # hash. $stage (hoisted above the try, advanced only after each
  # checkpoint's work genuinely completes) is the ONLY input to
  # reason_code -- never the exception itself, so this can never leak
  # exception text.
  if ($null -eq $hostReport -and -not (Test-Path -LiteralPath $hostFinalPath)) {
    $failureReasonCode = switch ($stage) {
      'before_account_binding_loaded' { 'dual_auth_failed_before_account_binding_loaded' }
      'account_binding_loaded'        { 'dual_auth_failed_after_account_binding_before_readiness' }
      'readiness_obtained'            { 'dual_auth_failed_after_readiness_before_guest_operation' }
      'guest_operation_dispatched'    { 'dual_auth_failed_during_guest_execution' }
      'guest_execution_completed'     { 'dual_auth_failed_reading_guest_result' }
      'guest_result_read'             { 'dual_auth_failed_writing_completed_report' }
      'writing_completed_report'      { 'dual_auth_failed_writing_completed_report' }
      default                         { 'dual_auth_failed_before_account_binding_loaded' }
    }
    # Task 3: report CONSTRUCTION now goes through the shared, pure
    # New-Evidence1DualAuthFailureReport builder (evidence1-live-handoff-contract.psm1)
    # instead of a hand-built inline hashtable -- same 11-key schema=2 shape,
    # same reason_code (the mapped $failureReasonCode computed above, passed
    # straight through, never recomputed inside the builder), same nullable
    # readiness_sha256/account_binding_sha256 semantics. The builder itself
    # refuses an exception/error-record value for any data parameter and
    # enforces the closed reason_code enum -- see its own header.
    #
    # Fail-closed even here: if THIS write itself throws (task 2's/3's fifth
    # failure-injection point -- "failure while trying to write the failure
    # report itself"), Write-CreateNewJson's own [IO.FileMode]::CreateNew
    # (this file's helper, above) guarantees it never overwrites an
    # existing $hostFinalPath -- it throws IOException instead, which is
    # not caught here and propagates out through the unconditional `throw`
    # below being skipped in favor of that NEW exception. Either way this
    # process still terminates with an uncaught exception and a non-zero
    # exit ($ErrorActionPreference = 'Stop', line 19) -- a terminal,
    # machine-readable outcome (the process exit code) even when no JSON
    # could be durably written, and never a silent partial write standing
    # in for evidence.
    $failureReport = New-Evidence1DualAuthFailureReport -ReasonCode $failureReasonCode `
      -OperationId $OperationId -VMName $VMName -VMId $VMId `
      -ReadinessSha256 $readinessSha -AccountBindingSha256 $accountBindingSha `
      -ModelPairCanary:$ModelPairCanary -ClaudeModel $ClaudeModel -CodexModel $CodexModel
    Write-CreateNewJson $hostFinalPath $failureReport
  }
  throw
}

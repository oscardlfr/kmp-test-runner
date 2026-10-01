param(
  [ValidateSet('DryRun','Live','FakeRuntime')][string]$Mode = 'DryRun',
  [string]$OperationRoot = '',
  [string]$AuthorizationPhrase = '',
  [string]$HarnessDir = 'C:\kmp-eval\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1',
  [string]$SourceTemplateDir = 'C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1',
  [string]$ClaudeAttestationFile = 'C:\kmp-eval\measurement-scopes\evidence1-claude-windows-isolation-attestation-stageb-v1.json',
  [string]$CodexAttestationFile = 'C:\kmp-eval\measurement-scopes\evidence1-codex-windows-isolation-attestation.json',
  [string]$ReadinessPath = 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1\READINESS.json',
  [string]$RemoteAuthCanaryOperationId = '',
  [string]$PrivateRoot = 'C:\Evidence1Private\dual-condition-canary',
  [string]$FakeRuntimeScript = '',
  [switch]$TestMode,
  [switch]$InternalLibrary
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:E1ToolchainRoot = 'C:\Evidence1Toolchain'
$script:E1NodeCommand = Join-Path $script:E1ToolchainRoot 'node\24.19.0\node.exe'
$script:E1ClaudeCommand = Join-Path $script:E1ToolchainRoot 'claude-code\2.1.238\claude.cmd'
$script:E1CodexCommand = Join-Path $script:E1ToolchainRoot 'codex-cli\0.154.0\bin\codex.exe'
$script:E1GitCommandRoot = Join-Path $script:E1ToolchainRoot 'git\2.55.0.windows.5'
$script:E1GitBashRoot = Join-Path $script:E1ToolchainRoot 'git-bash\2.55.0.windows.5'
$script:E1GitBashCommand = Join-Path $script:E1GitBashRoot 'bin\bash.exe'
$script:E1JdkRoot = Join-Path $script:E1ToolchainRoot 'jdk\21.0.12.1+1'
$script:E1AndroidRoot = Join-Path $script:E1ToolchainRoot 'android-sdk\platform-36-build-tools-36.0.0'
$script:E1CodexRuntimeRoot = 'C:\Evidence1RuntimeState'
$script:E1CodexHome = Join-Path $script:E1CodexRuntimeRoot 'codex'
$script:E1GradleUserHomeSeedDir = Join-Path $env:USERPROFILE '.gradle'

function Clear-E1LegacyFinalCampaignEnvironment {
  foreach($legacyFinalCampaignVariable in @(
    'KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_BINDING',
    'KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_BINDING_SHA256',
    'KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_AUTH_CLAIM',
    'KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_AUTH_CLAIM_SHA256',
    'KMP_AGENTIC_EVAL_FINAL_GLOBAL_AUTH_CLAIM',
    'KMP_AGENTIC_EVAL_FINAL_GLOBAL_AUTH_CLAIM_SHA256'
  )){
    [Environment]::SetEnvironmentVariable($legacyFinalCampaignVariable,$null,'Process')
  }
}

function Get-E1SanitizedProcessFailureReason($Result) {
  $text=([string]$Result.stderr)+"`n"+([string]$Result.stdout)
  $permissionDenied=$text-match'(?i)(EACCES|access is denied|permission denied)'
  $hardGateChecks = @(
    'availabilityOk','noSkillSafetyOk','pluginProfileOk','pluginSnapshotBindingOk','skillSelectionOk',
    'foreignSkillToolResultsCompleteOk','initOk','toolProfileOk','noUnexpectedToolsOk','hookAccountingOk',
    'cleanTranscriptOk','transcriptStructureOk','toolResultsCompleteOk','terminationOk','junitEvidenceOk',
    'parallelEvidenceOk','changedEvidenceOk','junitSkipEvidenceOk','junitCaptureCompleteOk',
    'ambientSkillProfileOk','targetSkillAmbientIdentityOk','ambientProfileMatrixOk','noPreInferenceFailureOk'
  )
  $failedChecks = @($hardGateChecks | Where-Object { $text -cmatch ([regex]::Escape($_) + ':false') })
  if($failedChecks.Count -gt 0){return 'dual_condition_runtime_hard_gate_' + (($failedChecks | ForEach-Object {$_.ToLowerInvariant()}) -join '_')}
  if($text-match'(?i)(401|unauthori[sz]ed|not logged in|login required|auth(entication)? failed)'){return 'dual_condition_runtime_auth_failed'}
  if($text-match'(?i)(provider_model_unsupported|model[^\r\n]{0,80}(unsupported|not available|not found))'){return 'dual_condition_runtime_model_unsupported'}
  if($text-match'(?i)(ENOENT|command not found|not recognized as an internal|executable file not found)'){return 'dual_condition_runtime_command_missing'}
  if($text-match'(?i)(KMP_EVAL_BASH_PATH|bash[^\r\n]{0,80}(missing|not found|invalid))'){return 'dual_condition_runtime_bash_unavailable'}
  if($permissionDenied-and$text-match'(?i)(materializeSkillSnapshot|git archive|tar extraction|kmp-agentic-eval-skill)'){return 'dual_condition_runtime_skill_materialization_permission_denied'}
  if($permissionDenied-and$text-match'(?i)(materializeScenarioProject|git worktree|cannot lock ref|kmp-agentic-eval-scenario)'){return 'dual_condition_runtime_worktree_permission_denied'}
  if($permissionDenied-and$text-match'(?i)(spawnSync|resolveBash|spawn error|syscall[^\r\n]{0,80}spawn)'){return 'dual_condition_runtime_bash_permission_denied'}
  if($text-match'(?i)(bypassPermissions|permission-mode)[^\r\n]{0,160}(root|administrator|not allowed|cannot)'){return 'dual_condition_runtime_permission_mode_rejected'}
  if($permissionDenied){return 'dual_condition_runtime_permission_denied'}
  $typedError = [regex]::Match($text, '(?mi)^(?:Error|TypeError|RangeError|ReferenceError):\s*([^\r\n]{1,160})$')
  if($typedError.Success){
    $safeError = ($typedError.Groups[1].Value.ToLowerInvariant() -replace '[^a-z0-9]+','_').Trim('_')
    if($safeError.Length -gt 96){$safeError=$safeError.Substring(0,96).TrimEnd('_')}
    if($safeError){return "dual_condition_runtime_error_$safeError"}
  }
  return 'dual_condition_runtime_nonzero_no_evidence'
}

function Get-E1SanitizedProcessDiagnosticLines($Result) {
  $lines = @((([string]$Result.stderr)+"`n"+([string]$Result.stdout)) -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  return @($lines | Select-Object -First 4 | ForEach-Object {
    $line = $_ -replace '(?i)[a-z]:\\[^\s]+', '<path>' -replace '(?i)file:///[^\s]+', '<path>'
    $safe = ($line.ToLowerInvariant() -replace '[^a-z0-9<>]+','_').Trim('_')
    if($safe.Length -gt 120){$safe=$safe.Substring(0,120).TrimEnd('_')}
    $safe
  })
}

function New-E1DualConditionCanaryRuntimeEnvironment([string]$RunsRoot = '') {
  $claudeConfigDir=[Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR','User')
  if([string]::IsNullOrWhiteSpace($claudeConfigDir)){$claudeConfigDir=$env:CLAUDE_CONFIG_DIR}
  if([string]::IsNullOrWhiteSpace($claudeConfigDir) -or
    -not [IO.Path]::GetFullPath($claudeConfigDir).TrimEnd('\').Equals('C:\Evidence1RuntimeState\claude',[StringComparison]::OrdinalIgnoreCase)){
    throw 'dual_condition_claude_config_dir'
  }
  $runtimePath=@(
    'C:\Windows\System32',(Join-Path $script:E1GitCommandRoot 'cmd'),(Join-Path $script:E1GitCommandRoot 'bin'),
    (Join-Path $script:E1GitBashRoot 'cmd'),(Join-Path $script:E1GitBashRoot 'bin'),(Split-Path -Parent $script:E1NodeCommand),
    (Join-Path $script:E1JdkRoot 'bin'),(Join-Path $script:E1AndroidRoot 'platform-tools'),
    (Split-Path -Parent $script:E1ClaudeCommand),(Split-Path -Parent $script:E1CodexCommand),$env:Path
  )|Where-Object{$_}
  $environment=@{
    Path=($runtimePath-join';');JAVA_HOME=$script:E1JdkRoot;ANDROID_HOME=$script:E1AndroidRoot;ANDROID_SDK_ROOT=$script:E1AndroidRoot;
    GRADLE_OPTS='-Dorg.gradle.configuration-cache=false';
    KMP_EVAL_BASH_PATH=$script:E1GitBashCommand;KMP_EVAL_CODEX_HOME=$script:E1CodexHome;KMP_EVAL_CODEX_RUNTIME_ROOT=$script:E1CodexRuntimeRoot;
    KMP_AGENTIC_EVAL_GRADLE_USER_HOME_SEED_DIR=$script:E1GradleUserHomeSeedDir;
    KMP_AGENTIC_EVAL_LIVE_SPAWN_PREFLIGHT='1';
    CLAUDE_CONFIG_DIR=$claudeConfigDir;
    CLAUDE_CODE_GIT_BASH_PATH=$script:E1GitBashCommand;CLAUDE_CODE_USE_POWERSHELL_TOOL='0';
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';DISABLE_TELEMETRY='1';DISABLE_ERROR_REPORTING='1';
    ENABLE_CLAUDEAI_MCP_SERVERS='false';CLAUDE_CODE_DISABLE_ARTIFACT='1'
  }
  if(-not [string]::IsNullOrWhiteSpace($RunsRoot)){$environment.KMP_EVAL_RUNS_ROOT=$RunsRoot}
  return $environment
}

if ($InternalLibrary) {
  Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1') -Force -DisableNameChecking
  Import-Module (Join-Path $PSScriptRoot 'evidence1-provider-runtime-contract.psm1') -Force -DisableNameChecking
  $script:E1InternalDualConditionContractModule = Import-Module `
    (Join-Path $PSScriptRoot 'evidence1-dual-condition-canary-contract.psm1') `
    -Force -DisableNameChecking -PassThru
  $script:E1InternalBoundedProcess =
    $script:E1InternalDualConditionContractModule.ExportedCommands['Invoke-E1BoundedProcess'].ScriptBlock
  if ($null -eq $script:E1InternalBoundedProcess) { throw 'agentic_eval_bounded_process_export_missing' }
  function ConvertTo-E1SessionNonNegativeInt($Value, [string]$ErrorCode) {
    if (($Value -isnot [byte]) -and ($Value -isnot [int16]) -and ($Value -isnot [int]) -and ($Value -isnot [int64])) { throw $ErrorCode }
    if ([int64]$Value -lt 0 -or [int64]$Value -gt [int]::MaxValue) { throw $ErrorCode }
    return [int]$Value
  }
  # Bash single quotes cannot contain a single quote: close the quote, escape the quote, reopen.
  function ConvertTo-E1BashSingleQuoted([string]$Value) { return "'" + $Value.Replace("'", "'\''") + "'" }
  # The `export` lines the fake provider needs for the multi-module-tests scenario of this campaign, as text
  # ending in a line feed, or '' for every other scenario (so their shims stay exactly what they always were).
  # The fake runs as the agent child, whose environment the harness filters, so a variable set by this launcher
  # would never reach it: the values go into the shim text itself. They come from the scenario file and its
  # ground-truth file under the harness directory's corpus; both are read here, never passed around.
  # Strict mode makes a missing property on parsed JSON a raw error; a missing one must read as absent instead.
  function Get-E1JsonProperty($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
  }
  function Get-E1FakeScenarioExportText($CurrentCampaignInputs) {
    $scenarioId = [string]$CurrentCampaignInputs.scenario_id
    $corpus = Join-Path ([string]$CurrentCampaignInputs.harness_dir) 'tools\agentic-eval\corpus'
    $scenarioPath = Join-Path $corpus (Join-Path 'scenarios' "$scenarioId.json")
    if (-not (Test-Path -LiteralPath $scenarioPath -PathType Leaf)) { return '' }
    try { $scenario = [IO.File]::ReadAllText($scenarioPath) | ConvertFrom-Json -ErrorAction Stop } catch { throw 'agentic_eval_fake_scenario_invalid' }
    if ([string](Get-E1JsonProperty $scenario 'family') -cne 'multi-module-tests') { return '' }
    $expectedPath = Join-Path $corpus (Join-Path 'expected' "$scenarioId.json")
    if (-not (Test-Path -LiteralPath $expectedPath -PathType Leaf)) { throw 'agentic_eval_fake_expected_missing' }
    try { $truth = [IO.File]::ReadAllText($expectedPath) | ConvertFrom-Json -ErrorAction Stop } catch { throw 'agentic_eval_fake_expected_invalid' }
    $answer = Get-E1JsonProperty $truth 'expected'
    $smoke = Get-E1JsonProperty $truth 'smoke'
    $kmpArgumentsRaw = Get-E1JsonProperty $smoke 'kmp_test_args'
    $kmpArguments = if ($null -eq $kmpArgumentsRaw) { @() } else { @($kmpArgumentsRaw) }
    $failingModules = Get-E1JsonProperty $answer 'failing_modules'
    $failedClasses = Get-E1JsonProperty $answer 'failed_test_classes'
    if ($null -eq $answer -or $null -eq $smoke -or $kmpArguments.Count -eq 0 -or $null -eq $failingModules -or $null -eq $failedClasses -or $null -eq (Get-E1JsonProperty $answer 'outcome_kind')) {
      throw 'agentic_eval_fake_expected_invalid'
    }
    try { $count = [int](Get-E1JsonProperty $answer 'failed_count') } catch { throw 'agentic_eval_fake_expected_invalid' }
    $json = { param($value) (ConvertTo-Json -InputObject ([string]$value) -Compress) }
    $modules = @($failingModules)
    $moduleJson = '[' + ((@($modules | ForEach-Object { & $json $_ })) -join ',') + ']'
    $classJson = '[' + ((@(@($failedClasses) | ForEach-Object { & $json $_ })) -join ',') + ']'
    $answerJson = '{"outcome_kind":' + (& $json $answer.outcome_kind) + ',"failing_modules":' + $moduleJson + ',"failed_test_classes":' + $classJson + ',"failed_count":' + $count + '}'
    $firstTestTask = @((Get-E1JsonProperty (Get-E1JsonProperty $scenario 'policy') 'allowed_gradle_tasks') | Where-Object { ([string]$_).Split(':')[-1] -cmatch '^test[A-Za-z]*$' } | Select-Object -First 1)
    if ($firstTestTask.Count -eq 0 -or $modules.Count -eq 0) { throw 'agentic_eval_fake_scenario_invalid' }
    $variables = [ordered]@{
      KMP_FAKE_SCENARIO_FAMILY = 'multi-module-tests'
      KMP_FAKE_SCENARIO_PROJECT_NAME = [string](Get-E1JsonProperty $scenario 'project_alias')
      KMP_FAKE_SCENARIO_INCLUDE_MARKER = ('include("' + [string]$modules[0] + '")')
      KMP_FAKE_SCENARIO_KMP_TEST_ARGS = (($kmpArguments | ForEach-Object { [string]$_ }) -join ' ')
      KMP_FAKE_SCENARIO_GRADLE_TASKS = [string]$firstTestTask[0]
      KMP_FAKE_SCENARIO_EXPECTED_JSON = $answerJson
    }
    $lines = foreach ($name in $variables.Keys) { 'export ' + $name + '=' + (ConvertTo-E1BashSingleQuoted ([string]$variables[$name])) }
    return (($lines -join "`n") + "`n")
  }
  # Inserts the export text right after the shebang line. LF only: bash reads a trailing CR as part of the name.
  function Add-E1FakeScenarioExports([string]$ShimText, [string]$ExportText) {
    if ([string]::IsNullOrEmpty($ExportText)) { return $ShimText }
    $lineEnd = $ShimText.IndexOf("`n")
    if ($lineEnd -lt 0 -or -not $ShimText.StartsWith('#!')) { throw 'agentic_eval_fake_runtime_fixture_shebang_missing' }
    return $ShimText.Substring(0, $lineEnd + 1) + $ExportText + $ShimText.Substring($lineEnd + 1)
  }
  function New-E1FakeAgenticEvalRuntimeShim($CurrentCampaignInputs, $Cell, [string]$RunsRoot) {
    $fixtureName = if ([string]$Cell.runtime_id -ceq 'claude-code') { 'fake-claude-campaign-success' } else { 'fake-codex-campaign-success' }
    $executable = if ([string]$Cell.runtime_id -ceq 'claude-code') { 'claude' } else { 'codex' }
    $fixturePath = Join-Path ([string]$CurrentCampaignInputs.harness_dir) (Join-Path 'tests\fixtures' (Join-Path $fixtureName $executable))
    if (-not (Test-Path -LiteralPath $fixturePath -PathType Leaf)) { throw 'agentic_eval_fake_runtime_fixture_missing' }
    $exportText = Get-E1FakeScenarioExportText $CurrentCampaignInputs
    $shimDir = Join-Path $RunsRoot 'provider-shim'
    New-Item -ItemType Directory -Path $shimDir -ErrorAction Stop | Out-Null
    $shimExecutable = Join-Path $shimDir $executable
    if ([string]$Cell.runtime_id -ceq 'claude-code') {
      $original = [IO.File]::ReadAllText($fixturePath)
      $normalized = $original.Replace('\"model\":\"claude-sonnet-5-fake-resolved\"', ('\"model\":\"' + [string]$Cell.model_id + '\"')).Replace('\"claude_code_version\":\"fake\"', '\"claude_code_version\":\"2.1.238\"')
      if ($normalized -ceq $original) { throw 'agentic_eval_fake_claude_fixture_normalization_failed' }
      [IO.File]::WriteAllText($shimExecutable, (Add-E1FakeScenarioExports $normalized $exportText), [Text.UTF8Encoding]::new($false))
      $wrapper ='@echo off' + [Environment]::NewLine + '"%CLAUDE_CODE_GIT_BASH_PATH%" --noprofile --norc "%~dp0claude" %*' + [Environment]::NewLine
      [IO.File]::WriteAllText((Join-Path $shimDir 'claude.cmd'), $wrapper, [Text.UTF8Encoding]::new($false))
    } elseif ([string]::IsNullOrEmpty($exportText)) {
      Copy-Item -LiteralPath $fixturePath -Destination $shimExecutable -ErrorAction Stop
    } else {
      [IO.File]::WriteAllText($shimExecutable, (Add-E1FakeScenarioExports ([IO.File]::ReadAllText($fixturePath)) $exportText), [Text.UTF8Encoding]::new($false))
    }
    return $shimDir
  }
  function Assert-E1AgenticEvalSelectedPlan($Process, $CurrentCampaignInputs, $Cell, [int]$CampaignCellIndex) {
    if ($Process.exit_code -ne 0 -or -not $Process.cleanup_ok) { throw 'agentic_eval_session_plan_preflight_failed' }
    try { $planResult = ([string]$Process.stdout | ConvertFrom-Json -ErrorAction Stop) } catch { throw 'agentic_eval_session_plan_preflight_invalid' }
    $expectedCondition = switch ([string]$Cell.condition) {
      'product' { 'current-skill'; break }
      'free' { 'no-skill'; break }
      default { throw 'agentic_eval_session_cell_condition_invalid' }
    }
    if ($planResult.dry_run -ne $true -or [int]$planResult.planned_sessions -ne 1 -or
        [string]$planResult.runtime_id -cne [string]$Cell.runtime_id -or
        [string]$planResult.model_id -cne [string]$Cell.model_id -or
        [string]$planResult.campaign_design_id -cne [string]$Cell.campaign_design_id -or
        @($planResult.plan).Count -ne 1 -or
        [int]$planResult.plan[0].order_index -ne $CampaignCellIndex -or
        [string]$planResult.plan[0].condition -cne $expectedCondition -or
        [string]$planResult.plan[0].execution_profile_id -cne [string]$CurrentCampaignInputs.execution_profile_id) {
      throw 'agentic_eval_session_plan_selection_invalid'
    }
  }
  function Set-E1AgenticEvalSourceOrigin($CurrentCampaignInputs, [scriptblock]$InvokeBoundedProcess, $RuntimeEnvironment) {
    $scenarioPath = Join-Path ([string]$CurrentCampaignInputs.harness_dir) (Join-Path 'tools\agentic-eval\corpus\scenarios' ("$([string]$CurrentCampaignInputs.scenario_id).json"))
    if (-not (Test-Path -LiteralPath $scenarioPath -PathType Leaf)) { throw 'agentic_eval_session_scenario_missing' }
    try { $scenario = Get-Content -LiteralPath $scenarioPath -Raw | ConvertFrom-Json -ErrorAction Stop } catch { throw 'agentic_eval_session_scenario_invalid' }
    $projectUrl = [string]$scenario.project_url
    if ($projectUrl -cnotmatch '^https://[^\s]+$') { throw 'agentic_eval_session_project_url_invalid' }
    $projectCommit = [string]$scenario.project_commit
    if ($projectCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'agentic_eval_session_project_commit_invalid' }
    $git = Join-Path $script:E1GitCommandRoot 'cmd\git.exe'
    $source = [string]$CurrentCampaignInputs.source_template_dir
    $set = & $InvokeBoundedProcess -FileName $git -Arguments @('-C',$source,'remote','set-url','origin',$projectUrl) -WorkingDirectory $source -EnvironmentVariables $RuntimeEnvironment -TimeoutSeconds 30
    if ($set.exit_code -ne 0 -or -not $set.cleanup_ok) { throw 'agentic_eval_session_source_origin_update_failed' }
    $get = & $InvokeBoundedProcess -FileName $git -Arguments @('-C',$source,'remote','get-url','origin') -WorkingDirectory $source -EnvironmentVariables $RuntimeEnvironment -TimeoutSeconds 30
    if ($get.exit_code -ne 0 -or -not $get.cleanup_ok -or ([string]$get.stdout).Trim() -cne $projectUrl) { throw 'agentic_eval_session_source_origin_update_failed' }
    # The dot-source clobbering bug meant every
    # guest bundle silently substituted a DIFFERENT source checkout (Evidence1's own) for months
    # -- this session path was traced and found safe (it always read
    # $CurrentCampaignInputs.source_template_dir, never a bare clobbered variable), but "safe
    # today" is not the same as "asserted." Fail-closed on the scenario's own pinned identity
    # instead of trusting that $source is what it's supposed to be. Tree comparison resolves the
    # expected tree from $projectCommit directly inside $source's own repo (no second,
    # externally-supplied expected value to keep in sync) -- catches content-level drift a bare
    # commit-SHA string match would miss (a corrupted or hand-edited checkout can still report the
    # right HEAD SHA).
    $headResult = & $InvokeBoundedProcess -FileName $git -Arguments @('-C',$source,'rev-parse','HEAD') -WorkingDirectory $source -EnvironmentVariables $RuntimeEnvironment -TimeoutSeconds 30
    if ($headResult.exit_code -ne 0 -or -not $headResult.cleanup_ok) { throw 'agentic_eval_session_source_identity_unreadable' }
    $observedCommit = ([string]$headResult.stdout).Trim()
    $observedTreeResult = & $InvokeBoundedProcess -FileName $git -Arguments @('-C',$source,'rev-parse','HEAD^{tree}') -WorkingDirectory $source -EnvironmentVariables $RuntimeEnvironment -TimeoutSeconds 30
    if ($observedTreeResult.exit_code -ne 0 -or -not $observedTreeResult.cleanup_ok) { throw 'agentic_eval_session_source_identity_unreadable' }
    $observedTree = ([string]$observedTreeResult.stdout).Trim()
    $expectedTreeResult = & $InvokeBoundedProcess -FileName $git -Arguments @('-C',$source,'rev-parse',"$projectCommit^{tree}") -WorkingDirectory $source -EnvironmentVariables $RuntimeEnvironment -TimeoutSeconds 30
    if ($expectedTreeResult.exit_code -ne 0 -or -not $expectedTreeResult.cleanup_ok) { throw 'agentic_eval_session_source_identity_unreadable' }
    $expectedTree = ([string]$expectedTreeResult.stdout).Trim()
    if ($observedCommit -cne $projectCommit -or $observedTree -cne $expectedTree) {
      throw "agentic_eval_session_source_identity_mismatch:commit=$observedCommit,tree=$observedTree,expected_commit=$projectCommit,expected_tree=$expectedTree"
    }
  }
  function Remove-E1AgenticEvalProductCliPathEntries([string]$PathValue) {
    $productExecutables = @('kmp-test','kmp-test.cmd','kmp-test.ps1','kmp-test-runner','kmp-test-runner.cmd','kmp-test-runner.ps1')
    return (@($PathValue -split ';' | Where-Object {
      $entry = $_
      -not @($productExecutables | Where-Object { Test-Path -LiteralPath (Join-Path $entry $_) -PathType Leaf }).Count
    }) -join ';')
  }
  function Invoke-E1DualConditionCanarySession {
    param([Parameter(Mandatory)]$CurrentCampaignInputs, [Parameter(Mandatory)]$Cell, [scriptblock]$InvokeBoundedProcess = $script:E1InternalBoundedProcess)
    $required = @('campaign_id','scenario_id','seed','execution_profile_id','harness_dir','source_template_dir','provider_timeout_seconds','worker_timeout_seconds','provider_mode')
    if (@($required | Where-Object { [string]::IsNullOrWhiteSpace([string]$CurrentCampaignInputs.$_) }).Count -ne 0) { throw 'agentic_eval_session_inputs_invalid' }
    $cellKeys = if ($Cell -is [Collections.IDictionary]) { @($Cell.Keys) } else { @($Cell.PSObject.Properties.Name) }
    foreach ($name in @('runtime_id','model_id','campaign_design_id','campaign_cell_index','round_index')) {
      if ($name -cnotin $cellKeys) { throw 'agentic_eval_session_cell_invalid' }
    }
    $roundIndex = ConvertTo-E1SessionNonNegativeInt $Cell.round_index 'agentic_eval_session_cell_invalid'
    $campaignCellIndex = ConvertTo-E1SessionNonNegativeInt $Cell.campaign_cell_index 'agentic_eval_session_cell_invalid'
    if ([string]$Cell.runtime_id -cnotin @('codex-cli','claude-code')) { throw 'agentic_eval_session_cell_invalid' }
    $runtime = @($CurrentCampaignInputs.runtimes | Where-Object { [string]$_.runtime_id -ceq [string]$Cell.runtime_id -and [string]$_.model_id -ceq [string]$Cell.model_id -and [string]$_.campaign_design_id -ceq [string]$Cell.campaign_design_id })
    if ($runtime.Count -ne 1 -or $roundIndex -ge @($runtime[0].campaign_cell_indices).Count) { throw 'agentic_eval_session_cell_not_manifest_enumerated' }
    $expectedCampaignCellIndex = ConvertTo-E1SessionNonNegativeInt (@($runtime[0].campaign_cell_indices)[$roundIndex]) 'agentic_eval_session_cell_not_manifest_enumerated'
    if ($expectedCampaignCellIndex -ne $campaignCellIndex) { throw 'agentic_eval_session_cell_not_manifest_enumerated' }
    $node = $script:E1NodeCommand
    $runsRoot = Join-Path ([string]$CurrentCampaignInputs.private_root) (Join-Path ([string]$CurrentCampaignInputs.campaign_id) ("$([string]$Cell.runtime_id)-$roundIndex"))
    if (Test-Path -LiteralPath $runsRoot) {
      return New-E1ProviderRuntimeSessionResult -RuntimeId ([string]$Cell.runtime_id) -ModelId ([string]$Cell.model_id) -RoundIndex ([int]$Cell.round_index) -SessionId ([guid]::NewGuid().ToString('N')) -StartedAtUtc ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) -CompletedAtUtc ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) -ExitCode 1 -Verdict 'FAIL' -ReasonCode 'indeterminate_prior_attempt' -OutputSummary ([ordered]@{ runs_root = $runsRoot })
    }
    $attestation = if ([string]$Cell.runtime_id -ceq 'claude-code') { [string]$CurrentCampaignInputs.claude_attestation_file } else { [string]$CurrentCampaignInputs.codex_attestation_file }
    $args = @('tools/agentic-eval/cli.mjs','run','--scenario',[string]$CurrentCampaignInputs.scenario_id,'--source-repo-dir',[string]$CurrentCampaignInputs.source_template_dir,'--seed',[string]$CurrentCampaignInputs.seed,'--runtime',[string]$Cell.runtime_id,'--model',[string]$Cell.model_id,'--campaign-design',[string]$Cell.campaign_design_id,'--campaign-cell-index',[string]$campaignCellIndex,'--isolation-attestation-file',$attestation,'--timeout-ms',([string]([int64]$CurrentCampaignInputs.provider_timeout_seconds * 1000)))
    if ($null -ne $runtime[0].max_budget_usd) { $args += @('--max-budget-usd',[string]$runtime[0].max_budget_usd) }
    $started = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    Clear-E1LegacyFinalCampaignEnvironment
    $runtimeEnvironment = New-E1DualConditionCanaryRuntimeEnvironment -RunsRoot $runsRoot
    if ([string]$Cell.condition -ceq 'free') {
      $runtimeEnvironment.Path = Remove-E1AgenticEvalProductCliPathEntries ([string]$runtimeEnvironment.Path)
    }
    Set-E1AgenticEvalSourceOrigin $CurrentCampaignInputs $InvokeBoundedProcess $runtimeEnvironment
    # CLI dry-run is a semantic preflight of the registered campaign plan. It
    # runs before the session directory exists, so a rejected selection cannot
    # create an indeterminate prior attempt. The actual session gets exactly
    # the same argv plus no --dry-run flag.
    $planProcess = & $InvokeBoundedProcess -FileName $node -Arguments (@($args) + '--dry-run') -WorkingDirectory ([string]$CurrentCampaignInputs.harness_dir) -EnvironmentVariables $runtimeEnvironment -TimeoutSeconds ([int]$CurrentCampaignInputs.worker_timeout_seconds)
    Assert-E1AgenticEvalSelectedPlan $planProcess $CurrentCampaignInputs $Cell $campaignCellIndex
    New-Item -ItemType Directory -Force -Path $runsRoot | Out-Null
    if ([string]$CurrentCampaignInputs.provider_mode -ceq 'fake') {
      $shimDir = New-E1FakeAgenticEvalRuntimeShim $CurrentCampaignInputs $Cell $runsRoot
      $runtimeEnvironment.Path = $shimDir + ';' + [string]$runtimeEnvironment.Path
    } elseif ([string]$CurrentCampaignInputs.provider_mode -cne 'live') {
      throw 'agentic_eval_session_provider_mode_invalid'
    }
    # 2026-09-28 incident (F2): this call (unlike the dry-run above, at :220,
    # which runs before runs_root exists at :222) can throw
    # dual_condition_process_cleanup_failed or dual_condition_process_timeout
    # (evidence1-dual-condition-canary-contract.psm1's own Invoke-E1BoundedProcess)
    # AFTER a real, possibly-successful CLI session already ran. Previously,
    # an uncaught exception here escaped the worker entirely: Receive-Job
    # re-threw on the host, evidence1-guest-bundle-hyperv.psm1's own
    # logon-candidate loop replayed onto a second guest logon, and this
    # file's own slot guard above (:203) correctly refused that replay as
    # indeterminate_prior_attempt -- but the FIRST, real attempt's own
    # result was gone by then, never recorded anywhere. Returning a proper
    # FAIL result here instead keeps this session's real identity: never
    # accepted (cleanup is unproven, the containment invariant is not
    # weakened for convenience), but recorded, with the real reason,
    # exactly once, no replay.
    try {
      $process = & $InvokeBoundedProcess -FileName $node -Arguments $args -WorkingDirectory ([string]$CurrentCampaignInputs.harness_dir) -EnvironmentVariables $runtimeEnvironment -TimeoutSeconds ([int]$CurrentCampaignInputs.worker_timeout_seconds)
    } catch {
      # M1: [string]$_.Exception.Message is not sanitized here the way the existing FAIL path's
      # own Get-E1SanitizedProcessFailureReason sanitizes $process.stderr/stdout -- a raw .NET
      # exception from Invoke-E1BoundedProcess (Start-Process/job-plumbing failures, not just
      # its own bare dual_condition_process_* throws) can carry a local path. Closed
      # vocabulary: only the known, bare reason codes this codebase's own
      # Invoke-E1BoundedProcess throws survive verbatim; anything else collapses to one
      # generic, path-free code.
      $rawFailureMessage = [string]$_.Exception.Message
      $sanitizedFailureReason = if ($rawFailureMessage -cmatch '^dual_condition_process_[a-z_]+$') { $rawFailureMessage } else { 'agentic_eval_session_process_unexpected_error' }
      New-E1ProviderRuntimeSessionResult -RuntimeId ([string]$Cell.runtime_id) -ModelId ([string]$Cell.model_id) -RoundIndex $roundIndex `
        -SessionId ([guid]::NewGuid().ToString('N')) -StartedAtUtc $started -CompletedAtUtc ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) `
        -ExitCode 1 -Verdict 'FAIL' -ReasonCode 'agentic_eval_session_process_failed' `
        -OutputSummary ([ordered]@{
          benchmark_status = 'transport-failed'
          rejection_id     = $null
          stdout_bytes      = $null
          stderr_bytes      = $null
          failure_reason     = $sanitizedFailureReason
          diagnostic_lines    = @()
          runs_root            = $runsRoot
        })
      return
    }
    $completed = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $ok = $false
    $benchmarkStatus = 'transport-failed'
    $rejectionId = $null
    if ($process.exit_code -eq 0 -and $process.cleanup_ok) {
      $records = @(Get-ChildItem -LiteralPath (Join-Path $runsRoot 'agentic-eval-scenario') -File -Filter '*.json' -ErrorAction SilentlyContinue)
      $sidecars = @(Get-ChildItem -LiteralPath (Join-Path $runsRoot 'agentic-eval-scenario\audit') -File -Filter '*.json' -ErrorAction SilentlyContinue)
      if ($records.Count -ne 1 -or $sidecars.Count -ne 1 -or $records[0].BaseName -cne $sidecars[0].BaseName -or
          (Test-Path -LiteralPath (Join-Path $runsRoot 'record.json')) -or (Test-Path -LiteralPath (Join-Path $runsRoot 'audit.json'))) {
        $ok = $false
      } else {
        Copy-Item -LiteralPath $records[0].FullName -Destination (Join-Path $runsRoot 'record.json') -ErrorAction Stop
        Copy-Item -LiteralPath $sidecars[0].FullName -Destination (Join-Path $runsRoot 'audit.json') -ErrorAction Stop
        $ok = $true
        $benchmarkStatus = 'accepted'
      }
    } elseif ($process.cleanup_ok) {
      $rejectionMatch = [regex]::Match((([string]$process.stderr) + "`n" + ([string]$process.stdout)), '(?i)\brejection_id\s+([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\b')
      if ($rejectionMatch.Success) {
        $candidateRejectionId = $rejectionMatch.Groups[1].Value.ToLowerInvariant()
        $rejectionPath = Join-Path (Join-Path $runsRoot 'agentic-eval-rejected') "$candidateRejectionId.json"
        if (Test-Path -LiteralPath $rejectionPath -PathType Leaf) {
          try { $rejection = Get-Content -LiteralPath $rejectionPath -Raw | ConvertFrom-Json -ErrorAction Stop } catch { $rejection = $null }
          if ($null -ne $rejection -and [string]$rejection.rejection_id -ceq $candidateRejectionId) {
            $rejectionId = $candidateRejectionId
            $benchmarkStatus = 'rejected'
            $ok = $true
          }
        }
      }
    }
    New-E1ProviderRuntimeSessionResult -RuntimeId ([string]$Cell.runtime_id) -ModelId ([string]$Cell.model_id) -RoundIndex $roundIndex -SessionId ([guid]::NewGuid().ToString('N')) -StartedAtUtc $started -CompletedAtUtc $completed -ExitCode ([int]$process.exit_code) -Verdict $(if($ok){'PASS'}else{'FAIL'}) -ReasonCode $(if($ok){$null}else{'agentic_eval_session_failed'}) -OutputSummary ([ordered]@{ benchmark_status = $benchmarkStatus; rejection_id = $rejectionId; stdout_bytes = ([string]$process.stdout).Length; stderr_bytes = ([string]$process.stderr).Length; failure_reason = $(if($ok){$null}else{Get-E1SanitizedProcessFailureReason $process}); diagnostic_lines = $(if($ok){@()}else{@(Get-E1SanitizedProcessDiagnosticLines $process)}) })
  }
  return
}
$ExpectedClaudeVersion = '2.1.238'
$ExpectedCodexVersion = '0.154.0'
$ExpectedCodexModel = 'gpt-5.6-terra'
$ToolchainRoot = $script:E1ToolchainRoot
$NodeCommand = $script:E1NodeCommand
$ClaudeCommand = $script:E1ClaudeCommand
$CodexCommand = $script:E1CodexCommand
$GitCommandRoot = $script:E1GitCommandRoot
$GitBashRoot = $script:E1GitBashRoot
$GitBashCommand = $script:E1GitBashCommand
$JdkRoot = $script:E1JdkRoot
$AndroidRoot = $script:E1AndroidRoot
$CodexRuntimeRoot = $script:E1CodexRuntimeRoot
$CodexHome = $script:E1CodexHome
$GradleUserHomeSeedDir = $script:E1GradleUserHomeSeedDir
if ($Mode -ceq 'Live') {
  throw 'dual_condition_legacy_live_entrypoint_disabled_use_evidence1_run'
}
# The dual-runtime campaign has its own immutable binding and authorization ledger.
# Never let a persisted legacy six-session Codex control plane hijack cli.mjs before
# this campaign reaches its own slot boundary.
Clear-E1LegacyFinalCampaignEnvironment
$contractPath = Join-Path $PSScriptRoot 'evidence1-dual-condition-canary-contract.psm1'
$handoffPath = Join-Path $PSScriptRoot 'evidence1-live-handoff-contract.psm1'
$validationOpsPath = Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1'
$validationForensicsPath = Join-Path $PSScriptRoot 'evidence1-validation-forensics.psm1'
$offlineCachePath = Join-Path $PSScriptRoot 'evidence1-gradle-offline-probe.psm1'
Import-Module $validationOpsPath -Force -DisableNameChecking
Import-Module $validationForensicsPath -Force -DisableNameChecking
Import-Module $offlineCachePath -Force -DisableNameChecking
Import-Module $contractPath -Force
Import-Module $handoffPath -Force

function Get-E1Hash([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'dual_condition_input_missing' }
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try{$sha=[Security.Cryptography.SHA256]::Create();try{return -join($sha.ComputeHash($stream)|ForEach-Object{$_.ToString('x2')})}finally{$sha.Dispose()}}finally{$stream.Dispose()}
}

function Write-E1SanitizedFailureReason($ErrorRecord) {
  $reason=[string]$ErrorRecord.Exception.Message
  if($reason-cnotmatch'^dual_condition_[a-z0-9_.:-]{1,112}$'){$reason='dual_condition_launcher_failed'}
  [Console]::Error.WriteLine($reason)
}

$script:E1LaunchStage='startup'
trap {
  $reason=[string]$_.Exception.Message
  if($reason-cnotmatch'^dual_condition_[a-z0-9_.:-]{1,112}$'){
    $failureId=([string]$_.FullyQualifiedErrorId).ToLowerInvariant()-replace'[^a-z0-9]+','_'
    $failureId=$failureId.Trim('_')
    if($failureId.Length-gt48){$failureId=$failureId.Substring(0,48).TrimEnd('_')}
    $reason="dual_condition_launcher_failed_$script:E1LaunchStage"
    if($failureId){$reason+="_$failureId"}
  }
  [Console]::Error.WriteLine($reason)
  exit 1
}

function Resolve-E1Directory([string]$Path, [string]$Code) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw $Code }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'dual_condition_reparse_point' }
  return $item.FullName
}

function Assert-E1PathInside([string]$Candidate, [string]$Root, [string]$Code) {
  $candidateFull = [IO.Path]::GetFullPath($Candidate)
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  if (-not $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) { throw $Code }
}

function Get-E1AttestationPath($Slot) {
  return $(if($Slot.runtime_id-ceq'claude-code'){$ClaudeAttestationFile}else{$CodexAttestationFile})
}

function Assert-E1AttestationPresent($Slot) {
  $path=Get-E1AttestationPath $Slot
  if(-not(Test-Path -LiteralPath $path -PathType Leaf)){throw 'dual_condition_attestation_missing'}
}

function Invoke-E1Git([string]$Root, [string[]]$Arguments) {
  $result = Invoke-E1BoundedProcess -FileName 'git.exe' -Arguments (@('-C',$Root) + $Arguments) `
    -WorkingDirectory $Root -TimeoutSeconds 120
  if ($result.exit_code -ne 0 -or -not $result.cleanup_ok) { throw 'dual_condition_git_failed' }
  return ([string]$result.stdout).Trim()
}

function Read-E1BoundContext {
  $bindingPath = Join-Path $OperationRoot 'binding.json'
  if (-not (Test-Path -LiteralPath $bindingPath -PathType Leaf)) { throw 'dual_condition_binding_missing' }
  $binding = Get-Content -LiteralPath $bindingPath -Raw | ConvertFrom-Json -ErrorAction Stop
  $null = Assert-Evidence1DualConditionCanaryBinding $binding
  $expectedRoot = Get-Evidence1DualConditionCanaryOperationRoot `
    ([IO.DirectoryInfo]::new([IO.Path]::GetFullPath($OperationRoot)).Parent.Parent.Parent.FullName) `
    $binding.pair_id $binding.group_run_id
  if ([IO.Path]::GetFullPath($expectedRoot) -cne [IO.Path]::GetFullPath($OperationRoot)) { throw 'dual_condition_noncanonical_operation_root' }
  return $binding
}

function Assert-E1FreshPrerequisites($Binding) {
    $readiness = Get-Content -LiteralPath $ReadinessPath -Raw | ConvertFrom-Json -ErrorAction Stop
  $readinessAt = [DateTime]::MinValue
  if (-not [DateTime]::TryParse([string]$readiness.generated_at_utc, [ref]$readinessAt)) { throw 'dual_condition_readiness_invalid' }
  $authPath = Join-Path 'C:\Evidence1Ops\remote-auth-canary-v2' "$RemoteAuthCanaryOperationId\final.json"
  if ($TestMode) { $authPath = Join-Path (Split-Path -Parent $ReadinessPath) 'remote-auth-final.json' }
  $auth = Get-Content -LiteralPath $authPath -Raw | ConvertFrom-Json -ErrorAction Stop
  if (-not $TestMode) {
    if (-not $auth.PSObject.Properties['context']) { throw 'dual_condition_vm_identity' }
    $boundVmName = [string]$auth.context.vm_name
    $boundVmId = ([string]$auth.context.vm_id).ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($boundVmName) -or
        $boundVmId -cnotmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$') { throw 'dual_condition_vm_identity' }
    $actualVmId = [string](Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters' -Name VirtualMachineId)
    if ($actualVmId.ToLowerInvariant() -cne $boundVmId) {
      throw 'dual_condition_vm_identity'
    }
    $null = Assert-Evidence1DualRemoteAuthCanary -Canary $auth `
      -ExpectedClaudeVersion $ExpectedClaudeVersion -ExpectedCodexVersion $ExpectedCodexVersion `
      -ExpectedVMName $boundVmName -ExpectedVMId $boundVmId -ExpectedCodexModel $ExpectedCodexModel `
      -NotBeforeUtc $readinessAt -MaxAgeMinutes $Binding.remote_auth_max_age_minutes
  } elseif ([string]$auth.status -cne 'passed') { throw 'dual_condition_remote_auth_invalid' }
}

function New-E1SourceClone($Binding, [int]$Ordinal, [string]$CloneRoot) {
  if (Test-Path -LiteralPath $CloneRoot) { throw 'dual_condition_clone_replay' }
  $parent = Split-Path -Parent $CloneRoot
  $null = New-Item -ItemType Directory -Path $parent -Force
  $scenarioId=[string]@($Binding.slots)[$Ordinal].scenario_id
  if($scenarioId-cnotmatch'^[a-z0-9][a-z0-9-]{0,63}$'){throw 'dual_condition_scenario_id'}
  $scenarioPath=Join-Path $HarnessDir "tools\agentic-eval\corpus\scenarios\$scenarioId.json"
  if(-not(Test-Path -LiteralPath $scenarioPath -PathType Leaf)){throw 'dual_condition_scenario_missing'}
  $scenario=Get-Content -LiteralPath $scenarioPath -Raw|ConvertFrom-Json -ErrorAction Stop
  $sourceOrigin=[string]$scenario.project_url
  if($sourceOrigin-cnotmatch'^https://[^\s]+$'){throw 'dual_condition_source_origin_missing'}
  $clone = Invoke-E1BoundedProcess -FileName 'git.exe' `
    -Arguments @('clone','--no-local','--no-hardlinks','--quiet',$SourceTemplateDir,$CloneRoot) `
    -WorkingDirectory $parent -TimeoutSeconds 300
  if ($clone.exit_code -ne 0 -or -not $clone.cleanup_ok) { throw 'dual_condition_clone_failed' }
  $null=Invoke-E1Git $CloneRoot @('remote','set-url','origin',$sourceOrigin)
  if((Invoke-E1Git $CloneRoot @('remote','get-url','origin'))-cne$sourceOrigin){throw 'dual_condition_source_origin_mismatch'}
  $null = Invoke-E1Git $CloneRoot @('checkout','--detach','--quiet',$Binding.source_commit)
  if ((Invoke-E1Git $CloneRoot @('rev-parse','HEAD')) -cne $Binding.source_commit -or
      (Invoke-E1Git $CloneRoot @('rev-parse','HEAD^{tree}')) -cne $Binding.source_tree -or
      (Invoke-E1Git $CloneRoot @('status','--porcelain=v1','--untracked-files=all')).Length -ne 0) {
    throw 'dual_condition_clone_identity'
  }
  return $CloneRoot
}

function Copy-E1SanitizedEvidence([string]$RunsRoot, [int]$Ordinal) {
  $slot = Join-Path (Join-Path $OperationRoot 'slots') ([string]$Ordinal)
  $source = Join-Path $RunsRoot 'agentic-eval-scenario'
  $audit = Join-Path $source 'audit'
  $records = @(Get-ChildItem -LiteralPath $source -File -Filter '*.json' -Force -ErrorAction Stop)
  $sidecars = @(Get-ChildItem -LiteralPath $audit -File -Filter '*.json' -Force -ErrorAction Stop)
  if ($records.Count -ne 1 -or $sidecars.Count -ne 1 -or $records[0].Name -cne $sidecars[0].Name) {
    throw 'dual_condition_evidence_layout'
  }
  $recordHash=Get-E1Hash $records[0].FullName;$sidecarHash=Get-E1Hash $sidecars[0].FullName
  $null=New-Evidence1DualConditionCanaryCopyTransaction $OperationRoot $Ordinal $records[0].BaseName $recordHash $sidecarHash
  $pairs=@(@($records[0].FullName,(Join-Path $slot $records[0].Name)), @($sidecars[0].FullName,(Join-Path (Join-Path $slot 'audit') $sidecars[0].Name)))
  for($copyIndex=0;$copyIndex-lt$pairs.Count;$copyIndex++){
    $pair=$pairs[$copyIndex]
    $bytes = [IO.File]::ReadAllBytes($pair[0])
    $stream = [IO.File]::Open($pair[1], [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if ((Get-E1Hash $pair[0]) -cne (Get-E1Hash $pair[1])) { throw 'dual_condition_evidence_copy_hash' }
    if($TestMode-and$copyIndex-eq0-and$env:E1_DUAL_TEST_CRASH_AFTER_RECORD_COPY-ceq'1'){Stop-Process -Id $PID -Force}
  }
}

function Close-E1DispatchWithoutEvidence([int]$Ordinal) {
  $slotRoot=Join-Path (Join-Path $OperationRoot 'slots') ([string]$Ordinal)
  $transaction=Join-Path $slotRoot 'copy.transaction.json'
  if(Test-Path -LiteralPath $transaction){$null=Invoke-Evidence1DualConditionCanaryCopyRecovery $OperationRoot $Ordinal}
  $records=@(Get-ChildItem -LiteralPath $slotRoot -File -Filter '*.json' -Force|
    Where-Object Name -NotIn @('claim.json','plan.claim.json','dispatch.started.json','copy.transaction.json','copy.recovery.json','terminal.json'))
  $sidecars=@(Get-ChildItem -LiteralPath (Join-Path $slotRoot 'audit') -File -Filter '*.json' -Force)
  if($records.Count-ne0-or$sidecars.Count-ne0){throw 'dual_condition_partial_evidence_safety_stop'}
  $null=New-Evidence1DualConditionCanaryIncompleteSlotTerminal $OperationRoot $Ordinal
  if($Ordinal-eq0){$null=New-Evidence1DualConditionInterSlotIntegrity $OperationRoot}
  return New-Evidence1DualConditionCanaryGroupCustody $OperationRoot
}

function Get-E1SlotArguments($Binding, [int]$Ordinal, [string]$CloneRoot) {
  $slot = @($Binding.slots)[$Ordinal]
  $attestation = if ($slot.runtime_id -ceq 'claude-code') { $ClaudeAttestationFile } else { $CodexAttestationFile }
  if (-not (Test-Path -LiteralPath $attestation -PathType Leaf)) { throw 'dual_condition_attestation_missing' }
  $args = @('tools/agentic-eval/cli.mjs','run','--scenario',$slot.scenario_id,'--source-repo-dir',$CloneRoot,
    '--seed',[string]$slot.seed,'--runtime',$slot.runtime_id,'--model',$slot.model_requested,
    '--campaign-design',$slot.campaign_design_id,'--isolation-attestation-file',$attestation)
  if ($slot.runtime_id -ceq 'claude-code') { $args += @('--max-budget-usd','2') }
  return $args
}

$OperationRoot = [IO.Path]::GetFullPath($OperationRoot)
Assert-E1PathInside $OperationRoot 'C:\Evidence1Ops\dual-condition-ledger' 'dual_condition_operation_root'
$HarnessDir = Resolve-E1Directory $HarnessDir 'dual_condition_harness_missing'
$SourceTemplateDir = Resolve-E1Directory $SourceTemplateDir 'dual_condition_source_missing'
foreach($tool in @($NodeCommand,$ClaudeCommand,$CodexCommand,$GitBashCommand,(Join-Path $JdkRoot 'bin\java.exe'))){
  if(-not(Test-Path -LiteralPath $tool -PathType Leaf)){throw 'dual_condition_toolchain_missing'}
}
foreach($directory in @($AndroidRoot,$CodexRuntimeRoot,$CodexHome)){
  if(-not(Test-Path -LiteralPath $directory -PathType Container)){throw 'dual_condition_toolchain_missing'}
}
if(-not(Test-Path -LiteralPath $GradleUserHomeSeedDir -PathType Container)){throw 'dual_condition_gradle_seed_missing'}
$runtimeEnvironment=New-E1DualConditionCanaryRuntimeEnvironment
$script:E1LaunchStage='binding'
$binding = Read-E1BoundContext
$validatorRoot=$(if($TestMode){$HarnessDir}else{Join-Path 'C:\Evidence1Ops\dual-condition-validator' 'current'})
foreach($requiredValidatorFile in @('package.json','docs\audits\evidence1-dual-condition-canary-contract.psm1','docs\audits\evidence1-dual-condition-canary-wrapper.ps1')){
  if(-not(Test-Path -LiteralPath (Join-Path $validatorRoot $requiredValidatorFile) -PathType Leaf)){throw 'dual_condition_validator_missing'}
}
$env:E1_DUAL_VALIDATOR_ROOT=$validatorRoot
foreach ($boundSlot in @($binding.slots)) {
  if ($boundSlot.runtime_id -ceq 'codex-cli' -and
      ($null -ne $boundSlot.session_budget_usd -or $boundSlot.session_budget_reason -cne 'runtime_does_not_support_session_budget')) {
    throw 'dual_condition_budget'
  }
  Assert-E1AttestationPresent $boundSlot
}
$script:E1LaunchStage='prerequisites'
Assert-E1FreshPrerequisites $binding

if ($Mode -ceq 'DryRun') {
  $dryRoot = Join-Path $PrivateRoot "dry-$($binding.group_run_id)"
  if (Test-Path -LiteralPath $dryRoot) { throw 'dual_condition_dryrun_replay' }
  $null = New-Item -ItemType Directory -Path $dryRoot -Force
  $plans = @()
  for ($ordinal=0; $ordinal -lt 2; $ordinal++) {
    $slot = @($binding.slots)[$ordinal]
    $clone = New-E1SourceClone $binding $ordinal (Join-Path $dryRoot "source-$ordinal")
    $args = @(Get-E1SlotArguments $binding $ordinal $clone) + '--dry-run'
    $dryEnvironment=$runtimeEnvironment.Clone();$dryEnvironment.KMP_EVAL_RUNS_ROOT=Join-Path $dryRoot "runs-$ordinal"
    $result = Invoke-E1BoundedProcess -FileName $NodeCommand -Arguments $args -WorkingDirectory $HarnessDir `
      -EnvironmentVariables $dryEnvironment -TimeoutSeconds 300
    if ($result.exit_code -ne 0 -or -not $result.cleanup_ok) { throw 'dual_condition_dryrun_failed' }
    $plan = $result.stdout | ConvertFrom-Json -ErrorAction Stop
    if (-not $plan.dry_run -or [int]$plan.planned_sessions -ne 1 -or $plan.runtime_id -cne $slot.runtime_id -or
      $plan.model_id -cne $slot.model_requested -or $plan.campaign_design_id -cne $slot.campaign_design_id) {
      throw 'dual_condition_dryrun_identity'
    }
    $plans += [ordered]@{ ordinal=$ordinal; runtime_id=$slot.runtime_id; campaign_design_id=$slot.campaign_design_id; planned_sessions=1 }
  }
  [ordered]@{ schema=1; state='passed'; mode='DryRun'; pair_id=$binding.pair_id; group_run_id=$binding.group_run_id;
    planned_sessions=2; runtime_order=@($binding.runtime_order); plans=$plans; inference_sessions_consumed=0 } | ConvertTo-Json -Depth 6
  exit 0
}

if ($Mode -ceq 'FakeRuntime' -and (-not $TestMode -or -not (Test-Path -LiteralPath $FakeRuntimeScript -PathType Leaf))) {
  throw 'dual_condition_fake_runtime_forbidden'
}

if($Mode -ceq 'Live'){
  # PowerShell Direct/startup-task sessions can inherit a system TEMP whose ACL
  # does not admit the runtime token. Keep the operation-private replacement near
  # the volume root as Gradle cache entries already consume most of MAX_PATH.
  $runtimeTempBase='C:\E1T'
  $null=New-Item -ItemType Directory -Path $runtimeTempBase -Force
  $runtimeTempRoot=Join-Path $runtimeTempBase $binding.group_run_id.Replace('-','')
  if(Test-Path -LiteralPath $runtimeTempRoot){throw 'dual_condition_runtime_temp_replay'}
  $null=New-Item -ItemType Directory -Path $runtimeTempRoot -Force
  # The donor user home contains machine-local daemon, transform and configuration-cache
  # state that is neither portable nor required for an offline dependency seed. Reuse the
  # project's canonical cache copier, which admits only modules-2 plus the pinned wrapper.
  # Keep the destination near the volume root: Gradle artifact paths are already deep and
  # Windows PowerShell 5.1 otherwise surfaces DirectoryNotFoundException at MAX_PATH.
  $compactGradleSeedRoot='C:\E1G'
  $null=New-Item -ItemType Directory -Path $compactGradleSeedRoot -Force
  $compactGradleSeed=Join-Path $compactGradleSeedRoot $binding.group_run_id.Replace('-','')
  if(Test-Path -LiteralPath $compactGradleSeed){throw 'dual_condition_gradle_seed_replay'}
  # 2026-09-29 (canary attempt 1 on 8869d9c2, Amendment A6): checked before the seed copy below,
  # the first of this session's own space-consuming steps -- same threshold and reason-code shape
  # as run-agentic-eval-product-smoke's own guard (evidence1-guest-bundle-contract.psm1).
  $guestFreeBytes=[int64](Get-PSDrive -Name 'C').Free
  if($guestFreeBytes -lt 32212254720){throw "guest_disk_space_insufficient:$guestFreeBytes"}
  $script:E1LaunchStage='gradle_seed_copy'
  try {
    $null=Copy-E1OfflineCache $GradleUserHomeSeedDir $compactGradleSeed
  } catch {
    $safeCacheReason=[string]$_.Exception.Message
    if($safeCacheReason-cmatch'^cache_[a-z0-9_]{1,96}$'){
      throw "dual_condition_gradle_seed_$safeCacheReason"
    }
    $failureLine=[int]$_.InvocationInfo.ScriptLineNumber
    $failureType=([string]$_.Exception.GetType().Name).ToLowerInvariant()-replace'[^a-z0-9]+','_'
    throw "dual_condition_gradle_seed_copy_line_${failureLine}_${failureType}"
  }
  $runtimeEnvironment.KMP_AGENTIC_EVAL_GRADLE_USER_HOME_SEED_DIR=$compactGradleSeed
  $runtimeEnvironment.TEMP=$runtimeTempRoot
  $runtimeEnvironment.TMP=$runtimeTempRoot
  $runtimeEnvironment.TMPDIR=$runtimeTempRoot
  $preflightRoot=Join-Path $PrivateRoot "preflight-$($binding.group_run_id)"
  if(Test-Path -LiteralPath $preflightRoot){throw 'dual_condition_live_preflight_replay'}
  $null=New-Item -ItemType Directory -Path $preflightRoot
  for($preflightOrdinal=0;$preflightOrdinal-lt2;$preflightOrdinal++){
    $script:E1LaunchStage="preflight_slot_$preflightOrdinal"
    $preflightClone=New-E1SourceClone $binding $preflightOrdinal (Join-Path $preflightRoot "source-$preflightOrdinal")
    $preflightRuns=Join-Path $preflightRoot "runs-$preflightOrdinal"
    $preflightEnvironment=$runtimeEnvironment.Clone();$preflightEnvironment.KMP_EVAL_RUNS_ROOT=$preflightRuns
    $preflightArguments=@(Get-E1SlotArguments $binding $preflightOrdinal $preflightClone)+'--dry-run'
    $preflight=Invoke-E1BoundedProcess -FileName $NodeCommand -Arguments $preflightArguments -WorkingDirectory $HarnessDir `
      -EnvironmentVariables $preflightEnvironment -TimeoutSeconds 300
    if(-not$preflight.cleanup_ok-or$preflight.exit_code-ne0){
      $preflightReason=Get-E1SanitizedProcessFailureReason $preflight
      [Console]::Error.WriteLine($preflightReason)
      throw $preflightReason
    }
    try{$preflightPlan=$preflight.stdout|ConvertFrom-Json -ErrorAction Stop}catch{throw 'dual_condition_live_preflight_output'}
    $preflightSlot=@($binding.slots)[$preflightOrdinal]
    if(-not$preflightPlan.dry_run-or[int]$preflightPlan.planned_sessions-ne1-or
      $preflightPlan.runtime_id-cne$preflightSlot.runtime_id-or$preflightPlan.model_id-cne$preflightSlot.model_requested-or
      $preflightPlan.campaign_design_id-cne$preflightSlot.campaign_design_id){throw 'dual_condition_live_preflight_identity'}
  }
  # The real harness launches both runtimes through Git Bash. Prove that exact
  # executable is runnable under the measured environment before any slot is
  # claimed; existence alone does not catch Windows ACL/Mark-of-the-Web faults.
  $script:E1LaunchStage='shell_preflight'
  $shellPreflight=Invoke-E1BoundedProcess -FileName $GitBashCommand -Arguments @('--noprofile','--norc','-c','exit 0') `
    -WorkingDirectory $HarnessDir -EnvironmentVariables $runtimeEnvironment -TimeoutSeconds 30
  if(-not$shellPreflight.cleanup_ok-or$shellPreflight.exit_code-ne0){
    $shellReason=Get-E1SanitizedProcessFailureReason $shellPreflight
    [Console]::Error.WriteLine($shellReason)
    throw $shellReason
  }
  $nestedProbeSource=@'
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const probeRoot = mkdtempSync(join(tmpdir(), 'e1-runtime-probe-'));
try { writeFileSync(join(probeRoot, 'write.probe'), 'ok'); }
finally { rmSync(probeRoot, { recursive: true, force: true }); }
const result = spawnSync(process.env.KMP_EVAL_BASH_PATH, ['--noprofile','--norc','-c','exit 0'], { stdio: 'ignore' });
if (result.error) process.exit(result.error.code === 'EACCES' ? 13 : 14);
process.exit(result.status === 0 ? 0 : 15);
'@
  $nestedProbeEncoded=[Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($nestedProbeSource))
  $script:E1LaunchStage='nested_shell_preflight'
  $nestedPreflight=Invoke-E1BoundedProcess -FileName $NodeCommand -Arguments @('-e',"eval(Buffer.from('$nestedProbeEncoded','base64').toString('utf8'))") `
    -WorkingDirectory $HarnessDir -EnvironmentVariables $runtimeEnvironment -TimeoutSeconds 30
  if(-not$nestedPreflight.cleanup_ok-or$nestedPreflight.exit_code-ne0){
    $nestedReason=$(if($nestedPreflight.exit_code-eq13){'dual_condition_runtime_bash_permission_denied'}else{'dual_condition_runtime_bash_unavailable'})
    [Console]::Error.WriteLine($nestedReason)
    throw $nestedReason
  }
}

$script:E1LaunchStage='recovery_scan'
for($recoveryOrdinal=0;$recoveryOrdinal-lt2;$recoveryOrdinal++){
  $recoverySlot=Join-Path (Join-Path $OperationRoot 'slots') ([string]$recoveryOrdinal)
  if((Test-Path -LiteralPath (Join-Path $recoverySlot 'dispatch.started.json'))-and-not(Test-Path -LiteralPath (Join-Path $recoverySlot 'terminal.json'))){
    if(Test-Path -LiteralPath (Join-Path $recoverySlot 'copy.transaction.json')){$null=Invoke-Evidence1DualConditionCanaryCopyRecovery $OperationRoot $recoveryOrdinal}
    $null=New-Evidence1DualConditionCanaryIncompleteSlotTerminal $OperationRoot $recoveryOrdinal
    if($recoveryOrdinal-eq0){$null=New-Evidence1DualConditionInterSlotIntegrity $OperationRoot}
    $recovered=New-Evidence1DualConditionCanaryGroupCustody $OperationRoot
    $null=Assert-Evidence1DualConditionCanaryPair -OperationRoot $OperationRoot
    $recovered.value|ConvertTo-Json -Depth 10
    exit 1
  }
}
$script:E1LaunchStage='pair_claim'
$null=New-Evidence1DualConditionCanaryPairArmClaim $OperationRoot
$null=Assert-Evidence1DualConditionCanaryPair -OperationRoot $OperationRoot

# The authorization claim may be staged offline by the host. If it is absent,
# only the exact binding-specific phrase can create it. The phrase is never written.
if (-not (Test-Path -LiteralPath (Join-Path $OperationRoot 'authorization.claim.json'))) {
  $null = New-Evidence1DualConditionCanaryAuthorizationClaim $OperationRoot $AuthorizationPhrase
}
$script:E1LaunchStage='group_claim'
$null = New-Evidence1DualConditionCanaryGroupClaim $OperationRoot
$privateOperation = Join-Path $PrivateRoot $binding.group_run_id
if (Test-Path -LiteralPath $privateOperation) { throw 'dual_condition_private_root_replay' }
$null = New-Item -ItemType Directory -Path $privateOperation -Force

for ($ordinal=0; $ordinal -lt 2; $ordinal++) {
  $script:E1LaunchStage="live_slot_$ordinal"
  $slot = @($binding.slots)[$ordinal]
  $clone = New-E1SourceClone $binding $ordinal (Join-Path $privateOperation "source-$ordinal")
  $runsRoot = Join-Path $privateOperation "runs-$ordinal"
  $null = New-Item -ItemType Directory -Path $runsRoot
  # These two immutable receipts are the immediate pre-spawn boundary.
  $null = New-Evidence1DualConditionCanarySlotClaim $OperationRoot $ordinal
  $null = New-Evidence1DualConditionCanaryPlanClaim $OperationRoot $ordinal
  $onStarted={
    $null=New-Evidence1DualConditionCanaryDispatchStarted $OperationRoot $ordinal
  }.GetNewClosure()
  $timedOut = $false; $cleanupOk = $false; $exitCode = $null
  try {
    if ($Mode -ceq 'FakeRuntime') {
      $process = Invoke-E1BoundedProcess -FileName 'powershell.exe' `
        -Arguments @('-NoProfile','-ExecutionPolicy','Bypass','-File',$FakeRuntimeScript,'-OperationRoot',$OperationRoot,
          '-BindingPath',(Join-Path $OperationRoot 'binding.json'),'-Ordinal',[string]$ordinal,'-RunsRoot',$runsRoot,'-SourceClone',$clone) `
        -WorkingDirectory $HarnessDir -TimeoutSeconds ([int]$slot.process_timeout_seconds) -OnStarted $onStarted
    } else {
      $slotEnvironment=$runtimeEnvironment.Clone();$slotEnvironment.KMP_EVAL_RUNS_ROOT=$runsRoot
      $process = Invoke-E1BoundedProcess -FileName $NodeCommand -Arguments (Get-E1SlotArguments $binding $ordinal $clone) `
        -WorkingDirectory $HarnessDir -EnvironmentVariables $slotEnvironment `
        -TimeoutSeconds ([int]$slot.process_timeout_seconds) -OnStarted $onStarted
    }
    $exitCode = [int]$process.exit_code; $cleanupOk = [bool]$process.cleanup_ok
    if($exitCode-ne0){[Console]::Error.WriteLine((Get-E1SanitizedProcessFailureReason $process))}
  } catch {
    if ($_.Exception.Message -ceq 'dual_condition_process_timeout') { $timedOut=$true; $cleanupOk=$true }
    elseif ($_.Exception.Message -ceq 'dual_condition_process_cleanup_failed') { $cleanupOk=$false }
    else {
      Write-E1SanitizedFailureReason $_
      $failed=Close-E1DispatchWithoutEvidence $ordinal
      $failed.value|ConvertTo-Json -Depth 10
      exit 1
    }
  }
  try{Copy-E1SanitizedEvidence $runsRoot $ordinal}catch{
    Write-E1SanitizedFailureReason $_
    $failed=Close-E1DispatchWithoutEvidence $ordinal
    $failed.value|ConvertTo-Json -Depth 10
    exit 1
  }
  $terminal = New-Evidence1DualConditionCanarySlotTerminal $OperationRoot $ordinal $exitCode $timedOut $cleanupOk 1
  if ($ordinal -eq 0) {
    $integrity = New-Evidence1DualConditionInterSlotIntegrity $OperationRoot
    if (-not $integrity.value.dispatch_next_slot) {
      $custody = New-Evidence1DualConditionCanaryGroupCustody $OperationRoot
      $custody.value | ConvertTo-Json -Depth 10
      exit 1
    }
  }
}
$final = New-Evidence1DualConditionCanaryGroupCustody $OperationRoot
$validated = Assert-Evidence1DualConditionCanaryOperation $OperationRoot
if (-not $final.value.complete -or -not $validated.validated -or $final.value.aggregated_across_runtimes -ne $false) { throw 'dual_condition_custody_incomplete' }
$final.value | ConvertTo-Json -Depth 10
exit $(if ($final.value.state -ceq 'closed_pass') { 0 } else { 1 })

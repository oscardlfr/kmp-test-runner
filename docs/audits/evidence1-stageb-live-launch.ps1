param(
  [string]$RunId = '',
  [string]$TerminalRecordPath = '',
  [string]$CanaryArm = '',
  [string]$CanaryBindingSha256 = '',
  [switch]$LoadOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$contractPath = Join-Path $PSScriptRoot 'evidence1-live-run-contract.psm1'
if ($RunId) {
  $parsedRunId = [guid]::Empty
  if (-not [guid]::TryParseExact($RunId, 'D', [ref]$parsedRunId)) {
    throw 'RunId must be a canonical D-format GUID'
  }
  if (-not $TerminalRecordPath) {
    throw 'TerminalRecordPath is required when RunId is supplied'
  }
  $terminalFullPath = [System.IO.Path]::GetFullPath($TerminalRecordPath)
  $opsRoot = ([System.IO.Path]::GetFullPath('C:\Evidence1Ops')).TrimEnd('\') + '\'
  if (-not $terminalFullPath.StartsWith($opsRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'TerminalRecordPath must stay inside C:\Evidence1Ops'
  }
  Import-Module $contractPath -Force
}

$HarnessCommit = ''
$HarnessTree = ''
$ClaudeVersion = '2.1.238'
$MaxBudgetUsd = '2.00'
$CampaignDesignId = 'claude-product-vs-free-baseline-v1'
$HarnessDir = 'C:\kmp-eval\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1'
$SourceDir = 'C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1'
$AttestationFile = 'C:\kmp-eval\measurement-scopes\evidence1-claude-windows-isolation-attestation-stageb-v1.json'
$ScratchDir = 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1'
$LogPath = Join-Path $ScratchDir 'STAGE-B-live.log'
$GradleUserHomeSeedDir = Join-Path $env:USERPROFILE '.gradle'
$ReadinessLedgerPath = Join-Path $ScratchDir 'READINESS.json'
$RemoteAuthCanaryPath = 'C:\Evidence1Ops\STAGE-B-auth-canary.json'
$RemoteAuthCanaryMaxAgeMinutes = 30

$ForbiddenCredentialOverrideNames = @(
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY'
)

function Fail($Message) {
  Write-Error "HARD STOP: $Message"
  exit 1
}

function Command-Source($Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Refresh-StageBPath {
  $npmPrefix = Join-Path $env:USERPROFILE 'AppData\Roaming\npm'
  $paths = @(
    'C:\Windows\System32',
    'C:\Program Files\Git\cmd',
    'C:\Program Files\Git\bin',
    $npmPrefix,
    'C:\Program Files\nodejs'
  )
  $jdkRoot = 'C:\Program Files\Eclipse Adoptium'
  if (Test-Path -LiteralPath $jdkRoot) {
    $jdk = Get-ChildItem -LiteralPath $jdkRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object Name -like 'jdk-21*' |
      Sort-Object Name -Descending |
      Select-Object -First 1
    if ($jdk) {
      $env:JAVA_HOME = $jdk.FullName
      $paths += (Join-Path $jdk.FullName 'bin')
    }
  }
  $env:Path = @($paths + $env:Path | Where-Object { $_ }) -join ';'
}

function Set-StageBClaudeNetworkEnvironment {
  $env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  $env:DISABLE_TELEMETRY = '1'
  $env:DISABLE_ERROR_REPORTING = '1'
  $env:ENABLE_CLAUDEAI_MCP_SERVERS = 'false'
  $env:CLAUDE_CODE_DISABLE_ARTIFACT = '1'
}

function Invoke-Git([string[]]$Args) {
  & git.exe @Args
  if ($LASTEXITCODE -ne 0) {
    Fail "git $($Args -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Invoke-CurlProbe([string]$Uri, [int]$MaxTimeSeconds) {
  $curl = Command-Source 'curl.exe'
  if (-not $curl) { Fail 'curl.exe not found' }
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $curl -IsS --max-time $MaxTimeSeconds $Uri 2>&1
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return [ordered]@{
    uri = $Uri
    exit_code = $LASTEXITCODE
    output_first_line = if ($output) { (@($output)[0] -as [string]) } else { '' }
  }
}

function Assert-RestrictedNetwork {
  $allowedUris = @(
    'https://api.anthropic.com',
    'https://platform.claude.com',
    'https://claude.ai',
    'https://claude.com'
  )
  foreach ($uri in $allowedUris) {
    $allowedProbe = Invoke-CurlProbe $uri 15
    if ($allowedProbe.exit_code -ne 0) {
      Fail "$uri is not reachable; live Claude Code sessions cannot run"
    }
  }

  $blockedHosts = @(
    'https://github.com',
    'https://registry.npmjs.org',
    'https://pypi.org',
    'https://www.wikipedia.org',
    'https://example.com',
    'https://cloudflare.com'
  )

  $unexpected = @()
  foreach ($uri in $blockedHosts) {
    $probe = Invoke-CurlProbe $uri 8
    if ($probe.exit_code -eq 0) {
      $unexpected += $uri
    }
  }

  if ($unexpected.Count -gt 0) {
    Fail "restricted network is not enforced; unexpected outbound access: $($unexpected -join ', ')"
  }
}

function Assert-ClaudeAuthReady([string]$ClaudeCommand) {
  & $ClaudeCommand auth status *> $null
  if ($LASTEXITCODE -ne 0) {
    Fail "claude auth status failed with exit code $LASTEXITCODE"
  }

  return [ordered]@{
    ok = $true
    check_kind = 'local_credential_presence_only'
    logged_in = $true
    remote_credential_validated = $false
  }
}

function Assert-CredentialEnvironmentPosture {
  $forbiddenNames = @(
    Get-ChildItem Env: |
      Where-Object {
        $_.Name -in $ForbiddenCredentialOverrideNames -or
        $_.Name -match 'OPENAI_API_KEY|GOOGLE_API_KEY|AZURE_OPENAI_API_KEY|GH_TOKEN|GITHUB_TOKEN|COPILOT_'
      } |
      Select-Object -ExpandProperty Name |
      Sort-Object -Unique
  )
  if ($forbiddenNames.Count -gt 0) {
    Fail "forbidden credential override environment variables present: $($forbiddenNames -join ', ')"
  }
  return [ordered]@{
    ok = $true
    forbidden_credential_override_names = @()
  }
}

function Assert-RemoteAuthCanary([string]$ExpectedClaudeVersion) {
  if (-not (Test-Path -LiteralPath $RemoteAuthCanaryPath -PathType Leaf)) {
    Fail 'remote auth canary record is missing; run the separately authorized auth canary before live Evidence1'
  }
  try {
    $canary = Get-Content -LiteralPath $RemoteAuthCanaryPath -Raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    Fail 'remote auth canary record is not valid JSON'
  }

  foreach ($field in @(
      'schema', 'state', 'completed_at_utc', 'claude_version', 'local_auth_status_exit_code',
      'process_exit_code', 'http_statuses', 'terminal', 'credential_override_names', 'privacy'
    )) {
    if (-not ($canary.PSObject.Properties.Name -contains $field)) {
      Fail "remote auth canary record is missing required property: $field"
    }
  }
  if ($canary.schema -ne 1 -or $canary.state -ne 'passed') {
    Fail 'remote auth canary did not pass'
  }
  if ($canary.claude_version -notmatch [regex]::Escape($ExpectedClaudeVersion)) {
    Fail "remote auth canary Claude version mismatch: $($canary.claude_version)"
  }
  if ($canary.local_auth_status_exit_code -ne 0 -or $canary.process_exit_code -ne 0) {
    Fail 'remote auth canary did not complete with successful local and process exit codes'
  }
  if (@($canary.credential_override_names).Count -ne 0) {
    Fail 'remote auth canary observed credential override environment variables'
  }
  if ($canary.privacy.raw_content_persisted -ne $false -or
      $canary.privacy.raw_content_printed -ne $false -or
      $canary.privacy.raw_content_read_in_memory_for_sanitization -ne $true) {
    Fail 'remote auth canary privacy contract drifted'
  }
  if ($canary.terminal.present -ne $true -or $canary.terminal.is_error -ne $false) {
    Fail 'remote auth canary did not produce a successful terminal result'
  }
  if (@($canary.http_statuses | Where-Object { $_ -eq 401 }).Count -gt 0) {
    Fail 'remote auth canary observed HTTP 401'
  }
  try {
    $completedAt = [DateTime]::Parse([string]$canary.completed_at_utc).ToUniversalTime()
  } catch {
    Fail 'remote auth canary completion timestamp is invalid'
  }
  $ageMinutes = ([DateTime]::UtcNow - $completedAt).TotalMinutes
  if ($ageMinutes -lt 0 -or $ageMinutes -gt $RemoteAuthCanaryMaxAgeMinutes) {
    Fail "remote auth canary is not fresh enough: age_minutes=$([Math]::Round($ageMinutes, 2)), max=$RemoteAuthCanaryMaxAgeMinutes"
  }
  return [ordered]@{
    ok = $true
    check_kind = 'remote_inference_auth_canary'
    completed_at_utc = $completedAt.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    age_minutes = [Math]::Round($ageMinutes, 2)
    http_statuses = @($canary.http_statuses)
  }
}

function Require-JsonProperty($Object, [string]$Name, [string]$Label) {
  if ($null -eq $Object -or -not ($Object.PSObject.Properties.Name -contains $Name)) {
    Fail "$Label missing required property: $Name"
  }
  return $Object.$Name
}

function Read-HarnessAnchorFields($Object, [string]$Label) {
  if ($Object.PSObject.Properties.Name -contains 'harness_commit_actual') {
    return [ordered]@{
      commit_actual = Require-JsonProperty $Object 'harness_commit_actual' $Label
      commit_expected = Require-JsonProperty $Object 'harness_commit_expected' $Label
      tree_actual = Require-JsonProperty $Object 'harness_tree_actual' $Label
      tree_expected = Require-JsonProperty $Object 'harness_tree_expected' $Label
    }
  }
  if ($Object.PSObject.Properties.Name -contains 'actual_commit') {
    return [ordered]@{
      commit_actual = Require-JsonProperty $Object 'actual_commit' $Label
      commit_expected = Require-JsonProperty $Object 'expected_commit' $Label
      tree_actual = Require-JsonProperty $Object 'actual_tree' $Label
      tree_expected = Require-JsonProperty $Object 'expected_tree' $Label
    }
  }
  if ($Object.PSObject.Properties.Name -contains 'harness_sha') {
    $commit = Require-JsonProperty $Object 'harness_sha' $Label
    $tree = Require-JsonProperty $Object 'harness_tree' $Label
    return [ordered]@{
      commit_actual = $commit
      commit_expected = $commit
      tree_actual = $tree
      tree_expected = $tree
    }
  }
  if ($Object.PSObject.Properties.Name -contains 'harness_commit') {
    $commit = Require-JsonProperty $Object 'harness_commit' $Label
    $tree = Require-JsonProperty $Object 'harness_tree' $Label
    return [ordered]@{
      commit_actual = $commit
      commit_expected = $commit
      tree_actual = $tree
      tree_expected = $tree
    }
  }
  $commit = Require-JsonProperty $Object 'commit' $Label
  $tree = Require-JsonProperty $Object 'tree' $Label
  return [ordered]@{
    commit_actual = $commit
    commit_expected = $commit
    tree_actual = $tree
    tree_expected = $tree
  }
}

function Assert-SequenceEquals($Actual, [string[]]$Expected, [string]$Label) {
  $actualArray = @($Actual | ForEach-Object { [string]$_ })
  if ($actualArray.Count -ne $Expected.Count) {
    Fail "${Label} length drifted: actual=$($actualArray.Count), expected=$($Expected.Count)"
  }
  for ($index = 0; $index -lt $Expected.Count; $index++) {
    if ($actualArray[$index] -ne $Expected[$index]) {
      Fail "${Label} drifted at index ${index}: actual=$($actualArray[$index]), expected=$($Expected[$index])"
    }
  }
}

function Read-ReadinessLedger {
  if (-not (Test-Path -LiteralPath $ReadinessLedgerPath)) {
    Fail "readiness ledger missing: $ReadinessLedgerPath"
  }

  try {
    $ledger = Get-Content -LiteralPath $ReadinessLedgerPath -Raw | ConvertFrom-Json
  } catch {
    Fail 'readiness ledger is not valid JSON'
  }

  $verdict = Require-JsonProperty $ledger 'verdict' 'readiness ledger'
  if ($verdict -ne 'PASS') {
    Fail "readiness ledger verdict is not PASS: $verdict"
  }

  if ($ledger.PSObject.Properties.Name -contains 'anchors') {
    $anchors = Require-JsonProperty $ledger 'anchors' 'readiness ledger'
    $fields = Read-HarnessAnchorFields $anchors 'readiness anchors'
  } elseif ($ledger.PSObject.Properties.Name -contains 'r2_harness') {
    $anchors = Require-JsonProperty $ledger 'r2_harness' 'readiness ledger'
    $fields = Read-HarnessAnchorFields $anchors 'readiness r2_harness'
  } elseif ($ledger.PSObject.Properties.Name -contains 'harness') {
    $anchors = Require-JsonProperty $ledger 'harness' 'readiness ledger'
    $fields = Read-HarnessAnchorFields $anchors 'readiness harness'
  } else {
    $anchors = Require-JsonProperty $ledger 'harness_anchor' 'readiness ledger'
    $fields = Read-HarnessAnchorFields $anchors 'readiness harness_anchor'
  }
  $ledgerCommitActual = $fields.commit_actual
  $ledgerCommitExpected = $fields.commit_expected
  $ledgerTreeActual = $fields.tree_actual
  $ledgerTreeExpected = $fields.tree_expected
  if ($ledgerCommitActual -ne $HarnessCommit -or $ledgerCommitExpected -ne $HarnessCommit) {
    Fail "readiness ledger harness commit drift: actual=$ledgerCommitActual expected=$ledgerCommitExpected"
  }
  if ($ledgerTreeActual -ne $HarnessTree -or $ledgerTreeExpected -ne $HarnessTree) {
    Fail "readiness ledger harness tree drift: actual=$ledgerTreeActual expected=$ledgerTreeExpected"
  }

  $attestationShaFromLedger = if ($ledger.PSObject.Properties.Name -contains 'attestation') {
    $attestation = Require-JsonProperty $ledger 'attestation' 'readiness ledger'
    if ($attestation.PSObject.Properties.Name -contains 'canonical_json_sha256') {
      [string]$attestation.canonical_json_sha256
    } elseif ($attestation.PSObject.Properties.Name -contains 'sha256') {
      [string]$attestation.sha256
    } else {
      ''
    }
  } else {
    ''
  }

  if ($ledger.PSObject.Properties.Name -contains 'dry_run_campaign_pass') {
    $campaign = Require-JsonProperty $ledger 'dry_run_campaign_pass' 'readiness ledger'
  } elseif ($ledger.PSObject.Properties.Name -contains 'R7_campaign_dry_run') {
    $r7 = Require-JsonProperty $ledger 'R7_campaign_dry_run' 'readiness ledger'
    $campaign = Require-JsonProperty $r7 'pass_dry_run' 'readiness campaign_dry_run'
  } elseif ($ledger.PSObject.Properties.Name -contains 'campaign_dry_run') {
    $r7 = Require-JsonProperty $ledger 'campaign_dry_run' 'readiness ledger'
    $campaign = Require-JsonProperty $r7 'pass_dry_run' 'readiness campaign_dry_run'
  } elseif ($ledger.PSObject.Properties.Name -contains 'dry_run_campaign') {
    $r7 = Require-JsonProperty $ledger 'dry_run_campaign' 'readiness ledger'
    $campaign = Require-JsonProperty $r7 'pass_dry_run' 'readiness campaign_dry_run'
  } elseif ($ledger.PSObject.Properties.Name -contains 'dry_runs') {
    $dryRuns = Require-JsonProperty $ledger 'dry_runs' 'readiness ledger'
    if ($dryRuns.PSObject.Properties.Name -contains 'campaign_pass') {
      $campaign = Require-JsonProperty $dryRuns 'campaign_pass' 'readiness dry_runs'
    } elseif ($dryRuns.PSObject.Properties.Name -contains 'campaign') {
      $campaign = Require-JsonProperty $dryRuns 'campaign' 'readiness dry_runs'
    } elseif ($dryRuns.PSObject.Properties.Name -contains 'pass_dry_run') {
      $campaign = Require-JsonProperty $dryRuns 'pass_dry_run' 'readiness dry_runs'
    } else {
      Fail 'readiness dry_runs missing campaign pass dry-run object'
    }
  } else {
    $r7 = Require-JsonProperty $ledger 'r7_campaign_dry_run' 'readiness ledger'
    $campaign = Require-JsonProperty $r7 'pass_dry_run' 'readiness campaign_dry_run'
  }
  foreach ($required in @(
    'planned_sessions',
    'plan_length',
    'strict_cell_count',
    'unrestricted_cell_count'
  )) {
    [void](Require-JsonProperty $campaign $required 'readiness campaign dry-run')
  }

  $campaignOutputSha = if ($campaign.PSObject.Properties.Name -contains 'output_sha256_lf_normalized') {
    $campaign.output_sha256_lf_normalized
  } elseif ($campaign.PSObject.Properties.Name -contains 'stdout_sha256') {
    $campaign.stdout_sha256
  } else {
    Fail 'readiness campaign dry-run missing stdout/output sha256'
  }
  $strictCellsWithAttestationHash = if ($campaign.PSObject.Properties.Name -contains 'strict_cells_with_attestation_hash') {
    [int]$campaign.strict_cells_with_attestation_hash
  } elseif ($campaign.PSObject.Properties.Name -contains 'strict_cells_carry_attestation_hash') {
    if ($campaign.strict_cells_carry_attestation_hash -eq $true) { 8 } else { 0 }
  } elseif ($campaign.PSObject.Properties.Name -contains 'strict_cells_carry_no_attestation_hash') {
    if ($campaign.strict_cells_carry_no_attestation_hash -eq $true) { 0 } else { 8 }
  } elseif ([int]$campaign.strict_cell_count -eq 0) {
    0
  } else {
    Fail 'readiness campaign dry-run missing strict attestation placement field'
  }
  $unrestrictedCellsWithAttestationHash = if ($campaign.PSObject.Properties.Name -contains 'unrestricted_cells_with_attestation_hash') {
    [int]$campaign.unrestricted_cells_with_attestation_hash
  } elseif ($campaign.PSObject.Properties.Name -contains 'unrestricted_distinct_attestation_hash_count') {
    if ([int]$campaign.unrestricted_distinct_attestation_hash_count -eq 1) { 8 } else { 0 }
  } elseif ($campaign.PSObject.Properties.Name -contains 'unrestricted_unique_attestation_hash_count') {
    if ([int]$campaign.unrestricted_unique_attestation_hash_count -eq 1) { [int]$campaign.unrestricted_cell_count } else { 0 }
  } elseif ($campaign.PSObject.Properties.Name -contains 'shared_attestation_hash_across_all_cells') {
    if ($campaign.shared_attestation_hash_across_all_cells -eq $true) { [int]$campaign.unrestricted_cell_count } else { 0 }
  } elseif ($campaign.PSObject.Properties.Name -contains 'unique_isolation_attestation_hash_count') {
    if ([int]$campaign.unique_isolation_attestation_hash_count -eq 1) { [int]$campaign.unrestricted_cell_count } else { 0 }
  } elseif ($campaign.PSObject.Properties.Name -contains 'distinct_isolation_attestation_hash_count') {
    if ([int]$campaign.distinct_isolation_attestation_hash_count -eq 1) { [int]$campaign.unrestricted_cell_count } else { 0 }
  } elseif ($campaign.PSObject.Properties.Name -contains 'distinct_isolation_attestation_hashes_on_unrestricted_cells') {
    if ([int]$campaign.distinct_isolation_attestation_hashes_on_unrestricted_cells -eq 1) { [int]$campaign.unrestricted_cell_count } else { 0 }
  } else {
    Fail 'readiness campaign dry-run missing unrestricted attestation placement field'
  }
  $distinctAttestationHashesAmongUnrestricted = if ($campaign.PSObject.Properties.Name -contains 'distinct_attestation_hashes_among_unrestricted') {
    [int]$campaign.distinct_attestation_hashes_among_unrestricted
  } elseif ($campaign.PSObject.Properties.Name -contains 'unrestricted_distinct_attestation_hash_count') {
    [int]$campaign.unrestricted_distinct_attestation_hash_count
  } elseif ($campaign.PSObject.Properties.Name -contains 'unrestricted_unique_attestation_hash_count') {
    [int]$campaign.unrestricted_unique_attestation_hash_count
  } elseif ($campaign.PSObject.Properties.Name -contains 'shared_attestation_hash_across_all_cells') {
    if ($campaign.shared_attestation_hash_across_all_cells -eq $true) { 1 } else { 0 }
  } elseif ($campaign.PSObject.Properties.Name -contains 'unique_isolation_attestation_hash_count') {
    [int]$campaign.unique_isolation_attestation_hash_count
  } elseif ($campaign.PSObject.Properties.Name -contains 'distinct_isolation_attestation_hash_count') {
    [int]$campaign.distinct_isolation_attestation_hash_count
  } elseif ($campaign.PSObject.Properties.Name -contains 'distinct_isolation_attestation_hashes_on_unrestricted_cells') {
    [int]$campaign.distinct_isolation_attestation_hashes_on_unrestricted_cells
  } else {
    Fail 'readiness campaign dry-run missing unrestricted attestation hash cardinality field'
  }
  $attestationPathLeaked = if ($campaign.PSObject.Properties.Name -contains 'attestation_path_leaked_in_output') {
    $campaign.attestation_path_leaked_in_output
  } elseif ($campaign.PSObject.Properties.Name -contains 'attestation_path_leaked') {
    $campaign.attestation_path_leaked
  } elseif ($campaign.PSObject.Properties.Name -contains 'attestation_path_or_content_or_timestamps_leaked') {
    $campaign.attestation_path_or_content_or_timestamps_leaked
  } elseif ($campaign.PSObject.Properties.Name -contains 'attestation_path_content_or_timestamps_leaked') {
    $campaign.attestation_path_content_or_timestamps_leaked
  } elseif ($campaign.PSObject.Properties.Name -contains 'attestation_path_absent_from_output') {
    -not $campaign.attestation_path_absent_from_output
  } else {
    Fail 'readiness campaign dry-run missing attestation path leak field'
  }
  $attestationContentLeaked = if ($campaign.PSObject.Properties.Name -contains 'attestation_content_leaked_in_output') {
    $campaign.attestation_content_leaked_in_output
  } elseif ($campaign.PSObject.Properties.Name -contains 'attestation_content_leaked') {
    $campaign.attestation_content_leaked
  } elseif ($campaign.PSObject.Properties.Name -contains 'attestation_filename_leaked_in_output') {
    $campaign.attestation_filename_leaked_in_output -or $campaign.attestation_campaign_id_leaked_in_output -or $campaign.attestation_boundary_kind_leaked_in_output
  } elseif ($campaign.PSObject.Properties.Name -contains 'attestation_path_or_content_or_timestamps_leaked') {
    $campaign.attestation_path_or_content_or_timestamps_leaked
  } elseif ($campaign.PSObject.Properties.Name -contains 'attestation_path_content_or_timestamps_leaked') {
    $campaign.attestation_path_content_or_timestamps_leaked
  } elseif ($campaign.PSObject.Properties.Name -contains 'attestation_content_absent_from_output') {
    -not $campaign.attestation_content_absent_from_output
  } else {
    Fail 'readiness campaign dry-run missing attestation content leak field'
  }
  $attestationTimestampsLeaked = if ($campaign.PSObject.Properties.Name -contains 'attestation_timestamps_leaked_in_output') {
    $campaign.attestation_timestamps_leaked_in_output
  } elseif ($campaign.PSObject.Properties.Name -contains 'attestation_timestamps_leaked') {
    $campaign.attestation_timestamps_leaked
  } elseif ($campaign.PSObject.Properties.Name -contains 'attestation_path_or_content_or_timestamps_leaked') {
    $campaign.attestation_path_or_content_or_timestamps_leaked
  } elseif ($campaign.PSObject.Properties.Name -contains 'attestation_path_content_or_timestamps_leaked') {
    $campaign.attestation_path_content_or_timestamps_leaked
  } elseif ($campaign.PSObject.Properties.Name -contains 'attestation_timestamps_absent_from_output') {
    -not $campaign.attestation_timestamps_absent_from_output
  } else {
    Fail 'readiness campaign dry-run missing attestation timestamp leak field'
  }
  $attestationHashMatchesFresh = if ($campaign.PSObject.Properties.Name -contains 'attestation_hash_matches_fresh_attestation') {
    $campaign.attestation_hash_matches_fresh_attestation
  } elseif ($campaign.PSObject.Properties.Name -contains 'unrestricted_attestation_hash_matches_file') {
    $campaign.unrestricted_attestation_hash_matches_file
  } elseif ($campaign.PSObject.Properties.Name -contains 'unrestricted_hash_matches_r5_validation') {
    $campaign.unrestricted_hash_matches_r5_validation
  } elseif ($campaign.PSObject.Properties.Name -contains 'isolation_attestation_hash_matches_r5') {
    $campaign.isolation_attestation_hash_matches_r5
  } elseif ($campaign.PSObject.Properties.Name -contains 'attestation_hash_matches_r5') {
    $campaign.attestation_hash_matches_r5
  } elseif ($campaign.PSObject.Properties.Name -contains 'attestation_hash_matches_loader') {
    $campaign.attestation_hash_matches_loader
  } elseif ($campaign.PSObject.Properties.Name -contains 'unrestricted_attestation_hash_matches_loader') {
    $campaign.unrestricted_attestation_hash_matches_loader
  } elseif ($campaign.PSObject.Properties.Name -contains 'shared_isolation_attestation_sha256') {
    [string]$campaign.shared_isolation_attestation_sha256 -match '^[0-9a-f]{64}$'
  } elseif ($campaign.PSObject.Properties.Name -contains 'bound_isolation_attestation_sha256') {
    [string]$campaign.bound_isolation_attestation_sha256 -match '^[0-9a-f]{64}$' -and
      ($attestationShaFromLedger -eq '' -or [string]$campaign.bound_isolation_attestation_sha256 -eq $attestationShaFromLedger)
  } else {
    Fail 'readiness campaign dry-run missing attestation hash match field'
  }

  if ($campaign.PSObject.Properties.Name -contains 'campaign_design_id' -and
      $campaign.campaign_design_id -ne $CampaignDesignId) {
    Fail "readiness campaign dry-run design drifted: $($campaign.campaign_design_id)"
  }
  if ([int]$campaign.planned_sessions -ne 8 -or [int]$campaign.plan_length -ne 8) {
    Fail "readiness campaign dry-run is not the 8-cell product/free-baseline design: planned=$($campaign.planned_sessions), plan=$($campaign.plan_length)"
  }
  if ($campaign.PSObject.Properties.Name -contains 'label_order_matches_expected') {
    foreach ($booleanGate in @(
      'label_order_matches_expected',
      'profile_order_matches_expected',
      'condition_order_matches_expected'
    )) {
      if ($campaign.$booleanGate -ne $true) {
        Fail "readiness campaign dry-run gate failed: $booleanGate"
      }
    }
  } else {
    Assert-SequenceEquals (Require-JsonProperty $campaign 'label_order' 'readiness campaign dry-run') @(
      'A', 'B', 'B', 'A', 'B', 'A', 'A', 'B'
    ) 'readiness campaign label order'
    Assert-SequenceEquals (Require-JsonProperty $campaign 'profile_order' 'readiness campaign dry-run') @(
      'sandboxed-unrestricted-v1', 'sandboxed-unrestricted-v1',
      'sandboxed-unrestricted-v1', 'sandboxed-unrestricted-v1',
      'sandboxed-unrestricted-v1', 'sandboxed-unrestricted-v1',
      'sandboxed-unrestricted-v1', 'sandboxed-unrestricted-v1'
    ) 'readiness campaign profile order'
    Assert-SequenceEquals (Require-JsonProperty $campaign 'condition_order' 'readiness campaign dry-run') @(
      'current-skill', 'no-skill',
      'no-skill', 'current-skill',
      'no-skill', 'current-skill',
      'current-skill', 'no-skill'
    ) 'readiness campaign condition order'
    if ($campaign.PSObject.Properties.Name -contains 'product_access_order') {
      Assert-SequenceEquals $campaign.product_access_order @(
        'product-assisted', 'free-baseline-no-product',
        'free-baseline-no-product', 'product-assisted',
        'free-baseline-no-product', 'product-assisted',
        'product-assisted', 'free-baseline-no-product'
      ) 'readiness campaign product-access order'
    }
  }
  if ($attestationHashMatchesFresh -ne $true) {
    Fail 'readiness campaign dry-run attestation hash does not match the fresh attestation'
  }
  if ($attestationPathLeaked -ne $false -or
      $attestationContentLeaked -ne $false -or
      $attestationTimestampsLeaked -ne $false) {
    Fail 'readiness campaign dry-run leaked attestation path/content/timestamp'
  }
  if ([int]$campaign.strict_cell_count -ne 0 -or [int]$campaign.unrestricted_cell_count -ne 8) {
    Fail "readiness campaign dry-run cell counts drifted: strict=$($campaign.strict_cell_count), unrestricted=$($campaign.unrestricted_cell_count)"
  }
  if ($strictCellsWithAttestationHash -ne 0 -or $unrestrictedCellsWithAttestationHash -ne 8) {
    Fail "readiness campaign dry-run attestation placement drifted: strict=$strictCellsWithAttestationHash, unrestricted=$unrestrictedCellsWithAttestationHash"
  }
  if ($distinctAttestationHashesAmongUnrestricted -ne 1) {
    Fail "readiness campaign dry-run attestation hash cardinality drifted: $distinctAttestationHashesAmongUnrestricted"
  }
  if (-not ($campaign.PSObject.Properties.Name -contains 'max_budget_usd')) {
    Fail 'readiness campaign dry-run missing max_budget_usd'
  }
  if ([double]$campaign.max_budget_usd -ne [double]$MaxBudgetUsd) {
    Fail "readiness campaign dry-run max_budget_usd drifted: $($campaign.max_budget_usd)"
  }

  $ledger | Add-Member -NotePropertyName '__live_harness_commit' -NotePropertyValue $ledgerCommitActual -Force
  $ledger | Add-Member -NotePropertyName '__live_harness_tree' -NotePropertyValue $ledgerTreeActual -Force
  $ledger | Add-Member -NotePropertyName '__live_campaign_dry_run' -NotePropertyValue $campaign -Force
  $campaign | Add-Member -NotePropertyName '__live_output_sha256' -NotePropertyValue $campaignOutputSha -Force
  return $ledger
}

function Assert-CampaignDryRunByteIdentical([string]$NodeCommand, $ReadinessCampaign) {
  $js = @'
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const args = [
  'tools/agentic-eval/cli.mjs',
  'run',
  '--scenario', 'coverage-threshold-failure',
  '--source-repo-dir', 'C:\\kmp-eval\\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1',
  '--seed', '20260821',
  '--runtime', 'claude-code',
  '--campaign-design', '__CAMPAIGN_DESIGN_ID__',
  '--max-budget-usd', '__MAX_BUDGET_USD__',
  '--isolation-attestation-file', 'C:\\kmp-eval\\measurement-scopes\\evidence1-claude-windows-isolation-attestation-stageb-v1.json',
  '--dry-run',
];

const result = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'buffer' });
const stdout = result.stdout ?? Buffer.alloc(0);
const stderr = result.stderr ?? Buffer.alloc(0);
const summary = {
  exit_code: typeof result.status === 'number' ? result.status : null,
  signal: result.signal ?? null,
  stdout_sha256: createHash('sha256').update(stdout).digest('hex'),
  stdout_sha256_lf_normalized: createHash('sha256').update(Buffer.from(stdout.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')).digest('hex'),
  stdout_size_bytes: stdout.length,
  stderr_size_bytes: stderr.length,
};
process.stdout.write(JSON.stringify(summary));
process.exit(result.status ?? 125);
'@
  $js = $js.Replace('__MAX_BUDGET_USD__', $MaxBudgetUsd)
  $js = $js.Replace('__CAMPAIGN_DESIGN_ID__', $CampaignDesignId)

  $dryRunRaw = & $NodeCommand --input-type=module -e $js
  $dryRunExit = $LASTEXITCODE
  try {
    $dryRun = $dryRunRaw | ConvertFrom-Json
  } catch {
    Fail 'campaign dry-run prelaunch fingerprint returned invalid JSON'
  }

  if ($dryRunExit -ne 0 -or $dryRun.exit_code -ne 0) {
    Fail "campaign dry-run prelaunch failed with exit code $dryRunExit / child $($dryRun.exit_code)"
  }
  if ($dryRun.stdout_sha256_lf_normalized -ne $ReadinessCampaign.__live_output_sha256 -and
      $dryRun.stdout_sha256 -ne $ReadinessCampaign.__live_output_sha256) {
    Fail "campaign dry-run stdout sha drift: raw=$($dryRun.stdout_sha256), lf=$($dryRun.stdout_sha256_lf_normalized)"
  }

  return [ordered]@{
    exit_code = [int]$dryRun.exit_code
    stdout_sha256 = [string]$dryRun.stdout_sha256
    stdout_sha256_lf_normalized = [string]$dryRun.stdout_sha256_lf_normalized
    stdout_size_bytes = [int64]$dryRun.stdout_size_bytes
  }
}

function Invoke-Evidence1CanaryLaunch {
  if (-not $RunId -or $CanaryArm -cnotin @('product','free-baseline') -or -not $CanaryBindingSha256) { throw 'canary_launch_parameters' }
  Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1') -ErrorAction Stop
  $directory = Join-Path 'C:\Evidence1Ops' "canary\$RunId"
  $bundle = Read-Evidence1CanaryBundle $directory $RunId $CanaryArm $CanaryBindingSha256
  $binding = $bundle.binding
  $null = New-Evidence1CanaryClaim $directory $RunId $CanaryBindingSha256 'launcher'
  $validationDirectory = 'C:\kmp-eval\scratch\evidence1-validation-ops'
  $sourceContext = $null; $sourceBefore = $null; $inventoryBefore = $null; $inventoryAfter = $null
  $mutex = $null; $locked = $false; $journal = $null; $exitCode = 997; $state = 'wrapper_error'
  $preserved = $false; $sdk = $null
  $liveOperation = $null; $liveJoined = $false
  $diagnostics = New-Evidence1CanaryDiagnostics
  $phase = 'guest_preflight'
  $environment = @{}
  foreach ($name in @('GIT_OPTIONAL_LOCKS','ANDROID_HOME','ANDROID_SDK_ROOT','KMP_AGENTIC_EVAL_GRADLE_USER_HOME_SEED_DIR')) { $environment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
  try {
    $env:GIT_OPTIONAL_LOCKS = '0'
    Refresh-StageBPath
    Set-StageBClaudeNetworkEnvironment
    $mutex = [Threading.Mutex]::new($false, 'Global\Evidence1ValidationOps')
    $locked = $mutex.WaitOne(0)
    if (-not $locked) { throw 'canary_validation_overlap' }
    Assert-E1NoGuestLive $SourceDir
    $null = Assert-E1Repo $HarnessDir $binding.target_commit $binding.target_tree $directory
    $HarnessCommit = $binding.target_commit; $HarnessTree = $binding.target_tree
    Assert-Evidence1CanaryGuestEvidence $bundle $HarnessDir $ReadinessLedgerPath $AttestationFile $validationDirectory
    $inventoryBefore = Get-Evidence1CanaryValidationInventory $validationDirectory
    $phase = 'auth'
    $node = Command-Source 'node.exe'
    $claude = Command-Source 'claude.cmd'
    if (-not $claude) { $claude = Command-Source 'claude.exe' }
    if (-not $node -or -not $claude) { throw 'canary_tools_missing' }
    $actualClaude = (& $claude --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualClaude -cnotmatch '^2\.1\.238(?: \(Claude Code\))?$') { throw 'canary_claude_version' }
    $null = Assert-CredentialEnvironmentPosture
    $null = Assert-ClaudeAuthReady $claude
    Assert-RestrictedNetwork
    $null = Assert-RemoteAuthCanary $actualClaude
    # This remains the legacy eight-cell V1 check, not the selected V3 fingerprint.
    $null = Read-ReadinessLedger
    if (-not (Test-Path -LiteralPath $GradleUserHomeSeedDir -PathType Container)) { throw 'canary_seed_missing' }
    $baseline = (Read-Evidence1CanaryJson (Join-Path $directory 'journal-baseline.json')).value
    if ($baseline.run_id -cne $RunId -or $baseline.binding_sha256 -cne $CanaryBindingSha256 -or $baseline.journal_ids -isnot [array]) { throw 'canary_journal_baseline' }
    $journalRoot = Join-Path $HarnessDir 'tools/runs/agentic-eval-journal'
    $journal = Get-Evidence1CanaryJournalProgress $journalRoot @($baseline.journal_ids) $RunId
    if ($journal.journal_id) { throw 'canary_journal_overlap' }
    $phase = 'source_clone'
    $sourceBefore = Get-E1SourceSnapshot $SourceDir $binding.source_commit '' $directory
    $sourceContext = New-Evidence1CanarySource $SourceDir (Join-Path $ScratchDir "canary-$RunId") $binding.source_commit
    # Reuse the existing bounded sdk.dir reader; do not copy ambient local.properties.
    Import-Module (Join-Path $HarnessDir 'docs/audits/evidence1-gradle-offline-probe.psm1') -ErrorAction Stop
    $sdk = Get-E1OfflineSdk $SourceDir
    $env:ANDROID_HOME = $sdk.root; $env:ANDROID_SDK_ROOT = $sdk.root
    $phase = 'dry_plan'
    $dryStdout = Join-Path $sourceContext.directory 'prelaunch-dry.stdout.json'
    $dryStderr = Join-Path $sourceContext.directory 'prelaunch-dry.stderr.txt'
    $dryProcess = Invoke-E1OwnedProcess $node @(Get-Evidence1CanaryArguments $binding $sourceContext.path $AttestationFile -DryRun) $HarnessDir $dryStdout $dryStderr 60
    $diagnostics.processes.dry_plan = ConvertTo-E1ProcessObservation @{ exit_code = [int]$dryProcess.ExitCode; wall_seconds = $dryProcess.WallSeconds; timed_out = $dryProcess.TimedOut; cleanup_ok = $dryProcess.CleanupOk }
    if ($dryProcess.ExitCode -ne 0 -or $dryProcess.TimedOut -or -not $dryProcess.CleanupOk -or (Get-Item $dryStderr).Length -ne 0) { throw 'canary_dry_process' }
    $dry = Read-E1Json $dryStdout
    $checks = Get-E1DryChecks $dry.value $binding.campaign_design_id $binding.hashes.attestation_canonical_sha256 $binding.hashes.execution_profile_sha256
    if ($checks.Values -contains $false -or $dry.sha256 -cne $binding.plan_sha256) { throw 'canary_dry_plan_changed' }
    $phase = 'live_preflight'
    $bundle = Read-Evidence1CanaryBundle $directory $RunId $CanaryArm $CanaryBindingSha256
    Assert-Evidence1CanaryGuestEvidence $bundle $HarnessDir $ReadinessLedgerPath $AttestationFile $validationDirectory
    $null = Assert-RemoteAuthCanary $actualClaude
    Assert-RestrictedNetwork
    Assert-E1NoGuestLive $SourceDir
    if ((Get-Evidence1CanaryValidationInventory $validationDirectory) -cne $inventoryBefore) { throw 'canary_validation_changed' }
    $null = Assert-E1SourcePostflight $SourceDir $binding.source_commit $sourceContext.tree $directory $sourceContext.before -Operation 'dry-v3'
    $null = Assert-E1Repo $sourceContext.path $binding.source_commit $sourceContext.tree $directory
    $arguments = @(Get-Evidence1CanaryArguments $binding $sourceContext.path $AttestationFile)
    $env:KMP_AGENTIC_EVAL_GRADLE_USER_HOME_SEED_DIR = $GradleUserHomeSeedDir
    $phase = 'live'
    $liveOperation = Start-E1OwnedProcess $node $arguments $HarnessDir (Join-Path $sourceContext.directory 'live.stdout.log') (Join-Path $sourceContext.directory 'live.stderr.log') 1800
    while (-not $liveOperation.Task.IsCompleted) {
      $phase = 'journal'
      try {
        $journal = Get-Evidence1CanaryJournalProgress $journalRoot @($baseline.journal_ids) $RunId $journal
      } catch {
        if ($_.Exception.Message -cne 'canary_journal_retiring') { throw }
        # Journal retirement happens after durable evidence promotion but can precede the
        # parent Node task completing. Give that same owned task a bounded finalization window;
        # never respawn or replace it.
        foreach ($attempt in 1..100) {
          if ($liveOperation.Task.IsCompleted) { break }
          Start-Sleep -Milliseconds 100
        }
        if (-not $liveOperation.Task.IsCompleted) { throw 'canary_journal_retirement_stalled' }
        $journal = Get-Evidence1CanaryJournalProgress $journalRoot @($baseline.journal_ids) $RunId $journal -AllowRetiredAfterProcessExit
      }
      Write-Evidence1JsonAtomically (Join-Path $directory 'journal.json') $journal
      Start-Sleep -Milliseconds 200
    }
    $phase = 'live'
    $live = Wait-E1OwnedProcess $liveOperation
    $liveJoined = $true
    $diagnostics.processes.live = ConvertTo-E1ProcessObservation @{ exit_code = [int]$live.ExitCode; wall_seconds = $live.WallSeconds; timed_out = $live.TimedOut; cleanup_ok = $live.CleanupOk }
    if ($live.TimedOut -or $live.Cancelled -or -not $live.CleanupOk) { throw 'canary_process_cleanup' }
    $phase = 'journal'
    $journalPath = Join-Path $directory 'journal.json'
    if (-not ($journal -and $journal.journal_id -and $journal.available -eq $false)) {
      $journal = Get-Evidence1CanaryJournalProgress $journalRoot @($baseline.journal_ids) $RunId $journal -AllowRetiredAfterProcessExit
    }
    Write-Evidence1JsonAtomically $journalPath $journal
    if ($journal.publication_pending) { throw 'canary_publication_incomplete' }
    $exitCode = [int]$live.ExitCode
    if ($exitCode -eq 0 -and -not $journal.journal_id) { throw 'canary_journal_unobserved' }
    $state = 'exited'
    if ($exitCode -ne 0) { try { throw 'canary_live_exit_nonzero' } catch { Set-Evidence1CanaryFailure $diagnostics 'primary' 'live' $_ } }
  } catch {
    Set-Evidence1CanaryFailure $diagnostics 'primary' $phase $_
    if ($liveOperation -and -not $liveJoined) {
      try {
        Stop-E1OwnedProcess $liveOperation
        $live = Wait-E1OwnedProcess $liveOperation
        $liveJoined = $true
        $diagnostics.processes.live = ConvertTo-E1ProcessObservation @{ exit_code = [int]$live.ExitCode; wall_seconds = $live.WallSeconds; timed_out = $live.TimedOut; cleanup_ok = $live.CleanupOk }
      } catch { Set-Evidence1CanaryFailure $diagnostics 'cleanup' 'live' $_ }
    }
    foreach ($processPhase in @('live','dry_plan')) {
      if ($diagnostics.processes[$processPhase] -and -not $diagnostics.processes[$processPhase].cleanup_ok) {
        try { throw 'canary_process_cleanup' } catch { Set-Evidence1CanaryFailure $diagnostics 'cleanup' $processPhase $_ }
      }
    }
    $exitCode = 997; $state = 'wrapper_error'
  } finally {
    try {
      if ($sourceBefore) {
        $null = Assert-E1SourcePostflight $SourceDir $binding.source_commit $sourceBefore.tree $directory $sourceBefore -Operation 'dry-v3'
      }
      if ($sdk) {
        $sdkAfter = Get-E1OfflineSdk $SourceDir
        if ($sdkAfter.configuration_sha256 -cne $sdk.configuration_sha256 -or $sdkAfter.build_tools_sha256 -cne $sdk.build_tools_sha256) { throw 'canary_sdk_changed' }
      }
      if ($inventoryBefore) {
        $inventoryAfter = Get-Evidence1CanaryValidationInventory $validationDirectory
        if ($inventoryAfter -cne $inventoryBefore) { throw 'canary_validation_changed' }
        $preserved = $null -ne $sourceBefore
      }
    } catch { Set-Evidence1CanaryFailure $diagnostics 'postflight' 'postflight' $_; $exitCode = 997; $state = 'wrapper_error'; $preserved = $false }
    $diagnostics.checks.source_preserved = $preserved
    $custody = [ordered]@{ schema = 1; run_id = $RunId; binding_sha256 = $CanaryBindingSha256; source_commit = $binding.source_commit
      source_preserved = $preserved; validation_inventory_before_sha256 = $inventoryBefore; validation_inventory_after_sha256 = $inventoryAfter
      clone_kind = 'independent-local-object-clone'; source_tree = $(if ($sourceContext) { $sourceContext.tree } else { $null }); diagnostics = $diagnostics }
    try {
      $diagnostics.checks.custody_written = $true
      Write-Evidence1JsonAtomically (Join-Path $directory 'source-custody.json') $custody
    } catch {
      $diagnostics.checks.custody_written = $false
      Set-Evidence1CanaryFailure $diagnostics 'persistence' 'custody_write' $_
      $exitCode = 997; $state = 'wrapper_error'
    }
    foreach ($name in $environment.Keys) { [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process') }
    if ($locked) { $mutex.ReleaseMutex() }; if ($mutex) { $mutex.Dispose() }
    try {
      $diagnostics.checks.terminal_written = $true
      Write-Evidence1JsonAtomically $TerminalRecordPath ([ordered]@{
        schema = 1; run_id = $RunId; state = $state; ts_utc = [datetime]::UtcNow.ToString('o'); exit_code = $exitCode; exit_code_source = 'launcher_record'
        canary = @{ arm = $CanaryArm; planned_sessions = 1; binding_sha256 = $CanaryBindingSha256 }; diagnostics = $diagnostics
      })
    } catch {
      $diagnostics.checks.terminal_written = $false
      Set-Evidence1CanaryFailure $diagnostics 'persistence' 'terminal_write' $_
      $exitCode = 997
      try { Write-Evidence1JsonAtomically (Join-Path $directory 'source-custody.json') $custody } catch { }
    }
  }
  return $exitCode
}

if ($LoadOnly) {
  return
}

if ($CanaryArm -or $CanaryBindingSha256) { exit (Invoke-Evidence1CanaryLaunch) }

Refresh-StageBPath
Set-StageBClaudeNetworkEnvironment
New-Item -ItemType Directory -Force -Path $ScratchDir | Out-Null

$node = Command-Source 'node.exe'
if (-not $node) { Fail 'node.exe not found' }
if (-not (Command-Source 'git.exe')) { Fail 'git.exe not found' }
$claude = Command-Source 'claude.cmd'
if (-not $claude) { $claude = Command-Source 'claude.exe' }
if (-not $claude) { Fail 'claude command not found' }

if (-not (Test-Path -LiteralPath $HarnessDir)) { Fail 'harness directory missing' }
if (-not (Test-Path -LiteralPath $SourceDir)) { Fail 'source directory missing' }
if (-not (Test-Path -LiteralPath $AttestationFile)) { Fail 'attestation file missing' }
if (-not (Test-Path -LiteralPath $GradleUserHomeSeedDir -PathType Container)) {
  Fail "prewarmed Gradle user-home seed directory missing: $GradleUserHomeSeedDir"
}

$credentialEnvironment = Assert-CredentialEnvironmentPosture

Push-Location $HarnessDir
try {
  $head = (& git.exe rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or -not ($head -match '^[0-9a-f]{40}$')) {
    Fail "could not resolve current harness HEAD: $head"
  }
  $HarnessCommit = $head

  $tree = (& git.exe @('rev-parse', 'HEAD^{tree}')).Trim()
  if ($LASTEXITCODE -ne 0 -or -not ($tree -match '^[0-9a-f]{40}$')) {
    Fail "could not resolve current harness tree: $tree"
  }
  $HarnessTree = $tree

  $status = (& git.exe status --short)
  if ($status) { Fail "harness worktree is not clean: $status" }

  $actualClaude = (& $claude --version).Trim()
  if ($actualClaude -notmatch [regex]::Escape($ClaudeVersion)) {
    Fail "Claude Code version mismatch: $actualClaude"
  }

  $authCheck = Assert-ClaudeAuthReady $claude
  Assert-RestrictedNetwork
  $remoteAuthCanary = Assert-RemoteAuthCanary $actualClaude
  $readiness = Read-ReadinessLedger
  $readinessCampaign = Require-JsonProperty $readiness '__live_campaign_dry_run' 'normalized readiness ledger'

  $attestationCheckRaw = & $node --input-type=module -e "import { loadIsolationAttestation } from './tools/agentic-eval/execution-profiles/isolation-attestation.mjs'; const r = loadIsolationAttestation('C:/kmp-eval/measurement-scopes/evidence1-claude-windows-isolation-attestation-stageb-v1.json', { profileId:'sandboxed-unrestricted-v1', runtimeId:'claude-code', platform:'windows', networkMode:'restricted', harnessSha:'$HarnessCommit' }); console.log(JSON.stringify({ok:r.ok,schema:r.schema,sha256:r.sha256})); if (!r.ok) process.exit(2);"
  if ($LASTEXITCODE -ne 0) {
    Fail 'attestation validation failed'
  }
  try {
    $attestationCheck = $attestationCheckRaw | ConvertFrom-Json
  } catch {
    Fail 'attestation validation returned invalid JSON'
  }
  if ($readiness.PSObject.Properties.Name -contains 'r5_attestation') {
    $readinessAttestation = Require-JsonProperty $readiness 'r5_attestation' 'readiness ledger'
    $readinessAttestationHash = Require-JsonProperty $readinessAttestation 'attestation_sha256' 'readiness r5_attestation'
  } elseif ($readiness.PSObject.Properties.Name -contains 'R5_attestation') {
    $readinessAttestation = Require-JsonProperty $readiness 'R5_attestation' 'readiness ledger'
    $readinessAttestationHash = Require-JsonProperty $readinessAttestation 'attestation_sha256' 'readiness attestation'
  } elseif ($readiness.PSObject.Properties.Name -contains 'isolation_attestation') {
    $readinessAttestation = Require-JsonProperty $readiness 'isolation_attestation' 'readiness ledger'
    $readinessAttestationHash = Require-JsonProperty $readinessAttestation 'sha256' 'readiness isolation_attestation'
  } elseif ($readiness.PSObject.Properties.Name -contains 'attestation') {
    $readinessAttestation = Require-JsonProperty $readiness 'attestation' 'readiness ledger'
    if ($readinessAttestation.PSObject.Properties.Name -contains 'canonical_json_sha256') {
      $readinessAttestationHash = Require-JsonProperty $readinessAttestation 'canonical_json_sha256' 'readiness attestation'
    } else {
      $readinessAttestationHash = Require-JsonProperty $readinessAttestation 'sha256' 'readiness attestation'
    }
  } else {
    $readinessAttestation = Require-JsonProperty $readiness 'r5_network_seal_and_attestation' 'readiness ledger'
    if ($readinessAttestation.PSObject.Properties.Name -contains 'attestation_sha256') {
      $readinessAttestationHash = Require-JsonProperty $readinessAttestation 'attestation_sha256' 'readiness r5_network_seal_and_attestation'
    } else {
      $readinessAttestationHash = Require-JsonProperty $readinessAttestation 'attestation_canonical_sha256' 'readiness r5_network_seal_and_attestation'
    }
  }
  if ($attestationCheck.sha256 -ne $readinessAttestationHash) {
    Fail "attestation hash drift against readiness ledger: $($attestationCheck.sha256)"
  }

  $dryRunCheck = Assert-CampaignDryRunByteIdentical $node $readinessCampaign

  $preflight = [ordered]@{
    started_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    harness_head = $head
    harness_tree = $tree
    claude = $actualClaude
    auth = [ordered]@{
      local = $authCheck
      environment = $credentialEnvironment
      remote_canary = $remoteAuthCanary
    }
    attestation = $attestationCheck
    readiness = [ordered]@{
      verdict = $readiness.verdict
      harness_commit = $readiness.__live_harness_commit
      harness_tree = $readiness.__live_harness_tree
      campaign_dry_run_sha256 = $readinessCampaign.__live_output_sha256
    }
    campaign_dry_run = $dryRunCheck
    max_budget_usd = $MaxBudgetUsd
    source_dir = $SourceDir
    gradle_user_home_seed_dir_configured = $true
    gradle_user_home_seed_dir_kind = 'vm-user-gradle-cache'
    launch_policy = 'single authorized live campaign; no retries/replacements/respawns'
  } | ConvertTo-Json -Depth 4

  Set-Content -LiteralPath $LogPath -Encoding UTF8 -Value @(
    '[stage-b-launch] PRELAUNCH'
    $preflight
    '[stage-b-launch] COMMAND_OUTPUT_BEGIN'
  )

  $args = @(
    'tools/agentic-eval/cli.mjs',
    'run',
    '--scenario', 'coverage-threshold-failure',
    '--source-repo-dir', $SourceDir,
    '--seed', '20260821',
    '--runtime', 'claude-code',
    '--campaign-design', $CampaignDesignId,
    '--max-budget-usd', $MaxBudgetUsd,
    '--isolation-attestation-file', $AttestationFile
  )

  function ConvertTo-NativeArgumentLine {
    param([Parameter(Mandatory = $true)][string[]]$ArgumentList)
    $parts = foreach ($argument in $ArgumentList) {
      if ($null -eq $argument) {
        '""'
        continue
      }
      $value = [string]$argument
      if ($value -notmatch '[\s"]') {
        $value
        continue
      }
      $value = $value -replace '(\\*)"', '$1$1\"'
      $value = $value -replace '(\\+)$', '$1$1'
      '"' + $value + '"'
    }
    [string]::Join(' ', $parts)
  }

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $appendLine = {
    param([string]$line)
    [System.IO.File]::AppendAllText($LogPath, "$line`r`n", $utf8NoBom)
  }
  $appendFileBytes = {
    param([string]$sourcePath)
    if (-not (Test-Path -LiteralPath $sourcePath)) { return }
    $sourceStream = [System.IO.File]::Open($sourcePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $targetStream = [System.IO.File]::Open($LogPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
      try {
        $sourceStream.CopyTo($targetStream)
      } finally {
        $targetStream.Dispose()
      }
    } finally {
      $sourceStream.Dispose()
    }
  }

  # Native stderr is expected on fail-closed harness outcomes (for example matrix fail-fast).
  # Capture stdout/stderr as native process streams instead of PowerShell's `2>&1` pipeline, which
  # can serialize stderr as ErrorRecord objects and corrupt the operational log with NUL/UTF-16-like
  # bytes while the JSON terminal records remain valid. Keep the two native streams in temporary
  # files while the process is alive; after exit, append the captured bytes to the operational log
  # without decoding or PowerShell object formatting.
  $streamCaptureRoot = Join-Path $ScratchDir 'stage-b-live-stream-capture'
  New-Item -ItemType Directory -Force -Path $streamCaptureRoot | Out-Null
  $stdoutPath = Join-Path $streamCaptureRoot 'stdout.log'
  $stderrPath = Join-Path $streamCaptureRoot 'stderr.log'
  Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.WorkingDirectory = $HarnessDir
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.Environment['KMP_AGENTIC_EVAL_GRADLE_USER_HOME_SEED_DIR'] = $GradleUserHomeSeedDir
  $argumentListProperty = $psi.GetType().GetProperty('ArgumentList')
  if ($null -ne $argumentListProperty) {
    foreach ($argument in $args) { [void]$psi.ArgumentList.Add($argument) }
  } else {
    $psi.Arguments = ConvertTo-NativeArgumentLine -ArgumentList $args
  }

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  $stdoutStream = $null
  $stderrStream = $null
  $stdoutTask = $null
  $stderrTask = $null
  try {
    $stdoutStream = [System.IO.File]::Open($stdoutPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
    $stderrStream = [System.IO.File]::Open($stderrPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
    if (-not $process.Start()) { Fail 'failed to start Node live campaign process' }
    $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdoutStream)
    $stderrTask = $process.StandardError.BaseStream.CopyToAsync($stderrStream)
    $process.WaitForExit()
    [System.Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask))
    $exit = [int]$process.ExitCode
  } finally {
    if ($null -ne $stdoutStream) { $stdoutStream.Dispose() }
    if ($null -ne $stderrStream) { $stderrStream.Dispose() }
    $process.Dispose()
  }
  & $appendFileBytes $stdoutPath
  & $appendFileBytes $stderrPath
  if ($RunId) {
    Write-Evidence1JsonAtomically -Path $TerminalRecordPath -Value ([ordered]@{
      schema = 1
      run_id = $RunId
      state = 'exited'
      ts_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      exit_code = [int]$exit
      exit_code_source = 'launcher_record'
    })
  }
  & $appendLine "EXITCODE:$exit"
  Write-Output "EXITCODE:$exit"
  exit $exit
} finally {
  Pop-Location
}

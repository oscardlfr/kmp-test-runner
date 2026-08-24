param(
  [string]$RunId = '',
  [string]$TerminalRecordPath = ''
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

$HarnessCommit = '66c5f3d02996142cbd0c16c26a2607fb96ecde33'
$HarnessTree = 'f1eb21847b90d9eece55298eb9dd142d5752e24f'
$ClaudeVersion = '2.1.238'
$MaxBudgetUsd = '2.00'
$CampaignDesignId = 'claude-product-vs-free-baseline-v1'
$HarnessDir = 'C:\kmp-eval\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1'
$SourceDir = 'C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1'
$AttestationFile = 'C:\kmp-eval\measurement-scopes\evidence1-claude-windows-isolation-attestation-stageb-v1.json'
$ScratchDir = 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1'
$LogPath = Join-Path $ScratchDir 'STAGE-B-live.log'
$ReadinessLedgerPath = Join-Path $ScratchDir 'READINESS.json'

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
    logged_in = $true
  }
}

function Require-JsonProperty($Object, [string]$Name, [string]$Label) {
  if ($null -eq $Object -or -not ($Object.PSObject.Properties.Name -contains $Name)) {
    Fail "$Label missing required property: $Name"
  }
  return $Object.$Name
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
    if ($anchors.PSObject.Properties.Name -contains 'harness_commit_actual') {
      $ledgerCommitActual = Require-JsonProperty $anchors 'harness_commit_actual' 'readiness anchors'
      $ledgerCommitExpected = Require-JsonProperty $anchors 'harness_commit_expected' 'readiness anchors'
      $ledgerTreeActual = Require-JsonProperty $anchors 'harness_tree_actual' 'readiness anchors'
      $ledgerTreeExpected = Require-JsonProperty $anchors 'harness_tree_expected' 'readiness anchors'
    } elseif ($anchors.PSObject.Properties.Name -contains 'harness_sha') {
      $ledgerCommitActual = Require-JsonProperty $anchors 'harness_sha' 'readiness anchors'
      $ledgerTreeActual = Require-JsonProperty $anchors 'harness_tree' 'readiness anchors'
      $ledgerCommitExpected = $ledgerCommitActual
      $ledgerTreeExpected = $ledgerTreeActual
    } else {
      $ledgerCommitActual = Require-JsonProperty $anchors 'harness_commit' 'readiness anchors'
      $ledgerTreeActual = Require-JsonProperty $anchors 'harness_tree' 'readiness anchors'
      $ledgerCommitExpected = $ledgerCommitActual
      $ledgerTreeExpected = $ledgerTreeActual
    }
  } elseif ($ledger.PSObject.Properties.Name -contains 'r2_harness') {
    $anchors = Require-JsonProperty $ledger 'r2_harness' 'readiness ledger'
    $ledgerCommitActual = Require-JsonProperty $anchors 'harness_commit' 'readiness r2_harness'
    $ledgerTreeActual = Require-JsonProperty $anchors 'harness_tree' 'readiness r2_harness'
    $ledgerCommitExpected = $ledgerCommitActual
    $ledgerTreeExpected = $ledgerTreeActual
  } elseif ($ledger.PSObject.Properties.Name -contains 'harness') {
    $anchors = Require-JsonProperty $ledger 'harness' 'readiness ledger'
    $ledgerCommitActual = Require-JsonProperty $anchors 'commit' 'readiness harness'
    $ledgerTreeActual = Require-JsonProperty $anchors 'tree' 'readiness harness'
    $ledgerCommitExpected = $ledgerCommitActual
    $ledgerTreeExpected = $ledgerTreeActual
  } else {
    $anchors = Require-JsonProperty $ledger 'harness_anchor' 'readiness ledger'
    $ledgerCommitActual = Require-JsonProperty $anchors 'commit' 'readiness harness_anchor'
    $ledgerTreeActual = Require-JsonProperty $anchors 'tree' 'readiness harness_anchor'
    $ledgerCommitExpected = $ledgerCommitActual
    $ledgerTreeExpected = $ledgerTreeActual
  }
  if ($ledgerCommitActual -ne $HarnessCommit -or $ledgerCommitExpected -ne $HarnessCommit) {
    Fail "readiness ledger harness commit drift: actual=$ledgerCommitActual expected=$ledgerCommitExpected"
  }
  if ($ledgerTreeActual -ne $HarnessTree -or $ledgerTreeExpected -ne $HarnessTree) {
    Fail "readiness ledger harness tree drift: actual=$ledgerTreeActual expected=$ledgerTreeExpected"
  }

  if ($ledger.PSObject.Properties.Name -contains 'R7_campaign_dry_run') {
    $r7 = Require-JsonProperty $ledger 'R7_campaign_dry_run' 'readiness ledger'
  } elseif ($ledger.PSObject.Properties.Name -contains 'campaign_dry_run') {
    $r7 = Require-JsonProperty $ledger 'campaign_dry_run' 'readiness ledger'
  } elseif ($ledger.PSObject.Properties.Name -contains 'dry_run_campaign') {
    $r7 = Require-JsonProperty $ledger 'dry_run_campaign' 'readiness ledger'
  } else {
    $r7 = Require-JsonProperty $ledger 'r7_campaign_dry_run' 'readiness ledger'
  }
  $campaign = Require-JsonProperty $r7 'pass_dry_run' 'readiness campaign_dry_run'
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
  } elseif ($campaign.PSObject.Properties.Name -contains 'attestation_hash_matches_loader') {
    $campaign.attestation_hash_matches_loader
  } elseif ($campaign.PSObject.Properties.Name -contains 'unrestricted_attestation_hash_matches_loader') {
    $campaign.unrestricted_attestation_hash_matches_loader
  } elseif ($campaign.PSObject.Properties.Name -contains 'shared_isolation_attestation_sha256') {
    [string]$campaign.shared_isolation_attestation_sha256 -match '^[0-9a-f]{64}$'
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

$forbiddenEnv = Get-ChildItem Env: |
  Where-Object { $_.Name -match 'ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|AZURE_OPENAI_API_KEY|GH_TOKEN|GITHUB_TOKEN|COPILOT_' } |
  Select-Object -ExpandProperty Name
if (@($forbiddenEnv).Count -gt 0) {
  Fail "forbidden secret-like environment variables present: $($forbiddenEnv -join ', ')"
}

Push-Location $HarnessDir
try {
  $head = (& git.exe rev-parse HEAD).Trim()
  if ($head -ne $HarnessCommit) { Fail "harness HEAD mismatch: $head" }

  $tree = (& git.exe @('rev-parse', 'HEAD^{tree}')).Trim()
  if ($tree -ne $HarnessTree) { Fail "harness tree mismatch: $tree" }

  $status = (& git.exe status --short)
  if ($status) { Fail "harness worktree is not clean: $status" }

  $actualClaude = (& $claude --version).Trim()
  if ($actualClaude -notmatch [regex]::Escape($ClaudeVersion)) {
    Fail "Claude Code version mismatch: $actualClaude"
  }

  $authCheck = Assert-ClaudeAuthReady $claude
  Assert-RestrictedNetwork
  $readiness = Read-ReadinessLedger
  $readinessCampaign = if ($readiness.PSObject.Properties.Name -contains 'R7_campaign_dry_run') {
    $readiness.R7_campaign_dry_run.pass_dry_run
  } elseif ($readiness.PSObject.Properties.Name -contains 'campaign_dry_run') {
    $readiness.campaign_dry_run.pass_dry_run
  } elseif ($readiness.PSObject.Properties.Name -contains 'dry_run_campaign') {
    $readiness.dry_run_campaign.pass_dry_run
  } else {
    $readiness.r7_campaign_dry_run.pass_dry_run
  }

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
    $readinessAttestationHash = Require-JsonProperty $readinessAttestation 'sha256' 'readiness attestation'
  } else {
    $readinessAttestation = Require-JsonProperty $readiness 'r5_network_seal_and_attestation' 'readiness ledger'
    $readinessAttestationHash = Require-JsonProperty $readinessAttestation 'attestation_sha256' 'readiness r5_network_seal_and_attestation'
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
    auth = $authCheck
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

  # Native stderr is expected on fail-closed harness outcomes (for example matrix fail-fast).
  # Keep the script strict for PowerShell code, but do not let PowerShell convert native stderr
  # into a terminating NativeCommandError before the Node process finishes finalizing evidence.
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $node @args 2>&1 | Tee-Object -FilePath $LogPath -Append
    $exit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
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
  "EXITCODE:$exit" | Tee-Object -FilePath $LogPath -Append
  exit $exit
} finally {
  Pop-Location
}

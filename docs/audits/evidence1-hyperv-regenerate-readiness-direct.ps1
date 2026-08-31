#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner',
  [string]$GuestComputerName = 'Evidence1Runner',
  [string]$GuestCredentialPath = 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml',
  [string]$SourceRepoDir = '',
  [string]$HarnessDir = 'C:\kmp-eval\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1',
  [string]$TargetRef = 'origin/develop',
  [string]$TargetCommit = '',
  [string]$TargetTree = '',
  [switch]$SkipFetch,
  [string]$SourceCommit = '7d45eae4f8720a0c77f507712ba2437ff974b6ed',
  [string]$NowInAndroidDir = 'C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1',
  [string]$AttestationFile = 'C:\kmp-eval\measurement-scopes\evidence1-claude-windows-isolation-attestation-stageb-v1.json',
  [string]$ScratchDir = 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1',
  [string]$ReportPath = 'C:\kmp-eval\scratch\hyperv-regenerate-readiness-direct\HYPERV-REGENERATE-READINESS-DIRECT.json',
  [int]$TimeoutMinutes = 20
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
  $rootBase = (Resolve-FullPath $Root).TrimEnd('\')
  $rootFull = $rootBase + '\'
  if ($candidateFull -ne $rootBase -and -not $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "$Label path is outside expected root: $candidateFull"
  }
}

function Invoke-HostGit([string[]]$Arguments, [string]$Step) {
  $output = @()
  $exit = $null
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Git writes progress such as "From <remote>" to stderr even on success.
    $ErrorActionPreference = 'Continue'
    $output = @(& git.exe @Arguments 2>&1)
    $exit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exit -ne 0) {
    Fail "$Step failed with exit code $exit`: $($output -join ' ')"
  }
  return @($output)
}

Assert-PathInside $GuestCredentialPath 'C:\kmp-eval\scratch\' 'guest credential'
Assert-PathInside $ReportPath 'C:\kmp-eval\scratch\' 'report'
if ([string]::IsNullOrWhiteSpace($SourceRepoDir)) {
  $SourceRepoDir = Resolve-FullPath (Join-Path $PSScriptRoot '..\..')
} else {
  $SourceRepoDir = Resolve-FullPath $SourceRepoDir
}
if (-not $HarnessDir.StartsWith('C:\kmp-eval\', [StringComparison]::OrdinalIgnoreCase)) {
  Fail "guest harness dir must stay under C:\kmp-eval: $HarnessDir"
}
if (-not $NowInAndroidDir.StartsWith('C:\kmp-eval\', [StringComparison]::OrdinalIgnoreCase)) {
  Fail "guest source dir must stay under C:\kmp-eval: $NowInAndroidDir"
}
if (-not $AttestationFile.StartsWith('C:\kmp-eval\measurement-scopes\', [StringComparison]::OrdinalIgnoreCase)) {
  Fail "attestation file must stay under C:\kmp-eval\measurement-scopes: $AttestationFile"
}
if (-not $ScratchDir.StartsWith('C:\kmp-eval\scratch\', [StringComparison]::OrdinalIgnoreCase)) {
  Fail "scratch dir must stay under C:\kmp-eval\scratch: $ScratchDir"
}
if (-not (Test-Path -LiteralPath $GuestCredentialPath -PathType Leaf)) {
  Fail "guest credential file does not exist: $GuestCredentialPath"
}
if (-not (Test-Path -LiteralPath $SourceRepoDir -PathType Container)) {
  Fail "source repo does not exist: $SourceRepoDir"
}
$inside = (@(Invoke-HostGit @('-C', $SourceRepoDir, 'rev-parse', '--is-inside-work-tree') 'verify source repo')[0]).Trim()
if ($inside -ne 'true') {
  Fail "source repo is not a git worktree: $SourceRepoDir"
}
if (-not $SkipFetch) {
  $null = Invoke-HostGit @('-C', $SourceRepoDir, 'fetch', 'origin', 'develop', '--prune') 'fetch origin/develop'
}

if (-not $TargetCommit) {
  $TargetCommit = (@(Invoke-HostGit @('-C', $SourceRepoDir, 'rev-parse', '--verify', $TargetRef) "resolve $TargetRef")[0]).Trim()
}
if (-not ($TargetCommit -match '^[0-9a-f]{40}$')) {
  Fail "target commit is not a full SHA: $TargetCommit"
}
$resolvedTargetCommit = (@(Invoke-HostGit @('-C', $SourceRepoDir, 'rev-parse', '--verify', $TargetCommit) 'verify target commit exists locally')[0]).Trim()
if ($resolvedTargetCommit -ne $TargetCommit) {
  $TargetCommit = $resolvedTargetCommit
}
$resolvedTargetTree = (@(Invoke-HostGit @('-C', $SourceRepoDir, 'rev-parse', "$TargetCommit^{tree}") 'resolve target tree')[0]).Trim()
if (-not $TargetTree) {
  $TargetTree = $resolvedTargetTree
} elseif ($TargetTree -ne $resolvedTargetTree) {
  Fail "target tree mismatch: expected $TargetTree, got $resolvedTargetTree"
}
if (-not ($TargetTree -match '^[0-9a-f]{40}$')) {
  Fail "target tree is not a full SHA: $TargetTree"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath) | Out-Null

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ($vm.State -ne 'Running') {
  Start-VM -Name $VMName
  Start-Sleep -Seconds 5
  $vm = Get-VM -Name $VMName -ErrorAction Stop
}
if ($vm.State -ne 'Running') {
  Fail "$VMName is not running after start attempt: $($vm.State)"
}

$storedCredential = Import-Clixml -LiteralPath $GuestCredentialPath
$simpleUser = $storedCredential.UserName
if ($simpleUser -match '[\\@]') {
  Fail "stored guest user must be a simple local account name, got: $simpleUser"
}

$candidates = @(
  "$GuestComputerName\$simpleUser",
  "$VMName\$simpleUser",
  ".\$simpleUser",
  $simpleUser,
  "localhost\$simpleUser"
)

$attempts = @()
$session = $null
$workingLogonName = $null
foreach ($logonName in $candidates) {
  $credential = [pscredential]::new($logonName, $storedCredential.Password)
  try {
    $session = New-PSSession -VMName $VMName -Credential $credential -ErrorAction Stop
    $workingLogonName = $logonName
    $attempts += [ordered]@{ logon_name = $logonName; ok = $true; error = $null }
    break
  } catch {
    $attempts += [ordered]@{ logon_name = $logonName; ok = $false; error = $_.Exception.Message }
  }
}

if (-not $session) {
  ([ordered]@{
    verdict = 'FAIL'
    generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    vm_name = $VMName
    vm_state = $vm.State.ToString()
    attempts = $attempts
  } | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $ReportPath -Encoding UTF8
  Fail "could not establish PowerShell Direct session to $VMName"
}

$job = $null
try {
  $job = Invoke-Command -Session $session -AsJob -ScriptBlock {
    param(
      $HarnessDir,
      $TargetCommit,
      $TargetTree,
      $SourceCommit,
      $NowInAndroidDir,
      $AttestationFile,
      $ScratchDir
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    $ClaudeVersion = '2.1.238'
    $CampaignDesignId = 'claude-product-vs-free-baseline-v1'
    $MaxBudgetUsd = '2.00'

    function FailGuest($Message) {
      throw "HARD STOP: $Message"
    }

    function Add-StageBPath {
      $npmPrefix = Join-Path $env:USERPROFILE 'AppData\Roaming\npm'
      $paths = @(
        'C:\Windows\System32',
        'C:\Program Files\Git\cmd',
        'C:\Program Files\Git\bin',
        'C:\Program Files\nodejs',
        $npmPrefix
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

    function Command-Source($Name) {
      $cmd = Get-Command $Name -ErrorAction SilentlyContinue
      if ($cmd) { return $cmd.Source }
      return $null
    }

    function Write-Utf8NoBom([string]$Path, [string]$Value) {
      $dir = Split-Path -Parent $Path
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
    }

    function ConvertTo-Sha256Hex([byte[]]$Bytes) {
      $sha = [System.Security.Cryptography.SHA256]::Create()
      try {
        return (($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
      } finally {
        $sha.Dispose()
      }
    }

    function Get-StringSha256([string]$Value) {
      return ConvertTo-Sha256Hex ([System.Text.Encoding]::UTF8.GetBytes($Value))
    }

    function Invoke-CurlProbe([string]$Uri, [int]$MaxTimeSeconds) {
      $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
      if (-not (Test-Path -LiteralPath $curl)) { FailGuest "curl.exe not found: $curl" }
      $previous = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        $output = & $curl -IsS --max-time $MaxTimeSeconds $Uri 2>&1
        $exit = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previous
      }
      return [ordered]@{
        uri = $Uri
        exit_code = $exit
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
      $allowed = @()
      foreach ($uri in $allowedUris) {
        $probe = Invoke-CurlProbe $uri 15
        $allowed += $probe
        if ($probe.exit_code -ne 0) {
          FailGuest "$uri is not reachable; live Claude Code sessions cannot run"
        }
      }

      $blockedUris = @(
        'https://github.com',
        'https://registry.npmjs.org',
        'https://pypi.org',
        'https://www.wikipedia.org',
        'https://example.com',
        'https://cloudflare.com'
      )
      $blocked = @()
      $unexpected = @()
      foreach ($uri in $blockedUris) {
        $probe = Invoke-CurlProbe $uri 8
        $blocked += $probe
        if ($probe.exit_code -eq 0) { $unexpected += $uri }
      }
      if ($unexpected.Count -gt 0) {
        FailGuest "restricted network is not enforced; unexpected outbound access: $($unexpected -join ', ')"
      }
      return [ordered]@{
        allowed_probe_count = $allowed.Count
        blocked_probe_count = $blocked.Count
        blocked_probe_success_count = 0
      }
    }

    function Assert-SequenceEquals($Actual, [string[]]$Expected, [string]$Label) {
      $actualArray = @($Actual | ForEach-Object { [string]$_ })
      if ($actualArray.Count -ne $Expected.Count) {
        FailGuest "${Label} length drifted: actual=$($actualArray.Count), expected=$($Expected.Count)"
      }
      for ($i = 0; $i -lt $Expected.Count; $i++) {
        if ($actualArray[$i] -ne $Expected[$i]) {
          FailGuest "${Label} drifted at index ${i}: actual=$($actualArray[$i]), expected=$($Expected[$i])"
        }
      }
    }

    Add-StageBPath
    New-Item -ItemType Directory -Force -Path $ScratchDir | Out-Null
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $AttestationFile) | Out-Null

    $node = Command-Source 'node.exe'
    if (-not $node) { FailGuest 'node.exe not found' }
    if (-not (Command-Source 'git.exe')) { FailGuest 'git.exe not found' }
    $claude = Command-Source 'claude.cmd'
    if (-not $claude) { $claude = Command-Source 'claude.exe' }
    if (-not $claude) { FailGuest 'claude command not found' }

    $forbiddenEnv = @(Get-ChildItem Env: |
      Where-Object { $_.Name -match 'ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|AZURE_OPENAI_API_KEY|GH_TOKEN|GITHUB_TOKEN|COPILOT_' } |
      Select-Object -ExpandProperty Name)
    if ($forbiddenEnv.Count -gt 0) {
      FailGuest "forbidden secret-like environment variables present: $($forbiddenEnv -join ', ')"
    }

    $sourceSnapshot = $null
    $sourcePostflightAttempted = $false
    Push-Location $HarnessDir
    try {
      $head = (& git.exe rev-parse HEAD).Trim()
      if ($LASTEXITCODE -ne 0 -or $head -ne $TargetCommit) { FailGuest "harness HEAD drift: $head" }
      $tree = (& git.exe @('rev-parse', 'HEAD^{tree}')).Trim()
      if ($LASTEXITCODE -ne 0 -or $tree -ne $TargetTree) { FailGuest "harness tree drift: $tree" }
      $status = (& git.exe status --short)
      if ($LASTEXITCODE -ne 0 -or $status) { FailGuest "harness worktree is not clean: $($status -join '; ')" }

      $custodyModule = Join-Path $HarnessDir 'docs/audits/evidence1-validation-ops.psm1'
      $expectedModuleBlob = (& git.exe rev-parse 'HEAD:docs/audits/evidence1-validation-ops.psm1').Trim()
      if ($LASTEXITCODE -ne 0 -or $expectedModuleBlob -notmatch '^[0-9a-f]{40}$') { FailGuest 'source custody module identity unavailable' }
      $actualModuleBlob = (& git.exe hash-object --no-filters -- $custodyModule).Trim()
      if ($LASTEXITCODE -ne 0 -or $actualModuleBlob -cne $expectedModuleBlob) { FailGuest 'source custody module hash mismatch' }
      Import-Module $custodyModule -Force -DisableNameChecking

      $nodeVersion = (& $node --version).Trim()
      $gitVersion = (& git.exe --version).Trim()
      $claudeVersion = (& $claude --version).Trim()
      if ($claudeVersion -notmatch [regex]::Escape($ClaudeVersion)) {
        FailGuest "Claude Code version mismatch: $claudeVersion"
      }

      & $claude auth status *> $null
      if ($LASTEXITCODE -ne 0) {
        FailGuest "claude auth status failed with exit code $LASTEXITCODE"
      }

      $previousErrorActionPreference = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        $javaVersion = & java.exe -version 2>&1
        $javaExit = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousErrorActionPreference
      }
      if ($javaExit -ne 0) { FailGuest 'java -version failed' }

      Push-Location $NowInAndroidDir
      try {
        $sourceHead = (& git.exe rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0 -or $sourceHead -ne $SourceCommit) {
          FailGuest "source HEAD drift: $sourceHead"
        }
        $sourceSnapshot = Get-E1SourceSnapshot $NowInAndroidDir $SourceCommit '' $ScratchDir
      } finally {
        Pop-Location
      }

      $network = Assert-RestrictedNetwork

      $now = [DateTime]::UtcNow
      $createdAt = $now.ToString('yyyy-MM-ddTHH:mm:ssZ')
      $expiresAt = $now.AddHours(23).ToString('yyyy-MM-ddTHH:mm:ssZ')
      $attestation = [ordered]@{
        schema = 1
        profile_id = 'sandboxed-unrestricted-v1'
        runtime_id = 'claude-code'
        campaign_id = 'evidence1-product-free-stageb'
        platform = 'windows'
        boundary_kind = 'dedicated-ephemeral-runner'
        network_mode = 'restricted'
        workspace_scope = 'campaign-only'
        runtime_credential_scope = 'runtime-only'
        normal_maintainer_home_mounted = $false
        ambient_secrets_present = $false
        disposable_home = $true
        rollback_or_destroy_required = $true
        harness_sha = $head
        created_at = $createdAt
        expires_at = $expiresAt
      }
      $attestationJson = $attestation | ConvertTo-Json -Depth 5
      Write-Utf8NoBom $AttestationFile $attestationJson
      $attestationBytes = [System.IO.File]::ReadAllBytes($AttestationFile)

      $validateJs = @"
import { loadIsolationAttestation } from './tools/agentic-eval/execution-profiles/isolation-attestation.mjs';
const r = loadIsolationAttestation('C:/kmp-eval/measurement-scopes/evidence1-claude-windows-isolation-attestation-stageb-v1.json', {
  profileId: 'sandboxed-unrestricted-v1',
  runtimeId: 'claude-code',
  platform: 'windows',
  networkMode: 'restricted',
  harnessSha: '$head',
});
process.stdout.write(JSON.stringify(r));
if (!r.ok) process.exit(2);
"@
      $validationRaw = & $node --input-type=module -e $validateJs
      if ($LASTEXITCODE -ne 0) {
        FailGuest 'attestation validation failed'
      }
      $validation = $validationRaw | ConvertFrom-Json
      if ($validation.ok -ne $true -or $validation.schema -ne 1 -or -not ([string]$validation.sha256 -match '^[0-9a-f]{64}$')) {
        FailGuest 'attestation validation returned an invalid success shape'
      }

      $dryStdout = Join-Path $ScratchDir 'campaign-dryrun-current.json'
      $dryStderr = Join-Path $ScratchDir 'campaign-dryrun-current.stderr.txt'
      Remove-Item -LiteralPath $dryStdout,$dryStderr -Force -ErrorAction SilentlyContinue
      $dryArgs = @(
        'tools/agentic-eval/cli.mjs',
        'run',
        '--scenario', 'coverage-threshold-failure',
        '--source-repo-dir', $NowInAndroidDir,
        '--seed', '20260821',
        '--runtime', 'claude-code',
        '--campaign-design', $CampaignDesignId,
        '--max-budget-usd', $MaxBudgetUsd,
        '--isolation-attestation-file', $AttestationFile,
        '--dry-run'
      )
      & $node @dryArgs 1> $dryStdout 2> $dryStderr
      $dryExit = $LASTEXITCODE
      if ($dryExit -ne 0) {
        FailGuest "campaign dry-run failed with exit code $dryExit"
      }
      $dryText = [System.IO.File]::ReadAllText($dryStdout, [System.Text.Encoding]::UTF8)
      $dryTextLf = $dryText.Replace("`r`n", "`n")
      $dryHashLf = Get-StringSha256 $dryTextLf
      $dryHashRaw = ConvertTo-Sha256Hex ([System.IO.File]::ReadAllBytes($dryStdout))
      $dry = $dryText | ConvertFrom-Json

      if ($dry.dry_run -ne $true) { FailGuest 'campaign dry-run did not report dry_run:true' }
      if ($dry.campaign_design_id -ne $CampaignDesignId) { FailGuest "campaign design drift: $($dry.campaign_design_id)" }
      if ([int]$dry.planned_sessions -ne 8) { FailGuest "planned_sessions drift: $($dry.planned_sessions)" }
      if ([double]$dry.max_budget_usd -ne [double]$MaxBudgetUsd) { FailGuest "max_budget_usd drift: $($dry.max_budget_usd)" }
      $plan = @($dry.plan)
      if ($plan.Count -ne 8) { FailGuest "dry-run plan length drift: $($plan.Count)" }

      Assert-SequenceEquals ($plan | ForEach-Object { $_.campaign_cell_label }) @('A','B','B','A','B','A','A','B') 'campaign label order'
      Assert-SequenceEquals ($plan | ForEach-Object { $_.execution_profile_id }) @(
        'sandboxed-unrestricted-v1','sandboxed-unrestricted-v1','sandboxed-unrestricted-v1','sandboxed-unrestricted-v1',
        'sandboxed-unrestricted-v1','sandboxed-unrestricted-v1','sandboxed-unrestricted-v1','sandboxed-unrestricted-v1'
      ) 'campaign profile order'
      Assert-SequenceEquals ($plan | ForEach-Object { $_.condition }) @(
        'current-skill','no-skill','no-skill','current-skill','no-skill','current-skill','current-skill','no-skill'
      ) 'campaign condition order'
      Assert-SequenceEquals ($plan | ForEach-Object { $_.product_access_mode }) @(
        'product-assisted','free-baseline-no-product','free-baseline-no-product','product-assisted',
        'free-baseline-no-product','product-assisted','product-assisted','free-baseline-no-product'
      ) 'campaign product-access order'

      $strictCount = @($plan | Where-Object { $_.execution_profile_id -eq 'strict-policy-v1' }).Count
      $unrestricted = @($plan | Where-Object { $_.execution_profile_id -eq 'sandboxed-unrestricted-v1' })
      $unrestrictedHashes = @($unrestricted | ForEach-Object { $_.execution_profile_isolation_attestation_sha256 } | Select-Object -Unique)
      if ($strictCount -ne 0 -or $unrestricted.Count -ne 8) {
        FailGuest "profile count drift: strict=$strictCount unrestricted=$($unrestricted.Count)"
      }
      if ($unrestrictedHashes.Count -ne 1 -or $unrestrictedHashes[0] -ne $validation.sha256) {
        FailGuest 'dry-run attestation hash does not match the fresh attestation'
      }

      $attestationPathLeaked = $dryText.Contains($AttestationFile)
      $attestationContentLeaked = $dryText.Contains($attestation.campaign_id) -or
        $dryText.Contains($attestation.boundary_kind) -or
        $dryText.Contains($attestation.workspace_scope) -or
        $dryText.Contains((Split-Path -Leaf $AttestationFile))
      $attestationTimestampsLeaked = $dryText.Contains($attestation.created_at) -or $dryText.Contains($attestation.expires_at)
      if ($attestationPathLeaked -or $attestationContentLeaked -or $attestationTimestampsLeaked) {
        FailGuest 'campaign dry-run leaked attestation path/content/timestamp'
      }

      $stderrBytes = if (Test-Path -LiteralPath $dryStderr) { (Get-Item -LiteralPath $dryStderr).Length } else { 0 }
      if ($stderrBytes -ne 0) {
        FailGuest "campaign dry-run wrote unexpected stderr bytes: $stderrBytes"
      }

      $ledger = [ordered]@{
        verdict = 'PASS'
        generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        operator_confirmation = [ordered]@{
          boundary_kind = 'dedicated-ephemeral-runner'
          workspace = 'campaign-only'
          credentials = 'runtime-only'
          network = 'restricted'
          normal_home_mounted = $false
          ambient_secrets_present = $false
          disposable_home = $true
          rollback_or_destroy_required = $true
          supplied_in_session = $true
        }
        anchors = [ordered]@{
          harness_commit_actual = $head
          harness_commit_expected = $TargetCommit
          harness_tree_actual = $tree
          harness_tree_expected = $TargetTree
          source_commit_actual = $sourceHead
          source_commit_expected = $SourceCommit
        }
        tools = [ordered]@{
          git = $gitVersion
          node = $nodeVersion
          npm = (& npm.cmd --version).Trim()
          java_present = $true
          claude = $claudeVersion
          claude_logged_in = $true
        }
        network = $network
        r5_attestation = [ordered]@{
          ok = $true
          schema = 1
          attestation_sha256 = [string]$validation.sha256
          size_bytes = [int64]$attestationBytes.Length
          content_recorded = $false
          path_recorded = $false
        }
        R7_campaign_dry_run = [ordered]@{
          pass_dry_run = [ordered]@{
            campaign_design_id = $CampaignDesignId
            planned_sessions = 8
            plan_length = 8
            strict_cell_count = 0
            unrestricted_cell_count = 8
            strict_cells_with_attestation_hash = 0
            unrestricted_cells_with_attestation_hash = 8
            distinct_attestation_hashes_among_unrestricted = 1
            attestation_hash_matches_fresh_attestation = $true
            attestation_path_leaked_in_output = $false
            attestation_content_leaked_in_output = $false
            attestation_timestamps_leaked_in_output = $false
            label_order = @('A','B','B','A','B','A','A','B')
            profile_order = @(
              'sandboxed-unrestricted-v1','sandboxed-unrestricted-v1','sandboxed-unrestricted-v1','sandboxed-unrestricted-v1',
              'sandboxed-unrestricted-v1','sandboxed-unrestricted-v1','sandboxed-unrestricted-v1','sandboxed-unrestricted-v1'
            )
            condition_order = @('current-skill','no-skill','no-skill','current-skill','no-skill','current-skill','current-skill','no-skill')
            product_access_order = @(
              'product-assisted','free-baseline-no-product','free-baseline-no-product','product-assisted',
              'free-baseline-no-product','product-assisted','product-assisted','free-baseline-no-product'
            )
            max_budget_usd = $MaxBudgetUsd
            output_sha256_lf_normalized = $dryHashLf
            stdout_sha256 = $dryHashRaw
            stdout_size_bytes = [int64]([System.IO.File]::ReadAllBytes($dryStdout).Length)
          }
        }
        zero_live_confirmation = [ordered]@{
          no_non_dry_run_command_executed_by_readiness = $true
          no_calibrate_or_smoke = $true
          raw_transcript_content_read = $false
          stderr_content_read = $false
        }
      }
      $sourcePostflightAttempted = $true
      $null = Assert-E1SourcePostflight $NowInAndroidDir $SourceCommit $sourceSnapshot.tree $ScratchDir $sourceSnapshot -Operation 'dry-v3'
      $ledgerPath = Join-Path $ScratchDir 'READINESS.json'
      Write-Utf8NoBom $ledgerPath ($ledger | ConvertTo-Json -Depth 12)
      Remove-Item -LiteralPath $dryStdout,$dryStderr -Force -ErrorAction SilentlyContinue

      return [ordered]@{
        verdict = 'PASS'
        generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        harness_head = $head
        harness_tree = $tree
        source_head = $sourceHead
        attestation_sha256 = [string]$validation.sha256
        attestation_size_bytes = [int64]$attestationBytes.Length
        dry_run_stdout_sha256_lf_normalized = $dryHashLf
        planned_sessions = 8
        network = $network
        tools = [ordered]@{
          node = $nodeVersion
          git = $gitVersion
          claude = $claudeVersion
          java_present = $true
        }
        ledger_path = $ledgerPath
        attestation_path = $AttestationFile
        privacy = [ordered]@{
          attestation_content_printed = $false
          dry_run_stdout_printed = $false
          raw_transcript_content_read = $false
          stderr_content_read = $false
        }
      }
    } catch {
      $readinessFailure = $_
      if ($null -ne $sourceSnapshot -and -not $sourcePostflightAttempted) {
        try {
          $null = Assert-E1SourcePostflight $NowInAndroidDir $SourceCommit $sourceSnapshot.tree $ScratchDir $sourceSnapshot -Operation 'dry-v3'
        } catch {
          # Preserve the primary error and retain only a bounded custody code.
          $readinessFailure.Exception.Data['source_postflight_failure'] = Get-E1FailureCode $_ 'postflight_failed'
        }
      }
      throw $readinessFailure
    } finally {
      Pop-Location
    }
  } -ArgumentList $HarnessDir, $TargetCommit, $TargetTree, $SourceCommit, $NowInAndroidDir, $AttestationFile, $ScratchDir

  $completed = Wait-Job -Job $job -Timeout ($TimeoutMinutes * 60)
  if (-not $completed) {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Fail "timed out regenerating readiness in guest after $TimeoutMinutes minutes"
  }
  $guestReport = Receive-Job -Job $job -ErrorAction Stop

  $report = [ordered]@{
    verdict = 'PASS'
    generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    vm_name = $VMName
    vm_state = (Get-VM -Name $VMName).State.ToString()
    powershell_direct_logon = $workingLogonName
    attempts = $attempts
    target_commit = $TargetCommit
    target_tree = $TargetTree
    guest = $guestReport
    privacy = [ordered]@{
      raw_transcript_content_read = $false
      stderr_content_read = $false
      attestation_content_printed = $false
      dry_run_stdout_printed = $false
    }
  }
  $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
  Write-Host "[hyperv-regenerate-readiness-direct] PASS: $ReportPath"
} finally {
  if ($job) {
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }
  if ($session) {
    Remove-PSSession -Session $session -ErrorAction SilentlyContinue
  }
}

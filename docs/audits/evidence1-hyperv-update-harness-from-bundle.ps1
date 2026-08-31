#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner',
  [string]$GuestComputerName = 'Evidence1Runner',
  [string]$GuestCredentialPath = 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml',
  [string]$SourceRepoDir = '',
  [string]$TargetRef = 'origin/develop',
  [string]$TargetCommit = '',
  [string]$TargetTree = '',
  [switch]$SkipFetch,
  [string]$HarnessDir = 'C:\kmp-eval\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1',
  [string]$GuestOpsDir = 'C:\Evidence1Ops',
  [string]$ReportPath = 'C:\kmp-eval\scratch\hyperv-update-harness-from-bundle\HYPERV-UPDATE-HARNESS-FROM-BUNDLE.json',
  [int]$ProbeTimeoutSeconds = 45
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

function Invoke-Checked([string]$Exe, [string[]]$Arguments, [string]$Step) {
  Write-Host "[hyperv-update-harness] $Step"
  $output = @()
  $exit = $null
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Git writes progress such as "From <remote>" to stderr even on success.
    $ErrorActionPreference = 'Continue'
    $output = @(& $Exe @Arguments 2>&1)
    $exit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($output) {
    $output | ForEach-Object { Write-Host $_ }
  }
  if ($exit -ne 0) {
    Fail "$Step failed with exit code $exit"
  }
}

function Invoke-GitText([string[]]$Arguments, [string]$Step) {
  $output = & git.exe @Arguments 2>&1
  $exit = $LASTEXITCODE
  if ($exit -ne 0) {
    Fail "$Step failed with exit code $exit`: $($output -join ' ')"
  }
  return ($output | Select-Object -First 1).ToString().Trim()
}

if ([string]::IsNullOrWhiteSpace($SourceRepoDir)) {
  $SourceRepoDir = Resolve-FullPath (Join-Path $PSScriptRoot '..\..')
}

Assert-PathInside $GuestCredentialPath 'C:\kmp-eval\scratch\' 'guest credential'
Assert-PathInside $ReportPath 'C:\kmp-eval\scratch\' 'report'
if (-not $HarnessDir.StartsWith('C:\kmp-eval\', [StringComparison]::OrdinalIgnoreCase)) {
  Fail "guest harness dir must stay under C:\kmp-eval: $HarnessDir"
}
if ($GuestOpsDir -ne 'C:\Evidence1Ops') {
  Fail "GuestOpsDir must stay exactly C:\Evidence1Ops"
}
if (-not (Test-Path -LiteralPath $GuestCredentialPath)) {
  Fail "guest credential file does not exist: $GuestCredentialPath"
}
if (-not (Test-Path -LiteralPath $SourceRepoDir)) {
  Fail "source repo does not exist: $SourceRepoDir"
}

$inside = Invoke-GitText @('-C', $SourceRepoDir, 'rev-parse', '--is-inside-work-tree') 'verify source repo'
if ($inside -ne 'true') {
  Fail "source repo is not a git worktree: $SourceRepoDir"
}

if (-not $SkipFetch) {
  Invoke-Checked 'git.exe' @('-C', $SourceRepoDir, 'fetch', 'origin', 'develop', '--prune') 'fetch origin/develop'
}
if ([string]::IsNullOrWhiteSpace($TargetCommit)) {
  $TargetCommit = Invoke-GitText @('-C', $SourceRepoDir, 'rev-parse', '--verify', $TargetRef) "resolve target ref $TargetRef"
}
Invoke-Checked 'git.exe' @('-C', $SourceRepoDir, 'rev-parse', '--verify', $TargetCommit) 'verify target commit exists locally'
$resolvedTargetCommit = Invoke-GitText @('-C', $SourceRepoDir, 'rev-parse', '--verify', $TargetCommit) 'resolve target commit'
if ($resolvedTargetCommit -ne $TargetCommit) {
  $TargetCommit = $resolvedTargetCommit
}
$resolvedTargetTree = Invoke-GitText @('-C', $SourceRepoDir, 'rev-parse', "$TargetCommit^{tree}") 'resolve target tree'
if ([string]::IsNullOrWhiteSpace($TargetTree)) {
  $TargetTree = $resolvedTargetTree
} elseif ($TargetTree -ne $resolvedTargetTree) {
  Fail "target tree mismatch: expected $TargetTree, got $resolvedTargetTree"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath) | Out-Null
$short = $TargetCommit.Substring(0, 12)
$exportRef = "refs/evidence1/export/$short"
$bundlePath = Join-Path (Split-Path -Parent $ReportPath) "harness-$short.bundle"
Remove-Item -LiteralPath $bundlePath -Force -ErrorAction SilentlyContinue

try {
  Invoke-Checked 'git.exe' @('-C', $SourceRepoDir, 'update-ref', $exportRef, $TargetCommit) 'create temporary export ref'
  Invoke-Checked 'git.exe' @('-C', $SourceRepoDir, 'bundle', 'create', $bundlePath, $exportRef) 'create git bundle for target commit'
} finally {
  & git.exe -C $SourceRepoDir update-ref -d $exportRef 2>$null
}
$bundleHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $bundlePath).Hash.ToLowerInvariant()
$bundleBytes = (Get-Item -LiteralPath $bundlePath).Length

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ($vm.State -ne 'Running') {
  Write-Host "[hyperv-update-harness] starting $VMName from state $($vm.State)"
  Start-VM -Name $VMName
  Start-Sleep -Seconds 5
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
  $attempts | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
  Fail "could not establish PowerShell Direct session to $VMName"
}

try {
  Invoke-Command -Session $session -ScriptBlock {
    param($GuestOpsDir)
    New-Item -ItemType Directory -Force -Path $GuestOpsDir | Out-Null
  } -ArgumentList $GuestOpsDir

  $guestBundlePath = Join-Path $GuestOpsDir (Split-Path -Leaf $bundlePath)
  Copy-Item -ToSession $session -LiteralPath $bundlePath -Destination $guestBundlePath -Force

  $guestReport = Invoke-Command -Session $session -ScriptBlock {
    param($HarnessDir, $TargetCommit, $TargetTree, $GuestBundlePath, $ExportRef)

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    function FailGuest($Message) {
      throw "HARD STOP: $Message"
    }

    function Assert-GuestHarnessTrackedCustody([string]$Root) {
      # Untracked finalized artifacts have their own archival policy below.
      # Never let checkout/restore erase edits or trust concealed index entries.
      $flags = @(& git.exe -C $Root ls-files -v)
      if ($LASTEXITCODE -ne 0) { throw 'HARD STOP: harness index inspection failed' }
      if (@($flags | Where-Object { $_ -cnotmatch '^H ' }).Count -gt 0) {
        throw 'HARD STOP: harness index contains concealed or unsupported entries'
      }
      $tracked = @(& git.exe -C $Root status --porcelain=v1 --untracked-files=no)
      if ($LASTEXITCODE -ne 0) { throw 'HARD STOP: harness tracked status inspection failed' }
      if ($tracked.Count -gt 0) { throw 'HARD STOP: harness has tracked changes; nothing restored' }
    }

    $env:Path = @(
      'C:\Program Files\Git\cmd',
      'C:\Program Files\Git\bin',
      'C:\Program Files\nodejs',
      (Join-Path $env:USERPROFILE 'AppData\Roaming\npm'),
      $env:Path
    ) -join ';'

    if (-not (Test-Path -LiteralPath $GuestBundlePath)) {
      FailGuest "bundle missing in guest: $GuestBundlePath"
    }

    $rebuiltHarness = $false
    $archivedInvalidHarness = $null
    if (Test-Path -LiteralPath $HarnessDir) {
      $previousErrorActionPreference = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        $repoProbeOutput = & git.exe -C $HarnessDir rev-parse --is-inside-work-tree 2>&1
        $repoProbeExit = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousErrorActionPreference
      }
      if ($repoProbeExit -ne 0) {
        $archiveRoot = Join-Path 'C:\kmp-eval\scratch\invalid-harness-checkouts' (Get-Date -Format 'yyyyMMdd-HHmmss')
        New-Item -ItemType Directory -Force -Path $archiveRoot | Out-Null
        $archivePath = Join-Path $archiveRoot 'harness-worktree'
        Move-Item -LiteralPath $HarnessDir -Destination $archivePath -Force
        $archivedInvalidHarness = [ordered]@{
          source = $HarnessDir
          destination = $archivePath
          reason = "git rev-parse --is-inside-work-tree failed: $($repoProbeOutput -join ' ')"
          content_read = $false
        }
        New-Item -ItemType Directory -Force -Path $HarnessDir | Out-Null
        $rebuiltHarness = $true
      }
    } else {
      New-Item -ItemType Directory -Force -Path $HarnessDir | Out-Null
      $rebuiltHarness = $true
    }

    if ($rebuiltHarness) {
      $initOutput = & git.exe -C $HarnessDir init 2>&1
      if ($LASTEXITCODE -ne 0) { FailGuest "git init rebuilt harness failed: $($initOutput -join ' ')" }
      $remoteOutput = & git.exe -C $HarnessDir remote add origin 'https://github.com/oscardlfr/kmp-test-runner.git' 2>&1
      if ($LASTEXITCODE -ne 0) { FailGuest "git remote add rebuilt harness failed: $($remoteOutput -join ' ')" }
    }

    Push-Location $HarnessDir
    try {
      Assert-GuestHarnessTrackedCustody $HarnessDir
      $previousErrorActionPreference = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        $fetchOutput = & git.exe fetch --force $GuestBundlePath "$ExportRef`:refs/evidence1/target" 2>&1
        $fetchExit = $LASTEXITCODE
        $checkoutOutput = & git.exe checkout --detach $TargetCommit 2>&1
        $checkoutExit = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousErrorActionPreference
      }
      if ($fetchExit -ne 0) { FailGuest "git fetch bundle failed: $($fetchOutput -join ' ')" }
      if ($checkoutExit -ne 0) { FailGuest "git checkout target commit failed: $($checkoutOutput -join ' ')" }
      $head = (& git.exe rev-parse HEAD).Trim()
      $tree = (& git.exe rev-parse 'HEAD^{tree}').Trim()
      $archivedUntracked = @()
      $archivedUntrackedScenarioFiles = 0
      $status = (& git.exe status --short)
      if ($status) {
        $statusLines = @($status | ForEach-Object { [string]$_ })
        $allowedPrefixes = @(
          '?? tools/runs/agentic-eval-journal/',
          '?? tools/runs/agentic-eval-incident/',
          '?? tools/runs/agentic-eval-rejected/',
          '?? tools/runs/agentic-eval-scenario/'
        )
        $unexpected = @($statusLines | Where-Object {
          $line = $_
          -not (@($allowedPrefixes | Where-Object { $line.StartsWith($_, [StringComparison]::Ordinal) }).Count -gt 0)
        })
        if ($unexpected.Count -gt 0) {
          FailGuest "worktree not clean outside preservable tools/runs artifacts: $($unexpected -join '; ')"
        }

        $archiveRoot = Join-Path 'C:\kmp-eval\scratch\pre-harness-update-artifacts' (Get-Date -Format 'yyyyMMdd-HHmmss')
        New-Item -ItemType Directory -Force -Path $archiveRoot | Out-Null
        foreach ($relativeDir in @(
          'tools\runs\agentic-eval-journal',
          'tools\runs\agentic-eval-incident',
          'tools\runs\agentic-eval-rejected'
        )) {
          $sourcePath = Join-Path $HarnessDir $relativeDir
          if (Test-Path -LiteralPath $sourcePath) {
            $destinationPath = Join-Path $archiveRoot ($relativeDir -replace '\\','_')
            Move-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
            $archivedUntracked += [ordered]@{
              source = $sourcePath
              destination = $destinationPath
              content_read = $false
            }
          }
        }

        # This directory also contains tracked corpus fixtures. Archive only the
        # untracked finalized records rather than moving the directory wholesale.
        $scenarioArtifactRoot = 'tools/runs/agentic-eval-scenario/'
        $scenarioUntrackedOutput = @(& git.exe ls-files --others --exclude-standard -- 'tools/runs/agentic-eval-scenario')
        if ($LASTEXITCODE -ne 0) {
          FailGuest 'git ls-files for finalized scenario artifacts failed'
        }
        $scenarioUntracked = @($scenarioUntrackedOutput | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
        $scenarioArchiveRoot = Join-Path $archiveRoot 'tools_runs_agentic-eval-scenario'
        foreach ($relativeFile in $scenarioUntracked) {
          if (-not $relativeFile.StartsWith($scenarioArtifactRoot, [StringComparison]::Ordinal)) {
            FailGuest "unexpected untracked scenario artifact path: $relativeFile"
          }
          $relativeWithinScenario = $relativeFile.Substring($scenarioArtifactRoot.Length)
          if ([string]::IsNullOrWhiteSpace($relativeWithinScenario)) {
            FailGuest "empty relative scenario artifact path: $relativeFile"
          }
          $sourcePath = Join-Path $HarnessDir ($relativeFile -replace '/', '\')
          if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            FailGuest "untracked scenario artifact is not a file: $relativeFile"
          }
          $destinationPath = Join-Path $scenarioArchiveRoot ($relativeWithinScenario -replace '/', '\')
          New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destinationPath) | Out-Null
          Move-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
          $archivedUntracked += [ordered]@{
            source = $sourcePath
            destination = $destinationPath
            content_read = $false
          }
          $archivedUntrackedScenarioFiles++
        }
        $status = (& git.exe status --short)
      }
      if ($head -ne $TargetCommit) { FailGuest "HEAD mismatch: $head" }
      if ($tree -ne $TargetTree) { FailGuest "tree mismatch: $tree" }
      if ($status) { FailGuest "worktree not clean: $status" }
      $nodeVersion = (& node.exe --version).Trim()
      $claudeVersion = (& claude.cmd --version).Trim()
      [ordered]@{
        ok = $true
        harness_dir = $HarnessDir
        head = $head
        tree = $tree
        rebuilt_harness = $rebuiltHarness
        archived_invalid_harness = $archivedInvalidHarness
        status_short = $status
        archived_untracked_paths = $archivedUntracked
        archived_untracked_scenario_files = $archivedUntrackedScenarioFiles
        node_version = $nodeVersion
        claude_version = $claudeVersion
      }
    } finally {
      Pop-Location
    }
  } -ArgumentList $HarnessDir, $TargetCommit, $TargetTree, $guestBundlePath, $exportRef

  $report = [ordered]@{
    verdict = 'PASS'
    generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    vm_name = $VMName
    vm_state = [string](Get-VM -Name $VMName).State
    powershell_direct_logon = $workingLogonName
    attempts = $attempts
    source_repo_dir = Resolve-FullPath $SourceRepoDir
    target_ref = $TargetRef
    target_commit = $TargetCommit
    target_tree = $TargetTree
    bundle_path = $bundlePath
    bundle_sha256 = $bundleHash
    bundle_bytes = $bundleBytes
    guest_bundle_path = $guestBundlePath
    guest = $guestReport
  }
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
  Write-Host "[hyperv-update-harness] PASS: $ReportPath"
} finally {
  if ($session) {
    Remove-PSSession -Session $session -ErrorAction SilentlyContinue
  }
}

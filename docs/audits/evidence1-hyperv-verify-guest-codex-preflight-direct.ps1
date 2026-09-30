#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner',
  [string]$GuestComputerName = 'Evidence1Runner',
  [string]$GuestCredentialPath = 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml',
  [string]$ProfilePath = '',
  [string]$CreatedInspectionReceiptPath = '',
  [string]$HarnessDir = 'C:\kmp-eval\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1',
  [Parameter(Mandatory = $true)]
  [string]$ExpectedTargetCommit,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedTargetTree,
  [string]$HostReportPath = 'C:\kmp-eval\scratch\hyperv-verify-guest-codex-preflight-direct\HYPERV-VERIFY-GUEST-CODEX-PREFLIGHT-DIRECT.json',
  [bool]$RequireCanonicalToolchain = $true,
  [int]$ProbeTimeoutSeconds = 240
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

if ($ExpectedTargetCommit -notmatch '^[0-9a-f]{40}$') {
  Fail 'ExpectedTargetCommit must be a lowercase 40-character Git object id'
}
if ($ExpectedTargetTree -notmatch '^[0-9a-f]{40}$') {
  Fail 'ExpectedTargetTree must be a lowercase 40-character Git object id'
}
Assert-PathInside $GuestCredentialPath 'C:\kmp-eval\scratch\' 'guest credential'
Assert-PathInside $HostReportPath 'C:\kmp-eval\scratch\' 'host report'
Assert-PathInside $HarnessDir 'C:\kmp-eval\' 'guest harness'
$hasProfile = -not [string]::IsNullOrWhiteSpace($ProfilePath)
$hasCreatedReceipt = -not [string]::IsNullOrWhiteSpace($CreatedInspectionReceiptPath)
if ($hasProfile -xor $hasCreatedReceipt) {
  Fail 'canonical profile and created-inspection receipt must be supplied together'
}
$canonicalIdentity = $null
if ($hasProfile) {
  Assert-PathInside $ProfilePath $PSScriptRoot 'canonical profile'
  Assert-PathInside $CreatedInspectionReceiptPath 'C:\kmp-eval\scratch\' 'created-inspection receipt'
  Import-Module (Join-Path $PSScriptRoot 'evidence1-vm-identity-contract.psm1') -Force -DisableNameChecking
  $canonicalIdentity = Get-Evidence1CanonicalE2EVmIdentity -ProfilePath $ProfilePath `
    -CreatedInspectionReceiptPath $CreatedInspectionReceiptPath -GuestCredentialPath $GuestCredentialPath
  $VMName = $canonicalIdentity.vm_name
  $GuestComputerName = $canonicalIdentity.guest_computer_name
} else {
  if ($VMName -cne 'Evidence1-Runner') {
    Fail 'VMName must stay exactly Evidence1-Runner without a canonical profile'
  }
  if ($GuestComputerName -cne 'Evidence1Runner') {
    Fail 'GuestComputerName must stay exactly Evidence1Runner without a canonical profile'
  }
}
if (-not (Test-Path -LiteralPath $GuestCredentialPath)) {
  Fail "guest credential file does not exist: $GuestCredentialPath"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $HostReportPath) | Out-Null

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ($canonicalIdentity -and ([string]$vm.Id).ToLowerInvariant() -cne $canonicalIdentity.vm_id) {
  Fail 'E2E VM id mismatch'
}
if ($vm.State -ne 'Running') {
  Fail "$VMName must be running for the offline Codex preflight"
}

$storedCredential = Import-Clixml -LiteralPath $GuestCredentialPath
$simpleUser = $storedCredential.UserName
if ($simpleUser -match '[\\@]') {
  Fail 'stored guest user must be a simple local account name'
}
$candidates = if ($canonicalIdentity) {
  @("$GuestComputerName\$simpleUser")
} else {
  @(
    "$GuestComputerName\$simpleUser",
    "$VMName\$simpleUser",
    ".\$simpleUser",
    $simpleUser,
    "localhost\$simpleUser"
  )
}

$attemptCount = 0
$probe = $null
foreach ($logonName in $candidates) {
  $attemptCount++
  $job = Start-Job -ScriptBlock {
    param($VmName, $UserName, $SecurePassword, $HarnessDir, $ExpectedTargetCommit, $ExpectedTargetTree, $RequireCanonicalToolchain)
    $credential = [pscredential]::new($UserName, $SecurePassword)
    Invoke-Command -VMName $VmName -Credential $credential -ScriptBlock {
      param($HarnessDir, $ExpectedTargetCommit, $ExpectedTargetTree, $RequireCanonicalToolchain)
      $ErrorActionPreference = 'Stop'
      $npmPrefix = Join-Path $env:USERPROFILE 'AppData\Roaming\npm'
      $canonicalCodexRoot = 'C:\Evidence1Toolchain\codex-cli\0.154.0'
      $canonicalGitBash = 'C:\Evidence1Toolchain\git-bash\2.55.0.windows.5\bin\bash.exe'
$canonicalCodex = Join-Path $canonicalCodexRoot 'bin\codex.exe'
      $canonicalMarker = Join-Path $canonicalCodexRoot '.evidence1-artifact.json'
      $env:Path = @(
        $canonicalCodexRoot,
        'C:\Evidence1Toolchain\node\24.19.0',
        'C:\Evidence1Toolchain\git-bash\2.55.0.windows.5\cmd',
        'C:\Evidence1Toolchain\git-bash\2.55.0.windows.5\bin',
        'C:\Evidence1Toolchain\git\2.55.0.windows.5\cmd',
        'C:\Evidence1Toolchain\git\2.55.0.windows.5\bin',
        $npmPrefix,
        'C:\Program Files\nodejs',
        'C:\Program Files\Git\cmd',
        'C:\Program Files\Git\bin',
        $env:Path
      ) -join ';'
      if (-not (Test-Path -LiteralPath $canonicalGitBash -PathType Leaf)) { throw 'git_bash_canonical_toolchain_required' }
      $env:KMP_EVAL_BASH_PATH = $canonicalGitBash
      $env:CODEX_HOME = 'C:\Evidence1RuntimeState\codex'
      $env:KMP_EVAL_CODEX_HOME = 'C:\Evidence1RuntimeState\codex'
      $env:KMP_EVAL_CODEX_RUNTIME_ROOT = 'C:\Evidence1RuntimeState'

      $reasonCode = $null
      $codexVersion = $null
      $authOk = $false
      $head = $null
      $tree = $null
      $harnessClean = $false
      $offline = $null
      $secretOverrideCount = 0
      $canonicalToolchain = $false
      $artifactSha256 = $null
      try {
        if (-not (Test-Path -LiteralPath $HarnessDir)) { throw 'guest_harness_missing' }
        $git = Get-Command git.exe -ErrorAction Stop
        $node = Get-Command node.exe -ErrorAction Stop
        if (Test-Path -LiteralPath $canonicalMarker -PathType Leaf) {
          $marker = Get-Content -LiteralPath $canonicalMarker -Raw | ConvertFrom-Json -ErrorAction Stop
          if ($marker.id -cne 'codex-cli' -or $marker.version -cne '0.154.0' -or
              [string]$marker.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $marker.bytes -lt 1 -or
              -not (Test-Path -LiteralPath $canonicalCodex -PathType Leaf)) { throw 'codex_canonical_marker_invalid' }
          $artifactSha256 = (Get-FileHash -LiteralPath $canonicalCodex -Algorithm SHA256).Hash.ToLowerInvariant()
          if ($artifactSha256 -cne [string]$marker.sha256 -or (Get-Item -LiteralPath $canonicalCodex).Length -ne $marker.bytes) {
            throw 'codex_canonical_artifact_drift'
          }
          $signature = Get-AuthenticodeSignature -LiteralPath $canonicalCodex -ErrorAction Stop
          if ([string]$signature.Status -cne 'Valid' -or -not $signature.SignerCertificate -or
              [string]$signature.SignerCertificate.Subject -cne 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US') {
            throw 'codex_canonical_signature_invalid'
          }
          $codex = Get-Command $canonicalCodex -ErrorAction Stop
          $canonicalToolchain = $true
        } else {
          if ($RequireCanonicalToolchain) { throw 'codex_canonical_toolchain_required' }
          $codex = Get-Command codex.cmd -ErrorAction SilentlyContinue
          if (-not $codex) { $codex = Get-Command codex.exe -ErrorAction SilentlyContinue }
        }
        if (-not $codex) { throw 'codex_cli_not_installed' }

        $head = [string](& $git.Source -C $HarnessDir rev-parse HEAD 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0) { throw 'guest_harness_commit_unreadable' }
        $tree = [string](& $git.Source -C $HarnessDir rev-parse 'HEAD^{tree}' 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0) { throw 'guest_harness_tree_unreadable' }
        $status = @(& $git.Source -C $HarnessDir status --porcelain --untracked-files=all 2>$null)
        if ($LASTEXITCODE -ne 0) { throw 'guest_harness_status_unreadable' }
        $harnessClean = $status.Count -eq 0
        if ($head.Trim() -cne $ExpectedTargetCommit -or $tree.Trim() -cne $ExpectedTargetTree -or -not $harnessClean) {
          throw 'guest_harness_identity_mismatch'
        }

        $versionOutput = @(& $codex.Source --version 2>$null)
        if ($LASTEXITCODE -ne 0 -or $versionOutput.Count -ne 1) { throw 'codex_version_failed' }
        $codexVersion = ([string]$versionOutput[0]).Trim()
        if ($canonicalToolchain -and $codexVersion -cne 'codex-cli 0.154.0') { throw 'codex_version_mismatch' }
        if (-not $canonicalToolchain -and $codexVersion -notmatch '^codex-cli\s+[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') {
          throw 'codex_version_unrecognized'
        }

        $previousPreference = $ErrorActionPreference
        try {
          $ErrorActionPreference = 'Continue'
          & $codex.Source login status *> $null
          $authOk = $LASTEXITCODE -eq 0
        } finally {
          $ErrorActionPreference = $previousPreference
        }
        if (-not $authOk) { throw 'codex_auth_preflight_failed' }

        $secretOverrideCount = @(
          Get-ChildItem Env: | Where-Object {
            $_.Name -match '^(OPENAI_API_KEY|AZURE_OPENAI_API_KEY|CODEX_API_KEY)$'
          }
        ).Count
        if ($secretOverrideCount -ne 0) { throw 'credential_environment_override_present' }

        $offlineScript = Join-Path $HarnessDir 'tools\agentic-eval\codex-offline-preflight.mjs'
        if (-not (Test-Path -LiteralPath $offlineScript)) { throw 'offline_preflight_missing' }
        $previousPreference = $ErrorActionPreference
        try {
          $ErrorActionPreference = 'Continue'
          $offlineOutput = @(& $node.Source $offlineScript 2>&1)
          $offlineExit = $LASTEXITCODE
        } finally {
          $ErrorActionPreference = $previousPreference
        }
        try {
          $offline = ($offlineOutput -join "`n") | ConvertFrom-Json -ErrorAction Stop
        } catch {
          if ($offlineExit -ne 0) { throw 'offline_preflight_failed' }
          throw 'offline_preflight_invalid_json'
        }
        if ($offlineExit -ne 0) { throw 'offline_preflight_failed' }
        if ($offline.ok -ne $true -or $offline.inference_sessions_consumed -ne 0) {
          throw 'offline_preflight_failed'
        }
      } catch {
        $candidate = [string]$_.Exception.Message
        $closedCodes = @(
          'guest_harness_missing', 'codex_cli_not_installed', 'guest_harness_commit_unreadable',
          'guest_harness_tree_unreadable', 'guest_harness_status_unreadable',
          'guest_harness_identity_mismatch', 'codex_version_failed', 'codex_version_unrecognized',
          'codex_version_mismatch','codex_canonical_toolchain_required','codex_canonical_marker_invalid',
          'codex_canonical_artifact_drift','codex_canonical_signature_invalid',
          'codex_auth_preflight_failed', 'credential_environment_override_present',
          'git_bash_canonical_toolchain_required',
          'offline_preflight_missing', 'offline_preflight_failed', 'offline_preflight_invalid_json'
        )
        $reasonCode = if ($candidate -cin $closedCodes) { $candidate } else { 'guest_codex_preflight_failed' }
      }

      $passed = $null -eq $reasonCode
      [ordered]@{
        verdict = if ($passed) { 'PASS' } else { 'FAIL' }
        reason_code = $reasonCode
        generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        runtime_id = 'codex-cli'
        cli_version = $codexVersion
        canonical_toolchain = $canonicalToolchain
        artifact_sha256 = $artifactSha256
        auth_preflight = if ($authOk) { 'pass' } else { 'fail' }
        offline_reason_code = if ($offline) { $offline.reason_code } else { $null }
        harness_commit_matches = $head -eq $ExpectedTargetCommit
        harness_tree_matches = $tree -eq $ExpectedTargetTree
        harness_clean = $harnessClean
        model_requested = if ($offline) { $offline.model_requested } else { $null }
        product_skill_available = if ($offline) { $offline.product_skill_available } else { $null }
        product_snapshot_bound = if ($offline) { $offline.product_snapshot_bound } else { $null }
        baseline_skill_available = if ($offline) { $offline.baseline_skill_available } else { $null }
        ambient_non_target_count = if ($offline) { $offline.ambient_non_target_count } else { $null }
        ambient_equivalent = if ($offline) { $offline.ambient_equivalent } else { $null }
        credential_environment_override_count = $secretOverrideCount
        inference_sessions_consumed = 0
        privacy = [ordered]@{
          codex_auth_material_read = $false
          auth_output_persisted = $false
          auth_output_printed = $false
          raw_cli_output_persisted = $false
          prompt_or_response_content_present = $false
          private_paths_persisted = $false
        }
      }
    } -ArgumentList $HarnessDir, $ExpectedTargetCommit, $ExpectedTargetTree, $RequireCanonicalToolchain -ErrorAction Stop
  } -ArgumentList $VMName, $logonName, $storedCredential.Password, $HarnessDir, $ExpectedTargetCommit, $ExpectedTargetTree, $RequireCanonicalToolchain

  try {
    $completed = Wait-Job -Job $job -Timeout $ProbeTimeoutSeconds
    if ($completed) {
      $probe = Receive-Job -Job $job -ErrorAction Stop
      break
    }
  } catch {
    $probe = $null
  } finally {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }
}

$sanitizedProbe = if ($probe) {
  [ordered]@{
    verdict = $probe.verdict
    reason_code = $probe.reason_code
    generated_at_utc = $probe.generated_at_utc
    runtime_id = $probe.runtime_id
    cli_version = $probe.cli_version
    canonical_toolchain = $probe.canonical_toolchain
    artifact_sha256 = $probe.artifact_sha256
    auth_preflight = $probe.auth_preflight
    offline_reason_code = $probe.offline_reason_code
    harness_commit_matches = $probe.harness_commit_matches
    harness_tree_matches = $probe.harness_tree_matches
    harness_clean = $probe.harness_clean
    model_requested = $probe.model_requested
    product_skill_available = $probe.product_skill_available
    product_snapshot_bound = $probe.product_snapshot_bound
    baseline_skill_available = $probe.baseline_skill_available
    ambient_non_target_count = $probe.ambient_non_target_count
    ambient_equivalent = $probe.ambient_equivalent
    credential_environment_override_count = $probe.credential_environment_override_count
    inference_sessions_consumed = $probe.inference_sessions_consumed
    privacy = [ordered]@{
      codex_auth_material_read = $probe.privacy.codex_auth_material_read
      auth_output_persisted = $probe.privacy.auth_output_persisted
      auth_output_printed = $probe.privacy.auth_output_printed
      raw_cli_output_persisted = $probe.privacy.raw_cli_output_persisted
      prompt_or_response_content_present = $probe.privacy.prompt_or_response_content_present
      private_paths_persisted = $probe.privacy.private_paths_persisted
    }
  }
} else { $null }
$hostReport = [ordered]@{
  verdict = if ($probe -and $probe.verdict -eq 'PASS') { 'PASS' } else { 'FAIL' }
  reason_code = if ($probe) { $probe.reason_code } else { 'powershell_direct_failed' }
  generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  vm_name = $VMName
  vm_id = if ($canonicalIdentity) { $canonicalIdentity.vm_id } else { ([string]$vm.Id).ToLowerInvariant() }
  vm_state = $vm.State.ToString()
  powershell_direct_attempt_count = $attemptCount
  guest_windows_credential_used_for_powershell_direct = $true
  guest_report = $sanitizedProbe
  privacy = [ordered]@{
    guest_identity_persisted = $false
    guest_windows_credential_value_persisted = $false
    raw_remote_output_persisted = $false
  }
  note = 'Offline-only Codex readiness and skill-catalog isolation proof. It consumes zero inference sessions.'
}
$hostReport | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $HostReportPath -Encoding UTF8
if ($hostReport.verdict -ne 'PASS') {
  Fail "sanitized guest Codex preflight failed; see $HostReportPath"
}
Write-Host "[hyperv-verify-guest-codex-preflight-direct] PASS: $HostReportPath"

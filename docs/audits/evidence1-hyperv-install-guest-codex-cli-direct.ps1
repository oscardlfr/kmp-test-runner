#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner',
  [string]$GuestComputerName = 'Evidence1Runner',
  [string]$GuestCredentialPath = 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml',
  [string]$ExpectedCodexVersion = '0.153.4',
  [string]$HostReportPath = 'C:\kmp-eval\scratch\hyperv-install-guest-codex-cli-direct\HYPERV-INSTALL-GUEST-CODEX-CLI-DIRECT.json',
  [int]$ProbeTimeoutSeconds = 120,
  [string]$AuthorizationPhrase = ''
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

if ($VMName -cne 'Evidence1-Runner') { Fail 'VMName must stay exactly Evidence1-Runner' }
if ($GuestComputerName -cne 'Evidence1Runner') { Fail 'GuestComputerName must stay exactly Evidence1Runner' }
if ($AuthorizationPhrase -cne 'authorize legacy codex migration-only install outside canonical toolchain') {
  Fail 'exact migration-only authorization phrase is required'
}
if ($ExpectedCodexVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') {
  Fail 'ExpectedCodexVersion is invalid'
}
Assert-PathInside $GuestCredentialPath 'C:\kmp-eval\scratch\' 'guest credential'
Assert-PathInside $HostReportPath 'C:\kmp-eval\scratch\' 'host report'
if (-not (Test-Path -LiteralPath $GuestCredentialPath)) { Fail 'guest credential file does not exist' }

$trustedHostRoot = Resolve-FullPath (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin')
$hostCodexPath = $null
$hostVersionText = $null
$commandCandidate = Get-Command codex.exe -ErrorAction SilentlyContinue
$pathCandidates = @()
if ($commandCandidate) { $pathCandidates += $commandCandidate.Source }
if (Test-Path -LiteralPath $trustedHostRoot) {
  $pathCandidates += @(
    Get-ChildItem -LiteralPath $trustedHostRoot -Filter 'codex.exe' -File -Recurse -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty FullName
  )
}
foreach ($candidatePath in @($pathCandidates | Select-Object -Unique)) {
  Assert-PathInside $candidatePath $trustedHostRoot 'host Codex CLI binary'
  $candidateVersion = [string](& $candidatePath --version 2>$null | Select-Object -First 1)
  if ($LASTEXITCODE -eq 0 -and $candidateVersion.Trim() -ceq "codex-cli $ExpectedCodexVersion") {
    $hostCodexPath = $candidatePath
    $hostVersionText = $candidateVersion
    break
  }
}
if (-not $hostCodexPath) { Fail 'matching host Codex CLI binary is not installed in the trusted application directory' }
$hostHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $hostCodexPath).Hash.ToLowerInvariant()
$hostBytes = (Get-Item -LiteralPath $hostCodexPath).Length

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $HostReportPath) | Out-Null
$vm = Get-VM -Name $VMName -ErrorAction Stop
if ($vm.State -ne 'Running') { Fail "$VMName must be running for Codex CLI installation" }
$storedCredential = Import-Clixml -LiteralPath $GuestCredentialPath
$simpleUser = $storedCredential.UserName
if ($simpleUser -match '[\\@]') { Fail 'stored guest user must be a simple local account name' }
$candidates = @(
  "$GuestComputerName\$simpleUser", "$VMName\$simpleUser", ".\$simpleUser", $simpleUser, "localhost\$simpleUser"
)

$attemptCount = 0
$guestReport = $null
foreach ($logonName in $candidates) {
  $attemptCount++
  $session = $null
  try {
    $credential = [pscredential]::new($logonName, $storedCredential.Password)
    $session = New-PSSession -VMName $VMName -Credential $credential -ErrorAction Stop
    $destination = Invoke-Command -Session $session -ScriptBlock {
      $destinationRoot = Join-Path $env:APPDATA 'npm'
      New-Item -ItemType Directory -Force -Path $destinationRoot | Out-Null
      $destinationPath = Join-Path $destinationRoot 'codex.exe'
      if (Test-Path -LiteralPath $destinationPath) {
        throw 'guest_codex_destination_already_exists'
      }
      return $destinationPath
    } -ErrorAction Stop

    $temporaryDestination = "$destination.incoming"
    Copy-Item -LiteralPath $hostCodexPath -Destination $temporaryDestination -ToSession $session -ErrorAction Stop
    $guestReport = Invoke-Command -Session $session -ScriptBlock {
      param($TemporaryDestination, $Destination, $ExpectedCodexVersion, $ExpectedHash, $ExpectedBytes)
      $ErrorActionPreference = 'Stop'
      try {
        $copiedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $TemporaryDestination).Hash.ToLowerInvariant()
        $copiedBytes = (Get-Item -LiteralPath $TemporaryDestination).Length
        if ($copiedHash -cne $ExpectedHash -or $copiedBytes -ne $ExpectedBytes) {
          throw 'guest_codex_binary_integrity_mismatch'
        }
        Move-Item -LiteralPath $TemporaryDestination -Destination $Destination
        $versionText = [string](& $Destination --version 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0 -or $versionText.Trim() -cne "codex-cli $ExpectedCodexVersion") {
          throw 'guest_codex_version_mismatch'
        }
        [ordered]@{
          verdict = 'PASS'
          reason_code = $null
          cli_version = $versionText.Trim()
          binary_sha256 = $copiedHash
          binary_bytes = $copiedBytes
          auth_material_copied = $false
          codex_auth_material_read = $false
          network_used_inside_guest = $false
          inference_sessions_consumed = 0
        }
      } catch {
        Remove-Item -LiteralPath $TemporaryDestination -Force -ErrorAction SilentlyContinue
        $candidate = [string]$_.Exception.Message
        $closedCodes = @('guest_codex_binary_integrity_mismatch', 'guest_codex_version_mismatch')
        [ordered]@{
          verdict = 'FAIL'
          reason_code = if ($candidate -cin $closedCodes) { $candidate } else { 'guest_codex_install_failed' }
          cli_version = $null
          binary_sha256 = $null
          binary_bytes = $null
          auth_material_copied = $false
          codex_auth_material_read = $false
          network_used_inside_guest = $false
          inference_sessions_consumed = 0
        }
      }
    } -ArgumentList $temporaryDestination, $destination, $ExpectedCodexVersion, $hostHash, $hostBytes -ErrorAction Stop
    break
  } catch {
    $guestReport = $null
  } finally {
    if ($session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
  }
}

$sanitizedGuest = if ($guestReport) {
  [ordered]@{
    verdict = $guestReport.verdict
    reason_code = $guestReport.reason_code
    cli_version = $guestReport.cli_version
    binary_sha256 = $guestReport.binary_sha256
    binary_bytes = $guestReport.binary_bytes
    auth_material_copied = $guestReport.auth_material_copied
    codex_auth_material_read = $guestReport.codex_auth_material_read
    network_used_inside_guest = $guestReport.network_used_inside_guest
    inference_sessions_consumed = $guestReport.inference_sessions_consumed
  }
} else { $null }
$report = [ordered]@{
  verdict = if ($guestReport -and $guestReport.verdict -eq 'PASS') { 'PASS' } else { 'FAIL' }
  reason_code = if ($guestReport) { $guestReport.reason_code } else { 'powershell_direct_failed' }
  generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  vm_name = $VMName
  vm_state = $vm.State.ToString()
  powershell_direct_attempt_count = $attemptCount
  source = [ordered]@{
    distribution = 'official-codex-desktop-cli-binary'
    cli_version = $hostVersionText.Trim()
    binary_sha256 = $hostHash
    binary_bytes = $hostBytes
    private_source_path_persisted = $false
  }
  guest_windows_credential_used_for_powershell_direct = $true
  guest_windows_credential_value_persisted = $false
  guest = $sanitizedGuest
  canonical_toolchain = $false
  benchmark_eligible = $false
  migration_only = $true
  note = 'Historical migration-only installer outside C:\Evidence1Toolchain. It never qualifies a VM for benchmark use; use the canonical provisioning bootstrap instead. It does not copy auth state, configuration, credentials, or user data.'
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $HostReportPath -Encoding UTF8
if ($report.verdict -ne 'PASS') { Fail "sanitized guest Codex CLI installation failed; see $HostReportPath" }
Write-Host "[hyperv-install-guest-codex-cli-direct] PASS: $HostReportPath"

#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner',
  [string]$GuestComputerName = 'Evidence1Runner',
  [string]$GuestCredentialPath = 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml',
  [string]$HostReportPath = 'C:\kmp-eval\scratch\hyperv-open-codex-auth-window-direct\HYPERV-OPEN-CODEX-AUTH-WINDOW-DIRECT.json',
  [int]$AuthWindowMinutes = 15,
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
if ($AuthWindowMinutes -lt 5 -or $AuthWindowMinutes -gt 30) { Fail 'AuthWindowMinutes must be between 5 and 30' }
if ($AuthorizationPhrase -cne 'authorize bounded codex authentication egress for canonical toolchain') {
  Fail 'exact Codex authentication-egress authorization phrase is required'
}
Assert-PathInside $GuestCredentialPath 'C:\kmp-eval\scratch\' 'guest credential'
Assert-PathInside $HostReportPath 'C:\kmp-eval\scratch\' 'host report'
if (-not (Test-Path -LiteralPath $GuestCredentialPath)) { Fail 'guest credential file does not exist' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $HostReportPath) | Out-Null

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ($vm.State -ne 'Running') { Fail "$VMName must be running for Codex device authentication" }
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
    $guestReport = Invoke-Command -Session $session -ScriptBlock {
      param($AuthWindowMinutes)
      $ErrorActionPreference = 'Stop'
      $failureCode = 'guest_operation_failed'
      try {
        $failureCode = 'canonical_toolchain_required'
        $markerPath = 'C:\Evidence1Toolchain\toolchain-marker.json'
        $codexRoot = 'C:\Evidence1Toolchain\codex-cli\0.154.0'
    $codexPath = Join-Path $codexRoot 'bin\codex.exe'
        $codexStateRoot = 'C:\Evidence1RuntimeState\codex'
        if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
            -not (Test-Path -LiteralPath $codexPath -PathType Leaf) -or
            -not (Test-Path -LiteralPath $codexStateRoot -PathType Container)) {
          throw 'canonical_toolchain_required'
        }
        $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
        $runtime = @($marker.runtimes | Where-Object { $_.id -ceq 'codex-cli' })
        if ($runtime.Count -ne 1 -or $runtime[0].version -cne '0.154.0' -or
            $runtime[0].install_root -cne $codexRoot -or
            $runtime[0].command_path -cne $codexPath) {
          throw 'canonical_toolchain_required'
        }
        $codexHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $codexPath).Hash.ToLowerInvariant()
        $codexBytes = (Get-Item -LiteralPath $codexPath).Length
        if ($runtime[0].command_sha256 -cne $codexHash -or [long]$runtime[0].command_bytes -ne $codexBytes) {
          throw 'canonical_toolchain_integrity_mismatch'
        }
        $signature = Get-AuthenticodeSignature -LiteralPath $codexPath
        if ($signature.Status.ToString() -cne 'Valid' -or
            $signature.SignerCertificate.Subject -notmatch 'OpenAI') {
          throw 'canonical_toolchain_signature_invalid'
        }
        $versionText = [string](& $codexPath --version 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0 -or $versionText.Trim() -cne 'codex-cli 0.154.0') {
          throw 'canonical_toolchain_version_mismatch'
        }
        $env:CODEX_HOME = $codexStateRoot

        $failureCode = 'watchdog_setup_failed'
        $watchdogTaskName = 'Evidence1CodexAuthEgressExpiry'
        Unregister-ScheduledTask -TaskName $watchdogTaskName -Confirm:$false -ErrorAction SilentlyContinue
        $emergencyCommand = @'
$ErrorActionPreference = 'Stop'
Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Block
$profiles = @(Get-NetFirewallProfile -Profile Domain,Private,Public)
$invalid = @($profiles | Where-Object {
  $_.Enabled.ToString() -ne 'True' -or $_.DefaultOutboundAction.ToString() -ne 'Block'
}).Count
if ($profiles.Count -ne 3 -or $invalid -ne 0) { exit 1 }
'@
        $encodedEmergencyCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($emergencyCommand))
        $watchdogAction = New-ScheduledTaskAction `
          -Execute 'powershell.exe' `
          -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encodedEmergencyCommand"
        $watchdogTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes($AuthWindowMinutes))
        $watchdogPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        $watchdogSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
        Register-ScheduledTask -TaskName $watchdogTaskName -Action $watchdogAction -Trigger $watchdogTrigger `
          -Principal $watchdogPrincipal -Settings $watchdogSettings -Force | Out-Null
        $watchdog = Get-ScheduledTask -TaskName $watchdogTaskName -ErrorAction Stop
        if ($watchdog.State.ToString() -notin @('Ready', 'Running')) { throw 'watchdog_setup_failed' }

        $failureCode = 'firewall_open_failed'
        Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True `
          -DefaultInboundAction Block -DefaultOutboundAction Allow
        $profiles = @(Get-NetFirewallProfile -Profile Domain,Private,Public)
        $openCount = @($profiles | Where-Object {
          $_.Enabled.ToString() -eq 'True' -and $_.DefaultOutboundAction.ToString() -eq 'Allow'
        }).Count
        if ($profiles.Count -ne 3 -or $openCount -ne 3) { throw 'firewall_open_failed' }

        $failureCode = 'codex_auth_endpoint_unreachable'
        $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
        if (-not (Test-Path -LiteralPath $curl)) { throw 'codex_auth_endpoint_unreachable' }
        $previousPreference = $ErrorActionPreference
        try {
          $ErrorActionPreference = 'Continue'
          & $curl -IsS --max-time 12 'https://auth.openai.com' *> $null
          $curlExit = $LASTEXITCODE
        } finally {
          $ErrorActionPreference = $previousPreference
        }
        if ($curlExit -ne 0) { throw 'codex_auth_endpoint_unreachable' }

        [ordered]@{
          verdict = 'PASS'
          reason_code = $null
          outbound_allow_profile_count = $openCount
          auth_endpoint_reachable = $true
          watchdog_armed = $true
          watchdog_window_minutes = $AuthWindowMinutes
          temporary_auth_window = $true
          must_reseal_before_readiness_or_live = $true
          codex_auth_material_read = $false
          network_response_content_persisted = $false
          inference_sessions_consumed = 0
          canonical_toolchain = $true
          codex_cli_version = $versionText.Trim()
        }
      } catch {
        $closedFailureCode = $failureCode
        $failClosed = $false
        try {
          Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True `
            -DefaultInboundAction Block -DefaultOutboundAction Block -ErrorAction Stop
          $profiles = @(Get-NetFirewallProfile -Profile Domain,Private,Public)
          $failClosed = $profiles.Count -eq 3 -and @($profiles | Where-Object {
            $_.Enabled.ToString() -ne 'True' -or $_.DefaultOutboundAction.ToString() -ne 'Block'
          }).Count -eq 0
        } catch {
          $failClosed = $false
        }
        [ordered]@{
          verdict = 'FAIL'
          reason_code = if ($failClosed) { $closedFailureCode } else { 'fail_closed_cleanup_failed' }
          outbound_allow_profile_count = 0
          auth_endpoint_reachable = $false
          watchdog_armed = $false
          watchdog_window_minutes = $AuthWindowMinutes
          temporary_auth_window = $false
          must_reseal_before_readiness_or_live = $true
          codex_auth_material_read = $false
          network_response_content_persisted = $false
          inference_sessions_consumed = 0
          canonical_toolchain = $false
          codex_cli_version = $null
        }
      }
    } -ArgumentList $AuthWindowMinutes -ErrorAction Stop
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
    outbound_allow_profile_count = $guestReport.outbound_allow_profile_count
    auth_endpoint_reachable = $guestReport.auth_endpoint_reachable
    watchdog_armed = $guestReport.watchdog_armed
    watchdog_window_minutes = $guestReport.watchdog_window_minutes
    temporary_auth_window = $guestReport.temporary_auth_window
    must_reseal_before_readiness_or_live = $guestReport.must_reseal_before_readiness_or_live
    codex_auth_material_read = $guestReport.codex_auth_material_read
    network_response_content_persisted = $guestReport.network_response_content_persisted
    inference_sessions_consumed = $guestReport.inference_sessions_consumed
    canonical_toolchain = $guestReport.canonical_toolchain
    codex_cli_version = $guestReport.codex_cli_version
  }
} else { $null }
$report = [ordered]@{
  verdict = if ($guestReport -and $guestReport.verdict -eq 'PASS') { 'PASS' } else { 'FAIL' }
  reason_code = if ($guestReport) { $guestReport.reason_code } else { 'powershell_direct_failed' }
  generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  vm_name = $VMName
  vm_state = $vm.State.ToString()
  powershell_direct_attempt_count = $attemptCount
  guest_windows_credential_used_for_powershell_direct = $true
  guest_windows_credential_value_persisted = $false
  guest = $sanitizedGuest
  note = 'Temporary Codex device-auth egress for the verified canonical toolchain, with an automatic fail-closed watchdog. No auth or response content is read or persisted.'
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $HostReportPath -Encoding UTF8
if ($report.verdict -ne 'PASS') { Fail "temporary Codex auth window failed; see $HostReportPath" }
Write-Host "[hyperv-open-codex-auth-window-direct] PASS: $HostReportPath"

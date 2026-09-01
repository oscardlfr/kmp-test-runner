#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner',
  [string]$GuestComputerName = 'Evidence1Runner',
  [string]$GuestCredentialPath = 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml',
  [string]$HostReportPath = 'C:\kmp-eval\scratch\hyperv-temporary-auth-egress\HYPERV-TEMPORARY-AUTH-EGRESS.json',
  [int]$AuthWindowMinutes = 15,
  [int]$ProbeTimeoutSeconds = 45
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$AuthProbeHosts = @(
  'claude.com',
  'accounts.google.com',
  'oauth2.googleapis.com'
)

function Fail([string]$Message) {
  Write-Error "HARD STOP: $Message"
  exit 1
}

function Resolve-FullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-PathInside([string]$Candidate, [string]$Root, [string]$Label) {
  $candidateFull = Resolve-FullPath $Candidate
  $rootFull = (Resolve-FullPath $Root).TrimEnd('\') + '\'
  if (-not $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "$Label path is outside expected root: $candidateFull"
  }
}

Assert-PathInside $GuestCredentialPath 'C:\kmp-eval\scratch\' 'guest credential'
Assert-PathInside $HostReportPath 'C:\kmp-eval\scratch\' 'host report'
if ($VMName -cne 'Evidence1-Runner') {
  Fail 'VMName is fixed to the dedicated Evidence1 runner'
}
if ($GuestComputerName -cne 'Evidence1Runner') {
  Fail 'GuestComputerName is fixed to the dedicated Evidence1 guest'
}
if ($GuestCredentialPath -cne 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml') {
  Fail 'guest credential path is fixed to the dedicated Evidence1 credential'
}
if (-not (Test-Path -LiteralPath $GuestCredentialPath -PathType Leaf)) {
  Fail "guest credential file does not exist: $GuestCredentialPath"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $HostReportPath) | Out-Null
if ($AuthWindowMinutes -lt 5 -or $AuthWindowMinutes -gt 30) {
  Fail 'AuthWindowMinutes must be between 5 and 30'
}

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ($vm.State -ne 'Running') {
  Fail "$VMName must be running for temporary auth egress"
}

$storedCredential = Import-Clixml -LiteralPath $GuestCredentialPath
$simpleUser = [string]$storedCredential.UserName
if ($simpleUser -cne 'Evidence1') {
  Fail 'stored guest user must be the dedicated Evidence1 account'
}

$candidates = @(
  "$GuestComputerName\$simpleUser",
  "$VMName\$simpleUser",
  ".\$simpleUser",
  $simpleUser,
  "localhost\$simpleUser"
)

$attempts = @()
$probe = $null
$workingCandidateIndex = $null
for ($candidateIndex = 0; $candidateIndex -lt $candidates.Count; $candidateIndex++) {
  $logonName = $candidates[$candidateIndex]
  $job = Start-Job -ScriptBlock {
    param($VmName, $UserName, $SecurePassword, $AuthWindowMinutes, $AuthProbeHosts)
    $credential = [pscredential]::new($UserName, $SecurePassword)
    Invoke-Command -VMName $VmName -Credential $credential -ScriptBlock {
      param($AuthWindowMinutes, $AuthProbeHosts)
      $ErrorActionPreference = 'Stop'
      $egressReady = $false
      try {

        function Invoke-AuthEndpointProbe([string]$HostName) {
          $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
          if (-not (Test-Path -LiteralPath $curl -PathType Leaf)) {
            throw 'auth endpoint probe tool is unavailable'
          }
          $previousPreference = $ErrorActionPreference
          try {
            $ErrorActionPreference = 'Continue'
            & $curl -IsS --max-time 12 "https://$HostName" *> $null
            return [int]$LASTEXITCODE
          } finally {
            $ErrorActionPreference = $previousPreference
          }
        }

        $watchdogTaskName = 'Evidence1AuthEgressExpiry'
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
        $watchdogSettings = New-ScheduledTaskSettingsSet `
          -StartWhenAvailable `
          -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
        Register-ScheduledTask `
          -TaskName $watchdogTaskName `
          -Action $watchdogAction `
          -Trigger $watchdogTrigger `
          -Principal $watchdogPrincipal `
          -Settings $watchdogSettings `
          -Force | Out-Null
        $watchdog = Get-ScheduledTask -TaskName $watchdogTaskName -ErrorAction Stop
        if ($watchdog.State.ToString() -notin @('Ready','Running')) {
          throw 'auth-egress expiry watchdog was not armed'
        }

        New-Item -ItemType Directory -Force -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' | Out-Null
        $priorQuicAllowed = Get-ItemPropertyValue `
          -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' `
          -Name 'QuicAllowed' `
          -ErrorAction SilentlyContinue
        New-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' -Name 'QuicAllowed' -Value 0 -PropertyType DWord -Force | Out-Null
        Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Allow
        $edgeProcessCount = @(Get-Process -Name 'msedge' -ErrorAction SilentlyContinue).Count
        $edgeRestartRequired = $priorQuicAllowed -ne 0
        if ($edgeRestartRequired) {
          Get-Process -Name 'msedge' -ErrorAction SilentlyContinue |
            Stop-Process -Force -ErrorAction SilentlyContinue
        }

        $profiles = @(Get-NetFirewallProfile -Profile Domain,Private,Public)
        $valid = $profiles.Count -eq 3 -and @($profiles | Where-Object {
          $_.Enabled.ToString() -ne 'True' -or $_.DefaultOutboundAction.ToString() -ne 'Allow'
        }).Count -eq 0
        if (-not $valid) {
          throw 'temporary auth egress profile verification failed'
        }

        $authProbeSuccessCount = 0
        foreach ($hostName in $AuthProbeHosts) {
          if ((Invoke-AuthEndpointProbe $hostName) -ne 0) {
            throw 'auth endpoint probe failed'
          }
          $authProbeSuccessCount++
        }
        $egressReady = $true
        [ordered]@{
          verdict = 'PASS'
          profile_count = $profiles.Count
          outbound_allow_profile_count = @($profiles | Where-Object { $_.DefaultOutboundAction.ToString() -eq 'Allow' }).Count
          quic_allowed_policy = [int](Get-ItemPropertyValue -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' -Name 'QuicAllowed')
          stopped_edge_process_count = if ($edgeRestartRequired) { $edgeProcessCount } else { 0 }
          edge_restart_required = $edgeRestartRequired
          auth_probe_host_count = $AuthProbeHosts.Count
          auth_probe_success_count = $authProbeSuccessCount
          watchdog_armed = $true
          watchdog_window_minutes = $AuthWindowMinutes
          temporary_auth_window = $true
          must_reseal_before_readiness_or_live = $true
          sensitive_content_read = $false
        }
      } finally {
        if (-not $egressReady) {
          Set-NetFirewallProfile `
            -Profile Domain,Private,Public `
            -Enabled True `
            -DefaultInboundAction Block `
            -DefaultOutboundAction Block `
            -ErrorAction Continue
          $cleanupProfiles = @(Get-NetFirewallProfile -Profile Domain,Private,Public -ErrorAction SilentlyContinue)
          $cleanupStillOpen = @($cleanupProfiles | Where-Object {
            $_.Enabled.ToString() -ne 'True' -or $_.DefaultOutboundAction.ToString() -ne 'Block'
          }).Count -gt 0
          if ($cleanupProfiles.Count -ne 3 -or $cleanupStillOpen) {
            throw 'auth-egress cleanup could not verify outbound blocking'
          }
        }
      }
    } -ArgumentList $AuthWindowMinutes, $AuthProbeHosts -ErrorAction Stop
  } -ArgumentList $VMName, $logonName, $storedCredential.Password, $AuthWindowMinutes, $AuthProbeHosts

  try {
    if (-not (Wait-Job -Job $job -Timeout $ProbeTimeoutSeconds)) {
      $attempts += [ordered]@{ candidate_index = $candidateIndex; ok = $false; error = 'timed_out' }
      continue
    }
    $probe = Receive-Job -Job $job -ErrorAction Stop
    $workingCandidateIndex = $candidateIndex
    $attempts += [ordered]@{ candidate_index = $candidateIndex; ok = $true; error = $null }
    break
  } catch {
    $attempts += [ordered]@{ candidate_index = $candidateIndex; ok = $false; error = 'powershell_direct_failed' }
  } finally {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }
}

$report = [ordered]@{
  schema = 1
  verdict = if ($probe -and $probe.verdict -eq 'PASS') { 'PASS' } else { 'FAIL' }
  generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  vm_name = $VMName
  vm_state = $vm.State.ToString()
  powershell_direct_candidate_index = $workingCandidateIndex
  attempts = $attempts
  guest = $probe
  privacy = [ordered]@{
    auth_content_read = $false
    credential_values_logged = $false
    network_response_content_logged = $false
  }
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $HostReportPath -Encoding UTF8
if ($report.verdict -ne 'PASS') {
  Fail "temporary auth egress failed; see $HostReportPath"
}
Write-Host "[hyperv-temporary-auth-egress] PASS: $HostReportPath"

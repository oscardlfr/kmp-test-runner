#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner',
  [string]$GuestComputerName = 'Evidence1Runner',
  [string]$GuestCredentialPath = 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml',
  [string]$GuestNetworkSealScript = 'C:\Evidence1Ops\evidence1-stageb-network-seal.ps1',
  [string]$GuestReportPath = 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1\NETWORK-SEAL.json',
  [string]$HostReportPath = 'C:\kmp-eval\scratch\hyperv-run-network-seal-direct\HYPERV-RUN-NETWORK-SEAL-DIRECT.json',
  [int]$ProbeTimeoutSeconds = 360
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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
$NetworkSealSourcePath = Join-Path $PSScriptRoot 'evidence1-stageb-network-seal.ps1'
if ($GuestNetworkSealScript -cne 'C:\Evidence1Ops\evidence1-stageb-network-seal.ps1') {
  Fail 'guest network-seal path is fixed'
}
if ($GuestReportPath -cne 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1\NETWORK-SEAL.json') {
  Fail 'guest network-seal report path is fixed'
}
if (-not (Test-Path -LiteralPath $GuestCredentialPath -PathType Leaf)) {
  Fail "guest credential file does not exist: $GuestCredentialPath"
}
if (-not (Test-Path -LiteralPath $NetworkSealSourcePath -PathType Leaf)) {
  Fail "network-seal source does not exist: $NetworkSealSourcePath"
}
$networkSealSha256 = (Get-FileHash -LiteralPath $NetworkSealSourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $HostReportPath) | Out-Null

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ($vm.State -ne 'Running') {
  Fail "$VMName must be running to reseal the guest network"
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
    param($VmName, $UserName, $SecurePassword, $NetworkSealSourcePath, $NetworkSealSha256, $GuestNetworkSealScript, $GuestReportPath)
    $session = $null
    $transportStage = 'credential_materialization_failed'
    try {
      [pscustomobject][ordered]@{ record_type = 'transport_stage'; stage = $transportStage }
      $credential = [pscredential]::new($UserName, $SecurePassword)
      $transportStage = 'session_open_failed'
      [pscustomobject][ordered]@{ record_type = 'transport_stage'; stage = $transportStage }
      $session = New-PSSession -VMName $VmName -Credential $credential -ErrorAction Stop
      $transportStage = 'payload_copy_failed'
      [pscustomobject][ordered]@{ record_type = 'transport_stage'; stage = $transportStage }
      Copy-Item -LiteralPath $NetworkSealSourcePath -Destination $GuestNetworkSealScript -ToSession $session -Force -ErrorAction Stop
      $transportStage = 'guest_invoke_failed'
      [pscustomobject][ordered]@{ record_type = 'transport_stage'; stage = $transportStage }
      Invoke-Command -Session $session -ScriptBlock {
        param($GuestNetworkSealScript, $GuestReportPath, $NetworkSealSha256)
        $ErrorActionPreference = 'Stop'
        $failureCode = 'guest_operation_failed'
        $remainingAuthProcesses = $null
        try {
          $failureCode = 'payload_integrity_failed'
          $guestSealSha256 = (Get-FileHash -LiteralPath $GuestNetworkSealScript -Algorithm SHA256).Hash.ToLowerInvariant()
          if ($guestSealSha256 -cne $NetworkSealSha256) {
            throw 'network-seal payload hash mismatch after guest transport'
          }

          $failureCode = 'auth_process_cleanup_incomplete'
          Stop-ScheduledTask -TaskName 'Evidence1OpenClaudeLogin' -ErrorAction SilentlyContinue
          Unregister-ScheduledTask -TaskName 'Evidence1OpenClaudeLogin' -Confirm:$false -ErrorAction SilentlyContinue
          for ($cleanupAttempt = 1; $cleanupAttempt -le 3; $cleanupAttempt++) {
            foreach ($name in @('msedge','claude','node')) {
              Get-Process -Name $name -ErrorAction SilentlyContinue |
                Stop-Process -Force -ErrorAction SilentlyContinue
            }
            Start-Sleep -Seconds 1
            $remainingAuthProcesses = @(Get-Process -Name 'msedge','claude','node' -ErrorAction SilentlyContinue)
            if ($remainingAuthProcesses.Count -eq 0) { break }
          }
          $interactiveTaskPresent = $null -ne (Get-ScheduledTask -TaskName 'Evidence1OpenClaudeLogin' -ErrorAction SilentlyContinue)
          if ($remainingAuthProcesses.Count -ne 0 -or $interactiveTaskPresent) {
            throw 'auth process cleanup was incomplete before network reseal'
          }

          $failureCode = 'network_seal_execution_failed'
          & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $GuestNetworkSealScript -ReportPath $GuestReportPath
          if ($LASTEXITCODE -ne 0) {
            throw 'network-seal guest script failed'
          }

          $failureCode = 'network_seal_result_invalid'
          $seal = Get-Content -LiteralPath $GuestReportPath -Raw | ConvertFrom-Json
          if ($seal.verdict -cne 'PASS' -or $seal.network_mode -cne 'restricted') {
            throw 'network-seal guest result was not restricted PASS'
          }

          $failureCode = 'watchdog_cleanup_failed'
          Unregister-ScheduledTask -TaskName 'Evidence1AuthEgressExpiry' -Confirm:$false -ErrorAction SilentlyContinue
          $watchdogPresent = $null -ne (Get-ScheduledTask -TaskName 'Evidence1AuthEgressExpiry' -ErrorAction SilentlyContinue)
          if ($watchdogPresent) {
            throw 'auth-egress expiry watchdog could not be removed after successful reseal'
          }

          [pscustomobject][ordered]@{
            verdict = 'PASS'
            failure_code = $null
            seal_schema = $seal.schema
            network_mode = $seal.network_mode
            profile_count = $seal.profile_count
            allowed_host_count = $seal.allowed_host_count
            blocked_probe_count = $seal.blocked_probe_count
            blocked_probe_success_count = $seal.blocked_probe_success_count
            stopped_auth_processes = $true
            remaining_auth_process_count = $remainingAuthProcesses.Count
            removed_interactive_task = $true
            removed_egress_watchdog = $true
            fail_closed_verified = $true
            network_seal_sha256 = $guestSealSha256
            sensitive_content_read = $false
          }
        } catch {
          Set-NetFirewallProfile `
            -Profile Domain,Private,Public `
            -Enabled True `
            -DefaultInboundAction Block `
            -DefaultOutboundAction Block `
            -ErrorAction SilentlyContinue
          $profiles = @(Get-NetFirewallProfile -Profile Domain,Private,Public -ErrorAction SilentlyContinue)
          $failClosedVerified = $profiles.Count -eq 3 -and @($profiles | Where-Object {
            $_.Enabled.ToString() -ne 'True' -or $_.DefaultOutboundAction.ToString() -ne 'Block'
          }).Count -eq 0
          [pscustomobject][ordered]@{
            verdict = 'FAIL'
            failure_code = $failureCode
            network_mode = if ($failClosedVerified) { 'blocked' } else { 'unknown' }
            remaining_auth_process_count = if ($null -ne $remainingAuthProcesses) { $remainingAuthProcesses.Count } else { $null }
            fail_closed_verified = $failClosedVerified
            sensitive_content_read = $false
          }
        }
      } -ArgumentList $GuestNetworkSealScript, $GuestReportPath, $NetworkSealSha256 -ErrorAction Stop
    } catch {
      [pscustomobject][ordered]@{
        verdict = 'FAIL'
        failure_code = $transportStage
        transport_hresult = [int]$_.Exception.HResult
        fail_closed_verified = $null
        sensitive_content_read = $false
      }
    } finally {
      if ($session) {
        Remove-PSSession -Session $session -ErrorAction SilentlyContinue
      }
    }
  } -ArgumentList $VMName, $logonName, $storedCredential.Password, $NetworkSealSourcePath, $networkSealSha256, $GuestNetworkSealScript, $GuestReportPath

  $workerJobState = $null
  $workerErrorCount = $null
  $workerErrorHResult = $null
  try {
    if (-not (Wait-Job -Job $job -Timeout $ProbeTimeoutSeconds)) {
      $childJob = @($job.ChildJobs) | Select-Object -First 1
      $workerJobState = $job.State.ToString()
      $workerErrorCount = if ($childJob) { @($childJob.Error).Count } else { 0 }
      $workerErrorHResult = if ($workerErrorCount -gt 0) { [int]$childJob.Error[-1].Exception.HResult } else { $null }
      $attempts += [ordered]@{
        candidate_index = $candidateIndex
        ok = $false
        error = 'timed_out'
        transport_hresult = $null
        worker_job_state = $workerJobState
        worker_error_count = $workerErrorCount
        worker_error_hresult = $workerErrorHResult
      }
      break
    }
    $childJob = @($job.ChildJobs) | Select-Object -First 1
    $workerJobState = $job.State.ToString()
    $workerErrorCount = if ($childJob) { @($childJob.Error).Count } else { 0 }
    $workerErrorHResult = if ($workerErrorCount -gt 0) { [int]$childJob.Error[-1].Exception.HResult } else { $null }
    $received = @(Receive-Job -Job $job -ErrorAction SilentlyContinue)
    $probe = @($received | Where-Object { $_ -and $_.PSObject.Properties['verdict'] }) | Select-Object -Last 1
    if (-not $probe) {
      $lastStage = @($received | Where-Object {
        $_ -and $_.PSObject.Properties['record_type'] -and $_.record_type -eq 'transport_stage'
      }) | Select-Object -Last 1
      $probe = [pscustomobject]@{
        verdict = 'FAIL'
        failure_code = if ($lastStage) { [string]$lastStage.stage } else { 'worker_terminated_before_stage' }
        transport_hresult = $workerErrorHResult
        fail_closed_verified = $null
        sensitive_content_read = $false
      }
    }
    $probeFailureCode = if ($probe.PSObject.Properties['failure_code']) {
      [string]$probe.failure_code
    } else {
      $null
    }
    if ($probeFailureCode -ne 'session_open_failed') {
      $workingCandidateIndex = $candidateIndex
    }
    $attempts += [ordered]@{
      candidate_index = $candidateIndex
      ok = $probe.verdict -eq 'PASS'
      error = if ($probe.verdict -eq 'PASS') { $null } else { $probeFailureCode }
      transport_hresult = if ($probe.PSObject.Properties['transport_hresult']) { [int]$probe.transport_hresult } else { $null }
      worker_job_state = $workerJobState
      worker_error_count = $workerErrorCount
      worker_error_hresult = $workerErrorHResult
    }
    if ($probeFailureCode -eq 'session_open_failed') {
      continue
    }
    break
  } catch {
    $attempts += [ordered]@{
      candidate_index = $candidateIndex
      ok = $false
      error = 'host_job_receive_failed'
      transport_hresult = [int]$_.Exception.HResult
      worker_job_state = $workerJobState
      worker_error_count = $workerErrorCount
      worker_error_hresult = $workerErrorHResult
    }
    break
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
  network_seal_sha256 = $networkSealSha256
  attempts = $attempts
  guest = $probe
  privacy = [ordered]@{
    response_content_logged = $false
    resolved_addresses_logged = $false
    credential_values_logged = $false
  }
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $HostReportPath -Encoding UTF8
if ($report.verdict -ne 'PASS') {
  Fail "network reseal failed; see $HostReportPath"
}
Write-Host "[hyperv-run-network-seal-direct] PASS: $HostReportPath"

#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner',
  [string]$GuestComputerName = 'Evidence1Runner',
  [string]$GuestCredentialPath = 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml',
  [string]$GuestLauncherPath = 'C:\Users\Evidence1\Desktop\Claude Login.cmd',
  [string]$TaskName = 'Evidence1OpenClaudeLogin',
  [string]$HostReportPath = 'C:\kmp-eval\scratch\hyperv-open-claude-login-task\HYPERV-OPEN-CLAUDE-LOGIN-TASK.json',
  [int]$ProbeTimeoutSeconds = 45
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
if ($GuestLauncherPath -cne 'C:\Users\Evidence1\Desktop\Claude Login.cmd') {
  Fail 'guest launcher path is fixed to the Evidence1 desktop launcher'
}
if ($TaskName -cne 'Evidence1OpenClaudeLogin') {
  Fail 'interactive task name is fixed'
}
if (-not (Test-Path -LiteralPath $GuestCredentialPath -PathType Leaf)) {
  Fail "guest credential file does not exist: $GuestCredentialPath"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $HostReportPath) | Out-Null

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ($vm.State -ne 'Running') {
  Fail "$VMName must be running to open Claude login"
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
    param($VmName, $UserName, $SecurePassword, $GuestLauncherPath, $TaskName)
    $credential = [pscredential]::new($UserName, $SecurePassword)
    Invoke-Command -VMName $VmName -Credential $credential -ScriptBlock {
      param($GuestLauncherPath, $TaskName)
      $ErrorActionPreference = 'Stop'
      if (-not (Test-Path -LiteralPath $GuestLauncherPath -PathType Leaf)) {
        throw "guest launcher missing: $GuestLauncherPath"
      }

      $interactiveUser = [string](Get-CimInstance Win32_ComputerSystem).UserName
      if ($interactiveUser -notmatch '(?i)\\Evidence1$') {
        throw 'the dedicated Evidence1 desktop is not logged on interactively'
      }

      $prior = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      if ($prior -and $prior.State.ToString() -eq 'Running') {
        throw 'the Claude login task is already running'
      }
      if ($prior) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
      }

      $beforeIds = @(Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -in @('claude','node','cmd','WindowsTerminal') } |
        Select-Object -ExpandProperty Id)
      $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/d /c ""' + $GuestLauncherPath + '""')
      $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(5))
      $principal = New-ScheduledTaskPrincipal -UserId 'Evidence1' -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null

      $startedAt = [DateTime]::UtcNow
      Start-ScheduledTask -TaskName $TaskName
      Start-Sleep -Seconds 5
      $task = Get-ScheduledTask -TaskName $TaskName
      $taskInfo = $task | Get-ScheduledTaskInfo
      $newProcessNames = @(Get-Process -ErrorAction SilentlyContinue |
        Where-Object {
          $_.Id -notin $beforeIds -and $_.ProcessName -in @('claude','node','cmd','WindowsTerminal')
        } |
        Select-Object -ExpandProperty ProcessName -Unique |
        Sort-Object)
      $startedAfterRequest = $taskInfo.LastRunTime.ToUniversalTime() -ge $startedAt.AddSeconds(-2)
      $launched = $startedAfterRequest -and (
        $newProcessNames.Count -gt 0 -or
        $task.State.ToString() -eq 'Running' -or
        $taskInfo.LastTaskResult -eq 0
      )

      [ordered]@{
        verdict = if ($launched) { 'PASS' } else { 'FAIL' }
        task_state = $task.State.ToString()
        task_last_result = [int64]$taskInfo.LastTaskResult
        task_started_after_request = $startedAfterRequest
        new_process_names = $newProcessNames
        operator_login_required = $true
        auth_content_read = $false
        credential_values_logged = $false
      }
    } -ArgumentList $GuestLauncherPath, $TaskName -ErrorAction Stop
  } -ArgumentList $VMName, $logonName, $storedCredential.Password, $GuestLauncherPath, $TaskName

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
  note = 'Opens the existing Claude launcher in the logged-on dedicated guest. The operator completes authentication; this script never reads or enters credentials.'
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $HostReportPath -Encoding UTF8
if ($report.verdict -ne 'PASS') {
  Fail "interactive Claude login launch failed; see $HostReportPath"
}
Write-Host "[hyperv-open-claude-login-task] PASS: $HostReportPath"

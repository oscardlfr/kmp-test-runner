#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner',
  [string]$GuestComputerName = 'Evidence1Runner',
  [string]$GuestCredentialPath = 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml',
  [string]$GuestOpsDir = 'C:\Evidence1Ops',
  [string]$GuestScratchDir = 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1',
  [string]$ReportPath = 'C:\kmp-eval\scratch\hyperv-read-live-operational-tail\HYPERV-READ-LIVE-OPERATIONAL-TAIL.json',
  [int]$TailLines = 120
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
  $rootFull = (Resolve-FullPath $Root).TrimEnd('\') + '\'
  if (-not $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "$Label path is outside expected root: $candidateFull"
  }
}

function File-Fact([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return [ordered]@{ exists = $false }
  }
  $item = Get-Item -LiteralPath $Path
  return [ordered]@{
    exists = $true
    length = $item.Length
    last_write_time_utc = $item.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
}

function Tail-IfPresent([string]$Path, [int]$Lines) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return @()
  }
  return @(Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction Stop | ForEach-Object { [string]$_ })
}

Assert-PathInside $GuestCredentialPath 'C:\kmp-eval\scratch\' 'guest credential'
Assert-PathInside $ReportPath 'C:\kmp-eval\scratch\' 'report'
if ($GuestOpsDir -ne 'C:\Evidence1Ops') {
  Fail 'GuestOpsDir must stay exactly C:\Evidence1Ops'
}
if ($GuestScratchDir -ne 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1') {
  Fail 'GuestScratchDir must stay exactly the Stage B scratch directory'
}
if (-not (Test-Path -LiteralPath $GuestCredentialPath)) {
  Fail "guest credential file does not exist: $GuestCredentialPath"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath) | Out-Null

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ($vm.State -ne 'Running') {
  Fail "$VMName must be running for operational tail read, got $($vm.State)"
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
$result = $null
$workingLogonName = $null
foreach ($logonName in $candidates) {
  $credential = [pscredential]::new($logonName, $storedCredential.Password)
  try {
    $session = New-PSSession -VMName $VMName -Credential $credential -ErrorAction Stop
    try {
      $result = Invoke-Command -Session $session -ScriptBlock {
        param($GuestOpsDir, $GuestScratchDir, $TailLines)
        Set-StrictMode -Version Latest
        $ErrorActionPreference = 'Stop'

        function File-Fact([string]$Path) {
          if (-not (Test-Path -LiteralPath $Path)) {
            return [ordered]@{ exists = $false }
          }
          $item = Get-Item -LiteralPath $Path
          return [ordered]@{
            exists = $true
            length = $item.Length
            last_write_time_utc = $item.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
          }
        }

        function Tail-IfPresent([string]$Path, [int]$Lines) {
          if (-not (Test-Path -LiteralPath $Path)) {
            return @()
          }
          return @(Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction Stop | ForEach-Object { [string]$_ })
        }

        $paths = [ordered]@{
          wrapper_log = Join-Path $GuestOpsDir 'STAGE-B-live-wrapper.log'
          wrapper_stdout = Join-Path $GuestOpsDir 'STAGE-B-live.stdout.log'
          wrapper_stderr = Join-Path $GuestOpsDir 'STAGE-B-live.stderr.log'
          status = Join-Path $GuestOpsDir 'STAGE-B-live.status.json'
          terminal = Join-Path $GuestOpsDir 'STAGE-B-live.exit.json'
          launcher_terminal = Join-Path $GuestOpsDir 'STAGE-B-live.launcher-exit.json'
          exit_marker = Join-Path $GuestOpsDir 'STAGE-B-live.exit.txt'
          stage_log = Join-Path $GuestScratchDir 'STAGE-B-live.log'
        }

        [ordered]@{
          files = [ordered]@{
            wrapper_log = File-Fact $paths.wrapper_log
            wrapper_stdout = File-Fact $paths.wrapper_stdout
            wrapper_stderr = File-Fact $paths.wrapper_stderr
            status = File-Fact $paths.status
            terminal = File-Fact $paths.terminal
            launcher_terminal = File-Fact $paths.launcher_terminal
            exit_marker = File-Fact $paths.exit_marker
            stage_log = File-Fact $paths.stage_log
          }
          tails = [ordered]@{
            wrapper_log = Tail-IfPresent $paths.wrapper_log $TailLines
            wrapper_stdout = Tail-IfPresent $paths.wrapper_stdout $TailLines
            wrapper_stderr = Tail-IfPresent $paths.wrapper_stderr $TailLines
            terminal = Tail-IfPresent $paths.terminal $TailLines
            launcher_terminal = Tail-IfPresent $paths.launcher_terminal $TailLines
            stage_log = Tail-IfPresent $paths.stage_log $TailLines
          }
        }
      } -ArgumentList $GuestOpsDir, $GuestScratchDir, $TailLines
      $workingLogonName = $logonName
      $attempts += [ordered]@{ logon_name = $logonName; ok = $true; error = $null }
      break
    } finally {
      Remove-PSSession -Session $session -ErrorAction SilentlyContinue
    }
  } catch {
    $attempts += [ordered]@{ logon_name = $logonName; ok = $false; error = $_.Exception.Message }
  }
}

$report = [ordered]@{
  verdict = if ($result) { 'PASS' } else { 'FAIL' }
  generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  vm_name = $VMName
  vm_state = $vm.State.ToString()
  powershell_direct_logon = $workingLogonName
  attempts = $attempts
  result = $result
  raw_transcript_content_read = $false
  note = 'Reads bounded tails of Stage B operational launcher logs only; does not read journal raw/*.jsonl or stderr/*.txt transcript artifacts.'
}

$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
if ($report.verdict -ne 'PASS') {
  Fail "could not read live operational tail; see $ReportPath"
}
Write-Host "[hyperv-read-live-operational-tail] PASS: $ReportPath"

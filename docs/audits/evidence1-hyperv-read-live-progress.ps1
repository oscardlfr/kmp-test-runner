#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner',
  [string]$GuestComputerName = 'Evidence1Runner',
  [string]$GuestCredentialPath = 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml',
  [string]$GuestOpsDir = 'C:\Evidence1Ops',
  [string]$CopiedArtifactsDir = 'C:\kmp-eval\scratch\hyperv-copy-live-artifacts',
  [string]$ReportPath = 'C:\kmp-eval\scratch\hyperv-read-live-progress\HYPERV-READ-LIVE-PROGRESS.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath) | Out-Null

function Read-KvpValue([string]$Name) {
  $escapedVmName = $VMName.Replace("'", "''")
  $vmWmi = Get-WmiObject -Namespace root\virtualization\v2 -Class Msvm_ComputerSystem -Filter "ElementName = '$escapedVmName'" |
    Select-Object -First 1
  if ($null -eq $vmWmi) {
    return [ordered]@{ ok = $false; reason = 'vm_not_found'; value = $null }
  }
  $kvpComponents = @($vmWmi.GetRelated('Msvm_KvpExchangeComponent'))
  if ($kvpComponents.Count -eq 0) {
    return [ordered]@{ ok = $false; reason = 'kvp_component_not_found'; value = $null }
  }
  foreach ($kvp in $kvpComponents) {
    foreach ($itemXml in @($kvp.GuestExchangeItems)) {
      try {
        [xml]$xml = $itemXml
        $properties = @{}
        foreach ($property in @($xml.INSTANCE.PROPERTY)) {
          $properties[$property.NAME] = [string]$property.VALUE
        }
        if ($properties['Name'] -eq $Name) {
          return [ordered]@{ ok = $true; reason = $null; value = $properties['Data'] }
        }
      } catch {
        # Ignore malformed/nonstandard KVP payloads from other components.
      }
    }
  }
  return [ordered]@{ ok = $false; reason = 'kvp_value_not_found'; value = $null }
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

$vm = Get-VM -Name $VMName -ErrorAction Stop
$integrationServices = @(Get-VMIntegrationService -VMName $VMName |
  Select-Object Name, Enabled, PrimaryStatusDescription, SecondaryStatusDescription)
$kvpResult = Read-KvpValue 'Evidence1StageBProgress'
$progress = $null
$guestRead = [ordered]@{
  ok = $false
  reason = $null
  powershell_direct_logon = $null
  attempts = @()
  status = $null
  files = $null
  process_facts = @()
}

if ($vm.State -eq 'Running' -and (Test-Path -LiteralPath $GuestCredentialPath)) {
  $storedCredential = Import-Clixml -LiteralPath $GuestCredentialPath
  $simpleUser = $storedCredential.UserName
  $candidates = @(
    "$GuestComputerName\$simpleUser",
    "$VMName\$simpleUser",
    ".\$simpleUser",
    $simpleUser,
    "localhost\$simpleUser"
  )
  $session = $null
  foreach ($logonName in $candidates) {
    $credential = [pscredential]::new($logonName, $storedCredential.Password)
    try {
      $session = New-PSSession -VMName $VMName -Credential $credential -ErrorAction Stop
      $guestRead.powershell_direct_logon = $logonName
      $guestRead.attempts += [ordered]@{ logon_name = $logonName; ok = $true; error = $null }
      break
    } catch {
      $guestRead.attempts += [ordered]@{ logon_name = $logonName; ok = $false; error = $_.Exception.Message }
    }
  }
  if ($session) {
    try {
      $guestReadResult = Invoke-Command -Session $session -ScriptBlock {
        param($GuestOpsDir)

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

        $statusPath = Join-Path $GuestOpsDir 'STAGE-B-live.status.json'
        $status = $null
        if (Test-Path -LiteralPath $statusPath) {
          try {
            $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
          } catch {
            $status = [ordered]@{ parse_error = $_.Exception.Message }
          }
        }
        $files = [ordered]@{}
        foreach ($name in @(
          'STAGE-B-live.log',
          'STAGE-B-live.stderr.log',
          'STAGE-B-live.stdout.log',
          'STAGE-B-live-wrapper.log',
          'STAGE-B-live.status.json',
          'STAGE-B-live.exit.txt'
        )) {
          $files[$name] = File-Fact (Join-Path $GuestOpsDir $name)
        }
        $processFacts = @(Get-CimInstance Win32_Process |
          Where-Object { $_.Name -match '^(node|claude|powershell|pwsh)\.exe$' -and ($_.CommandLine -like '*agentic-eval*' -or $_.CommandLine -like '*stageb-live*' -or $_.CommandLine -like '*claude*') } |
          ForEach-Object {
            $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
            $startTimeUtc = $null
            $elapsedSeconds = $null
            $cpuSeconds = $null
            if ($process) {
              try {
                $startTimeUtc = $process.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
                $elapsedSeconds = [int64]((Get-Date) - $process.StartTime).TotalSeconds
              } catch {
                $startTimeUtc = $null
                $elapsedSeconds = $null
              }
              $cpuSeconds = $process.CPU
            }
            [pscustomobject]@{
              Name = $_.Name
              ProcessId = $_.ProcessId
              ParentProcessId = $_.ParentProcessId
              StartTimeUtc = $startTimeUtc
              ElapsedSeconds = $elapsedSeconds
              CpuSeconds = $cpuSeconds
              CommandLine = $_.CommandLine
            }
          })
        [ordered]@{
          status = $status
          files = $files
          process_facts = $processFacts
        }
      } -ArgumentList $GuestOpsDir
      $guestRead.ok = $true
      $guestRead.status = $guestReadResult.status
      $guestRead.files = $guestReadResult.files
      $guestRead.process_facts = $guestReadResult.process_facts
    } catch {
      $guestRead.reason = $_.Exception.Message
    } finally {
      Remove-PSSession -Session $session -ErrorAction SilentlyContinue
    }
  } else {
    $guestRead.reason = 'powershell_direct_session_failed'
  }
} elseif ($vm.State -ne 'Running') {
  $guestRead.reason = 'vm_not_running'
} else {
  $guestRead.reason = 'guest_credential_missing'
}

if ($kvpResult.ok -and $kvpResult.value) {
  try {
    $progress = $kvpResult.value | ConvertFrom-Json
  } catch {
    $progress = [ordered]@{ parse_error = $_.Exception.Message; raw_length = $kvpResult.value.Length }
  }
}

$artifactFacts = [ordered]@{}
foreach ($name in @(
  'STAGE-B-live.log',
  'STAGE-B-live.stderr.log',
  'STAGE-B-live.stdout.log',
  'STAGE-B-live-wrapper.log',
  'STAGE-B-live.status.json',
  'STAGE-B-live.exit.txt',
  'HYPERV-COPY-LIVE-ARTIFACTS.json'
)) {
  $artifactFacts[$name] = File-Fact (Join-Path $CopiedArtifactsDir $name)
}

$report = [ordered]@{
  generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  vm_name = $VMName
  vm_state = [string]$vm.State
  vm_uptime_seconds = [int64]$vm.Uptime.TotalSeconds
  vm_status = [string]$vm.Status
  integration_services = $integrationServices
  kvp = $kvpResult
  progress = $progress
  powershell_direct = $guestRead
  copied_artifact_facts = $artifactFacts
  note = 'Reads live progress metadata/status via PowerShell Direct, plus Hyper-V KVP if available. Does not read raw transcript/stderr contents.'
}

$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
Write-Host "[hyperv-read-live-progress] PASS: $ReportPath"

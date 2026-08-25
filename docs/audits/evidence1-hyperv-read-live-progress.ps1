#Requires -RunAsAdministrator

param(
    [string]$VMName = 'Evidence1-Runner',
    [string]$GuestComputerName = 'Evidence1Runner',
    [string]$GuestCredentialPath = 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml',
    [string]$GuestOpsDir = 'C:\Evidence1Ops',
    [string]$PlacementReportPath = 'C:\kmp-eval\scratch\hyperv-place-live-autorun\HYPERV-PLACE-LIVE-AUTORUN.json',
    [string]$ExpectedRunId = '',
    [string]$ReportPath = 'C:\kmp-eval\scratch\hyperv-read-live-progress\HYPERV-READ-LIVE-PROGRESS.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$contractPath = Join-Path $PSScriptRoot 'evidence1-live-run-contract.psm1'
Import-Module $contractPath -Force

function Fail([string]$Message) {
    Write-Error "HARD STOP: $Message"
    exit 1
}

function Resolve-ExpectedRunId {
    if ($ExpectedRunId) { return $ExpectedRunId }
    if (-not (Test-Path -LiteralPath $PlacementReportPath -PathType Leaf)) {
        Fail 'ExpectedRunId was not supplied and the placement report is missing'
    }
    try {
        $placement = Get-Content -LiteralPath $PlacementReportPath -Raw | ConvertFrom-Json
    } catch {
        Fail 'placement report is not valid JSON'
    }
    if ($placement.verdict -ne 'PASS' -or -not $placement.run_id) {
        Fail 'placement report does not contain a successful run_id'
    }
    return [string]$placement.run_id
}

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
                # Ignore unrelated malformed KVP payloads.
            }
        }
    }
    return [ordered]@{ ok = $false; reason = 'kvp_value_not_found'; value = $null }
}

$runId = Resolve-ExpectedRunId
$parsedRunId = [guid]::Empty
if (-not [guid]::TryParseExact($runId, 'D', [ref]$parsedRunId)) {
    Fail 'ExpectedRunId must be a canonical D-format GUID'
}
if ($GuestOpsDir -ne 'C:\Evidence1Ops') { Fail 'GuestOpsDir must stay exactly C:\Evidence1Ops' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath) | Out-Null

$vm = Get-VM -Name $VMName -ErrorAction Stop
$integrationServices = @(Get-VMIntegrationService -VMName $VMName |
    Select-Object Name, Enabled, PrimaryStatusDescription, SecondaryStatusDescription)

$kvpTransport = Read-KvpValue 'Evidence1StageBProgress'
$kvpRecord = $null
if ($kvpTransport.ok -and $kvpTransport.value) {
    try {
        $kvpRecord = $kvpTransport.value | ConvertFrom-Json
    } catch {
        $kvpRecord = [ordered]@{ parse_error = $_.Exception.Message }
    }
}
$kvpProgress = Test-Evidence1ProgressRecord -Record $kvpRecord -Source 'hyperv_kvp' -ExpectedRunId $runId

$direct = [ordered]@{
    attempted = $false
    connected = $false
    reason = $null
    progress = (Test-Evidence1ProgressRecord -Record $null -Source 'powershell_direct' -ExpectedRunId $runId)
    terminal = (Read-Evidence1TerminalRecord -Path (Join-Path $GuestOpsDir 'STAGE-B-live.exit.json') -ExpectedRunId $runId)
    launcher_terminal = (Read-Evidence1TerminalRecord -Path (Join-Path $GuestOpsDir 'STAGE-B-live.launcher-exit.json') -ExpectedRunId $runId)
    process_facts = @()
}

if ($vm.State -eq 'Running' -and (Test-Path -LiteralPath $GuestCredentialPath -PathType Leaf)) {
    $direct.attempted = $true
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
        try {
            $credential = [pscredential]::new($logonName, $storedCredential.Password)
            $session = New-PSSession -VMName $VMName -Credential $credential -ErrorAction Stop
            break
        } catch {
            $direct.reason = 'powershell_direct_session_failed'
        }
    }
    if ($session) {
        try {
            $guest = Invoke-Command -Session $session -ScriptBlock {
                param($OpsDir)
                $statusPath = Join-Path $OpsDir 'STAGE-B-live.status.json'
                $terminalPath = Join-Path $OpsDir 'STAGE-B-live.exit.json'
                $launcherTerminalPath = Join-Path $OpsDir 'STAGE-B-live.launcher-exit.json'
                $status = $null
                $terminal = $null
                $launcherTerminal = $null
                if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
                    try {
                        $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
                    } catch {
                        $status = [ordered]@{ parse_error = $_.Exception.Message }
                    }
                }
                if (Test-Path -LiteralPath $terminalPath -PathType Leaf) {
                    try {
                        $terminal = Get-Content -LiteralPath $terminalPath -Raw | ConvertFrom-Json
                    } catch {
                        $terminal = [ordered]@{ parse_error = $_.Exception.Message }
                    }
                }
                if (Test-Path -LiteralPath $launcherTerminalPath -PathType Leaf) {
                    try {
                        $launcherTerminal = Get-Content -LiteralPath $launcherTerminalPath -Raw | ConvertFrom-Json
                    } catch {
                        $launcherTerminal = [ordered]@{ parse_error = $_.Exception.Message }
                    }
                }
                $processFacts = @(Get-CimInstance Win32_Process |
                    Where-Object { $_.Name -match '^(node|claude|powershell|pwsh|java|javaw|gradle|cmd|conhost)\.exe$' } |
                    ForEach-Object {
                        $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
                        [pscustomobject]@{
                            name = $_.Name
                            process_id = $_.ProcessId
                            parent_process_id = $_.ParentProcessId
                            start_time_utc = if ($process) {
                                try { $process.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } catch { $null }
                            } else { $null }
                            cpu_seconds = if ($process) { $process.CPU } else { $null }
                        }
                    })
                [ordered]@{ status = $status; terminal = $terminal; launcher_terminal = $launcherTerminal; process_facts = $processFacts }
            } -ArgumentList $GuestOpsDir
            $direct.connected = $true
            $direct.reason = $null
            $direct.progress = Test-Evidence1ProgressRecord -Record $guest.status -Source 'powershell_direct' -ExpectedRunId $runId
            $direct.terminal = Test-Evidence1TerminalRecordObject -Record $guest.terminal -Source 'powershell_direct_terminal' -ExpectedRunId $runId
            $direct.launcher_terminal = Test-Evidence1TerminalRecordObject -Record $guest.launcher_terminal -Source 'powershell_direct_launcher_terminal' -ExpectedRunId $runId
            $direct.process_facts = $guest.process_facts
        } catch {
            $direct.reason = 'powershell_direct_read_failed'
        } finally {
            Remove-PSSession -Session $session -ErrorAction SilentlyContinue
        }
    }
} elseif ($vm.State -ne 'Running') {
    $direct.reason = 'vm_not_running'
} else {
    $direct.reason = 'guest_credential_missing'
}

$authoritative = if ($direct.terminal.valid) {
    $direct.terminal
} elseif ($direct.launcher_terminal.valid) {
    $direct.launcher_terminal
} elseif ($direct.progress.valid) {
    $direct.progress
} elseif ($kvpProgress.valid) {
    $kvpProgress
} else {
    [ordered]@{ valid = $false; source = $null; reason = 'no_run_scoped_progress_or_terminal'; record = $null }
}

$report = [ordered]@{
    schema = 1
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    expected_run_id = $runId
    vm_name = $VMName
    vm_state = [string]$vm.State
    vm_uptime_seconds = [int64]$vm.Uptime.TotalSeconds
    vm_status = [string]$vm.Status
    integration_services = $integrationServices
    authoritative_progress = $authoritative
    hyperv_kvp = [ordered]@{ transport = $kvpTransport; progress = $kvpProgress }
    powershell_direct = $direct
    privacy = [ordered]@{
        raw_content_read = $false
        stderr_content_read = $false
        stdout_content_read = $false
        process_command_lines_read = $false
    }
}

$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
Write-Host "[hyperv-read-live-progress] PASS: $ReportPath"

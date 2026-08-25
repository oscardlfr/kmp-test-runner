#Requires -RunAsAdministrator

param(
    [string]$VMName = 'Evidence1-Runner',
    [string]$GuestUserName = 'Evidence1',
    [string]$LiveLauncherSourcePath = (Join-Path $PSScriptRoot 'evidence1-stageb-live-launch.ps1'),
    [string]$LiveWrapperSourcePath = (Join-Path $PSScriptRoot 'evidence1-stageb-live-wrapper.ps1'),
    [string]$ContractSourcePath = (Join-Path $PSScriptRoot 'evidence1-live-run-contract.psm1'),
    [string]$GuestOpsDir = 'C:\Evidence1Ops',
    [string]$ReportPath = 'C:\kmp-eval\scratch\hyperv-place-live-autorun\HYPERV-PLACE-LIVE-AUTORUN.json',
    [string]$LiveAuthorizationPhrase = '',
    [switch]$SkipStartupEntry
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RequiredLivePhrase = (
    'AUTORIZO HASTA 8 SESIONES LIVE NUEVAS DEL EVIDENCE' +
    '1 CLAUDE WINDOWS PRODUCT-VS-FREE-BASELINE COVERAGE-THRESHOLD EN ESTE ENTORNO AISLADO, SIN REINTENTOS, REEMPLAZOS NI RESPAWNS'
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

function Remove-Required([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $Path) {
        Fail "could not remove stale active-run artifact: $Path"
    }
}

$auditRoot = Resolve-FullPath $PSScriptRoot
foreach ($source in @($LiveLauncherSourcePath, $LiveWrapperSourcePath, $ContractSourcePath)) {
    Assert-PathInside $source $auditRoot 'source'
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        Fail "required source missing: $source"
    }
}
Assert-PathInside $ReportPath 'C:\kmp-eval\scratch\' 'report'
if ($GuestOpsDir -ne 'C:\Evidence1Ops') { Fail 'GuestOpsDir must stay exactly C:\Evidence1Ops' }
if ($LiveAuthorizationPhrase -ne $RequiredLivePhrase) {
    Fail 'exact Stage B live authorization phrase is required before placing live autorun'
}

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ($vm.State -ne 'Off') { Fail "placing live autorun requires $VMName to be Off, got $($vm.State)" }
$diskDrive = Get-VMHardDiskDrive -VMName $VMName | Select-Object -First 1
if (-not $diskDrive -or -not $diskDrive.Path) { Fail "could not resolve active VM disk for $VMName" }
$vhdPath = Resolve-FullPath $diskDrive.Path
Assert-PathInside $vhdPath 'C:\kmp-eval\hyperv\' 'active VHD'

$runId = [guid]::NewGuid().ToString('D')
$mount = $null
try {
    $mount = Mount-VHD -Path $vhdPath -Passthru
    $disk = $mount | Get-Disk
    $volume = $disk | Get-Partition | Get-Volume | Where-Object {
        $_.DriveLetter -and (Test-Path "$($_.DriveLetter):\Windows")
    } | Select-Object -First 1
    if (-not $volume) { Fail 'could not find mounted Windows volume in VHD' }

    $driveRoot = "$($volume.DriveLetter):\"
    $opsOnHost = Join-Path $driveRoot ($GuestOpsDir.Substring(3))
    New-Item -ItemType Directory -Force -Path $opsOnHost | Out-Null

    $sourceMap = [ordered]@{
        'evidence1-stageb-live-launch.ps1' = $LiveLauncherSourcePath
        'evidence1-stageb-live-wrapper.ps1' = $LiveWrapperSourcePath
        'evidence1-live-run-contract.psm1' = $ContractSourcePath
    }
    foreach ($entry in $sourceMap.GetEnumerator()) {
        Copy-Item -LiteralPath $entry.Value -Destination (Join-Path $opsOnHost $entry.Key) -Force
    }

    $startupDir = Join-Path $driveRoot "Users\$GuestUserName\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup"
    if (-not (Test-Path -LiteralPath $startupDir)) { Fail "guest Startup directory not found: $startupDir" }

    foreach ($name in @('Evidence1RunReadiness.cmd', 'Evidence1RunLive.cmd', 'Evidence1OpenClaude.cmd', 'Evidence1AuthVerify.cmd')) {
        Remove-Required (Join-Path $startupDir $name)
    }
    foreach ($name in @('STAGE-B-live.status.json', 'STAGE-B-live.exit.json', 'STAGE-B-live.launcher-exit.json', 'STAGE-B-live.stdout.log', 'STAGE-B-live.stderr.log')) {
        Remove-Required (Join-Path $opsOnHost $name)
    }

    $startupPath = Join-Path $startupDir 'Evidence1RunLive.cmd'
    $wrapperGuestPath = Join-Path $GuestOpsDir 'evidence1-stageb-live-wrapper.ps1'
    if (-not $SkipStartupEntry) {
        Set-Content -LiteralPath $startupPath -Encoding ASCII -Value @"
@echo off
set "SELF=%~f0"
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$wrapperGuestPath" -RunId "$runId" -ShutdownOnExit
set "WRAPPER_EXIT=%ERRORLEVEL%"
del "%SELF%" >nul 2>nul
if exist "%SELF%" exit /b 91
exit /b %WRAPPER_EXIT%
"@
    }

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath) | Out-Null
    $report = [ordered]@{
        verdict = 'PASS'
        schema = 1
        generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        run_id = $runId
        vm_name = $VMName
        launcher_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $LiveLauncherSourcePath).Hash.ToLowerInvariant()
        wrapper_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $LiveWrapperSourcePath).Hash.ToLowerInvariant()
        contract_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $ContractSourcePath).Hash.ToLowerInvariant()
        startup_entry_created = -not $SkipStartupEntry.IsPresent
        launch_policy = if ($SkipStartupEntry) {
            'assets staged and run_id generated without Startup entry; launch must use the direct one-shot runner'
        } else {
            'one-shot Startup entry is consumed after the wrapper process exits; every state record is bound to run_id'
        }
    }
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
    Write-Host "[hyperv-place-live-autorun] PASS: $ReportPath"
} finally {
    if ($mount) { Dismount-VHD -Path $vhdPath -ErrorAction SilentlyContinue }
}

#Requires -RunAsAdministrator

param(
    [string]$VMName = 'Evidence1-Runner',
    [string]$GuestUserName = 'Evidence1',
    [string]$LiveLauncherSourcePath = (Join-Path $PSScriptRoot 'evidence1-stageb-live-launch.ps1'),
    [string]$LiveWrapperSourcePath = (Join-Path $PSScriptRoot 'evidence1-stageb-live-wrapper.ps1'),
    [string]$ContractSourcePath = (Join-Path $PSScriptRoot 'evidence1-live-run-contract.psm1'),
    [string]$GuestOpsDir = 'C:\Evidence1Ops',
    [string]$GuestScratchDir = 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1',
    [string]$ReportPath = 'C:\kmp-eval\scratch\hyperv-place-live-autorun\HYPERV-PLACE-LIVE-AUTORUN.json',
    [string]$LiveAuthorizationPhrase = '',
    [string]$CanaryArm = '',
    [string]$CanaryRunId = '',
    [string]$CanaryBindingPath = '',
    [string]$CanaryBindingSha256 = '',
    [string]$ClosedPriorRunId = '',
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
if (-not $GuestScratchDir.StartsWith('C:\kmp-eval\scratch\', [StringComparison]::OrdinalIgnoreCase)) {
    Fail 'GuestScratchDir must stay under C:\kmp-eval\scratch'
}
$canary = $null
if ($CanaryArm -or $CanaryRunId -or $CanaryBindingPath -or $CanaryBindingSha256) {
    if ($CanaryArm -cnotin @('product','free-baseline') -or -not $CanaryRunId -or -not $CanaryBindingPath -or -not $CanaryBindingSha256 -or
        $VMName -cne 'Evidence1-Runner' -or $GuestUserName -cne 'Evidence1' -or $SkipStartupEntry) { Fail 'canary placement parameters invalid' }
    Import-Module (Join-Path $PSScriptRoot 'evidence1-live-run-contract.psm1') -ErrorAction Stop
    Import-Module (Join-Path $PSScriptRoot 'evidence1-live-handoff-contract.psm1') -ErrorAction Stop
    $expectedBindingPath = 'C:\kmp-eval\scratch\hyperv-start-authorized-live\canary\' + $CanaryRunId + '\binding.json'
    if ((Resolve-FullPath $CanaryBindingPath) -cne $expectedBindingPath) { Fail 'canary binding path mismatch' }
    $canary = Read-Evidence1CanaryBundle (Split-Path -Parent $CanaryBindingPath) $CanaryRunId $CanaryArm $CanaryBindingSha256
    Assert-Evidence1CanaryAuthorization $canary.binding $LiveAuthorizationPhrase
    $claim = (Read-Evidence1CanaryJson (Join-Path (Split-Path -Parent $CanaryBindingPath) 'handoff.claim.json')).value
    if ($claim.run_id -cne $CanaryRunId -or $claim.binding_sha256 -cne $CanaryBindingSha256 -or $claim.phase -cne 'handoff') { Fail 'canary handoff claim mismatch' }
} elseif ($LiveAuthorizationPhrase -ne $RequiredLivePhrase) {
    Fail 'exact Stage B live authorization phrase is required before placing live autorun'
}
if ($ClosedPriorRunId) {
    $parsedPriorRunId = [guid]::Empty
    if (-not [guid]::TryParseExact($ClosedPriorRunId, 'D', [ref]$parsedPriorRunId)) {
        Fail 'ClosedPriorRunId must be a canonical run GUID'
    }
}

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ($vm.State -ne 'Off') { Fail "placing live autorun requires $VMName to be Off, got $($vm.State)" }
$diskDrive = Get-VMHardDiskDrive -VMName $VMName | Select-Object -First 1
if (-not $diskDrive -or -not $diskDrive.Path) { Fail "could not resolve active VM disk for $VMName" }
$vhdPath = Resolve-FullPath $diskDrive.Path
Assert-PathInside $vhdPath 'C:\kmp-eval\hyperv\' 'active VHD'

$runId = if ($canary) { $CanaryRunId } else { [guid]::NewGuid().ToString('D') }
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
    $scratchOnHost = Join-Path $driveRoot ($GuestScratchDir.Substring(3))
    New-Item -ItemType Directory -Force -Path $opsOnHost | Out-Null
    $canaryOnHost = Join-Path $opsOnHost "canary\$runId"
    if ($canary -and (Test-Path -LiteralPath $canaryOnHost)) { Fail 'canary placement already exists; no retry or replacement' }

    $startupDir = Join-Path $driveRoot "Users\$GuestUserName\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup"
    if (-not (Test-Path -LiteralPath $startupDir)) { Fail "guest Startup directory not found: $startupDir" }

    $startupPath = Join-Path $startupDir 'Evidence1RunLive.cmd'
    $closedPriorStartup = $null
    if ((Test-Path -LiteralPath $startupPath) -and -not $ClosedPriorRunId) {
        Fail 'existing live autorun found; refusing to replace an armed or unconsumed run'
    }
    if (Test-Path -LiteralPath $startupPath) {
        $startupContent = Get-Content -LiteralPath $startupPath -Raw
        $expectedRunBinding = '-RunId "' + $ClosedPriorRunId + '"'
        if (-not $startupContent.Contains($expectedRunBinding)) {
            Fail 'existing live autorun does not match closed prior-run custody; refusing to replace it'
        }
        $closedPriorStartup = [ordered]@{ area = 'startup'; name = 'Evidence1RunLive.cmd'; source = $startupPath }
    }
    foreach ($name in @('Evidence1RunReadiness.cmd', 'Evidence1OpenClaude.cmd', 'Evidence1AuthVerify.cmd')) {
        Remove-Required (Join-Path $startupDir $name)
    }

    $liveArtifactNames = @(
        'STAGE-B-live.status.json',
        'STAGE-B-live.exit.json',
        'STAGE-B-live.launcher-exit.json',
        'STAGE-B-live.stdout.log',
        'STAGE-B-live.stderr.log',
        'STAGE-B-live-wrapper.log',
        'STAGE-B-live.exit.txt'
    )
    $existingLiveArtifacts = @($liveArtifactNames | Where-Object {
        Test-Path -LiteralPath (Join-Path $opsOnHost $_)
    } | ForEach-Object {
        [ordered]@{ area = 'ops'; name = $_; source = (Join-Path $opsOnHost $_) }
    })
    $scratchLiveLog = Join-Path $scratchOnHost 'STAGE-B-live.log'
    if (Test-Path -LiteralPath $scratchLiveLog) {
        $existingLiveArtifacts += [ordered]@{ area = 'scratch'; name = 'STAGE-B-live.log'; source = $scratchLiveLog }
    }
    if ($null -ne $closedPriorStartup) {
        $existingLiveArtifacts += $closedPriorStartup
    }
    $archiveRelativePath = $null
    if ($existingLiveArtifacts.Count -gt 0) {
        if (-not $ClosedPriorRunId) {
            Fail 'existing live artifacts have no closed prior-run custody; refusing to replace them'
        }
        $archiveRelativePath = "archive\$ClosedPriorRunId"
        $archivePath = Join-Path $opsOnHost $archiveRelativePath
        if (Test-Path -LiteralPath $archivePath) {
            Fail 'prior-run archive already exists; refusing to overwrite preserved evidence'
        }
        New-Item -ItemType Directory -Path $archivePath | Out-Null
        foreach ($artifact in $existingLiveArtifacts) {
            $areaArchive = Join-Path $archivePath $artifact.area
            New-Item -ItemType Directory -Force -Path $areaArchive | Out-Null
            Move-Item -LiteralPath $artifact.source -Destination (Join-Path $areaArchive $artifact.name)
        }
    }

    $sourceMap = [ordered]@{
        'evidence1-stageb-live-launch.ps1' = $LiveLauncherSourcePath
        'evidence1-stageb-live-wrapper.ps1' = $LiveWrapperSourcePath
        'evidence1-live-run-contract.psm1' = $ContractSourcePath
    }
    if ($canary) {
        foreach ($name in @('evidence1-live-handoff-contract.psm1','evidence1-validation-ops.psm1')) { $sourceMap[$name] = Join-Path $PSScriptRoot $name }
        foreach ($name in $sourceMap.Keys) {
            if ((Get-FileHash -LiteralPath $sourceMap[$name] -Algorithm SHA256).Hash.ToLowerInvariant() -cne $canary.binding.scripts[$name]) { Fail 'canary asset drift' }
        }
        New-Item -ItemType Directory -Path $canaryOnHost -ErrorAction Stop | Out-Null
        foreach ($name in @('binding.json','wet.json','dry.json','readiness.json','handoff.claim.json')) {
            $source = Join-Path (Split-Path -Parent $CanaryBindingPath) $name
            $destination = Join-Path $canaryOnHost $name
            Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
            if ((Get-FileHash -LiteralPath $source).Hash -cne (Get-FileHash -LiteralPath $destination).Hash) { Fail 'canary evidence copy drift' }
        }
        $null = Read-Evidence1CanaryBundle $canaryOnHost $runId $CanaryArm $CanaryBindingSha256
    }
    foreach ($entry in $sourceMap.GetEnumerator()) {
        Copy-Item -LiteralPath $entry.Value -Destination (Join-Path $opsOnHost $entry.Key) -Force
        if ($canary) {
            $staged = Get-Item -LiteralPath (Join-Path $opsOnHost $entry.Key) -Force
            if (($staged.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $staged.LinkType -eq 'HardLink' -or
                (Get-FileHash -LiteralPath $staged.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $canary.binding.scripts[$entry.Key]) { Fail 'canary staged asset drift' }
        }
    }

    $wrapperGuestPath = Join-Path $GuestOpsDir 'evidence1-stageb-live-wrapper.ps1'
    $canaryArguments = if ($canary) { " -CanaryArm `"$CanaryArm`" -CanaryBindingSha256 `"$CanaryBindingSha256`"" } else { '' }
    if (-not $SkipStartupEntry) {
        Set-Content -LiteralPath $startupPath -Encoding ASCII -Value @"
@echo off
set "SELF=%~f0"
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$wrapperGuestPath" -RunId "$runId" -ShutdownOnExit$canaryArguments
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
        prior_run_custody = [ordered]@{
            state = if ($ClosedPriorRunId) { 'closed' } else { 'none' }
            run_id = if ($ClosedPriorRunId) { $ClosedPriorRunId } else { $null }
            archived_operational_artifacts = @($existingLiveArtifacts | ForEach-Object { "$($_.area)/$($_.name)" })
            archive_relative_path = $archiveRelativePath
        }
        replacement_or_respawn_used = $false
        launch_policy = if ($SkipStartupEntry) {
            'assets staged and run_id generated without Startup entry; launch must use the direct one-shot runner'
        } else {
            'one-shot Startup entry is consumed after the wrapper process exits; every state record is bound to run_id'
        }
    }
    if ($canary) { $report.canary = @{ binding_sha256 = $CanaryBindingSha256; binding = $canary.binding } }
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
    Write-Host "[hyperv-place-live-autorun] PASS: $ReportPath"
} finally {
    if ($mount) { Dismount-VHD -Path $vhdPath -ErrorAction SilentlyContinue }
}

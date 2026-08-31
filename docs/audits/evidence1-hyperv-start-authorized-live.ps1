#Requires -RunAsAdministrator

param(
    [Parameter(Mandatory = $true)][string]$ExpectedTargetCommit,
    [Parameter(Mandatory = $true)][string]$ExpectedTargetTree,
    [string]$LiveAuthorizationPhrase = '',
    [string]$CanaryArm = '',
    [string]$CanaryRunId = '',
    [string]$WetReportPath = '',
    [string]$DryReportPath = '',
    [string]$ExpectedWetReportSha256 = '',
    [string]$ExpectedDryReportSha256 = '',
    [ValidateRange(30, 900)][int]$GracefulShutdownTimeoutSeconds = 300,
    [ValidateRange(15, 300)][int]$StartTimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RequiredLivePhrase = (
    'AUTORIZO HASTA 8 SESIONES LIVE NUEVAS DEL EVIDENCE' +
    '1 CLAUDE WINDOWS PRODUCT-VS-FREE-BASELINE COVERAGE-THRESHOLD EN ESTE ENTORNO AISLADO, SIN REINTENTOS, REEMPLAZOS NI RESPAWNS'
)
$VMName = 'Evidence1-Runner'
$ExpectedSourceCommit = '7d45eae4f8720a0c77f507712ba2437ff974b6ed'
$ExpectedClaudeVersion = '2.1.238'
$ExpectedPlannedSessions = 8
$ExpectedAttestationPath = 'C:\kmp-eval\measurement-scopes\evidence1-claude-windows-isolation-attestation-stageb-v1.json'
$ReadinessReportPath = 'C:\kmp-eval\scratch\hyperv-regenerate-readiness-direct\HYPERV-REGENERATE-READINESS-DIRECT.json'
$AuthReportPath = 'C:\kmp-eval\scratch\hyperv-verify-guest-claude-auth-direct\HYPERV-VERIFY-GUEST-CLAUDE-AUTH-DIRECT.json'
$PlacementReportPath = 'C:\kmp-eval\scratch\hyperv-place-live-autorun\HYPERV-PLACE-LIVE-AUTORUN.json'
$CopyReportPath = 'C:\kmp-eval\scratch\hyperv-copy-live-artifacts\HYPERV-COPY-LIVE-ARTIFACTS.json'
$HandoffReportPath = 'C:\kmp-eval\scratch\hyperv-start-authorized-live\HYPERV-START-AUTHORIZED-LIVE.json'
$PlaceScriptPath = Join-Path $PSScriptRoot 'evidence1-hyperv-place-live-autorun.ps1'
$ReadinessMaxAgeMinutes = 60
$RemoteAuthMaxAgeMinutes = 30
$ContractPath = Join-Path $PSScriptRoot 'evidence1-live-handoff-contract.psm1'
Import-Module $ContractPath -Force
$script:Canary = $null
if ($CanaryArm -or $CanaryRunId -or $WetReportPath -or $DryReportPath -or $ExpectedWetReportSha256 -or $ExpectedDryReportSha256) {
    if ($CanaryArm -cnotin @('product','free-baseline') -or -not $CanaryRunId -or -not $WetReportPath -or -not $DryReportPath -or
        -not $ExpectedWetReportSha256 -or -not $ExpectedDryReportSha256) { throw 'canary_parameters_required' }
    Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1') -ErrorAction Stop
    Import-Module (Join-Path $PSScriptRoot 'evidence1-live-run-contract.psm1') -ErrorAction Stop
    $null = Resolve-E1Path $WetReportPath 'C:\kmp-eval\scratch\hyperv-verify-wet-gate-v2-direct'
    $null = Resolve-E1Path $DryReportPath 'C:\kmp-eval\scratch\hyperv-verify-canary-dryrun-v3-direct'
}

function Fail([string]$Message) {
    throw "HARD STOP: $Message"
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

function Read-JsonFile([string]$Path, [string]$Label, [switch]$Optional) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        if ($Optional) { return $null }
        Fail "$Label file is missing"
    }
    try {
        return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Fail "$Label file is not valid JSON"
    }
}

function Write-JsonAtomically([string]$Path, $Value) {
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporary = Join-Path $directory ((Split-Path -Leaf $Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::WriteAllText(
            $temporary,
            ($Value | ConvertTo-Json -Depth 12),
            [System.Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Get-VMStateName([string]$Name) {
    return [string](Get-VM -Name $Name -ErrorAction Stop).State
}

function Wait-VMState([string]$Name, [string]$ExpectedState, [int]$TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $actual = Get-VMStateName $Name
        if ($actual -eq $ExpectedState) { return $actual }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    Fail "$Name did not reach $ExpectedState within the bounded wait; current state is $actual"
}

function Write-HandoffState([string]$State, [string]$FailureKind = $null) {
    $recordedVMState = try { Get-VMStateName $VMName } catch { 'unknown' }
    $record = [ordered]@{
        schema = 1
        state = $State
        generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        vm_name = $VMName
        vm_state = $recordedVMState
        target_commit = $ExpectedTargetCommit
        target_tree = $ExpectedTargetTree
        run_id = $script:CurrentRunId
        prior_run_custody = $script:PriorCustody
        failure_kind = $FailureKind
        hard_power_fallback_used = $false
        replacement_or_respawn_used = $false
        raw_content_read = $false
    }
    if ($script:Canary) { $record.canary = @{ binding_sha256 = $script:Canary.sha256; binding = $script:Canary.binding } }
    Write-JsonAtomically $HandoffReportPath $record
}

function Invoke-PlaceLiveAutorun([string]$ClosedPriorRunId) {
    $arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $PlaceScriptPath,
        '-VMName', $VMName,
        '-ReportPath', $PlacementReportPath,
        '-LiveAuthorizationPhrase', $LiveAuthorizationPhrase
    )
    if (-not [string]::IsNullOrWhiteSpace($ClosedPriorRunId)) {
        $arguments += @('-ClosedPriorRunId', $ClosedPriorRunId)
    }
    if ($script:Canary) {
        $arguments += @('-CanaryArm', $CanaryArm, '-CanaryRunId', $CanaryRunId,
            '-CanaryBindingPath', (Join-Path $script:Canary.directory 'binding.json'), '-CanaryBindingSha256', $script:Canary.sha256)
    }

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& powershell.exe @arguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
        Fail "internal live autorun placement failed with exit code $exitCode"
    }
    return @($output)
}

function Archive-PreviousHandoff([string]$RunId) {
    $archiveDir = Join-Path (Split-Path -Parent $HandoffReportPath) 'archive'
    $archivePath = Join-Path $archiveDir "$RunId.json"
    if (Test-Path -LiteralPath $archivePath) {
        $currentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $HandoffReportPath).Hash
        $archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash
        if ($currentHash -eq $archiveHash) { return }
        Fail 'previous handoff archive already exists with different content'
    }
    New-Item -ItemType Directory -Force -Path $archiveDir | Out-Null
    Copy-Item -LiteralPath $HandoffReportPath -Destination $archivePath
}

foreach ($path in @(
    $ReadinessReportPath,
    $AuthReportPath,
    $PlacementReportPath,
    $CopyReportPath,
    $HandoffReportPath
)) {
    Assert-PathInside $path 'C:\kmp-eval\scratch\' 'operational report'
}
$PlaceScriptPath = Resolve-FullPath $PlaceScriptPath
$expectedPlaceScript = Resolve-FullPath (Join-Path $PSScriptRoot 'evidence1-hyperv-place-live-autorun.ps1')
if ($PlaceScriptPath -ne $expectedPlaceScript) {
    Fail 'PlaceScriptPath must resolve to the versioned internal placement script'
}
if (-not (Test-Path -LiteralPath $PlaceScriptPath -PathType Leaf)) {
    Fail 'internal live autorun placement script is missing'
}
if (-not $CanaryArm -and $LiveAuthorizationPhrase -ne $RequiredLivePhrase) {
    Fail 'exact Stage B live authorization phrase is required'
}

$readiness = Read-JsonFile $ReadinessReportPath 'readiness report'
$auth = Read-JsonFile $AuthReportPath 'remote auth report'
$placement = Read-JsonFile $PlacementReportPath 'prior placement report' -Optional
$copy = Read-JsonFile $CopyReportPath 'prior copy report' -Optional
$evidence = Assert-Evidence1LiveHandoffEvidence `
    -ReadinessReport $readiness `
    -AuthReport $auth `
    -ExpectedVMName $VMName `
    -ExpectedTargetCommit $ExpectedTargetCommit `
    -ExpectedTargetTree $ExpectedTargetTree `
    -ExpectedSourceCommit $ExpectedSourceCommit `
    -ExpectedClaudeVersion $ExpectedClaudeVersion `
    -ExpectedAttestationPath $ExpectedAttestationPath `
    -ExpectedPlannedSessions $ExpectedPlannedSessions `
    -ReadinessMaxAgeMinutes $ReadinessMaxAgeMinutes `
    -RemoteAuthMaxAgeMinutes $RemoteAuthMaxAgeMinutes
$script:PriorCustody = Assert-Evidence1PreviousRunCustody `
    -PlacementReport $placement `
    -CopyReport $copy `
    -ExpectedVMName $VMName
$script:CurrentRunId = if ($CanaryArm) { $CanaryRunId } else { $null }

$existingHandoff = Read-JsonFile $HandoffReportPath 'existing handoff report' -Optional
$archivePreviousHandoff = $false
if ($null -ne $existingHandoff) {
    $existingState = [string]$existingHandoff.state
    if ($existingState -ne 'started') {
        Fail "existing live handoff is not terminal: $existingState"
    }
    if ($script:PriorCustody.state -ne 'closed') {
        Fail 'previous started handoff has no copied terminal custody'
    }
    if ([string]$existingHandoff.run_id -ne [string]$script:PriorCustody.run_id) {
        Fail 'previous handoff and copied terminal custody run_id mismatch'
    }
    $archivePreviousHandoff = $true
}

if ($CanaryArm) {
    if ($CanaryRunId -eq $script:PriorCustody.run_id) { Fail 'canary cannot reuse a prior run_id' }
    $script:Canary = New-Evidence1CanaryHostBundle -Directory (Join-Path (Split-Path -Parent $HandoffReportPath) "canary\$CanaryRunId") `
        -RunId $CanaryRunId -Arm $CanaryArm -TargetCommit $ExpectedTargetCommit -TargetTree $ExpectedTargetTree `
        -WetReportPath $WetReportPath -DryReportPath $DryReportPath -ReadinessReportPath $ReadinessReportPath `
        -ExpectedWetReportSha256 $ExpectedWetReportSha256 -ExpectedDryReportSha256 $ExpectedDryReportSha256 -AuthorizationPhrase $LiveAuthorizationPhrase
}

$phase = 'initial_state'
try {
    $initialState = Get-VMStateName $VMName
    if ($initialState -ne 'Running') {
        Fail "authorized live handoff requires $VMName to be Running after readiness and auth verification, got $initialState"
    }
    if ($archivePreviousHandoff) {
        Archive-PreviousHandoff $script:PriorCustody.run_id
    }

    $phase = 'validated'
    Write-HandoffState 'validated'

    $phase = 'graceful_shutdown'
    Write-HandoffState 'stopping'
    $stopJob = Stop-VM -Name $VMName -Confirm:$false -AsJob
    try {
        $completed = Wait-Job -Job $stopJob -Timeout $GracefulShutdownTimeoutSeconds
        if (-not $completed) {
            Fail 'guest shutdown timed out; no hard-power fallback is permitted'
        }
        Receive-Job -Job $stopJob -ErrorAction Stop | Out-Null
    } finally {
        Remove-Job -Job $stopJob -Force -ErrorAction SilentlyContinue
    }
    $null = Wait-VMState $VMName 'Off' 30
    $phase = 'off'
    Write-HandoffState 'off'

    $phase = 'placing_autorun'
    if ($script:Canary) {
        $null = Read-Evidence1CanaryBundle $script:Canary.directory $CanaryRunId $CanaryArm $script:Canary.sha256
        if ((Read-Evidence1CanaryJson $ReadinessReportPath).sha256 -cne $script:Canary.binding.hashes.readiness_sha256) { Fail 'canary readiness changed during handoff' }
    }
    $null = Invoke-PlaceLiveAutorun $script:PriorCustody.run_id
    $newPlacement = Read-JsonFile $PlacementReportPath 'new placement report'
    if ($newPlacement.verdict -ne 'PASS') {
        Fail 'new placement report verdict is not PASS'
    }
    if ([string]$newPlacement.vm_name -ne $VMName) {
        Fail 'new placement report VM mismatch'
    }
    if ($newPlacement.startup_entry_created -ne $true) {
        Fail 'new placement did not create the one-shot Startup entry'
    }
    if ($newPlacement.replacement_or_respawn_used -ne $false) {
        Fail 'new placement reports a replacement or respawn'
    }
    if ([string]$newPlacement.prior_run_custody.run_id -ne [string]$script:PriorCustody.run_id) {
        Fail 'new placement prior-run custody mismatch'
    }
    $newRunId = [string]$newPlacement.run_id
    if ($script:Canary -and ($newRunId -cne $CanaryRunId -or $newPlacement.canary.binding_sha256 -cne $script:Canary.sha256)) {
        Fail 'canary placement binding mismatch'
    }
    $parsedRunId = [guid]::Empty
    if (-not [guid]::TryParseExact($newRunId, 'D', [ref]$parsedRunId)) {
        Fail 'new placement report run_id is not canonical'
    }
    if ($script:PriorCustody.run_id -and $newRunId -eq $script:PriorCustody.run_id) {
        Fail 'new placement reused the prior run_id'
    }
    $script:CurrentRunId = $newRunId
    $phase = 'armed'
    Write-HandoffState 'armed'

    $phase = 'starting'
    Start-VM -Name $VMName
    $null = Wait-VMState $VMName 'Running' $StartTimeoutSeconds
    $phase = 'started'
    Write-HandoffState 'started'

    [ordered]@{
        verdict = 'PASS'
        state = 'started'
        run_id = $script:CurrentRunId
        vm_name = $VMName
        vm_state = Get-VMStateName $VMName
        target_commit = $evidence.target_commit
        target_tree = $evidence.target_tree
        raw_content_read = $false
    } | ConvertTo-Json -Depth 6
} catch {
    try {
        Write-HandoffState 'failed' $phase
    } catch {
        # Preserve the original operational failure if the state record cannot be updated.
    }
    Write-Error $_.Exception.Message
    exit 1
}

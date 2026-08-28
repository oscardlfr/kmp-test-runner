Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Evidence1Property {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ($null -eq $Value) {
        throw "$Label is missing"
    }
    if ($Value -is [System.Collections.IDictionary]) {
        if (-not $Value.Contains($Name)) {
            throw "$Label.$Name is missing"
        }
        return $Value[$Name]
    }

    $property = $Value.PSObject.Properties[$Name]
    if ($null -eq $property) {
        throw "$Label.$Name is missing"
    }
    return $property.Value
}

function ConvertFrom-Evidence1UtcTimestamp {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $parsed = [DateTime]::MinValue
    $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    if (-not [DateTime]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) {
        throw "$Label is not a valid UTC timestamp"
    }
    return $parsed.ToUniversalTime()
}

function Assert-Evidence1FullSha {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ($Value -notmatch '^[0-9a-f]{40}$') {
        throw "$Label is not a lowercase full SHA"
    }
}

function Assert-Evidence1Sha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ($Value -notmatch '^[0-9a-f]{64}$') {
        throw "$Label is not a lowercase SHA-256"
    }
}

function Assert-Evidence1False {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ($Value -ne $false) {
        throw "$Label must be false"
    }
}

function Assert-Evidence1NoValues {
    param(
        $Value,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (@($Value | Where-Object { $null -ne $_ }).Count -ne 0) {
        throw "$Label must be empty"
    }
}

function Assert-Evidence1FreshTimestamp {
    param(
        [Parameter(Mandatory = $true)][DateTime]$TimestampUtc,
        [Parameter(Mandatory = $true)][DateTime]$NowUtc,
        [Parameter(Mandatory = $true)][int]$MaxAgeMinutes,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $age = $NowUtc.ToUniversalTime() - $TimestampUtc.ToUniversalTime()
    if ($age.TotalMinutes -lt -5) {
        throw "$Label is more than five minutes in the future"
    }
    if ($age.TotalMinutes -gt $MaxAgeMinutes) {
        throw "$Label is stale"
    }
    return [Math]::Max(0, [int][Math]::Floor($age.TotalSeconds))
}

function Assert-Evidence1LiveHandoffEvidence {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$ReadinessReport,
        [Parameter(Mandatory = $true)]$AuthReport,
        [Parameter(Mandatory = $true)][string]$ExpectedVMName,
        [Parameter(Mandatory = $true)][string]$ExpectedTargetCommit,
        [Parameter(Mandatory = $true)][string]$ExpectedTargetTree,
        [Parameter(Mandatory = $true)][string]$ExpectedSourceCommit,
        [Parameter(Mandatory = $true)][string]$ExpectedClaudeVersion,
        [Parameter(Mandatory = $true)][string]$ExpectedAttestationPath,
        [ValidateRange(1, 64)][int]$ExpectedPlannedSessions = 8,
        [DateTime]$NowUtc = [DateTime]::UtcNow,
        [ValidateRange(1, 1440)][int]$ReadinessMaxAgeMinutes = 60,
        [ValidateRange(1, 1440)][int]$RemoteAuthMaxAgeMinutes = 30
    )

    Assert-Evidence1FullSha $ExpectedTargetCommit 'expected target commit'
    Assert-Evidence1FullSha $ExpectedTargetTree 'expected target tree'
    Assert-Evidence1FullSha $ExpectedSourceCommit 'expected source commit'

    if ([string]::IsNullOrWhiteSpace($ExpectedVMName)) {
        throw 'expected VM name is empty'
    }
    if ([string]::IsNullOrWhiteSpace($ExpectedClaudeVersion)) {
        throw 'expected Claude version is empty'
    }
    $expectedAttestationFull = [System.IO.Path]::GetFullPath($ExpectedAttestationPath)

    if ((Get-Evidence1Property $ReadinessReport 'verdict' 'readiness') -ne 'PASS') {
        throw 'readiness verdict is not PASS'
    }
    if ([string](Get-Evidence1Property $ReadinessReport 'vm_name' 'readiness') -ne $ExpectedVMName) {
        throw 'readiness VM mismatch'
    }
    if ([string](Get-Evidence1Property $ReadinessReport 'vm_state' 'readiness') -ne 'Running') {
        throw 'readiness VM state is not Running'
    }
    $readinessGenerated = ConvertFrom-Evidence1UtcTimestamp `
        ([string](Get-Evidence1Property $ReadinessReport 'generated_at_utc' 'readiness')) `
        'readiness generated_at_utc'
    $readinessAgeSeconds = Assert-Evidence1FreshTimestamp `
        $readinessGenerated $NowUtc $ReadinessMaxAgeMinutes 'readiness report'

    $readinessCommit = [string](Get-Evidence1Property $ReadinessReport 'target_commit' 'readiness')
    $readinessTree = [string](Get-Evidence1Property $ReadinessReport 'target_tree' 'readiness')
    if ($readinessCommit -ne $ExpectedTargetCommit) {
        throw 'readiness target commit mismatch'
    }
    if ($readinessTree -ne $ExpectedTargetTree) {
        throw 'readiness target tree mismatch'
    }

    $guest = Get-Evidence1Property $ReadinessReport 'guest' 'readiness'
    if ((Get-Evidence1Property $guest 'verdict' 'readiness.guest') -ne 'PASS') {
        throw 'readiness guest verdict is not PASS'
    }
    if ([string](Get-Evidence1Property $guest 'harness_head' 'readiness.guest') -ne $ExpectedTargetCommit) {
        throw 'readiness guest harness commit mismatch'
    }
    if ([string](Get-Evidence1Property $guest 'harness_tree' 'readiness.guest') -ne $ExpectedTargetTree) {
        throw 'readiness guest harness tree mismatch'
    }
    if ([string](Get-Evidence1Property $guest 'source_head' 'readiness.guest') -ne $ExpectedSourceCommit) {
        throw 'readiness guest source commit mismatch'
    }
    if ((Get-Evidence1Property $guest 'planned_sessions' 'readiness.guest') -ne $ExpectedPlannedSessions) {
        throw 'readiness guest planned session count mismatch'
    }
    $guestTools = Get-Evidence1Property $guest 'tools' 'readiness.guest'
    if ([string](Get-Evidence1Property $guestTools 'claude' 'readiness.guest.tools') -ne $ExpectedClaudeVersion) {
        throw 'readiness guest Claude version mismatch'
    }
    $actualAttestationFull = [System.IO.Path]::GetFullPath(
        [string](Get-Evidence1Property $guest 'attestation_path' 'readiness.guest')
    )
    if (-not $actualAttestationFull.Equals($expectedAttestationFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'readiness guest attestation path mismatch'
    }
    Assert-Evidence1Sha256 `
        ([string](Get-Evidence1Property $guest 'attestation_sha256' 'readiness.guest')) `
        'readiness.guest.attestation_sha256'

    $readinessPrivacy = Get-Evidence1Property $ReadinessReport 'privacy' 'readiness'
    foreach ($name in @(
        'raw_transcript_content_read',
        'stderr_content_read',
        'attestation_content_printed',
        'dry_run_stdout_printed'
    )) {
        Assert-Evidence1False (Get-Evidence1Property $readinessPrivacy $name 'readiness.privacy') "readiness.privacy.$name"
    }

    if ((Get-Evidence1Property $AuthReport 'verdict' 'auth') -ne 'PASS') {
        throw 'auth verdict is not PASS'
    }
    if ([string](Get-Evidence1Property $AuthReport 'vm_name' 'auth') -ne $ExpectedVMName) {
        throw 'auth VM mismatch'
    }
    if ([string](Get-Evidence1Property $AuthReport 'vm_state' 'auth') -ne 'Running') {
        throw 'auth VM state is not Running'
    }
    $authGuest = Get-Evidence1Property $AuthReport 'guest_report' 'auth'
    if ((Get-Evidence1Property $authGuest 'verdict' 'auth.guest_report') -ne 'PASS') {
        throw 'auth guest verdict is not PASS'
    }
    if ([string](Get-Evidence1Property $authGuest 'claude_version' 'auth.guest_report') -ne $ExpectedClaudeVersion) {
        throw 'auth guest Claude version mismatch'
    }
    Assert-Evidence1NoValues `
        (Get-Evidence1Property $authGuest 'credential_override_names' 'auth.guest_report') `
        'auth guest credential overrides'
    Assert-Evidence1False `
        (Get-Evidence1Property $authGuest 'identity_fields_logged' 'auth.guest_report') `
        'auth.guest_report.identity_fields_logged'
    foreach ($name in @('ssh_dir_present', 'git_credentials_present', 'gh_hosts_present')) {
        Assert-Evidence1False `
            (Get-Evidence1Property $authGuest $name 'auth.guest_report') `
            "auth.guest_report.$name"
    }

    $canary = Get-Evidence1Property $authGuest 'remote_auth_canary' 'auth.guest_report'
    if ((Get-Evidence1Property $canary 'schema' 'auth.remote_auth_canary') -ne 1) {
        throw 'remote auth canary schema mismatch'
    }
    if ((Get-Evidence1Property $canary 'state' 'auth.remote_auth_canary') -ne 'passed') {
        throw 'remote auth canary did not pass'
    }
    if ((Get-Evidence1Property $canary 'local_auth_status_exit_code' 'auth.remote_auth_canary') -ne 0) {
        throw 'remote auth canary local auth status failed'
    }
    if ((Get-Evidence1Property $canary 'process_exit_code' 'auth.remote_auth_canary') -ne 0) {
        throw 'remote auth canary process failed'
    }
    if ([string](Get-Evidence1Property $canary 'claude_version' 'auth.remote_auth_canary') -ne $ExpectedClaudeVersion) {
        throw 'remote auth canary Claude version mismatch'
    }
    if ((Get-Evidence1Property $canary 'parse_error_count' 'auth.remote_auth_canary') -ne 0) {
        throw 'remote auth canary contains parse errors'
    }
    Assert-Evidence1NoValues `
        (Get-Evidence1Property $canary 'credential_override_names' 'auth.remote_auth_canary') `
        'remote auth canary credential overrides'
    $httpStatuses = @(Get-Evidence1Property $canary 'http_statuses' 'auth.remote_auth_canary')
    if (@($httpStatuses | Where-Object { $_ -eq 401 -or $_ -eq 403 }).Count -ne 0) {
        throw 'remote auth canary contains an authentication HTTP failure'
    }

    $terminal = Get-Evidence1Property $canary 'terminal' 'auth.remote_auth_canary'
    if ((Get-Evidence1Property $terminal 'present' 'auth.remote_auth_canary.terminal') -ne $true) {
        throw 'remote auth canary terminal event is missing'
    }
    if ((Get-Evidence1Property $terminal 'is_error' 'auth.remote_auth_canary.terminal') -ne $false) {
        throw 'remote auth canary terminal event is an error'
    }

    $canaryPrivacy = Get-Evidence1Property $canary 'privacy' 'auth.remote_auth_canary'
    Assert-Evidence1False `
        (Get-Evidence1Property $canaryPrivacy 'raw_content_persisted' 'auth.remote_auth_canary.privacy') `
        'auth.remote_auth_canary.privacy.raw_content_persisted'
    Assert-Evidence1False `
        (Get-Evidence1Property $canaryPrivacy 'raw_content_printed' 'auth.remote_auth_canary.privacy') `
        'auth.remote_auth_canary.privacy.raw_content_printed'
    Assert-Evidence1False `
        (Get-Evidence1Property $canaryPrivacy 'error_text_persisted' 'auth.remote_auth_canary.privacy') `
        'auth.remote_auth_canary.privacy.error_text_persisted'

    $canaryCompleted = ConvertFrom-Evidence1UtcTimestamp `
        ([string](Get-Evidence1Property $canary 'completed_at_utc' 'auth.remote_auth_canary')) `
        'remote auth canary completed_at_utc'
    $authAgeSeconds = Assert-Evidence1FreshTimestamp `
        $canaryCompleted $NowUtc $RemoteAuthMaxAgeMinutes 'remote auth canary'
    if ($canaryCompleted -lt $readinessGenerated) {
        throw 'remote auth canary predates readiness'
    }

    return [ordered]@{
        ok = $true
        target_commit = $ExpectedTargetCommit
        target_tree = $ExpectedTargetTree
        readiness_age_seconds = $readinessAgeSeconds
        remote_auth_age_seconds = $authAgeSeconds
        privacy_safe = $true
    }
}

function Assert-Evidence1PreviousRunCustody {
    [CmdletBinding()]
    param(
        $PlacementReport,
        $CopyReport,
        [Parameter(Mandatory = $true)][string]$ExpectedVMName
    )

    if ($null -eq $PlacementReport -and $null -eq $CopyReport) {
        return [ordered]@{ state = 'none'; run_id = $null; privacy_safe = $true }
    }
    if ($null -eq $PlacementReport) {
        throw 'copied terminal custody exists without a prior placement report'
    }
    if ($null -eq $CopyReport) {
        throw 'prior placement has no copied terminal custody'
    }
    if ((Get-Evidence1Property $PlacementReport 'verdict' 'prior placement') -ne 'PASS') {
        throw 'prior placement verdict is not PASS'
    }
    if ([string](Get-Evidence1Property $PlacementReport 'vm_name' 'prior placement') -ne $ExpectedVMName) {
        throw 'prior placement VM mismatch'
    }

    $runId = [string](Get-Evidence1Property $PlacementReport 'run_id' 'prior placement')
    $parsedRunId = [guid]::Empty
    if (-not [guid]::TryParseExact($runId, 'D', [ref]$parsedRunId)) {
        throw 'prior placement run_id is not canonical'
    }
    if ((Get-Evidence1Property $CopyReport 'verdict' 'prior copy') -ne 'PASS') {
        throw 'prior copy verdict is not PASS'
    }
    if ([string](Get-Evidence1Property $CopyReport 'vm_name' 'prior copy') -ne $ExpectedVMName) {
        throw 'prior copy VM mismatch'
    }
    Assert-Evidence1False `
        (Get-Evidence1Property $CopyReport 'raw_content_read' 'prior copy') `
        'prior copy raw_content_read'

    $stageBExit = Get-Evidence1Property $CopyReport 'stage_b_exit' 'prior copy'
    if ((Get-Evidence1Property $stageBExit 'valid' 'prior copy.stage_b_exit') -ne $true) {
        throw 'prior copy has no valid terminal custody'
    }
    $terminalRecord = Get-Evidence1Property $stageBExit 'record' 'prior copy.stage_b_exit'
    $terminalRunId = [string](Get-Evidence1Property $terminalRecord 'run_id' 'prior copy.stage_b_exit.record')
    if ($terminalRunId -ne $runId) {
        throw 'prior copy terminal run_id mismatch'
    }

    $placementAt = ConvertFrom-Evidence1UtcTimestamp `
        ([string](Get-Evidence1Property $PlacementReport 'generated_at_utc' 'prior placement')) `
        'prior placement generated_at_utc'
    $copyAt = ConvertFrom-Evidence1UtcTimestamp `
        ([string](Get-Evidence1Property $CopyReport 'generated_at_utc' 'prior copy')) `
        'prior copy generated_at_utc'
    if ($copyAt -lt $placementAt) {
        throw 'prior copy predates its placement'
    }

    return [ordered]@{
        state = 'closed'
        run_id = $runId
        privacy_safe = $true
    }
}

Export-ModuleMember -Function @(
    'Assert-Evidence1LiveHandoffEvidence',
    'Assert-Evidence1PreviousRunCustody'
)

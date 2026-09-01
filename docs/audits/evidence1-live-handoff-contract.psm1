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

function Get-Evidence1PinnedClaudeVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Label
    )

    # Claude Code reports its pinned semver either bare or followed by this stable product label.
    $match = [regex]::Match($Value, '^\s*(?<version>\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?\s*$')
    if (-not $match.Success) {
        throw "$Label is not a recognized Claude Code version"
    }
    return $match.Groups['version'].Value
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
    $expectedClaudeCanonical = Get-Evidence1PinnedClaudeVersion $ExpectedClaudeVersion 'expected Claude version'
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
    $readinessClaudeCanonical = Get-Evidence1PinnedClaudeVersion `
        ([string](Get-Evidence1Property $guestTools 'claude' 'readiness.guest.tools')) `
        'readiness guest Claude version'
    if ($readinessClaudeCanonical -ne $expectedClaudeCanonical) {
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
    $authClaudeCanonical = Get-Evidence1PinnedClaudeVersion `
        ([string](Get-Evidence1Property $authGuest 'claude_version' 'auth.guest_report')) `
        'auth guest Claude version'
    if ($authClaudeCanonical -ne $expectedClaudeCanonical) {
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
    $canaryClaudeCanonical = Get-Evidence1PinnedClaudeVersion `
        ([string](Get-Evidence1Property $canary 'claude_version' 'auth.remote_auth_canary')) `
        'remote auth canary Claude version'
    if ($canaryClaudeCanonical -ne $expectedClaudeCanonical) {
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

function Get-Evidence1ObjectKeys {
    param($Value)
    if ($Value -is [Collections.IDictionary]) { return @($Value.Keys | ForEach-Object { [string]$_ }) }
    if ($Value -is [pscustomobject]) { return @($Value.PSObject.Properties | ForEach-Object { $_.Name }) }
    throw 'canary custody object is invalid'
}

function Assert-Evidence1ExactKeys {
    param($Value, [string[]]$Expected, [string]$Label)
    $keys = @(Get-Evidence1ObjectKeys $Value)
    if ($keys.Count -ne $Expected.Count -or @($keys | Where-Object { $_ -cnotin $Expected }).Count -ne 0) {
        throw "$Label has an invalid shape"
    }
}

function Assert-Evidence1ExactBoolean {
    param($Value, [bool]$Expected, [string]$Label)
    if ($Value -isnot [bool] -or $Value -ne $Expected) { throw "$Label has an invalid boolean" }
}

function Assert-Evidence1ExactInteger {
    param($Value, [long]$Expected, [string]$Label)
    if (($Value -isnot [int] -and $Value -isnot [long]) -or [long]$Value -ne $Expected) {
        throw "$Label has an invalid integer"
    }
}

function Test-Evidence1DeepExact {
    param($Actual, $Expected)

    if ($null -eq $Actual -or $null -eq $Expected) { return $null -eq $Actual -and $null -eq $Expected }
    if ($Actual -is [bool] -or $Expected -is [bool]) {
        return $Actual -is [bool] -and $Expected -is [bool] -and $Actual -eq $Expected
    }
    if ($Actual -is [string] -or $Expected -is [string]) {
        return $Actual -is [string] -and $Expected -is [string] -and $Actual -ceq $Expected
    }
    $actualInteger = $Actual -is [int] -or $Actual -is [long]
    $expectedInteger = $Expected -is [int] -or $Expected -is [long]
    if ($actualInteger -or $expectedInteger) {
        return $actualInteger -and $expectedInteger -and [long]$Actual -eq [long]$Expected
    }
    $actualObject = $Actual -is [Collections.IDictionary] -or $Actual -is [pscustomobject]
    $expectedObject = $Expected -is [Collections.IDictionary] -or $Expected -is [pscustomobject]
    if ($actualObject -or $expectedObject) {
        if (-not $actualObject -or -not $expectedObject) { return $false }
        $actualKeys = @(Get-Evidence1ObjectKeys $Actual)
        $expectedKeys = @(Get-Evidence1ObjectKeys $Expected)
        if ($actualKeys.Count -ne $expectedKeys.Count -or
            @($actualKeys | Where-Object { $_ -cnotin $expectedKeys }).Count -ne 0) { return $false }
        foreach ($key in $actualKeys) {
            if (-not (Test-Evidence1DeepExact `
                (Get-Evidence1Property $Actual $key 'actual binding') `
                (Get-Evidence1Property $Expected $key 'expected binding'))) { return $false }
        }
        return $true
    }
    $actualArray = $Actual -is [System.Array] -or $Actual -is [Collections.IList]
    $expectedArray = $Expected -is [System.Array] -or $Expected -is [Collections.IList]
    if ($actualArray -or $expectedArray) {
        if (-not $actualArray -or -not $expectedArray) { return $false }
        $actualValues = @($Actual)
        $expectedValues = @($Expected)
        if ($actualValues.Count -ne $expectedValues.Count) { return $false }
        for ($index = 0; $index -lt $actualValues.Count; $index++) {
            if (-not (Test-Evidence1DeepExact $actualValues[$index] $expectedValues[$index])) { return $false }
        }
        return $true
    }
    if ($Actual.GetType() -ne $Expected.GetType()) { return $false }
    return $Actual -eq $Expected
}

function Get-Evidence1PlacementCanaryBinding {
    param($Placement, [string]$RunId, [string]$VMName)

    if ([string](Get-Evidence1Property $Placement 'verdict' 'prior placement') -cne 'PASS' -or
        [string](Get-Evidence1Property $Placement 'run_id' 'prior placement') -cne $RunId -or
        [string](Get-Evidence1Property $Placement 'vm_name' 'prior placement') -cne $VMName) {
        throw 'prior placement identity mismatch'
    }
    $canary = Get-Evidence1Property $Placement 'canary' 'prior placement'
    $bindingSha256 = [string](Get-Evidence1Property $canary 'binding_sha256' 'prior placement.canary')
    Assert-Evidence1Sha256 $bindingSha256 'prior placement canary binding'
    $binding = Get-Evidence1Property $canary 'binding' 'prior placement.canary'
    Assert-Evidence1ExactInteger (Get-Evidence1Property $binding 'schema' 'prior placement.canary.binding') 1 'prior placement.canary.binding.schema'
    Assert-Evidence1ExactInteger (Get-Evidence1Property $binding 'planned_sessions' 'prior placement.canary.binding') 1 'prior placement.canary.binding.planned_sessions'
    $arm = [string](Get-Evidence1Property $binding 'arm' 'prior placement.canary.binding')
    if ([string](Get-Evidence1Property $binding 'run_id' 'prior placement.canary.binding') -cne $RunId -or
        $arm -cnotin @('product','free-baseline')) { throw 'prior placement canary binding mismatch' }
    return [ordered]@{ arm = $arm; binding_sha256 = $bindingSha256; binding = $binding }
}

function Assert-Evidence1PriorHandoffCustody {
    [CmdletBinding()]
    param($Placement, $Handoff, [string]$RunId, [string]$VMName)

    $placementBinding = Get-Evidence1PlacementCanaryBinding $Placement $RunId $VMName
    Assert-Evidence1ExactKeys $Handoff @(
        'schema','state','generated_at_utc','vm_name','vm_state','target_commit','target_tree','run_id',
        'prior_run_custody','failure_kind','hard_power_fallback_used','replacement_or_respawn_used',
        'raw_content_read','canary'
    ) 'prior handoff'
    Assert-Evidence1ExactInteger (Get-Evidence1Property $Handoff 'schema' 'prior handoff') 1 'prior handoff.schema'
    if ([string](Get-Evidence1Property $Handoff 'state' 'prior handoff') -cne 'started' -or
        [string](Get-Evidence1Property $Handoff 'run_id' 'prior handoff') -cne $RunId -or
        [string](Get-Evidence1Property $Handoff 'vm_name' 'prior handoff') -cne $VMName) {
        throw 'prior handoff identity mismatch'
    }
    Assert-Evidence1ExactBoolean (Get-Evidence1Property $Handoff 'hard_power_fallback_used' 'prior handoff') $false 'prior handoff.hard_power_fallback_used'
    Assert-Evidence1ExactBoolean (Get-Evidence1Property $Handoff 'replacement_or_respawn_used' 'prior handoff') $false 'prior handoff.replacement_or_respawn_used'
    Assert-Evidence1ExactBoolean (Get-Evidence1Property $Handoff 'raw_content_read' 'prior handoff') $false 'prior handoff.raw_content_read'

    $handoffCanary = Get-Evidence1Property $Handoff 'canary' 'prior handoff'
    Assert-Evidence1ExactKeys $handoffCanary @('binding_sha256','binding') 'prior handoff.canary'
    if ([string](Get-Evidence1Property $handoffCanary 'binding_sha256' 'prior handoff.canary') -cne $placementBinding.binding_sha256) {
        throw 'prior handoff canary binding hash mismatch'
    }
    $handoffBinding = Get-Evidence1Property $handoffCanary 'binding' 'prior handoff.canary'
    if (-not (Test-Evidence1DeepExact $handoffBinding $placementBinding.binding)) {
        throw 'prior handoff canary binding mismatch'
    }
    return $placementBinding
}

function Assert-Evidence1CanaryCopyReportShape {
    param($CopyReport, [bool]$RequireCurrentShape)

    $legacyKeys = @(
        'schema','invocation_id','state','verdict','generated_at_utc','expected_run_id',
        'failure_phase','failure_code','failure_subreason','vm_name','vm_state','vhd_path',
        'mounted_drive','out_dir','copied','stage_b_exit','stage_b_exit_text','journal_dirs',
        'journal_event_summaries','journal_event_copies','scenario_files','scenario_copies',
        'incident_diagnostics','rejection_diagnostics','local_structured_rejection_details',
        'runs_inventory','raw_content_read','note','canary'
    )
    $currentKeys = @($legacyKeys + @(
        'graceful_shutdown_intent_recorded','graceful_shutdown_requested',
        'graceful_shutdown_completed','hard_power_fallback_used'
    ))
    $keys = @(Get-Evidence1ObjectKeys $CopyReport)
    $matchesCurrent = $keys.Count -eq $currentKeys.Count -and
        @($keys | Where-Object { $_ -cnotin $currentKeys }).Count -eq 0
    $matchesLegacy = $keys.Count -eq $legacyKeys.Count -and
        @($keys | Where-Object { $_ -cnotin $legacyKeys }).Count -eq 0
    if (-not $matchesCurrent -and ($RequireCurrentShape -or -not $matchesLegacy)) {
        throw 'prior copy has an invalid canary report shape'
    }
    Assert-Evidence1ExactInteger (Get-Evidence1Property $CopyReport 'schema' 'prior copy') 1 'prior copy.schema'
    if ($matchesCurrent) {
        foreach ($name in @('graceful_shutdown_intent_recorded','graceful_shutdown_requested','graceful_shutdown_completed','hard_power_fallback_used')) {
            $value = Get-Evidence1Property $CopyReport $name 'prior copy'
            if ($value -isnot [bool]) { throw "prior copy.$name has an invalid boolean" }
        }
        Assert-Evidence1ExactBoolean (Get-Evidence1Property $CopyReport 'hard_power_fallback_used' 'prior copy') $false 'prior copy.hard_power_fallback_used'
    }
}

function Assert-Evidence1CanaryStageExitShape {
    param($StageExit, $Terminal)
    Assert-Evidence1ExactKeys $StageExit @('valid','source','reason','exit_code','record') 'prior copy.stage_b_exit'
    Assert-Evidence1ExactBoolean (Get-Evidence1Property $StageExit 'valid' 'prior copy.stage_b_exit') $true 'prior copy.stage_b_exit.valid'
    if ($null -ne (Get-Evidence1Property $StageExit 'reason' 'prior copy.stage_b_exit')) {
        throw 'prior copy.stage_b_exit has an unexpected reason'
    }
    $source = [string](Get-Evidence1Property $StageExit 'source' 'prior copy.stage_b_exit')
    if ($source -ceq 'wrapper_terminal') {
        $terminalKeys = @(
            'schema','run_id','state','ts_utc','exit_code','exit_code_source',
            'wrapper_error_type','wrapper_error_stage','canary','diagnostics'
        )
    } elseif ($source -ceq 'launcher_terminal') {
        $terminalKeys = @('schema','run_id','state','ts_utc','exit_code','exit_code_source','canary','diagnostics')
    } else {
        throw 'prior copy.stage_b_exit has an invalid canary terminal source'
    }
    Assert-Evidence1ExactKeys $Terminal $terminalKeys 'prior copy.stage_b_exit.record'
    Assert-Evidence1ExactInteger (Get-Evidence1Property $Terminal 'schema' 'prior copy.stage_b_exit.record') 1 'prior copy.stage_b_exit.record.schema'
    $state = [string](Get-Evidence1Property $Terminal 'state' 'prior copy.stage_b_exit.record')
    if ($state -cnotin @('exited','wrapper_error','terminated_after_launcher_exit')) {
        throw 'prior copy.stage_b_exit.record is not terminal'
    }
    $exitCode = Get-Evidence1Property $StageExit 'exit_code' 'prior copy.stage_b_exit'
    $terminalExitCode = Get-Evidence1Property $Terminal 'exit_code' 'prior copy.stage_b_exit.record'
    if (($exitCode -isnot [int] -and $exitCode -isnot [long]) -or
        ($terminalExitCode -isnot [int] -and $terminalExitCode -isnot [long]) -or
        [long]$exitCode -ne [long]$terminalExitCode) {
        throw 'prior copy.stage_b_exit exit code mismatch'
    }
    $exitCodeSource = [string](Get-Evidence1Property $Terminal 'exit_code_source' 'prior copy.stage_b_exit.record')
    if ($exitCodeSource -cnotin @('launcher_record','process_exit_code','wrapper_error') -or
        ($source -ceq 'launcher_terminal' -and $exitCodeSource -cne 'launcher_record')) {
        throw 'prior copy.stage_b_exit.record has an invalid exit code source'
    }
    $null = ConvertFrom-Evidence1UtcTimestamp `
        ([string](Get-Evidence1Property $Terminal 'ts_utc' 'prior copy.stage_b_exit.record')) `
        'prior copy.stage_b_exit.record.ts_utc'
    Assert-Evidence1ExactKeys (Get-Evidence1Property $Terminal 'canary' 'prior copy.stage_b_exit.record') `
        @('arm','planned_sessions','binding_sha256') 'prior copy.stage_b_exit.record.canary'
}

function Assert-Evidence1CanaryFilesShape {
    param($Files)
    if ($null -eq $Files -or ($Files -isnot [Collections.IDictionary] -and $Files -isnot [pscustomobject])) {
        throw 'prior copy.canary.files is not an object'
    }
    $allowed = @(
        'binding.json','wet.json','dry.json','readiness.json','handoff.claim.json','wrapper.claim.json',
        'launcher.claim.json','source-custody.json','journal-baseline.json','journal.json'
    )
    foreach ($name in @(Get-Evidence1ObjectKeys $Files)) {
        if ($name -cnotin $allowed) { throw 'prior copy.canary.files contains an unknown file' }
        Assert-Evidence1Sha256 ([string](Get-Evidence1Property $Files $name 'prior copy.canary.files')) "prior copy.canary.files.$name"
    }
}

function Assert-Evidence1CanaryCopySummaryShape {
    param($Canary, [bool]$Incomplete)
    $keys = @('verified','complete','custody_state','run_id','arm','planned_sessions','binding_sha256',
        'attempt_consumed','retry_authorized','source_preserved','files')
    if ($Incomplete) { $keys = @($keys + @('failure_phase','failure_code')) }
    Assert-Evidence1ExactKeys $Canary $keys 'prior copy.canary'
    Assert-Evidence1ExactBoolean (Get-Evidence1Property $Canary 'attempt_consumed' 'prior copy.canary') $true 'prior copy.canary.attempt_consumed'
    Assert-Evidence1ExactBoolean (Get-Evidence1Property $Canary 'retry_authorized' 'prior copy.canary') $false 'prior copy.canary.retry_authorized'
    Assert-Evidence1ExactInteger (Get-Evidence1Property $Canary 'planned_sessions' 'prior copy.canary') 1 'prior copy.canary.planned_sessions'
    $files = Get-Evidence1Property $Canary 'files' 'prior copy.canary'
    Assert-Evidence1CanaryFilesShape $files
    $requiredFiles = @('binding.json','wet.json','dry.json','readiness.json','handoff.claim.json','wrapper.claim.json')
    $custodyState = [string](Get-Evidence1Property $Canary 'custody_state' 'prior copy.canary')
    if ($custodyState -ceq 'complete') {
        $requiredFiles = @($requiredFiles + @('launcher.claim.json','source-custody.json'))
    } elseif ($custodyState -ceq 'incomplete_wrapper_monitor') {
        $requiredFiles = @($requiredFiles + 'launcher.claim.json')
    } elseif ($custodyState -cne 'incomplete_wrapper_preflight') {
        throw 'prior copy.canary has an invalid custody state'
    }
    $fileKeys = @(Get-Evidence1ObjectKeys $files)
    if (@($requiredFiles | Where-Object { $_ -cnotin $fileKeys }).Count -gt 0) {
        throw 'prior copy.canary.files is incomplete for its custody state'
    }
}

function Assert-Evidence1IncompleteCanaryDiagnostics {
    param($Diagnostics, [string]$ExpectedPhase, [string]$ExpectedCode)

    $knownCodes = @(
        'canary_bundle_invalid','canary_guest_evidence_changed','canary_guest_attestation_changed',
        'canary_guest_implementation_changed','canary_guest_script_changed','canary_guest_validation_failed',
        'canary_guest_validation_changed','canary_guest_stdout_changed','canary_validation_overlap',
        'canary_tools_missing','canary_claude_version','canary_seed_missing','canary_journal_baseline',
        'canary_journal_overlap','canary_source_invalid','sdk_configuration','canary_dry_process',
        'canary_dry_plan_changed','canary_validation_changed','canary_process_cleanup',
        'canary_publication_incomplete','canary_journal_unobserved','canary_sdk_changed','canary_journal_event',
        'canary_publication_stalled','canary_journal_ambiguous','canary_path_link',
        'canary_journal_duplicate_transition','canary_journal_cell','canary_journal_changed',
        'canary_journal_run_mismatch','canary_journal_count','canary_publication_ambiguous',
        'canary_publication_size','canary_journal_planned','canary_journal_retiring',
        'canary_journal_retirement','canary_journal_retirement_stalled','canary_journal_observer',
        'canary_json_size','canary_journal_identity','canary_live_exit_nonzero',
        'canary_terminal_required','canary_terminal_binding','canary_progress_shape','canary_diagnostics_shape',
        'unclassified'
    )
    $knownPhases = @('guest_preflight','auth','source_clone','dry_plan','live_preflight','live','journal','postflight','custody_write','terminal_write')
    Assert-Evidence1ExactKeys $Diagnostics @('schema','failure_phase','failure_code','failures','processes','checks') 'prior copy diagnostics'
    Assert-Evidence1ExactInteger (Get-Evidence1Property $Diagnostics 'schema' 'prior copy diagnostics') 1 'prior copy diagnostics.schema'
    if ([string](Get-Evidence1Property $Diagnostics 'failure_phase' 'prior copy diagnostics') -cne $ExpectedPhase -or
        [string](Get-Evidence1Property $Diagnostics 'failure_code' 'prior copy diagnostics') -cne $ExpectedCode -or
        $ExpectedCode -cnotin $knownCodes) { throw 'prior copy diagnostics summary mismatch' }

    $failures = Get-Evidence1Property $Diagnostics 'failures' 'prior copy diagnostics'
    Assert-Evidence1ExactKeys $failures @('primary','cleanup','postflight','persistence') 'prior copy diagnostics.failures'
    $first = $null
    foreach ($slot in @('primary','cleanup','postflight','persistence')) {
        $failure = Get-Evidence1Property $failures $slot "prior copy diagnostics.failures.$slot"
        if ($null -eq $failure) { continue }
        Assert-Evidence1ExactKeys $failure @('phase','code') "prior copy diagnostics.failures.$slot"
        $phase = [string](Get-Evidence1Property $failure 'phase' "prior copy diagnostics.failures.$slot")
        $code = [string](Get-Evidence1Property $failure 'code' "prior copy diagnostics.failures.$slot")
        if ($phase -cnotin $knownPhases -or $code -cnotin $knownCodes) { throw 'prior copy diagnostics contains an unknown failure' }
        if ($null -eq $first) { $first = [ordered]@{ phase = $phase; code = $code } }
    }
    if ($null -eq $first -or $first.phase -cne $ExpectedPhase -or $first.code -cne $ExpectedCode) {
        throw 'prior copy diagnostics primary failure mismatch'
    }

    $processes = Get-Evidence1Property $Diagnostics 'processes' 'prior copy diagnostics'
    Assert-Evidence1ExactKeys $processes @('dry_plan','live') 'prior copy diagnostics.processes'
    foreach ($slot in @('dry_plan','live')) {
        $process = Get-Evidence1Property $processes $slot "prior copy diagnostics.processes.$slot"
        if ($null -eq $process) { continue }
        Assert-Evidence1ExactKeys $process @('exit_code','wall_seconds','timed_out','cleanup_ok') "prior copy diagnostics.processes.$slot"
        $exit = Get-Evidence1Property $process 'exit_code' "prior copy diagnostics.processes.$slot"
        $wall = Get-Evidence1Property $process 'wall_seconds' "prior copy diagnostics.processes.$slot"
        if (($exit -isnot [int] -and $exit -isnot [long]) -or
            ($wall -isnot [double] -and $wall -isnot [decimal] -and $wall -isnot [int] -and $wall -isnot [long]) -or
            [double]::IsNaN([double]$wall) -or [double]::IsInfinity([double]$wall) -or
            [double]$wall -lt 0 -or [double]$wall -gt 86400) { throw 'prior copy diagnostics process mismatch' }
        $timedOut = Get-Evidence1Property $process 'timed_out' "prior copy diagnostics.processes.$slot"
        $cleanup = Get-Evidence1Property $process 'cleanup_ok' "prior copy diagnostics.processes.$slot"
        if ($timedOut -isnot [bool] -or $cleanup -isnot [bool]) { throw 'prior copy diagnostics process boolean mismatch' }
    }

    $checks = Get-Evidence1Property $Diagnostics 'checks' 'prior copy diagnostics'
    Assert-Evidence1ExactKeys $checks @('source_preserved','custody_written','terminal_written') 'prior copy diagnostics.checks'
    foreach ($name in @('source_preserved','custody_written','terminal_written')) {
        $value = Get-Evidence1Property $checks $name "prior copy diagnostics.checks.$name"
        if ($null -ne $value -and $value -isnot [bool]) { throw 'prior copy diagnostics check mismatch' }
    }
}

function Assert-Evidence1ClosedCanaryDiagnostics {
    param($Diagnostics)
    $phase = Get-Evidence1Property $Diagnostics 'failure_phase' 'prior copy diagnostics'
    $code = Get-Evidence1Property $Diagnostics 'failure_code' 'prior copy diagnostics'
    if ($null -ne $phase -or $null -ne $code) {
        if ($phase -isnot [string] -or $code -isnot [string]) { throw 'prior copy diagnostics failure mismatch' }
        Assert-Evidence1IncompleteCanaryDiagnostics $Diagnostics $phase $code
        return
    }

    Assert-Evidence1ExactKeys $Diagnostics @('schema','failure_phase','failure_code','failures','processes','checks') 'prior copy diagnostics'
    Assert-Evidence1ExactInteger (Get-Evidence1Property $Diagnostics 'schema' 'prior copy diagnostics') 1 'prior copy diagnostics.schema'
    $failures = Get-Evidence1Property $Diagnostics 'failures' 'prior copy diagnostics'
    Assert-Evidence1ExactKeys $failures @('primary','cleanup','postflight','persistence') 'prior copy diagnostics.failures'
    foreach ($slot in @('primary','cleanup','postflight','persistence')) {
        if ($null -ne (Get-Evidence1Property $failures $slot "prior copy diagnostics.failures.$slot")) {
            throw 'prior copy diagnostics has an unclassified failure'
        }
    }
    $processes = Get-Evidence1Property $Diagnostics 'processes' 'prior copy diagnostics'
    Assert-Evidence1ExactKeys $processes @('dry_plan','live') 'prior copy diagnostics.processes'
    foreach ($slot in @('dry_plan','live')) {
        $process = Get-Evidence1Property $processes $slot "prior copy diagnostics.processes.$slot"
        if ($null -eq $process) { continue }
        Assert-Evidence1ExactKeys $process @('exit_code','wall_seconds','timed_out','cleanup_ok') "prior copy diagnostics.processes.$slot"
        $exit = Get-Evidence1Property $process 'exit_code' "prior copy diagnostics.processes.$slot"
        $wall = Get-Evidence1Property $process 'wall_seconds' "prior copy diagnostics.processes.$slot"
        if (($exit -isnot [int] -and $exit -isnot [long]) -or
            ($wall -isnot [double] -and $wall -isnot [decimal] -and $wall -isnot [int] -and $wall -isnot [long]) -or
            [double]::IsNaN([double]$wall) -or [double]::IsInfinity([double]$wall) -or
            [double]$wall -lt 0 -or [double]$wall -gt 86400) { throw 'prior copy diagnostics process mismatch' }
        foreach ($name in @('timed_out','cleanup_ok')) {
            if ((Get-Evidence1Property $process $name "prior copy diagnostics.processes.$slot") -isnot [bool]) {
                throw 'prior copy diagnostics process boolean mismatch'
            }
        }
    }
    $checks = Get-Evidence1Property $Diagnostics 'checks' 'prior copy diagnostics'
    Assert-Evidence1ExactKeys $checks @('source_preserved','custody_written','terminal_written') 'prior copy diagnostics.checks'
    foreach ($name in @('source_preserved','custody_written','terminal_written')) {
        $value = Get-Evidence1Property $checks $name "prior copy diagnostics.checks.$name"
        if ($null -ne $value -and $value -isnot [bool]) { throw 'prior copy diagnostics check mismatch' }
    }
}

function Assert-Evidence1IncompleteCanaryCopy {
    param($PlacementReport, $CopyReport, [string]$RunId, [string]$ExpectedVMName)

    Assert-Evidence1CanaryCopyReportShape $CopyReport $true
    if ([string](Get-Evidence1Property $CopyReport 'state' 'prior copy') -cne 'failed' -or
        [string](Get-Evidence1Property $CopyReport 'vm_name' 'prior copy') -cne $ExpectedVMName -or
        [string](Get-Evidence1Property $CopyReport 'expected_run_id' 'prior copy') -cne $RunId -or
        [string](Get-Evidence1Property $CopyReport 'failure_phase' 'prior copy') -cne 'canary_custody' -or
        [string](Get-Evidence1Property $CopyReport 'failure_code' 'prior copy') -cne 'canary_custody_incomplete') {
        throw 'prior copy is not an exact incomplete canary custody report'
    }
    Assert-Evidence1ExactBoolean (Get-Evidence1Property $CopyReport 'raw_content_read' 'prior copy') $false 'prior copy.raw_content_read'

    $placementBinding = Get-Evidence1PlacementCanaryBinding $PlacementReport $RunId $ExpectedVMName
    $bindingSha256 = $placementBinding.binding_sha256
    $arm = $placementBinding.arm

    $canary = Get-Evidence1Property $CopyReport 'canary' 'prior copy'
    Assert-Evidence1CanaryCopySummaryShape $canary $true
    Assert-Evidence1ExactBoolean (Get-Evidence1Property $canary 'verified' 'prior copy.canary') $false 'prior copy.canary.verified'
    Assert-Evidence1ExactBoolean (Get-Evidence1Property $canary 'complete' 'prior copy.canary') $false 'prior copy.canary.complete'
    Assert-Evidence1ExactBoolean (Get-Evidence1Property $canary 'attempt_consumed' 'prior copy.canary') $true 'prior copy.canary.attempt_consumed'
    Assert-Evidence1ExactBoolean (Get-Evidence1Property $canary 'retry_authorized' 'prior copy.canary') $false 'prior copy.canary.retry_authorized'
    Assert-Evidence1ExactBoolean (Get-Evidence1Property $canary 'source_preserved' 'prior copy.canary') $false 'prior copy.canary.source_preserved'
    Assert-Evidence1ExactInteger (Get-Evidence1Property $canary 'planned_sessions' 'prior copy.canary') 1 'prior copy.canary.planned_sessions'
    if ([string](Get-Evidence1Property $canary 'run_id' 'prior copy.canary') -cne $RunId -or
        [string](Get-Evidence1Property $canary 'arm' 'prior copy.canary') -cne $arm -or
        [string](Get-Evidence1Property $canary 'binding_sha256' 'prior copy.canary') -cne $bindingSha256) {
        throw 'prior copy canary binding mismatch'
    }

    $custodyState = [string](Get-Evidence1Property $canary 'custody_state' 'prior copy.canary')
    $failurePhase = [string](Get-Evidence1Property $canary 'failure_phase' 'prior copy.canary')
    $failureCode = [string](Get-Evidence1Property $canary 'failure_code' 'prior copy.canary')
    if ([string](Get-Evidence1Property $CopyReport 'failure_subreason' 'prior copy') -cne $failureCode) {
        throw 'prior copy canary failure code mismatch'
    }

    $exit = Get-Evidence1Property $CopyReport 'stage_b_exit' 'prior copy'
    $terminal = Get-Evidence1Property $exit 'record' 'prior copy.stage_b_exit'
    Assert-Evidence1CanaryStageExitShape $exit $terminal
    Assert-Evidence1ExactInteger (Get-Evidence1Property $terminal 'schema' 'prior copy.stage_b_exit.record') 1 'prior copy.stage_b_exit.record.schema'
    Assert-Evidence1ExactInteger (Get-Evidence1Property $terminal 'exit_code' 'prior copy.stage_b_exit.record') 997 'prior copy.stage_b_exit.record.exit_code'
    if ([string](Get-Evidence1Property $terminal 'run_id' 'prior copy.stage_b_exit.record') -cne $RunId -or
        [string](Get-Evidence1Property $terminal 'state' 'prior copy.stage_b_exit.record') -cne 'wrapper_error' -or
        [string](Get-Evidence1Property $terminal 'exit_code_source' 'prior copy.stage_b_exit.record') -cne 'wrapper_error') {
        throw 'prior copy terminal is not the exact wrapper failure'
    }
    $terminalCanary = Get-Evidence1Property $terminal 'canary' 'prior copy.stage_b_exit.record'
    Assert-Evidence1ExactInteger (Get-Evidence1Property $terminalCanary 'planned_sessions' 'prior copy.stage_b_exit.record.canary') 1 'prior copy.stage_b_exit.record.canary.planned_sessions'
    if ([string](Get-Evidence1Property $terminalCanary 'arm' 'prior copy.stage_b_exit.record.canary') -cne $arm -or
        [string](Get-Evidence1Property $terminalCanary 'binding_sha256' 'prior copy.stage_b_exit.record.canary') -cne $bindingSha256) {
        throw 'prior copy terminal canary binding mismatch'
    }

    $stage = [string](Get-Evidence1Property $terminal 'wrapper_error_stage' 'prior copy.stage_b_exit.record')
    if ($custodyState -ceq 'incomplete_wrapper_preflight') {
        if ($stage -cnotin @('prepare_ops_directory','initialize_journal') -or $failurePhase -cne 'guest_preflight') {
            throw 'prior copy preflight custody mismatch'
        }
    } elseif ($custodyState -ceq 'incomplete_wrapper_monitor') {
        if ($stage -cne 'monitor_launcher' -or $failurePhase -cne 'journal') {
            throw 'prior copy monitor custody mismatch'
        }
    } else { throw 'prior copy canary custody state mismatch' }
    Assert-Evidence1IncompleteCanaryDiagnostics `
        (Get-Evidence1Property $terminal 'diagnostics' 'prior copy.stage_b_exit.record') $failurePhase $failureCode

    return [ordered]@{ arm = $arm; binding_sha256 = $bindingSha256 }
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
    $copyVerdict = [string](Get-Evidence1Property $CopyReport 'verdict' 'prior copy')
    if ($copyVerdict -ceq 'FAIL') {
        $failed = Assert-Evidence1IncompleteCanaryCopy $PlacementReport $CopyReport $runId $ExpectedVMName
        $placementAt = ConvertFrom-Evidence1UtcTimestamp `
            ([string](Get-Evidence1Property $PlacementReport 'generated_at_utc' 'prior placement')) `
            'prior placement generated_at_utc'
        $copyAt = ConvertFrom-Evidence1UtcTimestamp `
            ([string](Get-Evidence1Property $CopyReport 'generated_at_utc' 'prior copy')) `
            'prior copy generated_at_utc'
        if ($copyAt -lt $placementAt) { throw 'prior copy predates its placement' }
        return [ordered]@{
            state = 'closed'; run_id = $runId; privacy_safe = $true
            attempt_status = 'failed'; canary_custody = 'incomplete'
            arm = $failed.arm; planned_sessions = 1; binding_sha256 = $failed.binding_sha256
        }
    }
    if ($copyVerdict -cne 'PASS') {
        throw 'prior copy verdict is neither PASS nor a closed canary failure'
    }
    if ([string](Get-Evidence1Property $CopyReport 'vm_name' 'prior copy') -ne $ExpectedVMName) {
        throw 'prior copy VM mismatch'
    }
    Assert-Evidence1ExactBoolean `
        (Get-Evidence1Property $CopyReport 'raw_content_read' 'prior copy') `
        $false `
        'prior copy.raw_content_read'

    $stageBExit = Get-Evidence1Property $CopyReport 'stage_b_exit' 'prior copy'
    if ((Get-Evidence1Property $stageBExit 'valid' 'prior copy.stage_b_exit') -ne $true) {
        throw 'prior copy has no valid terminal custody'
    }
    $terminalRecord = Get-Evidence1Property $stageBExit 'record' 'prior copy.stage_b_exit'
    $terminalRunId = [string](Get-Evidence1Property $terminalRecord 'run_id' 'prior copy.stage_b_exit.record')
    if ($terminalRunId -ne $runId) {
        throw 'prior copy terminal run_id mismatch'
    }
    $canaryProperty = if ($PlacementReport -is [Collections.IDictionary]) { $PlacementReport['canary'] } else { $PlacementReport.PSObject.Properties['canary'] }
    if ($null -ne $canaryProperty) {
        $placementBinding = Get-Evidence1PlacementCanaryBinding $PlacementReport $runId $ExpectedVMName
        Assert-Evidence1CanaryCopyReportShape $CopyReport $true
        if ([string](Get-Evidence1Property $CopyReport 'state' 'prior copy') -cne 'passed' -or
            [string](Get-Evidence1Property $CopyReport 'expected_run_id' 'prior copy') -cne $runId -or
            [string](Get-Evidence1Property $CopyReport 'vm_state' 'prior copy') -cne 'Off' -or
            $null -ne (Get-Evidence1Property $CopyReport 'failure_phase' 'prior copy') -or
            $null -ne (Get-Evidence1Property $CopyReport 'failure_code' 'prior copy') -or
            $null -ne (Get-Evidence1Property $CopyReport 'failure_subreason' 'prior copy')) {
            throw 'canary prior copy PASS state is inconsistent'
        }
        $shutdownIntent = Get-Evidence1Property $CopyReport 'graceful_shutdown_intent_recorded' 'prior copy'
        $shutdownRequested = Get-Evidence1Property $CopyReport 'graceful_shutdown_requested' 'prior copy'
        $shutdownCompleted = Get-Evidence1Property $CopyReport 'graceful_shutdown_completed' 'prior copy'
        foreach ($entry in @(
            @{ name = 'graceful_shutdown_intent_recorded'; value = $shutdownIntent },
            @{ name = 'graceful_shutdown_requested'; value = $shutdownRequested },
            @{ name = 'graceful_shutdown_completed'; value = $shutdownCompleted }
        )) {
            if ($entry.value -isnot [bool]) { throw "prior copy.$($entry.name) has an invalid boolean" }
        }
        $alreadyOff = -not $shutdownIntent -and -not $shutdownRequested -and -not $shutdownCompleted
        $gracefullyStopped = $shutdownIntent -and $shutdownRequested -and $shutdownCompleted
        if (-not $alreadyOff -and -not $gracefullyStopped) {
            throw 'canary prior copy shutdown state is inconsistent'
        }
        Assert-Evidence1CanaryStageExitShape $stageBExit $terminalRecord
        $canaryCopy = Get-Evidence1Property $CopyReport 'canary' 'prior copy'
        Assert-Evidence1CanaryCopySummaryShape $canaryCopy $false
        Assert-Evidence1ExactBoolean (Get-Evidence1Property $canaryCopy 'verified' 'canary copy') $true 'canary copy.verified'
        Assert-Evidence1ExactBoolean (Get-Evidence1Property $canaryCopy 'complete' 'canary copy') $true 'canary copy.complete'
        Assert-Evidence1ExactBoolean (Get-Evidence1Property $canaryCopy 'source_preserved' 'canary copy') $true 'canary copy.source_preserved'
        if ([string](Get-Evidence1Property $canaryCopy 'custody_state' 'canary copy') -cne 'complete' -or
            [string](Get-Evidence1Property $canaryCopy 'run_id' 'canary copy') -cne $runId -or
            [string](Get-Evidence1Property $canaryCopy 'arm' 'canary copy') -cne $placementBinding.arm -or
            [string](Get-Evidence1Property $canaryCopy 'binding_sha256' 'canary copy') -cne $placementBinding.binding_sha256) {
            throw 'canary prior custody mismatch'
        }
        Assert-Evidence1ExactInteger (Get-Evidence1Property $terminalRecord 'schema' 'prior copy.stage_b_exit.record') 1 'prior copy.stage_b_exit.record.schema'
        $terminalCanary = Get-Evidence1Property $terminalRecord 'canary' 'prior copy.stage_b_exit.record'
        Assert-Evidence1ExactInteger (Get-Evidence1Property $terminalCanary 'planned_sessions' 'prior copy.stage_b_exit.record.canary') 1 'prior copy.stage_b_exit.record.canary.planned_sessions'
        if ([string](Get-Evidence1Property $terminalRecord 'run_id' 'prior copy.stage_b_exit.record') -cne $runId -or
            [string](Get-Evidence1Property $terminalCanary 'arm' 'prior copy.stage_b_exit.record.canary') -cne $placementBinding.arm -or
            [string](Get-Evidence1Property $terminalCanary 'binding_sha256' 'prior copy.stage_b_exit.record.canary') -cne $placementBinding.binding_sha256) {
            throw 'prior copy terminal canary binding mismatch'
        }
        Assert-Evidence1ClosedCanaryDiagnostics (Get-Evidence1Property $terminalRecord 'diagnostics' 'prior copy.stage_b_exit.record')
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

function New-Evidence1CanaryBinding {
    param([string]$Arm, [string]$RunId, [string]$TargetCommit, [string]$TargetTree,
        $WetReport, $DryReport, $ReadinessReport, [string]$WetReportSha256,
        [string]$DryReportSha256, [string]$ReadinessSha256)

    # Stage L adds a one-cell gate; it does not reinterpret the eight-cell V1 ledger.
    try {
        Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1') -ErrorAction Stop
        if ($Arm -cnotin @('product','free-baseline')) { throw 'arm' }
        $id = [guid]::Empty
        if (-not [guid]::TryParseExact($RunId, 'D', [ref]$id) -or $id -eq [guid]::Empty -or $RunId -cne $id.ToString('D')) { throw 'run' }
        foreach ($sha in @($TargetCommit,$TargetTree)) { if ($sha -cnotmatch '^[a-f0-9]{40}$') { throw 'anchor' } }
        foreach ($sha in @($WetReportSha256,$DryReportSha256,$ReadinessSha256)) { if ($sha -cnotmatch '^[a-f0-9]{64}$') { throw 'hash' } }
        Assert-E1Fields $WetReport @{ schema = 2; state = 'passed' }
        Assert-E1Fields $DryReport @{ schema = 2; state = 'passed' }
        $wet = ConvertTo-E1SafeResult $WetReport 'wet-v2' $TargetCommit $TargetTree
        $dry = ConvertTo-E1SafeResult $DryReport 'dry-v3' $TargetCommit $TargetTree
        Assert-E1Fields $ReadinessReport @{ verdict = 'PASS'; vm_name = 'Evidence1-Runner'; vm_state = 'Running'; target_commit = $TargetCommit; target_tree = $TargetTree }
        Assert-E1Fields (Get-E1Field $ReadinessReport 'guest') @{
            verdict = 'PASS'; planned_sessions = 8; harness_head = $TargetCommit; harness_tree = $TargetTree
            source_head = $wet.source_commit; attestation_sha256 = $wet.hashes.attestation_canonical_sha256
        }
        $shared = [ordered]@{}
        foreach ($key in @('readiness_sha256','ledger_sha256','attestation_sha256','attestation_canonical_sha256',
            'validation_module_sha256','scenario_sha256','product_entry_sha256','execution_profile_sha256','execution_profile_registry_sha256')) {
            if ($wet.hashes[$key] -cne $dry.hashes[$key]) { throw 'report_binding' }
            $shared[$key] = $wet.hashes[$key]
        }
        if ($shared.readiness_sha256 -cne $ReadinessSha256) { throw 'readiness_binding' }
        $scripts = [ordered]@{}
        foreach ($name in @('evidence1-stageb-live-launch.ps1','evidence1-stageb-live-wrapper.ps1',
            'evidence1-live-run-contract.psm1','evidence1-live-handoff-contract.psm1','evidence1-validation-ops.psm1')) {
            $scripts[$name] = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        if ($shared.validation_module_sha256 -cne $scripts['evidence1-validation-ops.psm1']) { throw 'local_validation_module' }
        $product = $Arm -ceq 'product'
        return [ordered]@{
            schema = 1; run_id = $RunId; arm = $Arm; target_commit = $TargetCommit; target_tree = $TargetTree
            source_commit = $wet.source_commit; campaign_design_id = "claude-$Arm-canary-v1"
            scenario_id = 'coverage-threshold-failure-v2'; planned_sessions = 1; repeats = 1
            cell_label = $(if ($product) { 'A' } else { 'B' })
            condition = $(if ($product) { 'current-skill' } else { 'no-skill' })
            product_access_mode = $(if ($product) { 'product-assisted' } else { 'free-baseline-no-product' })
            execution_profile_id = 'sandboxed-unrestricted-v1'; seed = 20260821; max_budget_usd = 2
            wet_report_sha256 = $WetReportSha256; dry_report_sha256 = $DryReportSha256
            plan_sha256 = $(if ($product) { $dry.hashes.product_stdout_sha256 } else { $dry.hashes.free_baseline_stdout_sha256 })
            hashes = $shared; scripts = $scripts
        }
    } catch { throw 'canary_evidence_invalid' }
}

function Get-Evidence1CanaryAuthorizationLiteral($Binding) {
    if ($Binding.arm -cnotin @('product','free-baseline') -or $Binding.planned_sessions -ne 1) { throw 'canary_authorization_scope' }
    return "AUTORIZO 1 SESION LIVE NUEVA DEL Evidence1 CLAUDE WINDOWS CANARY $($Binding.arm), SIN REINTENTOS, REEMPLAZOS NI RESPAWNS"
}

function Assert-Evidence1CanaryAuthorization($Binding, [string]$Phrase) {
    if ($Phrase -cne (Get-Evidence1CanaryAuthorizationLiteral $Binding)) { throw 'canary_authorization_required' }
}

Export-ModuleMember -Function @(
    'Assert-Evidence1LiveHandoffEvidence',
    'Assert-Evidence1PreviousRunCustody',
    'Assert-Evidence1PriorHandoffCustody',
    'New-Evidence1CanaryBinding',
    'Get-Evidence1CanaryAuthorizationLiteral',
    'Assert-Evidence1CanaryAuthorization'
)

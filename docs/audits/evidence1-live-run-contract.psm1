Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Evidence1JsonAtomically {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        $Value
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $directory = Split-Path -Parent $fullPath
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }

    $tempPath = Join-Path $directory ('.{0}.{1}.tmp' -f [System.IO.Path]::GetFileName($fullPath), [guid]::NewGuid().ToString('N'))
    try {
        $json = $Value | ConvertTo-Json -Depth 12 -Compress
        [System.IO.File]::WriteAllText($tempPath, $json, [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tempPath -Destination $fullPath -Force
    } finally {
        Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    }
}

function Read-Evidence1TerminalRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [string]$ExpectedRunId
    )

    $expectedGuid = [guid]::Empty
    if (-not [guid]::TryParseExact($ExpectedRunId, 'D', [ref]$expectedGuid)) {
        throw 'ExpectedRunId must be a canonical D-format GUID'
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [ordered]@{ valid = $false; reason = 'not_found'; exit_code = $null; record = $null }
    }

    try {
        $record = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return [ordered]@{ valid = $false; reason = 'invalid_json'; exit_code = $null; record = $null }
    }

    $required = @('schema', 'run_id', 'state', 'exit_code', 'exit_code_source')
    $propertyNames = @($record.PSObject.Properties.Name)
    if (@($required | Where-Object { $_ -notin $propertyNames }).Count -gt 0) {
        return [ordered]@{ valid = $false; reason = 'invalid_shape'; exit_code = $null; record = $record }
    }
    if (($record.schema -isnot [int] -and $record.schema -isnot [long]) -or [long]$record.schema -ne 1) {
        return [ordered]@{ valid = $false; reason = 'invalid_schema'; exit_code = $null; record = $record }
    }
    if ($record.run_id -ne $ExpectedRunId) {
        return [ordered]@{ valid = $false; reason = 'run_id_mismatch'; exit_code = $null; record = $record }
    }
    if ($record.state -notin @('exited', 'wrapper_error', 'terminated_after_launcher_exit')) {
        return [ordered]@{ valid = $false; reason = 'non_terminal_state'; exit_code = $null; record = $record }
    }
    if ($record.exit_code -isnot [int] -and $record.exit_code -isnot [long]) {
        return [ordered]@{ valid = $false; reason = 'invalid_exit_code'; exit_code = $null; record = $record }
    }
    if ($record.exit_code_source -notin @('launcher_record', 'process_exit_code', 'wrapper_error')) {
        return [ordered]@{ valid = $false; reason = 'invalid_exit_code_source'; exit_code = $null; record = $record }
    }

    return [ordered]@{
        valid = $true
        reason = $null
        exit_code = [int]$record.exit_code
        record = $record
    }
}

function Test-Evidence1TerminalRecordObject {
    [CmdletBinding()]
    param(
        $Record,

        [Parameter(Mandatory)]
        [string]$Source,

        [Parameter(Mandatory)]
        [string]$ExpectedRunId
    )

    $expectedGuid = [guid]::Empty
    if (-not [guid]::TryParseExact($ExpectedRunId, 'D', [ref]$expectedGuid)) {
        throw 'ExpectedRunId must be a canonical D-format GUID'
    }
    if ($null -eq $Record) {
        return [ordered]@{ valid = $false; source = $Source; reason = 'not_found'; exit_code = $null; record = $null }
    }

    $required = @('schema', 'run_id', 'state', 'exit_code', 'exit_code_source')
    $propertyNames = @($Record.PSObject.Properties.Name)
    if (@($required | Where-Object { $_ -notin $propertyNames }).Count -gt 0) {
        return [ordered]@{ valid = $false; source = $Source; reason = 'invalid_shape'; exit_code = $null; record = $Record }
    }
    if (($Record.schema -isnot [int] -and $Record.schema -isnot [long]) -or [long]$Record.schema -ne 1) {
        return [ordered]@{ valid = $false; source = $Source; reason = 'invalid_schema'; exit_code = $null; record = $Record }
    }
    if ($Record.run_id -ne $ExpectedRunId) {
        return [ordered]@{ valid = $false; source = $Source; reason = 'run_id_mismatch'; exit_code = $null; record = $Record }
    }
    if ($Record.state -notin @('exited', 'wrapper_error', 'terminated_after_launcher_exit')) {
        return [ordered]@{ valid = $false; source = $Source; reason = 'non_terminal_state'; exit_code = $null; record = $Record }
    }
    if ($Record.exit_code -isnot [int] -and $Record.exit_code -isnot [long]) {
        return [ordered]@{ valid = $false; source = $Source; reason = 'invalid_exit_code'; exit_code = $null; record = $Record }
    }
    if ($Record.exit_code_source -notin @('launcher_record', 'process_exit_code', 'wrapper_error')) {
        return [ordered]@{ valid = $false; source = $Source; reason = 'invalid_exit_code_source'; exit_code = $null; record = $Record }
    }

    return [ordered]@{
        valid = $true
        source = $Source
        reason = $null
        exit_code = [int]$Record.exit_code
        record = $Record
    }
}

function Test-Evidence1ProgressRecord {
    [CmdletBinding()]
    param(
        $Record,

        [Parameter(Mandatory)]
        [string]$Source,

        [Parameter(Mandatory)]
        [string]$ExpectedRunId
    )

    $expectedGuid = [guid]::Empty
    if (-not [guid]::TryParseExact($ExpectedRunId, 'D', [ref]$expectedGuid)) {
        throw 'ExpectedRunId must be a canonical D-format GUID'
    }
    if ($null -eq $Record) {
        return [ordered]@{ valid = $false; source = $Source; reason = 'not_found'; record = $null }
    }
    $required = @('schema', 'run_id', 'state', 'elapsed_seconds', 'exit_code', 'exit_code_source', 'journal')
    $propertyNames = @($Record.PSObject.Properties.Name)
    if (@($required | Where-Object { $_ -notin $propertyNames }).Count -gt 0) {
        return [ordered]@{ valid = $false; source = $Source; reason = 'invalid_shape'; record = $Record }
    }
    if (($Record.schema -isnot [int] -and $Record.schema -isnot [long]) -or [long]$Record.schema -ne 1) {
        return [ordered]@{ valid = $false; source = $Source; reason = 'invalid_schema'; record = $Record }
    }
    if ($Record.run_id -ne $ExpectedRunId) {
        return [ordered]@{ valid = $false; source = $Source; reason = 'run_id_mismatch'; record = $Record }
    }
    if ($Record.state -notin @('starting', 'running', 'exited', 'wrapper_error', 'terminated_after_launcher_exit')) {
        return [ordered]@{ valid = $false; source = $Source; reason = 'invalid_state'; record = $Record }
    }
    if (($Record.elapsed_seconds -isnot [int] -and $Record.elapsed_seconds -isnot [long]) -or
        [int64]$Record.elapsed_seconds -lt 0) {
        return [ordered]@{ valid = $false; source = $Source; reason = 'invalid_elapsed_seconds'; record = $Record }
    }
    if ($Record.exit_code -isnot [int] -and $Record.exit_code -isnot [long]) {
        return [ordered]@{ valid = $false; source = $Source; reason = 'invalid_exit_code'; record = $Record }
    }
    if ($Record.exit_code_source -notin @('launcher_record', 'process_exit_code', 'wrapper_error')) {
        return [ordered]@{ valid = $false; source = $Source; reason = 'invalid_exit_code_source'; record = $Record }
    }

    return [ordered]@{ valid = $true; source = $Source; reason = $null; record = $Record }
}

function Stop-Evidence1ProcessTree {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [int]$ProcessId,

        [ValidateRange(100, 60000)]
        [int]$TimeoutMilliseconds = 10000
    )

    if ($ProcessId -le 0 -or $ProcessId -eq $PID) {
        throw 'ProcessId must identify a different positive process'
    }
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
        return [ordered]@{ stopped = $true; reason = 'already_exited' }
    }

    $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    $killer = Start-Process -FilePath $taskkill -ArgumentList @('/PID', [string]$ProcessId, '/T', '/F') -WindowStyle Hidden -PassThru
    if (-not $killer.WaitForExit($TimeoutMilliseconds)) {
        Stop-Process -Id $killer.Id -Force -ErrorAction SilentlyContinue
        return [ordered]@{ stopped = $false; reason = 'taskkill_timeout' }
    }

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
            return [ordered]@{ stopped = $true; reason = 'terminated' }
        }
        Start-Sleep -Milliseconds 100
    }

    return [ordered]@{ stopped = $false; reason = 'process_still_running' }
}

function Initialize-Evidence1CanarySupport {
    Import-Module (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1') -ErrorAction Stop
    Import-Module (Join-Path $PSScriptRoot 'evidence1-live-handoff-contract.psm1') -ErrorAction Stop
}

function Read-Evidence1CanaryJson([string]$Path, [int]$MaxBytes = 1048576) {
    Initialize-Evidence1CanarySupport
    $full = [IO.Path]::GetFullPath($Path)
    $current = $full
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (Get-E1Field $item 'LinkType') -eq 'HardLink') { throw 'canary_path_link' }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
    $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $stream = [IO.File]::Open($full, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
    try {
        if ($stream.Length -gt $MaxBytes) { throw 'canary_json_size' }
        $memory = [IO.MemoryStream]::new()
        try { $stream.CopyTo($memory); $bytes = $memory.ToArray() } finally { $memory.Dispose() }
    } finally { $stream.Dispose() }
    return @{ value = (ConvertFrom-E1Json ([Text.UTF8Encoding]::new($false,$true).GetString($bytes).TrimStart([char]0xfeff))); sha256 = (Get-E1Sha256 $bytes); bytes = $bytes }
}

function New-Evidence1CanaryClaim([string]$Directory, [string]$RunId, [string]$BindingSha256, [string]$Phase) {
    $id = [guid]::Empty
    if (-not [guid]::TryParseExact($RunId, 'D', [ref]$id) -or $id -eq [guid]::Empty -or $RunId -cne $id.ToString('D') -or
        $BindingSha256 -cnotmatch '^[a-f0-9]{64}$' -or $Phase -cnotin @('handoff','wrapper','launcher')) { throw 'canary_claim_scope' }
    if ($Phase -ceq 'launcher') {
        try { $wrapper = (Read-Evidence1CanaryJson (Join-Path $Directory 'wrapper.claim.json')).value }
        catch { throw 'canary_wrapper_claim_missing' }
        if ($wrapper.run_id -cne $RunId -or $wrapper.binding_sha256 -cne $BindingSha256 -or $wrapper.phase -cne 'wrapper') { throw 'canary_wrapper_claim_mismatch' }
    }
    $record = [ordered]@{ schema = 1; run_id = $RunId; binding_sha256 = $BindingSha256; phase = $Phase; ts_utc = [datetime]::UtcNow.ToString('o') }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Compress))
    $stream = $null
    try {
        $stream = [IO.File]::Open((Join-Path $Directory "$Phase.claim.json"), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
    } catch { throw 'canary_attempt_consumed_or_unknown' }
    finally { if ($stream) { $stream.Dispose() } }
    return $record
}

function Read-Evidence1CanaryBundle([string]$Directory, [string]$RunId, [string]$Arm, [string]$BindingSha256) {
    Initialize-Evidence1CanarySupport
    try {
        $file = Read-Evidence1CanaryJson (Join-Path $Directory 'binding.json')
        if ($file.sha256 -cne $BindingSha256) { throw 'binding_hash' }
        $binding = $file.value
        $wet = Read-Evidence1CanaryJson (Join-Path $Directory 'wet.json')
        $dry = Read-Evidence1CanaryJson (Join-Path $Directory 'dry.json')
        $readiness = Read-Evidence1CanaryJson (Join-Path $Directory 'readiness.json')
        $expected = New-Evidence1CanaryBinding -Arm $Arm -RunId $RunId -TargetCommit $binding.target_commit -TargetTree $binding.target_tree `
            -WetReport $wet.value -DryReport $dry.value -ReadinessReport $readiness.value `
            -WetReportSha256 $wet.sha256 -DryReportSha256 $dry.sha256 -ReadinessSha256 $readiness.sha256
        Assert-E1Keys $binding @($expected.Keys)
        foreach ($key in $expected.Keys) {
            if ($key -cin @('hashes','scripts')) {
                Assert-E1Keys $binding.$key @($expected[$key].Keys)
                Assert-E1Fields $binding.$key $expected[$key]
            } elseif (-not (Test-E1Exact $binding.$key $expected[$key])) { throw 'binding_value' }
        }
        return @{ binding = $expected; wet = $wet.value; dry = $dry.value; readiness = $readiness.value; sha256 = $file.sha256 }
    } catch { throw 'canary_bundle_invalid' }
}

function New-Evidence1CanaryHostBundle {
    param([string]$Directory, [string]$RunId, [string]$Arm, [string]$TargetCommit, [string]$TargetTree,
        [string]$WetReportPath, [string]$DryReportPath, [string]$ReadinessReportPath,
        [string]$ExpectedWetReportSha256, [string]$ExpectedDryReportSha256, [string]$AuthorizationPhrase)
    Initialize-Evidence1CanarySupport
    try {
        $wet = Read-Evidence1CanaryJson $WetReportPath
        $dry = Read-Evidence1CanaryJson $DryReportPath
        $readiness = Read-Evidence1CanaryJson $ReadinessReportPath
        if ($wet.sha256 -cne $ExpectedWetReportSha256 -or $dry.sha256 -cne $ExpectedDryReportSha256) { throw 'report_hash' }
        $binding = New-Evidence1CanaryBinding -Arm $Arm -RunId $RunId -TargetCommit $TargetCommit -TargetTree $TargetTree `
            -WetReport $wet.value -DryReport $dry.value -ReadinessReport $readiness.value `
            -WetReportSha256 $wet.sha256 -DryReportSha256 $dry.sha256 -ReadinessSha256 $readiness.sha256
        Assert-Evidence1CanaryAuthorization $binding $AuthorizationPhrase
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($binding | ConvertTo-Json -Depth 12))
        $hash = Get-E1Sha256 $bytes
        if (Test-Path -LiteralPath $Directory) { throw 'attempt_exists' }
        New-Item -ItemType Directory -Path $Directory -ErrorAction Stop | Out-Null
        $null = New-Evidence1CanaryClaim $Directory $RunId $hash 'handoff'
        $files = @{ 'binding.json' = $bytes; 'wet.json' = $wet.bytes; 'dry.json' = $dry.bytes; 'readiness.json' = $readiness.bytes }
        foreach ($name in $files.Keys) {
            $stream = [IO.File]::Open((Join-Path $Directory $name), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
            try { $stream.Write($files[$name], 0, $files[$name].Length); $stream.Flush($true) } finally { $stream.Dispose() }
        }
        return @{ binding = $binding; sha256 = $hash; directory = $Directory }
    } catch { throw 'canary_host_bundle_rejected' }
}

function New-Evidence1PendingJournalSnapshot($Previous, [string]$RunId, [string]$JournalId, [datetime]$NowUtc) {
    $since = Get-E1Field $Previous 'publication_pending_since_utc'
    if (-not $since) { $since = $NowUtc.ToUniversalTime().ToString('o') }
    if (($NowUtc.ToUniversalTime() - [datetime]::Parse($since).ToUniversalTime()).TotalSeconds -gt 5) { throw 'canary_publication_stalled' }
    return [ordered]@{
        run_id = $RunId; journal_id = $JournalId; available = $true
        event_count = $(if ($Previous) { $Previous.event_count } else { 0 })
        latest_event = $(if ($Previous) { $Previous.latest_event } else { $null })
        transition_counts = $(if ($Previous) { $Previous.transition_counts } else { @{} })
        publication_pending = $true; publication_pending_since_utc = $since
    }
}

function Test-Evidence1JournalPathDisappearance($Failure) {
    $exception = $Failure.Exception
    for ($i = 0; $exception -and $i -lt 8; $i++) {
        if ($exception -is [IO.FileNotFoundException] -or $exception -is [IO.DirectoryNotFoundException] -or
            $exception -is [Management.Automation.ItemNotFoundException]) { return $true }
        $exception = $exception.InnerException
    }
    return $false
}

function Test-Evidence1JournalSnapshotLeafDisappearance($Failure, [string]$Path) {
    $sawFileNotFound = $false
    $sawItemNotFound = $false
    $exception = $Failure.Exception
    for ($i = 0; $exception -and $i -lt 8; $i++) {
        if ($exception -is [IO.DirectoryNotFoundException]) { return $false }
        if ($exception -is [IO.FileNotFoundException]) { $sawFileNotFound = $true }
        if ($exception -is [Management.Automation.ItemNotFoundException]) { $sawItemNotFound = $true }
        $exception = $exception.InnerException
    }
    if ($sawFileNotFound) { return $true }
    if (-not $sawItemNotFound) { return $false }
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
    return Test-Path -LiteralPath $parent -PathType Container
}

function Resolve-Evidence1JournalPathDisappearance($Failure, $Previous, [string]$RunId,
    [switch]$AllowRetiredAfterProcessExit, [switch]$AllowRetiredAfterTerminalJournal) {
    if (-not (Test-Evidence1JournalPathDisappearance $Failure)) { throw $Failure }
    if ($Previous -and $Previous.journal_id) {
        return Get-Evidence1RetiredJournalSnapshot $Previous $RunId `
            -AllowRetiredAfterProcessExit:$AllowRetiredAfterProcessExit `
            -AllowRetiredAfterTerminalJournal:$AllowRetiredAfterTerminalJournal
    }
    throw 'canary_journal_retirement'
}

function Test-Evidence1TerminalOneCellJournalSnapshot($Snapshot) {
    if ($Snapshot.publication_pending -or $Snapshot.available -isnot [bool] -or -not $Snapshot.available -or
        $Snapshot.event_count -ne 6 -or $Snapshot.latest_event -cne '000000000005-0-evaluated.json') { return $false }
    $expected = @('planned','spawn_started','spawn_completed','raw_persisted','parsed','evaluated')
    if (@($Snapshot.transition_counts.Keys).Count -ne $expected.Count) { return $false }
    foreach ($transition in $expected) {
        if (-not $Snapshot.transition_counts.Contains($transition) -or $Snapshot.transition_counts[$transition] -ne 1) { return $false }
    }
    return $true
}

function Get-Evidence1RetiredJournalSnapshot($Previous, [string]$RunId,
    [switch]$AllowRetiredAfterProcessExit, [switch]$AllowRetiredAfterTerminalJournal) {
    try { $safe = ConvertTo-Evidence1CanaryJournalSnapshot $Previous $RunId }
    catch { throw 'canary_journal_retirement' }
    if (-not $safe.journal_id -or $safe.event_count -lt 1 -or
        -not $safe.transition_counts.Contains('planned') -or $safe.transition_counts.planned -ne 1) {
        throw 'canary_journal_retirement'
    }
    if (-not $AllowRetiredAfterProcessExit -and
        (-not $AllowRetiredAfterTerminalJournal -or -not (Test-Evidence1TerminalOneCellJournalSnapshot $safe))) {
        throw 'canary_journal_retiring'
    }
    $safe.available = $false
    $safe.publication_pending = $false
    $safe.publication_pending_since_utc = $null
    return $safe
}

function Get-Evidence1CanaryJournalProgress([string]$JournalRoot, [string[]]$BaselineIds, [string]$RunId, $Previous = $null,
    [datetime]$NowUtc = [datetime]::UtcNow, [switch]$AllowRetiredAfterProcessExit,
    [switch]$AllowRetiredAfterTerminalJournal) {
    Initialize-Evidence1CanarySupport
    if ($Previous -and $Previous.run_id -cne $RunId) { throw 'canary_journal_run_mismatch' }
    try { $ids = @(if (Test-Path -LiteralPath $JournalRoot) { Get-ChildItem -LiteralPath $JournalRoot -Directory -Force | ForEach-Object Name }) }
    catch { return Resolve-Evidence1JournalPathDisappearance $_ $Previous $RunId `
        -AllowRetiredAfterProcessExit:$AllowRetiredAfterProcessExit `
        -AllowRetiredAfterTerminalJournal:$AllowRetiredAfterTerminalJournal }
    $new = @($ids | Where-Object { $_ -cnotin $BaselineIds })
    if ($new.Count -gt 1) { throw 'canary_journal_ambiguous' }
    $bound = if ($Previous) { $Previous.journal_id } else { $null }
    if ($bound -and $new.Count -eq 1 -and $new[0] -cne $bound) { throw 'canary_journal_changed' }
    if ($new.Count -eq 0) {
        if ($bound) { return Get-Evidence1RetiredJournalSnapshot $Previous $RunId `
            -AllowRetiredAfterProcessExit:$AllowRetiredAfterProcessExit `
            -AllowRetiredAfterTerminalJournal:$AllowRetiredAfterTerminalJournal }
        return [ordered]@{ run_id = $RunId; journal_id = $null; available = $false; event_count = 0; latest_event = $null; transition_counts = @{}; publication_pending = $false; publication_pending_since_utc = $null }
    }
    $bound = $new[0]
    $id = [guid]::Empty
    if (-not [guid]::TryParseExact($bound, 'D', [ref]$id) -or $bound -cne $id.ToString('D')) { throw 'canary_journal_identity' }
    $eventsPath = Join-Path $JournalRoot "$bound/events"
    if (-not (Test-Path -LiteralPath $eventsPath)) {
        if ($Previous -and $Previous.journal_id) { return Get-Evidence1RetiredJournalSnapshot $Previous $RunId `
            -AllowRetiredAfterProcessExit:$AllowRetiredAfterProcessExit `
            -AllowRetiredAfterTerminalJournal:$AllowRetiredAfterTerminalJournal }
        $events = @()
    } else {
        try { $events = @(Get-ChildItem -LiteralPath $eventsPath -File -Force | Sort-Object Name) }
        catch { return Resolve-Evidence1JournalPathDisappearance $_ $Previous $RunId `
            -AllowRetiredAfterProcessExit:$AllowRetiredAfterProcessExit `
            -AllowRetiredAfterTerminalJournal:$AllowRetiredAfterTerminalJournal }
    }
    if ($events.Count -gt 32) { throw 'canary_journal_count' }
    $transitionPattern = '(planned|spawn_started|spawn_completed|spawn_failed|raw_persisted|parsed|evaluated)'
    $temporaryPattern = '^[0-9]{12}-0-' + $transitionPattern + '\.json\.tmp-[a-f0-9]{8}$'
    $temporary = @($events | Where-Object Name -CMatch $temporaryPattern)
    foreach ($event in $events) {
        if ($event.Name -cnotmatch ('^[0-9]+-[0-9]+-' + $transitionPattern + '\.json$') -and $event.Name -cnotmatch $temporaryPattern) { throw 'canary_journal_event' }
    }
    if ($Previous -and $Previous.journal_id -and $events.Count -lt $Previous.event_count) {
        return Get-Evidence1RetiredJournalSnapshot $Previous $RunId `
            -AllowRetiredAfterProcessExit:$AllowRetiredAfterProcessExit `
            -AllowRetiredAfterTerminalJournal:$AllowRetiredAfterTerminalJournal
    }
    if ($temporary.Count -gt 1) { throw 'canary_publication_ambiguous' }
    if ($temporary.Count -eq 1) {
        try {
            if ($temporary[0].Length -gt 65536) { throw 'canary_publication_size' }
            $targetName = $temporary[0].Name -creplace '\.tmp-[a-f0-9]{8}$', ''
            foreach ($event in $events) {
                if ((Get-E1Field $event 'LinkType') -eq 'HardLink' -and $event.Name -cnotin @($targetName,$temporary[0].Name)) { throw 'canary_path_link' }
            }
        } catch { return Resolve-Evidence1JournalPathDisappearance $_ $Previous $RunId `
            -AllowRetiredAfterProcessExit:$AllowRetiredAfterProcessExit `
            -AllowRetiredAfterTerminalJournal:$AllowRetiredAfterTerminalJournal }
        return New-Evidence1PendingJournalSnapshot $Previous $RunId $bound $NowUtc
    }
    $counts = [ordered]@{}
    $expectedSequence = 0
    $previousTransition = $null
    $allowedNext = @{
        '' = @('planned'); planned = @('spawn_started','spawn_failed'); spawn_started = @('spawn_completed')
        spawn_completed = @('raw_persisted'); raw_persisted = @('parsed'); parsed = @('evaluated')
        spawn_failed = @(); evaluated = @()
    }
    foreach ($event in $events) {
        if ($event.Name -cnotmatch '^([0-9]+)-([0-9]+)-(planned|spawn_started|spawn_completed|spawn_failed|raw_persisted|parsed|evaluated)\.json$') { throw 'canary_journal_event' }
        $sequence = [int]$Matches[1]; $ordinal = [int]$Matches[2]; $transition = $Matches[3]
        $previousKey = $(if ($null -eq $previousTransition) { '' } else { $previousTransition })
        if ($sequence -ne $expectedSequence -or $transition -cnotin $allowedNext[$previousKey]) { throw 'canary_journal_sequence' }
        try { $value = (Read-Evidence1CanaryJson $event.FullName 65536).value }
        catch {
            $readFailure = $_
            if (Test-Evidence1JournalPathDisappearance $readFailure) {
                return Resolve-Evidence1JournalPathDisappearance $readFailure $Previous $RunId `
                    -AllowRetiredAfterProcessExit:$AllowRetiredAfterProcessExit `
                    -AllowRetiredAfterTerminalJournal:$AllowRetiredAfterTerminalJournal
            }
            # Publication may start between enumeration and reading. Only its exact companion
            # temp name permits a bounded pending observation; persistent links remain rejected.
            try { $publishing = @(Get-ChildItem -LiteralPath $eventsPath -File -Force | Where-Object { $_.Name -cmatch $temporaryPattern -and $_.Name.StartsWith($event.Name + '.tmp-', [StringComparison]::Ordinal) }) }
            catch { return Resolve-Evidence1JournalPathDisappearance $_ $Previous $RunId `
                -AllowRetiredAfterProcessExit:$AllowRetiredAfterProcessExit `
                -AllowRetiredAfterTerminalJournal:$AllowRetiredAfterTerminalJournal }
            try {
                if ($publishing.Count -eq 1 -and $publishing[0].Length -le 65536) { return New-Evidence1PendingJournalSnapshot $Previous $RunId $bound $NowUtc }
            } catch { return Resolve-Evidence1JournalPathDisappearance $_ $Previous $RunId `
                -AllowRetiredAfterProcessExit:$AllowRetiredAfterProcessExit `
                -AllowRetiredAfterTerminalJournal:$AllowRetiredAfterTerminalJournal }
            throw
        }
        if ($ordinal -ne 0 -or -not (Test-E1Exact $value.cellOrdinal 0) -or -not (Test-E1Exact $value.seq $sequence) -or
            $value.runKind -cne 'scenario' -or $value.transition -cne $transition) { throw 'canary_journal_cell' }
        if ($counts.Contains($transition)) { throw 'canary_journal_duplicate_transition' }
        $counts[$transition] = 1
        $expectedSequence++
        $previousTransition = $transition
    }
    if ($events.Count -gt 0 -and -not $counts.Contains('planned')) { throw 'canary_journal_planned' }
    return [ordered]@{ run_id = $RunId; journal_id = $bound; available = $true; event_count = $events.Count; latest_event = $(if ($events.Count) { $events[-1].Name } else { $null }); transition_counts = $counts; publication_pending = $false; publication_pending_since_utc = $null }
}

function Get-Evidence1CanaryArguments($Binding, [string]$SourceDir, [string]$AttestationFile, [switch]$DryRun) {
    Initialize-Evidence1CanarySupport
    $product = $Binding.arm -ceq 'product'
    if ($Binding.arm -cnotin @('product','free-baseline')) { throw 'canary_argument_scope' }
    try {
        Assert-E1Fields $Binding @{
            planned_sessions = 1; repeats = 1; scenario_id = 'coverage-threshold-failure-v2'; campaign_design_id = "claude-$($Binding.arm)-canary-v1"
            cell_label = $(if ($product) { 'A' } else { 'B' }); condition = $(if ($product) { 'current-skill' } else { 'no-skill' })
            product_access_mode = $(if ($product) { 'product-assisted' } else { 'free-baseline-no-product' })
            execution_profile_id = 'sandboxed-unrestricted-v1'; seed = 20260821; max_budget_usd = 2
        }
    } catch { throw 'canary_argument_scope' }
    $arguments = @('tools/agentic-eval/cli.mjs','run','--scenario','coverage-threshold-failure-v2',
        '--source-repo-dir',$SourceDir,'--seed','20260821','--runtime','claude-code',
        '--campaign-design',$Binding.campaign_design_id,'--max-budget-usd','2','--isolation-attestation-file',$AttestationFile)
    if ($DryRun) { $arguments += '--dry-run' }
    return $arguments
}

function Get-Evidence1CanaryValidationInventory([string]$Directory) {
    Initialize-Evidence1CanarySupport
    $rows = @()
    foreach ($file in @(Get-ChildItem -LiteralPath $Directory -File -Force | Sort-Object Name)) {
        if ($file.Name -cnotmatch '^(wet-v2|dry-v3)-[a-f0-9]{40}(?:-(?:product|free-baseline))?(?:\.stdout\.json|\.stderr\.txt|\.json)$') { continue }
        if ($rows.Count -ge 256 -or $file.Length -gt 16777216 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'canary_validation_inventory' }
        $rows += $file.Name + '|' + $file.Length + '|' + (Get-E1SourceFileHash $file.FullName 16777216)
    }
    return Get-E1Sha256 ([Text.Encoding]::UTF8.GetBytes(($rows -join "`n")))
}

function Assert-Evidence1CanaryGuestEvidence($Bundle, [string]$HarnessDir, [string]$LedgerPath, [string]$AttestationPath, [string]$ValidationDirectory) {
    Initialize-Evidence1CanarySupport
    $b = $Bundle.binding
    $ledger = Read-E1Json $LedgerPath
    $attestation = Read-E1Json $AttestationPath 16384
    if ($ledger.sha256 -cne $b.hashes.ledger_sha256 -or $attestation.sha256 -cne $b.hashes.attestation_sha256) { throw 'canary_guest_evidence_changed' }
    $canonical = Assert-E1Evidence $Bundle.readiness $ledger.value $attestation.value 'Evidence1-Runner' $b.target_commit $b.target_tree $AttestationPath
    if ($canonical -cne $b.hashes.attestation_canonical_sha256) { throw 'canary_guest_attestation_changed' }
    $files = @{
        scenario_sha256 = 'tools/agentic-eval/corpus/scenarios/coverage-threshold-failure-v2.json'
        product_entry_sha256 = 'bin/kmp-test.js'
        execution_profile_registry_sha256 = 'tools/agentic-eval/execution-profiles/registry.json'
    }
    foreach ($key in $files.Keys) {
        if ((Get-FileHash -LiteralPath (Join-Path $HarnessDir $files[$key]) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $b.hashes[$key]) { throw 'canary_guest_implementation_changed' }
    }
    foreach ($name in $b.scripts.Keys) {
        if ((Get-FileHash -LiteralPath (Join-Path $HarnessDir "docs/audits/$name") -Algorithm SHA256).Hash.ToLowerInvariant() -cne $b.scripts[$name]) { throw 'canary_guest_script_changed' }
    }
    foreach ($operation in @('wet-v2','dry-v3')) {
        $hostReport = if ($operation -ceq 'wet-v2') { $Bundle.wet } else { $Bundle.dry }
        $marker = (Read-E1Json (Join-Path $ValidationDirectory "$operation-$($b.target_commit).json")).value
        $safe = ConvertTo-E1SafeResult $marker $operation $b.target_commit $b.target_tree
        if ($safe.schema -ne 2 -or $safe.state -cne 'passed') { throw 'canary_guest_validation_failed' }
        foreach ($key in $safe.hashes.Keys) {
            if ($safe.hashes[$key] -cne (Get-E1Field $hostReport.hashes $key)) { throw 'canary_guest_validation_changed' }
        }
        $outputs = if ($operation -ceq 'wet-v2') { @{ 'product_stdout_sha256' = '' } } else { @{ 'product_stdout_sha256' = '-product'; 'free_baseline_stdout_sha256' = '-free-baseline' } }
        foreach ($key in $outputs.Keys) {
            $path = Join-Path $ValidationDirectory "$operation-$($b.target_commit)$($outputs[$key]).stdout.json"
            if ((Read-E1Json $path).sha256 -cne $safe.hashes[$key]) { throw 'canary_guest_stdout_changed' }
        }
    }
}

function Assert-Evidence1CanaryTerminalBinding($Record, [string]$RunId, [string]$Arm, [string]$BindingSha256) {
    Initialize-Evidence1CanarySupport
    try {
        Assert-E1Fields $Record @{ run_id = $RunId }
        $canary = Get-E1Field $Record 'canary'
        Assert-E1Fields $canary @{ arm = $Arm; binding_sha256 = $BindingSha256 }
        $planned = Get-E1Field $canary 'planned_sessions'
        if (($planned -isnot [int] -and $planned -isnot [long]) -or [long]$planned -ne 1) { throw 'planned_sessions' }
    } catch { throw 'canary_terminal_binding' }
}

function New-Evidence1CanaryDiagnostics {
    return [ordered]@{
        schema = 1; failure_phase = $null; failure_code = $null
        failures = [ordered]@{ primary = $null; cleanup = $null; postflight = $null; persistence = $null }
        processes = [ordered]@{ dry_plan = $null; live = $null }
        checks = [ordered]@{ source_preserved = $null; custody_written = $null; terminal_written = $null }
    }
}

function ConvertTo-Evidence1CanaryJournalSnapshot($Raw, [string]$RunId) {
    Initialize-Evidence1CanarySupport
    try {
        Assert-E1Keys $Raw @('run_id','journal_id','available','event_count','latest_event','transition_counts','publication_pending','publication_pending_since_utc')
        Assert-E1Fields $Raw @{ run_id = $RunId }
        if ($null -ne $Raw.journal_id -and ([string]$Raw.journal_id -cnotmatch '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$')) { throw 'identity' }
        if ($Raw.available -isnot [bool] -or $Raw.publication_pending -isnot [bool]) { throw 'boolean' }
        if ($null -ne $Raw.latest_event -and ([string]$Raw.latest_event -cnotmatch '^[0-9]+-0+-(planned|spawn_started|spawn_completed|spawn_failed|raw_persisted|parsed|evaluated)\.json$')) { throw 'event' }
        $counts = [ordered]@{}
        $keys = @(Get-E1ObjectKeys $Raw.transition_counts)
        foreach ($key in $keys) {
            if ($key -cnotin @('planned','spawn_started','spawn_completed','spawn_failed','raw_persisted','parsed','evaluated') -or -not (Test-E1Exact $Raw.transition_counts.$key 1)) { throw 'transition' }
            $counts[$key] = 1
        }
        if (-not (Test-E1Exact $Raw.event_count $counts.Count)) { throw 'count' }
        if ($null -ne $Raw.publication_pending_since_utc -and ([string]$Raw.publication_pending_since_utc -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$')) { throw 'timestamp' }
        return [ordered]@{ run_id = $RunId; journal_id = $Raw.journal_id; available = $Raw.available; event_count = $counts.Count
            latest_event = $Raw.latest_event; transition_counts = $counts; publication_pending = $Raw.publication_pending; publication_pending_since_utc = $Raw.publication_pending_since_utc }
    } catch { throw 'canary_progress_shape' }
}

function Read-Evidence1CanaryJournalSnapshot([string]$Path, [string]$RunId, $Previous = $null) {
    Initialize-Evidence1CanarySupport
    try {
        $file = Read-Evidence1CanaryJson $Path
    } catch {
        if (-not (Test-Evidence1JournalSnapshotLeafDisappearance $_ $Path)) { throw }
        if ($null -eq $Previous) { return $null }
        return ConvertTo-Evidence1CanaryJournalSnapshot $Previous $RunId
    }
    return ConvertTo-Evidence1CanaryJournalSnapshot $file.value $RunId
}

function ConvertTo-Evidence1CanaryDiagnostics($Raw) {
    Initialize-Evidence1CanarySupport
    try {
        $safe = New-Evidence1CanaryDiagnostics
        Assert-E1Keys $Raw @($safe.Keys); Assert-E1Fields $Raw @{ schema = 1 }
        foreach ($group in @('failures','processes','checks')) { Assert-E1Keys $Raw.$group @($safe[$group].Keys) }
        foreach ($slot in @($safe.failures.Keys)) {
            $failure = $Raw.failures.$slot
            if ($null -eq $failure) { continue }
            Assert-E1Keys $failure @('phase','code')
            if ($failure.code -isnot [string] -or $failure.phase -isnot [string]) { throw 'failure' }
            $errorRecord = [Management.Automation.ErrorRecord]::new([Exception]::new($failure.code), 'canary', [Management.Automation.ErrorCategory]::NotSpecified, $null)
            Set-Evidence1CanaryFailure $safe $slot $failure.phase $errorRecord
            if ($safe.failures[$slot].code -cne $failure.code) { throw 'failure_code' }
        }
        foreach ($phase in @($safe.processes.Keys)) {
            if ($null -ne $Raw.processes.$phase) { $safe.processes[$phase] = ConvertTo-E1ProcessObservation $Raw.processes.$phase }
        }
        foreach ($check in @($safe.checks.Keys)) {
            $value = $Raw.checks.$check
            if ($null -ne $value -and $value -isnot [bool]) { throw 'check' }
            $safe.checks[$check] = $value
        }
        foreach ($key in @('failure_phase','failure_code')) {
            if ($null -eq $safe[$key]) { if ($null -ne $Raw.$key) { throw 'summary' } }
            elseif (-not (Test-E1Exact $Raw.$key $safe[$key])) { throw 'summary' }
        }
        return $safe
    } catch { throw 'canary_diagnostics_shape' }
}

function Set-Evidence1CanaryFailure($Diagnostics, [string]$Slot, [string]$Phase, $Failure) {
    Initialize-Evidence1CanarySupport
    if ($Slot -cnotin @('primary','cleanup','postflight','persistence') -or $Phase -cnotin @(
        'guest_preflight','auth','source_clone','dry_plan','live_preflight','live','journal','postflight','custody_write','terminal_write')) { throw 'canary_failure_shape' }
    $known = @('canary_bundle_invalid','canary_guest_evidence_changed','canary_guest_attestation_changed','canary_guest_implementation_changed',
        'canary_guest_script_changed','canary_guest_validation_failed','canary_guest_validation_changed','canary_guest_stdout_changed',
        'canary_validation_overlap','canary_tools_missing','canary_claude_version','canary_seed_missing','canary_journal_baseline',
        'canary_journal_overlap','canary_source_invalid','sdk_configuration','canary_dry_process','canary_dry_plan_changed',
        'canary_validation_changed','canary_process_cleanup','canary_publication_incomplete','canary_journal_unobserved','canary_sdk_changed',
        'canary_journal_event','canary_publication_stalled','canary_journal_ambiguous','canary_path_link','canary_journal_duplicate_transition',
        'canary_journal_cell','canary_journal_changed','canary_journal_run_mismatch','canary_journal_count','canary_publication_ambiguous',
        'canary_publication_size','canary_journal_planned','canary_journal_retiring','canary_journal_retirement','canary_journal_retirement_stalled',
        'canary_journal_observer','canary_json_size','canary_journal_identity','canary_live_exit_nonzero',
        'canary_terminal_required','canary_terminal_binding','canary_progress_shape','canary_diagnostics_shape')
    $code = Get-E1FailureCode $Failure 'preflight_failed'
    if ($code -ceq 'preflight_failed') { $code = $(if ($Phase -ceq 'journal') { 'canary_journal_observer' } else { 'unclassified' }) }
    $exception = $Failure.Exception
    for ($i = 0; $exception -and $i -lt 8; $i++) {
        if ($exception.Message -cin $known) { $code = $exception.Message; break }
        $exception = $exception.InnerException
    }
    if ($null -eq $Diagnostics.failures[$Slot]) { $Diagnostics.failures[$Slot] = [ordered]@{ phase = $Phase; code = $code } }
    foreach ($priority in @('primary','cleanup','postflight','persistence')) {
        if ($Diagnostics.failures[$priority]) {
            $Diagnostics.failure_phase = $Diagnostics.failures[$priority].phase
            $Diagnostics.failure_code = $Diagnostics.failures[$priority].code
            break
        }
    }
}

function Assert-Evidence1CanaryShutdownCustody($Placement, $Handoff, $TerminalRecord, [string]$RunId, [string]$VMName) {
    Initialize-Evidence1CanarySupport
    try {
        if ($RunId -cnotmatch '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' -or
            $VMName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,63}$') { throw 'identity' }
        $binding = Assert-Evidence1PriorHandoffCustody $Placement $Handoff $RunId $VMName
        $terminal = Test-Evidence1TerminalRecordObject -Record $TerminalRecord -Source 'powershell_direct_terminal' -ExpectedRunId $RunId
        if (-not $terminal.valid) { throw 'terminal' }
        Assert-Evidence1CanaryTerminalBinding $terminal.record $RunId $binding.arm $binding.binding_sha256
        return $true
    } catch { throw 'canary_shutdown_custody_invalid' }
}

function Get-Evidence1CanaryCustody([string]$Directory, [string]$RunId, [string]$BindingSha256, $TerminalRecord) {
    Initialize-Evidence1CanarySupport
    try {
        $file = Read-Evidence1CanaryJson (Join-Path $Directory 'binding.json')
        if ($file.sha256 -cne $BindingSha256 -or $file.value.run_id -cne $RunId) { throw 'binding' }
        $b = $file.value
        $null = Get-Evidence1CanaryArguments $b 'unused' 'unused'
        Assert-Evidence1CanaryTerminalBinding $TerminalRecord $RunId $b.arm $BindingSha256
        $ops = Split-Path -Parent (Split-Path -Parent $Directory)
        $names = @('evidence1-stageb-live-launch.ps1','evidence1-stageb-live-wrapper.ps1','evidence1-live-run-contract.psm1',
            'evidence1-live-handoff-contract.psm1','evidence1-validation-ops.psm1')
        Assert-E1Keys $b.scripts $names
        foreach ($name in $names) {
            $path = Join-Path $ops $name
            $item = Get-Item -LiteralPath $path -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (Get-E1Field $item 'LinkType') -eq 'HardLink' -or
                (Get-E1SourceFileHash $path 1048576) -cne $b.scripts.$name) { throw 'staged_script' }
        }
        $files = [ordered]@{ 'binding.json' = $file.sha256 }
        $expected = @{ 'wet.json' = $b.wet_report_sha256; 'dry.json' = $b.dry_report_sha256; 'readiness.json' = $b.hashes.readiness_sha256 }
        foreach ($name in $expected.Keys) {
            $data = Read-Evidence1CanaryJson (Join-Path $Directory $name)
            if ($data.sha256 -cne $expected[$name]) { throw 'report' }
            $files[$name] = $data.sha256
        }
        foreach ($phase in @('handoff','wrapper')) {
            $name = "$phase.claim.json"
            $claim = Read-Evidence1CanaryJson (Join-Path $Directory $name)
            Assert-E1Fields $claim.value @{ schema = 1; run_id = $RunId; binding_sha256 = $BindingSha256; phase = $phase }
            $files[$name] = $claim.sha256
        }
        $launcherClaimPath = Join-Path $Directory 'launcher.claim.json'
        if (-not (Test-Path -LiteralPath $launcherClaimPath)) {
            if (Test-Path -LiteralPath (Join-Path $Directory 'source-custody.json')) { throw 'source_without_launcher' }
            Assert-E1Fields $TerminalRecord @{ schema = 1; run_id = $RunId; state = 'wrapper_error'; exit_code = 997; exit_code_source = 'wrapper_error' }
            if ((Get-E1Field $TerminalRecord 'wrapper_error_stage') -cnotin @('prepare_ops_directory','initialize_journal')) { throw 'wrapper_stage' }
            $diagnostics = ConvertTo-Evidence1CanaryDiagnostics (Get-E1Field $TerminalRecord 'diagnostics')
            if ($diagnostics.failure_phase -cne 'guest_preflight' -or $null -eq $diagnostics.failures.primary) { throw 'wrapper_diagnostics' }
            foreach ($name in @('journal-baseline.json','journal.json')) {
                $path = Join-Path $Directory $name
                if (Test-Path -LiteralPath $path) {
                    $data = Read-Evidence1CanaryJson $path
                    Assert-E1Fields $data.value @{ run_id = $RunId; binding_sha256 = $BindingSha256 }
                    $files[$name] = $data.sha256
                }
            }
            return [ordered]@{
                verified = $false; complete = $false; custody_state = 'incomplete_wrapper_preflight'
                run_id = $RunId; arm = $b.arm; planned_sessions = 1; binding_sha256 = $BindingSha256
                attempt_consumed = $true; retry_authorized = $false; source_preserved = $false
                failure_phase = $diagnostics.failure_phase; failure_code = $diagnostics.failure_code; files = $files
            }
        }
        $launcher = Read-Evidence1CanaryJson $launcherClaimPath
        Assert-E1Fields $launcher.value @{ schema = 1; run_id = $RunId; binding_sha256 = $BindingSha256; phase = 'launcher' }
        $files['launcher.claim.json'] = $launcher.sha256
        $sourcePath = Join-Path $Directory 'source-custody.json'
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            Assert-E1Fields $TerminalRecord @{ schema = 1; run_id = $RunId; state = 'wrapper_error'; exit_code = 997; exit_code_source = 'wrapper_error' }
            if ((Get-E1Field $TerminalRecord 'wrapper_error_stage') -cne 'monitor_launcher') { throw 'wrapper_stage' }
            $diagnostics = ConvertTo-Evidence1CanaryDiagnostics (Get-E1Field $TerminalRecord 'diagnostics')
            if ($diagnostics.failure_phase -cne 'journal' -or $null -eq $diagnostics.failures.primary) { throw 'wrapper_diagnostics' }
            foreach ($name in @('journal-baseline.json','journal.json')) {
                $path = Join-Path $Directory $name
                if (Test-Path -LiteralPath $path) {
                    $data = Read-Evidence1CanaryJson $path
                    Assert-E1Fields $data.value @{ run_id = $RunId }
                    $files[$name] = $data.sha256
                }
            }
            return [ordered]@{
                verified = $false; complete = $false; custody_state = 'incomplete_wrapper_monitor'
                run_id = $RunId; arm = $b.arm; planned_sessions = 1; binding_sha256 = $BindingSha256
                attempt_consumed = $true; retry_authorized = $false; source_preserved = $false
                failure_phase = $diagnostics.failure_phase; failure_code = $diagnostics.failure_code; files = $files
            }
        }
        $source = Read-Evidence1CanaryJson $sourcePath
        Assert-E1Fields $source.value @{ schema = 1; run_id = $RunId; binding_sha256 = $BindingSha256; source_preserved = $true }
        if ($source.value.validation_inventory_before_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            $source.value.validation_inventory_before_sha256 -cne $source.value.validation_inventory_after_sha256) { throw 'source_custody' }
        $files['source-custody.json'] = $source.sha256
        foreach ($name in @('journal-baseline.json','journal.json')) {
            $path = Join-Path $Directory $name
            if (Test-Path -LiteralPath $path) {
                $data = Read-Evidence1CanaryJson $path
                Assert-E1Fields $data.value @{ run_id = $RunId }
                $files[$name] = $data.sha256
            }
        }
        return [ordered]@{
            verified = $true; complete = $true; custody_state = 'complete'; run_id = $RunId; arm = $b.arm
            planned_sessions = 1; binding_sha256 = $BindingSha256; attempt_consumed = $true
            retry_authorized = $false; source_preserved = $true; files = $files
        }
    } catch { throw 'canary_custody_invalid' }
}

function New-Evidence1CanarySource([string]$SourcePath, [string]$Directory, [string]$Commit) {
    Initialize-Evidence1CanarySupport
    try {
        $source = Resolve-E1Path $SourcePath
        $directory = Resolve-E1Path $Directory
        if ($Commit -cnotmatch '^[a-f0-9]{40}$' -or $source -ieq $directory -or
            $directory.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $source.StartsWith($directory + '\', [StringComparison]::OrdinalIgnoreCase) -or
            (Test-Path -LiteralPath $directory)) { throw 'source_scope' }
        New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null
        $before = Get-E1SourceSnapshot $source $Commit '' $directory
        $clone = Join-Path $directory 'source'
        # Local upload-pack reads Git objects only; no worktree registration, alternates or hardlinks.
        $null = Invoke-E1Git $source @('-c','core.hooksPath=NUL','clone','--no-local','--no-checkout','--',$source,$clone) $directory
        $null = Invoke-E1Git $clone @('-c','core.hooksPath=NUL','checkout','--detach',$Commit) $directory
        $null = Invoke-E1Git $clone @('remote','set-url','origin','https://github.com/android/nowinandroid') $directory
        $tree = Assert-E1Repo $clone $Commit $before.tree $directory
        if (Test-Path -LiteralPath (Join-Path $clone '.git/objects/info/alternates')) { throw 'source_shared_objects' }
        $null = Assert-E1SourcePostflight $source $Commit $tree $directory $before -Operation 'dry-v3'
        return @{ path = $clone; source = $source; tree = $tree; before = $before; directory = $directory }
    } catch { throw 'canary_source_invalid' }
}

Export-ModuleMember -Function @(
    'Write-Evidence1JsonAtomically',
    'Read-Evidence1TerminalRecord',
    'Test-Evidence1TerminalRecordObject',
    'Test-Evidence1ProgressRecord',
    'Stop-Evidence1ProcessTree',
    'Read-Evidence1CanaryJson',
    'New-Evidence1CanaryClaim',
    'Read-Evidence1CanaryBundle',
    'New-Evidence1CanaryHostBundle',
    'Get-Evidence1CanaryJournalProgress',
    'New-Evidence1CanarySource'
    'Get-Evidence1CanaryArguments'
    'Get-Evidence1CanaryValidationInventory'
    'Assert-Evidence1CanaryGuestEvidence'
    'Assert-Evidence1CanaryTerminalBinding'
    'Get-Evidence1CanaryCustody'
    'New-Evidence1CanaryDiagnostics'
    'Set-Evidence1CanaryFailure'
    'ConvertTo-Evidence1CanaryJournalSnapshot'
    'Read-Evidence1CanaryJournalSnapshot'
    'ConvertTo-Evidence1CanaryDiagnostics'
    'Assert-Evidence1CanaryShutdownCustody'
)

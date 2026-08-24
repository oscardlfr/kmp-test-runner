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
    if ($record.schema -ne 1) {
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
    if ($Record.schema -ne 1) {
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
    if ($Record.schema -ne 1) {
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

Export-ModuleMember -Function @(
    'Write-Evidence1JsonAtomically',
    'Read-Evidence1TerminalRecord',
    'Test-Evidence1TerminalRecordObject',
    'Test-Evidence1ProgressRecord',
    'Stop-Evidence1ProcessTree'
)

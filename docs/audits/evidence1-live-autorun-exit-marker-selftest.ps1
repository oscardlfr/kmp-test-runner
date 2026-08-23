Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'evidence1-hyperv-place-live-autorun.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
  Write-Error "autorun placement script missing: $scriptPath"
  exit 1
}

$text = Get-Content -LiteralPath $scriptPath -Raw

foreach ($required in @(
  '[Parameter(Mandatory = $true)]',
  'function Read-ExitCodeMarker',
  '`$paths = @(`$liveLogPath, `$stdoutPath)',
  'Start-Sleep -Milliseconds `$DelayMilliseconds',
  '`$script:processExitCode = if (`$null -ne `$script:proc.ExitCode)',
  '`$marker = Read-ExitCodeMarker',
  '`$script:exitCodeSource = ''launcher_marker''',
  '`$script:exitCodeSource = ''process_exit_code''',
  'process_exit_code = `$script:processExitCode',
  'exit_code_source = `$script:exitCodeSource',
  'exit_marker_source = `$script:exitMarkerSource'
)) {
  if (-not $text.Contains($required)) {
    Write-Error "missing expected autorun exit-resolution fragment: $required"
    exit 1
  }
}

if ($text -match 'C:\\Users\\[^\\]+') {
  Write-Error 'autorun placement script must not contain a concrete host user profile path'
  exit 1
}

$processExitIndex = $text.IndexOf('`$script:processExitCode = if (`$null -ne `$script:proc.ExitCode)', [StringComparison]::Ordinal)
$markerIndex = $text.IndexOf('`$marker = Read-ExitCodeMarker', [StringComparison]::Ordinal)
$launcherMarkerIndex = $text.IndexOf('`$script:exitCodeSource = ''launcher_marker''', [StringComparison]::Ordinal)
$processFallbackIndex = $text.IndexOf('`$script:exitCodeSource = ''process_exit_code''', [StringComparison]::Ordinal)

if ($processExitIndex -lt 0 -or $markerIndex -lt 0 -or $launcherMarkerIndex -lt 0 -or $processFallbackIndex -lt 0) {
  Write-Error 'could not locate exit-resolution ordering anchors'
  exit 1
}
if (-not ($processExitIndex -lt $markerIndex -and $markerIndex -lt $launcherMarkerIndex -and $launcherMarkerIndex -lt $processFallbackIndex)) {
  Write-Error 'exit-resolution order drifted; launcher marker must be preferred before process fallback'
  exit 1
}

Write-Host 'PASS_LIVE_AUTORUN_EXIT_MARKER_CONTRACT'

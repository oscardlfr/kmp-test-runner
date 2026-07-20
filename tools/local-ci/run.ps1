[CmdletBinding()]
param(
    [ValidateSet('All', 'Linux', 'LinuxNode24', 'LinuxNode18', 'Windows')]
    [string]$Lane = 'All',
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path,
    [string]$WslDistro = 'Ubuntu-22.04'
)

$ErrorActionPreference = 'Stop'
$toolingRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$RepoRoot = (Resolve-Path $RepoRoot).Path
. (Join-Path $PSScriptRoot 'path-utils.ps1')

function Invoke-Checked {
    param([scriptblock]$Command, [string]$Description)
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

if ($Lane -in @('All', 'Linux', 'LinuxNode24', 'LinuxNode18')) {
    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
        throw 'WSL2 is required for the Linux Docker lane on Windows'
    }
    $toolingWsl = Convert-ToWslPath $toolingRoot
    $sourceWsl = Convert-ToWslPath $RepoRoot
    $linuxLane = switch ($Lane) {
        'LinuxNode24' { 'node24' }
        'LinuxNode18' { 'node18' }
        default { 'all' }
    }
    Invoke-Checked -Command {
        wsl.exe -d $WslDistro -- bash "$toolingWsl/tools/local-ci/run-linux.sh" $sourceWsl $linuxLane
    } -Description 'Linux Docker lane'
}

if ($Lane -in @('All', 'Windows')) {
    & (Join-Path $PSScriptRoot 'windows-gate.ps1') -RepoRoot $RepoRoot
}

Write-Host "[local-ci] requested lane '$Lane' passed" -ForegroundColor Green

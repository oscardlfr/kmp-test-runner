#!/usr/bin/env powershell
<#
.SYNOPSIS
    Run tests only on modules with uncommitted git changes.

.DESCRIPTION
    Detects modules with uncommitted changes (staged, unstaged, or untracked files)
    and runs tests only on those modules. Uses run-parallel-coverage-suite.ps1 for
    actual test execution.

    DETECTION LOGIC:
    - Uses `git status --porcelain` to find changed files
    - Maps file paths to Gradle modules
    - Filters out modules without build.gradle.kts
    - Optionally includes sibling shared-libs changes (via SHARED_PROJECT_NAME)

.PARAMETER ProjectRoot
    Path to the project root. Required.

.PARAMETER IncludeShared
    Include changes in sibling shared-libs project when detecting modules (requires SHARED_PROJECT_NAME).

.PARAMETER TestType
    Test type to run: "all", "common", "androidUnit", "androidInstrumented", "desktop".
    Default: auto-detect based on project type.

.PARAMETER StagedOnly
    Only consider staged files (git add). Ignores unstaged and untracked.

.PARAMETER ShowModulesOnly
    Show detected modules without running tests. Useful for verification.

.PARAMETER MaxFailures
    Stop after N test failures. 0 = run all modules regardless of failures.

.PARAMETER MinMissedLines
    Minimum missed lines to include a class in gaps report.

.EXAMPLE
    # Run tests on changed modules
    ./run-changed-modules-tests.ps1 -ProjectRoot "C:\Projects\MyApp"

.EXAMPLE
    # Show which modules have changes (dry run)
    ./run-changed-modules-tests.ps1 -ProjectRoot "C:\Projects\MyApp" -ShowModulesOnly

.EXAMPLE
    # Only staged files, include sibling shared-libs
    ./run-changed-modules-tests.ps1 -ProjectRoot "C:\Projects\MyApp" -StagedOnly -IncludeShared

.NOTES
    Author: kmp-test-runner
    Version: 1.0.0
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [switch]$IncludeShared,
    [ValidateSet("all", "common", "androidUnit", "androidInstrumented", "desktop")]
    [string]$TestType = "",
    [switch]$StagedOnly,
    [switch]$ShowModulesOnly,
    [int]$MaxFailures = 0,
    [int]$MinMissedLines = 0,
    [ValidateSet("jacoco", "kover", "auto", "none", "")]
    [string]$CoverageTool = "",
    [string]$ExcludeCoverage = "",
    [string]$TestFilter = "",
    [switch]$IgnoreJdkMismatch,
    [string]$ExcludeModules = "",
    [switch]$IncludeUntested
)

$ErrorActionPreference = "Stop"
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$ScriptRoot\lib\Jdk-Check.ps1"

# Pre-flight JDK toolchain gate (mirrors run-parallel-coverage-suite.ps1).
if (Test-Path $ProjectRoot) {
    $gateRc = Invoke-JdkMismatchGate -ProjectRoot $ProjectRoot -IgnoreJdkMismatch:$IgnoreJdkMismatch
    if ($gateRc -ne 0) { exit $gateRc }
}

# ============================================================================
# GIT CHANGE DETECTION
# ============================================================================

function Get-ChangedFiles {
    param(
        [string]$ProjectRoot,
        [switch]$StagedOnly
    )

    Push-Location $ProjectRoot
    try {
        if ($StagedOnly) {
            # Only staged files
            $files = git diff --cached --name-only 2>$null
        } else {
            # All changes: staged + unstaged + untracked
            $rawOutput = git status --porcelain 2>$null
            $files = @()
            foreach ($line in $rawOutput) {
                if ($line -match '^\s*[MADRCU?!]+\s+(.+)$') {
                    $filePath = $Matches[1] -replace '"', ''
                    # Handle renamed files (old -> new format)
                    if ($filePath -match ' -> ') {
                        $filePath = ($filePath -split ' -> ')[1]
                    }
                    $files += $filePath
                }
            }
        }
        return $files | Where-Object { $_ }
    } finally {
        Pop-Location
    }
}

function Get-ModuleFromFile {
    param(
        [string]$FilePath,
        [string]$ProjectRoot
    )

    # Split path into parts on either separator. Using the -split operator with
    # a character class instead of String.Split: the .NET overload chosen here
    # was Split(Char, Int32) — the '\' second arg got coerced to Int32 and
    # blew up with "The input string '\' was not in a correct format". `-split`
    # takes a regex so we get the multi-delimiter behaviour we actually wanted.
    $parts = $FilePath -split '[/\\]' | Where-Object { $_ }

    if ($parts.Count -lt 2) {
        return $null
    }

    # Pattern 1: Nested modules (core/domain, feature/home, shared/model)
    $nestedPrefixes = @('core', 'feature', 'shared', 'data', 'ui', 'common')
    if ($parts[0] -in $nestedPrefixes) {
        $modulePath = Join-Path $ProjectRoot "$($parts[0])/$($parts[1])"
        if (Test-Path (Join-Path $modulePath "build.gradle.kts")) {
            return ":$($parts[0]):$($parts[1])"
        }
    }

    # Pattern 2: Flat modules with prefix (core-domain, feature-home)
    if ($parts[0] -match '^(core|feature|shared|data|ui)-') {
        $modulePath = Join-Path $ProjectRoot $parts[0]
        if (Test-Path (Join-Path $modulePath "build.gradle.kts")) {
            return ":$($parts[0])"
        }
    }

    # Pattern 3: App modules (app, androidApp, desktopApp)
    if ($parts[0] -in @('app', 'androidApp', 'desktopApp', 'iosApp')) {
        $modulePath = Join-Path $ProjectRoot $parts[0]
        if (Test-Path (Join-Path $modulePath "build.gradle.kts")) {
            return ":$($parts[0])"
        }
    }

    # Pattern 4: Direct module at root level
    $modulePath = Join-Path $ProjectRoot $parts[0]
    if (Test-Path (Join-Path $modulePath "build.gradle.kts")) {
        return ":$($parts[0])"
    }

    return $null
}

function Find-ChangedModules {
    param(
        [string]$ProjectRoot,
        [switch]$StagedOnly,
        [switch]$IncludeShared
    )

    $changedFiles = Get-ChangedFiles -ProjectRoot $ProjectRoot -StagedOnly:$StagedOnly
    $modules = @{}

    foreach ($file in $changedFiles) {
        $module = Get-ModuleFromFile -FilePath $file -ProjectRoot $ProjectRoot

        if ($module) {
            # Track module with sample file
            if (-not $modules.ContainsKey($module)) {
                $modules[$module] = @()
            }
            $modules[$module] += $file
        }
    }

    # Filter out shared project modules if not included
    $sharedProjectName = if ($env:SHARED_PROJECT_NAME) { $env:SHARED_PROJECT_NAME } else { "" }
    if (-not $IncludeShared -and $sharedProjectName) {
        $filteredModules = @{}
        foreach ($key in $modules.Keys) {
            if ($key -notmatch [regex]::Escape($sharedProjectName)) {
                $filteredModules[$key] = $modules[$key]
            }
        }
        $modules = $filteredModules
    }

    return $modules
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Test Changed Modules" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Project: $ProjectRoot" -ForegroundColor White
Write-Host "Mode: $(if ($StagedOnly) { 'Staged only' } else { 'All changes' })" -ForegroundColor White
Write-Host ""

# Verify git repository
Push-Location $ProjectRoot
$isGitRepo = git rev-parse --is-inside-work-tree 2>$null
Pop-Location

if ($isGitRepo -ne "true") {
    Write-Host "ERROR: Not a git repository: $ProjectRoot" -ForegroundColor Red
    exit 1
}

# Find changed modules
$changedModules = Find-ChangedModules -ProjectRoot $ProjectRoot `
    -StagedOnly:$StagedOnly -IncludeShared:$IncludeShared

if ($changedModules.Count -eq 0) {
    Write-Host "No modules with uncommitted changes detected." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Possible reasons:" -ForegroundColor Gray
    Write-Host "  - No changes in module source directories" -ForegroundColor Gray
    Write-Host "  - Changes only in non-module files (root scripts, etc.)" -ForegroundColor Gray
    Write-Host "  - Use --include-shared to include sibling shared-libs changes (SHARED_PROJECT_NAME)" -ForegroundColor Gray
    exit 0
}

# Display detected modules
Write-Host "Modules with changes:" -ForegroundColor Cyan
foreach ($module in ($changedModules.Keys | Sort-Object)) {
    $fileCount = $changedModules[$module].Count
    Write-Host "  $module" -ForegroundColor White -NoNewline
    Write-Host " ($fileCount files)" -ForegroundColor Gray
}
Write-Host ""

if ($ShowModulesOnly) {
    Write-Host "Dry run - no tests executed." -ForegroundColor Yellow
    exit 0
}

# Build module filter for run-parallel-coverage-suite.ps1.
# Get-ModuleFromFile returns gradle-style names with a leading colon (':core-result',
# ':feature:home') but the parallel suite's --ModuleFilter expects bare globs
# like 'core-result' / 'feature-home'. Strip the leading colon to match the
# bash sibling (run-changed-modules-tests.sh line 228: `trimmed="${mod#:}"`).
$moduleFilter = ($changedModules.Keys | Sort-Object | ForEach-Object { $_.TrimStart(':') }) -join ','

Write-Host "Running tests on: $moduleFilter" -ForegroundColor Cyan
Write-Host ""

# Execute tests using existing script. Match the bash sibling
# (run-changed-modules-tests.sh): MaxFailures is parsed at this level for CLI
# parity but is NOT forwarded — run-parallel-coverage-suite.ps1 doesn't
# declare a -MaxFailures parameter, so splatting it threw "A parameter cannot
# be found that matches parameter name 'MaxFailures'" the moment kmp-test
# changed actually got past the dry-run path.
$params = @{
    ProjectRoot = $ProjectRoot
    ModuleFilter = $moduleFilter
    MinMissedLines = $MinMissedLines
}

if ($TestType -ne "") {
    $params.TestType = $TestType
}

if ($IncludeShared) {
    $params.IncludeShared = $true
}

if ($CoverageTool -ne "") {
    $params.CoverageTool = $CoverageTool
}

if ($ExcludeCoverage -ne "") {
    $params.ExcludeCoverage = $ExcludeCoverage
}

if ($TestFilter -ne "") {
    $params.TestFilter = $TestFilter
}

if ($ExcludeModules -ne "") {
    $params.ExcludeModules = $ExcludeModules
}

if ($IncludeUntested) {
    $params.IncludeUntested = $true
}

if ($IgnoreJdkMismatch) {
    $params.IgnoreJdkMismatch = $true
}

& "$ScriptRoot/run-parallel-coverage-suite.ps1" @params

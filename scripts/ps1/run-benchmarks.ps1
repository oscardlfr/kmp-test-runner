#!/usr/bin/env powershell
<#
.SYNOPSIS
    Run kotlinx-benchmark / androidx.benchmark suites across JVM and Android targets.

.DESCRIPTION
    Discovers benchmark modules, resolves Gradle tasks per platform and configuration,
    executes them, parses JSON results, and produces a console summary plus a Markdown
    report (benchmark-report.md).

    Mirrors the logic of scripts/sh/run-benchmarks.sh for PowerShell environments.

.PARAMETER ProjectRoot
    Path to the main Gradle project root. Required.

.PARAMETER Config
    Benchmark configuration preset: "smoke" (fast, few iterations),
    "main" (default, balanced), or "stress" (long, many iterations).

.PARAMETER Platform
    Target platform filter: "all", "jvm", or "android".

.PARAMETER ModuleFilter
    Glob pattern to filter which modules are included. Default "*" (all).

.PARAMETER IncludeShared
    Also scan sibling shared-libs directory for benchmark modules (requires SHARED_PROJECT_NAME env var).

.EXAMPLE
    ./run-benchmarks.ps1 -ProjectRoot "C:\Projects\MyApp"

.EXAMPLE
    ./run-benchmarks.ps1 -ProjectRoot "C:\Projects\MyApp" -Config stress -Platform jvm

.NOTES
    Author: kmp-test-runner
    Version: 1.0.0
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot,

    [ValidateSet("smoke", "main", "stress")]
    [string]$Config = "smoke",

    [ValidateSet("all", "jvm", "android")]
    [string]$Platform = "all",

    [string]$ModuleFilter = "*",

    [switch]$IncludeShared
)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# =============================================================================
# DOT-SOURCE LIBRARIES
# =============================================================================

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$scriptDir\lib\Benchmark-Detect.ps1"

# =============================================================================
# PLATFORM DETECTION
# =============================================================================

Write-Host ""
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host "  BENCHMARK RUNNER" -ForegroundColor Cyan
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host ""

Write-Host "[>>] Config   : $Config" -ForegroundColor White
Write-Host "[>>] Platform : $Platform" -ForegroundColor White
Write-Host "[>>] Project  : $ProjectRoot" -ForegroundColor White
Write-Host ""

# JVM info
$jvmInfo = Detect-JvmInfo
$jvmAvailable = $jvmInfo.Version -ne "unknown"

# Android devices
$androidDevices = Detect-AndroidDevices
$androidAvailable = $androidDevices.Count -gt 0

Write-Host ("{0,-20} {1,-12} {2}" -f "PLATFORM", "STATUS", "DETAILS") -ForegroundColor White
Write-Host ("-" * 55) -ForegroundColor DarkGray

if ($jvmAvailable) {
    Write-Host ("{0,-20} {1,-12} {2}" -f "JVM", "available", "Java $($jvmInfo.Version), $($jvmInfo.Cores) cores") -ForegroundColor Green
} else {
    Write-Host ("{0,-20} {1,-12} {2}" -f "JVM", "missing", "java not found on PATH") -ForegroundColor Red
}

if ($androidAvailable) {
    $deviceSummary = "$($androidDevices.Count) device(s)"
    Write-Host ("{0,-20} {1,-12} {2}" -f "Android", "available", $deviceSummary) -ForegroundColor Green
    foreach ($dev in $androidDevices) {
        Write-Host ("  -> {0} ({1}, API {2})" -f $dev.Serial, $dev.Type, $dev.ApiLevel) -ForegroundColor Gray
    }
} else {
    Write-Host ("{0,-20} {1,-12} {2}" -f "Android", "missing", "no devices via adb") -ForegroundColor Yellow
}

Write-Host ""

# Determine which platforms to run
$runJvm     = ($Platform -eq "all" -or $Platform -eq "jvm") -and $jvmAvailable
$runAndroid = ($Platform -eq "all" -or $Platform -eq "android") -and $androidAvailable

if (-not $runJvm -and -not $runAndroid) {
    Write-Host "[!!] No runnable platforms available. Check java / adb and try again." -ForegroundColor Red
    exit 1
}

# =============================================================================
# MODULE DISCOVERY
# =============================================================================

$modules = @(Detect-BenchmarkModules -ProjectRoot $ProjectRoot -ModuleFilter $ModuleFilter)

$SharedProjectName = if ($env:SHARED_PROJECT_NAME) { $env:SHARED_PROJECT_NAME } else { "" }

if ($IncludeShared) {
    if (-not $SharedProjectName -and -not $env:SHARED_ROOT) {
        Write-Host "[!!] --include-shared requires SHARED_PROJECT_NAME or SHARED_ROOT env var" -ForegroundColor Yellow
    } else {
        $sharedRoot = if ($env:SHARED_ROOT) {
            $env:SHARED_ROOT
        } else {
            Join-Path (Split-Path $ProjectRoot -Parent) $SharedProjectName
        }
        $resolvedName = if ($SharedProjectName) { $SharedProjectName } else { Split-Path $sharedRoot -Leaf }
        if (Test-Path $sharedRoot) {
            $sharedModules = @(Detect-BenchmarkModules -ProjectRoot $sharedRoot -ModuleFilter $ModuleFilter)
            foreach ($sm in $sharedModules) {
                $modules += "${resolvedName}:$sm"
            }
        } else {
            Write-Host "[!!] $resolvedName directory not found at: $sharedRoot" -ForegroundColor Yellow
        }
    }
}

if ($modules.Count -eq 0) {
    Write-Host "[!!] No benchmark modules found (filter: '$ModuleFilter')." -ForegroundColor Yellow
    Write-Host "[>>] Ensure at least one module references kotlinx-benchmark or androidx.benchmark." -ForegroundColor Gray
    exit 0
}

Write-Host "[>>] Discovered $($modules.Count) benchmark module(s):" -ForegroundColor Cyan
foreach ($mod in $modules) {
    Write-Host "     - $mod" -ForegroundColor White
}
Write-Host ""

# =============================================================================
# TASK EXECUTION
# =============================================================================

# Result tracking: array of PSCustomObjects
$taskResults = @()

function Invoke-GradleBenchmark {
    <#
    .SYNOPSIS
        Runs a single Gradle benchmark task and captures exit code.
    #>
    param(
        [string]$Root,
        [string]$Task,
        [string]$Label
    )

    Write-Host "[>>] Running: $Label" -ForegroundColor Cyan
    Write-Host "     Task   : $Task" -ForegroundColor Gray

    $gradlew = Join-Path $Root "gradlew.bat"
    if (-not (Test-Path $gradlew)) {
        $gradlew = Join-Path $Root "gradlew"
    }

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    & $gradlew $Task --no-daemon --stacktrace 2>&1 | ForEach-Object { Write-Host "     $_" -ForegroundColor DarkGray }
    $exitCode = $LASTEXITCODE
    $stopwatch.Stop()

    return [PSCustomObject]@{
        ExitCode  = $exitCode
        Duration  = $stopwatch.Elapsed
    }
}

foreach ($mod in $modules) {
    # Resolve project root for this module (shared-libs prefix means different root)
    $sharedLibsName = $SharedProjectName
    $isShared = $mod.StartsWith("${sharedLibsName}:")
    if ($isShared) {
        $effectiveRoot  = Join-Path (Split-Path $ProjectRoot -Parent) $sharedLibsName
        $effectiveModule = $mod -replace "^${sharedLibsName}:", ''
    } else {
        $effectiveRoot   = $ProjectRoot
        $effectiveModule = $mod
    }

    $platforms = @()
    if ($runJvm)     { $platforms += "jvm" }
    if ($runAndroid) { $platforms += "android" }

    foreach ($plat in $platforms) {
        $task  = Get-BenchmarkGradleTask -Module $effectiveModule -Platform $plat -Config $Config
        $label = "$mod [$plat/$Config]"

        $result = Invoke-GradleBenchmark -Root $effectiveRoot -Task $task -Label $label

        $success = $result.ExitCode -eq 0
        $statusText = if ($success) { "PASS" } else { "FAIL" }
        $color      = if ($success) { "Green" } else { "Red" }
        Write-Host "     Result : $statusText ($([math]::Round($result.Duration.TotalSeconds, 1))s)" -ForegroundColor $color
        Write-Host ""

        $taskResults += [PSCustomObject]@{
            Module   = $mod
            Platform = $plat
            Task     = $task
            Success  = $success
            Duration = $result.Duration
        }
    }
}

# =============================================================================
# JSON RESULT PARSING
# =============================================================================

$benchmarkEntries = @()

foreach ($mod in $modules) {
    $sharedLibsName = $SharedProjectName
    $isShared = $mod.StartsWith("${sharedLibsName}:")
    if ($isShared) {
        $effectiveRoot   = Join-Path (Split-Path $ProjectRoot -Parent) $sharedLibsName
        $effectiveModule = $mod -replace "^${sharedLibsName}:", ''
    } else {
        $effectiveRoot   = $ProjectRoot
        $effectiveModule = $mod
    }

    $modulePath = $effectiveModule -replace ':', [IO.Path]::DirectorySeparatorChar
    $reportsDir = Join-Path $effectiveRoot $modulePath "build" "reports" "benchmarks" "desktop" $Config

    if (-not (Test-Path $reportsDir)) {
        # Also try without config subfolder
        $reportsDir = Join-Path $effectiveRoot $modulePath "build" "reports" "benchmarks" "desktop"
    }

    if (-not (Test-Path $reportsDir)) { continue }

    $jsonFiles = Get-ChildItem -Path $reportsDir -Filter "*.json" -Recurse -ErrorAction SilentlyContinue
    foreach ($jf in $jsonFiles) {
        $parsed = Read-BenchmarkJson -JsonFile $jf.FullName
        foreach ($entry in $parsed) {
            $benchmarkEntries += [PSCustomObject]@{
                Module = $mod
                Name   = $entry.Name
                Mode   = $entry.Mode
                Score  = $entry.Score
                Error  = $entry.Error
                Units  = $entry.Units
            }
        }
    }
}

# =============================================================================
# CONSOLE SUMMARY
# =============================================================================

$passCount = ($taskResults | Where-Object { $_.Success }).Count
$failCount = ($taskResults | Where-Object { -not $_.Success }).Count
$totalTime = [TimeSpan]::Zero
foreach ($tr in $taskResults) { $totalTime += $tr.Duration }

Write-Host ""
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host "  BENCHMARK SUMMARY" -ForegroundColor Cyan
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host ""

Write-Host "Tasks: $($taskResults.Count) total | $passCount passed | $failCount failed | $([math]::Round($totalTime.TotalSeconds, 1))s elapsed" -ForegroundColor White
Write-Host ""

# Task results table
Write-Host ("{0,-40} {1,-10} {2,-8} {3,10}" -f "MODULE", "PLATFORM", "STATUS", "DURATION") -ForegroundColor White
Write-Host ("-" * 70) -ForegroundColor DarkGray

foreach ($tr in $taskResults) {
    $color      = if ($tr.Success) { "Green" } else { "Red" }
    $statusText = if ($tr.Success) { "PASS" } else { "FAIL" }
    $durStr     = "$([math]::Round($tr.Duration.TotalSeconds, 1))s"
    $displayMod = if ($tr.Module.Length -gt 38) { $tr.Module.Substring(0, 35) + "..." } else { $tr.Module }
    Write-Host ("{0,-40} {1,-10} {2,-8} {3,10}" -f $displayMod, $tr.Platform, $statusText, $durStr) -ForegroundColor $color
}

Write-Host ""

# Benchmark entries table (if any parsed results)
if ($benchmarkEntries.Count -gt 0) {
    Write-Host ("{0,-50} {1,-8} {2,14} {3,12} {4}" -f "BENCHMARK", "MODE", "SCORE", "+/- ERROR", "UNITS") -ForegroundColor White
    Write-Host ("-" * 95) -ForegroundColor DarkGray

    foreach ($be in $benchmarkEntries) {
        $displayName = if ($be.Name.Length -gt 48) { $be.Name.Substring(0, 45) + "..." } else { $be.Name }
        $scoreStr = if ($null -ne $be.Score) { "{0:N2}" -f $be.Score } else { "N/A" }
        $errorStr = if ($null -ne $be.Error) { "{0:N2}" -f $be.Error } else { "N/A" }
        Write-Host ("{0,-50} {1,-8} {2,14} {3,12} {4}" -f $displayName, $be.Mode, $scoreStr, $errorStr, $be.Units) -ForegroundColor Gray
    }

    Write-Host ""
}

# =============================================================================
# MARKDOWN REPORT
# =============================================================================

$reportPath = Join-Path $ProjectRoot "benchmark-report.md"
$timestamp  = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

$md = [System.Text.StringBuilder]::new()
[void]$md.AppendLine("# Benchmark Report")
[void]$md.AppendLine("")
[void]$md.AppendLine("- **Date:** $timestamp")
[void]$md.AppendLine("- **Config:** $Config")
[void]$md.AppendLine("- **Platform filter:** $Platform")
[void]$md.AppendLine("- **Module filter:** $ModuleFilter")
[void]$md.AppendLine("- **JVM:** Java $($jvmInfo.Version), $($jvmInfo.Cores) cores")
[void]$md.AppendLine("- **Android devices:** $($androidDevices.Count)")
[void]$md.AppendLine("- **Total duration:** $([math]::Round($totalTime.TotalSeconds, 1))s")
[void]$md.AppendLine("")

# Task results
[void]$md.AppendLine("## Task Results")
[void]$md.AppendLine("")
[void]$md.AppendLine("| Module | Platform | Status | Duration |")
[void]$md.AppendLine("|--------|----------|--------|----------|")

foreach ($tr in $taskResults) {
    $statusText = if ($tr.Success) { "PASS" } else { "FAIL" }
    $durStr     = "$([math]::Round($tr.Duration.TotalSeconds, 1))s"
    [void]$md.AppendLine("| $($tr.Module) | $($tr.Platform) | $statusText | $durStr |")
}

[void]$md.AppendLine("")

# Benchmark results
if ($benchmarkEntries.Count -gt 0) {
    [void]$md.AppendLine("## Benchmark Results")
    [void]$md.AppendLine("")
    [void]$md.AppendLine("| Benchmark | Mode | Score | Error | Units |")
    [void]$md.AppendLine("|-----------|------|------:|------:|-------|")

    foreach ($be in $benchmarkEntries) {
        $scoreStr = if ($null -ne $be.Score) { "{0:N2}" -f $be.Score } else { "N/A" }
        $errorStr = if ($null -ne $be.Error) { "{0:N2}" -f $be.Error } else { "N/A" }
        [void]$md.AppendLine("| $($be.Name) | $($be.Mode) | $scoreStr | $errorStr | $($be.Units) |")
    }

    [void]$md.AppendLine("")
}

# Summary
[void]$md.AppendLine("## Summary")
[void]$md.AppendLine("")
[void]$md.AppendLine("- **Tasks:** $($taskResults.Count) total, $passCount passed, $failCount failed")
[void]$md.AppendLine("- **Benchmarks parsed:** $($benchmarkEntries.Count)")
[void]$md.AppendLine("")

$md.ToString() | Out-File -FilePath $reportPath -Encoding UTF8 -Force

Write-Host "[>>] Report saved to: $reportPath" -ForegroundColor Cyan
Write-Host ""

# =============================================================================
# EXIT CODE
# =============================================================================

if ($failCount -gt 0) {
    Write-Host "[!!] $failCount task(s) failed." -ForegroundColor Red
    exit 1
} else {
    Write-Host "[OK] All benchmark tasks passed." -ForegroundColor Green
    exit 0
}

#!/usr/bin/env powershell
# SPDX-License-Identifier: MIT
<#
.SYNOPSIS
    Thin Node launcher for `kmp-test parallel` / `kmp-test coverage`.

.DESCRIPTION
    v0.8 PIVOT (sub-entry 5): the entire orchestration logic moved to
    lib/parallel-orchestrator.js + lib/coverage-orchestrator.js. This script
    rebuilds kebab-case argv from PascalCase params and execs node lib/runner.js.

    CrossShapeParityTest (gradle-plugin TestKit) keys off this script's
    basename and the --project-root flag — both preserved.

.PARAMETER ProjectRoot
    Path to the main project root. Required.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [switch]$IncludeShared,
    [ValidateSet("all", "common", "androidUnit", "androidInstrumented", "desktop", "ios", "macos")]
    [string]$TestType = "",
    [string]$ModuleFilter = "*",
    [switch]$SkipTests,
    [int]$MinMissedLines = 0,
    [string]$OutputFile = "coverage-full-report.md",
    [string]$JavaHome,
    [int]$MaxWorkers = 0,
    [switch]$FreshDaemon,
    [switch]$CoverageOnly,
    [string]$CoverageModules = "",
    [int]$Timeout = 600,
    [ValidateSet("jacoco", "kover", "auto", "none")]
    [string]$CoverageTool = "auto",
    [string]$ExcludeCoverage = "",
    [string]$TestFilter = "",
    [switch]$IgnoreJdkMismatch,
    [string]$ExcludeModules = "",
    [switch]$IncludeUntested,
    [switch]$DryRun,
    [switch]$NoCoverage,
    [switch]$Benchmark,
    [ValidateSet("smoke", "main", "stress")]
    [string]$BenchmarkConfig = "smoke"
)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Rebuild kebab-case argv from bound params. Order does not matter — Node
# parser reads flags positionally.
$kmpArgv = @('--project-root', $ProjectRoot)
if ($IncludeShared)        { $kmpArgv += @('--include-shared') }
if ($TestType)             { $kmpArgv += @('--test-type', $TestType) }
if ($ModuleFilter -and $ModuleFilter -ne "*") { $kmpArgv += @('--module-filter', $ModuleFilter) }
if ($SkipTests)            { $kmpArgv += @('--skip-tests') }
if ($MinMissedLines -gt 0) { $kmpArgv += @('--min-missed-lines', "$MinMissedLines") }
if ($OutputFile -and $OutputFile -ne "coverage-full-report.md") { $kmpArgv += @('--output-file', $OutputFile) }
if ($JavaHome)             { $kmpArgv += @('--java-home', $JavaHome) }
if ($MaxWorkers -gt 0)     { $kmpArgv += @('--max-workers', "$MaxWorkers") }
if ($CoverageModules)      { $kmpArgv += @('--coverage-modules', $CoverageModules) }
if ($Timeout -ne 600)      { $kmpArgv += @('--timeout', "$Timeout") }
if ($CoverageTool -and $CoverageTool -ne "auto") { $kmpArgv += @('--coverage-tool', $CoverageTool) }
if ($ExcludeCoverage)      { $kmpArgv += @('--exclude-coverage', $ExcludeCoverage) }
if ($TestFilter)           { $kmpArgv += @('--test-filter', $TestFilter) }
if ($IgnoreJdkMismatch)    { $kmpArgv += @('--ignore-jdk-mismatch') }
if ($ExcludeModules)       { $kmpArgv += @('--exclude-modules', $ExcludeModules) }
if ($IncludeUntested)      { $kmpArgv += @('--include-untested') }
if ($DryRun)               { $kmpArgv += @('--dry-run') }
if ($NoCoverage)           { $kmpArgv += @('--no-coverage') }
if ($FreshDaemon)          { $kmpArgv += @('--fresh-daemon') }
if ($CoverageOnly)         { $kmpArgv += @('--coverage-only') }
if ($Benchmark)            { $kmpArgv += @('--benchmark') }
if ($BenchmarkConfig -and $BenchmarkConfig -ne "smoke") { $kmpArgv += @('--benchmark-config', $BenchmarkConfig) }

$kmpScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$kmpRunner = Join-Path $kmpScriptDir '..\..\lib\runner.js'

# --skip-tests routes to coverage subcommand; otherwise parallel.
if ($SkipTests) {
    & node $kmpRunner coverage @kmpArgv
} else {
    & node $kmpRunner parallel @kmpArgv
}
exit $LASTEXITCODE

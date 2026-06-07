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
    [string]$BenchmarkConfig = "smoke",
    [ValidateSet("auto", "debug", "release", "all")]
    [string]$Variant = "auto",
    # 2026-05-05 v0.9 step 1 — parity-gap flags (close the gap between
    # `kmp-test parallel --test-type androidInstrumented` and the dedicated
    # `kmp-test android` subcommand). All five are androidInstrumented-only;
    # no-op for other test types. See lib/parallel-orchestrator.js.
    [string]$Device = "",
    [string]$DeviceTask = "",
    [switch]$AutoRetry,
    [switch]$ClearData,
    [string]$Flavor = "",
    # 2026-06-07 — forensic capture on instrumented-module failure (screenshot +
    # UI-hierarchy dump via adb). Parity with `kmp-test android`;
    # androidInstrumented-only, no-op for other test types. CaptureDir (when set)
    # implies CaptureOnFail. Param-block whitelist needed because the wrapper has
    # `passthrough: false` (cli.js strips kebab→PascalCase upstream).
    [switch]$CaptureOnFail,
    [string]$CaptureDir = "",
    # 2026-05-05 v0.9 step 2 — global escape hatch. Single string param
    # (NOT [string[]]) because PowerShell binds string-array params via comma
    # syntax, but gradle prop values legitimately contain commas (`-Pfoo=a,b`).
    # cli.js#collapseGradleArgs joins repeated `--gradle-args` invocations with
    # ASCII Unit Separator (\x1F) into a single value; this wrapper splits on
    # the same separator below and re-emits one `--gradle-args <tok>` per
    # element so the Node-side parser sees the canonical multi-invocation
    # shape. Stays empty when the user passes no `--gradle-args`.
    [string]$GradleArgs = "",
    # 2026-05-05 v0.9 step 4 — concurrency Tier 3 isolated cache dir.
    # `--isolated` injects gradle's --project-cache-dir <tmp> into every
    # spawn so concurrent kmp-test runs don't share <project>/.gradle/.
    # `--isolated-cache-dir` lets users pin the location (CI tmpfs / RAM
    # disk). `--isolated-no-lock` opts out of the Tier 1 advisory lockfile
    # (cli.js consumes it; forwarded here for envelope mirroring).
    [switch]$Isolated,
    [string]$IsolatedCacheDir = "",
    [switch]$IsolatedNoLock,
    # 2026-05-08 v0.9 step 9.8 (Bug #7) — `--list-only` mirrors the android
    # subcommand's flag. Short-circuits parallel-orchestrator before any
    # gradle dispatch, emitting the post-filter module set + skipped[] +
    # coverage block. Param-block whitelist needed because the wrapper has
    # `passthrough: false` (cli.js strips kebab→PascalCase upstream).
    [switch]$ListOnly
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
if ($Variant -and $Variant -ne "auto") { $kmpArgv += @('--variant', $Variant) }
# 2026-05-05 v0.9 step 1 — parity-gap flag passthrough.
if ($Device)               { $kmpArgv += @('--device', $Device) }
if ($DeviceTask)           { $kmpArgv += @('--device-task', $DeviceTask) }
if ($AutoRetry)            { $kmpArgv += @('--auto-retry') }
if ($ClearData)            { $kmpArgv += @('--clear-data') }
if ($Flavor)               { $kmpArgv += @('--flavor', $Flavor) }
# 2026-06-07 — forensic capture on instrumented failure passthrough.
if ($CaptureOnFail)        { $kmpArgv += @('--capture-on-fail') }
if ($CaptureDir)           { $kmpArgv += @('--capture-dir', $CaptureDir) }
# 2026-05-05 v0.9 step 2 — gradle-args escape hatch. cli.js joined multi-
# invocation values with ASCII \x1F. Split + re-emit one --gradle-args per
# token so the Node-side parser sees the canonical multi-invocation shape.
if ($GradleArgs) {
    $sep = [char]0x1F
    foreach ($g in ($GradleArgs -split $sep)) {
        if ($g) { $kmpArgv += @('--gradle-args', $g) }
    }
}
# 2026-05-05 v0.9 step 4 — concurrency Tier 3 isolated cache dir passthrough.
if ($Isolated)         { $kmpArgv += @('--isolated') }
if ($IsolatedCacheDir) { $kmpArgv += @('--isolated-cache-dir', $IsolatedCacheDir) }
if ($IsolatedNoLock)   { $kmpArgv += @('--isolated-no-lock') }
# 2026-05-08 v0.9 step 9.8 (Bug #7) — --list-only passthrough.
if ($ListOnly)         { $kmpArgv += @('--list-only') }

$kmpScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$kmpRunner = Join-Path $kmpScriptDir '..\..\lib\runner.js'

# --skip-tests routes to coverage subcommand; otherwise parallel.
if ($SkipTests) {
    & node $kmpRunner coverage @kmpArgv
} else {
    & node $kmpRunner parallel @kmpArgv
}
exit $LASTEXITCODE

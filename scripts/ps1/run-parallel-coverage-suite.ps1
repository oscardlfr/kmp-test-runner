#!/usr/bin/env powershell
<#
.SYNOPSIS
    Run all tests in parallel using a SINGLE Gradle invocation with full coverage report.

.DESCRIPTION
    Executes tests for all modules using ONE Gradle command with --parallel --continue,
    then generates Kover coverage reports and produces a comprehensive markdown report.

    KEY DIFFERENCE from run-full-coverage-suite.ps1:
    - Single Gradle invocation instead of one per module
    - Uses Gradle daemon (no --no-daemon) for JVM reuse
    - Parallel module execution via --parallel flag
    - ~2-3x faster overall execution

    Supports both Android projects and Kotlin Multiplatform (KMP) projects.

.PARAMETER ProjectRoot
    Path to the main project root. Required.

.PARAMETER IncludeShared
    Include sibling shared-libs modules in test execution and coverage report (requires SHARED_PROJECT_NAME env var).

.PARAMETER TestType
    Test type: "common", "desktop", "androidUnit", "androidInstrumented", "all".
    Default: auto-detect based on project type.

.PARAMETER ModuleFilter
    Filter modules by pattern. Supports wildcards and comma-separated values.

.PARAMETER SkipTests
    Skip test execution and only regenerate coverage report from existing data.

.PARAMETER MinMissedLines
    Minimum missed lines to include a class in gaps report. Default: 0.

.PARAMETER OutputFile
    Output markdown file name. Default: coverage-full-report.md

.PARAMETER JavaHome
    Override JAVA_HOME for Gradle execution.

.PARAMETER MaxWorkers
    Override Gradle worker count. 0 = auto (Gradle default based on CPU).

.PARAMETER FreshDaemon
    Stop existing Gradle daemons before starting.

.PARAMETER CoverageOnly
    Only run modules specified in -CoverageModules. Defaults to core:model, core:domain, core:data, core:audio.

.PARAMETER CoverageModules
    Comma-separated list of module patterns for -CoverageOnly mode.
    Default: "core:model,core:domain,core:data,core:audio".

.EXAMPLE
    ./run-parallel-coverage-suite.ps1 -ProjectRoot "C:\Projects\MyApp"

.EXAMPLE
    ./run-parallel-coverage-suite.ps1 -ProjectRoot "C:\Projects\MyApp" -FreshDaemon -MaxWorkers 4

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
    [string]$ModuleFilter = "*",
    [switch]$SkipTests,
    [int]$MinMissedLines = 0,
    [string]$OutputFile = "coverage-full-report.md",
    [string]$JavaHome,
    [int]$MaxWorkers = 0,
    [switch]$FreshDaemon,
    [switch]$CoverageOnly,
    [string]$CoverageModules = "core:model,core:domain,core:data,core:audio",
    [int]$Timeout = 600,
    [ValidateSet("jacoco", "kover", "auto", "none")]
    [string]$CoverageTool = "auto",
    [string]$ExcludeCoverage = "",
    [switch]$Benchmark,
    [ValidateSet("smoke", "main", "stress")]
    [string]$BenchmarkConfig = "smoke",
    [string]$TestFilter = ""
)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ----------------------------------------------------------------------------
# RUN ID — concurrent-invocation safety (v0.3.8+)
# Format: YYYYMMDD-HHMMSS-PID6 (zero-padded last 6 digits of PID). Used to
# disambiguate temp logs and report filenames when multiple kmp-test runs
# share the same project root.
# ----------------------------------------------------------------------------
if ([string]::IsNullOrEmpty($env:KMP_RUN_ID)) {
    $env:KMP_RUN_ID = "{0}-{1:D6}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), ($PID % 1000000)
}
$KmpRunId = $env:KMP_RUN_ID

# Source coverage detection library
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$scriptDir\lib\Coverage-Detect.ps1"

# ============================================================================
# CONFIGURATION
# ============================================================================

$SkipDesktopModules = if ($env:SKIP_DESKTOP_MODULES) { $env:SKIP_DESKTOP_MODULES.Split(",") | ForEach-Object { $_.Trim() } } else { @() }
$SkipAndroidModules = if ($env:SKIP_ANDROID_MODULES) { $env:SKIP_ANDROID_MODULES.Split(",") | ForEach-Object { $_.Trim() } } else { @() }
$ParentOnlyModules = if ($env:PARENT_ONLY_MODULES) { $env:PARENT_ONLY_MODULES.Split(",") | ForEach-Object { $_.Trim() } } else { @() }
$CoreOnlyModules = $CoverageModules.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }

$ExclusionPatterns = @(
    '*$DefaultImpls',
    '*$Companion',
    '*$$serializer',
    'ComposableSingletons$*'
)

# ============================================================================
# UTILITY FUNCTIONS (shared with run-full-coverage-suite.ps1)
# ============================================================================

function Get-ProjectType {
    param([string]$Root)
    if (Test-Path (Join-Path $Root "desktopApp")) { return "kmp-desktop" }
    $projectName = Split-Path $Root -Leaf
    if ($projectName -match "kmp|shared-kmp") { return "kmp-desktop" }
    $anyBuildGradle = Get-ChildItem -Path $Root -Filter "build.gradle.kts" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 5
    foreach ($file in $anyBuildGradle) {
        $content = Get-Content $file.FullName -ErrorAction SilentlyContinue | Select-Object -First 30
        if ($content -match 'kotlin\.multiplatform' -and $content -match 'jvm\("desktop"\)') {
            return "kmp-desktop"
        }
    }
    return "android"
}

function Test-ClassExcluded {
    param([string]$ClassName)
    foreach ($pattern in $ExclusionPatterns) {
        if ($ClassName -like $pattern) { return $true }
    }
    return $false
}

function Format-LineRanges {
    param([int[]]$Lines)
    if ($Lines.Count -eq 0) { return "-" }
    $ranges = [System.Collections.Generic.List[string]]::new()
    $start = $Lines[0]
    $end = $start
    for ($i = 1; $i -lt $Lines.Count; $i++) {
        $current = $Lines[$i]
        if ($current -eq ($end + 1)) {
            $end = $current
        } else {
            $ranges.Add($(if ($start -eq $end) { "$start" } else { "$start-$end" }))
            $start = $current
            $end = $current
        }
    }
    $ranges.Add($(if ($start -eq $end) { "$start" } else { "$start-$end" }))
    return $ranges -join ", "
}

function Find-Modules {
    param([string]$ProjectRoot, [string]$Filter)

    # Build set of modules actually included in settings.gradle.kts
    $settingsFile = Join-Path $ProjectRoot "settings.gradle.kts"
    $includedModules = @{}
    if (Test-Path $settingsFile) {
        Get-Content $settingsFile | ForEach-Object {
            # Match active include() lines (not commented out)
            if ($_ -match '^\s*include\s*\(\s*"([^"]+)"\s*\)') {
                $gradlePath = $Matches[1]
                # Convert Gradle path ":feature:projects" to filesystem path "feature:projects"
                $fsPath = $gradlePath.TrimStart(":")
                $includedModules[$fsPath] = $true
            }
        }
    }

    $allModules = Get-ChildItem -Path $ProjectRoot -Recurse -Filter "build.gradle.kts" -ErrorAction SilentlyContinue | ForEach-Object {
        $relPath = $_.DirectoryName.Replace($ProjectRoot, "") -replace '\\', ':'
        if ($relPath -ne "" -and $relPath -notmatch "[\\/]build[\\/]" -and $relPath -notmatch "\.gradle") {
            $relPath.TrimStart(":")
        }
    } | Where-Object { $_ } | Sort-Object -Unique

    # Filter out modules not in settings.gradle.kts (commented out or removed)
    if ($includedModules.Count -gt 0) {
        $allModules = $allModules | Where-Object { $includedModules.ContainsKey($_) }
    }

    $filterList = $Filter.Split(",") | ForEach-Object { $_.Trim() }
    $modules = $allModules | Where-Object {
        $mod = $_
        $isMatched = $false
        foreach ($f in $filterList) {
            if ($mod -like $f) { $isMatched = $true; break }
        }
        $isMatched
    }
    $modules = $modules | Where-Object { $_ -notin $ParentOnlyModules }
    return $modules
}

function Parse-CoverageReport {
    param([string]$XmlPath, [string]$ModuleName)
    if (-not (Test-Path $XmlPath)) { return $null }
    try {
        $parserScript = Join-Path $scriptDir "..\lib\parse-coverage-xml.py"
        $output = python3 $parserScript $XmlPath $ModuleName 2>$null
        if (-not $output) { return $null }

        $classes = [System.Collections.Generic.List[object]]::new()
        foreach ($line in ($output -split "`n")) {
            $line = $line.Trim()
            if (-not $line) { continue }
            $parts = $line.Split('|')
            if ($parts.Count -lt 9) { continue }
            $missedLinesArr = @()
            if ($parts[8] -and $parts[8].Trim() -ne '') {
                $missedLinesArr = $parts[8].Split(',') | ForEach-Object { [int]$_.Trim() } | Sort-Object
            }
            $classes.Add([PSCustomObject]@{
                Module      = $parts[0]
                Package     = $parts[1]
                SourceFile  = $parts[2]
                ClassName   = $parts[3]
                Covered     = [int]$parts[4]
                Missed      = [int]$parts[5]
                Total       = [int]$parts[6]
                CoveragePct = [double]$parts[7]
                MissedLines = $missedLinesArr
            })
        }
        return $classes
    } catch {
        return $null
    }
}


# ============================================================================
# MAIN EXECUTION
# ============================================================================

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Parallel Test Suite + Coverage Report" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Validate project path
if (-not (Test-Path $ProjectRoot)) {
    Write-Host "[ERROR] Project path does not exist: $ProjectRoot" -ForegroundColor Red
    exit 2
}

$ProjectRoot = (Resolve-Path $ProjectRoot).Path
$projectName = Split-Path $ProjectRoot -Leaf

# Set JAVA_HOME if provided
if ($JavaHome -and $JavaHome.Trim() -ne "") {
    $env:JAVA_HOME = $JavaHome
    Write-Host "Using JAVA_HOME override: $($env:JAVA_HOME)" -ForegroundColor Cyan
}

# Auto-detect required JDK version from project
if (-not $JavaHome -and (Test-Path $ProjectRoot)) {
    # Check gradle.properties
    $gradleProps = Join-Path $ProjectRoot "gradle.properties"
    if (Test-Path $gradleProps) {
        $javaHomeLine = Get-Content $gradleProps -ErrorAction SilentlyContinue |
            Where-Object { $_ -match "^org\.gradle\.java\.home" } |
            Select-Object -First 1
        if ($javaHomeLine) {
            $gradleJava = ($javaHomeLine -split "=", 2)[1].Trim()
            if (Test-Path $gradleJava) {
                $env:JAVA_HOME = $gradleJava
                Write-Host "Auto-detected JAVA_HOME from gradle.properties: $($env:JAVA_HOME)" -ForegroundColor Cyan
            }
        }
    }
    # Check jvmToolchain version mismatch
    if (-not $javaHomeLine) {
        $jvmLine = Get-ChildItem -Path $ProjectRoot -Recurse -Include "*.gradle.kts" -ErrorAction SilentlyContinue |
            Select-Object -First 20 |
            ForEach-Object { Get-Content $_.FullName -ErrorAction SilentlyContinue } |
            Where-Object { $_ -match "jvmToolchain" } |
            Select-Object -First 1
        if ($jvmLine -match "(\d+)") {
            $requiredVersion = $Matches[1]
            $currentVersion = (java -version 2>&1 | Select-Object -First 1) -replace '.*"(\d+).*', '$1'
            if ($currentVersion -and $requiredVersion -and $currentVersion -ne $requiredVersion) {
                Write-Host "[!] Project requires JDK $requiredVersion but JAVA_HOME points to JDK $currentVersion" -ForegroundColor Yellow
                Write-Host "    Use -JavaHome <path-to-jdk-$requiredVersion> or set JAVA_HOME before running" -ForegroundColor Yellow
                Write-Host "    With -FreshDaemon this WILL cause UnsupportedClassVersionError" -ForegroundColor Yellow
            }
        }
    }
}

# Detect platform and test type
$projectType = Get-ProjectType -Root $ProjectRoot

if ($TestType -eq "") {
    if ($projectType -eq "kmp-desktop") {
        $TestType = "common"
    } else {
        $TestType = "androidUnit"
    }
}

$Desktop = ($TestType -eq "common" -or $TestType -eq "desktop")

$platformName = switch ($TestType) {
    "common" { "desktop (commonTest)" }
    "desktop" { "desktop (desktopTest)" }
    "androidUnit" { "android (androidUnitTest)" }
    "androidInstrumented" { "android (instrumented)" }
    "all" { "all test types" }
    default { if ($Desktop) { "desktop" } else { "android" } }
}

# ============================================================================
# DAEMON MANAGEMENT
# ============================================================================

if ($FreshDaemon) {
    Write-Host "[>] Stopping existing Gradle daemons..." -ForegroundColor Yellow
    Push-Location $ProjectRoot
    & ./gradlew --stop 2>&1 | Out-Null
    Pop-Location

    # Clean cached coverage reports so Kover regenerates from scratch
    Write-Host "  [>] Cleaning cached coverage reports..." -ForegroundColor Cyan
    Get-ChildItem -Path $ProjectRoot -Recurse -Directory -Filter "kover" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "build[\\/]reports[\\/]kover" } |
        ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    Get-ChildItem -Path $ProjectRoot -Recurse -Directory -Filter "jacoco" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "build[\\/]reports[\\/]jacoco" } |
        ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

    Write-Host "  [OK] Daemons stopped + coverage cache cleaned" -ForegroundColor Green
    Write-Host ""
} else {
    # Check daemon status
    Push-Location $ProjectRoot
    $daemonStatus = & ./gradlew --status 2>&1
    Pop-Location
    $busyDaemons = $daemonStatus | Select-String "BUSY"
    if ($busyDaemons) {
        Write-Host "[!] WARNING: Busy Gradle daemons detected. Use -FreshDaemon to clean them." -ForegroundColor Yellow
        Write-Host ""
    }
}

# ============================================================================
# DISCOVER MODULES
# ============================================================================

$projectsToProcess = @(
    [PSCustomObject]@{ Name = $projectName; Path = $ProjectRoot; Prefix = "" }
)

$SharedProjectName = if ($env:SHARED_PROJECT_NAME) { $env:SHARED_PROJECT_NAME } else { "" }

if ($IncludeShared) {
    if (-not $SharedProjectName -and -not $env:SHARED_ROOT) {
        Write-Host "[!] --include-shared requires SHARED_PROJECT_NAME or SHARED_ROOT env var" -ForegroundColor Yellow
    } else {
        $sharedLibsPath = if ($env:SHARED_ROOT) {
            $env:SHARED_ROOT
        } else {
            Join-Path (Split-Path $ProjectRoot -Parent) $SharedProjectName
        }
        $resolvedName = if ($SharedProjectName) { $SharedProjectName } else { Split-Path $sharedLibsPath -Leaf }
        $sharedLibsResolved = (Resolve-Path $sharedLibsPath -ErrorAction SilentlyContinue).Path
        $projectRootResolved = (Resolve-Path $ProjectRoot).Path
        if ($sharedLibsResolved -and (Test-Path $sharedLibsResolved) -and ($sharedLibsResolved -ne $projectRootResolved)) {
            $projectsToProcess += [PSCustomObject]@{
                Name = $resolvedName
                Path = $sharedLibsResolved
                Prefix = "${resolvedName}:"
            }
            Write-Host "[+] Including ${resolvedName}: $sharedLibsResolved" -ForegroundColor Green
        } elseif ($sharedLibsResolved -eq $projectRootResolved) {
            Write-Host "[~] $resolvedName IS the project root - skipping duplicate" -ForegroundColor DarkYellow
        } else {
            Write-Host "[!] $resolvedName not found at: $sharedLibsPath" -ForegroundColor Yellow
        }
    }
}

$allModules = [System.Collections.Generic.List[object]]::new()

foreach ($project in $projectsToProcess) {
    Write-Host "[>] Discovering modules in $($project.Name)..." -ForegroundColor Cyan

    $modules = Find-Modules -ProjectRoot $project.Path -Filter $ModuleFilter

    foreach ($mod in $modules) {
        $moduleName = if ($project.Prefix) { "$($project.Prefix)$mod" } else { $mod }
        $modulePath = Join-Path $project.Path ($mod -replace ':', '/')

        $allModules.Add([PSCustomObject]@{
            Name = $moduleName
            Path = $modulePath
            ProjectRoot = $project.Path
            ShortName = $mod.Split(":")[-1]
            GradlePath = $mod
        })
    }
}

# Apply CoverageOnly filter
if ($CoverageOnly) {
    $allModules = $allModules | Where-Object {
        $mod = $_
        $isCoreModule = $false
        foreach ($coreMod in $CoreOnlyModules) {
            if ($mod.Name -eq $coreMod -or $mod.Name -like "*:$coreMod") {
                $isCoreModule = $true
                break
            }
        }
        $isCoreModule
    }
    Write-Host "[>] Coverage-only mode: filtering to core modules" -ForegroundColor Yellow
}

if ($allModules.Count -eq 0) {
    Write-Host "[ERROR] No modules found matching filter: $ModuleFilter" -ForegroundColor Red
    exit 3
}

Write-Host ""
Write-Host "Configuration:" -ForegroundColor Cyan
Write-Host "  Project: $projectName"
Write-Host "  Test Type: $TestType ($platformName)"
Write-Host "  Include shared: $IncludeShared"
Write-Host "  Skip tests: $SkipTests"
Write-Host "  Module filter: $ModuleFilter"
Write-Host "  Coverage only: $CoverageOnly"
Write-Host "  Coverage tool: $CoverageTool"
Write-Host "  Max workers: $(if ($MaxWorkers -gt 0) { $MaxWorkers } else { 'auto' })"
Write-Host "  Timeout: ${Timeout}s"
Write-Host "  Modules found: $($allModules.Count)"
Write-Host ""

# ============================================================================
# BUILD TASK LISTS
# ============================================================================

# Separate task lists by project (main vs shared-libs)
# Use List<T> for O(1) amortized appends instead of O(N) array += copies
$testTasks = [System.Collections.Generic.List[string]]::new()
$testTasksShared = [System.Collections.Generic.List[string]]::new()
$covTasks = [System.Collections.Generic.List[string]]::new()
$covTasksShared = [System.Collections.Generic.List[string]]::new()
$skippedModules = [System.Collections.Generic.List[object]]::new()
$testableModules = [System.Collections.Generic.List[object]]::new()

foreach ($module in $allModules) {
    # Check if module should be skipped
    $shouldSkip = $false
    if ($Desktop -and $SkipDesktopModules -contains $module.ShortName) {
        $shouldSkip = $true
    }
    if (-not $Desktop -and $SkipAndroidModules -contains $module.ShortName) {
        $shouldSkip = $true
    }

    if ($shouldSkip) {
        $skippedModules.Add($module)
        Write-Host "  [SKIP] $($module.Name) (no $TestType tests)" -ForegroundColor DarkYellow
        continue
    }

    $testableModules.Add($module)

    $isShared = $SharedProjectName -and $module.Name.StartsWith("${SharedProjectName}:")
    $shortMod = if ($isShared) { $module.Name.Substring("${SharedProjectName}:".Length) } else { $module.Name }
    # Convert colon-separated module path to Gradle task path
    $gradlePath = ":$($shortMod -replace ':', ':')"

    $testTask = switch ($TestType) {
        "common" { "${gradlePath}:desktopTest" }
        "desktop" { "${gradlePath}:desktopTest" }
        "androidUnit" { "${gradlePath}:testDebugUnitTest" }
        "androidInstrumented" { "${gradlePath}:connectedDebugAndroidTest" }
        "all" { "${gradlePath}:desktopTest" }
        default {
            if ($Desktop) { "${gradlePath}:desktopTest" } else { "${gradlePath}:testDebugUnitTest" }
        }
    }

    # Route tasks to the correct project's task list
    if ($isShared) {
        $testTasksShared.Add($testTask)
    } else {
        $testTasks.Add($testTask)
    }

    # Determine coverage tool for this module
    $buildFile = Join-Path $module.Path "build.gradle.kts"

    # Check if module is excluded from coverage
    $skipCov = $false

    # Auto-exclude patterns (built-in)
    $autoExcludePatterns = @("*:testing", "*:test-fakes", "*:test-fixtures", "konsist-guard", "konsist-tests", "detekt-rules*", "*detekt-rules*", "benchmark", "benchmark-*", "desktopApp")
    $modNameClean = $module.Name.TrimStart(':')
    foreach ($pattern in $autoExcludePatterns) {
        if ($modNameClean -like $pattern) {
            $skipCov = $true
            Write-Host "  [INFO] $($module.Name) - auto-excluded from coverage ($pattern)" -ForegroundColor DarkGray
            break
        }
    }

    # User-specified excludes
    if (-not $skipCov -and $ExcludeCoverage) {
        $exclList = $ExcludeCoverage -split ',' | ForEach-Object { $_.Trim() }
        foreach ($excl in $exclList) {
            $exclClean = $excl.TrimStart(':')
            if ($modNameClean -eq $exclClean) { $skipCov = $true; break }
        }
    }

    if ($skipCov) {
        $modCovTool = "none"
        Write-Host "  [INFO] $($module.Name) - excluded from coverage (--ExcludeCoverage)" -ForegroundColor DarkGray
    } elseif ($CoverageTool -eq "auto") {
        $modCovTool = Detect-CoverageTool -BuildFilePath $buildFile
    } elseif ($CoverageTool -eq "none") {
        $modCovTool = "none"
    } else {
        $modCovTool = $CoverageTool
    }

    # Store tool for later use in parsing
    $module | Add-Member -NotePropertyName "CovTool" -NotePropertyValue $modCovTool -Force

    # Get coverage task (only if not excluded)
    if (-not $skipCov) {
        $covTaskName = Get-CoverageGradleTask -Tool $modCovTool -TestType $TestType -IsDesktop $Desktop
        if ($covTaskName) {
            $covTask = "${gradlePath}:${covTaskName}"
            if ($isShared) {
                $covTasksShared.Add($covTask)
            } else {
                $covTasks.Add($covTask)
            }
        } else {
            $displayName = Get-CoverageDisplayName -Tool $modCovTool
            Write-Host "  [INFO] $($module.Name) - no coverage ($displayName), skipping" -ForegroundColor DarkGray
        }
    }
}

Write-Host ""
Write-Host "Testable modules: $($testableModules.Count) | Skipped: $($skippedModules.Count)" -ForegroundColor White
Write-Host ""

# ============================================================================
# RUN TESTS (SINGLE GRADLE INVOCATION)
# ============================================================================

$testResults = @{}
$successCount = 0
$failureCount = 0
$skippedCount = $skippedModules.Count
$startTime = Get-Date

# Initialize skipped modules in results
foreach ($module in $skippedModules) {
    $testResults[$module.Name] = @{ Status = "skipped"; Coverage = $null }
}

$allTestTasks = $testTasks + $testTasksShared
if (-not $SkipTests -and $allTestTasks.Count -gt 0) {
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host "  Running Tests (Single Invocation)" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host ""

    # Build Gradle command — main project tasks run from main root (composite build resolves shared-libs)
    $gradleArgs = @()
    $gradleArgs += $allTestTasks
    $gradleArgs += "--parallel"
    $gradleArgs += "--continue"

    if ($MaxWorkers -gt 0) {
        $gradleArgs += "--max-workers=$MaxWorkers"
    }
    # gradle's --tests applies to every Test task in $gradleArgs; modules without a
    # matching class run zero tests rather than erroring.
    if ($TestFilter) {
        $gradleArgs += @("--tests", $TestFilter)
    }

    Write-Host "[>] Executing $($allTestTasks.Count) test tasks in parallel..." -ForegroundColor Cyan
    Write-Host "    Command: ./gradlew $($allTestTasks.Count) tasks --parallel --continue" -ForegroundColor DarkGray

    # List tasks for visibility
    foreach ($task in $allTestTasks) {
        Write-Host "    $task" -ForegroundColor Gray
    }
    Write-Host ""

    # Run Gradle with output streaming (pipe-safe — no Start-Process hang)
    # Using System.Diagnostics.Process for reliable stdout/stderr capture
    # that works both in native PowerShell and when piped from bash.
    # Run-id (PID-suffixed) prevents log clobber when two runs start in same second.
    $tempLog = Join-Path $env:TEMP "gradle-parallel-tests-$KmpRunId.log"
    $gradleExe = Join-Path $ProjectRoot "gradlew.bat"
    $argString = ($gradleArgs -join " ")

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $gradleExe
    $psi.Arguments = $argString
    $psi.WorkingDirectory = $ProjectRoot
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $proc = [System.Diagnostics.Process]::Start($psi)

    # Async read stdout/stderr to avoid deadlocks
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()

    $elapsed = 0
    $interval = 15  # Check every 15 seconds

    Write-Host ""
    while (-not $proc.HasExited) {
        Start-Sleep -Seconds $interval
        $elapsed += $interval

        # Progress heartbeat
        $workers = Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match "GradleWorkerMain" }
        $activeModule = "unknown"
        foreach ($w in $workers) {
            if ($w.CommandLine -match '(feature|core)[\\/]([a-z-]+)[\\/]build') {
                $activeModule = "$($Matches[1]):$($Matches[2])"
                break
            }
        }

        $mins = [math]::Floor($elapsed / 60)
        $secs = $elapsed % 60
        Write-Host "  [${mins}m${secs}s] Running... active: $activeModule" -ForegroundColor DarkGray

        # Timeout check
        if ($elapsed -ge $Timeout) {
            Write-Host ""
            Write-Host "[TIMEOUT] Tests exceeded ${Timeout}s limit! Killing Gradle..." -ForegroundColor Red
            Write-Host "[TIMEOUT] Stuck module: $activeModule" -ForegroundColor Red

            # Kill the Gradle process tree
            $proc | Stop-Process -Force -ErrorAction SilentlyContinue
            Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -match "GradleWorkerMain" } |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Seconds 2

            # Cross-project clean: shared project first, then main project
            $sharedPath = if ($env:SHARED_ROOT) { $env:SHARED_ROOT } elseif ($SharedProjectName) { Join-Path (Split-Path $ProjectRoot -Parent) $SharedProjectName } else { $null }
            if ($sharedPath -and (Test-Path $sharedPath)) {
                Write-Host "[RECOVERY] Stopping daemons in $SharedProjectName..." -ForegroundColor Yellow
                Push-Location $sharedPath
                & ./gradlew --stop 2>&1 | Out-Null
                Pop-Location
            }
            Write-Host "[RECOVERY] Stopping daemons in $projectName..." -ForegroundColor Yellow
            Push-Location $ProjectRoot
            & ./gradlew --stop 2>&1 | Out-Null
            Pop-Location

            break
        }
    }

    # Ensure exit code is available after process completion
    if (-not ($elapsed -ge $Timeout)) {
        $proc.WaitForExit()
    }

    # Collect output from async readers
    $testExitCode = $proc.ExitCode
    $stdoutContent = if ($stdoutTask.IsCompleted) { $stdoutTask.Result } else { $stdoutTask.GetAwaiter().GetResult() }
    $stderrContent = if ($stderrTask.IsCompleted) { $stderrTask.Result } else { $stderrTask.GetAwaiter().GetResult() }
    $proc.Dispose()

    # Write to temp log for any downstream consumers, then parse
    if ($stdoutContent) {
        Set-Content -Path $tempLog -Value $stdoutContent -Encoding UTF8 -ErrorAction SilentlyContinue
    }
    $testOutput = if ($stdoutContent) { $stdoutContent -split "`n" } else { @() }

    # Report timeout as failure
    if ($elapsed -ge $Timeout) {
        Write-Host "[!] Timed out after ${Timeout}s. Stuck on: $activeModule" -ForegroundColor Red
        Write-Host "[!] Tip: Run /test $activeModule to isolate the issue" -ForegroundColor Yellow
        $testExitCode = 124  # Standard timeout exit code
    }

    # Parse output to determine per-module results
    $testOutputStr = $testOutput -join "`n"

    # Clean up temp log
    Remove-Item $tempLog -Force -ErrorAction SilentlyContinue

    foreach ($module in $testableModules) {
        $isShared = $SharedProjectName -and $module.Name.StartsWith("${SharedProjectName}:")
        $shortMod = if ($isShared) { $module.Name.Substring("${SharedProjectName}:".Length) } else { $module.Name }
        $gradlePath = ":$($shortMod -replace ':', ':')"

        # Check if this module's test task failed
        $taskName = switch ($TestType) {
            "common" { "${gradlePath}:desktopTest" }
            "desktop" { "${gradlePath}:desktopTest" }
            "androidUnit" { "${gradlePath}:testDebugUnitTest" }
            default { if ($Desktop) { "${gradlePath}:desktopTest" } else { "${gradlePath}:testDebugUnitTest" } }
        }

        # Look for FAILED marker in output for this task
        $failedPattern = [regex]::Escape($taskName) + " FAILED"
        if ($testOutputStr -match $failedPattern) {
            Write-Host "  [FAIL] $($module.Name)" -ForegroundColor Red
            $testResults[$module.Name] = @{ Status = "failed"; Coverage = $null }
            $failureCount++
        } else {
            Write-Host "  [PASS] $($module.Name)" -ForegroundColor Green
            $testResults[$module.Name] = @{ Status = "passed"; Coverage = $null }
            $successCount++
        }
    }

    $testDuration = (Get-Date) - $startTime

    Write-Host ""
    if ($testExitCode -ne 0 -and $failureCount -eq 0) {
        # Gradle failed but no specific task was identified - mark as general failure
        Write-Host "[!] Gradle exited with code $testExitCode (some tasks may have failed)" -ForegroundColor Yellow
    }
    Write-Host "Test Duration: $([int]$testDuration.TotalMinutes)m $($testDuration.Seconds)s" -ForegroundColor Cyan
    Write-Host ""

    # ========================================================================
    # GENERATE COVERAGE REPORTS (SINGLE INVOCATION)
    # ========================================================================

    Write-Host "[>] Generating coverage reports..." -ForegroundColor Cyan

    # Run main project coverage tasks from ProjectRoot
    # Do NOT use --rerun-tasks here: it forces re-execution of desktopTest
    # dependencies, and modules like core-storage-secure fail with residual
    # keystore state. Kover generates XML from UP-TO-DATE test results fine.
    if ($covTasks.Count -gt 0) {
        $covArgs = @()
        $covArgs += $covTasks
        $covArgs += "--parallel"
        $covArgs += "--continue"
        if ($MaxWorkers -gt 0) { $covArgs += "--max-workers=$MaxWorkers" }

        Push-Location $ProjectRoot
        $covOutput = & ./gradlew @covArgs 2>&1
        $covExitCode = $LASTEXITCODE
        Pop-Location

        if ($covExitCode -ne 0) {
            # Check if --continue saved us: count existing XML reports
            $covXmlCount = 0
            foreach ($mod in ($allModules | Where-Object { $_.ProjectRoot -eq $ProjectRoot })) {
                $modTool = $mod.CovTool
                if (-not $modTool -or $modTool -eq "none") { continue }
                $xmlCheck = Get-CoverageXmlPath -Tool $modTool -ModulePath $mod.Path -IsDesktop $Desktop
                if ($xmlCheck) { $covXmlCount++ }
            }

            if ($covXmlCount -gt 0) {
                # Partial success — collect missing tasks and retry as a single batch
                # (no --no-configuration-cache: cache is intact, just re-run missing tasks)
                $missingTasks = [System.Collections.Generic.List[string]]::new()
                foreach ($mod in ($allModules | Where-Object { $_.ProjectRoot -eq $ProjectRoot })) {
                    $modTool = $mod.CovTool
                    if (-not $modTool -or $modTool -eq "none") { continue }
                    $xmlCheck = Get-CoverageXmlPath -Tool $modTool -ModulePath $mod.Path -IsDesktop $Desktop
                    if (-not $xmlCheck) {
                        $modName = $mod.Name.TrimStart(':')
                        $gpath = ":$modName"
                        $missingTaskName = Get-CoverageGradleTask -Tool $modTool -TestType $TestType -IsDesktop $Desktop
                        $missingTasks.Add("${gpath}:${missingTaskName}")
                    }
                }
                $missingCov = $missingTasks.Count
                $recoveredCov = 0
                if ($missingCov -gt 0) {
                    Write-Host "  [>] Batch partial: $covXmlCount ok, $missingCov missing -> retrying as single batch..." -ForegroundColor Yellow
                    $retryArgs = @($missingTasks) + @("--parallel", "--continue")
                    if ($MaxWorkers -gt 0) { $retryArgs += "--max-workers=$MaxWorkers" }
                    Push-Location $ProjectRoot
                    & ./gradlew @retryArgs 2>&1 | Out-Null
                    $retryExit = $LASTEXITCODE
                    Pop-Location
                    if ($retryExit -eq 0) {
                        $recoveredCov = $missingCov
                    } else {
                        # Count how many were actually recovered
                        foreach ($mod in ($allModules | Where-Object { $_.ProjectRoot -eq $ProjectRoot })) {
                            $modTool = $mod.CovTool
                            if (-not $modTool -or $modTool -eq "none") { continue }
                            $xmlCheck = Get-CoverageXmlPath -Tool $modTool -ModulePath $mod.Path -IsDesktop $Desktop
                            if ($xmlCheck) { $recoveredCov++ }
                        }
                        $recoveredCov = $recoveredCov - $covXmlCount
                    }
                    Write-Host "  [!] Batch recovery: $recoveredCov / $missingCov recovered" -ForegroundColor Yellow
                } else {
                    Write-Host "  [OK] Main project coverage reports generated ($covXmlCount modules)" -ForegroundColor Green
                }
            } else {
                # Configuration failure: no XMLs at all — retry full batch without config cache
                Write-Host "  [!] Batch coverage failed (exit $covExitCode), 0 reports - retrying full batch without config cache..." -ForegroundColor Yellow
                $covOk = 0
                $covFail = 0
                $retryArgs = @($covTasks) + @("--parallel", "--continue", "--no-configuration-cache")
                if ($MaxWorkers -gt 0) { $retryArgs += "--max-workers=$MaxWorkers" }
                Push-Location $ProjectRoot
                & ./gradlew @retryArgs 2>&1 | Out-Null
                $retryExit = $LASTEXITCODE
                Pop-Location
                if ($retryExit -eq 0) {
                    $covOk = $covTasks.Count
                } else {
                    # Count how many XMLs exist now
                    foreach ($mod in ($allModules | Where-Object { $_.ProjectRoot -eq $ProjectRoot })) {
                        $modTool = $mod.CovTool
                        if (-not $modTool -or $modTool -eq "none") { continue }
                        $xmlCheck = Get-CoverageXmlPath -Tool $modTool -ModulePath $mod.Path -IsDesktop $Desktop
                        if ($xmlCheck) { $covOk++ } else { $covFail++ }
                    }
                }
                if ($covOk -gt 0) {
                    Write-Host "  [OK] Batch retry: $covOk succeeded, $covFail failed" -ForegroundColor Green
                } else {
                    Write-Host "  [!] All $($covTasks.Count) coverage tasks failed" -ForegroundColor Yellow
                }
            }
        } else {
            Write-Host "  [OK] Main project coverage reports generated ($($covTasks.Count) modules)" -ForegroundColor Green
        }
    }

    # Run shared project coverage tasks from shared project directory
    if ($covTasksShared.Count -gt 0) {
        $sharedLibsPath = ($projectsToProcess | Where-Object { $_.Name -eq $SharedProjectName } | Select-Object -First 1).Path
        if ($sharedLibsPath -and (Test-Path $sharedLibsPath)) {
            $covArgsShared = @()
            $covArgsShared += $covTasksShared
            $covArgsShared += "--parallel"
            $covArgsShared += "--continue"
            if ($MaxWorkers -gt 0) { $covArgsShared += "--max-workers=$MaxWorkers" }

            Write-Host "  [>] Generating $SharedProjectName coverage ($($covTasksShared.Count) modules)..." -ForegroundColor Cyan
            Push-Location $sharedLibsPath
            $covOutputShared = & ./gradlew @covArgsShared 2>&1
            $covExitCodeShared = $LASTEXITCODE
            Pop-Location

            if ($covExitCodeShared -ne 0) {
                # Check if --continue saved us
                $covXmlCountS = 0
                foreach ($mod in ($allModules | Where-Object { $SharedProjectName -and $_.Name.StartsWith("${SharedProjectName}:") })) {
                    $modTool = $mod.CovTool
                    if (-not $modTool -or $modTool -eq "none") { continue }
                    $xmlCheck = Get-CoverageXmlPath -Tool $modTool -ModulePath $mod.Path -IsDesktop $Desktop
                    if ($xmlCheck) { $covXmlCountS++ }
                }

                if ($covXmlCountS -gt 0) {
                    Write-Host "  [!] Shared coverage had errors (exit $covExitCodeShared) but $covXmlCountS reports generated (--continue saved partial results)" -ForegroundColor Yellow
                } else {
                    # Configuration failure: no XMLs at all — retry full batch without config cache
                    Write-Host "  [!] Batch shared coverage failed (exit $covExitCodeShared), 0 reports - retrying batch without config cache..." -ForegroundColor Yellow
                    $covOkS = 0
                    $covFailS = 0
                    $retryArgsS = @($covTasksShared) + @("--parallel", "--continue", "--no-configuration-cache")
                    if ($MaxWorkers -gt 0) { $retryArgsS += "--max-workers=$MaxWorkers" }
                    Push-Location $sharedLibsPath
                    & ./gradlew @retryArgsS 2>&1 | Out-Null
                    $retryExitS = $LASTEXITCODE
                    Pop-Location
                    if ($retryExitS -eq 0) {
                        $covOkS = $covTasksShared.Count
                    } else {
                        foreach ($mod in ($allModules | Where-Object { $SharedProjectName -and $_.Name.StartsWith("${SharedProjectName}:") })) {
                            $modTool = $mod.CovTool
                            if (-not $modTool -or $modTool -eq "none") { continue }
                            $xmlCheck = Get-CoverageXmlPath -Tool $modTool -ModulePath $mod.Path -IsDesktop $Desktop
                            if ($xmlCheck) { $covOkS++ } else { $covFailS++ }
                        }
                    }
                    if ($covOkS -gt 0) {
                        Write-Host "  [OK] Batch retry: $covOkS succeeded, $covFailS failed" -ForegroundColor Green
                    } else {
                        Write-Host "  [!] All $($covTasksShared.Count) shared coverage tasks failed" -ForegroundColor Yellow
                    }
                }
            } else {
                Write-Host "  [OK] $SharedProjectName coverage reports generated ($($covTasksShared.Count) modules)" -ForegroundColor Green
            }
        } else {
            Write-Host "  [!] $SharedProjectName not found for coverage at: $sharedLibsPath" -ForegroundColor Yellow
        }
    }

    if ($covTasks.Count -eq 0 -and $covTasksShared.Count -eq 0) {
        Write-Host "  [!] No modules with coverage configured - skipping coverage generation" -ForegroundColor Yellow
    }
    Write-Host ""
} elseif ($SkipTests) {
    # Mark all testable modules as passed (skipped test execution)
    foreach ($module in $testableModules) {
        $testResults[$module.Name] = @{ Status = "passed"; Coverage = $null }
        $successCount++
    }
}

# ============================================================================
# PARSE COVERAGE REPORTS
# ============================================================================

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Parsing Coverage Reports" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$allClasses = [System.Collections.Generic.List[object]]::new()
$moduleSummaries = @{}

foreach ($module in $allModules) {
    # Resolve coverage tool for this module
    $modTool = if ($module.PSObject.Properties['CovTool']) { $module.CovTool } else { "" }
    if (-not $modTool -or $modTool -eq "none") {
        if ($CoverageTool -eq "auto") {
            $buildFile = Join-Path $module.Path "build.gradle.kts"
            $modTool = Detect-CoverageTool -BuildFilePath $buildFile
        } elseif ($CoverageTool -ne "none") {
            $modTool = $CoverageTool
        } else {
            Write-Host "  [!] No coverage data: $($module.Name)" -ForegroundColor DarkYellow
            continue
        }
    }
    if ($modTool -eq "none") {
        Write-Host "  [!] No coverage data: $($module.Name)" -ForegroundColor DarkYellow
        continue
    }

    $xmlPath = Get-CoverageXmlPath -Tool $modTool -ModulePath $module.Path -IsDesktop $Desktop

    if (-not $xmlPath) {
        Write-Host "  [!] No coverage data: $($module.Name)" -ForegroundColor DarkYellow
        continue
    }

    Write-Host "  [>] Parsing: $($module.Name)" -ForegroundColor Gray

    $classes = Parse-CoverageReport -XmlPath $xmlPath -ModuleName $module.Name

    if ($classes -and $classes.Count -gt 0) {
        $allClasses.AddRange([object[]]$classes)

        $totalCovered = ($classes | Measure-Object -Property Covered -Sum).Sum
        $totalMissed = ($classes | Measure-Object -Property Missed -Sum).Sum
        $totalLines = $totalCovered + $totalMissed
        $moduleCoverage = if ($totalLines -gt 0) { [math]::Round(($totalCovered / $totalLines) * 100, 1) } else { 0 }

        $moduleSummaries[$module.Name] = [PSCustomObject]@{
            Name = $module.Name
            Covered = $totalCovered
            Missed = $totalMissed
            Total = $totalLines
            CoveragePct = $moduleCoverage
        }

        if ($testResults.ContainsKey($module.Name)) {
            $testResults[$module.Name].Coverage = $moduleCoverage
        }
    }
}

# Filter by MinMissedLines
if ($MinMissedLines -gt 0) {
    $allClasses = $allClasses | Where-Object { $_.Missed -ge $MinMissedLines }
}

# Calculate grand totals
$grandCovered = ($moduleSummaries.Values | Measure-Object -Property Covered -Sum).Sum
$grandMissed = ($moduleSummaries.Values | Measure-Object -Property Missed -Sum).Sum
$grandTotal = $grandCovered + $grandMissed
$grandCoverage = if ($grandTotal -gt 0) { [math]::Round(($grandCovered / $grandTotal) * 100, 1) } else { 0 }

# ============================================================================
# GENERATE MARKDOWN REPORT
# ============================================================================

$projectsList = ($projectsToProcess | ForEach-Object { $_.Name }) -join ", "
$totalDuration = (Get-Date) - $startTime

$report = @"
# Full Coverage Report

> **Generated**: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
> **Projects**: $projectsList
> **Platform**: $platformName
> **Tests Run**: $(if ($SkipTests) { "No (--skip-tests)" } else { "Yes (parallel)" })
> **Coverage Tool**: $(Get-CoverageDisplayName -Tool $CoverageTool)
> **Duration**: $([int]$totalDuration.TotalMinutes)m $($totalDuration.Seconds)s
> **Mode**: Parallel (single Gradle invocation)

---

## Summary by Module

| Module | Coverage | Covered | Total | Missed |
|--------|----------|---------|-------|--------|
"@

foreach ($summary in ($moduleSummaries.Values | Sort-Object Name)) {
    $report += "`n| ``$($summary.Name)`` | $($summary.CoveragePct)% | $($summary.Covered) | $($summary.Total) | $($summary.Missed) |"
}

$report += "`n| **TOTAL** | **$grandCoverage%** | **$grandCovered** | **$grandTotal** | **$grandMissed** |"

$report += @"


---

## AI-Optimized Summary

``````
TOTAL_COVERAGE: $grandCoverage%
TOTAL_LINES: $grandTotal
COVERED_LINES: $grandCovered
MISSED_LINES: $grandMissed
MODULES_SCANNED: $($moduleSummaries.Count)
CLASSES_ANALYZED: $($allClasses.Count)
COVERAGE_TOOL: $CoverageTool
EXECUTION_MODE: parallel
DURATION: $([int]$totalDuration.TotalMinutes)m $($totalDuration.Seconds)s
``````

---

## Detailed Class Coverage

"@

$groupedClasses = $allClasses | Group-Object Module | Sort-Object Name

foreach ($group in $groupedClasses) {
    $report += "`n### $($group.Name)`n`n"
    $report += "| Class | Coverage | Missed | Lines |`n"
    $report += "|-------|----------|--------|-------|`n"

    foreach ($class in ($group.Group | Sort-Object -Property Missed -Descending)) {
        $lineRanges = Format-LineRanges -Lines $class.MissedLines
        if ($lineRanges.Length -gt 60) {
            $lineRanges = $lineRanges.Substring(0, 57) + "..."
        }
        $report += "| ``$($class.ClassName)`` | $($class.CoveragePct)% | $($class.Missed) | $lineRanges |`n"
    }
}

$report += @"

---

*Generated by run-parallel-coverage-suite.ps1 (parallel mode)*
"@

# Write report — versioned filename for concurrency safety, mirror to legacy alias.
if ($OutputFile -match '\.md$') {
    $outputVersioned = ($OutputFile -replace '\.md$', "-$KmpRunId.md")
} else {
    $outputVersioned = "$OutputFile-$KmpRunId"
}
$outputPath = Join-Path $ProjectRoot $outputVersioned
$outputLegacyPath = Join-Path $ProjectRoot $OutputFile
$report | Out-File -FilePath $outputPath -Encoding UTF8

# Mirror to legacy stable name (last writer wins under concurrent invocations).
Copy-Item -Path $outputPath -Destination $outputLegacyPath -Force -ErrorAction SilentlyContinue

# ============================================================================
# CONSOLE SUMMARY
# ============================================================================

Write-Host ""
Write-Host "[OK] Full coverage report generated!" -ForegroundColor Green
Write-Host "[>>] Report saved to: $outputPath" -ForegroundColor Cyan
Write-Host "    legacy alias: $outputLegacyPath" -ForegroundColor DarkGray
Write-Host ""

if (-not $SkipTests) {
    Write-Host "Tests: $($allModules.Count) total | $successCount passed | $failureCount failed | $skippedCount skipped" -ForegroundColor White
    Write-Host ""
}

# Module coverage table
Write-Host ""
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host "  MODULE COVERAGE SUMMARY" -ForegroundColor Cyan
Write-Host ("=" * 70) -ForegroundColor Cyan
Write-Host ""
Write-Host ("{0,-48} {1,10} {2,8}" -f "MODULE", "COVERAGE", "MISSED") -ForegroundColor White
Write-Host ("-" * 70) -ForegroundColor DarkGray

$mainModules = $moduleSummaries.Values | Where-Object { -not ($SharedProjectName -and $_.Name.StartsWith("${SharedProjectName}:")) } | Sort-Object Name
$sharedModules = $moduleSummaries.Values | Where-Object { $SharedProjectName -and $_.Name.StartsWith("${SharedProjectName}:") } | Sort-Object Name

foreach ($m in $mainModules) {
    $color = if ($m.CoveragePct -lt 50) { "Red" } elseif ($m.CoveragePct -lt 80) { "Yellow" } else { "Green" }
    $displayName = if ($m.Name.Length -gt 46) { $m.Name.Substring(0, 43) + "..." } else { $m.Name }
    $covStr = "$($m.CoveragePct)%"
    Write-Host ("{0,-48} {1,10} {2,8}" -f $displayName, $covStr, $m.Missed) -ForegroundColor $color
}

if ($sharedModules.Count -gt 0) {
    Write-Host ("-" * 70) -ForegroundColor DarkGray
    foreach ($m in $sharedModules) {
        $color = if ($m.CoveragePct -lt 50) { "Red" } elseif ($m.CoveragePct -lt 80) { "Yellow" } else { "Green" }
        $displayName = if ($m.Name.Length -gt 46) { $m.Name.Substring(0, 43) + "..." } else { $m.Name }
        $covStr = "$($m.CoveragePct)%"
        Write-Host ("{0,-48} {1,10} {2,8}" -f $displayName, $covStr, $m.Missed) -ForegroundColor $color
    }
}

Write-Host ("=" * 70) -ForegroundColor Cyan
$covColor = if ($grandCoverage -ge 80) { "Green" } elseif ($grandCoverage -ge 60) { "Yellow" } else { "Red" }
Write-Host ("{0,-48} {1,10} {2,8}" -f "TOTAL", "$grandCoverage%", $grandMissed) -ForegroundColor $covColor
Write-Host ""

# Coverage gaps
$classesWithGaps = $allClasses | Where-Object { $_.Missed -gt 0 } | Sort-Object Module, @{Expression={$_.Missed}; Descending=$true}
$modulesWithGaps = $classesWithGaps | Group-Object Module

if ($modulesWithGaps.Count -gt 0) {
    Write-Host ""
    Write-Host ("=" * 80) -ForegroundColor Yellow
    Write-Host "  COVERAGE GAPS - CLASSES TO FIX" -ForegroundColor Yellow
    Write-Host ("=" * 80) -ForegroundColor Yellow

    foreach ($moduleGroup in $modulesWithGaps) {
        $modName = $moduleGroup.Name
        $modSummary = $moduleSummaries[$modName]
        $isUiCode = $modName -match "designsystem|screen|feature:"

        Write-Host ""
        $headerSuffix = if ($isUiCode) { " [UI CODE]" } else { "" }
        Write-Host "$modName ($($modSummary.CoveragePct)% - $($modSummary.Missed) lines missed)$headerSuffix" -ForegroundColor Yellow
        Write-Host ("-" * 80) -ForegroundColor DarkGray

        foreach ($class in $moduleGroup.Group) {
            $className = $class.ClassName
            if ($className.Length -gt 42) {
                $className = $className.Substring(0, 39) + "..."
            }
            $covStr = "$($class.CoveragePct)%"
            $linesStr = Format-LineRanges -Lines $class.MissedLines
            if ($class.Missed -gt 10 -and $linesStr.Length -gt 30) {
                $linesStr = "$($class.Missed) lines - " + $linesStr.Substring(0, 20) + "..."
            } elseif ($linesStr.Length -gt 35) {
                $linesStr = $linesStr.Substring(0, 32) + "..."
            }
            $color = if ($class.CoveragePct -lt 50) { "Red" } elseif ($class.CoveragePct -lt 80) { "Yellow" } else { "White" }
            Write-Host ("  {0,-44} {1,6}  {2}" -f $className, $covStr, $linesStr) -ForegroundColor $color
        }
    }

    Write-Host ""
    Write-Host ("=" * 80) -ForegroundColor Cyan
}

# Final summary
$modulesAt100 = ($moduleSummaries.Values | Where-Object { $_.CoveragePct -eq 100 }).Count
$totalDurationFinal = (Get-Date) - $startTime
Write-Host "SUMMARY: $grandCoverage% total | $grandMissed lines missed | $modulesAt100 modules at 100% | $([int]$totalDurationFinal.TotalMinutes)m $($totalDurationFinal.Seconds)s" -ForegroundColor $covColor
Write-Host ("=" * 80) -ForegroundColor Cyan
Write-Host ""

# ============================================================================
# OPTIONAL BENCHMARK EXECUTION
# ============================================================================
if ($Benchmark) {
    Write-Host ""
    Write-Host "[>] Running benchmarks (config: $BenchmarkConfig)..." -ForegroundColor Cyan
    $benchParams = @{
        ProjectRoot = $ProjectRoot
        Config = $BenchmarkConfig
    }
    if ($IncludeShared) { $benchParams.IncludeShared = $true }
    & "$scriptDir\run-benchmarks.ps1" @benchParams
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[!] Benchmark execution had failures" -ForegroundColor Yellow
    }
}

# Exit code
if ($failureCount -gt 0) {
    Write-Host "BUILD FAILED - $failureCount module(s) failed" -ForegroundColor Red
    exit 1
} else {
    Write-Host "BUILD SUCCESSFUL" -ForegroundColor Green
    exit 0
}

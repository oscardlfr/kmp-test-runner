# kmp-test-runner - Android Instrumented Tests Runner
# Runs androidTest on connected device/emulator with logcat capture
#
# Usage:
#   ./run-android-tests.ps1                          # All modules with androidTest
#   ./run-android-tests.ps1 -ModuleFilter "core:*"   # Filter modules
#   ./run-android-tests.ps1 -Device emulator-5554    # Specific device
#   ./run-android-tests.ps1 -AutoRetry               # Retry failed modules
#
# Autonomy Features:
#   - JSON summary for machine parsing
#   - Error extraction for diagnosis
#   - Logcat capture filtered by package

param(
    [string]$ProjectRoot = "",
    [string]$Device = "",
    [string]$ModuleFilter = "",
    [switch]$SkipApp = $false,
    [switch]$Verbose = $false,
    [string]$Flavor = "",
    [switch]$AutoRetry = $false,
    [switch]$ClearData = $false,
    [Alias("List")][switch]$ListOnly = $false,
    [string]$TestFilter = "",
    [string]$DeviceTask = ""
)

$ErrorActionPreference = "Continue"

# Source the shared gradle-tasks-probe library (Bug B' / Bug B'' / v0.5.1).
$psScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $psScriptDir 'lib\Gradle-Tasks-Probe.ps1')

# Color scheme
$Colors = @{
    Header = "Cyan"
    Success = "Green"
    Failure = "Red"
    Warning = "Yellow"
    Info = "Gray"
    Module = "Magenta"
}

if (-not $ProjectRoot) {
    Write-Error "[ERROR] --project-root is required."
    exit 1
}

# Navigate to project root
Set-Location $ProjectRoot
$ProjectRoot = (Get-Location).Path

# Setup Environment
$env:ANDROID_HOME = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$adb = if (Test-Path "$env:ANDROID_HOME\platform-tools\adb.exe") {
    "$env:ANDROID_HOME\platform-tools\adb.exe"
} else {
    "adb"
}

# Detect package name from AndroidManifest.xml
function Get-PackageName {
    param([string]$Root)

    $manifests = Get-ChildItem -Path $Root -Recurse -Filter "AndroidManifest.xml" |
        Where-Object { $_.FullName -notmatch "build" -and $_.FullName -match "src[\\/]main" } |
        Select-Object -First 1

    if ($manifests) {
        $content = Get-Content $manifests.FullName -Raw
        if ($content -match 'package="([^"]+)"') {
            return $Matches[1]
        }
    }
    return $null
}

# Auto-discover modules with androidTest
function Get-AndroidTestModules {
    param([string]$Root)

    Get-ChildItem -Path $Root -Recurse -Directory -Filter "androidTest" |
        Where-Object { $_.Parent.Name -eq "src" -and $_.FullName -notmatch "build" } |
        ForEach-Object {
            $modulePath = $_.Parent.Parent.FullName
            $relativePath = $modulePath.Replace($Root, "").TrimStart("\", "/")
            $moduleName = $relativePath -replace "[\\/]", ":"

            # Detect if KMP project
            $isKmp = (Test-Path (Join-Path $modulePath "src/commonMain")) -or
                     (Test-Path (Join-Path $modulePath "src/desktopMain"))

            # Detect flavors
            $buildFile = Join-Path $modulePath "build.gradle.kts"
            $hasFlavor = $false
            if (Test-Path $buildFile) {
                $buildContent = Get-Content $buildFile -Raw
                $hasFlavor = $buildContent -match "productFlavors"
            }

            # Get module description from build file comments or module name
            $description = switch -Wildcard ($moduleName) {
                "*:database*" { "Database DAO Tests" }
                "*:data*" { "Data Layer Tests" }
                "*:domain*" { "Domain Logic Tests" }
                "*:auth*" { "Auth Feature Tests" }
                "*:settings*" { "Settings Feature Tests" }
                "*:storage*" { "Storage Tests" }
                "*:designsystem*" { "Design System Tests" }
                "app*" { "App E2E Tests" }
                "*App*" { "App E2E Tests" }
                default { "Android Tests" }
            }

            @{
                Name = $moduleName
                Path = $modulePath
                HasFlavor = $hasFlavor
                IsKmp = $isKmp
                Description = $description
            }
        } | Sort-Object { $_.Name }
}

# Discover modules first (needed for --list which doesn't require device)
$allModules = @(Get-AndroidTestModules -Root $ProjectRoot)

# Apply filters
$modules = @($allModules)

if ($SkipApp) {
    Write-Host "Skipping app modules (--SkipApp flag set)" -ForegroundColor $Colors.Warning
    $modules = $modules | Where-Object { $_.Name -notmatch "^app$|App$" }
}

if ($ModuleFilter) {
    $filterList = $ModuleFilter.Split(',') | ForEach-Object { $_.Trim() }
    Write-Host "Filtering modules: $($filterList -join ', ')" -ForegroundColor $Colors.Warning
    # WRAP IN @() so a single match doesn't collapse to a hashtable. Without
    # this wrap, `$modules.Count` returned the number of KEYS in the matched
    # module hashtable (5: Name, Path, HasFlavor, IsKmp, Description) instead
    # of the array length 1, propagating into summary.json as `totalModules: 5`.
    $modules = @($modules | Where-Object {
        $mod = $_
        $matched = $false
        foreach ($f in $filterList) {
            if ($mod.Name -like $f) { $matched = $true; break }
        }
        $matched
    })
}

if ($modules.Count -eq 0) {
    Write-Host "ERROR: No modules found with androidTest directory" -ForegroundColor $Colors.Failure
    if ($ModuleFilter) {
        Write-Host "Filter applied: $ModuleFilter" -ForegroundColor $Colors.Warning
    }
    Write-Host "Available modules:" -ForegroundColor $Colors.Info
    $allModules | ForEach-Object { Write-Host "  - $($_.Name)" }
    exit 1
}

# Handle --list early (no device needed)
if ($ListOnly) {
    Write-Host ""
    Write-Host "Android Test Modules ($($modules.Count)):" -ForegroundColor $Colors.Header
    $modules | ForEach-Object {
        $kmpTag = if ($_.IsKmp) { " [KMP]" } else { "" }
        $flavorTag = if ($_.HasFlavor) { " [Flavored]" } else { "" }
        Write-Host "  - $($_.Name)$kmpTag$flavorTag - $($_.Description)"
    }
    exit 0
}

# Device Detection (required for actual test execution)
if (-not $Device) {
    $devs = & $adb devices 2>&1 | Select-String -Pattern "\t(device|emulator)$"
    if ($devs.Count -gt 0) {
        $Device = $devs[0].ToString().Split("`t")[0].Trim()
        Write-Host "Auto-selected device: $Device" -ForegroundColor $Colors.Warning
    }
    else {
        Write-Host "ERROR: No active devices found via ADB." -ForegroundColor $Colors.Failure
        Write-Host "Please connect a device or start an emulator." -ForegroundColor $Colors.Warning
        exit 1
    }
}

# Verify device is connected
$deviceCheck = & $adb -s $Device get-state 2>&1
if ($deviceCheck -ne "device") {
    Write-Host "ERROR: Device '$Device' is not available (state: $deviceCheck)" -ForegroundColor $Colors.Failure
    exit 1
}

# Create logs directory
$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$logsDir = "androidtest-logs\$timestamp"
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null

# Get package name
$packageName = Get-PackageName -Root $ProjectRoot
if (-not $packageName) {
    Write-Host "WARNING: Could not detect package name for logcat filtering" -ForegroundColor $Colors.Warning
}

Write-Host ""
Write-Host "========================================" -ForegroundColor $Colors.Header
Write-Host "  Android Tests - All Modules Runner" -ForegroundColor $Colors.Header
Write-Host "========================================" -ForegroundColor $Colors.Header
Write-Host "Device: $Device" -ForegroundColor $Colors.Info
Write-Host "Logs: $logsDir" -ForegroundColor $Colors.Info
if ($packageName) {
    Write-Host "Package: $packageName" -ForegroundColor $Colors.Info
}
Write-Host ""

# Results tracking
$results = @()
$totalModules = $modules.Count
$currentModule = 0

# Clear logcat once at the start
Write-Host "Clearing logcat..." -ForegroundColor $Colors.Info
& $adb -s $Device logcat -c 2>&1 | Out-Null

foreach ($module in $modules) {
    $currentModule++
    $moduleName = $module.Name
    $hasFlavor = $module.HasFlavor
    $description = $module.Description

    Write-Host ""
    Write-Host "[$currentModule/$totalModules] " -NoNewline -ForegroundColor $Colors.Info
    Write-Host "$moduleName" -NoNewline -ForegroundColor $Colors.Module
    Write-Host " - $description" -ForegroundColor $Colors.Info
    Write-Host "".PadRight(80, "-") -ForegroundColor $Colors.Info

    # Construct Gradle task
    $formattedModule = ":$($moduleName.Replace(':', ':'))"
    $isKmpModule = $module.IsKmp

    # Bug B' (v0.5.1): probe gradle for the actual task set instead of
    # hardcoding by IsKmp/HasFlavor. The new KMP `androidLibrary { }` DSL
    # exposes `androidConnectedCheck` rather than `connectedDebugAndroidTest`
    # — old detection blew up with `Cannot locate tasks that match`.
    if ($DeviceTask) {
        $task = "$formattedModule`:$DeviceTask"
    }
    else {
        $candidates = @()
        if ($hasFlavor -and $Flavor) {
            $flavorCapitalized = $Flavor.Substring(0,1).ToUpper() + $Flavor.Substring(1)
            $candidates += "connected${flavorCapitalized}DebugAndroidTest"
        }
        $candidates += @('connectedDebugAndroidTest', 'connectedAndroidTest', 'androidConnectedCheck')

        $probeResult = Get-ModuleFirstExistingTask -ProjectRoot $ProjectRoot `
            -Module $moduleName -Candidates $candidates

        switch ($probeResult.Status) {
            'found' {
                $task = "$formattedModule`:$($probeResult.Task)"
            }
            'no_match' {
                # Probe healthy but module has none of the candidate tasks.
                # Best-effort: try the umbrella task — gradle will surface a
                # task_not_found error captured by the JSON envelope (Phase 1).
                $task = "$formattedModule`:androidConnectedCheck"
                Write-Host "[!] No standard android task found for $moduleName - trying $task (override with -DeviceTask)" -ForegroundColor $Colors.Warning
            }
            default {
                # Probe unavailable - fall back to legacy hardcoded matrix.
                if ($isKmpModule) {
                    if ($hasFlavor -and $Flavor) {
                        $flavorCapitalized = $Flavor.Substring(0,1).ToUpper() + $Flavor.Substring(1)
                        $task = "$formattedModule`:connected${flavorCapitalized}DebugAndroidTest"
                    } else {
                        $task = "$formattedModule`:connectedDebugAndroidTest"
                    }
                } elseif ($hasFlavor -and $Flavor) {
                    $flavorCapitalized = $Flavor.Substring(0,1).ToUpper() + $Flavor.Substring(1)
                    $task = "$formattedModule`:connected${flavorCapitalized}DebugAndroidTest"
                } elseif ($hasFlavor) {
                    $task = "$formattedModule`:connectedDebugAndroidTest"
                } else {
                    $task = "$formattedModule`:connectedAndroidTest"
                }
            }
        }
    }

    # Log files for this module
    $safeName = $moduleName.Replace(':', '_')
    $moduleLogFile = "$logsDir\$safeName.log"
    $moduleLogcatFile = "$logsDir\${safeName}_logcat.log"
    $moduleErrorsFile = "$logsDir\${safeName}_errors.json"

    # Per-module gradle args, optionally a test-filter passthrough
    $gradleFilterArgs = @()
    if ($TestFilter) {
        $gradleFilterArgs += "-Pandroid.testInstrumentationRunnerArguments.class=$TestFilter"
    }

    Write-Host "Running: .\gradlew.bat $task $($gradleFilterArgs -join ' ')" -ForegroundColor $Colors.Info

    # Run tests
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        if ($IsWindows -or $env:OS -match "Windows") {
            & ".\gradlew.bat" $task @gradleFilterArgs --console=plain 2>&1 | Tee-Object -FilePath $moduleLogFile
        } else {
            & "./gradlew" $task @gradleFilterArgs --console=plain 2>&1 | Tee-Object -FilePath $moduleLogFile
        }
        $exitCode = $LASTEXITCODE
    }
    catch {
        Write-Host "Execution error: $_" -ForegroundColor $Colors.Failure
        $exitCode = 1
    }
    $sw.Stop()
    $duration = $sw.Elapsed.ToString("mm\:ss")

    # Capture logcat for this module (filtered by package if possible)
    if ($packageName) {
        $pid = & $adb -s $Device shell pidof $packageName 2>&1
        if ($pid -and $pid -match "^\d+$") {
            & $adb -s $Device logcat -d --pid=$pid > $moduleLogcatFile 2>&1
        } else {
            # Fallback to tag filter
            & $adb -s $Device logcat -d -s "${packageName}:*" "AndroidRuntime:E" "System.err:W" > $moduleLogcatFile 2>&1
        }
    } else {
        & $adb -s $Device logcat -d > $moduleLogcatFile 2>&1
    }

    # Parse results from log
    $logContent = if (Test-Path $moduleLogFile) { Get-Content $moduleLogFile -Raw } else { "" }
    $testsPassed = 0
    $testsFailed = 0
    $testsSkipped = 0

    # Try to extract test counts from output
    if ($logContent -match "(\d+) tests? completed") {
        $testsPassed = [int]$Matches[1]
    }
    if ($logContent -match "(\d+) failed") {
        $testsFailed = [int]$Matches[1]
        $testsPassed = [Math]::Max(0, $testsPassed - $testsFailed)
    }
    if ($logContent -match "(\d+) skipped") {
        $testsSkipped = [int]$Matches[1]
    }

    # Determine success/failure
    $success = ($exitCode -eq 0)
    $status = if ($success) { "PASS" } else { "FAIL" }
    $statusColor = if ($success) { $Colors.Success } else { $Colors.Failure }

    # Extract errors for diagnosis
    if (-not $success) {
        $errors = @{
            compilationErrors = @()
            testFailures = @()
            crashes = @()
        }

        # Compilation errors
        $compErrors = $logContent | Select-String -Pattern "^e: " -AllMatches | Select-Object -First 10
        if ($compErrors) {
            $errors.compilationErrors = @($compErrors | ForEach-Object { $_.Line })
        }

        # Test assertion failures
        $assertions = $logContent | Select-String -Pattern "AssertionError|expected.*but was|junit.*Failure" -AllMatches | Select-Object -First 10
        if ($assertions) {
            $errors.testFailures = @($assertions | ForEach-Object { $_.Line })
        }

        # Crashes from logcat
        if (Test-Path $moduleLogcatFile) {
            $logcatContent = Get-Content $moduleLogcatFile -Raw
            $crashes = $logcatContent | Select-String -Pattern "FATAL EXCEPTION|AndroidRuntime.*E" -AllMatches | Select-Object -First 5
            if ($crashes) {
                $errors.crashes = @($crashes | ForEach-Object { $_.Line })
            }
        }

        # Write errors JSON
        $errors | ConvertTo-Json -Depth 2 | Set-Content $moduleErrorsFile
    }

    # Auto-retry logic
    $retried = $false
    if ($AutoRetry -and -not $success) {
        Write-Host "  [RETRY] Retrying after failure..." -ForegroundColor $Colors.Yellow

        # Clear app data if requested
        if ($ClearData -and $packageName) {
            & $adb -s $Device shell pm clear $packageName 2>&1 | Out-Null
        }

        # Clear logcat
        & $adb -s $Device logcat -c 2>&1 | Out-Null

        # Retry
        $retryLogFile = "$logsDir\${safeName}_retry.log"
        if ($IsWindows -or $env:OS -match "Windows") {
            & ".\gradlew.bat" $task @gradleFilterArgs --console=plain 2>&1 | Tee-Object -FilePath $retryLogFile
        } else {
            & "./gradlew" $task @gradleFilterArgs --console=plain 2>&1 | Tee-Object -FilePath $retryLogFile
        }
        $retryExitCode = $LASTEXITCODE

        if ($retryExitCode -eq 0) {
            Write-Host "  [RETRY] Succeeded on retry!" -ForegroundColor $Colors.Success
            $success = $true
            $status = "PASS"
            $exitCode = 0
            $retried = $true
        }
    }

    # Store result
    $results += @{
        Module = $moduleName
        Status = $status
        Duration = $duration
        TestsPassed = $testsPassed
        TestsFailed = $testsFailed
        TestsSkipped = $testsSkipped
        LogFile = $moduleLogFile
        LogcatFile = $moduleLogcatFile
        ErrorsFile = if (-not $success) { $moduleErrorsFile } else { $null }
        Success = $success
        Retried = $retried
    }

    # Display result
    Write-Host ""
    Write-Host "  Status: " -NoNewline
    Write-Host "$status" -NoNewline -ForegroundColor $statusColor
    Write-Host " ($duration)" -ForegroundColor $Colors.Info

    if ($testsPassed -gt 0 -or $testsFailed -gt 0) {
        Write-Host "  Tests: $testsPassed passed" -NoNewline -ForegroundColor $Colors.Success
        if ($testsFailed -gt 0) {
            Write-Host ", $testsFailed failed" -NoNewline -ForegroundColor $Colors.Failure
        }
        if ($testsSkipped -gt 0) {
            Write-Host ", $testsSkipped skipped" -NoNewline -ForegroundColor $Colors.Warning
        }
        Write-Host ""
    }

    # Show errors if failed
    if (-not $success) {
        Write-Host ""
        Write-Host "  [ERROR SUMMARY]" -ForegroundColor $Colors.Failure

        if (Test-Path $moduleErrorsFile) {
            $errData = Get-Content $moduleErrorsFile | ConvertFrom-Json

            if ($errData.compilationErrors -and $errData.compilationErrors.Count -gt 0) {
                Write-Host "  Compilation errors:" -ForegroundColor $Colors.Failure
                $errData.compilationErrors | Select-Object -First 3 | ForEach-Object {
                    $line = if ($_.Length -gt 100) { $_.Substring(0, 100) + "..." } else { $_ }
                    Write-Host "    $line" -ForegroundColor $Colors.Info
                }
            }

            if ($errData.testFailures -and $errData.testFailures.Count -gt 0) {
                Write-Host "  Test failures:" -ForegroundColor $Colors.Failure
                $errData.testFailures | Select-Object -First 3 | ForEach-Object {
                    $line = if ($_.Length -gt 100) { $_.Substring(0, 100) + "..." } else { $_ }
                    Write-Host "    $line" -ForegroundColor $Colors.Info
                }
            }

            if ($errData.crashes -and $errData.crashes.Count -gt 0) {
                Write-Host "  Crashes detected:" -ForegroundColor $Colors.Failure
                $errData.crashes | Select-Object -First 2 | ForEach-Object {
                    $line = if ($_.Length -gt 100) { $_.Substring(0, 100) + "..." } else { $_ }
                    Write-Host "    $line" -ForegroundColor $Colors.Info
                }
            }
        }

        Write-Host "  Full log: $moduleLogFile" -ForegroundColor $Colors.Warning
        Write-Host "  Logcat: $moduleLogcatFile" -ForegroundColor $Colors.Warning
    }

    # Verbose output
    if ($Verbose -and -not $success) {
        Write-Host ""
        Write-Host "  [LAST 30 LINES OF LOG]" -ForegroundColor $Colors.Warning
        Get-Content $moduleLogFile -Tail 30 | ForEach-Object {
            Write-Host "    $_" -ForegroundColor $Colors.Info
        }
    }

    # Clear logcat for next module
    & $adb -s $Device logcat -c 2>&1 | Out-Null
}

# Summary
Write-Host ""
Write-Host "========================================" -ForegroundColor $Colors.Header
Write-Host "  SUMMARY" -ForegroundColor $Colors.Header
Write-Host "========================================" -ForegroundColor $Colors.Header
Write-Host ""

# Same single-item-pipeline-collapse pitfall as the $modules filter above:
# without `@(...)`, a single matching result becomes a hashtable and `.Count`
# returns the number of result-hashtable keys (11: Module, Status, Duration,
# Success, TestsPassed, TestsFailed, TestsSkipped, LogFile, LogcatFile,
# ErrorsFile, Retried) rather than the array length 1. That misreporting
# propagated into summary.json as `passedModules: 11` for single-module runs.
$totalSuccess = @($results | Where-Object { $_.Success }).Count
$totalFailure = @($results | Where-Object { -not $_.Success }).Count

# Calculate totals safely
$totalTests = 0
$totalFailed = 0
foreach ($r in $results) {
    if ($r.TestsPassed) { $totalTests += $r.TestsPassed }
    if ($r.TestsFailed) { $totalFailed += $r.TestsFailed }
}

# Module results table
Write-Host "Module Results:" -ForegroundColor $Colors.Info
Write-Host ""
$results | ForEach-Object {
    $statusColor = if ($_.Success) { $Colors.Success } else { $Colors.Failure }
    $statusSymbol = if ($_.Success) { "[PASS]" } else { "[FAIL]" }
    $retriedTag = if ($_.Retried) { " (retried)" } else { "" }

    Write-Host "  $statusSymbol " -NoNewline -ForegroundColor $statusColor
    Write-Host "$($_.Module.PadRight(30))$retriedTag" -NoNewline
    Write-Host " ($($_.Duration)) " -NoNewline -ForegroundColor $Colors.Info

    if ($_.TestsPassed -gt 0 -or $_.TestsFailed -gt 0) {
        Write-Host " - $($_.TestsPassed) tests" -NoNewline -ForegroundColor $Colors.Success
        if ($_.TestsFailed -gt 0) {
            Write-Host ", $($_.TestsFailed) failed" -NoNewline -ForegroundColor $Colors.Failure
        }
    }
    Write-Host ""
}

Write-Host ""
Write-Host "Overall Results:" -ForegroundColor $Colors.Info
Write-Host "  Modules: $totalSuccess passed" -NoNewline -ForegroundColor $Colors.Success
if ($totalFailure -gt 0) {
    Write-Host ", $totalFailure failed" -NoNewline -ForegroundColor $Colors.Failure
}
Write-Host " (out of $totalModules)" -ForegroundColor $Colors.Info

if ($totalTests -gt 0) {
    Write-Host "  Tests: $totalTests passed" -NoNewline -ForegroundColor $Colors.Success
    if ($totalFailed -gt 0) {
        Write-Host ", $totalFailed failed" -NoNewline -ForegroundColor $Colors.Failure
    }
    Write-Host ""
}

Write-Host ""
Write-Host "Logs saved to: $logsDir" -ForegroundColor $Colors.Info

# Generate JSON summary for machine parsing
$summary = @{
    timestamp = $timestamp
    device = $Device
    packageName = $packageName
    totalModules = $totalModules
    passedModules = $totalSuccess
    failedModules = $totalFailure
    totalTests = $totalTests
    passedTests = $totalTests - $totalFailed
    failedTests = $totalFailed
    logsDir = $logsDir
    modules = @($results | ForEach-Object {
        @{
            name = $_.Module
            status = $_.Status
            duration = $_.Duration
            testsPassed = $_.TestsPassed
            testsFailed = $_.TestsFailed
            testsSkipped = $_.TestsSkipped
            logFile = $_.LogFile
            logcatFile = $_.LogcatFile
            errorsFile = $_.ErrorsFile
            retried = $_.Retried
        }
    })
}

$summaryFile = "$logsDir\summary.json"
$summary | ConvertTo-Json -Depth 3 | Set-Content $summaryFile

Write-Host ""
Write-Host "=== JSON SUMMARY ===" -ForegroundColor $Colors.Header
Get-Content $summaryFile -Raw

# Exit code
if ($totalFailure -gt 0) {
    Write-Host ""
    Write-Host "BUILD FAILED - $totalFailure module(s) failed" -ForegroundColor $Colors.Failure
    exit 1
}
else {
    Write-Host ""
    Write-Host "BUILD SUCCESSFUL - All modules passed!" -ForegroundColor $Colors.Success
    exit 0
}

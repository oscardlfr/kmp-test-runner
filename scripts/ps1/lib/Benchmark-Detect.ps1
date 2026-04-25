# =============================================================================
# Benchmark detection and task resolution library (PowerShell).
#
# Supports: kotlinx-benchmark (JVM/Native), androidx.benchmark (Android).
# Dot-source this file from any PowerShell script that needs benchmark support.
# =============================================================================

function Detect-JvmInfo {
    <#
    .SYNOPSIS
        Detects JVM version and available CPU cores.
    .OUTPUTS
        PSCustomObject with .Version (string) and .Cores (int).
    #>

    $version = "unknown"
    try {
        $javaOutput = & java -version 2>&1 | Out-String
        if ($javaOutput -match '"(\d+)[\.\-]') {
            $version = $Matches[1]
        }
    } catch {
        # java not on PATH
    }

    $cores = [Environment]::ProcessorCount

    return [PSCustomObject]@{
        Version = $version
        Cores   = $cores
    }
}

function Detect-AndroidDevices {
    <#
    .SYNOPSIS
        Lists connected Android devices/emulators via adb.
    .OUTPUTS
        Array of PSCustomObject with .Serial, .Type, .Model, .ApiLevel.
    #>

    $devices = @()

    $adbPath = Get-Command adb -ErrorAction SilentlyContinue
    if (-not $adbPath) { return $devices }

    try {
        $lines = & adb devices -l 2>&1 | Out-String -Stream
    } catch {
        return $devices
    }

    foreach ($line in $lines) {
        # Match lines like: emulator-5554  device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 ...
        if ($line -match '^(\S+)\s+device\b') {
            $serial = $Matches[1]

            # Determine type
            $type = if ($serial -match '^emulator-') { "emulator" } else { "physical" }

            # Extract model from the line
            $model = "unknown"
            if ($line -match 'model:(\S+)') {
                $model = $Matches[1]
            }

            # Query API level
            $apiLevel = "unknown"
            try {
                $apiLevel = (& adb -s $serial shell getprop ro.build.version.sdk 2>&1).Trim()
            } catch {
                # device may have disconnected
            }

            $devices += [PSCustomObject]@{
                Serial   = $serial
                Type     = $type
                Model    = $model
                ApiLevel = $apiLevel
            }
        }
    }

    return $devices
}

function Detect-BenchmarkModules {
    <#
    .SYNOPSIS
        Scans settings.gradle.kts for included modules that have benchmark plugin references.
    .PARAMETER ProjectRoot
        Root directory of the Gradle project.
    .PARAMETER ModuleFilter
        Glob filter for module names (default "*").
    .OUTPUTS
        Array of module name strings.
    #>
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [string]$ModuleFilter = "*"
    )

    $settingsFile = Join-Path $ProjectRoot "settings.gradle.kts"
    if (-not (Test-Path $settingsFile)) { return @() }

    $settingsContent = Get-Content $settingsFile -Raw -ErrorAction SilentlyContinue
    if (-not $settingsContent) { return @() }

    $modules = @()

    # Match include(":<module>") patterns
    $includeMatches = [regex]::Matches($settingsContent, 'include\s*\(\s*":([\w\-:]+)"\s*\)')
    foreach ($m in $includeMatches) {
        $moduleName = $m.Groups[1].Value

        if ($moduleName -notlike $ModuleFilter) { continue }

        # Resolve module directory: colons become path separators
        $modulePath = $moduleName -replace ':', [IO.Path]::DirectorySeparatorChar
        $buildFile = Join-Path $ProjectRoot $modulePath "build.gradle.kts"

        if (-not (Test-Path $buildFile)) { continue }

        $buildContent = Get-Content $buildFile -Raw -ErrorAction SilentlyContinue
        if (-not $buildContent) { continue }

        # Check for benchmark plugin references
        if ($buildContent -match 'kotlinx[\.\-]benchmark' -or
            $buildContent -match 'androidx\.benchmark' -or
            $buildContent -match 'id\s*\(\s*"[^"]*benchmark[^"]*"\s*\)') {
            $modules += $moduleName
        }
    }

    return $modules
}

function Get-BenchmarkGradleTask {
    <#
    .SYNOPSIS
        Returns the Gradle task name for running benchmarks on the given module/platform/config.
    .PARAMETER Module
        Gradle module name (without leading colon).
    .PARAMETER Platform
        Target platform: "jvm" or "android".
    .PARAMETER Config
        Benchmark configuration: "main", "smoke", or "stress".
    .OUTPUTS
        Gradle task string.
    #>
    param(
        [Parameter(Mandatory)][string]$Module,
        [Parameter(Mandatory)][string]$Platform,
        [string]$Config = "main"
    )

    $prefix = ":$Module"

    if ($Platform -eq "android") {
        return "${prefix}:connectedAndroidTest"
    }

    # JVM platform
    switch ($Config) {
        "smoke"  { return "${prefix}:desktopSmokeBenchmark" }
        "stress" { return "${prefix}:desktopStressBenchmark" }
        default  { return "${prefix}:desktopBenchmark" }
    }
}

function Detect-MacosTargets {
    <#
    .SYNOPSIS
        Detects macOS ARM/x64 targets for kotlinx-benchmark native. Currently a stub.
    .OUTPUTS
        Empty array.
    #>
    # TODO: detect macOS ARM/x64 targets for kotlinx-benchmark native
    return @()
}

function Detect-IosSimulators {
    <#
    .SYNOPSIS
        Detects iOS simulators available for benchmark execution. Currently a stub.
    .OUTPUTS
        Empty array.
    #>
    # TODO: detect iOS simulators via xcrun simctl list devices
    return @()
}

function Read-BenchmarkJson {
    <#
    .SYNOPSIS
        Parses a kotlinx-benchmark/JMH JSON results file.
    .PARAMETER JsonFile
        Path to the JSON benchmark results file.
    .OUTPUTS
        Array of PSCustomObject with .Name, .Mode, .Score, .Error, .Units.
    #>
    param(
        [Parameter(Mandatory)][string]$JsonFile
    )

    if (-not (Test-Path $JsonFile)) {
        Write-Warning "Benchmark results file not found: $JsonFile"
        return @()
    }

    $content = Get-Content $JsonFile -Raw -ErrorAction SilentlyContinue
    if (-not $content) { return @() }

    $json = $content | ConvertFrom-Json

    $results = @()
    foreach ($entry in $json) {
        $score = $null
        $error = $null
        $units = "unknown"

        if ($entry.PSObject.Properties['primaryMetric']) {
            $metric = $entry.primaryMetric
            $score = $metric.score
            $error = $metric.scoreError
            $units = $metric.scoreUnit
        }

        $results += [PSCustomObject]@{
            Name  = $entry.benchmark
            Mode  = $entry.mode
            Score = $score
            Error = $error
            Units = $units
        }
    }

    return $results
}

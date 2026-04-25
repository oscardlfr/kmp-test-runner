# =============================================================================
# Coverage tool detection and task/path resolution library (PowerShell).
#
# Supports: jacoco (default), kover, auto (per-module detection), none.
# Dot-source this file from any PowerShell script that needs coverage support.
# =============================================================================

function Detect-CoverageTool {
    <#
    .SYNOPSIS
        Inspects a module's build.gradle.kts to determine which coverage tool is configured.
    .OUTPUTS
        "kover" | "jacoco" | "none"
    #>
    param([string]$BuildFilePath)

    if (-not (Test-Path $BuildFilePath)) {
        return "none"
    }

    $content = Get-Content $BuildFilePath -Raw -ErrorAction SilentlyContinue
    if (-not $content) { return "none" }

    # Check for Kover plugin
    if ($content -match "kover") {
        return "kover"
    }

    # Check for JaCoCo plugin or AGP testCoverageEnabled
    if ($content -match "jacoco") {
        return "jacoco"
    }
    if ($content -match "testCoverageEnabled") {
        return "jacoco"
    }

    # Check if coverage report directories exist from previous runs
    $moduleDir = Split-Path $BuildFilePath -Parent
    if (Test-Path (Join-Path $moduleDir "build/reports/kover")) {
        return "kover"
    }
    if (Test-Path (Join-Path $moduleDir "build/reports/jacoco")) {
        return "jacoco"
    }

    # Check root/parent buildscripts for convention plugin applying kover
    $rootBuild = $null
    $parentBuild = Join-Path $moduleDir "../build.gradle.kts"
    $grandBuild = Join-Path $moduleDir "../../build.gradle.kts"
    if (Test-Path $parentBuild) { $rootBuild = $parentBuild }
    elseif (Test-Path $grandBuild) { $rootBuild = $grandBuild }

    if ($rootBuild) {
        $rootContent = Get-Content $rootBuild -Raw -ErrorAction SilentlyContinue
        if ($rootContent -match "kover") { return "kover" }
    }

    # Check build-logic convention plugins for kover
    $projectRoot = $null
    $parentSettings = Join-Path $moduleDir "../settings.gradle.kts"
    $grandSettings = Join-Path $moduleDir "../../settings.gradle.kts"
    if (Test-Path $parentSettings) { $projectRoot = (Resolve-Path (Join-Path $moduleDir "..")).Path }
    elseif (Test-Path $grandSettings) { $projectRoot = (Resolve-Path (Join-Path $moduleDir "../..")).Path }

    if ($projectRoot) {
        # Check build-logic/ directory
        $buildLogicDir = Join-Path $projectRoot "build-logic"
        if (Test-Path $buildLogicDir) {
            $koverFiles = Get-ChildItem -Path $buildLogicDir -Recurse -Include "*.gradle.kts","*.kt" -ErrorAction SilentlyContinue |
                Where-Object { (Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue) -match "kover" } |
                Select-Object -First 1
            if ($koverFiles) { return "kover" }
        }

        # Check version catalog for kover plugin declaration
        $versionCatalog = Join-Path $projectRoot "gradle/libs.versions.toml"
        if (Test-Path $versionCatalog) {
            $catalogContent = Get-Content $versionCatalog -Raw -ErrorAction SilentlyContinue
            if ($catalogContent -match "kover") { return "kover" }
        }
    }

    return "jacoco"
}

function Get-CoverageGradleTask {
    <#
    .SYNOPSIS
        Returns the Gradle task name for generating coverage, or "" if not applicable.
    .PARAMETER Tool
        Coverage tool: "kover", "jacoco", "none"
    .PARAMETER TestType
        Test type: "common", "desktop", "androidUnit", "androidInstrumented", "all"
    .PARAMETER IsDesktop
        Whether this is a desktop/KMP build
    #>
    param(
        [string]$Tool,
        [string]$TestType,
        [bool]$IsDesktop
    )

    switch ($Tool) {
        "kover" {
            switch ($TestType) {
                "common"              { return "koverXmlReportDesktop" }
                "desktop"             { return "koverXmlReportDesktop" }
                "all"                 { return "koverXmlReportDesktop" }
                "androidUnit"         { return "koverXmlReportDebug" }
                "androidInstrumented" { return "koverXmlReportDebug" }
                default {
                    if ($IsDesktop) { return "koverXmlReportDesktop" }
                    else { return "koverXmlReportDebug" }
                }
            }
        }
        "jacoco" {
            return "jacocoTestReport"
        }
        default {
            return ""
        }
    }
}

function Get-CoverageXmlPath {
    <#
    .SYNOPSIS
        Returns the absolute path to the coverage XML report, or $null if not found.
    #>
    param(
        [string]$Tool,
        [string]$ModulePath,
        [bool]$IsDesktop
    )

    switch ($Tool) {
        "kover" {
            $koverDir = Join-Path $ModulePath "build/reports/kover"
            if (-not (Test-Path $koverDir)) { return $null }

            $candidates = @()
            if ($IsDesktop) {
                $candidates += "reportDesktop.xml"
            } else {
                $candidates += "reportDebug.xml"
            }
            $candidates += "report.xml"

            foreach ($name in $candidates) {
                $path = Join-Path $koverDir $name
                if (Test-Path $path) { return $path }
            }

            # Fallback: any XML in kover dir
            $xmlFiles = Get-ChildItem -Path $koverDir -Filter "*.xml" -ErrorAction SilentlyContinue
            if ($xmlFiles) { return $xmlFiles[0].FullName }
            return $null
        }
        "jacoco" {
            $jacocoDir = Join-Path $ModulePath "build/reports/jacoco"
            if (-not (Test-Path $jacocoDir)) { return $null }

            # Search order: common locations first
            $candidates = @(
                (Join-Path $jacocoDir "jacocoTestReport.xml"),
                (Join-Path $jacocoDir "test/jacocoTestReport.xml"),
                (Join-Path $jacocoDir "testDebugUnitTest/jacocoTestReport.xml"),
                (Join-Path $jacocoDir "jacocoTestReport/jacocoTestReport.xml")
            )

            foreach ($path in $candidates) {
                if (Test-Path $path) { return $path }
            }

            # Fallback: any XML in jacoco dir (recursive)
            $xmlFiles = Get-ChildItem -Path $jacocoDir -Filter "*.xml" -Recurse -ErrorAction SilentlyContinue
            if ($xmlFiles) { return $xmlFiles[0].FullName }
            return $null
        }
        default {
            return $null
        }
    }
}


function Get-KoverTaskFallbacks {
    <#
    .SYNOPSIS
        Returns an ordered list of kover task names to try as fallbacks.
    .PARAMETER IsDesktop
        Whether this is a desktop/KMP build.
    .OUTPUTS
        Array of task name strings.
    #>
    param([bool]$IsDesktop)

    if ($IsDesktop) {
        return @("koverXmlReportDesktop", "koverXmlReport", "koverXmlReportDebug")
    } else {
        return @("koverXmlReportDebug", "koverXmlReport", "koverXmlReportDesktop")
    }
}

function Get-CoverageReportDir {
    <#
    .SYNOPSIS
        Returns the relative report directory path.
    #>
    param([string]$Tool)

    switch ($Tool) {
        "kover"  { return "build/reports/kover" }
        "jacoco" { return "build/reports/jacoco" }
        default  { return "" }
    }
}

function Get-CoverageDisplayName {
    <#
    .SYNOPSIS
        Returns a human-readable name for display.
    #>
    param([string]$Tool)

    switch ($Tool) {
        "kover"  { return "Kover" }
        "jacoco" { return "JaCoCo" }
        default  { return "(none)" }
    }
}

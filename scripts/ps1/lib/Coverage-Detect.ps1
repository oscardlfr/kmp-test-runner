# =============================================================================
# Coverage tool detection and task/path resolution library (PowerShell).
#
# Supports: jacoco (default), kover, auto (per-module detection), none.
# Dot-source this file from any PowerShell script that needs coverage support.
# =============================================================================

# v0.8 sub-entry 4: Detect-CoverageTool + Get-CoverageGradleTask removed.
# Their logic was a duplicate of lib/project-model.js#analyzeModule's
# coveragePlugin field + resolveTasksFor's coverageTask. The Node side
# (lib/project-model.js + lib/coverage-orchestrator.js + scripts/ps1/lib/
# Project-Model.ps1's Get-PmCoverageTask) is now the single source of truth.
# Carry-over from v0.5.2 Gap A (PR #67).

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

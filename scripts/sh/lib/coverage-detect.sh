#!/usr/bin/env bash
# =============================================================================
# Coverage tool detection and task/path resolution library.
#
# Supports: jacoco (default), kover, auto (per-module detection), none.
# Source this file from any bash script that needs coverage support.
# =============================================================================

# v0.8 sub-entry 4: detect_coverage_tool + get_coverage_gradle_task removed.
# Their logic was a duplicate of lib/project-model.js#analyzeModule's
# coveragePlugin field + resolveTasksFor's coverageTask. The Node side
# (lib/project-model.js + lib/coverage-orchestrator.js + scripts/sh/lib/
# project-model.sh's pm_get_coverage_task) is now the single source of truth.
# Carry-over from v0.5.2 Gap A (PR #67).

# get_kover_task_fallbacks <is_desktop>
#   Returns an ordered list of kover task names to try.
#   Use when the primary task doesn't exist on a module.
get_kover_task_fallbacks() {
    local is_desktop="$1"
    if [[ "$is_desktop" == "true" ]]; then
        echo "koverXmlReportDesktop koverXmlReport koverXmlReportDebug"
    else
        echo "koverXmlReportDebug koverXmlReport koverXmlReportDesktop"
    fi
}

# get_coverage_xml_path <tool> <module_path> <is_desktop>
#   Returns the absolute path to the coverage XML report, or "" if not found.
get_coverage_xml_path() {
    local tool="$1"
    local module_path="$2"
    local is_desktop="$3"

    case "$tool" in
        kover)
            local kover_dir="$module_path/build/reports/kover"
            if [[ ! -d "$kover_dir" ]]; then return 1; fi

            local candidates=()
            if [[ "$is_desktop" == "true" ]]; then
                candidates+=("reportDesktop.xml")
            else
                candidates+=("reportDebug.xml")
            fi
            candidates+=("report.xml")

            for name in "${candidates[@]}"; do
                local path="$kover_dir/$name"
                if [[ -f "$path" ]]; then echo "$path"; return 0; fi
            done

            # Fallback: any XML in kover dir
            local first_xml
            first_xml="$(find "$kover_dir" -maxdepth 1 -name "*.xml" 2>/dev/null | head -1)"
            if [[ -n "$first_xml" ]]; then echo "$first_xml"; return 0; fi
            return 1
            ;;
        jacoco)
            local jacoco_dir="$module_path/build/reports/jacoco"
            if [[ ! -d "$jacoco_dir" ]]; then return 1; fi

            # Search order: common locations first, then recursive
            local jacoco_candidates=(
                "$jacoco_dir/jacocoTestReport.xml"
                "$jacoco_dir/test/jacocoTestReport.xml"
                "$jacoco_dir/testDebugUnitTest/jacocoTestReport.xml"
                "$jacoco_dir/jacocoTestReport/jacocoTestReport.xml"
            )
            for path in "${jacoco_candidates[@]}"; do
                if [[ -f "$path" ]]; then echo "$path"; return 0; fi
            done

            # Fallback: any XML in jacoco dir (recursive)
            local first_xml
            first_xml="$(find "$jacoco_dir" -name "*.xml" 2>/dev/null | head -1)"
            if [[ -n "$first_xml" ]]; then echo "$first_xml"; return 0; fi
            return 1
            ;;
        none|"")
            return 1
            ;;
    esac
}

# get_coverage_report_dir <tool>
#   Returns the relative report directory path.
get_coverage_report_dir() {
    local tool="$1"
    case "$tool" in
        kover)  echo "build/reports/kover" ;;
        jacoco) echo "build/reports/jacoco" ;;
        *)      echo "" ;;
    esac
}

# get_coverage_display_name <tool>
#   Returns a human-readable name for display.
get_coverage_display_name() {
    local tool="$1"
    case "$tool" in
        kover)  echo "Kover" ;;
        jacoco) echo "JaCoCo" ;;
        *)      echo "(none)" ;;
    esac
}

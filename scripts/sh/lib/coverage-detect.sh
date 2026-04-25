#!/usr/bin/env bash
# =============================================================================
# Coverage tool detection and task/path resolution library.
#
# Supports: jacoco (default), kover, auto (per-module detection), none.
# Source this file from any bash script that needs coverage support.
# =============================================================================

# detect_coverage_tool <build_file_path>
#   Inspects a module's build.gradle.kts to determine which coverage tool is configured.
#   Returns: "kover" | "jacoco" | "none"
detect_coverage_tool() {
    local build_file="$1"
    if [[ ! -f "$build_file" ]]; then
        echo "none"
        return
    fi

    # Read file once, match in memory (avoids 3 separate grep subprocess spawns)
    local content
    content="$(<"$build_file")"

    if [[ "$content" == *kover* ]]; then echo "kover"; return; fi
    if [[ "$content" == *jacoco* ]]; then echo "jacoco"; return; fi
    if [[ "$content" == *testCoverageEnabled* ]]; then echo "jacoco"; return; fi

    # Check if coverage report directories exist from previous runs
    local module_dir
    module_dir="$(dirname "$build_file")"
    if [[ -d "$module_dir/build/reports/kover" ]]; then
        echo "kover"
        return
    fi
    if [[ -d "$module_dir/build/reports/jacoco" ]]; then
        echo "jacoco"
        return
    fi

    # Check root/parent buildscripts for convention plugin applying kover
    local root_build=""
    if [[ -f "$module_dir/../build.gradle.kts" ]]; then
        root_build="$module_dir/../build.gradle.kts"
    elif [[ -f "$module_dir/../../build.gradle.kts" ]]; then
        root_build="$module_dir/../../build.gradle.kts"
    fi
    if [[ -n "$root_build" ]]; then
        local root_content
        root_content="$(<"$root_build")"
        if [[ "$root_content" == *kover* ]]; then echo "kover"; return; fi
    fi

    # Check build-logic convention plugins for kover
    local project_root=""
    if [[ -f "$module_dir/../settings.gradle.kts" ]]; then
        project_root="$module_dir/.."
    elif [[ -f "$module_dir/../../settings.gradle.kts" ]]; then
        project_root="$module_dir/../.."
    fi
    if [[ -n "$project_root" ]]; then
        # Check build-logic/ directory for convention plugins applying kover
        local build_logic_dir="$project_root/build-logic"
        if [[ -d "$build_logic_dir" ]]; then
            local kover_in_logic
            kover_in_logic=$(grep -rl "kover" "$build_logic_dir" --include="*.gradle.kts" --include="*.kt" 2>/dev/null | head -1)
            if [[ -n "$kover_in_logic" ]]; then echo "kover"; return; fi
        fi

        # Check version catalog for kover plugin declaration
        local version_catalog="$project_root/gradle/libs.versions.toml"
        if [[ -f "$version_catalog" ]]; then
            local catalog_content
            catalog_content="$(<"$version_catalog")"
            if [[ "$catalog_content" == *kover* ]]; then echo "kover"; return; fi
        fi
    fi

    # Default: JaCoCo (built into AGP, no explicit config needed)
    echo "jacoco"
}

# get_coverage_gradle_task <tool> <test_type> <is_desktop>
#   Returns the Gradle task name for generating coverage, or "" if not applicable.
#   test_type: common|desktop|androidUnit|androidInstrumented|all
#   is_desktop: "true"|"false"
get_coverage_gradle_task() {
    local tool="$1"
    local test_type="$2"
    local is_desktop="$3"

    case "$tool" in
        kover)
            # Kover task names vary by project configuration:
            # - KMP projects: koverXmlReportDesktop, koverXmlReportDebug
            # - Android-only: koverXmlReportDebug, koverXmlReportRelease
            # - Root merged: koverXmlReport
            # The caller should verify the task exists before running.
            case "$test_type" in
                common|desktop|all)
                    echo "koverXmlReportDesktop" ;;
                androidUnit|androidInstrumented)
                    echo "koverXmlReportDebug" ;;
                *)
                    if [[ "$is_desktop" == "true" ]]; then
                        echo "koverXmlReportDesktop"
                    else
                        echo "koverXmlReportDebug"
                    fi
                    ;;
            esac
            ;;
        jacoco)
            case "$test_type" in
                common|desktop)
                    # JaCoCo doesn't natively support KMP desktop, but some setups have it
                    echo "jacocoTestReport" ;;
                androidUnit|androidInstrumented|all)
                    echo "jacocoTestReport" ;;
                *)
                    echo "jacocoTestReport" ;;
            esac
            ;;
        none|"")
            echo ""
            ;;
    esac
}

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

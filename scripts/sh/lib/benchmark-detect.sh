#!/usr/bin/env bash
# =============================================================================
# Benchmark detection and task resolution library.
#
# Supports: kotlinx-benchmark (JVM/Native), androidx.benchmark (Android).
# Source this file from any bash script that needs benchmark support.
# =============================================================================

# detect_jvm_info
#   Detects Java version and available CPU cores.
#   Output format: "version|cores" (e.g., "21|12").
#   Returns empty string if java is not found.
detect_jvm_info() {
    local java_version=""
    local cpu_cores=""

    # Java version is printed to stderr
    if command -v java &>/dev/null; then
        java_version=$(java -version 2>&1 | head -1 | sed -E 's/.*"([0-9]+)(\.[0-9]+)*.*/\1/')
    else
        return
    fi

    # CPU cores: nproc on Linux, sysctl on macOS
    if command -v nproc &>/dev/null; then
        cpu_cores=$(nproc)
    elif command -v sysctl &>/dev/null; then
        cpu_cores=$(sysctl -n hw.ncpu 2>/dev/null)
    else
        cpu_cores=1
    fi

    echo "${java_version}|${cpu_cores}"
}

# detect_android_devices
#   Parses `adb devices -l` output and returns device info.
#   Output: one line per device — "serial|type|model|api_level"
#   where type is "emulator" or "physical".
#   Outputs nothing if adb is not found or no devices are connected.
detect_android_devices() {
    if ! command -v adb &>/dev/null; then
        return
    fi

    local adb_output
    adb_output=$(adb devices -l 2>/dev/null)
    if [[ -z "$adb_output" ]]; then
        return
    fi

    # Skip the header line ("List of devices attached") and blank lines
    while IFS= read -r line; do
        # Skip header and empty lines
        [[ "$line" == "List of devices"* ]] && continue
        [[ -z "${line// /}" ]] && continue

        local serial
        serial=$(echo "$line" | awk '{print $1}')
        [[ -z "$serial" ]] && continue

        # Determine type: emulators typically have "emulator-" prefix
        local device_type="physical"
        if [[ "$serial" == emulator-* ]]; then
            device_type="emulator"
        fi

        # Extract model from the device line (model:XXX)
        local model="unknown"
        if [[ "$line" =~ model:([^ ]+) ]]; then
            model="${BASH_REMATCH[1]}"
        fi

        # Query API level via adb shell
        local api_level="unknown"
        api_level=$(adb -s "$serial" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')

        echo "${serial}|${device_type}|${model}|${api_level}"
    done <<< "$adb_output"
}

# detect_benchmark_modules <project_root> [module_filter]
#   Scans settings.gradle.kts for included modules, then checks each module's
#   build.gradle.kts for benchmark plugin/dependency references.
#   Output: one module name per line (without leading colon).
detect_benchmark_modules() {
    local project_root="$1"
    local module_filter="${2:-}"
    local settings_file="$project_root/settings.gradle.kts"

    if [[ ! -f "$settings_file" ]]; then
        return
    fi

    # Extract module include paths from settings.gradle.kts
    # Matches: include(":module-name") or include(":parent:child")
    local modules
    modules=$(grep -oP 'include\s*\(\s*":([\w:.-]+)"' "$settings_file" | \
              sed -E 's/include\s*\(\s*"://; s/"//')

    while IFS= read -r module; do
        [[ -z "$module" ]] && continue

        # Apply filter if provided
        if [[ -n "$module_filter" ]] && [[ "$module" != *"$module_filter"* ]]; then
            continue
        fi

        # Convert colon-separated module path to directory path
        local module_dir="$project_root/${module//://}"
        local build_file="$module_dir/build.gradle.kts"

        if [[ ! -f "$build_file" ]]; then
            continue
        fi

        # Read file once, check for benchmark references
        local content
        content="$(<"$build_file")"

        if [[ "$content" == *"kotlinx.benchmark"* ]] || \
           [[ "$content" == *"androidx.benchmark"* ]] || \
           [[ "$content" == *"benchmark"*"plugin"* ]] || \
           [[ "$content" == *"allopen"*"benchmark"* ]]; then
            echo "$module"
        fi
    done <<< "$modules"
}

# get_benchmark_gradle_task <module> <platform> <config>
#   Maps module, platform, and config to the appropriate Gradle task name.
#   platform: "jvm" | "android"
#   config: "main" | "smoke" | "stress"
#   Returns the fully qualified Gradle task path.
get_benchmark_gradle_task() {
    local module="$1"
    local platform="$2"
    local config="${3:-main}"

    case "$platform" in
        jvm)
            case "$config" in
                smoke)
                    echo ":${module}:desktopSmokeBenchmark" ;;
                stress)
                    echo ":${module}:desktopStressBenchmark" ;;
                *)
                    echo ":${module}:desktopBenchmark" ;;
            esac
            ;;
        android)
            echo ":${module}:connectedAndroidTest"
            ;;
        *)
            echo ":${module}:desktopBenchmark"
            ;;
    esac
}

# detect_macos_targets
#   Detects macOS ARM/x64 targets for kotlinx-benchmark native runs.
# TODO: detect macOS ARM/x64 targets for kotlinx-benchmark native
detect_macos_targets() {
    :
}

# detect_ios_simulators
#   Detects available iOS simulators for benchmark runs.
# TODO: detect iOS simulators via xcrun simctl list devices
detect_ios_simulators() {
    :
}

# parse_benchmark_json <json_file>
#   Parses a kotlinx-benchmark / JMH JSON results file.
#   Output: one line per benchmark — "benchmark_name|mode|score|error|units"
#   Uses jq if available, falls back to grep/awk.
parse_benchmark_json() {
    local json_file="$1"

    if [[ ! -f "$json_file" ]]; then
        return 1
    fi

    if command -v jq &>/dev/null; then
        # jq approach: reliable JSON parsing
        jq -r '.[] | "\(.benchmark)|\(.mode)|\(.primaryMetric.score)|\(.primaryMetric.scoreError)|\(.primaryMetric.scoreUnit)"' \
            "$json_file" 2>/dev/null
    else
        # Fallback: line-by-line extraction with awk
        # This handles the standard JMH/kotlinx-benchmark JSON array format
        local benchmark="" mode="" score="" error="" units=""

        while IFS= read -r line; do
            if [[ "$line" =~ \"benchmark\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
                benchmark="${BASH_REMATCH[1]}"
            fi
            if [[ "$line" =~ \"mode\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
                mode="${BASH_REMATCH[1]}"
            fi
            if [[ "$line" =~ \"score\"[[:space:]]*:[[:space:]]*([0-9.eE+-]+) ]]; then
                score="${BASH_REMATCH[1]}"
            fi
            if [[ "$line" =~ \"scoreError\"[[:space:]]*:[[:space:]]*([0-9.eE+-]+) ]]; then
                error="${BASH_REMATCH[1]}"
            fi
            if [[ "$line" =~ \"scoreUnit\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
                units="${BASH_REMATCH[1]}"
            fi

            # Emit when we hit a closing brace (end of one benchmark object)
            # and we have all fields populated
            if [[ "$line" =~ ^[[:space:]]*\} ]] && [[ -n "$benchmark" ]]; then
                echo "${benchmark}|${mode}|${score}|${error}|${units}"
                benchmark="" mode="" score="" error="" units=""
            fi
        done < "$json_file"
    fi
}

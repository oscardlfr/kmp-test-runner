#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/audit-append.sh"

# =============================================================================
# Android Instrumented Tests Runner
# Runs androidTest on connected device/emulator with logcat capture.
#
# Usage:
#   ./run-android-tests.sh                                    # All modules with androidTest
#   ./run-android-tests.sh --module-filter "core:*"           # Filter modules
#   ./run-android-tests.sh --device emulator-5554             # Specific device
#   ./run-android-tests.sh --auto-retry                       # Retry failed modules
#   ./run-android-tests.sh --list                             # List test modules only
#
# Options:
#   --project-root <path>   Project root (default: current directory)
#   --device <serial>       ADB device serial
#   --module-filter <glob>  Comma-separated glob patterns for module names
#   --skip-app              Skip app/androidApp modules
#   --verbose               Show last 30 lines of log on failure
#   --flavor <name>         Android build flavor
#   --auto-retry            Retry failed modules once
#   --clear-data            Clear app data before retry
#   --list | --list-only    List discovered modules and exit
# =============================================================================

# Defaults
PROJECT_ROOT="."
DEVICE=""
MODULE_FILTER=""
SKIP_APP=false
VERBOSE=false
FLAVOR=""
AUTO_RETRY=false
CLEAR_DATA=false
LIST_ONLY=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --project-root)
            PROJECT_ROOT="$2"; shift 2 ;;
        --device)
            DEVICE="$2"; shift 2 ;;
        --module-filter)
            MODULE_FILTER="$2"; shift 2 ;;
        --skip-app)
            SKIP_APP=true; shift ;;
        --verbose)
            VERBOSE=true; shift ;;
        --flavor)
            FLAVOR="$2"; shift 2 ;;
        --auto-retry)
            AUTO_RETRY=true; shift ;;
        --clear-data)
            CLEAR_DATA=true; shift ;;
        --list|--list-only)
            LIST_ONLY=true; shift ;;
        *)
            shift ;;
    esac
done

# Color codes
color_cyan="\033[36m"
color_green="\033[32m"
color_red="\033[31m"
color_yellow="\033[33m"
color_gray="\033[90m"
color_magenta="\033[35m"
color_reset="\033[0m"

# Navigate to project root
if [[ "$PROJECT_ROOT" != "." ]]; then
    cd "$PROJECT_ROOT"
fi
PROJECT_ROOT="$(pwd)"

# Setup ADB
ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [[ -f "$ANDROID_HOME/platform-tools/adb" ]]; then
    ADB="$ANDROID_HOME/platform-tools/adb"
elif command -v adb >/dev/null 2>&1; then
    ADB="adb"
else
    echo -e "${color_red}ERROR: ADB not found. Set ANDROID_HOME or ANDROID_SDK_ROOT.${color_reset}"
    exit 1
fi

# Detect package name from AndroidManifest.xml
get_package_name() {
    local root="$1"
    local manifest
    manifest=$(find "$root" -path "*/src/main/AndroidManifest.xml" -not -path "*/build/*" 2>/dev/null | head -1)
    if [[ -n "$manifest" ]]; then
        grep -oP 'package="\K[^"]+' "$manifest" 2>/dev/null || true
    fi
}

# Auto-discover modules with androidTest
# Output: name|path|has_flavor|is_kmp|description (one per line)
discover_android_test_modules() {
    local root="$1"

    find "$root" -type d -name "androidTest" -not -path "*/build/*" 2>/dev/null | while read -r at_dir; do
        # Verify parent is "src"
        local parent_name
        parent_name=$(basename "$(dirname "$at_dir")")
        if [[ "$parent_name" != "src" ]]; then
            continue
        fi

        local module_path
        module_path=$(dirname "$(dirname "$at_dir")")
        local relative_path="${module_path#"$root"/}"
        local module_name="${relative_path//\//:}"

        # Detect if KMP
        local is_kmp="false"
        if [[ -d "$module_path/src/commonMain" || -d "$module_path/src/desktopMain" ]]; then
            is_kmp="true"
        fi

        # Detect flavors
        local has_flavor="false"
        local build_file="$module_path/build.gradle.kts"
        if [[ -f "$build_file" ]] && grep -q "productFlavors" "$build_file" 2>/dev/null; then
            has_flavor="true"
        fi

        # Description based on module name
        local description="Android Tests"
        case "$module_name" in
            *:database*) description="Database DAO Tests" ;;
            *:data*)     description="Data Layer Tests" ;;
            *:domain*)   description="Domain Logic Tests" ;;
            *:auth*)     description="Auth Feature Tests" ;;
            *:settings*) description="Settings Feature Tests" ;;
            *:storage*)  description="Storage Tests" ;;
            *:designsystem*) description="Design System Tests" ;;
            app*|*App*)  description="App E2E Tests" ;;
        esac

        echo "${module_name}|${module_path}|${has_flavor}|${is_kmp}|${description}"
    done | sort
}

# Discover all modules
ALL_MODULES_RAW=$(discover_android_test_modules "$PROJECT_ROOT")
if [[ -z "$ALL_MODULES_RAW" ]]; then
    echo -e "${color_red}ERROR: No modules found with androidTest directory${color_reset}"
    exit 1
fi

# Apply filters
MODULES_RAW="$ALL_MODULES_RAW"

if [[ "$SKIP_APP" == "true" ]]; then
    echo -e "${color_yellow}Skipping app modules (--skip-app flag set)${color_reset}"
    MODULES_RAW=$(echo "$MODULES_RAW" | grep -v -E '(^app\||App\|)' || true)
fi

if [[ -n "$MODULE_FILTER" ]]; then
    IFS=',' read -ra filters <<< "$MODULE_FILTER"
    echo -e "${color_yellow}Filtering modules: ${MODULE_FILTER}${color_reset}"
    filtered=""
    while IFS='|' read -r name rest; do
        for f in "${filters[@]}"; do
            f_trimmed=$(echo "$f" | xargs)
            # Use bash glob matching
            # shellcheck disable=SC2254
            case "$name" in
                $f_trimmed) filtered="${filtered}${name}|${rest}"$'\n' ;;
            esac
        done
    done <<< "$MODULES_RAW"
    MODULES_RAW=$(echo "$filtered" | sed '/^$/d')
fi

if [[ -z "$MODULES_RAW" ]]; then
    echo -e "${color_red}ERROR: No modules found with androidTest directory${color_reset}"
    if [[ -n "$MODULE_FILTER" ]]; then
        echo -e "${color_yellow}Filter applied: ${MODULE_FILTER}${color_reset}"
    fi
    echo -e "${color_gray}Available modules:${color_reset}"
    while IFS='|' read -r name _rest; do
        echo "  - $name"
    done <<< "$ALL_MODULES_RAW"
    exit 1
fi

# Count modules
total_modules=$(echo "$MODULES_RAW" | wc -l | tr -d ' \r')

# Handle --list (no device needed)
if [[ "$LIST_ONLY" == "true" ]]; then
    echo ""
    echo -e "${color_cyan}Android Test Modules (${total_modules}):${color_reset}"
    while IFS='|' read -r name path has_flavor is_kmp description; do
        local_tags=""
        [[ "$is_kmp" == "true" ]] && local_tags+=" [KMP]"
        [[ "$has_flavor" == "true" ]] && local_tags+=" [Flavored]"
        echo "  - ${name}${local_tags} - ${description}"
    done <<< "$MODULES_RAW"
    exit 0
fi

# Device detection (required for actual test execution)
if [[ -z "$DEVICE" ]]; then
    dev_line=$("$ADB" devices 2>&1 | grep -E $'\t'"(device|emulator)$" | head -1) || true
    if [[ -n "$dev_line" ]]; then
        DEVICE=$(echo "$dev_line" | awk '{print $1}')
        echo -e "${color_yellow}Auto-selected device: ${DEVICE}${color_reset}"
    else
        echo -e "${color_red}ERROR: No active devices found via ADB.${color_reset}"
        echo -e "${color_yellow}Please connect a device or start an emulator.${color_reset}"
        exit 1
    fi
fi

# Verify device
device_state=$("$ADB" -s "$DEVICE" get-state 2>&1) || true
if [[ "$device_state" != "device" ]]; then
    echo -e "${color_red}ERROR: Device '$DEVICE' is not available (state: ${device_state})${color_reset}"
    exit 1
fi

# Create logs directory
timestamp=$(date +%Y-%m-%d_%H-%M-%S)
logs_dir="androidtest-logs/$timestamp"
mkdir -p "$logs_dir"

# Get package name
package_name=$(get_package_name "$PROJECT_ROOT")
if [[ -z "$package_name" ]]; then
    echo -e "${color_yellow}WARNING: Could not detect package name for logcat filtering${color_reset}"
fi

echo ""
echo -e "${color_cyan}========================================${color_reset}"
echo -e "${color_cyan}  Android Tests - All Modules Runner${color_reset}"
echo -e "${color_cyan}========================================${color_reset}"
echo -e "${color_gray}Device: ${DEVICE}${color_reset}"
echo -e "${color_gray}Logs: ${logs_dir}${color_reset}"
if [[ -n "$package_name" ]]; then
    echo -e "${color_gray}Package: ${package_name}${color_reset}"
fi
echo ""

# Results tracking arrays (parallel arrays since bash 3.2 lacks associative arrays)
declare -a result_names=()
declare -a result_statuses=()
declare -a result_durations=()
declare -a result_passed=()
declare -a result_failed=()
declare -a result_skipped=()
declare -a result_logfiles=()
declare -a result_logcats=()
declare -a result_errorfiles=()
declare -a result_successes=()
declare -a result_retried=()

current_module=0

# Clear logcat once at the start
echo -e "${color_gray}Clearing logcat...${color_reset}"
"$ADB" -s "$DEVICE" logcat -c >/dev/null 2>&1 || true

while IFS='|' read -r module_name module_path has_flavor is_kmp description; do
    current_module=$((current_module + 1))

    echo ""
    echo -e "${color_gray}[${current_module}/${total_modules}] ${color_magenta}${module_name}${color_gray} - ${description}${color_reset}"
    printf '%0.s-' {1..80}; echo ""

    # Construct Gradle task
    formatted_module=":${module_name}"

    if [[ "$is_kmp" == "true" ]]; then
        if [[ "$has_flavor" == "true" && -n "$FLAVOR" ]]; then
            flavor_cap="$(echo "${FLAVOR:0:1}" | tr '[:lower:]' '[:upper:]')${FLAVOR:1}"
            task="${formatted_module}:connected${flavor_cap}DebugAndroidTest"
        else
            task="${formatted_module}:connectedDebugAndroidTest"
        fi
    elif [[ "$has_flavor" == "true" && -n "$FLAVOR" ]]; then
        flavor_cap="$(echo "${FLAVOR:0:1}" | tr '[:lower:]' '[:upper:]')${FLAVOR:1}"
        task="${formatted_module}:connected${flavor_cap}DebugAndroidTest"
    elif [[ "$has_flavor" == "true" ]]; then
        task="${formatted_module}:connectedDebugAndroidTest"
    else
        task="${formatted_module}:connectedAndroidTest"
    fi

    # Log files for this module
    safe_name="${module_name//:/_}"
    module_log_file="${logs_dir}/${safe_name}.log"
    module_logcat_file="${logs_dir}/${safe_name}_logcat.log"
    module_errors_file="${logs_dir}/${safe_name}_errors.json"

    echo -e "${color_gray}Running: ./gradlew ${task}${color_reset}"

    # Run tests
    start_sec=$SECONDS
    exit_code=0
    ./gradlew "$task" --console=plain 2>&1 | tee "$module_log_file" || exit_code=$?
    duration_sec=$((SECONDS - start_sec))
    duration_min=$((duration_sec / 60))
    duration_s=$((duration_sec % 60))
    duration_str=$(printf "%02d:%02d" "$duration_min" "$duration_s")

    # Capture logcat for this module
    if [[ -n "$package_name" ]]; then
        pid=$("$ADB" -s "$DEVICE" shell pidof "$package_name" 2>/dev/null | tr -d '\r\n') || true
        if [[ "$pid" =~ ^[0-9]+$ ]]; then
            "$ADB" -s "$DEVICE" logcat -d --pid="$pid" > "$module_logcat_file" 2>&1 || true
        else
            "$ADB" -s "$DEVICE" logcat -d -s "${package_name}:*" "AndroidRuntime:E" "System.err:W" > "$module_logcat_file" 2>&1 || true
        fi
    else
        "$ADB" -s "$DEVICE" logcat -d > "$module_logcat_file" 2>&1 || true
    fi

    # Parse test counts from log
    log_content=""
    [[ -f "$module_log_file" ]] && log_content=$(cat "$module_log_file")

    tests_passed=0
    tests_failed=0
    tests_skipped=0

    if [[ "$log_content" =~ ([0-9]+)\ tests?\ completed ]]; then
        tests_passed="${BASH_REMATCH[1]}"
    fi
    if [[ "$log_content" =~ ([0-9]+)\ failed ]]; then
        tests_failed="${BASH_REMATCH[1]}"
        tests_passed=$((tests_passed > tests_failed ? tests_passed - tests_failed : 0))
    fi
    if [[ "$log_content" =~ ([0-9]+)\ skipped ]]; then
        tests_skipped="${BASH_REMATCH[1]}"
    fi

    success=true
    status="PASS"
    if [[ $exit_code -ne 0 ]]; then
        success=false
        status="FAIL"
    fi

    # Extract errors for diagnosis
    if [[ "$success" == "false" ]]; then
        python3 -c "
import json, sys, re

log_content = sys.argv[1]
logcat_file = sys.argv[2]
output_file = sys.argv[3]

errors = {
    'compilationErrors': [],
    'testFailures': [],
    'crashes': []
}

# Compilation errors
for m in re.finditer(r'^e: .+', log_content, re.MULTILINE):
    errors['compilationErrors'].append(m.group()[:200])
    if len(errors['compilationErrors']) >= 10:
        break

# Test failures
for m in re.finditer(r'(AssertionError|expected.*but was|junit.*Failure).*', log_content):
    errors['testFailures'].append(m.group()[:200])
    if len(errors['testFailures']) >= 10:
        break

# Crashes from logcat
try:
    with open(logcat_file) as f:
        logcat = f.read()
    for m in re.finditer(r'(FATAL EXCEPTION|AndroidRuntime.*E/).*', logcat):
        errors['crashes'].append(m.group()[:200])
        if len(errors['crashes']) >= 5:
            break
except:
    pass

with open(output_file, 'w') as f:
    json.dump(errors, f, indent=2)
" "$log_content" "$module_logcat_file" "$module_errors_file" 2>/dev/null || true
    fi

    # Auto-retry logic
    retried=false
    if [[ "$AUTO_RETRY" == "true" && "$success" == "false" ]]; then
        echo -e "  ${color_yellow}[RETRY] Retrying after failure...${color_reset}"

        if [[ "$CLEAR_DATA" == "true" && -n "$package_name" ]]; then
            "$ADB" -s "$DEVICE" shell pm clear "$package_name" >/dev/null 2>&1 || true
        fi

        "$ADB" -s "$DEVICE" logcat -c >/dev/null 2>&1 || true

        retry_log_file="${logs_dir}/${safe_name}_retry.log"
        retry_exit=0
        ./gradlew "$task" --console=plain 2>&1 | tee "$retry_log_file" || retry_exit=$?

        if [[ $retry_exit -eq 0 ]]; then
            echo -e "  ${color_green}[RETRY] Succeeded on retry!${color_reset}"
            success=true
            status="PASS"
            exit_code=0
            retried=true
        fi
    fi

    # Store results
    result_names+=("$module_name")
    result_statuses+=("$status")
    result_durations+=("$duration_str")
    result_passed+=("$tests_passed")
    result_failed+=("$tests_failed")
    result_skipped+=("$tests_skipped")
    result_logfiles+=("$module_log_file")
    result_logcats+=("$module_logcat_file")
    if [[ "$success" == "false" ]]; then
        result_errorfiles+=("$module_errors_file")
    else
        result_errorfiles+=("")
    fi
    result_successes+=("$success")
    result_retried+=("$retried")

    # Display result
    echo ""
    if [[ "$success" == "true" ]]; then
        echo -e "  Status: ${color_green}${status}${color_reset} ${color_gray}(${duration_str})${color_reset}"
    else
        echo -e "  Status: ${color_red}${status}${color_reset} ${color_gray}(${duration_str})${color_reset}"
    fi

    if [[ $tests_passed -gt 0 || $tests_failed -gt 0 ]]; then
        echo -ne "  Tests: ${color_green}${tests_passed} passed${color_reset}"
        if [[ $tests_failed -gt 0 ]]; then
            echo -ne ", ${color_red}${tests_failed} failed${color_reset}"
        fi
        if [[ $tests_skipped -gt 0 ]]; then
            echo -ne ", ${color_yellow}${tests_skipped} skipped${color_reset}"
        fi
        echo ""
    fi

    # Show errors if failed
    if [[ "$success" == "false" ]]; then
        echo ""
        echo -e "  ${color_red}[ERROR SUMMARY]${color_reset}"

        if [[ -f "$module_errors_file" ]]; then
            python3 -c "
import json, sys

with open(sys.argv[1]) as f:
    err = json.load(f)

if err.get('compilationErrors'):
    print('  Compilation errors:')
    for e in err['compilationErrors'][:3]:
        line = e[:100] + '...' if len(e) > 100 else e
        print(f'    {line}')

if err.get('testFailures'):
    print('  Test failures:')
    for e in err['testFailures'][:3]:
        line = e[:100] + '...' if len(e) > 100 else e
        print(f'    {line}')

if err.get('crashes'):
    print('  Crashes detected:')
    for e in err['crashes'][:2]:
        line = e[:100] + '...' if len(e) > 100 else e
        print(f'    {line}')
" "$module_errors_file" 2>/dev/null || true
        fi

        echo -e "  ${color_yellow}Full log: ${module_log_file}${color_reset}"
        echo -e "  ${color_yellow}Logcat: ${module_logcat_file}${color_reset}"
    fi

    # Verbose output
    if [[ "$VERBOSE" == "true" && "$success" == "false" ]]; then
        echo ""
        echo -e "  ${color_yellow}[LAST 30 LINES OF LOG]${color_reset}"
        tail -30 "$module_log_file" 2>/dev/null | while IFS= read -r vline; do
            echo -e "    ${color_gray}${vline}${color_reset}"
        done
    fi

    # Clear logcat for next module
    "$ADB" -s "$DEVICE" logcat -c >/dev/null 2>&1 || true

done <<< "$MODULES_RAW"

# Summary
echo ""
echo -e "${color_cyan}========================================${color_reset}"
echo -e "${color_cyan}  SUMMARY${color_reset}"
echo -e "${color_cyan}========================================${color_reset}"
echo ""

total_success=0
total_failure=0
total_tests=0
total_failed_tests=0

for i in "${!result_names[@]}"; do
    if [[ "${result_successes[$i]}" == "true" ]]; then
        total_success=$((total_success + 1))
    else
        total_failure=$((total_failure + 1))
    fi
    total_tests=$((total_tests + result_passed[i]))
    total_failed_tests=$((total_failed_tests + result_failed[i]))
done

# Module results table
echo -e "${color_gray}Module Results:${color_reset}"
echo ""
for i in "${!result_names[@]}"; do
    if [[ "${result_successes[$i]}" == "true" ]]; then
        echo -ne "  ${color_green}[PASS]${color_reset} "
    else
        echo -ne "  ${color_red}[FAIL]${color_reset} "
    fi

    retried_tag=""
    [[ "${result_retried[$i]}" == "true" ]] && retried_tag=" (retried)"

    # Pad module name
    printf "%-30s%s" "${result_names[$i]}" "$retried_tag"
    echo -ne " ${color_gray}(${result_durations[$i]})${color_reset}"

    if [[ ${result_passed[$i]} -gt 0 || ${result_failed[$i]} -gt 0 ]]; then
        echo -ne " - ${color_green}${result_passed[$i]} tests${color_reset}"
        if [[ ${result_failed[$i]} -gt 0 ]]; then
            echo -ne ", ${color_red}${result_failed[$i]} failed${color_reset}"
        fi
    fi
    echo ""
done

echo ""
echo -e "${color_gray}Overall Results:${color_reset}"
echo -ne "  Modules: ${color_green}${total_success} passed${color_reset}"
if [[ $total_failure -gt 0 ]]; then
    echo -ne ", ${color_red}${total_failure} failed${color_reset}"
fi
echo -e " ${color_gray}(out of ${total_modules})${color_reset}"

if [[ $total_tests -gt 0 ]]; then
    echo -ne "  Tests: ${color_green}${total_tests} passed${color_reset}"
    if [[ $total_failed_tests -gt 0 ]]; then
        echo -ne ", ${color_red}${total_failed_tests} failed${color_reset}"
    fi
    echo ""
fi

echo ""
echo -e "${color_gray}Logs saved to: ${logs_dir}${color_reset}"

# Generate JSON summary
summary_file="${logs_dir}/summary.json"
python3 -c "
import json, sys

# Read parallel arrays from args
names = sys.argv[1].split('|') if sys.argv[1] else []
statuses = sys.argv[2].split('|') if sys.argv[2] else []
durations = sys.argv[3].split('|') if sys.argv[3] else []
passed_arr = sys.argv[4].split('|') if sys.argv[4] else []
failed_arr = sys.argv[5].split('|') if sys.argv[5] else []
skipped_arr = sys.argv[6].split('|') if sys.argv[6] else []
logfiles = sys.argv[7].split('|') if sys.argv[7] else []
logcats = sys.argv[8].split('|') if sys.argv[8] else []
errorfiles = sys.argv[9].split('|') if sys.argv[9] else []
retried_arr = sys.argv[10].split('|') if sys.argv[10] else []

timestamp = sys.argv[11]
device = sys.argv[12]
pkg = sys.argv[13]
total_mods = int(sys.argv[14])
pass_mods = int(sys.argv[15])
fail_mods = int(sys.argv[16])
total_tests = int(sys.argv[17])
total_failed = int(sys.argv[18])
logs_dir = sys.argv[19]

modules = []
for i in range(len(names)):
    modules.append({
        'name': names[i],
        'status': statuses[i] if i < len(statuses) else '',
        'duration': durations[i] if i < len(durations) else '',
        'testsPassed': int(passed_arr[i]) if i < len(passed_arr) and passed_arr[i] else 0,
        'testsFailed': int(failed_arr[i]) if i < len(failed_arr) and failed_arr[i] else 0,
        'testsSkipped': int(skipped_arr[i]) if i < len(skipped_arr) and skipped_arr[i] else 0,
        'logFile': logfiles[i] if i < len(logfiles) else '',
        'logcatFile': logcats[i] if i < len(logcats) else '',
        'errorsFile': errorfiles[i] if i < len(errorfiles) and errorfiles[i] else None,
        'retried': retried_arr[i] == 'true' if i < len(retried_arr) else False
    })

summary = {
    'timestamp': timestamp,
    'device': device,
    'packageName': pkg,
    'totalModules': total_mods,
    'passedModules': pass_mods,
    'failedModules': fail_mods,
    'totalTests': total_tests,
    'passedTests': total_tests - total_failed,
    'failedTests': total_failed,
    'logsDir': logs_dir,
    'modules': modules
}

output = json.dumps(summary, indent=2)
print(output)

with open(sys.argv[20], 'w') as f:
    f.write(output)
" \
  "$(IFS='|'; echo "${result_names[*]}")" \
  "$(IFS='|'; echo "${result_statuses[*]}")" \
  "$(IFS='|'; echo "${result_durations[*]}")" \
  "$(IFS='|'; echo "${result_passed[*]}")" \
  "$(IFS='|'; echo "${result_failed[*]}")" \
  "$(IFS='|'; echo "${result_skipped[*]}")" \
  "$(IFS='|'; echo "${result_logfiles[*]}")" \
  "$(IFS='|'; echo "${result_logcats[*]}")" \
  "$(IFS='|'; echo "${result_errorfiles[*]}")" \
  "$(IFS='|'; echo "${result_retried[*]}")" \
  "$timestamp" "$DEVICE" "${package_name:-}" \
  "$total_modules" "$total_success" "$total_failure" \
  "$total_tests" "$total_failed_tests" \
  "$logs_dir" "$summary_file"

echo ""
echo -e "${color_cyan}=== JSON SUMMARY ===${color_reset}"
cat "$summary_file"

# Append audit record
if [[ $total_failure -gt 0 ]]; then
    _at_result="fail"
elif [[ $total_tests -eq 0 ]]; then
    _at_result="warn"
else
    _at_result="pass"
fi
_at_pass_rate=0
if [[ $total_tests -gt 0 ]]; then
    _at_pass_rate=$(python3 -c "print(round((($total_tests - $total_failed_tests) / $total_tests) * 100, 1))" 2>/dev/null || echo 0)
fi
_at_extra='"tests_total":'"${total_tests}"',"tests_passed":'"$((total_tests - total_failed_tests))"',"tests_failed":'"${total_failed_tests}"',"modules_total":'"${total_modules}"',"modules_passed":'"$((total_modules - total_failure))"',"pass_rate":'"${_at_pass_rate}"
audit_append "$PROJECT_ROOT" "android_test" "$_at_result" "$_at_extra"

# Exit code
if [[ $total_failure -gt 0 ]]; then
    echo ""
    echo -e "${color_red}BUILD FAILED - ${total_failure} module(s) failed${color_reset}"
    exit 1
else
    echo ""
    echo -e "${color_green}BUILD SUCCESSFUL - All modules passed!${color_reset}"
    exit 0
fi

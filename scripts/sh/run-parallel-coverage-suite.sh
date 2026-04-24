#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Run all tests in parallel using a SINGLE Gradle invocation with full coverage.
#
# Executes tests for all modules using ONE Gradle command with --parallel
# --continue, then generates Kover coverage reports and produces a comprehensive
# markdown report.
#
# Supports both Android projects and Kotlin Multiplatform (KMP) projects.
# =============================================================================

# ---------------------------------------------------------------------------
# COLOR HELPERS
# ---------------------------------------------------------------------------
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
WHITE='\033[37m'
GRAY='\033[90m'
DARK_YELLOW='\033[33m'
RESET='\033[0m'

color_print() { echo -e "${1}${2}${RESET}"; }
info()   { color_print "$CYAN"   "$1"; }
ok()     { color_print "$GREEN"  "$1"; }
warn()   { color_print "$YELLOW" "$1"; }
err()    { color_print "$RED"    "$1"; }
gray()   { color_print "$GRAY"   "$1"; }
white()  { color_print "$WHITE"  "$1"; }

# ---------------------------------------------------------------------------
# DEFAULTS
# ---------------------------------------------------------------------------
PROJECT_ROOT=""
INCLUDE_SHARED=false
TEST_TYPE=""
MODULE_FILTER="*"
SKIP_TESTS=false
MIN_MISSED_LINES=0
OUTPUT_FILE="coverage-full-report.md"
JAVA_HOME_OVERRIDE=""
MAX_WORKERS=0
FRESH_DAEMON=false
COVERAGE_ONLY=false
COVERAGE_MODULES="${COVERAGE_MODULES:-}"
COVERAGE_TOOL="auto"
EXCLUDE_COVERAGE=""
TIMEOUT=600

# ---------------------------------------------------------------------------
# USAGE
# ---------------------------------------------------------------------------
usage() {
    cat <<'USAGE'
Usage: run-parallel-coverage-suite.sh --project-root <path> [OPTIONS]

Required:
  --project-root <path>       Path to the main project root.

Options:
  --include-shared            Include shared-kmp-libs modules.
  --test-type <type>          all | common | androidUnit | androidInstrumented | desktop
  --module-filter <pattern>   Filter modules (wildcards/comma-separated). Default: *
  --skip-tests                Skip test execution, regenerate coverage only.
  --min-missed-lines <N>      Min missed lines to include in gaps. Default: 0
  --output-file <name>        Report filename. Default: coverage-full-report.md
  --java-home <path>          Override JAVA_HOME.
  --max-workers <N>           Override Gradle worker count. 0 = auto.
  --fresh-daemon              Stop existing Gradle daemons before starting.
  --coverage-only             Only run coverage modules.
  --coverage-modules <list>   Comma-separated modules for coverage-only mode.
  --coverage-tool <tool>      Coverage tool: auto (default) | jacoco | kover | none
  --exclude-coverage <list>   Comma-separated modules to exclude from coverage (still tested).
  --timeout <seconds>         Timeout for test execution. Default: 600
  --benchmark                 Run benchmarks after tests/coverage (default: off).
  --benchmark-config <name>   Benchmark config: smoke (default) | main | stress
  -h | --help                 Show this help.
USAGE
    exit 0
}

# ---------------------------------------------------------------------------
# ARGUMENT PARSING
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --project-root)       PROJECT_ROOT="$2"; shift 2 ;;
        --include-shared)     INCLUDE_SHARED=true; shift ;;
        --test-type)          TEST_TYPE="$2"; shift 2 ;;
        --module-filter)      MODULE_FILTER="$2"; shift 2 ;;
        --skip-tests)         SKIP_TESTS=true; shift ;;
        --min-missed-lines)   MIN_MISSED_LINES="$2"; shift 2 ;;
        --output-file)        OUTPUT_FILE="$2"; shift 2 ;;
        --java-home)          JAVA_HOME_OVERRIDE="$2"; shift 2 ;;
        --max-workers)        MAX_WORKERS="$2"; shift 2 ;;
        --fresh-daemon)       FRESH_DAEMON=true; shift ;;
        --coverage-only)      COVERAGE_ONLY=true; shift ;;
        --coverage-modules)   COVERAGE_MODULES="$2"; shift 2 ;;
        --coverage-tool)      COVERAGE_TOOL="$2"; shift 2 ;;
        --exclude-coverage)   EXCLUDE_COVERAGE="$2"; shift 2 ;;
        --timeout)            TIMEOUT="$2"; shift 2 ;;
        --benchmark)          BENCHMARK=true; shift ;;
        --benchmark-config)   BENCHMARK_CONFIG="$2"; shift 2 ;;
        -h|--help)            usage ;;
        *) err "[ERROR] Unknown option: $1"; exit 1 ;;
    esac
done

if [[ -z "$PROJECT_ROOT" ]]; then
    err "[ERROR] --project-root is required."
    usage
fi

# ---------------------------------------------------------------------------
# CONFIGURATION
# ---------------------------------------------------------------------------
SKIP_DESKTOP_MODULES="${SKIP_DESKTOP_MODULES:-}"
SKIP_ANDROID_MODULES="${SKIP_ANDROID_MODULES:-}"
PARENT_ONLY_MODULES="${PARENT_ONLY_MODULES:-}"
# Modules that run tests but should NOT generate coverage reports
# (test utilities, guard tests, app shells without meaningful coverage)
AUTO_EXCLUDE_COVERAGE_PATTERNS=("*:testing" "*:test-fakes" "*:test-fixtures" "konsist-guard" "konsist-tests" "detekt-rules*" "*detekt-rules*" "benchmark" "benchmark-*" "desktopApp")

IFS=',' read -ra CORE_ONLY_MODULES <<< "$COVERAGE_MODULES"
# Trim whitespace from each element (bash builtins instead of sed subshell)
for i in "${!CORE_ONLY_MODULES[@]}"; do
    local_val="${CORE_ONLY_MODULES[$i]}"
    local_val="${local_val#"${local_val%%[![:space:]]*}"}"
    local_val="${local_val%"${local_val##*[![:space:]]}"}"
    CORE_ONLY_MODULES[$i]="$local_val"
done

# Source libraries
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/coverage-detect.sh"
source "$SCRIPT_DIR/lib/audit-append.sh"
source "$SCRIPT_DIR/lib/script-utils.sh"

EXCLUSION_PATTERNS=(
    '*$DefaultImpls'
    '*$Companion'
    '*$$serializer'
    'ComposableSingletons$*'
)

# ---------------------------------------------------------------------------
# UTILITY FUNCTIONS
# (glob_match, get_project_type, test_class_excluded, format_line_ranges
#  are provided by lib/script-utils.sh, sourced above)
# ---------------------------------------------------------------------------

# Discover modules from settings.gradle.kts and build.gradle.kts.
# Outputs one module per line.
find_modules() {
    local project_path="$1"
    local filter="$2"

    # Build set of modules from settings.gradle.kts (Bash 3.2 compatible — no declare -A)
    local settings_file="$project_path/settings.gradle.kts"
    local included_modules_list=""
    local included_count=0
    if [[ -f "$settings_file" ]]; then
        while IFS= read -r line; do
            # Match active include() lines (not commented out) using bash regex
            if [[ "$line" =~ ^[[:space:]]*include[[:space:]]*\([[:space:]]*\"([^\"]+)\" ]]; then
                local gradle_path="${BASH_REMATCH[1]}"
                if [[ -n "$gradle_path" ]]; then
                    local fs_path="${gradle_path#:}"
                    included_modules_list="${included_modules_list}|${fs_path}|"
                    included_count=$((included_count + 1))
                fi
            fi
        done < "$settings_file"
    fi

    # Find all build.gradle.kts directories
    local all_modules=()
    while IFS= read -r bgk; do
        local dir
        dir="$(dirname "$bgk")"
        local rel_path="${dir#"$project_path"}"
        rel_path="${rel_path#/}"
        if [[ -z "$rel_path" ]]; then continue; fi
        # Skip build directories and .gradle (bash builtins instead of grep subshells)
        if [[ "$rel_path" =~ (^|/)build(/|$) ]]; then continue; fi
        if [[ "$rel_path" == *".gradle"* ]]; then continue; fi
        # Convert slashes to colons for Gradle-style module path
        local mod_path="${rel_path//\//:}"
        all_modules+=("$mod_path")
    done < <(find "$project_path" -name "build.gradle.kts" -not -path "*/build/*" -not -path "*/.gradle/*" 2>/dev/null | sort -u)

    # Filter out modules not in settings.gradle.kts (if we found any)
    if [[ $included_count -gt 0 ]]; then
        local filtered=()
        for mod in "${all_modules[@]}"; do
            if [[ "$included_modules_list" == *"|${mod}|"* ]]; then
                filtered+=("$mod")
            fi
        done
        all_modules=("${filtered[@]+"${filtered[@]}"}")
    fi

    # Apply module filter (comma-separated glob patterns)
    IFS=',' read -ra filter_list <<< "$filter"
    local matched_modules=()
    for mod in "${all_modules[@]}"; do
        for f in "${filter_list[@]}"; do
            # Trim whitespace using bash builtins instead of sed subshell
            f="${f#"${f%%[![:space:]]*}"}"
            f="${f%"${f##*[![:space:]]}"}"
            if glob_match "$f" "$mod"; then
                matched_modules+=("$mod")
                break
            fi
        done
    done

    # Remove parent-only modules
    local final_modules=()
    for mod in "${matched_modules[@]}"; do
        local is_parent=false
        for pmod in $PARENT_ONLY_MODULES; do
            if [[ "$mod" == "$pmod" ]]; then is_parent=true; break; fi
        done
        if ! $is_parent; then
            final_modules+=("$mod")
        fi
    done

    # Output unique sorted
    printf '%s\n' "${final_modules[@]}" | sort -u
}

# Parse coverage XML report (Kover or JaCoCo) using shared Python parser.
# Each line: MODULE|PACKAGE|SOURCEFILE|CLASSNAME|COVERED|MISSED|TOTAL|PCT|MISSED_LINES
parse_coverage_report() {
    local xml_path="$1"
    local module_name="$2"
    if [[ ! -f "$xml_path" ]]; then return; fi

    local parser_script="$SCRIPT_DIR/../lib/parse-coverage-xml.py"
    python3 "$parser_script" "$xml_path" "$module_name"
}

# format_line_ranges provided by lib/script-utils.sh

# Colored printf with fixed-width columns.
# printf_color <color_code> <format> <args...>
printf_color() {
    local color="$1"; shift
    local fmt="$1"; shift
    # shellcheck disable=SC2059
    printf "${color}${fmt}${RESET}" "$@"
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

echo ""
info "========================================"
info "  Parallel Test Suite + Coverage Report"
info "========================================"
echo ""

# Validate project path
if [[ ! -d "$PROJECT_ROOT" ]]; then
    err "[ERROR] Project path does not exist: $PROJECT_ROOT"
    exit 2
fi

# Resolve to absolute path
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
PROJECT_NAME="$(basename "$PROJECT_ROOT")"

# Set JAVA_HOME if provided
if [[ -n "$JAVA_HOME_OVERRIDE" ]]; then
    export JAVA_HOME="$JAVA_HOME_OVERRIDE"
    info "Using JAVA_HOME override: $JAVA_HOME"
fi

# Auto-detect required JDK version from project
if [[ -z "$JAVA_HOME_OVERRIDE" && -d "$PROJECT_ROOT" ]]; then
    required_jdk=""
    gradle_java=""
    # Check gradle.properties for org.gradle.java.home
    if [[ -f "$PROJECT_ROOT/gradle.properties" ]]; then
        gradle_java="$(grep "^org.gradle.java.home" "$PROJECT_ROOT/gradle.properties" 2>/dev/null | sed 's/.*=//' | tr -d ' \r' || true)"
        if [[ -n "$gradle_java" && -d "$gradle_java" ]]; then
            export JAVA_HOME="$gradle_java"
            info "Auto-detected JAVA_HOME from gradle.properties: $JAVA_HOME"
        fi
    fi
    # Check jvmToolchain version in build files
    if [[ -z "$gradle_java" ]]; then
        jvm_version="$(grep -rh "jvmToolchain" "$PROJECT_ROOT" --include="*.gradle.kts" 2>/dev/null | head -1 | grep -oE '[0-9]+' | head -1 || true)"
        if [[ -n "$jvm_version" && -n "$JAVA_HOME" ]]; then
            current_version="$(java -version 2>&1 | head -1 | grep -oE '"[0-9]+' | tr -d '"' || true)"
            if [[ -n "$current_version" && "$current_version" != "$jvm_version" ]]; then
                warn "[!] Project requires JDK $jvm_version but current JAVA_HOME points to JDK $current_version"
                warn "    Use --java-home <path-to-jdk-$jvm_version> or set JAVA_HOME before running"
                warn "    With --fresh-daemon this WILL cause UnsupportedClassVersionError"
            fi
        fi
    fi
fi

# Detect platform and test type
PROJECT_TYPE="$(get_project_type "$PROJECT_ROOT")"

if [[ -z "$TEST_TYPE" ]]; then
    if [[ "$PROJECT_TYPE" == "kmp-desktop" ]]; then
        TEST_TYPE="common"
    else
        TEST_TYPE="androidUnit"
    fi
fi

IS_DESKTOP=false
if [[ "$TEST_TYPE" == "common" || "$TEST_TYPE" == "desktop" ]]; then
    IS_DESKTOP=true
fi

case "$TEST_TYPE" in
    common)              PLATFORM_NAME="desktop (commonTest)" ;;
    desktop)             PLATFORM_NAME="desktop (desktopTest)" ;;
    androidUnit)         PLATFORM_NAME="android (androidUnitTest)" ;;
    androidInstrumented) PLATFORM_NAME="android (instrumented)" ;;
    all)                 PLATFORM_NAME="all test types" ;;
    *)
        if $IS_DESKTOP; then PLATFORM_NAME="desktop"
        else PLATFORM_NAME="android"; fi
        ;;
esac

# ============================================================================
# DAEMON MANAGEMENT
# ============================================================================

if $FRESH_DAEMON; then
    warn "[>] Stopping existing Gradle daemons..."
    (cd "$PROJECT_ROOT" && ./gradlew --stop 2>&1 >/dev/null) || true

    # Clean cached coverage reports so Kover regenerates from scratch
    info "  [>] Cleaning cached coverage reports..."
    find "$PROJECT_ROOT" -path "*/build/reports/kover" -type d -exec rm -rf {} + 2>/dev/null || true
    find "$PROJECT_ROOT" -path "*/build/reports/jacoco" -type d -exec rm -rf {} + 2>/dev/null || true

    ok "  [OK] Daemons stopped + coverage cache cleaned"
    echo ""
else
    # Check daemon status
    DAEMON_STATUS="$(cd "$PROJECT_ROOT" && ./gradlew --status 2>&1)" || true
    if echo "$DAEMON_STATUS" | grep -q "BUSY"; then
        warn "[!] WARNING: Busy Gradle daemons detected. Use --fresh-daemon to clean them."
        echo ""
    fi
fi

# ============================================================================
# DISCOVER MODULES
# ============================================================================

# We store module info in parallel arrays (bash 3.2 compatible associative-array workaround)
declare -a MOD_NAMES=()   # Display name (may include shared-kmp-libs: prefix)
declare -a MOD_PATHS=()   # Filesystem path
declare -a MOD_PROJ=()    # Project path this module belongs to
declare -a MOD_SHORT=()   # Short name (last segment)
declare -a MOD_GRADLE=()  # Gradle path inside its project

# Track projects to process
declare -a PROJ_NAMES=()
declare -a PROJ_PATHS=()
declare -a PROJ_PREFIXES=()

PROJ_NAMES+=("$PROJECT_NAME")
PROJ_PATHS+=("$PROJECT_ROOT")
PROJ_PREFIXES+=("")

if $INCLUDE_SHARED; then
    SHARED_LIBS_PATH="${SHARED_ROOT:-$(cd "$(dirname "$PROJECT_ROOT")/shared-kmp-libs" 2>/dev/null && pwd)}"
    PROJECT_ROOT_RESOLVED="$(cd "$PROJECT_ROOT" && pwd)"
    if [[ -n "$SHARED_LIBS_PATH" && -d "$SHARED_LIBS_PATH" && "$SHARED_LIBS_PATH" != "$PROJECT_ROOT_RESOLVED" ]]; then
        PROJ_NAMES+=("shared-kmp-libs")
        PROJ_PATHS+=("$SHARED_LIBS_PATH")
        PROJ_PREFIXES+=("shared-kmp-libs:")
        ok "[+] Including shared-kmp-libs: $SHARED_LIBS_PATH"
    elif [[ "$SHARED_LIBS_PATH" == "$PROJECT_ROOT_RESOLVED" ]]; then
        warn "[~] shared-kmp-libs IS the project root - skipping duplicate"
    else
        warn "[!] shared-kmp-libs not found at: $(dirname "$PROJECT_ROOT")/shared-kmp-libs"
    fi
fi

for pi in "${!PROJ_NAMES[@]}"; do
    pname="${PROJ_NAMES[$pi]}"
    ppath="${PROJ_PATHS[$pi]}"
    pprefix="${PROJ_PREFIXES[$pi]}"

    info "[>] Discovering modules in $pname..."

    while IFS= read -r mod; do
        [[ -z "$mod" ]] && continue
        local_name="${pprefix}${mod}"
        local_path="$ppath/${mod//:/\/}"
        local_short="${mod##*:}"

        MOD_NAMES+=("$local_name")
        MOD_PATHS+=("$local_path")
        MOD_PROJ+=("$ppath")
        MOD_SHORT+=("$local_short")
        MOD_GRADLE+=("$mod")
    done < <(find_modules "$ppath" "$MODULE_FILTER")
done

# Apply CoverageOnly filter
if $COVERAGE_ONLY; then
    declare -a FILTERED_NAMES=() FILTERED_PATHS=() FILTERED_PROJ=() FILTERED_SHORT=() FILTERED_GRADLE=()
    for mi in "${!MOD_NAMES[@]}"; do
        mod_name="${MOD_NAMES[$mi]}"
        is_core=false
        for core_mod in "${CORE_ONLY_MODULES[@]}"; do
            if [[ "$mod_name" == "$core_mod" ]] || [[ "$mod_name" == *":$core_mod" ]]; then
                is_core=true; break
            fi
        done
        if $is_core; then
            FILTERED_NAMES+=("${MOD_NAMES[$mi]}")
            FILTERED_PATHS+=("${MOD_PATHS[$mi]}")
            FILTERED_PROJ+=("${MOD_PROJ[$mi]}")
            FILTERED_SHORT+=("${MOD_SHORT[$mi]}")
            FILTERED_GRADLE+=("${MOD_GRADLE[$mi]}")
        fi
    done
    MOD_NAMES=("${FILTERED_NAMES[@]+"${FILTERED_NAMES[@]}"}")
    MOD_PATHS=("${FILTERED_PATHS[@]+"${FILTERED_PATHS[@]}"}")
    MOD_PROJ=("${FILTERED_PROJ[@]+"${FILTERED_PROJ[@]}"}")
    MOD_SHORT=("${FILTERED_SHORT[@]+"${FILTERED_SHORT[@]}"}")
    MOD_GRADLE=("${FILTERED_GRADLE[@]+"${FILTERED_GRADLE[@]}"}")
    warn "[>] Coverage-only mode: filtering to core modules"
fi

MODULE_COUNT="${#MOD_NAMES[@]}"
if [[ "$MODULE_COUNT" -eq 0 ]]; then
    err "[ERROR] No modules found matching filter: $MODULE_FILTER"
    exit 3
fi

echo ""
info "Configuration:"
echo "  Project: $PROJECT_NAME"
echo "  Test Type: $TEST_TYPE ($PLATFORM_NAME)"
echo "  Include shared: $INCLUDE_SHARED"
echo "  Skip tests: $SKIP_TESTS"
echo "  Module filter: $MODULE_FILTER"
echo "  Coverage only: $COVERAGE_ONLY"
echo "  Coverage tool: $COVERAGE_TOOL"
echo "  Max workers: $(if [[ "$MAX_WORKERS" -gt 0 ]]; then echo "$MAX_WORKERS"; else echo "auto"; fi)"
echo "  Timeout: ${TIMEOUT}s"
echo "  Modules found: $MODULE_COUNT"
echo ""

# ============================================================================
# BUILD TASK LISTS
# ============================================================================

declare -a TEST_TASKS=()
declare -a TEST_TASKS_SHARED=()
declare -a COV_TASKS=()
declare -a COV_TASKS_SHARED=()
declare -a SKIPPED_MODULES=()
declare -a MOD_COV_TOOL=()
declare -a TESTABLE_INDICES=()

for mi in "${!MOD_NAMES[@]}"; do
    short_name="${MOD_SHORT[$mi]}"
    should_skip=false

    if $IS_DESKTOP; then
        for skip_mod in $SKIP_DESKTOP_MODULES; do
            if [[ "$short_name" == "$skip_mod" ]]; then should_skip=true; break; fi
        done
    else
        for skip_mod in $SKIP_ANDROID_MODULES; do
            if [[ "$short_name" == "$skip_mod" ]]; then should_skip=true; break; fi
        done
    fi

    if $should_skip; then
        SKIPPED_MODULES+=("${MOD_NAMES[$mi]}")
        color_print "$DARK_YELLOW" "  [SKIP] ${MOD_NAMES[$mi]} (no $TEST_TYPE tests)"
        continue
    fi

    TESTABLE_INDICES+=("$mi")

    is_shared=false
    short_mod="${MOD_NAMES[$mi]}"
    if [[ "$short_mod" == shared-kmp-libs:* ]]; then
        is_shared=true
        short_mod="${short_mod#shared-kmp-libs:}"
    fi
    gradle_path=":${short_mod}"

    # Determine test task
    case "$TEST_TYPE" in
        common|desktop|all) test_task="${gradle_path}:desktopTest" ;;
        androidUnit)        test_task="${gradle_path}:testDebugUnitTest" ;;
        androidInstrumented) test_task="${gradle_path}:connectedDebugAndroidTest" ;;
        *)
            if $IS_DESKTOP; then test_task="${gradle_path}:desktopTest"
            else test_task="${gradle_path}:testDebugUnitTest"; fi
            ;;
    esac

    if $is_shared; then
        TEST_TASKS_SHARED+=("$test_task")
    else
        TEST_TASKS+=("$test_task")
    fi

    # Determine coverage tool for this module
    build_file="${MOD_PATHS[$mi]}/build.gradle.kts"

    # Check if module is excluded from coverage
    skip_cov=false
    if [[ -n "$EXCLUDE_COVERAGE" ]]; then
        IFS=',' read -ra excl_list <<< "$EXCLUDE_COVERAGE"
        for excl in "${excl_list[@]}"; do
            excl="${excl#"${excl%%[! ]*}"}"  # trim leading space
            excl="${excl%"${excl##*[! ]}"}"  # trim trailing space
            if [[ "${MOD_NAMES[$mi]}" == "$excl" || "${MOD_NAMES[$mi]}" == ":$excl" || ":${MOD_NAMES[$mi]#:}" == ":$excl" ]]; then
                skip_cov=true
                break
            fi
        done
    fi

    if $skip_cov; then
        MOD_COV_TOOL[$mi]="none"
        gray "  [INFO] ${MOD_NAMES[$mi]} - excluded from coverage (--exclude-coverage)"
    else
        # Auto-exclude modules matching patterns (test utilities, guard tests)
        for pattern in "${AUTO_EXCLUDE_COVERAGE_PATTERNS[@]}"; do
            if [[ "${MOD_NAMES[$mi]}" == $pattern || ":${MOD_NAMES[$mi]#:}" == $pattern ]]; then
                skip_cov=true
                break
            fi
        done
        if $skip_cov; then
            MOD_COV_TOOL[$mi]="none"
            gray "  [INFO] ${MOD_NAMES[$mi]} - auto-excluded from coverage (test utility pattern)"
        fi
    fi

    if ! $skip_cov; then
        if [[ "$COVERAGE_TOOL" == "auto" ]]; then
            mod_cov_tool="$(detect_coverage_tool "$build_file")"
        elif [[ "$COVERAGE_TOOL" == "none" ]]; then
            mod_cov_tool="none"
        else
            mod_cov_tool="$COVERAGE_TOOL"
        fi
        MOD_COV_TOOL[$mi]="$mod_cov_tool"
    fi

    # Determine coverage task (only if not excluded)
    if ! $skip_cov; then
        cov_task="$(get_coverage_gradle_task "$mod_cov_tool" "$TEST_TYPE" "$IS_DESKTOP")"
        if [[ -n "$cov_task" ]]; then
            cov_task="${gradle_path}:${cov_task}"
            if $is_shared; then
                COV_TASKS_SHARED+=("$cov_task")
            else
                COV_TASKS+=("$cov_task")
            fi
        else
            gray "  [INFO] ${MOD_NAMES[$mi]} - no coverage ($(get_coverage_display_name "$mod_cov_tool")), skipping"
        fi
    fi
done

TESTABLE_COUNT="${#TESTABLE_INDICES[@]}"
SKIPPED_COUNT="${#SKIPPED_MODULES[@]}"

echo ""
white "Testable modules: $TESTABLE_COUNT | Skipped: $SKIPPED_COUNT"
echo ""

# ============================================================================
# RUN TESTS (SINGLE GRADLE INVOCATION)
# ============================================================================

# Per-module test result tracking (status in parallel array keyed by module name)
declare -a RESULT_STATUS=()   # passed / failed / skipped
declare -a RESULT_COVERAGE=() # coverage percentage or empty

# Initialize all as empty
for mi in "${!MOD_NAMES[@]}"; do
    RESULT_STATUS+=("")
    RESULT_COVERAGE+=("")
done

# Mark skipped — string-based lookup for Bash 3.2 compatibility
skipped_list=""
for skipped in "${SKIPPED_MODULES[@]}"; do
    skipped_list="${skipped_list}|${skipped}|"
done
for mi in "${!MOD_NAMES[@]}"; do
    if [[ "$skipped_list" == *"|${MOD_NAMES[$mi]}|"* ]]; then
        RESULT_STATUS[$mi]="skipped"
    fi
done

SUCCESS_COUNT=0
FAILURE_COUNT=0
START_TIME="$(date +%s)"

ALL_TEST_TASKS=("${TEST_TASKS[@]+"${TEST_TASKS[@]}"}" "${TEST_TASKS_SHARED[@]+"${TEST_TASKS_SHARED[@]}"}")

if ! $SKIP_TESTS && [[ "${#ALL_TEST_TASKS[@]}" -gt 0 ]]; then
    warn "========================================"
    warn "  Running Tests (Single Invocation)"
    warn "========================================"
    echo ""

    # Build Gradle args
    GRADLE_ARGS=("${ALL_TEST_TASKS[@]}" "--parallel" "--continue")
    if [[ "$MAX_WORKERS" -gt 0 ]]; then
        GRADLE_ARGS+=("--max-workers=$MAX_WORKERS")
    fi

    info "[>] Executing ${#ALL_TEST_TASKS[@]} test tasks in parallel..."
    gray "    Command: ./gradlew ${#ALL_TEST_TASKS[@]} tasks --parallel --continue"

    # List tasks for visibility
    for task in "${ALL_TEST_TASKS[@]}"; do
        gray "    $task"
    done
    echo ""

    # Run Gradle as background process with timeout watchdog
    TEMP_LOG="${TMPDIR:-/tmp}/gradle-parallel-tests-$(date +%Y%m%d-%H%M%S).log"
    TEMP_LOG_ERR="${TEMP_LOG}.err"

    (cd "$PROJECT_ROOT" && ./gradlew "${GRADLE_ARGS[@]}" > "$TEMP_LOG" 2> "$TEMP_LOG_ERR") &
    GRADLE_PID=$!

    ELAPSED=0
    INTERVAL=15

    echo ""
    while kill -0 "$GRADLE_PID" 2>/dev/null; do
        sleep "$INTERVAL"
        ELAPSED=$((ELAPSED + INTERVAL))

        # Progress heartbeat
        CURRENT_LINES=0
        if [[ -f "$TEMP_LOG" ]]; then
            CURRENT_LINES="$(wc -l < "$TEMP_LOG" 2>/dev/null || echo 0)"
            CURRENT_LINES="${CURRENT_LINES// /}"
        fi

        MINS=$((ELAPSED / 60))
        SECS=$((ELAPSED % 60))
        gray "  [${MINS}m${SECS}s] Running... | log lines: $CURRENT_LINES"

        # Timeout check
        if [[ "$ELAPSED" -ge "$TIMEOUT" ]]; then
            echo ""
            err "[TIMEOUT] Tests exceeded ${TIMEOUT}s limit! Killing Gradle..."

            # Kill the Gradle process tree
            kill "$GRADLE_PID" 2>/dev/null || true
            # Kill any lingering GradleWorkerMain processes
            pkill -f "GradleWorkerMain" 2>/dev/null || true
            sleep 2

            # Cross-project clean: shared-kmp-libs first, then main project
            SHARED_PATH="$(dirname "$PROJECT_ROOT")/shared-kmp-libs"
            if [[ -d "$SHARED_PATH" ]]; then
                warn "[RECOVERY] Stopping daemons in shared-kmp-libs..."
                (cd "$SHARED_PATH" && ./gradlew --stop 2>&1 >/dev/null) || true
            fi
            warn "[RECOVERY] Stopping daemons in $PROJECT_NAME..."
            (cd "$PROJECT_ROOT" && ./gradlew --stop 2>&1 >/dev/null) || true
            break
        fi
    done

    # Wait for process to finish and get exit code
    wait "$GRADLE_PID" 2>/dev/null && TEST_EXIT_CODE=0 || TEST_EXIT_CODE=$?

    # Read test output
    TEST_OUTPUT=""
    if [[ -f "$TEMP_LOG" ]]; then
        TEST_OUTPUT="$(cat "$TEMP_LOG" 2>/dev/null || true)"
    fi

    # Clean up temp files
    rm -f "$TEMP_LOG" "$TEMP_LOG_ERR" 2>/dev/null || true

    # Report timeout as failure
    if [[ "$ELAPSED" -ge "$TIMEOUT" ]]; then
        err "[!] Timed out after ${TIMEOUT}s."
        warn "[!] Tip: Run tests on individual modules to isolate the issue"
        TEST_EXIT_CODE=124
    fi

    # Parse output to determine per-module results
    for idx in "${TESTABLE_INDICES[@]}"; do
        mod_name="${MOD_NAMES[$idx]}"
        is_shared=false
        short_mod="$mod_name"
        if [[ "$short_mod" == shared-kmp-libs:* ]]; then
            is_shared=true
            short_mod="${short_mod#shared-kmp-libs:}"
        fi
        gradle_path=":${short_mod}"

        case "$TEST_TYPE" in
            common|desktop) task_name="${gradle_path}:desktopTest" ;;
            androidUnit)    task_name="${gradle_path}:testDebugUnitTest" ;;
            *)
                if $IS_DESKTOP; then task_name="${gradle_path}:desktopTest"
                else task_name="${gradle_path}:testDebugUnitTest"; fi
                ;;
        esac

        # Look for FAILED marker in output
        escaped_task="$(echo "$task_name" | sed 's/[.[\*^$()+?{|\\]/\\&/g')"
        if echo "$TEST_OUTPUT" | grep -q "${escaped_task} FAILED"; then
            err "  [FAIL] $mod_name"
            RESULT_STATUS[$idx]="failed"
            FAILURE_COUNT=$((FAILURE_COUNT + 1))
        else
            ok "  [PASS] $mod_name"
            RESULT_STATUS[$idx]="passed"
            SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        fi
    done

    END_TIME="$(date +%s)"
    TEST_DURATION=$((END_TIME - START_TIME))
    TEST_MINS=$((TEST_DURATION / 60))
    TEST_SECS=$((TEST_DURATION % 60))

    echo ""
    if [[ "$TEST_EXIT_CODE" -ne 0 && "$FAILURE_COUNT" -eq 0 && "$SUCCESS_COUNT" -eq 0 ]]; then
        # Gradle failed AND no individual task results detected at all.
        # This happens with JVM-level errors (UnsupportedClassVersionError,
        # OOM, daemon crash) where task output is missing entirely.
        warn "[!] Gradle exited with code $TEST_EXIT_CODE and no task results found."
        warn "    This usually means a JVM-level error (wrong JAVA_HOME, OOM, daemon crash)."
        warn "    Marking all ${#TESTABLE_INDICES[@]} modules as failed."
        FAILURE_COUNT="${#TESTABLE_INDICES[@]}"
        for idx in "${TESTABLE_INDICES[@]}"; do
            RESULT_STATUS[$idx]="failed"
        done
    elif [[ "$TEST_EXIT_CODE" -ne 0 && "$FAILURE_COUNT" -eq 0 && "$SUCCESS_COUNT" -gt 0 ]]; then
        # Gradle exit non-zero but individual tasks passed.
        # Likely deprecation warnings or non-fatal build issues (Gradle 9+).
        warn "[!] Gradle exited with code $TEST_EXIT_CODE but all $SUCCESS_COUNT tasks passed individually."
        warn "    This is likely deprecation warnings (Gradle 9+), not test failures."
    fi
    info "Test Duration: ${TEST_MINS}m ${TEST_SECS}s"
    echo ""

    # ========================================================================
    # GENERATE COVERAGE REPORTS (SINGLE INVOCATION)
    # ========================================================================

    info "[>] Generating coverage reports..."

    # Run main project coverage tasks
    # Do NOT use --rerun-tasks: it forces re-execution of desktopTest dependencies,
    # and modules like core-storage-secure fail with residual keystore state.
    # Kover generates XML from UP-TO-DATE test results without issue.
    if [[ "${#COV_TASKS[@]}" -gt 0 ]]; then
        COV_ARGS=("${COV_TASKS[@]}" "--parallel" "--continue")
        if [[ "$MAX_WORKERS" -gt 0 ]]; then COV_ARGS+=("--max-workers=$MAX_WORKERS"); fi

        COV_EXIT=0
        (cd "$PROJECT_ROOT" && ./gradlew "${COV_ARGS[@]}" 2>&1) || COV_EXIT=$?

        if [[ "$COV_EXIT" -ne 0 ]]; then
            # Check if --continue saved us: count how many XML reports were generated
            COV_XML_COUNT=0
            for idx in "${TESTABLE_INDICES[@]}"; do
                [[ "${MOD_PROJ[$idx]}" != "$PROJECT_ROOT" ]] && continue
                mod_tool="${MOD_COV_TOOL[$idx]:-}"
                [[ -z "$mod_tool" || "$mod_tool" == "none" ]] && continue
                xml_check="$(get_coverage_xml_path "$mod_tool" "${MOD_PATHS[$idx]}" "$IS_DESKTOP" 2>/dev/null)" || true
                [[ -n "$xml_check" ]] && COV_XML_COUNT=$((COV_XML_COUNT + 1))
            done

            if [[ "$COV_XML_COUNT" -gt 0 ]]; then
                # --continue worked: some tasks succeeded, some failed — reports exist
                # Collect missing modules and retry as a SINGLE batch (not per-module)
                declare -a MISSING_TASKS=()
                for idx in "${TESTABLE_INDICES[@]}"; do
                    [[ "${MOD_PROJ[$idx]}" != "$PROJECT_ROOT" ]] && continue
                    mod_tool="${MOD_COV_TOOL[$idx]:-}"
                    [[ -z "$mod_tool" || "$mod_tool" == "none" ]] && continue
                    xml_check="$(get_coverage_xml_path "$mod_tool" "${MOD_PATHS[$idx]}" "$IS_DESKTOP" 2>/dev/null)" || true
                    if [[ -z "$xml_check" ]]; then
                        short_mod="${MOD_NAMES[$idx]}"
                        short_mod="${short_mod#:}"
                        gpath=":${short_mod}"
                        cov_task_name="$(get_coverage_gradle_task "$mod_tool" "$TEST_TYPE" "$IS_DESKTOP")"
                        MISSING_TASKS+=("${gpath}:${cov_task_name}")
                    fi
                done
                MISSING_COV="${#MISSING_TASKS[@]}"
                RECOVERED_COV=0
                if [[ "$MISSING_COV" -gt 0 ]]; then
                    # Batch retry: single invocation for all missing modules
                    warn "  [>] Batch partial: $COV_XML_COUNT ok, $MISSING_COV missing → retrying as single batch..."
                    if (cd "$PROJECT_ROOT" && ./gradlew "${MISSING_TASKS[@]}" --parallel --continue 2>&1) >/dev/null; then
                        RECOVERED_COV="$MISSING_COV"
                    else
                        # Count how many were actually recovered
                        for idx in "${TESTABLE_INDICES[@]}"; do
                            [[ "${MOD_PROJ[$idx]}" != "$PROJECT_ROOT" ]] && continue
                            mod_tool="${MOD_COV_TOOL[$idx]:-}"
                            [[ -z "$mod_tool" || "$mod_tool" == "none" ]] && continue
                            xml_check="$(get_coverage_xml_path "$mod_tool" "${MOD_PATHS[$idx]}" "$IS_DESKTOP" 2>/dev/null)" || true
                            [[ -n "$xml_check" ]] && RECOVERED_COV=$((RECOVERED_COV + 1))
                        done
                        RECOVERED_COV=$((RECOVERED_COV - COV_XML_COUNT))
                    fi
                    warn "  [!] Batch recovery: $RECOVERED_COV / $MISSING_COV recovered"
                else
                    ok "  [OK] Main project coverage reports generated ($COV_XML_COUNT modules)"
                fi
            else
                # Configuration failure: no XMLs at all — fallback to per-module
                # Full batch failed — retry with --no-configuration-cache as single batch
                warn "  [!] Batch coverage failed (exit $COV_EXIT), 0 reports — retrying full batch without config cache..."
                COV_OK=0
                COV_FAIL=0
                if (cd "$PROJECT_ROOT" && ./gradlew "${COV_TASKS[@]}" --parallel --continue --no-configuration-cache 2>&1) >/dev/null; then
                    COV_OK="${#COV_TASKS[@]}"
                else
                    # Count how many XMLs exist now
                    for idx in "${TESTABLE_INDICES[@]}"; do
                        [[ "${MOD_PROJ[$idx]}" != "$PROJECT_ROOT" ]] && continue
                        mod_tool="${MOD_COV_TOOL[$idx]:-}"
                        [[ -z "$mod_tool" || "$mod_tool" == "none" ]] && continue
                        xml_check="$(get_coverage_xml_path "$mod_tool" "${MOD_PATHS[$idx]}" "$IS_DESKTOP" 2>/dev/null)" || true
                        if [[ -n "$xml_check" ]]; then
                            COV_OK=$((COV_OK + 1))
                        else
                            COV_FAIL=$((COV_FAIL + 1))
                        fi
                    done
                fi
                if [[ "$COV_OK" -gt 0 ]]; then
                    ok "  [OK] Batch retry: $COV_OK succeeded, $COV_FAIL failed"
                else
                    warn "  [!] All ${#COV_TASKS[@]} coverage tasks failed"
                fi
            fi
        else
            ok "  [OK] Main project coverage reports generated (${#COV_TASKS[@]} modules)"
        fi
    fi

    # Run shared-kmp-libs coverage tasks
    if [[ "${#COV_TASKS_SHARED[@]}" -gt 0 ]]; then
        SHARED_LIBS_PATH=""
        for pi in "${!PROJ_NAMES[@]}"; do
            if [[ "${PROJ_NAMES[$pi]}" == "shared-kmp-libs" ]]; then
                SHARED_LIBS_PATH="${PROJ_PATHS[$pi]}"
                break
            fi
        done
        if [[ -n "$SHARED_LIBS_PATH" && -d "$SHARED_LIBS_PATH" ]]; then
            COV_ARGS_SHARED=("${COV_TASKS_SHARED[@]}" "--parallel" "--continue")
            if [[ "$MAX_WORKERS" -gt 0 ]]; then COV_ARGS_SHARED+=("--max-workers=$MAX_WORKERS"); fi

            info "  [>] Generating shared-kmp-libs coverage (${#COV_TASKS_SHARED[@]} modules)..."
            COV_EXIT_SHARED=0
            (cd "$SHARED_LIBS_PATH" && ./gradlew "${COV_ARGS_SHARED[@]}" 2>&1) || COV_EXIT_SHARED=$?

            if [[ "$COV_EXIT_SHARED" -ne 0 ]]; then
                # Check if --continue saved us
                COV_XML_COUNT_S=0
                for idx in "${TESTABLE_INDICES[@]}"; do
                    [[ "${MOD_NAMES[$idx]}" != shared-kmp-libs:* ]] && continue
                    mod_tool="${MOD_COV_TOOL[$idx]:-}"
                    [[ -z "$mod_tool" || "$mod_tool" == "none" ]] && continue
                    xml_check="$(get_coverage_xml_path "$mod_tool" "${MOD_PATHS[$idx]}" "$IS_DESKTOP" 2>/dev/null)" || true
                    [[ -n "$xml_check" ]] && COV_XML_COUNT_S=$((COV_XML_COUNT_S + 1))
                done

                if [[ "$COV_XML_COUNT_S" -gt 0 ]]; then
                    warn "  [!] Shared coverage had errors (exit $COV_EXIT_SHARED) but $COV_XML_COUNT_S reports generated (--continue saved partial results)"
                else
                    warn "  [!] Batch shared coverage failed (exit $COV_EXIT_SHARED), 0 reports — retrying batch without config cache..."
                    COV_OK_S=0
                    COV_FAIL_S=0
                    if (cd "$SHARED_LIBS_PATH" && ./gradlew "${COV_TASKS_SHARED[@]}" --parallel --continue --no-configuration-cache 2>&1) >/dev/null; then
                        COV_OK_S="${#COV_TASKS_SHARED[@]}"
                    else
                        for idx in "${TESTABLE_INDICES[@]}"; do
                            [[ "${MOD_NAMES[$idx]}" != shared-kmp-libs:* ]] && continue
                            mod_tool="${MOD_COV_TOOL[$idx]:-}"
                            [[ -z "$mod_tool" || "$mod_tool" == "none" ]] && continue
                            xml_check="$(get_coverage_xml_path "$mod_tool" "${MOD_PATHS[$idx]}" "$IS_DESKTOP" 2>/dev/null)" || true
                            if [[ -n "$xml_check" ]]; then COV_OK_S=$((COV_OK_S + 1))
                            else COV_FAIL_S=$((COV_FAIL_S + 1)); fi
                        done
                    fi
                    if [[ "$COV_OK_S" -gt 0 ]]; then
                        ok "  [OK] Batch retry: $COV_OK_S succeeded, $COV_FAIL_S failed"
                    else
                        warn "  [!] All ${#COV_TASKS_SHARED[@]} shared coverage tasks failed"
                    fi
                fi
            else
                ok "  [OK] shared-kmp-libs coverage reports generated (${#COV_TASKS_SHARED[@]} modules)"
            fi
        else
            warn "  [!] shared-kmp-libs not found for coverage"
        fi
    fi

    if [[ "${#COV_TASKS[@]}" -eq 0 && "${#COV_TASKS_SHARED[@]}" -eq 0 ]]; then
        warn "  [!] No modules with coverage configured - skipping coverage generation"
    fi
    echo ""

elif $SKIP_TESTS; then
    # Mark all testable modules as passed (skipped test execution)
    for idx in "${TESTABLE_INDICES[@]}"; do
        RESULT_STATUS[$idx]="passed"
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    done
fi

# ============================================================================
# PARSE COVERAGE REPORTS
# ============================================================================

info "========================================"
info "  Parsing Coverage Reports"
info "========================================"
echo ""

# We'll collect all class data into a temp file for later processing
ALL_CLASSES_FILE="${TMPDIR:-/tmp}/coverage-classes-$$.tsv"
MODULE_SUMMARIES_FILE="${TMPDIR:-/tmp}/coverage-summaries-$$.tsv"
: > "$ALL_CLASSES_FILE"
: > "$MODULE_SUMMARIES_FILE"

for mi in "${!MOD_NAMES[@]}"; do
    mod_name="${MOD_NAMES[$mi]}"
    mod_path="${MOD_PATHS[$mi]}"

    # Resolve coverage tool for this module
    mod_tool="${MOD_COV_TOOL[$mi]:-}"
    if [[ -z "$mod_tool" || "$mod_tool" == "none" ]]; then
        # Try auto-detect if MOD_COV_TOOL wasn't set (e.g. skip-tests mode)
        if [[ "$COVERAGE_TOOL" == "auto" ]]; then
            build_file="${MOD_PATHS[$mi]}/build.gradle.kts"
            mod_tool="$(detect_coverage_tool "$build_file")"
        elif [[ "$COVERAGE_TOOL" != "none" ]]; then
            mod_tool="$COVERAGE_TOOL"
        else
            continue
        fi
    fi

    xml_path=""
    xml_path="$(get_coverage_xml_path "$mod_tool" "$mod_path" "$IS_DESKTOP")" || true

    if [[ -z "$xml_path" ]]; then
        color_print "$DARK_YELLOW" "  [!] No coverage data: $mod_name"
        continue
    fi

    gray "  [>] Parsing: $mod_name"

    # Parse and append to classes file
    parse_output="$(parse_coverage_report "$xml_path" "$mod_name")" || true
    if [[ -n "$parse_output" ]]; then
        echo "$parse_output" >> "$ALL_CLASSES_FILE"

        # Calculate module summary
        total_covered=0
        total_missed=0
        while IFS='|' read -r _mod _pkg _sf _cls covered missed _total _pct _ml; do
            total_covered=$((total_covered + covered))
            total_missed=$((total_missed + missed))
        done <<< "$parse_output"

        total_lines=$((total_covered + total_missed))
        if [[ "$total_lines" -gt 0 ]]; then
            mod_coverage="$(python3 -c "print(round(($total_covered / $total_lines) * 100, 1))")"
        else
            mod_coverage="0"
        fi

        echo "${mod_name}|${total_covered}|${total_missed}|${total_lines}|${mod_coverage}" >> "$MODULE_SUMMARIES_FILE"

        # Update result coverage
        RESULT_COVERAGE[$mi]="$mod_coverage"
    fi
done

# Filter by MinMissedLines
if [[ "$MIN_MISSED_LINES" -gt 0 ]]; then
    FILTERED_CLASSES="${TMPDIR:-/tmp}/coverage-filtered-$$.tsv"
    while IFS='|' read -r mod pkg sf cls covered missed total pct ml; do
        if [[ "$missed" -ge "$MIN_MISSED_LINES" ]]; then
            echo "${mod}|${pkg}|${sf}|${cls}|${covered}|${missed}|${total}|${pct}|${ml}"
        fi
    done < "$ALL_CLASSES_FILE" > "$FILTERED_CLASSES"
    mv "$FILTERED_CLASSES" "$ALL_CLASSES_FILE"
fi

# Calculate grand totals
GRAND_COVERED=0
GRAND_MISSED=0
MODULES_SCANNED=0
while IFS='|' read -r _name covered missed _total _pct; do
    GRAND_COVERED=$((GRAND_COVERED + covered))
    GRAND_MISSED=$((GRAND_MISSED + missed))
    MODULES_SCANNED=$((MODULES_SCANNED + 1))
done < "$MODULE_SUMMARIES_FILE"

GRAND_TOTAL=$((GRAND_COVERED + GRAND_MISSED))
if [[ "$GRAND_TOTAL" -gt 0 ]]; then
    GRAND_COVERAGE="$(python3 -c "print(round(($GRAND_COVERED / $GRAND_TOTAL) * 100, 1))")"
else
    GRAND_COVERAGE="0"
fi

CLASSES_ANALYZED="$(wc -l < "$ALL_CLASSES_FILE" 2>/dev/null || echo 0)"
CLASSES_ANALYZED="${CLASSES_ANALYZED// /}"

# ============================================================================
# GENERATE MARKDOWN REPORT
# ============================================================================

PROJECTS_LIST=""
for pn in "${PROJ_NAMES[@]}"; do
    if [[ -n "$PROJECTS_LIST" ]]; then PROJECTS_LIST="$PROJECTS_LIST, "; fi
    PROJECTS_LIST="$PROJECTS_LIST$pn"
done

TOTAL_END_TIME="$(date +%s)"
TOTAL_DURATION=$((TOTAL_END_TIME - START_TIME))
TOTAL_MINS=$((TOTAL_DURATION / 60))
TOTAL_SECS=$((TOTAL_DURATION % 60))

SKIP_TESTS_LABEL="Yes (parallel)"
if $SKIP_TESTS; then SKIP_TESTS_LABEL="No (--skip-tests)"; fi

REPORT_FILE="$PROJECT_ROOT/$OUTPUT_FILE"

{
cat <<HEADER
# Full Coverage Report

> **Generated**: $(date "+%Y-%m-%d %H:%M:%S")
> **Projects**: $PROJECTS_LIST
> **Platform**: $PLATFORM_NAME
> **Tests Run**: $SKIP_TESTS_LABEL
> **Coverage Tool**: $(get_coverage_display_name "$COVERAGE_TOOL")
> **Duration**: ${TOTAL_MINS}m ${TOTAL_SECS}s
> **Mode**: Parallel (single Gradle invocation)

---

## Summary by Module

| Module | Coverage | Covered | Total | Missed |
|--------|----------|---------|-------|--------|
HEADER

# Module summary rows
while IFS='|' read -r name covered missed total pct; do
    echo "| \`$name\` | ${pct}% | $covered | $total | $missed |"
done < <(sort "$MODULE_SUMMARIES_FILE")

echo "| **TOTAL** | **${GRAND_COVERAGE}%** | **$GRAND_COVERED** | **$GRAND_TOTAL** | **$GRAND_MISSED** |"

cat <<AISECTION

---

## AI-Optimized Summary

\`\`\`
TOTAL_COVERAGE: ${GRAND_COVERAGE}%
TOTAL_LINES: $GRAND_TOTAL
COVERED_LINES: $GRAND_COVERED
MISSED_LINES: $GRAND_MISSED
MODULES_SCANNED: $MODULES_SCANNED
CLASSES_ANALYZED: $CLASSES_ANALYZED
COVERAGE_TOOL: $COVERAGE_TOOL
EXECUTION_MODE: parallel
DURATION: ${TOTAL_MINS}m ${TOTAL_SECS}s
\`\`\`

---

## Detailed Class Coverage

AISECTION

# Group classes by module
CURRENT_MODULE=""
while IFS='|' read -r mod pkg sf cls covered missed total pct ml; do
    if [[ "$mod" != "$CURRENT_MODULE" ]]; then
        if [[ -n "$CURRENT_MODULE" ]]; then echo ""; fi
        echo "### $mod"
        echo ""
        echo "| Class | Coverage | Missed | Lines |"
        echo "|-------|----------|--------|-------|"
        CURRENT_MODULE="$mod"
    fi
    line_ranges="$(format_line_ranges "$ml")"
    if [[ "${#line_ranges}" -gt 60 ]]; then
        line_ranges="${line_ranges:0:57}..."
    fi
    echo "| \`$cls\` | ${pct}% | $missed | $line_ranges |"
done < <(sort -t'|' -k1,1 -k6,6rn "$ALL_CLASSES_FILE")

cat <<FOOTER

---

*Generated by run-parallel-coverage-suite.sh (parallel mode)*
FOOTER

} > "$REPORT_FILE"

# ============================================================================
# CONSOLE SUMMARY
# ============================================================================

echo ""
ok "[OK] Full coverage report generated!"
info "[>>] Report saved to: $REPORT_FILE"
echo ""

if ! $SKIP_TESTS; then
    white "Tests: $MODULE_COUNT total | $SUCCESS_COUNT passed | $FAILURE_COUNT failed | $SKIPPED_COUNT skipped"
    echo ""
fi

# Module coverage table
echo ""
info "$(printf '=%.0s' {1..70})"
info "  MODULE COVERAGE SUMMARY"
info "$(printf '=%.0s' {1..70})"
echo ""

printf_color "$WHITE" "%-48s %10s %8s\n" "MODULE" "COVERAGE" "MISSED"
gray "$(printf -- '-%.0s' {1..70})"

# Print main modules
while IFS='|' read -r name covered missed total pct; do
    # Skip shared-kmp-libs modules (print them separately below)
    if [[ "$name" == shared-kmp-libs:* ]]; then continue; fi
    display_name="$name"
    if [[ "${#display_name}" -gt 46 ]]; then
        display_name="${display_name:0:43}..."
    fi
    cov_str="${pct}%"
    color="$GREEN"
    pct_int="${pct%%.*}"
    if [[ "$pct_int" -lt 50 ]]; then color="$RED"
    elif [[ "$pct_int" -lt 80 ]]; then color="$YELLOW"; fi
    printf_color "$color" "%-48s %10s %8s\n" "$display_name" "$cov_str" "$missed"
done < <(sort "$MODULE_SUMMARIES_FILE")

# Print shared-kmp-libs modules
HAS_SHARED=false
while IFS='|' read -r name covered missed total pct; do
    if [[ "$name" != shared-kmp-libs:* ]]; then continue; fi
    if ! $HAS_SHARED; then
        gray "$(printf -- '-%.0s' {1..70})"
        HAS_SHARED=true
    fi
    display_name="$name"
    if [[ "${#display_name}" -gt 46 ]]; then
        display_name="${display_name:0:43}..."
    fi
    cov_str="${pct}%"
    color="$GREEN"
    pct_int="${pct%%.*}"
    if [[ "$pct_int" -lt 50 ]]; then color="$RED"
    elif [[ "$pct_int" -lt 80 ]]; then color="$YELLOW"; fi
    printf_color "$color" "%-48s %10s %8s\n" "$display_name" "$cov_str" "$missed"
done < <(sort "$MODULE_SUMMARIES_FILE")

info "$(printf '=%.0s' {1..70})"

# Grand total line
GRAND_COV_COLOR="$RED"
GRAND_PCT_INT="${GRAND_COVERAGE%%.*}"
if [[ "$GRAND_PCT_INT" -ge 80 ]]; then GRAND_COV_COLOR="$GREEN"
elif [[ "$GRAND_PCT_INT" -ge 60 ]]; then GRAND_COV_COLOR="$YELLOW"; fi

printf_color "$GRAND_COV_COLOR" "%-48s %10s %8s\n" "TOTAL" "${GRAND_COVERAGE}%" "$GRAND_MISSED"
echo ""

# ============================================================================
# COVERAGE GAPS
# ============================================================================

# Check if there are classes with gaps
GAPS_EXIST=false
while IFS='|' read -r _mod _pkg _sf _cls _covered missed _total _pct _ml; do
    if [[ "$missed" -gt 0 ]]; then GAPS_EXIST=true; break; fi
done < "$ALL_CLASSES_FILE"

if $GAPS_EXIST; then
    echo ""
    warn "$(printf '=%.0s' {1..80})"
    warn "  COVERAGE GAPS - CLASSES TO FIX"
    warn "$(printf '=%.0s' {1..80})"

    # Pre-load module summaries into temp file for grep-based lookup (Bash 3.2 compat)
    mod_summary_lookup="${TMPDIR:-/tmp}/mod_summary_lookup_$$.txt"
    while IFS='|' read -r sname scov smissed stotal spct; do
        echo "${sname}|${spct}|${smissed}" >> "$mod_summary_lookup"
    done < "$MODULE_SUMMARIES_FILE"

    CURRENT_GAP_MODULE=""
    while IFS='|' read -r mod pkg sf cls covered missed total pct ml; do
        if [[ "$missed" -le 0 ]]; then continue; fi

        if [[ "$mod" != "$CURRENT_GAP_MODULE" ]]; then
            # Get module summary from file-based lookup
            lookup_line="$(grep "^${mod}|" "$mod_summary_lookup" 2>/dev/null | head -1 || true)"
            mod_pct="$(echo "$lookup_line" | cut -d'|' -f2)"
            mod_missed="$(echo "$lookup_line" | cut -d'|' -f3)"

            is_ui=""
            if [[ "$mod" =~ designsystem|screen|feature: ]]; then
                is_ui=" [UI CODE]"
            fi

            echo ""
            warn "$mod (${mod_pct}% - ${mod_missed} lines missed)${is_ui}"
            gray "$(printf -- '-%.0s' {1..80})"
            CURRENT_GAP_MODULE="$mod"
        fi

        class_display="$cls"
        if [[ "${#class_display}" -gt 42 ]]; then
            class_display="${class_display:0:39}..."
        fi
        cov_str="${pct}%"
        lines_str="$(format_line_ranges "$ml")"
        if [[ "$missed" -gt 10 && "${#lines_str}" -gt 30 ]]; then
            lines_str="${missed} lines - ${lines_str:0:20}..."
        elif [[ "${#lines_str}" -gt 35 ]]; then
            lines_str="${lines_str:0:32}..."
        fi

        color="$WHITE"
        pct_int="${pct%%.*}"
        if [[ "$pct_int" -lt 50 ]]; then color="$RED"
        elif [[ "$pct_int" -lt 80 ]]; then color="$YELLOW"; fi

        printf_color "$color" "  %-44s %6s  %s\n" "$class_display" "$cov_str" "$lines_str"
    done < <(sort -t'|' -k1,1 -k6,6rn "$ALL_CLASSES_FILE")

    echo ""
    info "$(printf '=%.0s' {1..80})"
fi

# Final summary
MODULES_AT_100=0
while IFS='|' read -r _name _covered _missed _total pct; do
    if [[ "$pct" == "100.0" || "$pct" == "100" ]]; then
        MODULES_AT_100=$((MODULES_AT_100 + 1))
    fi
done < "$MODULE_SUMMARIES_FILE"

FINAL_END="$(date +%s)"
FINAL_DUR=$((FINAL_END - START_TIME))
FINAL_MINS=$((FINAL_DUR / 60))
FINAL_SECS=$((FINAL_DUR % 60))

printf_color "$GRAND_COV_COLOR" "SUMMARY: ${GRAND_COVERAGE}%% total | ${GRAND_MISSED} lines missed | ${MODULES_AT_100} modules at 100%% | ${FINAL_MINS}m ${FINAL_SECS}s\n"
info "$(printf '=%.0s' {1..80})"
echo ""

# Clean up temp files
rm -f "$ALL_CLASSES_FILE" "$MODULE_SUMMARIES_FILE" 2>/dev/null || true

# Detekt violation count — parse XML if present (zero extra Gradle invocations)
DETEKT_VIOLATIONS=0
DETEKT_RULES_FIRED=0
for detekt_xml in "$PROJECT_ROOT"/build/reports/detekt/detekt.xml \
                  "$PROJECT_ROOT"/*/build/reports/detekt/detekt.xml; do
    if [[ -f "$detekt_xml" ]]; then
        count=$(python3 -c "
import xml.etree.ElementTree as ET, sys
try:
    root = ET.parse('$detekt_xml').getroot()
    errors = root.findall('.//error')
    rules = {e.get('source','') for e in errors}
    print(len(errors), len(rules))
except:
    print('0 0')
" 2>/dev/null)
        v=$(echo "$count" | awk '{print $1}')
        r=$(echo "$count" | awk '{print $2}')
        DETEKT_VIOLATIONS=$((DETEKT_VIOLATIONS + ${v:-0}))
        DETEKT_RULES_FIRED=$((DETEKT_RULES_FIRED > ${r:-0} ? DETEKT_RULES_FIRED : ${r:-0}))
    fi
done

# Append audit record — 1 line, no agent reads this
TESTABLE_COUNT="${TESTABLE_COUNT:-$MODULE_COUNT}"
if [[ "$FAILURE_COUNT" -gt 0 ]]; then
    _audit_result="fail"
elif [[ "$GRAND_COVERAGE" != "" && "${GRAND_COVERAGE%%.*}" -lt 60 ]]; then
    _audit_result="warn"
else
    _audit_result="pass"
fi
_extra='"coverage_pct":'"${GRAND_COVERAGE:-0}"',"modules_total":'"${TESTABLE_COUNT:-0}"',"modules_passed":'"${SUCCESS_COUNT:-0}"',"modules_at_100":'"${MODULES_AT_100:-0}"',"missed_lines":'"${GRAND_MISSED:-0}"',"duration_s":'"${FINAL_DUR:-0}"',"detekt_violations":'"${DETEKT_VIOLATIONS}"',"detekt_rules_fired":'"${DETEKT_RULES_FIRED}"
audit_append "$PROJECT_ROOT" "coverage" "$_audit_result" "$_extra"

# ---------------------------------------------------------------------------
# OPTIONAL BENCHMARK EXECUTION
# ---------------------------------------------------------------------------
if ${BENCHMARK:-false}; then
    echo ""
    info "[>] Running benchmarks (config: ${BENCHMARK_CONFIG:-smoke})..."
    BENCH_ARGS="--project-root $PROJECT_ROOT --config ${BENCHMARK_CONFIG:-smoke}"
    if $INCLUDE_SHARED; then BENCH_ARGS="$BENCH_ARGS --include-shared"; fi
    "$SCRIPT_DIR/run-benchmarks.sh" $BENCH_ARGS || warn "[!] Benchmark execution had failures"
fi

# Exit code
if [[ "$FAILURE_COUNT" -gt 0 ]]; then
    err "BUILD FAILED - $FAILURE_COUNT module(s) failed"
    exit 1
else
    ok "BUILD SUCCESSFUL"
    exit 0
fi

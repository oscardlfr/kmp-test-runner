#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Run benchmark suites across JVM Desktop and Android platforms.
#
# Discovers benchmark modules, executes kotlinx-benchmark / androidx.benchmark
# tasks via Gradle, parses JSON results, and produces a markdown report.
#
# Supports main project and sibling shared-libs benchmark modules (via SHARED_PROJECT_NAME).
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
CONFIG="smoke"
PLATFORM="all"
MODULE_FILTER="*"
INCLUDE_SHARED=false
TEST_FILTER=""

# ---------------------------------------------------------------------------
# USAGE
# ---------------------------------------------------------------------------
usage() {
    cat <<'USAGE'
Usage: run-benchmarks.sh --project-root <path> [OPTIONS]

Required:
  --project-root <path>       Path to the project root.

Options:
  --config <name>             Benchmark config: smoke (default) | main | stress
  --platform <name>           Platform: all (default) | jvm | android
  --module-filter <pattern>   Filter modules (wildcards/comma-separated). Default: *
  --include-shared            Include sibling shared-libs benchmark modules (requires SHARED_PROJECT_NAME).
  --test-filter <pattern>     Filter to a single benchmark class. JVM uses gradle --tests
                              (globs OK); Android uses
                              -Pandroid.testInstrumentationRunnerArguments.class=<FQN>
                              (wildcards not supported by the runner — pass a literal FQN;
                              kmp-test CLI resolves *Pattern* globs to FQNs upstream).
  -h, --help                  Show this help.
USAGE
    exit "${1:-0}"
}

# ---------------------------------------------------------------------------
# ARGUMENT PARSING
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --project-root)       PROJECT_ROOT="$2"; shift 2 ;;
        --config)             CONFIG="$2"; shift 2 ;;
        --platform)           PLATFORM="$2"; shift 2 ;;
        --module-filter)      MODULE_FILTER="$2"; shift 2 ;;
        --include-shared)     INCLUDE_SHARED=true; shift ;;
        --test-filter)        TEST_FILTER="$2"; shift 2 ;;
        -h|--help)            usage ;;
        *) err "[ERROR] Unknown option: $1"; exit 1 ;;
    esac
done

if [[ -z "$PROJECT_ROOT" ]]; then
    err "[ERROR] --project-root is required."
    usage 1
fi

if [[ ! -d "$PROJECT_ROOT" ]]; then
    err "[ERROR] Project root does not exist: $PROJECT_ROOT"
    exit 1
fi

# Validate config
case "$CONFIG" in
    smoke|main|stress) ;;
    *) err "[ERROR] Invalid config: $CONFIG. Must be smoke, main, or stress."; exit 1 ;;
esac

# Validate platform
case "$PLATFORM" in
    all|jvm|android) ;;
    *) err "[ERROR] Invalid platform: $PLATFORM. Must be all, jvm, or android."; exit 1 ;;
esac

# ---------------------------------------------------------------------------
# SOURCE LIBRARIES
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/benchmark-detect.sh"
source "$SCRIPT_DIR/lib/script-utils.sh"

# ---------------------------------------------------------------------------
# PLATFORM DETECTION
# ---------------------------------------------------------------------------
echo ""
info "$(printf '=%.0s' {1..70})"
info "  BENCHMARK RUNNER ($CONFIG)"
info "$(printf '=%.0s' {1..70})"
echo ""

JVM_AVAILABLE=false
JVM_VERSION=""
JVM_CORES=""
ANDROID_AVAILABLE=false
ANDROID_DEVICE_COUNT=0
ANDROID_DEVICES_SUMMARY=""

# Detect JVM if needed
if [[ "$PLATFORM" == "all" ]] || [[ "$PLATFORM" == "jvm" ]]; then
    JVM_INFO=$(detect_jvm_info)
    if [[ -n "$JVM_INFO" ]]; then
        JVM_AVAILABLE=true
        JVM_VERSION="${JVM_INFO%%|*}"
        JVM_CORES="${JVM_INFO##*|}"
    fi
fi

# Detect Android if needed
if [[ "$PLATFORM" == "all" ]] || [[ "$PLATFORM" == "android" ]]; then
    ANDROID_DEVICES=()
    while IFS= read -r line; do
        [[ -n "$line" ]] && ANDROID_DEVICES+=("$line")
    done < <(detect_android_devices)
    ANDROID_DEVICE_COUNT=${#ANDROID_DEVICES[@]}
    if [[ $ANDROID_DEVICE_COUNT -gt 0 ]]; then
        ANDROID_AVAILABLE=true
        # Build summary string: model (type) for each device
        local_summaries=()
        for dev in "${ANDROID_DEVICES[@]}"; do
            # shellcheck disable=SC2034
            IFS='|' read -r serial dtype model api <<< "$dev"
            local_summaries+=("${model} (${dtype})")
        done
        ANDROID_DEVICES_SUMMARY=$(IFS=', '; echo "${local_summaries[*]}")
    fi
fi

# Print platform availability
echo ""
white "AVAILABLE PLATFORMS:"
if $JVM_AVAILABLE; then
    ok "  [OK] JVM Desktop — Java ${JVM_VERSION}, ${JVM_CORES} cores"
else
    gray "  [--] JVM Desktop — not available"
fi
if $ANDROID_AVAILABLE; then
    ok "  [OK] Android — ${ANDROID_DEVICES_SUMMARY}"
else
    gray "  [--] Android — no devices connected"
fi
gray "  [--] macOS Native — not yet supported"
gray "  [--] iOS Simulator — not yet supported"
echo ""

# Fail if requested platform is unavailable
if [[ "$PLATFORM" == "jvm" ]] && ! $JVM_AVAILABLE; then
    err "[ERROR] JVM platform requested but Java is not available."
    exit 1
fi
if [[ "$PLATFORM" == "android" ]] && ! $ANDROID_AVAILABLE; then
    err "[ERROR] Android platform requested but no devices found."
    exit 1
fi

# ---------------------------------------------------------------------------
# MODULE DISCOVERY
# ---------------------------------------------------------------------------
info "[>>] Discovering benchmark modules..."

BENCHMARK_MODULES=()
while IFS= read -r mod; do
    [[ -n "$mod" ]] && BENCHMARK_MODULES+=("$mod")
done < <(detect_benchmark_modules "$PROJECT_ROOT" "$MODULE_FILTER")

# Include shared project modules if requested
SHARED_PROJECT_NAME="${SHARED_PROJECT_NAME:-}"
SHARED_ROOT="${SHARED_ROOT:-}"
if $INCLUDE_SHARED; then
    if [[ -z "$SHARED_PROJECT_NAME" && -z "$SHARED_ROOT" ]]; then
        warn "[!] --include-shared requires SHARED_PROJECT_NAME or SHARED_ROOT env var"
    else
        if [[ -n "$SHARED_ROOT" ]]; then
            _shared_dir="$SHARED_ROOT"
            _shared_name="${SHARED_PROJECT_NAME:-$(basename "$SHARED_ROOT")}"
        else
            _shared_dir="$(dirname "$PROJECT_ROOT")/$SHARED_PROJECT_NAME"
            _shared_name="$SHARED_PROJECT_NAME"
        fi
        if [[ -d "$_shared_dir" ]]; then
            while IFS= read -r mod; do
                [[ -n "$mod" ]] && BENCHMARK_MODULES+=("${_shared_name}:$mod")
            done < <(detect_benchmark_modules "$_shared_dir" "$MODULE_FILTER")
        fi
    fi
fi

if [[ ${#BENCHMARK_MODULES[@]} -eq 0 ]]; then
    warn "[WARN] No benchmark modules found. Nothing to run."
    exit 0
fi

info "[OK] Found ${#BENCHMARK_MODULES[@]} benchmark module(s):"
for mod in "${BENCHMARK_MODULES[@]}"; do
    gray "     - $mod"
done
echo ""

# ---------------------------------------------------------------------------
# TASK EXECUTION
# ---------------------------------------------------------------------------
info "[>>] Running benchmarks (config=$CONFIG, platform=$PLATFORM)..."
echo ""

# shellcheck disable=SC2034
declare -A MODULE_STATUS
TOTAL_PASS=0
TOTAL_FAIL=0

# Build the list of platform targets to run
PLATFORMS_TO_RUN=()
if [[ "$PLATFORM" == "all" ]]; then
    $JVM_AVAILABLE && PLATFORMS_TO_RUN+=("jvm")
    $ANDROID_AVAILABLE && PLATFORMS_TO_RUN+=("android")
elif [[ "$PLATFORM" == "jvm" ]]; then
    PLATFORMS_TO_RUN+=("jvm")
elif [[ "$PLATFORM" == "android" ]]; then
    PLATFORMS_TO_RUN+=("android")
fi

SKIPPED_INCOMPAT=0
for mod in "${BENCHMARK_MODULES[@]}"; do
    for plat in "${PLATFORMS_TO_RUN[@]}"; do
        # Resolve the actual module name and project root for this module
        actual_mod="$mod"
        gradle_root="$PROJECT_ROOT"
        shared_prefix="$SHARED_PROJECT_NAME"
        if [[ "$mod" == ${shared_prefix}:* ]]; then
            actual_mod="${mod#"${shared_prefix}":}"
            gradle_root="$SHARED_ROOT"
        fi

        # Skip modules that don't support the requested platform.
        # Avoids invoking non-existent Gradle tasks (e.g. :module:desktopSmokeBenchmark
        # on an androidx.benchmark-only module) which would fail with TaskSelectionException
        # after a long Gradle configuration phase.
        if ! module_supports_platform "$gradle_root" "$actual_mod" "$plat"; then
            warn "  [SKIP] $mod ($plat) — module does not declare $plat benchmark capability"
            SKIPPED_INCOMPAT=$((SKIPPED_INCOMPAT + 1))
            continue
        fi

        task=$(get_benchmark_gradle_task "$actual_mod" "$plat" "$CONFIG")
        # Per-platform translation of --test-filter so a glob like *ScaleBenchmark*
        # produces gradle --tests for jvm and -Pandroid.test...class= for android.
        gradle_filter_args=()
        if [[ -n "$TEST_FILTER" ]]; then
            if [[ "$plat" == "jvm" ]]; then
                gradle_filter_args+=("--tests" "$TEST_FILTER")
            else
                gradle_filter_args+=("-Pandroid.testInstrumentationRunnerArguments.class=$TEST_FILTER")
            fi
        fi
        info "  [>>] $mod ($plat) -> $task ${gradle_filter_args[*]:-}"

        set +e
        (cd "$gradle_root" && ./gradlew "$task" "${gradle_filter_args[@]+"${gradle_filter_args[@]}"}" --continue 2>&1) | while IFS= read -r line; do
            gray "       $line"
        done
        exit_code=${PIPESTATUS[0]}
        set -e

        key="${mod}|${plat}"
        if [[ $exit_code -eq 0 ]]; then
            MODULE_STATUS["$key"]="pass"
            TOTAL_PASS=$((TOTAL_PASS + 1))
            ok "  [OK] $mod ($plat) completed successfully."
        else
            MODULE_STATUS["$key"]="fail"
            TOTAL_FAIL=$((TOTAL_FAIL + 1))
            err "  [FAIL] $mod ($plat) failed with exit code $exit_code."
        fi
        echo ""
    done
done

# All combinations skipped → tell user clearly instead of silently "succeeding"
TOTAL_ATTEMPTED=$((TOTAL_PASS + TOTAL_FAIL))
if [[ $TOTAL_ATTEMPTED -eq 0 ]] && [[ $SKIPPED_INCOMPAT -gt 0 ]]; then
    err "[ERROR] No benchmark module supports platform '$PLATFORM'."
    err "        $SKIPPED_INCOMPAT module/platform combination(s) were skipped due to missing benchmark capability."
    err "        Hint: try --platform all, or check that the module's build.gradle.kts declares the expected"
    err "              benchmark plugin (kotlinx.benchmark for jvm, androidx.benchmark for android)."
    exit 3
fi

# ---------------------------------------------------------------------------
# JSON RESULT PARSING
# ---------------------------------------------------------------------------
info "[>>] Parsing benchmark results..."
echo ""

# Collect all benchmark results: "module|benchmark_name|mode|score|error|units"
ALL_RESULTS=()
declare -A MODULE_BENCHMARK_COUNT
declare -A MODULE_AVG_SCORE

for mod in "${BENCHMARK_MODULES[@]}"; do
    actual_mod="$mod"
    gradle_root="$PROJECT_ROOT"
    shared_prefix="${SHARED_LIBS_PREFIX:-${SHARED_PROJECT_NAME:-}}"
    if [[ "$mod" == ${shared_prefix}:* ]]; then
        actual_mod="${mod#"${shared_prefix}":}"
        gradle_root="$SHARED_ROOT"
    fi

    module_dir="$gradle_root/${actual_mod//://}"
    report_dir="$module_dir/build/reports/benchmarks/desktop/${CONFIG}"

    count=0
    total_score=0

    if [[ -d "$report_dir" ]]; then
        while IFS= read -r json_file; do
            [[ -z "$json_file" ]] && continue
            while IFS= read -r result_line; do
                [[ -z "$result_line" ]] && continue
                ALL_RESULTS+=("${mod}|${result_line}")
                # Extract score for averaging
                IFS='|' read -r _bench _mode score _err _units <<< "$result_line"
                if [[ -n "$score" ]]; then
                    total_score=$(echo "$total_score + $score" | bc 2>/dev/null || echo "$total_score")
                    count=$((count + 1))
                fi
            done < <(parse_benchmark_json "$json_file")
        done < <(find "$report_dir" -name "*.json" -type f 2>/dev/null)
    fi

    MODULE_BENCHMARK_COUNT["$mod"]=$count
    if [[ $count -gt 0 ]]; then
        MODULE_AVG_SCORE["$mod"]=$(echo "scale=1; $total_score / $count" | bc 2>/dev/null || echo "N/A")
    else
        MODULE_AVG_SCORE["$mod"]="N/A"
    fi
done

# ---------------------------------------------------------------------------
# CONSOLE SUMMARY
# ---------------------------------------------------------------------------
echo ""
info "$(printf '=%.0s' {1..70})"
info "  BENCHMARK SUMMARY ($CONFIG)"
info "$(printf '=%.0s' {1..70})"
echo ""

white "AVAILABLE PLATFORMS:"
if $JVM_AVAILABLE; then
    ok "  [OK] JVM Desktop — Java ${JVM_VERSION}, ${JVM_CORES} cores"
else
    gray "  [--] JVM Desktop — not available"
fi
if $ANDROID_AVAILABLE; then
    ok "  [OK] Android — ${ANDROID_DEVICE_COUNT} device(s)"
else
    gray "  [--] Android — no devices connected"
fi
gray "  [--] macOS Native — not yet supported"
gray "  [--] iOS Simulator — not yet supported"
echo ""

printf "${WHITE}%-48s %12s %10s${RESET}\n" "MODULE" "BENCHMARKS" "AVG TIME"
gray "$(printf -- '-%.0s' {1..70})"

for mod in "${BENCHMARK_MODULES[@]}"; do
    count="${MODULE_BENCHMARK_COUNT[$mod]:-0}"
    avg="${MODULE_AVG_SCORE[$mod]:-N/A}"

    # Determine units suffix
    units_suffix="ms"
    if [[ "$avg" != "N/A" ]]; then
        avg_display="${avg} ${units_suffix}"
    else
        avg_display="N/A"
    fi

    printf "${WHITE}%-48s %12s %10s${RESET}\n" "$mod" "$count" "$avg_display"

    # Print individual benchmarks for this module
    for result in "${ALL_RESULTS[@]}"; do
        IFS='|' read -r r_mod r_bench r_mode r_score r_error r_units <<< "$result"
        if [[ "$r_mod" == "$mod" ]]; then
            # Shorten benchmark name: strip class prefix, keep method
            short_name="$r_bench"
            if [[ "$r_bench" == *.* ]]; then
                short_name="${r_bench##*.}"
                class_name="${r_bench%.*}"
                class_name="${class_name##*.}"
                short_name="${class_name}.${short_name}"
            fi
            if [[ "${#short_name}" -gt 44 ]]; then
                short_name="${short_name:0:41}..."
            fi
            score_display="${r_score:-N/A}"
            if [[ -n "$r_units" ]]; then
                score_display="${score_display} ${r_units}"
            fi
            gray "$(printf '  %-46s %22s' "$short_name" "$score_display")"
        fi
    done
done

info "$(printf '=%.0s' {1..70})"
echo ""

if [[ $TOTAL_FAIL -gt 0 ]]; then
    err "Result: ${TOTAL_PASS} passed, ${TOTAL_FAIL} failed"
else
    ok "Result: ${TOTAL_PASS} passed, ${TOTAL_FAIL} failed"
fi
echo ""

# ---------------------------------------------------------------------------
# MARKDOWN REPORT
# ---------------------------------------------------------------------------
REPORT_FILE="$PROJECT_ROOT/benchmark-report.md"
REPORT_DATE=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

{
    echo "# Benchmark Report"
    echo ""
    echo "**Config:** ${CONFIG}  "
    echo "**Date:** ${REPORT_DATE}  "
    echo "**Platform:** ${PLATFORM}  "
    echo ""
    echo "## Platform Availability"
    echo ""
    echo "| Platform | Status | Details |"
    echo "|----------|--------|---------|"
    if $JVM_AVAILABLE; then
        echo "| JVM Desktop | Available | Java ${JVM_VERSION}, ${JVM_CORES} cores |"
    else
        echo "| JVM Desktop | Unavailable | — |"
    fi
    if $ANDROID_AVAILABLE; then
        echo "| Android | Available | ${ANDROID_DEVICE_COUNT} device(s) |"
    else
        echo "| Android | Unavailable | — |"
    fi
    echo "| macOS Native | Not yet supported | — |"
    echo "| iOS Simulator | Not yet supported | — |"
    echo ""
    echo "## Results"
    echo ""
    echo "| Module | Benchmark | Mode | Score | Error | Units |"
    echo "|--------|-----------|------|------:|------:|-------|"

    if [[ ${#ALL_RESULTS[@]} -gt 0 ]]; then
        for result in "${ALL_RESULTS[@]}"; do
            IFS='|' read -r r_mod r_bench r_mode r_score r_error r_units <<< "$result"
            echo "| ${r_mod} | ${r_bench} | ${r_mode} | ${r_score} | ${r_error} | ${r_units} |"
        done
    else
        echo "| — | No benchmark results found | — | — | — | — |"
    fi

    echo ""
    echo "## Summary"
    echo ""
    echo "| Module | Benchmarks | Avg Score |"
    echo "|--------|----------:|----------:|"

    for mod in "${BENCHMARK_MODULES[@]}"; do
        count="${MODULE_BENCHMARK_COUNT[$mod]:-0}"
        avg="${MODULE_AVG_SCORE[$mod]:-N/A}"
        echo "| ${mod} | ${count} | ${avg} |"
    done

    echo ""
    echo "**Total:** ${TOTAL_PASS} passed, ${TOTAL_FAIL} failed  "
} > "$REPORT_FILE"

ok "[OK] Markdown report saved to: $REPORT_FILE"
echo ""

# ---------------------------------------------------------------------------
# EXIT CODE
# ---------------------------------------------------------------------------
if [[ $TOTAL_FAIL -gt 0 ]]; then
    exit 1
fi
exit 0

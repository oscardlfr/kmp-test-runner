#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Run tests only on modules with uncommitted git changes.
#
# Detects modules with uncommitted changes (staged, unstaged, or untracked)
# and runs tests only on those modules. Delegates to
# run-parallel-coverage-suite.sh for actual test execution.
#
# DETECTION LOGIC:
#   - Uses `git status --porcelain` to find changed files
#   - Maps file paths to Gradle modules
#   - Filters out modules without build.gradle.kts
#   - Optionally includes shared-kmp-libs changes
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
info()  { color_print "$CYAN"   "$1"; }
ok()    { color_print "$GREEN"  "$1"; }
warn()  { color_print "$YELLOW" "$1"; }
err()   { color_print "$RED"    "$1"; }
white() { color_print "$WHITE"  "$1"; }
gray()  { color_print "$GRAY"   "$1"; }

# ---------------------------------------------------------------------------
# DEFAULTS
# ---------------------------------------------------------------------------
PROJECT_ROOT=""
INCLUDE_SHARED=false
TEST_TYPE=""
STAGED_ONLY=false
SHOW_MODULES_ONLY=false
MAX_FAILURES=0
MIN_MISSED_LINES=0
COVERAGE_TOOL=""
EXCLUDE_COVERAGE=""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/script-utils.sh"

# ---------------------------------------------------------------------------
# USAGE
# ---------------------------------------------------------------------------
usage() {
    cat <<'USAGE'
Usage: run-changed-modules-tests.sh --project-root <path> [OPTIONS]

Required:
  --project-root <path>       Path to the project root.

Options:
  --include-shared            Include changes in shared-kmp-libs.
  --test-type <type>          all | common | androidUnit | androidInstrumented | desktop
  --staged-only               Only consider staged files (git add).
  --show-modules-only         Show detected modules without running tests (dry run).
  --max-failures <N>          Stop after N failures. 0 = run all. Default: 0
  --min-missed-lines <N>      Min missed lines for gaps report. Default: 0
  --coverage-tool <tool>      Coverage tool: jacoco | kover | auto | none. Default: jacoco
  --exclude-coverage <list>   Comma-separated modules to exclude from coverage.
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
        --staged-only)        STAGED_ONLY=true; shift ;;
        --show-modules-only)  SHOW_MODULES_ONLY=true; shift ;;
        --max-failures)       MAX_FAILURES="$2"; shift 2 ;;
        --min-missed-lines)   MIN_MISSED_LINES="$2"; shift 2 ;;
        --coverage-tool)      COVERAGE_TOOL="$2"; shift 2 ;;
        --exclude-coverage)   EXCLUDE_COVERAGE="$2"; shift 2 ;;
        -h|--help)            usage ;;
        *) err "[ERROR] Unknown option: $1"; exit 1 ;;
    esac
done

if [[ -z "$PROJECT_ROOT" ]]; then
    err "[ERROR] --project-root is required."
    usage
fi

# ============================================================================
# GIT CHANGE DETECTION
# ============================================================================

# get_changed_files and get_module_from_file are provided by lib/script-utils.sh

# Find all changed modules.
# Outputs unique module paths, one per line.
# Also stores file counts in a temp file for display.
find_changed_modules() {
    local project_path="$1"
    local staged_only="$2"
    local include_shared="$3"
    local counts_file="$4"

    # Use temp file instead of declare -A for Bash 3.2 compatibility
    local mod_counts_tmp
    mod_counts_tmp="$(mktemp)"

    while IFS= read -r file; do
        [[ -z "$file" ]] && continue
        local module
        module="$(get_module_from_file "$file" "$project_path")"
        if [[ -n "$module" ]]; then
            # Filter shared-kmp-libs if not included
            if [[ "$include_shared" != "true" ]] && echo "$module" | grep -q 'shared-kmp-libs'; then
                continue
            fi
            echo "$module" >> "$mod_counts_tmp"
        fi
    done < <(get_changed_files "$project_path" "$staged_only")

    # Output modules and counts
    sort -u "$mod_counts_tmp" | while IFS= read -r mod; do
        local count
        count="$(grep -cxF "$mod" "$mod_counts_tmp")"
        echo "${mod}|${count}" >> "$counts_file"
        echo "$mod"
    done
    rm -f "$mod_counts_tmp"
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

echo ""
info "========================================"
info "  Test Changed Modules"
info "========================================"
if $STAGED_ONLY; then
    white "Project: $PROJECT_ROOT"
    white "Mode: Staged only"
else
    white "Project: $PROJECT_ROOT"
    white "Mode: All changes"
fi
echo ""

# Validate project path
if [[ ! -d "$PROJECT_ROOT" ]]; then
    err "[ERROR] Project path does not exist: $PROJECT_ROOT"
    exit 1
fi

PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"

# Verify git repository
IS_GIT_REPO="$(cd "$PROJECT_ROOT" && git rev-parse --is-inside-work-tree 2>/dev/null || echo "false")"
if [[ "$IS_GIT_REPO" != "true" ]]; then
    err "ERROR: Not a git repository: $PROJECT_ROOT"
    exit 1
fi

# Find changed modules
COUNTS_FILE="${TMPDIR:-/tmp}/changed-module-counts-$$.txt"
: > "$COUNTS_FILE"

CHANGED_MODULES=()
while IFS= read -r mod; do
    [[ -z "$mod" ]] && continue
    CHANGED_MODULES+=("$mod")
done < <(find_changed_modules "$PROJECT_ROOT" "$STAGED_ONLY" "$INCLUDE_SHARED" "$COUNTS_FILE")

if [[ "${#CHANGED_MODULES[@]}" -eq 0 ]]; then
    warn "No modules with uncommitted changes detected."
    echo ""
    gray "Possible reasons:"
    gray "  - No changes in module source directories"
    gray "  - Changes only in non-module files (root scripts, etc.)"
    gray "  - Use --include-shared to include shared-kmp-libs changes"
    rm -f "$COUNTS_FILE" 2>/dev/null || true
    exit 0
fi

# Display detected modules
info "Modules with changes:"
for mod in "${CHANGED_MODULES[@]}"; do
    file_count=0
    while IFS='|' read -r cmod ccount; do
        if [[ "$cmod" == "$mod" ]]; then
            file_count="$ccount"
            break
        fi
    done < "$COUNTS_FILE"
    echo -e "  ${WHITE}${mod}${RESET} ${GRAY}(${file_count} files)${RESET}"
done
echo ""

rm -f "$COUNTS_FILE" 2>/dev/null || true

if $SHOW_MODULES_ONLY; then
    warn "Dry run - no tests executed."
    exit 0
fi

# Build module filter for run-parallel-coverage-suite.sh
# Convert ":core:domain" style to "core:domain" for the filter
MODULE_FILTER=""
for mod in "${CHANGED_MODULES[@]}"; do
    trimmed="${mod#:}"
    if [[ -n "$MODULE_FILTER" ]]; then
        MODULE_FILTER="$MODULE_FILTER,$trimmed"
    else
        MODULE_FILTER="$trimmed"
    fi
done

info "Running tests on: $MODULE_FILTER"
echo ""

# Build arguments for run-parallel-coverage-suite.sh
SUITE_ARGS=(
    --project-root "$PROJECT_ROOT"
    --module-filter "$MODULE_FILTER"
    --min-missed-lines "$MIN_MISSED_LINES"
)

if [[ -n "$TEST_TYPE" ]]; then
    SUITE_ARGS+=(--test-type "$TEST_TYPE")
fi

if $INCLUDE_SHARED; then
    SUITE_ARGS+=(--include-shared)
fi

if [[ -n "$COVERAGE_TOOL" ]]; then
    SUITE_ARGS+=(--coverage-tool "$COVERAGE_TOOL")
fi

if [[ -n "$EXCLUDE_COVERAGE" ]]; then
    SUITE_ARGS+=(--exclude-coverage "$EXCLUDE_COVERAGE")
fi

# Execute tests using the parallel coverage suite script
exec "$SCRIPT_DIR/run-parallel-coverage-suite.sh" "${SUITE_ARGS[@]}"

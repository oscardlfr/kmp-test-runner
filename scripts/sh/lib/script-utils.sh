#!/usr/bin/env bash
# =============================================================================
# script-utils.sh — Pure utility functions shared by coverage and test scripts.
#
# Source this file from any script that needs:
#   - glob_match: shell glob pattern matching
#   - get_project_type: KMP vs Android project detection
#   - test_class_excluded: Kotlin synthetic class exclusion (requires EXCLUSION_PATTERNS)
#   - format_line_ranges: compress line numbers into range strings
#   - get_module_from_file: map a file path to its Gradle module
#   - get_changed_files: list changed files in a git repo
#   - safe_rg: cross-platform ripgrep with find+grep fallback on Windows
#   - gate_gradle_exit_for_deprecation: classify a non-zero gradle exit
#
# All functions are pure — no global side effects, no exit calls.
# =============================================================================

# Classify a gradle process exit code by comparing it against per-task
# success / failure counters, and emit the matching message line(s) on stdout.
# Used by both the test-execution pass and the coverage-generation pass:
# gradle 9 deprecation warnings cause a non-zero exit even when every
# requested task succeeded individually, and we want the runner to treat
# that as a [NOTICE] (parsed into warnings[]) rather than a [!] failure.
#
# Usage (capture message, then color via caller's notice/warn helper):
#   gate_msg="$(gate_gradle_exit_for_deprecation "$EXIT" "$OK" "$FAIL" "$TOTAL" "tests")"
#   gate_rc=$?
#   case "$gate_rc" in
#       0) [[ -n "$gate_msg" ]] && notice "$gate_msg" ;;
#       1) warn "$gate_msg"; mark_all_failed ;;
#       2) ;;  # partial — per-module reporting already handles it
#   esac
#
# Returns:
#   0 = continue — exit was 0 (no message emitted), OR exit was nonzero but
#       every task succeeded (deprecation noise; emits a [NOTICE] line that
#       lib/cli.js maps to warnings[].code = "gradle_deprecation").
#   1 = env error — exit was nonzero AND zero tasks succeeded. Emits a [!]
#       line describing the JVM-level failure. Caller marks all modules failed.
#   2 = partial — exit was nonzero AND some succeeded AND some failed. No
#       message; caller's per-module FAILED reporting speaks for itself.
gate_gradle_exit_for_deprecation() {
    local exit_code="$1"
    local success_count="$2"
    local failure_count="$3"
    local total_count="$4"
    local context="${5:-gradle}"

    if [[ "$exit_code" -eq 0 ]]; then
        return 0
    fi

    if [[ "$failure_count" -eq 0 && "$success_count" -eq 0 ]]; then
        printf '%s\n' \
            "[!] Gradle ($context) exited with code $exit_code and no task results found." \
            "    This usually means a JVM-level error (wrong JAVA_HOME, OOM, daemon crash)."
        return 1
    fi

    if [[ "$failure_count" -eq 0 && "$success_count" -gt 0 ]]; then
        printf '%s\n' \
            "[NOTICE] Gradle ($context) exited with code $exit_code but all $success_count tasks passed individually." \
            "         This is likely deprecation warnings (Gradle 9+), not real failures."
        return 0
    fi

    return 2
}

# Check if a string matches a simple wildcard pattern (shell glob).
# Usage: glob_match "pattern" "string"
glob_match() {
    local pattern="$1" string="$2"
    # shellcheck disable=SC2254
    case "$string" in
        $pattern) return 0 ;;
        *) return 1 ;;
    esac
}

# Detect project type: "kmp-desktop" or "android".
# Usage: get_project_type <project_root>
get_project_type() {
    local root="$1"
    if [[ -d "$root/desktopApp" ]]; then echo "kmp-desktop"; return; fi
    local project_name
    project_name="$(basename "$root")"
    if echo "$project_name" | tr '[:upper:]' '[:lower:]' | grep -qE 'kmp|shared-kmp'; then
        echo "kmp-desktop"; return
    fi
    # Check build.gradle.kts files for multiplatform
    local found
    found="$(find "$root" -maxdepth 4 -name "build.gradle.kts" -not -path "*/build/*" -not -path "*/.gradle/*" 2>/dev/null | head -5)"
    local f
    for f in $found; do
        if head -30 "$f" 2>/dev/null | grep -q 'kotlin\.multiplatform' && \
           head -30 "$f" 2>/dev/null | grep -q 'jvm("desktop")'; then
            echo "kmp-desktop"; return
        fi
    done
    echo "android"
}

# Test if a class name matches any exclusion pattern.
# Requires EXCLUSION_PATTERNS array to be defined by the caller.
# Usage: test_class_excluded <class_name>
test_class_excluded() {
    local class_name="$1"
    local pattern
    for pattern in "${EXCLUSION_PATTERNS[@]}"; do
        if glob_match "$pattern" "$class_name"; then return 0; fi
    done
    return 1
}

# Check if a module contains any standard Kotlin/JVM/Android test source set.
# Returns 0 (true) when the model says it does OR when any of the 9 standard
# test directories exist on disk. Returns 1 (false) otherwise.
#
# Two call shapes are supported (we keep both for backwards compatibility):
#   module_has_test_sources <module_filesystem_path>            (legacy)
#   module_has_test_sources <project_root> <module_name>        (Phase 4)
#
# The two-arg form prefers the ProjectModel JSON via pm_module_has_tests
# (Phase 4 step 4 — single source of truth), falling back to the filesystem
# walk when the model is absent. The one-arg form skips the model lookup
# entirely (callers without a project_root context).
module_has_test_sources() {
    if [[ $# -ge 2 ]]; then
        local project_root="$1"
        local module_name="$2"
        # Try the model first (fast, cached, content-keyed). Source the readers
        # lazily so callers that haven't sourced project-model.sh keep working.
        if ! type pm_module_has_tests >/dev/null 2>&1; then
            local _pm_lib_dir
            _pm_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
            # shellcheck source=./project-model.sh
            [[ -f "$_pm_lib_dir/project-model.sh" ]] && source "$_pm_lib_dir/project-model.sh"
        fi
        if type pm_module_has_tests >/dev/null 2>&1; then
            local model_answer
            model_answer="$(pm_module_has_tests "$project_root" "$module_name")"
            case "$model_answer" in
                true)  return 0 ;;
                false) return 1 ;;
                # empty → model absent / unreadable → fall through to filesystem walk
            esac
        fi
        local module_path="$project_root/${module_name#:}"
        module_path="${module_path//:/\/}"
        _module_has_test_sources_fs "$module_path"
        return $?
    fi
    _module_has_test_sources_fs "$1"
}

# Internal: filesystem-walk fallback. Checks the 9 standard directories.
_module_has_test_sources_fs() {
    local module_path="$1"
    [[ -d "$module_path/src/test" ]] && return 0
    [[ -d "$module_path/src/commonTest" ]] && return 0
    [[ -d "$module_path/src/jvmTest" ]] && return 0
    [[ -d "$module_path/src/desktopTest" ]] && return 0
    [[ -d "$module_path/src/androidUnitTest" ]] && return 0
    [[ -d "$module_path/src/androidInstrumentedTest" ]] && return 0
    [[ -d "$module_path/src/androidTest" ]] && return 0
    [[ -d "$module_path/src/iosTest" ]] && return 0
    [[ -d "$module_path/src/nativeTest" ]] && return 0
    return 1
}

# Format a sorted comma-separated list of line numbers into compact ranges.
# E.g., "1,2,3,5,6,10" -> "1-3, 5-6, 10"
# Usage: format_line_ranges <csv_string>
format_line_ranges() {
    local lines_csv="$1"
    if [[ -z "$lines_csv" ]]; then echo "-"; return; fi

    # Strip carriage returns (Windows line endings)
    lines_csv="${lines_csv//$'\r'/}"

    IFS=',' read -ra raw_nums <<< "$lines_csv"
    if [[ ${#raw_nums[@]} -eq 0 ]]; then echo "-"; return; fi

    local nums=()
    for val in "${raw_nums[@]}"; do
        val="${val#"${val%%[! ]*}"}"
        val="${val%"${val##*[! ]}"}"
        if [[ -n "$val" && "$val" =~ ^[0-9]+$ ]]; then
            nums+=("$val")
        fi
    done
    if [[ ${#nums[@]} -eq 0 ]]; then echo "-"; return; fi

    local ranges=()
    local start="${nums[0]}" end="${nums[0]}"

    for ((i=1; i<${#nums[@]}; i++)); do
        local n="${nums[$i]}"
        if [[ "$n" -eq $((end + 1)) ]]; then
            end="$n"
        else
            if [[ "$start" -eq "$end" ]]; then
                ranges+=("$start")
            else
                ranges+=("${start}-${end}")
            fi
            start="$n"
            end="$n"
        fi
    done

    if [[ "$start" -eq "$end" ]]; then
        ranges+=("$start")
    else
        ranges+=("${start}-${end}")
    fi

    # Join with ", " — local IFS is unreliable on some bash builds on Windows
    local result=""
    local i
    for ((i=0; i<${#ranges[@]}; i++)); do
        if [[ $i -gt 0 ]]; then result="${result}, "; fi
        result="${result}${ranges[$i]}"
    done
    echo "$result"
}

# Map a file path to its Gradle module path.
# Returns the module path (e.g., ":core:domain") or empty string.
# Usage: get_module_from_file <file_path> <project_path>
get_module_from_file() {
    local file_path="$1"
    local project_path="$2"

    IFS='/' read -ra parts <<< "$file_path"
    if [[ "${#parts[@]}" -lt 2 ]]; then
        return
    fi

    # Pattern 1: Nested modules (core/domain, feature/home, shared/model)
    local nested_prefixes="core feature shared data ui common"
    local is_nested=false
    for prefix in $nested_prefixes; do
        if [[ "${parts[0]}" == "$prefix" ]]; then
            is_nested=true
            break
        fi
    done
    if $is_nested && [[ "${#parts[@]}" -ge 2 ]]; then
        local module_path="$project_path/${parts[0]}/${parts[1]}"
        if [[ -f "$module_path/build.gradle.kts" ]]; then
            echo ":${parts[0]}:${parts[1]}"
            return
        fi
    fi

    # Pattern 2: Flat modules with prefix (core-domain, feature-home)
    if echo "${parts[0]}" | grep -qE '^(core|feature|shared|data|ui)-'; then
        local module_path="$project_path/${parts[0]}"
        if [[ -f "$module_path/build.gradle.kts" ]]; then
            echo ":${parts[0]}"
            return
        fi
    fi

    # Pattern 3: App modules
    local app_modules="app androidApp desktopApp iosApp macosApp"
    for app_mod in $app_modules; do
        if [[ "${parts[0]}" == "$app_mod" ]]; then
            local module_path="$project_path/${parts[0]}"
            if [[ -f "$module_path/build.gradle.kts" ]]; then
                echo ":${parts[0]}"
                return
            fi
        fi
    done
}

# Cross-platform ripgrep wrapper with find+grep fallback.
# rg --glob '!pattern' silently returns empty on Windows/MSYS2 (path mangling).
# This function uses rg on Linux/macOS and falls back to find+grep on Windows.
#
# Usage: safe_rg <pattern> <directory> [options...]
#   --include=GLOB   include only files matching glob (e.g. --include='*.kt')
#   --exclude-dir=D  exclude directory from search
#   -l               list files only (no content)
#   -n               show line numbers
#   -c               count matches per file
#
# Examples:
#   safe_rg "import java.time" src/commonMain --include='*.kt'
#   safe_rg "println" . --include='*.kt' --exclude-dir=build --exclude-dir=.gradle
#   safe_rg -l "TODO" . --include='*.kt'
safe_rg() {
    local pattern=""
    local directory="."
    local includes=()
    local excludes=()
    local rg_flags=()
    local list_only=false
    local count_mode=false
    local show_line_numbers=false

    # Parse arguments
    local positional_idx=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --include=*)
                local glob="${1#--include=}"
                glob="${glob//\'/}"
                includes+=("$glob")
                shift ;;
            --exclude-dir=*)
                local dir="${1#--exclude-dir=}"
                excludes+=("$dir")
                shift ;;
            -l) list_only=true; shift ;;
            -n) show_line_numbers=true; shift ;;
            -c) count_mode=true; shift ;;
            -*)
                rg_flags+=("$1"); shift ;;
            *)
                if [[ $positional_idx -eq 0 ]]; then
                    pattern="$1"
                elif [[ $positional_idx -eq 1 ]]; then
                    directory="$1"
                fi
                positional_idx=$((positional_idx + 1))
                shift ;;
        esac
    done

    if [[ -z "$pattern" ]]; then
        echo "safe_rg: pattern required" >&2
        return 1
    fi

    # Detect platform — Windows/MSYS2 rg has broken glob negation
    local use_rg=true
    case "$(uname -s)" in
        MINGW*|MSYS*|CYGWIN*) use_rg=false ;;
        *)
            if ! command -v rg &>/dev/null; then
                use_rg=false
            fi
            ;;
    esac

    if $use_rg; then
        local rg_args=("${rg_flags[@]}")
        for inc in "${includes[@]}"; do
            rg_args+=("--glob" "$inc")
        done
        for exc in "${excludes[@]}"; do
            rg_args+=("--glob" "!${exc}/**")
        done
        if $list_only; then rg_args+=("-l"); fi
        if $count_mode; then rg_args+=("-c"); fi
        if $show_line_numbers; then rg_args+=("-n"); fi

        rg "${rg_args[@]}" "$pattern" "$directory" 2>/dev/null || true
    else
        # find+grep fallback
        local find_args=("$directory")

        # Prune excluded dirs
        if [[ ${#excludes[@]} -gt 0 ]]; then
            find_args+=("(")
            local first=true
            for exc in "${excludes[@]}"; do
                if $first; then first=false; else find_args+=("-o"); fi
                find_args+=("-name" "$exc" "-prune")
            done
            find_args+=(")" "-o")
        fi

        # File name filters
        find_args+=("-type" "f")
        if [[ ${#includes[@]} -gt 0 ]]; then
            find_args+=("(")
            local first=true
            for inc in "${includes[@]}"; do
                if $first; then first=false; else find_args+=("-o"); fi
                find_args+=("-name" "$inc")
            done
            find_args+=(")")
        fi
        find_args+=("-print")

        if $list_only; then
            find "${find_args[@]}" 2>/dev/null | while IFS= read -r file; do
                if grep -q "$pattern" "$file" 2>/dev/null; then
                    echo "$file"
                fi
            done
        elif $count_mode; then
            find "${find_args[@]}" 2>/dev/null | while IFS= read -r file; do
                local c
                c=$(grep -c "$pattern" "$file" 2>/dev/null || echo "0")
                if [[ "$c" -gt 0 ]]; then
                    echo "$file:$c"
                fi
            done
        else
            local gflags=()
            if $show_line_numbers; then gflags+=("-n"); fi
            find "${find_args[@]}" 2>/dev/null | while IFS= read -r file; do
                grep "${gflags[@]}" "$pattern" "$file" 2>/dev/null | while IFS= read -r line; do
                    echo "$file:$line"
                done
            done
        fi
    fi
    return 0
}

# List changed files in a git repository.
# Usage: get_changed_files <project_path> <staged_only>
#   staged_only: "true" for staged files only, "false" for all (staged+unstaged+untracked)
get_changed_files() {
    local project_path="$1"
    local staged_only="$2"

    if [[ "$staged_only" == "true" ]]; then
        (cd "$project_path" && git diff --cached --name-only 2>/dev/null) || true
    else
        (cd "$project_path" && git status --porcelain 2>/dev/null) | while IFS= read -r line; do
            local file_path
            file_path="$(echo "$line" | sed 's/^.\{2,3\}//')"
            file_path="$(echo "$file_path" | sed 's/^[[:space:]]*//' | sed 's/"//g')"
            if echo "$file_path" | grep -q ' -> '; then
                file_path="$(echo "$file_path" | sed 's/.* -> //')"
            fi
            if [[ -n "$file_path" ]]; then
                echo "$file_path"
            fi
        done
    fi
}

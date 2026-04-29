#!/usr/bin/env bash
# =============================================================================
# gradle-tasks-probe.sh — One-shot Gradle task-set probe with content-keyed cache.
#
# Source this file and call:
#   probe_gradle_tasks "$PROJECT_ROOT"           -> echoes cache file path, 0 if ok
#   module_has_task "$PROJECT_ROOT" "$mod" task  -> returns 0 if ":mod:task" or "task" exists
#   module_first_existing_task "$PROJECT_ROOT" "$mod" task1 task2 task3
#                                                -> echoes first existing task name (no colon), empty if none
#
# Cache layout: <project>/.kmp-test-runner-cache/tasks-<sha>.txt
# Cache key:    sha1 of concatenated file contents of settings.gradle.kts,
#               gradle.properties, and every <module>/build.gradle.kts
#               discovered via include() declarations. Any content change
#               invalidates the cache deterministically.
#
# Probe failure (gradle missing, timeout, exit nonzero) is non-fatal: the
# probe returns 1 and callers fall back to their pre-probe behavior. A WARN
# is emitted to stderr exactly once per cache miss.
# =============================================================================

# Internal: hash a string deterministically. sha1 preferred (faster, present
# in msys/cygwin/macOS/linux), fall back to sha256, then to a long string of
# the input itself if nothing is available (cache still works, file name is
# just longer).
_kmp_hash() {
    local input="$1"
    if command -v sha1sum >/dev/null 2>&1; then
        printf '%s' "$input" | sha1sum 2>/dev/null | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        printf '%s' "$input" | shasum 2>/dev/null | awk '{print $1}'
    elif command -v sha256sum >/dev/null 2>&1; then
        printf '%s' "$input" | sha256sum 2>/dev/null | awk '{print $1}'
    else
        # Fallback: collapse non-alphanumeric to '_', truncate
        printf '%s' "$input" | tr -c '[:alnum:]' '_' | cut -c1-40
    fi
}

# Internal: compute cache key for a project.
# Concatenates settings.gradle.kts + gradle.properties + every per-module
# build.gradle.kts content into one stream, hashes it. Any content change
# triggers a new cache file.
_kmp_compute_cache_key() {
    local project_root="$1"
    local concat=""

    # v0.5.2 Gap C: strip all CR via `tr -d '\r'` so CRLF and LF files hash
    # identically across Windows / Linux / macOS runners. Subshell `$(...)`
    # then strips trailing LF the same way it always has. JS sibling does
    # `s.replace(/\r/g, '').replace(/\n+$/, '')`; PS1 sibling does
    # `-replace '\r', ''` then `-replace '\n+$', ''`. All three converge.
    if [[ -f "$project_root/settings.gradle.kts" ]]; then
        concat="${concat}$(tr -d '\r' < "$project_root/settings.gradle.kts" 2>/dev/null)"
    fi
    if [[ -f "$project_root/gradle.properties" ]]; then
        concat="${concat}$(tr -d '\r' < "$project_root/gradle.properties" 2>/dev/null)"
    fi

    # Find all build.gradle.kts up to depth 4, excluding build/ and .gradle/
    local found
    found="$(find "$project_root" -maxdepth 4 -name "build.gradle.kts" \
        -not -path "*/build/*" -not -path "*/.gradle/*" 2>/dev/null | sort)"
    local f
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        concat="${concat}$(tr -d '\r' < "$f" 2>/dev/null)"
    done <<< "$found"

    _kmp_hash "$concat"
}

# Probe gradle for the full task set. Caches output keyed by content of all
# build files. Returns 0 on success (echoes cache file path); 1 on failure.
# Subsequent calls with the same project root + unchanged build files are
# instant (cache hit, no gradle invocation).
#
# Optional global: KMP_PROBE_TIMEOUT (seconds, default 60). Probe is killed
# if it exceeds this — keeps the CLI from hanging on a misconfigured project.
probe_gradle_tasks() {
    local project_root="$1"
    [[ -z "$project_root" || ! -d "$project_root" ]] && return 1
    [[ ! -x "$project_root/gradlew" && ! -f "$project_root/gradlew" ]] && return 1

    local cache_dir="$project_root/.kmp-test-runner-cache"
    local cache_key
    cache_key="$(_kmp_compute_cache_key "$project_root")"
    [[ -z "$cache_key" ]] && return 1

    local cache_file="$cache_dir/tasks-${cache_key}.txt"

    # Cache hit
    if [[ -s "$cache_file" ]]; then
        echo "$cache_file"
        return 0
    fi

    # Cache miss — probe gradle
    mkdir -p "$cache_dir" 2>/dev/null || return 1

    local timeout_secs="${KMP_PROBE_TIMEOUT:-60}"
    local tmp_out="${cache_file}.tmp.$$"

    # Run gradle in background with watchdog. We can't rely on `timeout(1)`
    # being installed everywhere (missing on macOS by default).
    (cd "$project_root" && ./gradlew tasks --all --quiet > "$tmp_out" 2>/dev/null) &
    local probe_pid=$!

    local elapsed=0
    while kill -0 "$probe_pid" 2>/dev/null; do
        sleep 1
        elapsed=$((elapsed + 1))
        if [[ "$elapsed" -ge "$timeout_secs" ]]; then
            kill "$probe_pid" 2>/dev/null || true
            sleep 1
            kill -9 "$probe_pid" 2>/dev/null || true
            rm -f "$tmp_out" 2>/dev/null
            echo "[!] WARN: gradle task probe exceeded ${timeout_secs}s — falling back to legacy detection" >&2
            return 1
        fi
    done

    local probe_exit=0
    wait "$probe_pid" 2>/dev/null || probe_exit=$?

    if [[ "$probe_exit" -ne 0 || ! -s "$tmp_out" ]]; then
        rm -f "$tmp_out" 2>/dev/null
        echo "[!] WARN: gradle task probe failed (exit $probe_exit) — falling back to legacy detection" >&2
        return 1
    fi

    mv -f "$tmp_out" "$cache_file" 2>/dev/null || {
        rm -f "$tmp_out" 2>/dev/null
        return 1
    }
    echo "$cache_file"
    return 0
}

# Check if a task exists for a given module. Module is normalized
# ("core-foo" or ":core-foo" both work). Task is the bare task name
# ("connectedDebugAndroidTest", "jacocoTestReport").
#
# Returns:
#   0 = task confirmed present in cache
#   1 = cache present, task NOT in it (definitely missing)
#   2 = probe unavailable (caller should fall back to legacy behavior)
module_has_task() {
    local project_root="$1"
    local module="$2"
    local task="$3"

    local cache_file
    cache_file="$(probe_gradle_tasks "$project_root")" || return 2

    # `gradlew tasks --all` emits `module:task - description` (NO leading colon)
    # at column 0. Earlier versions of this probe required a `:` prefix in the
    # needle, which never matched and caused every probe to fall back to the
    # legacy umbrella task. Strip any caller-supplied colon and match the
    # actual cache format.
    module="${module#:}"
    local needle="${module}:${task}"

    grep -qE "(^|[[:space:]])${needle}([[:space:]]|$)" "$cache_file" 2>/dev/null
    # grep returns 0 (found) or 1 (missing), which matches our contract.
}

# Pick the first task name from a candidate list that exists for the module.
# Echoes the bare task name (no colon prefix) on success.
# Useful for: connectedDebugAndroidTest -> connectedAndroidTest -> androidConnectedCheck.
#
# Returns:
#   0 = found a candidate (echoed on stdout)
#   1 = probe OK but no candidate matched
#   2 = probe unavailable (caller should fall back to legacy behavior)
module_first_existing_task() {
    local project_root="$1"
    local module="$2"
    shift 2

    local cache_file
    cache_file="$(probe_gradle_tasks "$project_root")" || return 2

    # See `module_has_task` for cache-format rationale (no leading colon).
    module="${module#:}"
    local task
    for task in "$@"; do
        local needle="${module}:${task}"
        if grep -qE "(^|[[:space:]])${needle}([[:space:]]|$)" "$cache_file" 2>/dev/null; then
            echo "$task"
            return 0
        fi
    done
    return 1
}

# Force-rebuild the cache (used by tests + when the user passes a flag).
# Removes all tasks-*.txt files for the project; the next probe rebuilds.
clear_gradle_tasks_cache() {
    local project_root="$1"
    [[ -z "$project_root" || ! -d "$project_root" ]] && return 1
    rm -f "$project_root/.kmp-test-runner-cache/tasks-"*.txt 2>/dev/null
    return 0
}

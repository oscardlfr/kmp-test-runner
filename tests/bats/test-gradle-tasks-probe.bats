#!/usr/bin/env bats
# Tests for scripts/sh/lib/gradle-tasks-probe.sh — content-keyed task-set
# probe used by Bug B'' (coverage skip), Bug B' (android task selection),
# and the eventual Phase 4 ProjectModel refactor.

PROBE_LIB="scripts/sh/lib/gradle-tasks-probe.sh"

setup() {
    WORK_DIR="$(mktemp -d)"
    mkdir -p "$WORK_DIR"
    echo 'rootProject.name = "probe-test"' > "$WORK_DIR/settings.gradle.kts"

    # Stub gradlew that emits a canned task-set output.
    # Format mirrors REAL `gradlew tasks --all --quiet` output:
    #   `module:task - description` (NO leading colon at column 0).
    # An earlier version of this fixture used `:core-foo:test` (synthetic
    # leading colon) and accidentally validated a probe regex that never
    # matched real gradle output — see the cache-format fix in this PR.
    cat > "$WORK_DIR/gradlew" << 'EOF'
#!/usr/bin/env bash
cat <<TASKS
core-foo:test - Runs the unit tests.
core-foo:jacocoTestReport - Generates code coverage report for the test task.
core-bar:test - Runs the unit tests.
core-bar:connectedAndroidTest - Installs and runs instrumentation tests on connected devices.
core-bar:androidConnectedCheck - Runs all device checks on currently connected devices.
legacy-only:connectedDebugAndroidTest - Installs and runs the tests for debug on connected devices.
TASKS
exit 0
EOF
    chmod +x "$WORK_DIR/gradlew"
}

teardown() {
    rm -rf "$WORK_DIR"
}

@test "probe lib sources cleanly" {
    # shellcheck disable=SC1090
    source "$PROBE_LIB"
    type probe_gradle_tasks >/dev/null
    type module_has_task >/dev/null
    type module_first_existing_task >/dev/null
    type clear_gradle_tasks_cache >/dev/null
}

@test "probe_gradle_tasks: cold run populates cache, warm run reuses it" {
    # shellcheck disable=SC1090
    source "$PROBE_LIB"
    local cache1 cache2
    cache1="$(probe_gradle_tasks "$WORK_DIR")"
    [ -n "$cache1" ]
    [ -f "$cache1" ]
    # Second call must return the SAME cache file path (cache hit).
    cache2="$(probe_gradle_tasks "$WORK_DIR")"
    [ "$cache1" = "$cache2" ]
}

@test "probe_gradle_tasks: cache invalidates when settings.gradle.kts changes" {
    # shellcheck disable=SC1090
    source "$PROBE_LIB"
    local cache1 cache2
    cache1="$(probe_gradle_tasks "$WORK_DIR")"
    # Mutate settings.gradle.kts content (mtime + content change)
    echo 'include(":new-module")' >> "$WORK_DIR/settings.gradle.kts"
    cache2="$(probe_gradle_tasks "$WORK_DIR")"
    [ "$cache1" != "$cache2" ]
}

@test "module_has_task: rc 0 when task confirmed present" {
    # shellcheck disable=SC1090
    source "$PROBE_LIB"
    set +e
    module_has_task "$WORK_DIR" "core-foo" "jacocoTestReport"
    rc=$?
    set -e
    [ "$rc" -eq 0 ]
}

@test "module_has_task: rc 1 when cache present but task absent" {
    # shellcheck disable=SC1090
    source "$PROBE_LIB"
    set +e
    module_has_task "$WORK_DIR" "core-foo" "doesNotExist"
    rc=$?
    set -e
    [ "$rc" -eq 1 ]
}

@test "module_has_task: rc 2 when probe unavailable (no gradlew)" {
    # shellcheck disable=SC1090
    source "$PROBE_LIB"
    local empty_dir
    empty_dir="$(mktemp -d)"
    set +e
    module_has_task "$empty_dir" "anything" "anything"
    rc=$?
    set -e
    rm -rf "$empty_dir"
    [ "$rc" -eq 2 ]
}

@test "module_first_existing_task: picks earliest matching candidate" {
    # shellcheck disable=SC1090
    source "$PROBE_LIB"
    local task
    # core-bar has connectedAndroidTest AND androidConnectedCheck — earlier wins.
    task="$(module_first_existing_task "$WORK_DIR" "core-bar" \
        "connectedDebugAndroidTest" "connectedAndroidTest" "androidConnectedCheck")"
    [ "$task" = "connectedAndroidTest" ]
}

@test "module_first_existing_task: picks androidConnectedCheck for KMP-DSL-only module" {
    # shellcheck disable=SC1090
    source "$PROBE_LIB"
    local task
    # core-bar has only connectedAndroidTest + androidConnectedCheck (no Debug variant)
    task="$(module_first_existing_task "$WORK_DIR" "core-bar" \
        "connectedDebugAndroidTest" "androidConnectedCheck")"
    [ "$task" = "androidConnectedCheck" ]
}

@test "module_first_existing_task: rc 1 when probe healthy but no candidate matches" {
    # shellcheck disable=SC1090
    source "$PROBE_LIB"
    set +e
    module_first_existing_task "$WORK_DIR" "core-foo" "neverHeardOfThis" "norThis"
    rc=$?
    set -e
    [ "$rc" -eq 1 ]
}

@test "module_first_existing_task: rc 2 when probe unavailable" {
    # shellcheck disable=SC1090
    source "$PROBE_LIB"
    local empty_dir
    empty_dir="$(mktemp -d)"
    set +e
    module_first_existing_task "$empty_dir" "x" "anything"
    rc=$?
    set -e
    rm -rf "$empty_dir"
    [ "$rc" -eq 2 ]
}

@test "module_has_task: matches real gradle format (no leading colon) — regression for probe-cache miss" {
    # The bug: when gradle emits `core-bar:androidConnectedCheck - Runs ...`
    # at column 0, an earlier needle of `:core-bar:androidConnectedCheck`
    # never matched because the line didn't start with `:`. Real-world impact
    # against shared-kmp-libs: probe rc=1 + fallback to umbrella task even
    # though `androidConnectedCheck` was right there in the cache.
    # shellcheck disable=SC1090
    source "$PROBE_LIB"
    set +e
    module_has_task "$WORK_DIR" "core-bar" "androidConnectedCheck"
    rc=$?
    set -e
    [ "$rc" -eq 0 ]
}

@test "module_has_task: caller-supplied leading colon is stripped (backward compat)" {
    # Even though gradle output never has a leading colon, callers in the
    # codebase sometimes pass `:module` (gradle invocation syntax). Verify
    # we strip it cleanly so both forms work.
    # shellcheck disable=SC1090
    source "$PROBE_LIB"
    set +e
    module_has_task "$WORK_DIR" ":core-foo" "jacocoTestReport"
    rc=$?
    set -e
    [ "$rc" -eq 0 ]
}

@test "module_first_existing_task: prefers earlier candidates (KMP androidLibrary{} priority)" {
    # Bug B' fallback: when both connectedDebugAndroidTest AND
    # androidConnectedCheck exist (rare but possible), pick the FIRST in
    # priority. core-bar has both connectedAndroidTest and androidConnectedCheck;
    # query with both candidates → must pick the first one in our list.
    # shellcheck disable=SC1090
    source "$PROBE_LIB"
    local picked
    picked="$(module_first_existing_task "$WORK_DIR" "core-bar" \
        "connectedAndroidTest" "androidConnectedCheck")"
    [ "$picked" = "connectedAndroidTest" ]
}

@test "module_first_existing_task: falls back to umbrella when only that exists" {
    # The KMP `androidLibrary{}` DSL: only androidConnectedCheck is defined.
    # Verify we walk the candidate list and pick the umbrella.
    # shellcheck disable=SC1090
    source "$PROBE_LIB"
    # Override the gradlew stub to simulate a KMP-only module.
    cat > "$WORK_DIR/gradlew" << 'EOF'
#!/usr/bin/env bash
cat <<TASKS
kmp-module:androidConnectedCheck - Runs all device checks on currently connected devices.
TASKS
exit 0
EOF
    chmod +x "$WORK_DIR/gradlew"
    # Force a fresh cache (settings.gradle.kts mtime change to trigger key change).
    echo '# touch' >> "$WORK_DIR/settings.gradle.kts"
    local picked
    picked="$(module_first_existing_task "$WORK_DIR" "kmp-module" \
        "connectedDebugAndroidTest" "connectedAndroidTest" "androidConnectedCheck")"
    [ "$picked" = "androidConnectedCheck" ]
}

@test "clear_gradle_tasks_cache: removes cache files" {
    # shellcheck disable=SC1090
    source "$PROBE_LIB"
    probe_gradle_tasks "$WORK_DIR" >/dev/null
    [ -d "$WORK_DIR/.kmp-test-runner-cache" ]
    [ "$(find "$WORK_DIR/.kmp-test-runner-cache" -name 'tasks-*.txt' | wc -l)" -gt 0 ]
    clear_gradle_tasks_cache "$WORK_DIR"
    [ "$(find "$WORK_DIR/.kmp-test-runner-cache" -name 'tasks-*.txt' 2>/dev/null | wc -l)" -eq 0 ]
}

# v0.5.2 Gap C — cross-platform cache-key SHA byte parity.
# Strategy: all three walkers (JS / bash / PS1) normalize content by stripping
# ALL `\r` then trailing `\n+` before hashing, so files with identical
# logical content but different line endings (CRLF vs LF) hash to the SAME
# SHA on every platform. Fixtures + expected SHAs mirrored in
# tests/vitest/project-model.test.js and
# tests/pester/Gradle-Tasks-Probe.Tests.ps1.

@test "_kmp_compute_cache_key (Gap C): LF fixture produces canonical SHA" {
    local fix
    fix="$(mktemp -d)"
    printf 'rootProject.name = "x"\nplugins { kotlin("jvm") }\n' > "$fix/settings.gradle.kts"
    printf 'plugins { kotlin("jvm") }\n' > "$fix/build.gradle.kts"
    source "$PROBE_LIB"
    local sha
    sha="$(_kmp_compute_cache_key "$fix")"
    [ "$sha" = "0939412f62e3d3480919e52e477d01063d948cdd" ]
    rm -rf "$fix"
}

@test "_kmp_compute_cache_key (Gap C): CRLF fixture produces SAME canonical SHA (cross-platform parity)" {
    local fix
    fix="$(mktemp -d)"
    printf 'rootProject.name = "x"\r\nplugins { kotlin("jvm") }\r\n' > "$fix/settings.gradle.kts"
    printf 'plugins { kotlin("jvm") }\r\n' > "$fix/build.gradle.kts"
    source "$PROBE_LIB"
    local sha
    sha="$(_kmp_compute_cache_key "$fix")"
    # Same logical content as LF fixture; line-ending normalization via
    # `tr -d '\r'` aligns bash with JS `s.replace(/\r/g, '')` and PS1
    # `-replace '\r', ''`.
    [ "$sha" = "0939412f62e3d3480919e52e477d01063d948cdd" ]
    rm -rf "$fix"
}

@test "_kmp_compute_cache_key (Gap C): mixed CRLF+LF fixture produces SAME canonical SHA" {
    local fix
    fix="$(mktemp -d)"
    printf 'rootProject.name = "x"\r\nplugins { kotlin("jvm") }\r\n' > "$fix/settings.gradle.kts"  # CRLF
    printf 'plugins { kotlin("jvm") }\n' > "$fix/build.gradle.kts"                                 # LF
    source "$PROBE_LIB"
    local sha
    sha="$(_kmp_compute_cache_key "$fix")"
    [ "$sha" = "0939412f62e3d3480919e52e477d01063d948cdd" ]
    rm -rf "$fix"
}

@test "_kmp_compute_cache_key (Gap C): multiple trailing newlines fold to same SHA" {
    local a b sha_a sha_b
    a="$(mktemp -d)"
    b="$(mktemp -d)"
    printf 'rootProject.name = "x"\nplugins { kotlin("jvm") }\n' > "$a/settings.gradle.kts"
    printf 'plugins { kotlin("jvm") }\n' > "$a/build.gradle.kts"
    printf 'rootProject.name = "x"\nplugins { kotlin("jvm") }\n\n\n' > "$b/settings.gradle.kts"
    printf 'plugins { kotlin("jvm") }\n\n' > "$b/build.gradle.kts"
    source "$PROBE_LIB"
    sha_a="$(_kmp_compute_cache_key "$a")"
    sha_b="$(_kmp_compute_cache_key "$b")"
    [ "$sha_a" = "$sha_b" ]
    rm -rf "$a" "$b"
}

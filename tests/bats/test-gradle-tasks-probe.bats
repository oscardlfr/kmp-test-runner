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
    cat > "$WORK_DIR/gradlew" << 'EOF'
#!/usr/bin/env bash
# Mimics `gradlew tasks --all --quiet` output for the probe.
cat <<TASKS
:core-foo:test
:core-foo:jacocoTestReport
:core-bar:test
:core-bar:connectedAndroidTest
:core-bar:androidConnectedCheck
:legacy-only:connectedDebugAndroidTest
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

@test "clear_gradle_tasks_cache: removes cache files" {
    # shellcheck disable=SC1090
    source "$PROBE_LIB"
    probe_gradle_tasks "$WORK_DIR" >/dev/null
    [ -d "$WORK_DIR/.kmp-test-runner-cache" ]
    [ "$(find "$WORK_DIR/.kmp-test-runner-cache" -name 'tasks-*.txt' | wc -l)" -gt 0 ]
    clear_gradle_tasks_cache "$WORK_DIR"
    [ "$(find "$WORK_DIR/.kmp-test-runner-cache" -name 'tasks-*.txt' 2>/dev/null | wc -l)" -eq 0 ]
}

#!/usr/bin/env bats
# Tests for scripts/sh/run-android-tests.sh

SCRIPT="scripts/sh/run-android-tests.sh"

setup() {
    WORK_DIR="$(mktemp -d)"
    mkdir -p "$WORK_DIR"
    echo 'rootProject.name = "test-project"' > "$WORK_DIR/settings.gradle.kts"
    mkdir -p "$WORK_DIR/bin"
    cat > "$WORK_DIR/bin/gradlew" << 'EOF'
#!/usr/bin/env bash
echo "BUILD SUCCESSFUL (stub): $*"
exit 0
EOF
    chmod +x "$WORK_DIR/bin/gradlew"
    export PATH="$WORK_DIR/bin:$PATH"
}

teardown() {
    rm -rf "$WORK_DIR"
}

@test "android: --list-only exits 0 without requiring ADB" {
    run bash "$SCRIPT" --project-root "$WORK_DIR" --list-only
    [ "$status" -eq 0 ]
    [[ "$output" != *"ADB not found"* ]]
}

@test "android: error path exits 1 when --project-root missing" {
    run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"--project-root is required"* ]]
}

@test "android: lib sourcing uses SCRIPT_DIR not absolute paths" {
    local sources
    sources=$(grep -E '^source ' "$SCRIPT" || true)
    [[ "$sources" != *"/Users/"* ]]
    [[ "$sources" != *"/home/"* ]]
    [[ "$sources" != *"/root/"* ]]
    if [[ -n "$sources" ]]; then
        [[ "$sources" == *'$SCRIPT_DIR'* ]]
    fi
}

@test "android: emits === JSON SUMMARY === delimiter (parser contract for v0.5.1 Bug G)" {
    # The cli.js parseAndroidSummary parser keys off the literal string
    # "=== JSON SUMMARY ===" to locate the JSON envelope. If the script
    # changes this delimiter, --json mode will silently fall back to
    # bracket-table parsing. Pin it.
    grep -F "=== JSON SUMMARY ===" "$SCRIPT"
}

@test "android: JSON SUMMARY exposes the fields parseAndroidSummary reads (Bug G contract)" {
    # The cli.js parser maps these exact keys. If the script renames any of
    # them, the envelope loses signal silently — this test catches that drift.
    grep -F "'totalTests'" "$SCRIPT"
    grep -F "'passedTests'" "$SCRIPT"
    grep -F "'failedTests'" "$SCRIPT"
    grep -F "'modules'" "$SCRIPT"
    grep -F "'name'" "$SCRIPT"
    grep -F "'status'" "$SCRIPT"
    grep -F "'logFile'" "$SCRIPT"
    grep -F "'logcatFile'" "$SCRIPT"
    grep -F "'errorsFile'" "$SCRIPT"
}

# ---------------------------------------------------------------------------
# v0.5.1 Bug B' — android task selection via gradle-tasks-probe
# ---------------------------------------------------------------------------
@test "android (Bug B'): script sources gradle-tasks-probe.sh" {
    grep -q 'lib/gradle-tasks-probe.sh' "$SCRIPT"
}

@test "android (Bug B'): accepts --device-task <name> flag" {
    grep -q -- '--device-task)' "$SCRIPT"
    grep -q 'DEVICE_TASK_OVERRIDE=' "$SCRIPT"
}

@test "android (Bug B'): help text documents --device-task and androidConnectedCheck" {
    grep -q -- '--device-task' "$SCRIPT"
    grep -q 'androidConnectedCheck' "$SCRIPT"
}

@test "android (Bug B'): task selection probes via module_first_existing_task" {
    grep -q 'module_first_existing_task' "$SCRIPT"
    # Candidate priority must include the new umbrella task name.
    grep -q '"connectedDebugAndroidTest" "connectedAndroidTest" "androidConnectedCheck"' "$SCRIPT"
}

@test "android (Bug B'): probe-unavailable path falls back to legacy hardcoded matrix" {
    # The fallback branch must keep the old logic so probe failure doesn't brick the script.
    grep -q 'Probe unavailable.*fall back to legacy' "$SCRIPT"
}

@test "android (Bug B'): override flag short-circuits probe entirely" {
    # When DEVICE_TASK_OVERRIDE is set, probe is skipped entirely.
    grep -B 0 -A 2 'if \[\[ -n "\$DEVICE_TASK_OVERRIDE" \]\]; then' "$SCRIPT" | \
        grep -q 'task="\${formatted_module}:\${DEVICE_TASK_OVERRIDE}"'
}

@test "android (Phase 4 step 5): ProjectModel fast-path tier 1 is wired before probe" {
    # The script must source project-model.sh so pm_get_device_test_task is
    # available, and the device-task selector must consult it BEFORE
    # invoking module_first_existing_task.
    grep -q 'source "\$SCRIPT_DIR/lib/project-model.sh"' "$SCRIPT"
    grep -q 'pm_get_device_test_task' "$SCRIPT"
    # The model check must appear before the probe call in the source.
    pm_line="$(grep -n 'pm_get_device_test_task' "$SCRIPT" | head -1 | cut -d: -f1)"
    probe_line="$(grep -n 'module_first_existing_task "\$PROJECT_ROOT"' "$SCRIPT" | head -1 | cut -d: -f1)"
    [ "$pm_line" -lt "$probe_line" ]
}

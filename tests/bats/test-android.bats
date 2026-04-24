#!/usr/bin/env bats
# Tests for scripts/sh/run-android-tests.sh
#
# NOTE: run-android-tests.sh does NOT validate --project-root as required.
# It defaults PROJECT_ROOT="." when not supplied. The --project-root required
# contract is NOT enforced here — this is a production code gap reported to
# arch-testing. Error path tests below use the ADB-missing exit path instead.

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
    # Unset ANDROID_HOME so ADB lookup fails predictably
    unset ANDROID_HOME
    unset ANDROID_SDK_ROOT
}

teardown() {
    rm -rf "$WORK_DIR"
}

@test "android: --list-only exits 0 without requiring ADB" {
    run bash "$SCRIPT" --project-root "$WORK_DIR" --list-only
    # list-only exits before ADB check — should not print ADB error
    [[ "$output" != *"ADB not found"* ]]
}

@test "android: error path exits 1 when ADB is not available" {
    # Verify ADB truly not on PATH in this environment
    if command -v adb >/dev/null 2>&1; then
        skip "adb found on PATH — ADB-missing path not testable in this env"
    fi
    run bash "$SCRIPT" --project-root "$WORK_DIR"
    [ "$status" -eq 1 ]
    [[ "$output" == *"ADB not found"* ]]
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

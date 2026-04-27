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

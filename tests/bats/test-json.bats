#!/usr/bin/env bats
# Smoke tests for kmp-test --json (agentic output mode)

CLI="bin/kmp-test.js"

setup() {
    WORK_DIR="$(mktemp -d)"
    # Minimum gradle project: settings + gradlew wrapper
    echo 'rootProject.name = "fake"' > "$WORK_DIR/settings.gradle.kts"
    cat > "$WORK_DIR/gradlew" << 'EOF'
#!/usr/bin/env bash
echo "BUILD SUCCESSFUL (stub gradlew): $*"
exit 0
EOF
    chmod +x "$WORK_DIR/gradlew"
    # Also create gradlew.bat so the cross-platform pre-flight check passes on either OS
    printf '@echo off\r\nexit /b 0\r\n' > "$WORK_DIR/gradlew.bat"
}

teardown() {
    rm -rf "$WORK_DIR"
}

@test "--json: emits a single JSON object on stdout against a fake gradle project" {
    run node "$CLI" --json parallel --project-root "$WORK_DIR"
    # Whatever the bash script's exit (likely 3 — "no modules"), --json must still
    # emit a parseable JSON object on stdout.
    [ -n "$output" ]
    # The very first non-blank stdout line must be a JSON object
    first_line=$(echo "$output" | grep -m1 '^{' || true)
    [ -n "$first_line" ]
    # Must have the canonical top-level keys
    [[ "$first_line" == *'"tool":"kmp-test"'* ]]
    [[ "$first_line" == *'"subcommand":"parallel"'* ]]
    [[ "$first_line" == *'"version":'* ]]
    [[ "$first_line" == *'"project_root":'* ]]
    [[ "$first_line" == *'"exit_code":'* ]]
    [[ "$first_line" == *'"duration_ms":'* ]]
    [[ "$first_line" == *'"tests":'* ]]
    [[ "$first_line" == *'"modules":'* ]]
    [[ "$first_line" == *'"coverage":'* ]]
    [[ "$first_line" == *'"errors":'* ]]
}

@test "--json: missing gradlew → exit 3 + valid JSON envelope with errors[]" {
    EMPTY_DIR="$(mktemp -d)"
    run node "$CLI" --json parallel --project-root "$EMPTY_DIR"
    rm -rf "$EMPTY_DIR"
    [ "$status" -eq 3 ]
    first_line=$(echo "$output" | grep -m1 '^{' || true)
    [ -n "$first_line" ]
    [[ "$first_line" == *'"exit_code":3'* ]]
    [[ "$first_line" == *'"errors":'* ]]
    [[ "$first_line" == *'gradlew'* ]]
}

@test "--format json: alias is recognized" {
    run node "$CLI" --format json parallel --project-root "$WORK_DIR"
    first_line=$(echo "$output" | grep -m1 '^{' || true)
    [ -n "$first_line" ]
    [[ "$first_line" == *'"tool":"kmp-test"'* ]]
}

@test "parallel --help shows subcommand-specific flags (no spawn)" {
    run node "$CLI" parallel --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"kmp-test parallel"* ]]
    [[ "$output" == *"--include-shared"* ]]
    [[ "$output" == *"--coverage-tool"* ]]
    [[ "$output" == *"Example:"* ]]
}

@test "missing gradlew (no --json) → exit 3 + helpful error on stderr" {
    EMPTY_DIR="$(mktemp -d)"
    run node "$CLI" parallel --project-root "$EMPTY_DIR"
    rm -rf "$EMPTY_DIR"
    [ "$status" -eq 3 ]
    [[ "$output" == *"no gradlew"* ]]
    [[ "$output" == *"--project-root"* ]]
}

@test "no args → exit 2 + global help printed" {
    run node "$CLI"
    [ "$status" -eq 2 ]
    [[ "$output" == *"Subcommands:"* ]]
}

@test "unknown subcommand → exit 2 + error message" {
    run node "$CLI" not-a-subcommand
    [ "$status" -eq 2 ]
    [[ "$output" == *"unknown subcommand"* ]]
}

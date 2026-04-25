#!/usr/bin/env bats
# Tests for coverage subcommand — uses same script as parallel
# (run-parallel-coverage-suite.sh with --skip-tests injected by bin/kmp-test.js)

SCRIPT="scripts/sh/run-parallel-coverage-suite.sh"

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

@test "coverage: --skip-tests flag accepted without error" {
    run bash "$SCRIPT" --project-root "$WORK_DIR" --skip-tests --module-filter "nonexistent-module-xyz"
    # --skip-tests must not produce an unknown-option error
    [[ "$output" != *"Unknown option"* ]]
    [[ "$output" != *"--project-root is required"* ]]
}

@test "coverage: error path exits 1 when --project-root is missing" {
    run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"--project-root is required"* ]]
}

@test "coverage: lib sourcing uses SCRIPT_DIR not absolute paths" {
    local sources
    sources=$(grep -E '^source ' "$SCRIPT" || true)
    [[ "$sources" != *"/Users/"* ]]
    [[ "$sources" != *"/home/"* ]]
    [[ "$sources" != *"/root/"* ]]
    if [[ -n "$sources" ]]; then
        [[ "$sources" == *'$SCRIPT_DIR'* ]]
    fi
}

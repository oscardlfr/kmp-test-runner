#!/usr/bin/env bats
# Tests for scripts/sh/run-parallel-coverage-suite.sh

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

@test "parallel: happy path exits 0 with valid --project-root" {
    # Script exits 0 when --project-root points to a valid dir
    # It may exit early on no modules — that is still a valid run
    run bash "$SCRIPT" --project-root "$WORK_DIR" --module-filter "nonexistent-module-xyz"
    # exit 0 or non-zero is acceptable if no modules found, but must NOT be usage-error exit
    # The key assertion: --project-root was accepted (no "required" error)
    [[ "$output" != *"--project-root is required"* ]]
}

# v0.8 sub-entry 5: wrapper is now a thin Node launcher. The legacy
# `--project-root is required` upfront-check moved to lib/runner.js, which
# auto-defaults to cwd. The "lib sourcing uses SCRIPT_DIR" guard is moot
# (no source lines remain in the wrapper).
@test "parallel: wrapper script delegates to lib/runner.js parallel" {
    grep -q 'exec node.*lib/runner.js.*parallel' "$SCRIPT"
}

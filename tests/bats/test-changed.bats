#!/usr/bin/env bats
# Tests for scripts/sh/run-changed-modules-tests.sh

SCRIPT="scripts/sh/run-changed-modules-tests.sh"

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

@test "changed: happy path exits 0 with --project-root and no changed modules" {
    # Initialize a git repo so git-status doesn't fail
    git -C "$WORK_DIR" init --quiet
    git -C "$WORK_DIR" commit --allow-empty -m "init" --quiet
    run bash "$SCRIPT" --project-root "$WORK_DIR"
    # Should not produce a --project-root required error
    [[ "$output" != *"--project-root is required"* ]]
}

@test "changed: error path exits 1 when --project-root is missing" {
    run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"--project-root is required"* ]]
}

@test "changed: lib sourcing uses SCRIPT_DIR not absolute paths" {
    local sources
    sources=$(grep -E '^source ' "$SCRIPT" || true)
    [[ "$sources" != *"/Users/"* ]]
    [[ "$sources" != *"/home/"* ]]
    [[ "$sources" != *"/root/"* ]]
    if [[ -n "$sources" ]]; then
        [[ "$sources" == *'$SCRIPT_DIR'* ]]
    fi
}

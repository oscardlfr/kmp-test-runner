#!/usr/bin/env bats
# Smoke tests for kmp-test --dry-run

CLI="bin/kmp-test.js"

setup() {
    WORK_DIR="$(mktemp -d)"
    echo 'rootProject.name = "fake"' > "$WORK_DIR/settings.gradle.kts"
    cat > "$WORK_DIR/gradlew" << 'EOF'
#!/usr/bin/env bash
echo "this stub gradlew should NOT be invoked in a dry run"
exit 99
EOF
    chmod +x "$WORK_DIR/gradlew"
    printf '@echo off\r\nexit /b 99\r\n' > "$WORK_DIR/gradlew.bat"
}

teardown() {
    rm -rf "$WORK_DIR"
}

@test "--dry-run: parallel exits 0 without invoking the stub gradlew" {
    run node "$CLI" parallel --dry-run --project-root "$WORK_DIR"
    [ "$status" -eq 0 ]
    [[ "$output" == *"DRY RUN"* ]]
    [[ "$output" == *"Project root:"* ]]
    [[ "$output" == *"Subcommand:"* ]]
    # The stub gradlew above prints a unique sentinel — make sure it never ran.
    [[ "$output" != *"should NOT be invoked"* ]]
}

@test "--dry-run --json: emits a single JSON object with dry_run:true and plan{}" {
    run node "$CLI" parallel --dry-run --json --project-root "$WORK_DIR"
    [ "$status" -eq 0 ]
    first_line=$(echo "$output" | grep -m1 '^{' || true)
    [ -n "$first_line" ]
    [[ "$first_line" == *'"tool":"kmp-test"'* ]]
    [[ "$first_line" == *'"dry_run":true'* ]]
    [[ "$first_line" == *'"exit_code":0'* ]]
    [[ "$first_line" == *'"plan":'* ]]
    [[ "$first_line" == *'"spawn_args":'* ]]
}

@test "--dry-run BEFORE subcommand is hoisted (zero-spawn path)" {
    run node "$CLI" --dry-run parallel --project-root "$WORK_DIR"
    [ "$status" -eq 0 ]
    [[ "$output" == *"DRY RUN"* ]]
    [[ "$output" != *"should NOT be invoked"* ]]
}

@test "--dry-run still surfaces gradlew env-error when wrapper missing" {
    EMPTY_DIR="$(mktemp -d)"
    run node "$CLI" parallel --dry-run --project-root "$EMPTY_DIR"
    rm -rf "$EMPTY_DIR"
    [ "$status" -eq 3 ]
    [[ "$output" == *"gradlew"* ]]
}

@test "--dry-run reports the resolved test filter in plan output" {
    run node "$CLI" parallel --dry-run --test-filter "*FooTest*" --project-root "$WORK_DIR"
    [ "$status" -eq 0 ]
    [[ "$output" == *"*FooTest*"* ]]
    [[ "$output" == *"--test-filter"* ]]
}

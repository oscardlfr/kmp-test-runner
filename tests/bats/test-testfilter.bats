#!/usr/bin/env bats
# Smoke tests for kmp-test --test-filter (CLI passthrough only — full Android FQN
# resolution is unit-tested in vitest).

CLI="bin/kmp-test.js"

setup() {
    WORK_DIR="$(mktemp -d)"
    echo 'rootProject.name = "fake"' > "$WORK_DIR/settings.gradle.kts"
    cat > "$WORK_DIR/gradlew" << 'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "$WORK_DIR/gradlew"
    printf '@echo off\r\nexit /b 0\r\n' > "$WORK_DIR/gradlew.bat"
}

teardown() {
    rm -rf "$WORK_DIR"
}

@test "parallel --test-filter passthrough appears in dry-run plan args" {
    run node "$CLI" parallel --test-filter "*FooTest*" --dry-run --project-root "$WORK_DIR"
    [ "$status" -eq 0 ]
    [[ "$output" == *"--test-filter"* ]]
    [[ "$output" == *"*FooTest*"* ]]
}

@test "android --test-filter literal FQN passes through unchanged" {
    run node "$CLI" android --test-filter "com.example.WidgetTest" --dry-run --project-root "$WORK_DIR"
    [ "$status" -eq 0 ]
    [[ "$output" == *"com.example.WidgetTest"* ]]
}

@test "android --test-filter glob with no source match falls back to original pattern" {
    # --project-root has no Kotlin files, so resolution can't find a class.
    # Behavior: pass the original *Pattern* through (gradle/Android instrumentation
    # surfaces a clear error downstream rather than the CLI guessing).
    run node "$CLI" android --test-filter "*NoSuchClass*" --dry-run --project-root "$WORK_DIR"
    [ "$status" -eq 0 ]
    [[ "$output" == *"*NoSuchClass*"* ]]
}

@test "android --test-filter glob resolves to FQN when source class is found" {
    SRC="$WORK_DIR/app/src/androidTest/kotlin/app"
    mkdir -p "$SRC"
    cat > "$SRC/WidgetTest.kt" << 'EOF'
package app

class WidgetTest {
    fun foo() {}
}
EOF

    run node "$CLI" android --test-filter "*WidgetTest*" --dry-run --json --project-root "$WORK_DIR"
    [ "$status" -eq 0 ]
    first_line=$(echo "$output" | grep -m1 '^{' || true)
    [ -n "$first_line" ]
    [[ "$first_line" == *'"test_filter":"app.WidgetTest"'* ]]
}

@test "test-filter help text appears in subcommand --help" {
    run node "$CLI" parallel --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"--test-filter"* ]]
}

# v0.5.2 Gap E — Android method-level filter wire format.
# CLI normalizes both `FQN#method` and `FQN.method` into `FQN#method`
# on the wire to platform scripts; scripts split on `#` and emit two
# AndroidJUnitRunner runner-argument flags.

@test "android --test-filter FQN#method preserves wire format" {
    run node "$CLI" android --test-filter "com.example.WidgetTest#testFoo" --dry-run --json --project-root "$WORK_DIR"
    [ "$status" -eq 0 ]
    first_line=$(echo "$output" | grep -m1 '^{' || true)
    [ -n "$first_line" ]
    [[ "$first_line" == *'"test_filter":"com.example.WidgetTest#testFoo"'* ]]
}

@test "android --test-filter FQN.method normalizes to FQN#method on wire" {
    run node "$CLI" android --test-filter "com.example.WidgetTest.testFoo" --dry-run --json --project-root "$WORK_DIR"
    [ "$status" -eq 0 ]
    first_line=$(echo "$output" | grep -m1 '^{' || true)
    [ -n "$first_line" ]
    [[ "$first_line" == *'"test_filter":"com.example.WidgetTest#testFoo"'* ]]
}

@test "android --test-filter resolves wildcard class with #method portion" {
    SRC="$WORK_DIR/app/src/androidTest/kotlin/app"
    mkdir -p "$SRC"
    cat > "$SRC/WidgetTest.kt" << 'EOF'
package app

class WidgetTest {
    fun foo() {}
}
EOF

    run node "$CLI" android --test-filter "*WidgetTest*#testFoo" --dry-run --json --project-root "$WORK_DIR"
    [ "$status" -eq 0 ]
    first_line=$(echo "$output" | grep -m1 '^{' || true)
    [ -n "$first_line" ]
    [[ "$first_line" == *'"test_filter":"app.WidgetTest#testFoo"'* ]]
}

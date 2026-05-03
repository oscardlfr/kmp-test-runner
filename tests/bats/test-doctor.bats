#!/usr/bin/env bats
# Smoke tests for kmp-test doctor

CLI="bin/kmp-test.js"

# Opt out of the adb probe inside runDoctorChecks — on macos-latest GH
# runners the adb client inherits Node's pipe FDs and prevents bats from
# reaching pipe EOF on suite exit, hanging the whole run. Closes v0.8.0
# BACKLOG #6 + #9.
setup_file() {
    export KMP_TEST_SKIP_ADB=1
}

# Belt + braces — reap any daemon a previous suite or external invocation
# may have left running on the same shell.
teardown_file() {
    command -v adb >/dev/null 2>&1 && adb kill-server >/dev/null 2>&1 || true
}

@test "doctor --help prints subcommand-specific help and returns 0" {
    run node "$CLI" doctor --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"kmp-test doctor"* ]]
    [[ "$output" == *"Node"* ]]
    [[ "$output" == *"JDK"* ]]
}

@test "doctor (human) prints a CHECK/STATUS/VALUE/MESSAGE table" {
    run node "$CLI" doctor
    # Exit 0 (all OK/WARN) or 3 (FAIL) — both are acceptable; we only assert the table.
    [ "$status" -eq 0 ] || [ "$status" -eq 3 ]
    [[ "$output" == *"CHECK"* ]]
    [[ "$output" == *"STATUS"* ]]
    [[ "$output" == *"Node"* ]]
    [[ "$output" == *"JDK"* ]]
}

@test "doctor --json emits a single JSON object with checks[] array" {
    run node "$CLI" doctor --json
    first_line=$(echo "$output" | grep -m1 '^{' || true)
    [ -n "$first_line" ]
    [[ "$first_line" == *'"tool":"kmp-test"'* ]]
    [[ "$first_line" == *'"subcommand":"doctor"'* ]]
    [[ "$first_line" == *'"checks":'* ]]
    [[ "$first_line" == *'"version":'* ]]
    [[ "$first_line" == *'"exit_code":'* ]]
}

@test "doctor --json: exit code matches exit_code field" {
    run node "$CLI" doctor --json
    first_line=$(echo "$output" | grep -m1 '^{' || true)
    [ -n "$first_line" ]
    # Extract exit_code field value (best-effort grep — JSON is a single line)
    field=$(echo "$first_line" | grep -oE '"exit_code":[0-9]+' | head -1 | grep -oE '[0-9]+')
    [ -n "$field" ]
    [ "$status" -eq "$field" ]
}

@test "doctor: subcommand appears in global help" {
    run node "$CLI" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"doctor"* ]]
    [[ "$output" == *"Diagnose"* ]]
}

# v0.6.x Gap 2: doctor surfaces installed JDKs from the catalogue so users
# can see which auto-select candidates are available.
@test "doctor (human): includes 'JDK catalogue' check row" {
    run node "$CLI" doctor
    [ "$status" -eq 0 ] || [ "$status" -eq 3 ]
    [[ "$output" == *"JDK catalogue"* ]]
}

@test "doctor --json: checks[] includes 'JDK catalogue' entry" {
    run node "$CLI" doctor --json
    first_line=$(echo "$output" | grep -m1 '^{' || true)
    [ -n "$first_line" ]
    [[ "$first_line" == *'"name":"JDK catalogue"'* ]]
}

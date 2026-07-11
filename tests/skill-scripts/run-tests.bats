#!/usr/bin/env bats
# Smoke tests for .skills/kmp-test-runner/scripts/run-tests.sh.
#
# The script is a dispatcher around `kmp-test`. Tests exercise:
#   - file presence + executable bit
#   - --help / -h short-circuit
#   - unknown TYPE → exit 2 with usage on stderr
#   - default + custom TYPE map to the right kmp-test subcommand
#   - env preamble fires for android but not for unit
#
# kmp-test itself is mocked via a stub on PATH (the dispatch contract is
# what we test, not the kmp-test orchestrators — those have their own
# vitest suites). The stub just echoes its argv back to stdout so we can
# assert the script forwarded the right shape.

SCRIPT=".skills/kmp-test-runner/scripts/run-tests.sh"

setup() {
    TMPBIN="$(mktemp -d)"
    cat > "$TMPBIN/kmp-test" << 'EOF'
#!/usr/bin/env bash
echo "STUB_KMP_TEST_ARGS: $*"
EOF
    chmod +x "$TMPBIN/kmp-test"
}

teardown() {
    rm -rf "$TMPBIN"
}

@test "run-tests.sh exists at the expected path" {
    [ -f "$SCRIPT" ]
}

@test "run-tests.sh is executable" {
    [ -x "$SCRIPT" ]
}

@test "run-tests.sh --help exits 0 and prints usage" {
    run bash "$SCRIPT" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"Usage:"* ]]
    [[ "$output" == *"unit"* ]]
    [[ "$output" == *"android"* ]]
    [[ "$output" == *"--json"* ]]
}

@test "run-tests.sh -h is equivalent to --help" {
    run bash "$SCRIPT" -h
    [ "$status" -eq 0 ]
    [[ "$output" == *"Usage:"* ]]
}

@test "run-tests.sh rejects an unknown TYPE with exit 2 + usage on stderr" {
    run env PATH="$TMPBIN:$PATH" bash "$SCRIPT" bogus
    [ "$status" -eq 2 ]
    [[ "$output" == *"unknown TYPE 'bogus'"* ]]
    [[ "$output" == *"Usage:"* ]]
}

@test "run-tests.sh default TYPE dispatches kmp-test parallel" {
    run env PATH="$TMPBIN:$PATH" bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"STUB_KMP_TEST_ARGS: parallel --json --project-root ."* ]]
}

@test "run-tests.sh TYPE=coverage dispatches kmp-test coverage and forwards args" {
    run env PATH="$TMPBIN:$PATH" bash "$SCRIPT" coverage --module-filter "core-*"
    [ "$status" -eq 0 ]
    [[ "$output" == *"STUB_KMP_TEST_ARGS: coverage --json --project-root . --module-filter core-*"* ]]
}

@test "run-tests.sh TYPE=android emits env preamble on stderr" {
    # The env preamble line is the one stderr signal that distinguishes
    # android from other types. The kmp-test stub's stdout still fires.
    run env PATH="$TMPBIN:$PATH" bash "$SCRIPT" android --device FAKEDEVICE12X
    [ "$status" -eq 0 ]
    [[ "$output" == *"[INFO] env:"* ]]
    [[ "$output" == *"STUB_KMP_TEST_ARGS: android --json --project-root . --device FAKEDEVICE12X"* ]]
}

@test "run-tests.sh TYPE=unit does NOT emit env preamble on stderr" {
    run env PATH="$TMPBIN:$PATH" bash "$SCRIPT" unit
    [ "$status" -eq 0 ]
    # No env preamble for unit (only fires for android).
    [[ "$output" != *"[INFO] env:"* ]]
}

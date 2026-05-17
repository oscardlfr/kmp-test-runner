#!/usr/bin/env bats
# Smoke tests for .skills/kmp-test-runner/scripts/detect-env.sh.
#
# The script is intentionally side-effect-free: it probes for the `android`
# CLI on PATH and prints HAS_ANDROID_CLI or NO_ANDROID_CLI to stdout, always
# exiting 0. Tests cover both branches by mocking PATH (no real `android`
# binary required).

SCRIPT=".skills/kmp-test-runner/scripts/detect-env.sh"

@test "detect-env.sh exists at the expected path" {
    [ -f "$SCRIPT" ]
}

@test "detect-env.sh is executable" {
    [ -x "$SCRIPT" ]
}

@test "detect-env.sh exits 0 and prints one of the two sentinel values" {
    run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == "HAS_ANDROID_CLI" || "$output" == "NO_ANDROID_CLI" ]]
}

@test "detect-env.sh prints NO_ANDROID_CLI when android is NOT on PATH" {
    # Empty tmpdir as the ONLY PATH dir → command -v android returns false.
    # Resolve bash via an absolute path so the shebang doesn't need to look
    # it up through the (intentionally android-free) PATH.
    TMPBIN="$(mktemp -d)"
    BASH_BIN="$(command -v bash)"
    run env PATH="$TMPBIN" "$BASH_BIN" "$SCRIPT"
    rm -rf "$TMPBIN"
    [ "$status" -eq 0 ]
    [[ "$output" == "NO_ANDROID_CLI" ]]
}

@test "detect-env.sh prints HAS_ANDROID_CLI when a stub android binary on PATH succeeds" {
    TMPBIN="$(mktemp -d)"
    cat > "$TMPBIN/android" << 'EOF'
#!/usr/bin/env bash
# Stub: accept any args, exit 0 silently.
exit 0
EOF
    chmod +x "$TMPBIN/android"
    run env PATH="$TMPBIN:$PATH" bash "$SCRIPT"
    rm -rf "$TMPBIN"
    [ "$status" -eq 0 ]
    [[ "$output" == "HAS_ANDROID_CLI" ]]
}

@test "detect-env.sh prints NO_ANDROID_CLI when android is on PATH but \`android info\` fails" {
    TMPBIN="$(mktemp -d)"
    cat > "$TMPBIN/android" << 'EOF'
#!/usr/bin/env bash
# Stub: simulate an unconfigured android CLI (binary present, info fails).
exit 1
EOF
    chmod +x "$TMPBIN/android"
    run env PATH="$TMPBIN:$PATH" bash "$SCRIPT"
    rm -rf "$TMPBIN"
    [ "$status" -eq 0 ]
    [[ "$output" == "NO_ANDROID_CLI" ]]
}

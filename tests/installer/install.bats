#!/usr/bin/env bats
# Tests for scripts/install.sh and scripts/uninstall.sh

INSTALL_SCRIPT="scripts/install.sh"
UNINSTALL_SCRIPT="scripts/uninstall.sh"

@test "install.sh is executable" {
    [ -x "$INSTALL_SCRIPT" ]
}

@test "uninstall.sh is executable" {
    [ -x "$UNINSTALL_SCRIPT" ]
}

@test "install.sh --help prints usage with no network call" {
    run bash "$INSTALL_SCRIPT" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"Usage:"* ]]
    [[ "$output" == *"--version"* ]]
    [[ "$output" == *"--prefix"* ]]
}

@test "uninstall.sh --help prints usage" {
    run bash "$UNINSTALL_SCRIPT" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"Usage:"* ]]
    [[ "$output" == *"--prefix"* ]]
}

@test "install.sh rejects unsupported platform and exits non-zero" {
    # Override uname to return an unsupported OS
    TMPBIN="$(mktemp -d)"
    cat > "$TMPBIN/uname" << 'EOF'
#!/usr/bin/env bash
echo "FreeBSD"
EOF
    chmod +x "$TMPBIN/uname"
    run env PATH="$TMPBIN:$PATH" bash "$INSTALL_SCRIPT" --version 0.3.0 --prefix /tmp/kmp-test-install-fake
    rm -rf "$TMPBIN"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Unsupported platform"* ]]
}

@test "install.sh rejects unknown flags" {
    run bash "$INSTALL_SCRIPT" --unknown-flag
    [ "$status" -ne 0 ]
}

@test "uninstall.sh exits non-zero when prefix does not exist" {
    run bash "$UNINSTALL_SCRIPT" --prefix "/tmp/kmp-test-runner-does-not-exist-$$"
    [ "$status" -ne 0 ]
    [[ "$output" == *"does not appear to be installed"* ]]
}

@test "install.sh has no eval" {
    run grep -n '\beval\b' "$INSTALL_SCRIPT"
    [ "$status" -ne 0 ]
}

@test "install.sh has set -euo pipefail" {
    run grep -c 'set -euo pipefail' "$INSTALL_SCRIPT"
    [ "$status" -eq 0 ]
    [ "$output" -ge 1 ]
}

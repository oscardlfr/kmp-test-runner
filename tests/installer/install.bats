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

# --------------------------------------------------------------------------
# E2E tests — use local archive (no network). Filtered by `bats --filter E2E`.
# --------------------------------------------------------------------------

setup_e2e_archive() {
    E2E_TMPDIR="$(mktemp -d)"
    E2E_PREFIX="${E2E_TMPDIR}/prefix"
    ARTIFACT_VER="0.3.3"

    # Build a minimal archive that mirrors the real artifact structure
    STAGING="${E2E_TMPDIR}/staging/kmp-test-runner-${ARTIFACT_VER}"
    mkdir -p "${STAGING}/bin" "${STAGING}/lib" "${STAGING}/scripts"

    # Minimal package.json so cli.js can resolve version
    cat > "${STAGING}/package.json" <<EOF
{"name":"kmp-test-runner","version":"${ARTIFACT_VER}"}
EOF

    # Minimal bin/kmp-test.js that reads version from package.json
    cat > "${STAGING}/bin/kmp-test.js" <<'BINEOF'
#!/usr/bin/env node
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(pkg.version); process.exit(0); }
if (args[0] === '--help')    { console.log('kmp-test-runner help'); process.exit(0); }
BINEOF
    chmod +x "${STAGING}/bin/kmp-test.js"

    # Placeholder LICENSE so cp in install.sh doesn't fail
    touch "${STAGING}/LICENSE"

    LOCAL_ARCHIVE="${E2E_TMPDIR}/kmp-test-runner-${ARTIFACT_VER}-linux.tar.gz"
    tar -czf "$LOCAL_ARCHIVE" -C "${E2E_TMPDIR}/staging" "kmp-test-runner-${ARTIFACT_VER}"
    rm -rf "${E2E_TMPDIR}/staging"
}

teardown_e2e_archive() {
    rm -rf "${E2E_TMPDIR:-}"
}

@test "E2E: install.sh installs successfully from local archive" {
    setup_e2e_archive
    run bash "$INSTALL_SCRIPT" \
        --version "$ARTIFACT_VER" \
        --prefix  "$E2E_PREFIX" \
        --archive "$LOCAL_ARCHIVE"
    teardown_e2e_archive
    [ "$status" -eq 0 ]
}

@test "E2E: kmp-test --version matches package.json after install" {
    setup_e2e_archive
    bash "$INSTALL_SCRIPT" \
        --version "$ARTIFACT_VER" \
        --prefix  "$E2E_PREFIX" \
        --archive "$LOCAL_ARCHIVE"
    run node "${E2E_PREFIX}/lib/bin/kmp-test.js" --version
    teardown_e2e_archive
    [ "$status" -eq 0 ]
    [[ "$output" == *"${ARTIFACT_VER}"* ]]
}

@test "E2E: kmp-test --help is non-empty after install" {
    setup_e2e_archive
    bash "$INSTALL_SCRIPT" \
        --version "$ARTIFACT_VER" \
        --prefix  "$E2E_PREFIX" \
        --archive "$LOCAL_ARCHIVE"
    run node "${E2E_PREFIX}/lib/bin/kmp-test.js" --help
    teardown_e2e_archive
    [ "$status" -eq 0 ]
    [ -n "$output" ]
}

@test "E2E: uninstall.sh removes prefix after install" {
    setup_e2e_archive
    bash "$INSTALL_SCRIPT" \
        --version "$ARTIFACT_VER" \
        --prefix  "$E2E_PREFIX" \
        --archive "$LOCAL_ARCHIVE"
    run bash "$UNINSTALL_SCRIPT" --prefix "$E2E_PREFIX"
    teardown_e2e_archive
    [ "$status" -eq 0 ]
    [ ! -d "$E2E_PREFIX" ]
}

@test "E2E: install.sh fails when --archive file is missing" {
    E2E_TMPDIR="$(mktemp -d)"
    E2E_PREFIX="${E2E_TMPDIR}/prefix"
    run bash "$INSTALL_SCRIPT" \
        --version "0.3.3" \
        --prefix  "$E2E_PREFIX" \
        --archive "${E2E_TMPDIR}/does-not-exist.tar.gz"
    rm -rf "$E2E_TMPDIR"
    [ "$status" -ne 0 ]
}

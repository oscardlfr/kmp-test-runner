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

# --------------------------------------------------------------------------
# Shell-detection tests (v0.5.0 Bug D) — point HOME and SHELL at a temp dir
# and assert the installer wrote the expected rc file with the expected
# syntax, and printed the expected per-shell hint.
# --------------------------------------------------------------------------

# Run install.sh in an isolated $HOME / $SHELL context against the local archive.
# Sets E2E_TMPDIR / FAKE_HOME / E2E_PREFIX as side-effects + LOCAL_ARCHIVE.
run_install_with_shell() {
    local shell_name="$1"
    setup_e2e_archive
    FAKE_HOME="${E2E_TMPDIR}/home"
    mkdir -p "$FAKE_HOME"
    HOME="$FAKE_HOME" SHELL="/usr/bin/$shell_name" \
        run bash "$INSTALL_SCRIPT" \
            --version "$ARTIFACT_VER" \
            --prefix  "$E2E_PREFIX" \
            --archive "$LOCAL_ARCHIVE"
}

@test "E2E shell-detect: zsh writes ~/.zshrc with export PATH and prints zsh hint" {
    run_install_with_shell zsh
    [ "$status" -eq 0 ]
    [ -f "${FAKE_HOME}/.zshrc" ]
    grep -q 'export PATH=' "${FAKE_HOME}/.zshrc"
    grep -q "${E2E_PREFIX}/lib/bin" "${FAKE_HOME}/.zshrc"
    [[ "$output" == *"current shell (zsh)"* ]]
    [[ "$output" == *"source ${FAKE_HOME}/.zshrc"* ]]
    teardown_e2e_archive
}

@test "E2E shell-detect: bash writes ~/.bashrc with export PATH and prints bash hint" {
    run_install_with_shell bash
    [ "$status" -eq 0 ]
    [ -f "${FAKE_HOME}/.bashrc" ]
    grep -q 'export PATH=' "${FAKE_HOME}/.bashrc"
    [[ "$output" == *"current shell (bash)"* ]]
    [[ "$output" == *"source ${FAKE_HOME}/.bashrc"* ]]
    teardown_e2e_archive
}

@test "E2E shell-detect: fish writes ~/.config/fish/config.fish with set -gx PATH (fish syntax)" {
    run_install_with_shell fish
    [ "$status" -eq 0 ]
    local rc="${FAKE_HOME}/.config/fish/config.fish"
    [ -f "$rc" ]
    # fish uses `set -gx PATH ... $PATH` (no quotes, not export).
    grep -q '^set -gx PATH ' "$rc"
    [[ "$output" == *"current shell (fish)"* ]]
    [[ "$output" == *"source ${rc}"* ]]
    [[ "$output" == *"set -gx PATH ${E2E_PREFIX}/lib/bin"* ]]
    teardown_e2e_archive
}

@test "E2E shell-detect: unknown shell falls back to ~/.profile + sh hint" {
    run_install_with_shell tcsh
    [ "$status" -eq 0 ]
    [ -f "${FAKE_HOME}/.profile" ]
    grep -q 'export PATH=' "${FAKE_HOME}/.profile"
    [[ "$output" == *"current shell (sh)"* ]]
    [[ "$output" == *"source ${FAKE_HOME}/.profile"* ]]
    teardown_e2e_archive
}

@test "E2E shell-detect: prints 'open a new terminal' fallback for users who don't want to source" {
    run_install_with_shell zsh
    [ "$status" -eq 0 ]
    [[ "$output" == *"open a new terminal"* ]]
    teardown_e2e_archive
}

@test "E2E shell-detect: re-running install on an already-configured rc does NOT duplicate the export line" {
    run_install_with_shell zsh
    [ "$status" -eq 0 ]
    local rc="${FAKE_HOME}/.zshrc"
    local first_count
    first_count="$(grep -c "${E2E_PREFIX}/lib/bin" "$rc")"
    [ "$first_count" -eq 1 ]
    # Re-run with same HOME / SHELL — must be idempotent.
    HOME="$FAKE_HOME" SHELL="/usr/bin/zsh" \
        run bash "$INSTALL_SCRIPT" \
            --version "$ARTIFACT_VER" \
            --prefix  "$E2E_PREFIX" \
            --archive "$LOCAL_ARCHIVE"
    [ "$status" -eq 0 ]
    local second_count
    second_count="$(grep -c "${E2E_PREFIX}/lib/bin" "$rc")"
    [ "$second_count" -eq 1 ]
    teardown_e2e_archive
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

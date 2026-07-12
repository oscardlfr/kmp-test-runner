#!/usr/bin/env bash
set -euo pipefail

REPO="oscardlfr/kmp-test-runner"
PACKAGE="kmp-test-runner"
BIN_NAME="kmp-test"

usage() {
    cat <<'USAGE'
Usage: install.sh [OPTIONS]

Install kmp-test-runner on Linux or macOS.

Options:
  --version <ver>         Install a specific version (default: latest)
  --prefix <dir>          Installation prefix (default: $XDG_DATA_HOME/kmp-test-runner
                          or ~/.local/share/kmp-test-runner)
  --archive <path>        Use a local archive instead of downloading from GitHub
                          (checksum verification skipped unless --archive-sha256 given)
  --archive-sha256 <path> Path to a .sha256 file for offline checksum verification
                          of the archive passed via --archive
  --help                  Print this message and exit

The installer places the runtime under <prefix>/lib/ and creates a symlink
at <prefix>/bin/kmp-test. It then appends <prefix>/bin to PATH in your
shell rc file if it is not already present.

Remote downloads verify the .sha256 file published alongside each GitHub
Release before extraction. Failed installs restore previous components (on
upgrades) or remove empty directories created by this run (on fresh installs).
USAGE
    exit "${1:-0}"
}

# --------------------------------------------------------------------------
# Argument parsing
# --------------------------------------------------------------------------
VERSION=""
PREFIX=""
LOCAL_ARCHIVE=""
LOCAL_ARCHIVE_SHA256=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)
            [[ -z "${2:-}" || "${2:-}" == --* ]] && { echo "Error: --version requires a value" >&2; usage 1; }
            VERSION="$2"; shift 2 ;;
        --prefix)
            [[ -z "${2:-}" || "${2:-}" == --* ]] && { echo "Error: --prefix requires a value" >&2; usage 1; }
            PREFIX="$2"; shift 2 ;;
        --archive)
            [[ -z "${2:-}" || "${2:-}" == --* ]] && { echo "Error: --archive requires a value" >&2; usage 1; }
            LOCAL_ARCHIVE="$2"; shift 2 ;;
        --archive-sha256)
            [[ -z "${2:-}" || "${2:-}" == --* ]] && { echo "Error: --archive-sha256 requires a value" >&2; usage 1; }
            LOCAL_ARCHIVE_SHA256="$2"; shift 2 ;;
        --help|-h) usage 0 ;;
        *) echo "Unknown option: $1" >&2; usage 1 ;;
    esac
done

# --------------------------------------------------------------------------
# Platform detection (Node.js runtime is arch-agnostic — single artifact)
#
# DOWNLOAD_PLATFORM is the suffix used in the release archive name. Only
# `linux` and `windows` artifacts are published per the single-artifact
# policy in CLAUDE.md, so macOS reuses the `linux.tar.gz` (Node + bash
# scripts only — no native binaries to differentiate).
# --------------------------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
    Linux)  PLATFORM="linux";  DOWNLOAD_PLATFORM="linux" ;;
    Darwin) PLATFORM="macos";  DOWNLOAD_PLATFORM="linux" ;;
    *)
        echo "Unsupported platform: $OS" >&2
        echo "Supported: Linux, macOS" >&2
        exit 1
        ;;
esac

# --------------------------------------------------------------------------
# Resolve install prefix (XDG_DATA_HOME or ~/.local/share)
# --------------------------------------------------------------------------
if [[ -z "$PREFIX" ]]; then
    XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
    PREFIX="$XDG_DATA_HOME/$PACKAGE"
fi

INSTALL_DIR="$PREFIX/lib"
BIN_DIR="$PREFIX/bin"
SYMLINK="$BIN_DIR/$BIN_NAME"
MARKER_PATH="$PREFIX/.kmp-test-runner-install.json"

# Track whether prefix/bin existed before this run (used by rollback).
PREFIX_EXISTED=false;  [[ -d "$PREFIX" ]]  && PREFIX_EXISTED=true
BIN_DIR_EXISTED=false; [[ -d "$BIN_DIR" ]] && BIN_DIR_EXISTED=true

# --------------------------------------------------------------------------
# Resolve version
# --------------------------------------------------------------------------
resolve_latest_version() {
    # Primary: redirect URL (no API call, avoids 60/hr rate limit)
    local redirect_url="https://github.com/$REPO/releases/latest"
    local resolved
    resolved="$(curl -fsS -o /dev/null -w '%{url_effective}' -L "$redirect_url" 2>/dev/null)" || true
    if [[ -n "$resolved" ]]; then
        # Extract tag from e.g. .../releases/tag/v0.3.0
        local tag
        tag="$(basename "$resolved")"
        # Strip leading 'v'
        echo "${tag#v}"
        return
    fi

    # Fallback: GitHub API
    local api_url="https://api.github.com/repos/$REPO/releases/latest"
    local tag_name
    tag_name="$(curl -fsS "$api_url" 2>/dev/null \
        | grep -o '"tag_name":"[^"]*"' \
        | cut -d'"' -f4)" || true
    if [[ -n "$tag_name" ]]; then
        echo "${tag_name#v}"
        return
    fi

    echo "Could not resolve latest version. Use --version to specify." >&2
    exit 1
}

if [[ -z "$VERSION" ]]; then
    echo "Resolving latest version..."
    VERSION="$(resolve_latest_version)"
fi

echo "Installing $PACKAGE v$VERSION ($PLATFORM)..."

# --------------------------------------------------------------------------
# Temp directory + cleanup trap (atomic install + rollback)
# --------------------------------------------------------------------------
ARCHIVE_NAME="${PACKAGE}-${VERSION}-${DOWNLOAD_PLATFORM}.tar.gz"
PRIMARY_URL="https://github.com/$REPO/releases/latest/download/$ARCHIVE_NAME"
VERSIONED_URL="https://github.com/$REPO/releases/download/v${VERSION}/$ARCHIVE_NAME"

TMPDIR="$(mktemp -d)"
ARCHIVE_PATH="$TMPDIR/$ARCHIVE_NAME"

# Backup tracking — cleared after all three commit steps succeed.
OLD_INSTALL_BACKUP=""
OLD_SYMLINK_TARGET=""
OLD_MARKER_BACKUP=""

# Commit flags — only remove components that this run actually wrote; never
# remove pre-existing files when a failure occurs before any backup is taken.
STAGING_COMMITTED=false
LAUNCHER_COMMITTED=false

cleanup() {
    local ec=$?
    if [[ $ec -ne 0 ]]; then
        echo "Install failed — rolling back..." >&2
        # Only remove components that this run committed
        if [[ "$STAGING_COMMITTED" == true ]]; then
            rm -rf "$INSTALL_DIR" 2>/dev/null || true
        fi
        if [[ "$LAUNCHER_COMMITTED" == true ]]; then
            rm -f "$SYMLINK" 2>/dev/null || true
        fi
        # Restore previous lib (upgrade only)
        if [[ -n "${OLD_INSTALL_BACKUP:-}" && -d "${OLD_INSTALL_BACKUP:-}" ]]; then
            mv "${OLD_INSTALL_BACKUP}" "$INSTALL_DIR" 2>/dev/null || true
        fi
        # Restore previous launcher (upgrade only)
        if [[ -n "${OLD_SYMLINK_TARGET:-}" ]]; then
            ln -sf "${OLD_SYMLINK_TARGET}" "$SYMLINK" 2>/dev/null || true
        fi
        # Restore previous marker (upgrade only)
        if [[ -n "${OLD_MARKER_BACKUP:-}" && -f "${OLD_MARKER_BACKUP:-}" ]]; then
            mv "${OLD_MARKER_BACKUP}" "$MARKER_PATH" 2>/dev/null || true
        fi
        # Fresh-install: remove empty bin and prefix dirs we created.
        # rmdir is a no-op on non-empty dirs — safe even if the user put files there.
        if [[ "$BIN_DIR_EXISTED" == false ]]; then
            rmdir "$BIN_DIR" 2>/dev/null || true
        fi
        if [[ "$PREFIX_EXISTED" == false ]]; then
            rmdir "$PREFIX" 2>/dev/null || true
        fi
    fi
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

# --------------------------------------------------------------------------
# Checksum helpers
# --------------------------------------------------------------------------
sha256_of() {
    local file="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file" | awk '{print $1}'
    else
        echo "Error: sha256sum or shasum not found." >&2; exit 1
    fi
}

verify_checksum() {
    local archive="$1" sha256_file="$2" expected actual
    expected="$(awk 'NR==1 {print $1}' "$sha256_file" | tr 'A-Z' 'a-z')"
    if [[ ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
        echo "Error: Malformed checksum file — expected a 64-character hex hash." >&2; exit 1
    fi
    actual="$(sha256_of "$archive" | tr 'A-Z' 'a-z')"
    if [[ "$actual" != "$expected" ]]; then
        echo "Error: Checksum mismatch. The archive may be corrupt or tampered with." >&2
        echo "  Expected: $expected" >&2
        echo "  Got:      $actual" >&2
        echo "Try re-running the installer." >&2
        exit 1
    fi
    echo "Checksum verified."
}

# --------------------------------------------------------------------------
# Layout validation
# --------------------------------------------------------------------------
validate_layout() {
    local dir="$1"
    if [[ ! -f "$dir/bin/kmp-test.js" ]]; then
        echo "Error: Archive layout invalid — missing required file: bin/kmp-test.js" >&2
        return 1
    fi
    if [[ ! -f "$dir/package.json" ]]; then
        echo "Error: Archive layout invalid — missing required file: package.json" >&2
        return 1
    fi
    local pkg_name
    pkg_name="$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$dir/package.json" \
        | grep -o '"[^"]*"$' | tr -d '"')" 2>/dev/null || true
    if [[ "$pkg_name" != "kmp-test-runner" ]]; then
        echo "Error: Archive layout invalid — package.json name must be 'kmp-test-runner', got '${pkg_name:-<missing>}'." >&2
        return 1
    fi
}

# --------------------------------------------------------------------------
# Download
# --------------------------------------------------------------------------
download_archive() {
    local url="$1"
    echo "Downloading from $url ..."
    if curl -fsSL -o "$ARCHIVE_PATH" "$url"; then
        return 0
    fi
    return 1
}

if [[ -n "${LOCAL_ARCHIVE:-}" ]]; then
    cp "$LOCAL_ARCHIVE" "$ARCHIVE_PATH"
else
    if ! download_archive "$PRIMARY_URL"; then
        echo "Primary URL failed, trying versioned URL..."
        if ! download_archive "$VERSIONED_URL"; then
            echo "Download failed. Check your network or try --version." >&2
            exit 1
        fi
    fi
fi

# --------------------------------------------------------------------------
# Checksum verification
# --------------------------------------------------------------------------
CHECKSUM_NAME="${ARCHIVE_NAME}.sha256"
CHECKSUM_PATH="$TMPDIR/$CHECKSUM_NAME"

if [[ -z "${LOCAL_ARCHIVE:-}" ]]; then
    echo "Downloading checksum..."
    CHECKSUM_PRIMARY="https://github.com/$REPO/releases/latest/download/$CHECKSUM_NAME"
    CHECKSUM_VERSIONED="https://github.com/$REPO/releases/download/v${VERSION}/$CHECKSUM_NAME"
    if ! curl -fsSL -o "$CHECKSUM_PATH" "$CHECKSUM_PRIMARY" 2>/dev/null; then
        if ! curl -fsSL -o "$CHECKSUM_PATH" "$CHECKSUM_VERSIONED" 2>/dev/null; then
            echo "Error: Could not download checksum file. Refusing to install without verification." >&2
            exit 1
        fi
    fi
    verify_checksum "$ARCHIVE_PATH" "$CHECKSUM_PATH"
elif [[ -n "${LOCAL_ARCHIVE_SHA256:-}" ]]; then
    verify_checksum "$ARCHIVE_PATH" "$LOCAL_ARCHIVE_SHA256"
fi
# Local archive with no --archive-sha256: skip verification (documented in usage).

# --------------------------------------------------------------------------
# Atomic install
# --------------------------------------------------------------------------
STAGING_DIR="$TMPDIR/staging"
mkdir -p "$STAGING_DIR"
echo "Extracting to staging..."
tar -xzf "$ARCHIVE_PATH" -C "$STAGING_DIR" --strip-components=1
validate_layout "$STAGING_DIR"

mkdir -p "$BIN_DIR"

# Back up existing components before any modification (upgrade case).
if [[ -d "$INSTALL_DIR" ]]; then
    OLD_INSTALL_BACKUP="$TMPDIR/old_lib"
    mv "$INSTALL_DIR" "$OLD_INSTALL_BACKUP"
fi
if [[ -L "$SYMLINK" ]]; then
    OLD_SYMLINK_TARGET="$(readlink "$SYMLINK")"
    rm -f "$SYMLINK"
elif [[ -e "$SYMLINK" ]]; then
    rm -f "$SYMLINK"
fi
if [[ -f "$MARKER_PATH" ]]; then
    OLD_MARKER_BACKUP="$TMPDIR/old_marker.json"
    mv "$MARKER_PATH" "$OLD_MARKER_BACKUP"
fi

# Commit: lib
echo "Installing to $INSTALL_DIR ..."
mv "$STAGING_DIR" "$INSTALL_DIR"
STAGING_COMMITTED=true

# Commit: launcher
ln -s "$INSTALL_DIR/bin/$BIN_NAME.js" "$SYMLINK"
chmod +x "$SYMLINK"
LAUNCHER_COMMITTED=true

# Commit: marker — staged move is the final commit point.
STAGED_MARKER="$TMPDIR/.kmp-test-runner-install.json"
printf '{"tool":"kmp-test-runner","schema":1,"version":"%s"}\n' "$VERSION" > "$STAGED_MARKER"
mv "$STAGED_MARKER" "$MARKER_PATH"

# Release backup tracking — install is now committed; rollback no longer needed.
OLD_INSTALL_BACKUP=""; OLD_SYMLINK_TARGET=""; OLD_MARKER_BACKUP=""

# --------------------------------------------------------------------------
# PATH setup — append to shell rc if not already present.
# Honors the user's $SHELL: zsh → ~/.zshrc, bash → ~/.bashrc, fish →
# ~/.config/fish/config.fish (different syntax!), other → ~/.profile.
# --------------------------------------------------------------------------
configure_path() {
    local rc_file="$1"
    local shell="$2"
    local export_line
    case "$shell" in
        # fish uses set -gx, NOT export. Quoted "fish" detection on parent
        # process avoids spurious matches against names containing "fish".
        fish) export_line="set -gx PATH $BIN_DIR \$PATH" ;;
        *)    export_line="export PATH=\"$BIN_DIR:\$PATH\"" ;;
    esac

    if [[ -f "$rc_file" ]] && grep -qF "$BIN_DIR" "$rc_file" 2>/dev/null; then
        return 0
    fi

    # Ensure parent dir exists (relevant for fish: ~/.config/fish/ may not).
    mkdir -p "$(dirname "$rc_file")"
    printf '\n# kmp-test-runner\n%s\n' "$export_line" >> "$rc_file"
    echo "Added $BIN_DIR to PATH in $rc_file"
}

SHELL_NAME="$(basename "${SHELL:-/bin/sh}")"
case "$SHELL_NAME" in
    zsh)  RC_FILE="$HOME/.zshrc";                  configure_path "$RC_FILE" zsh ;;
    bash) RC_FILE="$HOME/.bashrc";                 configure_path "$RC_FILE" bash ;;
    fish) RC_FILE="$HOME/.config/fish/config.fish"; configure_path "$RC_FILE" fish ;;
    *)    RC_FILE="$HOME/.profile";                configure_path "$RC_FILE" sh
          SHELL_NAME="sh" ;;
esac

# --------------------------------------------------------------------------
# Done — per-shell hint so users can use kmp-test in the CURRENT shell
# without restarting. Bug D fix (v0.5.0): old behavior printed a generic
# "Restart your shell or run: export PATH=..." line that didn't match the
# user's shell (broken for fish, redundant for zsh/bash if they prefer
# `source ~/.zshrc`).
# --------------------------------------------------------------------------
echo ""
echo "kmp-test-runner v$VERSION installed successfully."
echo "  Binary : $SYMLINK"
echo "  Runtime: $INSTALL_DIR"
echo ""
echo "To use kmp-test in your current shell ($SHELL_NAME), run ONE of:"
case "$SHELL_NAME" in
    fish)
        echo "  set -gx PATH $BIN_DIR \$PATH"
        echo "  source $RC_FILE"
        ;;
    *)
        echo "  export PATH=\"$BIN_DIR:\$PATH\""
        echo "  source $RC_FILE"
        ;;
esac
echo ""
echo "Or open a new terminal — kmp-test will be on PATH automatically."
echo "Then verify with: kmp-test --version"

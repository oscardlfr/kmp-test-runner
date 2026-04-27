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
  --version <ver>   Install a specific version (default: latest)
  --prefix <dir>    Installation prefix (default: $XDG_DATA_HOME/kmp-test-runner
                    or ~/.local/share/kmp-test-runner)
  --archive <path>  Use a local archive instead of downloading from GitHub
  --help            Print this message and exit

The installer places the runtime under <prefix>/lib/ and creates a symlink
at <prefix>/bin/kmp-test. It then appends <prefix>/bin to PATH in your
shell rc file if it is not already present.
USAGE
    exit "${1:-0}"
}

# --------------------------------------------------------------------------
# Argument parsing
# --------------------------------------------------------------------------
VERSION=""
PREFIX=""
LOCAL_ARCHIVE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        --prefix)  PREFIX="$2";  shift 2 ;;
        --archive) LOCAL_ARCHIVE="$2"; shift 2 ;;
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
# Download
# --------------------------------------------------------------------------
ARCHIVE_NAME="${PACKAGE}-${VERSION}-${DOWNLOAD_PLATFORM}.tar.gz"
PRIMARY_URL="https://github.com/$REPO/releases/latest/download/$ARCHIVE_NAME"
VERSIONED_URL="https://github.com/$REPO/releases/download/v${VERSION}/$ARCHIVE_NAME"

TMPDIR="$(mktemp -d)"
# shellcheck disable=SC2064
trap "rm -rf '$TMPDIR'" EXIT

ARCHIVE_PATH="$TMPDIR/$ARCHIVE_NAME"

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
# Extract and install
# --------------------------------------------------------------------------
mkdir -p "$INSTALL_DIR" "$BIN_DIR"

echo "Extracting to $INSTALL_DIR ..."
tar -xzf "$ARCHIVE_PATH" -C "$INSTALL_DIR" --strip-components=1

# Create symlink
SYMLINK="$BIN_DIR/$BIN_NAME"
if [[ -L "$SYMLINK" || -e "$SYMLINK" ]]; then
    rm -f "$SYMLINK"
fi
ln -s "$INSTALL_DIR/bin/$BIN_NAME.js" "$SYMLINK"
chmod +x "$SYMLINK"

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

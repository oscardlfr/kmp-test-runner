#!/usr/bin/env bash
set -euo pipefail

PACKAGE="kmp-test-runner"
BIN_NAME="kmp-test"

usage() {
    cat <<'USAGE'
Usage: uninstall.sh [OPTIONS]

Remove kmp-test-runner from Linux or macOS.

Options:
  --prefix <dir>  Installation prefix (default: $XDG_DATA_HOME/kmp-test-runner
                  or ~/.local/share/kmp-test-runner)
  --help          Print this message and exit
USAGE
    exit "${1:-0}"
}

PREFIX=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --prefix) PREFIX="$2"; shift 2 ;;
        --help|-h) usage 0 ;;
        *) echo "Unknown option: $1" >&2; usage 1 ;;
    esac
done

if [[ -z "$PREFIX" ]]; then
    XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
    PREFIX="$XDG_DATA_HOME/$PACKAGE"
fi

BIN_DIR="$PREFIX/bin"
SYMLINK="$BIN_DIR/$BIN_NAME"

if [[ ! -d "$PREFIX" ]]; then
    echo "kmp-test-runner does not appear to be installed at $PREFIX" >&2
    exit 1
fi

echo "Removing $PACKAGE from $PREFIX ..."

if [[ -L "$SYMLINK" || -e "$SYMLINK" ]]; then
    rm -f "$SYMLINK"
    echo "Removed symlink: $SYMLINK"
fi

rm -rf "$PREFIX"
echo "Removed directory: $PREFIX"

echo ""
echo "kmp-test-runner uninstalled."
echo "You may also remove the PATH entry from your shell rc file manually."

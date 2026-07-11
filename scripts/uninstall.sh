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
        --prefix)
            [[ -z "${2:-}" || "${2:-}" == --* ]] && { echo "Error: --prefix requires a value" >&2; usage 1; }
            PREFIX="$2"; shift 2 ;;
        --help|-h) usage 0 ;;
        *) echo "Unknown option: $1" >&2; usage 1 ;;
    esac
done

if [[ -z "$PREFIX" ]]; then
    XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
    PREFIX="$XDG_DATA_HOME/$PACKAGE"
fi

# --------------------------------------------------------------------------
# Canonicalize prefix (resolve symlinks to prevent symlink-to-home attacks)
# --------------------------------------------------------------------------
if [[ -d "$PREFIX" ]]; then
    CANON_PREFIX="$(cd "$PREFIX" && pwd -P)"
else
    CANON_PREFIX="$PREFIX"
fi

# --------------------------------------------------------------------------
# Hard guards — refuse protected paths before any filesystem mutation
# --------------------------------------------------------------------------
if [[ -z "$CANON_PREFIX" ]]; then
    echo "Error: resolved installation prefix is empty." >&2
    exit 1
fi

if [[ "$CANON_PREFIX" == "/" ]]; then
    echo "Error: refusing to remove filesystem root '/'." >&2
    exit 1
fi

real_home="$(cd "$HOME" && pwd -P 2>/dev/null || echo "$HOME")"
if [[ "$CANON_PREFIX" == "$real_home" ]]; then
    echo "Error: refusing to remove home directory '$real_home'." >&2
    exit 1
fi

# --------------------------------------------------------------------------
# Existence check
# --------------------------------------------------------------------------
if [[ ! -d "$CANON_PREFIX" ]]; then
    echo "kmp-test-runner does not appear to be installed at $PREFIX" >&2
    exit 1
fi

# --------------------------------------------------------------------------
# Ownership validation helpers
# --------------------------------------------------------------------------
_validate_package_json() {
    local prefix="$1"
    local pjson="$prefix/lib/package.json"
    [[ -f "$pjson" ]] && grep -Eq '"name"[[:space:]]*:[[:space:]]*"kmp-test-runner"' "$pjson" 2>/dev/null
}

_validate_runtime_entry() {
    local prefix="$1"
    [[ -f "$prefix/lib/bin/$BIN_NAME.js" ]]
}

_validate_launcher_posix() {
    local prefix="$1"
    local launcher="$prefix/bin/$BIN_NAME"
    # Must be a symlink
    [[ -L "$launcher" ]] || return 1
    # Target must resolve to <prefix>/lib/bin/<BIN_NAME>.js
    local target
    target="$(readlink "$launcher" 2>/dev/null)" || return 1
    # Canonicalize target path via pwd -P so both absolute and relative targets
    # are resolved through the real filesystem (handles macOS /var -> /private/var).
    case "$target" in
        /*)
            if [[ -e "$target" ]]; then
                target="$(cd "$(dirname "$target")" && pwd -P)/$(basename "$target")"
            fi
            ;;
        *) target="$(cd "$(dirname "$launcher")" && cd "$(dirname "$target")" && pwd -P)/$(basename "$target")" ;;
    esac
    [[ "$target" == "$prefix/lib/bin/$BIN_NAME.js" ]]
}

_validate_marker() {
    local marker="$1"
    [[ -f "$marker" ]] && grep -qF '"tool":"kmp-test-runner"' "$marker" 2>/dev/null
}

_validate_layout_ownership() {
    local prefix="$1"
    _validate_package_json "$prefix" &&
        _validate_runtime_entry "$prefix" &&
        _validate_launcher_posix "$prefix"
}

_validate_legacy_layout() {
    local prefix="$1"
    [[ "$(basename "$prefix")" == "$PACKAGE" ]] || return 1
    _validate_layout_ownership "$prefix"
}

# --------------------------------------------------------------------------
# Decide whether to proceed: marker+layout (Path A) or legacy adoption (Path B)
# --------------------------------------------------------------------------
MARKER_PATH="$CANON_PREFIX/.kmp-test-runner-install.json"

if _validate_marker "$MARKER_PATH" && _validate_layout_ownership "$CANON_PREFIX"; then
    : # marker + layout valid — proceed
elif _validate_legacy_layout "$CANON_PREFIX"; then
    echo "Legacy install detected — validating layout and adopting..."
    printf '{"tool":"kmp-test-runner","schema":1,"version":"legacy"}\n' > "$MARKER_PATH"
    echo "Adopted install at $CANON_PREFIX."
else
    echo "Error: $PREFIX does not contain a valid kmp-test-runner install." >&2
    echo "  No valid install marker+layout or recognizable legacy layout found." >&2
    echo "  Inspect the directory manually and remove it only if you are certain it is safe." >&2
    exit 1
fi

# --------------------------------------------------------------------------
# Remove installation
# --------------------------------------------------------------------------
echo "Removing $PACKAGE from $CANON_PREFIX ..."

SYMLINK="$CANON_PREFIX/bin/$BIN_NAME"
if [[ -L "$SYMLINK" || -e "$SYMLINK" ]]; then
    rm -f "$SYMLINK"
    echo "Removed symlink: $SYMLINK"
fi

rm -rf "$CANON_PREFIX"
echo "Removed directory: $CANON_PREFIX"

echo ""
echo "kmp-test-runner uninstalled."
echo "You may also remove the PATH entry from your shell rc file manually."

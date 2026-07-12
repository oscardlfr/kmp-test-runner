#!/usr/bin/env bash
# Build local release artifacts for E2E installer tests (mirrors publish-release.yml "Build artifacts" step).
# Usage: bash scripts/build-artifact.sh <version> <output-dir>
set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <version> <output-dir>" >&2
    exit 1
fi

VERSION="$1"
OUTPUT_DIR="$2"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

mkdir -p "$OUTPUT_DIR"

WRAPPER="kmp-test-runner-${VERSION}"
STAGING_ROOT="${OUTPUT_DIR}/staging-${VERSION}"
STAGING="${STAGING_ROOT}/${WRAPPER}"
mkdir -p "$STAGING"

cp -r \
    "$REPO_ROOT/bin" \
    "$REPO_ROOT/lib" \
    "$REPO_ROOT/scripts" \
    "$REPO_ROOT/LICENSE" \
    "$REPO_ROOT/CHANGELOG.md" \
    "$REPO_ROOT/package.json" \
    "$STAGING/"

LINUX_ARCHIVE="${OUTPUT_DIR}/kmp-test-runner-${VERSION}-linux.tar.gz"
tar -czf "$LINUX_ARCHIVE" -C "$STAGING_ROOT" "$WRAPPER"
echo "linux_archive=$LINUX_ARCHIVE"

WINDOWS_ARCHIVE=""
if command -v zip >/dev/null 2>&1; then
    WINDOWS_ARCHIVE="${OUTPUT_DIR}/kmp-test-runner-${VERSION}-windows.zip"
    (cd "$STAGING_ROOT" && zip -r "../$(basename "$WINDOWS_ARCHIVE")" "$WRAPPER")
    echo "windows_archive=$WINDOWS_ARCHIVE"
fi

rm -rf "$STAGING_ROOT"

# Generate SHA-256 checksums (mirrors publish-release.yml Step 6).
sha256_file() {
    local f="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$f"
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$f"
    fi
}

if sha256_file "$LINUX_ARCHIVE" > "${LINUX_ARCHIVE}.sha256" 2>/dev/null; then
    echo "linux_sha256=${LINUX_ARCHIVE}.sha256"
fi
if [[ -n "${WINDOWS_ARCHIVE:-}" ]] && sha256_file "$WINDOWS_ARCHIVE" > "${WINDOWS_ARCHIVE}.sha256" 2>/dev/null; then
    echo "windows_sha256=${WINDOWS_ARCHIVE}.sha256"
fi

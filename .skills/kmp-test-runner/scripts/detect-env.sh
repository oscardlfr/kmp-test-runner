#!/usr/bin/env bash
# Detect whether Google's `android` CLI is available + reachable.
#
# Prints HAS_ANDROID_CLI to stdout when the binary is on PATH AND
# `android info` succeeds; NO_ANDROID_CLI otherwise. Exits 0 either way —
# the value is the signal, not the exit code (so callers can branch on
# stdout without retry logic or special-casing exit codes).
#
# Used by run-tests.sh as an env preamble and by SKILL.md workflows that
# branch on the enriched-vs-fallback instrumented test surface.
#
# Usage: bash detect-env.sh
set -euo pipefail

if command -v android >/dev/null 2>&1 && android info >/dev/null 2>&1; then
  echo "HAS_ANDROID_CLI"
else
  echo "NO_ANDROID_CLI"
fi

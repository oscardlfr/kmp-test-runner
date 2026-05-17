#!/usr/bin/env bash
# Convenience wrapper for kmp-test. Picks the subcommand from the first
# positional arg (default: unit), forwards everything else verbatim, and
# auto-injects --json + --project-root . so the call is location-agnostic
# and produces a single parseable envelope on stdout.
#
# For `android` type, an env preamble runs detect-env.sh first and prints
# [INFO] env: HAS_ANDROID_CLI|NO_ANDROID_CLI to stderr — the agent can
# branch on the enriched-vs-fallback troubleshooting workflow without
# parsing it out of the envelope.
#
# Usage:
#   bash run-tests.sh [TYPE] [extra kmp-test args...]
#   bash run-tests.sh --help
#
# TYPE: unit (default) | android | coverage | benchmark | changed |
#       info | doctor | describe
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

print_usage() {
  cat <<'EOF'
Usage: bash run-tests.sh [TYPE] [extra kmp-test args...]

TYPE (first positional arg, default = unit):
  unit        → kmp-test parallel --json
  android     → kmp-test android --json
  coverage    → kmp-test coverage --json
  benchmark   → kmp-test benchmark --json
  changed     → kmp-test changed --json
  info        → kmp-test info --json
  doctor      → kmp-test doctor --json
  describe    → kmp-test describe --json

Extra args after TYPE are forwarded verbatim. --json and
--project-root . are injected automatically.

For `android`, an env preamble runs detect-env.sh and prints
[INFO] env: HAS_ANDROID_CLI|NO_ANDROID_CLI to stderr.
EOF
}

# Help flag may appear in any position; check first arg.
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_usage
  exit 0
fi

# First positional → subcommand. Default to unit.
TYPE="${1:-unit}"
shift || true

case "$TYPE" in
  unit)       SUB="parallel" ;;
  android)    SUB="android" ;;
  coverage)   SUB="coverage" ;;
  benchmark)  SUB="benchmark" ;;
  changed)    SUB="changed" ;;
  info)       SUB="info" ;;
  doctor)     SUB="doctor" ;;
  describe)   SUB="describe" ;;
  *)
    echo "run-tests.sh: unknown TYPE '$TYPE'" >&2
    print_usage >&2
    exit 2
    ;;
esac

# Env preamble for instrumented dispatch. Skipped for info/doctor/describe
# where adb isn't relevant to the operation.
case "$TYPE" in
  android)
    if [[ -x "$SCRIPT_DIR/detect-env.sh" ]]; then
      echo "[INFO] env: $(bash "$SCRIPT_DIR/detect-env.sh")" >&2
    fi
    ;;
esac

exec kmp-test "$SUB" --json --project-root . "$@"

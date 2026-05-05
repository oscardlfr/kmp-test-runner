#!/usr/bin/env bash
# kmp-test-runner — changed-modules orchestrator wrapper (Node-backed since v0.8).
# Logic lives in lib/changed-orchestrator.js. This wrapper passes argv through
# verbatim. PRODUCT.md "logic in Node, plumbing in shell".
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/../../lib/runner.js" changed "$@"

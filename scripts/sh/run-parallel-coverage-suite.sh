#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# v0.8 PIVOT (sub-entry 5): this wrapper is now a thin Node launcher. The
# entire bash orchestration logic (~1,701 LOC of module discovery, gradle
# dispatch, parallel execution, result parsing, coverage aggregation) moved
# to lib/parallel-orchestrator.js + lib/coverage-orchestrator.js.
#
# Behavior preserved:
#   1. --skip-tests routes to coverage-orchestrator (sub-entry 4 contract).
#   2. Otherwise routes to parallel-orchestrator.
#   3. All flags pass through verbatim. The Node side parses them.
#
# CrossShapeParityTest (gradle-plugin TestKit) keys off this script's basename
# and the --project-root flag — both preserved.
set -euo pipefail

_KMP_SD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect --skip-tests once — coverage subcommand routes here too via the
# COMMANDS table prefix (lib/cli.js#COMMANDS.coverage). Path to lib/runner.js
# is inlined (vs hoisted to a variable) so cross-shape probes that grep this
# wrapper for `lib/runner.js coverage` / `lib/runner.js parallel` succeed.
for _kmp_arg in "$@"; do
  if [[ "$_kmp_arg" == "--skip-tests" ]]; then
    exec node "$_KMP_SD/../../lib/runner.js" coverage "$@"
  fi
done

exec node "$_KMP_SD/../../lib/runner.js" parallel "$@"

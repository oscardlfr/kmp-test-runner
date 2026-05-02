#!/usr/bin/env bats
# Wrapper-invocation contracts for scripts/sh/run-benchmarks.sh.
#
# Behavioral coverage moved to tests/vitest/benchmark-orchestrator.test.js
# in v0.8 (PRODUCT.md "logic in Node, plumbing in shell"). This file's job
# is to lock the wrapper shape so the benchmark feature never re-grows
# bash plumbing under shellcheck's blind spots.

SCRIPT="scripts/sh/run-benchmarks.sh"

@test "benchmark wrapper: exec's into node lib/runner.js benchmark" {
    grep -qE 'exec node ' "$SCRIPT"
    grep -qE 'lib/runner\.js' "$SCRIPT"
    grep -qE ' benchmark ' "$SCRIPT"
}

@test "benchmark wrapper: ≤50 LOC (PRODUCT.md cap, target ≤10)" {
    local lines
    lines=$(wc -l < "$SCRIPT")
    [[ "$lines" -le 50 ]]
}

@test "benchmark wrapper: no associative arrays (declare -A)" {
    ! grep -q 'declare -A' "$SCRIPT"
}

@test "benchmark wrapper: no parallel loops (no trailing & or wait)" {
    ! grep -qE '^\s*[^#]*&\s*$' "$SCRIPT"
    ! grep -qE '^\s*wait\s*$' "$SCRIPT"
}

@test "benchmark wrapper: passes argv through verbatim" {
    grep -qE '"\$@"' "$SCRIPT"
}

@test "benchmark wrapper: no output parsing (no awk/sed/cut/grep on gradle output)" {
    # Wrappers must not try to parse what gradle prints — that's the
    # orchestrator's job. Fail if we see piped data extraction commands.
    ! grep -qE '\| (awk|sed|cut|grep)\b' "$SCRIPT"
}

@test "benchmark wrapper: uses set -euo pipefail (safe defaults)" {
    grep -qE '^set -euo pipefail' "$SCRIPT"
}

@test "benchmark wrapper: SCRIPT_DIR resolution is portable (no /Users/, /home/)" {
    ! grep -qE '/Users/|/home/|/root/' "$SCRIPT"
    grep -q 'SCRIPT_DIR=' "$SCRIPT"
}

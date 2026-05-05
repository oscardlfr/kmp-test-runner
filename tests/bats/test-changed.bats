#!/usr/bin/env bats
# Wrapper-invocation contracts for scripts/sh/run-changed-modules-tests.sh.
#
# Behavioral coverage moved to tests/vitest/changed-orchestrator.test.js in
# v0.8 sub-entry 2 (PRODUCT.md "logic in Node, plumbing in shell"). This
# file's job is to lock the wrapper shape so the changed feature never
# re-grows bash plumbing under shellcheck's blind spots.

SCRIPT="scripts/sh/run-changed-modules-tests.sh"

@test "changed wrapper: exec's into node lib/runner.js changed" {
    grep -qE 'exec node ' "$SCRIPT"
    grep -qE 'lib/runner\.js' "$SCRIPT"
    grep -qE ' changed ' "$SCRIPT"
}

@test "changed wrapper: ≤40 LOC (BACKLOG sub-entry 2 cap, target ≤10)" {
    local lines
    lines=$(wc -l < "$SCRIPT")
    [[ "$lines" -le 40 ]]
}

@test "changed wrapper: no associative arrays (declare -A)" {
    ! grep -q 'declare -A' "$SCRIPT"
}

@test "changed wrapper: no parallel loops (no trailing & or wait)" {
    ! grep -qE '^\s*[^#]*&\s*$' "$SCRIPT"
    ! grep -qE '^\s*wait\s*$' "$SCRIPT"
}

@test "changed wrapper: passes argv through verbatim" {
    grep -qE '"\$@"' "$SCRIPT"
}

@test "changed wrapper: no output parsing (no awk/sed/cut/grep on gradle output)" {
    # Wrappers must not try to parse what gradle prints — that's the
    # orchestrator's job. Fail if we see piped data extraction commands.
    ! grep -qE '\| (awk|sed|cut|grep)\b' "$SCRIPT"
}

@test "changed wrapper: uses set -euo pipefail (safe defaults)" {
    grep -qE '^set -euo pipefail' "$SCRIPT"
}

@test "changed wrapper: SCRIPT_DIR resolution is portable (no /Users/, /home/)" {
    ! grep -qE '/Users/|/home/|/root/' "$SCRIPT"
    grep -q 'SCRIPT_DIR=' "$SCRIPT"
}

@test "changed wrapper: no git-status/git-diff parsing in shell (orchestrator owns it)" {
    # WS-4 root cause was a hand-rolled get_changed_files+get_module_from_file
    # in the wrapper. The Node orchestrator owns this now.
    ! grep -qE 'git status --porcelain|git diff --cached' "$SCRIPT"
    ! grep -qE 'get_module_from_file|get_changed_files' "$SCRIPT"
}

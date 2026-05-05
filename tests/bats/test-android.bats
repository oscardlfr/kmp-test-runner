#!/usr/bin/env bats
# Wrapper-invocation contracts for scripts/sh/run-android-tests.sh.
#
# Behavioral coverage moved to tests/vitest/android-orchestrator.test.js in
# v0.8 sub-entry 3 (PRODUCT.md "logic in Node, plumbing in shell"). This
# file's job is to lock the wrapper shape so the android feature never
# re-grows bash plumbing under shellcheck's blind spots.

SCRIPT="scripts/sh/run-android-tests.sh"

@test "android wrapper: exec's into node lib/runner.js android" {
    grep -qE 'exec node ' "$SCRIPT"
    grep -qE 'lib/runner\.js' "$SCRIPT"
    grep -qE ' android ' "$SCRIPT"
}

@test "android wrapper: ≤50 LOC (BACKLOG sub-entry 3 cap, target ≤10)" {
    local lines
    lines=$(wc -l < "$SCRIPT")
    [[ "$lines" -le 50 ]]
}

@test "android wrapper: no associative arrays (declare -A)" {
    ! grep -q 'declare -A' "$SCRIPT"
}

@test "android wrapper: no parallel loops (no trailing & or wait)" {
    ! grep -qE '^\s*[^#]*&\s*$' "$SCRIPT"
    ! grep -qE '^\s*wait\s*$' "$SCRIPT"
}

@test "android wrapper: passes argv through verbatim" {
    grep -qE '"\$@"' "$SCRIPT"
}

@test "android wrapper: no output parsing (no awk/sed/cut/grep on gradle output)" {
    # Wrappers must not try to parse what gradle prints — that's the
    # orchestrator's job. Fail if we see piped data extraction commands.
    ! grep -qE '\| (awk|sed|cut|grep)\b' "$SCRIPT"
}

@test "android wrapper: uses set -euo pipefail (safe defaults)" {
    grep -qE '^set -euo pipefail' "$SCRIPT"
}

@test "android wrapper: SCRIPT_DIR resolution is portable (no /Users/, /home/)" {
    ! grep -qE '/Users/|/home/|/root/' "$SCRIPT"
    grep -q 'SCRIPT_DIR=' "$SCRIPT"
}

@test "android wrapper: no adb / find walkers in shell (orchestrator owns discovery)" {
    # WS-3 root cause was a hand-rolled find -name androidTest discovery
    # in the wrapper. The Node orchestrator owns this now via lib/project-model.js.
    ! grep -qE 'find .* -name "androidTest"' "$SCRIPT"
    ! grep -qE 'discover_android_test_modules' "$SCRIPT"
}

@test "android wrapper: no inline-Python summary builder (orchestrator emits via JSON.stringify)" {
    # The 784-LOC bash wrapper used inline `python3 -c '...'` to write summary.json.
    # The orchestrator emits the same shape via JSON.stringify. Lock the
    # bash-side absence so a future refactor can't re-introduce it.
    ! grep -qE 'python3? -c' "$SCRIPT"
}

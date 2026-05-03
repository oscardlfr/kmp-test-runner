#!/usr/bin/env bats
# Tests for the Gradle 9 deprecation notice handling.
# v0.5.0 (Bug C): coverage script uses [NOTICE] (not [!]) for the benign
# "gradle exited 1 but all tasks passed" case.
# v0.5.1 (Bug C'): logic extracted to script-utils.sh::gate_gradle_exit_for_deprecation
# and reused by both the test-execution AND coverage-generation passes.

PARALLEL="scripts/sh/run-parallel-coverage-suite.sh"
HELPER="scripts/sh/lib/script-utils.sh"

# v0.8 sub-entry 5: parallel.sh is now a thin Node launcher; the notice()
# helper + gate_gradle_exit_for_deprecation invocations moved into
# lib/parallel-orchestrator.js (where exit code classification + warnings
# are computed in JS). The script-utils.sh helper itself is still tested
# below since it remains a load-bearing utility for any remaining bash
# consumers (e.g. tests/installer/).

@test "script-utils.sh: gate_gradle_exit_for_deprecation defined" {
    grep -q '^gate_gradle_exit_for_deprecation()' "$HELPER"
}

@test "gate: exit 0 returns 0 with no message (success path)" {
    # shellcheck disable=SC1090
    source "$HELPER"
    set +e
    msg="$(gate_gradle_exit_for_deprecation 0 5 0 5 'tests')"
    rc=$?
    set -e
    [[ "$rc" -eq 0 ]]
    [[ -z "$msg" ]]
}

@test "gate: exit non-zero, all tasks passed -> [NOTICE], rc 0 (deprecation)" {
    # shellcheck disable=SC1090
    source "$HELPER"
    set +e
    msg="$(gate_gradle_exit_for_deprecation 1 5 0 5 'tests')"
    rc=$?
    set -e
    [[ "$rc" -eq 0 ]]
    [[ "$msg" == *'[NOTICE]'* ]]
    [[ "$msg" == *'tasks passed individually'* ]]
    [[ "$msg" == *'(tests)'* ]]
}

@test "gate: exit non-zero, zero results -> [!], rc 1 (env error)" {
    # shellcheck disable=SC1090
    source "$HELPER"
    set +e
    msg="$(gate_gradle_exit_for_deprecation 1 0 0 5 'tests')"
    rc=$?
    set -e
    [[ "$rc" -eq 1 ]]
    [[ "$msg" == *'[!]'* ]]
    [[ "$msg" == *'no task results found'* ]]
}

@test "gate: exit non-zero, mixed pass/fail -> rc 2 (no message)" {
    # shellcheck disable=SC1090
    source "$HELPER"
    set +e
    msg="$(gate_gradle_exit_for_deprecation 1 3 2 5 'tests')"
    rc=$?
    set -e
    [[ "$rc" -eq 2 ]]
    [[ -z "$msg" ]]
}

@test "gate: context label is interpolated into both message variants" {
    # shellcheck disable=SC1090
    source "$HELPER"
    local msg
    set +e
    msg="$(gate_gradle_exit_for_deprecation 1 4 0 4 'coverage')"
    [[ "$msg" == *'(coverage)'* ]]
    msg="$(gate_gradle_exit_for_deprecation 1 0 0 4 'shared coverage')"
    set -e
    [[ "$msg" == *'(shared coverage)'* ]]
}

# Wrapper-grep tests removed in sub-entry 5: the wrapper no longer invokes
# gate_gradle_exit_for_deprecation. Equivalent classification (passed/failed/
# mixed-with-deprecation) lives in lib/parallel-orchestrator.js and is
# covered by tests/vitest/parallel-orchestrator.test.js exit-code cases.

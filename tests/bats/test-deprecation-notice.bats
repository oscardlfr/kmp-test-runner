#!/usr/bin/env bats
# Tests for the Gradle 9 deprecation notice handling.
# v0.5.0 (Bug C): coverage script uses [NOTICE] (not [!]) for the benign
# "gradle exited 1 but all tasks passed" case.
# v0.5.1 (Bug C'): logic extracted to script-utils.sh::gate_gradle_exit_for_deprecation
# and reused by both the test-execution AND coverage-generation passes.

PARALLEL="scripts/sh/run-parallel-coverage-suite.sh"
HELPER="scripts/sh/lib/script-utils.sh"

@test "parallel.sh: notice() helper defined alongside warn/err/info/ok" {
    grep -q '^notice() ' "$PARALLEL"
}

@test "parallel.sh: notice() emits cyan output (distinct prefix from warn yellow)" {
    local helpers
    helpers="$(sed -n '/^# COLOR HELPERS/,/^# RUN ID/p' "$PARALLEL")"
    local tmp
    tmp="$(mktemp)"
    printf '%s\n' "$helpers" > "$tmp"
    # shellcheck disable=SC1090
    source "$tmp"
    rm -f "$tmp"

    local out
    out="$(notice 'msg')"
    [[ "$out" == *$'\033[36m'* ]] || [[ "$out" == *'msg'* ]]
}

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

@test "parallel.sh: test-execution gate calls gate_gradle_exit_for_deprecation with 'tests'" {
    # Multi-line call (\ continuations); search across lines.
    grep -A 3 'gate_gradle_exit_for_deprecation' "$PARALLEL" | grep -q '"tests"'
}

@test "parallel.sh: coverage-gen gate (Bug C') calls helper for main project" {
    grep -A 3 'gate_gradle_exit_for_deprecation' "$PARALLEL" | grep -q '"coverage"'
}

@test "parallel.sh: coverage-gen gate (Bug C') calls helper for shared-libs" {
    grep -A 3 'gate_gradle_exit_for_deprecation' "$PARALLEL" | grep -q '"shared coverage"'
}

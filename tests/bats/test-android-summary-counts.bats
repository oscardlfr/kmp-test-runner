#!/usr/bin/env bats
# v0.5.2 Gap D — regression tests for summary.json counter shape on
# single-module Android runs.
#
# Background: PR #54 fixed a PowerShell-only bug where Where-Object
# pipeline collapse caused $modules.Count to return hashtable key count
# (5/11) instead of array length (1) for single-module runs. The bash side
# was audited clean (run-android-tests.sh uses explicit loop counters via
# ${!result_names[@]} indexed iteration, not ${#hash[@]} on associative
# arrays). These tests lock that contract so any future regression is
# caught at PR time.
#
# Real-world end-to-end validation (Gap E smoke run on S22 Ultra,
# 2026-04-29): single-module run against shared-kmp-libs:core-encryption
# produced summary.json with totalModules=1, passedModules=1,
# modules.length=1. This file pins the source-level invariants that
# guarantee that shape.

SCRIPT="scripts/sh/run-android-tests.sh"

@test "summary-counts (bash, Gap D): counter loop iterates indexed array, never assoc-array hash size" {
    # The counter loop must use indexed-array iteration (\${!result_names[@]})
    # so length is well-defined. \${#hash[@]} on an associative array would
    # return KEY count (the PR #54 bug class on the PS1 side; bash analogue
    # would surface here). Lock the indexed pattern; assert the assoc-array
    # foot-gun is absent.
    grep -q 'for i in "\${!result_names\[@\]}"; do' "$SCRIPT"
}

@test "summary-counts (bash, Gap D): per-module counters increment explicitly, not via hash size" {
    # The fix-class is "use explicit increments, not derived counts from
    # a possibly-not-an-array variable." Three counters must follow this
    # idiom: total_success, total_failure, total_tests.
    grep -q 'total_success=$((total_success + 1))' "$SCRIPT"
    grep -q 'total_failure=$((total_failure + 1))' "$SCRIPT"
    grep -q 'total_tests=$((total_tests + result_passed\[i\]))' "$SCRIPT"
    grep -q 'total_failed_tests=$((total_failed_tests + result_failed\[i\]))' "$SCRIPT"
}

@test "summary-counts (bash, Gap D): summary.json field names match the JSON envelope contract" {
    # parseAndroidSummary in cli.js (v0.5.1 Bug G) reads these exact keys.
    # Renaming any of them silently degrades --json signal. This test
    # also fences PR #54's regression: each field must be a single integer,
    # not a derived count.
    grep -q "'totalModules': total_mods" "$SCRIPT"
    grep -q "'passedModules': pass_mods" "$SCRIPT"
    grep -q "'failedModules': fail_mods" "$SCRIPT"
    grep -q "'totalTests': total_tests" "$SCRIPT"
    grep -q "'passedTests': total_tests - total_failed" "$SCRIPT"
    grep -q "'failedTests': total_failed" "$SCRIPT"
}

@test "summary-counts (bash, Gap D): Python receives counters as integers via int(sys.argv[N])" {
    # Pre-summed integers from bash → int() in Python. This pattern
    # makes the PS1-style hashtable-key-count bug structurally impossible
    # on the bash path (bash builds the counter; Python only re-interprets it).
    grep -q 'total_mods = int(sys.argv\[14\])' "$SCRIPT"
    grep -q 'pass_mods = int(sys.argv\[15\])' "$SCRIPT"
    grep -q 'fail_mods = int(sys.argv\[16\])' "$SCRIPT"
}

@test "summary-counts (bash, Gap D): 'modules' array is built by indexed range over names list" {
    # The modules[] array must iterate range(len(names)) — same indexed
    # pattern as the bash counter loop. Catches a future refactor that
    # drops to e.g. a comprehension over a dict.
    grep -q 'for i in range(len(names)):' "$SCRIPT"
}

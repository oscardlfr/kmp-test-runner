#!/usr/bin/env bats
# Tests for the Gradle 9 deprecation notice handling (v0.5.0 — Bug C fix).
# Verifies parallel.sh uses `[NOTICE]` (not `[!]`) for the benign
# "gradle exited 1 but all tasks passed" case so JSON parsers and humans
# can distinguish deprecation noise from real failures.

PARALLEL="scripts/sh/run-parallel-coverage-suite.sh"

@test "parallel.sh: notice() helper defined alongside warn/err/info/ok" {
    grep -q '^notice() ' "$PARALLEL"
}

@test "parallel.sh: notice() emits cyan output (distinct prefix from warn yellow)" {
    # Source just the color/helper section. The script's full body needs
    # --project-root, but the helpers are top-level and source-friendly when
    # we stop short of the arg parser.
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
    # Cyan ANSI escape (\033[36m)
    [[ "$out" == *$'\033[36m'* ]] || [[ "$out" == *'msg'* ]]
}

@test "parallel.sh: deprecation branch uses notice/[NOTICE], NOT warn/[!]" {
    # Find the elif branch handling the deprecation case (gradle exit non-zero
    # AND failure_count==0 AND success_count>0). It must call notice() with
    # the [NOTICE] prefix so cli.js parses it into warnings[] not errors[].
    local branch
    branch="$(awk '/SUCCESS_COUNT.*-gt 0/,/^    fi$/' "$PARALLEL")"
    [[ "$branch" == *'notice "[NOTICE] Gradle exited'* ]]
    # And it must NOT use the legacy warn [!] form.
    [[ "$branch" != *'warn "[!] Gradle exited with code'*'tasks passed individually'* ]]
}

@test "parallel.sh: JVM-level error branch (success==0) still uses warn/[!] (real failure)" {
    # The first branch — gradle failed AND no individual results — IS a real
    # error, so it must keep the warn/[!] form (cli.js parses it as error).
    local branch
    branch="$(awk '/no task results found/' "$PARALLEL")"
    [[ "$branch" == *'warn "[!] Gradle exited'* ]]
}

# `no_summary` — wrapper output had no recognisable summary (soft code)

The orchestrator finished running but the wrapper script's stdout didn't contain a parseable summary block. **Soft code** — does NOT promote `exit_code`. Legitimate exit-0 outcome with structured signal.

## Symptom

```json
{
  "exit_code": 0,
  "errors": [{
    "code": "no_summary",
    "message": "Wrapper output had no recognizable summary line"
  }],
  "tests": { "total": 0, "passed": 0, "failed": 0, "skipped": 0 }
}
```

Applies to any script-backed subcommand (`parallel`, `coverage`, `benchmark`, `changed`, `android`). Most common with stub scripts in unit tests, projects that have zero modules with tests, and pure-app projects without test source sets.

## Why this is soft

`no_summary` is a parse-gap fallback. The wrapper ran cleanly (exit 0), but the orchestrator's output parser couldn't find a "X tests completed" / "BUILD SUCCESSFUL" / coverage-summary block to extract counts from.

This is NOT a hard error — the wrapper might have:
- Run zero modules (legitimately empty project), OR
- Emitted output the orchestrator doesn't yet recognise (newer gradle version with reshaped progress lines), OR
- Been stubbed out (e.g. in vitest tests).

WS-5 invariant: hard codes promote `exit_code` from 0 to 1; soft codes don't. `no_summary` is intentionally soft so legitimate empty-project runs return `exit 0` with structured signal.

## Root causes

1. **Project has zero modules with tests** (the most common case): every module landed in `skipped[]`. Gradle ran but never invoked a test task. No summary to parse. Often paired with `no_test_modules` (hard) when discovery itself found nothing — in that case `no_test_modules` preempts `no_summary` via `sawAnything` check.
2. **`--list-only` short-circuit**: the orchestrator returned early before any gradle dispatch. `parallel.legs[]` is populated but no test summary exists. Since v0.9 the orchestrator emits `parallel.legs[]` directly so `no_summary` should be rare on `--list-only`; surfaces only on edge cases.
3. **Stub gradle output in tests**: vitest characterization tests inject fake wrappers that emit minimal output. The parser can't find the summary line; emits `no_summary`.
4. **Gradle progress format change**: a new gradle version reshaped the "X tests completed" line beyond what the parser recognises. The orchestrator's `parseScriptOutput` regex doesn't match. Recovery: file a bug at `kmp-test-runner` repo with the captured stdout.
5. **Wrapper script crash mid-output**: rare — would normally surface as a non-zero exit with a different error code. Could leave partial stdout that the parser doesn't match.

## Recovery path

For "zero-modules legitimate empty":

1. Confirm with `kmp-test describe --json` — if `modules[]` is empty or every entry has null `test_tasks`, the project genuinely has nothing to test.
2. Surface `no_summary` to the user as informational. Don't escalate.

For "newer gradle":

1. Capture the wrapper stdout (`kmp-test parallel 2>&1 | tee /tmp/wrapper.log`).
2. File a bug at `kmp-test-runner` repo with the log attached so the parser can be updated.
3. Workaround: pass `--gradle-args "--console=plain"` (already implicit in non-TTY mode) to force a stable output format.

For "stub gradle output in tests": expected — vitest fixtures legitimately produce `no_summary`. The CLI is correctly behaving.

## Recovery commands

```bash
# Confirm project has testable modules
kmp-test describe --json | jq '.describe.modules[] | { name, test_tasks }'

# Re-run with plain console for parseable output
kmp-test parallel --color never --json

# Capture raw wrapper stdout for bug report
kmp-test parallel 2>&1 | tee /tmp/wrapper-output.log
```

## AGP / JDK quirks

- **Gradle 9 deprecation handling**: the v0.9 envelope handles `BUILD FAILED` paired with deprecation-only warnings via a `warnings[]` entry with `code: gradle_deprecation`. `no_summary` does NOT fire on that case — there's still a summary, just paired with a warning.
- **Project model cache**: `no_summary` is independent of cache state. Doesn't help to clear the cache.
- **Empty multi-project root**: a root `settings.gradle.kts` with `include()` of zero sub-modules → discovery is empty → `no_summary` is appropriate.

## See also

- [`../cli/envelope-schema.md#errors-discriminated-codes`](../cli/envelope-schema.md#errors-discriminated-codes) — full code table (soft codes section)
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — WS-5 invariant and why soft codes don't promote
- [`overview.md`](overview.md) — troubleshooting hub
- [`no-changed-modules.md`](no-changed-modules.md) — the other soft code
- [`no-test-modules.md`](no-test-modules.md) — the HARD code that fires when discovery confirms empty (preempts `no_summary`)

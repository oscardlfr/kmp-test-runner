---
name: kmp-test-runner
description: "Parallel test runner for Kotlin Multiplatform (KMP) and Android Gradle projects via the kmp-test CLI. Runs unit, instrumented, coverage (kover/jacoco), and benchmark tests. Use when the user asks to run tests, gradle's default dispatch is slow, the target module or Gradle test task is unclear, or the agent needs structured JSON output. Invoke before Bash exploration, file traversal, Gradle task listing, or project-structure inspection — including when named only by role, contents, platform, or test capability."
license: MIT
compatibility: "Requires kmp-test CLI + gradlew. Android CLI (https://developer.android.com/tools/agents/android-cli) is optional for device/UI diagnostics."
metadata:
  author: oscardlfr
  homepage: https://github.com/oscardlfr/kmp-test-runner
  npm: kmp-test-runner
  keywords:
    - Kotlin Multiplatform
    - KMP
    - Android Gradle
    - parallel tests
    - instrumented tests
    - coverage
    - kover
    - jacoco
    - benchmarks
---

## Decision protocol

Resolve scope before acting.

1. **Resolve the workflow first** — from what the user asked (see the table under Steps), with the
   modifiers that request makes mandatory. `describe` discovers modules and tasks;
   it does not decide the workflow. Unnamed target, only an uncommitted change:
   the workflow is `changed`, not `parallel`. Run/confirm tests plus at most N missed/uncovered
   lines is one item — `parallel --min-missed-lines 100`, `100` replaced by the integer asked
   for; never a separate `coverage` probe first. If ambiguous, ask before running.
2. **Classify scope** — broad, exact module, test-capability target, or likely-no-tests target.
   Naming or platform wording never settles task capability: an Android-named module with
   `test_tasks.unit: null` loses to a differently-named KMP module whose own field is
   `"testAndroidHostTest"`.
3. **Broad** — dispatch that workflow's own command globally as the first action:
   `kmp-test parallel --json --project-root .` (or `android`/`coverage`/`benchmark`/`changed`);
   descriptive wording ("app", "shared") isn't an exact module.
4. **Exact module** — dispatch with the workflow's module-scoping flag set to a module already known:
   explicit from the user, or a prior envelope's `modules[].name` — never descriptive
   wording alone. Use `--modules` for `parallel`/`android`; `benchmark` has only the broad
   `--module-filter`, so verify its returned scope. `changed`
   has no exact flag — its module set is always git-derived. Use `--coverage-modules` for an exact
   coverage target (`coverage` also accepts a broader `--module-filter` glob); it needs the name with any leading `:` stripped,
   comma-separated, no glob. `changed` selects exact module names from Git; use `--base <ref>`
   to include branch changes and `--include-dependents` to add transitive project consumers.
5. **Test-capability target** — run `kmp-test describe --json --project-root .` once; check every
   `modules[]` entry's task field for the test type — `test_tasks.unit` for `parallel`'s default,
   `flags-reference.md` for an explicit `--test-type`. 1 eligible: bind dispatch to that entry's
   exact `modules[].name` (strip `:` for `--coverage-modules`) — never a different entry merely
   resembling by name, type, or platform. `parallel`/`android` use `--modules` for this binding;
   the substring `--module-filter` is only for broad selection. Keep the same resolved workflow and every mandatory modifier while retaining
   the bound exact `modules[].name`. `describe` only completes unknown discovery data; it does not
   reconstruct the workflow or remove a threshold. For a tests-plus-budget request, use one
   canonical `parallel` dispatch with the bound exact `modules[].name` and the originally resolved
   missed-lines threshold; never `coverage` first or a plain `parallel`. 2+ eligible: dispatch
   globally if broad, else ask. 0 eligible: report no match; don't invent one.
6. **Likely-no-tests target** — for `parallel`'s default (others: `flags-reference.md`): run
   `kmp-test describe --json --project-root .` once if not already run; inspect every `modules[]`
   entry's `test_tasks.unit`.
   1 null: dispatch its exact `modules[].name` for one real filtered run. 2+ null: ask for the
   exact target, never guess from names or types. 0 null: report no matching candidate; don't
   invent one. `test_tasks.unit: null` alone is candidate evidence, never proof — require that
   real, filtered, non-dry-run envelope with `no_test_modules` + `caused_by_filter:true` before
   reporting "no applicable tests" and stop.
7. **Preview only** — add `--dry-run` to parallel/android/coverage/benchmark/changed, or
   `changed --show-modules-only` for its git-derived list; not a preflight for an execution
   request, and don't loop through guessed filters.
8. **Trust the real envelope** — a non-dry-run envelope is authoritative; trust `exit_code`/
   `errors[]` over assumption.
9. **Stop once proven** — a non-dry-run envelope with expected outcome, coherent
   `exit_code`/`errors[]`, and (when tests ran) matching counts/failures is terminal. Report and
   stop: no post-success dry-run, doctor, describe, raw or task-listing Gradle, version, or
   ls/pwd/which probe. An unrelated `skipped[]` entry isn't a reason to keep exploring.
10. **Diagnose only on failure** — run `kmp-test doctor --json --project-root .` only for
    `exit_code: 3` or an explicit request.

Start with the structured CLI from the project root.

When the user names an exact execution set, use one `--modules ":feature:auth,:feature:profile"`
on `parallel` or `android` (also `parallel --test-type androidInstrumented`). Full Gradle paths
avoid ambiguous short names. The selector resolves against the project model, deduplicates names,
and rejects unknown or ambiguous names with typed exit-2 JSON errors. `--list-only --json` shows
the post-filter module set; `--dry-run --json` previews it with static model analysis.

Use `--module-filter` for a broad execution pattern: comma-separated tokens containing `*` or `?`
are globs, while plain tokens use substring matching. `:core:data` may also match
`:core:database`. With `--modules`, a filter or `--exclude-modules` narrows the resolved set;
automatic test-source, test-type and configured skip rules still apply. Inspect `modules[]` and
`skipped[]` before claiming an exact task count. `--modules` scopes test dispatch; use
`--coverage-modules` separately to scope coverage aggregation. `describe --module-filter` is different: it uses
a JavaScript regex because it queries the metadata array rather than dispatching tests; anchor
with `^` and `$` when querying one full name.

`--coverage-modules` is exact-match only (no substring, no glob). `coverage`'s own `modules[]` is
always empty — verify via `plan.coverage_modules` on `--dry-run` (echoes the filter, unresolved)
or `coverage.module_buckets` on a real run.

A denied exploratory command isn't worth retrying — abandon it and go to the next canonical step,
rebuilt from the resolved workflow and its modifiers; a denial never drops a user constraint.
A denied EXACT canonical `kmp-test` command is final: stop and report the blockage; don't retry
with a different flag, subcommand, or shell wrapper. A denied DECORATED command — redirection, a
pipe, chaining, `head`, or a shell wrapper — isn't yet canonical: issue the exact standalone command once;
if denied too, stop and report.

## Prerequisites

1. `kmp-test` CLI installed — npm: `npm install -g kmp-test-runner`.
2. `gradlew` (`gradlew.bat` on Windows) at project root — if missing, report the prerequisite
   failure.
3. JDK 17+ — auto-selected from `~/.kmp-test/config.json`, `JAVA_HOME`, or catalogue.

## Environment detection

Optional — running tests never needs it. `kmp-test doctor --json --project-root .` reports
ADB/SDK status; `kmp-test android --json --project-root .` works alone. `android` CLI never
changes `kmp-test`'s envelope.

## Tool selection — `kmp-test` vs `android` CLI overlap

Default to `kmp-test`: versioned JSON, cross-platform, `--dry-run`-safe. Android
CLI provides SDK, deployment, layout and screen tools; on Windows use the SDK
emulator executable for AVD lifecycle. Check `android --help` for installed verbs.
Mapping: [`envelope-schema.md`](references/cli/envelope-schema.md#cross-tool-comparison-android-cli-analogues).

## Steps

### 1. Run the relevant test type

Pick the subcommand:

| User intent | Subcommand | Notes |
|-------------|-----------|-------|
| "run tests" / "test this" / "run tests with coverage" | `kmp-test parallel --json --project-root .` | `test`/`jvmTest`/`desktopTest` |
| "run instrumented tests" / "run on device" | `kmp-test android --json --project-root .` | `connectedAndroidTest` |
| "run coverage" | `kmp-test coverage --json --project-root .` ||
| "run tests; at most 100 missed/uncovered lines" | `kmp-test parallel --min-missed-lines 100 --json --project-root .` ||
| "run benchmarks" | `kmp-test benchmark --json --project-root .` ||
| "what would run?" / "dry run" | append `--dry-run` to the command above ||
| "run only changed tests" | `kmp-test changed --json --project-root .` | Git-derived; add `--base <ref>` for branch changes and `--include-dependents` for transitive consumers |

> Deep-dives: [`overview.md`](references/workflows/overview.md).

### 2. Parse the JSON envelope

Shape: [`envelope-schema.md`](references/cli/envelope-schema.md); exit codes:
[`exit-codes.md`](references/cli/exit-codes.md). `errors[{message,code?,...extra}]`
carries codes (`no_test_modules`+`caused_by_filter`).

### 3. Report failures with module attribution

Per `errors[]` entry, surface `code`, discriminators, `message`; include `module` only when present.
For test failures, check `modules[].test_failures[{test,cause,type}]` — `test` is
`ClassName.methodName`, `cause` message, `type` optional. `tests.individual_failed` counts
failing executions; `tests.individual_failed_distinct` counts unique methods within modules.
For a pre-test compilation failure, use the owning `errors[].compile_failures[]` diagnostics
and `setup_failed:true`. `parallel.legs[].compile_failures[]` preserves leg-wide evidence;
recognized compilation failures suppress cascade retry (`retry_fired:false`).

## Convenience scripts

Optional, source-checkout only — may not resolve once installed; prefer `kmp-test`.
`run-tests.sh` / `run-tests.ps1` wrap the same JSON envelope;
`detect-env.sh` / `detect-env.ps1` print a plain token instead.

| Script | Purpose |
|---|---|
| `detect-env.sh` / `detect-env.ps1` | Prints `HAS_ANDROID_CLI`/`NO_ANDROID_CLI`; `run-tests.sh` env preamble. |
| `run-tests.sh` / `run-tests.ps1` | Dispatcher — first positional (`-Type` on PowerShell) picks the workflow; `--json`/`--project-root .` auto-inject. |

## Verification

Confirm the envelope matches `exit_code`:

1. `0` — success: `errors[]` empty, or only soft codes (`no_summary`, `no_changed_modules`,
   `gradle_timeout`).
2. `1` — a test failed, or a hard error was WS-5-promoted: check `modules[].test_failures[]` and
   `errors[]`.
3. `2` — CLI usage error: check `errors[].code` (e.g. `no_test_modules` + `caused_by_filter:true`).
4. `3` — environment error: run `kmp-test doctor --json --project-root .` to localize
   (`task_not_found`, `no_test_modules`+`caused_by_filter:false`).

## Guidelines

- **Never run `gradle clean`.**
- **`--module-filter` / `--coverage-modules`** narrow scope — see Decision protocol.
- **`--test-filter`** narrows to one test — `FullyQualifiedClassName#methodName`.
- **Coverage evidence** — `coverage.module_results[]` gives each module's LINE score and
  status; a percentage gate uses `--min-line-coverage <pct>`. Check
  `coverage.data_provenance`: `current_run` for fresh `parallel`/`changed` evidence,
  `saved_reports` for standalone `coverage` or `--skip-tests`.
- **Avoid `--no-coverage`** unless coverage doesn't apply.
- **`--dry-run`** plans without running — same shape, `dry_run: true`.
- **Don't conflate `parallel`/`android`** — unit (`*:test`/`*:jvmTest`) vs instrumented
  (`*:connectedAndroidTest`).
- **Unknown error codes are opaque** — forward `code`/`message` verbatim.

## Troubleshooting

Branch on `errors[].code` — details in
[`references/troubleshooting/overview.md`](references/troubleshooting/overview.md):

- `no_test_modules` — `caused_by_filter` splits CONFIG_ERROR (2) from ENV_ERROR (3).
- `task_not_found` / `module_failed` / `unsupported_class_version` — wrong subcommand,
  failure, or JDK mismatch.
- `instrumented_setup_failed` / `flavor_unused` / `isolated_runtime_race` / `lock_held` —
  device/flavor/race/lock.

## References

- [`references/cli/envelope-schema.md`](references/cli/envelope-schema.md) — shape (schema:2)
- [`references/cli/exit-codes.md`](references/cli/exit-codes.md) — exit-code semantics + WS-5
- [`references/cli/flags-reference.md`](references/cli/flags-reference.md) — CLI flags table
- [`references/workflows/overview.md`](references/workflows/overview.md) — workflow hub
- [`references/troubleshooting/overview.md`](references/troubleshooting/overview.md) — troubleshooting hub

---

> **Skill source**: published as part of `kmp-test-runner`. Open standard: [agentskills.io](https://agentskills.io). Source: [github.com/oscardlfr/kmp-test-runner](https://github.com/oscardlfr/kmp-test-runner).

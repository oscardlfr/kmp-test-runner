---
name: kmp-test-runner
description: "Parallel test runner for Kotlin Multiplatform (KMP) and Android Gradle projects via the kmp-test CLI. Runs unit, instrumented, coverage (kover/jacoco), and benchmark tests. Use when the user asks to run tests, gradle's default dispatch is slow, the target module or Gradle test task is unclear, or the agent needs structured JSON output. Invoke before Bash exploration, file traversal, Gradle task listing, or project-structure inspection — including when named only by role, contents, platform, or test capability."
license: MIT
compatibility: "Requires kmp-test CLI + gradlew. Instrumented tests: android CLI (https://developer.android.com/tools/agents/android-cli), emulator/UI-debug."
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

1. **Resolve the workflow first** — from what the user asked (see the table under Steps).
   `describe` discovers modules and tasks; it does not decide the workflow. If ambiguous, ask
   before running.
2. **Classify scope** — broad, exact module, test-capability target, or likely-no-tests target.
   Naming or platform wording never settles task capability: an Android-named module with
   `test_tasks.unit: null` loses to a differently-named KMP module whose own field is
   `"testAndroidHostTest"`.
3. **Broad** — dispatch that workflow's own command globally as the first action:
   `kmp-test parallel --json --project-root .` (or `android`/`coverage`/`benchmark`/`changed`);
   descriptive wording ("app", "shared") isn't an exact module.
4. **Exact module** — dispatch with the workflow's module-scoping flag set to a module already known:
   explicit from the user, or a prior envelope's `modules[].name` — never descriptive
   wording alone. `--module-filter` (parallel/android/benchmark) takes the name as-is; `changed`
   has no such flag — its module set is always git-derived. `--coverage-modules` (coverage;
   `coverage` ignores `--module-filter`) needs the exact name with any leading `:` stripped,
   comma-separated, no glob.
5. **Test-capability target** — run `kmp-test describe --json --project-root .` once; check every
   `modules[]` entry's task field for the test type — `test_tasks.unit` for `parallel`'s default,
   `flags-reference.md` for an explicit `--test-type`. 1 eligible: bind dispatch to that entry's
   exact `modules[].name` (strip `:` for `--coverage-modules`) — never a different entry merely
   resembling by name, type, or platform. For `--module-filter`, first check `modules[]`: if the
   bound name's substring also matches another entry, ask instead of dispatching (`--coverage-modules`
   is already exact). 2+ eligible: dispatch globally if broad, else ask. 0 eligible: report no
   match; don't invent one.
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

`--module-filter` matches by substring unless the value has glob characters — verify `modules[]`
before trusting exact scope.

`--coverage-modules` is exact-match only (no substring, no glob). `coverage`'s own `modules[]` is
always empty — verify via `plan.coverage_modules` on `--dry-run` (echoes the filter, unresolved)
or `coverage.module_buckets` on a real run.

A denied exploratory command isn't worth retrying — abandon it and go to the next canonical step.
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

Default to `kmp-test`: versioned JSON, cross-platform, side-effect-free on `--dry-run`. `android
info`/`describe` overlap (plain text; Windows bug in `describe`) — SDK/emulator/UI only.
Mapping: [`envelope-schema.md`](references/cli/envelope-schema.md#cross-tool-comparison-android-cli-analogues).

## Steps

### 1. Run the relevant test type

Pick the subcommand for what the user asked:

| User intent | Subcommand | Notes |
|-------------|-----------|-------|
| "run tests" / "test this" | `kmp-test parallel --json --project-root .` | `test`/`jvmTest`/`desktopTest` per module |
| "run instrumented tests" / "run on device" | `kmp-test android --json --project-root .` | `connectedAndroidTest`, needs device |
| "run coverage" / "with coverage" | `kmp-test coverage --json --project-root .` | kover/jacoco XML |
| "run benchmarks" | `kmp-test benchmark --json --project-root .` | Macro/microbenchmark |
| "what would run?" / "dry run" | append `--dry-run` to the matching command above | No spawn — plan as JSON |
| "run only changed tests" | `kmp-test changed --json --project-root .` | Touched in the git tree |

> Per-subcommand deep-dives: [`workflows/overview.md`](references/workflows/overview.md).

### 2. Parse the JSON envelope

Full shape: [`references/cli/envelope-schema.md`](references/cli/envelope-schema.md); exit codes:
[`references/cli/exit-codes.md`](references/cli/exit-codes.md). `errors[{message,code?,...extra}]`
carries discriminated codes (`no_test_modules`+`caused_by_filter`).

### 3. Report failures with module attribution

Per `errors[]` entry, surface `code`, discriminators, and `message`; include `module` only when present.
For test failures, drill into `modules[].test_failures[{test,cause,type}]` — `test` is
`ClassName.methodName`, `cause` the message, `type` optional.

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

- **Never run `gradle clean`** — dispatch is already incremental.
- **`--module-filter` / `--coverage-modules`** narrow scope — see Decision protocol.
- **`--test-filter`** narrows to one test — `FullyQualifiedClassName#methodName`.
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

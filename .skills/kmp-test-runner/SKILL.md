---
name: kmp-test-runner
description: "Parallel test runner for Kotlin Multiplatform (KMP) and Android Gradle projects via the kmp-test CLI. Runs unit tests, instrumented tests on devices and emulators, coverage (kover/jacoco), and benchmarks across multi-module projects. Use when the user asks to run tests, the project is slow with gradle's default sequential dispatch, the target module or Gradle test task is unclear, or the agent needs structured JSON output to parse failures and module attribution."
license: MIT
compatibility: "Requires kmp-test CLI + gradlew. Optional, recommended for instrumented tests: Google's android CLI (https://developer.android.com/tools/agents/android-cli) for emulator/screen-capture/UI-debug workflows."
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
    - gradle
---

## Decision protocol

Resolve scope before acting; stop once proven.

1. **Resolve the workflow first** — from what the user asked (see the table under Steps).
   `describe` discovers modules and tasks; it does not decide the workflow. If ambiguous, ask
   before running.
2. **Known workflow, no specific module** — dispatch that workflow's own command globally as the
   first action: `kmp-test parallel --json --project-root .` (or `android`/`coverage`/
   `benchmark`/`changed`); descriptive wording ("app", "shared") isn't an exact module.
3. **Known workflow, known module** — dispatch with the workflow's module-scoping flag set to a
   module already known: explicit from the user, or a prior envelope's
   `modules[].name` — never descriptive wording alone (previous step). `--module-filter`
   (parallel/android/benchmark) takes the name as-is; `changed` has no such flag — its module set
   is always git-derived. `--coverage-modules` (coverage; `coverage` ignores `--module-filter`)
   needs the exact name with any leading `:` stripped, comma-separated, no glob.
4. **Known workflow, unclear module** — run `kmp-test describe --json --project-root .` once;
   check every `modules[]` entry's task field for the test type — `test_tasks.unit` for
   `parallel`'s default, `flags-reference.md` for an explicit `--test-type`; never derive it from
   descriptive wording like "Android". 1 eligible: dispatch its exact name (strip `:` for
   `--coverage-modules`). 2+ eligible: dispatch globally if broad, else ask. 0 eligible: don't
   invent one.
5. **Preview only** — add `--dry-run` to parallel/android/coverage/benchmark/changed, or
   `changed --show-modules-only` for its git-derived list; don't loop through guessed filters.
6. **Trust the real envelope** — a non-dry-run envelope is authoritative for what ran; trust its
   `exit_code`/`errors[]` over any prior assumption.
7. **Stop once proven** — a non-dry-run envelope with expected outcome, coherent
   `exit_code`/`errors[]`, and (when tests ran) matching counts/failures is terminal. Report and
   stop: no post-success dry-run, doctor, describe, raw or task-listing Gradle, version, or
   ls/pwd/which probe. An unrelated `skipped[]` entry isn't a reason to keep exploring.
8. **Diagnose only on failure** — run `kmp-test doctor --json --project-root .` only for
   `exit_code: 3` or an explicit request.

Start with the structured CLI from the project root — skip generic preflight.

`--module-filter` matches by substring unless the value has glob characters — verify `modules[]`
before trusting exact scope.

`--coverage-modules` is exact-match only (no substring, no glob). `coverage`'s own `modules[]` is
always empty — verify via `plan.coverage_modules` on `--dry-run` (echoes the filter, unresolved)
or `coverage.module_buckets` on a real run.

A denied exploratory command isn't worth retrying — abandon it and go to the next canonical step.
A denied canonical `kmp-test` command is final: stop and report the blockage; don't retry with a
different flag, subcommand, or shell wrapper.

For the default unit-test `parallel` workflow, "no applicable tests" requires a real, non-dry-run
`parallel` envelope with `no_test_modules` + `caused_by_filter:true` — `test_tasks.unit: null`
alone never proves it (a module may still run under a different `--test-type`; see
`flags-reference.md` for `test_tasks` field mapping). Use `describe` only to confirm the module
exists. Once both hold, report "no applicable tests" and stop; don't switch workflows for
another answer.

## Prerequisites

1. `kmp-test` CLI installed — npm: `npm install -g kmp-test-runner`.
2. `gradlew` (`gradlew.bat` on Windows) at the project root — if missing, report the prerequisite
   failure; ask the user to initialize it.
3. JDK 17+ — auto-selected from `~/.kmp-test/config.json`, `JAVA_HOME`, or built-in catalogue.

## Environment detection

Optional — running tests never needs it. `kmp-test doctor --json --project-root .` reports
ADB/SDK availability; `kmp-test android --json --project-root .` works standalone. Google's
`android` CLI is a separate layer (see Tool selection) — it never changes `kmp-test`'s envelope.
Deep-dives:
[`references/workflows/overview.md`](references/workflows/overview.md).

## Tool selection — `kmp-test` vs `android` CLI overlap

Default to `kmp-test`: versioned JSON, cross-platform, side-effect-free on `--dry-run`. `android
info`/`describe` overlap but stay plain text (and `describe` has a known Windows bug) — use
`android` CLI only for SDK/emulator/UI work outside `kmp-test`. Mapping:
[`envelope-schema.md`](references/cli/envelope-schema.md#cross-tool-comparison-android-cli-analogues).

## Steps

### 1. Run the relevant test type

Use the right subcommand based on what the user asked for:

| User intent | Subcommand | Notes |
|-------------|-----------|-------|
| "run tests" / "run unit tests" / "test this" | `kmp-test parallel --json --project-root .` | Dispatches `test`/`jvmTest`/`desktopTest` per module |
| "run instrumented tests" / "run on device" | `kmp-test android --json --project-root .` | Dispatches `connectedAndroidTest`; needs a device/emulator |
| "run coverage" / "with coverage" | `kmp-test coverage --json --project-root .` | Aggregates kover/jacoco XML |
| "run benchmarks" | `kmp-test benchmark --json --project-root .` | Dispatches macro/microbenchmark tasks |
| "what would run?" / "dry run" | append `--dry-run` to the matching command above | No spawn — plan as JSON |
| "run only changed tests" | `kmp-test changed --json --project-root .` | Modules touched in the git working tree |

> Per-subcommand deep-dives: [`workflows/overview.md`](references/workflows/overview.md).

### 2. Parse the JSON envelope

Full shape: [`references/cli/envelope-schema.md`](references/cli/envelope-schema.md); exit codes:
[`references/cli/exit-codes.md`](references/cli/exit-codes.md). `errors[{message,code?,...extra}]`
carries discriminated codes (`no_test_modules`+`caused_by_filter` — full list in the reference
docs).

### 3. Report failures with module attribution

Per `errors[]` entry, surface `code`, discriminators, and `message`; include `module` only when present.
For test failures, drill into `modules[].test_failures[{test,cause,type}]` — `test` is
fully-qualified `ClassName.methodName`, `cause` the message, `type` optional exception class.

## Convenience scripts

Optional, source-checkout only — may not resolve once plugin-installed or via agentskills.io;
prefer `kmp-test`. `run-tests.sh` / `run-tests.ps1` wrap the same JSON envelope;
`detect-env.sh` / `detect-env.ps1` print a plain token instead.

| Script | Purpose |
|---|---|
| `detect-env.sh` / `detect-env.ps1` | Prints `HAS_ANDROID_CLI`/`NO_ANDROID_CLI`; exits 0 either way. `run-tests.sh`'s env preamble; also standalone. |
| `run-tests.sh` / `run-tests.ps1` | Dispatcher — first positional (`-Type` on PowerShell) selects `unit` (default) / `android` / `coverage` / `benchmark` / `changed` / `info` / `doctor` / `describe`; remaining args forward verbatim, `--json` + `--project-root .` auto-inject. |

## Verification

Confirm the envelope matches `exit_code`:

1. `0` — success: `errors[]` empty, or only soft codes (`no_summary`, `no_changed_modules`,
   `gradle_timeout`).
2. `1` — a test failed, or a hard error was WS-5-promoted: check `modules[].test_failures[]` and
   `errors[]`.
3. `2` — CLI usage error: check `errors[].code` (e.g. `no_test_modules` + `caused_by_filter:true`).
4. `3` — environment error: run `kmp-test doctor --json --project-root .` to localize
   (`task_not_found`, or `no_test_modules` + `caused_by_filter:false` — see Troubleshooting).

## Guidelines

- **Never run `gradle clean`** first — dispatch is already incremental.
- **`--module-filter` / `--coverage-modules`** narrow scope by module — rules differ by
  flag/workflow (see Decision protocol).
- **`--test-filter`** narrows to one test — `FullyQualifiedClassName#methodName`.
- **Avoid `--no-coverage`** unless coverage doesn't apply.
- **`--dry-run`** plans without running — same envelope shape, `dry_run: true`.
- **Don't conflate `parallel` and `android`** — unit (`*:test`/`*:jvmTest`) vs instrumented
  (`*:connectedAndroidTest`).
- **Unknown error codes are opaque** — forward `code`/`message` verbatim; new codes may appear.

## Troubleshooting

Branch on `errors[].code` — details in
[`references/troubleshooting/overview.md`](references/troubleshooting/overview.md), keyed by code:

- `no_test_modules` — `caused_by_filter` splits CONFIG_ERROR (2) from ENV_ERROR (3).
- `task_not_found` / `module_failed` / `unsupported_class_version` — wrong subcommand, real
  failure, or JDK mismatch.
- `instrumented_setup_failed` / `flavor_unused` / `isolated_runtime_race` / `lock_held` — device,
  flavor, race, or lock problem.

## References

- [`references/cli/envelope-schema.md`](references/cli/envelope-schema.md) — JSON envelope shape (schema:2)
- [`references/cli/exit-codes.md`](references/cli/exit-codes.md) — exit-code semantics + WS-5
- [`references/cli/flags-reference.md`](references/cli/flags-reference.md) — CLI flags table
- [`references/workflows/overview.md`](references/workflows/overview.md) — workflow hub
- [`references/troubleshooting/overview.md`](references/troubleshooting/overview.md) — troubleshooting hub

---

> **Skill source**: published as part of `kmp-test-runner`. Open standard: [agentskills.io](https://agentskills.io). Source: [github.com/oscardlfr/kmp-test-runner](https://github.com/oscardlfr/kmp-test-runner).

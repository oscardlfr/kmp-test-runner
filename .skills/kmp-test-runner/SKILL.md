---
name: kmp-test-runner
description: "Parallel test runner for Kotlin Multiplatform (KMP) and Android Gradle projects via the kmp-test CLI. Runs unit tests, instrumented tests on devices and emulators, coverage (kover/jacoco), and benchmarks across multi-module projects. Use when the user asks to run tests, the project is slow with gradle's default sequential dispatch, the target module or Gradle test task is unclear, or the agent needs structured JSON output to parse failures and module attribution."
license: MIT
compatibility: "Requires kmp-test CLI installed and gradlew present. Optional but recommended for instrumented tests: Google's android CLI (https://developer.android.com/tools/agents/android-cli) for enhanced emulator, screen-capture, and UI-debug workflows."
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

Resolve scope before running anything, then stop once the envelope proves the outcome.

1. **Resolve the workflow first** — from what the user asked for (see the table under Steps).
   `describe` discovers modules and their available tasks; it does not decide which workflow the
   user wants. If the workflow itself is ambiguous, ask before running anything.
2. **Known workflow, no specific module** — dispatch the matching subcommand globally, e.g.
   `kmp-test parallel --json --project-root .`.
3. **Known workflow, known module** — dispatch the matching subcommand with `--module-filter` set
   to the module name already known from context; no `describe` call needed.
4. **Known workflow, unclear module** — run `kmp-test describe --json --project-root .` once. Read
   the exact value from its `modules[].name` field. Dispatch the matching subcommand (e.g.
   `kmp-test parallel --json --project-root .`) with `--module-filter` set to that exact value.
5. **Preview only** — add `--dry-run` to any subcommand; don't loop through guessed filters.
6. **Trust the real envelope** — a non-dry-run envelope is authoritative for what ran; trust its
   `exit_code` and `errors[]` over any prior assumption.
7. **Stop once proven** — report the envelope-backed result and stop.
8. **Diagnose only on failure** — run `kmp-test doctor --json --project-root .` only for
   `exit_code: 3` or an explicit request. Confirms gradlew, JDK, ADB, Kotlin/AGP versions, project
   shape.

Start with the structured CLI from the project root — skip generic preflight.

A denied exploratory command is not worth retrying in another shape — abandon it and go straight
to the next canonical step above. A denied canonical `kmp-test` command is final — stop and report
the blockage; don't retry with a different flag, subcommand, or shell wrapper.

When the resolved workflow is `parallel`, "no applicable tests" needs `describe`-confirmed
evidence: the module is in `modules[].name` with `test_tasks.unit: null`. Reached step 3 (known
module, no describe) and got `no_test_modules` + `caused_by_filter:true` instead? Run `describe`
once first — the same code can also mean a wrong name. Once confirmed, report "no applicable
tests" and stop; don't switch subcommand or workflow for another answer.

## Prerequisites

1. `kmp-test` CLI installed — npm: `npm install -g kmp-test-runner`.
2. `gradlew` (`gradlew.bat` on Windows) at the project root — initialize the gradle wrapper first
   if missing.
3. JDK 17+ — auto-selected from `~/.kmp-test/config.json`, `JAVA_HOME`, or the built-in catalogue.

## Environment detection

Optional — running tests never needs it. `kmp-test doctor --json --project-root .` reports
ADB/SDK availability, and `kmp-test android --json --project-root .` works standalone regardless.
Google's `android` CLI is a separate, optional layer for emulator, screen-capture, and UI-debug
tooling with its own independent output format (see Tool selection below) — using it or not never
changes `kmp-test`'s own envelope shape. See [`references/workflows/overview.md`](references/workflows/overview.md)
for the per-environment deep-dives when useful.

## Tool selection — `kmp-test` vs `android` CLI overlap

`android describe`/`android info` overlap with `kmp-test parallel --dry-run --json`/`kmp-test
doctor --json`. Default to `kmp-test`: versioned JSON (`schema_version: 2`), cross-platform,
side-effect-free on `--dry-run`. `android info` is plain text, not JSON; `android describe` is a
paths-pointer tool with a known Windows bug at 0.7.15. Use `android` CLI for SDK probing or
emulator/UI work `kmp-test` doesn't cover. Mapping: [`references/cli/envelope-schema.md` section
Cross-tool comparison](references/cli/envelope-schema.md#cross-tool-comparison-android-cli-analogues).

## Steps

### 1. Run the relevant test type

Use the right subcommand based on what the user asked for:

| User intent | Subcommand | Notes |
|-------------|-----------|-------|
| "run tests" / "run unit tests" / "test this" | `kmp-test parallel --json --project-root .` | Dispatches `test`/`jvmTest`/`desktopTest` per module, in parallel |
| "run instrumented tests" / "run on device" | `kmp-test android --json --project-root .` | Dispatches `connectedAndroidTest`; needs a device/emulator |
| "run coverage" / "with coverage" | `kmp-test coverage --json --project-root .` | Aggregates kover/jacoco XML across modules |
| "run benchmarks" | `kmp-test benchmark --json --project-root .` | Dispatches macro/microbenchmark tasks |
| "what would run?" / "dry run" | append `--dry-run` to any subcommand | No spawn — emits the plan as JSON |
| "run only changed tests" | `kmp-test changed --json --project-root .` | Modules touched in the git working tree |

> Per-subcommand deep-dives: [`workflows/overview.md`](references/workflows/overview.md).

### 2. Parse the JSON envelope

Full shape: [`references/cli/envelope-schema.md`](references/cli/envelope-schema.md); exit codes:
[`references/cli/exit-codes.md`](references/cli/exit-codes.md). `errors[{message,code?,...extra}]`
carries discriminated codes — `no_test_modules` (`caused_by_filter`), `module_failed`
(`setup_failed`), `task_not_found`, `unsupported_class_version`, `instrumented_setup_failed`,
`flavor_unused`, `isolated_runtime_race`, `coverage_threshold_exceeded`, `lock_held`,
`no_gradlew`, `missing_shell` — plus soft codes that don't promote `exit_code`: `no_summary`,
`no_changed_modules`.

### 3. Report failures with module attribution

Per `errors[]` entry, surface the module, the `code` plus discriminators (`caused_by_filter`,
`setup_failed`), and the full `message`. For test failures, drill into
`modules[].test_failures[{test,cause,type}]` — `test` is the fully-qualified `ClassName.methodName`,
`cause` the failure message, `type` the optional exception class.

## Convenience scripts

Optional, source-checkout only — these paths may not resolve once installed as a plugin or via
agentskills.io; prefer the direct `kmp-test` invocations above.

`run-tests.sh` / `run-tests.ps1` wrap the same JSON envelope as a direct `kmp-test` call.
`detect-env.sh` / `detect-env.ps1` print a plain `HAS_ANDROID_CLI` / `NO_ANDROID_CLI` token
instead.

| Script | Purpose |
|---|---|
| `detect-env.sh` / `detect-env.ps1` | Prints `HAS_ANDROID_CLI` or `NO_ANDROID_CLI`; exits 0 either way. `run-tests.sh`'s env preamble; also callable standalone. |
| `run-tests.sh` / `run-tests.ps1` | Dispatcher — first positional (`-Type` on PowerShell) selects `unit` (default) / `android` / `coverage` / `benchmark` / `changed` / `info` / `doctor` / `describe`; remaining args forward verbatim, `--json` + `--project-root .` auto-inject. |

## Verification

Confirm the envelope matches `exit_code`:

1. `0` — success: `errors[]` empty, or only soft codes (`no_summary`, `no_changed_modules`).
2. `1` — a test failed: drill into `modules[].test_failures[]`.
3. `2` — CLI usage error: check `errors[].code` (`invalid_*`, `flavor_unused`,
   `isolated_runtime_race`, `no_test_modules` + `caused_by_filter:true`).
4. `3` — environment error: run `kmp-test doctor --json --project-root .` (`lock_held`,
   `no_gradlew`, `missing_shell`, `task_not_found`, `unsupported_class_version`,
   `instrumented_setup_failed`, or `no_test_modules` + `caused_by_filter:false`).

## Guidelines

- **Never run `gradle clean`** first — wastes time; dispatch is already incremental.
- **`--module-filter`** narrows scope to a module subset — e.g. `--module-filter core-network`
  matches modules whose name contains "core-network".
- **`--test-filter`** narrows to one test in large, slow suites, using
  `FullyQualifiedClassName#methodName` — e.g. `--test-filter com.example.MyTest#myMethod`.
- **Avoid `--no-coverage`** unless coverage genuinely doesn't apply — `coverage{}` is often what
  the agent wants.
- **`--dry-run`** plans without running — same envelope shape, `dry_run: true`.
- **Don't conflate `parallel` and `android`** — unit (`*:test`/`*:jvmTest`) vs instrumented
  (`*:connectedAndroidTest`).
- **Unknown error codes are opaque** — forward `code`/`message` verbatim; new codes can land in
  additive releases.

## Troubleshooting

Branch on `errors[].code` — root-cause and recovery steps live in
[`references/troubleshooting/overview.md`](references/troubleshooting/overview.md), keyed by code:

- `no_test_modules` — `caused_by_filter` splits user-filter (CONFIG_ERROR 2) from project-wide
  (ENV_ERROR 3).
- `task_not_found` / `module_failed` / `unsupported_class_version` — wrong subcommand/AGP
  mismatch; a real failure (`setup_failed`); or a JDK mismatch (`kmp-test doctor`).
- `instrumented_setup_failed` / `flavor_unused` / `isolated_runtime_race` / `lock_held` — device
  problem; unmatched `--flavor`; a shared-resource race; or a held lock (`--force`).

## References

- [`references/cli/envelope-schema.md`](references/cli/envelope-schema.md) — full JSON envelope shape (schema:2)
- [`references/cli/exit-codes.md`](references/cli/exit-codes.md) — exit-code semantics + WS-5 invariant
- [`references/cli/flags-reference.md`](references/cli/flags-reference.md) — CLI flags table (all subcommands + global options)
- [`references/workflows/overview.md`](references/workflows/overview.md) — workflow navigation hub
- [`references/troubleshooting/overview.md`](references/troubleshooting/overview.md) — troubleshooting navigation hub

---

> **Skill source**: published as part of `kmp-test-runner`. Open standard: [agentskills.io](https://agentskills.io). Source: [github.com/oscardlfr/kmp-test-runner](https://github.com/oscardlfr/kmp-test-runner).

---
name: kmp-test-runner
description: "Parallel test runner for Kotlin Multiplatform (KMP) and Android Gradle projects via the kmp-test CLI. Runs unit tests, instrumented tests on devices and emulators, coverage (kover/jacoco), and benchmarks across multi-module projects. Use when the user asks to run tests, the project is slow with gradle's default sequential dispatch, or the agent needs structured JSON output to parse failures and module attribution."
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

## Quick start

If `kmp-test` is installed and the project has `gradlew`, run:

```bash
kmp-test parallel --json
```

Parse the JSON envelope (see [`references/cli/envelope-schema.md`](references/cli/envelope-schema.md)) for module-level results and failure details.

## Prerequisites

1. `kmp-test` CLI installed:
   - npm: `npm install -g kmp-test-runner`
   - or shell installer: `curl -fsSL https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/install.sh | bash`
2. `gradlew` (or `gradlew.bat` on Windows) at project root. If missing, the project must initialize the gradle wrapper first.
3. JDK 17+ available. The CLI auto-selects a compatible JDK from `~/.kmp-test/config.json`, `JAVA_HOME`, or its built-in catalogue. Run `kmp-test doctor` to diagnose.

## Environment detection

Before running INSTRUMENTED tests, branch on Android CLI presence. The skill ships a dedicated detector (also useful as a stable executable for agent invocation):

```bash
bash .skills/kmp-test-runner/scripts/detect-env.sh
# → prints HAS_ANDROID_CLI or NO_ANDROID_CLI; exits 0 either way
```

```powershell
pwsh .skills/kmp-test-runner/scripts/detect-env.ps1
```

Inline equivalent (fallback for agents that can't execute scripts):

```bash
which android && android info >/dev/null 2>&1 && echo "HAS_ANDROID_CLI" || echo "NO_ANDROID_CLI"
```

If `HAS_ANDROID_CLI`, use `android emulator` / `android screen capture` / `android layout` for enhanced workflows.
If `NO_ANDROID_CLI`, fall back to ADB directly (`adb devices`, `adb shell screencap`, `adb shell uiautomator dump`).

Both paths produce the same `kmp-test --json` envelope. The Android CLI verbs only enrich the agent's troubleshooting surface, not the test dispatch itself.

Per-branch deep-dives:
- HAS_ANDROID_CLI → [`references/workflows/instrumented/with-android-cli.md`](references/workflows/instrumented/with-android-cli.md) + [`references/troubleshooting/instrumented-setup-failed/with-android-cli.md`](references/troubleshooting/instrumented-setup-failed/with-android-cli.md)
- NO_ANDROID_CLI → [`references/workflows/instrumented/without-android-cli.md`](references/workflows/instrumented/without-android-cli.md) + [`references/troubleshooting/instrumented-setup-failed/without-android-cli.md`](references/troubleshooting/instrumented-setup-failed/without-android-cli.md)

## Tool selection — `kmp-test` vs `android` CLI overlap

Two `android` CLI subcommands superficially overlap with `kmp-test`: `android describe` (with `kmp-test parallel --dry-run --json`) and `android info` (with `kmp-test doctor --json`). **Default to `kmp-test`** for these flows — its `--json` envelope is versioned (`schema_version: 2`), cross-platform, side-effect-free on `--dry-run`, and carries discriminated `errors[].code` + `warnings[].code`. `android info` is plain text (not JSON), and `android describe` is a paths-to-JSON-files pointer tool with a separate consumption model and a known Windows portability bug at 0.7.15. Use `android` CLI when probing SDK quickly (`android info | grep sdk`) or for emulator / screen / UI workflows `kmp-test` does not cover. Field-by-field mapping: [`references/cli/envelope-schema.md` § Cross-tool comparison](references/cli/envelope-schema.md#cross-tool-comparison-android-cli-analogues).

## Steps

### 1. Diagnose the environment

```bash
kmp-test doctor
```

Confirms gradlew, JDK, ADB (optional), Kotlin/AGP versions, project shape. Exits non-zero with `errors[].code` if anything blocks running tests.

### 2. Run the relevant test type

Use the right subcommand based on what the user asked for:

| User intent | Subcommand | Notes |
|-------------|-----------|-------|
| "run tests" / "run unit tests" / "test this" | `kmp-test parallel --json` | Dispatches `<module>:test`, `<module>:jvmTest`, `<module>:desktopTest` across modules in parallel |
| "run instrumented tests" / "run on device" | `kmp-test android --json` | Dispatches `<module>:connectedAndroidTest`. Requires a connected device or emulator |
| "run coverage" / "with coverage" | `kmp-test coverage --json` | Aggregates kover/jacoco XML across all modules with coverage plugins applied |
| "run benchmarks" | `kmp-test benchmark --json` | Dispatches macrobenchmark/microbenchmark tasks |
| "what would run?" / "dry run" | append `--dry-run` to any subcommand | No spawn — emits the plan as JSON |
| "run only changed tests" | `kmp-test changed --json` | Restricts dispatch to modules touched in the current git working tree |

> Per-subcommand workflow deep-dives (common flags, edge cases, recommended combinations) are documented in `references/workflows/` — start at [`workflows/overview.md`](references/workflows/overview.md).

### 3. Parse the JSON envelope

The envelope shape is documented at [`references/cli/envelope-schema.md`](references/cli/envelope-schema.md). Key fields:

- `tool: "kmp-test"`, `schema_version: 2`, `subcommand: <name>`
- `exit_code: 0|1|2|3` (see [`references/cli/exit-codes.md`](references/cli/exit-codes.md))
- `tests: { total, passed, failed, skipped, individual_total? }`
- `modules: [{ name, type, coverage_plugin, test_build_type, has_flavor, android_dsl, android_dsl_variant, test_failures }]`
- `errors: [{ message, code?, ...extra }]` — discriminated codes include `no_test_modules` (with `caused_by_filter:bool`), `module_failed` (with `setup_failed:bool`), `task_not_found`, `unsupported_class_version`, `instrumented_setup_failed`, `flavor_unused`, `isolated_runtime_race`, `coverage_threshold_exceeded`, `lock_held`, `no_gradlew`, `missing_shell`. Soft codes (do NOT promote exit_code): `no_summary`, `no_changed_modules`
- `skipped: [{ module, reason }]`
- `coverage: { tool, missed_lines, modules_with_kover_plugin, modules_with_jacoco_plugin, module_buckets: { with_data, no_xml, parse_errored, skipped_by_user } }`
- Optional subcommand-specific block: `parallel`, `android`, `benchmark`, `changed`, `doctor`, `info`, `describe`, `isolated`

### 4. Report failures with module attribution

For each `errors[]` entry, surface:
- The module (from the entry's `module` field or `extra.module`)
- The error `code` (if discriminated) and any discriminator fields (`caused_by_filter`, `setup_failed`)
- The full `message`

For test failures (not setup errors), drill into per-module `modules[].test_failures[]` to find failing test names. Each `test_failures[]` entry carries `{ test, cause, type }` — `test` is the fully-qualified `ClassName.methodName`, `cause` is the failure/error message, `type` is the optional exception class.

## Convenience scripts

The skill ships executable helpers under `.skills/kmp-test-runner/scripts/` for the two common patterns. They return the same JSON envelope as direct `kmp-test` invocation — use whichever surface fits the host shell.

| Script | Purpose |
|---|---|
| `detect-env.sh` / `detect-env.ps1` | Prints `HAS_ANDROID_CLI` or `NO_ANDROID_CLI` to stdout. Exits 0 either way. Used as the env preamble in `run-tests.sh`, also callable standalone. |
| `run-tests.sh` / `run-tests.ps1` | Smart dispatcher. First positional (`-Type` on PowerShell) picks the subcommand: `unit` (default) / `android` / `coverage` / `benchmark` / `changed` / `info` / `doctor` / `describe`. Remaining args forward verbatim; `--json` + `--project-root .` inject automatically. For `android`, emits `[INFO] env: HAS_ANDROID_CLI\|NO_ANDROID_CLI` to stderr. |

Example:

```bash
bash .skills/kmp-test-runner/scripts/run-tests.sh android --device R3CT30KAMEH
# [INFO] env: HAS_ANDROID_CLI                          (stderr)
# {"tool":"kmp-test","subcommand":"android",...}      (stdout)
```

## Verification

After the run, confirm:

1. `kmp-test --version` prints the installed version (current: 0.10.0+).
2. For a successful run, the envelope has `exit_code: 0` and `errors[]` is empty (or contains only soft codes like `no_summary` / `no_changed_modules`).
3. If `exit_code` is `1`, tests ran but at least one failed — drill into `modules[].test_failures[]`.
4. If `exit_code` is `2`, it's a CLI usage error — check `errors[].code` (typically `invalid_*`, `flavor_unused`, `isolated_runtime_race`, or `no_test_modules` with `caused_by_filter:true`).
5. If `exit_code` is `3`, it's an environment error — re-run `kmp-test doctor` to localize (`lock_held`, `no_gradlew`, `missing_shell`, `task_not_found`, `unsupported_class_version`, `instrumented_setup_failed`, or `no_test_modules` with `caused_by_filter:false`).

## Guidelines

- **Never run `gradle clean`** before tests — it wastes time and the CLI handles incremental dispatch correctly.
- **Use `--module-filter <glob>`** to narrow scope when the user asks for a specific module subset (e.g. `--module-filter "core-*"`).
- **Use `--test-filter <FQN>#<method>`** for single-test scope, especially in big projects where the full suite is slow.
- **Avoid `--no-coverage`** unless coverage genuinely doesn't apply — the JSON `coverage{}` field is often what the agent wants.
- **Respect `--dry-run`** when the user wants to plan before executing — emits the same envelope shape with `dry_run: true`.
- **Don't conflate `parallel` and `android` subcommands** — `parallel` is unit tests (`*:test`, `*:jvmTest`); `android` is instrumented (`*:connectedAndroidTest`). The agent must dispatch the right one.
- **Treat unknown error codes as opaque** — forward them to the user verbatim along with the `message` field. New codes can land in additive (non-schema-bumping) releases.

## Troubleshooting

See [`references/troubleshooting/overview.md`](references/troubleshooting/overview.md) for the troubleshooting hub. Common error codes:

- `no_test_modules` — gradle probe found zero modules with test tasks. Check `caused_by_filter` to discriminate user-filter vs project-wide: `true` → CONFIG_ERROR (2), `false` → ENV_ERROR (3).
- `task_not_found` — the specific gradle task (e.g. `:connectedAndroidTest`) doesn't exist on the requested module. Most often AGP version mismatch or wrong subcommand.
- `module_failed` — a gradle task failed. Check `setup_failed:bool` to discriminate test-failure vs compile/setup failure (the latter has no JUnit XML evidence).
- `unsupported_class_version` — JDK toolchain mismatch (project requires newer JDK than runtime). Run `kmp-test doctor` and consider setting `java_home` in `~/.kmp-test/config.json`.
- `instrumented_setup_failed` — emulator/device problem. Check `adb devices`. If `android` CLI is available, also `android emulator list`.
- `flavor_unused` — `--flavor <name>` supplied but no module declares matching `productFlavors {}`. Orchestrator early-exits before any gradle dispatch.
- `isolated_runtime_race` — `--isolated` combined with a test-type that hits a shared runtime resource (iOS simulator, ADB without `--device`, or `--test-type all`).
- `lock_held` — another `kmp-test` process holds the project lock. Pass `--force` to bypass when safe.

> Per-code troubleshooting deep-dives (root cause analysis, recovery steps, AGP-specific quirks) live under [`references/troubleshooting/`](references/troubleshooting/overview.md) — see the overview's status table for coverage.

## References

- [`references/cli/envelope-schema.md`](references/cli/envelope-schema.md) — full JSON envelope shape (schema:2)
- [`references/cli/exit-codes.md`](references/cli/exit-codes.md) — exit-code semantics + WS-5 invariant
- [`references/cli/flags-reference.md`](references/cli/flags-reference.md) — CLI flags table (all subcommands + global options)
- [`references/workflows/overview.md`](references/workflows/overview.md) — workflow navigation hub
- [`references/troubleshooting/overview.md`](references/troubleshooting/overview.md) — troubleshooting navigation hub

---

> **Skill source**: published as part of `kmp-test-runner`. Open standard: [agentskills.io](https://agentskills.io). Source: [github.com/oscardlfr/kmp-test-runner](https://github.com/oscardlfr/kmp-test-runner).

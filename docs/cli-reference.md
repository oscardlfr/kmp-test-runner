# CLI reference

```text
kmp-test <subcommand> [--project-root <path>] [options]
```

Values may be passed as `--name value` or, on POSIX shells, `--name=value`.
Run `kmp-test <subcommand> --help` for the installed version's concise help.
This reference describes the v0.14.0 implementation.

## Subcommands

| Command | Purpose | Runs Gradle |
|---|---|---:|
| `parallel` | Resolve and run module test tasks, then aggregate coverage | Yes |
| `changed` | Map Git changes to modules and run their parallel workflow | Yes, unless no modules |
| `android` | Run Android instrumented tests on an ADB device | Yes |
| `benchmark` | Run JVM and/or Android benchmark tasks | Yes |
| `coverage` | Discover coverage metadata and aggregate existing Kover/JaCoCo XML | Configuration probe only when the model cache is absent |
| `doctor` | Diagnose the host and project prerequisites | No |
| `info` | Return raw environment paths and versions | No |
| `describe` | Model modules, test tasks, coverage and dependencies | Probe only unless `--skip-probe` |
| `update` | Check or install the latest GitHub release | No Gradle; may run installer |
| `clean` | Remove runner-owned artifacts | No |

## Cross-command options

These flags are parsed before subcommand dispatch, but they are not meaningful for every
subcommand. The applicability column is part of the contract.

| Option | Default | Applies to | Meaning |
|---|---|---|---|
| `--project-root <path>` | current directory | all subcommands | Gradle project root |
| `--json` | off | all subcommands | Emit one schema-2 JSON object on stdout |
| `--format json` | off | all subcommands | Alias for `--json` |
| `--dry-run` | off | `parallel`, `changed`, `android`, `benchmark`, `coverage`, `clean` | Return the resolved plan, or the cleanup preview, without performing the operation. `update` rejects it; use `update --check` for a non-mutating probe |
| `--force` | off | runner-backed commands and `clean`; `update` has separate semantics | Bypass the project advisory lock; on `update`, reinstall an equal version |
| `--isolated` | off | runner-backed commands | Use a per-run Gradle project-cache directory |
| `--isolated-cache-dir <path>` | generated | runner-backed commands | Use a caller-owned cache directory; implies `--isolated` |
| `--isolated-no-lock` | off | runner-backed commands | Skip the advisory lock; implies `--isolated` |
| `--test-filter <pattern>` | none | `parallel`, `android`, `benchmark` | Narrow tests; translation and support depend on the target task |
| `--color <mode>` | `auto` | runner-backed commands | `auto`, `always`, or `never` |
| `--help`, `-h` | — | all subcommands | Print help |
| `--version`, `-v` | — | all subcommands | Print the package version |

Isolation options affect test/report-task dispatch. `coverage` never dispatches
those tasks, so the options have no execution to isolate; an uncached invocation
may still run the read-only `gradlew tasks --all --quiet` configuration probe.

## Test-type values

The validated `--test-type` values are:

| Value | Dispatch |
|---|---|
| `common` | JVM/desktop candidate chain; excludes JS/Wasm and Android host-only tasks |
| `jvm` | Same JVM-side candidate chain as `common` |
| `desktop` | Same JVM-side candidate chain as `common` |
| `android` | Alias of the Android host-unit leg |
| `androidUnit` | Android unit or KMP Android host tests |
| `androidInstrumented` | Connected Android device tests |
| `ios` | iOS test task resolved per module; macOS host required |
| `macos` | macOS native test task resolved per module; macOS host required |
| `js` | Resolved JavaScript test task |
| `wasm` | Resolved `wasmJsTest` task |
| `all` | common + desktop + Android unit; adds instrumented when ADB is enabled and iOS/macOS on macOS |

`all` does not add the explicit `js` and `wasm` legs.

## `parallel`

```text
kmp-test parallel [--project-root <path>] [options]
```

### Selection and execution

| Option | Default | Meaning |
|---|---|---|
| `--test-type <type>` | auto | Select a test surface from the table above |
| `--module-filter <globs>` | `*` | Comma-separated module globs |
| `--exclude-modules <globs>` | none | Comma-separated module globs removed from test dispatch |
| `--include-untested` | off | Include modules without recognized test-source directories |
| `--include-shared` | off | Include the configured sibling shared project |
| `--test-filter <pattern>` | none | Test class or class/method filter |
| `--max-workers <N>` | `0` | Gradle auto-selection at zero; positive values add `--max-workers=N` |
| `--timeout <seconds>` | `600` | Per-dispatch watchdog; zero disables it |
| `--fresh-daemon` | off | Run the wrapper's Gradle daemon stop step before dispatch |
| `--benchmark` | off | Internal composition switch; normal callers should use the dedicated `benchmark` subcommand |
| `--list`, `--list-only` | off | Return the post-filter module set without Gradle execution |
| `--gradle-args <string>` | none | Append whitespace-split Gradle arguments; repeatable and last-wins |

### Coverage

| Option | Default | Meaning |
|---|---|---|
| `--coverage-tool <tool>` | `auto` | `auto`, `kover`, `jacoco`, or `none` |
| `--no-coverage` | off | Alias for `--coverage-tool none` |
| `--coverage-modules <names>` | all detected | Exact comma-separated colonless module names |
| `--exclude-coverage <names>` | none | Exact comma-separated colonless module names |
| `--min-missed-lines <N>` | `0` | A positive value enables failure when the complete aggregate exceeds N; zero disables the budget |
| `--no-coverage-xml-autofix` | off | Do not force JaCoCo XML reports on |
| `--skip-tests` | off | Skip test dispatch and aggregate reports already on disk |
| `--coverage-only` | off | Coverage-only path; implies skipped tests |
| `--output-file <path>` | generated | Explicit report path; otherwise `.kmp-test-runner/reports/coverage/<runId>.md` plus `latest.md` |

### Android leg

| Option | Default | Meaning |
|---|---|---|
| `--variant <value>` | `auto` | `auto`, `debug`, `release`, or `all`; `--android-variant` is the legacy alias |
| `--flavor <name>` | none | Android product flavor |
| `--device <serial>` | auto when unambiguous | Pin the ADB device |
| `--device-task <name>` | resolved | Override the module's instrumented Gradle task |
| `--auto-retry` | off | Retry runtime-failed instrumented tasks once |
| `--clear-data` | off | Clear package data before a requested auto-retry; use with `--auto-retry` |
| `--capture-on-fail` | off | Capture screenshot and UI hierarchy after module failure |
| `--capture-dir <path>` | per-run Android log directory | Override capture directory; implies capture |

### Runtime and safety

| Option | Default | Meaning |
|---|---|---|
| `--java-home <path>` | none | Select this JDK for the run |
| `--no-jdk-autoselect` | off | Disable catalogue selection |
| `--ignore-jdk-mismatch` | off | Bypass the preflight JDK mismatch block |
| `--isolated` | off | Isolate Gradle project-cache state |
| `--isolated-cache-dir <path>` | generated | Caller-owned isolated cache |
| `--isolated-no-lock` | off | Allow overlapping isolated invocations |

## `changed`

```text
kmp-test changed [--project-root <path>] [options]
```

| Option | Default | Meaning |
|---|---|---|
| `--staged-only` | off | Inspect only staged changes |
| `--show-modules-only` | off | Return changed modules without tests |
| `--include-shared` | off | Include the configured sibling project |
| `--test-type <type>` | auto | Forwarded to the parallel delegate |
| `--test-filter <pattern>` | none | Forwarded test filter |
| `--exclude-modules <globs>` | none | Exclude module globs |
| `--include-untested` | off | Retain modules without standard test-source directories |
| `--coverage-tool <tool>` | `auto` | Coverage selection |
| `--no-coverage` | off | Disable coverage |
| `--exclude-coverage <names>` | none | Exact module exclusions |
| `--min-missed-lines <N>` | `0` | Coverage budget |
| `--variant`, `--android-variant` | `auto` | Android variant forwarded to parallel |
| `--gradle-args <string>` | none | Append Gradle arguments |
| JDK and isolation flags | off | Same semantics as `parallel` |

The module set is Git-derived; use `--show-modules-only` instead of a module
filter to preview it. A clean diff emits `no_changed_modules` with exit 0.

## `android`

```text
kmp-test android [--project-root <path>] [options]
```

| Option | Default | Meaning |
|---|---|---|
| `--device <serial>` | auto when unambiguous | Select ADB target |
| `--device-task <name>` | resolved | Force a Gradle task name |
| `--module-filter <globs>` | all | Select Android modules |
| `--skip-app` | off | Remove `app`, `androidApp`, and `*App` modules |
| `--verbose` | off | Show the last 30 log lines on failure |
| `--flavor <name>` | none | Select Android flavor |
| `--variant`, `--android-variant` | `auto` | Android build variant |
| `--test-filter <pattern>` | none | Instrumented class or class/method filter |
| `--auto-retry` | off | Retry runtime failures once |
| `--clear-data` | off | Clear package before a requested auto-retry |
| `--capture-on-fail` | off | Collect post-failure screenshot and hierarchy |
| `--capture-dir <path>` | per-run | Override capture directory |
| `--list`, `--list-only` | off | Discover modules without dispatch |
| `--no-adb` | off | Skip ADB and imply list-only |
| `--gradle-args <string>` | none | Append Gradle arguments |
| JDK and isolation flags | off | Same semantics as `parallel` |

## `benchmark`

```text
kmp-test benchmark [--project-root <path>] [options]
```

| Option | Default | Meaning |
|---|---|---|
| `--config <name>` | `smoke` | `smoke`, `main`, or `stress` |
| `--platform <name>` | `all` | `all`, `jvm`, or `android` |
| `--module-filter <globs>` | `*` | Select benchmark modules |
| `--include-shared` | off | Include configured sibling modules |
| `--test-filter <pattern>` | none | Android-only effective filter; JVM legs are skipped with a warning |
| `--variant`, `--android-variant` | `auto` | Android benchmark variant |
| `--timeout <seconds>` | profile default | Task watchdog; zero disables |
| `--ignore-gradle-timeout` | off | Disable watchdog |
| `--strict-timeouts` | off | Make every timeout an exit-3 error |
| `--gradle-args <string>` | none | Append Gradle arguments |
| JDK and isolation flags | off | Same semantics as `parallel` |

Benchmark dispatch injects Gradle `--no-configuration-cache` by default to avoid
stale kotlinx-benchmark paths. An explicit later Gradle argument can override it.

## `coverage`

```text
kmp-test coverage [--project-root <path>] [options]
```

| Option | Default | Meaning |
|---|---|---|
| `--coverage-tool <tool>` | `auto` | `auto`, `kover`, `jacoco`, or `none` |
| `--coverage-modules <names>` | all detected | Exact comma-separated module names |
| `--exclude-coverage <names>` | none | Exact comma-separated module names |
| `--min-missed-lines <N>` | `0` | Coverage budget |
| `--flavor <name>` | first discovered flavor | Select per-variant Android report |
| `--output-file <path>` | generated | Explicit path or the managed run-id report tree |
| `--skip-tests` | implicit | Accepted no-op for parity; coverage never runs tests |
| JDK flags | off | Apply to project-model probing when needed |

## Diagnostic and maintenance commands

### `doctor`

`kmp-test doctor [--project-root <path>] [--json]` checks Node, the platform
shell, Gradle wrapper, JDK, JDK catalogue, Android SDK, local configuration, and
ADB. Missing optional project/device prerequisites are warnings; critical host
failures produce exit 3.

### `info`

`kmp-test info [--project-root <path>] [--no-adb] [--json]` reports raw values
without grading them. It always exits 0; missing tools appear as null or absent
values.

### `describe`

| Option | Default | Meaning |
|---|---|---|
| `--module-filter <regex>` | all | JavaScript regular expression applied to module names |
| `--skip-probe` | off | Static/cached modelling only |
| `--no-cache` | off | Bypass the model/tasks cache |
| JDK flags | off | Control the Gradle task probe |

`describe` emits JSON by default. A missing Gradle settings file is reported as
`no_project`.

### `update`

| Option | Default | Meaning |
|---|---|---|
| `--check` | off | Probe only; never install |
| `--force` | off | Reinstall an equal version |
| `--prefix <path>` | platform installer default | Forward install prefix |
| `--prerelease` | off | Allow prerelease tags |

### `clean`

| Option | Default | Meaning |
|---|---|---|
| `--all` | off | Also remove model/task cache and reports |
| `--dry-run` | off | List targets and sizes without deleting |
| `--force` | off | Proceed despite a live project lock |

`clean` never removes `.kmp-test-runner.json` or the project lockfile itself.

## JSON contract and exit codes

Every `--json` response has the common fields `tool`, `schema_version`,
`subcommand`, `version`, `project_root`, `exit_code`, `duration_ms`, `tests`,
`modules`, `skipped`, `coverage`, `errors`, and `warnings`, plus a
subcommand-specific block where applicable.

| Exit | Meaning |
|---:|---|
| `0` | Success, including documented no-op outcomes |
| `1` | Tests or a run-level operation failed |
| `2` | Invalid usage or contradictory configuration |
| `3` | Host, toolchain, device, task, timeout, or other environment failure |

Do not infer the cause from the number alone. Inspect `errors[].code` and its
discriminator fields. The complete additive schema, error catalogue, warning
catalogue, per-leg accounting, and schema-change rules are defined in
[JSON envelope contract](envelope-contract.md).

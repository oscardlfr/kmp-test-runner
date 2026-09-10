# CLI reference

`kmp-test <command> --help` is the executable source of truth. This page is the reviewable public index; tests compare its flag tables with the parsers to prevent drift.

## Commands

| Command | Main output |
|---|---|
| `parallel` | Parallel test and optional coverage result. |
| `changed` | Git-derived affected modules and their result. |
| `android` | Android instrumented result. |
| `benchmark` | Benchmark result. |
| `coverage` | Aggregated coverage report. |
| `doctor` | Readiness checks. |
| `info` | Environment inventory. |
| `describe` | Project model. |
| `update` | Release/update status. |
| `clean` | Removed or candidate artifact paths. |

## Global and output flags

| Flag | Default | Notes |
|---|---|---|
| `--project-root <path>` | current directory | Gradle project root. |
| `--json` | off | Single JSON envelope on stdout. |
| `--format json` | unset | Alias for JSON output. |
| `--color <mode>` | `auto` | `always`, `never`, or `auto`. |
| `--dry-run` | off | Validate and show the plan without executing Gradle. |
| `--java-home <path>` | auto | Pin the JDK. |
| `--no-jdk-autoselect` | off | Keep the host JDK instead of catalog selection. |
| `--ignore-jdk-mismatch` | off | Downgrade the JDK compatibility gate. |
| `--force` | off | Override the command-specific safety check. |
| `--help` | — | Command help. |
| `--version` | — | CLI version. |

## Test selection

| Flag | Default | Commands |
|---|---|---|
| `--test-type <type>` | auto unit leg | `parallel`, `changed`; accepts `all`, `common`, `jvm`, `androidUnit`, `androidInstrumented`, `desktop`, `ios`, `macos`, `js`, `wasm`. |
| `--module-filter <glob>` | `*` | Applies to `parallel`, `android`, and `benchmark` (not `changed`). |
| `--module-filter <regex>` | unset | A real regular expression for `describe`-only; see the describe section below. |
| `--test-filter <pattern>` | unset | `parallel`, `changed`, and `android`; Android benchmark legs resolve the pattern, while JVM benchmark legs are skipped with `test_filter_unsupported`. |
| `--exclude-modules <list>` | unset | Skip matching modules in `parallel`/`changed`. |
| `--include-untested` | off | Re-include modules without detected test sources. |
| `--include-shared` | off | Include the configured sibling shared project. |
| `--staged-only` | off | Restrict `changed` to staged changes. |
| `--show-modules-only` | off | Resolve `changed` modules without running. |
| `--list` / `--list-only` | off | List selected modules without dispatch. |

## Parallelism, Gradle, and isolation

| Flag | Default | Notes |
|---|---|---|
| `--max-workers <N>` | `0` (auto) | `parallel` worker limit. |
| `--timeout <seconds>` | `600` for `parallel` | Per-task watchdog where supported. |
| `--ignore-gradle-timeout` | off | Disable the benchmark watchdog. |
| `--strict-timeouts` | off | Treat every benchmark timeout as infrastructure failure. |
| `--fresh-daemon` | off | Stop Gradle daemons before dispatch. |
| `--gradle-args <string>` | unset | Append explicit Gradle arguments. |
| `--isolated` | off | Use a per-run Gradle project cache. |
| `--isolated-cache-dir <path>` | temporary | Override the isolated cache path. |
| `--isolated-no-lock` | off | Disable the isolation cache lock. |

Flags passed inside `--gradle-args` belong to Gradle, not to the public parser. For example, use `--gradle-args "--no-configuration-cache"`; there is no top-level `kmp-test --no-configuration-cache` option.

## Coverage

| Flag | Default | Notes |
|---|---|---|
| `--coverage-tool <tool>` | `auto` | `auto`, `jacoco`, `kover`, or `none`. Same default across `parallel`, `coverage`, and `changed` — `info` reports the detected tool but does not accept or resolve this flag. |
| `--no-coverage` | off | Alias for `--coverage-tool none` on supported workflows. |
| `--coverage-modules <list>` | all eligible | Exact modules to aggregate. |
| `--exclude-coverage <list>` | unset | Exact modules to omit from aggregation. |
| `--no-coverage-xml-autofix` | off | Do not force JaCoCo XML output. |
| `--min-missed-lines <N>` | `0` | Fail above the missed-line threshold; zero disables the gate. |
| `--output-file <path>` | run-scoped path | Custom markdown report path. |
| `--skip-tests` | off | Aggregate existing reports without test execution. |
| `--coverage-only` | off | Coverage-only alias in `parallel`. |
| `--benchmark` | off | Internal composition switch accepted by `parallel`; ordinary users should invoke the `benchmark` subcommand. |

Default coverage reports live at `.kmp-test-runner/reports/coverage/<run-id>.md` with `latest.md`. The historical filename `coverage-full-report.md` is treated as a request for the current default location.

## Android device work

| Flag | Default | Notes |
|---|---|---|
| `--device <serial>` | auto | Pin an ADB target. |
| `--device-task <name>` | discovered | Force a Gradle device task. |
| `--variant` / `--android-variant <value>` | `auto` | Select Android build variant. |
| `--flavor <name>` | unset | Select Android product flavor. |
| `--auto-retry` | off | Retry each failed instrumented module once. |
| `--clear-data` | off | Clear app data before retry; implies retry. |
| `--capture-on-fail` | off | Capture screenshot and UI hierarchy after final failure. |
| `--capture-dir <path>` | run log directory | Override capture output; implies capture. |
| `--skip-app` | off | Skip application modules in `android`. |
| `--verbose` | off | Include a larger failure-log tail. |
| `--no-adb` | off | Skip ADB probing where supported. |

## Benchmark, describe, update, and clean

| Flag | Default | Command |
|---|---|---|
| `--config <name>` | `smoke` | `benchmark`: `smoke`, `main`, or `stress`. |
| `--platform <name>` | `all` | `benchmark`: `all`, `jvm`, or `android`. |
| `--skip-probe` | off | `describe`: avoid a live Gradle task probe. |
| `--no-cache` | off | `describe`: ignore the project-model cache. |
| `--check` | off | `update`: resolve the latest release without installing. |
| `--prefix <dir>` | installer default | `update`: install prefix. |
| `--prerelease` | off | `update`: permit prerelease tags. |
| `--all` | off | `clean`: also remove model/task caches. |

`--benchmark-config` is an internal forwarding argument, not a public CLI flag. Use `kmp-test benchmark --config <name>`.

## Describe

Flags: `--module-filter <regex>`, `--skip-probe`, `--no-cache`, `--json`.

```sh
kmp-test describe --json --module-filter "^:sample-result$"
```

Unlike the glob accepted by `parallel`, `android`, and `benchmark`, the `describe` filter is passed to JavaScript's regular-expression engine. Invalid expressions fail with `invalid_regex`.

## Exit codes

| Exit | Contract |
|---:|---|
| `0` | Successful or explicitly warning-only result. |
| `1` | Test/benchmark failure or coverage threshold exceeded. |
| `2` | Invalid input or configuration. |
| `3` | Environment, platform, dependency, or execution failure. |

For field-level semantics, see the [JSON envelope contract](envelope-contract.md).

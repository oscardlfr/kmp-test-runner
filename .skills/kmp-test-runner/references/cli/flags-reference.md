# CLI flag reference

The `kmp-test` CLI shares a common flag surface across subcommands, with per-subcommand additions. This file is the canonical per-flag truth — grounded in `lib/cli.js`'s `SUBCOMMAND_HELP` table. Run `kmp-test <sub> --help` to see the same content rendered live.

## Common flags (accepted by every script-backed subcommand)

| Flag | Default | parallel | coverage | benchmark | changed | android | doctor | info | describe | Notes |
|------|---------|:--------:|:--------:|:---------:|:-------:|:-------:|:------:|:----:|:--------:|-------|
| `--json` | off | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Single JSON envelope on stdout. **Mandatory for agent consumption.** Suppresses human output. |
| `--project-root <path>` | `cwd` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Absolute or relative path to the gradle project root. |
| `--dry-run` | off | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | Plan envelope, exit 0, no gradle spawn. Still validates `gradlew` exists. |
| `--color <mode>` | `auto` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `always` / `never` / `auto`. Auto injects `--console=plain` when stdout is non-TTY or `NO_COLOR` set. Respected by all gradle subprocesses (since v0.10 #1). |
| `--help` | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Per-subcommand help text. |
| `--java-home <path>` | none | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | Explicit JDK. Wins over catalogue auto-select and `gradle.properties org.gradle.java.home`. |
| `--no-jdk-autoselect` | off | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | Disable JDK catalogue auto-select; use host `JAVA_HOME` unmodified. |
| `--ignore-jdk-mismatch` | off | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | Downgrade JDK mismatch gate from BLOCK (exit 3) to WARN. |
| `--force` | off | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | Bypass project lockfile (`errors[].code: lock_held`). Use only when prior `kmp-test` process is known-dead. |

## Test scope + filtering (parallel / changed / benchmark / android)

| Flag | Default | parallel | coverage | benchmark | changed | android | Notes |
|------|---------|:--------:|:--------:|:---------:|:-------:|:-------:|-------|
| `--test-type <type>` | auto-detect | ✓ | — | — | ✓ | — | `all` / `common` / `androidUnit` / `androidInstrumented` / `desktop` / `ios` / `macos` / `jvm` / `js` / `wasm`. |
| `--module-filter <glob>` | `*` | ✓ | — | ✓ | — | ✓ | Glob, comma-separated. Not accepted by `changed` (`unknown_flag`) — its module set is always git-derived; see `--show-modules-only`. |
| `--test-filter <pattern>` | none | ✓ | — | android only | ✓ | ✓ | Single class or `Class#method`. JVM test tasks use gradle `--tests`; Android resolves wildcards to FQN by source scan. **benchmark**: only the android leg filters (`-P` instrumentation args); jvm benchmark legs are SKIPPED with `warnings[].code: test_filter_unsupported` + `skipped[]` entries — kotlinx-benchmark tasks reject `--tests` and have no CLI filter (use `benchmark { configurations { include(...) } }` in the build script, or `--module-filter` + `--config smoke` to narrow). |
| `--exclude-modules <list>` | none | ✓ | — | — | ✓ | — | Comma-separated globs to skip entirely (not probed, not tested). |
| `--include-untested` | off | ✓ | — | — | ✓ | — | Re-include modules auto-skipped because filesystem has no `src/*Test*` directory. |
| `--include-shared` | off | ✓ | — | ✓ | ✓ | — | Include sibling shared-libs project (composite-build context). |

## Coverage (parallel / coverage / changed)

| Flag | Default | parallel | coverage | changed | Notes |
|------|---------|:--------:|:--------:|:-------:|-------|
| `--coverage-tool <tool>` | `auto` (parallel/coverage), `jacoco` (changed) | ✓ | ✓ | ✓ | `auto` / `jacoco` / `kover` / `none`. **Default diverges**: `changed`'s historical default is `jacoco`. |
| `--no-coverage` | off | ✓ (alias) | — | ✓ (alias) | Sugar for `--coverage-tool none`. Expanded via `expandNoCoverageAlias` in `lib/parsers/argv.js`. |
| `--coverage-modules <list>` | all with plugin | ✓ | ✓ | — | Comma-separated **exact** module names (no leading `:`, no glob/substring) to include in coverage aggregation. |
| `--exclude-coverage <list>` | none | ✓ | ✓ | ✓ | Comma-separated **exact** module names (same matching rules as `--coverage-modules`) to skip from coverage aggregation only (tests still run). |
| `--no-coverage-xml-autofix` | off | ✓ | — | — | Disable the auto-injected init-script that forces jacoco `xml.required=true` on the coverage-report leg. By default `kmp-test` enables jacoco XML so HTML-only `jacocoTestReport` modules still produce parseable XML. No-op for Kover. Opting out surfaces `coverage_xml_disabled` for HTML-only modules. |
| `--min-missed-lines <N>` | `0` | ✓ | ✓ | ✓ | Fail (`coverage_threshold_exceeded`, exit 1) if aggregated missed lines exceed `N`. `0` = no gate. |
| `--output-file <path>` | (writes under `.kmp-test-runner/reports/coverage/`) | ✓ | ✓ | — | Path for the markdown report. Absolute → verbatim; relative → resolved against `--project-root`. When omitted (or set to the historic literal `coverage-full-report.md`), writes to `.kmp-test-runner/reports/coverage/<runId>.md` with a `latest.md` alias. With a custom path, only that file is written — no alias. |
| `--skip-tests` | off (set internally by `coverage`) | ✓ | implicit | — | Skip test execution; aggregate coverage from existing reports. Coverage subcommand sets this internally. |
| `--coverage-only` | off | ✓ | — | — | Generate only coverage report — implies `--skip-tests`, skips test discovery. |

## Parallelism + scheduling (parallel / benchmark / changed)

| Flag | Default | parallel | coverage | benchmark | changed | android | Notes |
|------|---------|:--------:|:--------:|:---------:|:-------:|:-------:|-------|
| `--max-workers <N>` | `0` (auto) | ✓ | — | — | — | — | Parallel gradle workers. `0` = gradle decides. Not accepted by `changed` (`unknown_flag`). |
| `--timeout <seconds>` | `600` (parallel), per-config (benchmark) | ✓ | — | ✓ | — | — | Per-task gradle watchdog. `0` disables. |
| `--ignore-gradle-timeout` | off | — | — | ✓ | — | — | Disable watchdog entirely. Wins over `--timeout` and `KMP_GRADLE_TIMEOUT_MS`. |
| `--max-failures <N>` | `0` (run all) | — | — | — | ✓ | — | Stop after `N` per-module failures (changed only). |
| `--fresh-daemon` | off | ✓ | — | — | — | — | Stop gradle daemons before launching. Costs ~5 s cold-start; useful when daemon state is suspect. |
| `--gradle-args "<args>"` | none | ✓ | — | ✓ | ✓ | ✓ | Escape hatch — tokens appended LAST (gradle last-wins). |

## Android variant + instrumented dispatch

| Flag | Default | parallel | benchmark | changed | android | Notes |
|------|---------|:--------:|:---------:|:-------:|:-------:|-------|
| `--variant` / `--android-variant <val>` | `auto` | ✓ | ✓ | ✓ | ✓ | `auto` (respects `testBuildType="release"`) / `debug` / `release` / `all`. JVM benchmarks ignore. |
| `--device <serial>` | auto | ✓ (`androidInstrumented`) | — | — | ✓ | Pin ADB device. Validated against `adb devices`; pins `ANDROID_SERIAL`. Mismatched serial → `instrumented_setup_failed` (exit 3). |
| `--device-task <name>` | auto | ✓ (`androidInstrumented`) | — | — | ✓ | Force gradle task name (e.g. `androidConnectedCheck` for `androidLibrary { }` DSL). Preempts auto-resolution. |
| `--auto-retry` | off | ✓ (`androidInstrumented`) | — | — | ✓ | Re-dispatch instrumented tasks that ran but failed. One retry per task. Surfaces `parallel.legs[i].retries[]`. |
| `--clear-data` | off | ✓ (`androidInstrumented`) | — | — | ✓ | `adb shell pm clear <pkg>` before retry. Implies `--auto-retry`. |
| `--flavor <name>` | none | ✓ (`androidUnit`/`androidInstrumented`/`all` + coverage) | — | — | ✓ | Android `productFlavors` weave for the unit (`test${Cap}${Variant}UnitTest`), instrumented (`connected${Cap}${Variant}AndroidTest`), and coverage report tasks. Convention-applied flavors are recovered from the gradle probe. No `--flavor` on a flavored project → flavor-agnostic umbrella (`test`/`connectedAndroidTest`) + `flavor_defaulted_umbrella` warning. `--flavor` on a non-flavored project → `flavor_unused` (exit 2). |
| `--capture-on-fail` | off | ✓ (`androidInstrumented`) | — | — | ✓ | On instrumented-module failure, capture a device screenshot (`adb exec-out screencap`) + UI-hierarchy dump (`adb exec-out uiautomator dump`), best-effort. Paths surface on `errors[].screenshot_file` / `.ui_hierarchy_file` (`capture_error` when adb can't oblige). On `parallel`: once per still-failed module, after `--auto-retry`/cascade settle (no per-attempt spam). Forensic-only — **never** changes the exit code. Emulators are first-class. |
| `--capture-dir <path>` | per-run log dir | ✓ (`androidInstrumented`) | — | — | ✓ | Override where `--capture-on-fail` artifacts land (default `.kmp-test-runner/logs/android/<runId>/`, namespaced `<module>_screenshot.png` / `<module>_ui-hierarchy.xml`). Implies `--capture-on-fail`. Relative → resolved against `--project-root`. |
| `--skip-app` | off | — | — | — | ✓ | Skip `app/androidApp` modules. android-only. |
| `--verbose` | off | — | — | — | ✓ | Show last 30 lines of log on failure. android-only. |

## Concurrency isolation (parallel / changed / benchmark / android)

| Flag | Default | parallel | changed | benchmark | android | Notes |
|------|---------|:--------:|:-------:|:---------:|:-------:|-------|
| `--isolated` | off | ✓ | ✓ | ✓ | ✓ | Tier-3 — `--project-cache-dir <tmp>` for concurrent runs. |
| `--isolated-cache-dir <path>` | per-run tmpdir | ✓ | ✓ | ✓ | ✓ | Override cache-dir location. Implies `--isolated`. |
| `--isolated-no-lock` | off | ✓ | ✓ | ✓ | ✓ | Skip OS-level cache-dir lockfile. Implies `--isolated`. |

`--isolated` + `--test-type androidInstrumented` without `--device` → `isolated_runtime_race` (exit 2). Same for `--test-type ios` / `--test-type all`. See [`../troubleshooting/isolated-runtime-race.md`](../troubleshooting/isolated-runtime-race.md).

## Diagnostic / preview (parallel / android)

| Flag | Default | parallel | android | Notes |
|------|---------|:--------:|:-------:|-------|
| `--list` / `--list-only` | off | ✓ | ✓ | Emit post-filter `modules[]` + `skipped[]` envelope, exit 0 before gradle dispatch. Different from `--dry-run` (shows spawn command). |
| `--staged-only` | off | — | — | `changed` only: only consider git-staged files (`git diff --cached`). |
| `--show-modules-only` | off | — | — | `changed` only: list detected modules, exit 0 without running tests. |

## Subcommand-specific (benchmark / info / describe)

### `benchmark` only

| Flag | Default | Notes |
|------|---------|-------|
| `--config <name>` | `smoke` | `smoke` / `main` / `stress`. Controls iterations + per-task timeout. |
| `--platform <name>` | `all` | `all` / `jvm` / `android`. |
| `--strict-timeouts` | off | Restore pre-graded exit-code behaviour: any gradle timeout exits 3 even when other modules passed. Default (off) grades partial timeouts as exit 0 + `warnings[].code: partial_timeout` when ≥1 module passed. Use in CI cells that must hard-fail on any timeout. |

### `info` only

| Flag | Default | Notes |
|------|---------|-------|
| `--no-adb` | off | Skip the ADB probe (also via `KMP_TEST_SKIP_ADB=1` env). |

### `describe` only

| Flag | Default | Notes |
|------|---------|-------|
| `--skip-probe` | off | Skip gradle tasks probe (static analysis + cache only — fast but may miss KMP-aware task names). |
| `--no-cache` | off | Bypass `.kmp-test-runner/cache/model-*.json`; force fresh probe. |

## Env vars

| Variable | Applies when | Effect |
|----------|--------------|--------|
| `SKIP_DESKTOP_MODULES` | `--test-type common` / `desktop` | Comma-separated short module names skipped from desktop dispatch. |
| `SKIP_ANDROID_MODULES` | `--test-type androidUnit` (default) | Same shape, for Android unit dispatch. |
| `SKIP_IOS_MODULES` | `--test-type ios` | Same shape, for iOS dispatch. |
| `SKIP_MACOS_MODULES` | `--test-type macos` | Same shape, for macOS dispatch. |
| `PARENT_ONLY_MODULES` | always | Comma-separated module names that are aggregator-only — skipped at discovery time. |
| `NO_COLOR` | always (POSIX) | Any non-empty value disables gradle ANSI output (equivalent to `--color never`). |
| `KMP_COLOR_MODE` | always | `always` / `never` / `auto`. Set via `--color`; persists across re-exec chain. |
| `KMP_GRADLE_TIMEOUT_MS` | parallel / benchmark | Per-task gradle watchdog override in milliseconds. Precedence: `--ignore-gradle-timeout` > `--timeout` > this > config default. |
| `KMP_GRADLE_MAXBUFFER_MB` | always | Max stdout/stderr captured per gradle/adb subprocess, in megabytes (default `64`). Exceeding the cap surfaces as `errors[].code: "spawn_error"`. |
| `KMP_TEST_NO_SWEEP` | test subcommands | Set to `1` to disable the startup artifact-lifecycle sweep of `.kmp-test-runner/` (config key `cleanup:{auto,logsTtlDays}`). Explicit purge: `kmp-test clean [--all] [--dry-run]`. |
| `KMP_PROBE_TIMEOUT` | always | `lib/gradle-tasks-probe.sh` timeout in seconds (default 60). |
| `KMP_TEST_SKIP_ADB` | info, doctor | Set to `1` to skip ADB probe (equivalent to `--no-adb` on `info`). |
| `JAVA_HOME` | always | Injected via JDK catalogue auto-select when host default mismatches project's `jvmToolchain(N)`. |

## Example invocations

```bash
# Auto-detect everything, JSON output
kmp-test parallel --json

# Narrow to specific modules, single test method
kmp-test parallel --module-filter "core-*" --test-filter "com.foo.UserRepositoryTest#fetchUser" --json

# Coverage-only re-aggregation
kmp-test coverage --json

# Coverage gate in CI
kmp-test coverage --min-missed-lines 100 --json

# Benchmark smoke narrowed by module (jvm legs have no per-test filter —
# --test-filter would skip them; android legs DO honor --test-filter)
kmp-test benchmark --config smoke --module-filter "core-perf*" --json

# Changed-only with staged scope (pre-commit hook)
kmp-test changed --staged-only --json

# Preview without running
kmp-test parallel --module-filter "core-*" --list-only --json

# Concurrent agent runs with per-run cache isolation
kmp-test parallel --isolated --json

# Android instrumented on specific device
kmp-test android --device <DEVICE_SERIAL> --test-filter "*UserAuthTest*" --json

# Diagnose JDK / shell / ADB state
kmp-test doctor --json
```

## See also

- [`envelope-schema.md`](envelope-schema.md) — JSON envelope contract (every flag's effect on the envelope shape is documented per-field)
- [`exit-codes.md`](exit-codes.md) — exit-code semantics + WS-5 invariant
- [`../workflows/overview.md`](../workflows/overview.md) — per-workflow flag recommendations
- [`../troubleshooting/overview.md`](../troubleshooting/overview.md) — when flag combinations produce `errors[].code` entries

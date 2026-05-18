# Unit tests — `kmp-test parallel`

The canonical workflow for "run the unit tests in this project". Dispatches the per-module unit test task across every module that has one, in parallel, with coverage aggregated at the end.

## Goal

Run every module's unit tests (`*:test`, `*:jvmTest`, `*:desktopTest`, `*:testDebugUnitTest`, `*:iosSimulatorArm64Test`, `*:macosArm64Test`, etc.) under one gradle invocation and surface a single JSON envelope summarising pass/fail counts, per-module attribution, coverage, and any discriminated errors.

## When to use this workflow

The agent should dispatch `kmp-test parallel` when the user asks any of:

- "Run the tests" / "run unit tests" / "test this" / "run all tests"
- "Make sure the tests still pass" / "verify nothing broke"
- "Run the JVM / desktop / iOS / macOS tests" — narrow with `--test-type`
- "Run only `<module>`'s tests" — narrow with `--module-filter`

Do **not** dispatch `parallel` for:

- Android instrumented tests on a device or emulator — use the `android` workflow ([`instrumented/with-android-cli.md`](instrumented/with-android-cli.md) *or* [`instrumented/without-android-cli.md`](instrumented/without-android-cli.md), branch on `which android`).
- Coverage-only re-aggregation when tests already ran — use the `coverage` workflow ([`coverage.md`](coverage.md)).
- Benchmarks — use the `benchmark` workflow ([`benchmarks.md`](benchmarks.md)).
- "Tests for the files I just changed" — use the `changed` workflow ([`changed.md`](changed.md)).

## Quickstart

```bash
kmp-test parallel --json
```

That single command:

1. Probes the project for modules with test source sets.
2. Auto-skips modules with no `src/*Test*` directory (logged as `[SKIP]` on stderr; surfaced in `skipped[]`).
3. Auto-detects the unit-test type (`common` for KMP-desktop projects, `androidUnit` otherwise) — override with `--test-type`.
4. Auto-detects the coverage plugin per module (`kover` / `jacoco` / none) — override with `--coverage-tool`.
5. Auto-selects a compatible JDK from the catalogue if the project requires a different version from the host default.
6. Dispatches gradle in parallel (`--parallel` injected, unless `org.gradle.parallel=false` is in the resolved `gradle.properties` since v0.10 #2).
7. Emits a single-line JSON envelope on stdout — parse with `JSON.parse(stdout)`.

## Common flags

Defaults grounded in `lib/cli.js` SUBCOMMAND_HELP (the canonical source). Full per-subcommand matrix in [`../cli/flags-reference.md`](../cli/flags-reference.md).

| Flag | Default | Notes |
|------|---------|-------|
| `--json` | off | Mandatory for agent consumption. Without it the CLI prints human-readable text. |
| `--test-type <type>` | auto-detect | One of `all` / `common` / `androidUnit` / `androidInstrumented` / `desktop` / `ios` / `macos` / `jvm` / `js` / `wasm`. Auto picks `common` for KMP-desktop, `androidUnit` otherwise. |
| `--module-filter <glob>` | `*` | Glob, comma-separated. Narrow dispatch (e.g. `"core-*"`, `":feature:auth,:feature:profile"`). |
| `--test-filter <pattern>` | none | Filter to a single class or method. JVM legs use `gradle --tests` (globs OK); Android-instrumented resolves wildcards to FQN by source scan. Combined form `Class#method` works on both. |
| `--max-workers <N>` | `0` (auto) | Number of parallel gradle workers. `0` lets gradle decide. |
| `--coverage-tool <tool>` | `auto` | `auto` / `jacoco` / `kover` / `none`. `auto` picks per-module from the project model. |
| `--no-coverage` | off | Alias for `--coverage-tool none`. Drops coverage aggregation entirely. |
| `--min-missed-lines <N>` | `0` | Fail (`errors[].code: coverage_threshold_exceeded`, exit 1) if aggregated missed lines exceed `N`. |
| `--exclude-modules <list>` | none | Comma-separated globs to skip entirely (not even probed). |
| `--exclude-coverage <list>` | none | Comma-separated modules to skip from coverage aggregation only — tests still run. |
| `--include-untested` | off | Re-include modules auto-skipped because their filesystem path has no `src/*Test*` directory. |
| `--timeout <seconds>` | `600` | Per-task gradle watchdog. `0` disables. Overridden by `KMP_GRADLE_TIMEOUT_MS` env var. |
| `--variant <auto\|debug\|release\|all>` | `auto` | Android build-variant selector. `auto` respects `testBuildType="release"` projects; `all` dispatches both. |
| `--gradle-args "<args>"` | none | Escape hatch — tokens appended LAST so they override CLI defaults via gradle's last-wins (e.g. `--gradle-args "--no-parallel"`). |
| `--isolated` | off | Wrap gradle with `--project-cache-dir <tmp>` so concurrent `kmp-test` runs don't share configuration cache. |
| `--isolated-cache-dir <path>` | per-run tmpdir | Override the cache-dir location. Implies `--isolated`. |
| `--isolated-no-lock` | off | Skip the OS-level cache-dir lockfile. Implies `--isolated`. |
| `--java-home <path>` | none | Explicit JDK install — wins over catalogue auto-select and `gradle.properties org.gradle.java.home`. |
| `--no-jdk-autoselect` | off | Disable JDK catalogue auto-select; fall through to the gate on mismatch. |
| `--ignore-jdk-mismatch` | off | Downgrade the JDK-mismatch gate from BLOCK (exit 3) to WARN. |
| `--dry-run` | off | Emit a plan envelope (`dry_run: true`, `plan{}` block), exit 0, no gradle spawn. |
| `--list` / `--list-only` | off | Emit the post-filter `modules[]` + `skipped[]` envelope and exit 0 before any dispatch. Different from `--dry-run`: shows the module set, not the spawn command. |
| `--color <mode>` | `auto` | `always` / `never` / `auto`. Controls `--console=plain` injection. Respects `NO_COLOR` on POSIX. |
| `--force` | off | Bypass the project lockfile when another `kmp-test` process holds it (`errors[].code: lock_held`). |

`--device`, `--device-task`, `--auto-retry`, `--clear-data`, `--flavor` are only relevant when `--test-type androidInstrumented` — see the `android` workflow ([`instrumented/with-android-cli.md`](instrumented/with-android-cli.md) *or* [`instrumented/without-android-cli.md`](instrumented/without-android-cli.md)).

## Behaviors únicos

### Cascade retry

When a leg's gradle invocation aborts during configuration / evaluation (compile error, missing dependency), every task in that leg's downstream graph is marked `no_evidence` because gradle never got to run them. The orchestrator detects this shape (`no_evidence > 0` AND `failed === 0`) and surfaces it as `parallel.legs[i].cascade_detected: true`. The leg's `exit_code` is non-zero; the envelope's top-level `errors[]` carries the originating gradle failure with discriminated `code` when recognisable.

`--auto-retry` re-dispatches **runtime-failed instrumented tasks** (not cascades). Surfaces `parallel.legs[i].retries[]`. Unit tests don't typically need this.

### Auto-detect chain

Five things are auto-detected per-run unless overridden:

1. **Test type** — `kmp-desktop` projects default to `common`, others to `androidUnit`. Explicit `--test-type` overrides.
2. **Coverage plugin** — per-module probe via `lib/project-model.js`. Convention-plugin coverage is inherited per-module since v0.6.1; modules that don't apply a coverage-adding convention plugin are listed under `skipped[]` with reason `no coverage plugin`.
3. **JDK toolchain** — reads project's `jvmToolchain(N)` / `JvmTarget.JVM_N` / `JavaVersion.VERSION_N` (MAX), compares to runtime JDK, then walks `~/.kmp-test/config.json` `java_home` → `--java-home` → `gradle.properties org.gradle.java.home` → JDK catalogue (since v0.6.1: Adoptium / Zulu / Microsoft / Semeru / BellSoft on Windows; `/Library/Java/JavaVirtualMachines/` on macOS; `/usr/lib/jvm` + `/opt/{java,jdk}` on Linux) → host default.
4. **Console mode** — when stdout is not a TTY or `NO_COLOR` is set, the orchestrator injects `--console=plain` into the gradle subprocess so test output stays parseable. Override with `--color always` / `--color never`.
5. **Parallelism respect** — since v0.10 #2, if the resolved `gradle.properties` has `org.gradle.parallel=false`, the CLI drops the unconditional `--parallel` flag from the gradle dispatch and surfaces `gradle_config_applied: { parallel_dropped: true }` on the `parallel` envelope block. Re-enable via `--gradle-args "--parallel"`.

### Discovery-time skips

The wrapper auto-skips modules whose filesystem path has no `src/test/`, `src/commonTest/`, `src/jvmTest/`, `src/desktopTest/`, `src/androidUnitTest/`, `src/androidTest/`, `src/iosTest/`, or `src/nativeTest/` directory. Each skip is logged on stderr as `[SKIP] <module> (no test source set)` and surfaced in `skipped[]`.

The `SKIP_*_MODULES` env vars layer on top: `SKIP_DESKTOP_MODULES="legacy-app"`, `SKIP_ANDROID_MODULES`, `SKIP_IOS_MODULES`, `SKIP_MACOS_MODULES`. Comma-separated short module names. `PARENT_ONLY_MODULES` skips aggregator-only modules entirely from discovery.

## Edge cases

- **`--dry-run` vs `--list-only`**: dry-run shows the resolved spawn command (`plan.spawn_args[]`); list-only shows the resolved module set (`modules[]`) the spawn would iterate. Both exit 0 without gradle dispatch. Both can combine with `--isolated` to inspect the isolation shape.
- **`--test-type all`** dispatches every applicable leg (`common` + `androidUnit` + `desktop` + `ios` + `macos`) sequentially-per-leg / parallel-within-leg. Combine with `--isolated` only when ADB / iOS simulator races aren't a concern — otherwise emits `isolated_runtime_race` (`exit 2`) at parse time.
- **`--flavor` on `parallel` without `--test-type androidInstrumented`**: ignored cleanly when no module declares matching `productFlavors {}`; otherwise emits `flavor_unused` (`exit 2`) at parse time.
- **Filter narrows to zero modules**: `--module-filter "nonexistent-*"` produces `errors[].code: no_test_modules` with `caused_by_filter: true` and `exit 2`. Compare with the same code at project-wide scope (no filter, project genuinely has no test modules) which sets `caused_by_filter: false` and `exit 3`.
- **JDK toolchain mismatch with `--ignore-jdk-mismatch`**: the gate downgrades to a `WARN` stderr line; tests then run under the host default and likely fail with `unsupported_class_version` on the actual task. Prefer fixing the JDK (catalogue auto-select, `--java-home`, `~/.kmp-test/config.json java_home`) over bypassing.
- **Concurrent `kmp-test` on the same project root**: the second process exits 3 with `errors[].code: lock_held`. Bypass with `--force` only when you know the prior run is dead (stale lockfile from a crashed process). `--isolated` is the safer answer for parallel agents — gives each its own cache dir.
- **Compile-time failure in a module**: surfaces as `errors[].code: module_failed` with `setup_failed: true` (no JUnit XML evidence). Distinguishes from runtime test failure (`setup_failed: false`, has `modules[].test_failures[]`).
- **Coverage gate**: `--min-missed-lines 100` emits `errors[].code: coverage_threshold_exceeded` (exit 1) when `coverage.missed_lines > 100`. Useful in CI gates.

## Envelope shape excerpt

The `parallel` subcommand emits the standard top-level envelope (see [`../cli/envelope-schema.md`](../cli/envelope-schema.md)) plus a subcommand-specific `parallel:{}` block:

```json
{
  "tool": "kmp-test",
  "schema_version": 2,
  "subcommand": "parallel",
  "exit_code": 0,
  "tests": { "total": 42, "passed": 42, "failed": 0, "skipped": 0, "individual_total": 58 },
  "modules": [
    {
      "name": ":core:network",
      "type": "kmp",
      "coverage_plugin": "kover",
      "test_failures": []
    }
  ],
  "coverage": {
    "tool": "kover",
    "missed_lines": 16,
    "modules_with_kover_plugin": [":core:network"],
    "modules_with_jacoco_plugin": []
  },
  "parallel": {
    "test_type": "androidUnit",
    "max_workers": 0,
    "timeout_s": 600,
    "legs": [
      {
        "test_type": "androidUnit",
        "exit_code": 0,
        "execution": { "fresh": 5, "up_to_date": 0, "from_cache": 2, "no_source": 0, "skipped_by_gradle": 0, "failed": 0, "no_evidence": 0 },
        "cascade_detected": false,
        "retry_fired": false
      }
    ]
  },
  "errors": [],
  "warnings": []
}
```

`parallel.legs[i].execution` counts per-task dispositions. `cascade_detected` flags abort-before-task-runs; `retry_fired` flags the `--auto-retry` path. Both default to `false`.

## Troubleshooting

Branch on `errors[].code`:

- `no_test_modules` → [`../troubleshooting/no-test-modules.md`](../troubleshooting/no-test-modules.md)
- `module_failed` (incl. `setup_failed:true`) → [`../troubleshooting/module-failed.md`](../troubleshooting/module-failed.md)
- `task_not_found` → [`../troubleshooting/task-not-found.md`](../troubleshooting/task-not-found.md)
- `unsupported_class_version` → [`../troubleshooting/unsupported-class-version.md`](../troubleshooting/unsupported-class-version.md)
- `coverage_threshold_exceeded` → [`../troubleshooting/coverage-threshold-exceeded.md`](../troubleshooting/coverage-threshold-exceeded.md)
- `flavor_unused` → [`../troubleshooting/flavor-unused.md`](../troubleshooting/flavor-unused.md)
- `isolated_runtime_race` → [`../troubleshooting/isolated-runtime-race.md`](../troubleshooting/isolated-runtime-race.md)
- `no_summary` (soft) → [`../troubleshooting/no-summary.md`](../troubleshooting/no-summary.md)

## See also

- [`overview.md`](overview.md) — workflows hub
- [`../cli/envelope-schema.md`](../cli/envelope-schema.md) — full JSON envelope contract
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — exit-code semantics + WS-5 invariant
- [`../cli/flags-reference.md`](../cli/flags-reference.md) — full per-subcommand flag matrix
- [`coverage.md`](coverage.md) — coverage-only re-aggregation workflow
- [`changed.md`](changed.md) — narrow-by-git-diff variant of `parallel`

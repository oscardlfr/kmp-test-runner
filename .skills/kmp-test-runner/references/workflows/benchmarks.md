# Benchmarks — `kmp-test benchmark`

Run benchmark suites (kotlinx-benchmark on JVM, androidx-benchmark on Android, JMH variants when the project uses them) with real `Dispatchers.Default` contention. Adaptive timeouts per profile. `--test-filter` narrowing is **strongly recommended** for any agent-driven run.

## Goal

Dispatch every module that has a benchmark plugin applied, run the configured profile (smoke / main / stress), capture kotlinx-benchmark JSON output and androidx-benchmark Trace files, and emit a single JSON envelope summarising what ran. Benchmarks return their own per-iteration scores via build artefacts — the envelope confirms which suites ran, not the raw numbers.

## When to use this workflow

The agent should dispatch `kmp-test benchmark` when the user asks any of:

- "Run benchmarks" / "run the benchmark suite"
- "Run a specific benchmark" — combine with `--test-filter <FQN>#<method>`
- "Smoke benchmark this PR" — `--config smoke` (default; ~30 s/module)
- "Full benchmark run" — `--config main` (~5 min/module) or `--config stress` (~longer)
- "Benchmark on the JVM only" / "on the device only" — narrow with `--platform jvm` / `--platform android`

Do **not** dispatch `benchmark` for:

- Unit tests — `parallel` ([`unit-tests.md`](unit-tests.md)).
- Coverage of benchmark code — benchmarks are excluded from coverage by convention.
- "Run all the things" — benchmarks are slow; do not bundle into a generic "run tests" reply.

## Quickstart

```bash
kmp-test benchmark --config smoke --test-filter "com.example.UserBenchmark#fastPath" --json
```

The `--test-filter` is **almost always required** for agent invocations — full suites take 30 min to 4 h depending on size. Smoke profile with a single-method filter usually completes in 1-3 min.

That command:

1. Probes for modules applying `org.jetbrains.kotlinx.benchmark`, `androidx.benchmark.microbenchmark`, `androidx.benchmark.macrobenchmark`, or `org.jetbrains.kotlin.plugin.allopen` (the kotlinx-benchmark companion).
2. Resolves the test-filter pattern per-platform:
   - JVM legs: `gradle --tests "<pattern>"` natively.
   - Android-instrumented legs: source-scan resolves wildcards to FQN, then emits the canonical AGP form `-Pandroid.testInstrumentationRunnerArguments.class=<FQN>#<method>`.
3. Auto-selects a compatible JDK — kotlinx-benchmark's JMH bytecode generator **requires JDK 21+**, even for projects whose runtime target is JDK 17. See troubleshooting `unsupported_class_version`.
4. Dispatches with the profile's per-task timeout (`smoke=300s`, `main=1800s`, `stress=3600s` — see `--timeout`).
5. Emits a JSON envelope summarising the dispatch.

## Common flags

Defaults grounded in `lib/cli.js` SUBCOMMAND_HELP. Full matrix in [`../cli/flags-reference.md`](../cli/flags-reference.md).

| Flag | Default | Notes |
|------|---------|-------|
| `--json` | off | Mandatory for agent consumption. |
| `--config <name>` | `smoke` | `smoke` / `main` / `stress`. Controls per-iteration count + per-task gradle watchdog timeout. |
| `--platform <name>` | `all` | `all` / `jvm` / `android`. Narrow to one platform when the user only cares about that side. |
| `--module-filter <pattern>` | `*` | Glob, comma-separated. **Strongly recommended** to narrow to specific benchmark modules. |
| `--test-filter <pattern>` | none | **Critical for agent invocations.** Filter to a single benchmark class or method. Wildcard pattern `*UserBenchmark*` resolves to FQN by source scan (Android); JVM uses gradle's native `--tests`. `Class#method` form is honored verbatim across both platforms. |
| `--include-shared` | off | Include sibling shared-libs benchmark modules (composite-build context). |
| `--variant <auto\|debug\|release\|all>` | `auto` | Android variant selector for instrumented benchmarks. JVM benchmarks ignore this flag (no Debug/Release split for `desktopBenchmark`). |
| `--timeout <seconds>` | per-config default | Per-task gradle watchdog. Overrides `KMP_GRADLE_TIMEOUT_MS` and the per-config default. `0` disables. Precedence: `--ignore-gradle-timeout` > `--timeout` > `KMP_GRADLE_TIMEOUT_MS` > config default. |
| `--ignore-gradle-timeout` | off | Disable the gradle watchdog entirely. Equivalent to `--timeout 0`. Use only when you've measured the run already and know it exceeds `stress`'s 1 h cap. |
| `--gradle-args "<args>"` | none | Escape hatch — tokens appended LAST (gradle last-wins). |
| `--isolated` | off | Wrap gradle with `--project-cache-dir <tmp>` for concurrent runs. |
| `--isolated-cache-dir <path>` | per-run tmpdir | Override cache-dir location. Implies `--isolated`. |
| `--isolated-no-lock` | off | Skip the OS-level cache-dir lockfile. Implies `--isolated`. |
| `--java-home <path>` | none | Explicit JDK — wins over catalogue auto-select. Critical for kotlinx-benchmark which needs JDK 21+. |
| `--no-jdk-autoselect` | off | Disable JDK catalogue auto-select. |
| `--ignore-jdk-mismatch` | off | Downgrade JDK gate to WARN. Risky for benchmark — likely to surface `unsupported_class_version` mid-run. |
| `--dry-run` | off | Plan envelope, exit 0, no gradle spawn. |
| `--color <mode>` | `auto` | `always` / `never` / `auto`. |

`--device`, `--device-task`, `--auto-retry`, `--clear-data`, `--flavor` are instrumented-only flags accepted by `parallel --test-type androidInstrumented` and the `android` subcommand — **not by `benchmark` directly**. Android benchmarks dispatch via gradle task probe, not the `--device`/`--device-task` resolution chain.

## Behaviors únicos

### Per-config timeout matrix

Each `--config` value sets a per-task gradle watchdog default:

| Config | Per-task timeout | Iteration shape (approx.) | Use when |
|--------|------------------|--------------------------|----------|
| `smoke` | 300 s (5 min) | 1 warmup + 3 measurement iters per benchmark | Agent loops, PR validation, smoke gate |
| `main` | 1800 s (30 min) | 5 warmup + 10 iters | Periodic CI, performance regression detection |
| `stress` | 3600 s (1 h) | 10 warmup + 20 iters, multiple forks | Pre-release validation, contention analysis |

On top of the per-task timeout, an **outer timeout** applies to the whole `kmp-test benchmark` invocation: `smoke=35 min`, `main=1 h`, `stress=1.5 h`. This protects against runaway accumulation when multiple modules each hit the per-task ceiling.

Precedence (highest wins): `--ignore-gradle-timeout` → `--timeout <s>` (CLI flag) → `KMP_GRADLE_TIMEOUT_MS` (env var) → config default.

### Module detection

Per `lib/orchestrators/benchmark-orchestrator.js`, a module qualifies as "has benchmarks" when its `build.gradle.kts` (or `build.gradle`) applies any of:

- `org.jetbrains.kotlinx.benchmark` (kotlinx-benchmark, JVM + Android).
- `androidx.benchmark.microbenchmark` (instrumented Microbenchmark library).
- `androidx.benchmark.macrobenchmark` (instrumented Macrobenchmark library).
- `org.jetbrains.kotlin.plugin.allopen` paired with kotlinx-benchmark.
- `kotlin("plugin.allopen")` paired with kotlinx-benchmark.

Modules without any of these are silently skipped (no `[SKIP]` line, no `skipped[]` entry — benchmark modules are explicitly opted-in). `errors[].code: no_test_modules` fires only when the filter narrows to zero qualifying modules.

### `--test-filter` resolution

The orchestrator handles three input shapes:

1. **Literal FQN with method**: `com.example.UserBench#fastPath` → passes verbatim to gradle (JVM) or as `-Pandroid.testInstrumentationRunnerArguments.class=com.example.UserBench#fastPath` (Android).
2. **Literal FQN without method**: `com.example.UserBench` → runs every `@Benchmark` method on the class.
3. **Wildcard pattern**: `*UserBench*` → source-walk every `.kt` file (skipping `build/`, `.gradle/`, `node_modules/`, `.git/`) for a `class UserBench` declaration, substitute the FQN, then dispatch.

If no match is found, the original pattern forwards — gradle / AndroidJUnitRunner surface a clearer error than the CLI's resolution would.

The `.method` heuristic: when the last `.`-separated segment is lowercase (e.g. `com.example.UserBench.fastPath`), the CLI treats it as `Class.method` and rewrites to canonical `Class#method`. Use explicit `#` separator if your class names start with lowercase.

### Adaptive outer timeout

The wrapper applies an outer `setTimeout` on the spawn (`resolveBenchmarkOuterTimeoutMs` in `lib/runners/script-dispatcher.js`):

- `smoke` → 35 min
- `main` → 60 min
- `stress` → 90 min

This is independent of the per-task gradle watchdog. The outer kicks in when the total run exceeds the cap — usually a sign that someone forgot `--test-filter`. The envelope's `errors[]` will then carry a watchdog-style entry.

## Edge cases

- **Full suite without `--test-filter` on a 70-module project**: takes up to 4 h. Agent runs MUST narrow with `--test-filter` (memory rule: `feedback_dipatternsdemo_benchmarks_must_be_narrowed.md`). If the user truly wants a full run, escalate the decision before dispatching.
- **kotlinx-benchmark + JDK 17**: surfaces `errors[].code: unsupported_class_version` because the JMH bytecode generator (`JmhBytecodeGeneratorWorker`) is compiled against JDK 21. Recovery: ensure a JDK 21+ install is in `~/.kmp-test/config.json java_home` or pass `--java-home <jdk21-path>`.
- **`--platform android` without a connected device**: emits `errors[].code: instrumented_setup_failed` (exit 3) at dispatch. Recovery: check `adb devices`, or use `--platform jvm` to skip the Android leg.
- **`--platform jvm` on an Android-only project**: emits `errors[].code: no_test_modules` because no JVM benchmark module qualifies. Recovery: use `--platform android` or `--platform all`.
- **`--variant release` on a project that has no instrumented benchmark with a Release task**: AGP falls back to umbrella `connectedAndroidTest`. JVM modules ignore `--variant` regardless.
- **`--isolated --platform android`**: emits `errors[].code: isolated_runtime_race` (exit 2) at parse time — ADB serial ownership is process-global, not project-cache-dir-scoped. Recovery: pass `--device <serial>` to pin a specific device for the isolated run.
- **kotlinx-benchmark JSON output location**: `build/reports/benchmarks/<config>/<platform>/main/*.json` per module. Agents reading scores directly should drill there; the envelope confirms the dispatch only.
- **Macrobenchmark Trace files**: written to `app/build/outputs/connected_android_test_additional_output/<variant>/`. Pull via `adb pull` after the run — not part of the envelope.

## Envelope shape excerpt

```json
{
  "tool": "kmp-test",
  "schema_version": 2,
  "subcommand": "benchmark",
  "exit_code": 0,
  "tests": { "total": 1, "passed": 1, "failed": 0, "skipped": 0 },
  "modules": [
    {
      "name": ":benchmark:user",
      "type": "kmp",
      "coverage_plugin": null,
      "android_dsl": true,
      "android_dsl_variant": "library",
      "test_failures": []
    }
  ],
  "coverage": { "tool": "none", "missed_lines": null, "modules_with_kover_plugin": [], "modules_with_jacoco_plugin": [] },
  "benchmark": {
    "config": "smoke",
    "total": 1,
    "passed": 1,
    "failed": 0,
    "timed_out": 0,
    "platforms": ["android"],
    "timeout_ms": 300000
  },
  "errors": [],
  "warnings": []
}
```

`benchmark.config` echoes the user's `--config` value. `total` / `passed` / `failed` / `timed_out` are benchmark-suite-level counts (not test-method-level). `platforms` is a sorted array of which platforms actually dispatched (e.g. `["android", "jvm"]` when `--platform all` matches both). `timeout_ms` is the resolved per-task watchdog timeout (after the precedence chain). Per-iteration scores are NOT in the envelope — read them from `build/reports/benchmarks/**/*.json` directly. The resolved `--test-filter` is not surfaced in `benchmark:{}` — it appears in `plan.test_filter` under `--dry-run`.

## Troubleshooting

Branch on `errors[].code`:

- `no_test_modules` → [`../troubleshooting/no-test-modules.md`](../troubleshooting/no-test-modules.md)
- `task_not_found` → [`../troubleshooting/task-not-found.md`](../troubleshooting/task-not-found.md)
- `unsupported_class_version` → [`../troubleshooting/unsupported-class-version.md`](../troubleshooting/unsupported-class-version.md) (very common with kotlinx-benchmark JMH on JDK 17 projects)
- `module_failed` → [`../troubleshooting/module-failed.md`](../troubleshooting/module-failed.md)
- `isolated_runtime_race` → [`../troubleshooting/isolated-runtime-race.md`](../troubleshooting/isolated-runtime-race.md)
- `instrumented_setup_failed` (when `--platform android` or `all`) — same shape as the unit-tests workflow. Branch deep-dives: [`../troubleshooting/instrumented-setup-failed/with-android-cli.md`](../troubleshooting/instrumented-setup-failed/with-android-cli.md) *or* [`../troubleshooting/instrumented-setup-failed/without-android-cli.md`](../troubleshooting/instrumented-setup-failed/without-android-cli.md).

## See also

- [`overview.md`](overview.md) — workflows hub
- [`../cli/envelope-schema.md`](../cli/envelope-schema.md) — full JSON envelope contract
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — exit-code semantics
- [`../cli/flags-reference.md`](../cli/flags-reference.md) — full per-subcommand flag matrix
- [`unit-tests.md`](unit-tests.md) — for the unit-test workflow that aggregates per-module coverage

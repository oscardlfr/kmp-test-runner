# Usage guide

This guide covers choosing a test surface, running the main workflows, handling
coverage and Android devices, configuring projects, and using the runner in CI.
For every flag and subcommand, see [CLI reference](cli-reference.md).

## First run

From a Gradle project root:

```sh
kmp-test doctor
kmp-test describe --json
kmp-test parallel --json
```

`--project-root` defaults to the current directory. Supply it explicitly when a
script runs elsewhere:

```sh
kmp-test parallel --project-root /work/my-project --json
```

Use `--dry-run` to inspect the resolved command without spawning Gradle, or
`--list-only` on `parallel` and `android` to inspect the effective module set.

## Choose the test surface

The default `parallel` invocation is intentionally a unit-test path. It selects
the best host-side task per module and does not silently opt into simulators or
connected devices.

| Intent | Command | Typical Gradle task |
|---|---|---|
| Host/JVM or desktop tests | `kmp-test parallel --test-type common` | `desktopTest`, `jvmTest`, or `test` |
| Explicit JVM-side tests | `kmp-test parallel --test-type jvm` | same JVM-side candidate chain |
| Android host unit tests | `kmp-test parallel --test-type androidUnit` | `testDebugUnitTest`, variant task, or `testAndroidHostTest` |
| Android instrumented/Compose UI | `kmp-test android` | a resolved `connected*AndroidTest` task or `androidConnectedCheck` |
| Instrumented tests plus parallel coverage flow | `kmp-test parallel --test-type androidInstrumented` | same device-task resolution |
| iOS tests | `kmp-test parallel --test-type ios` | resolved `iosSimulatorArm64Test`, `iosX64Test`, `iosArm64Test`, or `iosTest` |
| macOS tests | `kmp-test parallel --test-type macos` | resolved `macosArm64Test`, `macosX64Test`, or `macosTest` |
| JavaScript tests | `kmp-test parallel --test-type js` | resolved `jsTest` |
| Wasm tests | `kmp-test parallel --test-type wasm` | resolved `wasmJsTest` |

The aliases `android` and `desktop` are accepted as test-type values alongside
`androidUnit` and `common`; consult [CLI reference](cli-reference.md#test-type-values)
when generating commands programmatically.

`--test-type all` expands to `common`, `desktop`, `androidUnit`, and, when ADB is
enabled, `androidInstrumented`. On macOS it additionally includes `ios` and
`macos`. It does **not** include the explicit `js` or `wasm` legs. Run those
separately when they are part of the required matrix.

### Instrumented-only modules

A bare `kmp-test parallel` skips modules whose only test sources are
`androidInstrumentedTest` or `androidTest`. The JSON envelope reports
`warnings[].code: "instrumented_only_skipped"`; run `kmp-test android` or use
`--test-type androidInstrumented` to execute them.

iOS and macOS dispatch are host-gated: requesting either on a non-macOS host
returns `platform_unsupported` rather than pretending the target ran.

## Common workflows

### Run all host-side tests

```sh
kmp-test parallel
kmp-test parallel --json
kmp-test parallel --module-filter "core-*,feature-auth"
kmp-test parallel --test-filter "com.example.WidgetTest.shouldRender"
```

Module filters are comma-separated globs and match bare or colon-prefixed module
names. Test filters are forwarded as Gradle `--tests` for JVM, Kotlin/Native and
Kotlin/JS tasks. Instrumented Android filters are translated to the Android test
runner's `class=<FQN>` or `class=<FQN>#<method>` property.

By default modules without a recognized `src/*Test*` source directory are
skipped before dispatch. Use `--include-untested` only when a generated or
non-standard test task exists despite the absence of those directories.

### Test changed modules

```sh
kmp-test changed --json
kmp-test changed --staged-only --json
kmp-test changed --show-modules-only
```

`changed` maps files reported by Git to modules, then delegates the selected set
to the parallel workflow. A clean working tree is a successful no-op with soft
code `no_changed_modules`. Git inspection failures are hard environment errors
with code `git_error`.

Use `--include-shared` when changes in a configured sibling build should be
included. The shared project is defined by `sharedProject` in configuration or
the legacy `SHARED_PROJECT_NAME` environment variable.

### Run Android instrumented tests

```sh
adb devices
kmp-test android --device emulator-5554 --json
kmp-test android --module-filter "app,feature-*" --variant release
kmp-test android --test-filter "com.example.LoginTest#submitsForm"
```

If exactly one usable device is connected, `--device` can be omitted. Multiple
usable devices require an explicit serial. Offline, unauthorized, absent, and
ambiguous devices have distinct environment error codes in the JSON envelope.

`--variant auto` uses the project model and `testBuildType`; explicit `debug`,
`release`, or `all` values override that choice. `--flavor <name>` composes a
flavored task. With no explicit flavor, a flavored project uses an umbrella task
and reports `flavor_defaulted_umbrella` when applicable.

For non-standard plugins or custom task names, `--device-task <name>` preempts
normal task resolution.

### Capture device state after failure

```sh
kmp-test android --capture-on-fail --json
kmp-test parallel --test-type androidInstrumented \
  --capture-dir .artifacts/android-failures --json
```

After each failed instrumented module, `--capture-on-fail` asks ADB for a PNG
screenshot and UI hierarchy XML. This is best-effort forensic evidence captured
at task end, not necessarily the exact assertion frame, and it never changes the
test exit code. Paths are attached to `module_failed` entries as
`screenshot_file` and `ui_hierarchy_file`; `capture_error` explains a failed
capture.

`--auto-retry` retries runtime failures once. Add `--clear-data` to perform
`adb shell pm clear <package>` before that retry; `--clear-data` has no retry to
prepare unless `--auto-retry` is also present.

### Run benchmarks

```sh
kmp-test benchmark --config smoke --json
kmp-test benchmark --config main --platform jvm
kmp-test benchmark --platform android
```

Profiles set default per-task watchdogs: `smoke` 300 seconds, `main` 1,800
seconds, and `stress` 3,600 seconds. `--timeout` overrides that value and zero
disables it. `--ignore-gradle-timeout` also disables the watchdog.

Android benchmark filtering is supported through instrumentation arguments.
When `--test-filter` is combined with a JVM benchmark leg, that leg is skipped
with `test_filter_unsupported` because kotlinx-benchmark tasks do not accept
Gradle's normal `--tests` filter. The runner does not silently execute the full
JVM benchmark suite instead.

By default, a timeout can be a warning (`partial_timeout`) when another module
passed. Use `--strict-timeouts` in CI when any timeout must produce exit 3.

## Coverage

`parallel` runs eligible host-side tests, dispatches their detected report tasks,
and aggregates the resulting XML. Android instrumented, iOS, macOS, JS, and
Wasm legs do not generate coverage in this workflow; a run containing only one
of those legs can at most aggregate XML left by an earlier eligible run.

`coverage` reads and aggregates reports already on disk. It does not run tests
or coverage report tasks, but it may invoke `gradlew tasks --all --quiet` when
the project-model cache is absent so it can discover modules and coverage
metadata. That configuration probe can resolve plugins and update Gradle's
normal local caches.

```sh
kmp-test parallel --coverage-tool auto --json
kmp-test coverage --coverage-modules core,app --json
kmp-test coverage --exclude-coverage generated,fixtures
```

| Value | Behavior |
|---|---|
| `auto` | Detect Kover and JaCoCo per module from the probed Gradle task graph |
| `kover` | Select Kover report tasks |
| `jacoco` | Select JaCoCo report tasks |
| `none` | Disable coverage aggregation |

`--coverage-modules` and `--exclude-coverage` accept comma-separated, exact,
colonless module names. They are not glob filters. `--exclude-modules`, by
contrast, is a glob filter and also excludes test execution.

Standard JaCoCo report tasks often have XML disabled. The parallel workflow
injects a temporary init script that enables `xml.required` for JaCoCo report
tasks. `--no-coverage-xml-autofix` disables that behavior; missing XML then
surfaces explicitly rather than being counted as zero coverage.

### Coverage budgets

A positive `--min-missed-lines N` enables the budget and fails with
`coverage_threshold_exceeded` when the complete aggregate exceeds `N`. The
default zero leaves the budget disabled. An enabled budget is fail-closed:

- no contributing data or a missing required target produces
  `coverage_data_unavailable` (exit 3);
- combining a positive budget with `--coverage-tool none` or `--no-coverage`
  produces `coverage_budget_without_coverage` (exit 2).

The JSON `coverage.missed_lines` and module buckets always describe the complete
aggregate. The threshold does not remove data from the envelope.

When `--output-file` is omitted, reports are written under
`.kmp-test-runner/reports/coverage/<runId>.md` with `latest.md` updated as the
stable alias. An explicit path is used as requested and does not create that
alias.

## JDK selection

The runner derives the highest required JDK from project signals such as
`jvmToolchain`, `JvmTarget`, Java compatibility, and AGP. Effective selection is:

1. a valid project `org.gradle.java.home`; Gradle owns this setting and it takes
   precedence over the process environment, so `--java-home` does not override it;
2. `--java-home <path>` or a user-global `java_home` injected as that flag;
3. a matching JDK from the built-in host catalogue;
4. the host `java` when it already satisfies the project;
5. otherwise, fail with `jdk_mismatch` and exit 3.

Catalogue roots include common vendor installations on Windows,
`/Library/Java/JavaVirtualMachines` on macOS, and `/usr/lib/jvm` plus selected
`/opt` roots on Linux. `--no-jdk-autoselect` disables catalogue selection.
`--ignore-jdk-mismatch` bypasses the safety gate and should be reserved for
diagnosis because Gradle can still fail later.

`--dry-run` does not require a working JDK because it does not spawn Gradle.

## Project configuration

Create `.kmp-test-runner.json` at the Gradle project root for portable defaults:

```json
{
  "sharedProject": {
    "name": "shared-build",
    "path": "../shared-build"
  },
  "defaults": {
    "testType": "common",
    "coverageTool": "auto",
    "excludeModules": "*:api,build-logic"
  },
  "skip": {
    "android": ["legacy-app"],
    "desktop": [],
    "ios": ["ios-fixtures"],
    "macos": []
  },
  "cleanup": {
    "auto": true,
    "logsTtlDays": 7
  }
}
```

Recognized defaults are `testType`, `coverageTool`, and `excludeModules`.
Recognized skip lists are `android`, `desktop`, `ios`, and `macos`. Skip entries
are exact module names. Type-invalid fields are dropped and reported as
`config_invalid_field` warnings.

`cleanup` controls the startup sweep of old run logs, isolated caches,
temporary init scripts, and temporary cache files. Set `KMP_TEST_NO_SWEEP=1` to
disable the automatic sweep. `kmp-test clean --dry-run` previews an explicit
purge; `clean --all` additionally removes model/task caches and reports.

## User-global configuration

Machine-specific values belong in `~/.kmp-test/config.json` on POSIX systems or
`%USERPROFILE%\.kmp-test\config.json` on Windows:

```json
{
  "projects": {
    "https://github.com/example/my-project.git": {
      "defaults": {
        "testType": "desktop",
        "coverageTool": "kover"
      },
      "skip": {
        "android": ["device-fixtures"]
      },
      "java_home": "C:/Java/jdk-21"
    }
  }
}
```

Project keys are resolved from the Git `origin` URL, then `rootProject.name`,
then the project-directory basename. The project-local configuration overrides
the matching user preset field by field. `java_home` is intentionally accepted
only in user-global configuration so machine paths are not committed.

Operational precedence is CLI flags, relevant environment overrides,
project-local config, user-global preset, then built-in defaults.

### Supported environment overrides

| Variable | Purpose |
|---|---|
| `SHARED_PROJECT_NAME` | legacy shared-project name; takes precedence over configured `sharedProject.name` |
| `SKIP_DESKTOP_MODULES` | exact comma-separated module names for common/desktop legs |
| `SKIP_ANDROID_MODULES` | exact comma-separated module names for Android legs |
| `SKIP_IOS_MODULES` | exact comma-separated module names for the iOS leg |
| `SKIP_MACOS_MODULES` | exact comma-separated module names for the macOS leg |
| `KMP_TEST_SKIP_ADB=1` | skip ADB probing; on `android`, implies list-only |
| `KMP_GRADLE_TIMEOUT_MS` | Gradle watchdog override in milliseconds |
| `KMP_GRADLE_MAXBUFFER_MB` | child-process output cap; default 64 MB |
| `KMP_JUNIT_XML_MAX_MB` | per-JUnit-XML parse cap; default 32 MB |
| `KMP_COVERAGE_XML_MAX_MB` | per-coverage-XML parse cap; default 128 MB |
| `KMP_TEST_KEEP_ISOLATED=1` | retain generated isolated cache directories |
| `KMP_TEST_NO_SWEEP=1` | disable automatic stale-artifact cleanup |
| `NO_COLOR` | disable ANSI output in non-Windows POSIX flows |

## Concurrency

Spawning commands coordinate through `.kmp-test-runner.lock`. A second run
against the same project normally exits 3 with `lock_held`; dead-process locks
are reclaimed. `--force` bypasses this advisory protection but does not isolate
Gradle state.

For deliberate same-project fan-out, use both:

```sh
kmp-test parallel --isolated --isolated-no-lock \
  --module-filter "core-*" --json
```

`--isolated` gives the run a separate Gradle project-cache directory.
`--isolated-no-lock` allows overlap. This does not isolate a shared Android
device, the global Gradle dependency cache, or a changing Git working tree. See
[Concurrency model](concurrency.md) for the complete collision model.

## Continuous integration

Pin an exact npm version and parse the JSON envelope:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npm install --global kmp-test-runner@0.14.0
- run: kmp-test doctor --project-root "$GITHUB_WORKSPACE" --json
- run: kmp-test parallel --project-root "$GITHUB_WORKSPACE" --json
```

For parallel matrix cells sharing one checkout, either assign disjoint project
roots/worktrees or combine `--isolated`, `--isolated-no-lock`, and disjoint
module filters. Pin `--device` for every concurrent Android instrumented cell.

Use normal process exit codes as the CI verdict. Persist
`.kmp-test-runner/logs/` and failure captures as protected artifacts when needed;
do not assume Gradle stderr is safe for public telemetry.

## Machine-readable output

Add `--json` to receive one JSON object on stdout. Parse stdout only; failed
commands may retain a bounded human diagnostic excerpt on stderr. The common
schema, discriminated errors, warning codes, and compatibility policy are in
[JSON envelope contract](envelope-contract.md).

```json
{"tool":"kmp-test","schema_version":2,"subcommand":"parallel","exit_code":0,"tests":{"total":3,"passed":3,"failed":0,"skipped":0,"individual_total":42},"modules":[],"skipped":[],"coverage":{"tool":"auto","missed_lines":0},"errors":[],"warnings":[]}
```

Agents should branch first on `exit_code`, then on `errors[].code`, and finally
inspect module-level `test_failures`. Unknown additive codes must be forwarded as
opaque values rather than treated as success.

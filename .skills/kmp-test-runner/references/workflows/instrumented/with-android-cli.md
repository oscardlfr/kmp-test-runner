# Instrumented tests (with android CLI) — `kmp-test android`

The canonical workflow for "run instrumented tests on a connected device or emulator" **when Google's `android` CLI is installed** (probe: `which android && android info >/dev/null 2>&1`). Dispatches `<module>:connectedAndroidTest` (or `<module>:androidConnectedCheck` for KMP `androidLibrary{}` DSL) across instrumented-capable modules, surfaces a single JSON envelope summarising per-module pass/fail and device attribution. The `android` CLI verbs supplement the agent's diagnostic surface — they do **not** alter `kmp-test android`'s dispatch or its envelope shape; the without-CLI branch produces a byte-identical envelope.

## Goal

Run every instrumented-capable module's connected-test task under one orchestrator invocation, dispatched against a single resolved device. The orchestrator pins `ANDROID_SERIAL`, resolves the gradle task name per-module (KMP `androidLibrary{}` registers `androidConnectedCheck`, classic AGP `connectedDebugAndroidTest`), composes `--flavor` + `--variant` weaving, and emits the standard top-level envelope plus a subcommand-specific `android:{device_serial, device_task, flavor, instrumented_modules[]}` block. Test failures populate `modules[].test_failures[]`; device/adb problems surface as `errors[].code: instrumented_setup_failed`.

## When to use this workflow

The agent should dispatch `kmp-test android` when the user asks any of:

- "Run instrumented tests" / "run on device" / "run connectedAndroidTest"
- "Run UI tests" / "run espresso tests" / "run the screenshot tests"
- "Run instrumented tests on `<SERIAL>`" — pin with `--device <SERIAL>`
- "Run only `<module>`'s instrumented tests" — narrow with `--module-filter`

Do **not** dispatch `android` for:

- JVM / desktop / iOS / macOS unit tests — use the `parallel` workflow ([`../unit-tests.md`](../unit-tests.md)).
- "Tests for the files I just changed" (which may include instrumented modules) — use the `changed` workflow ([`../changed.md`](../changed.md)).
- Coverage-only re-aggregation — use the `coverage` workflow ([`../coverage.md`](../coverage.md)).
- Macrobenchmark / microbenchmark dispatch on Android — use the `benchmark` workflow ([`../benchmarks.md`](../benchmarks.md)) with `--platform android`; it shares the same `instrumented_setup_failed` contract.

## Quickstart

```bash
# Branch check (canonical, from SKILL.md "Environment detection")
which android && android info >/dev/null 2>&1 && echo "HAS_ANDROID_CLI"

# Verify a device is bootable
android emulator list                              # AVDs (offline)
adb devices -l                                     # connected devices (online status)

# Pick a device + dispatch
kmp-test android --device R3CT30KAMEH --json
```

That command:

1. Probes for modules with `connectedAndroidTest` / `androidConnectedCheck` / connected instrumented benchmark tasks via the project model.
2. Reads `adb devices`; if `--device <SERIAL>` is set, validates the serial against the live list — mismatch → `errors[].code: instrumented_setup_failed` (exit 3). If `--device` is absent, auto-picks the first device.
3. Pins `ANDROID_SERIAL` to the resolved serial for the gradle subprocess.
4. Resolves the gradle task name per-module (auto, or forced via `--device-task <name>`).
5. Dispatches each module's task with `--continue`; appends `--gradle-args` tokens LAST (gradle last-wins).
6. Auto-selects a compatible JDK from the catalogue when the project requires a different version from the host default.
7. Emits a single-line JSON envelope on stdout — parse with `JSON.parse(stdout)`. The `android:{device_serial, device_task, flavor, instrumented_modules[]}` block carries the dispatch's resolved shape.

## Common flags

Defaults grounded in `lib/cli.js` SUBCOMMAND_HELP (the canonical source). Full per-subcommand matrix in [`../../cli/flags-reference.md`](../../cli/flags-reference.md).

| Flag | Default | Notes |
|------|---------|-------|
| `--json` | off | Mandatory for agent consumption. |
| `--device <serial>` | auto | Pin ADB device. Validated against `adb devices`; pins `ANDROID_SERIAL` in the gradle subprocess env (covers legacy `connected{Variant}AndroidTest`). On `connectedAndroidDeviceTest` (KMP `withDeviceTestBuilder` task) the orchestrator ALSO injects `-Pandroid.testInstrumentationRunnerArguments.deviceSerial=<serial>` because the device-test reporter ignores `ANDROID_SERIAL`. Mismatch → `instrumented_setup_failed` (exit 3). |
| `--device-task <name>` | auto | Force gradle task name. Two modern KMP variants: `androidConnectedCheck` for `androidLibrary{}` without device-test opt-in, `connectedAndroidDeviceTest` for `androidLibrary { withDeviceTestBuilder { sourceSetTreeName = "test" } }`. Preempts auto-resolution. |
| `--module-filter <glob>` | `*` | Glob, comma-separated. Narrow dispatch. |
| `--test-filter <pattern>` | none | Single class or `Class#method`. Wildcards resolved to FQN by source scan. |
| `--variant <auto\|debug\|release\|all>` | auto | Build variant. `auto` respects `testBuildType="release"` projects. |
| `--flavor <name>` | none | Android `productFlavors` weave. Unused → `flavor_unused` (exit 2). |
| `--auto-retry` | off | Re-dispatch instrumented tasks that ran but failed. One retry per task. |
| `--clear-data` | off | `adb shell pm clear <pkg>` before retry. Implies `--auto-retry`. |
| `--capture-on-fail` | off | On per-module failure, capture a device screenshot + UI-hierarchy dump via `adb` (best-effort). Paths on `errors[].screenshot_file` / `.ui_hierarchy_file`; `capture_error` when adb can't oblige. Forensic-only — never changes the exit code. Same flag on `parallel --test-type androidInstrumented`. |
| `--capture-dir <path>` | per-run log dir | Override where `--capture-on-fail` artifacts land (default `.kmp-test-runner/logs/android/<runId>/`). Implies `--capture-on-fail`. |
| `--skip-app` | off | Skip `app` / `androidApp` modules — library-only instrumented dispatch. |
| `--verbose` | off | Show last 30 lines of log on per-module failure. |
| `--isolated` | off | Wrap gradle with `--project-cache-dir <tmp>`. **Requires `--device <SERIAL>`** for instrumented dispatch — otherwise `isolated_runtime_race` (exit 2). |
| `--isolated-cache-dir <path>` | per-run tmpdir | Override cache-dir location. Implies `--isolated`. |
| `--isolated-no-lock` | off | Skip the OS-level cache-dir lockfile. Implies `--isolated`. |
| `--gradle-args "<args>"` | none | Escape hatch — tokens appended LAST. |
| `--java-home <path>` | none | Explicit JDK. Wins over catalogue auto-select. |
| `--no-jdk-autoselect` | off | Disable JDK catalogue auto-select. |
| `--ignore-jdk-mismatch` | off | Downgrade JDK-mismatch gate to WARN. |
| `--dry-run` | off | Plan envelope, exit 0, no gradle spawn. |
| `--list` / `--list-only` | off | Post-filter `modules[]` + `skipped[]` envelope, exit 0 before dispatch. |
| `--color <mode>` | auto | `always` / `never` / `auto`. Controls `--console=plain` injection. |
| `--force` | off | Bypass project lockfile when another `kmp-test` process holds it. |

## Android CLI augmentation

The `android` CLI (0.7.x at the time of writing — see [developer.android.com/tools/agents/android-cli](https://developer.android.com/tools/agents/android-cli)) extends the agent's instrumented-test diagnostic surface in three ways. None of them change `kmp-test android`'s dispatch — they enrich what the agent sees when something goes wrong.

### Device discovery + AVD lifecycle

```bash
android emulator list             # AVD names from $ANDROID_HOME/avd/ (offline)
android emulator start <AVD>      # Foreground boot
android emulator start <AVD> --cold   # Snapshot bypass — clean userdata
android emulator stop             # adb emu kill under the hood
```

`android emulator start` foregrounds — pair with `adb wait-for-device` in scripts, or background it (`&` in bash; `Start-Process` in PowerShell). Windows PowerShell limitation: `android emulator` is disabled on PowerShell hosts in CLI 0.7.x (documented at the URL above) — on PowerShell, fall back to invoking the emulator binary directly (`$env:ANDROID_HOME\emulator\emulator.exe -avd <AVD>`). The without-CLI branch ([`without-android-cli.md`](without-android-cli.md)) documents that path in full.

### UI + visual diagnostics on instrumented failures

```bash
android screen capture -o failure.png             # PNG snapshot
android screen capture --annotate -o annotated.png   # Compose semantic bboxes
android layout                                     # UiAutomator tree as native JSON
android layout --pretty                            # human-formatted
android layout --diff > delta.json                 # incremental vs last capture
```

Use these when `errors[].code: module_failed` fires on an instrumented module — the visual + semantic-tree snapshot often reveals "view not visible / wrong activity / dialog dismissed mid-test" causes the JUnit XML alone won't show. `android screen capture --annotate` is the only diagnostic verb that has **no clean adb equivalent** (the without-CLI branch's substitute is the Layout Inspector standalone JAR).

### Gradle introspection — sharp caveat

`android describe` reports the project's gradle-resolved output paths (APK / AAB / resources). It is **not a substitute** for `kmp-test describe` — they answer different questions:

- `kmp-test describe --json` — walks the kmp-test project model (per-module `test_tasks`, coverage plugin attribution, dependency graph). **Canonical for agent test-dispatch planning.**
- `android describe` — walks AGP build outputs. Useful only when the agent needs to locate `outputs/connected_android_test_additional_output/<variant>/` for macrobenchmark Trace artifact pull post-dispatch.

When in doubt, use `kmp-test describe`.

### What NOT to use from the android CLI

- `android info` — analytics network calls (warning if offline; non-fatal). Useful as the branch-detection probe only.
- `android run` — installs an APK and launches an activity via `am start`. Useful for manual repro of a failing instrumented scenario; do **not** use to bypass the kmp-test dispatch contract.
- `android create` — scaffolds a new Android project. Irrelevant for instrumented testing.
- `android docs search` / `android docs fetch` — knowledge-base verbs. Tangential to the test loop; the agent's WebFetch tool is the canonical doc lookup path.

## Behaviors únicos

### `--auto-retry` + `--clear-data`

`--auto-retry` re-dispatches instrumented tasks that ran but failed (runtime failures only, not configuration-time aborts). One retry per task. `--clear-data` adds `adb shell pm clear <pkg>` before each retry; implies `--auto-retry`. Useful for flaky tests that share device state across runs (saved auth, cached web responses, dirty database). The `android:{}` block does not surface a separate retries[] field on this subcommand; on `kmp-test parallel --test-type androidInstrumented` the per-leg `parallel.legs[i].retries[]` array carries the per-task retry record.

### `--device-task` auto-resolution

Modern KMP `androidLibrary{}` DSL (AGP 9+) registers one of two tasks depending on whether the module opts into device-test reporting:

- `:<module>:androidConnectedCheck` — `androidLibrary {}` without `withDeviceTestBuilder {}`. Lightweight; reports via legacy AGP instrumented runner.
- `:<module>:connectedAndroidDeviceTest` — `androidLibrary { withDeviceTestBuilder { sourceSetTreeName = "test" } }`. Uses the newer device-test reporter (per-device progress lines + `Finished N tests on <device>` banners). Ignores the `ANDROID_SERIAL` env var; reads `-Pandroid.testInstrumentationRunnerArguments.deviceSerial=<serial>` instead — the orchestrator injects this property automatically when this task is in play.

The orchestrator probes per-module via the project model and picks the right task automatically. Force with `--device-task <name>` when the probe is wrong (or when the project uses a custom convention plugin that registers an unconventional name). Same recovery pattern as in [`../../troubleshooting/task-not-found.md`](../../troubleshooting/task-not-found.md).

### Flavor + variant weaving

`--flavor staging --variant release` → `:<module>:connectedStagingReleaseAndroidTest`. Mismatched flavor (no module declares `productFlavors { staging {} }`) emits `flavor_unused` (exit 2) at parse time — see [`../../troubleshooting/flavor-unused.md`](../../troubleshooting/flavor-unused.md). Missing variant surfaces later as `task_not_found` from gradle.

### Discovery + filter

`--skip-app` drops `app` / `androidApp` modules from the dispatch (library-only). `--verbose` surfaces the last 30 lines of each failing per-module log into stderr — useful when the JUnit XML doesn't carry the actual cause (process death, ANR, native crash).

## Edge cases

- **Cold-boot timing**: `android emulator start <AVD>` foregrounds and takes 15-60s to reach a wakeful state. Pair with `adb wait-for-device` before invoking `kmp-test android`, or accept that the first call will see `instrumented_setup_failed` if the emulator hasn't finished booting.
- **`--device <SERIAL>` with offline serial**: `adb devices -l` shows `offline` next to the serial; `kmp-test android --device <OFFLINE_SERIAL>` emits `instrumented_setup_failed` (exit 3) — the dispatch never spawns gradle. Recovery: `adb -s <SERIAL> reboot` (real device) or restart the emulator.
- **`--flavor` + KMP `androidLibrary{}`**: AGP 9+ KMP DSL has a limited `productFlavors{}` surface — some flavor / variant combinations don't weave into a connected-test task name. Use `--device-task androidConnectedCheck` to bypass flavor resolution entirely; the gradle task ignores the flavor selector.
- **`--isolated` + `--device`**: safe combination *for parallel runs against different project roots* — each isolated run pins its own serial and gets its own config-cache dir. Without `--device` → `isolated_runtime_race` (exit 2) at parse time, because two concurrent isolated runs would race for ADB's auto-picked device. **`--isolated` does NOT bypass the project lockfile**: concurrent runs against the **same** `--project-root` still trigger `lock_held` (exit 3) — `--isolated` isolates cache state, not project ownership. Use `--force` to bypass the lockfile when the prior process is known-dead.
- **`--auto-retry` on cascade failures**: the retry path only re-runs runtime-failed instrumented tasks. Configuration-phase failures (compile errors, plugin conflicts) surface as `module_failed` with `setup_failed:true` and do **not** retry — those need code edits, not re-dispatch.
- **Multiple devices, no `--device`**: kmp-test auto-picks the first device from `adb devices`. If that's a stale offline emulator, the dispatch fails downstream rather than at the gate. Pin with `--device <SERIAL>` whenever multiple devices may be present.
- **Multiple devices, `--device <SERIAL>` on `connectedAndroidDeviceTest` (managed-device task)**: the device-test reporter ignores `ANDROID_SERIAL` — without the gradle property injection AGP picks any device from the pool, including the wrong one. The orchestrator injects `-Pandroid.testInstrumentationRunnerArguments.deviceSerial=<serial>` automatically when it detects this task suffix, so user-side intervention is rarely needed. Diagnostic: gradle stdout shows `Starting N tests on <other-device>` instead of the pinned serial.
- **`--auto-retry` on a device that went offline mid-run**: the orchestrator runs `adb kill-server && adb start-server` between attempts so the retry sees an up-to-date device list. If the device stays offline through the kill+start, the retry still fails — recovery is `adb -s <SERIAL> reboot` and a fresh `kmp-test android` invocation.

## Envelope shape excerpt

The `android` subcommand emits the standard top-level envelope (see [`../../cli/envelope-schema.md`](../../cli/envelope-schema.md)) plus a subcommand-specific `android:{}` block:

```json
{
  "tool": "kmp-test",
  "schema_version": 2,
  "subcommand": "android",
  "exit_code": 0,
  "tests": { "total": 3, "passed": 3, "failed": 0, "skipped": 0 },
  "modules": [
    {
      "name": ":app",
      "type": "kmp",
      "android_dsl": true,
      "android_dsl_variant": "kmpAndroidLibrary",
      "test_failures": []
    }
  ],
  "coverage": {
    "tool": "auto",
    "missed_lines": null,
    "modules_with_kover_plugin": [],
    "modules_with_jacoco_plugin": []
  },
  "android": {
    "device_serial": "R3CT30KAMEH",
    "device_task": "",
    "flavor": "",
    "instrumented_modules": [":app"]
  },
  "errors": [],
  "warnings": []
}
```

- `android.device_serial` echoes the RESOLVED serial — after `--device` validation or auto-pick. Empty string only when validation pre-failed and no `--device` was passed.
- `android.device_task` is empty unless `--device-task` was explicitly passed; the auto-resolved task name is NOT surfaced.
- `android.flavor` echoes `--flavor` verbatim (empty when absent).
- `android.instrumented_modules[]` is the post-filter set the dispatch iterated.

## Troubleshooting

Branch on `errors[].code`:

- `instrumented_setup_failed` → [`../../troubleshooting/instrumented-setup-failed/with-android-cli.md`](../../troubleshooting/instrumented-setup-failed/with-android-cli.md) (this branch)
- `module_failed` (incl. `setup_failed:true`) → [`../../troubleshooting/module-failed.md`](../../troubleshooting/module-failed.md)
- `task_not_found` → [`../../troubleshooting/task-not-found.md`](../../troubleshooting/task-not-found.md) (most common with KMP `androidLibrary{}` on AGP 9)
- `unsupported_class_version` → [`../../troubleshooting/unsupported-class-version.md`](../../troubleshooting/unsupported-class-version.md)
- `flavor_unused` → [`../../troubleshooting/flavor-unused.md`](../../troubleshooting/flavor-unused.md)
- `isolated_runtime_race` → [`../../troubleshooting/isolated-runtime-race.md`](../../troubleshooting/isolated-runtime-race.md)

## See also

- [`without-android-cli.md`](without-android-cli.md) — sibling branch (no `android` CLI on PATH)
- [`../overview.md`](../overview.md) — workflows hub
- [`../../../SKILL.md#environment-detection`](../../../SKILL.md) — canonical branch-detection probe
- [`../../cli/envelope-schema.md`](../../cli/envelope-schema.md) — full JSON envelope contract
- [`../../cli/exit-codes.md`](../../cli/exit-codes.md) — exit-code semantics + WS-5 invariant
- [`../../cli/flags-reference.md`](../../cli/flags-reference.md) — full per-subcommand flag matrix
- [`../unit-tests.md`](../unit-tests.md) — `parallel` workflow (unit tests, NOT instrumented)
- [`../benchmarks.md`](../benchmarks.md) — `benchmark` with `--platform android` (instrumented benchmark variant; shares `instrumented_setup_failed` contract)

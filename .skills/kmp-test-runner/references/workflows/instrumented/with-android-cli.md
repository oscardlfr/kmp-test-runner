# Instrumented tests (with android CLI) — `kmp-test android`

Use this workflow for instrumented tests when Google's `android` CLI is installed. `kmp-test android` dispatches each selected module's connected-test task and emits its own JSON envelope. Android CLI helps the agent deploy an app and inspect its UI; it does not change Gradle dispatch or add a Journey verdict to the `kmp-test` envelope. Check the installed `android --version` and command help before using a verb: Android CLI changes independently of this skill.

## Goal

Run every instrumented-capable module's connected-test task under one orchestrator invocation, dispatched against a single resolved device. The orchestrator pins `ANDROID_SERIAL`, resolves the gradle task name per-module (KMP `androidLibrary{}` registers `androidConnectedCheck`, classic AGP `connectedDebugAndroidTest`), composes `--flavor` + `--variant` weaving, and emits the standard top-level envelope plus a subcommand-specific `android:{device_serial, device_task, flavor, instrumented_modules[]}` block. Test failures populate `modules[].test_failures[]`; device/adb problems surface as `errors[].code: instrumented_setup_failed`.

## When to use this workflow

The agent should dispatch `kmp-test android` when the user asks any of:

- "Run instrumented tests" / "run on device" / "run connectedAndroidTest"
- "Run UI tests" / "run espresso tests" / "run the screenshot tests"
- "Run instrumented tests on `<SERIAL>`" — pin with `--device <SERIAL>`
- "Run only `<module>`'s instrumented tests" — select its exact Gradle path with `--modules :module`; `--module-filter` remains a glob/substr filter.

Do **not** dispatch `android` for:

- JVM / desktop / iOS / macOS unit tests — use the `parallel` workflow ([`../unit-tests.md`](../unit-tests.md)).
- "Tests for the files I just changed" (which may include instrumented modules) — use the `changed` workflow ([`../changed.md`](../changed.md)).
- Coverage-only re-aggregation — use the `coverage` workflow ([`../coverage.md`](../coverage.md)).
- Macrobenchmark / microbenchmark dispatch on Android — use the `benchmark` workflow ([`../benchmarks.md`](../benchmarks.md)) with `--platform android`; it shares the same `instrumented_setup_failed` contract.

## Windows PowerShell: pin one local device

Prerequisites: a Gradle project with `gradlew.bat` and instrumented tests, `kmp-test`, a compatible JDK, Android SDK platform-tools, Android CLI, and a USB device with debugging authorized or a **local** emulator. This example also works when `adb.exe` is absent from `PATH` before the setup line. Replace the project, module and serial with values observed on your machine. If no device is online yet, follow [Local AVDs on Windows](#local-avds-on-windows) before dispatch.

```powershell
Get-Command android, kmp-test
android --version
android run --help
android layout --help
android screen capture --help

$Project = 'C:\path\to\your-project'
$Module = ':app'
$Sdk = (android info sdk).Trim()
$Adb = Join-Path $Sdk 'platform-tools\adb.exe'
$env:Path = "$(Split-Path $Adb);$env:Path" # kmp-test also spawns adb
kmp-test doctor --project-root $Project --json
& $Adb devices -l                         # copy a row whose status is device
$Serial = 'emulator-5554'                  # example only; use the listed serial
& $Adb -s $Serial shell getprop sys.boot_completed # expect 1

$Evidence = Join-Path $Project '.kmp-test-runner\journey-evidence'
New-Item -ItemType Directory -Force -Path $Evidence | Out-Null
$TestsJson = Join-Path $Evidence 'tests.json'
$TestsStderr = Join-Path $Evidence 'tests.stderr.log'
kmp-test android --project-root $Project --modules $Module --device $Serial --json `
  1> $TestsJson 2> $TestsStderr
$TestProcessExit = $LASTEXITCODE
$Test = Get-Content -Raw $TestsJson | ConvertFrom-Json
"runner process exit: $TestProcessExit"
$Test | Select-Object exit_code, tests, modules
$Test.android.device_serial             # must equal $Serial
```

The shell exit and JSON `exit_code` must agree. `tests.total/passed/failed` describe the runner's instrumented tasks; they are **not** Journey assertions. `android.device_serial` identifies the device selected by the runner. Check Gradle's per-task log if its reporter prints a different device name. With multiple devices, never rely on auto-selection.

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
| `--output-dir <path>` | `<project>/.kmp-test-runner` | Put runner-owned logs, caches, reports and default failure captures in a dedicated directory. Journey evidence remains a separate agent-owned artifact. |
| `--device <serial>` | auto | Pin ADB device. Validated against `adb devices`; pins `ANDROID_SERIAL` in the gradle subprocess env (covers legacy `connected{Variant}AndroidTest`). On `connectedAndroidDeviceTest` (KMP `withDeviceTestBuilder` task) the orchestrator ALSO injects `-Pandroid.testInstrumentationRunnerArguments.deviceSerial=<serial>` because the device-test reporter ignores `ANDROID_SERIAL`. Mismatch → `instrumented_setup_failed` (exit 3). |
| `--device-task <name>` | auto | Force gradle task name. Two modern KMP variants: `androidConnectedCheck` for `androidLibrary{}` without device-test opt-in, `connectedAndroidDeviceTest` for `androidLibrary { withDeviceTestBuilder { sourceSetTreeName = "test" } }`. Preempts auto-resolution. |
| `--modules <names>` | all discovered | Exact Gradle module paths, comma-separated and supplied once. Unknown or ambiguous names fail with exit 2. Use this for one known module. |
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

## Local AVDs on Windows

Google [lists `android emulator` as disabled on Windows](https://developer.android.com/tools/agents/android-cli#known-issues). Use the SDK emulator executable for AVD lifecycle; `android layout`, `android screen capture` and `android run` can still target a serial explicitly. The following Windows startup pattern was exercised with a local AVD. It is optional when a physical device is already connected.

```powershell
$Emulator = Join-Path $Sdk 'emulator\emulator.exe'
& $Emulator -list-avds
Start-Process -FilePath $Emulator -ArgumentList @('-avd', 'YOUR_AVD', '-no-window', '-no-audio') -WindowStyle Hidden
& $Adb devices -l
$Serial = 'emulator-5554' # replace after the intended AVD appears online
# Wait until the intended serial reports device and boot_completed is 1.
& $Adb -s $Serial wait-for-device
& $Adb -s $Serial shell getprop sys.boot_completed
& $Adb -s $Serial emu avd name           # confirm the AVD behind this serial
```

Use a serial from the **online** ADB row. An `offline` row is not a usable device. On Windows, the SDK's `adb.exe` may exist even when `adb` is not on `PATH`; the setup above adds platform-tools before invoking `kmp-test`.

## Agent-guided Journey after the Gradle test

Google's [Journey guide](https://developer.android.com/tools/agents/android-cli/journeys) defines a Journey as natural-language actions evaluated by an agent on a running app. The [official skill reference](https://developer.android.com/agents/skills/devtools/android-cli/references/journeys) specifies sequential evaluation and a per-action report. `android --help` has no `journeys` run command. Ask the agent to read a Journey XML file, perform each action on **the same `$Serial`**, and write a separate report. For example:

```xml
<journey name="Review list loads">
  <description>Open the app and verify its primary content.</description>
  <actions>
    <action>Launch the app on the selected device.</action>
    <action>Verify that at least one review card is visible.</action>
  </actions>
</journey>
```

After the Gradle run, locate its built app APK and use the installed CLI's `android run --help` to check the flags. These PowerShell commands were exercised with Android CLI 1.0.16500706; on older installed builds, check each verb's help because `screen capture --device` may be absent.

```powershell
$Apk = Join-Path $Project 'app\build\outputs\apk\debug\app-debug.apk'
$Layout = Join-Path $Evidence 'journey-layout.json'
$Screen = Join-Path $Evidence 'journey-screen.png'
android run --device=$Serial --apks=$Apk
& $Adb -s $Serial shell dumpsys activity activities # confirm intended app is top resumed
android layout --device=$Serial --full --pretty --output=$Layout
android screen capture --device=$Serial --output=$Screen
# For an action that requires input, inspect the UI first, then target the same device:
# & $Adb -s $Serial shell input tap <x> <y>
```

Inspect the layout and **view the screenshot** before deciding a visual assertion. Evaluate the XML actions in order, stop after an unmet expectation, and record `PASSED` / `FAILED` / `SKIPPED`, commands, observations, and evidence paths per action in `journey-result.md`. The Journey verdict comes from those observations, not `tests.json`. A successful JUnit context test can coexist with a failed Journey if the app displays an error or wrong screen. Do not mark a Journey PASS just because `android run`, `layout`, or `screen capture` exited 0.

On a physical device, the first `android layout --output=$Layout` invocation may install its layout instrumentation server and exit before writing the file. Check `Test-Path -LiteralPath $Layout`; if absent, run the command again and require the file before evaluating an assertion. This happened in a local Windows device smoke test; an exit code of zero alone did not prove a layout was captured.

For diagnostics after an instrumented failure, capture the same serial with `android layout --device=$Serial` and `android screen capture --device=$Serial`. The current `android layout --diff` flag is [deprecated and has no effect](https://developer.android.com/tools/agents/android-cli/commands/layout); use a full capture. `android describe` locates AGP build outputs, while `kmp-test describe --json` is the test-module planning source.

**Automation boundary:** Google describes agent-run Journeys in CI, but the published CLI reference documents no Journey invocation, stable JSON/JUnit result schema, or aggregate exit-code contract. Treat the agent's report as a separate artifact and apply an explicit human or project-owned gate if CI needs a Journey verdict. Android CLI is optional for `kmp-test android`. [Remote physical devices](https://developer.android.com/tools/agents/android-cli/commands/device_remote) are an unverified option here and bill a Google Cloud project; do not reserve one without authorization.

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

- **Cold-boot timing**: an AVD can appear as `offline` or `device` before Android finishes booting. Check `& $Adb -s $Serial shell getprop sys.boot_completed` for `1` before dispatch. On Windows, start the local AVD with the SDK emulator executable as shown above.
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
  "schema_version": 3,
  "contracts": { "coverage_evidence": 1 },
  "subcommand": "android",
  "exit_code": 0,
  "tests": { "total": 1, "passed": 1, "failed": 0, "skipped": 0 },
  "modules": ["app"],
  "coverage": {
    "tool": "auto",
    "missed_lines": null,
    "modules_with_kover_plugin": [],
    "modules_with_jacoco_plugin": []
  },
  "android": {
    "device_serial": "<DEVICE_SERIAL>",
    "device_task": "",
    "flavor": "",
    "instrumented_modules": ["app"]
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

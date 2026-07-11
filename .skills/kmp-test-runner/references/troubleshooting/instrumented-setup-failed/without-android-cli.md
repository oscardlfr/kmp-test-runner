# `instrumented_setup_failed` (without android CLI) — adb / device problem

The orchestrator wanted a connected device but `adb` returned zero devices, or `--device <SERIAL>` was supplied and didn't match any listed serial. This branch documents recovery using only `adb` + the `emulator` binary. The sibling with-CLI branch ([`with-android-cli.md`](with-android-cli.md)) documents the same recovery with Google's `android` CLI verbs. The envelope is **identical across both branches** — only the recovery commands differ.

Applies to `kmp-test android`, `kmp-test parallel --test-type androidInstrumented`, and `kmp-test benchmark --platform android` (or `all`). Always exits **3** (ENV_ERROR).

## Symptom

No-devices variant:

```json
{
  "exit_code": 3,
  "errors": [{
    "code": "instrumented_setup_failed",
    "message": "No adb devices connected. Plug in a device or set KMP_TEST_SKIP_ADB=1 to bypass."
  }],
  "android": {
    "device_serial": "",
    "device_task": "",
    "flavor": "",
    "instrumented_modules": [":app"]
  }
}
```

Device-mismatch variant:

```json
{
  "exit_code": 3,
  "errors": [{
    "code": "instrumented_setup_failed",
    "message": "Requested device \"BAD_SERIAL\" not found in adb devices output. Available: <DEVICE_SERIAL>."
  }],
  "android": {
    "device_serial": "BAD_SERIAL",
    "device_task": "",
    "flavor": "",
    "instrumented_modules": [":app"]
  }
}
```

Read `android.device_serial` to discriminate: empty → no device was selected (zero connected, or no `--device`); populated → that serial didn't validate against the live `adb devices` list.

## Root causes

Ranked by frequency:

1. **No device connected.** USB cable issue, emulator never booted, `adb` daemon dead. The most common cause.
2. **Device offline.** `adb devices -l` shows `offline` next to the serial — USB transient or emulator mid-boot. Not "no devices" but functionally equivalent for the gate.
3. **`--device <SERIAL>` typo.** Serials are case-sensitive; copy from `adb devices -l` verbatim.
4. **Multiple devices, no `--device`, auto-pick wrong.** kmp-test auto-picks the FIRST device from the list. If that's a stale offline emulator, the dispatch fails downstream. Pin with `--device <SERIAL>`.
5. **Emulator AVD doesn't exist.** `--device emulator-5554` but no AVD is running. `emulator -list-avds` (from `$ANDROID_HOME/emulator/`) shows available AVDs; `emulator -avd <AVD>` boots one.
6. **adb server dead.** Rare but happens on Windows after sleep/wake. Recovery: `adb kill-server && adb start-server`.
7. **Ghost offline device on Managed Devices task.** `--device <SERIAL>` is set, the serial appears in `adb devices`, but the gradle `connectedAndroidDeviceTest` task picks a DIFFERENT device — diagnostic in gradle stdout: `Starting N tests on <other-device>` instead of the pinned serial. Root cause: the device-test reporter ignores `ANDROID_SERIAL`. The orchestrator now injects `-Pandroid.testInstrumentationRunnerArguments.deviceSerial=<serial>` automatically when the resolved task is `connectedAndroidDeviceTest`. If you still hit it, force the gradle property via `--gradle-args "-Pandroid.testInstrumentationRunnerArguments.deviceSerial=<serial>"` as a workaround.

## Recovery path

1. **Probe** with `adb devices -l`. Branch:
   - Empty output → root cause #1, go to section 2.
   - One or more serials with `offline` status → root cause #2, go to section 3.
   - Serials present but `--device` typo → root cause #3, go to section 4.
2. **No devices**:
   - Check the USB cable + USB-debugging toggle (real device).
   - `emulator -list-avds` → pick an AVD → `emulator -avd <AVD> &` (background; `-no-snapshot-load` for cold).
   - Wait for `adb devices` to show the device as `device` (not `offline` / `unauthorized`).
3. **Offline device**: `adb -s <SERIAL> reboot` (real device) or `adb emu kill && emulator -avd <AVD> &` (emulator).
4. **`--device` typo**: copy the serial from `adb devices -l` column 1 verbatim and re-run.
5. **Auto-pick wrong device**: always pass `--device <SERIAL>` when multiple devices may be present.
6. **Stale adb server**: `adb kill-server && adb start-server && adb devices -l`.

## Recovery commands (without-CLI branch)

```bash
# Discovery
adb devices -l                                      # connected serials + status
emulator -list-avds                                 # AVD names (offline; from $ANDROID_HOME/emulator/)
emulator -avd <AVD> -no-snapshot-load &             # cold boot in background
adb emu kill                                        # stop running emulator

# Stop + restart adb server (last resort)
adb kill-server && adb start-server && adb devices -l

# Re-dispatch with explicit pin
kmp-test android --device <DEVICE_SERIAL> --json

# Very-rare escape hatch — only useful for `kmp-test doctor` / `info` paths,
# NOT a recovery for `android` subcommand (the orchestrator legitimately needs devices)
KMP_TEST_SKIP_ADB=1 kmp-test doctor --json
```

## AGP / JDK quirks

- **KMP `androidLibrary{}` DSL + AGP 9**: when the device is fine but the dispatch still fails, the surfaced code is `task_not_found`, NOT `instrumented_setup_failed` — the orchestrator dispatched `:<module>:connectedDebugAndroidTest` against a module that only registers `:<module>:androidConnectedCheck`. See [`../task-not-found.md`](../task-not-found.md).
- **Windows USB-debugging driver**: Samsung's KIES driver sometimes hijacks the USB device claim, causing `offline` or `unauthorized` status to stick. Uninstall the OEM driver; rely on Google's universal ADB driver from `$ANDROID_HOME/extras/google/usb_driver/`.
- **`emulator` binary not on PATH**: `$ANDROID_HOME/emulator/emulator` must be invoked via absolute path on hosts where the SDK is installed but the emulator dir wasn't appended to PATH. Add the directory to PATH (POSIX: `export PATH="$ANDROID_HOME/emulator:$PATH"`; PowerShell: `$env:PATH = "$env:ANDROID_HOME\emulator;$env:PATH"`) or alias the verb.
- **Macrobenchmark connected output**: `app/build/outputs/connected_android_test_additional_output/<variant>/` only exists after a SUCCESSFUL instrumented dispatch — irrelevant to the recovery path but useful confirmation that recovery worked when the agent re-checks the directory.
- **KMP `withDeviceTestBuilder` device-test reporter**: the `:<module>:connectedAndroidDeviceTest` task (registered when a KMP module uses `androidLibrary { withDeviceTestBuilder { sourceSetTreeName = "test" } }`) ignores `ANDROID_SERIAL`. The orchestrator auto-injects `-Pandroid.testInstrumentationRunnerArguments.deviceSerial=<serial>` on top whenever `--device <SERIAL>` is set and this task is in play. No user action required — but if you see a `Starting N tests on <other-device>` line in the captured per-task log under `.kmp-test-runner/logs/android/<runId>/<module>.log`, force the property via `--gradle-args "-Pandroid.testInstrumentationRunnerArguments.deviceSerial=<serial>"` as a workaround and report the regression.

## See also

- [`with-android-cli.md`](with-android-cli.md) — sibling branch (`android` CLI installed)
- [`../overview.md`](../overview.md) — troubleshooting hub
- [`../../cli/envelope-schema.md#errors-discriminated-codes`](../../cli/envelope-schema.md) — full discriminated-code table
- [`../../cli/exit-codes.md`](../../cli/exit-codes.md) — exit-code → code mapping (3 = ENV_ERROR)
- [`../task-not-found.md`](../task-not-found.md) — when the device is fine but the task name is wrong
- [`../../workflows/instrumented/without-android-cli.md`](../../workflows/instrumented/without-android-cli.md) — workflow context

# `instrumented_setup_failed` (with android CLI) — adb / device problem

The orchestrator wanted a connected device but `adb` returned zero devices, or `--device <SERIAL>` was supplied and didn't match any listed serial. This branch documents recovery using the `android` CLI verbs (see [developer.android.com/tools/agents/android-cli](https://developer.android.com/tools/agents/android-cli)). The sibling without-CLI branch ([`without-android-cli.md`](without-android-cli.md)) documents the same recovery with raw `adb` + `emulator` verbs. The envelope is **identical across both branches** — only the recovery commands differ.

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
5. **Emulator AVD doesn't exist or hasn't booted.** `--device emulator-5554` names a serial, not an AVD. On Windows, the SDK's `emulator.exe -list-avds` lists local AVDs and `emulator.exe -avd <AVD>` starts one. Confirm its assigned serial with `adb -s <SERIAL> emu avd name` and `sys.boot_completed=1`.
6. **adb server dead.** Rare but happens on Windows after sleep/wake. Restart it with separate `adb kill-server` and `adb start-server` commands.
7. **Ghost offline device on Managed Devices task.** `--device <SERIAL>` is set, the serial appears in `adb devices`, but the gradle `connectedAndroidDeviceTest` task picks a DIFFERENT device — diagnostic in gradle stdout: `Starting N tests on <other-device>` instead of the pinned serial. Root cause: the device-test reporter ignores `ANDROID_SERIAL`. The orchestrator now injects `-Pandroid.testInstrumentationRunnerArguments.deviceSerial=<serial>` automatically when the resolved task is `connectedAndroidDeviceTest`, so this surface is rare after PR 3.2's predecessor PR 3.3 (2026-05-17). If you still hit it, force the gradle property via `--gradle-args "-Pandroid.testInstrumentationRunnerArguments.deviceSerial=<serial>"` and file an issue.

## Recovery path

1. **Probe** with `adb devices -l`. Branch:
   - Empty output → root cause #1, go to section 2.
   - One or more serials with `offline` status → root cause #2, go to section 3.
   - Serials present but `--device` typo → root cause #3, go to section 4.
2. **No devices**:
   - Check the USB cable + USB-debugging toggle (real device).
   - On Windows, list/start a local AVD with the SDK emulator executable; see the [Windows workflow](../../workflows/instrumented/with-android-cli.md#local-avds-on-windows). On other hosts, use the installed `android emulator --help` if supported.
   - Wait for `adb devices` to show the device as `device` (not `offline` / `unauthorized`).
3. **Offline device**: check the cable/authorization for a physical device. Restart only the AVD you own; do not stop another emulator selected from a multi-device list.
4. **`--device` typo**: copy the serial from `adb devices -l` column 1 verbatim and re-run.
5. **Auto-pick wrong device**: always pass `--device <SERIAL>` when multiple devices may be present.
6. **Stale adb server**: stop, start, then list devices; recheck the pinned serial.

## Recovery commands on Windows PowerShell

```powershell
$Sdk = (android info sdk).Trim()
$Adb = Join-Path $Sdk 'platform-tools\adb.exe'
$Emulator = Join-Path $Sdk 'emulator\emulator.exe'
$env:Path = "$(Split-Path $Adb);$env:Path"
& $Adb devices -l
& $Emulator -list-avds
# If needed, launch the intended local AVD as in the linked workflow.
$Serial = 'emulator-5554' # replace with an online row from adb devices -l
& $Adb -s $Serial shell getprop sys.boot_completed
& $Adb -s $Serial emu avd name
kmp-test android --project-root 'C:\path\to\project' --modules :app --device $Serial --json
```

Only after diagnosing a stale ADB server, run `& $Adb kill-server`, then `& $Adb start-server`, then `& $Adb devices -l`. `KMP_TEST_SKIP_ADB=1` is not a recovery for an instrumented dispatch; it makes that dispatch list-only.

## AGP / JDK quirks

- **KMP `androidLibrary{}` DSL + AGP 9**: when the device is fine but the dispatch still fails, the surfaced code is `task_not_found`, NOT `instrumented_setup_failed` — the orchestrator dispatched `:<module>:connectedDebugAndroidTest` against a module that only registers `:<module>:androidConnectedCheck`. See [`../task-not-found.md`](../task-not-found.md).
- **Windows USB-debugging driver**: Samsung's KIES driver sometimes hijacks the USB device claim, causing `offline` or `unauthorized` status to stick. Uninstall the OEM driver; rely on Google's universal ADB driver from `$ANDROID_HOME/extras/google/usb_driver/`.
- **Windows + `android emulator`**: Google's [current known issues](https://developer.android.com/tools/agents/android-cli#known-issues) still list the verb as disabled on Windows. Use the SDK's `emulator.exe`; Android CLI's layout and screen commands can target the serial.
- **Macrobenchmark connected output**: `app/build/outputs/connected_android_test_additional_output/<variant>/` only exists after a SUCCESSFUL instrumented dispatch — irrelevant to the recovery path but useful confirmation that recovery worked when the agent re-checks the directory.
- **KMP `withDeviceTestBuilder` device-test reporter**: the `:<module>:connectedAndroidDeviceTest` task (registered when a KMP module uses `androidLibrary { withDeviceTestBuilder { sourceSetTreeName = "test" } }`) ignores `ANDROID_SERIAL`. The orchestrator auto-injects `-Pandroid.testInstrumentationRunnerArguments.deviceSerial=<serial>` on top whenever `--device <SERIAL>` is set and this task is in play. No user action required — but if you see a `Starting N tests on <other-device>` line in the captured per-task log under `.kmp-test-runner/logs/android/<runId>/<module>.log`, force the property via `--gradle-args "-Pandroid.testInstrumentationRunnerArguments.deviceSerial=<serial>"` as a workaround and report the regression.

## See also

- [`without-android-cli.md`](without-android-cli.md) — sibling branch (no `android` CLI on PATH)
- [`../overview.md`](../overview.md) — troubleshooting hub
- [`../../cli/envelope-schema.md#errors-discriminated-codes`](../../cli/envelope-schema.md) — full discriminated-code table
- [`../../cli/exit-codes.md`](../../cli/exit-codes.md) — exit-code → code mapping (3 = ENV_ERROR)
- [`../task-not-found.md`](../task-not-found.md) — when the device is fine but the task name is wrong
- [`../../workflows/instrumented/with-android-cli.md`](../../workflows/instrumented/with-android-cli.md) — workflow context

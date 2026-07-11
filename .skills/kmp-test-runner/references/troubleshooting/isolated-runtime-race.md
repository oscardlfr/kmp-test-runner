# `isolated_runtime_race` — `--isolated` combined with a shared-runtime test type

`--isolated` provides Tier-3 isolation via per-run `--project-cache-dir <tmp>` — but some test types share a process-global resource (ADB serial, iOS simulator, `--test-type all`) that no cache-dir trick can isolate. The orchestrator detects this combination at parse time and exits 2 before any gradle dispatch.

## Symptom

```json
{
  "exit_code": 2,
  "errors": [{
    "code": "isolated_runtime_race",
    "message": "--isolated cannot be combined with --test-type androidInstrumented without --device <serial>"
  }]
}
```

Applies to `parallel` only. Detected at parse time (no gradle invocation).

## Why it exists

`--isolated` solves **configuration cache** races (gradle's local model). It doesn't solve **runtime** races on shared OS-level resources:

- ADB serial ownership: a single device serial can't host two concurrent test runs.
- iOS simulator booting: `xcrun simctl boot <udid>` is process-global.
- `--test-type all`: dispatches every leg sequentially; combining with another concurrent `kmp-test` would still serialise the legs through gradle.

The orchestrator picks the safer default — exit 2 + tell the user — over silently sharing the resource and producing flaky / corrupt results.

## Root causes

1. **`--isolated --test-type androidInstrumented` without `--device`**: ADB serial isn't pinned, so two isolated runs might race for the same device.
2. **`--isolated --test-type ios`**: iOS simulator is process-global; can't isolate.
3. **`--isolated --test-type all`**: the orchestrator dispatches every leg, including instrumented + iOS. Catches the same shared-resource problem.
4. **`--isolated` paired with `parallel --test-type androidInstrumented` even with `--device <serial>` — false positive**: this combination IS safe (the serial pins the device per run) but the v0.9 detector was conservative. Recent versions allow it; if you hit this, verify your `kmp-test` version.

## Recovery path

For `androidInstrumented`:

1. Pass `--device <serial>` to pin a specific ADB device for the isolated run. Each concurrent run uses a different device.
2. Or drop `--isolated` if you only need configuration-cache isolation in a single-leg dispatch.

For `ios`:

1. Drop `--isolated` and rely on gradle's daemon serialisation for iOS legs.
2. Or use separate project directories for concurrent runs (each agent has its own `worktree`).

For `--test-type all`:

1. Split the dispatch: run `--test-type androidUnit` isolated, then `--test-type androidInstrumented --device <serial>` separately.

## Recovery commands

```bash
# androidInstrumented with explicit device pin
kmp-test parallel --test-type androidInstrumented --device <DEVICE_SERIAL> --isolated --json

# Drop --isolated for ios
kmp-test parallel --test-type ios --json

# Split the dispatch instead of --test-type all
kmp-test parallel --test-type androidUnit --isolated --json
kmp-test parallel --test-type androidInstrumented --device emulator-5554 --isolated --json
```

## AGP / JDK quirks

- **Single-emulator hosts**: even with `--device <serial>`, a single emulator can only host one connected test run at a time. AGP serialises gradle invocations targeting the same device. `--isolated --device` is correct architecturally but may not give concurrent throughput on single-emulator hosts.
- **iOS simulator multi-instance** (Xcode 15+): newer Xcode supports multiple simulator instances; but `kmp-test` doesn't orchestrate that. If the project needs concurrent iOS testing, run each agent in a separate working tree with its own simulator.
- **Cascading-isolation in `kmp-test`**: `--isolated` doesn't interact with `--auto-retry` (the latter is per-task retry; the former is per-run cache-dir). Both can be set, but `isolated_runtime_race` may fire if `--auto-retry` is combined with `--test-type androidInstrumented` without `--device`.

## See also

- [`../cli/envelope-schema.md#errors-discriminated-codes`](../cli/envelope-schema.md#errors-discriminated-codes) — full code table
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — exit-code → code mapping
- [`overview.md`](overview.md) — troubleshooting hub
- `docs/concurrency.md` (source repo) — Tier 1/2/3 isolation model
- [`../workflows/unit-tests.md`](../workflows/unit-tests.md) — `--isolated` usage in the `parallel` workflow

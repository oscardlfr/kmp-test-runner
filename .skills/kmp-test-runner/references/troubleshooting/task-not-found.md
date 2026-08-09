# `task_not_found` — gradle task class missing on the requested module

The orchestrator dispatched a gradle task that the project doesn't register. Usually means the relevant plugin isn't applied (or doesn't expose the task name the orchestrator probed for under the current AGP / KMP version).

## Symptom

```json
{
  "exit_code": 3,
  "errors": [{
    "code": "task_not_found",
    "message": "Cannot locate tasks that match ':feature:auth:connectedDebugAndroidTest'"
  }]
}
```

Applies to every subcommand. Most common with `parallel --test-type androidInstrumented`, `android`, and `coverage` (when `--coverage-tool` forces a plugin not applied).

## Root causes

1. **KMP `androidLibrary { }` DSL on AGP 9+** doesn't register `connectedDebugAndroidTest` — neither `connectedDebugAndroidTest` nor `connectedAndroidTest`. The KMP-native task is `androidConnectedCheck` instead. Most common cause on modern KMP projects.
2. **Wrong subcommand for the project shape**: `kmp-test android` on a JVM-only project → `connectedAndroidTest` doesn't exist anywhere. Recovery: `kmp-test parallel` (auto-detects `androidUnit`).
3. **Forced `--coverage-tool jacoco` on a Kover-only module**: `:core:network` applies Kover, the user passed `--coverage-tool jacoco`, the orchestrator dispatches `jacocoTestReport` → not registered. Recovery: `--coverage-tool auto` (or `kover`).
4. **AGP version downgrade**: a module's `build.gradle.kts` references an AGP plugin version that's been removed. The plugin's task list disappears with it.
5. **Stale project model cache**: `lib/project/cache.js` content-hashes 3 files (`settings.gradle.kts`, root `build.gradle.kts`, root `gradle.properties`). When a module's `build.gradle.kts` changes but those three don't, the cache may serve stale `test_tasks` entries. Recovery: pass `--no-cache` (on `describe`) or delete `.kmp-test-runner/cache/model-*.json`.

## Recovery path

1. **Identify the missing task**: read the `message` field — it names the specific task gradle couldn't locate.
2. **Check the project model**: `kmp-test describe --json` (no filter) and find the affected module in `modules[]` by its exact `name`, then inspect its `test_tasks`. (Don't pass the module name as `--module-filter` — describe's filter is an unanchored regular expression, so a bare name like `:foo` would also match `:fooApp`.) If the `device` / `unit` / `web` field is null for the type that errored, the orchestrator picked a default that doesn't apply.
3. **For KMP `androidLibrary { }` modules**: pass `--device-task androidConnectedCheck` to force the KMP-native task name. Works on `parallel --test-type androidInstrumented` and `android`.
4. **For coverage-tool mismatches**: switch to `--coverage-tool auto`.
5. **For stale cache**: `kmp-test describe --no-cache --json` to force a fresh probe.
6. **For genuine AGP / plugin issues**: open the module's `build.gradle.kts`; verify the plugin block applies what the task name implies. Sometimes the plugin is conditionally applied via `if (somePredicate)` — the orchestrator can't see that.

## Recovery commands

```bash
# Enumerate test tasks per module (fresh probe)
kmp-test describe --no-cache --json | jq '.describe.modules[] | { name, test_tasks }'

# Force the KMP-native task name on instrumented dispatch
kmp-test parallel --test-type androidInstrumented --device-task androidConnectedCheck

# Switch to auto coverage detection
kmp-test coverage --coverage-tool auto

# Clear the project model cache
rm -rf .kmp-test-runner/cache/
```

## AGP / JDK quirks

- **AGP 9 + KMP `androidLibrary { }`**: removed the legacy `*Test` task surface. The orchestrator's task probe (since v0.6.x) detects this and prefers `androidConnectedCheck` — but if the project mixes new-DSL and legacy modules, the probe can pick the wrong default. `--device-task` is the override.
- **Gradle 9 deprecation warnings**: a module may still register the task but emit deprecation warnings that escalate to errors under `--warning-mode fail`. The `task_not_found` shape is wrong here — look for `BUILD FAILED` plus a deprecation message instead.
- **Convention-plugin coverage**: `lib/project/analyze-module.js` walks `build-logic/<X>/build.gradle.kts` for `gradlePlugin { plugins { register("<key>") { ... } } }` blocks since v0.6.1. Modules that apply a coverage convention plugin inherit its tool; modules that DON'T apply such a plugin emit `task_not_found` when forced to a specific coverage tool.

## See also

- [`../cli/envelope-schema.md#errors-discriminated-codes`](../cli/envelope-schema.md#errors-discriminated-codes) — full code table
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — exit-code → code mapping
- [`overview.md`](overview.md) — troubleshooting hub
- [`no-test-modules.md`](no-test-modules.md) — the discovery-side variant (zero modules vs. wrong task name)
- [`../workflows/unit-tests.md`](../workflows/unit-tests.md) — workflow context

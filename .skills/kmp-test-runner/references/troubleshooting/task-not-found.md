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

Applies to routes that dispatch named gradle tasks, most commonly `parallel --test-type androidInstrumented`, `android`, `benchmark`, and `changed` through its delegated parallel run. The standalone `coverage` command cannot produce this error from a coverage task: it only aggregates existing XML and never executes Kover or JaCoCo report tasks.

## Root causes

1. **Custom or stale instrumented-task discovery**: KMP `androidLibrary { }` DSL on AGP 9+ uses the KMP-native `androidConnectedCheck` rather than legacy `connectedDebugAndroidTest`. The project-model probe normally detects and selects it automatically; stale cache, an unavailable probe, or a custom plugin can still leave the wrong task selected.
2. **Wrong subcommand for the project shape**: `kmp-test android` on a JVM-only project → `connectedAndroidTest` doesn't exist anywhere. Recovery: `kmp-test parallel` (auto-detects `androidUnit`).
3. **Explicit task override is wrong**: `--device-task <name>` bypasses automatic resolution. A legacy override copied from another project or AGP version can select a task the module does not register.
4. **AGP version downgrade**: a module's `build.gradle.kts` references an AGP plugin version that's been removed. The plugin's task list disappears with it.
5. **Stale project model cache**: `lib/project/cache.js` content-hashes 3 files (`settings.gradle.kts`, root `build.gradle.kts`, root `gradle.properties`). When a module's `build.gradle.kts` changes but those three don't, the cache may serve stale `test_tasks` entries. Recovery: pass `--no-cache` (on `describe`) or delete `.kmp-test-runner/cache/model-*.json`.

## Recovery path

1. **Identify the missing task**: read the `message` field — it names the specific task gradle couldn't locate.
2. **Check the project model**: `kmp-test describe --json` (no filter) and find the affected module in `modules[]` by its exact `name`, then inspect its `test_tasks`. (Don't pass the module name as `--module-filter` — describe's filter is an unanchored regular expression, so a bare name like `:foo` would also match `:fooApp`.) If the `device` / `unit` / `web` field is null for the type that errored, the orchestrator picked a default that doesn't apply.
3. **For KMP `androidLibrary { }` modules**: first rely on the fresh probe, which should select `androidConnectedCheck`. Only if discovery is unavailable or wrong, pass `--device-task androidConnectedCheck` as an explicit override. It works on `parallel --test-type androidInstrumented` and `android`.
4. **For genuine AGP / plugin issues**: open the module's `build.gradle.kts`; verify the plugin block applies what the task name implies. Sometimes the plugin is conditionally applied via `if (somePredicate)` — the orchestrator can't see that.
5. **For missing coverage XML**: do not diagnose `task_not_found` from `kmp-test coverage`. That command only reads XML; run `kmp-test parallel` (or the project's report task directly) to generate reports, then inspect `module_buckets.no_xml` and the coverage warning codes.

## Recovery commands

```bash
# Enumerate test tasks per module (fresh probe)
kmp-test describe --no-cache --json | jq '.describe.modules[] | { name, test_tasks }'

# Override only if the fresh probe still selected the wrong task
kmp-test parallel --test-type androidInstrumented --device-task androidConnectedCheck

# Aggregate existing coverage XML (this does not run report tasks)
kmp-test coverage --coverage-tool auto --json
```

## AGP / JDK quirks

- **AGP 9 + KMP `androidLibrary { }`**: uses a different instrumented task surface. The orchestrator's task probe detects this and prefers `androidConnectedCheck`; `--device-task` is an escape-hatch override, not the normal setup step.
- **Gradle 9 deprecation warnings**: a module may still register the task but emit deprecation warnings that escalate to errors under `--warning-mode fail`. The `task_not_found` shape is wrong here — look for `BUILD FAILED` plus a deprecation message instead.
- **Coverage is aggregation-only in this subcommand**: `kmp-test coverage` never dispatches `koverXmlReport`, `koverHtmlReport`, or `jacocoTestReport`, so forcing a coverage tool changes XML discovery paths rather than creating a task-not-found failure.

## See also

- [`../cli/envelope-schema.md#errors-discriminated-codes`](../cli/envelope-schema.md#errors-discriminated-codes) — full code table
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — exit-code → code mapping
- [`overview.md`](overview.md) — troubleshooting hub
- [`no-test-modules.md`](no-test-modules.md) — the discovery-side variant (zero modules vs. wrong task name)
- [`../workflows/unit-tests.md`](../workflows/unit-tests.md) — workflow context

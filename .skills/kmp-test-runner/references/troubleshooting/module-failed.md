# `module_failed` — a gradle task failed on a specific module

A module's test task exited non-zero. The `setup_failed` key splits "tests ran and one failed" from "compile / setup failed before any test ran": it is `true` only for the second case and absent in the first (it is never `false`).

## Symptom

Test-failure shape (no `setup_failed` key):

```json
{
  "exit_code": 1,
  "errors": [{
    "code": "module_failed",
    "module": "feature:auth:impl",
    "task": ":feature:auth:impl:testDebugUnitTest",
    "message": "[FAIL] feature:auth:impl"
  }],
  "modules": [{
    "name": "feature:auth:impl",
    "test_failures": [
      { "test": "com.example.AuthRepositoryTest.fetchUserHandlesTimeout", "cause": "expected:<200> but was:<504>", "type": "java.lang.AssertionError" }
    ]
  }]
}
```

Setup-failure shape (`setup_failed: true`):

```json
{
  "exit_code": 1,
  "errors": [{
    "code": "module_failed",
    "module": "feature:auth:impl",
    "task": ":feature:auth:impl:testDebugUnitTest",
    "message": "[FAIL] feature:auth:impl",
    "setup_failed": true
  }],
  "modules": [{
    "name": "feature:auth:impl"
  }]
}
```

(`modules[]` entries are abbreviated; the setup-failure entry has no `test_failures` key.) In both shapes `message` is only `[FAIL] <module>` and `task` is the dispatched **test** task, not the compile task that failed: the compiler message is not part of the envelope.

`setup_failed` is emitted by `parallel` and `changed` (which copies its delegate). `kmp-test android` also emits `module_failed`, without the key.

## `setup_failed` discriminator

| `setup_failed` | Meaning | Where to look |
|----------------|---------|---------------|
| absent | Tests ran, at least one failed. JUnit XML evidence exists. | `modules[<n>].test_failures[]` carries `{ test, cause, type }`. The agent should surface failing test names verbatim. |
| `true` | The task failed and no JUnit XML testcase evidence was found: compilation, dependency resolution, configuration, or runner setup may have failed. | First check `errors[].compile_failures[]` on the compiler task's owning module; each diagnostic contains file, line, optional column, message, and language. `parallel.legs[].compile_failures[]` retains all compiler failures on the leg. If those arrays are absent, inspect Gradle output for a non-compiler setup cause. |

The key was added in v0.9.0 (schema:2). Pre-v0.9, agents couldn't tell whether `module_failed` meant "test broke" or "couldn't even build".

## Capture artifacts (instrumented + `--capture-on-fail`)

When the failing task is an instrumented run — `kmp-test android` **or** `parallel --test-type androidInstrumented` — launched with `--capture-on-fail`, the `module_failed` entry additionally carries `screenshot_file` / `ui_hierarchy_file` (paths under `.kmp-test-runner/logs/android/<runId>/`, namespaced per module) plus `capture_error` when adb couldn't oblige:

```json
{
  "code": "module_failed",
  "module": ":feature:home",
  "screenshot_file": ".kmp-test-runner/logs/android/<runId>/feature_home_screenshot.png",
  "ui_hierarchy_file": ".kmp-test-runner/logs/android/<runId>/feature_home_ui-hierarchy.xml"
}
```

Surface these to the user — the screenshot + view hierarchy are the fastest triage signal for a Compose UI / Espresso failure. Capture is **post-hoc** (adb runs after the task ends, so it reflects the device state at task-end — highest value for crashes / ANRs / hangs) and **best-effort**: it never changes the exit code, and a capture that can't run only sets `capture_error`.

## Root causes

When `setup_failed` is absent (tests ran, failed):

1. **Real test failure** — surface the test name + cause to the user. They wrote the test; they fix it.
2. **Flaky tests** — non-deterministic timing, ordering, or external dependency. Recovery: re-run; if it passes intermittently, file a flake fix at the test level. `--auto-retry` only retries instrumented tasks at runtime, not unit tests.
3. **Test environment drift** — local clock vs. CI clock, locale, timezone. Surface to the user; not a kmp-test bug.

For `setup_failed: true` (no test ran):

1. **Compilation failure** — typo in test code or deleted production code. A recognized compiler failure names the Gradle compile task and source diagnostics in `compile_failures[]`; it suppresses cascade retry. Use the diagnostic location to inspect the source change.
2. **Missing test dependency** — `commonTest` imports a library not in `dependencies { commonTestImplementation(...) }`. Recovery: add the dependency.
3. **Configuration-time exception** — a `tasks.named("...") { ... }` block throws during configuration (not execution). Often AGP / KMP version mismatch.
4. **OutOfMemoryError during configuration** — common on monorepos with many modules. Recovery: bump `gradle.properties` `org.gradle.jvmargs=-Xmx4g` or higher. `--fresh-daemon` may help when a stale daemon accumulates heap pressure.
5. **Gradle plugin conflict** — two plugins both register the same task name. The first applied wins; the second emits a configuration error. Recovery: read the gradle error block.

## Recovery path

When `setup_failed` is absent:

1. Surface `modules[].test_failures[]` entries verbatim to the user. `test` is `Class.method`, `cause` is the assertion / exception message.
2. If a test failure type indicates flakiness (`SocketTimeoutException`, ordering issue), recommend a single retry: re-run `kmp-test parallel --module-filter "<failed-module>"`.
3. Do NOT mark the run successful — the user owns fixing the test.

For `setup_failed: true`:

1. Check `errors[].compile_failures[]` and, for `parallel`, `parallel.legs[].compile_failures[]`. A leg may contain an independent JUnit failure in another module; do not label that test failure as compilation.
2. If no compiler diagnostic is present, inspect Gradle output and distinguish dependency resolution, configuration, and runtime setup errors. Re-run a specific Gradle task only when the captured evidence is insufficient.
3. For compile errors: the user (or the agent) needs to read the production code change; the test file may not be the locus of the bug.
4. For configuration errors: try `kmp-test parallel --gradle-args "--no-configuration-cache"` to bypass a stale config cache. Try `--fresh-daemon` for daemon-state issues.
5. For OOM: bump JVM args in `gradle.properties`.

## Recovery commands

```bash
# Re-run just the failed module with verbose gradle output
kmp-test parallel --module-filter ":feature:auth:impl" --gradle-args "--info --stacktrace" --json

# Fallback when the envelope has no compiler diagnostic: re-run the named compile task
./gradlew :feature:auth:impl:compileDebugUnitTestKotlin --console=plain

# Bypass configuration cache (common setup-failure recovery)
kmp-test parallel --gradle-args "--no-configuration-cache" --json

# Fresh daemon (kills stale daemons that hold corrupt state)
kmp-test parallel --fresh-daemon --json

# Increase heap for configuration-phase OOM
# (edit gradle.properties: org.gradle.jvmargs=-Xmx6g)
```

## AGP / JDK quirks

- **KMP + AGP 9** sometimes throws `IncompatibleClassChangeError` during configuration when older plugins ship pre-AGP-9 bytecode. Surfaces as `setup_failed: true`. Recovery: bump the offending plugin to its AGP-9-compatible version.
- **Hilt + AGP 9 KSP transition**: Hilt's KAPT-era processor occasionally fails configuration on AGP 9 projects. Moving to Hilt's KSP processor fixes it.
- **Compose Multiplatform Resources**: generating Compose Resources at configuration time can OOM small heap sizes; bump `org.gradle.jvmargs` if the affected modules use heavy resource generation.

## See also

- [`../cli/envelope-schema.md#modules-shape`](../cli/envelope-schema.md#modules-shape) — `modules[].test_failures[]` structure
- [`../cli/envelope-schema.md#errors-discriminated-codes`](../cli/envelope-schema.md#errors-discriminated-codes) — full code table
- [`overview.md`](overview.md) — troubleshooting hub
- [`task-not-found.md`](task-not-found.md) — distinct code for "task doesn't exist" (vs "task ran and failed")
- [`unsupported-class-version.md`](unsupported-class-version.md) — common cause of `setup_failed:true` on benchmark modules

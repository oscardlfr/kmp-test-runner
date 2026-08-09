# `flavor_unused` — `--flavor` passed but no module declares matching `productFlavors {}`

The user supplied `--flavor <name>` but the orchestrator found **no flavored module** on the leg — neither a static `productFlavors {}` declaration nor flavor names recovered from the `gradlew tasks --all` probe. Flavors applied by a build-logic convention plugin ARE now detected (via the probe), so a valid `--flavor` on a convention-flavor project no longer false-fails. Promoted from warning to error in v0.9 OBS-7 (pre-v0.9 was a soft warning + exit 0, which CI gates routinely missed).

## Symptom

```json
{
  "exit_code": 2,
  "errors": [{
    "code": "flavor_unused",
    "message": "Flavor 'staging' not declared by any module's productFlavors {}"
  }]
}
```

Applies to `parallel --test-type androidUnit` / `androidInstrumented` / `--test-type all` and `android`. The `coverage` subcommand accepts `--flavor` but does not raise this error (it only re-aggregates leftover reports). Not applicable to `benchmark` / `changed`.

> **Related — no `--flavor` on a flavored project is NOT an error.** When a project IS flavored and you omit `--flavor`, the unit / instrumented leg dispatches the flavor-agnostic umbrella task (`:module:test` / `:module:connectedAndroidTest`, which run *every* flavor) and emits a non-fatal `flavor_defaulted_umbrella` warning (exit 0) listing the candidate flavors. Pass `--flavor <name>` to target one flavor (faster, single-variant coverage).

## Root causes

1. **Typo in flavor name**: `--flavor stagging` (extra `g`) instead of `--flavor staging`. AGP names are case-sensitive.
2. **Flavor declared in app module only, but `--module-filter` excludes the app**: the orchestrator can't see the flavor on filtered-in library modules. AGP's flavor weaving requires the consuming module to also declare it.
3. **Flavor declared at a parent `productFlavors {}` block but not bound to a dimension**: AGP requires `flavorDimensions += "tier"` and `productFlavors { create("staging") { dimension = "tier" } }`. Half-configured flavors don't register.
4. **Recent `productFlavors {}` removal**: someone deleted the flavor declaration. CI hasn't caught up to the new config.
5. **KMP-Android composite without flavor support**: the new `androidLibrary { }` DSL (AGP 9+) has limited flavor surface — some flavor configurations don't propagate. Confirm via `./gradlew :<module>:tasks --all | grep <flavor>`.

## Recovery path

1. **Confirm flavor names**: open the app / library `build.gradle.kts`, find `productFlavors { ... }`, list the declared flavors verbatim.
2. **Confirm module-filter compatibility**: `kmp-test describe --json` (no filter) to see every module the orchestrator considers, then check whether the flavor-bearing module is excluded by your `parallel`/`android` `--module-filter` glob. Don't pass that same glob to `describe` — its own `--module-filter` is a separate, real regular expression, not a glob; if you want to narrow `describe`'s own output, write an explicit regex for it instead. If the flavor-bearing module is excluded from the original command, broaden its glob.
3. **Verify dimension binding**: every flavor needs a `dimension =` assignment. Check `flavorDimensions += "<dim>"` is at the same level.
4. **Try without `--flavor`**: confirm the workflow runs without the flavor scope. If it does, the AGP config is the locus.

## Recovery commands

```bash
# Find every productFlavors declaration in the project
grep -rn "productFlavors" --include="*.gradle.kts" --include="*.gradle"

# Enumerate AGP tasks that include the flavor name (verifies the flavor IS bound)
./gradlew :<module>:tasks --all | grep -i "<flavor>"

# Re-run without --flavor to isolate
kmp-test parallel --test-type androidInstrumented --json

# Use --device-task to bypass flavor resolution entirely for KMP modules
kmp-test parallel --test-type androidInstrumented --device-task androidConnectedCheck --json
```

## AGP / JDK quirks

- **AGP 9 + KMP `androidLibrary { }`**: flavor surface is limited; `connected${Cap}${Variant}AndroidTest` task names may not exist for arbitrary flavor / variant combinations. Use `--device-task` to force a specific task name.
- **Flavor + variant interaction**: `--flavor staging --variant release` composes to `connectedStagingReleaseAndroidTest`. If only `connectedStagingDebugAndroidTest` exists, AGP errors at task resolution. Recovery: pass `--variant debug` (or `--variant all` to dispatch both).
- **Multi-dimension flavors**: `productFlavors { staging { dimension = "tier" } free { dimension = "feature" } }` requires AGP to compose two flavors in the task name (`connectedStagingFreeReleaseAndroidTest`). `--flavor` accepts only one — the second dimension's default flavor is used. Override via `--device-task` if needed.

## See also

- [`../cli/envelope-schema.md#errors-discriminated-codes`](../cli/envelope-schema.md#errors-discriminated-codes) — full code table
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — exit-code → code mapping
- [`overview.md`](overview.md) — troubleshooting hub
- [`task-not-found.md`](task-not-found.md) — sibling code when the resolved task name doesn't exist (often pairs with flavor issues)
- [`../workflows/unit-tests.md`](../workflows/unit-tests.md) — `parallel` workflow with `--test-type androidInstrumented`

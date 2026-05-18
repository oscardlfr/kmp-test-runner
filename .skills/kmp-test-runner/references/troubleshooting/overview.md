# Troubleshooting hub

Branch on `errors[].code` from the JSON envelope. Each linked file (when populated) contains root-cause analysis, recovery steps, and AGP/JDK-specific quirks.

| `errors[].code` | Troubleshooting doc | Status |
|------------------|---------------------|--------|
| `no_test_modules` | [`no-test-modules.md`](no-test-modules.md) | **shipped (v0.10 #4 PR 2)** |
| `task_not_found` | [`task-not-found.md`](task-not-found.md) | **shipped (v0.10 #4 PR 2)** |
| `module_failed` (incl. `setup_failed:true`) | [`module-failed.md`](module-failed.md) | **shipped (v0.10 #4 PR 2)** |
| `instrumented_setup_failed` | [`instrumented-setup-failed/with-android-cli.md`](instrumented-setup-failed/with-android-cli.md) *or* [`instrumented-setup-failed/without-android-cli.md`](instrumented-setup-failed/without-android-cli.md) | **shipped (v0.10 #4 PR 3)** |
| `unsupported_class_version` | [`unsupported-class-version.md`](unsupported-class-version.md) | **shipped (v0.10 #4 PR 2)** |
| `flavor_unused` | [`flavor-unused.md`](flavor-unused.md) | **shipped (v0.10 #4 PR 2)** |
| `isolated_runtime_race` | [`isolated-runtime-race.md`](isolated-runtime-race.md) | **shipped (v0.10 #4 PR 2)** |
| `coverage_threshold_exceeded` | [`coverage-threshold-exceeded.md`](coverage-threshold-exceeded.md) | **shipped (v0.10 #4 PR 2)** |
| `lock_held` | [`lock-held.md`](lock-held.md) | **shipped (v0.10 #4 PR 3.4)** |
| `no_gradlew` / `missing_shell` | `prerequisites.md` | follow-up release |
| `invalid_*` | `invalid-args.md` | follow-up release |
| `no_summary` (soft) | [`no-summary.md`](no-summary.md) | **shipped (v0.10 #4 PR 2)** |
| `no_changed_modules` (soft) | [`no-changed-modules.md`](no-changed-modules.md) | **shipped (v0.10 #4 PR 2)** |

For unrecognized codes, surface the full `errors[].message` and `kmp-test doctor` output to the user verbatim.

## See also

- [`../cli/envelope-schema.md`](../cli/envelope-schema.md#errors-discriminated-codes) — discriminated-code table with extra fields (`caused_by_filter`, `setup_failed`)
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — `errors[].code` → `exit_code` mapping

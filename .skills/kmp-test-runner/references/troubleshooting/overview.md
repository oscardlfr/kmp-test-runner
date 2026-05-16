# Troubleshooting hub

Branch on `errors[].code` from the JSON envelope. Each linked file (when populated) contains root-cause analysis, recovery steps, and AGP/JDK-specific quirks.

| `errors[].code` | Troubleshooting doc | Status |
|------------------|---------------------|--------|
| `no_test_modules` | `no-test-modules.md` | follow-up release |
| `task_not_found` | `task-not-found.md` | follow-up release |
| `module_failed` (incl. `setup_failed:true`) | `module-failed.md` | follow-up release |
| `instrumented_setup_failed` | `instrumented-setup-failed/with-android-cli.md` *or* `instrumented-setup-failed/without-android-cli.md` | follow-up release (dual branch) |
| `unsupported_class_version` | `unsupported-class-version.md` | follow-up release |
| `flavor_unused` | `flavor-unused.md` | follow-up release |
| `isolated_runtime_race` | `isolated-runtime-race.md` | follow-up release |
| `coverage_threshold_exceeded` | `coverage-threshold-exceeded.md` | follow-up release |
| `lock_held` | `lock-held.md` | follow-up release |
| `no_gradlew` / `missing_shell` | `prerequisites.md` | follow-up release |
| `invalid_*` | `invalid-args.md` | follow-up release |
| `no_summary` (soft) | `no-summary.md` | follow-up release |
| `no_changed_modules` (soft) | `no-changed-modules.md` | follow-up release |

For unrecognized codes, surface the full `errors[].message` and `kmp-test doctor` output to the user verbatim.

## See also

- [`../cli/envelope-schema.md`](../cli/envelope-schema.md#errors-discriminated-codes) — discriminated-code table with extra fields (`caused_by_filter`, `setup_failed`)
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — `errors[].code` → `exit_code` mapping

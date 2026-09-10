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
| `coverage_budget_without_coverage` / `coverage_data_unavailable` | [`coverage-threshold-exceeded.md`](coverage-threshold-exceeded.md) | covered: contradictory configuration vs unavailable fail-closed gate data |
| `lock_held` | [`lock-held.md`](lock-held.md) | **shipped (v0.10 #4 PR 3.4)** |
| `lock_write_error` | [`lock-held.md`](lock-held.md) | lockfile could not be written; exit 3 |
| `jdk_mismatch` | [`unsupported-class-version.md`](unsupported-class-version.md) | pre-dispatch JDK gate; exit 3 unless explicitly ignored |
| `platform_unsupported` | [`../workflows/unit-tests.md`](../workflows/unit-tests.md) | Apple test type requested off macOS; exit 3 |
| `gradle_timeout` / warning `partial_timeout` | [`../cli/exit-codes.md`](../cli/exit-codes.md) | fatal except graded benchmark partial timeout |
| `no_gradlew` / `missing_shell` | `prerequisites.md` | follow-up release |
| `invalid_*` | `invalid-args.md` | follow-up release |
| `unknown_flag` | [`../cli/flags-reference.md`](../cli/flags-reference.md) | unsupported or wrong-subcommand flag; exit 2 |
| `no_summary` (soft) | [`no-summary.md`](no-summary.md) | **shipped (v0.10 #4 PR 2)** |
| `no_changed_modules` (soft) | [`no-changed-modules.md`](no-changed-modules.md) | **shipped (v0.10 #4 PR 2)** |

For unrecognized codes, surface the full `errors[].message` and `kmp-test doctor` output to the user verbatim.

## See also

- [`../cli/envelope-schema.md`](../cli/envelope-schema.md#errors-discriminated-codes) — discriminated-code table with extra fields (`caused_by_filter`, `setup_failed`)
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — `errors[].code` → `exit_code` mapping

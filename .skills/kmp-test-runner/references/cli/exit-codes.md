# Exit-code reference

The `kmp-test` CLI uses 4 semantic exit codes. Agents should branch on `envelope.exit_code` (in JSON mode) or the shell `$?` (in plain-text mode).

| Code | Constant | Meaning |
|------|----------|---------|
| `0` | `EXIT.SUCCESS` | All tests passed. The dispatch ran without failure. |
| `1` | `EXIT.TEST_FAIL` | The dispatch ran, but at least one test failed OR a hard `errors[]` entry promoted via WS-5. |
| `2` | `EXIT.CONFIG_ERROR` | Bad CLI usage — unknown subcommand, missing required argument, invalid flag value, `unknown_flag`, `flavor_unused`, `isolated_runtime_race`, `coverage_budget_without_coverage`, `describe`'s `no_project`, or `no_test_modules` with `caused_by_filter:true`. |
| `3` | `EXIT.ENV_ERROR` | Environment problem — missing `gradlew` / JDK / `pwsh` / `bash`; `jdk_mismatch`, `platform_unsupported`, `lock_write_error`, `coverage_data_unavailable`, `task_not_found`, `unsupported_class_version`, instrumented-device codes, `lock_held`, `gradle_timeout`, or `no_test_modules` with `caused_by_filter:false`. |

Exit codes `124+` are reserved for OS-level signals; the orchestrator never emits them directly.

## WS-5 invariant (load-bearing)

If the JSON envelope's `errors[]` contains any **HARD-coded** entry, the `exit_code` MUST be non-zero. The CLI auto-promotes `0 → 1 (TEST_FAIL)` when this invariant would otherwise be violated.

Soft codes (`no_summary`, `no_changed_modules`) do NOT trigger promotion — they represent legitimate exit-0 outcomes with structured signal.

`gradle_timeout` is conditional, not globally soft. It is an environment error (`exit 3`) whenever
the timeout determines the run result, including every parallel timeout, a benchmark where no
module passed, or any benchmark invoked with `--strict-timeouts`. The sole exit-0 exception is a
graded benchmark run where at least one module passed and strict timeouts are disabled. That
envelope retains the per-module `gradle_timeout` entries for observability and adds the non-fatal
`warnings[].code: "partial_timeout"` aggregate.

This guarantee was introduced post-v0.7.x. Before it, agents reading `errors.length > 0` while the process exited 0 received false positives on "passing" runs.

## Agent decision flowchart

```
exit_code == 0 && errors[] empty
    → green run, report success
exit_code == 0 && errors[] has only SOFT codes (no_summary / no_changed_modules)
    → green run with soft warnings; surface the message to the user but don't escalate
exit_code == 0 && subcommand == benchmark && warnings[] contains partial_timeout
    → graded partial success; report passed and timed-out module counts, and mention that
      --strict-timeouts makes the same timeout fatal
exit_code == 1
    → tests failed OR WS-5 promoted; drill into modules[].test_failures[] for failing
      test names, and inspect errors[] for module_failed entries (especially
      setup_failed:true for compile/setup failures with no XML evidence)
exit_code == 2
    → CLI usage / config error; re-read --help, check errors[].code for invalid_*,
      unknown_flag, flavor_unused, isolated_runtime_race, coverage_budget_without_coverage,
      or no_test_modules + caused_by_filter:true
exit_code == 3
    → environment error; run `kmp-test doctor` to localize the cause
      (missing gradlew, JDK toolchain mismatch, unsupported host, ADB device problem,
      unwritable lockfile, unavailable gated coverage data, timeout, etc.)
```

## Mapping `errors[].code` to `exit_code`

See [`envelope-schema.md`](envelope-schema.md#errors-discriminated-codes) for the full discriminated-code → exit-code table.

## See also

- [`envelope-schema.md`](envelope-schema.md) — full JSON envelope contract
- [`flags-reference.md`](flags-reference.md) — CLI flag reference (all subcommands + global options)

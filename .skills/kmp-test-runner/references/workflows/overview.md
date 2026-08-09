# Workflows hub

Pick the workflow that matches the user's intent. Each linked file (when populated) contains step-by-step instructions, common flags for that workflow, and edge cases.

| User intent | Subcommand | Workflow doc | Status |
|-------------|-----------|--------------|--------|
| Unit tests | `kmp-test parallel` | [`unit-tests.md`](unit-tests.md) | **shipped (v0.10 #4 PR 2)** |
| Coverage aggregation | `kmp-test coverage` | [`coverage.md`](coverage.md) | **shipped (v0.10 #4 PR 2)** |
| Benchmarks | `kmp-test benchmark` | [`benchmarks.md`](benchmarks.md) | **shipped (v0.10 #4 PR 2)** |
| Instrumented tests | `kmp-test android` | [`instrumented/with-android-cli.md`](instrumented/with-android-cli.md) *or* [`instrumented/without-android-cli.md`](instrumented/without-android-cli.md) | **shipped (v0.10 #4 PR 3)** |
| Changed-only tests | `kmp-test changed` | [`changed.md`](changed.md) | **shipped (v0.10 #4 PR 2)** |

Branch on environment for the **instrumented** workflow only — see [`SKILL.md`](../../SKILL.md#environment-detection) "Environment detection" section. The other workflows do not branch on Android CLI presence.

Each shipped workflow doc covers: when to dispatch, full common flags (subset of [`../cli/flags-reference.md`](../cli/flags-reference.md)), behaviors únicos (cascade-retry, auto-detect chain, SKIP_* env vars, Git change-detection strategy, etc.), edge cases, an envelope-shape excerpt, and links to the relevant troubleshooting deep-dives.

## See also

- [`../cli/envelope-schema.md`](../cli/envelope-schema.md) — JSON envelope contract (used by every workflow)
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — exit-code semantics
- [`../troubleshooting/overview.md`](../troubleshooting/overview.md) — keyed by `errors[].code`

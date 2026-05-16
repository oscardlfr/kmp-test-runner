# Workflows hub

Pick the workflow that matches the user's intent. Each linked file (when populated) contains step-by-step instructions, common flags for that workflow, and edge cases.

| User intent | Subcommand | Workflow doc | Status |
|-------------|-----------|--------------|--------|
| Unit tests | `kmp-test parallel` | `unit-tests.md` | follow-up release |
| Coverage aggregation | `kmp-test coverage` | `coverage.md` | follow-up release |
| Benchmarks | `kmp-test benchmark` | `benchmarks.md` | follow-up release |
| Instrumented tests | `kmp-test android` | `instrumented/with-android-cli.md` *or* `instrumented/without-android-cli.md` | follow-up release (dual branch) |
| Changed-only tests | `kmp-test changed` | `changed.md` | follow-up release |

Branch on environment for the **instrumented** workflow only — see [`SKILL.md`](../../SKILL.md#environment-detection) "Environment detection" section. The other workflows do not branch on Android CLI presence.

> **Why this hub exists at the foundation release**: it lets `SKILL.md` cross-reference workflow docs that don't exist yet, so the navigation surface is in place when follow-up releases land the per-workflow deep-dives.

## See also

- [`../cli/envelope-schema.md`](../cli/envelope-schema.md) — JSON envelope contract (used by every workflow)
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — exit-code semantics
- [`../troubleshooting/overview.md`](../troubleshooting/overview.md) — keyed by `errors[].code`

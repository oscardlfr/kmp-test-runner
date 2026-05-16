# `no_test_modules` — gradle probe found zero modules with test tasks

The discovery phase returned an empty set. Either the user's `--module-filter` excluded everything, the `--test-type` filtered out every module, or the project genuinely has no test source sets. The `caused_by_filter` discriminator field decides which.

## Symptom

```json
{
  "exit_code": 2,
  "errors": [{
    "code": "no_test_modules",
    "caused_by_filter": true,
    "message": "No modules found matching filter: \"nonexistent-*\""
  }]
}
```

or:

```json
{
  "exit_code": 3,
  "errors": [{
    "code": "no_test_modules",
    "caused_by_filter": false,
    "message": "No modules support the requested --test-type=ios"
  }]
}
```

Applies to `parallel`, `changed`, and (rarer) `coverage`.

## `caused_by_filter` discriminator

| Value | `exit_code` | Meaning |
|-------|-------------|---------|
| `true` | `2` (CONFIG_ERROR) | User-side filter problem — wrong `--module-filter` glob, wrong `--test-type` for the project shape, `--exclude-modules` too aggressive. Recovery: adjust the filter and retry. |
| `false` | `3` (ENV_ERROR) | Project-side problem — the project actually has zero modules with test source sets for the requested type. Recovery: investigate the project; this is rarely a kmp-test bug. |

Branch on `caused_by_filter` BEFORE reading `message` — the message is human-readable and may evolve across releases.

## Root causes

1. **Filter typo** (`caused_by_filter: true`): `--module-filter "core-*"` on a project where modules are named `:core:network` (colon-prefixed, not dashed). The glob `core-*` matches `core-foo` but not `:core:network`. Recovery: try `*:core:*` or list explicit module names.
2. **`--test-type` mismatch** (`caused_by_filter: true`): requesting `--test-type ios` on a pure-Android project. No iOS modules → empty set. Recovery: omit `--test-type` (auto-detect) or pick a matching type.
3. **`--exclude-modules` too greedy** (`caused_by_filter: true`): `--exclude-modules "*"` excludes everything. Less obvious: `--exclude-modules "*-test*"` excludes both `:test-fakes` AND `:feature-tests`. Recovery: tighten the exclusion glob.
4. **Project has no test source sets** (`caused_by_filter: false`): a sample-only project, an `:api` interface-only module set, or a fresh project where tests haven't been written yet. Recovery: `kmp-test describe --json` to confirm `modules[].test_tasks` is null across the board.
5. **AGP version mismatch** (`caused_by_filter: false`, rare): the project's KMP / AGP combination doesn't register the test tasks `kmp-test` expects. Recovery: `kmp-test doctor` for AGP version; `kmp-test describe --skip-probe` to see what the static analysis found.

## Recovery path

For `caused_by_filter: true`:

1. Re-run with `kmp-test describe --json --module-filter <same-pattern>` to see which modules the filter actually matches.
2. If the resulting `modules[]` array is empty, broaden the filter (`*:core:*`, comma-separated explicit names, etc.).
3. If `modules[]` has entries but their `test_tasks` are null for the requested `--test-type`, adjust `--test-type` to match what's actually there.

For `caused_by_filter: false`:

1. Run `kmp-test describe --json` (no filter) to enumerate the full module set.
2. Inspect each module's `test_tasks` — `unit`, `device`, `web`, `ios`, `macos`.
3. If all are null, the project legitimately has no testable modules. Confirm with the user before treating this as a bug.
4. If some have test_tasks but the orchestrator's discovery missed them, file a bug with the `kmp-test describe` envelope attached.

## Recovery commands

```bash
# Preview what the filter matches
kmp-test describe --json --module-filter "<your-pattern>" | jq '.describe.modules[].name'

# Enumerate every module + its test tasks
kmp-test describe --json | jq '.describe.modules[] | { name, test_tasks }'

# List-only mode shows the same set parallel would dispatch
kmp-test parallel --list-only --json --module-filter "<your-pattern>"
```

## AGP / JDK quirks

- **KMP `androidLibrary { }` DSL (AGP 9+)** doesn't register `connectedDebugAndroidTest` — modules using the new DSL emit `task_not_found` instead of `no_test_modules` when `--test-type androidInstrumented` is requested. The `--device-task androidConnectedCheck` flag is the workaround.
- **Composite-build modules** are only discovered when `--include-shared` is set — otherwise they're silently excluded from the project's module set. If the user's working in a shared-libs composite, they likely want `--include-shared`.

## See also

- [`../cli/envelope-schema.md#errors-discriminated-codes`](../cli/envelope-schema.md#errors-discriminated-codes) — full code table
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — exit-code → code mapping
- [`overview.md`](overview.md) — troubleshooting hub
- [`../workflows/unit-tests.md`](../workflows/unit-tests.md) — `parallel` workflow where this code most commonly fires

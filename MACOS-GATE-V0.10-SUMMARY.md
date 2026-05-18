# v0.10 macOS validation gate — summary

Generated: 2026-05-18T18:14:36.500Z
Mode: `probe`
Output cells: 45
Repo HEAD: `8472176`

## v0.10 cycle notes

This file is the committed evidence for v0.10 ramp step #6 (macOS validation gate, same shape as the v0.9 step 7 closeout). The auto-generated tables below are the canonical machine output; the human commentary in this section is frozen at PR-close time and will not regenerate on subsequent gate runs.

### Phases executed

- **probe** — completed (this run). 45 cells, no gradle spawn, envelope-shape comparison vs `tests/vitest/__snapshots__/parity.test.js.snap`.
- **scoped** — NOT executed. Disk check: `/System/Volumes/Data` at 6.3 GB free (97 % used) — below the 8 GB pre-flight floor agreed for this cycle, so the run was intentionally short-circuited at probe. Probe alone is sufficient evidence for envelope-shape parity; scoped would have added real-gradle per-cell evidence on the smallest module of each project.
- **full** — out of scope (gated behind `--i-have-20gb-free`, system disk has 6.3 GB).

### DRIFT triage — `android_none_KaMPKit` (1 cell)

The single DRIFT cell shows `onlyInObserved: []` — the live envelope is a strict **subset** of the parity snapshot, never a superset. Eleven snapshot paths are missing from observation:

```
coverage.module_buckets, coverage.module_buckets.no_xml(.[]), coverage.module_buckets.parse_errored(.[]),
coverage.module_buckets.skipped_by_user(.[]), coverage.module_buckets.with_data(.[]),
errors[].code, errors[].message
```

Both groups are explainable as snapshot-richer-than-runtime, not as regressions:

1. `errors[].code` / `errors[].message` — surface only when `errors` is non-empty. The live KaMPKit `android --list-only --json` envelope produces `"errors": []`, so the `errors[]` subpaths can't manifest.
2. `coverage.module_buckets.*` — these fields are emitted by the `parallel` / `coverage` orchestrators, not by the `android` subcommand. The parity snapshot's `android --list-only` baseline appears to have been seeded with a richer shape that the actual envelope never carried.

**Verdict:** benign drift caused by an over-rich parity snapshot for the `android --list-only` cell. Independent verification: `npx vitest run tests/vitest/parity.test.js` is **64/64 PASS** on this commit, confirming that no consumer-facing contract regression exists. Filed as follow-up under the v0.10 ramp BACKLOG entry: parity snapshot refresh against live `android --list-only` envelope.

### `private-lib` skip rationale (15 cells)

`tools/macos-validation-gate.mjs` hardcodes a maintainer-private project at `$WORKSPACE/private-lib` (the L0 toolkit, kept out of public memory per the decouple rule in `CLAUDE.md`). On this Mac the path is absent by design, so the gate's built-in `projectExists()` short-circuit emits `SKIP project-absent` for each of those 15 cells (7 test-types × parallel + 7 test-types × changed + 1 android). No action needed — this is the gate's correct behavior on a workspace without the private project.

### Gate tooling change bundled in this PR

`tools/macos-validation-gate.mjs` gained a `--label <vX.Y>` flag (default `v0.9` for backward-compat). Drives the summary title (line 1) and the per-cell artifact subdirectory (`.smoke/macos-gate-<label>/`). Bundled here because the v0.9 hardcodes were the only reason this v0.10 evidence file would have shipped with the wrong header otherwise. Future v0.11+ runs invoke `--label v0.11` and re-use the script without further edits.

## Bucket counts

| Bucket | Count |
|---|---|
| PLANNED | 0 |
| PASS | 28 |
| DRIFT | 1 |
| SKIP | 16 |
| ERROR | 0 |
| TIMEOUT | 0 |
| ABSENT | 0 |
| **Total** | **45** |

## Cells

| Subcommand | Test type | Project | Bucket | Duration | Notes |
|---|---|---|---|---|---|
| parallel | all | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | common | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | androidUnit | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | androidInstrumented | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | desktop | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | ios | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | macos | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | all | private-lib | SKIP | – | project-absent |
| parallel | common | private-lib | SKIP | – | project-absent |
| parallel | androidUnit | private-lib | SKIP | – | project-absent |
| parallel | androidInstrumented | private-lib | SKIP | – | project-absent |
| parallel | desktop | private-lib | SKIP | – | project-absent |
| parallel | ios | private-lib | SKIP | – | project-absent |
| parallel | macos | private-lib | SKIP | – | project-absent |
| parallel | all | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | common | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | androidUnit | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | androidInstrumented | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | desktop | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | ios | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | macos | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | all | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | common | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | androidUnit | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | androidInstrumented | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | desktop | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | ios | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | macos | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | all | private-lib | SKIP | – | project-absent |
| changed | common | private-lib | SKIP | – | project-absent |
| changed | androidUnit | private-lib | SKIP | – | project-absent |
| changed | androidInstrumented | private-lib | SKIP | – | project-absent |
| changed | desktop | private-lib | SKIP | – | project-absent |
| changed | ios | private-lib | SKIP | – | project-absent |
| changed | macos | private-lib | SKIP | – | project-absent |
| changed | all | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | common | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | androidUnit | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | androidInstrumented | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | desktop | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | ios | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | macos | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| android | n/a | fixture | SKIP | – | no-instrumented-target |
| android | n/a | private-lib | SKIP | – | project-absent |
| android | n/a | KaMPKit | DRIFT | 0s | 11 missing, 0 unexpected paths |

## Drift detail

### android_none_KaMPKit — DRIFT

Missing from observed envelope:
```
coverage.module_buckets
coverage.module_buckets.no_xml
coverage.module_buckets.no_xml[]
coverage.module_buckets.parse_errored
coverage.module_buckets.parse_errored[]
coverage.module_buckets.skipped_by_user
coverage.module_buckets.skipped_by_user[]
coverage.module_buckets.with_data
coverage.module_buckets.with_data[]
errors[].code
errors[].message
```

## Forensic artifacts

Per-cell stdout / stderr / envelope / meta live under `.smoke/macos-gate-v0.10/`.
Filename pattern: `<subcommand>_<testType|none>_<project>.{out,err,json,meta.json}`.

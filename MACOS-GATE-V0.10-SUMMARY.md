# v0.10 macOS validation gate — summary

Generated: 2026-05-18T18:36:57.026Z
Mode: `scoped` (reclassified)
Output cells: 45
Repo HEAD: `aaa12d9`

## v0.10 cycle notes

Frozen at PR-close time; will not regenerate on subsequent gate runs. The auto-generated tables below are the canonical machine output.

### Phases executed

1. **probe** — 45 cells, no gradle spawn, envelope-shape parity vs `tests/vitest/__snapshots__/parity.test.js.snap`. Surfaced one benign DRIFT (`android_none_KaMPKit`) which the subsequent scoped phase confirmed as snapshot-richer-than-runtime, not a regression.
2. **scoped** — 45 cells, **real gradle invocations** per cell. Initial run produced 14 false-ERROR cells; bug in the gate's bucketing logic (see "Gate fixes bundled" below). After the fix landed in the same PR, `--reclassify` re-bucketed the saved envelopes against the corrected logic without re-spawning gradle. Final numbers above (15 PASS / 30 SKIP / 0 ERROR / 0 DRIFT) reflect the corrected classification on the same wet evidence.
3. **targeted wet** — 4 representative subcommands outside the gate's matrix (`doctor`, `info`, `describe`, `parallel --test-type ios`) to cover surfaces the matrix doesn't reach. Results in the "Targeted wet evidence" section below.

### Disk strategy

The original cycle hit a wall: `/System/Volumes/Data` at 6.3 GB free, below the 8 GB scoped pre-flight floor. Resolution: redirect every disk-heavy gradle path to the external `<EXT_VOL>` (167 GB free) via environment overrides:

| Env var            | Redirect target                         | What it controls                                         |
| ------------------ | --------------------------------------- | -------------------------------------------------------- |
| `KMP_TMPDIR`       | `<EXT_VOL>/.tmp`              | `/tmp/`-equivalent for CLI scratch files                  |
| `GRADLE_USER_HOME` | `<EXT_VOL>/.gradle-cache`     | Gradle daemon work dir + module caches (`~/.gradle/`)    |
| `KONAN_DATA_DIR`   | `<EXT_VOL>/.konan`            | Kotlin/Native compiler distribution + sysroot cache       |

System disk stayed at 6.3 GB throughout both targeted wet and the full scoped matrix; external grew from 33 GB → 36 GB used (3 GB of caches). The previous-cycle assumption that scoped requires ≥ 8 GB of system disk is **wrong** with the redirects in place; the floor matters only without redirects.

### Targeted wet evidence

Four wet invocations outside the gate's matrix, captured manually against `<EXT_VOL>/kmp-test-workspace/KaMPKit` with the redirects above. All exit 0.

| Subcommand                              | Exit | Duration | Evidence                                                                                                                                              |
| --------------------------------------- | ---- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kmp-test doctor`                       | 0    | < 5s     | All 9 checks OK: Node 25.9.0, bash, gradlew, JDK 21.0.11, JDK catalogue (3 installs), Android SDK env, no project config, no user config, ADB 37.0.0  |
| `kmp-test info`                         | 0    | < 5s     | Resolved JAVA_HOME, JDK catalogue, ADB version, Android SDK path                                                                                       |
| `kmp-test describe --json`              | 0    | ~2 s    | Real envelope w/ `describe.schema_version: 7`, 2 modules (`:app` android type, `:shared` kmp type), per-target test tasks (`iosSimulatorArm64Test` for `:shared`). Cached via `c5f3a4281459c00694bde7b1b19fc8de72061aa5` — model JSON read path exercised. |
| `kmp-test parallel --test-type ios --module-filter :shared` | 0 | 106 s | Real gradle invocation: `:shared:iosSimulatorArm64Test` task dispatched, BUILD SUCCESSFUL, `[PASS] shared`. Forensic dispatch chain: `kmpPartiallyResolvedDependenciesChecker → downloadKotlinNativeDistribution → skieProcessSwiftSourcesIosSimulatorArm64 → compileKotlinIosSimulatorArm64 → iosSimulatorArm64MainKlibrary → compileTestKotlinIosSimulatorArm64 → linkDebugTestIosSimulatorArm64 → iosSimulatorArm64Test`. |

### Scoped matrix highlights

- **15 PASS** — every cell that had real work executed real gradle and exited 0. The fixture's `parallel_all` cell ran cold for 1m 24s; rest were 0–20 s (gradle cache UP-TO-DATE after the first fixture pass). KaMPKit cells reused the warm cache from the targeted-wet `iosSimulatorArm64Test` invocation.
- **30 SKIP** breaks down as:
  - 15 `project-absent` for the maintainer-private `private-lib` placeholder (gate's correct degradation on workspaces without the private project)
  - 14 `benign no-op: no_changed_modules` for the `changed` subcommand against the clean PR worktree (no uncommitted modifications, so nothing to test — the CLI's intended response)
  - 1 `no-instrumented-target` for the fixture's android cell (the fixture is `androidLibrary { withHostTestBuilder }` only, no connected-device target)
- **0 ERROR, 0 DRIFT, 0 TIMEOUT** — across the wet evidence, the CLI behaved correctly on every cell that had work and gracefully no-op'd on every cell that didn't.

### Gate fixes bundled in this PR

Two `tools/macos-validation-gate.mjs` edits, both backward-compatible (vitest 1592/1592 PASS unchanged):

1. **`--label <vX.Y>` flag** (default `v0.9`). Parameterizes the summary title (line 1) and the `.smoke/macos-gate-<label>/` per-cell artifact subdirectory. Without this the v0.10 evidence file would have shipped with a "v0.9 macOS validation gate" header and overwritten v0.9's smoke artifacts in-place.

2. **`BENIGN_NO_OP_CODES` filter on scoped bucketing.** Initial scoped run produced 14 false-ERROR cells against `changed` subcommand on a clean worktree (no git diff → `errors[].code: "no_changed_modules"`). The CLI's behavior was correct (exit 0, structured no-op signal for agents); the gate's `errors.length > 0 → ERROR` classification was the bug. Fix: filter known-benign codes before failure attribution; benign-only no-ops bucket to `SKIP` (with reason), real failures still bucket to `ERROR`. Mirrored in `--reclassify` mode so the fix could be applied to existing `.smoke/macos-gate-v0.10/` envelopes without re-running gradle.

### Follow-up

- **Parity snapshot refresh** against live `android --list-only` envelope to clear the benign probe-mode DRIFT (`coverage.module_buckets.*` + `errors[].code/message` paths that appear in the snapshot but never in the runtime envelope for android-list-only).
- **Reclassify outside scoped** — `--reclassify` currently requires `--mode <non-dry>` to enter the per-cell loop. Future polish could allow `--reclassify` standalone (implicit non-dry pass-through).


## Bucket counts

| Bucket | Count |
|---|---|
| PLANNED | 0 |
| PASS | 15 |
| DRIFT | 0 |
| SKIP | 30 |
| ERROR | 0 |
| TIMEOUT | 0 |
| ABSENT | 0 |
| **Total** | **45** |

## Cells

| Subcommand | Test type | Project | Bucket | Duration | Notes |
|---|---|---|---|---|---|
| parallel | all | fixture | PASS | 1m 24s | (reclassified) wet run green (exit 0, no errors[]) |
| parallel | common | fixture | PASS | 9s | (reclassified) wet run green (exit 0, no errors[]) |
| parallel | androidUnit | fixture | PASS | 6s | (reclassified) wet run green (exit 0, no errors[]) |
| parallel | androidInstrumented | fixture | PASS | 1s | (reclassified) wet run green (exit 0, no errors[]) |
| parallel | desktop | fixture | PASS | 6s | (reclassified) wet run green (exit 0, no errors[]) |
| parallel | ios | fixture | PASS | 20s | (reclassified) wet run green (exit 0, no errors[]) |
| parallel | macos | fixture | PASS | 8s | (reclassified) wet run green (exit 0, no errors[]) |
| parallel | all | private-lib | SKIP | – | project-absent |
| parallel | common | private-lib | SKIP | – | project-absent |
| parallel | androidUnit | private-lib | SKIP | – | project-absent |
| parallel | androidInstrumented | private-lib | SKIP | – | project-absent |
| parallel | desktop | private-lib | SKIP | – | project-absent |
| parallel | ios | private-lib | SKIP | – | project-absent |
| parallel | macos | private-lib | SKIP | – | project-absent |
| parallel | all | KaMPKit | PASS | 24s | (reclassified) wet run green (exit 0, no errors[]) |
| parallel | common | KaMPKit | PASS | 0s | (reclassified) wet run green (exit 0, no errors[]) |
| parallel | androidUnit | KaMPKit | PASS | 10s | (reclassified) wet run green (exit 0, no errors[]) |
| parallel | androidInstrumented | KaMPKit | PASS | 0s | (reclassified) wet run green (exit 0, no errors[]) |
| parallel | desktop | KaMPKit | PASS | 0s | (reclassified) wet run green (exit 0, no errors[]) |
| parallel | ios | KaMPKit | PASS | 13s | (reclassified) wet run green (exit 0, no errors[]) |
| parallel | macos | KaMPKit | PASS | 0s | (reclassified) wet run green (exit 0, no errors[]) |
| changed | all | fixture | SKIP | 0s | (reclassified) benign no-op: no_changed_modules |
| changed | common | fixture | SKIP | 0s | (reclassified) benign no-op: no_changed_modules |
| changed | androidUnit | fixture | SKIP | 0s | (reclassified) benign no-op: no_changed_modules |
| changed | androidInstrumented | fixture | SKIP | 0s | (reclassified) benign no-op: no_changed_modules |
| changed | desktop | fixture | SKIP | 0s | (reclassified) benign no-op: no_changed_modules |
| changed | ios | fixture | SKIP | 0s | (reclassified) benign no-op: no_changed_modules |
| changed | macos | fixture | SKIP | 0s | (reclassified) benign no-op: no_changed_modules |
| changed | all | private-lib | SKIP | – | project-absent |
| changed | common | private-lib | SKIP | – | project-absent |
| changed | androidUnit | private-lib | SKIP | – | project-absent |
| changed | androidInstrumented | private-lib | SKIP | – | project-absent |
| changed | desktop | private-lib | SKIP | – | project-absent |
| changed | ios | private-lib | SKIP | – | project-absent |
| changed | macos | private-lib | SKIP | – | project-absent |
| changed | all | KaMPKit | SKIP | 0s | (reclassified) benign no-op: no_changed_modules |
| changed | common | KaMPKit | SKIP | 0s | (reclassified) benign no-op: no_changed_modules |
| changed | androidUnit | KaMPKit | SKIP | 0s | (reclassified) benign no-op: no_changed_modules |
| changed | androidInstrumented | KaMPKit | SKIP | 0s | (reclassified) benign no-op: no_changed_modules |
| changed | desktop | KaMPKit | SKIP | 0s | (reclassified) benign no-op: no_changed_modules |
| changed | ios | KaMPKit | SKIP | 0s | (reclassified) benign no-op: no_changed_modules |
| changed | macos | KaMPKit | SKIP | 0s | (reclassified) benign no-op: no_changed_modules |
| android | n/a | fixture | SKIP | – | no-instrumented-target |
| android | n/a | private-lib | SKIP | – | project-absent |
| android | n/a | KaMPKit | PASS | 7s | (reclassified) wet run green (exit 0, no errors[]) |

## Forensic artifacts

Per-cell stdout / stderr / envelope / meta live under `.smoke/macos-gate-v0.10/`.
Filename pattern: `<subcommand>_<testType|none>_<project>.{out,err,json,meta.json}`.

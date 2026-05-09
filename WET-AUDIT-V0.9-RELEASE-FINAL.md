# Wet-audit v0.9.0 — pre-release final validation

**Date:** 2026-05-09
**develop tip at audit start:** `867df44` (post PR #183/#184/#185 — schema_version:2 + isolated_runtime_race + 6 OBS closures)
**Branch:** wet-audit ran straight against develop; one inline-fix PR (`fix/wet-audit-adb-path-augment` → PR #186)
**Vitest:** 1257 baseline → 1261 post-fix (+4 PATH-augmentation regression tests)
**S22 Ultra:** R3CT30KAMEH (Samsung SM-S908B, Android 16) — used for instrumented cells

This file is the closure evidence for the comprehensive CLI wet-audit pass before tagging v0.9.0. Tooling: `tools/wet-audit-v0.9.mjs` (built this session) drives 65 cells across 7 real workspace projects with 5 mode bands (probe → wet-non-android → wet-android → wet → reclassify). Per-cell artifacts captured under `.smoke/wet-audit-v0.9-release/<id>.{out,err,json,meta.json}` (gitignored).

## Phase summary

| Phase | Cells | Mode | Notes |
|---|---|---|---|
| 0 — baseline | n/a | — | git fetch → develop@867df44; `npm ci`; `npm test` 1257 ✓; `node tools/sync-versions.js --check` ✓; `adb devices` shows `R3CT30KAMEH` |
| 1 — tool build | n/a | — | `tools/wet-audit-v0.9.mjs` reuses classifier from `wide-smoke-pass-10.mjs` + matrix shape from `macos-validation-gate.mjs`. Modes: `dry`/`probe`/`wet-non-android`/`wet-android`/`wet`/`reclassify`. `--skip-cached` flag added mid-pass |
| 2 — probe | 42 | probe | doctor + info + describe (cache miss + hit) + parallel `--dry-run` / `--list-only` per project. All cells exit 0, schema_version:2, envelope shape stable |
| 3 — wet non-android | 13 | wet-non-android | wet-common × 5, wet-desktop × 3, neg-filter, neg-iso-ios, neg-iso-all, coverage-only, coverage-min-missed, **wet-full-parallel** (the cell macOS gate could not run), pos-iso × 2 concurrent |
| 4 — wet android (S22) | 6 | wet-android | wet-aunit × 3, neg-iso-aint-no-device, wet-aint × 2, neg-flavor |
| 5 — fix-PR-186 | n/a | — | Surfaced 1 release-blocker (RED-orchestrator: `instrumented_setup_failed` despite live S22). Inline-fixed in `fix/wet-audit-adb-path-augment` per `feedback_no_milestone_deferral_at_pre_release.md` |
| 6 — closure | n/a | — | This file. 1 docs PR queued for develop |
| 7 — GO/NO-GO | n/a | — | **GO** — all cells in `{PASS, PASS-AS-EXPECTED, SKIP-legit, RED-repo}`. 0 RED-orchestrator. Vitest 1257 → 1261 |

## Final bucket counts

| Bucket | Count | Meaning |
|---|---|---|
| **PASS** | 52 | wet exit 0 + tests ran (or non-test cell exit 0) |
| **PASS-AS-EXPECTED** | 5 | negative-test cell hit expected error code + exit |
| **SKIP-legit** | 6 | no testcases + legit reasons (no source set, no leg target, etc.) |
| **RED-repo** | 2 | real test failures in the upstream project (not orchestrator) |
| **RED-orchestrator** | 0 | ✓ none after fix-PR-186 |
| **DRIFT** | 0 | ✓ envelope contract stable (schema_version:2 everywhere) |
| **TIMEOUT** | 0 | ✓ |
| **ABSENT** | 0 | ✓ all cells captured |
| **Total** | **65** | |

## Block A — `isolated_runtime_race` rejection (NEW path from PR #185)

The new CONFIG_ERROR discriminator added in PR #185 (lib/parallel-orchestrator.js:1400-1428) had zero prior wet coverage. Three rejection paths exercised end-to-end:

| Cell | Command | Result |
|---|---|---|
| A.1 | `parallel --isolated --test-type ios --json` | exit 2, `errors[].code='isolated_runtime_race'`, `test_type='ios'` ✓ |
| A.2 | `parallel --isolated --test-type all --json` | exit 2, `errors[].code='isolated_runtime_race'`, `test_type='all'` ✓ |
| A.3 | `parallel --isolated --test-type androidInstrumented --json` (no --device) | exit 2, `errors[].code='isolated_runtime_race'`, `test_type='androidInstrumented'` ✓ |

Rejection happens before any gradle dispatch (line 1400-1428 of `parallel-orchestrator.js`); no daemon spawned, sub-second envelope emission. Schema version 2 confirmed on all three.

## Block B — `--module-filter ":nonexistent"` (caused_by_filter discriminator from PR #185 OBS-3)

| Cell | Command | Result |
|---|---|---|
| B.1 | `parallel --module-filter ":nonexistent" --test-type common --json` | exit 2 (CONFIG_ERROR), `errors[0].code='no_test_modules'`, `errors[0].caused_by_filter:true` ✓ |

Distinguishes user-filter-miss (CONFIG_ERROR 2) from project-empty (ENV_ERROR 3) per the OBS-3 contract.

## Block C — `--flavor nonexistent` promoted to error (PR #185 OBS-7)

`flavor_unused` was promoted from `warnings[]` to `errors[]` with CONFIG_ERROR exit. Note: only emitted via `parallel --test-type androidInstrumented|all`, NOT the `android` subcommand (which forwards `--flavor` verbatim to gradle without validation). The wet-audit's initial cell shape used `kmp-test android` and was inline-corrected to use parallel.

| Cell | Command | Result |
|---|---|---|
| C.1 | `parallel --test-type androidInstrumented --flavor nonexistent --json` against DawSync | exit 2, `errors[].code='flavor_unused'`, `errors[].flavor='nonexistent'` ✓ |

## Block D — Concurrent `--isolated` cache_dir separation (positive case)

| Cell | Command | Result |
|---|---|---|
| D.1 | shared-kmp-libs `parallel --isolated --test-type common --module-filter core-result --json` (concurrent) | exit 0, 70 testcases, `isolated.cache_dir` unique per process ✓ |
| D.2 | KaMPKit `parallel --isolated --test-type common --module-filter shared --json` (concurrent) | exit 0 (SKIP-legit — no common target on KaMPKit's :shared), `isolated.cache_dir` unique ✓ |

Both processes ran concurrently; cache_dir paths confirmed distinct via meta.json. No race-condition conflict.

## Block E — wet_full_parallel (the cell macOS gate could NOT run)

The user explicitly asked for this cell — the macOS validation gate skipped `--test-type all` full-parallel because the secondary Mac's tight disk wouldn't accommodate the cumulative gradle daemon footprint. Windows host has no such constraint, so the cell ran here.

| Cell | Command | Result |
|---|---|---|
| E.1 | shared-kmp-libs `parallel --test-type all --json --timeout 1500` | exit 1 (RED-repo), 7750 testcases ran, 1 module_failed (`:benchmark-storage:androidConnectedCheck`), 5m wall time |

**Multi-leg envelope verified**: `parallel.legs[]` populated with 4 legs (common, desktop, androidUnit, androidInstrumented). Each leg's `execution.{fresh,up_to_date,from_cache,no_source,skipped_by_gradle,failed,no_evidence}` populated correctly. iOS/macOS legs absent (Windows host — correct platform-aware behavior). 135 modules in `skipped[]` for source-set absence reasons.

## Block F — Schema_version:2 sweep

| Cell | Method | Result |
|---|---|---|
| F.1 | `grep -oE '"schema_version":[^,]*' <every wet-audit envelope>` | All 65 cells emit `"schema_version":2` ✓ |

## Block G — Inline fix-PR-186 (release-blocker closed)

### Bug surfaced

`wet_aint_android_subcommand__shared-kmp-libs` (S22 instrumented `:benchmark-network` test) returned exit 3 with `errors[].code='instrumented_setup_failed'` even though `adb devices` showed `R3CT30KAMEH device` connected.

### Root cause

`maybeAugmentEnvWithAndroidSdk` (lib/android-sdk-catalogue.js) early-returned env unchanged when `local.properties` had `sdk.dir`. Gradle uses `sdk.dir` directly via SdkLocator, but the orchestrator's Node-side `defaultAdbProbe` (lib/orchestrator-utils.js) calls `spawnSync('adb', ['devices', '-l'])` from PATH. With `ANDROID_HOME` unset AND `${SDK}/platform-tools` not on PATH (common on Windows shells), the bare `adb` invocation hit ENOENT, the probe returned empty, and the orchestrator emitted `instrumented_setup_failed` despite a connected device.

### Fix (PR #186)

- `lib/android-sdk-catalogue.js`: removed early-return for `local.properties` sdk.dir; helper now reads sdk.dir, sets `ANDROID_HOME` + `ANDROID_SDK_ROOT`, and prepends `${SDK}/platform-tools` to PATH. Falls back to canonical-install-paths discovery when sdk.dir absent or invalid.
- `lib/runner.js`: also propagates `augmented.PATH` to `process.env.PATH` so transitive child-process spawns inherit it.
- `tests/vitest/android-sdk-catalogue.test.js`: +4 regression tests pinning the PATH augmentation contract; 1 modified test (sdk.dir-in-local.properties case now augments instead of no-op).

### Verification

| Cell | Pre-fix | Post-fix |
|---|---|---|
| `kmp-test android --module-filter benchmark-network` against shared-kmp-libs (no `ANDROID_HOME`, no platform-tools on PATH) | exit 3, `instrumented_setup_failed`, no testcases | exit 0, 3 testcases passed on R3CT30KAMEH ✓ |
| Vitest | 1257 | 1261 (+4 new tests, all green) |

PR: [#186](https://github.com/oscardlfr/kmp-test-runner/pull/186) (`fix/wet-audit-adb-path-augment` → develop).

## Observations (non-blocking, documented for future cycle)

### OBS-A — `modules[].test_failures[]` partial coverage on multi-failed-task envelopes

`wet_common__DawSync` returned exit 1 with 5 `errors[].code='module_failed'` entries (`core:data`, `desktopApp`, `feature:activity-log`, `feature:analytics`, `feature:sessions`) and 8282 individual testcases ran. Of those 5 failed modules, only 2 (`feature:analytics` 7 failures, `feature:sessions` 2 failures) populate `modules[].test_failures[]`. The other 3 have empty `test_failures`. Likely cause: compile-time / test-runner-setup-time failures where no JUnit XML is emitted, so the parser has nothing to attach. Contract is "best-effort": when populated, accurate; when absent, just means "couldn't parse." Worth a follow-up to either:
- Detect the no-XML case and surface a separate `setup_failed` discriminator on the affected module
- OR document the contract clearly in the README's `--json` envelope reference

Not a release-blocker — the user-visible orchestrator contract is correct (exit 1, module_failed errors[] populated, individual_total accurate).

### OBS-B — `flavor_unused` does not early-exit before gradle dispatch

`lib/parallel-orchestrator.js:1595-1614` comment states the check "runs before any gradle dispatch so we don't waste a build cycle." In practice, the error is pushed to `state.errors` but the orchestrator continues to gradle dispatch (~66s on DawSync). Final exit_code maps correctly to CONFIG_ERROR via CONFIG_CODES, but a build cycle does run. Doc-fix or implementation-fix candidate; not a release-blocker (user-visible contract is correct).

### OBS-C — Initial wet-audit cell shape used wrong subcommand for flavor_unused

The matrix initially used `kmp-test android --flavor nonexistent` to negative-test flavor_unused. That subcommand does NOT validate `--flavor` — it forwards verbatim to gradle. The validation lives in `parallel-orchestrator.js` only. Cell shape inline-corrected to `parallel --test-type androidInstrumented --flavor nonexistent`. Captured here so future audit cycles use the right shape.

### OBS-D — `defaultAdbProbe` brittle to PATH config (mitigated by PR #186)

Pre-#186: `defaultAdbProbe` relied entirely on bare `adb` from PATH. Post-#186: PATH is auto-augmented from `local.properties` sdk.dir or auto-discovered SDK. But: if user sets `ANDROID_HOME` explicitly and PATH lacks platform-tools, the helper still early-returns to respect user choice — adb probe will fail in that edge case. Defensive mitigation (always check + augment PATH when ANDROID_HOME points to a valid SDK) deferred to user judgement. Not a release-blocker; documented for future cycle.

## Comparison vs prior wet-audits

| Audit | Tip | Cells | RED-orchestrator | RED-repo | Notes |
|---|---|---|---|---|---|
| `WET-AUDIT-V0.9-FINAL.md` (Win-side, pre-PR-185) | `989f57b` | 61 | 0 | varied | F-1 envelope-exit alignment closed in PR #182 |
| `MACOS-GATE-V0.9-WET-RESULTS.md` (Mac-side) | `e581f62` | 14 | 0 | 1 (legit) | --test-type=all skipped due to disk |
| `BUGS-V0.9-WIN-AUDIT-FINAL.md` (post-PR-#175-#181) | `989f57b` | 8 bugs | 0 (after closure) | n/a | All 8 win-audit bugs CLOSED |
| `WET-AUDIT-V0.9-PART2-RESULTS.md` (pre-PR-185 surface) | `989f57b` | 38 | 0 | varied | Surfaced the 9 OBS that PR #183/#184/#185 closed |
| **This audit (`WET-AUDIT-V0.9-RELEASE-FINAL.md`)** | **`867df44`** | **65** | **0** | **2** | **+1 release-blocker fixed inline (PR #186)**; full-parallel cell run; 3 isolated_runtime_race paths covered |

## GO/NO-GO

**GO for v0.9.0 release ceremony (BACKLOG step 10).**

Criteria met per `feedback_no_milestone_deferral_at_pre_release.md`:
- All cells in `{PASS, PASS-AS-EXPECTED, SKIP-legit, RED-repo}`
- 0 unfixed RED-orchestrator
- Vitest 1257 → 1261 (full suite green post-fix)
- 1 release-blocker discovered (PATH augmentation gap) + fixed in-session per the standing rule
- 0 DRIFT — envelope contract stable across all 65 cells
- Schema_version:2 verified everywhere (PR #185 contract holds)
- New `isolated_runtime_race` rejection path validated end-to-end on 3 distinct test-types
- User-requested `wet_full_parallel` cell (the macOS gap) ran successfully on Windows: 4-leg fan-out, 7750 testcases, schema_version:2, multi-leg envelope shape correct

The 2 RED-repo findings are upstream project-side test failures (DawSync feature UI tests + shared-kmp-libs `:benchmark-storage:androidConnectedCheck`), out of scope for the v0.9.0 release.

Release ceremony unblocked. Use `v0_9_step_10_fresh_session_prompt.md` for the `release/v0.9.0-clean → main` cut.

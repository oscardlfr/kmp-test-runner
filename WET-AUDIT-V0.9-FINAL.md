# Wet audit final — `kmp-test` pre-tag v0.9.0

Generated 2026-05-08. Wallclock ~2 h on the audit Mac. All cells executed real `kmp-test` invocations against `develop` source (`node bin/kmp-test.js`, not the Homebrew-installed copy). The Samsung S22 (`R3CT30KAMEH` / `SM-S908B - 16`) was attached via USB for Part 2 instrumented cells.

This document is the WET counterpart to the earlier `MACOS-GATE-V0.9-WET-RESULTS.md` (PR #155, 2026-05-06). Together they certify v0.9.0 dispatch end-to-end across the workspace's 5 testbeds.

## Versions tested

- `kmp-test` 0.8.1 from `develop` at chore/wet-audit-v0_9-part2 (post PR #166 + PR #167 merge)
- 5 workspace projects: KaMPKit (1 module), PeopleInSpace (7), shared-kmp-libs (70 with Kover), Confetti (16), di-patterns-demo (43)
- Host: macOS Darwin 25.2, JDK 21.0.11 Homebrew, AGP 8.13.1 / 9.0.1 / 9.1.1 across projects, iOS 26.4 simulator runtime

## Disk profile

| Checkpoint | Free GB |
|---|---|
| Pre-flight | 7.1 |
| End of part 1 (B-I) | 6.1 (–1.0 GB consumed by H2 concurrent `--isolated`) |
| End of part 2 (J-L) | 5.1 (–1.0 GB consumed by di-patterns-demo build artifacts in J5) |

Stayed safely above the 500 MB STOP threshold throughout. Cleaned daemons between project switches.

## Bugs surfaced and fixed inline

Per `feedback_close_in_one_session.md` and the user's choice, every bug surfaced got fixed in the same session with a regression test and a dedicated PR. No deferrals to a follow-up.

### Bug A — `lib/project-model.js` cache no auto-invalidates on introspector change → PR #166 (merged `5932060`)

Surfaced by cell **B4** against `shared-kmp-libs:core-result`. `describe` returned `platforms:["android"]` and `coverage_plugin:null` for a module that should report `["jvm","android","ios","macos"]` and `kover`. Root cause: `cacheKey` hashes only project inputs (`settings.gradle.kts` + `gradle.properties` + `build.gradle.kts`); changes to `lib/project-model.js` itself never invalidated the cache. The Bug #4 fix (commit `ae02317`, 2026-05-07) changed `platformsFromAnalysis()` output without bumping `SCHEMA_VERSION`, so the 2026-05-04 cache silently kept being returned.

Fix: embed a sha1 fingerprint of `lib/project-model.js` source in the persisted model JSON; cache validation rejects entries whose `modelFingerprint` is missing or mismatched. Re-building is Node-only (~ms) because `tasks-<sha>.txt` (raw gradle probe output) is independent of the introspector and stays valid.

3 regression tests added to `tests/vitest/project-model.test.js`. 195/195 pass.

### Bug B — `--flag=value` POSIX syntax not parsed by orchestrators → PR #167 (merged `e2c3654`)

Surfaced by cell **I1c** against PeopleInSpace. `kmp-test parallel --gradle-args=--rerun-tasks ...` ran with `up_to_date:1` (gradle did NOT re-execute). Same for `--module-filter=core-result`, `--test-type=common`, `--coverage-tool=kover`. Root cause: the `parseArgs` switch in `parallel-orchestrator` and `coverage-orchestrator` matches the FULL token (`case '--flag':`), so `--flag=value` (POSIX form, accepted by `gh`, `npm`, `kubectl`, etc.) didn't hit any case and was silently dropped.

Fix: extend `expandNoCoverageAlias` in both orchestrators to pre-split `--<name>=value` into `[--<name>, value]` before the switch sees the args. Restricted to tokens beginning with `--<name>=` (no whitespace before the `=`) so values passed via the space form (`--gradle-args "--no-parallel -Pfoo=bar"`) keep their internal `=` intact.

8 regression tests added to `tests/vitest/parallel-orchestrator.test.js` + `tests/vitest/coverage-orchestrator.test.js`. 200/200 pass.

## Cells executed

### Part 1 — without S22 (PC charging)

| Cell | Project | Subcommand | Test type / flags | Result | Wall | Tests | Notes |
|---|---|---|---|---|---|---|---|
| A1 | – | `doctor` | – | ✅ | <1s | – | 3 JDKs catalogued, ADB OK |
| A2 | – | `info --json` | – | ✅ | 78ms | – | full envelope shape |
| A3 | – | `update --check --json` | – | ✅ | 1.3s | – | already on latest 0.8.1 |
| B1 | KaMPKit | `parallel --dry-run --isolated --json` | – | ✅ | <1s | – | Bug #6 fix wet: `isolated:{enabled:true,cache_dir:null,kept:false,locked:true}` top-level |
| B2 | PeopleInSpace | `parallel --list-only --json` | – | ✅ | 31ms | – | Bug #7 fix wet: `parallel.list_only:true`, exit 0, 3 testable modules listed |
| B3 | shared-kmp-libs | `coverage --dry-run --json` | `--module-filter core-result` | ✅ | <1s | – | Bug #5 fix wet: `coverage{tool, missed_lines, modules_with_kover_plugin[], modules_with_jacoco_plugin[]}` shape |
| B4 | shared-kmp-libs | `describe --json` | – | ❌→✅ | 17s | – | Bug A surfaced + fixed inline (PR #166) |
| B5 | PeopleInSpace | `describe --json` | – | ✅ | – | – | Bug #4 fix wet on project without convention plugins: `:common` reports `["jvm","android","ios","wasmJs"]` |
| B6 | Confetti | `parallel --list-only --json` | – | ✅ | – | – | 4 testable modules / 9 legit-skipped, no-Kover envelope correct |
| B7 | di-patterns-demo | `parallel --list-only --json` | `--module-filter sample` | ✅ | – | – | glob filter + Android-only envelope, 1 testable / 4 skipped |
| C1 | KaMPKit | `parallel` | `common` | ✅ legit-skip | <1s | 0 | no JVM target on `:shared` (matches PR #155 "SKIP legit") |
| C2 | PeopleInSpace | `parallel` | `common` `:common` | ✅ | 6.8s | 8 | commonTest |
| C3 | shared-kmp-libs | `parallel` | `common` `:core-result` | ✅ | 5s | 70 | cached |
| C4 | shared-kmp-libs | `parallel` | `desktop` `:benchmark-crypto` | ✅ | 4s | 9 | JMH harness |
| C5 | Confetti | `parallel` | `common` `:backend` | ✅ | 19.6s | 1 | cold gradle init |
| C6b | di-patterns-demo | `parallel` | `androidUnit` `:di-contracts` | ✅ | 12.6s | 68 | (C6 with `--test-type common` correctly returned `no_test_modules` — Android-only project) |
| D1 | KaMPKit | `parallel` | `ios` `:shared` | ✅ | 17.3s | 24 | iosSimulatorArm64Test, real iOS sim |
| D2 | PeopleInSpace | `parallel` | `ios` `:common` | ✅ | 10.7s | 8 | **NEW coverage** — iOS sim wet on multi-module project |
| D3 | shared-kmp-libs | `parallel` | `ios` `:core-result` | ✅ | 27.6s | 73 | **NEW coverage** — iOS sim on Kover module (commonTest 70 + iosTest 3) |
| E1 | KaMPKit | `parallel` | `macos` `:shared` | ⚠️ legit-skip | <1s | 0 | no macos target (drift: exit 3 instead of 0) |
| E2 | PeopleInSpace | `parallel` | `macos` `:common` | ⚠️ legit-skip | <1s | 0 | no macos target on this module (correct skip; drift exit 3) |
| E3 | shared-kmp-libs | `parallel` | `macos` `:core-result` | ✅ | 8.3s | 73 | macosArm64Test cached |
| F1 | shared-kmp-libs | `coverage` | `:core-result` | ✅ | 3.3s | – | **Bug #5 wet-validated**: `missed_lines:317`, `modules_with_kover_plugin:[62 modules]`, `modules_with_jacoco_plugin:[]` |
| F2 | Confetti | `coverage --dry-run` | `:backend` | ✅ | <1s | – | shape OK, both arrays empty (no Kover/JaCoCo) |
| G1 | KaMPKit | `changed --json` | sentinel + `--no-coverage` | ✅ | – | 24 | `changed.detected_modules:["shared"]` |
| G2 | PeopleInSpace | `changed --dry-run --json` | sentinel + `--test-type ios` | ✅ | – | – | plan emits `--test-type ios` correctly |
| H1 | shared-kmp-libs | `parallel --isolated` | `common` `:core-result` | ✅ | 10.2s | 70 | `isolated.cache_dir:.kmp-test-runner/cache-isolated/<runId>`, removed at exit |
| H2 | shared-kmp-libs | 2× concurrent `parallel --isolated --isolated-no-lock` | disjoint `core-result` / `core-error` | ✅ | 32s | 70 + 287 | both succeeded; distinct `cache_dir`s; –1 GB disk consumed |
| I1d | PeopleInSpace | `parallel` | `--gradle-args "--info --rerun-tasks"` (space form) | ✅ | – | 8 | `fresh:1` confirms `--rerun-tasks` propagated |
| I1c | PeopleInSpace | `parallel` | `--gradle-args="--rerun-tasks"` (= form) | ❌→✅ | – | 8 | Bug B surfaced + fixed inline (PR #167) |
| I2 | shared-kmp-libs | `parallel` | `desktop` + `--gradle-args="-Dkotlin.daemon.jvmargs=-Xmx1g"` | ✅ | – | 9 | passthrough OK |

### Part 2 — with S22 attached

| Cell | Project | Subcommand | Flags | Result | Wall | Tests | Notes |
|---|---|---|---|---|---|---|---|
| J1 | KaMPKit | `android` | `:shared` | ✅ | 10.1s | 0 | dispatch OK, 0 tests (no androidDeviceTest source set), matches PR #155 |
| J2 | PeopleInSpace | `android` | – | ⚠️ partial | 1m45s | 1 task ok | `wearApp:connectedDebugAndroidTest` FAILED with 0 tests on the S22 phone — expected (Wear OS app on a phone) |
| J2-watch | PeopleInSpace | `android --module-filter wearApp --device 192.168.68.105:33999` | Galaxy Watch SM_L705F via wireless ADB | ⚠️ test-side fail | 1m3s | 2 ran (1 passed, 1 failed) | **CLI dispatched + parsed correctly** on the Watch (envelope `tests:{total:2,passed:1,failed:1}`, parseTestCounts handled the new-plugin "Starting 2 tests / Tests 1/2 completed / Finished 2 tests" format). The 1 failed test (`testPeopleListScreen`) is `IllegalStateException: No compose hierarchies found in the app` — a project-side test-setup issue on Wear OS, NOT a CLI bug. Side finding: `_errors.json` did NOT capture the test runtime failure (drift #4 reinforced — see below) |
| J3 | shared-kmp-libs | `android` | `:benchmark-network` | ✅ | 38.1s | 3 | matches PR #155 evidence; new-plugin format `Finished 3 tests` parsed correctly |
| J4 | Confetti | `android` | – | ✅ | 1m | 0 | 5 modules dispatched, 0 instrumented tests defined (matches `find -name androidTest` count = 0) |
| J5 | di-patterns-demo | `android` | `--module-filter sample` | ❌ project-side | 1m30s | 0 | `sample-multimodule:compileDebugAndroidTestKotlin FAILED` — 3 unresolved references in `SdkIntegrationTest.kt` (project bug, not CLI). CLI envelope correctly populates `errors[].compilationErrors[]` |
| K1 | shared-kmp-libs | `android` | `:benchmark-network --auto-retry` | ✅ | 40.1s | 3 | retry didn't fire (tests passed) |
| K2 | shared-kmp-libs | `android` | `--clear-data --auto-retry` | ✅ | 29.7s | 3 | `pm clear` flow OK |
| K3 | shared-kmp-libs | `android` | `--device R3CT30KAMEH` | ✅ | 31.7s | 3 | explicit device flag respected; envelope captures `android.device_serial` |
| K4 | shared-kmp-libs | `parallel --test-type androidInstrumented` | `:benchmark-network` | ✅ | 46.5s | 1 task | parity with `kmp-test android` confirmed |
| L1 | – | `--flavor` | – | ⏸️ N/A | – | – | None of the 5 workspace projects declares `productFlavors` — wet validation requires synthetic fixture |
| L2 | shared-kmp-libs | `android` | `--test-filter "class=*NetworkStressTest"` | ❌ user-error | – | – | `class=` prefix is the INTERNAL AGP wire form (per CHANGELOG entry on combined `class=<FQN>#<method>`), NOT the user-facing `--test-filter` shape (per README). User-facing is `*Pattern*` or `FQN[#method]` |
| L2b | shared-kmp-libs | `android` | `--test-filter "*NetworkStressTest"` | ✅ | – | 3 | correct user-facing shape |
| L3b | shared-kmp-libs | `parallel --test-type androidInstrumented` | `--test-filter "*NetworkStressTest"` | ✅ | 31.4s | 1 | parity with `kmp-test android` |

## Drift findings (non-blocking, not fixed in this audit)

These are envelope/UX inconsistencies the audit surfaced but the user did not flag for inline-fix. Recommended for v0.10 or later.

1. **`exit 3` on legit-skip with no remaining modules** (C1, E1, E2). When `--module-filter <X>` matches a module that is then legitimately filtered out by `--test-type` (e.g. KaMPKit `:shared` has no JVM target), the orchestrator emits `errors[{code:"no_test_modules"}]` and exits 3. The `errors[]` discriminator is correct, but exit 3 (`environment error`) is confusing — agent code branching on exit code reads it as a real failure. `tests.total:0 + skipped[].reason:"no <type> target"` would justify exit 0.

2. **`modules[]` shape difference between list-only vs wet** (B vs C). `--list-only` emits objects (`{name, type, coverage_plugin, test_build_type, has_flavor, android_dsl_variant}`), but wet runs emit bare strings (`["common"]`). Either is fine alone; the contrast across one envelope schema is the drift.

3. **`parallel --test-type androidInstrumented` does not populate `individual_total` or `android.device_serial`** (K4, L3b). Both fields are populated by `kmp-test android`. The two paths should expose the same agent-readable shape.

4. **`_errors.json` doesn't capture instrumented test runtime failures** (J2 + J2-watch). The structured error file populates `compilationErrors[]` correctly (proven by J5 demo with 3 unresolved refs) but does NOT populate `testFailures[]` when an instrumented test throws at runtime. Two distinct repros:
   - J2 (S22 phone): `:wearApp:connectedDebugAndroidTest FAILED` with 0 tests — `_errors.json` empty.
   - J2-watch (Galaxy Watch SM_L705F): 2 tests ran, `testPeopleListScreen` threw `IllegalStateException: No compose hierarchies found in the app` — `_errors.json` STILL empty (`compilationErrors:[], testFailures:[], crashes:[]`), even though the gradle stdout has the full stack trace and the parser already correctly counted `tests:{total:2,passed:1,failed:1}` in the top-level envelope.
   The fix is to thread the `Tests M/N completed. (S skipped) (F failed)` parser output to also populate `testFailures[]` with the failing test FQN + cause (extractable from the `> testName[device] FAILED` + indented stack trace lines). Lets agents diagnose runtime failures without fetching `wearApp.log`.

5. **`describe` `module-filter` does not accept positional shape** (B4 first attempt). I tried `kmp-test describe :core-result --json` and got 0 modules without an error message; the working form is `--module-filter core-result`. The positional form is silently ignored.

## What was NOT validated wet

- **`--flavor <name>`** (L1) — no workspace project has `productFlavors`; would require a synthetic fixture.
- **iOS device** (`iosArm64Test`) — never reachable via Gradle (per `reference_kmp_benchmark_platforms.md`); only simulator path exists.
- **shared-kmp-libs Android-host tests** — same as PR #155: 0/65 modules opt-in to `withHostTestBuilder{}`, so the orchestrator skips with the legit reason; not a CLI bug.

## End-state verdict

- **Pre-tag readiness for v0.9.0**: ✅ green for the dispatch surface across **3 distinct device classes** wet-validated:
  - macOS host (jvm/desktop, iosSimulatorArm64Test, macosArm64Test) — 5 testbeds × multiple test-types
  - Samsung Galaxy S22 phone — `kmp-test android` instrumented (3 tests on `shared-kmp-libs:benchmark-network`)
  - Samsung Galaxy Watch (SM_L705F) via wireless ADB — `kmp-test android --device <ip:port>` instrumented (2 tests on `PeopleInSpace:wearApp`, parseTestCounts handled new-plugin format on a Wear device for the first time)
- Both bugs surfaced were fixed inline and merged to `develop` (PR #166 + PR #167); the 5 drift findings (incl. drift #4 reinforced by J2-watch) are envelope/UX clarifications, none are dispatch correctness regressions.
- **Vitest baseline**: 1142/1143 (1 preexisting `parity.test.js#info --json --no-adb` snapshot drift on the audit machine where `JAVA_HOME` is unset; passes in CI).
- **Recommendation**: tag `v0.9.0` (BACKLOG step 10). The audit closes with 0 unfixed bugs and 5 documented drifts queued as v0.10 candidates.

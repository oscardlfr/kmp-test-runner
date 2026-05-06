# v0.9 macOS validation gate — wet results

Generated 2026-05-06. Wallclock ~30 min on the secondary Mac (8.6 GiB → 6.2 GiB system disk). All cells executed real `gradle` invocations (no `--dry-run`). The S22 (`R3CT30KAMEH` / `SM-S908B - 16`) was attached over USB for instrumented cells.

This is the WET counterpart to the auto-generated `MACOS-GATE-V0.9-SUMMARY.md` (which is `--mode probe` shape-validation only). Together they certify v0.9.0 dispatch end-to-end.

## Cells executed

| Project | Subcommand | --test-type | Module filter | Result | Wall | Tests run | Notes |
|---|---|---|---|---|---|---|---|
| `kmp-cross-platform-e2e` (in-repo) | `parallel` | `desktop` | `sample` | ✅ PASS | 0.6s | 2 (jvmTest) | gradlew exec-bit bug surfaced + fixed |
| `kmp-cross-platform-e2e` | `parallel` | `ios` | `sample` | ✅ PASS | 44s | 2 (iosSimulatorArm64Test) | Cold Kotlin/Native download |
| `kmp-cross-platform-e2e` | `parallel` | `macos` | `sample` | ✅ PASS | 4s | 2 (macosArm64Test) | K/N cached after iOS run |
| `kmp-cross-platform-e2e` | `parallel` | `androidUnit` | `sample` | ✅ PASS | 4s | 2 (testAndroidHostTest) | KMP-Android plugin path |
| `kmp-cross-platform-e2e` | `parallel` | `common` | `sample` | ✅ PASS | 0.7s | 2 (jvmTest) | common-test cascade |
| `KaMPKit` | `parallel` | `common` | `shared` | ⚠️ SKIP (legit) | – | – | No JVM target in `:shared` (Android+iOS only) |
| `KaMPKit` | `parallel` | `ios` | `shared` | ✅ PASS | 17s | – | iosSimulatorArm64Test, real iOS sim |
| `KaMPKit` | `parallel` | `androidUnit` | `shared` | ✅ PASS | 32s | – | testAndroidHostTest, hybrid plugin pattern fix surfaced |
| `KaMPKit` | `android` | – | `shared` | ✅ PASS | – | 0 (dispatch only) | S22 connected; no `androidDeviceTest` source set in `:shared` |
| `shared-kmp-libs` | `parallel` | `common` | `core-result` | ✅ PASS | – | **70** real | Real JVM execution against 70 commonTest cases |
| `shared-kmp-libs` | `parallel` | `androidUnit` | `core-result` | ⚠️ SKIP (legit) | – | – | No `withHostTestBuilder{}` opt-in (convention: 0/65 modules) |
| `shared-kmp-libs` | `parallel` | `macos` | `benchmark-crypto` | ✅ PASS | – | 0 (dispatch only) | macosArm64Test built; tests live in `desktopTest`, not `commonTest` |
| `shared-kmp-libs` | `parallel` | `desktop` | `benchmark-crypto` | ✅ PASS | – | **9** real | Real JVM execution (JMH stress + envelope tests) |
| `shared-kmp-libs` | `android` | – | `benchmark-network` | ✅ PASS | 41s | **3** real | **3 instrumented tests ran on S22** (`Finished 3 tests on SM-S908B - 16`); parseTestCounts fix surfaced |

## Bugs surfaced and fixed inline this PR

Per `feedback_close_in_one_session.md`, every bug surfaced by the wet pass got fixed in the same PR with a regression test. No "Phase D" deferrals.

1. **`tests/fixtures/kmp-cross-platform-e2e/gradlew` had no execute bit** (git mode `100644` instead of `100755`). `gradle-plugin/gradlew` was correctly `100755` but the v0.9 step 6 fixture was checked in without the bit. The first wet cell hit `permission denied: ./gradlew` → orchestrator reported `[FAIL] sample` for what should have been a 600 ms PASS. Fixed via `git update-index --chmod=+x`. The other read-only fixtures under `tests/fixtures/build-logic-*` keep their `100644` mode (they exist for static parser tests and never invoke gradle).

2. **`lib/parallel-orchestrator.js#pickGradleTaskFor('androidUnit')` early-return missed the hybrid plugin pattern.** KaMPKit's `:shared` uses `com.android.library` (legacy plugin) at the top, but `kotlin { android { withHostTestBuilder {} } }` (new KMP-Android DSL) inside the `kotlin {}` block. The parser surfaces `type='kmp'`, `androidDsl=null`, `androidDslVariant='kmpAndroidLibrary'`. The orchestrator's gate checked only `type` and `androidDsl`, so the existing `kmpAndroidLibrary` branch (which would have dispatched `testAndroidHostTest`) never ran. Extended the gate to also accept `androidDslVariant`. Regression test in `tests/vitest/parallel-orchestrator.test.js#Bug D` (KaMPKit hybrid case).

3. **`lib/android-orchestrator.js#parseTestCounts` only handled legacy AGP format**, missing the new KMP-Android plugin's `connectedAndroidDeviceTest` reporter shape. Legacy emits `"12 tests completed, 1 failed, 2 skipped"`; new plugin emits `"Starting 3 tests on <device>"` + progress lines `"<device> Tests M/N completed. (S skipped) (F failed)"` + `"Finished 3 tests on <device>"`. The benchmark-network wet cell ran 3 real tests on the S22 with `BUILD SUCCESSFUL`, but the envelope reported `testsPassed: 0`. Added a fallback regex chain (legacy first, then `Finished N tests` for total + last progress line for failed/skipped). 5 regression tests in `tests/vitest/android-orchestrator.test.js`.

## What was NOT validated wet

- **iOS simulator on benchmark modules.** The `KmpBenchmarkConventionPlugin.kt` declares only `jvm("desktop")` + `macosArm64()` + `androidLibrary {}` — NO iOS targets. Coincides with memory `reference_kmp_benchmark_platforms.md` ("kotlinx.benchmark behaves differently on iOS sim"). Out-of-scope for this gate; would require modifying shared-kmp-libs to add iOS targets.
- **Android instrumented on KaMPKit `:shared`.** `:shared` has no `androidDeviceTest`/`androidInstrumentedTest` source set. The `kmp-test android` invocation succeeded (dispatch + S22 connection) but ran 0 tests. The benchmark-network case (above) covers the actual instrumented execution path.
- **shared-kmp-libs Android-host tests.** All 65 modules with `androidLibrary {}` are missing the `withHostTestBuilder {}` opt-in. This is a convention decision by the repo owner (the convention plugin doesn't add it). Validated via wet smoke that the orchestrator correctly skips with `[SKIP] no androidUnitTest source set (withHostTestBuilder{} missing)` rather than generating a `task_not_found`.

## End-state

- `node tools/macos-validation-gate.mjs --mode probe` → **44 PASS / 0 DRIFT / 1 SKIP** (the SKIP is the in-repo fixture's android cell which has no instrumented target by design).
- `npm test` → **1068/1068** (1063 → 1068, +5 from this PR).
- 0 unfixed drift findings carried over to a follow-up session.

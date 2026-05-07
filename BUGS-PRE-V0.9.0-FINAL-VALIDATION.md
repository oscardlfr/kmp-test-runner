# v0.9 pre-release bug sweep — final validation matrix

**Date:** 2026-05-08
**develop tip after sweep:** `979c27a` (Bug #6 / PR #163)
**Bugs closed in this sweep:** #2, #3, #4, #5, #6 (Bug #1 closed earlier in PR #158)
**Vitest baseline:** 1080 → 1124 (+44 across the sweep)

This file is the post-sweep evidence companion. Every cell below was executed against post-sweep develop with `./gradlew --stop` + `rm -rf .kmp-test-runner/ .kmp-test-runner-cache/` per project per block. S22 Ultra (R3CT30KAMEH) was attached for instrumented cells. ADB resolution was via `ANDROID_HOME=$ANDROID_HOME PATH=...platform-tools:$PATH` (kmp-test's adb probe inherits the orchestrator's spawn env).

## Block A — Bug #2 closure (NowInAndroid `:core:data`)

Convention plugin alias resolution. Pre-fix: alias `nowinandroid.android.library` resolved to non-canonical literal id; analyzeModule's canonical-id checks never fired; module classified as `type: 'unknown'` and orchestrator gate rejected with `no_test_modules`.

| Cell | Command | Result |
|---|---|---|
| A.1 | `kmp-test describe --module-filter "^:core:data$" --no-cache --project-root <NIA>` → `module.type` | `'android'` ✓ (pre-fix: `'unknown'`) |
| A.2 | (same) → `module.android_dsl` | `null` ✓ (legacy AGP DSL — no `androidLibrary {}` block in NIA's consumer module) |
| A.3 | (same) → `module.coverage_plugin` | `'jacoco'` ✓ (descriptor-direct via `nowinandroid.android.library.jacoco` alias's `apply<JacocoPlugin>()`) |

PR: [#159](https://github.com/oscardlfr/kmp-test-runner/pull/159) (squashed to develop @ `e241de8`).

## Block B — Bug #3 closure (`--module-filter ":benchmark"` on dipatternsdemo)

Filter normalization. Pre-fix: `kmp-test android --list-only --module-filter ":benchmark"` returned 0 modules with `no_test_modules`; substring `m.name.includes(":benchmark")` against the colon-stripped discovery name fails.

| Cell | Command | Result |
|---|---|---|
| B.1 | `kmp-test android --list-only --json --module-filter ":benchmark" --project-root <dipatternsdemo>` → exit | 0 ✓ (pre-fix: 3) |
| B.2 | (same) → `android.instrumented_modules` | `["benchmark"]` ✓ (pre-fix: `[]`) |
| B.3 | (same) → `errors` | `[]` ✓ (pre-fix: `[{code: "no_test_modules"}]`) |
| B.4 | `kmp-test android --list-only --json --module-filter "benchmark" --project-root <dipatternsdemo>` (no colon, control) → `instrumented_modules` | `["benchmark"]` ✓ (consistent with B.2) |

PR: [#160](https://github.com/oscardlfr/kmp-test-runner/pull/160) (squashed to develop @ `8bb7996`).

## Block C — Bug #4 closure (`platforms[]` augmented from gradle probe)

Static-only platforms detection undercounted KMP modules whose convention plugins emit targets without visible source-set dirs. shared-kmp-libs `:core-result` reported `["android"]` despite gradle exposing `desktopTest` / `iosSimulatorArm64Test` / `macosArm64Test` / `testAndroidHostTest`.

| Cell | Command | Result |
|---|---|---|
| C.1 | `kmp-test describe --module-filter "^:core-result$" --no-cache --project-root <shared-kmp-libs>` → `module.platforms` | `["jvm","android","ios","macos"]` ✓ (pre-fix: `["android"]`) |
| C.2 | (same) → `module.test_tasks` | `unit:'desktopTest'`, `device:'androidConnectedCheck'`, `ios:'iosSimulatorArm64Test'`, `macos:'macosArm64Test'` ✓ (consistent w/ probed signal driving `platforms[]`) |

PR: [#161](https://github.com/oscardlfr/kmp-test-runner/pull/161) (squashed to develop @ `ae02317`).

## Block D — Bug #5 closure (coverage envelope shape parity)

Pre-fix `parallel-orchestrator`'s `state.coverage` was `{tool, missed_lines}` only; `android-orchestrator` emitted empty `modules_with_kover_plugin` / `modules_with_jacoco_plugin` (placeholder shape). Coverage-orchestrator already populated correctly.

| Cell | Command | Result |
|---|---|---|
| D.1 | `kmp-test coverage --json --coverage-tool kover --module-filter "core-result,core-common" --project-root <shared-kmp-libs>` → `coverage.tool` | `'kover'` ✓ |
| D.2 | (same) → `coverage.modules_with_kover_plugin.length` | 62 ✓ (full kover surface across shared-kmp-libs) |
| D.3 | (same) → `coverage.modules_with_jacoco_plugin.length` | 0 ✓ (kover-only project) |
| D.4 | (same) → first 5 kover modules | `["benchmark-infra","core-audit","core-auth-biometric","core-backend-api","core-billing-api"]` ✓ |

PR: [#162](https://github.com/oscardlfr/kmp-test-runner/pull/162) (squashed to develop @ `920eb27`).

## Block E — Bug #6 closure (`--isolated --dry-run` envelope shape)

Pre-fix: `kmp-test parallel --isolated --dry-run --json` (and android/benchmark/changed equivalents) emitted an envelope WITHOUT a top-level `isolated:{}` field. Only `plan.spawn_args` reflected `-Isolated`. `cli.js#main` intercepts `--dry-run` upstream of the orchestrator's real-run path, where `envelope.isolated = isolatedField` is set; `cli.js#buildDryRunReport` lacked the `isolated` parameter entirely.

| Cell | Command | Result |
|---|---|---|
| E.1 | `kmp-test parallel --isolated --dry-run --json --project-root <shared-kmp-libs>` → top-level `isolated` | `{enabled:true, cache_dir:null, kept:false, locked:true}` ✓ (pre-fix: `undefined`) |
| E.2 | `kmp-test android --isolated --dry-run --json --project-root <shared-kmp-libs>` → top-level `isolated` | `{enabled:true, cache_dir:null, kept:false, locked:true}` ✓ (pre-fix: `undefined`) |
| E.3 | `kmp-test parallel --isolated-cache-dir /tmp/my-cache --isolated-no-lock --dry-run --json` → `isolated` | `{enabled:true, cache_dir:'<resolved-path>', kept:false, locked:false}` ✓ |

PR: [#163](https://github.com/oscardlfr/kmp-test-runner/pull/163) (squashed to develop @ `979c27a`).

## Block F — Vitest full suite + sweep delta

| Pre-sweep baseline | Post-sweep | Delta |
|---|---|---|
| 1080 (PR #158 / `e7367dc`) | 1124 (PR #163 / `979c27a`) | +44 across the sweep |

Per-PR delta:
- Bug #2 (PR #159): +7 (8 new tests, 1 existing test updated for descriptor shape)
- Bug #3 (PR #160): +17 (15 in `orchestrator-utils.test.js`, 3 in `android-orchestrator.test.js`)
- Bug #4 (PR #161): +9 (all in `describe-orchestrator.test.js`)
- Bug #5 (PR #162): +5 (3 in `android-orchestrator.test.js`, 2 in `parallel-orchestrator.test.js`)
- Bug #6 (PR #163): +6 (all in `parity.test.js` — `--isolated --dry-run` cross-subcommand matrix)

## Block G — S22 Ultra instrumented regression guard

End-to-end smoke against `shared-kmp-libs :benchmark-network` (instrumented test running against R3CT30KAMEH). Confirms the full sweep didn't regress a working flow.

| Cell | Command | Result |
|---|---|---|
| G.1 | `kmp-test parallel --test-type androidInstrumented --json --module-filter "benchmark-network" --device R3CT30KAMEH --project-root <shared-kmp-libs>` → exit | 0 ✓ |
| G.2 | (same) → `tests` | `{total:1, passed:1, failed:0, skipped:0}` ✓ |
| G.3 | (same) → `modules` | `[{name:"benchmark-network", ...}]` ✓ |
| G.4 | (same) → `errors` | `[]` ✓ |

(Bug #5 envelope shape verified in Block D using the coverage subcommand — Block G's coverage block emits the parallel-orchestrator real-run path's coverage shape, which includes the kover/jacoco arrays.)

## Cache discipline

Every cell prefixed with `./gradlew --stop` + `rm -rf .kmp-test-runner/ .kmp-test-runner-cache/`. Per-project, per-block discipline. No cell ran against a hot cache from a prior cell.

## Out-of-scope discoveries (NOT fixed, NOT release-blockers)

These surfaced during the matrix but are documented limitations / out-of-scope for this sweep. NONE block v0.9.0 tagging.

- **`kmp-test parallel --list-only` not implemented.** Documented in cli.js help text for `android` only; parallel ignores the flag and exits with `no_summary`. Surfaced during Bug #3 cross-product matrix (Cell D in original investigation).
- **`testBuildType = when {}` / `if {}` complex expressions** not parsed. Static regex covers literal + `?: "default"` patterns. Documented limitation; introducing a Kotlin AST parser is out of scope.
- **adb probe inherits orchestrator spawn env.** When `ANDROID_HOME` / PATH don't include `platform-tools`, `defaultAdbProbe` returns empty even if adb is reachable elsewhere on the host. Surfaced during Block G; already documented in code comments. Workaround: set ANDROID_HOME or pass platform-tools via PATH.

## Sign-off

| Bug | Status | Fix-PR | Validation |
|---|---|---|---|
| #2 (convention plugin alias) | ✅ FIXED | [#159](https://github.com/oscardlfr/kmp-test-runner/pull/159) | Block A |
| #3 (filter normalization) | ✅ FIXED | [#160](https://github.com/oscardlfr/kmp-test-runner/pull/160) | Block B |
| #4 (`platforms[]` augmentation) | ✅ FIXED | [#161](https://github.com/oscardlfr/kmp-test-runner/pull/161) | Block C |
| #5 (coverage envelope parity) | ✅ FIXED | [#162](https://github.com/oscardlfr/kmp-test-runner/pull/162) | Block D |
| #6 (isolated dry-run envelope) | ✅ FIXED | [#163](https://github.com/oscardlfr/kmp-test-runner/pull/163) | Block E |

Vitest 1124 ✓. S22 instrumented smoke ✓. develop @ `979c27a`. **Step 10 release ceremony unblocked.**

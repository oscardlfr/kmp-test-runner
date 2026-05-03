# Backlog

> Active and queued tasks for `kmp-test-runner`. Newest first. Read `CLAUDE.md` first for repo state + gitflow rules.

---

## ACTIVE

### v0.8 — STRATEGIC PIVOT: migrate orchestration logic from bash/ps1 to Node (decided 2026-05-02)

**Surfaced 2026-05-02 during the WS-2 / PR #105 firefighting session, after stepping back from "another Bash 3.2 patch" thinking.**

**Diagnosis of the maintenance trajectory:**

The repo has invested 3 PRs in this session alone (#102 SKIPPED_MODULES unbound, #103 WS-1/WS-5/UX-1/UX-2 task-not-found + target filter, #105 WS-2 declare -A + 2 surfaced empty-array landmines) plus the original v0.7.0 18-entry sourceSet walker — all on bash-side bug classes that **shellcheck does not catch**. Of the 11 wide-smoke bugs WS-1..WS-10 + UX-1/UX-2, 7 remain (WS-3, WS-4, WS-6, WS-7, WS-8, WS-9, WS-10) plus jvm()→jvmTest discovery. Every one of them lives in `scripts/sh/run-*.sh` or `scripts/ps1/run-*.ps1`. Same pattern: discover modules, dispatch parallel, parse output, aggregate summary — implemented twice (bash + ps1) with subtly different gotchas in each dialect.

The `bats-macos` job added in PR #105 to close the Bash 3.2 parity gap hit the adb-orphan flake on macos-latest in 2/2 runs. Validating bash-side fixes requires coming to mom's MacBook (the repo owner's primary machine is Windows). The cycle is: write fix on Windows → push to a Mac → smoke → discover the next bash-3.2 gotcha → repeat.

**The asymmetry that breaks this open:**

The product's value-add (per `README.md:5-123`) is the `--json` envelope — 13K → 100 token reduction for AI agents, ~542K → ~500 tokens for the coverage 5-iter loop. **That value lives entirely in Node** (`lib/cli.js` parser + envelope shaping, `lib/project-model.js` fast path, `lib/jdk-catalogue.js` multi-JDK selection, `tests/vitest/*` coverage). The bash + ps1 scripts are plumbing that invokes gradle and prints lines that Node then parses back. **The plumbing has no value the user pays for.**

**Decision: incremental migration of orchestration logic from bash/ps1 → Node. Bash and ps1 become thin gradle invokers (target: ≤100 LOC each, no associative arrays, no parallel loops).**

**Why this is the right move for this product (vs the alternatives considered):**

| Alternative considered | Rejected because |
|---|---|
| Keep bash + invest in custom shellcheck rules | Doesn't address triple maintenance; every feature still doubles. shellcheck custom rules are themselves new maintenance. |
| Hybrid Bash 4+ gate (require `brew install bash`) | Bad UX for an open-source product. "First install brew, then this" loses contributors. Repo owner explicitly retracted this option. |
| Migrate runtime to zsh | ~2000 LOC rewrite, shellcheck doesn't validate zsh, bats is bash-idiom, breaks installer. Larger lift than Node migration with worse outcome. |
| Status quo (keep firefighting) | 7 wide-smoke bugs remain + new ones surface every PR. Trajectory is more PRs not fewer. |
| Greenfield Node rewrite | Months of work, breaks existing user contracts. Migration is incremental — preserves contracts. |

**Why Node migration aligns with product reality (per the answers from 2026-05-02):**

- **Open-source product, every-OS contributor** — Node runs identically on Windows/Linux/macOS; one logic, one test suite (vitest already covers all 3 OSes in `build` matrix).
- **macOS must work on default Bash 3.2** — thin invoker scripts use no Bash-4 features, so this works for free.
- **Repo owner is Windows-primary, mom's MacBook for testing** — Node iteration happens on Windows; comes to Mac only for final smoke. Cuts the iteration cycle massively.
- **AI-agent first-class consumer** — vitest snapshots of envelope shapes catch agent-contract regressions deterministically (vs bats parsing stub gradle output).
- **Producto, no tooling** — defaults must be rock-solid; one Node implementation has fewer surfaces to be flaky than three (bash + ps1 + gradle plugin).

**Required precondition:**

`PRODUCT.md` (or `docs/strategy.md`) drafted in next session that codifies:
- Target user (open-source contributor any OS, with + without AI agents)
- Supported OS matrix (Windows/Linux/macOS, with platform-aware error messages e.g. iOS tests on Windows fail clearly)
- Value prop (token cost reduction via `--json` envelope, measured per README)
- Architecture principle: "logic in Node, plumbing in shell" — every PR justifies itself against this

Once `PRODUCT.md` exists, this entry expands into a per-feature migration plan (see "Approach" below).

**Approach (incremental, per-feature):**

Each feature migrates in a single PR following the same shape:
1. New `lib/<feature>-orchestrator.js` implementing discovery + parallel dispatch + output parsing logic (parsers already partly exist in `lib/cli.js`).
2. `scripts/sh/run-<feature>.sh` and `scripts/ps1/run-<feature>.ps1` shrink to thin wrappers that `exec node lib/runner.js <feature> ...`. Per `PRODUCT.md` architecture principle: ≤100 LOC each (realistic 40-80), no associative arrays, no parallel loops, no output parsing.
3. New `tests/vitest/<feature>-orchestrator.test.js` covers the migrated logic on all 3 OSes (Linux/Mac/Win — the existing `build` matrix).
4. Existing bats + Pester tests of the SCRIPT shrink to "wrapper invokes node correctly" contracts; LOGIC tests live in vitest.
5. `bats-macos` informational job stays during transition (catches Bash-3.2 regressions in remaining `run-*.sh` plumbing); removed in the PR that completes the migration (sub-entry 5).

LOC baseline (source of truth — feeds the per-entry LOC delta below):

| Script                              | LOC    |
|-------------------------------------|-------:|
| `run-benchmarks.sh`                 |   538  |
| `run-benchmarks.ps1`                |   471  |
| `run-changed-modules-tests.sh`      |   292  |
| `run-changed-modules-tests.ps1`     |   314  |
| `run-android-tests.sh`              |   784  |
| `run-android-tests.ps1`             |   649  |
| `run-parallel-coverage-suite.sh`    | 1,685  |
| `run-parallel-coverage-suite.ps1`   | 1,463  |
| **TOTAL bash + ps1**                | **6,196** |

Post-migration target: ~470 LOC of residual shell across 8 wrapper files (12× reduction) + ~1,800-2,400 LOC of new `lib/<feature>-orchestrator.js` covered by a single vitest matrix vs three test runners today.

**Cross-cutting decisions (locked 2026-05-02):**
- Coverage and parallel share the file `run-parallel-coverage-suite.{sh,ps1}` (per `lib/cli.js:45`, `coverage` = `parallel --skip-tests`). Migration is two phased PRs: PR4 extracts the coverage codepath into `lib/coverage-orchestrator.js` (small, low-risk pattern validator); PR5 then migrates the rest into `lib/parallel-orchestrator.js` and the wrapper becomes thin.
- The "4 build-logic backlog entries" bash-side coverage helpers are: `detect_coverage_tool` (sh) + `get_coverage_gradle_task` (sh) + ps1 mirrors of both. Their deletion was deferred from the v0.5.2 Gap A scope reduction; the coverage migration (sub-entry 4) finally executes it.
- WS-8 (`tests.total` = task count) ships as **additive `tests.individual_total`** in v0.8 (no major version bump). CHANGELOG carries a forward-rename note: "v1.0 will rename `tests.total` → `tests.tasks` and promote `tests.individual_total` → `tests.total`." Preserves PRODUCT success criterion 4.

**Migration order with per-feature acceptance criteria** (smallest blast radius first):

---

#### Sub-entry 1 — `benchmark` migration (warm-up; smallest blast radius)

**Migration PR title:** `feat(node): migrate benchmark orchestrator to lib/benchmark-orchestrator.js`

1. **Input contracts (wrapper passes through verbatim):** flags `--project-root`, `--config {smoke|main|stress}`, `--platform {all|jvm|android}`, `--module-filter`, `--include-shared`, `--test-filter`, `--ignore-jdk-mismatch`, `--java-home`, `--no-jdk-autoselect`, `--dry-run`, `--json`, `--force`. Env vars `JAVA_HOME`, `KMP_TEST_SKIP_ADB`, `KMP_GRADLE_TIMEOUT_MS`. No `SKIP_*_MODULES` apply.
2. **Output contract:** preserves the unique top-level `benchmark:{config,total,passed,failed}` envelope field (parsed today by `parseBenchmarkSummary`); preserves per-subcommand envelope `{tests,modules,skipped,coverage,errors,warnings}`. **Adds:** `benchmark.platforms:["jvm","android"]` enum array reflecting which legs ran.
3. **Test plan:** `tests/vitest/benchmark-orchestrator.test.js` snapshots for `--platform jvm` task dispatch, `--platform android` adb resolution + `instrumented_setup_failed` error; contract that no benchmark module → `errors[].code:"no_test_modules"` (NOT `no_summary`); regression that empty result sets do not throw. **e2e on mom's MacBook:** `cd Confetti && kmp-test benchmark --config smoke` exits 0 (today: WS-2 crashes with `declare -A`); `cd PeopleInSpace && kmp-test benchmark --json` round-trips through `JSON.parse`.
4. **Bugs closed by construction:** **WS-2** (`declare -A` Bash 4+ crash on macOS Bash 3.2.57 — JS has no Bash version dependency); empty-array under `set -u` landmines surfaced during PR #105 (same bug class).
5. **LOC delta:** 538 (sh) + 471 (ps1) = **1,009** today → ≤50 + ≤50 wrappers + ~250-350 in `lib/benchmark-orchestrator.js`. **Net: ~-600 LOC (40% reduction).**
6. **Risks / gotchas:** `tests/bats/test-benchmark.bats` + `tests/pester/Benchmark-Detect.Tests.ps1` shrink to wrapper-invocation contracts. Preserve `[OK] / [FAIL]` per-module banner lines (humans grep these). No cross-feature coupling — benchmark dispatches its own `:module:jvmBenchmark` / `:module:android*Benchmark` tasks.

---

#### Sub-entry 2 — `changed` migration

**Migration PR title:** `feat(node): migrate changed orchestrator to lib/changed-orchestrator.js`

1. **Input contracts:** flags `--project-root`, `--include-shared`, `--test-type {all|common|androidUnit|androidInstrumented|desktop|ios|macos}`, `--staged-only`, `--show-modules-only`, `--max-failures`, `--min-missed-lines`, `--coverage-tool`, `--exclude-coverage`, `--exclude-modules`, `--include-untested`, `--test-filter`, `--ignore-jdk-mismatch`, `--java-home`, `--no-jdk-autoselect`, `--no-coverage`, `--dry-run`, `--json`, `--force`. Env vars: benchmark set + `SKIP_DESKTOP_MODULES` / `SKIP_ANDROID_MODULES` / `SKIP_IOS_MODULES` / `SKIP_MACOS_MODULES` / `PARENT_ONLY_MODULES` (consumer-config API per `CLAUDE.md` "Decouple from L0" exemption — must remain stable).
2. **Output contract:** standard envelope. **Adds:** `changed:{detected_modules:[], staged_only:bool, base_ref:"HEAD"}` top-level field giving agents structured visibility into git-diff-to-module mapping. **Adds discriminator:** `errors[].code:"no_changed_modules"` (clean zero-set, distinct from `no_test_modules` "filter rejected everything").
3. **Test plan:** `tests/vitest/changed-orchestrator.test.js` contracts that git-diff-to-module mapping walks all 18 source-set leaves from `lib/project-model.js#sourceSetNames` (the v0.7.0 walker); `--staged-only` uses `git diff --cached`; zero detected modules → `no_changed_modules` + `exit_code:0`. **e2e:** `cd Confetti && touch shared/src/commonMain/kotlin/dev/johnoreilly/confetti/Model.kt && kmp-test changed --show-modules-only --json` → `changed.detected_modules:["shared"]` (today WS-4 reproducer returns `[]`); `cd PeopleInSpace && git stash && kmp-test changed --json` → `errors[0].code:"no_changed_modules"`, `exit_code:0`.
4. **Bugs closed by construction:** **WS-4** (changed does not detect modifications under source-set dirs); **half of UX-1** (modules with `commonTest` but no `jvm()`/`androidTarget()` — emits `skipped[]` with reason instead of dropping silently; full fix in sub-entry 5); jvm()→jvmTest fallback consumed from project-model fix.
5. **LOC delta:** 292 (sh) + 314 (ps1) = **606** today → ≤40 + ≤40 wrappers + ~200-300 in `lib/changed-orchestrator.js`. **Net: ~-280 LOC (46% reduction).**
6. **Risks / gotchas:** `tests/bats/test-changed.bats` shrinks to wrapper contract. **No dedicated Pester test** for `changed` exists today (only implicit via `Invoke-ScriptSmoke.Tests.ps1`); migration adds vitest as primary suite, removing the implicit Pester gap. Preserve `[SKIP] <module>` stdout banners + `--staged-only` semantics + `SKIP_*_MODULES` env API. **Cross-feature coupling:** changed delegates execution to the parallel suite. PR2 keeps the subprocess invocation initially; PR5 refactors to direct in-process call.

---

#### Sub-entry 3 — `android` migration

**Migration PR title:** `feat(node): migrate android orchestrator to lib/android-orchestrator.js`

1. **Input contracts:** flags `--project-root`, `--device <serial>`, `--module-filter`, `--skip-app`, `--verbose`, `--flavor`, `--auto-retry`, `--clear-data`, `--list | --list-only`, `--test-filter`, `--device-task <name>` (KMP `androidLibrary { }` DSL escape hatch), `--ignore-jdk-mismatch`, `--java-home`, `--no-jdk-autoselect`, `--dry-run`, `--json`, `--force`. Env vars: `JAVA_HOME`, `KMP_TEST_SKIP_ADB`, `KMP_GRADLE_TIMEOUT_MS`.
2. **Output contract:** standard envelope; `parseAndroidSummary` (`lib/cli.js:878`) already in Node and stays put. **Adds:** `android:{device_serial, device_task, flavor, instrumented_modules:[]}` top-level field (closes WS-10's empty-name renderer by construction — orchestrator builds the rendered list from the same data the count derives from). Preserves discriminators `instrumented_setup_failed` / `task_not_found` / `unsupported_class_version`.
3. **Test plan:** `tests/vitest/android-orchestrator.test.js` contracts that module detection consolidates through `lib/project-model.js#resolveTasksFor` `deviceTestTask` (same source as `parallel --test-type androidInstrumented` — closes WS-3); `--list-only` never renders empty names (closes WS-10); no adb device → `errors[].code:"instrumented_setup_failed"`, `exit_code:3` (NOT silent pass — per PRODUCT criterion 5); `--device-task` override propagates verbatim. **e2e on mom's MacBook** (S22 Ultra `R3CT30KAMEH`): `cd Confetti && kmp-test android --json` → 4 modules detected (matches `parallel --test-type androidInstrumented`); `--list-only` renders 4 non-empty names; `adb kill-server; cd KaMPKit && kmp-test android` → `instrumented_setup_failed`.
4. **Bugs closed by construction:** **WS-3** (`kmp-test android` finds 0 modules where `parallel` finds 4 — single source of truth via project model); **WS-10** (`--list-only` empty-name renderer). **Adb-orphan flake** in `tests/installer/install.bats` on macos-latest may close as a side-effect (orchestrator honors `KMP_TEST_SKIP_ADB=1`); defer formal closure until empirically validated post-migration.
5. **LOC delta:** 784 (sh) + 649 (ps1) = **1,433** today → ≤50 + ≤50 wrappers + ~400-500 in `lib/android-orchestrator.js`. **Net: ~-880 LOC (61% reduction — largest single drop, due to accumulated KMP DSL detection complexity in bash).**
6. **Risks / gotchas:** `tests/bats/test-android.bats` + `test-android-summary-counts.bats` and `tests/pester/Android-Summary-Counts.Tests.ps1` shrink to wrapper contracts. `parseAndroidSummary` + `parseAndroidModuleTableFallback` stay put (orchestrator emits the same banner shape). Preserve `JSON SUMMARY` block on stdout, per-module log files at `<project>/build/logcat/<run-id>/` surfaced via `errors[].log_file` / `logcat_file` / `errors_file` (Bug G v0.5.2), and the `--device-task` escape hatch.

---

#### Sub-entry 4 — `coverage` migration (script not yet thin — see sub-entry 5)

**Migration PR title:** `feat(node): migrate coverage orchestrator to lib/coverage-orchestrator.js`

> Note: `coverage` and `parallel` share `run-parallel-coverage-suite.{sh,ps1}` (per `lib/cli.js:45`, `coverage` = `parallel --skip-tests`). This PR migrates only the coverage-only codepath (`--skip-tests` branch + Kover/JaCoCo discrimination + report aggregation). The wrapper becomes fully thin only after sub-entry 5.

1. **Input contracts:** flags `--project-root`, `--coverage-tool {auto|jacoco|kover|none}`, `--coverage-modules`, `--min-missed-lines`, `--exclude-coverage`, `--output-file <name>` (default `coverage-full-report.md`), `--ignore-jdk-mismatch`, `--java-home`, `--no-jdk-autoselect`, `--no-coverage`, `--dry-run`, `--json`, `--force`. Env vars: same as benchmark.
2. **Output contract:** preserves `coverage:{tool, missed_lines, modules_contributing}`. **Adds:** `coverage.modules_with_kover_plugin:[]` and `coverage.modules_with_jacoco_plugin:[]` (consumes `lib/project-model.js#detectBuildLogicCoverageHints` already there). **Adds:** `warnings[].code:"coverage_aggregation_skipped"` when `--coverage-tool none` (today logged-only).
3. **Test plan:** `tests/vitest/coverage-orchestrator.test.js` contracts that Kover/JaCoCo plugin discrimination consumes existing CONVENTION-vs-SELF detection (v0.6 Bug 6) without behavior change; `--skip-tests` skips the dispatch loop entirely; zero coverage data → `warnings[].code:"no_coverage_data"` (existing v0.5.2 Bug E). **e2e:** `cd Confetti && kmp-test coverage --json` after a prior `parallel` run → `coverage.modules_contributing > 0`, `errors:[]`; `cd KaMPKit && kmp-test coverage --no-coverage --json` → `warnings[0].code:"coverage_aggregation_skipped"`, `exit_code:0`.
4. **Bugs closed by construction:** the **4 bash-side coverage helpers** deferred from Gap A scope-reduction at PR #67 — `detect_coverage_tool` (sh) + `get_coverage_gradle_task` (sh) + ps1 mirrors of both. The legacy chain was kept "load-bearing for projects without a model.json"; `lib/project-model.js` now carries that fallback path, so the helpers can finally be deleted.
5. **LOC delta** (within `run-parallel-coverage-suite.{sh,ps1}` only — script is not yet thin): coverage-specific subset ~300 LOC (sh) + ~280 LOC (ps1) = **~580** today → ~50 LOC of pass-through inside the script + ~150-200 in `lib/coverage-orchestrator.js`. **Net this PR: ~-300 LOC inside the parallel script.**
6. **Risks / gotchas:** `tests/bats/test-coverage.bats`, `test-build-logic-coverage-kind.bats`, `test-build-logic-selective-jacoco.bats` keep their behavioral contracts (project-model JS unchanged) — they shift from "tested via shell stub" to "tested via vitest stub" patterns. Pester equivalents same shape shrink. Preserve `coverage-full-report.md` filename + run-id naming (`coverage-full-report-<id>.md` per v0.3.8 lockfile work) and Markdown report structure (humans render this). **Cross-feature coupling — heavy:** must ship this PR before sub-entry 5; otherwise parallel-orchestrator subsumes everything and there is nothing to migrate.

---

#### Sub-entry 5 — `parallel` migration (largest; completes v0.8 PIVOT)

**Migration PR title:** `feat(node): migrate parallel orchestrator to lib/parallel-orchestrator.js`

1. **Input contracts (full set):** flags `--project-root`, `--include-shared`, `--test-type {all|common|androidUnit|androidInstrumented|desktop|ios|macos}`, `--module-filter`, `--test-filter`, `--max-workers`, `--coverage-tool`, `--coverage-modules`, `--min-missed-lines`, `--exclude-coverage`, `--exclude-modules`, `--include-untested`, `--timeout`, `--ignore-jdk-mismatch`, `--java-home`, `--no-jdk-autoselect`, `--no-coverage`, `--skip-tests` (used by coverage subcommand), `--dry-run`, `--json`, `--force`. Env vars: `JAVA_HOME`, `KMP_TEST_SKIP_ADB`, `KMP_GRADLE_TIMEOUT_MS`, `SKIP_DESKTOP_MODULES`, `SKIP_ANDROID_MODULES`, `SKIP_IOS_MODULES`, `SKIP_MACOS_MODULES`, `PARENT_ONLY_MODULES`, `FRESH_DAEMON`.
2. **Output contract:** full envelope `{tool, subcommand, version, project_root, exit_code, duration_ms, tests:{total,passed,failed,skipped}, modules:[], skipped:[], coverage:{...}, errors:[], warnings:[], gradle_config?:{...}}`. **Critical fix:** `modules:[]` populated when `tests.passed > 0` (closes WS-9 — today empty even on passing runs because the report-builder is keyed off coverage data presence, not test execution). **Additive WS-8 fix:** new field `tests.individual_total` aggregated from junit-XML walk under `<module>/build/test-results/<task>/TEST-*.xml`. `tests.total` keeps task-count semantic untouched (no major bump). **Discriminator fix (UX-2):** message text "No modules found matching filter: *" → "No modules support the requested --test-type=<X>" when filter is `*` AND `--test-type` is the cause. **Discriminator addition:** `errors[].code:"platform_unsupported"` when `--test-type ios|macos` is invoked on Windows/Linux (per PRODUCT.md "platform-aware behavior" bullet 1).
3. **Test plan:** `tests/vitest/parallel-orchestrator.test.js` contracts: `--test-type all` dispatches one set per supported type and aggregates (closes WS-6); `--test-type common` design decision (alias-with-doc OR `--test-type jvm` rename with deprecation; lands in PR description); `tests.individual_total` populates from junit-XML walking (closes WS-8); `modules[]` populated even with zero coverage data (closes WS-9); empty array under strict mode does not throw (locks v0.7.x SKIPPED_MODULES Bash-3.2 fix into JS forever); `--test-type ios` on Linux/Windows → `errors[].code:"platform_unsupported"`. **e2e on mom's MacBook:** `cd Confetti && kmp-test parallel --test-type ios --json` → PASS only on iOS-capable modules + rest emit `skipped[]` with reason "no iosX64()/iosSimulatorArm64() target" (closes UX-1 fully); `cd PeopleInSpace && kmp-test parallel --test-type all` → all 5+ test types invoked (closes WS-6); `cd KaMPKit && kmp-test parallel --test-type common --json` → "No modules support the requested --test-type=common" message text (closes UX-2); `--test-type ios` on Windows host → `errors[0].code:"platform_unsupported"`, `exit_code:3`.
4. **Bugs closed by construction:** **WS-4** (changed delegates to parallel-orchestrator — closed here at the execution layer); **WS-6** (`--test-type all` does not span all types); **WS-7** (`--test-type common` maps to desktopTest — design decision); **WS-8** (additive `tests.individual_total`); **WS-9** (`modules:[]` empty when `tests.passed > 0`); **UX-1** full fix (the partial sub-entry 2 fix at the changed layer becomes complete here); **UX-2** (misleading filter message); **jvm()→jvmTest fallback** (BACKLOG entry 133-162; orchestrator consumes `unitTestTask` from resolved project-model instead of hardcoding `desktopTest`); **PRODUCT charter alignment** via `platform_unsupported` error code.
5. **LOC delta** (residual after PR4 coverage extraction): `run-parallel-coverage-suite.sh` ~1,400 LOC + `.ps1` ~1,200 LOC = **~2,600** at start of PR5 → ≤80 LOC + ≤80 LOC wrappers + ~600-800 in `lib/parallel-orchestrator.js`. **Net this PR: ~-1,740 LOC (largest single migration delta).** **Cumulative across all 5 sub-entries:** bash + ps1 6,196 → ~470 (12× reduction); new `lib/<feature>-orchestrator.js` aggregate ~1,800-2,400 LOC covered by a single vitest matrix on Linux+Mac+Windows. **Net product LOC reduction: ~3,200-3,800 LOC, ~50%, with the bug-prone half eliminated.**
6. **Risks / gotchas:** the largest test surface in the repo lives here. `tests/bats/test-parallel.bats`, `test-parallel-ios-dispatch.bats`, `test-task-not-found.bats`, `test-module-exclusion.bats`, `test-ios-macos-support.bats`, `test-js-wasm-support.bats`, `test-jdk-gate.bats`, `test-deprecation-notice.bats`, `test-gradle-tasks-probe.bats`, `test-version-catalog-alias.bats` and Pester mirrors all shrink to wrapper-invocation contracts. `gradle-plugin/src/test/kotlin/` TestKit suite (9 tests including parameterized `CrossShapeParityTest`) **must not change** — plugin-side contracts (task names, property names, exit codes) stay identical. Preserve all 6 envelope fields (additions OK; renames forbidden without major bump per PRODUCT criterion 4); banner shape `[OK] / [FAIL] / [SKIP]`; lockfile `.kmp-test-runner.lock` shape (already in `lib/cli.js#acquireLock` — preserved by construction); `--coverage-tool auto` Kover/JaCoCo discrimination chain; run-id naming (`gradle-parallel-tests-<id>.log`). **Terminal cross-feature coupling:** this is the LAST migration. After it lands, `bats-macos` informational job can be removed (no remaining Bash plumbing) and `gradle-plugin-test-ios` can be promoted from informational to required (no remaining BSD-vs-GNU shell drift surface).

**Effort:** ~2-4 weeks of focused work (rough). Each feature migration is 1-3 days. Spread across v0.8.0 milestone.

**What this means for pending bugs (WS-3..WS-10, jvm()→jvmTest):**

- **Hold all bash-side patch PRs.** Opening more `fix(...)` PRs for these bugs is patching code that's scheduled for migration.
- The bugs themselves don't disappear — they get fixed AS PART OF each feature's migration PR. Each migration PR description must explicitly note which WS-* / UX-* / discovery bugs it resolves.
- BACKLOG entries below are **not deleted** — they document the bugs to verify against in the migration PR test plans.

**What this means for the `bats-macos` informational job (added PR #105):**

Stays in CI as a regression-guard against Bash 3.2 patterns in the remaining bash plumbing during the transition. Removed in the PR that completes the migration. Adb-orphan flake (separate BACKLOG entry below) gets investigated only if it blocks Mac-side smoke testing of migration PRs.

**Next session start:**

1. Draft `PRODUCT.md` codifying the 5 strategic answers (~30-60 min, repo owner drives, agent listens).
2. Refine this BACKLOG entry into a per-feature migration plan with concrete acceptance criteria.
3. Open first migration PR: `feat(node): migrate benchmark orchestrator to lib/benchmark-orchestrator.js`. Validates the pattern end-to-end before committing to the larger features.

---

#### v0.8.0 — Release readiness gate (post Sub-entry 5)

Once Sub-entries 1-5 land, the v0.8.0 stamp does NOT ship until the four gates below are green. Surfaced 2026-05-02 during Sub-entry 2 review: PRODUCT.md success criterion #2 ("OS parity. Windows / Linux / macOS all behave identically modulo platform constraints") is enforced today only at the docs-text level — there is no CI workflow that verifies cross-OS parity of the `--json` envelope, and no green CI history for real iOS / macOS test execution on macOS hosts. Without these gates, "iOS works on macOS" rests on the maintainer's local wide-smoke alone, which doesn't survive in green/red CI history.

This entry is the **terminal acceptance criteria** for the v0.8 PIVOT. It is not a sixth sub-entry — Sub-entries 1-5 stand alone. This is the release-readiness work that runs once Sub-entry 5 closes the bash → Node migration.

1. **Cross-OS CLI parity workflow (NEW `cross-os-parity.yml`).** Matrix `{ubuntu-latest, windows-latest, macos-latest}` runs `kmp-test {parallel,changed,coverage,android,benchmark} --json --dry-run` against `tests/fixtures/kmp-cross-platform-e2e/` (see gate 2). For each subcommand, diff the captured envelope across the three OSes modulo an explicit allowlist of platform-specific fields (`android.device_serial`, `errors[].code:"platform_unsupported"` on Win/Linux for `--test-type ios|macos`, OS-specific paths in `project_root`, etc.). Fail the job if any non-allowlisted field diverges. **Effort: ~2-3h** (workflow + diff logic in Node + allowlist documentation). Becomes a **required** check on the v0.8.0 release PR.

2. **Buildable cross-platform E2E fixture promoted from "v0.7.x patch / v0.8.0 minor / v1.0" to v0.8.0 release-blocker.** The "Buildable cross-platform E2E fixture project" entry below (currently scoped flexibly across releases) is reclassified as a v0.8.0 dependency. The fixture under `tests/fixtures/kmp-cross-platform-e2e/` must include real `gradle/wrapper/`, `gradlew[.bat]`, KMP modules with every supported target (`jvm`, `js(IR)`, `wasmJs`, `iosX64+iosSimulatorArm64`, `macosArm64`, `androidLibrary`/`androidTarget`), pinned Kotlin + AGP versions, and a trivial passing test in each test source set. The `e2e (macos-latest)` leg of the new `e2e-cross-platform.yml` workflow boots an iOS simulator and runs `:module:iosSimulatorArm64Test` + `:module:macosArm64Test` for real (not just dispatch). **This is the only place where iOS actually runs in CI.** Effort estimate from the existing entry stands: ~6-10h fixture + flakiness budget.

3. **Branch-protection promotions.** `bats-macos` and `gradle-plugin-test-ios` move from informational to **required** status checks on `develop` and `main`. Promotion criteria: each must be green on at least 5 consecutive PRs after Sub-entry 5 lands (de-flake confidence — the bats-macos hang in `tests/bats/` and the install.bats adb-orphan flake must both be addressed first). The new `cross-os-parity` (gate 1) and `e2e (macos-latest)` (gate 2) jobs also become required at the same promotion. Effort: ~1-2h (manual `Settings → Branches → Edit rule` per CLAUDE.md "Adding a new required check" + verification PR).

4. **Wide-smoke release validation on the maintainer's macOS.** Per existing `feedback_e2e_validate_as_you_go` memory, run all 5 subcommands × `{Confetti, KaMPKit, PeopleInSpace}` × `{--test-type all, androidUnit, androidInstrumented, common, desktop, ios, macos}` matrix on the maintainer's macOS before tagging v0.8.0. This is **in addition to** (not instead of) the synthetic E2E in gate 2 — the synthetic catches deterministic regressions; wide-smoke catches integration-level surprises against real-world projects with pinned dependencies the maintainer doesn't control. Hardware: Galaxy S22 Ultra connected for Android instrumented; iOS 26.4 Simulator runtime; JDK catalogue 11/17/21. Logs preserved on the host machine. Effort: ~2-3h ad-hoc.

**Why this gate exists explicitly (vs leaving Sub-entry 5's existing acceptance line "the largest test surface in the repo lives here" load-bearing):**

- Sub-entry 5 acceptance criteria validate `--test-type ios → PASS only on iOS-capable modules + rest skipped[]`. That's the **detection** path — it doesn't validate that simulator boot + test execution actually work end-to-end on macOS. iOS on macOS could silently regress and Sub-entry 5 vitest + bats would still go green.
- Sub-entry 5 risks-line mention of "`gradle-plugin-test-ios` can be promoted from informational to required" is informational, not a blocking criterion. This entry makes it blocking.
- v0.8.0's pitch is "no more Bash bug class on macOS, OS parity is honest". Without gates 1+2 enforcing in CI, the pitch rests on local wide-smoke that doesn't survive PR rotation.

**Effort total: ~10-15h.** Spread across the v0.8.0 release ramp after Sub-entry 5 merges, before tagging `v0.8.0`. Each gate is independent (can be parallelized across multiple PRs).

**Out of scope for this entry:**
- Promoting `installer-e2e (macos-latest)` to required — it's already required in the existing 7-check matrix.
- Re-using an existing OSS KMP project as the cross-platform E2E fixture — see Buildable cross-platform E2E fixture entry below for that decision.
- ~~New CLI features.~~ **Carve-out (2026-05-03):** the project-level config file entry below (covers `sharedProjectName` + stable defaults) IS in v0.8.0 scope — closing the README ↔ tool surface gap honestly requires it rather than just deleting the misleading flag doc line.

### v0.8 — ✅ Silent-pass class FIXED — but the unsilenced REDs surfaced 3 more pre-existing bugs (2026-05-03)

**Status: silent-pass class FIXED + parseSettingsIncludes phantom-module FIXED + stderr filter WIDENED. Still outstanding: 2 pre-existing bugs that were hidden behind silent-pass and need their own investigation.**

**What's fixed in commits on `fix/windows-spawn-einval`:**

1. **Spawn EINVAL** — `lib/orchestrator-utils.js#spawnGradle` (cmd.exe wrapper + `windowsVerbatimArguments:true`); 5 spawn sites in parallel/android/benchmark routed through it. Defense-in-depth in `classifyTaskResults` (legExit + no positive evidence → 'failed'). Stale-junit guard (mtime gate). 9 new e2e cases with real spawn (`tests/vitest/e2e-spawn-gradle.test.js`).

2. **Phantom commented modules** — `lib/project-model.js#parseSettingsIncludes` did NOT strip Kotlin comments before matching `\binclude\b`, so `// include(":benchmark-android-test")` was treated as a live module. Gradle then errored at task resolution (`project 'benchmark-android-test' not found`), which combined with EINVAL silent-pass produced the false GREEN. Fixed by mirroring `orchestrator-utils.js#stripKotlinComments`. Schema bumped 2 → 3 to invalidate stale `.kmp-test-runner-cache/model-*.json` entries that contain phantom modules. 4 regression tests added in `tests/vitest/project-model.test.js`.

3. **stderr filter swallowed gradle's actual error context** — `executeLeg`'s pre-fix filter only forwarded lines matching `Cannot locate|FAILURE:|BUILD FAILED|UnsupportedClassVersionError|Failed to install`. The `* What went wrong:`, `> Could not resolve`, `Android Gradle plugin requires Java 17` and similar diagnostic blocks were dropped. Widened to forward `> Task :*`, `* What went wrong:`, `* Try:`, `Caused by:`, AGP/JDK requirement messages, plugin-resolution errors, and capped at 60 lines/leg with a "(N more suppressed)" footer. Wide-smoke surfaced TaskFlow's actual error: `Android Gradle plugin requires Java 17 to run. You are currently using Java 11`.

**Wide-smoke trajectory across 6 fix passes:**

| Verdict | Broken | P1 spawn | P2 +strip+stderr | P3 +AGP+cascade | P4 +per-mod-isolation | P5 +jvm("name")+hierarchy | P6 +variant+sdk+default-jvm |
|---|---:|---:|---:|---:|---:|---:|---:|
| SILENT-FAKE-PASS | 14 | **0** ✅ | 0 | 0 | 0 | 0 | 0 |
| REAL-GREEN | 0 | 0 | 3 | 6 | 5 | 6 | **8** |
| REAL-RED | 0 | 14 | 11 | 8 | 9 | 8 | 6 |
| NO-MODULES | 9 | 9 | 9 | 9 | 9 | 9 | 9 |

P6 flips: `dipatternsdemo`, `PeopleInSpace-main` to GREEN (instrumented-only skip + default jvm() detection + ANDROID_HOME auto-set). The 6 remaining REDs are honest:
- `DawSync` — 5 tests desync with refactored production
- `OmniSound` — 1 missing `DesktopPKCEGenerator` cascades 7 features
- `gyg` — 1 real test failing (`LoadingAndErrorStatesTest`)
- `nav3-recipes` — `NavigatorTest.kt` references removed `RouteV2`/`Navigator`
- `nowinandroid` — `:foryou:impl` Prod variant missing dep + 2 real tests
- `Confetti-main` — `:wearApp` 2 real tests fail (`WorkManagerTest`, `ComplicationScreenshotTest`)

Notable per-project flips:
- **shared-kmp-libs**: silent-pass-38 → cross-contaminated-37-fail → 35/2 → 35/2 → **63/0** (jvm("desktop") fix unlocked all modules)
- **TaskFlow**: silent-pass-1 → JDK-mismatch-fail → JDK-mismatch-fail → **PASS** (AGP-aware JDK fix)
- **Confetti-main**: silent-pass-4 → cascade-fail-4 → fake-green-via-cascade → REAL-RED-2/2 (cascade isolation honest, then per-module isolation honest)
- **nowinandroid**: silent-pass-14 → real-RED → real-RED (real Kotlin compile error in `:feature:foryou:impl` — repo bug, not CLI)

REAL-GREEN flips after Pass 3: TaskFlow (AGP 8.8.2 → JDK 17 picked correctly), Confetti-main (cascade-isolation: `:shared:jvmTest` succeeds when isolated from broken `:androidApp`), kotlinconf-app-main + FileKit-main (cache invalidation + AGP fix). Pre-existing REAL-GREEN: android-challenge, androidify-main.

**The 8 remaining REAL-REDs** (decompose by root cause):

- **2 are REAL test failures** — gyg (`LoadingAndErrorStatesTest.errorStateWithRetryShowsButton FAILED`), nowinandroid (`feature:foryou:impl` + `lint` test tasks fail). The CLI is correctly surfacing real project bugs.
- **1 is a project-model task-name discovery bug** — shared-kmp-libs sends gradle `:core-X:desktopTest` for 37 modules; gradle says `Cannot locate tasks that match` for each one (per-module retry confirmed each individually fails). The convention plugin shape is registering tasks under different names than the project model expects. Separate v0.7.x BACKLOG entry candidate.
- **5 need per-project investigation** — DawSync, OmniSound, dipatternsdemo, nav3-recipes, PeopleInSpace — could be real test failures, JDK/dep issues, or more orchestrator bugs. The widened stderr filter now exposes their real errors so investigation is straightforward.

**The 11 REAL-REDs decompose as follows (root-cause categories that the orchestrator could mitigate but doesn't yet):**

- **JDK auto-select picks the bytecode `jvmTarget` instead of AGP's required runtime JDK.** TaskFlow has `jvmTarget = "11"` in `app/build.gradle.kts` so the orchestrator chose JDK 11; AGP 8.8.2 needs JDK 17 to RUN (separate from bytecode target). Manual `JAVA_HOME=jdk-17 ./gradlew :app:testDebugUnitTest` → BUILD SUCCESSFUL in 1m 8s. Affects: TaskFlow, possibly DawSync / OmniSound / dipatternsdemo / gyg / nav3-recipes / FileKit (all show similar fast-fail patterns). Fix: in `lib/jdk-catalogue.js` discoverer / `lib/cli.js#preflightJdkCheck`, prefer the AGP-version-implied JDK over the project's `jvmTarget`. AGP version → required JDK table is publicly documented (`https://developer.android.com/build/releases/gradle-plugin#compatibility`).

- **One-shot multi-module dispatch + `--continue` + evaluation-time abort cascades.** When the orchestrator dispatches `:a:test :b:test :c:test` in ONE gradle invocation, if module A fails at evaluation phase (plugin resolution, AGP-JDK mismatch, missing SDK), gradle aborts BEFORE reaching B and C. defense-in-depth correctly marks all three as failed (none have `> Task :foo:bar` evidence in stdout). Confetti-main reproduces this: `:shared:jvmTest` succeeds in 1m 44s when invoked alone, fails when bundled with `:androidApp:testDebugUnitTest` whose evaluation aborts. Affects: Confetti-main, shared-kmp-libs (37 modules cascade-fail because some configuration bug aborts the whole graph), OmniSound, etc. Fix options: (a) per-module gradle dispatch (slower but isolates failures); (b) detect evaluation-phase abort vs task-execution failure and report differently; (c) `--no-continue` retry split when first invocation aborts at evaluation.

- **(Already noted) jvm()→jvmTest fallback** in project model — separate `v0.7.x` BACKLOG entry below; surfaces here as `[SKIP] X (no resolvable test task)` in nowinandroid (4 modules skipped: app, core:database, core:ui, sync:work).

The CRITICAL silent-pass bug IS fixed. These 3 follow-up bugs should each get their own PR and BACKLOG entry. Defense-in-depth means they now produce HONEST RED instead of silent GREEN — already a major win for AI-agent users who can no longer be misled.

**Severity: CRITICAL. Blocks v0.8.0 release. Every parallel/coverage/changed/android/benchmark invocation on Windows produces false-positive PASS envelopes.** PRODUCT.md WS-1 contract ("never silent pass") violated by every dispatch in the migrated orchestrators on win32.

**Repro:**
```bash
node bin/kmp-test.js --json parallel --project-root C:/path/to/any-gradle-project --no-coverage --max-workers 4
# → exit_code:0, tests.passed = modules.length, parallel.legs[0].exit_code:1, duration_ms:11-722
```

**Root cause:** Node `spawnSync("gradlew.bat", args, { ... })` on Windows returns `status:null, error:'EINVAL'` because Node 18.20.2 / 20.12.2 / 22.0.0+ enforce CVE-2024-27980 which forbids direct `.bat`/`.cmd` execution without `shell:true` or explicit `cmd.exe /c` invocation. **All 5 migrated orchestrators (`parallel`, `coverage`, `changed`, `android`, `benchmark`) call `spawn(gradlewPath, ...)` with `shell:false` (the default).** Verified by direct test:

```js
spawnSync("gradlew.bat", [...], { cwd, encoding:"utf8" })            // → status:null, EINVAL
spawnSync("gradlew.bat", [...], { cwd, encoding:"utf8", shell:true }) // → status:0, real output
```

**The cascade:**
1. `dispatchLeg` calls `spawn(gradlewPath, gradleArgs, {...})` — no `shell:true` (line 409, parallel-orchestrator.js).
2. spawn returns `result.status === null`. Line 416: `const exit = (typeof result.status === 'number') ? result.status : 1;` → exit:1.
3. `result.stdout` and `result.stderr` are both empty strings (gradle never ran).
4. `classifyTaskResults(stdout, stderr, taskList)` (line 424) checks the empty `all` for `<task>\s+FAILED` regex → no match → defaults to `'passed'` (line 439: `out.set(task, re.test(all) ? 'failed' : 'passed')`).
5. Per-task loop (line 521-548) emits `[PASS] mod` for every task; `state.tests.passed += 1` for every module.
6. No `errors[]` row added; top-level `exit_code` stays 0.
7. Envelope reports GREEN with `tests.passed = modules.length` for a project where gradle was **never invoked**.

**Wide-smoke evidence** (23 gradle-rooted projects under `C:/Users/34645/AndroidStudioProjects/`, run via `.smoke/run.sh`):

| Project | reported | reality | leg.exit | duration |
|---|---|---|---|---|
| DawSync | GREEN, 20/20 passed, 7393 individual | NEVER RAN (manual `gradlew tasks` → BUILD FAILED 16s) | 1 | 722ms |
| OmniSound | GREEN, 10/10 passed, 4063 individual | NEVER RAN | 1 | 241ms |
| TaskFlow | GREEN, 1/1 passed | NEVER RAN (manual gradle → BUILD FAILED 1s, gradle.properties JAVA_HOME issue) | 1 | 11ms |
| android-challenge | GREEN, 1/1 | NEVER RAN | 1 | 13ms |
| dipatternsdemo | GREEN, 3/3, 68 individual | NEVER RAN | 1 | 116ms |
| gyg | GREEN, 1/1, 26 individual | NEVER RAN | 1 | 20ms |
| shared-kmp-libs | GREEN, 38/38 passed, 317 individual | NEVER RAN | 1 | 681ms |
| nav3-recipes / nowinandroid / Confetti / PeopleInSpace / androidify / kotlinconf / FileKit | GREEN, all passed | NEVER RAN | 1 | 38–143ms |
| dokka-markdown / Nav3Guide-scenes / DroidconKotlin / KMedia / KaMPKit / NYTimes-KMP / Nav3Guide-master / kmp-basic-sample / kmp-production-sample | AMBER (`no_test_modules`) | discovery short-circuited before dispatch | n/a | 11–36ms |

**14 of 14 "green" envelopes are false positives.** The 9 AMBER results never reached `dispatchLeg` (caught at module-discovery stage), so they're correct by accident.

`tests.individual_total` populated values (7393, 4063, 317, 68, 26) are **stale junit XMLs from previous bash-wrapper-era runs** that the v0.7.0 wrapper left on disk under `<module>/build/test-results/`. The walker counts them every time because no recency check exists.

**Why CI didn't catch this:**
- `tests/vitest/parallel-orchestrator.test.js` (48 cases) injects a mock `spawn` that returns synthetic stdout/stderr — never exercises real `spawnSync` on Windows.
- `tests/bats/*` runs on Linux only (no `.bat`).
- `tests/pester/*` exists but the v0.8 PIVOT shrank Pester contracts to "wrapper invokes node" assertions (sub-entry 5 removed `Invoke-ScriptSmoke.Tests.ps1` 206→? lines), losing the integration-test coverage that would have caught EINVAL.
- The `gradle-plugin-test-ios` informational job runs on macOS, not Windows.
- Manual repo-owner testing happened on shared-kmp-libs with `--test-type androidUnit --module-filter X` — same EINVAL bug, but I read the `tests.passed:1` as success during sub-entry 5 dev. (`leg.exit_code:1` was also visible but dismissed at the time.)

**Fix (trivial, ~5 LOC × 5 orchestrators = ~25 LOC):**

```js
// lib/parallel-orchestrator.js (and 4 mirror sites)
const isWin = process.platform === 'win32';
const result = spawn(gradlewPath, gradleArgs, {
  cwd: projectRoot,
  encoding: 'utf8',
  env: { ...env },
  maxBuffer: 64 * 1024 * 1024,
  timeout: opts.timeout > 0 ? opts.timeout * 1000 : undefined,
  shell: isWin,   // ← required for .bat on Node 18.20.2+ / 20.12.2+ / 22+
});
```

Caveats:
- `shell: true` triggers `DEP0190` deprecation warning in Node 22+ ("args not escaped, only concatenated"). For our case (gradle task names: `:mod:taskName` — no shell metachars in module/task names by Gradle convention), this is safe but should be quoted defensively. Cleaner long-term: invoke `process.env.ComSpec || 'cmd.exe'` with `['/d', '/s', '/c', gradlewPath, ...args]` explicitly — bypasses the deprecation entirely.
- `--tests "<filter>"` user input does flow into args; need to ensure proper escaping if going `shell:true` route, OR use the explicit cmd.exe approach.
- Same fix needed in `parallel-orchestrator.js` `--stop` daemon-stop call (line 669).

**Required additional work to PREVENT recurrence:**

1. **Live integration test on Windows CI** — at least one Pester or vitest case that does `spawn(gradlewPath, ['--version'], {...})` against a real fixture and asserts non-null status. Cost: ~20 LOC, would have caught this in PR #110.
2. **Refuse to silent-pass when leg.exit_code !== 0** — even after the spawn fix, `classifyTaskResults` should treat unclassified-tasks-after-failed-leg as `'failed'`, not `'passed'`. Defense in depth against future `[PASS]` fallthroughs. (This is also what F2 / WS-1 contract demands — already a documented invariant per PRODUCT.md.)
3. **Stale-junit guard** — `junitTestCountFor(projectRoot, task)` should filter by `mtime > orchestrator_start_time` to avoid counting prior runs' XMLs.
4. **Pre-release wide-smoke job in CI** — current process is manual repo-owner pass on Windows; should be a `wide-smoke` workflow that runs `kmp-test parallel --json` against the 5-6 curated KMP fixtures listed in PRODUCT.md success criteria + asserts `parallel.legs[*].exit_code === 0` when `tests.passed > 0` (catches the silent-pass invariant).

**Knock-on:** the previously-noted F1 / F2 / F3 findings (above, in earlier draft of this section) still apply but become low-priority. F2 (`--test-type all` double-counting) is even masked by this bug — when the spawn never runs, `--test-type all` reports false GREEN per-leg.

**Recommended sequence:**
1. Hotfix PR `fix(orchestrator): pass shell:true / cmd.exe wrapper on Windows for gradle dispatch` — touches all 5 orchestrators, adds 2-3 vitest/Pester live-integration cases, no new CLI surface.
2. Re-run wide-smoke against 23 projects, capture true GREEN/RED distribution, file follow-up tickets per RED project.
3. Then resume the v0.8.0 release-readiness gate (BACKLOG entry below).

---

### v0.8 — Sub-entry 5 follow-up findings (F1+F2 ✅ FIXED 2026-05-03; F3 still open)

> **NOTE:** these 3 findings were discovered during the same wide-smoke pass as the CRITICAL Windows-spawn bug above. F1 + F2 closed in PR `feature/sub-entry-5-followups` (2026-05-03). F3 remains pending Windows-side repro.

**✅ Finding F1 — `--dry-run` not consumed in 3 of 5 orchestrators (FIXED 2026-05-03).** `changed`, `android`, `benchmark` orchestrators now short-circuit on `--dry-run` before any spawn / git probe / adb probe, emitting `dry_run:true` envelope with subcommand-specific plan fields. +3 vitest cases. Validated e2e on macOS.

**✅ Finding F2 — `--test-type all` per-leg `no_test_modules` forced exit 3 (FIXED 2026-05-03).** Per-leg empties demoted to `warnings[].code:"no_test_modules_for_leg"` when at least one other leg produced test results. +1 vitest case. PR `feature/sub-entry-5-followups`.

**🟡 Finding F3 — `tests.individual_total:0` on AGP-only runs (still open).** The junit-XML walker constructs `<module>/build/test-results/<taskShort>/` from `taskColonPath` (e.g. `:app:testDebugUnitTest` → `app/build/test-results/testDebugUnitTest/`), which IS the canonical AGP path. **The fix as originally described may already be a no-op post-PR #116** (the stale-junit `mtime` guard added there + the existing path construction look correct). Needs concrete Windows-side repro: run `kmp-test parallel --test-type androidUnit --json` against an Android-only project on Windows, capture the actual `<module>/build/test-results/` tree shape, and verify whether (a) AGP still puts XMLs at the expected path, (b) `tests.individual_total` actually reports 0, (c) the walker fails because of nested subdirs, mtime drift, or something else. **Pickup this on Windows next** with a fresh wide-smoke against the maintainer's Android-only projects (TaskFlow, dipatternsdemo, gyg). Fix: only after repro confirms what's actually wrong; speculative "extend walker glob, dedupe by file path" deferred.

### v0.8.0 — JDK auto-select must prefer AGP runtime JDK over project's bytecode `jvmTarget` (surfaced 2026-05-03 wide-smoke; promoted to v0.8.0 release-blocker)

**Surfaced 2026-05-03 during the post-EINVAL wide-smoke pass on Windows.** TaskFlow declares `jvmTarget = "11"` in `app/build.gradle.kts` so the orchestrator's JDK auto-select picks JDK 11; AGP 8.8.2 needs JDK 17 to RUN (separate from bytecode target — bytecode 11 means "produce class files compatible with Java 11 runtime", which is a different question from "what JDK does the gradle build itself need"). Manual override `JAVA_HOME=jdk-17 ./gradlew :app:testDebugUnitTest` → BUILD SUCCESSFUL in 1m 8s, confirming the bug.

**Affected (wide-smoke evidence 2026-05-03):** TaskFlow (definitive); strong fast-fail patterns in DawSync, OmniSound, dipatternsdemo, gyg, nav3-recipes, FileKit. All show JDK-mismatch shape: gradle aborts in <1s with `Android Gradle plugin requires Java 17 to run` once stderr filter widening (PR #116) exposed the real error.

**Fix:** in `lib/jdk-catalogue.js` discoverer and `lib/cli.js#preflightJdkCheck`, when the project applies AGP, prefer the AGP-version-implied JDK over the project's bytecode `jvmTarget`. The AGP → required-JDK mapping is publicly documented at https://developer.android.com/build/releases/gradle-plugin#compatibility (e.g. AGP 8.0+ requires JDK 17, AGP 8.8+ requires JDK 17, AGP 9.0+ requires JDK 21). Resolution precedence:

1. Explicit `--java-home <path>` (user override; trust them)
2. AGP-version-implied JDK if project has AGP plugin AND auto-select catalogue has it
3. `gradle.properties#org.gradle.java.home` if set
4. `org.jetbrains.kotlin.jvmTarget` if no AGP (current behavior for KMP-pure-JVM and Java-only projects)
5. Host default JDK

**Test surface:** `tests/vitest/jdk-catalogue.test.js` + `tests/vitest/cli.test.js`. New cases for: (a) AGP 8.8 + jvmTarget=11 → picks JDK 17, (b) KMP module with jvmTarget=21 + no AGP → picks JDK 21 (existing behavior preserved), (c) explicit `--java-home` always wins.

**Effort:** ~3-4h (catalogue + preflight extension, 4-6 vitest cases, regression test against TaskFlow shape via fixture). 

**Ship-when:** v0.8.0 release-blocker. Land before the wide-smoke release-validation gate (#4 of release-readiness), since the gate's wide-smoke matrix on the maintainer's macOS will REPRODUCE these failures and need them fixed first. Decompose: the 5 per-project investigations (DawSync, OmniSound, dipatternsdemo, nav3-recipes, PeopleInSpace) are blocked by this — once landed, re-run wide-smoke and any persistent REDs are repo-level test failures, not orchestrator bugs.

### v0.8.0 — Cascade isolation: per-module retry when one-shot dispatch aborts at evaluation phase (surfaced 2026-05-03 wide-smoke; promoted to v0.8.0 release-blocker)

**Surfaced 2026-05-03 during the wide-smoke pass on Confetti-main and shared-kmp-libs.** When the orchestrator dispatches `:a:test :b:test :c:test` in ONE gradle invocation with `--continue`, and module `:a` fails at the **evaluation phase** (plugin resolution, AGP-JDK mismatch, SDK location not found, missing dep), gradle aborts BEFORE reaching `:b` and `:c`. The post-#116 defense-in-depth correctly marks all three as failed (none have `> Task :foo:bar` evidence in stdout) — but this is **honest RED for the wrong reason**: `:b` and `:c` would have succeeded in isolation.

**Affected (wide-smoke evidence 2026-05-03):**
- **Confetti-main**: `:shared:jvmTest` succeeds in 1m 44s when invoked alone; fails when bundled with `:androidApp:testDebugUnitTest` whose evaluation aborts. Cascade-isolated retry confirmed `:shared` is real-green.
- **shared-kmp-libs**: 37 modules cascade-fail because some configuration bug aborts the whole graph at evaluation. Per-module retry isolates the actual broken modules.
- Likely affects most multi-module projects with one misconfigured module at evaluation time.

**Note:** PR #116 already added a "one-shot dispatch aborted before any task ran — retrying per-module" path (parallel-orchestrator.js#executeLeg step 4a) which fires when `legExit !== 0 && taskList.length > 1 && !anyTaskMentioned`. It correctly classifies each retry independently. **What's pending:** verifying the cascade isolation handles every shape we've observed (especially mixed evaluation-vs-execution failures in the same dispatch — when SOME tasks ran and SOME aborted) and that it scales to the 37-module shared-kmp-libs case without timing out.

**Fix verification:**
1. Reproduce the Confetti `:shared` ↔ `:androidApp` cascade on Windows; confirm post-#116 retry isolates `:shared` to GREEN.
2. Reproduce the shared-kmp-libs 37-module cascade; confirm per-module retry surfaces which exact modules are broken (not all 37 cascade-failing).
3. Add at least 2 vitest cases that exercise the retry path: (a) leg with 1 evaluation-aborting + 2 succeed-when-isolated, (b) leg with N modules where 1 fails at evaluation.

**Effort:** ~2-3h (mostly verification + vitest; the implementation already landed in PR #116). 

**Ship-when:** v0.8.0 release-blocker. Validates that PR #116's cascade-isolation path is robust enough to ship in the v0.8.0 wide-smoke release-validation gate.

### v0.8.0 — Wide-smoke per-project triage: confirm REDs are repo-level vs orchestrator (surfaced 2026-05-03)

**Surfaced 2026-05-03 wide-smoke against 23 KMP/Android projects on Windows post-EINVAL.** After the spawn fix + 13 collateral fixes (PR #116), the wide-smoke produced 8 REAL-GREEN, 6 REAL-RED, 9 NO-MODULES. The 6 REAL-REDs decompose into:

| Project | Suspected root cause | Confirm in v0.8.0? |
|---|---|---|
| DawSync | 5 tests desync with refactored production | Repo-level (skip) |
| OmniSound | 1 missing `DesktopPKCEGenerator` cascades 7 features | Repo-level (skip) |
| gyg | 1 real test failing (`LoadingAndErrorStatesTest`) | Repo-level (skip) |
| nav3-recipes | `NavigatorTest.kt` references removed `RouteV2`/`Navigator` | Repo-level (skip) |
| nowinandroid | `:foryou:impl` Prod variant missing dep + 2 real tests | Repo-level (skip) |
| Confetti-main | `:wearApp` 2 real tests fail (`WorkManagerTest`, `ComplicationScreenshotTest`) | Repo-level (skip) |

**Plus the 5 per-project investigations** (still pending):
- DawSync, OmniSound, dipatternsdemo, nav3-recipes, PeopleInSpace — flagged as "could be real test failures, JDK/dep issues, or more orchestrator bugs" pre-AGP-JDK fix. Once the AGP-JDK fix above lands, re-run wide-smoke and each of these will resolve to one of: (a) real repo bug → document and skip, (b) orchestrator bug → file own entry.

**Process for v0.8.0:**
1. Land the AGP-JDK fix (entry above).
2. Re-run wide-smoke on Windows + Mac. Capture envelope diffs vs the 2026-05-03 baseline.
3. For each REAL-RED, do a 5-minute triage: read the stderr context (now visible post-PR #116 widening), decide product-bug vs repo-bug.
4. Product-bugs → file own v0.8.0 entry, fix in this milestone.
5. Repo-bugs → document the project + reason in PRODUCT.md "known wide-smoke skip-list" (so v0.8.0 wide-smoke gate doesn't fail on them).

**Effort:** ~3-4h (re-run wide-smoke + triage + filing).

**Ship-when:** v0.8.0 release-blocker, AFTER the AGP-JDK fix lands. Closes the "5 per-project investigations" carve-out from the silent-pass entry.

### v0.8.0 — `resolveTasksFor` returns null when `gradleTasks` is null even though `sourceSets` declares the test set (surfaced 2026-05-02; promoted 2026-05-03)

**Surfaced 2026-05-02 while validating PR #103 (`fix(parallel): proactive iOS/macOS/common/desktop target filter`).** When a KMP module declares `jvm()` (no custom name), Gradle exposes the unit-test task as `:moduleX:jvmTest` — not `:moduleX:desktopTest`. The wrapper hardcodes `desktopTest` for `--test-type common|desktop`. The proactive UX-1 filter from PR #103 now lets such a module slip into the dispatch set; the reactive WS-1 fallback then catches the resulting `Cannot locate tasks that match ':moduleX:desktopTest'` as a real failure (good — no more PASS fantasma). But the user-visible result is still `[FAIL] :moduleX (task not found)`, when the correct behavior would be: per-module task lookup picks `jvmTest` from the project model and runs it green.

**Root cause** (file:line evidence): `lib/project-model.js:697-706` — when `gradleTasks` is null (probe didn't run / cache miss), `resolveTasksFor` returns all task fields as `null` — *even though* the `sourceSets` analysis available alongside it already knows which test source sets exist. Confetti reproducer from cached model `.kmp-test-runner-cache/model-1b53ddf*.json`:

```json
"shared": {
  "type": "kmp",
  "sourceSets": { "jvmTest": true, ...rest false },
  "gradleTasks": null,
  "resolved": { "unitTestTask": null, ... }
}
```

The `sourceSets.jvmTest: true` is enough signal to predict `unitTestTask: "jvmTest"` without a gradle probe — the same way `predictedCoverage` is computed at line 694-696 as a fallback for `coverageTask`. This pattern is missing for the four other resolved fields.

**Reproducer (live):** `cd /Volumes/XcodeOscar/kmp-test-workspace/Confetti && grep -c '":jvmTest"\|"jvmTest "' .kmp-test-runner-cache/tasks-*.txt` → 5 modules with `jvmTest` task; `kmp-test parallel --test-type common --json` → 5 of those are dispatched as `:moduleX:desktopTest`, gradle "Cannot locate", reactive WS-1 catches as FAIL. Direct `./gradlew :shared:jvmTest` → BUILD SUCCESSFUL.

**Fix direction:**

1. **Add `predictTaskFromSourceSets(analysis, candidate)` helper** in `lib/project-model.js` mirroring `predictCoverageTask`. Returns the first candidate task name whose corresponding source set is `true` in `analysis.sourceSets`.
2. **Wire predicted fallbacks into the `gradleTasks==null` branch** for `unitTestTask` / `deviceTestTask` / `webTestTask` / `iosTestTask` / `macosTestTask`. Use the same candidate orders as the populated branch.
3. **Sh + ps1 readers no change needed** — they already consume `unitTestTask` via `pm_get_unit_test_task` (per-module fast path).
4. **Vitest in `tests/vitest/project-model.test.js`** — assert `resolveTasksFor('mod', null, { sourceSets: { jvmTest: true, ...rest false }, type: 'kmp' })` returns `unitTestTask: 'jvmTest'`. Repeat for desktopTest precedence, jsTest fallback, iosSimulatorArm64Test, macosArm64Test.
5. **Bats integration test** — fixture project with a single `jvm()` KMP module + stub gradlew that succeeds on `jvmTest` and fails on `desktopTest`; assert `kmp-test parallel --test-type common` dispatches to `jvmTest`, exit 0, no `Cannot locate` in output.

**Effort: 2-3h** (1h core resolver + tests, 1h fixture + bats integration, 30min sanity-check on Confetti live). Could ship in PR4 (alongside WS-3 which also touches the project-model resolver) or as its own standalone PR. Listed standalone here because it has zero coupling to Android detection (WS-3 territory).

**Cross-references:** complement to v0.7.0 Phase 1 (`unitTestTask` candidate chain landed there with the assumption that `gradleTasks` would be populated). Complement to PR #103 reactive WS-1 fix (which now surfaces this bug as a real FAIL instead of swallowing it).

### v0.8.0 — Adaptive `KMP_GRADLE_TIMEOUT_MS` per benchmark config (surfaced 2026-05-03; promoted to v0.8.0 release-blocker 2026-05-03)

**Surfaced 2026-05-03 during e2e validation of the new `--benchmark` / `--benchmark-config` parallel hook against `shared-kmp-libs:benchmark-io`.** `--config smoke` completes in ~1-3s; `--config stress` legitimately needs 30+ minutes (full JMH warmup + measurement iterations across 5 benchmarks). The orchestrator's default `KMP_GRADLE_TIMEOUT_MS=1800000` (30 min) is calibrated to detect hung daemons but trips on legitimate stress runs.

**Observed behavior (validated):**
- `kmp-test benchmark --config stress --module-filter benchmark-io --platform jvm` against shared-kmp-libs hit the 1800s timeout with the message `"gradle invocation exceeded 1800s timeout — likely a hung daemon"`. Plumbing was correct — task `:benchmark-io:desktopStressBenchmark` dispatched, gradle ran the JMH stress harness, just exceeded the budget.
- Exit code anomaly: orchestrator emits the timeout message but reports exit code 0 to the caller. Pre-existing in benchmark-orchestrator, not introduced by the parallel `--benchmark` hook. Worth a separate audit (timeout-as-warning vs timeout-as-error semantics).

**Proposal — adaptive timeout default by config:**

| `--benchmark-config` | Suggested default `KMP_GRADLE_TIMEOUT_MS` |
|---|---|
| `smoke` (CI / validation) | 300000 (5 min) — generous slack on the 1-3s expected |
| `main` (kotlinx-benchmark default) | 1800000 (30 min) — current default |
| `stress` (real perf measurement) | 3600000 (1 h) — or `0` to disable |

User override via env var continues to win. The `kmp-test benchmark --help` output should mention the implicit per-config defaults so users know what to expect.

**Lift:** 1-2h. `lib/benchmark-orchestrator.js` reads `KMP_GRADLE_TIMEOUT_MS` already; add a config-aware default fallback when env var is unset. Vitest covers the resolution table. Document in README's flag reference.

**Ship-when:** **v0.8.0 release-blocker** (promoted 2026-05-03 — every known bug closes before tag). Lands as a dedicated PR alongside the README refresh.

**Includes (added when promoted to v0.8.0):**
- Fix the exit-code-0-on-timeout discrepancy at the same time. Today the orchestrator emits the timeout warning but reports exit 0 to the caller; this conflates "test passed" and "build hung". Decision: timeout → exit 3 (`errors[].code:"gradle_timeout"`), with `--ignore-gradle-timeout` as the explicit bypass. Closes the audit gap surfaced 2026-05-03 against `--config stress`.

### v0.8.0 — `tests/installer/install.bats` leaves orphan adb process and hangs on macos-latest (surfaced 2026-05-02; promoted 2026-05-03; CLOSED 2026-05-03 by PR #118)

**CLOSED 2026-05-03 by PR #118 (`fix(doctor): skip adb probe via KMP_TEST_SKIP_ADB to fix bats-macos hang`).** Hypothesis-correction note: the original "install.bats spawns adb via `--version`/`--help`" framing was wrong. install.bats E2E tests use a stub `bin/kmp-test.js` (built inline by `setup_e2e_archive`) with no adb codepath; even the real CLI short-circuits `--version`/`--help` at `lib/cli.js:1498-1505` before any subcommand dispatch. The actual leak source was `tests/bats/test-doctor.bats` + `tests/bats/test-concurrency.bats` (the only files that invoke `kmp-test doctor`, which spawns `adb version` at `lib/cli.js:1411`). Fixed by adding a `KMP_TEST_SKIP_ADB=1` env opt-out in `runDoctorChecks` and exporting it from those two bats files' `setup_file` hooks. Empirical validation in PR #118: bats-macos completes in 1m48s vs prior 15-min hang; in-CI `pgrep -af adb` after the suite confirms zero residual adb processes. `tests/installer/` restored in the bats-macos CI scope.

**Surfaced 2026-05-02 by the new `bats-macos` CI job in PR #105 (WS-2 parity).** When `npx bats tests/bats/ tests/installer/` runs on `macos-latest`, the suite passes the first 227 tests cleanly (entire `tests/bats/` directory + part of `tests/installer/install.bats`) in ~3 min, then **hangs for 8 min** on the next test until the 15-min job timeout fires. Cleanup logs show `Terminate orphan process: pid (2875) (adb)` — an `adb` subprocess was spawned by one of the install.bats tests and never reaped, blocking bats's "wait for child to exit" step.

Same symptom referenced in pre-existing comment at `.github/workflows/ci.yml:70-72` ("the wider tests/bats/ suite has a hang on macos-latest"); root cause now narrowed: it's specifically `tests/installer/install.bats` (not the wider `tests/bats/`).

**Reproducer (when bats is installed locally):** `cd kmp-test-runner && /bin/bash -c 'npx bats --timing tests/installer/install.bats'` on macos-latest. Last test that completes is "E2E: install.sh fails when --archive file is missing"; the suite then hangs starting the next test. `pgrep adb` during the hang confirms a leaked daemon.

**Suspect tests:** the install.bats E2E tests run `kmp-test --version` / `kmp-test --help` after install. The `kmp-test doctor` codepath at `lib/cli.js:1306` runs `spawnSync('adb', ['version'], ...)` — on a fresh macos-latest runner without prior adb usage, this triggers `adb start-server` which forks a daemon. Bats then waits for the daemon process tree to terminate. Hypothesis to verify: doctor / version checks are spawning the adb daemon during a wrapper invocation, and bats counts the daemon as a child of the test process.

**Fix candidates:**
1. Add an explicit `adb kill-server || true` in install.bats's `teardown_file()` (or per-test `teardown()`) to reap the daemon.
2. Skip the adb probe in `kmp-test doctor` when `KMP_TEST_SKIP_ADB=1` (env opt-out) and set it in install.bats fixtures.
3. Replace `adb` invocation with a process-group-isolated spawn (`setsid` or `kill -- -$pid` on teardown).

**Workaround in flight (PR #105):** scope `bats-macos` to `tests/bats/` only. The 216 tests in that directory exercise the WS-2 regression coverage and pass in ~3 min. installer-e2e (macos-latest) at `ci.yml:45-77` already runs install.bats E2E with `--filter "E2E"` (different invocation that avoids the hang). Net effect: no parity loss for WS-2; install.bats macOS hang remains as documented follow-up here.

**Effort: 1-2h** to identify the exact test (run install.bats one test at a time on macos-latest with `--filter` until the hang triggers), confirm the adb hypothesis, and pick a fix. Likely option 1 is the minimal change.

### v0.8.0 — `bats-macos` job hangs in `tests/bats/` on macos-latest (surfaced 2026-05-02; promoted 2026-05-03; CLOSED 2026-05-03 by PR #118)

**CLOSED 2026-05-03 by PR #118.** Same root cause as the install.bats entry above — `runDoctorChecks` at `lib/cli.js:1411` spawning `adb version` whose client inherits Node's pipe FDs on macos-latest. The leak fired from `tests/bats/test-doctor.bats` (and to a lesser extent `tests/bats/test-concurrency.bats`'s lockfile-not-acquired test). Fixed by `KMP_TEST_SKIP_ADB=1` env opt-out exported from those files' `setup_file` hooks. The hypothesised BSD signal-delivery alternative for `test-concurrency.bats` (cross-referenced in fix-candidate 2 below) was NOT the cause. With the env-var fix, bats-macos completes in 1m48s and runs the full `tests/bats/ + tests/installer/` scope (parity with the ubuntu bats job). Branch-protection promotion of `bats-macos` to required is now unblocked — promote when v0.8.0 ships.

**Surfaced 2026-05-02 in PR #108** (`docs(backlog): expand v0.8 STRATEGIC PIVOT per-feature migration plan`, doc-only — no `.sh` / `.js` / test changes). The `bats-macos` CI job was cancelled at 15m17s (job `timeout-minutes: 15` at `.github/workflows/ci.yml:124`). The cancelled step is `bats (macOS — Bash 3.2 regression coverage)` which executes `npx bats --timing tests/bats/` (`.github/workflows/ci.yml:131-132`).

**This is a NEW finding distinct from the `tests/installer/install.bats` adb-orphan hang** documented in the entry above:
- The PR #105 workaround (BACKLOG entry above, "Workaround in flight") explicitly scoped `bats-macos` to `tests/bats/` only, claiming "the 216 tests in that directory exercise the WS-2 regression coverage and pass in ~3 min." That assumption no longer holds: the same scope now hangs >15 min.
- This PR (#108) modified only `BACKLOG.md`. No script, lib, or test files changed. The hang was therefore present in `develop` HEAD `d02b2f7` already and was not surfaced because PR #105's `bats-macos` introduction predated this run.

**Evidence:**
- Run URL: `https://github.com/oscardlfr/kmp-test-runner/actions/runs/25251117434/job/74043227381`
- Job conclusion: `cancelled` (15m17s wall time)
- Steps before the cancelled bats step: `Set up job` / `actions/checkout` / `actions/setup-node` / `npm ci` — all `success` → setup is not the culprit, the hang is in `npx bats tests/bats/` itself.
- Other macOS jobs in the same run completed cleanly: `build (macos-latest)` 12s pass, `installer-e2e (macos-latest)` 12s pass, `gradle-plugin-test-ios` 3m pass. None of them invoke `bats tests/bats/`.

**Reproducer (when bats is installed locally on macos-latest):** `cd kmp-test-runner && /bin/bash -c 'npx bats --timing tests/bats/'`. If hangs >5 min, reproduces. To bisect to the specific file: run each `tests/bats/test-*.bats` individually with `npx bats --timing <file>` and identify which one hangs. Suspects (priority by likelihood of spawning lingering processes / sub-shells):
1. `tests/bats/test-concurrency.bats` — already known macOS-flaky per the original comment at `.github/workflows/ci.yml:70-72` ("the wider tests/bats/ suite has a hang on macos-latest" + the BSD-vs-Linux SIGINT delivery hypothesis surfaced in PR #30 deferred entry, BACKLOG line ~404). Forks stub `gradlew` that `sleep 30`s, sends SIGINT to parent, then `wait $cli_pid` — could leak children under BSD signal-delivery semantics.
2. `tests/bats/test-android.bats` / `test-android-summary-counts.bats` / `test-parallel-ios-dispatch.bats` — invoke wrappers that may spawn `adb` (same class of orphan as the install.bats hang above).
3. `tests/bats/test-doctor.bats` — runs `kmp-test doctor` which probes adb directly (`lib/cli.js:1306`'s `spawnSync('adb', ['version'], ...)`) — same pattern as the install.bats root cause.

**Hypothesis:** likely the same adb-daemon-leak root cause as the install.bats entry above, just from a different test file in `tests/bats/`. The `KMP_TEST_SKIP_ADB=1` env opt-out documented as fix candidate 2 in the install.bats entry would address both hangs simultaneously if implemented in `lib/cli.js#runDoctorChecks` and exported to bats's setup_file(). Could ALTERNATIVELY be the BSD signal-delivery flake from `test-concurrency.bats` — those are different bug classes and need separate confirmation.

**Fix candidates** (mostly subsume into the install.bats entry's fix, but with broader scope):
1. Implement `KMP_TEST_SKIP_ADB=1` opt-out in `lib/cli.js#runDoctorChecks` (already referenced in PRODUCT.md OS matrix bullets and BACKLOG line 176); set it in BOTH `tests/installer/install.bats` and `tests/bats/` setup hooks. Single fix, both hangs closed.
2. Bisect first via `--filter` on macos-latest to pin down the exact bats file → if it's `test-concurrency.bats`, fix is the BSD-signal-delivery option from PR #30 deferred entry; if it's a different file, fix is option 1.
3. Mark `bats-macos` as `continue-on-error: true` until root cause confirmed (already done by branch-protection treating it as informational; document explicitly in `.github/workflows/ci.yml` for clarity).

**Impact assessment:** the `bats-macos` job remains informational (NOT in the 7 required CI checks per `CLAUDE.md` "Daily workflow" bullet — required set is `build x2`, `secrets-scan`, `gradle-plugin-test`, `installer-e2e x2`, `commit-lint`). PR #108 merged with the failure; future doc-only and code-only PRs will continue to merge despite the hang as long as the 7 required checks pass. **No release blocker.** Quality concern: bash 3.2 regression coverage is currently de facto disabled on macOS, leaving WS-2 (`declare -A`)-class bugs unchecked at the CI level. The 2-3h migration of `benchmark` to Node (Sub-entry 1 of v0.8 PIVOT) closes WS-2's specific bug class by construction, partially compensating for the gap until this hang is fixed.

**Effort: 2-3h.** Bisect (1h) + fix (1h via option 1, otherwise 1-2h via option 2) + CI re-run validation (30min). Recommended order: ship the v0.8 PIVOT benchmark migration first (closes the WS-2 surface that `bats-macos` is supposed to guard), then fix this hang to restore the regression-coverage net for the remaining bash plumbing across the migration window.

**Cross-references:**
- BACKLOG entry above (`tests/installer/install.bats` adb-orphan hang) — likely shared root cause; fixes should be coordinated.
- BACKLOG entry below in the QUEUED section (`macOS bats end-to-end validation (deuda from PR #30)`, line ~404) — original BSD-signal hypothesis for `test-concurrency.bats`; possibly the same bug as this one or a sibling.
- PR #105 BACKLOG entry "Workaround in flight" claim ("tests/bats/ passes in ~3 min") — invalidated by this finding; the workaround scope reduction did not actually deliver a passing macOS bats job.

### v0.8.0 — Project-level config file for stable settings (`sharedProjectName`, defaults) — surfaced 2026-05-03

**Surfaced 2026-05-03 during the README ↔ tool-surface audit.** `--shared-project-name` is documented in the README's CLI flag tables (line 409 + line 639), but **has never existed as a CLI flag**. The legacy bash wrapper only ever read the `SHARED_PROJECT_NAME` env var; the Gradle plugin exposes it as a real DSL property (`sharedProjectName = "..."`).

The repo owner's workflow makes the design tension visible: their main project depends on `shared-kmp-libs` (a sibling project that's a pure-libraries package). The shared-project relationship is **stable per-checkout** — it doesn't change between runs. A per-invocation CLI flag is the wrong shape; project-level config is.

**Proposal — `.kmp-test-runner.json` (or `.kmp-test-runner.yml` / TOML) at project root:**

```json
{
  "sharedProject": {
    "name": "shared-kmp-libs",
    "path": "../shared-kmp-libs"
  },
  "defaults": {
    "testType": "common",
    "coverageTool": "auto",
    "excludeModules": "*:test-fakes,konsist-guard"
  },
  "skip": {
    "android": ["legacy-app"],
    "ios": ["benchmark-android-test"]
  }
}
```

CLI flags continue to override config-file defaults (per-invocation precedence: CLI > env > config file > built-in default). Gradle plugin DSL props continue to work the same way; they read the same config file under the hood. This lets `kmp-test parallel --include-shared` Just Work without any CLI argument or env-var setup once the config is committed.

**Pairs naturally with the `.kmp-test-runner/` subdir entry below** — both put the runner's project-level surface under a single coherent root (`.kmp-test-runner.json` for config, `.kmp-test-runner/cache/` + `.kmp-test-runner/reports/` for artifacts). One `.gitignore` line covers all artifacts; the config file is committed.

**Migration path for `--shared-project-name`:**
1. v0.8.0 README refresh: **remove** `--shared-project-name` from the CLI flag tables (it never worked there). Document `SHARED_PROJECT_NAME` env var as the current interim. Keep the Gradle DSL property.
2. v0.8.x or v0.9: ship config-file support; deprecate the env var with a friendly warning.
3. v1.0: env var removed if config-file adoption sticks.

**What else fits naturally as project config (post-config-file shape — not v0.8.0 scope):**
- Default `testType`, `coverageTool`, `coverageModules`, `excludeCoverage`
- Skip lists per platform (`SKIP_DESKTOP_MODULES` / `SKIP_ANDROID_MODULES` / `SKIP_IOS_MODULES` / `SKIP_MACOS_MODULES` env vars all become array fields)
- `--output-file` default for coverage reports
- `--module-filter` default (rare but possible for monorepo subproject focus)

**Out of scope:**
- Per-invocation flags that genuinely vary per CI job: `--json`, `--dry-run`, `--test-filter`, `--ignore-jdk-mismatch`, `--fresh-daemon`. These stay flag-only.
- Schema validation / autocompletion — defer to v0.9 with a published JSON schema.

**Effort:** ~4-6h (config loader in `lib/cli.js`, CLI > env > config precedence resolver, migration code for `SHARED_PROJECT_NAME` → file, vitest for precedence + parse). **Promoted to v0.8.0 release-blocker** (2026-05-03) — closing the `--shared-project-name` README↔CLI gap honestly requires this rather than just deleting the doc line. Without project-level config the user's "main project depends on shared-kmp-libs" workflow has no clean shape (env var is a workaround, not a feature). Lands as a dedicated PR before the v0.8.0 release readiness gate.

### v0.8.0 — Move CLI-emitted artifacts into a single `.kmp-test-runner/` subdir (surfaced 2026-05-03; promoted to v0.8.0 release-blocker 2026-05-03)

**Surfaced 2026-05-03 during e2e validation of `kmp-test coverage --coverage-tool kover` on `shared-kmp-libs`.** The orchestrator scatters CLI-generated artifacts at the project root, mixed with the user's actual files:

- `coverage-full-report-<runId>.md` (one per run — ~20 accumulated in shared-kmp-libs after a week of iteration)
- `coverage-full-report.md` (legacy alias — overwritten each run)
- `androidtest-logs/<timestamp>/` (legacy `kmp-test android` log dir — pre-v0.8 sub-entry 3)
- `.kmp-test-runner-cache/` (project-model + gradle-tasks cache — already in subdir, only correctly-grouped artifact)

Users currently have no clean way to gitignore CLI output without enumerating every path individually. The legacy `coverage-full-report*.md` glob is fragile (third-party tools may produce similar filenames).

**Proposed shape:**

```
<project-root>/
  .kmp-test-runner/
    cache/                      # was .kmp-test-runner-cache/ (consolidate)
      model-<sha>.json
      tasks-<sha>.txt
    reports/
      coverage/
        <runId>.md
        latest.md               # symlink/copy alias (replaces coverage-full-report.md)
    logs/
      android/
        <runId>/<module>.log    # was build/logcat/<runId>/ (sub-entry 3 contract)
        <runId>/<module>_logcat.log
        <runId>/<module>_errors.json
```

**One-line `.gitignore` recipe** users can adopt:
```
# kmp-test-runner local artifacts (CLI output — never commit)
.kmp-test-runner/
```

**Migration plan:**
1. Single PR introduces `<project>/.kmp-test-runner/{cache,reports/coverage,logs/android}/` paths in coverage-orchestrator + android-orchestrator + project-model cache writer.
2. Cache layer reads from BOTH old and new paths during a transition release (v0.8.x); writes to new only. Old caches become stale and ignored.
3. Coverage reports read from new path; the `coverage-full-report.md` legacy alias at project root stays for one release with a deprecation banner inside the file ("> This file will be removed in v0.9 — see `.kmp-test-runner/reports/coverage/latest.md`").
4. Android log dir migration: `<project>/build/logcat/<runId>/` (current, since sub-entry 3) → `<project>/.kmp-test-runner/logs/android/<runId>/`. The current path is gitignored by Gradle's default `build/` exclusion already; the new path needs the user-side `.gitignore` rule.
5. README "Quick start" gains a 2-line section: "Add `.kmp-test-runner/` to your project `.gitignore` to keep CLI output out of git."

**Effort:** ~120 LOC across 3 orchestrators + 2-3 vitest cases per orchestrator covering the new path resolution + 1 cli.test.js case for the doctor / `--help` text mention. Schema bump on the project-model cache (versions to 7) so old caches at the legacy path don't get half-read on first upgrade.

**Ship-when:** **v0.8.0 release-blocker** (promoted 2026-05-03 — every known bug/improvement closes before tag). Lands as a dedicated PR after the project-level config file PR (the two pair: `.kmp-test-runner.json` config + `.kmp-test-runner/` artifacts share the same root). Cache layer keeps the dual-read transition behavior intact for one release so users coming from v0.7.x don't lose their cached models on first upgrade.

### v0.8.0 — Buildable cross-platform E2E fixture project (promoted to release-blocker per release-readiness gate #2)

**Surfaced 2026-05-01 during v0.7.0 Phase 3 review.** The current iOS / macOS test coverage is the same shape as JS/Wasm/Android — model unit tests, wrapper integration tests with stub `gradlew`, Gradle TestKit acceptance — but **no real iOS / macOS test execution in CI**. This is in parity with the rest of the platforms (Android instrumented + JS/Wasm also lack real-task CI runs), so v0.7.0 ships honestly. But it's the largest single piece of testing debt the project carries: every "iOS support works" claim today rests on wide-smoke validation against the user's local KMP projects, which doesn't survive in green/red CI history.

**Proposal**: build a **minimum-viable buildable Kotlin Multiplatform fixture** under `tests/fixtures/kmp-cross-platform-e2e/` with:
- Real `gradle/wrapper/` (gradle-wrapper.jar + properties pinning a stable Gradle 8.x or 9.x)
- Real `gradlew` + `gradlew.bat`
- Root `build.gradle.kts` with kotlin-multiplatform plugin
- One module exercising **every supported target**: `jvm()`, `js(IR)`, `wasmJs()`, `iosX64()` + `iosSimulatorArm64()`, `macosArm64()`, `androidLibrary { }` (or `androidTarget()`)
- Trivial passing test in each test source set (`commonTest`, `jvmTest`, `jsTest`, `wasmJsTest`, `iosX64Test`, `iosSimulatorArm64Test`, `macosArm64Test`, `androidUnitTest`)
- Pinned Kotlin + AGP versions in `gradle/libs.versions.toml`

**CI matrix** (new workflow `e2e-cross-platform.yml`):
- `e2e (ubuntu-latest)`: runs `kmp-test parallel --test-type common` + `--test-type androidUnit` + `--test-type ios` (dispatch only — no simulator) + `--test-type macos` (dispatch only) + JS-via-jvmTest fallback. Verifies the wrapper picks the right per-module task in the JSON envelope (no real test execution beyond JVM).
- `e2e (windows-latest)`: same as ubuntu — Pester / bash-via-Git-Bash parity check.
- `e2e (macos-latest)`: full iOS + macOS execution. Boots simulator (Approach B fallback if needed), runs `:module:iosSimulatorArm64Test` and `:module:macosArm64Test` for real. This is the only place where iOS actually runs.

**Risk + cost:**
- **Risk**: high CI flakiness from network deps (Maven plugin downloads), Xcode version drift on macos-latest, simulator boot races. Initial implementation could spend 50% of effort fighting infrastructure.
- **Cost**: ~6-10h to build a working fixture + reliable CI. Net new bytes in the repo: ~70KB for `gradle-wrapper.jar` (binary).
- **Per-run CI cost**: macOS minutes are 10× ubuntu minutes — full E2E job could add 5-10 min per CI run, ~50 min macOS-equivalent per PR.

**When to ship:**
- v0.7.x patch — if a v0.7 user surfaces an iOS regression that the unit/integration suite missed, this becomes urgent.
- v0.8.0 minor — if v0.7 ships clean, defer to a dedicated milestone where we can budget the CI flakiness work properly.
- v1.0.0 — if v0.7 + v0.8 hold up, the bar for v1.0 is "no major iOS regressions in 3+ months", and this fixture is part of the v1.0 stability claim.

**Out of scope for this entry:**
- Re-using an existing real-world OSS KMP project (Confetti / KaMPKit) as the fixture — version drift makes our CI flakier than a pinned synthetic; only revisit if synthetic proves too much work.
- Replacing the wide-smoke local validation gate (`feedback_release_wide_smoke.md`). Both should coexist: wide-smoke catches integration-level bugs against real projects; the synthetic E2E catches regressions deterministically.

### v0.8.0 — README refresh + token-cost re-measurement across all CLI tools (surfaced 2026-05-03)

**Surfaced 2026-05-03 after sub-entry 5 + PR #116 + sub-entry-5-followups landed.** The README has not been refreshed since v0.6.x; v0.7.0 (iOS/macOS surface), the v0.8 STRATEGIC PIVOT (5 orchestrators migrated to Node), the EINVAL spawn fix (PR #116), and the new flags restored in PR #115 follow-up (`--fresh-daemon`, `--output-file`, `--coverage-only`, `--benchmark` + `--benchmark-config`) all need to land in the user-facing docs before v0.8.0 tag.

Concurrently, `tests/vitest/measure-token-cost.test.js` was last calibrated against the bash-wrapper-era output; the migrated orchestrators' envelope-mode output is structurally identical but the human-banner output paths diverged. The token-cost numbers reported in the README ("13K → 100 token reduction for AI agents", "~542K → ~500 tokens for the coverage 5-iter loop") need re-measurement against:
- `kmp-test parallel` — both `--json` envelope mode AND human-banner mode, across `--test-type {common, desktop, androidUnit, androidInstrumented, ios, macos, all}` × `--no-coverage` × baseline
- `kmp-test coverage` — `--json` + human modes
- `kmp-test changed` — `--json` + human, with realistic git-diff scenarios
- `kmp-test android` — `--json` + human
- `kmp-test benchmark` — `--json` + human, across `--config {smoke, main, stress}`
- `kmp-test doctor` — `--json` + human

**Tasks:**
1. Run the full token-cost measurement matrix on a representative project (e.g. shared-kmp-libs or KaMPKit) and record before/after/reduction-ratio numbers per subcommand.
2. Refresh README sections: "Why kmp-test-runner" lead numbers, "AI agents and JSON envelope" examples, the per-subcommand flag tables (add `--fresh-daemon` / `--output-file` / `--coverage-only` / `--benchmark` / `--benchmark-config` / `--dry-run` to whichever subcommands accept them post-F1).
3. Verify "Platforms supported" table still matches `lib/project-model.js` candidate chains.
4. Audit README's tool surface against `lib/cli.js#COMMANDS` — add a separate BACKLOG entry below for any tool dropped during the migration.
5. **Remove `--shared-project-name` from the CLI flag tables** (lines 409 + 639). Has never existed as a CLI flag — only the `SHARED_PROJECT_NAME` env var works, and the Gradle DSL property `sharedProjectName` works in the plugin. Replacement design tracked in the project-level config file BACKLOG entry below — the env var stays as the interim shape until that lands. Surfaced 2026-05-03 during the README ↔ tool-surface audit.

**Effort:** 2-3h ad-hoc on the maintainer's macOS once a stable wide-smoke baseline is captured.

**Ship-when:** Folded into the v0.8.0 release-readiness gate (BACKLOG entry above) — README refresh is a release-PR scope item, not standalone.

### v0.8.0 — Verify all CLI tools advertised in README are still offered post-Node-migration (✅ audited 2026-05-03; remediation pending)

**Audited 2026-05-03 during the sub-entry-5-followups PR.** First pass complete; findings below feed into the README refresh entry above. No action needed on this entry beyond folding the findings into that PR.

**Audit findings (2026-05-03):**

✅ **All 6 subcommands listed in README exist in `lib/cli.js#COMMANDS` and dispatch correctly:** parallel, changed, android, benchmark, coverage, doctor.

✅ **All concrete `kmp-test ...` examples in README execute against valid parseArgs cases.** ~25 command-line examples extracted from backtick blocks; every flag matched to a parser case in the corresponding orchestrator.

✅ **All legacy bash wrapper flags successfully migrated.** Compared `git show 1b92c6d^:scripts/sh/run-parallel-coverage-suite.sh` against `lib/parallel-orchestrator.js#parseArgs`: 20/20 legacy flags present. The 4 originally dropped (`--fresh-daemon`, `--output-file`, `--coverage-only`, `--benchmark` + `--benchmark-config`) were restored in PR #115 follow-up. **Migration is flag-complete.**

⚠️ **`--shared-project-name` documented in README's CLI flag tables (line 409 + 639) but has never existed as a CLI flag.** Legacy bash wrapper only ever read the `SHARED_PROJECT_NAME` env var; Gradle plugin DSL `sharedProjectName` does work. Pre-existing README bug, not migration loss. **Tracked separately in the "Project-level config file" v0.8.0 entry above.**

⚠️ **Flag reference table at README line 393-410 is significantly out-of-date.** Documents 8 flags; `parallel-orchestrator.js#parseArgs` parses 19+. Missing from README (need to be added or omitted with rationale): `--include-shared`, `--test-filter`, `--exclude-coverage`, `--timeout`, `--skip-tests`, `--dry-run`, `--fresh-daemon`, `--output-file`, `--coverage-only`, `--benchmark`, `--benchmark-config`. **Tracked in the "README refresh + token-cost re-measurement" v0.8.0 entry above** — this audit feeds that PR's task list.

**Ship-when:** No standalone PR — findings already documented; remediation lands as part of the README refresh PR. Close this entry when README refresh ships.

### v0.8 — KMP target tier intel for iOS/macOS strategy (surfaced 2026-05-02 during sub-entry 3 validation in shared-kmp-libs)

**Source:** repo owner's investigation in shared-kmp-libs while validating sub-entry 3 (PR #113). Captures the current Kotlin/Native target tier status that affects (a) the v0.7.0 `resolveTasksFor` candidate-chain design (`iosX64Test → iosArm64Test → iosSimulatorArm64Test` for `iosTestTask`; `macosX64Test → macosArm64Test → macosTest` for `macosTestTask`), (b) the v0.8.0 release-readiness gate's "Buildable cross-platform E2E fixture" target matrix, and (c) the `gradle-plugin-test-ios` informational job's promotion criteria.

**Tier table (Kotlin 2.x current state):**

| Target | Tier | Status | Action for kmp-test-runner |
|---|---|---|---|
| `macosArm64` | Tier 1 | Active, tested every Kotlin release | **Primary macOS target.** First in `macosTestTask` candidate chain (line 738). |
| `iosSimulatorArm64` | Tier 1 | Active | **Primary iOS test target.** First in `iosTestTask` chain. |
| `iosArm64` | Tier 2 | Active (physical device, publish-time) | Keep in chain for device runs; not test-runtime on Apple Silicon hosts. |
| `iosX64` | Tier 2 | Active (Intel sim — won't execute on Apple Silicon hosts) | Keep in chain BUT document the Apple Silicon caveat. |
| `macosX64` | Deprecated | Removed in Kotlin 2.4.0 | **Drop from `macosTestTask` candidates** when the v0.8.0 fixture pins Kotlin 2.4+. Keep in v0.7.x for back-compat. |

**Implications for the v0.8.0 release-readiness gate's E2E fixture (BACKLOG entry "Buildable cross-platform E2E fixture project"):**

- Fixture target list: `jvm()`, `js(IR)`, `wasmJs()`, `iosSimulatorArm64()` + `iosArm64()` (NOT `iosX64()` — won't execute on the macos-latest CI runner which is Apple Silicon since 2024). Drop `macosX64()` (deprecated, gone in 2.4).
- Pin Kotlin 2.4+ AGP 8.x — captures the post-`macosX64` shape that ships with v0.8.0.
- `e2e (macos-latest)` job runs `:module:macosArm64Test` + `:module:iosSimulatorArm64Test` — these are the two Tier 1 paths and the only ones that ACTUALLY execute on the runner.
- `gradle-plugin-test-ios` promotion (currently informational) gets the same tier-1-only test list.

**What's testable on the maintainer's Apple Silicon Mac WITHOUT a physical iPhone (per repo owner's research):**

| Test type | How |
|---|---|
| `commonTest` unit | `:module:macosArm64Test` + `:module:iosSimulatorArm64Test` — same `commonMain` runs in both K/N runtimes |
| iOS-specific unit | `:module:iosSimulatorArm64Test` — simulator is a real iOS runtime (same K/N, same Foundation/UIKit) |
| macOS-specific unit | `:module:macosArm64Test` — native on host |
| Compose UI Desktop | native on macOS |
| Compose UI iOS | XCUITest on simulator |
| Producer ↔ Consumer integration | macOS process + iOS Simulator process share `localhost`/`127.0.0.1` loopback (simulator shares host network) |
| Deep links / Universal Links | `xcrun simctl openurl` on simulator |
| Push notifications | `xcrun simctl push` on iOS 16+ simulator |
| Foundation / UIKit / CoreData APIs | all functional on simulator |

**What requires a physical device (out of scope for kmp-test-runner CI; deferred to TestFlight / Firebase Test Lab / BrowserStack farms):**

- Bluetooth / MultipeerConnectivity (no simulation, hardware only)
- Camera / Mic with real data (simulator injects fake video)
- HealthKit, sensors (accelerometer, precise GPS) — limited or stub
- Performance characterization (simulator uses Mac CPU, not A-series chip)
- Battery / thermal throttling
- Realistic memory pressure / OOM (simulator inherits host GB)
- App Store / TestFlight signing flow
- iOS sandbox-specific bugs (simulator sandbox is more permissive)

**Producer ↔ consumer integration test pattern (no physical device required):**

1. Gradle test target arranges the producer macOS process via `exec` task.
2. `xcrun simctl boot` + `xcrun simctl launch` boots the iOS Simulator from Gradle.
3. JVM-side test driver (`junit` / `kotlin-test`) asserts on observable behavior (HTTP requests, files, sockets, IPC).
4. Producer ↔ consumer comms over `localhost` / `127.0.0.1` (simulator shares host loopback).

This pattern covers ~90-95% of integration bugs. The remaining 5% (hardware/performance) is industry-standard "TestFlight beta + device farm" territory — outside this product's scope.

**Action items (defer to v0.8.0 release-readiness work, after sub-entries 4+5 close):**

1. Update `lib/project-model.js#resolveTasksFor` `macosTestTask` candidate chain (line 742) to drop `macosX64Test` once the v0.8.0 fixture pins Kotlin 2.4+. Pre-2.4 users still get the candidate via the legacy ordering.
2. v0.8.0 fixture targets: `jvm`, `js(IR)`, `wasmJs`, `iosSimulatorArm64`, `iosArm64`, `macosArm64`, `androidLibrary` / `androidTarget` — drop `iosX64` + `macosX64`.
3. README "Multi-platform test dispatch" section (v0.7.0): add an explicit note that `iosX64Test` / `macosX64Test` won't execute on Apple Silicon hosts (only show up via cross-compilation publish). Document the test-time vs publish-time distinction.
4. `gradle-plugin-test-ios` promotion: same tier-1-only test list as the E2E fixture — `:module:macosArm64Test` + `:module:iosSimulatorArm64Test` are the only two that execute on the runner.

**Effort:** ~2-3h folded into v0.8.0 release-readiness gate (1) cross-OS parity workflow + (2) fixture build. Documentation update lands as a follow-up README polish PR pre-tag.

### ✅ HISTORICAL — Wide-smoke validation findings (mom's MacBook session, 2026-05-01)

> **STATUS (2026-05-03):** All WS-1 through WS-10 + UX-1/UX-2 findings closed via v0.8 sub-entries 1-5 (PRs #110-#115) + PR #116 EINVAL fix + sub-entry-5-followups (this PR). Entry preserved for historical context (the original 11-issue triage that drove v0.8 STRATEGIC PIVOT scoping).
>
> **What replaced it:** the post-#116 wide-smoke baseline lives in BACKLOG entry "v0.8 — ✅ Silent-pass class FIXED" (line ~199) and the 3 follow-up v0.8.0 entries (JDK-AGP, cascade isolation, per-project triage). Future wide-smoke surfaces feed those entries, not this one.

**Surfaced 2026-05-01 during cross-project wide-smoke validation against PeopleInSpace, Confetti (multi-module ~13 subprojects), and KaMPKit at `/Volumes/XcodeOscar/kmp-test-workspace/`. Validation hardware: Galaxy S22 Ultra (SM-S908B, Android 16, arm64-v8a, instrumented tests), iOS 26.4 Simulator runtime (10 devices: iPhone 17 Pro/Air/17e, iPad Pro M5, etc.), JDK catalogue 11/17/21, host JDK 21 default.** Eleven issues uncovered (twelfth `SKIPPED_MODULES` fix tracked separately below). Target: clear ALL before v0.8.0.

The session ran an end-to-end reproducible matrix: every `--test-type {common,androidUnit,androidInstrumented,desktop,macos,ios,all}` × {PeopleInSpace, Confetti, KaMPKit} plus all five subcommands (`parallel`, `android`, `changed`, `coverage`, `benchmark`). Logs preserved at `/tmp/kmp-{pis,conf,kk}-*.log` on the host machine for evidence. The whole-session HANDOFF lives at `/Volumes/XcodeOscar/HANDOFF.md`.

**🔴 Critical (false-positive PASS / broken subcommand):**

- **Bug WS-1 — PASS fantasma when Gradle reports "task not found".** `scripts/sh/run-parallel-coverage-suite.sh` interprets ANY `gradle exit 1` as "deprecation warning + tasks passed individually" (the v0.5.0 Bug C workaround). When exit 1 is from `Cannot locate tasks that match ':moduleX:iosSimulatorArm64Test'` (module without that KMP target), the script reports `[PASS] moduleX` and the JSON envelope says `tests.passed = N, errors = []`. Confirmed reproducer: `cd Confetti && kmp-test parallel --test-type ios` reports 4 PASS in 15s (identical with/without iOS Simulator runtime installed); direct `./gradlew :androidApp:iosSimulatorArm64Test` immediately returns `BUILD FAILED in 981ms` with "task not found". Same false-positive applies to `--test-type macos` (4 PASS in 16s on modules without `macosArm64()`). Fix direction: the `gate_gradle_exit_for_deprecation` path (sh + ps1) must distinguish `BUILD FAILED ... Cannot locate tasks that match` from `Deprecated Gradle features were used` before counting un-named tasks as pass. Concrete signal: presence of `Cannot locate tasks that match` substring in stdout/stderr → real failure, emit `errors[].code = "task_not_found"` (already a defined code, just not wired here) and reflect in exit code. **Effort: 2-3h** (sh + ps1 + tests). Risk: the per-task PASS/FAIL parsing today is line-prefix-based; need to anchor task-not-found detection to the gradle exception block.

- **Bug WS-2 — `run-benchmarks.sh` uses `declare -A` (Bash 4+) on macOS Bash 3.2.** Lines 242, 338, 339 declare associative arrays `MODULE_STATUS`, `MODULE_BENCHMARK_COUNT`, `MODULE_AVG_SCORE`; macOS default Bash 3.2.57 fails immediately with `declare: -A: invalid option`. `kmp-test benchmark` is broken on every macOS without `brew install bash` first. Sister scripts already document this as a known gotcha (`run-changed-modules-tests.sh:133` "Use temp file instead of declare -A for Bash 3.2 compatibility"; `run-parallel-coverage-suite.sh:202` "Build set of modules from settings.gradle.kts (Bash 3.2 compatible — no declare -A)"). The benchmark script slipped through. Reproducer: `cd Confetti && kmp-test benchmark --config smoke` → exit 2, `errors[0].code:"no_summary"` after 368ms; module discovery and platform detection had succeeded (logged "Found 2 benchmark module(s): androidBenchmark, wearBenchmark", "JVM Desktop OK", "Android — SM_S908B (physical) OK"). Fix: port the same parallel-strings-array workaround used in `run-parallel-coverage-suite.sh` (lookup via `module_status_<i>` indexed scalars + `string|key|string` join). **Effort: 1-2h** for all three usages + a Bash-3.2 syntax-only smoke test in CI on `macos-latest`.

**🟠 High (agent / automation impact):**

- **Bug WS-3 — `kmp-test android` subcommand finds 0 modules where `parallel --test-type androidInstrumented` finds 4** in the same project root. Reproducer: `cd Confetti && kmp-test android` → "ERROR: No modules found with androidTest directory" exit 1; `kmp-test parallel --test-type androidInstrumented` → 4 PASS (`:androidApp:`, `:backend:service-import:`, `:shared:`, `:wearApp:connectedDebugAndroidTest`) in 17s on S22 Ultra. Plus `kmp-test android --list-only` reports "Android Test Modules (1):" with the listed name empty (`-  -`). Three different module-detection paths with three different criteria: (a) `parallel --test-type androidInstrumented` uses gradle task probe (works), (b) `android` subcommand looks for literal `src/androidTest/` directory (misses KMP `androidTarget()` modules where the source set is `androidInstrumentedTest/` or implied by KMP DSL), (c) `android --list-only` somewhere counts but doesn't render. Fix: consolidate Android detection through the project-model fast path (`pm_get_*_test_task` style — already proven in v0.5.1 Phase 4 refactor) so all three callers see the same module set. **Effort: 3-4h** (model.json field if missing + sh/ps1 readers + cli wiring + tests). Cross-references v0.7.0 surface (Bug B' / B'' from v0.5.1).

- **Bug WS-4 — `kmp-test changed` does not detect modifications under module source-set directories.** Reproducer: in Confetti `git status -s` showed `M shared/src/commonMain/kotlin/dev/johnoreilly/confetti/Model.kt` (clean modify). `kmp-test changed --show-modules-only` reported "No modules with uncommitted changes detected" + JSON `errors[0].code:"no_summary"` with `exit_code:0`. The `:shared` module clearly contains the file. Suspected: `scripts/sh/run-changed-modules-tests.sh` git-diff-to-module mapping does not enumerate KMP source-set subdirs (commonMain/androidMain/iosMain/etc.) under `<module>/src/`, only top-level module-root paths. Plus envelope inconsistency: human-readable output produced a recognizable "No modules…" line but the wrapper Node parser still flagged `no_summary` (treating "no detected modules" as an error rather than a clean zero-set). Fix: (a) module-mapping must walk all source-set leaves (the same 18-entry sourceSetNames list from v0.7.0 Phase 1); (b) parser must recognize "No modules with uncommitted changes detected" as a clean exit (similar to v0.6.2 Gap 1.1's `no_test_modules` discriminator). **Effort: 2-3h** (mapping fix + new discriminator + tests). Tagentially related to v0.6.2 Gap 1 hierarchy.

- **Bug WS-5 — `errors[]` populated while `exit_code:0`.** Confetti `--test-type common --json` returned `errors[0].code:"task_not_found", message:"Cannot locate tasks that match ':androidApp:jacocoTestReport'..."` AND `exit_code:0` simultaneously. Either the task-not-found is a real failure (and exit must be ≠0) or it's a recoverable warning (and belongs in `warnings[]`, not `errors[]`). Today both can fire and an agent reading `errors.length > 0` to branch on failure will get false positives on a passing run. Same root issue surfaces with WS-1 from a different angle. Fix: define the contract — anything in `errors[]` MUST correspond to non-zero exit; recoverable should move to `warnings[]`. **Effort: ~1h** once WS-1 is in flight (likely same PR).

- **HANDOFF UX-1 (still alive in v0.7) — modules with `commonTest` but no `jvm()`/`androidTarget()` go invisible.** KaMPKit `:shared` declares `commonTest`, `androidHostTest`, `iosTest` source sets per `settings.gradle.kts include(":shared")` and on-disk `shared/src/{commonTest,androidHostTest,iosTest}` — yet `kmp-test parallel --test-type common --json` returns `modules:[]` AND `skipped:[{module:"app", ...}]`: `:shared` appears in **neither** array. Today users see "no modules ran" with no clue why. Fix: when filesystem walker observes a test source set on a module that lacks the requested test-type's target, emit `skipped[{module, reason: "no <target>() target for --test-type <X>"}]` instead of dropping the module entirely. **Effort: 1-2h.** Also addresses HANDOFF UX-2 (below) by giving the user real signal instead of the misleading default error.

**🟡 Medium (DX / observability):**

- **Bug WS-6 — `--test-type all` does not span all types.** Both PeopleInSpace and Confetti runs of `--test-type all` invoke only `:*:desktopTest` (4 tasks, identical to `--test-type desktop`); androidUnit / androidInstrumented / common / macos / ios are NOT ALSO dispatched. Either the flag is misnamed or the dispatch is incomplete. If "all" is supposed to span every supported type, the fix is wide (sh + ps1 dispatch one set per type, parallel across types). If "all" is "auto-pick the best fit per module", the rename is `--test-type auto` and that's a CLI surface change. **Effort: 1h** for design clarification + 2-4h once direction is chosen.

- **Bug WS-7 — `--test-type common` maps to `desktopTest`** (not to a true `commonTest`-source-set runner). Functionally OK in pure-KMP modules where common tests are inherited by JVM target, but the naming surprises new users who pass `--test-type common` expecting "run only the common source set". Document explicitly OR rename to `--test-type jvm` to align with the gradle task name. **Effort: 30min** (docs-only fix in `parallel --help` + flag-reference table) or 2-3h if renamed (alias + deprecation path + tests).

- **Bug WS-8 — `tests.total` counts gradle tasks, not individual tests.** Across all matrix runs `tests.total` equals `count(gradle test tasks invoked)` — `:app:testDebugUnitTest` reports 1 even when its junit-XML has 5 method results. For an agent budgeting on test counts (e.g. CI sharding, regression blast-radius assessment) this is wrong by 1-2 orders of magnitude. Fix: parse junit XML reports under `<module>/build/test-results/<task>/TEST-*.xml` post-run, sum `<testsuite tests="N">` per task. **Effort: 3-4h** (reports walker + per-OS path quirks + tests + JSON envelope shape addition `tests.tasks` vs `tests.total`).

- **Bug WS-9 — `modules:[]` JSON envelope empty even when `tests.passed > 0`.** Across PeopleInSpace runs with 3 PASS, the `modules` array stayed `[]`. The agent today has to infer module names from `skipped[]` complement against `settings.gradle.kts`. Fix: per-module result entries must populate `modules[]` regardless of coverage data presence. Likely a one-line fix in the report-builder. **Effort: 1h.**

- **Bug WS-10 — `kmp-test android --list-only` shows "Android Test Modules (1):" with empty name.** Renderer prints the count from one source and the names from another (and the names path resolves to "" or whitespace). Fix: align rendered list with the count-source; use the project-model fast path. Pairs with WS-3. **Effort: ~1h** (likely subsumed by WS-3).

- **HANDOFF UX-2 (still alive in v0.7) — misleading "No modules found matching filter: *" when `--test-type` is the filter that rejected.** KaMPKit `kmp-test parallel --test-type common` (no `--module-filter`) returns `errors[0].code:"no_test_modules", message:"No modules found matching filter: *"`. The literal filter `*` is correct; what filtered everything out was the test-type. Cross-references v0.6.2 Gap 1.1 (the `no_test_modules` discriminator was added but the message text retained from before). Fix: change message to "No modules support the requested --test-type=<X>" when the cause is type filtering vs the `*` filter. **Effort: 1h** (message wording + test).

**Out of scope for this entry:**
- The `SKIPPED_MODULES[@]` unbound fix — handled in its own backlog entry below (patch already validated, awaiting first PR).
- Re-measuring token-cost tables to capture iOS / macOS dispatch cost — already a separate backlog entry.
- Any new feature work (WS-* are all bugs, not features).

**Aggregate effort estimate:** ~20-25h to clear all 11 (sequential), or 3-4 PRs of 5-7h each if grouped: PR1 (WS-1 + WS-5 + UX-2) — error/exit-code consistency; PR2 (WS-2) — benchmark Bash 3.2; PR3 (WS-3 + WS-10 + UX-1) — Android detection + invisible-module fix; PR4 (WS-4 + WS-6 + WS-7 + WS-8 + WS-9) — DX cleanup. Suggested order by user-impact: WS-1 → WS-2 → WS-3/UX-1 → WS-4 → DX bundle.

**Wide-smoke evidence:** logs at `/tmp/kmp-{pis,conf,kk}-*.{log,json}` on mom's MacBook (2026-05-01); npm-link active there (global `kmp-test` → `/Volumes/XcodeOscar/kmp-test-workspace/kmp-test-runner`). Direct gradle reproductions captured for WS-1 evidence.

### ✅ OBSOLETE — `SKIPPED_MODULES[@]` unbound under Bash 3.2 set -u (resolved by v0.8 PIVOT 2026-05-03)

**Resolution:** the v0.8 STRATEGIC PIVOT (sub-entry 5, PR #115) replaced `scripts/sh/run-parallel-coverage-suite.sh` (1,701 LOC) with a 28 LOC thin Node launcher. The line `scripts/sh/run-parallel-coverage-suite.sh:779` referenced in this entry no longer exists. The Bash 3.2 array-expansion bug is structurally impossible in the migrated `lib/parallel-orchestrator.js` (Node has no equivalent gotcha). Locked-in regression coverage: `tests/vitest/parallel-orchestrator.test.js` test "`partitionBySkipEnv` empty SKIP_* env partitions cleanly (locks Bash 3.2 SKIPPED_MODULES regression into JS)".

**Original report below preserved for historical context only:**

**Surfaced 2026-04-30 (HANDOFF.md, sesión previa). Validated 2026-05-01 with reverted-then-restored A/B experiment.**

`scripts/sh/run-parallel-coverage-suite.sh:779` references `"${SKIPPED_MODULES[@]}"` directly. macOS Bash 3.2.57 (default) treats expansion of an empty array as unbound under `set -u`, so the script crashes BEFORE producing any test/build summary whenever no module is skipped (e.g. when `--include-untested` overrides every auto-skip, or when the project happens to have zero skip candidates).

Reproducer (validated this session): `cd /Volumes/XcodeOscar/kmp-test-workspace/PeopleInSpace && kmp-test parallel --test-type common --include-untested --json`
- **Without fix**: `exit_code:1, duration_ms:1348, errors[0].code:"no_summary", tests.total:0` (script dies in ~1.3s, before gradle).
- **With fix**: `exit_code:0, duration_ms:16581, tests.passed:7, skipped:[]` (script proceeds normally; with `--include-untested` 7 tasks run end-to-end).

Fix is **one line**, applied locally on mom's MacBook but **NOT committed**:

```diff
-for skipped in "${SKIPPED_MODULES[@]}"; do
+for skipped in "${SKIPPED_MODULES[@]+"${SKIPPED_MODULES[@]}"}"; do
     skipped_list="${skipped_list}|${skipped}|"
 done
```

Pattern is the **idiomatic one already used in this same file at line 792** for `TEST_TASKS` / `TEST_TASKS_SHARED`. Preferred over `${arr[@]:-}` (HANDOFF's first instinct) because `:-` introduces a phantom empty-string element when the array is empty (`for` runs once with `skipped=""` and pollutes `skipped_list` with `||`). The `${arr[@]+"${arr[@]}"}` form expands to nothing on empty arrays — clean.

**Test coverage gap to close in same PR:**
- bats test: assert exit 0 when `SKIPPED_MODULES` is empty (use a fixture project where every module has test sources, or use `--include-untested`).
- Pester equivalent N/A — PowerShell associative arrays don't have this Bash-3.2 specific semantics (script runs Windows path).

**Effort: 30-45 min** (1-line code fix, 1-2 bats tests, 1 vitest if the JS layer touches the codepath, PR description with the A/B evidence above).

**Suggested first PR for the v0.7.x patch run** — small, isolated, evidence-rich, high signal-to-effort. Good warm-up before tackling WS-1 (which is the architecturally trickiest of the wide-smoke findings).

### v0.7.x / v0.8 — Community standards (issue + PR templates)

**Surfaced 2026-05-01.** GitHub flags the repo as missing two community-standards files:

- `.github/ISSUE_TEMPLATE/` — at minimum a `bug_report.md` and `feature_request.md` (or YAML form templates). The README's "How to file an issue" path today is implicit; templates make first-time contributors land on a structured form.
- `.github/PULL_REQUEST_TEMPLATE.md` — a single-file template that pre-fills the PR description with the standard sections we already use ad-hoc (Summary, What changed, Tests, Out of scope, Test plan). Today every PR copies the shape from a previous PR's description; codifying it in a template removes that drift.

Both are tiny single-file additions (~50-100 lines each). Pair with a CONTRIBUTING.md cross-reference (already exists). Estimated effort: 30-45 min total.

### ✅ SUPERSEDED — Refresh token-cost measurement tables (folded into v0.8.0 README refresh entry above 2026-05-03)

**Surfaced 2026-05-01 during v0.7.0 README revamp.** The token-cost numbers in the README were captured at v0.5.0. The JSON envelope shape barely changed since (additive fields only — `skipped[]` in v0.6.2, `iosTestTask` / `macosTestTask` in v0.7.0 when those test types are picked), so the numbers remain representative within ±5%. But the date is now stale.

Refresh approach:
- Re-run `tools/measure-token-cost.js` against `shared-kmp-libs` for all 4 features × 3 approaches × cross-model. ~$10-15 USD in Anthropic API calls.
- Add a new column / row showing iOS or macOS dispatch token cost (different envelope content vs JVM).
- Update the timestamp note in the README (currently absent — should say "Measured at v0.X.Y on YYYY-MM-DD").
- Optional: bump bar resolution / column widths if the new layout (post-v0.7.0 redesign) exposes any awkward wraps.

Effort: ~2-3h total (1h re-running, 1h reviewing, 30-45 min editing the tables). Defer to v0.8 unless a v0.7.x bug pushes the JSON envelope shape (in which case re-measure becomes load-bearing).

### ✅ SUPERSEDED — Update README to reflect post-v0.6.x feature surface (folded into v0.8.0 README refresh entry above 2026-05-03)

The README has not been touched since v0.5.x. v0.6.0 + v0.6.x added significant surface that should be documented before v0.7 (where API breaks may land):

- **v0.6 Bug 2** — `kotlin("android")` + `com.android.test` plugin detection
- **v0.6 Bug 3** — JS / Wasm source-set + task support (`webTestTask` field)
- **v0.6 Bug 5** — `--no-coverage` alias
- **v0.6 Bug 6** — CONVENTION vs SELF coverage hint discrimination
- **v0.6.x Gap 1** — `errors[].code = "no_summary"` discriminator
- **v0.6.x Gap 2** — Multi-JDK auto-select catalogue + `--java-home` / `--no-jdk-autoselect` flags + `kmp-test doctor` "JDK catalogue" surface
- **v0.6.x Gap 3** — `alias(libs.plugins.<X>)` resolution via version catalogue (+ heuristic fallback)
- **v0.6.x Gap 4** — Per-module convention-plugin coverage detection (heuristic-first via class name)

Two slots:

1. **v0.6.2 (light pass)**: add a "What's new in v0.6.x" section + flag table (`--java-home`, `--no-jdk-autoselect`, `--no-coverage`). Update the `kmp-test doctor` example output to show the new "JDK catalogue" row. Estimate: 30-45min.
2. **Pre-v0.7 (full revamp)**: regenerate the entire README structure — quick-start, install paths (npm + Gradle plugin + GH Release archives), CLI surface table, decision matrix for `parallel` vs `changed` vs `android` vs `benchmark` vs `coverage`, troubleshooting (mismatched JDK, no coverage data, locked daemon, etc.), and a "How the project model works" diagram. Estimate: 2-3h.

The pre-v0.7 pass is critical — v0.7 introduces iOS support (Bug 4 deferred) which is a major surface change and the README must be coherent for new users.

### v0.6.2 — Refine `no_summary` discrimination into specific sub-codes (surfaced 2026-04-30 v0.6.x stress test)

`no_summary` (added in v0.6.x Gap 1) is a defensive catch-all for "the script ran but produced no recognizable test/build summary". Phase J stress test against 9 ex-AMBER-JDK projects post-Adoptium-11-install surfaced 3 distinct real-world causes that all collapse to `no_summary` today:

1. **Project has no test source sets** — Nav3Guide-scenes, kmp-production-sample-master. Wrapper emits `[ERROR] No modules found matching filter: *` after `[SKIP] composeApp (no test source set)`. Currently `no_summary`.
2. **Build fail before tests** (gradle compile error / dep resolution failure) where the script doesn't propagate `BUILD FAILED` to stdout — KMedia-main pattern.
3. **Filter excludes everything** — `--changed-since` with zero changes, `--test-filter` not matching any class. Currently `no_summary`.

Refinements (each ~30-60min, all additive — no API break):

- **Gap 1.1**: discriminator for `[ERROR] No modules found matching filter` → `code: "no_test_modules"`. Reads stdout for the wrapper's literal string.
- **Gap 1.2**: parse `[SKIP] <module> (no test source set)` lines into `state.skipped[]` array on the envelope so agents can suggest `--include-untested`.
- **Gap 1.3**: when `state.errors` already has a discriminated code AND the parse-gap fallback would also fire, prefer the specific code (don't double-emit `no_summary`).
- **Gap 1.4** (out of scope without protocol break): the wrapper script could emit a structured `[KMP_TEST_EXIT_REASON] <code>` line that the parser captures verbatim. Defer to v0.7+ when we control both ends.

Wide-smoke evidence files (already on disk locally): `.smoke/stress-J/OFFICIAL_PROJECTS_*.json` for the 3 Phase J reds.

Estimated effort: 2-3h total for Gaps 1.1-1.3. Patch bump (no API break, additive codes/fields).

### Multi-JDK auto-selection per project (research — surfaced 2026-04-30 v0.6 wide smoke)

When running `kmp-test parallel` against many KMP projects in one session, each project may require a different JDK (KaMPKit JDK 11 / nav3-recipes JDK 11 / Confetti JDK 17 / shared-kmp-libs JDK 21). Today the user must restart the shell with a different `JAVA_HOME` between projects, or pass `--ignore-jdk-mismatch` to bypass the gate. Wide-smoke surface 2026-04-30: 4/20 surveyed projects exited 3 with `jdk_mismatch` because the host's `java -version` was 21.

Investigation questions:
1. **Detect installed JDKs** — common locations on each platform (Eclipse Adoptium / Zulu / Microsoft Build / SAP / `/usr/libexec/java_home -V` on macOS / `update-alternatives --list java` on Linux / `where java` + Registry on Windows). Build a catalogue at startup.
2. **Match required JDK** — when `findRequiredJdkVersion` returns N and the catalogue has a matching install, use it for the spawn (export `JAVA_HOME=<path>` to the gradle subprocess). Bypass the gate.
3. **Surface in `kmp-test doctor`** — list installed JDKs + show which one would be chosen for the current project.
4. **`--java-home <path>`** flag already exists in `scripts/{sh,ps1}` (added v0.5.1 Bug F). Hoist it to the CLI layer so users can override the auto-detected pick.
5. **Per-project config presets** (sister entry below) could pin a specific JDK path — useful when auto-detection picks the wrong major (e.g. project tests fail under JDK 21 even though it satisfies the toolchain version).
6. **`gradle.properties` precedence** — `org.gradle.java.home=<path>` already bypasses the gate; the auto-selection should respect this when present.

Estimated effort: ~3-4h for catalogue + match + doctor surfacing. Probably v0.6.x or v0.7.

### Per-project config presets (post-v0.5.1 idea — needs design)

The CLI currently expects each invocation to carry every flag verbatim — which becomes painful when running it against several real projects with different requirements. Examples surfaced 2026-04-27 while validating v0.5.1:

- One KMP project compiles to `JvmTarget.JVM_21` → benchmarks need `JAVA_HOME=jdk21` to run; without it you hit `UnsupportedClassVersionError` (class file v65 vs runtime v61).
- Another personal Android-only project pins `JavaVersion.VERSION_11` for `compileOptions` → fine on either JDK 17 or 21, but its benchmark module wants `--platform android --config smoke --test-filter '*Scale*'`.
- A third heterogeneous KMP project on a different machine pins JDK 17 toolchain and wants `--coverage-tool none` (no kover/jacoco plugin applied per-module).

Today every `kmp-test ...` invocation has to carry this knowledge as flags + env vars, by memory, every time.

**Proposal sketch** (not yet a phase plan):
- `~/.kmp-test/config.json` (or `.kmp-test.json` in project root) keyed by project name or git-remote, with a per-project preset:
  ```json
  {
    "projects": {
      "shared-kmp-libs": {
        "java_home": "C:/Program Files/Zulu/zulu-21",
        "benchmark": { "config": "main" }
      },
      "<personal-android-only>": {
        "benchmark": { "platform": "android", "config": "smoke", "test_filter": "*Scale*" }
      }
    }
  }
  ```
- `kmp-test benchmark --project shared-kmp-libs` reads the preset and applies env + flags.
- Or auto-detect by `cwd` when no `--project` is passed.
- Doctor extension (Bug F in v0.5.1 Phase 4) could write the JDK requirement back into the config when it detects `jvmTarget = JVM_N` so the next invocation Just Works.

Open questions:
- Schema validation — JSON Schema, or just permissive merge?
- Precedence vs explicit CLI flags — flags always win? Always lose? Configurable per-key?
- Security — `java_home` overrides `$JAVA_HOME`; do we let a checked-in `.kmp-test.json` mutate the spawn env, or only the user-global one?
- Would this benefit from an `init` subcommand that templated the config from observed project state (`jvmTarget`, plugins applied, modules with tests)?

Estimated effort: ~6–10h once the schema is designed. Probably a v0.6 milestone scope, not v0.5.1.

### v0.5.2 candidates _(SHIPPED 2026-04-30 — see DONE section)_

All five gaps shipped in v0.5.2 (PRs #63 / #64 / #65 / #66 / #67). One scope reduction: Gap A's deletion phase (removing `detect_coverage_tool` / `get_coverage_gradle_task` from sh + ps1) was deferred to a future milestone. The pre-work (build-logic detection + coverage-task prediction in JS) shipped, which closed the practical gap without removing the fallback safety net. See DONE section below for closure record.

- **Bug H — `gradle_timeout` exit code consistency** _(DONE in PR #55 step 9, was an open gap)_ — wrapper-script keying-on-bash-exit got 1 (TEST_FAIL) while the JSON envelope reported `exit_code: 3` (ENV_ERROR). Now both agree on 3.

### Side-issue documented in shared-kmp-libs (NOT a kmp-test-runner bug)

- `benchmark-storage` with `kmp-test benchmark --config main --platform jvm` on JDK 21 Windows produces `org.gradle.launcher.daemon.client.DaemonDisappearedException`. The CLI handles this cleanly — emits structured `errors[].code = "module_failed"` envelope. Likely root cause is **MMKV native lib + kotlinx-benchmark + Gradle 9.1 + JDK 21 + Windows** combo (the `BenchmarkMmkvAdapter` class crashes the daemon JVM during benchmark fork). To fix in **shared-kmp-libs side**: try `--no-configuration-cache`, increase `org.gradle.jvmargs=-Xmx8g`, isolate the failing benchmark, or update kotlinx-benchmark plugin version. Other benchmark modules (V13: `*benchmark-network*`) run cleanly with the same setup.

### Deferred

- **README hero banner** — hand-drawn banner from 2026-04-27 has typos (`CONTEXTUAUZATION`, `"savings_rae"`) and informal style that may not fit the "professional infra tool" positioning. Postponed past v0.5.0 pending a cleaner regeneration. File on user's Desktop: `FondoKMPtestRunner.jpeg`.

---

## QUEUED — post-v0.3.4 ideas (newest first)

### Multi-feature token-cost measurement (v0.4 milestone)

Today's measurement (PRs #27–#29) covers **one** scenario: `kmp-test parallel` with Kover coverage on a single failing module of `shared-kmp-libs`. The "127–154× cheaper than raw gradle" claim in the README only stands up for that scenario. The CLI ships several other features the same agent-cost story applies to but we haven't measured:

- **`coverage`** (= `parallel --skip-tests`) — "I already ran tests, just regenerate the report." Approach A is `./gradlew koverXmlReport` (or `jacocoXmlReport`) + read the aggregated report; B/C are `kmp-test coverage` markdown / `--json`. Hypothesis: the largest A:C ratio of the lot, because A drops the test logs but the aggregated XML is still huge.
- **`changed`** — incremental retry of changed modules. Approach A is `git diff` filter + per-module raw gradle + reports for that subset; B/C are `kmp-test changed --json`. Hypothesis: matches `parallel`'s ratio but at smaller absolute scale.
- **`benchmark`** — `kotlinx-benchmark` runs. Approach A is `./gradlew :module:nativeBenchmark` + read benchmark report JSON/HTML; B/C are `kmp-test benchmark --json`. Hypothesis: distinct story — benchmark output is denser/structured, the savings story is "you don't need the per-iteration noise."
- **`android`** (instrumented tests on emulator) — out of scope for v0.4; needs an emulator + connected device, breaks the CI repro story. Defer to v1.0 with an Android-flavored variant of the measurement script.
- **`doctor`** — too small (<200 tokens regardless of mode). Skip.

**Coverage-tool variation worth one extra column.** The default is Kover; JaCoCo is supported but currently undocumented in the README (separate quick-fix entry below). For one project run it twice (Kover, JaCoCo) and tabulate side-by-side — the A row will diverge (different XML schemas), B/C should be identical (CLI normalises). One row per coverage tool answers "does the savings claim depend on Kover?"

**Reference projects.** Stick with `shared-kmp-libs` for v0.4 (consistent variables — same module count, same deps, same JDK). Other personal KMP projects are tempting cross-validation but at least one larger one (43 modules) hung on Windows MinGW already (per current docs) — adding a third project doesn't validate the claim more, it just adds tokens spent.

**Chart redesign (mandatory).** 4 features × 3 approaches × 4 tokenizers = 48 bars in one chart is unreadable. Two viable layouts:
- **One chart per feature** at the top of `docs/token-cost-measurement.md`, then a single "summary" row in the README with feature on x-axis and `A:C ratio` on y-axis (one number per feature). README stays scannable, doc has the full breakdown.
- **One markdown bar table per feature** (no Mermaid), like the current README structure. Renders everywhere, easy to scan for "which feature gets which savings."

Recommend the second — Mermaid xychart-beta has been a pain (PRs #28–#29 history) and a clean markdown table per feature is more durable.

**Cost projection.** `messages.countTokens` calls cost ~$3–15/MTok depending on model. 4 features × 3 captures × 3 Claude models × ~25k input tokens average ≈ 900k tokens ≈ **$3–14 per full re-measure**. Acceptable as a one-time investment per release that updates these numbers; not OK to re-run on every PR. Treat the captures in `tools/runs/` as authoritative for the docs and only re-measure when the CLI's output shape changes (e.g. `--json` schema bump).

**Effort estimate.** Per feature: ~1–2h to add the "approach A" raw-gradle equivalent in `tools/measure-token-cost.js`, capture, tokenize, write up. 3 features = 4–6h coding + ~$10 API. Plus 2–3h for the chart redesign and doc reorg. Total **~8–10h** for v0.4.

**Out of scope for this entry.** README quick-fix mentioning Kover/JaCoCo as supported coverage tools (currently undocumented — separate small entry below).

### Document Kover and JaCoCo in README (quick win)

`--coverage-tool` accepts `kover`, `jacoco`, or `none` (current default `kover`). README never mentions either tool by name — only references "coverage" generically. New users land on the README, see "coverage" with no signal that JaCoCo is supported, assume Kover-only or look for `--jacoco`-style flags. Quick fix: a 1-paragraph "Coverage tools" subsection under "Usage" naming both tools, the default, and the flag.

Estimated effort: 15 min. Probably bundle into the next docs PR.

### macOS bats end-to-end validation (deuda from PR #30)

PR #30 added `macos-latest` to the CI matrix for `build` (vitest) and `installer-e2e` (install.bats E2E only). The wider `tests/bats/` suite is intentionally skipped on macOS because the bats step **hung** for 12+ minutes on macos-latest in the first run (cancelled to avoid burning runner minutes). Suspected culprit: `tests/bats/test-concurrency.bats` (v0.3.8 lockfile work) — its concurrency tests fork a stub `gradlew` that `sleep 30`, send SIGINT to the parent, then `wait $cli_pid`. BSD signal handling on macOS may not deliver SIGINT to forked sub-processes the same way Linux does, leaving `wait` stuck.

Investigate steps:

1. Re-enable bats on macOS in `build` matrix with a `timeout 60 npx bats tests/bats/...` wrapper so the hang fails fast with logs identifying the specific test.
2. Run that specific test on a macOS machine (not GH Actions) to reproduce locally.
3. Likely fix in the test: `kill -TERM` after `kill -INT` with a short `wait` timeout; or move the test to a Linux-only `if` guard if the underlying CLI signal handling is genuinely platform-different (unlikely — Node's `spawnSync` should handle signals consistently).

Side benefit of the investigation: would surface whether v0.3.8's lockfile + signal-handling code has any real macOS bug, not just a test-only artifact.

Estimated effort: 1–2h investigation + likely a 1-line test fix once the hanging test is identified.

### Adapt CLI to project's Gradle config (workers / parallel / cache)

`kmp-test parallel` always injects `--parallel --continue` into the gradlew invocation, regardless of the consumer project's `gradle.properties`. Some projects deliberately turn parallel execution off (`org.gradle.parallel=false`), cap workers (`org.gradle.workers.max=2`), or disable build cache (`org.gradle.caching=false`) — because their build has shared state that breaks under parallel, or they're on a constrained box. Today we override silently and the user has no signal we did so.

Today's escape hatches:
- `--max-workers <N>` exists; passing `1` effectively serializes per Gradle's worker model (does NOT remove `--parallel` though, so configuration phase still parallelizes).
- `FRESH_DAEMON` env var stops daemons.
- Nothing for caching, configure-on-demand, or generic gradlew arg passthrough.

**Three levels, ship cheapest first:**

1. **Doctor surfacing (~30min)** — `kmp-test doctor` reads `<project>/gradle.properties` (and `~/.gradle/gradle.properties`) and prints the resolved values for `org.gradle.parallel`, `org.gradle.workers.max`, `org.gradle.caching`, `org.gradle.daemon`, `org.gradle.jvmargs`, `org.gradle.configureondemand`. Pure diagnostic — surfaces mismatches between project intent and what the CLI is about to do. Adds a `gradle_config{}` section to `--json` output. Zero behavior change.
2. **Generic pass-through (~1h)** — `--gradle-args "..."` global flag that appends arbitrary tokens to the gradlew invocation. Lets any agent or user inject `--no-parallel`, `--no-build-cache`, `--max-workers 1`, `-Pflag=value`, etc. Documented as an escape hatch — the CLI still has its opinionated defaults. Lower precedence than dedicated flags.
3. **Auto-detect + respect (~2-3h)** — read `gradle.properties` at startup; if `org.gradle.parallel=false`, drop the `--parallel` injection; if `workers.max` is set, do not pass `--max-workers` unless explicitly overridden on the CLI; if `caching=false`, don't fight it. Most invasive — changes default behavior. Needs migration note ("`kmp-test parallel` no longer always parallelizes — set `org.gradle.parallel=true` if you want the previous behavior, or pass `--max-workers >1`").

**Why this matters for agents.** An agent calling `kmp-test parallel` against a repo it didn't build doesn't know whether the project supports parallel execution. Today the CLI happily parallelizes a project where Gradle would normally have refused — sometimes that's a fast pass, sometimes it's a flaky failure pinned on the agent. Surfacing the mismatch (level 1) buys most of the value at minimal risk; auto-respect (level 3) eliminates the foot-gun entirely but is a behavior change.

**Out of scope.** Per-task gradle.properties (init.gradle, root vs subproject overrides) — too project-specific. Java-toolchain auto-detection (already partial via `--java-home`).

Estimated effort per level above. Recommend shipping level 1 + 2 as a single v0.4.x DX bundle alongside the existing "DX/UX parity" entry below; level 3 deserves its own release with migration notes.

### Integrate with Google's `android` CLI for agents (skills system)

Google ships an [`android` CLI for AI agents](https://developer.android.com/tools/agents/android-cli) that covers project create/describe/run/emulator but has no test subcommand. It also ships a pluggable `skills` subsystem (`android skills`, `android init` for skill registration). Idea: package `kmp-test` as a discoverable `android` skill so any agent using the official CLI auto-finds the testing slice without separate setup. Investigate the skill manifest format, registration command, what context is passed to the skill, and whether the skill can shell out to `kmp-test --json` cleanly.

Estimated effort: 2–3h investigation + ~1h to ship a minimal skill if the format is straightforward. Win: makes kmp-test a first-class citizen for agents using Google's tooling, zero integration work on the agent side.

### DX/UX parity audit — borrow good ideas from Google's `android` CLI

Google's [`android` CLI for agents](https://developer.android.com/tools/agents/android-cli) is a well-thought-out agentic toolbelt. Sister entries above already cover **integration** (ship a `kmp-test` skill, use `android describe` for discovery). This one is about **inspiration** — patterns kmp-test should consider adopting from their UX, not from their plumbing.

Audit items (priority-ranked):

**High value — small ship slices**

- **`--debug` / `--release` flags** (from `android run`): explicit build-variant selection across subcommands. Currently only `kmp-test android` has `--flavor`; add a global `--variant <debug|release>` (or paired `--debug`/`--release` switches) that propagates to the gradle invocation. The android CLI's pattern is the obvious idiom; agents already know it.
- **`kmp-test describe`** subcommand mirroring `android describe`: emit project metadata as a single JSON document (modules, test tasks per module, coverage tool detected, dependency graph hints) **without** running anything. Lets an agent plan, then execute — same shape as `android describe`'s JSON of build targets + APK paths. Today an agent has to either guess module names or run `--module-filter '*' --dry-run --json` and parse the plan.
- **`kmp-test info`** (lighter sibling to `doctor`): print environment paths/versions only (Node, JDK, gradlew, ADB), no PASS/WARN/FAIL judgments. `doctor` is for diagnosis; `info` is for "tell me where things are." Android CLI ships both.
- **`kmp-test update`** (from `android update`): re-run the install script for the latest GitHub release, idempotent. Currently users have to remember the curl one-liner.

**Medium value — quality-of-life**

- **`--sdk` / `--java-home` hoisted to CLI**: scripts already accept `--java-home`; surface it as a global CLI flag (matches `android --sdk=PARAM`). Useful when an agent needs to test against a specific JDK without env-var dance.
- **`--capture-on-fail` for `kmp-test android`**: take a screenshot + dump UI state when an instrumented test fails (Android CLI's `screen` + `layout` together). Agentic-friendly artifact — the failure context an agent gets to act on.
- **Subcommand grouping**: android groups by topic (`emulator <subsub>`, `sdk <subsub>`, `skills <subsub>`). Our flat namespace (parallel/changed/android/benchmark/coverage/doctor) is fine for 6 commands but won't scale past ~10. Decide now whether to migrate to verb/noun (`kmp-test run parallel`, `kmp-test run changed`, `kmp-test diagnose doctor`, `kmp-test diagnose info`) before more commands accumulate. Probably defer until 8+ commands.

**Lower priority — speculative**

- **`kmp-test docs`** (from `android docs`): opens the README anchor or specific section in `$BROWSER` / man-page. Marginal win when `--help` already exists.
- **`kmp-test devices`** (from `android emulator` + `screen`): wrap ADB device-listing/management. Probably out of scope — `adb devices` is fine.
- **`kmp-test sdk`** (from `android sdk`): install/check SDK packages. Out of scope — `doctor` already flags missing tooling.

Estimated effort per item: 1-3h each except the subcommand-grouping refactor (full day if done with backwards compat). Recommend shipping the high-value 4 (`--debug`/`--release`, `describe`, `info`, `update`) as a single v0.4.0 "DX-parity" PR and leaving the rest as separate backlog candidates.

### Use `android describe` JSON as module-discovery source (pending review)

The official `android` CLI's `describe` subcommand emits a JSON document of build targets + APK paths for an Android project. Currently kmp-test does its own module discovery via bash filesystem walks (`scripts/sh/lib/script-utils.sh` etc.), which on Windows MinGW is the slow path that motivated the [concurrent-invocation safety entry](#concurrent-invocation-safety-multi-agent-scenarios) above and is the suspect for the 10+ min hang against a 43-module personal project. Consider replacing or augmenting the bash discovery with an `android describe` invocation when the CLI is on PATH — gets the official Google schema, faster on Windows.

Open questions: (1) does `describe` cover KMP-only (non-Android) modules, or only AGP-rooted ones? (2) what's the schema stability guarantee, esp. for multi-module multi-target KMP? (3) fallback path when `android` CLI isn't installed — keep bash discovery as default, opt-in via `--use-android-describe` flag.

Estimated effort: 3–4h research + refactor in `scripts/sh/lib/`. Pending review on (1) above before committing — if `describe` doesn't enumerate KMP non-AGP modules it's not a drop-in replacement.

### Concurrent-invocation safety (multi-agent scenarios)

When multiple AI agents (or humans, or CI matrix shards) run `kmp-test` against the **same project root** simultaneously, several output paths collide and a few resources contend. Gradle itself is safe — its daemon serializes builds and `.gradle/` lockfiles prevent corruption. The CLI layer does not.

**Hard collisions (data clobber):**
- `<project>/coverage-full-report.md` and `<project>/benchmark-report.md` — fixed names. Two runs → last writer wins. An agent reading the report mid-write sees garbage.
- `${TMPDIR}/gradle-parallel-tests-<YYYYMMDD-HHMMSS>.log` — date-second granularity. Same-second invocations clobber. Missing `$$` (PID).

**Resource contention:**
- `kmp-test android` device auto-detect — two parallel runs without explicit `--device` both pick `emulator-5554`, tests interleave on the same device.
- `kmp-test changed` reads `git status` then runs — if another process commits between detection and execution, the detected module set is stale.

**Soft contention (slow, not corrupt):**
- Gradle's own daemon + `.gradle/` lockfile serialize builds against the same project. Second invocation just waits. Correct but invisible.

**Three tiers — Tier 1 shipped in v0.3.8 (2026-04-26):**

1. **Cheap hardening (~1h)** — ✅ **DONE in v0.3.8**: PID-suffixed `TEMP_LOG`; run-id `YYYYMMDD-HHMMSS-PID6` versioned report filenames + legacy mirror; advisory lockfile at `<project>/.kmp-test-runner.lock` with `{schema, pid, start_time, subcommand, project_root, version}` JSON; `--force` global flag bypasses a live lock; stale-lock reclaim (PID dead) is automatic; SIGINT/SIGTERM/uncaughtException handlers clean up. `--json` mode surfaces `errors[].code = "lock_held"`. Doctor + dry-run skip the lock.
2. **Audit + docs (~30min)** — partly done (Tier 1 ships with `docs/concurrency.md` stub); full collision matrix (subcommand × resource × outcome) still queued.
3. **Opt-in isolation (~3-4h)** — queued: `--isolated` global flag → injects `--project-cache-dir <tmp>` into every gradle invocation, giving each run its own `.gradle/` cache. Slow (no cache hits), but truly parallel-safe. Ideal for CI multi-agent fan-out.

Out of scope for this item: cross-host coordination (use a real lock manager), Gradle-internal concurrency tuning, or rewriting the daemon model.

### Other QUEUED ideas

- **ANSI color** — auto-detect TTY, plain output when piped
- **Maven Central publish** for Gradle plugin — currently GitHub Packages only; needs Sonatype account + signing keys
- **iOS/macOS TestKit** matrix — needs Mac hardware in CI
- **VitePress/MkDocs docs site** — separate consumer-facing docs beyond README

---

## DONE (recent — newest first)

- 2026-04-30: **v0.6.0** — "Real-world diversity hardening." Five bugs surfaced from v0.6 smoke survey against 17 official KMP projects (KaMPKit, Confetti, nowinandroid, Compose Multiplatform html, nav3-recipes, DroidconKotlin, etc.); Bug 4 (iOS support) deferred to v0.7. Suite at release: ~353 vitest + ~175 bats + ~157 Pester (+27 / +16 / +10 over v0.5.2 baseline). Real-world re-validated against KaMPKit + Confetti + nowinandroid + compose-multiplatform/html (5/5 expected behaviors confirmed):
  - **Bug 1 (#73)** — `--dry-run` no longer blocks on JDK toolchain mismatch. Pre-flight `preflightJdkCheck` now skipped when `dryRun === true`. 13/17 projects in the smoke survey hit this — `--dry-run` is for plan inspection, not run validation, so gating it on a JDK mismatch defeats the purpose. Real runs (`parallel`/`changed`/etc.) still gate. Smoke validated against KaMPKit (JDK 11) on JDK 17 host: dry-run exits 0 with plan instead of `jdk_mismatch` error.
  - **Bug 5 (#74)** — `--no-coverage` alias for `--coverage-tool none`. Users naturally reach for `--no-coverage` based on most-CLI conventions; pre-fix neither sh nor ps1 scripts wired it up — only `--coverage-tool none` worked. New `expandNoCoverageAlias` helper expands at the CLI normalization layer BEFORE flag translation, so `kmp-test parallel --no-coverage` works on both Linux and Windows. If `--coverage-tool` is already explicit, user choice wins (conservative). Smoke validated against KaMPKit: PS1 spawn args now contain `-CoverageTool none`, not the rejected `-NoCoverage`.
  - **Bug 2 (#75)** — `analyzeModule` now classifies `com.android.test` and `kotlin("android")` modules as Android. Pre-fix the AGP plugin pattern only matched `library|application`; `com.android.test` modules (Confetti's `androidBenchmark`) fell through to `type=unknown`. New `hasKotlinAndroidPlugin` regex catches both `kotlin("android")` and `id("org.jetbrains.kotlin.android")`. Real-world validated against Confetti: `androidApp` AND `androidBenchmark` now both `type=android`. Out of scope: version-catalog `alias(libs.plugins.<...>)` form (covers nav3-recipes / Confetti's modern modules — separate v0.7 scope).
  - **Bug 6 (#76)** — `detectBuildLogicCoverageHints` distinguishes CONVENTION vs SELF kover/jacoco signals. Pre-fix the naive `\bjacoco\b` scan over all build-logic files false-positived on nowinandroid (`build-logic/convention/build.gradle.kts` only NAMES jacoco-related convention plugins via `register("...Jacoco...")` blocks — but jacoco isn't applied for build-logic itself or for consumer modules from this file). Discrimination now uses path heuristic + registration-noise stripping: files under `build-logic/<X>/src/main/...` → CONVENTION; files outside → SELF (after stripping `register(...) { ... }`, `implementationClass = ...`, `id = libs.plugins.<...>`, `pluginId = ...`, `asProvider().get().pluginId`, and comments). `analyzeModule` only inherits when kind === 'convention'. Return-shape break: `{ hasKover: bool, hasJacoco: bool }` → `{ hasKover: 'convention'\|'self'\|null, ... }`. Real-world validated: nowinandroid → `hasJacoco: 'convention'` (correctly detects real `Plugin<Project>` jacoco classes under `src/main/kotlin/`); shared-kmp-libs → `hasKover: 'convention'` (continues to inherit kover for all 71 modules). Out of scope: per-module convention-plugin application detection (which modules apply `nowinandroid.android.application.jacoco`?) — needs version-catalog plugin-id mapping, separate v0.7 scope. Three CI fixtures locked under `tests/fixtures/build-logic-{convention,self,noise}-jacoco/` are loaded by both bats and Pester via `node --input-type=module -e "..."` to keep the JS classifier as the single source of truth.
  - **Bug 3 (#77)** — JS / Wasm source-set + task support in the project model. `analyzeModule` enumerates 3 additional source-set directories (`jsTest`, `wasmJsTest`, `wasmWasiTest`); `resolveTasksFor` adds `jsTest`/`wasmJsTest` as `unitTestTask` candidates AFTER the JVM ones (KMP+JS modules still pick `jvmTest`); new `webTestTask` field surfaces JS/Wasm test invocation explicitly. Sh and ps1 readers grow `pm_get_web_test_task` / `Get-PmWebTestTask`. Real-world validated against compose-multiplatform/html: `core`, `benchmark-core`, `compose-compiler-integration` all now report `sourceSets.jsTest=true` (previously these source sets weren't enumerated at all). Out of scope: actual JS test EXECUTION in CI (requires Node + browser drivers; v0.6.x follow-up). One CI fixture under `tests/fixtures/kmp-with-js/` covers both JS-only fallback (`:web-only`) and KMP+JS regression (`:kmp-multi`).
  - **Deferred to v0.7**: iOS source-set + task support (Bug 4). Adds 30% of the complexity for ~5% of KMP projects (3/17 with iosTest in survey). Requires macOS GitHub Actions runner job + Xcode integration + xcodebuild OR `gradlew iosSimulatorArm64Test` + simulator boot orchestration. Estimated 6-8h + CI hardware costs.

- 2026-04-30: **v0.5.2** — "Minor-gaps milestone." Five non-blocking follow-ups from the v0.5.1 ship cycle (Phase 4 D1+D4 deferrals + post-ship validation findings + one DX gap). Suite at release: ~326 vitest + ~159 bats + ~147 Pester (+ ~37/~14/~17 over v0.5.1 baseline). Real-world validated against shared-kmp-libs on Windows + S22 Ultra + JDK 21:
  - **Gap E (#63)** — Android `--test-filter` method-level filtering. `kmp-test android --test-filter "FQN#method"` and `--test-filter "FQN.method"` now run a single test method via AndroidJUnitRunner. cli.js splits class+method, resolves wildcards in the class part as before, recombines as `<resolvedClass>#<method>` on the wire; platform scripts (sh + ps1) detect `#` and emit BOTH `-Pandroid.testInstrumentationRunnerArguments.class=` AND `.method=` flags. Same gap closed for `kmp-test benchmark --platform android`. Smoke validated end-to-end on S22 Ultra against `:core-encryption:AndroidEncryptionServiceTest#test_encrypt_returnsBase64EncodedString` and `.test_decrypt_recoversOriginalPlaintext` (heuristic form). Tests: +13 vitest, +5 bats, +2 Pester.
  - **Gap D (#64)** — `summary.json` counter shape regression coverage. PR #54 fixed the PS1 single-item-pipeline collapse where `$modules.Count` returned hashtable-key count (5/11) instead of array length (1) on single-module runs. Bash side audited clean (`${!result_names[@]}` indexed iteration, no `${#hash[@]}` bug-pattern). New `tests/bats/test-android-summary-counts.bats` (5 tests) + `tests/pester/Android-Summary-Counts.Tests.ps1` (9 tests including a negative-guard against the bug-pattern returning) lock the contract at source level. Real-world validated during Gap E smoke run — single-module produced `totalModules:1, passedModules:1, modules.length:1`.
  - **Gap B (#65)** — JDK gate walker unification via ProjectModel fast-path. `gate_jdk_mismatch` (sh) + `Invoke-JdkMismatchGate` (ps1) now consult `pm_get_jdk_requirement` / `Get-PmJdkRequirement` first; the JS canonical walker (9-dir exclude list + depth=12) returns the MAX-of-signals into the model JSON's `jdkRequirement.min`. Legacy walkers (sh: 4 dirs unbounded, ps1: 5 dirs unbounded) preserved as fallback when model.json absent. Eliminates exclusion-list drift. Tests: +2 bats, +2 Pester.
  - **Gap C (#66)** — Cache-key SHA byte-parity across walkers AND across host platforms. JS / bash / PS1 now produce IDENTICAL SHAs for the same logical content regardless of file line endings (CRLF / LF / mixed) or runner OS. Strategy: every walker normalizes by stripping ALL `\r` then trailing `\n+` before hashing — bash uses `tr -d '\r'`, JS uses `s.replace(/\r/g, '').replace(/\n+$/, '')`, PS1 uses `-replace '\r', ''` then `-replace '\n+$', ''`. Pre-fix: Linux bash `$(cat)` only stripped LF (left stray `\r`), Windows Git Bash text-mode read collapsed CRLF→LF transparently — Linux/Windows hashes diverged. Validated against shared-kmp-libs (71 build files): `57f70e4c119d81bfd4ba8590f96025e7c3d4cfcb` on every walker. Tests: +6 vitest, +4 bats, +5 Pester (+ 1 negative guard that fixtures with same logical content but different line endings hash identically).
  - **Gap A (#67)** — Build-logic kover/jacoco detection ported into JS + coverage-task prediction in `resolveTasksFor`. New `lib/project-model.js#detectBuildLogicCoverageHints` walks `build-logic/**/*.{gradle.kts,kt}` (previously only the bash `detect_coverage_tool` scanned this location). `analyzeModule` ORs the per-module signal with the project-wide hint; `resolveTasksFor` predicts `coverageTask` from `(coveragePlugin, type)` when probe data is missing (kover+kmp → `koverXmlReportDesktop`, etc.). Closes the practical gap of "fast-path returns null when it shouldn't": shared-kmp-libs went from 0/71 to 69/71 modules with `resolved.coverageTask` populated. Tests: +16 vitest. **Scope reduction** — deletion of `detect_coverage_tool` / `get_coverage_gradle_task` from sh + ps1 deferred to a future milestone since the legacy chain is still load-bearing for projects without a model.json (no probe + no model = legacy file scan is the only detection path). The pre-work alone closed the user-visible gap.

- 2026-04-29: **v0.5.1** — "Real-world validation hardening, round 2 + Phase 4 ProjectModel refactor". Closes 11 bugs surfaced when v0.5.0 was tested against (a) a 13-module Android-only Gradle 9 project on macOS and (b) `shared-kmp-libs` on Windows + S22 Ultra physical device + JDK 21:
  - **Bug G (#52)** — `--json` envelope now surfaces real signal for `android` + `benchmark` failures. `parseScriptOutput` dispatches per-subcommand (android JSON SUMMARY, benchmark `[OK]/[FAIL]` lines + Result tally, parallel/changed/coverage legacy). New `errors[].code` discriminators (`task_not_found`, `instrumented_setup_failed`, `unsupported_class_version` w/ `class_file_version` + `runtime_version` fields, `module_failed` w/ `log_file`/`logcat_file`/`errors_file` paths). New top-level `benchmark` envelope field `{config, total, passed, failed}`. PS1 parity for benchmark per-task lines.
  - **Bug F (#52)** — JDK toolchain pre-flight gate detects three signals: `jvmToolchain(N)`, `JvmTarget.JVM_N`, `JavaVersion.VERSION_N`; takes MAX. Was: only `jvmToolchain(N)` matched, so projects pinning `jvmTarget = JVM_21` in build-logic without a toolchain crashed at runtime instead of being blocked pre-flight. Function renamed `findRequiredJdkVersion`. SH/PS1 parity.
  - **`--test-filter '*Foo*'` substring resolution (#52)** — wildcards now interpret as wildcards: `*Scale*` → `ScaleBenchmark`. Was: regex word-boundary failed when the next char was a word char.
  - **Bug B' (#51)** — `kmp-test android` no longer hardcodes `connectedDebugAndroidTest`. Probe-based selector picks the first available from `connectedDebugAndroidTest` → `connectedAndroidTest` → `androidConnectedCheck` (KMP `androidLibrary{}` DSL umbrella). New `--device-task` override flag. New `scripts/{sh,ps1}/lib/gradle-tasks-probe` with content-keyed cache at `<project>/.kmp-test-runner-cache/tasks-<sha1>.txt`.
  - **Bug B'' (#51)** — `kmp-test parallel --coverage-tool auto` no longer invokes `jacocoTestReport` on modules that don't have the plugin applied. Probe verifies task existence; emits `[SKIP coverage] <module>` and proceeds with tests only.
  - **Bug E (#51)** — `[OK] Full coverage report generated!` no longer appears with 0% coverage. New `[!] No coverage data collected from any module …` banner; `coverage.modules_contributing` integer + `warnings[].code = "no_coverage_data"` in `--json`.
  - **Bug C' (#51)** — Gradle 9 deprecation routing now covers the coverage-gen pass too (was test-execution-only). Shared `gate_gradle_exit_for_deprecation` (sh) + `Invoke-GradleExitDeprecationGate` (ps1) helper. `warnings[].context` field disambiguates `tests` / `coverage` / `shared coverage` passes; multiple notices in one run all surface as separate warnings.
  - **Bug Z (#53)** — `--json` mode hung indefinitely on Windows when the gradle daemon survived the script exit and held Node's pipe handles open. Fix: redirect child stdout/stderr to temp file descriptors via `fs.openSync` instead of buffered pipes (Windows + jsonMode only). 15+ min hang → 10s envelope.
  - **Bug H (#53 + Phase 4 step 8 in #55)** — `./gradlew` invocations had no watchdog; a hung daemon zombie'd the CLI forever. Fix: `spawnSync` now passes `timeout: KMP_GRADLE_TIMEOUT_MS` (default 30 min) plus `killSignal: 'SIGTERM'`. On timeout, the CLI emits structured `errors[].code = "gradle_timeout"`. Bridges BOTH POSIX SIGTERM and Windows ETIMEDOUT paths. Exit 3 (ENV_ERROR).
  - **Probe-cache regex fix (#54)** — `module_has_task` / `module_first_existing_task` (sh + ps1) now match real `gradlew tasks --all` output (`module:task` with no leading colon). Was: needle had a leading colon that never matched. Fixture format also realigned to gradle's actual output.
  - **PS1 single-item-pipeline collapse (#54)** — `run-android-tests.ps1` summary counts wrapped in `@(...)` to force array semantics. Was: `summary.json: { totalModules: 5, passedModules: 11, modules.length: 1 }` because `Where-Object` results collapsed to a hashtable and `.Count` returned the number of HASHTABLE KEYS instead of the array length.
  - **Phase 4 ProjectModel consolidation refactor (#55)** — single canonical introspector `lib/project-model.js` builds a JSON ProjectModel JSON file at `<project>/.kmp-test-runner-cache/model-<sha1>.json`. Sh and ps1 readers parse it via python3 / `ConvertFrom-Json`; legacy detection runs unchanged when the model is absent. Migrated call-sites: `findRequiredJdkVersion`, `module_has_test_sources`, android device-task selection, coverage-task selection — all delegate to `pm_get_*` / `Get-Pm*` first. 10 atomic commits + 47 new tests. Future detection bugs become a one-place fix.
  - Suite at release: **297 vitest + ~110 bats + ~99 Pester** (was 246 + 87 + 74 at v0.5.0). Coverage 95.84% lines / 84.03% branches on `lib/**/*.js`.
  - Real-world validation against shared-kmp-libs (Win + S22 Ultra + JDK 21): V8 (android tier 1 with model-*.json), V10/V12-real (parallel cold + warm), V13 (benchmark `--config main --platform jvm` happy-path 22s 1/1 passed), V9 (Bug H ETIMEDOUT structured envelope). Coverage report: 95.1% TOTAL on core-encryption modules.

- 2026-04-27: **v0.5.0** — "Real-world Mac validation hardening." Four production bugs surfaced on macOS running v0.4.1 against a 20-module Android-only KMP project, all bundled into one milestone:
  - **Bug A (#43)** — JDK toolchain mismatch becomes BLOCKING by default. Was: warning printed and script continued, then tests failed downstream with `UnsupportedClassVersionError`. Now: exits 3 with a per-OS `JAVA_HOME` hint; `--ignore-jdk-mismatch` / `-IgnoreJdkMismatch` downgrades to WARN; `gradle.properties` `org.gradle.java.home` bypasses the check (gradle's explicit override wins). 12 vitest + 9 bats + 6 Pester. Shared helpers `scripts/sh/lib/jdk-check.sh` + `scripts/ps1/lib/Jdk-Check.ps1`.
  - **Bug B (#44)** — modules without test source sets cause silent failures + misleading reports. Was: script invoked `:module:jacocoTestReport` blindly; api/build-logic modules failed with "task not found" but final output said `[OK] Full coverage report generated!` with 0% coverage. Now: auto-skip modules with no `src/*Test*` directory (9 KMP/Android source-set variants checked); `--exclude-modules "*:api,build-logic"` for explicit exclusion (matches `--module-filter` syntax); `--include-untested` to opt out of the auto-skip. 4 vitest + 10 bats + 9 Pester. Shared helper `module_has_test_sources` in `script-utils.sh`.
  - **Bug C (#46)** — Gradle 9 deprecation noise lumped into `errors[]`. Was: `[!]` prefix indistinguishable from real warnings; `BUILD FAILED` from the deprecation pile ended up in `errors[]`. Now: distinct `[NOTICE]` prefix (sh + ps1); JSON envelope grows `warnings: [{code: "gradle_deprecation", gradle_exit_code, tasks_passed}]`; `BUILD FAILED` suppressed in `errors[]` when paired with the deprecation notice; PowerShell script gains the 3-branch JVM-error/deprecation/per-module logic that bash already had. 10 vitest + 4 bats + 5 Pester.
  - **Bug D (#47)** — installer "installed successfully" but `kmp-test` not on PATH. Was: `~/.zshrc` updated but no `source` hint; broken outright for fish (wrote bash-syntax to `~/.profile`). Now: install.sh detects `$SHELL` and writes the right rc file with the right syntax (zsh / bash / fish via `set -gx PATH` to `~/.config/fish/config.fish` / sh fallback); per-shell hint shows both literal `export`/`set` line AND `source <rc-file>` shortcut. install.ps1: clarified that `$env:PATH` is already updated for the current session. 6 bats E2E (incl. idempotent re-run).
  - **Docs (#45)** — README gains "Heterogeneous projects (modules without tests)" + "JDK toolchain mismatch" sections; flag-reference table + exit-code row updated; `errors` vs `warnings` distinction documented in agentic section.
  - Suite totals at release: **221 vitest + 87 bats + 74 Pester**. README banner deferred per design decision.

- 2026-04-26: **v0.3.8** — Tier 1 concurrent-invocation safety. Advisory lockfile at `<project>/.kmp-test-runner.lock` (`{schema:1, pid, start_time, subcommand, project_root, version}` JSON); `--force` global flag bypasses live lock; stale-PID reclaim is automatic; SIGINT/SIGTERM/uncaughtException cleanup hooks; `--json` mode emits `errors[].code = "lock_held"`. Run-id naming `YYYYMMDD-HHMMSS-PID6` for `coverage-full-report-<id>.md`, `benchmark-report-<id>.md`, and `gradle-parallel-tests-<id>.log`; legacy stable filenames retained as a last-finished mirror so existing consumers keep working. Tests: 121 vitest (96% line coverage on cli.js, +30 lockfile-specific cases) + 12 bats (`tests/bats/test-concurrency.bats`, 3 skipped under MinGW due to MSYS PID semantics — Linux CI runs all of them) + 10 Pester 5 (`tests/pester/Concurrency.Tests.ps1`). `doctor` and `--dry-run` skip the lock since they're read-only.
- 2026-04-26: **Real token-cost metrics for the "Agentic usage" claim** — `tools/measure-token-cost.js` (Node + js-tiktoken; `--project-root`, `--module-filter`, `--test-task`, `--runs`) runs the three approaches (A: raw `./gradlew + read build/reports/**`, B: `kmp-test parallel`, C: `kmp-test parallel --json`) against any KMP project and emits a markdown table with token counts. First run against `shared-kmp-libs:core-result:desktopTest` produced **A 12,816 tok / B 376 tok / C 100 tok** — `--json` is **128× cheaper than raw gradle**. Captured run logs committed to `tools/runs/`; methodology + caveats in `docs/token-cost-measurement.md`; README "Agentic usage" section updated to link the doc. Replaces the prior qualitative claim with a self-auditable measurement.
- 2026-04-26: **v0.3.7** — DX & agentic features bundle. `--dry-run` (skip spawn, print/JSON the resolved plan), `kmp-test doctor` subcommand (5 env checks: Node, shell, gradlew, JDK, ADB; human table + `--json` array), and `--test-filter <pattern>` passthrough (gradle `--tests` for JVM, `-Pandroid.testInstrumentationRunnerArguments.class=` for Android with `*Pattern*` → FQN resolution by source scan). Plus Conventional Commits enforcement on PR titles via `.github/workflows/commit-lint.yml` (adapted inline from AndroidCommonDoc reusable workflow — repo stays standalone). 91 vitest + 52 bats tests. **Branch protection must be updated to add `commit-lint / 🔤 Commit Lint` as required check.**
- 2026-04-25: **v0.3.6** — `auto-tag.yml` → `publish-release.yml` cascade now fires automatically via `workflow_call` (no PAT, no rotation). v0.3.5 had needed manual `gh workflow run -f tag=...` to ship artefacts because GitHub blocks `GITHUB_TOKEN`-pushed events from triggering downstream workflows. v0.3.6's merge was the first 100 %-hands-off cascade end-to-end (auto-tag → release artefacts → npm publish → gradle publish), ~90 sec from merge to all artefacts visible. (PR #15 + #16)
- 2026-04-25: **v0.3.5** — `scripts/install.ps1` `Resolve-LatestVersion` now works in PowerShell 7+ via new `Get-LocationHeader` helper (the old `$Response.Headers["Location"]` indexer threw on `HttpResponseHeaders`). Also added `develop` to `ci.yml` triggers (PR-to-develop checks were not running). Was the first real exercise of the auto-publish pipeline (v0.3.4's was a no-op for auto-tag). Caught while validating v0.3.4 install.ps1 against the live GitHub Release. (PR #13 + #14)
- 2026-04-25: **Auto-publish on push to `main`** — `publish-npm.yml` + `publish-gradle.yml` + new `auto-tag.yml` all trigger on push to main with skip-if-already-published idempotency. Bumping `package.json` (and `gradle-plugin/build.gradle.kts`) + merging develop → main now produces npm publish + gradle publish + git tag + GitHub Release artefacts in one shot. Documented in CLAUDE.md gitflow section.
- 2026-04-25: **`develop` branch** added as integration branch alongside `main`. Daily work goes to `develop`; releases promote `develop → main` and trigger the auto-publish pipeline.
- 2026-04-25: **v0.3.4** — Agentic CLI. `--json` / `--format json` output mode, per-subcommand `--help`, pre-flight `gradlew` check, semantic exit codes (0/1/2/3). README "Agentic usage — token-cost rationale" section. Shipped via 4 PRs (#8 feature + #9 bin-name + #10 benchmark platform-filter + #11 coverage + 2 latent bug fixes).
- 2026-04-25: **Full E2E installer test coverage** (W31.5c post-ship hardening) — `scripts/build-artifact.sh` + 5 bats E2E + 4 Pester E2E + `installer-e2e` CI matrix job. Catches all 3 historical bugs (wrapper dir, missing package.json, version sync) as regression tests.
- 2026-04-25: **v0.3.3** — third hotfix; `package.json` version bumped from stale `0.2.0` to `0.3.3`. First fully working release.
- 2026-04-25: **v0.3.2** — second hotfix; added `package.json` to release artifacts.
- 2026-04-25: **v0.3.1** — first hotfix; wrapped release artifacts in `kmp-test-runner-${VER}/` directory so installer extraction works.
- 2026-04-25: **v0.3.0** — W31.5c original ship. Installer scripts (POSIX + PowerShell) + `CHANGELOG.md` + README polish + `publish-release.yml` workflow.
- 2026-04-25: **v0.2.0** — W31.5b. Gradle plugin shape (5 tasks, Kover auto-detect, GitHub Packages publish).
- 2026-04-24: **v0.1.0** — W31.5a. Initial npm CLI release with 5 subcommands (parallel, changed, android, benchmark, coverage).
- 2026-04-25: **Branch protection** on `main` (PR required, 6 CI checks, linear history, enforce_admins).

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **`changed` orchestrator migrated from bash/ps1 to Node** — second sub-entry of the v0.8 STRATEGIC PIVOT (3 more sub-entries pending: `android`, `coverage`, `parallel`). Logic now lives in `lib/changed-orchestrator.js` (~270 LOC) per PRODUCT.md "logic in Node, plumbing in shell". The orchestrator owns git-diff invocation (`git status --porcelain` for all changes; `git diff --cached --name-only` for `--staged-only`), file→module mapping via longest-prefix match against `discoverIncludedModules()` (the actual settings.gradle.kts include list — replaces the hand-rolled `core/feature/shared/data/ui` prefix heuristic that missed top-level KMP modules), `--include-shared` / `SHARED_PROJECT_NAME` filter, `--show-modules-only` short-circuit, subprocess dispatch to `run-parallel-coverage-suite.{sh,ps1}` (per BACKLOG sub-entry 5: refactored to in-process call once the parallel suite migrates), and envelope construction reusing `parseScriptOutput` / `applyErrorCodeDiscriminators` / `buildJsonReport` from `lib/cli.js`. **No version bump** — lands in `[Unreleased]`; the v0.8.0 stamp comes when all 5 sub-entries land.
- **Wrapper shrink:** `scripts/sh/run-changed-modules-tests.sh` 293 → 7 LOC; `scripts/ps1/run-changed-modules-tests.ps1` 315 → 7 LOC. Both `exec node lib/runner.js changed "$@"`. Net 608 → 14 LOC across the two wrappers + ~270 LOC orchestrator + ~50 LOC shared `lib/orchestrator-utils.js` (extracted from `benchmark-orchestrator.js`). PS1 wrapper sheds the pre-v0.4 `Get-ModuleFromFile` `.NET String.Split` bug class entirely — Node has no equivalent regex/string-split landmines.
- **Gradle plugin `ChangedTestsTask` updated** to extract `lib/` + the parallel suite + its sourced helpers (`scripts/sh/lib/{audit-append,coverage-detect,gradle-tasks-probe,jdk-check,project-model,script-utils}.sh`) and invoke `node lib/runner.js changed`. The script-helper bundle drops once sub-entry 5 lands and the orchestrator dispatches to `runParallel({...})` in-process.
- **`lib/runner.js` orchestrators are dynamic-imported** — each `if (sub === ...)` branch lazy-imports its orchestrator module so per-task `libResources` arrays in the Gradle plugin only need to bundle the orchestrator (and its transitive deps) for THAT task. Adding sub-entries 3-5 won't grow existing TestsTask bundle lists.

### Added
- **`changed: { detected_modules, staged_only, base_ref }`** envelope field — gives agents structured visibility into git-diff-to-module mapping. `base_ref` is hard-coded to `"HEAD"` for now (sub-entry 5 may surface `--base-ref <X>` for cross-branch diff). Additive, non-breaking.
- **`errors[].code = "no_changed_modules"` discriminator** — clean zero-set after walking the diff. Distinct from `no_test_modules` ("filter rejected everything" — happens when modules are detected but `--module-filter` excludes them all). Treated as a soft error (`exit_code:0`) by `enforceErrorsExitCodeInvariant` per BACKLOG line 105.
- **`predictTaskFromSourceSets` helper in `lib/project-model.js`** (BACKLOG line 215-244) — when `gradleTasks` is null (probe didn't run / cache miss) but `analysis.sourceSets` carries flags, predict `unitTestTask` / `webTestTask` / `iosTestTask` / `macosTestTask` by walking the same candidate orders the populated branch uses. Closes the `jvm()→jvmTest` fallback bug for KMP modules with only `jvm()` target — `:shared` no longer mis-routes to `desktopTest` and trip the WS-1 reactive task-not-found path.

### Tests
- New `tests/vitest/changed-orchestrator.test.js` — 33 cases: WS-4 reproducer (top-level `:shared`), parametrized walk over all 18 sourceSetNames, nested-module longest-prefix precedence, `--staged-only` git-diff path, `no_changed_modules` discriminator, `--show-modules-only` short-circuit (no parallel-suite spawn), multi-module dispatch + `--module-filter` shape, envelope schema, `--include-shared`/`SHARED_PROJECT_NAME` filter, error-code discrimination preempts `no_summary`, banner emission flow-through, non-git directory.
- 7 new vitest cases in `tests/vitest/project-model.test.js` covering `predictTaskFromSourceSets` precedence chains.
- `tests/bats/test-changed.bats` shrinks from 3 wrapper-internal tests to 9 wrapper-invocation contracts (≤40 LOC cap, no `git status` / `get_module_from_file` references in shell).
- `tests/pester/Invoke-ScriptSmoke.Tests.ps1` drops the `Get-ModuleFromFile` AST-test block and the `splat-parity` block (both reference internals that no longer exist in the thin wrapper); replaces with 3 wrapper-shape contracts.

### Fixed
- **WS-4 (`kmp-test changed` returns `[]` for top-level KMP modules with file changes under sourceSet dirs)** — closed **by construction**. The legacy bash + ps1 wrappers used a hardcoded prefix list (`core/feature/shared/data/ui`) that missed Confetti's top-level `:shared` and similar shapes. The new orchestrator walks the actual `discoverIncludedModules()` list from `settings.gradle.kts` and uses longest-prefix matching against the file paths — every declared module is recognized regardless of nesting depth or naming. Reproducer (`cd Confetti && touch shared/src/commonMain/.../Model.kt && kmp-test changed --show-modules-only --json`) now returns `changed.detected_modules: ["shared"]` instead of `[]`.
- **WS-5 invariant exempts `no_changed_modules`** alongside `no_summary` — clean working tree exits 0 with structured signal in `errors[].code` instead of being promoted to `TEST_FAIL` by the discriminator-vs-exit-code invariant.
- **Half of UX-1 fix** (modules with `commonTest` source set but no `jvm()` / `androidTarget()` for the requested test type) — the changed orchestrator passes detected modules verbatim to the parallel suite (which already has the partial UX-1 fix from PR #103) instead of dropping them with the legacy hardcoded-prefix filter. Full UX-1 closure lands in sub-entry 5.

### Internal
- **`lib/orchestrator-utils.js`** (~50 LOC) — extracted `stripKotlinComments`, `readBuildFile`, `discoverIncludedModules` from `benchmark-orchestrator.js`. Sub-entries 3-5 import from the same module so the settings.gradle.kts walking shape doesn't drift.
- **`buildJsonReport` and `enforceErrorsExitCodeInvariant` in `lib/cli.js`** grow non-breaking surface for the `changed.*` field passthrough and the `no_changed_modules` soft-error exemption respectively.

### Changed — sub-entry 1 (benchmark)
- **`benchmark` orchestrator migrated from bash/ps1 to Node** — first sub-entry of the v0.8 STRATEGIC PIVOT (4 more sub-entries pending: `changed`, `android`, `coverage`, `parallel`). Logic now lives in `lib/benchmark-orchestrator.js` (~290 LOC) per PRODUCT.md "logic in Node, plumbing in shell". The orchestrator owns module discovery (kotlinx-benchmark / androidx.benchmark plugin detection via `build.gradle.kts` scan), per-platform task dispatch (`:<mod>:desktop{Smoke|Stress|}Benchmark` for JVM, `:<mod>:connectedAndroidTest` for Android), adb device probe (`KMP_TEST_SKIP_ADB=1` opt-out preserved), and envelope construction. Reuses `buildJsonReport` / `envErrorJson` / `resolveAndroidTestFilter` / `splitClassMethod` from `lib/cli.js` — no parser duplication. New `lib/runner.js` entrypoint dispatcher (invoked by the thin shell wrappers; emits sentinel-bracketed envelope when `--json`). `lib/cli.js#main()` grows a small migrated-subcommand short-circuit (`COMMANDS.benchmark.migrated = true`) that uses the orchestrator's envelope directly when `--json`; non-migrated subcommands flow through the existing parser path unchanged. **No version bump** — this lands in `[Unreleased]` and the version stays at 0.7.0 until all 5 sub-entries have landed.
- **Wrapper shrink:** `scripts/sh/run-benchmarks.sh` 538 → 7 LOC; `scripts/ps1/run-benchmarks.ps1` 471 → 7 LOC. Both `exec node lib/runner.js benchmark "$@"`. PRODUCT.md non-negotiables: no associative arrays, no parallel loops, no output parsing in any wrapper. `scripts/sh/lib/benchmark-detect.sh` (281 LOC) and `scripts/ps1/lib/Benchmark-Detect.ps1` (306 LOC) deleted — logic moved to the orchestrator.
- **Gradle plugin `BenchmarkTestsTask` updated** to extract the bundled `lib/` tree and invoke `node lib/runner.js benchmark` directly (bypassing the shell hop entirely for this consumer shape). New `syncLib` + `syncPackageJson` Gradle tasks bundle the lib/ files and `package.json` into the published JAR resources. Requires `node` on PATH for gradle-plugin users.

### Added
- **`benchmark.platforms: ["jvm" | "android"]`** envelope field reflects which legs actually ran (sorted alphabetically). Additive, non-breaking per PRODUCT criterion 4.

### Tests
- New `tests/vitest/benchmark-orchestrator.test.js` — 15 cases: jvm dispatch + config variants, android adb resolution + `KMP_TEST_SKIP_ADB` opt-out, `no_test_modules` discrimination, empty-result regression (locks the WS-2 / Bash-3.2 bug class into JS by construction), `--test-filter` jvm pass-through + android FQN + `#` method split, banner shape, envelope schema.
- `tests/bats/test-benchmark.bats` shrinks 346 → 8 wrapper-invocation contracts.
- `tests/pester/Benchmark-Detect.Tests.ps1` shrinks 141 → 7 wrapper-invocation contracts.
- New fixture `tests/fixtures/kmp-with-benchmark/` (3 modules: `bench-jvm` + `bench-android` + `no-bench` negative).

### Fixed
- **WS-2 (`declare -A` Bash 4+ crash on macOS Bash 3.2.57)** and the empty-array `set -u` landmine class — closed **by construction** for the benchmark feature. JS has no Bash version dependency, so those failure modes cannot exist in the new orchestrator. The bug class returns for the other 4 features until their respective sub-entries migrate.
- **Discovery comment-strip bug** — the legacy bash regex matched `include(":foo")` even when prefixed by `//` (commented out in `settings.gradle.kts`), causing gradle to fail with `Cannot locate tasks that match ':foo:...'`. The new orchestrator strips Kotlin-style `//` line comments and `/* … */` block comments before matchAll, so commented-out includes are correctly ignored. Surfaced in real-workspace E2E validation.
- **Per-module discriminator pass** — orchestrator now feeds the union of per-module gradle stdout+stderr through `applyErrorCodeDiscriminators` after dispatch, upgrading the generic `module_failed` code to the more specific `task_not_found` / `unsupported_class_version` / `instrumented_setup_failed` / `no_test_modules` when gradle's output matches those signatures.
- **Gradle plugin task properties: missing `@get:Internal` annotation** — Gradle 9.x rejects `lateinit var extension: KmpTestRunnerExtension` on `DefaultTask` subclasses with "property 'extension' is missing an input or output annotation". All 5 task classes (`AndroidTestsTask`, `BenchmarkTestsTask`, `ChangedTestsTask`, `CoverageTask`, `ParallelTestsTask`) now annotate the field as `@get:Internal` since it's wired by the plugin, not by Gradle's task graph. CoverageTask's `koverDetected` property gets the same treatment.

### Internal
- **`KMP_TEST_RUNNER_EMIT_ENVELOPE=1`** — env var injected by `lib/cli.js` into the wrapper's spawn when the subcommand is `migrated:true` AND `--json` was requested. `lib/runner.js` honors either `--json` on its argv OR this env var to decide whether to emit the sentinel-bracketed envelope. Closes the discovered gap where `lib/cli.js#consumeJsonFlag` strips `--json` upstream, leaving the wrapper unable to know it was invoked in JSON mode.
- **`applyErrorCodeDiscriminators` is now exported** from `lib/cli.js` so the orchestrator can reuse it directly without falling back to a no-op stub.

## [0.7.0] — 2026-05-01

### Documentation
- **README v0.7.0 surface (Phase 4).** Surgical update — adds a new "Platforms supported" table covering JVM/Desktop, Android (unit + instrumented), iOS, macOS, JS/Wasm with per-target gradle task names and where each runs. New "Multi-platform test dispatch" section explains how `--test-type ios|macos` consults the project model per module to pick `iosSimulatorArm64Test` (Apple-silicon) → `iosX64Test` (Intel/CI) → `iosArm64Test` (device) → `iosTest` (umbrella) and the analogous macOS chain, plus when to use `SKIP_IOS_MODULES` / `SKIP_MACOS_MODULES` env vars. Flag reference table grows a `--test-type <type>` row and a new env-var sub-table. Gradle plugin DSL example bumps to `version "0.7.0"` and shows the new `testType` property. "What's new" leads with v0.7.0 (iOS / macOS) followed by v0.6.x. Test-count notes in CONTRIBUTING-style block updated to current values.
- **Backlog entry: buildable cross-platform E2E fixture project.** Added a v0.7.x / v0.8 candidate that captures the largest known testing-debt item — building a real Kotlin Multiplatform fixture (gradle wrapper + iosX64() + iosSimulatorArm64() + macosArm64() + jvm() + js() + android targets) plus a CI matrix workflow that runs `kmp-test parallel --test-type {ios,macos,common,...}` against it on macos-latest / ubuntu-latest / windows-latest. Captures risk + cost + ship-when criteria so the work has a clear shape when we pick it up.

### Added
- **Gradle plugin `testType` property + macOS CI smoke job (v0.7.0 Phase 3).** The Gradle plugin's `KmpTestRunnerExtension` grows a `testType` property (default `""` = wrapper auto-detect — preserves existing behavior). When non-empty, `parallelTests`, `changedTests`, and `coverageTask` propagate `--test-type <value>` to the bundled wrapper script. Accepts the same set as the npm CLI: `common | desktop | androidUnit | androidInstrumented | ios | macos | all`. Gradle plugin users who want iOS dispatch now write `kmpTestRunner { testType = "ios" }` instead of stringly-typed shell-out workarounds. New `gradle-plugin-test-ios` CI job runs the existing Gradle TestKit suite on `macos-latest` (informational by default; promote to required in branch protection when the v0.7 line stabilises). Catches mac-specific build/test regressions (BSD vs GNU shell tooling, JDK locator differences, gradle daemon quirks) before they reach iOS users. Tests: +3 Gradle TestKit (`gradle-plugin/src/test/kotlin/.../TestTypeExtensionTest.kt`) — extension defaults to empty / DSL accepts `testType = "ios"` / DSL accepts `testType = "macos"`.
- **Wrapper iOS / macOS test dispatch (v0.7.0 Phase 2).** `scripts/{sh,ps1}/run-parallel-coverage-suite.{sh,ps1}` now accept two new `--test-type` / `-TestType` values: `ios` and `macos`. When set, the wrapper consults the v0.7.0 Phase 1 project-model readers (`pm_get_ios_test_task` / `pm_get_macos_test_task` in sh; `Get-PmIosTestTask` / `Get-PmMacosTestTask` in ps1) to pick the per-module gradle task name. The model returns `iosSimulatorArm64Test` on Apple-silicon hosts, `iosX64Test` on Intel hosts/CI, `iosArm64Test` for device runs, with `iosTest` (umbrella) as last fallback; macOS picks among `macosArm64Test` → `macosX64Test` → `macosTest`. When the model is absent, the wrapper falls back to `iosSimulatorArm64Test` / `macosArm64Test` (most-portable defaults). New `SKIP_IOS_MODULES` / `SKIP_MACOS_MODULES` env vars mirror the existing `SKIP_DESKTOP_MODULES` / `SKIP_ANDROID_MODULES` shape. Configuration banner now reflects the new platform names: `Test Type: ios (per-module iosTestTask)` and `Test Type: macos (per-module macosTestTask, host-native)`. macOS dispatches host-natively (no simulator boot orchestration in the wrapper); iOS relies on Gradle's built-in simulator boot since AGP/KMP 1.9+ (Approach A from the v0.7.0 plan). Legacy filesystem walker (`_module_has_test_sources_fs` in sh; `Get-Module-Has-Test-Sources` candidates in ps1) extends from 9 → 18 directories so iOS-only / macOS-only modules without an umbrella `iosTest/` directory still register as testable when the project model JSON is absent. CLI `--help` text updated accordingly. Tests: +4 vitest in `cli.test.js` (POSIX flag pass-through / Windows PS1 translation `-TestType` / dry-run JSON envelope shows the new value), +8 bats (`tests/bats/test-parallel-ios-dispatch.bats` covering `--help` surface, `--test-type ios|macos` acceptance without usage error, banner text, default fallback dispatch, and legacy filesystem-walker recognition of `iosX64Test`), +7 Pester (`tests/pester/Parallel-Ios-Dispatch.Tests.ps1` mirror including ValidateSet rejection of unknown values).
- **iOS / macOS source-set + task support in the project model (v0.7.0 Phase 1).** `lib/project-model.js` now enumerates 18 test source-set directories (12 baseline + 6 added: `iosX64Test`, `iosArm64Test`, `iosSimulatorArm64Test`, `macosTest`, `macosX64Test`, `macosArm64Test`) so KMP modules declaring `iosX64()` / `iosSimulatorArm64()` / `macosArm64()` etc. surface their per-target test source sets without falling back to the umbrella `iosTest` / `nativeTest` directories. `resolveTasksFor` grows two new fields on its return shape: `iosTestTask` (candidate order `iosSimulatorArm64Test` → `iosX64Test` → `iosArm64Test` → `iosTest` — Apple-silicon hosts pick the simulator task, Intel hosts/CI pick the x64 task, device runs pick arm64, umbrella `iosTest` stays last) and `macosTestTask` (candidate order `macosArm64Test` → `macosX64Test` → `macosTest`). Both surface alongside (not inside) `unitTestTask`'s candidate race — KMP modules with `jvmTest + iosSimulatorArm64Test` still pick `jvmTest` for `unitTestTask` (regression-locked), while iOS surfaces only via the explicit `iosTestTask` field. Sh + ps1 readers grow `pm_get_ios_test_task` / `pm_get_macos_test_task` and `Get-PmIosTestTask` / `Get-PmMacosTestTask`, mirroring the v0.6 Bug 3 webTestTask pattern. Wrapper-side dispatch is deferred to v0.7.0 Phase 2. New CI fixture `tests/fixtures/kmp-with-ios/` with 3 modules (`:ios-only` declaring only `iosX64()`, `:macos-only` declaring only `macosArm64()`, `:kmp-multi` declaring `jvm() + iosSimulatorArm64()`). Tests: +14 vitest (1 source-set discovery for the 6 new dirs + 13 in `resolveTasksFor` for the iOS/macOS describe suite covering candidate order, fallback, regression guards, and field independence), +6 bats (`tests/bats/test-ios-macos-support.bats`), +6 Pester (`tests/pester/Ios-Macos-Support.Tests.ps1`).

## [0.6.2] — 2026-04-30

### Added
- **`errors[].code = "no_test_modules"` discriminator (v0.6.2 Gap 1.1).** v0.6.1 Phase J stress test against 9 ex-AMBER-JDK projects (post Adoptium 11 install) surfaced 3 distinct real-world causes that all collapsed to the generic `code: "no_summary"` parse-gap fallback. The most common — Nav3Guide-scenes, kmp-production-sample-master — emits `[ERROR] No modules found matching filter: <pat>` after `[SKIP] composeApp (no test source set ...)`. New discriminator in `applyErrorCodeDiscriminators` matches the wrapper's literal stdout line and pushes `{ code: 'no_test_modules' }` on `state.errors`. The existing `sawAnything` check already suppresses the no_summary fallback once any discriminated code fires, so Gap 1.1 + Gap 1.3 work together: agents can branch on `errors[0].code === 'no_test_modules'` to suggest `--include-untested` instead of bug-reporting "the script crashed". Tests: +3 vitest (literal line / quoted-in-log false-negative / preempts no_summary) + 1 bats + 1 Pester end-to-end.
- **`skipped: [{module, reason}]` array on JSON envelope (v0.6.2 Gap 1.2).** The legacy wrapper script (`run-parallel-coverage-suite.{sh,ps1}`) emits `[SKIP] <module> (<reason>)` lines as it discovers modules to test — discovery-time skips on stderr (`excluded by --exclude-modules`, `no test source set`), test-task-time skips on stdout (`no jvmTest tests`). Pre-fix this was just noise; agents had to re-parse the wrapper's stdout to know what got skipped. Now `parseSkippedModules` runs over stdout+stderr and surfaces a structured array, so agents can suggest `--include-untested` when the user expected tests, TSV summaries can show `skipped:N` alongside `tests:N`, and CI dashboards can audit module-filter mistakes. Additive field; existing JSON consumers ignore unknown keys. Tests: +6 vitest (single SKIP / multi stdout+stderr / malformed reject / dedup / empty-on-clean-runs / envelope surfacing) + 1 bats + 1 Pester end-to-end.

### Changed
- **No-summary discrimination contract locked (v0.6.2 Gap 1.3).** The behavior already worked — `parseScriptOutput`'s `sawAnything` check includes `state.errors.length > 0`, so once any of `task_not_found` / `unsupported_class_version` / `instrumented_setup_failed` / `no_test_modules` / `module_failed` / etc. fires, the generic `no_summary` fallback skips. But the contract lived on a single condition; a future refactor could regress without ripping the cover off any feature test. +4 vitest regression guards lock the discriminate-or-fallback (never both) contract for each of the four discriminated codes. Test-only change.

## [0.6.1] — 2026-04-30

### Added
- **`errors[].code = "no_summary"` for parse-gap fallback envelope (v0.6.x Gap 1).** When `parseScriptOutput` runs every recognizer (legacy/Android/benchmark) AND every shared signal (BUILD SUCCESSFUL/FAILED, deprecation warnings) without finding anything actionable, it pushes a fallback `errors[]` entry. Pre-fix the entry only had a `message`, leaving downstream agents unable to discriminate this path from other error states without string-matching on `message`. Every other error path already carries a `code` field (`jdk_mismatch`, `lock_held`, `gradle_timeout`, `task_not_found`, `unsupported_class_version`, `instrumented_setup_failed`, `module_failed`, `gradle_deprecation`, `no_coverage_data`, `json_summary_parse_failed`, `lock_write_error`); this fallback now does too. Wide-smoke 2026-04-30 surfaced 4/20 projects (DroidconKotlin-main, kotlinconf-app-main, androidify-main, OFFICIAL/OmniSound) hitting this path. Tests: +1 vitest (empty output asserts `code === 'no_summary'`); existing parse-gap test strengthened to assert the new field.
- **`alias(libs.plugins.<X>)` plugin reference resolution in module-type detection (v0.6.x Gap 3).** `analyzeModule` now recognizes the version-catalog DSL form alongside the existing literal `id("...")` and `kotlin("...")` forms. New `parseVersionCatalog(projectRoot)` helper reads `gradle/libs.versions.toml` and parses the `[plugins]` section into a `Map<dottedKey, pluginId>` (table-form `key = { id = "...", ... }` and string-form `key = "id:version"` both supported; TOML keys' `-` become `.` so the consumer's `alias(libs.plugins.kotlin.multiplatform)` matches a TOML `kotlin-multiplatform = ...` entry). When the catalog is missing or doesn't contain the alias key, a small suffix heuristic resolves namespaced aliases (e.g. `libs.plugins.nowinandroid.android.application` → `com.android.application`). The resolved plugin ids participate in the existing booleans (`hasAndroidPlugin || hasAndroidViaAlias`, etc.) so all four type categories (kmp/android/jvm) classify correctly. Wide-smoke 2026-04-30 surfaced nav3-recipes, Compose Multiplatform's modern modules, and Confetti as projects where alias-only modules previously classified `unknown`. Tests: +6 vitest in `analyzeModule` (TOML table-form per type + string-form + heuristic fallback + namespaced + literal regression), +5 vitest covering `parseVersionCatalog` directly (table form, string form, no `[plugins]`, malformed, section bleed-through guard). New CI fixture `tests/fixtures/version-catalog-alias-plugins/` with 4 modules (`:app` AGP-alias, `:shared` KMP-alias, `:jvm-lib` JVM-alias-string-form, `:namespaced-app` heuristic-only) loaded by `tests/bats/test-version-catalog-alias.bats` (4 tests) and `tests/pester/Version-Catalog-Alias.Tests.ps1` (4 tests).
- **Multi-JDK auto-selection for JDK toolchain mismatch (v0.6.x Gap 2).** When the project requires a JDK version different from the host default, kmp-test now consults a system-wide JDK catalogue (`lib/jdk-catalogue.js`) and auto-selects a matching install if present, injecting `JAVA_HOME` and a prepended `PATH` into the gradle subprocess environment. Before: the gate fired with `jdk_mismatch` even when a matching JDK was installed locally — the user had to manually export `JAVA_HOME` between projects. After: 9/20 wide-smoke projects (KaMPKit, nav3-recipes, etc.) that exited with `jdk_mismatch` against a JDK 21 host default now succeed automatically when an Adoptium/Zulu/Microsoft JDK 11 or 17 is installed. The catalogue scans standard install locations per platform: Windows (`C:\Program Files\Eclipse Adoptium|Zulu|Microsoft|Java|Semeru|BellSoft|Azul Zulu`), macOS (`/Library/Java/JavaVirtualMachines/*/Contents/Home/release` bundle layout), Linux (`/usr/lib/jvm/*`, `/opt/java`, `/opt/jdk`), plus `JAVA_HOME` env. Each install's `release` file gives major version + vendor; entries are dedup'd by realpath. New CLI flags: `--java-home <path>` (explicit override — wins over catalogue auto-select), `--no-jdk-autoselect` (disable catalogue lookup and fall through to gate as v0.6.0). Precedence: `--java-home` > `gradle.properties org.gradle.java.home` > catalogue auto-select > `--ignore-jdk-mismatch` > host default (gate fires). `kmp-test doctor` surfaces an "Installed JDKs" check row listing `JDK <ver> (<vendor>)` for every detected install (or WARN when empty). Tests: new `tests/vitest/jdk-catalogue.test.js` (8 cases — Linux/Windows/macOS layouts + JAVA_HOME probe + dedup + JDK 8 format + malformed release file). +5 vitest in `cli.test.js` (catalogue match auto-selects + env injection / `--java-home` wins / `--no-jdk-autoselect` disables / catalogue empty / catalogue non-matching). +2 bats (`tests/bats/test-doctor.bats`) and +2 Pester (`tests/pester/Doctor-Jdk-Catalogue.Tests.ps1`) verify the doctor "JDK catalogue" surface.

### Fixed
- **Per-module convention-plugin coverage detection (v0.6.x Gap 4).** v0.6 Bug 6 introduced CONVENTION vs SELF discrimination on the build-logic coverage signal but kept blanket inheritance: any consumer module without a per-module signal inherited the project-wide convention plugin. nowinandroid surfaces the over-prediction — its `build-logic/convention/` publishes ~14 plugins (only some add jacoco), and only the modules that explicitly apply a `*Jacoco*ConventionPlugin` plugin id should report `coveragePlugin: 'jacoco'`. Pre-fix, `kmp-test parallel --coverage-tool jacoco` reported all 35 nowinandroid modules as jacoco-aware; the actual run produced `modules_contributing: 0` because most modules don't have jacoco apply. New `parseBuildLogicPluginDescriptors(projectRoot, catalog)` helper scans `build-logic/<X>/build.gradle.kts` for `gradlePlugin { plugins { register("<key>") { id = ...; implementationClass = "<Class>" } } }` blocks and resolves `id = libs.plugins.<X>.get().pluginId` via the version catalog (or accepts literal `id = "..."` strings). It also handles the precompiled-script-plugin pattern (`<plugin-id>.gradle.kts` files under `build-logic/<X>/src/main/kotlin/` — filename IS the plugin id). `addsCoverage` is determined heuristic-first from the class name / filename: `/Jacoco/i` → `'jacoco'`, `/Kover/i` → `'kover'`. `analyzeModule` now collects the consumer's applied plugin ids (from `id("...")`, `kotlin("...")`, and Gap 3's `alias(libs.plugins.<X>)` resolved ids) and only inherits when one of them matches a descriptor with `addsCoverage`. Backwards-compat: when `parseBuildLogicPluginDescriptors` returns an empty array (e.g. a pure `Plugin<Project>` setup with no `gradlePlugin {}` block — the `build-logic-convention-jacoco` fixture pattern), `analyzeModule` falls through to the v0.6 broad-inheritance behavior via `buildLogicHints` so existing convention-plugin users (shared-kmp-libs's kover setup; the convention fixture) keep working unchanged. Tests: +7 vitest in `parseBuildLogicPluginDescriptors` (empty / literal id / catalogue-resolved id / kover class / precompiled-script filename / unresolvable / dedup) and +7 vitest in `analyzeModule` (jacoco-via-id / jacoco-via-alias / non-coverage applied / nothing applied / nowinandroid-noise regression / convention fallback for fixtures without `gradlePlugin{}` / per-module signal still wins). New CI fixture `tests/fixtures/build-logic-selective-jacoco/` with 3 consumer modules (`:app-with-jacoco`, `:app-with-noop`, `:app-no-convention`) loaded by `tests/bats/test-build-logic-selective-jacoco.bats` (4 tests) and `tests/pester/Build-Logic-Selective-Jacoco.Tests.ps1` (4 tests). The Bug 6 anti-noise regression suite (`test-build-logic-coverage-kind.bats`, 4 tests) continues to pass — the `build-logic-noise-jacoco` fixture has a `gradlePlugin{}` block that names jacoco classes, but consumer `:core-baz` doesn't apply any of those plugin ids → coveragePlugin stays null.

## [0.6.0] — 2026-04-30

### Changed
- **`detectBuildLogicCoverageHints` now distinguishes CONVENTION vs SELF kover/jacoco signals (v0.6 Bug 6).** The v0.5.2 Gap A pre-work added a naive `\bjacoco\b` (and `\bkover\b`) scan over every file under `build-logic/`. nowinandroid surfaced the false positive: `build-logic/convention/build.gradle.kts` only NAMES jacoco-related convention plugins via `gradlePlugin { plugins { register("androidApplicationJacoco") { id = libs.plugins.<...>.jacoco.get().pluginId; implementationClass = "AndroidApplicationJacocoConventionPlugin" } } }` — the substring "jacoco" appears multiple times but jacoco is never APPLIED to build-logic itself or to consumer modules from this file. Pre-fix, `analyzeModule` propagated `coveragePlugin: 'jacoco'` to all 35 nowinandroid modules; the actual `kmp-test parallel --coverage-tool jacoco` run reported `modules_contributing: 0` because no module had jacoco apply for its own tests. Discrimination now uses two signals:
  - **CONVENTION**: any file under `build-logic/<X>/src/main/...` mentioning kover/jacoco. Precompiled-script plugins (`*.gradle.kts` under `src/main/kotlin/`) and `Plugin<Project>` class sources both apply effects to consumer modules from this location.
  - **SELF**: any file in `build-logic/` outside `src/main/` that references kover/jacoco AFTER stripping plugin-registration noise (`register("...") { ... }` blocks, `implementationClass = "..."`, `pluginId = ...`, `id = libs.plugins.<...>`, `asProvider().get().pluginId`) and comments. What survives the strip is a real `plugins { jacoco }` / `apply { plugin("jacoco") }` reference in build-logic's own buildscript.

  Return shape changes from `{ hasKover: boolean, hasJacoco: boolean }` to `{ hasKover: 'convention' \| 'self' \| null, hasJacoco: 'convention' \| 'self' \| null }`. `analyzeModule` only inherits when `kind === 'convention'`. CONVENTION wins over SELF when both fire (a build-logic module both compiles itself with jacoco AND publishes a jacoco convention plugin). Comment lines mentioning kover/jacoco (e.g. `// adds jacoco support — see ...`) are stripped before regex checks at both `detectBuildLogicCoverageHints` and per-module `analyzeModule` layers, eliminating doc-comment false positives.

  Real-world surface: shared-kmp-libs continues to inherit `coveragePlugin: 'kover'` for all 71 modules (its convention plugin lives under `build-logic/src/main/kotlin/` — the CONVENTION path); nowinandroid no longer false-positives.

  Tests: +6 vitest (existing 4 updated to the new shape, +6 new covering convention vs self vs registration-noise vs convention-wins-over-self), +4 bats (`tests/bats/test-build-logic-coverage-kind.bats`), +6 Pester (`tests/pester/Build-Logic-Coverage-Kind.Tests.ps1`). Three new CI fixtures locked under `tests/fixtures/build-logic-{convention,self,noise}-jacoco/` are loaded by both bats and Pester via `node --input-type=module -e "..."` to keep the JS classifier as the single source of truth — any drift breaks at least one suite.

### Added
- **JS / Wasm source-set + task support in the project model (v0.6 Bug 3).** `analyzeModule` now enumerates three additional source-set directories — `jsTest`, `wasmJsTest`, `wasmWasiTest` — bringing the total from 9 to 12. `resolveTasksFor` candidates extend with `jsTest`/`wasmJsTest` AFTER the JVM candidates so a KMP module with both `jvmTest` and `jsTest` continues to pick `jvmTest` for its `unitTestTask` (regression-guarded). JS-only KMP modules with no JVM-side test task now resolve `unitTestTask: 'jsTest'` instead of `null`. New top-level `webTestTask` field surfaces JS/Wasm test invocation explicitly so scripts can run the web side alongside (or instead of) JVM tests without inferring intent from `unitTestTask`. Sh and ps1 readers grow `pm_get_web_test_task` (sh) and `Get-PmWebTestTask` (ps1) mirroring the JDK / coverage helpers; both return empty / `$null` when the module has no JS/Wasm targets, the model is missing, or the probe didn't see the candidate task. Real-world surface: Compose Multiplatform's `html/` modules and other JS-only KMP projects (KaMPKit's `web` examples, kotlinconf-app's web frontends) were previously invisible to the model. Out of scope for this entry: actual JS test execution in CI (requires Node + browser drivers; deferred to a v0.6.x follow-up). Tests: +7 vitest covering source-set detection (jsTest / wasmJsTest / wasmWasiTest) + webTestTask resolution + JS-only fallback + KMP+JS regression guards, +4 bats (`tests/bats/test-js-wasm-support.bats`) + 4 Pester (`tests/pester/Js-Wasm-Support.Tests.ps1`) loading the new `tests/fixtures/kmp-with-js/` fixture (two modules: a JS-only `:web-only` and a KMP+JS `:kmp-multi`).
- **`--no-coverage` alias for `--coverage-tool none` (v0.6 Bug 5).** Users naturally reach for `--no-coverage` based on the conventions of most CLIs, but neither the bash nor PowerShell scripts ever wired it up — only `--coverage-tool none` was supported. Pre-fix, `kmp-test parallel --no-coverage` on Windows raised `A parameter cannot be found that matches parameter name 'NoCoverage'` (`translateFlagForPowerShell` produced `-NoCoverage`, which `run-parallel-coverage-suite.ps1` doesn't declare); on Linux/macOS bash scripts also rejected the unknown flag. New `expandNoCoverageAlias` helper expands `--no-coverage` to `--coverage-tool none` at the CLI normalization layer (BEFORE flag translation), so both platforms accept the natural form. If `--coverage-tool` is already explicit on the command line, the user's choice wins and `--no-coverage` is dropped silently (conservative; last-wins would be ambiguous). Tests: +4 vitest (3 helper unit, 1 end-to-end through `main()` asserting final spawn argv carries `--coverage-tool none` and NOT `-NoCoverage`).

### Fixed
- **`analyzeModule` now classifies `com.android.test` and `kotlin("android")` as Android (v0.6 Bug 2).** Pre-fix the AGP plugin pattern only matched `id("com.android.(library|application)")`, so test-fixtures-only modules using `id("com.android.test")` (e.g. Confetti's `androidBenchmark`) showed `type=unknown`. The kotlin-android plugin (`kotlin("android")` / `id("org.jetbrains.kotlin.android")`) — separate from AGP itself — also had no detection at all. Modules using only the kotlin-android plugin id, or AGP paired with kotlin-android where the AGP id form wasn't picked up for any reason, fell through every type branch and ended up `unknown` — which suppresses `resolved.coverageTask` prediction and surfaces no platform-specific tasks. Now `hasAndroidPlugin` regex includes `test` in the alternation, and a new `hasKotlinAndroidPlugin` regex catches both `kotlin("android")` and `id("org.jetbrains.kotlin.android")`. `type='android'` when EITHER signal fires. Tests: +4 vitest covering both new patterns + a regression for the pre-existing AGP+kotlin-android pair.
- **`--dry-run` no longer blocks on JDK toolchain mismatch (v0.6 Bug 1).** The pre-flight gate added in v0.5.0 (Bug A) gated both real runs AND `--dry-run`, on the rationale of "users see the mismatch before expecting success." In practice this defeats the whole point of `--dry-run`: the dry-run path doesn't spawn gradle, doesn't read tests, doesn't even acquire the lockfile — it just prints the resolved plan and exits 0. Gating it on JDK version blocks legitimate plan inspection on misconfigured hosts (13/17 official KMP projects in the v0.6 smoke survey hit this). Now `preflightJdkCheck` is skipped when `dryRun === true`; real runs (`parallel`/`changed`/`android`/`benchmark`/`coverage` without `--dry-run`) still gate as before. `--ignore-jdk-mismatch` continues to bypass for non-dry-run cases. Tests: existing "gates --dry-run too" test inverted; +1 vitest verifies `--dry-run --json` on a mismatched JDK emits a plan with empty `errors[]` (NOT a `jdk_mismatch` error envelope).

## [0.5.2] — 2026-04-30

### Added
- **Build-logic convention-plugin coverage detection in JS (v0.5.2 Gap A pre-work).** `lib/project-model.js#detectBuildLogicCoverageHints` walks `<projectRoot>/build-logic/**/*.{gradle.kts,kt}` for `kover` / `jacoco` / `testCoverageEnabled` signals — previously only the bash `detect_coverage_tool` scanned this location. `analyzeModule` now ORs the per-module signal with the project-wide hint, so modules that consume a kover convention plugin without a per-module reference still get `coveragePlugin: 'kover'` populated. Closes the gap where shared-kmp-libs and similar build-logic-driven projects had `coveragePlugin` correctly identified per-module but `resolved.coverageTask` unset.
- **Coverage-task prediction in `resolveTasksFor` (v0.5.2 Gap A pre-work).** When `gradleTasks` is null (probe didn't run / timed out) but `analysis.coveragePlugin` is non-null, the resolver now predicts the canonical task name from `(coveragePlugin, type)`: `kover + kmp` → `koverXmlReportDesktop`, `kover + android` → `koverXmlReportDebug`, `kover + jvm` → `koverXmlReport`, `jacoco + *` → `jacocoTestReport`. Replaces the legacy `get_coverage_gradle_task` mapping when the model fast-path is available. Real-world impact: shared-kmp-libs went from 0/71 modules with `resolved.coverageTask` populated to 69/71, so the v0.5.1 model fast-path tier 1 actually fires in production instead of always falling through to the legacy chain. Tests: +16 vitest covering build-logic detection, per-module signal precedence, prediction matrix, and end-to-end model assembly.

### Changed
- **JDK mismatch gate now consults ProjectModel fast-path before legacy walker (v0.5.2 Gap B).** `gate_jdk_mismatch` (sh) and `Invoke-JdkMismatchGate` (ps1) read `pm_get_jdk_requirement` / `Get-PmJdkRequirement` first when `<project>/.kmp-test-runner-cache/model-<sha>.json` exists; the model's `jdkRequirement.min` is the MAX-of-signals computed by the JS canonical walker (lib/project-model.js — 9-dir exclude list + depth=12). Legacy walker (sh: 4 dirs unbounded depth, ps1: 5 dirs unbounded depth) is preserved as fallback when the model is absent. Eliminates exclusion-list drift between sh/ps1/JS for projects with a generated model. End-to-end validated 2026-04-29 against `shared-kmp-libs` (model says JDK 21, current JDK 21 → no false-positive; model fast-path engaged per `_pm_locate_model_file` log).

### Fixed
- **Cache-key SHA byte-parity across sh / ps1 / JS walkers AND across Linux / macOS / Windows runners (v0.5.2 Gap C).** `lib/project-model.js#computeCacheKey`, `scripts/sh/lib/gradle-tasks-probe.sh:_kmp_compute_cache_key`, and `scripts/ps1/lib/Gradle-Tasks-Probe.ps1:Get-KmpCacheKey` now produce IDENTICAL SHAs for the same logical content regardless of file line endings (CRLF / LF / mixed) or host platform. Pre-fix divergences: JS regex `/\n+$/` left a stray `\r` on CRLF files; PS1 `Get-Content -Raw` preserved trailing newlines entirely; Linux bash `$(cat foo)` only stripped trailing LF (left a stray `\r` from CRLF files), while Windows Git Bash transparently collapsed CRLF→LF on read so its hashes diverged from Linux bash. Post-fix: every walker normalizes content by stripping ALL `\r` then trailing `\n+` before hashing. Bash uses `tr -d '\r'` before `$(cat)`; JS uses `s.replace(/\r/g, '').replace(/\n+$/, '')`; PS1 uses `-replace '\r', ''` then `-replace '\n+$', ''`. End-to-end validated 2026-04-30 against shared-kmp-libs (71 build files): all three walkers produced `57f70e4c119d81bfd4ba8590f96025e7c3d4cfcb`. Removes the documented divergence comment from `lib/project-model.js` (lines 55-69 pre-fix). Tests: +6 vitest, +4 bats, +5 Pester — all assert that fixtures with identical logical content but different line endings hash to the SAME canonical SHA on every platform; any regression breaks at least one suite.

### Tests
- **Regression coverage for `summary.json` counter shape on single-module Android runs (v0.5.2 Gap D).** PR #54 fixed PowerShell single-item-pipeline collapse where `$modules.Count` returned hashtable key count (5/11) instead of array length (1) on single-module runs. The bash side was audited clean (uses explicit loop counters via `${!result_names[@]}` indexed iteration, not `${#hash[@]}` on associative arrays). New `tests/bats/test-android-summary-counts.bats` (5 tests) locks the bash counter-math invariants; new `tests/pester/Android-Summary-Counts.Tests.ps1` (9 tests) locks PR #54's `@(...)` array-forcing wrappers + a negative guard that prevents the bug-pattern from being reintroduced. End-to-end validated 2026-04-29 on S22 Ultra against `shared-kmp-libs:core-encryption` — single-module run produced `totalModules:1, passedModules:1, modules.length:1`.

### Added
- **Android `--test-filter` method-level filtering (v0.5.2 Gap E).** `kmp-test android --test-filter "FQN#method"` and `kmp-test android --test-filter "FQN.method"` now run a single test method via AndroidJUnitRunner — `cli.js` splits class+method, resolves wildcards in the class part as before, and recombines as `<resolvedClass>#<method>` on the wire. Platform scripts (`run-android-tests.{sh,ps1}` + `run-benchmarks.{sh,ps1}`) detect the `#` separator and emit BOTH `-Pandroid.testInstrumentationRunnerArguments.class=<class>` AND `-Pandroid.testInstrumentationRunnerArguments.method=<method>` (AndroidJUnitRunner accepts both runner-args together). Same gap closed for `kmp-test benchmark --platform android`. JVM-side (`parallel`/`changed`/`coverage`/`benchmark --platform jvm`) was already supported via Gradle's native `--tests "FQN.method"` pattern — that path stays untouched. The `.method` form uses a heuristic (last `.`-segment lowercase, ≥ 2 segments) since `#` is the only unambiguous separator; classes with lowerCamelCase names should use `#` to disambiguate.

## [0.5.1] — 2026-04-29

### Added
- **`errors[].code` discriminators** so agents can branch on failure cause without regex on `message`. New codes:
  - `task_not_found` — gradle "Cannot locate tasks that match" (e.g. KMP `androidLibrary{}` DSL has no `connectedDebugAndroidTest`).
  - `unsupported_class_version` — `UnsupportedClassVersionError` with `class_file_version` + `runtime_version` integer fields (e.g. kotlinx-benchmark internals require JDK 21+ on a JDK 17 toolchain).
  - `instrumented_setup_failed` — android emulator/device couldn't host instrumented tests.
  - `module_failed` — per-module failure in android/benchmark output, with `module`, `platform` (benchmark), `log_file`, `logcat_file`, `errors_file` paths so agents can `Read` the full detail without re-running.
- **`warnings[].code = "json_summary_parse_failed"`** when the android script's JSON SUMMARY block is present but malformed (truncated stdout, JSON parse error). Parser falls back to scanning the bracket-table.
- **Top-level `benchmark` field on the JSON envelope** for `kmp-test benchmark --json`: `{ config, total, passed, failed }`. Conditionally included — non-benchmark subcommands keep the existing envelope shape unchanged.
- **PowerShell benchmark script (`scripts/ps1/run-benchmarks.ps1`) now emits the bash-parity `[OK]/[FAIL] <module> (<platform>) completed/failed` per-task lines and `Result: X passed, Y failed` tally** so the parser handles Windows output identically to Linux/macOS.
- **`scripts/{sh,ps1}/lib/gradle-tasks-probe`** — content-keyed gradle task-set probe shared by the coverage layer (Bug B'') and the android task selector (Bug B'). Runs `./gradlew tasks --all --quiet` once and caches the output at `<project>/.kmp-test-runner-cache/tasks-<sha1>.txt` keyed by the SHA1 of `settings.gradle.kts` + `gradle.properties` + every per-module `build.gradle.kts`. Any content change invalidates the cache deterministically. 60s timeout (override via `KMP_PROBE_TIMEOUT`); probe failure is non-fatal — callers fall back to legacy behavior.
- **`--device-task <name>` flag for `kmp-test android`** (translated to `-DeviceTask` on PowerShell). Force a specific gradle task name, useful for KMP modules using the new `androidLibrary { }` DSL where neither `connectedDebugAndroidTest` nor `connectedAndroidTest` exists.
- **`coverage.modules_contributing` integer field in the `--json` envelope.** Counts how many modules actually produced coverage data (parsed XML with `> 0` lines). Distinguishes "0% coverage but ran successfully" from "0 modules had a coverage plugin applied".
- **`warnings[].code = "no_coverage_data"`** — surfaced when zero modules contributed coverage data. Pairs with the new console banner `[!] No coverage data collected from any module …` so agents and humans get the same signal.
- **`warnings[].context` field on `gradle_deprecation` warnings** — `"tests"`, `"coverage"`, or `"shared coverage"`. Lets agents disambiguate which gradle pass produced the deprecation noise. Multiple deprecation warnings can now be emitted in a single run (one per pass) — previously only the first matched.

### Fixed
- **`--json` envelope now surfaces real signal for `android` and `benchmark` failures (Bug G).** Previously a failed `kmp-test android --json` or `kmp-test benchmark --json` returned `{"errors": [{"message": "Build failed with an exception."}]}` and dropped per-module detail on the floor — even though the underlying script wrote a fully structured summary to stdout. `parseScriptOutput` now dispatches per-subcommand: android parses the `=== JSON SUMMARY ===` JSON block (per-module status, log file paths, retry flag); benchmark parses the `[OK]/[FAIL] <module> (<platform>) completed/failed` lines plus the `Result: X passed, Y failed` tally; parallel/changed/coverage keep the legacy `Tests: X total | …` shape. Backward compatible — when subcommand is omitted (e.g. internal callers, downstream consumers), the legacy parser runs.
- **`--test-filter '*Foo*'` now substring-matches Android instrumented test classes (`*Scale*` → `ScaleBenchmark`).** `findFirstClassFqn` previously stripped wildcards and searched for the literal core with a regex word boundary (`class\s+Scale\b`), which failed to match `class ScaleBenchmark` because `B` is a word char and breaks the boundary. The function now interprets wildcards as wildcards: `*Foo*` (substring), `Foo*` (prefix), `*Foo` (suffix), `Foo` (exact, preserves prior behavior). Real-world reproducer: `kmp-test benchmark --platform android --test-filter '*Scale*'` now correctly resolves to a class FQN and runs; before, gradle received the literal `*Scale*` and the instrumentation runner errored with `Failed loading specified test class '*Scale*'`.
- **JDK toolchain pre-flight gate (Bug A) now also detects `JvmTarget.JVM_N` and `JavaVersion.VERSION_N` declarations (Bug F).** Previously `findJvmToolchainVersion` only scanned for `jvmToolchain(N)` calls. Projects that pin `compilerOptions { jvmTarget.set(JvmTarget.JVM_21) }` in a convention plugin under `build-logic/` (without declaring `jvmToolchain`) slipped through the gate, then crashed at runtime with `UnsupportedClassVersionError class file v65 vs runtime v61` when the gradle worker used a JDK 17 JAVA_HOME. Three signals are now recognized — `jvmToolchain(N)`, `JvmTarget.JVM_N`, `JavaVersion.VERSION_N` — and the MAX is taken as the project's effective JDK requirement. Function renamed to `findRequiredJdkVersion`. SH/PS1 parity: `scripts/sh/lib/jdk-check.sh` and `scripts/ps1/lib/Jdk-Check.ps1` updated symmetrically. Real-world impact: a project compiling to JVM 21 bytecode is now blocked at pre-flight in <1s instead of failing 10+ minutes into a benchmark run.
- **Bug B'' (v0.5.1) — `kmp-test parallel --coverage-tool auto` invoked `:module:jacocoTestReport` for modules that had no coverage plugin applied.** Real-world repro: an Android-only KMP project with 13 testable modules, none using `kover`/`jacoco` plugins per-module, but the version catalog mentioned `kover`. Tests ran cleanly, then coverage gen crashed with `Cannot locate tasks that match ':core:integration:jacocoTestReport'`. Fix: after content-based detection picks a candidate task, the new gradle-tasks probe verifies it exists; if not, the script emits `[SKIP coverage] <module> (no coverage plugin applied)` and continues.
- **Bug E (v0.5.1) — `[OK] Full coverage report generated!` displayed even when zero modules contributed data.** When all modules were skipped via Bug B'' (or coverage gen failed silently), the OK banner was misleading. Fix: count modules with `> 0` lines after parsing; if zero, replace the banner with `[!] No coverage data collected from any module — verify your project has kover/jacoco configured (see https://github.com/oscardlfr/kmp-test-runner#coverage-setup)` and emit the new `no_coverage_data` warning.
- **Bug C' (v0.5.1) — Gradle 9 deprecation routing was test-execution-only.** Bug C (v0.5.0) routed `gradle_deprecation` to `warnings[]` for the test pass, but the coverage-generation pass had its own gradle invocation with separate exit-handling that didn't apply the same gate — coverage-gen deprecations were silently swallowed. Fix: extracted the 3-branch logic to `script-utils.sh::gate_gradle_exit_for_deprecation` (sh) and `Script-Utils.ps1::Invoke-GradleExitDeprecationGate` (ps1); both the test pass AND both coverage passes (main project + shared-libs) now route through it. A single run can now emit two `[NOTICE]` lines (one per pass) — both surface as separate warnings with `context` field set.
- **Bug B' (v0.5.1) — `kmp-test android` hardcoded `connectedDebugAndroidTest` / `connectedAndroidTest` matrix breaks the new KMP `androidLibrary { }` DSL.** That DSL exposes the umbrella `androidConnectedCheck` instead. Fix: replaces the hardcoded `is_kmp` × `has_flavor` decision tree with a probe-based selector — for each module, picks the first candidate that exists from `connectedDebugAndroidTest` → `connectedAndroidTest` → `androidConnectedCheck` (flavor variant prepended when `--flavor` is set). When the probe is unavailable, falls back to the legacy hardcoded matrix.
- **PowerShell-only bug found by tests during this work**: `Get-KmpHashString` had `param([string]$Input)`, but `$Input` is a PowerShell automatic variable (the pipeline-input enumerator) so the parameter never bound and the cache always hashed the empty string. Renamed the parameter to `$Text`. Without this, the cache would have been a no-op on Windows.
- **Bug Z (v0.5.1) — `--json` mode hung indefinitely on Windows with no output.** `pwsh.exe` inherited Node's pipe handles to its grandchildren (`gradlew.bat` → gradle java daemon). The daemon survived the script exit by hours and held the pipes open, so `spawnSync` waited for stdout EOF that never arrived. Real-world repro: `kmp-test android --json --module-filter '*core-encryption*'` against shared-kmp-libs hung 15+ min with 0 bytes stdout (the actual gradle work completed in 4s — the rest was wait-for-pipe-close). Fix: on Windows + jsonMode, redirect child stdout/stderr to temp file descriptors via `fs.openSync` instead of buffered pipes — the daemon may keep the FD open, but `spawnSync` only waits for the script process to exit, not for FD close. POSIX path keeps default `encoding: 'utf8'` (no inheritance issue). Production validation: `kmp-test parallel --json` against shared-kmp-libs now completes in 50s with full envelope (3/3 tests passed, `no_coverage_data` warning surfaced).
- **Bug H (v0.5.1) — no watchdog on `./gradlew` invocations.** When gradle hung (typical: JDK switch confusing daemon cache, or misconfigured project), the CLI process stayed zombie indefinitely; the lock file detected the zombie but didn't auto-recover. Fix: `spawnSync` now passes `timeout: KMP_GRADLE_TIMEOUT_MS` (default 30 minutes) plus `killSignal: 'SIGTERM'`. On timeout, the CLI surfaces a structured `errors[].code = "gradle_timeout"` envelope (with the env var hint) so agents can distinguish hung-daemon from failing-tests, and exits with `EXIT.TEST_FAIL` so the lock cleanup runs. Override per-run with `export KMP_GRADLE_TIMEOUT_MS=3600000` for slow projects.
- **Probe-cache regex didn't match real `gradlew tasks --all` output (v0.5.1).** `module_has_task` and `module_first_existing_task` (sh + ps1) constructed the needle as `:${module}:${task}` with a leading colon, but `gradlew tasks --all` emits `module:task - description` with no leading colon at column 0. Real-world impact: every probe call against shared-kmp-libs returned rc=1 ("no candidate") even when the task was right there in the cache; the android script then fell back to the legacy umbrella-task heuristic and emitted a misleading `[!] No standard android task found for <module> — trying :<module>:androidConnectedCheck` warning. Fix: drop the leading colon from the needle (caller-supplied `:module` syntax is still accepted via `TrimStart(':')`); update the bats + Pester fixtures to use realistic gradle output (the synthetic `:module:task` fixture format paired with the buggy regex was hiding the bug).
- **PowerShell single-item-pipeline collapse in `run-android-tests.ps1` summary counts (v0.5.1).** A single matching `Where-Object` result on `$modules` collapsed to a hashtable; `$modules.Count` then returned the number of HASHTABLE KEYS (5: Name, Path, HasFlavor, IsKmp, Description) instead of the array length 1. Same pitfall on `$totalSuccess`/`$totalFailure` over `$results` (11 keys: Module, Status, Duration, Success, TestsPassed, TestsFailed, TestsSkipped, LogFile, LogcatFile, ErrorsFile, Retried). Single-module runs reported `summary.json: { totalModules: 5, passedModules: 11, modules.length: 1 }`. Fix: wrap the three `Where-Object` results in `@(...)` to force array semantics. Also rewrote the filter predicate for clarity (`foreach` over `$filterList` instead of nested `Where-Object` + `Select-Object -First 1`).

### Changed
- **`ProjectModel` consolidation refactor (v0.5.1 Phase 4).** Six detection helpers that previously lived in three languages (`findRequiredJdkVersion` in `lib/cli.js`, `gate_jdk_mismatch` in sh, `Invoke-JdkMismatchGate` in ps1, `module_has_test_sources`, `detect_coverage_tool`, the gradle-tasks probe) with subtly different exclusion lists, depth limits, and cache keys are now backed by a single canonical introspector at `lib/project-model.js`. The model writes a v1-schema JSON file to `<projectRoot>/.kmp-test-runner-cache/model-<sha1>.json` (same SHA1 cache-key algorithm as the gradle-tasks probe so both invalidate on the same content changes). Sh readers (`scripts/sh/lib/project-model.sh` — `pm_get_jdk_requirement`, `pm_get_unit_test_task`, `pm_get_device_test_task`, `pm_get_coverage_task`, `pm_module_type`, `pm_module_has_tests`) parse via python3; ps1 readers (`scripts/ps1/lib/ProjectModel.ps1` — same surface as `Get-Pm*` cmdlets) parse via `ConvertFrom-Json`. Both surfaces are fail-soft: when the model JSON is absent / unreadable / corrupt, readers return empty / $null and the existing legacy detection runs unchanged. Migrated call-sites: `findRequiredJdkVersion` (delegates to `aggregateJdkSignals(projectRoot).min`), `module_has_test_sources` (sh + `Test-ModuleHasTestSources` ps1, the latter moved from `run-parallel-coverage-suite.ps1` to `lib/Script-Utils.ps1` for layout parity), android device-task selection in `run-android-tests.{sh,ps1}` (3-tier fallback: model → existing `module_first_existing_task` probe → legacy hardcoded matrix; `--device-task` override pre-empts all three), and coverage-task selection in `run-parallel-coverage-suite.{sh,ps1}` (model fast-path → existing `detect_coverage_tool` + `module_has_task` chain → `[SKIP coverage]` emit). Zero behavior change for end users — model fast-path returns the same answer the legacy chain would, just without N stat() calls + N grep() calls per module on large repos. After this lands, every detection-related future bug becomes a one-place fix in `lib/project-model.js`; sh and ps1 inherit through JSON.

### Tests
- 17 new vitest tests across 8 describe blocks: android/benchmark summary parsing (5), error-code discriminators (2), subcommand-aware fallback (1), optional `benchmark` envelope field (1), wildcard test-filter resolution (4: substring/prefix/suffix/exact-boundary), extended JDK signal detection (3: jvmTarget, JavaVersion, MAX-of-mixed), regression for `*Scale*` against `ScaleBenchmark` (1).
- 6 new bats tests: 4 pinning script-source contracts (`=== JSON SUMMARY ===` delimiter + JSON field names + `Result:` tally + `[OK]/[FAIL]` per-task format), 2 covering the extended JDK gate (`JvmTarget.JVM_N` in build-logic + MAX-of-signals).
- 5 new Pester tests: 3 for the script-source contracts on the ps1 side, 2 for the extended JDK gate.
- **+8 vitest** in `tests/vitest/cli.test.js` — Bug E warning + `coverage.modules_contributing` field, Bug C' multi-context deprecation parsing, `--device-task` flag round-trip via `translateFlagForPowerShell`.
- **+11 bats** in `tests/bats/test-gradle-tasks-probe.bats` (new file) — cache hit/miss, content-keyed invalidation, tristate `module_has_task`, candidate priority in `module_first_existing_task`, `clear_gradle_tasks_cache`.
- **+13 bats** across `test-coverage.bats` (Bug B'' + Bug E wiring), `test-android.bats` (Bug B' wiring + `--device-task` flag), `test-deprecation-notice.bats` (rewritten to test the helper directly + assert call sites).
- **+21 Pester** in `tests/pester/Gradle-Tasks-Probe.Tests.ps1` (new file) covering the same surface as the bats lib tests, plus assertions that both `parallel.ps1` and `run-android-tests.ps1` source the lib + call the right entrypoints.
- **+6 Pester** rewriting `Deprecation-Notice.Tests.ps1` against the new `Invoke-GradleExitDeprecationGate` helper.

## [0.5.0] — 2026-04-27

> **"Real-world Mac validation hardening"** — bundles 4 production bugs surfaced when running `kmp-test v0.4.1` on macOS against a 20-module Android-only KMP project. Bug A (#43): JDK toolchain mismatch becomes blocking by default. Bug B (#44): auto-skip modules without test source sets + `--exclude-modules` flag for heterogeneous projects. Bug C (#46): Gradle 9 deprecation noise routed to `warnings[]` not `errors[]`. Bug D (#47): per-shell installer PATH detection (zsh / bash / fish / sh) + accurate post-install hint. Plus README docs (#45) for the new flags + JSON schema. Total: 50+ new tests across vitest, bats, Pester.

### Added
- **`warnings[]` array in the `--json` envelope** for non-fatal signals that agents should branch on differently than `errors[]`. First entry: `gradle_deprecation` — emitted when gradle exits non-zero solely because of Gradle 9+ deprecation warnings while every individual task still passed. Includes `gradle_exit_code` and `tasks_passed` integer fields so callers can sanity-check.
  - Old behavior: gradle's exit code 1 in this scenario ended up in `errors[]` alongside real test failures, forcing agents to do error-message regex to disambiguate.
  - New behavior: parser detects the `[NOTICE] Gradle exited with code N but all M tasks passed individually` line and routes it to `warnings[]` with `code: "gradle_deprecation"`. The corresponding `BUILD FAILED` line is suppressed in `errors[]` when paired with the deprecation notice (it's the same signal).
  - The legacy `[!]` prefix variant is still recognized by the parser for backward compatibility with older direct-script invocations.
  - `warnings: []` is now part of the canonical envelope shape — emitted by `buildJsonReport`, `envErrorJson`, and `buildDryRunReport` (always-present, defaults to empty).

- **`--exclude-modules <list>` and `--include-untested` flags** for `parallel` + `changed` (translated to `-ExcludeModules` / `-IncludeUntested` on PowerShell). Solves the "not all modules have tests" case in heterogeneous projects (e.g. KMP setups where `:api`, `:build-logic`, and aggregator modules by convention have no test source set).
  - **Auto-skip by default**: modules whose filesystem path contains no `src/test`, `src/commonTest`, `src/jvmTest`, `src/desktopTest`, `src/androidUnitTest`, `src/androidInstrumentedTest`, `src/androidTest`, `src/iosTest`, or `src/nativeTest` directory are silently filtered out before gradle is invoked. Each skip prints `[SKIP] <module> (no test source set — pass --include-untested to override)` to stderr so the tally stays honest.
  - **Explicit exclusion**: `--exclude-modules "*:api,build-logic"` accepts comma-separated globs (matches `--module-filter` syntax). Excluded modules print `[SKIP] <module> (excluded by --exclude-modules)`.
  - **Opt-out**: `--include-untested` re-includes modules with no test source set (for projects under early development where modules exist but tests don't yet).
  - Real-world bug context: previously, an :api module with no test source set caused `BUILD FAILED in 791ms` ("Task 'jacocoTestReport' not found in project ':api'") followed by the misleading `[OK] Full coverage report generated!` with 0% coverage. The auto-skip catches this before gradle is invoked.
  - Added shared helper `module_has_test_sources` in `scripts/sh/lib/script-utils.sh` and `Test-ModuleHasTestSources` inline in `scripts/ps1/run-parallel-coverage-suite.ps1`. Both `find_modules` (sh) and `Find-Modules` (ps1) honor the new flags. `changed.sh` / `changed.ps1` pass them through to the suite.

### Changed
- **Installer per-shell PATH UX (`scripts/install.sh` + `install.ps1`)**. Previously `curl ... | bash` printed `kmp-test-runner v0.4.1 installed successfully` and added the `export PATH` line to `~/.zshrc`, but `kmp-test --version` immediately after returned `command not found` — users had to manually re-`export PATH` or restart the shell.
  - sh installer: detects `$SHELL` and now writes the rc file with the right syntax for fish (`set -gx PATH …` to `~/.config/fish/config.fish`), zsh (`~/.zshrc`), bash (`~/.bashrc`), or `~/.profile` for unknown shells. Final hint personalizes per shell: shows both the literal `export`/`set` line for the current session AND the `source <rc-file>` shortcut.
  - ps1 installer: clarified the final message — `$env:PATH` is already updated for the current PowerShell session (so `kmp-test --version` works immediately), and new sessions pick up the user PATH automatically. Only cmd.exe needs a restart.
  - Tests: 6 new bats E2E in `tests/installer/install.bats` covering zsh / bash / fish / unknown-shell detection + idempotent re-runs.

- **`[NOTICE]` prefix replaces `[!]` for the Gradle 9 deprecation handler line in markdown mode** (sh + ps1 parallel scripts). Distinct prefix lets humans tell benign deprecation noise from real `[!]` warnings at a glance, and lets the JSON parser route it correctly.
- **PowerShell parallel script gains the missing JVM-error / deprecation 3-branch logic** that the bash sibling has had since the original v0.3.x. Previously the ps1 had a single coarse `if (testExitCode -ne 0 -and failureCount -eq 0)` that printed `[!]` for all non-zero exits, masking the JVM-level vs deprecation distinction on Windows.

- **JDK toolchain mismatch is now BLOCKING by default** (was: warning that printed and continued). When `jvmToolchain(N)` in any `*.gradle.kts` differs from the major version reported by `java -version`, kmp-test exits 3 (`EXIT.ENV_ERROR`) before spawning gradle, with an actionable per-OS hint for setting `JAVA_HOME`. Previously the script warned and proceeded, which caused tests to fail downstream with `UnsupportedClassVersionError` (real-world bug surfaced on macOS running v0.4.1 against a 20-module Android-only project).
  - Bypass with `--ignore-jdk-mismatch` (sh/cli) or `-IgnoreJdkMismatch` (ps1) — downgrades the block to a `WARN` line.
  - The check is skipped when `gradle.properties` declares `org.gradle.java.home` pointing to an existing directory (gradle's explicit JDK override wins).
  - JSON envelope: `errors[0]` carries `code: "jdk_mismatch"` plus `required_jdk` / `current_jdk` integer fields.
  - Gates real runs **and** `--dry-run` so users see the mismatch before expecting a successful run.
  - Added in `lib/cli.js` (covers all gradle-spawning subcommands), `scripts/sh/lib/jdk-check.sh`, and `scripts/ps1/lib/Jdk-Check.ps1`. Wired into `parallel` + `changed` scripts in both shells.

## [0.4.1] — 2026-04-27

### Added
- **`CONTRIBUTING.md`** — full contributor guide promised in v0.4.0 README but not shipped. Covers gitflow branch model (main + develop + feature/fix/chore/release branches), conventional-commits PR title format, the SH/PS1 parity rule (every shell change touches both shells), the per-change-area test matrix (vitest + bats + Pester + Gradle TestKit + installer-e2e), the release flow (develop → main triggers auto-tag + npm + GitHub Packages + GitHub Release), and the historical-bug regression-test rubric.
- **`SECURITY.md`** — vulnerability disclosure policy (private email to oscardlfr@gmail.com), supported-version matrix, in-scope and out-of-scope categories (command injection, path traversal, supply-chain, CI workflow exploits, PowerShell-specific patterns), 48h/1w/2w response timeline, and a list of the security-oriented features already in CI (TruffleHog secrets-scan, Trusted Publisher OIDC for npm, step-level GITHUB_TOKEN scoping, branch protection with `enforce_admins: true`, squash-merge enforcement, commit-lint gate, multi-agent advisory lockfile).
- **`CODE_OF_CONDUCT.md`** — Contributor Covenant 2.1, scoped to GitHub issues / PR reviews / Discussions / npm package metadata / GitHub Releases comments.
- **README "Contributing" section rewritten** to point at `CONTRIBUTING.md`, surface the quick-check command list, and link to `CODE_OF_CONDUCT.md` and `SECURITY.md`.

### Changed
- README no longer claims `CONTRIBUTING.md` is "planned for v0.4.0" — the file now exists.

## [0.4.0] — 2026-04-26

### Added
- **`--feature <parallel|coverage|changed|benchmark>` flag in `tools/measure-token-cost.js`.**
  v0.3.x measured only the `parallel` feature; v0.4 extends to all four
  CLI subcommands via a `FEATURES` registry that plugs per-feature gradle
  tasks, report-file predicates, and module resolution into a shared
  approach-A/B/C runner. Captures land in
  `tools/runs/<feature>/<A|B|C>-run<N>.txt` (subdir per feature). Cross-model
  evidence files (`tools/runs/cross-model-results-<feature>.txt`) committed
  for all four features — 48 canonical numbers (4 features × 3 approaches
  × 4 tokenizers).
- **Cross-model token-cost validation via Anthropic `messages.countTokens`.**
  The same captured stdout is re-tokenised offline (`cl100k_base` baseline)
  AND online per Claude 4.x model — `claude-opus-4-7`, `claude-sonnet-4-6`,
  `claude-haiku-4-5`. The `messages.countTokens` endpoint is free of
  charge (rate-limited only). Confirms the A:C ratio survives the
  tokenizer family in a tight per-feature band:
  - `parallel` 127×–154× · `changed` 127×–153× · `benchmark` 144×–181×
  - `coverage` **765×–1218×** (largest savings of any feature — Kover
    HTML reports include a fully annotated source page per file)
  - `claude-sonnet-4-6` and `claude-haiku-4-5` share a tokenizer
    (identical counts to the unit on every cell)
  - `claude-opus-4-7` ships a new tokenizer producing 30–100% more
    tokens for the same input
- **`--benchmark-task` and `--changed-range` flags** for per-feature gradle
  task / git-rev-range overrides (default: `jvmBenchmark` / `HEAD~1..HEAD`).
- **macOS CI matrix** (`build` and `installer-e2e` jobs now run on
  `ubuntu-latest`, `windows-latest`, `macos-latest` — 9 required checks
  total).
- **README "Why this exists" + `docs/token-cost-measurement.md` rewritten**
  with cross-feature summary table + per-feature drill-down tables.
  Bars are unicode block characters (full-block `█` only, sub-1-char
  values render as `▏`) for guaranteed-uniform GitHub rendering across
  light/dark themes — replaces the v0.3.9 Mermaid `xychart-beta` charts
  whose multi-series mode stacks bars instead of grouping (historic
  Mermaid bug). Models distinguished via colored squares
  (🟦 cl100k_base · 🟥 opus-4-7 · 🟩🟧 sonnet/haiku) in column headers.

### Fixed
- **`run-changed-modules-tests.ps1`: 3 Windows-blocking bugs** that made
  `kmp-test changed` end-to-end non-functional on Windows for any project:
  - `Get-ModuleFromFile`: `$path.Split('/', '\')` resolved to .NET
    `String.Split(Char, Int32)` overload — `'\'` got coerced to Int32
    and threw "input string '\' was not in correct format" the moment a
    Windows-style path appeared. Replaced with `-split '[/\\]'` regex.
  - Splat hashtable mismatch: `MaxFailures` was splatted to
    `run-parallel-coverage-suite.ps1` which doesn't declare it, raising
    "parameter cannot be found". Now matches the bash sibling
    (drops `MaxFailures` from forwarding).
  - Leading colon: `Get-ModuleFromFile` returns `':core-result'` (gradle
    style) but `-ModuleFilter` expects `'core-result'`. Now uses
    `TrimStart(':')` to match the bash sibling
    (`run-changed-modules-tests.sh` line 228: `trimmed="${mod#:}"`).
- **`run-benchmarks.ps1` wrong-cwd bug.** `Invoke-GradleBenchmark` called
  `& $gradlew $Task` without changing directory first; gradle uses the
  *current* working directory as the project root unless `--project-dir`
  is passed, so the script blew up with "Directory '<cwd>' does not
  contain a Gradle build" the moment it was launched from anywhere
  other than the target Gradle project. Wraps the call in
  `Push-Location $Root` / `Pop-Location` to mirror the bash sibling
  (`(cd "$gradle_root" && ./gradlew …)`).
- All four PowerShell bug fixes have AST-driven Pester regression tests
  (28 tests in the script-smoke suite).

### Changed
- **License relicensed from Apache-2.0 to MIT.** All first-party source files
  (`lib/`, `tools/`, `gradle-plugin/src/`) and the top-level `LICENSE` file
  now declare MIT. The `gradle-plugin/gradlew` + `gradlew.bat` wrapper
  scripts retain their upstream Apache-2.0 header (Copyright © 2015 the
  original Gradle authors) — they are unmodified files from the Gradle
  wrapper distribution and remain under their original license.
- **`measure-token-cost.js` capture layout:** legacy
  `<A|B|C>-<descriptive>-run<N>.txt` at `tools/runs/` root migrated to
  `tools/runs/parallel/<A|B|C>-run<N>.txt` (subdir per feature). The
  legacy `cross-model-results.txt` renamed to
  `cross-model-results-parallel.txt` for symmetry with the three new
  evidence files.
- **Vitest test count** grew from 143 to 183 (40 new tests covering the
  `FEATURES` registry, `parseArgs --feature` dispatch including invalid
  input, `filterModulesByGlob`, `modulesFromGitDiff` against real tmp git
  repos, `featureRunsDir`, `loadCaptures` short-form regex,
  `buildApproachAInvocation` per feature, `buildKmpTestCliInvocation`
  per feature, and `runCrossModelMode`'s feature-aware heading).
- **`.gitignore` `coverage/`** scoped to root only (`/coverage/`) so
  `tools/runs/coverage/` measurement evidence is checked in.

## [0.3.8] — 2026-04-26

### Added
- **Concurrent-invocation safety (Tier 1)** — when multiple `kmp-test` runs
  share the same `--project-root` (multi-agent workflows, CI matrix shards,
  human + agent overlap), an advisory lockfile at
  `<project>/.kmp-test-runner.lock` now coordinates them:
  - **First arrival** writes
    `{schema:1, pid, start_time, subcommand, project_root, version}` JSON,
    proceeds, removes the lock on exit (success, failure, or signal).
  - **Second arrival with live PID in the lock** refuses with exit `3` and
    prints PID + age + subcommand of the holder. In `--json` mode the
    envelope includes `errors[].code = "lock_held"`.
  - **Stale lock** (PID dead, e.g. previous run killed `-9`) is reclaimed
    silently — no manual cleanup needed.
  - **Cleanup hooks** for `SIGINT` (Ctrl-C), `SIGTERM`, and
    `uncaughtException` drop the lockfile so a crashed run doesn't leave
    a stuck lock behind.
  - **`doctor` and `--dry-run` skip the lock entirely** — they're read-only
    operations with no side effects worth coordinating.
- **`--force` global flag** — bypasses a live lock when you intentionally
  want concurrent runs (e.g. a debug session alongside CI). Hoisted like
  `--json` / `--dry-run` so it can appear before or after the subcommand.
- **Run-id naming for reports and temp logs** — every run computes a
  `YYYYMMDD-HHMMSS-PID6` run-id (zero-padded last 6 digits of PID) and
  uses it to suffix:
  - `<project>/coverage-full-report-<run-id>.md` (parallel/coverage)
  - `<project>/benchmark-report-<run-id>.md` (benchmark)
  - `${TMPDIR}/gradle-parallel-tests-<run-id>.log` (parallel/coverage)

  The legacy stable filenames (`coverage-full-report.md`,
  `benchmark-report.md`) remain as a "last finished run" mirror copy so
  existing consumers keep working.

### Fixed
- Same-second simultaneous parallel runs no longer clobber each other's
  `gradle-parallel-tests-<timestamp>.log` (now PID-suffixed).
- Two runs against the same project no longer race each other into the
  fixed report filenames — each gets its own versioned copy.

## [0.3.7] — 2026-04-26

### Added
- `--dry-run` global flag: prints the resolved plan (project root, subcommand,
  script path, final argv, spawn command) and exits `0` without invoking the
  underlying script. Hoisted alongside `--json`, so it can appear before or
  after the subcommand. Under `--json` the flag emits the canonical envelope
  with `dry_run: true`, all-zero `tests` counts, and a `plan{}` section
  describing what would have run. Useful for agents that want to introspect
  what `kmp-test` would do without paying the test-execution cost.
- `kmp-test doctor` subcommand: diagnoses the local environment with five
  checks — Node ≥18, `bash` (Linux/macOS) or `pwsh`/`powershell.exe` (Windows),
  `gradlew` in `--project-root` (warn-only), `java -version` (≥17 recommended),
  and `adb version` (warn-only — only needed for the `android` subcommand).
  Human output prints a `CHECK / STATUS / VALUE / MESSAGE` table; `--json`
  emits a single JSON object with a `checks[]` array of
  `{name, status, value, message}` entries. Exit code `0` when all OK or WARN,
  `3` when any FAIL.
- `--test-filter <pattern>` global flag: filters to a single test class without
  forcing the user to bypass the CLI. Mapping per subcommand:
  - JVM tasks (`parallel`, `changed`, `coverage`, `benchmark --platform jvm`):
    appended as `--tests <pattern>` to the gradle command line. Gradle's
    `--tests` handles globs natively, so `*FooTest*` works as-is.
  - Android instrumented (`android`, `benchmark --platform android` or `all`):
    appended as `-Pandroid.testInstrumentationRunnerArguments.class=<FQN>`.
    The Android instrumentation runner does NOT accept wildcards, so the CLI
    pre-resolves a `*Pattern*` glob to a fully-qualified class name by walking
    the project sources for `class <stripped>` declarations (skipping `build/`,
    `.gradle/`, `node_modules/`, `.git/`). If no match is found, the original
    pattern is forwarded — gradle/Android then surfaces a clear error rather
    than the CLI guessing.
  Caught while validating v0.3.4 against a personal benchmark project
  (3 benchmark classes, user wanted to filter to a single one).
- Conventional Commits enforcement on PR titles via
  `.github/workflows/commit-lint.yml`. Adapted inline from
  AndroidCommonDoc/reusable-commit-lint.yml so the repo stays standalone (per
  CLAUDE.md "Decouple from L0"). Squash-merge mode — only the PR title is
  validated since branch protection enforces squash-merge and the PR title
  becomes the squash commit message. Valid types:
  `feat,fix,docs,style,refactor,perf,test,build,ci,chore,revert,release`.
  **Branch protection on `main` and `develop` must be updated to require the
  new `commit-lint / 🔤 Commit Lint` check** (manual one-time step).

### Changed
- README "Agentic flags" section added covering `--dry-run`, `--json`,
  `--test-filter`, and the `doctor` subcommand with example invocations.
- Per-subcommand `--help` text now documents `--dry-run` and `--test-filter`
  for `parallel`, `changed`, `android`, `benchmark`, and `coverage`.
- vitest coverage on `lib/cli.js` extended with 35 new tests (91 total) for
  the new helpers (`consumeDryRunFlag`, `consumeTestFilter`,
  `findFirstClassFqn`, `resolveAndroidTestFilter`, `resolvePatternForSubcommand`,
  `runDoctorChecks`, `buildDryRunReport`) and end-to-end `main()` flows for
  `--dry-run`, `doctor`, and `--test-filter`.
- bats tests added for `--dry-run`, `doctor`, and `--test-filter` against a
  stub gradlew (`tests/bats/test-dryrun.bats`, `test-doctor.bats`,
  `test-testfilter.bats`).
- Pester smoke now asserts every `scripts/ps1/*.ps1` declares a `-TestFilter`
  parameter so the CLI's `--test-filter` translation never lands on an
  unknown-parameter error.

## [0.3.6] — 2026-04-25

### Fixed
- `auto-tag.yml` → `publish-release.yml` cascade now fires automatically.
  v0.3.5 exposed that the tag created and pushed by `auto-tag.yml` did NOT
  trigger `publish-release.yml`'s `push: tags:` listener, because GitHub
  Actions blocks pushes made with the default `GITHUB_TOKEN` from triggering
  downstream workflows (anti-recursion guard). Workaround was a manual
  `gh workflow run publish-release.yml -f tag=vX.Y.Z` after every release
  merge.
- Fix uses `workflow_call` (no new credentials needed):
  - `publish-release.yml` adds a `workflow_call:` trigger alongside the
    existing `push: tags:` and `workflow_dispatch:` triggers, parameterized
    on a `tag` input. The version-determination logic resolves `TAG` from
    `inputs.tag` (workflow_call / workflow_dispatch) or `GITHUB_REF_NAME`
    (push:tags:), so all three paths produce identical artefacts.
  - `auto-tag.yml` gains a `release` job that depends on `tag` and
    `uses: ./.github/workflows/publish-release.yml` via workflow_call when
    `tag.outputs.tag_created == 'true'`. No PAT, no GitHub App — a built-in
    cross-workflow dependency that explicitly chains the two.

### Validated
- Second exercise of the auto-publish pipeline. v0.3.5 needed manual
  intervention for the GitHub Release artefacts; v0.3.6 should be 100 %
  hands-off — bump version, merge develop → main, all artefacts land.

## [0.3.5] — 2026-04-25

### Fixed
- `scripts/install.ps1` `Resolve-LatestVersion` now works in PowerShell 7+.
  The previous code accessed `$Response.Headers["Location"]` directly, which
  works on Windows PowerShell 5.1 (where `Headers` is a `Hashtable` /
  `WebHeaderCollection`) but throws `Unable to index into an object of type
  System.Net.Http.Headers.HttpResponseHeaders` on PowerShell 7+. Replaced
  with `Get-LocationHeader` helper that handles both shapes (Hashtable
  indexer, single-string array, and the typed `HttpResponseHeaders.GetValues`
  / `.Location` accessors). Workaround until the fix shipped: pass `-Version`
  explicitly.

### Validated
- First end-to-end exercise of the auto-publish pipeline introduced in
  v0.3.4: bumping `package.json` + `gradle-plugin/build.gradle.kts` to
  `0.3.5` on `develop`, PR `develop → main`, squash-merge → `auto-tag.yml`
  creates `v0.3.5` git tag → cascades to `publish-release.yml` (artefacts)
  → `publish-npm.yml` + `publish-gradle.yml` push their respective
  registries — all without manual intervention. v0.3.4 was a no-op for
  `auto-tag.yml` (tag pre-existed); v0.3.5 was the first real exercise.

## [0.3.4] — 2026-04-25

### Added
- `--json` / `--format json` output mode: emits a single, parseable JSON object on
  stdout with `tool`, `subcommand`, `version`, `project_root`, `exit_code`,
  `duration_ms`, `tests {total/passed/failed/skipped}`, `modules[]`,
  `coverage {tool, missed_lines}`, and `errors[]`. Designed for AI agents and
  structured-output consumers — typical response is a few hundred tokens vs.
  several thousand for raw Gradle + report parsing. Always valid JSON; parse
  failures surface in `errors[]` rather than crashing.
- Per-subcommand `--help` for `parallel`, `changed`, `android`, `benchmark`, and
  `coverage`. Each shows subcommand-specific flags + one usage example,
  ≤30 lines.
- Pre-flight `gradlew` check: before invoking the bash/PowerShell script the
  CLI verifies `<project-root>/gradlew` (or `gradlew.bat` on Windows) exists
  and prints a 3-line helpful error (exit code `3`) when it doesn't.
- Semantic exit codes documented in `--help` and README: `0` success, `1` test
  failure, `2` config error (bad CLI usage), `3` environment error
  (`gradlew`/`bash`/`pwsh` missing).
- README "Agentic usage — token-cost rationale" section comparing three
  approaches: (A) raw Gradle + report parsing, (B) `kmp-test` default,
  (C) `kmp-test --json`. Side-by-side example shows ~80–100 tokens for
  `--json` vs. several thousand for the equivalent raw-Gradle workflow.
- vitest tests for parser, JSON envelope, gradlew pre-flight, and exit-code
  semantics. `bin/kmp-test.js` + `lib/cli.js` line coverage now ~97%.
- bats smoke tests for `--json` output shape, `--format json` alias, missing
  gradlew, and per-subcommand help.

### Changed
- `--project-root` is now formally documented as defaulting to `process.cwd()`,
  so `cd <project> && kmp-test parallel` works without typing the path. (The
  default already existed in code; this release locks it into the public help
  text and README.)
- Global flags `--json` / `--format json` may appear before OR after the
  subcommand (e.g. both `kmp-test --json parallel` and
  `kmp-test parallel --json` work).
- `ENOENT` when spawning `bash`/`pwsh` now exits with `3`
  (environment error) instead of the previous `127`, aligning with the
  documented semantic-exit-code scheme.

### Fixed
- `npm install -g kmp-test-runner` now installs a `kmp-test` binary, matching
  the documented usage. Previously the `bin` field was a string
  (`"bin/kmp-test.js"`), which made npm derive the shim name from the package
  name (`kmp-test-runner`), so users who installed via npm got `kmp-test-runner`
  on `PATH` instead of the documented `kmp-test`. The shell installer
  (`scripts/install.{sh,ps1}`) was unaffected since it creates the `kmp-test`
  shim explicitly.
- `kmp-test benchmark --platform jvm/android` no longer invokes non-existent
  Gradle tasks on incompatible modules. Previously `detect_benchmark_modules`
  returned every module with a benchmark reference and `get_benchmark_gradle_task`
  blindly built a task name (`:module:desktopSmokeBenchmark` for jvm,
  `:module:connectedAndroidTest` for android), so an `androidx.benchmark`-only
  module asked to run as `--platform jvm` produced a `TaskSelectionException`
  after a long Gradle configuration phase. New helpers
  `detect_module_benchmark_platforms` (sh) / `Get-ModuleBenchmarkPlatforms`
  (ps1) categorize each module by detected capability (`androidx.benchmark` →
  android, `kotlinx.benchmark` / `org.jetbrains.kotlinx.benchmark` → jvm), and
  the runner skips modules that don't declare the requested platform with a
  `[SKIP]` warning. If every module/platform combination is skipped, the
  script exits `3` (env error) with a useful hint instead of pretending success.
  Discovered while validating v0.3.4 against an `androidx.benchmark`-only
  personal project.
- `detect_benchmark_modules` (sh) now correctly handles the default
  `--module-filter "*"`. Previously the filter check used a literal substring
  match (`[[ "$mod" != *"*"* ]]`), so passing `*` filtered EVERY module out
  (since module names like "benchmark" don't contain a literal asterisk),
  silently returning zero benchmark modules on any default invocation.
  The filter now treats `*` and the empty string as "match all" and only
  applies substring filtering for non-empty, non-asterisk patterns. Caught
  by the new `detect_benchmark_modules with default filter '*'` regression
  bats test.
- `detect_benchmark_modules` (sh) `include(...)` extraction is now locale-
  portable. Previously it used `grep -oP` (PCRE), which fails under MinGW /
  Git Bash with `grep: -P supports only unibyte and UTF-8 locales` when
  `LC_ALL=C`, returning zero modules. The implementation now uses
  `grep -E` + `sed -E` (POSIX) and is exercised under `LC_ALL=C` by a
  dedicated regression bats test.

## [0.3.3] — 2026-04-25

### Fixed
- `package.json` version bumped from `0.2.0` to `0.3.3` to match the GitHub Release
  tag. Sub-wave c (v0.3.0..v0.3.2) shipped installer + workflow changes only — no
  npm/Gradle code change — and missed bumping `package.json`. Result on v0.3.0/0.3.1/0.3.2:
  `kmp-test --version` returned `0.2.0` post-install (the stale `package.json` value)
  even though users installed from a v0.3.x GitHub Release. v0.3.3 syncs the
  version-string source-of-truth with the release tag.
- Note: the **npm registry** still publishes `kmp-test-runner@0.2.0`. `publish-npm.yml`
  is `workflow_dispatch`-only (intentionally — Trusted Publisher OIDC requires manual
  approval). To publish v0.3.3 to npm, trigger that workflow explicitly.

### Notes
- v0.3.0..v0.3.2 users: please reinstall from v0.3.3. Run `scripts/uninstall.{sh,ps1}`
  first, then `scripts/install.{sh,ps1}` from v0.3.3.

## [0.3.2] — 2026-04-25

> **NOTE:** v0.3.2 reports `kmp-test --version` as `0.2.0` (stale `package.json`).
> Use v0.3.3 — same installer, correct version reporting.

### Fixed
- Release artifacts now include `package.json`. Without it, `cli.js`'s `readVersion()`
  function (which reads version via `path.join(__dirname, '..', 'package.json')`)
  failed post-install with `ENOENT: no such file or directory`. v0.3.0 + v0.3.1
  artifacts both omitted `package.json` from the `cp` list in `publish-release.yml`,
  so `kmp-test --version` failed even after fixing the wrapper-directory bug in v0.3.1.

### Notes
- v0.3.0 + v0.3.1 users: please reinstall from v0.3.3 (NOT v0.3.2 — see note above).

## [0.3.1] — 2026-04-25

### Fixed
- Release artifact extraction. v0.3.0 archives were packaged with files at top level
  (`bin/`, `lib/`, `scripts/` directly), but `install.sh` (`tar --strip-components=1`)
  and `install.ps1` (`Get-ChildItem -Directory | Select-Object -First 1`) both expect
  a single wrapper directory (`kmp-test-runner-${VER}/`). Result on v0.3.0: installers
  ran without error but produced unusable installs (`kmp-test --version` failed with
  `MODULE_NOT_FOUND`). v0.3.1 wraps the archive contents in `kmp-test-runner-${VER}/`
  so the installer extraction logic works as designed.

> **NOTE:** v0.3.1 also has a packaging bug — see v0.3.2.

### Notes
- v0.3.0 users: do NOT install v0.3.1 — install v0.3.2 instead.

## [0.3.0] — 2026-04-25

> **NOTE:** v0.3.0 archives have a packaging bug (no wrapper directory) that breaks
> installer extraction. **Do not install v0.3.0 — use v0.3.1 instead.** The v0.3.0
> installer scripts themselves are sound; only the release artifacts are broken.

### Added
- Shell installer (`scripts/install.sh`) — POSIX-compatible, works on Linux and macOS (bash 3.2+)
- PowerShell installer (`scripts/install.ps1`) — Windows 10/11, PowerShell 5.1+
- Uninstall scripts for both platforms (`scripts/uninstall.sh`, `scripts/uninstall.ps1`)
- GitHub Release workflow (`publish-release.yml`) — tag-triggered, attaches tarball + zip artifacts
- Bats smoke tests for installer detection logic (`tests/installer/install.bats`)
- Pester syntax tests for PowerShell installer (`tests/installer/Install.Tests.ps1`)

### Changed
- README final polish: Quick Start moved to top, Installation section expanded with all 3 shapes,
  10-section canonical order established

## [0.2.0] — 2026-04-25

### Added
- Gradle plugin shape `io.github.oscardlfr.kmp-test-runner` published to GitHub Packages
- 5 Gradle tasks: `parallelTests`, `changedTests`, `androidTests`, `benchmarkTests`, `coverageTask`
- `KmpTestRunnerExtension` DSL with 6 properties: `projectRoot`, `maxWorkers`, `coverageTool`,
  `coverageModules`, `minMissedLines`, `sharedProjectName`
- Kover auto-detect via `pluginManager.withPlugin` — graceful skip if Kover absent
- TestKit 3-target matrix (Android, KMP-desktop, KMP-multiplatform) + structural `CrossShapeParityTest`

### Changed
- npm CLI bumped to v0.2.0 to stay version-synced with Gradle plugin

### Infrastructure
- Trusted Publisher OIDC for npm publish (no static tokens)
- Step-level `GITHUB_TOKEN` scoping in `publish-gradle.yml`

## [0.1.0] — 2026-04-25

### Added
- Initial release of npm CLI shape `kmp-test-runner`
- 5 subcommands: `parallel`, `changed`, `android`, `benchmark`, `coverage`
- Cross-platform via Unix bash scripts + flag translation in `cli.js`
- Bats (≥15 tests), Pester (≥4 syntax tests), Vitest (≥80% coverage), shellcheck (0 warnings) in CI
- TruffleHog secrets scan as required CI status check
- Apache-2.0 license

[0.4.1]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.8...v0.4.0
[0.3.8]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/oscardlfr/kmp-test-runner/releases/tag/v0.1.0

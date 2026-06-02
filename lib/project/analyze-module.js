// SPDX-License-Identifier: MIT
// lib/project/analyze-module.js — per-module Kotlin DSL analysis +
// canonical-task resolution.
//
// Owns: analyzeModule (the 290+ LOC Kotlin DSL classifier), predictCoverageTask
// + predictTaskFromSourceSets (private fallbacks), resolveTasksFor (canonical
// task name extraction). The orchestrator (buildProjectModel in
// lib/project-model.js) stays a thin composition step over this.
//
// All file I/O is sync. analyzeModule is a pure function: same inputs →
// same outputs (no global state mutation, no caching layer). The cache layer
// lives in lib/project/cache.js.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  stripGradleComments,
  parseVersionCatalog,
  parseBuildLogicPluginDescriptors,
} from './kotlin-dsl.js';
// Back-import keeps detectBuildLogicCoverageHints reachable both from here
// (analyzeModule lazy-loads it) and from buildProjectModel. Live ESM binding —
// runtime resolution avoids the top-level cycle.
import { detectBuildLogicCoverageHints } from '../project-model.js';

// Suffix-based fallback when the catalog is missing or doesn't contain
// the alias key. Covers conventional naming (`<namespace>.android.application`,
// `<namespace>.kotlin.multiplatform`, etc.) used by nowinandroid-style
// projects whose plugin keys are namespaced. Returns `null` when no
// suffix matches — caller treats the alias as unresolvable.
const HEURISTIC_PLUGIN_SUFFIXES = [
  ['android.application',  'com.android.application'],
  ['android.library',      'com.android.library'],
  ['android.test',         'com.android.test'],
  ['kotlin.multiplatform', 'org.jetbrains.kotlin.multiplatform'],
  ['kotlin.android',       'org.jetbrains.kotlin.android'],
  ['kotlin.jvm',           'org.jetbrains.kotlin.jvm'],
];

function heuristicResolveAlias(dottedKey) {
  for (const [suffix, pluginId] of HEURISTIC_PLUGIN_SUFFIXES) {
    if (dottedKey === suffix || dottedKey.endsWith('.' + suffix)) return pluginId;
  }
  return null;
}

export function analyzeModule(projectRoot, moduleName, buildLogicHints = null, catalog = null, buildLogicDescriptors = null) {
  const rel = moduleName.replace(/^:/, '').replace(/:/g, path.sep);
  const modulePath = path.join(projectRoot, rel);
  const buildFile = path.join(modulePath, 'build.gradle.kts');
  let content = '';
  try { content = readFileSync(buildFile, 'utf8'); } catch { /* missing or unreadable */ }

  // v0.6.x Gap 3: lazy-load the version catalog when not threaded through
  // from buildProjectModel. Direct test calls (analyzeModule(dir, ':m'))
  // and ad-hoc consumers still get alias resolution this way.
  if (catalog === null) catalog = parseVersionCatalog(projectRoot);

  // v0.6.x Gap 4: lazy-load build-logic descriptors and hints. Same pattern
  // as catalog above — direct test calls work without requiring
  // buildProjectModel as a wrapper.
  if (buildLogicDescriptors === null) {
    buildLogicDescriptors = parseBuildLogicPluginDescriptors(projectRoot, catalog);
  }
  if (buildLogicHints === null) {
    buildLogicHints = detectBuildLogicCoverageHints(projectRoot);
  }

  // Source-set detection — 12 standard directories. JS/Wasm targets
  // (v0.6 Bug 3) added so consumer scripts can decide whether to invoke
  // jsTest / wasmJsTest tasks alongside the JVM-side jvmTest / desktopTest.
  // Compose Multiplatform's `html/` modules and other JS-only KMP projects
  // were previously invisible to the model.
  const sourceSetNames = [
    'test', 'commonTest', 'jvmTest', 'desktopTest',
    // 2026-05-04 Bug D — `androidDeviceTest` is the new-plugin
    // (com.android.kotlin.multiplatform.library, Kotlin 2.3+) device-test
    // source set, distinct from legacy AGP's `androidInstrumentedTest`.
    // Modules that declare `androidLibrary { withDeviceTestBuilder { } }`
    // surface their device-test sources here.
    'androidUnitTest', 'androidInstrumentedTest', 'androidDeviceTest', 'androidTest',
    'iosTest', 'nativeTest',
    'jsTest', 'wasmJsTest', 'wasmWasiTest',
    // v0.7.0: iOS-arch-specific + macOS source sets so KMP modules that
    // declare iosX64() / iosSimulatorArm64() / macosArm64() etc. surface
    // their per-target test source sets without falling back to the
    // umbrella `iosTest` / `nativeTest` directories.
    'iosX64Test', 'iosArm64Test', 'iosSimulatorArm64Test',
    'macosTest', 'macosX64Test', 'macosArm64Test',
    // v0.8 sub-entry 5: *Main variants for iOS/macOS target detection. Modules
    // declaring iosX64()/iosSimulatorArm64()/macosArm64() typically have these
    // source-set dirs even before any iosTest/macosTest source set exists.
    // The parallel-orchestrator uses these signals to dispatch the gradle
    // *Test task (created from the target() declaration) rather than skip
    // the module — preserves the legacy wrapper's permissive behavior.
    'iosMain', 'iosX64Main', 'iosArm64Main', 'iosSimulatorArm64Main',
    'macosMain', 'macosX64Main', 'macosArm64Main',
  ];
  // 2026-05-03 — Detect renamed JVM targets: `kotlin { jvm("desktop") {} }`.
  // The runnable test task is `<name>Test` (e.g. `desktopTest`), NOT `jvmTest`.
  // Some private KMP projects use this pattern to declare the JVM target as
  // "desktop" alongside an `androidLibrary {}` target. Without this detection, the CLI
  // sees on-disk `jvmTest/` (intermediate hierarchy folder, see below), picks
  // `jvmTest` task, and gradle aborts with `Cannot locate tasks that match
  // ':foo:jvmTest'`. Strip comments first so commented-out `jvm("...")` calls
  // don't surface as phantom targets.
  const codeOnlyForJvm = stripGradleComments(content);
  const namedJvmTargets = [];
  for (const m of codeOnlyForJvm.matchAll(/\bjvm\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!namedJvmTargets.includes(m[1])) namedJvmTargets.push(m[1]);
  }
  // 2026-05-03 — Detect default `jvm()` declaration (no name). KMP creates
  // a `jvmTest` task from this declaration even when `src/jvmTest/` doesn't
  // exist (test code typically lives in `commonTest`). PeopleInSpace `:common`
  // reproduces: declares `kotlin { jvm() }`, has only `commonTest/` on disk,
  // pre-fix the CLI returned null because no `jvmTest/` folder existed.
  // Negative lookbehind avoids matching `jvm("name")` (already captured above).
  const hasDefaultJvm = /\bjvm\s*\(\s*\)/.test(codeOnlyForJvm);
  // 2026-05-03 — Detect intermediate hierarchy groups created via
  // `applyDefaultHierarchyTemplate { common { group("X") { ... } } }`. These
  // produce `XMain`/`XTest` source sets but NO runnable `XTest` task. The
  // hierarchy is just for sharing code between sibling targets. A `group("jvm")`
  // declaration paired with `jvm("desktop")` is the canonical KMP pattern for
  // android+desktop code-sharing — see real-world KMP modules using `jvm("desktop")`.
  const intermediateGroups = [];
  const hierarchyBlocks = codeOnlyForJvm.matchAll(/applyDefaultHierarchyTemplate\s*\{([\s\S]*?)\n\s*\}/g);
  for (const block of hierarchyBlocks) {
    for (const gm of block[1].matchAll(/\bgroup\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!intermediateGroups.includes(gm[1])) intermediateGroups.push(gm[1]);
    }
  }
  // Augment the source-set walker with disk dirs implied by named JVM targets,
  // so projects with `jvm("server")` get `serverMain`/`serverTest` registered
  // even though those names aren't in the static sourceSetNames list.
  const augmentedSourceSetNames = [...sourceSetNames];
  for (const name of namedJvmTargets) {
    for (const suffix of ['Main', 'Test']) {
      const ss = `${name}${suffix}`;
      if (!augmentedSourceSetNames.includes(ss)) augmentedSourceSetNames.push(ss);
    }
  }
  const sourceSets = {};
  for (const ss of augmentedSourceSetNames) {
    sourceSets[ss] = existsSync(path.join(modulePath, 'src', ss));
  }

  // Type detection.
  // Android plugin coverage (v0.6 Bug 2): the `library` / `application`
  // alternation missed `com.android.test` (test-fixtures-only Android module
  // pattern, e.g. Confetti's androidBenchmark) and `kotlin("android")` /
  // `org.jetbrains.kotlin.android` (the Android-paired Kotlin plugin id —
  // separate from AGP itself; some modules apply it without an AGP id, others
  // pair AGP + kotlin-android with neither matching the pre-fix regex).
  const kmpPluginIdPattern = /kotlin\s*\(\s*['"]multiplatform['"]\s*\)|id\s*\(?\s*['"]org\.jetbrains\.kotlin\.multiplatform['"]/;
  const hasAndroidLibraryDsl = /\bandroidLibrary\s*\{/.test(content);
  const hasAndroidTargetCall = /\bandroidTarget\s*\(/.test(content);
  const hasAndroidPlugin       = /\bid\s*\(?\s*['"]com\.android\.(library|application|test)['"]/.test(content);
  const hasKotlinAndroidPlugin = /kotlin\s*\(\s*['"]android['"]\s*\)|id\s*\(?\s*['"]org\.jetbrains\.kotlin\.android['"]/.test(content);
  const hasJvmKotlinPlugin     = /kotlin\s*\(\s*['"]jvm['"]\s*\)|id\s*\(?\s*['"]org\.jetbrains\.kotlin\.jvm['"]/.test(content);

  // v0.6.x Gap 3: resolve `alias(libs.plugins.<X>)` references via the
  // version catalog (preferred) or a small suffix heuristic (fallback).
  // Each resolved id participates in the type-classification booleans
  // below alongside the literal `id()` / `kotlin()` forms.
  const aliasPluginIds = [];
  for (const am of content.matchAll(/alias\s*\(\s*libs\.plugins\.([\w\.]+)\s*\)/g)) {
    const dotted = am[1];
    const resolved = (catalog && catalog.get(dotted)) || heuristicResolveAlias(dotted);
    if (resolved) aliasPluginIds.push(resolved);
  }

  // Expand alias-resolved ids through convention-plugin
  // `appliedPlugins`. NIA pattern: `alias(libs.plugins.nowinandroid.android.library)`
  // resolves to literal `"nowinandroid.android.library"`. The corresponding
  // AndroidLibraryConventionPlugin.kt calls `apply(plugin = "com.android.library")`
  // at runtime — invisible to regex without source-scan. We collect those
  // transitively-applied plugin ids during parseBuildLogicPluginDescriptors and
  // expand them here so `hasAndroidViaAlias` (and friends) fire when the
  // canonical AGP id is reachable only via convention-plugin indirection.
  const descriptorMap = new Map((buildLogicDescriptors || []).map(d => [d.pluginId, d]));
  const expandedPluginIds = [];
  for (const id of aliasPluginIds) {
    expandedPluginIds.push(id);
    const d = descriptorMap.get(id);
    if (d && d.appliedPlugins && d.appliedPlugins.length > 0) {
      expandedPluginIds.push(...d.appliedPlugins);
    }
  }

  const hasKmpViaAlias            = expandedPluginIds.includes('org.jetbrains.kotlin.multiplatform');
  const hasAndroidViaAlias        = expandedPluginIds.some(id => /^com\.android\.(library|application|test)$/.test(id));
  const hasKotlinAndroidViaAlias  = expandedPluginIds.includes('org.jetbrains.kotlin.android');
  const hasJvmKotlinPluginViaAlias = expandedPluginIds.includes('org.jetbrains.kotlin.jvm');

  // 2026-05-04 Bug D — Google's new KMP-Android plugin
  // `com.android.kotlin.multiplatform.library` (Kotlin 2.3+) replaces
  // `com.android.library` for KMP modules. It uses different test task names
  // (`testAndroidHostTest` vs `testDebugUnitTest`) and requires
  // `withHostTestBuilder {} / withDeviceTestBuilder {}` opt-ins inside
  // `androidLibrary {}` for AGP to generate test tasks. Detect by literal
  // plugin id OR alias resolution (some projects use the
  // `libs.plugins.android.kotlin.multiplatform.library` alias) — and by
  // expansion through convention-plugin appliedPlugins.
  const hasNewKmpAndroidLiteralId = /\bid\s*\(?\s*['"]com\.android\.kotlin\.multiplatform\.library['"]/.test(content);
  const hasNewKmpAndroidViaAlias = expandedPluginIds.includes('com.android.kotlin.multiplatform.library');
  const hasNewKmpAndroidPlugin = hasNewKmpAndroidLiteralId || hasNewKmpAndroidViaAlias;

  let type = 'unknown';
  let androidDsl = null;
  let androidDslVariant = null;
  if (kmpPluginIdPattern.test(content) || hasAndroidLibraryDsl || hasAndroidTargetCall || hasKmpViaAlias || hasNewKmpAndroidPlugin) {
    type = 'kmp';
    if (hasAndroidLibraryDsl) androidDsl = 'androidLibrary';
    else if (hasAndroidTargetCall) androidDsl = 'androidTarget';
    // 2026-05-04 Bug D — `androidLibrary {}` DSL is exclusive to the new
    // plugin (legacy `com.android.library` uses `android {}` block). Any
    // module that calls `androidLibrary { }` IS using the new plugin —
    // direct alias OR via convention plugin (e.g. a benchmark module that
    // applies a private convention plugin id which internally applies the
    // new plugin).
    if (hasNewKmpAndroidPlugin || hasAndroidLibraryDsl) {
      androidDslVariant = 'kmpAndroidLibrary';
    }
  } else if (hasAndroidPlugin || hasKotlinAndroidPlugin || hasAndroidViaAlias || hasKotlinAndroidViaAlias) {
    type = 'android';
  } else if (hasJvmKotlinPlugin || hasJvmKotlinPluginViaAlias) {
    type = 'jvm';
  }

  // 2026-05-04 Bug D — Parse `withHostTestBuilder {}` / `withDeviceTestBuilder {}`
  // opt-ins for the new KMP-Android plugin. Without these declarations,
  // AGP does NOT generate the test tasks even when `src/androidUnitTest/` or
  // `src/androidDeviceTest/` exist on disk. Override `sourceSets` to reflect
  // AGP behavior: opt-in trumps disk evidence (and vice versa).
  // Global match scoped via comment-stripped source — these identifiers are
  // unique to the new plugin so false positives from string literals are
  // not a real-world risk.
  let hasHostTestOptIn = false;
  let hasDeviceTestOptIn = false;
  if (androidDslVariant === 'kmpAndroidLibrary') {
    hasHostTestOptIn = /\bwithHostTestBuilder\s*\{/.test(codeOnlyForJvm);
    hasDeviceTestOptIn = /\bwithDeviceTestBuilder\s*\{/.test(codeOnlyForJvm);
    // Override the filesystem-derived source-set booleans. Repro:
    // a private KMP module with `src/androidUnitTest/` on disk but no
    // `withHostTestBuilder {}` declared → AGP creates no `testAndroidHostTest`
    // task → orchestrator must skip, not dispatch.
    sourceSets.androidUnitTest = hasHostTestOptIn;
    sourceSets.androidDeviceTest = hasDeviceTestOptIn;
  }

  // Has flavor (drives the connected${Flavor}DebugAndroidTest candidate).
  const hasFlavor = /\bproductFlavors\b/.test(content);

  // Coverage plugin detection. Per-module signal first (most specific),
  // then build-logic project-wide hint (v0.5.2 Gap A — replaces the
  // legacy `detect_coverage_tool` build-logic scan that lived in bash).
  // v0.6 Bug 6 refinement:
  //   - Strip comments before per-module regex check; doc-style comments
  //     that mention jacoco/kover ("// adds jacoco support — see ...")
  //     must NOT raise the signal.
  //   - Only inherit when the build-logic hint is a CONVENTION signal
  //     (consumer-facing plugin); SELF signals (build-logic's own buildscript
  //     using kover/jacoco for self-compilation only) are ignored to avoid
  //     the over-prediction surfaced in nowinandroid.
  const codeOnly = stripGradleComments(content);
  let coveragePlugin = null;
  if (/\bkover\b/.test(codeOnly)) coveragePlugin = 'kover';
  else if (/\bjacoco\b/.test(codeOnly) || /\btestCoverageEnabled\b/.test(codeOnly)) coveragePlugin = 'jacoco';
  else if (buildLogicDescriptors && buildLogicDescriptors.length > 0) {
    // v0.6.x Gap 4: per-module application detection. Only inherit when
    // THIS module's plugins{} block applies a coverage-adding convention
    // plugin (one whose descriptor has addsCoverage='jacoco'|'kover').
    // Pre-fix the buildLogicHints fallback below treated all consumers
    // identically, over-predicting on nowinandroid (35 modules, only ~5-10
    // actually apply jacoco).
    const appliedIds = new Set(aliasPluginIds);
    for (const m of codeOnly.matchAll(/\bid\s*\(?\s*['"]([^'"]+)['"]/g)) appliedIds.add(m[1]);
    for (const m of codeOnly.matchAll(/\bkotlin\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      appliedIds.add(`org.jetbrains.kotlin.${m[1]}`);
    }
    const matched = buildLogicDescriptors.find(d => d.addsCoverage && appliedIds.has(d.pluginId));
    if (matched) coveragePlugin = matched.addsCoverage;
  } else if (buildLogicHints) {
    // Backwards-compat fallback (v0.6.0 broad inheritance). Triggers when
    // descriptor parsing produced nothing — typical of pure Plugin<Project>
    // setups where build-logic has no `gradlePlugin {}` block (like the
    // build-logic-convention-jacoco fixture). Trust the convention-level
    // signal as before.
    if (buildLogicHints.hasKover === 'convention') coveragePlugin = 'kover';
    else if (buildLogicHints.hasJacoco === 'convention') coveragePlugin = 'jacoco';
  }

  // 2026-05-03 — Detect Android `testBuildType` declarations. AGP creates
  // `test${BuildType}UnitTest` and `connected${BuildType}AndroidTest` tasks
  // from this property — when set to "release", the Debug variants do NOT
  // exist. Repro: di-sample `:benchmark` declares
  // `testBuildType = benchmarkBuildType` where
  // `val benchmarkBuildType = (project.findProperty(...) as? String) ?: "release"`.
  // Also resolves single-file variable
  // expressions matching `val NAME = ... ?: "literal"` so the orchestrator
  // can dispatch the right variant under default `--variant auto`. Out of
  // scope: extra/findProperty fallthroughs, multi-file lookups, conditional
  // expressions — they fall through to null (legacy AGP-default behavior).
  let testBuildType = null;
  const stripped = stripGradleComments(content);
  const tbtMatch = stripped.match(/\btestBuildType\s*=\s*['"]([^'"]+)['"]/);
  if (tbtMatch) {
    testBuildType = tbtMatch[1];
  } else {
    const tbtVarMatch = stripped.match(/\btestBuildType\s*=\s*([A-Za-z_][\w]*)\b/);
    if (tbtVarMatch) {
      const varName = tbtVarMatch[1];
      const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Try `?:` default first (e.g. `val x = (...) ?: "release"` —
      // di-sample :benchmark shape).
      let valLookup = stripped.match(new RegExp(`\\bval\\s+${escaped}\\s*=[^\\n]*?\\?:\\s*['\"]([^'\"]+)['\"]`));
      // Fall back to direct literal (e.g. `val x = "release"`).
      if (!valLookup) {
        valLookup = stripped.match(new RegExp(`\\bval\\s+${escaped}\\s*=\\s*['\"]([^'\"]+)['\"]`));
      }
      if (valLookup) testBuildType = valLookup[1];
    }
  }

  return {
    type,
    androidDsl,
    androidDslVariant,
    hasFlavor,
    sourceSets,
    coveragePlugin,
    namedJvmTargets,
    intermediateGroups,
    testBuildType,
    hasDefaultJvm,
    hasHostTestOptIn,
    hasDeviceTestOptIn,
  };
}

// Predict the canonical coverage task name from the (coveragePlugin, type)
// pair when probe data is unavailable (v0.5.2 Gap A — replaces the legacy
// `get_coverage_gradle_task` mapping in coverage-detect.sh). Used as a
// fallback inside `resolveTasksFor` when gradleTasks is null.
//   - jacoco          → jacocoTestReport
//   - kover + kmp     → koverXmlReportDesktop  (jvm-side coverage on KMP)
//   - kover + android → koverXmlReportDebug
//   - kover + jvm     → koverXmlReport
//   - else            → null
function predictCoverageTask(coveragePlugin, type) {
  if (coveragePlugin === 'jacoco') return 'jacocoTestReport';
  if (coveragePlugin === 'kover') {
    if (type === 'kmp') return 'koverXmlReportDesktop';
    if (type === 'android') return 'koverXmlReportDebug';
    if (type === 'jvm') return 'koverXmlReport';
    return 'koverXmlReport'; // unknown type — best effort
  }
  return null;
}

// Extract product-flavor names from a probed gradle task list. Convention
// plugins (build-logic/) can apply productFlavors that the per-module static
// scan (analyzeModule's `hasFlavor` regex over the module's own build.gradle.kts)
// never sees — yet AGP still creates `test${Flavor}${BuildType}UnitTest` tasks,
// which `gradlew tasks --all` lists. Recover the flavor NAMES so the dispatch
// layer can weave the correct unit + coverage task. Lowercases the first char
// (`Demo` → `demo`), dedupes, sorts. Plain testDebugUnitTest / testReleaseUnitTest
// (no flavor) do NOT match: the non-greedy `*?` + anchored `(Debug|Release)`
// forces the flavor segment empty there, and `[A-Z]` rejects an empty capture.
// Receives BARE task names (already `module:`-stripped by parseGradleTasksOutput).
export function flavorsFromTasks(gradleTasks) {
  if (!Array.isArray(gradleTasks)) return [];
  const re = /^test([A-Z][A-Za-z0-9]*?)(Debug|Release)UnitTest$/;
  const out = new Set();
  for (const t of gradleTasks) {
    const m = typeof t === 'string' ? t.match(re) : null;
    if (m && m[1]) out.add(m[1].charAt(0).toLowerCase() + m[1].slice(1));
  }
  return [...out].sort();
}

// v0.8 sub-entry 2 — predict task name from sourceSets when probe is
// unavailable (BACKLOG line 215-244). Walks the same candidate orders
// `resolveTasksFor` uses for the populated branch and returns the first
// candidate whose corresponding source set is `true`. Only meaningful for
// task families where task-name == source-set-name (unitTestTask, webTestTask,
// iosTestTask, macosTestTask). The deviceTestTask candidates are gradle task
// names that do NOT correspond to source-set names (connectedDebugAndroidTest
// vs androidInstrumentedTest), so deviceTestTask prediction is intentionally
// skipped — callers fall back to probe or static defaults.
function predictTaskFromSourceSets(analysis, candidates) {
  if (!analysis || !analysis.sourceSets) return null;
  // 2026-05-03 — JVM-family-only override: trust `kotlin { jvm("name") {} }`
  // declarations. Gradle creates the `<name>Test` task automatically from
  // the target declaration, independent of whether `src/<name>Test/` exists
  // on disk (code typically lives in `commonTest` or the intermediate
  // `jvmTest` source set when a hierarchy template is in play).
  // A real-world repro: a module declares `jvm("desktop")` but only has
  // `jvmTest/` on disk — the runnable task is `:<module>:desktopTest`,
  // verified via `gradle :tasks --all`.
  // Detect the JVM family by checking if any canonical JVM candidate
  // (`jvmTest`, `desktopTest`, `test`) is in the chain — only then apply
  // the named-target override. Avoids polluting iOS/macOS/web prediction.
  const isJvmChain = candidates.some(c => c === 'jvmTest' || c === 'desktopTest' || c === 'test');
  if (isJvmChain) {
    const namedJvm = analysis.namedJvmTargets || [];
    if (namedJvm.length > 0) {
      const intermediate = new Set(analysis.intermediateGroups || []);
      const pick = namedJvm.find(n => !intermediate.has(n));
      if (pick) return `${pick}Test`;
    }
    // 2026-05-03 — Default `jvm()` declaration: KMP creates `jvmTest` task
    // even without `src/jvmTest/` folder (test code lives in commonTest).
    // PeopleInSpace `:common` repro. Only fires when no named target wins
    // above and no intermediate group claims `jvm`.
    if (analysis.hasDefaultJvm) {
      const intermediate = new Set(analysis.intermediateGroups || []);
      if (!intermediate.has('jvm')) return 'jvmTest';
    }
  }
  // Standard disk-walk chain. Drop candidates that match a declared
  // intermediate hierarchy group (they have source-set folders but no
  // runnable task — `applyDefaultHierarchyTemplate { common { group("jvm")
  // {...} } }` is the canonical KMP shape).
  let effective = candidates;
  const intermediateTasks = (analysis.intermediateGroups || []).map(g => `${g}Test`);
  if (intermediateTasks.length > 0) {
    effective = effective.filter(c => !intermediateTasks.includes(c));
  }
  for (const c of effective) {
    if (analysis.sourceSets[c]) return c;
  }
  return null;
}

// Resolve canonical task names from a per-module gradleTasks[] list.
// Returns { unitTestTask, deviceTestTask, coverageTask, webTestTask } — each
// null when no candidate matched (probe ran but nothing fits) AND no
// fallback applies.
//
// When `gradleTasks` is null (probe didn't run / timed out) but the analysis
// carries a `coveragePlugin` signal, predict the coverage task name via
// `predictCoverageTask` (v0.5.2 Gap A). The script-side coverage selector
// then confirms task existence via the cheap `module_has_task` probe before
// invoking gradle, so a wrong prediction degrades gracefully to a
// `[SKIP coverage]` notice.
//
// v0.6 Bug 3: `unitTestTask` candidates extend with `jsTest`/`wasmJsTest`
// AFTER the JVM candidates so a KMP module with both `jvmTest` and `jsTest`
// still picks `jvmTest` (the expected default). JS-only modules with no
// JVM-side test task now get `unitTestTask: 'jsTest'` instead of null.
// New `webTestTask` field surfaces JS/Wasm test invocation explicitly so
// scripts can run the web side alongside (or instead of) JVM tests without
// inferring intent from `unitTestTask`.
//
// v0.7.0: parallel `iosTestTask` and `macosTestTask` fields surface Apple
// platform test invocation without polluting the `unitTestTask` candidate
// race. iOS task names vary by declared target (iosSimulatorArm64Test on
// Apple-silicon hosts, iosX64Test on Intel hosts/CI, iosArm64Test for
// device runs); macOS likewise picks among macosArm64Test / macosX64Test /
// macosTest. Scripts opt in by reading these fields when they want to
// dispatch to the Apple side.
export function resolveTasksFor(_moduleName, gradleTasks, analysis = null) {
  const predictedCoverage = analysis
    ? predictCoverageTask(analysis.coveragePlugin, analysis.type)
    : null;
  if (!Array.isArray(gradleTasks)) {
    // v0.8 sub-entry 2: predict task names from sourceSets where
    // task-name == source-set-name (unit / web / ios / macos). deviceTestTask
    // candidates are gradle task names (connectedDebugAndroidTest etc.) with
    // no source-set parity, so deviceTestTask stays null when probe missed.
    return {
      unitTestTask:   predictTaskFromSourceSets(analysis, ['desktopTest', 'jvmTest', 'test', 'jsTest', 'wasmJsTest']),
      deviceTestTask: null,
      coverageTask:   predictedCoverage,
      webTestTask:    predictTaskFromSourceSets(analysis, ['jsTest', 'wasmJsTest']),
      iosTestTask:    predictTaskFromSourceSets(analysis, ['iosSimulatorArm64Test', 'iosX64Test', 'iosArm64Test', 'iosTest']),
      macosTestTask:  predictTaskFromSourceSets(analysis, ['macosArm64Test', 'macosX64Test', 'macosTest']),
      // Flavor data only comes from the probe (the task graph reveals
      // convention-applied flavors the static scan misses); empty here for
      // shape parity when the probe didn't run.
      flavors:            [],
      coverageReportTasks: [],
    };
  }
  const set = new Set(gradleTasks);
  // Probe-recovered product flavors (from test<Flavor><BuildType>UnitTest task
  // names). Hoisted so the `test`-candidate gate below and the return value
  // share one computation.
  const flavors = flavorsFromTasks(gradleTasks);
  function pickFirst(candidates) {
    for (const c of candidates) {
      if (!set.has(c)) continue;
      // The bare AGP `test` lifecycle task is registered even when a module has
      // no unit-test source set (a `com.android.application` without `src/test`
      // still exposes `test` in the probe). Dispatch skips such modules (it
      // gates on `test || androidUnitTest` source sets), so gate the same way
      // here to keep `describe` from over-reporting `unit=test`. The KMP
      // source-set-parity candidates (jvmTest/desktopTest/jsTest/wasmJsTest)
      // only exist when their source set does, so they need no gate. Exception:
      // a convention-flavored module keeps its unit tests in src/test<Flavor>/
      // (invisible to the static walker), but the probe lists
      // test<Flavor><BuildType>UnitTest → flavors is non-empty; the umbrella
      // `test` task runs them all, so accept it (dispatch picks the same
      // umbrella). Falls through to current behavior when source-set info is absent.
      if (c === 'test' && analysis && analysis.sourceSets
          && !analysis.sourceSets.test && !analysis.sourceSets.androidUnitTest
          && flavors.length === 0) {
        continue;
      }
      return c;
    }
    return null;
  }
  const probedCoverage = pickFirst([
    'koverXmlReportDesktop', 'koverXmlReportDebug', 'koverXmlReport', 'jacocoTestReport',
  ]);
  // testBuildType-aware deviceTestTask candidate
  // chain. AGP exposes connected${BuildType}AndroidTest per declared variant;
  // when testBuildType="release" the canonical task is connectedReleaseAndroidTest.
  // Pre-fix the chain hardcoded `connectedDebugAndroidTest` first, so projects
  // exposing BOTH variants (e.g. di-sample `:benchmark` after the
  // androidComponents.beforeVariants opt-in that re-enabled debug tests
  // alongside the testBuildType="release" canonical) silently picked Debug.
  const deviceCandidates = ['connectedAndroidDeviceTest'];
  if (analysis && analysis.testBuildType) {
    const cap = analysis.testBuildType[0].toUpperCase() + analysis.testBuildType.slice(1);
    deviceCandidates.push(`connected${cap}AndroidTest`);
  }
  deviceCandidates.push('connectedDebugAndroidTest', 'connectedAndroidTest', 'androidConnectedCheck');
  // Probe-recovered product flavors + the AGP per-variant unit-test coverage
  // report tasks (`create${Variant}UnitTestCoverageReport`, jacoco-format).
  // These close the flavor dimension of the static-vs-probe gap: the dispatch
  // layer weaves `test${Flavor}${BuildType}UnitTest` for the unit leg and the
  // matching coverage report task, neither of which the non-flavored
  // `coverageTask`/`unitTestTask` candidates can express.
  const flavoredCoverage = gradleTasks.filter(t => /UnitTestCoverageReport$/.test(t)).sort();
  return {
    unitTestTask:   pickFirst(['desktopTest', 'jvmTest', 'test', 'jsTest', 'wasmJsTest']),
    deviceTestTask: pickFirst(deviceCandidates),
    coverageTask:   probedCoverage ?? predictedCoverage,
    webTestTask:    pickFirst(['jsTest', 'wasmJsTest']),
    iosTestTask:    pickFirst(['iosSimulatorArm64Test', 'iosX64Test', 'iosArm64Test', 'iosTest']),
    macosTestTask:  pickFirst(['macosArm64Test', 'macosX64Test', 'macosTest']),
    flavors,
    coverageReportTasks: flavoredCoverage,
  };
}

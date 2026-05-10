// SPDX-License-Identifier: MIT
// lib/parallel-orchestrator.js — Node-side `kmp-test parallel` orchestrator
// (v0.8 PIVOT, sub-entry 5 — terminal step). Replaces the parallel codepath
// of scripts/{sh,ps1}/run-parallel-coverage-suite.{sh,ps1} (~2,600 LOC after
// the sub-entry 4 --skip-tests early-shim) with direct gradle dispatch and
// in-process result aggregation.
//
// Bugs closed by construction:
//   WS-3  — kmp-test android module discovery aligns with parallel via the
//           single source of truth (project-model resolveTasksFor).
//   WS-6  — `--test-type all` dispatches one gradle leg per supported type
//           and aggregates, instead of mapping `all` to `desktopTest`.
//   WS-7  — `--test-type common` resolves through unitTestTask candidate
//           chain (jvmTest > desktopTest > test) instead of hardcoding
//           desktopTest. Also closes the jvm()→jvmTest fallback.
//   WS-8  — `tests.individual_total` aggregated from junit-XML walk under
//           <module>/build/test-results/<task>/TEST-*.xml.
//   WS-9  — `modules:[]` populated when tests.passed > 0 (today empty even
//           on passing runs because legacy report-builder keys off coverage).
//   UX-1  — modules without target source set emit skipped[] with reason
//           instead of dropping silently.
//   UX-2  — message text "No modules found matching filter: *" → "No modules
//           support the requested --test-type=<X>" when filter is `*` AND
//           --test-type is the cause.
//   platform_unsupported — new errors[].code when --test-type ios|macos is
//           invoked on Windows/Linux (per PRODUCT.md "platform-aware").
//
// Coverage hand-off: when !--no-coverage and !--skip-tests, calls runCoverage
// from lib/coverage-orchestrator.js IN-PROCESS (no subprocess hop). The
// --skip-tests path delegates to runCoverage early (collapsing the wrapper's
// coverage = parallel --skip-tests aliasing).

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  buildJsonReport,
  envErrorJson,
  buildDryRunReport,
  buildInvalidArgsEnvelope,
  applyErrorCodeDiscriminators,
  parseGradleTimeoutMs,
  resolveAndroidTestFilter,
  splitClassMethod,
  EXIT,
} from './cli.js';
import { buildProjectModel } from './project-model.js';
import {
  defaultAdbProbe,
  spawnGradle,
  readPackageName,
  parseIsolatedArgs,
  resolveIsolatedDir,
  injectProjectCacheDir,
  cleanupIsolatedDir,
  shouldKeepIsolated,
  buildIsolatedField,
  splitCsv,
  globToRegex,
  matchModuleFilter,
  expandPosixEqualsForm,
  validateEnum,
  validateNonNegativeInt,
} from './orchestrator-utils.js';

// v0.9 session 2 Bug-B — enum allowlists. Mirrors cli.js's pre-spawn list
// AND the ps1 wrapper's [ValidateSet]. Pre-fix the parser silently accepted
// any string; invalid values surfaced as confusing "task not found" errors
// at gradle time. `desktop` is a wrapper-level alias for jvm-on-Compose-Desktop.
const TEST_TYPE_VALUES = [
  'common', 'jvm', 'android', 'androidUnit', 'androidInstrumented',
  'ios', 'macos', 'js', 'wasm', 'desktop', 'all',
];
const COVERAGE_TOOL_VALUES = ['auto', 'kover', 'jacoco', 'none'];
import { maybeAugmentEnvWithAndroidSdk } from './android-sdk-catalogue.js';
// PR-02 pre-v0.10 refactor — junit-XML parsers extracted to lib/parsers/.
// Re-exported below from this module for back-compat with tests that
// import these names directly.
import {
  junitTestCountFor,
  forEachJunitXml,
  junitTestFailuresFor,
  extractTestcaseFailures,
  decodeXmlEntities,
} from './parsers/junit-xml.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    includeShared: false,
    testType: '',
    testTypeExplicit: false,
    moduleFilter: '*',
    testFilter: '',
    maxWorkers: 0,
    coverageTool: 'auto',
    coverageModules: '',
    minMissedLines: 0,
    excludeCoverage: '',
    excludeModules: '',
    includeUntested: false,
    timeout: 600,
    noCoverage: false,
    skipTests: false,
    dryRun: false,
    // v0.9 step 9.8 — `--list-only` emits the discovered/filtered module set
    // (post-skip) and exits before any gradle dispatch. Mirrors
    // `kmp-test android --list-only` shape; complements `--dry-run` (which
    // shows the resolved spawn command) by surfacing the set the spawn
    // would actually iterate over.
    listOnly: false,
    freshDaemon: false,
    outputFile: 'coverage-full-report.md',
    coverageOnly: false,
    benchmark: false,
    benchmarkConfig: 'smoke',
    // 2026-05-03 — Android variant selector. Default 'auto' picks Debug if
    // its task exists, falls back to Release (handles `testBuildType =
    // "release"` projects like di-sample `:benchmark`). Explicit
    // values: 'debug', 'release', 'all' (dispatches both as separate tasks
    // in the same gradle invocation).
    androidVariant: 'auto',
    // 2026-05-05 v0.9 step 1 (flags #3 / #5 / #1 / #2 / #4) — close parity
    // with `kmp-test android` for instrumented runs. Each flag is a no-op
    // for non-androidInstrumented legs.
    device: '',                  // #3 — adb device serial (ANDROID_SERIAL)
    deviceTaskOverride: '',      // #5 — explicit gradle task override
    autoRetry: false,            // #2 — re-spawn failed tasks once
    clearData: false,            // #1 — adb shell pm clear before retry
    flavor: '',                  // #4 — productFlavor weave
    // 2026-05-05 v0.9 step 2 — global escape hatch. Tokens are appended
    // LAST in the gradleArgs array so users can override CLI defaults
    // (e.g. `--gradle-args "--no-parallel"` overrides the CLI's --parallel
    // via gradle's last-wins flag semantics). Repeatable across invocations
    // — `--gradle-args "--no-parallel" --gradle-args "-Pfoo=bar"` accumulates
    // both. Single-invocation values are whitespace-split. Quoted values
    // with embedded spaces (`-Pmessage="hello world"`) are NOT supported;
    // workaround is to pass --gradle-args multiple times.
    gradleArgs: [],
    // v0.9 session 2 Bug-B/Bug-D — collected validation errors. Caller
    // (runParallel) inspects `opts.errors` and emits an EXIT.CONFIG_ERROR
    // envelope before any gradle work when any `invalid_*` code is present.
    errors: [],
  };
  const expanded = expandNoCoverageAlias(argv);
  for (let i = 0; i < expanded.length; i++) {
    const a = expanded[i];
    switch (a) {
      case '--include-shared':     out.includeShared = true; break;
      case '--test-type': {
        const v = validateEnum('--test-type', expanded[++i], TEST_TYPE_VALUES, out.errors);
        if (v !== null && v !== undefined) { out.testType = v; out.testTypeExplicit = true; }
        break;
      }
      case '--module-filter':      out.moduleFilter = expanded[++i] || '*'; break;
      case '--test-filter':        out.testFilter = expanded[++i] || ''; break;
      case '--max-workers': {
        const v = validateNonNegativeInt('--max-workers', expanded[++i], out.errors);
        if (v !== null && v !== undefined) out.maxWorkers = v;
        break;
      }
      case '--coverage-tool': {
        const v = validateEnum('--coverage-tool', expanded[++i], COVERAGE_TOOL_VALUES, out.errors);
        if (v !== null && v !== undefined) out.coverageTool = v;
        break;
      }
      case '--coverage-modules':   out.coverageModules = expanded[++i] || ''; break;
      case '--min-missed-lines': {
        const v = validateNonNegativeInt('--min-missed-lines', expanded[++i], out.errors);
        if (v !== null && v !== undefined) out.minMissedLines = v;
        break;
      }
      case '--exclude-coverage':   out.excludeCoverage = expanded[++i] || ''; break;
      case '--exclude-modules':    out.excludeModules = expanded[++i] || ''; break;
      case '--include-untested':   out.includeUntested = true; break;
      case '--timeout': {
        const v = validateNonNegativeInt('--timeout', expanded[++i], out.errors);
        if (v !== null && v !== undefined) out.timeout = v;
        break;
      }
      case '--skip-tests':         out.skipTests = true; break;
      case '--dry-run':            out.dryRun = true; break;
      case '--list':
      case '--list-only':          out.listOnly = true; break;
      case '--fresh-daemon':       out.freshDaemon = true; break;
      case '--output-file':        out.outputFile = expanded[++i] || 'coverage-full-report.md'; break;
      // v0.9 session 2 Bug-E — `--coverage-only` implies `--skip-tests`. The
      // help text documents the implication; pre-fix only `coverageOnly` was
      // set, leaving `skipTests` false so dispatchLeg still ran the full test
      // suite before the coverage-only short-circuit.
      case '--coverage-only':      out.coverageOnly = true; out.skipTests = true; break;
      case '--benchmark':          out.benchmark = true; break;
      case '--benchmark-config':   out.benchmarkConfig = expanded[++i] || 'smoke'; break;
      case '--variant':
      case '--android-variant':    out.androidVariant = (expanded[++i] || 'auto').toLowerCase(); break;
      // 2026-05-05 v0.9 step 1 — parity-gap flags. All five are
      // androidInstrumented-only; no-op for other test types.
      case '--device':             out.device = expanded[++i] || ''; break;
      case '--device-task':        out.deviceTaskOverride = expanded[++i] || ''; break;
      case '--auto-retry':         out.autoRetry = true; break;
      case '--clear-data':         out.clearData = true; break;
      case '--flavor':             out.flavor = expanded[++i] || ''; break;
      // 2026-05-05 v0.9 step 2 — global gradle-args escape hatch.
      case '--gradle-args': {
        const raw = expanded[++i] || '';
        for (const tok of raw.split(/\s+/).filter(Boolean)) out.gradleArgs.push(tok);
        break;
      }
      default: /* unknown — drop, runner.js already stripped globals */ break;
    }
  }
  return out;
}

// --no-coverage is sugar for --coverage-tool none.
//
// v0.9 session 2 Bug-A.2 — POSIX `--flag=value` split lifted to
// orchestrator-utils.js#expandPosixEqualsForm so android / benchmark / changed
// / describe orchestrators share the same normalization. Alias-then-split
// shape preserved: `--no-coverage=foo` (typo, since `--no-coverage` is
// boolean) still emits `[--no-coverage, foo]` rather than re-aliasing.
function expandNoCoverageAlias(argv) {
  const aliased = [];
  for (const a of argv) {
    if (a === '--no-coverage') {
      aliased.push('--coverage-tool', 'none');
      continue;
    }
    aliased.push(a);
  }
  return expandPosixEqualsForm(aliased);
}

// v0.9 step 9.3 (Bug #3) — `splitCsv`, `globToRegex`, and the dual-test
// glob matcher were lifted to `lib/orchestrator-utils.js` so android +
// benchmark + describe orchestrators share the same filter normalization.
// `matchAnyGlob` retained as a backwards-compat alias for tests + downstream
// consumers; new code should call `matchModuleFilter` directly.
const matchAnyGlob = matchModuleFilter;

// ---------------------------------------------------------------------------
// Module discovery + classification
// ---------------------------------------------------------------------------
function discoverParallelModules(projectModel) {
  const out = [];
  if (!projectModel?.modules) return out;
  for (const [modKey, entry] of Object.entries(projectModel.modules)) {
    const name = modKey.replace(/^:/, '');
    out.push({
      name,
      type: entry.type ?? null,             // 'kmp' | 'android' | 'jvm' | null
      androidDsl: !!entry.androidDsl,
      // 2026-05-04 Bug D — `androidDslVariant` distinguishes the new KMP-Android
      // plugin (`com.android.kotlin.multiplatform.library`, Kotlin 2.3+) from
      // legacy AGP. The new plugin uses `testAndroidHostTest` /
      // `androidConnectedCheck` task names and requires opt-in builders inside
      // `androidLibrary {}`. Null = legacy / non-android-library.
      androidDslVariant: entry.androidDslVariant ?? null,
      sourceSets: entry.sourceSets ?? {},
      coveragePlugin: entry.coveragePlugin ?? null,
      resolved: entry.resolved ?? null,
      testBuildType: entry.testBuildType ?? null,
      // 2026-05-05 v0.9 step 1 (flag #4) — surfaces project-model
      // `productFlavors {}` detection so `--flavor <name>` can weave the
      // flavor name into the gradle task only on modules that declare
      // flavors (mirrors `lib/android-orchestrator.js` line 98).
      hasFlavor: !!entry.hasFlavor,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// True when the module has any *Test* source set on disk. Mirrors the wrapper's
// auto-skip-untested filter (run-parallel-coverage-suite.sh find_modules).
function hasAnyTestSourceSet(mod) {
  if (!mod.sourceSets || typeof mod.sourceSets !== 'object') return false;
  for (const [ss, present] of Object.entries(mod.sourceSets)) {
    if (present && /test/i.test(ss)) return true;
  }
  return false;
}

// Apply --module-filter (glob), --exclude-modules (glob), and the
// auto-skip-untested filter. Returns { kept, skipped:[{module,reason}] } so
// the caller can append skipped[] to state.
function applyModuleFilters(modules, opts, env) {
  let kept = modules;
  const skipped = [];

  // --module-filter: default "*" matches everything; comma-separated list of
  // globs. `matchModuleFilter` (lifted to orchestrator-utils in v0.9 step 9.3)
  // already dual-tests against bare + `:`-prefixed + short-suffix variants,
  // so the previous local short-suffix branch is no longer needed. Modules
  // dropped by --module-filter are NOT surfaced in skipped[] (the user
  // explicitly narrowed the set; this matches benchmark/changed conventions).
  if (opts.moduleFilter && opts.moduleFilter !== '*') {
    kept = kept.filter(m => matchModuleFilter(m.name, opts.moduleFilter));
  }

  // --exclude-modules: glob list. Surfaced in skipped[] with reason
  // (preserves wrapper [SKIP] banner contract for visibility).
  if (opts.excludeModules) {
    const survivors = [];
    for (const m of kept) {
      if (matchModuleFilter(m.name, opts.excludeModules)) {
        skipped.push({ module: m.name, reason: 'excluded by --exclude-modules' });
      } else {
        survivors.push(m);
      }
    }
    kept = survivors;
  }

  // Auto-skip modules with no *Test* source set unless --include-untested.
  // Mirrors the wrapper's find_modules filter.
  if (!opts.includeUntested) {
    const survivors = [];
    for (const m of kept) {
      if (hasAnyTestSourceSet(m)) {
        survivors.push(m);
      } else {
        skipped.push({ module: m.name, reason: 'no test source set' });
      }
    }
    kept = survivors;
  }

  return { kept, skipped };
}

// SKIP_*_MODULES env vars target the per-test-type leg. Returns
// { kept, skipped:[{module,reason}] } so the caller can append to state.skipped.
// v0.8.0 — `config` (optional) provides a fallback when env is unset:
//   precedence is env SKIP_<X>_MODULES > config.skip.<x> > '' (no skip).
//   The skip reason string is suffixed with " [config]" when config-sourced
//   so debugging can distinguish env vs config provenance.
function partitionBySkipEnv(modules, testType, env, config = null) {
  const skipped = [];
  const kept = [];
  let envVar = '';
  let label = '';
  let configKey = '';
  if (testType === 'desktop' || testType === 'common') {
    envVar = env.SKIP_DESKTOP_MODULES || ''; label = 'desktop'; configKey = 'desktop';
  } else if (testType === 'ios') {
    envVar = env.SKIP_IOS_MODULES || ''; label = 'ios'; configKey = 'ios';
  } else if (testType === 'macos') {
    envVar = env.SKIP_MACOS_MODULES || ''; label = 'macos'; configKey = 'macos';
  } else if (testType === 'androidUnit' || testType === 'androidInstrumented') {
    envVar = env.SKIP_ANDROID_MODULES || ''; label = 'android'; configKey = 'android';
  }
  let fromConfig = false;
  if (!envVar && config && config.skip && Array.isArray(config.skip[configKey])) {
    envVar = config.skip[configKey].join(',');
    fromConfig = true;
  }
  const skipNames = new Set(splitCsv(envVar));
  const reasonSuffix = fromConfig ? ' [config]' : '';
  for (const m of modules) {
    const short = m.name.split(':').pop();
    if (skipNames.has(short) || skipNames.has(m.name)) {
      skipped.push({ module: m.name, reason: `SKIP_${label.toUpperCase()}_MODULES (${envVar})${reasonSuffix}` });
    } else {
      kept.push(m);
    }
  }
  return { kept, skipped };
}

// ---------------------------------------------------------------------------
// Per-test-type task selection (single source of truth: project-model)
// ---------------------------------------------------------------------------
// True when the module declares an iOS target on disk (iosMain, iosSimulatorArm64Main,
// iosX64Main, iosArm64Main source sets) — gradle creates the *Test task from
// the target() declaration even without a test source set yet. Mirrors the
// legacy wrapper's permissive dispatch (Confetti :shared shape regression).
function hasIosTargetDeclared(mod) {
  if (!mod.sourceSets) return false;
  return ['iosMain', 'iosSimulatorArm64Main', 'iosX64Main', 'iosArm64Main',
          'iosSimulatorArm64Test', 'iosX64Test', 'iosArm64Test', 'iosTest']
    .some(ss => mod.sourceSets[ss]);
}
function hasMacosTargetDeclared(mod) {
  if (!mod.sourceSets) return false;
  return ['macosMain', 'macosArm64Main', 'macosX64Main',
          'macosArm64Test', 'macosX64Test', 'macosTest']
    .some(ss => mod.sourceSets[ss]);
}

// Returns { task: ":mod:<task>" | null, reason: '<why null>' | '' }. A null
// task surfaces the module on state.skipped[] with the reason text — closes
// UX-1 (silent drops were the source of the bug).
// 2026-05-03 — Android variant resolver. Default 'auto' uses the project's
// declared testBuildType (when statically detectable) or falls back to debug.
// Explicit values: 'debug', 'release', 'all' (umbrella `test` task — gradle
// runs both Debug and Release variants).
function androidUnitTask(gradlePath, variant, mod) {
  const v = (variant || 'auto').toLowerCase();
  if (v === 'debug')   return `${gradlePath}:testDebugUnitTest`;
  if (v === 'release') return `${gradlePath}:testReleaseUnitTest`;
  if (v === 'all')     return `${gradlePath}:test`;  // umbrella runs both
  // 'auto' — prefer Release when build script statically declares
  // `testBuildType = "release"`; else default to Debug (the AGP default).
  if (mod && mod.testBuildType === 'release') return `${gradlePath}:testReleaseUnitTest`;
  return `${gradlePath}:testDebugUnitTest`;
}

// 2026-05-05 fix-PR-F — Mirror of androidUnitTask for instrumented dispatch.
// AGP creates :m:connectedAndroidTest as a lifecycle umbrella that depends
// on every :m:connected${Variant}AndroidTest for variants with an
// androidInstrumentedTest source set — the connected analog of :m:test.
// Repro: di-sample :benchmark sets `testBuildType = "release"`, so
// connectedDebugAndroidTest doesn't exist; auto-resolution must pick
// connectedReleaseAndroidTest from mod.testBuildType.
//
// 2026-05-05 v0.9 step 1 (flag #4) — `--flavor <name>` weave. When `flavor`
// is non-empty AND the module declares productFlavors (mod.hasFlavor=true),
// AGP creates `:m:connected${Cap(flavor)}${Variant}AndroidTest`. When
// hasFlavor is false, the flavor weave is a no-op for THIS module (gradle
// would error on a non-existent task name); the runParallel layer surfaces
// a `flavor_unused` warning when no module on the leg has hasFlavor.
function androidConnectedTask(gradlePath, variant, mod, flavor = '') {
  const v = (variant || 'auto').toLowerCase();
  const cap = flavor && mod && mod.hasFlavor
    ? flavor.charAt(0).toUpperCase() + flavor.slice(1)
    : '';
  if (v === 'debug')   return `${gradlePath}:connected${cap}DebugAndroidTest`;
  if (v === 'release') return `${gradlePath}:connected${cap}ReleaseAndroidTest`;
  if (v === 'all')     return `${gradlePath}:connected${cap}AndroidTest`;  // umbrella
  if (mod && mod.testBuildType === 'release') return `${gradlePath}:connected${cap}ReleaseAndroidTest`;
  return `${gradlePath}:connected${cap}DebugAndroidTest`;
}

// v0.9 wet-audit drift #2: stable per-module envelope shape used by BOTH
// the `--list-only` short-circuit and the wet-run modules[] population.
// Pre-fix wet runs emitted bare strings (`["sample-result"]`) while list-only
// emitted objects (`[{name, type, coverage_plugin, ...}]`) — agents reading
// the same `modules[]` field across the two execution paths had to branch
// on shape. Post-fix both paths emit the same object schema.
function canonicalModuleEntry(mod) {
  return {
    name: mod.name,
    type: mod.type ?? null,
    coverage_plugin: mod.coveragePlugin ?? null,
    test_build_type: mod.testBuildType ?? null,
    has_flavor: !!mod.hasFlavor,
    android_dsl: mod.androidDsl ?? null,
    android_dsl_variant: mod.androidDslVariant ?? null,
  };
}

function pickGradleTaskFor(mod, testType, opts = {}) {
  const r = mod.resolved || {};
  const gradlePath = ':' + mod.name;
  switch (testType) {
    case 'common':
    case 'desktop': {
      // WS-7 + jvm()→jvmTest fallback closure: resolve via unitTestTask
      // candidate chain (desktopTest > jvmTest > test > jsTest > wasmJsTest).
      // The bare `test` source set is ambiguous (Android JUnit unit tests
      // also live there); only accept it when the module also declares a
      // jvm/desktop main source set to disambiguate from android-only.
      const t = r.unitTestTask;
      const ss = mod.sourceSets || {};
      if (!t) return { task: null, reason: `no ${testType} target` };
      if (t === 'test' && !ss.jvmMain && !ss.desktopMain && mod.type !== 'jvm') {
        return { task: null, reason: `no ${testType} target` };
      }
      return { task: `${gradlePath}:${t}`, reason: '' };
    }
    case 'androidUnit': {
      // Android unit tests don't have a project-model field today (see
      // resolveTasksFor — no androidUnitTask candidate). Variant-aware task
      // selection via androidUnitTask helper; gate by AGP plugin presence.
      // 2026-05-06 step 7 wet-validation fix — KaMPKit's `:shared` uses the
      // hybrid pattern (`com.android.library` plugin + `kotlin { android {
      // withHostTestBuilder {} } }` DSL) → parser surfaces type='kmp' +
      // androidDsl=null + androidDslVariant='kmpAndroidLibrary'. The legacy
      // gate only checked `type` and `androidDsl`, so the kmpAndroidLibrary
      // branch below never ran. Extending the gate to also accept
      // androidDslVariant closes the regression. Bug D's internal branch
      // already handled the variant; only the early-return was incomplete.
      if (mod.type !== 'android' && !mod.androidDsl && !mod.androidDslVariant) {
        return { task: null, reason: 'no androidUnit target' };
      }
      const ss = mod.sourceSets || {};
      // 2026-05-04 Bug D — kmpAndroidLibrary path. The new KMP-Android plugin
      // (`com.android.kotlin.multiplatform.library`, Kotlin 2.3+) uses a
      // distinct task name `testAndroidHostTest` (no Debug/Release variants
      // — the new DSL omits product-flavor support per the plugin docs).
      // Source-set boolean is opt-in-driven (project-model overrides
      // `ss.androidUnitTest = hasHostTestOptIn`), so this single gate covers
      // BOTH "no source set on disk" and "no withHostTestBuilder {} opt-in".
      // Repro: a private KMP project's `:core-foo` module has the dir on disk
      // but no opt-in → AGP creates no task → must skip, not dispatch.
      if (mod.androidDslVariant === 'kmpAndroidLibrary') {
        if (!ss.androidUnitTest) {
          return { task: null, reason: 'no androidUnitTest source set (withHostTestBuilder{} missing)' };
        }
        // --variant flag is a no-op for the new plugin (no Debug/Release).
        return { task: `${gradlePath}:testAndroidHostTest`, reason: '' };
      }
      // 2026-05-04 Bug A — source-set evidence guard. Mirrors the default-case
      // heuristic at line ~388-393 but stricter: explicit --test-type=androidUnit
      // must NOT coerce a KMP+androidLibrary module into testDebugUnitTest when
      // no androidUnitTest source set was declared (AGP does not create the
      // task → task_not_found + module_failed). commonTest is excluded on
      // purpose: empirically a KMP+android module with `commonTest` but no
      // explicit `androidUnitTest by getting` does NOT get testDebugUnitTest.
      const hasUnitTestSrc = ss.test || ss.androidUnitTest;
      if (!hasUnitTestSrc) {
        return { task: null, reason: 'no androidUnitTest source set' };
      }
      return { task: androidUnitTask(gradlePath, opts.androidVariant, mod), reason: '' };
    }
    case 'androidInstrumented': {
      const t = r.deviceTestTask;
      const ss = mod.sourceSets || {};
      // 2026-05-05 v0.9 step 1 (flag #5) — `--device-task <name>` preempts
      // every other resolution path. Mirrors `lib/android-orchestrator.js`
      // line 122; escape hatch for projects whose connected*AndroidTest
      // names don't match either the kmpAndroidLibrary plugin's
      // `androidConnectedCheck` or AGP's `connected${Variant}AndroidTest`.
      if (opts.deviceTaskOverride) {
        return { task: `${gradlePath}:${opts.deviceTaskOverride}`, reason: '' };
      }
      // 2026-05-04 Bug D — kmpAndroidLibrary uses `androidDeviceTest` source
      // set (NOT `androidInstrumentedTest`). Plugin has no Debug/Release
      // variant split, so --variant is a no-op for this branch.
      if (mod.androidDslVariant === 'kmpAndroidLibrary') {
        if (!ss.androidDeviceTest) {
          return { task: null, reason: 'no androidDeviceTest source set (withDeviceTestBuilder{} missing)' };
        }
        return { task: `${gradlePath}:androidConnectedCheck`, reason: '' };
      }
      // 2026-05-05 fix-PR-F-bis — AGP modules with source-set evidence go
      // through `androidConnectedTask` so `--variant` + `mod.testBuildType`
      // decide the canonical variant BEFORE the probe early-return below.
      // Pre-fix this branch sat AFTER the early-return, so projects exposing
      // BOTH `connectedDebugAndroidTest` AND `connectedReleaseAndroidTest` in
      // `gradleTasks` (e.g. di-sample `:benchmark` post the
      // `androidComponents.beforeVariants` opt-in that re-enabled debug
      // tests alongside `testBuildType = "release"`) silently dispatched the
      // first probed candidate (Debug) regardless of testBuildType, and an
      // explicit `--variant release` from the user was bypassed.
      // 2026-05-04 Bug A source-set evidence guard preserved.
      const hasInstrumentedSrc = ss.androidInstrumentedTest || ss.androidTest;
      if ((mod.type === 'android' || mod.androidDsl) && hasInstrumentedSrc) {
        return { task: androidConnectedTask(gradlePath, opts.androidVariant, mod, opts.flavor), reason: '' };
      }
      // Probe-wins fallback for non-AGP / non-kmpAndroidLibrary modules or
      // AGP modules without source-set evidence (preserves the existing
      // "deviceTestTask probe wins over fallback gate" invariant).
      if (t) return { task: `${gradlePath}:${t}`, reason: '' };
      return { task: null, reason: 'no androidInstrumentedTest source set' };
    }
    case 'ios': {
      const t = r.iosTestTask;
      if (t) return { task: `${gradlePath}:${t}`, reason: '' };
      // Permissive fallback: module declares an iOS target (any iosMain/
      // iosSimulatorArm64Main/etc. source set) but has no iosTest source set
      // yet — gradle still creates iosSimulatorArm64Test from the target
      // declaration. Match the legacy wrapper's behavior so Confetti's
      // :shared shape (iosMain only, no iosTest yet) gets dispatched.
      if (hasIosTargetDeclared(mod)) {
        return { task: `${gradlePath}:iosSimulatorArm64Test`, reason: '' };
      }
      return { task: null, reason: 'no ios target' };
    }
    case 'macos': {
      const t = r.macosTestTask;
      if (t) return { task: `${gradlePath}:${t}`, reason: '' };
      if (hasMacosTargetDeclared(mod)) {
        return { task: `${gradlePath}:macosArm64Test`, reason: '' };
      }
      return { task: null, reason: 'no macos target' };
    }
    case 'js':
    case 'wasmJs': {
      const t = r.webTestTask;
      if (!t) return { task: null, reason: `no ${testType}() target` };
      return { task: `${gradlePath}:${t}`, reason: '' };
    }
    default: {
      // Empty test-type / unknown → auto-pick by module type. Mirror the legacy
      // case *) branch (line 678): KMP/JVM → unitTestTask, Android-only → testDebugUnitTest.
      if (mod.type === 'android') {
        // 2026-05-03 — Skip Android modules that have NO unit-test source set.
        // Repro: di-sample `:benchmark` is an instrumented-only module
        // (only `src/androidTest/`, no `src/test/`) with `testBuildType =
        // "release"` so even AGP's auto-created `testDebugUnitTest` doesn't
        // exist. Hardcoding the task name → `Cannot locate tasks that match`.
        // Source-set evidence is the cheapest signal: any of `test`,
        // `androidUnitTest`, `commonTest` (KMP+android paired) means at least
        // one unit-test source likely exists. Absence → skip with reason.
        const ss = mod.sourceSets || {};
        const hasUnitTestSrc = ss.test || ss.androidUnitTest || ss.commonTest;
        if (!hasUnitTestSrc) {
          return { task: null, reason: 'no androidUnit source set (instrumented-only?)' };
        }
        return { task: androidUnitTask(gradlePath, opts.androidVariant, mod), reason: '' };
      }
      const t = r.unitTestTask;
      if (!t) {
        // 2026-05-04 Bug D — kmpAndroidLibrary modules without a JVM target
        // declaration have no `unitTestTask` resolved by the probe. In auto-pick
        // mode, fall back to the host test task when the opt-in is present —
        // otherwise the module would be silently skipped despite having a real
        // test surface (`src/androidUnitTest/` + `withHostTestBuilder {}`).
        if (mod.androidDslVariant === 'kmpAndroidLibrary' && mod.sourceSets?.androidUnitTest) {
          return { task: `${gradlePath}:testAndroidHostTest`, reason: '' };
        }
        return { task: null, reason: 'no resolvable test task' };
      }
      return { task: `${gradlePath}:${t}`, reason: '' };
    }
  }
}

// ---------------------------------------------------------------------------
// `--test-type all` aggregation: which legs to run on which platform
// ---------------------------------------------------------------------------
function legsForAll(env) {
  const isMac = process.platform === 'darwin';
  const skipAdb = String(env.KMP_TEST_SKIP_ADB || '') === '1';
  const legs = ['common', 'desktop', 'androidUnit'];
  if (!skipAdb) legs.push('androidInstrumented');
  if (isMac) {
    legs.push('ios');
    legs.push('macos');
  }
  return legs;
}

// ---------------------------------------------------------------------------
// Per-leg gradle dispatch — single invocation, all tasks at once
// ---------------------------------------------------------------------------
// 2026-05-05 fix-PR-G — translate `--test-filter` into the right gradle args
// per task class. JvmTestTask (jvmTest, desktopTest, testDebugUnitTest, etc.),
// KotlinNativeTest (iosSimulatorArm64Test, macosArm64Test) and KotlinJsTest
// (jsTest, wasmJsTest) all accept the `--tests <pattern>` CLI flag. AGP's
// AndroidConnectedTest (connectedDebugAndroidTest, connectedReleaseAndroidTest,
// connected${Flavor}DebugAndroidTest, etc.) does NOT — passing `--tests`
// produces `Unknown command-line option '--tests'` and BUILD FAILED. The
// canonical filter for instrumented tests is
// `-Pandroid.testInstrumentationRunnerArguments.{class,method}` per
// https://developer.android.com/studio/test/command-line. Repro pre-fix:
// `kmp-test parallel --test-type androidInstrumented --test-filter <FQN>`
// against any project with a connected device. Mirrors
// `lib/android-orchestrator.js#buildFilterArgs` which already does the right
// translation for the dedicated `kmp-test android` subcommand.
//
// 2026-05-05 v0.9 step 1 (flag #6) — emit the combined single-arg shape
// `class=<FQN>#<method>` instead of separate `class=<FQN>` + `method=<m>`.
// The combined form is the canonical AGP/AndroidJUnitRunner shape that
// ALWAYS works (per BACKLOG.md L329); separate args silently miss the
// method filter under Microbenchmark (live repro on di-sample:
// 14 of 14 DiBenchmark methods ran instead of 1 with separate args).
function buildFilterArgs(testFilter, testType, projectRoot) {
  if (!testFilter) return [];
  if (testType === 'androidInstrumented') {
    const resolved = resolveAndroidTestFilter(testFilter, projectRoot) || testFilter;
    const { cls, method } = splitClassMethod(resolved);
    if (method) {
      return [`-Pandroid.testInstrumentationRunnerArguments.class=${cls}#${method}`];
    }
    return [`-Pandroid.testInstrumentationRunnerArguments.class=${cls}`];
  }
  // JvmTestTask / KotlinNativeTest / KotlinJsTest all accept --tests.
  return ['--tests', testFilter];
}

function dispatchLeg({
  spawn, gradlewPath, projectRoot, taskList, testType, opts, env, log, isolatedDir = null,
}) {
  let gradleArgs = [...taskList, '--parallel', '--continue'];
  if (opts.maxWorkers > 0) gradleArgs.push(`--max-workers=${opts.maxWorkers}`);
  gradleArgs.push(...buildFilterArgs(opts.testFilter, testType, projectRoot));
  // v0.9 step 2 — append user escape-hatch tokens LAST so gradle's last-wins
  // flag semantics let `--gradle-args "--no-parallel"` override CLI default.
  if (opts.gradleArgs && opts.gradleArgs.length > 0) gradleArgs.push(...opts.gradleArgs);
  // v0.9 step 4 — `--isolated` injects gradle's --project-cache-dir <tmp> so
  // concurrent kmp-test runs against the same project don't share the
  // configuration cache / build outputs in <project>/.gradle/.
  gradleArgs = injectProjectCacheDir(gradleArgs, isolatedDir);

  log(`[>] Executing ${taskList.length} test task(s) in parallel...`);
  for (const t of taskList) log(`    ${t}`);

  const result = spawnGradle(spawn, gradlewPath, gradleArgs, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout > 0 ? opts.timeout * 1000 : undefined,
  });
  const exit = (result && typeof result.status === 'number') ? result.status : 1;
  const stdout = (result && result.stdout) || '';
  const stderr = (result && result.stderr) || '';
  return { exit, stdout, stderr, gradleArgs };
}

// Per-task pass/fail extraction. Mirrors the bash wrapper's "<task> FAILED"
// grep (line 983). Returns Map<task, 'passed'|'failed'>.
//
// Defense-in-depth (added 2026-05-03 after the EINVAL silent-pass incident):
// when the leg explicitly failed (`legExit !== 0`) AND we have no positive
// evidence the task ran (no `Task :<task>` mention) AND no global success
// marker (no `BUILD SUCCESSFUL`), default to 'failed' instead of 'passed'.
// PRODUCT.md WS-1 contract requires never silent-passing on a failed leg.
// Catches: (a) Windows EINVAL spawn no-ops, (b) gradle aborts in
// configuration phase before any task runs, (c) future regressions where
// stdout is empty for any reason while exit != 0.
// Per-task execution mode telemetry — returns Map<task, 'fresh' | 'up_to_date'
// | 'from_cache' | 'no_source' | 'skipped_by_gradle' | 'failed' | 'no_evidence'>.
// Distinguishes "tests actually re-ran" (fresh) from gradle's incremental
// shortcuts (UP-TO-DATE / FROM-CACHE) that produce a [PASS] outcome without
// new test execution. Aggregated per-leg into envelope `parallel.legs[].execution`
// so AI-agent consumers and CI dashboards can detect cache-only-greens (a stale
// build cache or a not-actually-executed CI run will surface as
// `up_to_date+from_cache > 0 && fresh === 0`). Defense-in-depth complement to
// the post-#116 silent-pass guard; that guard catches "gradle didn't run at all",
// this catches "gradle ran but produced no fresh test execution".
function classifyTaskExecutionMode(stdout, stderr, taskList) {
  const all = stdout + '\n' + stderr;
  const out = new Map();
  for (const task of taskList) {
    const escaped = task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match `> Task <name>` (or `Task <name>` mid-line) with optional status
    // suffix. Tolerant to trailing whitespace; multiline mode pins to line end.
    const re = new RegExp('Task\\s+' + escaped
      + '(?:\\s+(UP-TO-DATE|FROM-CACHE|NO-SOURCE|SKIPPED|FAILED))?\\s*$', 'm');
    const m = re.exec(all);
    if (!m) { out.set(task, 'no_evidence'); continue; }
    const suffix = m[1];
    if (!suffix)                          out.set(task, 'fresh');
    else if (suffix === 'UP-TO-DATE')     out.set(task, 'up_to_date');
    else if (suffix === 'FROM-CACHE')     out.set(task, 'from_cache');
    else if (suffix === 'NO-SOURCE')      out.set(task, 'no_source');
    else if (suffix === 'SKIPPED')        out.set(task, 'skipped_by_gradle');
    else if (suffix === 'FAILED')         out.set(task, 'failed');
  }
  return out;
}

// Aggregate per-task execution modes into a leg-level summary.
function summarizeExecutionModes(modeMap) {
  const summary = {
    fresh: 0, up_to_date: 0, from_cache: 0, no_source: 0,
    skipped_by_gradle: 0, failed: 0, no_evidence: 0,
  };
  for (const mode of modeMap.values()) {
    if (mode in summary) summary[mode]++;
  }
  return summary;
}

function classifyTaskResults(stdout, stderr, taskList, legExit = 0) {
  const all = stdout + '\n' + stderr;
  const out = new Map();
  const resolutionFailed = /Cannot locate tasks? that match/.test(all);
  const buildSucceeded = /BUILD SUCCESSFUL/.test(all);
  for (const task of taskList) {
    if (resolutionFailed) {
      out.set(task, 'failed');
      continue;
    }
    const escaped = task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const failedRe = new RegExp(escaped + '\\s+FAILED');
    if (failedRe.test(all)) {
      out.set(task, 'failed');
      continue;
    }
    // Positive-evidence check for defense-in-depth path. Gradle prints
    // `> Task :mod:taskName` (optionally followed by UP-TO-DATE / NO-SOURCE /
    // SKIPPED / FAILED) for every task it considers; absence means the task
    // never reached the executor.
    const taskMentionRe = new RegExp('Task\\s+' + escaped + '(\\s|$)');
    const taskMentioned = taskMentionRe.test(all);
    if (legExit !== 0 && !buildSucceeded && !taskMentioned) {
      out.set(task, 'failed');
      continue;
    }
    out.set(task, 'passed');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Default run-id (used for log naming continuity with the legacy wrapper)
// ---------------------------------------------------------------------------
function defaultRunId() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const pid6 = String(process.pid % 1000000).padStart(6, '0');
  return `${stamp}-${pid6}`;
}

// ---------------------------------------------------------------------------
// Per-leg execution: build task list, dispatch, collect results
// ---------------------------------------------------------------------------
async function executeLeg({
  spawn, gradlewPath, projectRoot, modules, testType, opts, env, config, log, state, runCoverageInjection,
  // 2026-05-05 v0.9 step 1 (flags #1 / #2) — resolved adb serial, threaded
  // by runParallel before the leg loop. Empty when not applicable
  // (no --device / --clear-data) or non-instrumented leg.
  deviceSerial = '',
  // v0.9 step 4 — isolated `--project-cache-dir <tmp>` resolved by the
  // top-level runParallel; null when --isolated wasn't set. Threaded into
  // every dispatchLeg call so the bundled-leg + cascade-isolation retry +
  // --auto-retry single-task retry all hit the same disposable cache dir.
  isolatedDir = null,
}) {
  // Step 1 — partition by SKIP_*_MODULES env (or config.skip.<type> fallback).
  const { kept, skipped: envSkipped } = partitionBySkipEnv(modules, testType, env, config);
  for (const sk of envSkipped) {
    log(`  [SKIP] ${sk.module} (${sk.reason})`);
    state.skipped.push(sk);
  }

  // Step 2 — pick task per module, route to skipped[] when no target exists.
  const taskList = [];
  const taskOwners = []; // Parallel: taskOwners[i] is the module owning taskList[i].
  for (const mod of kept) {
    const { task, reason } = pickGradleTaskFor(mod, testType, opts);
    if (!task) {
      // UX-1: emit skipped[] entry with reason instead of dropping silently.
      const reasonText = `${reason} (--test-type=${testType || 'auto'})`;
      log(`  [SKIP] ${mod.name} (${reason})`);
      state.skipped.push({ module: mod.name, reason: reasonText });
      continue;
    }
    taskList.push(task);
    taskOwners.push(mod.name);
  }

  // Step 3 — empty post-filter task list.
  //
  // v0.9 wet-audit drift #1 (PR #168, cells C1/E1/E2): when --module-filter
  // matched at least one module but the per-leg skip semantics (env
  // SKIP_*_MODULES at step 1, no test-type target at step 2) routed every
  // match to skipped[], emitting `no_test_modules` + promoting the leg to
  // exit 3 was confusing — agents reading exit-code branches saw a real
  // environmental failure instead of the legitimate "this leg has no
  // applicable target on the matched modules" outcome. Post-fix: when
  // modules were present pre-leg AND the user asked for a specific
  // test-type (single-leg path), the skipped[] entries carry the
  // diagnostic; no error is pushed, the leg returns success.
  //
  // For `--test-type all` (multi-leg dispatch), keep emitting the
  // `no_test_modules` error so the F2 demotion logic at line ~1565
  // can convert per-leg empties to `no_test_modules_for_leg` warnings
  // when at least one other leg passes — that contract was added in
  // v0.8 fix-PR-E and is still tested below.
  //
  // Filter-actually-matched-nothing (modules === 0 from
  // `applyModuleFilters` upstream) still surfaces the error through
  // the runParallel-level guard at line 1348.
  if (taskList.length === 0) {
    if (modules.length > 0 && opts.testType !== 'all') {
      log('  All matched modules legitimately skipped for this leg; no gradle dispatch.');
      return { stdout: '', stderr: '', exit: 0 };
    }
    // wet-audit-v0.9-part2 OBS-3 — `caused_by_filter` discriminator.
    // True when the empty match is downstream of a user-supplied filter
    // (--module-filter != '*' OR --exclude-modules set). False when the
    // project simply has no modules supporting the requested test-type.
    // Drives the CONFIG_ERROR (2) vs ENV_ERROR (3) split at the dispatch
    // tail (line ~1926).
    const causedByFilter = (opts.moduleFilter && opts.moduleFilter !== '*')
      || !!opts.excludeModules;
    let message;
    if (opts.moduleFilter === '*' && opts.testTypeExplicit && !opts.excludeModules) {
      message = `[ERROR] No modules support the requested --test-type=${testType}`;
    } else {
      message = `[ERROR] No modules found matching filter: ${opts.moduleFilter}`;
    }
    log(message);
    state.errors.push({
      code: 'no_test_modules',
      message: message.replace(/^\[ERROR\] /, ''),
      test_type: testType,
      caused_by_filter: causedByFilter,
    });
    return { stdout: '', stderr: '', exit: 0 };
  }

  // Step 4 — dispatch the gradle leg (one-shot, fast path).
  let { exit, stdout, stderr } = dispatchLeg({
    spawn, gradlewPath, projectRoot, taskList, testType, opts, env, log, isolatedDir,
  });

  // Step 4a — cascade-isolation fallback. When the leg exited non-zero AND
  // the per-task execution-mode summary shows ZERO `failed` tasks but
  // `no_evidence > 0`, gradle aborted at evaluation phase before reaching any
  // executor. With `--continue` + multi-module dispatch this means ONE
  // module's configuration error cascades all N tasks into a misleading "all
  // failed" — a passing `:shared:jvmTest` gets reported FAIL just because it
  // shares the leg with a broken `:androidApp:test` (Confetti repro,
  // wide-smoke 2026-05-03).
  //
  // PR5 fix (2026-05-04): the original PR #116 trigger relied on a permissive
  // `anyTaskMentioned` regex (`Task\s+:foo:bar(\s|$)`) that diverged from the
  // strict `classifyTaskExecutionMode` regex (`Task\s+:foo:bar(?:\s+SUFFIX)?\s*$`)
  // — gradle's housekeeping/daemon log lines mentioning task names tripped the
  // lax regex while genuine task execution lines were absent. Wide-smoke pass-7
  // found 8 of 30 cascade cases bypassed the original guard. The trigger now
  // mirrors the cascade signature pass-7's classifier uses, eliminating the
  // divergence. Single-task cascades (nav3-recipes shape) also retry now —
  // the per-module dispatch surfaces the actual gradle error context that the
  // bundled-leg output buried.
  //
  // Per-module classification (2026-05-03 v2): we MUST classify each retry
  // independently — merging stdout/stderr and re-running classifyTaskResults
  // over the aggregate corrupts results when ONE retry has `Cannot locate`
  // (taints `resolutionFailed` for ALL modules, repro: a 37-module private KMP project where
  // 36 of 37 modules' individual `:foo:desktopTest` succeeded but the global
  // classifier marked them all failed because one retry had a missing task).
  // Pre-classified results bypass step 5's global classifier.
  //
  // fix-PR-E (2026-05-04): cascade signature refined from `failed===0 &&
  // no_evidence>0` to the literal invariant "every task ended up no_evidence"
  // (i.e., gradle aborted before any task ran). The pre-fix proxy false-fired
  // on K/N native + AGP instrumented runtime fails where some tasks ran fresh
  // and the failing one's status line dropped to no_evidence due to the strict
  // `\s*$` anchor (gradle prints `> Task :foo FAILED in 5s` — non-whitespace
  // before EOL → strict regex misses). Repro: a private KMP project Win post-toolchain
  // `androidInstrumented` leg with S22 connected (`fresh:2, no_evidence:1`,
  // cascade_detected:true, retry_fired:true wasted gradle work). The new signal
  // is a strict superset on the genuine cascade cases (every task no_evidence)
  // and rejects the runtime-fail false positives (any task ran → not cascade).
  let execModes = classifyTaskExecutionMode(stdout, stderr, taskList);
  let execSummary = summarizeExecutionModes(execModes);
  const cascadeDetected = exit !== 0
    && execSummary.no_evidence === taskList.length;
  let retryFired = false;
  let preClassified = null;
  if (cascadeDetected) {
    retryFired = true;
    log('');
    log('  [!] One-shot dispatch aborted before any task ran — retrying per-module');
    log('      to isolate which module(s) are broken...');
    preClassified = new Map();
    let mergedStdout = '';
    let mergedStderr = '';
    let mergedExit = 0;
    for (let i = 0; i < taskList.length; i++) {
      const task = taskList[i];
      const owner = taskOwners[i];
      const r = dispatchLeg({
        spawn, gradlewPath, projectRoot, taskList: [task], testType, opts, env,
        log: (l) => log(`      ${owner}: ${l}`),
        isolatedDir,
      });
      // Classify THIS module's result in isolation (no cross-contamination).
      const oneShotMap = classifyTaskResults(r.stdout, r.stderr, [task], r.exit);
      preClassified.set(task, oneShotMap.get(task));
      mergedStdout += r.stdout + '\n';
      mergedStderr += r.stderr + '\n';
      if (r.exit !== 0 && mergedExit === 0) mergedExit = r.exit;
    }
    stdout = mergedStdout;
    stderr = mergedStderr;
    exit = mergedExit;
    // Re-classify execModes from the merged retry stdout. Each per-module
    // retry has fresh task-line evidence (gradle ran each task in isolation)
    // that the bundled one-shot lacked, so the post-retry summary now
    // accurately reflects fresh / failed / etc.
    execModes = classifyTaskExecutionMode(stdout, stderr, taskList);
    execSummary = summarizeExecutionModes(execModes);
  }

  // Step 4b — forward gradle's actual error context. The pre-2026-05-03
  // filter was too narrow (only `Cannot locate|FAILURE:|BUILD FAILED|
  // UnsupportedClassVersionError|Failed to install`) which swallowed every
  // `* What went wrong:` block, every `> Task :foo:bar FAILED` line, every
  // `> Could not resolve...` cause, leaving the user with only "BUILD
  // FAILED in 18s" and no diagnostic. Wide-smoke 2026-05-03 surfaced this
  // as soon as the EINVAL silent-pass was lifted (gradle was finally
  // running, but its output was still being hidden).
  //
  // New strategy (2026-05-03 v2): split by priority. Critical lines (failure
  // diagnostics) ALWAYS surface. Status-noise lines (`> Task :foo UP-TO-DATE`,
  // `NO-SOURCE`, `SKIPPED`, `FROM-CACHE`) get capped-and-summarized only when
  // there's room left under the global cap. The previous flat-cap approach
  // let 60 UP-TO-DATE lines drown the actual `Compilation error` 1000 lines
  // below — repro: nowinandroid `:feature:foryou:impl` failure reason hidden
  // by 1394-line task-status flood.
  const allLines = (stdout + '\n' + stderr).split(/\r?\n/);
  // CRITICAL_RE matches lines that carry the actual diagnostic. Includes any
  // unindented or indented `> ...` continuation line (PeopleInSpace `> SDK
  // location not found` was at column 0; my pre-fix `^\s+>\s+` only matched
  // indented). Also matches gradle's per-failure-block headers
  // (`> A failure occurred`, `> Could not resolve`, etc.) generically.
  const CRITICAL_RE = /FAILED$|^FAILURE:|^BUILD (FAILED|SUCCESSFUL)|^\* What went wrong:|^\* Where:|^\* Try:|UnsupportedClassVersionError|Failed to install|Cannot locate|requires Java|Android Gradle plugin requires|Plugin .* not found|Could not resolve all|Could not determine|^Caused by:|Compilation error|Execution failed for task|^[\d]+:\s+Task failed|There were failing tests|SDK location not found|sdk\.dir|^\s*>\s+\S/;
  const STATUS_RE = /^>\s*Task\s.*\b(UP-TO-DATE|NO-SOURCE|SKIPPED|FROM-CACHE)\b$/;
  const TASK_RUNNING_RE = /^>\s*Task\s/;
  const critical = [];
  const tasksRun = [];
  const statusNoise = [];
  for (const line of allLines) {
    if (CRITICAL_RE.test(line)) critical.push(line);
    else if (STATUS_RE.test(line)) statusNoise.push(line);
    else if (TASK_RUNNING_RE.test(line)) tasksRun.push(line);
  }
  // Always emit ALL critical lines (these are the actionable diagnostic).
  for (const line of critical) log(line);
  // Then up to 30 task-running lines (gives a sense of what executed).
  for (const line of tasksRun.slice(0, 30)) log(line);
  if (tasksRun.length > 30) {
    log(`  (… ${tasksRun.length - 30} more "> Task" lines suppressed)`);
  }
  if (statusNoise.length > 0) {
    log(`  (${statusNoise.length} UP-TO-DATE/NO-SOURCE/SKIPPED status lines suppressed)`);
  }

  // Step 5 — classify per-task pass/fail and record per-module results.
  // When cascade-isolation pre-classified per-module (each retry classified
  // in isolation to avoid `Cannot locate` cross-contamination), use those
  // results directly instead of re-running the global classifier over the
  // merged stdout (which would re-introduce the cross-contamination bug).
  const all = stdout + '\n' + stderr;
  const resolutionFailed = preClassified ? false : /Cannot locate tasks? that match/.test(all);
  const results = preClassified || classifyTaskResults(stdout, stderr, taskList, exit);

  // 2026-05-05 v0.9 step 1 (flags #1 + #2) — `--auto-retry` re-dispatches
  // failed tasks once when leg exited non-zero with at least one task
  // classified `failed`. `--clear-data` (precondition: --auto-retry is set)
  // invokes `adb shell pm clear <pkg>` between attempts. Mutually exclusive
  // with PR5 cascade-isolation: cascade covers eval-phase aborts (every
  // task `no_evidence`), auto-retry covers runtime failures (some task
  // failed). When cascade fired, every task already retried per-module —
  // the `once-more` semantic of --auto-retry is satisfied and this block
  // skips. Gated to androidInstrumented (per BACKLOG L339-340 parity-gap
  // intent — flake source is device-side; pm clear has no JVM analog).
  let retries = [];
  let preRunActions = [];
  if (opts.autoRetry && exit !== 0 && !cascadeDetected
      && testType === 'androidInstrumented') {
    for (let i = 0; i < taskList.length; i++) {
      const task = taskList[i];
      const owner = taskOwners[i];
      if (results.get(task) !== 'failed') continue;
      log(`  [RETRY] ${owner} — re-running after failure`);
      if (opts.clearData && deviceSerial) {
        const pkg = readPackageName(projectRoot, owner);
        if (pkg) {
          log(`  [CLEAR] adb shell pm clear ${pkg}`);
          spawn('adb', ['-s', deviceSerial, 'shell', 'pm', 'clear', pkg], { encoding: 'utf8' });
          preRunActions.push({ module: owner, action: 'pm_clear', package: pkg });
        }
      }
      const r = dispatchLeg({
        spawn, gradlewPath, projectRoot, taskList: [task], testType, opts, env,
        log: (l) => log(`      ${owner}: ${l}`),
        isolatedDir,
      });
      const oneShotMap = classifyTaskResults(r.stdout, r.stderr, [task], r.exit);
      const newStatus = oneShotMap.get(task);
      results.set(task, newStatus);
      retries.push({ module: owner, task, attempt: 2, exit: r.exit, status: newStatus });
    }
    // Recompute leg exit from post-retry results: if no task is still
    // `failed`, flip exit to 0. Otherwise keep the original non-zero exit.
    let stillFailed = false;
    for (const status of results.values()) {
      if (status === 'failed') { stillFailed = true; break; }
    }
    if (!stillFailed) exit = 0;
  }

  // Per-task execution-mode classification was hoisted to step 4a (above the
  // cascade-isolation guard) so the cascade trigger uses the same signal as
  // the envelope's `execution` summary. `execModes` is reused here for the
  // per-task junit-XML stale-guard decision (cache-respecting vs not).
  // v0.9 wet-audit drift #2: surface participating modules as objects (matching
  // the `--list-only` short-circuit shape) instead of bare strings. The map
  // lets us recover the full module metadata (`type`, `coveragePlugin`, etc.)
  // from `modules` (already filtered by applyModuleFilters above) at push
  // time without re-walking project-model.
  const moduleByName = new Map(modules.map(m => [m.name, m]));
  for (let i = 0; i < taskList.length; i++) {
    const task = taskList[i];
    const mod = taskOwners[i];
    const status = results.get(task);
    if (status === 'failed') {
      // WS-1: when gradle aborted at task-graph resolution, every module
      // is doomed (not just the named one). Surface the cause in the banner.
      const suffix = resolutionFailed ? ' (task not found / build aborted at resolution)' : '';
      log(`  [FAIL] ${mod}${suffix}`);
      state.tests.failed += 1;
      state.errors.push({
        code: 'module_failed',
        module: mod,
        task,
        message: `[FAIL] ${mod}${suffix}`,
      });
    } else {
      log(`  [PASS] ${mod}`);
      state.tests.passed += 1;
    }
    state.tests.total += 1;
    // WS-9 + drift #2 — populate modules[] with full object shape (parity
    // with the list-only short-circuit), keyed off `mod` (the module name
    // string from `taskOwners`).
    let entry = state.modules.find(em => em.name === mod);
    if (!entry) {
      entry = canonicalModuleEntry(moduleByName.get(mod) || { name: mod });
      state.modules.push(entry);
    }
    // WS-8 additive: junit-XML walk for individual test count. Stale-XML
    // guard: only count XMLs produced after this run started.
    //
    // F3 fix (2026-05-03): when gradle classified the task as UP-TO-DATE or
    // FROM-CACHE, the existing TEST-*.xml files were intentionally not
    // re-written — gradle confirmed inputs match cached outputs. Their mtime
    // therefore lags `runStartMs` and the guard would false-discard them,
    // dropping `individual_total` to 0 on otherwise-green incremental runs.
    // Disable the guard for those modes only; `no_evidence` (gradle never
    // mentioned the task — EINVAL class) and `fresh` / `failed` keep it on
    // so the original PR #116 protection against bash-wrapper-era leftovers
    // remains intact.
    const execMode = execModes.get(task);
    const cacheRespected = execMode === 'up_to_date' || execMode === 'from_cache';
    const taskTestcaseCount = junitTestCountFor(
      projectRoot,
      task,
      cacheRespected ? 0 : state.runStartMs,
    );
    state.tests.individual_total += taskTestcaseCount;
    // wet-audit-v0.9-part2 BUG-1 — when the task failed, walk JUnit XMLs to
    // populate the module entry's test_failures[] with structured per-test
    // signal. Pre-fix only the `kmp-test android` orchestrator emitted this
    // (via stdout regex on AGP output); the parallel orchestrator surfaced
    // only `errors[].code:'module_failed'` (module-level), forcing agents
    // to walk build/test-results/*/TEST-*.xml on disk.
    //
    // OBS-A from 2026-05-09 wet-audit — when the task failed AND no
    // testcase XML evidence exists (zero failures from junit walk AND
    // zero testcase count), the failure happened pre-test (compile,
    // plugin error, classpath, runner setup, etc.). Mark the
    // module_failed entry with `setup_failed: true` so agents can
    // discriminate "test ran and failed" from "test never ran". Pre-fix
    // both shapes surfaced as plain `module_failed` with an empty
    // `test_failures[]`, indistinguishable.
    if (status === 'failed') {
      const failures = junitTestFailuresFor(
        projectRoot,
        task,
        cacheRespected ? 0 : state.runStartMs,
      );
      if (failures.length > 0) {
        entry.test_failures = (entry.test_failures || []).concat(failures);
      } else if (taskTestcaseCount === 0) {
        const errEntry = state.errors.find(e =>
          e && e.code === 'module_failed'
          && e.module === mod && e.task === task);
        if (errEntry) errEntry.setup_failed = true;
      }
    }
  }

  // fix-PR-E (2026-05-04): align execSummary.failed with classifyTaskResults
  // (the same source feeding [FAIL]-line emission at line 836 and module_failed
  // entries in errors[]). K/N native test tasks (`macosArm64Test`, `iosX/Sim/
  // ArmTest`) and AGP instrumented tasks (`connectedAndroidDeviceTest`,
  // `androidConnectedCheck`, `connectedDebug/ReleaseAndroidTest`) emit FAILED
  // suffix lines that classifyTaskExecutionMode's strict-EOL regex misses;
  // classifyTaskResults catches them via its non-anchored primary regex +
  // defense-in-depth path. Realigning here keeps the OS-parity invariant:
  // execSummary.failed === errors.filter(c='module_failed').length per leg.
  // Total bucket count is preserved: tasks promoted to `failed` are removed
  // from their original bucket. Repro envelopes: a private KMP project Mac `macos`
  // leg + a multi-module DI sample `androidInstrumented` leg (.smoke/pass-9/).
  const failedTasks = new Set();
  for (const [task, status] of results) {
    if (status === 'failed') failedTasks.add(task);
  }
  if (failedTasks.size !== execSummary.failed) {
    const aligned = {
      fresh: 0, up_to_date: 0, from_cache: 0, no_source: 0,
      skipped_by_gradle: 0, failed: 0, no_evidence: 0,
    };
    for (const [task, mode] of execModes) {
      if (failedTasks.has(task)) {
        aligned.failed++;
      } else if (mode in aligned) {
        aligned[mode]++;
      }
    }
    execSummary = aligned;
  }

  return {
    stdout, stderr, exit, execution: execSummary, cascadeDetected, retryFired,
    // 2026-05-05 v0.9 step 1 (flags #1 + #2) — surface auto-retry telemetry
    // up to runParallel so legResults can carry per-leg retries + pre-run
    // actions. Empty arrays (not undefined) keep the envelope shape stable.
    retries, preRunActions,
  };
}

// ---------------------------------------------------------------------------
// In-process coverage call (closes the subprocess hop)
// ---------------------------------------------------------------------------
async function runCoverageInProcess(projectRoot, opts, env, log, runCoverageInjection) {
  // Allow vitest to inject a stubbed runCoverage to avoid spawning python3.
  let runCoverage = runCoverageInjection;
  if (!runCoverage) {
    const mod = await import('./coverage-orchestrator.js');
    runCoverage = mod.runCoverage;
  }
  const coverageArgs = ['--coverage-tool', opts.coverageTool || 'auto'];
  if (opts.coverageModules) coverageArgs.push('--coverage-modules', opts.coverageModules);
  if (opts.excludeCoverage) coverageArgs.push('--exclude-coverage', opts.excludeCoverage);
  if (opts.minMissedLines)  coverageArgs.push('--min-missed-lines', String(opts.minMissedLines));
  if (opts.outputFile && opts.outputFile !== 'coverage-full-report.md') {
    coverageArgs.push('--output-file', opts.outputFile);
  }
  const { envelope } = await runCoverage({
    projectRoot,
    args: coverageArgs,
    env,
    log,
  });
  // wet-audit-v0.9-part2 BUG-2 — surface coverage envelope errors[] (e.g.
  // `coverage_threshold_exceeded` from --min-missed-lines gate) so the caller
  // can propagate them to the parallel envelope. Pre-fix this dropped the
  // gate signal silently.
  return {
    coverage: envelope.coverage || null,
    errors: Array.isArray(envelope.errors) ? envelope.errors : [],
  };
}

// ---------------------------------------------------------------------------
// Main entrypoint — invoked by lib/runner.js when sub === 'parallel'.
// ---------------------------------------------------------------------------
export async function runParallel({
  projectRoot,
  args = [],
  env = process.env,
  config = null,
  spawn = spawnSync,
  log = () => {},
  runId = defaultRunId(),
  // Test-only overrides (not exposed to callers in production).
  runCoverageInjection = null,
  runBenchmarkInjection = null,
  adbProbe = defaultAdbProbe,
}) {
  const startTime = Date.now();

  // v0.9 step 4 — strip + parse `--isolated*` flags BEFORE parseArgs so the
  // existing default-drop case doesn't have to know about them.
  const isolatedFlags = parseIsolatedArgs(args);
  const opts = parseArgs(isolatedFlags.args);

  // v0.9 session 2 Bug-B/Bug-D — exit 2 BEFORE gradle work when parseArgs
  // collected validation errors. Mirrors EXIT.CONFIG_ERROR contract: bad
  // CLI input is a usage error, not an environment failure.
  const invalidArgs = opts.errors.filter(e => e.code && e.code.startsWith('invalid_'));
  if (invalidArgs.length > 0) {
    const envelope = buildInvalidArgsEnvelope({
      subcommand: 'parallel',
      projectRoot,
      durationMs: Date.now() - startTime,
      errors: invalidArgs,
    });
    return { envelope, exitCode: EXIT.CONFIG_ERROR };
  }

  // wet-audit-v0.9-part2 OBS-4 — `--isolated` isolates Gradle's
  // `--project-cache-dir` and lockfile, but does NOT protect against
  // shared runtime resources: iOS simulator (only one booted sim per
  // host), ADB daemon serialization (single device targeted by N
  // processes), system-wide Konan caches. Combining `--isolated` with
  // test types that hit those shared resources produces non-determinism
  // (concurrent runs interfere with each other). Reject early with a
  // structured CONFIG_ERROR so users / agents discover the limitation
  // before paying the gradle cost.
  //
  // Reject:
  //   - `--isolated --test-type ios`   (sim is shared regardless)
  //   - `--isolated --test-type all`   (expands to include ios + androidInstrumented)
  //   - `--isolated --test-type androidInstrumented` WITHOUT `--device <serial>`
  //     (ADB requires a serial to target distinct devices)
  // Allow (safe — no shared runtime resources between processes):
  //   - jvm / desktop / macos (Konan macos host-native; gradle parallel-
  //     handles per-task isolation), common, androidUnit (no device).
  //   - androidInstrumented WITH --device <serial>  (caller asserts each
  //     concurrent process targets its own device).
  if (isolatedFlags.enabled) {
    const ttype = opts.testType || '';
    let rejectReason = null;
    if (ttype === 'ios') {
      rejectReason = '--isolated does not protect against iOS simulator races (shared host-wide). ' +
        'Run sequentially without --isolated, or split iOS runs across separate hosts.';
    } else if (ttype === 'all') {
      rejectReason = '--isolated --test-type all is unsafe: the iOS leg races on the simulator. ' +
        'Use --isolated with a single safe test-type (jvm/desktop/macos/androidUnit/common), ' +
        'or run --test-type all sequentially without --isolated.';
    } else if (ttype === 'androidInstrumented' && !opts.device) {
      rejectReason = '--isolated --test-type androidInstrumented requires --device <serial> to ' +
        'target distinct devices per concurrent process. Without --device, all processes target ' +
        'the same default device and race on ADB / app-install state.';
    }
    if (rejectReason) {
      const envelope = buildInvalidArgsEnvelope({
        subcommand: 'parallel',
        projectRoot,
        durationMs: Date.now() - startTime,
        errors: [{
          code: 'isolated_runtime_race',
          message: rejectReason,
          test_type: ttype,
        }],
      });
      return { envelope, exitCode: EXIT.CONFIG_ERROR };
    }
  }

  // ---------------------------------------------------------------
  // 1. --skip-tests early delegate to coverage-orchestrator.
  //    Collapses `coverage = parallel --skip-tests` into Node and
  //    removes the last subprocess hop for `kmp-test coverage` callers
  //    that arrive via the parallel entrypoint.
  //
  //    Routed BEFORE resolveIsolatedDir's mkdir so `--skip-tests --isolated`
  //    doesn't leave an orphan cache dir behind (coverage reads pre-existing
  //    XML files; no gradle spawn means no use for --project-cache-dir).
  //    coverage-orchestrator silently ignores --isolated by design.
  // ---------------------------------------------------------------
  if (opts.skipTests) {
    const { runCoverage } = runCoverageInjection
      ? { runCoverage: runCoverageInjection }
      : await import('./coverage-orchestrator.js');
    return runCoverage({ projectRoot, args, env, spawn, log, runId });
  }

  // v0.9 step 4 — resolve the isolated cache dir AFTER --skip-tests routes
  // out. dryRun:opts.dryRun keeps `--isolated --dry-run` from leaving an
  // empty cache dir behind. Cleanup runs at every return site below.
  const isolatedDir = resolveIsolatedDir(projectRoot, {
    enabled: isolatedFlags.enabled,
    cacheDir: isolatedFlags.cacheDir,
    dryRun: opts.dryRun,
  });
  const isolatedUserSupplied = isolatedFlags.cacheDir !== null;
  const isolatedKept = isolatedFlags.enabled
    && shouldKeepIsolated({ userSupplied: isolatedUserSupplied, env });
  const isolatedField = buildIsolatedField({
    enabled: isolatedFlags.enabled,
    cacheDir: isolatedDir,
    kept: isolatedKept,
    locked: !isolatedFlags.noLock,
  });

  // ---------------------------------------------------------------
  // 2. Banner
  // ---------------------------------------------------------------
  log('');
  log('========================================');
  log('  Parallel Test Suite');
  log('========================================');
  log(`Project: ${projectRoot}`);
  log(`Test Type: ${opts.testType || '(auto)'}`);
  log(`Module filter: ${opts.moduleFilter}`);
  log('');

  // ---------------------------------------------------------------
  // 3. Platform precondition (NEW: platform_unsupported discriminator).
  //    --test-type ios|macos requires a macOS host. Per PRODUCT.md
  //    "platform-aware behavior": fail clearly with a structured code,
  //    do NOT silently dispatch (gradle would fail with cryptic error).
  // ---------------------------------------------------------------
  if ((opts.testType === 'ios' || opts.testType === 'macos') && process.platform !== 'darwin') {
    const msg = `--test-type ${opts.testType} requires macOS host (current platform: ${process.platform})`;
    log(`[ERROR] ${msg}`);
    const envelope = envErrorJson({
      subcommand: 'parallel',
      projectRoot,
      durationMs: Date.now() - startTime,
      message: msg,
      code: 'platform_unsupported',
      extra: { test_type: opts.testType, platform: process.platform },
    });
    envelope.isolated = isolatedField;
    if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });
    return { envelope, exitCode: EXIT.ENV_ERROR };
  }

  // ---------------------------------------------------------------
  // 4. --dry-run short-circuit (no model build, no gradle, no XML reads).
  // ---------------------------------------------------------------
  if (opts.dryRun) {
    const envelope = buildDryRunReport({
      subcommand: 'parallel',
      projectRoot,
      plan: {
        test_type: opts.testType || 'auto',
        module_filter: opts.moduleFilter,
        max_workers: opts.maxWorkers,
        coverage_tool: opts.coverageTool,
        timeout_s: opts.timeout,
        legs: opts.testType === 'all' ? legsForAll(env) : [opts.testType || 'auto'],
      },
    });
    envelope.isolated = isolatedField;
    return { envelope, exitCode: EXIT.SUCCESS };
  }

  // ---------------------------------------------------------------
  // 4b. --fresh-daemon: stop existing gradle daemons before dispatch.
  //     Mirrors the legacy wrapper's `gradlew --stop` step.
  // ---------------------------------------------------------------
  if (opts.freshDaemon) {
    log('[~] --fresh-daemon: stopping existing gradle daemons...');
    const isWin = process.platform === 'win32';
    const gradlewPath = path.join(projectRoot, isWin ? 'gradlew.bat' : 'gradlew');
    spawnGradle(spawn, gradlewPath, ['--stop'], { cwd: projectRoot, encoding: 'utf8', env: { ...env } });
  }

  // ---------------------------------------------------------------
  // 5. Build project model (single source of truth for module discovery).
  // ---------------------------------------------------------------
  let projectModel = null;
  try {
    projectModel = buildProjectModel(projectRoot, {
      skipProbe: false,
      useCache: false,
      probeTimeoutMs: parseGradleTimeoutMs(env.KMP_GRADLE_TIMEOUT_MS),
    });
  } catch { /* model is best-effort; orchestrator falls through to empty discovery */ }

  // ---------------------------------------------------------------
  // 6. Discover + filter modules.
  // ---------------------------------------------------------------
  const allModules = discoverParallelModules(projectModel);
  let { kept: modules, skipped: filterSkipped } = applyModuleFilters(allModules, opts, env);

  // --coverage-only: keep only modules listed in --coverage-modules (match by
  // exact name or `:name` suffix, mirrors the legacy bash CORE_ONLY_MODULES
  // semantics from scripts/sh/run-parallel-coverage-suite.sh:519-540).
  if (opts.coverageOnly && opts.coverageModules) {
    const coreList = splitCsv(opts.coverageModules);
    const isCore = (name) => coreList.some(c => name === c || name.endsWith(':' + c));
    const before = modules.length;
    modules = modules.filter(m => isCore(m.name));
    if (modules.length < before) {
      log(`[>] Coverage-only mode: filtering to ${modules.length} core module(s)`);
    }
  }

  // ---------------------------------------------------------------
  // 7. State accumulator (single envelope across all legs).
  // ---------------------------------------------------------------
  // v0.9 step 9.5 (Bug #5) — coverage envelope shape parity with android +
  // coverage orchestrators. Pre-fix `state.coverage` was {tool, missed_lines}
  // only; post-fix it carries the kover/jacoco module lists so agents can
  // pivot on coverage_plugin assignment without a separate `describe` call.
  // Populated below from `modules` (each carries `coveragePlugin` from the
  // project model — see discoverParallelModules).
  const koverModules = modules.filter(m => m.coveragePlugin === 'kover').map(m => m.name);
  const jacocoModules = modules.filter(m => m.coveragePlugin === 'jacoco').map(m => m.name);
  const state = {
    tests: { total: 0, passed: 0, failed: 0, skipped: 0, individual_total: 0 },
    modules: [],
    skipped: [],
    coverage: {
      tool: opts.coverageTool,
      missed_lines: null,
      modules_with_kover_plugin: koverModules,
      modules_with_jacoco_plugin: jacocoModules,
    },
    errors: [],
    warnings: [],
    // Used by junitTestCountFor to filter out stale XMLs from prior runs.
    runStartMs: Date.now(),
  };
  // Surface filter-time skips (--exclude-modules + auto-skip-untested) in
  // the envelope. Banner prints them in legacy [SKIP] format for humans.
  for (const sk of filterSkipped) {
    log(`  [SKIP] ${sk.module} (${sk.reason})`);
    state.skipped.push(sk);
  }

  // wet-audit-v0.9-part2 OBS-7 — `--flavor <name>` against a project where
  // no module declares productFlavors {} now hard-fails as CONFIG_ERROR (2)
  // instead of emitting a soft warning. Pre-fix (v0.9 step 1, flag #4) the
  // misconfiguration surfaced as `warnings[].code:'flavor_unused'` + exit 0,
  // which CI gates routinely missed; user typos in the flavor name silently
  // ran the default-flavor task. Hard-fail makes the contract explicit:
  // if you supply --flavor, you commit to the project actually having
  // flavors.
  // Fires for any androidInstrumented-touching test type (single + 'all')
  // and runs before any gradle dispatch so we don't waste a build cycle.
  //
  // OBS-B (2026-05-09 wet-audit follow-up) — early-return now matches the
  // comment intent. Pre-fix the error was pushed to state.errors but
  // execution continued to gradle dispatch (~66s real wall on a private project).
  // Mirrors the no_test_modules short-circuit shape below.
  const flavorAffectsLeg = opts.testType === 'androidInstrumented'
    || opts.testType === 'all';
  if (opts.flavor && flavorAffectsLeg
      && !modules.some(m => m.hasFlavor)) {
    state.errors.push({
      code: 'flavor_unused',
      message: `--flavor "${opts.flavor}" supplied but no discovered module declares productFlavors {} (CLI usage error). Remove --flavor or run against a project that declares productFlavors.`,
      flavor: opts.flavor,
    });
    // Surface the discovered modules on the envelope so agents can see
    // what the leg WOULD have dispatched against had --flavor been
    // valid (vs. the no_test_modules early-exit which has 0 modules
    // by definition).
    state.modules = modules.map(canonicalModuleEntry);
    const envelope = buildJsonReport({
      subcommand: 'parallel',
      projectRoot,
      exitCode: EXIT.CONFIG_ERROR,
      durationMs: Date.now() - startTime,
      parsed: state,
    });
    envelope.isolated = isolatedField;
    if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });
    return { envelope, exitCode: EXIT.CONFIG_ERROR };
  }

  // Module-count zero — short-circuit. UX-2: when the user explicitly asked
  // for a --test-type AND --module-filter is the default `*` AND no
  // --exclude-modules was supplied, the cause is the test-type rejecting
  // every module — say so.
  if (modules.length === 0) {
    // wet-audit-v0.9-part2 OBS-3 — discriminate user-filter-miss
    // (CONFIG_ERROR 2) from project-empty (ENV_ERROR 3 preserved).
    const causedByFilter = (opts.moduleFilter && opts.moduleFilter !== '*')
      || !!opts.excludeModules;
    let message;
    if (opts.moduleFilter === '*' && opts.testTypeExplicit && !opts.excludeModules) {
      message = `[ERROR] No modules support the requested --test-type=${opts.testType}`;
    } else {
      message = `[ERROR] No modules found matching filter: ${opts.moduleFilter}`;
    }
    log(message);
    state.errors.push({
      code: 'no_test_modules',
      message: message.replace(/^\[ERROR\] /, ''),
      test_type: opts.testType || '',
      caused_by_filter: causedByFilter,
    });
    const earlyExit = causedByFilter ? EXIT.CONFIG_ERROR : EXIT.ENV_ERROR;
    const envelope = buildJsonReport({
      subcommand: 'parallel',
      projectRoot,
      exitCode: earlyExit,
      durationMs: Date.now() - startTime,
      parsed: state,
    });
    envelope.isolated = isolatedField;
    if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });
    return { envelope, exitCode: earlyExit };
  }

  // v0.9 step 9.8 — --list-only short-circuit. Mirrors android-orchestrator's
  // shape: emit the discovered/filtered module set on `modules[]`, include
  // filter-time skips on `skipped[]`, populate the coverage block, and exit
  // before any gradle dispatch. Designed for agents that need to enumerate
  // the leg's effective module set without paying the gradle cost. Differs
  // from `--dry-run`: dry-run surfaces the resolved spawn command but
  // doesn't compute the post-filter module set.
  if (opts.listOnly) {
    log('');
    log(`Parallel modules (${modules.length}):`);
    for (const m of modules) log(`  - ${m.name}`);
    log('');
    const listOnlyState = {
      ...state,
      modules: modules.map(canonicalModuleEntry),
      parallel: {
        test_type: opts.testType || 'auto',
        list_only: true,
        legs: [],
        max_workers: opts.maxWorkers,
        timeout_s: opts.timeout,
      },
    };
    const envelope = buildJsonReport({
      subcommand: 'parallel',
      projectRoot,
      exitCode: EXIT.SUCCESS,
      durationMs: Date.now() - startTime,
      parsed: listOnlyState,
    });
    envelope.isolated = isolatedField;
    if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });
    return { envelope, exitCode: EXIT.SUCCESS };
  }

  // ---------------------------------------------------------------
  // 8. Determine which legs to run.
  //    --test-type all → multiple legs (closes WS-6).
  //    Anything else → single leg.
  // ---------------------------------------------------------------
  const legs = opts.testType === 'all' ? legsForAll(env) : [opts.testType || ''];

  // ---------------------------------------------------------------
  // 9. Per-leg execution (single gradle invocation per leg).
  // ---------------------------------------------------------------
  const isWindows = process.platform === 'win32';
  const gradlewPath = path.join(projectRoot, isWindows ? 'gradlew.bat' : 'gradlew');

  // 2026-05-03 — Auto-set ANDROID_HOME when (a) any discovered module is
  // Android-typed, (b) ANDROID_HOME isn't already set, (c) project doesn't
  // supply sdk.dir via local.properties, AND (d) we find a real SDK on disk
  // at the canonical install path. Repro: Confetti / PeopleInSpace freshly
  // downloaded (local.properties gitignored) with `:androidApp` modules —
  // gradle aborted with `SDK location not found`. The user already has the
  // SDK installed; auto-set is the right UX.
  const hasAndroidModule = modules.some(m => m.type === 'android' || !!m.androidDsl);
  let dispatchEnv = env;
  if (hasAndroidModule) {
    dispatchEnv = maybeAugmentEnvWithAndroidSdk(projectRoot, env, log);
  }

  // 2026-05-05 v0.9 step 1 (flags #1 + #3) — `--device <serial>` validates
  // against adb output and injects ANDROID_SERIAL into the dispatch env (AGP
  // + AndroidJUnitRunner read it to pin instrumentation to that device).
  // `--clear-data` (#1) also needs a serial for `adb shell pm clear` and
  // probes adb best-effort when `--device` wasn't supplied — picks the first
  // connected device, mirroring `kmp-test android` default. Mirrors
  // `lib/android-orchestrator.js:378-402` validation shape but only probes
  // when at least one of the two flags was supplied — no behavior change
  // otherwise. Validation runs once before the leg loop; failure aborts
  // before any gradle work (mirrors instrumented_setup_failed contract).
  // 2026-05-09 wet-audit envelope-parity fix — when the leg set includes
  // androidInstrumented we ALWAYS probe adb (best-effort) so the
  // envelope's `android.device_serial` is populated. Pre-fix only the
  // strict paths (`--device` or `--clear-data`) probed; envelope reported
  // `device_serial:''` for plain `parallel --test-type androidInstrumented`
  // even with a device connected — paridad gap with `kmp-test android`
  // (which always probes). Strict validation for `--device` /
  // `--clear-data` keeps the existing fail-fast contract.
  const hasInstrumentedLeg = legs.includes('androidInstrumented');
  const wantsAdbStrict = (opts.device || opts.clearData) && hasInstrumentedLeg;
  let resolvedDeviceSerial = '';
  if (hasInstrumentedLeg) {
    const devices = adbProbe();
    const haveDevices = devices && devices.length > 0;

    if (wantsAdbStrict && !haveDevices) {
      if (opts.device) {
        const msg = `Requested device "${opts.device}" but no adb devices connected.`;
        log(`[ERROR] ${msg}`);
        state.errors.push({
          code: 'instrumented_setup_failed',
          message: msg,
          device: opts.device,
        });
        const envelope = buildJsonReport({
          subcommand: 'parallel',
          projectRoot,
          exitCode: EXIT.ENV_ERROR,
          durationMs: Date.now() - startTime,
          parsed: state,
        });
        return { envelope, exitCode: EXIT.ENV_ERROR };
      }
      // --clear-data alone with no devices → warn and proceed without
      // pm clear hook (gradle dispatch will fail with its own error if no
      // device is reachable; we don't pre-fail here).
      log('[WARN] --clear-data: no adb devices connected, pm clear will be skipped');
      state.warnings.push({
        code: 'clear_data_no_device',
        message: '--clear-data requested but no adb devices connected; pm clear hook skipped',
      });
    } else if (haveDevices) {
      if (opts.device) {
        const match = devices.find(d => d.serial === opts.device);
        if (!match) {
          const msg = `Requested device "${opts.device}" not found in adb devices output. Available: ${devices.map(d => d.serial).join(', ') || '(none)'}.`;
          log(`[ERROR] ${msg}`);
          state.errors.push({
            code: 'instrumented_setup_failed',
            message: msg,
            device: opts.device,
          });
          const envelope = buildJsonReport({
            subcommand: 'parallel',
            projectRoot,
            exitCode: EXIT.ENV_ERROR,
            durationMs: Date.now() - startTime,
            parsed: state,
          });
          return { envelope, exitCode: EXIT.ENV_ERROR };
        }
        resolvedDeviceSerial = match.serial;
        dispatchEnv = { ...dispatchEnv, ANDROID_SERIAL: resolvedDeviceSerial };
        log(`Device: ${resolvedDeviceSerial}`);
      } else if (opts.clearData) {
        // --clear-data only — pick first device, no ANDROID_SERIAL injection
        // (user didn't pin; let gradle pick its default).
        resolvedDeviceSerial = devices[0].serial;
        log(`Device (auto-selected for --clear-data): ${resolvedDeviceSerial}`);
      } else {
        // No --device, no --clear-data, but instrumented leg present:
        // best-effort surface for envelope only. Pick first device
        // (gradle's typical default). Don't inject ANDROID_SERIAL —
        // gradle picks its own.
        resolvedDeviceSerial = devices[0].serial;
        log(`Device (auto-detected, gradle's default): ${resolvedDeviceSerial}`);
      }
    }
    // !haveDevices && !wantsAdbStrict: keep resolvedDeviceSerial='' silently.
    // gradle will surface its own error if a device is actually needed.
  }

  let allStdout = '';
  let allStderr = '';
  const legResults = [];

  for (const leg of legs) {
    log('');
    log(`---- Leg: ${leg || 'auto'} ----`);
    const r = await executeLeg({
      spawn, gradlewPath, projectRoot, modules, testType: leg, opts, env: dispatchEnv, config, log,
      state, runCoverageInjection, deviceSerial: resolvedDeviceSerial, isolatedDir,
    });
    allStdout += r.stdout + '\n';
    allStderr += r.stderr + '\n';
    const legEntry = {
      test_type: leg || 'auto',
      exit_code: r.exit,
      execution: r.execution || {
        fresh: 0, up_to_date: 0, from_cache: 0, no_source: 0,
        skipped_by_gradle: 0, failed: 0, no_evidence: 0,
      },
      // PR5 (2026-05-04): expose orchestrator-side cascade detection +
      // per-module retry decision so downstream consumers (pass-N sweeps,
      // dashboards, AI agents) can branch on the orchestrator's verdict
      // directly instead of re-deriving the signature from `execution`.
      cascade_detected: r.cascadeDetected || false,
      retry_fired: r.retryFired || false,
    };
    // 2026-05-05 v0.9 step 1 (flag #3) — surface resolved device.serial on
    // androidInstrumented legs when --device was supplied. Field absent on
    // other legs (clean envelope; agents branch on field presence).
    if (leg === 'androidInstrumented' && resolvedDeviceSerial) {
      legEntry.device = { serial: resolvedDeviceSerial };
    }
    // 2026-05-05 v0.9 step 1 (flags #1 + #2) — surface auto-retry telemetry.
    // Both fields are arrays; empty when --auto-retry / --clear-data not
    // active or no failures occurred. Stable shape across leg types.
    if (r.retries && r.retries.length > 0) {
      legEntry.retries = r.retries;
    }
    if (r.preRunActions && r.preRunActions.length > 0) {
      legEntry.pre_run_actions = r.preRunActions;
    }
    legResults.push(legEntry);
  }

  // ---------------------------------------------------------------
  // 9b. F2: Demote per-leg `no_test_modules` errors to warnings when
  //     another leg in a multi-leg dispatch produced test results.
  //     `--test-type all` runs N legs; some legs may have zero matching
  //     modules (e.g., a JVM-only project's `ios` leg) — that's expected,
  //     not an environmental failure. Pre-fix, ANY per-leg empty forced
  //     exit 3 even when other legs passed cleanly.
  // ---------------------------------------------------------------
  if (opts.testType === 'all' && legResults.length > 1 && state.tests.passed > 0) {
    const demoted = [];
    state.errors = state.errors.filter(e => {
      if (e && e.code === 'no_test_modules' && e.test_type && e.test_type !== 'all') {
        demoted.push(e);
        return false;
      }
      return true;
    });
    for (const e of demoted) {
      state.warnings.push({
        code: 'no_test_modules_for_leg',
        message: `Leg '${e.test_type}': ${e.message}`,
        test_type: e.test_type,
      });
    }
  }

  // ---------------------------------------------------------------
  // 10. Discriminator pass — upgrade gradle errors to canonical codes.
  // ---------------------------------------------------------------
  applyErrorCodeDiscriminators(allStdout, allStderr, state);

  // ---------------------------------------------------------------
  // 11. In-process coverage call (replaces subprocess hop).
  //     Skipped when --no-coverage / --coverage-tool none.
  // ---------------------------------------------------------------
  if (opts.coverageTool !== 'none') {
    try {
      const cov = await runCoverageInProcess(projectRoot, opts, env, log, runCoverageInjection);
      if (cov && cov.coverage) state.coverage = cov.coverage;
      // wet-audit-v0.9-part2 BUG-2 — propagate coverage envelope errors
      // (notably `coverage_threshold_exceeded`) to the parallel envelope so
      // the exit-code dispatch at step 12 promotes to TEST_FAIL.
      if (cov && cov.errors && cov.errors.length > 0) {
        for (const err of cov.errors) state.errors.push(err);
      }
    } catch (e) {
      state.warnings.push({
        code: 'coverage_aggregation_failed',
        message: `Coverage aggregation threw: ${e?.message || e}`,
      });
    }
  } else {
    state.warnings.push({
      code: 'coverage_aggregation_skipped',
      message: '--coverage-tool none: coverage aggregation skipped',
    });
  }

  // ---------------------------------------------------------------
  // 11b. Optional benchmark execution. Mirrors legacy wrapper's
  //      `if BENCHMARK; then run-benchmarks.sh ...` step (lines 1684-1692).
  //      Benchmark failures are non-fatal — surfaced as warning, never
  //      change exit code (legacy wrapper's `|| warn` shape).
  // ---------------------------------------------------------------
  if (opts.benchmark) {
    log('');
    log(`[>] Running benchmarks (config: ${opts.benchmarkConfig})...`);
    try {
      let runBenchmark = runBenchmarkInjection;
      if (!runBenchmark) {
        const mod = await import('./benchmark-orchestrator.js');
        runBenchmark = mod.runBenchmark;
      }
      const benchArgs = ['--config', opts.benchmarkConfig];
      if (opts.includeShared) benchArgs.push('--include-shared');
      const benchResult = await runBenchmark({
        projectRoot, args: benchArgs, env, spawn, log,
      });
      if (benchResult?.exitCode && benchResult.exitCode !== 0) {
        state.warnings.push({
          code: 'benchmark_failed',
          message: `Benchmark execution had failures (exit ${benchResult.exitCode})`,
        });
      }
    } catch (e) {
      state.warnings.push({
        code: 'benchmark_failed',
        message: `Benchmark execution threw: ${e?.message || e}`,
      });
    }
  }

  // ---------------------------------------------------------------
  // 12. Build envelope with parallel:{} top-level field.
  //     Exit code policy (in priority order — first match wins):
  //     - CONFIG_ERROR (2) for CLI usage errors: flavor_unused (user
  //       supplied --flavor against a project with no productFlavors).
  //     - ENV_ERROR (3) for environmental failures: no_test_modules,
  //       platform_unsupported, instrumented_setup_failed (mirrors legacy
  //       wrapper's exit 3 path).
  //     - TEST_FAIL (1) for module_failed / any test failure.
  //     - SUCCESS (0) otherwise.
  // ---------------------------------------------------------------
  // wet-audit-v0.9-part2 OBS-7 — `flavor_unused` is a USAGE error: user
  // typed --flavor but the discovered modules don't support flavors.
  // CONFIG_ERROR (2) takes precedence over ENV/TEST so CI gates fail fast
  // on the typo without spawning gradle.
  const CONFIG_CODES = new Set(['flavor_unused']);
  // wet-audit-v0.9-part2 OBS-3 — `no_test_modules` with `caused_by_filter:
  // true` is also a CONFIG_ERROR (user supplied a filter that matched
  // nothing). With `caused_by_filter:false` (project genuinely has no
  // modules supporting the test-type) it stays ENV_ERROR per the legacy
  // wrapper contract.
  const hasConfigError = state.errors.some(e =>
    e && (CONFIG_CODES.has(e.code)
      || (e.code === 'no_test_modules' && e.caused_by_filter === true)));
  // ENV_ERROR (3) reserved for cases where the test harness can't even
  // attempt to execute: no modules to dispatch (project-empty path),
  // host platform mismatch, adb/instrumented setup failed.
  const ENV_CODES = new Set(['no_test_modules', 'platform_unsupported',
    'instrumented_setup_failed']);
  const hasEnvError = state.errors.some(e => e && ENV_CODES.has(e.code)
    // OBS-3 — exclude filter-caused empties from ENV; they're CONFIG above.
    && !(e.code === 'no_test_modules' && e.caused_by_filter === true));
  const hasTestFailure = state.tests.failed > 0
    || state.errors.some(e => e && (e.code === 'module_failed'
        || e.code === 'task_not_found'
        || e.code === 'unsupported_class_version'
        // wet-audit-v0.9-part2 BUG-2 — coverage gate breach is a test-fail
        // class signal (the run produced more uncovered lines than the
        // configured threshold). Promotes envelope to exit 1.
        || e.code === 'coverage_threshold_exceeded'));
  let exitCode = EXIT.SUCCESS;
  if (hasConfigError)      exitCode = EXIT.CONFIG_ERROR;
  else if (hasEnvError)    exitCode = EXIT.ENV_ERROR;
  else if (hasTestFailure) exitCode = EXIT.TEST_FAIL;
  const parsed = {
    tests: state.tests,
    modules: state.modules,
    skipped: state.skipped,
    coverage: state.coverage,
    errors: state.errors,
    warnings: state.warnings,
    parallel: {
      test_type: opts.testType || 'auto',
      legs: legResults,
      max_workers: opts.maxWorkers,
      timeout_s: opts.timeout,
    },
    isolated: isolatedField,
  };
  // v0.9 wet-audit drift #3: surface `android:{device_serial}` when the
  // leg set includes androidInstrumented. Mirrors `kmp-test android`'s
  // top-level `android:{}` block so agents can pivot on the device serial
  // without branching by subcommand. `individual_total` is already tracked
  // in `state.tests.individual_total` (WS-8) and surfaces via parsed.tests.
  const dispatchedAndroidInstrumented = legResults.some(
    l => l.test_type === 'androidInstrumented'
  );
  if (dispatchedAndroidInstrumented) {
    parsed.android = {
      device_serial: resolvedDeviceSerial || '',
      device_task: opts.deviceTaskOverride || '',
      flavor: opts.flavor || '',
    };
  }
  const envelope = buildJsonReport({
    subcommand: 'parallel',
    projectRoot,
    exitCode,
    durationMs: Date.now() - startTime,
    parsed,
  });

  // v0.9 step 4 — cleanup the isolated cache dir on the way out (no-op when
  // --isolated wasn't enabled or the policy says keep). Best-effort: errors
  // are swallowed so a transient FS issue doesn't fail an otherwise-green run.
  if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });

  return { envelope, exitCode };
}

export {
  parseArgs,
  expandNoCoverageAlias,
  splitCsv,
  globToRegex,
  matchAnyGlob,
  discoverParallelModules,
  hasAnyTestSourceSet,
  applyModuleFilters,
  partitionBySkipEnv,
  pickGradleTaskFor,
  legsForAll,
  junitTestCountFor,
  junitTestFailuresFor,
  extractTestcaseFailures,
  classifyTaskResults,
  defaultRunId,
  buildFilterArgs,
  canonicalModuleEntry,
};

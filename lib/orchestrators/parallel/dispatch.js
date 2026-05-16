// SPDX-License-Identifier: MIT
// lib/orchestrators/parallel/dispatch.js — PR-10 extraction from
// lib/parallel-orchestrator.js (refactor pre-v0.10). Owns: argv parsing,
// module discovery + filtering, gradle-task resolution per (module, test-type),
// per-leg gradle dispatch primitive. Pure file-move from the parent orchestrator
// (no behavior change). Re-exported back to lib/parallel-orchestrator.js for
// back-compat with tests + lib/parsers/script-output.js + lib/runner.js.

import {
  resolveAndroidTestFilter,
  splitClassMethod,
} from '../../cli.js';
import {
  spawnGradle,
  splitCsv,
  matchModuleFilter,
  validateEnum,
  validateNonNegativeInt,
  injectProjectCacheDir,
  splitGradleArgs,
  expandNoCoverageAlias,
} from '../orchestrator-utils.js';
import { TEST_TYPE_VALUES, COVERAGE_TOOL_VALUES } from '../../parsers/argv-constants.js';

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
      case '--gradle-args':
        out.gradleArgs.push(...splitGradleArgs(expanded[++i]));
        break;
      default: /* unknown — drop, runner.js already stripped globals */ break;
    }
  }
  return out;
}

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
  // v0.10 #2 — drop the unconditional `--parallel` when the orchestrator
  // resolved `org.gradle.parallel=false` from the project's gradle.properties.
  // User-supplied `--gradle-args "--parallel"` is appended LAST below and wins
  // via gradle's last-wins flag semantics.
  let gradleArgs = [...taskList, ...(opts.parallelDropped ? ['--continue'] : ['--parallel', '--continue'])];
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

export {
  parseArgs,
  expandNoCoverageAlias,
  discoverParallelModules,
  hasAnyTestSourceSet,
  applyModuleFilters,
  partitionBySkipEnv,
  canonicalModuleEntry,
  pickGradleTaskFor,
  legsForAll,
  buildFilterArgs,
  dispatchLeg,
};

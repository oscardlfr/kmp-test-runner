// SPDX-License-Identifier: MIT
// lib/android-orchestrator.js — Node-side `kmp-test android` orchestrator
// (v0.8 PIVOT, sub-entry 3). Replaces scripts/sh/run-android-tests.sh
// (784 LOC) + scripts/ps1/run-android-tests.ps1 (649 LOC) — together
// 1,433 LOC of bash/ps1 with three disagreeing module-detection paths
// (WS-3) and an empty-name renderer in --list-only (WS-10).
//
// The new orchestrator consolidates module discovery through
// lib/project-model.js#resolveTasksFor.deviceTestTask — the same source
// `parallel --test-type androidInstrumented` uses. WS-3 + WS-10 are
// closed by construction:
//   WS-3:  kmp-test android sees the SAME modules as parallel
//   WS-10: --list-only renders names from the SAME array the count derives from
//
// Per-module log files live under <project>/.kmp-test-runner/logs/android/<runId>/
// (v0.8.0 — moved from <project>/build/logcat/<runId>/, originally relocated
// from the legacy <project>/androidtest-logs/<timestamp>/ in BACKLOG sub-entry 3).
// One-line .gitignore for users: `.kmp-test-runner/`.
//
// PRODUCT.md "logic in Node, plumbing in shell".

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { buildAndroidBlock } from '../envelope/dry-run-blocks.js';
import {
  buildJsonReport,
  envErrorJson,
  buildDryRunReport,
  applyErrorCodeDiscriminators,
  resolveAndroidTestFilter,
  splitClassMethod,
  parseGradleTimeoutMs,
  EXIT,
} from '../cli.js';
import { buildProjectModel } from '../project-model.js';
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
  matchModuleFilter,
  expandPosixEqualsForm,
  splitGradleArgs,
  effectiveFlavors,
  effectiveHasFlavor,
} from './orchestrator-utils.js';
import { captureOnFailure } from './android-capture.js';

// Argparse for android-specific flags. Global flags (--json, --force, etc.)
// were stripped by lib/runner.js; --project-root is already consumed there.
function parseArgs(argv) {
  const out = {
    device: '',
    moduleFilter: '',
    skipApp: false,
    verbose: false,
    flavor: '',
    autoRetry: false,
    clearData: false,
    // --capture-on-fail: on instrumented-test failure, grab a device screenshot
    // + UI-hierarchy dump via adb (best-effort, forensic-only). --capture-dir
    // <path> overrides where artifacts land and implies --capture-on-fail.
    captureOnFail: false,
    captureDir: '',
    listOnly: false,
    testFilter: '',
    deviceTaskOverride: '',
    dryRun: false,
    // --no-adb on the android subcommand. Instrumented tests fundamentally
    // require adb, so we treat the flag as an implicit --list-only (emit the
    // discovered module set without dispatching gradle, which would hang or
    // fail trying to find a device). A warning surfaces the implication so
    // agents can branch on it.
    noAdb: false,
    // Global escape hatch. Tokens appended LAST in
    // gradleArgs so users override CLI defaults via gradle's last-wins flag
    // semantics. Repeatable; single-invocation values are whitespace-split.
    gradleArgs: [],
    // Android variant selector for instrumented
    // task composition. Precedence: --device-task override > explicit
    // --variant (debug|release|all) > project-model deviceTestTask
    // (testBuildType-aware) > static connectedDebugAndroidTest
    // fallback. 'auto' (default) preserves the project-model resolution.
    variant: 'auto',
  };
  // Accept POSIX `--name=value` form. Splits to
  // `[--name, value]` so the switch below (which matches the bare flag head)
  // sees the canonical shape.
  argv = expandPosixEqualsForm(argv);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--device':         out.device = argv[++i] || ''; break;
      case '--module-filter':  out.moduleFilter = argv[++i] || ''; break;
      case '--skip-app':       out.skipApp = true; break;
      case '--verbose':        out.verbose = true; break;
      case '--flavor':         out.flavor = argv[++i] || ''; break;
      case '--auto-retry':     out.autoRetry = true; break;
      case '--clear-data':     out.clearData = true; break;
      case '--capture-on-fail': out.captureOnFail = true; break;
      case '--capture-dir':    out.captureDir = argv[++i] || ''; out.captureOnFail = true; break;
      case '--list':           out.listOnly = true; break;
      case '--list-only':      out.listOnly = true; break;
      case '--no-adb':         out.noAdb = true; out.listOnly = true; break;
      case '--test-filter':    out.testFilter = argv[++i] || ''; break;
      case '--device-task':    out.deviceTaskOverride = argv[++i] || ''; break;
      case '--dry-run':        out.dryRun = true; break;
      case '--gradle-args':
        out.gradleArgs.push(...splitGradleArgs(argv[++i]));
        break;
      case '--variant':
      case '--android-variant':  out.variant = (argv[++i] || 'auto').toLowerCase(); break;
      default: /* unknown — drop, runner.js already stripped globals */ break;
    }
  }
  return out;
}

// Module is android-instrumented capable when: (a) project-model probe
// resolved a deviceTestTask candidate; or (b) the module declares an
// AGP plugin (type:'android'); or (c) it's KMP with androidLibrary{} or
// androidTarget(). The triple-source closes WS-3.
function moduleHasAndroidInstrumented(modEntry) {
  if (!modEntry) return false;
  if (modEntry.resolved?.deviceTestTask) return true;
  if (modEntry.type === 'android') return true;
  if (modEntry.androidDsl) return true;
  return false;
}

function discoverAndroidModules(projectModel) {
  const out = [];
  if (!projectModel?.modules) return out;
  for (const [modKey, entry] of Object.entries(projectModel.modules)) {
    if (!moduleHasAndroidInstrumented(entry)) continue;
    const name = modKey.replace(/^:/, '');
    out.push({
      name,
      deviceTestTask: entry.resolved?.deviceTestTask ?? null,
      androidDsl: entry.androidDsl ?? null,
      hasFlavor: !!entry.hasFlavor,
      // Probe-aware flavored-ness so `--flavor` weaves on convention-flavor
      // projects (static hasFlavor=false) and a no-flavor run falls back to the
      // umbrella connectedAndroidTest instead of the ambiguous per-variant task.
      effectiveHasFlavor: effectiveHasFlavor(entry),
      flavors: effectiveFlavors(entry),
      type: entry.type,
      // Surface coveragePlugin so the envelope's
      // coverage block can populate modules_with_kover_plugin /
      // modules_with_jacoco_plugin from the discovered set.
      coveragePlugin: entry.coveragePlugin ?? null,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Derive module-name lists keyed on coveragePlugin
// for the envelope's coverage block. Mirrors coverage-orchestrator's
// discoverCoverageModules shape (kover/jacoco arrays of bare module names).
function buildCoveragePluginLists(modules) {
  const kover = [];
  const jacoco = [];
  for (const m of modules) {
    if (m.coveragePlugin === 'kover') kover.push(m.name);
    else if (m.coveragePlugin === 'jacoco') jacoco.push(m.name);
  }
  return { kover, jacoco };
}

// --skip-app filters away :app, :androidApp, modules ending in App.
function applySkipAppFilter(modules) {
  return modules.filter(m => !/^app$|^androidApp$|App$/.test(m.name));
}

// --module-filter is normalized via the shared `matchModuleFilter` helper —
// glob + comma-CSV + dual-test (bare + `:`-prefixed) so user input `:benchmark`
// matches the colon-stripped discovery form (`"benchmark"`) and vice versa.
// Pre-unification this was a plain `m.name.includes(filter)` substring
// check that returned 0 modules on `:`-prefixed input — bug reproduced
// when filtering `:benchmark` against the `android` subcommand.
function applyModuleFilter(modules, filter) {
  if (!filter) return modules;
  return modules.filter(m => matchModuleFilter(m.name, filter));
}

// Four-tier task selection: --device-task override > explicit
// --variant (debug|release|all) > model.deviceTestTask > static fallback.
// Mirrors parallel-orchestrator's androidConnectedTask helper. The variant
// override beats the project-model resolution so users can dispatch a
// non-default variant against a project that declares testBuildType="release"
// (or vice versa). When variant === 'auto' (default), the project-model
// signal wins — preserves the project-model testBuildType awareness.
function pickGradleTaskFor(mod, deviceTaskOverride, flavor, variant = 'auto') {
  if (deviceTaskOverride) return `:${mod.name}:${deviceTaskOverride}`;

  const v = (variant || 'auto').toLowerCase();
  const flavored = !!(mod.effectiveHasFlavor || mod.hasFlavor);
  // Flavored + no explicit flavor → the flavor-agnostic umbrella
  // connectedAndroidTest (connectedDebugAndroidTest is ambiguous under flavors).
  // Mirrors parallel's androidConnectedTask; effectiveHasFlavor catches
  // convention-applied flavors the static boolean misses.
  if (flavored && !flavor) return `:${mod.name}:connectedAndroidTest`;
  const cap = flavor && flavored
    ? flavor.charAt(0).toUpperCase() + flavor.slice(1)
    : '';

  // Explicit variant overrides project-model. AGP creates
  // :m:connected${Cap}${Variant}AndroidTest for every variant with an
  // androidInstrumentedTest source set; 'all' targets the umbrella.
  if (v === 'debug')   return `:${mod.name}:connected${cap}DebugAndroidTest`;
  if (v === 'release') return `:${mod.name}:connected${cap}ReleaseAndroidTest`;
  if (v === 'all')     return `:${mod.name}:connected${cap}AndroidTest`;

  // 'auto' — trust project-model's testBuildType-aware resolution.
  if (mod.deviceTestTask) return `:${mod.name}:${mod.deviceTestTask}`;

  // Static fallback (no project-model signal — cold cache or probe disabled).
  return `:${mod.name}:connected${cap}DebugAndroidTest`;
}

// --test-filter resolves to gradle -P args.
//
// Emit the combined single-arg shape
// `class=<FQN>#<method>` instead of separate `class=<FQN>` + `method=<m>`.
// The combined form is the canonical AGP/AndroidJUnitRunner shape that
// ALWAYS works (per BACKLOG.md L329); separate args silently miss the
// method filter under Microbenchmark (live repro on di-sample:
// 14 of 14 DiBenchmark methods ran instead of 1 with separate args).
// Pre-v0.9 shape (Gap E v0.5.2) emitted both `.class=` AND `.method=`
// args; the new shape is a strict superset of correctness for AGP +
// AndroidJUnitRunner + Microbenchmark.
function buildFilterArgs(testFilter, projectRoot) {
  if (!testFilter) return [];
  const resolved = resolveAndroidTestFilter(testFilter, projectRoot) || testFilter;
  const { cls, method } = splitClassMethod(resolved);
  if (method) {
    return [`-Pandroid.testInstrumentationRunnerArguments.class=${cls}#${method}`];
  }
  return [`-Pandroid.testInstrumentationRunnerArguments.class=${cls}`];
}

// v0.9 wet-audit drift #4: parse the canonical AGP/AndroidJUnitRunner test
// failure shape into structured {test, cause} entries. Pre-fix the simple
// `/AssertionError[:\s].+/g` regex missed non-AssertionError throws (e.g.
// `IllegalStateException` from a Compose test, `NullPointerException` from
// a coroutine cancellation, etc.) — leading to `_errors.json#testFailures`
// being empty even when `tests.failed > 0`.
//
// Canonical shape emitted by AGP's gradle test executor:
//   <ClassFQN> > <testName>[device-id] FAILED
//       <ExceptionFQN>: <message>
//       at ...
//
// The regex captures (1) the class FQN, (2) the test name, (3) the cause
// line that follows. The `[device-id]` suffix is optional — host JVM tests
// omit it. Returns object array `[{test, cause}]` — agents always see a
// stable shape (test === null on the fallback path when no canonical match
// fired).
function parseTestFailures(stdout) {
  const out = [];
  const seen = new Set();
  const canonical = /^([\w.$]+(?:\.[\w$]+)*) > ([\w$]+)(?:\[[^\]]*\])? FAILED\s*\n\s+([\w.$]+(?:Exception|Error|Throwable)[:\s][^\n]*)/gm;
  let m;
  while ((m = canonical.exec(stdout)) !== null) {
    const test = `${m[1]}.${m[2]}`;
    if (seen.has(test)) continue;
    seen.add(test);
    out.push({ test, cause: m[3].trim() });
  }
  if (out.length === 0) {
    const fallback = stdout.match(
      /[\w.$]*(?:Exception|Error)[:\s][^\n]+/g,
    ) || [];
    for (const f of fallback) {
      const trimmed = f.trim();
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push({ test: null, cause: trimmed });
    }
  }
  return out;
}

// Derive a per-module safe filename: `:core:db` → `core_db`.
function safeModuleName(name) {
  return name.replace(/:/g, '_');
}

// Default run-id: ISO-ish sortable timestamp without colons (filesystem-safe).
function defaultRunId() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

// Parse gradle stdout for per-module test counts. Two formats supported:
//
// LEGACY (AGP `connectedDebugAndroidTest` task w/ traditional reporter):
//   `12 tests completed, 1 failed, 2 skipped`
//
// NEW (com.android.kotlin.multiplatform.library + Kotlin 2.x KMP-Android,
// `connectedAndroidDeviceTest` task w/ device-test reporter):
//   `Starting 3 tests on SM-S908B - 16`
//   `SM-S908B - 16 Tests 0/3 completed. (0 skipped) (0 failed)`
//   `SM-S908B - 16 Tests 2/3 completed. (0 skipped) (0 failed)`
//   `Finished 3 tests on SM-S908B - 16`
//
// Surfaced by wet validation against
// a private KMP project's benchmark module on a real S22 — gradle emitted
// `Finished 3 tests` + `BUILD SUCCESSFUL` but the legacy-only parser
// reported testsPassed=0, hiding the actual run. Returns
// { passed, failed, skipped, total } — counts are best-effort;
// orchestrator does NOT rely on them for the exit-code decision (gradle
// exit code is the authority).
function parseTestCounts(stdout) {
  let passed = 0, failed = 0, skipped = 0, total = 0;
  // Try the legacy format first.
  const legacy = stdout.match(/(\d+)\s+tests?\s+completed(?:,\s+(\d+)\s+failed)?(?:,\s+(\d+)\s+skipped)?/i);
  if (legacy) {
    total = +legacy[1];
    failed = +(legacy[2] || 0);
    skipped = +(legacy[3] || 0);
    passed = Math.max(0, total - failed - skipped);
    return { passed, failed, skipped, total };
  }
  // New KMP-Android plugin format. `Finished N tests on <device>` is the
  // authority for `total`; progress lines `Tests M/N completed.
  // (S skipped) (F failed)` carry incremental failure/skip counts. The
  // LAST progress line snapshots the final failed+skipped totals (those
  // counters only grow — they don't reset). When no progress line shows
  // failures, assume all `total` tests passed.
  const finished = stdout.match(/Finished\s+(\d+)\s+tests?\s+on\s+/i);
  if (finished) {
    total = +finished[1];
    let lastFailed = 0, lastSkipped = 0;
    const progressRe = /Tests\s+\d+\/\d+\s+completed\.\s*\((\d+)\s+skipped\)\s*\((\d+)\s+failed\)/gi;
    let p;
    while ((p = progressRe.exec(stdout)) !== null) {
      lastSkipped = +p[1];
      lastFailed  = +p[2];
    }
    failed = lastFailed;
    skipped = lastSkipped;
    passed = Math.max(0, total - failed - skipped);
  }
  return { passed, failed, skipped, total };
}

// Reconcile best-effort stdout counts against the AUTHORITATIVE gradle exit
// code. Some AGP device-test reporters emit a parseable test `total` but no
// failure marker that parseTestCounts recognises on a failing run — observed
// on AGP 9.2.1 `connectedDebugAndroidTest`, where a single failing test
// surfaced as `tests:{total:1, passed:1, failed:0}` even though the task
// exited non-zero. The gradle exit code is the authority (the PASS/FAIL +
// module_failed decision keys off it, NOT off these counts). When the task
// failed but the parse found tests with zero failures, attribute at least one
// failure so tests.{passed,failed} can't contradict exit_code / module_failed.
// No-op on exit 0, and no-op when nothing parsed (total:0) — there the
// module_failed entry + exit_code already carry the verdict and there is no
// count to correct. Counts remain best-effort: this only prevents the
// narrower "parsed a total, missed the failure" contradiction.
function reconcileTestCounts(counts, exit) {
  if (exit !== 0 && counts.total > 0 && counts.failed === 0) {
    const failed = 1;
    return {
      total: counts.total,
      failed,
      skipped: counts.skipped,
      passed: Math.max(0, counts.total - failed - counts.skipped),
    };
  }
  return counts;
}

// Build the JSON SUMMARY block emitted on stdout for human/legacy parser
// compatibility. lib/cli.js#parseAndroidSummary keys off the literal
// "=== JSON SUMMARY ===" sentinel and reads totalTests/passedTests/
// failedTests/modules:[{name,status,testsSkipped,logFile,logcatFile,
// errorsFile}]. BACKLOG sub-entry 3 line 122: "preserve JSON SUMMARY block".
function emitJsonSummary(log, summary) {
  log('=== JSON SUMMARY ===');
  log(JSON.stringify(summary, null, 2));
}

// Main entrypoint — invoked by lib/runner.js when sub === 'android'.
/**
 * Run the Android (unit + instrumented) test orchestrator.
 * @param {object} opts
 * @param {string} opts.projectRoot - Absolute path to the gradle project root.
 * @param {string[]} [opts.args=[]] - CLI argv tail (post subcommand name).
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {object|null} [opts.config=null] - Loaded kmp-test config or null.
 * @param {Function} [opts.spawn=spawnSync] - Injected spawn for tests.
 * @param {Function} [opts.adbProbe=defaultAdbProbe] - adb device probe (injected for tests).
 * @param {Function} [opts.log=() => {}] - Log sink.
 * @param {string} [opts.runId] - Run id used for envelope / cache paths.
 * @returns {Promise<{envelope:object, exitCode:number}>}
 */
export async function runAndroid({
  projectRoot,
  args = [],
  env = process.env,
  config = null,
  spawn = spawnSync,
  adbProbe = defaultAdbProbe,
  log = () => {},
  // Test-only override: deterministic run-id for log-path assertions.
  runId = defaultRunId(),
}) {
  const startTime = Date.now();

  // Strip + parse `--isolated*` flags BEFORE parseArgs so the
  // existing default-drop case stays simple. The cache dir is created lazily
  // (resolveIsolatedDir with dryRun: opts.dryRun) and torn down at every
  // return site; the per-module gradle dispatch loop below injects
  // --project-cache-dir on every spawnGradle call.
  const isolatedFlags = parseIsolatedArgs(args);
  const opts = parseArgs(isolatedFlags.args);

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

  // F1: --dry-run short-circuit — emit the resolved plan and exit before any
  // gradle probe, adb probe, or test dispatch. cli.js intercepts upstream for
  // `bin/kmp-test.js`, but direct `node lib/runner.js android --dry-run`
  // invocations now honor it.
  if (opts.dryRun) {
    const envelope = buildDryRunReport({
      subcommand: 'android',
      projectRoot,
      plan: {
        device: opts.device,
        module_filter: opts.moduleFilter,
        skip_app: opts.skipApp,
        flavor: opts.flavor,
        variant: opts.variant,
        list_only: opts.listOnly,
        test_filter: opts.testFilter,
        device_task_override: opts.deviceTaskOverride,
        capture_on_fail: opts.captureOnFail,
        capture_dir: opts.captureDir,
      },
    });
    envelope.android = buildAndroidBlock({
      device: opts.device,
      deviceTask: opts.deviceTaskOverride,
      flavor: opts.flavor,
    });
    envelope.isolated = isolatedField;
    return { envelope, exitCode: EXIT.SUCCESS };
  }

  // ---------------------------------------------------------------
  // Banner
  // ---------------------------------------------------------------
  log('');
  log('========================================');
  log('  Android Tests - All Modules Runner');
  log('========================================');
  log(`Project: ${projectRoot}`);
  if (opts.flavor)             log(`Flavor: ${opts.flavor}`);
  if (opts.variant && opts.variant !== 'auto') log(`Variant: ${opts.variant}`);
  if (opts.deviceTaskOverride) log(`Device task override: ${opts.deviceTaskOverride}`);
  log('');

  // ---------------------------------------------------------------
  // 1. Build project model (single source of truth for module discovery)
  // ---------------------------------------------------------------
  let projectModel = null;
  try {
    projectModel = buildProjectModel(projectRoot, {
      skipProbe: false,
      useCache: false,
      probeTimeoutMs: parseGradleTimeoutMs(env.KMP_GRADLE_TIMEOUT_MS),
    });
  } catch { /* model is best-effort; orchestrator falls back to empty discovery */ }

  // ---------------------------------------------------------------
  // 2. Module discovery + filters
  // ---------------------------------------------------------------
  let modules = discoverAndroidModules(projectModel);
  if (opts.skipApp)       modules = applySkipAppFilter(modules);
  if (opts.moduleFilter)  modules = applyModuleFilter(modules, opts.moduleFilter);

  if (modules.length === 0) {
    const msg = '[ERROR] No modules found with android-instrumented tests';
    log(msg);
    const envelope = envErrorJson({
      subcommand: 'android',
      projectRoot,
      durationMs: Date.now() - startTime,
      message: msg,
      code: 'no_test_modules',
    });
    envelope.android = {
      device_serial: '',
      device_task: opts.deviceTaskOverride || '',
      flavor: opts.flavor || '',
      instrumented_modules: [],
    };
    envelope.isolated = isolatedField;
    if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });
    return { envelope, exitCode: EXIT.ENV_ERROR };
  }

  // ---------------------------------------------------------------
  // 3. --list / --list-only short-circuit (closes WS-10)
  //    Names are rendered from the SAME array the count derives from.
  // ---------------------------------------------------------------
  const instrumentedModules = modules.map(m => m.name);
  // Populate kover/jacoco module lists from
  // discovered modules so describe-style coverage_plugin queries work via
  // the android envelope without a separate `kmp-test describe` round-trip.
  const coverageLists = buildCoveragePluginLists(modules);
  if (opts.listOnly) {
    log(`Android Test Modules (${instrumentedModules.length}):`);
    for (const name of instrumentedModules) log(`  - ${name}`);
    log('');
    // When the user reached this short-circuit via `--no-adb` (instrumented
    // tests require adb, so we silently elevate to --list-only), surface a
    // warning so agents can branch on the implication rather than wonder
    // why a real run didn't happen.
    const warnings = opts.noAdb
      ? [{
          code: 'no_adb_implies_list_only',
          message: '--no-adb on the android subcommand implies --list-only (instrumented tests require adb)',
        }]
      : [];
    // Populate top-level `modules[]` and echo
    // `--device <serial>` to `android.device_serial` even in --list-only
    // mode. Pre-fix list-only left top-level `modules: []` empty (forcing
    // agents to pivot on `android.instrumented_modules[]`) and dropped the
    // user-supplied --device value. Post-fix the list-only envelope shape
    // matches the wet-run shape for android: top-level `modules` carries
    // module names (strings, mirroring parseAndroidSummary on the wet path),
    // and `android.device_serial` echoes `--device <SERIAL>` so agents can
    // confirm their input was understood without spawning gradle.
    const envelope = buildJsonReport({
      subcommand: 'android',
      projectRoot,
      exitCode: EXIT.SUCCESS,
      durationMs: Date.now() - startTime,
      parsed: {
        tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
        modules: instrumentedModules,
        skipped: [],
        coverage: { tool: 'auto', missed_lines: null, modules_with_kover_plugin: coverageLists.kover, modules_with_jacoco_plugin: coverageLists.jacoco },
        errors: [],
        warnings,
        android: {
          device_serial: opts.device || '',
          device_task: opts.deviceTaskOverride || '',
          flavor: opts.flavor || '',
          instrumented_modules: instrumentedModules,
        },
        isolated: isolatedField,
      },
    });
    if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });
    return { envelope, exitCode: EXIT.SUCCESS };
  }

  // ---------------------------------------------------------------
  // 4. adb device probe
  // ---------------------------------------------------------------
  const skipAdb = String(env.KMP_TEST_SKIP_ADB || '') === '1';
  let deviceSerial = '';
  if (skipAdb) {
    log('[INFO] KMP_TEST_SKIP_ADB=1 — skipping adb probe; modules will be skipped[]');
    const skippedList = modules.map(m => ({
      module: m.name,
      reason: 'KMP_TEST_SKIP_ADB=1',
    }));
    const envelope = buildJsonReport({
      subcommand: 'android',
      projectRoot,
      exitCode: EXIT.SUCCESS,
      durationMs: Date.now() - startTime,
      parsed: {
        tests: { total: 0, passed: 0, failed: 0, skipped: skippedList.length },
        modules: [],
        skipped: skippedList,
        coverage: { tool: 'auto', missed_lines: null, modules_with_kover_plugin: coverageLists.kover, modules_with_jacoco_plugin: coverageLists.jacoco },
        errors: [],
        warnings: [],
        android: {
          device_serial: '',
          device_task: opts.deviceTaskOverride || '',
          flavor: opts.flavor || '',
          instrumented_modules: instrumentedModules,
        },
        isolated: isolatedField,
      },
    });
    if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });
    return { envelope, exitCode: EXIT.SUCCESS };
  }

  const devices = adbProbe();
  if (!devices || devices.length === 0) {
    const msg = 'No adb devices connected. Plug in a device or set KMP_TEST_SKIP_ADB=1 to bypass.';
    log(`[ERROR] ${msg}`);
    const envelope = envErrorJson({
      subcommand: 'android',
      projectRoot,
      durationMs: Date.now() - startTime,
      message: msg,
      code: 'instrumented_setup_failed',
    });
    envelope.android = {
      device_serial: '',
      device_task: opts.deviceTaskOverride || '',
      flavor: opts.flavor || '',
      instrumented_modules: instrumentedModules,
    };
    envelope.isolated = isolatedField;
    if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });
    return { envelope, exitCode: EXIT.ENV_ERROR };
  }

  // Pin to --device <serial> if supplied; else pick first.
  if (opts.device) {
    const match = devices.find(d => d.serial === opts.device);
    if (!match) {
      const msg = `Requested device "${opts.device}" not found in adb devices output. Available: ${devices.map(d => d.serial).join(', ') || '(none)'}.`;
      log(`[ERROR] ${msg}`);
      const envelope = envErrorJson({
        subcommand: 'android',
        projectRoot,
        durationMs: Date.now() - startTime,
        message: msg,
        code: 'instrumented_setup_failed',
      });
      envelope.android = {
        device_serial: opts.device,
        device_task: opts.deviceTaskOverride || '',
        flavor: opts.flavor || '',
        instrumented_modules: instrumentedModules,
      };
      envelope.isolated = isolatedField;
      if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });
      return { envelope, exitCode: EXIT.ENV_ERROR };
    }
    deviceSerial = match.serial;
  } else {
    deviceSerial = devices[0].serial;
  }
  log(`Device: ${deviceSerial}`);

  // ---------------------------------------------------------------
  // 5. Log directory — v0.8.0: moved from <project>/build/logcat/<runId>/
  //    to <project>/.kmp-test-runner/logs/android/<runId>/ as part of the
  //    artifact-subdir consolidation. Users now gitignore `.kmp-test-runner/`
  //    once instead of enumerating individual paths.
  // ---------------------------------------------------------------
  const logDir = path.join(projectRoot, '.kmp-test-runner', 'logs', 'android', runId);
  try { mkdirSync(logDir, { recursive: true }); } catch { /* best-effort */ }
  log(`Logs: ${logDir}`);
  // --capture-on-fail artifact dir. Defaults to the per-run log dir so captures
  // sit beside the log/logcat/errors files (one .gitignore covers all);
  // --capture-dir <path> overrides it (absolute used verbatim; relative resolved
  // against the project root). Only created when the user opted in.
  const captureDir = opts.captureOnFail && opts.captureDir
    ? path.resolve(projectRoot, opts.captureDir)
    : logDir;
  if (opts.captureOnFail && captureDir !== logDir) {
    try { mkdirSync(captureDir, { recursive: true }); } catch { /* best-effort */ }
  }
  log('');

  // Pre-loop logcat clear (best-effort).
  spawn('adb', ['-s', deviceSerial, 'logcat', '-c'], { encoding: 'utf8' });

  // ---------------------------------------------------------------
  // 6. Per-module dispatch loop
  // ---------------------------------------------------------------
  const isWindows = process.platform === 'win32';
  const gradlewPath = path.join(projectRoot, isWindows ? 'gradlew.bat' : 'gradlew');

  const state = {
    tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
    modules: [],
    skipped: [],
    coverage: { tool: 'auto', missed_lines: null, modules_with_kover_plugin: coverageLists.kover, modules_with_jacoco_plugin: coverageLists.jacoco },
    errors: [],
    warnings: [],
  };
  const summaryModules = [];
  let allStdout = '';
  let allStderr = '';

  for (const mod of modules) {
    const safe = safeModuleName(mod.name);
    const logFile = path.join(logDir, `${safe}.log`);
    const logcatFile = path.join(logDir, `${safe}_logcat.log`);
    const errorsFile = path.join(logDir, `${safe}_errors.json`);

    const task = pickGradleTaskFor(mod, opts.deviceTaskOverride, opts.flavor, opts.variant);
    const filterArgs = buildFilterArgs(opts.testFilter, projectRoot);
    let gradleArgs = [task, ...filterArgs, '--continue'];
    // Append --gradle-args tokens LAST so they win on duplicate
    // flags (gradle last-wins). Retry block at L460+ reuses this same array.
    if (opts.gradleArgs && opts.gradleArgs.length > 0) gradleArgs.push(...opts.gradleArgs);
    // `--isolated` injects gradle's --project-cache-dir <tmp>
    // so concurrent kmp-test android runs against the same project don't
    // share <project>/.gradle/.
    gradleArgs = injectProjectCacheDir(gradleArgs, isolatedDir);
    // Propagate device pin to the gradle subprocess. The newer
    // KMP `androidLibrary { withDeviceTestBuilder {...} }` DSL produces a
    // `connectedAndroidDeviceTest` task that IGNORES the ANDROID_SERIAL env
    // var (the legacy `connected*AndroidTest` family honors it). Detect the
    // managed-devices task by suffix and inject the gradle property the new
    // reporter actually reads. No-op when the user didn't pass --device or
    // when the resolved task is a legacy variant (env var below covers those).
    if (deviceSerial && /connectedAndroidDeviceTest$/.test(task)) {
      gradleArgs.push(`-Pandroid.testInstrumentationRunnerArguments.deviceSerial=${deviceSerial}`);
    }
    // Set ANDROID_SERIAL in the spawn env unconditionally when
    // we have a resolved deviceSerial. Cheap + harmless for tasks that
    // ignore it (the gradle property above handles those). Fixes the silent
    // device-pin miss on legacy AGP `connected{Variant}AndroidTest` paths
    // when the host has multiple devices attached.
    const spawnEnv = { ...env };
    if (deviceSerial) spawnEnv.ANDROID_SERIAL = deviceSerial;

    log(`  [>>] ${mod.name} → ${task}`);
    const t0 = Date.now();
    let result = spawnGradle(spawn, gradlewPath, gradleArgs, {
      cwd: projectRoot,
      encoding: 'utf8',
      env: spawnEnv,
    });
    let exit = (result && typeof result.status === 'number') ? result.status : 1;
    let stdout = (result && result.stdout) || '';
    let stderr = (result && result.stderr) || '';
    let retried = false;

    // --auto-retry block: re-spawn once on failure; optional pm clear
    // when --clear-data and a package name is resolvable.
    if (exit !== 0 && opts.autoRetry) {
      log(`  [RETRY] ${mod.name} — re-running after failure`);
      // Refresh the adb server between attempts. Defensive
      // cleanup in case the device went offline mid-run; without this the
      // retry sees the same stale device list and fails identically. Gated
      // behind --auto-retry → zero impact on the happy path.
      log(`  [ADB] kill-server + start-server (refresh device list)`);
      spawn('adb', ['kill-server'], { encoding: 'utf8' });
      spawn('adb', ['start-server'], { encoding: 'utf8' });
      if (opts.clearData) {
        const pkg = readPackageName(projectRoot, mod.name);
        if (pkg) {
          log(`  [CLEAR] adb shell pm clear ${pkg}`);
          spawn('adb', ['-s', deviceSerial, 'shell', 'pm', 'clear', pkg], { encoding: 'utf8' });
        }
      }
      spawn('adb', ['-s', deviceSerial, 'logcat', '-c'], { encoding: 'utf8' });
      // gradleArgs already carries --project-cache-dir +
      // device-pin gradle property; retry reuses the same array so the
      // disposable cache + serial pin stay consistent across attempts.
      result = spawnGradle(spawn, gradlewPath, gradleArgs, { cwd: projectRoot, encoding: 'utf8', env: spawnEnv });
      exit = (result && typeof result.status === 'number') ? result.status : 1;
      stdout += '\n' + ((result && result.stdout) || '');
      stderr += '\n' + ((result && result.stderr) || '');
      retried = true;
    }

    const duration = Date.now() - t0;
    allStdout += stdout + '\n';
    allStderr += stderr + '\n';

    // Tee outputs into log files (best-effort).
    try { writeFileSync(logFile, stdout, 'utf8'); } catch { /* best-effort */ }

    // Capture per-module logcat post-run (best-effort).
    const logcatRes = spawn('adb', ['-s', deviceSerial, 'logcat', '-d'], { encoding: 'utf8' });
    try { writeFileSync(logcatFile, (logcatRes && logcatRes.stdout) || '', 'utf8'); } catch { /* best-effort */ }

    const counts = reconcileTestCounts(parseTestCounts(stdout), exit);
    state.tests.total   += counts.total;
    state.tests.passed  += counts.passed;
    state.tests.failed  += counts.failed;
    state.tests.skipped += counts.skipped;

    const status = exit === 0 ? 'PASS' : 'FAIL';
    if (status === 'PASS') {
      log(`  [OK] ${mod.name} (${duration}ms)`);
      state.modules.push(mod.name);
    } else {
      log(`  [FAIL] ${mod.name} exit=${exit}`);
      state.modules.push(mod.name);
      // Write errors.json (lightweight bucketing — buckets stay empty if
      // regex finds nothing, which is fine; downstream agents can read the
      // raw .log file for full detail).
      //
      // Pre-fix the
      // testFailures regex matched only `AssertionError` lines, so non-
      // AssertionError throws (`IllegalStateException`, `NullPointerException`,
      // etc.) emitted by androidx-test runners produced an empty
      // testFailures[] even though the top-level envelope correctly counted
      // tests.failed. `parseTestFailures` now captures the canonical AGP
      // failure shape (`<ClassFQN> > <testName>[device] FAILED\n    <Throwable>:
      // <msg>`) into structured `{test, cause}` entries, falling back to a
      // wider `*Exception/Error` regex for non-canonical output.
      const errBuckets = {
        compilationErrors: stderr.match(/^e:.+/gm) || [],
        testFailures: parseTestFailures(stdout),
        crashes: stdout.match(/FATAL EXCEPTION:.+/g) || [],
      };
      try { writeFileSync(errorsFile, JSON.stringify(errBuckets, null, 2), 'utf8'); } catch { /* best-effort */ }
      const errEntry = {
        code: 'module_failed',
        module: mod.name,
        message: `[FAIL] ${mod.name}`,
        log_file: logFile,
        logcat_file: logcatFile,
        errors_file: errorsFile,
      };
      // --capture-on-fail: best-effort device screenshot + UI-hierarchy dump,
      // written beside the log/logcat/errors artifacts and surfaced on this
      // error entry so an agent gets visual + structural context for the failing
      // instrumented test. Runs AFTER the optional --auto-retry attempt, so it
      // reflects the final failed state (mirrors the post-hoc logcat -d dump
      // above). Forensic-only — captureOnFailure never throws and the result is
      // additive, so the exit code is unaffected.
      if (opts.captureOnFail) {
        const cap = captureOnFailure({ deviceSerial, outDir: captureDir, safeName: safe, spawn });
        if (cap.screenshot_file)   errEntry.screenshot_file = cap.screenshot_file;
        if (cap.ui_hierarchy_file) errEntry.ui_hierarchy_file = cap.ui_hierarchy_file;
        if (cap.capture_error)     errEntry.capture_error = cap.capture_error;
      }
      state.errors.push(errEntry);
    }

    summaryModules.push({
      name: mod.name,
      status,
      duration: `${Math.floor(duration / 60000)}:${String(Math.floor((duration % 60000) / 1000)).padStart(2, '0')}`,
      testsPassed: counts.passed,
      testsFailed: counts.failed,
      testsSkipped: counts.skipped,
      logFile,
      logcatFile,
      errorsFile: status === 'FAIL' ? errorsFile : null,
      retried,
    });
  }

  // ---------------------------------------------------------------
  // 7. Discriminator pass — upgrade module_failed to task_not_found /
  //    unsupported_class_version / instrumented_setup_failed where gradle
  //    output matches.
  // ---------------------------------------------------------------
  applyErrorCodeDiscriminators(allStdout, allStderr, state);

  // ---------------------------------------------------------------
  // 8. JSON SUMMARY banner — preserves v0.7.x stdout contract for
  //    humans + agents that grep `=== JSON SUMMARY ===` literal.
  // ---------------------------------------------------------------
  const passedModules = summaryModules.filter(m => m.status === 'PASS').length;
  const failedModules = summaryModules.length - passedModules;
  emitJsonSummary(log, {
    timestamp: runId,
    device: deviceSerial,
    totalModules: summaryModules.length,
    passedModules,
    failedModules,
    totalTests: state.tests.total,
    passedTests: state.tests.passed,
    failedTests: state.tests.failed,
    logsDir: logDir,
    modules: summaryModules,
  });

  // ---------------------------------------------------------------
  // 9. Build envelope
  // ---------------------------------------------------------------
  const exitCode = state.errors.length > 0 ? EXIT.TEST_FAIL : EXIT.SUCCESS;
  const envelope = buildJsonReport({
    subcommand: 'android',
    projectRoot,
    exitCode,
    durationMs: Date.now() - startTime,
    parsed: {
      tests: state.tests,
      modules: state.modules,
      skipped: state.skipped,
      coverage: state.coverage,
      errors: state.errors,
      warnings: state.warnings,
      android: {
        device_serial: deviceSerial,
        device_task: opts.deviceTaskOverride || '',
        flavor: opts.flavor || '',
        instrumented_modules: instrumentedModules,
      },
      isolated: isolatedField,
    },
  });

  // Cleanup the isolated cache dir (no-op when --isolated
  // wasn't enabled or policy says keep). Best-effort: rm errors are swallowed.
  if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });

  return { envelope, exitCode };
}

export {
  parseArgs,
  discoverAndroidModules,
  applySkipAppFilter,
  applyModuleFilter,
  pickGradleTaskFor,
  buildFilterArgs,
  parseTestCounts,
  reconcileTestCounts,
  parseTestFailures,
  safeModuleName,
};

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

import {
  buildJsonReport,
  envErrorJson,
  buildDryRunReport,
  applyErrorCodeDiscriminators,
  resolveAndroidTestFilter,
  splitClassMethod,
  parseGradleTimeoutMs,
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
} from './orchestrator-utils.js';

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
    listOnly: false,
    testFilter: '',
    deviceTaskOverride: '',
    dryRun: false,
    // 2026-05-05 v0.9 step 2 — global escape hatch. Tokens appended LAST in
    // gradleArgs so users override CLI defaults via gradle's last-wins flag
    // semantics. Repeatable; single-invocation values are whitespace-split.
    gradleArgs: [],
    // 2026-05-05 v0.9 step 3 — Android variant selector for instrumented
    // task composition. Precedence: --device-task override > explicit
    // --variant (debug|release|all) > project-model deviceTestTask
    // (testBuildType-aware via fix-PR-F-bis) > static connectedDebugAndroidTest
    // fallback. 'auto' (default) preserves the project-model resolution.
    variant: 'auto',
  };
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
      case '--list':           out.listOnly = true; break;
      case '--list-only':      out.listOnly = true; break;
      case '--test-filter':    out.testFilter = argv[++i] || ''; break;
      case '--device-task':    out.deviceTaskOverride = argv[++i] || ''; break;
      case '--dry-run':        out.dryRun = true; break;
      case '--gradle-args': {
        const raw = argv[++i] || '';
        for (const tok of raw.split(/\s+/).filter(Boolean)) out.gradleArgs.push(tok);
        break;
      }
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
      type: entry.type,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// --skip-app filters away :app, :androidApp, modules ending in App.
function applySkipAppFilter(modules) {
  return modules.filter(m => !/^app$|^androidApp$|App$/.test(m.name));
}

// --module-filter is substring match (mirrors benchmark filter shape).
function applyModuleFilter(modules, filter) {
  if (!filter) return modules;
  return modules.filter(m => m.name.includes(filter));
}

// Four-tier task selection (v0.9 step 3): --device-task override > explicit
// --variant (debug|release|all) > model.deviceTestTask > static fallback.
// Mirrors parallel-orchestrator's androidConnectedTask helper. The variant
// override beats the project-model resolution so users can dispatch a
// non-default variant against a project that declares testBuildType="release"
// (or vice versa). When variant === 'auto' (default), the project-model
// signal wins — preserves fix-PR-F-bis testBuildType awareness.
function pickGradleTaskFor(mod, deviceTaskOverride, flavor, variant = 'auto') {
  if (deviceTaskOverride) return `:${mod.name}:${deviceTaskOverride}`;

  const v = (variant || 'auto').toLowerCase();
  const cap = flavor && mod.hasFlavor
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
// 2026-05-05 v0.9 step 1 (flag #6) — emit the combined single-arg shape
// `class=<FQN>#<method>` instead of separate `class=<FQN>` + `method=<m>`.
// The combined form is the canonical AGP/AndroidJUnitRunner shape that
// ALWAYS works (per BACKLOG.md L329); separate args silently miss the
// method filter under Microbenchmark (live repro on dipatternsdemo:
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

// Derive a per-module safe filename: `:core:db` → `core_db`.
function safeModuleName(name) {
  return name.replace(/:/g, '_');
}

// Default run-id: ISO-ish sortable timestamp without colons (filesystem-safe).
function defaultRunId() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

// Parse gradle stdout for per-module test counts. Gradle emits lines like:
//   `> Task :module:connectedDebugAndroidTest`
//   `12 tests completed, 1 failed, 2 skipped`
// or in the success case `BUILD SUCCESSFUL` with `5 tests completed`.
// Returns { passed, failed, skipped } — counts are best-effort; orchestrator
// does NOT rely on them for the exit-code decision (gradle exit code is the
// authority).
function parseTestCounts(stdout) {
  let passed = 0, failed = 0, skipped = 0, total = 0;
  // Pattern: "X tests completed[, Y failed][, Z skipped]"
  const m = stdout.match(/(\d+)\s+tests?\s+completed(?:,\s+(\d+)\s+failed)?(?:,\s+(\d+)\s+skipped)?/i);
  if (m) {
    total = +m[1];
    failed = +(m[2] || 0);
    skipped = +(m[3] || 0);
    passed = Math.max(0, total - failed - skipped);
  }
  return { passed, failed, skipped, total };
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

  // v0.9 step 4 — strip + parse `--isolated*` flags BEFORE parseArgs so the
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
      },
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
  if (opts.listOnly) {
    log(`Android Test Modules (${instrumentedModules.length}):`);
    for (const name of instrumentedModules) log(`  - ${name}`);
    log('');
    const envelope = buildJsonReport({
      subcommand: 'android',
      projectRoot,
      exitCode: EXIT.SUCCESS,
      durationMs: Date.now() - startTime,
      parsed: {
        tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
        modules: [],
        skipped: [],
        coverage: { tool: 'auto', missed_lines: null, modules_with_kover_plugin: [], modules_with_jacoco_plugin: [] },
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
        coverage: { tool: 'auto', missed_lines: null, modules_with_kover_plugin: [], modules_with_jacoco_plugin: [] },
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
    coverage: { tool: 'auto', missed_lines: null, modules_with_kover_plugin: [], modules_with_jacoco_plugin: [] },
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
    // v0.9 step 2 — append --gradle-args tokens LAST so they win on duplicate
    // flags (gradle last-wins). Retry block at L460+ reuses this same array.
    if (opts.gradleArgs && opts.gradleArgs.length > 0) gradleArgs.push(...opts.gradleArgs);
    // v0.9 step 4 — `--isolated` injects gradle's --project-cache-dir <tmp>
    // so concurrent kmp-test android runs against the same project don't
    // share <project>/.gradle/.
    gradleArgs = injectProjectCacheDir(gradleArgs, isolatedDir);

    log(`  [>>] ${mod.name} → ${task}`);
    const t0 = Date.now();
    let result = spawnGradle(spawn, gradlewPath, gradleArgs, {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...env },
    });
    let exit = (result && typeof result.status === 'number') ? result.status : 1;
    let stdout = (result && result.stdout) || '';
    let stderr = (result && result.stderr) || '';
    let retried = false;

    // --auto-retry block: re-spawn once on failure; optional pm clear
    // when --clear-data and a package name is resolvable.
    if (exit !== 0 && opts.autoRetry) {
      log(`  [RETRY] ${mod.name} — re-running after failure`);
      if (opts.clearData) {
        const pkg = readPackageName(projectRoot, mod.name);
        if (pkg) {
          log(`  [CLEAR] adb shell pm clear ${pkg}`);
          spawn('adb', ['-s', deviceSerial, 'shell', 'pm', 'clear', pkg], { encoding: 'utf8' });
        }
      }
      spawn('adb', ['-s', deviceSerial, 'logcat', '-c'], { encoding: 'utf8' });
      // gradleArgs already carries --project-cache-dir (injected above);
      // retry reuses the same array so the disposable cache stays consistent.
      result = spawnGradle(spawn, gradlewPath, gradleArgs, { cwd: projectRoot, encoding: 'utf8', env: { ...env } });
      exit = (result && typeof result.status === 'number') ? result.status : 1;
      stdout += '\n' + ((result && result.stdout) || '');
      stderr += '\n' + ((result && result.stderr) || '');
      retried = true;
    }

    const duration = Date.now() - t0;
    allStdout += stdout + '\n';
    allStderr += stderr + '\n';

    // Tee outputs into log files (best-effort).
    try { writeFileSync(logFile, stdout); } catch { /* best-effort */ }

    // Capture per-module logcat post-run (best-effort).
    const logcatRes = spawn('adb', ['-s', deviceSerial, 'logcat', '-d'], { encoding: 'utf8' });
    try { writeFileSync(logcatFile, (logcatRes && logcatRes.stdout) || ''); } catch { /* best-effort */ }

    const counts = parseTestCounts(stdout);
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
      const errBuckets = {
        compilationErrors: stderr.match(/^e:.+/gm) || [],
        testFailures: stdout.match(/AssertionError[:\s].+/g) || [],
        crashes: stdout.match(/FATAL EXCEPTION:.+/g) || [],
      };
      try { writeFileSync(errorsFile, JSON.stringify(errBuckets, null, 2)); } catch { /* best-effort */ }
      state.errors.push({
        code: 'module_failed',
        module: mod.name,
        message: `[FAIL] ${mod.name}`,
        log_file: logFile,
        logcat_file: logcatFile,
        errors_file: errorsFile,
      });
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

  // v0.9 step 4 — cleanup the isolated cache dir (no-op when --isolated
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
  safeModuleName,
};

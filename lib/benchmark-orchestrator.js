// SPDX-License-Identifier: MIT
// lib/benchmark-orchestrator.js — Node-side benchmark orchestrator (v0.8 PIVOT, sub-entry 1).
// Replaces scripts/sh/run-benchmarks.sh (538 LOC) + scripts/ps1/run-benchmarks.ps1
// (471 LOC). PRODUCT.md "logic in Node, plumbing in shell"; BACKLOG.md Sub-entry 1.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  buildJsonReport,
  envErrorJson,
  buildDryRunReport,
  resolveAndroidTestFilter,
  splitClassMethod,
  applyErrorCodeDiscriminators,
  parseGradleTimeoutMs,
  EXIT,
} from './cli.js';
import { buildProjectModel, resolveTasksFor } from './project-model.js';
import { readBuildFile, discoverIncludedModules, defaultAdbProbe, spawnGradle } from './orchestrator-utils.js';

// Argparse for benchmark-specific flags only; global flags are stripped upstream by lib/cli.js.
function parseArgs(argv) {
  const out = {
    config: 'smoke',
    platform: 'all',
    moduleFilter: '*',
    includeShared: false,
    testFilter: null,
    dryRun: false,
    timeout: null,           // --timeout <seconds>; null = use config default
    ignoreGradleTimeout: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config')           { out.config = argv[++i]; }
    else if (a === '--platform')    { out.platform = argv[++i]; }
    else if (a === '--module-filter') { out.moduleFilter = argv[++i]; }
    else if (a === '--include-shared') { out.includeShared = true; }
    else if (a === '--test-filter') { out.testFilter = argv[++i]; }
    else if (a === '--dry-run')     { out.dryRun = true; }
    else if (a === '--timeout')     { out.timeout = parseInt(argv[++i], 10); }
    else if (a === '--ignore-gradle-timeout') { out.ignoreGradleTimeout = true; }
  }
  return out;
}

// v0.8.0 — adaptive `KMP_GRADLE_TIMEOUT_MS` per benchmark config (BACKLOG #5).
//
// Resolution precedence (highest wins):
//   1. `--ignore-gradle-timeout`          → 0 (timeout disabled)
//   2. `--timeout <seconds>` flag (>= 0)  → seconds * 1000
//   3. `KMP_GRADLE_TIMEOUT_MS` env var    → that value (0 also disables)
//   4. Per-config default                 → smoke=300_000, main=1_800_000, stress=3_600_000
//
// Returning 0 disables the timeout entirely (gradle runs without watchdog).
// Unknown configs fall through to the `main` default — preserves prior behavior
// for legacy `--config <custom>` users.
const BENCHMARK_TIMEOUT_DEFAULTS_MS = Object.freeze({
  smoke: 300_000,
  main: 1_800_000,
  stress: 3_600_000,
});

function resolveBenchmarkTimeoutMs(config, env, opts) {
  if (opts && opts.ignoreGradleTimeout) return 0;
  if (opts && typeof opts.timeout === 'number' && Number.isFinite(opts.timeout) && opts.timeout >= 0) {
    return opts.timeout * 1000;
  }
  if (env && env.KMP_GRADLE_TIMEOUT_MS != null && env.KMP_GRADLE_TIMEOUT_MS !== '') {
    const envMs = parseInt(env.KMP_GRADLE_TIMEOUT_MS, 10);
    if (Number.isFinite(envMs) && envMs >= 0) return envMs;
  }
  return BENCHMARK_TIMEOUT_DEFAULTS_MS[config] ?? BENCHMARK_TIMEOUT_DEFAULTS_MS.main;
}

// Module discovery — port of scripts/sh/lib/benchmark-detect.sh:86-133.
// `stripKotlinComments`, `readBuildFile`, `discoverIncludedModules` extracted
// to `./orchestrator-utils.js` so other v0.8 orchestrators (changed, android,
// etc.) reuse the exact same walking shape. No behavior change here.

function moduleHasBenchmarkPlugin(content) {
  if (!content) return false;
  return (
    content.includes('kotlinx.benchmark') ||
    content.includes('androidx.benchmark') ||
    /benchmark[\s\S]{0,40}plugin/.test(content) ||
    /allopen[\s\S]{0,40}benchmark/.test(content)
  );
}

function detectModulePlatforms(content) {
  if (!content) return [];
  const platforms = [];
  const hasKotlinxBenchmark = content.includes('kotlinx.benchmark') ||
    content.includes('org.jetbrains.kotlinx.benchmark');
  const hasAndroidxBenchmark = content.includes('androidx.benchmark');
  // KMP / AGP markers — module exposes an Android target whose connectedAndroidTest
  // can host device-side benchmarks even when kotlinx-benchmark itself is jvm-only.
  const hasAndroidTarget =
    /\bandroidLibrary\s*\{/.test(content) ||
    /\bandroidTarget\s*\(/.test(content) ||
    /id\s*\(\s*"com\.android\.library"\s*\)/.test(content) ||
    /id\s*\(\s*"com\.android\.application"\s*\)/.test(content) ||
    /alias\s*\(\s*libs\.plugins\.android\.(library|application)\s*\)/.test(content);
  // androidx.benchmark → android leg (instrumented via connectedAndroidTest)
  if (hasAndroidxBenchmark) platforms.push('android');
  // kotlinx.benchmark → jvm leg; also android leg when an Android target is declared
  // (KMP androidLibrary with withDeviceTestBuilder, or AGP-applied android plugin).
  if (hasKotlinxBenchmark) {
    platforms.push('jvm');
    if (hasAndroidTarget && !platforms.includes('android')) platforms.push('android');
  }
  return platforms;
}

function moduleFilterMatches(name, filter) {
  if (!filter || filter === '*') return true;
  // Bash side does substring match (benchmark-detect.sh:109-110); preserve.
  return name.includes(filter);
}

function discoverBenchmarkModules(projectRoot, moduleFilter) {
  const all = discoverIncludedModules(projectRoot);
  const out = [];
  for (const name of all) {
    if (!moduleFilterMatches(name, moduleFilter)) continue;
    const content = readBuildFile(projectRoot, name);
    if (!moduleHasBenchmarkPlugin(content)) continue;
    out.push({ name, platforms: detectModulePlatforms(content) });
  }
  return out;
}

// Task name builder — port of benchmark-detect.sh:197-220.
function gradleTaskFor(moduleName, platform, config, projectModel = null) {
  if (platform === 'jvm') {
    if (config === 'smoke')  return `:${moduleName}:desktopSmokeBenchmark`;
    if (config === 'stress') return `:${moduleName}:desktopStressBenchmark`;
    return `:${moduleName}:desktopBenchmark`;
  }
  if (platform === 'android') {
    // Project model already resolved the right task per module from the
    // `gradle tasks --all` cache, picking the KMP-aware
    // connectedAndroidDeviceTest over plain connectedAndroidTest when both
    // exist. Fall back to the static template only when the model has no
    // signal for this module (cold cache, probe never ran).
    const modKey = `:${moduleName}`;
    const resolved = projectModel?.modules?.[modKey]?.resolved;
    if (resolved?.deviceTestTask) return `:${moduleName}:${resolved.deviceTestTask}`;
    return `:${moduleName}:connectedAndroidTest`;
  }
  return `:${moduleName}:desktopBenchmark`;
}

// Test-filter resolution — preserves Gap E (v0.5.2) `#` method-level split.
function buildFilterArgs(platform, testFilter, projectRoot) {
  if (!testFilter) return [];
  if (platform === 'jvm') {
    // Pass-through to gradle's --tests; gradle handles globs natively.
    return ['--tests', testFilter];
  }
  // android: glob → FQN resolution upstream (resolveAndroidTestFilter walks
  // src/ trees). For literal FQNs, this is a no-op pass-through.
  const resolved = resolveAndroidTestFilter(testFilter, projectRoot) || testFilter;
  const { cls, method } = splitClassMethod(resolved);
  const out = [`-Pandroid.testInstrumentationRunnerArguments.class=${cls}`];
  if (method) {
    out.push(`-Pandroid.testInstrumentationRunnerArguments.method=${method}`);
  }
  return out;
}

// Main entrypoint
export async function runBenchmark({
  projectRoot,
  args = [],
  env = process.env,
  spawn = spawnSync,           // injectable for tests
  adbProbe = defaultAdbProbe,  // injectable for tests
  log = () => {},              // human-banner sink (runner.js wires console)
}) {
  const startTime = Date.now();
  const opts = parseArgs(args);

  // F1: --dry-run short-circuit — emit the resolved plan and exit before any
  // module discovery or gradle spawn. Direct `node lib/runner.js benchmark
  // --dry-run` invocations now honor the flag (cli.js intercepts upstream for
  // production paths, but not for direct runner.js calls).
  if (opts.dryRun) {
    const envelope = buildDryRunReport({
      subcommand: 'benchmark',
      projectRoot,
      plan: {
        config: opts.config,
        platform: opts.platform,
        module_filter: opts.moduleFilter,
        include_shared: opts.includeShared,
        test_filter: opts.testFilter,
      },
    });
    return { envelope, exitCode: EXIT.SUCCESS };
  }

  // Normalize platform requests.
  const requestedPlatforms = opts.platform === 'all'
    ? ['jvm', 'android']
    : [opts.platform];

  // ---------------------------------------------------------------
  // Module discovery
  // ---------------------------------------------------------------
  const modules = discoverBenchmarkModules(projectRoot, opts.moduleFilter);

  if (modules.length === 0) {
    const msg = opts.moduleFilter && opts.moduleFilter !== '*'
      ? `[ERROR] No modules found matching filter: ${opts.moduleFilter}`
      : `[ERROR] No benchmark modules found in ${projectRoot}`;
    log(msg);
    const envelope = envErrorJson({
      subcommand: 'benchmark',
      projectRoot,
      durationMs: Date.now() - startTime,
      message: msg,
      code: 'no_test_modules',
    });
    envelope.benchmark = {
      config: opts.config, total: 0, passed: 0, failed: 0, platforms: [],
    };
    return { envelope, exitCode: EXIT.ENV_ERROR };
  }

  // ---------------------------------------------------------------
  // adb device probe (only when android leg is requested AND not skipped)
  // ---------------------------------------------------------------
  const skipAdb = String(env.KMP_TEST_SKIP_ADB || '') === '1';
  let adbDevices = [];
  let androidAvailable = false;
  if (requestedPlatforms.includes('android')) {
    if (skipAdb) {
      // Honor user opt-out: silently disable android leg without erroring.
      androidAvailable = false;
    } else {
      adbDevices = adbProbe();
      androidAvailable = adbDevices.length > 0;
    }
  }

  // If android was the ONLY platform requested AND adb has no device AND
  // skipAdb is false → instrumented_setup_failed (PRODUCT criterion 5: no
  // silent passes for missing platform deps).
  if (
    opts.platform === 'android' &&
    !androidAvailable &&
    !skipAdb
  ) {
    const msg = 'No adb devices connected. Plug in a device or set KMP_TEST_SKIP_ADB=1 to bypass.';
    log(`[ERROR] ${msg}`);
    const envelope = envErrorJson({
      subcommand: 'benchmark',
      projectRoot,
      durationMs: Date.now() - startTime,
      message: msg,
      code: 'instrumented_setup_failed',
    });
    envelope.benchmark = {
      config: opts.config, total: 0, passed: 0, failed: 0, platforms: [],
    };
    return { envelope, exitCode: EXIT.ENV_ERROR };
  }

  // ---------------------------------------------------------------
  // Per-module dispatch
  // ---------------------------------------------------------------
  const state = {
    tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
    modules: [],
    skipped: [],
    coverage: { tool: 'auto', missed_lines: null },
    errors: [],
    warnings: [],
  };

  let totalPass = 0;
  let totalFail = 0;
  let totalTimedOut = 0;
  const platformsThatRan = new Set();
  let capturedAllStdout = '';
  let capturedAllStderr = '';

  // v0.8.0 — resolve effective gradle timeout per --config. 0 = disabled.
  const benchmarkTimeoutMs = resolveBenchmarkTimeoutMs(opts.config, env, opts);
  log(`Gradle benchmark timeout: ${benchmarkTimeoutMs === 0 ? 'disabled' : `${benchmarkTimeoutMs} ms`} (config=${opts.config})`);

  // Build project model so we can pick the right Android task per module
  // (KMP-aware connectedAndroidDeviceTest vs plain connectedAndroidTest).
  // First call probes `gradle tasks --all` once and caches; subsequent calls
  // (same content hash) hit the cache. Honor KMP_GRADLE_TIMEOUT_MS so large
  // projects (60+ modules) don't truncate at the default 60s probe deadline.
  // Failures are non-fatal — orchestrator falls back to the static task
  // template when the model has no signal.
  let projectModel = null;
  try {
    // useCache:false bypasses the JSON model cache that lib/cli.js wrote with
    // skipProbe:true (tasks all null). The tasks-<sha>.txt probe cache IS
    // honored — only the JSON aggregation is rebuilt, so this is cheap on
    // warm runs (no gradle invocation when probe cache is hot).
    projectModel = buildProjectModel(projectRoot, {
      skipProbe: false,
      useCache: false,
      probeTimeoutMs: parseGradleTimeoutMs(env.KMP_GRADLE_TIMEOUT_MS),
    });
  } catch { /* model is best-effort */ }

  const gradlewName = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const gradlewPath = path.join(projectRoot, gradlewName);

  for (const mod of modules) {
    for (const plat of requestedPlatforms) {
      // Module doesn't declare this platform → skip with banner.
      if (!mod.platforms.includes(plat)) {
        const reason = `module does not declare ${plat} benchmark capability`;
        log(`  [SKIP] ${mod.name} (${plat}) — ${reason}`);
        state.skipped.push({ module: mod.name, reason: `(${plat}) ${reason}` });
        state.tests.skipped++;
        continue;
      }
      // Android leg requested but adb skipped → push to skipped[] (no error,
      // intentional opt-out).
      if (plat === 'android' && !androidAvailable) {
        const reason = skipAdb
          ? 'skipped (KMP_TEST_SKIP_ADB=1)'
          : 'no adb device available';
        log(`  [SKIP] ${mod.name} (${plat}) — ${reason}`);
        state.skipped.push({ module: mod.name, reason: `(${plat}) ${reason}` });
        state.tests.skipped++;
        continue;
      }

      const task = gradleTaskFor(mod.name, plat, opts.config, projectModel);
      const filterArgs = buildFilterArgs(plat, opts.testFilter, projectRoot);
      const gradleArgs = [task, ...filterArgs, '--continue'];

      log(`  [>>] ${mod.name} (${plat}) -> ${task} ${filterArgs.join(' ')}`.trimEnd());

      const spawnOpts = {
        cwd: projectRoot,
        encoding: 'utf8',
        env: { ...env },
      };
      // v0.8.0 — apply per-config timeout (0 = disabled). When set, Node sends
      // SIGTERM if gradle exceeds it; we surface that as `gradle_timeout`
      // below instead of treating it like a generic test failure.
      if (benchmarkTimeoutMs > 0) {
        spawnOpts.timeout = benchmarkTimeoutMs;
        spawnOpts.killSignal = 'SIGTERM';
      }
      const result = spawnGradle(spawn, gradlewPath, gradleArgs, spawnOpts);

      capturedAllStdout += ((result && result.stdout) || '') + '\n';
      capturedAllStderr += ((result && result.stderr) || '') + '\n';

      platformsThatRan.add(plat);

      // v0.8.0 — detect gradle timeout. spawnSync surfaces it two ways:
      //   POSIX: signal === 'SIGTERM' && status === null
      //   Windows: error.code === 'ETIMEDOUT'
      // Both converge on the same `gradle_timeout` envelope so agents can
      // disambiguate hung-daemon from failing-tests regardless of platform.
      const isGradleTimeout = benchmarkTimeoutMs > 0 && (
        (result && result.signal === 'SIGTERM' && result.status === null) ||
        (result && result.error && result.error.code === 'ETIMEDOUT')
      );

      if (isGradleTimeout) {
        totalTimedOut++;
        const timeoutSec = Math.round(benchmarkTimeoutMs / 1000);
        const msg = `gradle invocation exceeded ${timeoutSec}s timeout (config=${opts.config}). Increase via --timeout / KMP_GRADLE_TIMEOUT_MS, or pass --ignore-gradle-timeout.`;
        log(`  [TIMEOUT] ${mod.name} (${plat}) — ${msg}`);
        if (!state.modules.includes(mod.name)) state.modules.push(mod.name);
        state.errors.push({
          code: 'gradle_timeout',
          module: mod.name,
          platform: plat,
          message: `[TIMEOUT] ${mod.name} (${plat}) ${msg}`,
        });
        continue;
      }

      const exitCode = (result && typeof result.status === 'number')
        ? result.status
        : 1;

      if (exitCode === 0) {
        totalPass++;
        log(`  [OK] ${mod.name} (${plat}) completed successfully.`);
        if (!state.modules.includes(mod.name)) state.modules.push(mod.name);
      } else {
        totalFail++;
        log(`  [FAIL] ${mod.name} (${plat}) failed with exit code ${exitCode}.`);
        if (!state.modules.includes(mod.name)) state.modules.push(mod.name);
        state.errors.push({
          code: 'module_failed',
          module: mod.name,
          platform: plat,
          message: `[FAIL] ${mod.name} (${plat}) failed with exit code ${exitCode}.`,
        });
      }
    }
  }

  // Upgrade generic `module_failed` to discriminated codes (task_not_found,
  // unsupported_class_version, instrumented_setup_failed) when gradle output matches.
  applyErrorCodeDiscriminators(capturedAllStdout, capturedAllStderr, state);

  // ---------------------------------------------------------------
  // Aggregate exit code + summary banner
  // ---------------------------------------------------------------
  // totalAttempted counts only test-level outcomes (pass/fail). Timed-out
  // modules are tracked separately so they preempt the no_test_modules
  // fallback and surface as gradle_timeout instead.
  const totalAttempted = totalPass + totalFail;
  const skippedCount = state.skipped.length;

  // Distinguish "no module declares this platform" (configuration mismatch
  // → no_test_modules + exit 3, matching run-benchmarks.sh:319-325) from
  // "user opted out via KMP_TEST_SKIP_ADB" (intentional skip → exit 0). The
  // discriminator: at least one module that DECLARED a requested platform
  // could have run if not for the opt-out.
  const haveCapableModules = modules.some(m =>
    m.platforms.some(p => requestedPlatforms.includes(p))
  );

  let scriptStatus;
  if (totalAttempted === 0 && totalTimedOut === 0 && skippedCount > 0 && !haveCapableModules) {
    const msg = `[ERROR] No benchmark module supports platform '${opts.platform}'.`;
    log(msg);
    state.errors.push({ code: 'no_test_modules', message: msg });
    scriptStatus = EXIT.ENV_ERROR;
  } else if (totalAttempted === 0 && totalTimedOut === 0 && skippedCount > 0 && skipAdb) {
    // All capable modules were on the android leg and the user opted out
    // of adb. Treat as a clean exit (intentional CI shape).
    scriptStatus = EXIT.SUCCESS;
  } else if (totalTimedOut > 0) {
    // v0.8.0 — gradle_timeout surfaces as ENV_ERROR (not TEST_FAIL) so agents
    // can distinguish "build hung / config too tight" from "tests failed".
    // BACKLOG #5 line 468 decision.
    scriptStatus = EXIT.ENV_ERROR;
  } else if (totalFail > 0) {
    scriptStatus = EXIT.TEST_FAIL;
  } else {
    scriptStatus = EXIT.SUCCESS;
  }

  state.tests.passed = totalPass;
  // Treat timed-out modules as failed-from-the-test-result perspective so
  // tests.{failed,total} stay consistent with the per-module FAIL banner shape.
  state.tests.failed = totalFail + totalTimedOut;
  state.tests.total = totalAttempted + totalTimedOut;

  const timedOutSuffix = totalTimedOut > 0 ? `, ${totalTimedOut} timed out` : '';
  log(`Result: ${totalPass} passed, ${totalFail} failed${timedOutSuffix}`);

  // ---------------------------------------------------------------
  // Build envelope
  // ---------------------------------------------------------------
  const benchmarkField = {
    config: opts.config,
    total: totalAttempted + totalTimedOut,
    passed: totalPass,
    failed: totalFail,
    timed_out: totalTimedOut,
    platforms: Array.from(platformsThatRan).sort(),
    timeout_ms: benchmarkTimeoutMs,
  };

  const envelope = buildJsonReport({
    subcommand: 'benchmark',
    projectRoot,
    exitCode: scriptStatus,
    durationMs: Date.now() - startTime,
    parsed: {
      tests: state.tests,
      modules: state.modules,
      skipped: state.skipped,
      coverage: state.coverage,
      errors: state.errors,
      warnings: state.warnings,
      benchmark: benchmarkField,
    },
  });

  return { envelope, exitCode: scriptStatus };
}

export {
  // re-exports for runner.js + tests
  parseArgs,
  discoverBenchmarkModules,
  detectModulePlatforms,
  gradleTaskFor,
  buildFilterArgs,
  resolveBenchmarkTimeoutMs,
  BENCHMARK_TIMEOUT_DEFAULTS_MS,
};

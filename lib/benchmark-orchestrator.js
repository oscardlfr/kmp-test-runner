// SPDX-License-Identifier: MIT
// lib/benchmark-orchestrator.js — Node-side benchmark orchestrator (v0.8 PIVOT, sub-entry 1).
// Replaces scripts/sh/run-benchmarks.sh (538 LOC) + scripts/ps1/run-benchmarks.ps1
// (471 LOC). PRODUCT.md "logic in Node, plumbing in shell"; BACKLOG.md Sub-entry 1.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import {
  buildJsonReport,
  envErrorJson,
  resolveAndroidTestFilter,
  splitClassMethod,
  applyErrorCodeDiscriminators,
  parseGradleTimeoutMs,
  EXIT,
} from './cli.js';
import { buildProjectModel, resolveTasksFor } from './project-model.js';

// Argparse for benchmark-specific flags only; global flags are stripped upstream by lib/cli.js.
function parseArgs(argv) {
  const out = {
    config: 'smoke',
    platform: 'all',
    moduleFilter: '*',
    includeShared: false,
    testFilter: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config')           { out.config = argv[++i]; }
    else if (a === '--platform')    { out.platform = argv[++i]; }
    else if (a === '--module-filter') { out.moduleFilter = argv[++i]; }
    else if (a === '--include-shared') { out.includeShared = true; }
    else if (a === '--test-filter') { out.testFilter = argv[++i]; }
  }
  return out;
}

// Module discovery — port of scripts/sh/lib/benchmark-detect.sh:86-133.
// Walks settings.gradle.kts, then per-module build.gradle.kts, applying the
// same plugin-id markers the bash side uses.
function readBuildFile(projectRoot, modulePath) {
  const dir = path.join(projectRoot, ...modulePath.split(':'));
  const file = path.join(dir, 'build.gradle.kts');
  if (!existsSync(file)) return null;
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

// Strip Kotlin `//` + `/* ... */` comments. Legacy bash matched commented
// `//include(":foo")` lines, causing phantom-module gradle failures.
function stripKotlinComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function discoverIncludedModules(projectRoot) {
  const settings = path.join(projectRoot, 'settings.gradle.kts');
  if (!existsSync(settings)) return [];
  let content;
  try { content = readFileSync(settings, 'utf8'); } catch { return []; }
  content = stripKotlinComments(content);
  const out = [];
  const re = /include\s*\(\s*"(:[\w\-:]+)"/g;
  for (const m of content.matchAll(re)) out.push(m[1].replace(/^:/, ''));
  const multi = /include\s*\(\s*((?:"[^"]+"\s*,?\s*)+)\)/g;
  for (const m of content.matchAll(multi)) {
    for (const sub of m[1].matchAll(/"(:[\w\-:]+)"/g)) {
      const name = sub[1].replace(/^:/, '');
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

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

// adb device probe — port of scripts/sh/lib/benchmark-detect.sh:36-80.
// Returns array of { serial, type, model }; empty when no devices or no adb.
function defaultAdbProbe() {
  const result = spawnSync('adb', ['devices', '-l'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return [];
  const out = [];
  for (const line of (result.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('List of devices')) continue;
    if (!line.trim()) continue;
    const serial = line.split(/\s+/)[0];
    if (!serial) continue;
    const type = serial.startsWith('emulator-') ? 'emulator' : 'physical';
    const modelMatch = line.match(/model:(\S+)/);
    out.push({ serial, type, model: modelMatch ? modelMatch[1] : 'unknown' });
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
  const platformsThatRan = new Set();
  let capturedAllStdout = '';
  let capturedAllStderr = '';

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

      const result = spawn(gradlewPath, gradleArgs, {
        cwd: projectRoot,
        encoding: 'utf8',
        env: { ...env },
      });
      const exitCode = (result && typeof result.status === 'number')
        ? result.status
        : 1;

      capturedAllStdout += ((result && result.stdout) || '') + '\n';
      capturedAllStderr += ((result && result.stderr) || '') + '\n';

      platformsThatRan.add(plat);

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
  if (totalAttempted === 0 && skippedCount > 0 && !haveCapableModules) {
    const msg = `[ERROR] No benchmark module supports platform '${opts.platform}'.`;
    log(msg);
    state.errors.push({ code: 'no_test_modules', message: msg });
    scriptStatus = EXIT.ENV_ERROR;
  } else if (totalAttempted === 0 && skippedCount > 0 && skipAdb) {
    // All capable modules were on the android leg and the user opted out
    // of adb. Treat as a clean exit (intentional CI shape).
    scriptStatus = EXIT.SUCCESS;
  } else if (totalFail > 0) {
    scriptStatus = EXIT.TEST_FAIL;
  } else {
    scriptStatus = EXIT.SUCCESS;
  }

  state.tests.passed = totalPass;
  state.tests.failed = totalFail;
  state.tests.total = totalAttempted;

  log(`Result: ${totalPass} passed, ${totalFail} failed`);

  // ---------------------------------------------------------------
  // Build envelope
  // ---------------------------------------------------------------
  const benchmarkField = {
    config: opts.config,
    total: totalAttempted,
    passed: totalPass,
    failed: totalFail,
    platforms: Array.from(platformsThatRan).sort(),
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
};

// SPDX-License-Identifier: MIT
// lib/benchmark-orchestrator.js — Node-side benchmark orchestrator (v0.8 PIVOT, sub-entry 1).
// Replaces scripts/sh/run-benchmarks.sh (538 LOC) + scripts/ps1/run-benchmarks.ps1
// (471 LOC). PRODUCT.md "logic in Node, plumbing in shell"; BACKLOG.md Sub-entry 1.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildBenchmarkBlock } from '../envelope/dry-run-blocks.js';
import {
  buildJsonReport,
  envErrorJson,
  buildDryRunReport,
  resolveAndroidTestFilter,
  splitClassMethod,
  applyErrorCodeDiscriminators,
  parseGradleTimeoutMs,
  buildInvalidArgsEnvelope,
  EXIT,
} from '../cli.js';
import { buildProjectModel, resolveTasksFor } from '../project-model.js';
import { parseBuildLogicPluginDescriptors } from '../project/kotlin-dsl.js';
import {
  readBuildFile,
  discoverIncludedModules,
  defaultAdbProbe,
  spawnGradle,
  parseIsolatedArgs,
  resolveIsolatedDir,
  injectProjectCacheDir,
  cleanupIsolatedDir,
  shouldKeepIsolated,
  buildIsolatedField,
  matchModuleFilter,
  expandPosixEqualsForm,
  validateEnum,
  validateNonNegativeInt,
  requireFlagValue,
  splitGradleArgs,
  tailTruncate,
  AGGREGATE_OUTPUT_CAP,
} from './orchestrator-utils.js';
import { PLATFORM_VALUES } from '../parsers/argv-constants.js';

// Derive a per-module safe filename: `:core:db` → `core_db`. Mirrors
// android-orchestrator.js so per-task log filenames stay parallel across
// orchestrators.
function safeModuleName(name) {
  return name.replace(/:/g, '_');
}

// Default run-id: ISO-ish sortable timestamp without colons (filesystem-safe).
// Mirrors android-orchestrator.js.
function defaultRunId() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

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
    // Global escape hatch. Tokens appended LAST in
    // gradleArgs so users override CLI defaults via gradle's last-wins flag
    // semantics. Repeatable; single-invocation values are whitespace-split.
    gradleArgs: [],
    // Android variant selector for instrumented
    // benchmark tasks. JVM benchmarks are variant-agnostic. Default 'auto'
    // preserves existing behavior (project-model deviceTestTask resolution
    // or connectedAndroidTest umbrella). Explicit variants (debug|release|
    // all) compose connected${Variant}AndroidTest directly.
    variant: 'auto',
    // Opt-in restore of pre-graded behavior: any gradle
    // timeout exits 3 even when other modules passed. CI matrix users that
    // want strict per-matrix-cell failure on any timeout pass this flag.
    // Default false → graded path applies (totalTimedOut > 0 AND totalPass
    // >= 1 → exit 0 + warnings[].code='partial_timeout').
    strictTimeouts: false,
    // Collected validation errors.
    errors: [],
  };
  // Accept POSIX `--name=value` form. Splits to
  // `[--name, value]` so the if-else chain (which matches the bare flag head)
  // sees the canonical shape.
  argv = expandPosixEqualsForm(argv);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config')           { out.config = requireFlagValue(a, argv[++i], out.errors); }
    else if (a === '--platform') {
      const v = validateEnum('--platform', argv[++i], PLATFORM_VALUES, out.errors);
      if (v !== null && v !== undefined) out.platform = v;
    }
    else if (a === '--module-filter') { out.moduleFilter = requireFlagValue(a, argv[++i], out.errors); }
    else if (a === '--include-shared') { out.includeShared = true; }
    else if (a === '--test-filter') { out.testFilter = requireFlagValue(a, argv[++i], out.errors); }
    else if (a === '--dry-run')     { out.dryRun = true; }
    else if (a === '--timeout') {
      const v = validateNonNegativeInt('--timeout', argv[++i], out.errors);
      if (v !== null && v !== undefined) out.timeout = v;
    }
    else if (a === '--ignore-gradle-timeout') { out.ignoreGradleTimeout = true; }
    else if (a === '--gradle-args') {
      out.gradleArgs.push(...splitGradleArgs(requireFlagValue(a, argv[++i], out.errors)));
    }
    else if (a === '--variant' || a === '--android-variant') {
      out.variant = (requireFlagValue(a, argv[++i], out.errors) || 'auto').toLowerCase();
    }
    else if (a === '--strict-timeouts') { out.strictTimeouts = true; }
  }
  return out;
}

// v0.8.0 — adaptive `KMP_GRADLE_TIMEOUT_MS` per benchmark config.
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

// Unified filter normalization. Pre-fix used
// `name.includes(filter)` substring; now delegates to the shared helper for
// glob + comma-CSV + dual-test (`:`-prefix-aware) matching consistent with
// parallel / android orchestrators.
function moduleFilterMatches(name, filter) {
  return matchModuleFilter(name, filter);
}

function discoverBenchmarkModules(projectRoot, moduleFilter) {
  const all = discoverIncludedModules(projectRoot);
  // Convention-plugin expansion: a project that applies kotlinx-benchmark
  // through a build-logic convention plugin (custom id, e.g.
  // `id("com.acme.kmp.benchmark")`) is invisible to the literal markers in
  // moduleHasBenchmarkPlugin — the same problem the coverage path solved
  // with build-logic descriptors. descriptor.appliedPlugins carries the ids
  // the convention class's apply() body activates; appending them to the
  // module content lets the existing markers + platform detection fire
  // unchanged. Lazy: descriptors parse only when a module's static markers
  // miss (zero cost for direct-application projects).
  let descriptors = null;
  const getDescriptors = () => {
    if (descriptors === null) {
      try { descriptors = parseBuildLogicPluginDescriptors(projectRoot); } catch { descriptors = []; }
    }
    return descriptors;
  };
  const out = [];
  for (const name of all) {
    if (!moduleFilterMatches(name, moduleFilter)) continue;
    const content = readBuildFile(projectRoot, name);
    let effective = content;
    if (content && !moduleHasBenchmarkPlugin(content)) {
      const appliedIds = [...content.matchAll(/id\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      const matched = getDescriptors().filter((d) => appliedIds.includes(d.pluginId));
      const expansion = matched
        .flatMap((d) => [d.pluginId, d.className, ...(d.appliedPlugins || [])])
        .join('\n');
      if (expansion) effective = `${content}\n${expansion}`;
    }
    if (!moduleHasBenchmarkPlugin(effective)) continue;
    out.push({ name, platforms: detectModulePlatforms(effective) });
  }
  return out;
}

// Task name builder — port of benchmark-detect.sh:197-220.
//
// `variant` parameter for Android benchmarks.
// JVM benchmarks are variant-agnostic (gradle's `desktopBenchmark` shape
// doesn't split by build type). For Android, explicit variant composes
// `connected${Variant}AndroidTest`; 'all' (default) maps to the umbrella
// `connectedAndroidTest`. 'auto' preserves the project-model's
// testBuildType-aware resolution.
function gradleTaskFor(moduleName, platform, config, projectModel = null, variant = 'auto') {
  if (platform === 'jvm') {
    if (config === 'smoke')  return `:${moduleName}:desktopSmokeBenchmark`;
    if (config === 'stress') return `:${moduleName}:desktopStressBenchmark`;
    return `:${moduleName}:desktopBenchmark`;
  }
  if (platform === 'android') {
    const v = (variant || 'auto').toLowerCase();
    // Explicit variant overrides project-model resolution.
    if (v === 'debug')   return `:${moduleName}:connectedDebugAndroidTest`;
    if (v === 'release') return `:${moduleName}:connectedReleaseAndroidTest`;
    if (v === 'all')     return `:${moduleName}:connectedAndroidTest`;
    // 'auto' — trust project-model's testBuildType-aware resolution; fall
    // back to the umbrella when the model has no signal (cold cache).
    const modKey = `:${moduleName}`;
    const resolved = projectModel?.modules?.[modKey]?.resolved;
    if (resolved?.deviceTestTask) return `:${moduleName}:${resolved.deviceTestTask}`;
    return `:${moduleName}:connectedAndroidTest`;
  }
  return `:${moduleName}:desktopBenchmark`;
}

// Test-filter resolution.
//
// Emit the combined single-arg shape
// `class=<FQN>#<method>` instead of separate `class=<FQN>` + `method=<m>`.
// The combined form is the canonical AGP/AndroidJUnitRunner shape that
// ALWAYS works (per BACKLOG.md L329); separate args silently miss the
// method filter under Microbenchmark (live repro on di-sample:
// 14 of 14 DiBenchmark methods ran instead of 1 with separate args).
function buildFilterArgs(platform, testFilter, projectRoot) {
  if (!testFilter) return [];
  if (platform === 'jvm') {
    // kotlinx-benchmark BenchmarkExec tasks reject gradle's `--tests`
    // (wet-confirmed: "Unknown command-line option '--tests'" →
    // module_failed) and expose no CLI / -P filter mechanism — filtering is
    // build-script DSL only (`benchmark { configurations { include(...) } }`).
    // The dispatch loop skips jvm (module, platform) cells when a filter is
    // set, so this branch only defends direct callers: never emit a flag
    // gradle will reject.
    return [];
  }
  // android: glob → FQN resolution upstream (resolveAndroidTestFilter walks
  // src/ trees). For literal FQNs, this is a no-op pass-through.
  const resolved = resolveAndroidTestFilter(testFilter, projectRoot) || testFilter;
  const { cls, method } = splitClassMethod(resolved);
  if (method) {
    return [`-Pandroid.testInstrumentationRunnerArguments.class=${cls}#${method}`];
  }
  return [`-Pandroid.testInstrumentationRunnerArguments.class=${cls}`];
}

// Main entrypoint
/**
 * Run the benchmark test orchestrator on a connected device.
 * No project-config param: benchmark consults env only (KMP_TEST_SKIP_ADB,
 * KMP_GRADLE_TIMEOUT_MS); config-file defaults reach it as injected flags via
 * cli.js#applyConfigDefaults like every other sub.
 * @param {object} opts
 * @param {string} opts.projectRoot - Absolute path to the gradle project root.
 * @param {string[]} [opts.args=[]] - CLI argv tail (post subcommand name).
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {Function} [opts.spawn=spawnSync] - Injected spawn for tests.
 * @param {Function} [opts.adbProbe=defaultAdbProbe] - adb device probe (injected for tests).
 * @param {Function} [opts.log=() => {}] - Log sink.
 * @returns {Promise<{envelope:object, exitCode:number}>}
 */
export async function runBenchmark({
  projectRoot,
  args = [],
  env = process.env,
  spawn = spawnSync,           // injectable for tests
  adbProbe = defaultAdbProbe,  // injectable for tests
  log = () => {},              // human-banner sink (runner.js wires console)
  // Test-only override: deterministic run-id for log-path
  // assertions. Mirrors android-orchestrator.js.
  runId = defaultRunId(),
}) {
  const startTime = Date.now();

  // Strip + parse `--isolated*` flags BEFORE parseArgs. Each
  // (module, platform) gradle spawn below receives --project-cache-dir.
  const isolatedFlags = parseIsolatedArgs(args);
  const opts = parseArgs(isolatedFlags.args);

  // Exit 2 BEFORE gradle work when parseArgs (or the
  // isolated-flag strip above) collected validation errors.
  const invalidArgs = [...isolatedFlags.errors, ...(opts.errors || [])]
    .filter(e => e.code && e.code.startsWith('invalid_'));
  if (invalidArgs.length > 0) {
    const envelope = buildInvalidArgsEnvelope({
      subcommand: 'benchmark',
      projectRoot,
      durationMs: Date.now() - startTime,
      errors: invalidArgs,
    });
    return { envelope, exitCode: EXIT.CONFIG_ERROR };
  }

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
        variant: opts.variant,
      },
    });
    envelope.benchmark = buildBenchmarkBlock({
      config: opts.config,
      timeoutMs: resolveBenchmarkTimeoutMs(opts.config, env, opts),
    });
    envelope.isolated = isolatedField;
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
    envelope.isolated = isolatedField;
    if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });
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
    envelope.isolated = isolatedField;
    if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });
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

  // Per-task gradle logs at
  // `<projectRoot>/.kmp-test-runner/logs/benchmark/<runId>/<module>-<plat>.log`.
  // Mirrors android-orchestrator.js artifact-subdir layout so a single
  // `.kmp-test-runner/` gitignore covers both. Surfaced on envelope via
  // `benchmark.log_paths` map (success + failure + timeout) and inline on
  // `errors[].log_path` for failures.
  const logDir = path.join(projectRoot, '.kmp-test-runner', 'logs', 'benchmark', runId);
  try { mkdirSync(logDir, { recursive: true }); } catch { /* best-effort */ }
  log(`Logs: ${logDir}`);
  log('');
  const logPathsMap = {};

  let jvmFilterSkips = 0;
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
      // jvm leg with --test-filter → skip. kotlinx-benchmark tasks reject
      // gradle's `--tests` and expose no CLI/-P filter; running the leg
      // UNFILTERED would dispatch the full benchmark suite the user
      // explicitly narrowed (hours on real composites). Skip honors intent:
      // never run un-narrowed work, never pass a flag gradle rejects. The
      // android leg keeps filtering via -P instrumentation args.
      if (plat === 'jvm' && opts.testFilter) {
        const reason = '--test-filter not supported by kotlinx-benchmark jvm tasks';
        log(`  [SKIP] ${mod.name} (${plat}) — ${reason}`);
        state.skipped.push({ module: mod.name, reason: `(${plat}) ${reason}` });
        state.tests.skipped++;
        jvmFilterSkips++;
        continue;
      }

      const task = gradleTaskFor(mod.name, plat, opts.config, projectModel, opts.variant);
      const filterArgs = buildFilterArgs(plat, opts.testFilter, projectRoot);
      // Default `--no-configuration-cache` for benchmark
      // dispatch. Root cause: kotlinx-benchmark caches `%TEMP%` inside its
      // gradle configuration cache; a stale TEMP path produces a silent
      // 2.2s FileNotFoundException FAIL on Windows. The flag bypasses the
      // cache so kotlinx-benchmark re-resolves a fresh TEMP each run.
      // Cost: ~5-10s config-cache miss per benchmark task. Users can
      // override with `--gradle-args "--configuration-cache"` (appended
      // LAST below, so gradle last-wins gives them what they asked for).
      let gradleArgs = [task, ...filterArgs, '--continue', '--no-configuration-cache'];
      // Append --gradle-args tokens LAST so they win on duplicate
      // flags (gradle last-wins). user `--gradle-args
      // "--configuration-cache"` overrides the default disabled state.
      if (opts.gradleArgs && opts.gradleArgs.length > 0) gradleArgs.push(...opts.gradleArgs);
      // `--isolated` injects gradle's --project-cache-dir <tmp>.
      gradleArgs = injectProjectCacheDir(gradleArgs, isolatedDir);

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

      // Aggregates only feed the discriminator pass; full per-(module,
      // platform) output is persisted to logFile below. Tail-cap so a long
      // benchmark matrix can't pin N×64 MB in memory.
      capturedAllStdout = tailTruncate(capturedAllStdout + ((result && result.stdout) || '') + '\n', AGGREGATE_OUTPUT_CAP);
      capturedAllStderr = tailTruncate(capturedAllStderr + ((result && result.stderr) || '') + '\n', AGGREGATE_OUTPUT_CAP);

      platformsThatRan.add(plat);

      // Persist per-(module, platform) gradle stdout+stderr
      // to disk (best-effort; failures here never abort the run) and record
      // the path for envelope surfacing via benchmark.log_paths map below.
      const logFile = path.join(logDir, `${safeModuleName(mod.name)}-${plat}.log`);
      const logContent = ((result && result.stdout) || '')
        + '\n--- STDERR ---\n'
        + ((result && result.stderr) || '');
      try { writeFileSync(logFile, logContent, 'utf8'); } catch { /* best-effort */ }
      logPathsMap[`${mod.name}:${plat}`] = logFile;

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
          log_path: logFile,
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
        // Spawn-layer error (child never ran to completion — e.g.
        // ERR_CHILD_PROCESS_STDIO_MAXBUFFER) discriminates as spawn_error so
        // agents don't read it as an ordinary benchmark failure. Timeout
        // errors were already consumed by the gradle_timeout branch above.
        const spawnError = (result && result.error) || null;
        const errEntry = {
          code: spawnError ? 'spawn_error' : 'module_failed',
          module: mod.name,
          platform: plat,
          message: spawnError
            ? `[FAIL] ${mod.name} (${plat}) gradle child process error: ${spawnError.code || spawnError.message || spawnError}`
              + ((spawnError.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || spawnError.code === 'ENOBUFS')
                ? ' (output exceeded maxBuffer — raise KMP_GRADLE_MAXBUFFER_MB)'
                : '')
            : `[FAIL] ${mod.name} (${plat}) failed with exit code ${exitCode}.`,
          log_path: logFile,
        };
        if (spawnError) errEntry.errno = spawnError.code || null;
        state.errors.push(errEntry);
      }
    }
  }

  // One aggregate warning for all jvm filter-skips (mirrors the
  // partial_timeout shape below; per-module detail lives in skipped[]).
  if (jvmFilterSkips > 0) {
    state.warnings.push({
      code: 'test_filter_unsupported',
      platform: 'jvm',
      test_filter: opts.testFilter,
      skipped_modules: jvmFilterSkips,
      message: `--test-filter is not supported by kotlinx-benchmark jvm tasks; `
        + `${jvmFilterSkips} jvm leg(s) skipped. Run without --test-filter, use `
        + `--platform android, or filter via benchmark { configurations { include(...) } } `
        + `in the build script.`,
    });
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
  } else if (totalTimedOut > 0 && totalPass >= 1 && !opts.strictTimeouts) {
    // Graded partial-timeout. When at least one benchmark
    // module passed, soft-signal the timeouts via warnings[] and exit 0
    // instead of hard-failing the whole run. CI matrix users that need the
    // pre-graded behavior pass --strict-timeouts. The per-module
    // `gradle_timeout` errors[] entries stay; this aggregate warning
    // explains why we still exit 0 despite their presence.
    state.warnings.push({
      code: 'partial_timeout',
      message: `${totalTimedOut} module(s) timed out, but ${totalPass} passed. Exit 0 (graded). Use --strict-timeouts to restore exit 3 on any timeout.`,
      timed_out: totalTimedOut,
      passed: totalPass,
    });
    scriptStatus = EXIT.SUCCESS;
  } else if (totalTimedOut > 0) {
    // v0.8.0 — gradle_timeout surfaces as ENV_ERROR (not TEST_FAIL) so agents
    // can distinguish "build hung / config too tight" from "tests failed".
    // Also fires when
    // --strict-timeouts is set OR when zero modules passed (everything hung).
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
    // Per-(module, platform) log file paths keyed by
    // `<module>:<platform>`. Additive field; omitted from early-exit
    // envelope shapes (no_test_modules / instrumented_setup_failed) where
    // no module dispatched. Failure entries also carry `log_path` inline
    // on errors[i] for read-time ergonomics.
    log_paths: logPathsMap,
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
      isolated: isolatedField,
    },
  });

  // Cleanup the isolated cache dir on the way out (no-op when
  // --isolated wasn't enabled or policy says keep). Best-effort.
  if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });

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

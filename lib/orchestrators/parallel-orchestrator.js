// SPDX-License-Identifier: MIT
// lib/parallel-orchestrator.js — Node-side `kmp-test parallel` orchestrator
// (v0.8 PIVOT, sub-entry 5 — terminal step). Replaces the parallel codepath
// of scripts/{sh,ps1}/run-parallel-coverage-suite.{sh,ps1} (~2,600 LOC after
// the sub-entry 4 --skip-tests early-shim) with direct gradle dispatch and
// in-process result aggregation.
//
// PR-10 (refactor pre-v0.10): the per-leg dispatch + cascade-retry + result
// classification + envelope assembly logic was extracted to sub-modules
// under lib/orchestrators/parallel/{dispatch,cascade-retry,result-rollup}.js.
// This file is now the residual entry point + 12-step composition for
// runParallel + the in-process coverage call. All public symbols (parseArgs,
// pickGradleTaskFor, junitTestCountFor, classifyTaskResults, etc.) are
// re-exported from the sub-modules at the bottom of this file so existing
// importers (lib/runner.js, lib/changed-orchestrator.js,
// lib/parsers/script-output.js, tests/vitest/parallel-orchestrator.test.js,
// tests/vitest/e2e-spawn-gradle.test.js, tests/vitest/input-validation.test.js)
// keep working unchanged.
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
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { captureOnFailure } from './android-capture.js';
import {
  buildJsonReport,
  envErrorJson,
  buildDryRunReport,
  buildInvalidArgsEnvelope,
  applyErrorCodeDiscriminators,
  parseGradleTimeoutMs,
  parseGradleConfig,
  EXIT,
} from '../cli.js';
import { buildProjectModel } from '../project-model.js';
import {
  defaultAdbProbe,
  spawnGradle,
  parseIsolatedArgs,
  resolveIsolatedDir,
  cleanupIsolatedDir,
  shouldKeepIsolated,
  buildIsolatedField,
  splitCsv,
  matchModuleFilter,
  effectiveCoveragePlugin,
  effectiveHasFlavor,
} from './orchestrator-utils.js';
import { maybeAugmentEnvWithAndroidSdk } from '../android-sdk-catalogue.js';

import {
  parseArgs,
  discoverParallelModules,
  applyModuleFilters,
  canonicalModuleEntry,
  legsForAll,
  buildCoverageReportTasks,
  dispatchCoverageReports,
} from './parallel/dispatch.js';
import { executeLeg } from './parallel/cascade-retry.js';
import {
  demoteNoTestModulesAcrossLegs,
  decideExitCode,
  buildParallelParsed,
} from './parallel/result-rollup.js';

// `splitCsv`, `globToRegex`, and the dual-test
// glob matcher were lifted to `lib/orchestrator-utils.js` so android +
// benchmark + describe orchestrators share the same filter normalization.
// `matchAnyGlob` retained as a backwards-compat alias for tests + downstream
// consumers; new code should call `matchModuleFilter` directly.
const matchAnyGlob = matchModuleFilter;

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
// In-process coverage call (closes the subprocess hop)
// ---------------------------------------------------------------------------
async function runCoverageInProcess(projectRoot, opts, env, log, runCoverageInjection, runStartTime) {
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
  // Forward the chosen --flavor so the aggregation step reads the matching
  // per-variant AGP coverage XML (build/reports/coverage/test/<flavor>/<buildType>/).
  // When absent, coverage-orchestrator picks the first-flavor default per module
  // (the same representative the report-task dispatch chose).
  if (opts.flavor) coverageArgs.push('--flavor', opts.flavor);
  // Forward --output-file unconditionally; coverage-orchestrator treats the
  // historic default literal as its "use default tree" sentinel.
  if (opts.outputFile) {
    coverageArgs.push('--output-file', opts.outputFile);
  }
  const { envelope } = await runCoverage({
    projectRoot,
    args: coverageArgs,
    env,
    log,
    // Parent run started the clock before the tests ran; thread it so the
    // report Duration reflects the full run, not just this aggregation step.
    runStartTime,
    // Tests already ran on the dispatch path; mark so the report says
    // "Yes (via parallel)" instead of the skip-tests-default header.
    testsRan: true,
    originatingSubcommand: 'parallel',
  });
  // Surface coverage envelope errors[] (e.g.
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
/**
 * Run the parallel-tests orchestrator on a KMP / Android project.
 * @param {object} opts
 * @param {string} opts.projectRoot - Absolute path to the gradle project root.
 * @param {string[]} [opts.args=[]] - CLI argv tail (post subcommand name).
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {object|null} [opts.config=null] - Loaded kmp-test config or null.
 * @param {Function} [opts.spawn=spawnSync] - Injected spawn for tests.
 * @param {Function} [opts.log=() => {}] - Log sink.
 * @param {string} [opts.runId] - Run id used for envelope / cache paths.
 * @param {Function|null} [opts.runCoverageInjection=null] - Injected runCoverage for cascade-retry.
 * @param {Function|null} [opts.runBenchmarkInjection=null] - Injected runBenchmark for cascade-retry.
 * @param {Function} [opts.adbProbe=defaultAdbProbe] - adb device probe (injected for tests).
 * @returns {Promise<{envelope:object, exitCode:number}>}
 */
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

  // Strip + parse `--isolated*` flags BEFORE parseArgs so the
  // existing default-drop case doesn't have to know about them.
  const isolatedFlags = parseIsolatedArgs(args);
  const opts = parseArgs(isolatedFlags.args);

  // Exit 2 BEFORE gradle work when parseArgs
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

  // `--isolated` isolates Gradle's
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
    // Tag the originator so the report header says "No (--skip-tests)"
    // rather than the standalone-coverage default.
    return runCoverage({
      projectRoot, args, env, spawn, log, runId,
      testsRan: false,
      originatingSubcommand: 'parallel',
    });
  }

  // Resolve the isolated cache dir AFTER --skip-tests routes
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

  // Auto-respect org.gradle.parallel=false from project gradle.properties.
  // `sources.project` is true when the project has a gradle.properties file at all;
  // `parallel === false` is the resolved value (project overrides user-global, gradle
  // default is false). When both hold, drop the unconditional --parallel injection
  // in dispatchLeg. Escape hatches: set org.gradle.parallel=true in the project's
  // gradle.properties, or pass `--gradle-args "--parallel"` (last-wins via v0.9
  // gradle-args passthrough).
  const gradleCfg = parseGradleConfig(projectRoot);
  const parallelDropped = gradleCfg.sources.project && gradleCfg.parallel === false;
  opts.parallelDropped = parallelDropped;

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
    if (parallelDropped) envelope.gradle_config_applied = { parallel_dropped: true };
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
        capture_on_fail: opts.captureOnFail,
        capture_dir: opts.captureDir,
      },
    });
    envelope.isolated = isolatedField;
    if (parallelDropped) envelope.gradle_config_applied = { parallel_dropped: true };
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
  // Coverage envelope shape parity with android +
  // coverage orchestrators. Pre-fix `state.coverage` was {tool, missed_lines}
  // only; post-fix it carries the kover/jacoco module lists so agents can
  // pivot on coverage_plugin assignment without a separate `describe` call.
  // Populated below from `modules` (each carries `coveragePlugin` from the
  // project model — see discoverParallelModules).
  // Probe-backed classification: `discoverParallelModules` precomputes
  // `effectiveCoveragePlugin` (static coveragePlugin OR probe-derived
  // resolved.coverageTask), so root-convention jacoco/kover counts here too.
  const koverModules = modules.filter(m => effectiveCoveragePlugin(m) === 'kover').map(m => m.name);
  const jacocoModules = modules.filter(m => effectiveCoveragePlugin(m) === 'jacoco').map(m => m.name);
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

  // `--flavor <name>` against a project where
  // no module declares productFlavors {} now hard-fails as CONFIG_ERROR (2)
  // instead of emitting a soft warning. Pre-fix the
  // misconfiguration surfaced as `warnings[].code:'flavor_unused'` + exit 0,
  // which CI gates routinely missed; user typos in the flavor name silently
  // ran the default-flavor task. Hard-fail makes the contract explicit:
  // if you supply --flavor, you commit to the project actually having
  // flavors.
  // Fires for any flavor-affecting test type (androidUnit / androidInstrumented
  // / 'all') and runs before any gradle dispatch so we don't waste a build cycle.
  // The flavored-ness test is probe-aware (effectiveHasFlavor): a project whose
  // flavors are applied by a build-logic convention plugin reports static
  // hasFlavor=false on every module, so a bare-boolean check would mis-fire this
  // guard for a perfectly valid --flavor. Mirrors the no_test_modules
  // short-circuit shape below.
  const flavorAffectsLeg = opts.testType === 'androidUnit'
    || opts.testType === 'androidInstrumented'
    || opts.testType === 'all';
  const anyFlavored = modules.some(m => effectiveHasFlavor(m));
  if (opts.flavor && flavorAffectsLeg && !anyFlavored) {
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
    if (parallelDropped) envelope.gradle_config_applied = { parallel_dropped: true };
    if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });
    return { envelope, exitCode: EXIT.CONFIG_ERROR };
  }

  // Module-count zero — short-circuit. UX-2: when the user explicitly asked
  // for a --test-type AND --module-filter is the default `*` AND no
  // --exclude-modules was supplied, the cause is the test-type rejecting
  // every module — say so.
  if (modules.length === 0) {
    // Discriminate user-filter-miss
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
    if (parallelDropped) envelope.gradle_config_applied = { parallel_dropped: true };
    if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });
    return { envelope, exitCode: earlyExit };
  }

  // --list-only short-circuit. Mirrors android-orchestrator's
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
    if (parallelDropped) envelope.gradle_config_applied = { parallel_dropped: true };
    if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });
    return { envelope, exitCode: EXIT.SUCCESS };
  }

  // Flavored project + flavor-affecting leg + NO explicit --flavor → the unit /
  // instrumented dispatch falls back to the flavor-agnostic umbrella task (runs
  // EVERY flavor). That is the chosen default (always-correct, just slower), but
  // make it non-silent so agents/humans know timing + coverage reflect all
  // flavors and can narrow with --flavor. Skipped when the user explicitly asked
  // for --variant all (they opted into the umbrella).
  if (!opts.flavor && flavorAffectsLeg && anyFlavored && opts.androidVariant !== 'all') {
    const candidates = [...new Set(
      modules.flatMap(m => (Array.isArray(m.flavors) ? m.flavors : [])),
    )].sort();
    state.warnings.push({
      code: 'flavor_defaulted_umbrella',
      message: `project declares product flavors and no --flavor was supplied; running the flavor-agnostic umbrella task across all flavors (slower). Pass --flavor <name> (one of: ${candidates.join(', ') || 'unknown'}) to target a single flavor.`,
      candidates,
      test_type: opts.testType || '',
    });
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

  // `--device <serial>` validates
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
        if (parallelDropped) envelope.gradle_config_applied = { parallel_dropped: true };
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
          if (parallelDropped) envelope.gradle_config_applied = { parallel_dropped: true };
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

  // --capture-on-fail: forensic device capture (screenshot + UI-hierarchy dump
  // via adb) on instrumented-module failure. Reuses the `kmp-test android`
  // helper + its .kmp-test-runner/logs/android/<runId>/ tree. Only meaningful
  // when an instrumented leg runs (no-op otherwise — mirrors the other
  // androidInstrumented-only parity flags). The closure is threaded into
  // executeLeg → recordLegResults as an injected callback so the pure
  // result-rollup module never imports child_process directly. Best-effort:
  // captureOnFailure never throws and the result is additive on errors[], so
  // the exit code is unaffected. Emulators are first-class — adb -s <serial>
  // is identical for `emulator-5554` and a physical serial.
  let captureFn = null;
  if (opts.captureOnFail && hasInstrumentedLeg) {
    const defaultCaptureDir = path.join(projectRoot, '.kmp-test-runner', 'logs', 'android', runId);
    const captureDir = opts.captureDir
      ? path.resolve(projectRoot, opts.captureDir)
      : defaultCaptureDir;
    try { mkdirSync(captureDir, { recursive: true }); } catch { /* best-effort */ }
    log(`Capture dir: ${captureDir}`);
    captureFn = (moduleName) => captureOnFailure({
      deviceSerial: resolvedDeviceSerial,   // '' when no device → helper returns capture_error
      outDir: captureDir,
      safeName: moduleName.replace(/:/g, '_'),
      spawn,
    });
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
      capture: captureFn,
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
    // Surface resolved device.serial on
    // androidInstrumented legs when --device was supplied. Field absent on
    // other legs (clean envelope; agents branch on field presence).
    if (leg === 'androidInstrumented' && resolvedDeviceSerial) {
      legEntry.device = { serial: resolvedDeviceSerial };
    }
    // Surface auto-retry telemetry.
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
  //     PR-10: extracted to result-rollup.demoteNoTestModulesAcrossLegs.
  // ---------------------------------------------------------------
  demoteNoTestModulesAcrossLegs(state, opts, legResults);

  // ---------------------------------------------------------------
  // 10. Discriminator pass — upgrade gradle errors to canonical codes.
  // ---------------------------------------------------------------
  applyErrorCodeDiscriminators(allStdout, allStderr, state);

  // ---------------------------------------------------------------
  // 11-pre. Generate coverage reports. The test legs above ran the test
  //     tasks but NOT the jacoco/kover report tasks — those are SEPARATE
  //     gradle tasks (jacocoTestReport depends on testDebugUnitTest, etc.)
  //     and nothing else dispatches them. Run the probe-resolved report
  //     tasks now: the test tasks are UP-TO-DATE, so gradle only writes the
  //     XML that step 11 reads. Skipped for --coverage-tool none and the
  //     --skip-tests / --coverage-only pure-aggregation paths. Non-fatal —
  //     a report failure warns but never flips a green test run red.
  //
  //     Gated to unit-coverage-bearing legs: jacocoTestReport /
  //     koverXmlReport{,Debug,Desktop} aggregate the UNIT test task, so an
  //     ios/macos/js/androidInstrumented-only run never produced that data —
  //     dispatching there would wastefully trigger an unrelated test task.
  //     A plain `parallel` (auto leg ''), `--test-type all`, or an explicit
  //     common/desktop/androidUnit run all qualify.
  // ---------------------------------------------------------------
  const UNIT_COVERAGE_LEGS = new Set(['', 'common', 'desktop', 'androidUnit']);
  const ranUnitCoverageLeg = legs.some(l => UNIT_COVERAGE_LEGS.has(l));
  if (opts.coverageTool !== 'none' && !opts.skipTests && ranUnitCoverageLeg) {
    const coverageTasks = buildCoverageReportTasks(modules, opts);
    if (coverageTasks.length > 0) {
      log('');
      const cr = dispatchCoverageReports({
        spawn, gradlewPath, projectRoot, taskList: coverageTasks,
        opts, env: dispatchEnv, log, isolatedDir,
      });
      allStdout += cr.stdout + '\n';
      allStderr += cr.stderr + '\n';
      if (cr.exit !== 0) {
        state.warnings.push({
          code: 'coverage_report_dispatch_failed',
          message: `Coverage report task(s) exited ${cr.exit}; some module XML may be missing`,
        });
      }
    }
  }

  // ---------------------------------------------------------------
  // 11. In-process coverage call (replaces subprocess hop).
  //     Skipped when --no-coverage / --coverage-tool none.
  // ---------------------------------------------------------------
  if (opts.coverageTool !== 'none') {
    try {
      const cov = await runCoverageInProcess(projectRoot, opts, env, log, runCoverageInjection, startTime);
      if (cov && cov.coverage) state.coverage = cov.coverage;
      // Propagate coverage envelope errors
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
  //     Exit code policy + parsed shape extracted to result-rollup
  //     during PR-10 (decideExitCode + buildParallelParsed).
  // ---------------------------------------------------------------
  const exitCode = decideExitCode(state);
  const parsed = buildParallelParsed({
    state, opts, legResults, isolatedField, resolvedDeviceSerial,
  });
  const envelope = buildJsonReport({
    subcommand: 'parallel',
    projectRoot,
    exitCode,
    durationMs: Date.now() - startTime,
    parsed,
  });
  if (parallelDropped) envelope.gradle_config_applied = { parallel_dropped: true };

  // Cleanup the isolated cache dir on the way out (no-op when
  // --isolated wasn't enabled or the policy says keep). Best-effort: errors
  // are swallowed so a transient FS issue doesn't fail an otherwise-green run.
  if (isolatedDir) cleanupIsolatedDir(isolatedDir, { userSupplied: isolatedUserSupplied, env });

  return { envelope, exitCode };
}

// ---------------------------------------------------------------------------
// Back-compat re-exports — preserve every public symbol at this path so
// existing importers (lib/runner.js, lib/changed-orchestrator.js,
// lib/parsers/script-output.js, the 3 vitest test files) keep working
// unchanged after PR-10's split.
// ---------------------------------------------------------------------------
export {
  parseArgs,
  expandNoCoverageAlias,
  discoverParallelModules,
  hasAnyTestSourceSet,
  applyModuleFilters,
  partitionBySkipEnv,
  canonicalModuleEntry,
  isInstrumentedOnly,
  pickGradleTaskFor,
  legsForAll,
  buildFilterArgs,
  buildCoverageReportTasks,
} from './parallel/dispatch.js';
export { classifyTaskResults } from './parallel/result-rollup.js';
export { splitCsv, globToRegex } from './orchestrator-utils.js';
export {
  junitTestCountFor,
  junitTestFailuresFor,
  extractTestcaseFailures,
} from '../parsers/junit-xml.js';
export { matchAnyGlob, defaultRunId };

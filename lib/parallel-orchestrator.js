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
  applyErrorCodeDiscriminators,
  parseGradleTimeoutMs,
  EXIT,
} from './cli.js';
import { buildProjectModel } from './project-model.js';
import { defaultAdbProbe, spawnGradle } from './orchestrator-utils.js';
import { maybeAugmentEnvWithAndroidSdk } from './android-sdk-catalogue.js';

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
    freshDaemon: false,
    outputFile: 'coverage-full-report.md',
    coverageOnly: false,
    benchmark: false,
    benchmarkConfig: 'smoke',
    // 2026-05-03 — Android variant selector. Default 'auto' picks Debug if
    // its task exists, falls back to Release (handles `testBuildType =
    // "release"` projects like dipatternsdemo `:benchmark`). Explicit
    // values: 'debug', 'release', 'all' (dispatches both as separate tasks
    // in the same gradle invocation).
    androidVariant: 'auto',
  };
  const expanded = expandNoCoverageAlias(argv);
  for (let i = 0; i < expanded.length; i++) {
    const a = expanded[i];
    switch (a) {
      case '--include-shared':     out.includeShared = true; break;
      case '--test-type':          out.testType = expanded[++i] || ''; out.testTypeExplicit = true; break;
      case '--module-filter':      out.moduleFilter = expanded[++i] || '*'; break;
      case '--test-filter':        out.testFilter = expanded[++i] || ''; break;
      case '--max-workers':        out.maxWorkers = +(expanded[++i] || 0); break;
      case '--coverage-tool':      out.coverageTool = expanded[++i] || 'auto'; break;
      case '--coverage-modules':   out.coverageModules = expanded[++i] || ''; break;
      case '--min-missed-lines':   out.minMissedLines = +(expanded[++i] || 0); break;
      case '--exclude-coverage':   out.excludeCoverage = expanded[++i] || ''; break;
      case '--exclude-modules':    out.excludeModules = expanded[++i] || ''; break;
      case '--include-untested':   out.includeUntested = true; break;
      case '--timeout':            out.timeout = +(expanded[++i] || 600); break;
      case '--skip-tests':         out.skipTests = true; break;
      case '--dry-run':            out.dryRun = true; break;
      case '--fresh-daemon':       out.freshDaemon = true; break;
      case '--output-file':        out.outputFile = expanded[++i] || 'coverage-full-report.md'; break;
      case '--coverage-only':      out.coverageOnly = true; break;
      case '--benchmark':          out.benchmark = true; break;
      case '--benchmark-config':   out.benchmarkConfig = expanded[++i] || 'smoke'; break;
      case '--variant':
      case '--android-variant':    out.androidVariant = (expanded[++i] || 'auto').toLowerCase(); break;
      default: /* unknown — drop, runner.js already stripped globals */ break;
    }
  }
  return out;
}

// --no-coverage is sugar for --coverage-tool none.
function expandNoCoverageAlias(argv) {
  const out = [];
  for (const a of argv) {
    if (a === '--no-coverage') out.push('--coverage-tool', 'none');
    else out.push(a);
  }
  return out;
}

function splitCsv(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}

// Glob matcher: `*` and `?` only (matches the bash wrapper's `case` glob).
// `*:api,*-api,build-logic` style commas split into N patterns OR'd together.
function globToRegex(pattern) {
  let re = '^';
  for (const ch of pattern) {
    if (ch === '*')      re += '.*';
    else if (ch === '?') re += '.';
    else if (/[\\^$+.()|[\]{}]/.test(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp(re + '$');
}
function matchAnyGlob(name, patternsCsv) {
  const patterns = splitCsv(patternsCsv);
  if (patterns.length === 0) return false;
  for (const pat of patterns) {
    if (globToRegex(pat).test(name)) return true;
    // Also try with a leading-colon variant (`:api` vs `api`) since project
    // module names can be either form depending on settings.gradle.kts shape.
    if (globToRegex(pat).test(':' + name)) return true;
  }
  return false;
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
      sourceSets: entry.sourceSets ?? {},
      coveragePlugin: entry.coveragePlugin ?? null,
      resolved: entry.resolved ?? null,
      testBuildType: entry.testBuildType ?? null,
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
  // globs. Match against full colon-name and the short suffix. Modules
  // dropped by --module-filter are NOT surfaced in skipped[] (the user
  // explicitly narrowed the set; this matches benchmark/changed conventions).
  if (opts.moduleFilter && opts.moduleFilter !== '*') {
    kept = kept.filter(m => {
      const short = m.name.split(':').pop();
      return matchAnyGlob(m.name, opts.moduleFilter)
          || matchAnyGlob(short, opts.moduleFilter);
    });
  }

  // --exclude-modules: glob list. Surfaced in skipped[] with reason
  // (preserves wrapper [SKIP] banner contract for visibility).
  if (opts.excludeModules) {
    const survivors = [];
    for (const m of kept) {
      const short = m.name.split(':').pop();
      if (matchAnyGlob(m.name, opts.excludeModules) || matchAnyGlob(short, opts.excludeModules)) {
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
function partitionBySkipEnv(modules, testType, env) {
  const skipped = [];
  const kept = [];
  let envVar = '';
  let label = '';
  if (testType === 'desktop' || testType === 'common') {
    envVar = env.SKIP_DESKTOP_MODULES || ''; label = 'desktop';
  } else if (testType === 'ios') {
    envVar = env.SKIP_IOS_MODULES || ''; label = 'ios';
  } else if (testType === 'macos') {
    envVar = env.SKIP_MACOS_MODULES || ''; label = 'macos';
  } else if (testType === 'androidUnit' || testType === 'androidInstrumented') {
    envVar = env.SKIP_ANDROID_MODULES || ''; label = 'android';
  }
  const skipNames = new Set(splitCsv(envVar));
  for (const m of modules) {
    const short = m.name.split(':').pop();
    if (skipNames.has(short) || skipNames.has(m.name)) {
      skipped.push({ module: m.name, reason: `SKIP_${label.toUpperCase()}_MODULES (${envVar})` });
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
      if (mod.type !== 'android' && !mod.androidDsl) {
        return { task: null, reason: 'no androidUnit target' };
      }
      return { task: androidUnitTask(gradlePath, opts.androidVariant, mod), reason: '' };
    }
    case 'androidInstrumented': {
      const t = r.deviceTestTask;
      if (t) return { task: `${gradlePath}:${t}`, reason: '' };
      // Probe missed but module declares an Android target — fall back to the
      // canonical instrumented task name (legacy wrapper behavior preserved).
      if (mod.type === 'android' || mod.androidDsl) {
        return { task: `${gradlePath}:connectedDebugAndroidTest`, reason: '' };
      }
      return { task: null, reason: 'no androidInstrumented target' };
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
        // Repro: dipatternsdemo `:benchmark` is an instrumented-only module
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
      if (!t) return { task: null, reason: 'no resolvable test task' };
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
// Junit-XML walk for individual test count (closes WS-8 additively)
// ---------------------------------------------------------------------------
// task path: `:foo:bar:baz` → module dir `foo/bar`, task short name `baz`.
// XML location: <projectRoot>/<modulePath>/build/test-results/<taskShort>/TEST-*.xml
//
// Stale-XML guard (added 2026-05-03 after the EINVAL incident exposed
// ~10K junit XMLs from prior bash-wrapper-era runs being counted as if
// produced this run): when `sinceMs` is provided, only files with
// `mtime >= sinceMs` are counted. Default 0 keeps backward compat for
// any external caller (this function is exported for tests).
function junitTestCountFor(projectRoot, taskColonPath, sinceMs = 0) {
  // Strip leading colon, split into segments.
  const segs = taskColonPath.replace(/^:/, '').split(':');
  if (segs.length < 2) return 0;
  const taskShort = segs.pop();
  const modPath = path.join(projectRoot, ...segs);
  const dir = path.join(modPath, 'build', 'test-results', taskShort);
  if (!existsSync(dir)) return 0;
  let count = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.startsWith('TEST-') || !e.name.endsWith('.xml')) continue;
    const filePath = path.join(dir, e.name);
    if (sinceMs > 0) {
      try {
        const st = statSync(filePath);
        if (st.mtimeMs < sinceMs) continue;
      } catch { continue; }
    }
    let xml;
    try { xml = readFileSync(filePath, 'utf8'); } catch { continue; }
    // Match <testcase ...> occurrences (self-closing or with body). Cheap
    // regex parse — no XML parser needed since gradle's junit XML is simple.
    const matches = xml.match(/<testcase\b/g);
    if (matches) count += matches.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Per-leg gradle dispatch — single invocation, all tasks at once
// ---------------------------------------------------------------------------
function dispatchLeg({
  spawn, gradlewPath, projectRoot, taskList, opts, env, log,
}) {
  const gradleArgs = [...taskList, '--parallel', '--continue'];
  if (opts.maxWorkers > 0) gradleArgs.push(`--max-workers=${opts.maxWorkers}`);
  if (opts.testFilter) gradleArgs.push('--tests', opts.testFilter);

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
  spawn, gradlewPath, projectRoot, modules, testType, opts, env, log, state, runCoverageInjection,
}) {
  // Step 1 — partition by SKIP_*_MODULES env.
  const { kept, skipped: envSkipped } = partitionBySkipEnv(modules, testType, env);
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

  // Step 3 — empty post-filter → emit no_test_modules error (UX-2).
  if (taskList.length === 0) {
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
    });
    return { stdout: '', stderr: '', exit: 0 };
  }

  // Step 4 — dispatch the gradle leg (one-shot, fast path).
  let { exit, stdout, stderr } = dispatchLeg({
    spawn, gradlewPath, projectRoot, taskList, opts, env, log,
  });

  // Step 4a — cascade-isolation fallback. When the leg exited non-zero AND
  // gradle's stdout shows ZERO evidence that any of our tasks ran (no
  // `> Task :foo:bar` mention, no `<task> FAILED` marker), the build
  // aborted at evaluation phase before reaching the executor. With
  // `--continue` + multi-module dispatch this means ONE module's
  // configuration error cascades all N tasks into a misleading "all
  // failed" — a passing `:shared:jvmTest` gets reported FAIL just because
  // it shares the leg with a broken `:androidApp:test` (Confetti repro,
  // wide-smoke 2026-05-03).
  //
  // Per-module classification (2026-05-03 v2): we MUST classify each retry
  // independently — merging stdout/stderr and re-running classifyTaskResults
  // over the aggregate corrupts results when ONE retry has `Cannot locate`
  // (taints `resolutionFailed` for ALL modules, repro: shared-kmp-libs where
  // 36 of 37 modules' individual `:foo:desktopTest` succeeded but the global
  // classifier marked them all failed because one retry had a missing task).
  // Pre-classified results bypass step 5's global classifier.
  let preClassified = null;
  if (exit !== 0 && taskList.length > 1) {
    const all0 = stdout + '\n' + stderr;
    const anyTaskMentioned = taskList.some(t => {
      const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('Task\\s+' + escaped + '(\\s|$)').test(all0)
          || new RegExp(escaped + '\\s+FAILED').test(all0);
    });
    if (!anyTaskMentioned) {
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
          spawn, gradlewPath, projectRoot, taskList: [task], opts, env,
          log: (l) => log(`      ${owner}: ${l}`),
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
    }
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
  // Per-task execution-mode classification — feeds the per-leg `execution`
  // summary in the envelope so consumers can detect cache-only-greens.
  const execModes = classifyTaskExecutionMode(stdout, stderr, taskList);
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
    // WS-9: populate modules[] from the modules that participated, NOT keyed
    // off coverage data presence.
    if (!state.modules.includes(mod)) state.modules.push(mod);
    // WS-8 additive: junit-XML walk for individual test count. Stale-XML
    // guard: only count XMLs produced after this run started.
    state.tests.individual_total += junitTestCountFor(projectRoot, task, state.runStartMs);
  }

  return { stdout, stderr, exit, execution: summarizeExecutionModes(execModes) };
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
  return envelope.coverage || null;
}

// ---------------------------------------------------------------------------
// Main entrypoint — invoked by lib/runner.js when sub === 'parallel'.
// ---------------------------------------------------------------------------
export async function runParallel({
  projectRoot,
  args = [],
  env = process.env,
  spawn = spawnSync,
  log = () => {},
  runId = defaultRunId(),
  // Test-only overrides (not exposed to callers in production).
  runCoverageInjection = null,
  runBenchmarkInjection = null,
  adbProbe = defaultAdbProbe,
}) {
  const startTime = Date.now();
  const opts = parseArgs(args);

  // ---------------------------------------------------------------
  // 1. --skip-tests early delegate to coverage-orchestrator.
  //    Collapses `coverage = parallel --skip-tests` into Node and
  //    removes the last subprocess hop for `kmp-test coverage` callers
  //    that arrive via the parallel entrypoint.
  // ---------------------------------------------------------------
  if (opts.skipTests) {
    const { runCoverage } = runCoverageInjection
      ? { runCoverage: runCoverageInjection }
      : await import('./coverage-orchestrator.js');
    return runCoverage({ projectRoot, args, env, spawn, log, runId });
  }

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
  const state = {
    tests: { total: 0, passed: 0, failed: 0, skipped: 0, individual_total: 0 },
    modules: [],
    skipped: [],
    coverage: { tool: opts.coverageTool, missed_lines: null },
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

  // Module-count zero — short-circuit. UX-2: when the user explicitly asked
  // for a --test-type AND --module-filter is the default `*` AND no
  // --exclude-modules was supplied, the cause is the test-type rejecting
  // every module — say so.
  if (modules.length === 0) {
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

  let allStdout = '';
  let allStderr = '';
  const legResults = [];

  for (const leg of legs) {
    log('');
    log(`---- Leg: ${leg || 'auto'} ----`);
    const r = await executeLeg({
      spawn, gradlewPath, projectRoot, modules, testType: leg, opts, env: dispatchEnv, log,
      state, runCoverageInjection,
    });
    allStdout += r.stdout + '\n';
    allStderr += r.stderr + '\n';
    legResults.push({
      test_type: leg || 'auto',
      exit_code: r.exit,
      execution: r.execution || {
        fresh: 0, up_to_date: 0, from_cache: 0, no_source: 0,
        skipped_by_gradle: 0, failed: 0, no_evidence: 0,
      },
    });
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
      if (cov) state.coverage = cov;
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
  //     Exit code policy:
  //     - ENV_ERROR (3) for environmental failures: no_test_modules,
  //       platform_unsupported, task_not_found, instrumented_setup_failed,
  //       unsupported_class_version (mirrors legacy wrapper's exit 3 path).
  //     - TEST_FAIL (1) for module_failed / any test failure.
  //     - SUCCESS (0) otherwise.
  // ---------------------------------------------------------------
  // ENV_ERROR (3) reserved for cases where the test harness can't even
  // attempt to execute: no modules to dispatch, host platform mismatch,
  // adb/instrumented setup failed. task_not_found + unsupported_class_version
  // map to TEST_FAIL (1) per the legacy wrapper contract (WS-5 invariant).
  const ENV_CODES = new Set(['no_test_modules', 'platform_unsupported',
    'instrumented_setup_failed']);
  const hasEnvError = state.errors.some(e => e && ENV_CODES.has(e.code));
  const hasTestFailure = state.tests.failed > 0
    || state.errors.some(e => e && (e.code === 'module_failed'
        || e.code === 'task_not_found'
        || e.code === 'unsupported_class_version'));
  let exitCode = EXIT.SUCCESS;
  if (hasEnvError)        exitCode = EXIT.ENV_ERROR;
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
  };
  const envelope = buildJsonReport({
    subcommand: 'parallel',
    projectRoot,
    exitCode,
    durationMs: Date.now() - startTime,
    parsed,
  });

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
  classifyTaskResults,
  defaultRunId,
};

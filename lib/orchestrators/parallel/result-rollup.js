// SPDX-License-Identifier: MIT
// lib/orchestrators/parallel/result-rollup.js — PR-10 extraction from
// lib/parallel-orchestrator.js. Owns: gradle output classifiers (per-task
// pass/fail + per-task execution mode), per-leg result recording (state
// mutation + junit-XML walk + execSummary realignment), F2 cross-leg
// `no_test_modules` demotion, parallel envelope shape assembly, exit-code
// policy. Pure file-move + helper extraction (no behavior change).
//
// SAFETY: this module does NOT import node:child_process and does NOT
// invoke any shell. Pure data transformations over already-collected
// stdout/stderr strings + state mutation. The ONE optional side-effect —
// --capture-on-fail device capture — is reached only through an injected
// `capture` callback (built by runParallel from the threaded spawn, like the
// injected `log`); this module never imports the adb/fs capture helper itself,
// so the no-child_process invariant holds.

import {
  junitTestCountFor,
  junitTestFailuresFor,
} from '../../parsers/junit-xml.js';
import { EXIT, classifyExitCode } from '../../cli.js';
import { canonicalModuleEntry } from './dispatch.js';

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
const EXECUTION_MODE_BY_SUFFIX = {
  '': 'fresh', 'UP-TO-DATE': 'up_to_date', 'FROM-CACHE': 'from_cache',
  'NO-SOURCE': 'no_source', SKIPPED: 'skipped_by_gradle', FAILED: 'failed',
};

function classifyTaskExecutionMode(stdout, stderr, taskList = null) {
  const all = stdout + '\n' + stderr;
  const out = new Map();
  if (taskList === null) {
    // Full attempt evidence is separate from requested-task execution telemetry.
    const re = /\bTask\s+(:\S+?)(?:\s+(UP-TO-DATE|FROM-CACHE|NO-SOURCE|SKIPPED|FAILED))?\s*$/gm;
    for (const match of all.matchAll(re)) {
      const task = match[1];
      const mode = EXECUTION_MODE_BY_SUFFIX[match[2] || ''];
      out.set(task, out.has(task) && out.get(task) !== mode ? 'no_evidence' : mode);
    }
    return out;
  }
  for (const task of taskList) {
    const escaped = task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match `> Task <name>` (or `Task <name>` mid-line) with optional status
    // suffix. Tolerant to trailing whitespace; multiline mode pins to line end.
    const re = new RegExp('Task\\s+' + escaped
      + '(?:\\s+(UP-TO-DATE|FROM-CACHE|NO-SOURCE|SKIPPED|FAILED))?\\s*$', 'm');
    const m = re.exec(all);
    if (!m) { out.set(task, 'no_evidence'); continue; }
    out.set(task, EXECUTION_MODE_BY_SUFFIX[m[1] || '']);
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

// PR-10 helper extracted from the per-task push loop in cascade-retry's
// per-leg routine (lines 1086-1197 of pre-PR-10 parallel-orchestrator.js).
// Mutates `state` by reference (the same contract observed inline before
// the extraction): pushes module_failed errors, updates tests counters,
// populates state.modules with canonical entries, walks junit-XML for
// test_failures + individual_total. Returns the (possibly-realigned)
// execSummary so the caller can thread it into the per-leg envelope;
// pre-PR-10 the alignment block reassigned execSummary in-place — we
// surface the new value via the return tuple to keep the caller free of
// double-mutation semantics.
function recordLegResults({
  taskList, taskOwners, results, execModes, execSummary,
  modules, state, projectRoot, log, resolutionFailed,
  resolutionFailedTasks = null,
  junitAttempts = null,
  // --capture-on-fail callback: (moduleName) => {screenshot_file, ui_hierarchy_file,
  // capture_error}. Non-null only on the androidInstrumented leg with the flag set
  // (cascade-retry gates it). Invoked once per still-failed module here — the
  // final-failure site, post-retry — so artifacts aren't re-captured per attempt.
  capture = null,
  // When true, the gradle process was killed by a spawn timeout (SIGTERM /
  // ETIMEDOUT). Skip junit-XML walk and module_failed; emit gradle_timeout
  // errors instead.
  timedOut = false,
  timeoutMs = 0,
}) {
  if (timedOut) {
    const timeoutSec = Math.round(timeoutMs / 1000);
    const moduleByTimeout = new Map(modules.map(m => [m.name, m]));
    for (let i = 0; i < taskList.length; i++) {
      const task = taskList[i];
      const mod = taskOwners[i];
      log(`  [TIMEOUT] ${mod}`);
      state.errors.push({
        code: 'gradle_timeout',
        module: mod,
        task,
        timeout_ms: timeoutMs,
        message: `[TIMEOUT] ${task} exceeded ${timeoutSec}s timeout`,
      });
      state.tests.total += 1;
      state.tests.failed += 1;
      let entry = state.modules.find(em => em.name === mod);
      if (!entry) {
        entry = canonicalModuleEntry(moduleByTimeout.get(mod) || { name: mod });
        state.modules.push(entry);
      }
    }
    return {
      fresh: 0, up_to_date: 0, from_cache: 0, no_source: 0,
      skipped_by_gradle: 0, failed: taskList.length, no_evidence: 0,
    };
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
      const taskResolutionFailed = resolutionFailed
        || (resolutionFailedTasks && resolutionFailedTasks.has(task));
      const suffix = taskResolutionFailed ? ' (task not found / build aborted at resolution)' : '';
      log(`  [FAIL] ${mod}${suffix}`);
      state.tests.failed += 1;
      const errEntry = {
        code: 'module_failed',
        module: mod,
        task,
        message: `[FAIL] ${mod}${suffix}`,
      };
      // --capture-on-fail: best-effort device screenshot + UI-hierarchy dump,
      // surfaced on this entry so an agent gets visual + structural context for
      // the failing instrumented module. Forensic-only — the injected callback
      // never throws and the fields are additive, so the exit code is
      // unaffected. Mirrors the `kmp-test android` orchestrator's call site.
      if (capture) {
        const cap = capture(mod);
        if (cap.screenshot_file)   errEntry.screenshot_file = cap.screenshot_file;
        if (cap.ui_hierarchy_file) errEntry.ui_hierarchy_file = cap.ui_hierarchy_file;
        if (cap.capture_error)     errEntry.capture_error = cap.capture_error;
      }
      state.errors.push(errEntry);
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
    // so the original protection against bash-wrapper-era leftovers
    // remains intact. Umbrella children use their own final-attempt modes and
    // cutoff, passed separately from this requested-task telemetry.
    const execMode = execModes.get(task);
    const cacheRespected = execMode === 'up_to_date' || execMode === 'from_cache';
    // Side-channel collector for oversized-XML skips (junit-xml.js size
    // guard). Per-task array — the count walk and the failures walk below
    // visit the SAME files, so entries are deduped by file before they
    // become warnings.
    const xmlAnomalies = [];
    const junitOptions = junitAttempts?.get(task);
    const taskTestcaseCount = junitTestCountFor(
      projectRoot,
      task,
      cacheRespected ? 0 : state.runStartMs,
      xmlAnomalies,
      junitOptions,
    );
    state.tests.individual_total += taskTestcaseCount;
    // When the task failed, walk JUnit XMLs to
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
        xmlAnomalies,
        junitOptions,
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
    // Surface oversized-XML skips as soft warnings (never affect the exit
    // code). The signal matters because every skipped file means
    // `tests.individual_total` undercounts and `test_failures[]` may be
    // incomplete for this task.
    if (xmlAnomalies.length > 0) {
      const seenFiles = new Set();
      for (const a of xmlAnomalies) {
        if (seenFiles.has(a.file)) continue;
        seenFiles.add(a.file);
        const sizeMb = Math.round(a.size / (1024 * 1024));
        const maxMb = Math.floor(a.maxBytes / (1024 * 1024));
        state.warnings.push({
          code: 'junit_xml_oversized',
          module: mod,
          task,
          file: a.file,
          size_bytes: a.size,
          max_mb: maxMb,
          message: `skipped oversized JUnit XML (${sizeMb} MB > ${maxMb} MB cap) — `
            + `test counts for ${task} undercount; raise KMP_JUNIT_XML_MAX_MB to include it`,
        });
      }
    }
  }

  // Align execSummary.failed with classifyTaskResults
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
    return aligned;
  }
  return execSummary;
}

// PR-10 helper extracted from runParallel step 9b (lines 1775-1791 of
// pre-PR-10 parallel-orchestrator.js). F2 demotion: when `--test-type all`
// dispatched multiple legs and at least one passed, per-leg
// `no_test_modules` errors are demoted to `no_test_modules_for_leg`
// warnings — they're expected (e.g. JVM-only project's `ios` leg) rather
// than environmental failures. Mutates `state.errors` and `state.warnings`
// in place to preserve the runParallel call-site contract.
function demoteNoTestModulesAcrossLegs(state, opts, legResults) {
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
}

// PR-10 helper extracted from runParallel step 12 (lines 1870-1902 of
// pre-PR-10 parallel-orchestrator.js). Exit-code policy now lives in
// classifyExitCode (lib/envelope/exit-codes.js) — the one central mapping
// point shared by parallel/android/benchmark — this is a thin wrapper so
// parallel-orchestrator.js's call site doesn't need to change.
function decideExitCode(state) {
  return classifyExitCode(state.errors, { testsFailed: state.tests.failed });
}

// PR-10 helper extracted from runParallel step 12 (lines 1903-1932 of
// pre-PR-10 parallel-orchestrator.js). Builds the `parsed` object that
// downstream `buildJsonReport` wraps into the envelope. Conditionally
// emits the `android:{}` block when at least one androidInstrumented leg
// dispatched (drift #3). All other fields surface unconditionally to
// preserve envelope shape stability across leg sets.
function buildParallelParsed({
  state, opts, legResults, isolatedField,
  resolvedDeviceSerial,
}) {
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
  return parsed;
}

export {
  classifyTaskExecutionMode,
  summarizeExecutionModes,
  classifyTaskResults,
  recordLegResults,
  demoteNoTestModulesAcrossLegs,
  decideExitCode,
  buildParallelParsed,
};

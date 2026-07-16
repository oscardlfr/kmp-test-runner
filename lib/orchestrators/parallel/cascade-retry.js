// SPDX-License-Identifier: MIT
// lib/orchestrators/parallel/cascade-retry.js — PR-10 extraction from
// lib/parallel-orchestrator.js. Owns: per-leg state machine — module-skip
// partitioning, task-list construction, one-shot gradle dispatch,
// cascade-isolation per-module retry (PR5 v0.8.0), --auto-retry loop with
// optional `adb shell pm clear` (--clear-data), gradle stdout
// noise filtering, handoff to result-rollup.recordLegResults for per-task
// state push. Pure file-move + recordLegResults extraction (no behavior
// change).
//
// SAFETY: no direct child_process import. All gradle dispatch goes through
// dispatch.dispatchLeg (which itself routes through orchestrator-utils
// spawnGradle). adb invocation is via the threaded `spawn` parameter
// (spawnSync injected by runParallel) — no shell interpolation.

import {
  partitionBySkipEnv,
  pickGradleTaskFor,
  dispatchLeg,
} from './dispatch.js';
import {
  classifyTaskExecutionMode,
  summarizeExecutionModes,
  classifyTaskResults,
  recordLegResults,
} from './result-rollup.js';
import { readPackageName } from '../orchestrator-utils.js';

// ---------------------------------------------------------------------------
// Per-leg execution: build task list, dispatch, collect results
// ---------------------------------------------------------------------------
async function executeLeg({
  spawn, gradlewPath, projectRoot, modules, testType, opts, env, config, log, state,
  // Resolved adb serial, threaded
  // by runParallel before the leg loop. Empty when not applicable
  // (no --device / --clear-data) or non-instrumented leg.
  deviceSerial = '',
  // Isolated `--project-cache-dir <tmp>` resolved by the
  // top-level runParallel; null when --isolated wasn't set. Threaded into
  // every dispatchLeg call so the bundled-leg + cascade-isolation retry +
  // --auto-retry single-task retry all hit the same disposable cache dir.
  isolatedDir = null,
  // --capture-on-fail closure built by runParallel (null when off / no
  // instrumented leg). Invoked once per still-failed module by
  // recordLegResults, AFTER cascade-isolation + --auto-retry settle, so it
  // reflects the final failed state (no per-attempt spam). Gated to the
  // androidInstrumented leg below before handing it to the pure rollup module.
  capture = null,
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
    const { task, reason, hint } = pickGradleTaskFor(mod, testType, opts);
    if (!task) {
      // UX-1: emit skipped[] entry with reason instead of dropping silently.
      const reasonText = `${reason} (--test-type=${testType || 'auto'})`;
      log(`  [SKIP] ${mod.name} (${reason})`);
      state.skipped.push({ module: mod.name, reason: reasonText });
      // Discoverability: a unit/auto leg skipped this module SOLELY because it
      // is instrumented-only (Compose-UI-only "no reports" bug, 2026-06-06).
      // Raise a structured pointer at --test-type androidInstrumented. Suppressed
      // for `--test-type all` (that run already targets the instrumented leg, so
      // the user isn't unaware of those tests). Deduped per module.
      if (hint === 'instrumented_only' && opts.testType !== 'all'
          && !state.warnings.some((w) => w.code === 'instrumented_only_skipped' && w.module === mod.name)) {
        state.warnings.push({
          code: 'instrumented_only_skipped',
          module: mod.name,
          message: `${mod.name} has only instrumented (androidTest) tests and was skipped by the unit-test leg. Run them with: kmp-test android  (or  kmp-test parallel --test-type androidInstrumented).`,
        });
      }
      continue;
    }
    taskList.push(task);
    taskOwners.push(mod.name);
  }

  // Step 3 — empty post-filter task list.
  //
  // When --module-filter
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
  // an earlier fix and is still tested below.
  //
  // Filter-actually-matched-nothing (modules === 0 from
  // `applyModuleFilters` upstream) still surfaces the error through
  // the runParallel-level guard at line 1348.
  if (taskList.length === 0) {
    if (modules.length > 0 && opts.testType !== 'all') {
      log('  All matched modules legitimately skipped for this leg; no gradle dispatch.');
      return { stdout: '', stderr: '', exit: 0 };
    }
    // `caused_by_filter` discriminator.
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
  let { exit, stdout, stderr, signal, spawnError } = dispatchLeg({
    spawn, gradlewPath, projectRoot, taskList, testType, opts, env, log, isolatedDir,
  });
  // Detect a gradle spawn timeout (POSIX: signal SIGTERM + null status;
  // Windows: spawnError.code ETIMEDOUT). Mirrors benchmark-orchestrator's
  // isGradleTimeout pattern. When true, cascade-isolation and auto-retry
  // are both skipped — retrying an infra timeout is never useful.
  const timedOut = opts.timeout > 0 && (
    signal === 'SIGTERM' ||
    (spawnError != null && spawnError.code === 'ETIMEDOUT')
  );

  // Step 4a — cascade-isolation fallback. When the leg exited non-zero AND
  // the per-task execution-mode summary shows ZERO `failed` tasks but
  // `no_evidence > 0`, gradle aborted at evaluation phase before reaching any
  // executor. With `--continue` + multi-module dispatch this means ONE
  // module's configuration error cascades all N tasks into a misleading "all
  // failed" — a passing `:shared:jvmTest` gets reported FAIL just because it
  // shares the leg with a broken `:androidApp:test` (Confetti repro,
  // wide-smoke 2026-05-03).
  //
  // The original cascade trigger relied on a permissive
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
  // Cascade signature refined from `failed===0 &&
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
  const cascadeDetected = !timedOut && exit !== 0
    && execSummary.no_evidence === taskList.length;
  let retryFired = false;
  let preClassified = null;
  let resolutionFailedTasks = null;
  if (cascadeDetected) {
    retryFired = true;
    log('');
    log('  [!] One-shot dispatch aborted before any task ran — retrying per-module');
    log('      to isolate which module(s) are broken...');
    preClassified = new Map();
    resolutionFailedTasks = new Set();
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
      if (/Cannot locate tasks? that match/.test(r.stdout + '\n' + r.stderr)) {
        resolutionFailedTasks.add(task);
      }
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
  // CRITICAL_SPECIFIC_RE matches lines that carry the actual diagnostic by
  // named pattern. CONTINUATION_RE is the generic `> ...` failure-block arm
  // (PeopleInSpace `> SDK location not found` was at column 0; gradle's
  // `> A failure occurred`, `> Could not resolve`, etc.). The generic arm is
  // tested LAST: pre-fix it lived inside one combined CRITICAL_RE tested
  // first, which shadowed EVERY `> Task ...` line — the STATUS_RE and
  // TASK_RUNNING_RE branches below were dead since 2026-05-03 (invisible
  // while critical lines were emitted uncapped; with the L6 cap the noise
  // would evict real diagnostics from the 50-line budget, so the trichotomy
  // had to actually work).
  const CRITICAL_SPECIFIC_RE = /FAILED$|^FAILURE:|^BUILD (FAILED|SUCCESSFUL)|^\* What went wrong:|^\* Where:|^\* Try:|UnsupportedClassVersionError|Failed to install|Cannot locate|requires Java|Android Gradle plugin requires|Plugin .* not found|Could not resolve all|Could not determine|^Caused by:|Compilation error|Execution failed for task|^[\d]+:\s+Task failed|There were failing tests|SDK location not found|sdk\.dir/;
  const CONTINUATION_RE = /^\s*>\s+\S/;
  const STATUS_RE = /^>\s*Task\s.*\b(UP-TO-DATE|NO-SOURCE|SKIPPED|FROM-CACHE)\b$/;
  const TASK_RUNNING_RE = /^>\s*Task\s/;
  // Bounded at PUSH time (not collect-all-then-slice): a pathological gradle
  // failure can emit thousands of matching lines per leg, and the arrays were
  // only bounded de facto by the leg's maxBuffer. Caps keep memory flat while
  // the emitted text stays byte-identical below them.
  const MAX_CRITICAL_LINES = 50;
  const MAX_TASKS_RUN_LINES = 30;
  const critical = [];
  const tasksRun = [];
  let criticalSuppressed = 0;
  let tasksRunTotal = 0;
  let statusNoiseCount = 0;
  const pushCritical = (line) => {
    if (critical.length < MAX_CRITICAL_LINES) critical.push(line);
    else criticalSuppressed++;
  };
  for (const line of allLines) {
    // Precedence: status-noise first (its suffix shape can never be a
    // diagnostic), then named critical patterns (catches `> Task :x FAILED`
    // via FAILED$), then plain task-running lines, then the generic `> ...`
    // continuation arm for non-Task failure-block lines.
    if (STATUS_RE.test(line)) {
      // Only the COUNT is ever emitted — no need to hold the lines.
      statusNoiseCount++;
    } else if (CRITICAL_SPECIFIC_RE.test(line)) {
      pushCritical(line);
    } else if (TASK_RUNNING_RE.test(line)) {
      tasksRunTotal++;
      if (tasksRun.length < MAX_TASKS_RUN_LINES) tasksRun.push(line);
    } else if (CONTINUATION_RE.test(line)) {
      pushCritical(line);
    }
  }
  // Emit critical lines first (the actionable diagnostic), capped.
  for (const line of critical) log(line);
  if (criticalSuppressed > 0) {
    log(`  (… ${criticalSuppressed} more critical lines suppressed — full output in the per-module log)`);
  }
  // Then up to 30 task-running lines (gives a sense of what executed).
  for (const line of tasksRun) log(line);
  if (tasksRunTotal > MAX_TASKS_RUN_LINES) {
    log(`  (… ${tasksRunTotal - MAX_TASKS_RUN_LINES} more "> Task" lines suppressed)`);
  }
  if (statusNoiseCount > 0) {
    log(`  (${statusNoiseCount} UP-TO-DATE/NO-SOURCE/SKIPPED status lines suppressed)`);
  }

  // Step 5 — classify per-task pass/fail and record per-module results.
  // When cascade-isolation pre-classified per-module (each retry classified
  // in isolation to avoid `Cannot locate` cross-contamination), use those
  // results directly instead of re-running the global classifier over the
  // merged stdout (which would re-introduce the cross-contamination bug).
  const all = stdout + '\n' + stderr;
  const resolutionFailed = preClassified ? false : /Cannot locate tasks? that match/.test(all);
  const results = preClassified || classifyTaskResults(stdout, stderr, taskList, exit);

  // `--auto-retry` re-dispatches
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
  if (opts.autoRetry && exit !== 0 && !cascadeDetected && !timedOut
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

  // Step 5 (cont) — record per-task pass/fail into state, walk junit-XML
  // for individual_total + test_failures, realign execSummary.failed.
  // Extracted into result-rollup.recordLegResults during PR-10; same state
  // mutation contract observed by reference (see helper docstring).
  execSummary = recordLegResults({
    taskList, taskOwners, results, execModes, execSummary,
    modules, state, projectRoot, log, resolutionFailed, resolutionFailedTasks,
    // Only the instrumented leg captures device artifacts; pass null otherwise
    // so the rollup's module_failed branch stays a no-op for unit/native legs.
    capture: testType === 'androidInstrumented' ? capture : null,
    timedOut,
    timeoutMs: opts.timeout > 0 ? opts.timeout * 1000 : 0,
  });

  return {
    stdout, stderr, exit, execution: execSummary, cascadeDetected, retryFired,
    // Surface auto-retry telemetry
    // up to runParallel so legResults can carry per-leg retries + pre-run
    // actions. Empty arrays (not undefined) keep the envelope shape stable.
    retries, preRunActions, timedOut,
  };
}

export { executeLeg };

#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/matrix-runner.mjs -- shared-resource acquisition, single-condition execution,
// and scenario-matrix orchestration.
//
// Extracted from cli.mjs's runConditionPair (calibrate/smoke's engine) so a scenario-matrix run
// (repeated pairs, not just one) can reuse the exact same acquisition/spawn/parse machinery
// without duplicating it. runConditionPair itself becomes a thin two-call wrapper around
// runSingleCondition with the fixed current-skill-then-no-skill order preserved verbatim -- its
// external behavior, including the exact incremental-cleanup-on-partial-failure contract
// regression-tested by agentic-eval-run-condition-pair.test.js, is unchanged.
//
// Deliberately self-contained (no import from cli.mjs) to avoid a circular import -- cli.mjs
// imports FROM this module. Anything cli.mjs-specific (PINNED_SKILL_SHA, REPO_ROOT,
// TARGET_SKILL_NAME, the plugin validator) is threaded in as an explicit parameter instead.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { buildPathShim } from './path-shim.mjs';
import { materializeSkillSnapshot, materializeGradleUserHome, realpath } from './materialize.mjs';
import { buildBaseArgv, buildConditionArgv, buildSharedEnv, buildPolicySettingsFile, spawnCondition } from './condition-launcher.mjs';
import { parseStreamJsonl, findInitEvent, findResultEvent, findSkillInvocation, countHookEvents, computeByteMetrics, findBashToolUsesWithResults } from './stream-parser.mjs';
import { buildRunMatrix, buildConditionOrders } from './randomizer.mjs';
import { junitTestCountFor, junitTestFailuresFor, forEachJunitXml } from '../../lib/parsers/junit-xml.js';

/** Prints a single, clearly-labeled WARNING line if `failures` (from a cleanup accumulator's
 * runCleanup()) is non-empty -- never silent, but never escalated into a hard failure either: a
 * temp-dir cleanup race is a disk-hygiene concern, not evidence the run's own gate result is
 * wrong. Shared by every caller of createCleanupAccumulator (acquireSharedEvalResources's own
 * internal rollback, plus every caller of runConditionPair/runScenarioMatrix). */
export function reportCleanupFailures(failures, contextSuffix = '') {
  if (failures.length === 0) return;
  const suffix = contextSuffix ? ` ${contextSuffix}` : '';
  console.error(`WARNING: ${failures.length} cleanup step(s) failed${suffix} (resources may be left behind): ${failures.join('; ')}`);
}

/** Cleanup steps accumulate AS EACH RESOURCE IS CREATED, not all at once at the end -- a failure
 * partway through acquisition (or partway through running conditions) is caught by the caller and
 * runs whatever steps have been queued SO FAR before rethrowing. Returns {registerCleanup,
 * runCleanup}: registerCleanup(fn) queues a step; runCleanup() runs and clears every queued step,
 * returning the list of step failures (never throws itself -- deliberately best-effort, so ONE
 * failed step, e.g. a transient file lock on a temp dir delete, doesn't prevent every OTHER queued
 * step from still running). */
function createCleanupAccumulator() {
  const cleanupSteps = [];
  function registerCleanup(fn) {
    cleanupSteps.push(fn);
  }
  async function runCleanup() {
    const failures = [];
    for (const step of cleanupSteps.splice(0)) {
      try {
        await step();
      } catch (err) {
        failures.push(err.message);
      }
    }
    return failures;
  }
  return { registerCleanup, runCleanup };
}

/**
 * Acquires every resource shared across an entire pair (calibrate/smoke) or an entire scenario
 * matrix (run) -- materialized ONCE, reused by every condition/cell that follows. Self-contained
 * try/catch + rollback: if acquisition fails partway through, this function is the only thing
 * holding the partial cleanupSteps at that point (the caller never received a runCleanup handle
 * yet), so it must roll back and report before rethrowing -- exactly the incremental-cleanup
 * rationale the original runConditionPair documented.
 * @returns {Promise<{settingsPath, shimDir, snapshotDir, gradleUserHome, gradleSnapshotDir,
 *   resetGradleToSnapshot, daemonPolicy, kmpEvalTempHome, sharedEnv, registerCleanup, runCleanup}>}
 */
export async function acquireSharedEvalResources({ allowedGradleTasks, allowedKmpTestSubcommands, repoRoot, pinnedSkillSha, runPluginValidator }) {
  const { registerCleanup, runCleanup } = createCleanupAccumulator();
  try {
    const settingsPath = buildPolicySettingsFile();
    registerCleanup(() => rmSync(dirname(settingsPath), { recursive: true, force: true }));
    const { shimDir } = buildPathShim({ worktreeRoot: repoRoot });
    registerCleanup(() => rmSync(shimDir, { recursive: true, force: true }));
    const { snapshotDir } = await materializeSkillSnapshot({ repoRoot, sha: pinnedSkillSha, validateFn: runPluginValidator });
    registerCleanup(() => rmSync(snapshotDir, { recursive: true, force: true }));
    // materializeGradleUserHome creates TWO temp directories (gradleUserHome itself, plus its own
    // internal snapshotDir it resets from) -- gradleSnapshotDir here is deliberately distinctly
    // named from the skill snapshot's `snapshotDir` above; conflating the two previously meant the
    // Gradle module's own snapshot directory was never captured at all and leaked on every run.
    const { gradleUserHome, snapshotDir: gradleSnapshotDir, resetToSnapshot, daemonPolicy } = materializeGradleUserHome({});
    registerCleanup(() => rmSync(gradleUserHome, { recursive: true, force: true }));
    registerCleanup(() => rmSync(gradleSnapshotDir, { recursive: true, force: true }));
    const kmpEvalTempHome = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-home-'));
    registerCleanup(() => rmSync(kmpEvalTempHome, { recursive: true, force: true }));

    const sharedEnv = buildSharedEnv({
      shimDir, gradleUserHome, kmpEvalTempHome,
      expectedFixtureRoot: null, // set per-condition once the fixture dir is materialized
      allowedGradleTasks, allowedKmpTestSubcommands,
    });

    return {
      settingsPath, shimDir, snapshotDir, gradleUserHome, gradleSnapshotDir,
      resetGradleToSnapshot: resetToSnapshot, daemonPolicy, kmpEvalTempHome, sharedEnv,
      registerCleanup, runCleanup,
    };
  } catch (err) {
    reportCleanupFailures(await runCleanup(), 'during acquisition-failure rollback');
    throw err;
  }
}

/**
 * Runs exactly one condition (`no-skill` or `current-skill`) against an already-acquired shared
 * resource set: materializes/resets the fixture, resets Gradle's user home, wipes
 * KMP_EVAL_TEMP_HOME, spawns Claude, and parses the resulting transcript. Never has its own
 * try/catch -- the caller (runConditionPair / runScenarioMatrix) wraps the whole run-conditions
 * phase and calls the shared runCleanup() on any failure, exactly like the original
 * runConditionPair's single try/catch did.
 * @param {object} opts
 * @param {'no-skill'|'current-skill'} opts.condition
 * @param {(previousFixtureDir: string|undefined) => {fixtureDir: string}} opts.materializeFixture
 * @param {string|undefined} opts.previousFixtureDir - the prior call's fixtureDir (undefined for
 *   the first call), so materializeFixture can implement "reuse the same path, wiped and
 *   re-populated" (the Materialization Principle).
 * @param {(fixtureDir: string) => void} opts.cleanupFixtureOnce - called on every invocation; the
 *   CALLER'S closure is responsible for the "only actually queue once" logic (e.g. a captured
 *   boolean), so this function itself doesn't need to know about cleanupSteps internals at all.
 * @param {() => void} opts.resetGradleToSnapshot
 * @param {string} opts.kmpEvalTempHome
 * @param {object} opts.sharedEnv
 * @param {string[]} opts.baseArgv
 * @param {string} opts.snapshotDir - the skill snapshot dir (only actually used when
 *   condition==='current-skill'; buildConditionArgv ignores it otherwise).
 * @param {string} opts.targetSkillName
 * @param {number} opts.timeoutMs
 */
export async function runSingleCondition({ condition, materializeFixture, previousFixtureDir, cleanupFixtureOnce, resetGradleToSnapshot, kmpEvalTempHome, sharedEnv, baseArgv, snapshotDir, targetSkillName, timeoutMs }) {
  const materialized = materializeFixture(previousFixtureDir);
  const fixtureDir = materialized.fixtureDir;
  cleanupFixtureOnce(fixtureDir);
  resetGradleToSnapshot();
  // KMP_EVAL_TEMP_HOME is reused (same path) across every condition sharing this resource set,
  // like fixtureDir/GRADLE_USER_HOME -- wiped back to empty before EACH condition's run, so
  // whatever one condition wrote under ~/.kmp-test/ can never leak into the next.
  rmSync(kmpEvalTempHome, { recursive: true, force: true });
  mkdirSync(kmpEvalTempHome, { recursive: true });
  const conditionEnv = { ...sharedEnv, KMP_EVAL_EXPECTED_FIXTURE_ROOT: realpath(fixtureDir) };
  const argv = buildConditionArgv(baseArgv, condition, condition === 'current-skill' ? snapshotDir : null);
  const startedAt = new Date();
  const spawnResult = await spawnCondition(argv, { env: conditionEnv, cwd: fixtureDir, timeoutMs });
  const endedAt = new Date();
  const { events, malformedLines } = parseStreamJsonl(spawnResult.rawStdout, { taggedLines: spawnResult.taggedLines });
  const init = findInitEvent(events);
  const result = findResultEvent(events);
  const invocation = findSkillInvocation(events, targetSkillName);
  const hookStats = countHookEvents(events);
  const byteMetrics = computeByteMetrics(spawnResult.rawStdout, events);
  const bashResults = findBashToolUsesWithResults(events);

  return {
    condition, argv, env: conditionEnv, fixtureDir, events, malformedLines, init, result,
    invocation, hookStats, byteMetrics, bashResults, spawnResult, startedAt, endedAt,
    // Only current-skill's own argv actually passed --plugin-dir snapshotDir (see
    // buildConditionArgv) -- carried on the per-condition result itself (rather than as a
    // separate hard-gate parameter) so pluginSnapshotBindingOk can read it directly, the same way
    // every other gate check already reads its inputs off the per-condition result.
    snapshotDir: condition === 'current-skill' ? snapshotDir : null,
  };
}

/**
 * Snapshots the real JUnit XML for the scenario's declared `expected.gradle.evidence_task`
 * immediately after a condition finishes executing, before the NEXT cell's `git clean -fdx` reset
 * deletes it. Deliberately called unconditionally (sinceMs=0, "whatever's there right now") rather
 * than freshness-gated against a specific gradle invocation's dispatch time -- the per-cell reset
 * already guarantees any XML present was written DURING this condition's own run, since `build/`
 * starts empty every cell (the Materialization Principle). That eliminates cross-attempt staleness
 * WITHIN a session at the source, rather than needing to detect and gate against it after the fact
 * the way result-rollup.js's own `cacheRespected ? 0 : runStartMs` has to for its multi-leg,
 * non-reset-between-legs use case. Only meaningful for `outcome_kind:'tests_executed'` scenarios --
 * a `no_applicable_tests` scenario has no XML to read by definition; returns null for both that
 * case and a scenario with no `evidence_task` declared at all.
 *
 * Returns `null`, not `{total:0,passed:0,failed:0}`, when NO JUnit XML file was ever produced for
 * the task at all -- a fresh review reproduced a real gap: `junitTestCountFor`/
 * `junitTestFailuresFor` both simply accumulate from zero and never distinguish "walked zero
 * matching files" from "walked real files that happen to report zero testcases," so a completely
 * ABSENT `build/test-results/<task>/` directory (nothing ever ran, or ran against the wrong task
 * entirely) previously produced the exact same `{total:0,passed:0,failed:0}` shape a real,
 * genuinely-empty test suite would -- and the schema permitted a `tests_executed` contract to
 * legitimately expect all-zero counts, so this could grade as a fully-matching "correct execution
 * of zero tests" with no real evidence behind it at all. `forEachJunitXml` is called directly
 * (imported from the same shared `lib/parsers/junit-xml.js` utility, not reimplemented) purely to
 * detect whether at least one real XML file exists for this task, before trusting the counts
 * `junitTestCountFor`/`junitTestFailuresFor` compute from those same files.
 *
 * Also returns `{harnessIntegrityIssue:true, reason}` (never a false pass/fail count) when the
 * real XML shows something this evidence path cannot correctly account for -- a fresh review found
 * `passed = total - failures.length` silently misattributes a genuine `<skipped>` testcase to
 * `passed` (confirmed against the real `lib/parsers/junit-xml.js`: skipped cases are counted in
 * `total` by `junitTestCountFor`'s bare `<testcase\b` scan, but never appear in
 * `junitTestFailuresFor`'s output, since `extractTestcaseFailures` only matches `<failure>`/
 * `<error>` children). A skip, an oversized XML the walk had to skip entirely (`onOversized`), or a
 * file that exists but could not be read (`onReadError`) are all evidence-COMPLETENESS problems,
 * not a legitimate agent outcome -- the caller (`gradeScenarioCondition`) surfaces this as a
 * HARNESS-INTEGRITY defect that blocks the whole matrix's promotion, the same treatment already
 * given to ambiguous JUnit provenance and incoherent `parallel.legs[]` evidence, rather than
 * letting a miscounted total silently become benchmark-eligible data.
 * @returns {{total: number, passed: number, failed: number}|{harnessIntegrityIssue: true, reason: string}|null}
 */
export function captureGradleJunitEvidence(fixtureDir, scenario) {
  if (scenario.expected?.outcome_kind !== 'tests_executed') return null;
  const evidenceTask = scenario.expected?.gradle?.evidence_task;
  if (!evidenceTask) return null;
  let anyXmlFound = false;
  let hasSkippedTestcase = false;
  const anomalies = [];
  forEachJunitXml(fixtureDir, evidenceTask, 0, (xml) => {
    anyXmlFound = true;
    if (/<skipped\b/.test(xml)) hasSkippedTestcase = true;
  }, {
    onOversized: (info) => anomalies.push(info),
    onReadError: (info) => anomalies.push(info),
  });
  // An oversized/unreadable file is itself proof that a relevant XML file existed for this task --
  // `onOversized`/`onReadError` fire INSTEAD of the visit callback (forEachJunitXml `continue`s past
  // it), never alongside it, so `anyXmlFound` stays false for a fixture dir containing ONLY such a
  // file. Checking this BEFORE the `!anyXmlFound` early-return is required, not just an ordering
  // preference: reversed, a directory with one oversized file and nothing else would silently read
  // as "no evidence at all" (null), discarding the anomaly entirely -- exactly the same class of
  // evidence-completeness bug this function exists to eliminate, one level up in its own new code
  // (caught by a discriminating test, not inferred).
  if (anomalies.length > 0) return { harnessIntegrityIssue: true, reason: 'junit_xml_read_anomaly' };
  if (!anyXmlFound) return null;
  if (hasSkippedTestcase) return { harnessIntegrityIssue: true, reason: 'skipped_testcase_unsupported' };
  const total = junitTestCountFor(fixtureDir, evidenceTask, 0);
  const failures = junitTestFailuresFor(fixtureDir, evidenceTask, 0);
  return { total, passed: total - failures.length, failed: failures.length };
}

/**
 * Orchestrates a full scenario matrix: acquires shared resources ONCE, gets a reproducible
 * EXECUTION order for the `repeats` repetition slots from buildRunMatrix (honoring the task
 * brief's literal "execute cells from buildRunMatrix()") and a genuinely counterbalanced
 * per-repetition condition order from buildConditionOrders, builds baseArgv ONCE from the
 * scenario's own prompt (a matrix is scoped to exactly one scenario -- `run`'s `--scenario` is
 * required and singular), then runs every repetition's pair strictly sequentially, visiting
 * repetitions in buildRunMatrix's shuffled slot order and, within each repetition, the two
 * conditions in buildConditionOrders' data-driven order. "Which repetition runs in which
 * time-slot" (shuffle-derived) is deliberately decoupled from "which condition goes first within
 * a repetition" (deterministic alternation) -- buildRunMatrix is called with a single-element
 * `scenarios`/`conditions` array (`['trial']`, an opaque placeholder -- the condition axis itself
 * is NOT what's being shuffled here, buildConditionOrders owns that), so its only real effect is
 * permuting WHICH repetition index executes at each of the `repeats` time-slots; `order_index`
 * assigned to each resulting record still reflects true execution order (0..2*repeats-1
 * contiguous), never buildRunMatrix's own repeats-length orderIndex. Every cell gets a fresh
 * materialize/reset -- "every cell gets an equivalent pristine project and Gradle-state baseline."
 * @param {object} opts
 * @param {{prompt: string}} opts.scenario
 * @param {number} opts.repeats
 * @param {number} opts.seed
 * @param {string} opts.model
 * @param {string[]} opts.allowedGradleTasks
 * @param {string[]} opts.allowedKmpTestSubcommands
 * @param {string} opts.repoRoot
 * @param {string} opts.pinnedSkillSha
 * @param {Function} opts.runPluginValidator
 * @param {string} opts.settingsPath - unused directly here; acquireSharedEvalResources builds its
 *   own, kept out of this signature (callers never pass it in).
 * @param {(previousFixtureDir: string|undefined) => {fixtureDir: string}} opts.materializeFixture
 * @param {(fixtureDir: string) => void|Promise<void>} [opts.cleanupFixture] - called once at the end.
 * @param {string} opts.targetSkillName
 * @param {number} opts.timeoutMs
 * @returns {Promise<{cellResults: Array<{repetitionIndex: number, orderIndex: number, seed: number,
 *   conditionResult: object}>, snapshotDir: string, daemonPolicy: string, allowedGradleTasks: string[],
 *   allowedKmpTestSubcommands: string[], cleanup: () => Promise<string[]>}>}
 */
export async function runScenarioMatrix({ scenario, repeats, seed, model, allowedGradleTasks, allowedKmpTestSubcommands, repoRoot, pinnedSkillSha, runPluginValidator, materializeFixture, cleanupFixture, targetSkillName, timeoutMs }) {
  const shared = await acquireSharedEvalResources({ allowedGradleTasks, allowedKmpTestSubcommands, repoRoot, pinnedSkillSha, runPluginValidator });
  const { registerCleanup, runCleanup } = shared;

  try {
    // Shuffled EXECUTION order of the `repeats` repetition slots -- a single-element
    // scenarios/conditions array means buildRunMatrix's only real effect here is permuting WHICH
    // repetition index runs at each time-slot (see this function's own doc comment).
    const repetitionSlots = buildRunMatrix([scenario.id], ['trial'], repeats, seed);
    const conditionOrders = buildConditionOrders(repeats, seed);
    const baseArgv = buildBaseArgv({ prompt: scenario.prompt, model, settingsPath: shared.settingsPath });

    let fixtureDir;
    let fixtureCleanupQueued = false;
    const cleanupFixtureOnce = (dir) => {
      if (!fixtureCleanupQueued && cleanupFixture) {
        fixtureCleanupQueued = true;
        registerCleanup(() => cleanupFixture(dir));
      }
    };

    const cellResults = [];
    let orderIndex = 0;
    for (const slot of repetitionSlots) {
      const repetitionIndex = slot.repetition;
      const [firstCondition, secondCondition] = conditionOrders[repetitionIndex];
      for (const condition of [firstCondition, secondCondition]) {
        const conditionResult = await runSingleCondition({
          condition,
          materializeFixture,
          previousFixtureDir: fixtureDir,
          cleanupFixtureOnce,
          resetGradleToSnapshot: shared.resetGradleToSnapshot,
          kmpEvalTempHome: shared.kmpEvalTempHome,
          sharedEnv: shared.sharedEnv,
          baseArgv,
          snapshotDir: shared.snapshotDir,
          targetSkillName,
          timeoutMs,
        });
        fixtureDir = conditionResult.fixtureDir;
        const gradleJunitEvidence = captureGradleJunitEvidence(fixtureDir, scenario);
        cellResults.push({ repetitionIndex, orderIndex, seed, conditionResult: { ...conditionResult, gradleJunitEvidence } });
        orderIndex++;
      }
    }

    return {
      cellResults, snapshotDir: shared.snapshotDir, daemonPolicy: shared.daemonPolicy,
      allowedGradleTasks, allowedKmpTestSubcommands, cleanup: runCleanup,
    };
  } catch (err) {
    reportCleanupFailures(await runCleanup(), 'during scenario-matrix execution rollback');
    throw err;
  }
}

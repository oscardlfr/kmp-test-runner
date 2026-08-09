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
// TARGET_PLUGIN_NAME/TARGET_SKILL_NAME, the plugin validator) is threaded in as an explicit
// parameter instead -- TARGET_PLUGIN_NAME and TARGET_SKILL_NAME are kept as two separate
// parameters throughout (never collapsed into one), matching stream-parser.mjs's
// isTargetSkillReference contract: a plugin's own identity and a skill's own identity within it
// are logically distinct, even where (as in this harness) their literal string values coincide.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { buildPathShim } from './path-shim.mjs';
import { materializeSkillSnapshot, materializeGradleUserHome, realpath, applyFixtureSetup } from './materialize.mjs';
import { buildBaseArgv, buildConditionArgv, buildSharedEnv, buildPolicySettingsFile, spawnCondition } from './condition-launcher.mjs';
import { parseStreamJsonl, findInitEvent, findResultEvent, findSkillInvocation, countHookEvents, computeByteMetrics, findBashToolUsesWithResults } from './stream-parser.mjs';
import { buildRunMatrix, buildConditionOrders } from './randomizer.mjs';
import { attributeCondition } from './junit-evidence.mjs';

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
 * @param {boolean} [junitEvidenceEnabled] - threaded straight into buildPolicySettingsFile(); false
 *   (the default) produces byte-for-byte the same settings.json this function has always produced
 *   -- calibrate/smoke never pass true, so their behavior is completely unaffected.
 * @returns {Promise<{settingsPath, shimDir, snapshotDir, gradleUserHome, gradleSnapshotDir,
 *   resetGradleToSnapshot, daemonPolicy, kmpEvalTempHome, sharedEnv, registerCleanup, runCleanup}>}
 */
export async function acquireSharedEvalResources({ allowedGradleTasks, allowedKmpTestSubcommands, repoRoot, pinnedSkillSha, runPluginValidator, junitEvidenceEnabled = false }) {
  const { registerCleanup, runCleanup } = createCleanupAccumulator();
  try {
    const settingsPath = buildPolicySettingsFile({ junitEvidenceEnabled });
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
 * @param {string} opts.targetPluginName - the plugin's own identity (plugin.json's `name`), used
 *   for both plugin-profile checks and as the namespace prefix in Skill invocation matching --
 *   see stream-parser.mjs's isTargetSkillReference for why this is kept separate from
 *   targetSkillName even though this harness's own plugin and skill share one string value.
 * @param {string} opts.targetSkillName
 * @param {number} opts.timeoutMs
 * @param {boolean} [opts.decisionAttributionEnabled] - when true, materializes the per-condition
 *   decision-attribution scratch directory and sets `KMP_EVAL_JUNIT_EVIDENCE_DIR` -- the ONLY env
 *   var policy-hook.mjs's own recordDecisionSideEffect needs to start writing a per-attempt
 *   allow/deny decision sidecar for every Bash call (see junit-evidence.mjs's attributeCondition,
 *   which reads them back). Independent of junitEvidenceEnabled below (round-7 fix): a scenario
 *   whose outcome_kind isn't 'tests_executed' still needs its own attempts' allow/deny decisions
 *   correctly attributed -- a no_applicable_tests condition's denied kmp-test-parallel attempts
 *   were previously phantom-counted into test_invocations_total/retries and could corrupt terminal
 *   selection, since decisionByAttempt was never populated at all for that outcome_kind and
 *   graders.mjs's own deny/null exclusion gate never fires on bare `undefined`. Default false
 *   (calibrate/smoke): completely inert, conditionEnv is unchanged from before this parameter
 *   existed.
 * @param {boolean} [opts.junitEvidenceEnabled] - when true, ADDITIONALLY registers
 *   junit-evidence-hook.mjs on PostToolUse/PostToolUseFailure and sets the two Gradle-JUnit-XML-
 *   specific env vars (evidenceTask/allowedInvocations) -- only meaningful on top of
 *   decisionAttributionEnabled:true, since without a real scratch dir there is nowhere for that
 *   hook to write. Scoped to 'tests_executed'/'tests_failed' scenarios only (real JUnit XML only
 *   ever exists there -- both represent a genuine test execution, just with a different real
 *   outcome); calibrate/smoke and no_applicable_tests scenarios never set this.
 * @param {string} [opts.evidenceTask] - scenario.expected.gradle.evidence_task (only meaningful
 *   when junitEvidenceEnabled).
 * @param {string[]} [opts.allowedInvocations] - scenario.expected.gradle.allowed_invocations (only
 *   meaningful when junitEvidenceEnabled).
 * @param {Function} [opts.registerCleanup] - the caller's shared cleanup accumulator (from
 *   acquireSharedEvalResources); the scratch directory's removal is queued on it IMMEDIATELY after
 *   creation, before spawnCondition runs, so a failure anywhere later in this call is still covered.
 */
export async function runSingleCondition({ condition, materializeFixture, previousFixtureDir, cleanupFixtureOnce, resetGradleToSnapshot, kmpEvalTempHome, sharedEnv, baseArgv, snapshotDir, targetPluginName, targetSkillName, timeoutMs, decisionAttributionEnabled = false, junitEvidenceEnabled = false, evidenceTask = null, allowedInvocations = null, registerCleanup = null, fixtureSetup = null }) {
  const materialized = materializeFixture(previousFixtureDir);
  const fixtureDir = materialized.fixtureDir;
  cleanupFixtureOnce(fixtureDir);
  resetGradleToSnapshot();
  // Applied after every reset, before the condition ever spawns -- materializeFixture above always
  // yields a byte-for-byte pristine tree first (a fresh worktree, or `git clean -fdx && git reset
  // --hard`), so re-applying this on every repetition x condition is naturally idempotent: any
  // leftover from a prior cell is already gone by this point, and the mutation reproduces
  // identically every time (see materialize.mjs's own applyFixtureSetup doc comment).
  if (fixtureSetup) applyFixtureSetup({ fixtureDir, fixtureSetup });
  // KMP_EVAL_TEMP_HOME is reused (same path) across every condition sharing this resource set,
  // like fixtureDir/GRADLE_USER_HOME -- wiped back to empty before EACH condition's run, so
  // whatever one condition wrote under ~/.kmp-test/ can never leak into the next.
  rmSync(kmpEvalTempHome, { recursive: true, force: true });
  mkdirSync(kmpEvalTempHome, { recursive: true });
  let conditionEnv = { ...sharedEnv, KMP_EVAL_EXPECTED_FIXTURE_ROOT: realpath(fixtureDir) };
  // Per-condition JUnit-evidence scratch directory -- a fresh mkdtempSync per condition (never
  // reused/wiped like fixtureDir/GRADLE_USER_HOME, since there is no expensive resource here worth
  // preserving), matching this codebase's existing `kmp-agentic-eval-*` scratch-resource naming
  // convention. Cleanup is registered on the SHARED accumulator immediately, before spawnCondition
  // is ever called, so an exception anywhere later in this function still results in it being
  // removed once the caller's own try/catch invokes runCleanup().
  let evidenceDir = null;
  if (decisionAttributionEnabled) {
    evidenceDir = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-junit-'));
    if (registerCleanup) registerCleanup(() => rmSync(evidenceDir, { recursive: true, force: true }));
    conditionEnv = { ...conditionEnv, KMP_EVAL_JUNIT_EVIDENCE_DIR: evidenceDir };
    if (junitEvidenceEnabled) {
      conditionEnv = {
        ...conditionEnv,
        KMP_EVAL_JUNIT_EVIDENCE_TASK: evidenceTask,
        KMP_EVAL_JUNIT_ALLOWED_INVOCATIONS: JSON.stringify(allowedInvocations ?? []),
      };
    }
  }
  const argv = buildConditionArgv(baseArgv, condition, condition === 'current-skill' ? snapshotDir : null);
  const startedAt = new Date();
  const spawnResult = await spawnCondition(argv, { env: conditionEnv, cwd: fixtureDir, timeoutMs });
  const endedAt = new Date();
  const { events, malformedLines } = parseStreamJsonl(spawnResult.rawStdout, { taggedLines: spawnResult.taggedLines });
  const init = findInitEvent(events);
  const result = findResultEvent(events);
  const invocation = findSkillInvocation(events, targetPluginName, targetSkillName);
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
    evidenceDir,
  };
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
 * @param {string} opts.targetPluginName - see runSingleCondition's identical doc comment.
 * @param {string} opts.targetSkillName
 * @param {number} opts.timeoutMs
 * @returns {Promise<{cellResults: Array<{repetitionIndex: number, orderIndex: number, seed: number,
 *   conditionResult: object}>, snapshotDir: string, daemonPolicy: string, allowedGradleTasks: string[],
 *   allowedKmpTestSubcommands: string[], cleanup: () => Promise<string[]>}>}
 */
// Whether a scenario's own `outcome_kind` represents a genuine test EXECUTION whose real JUnit XML
// is worth per-attempt attribution -- `tests_executed` and `tests_failed` both do (the target task
// genuinely ran, just with a different real outcome); `no_applicable_tests` never does (no test
// task ever ran, so there is no real JUnit XML to attribute). Extracted as its own small, pure,
// directly-testable function -- reviewed and confirmed as a real gap: the inline boolean
// expression this replaced was previously exercised only by grader-level tests that inject
// `perAttemptJunit` evidence manually (agentic-eval-graders.test.js's own `buildConditionResult`
// helper), which stay green regardless of what THIS function returns -- a regression that
// re-narrowed this back to `'tests_executed'` only would never have been caught by that route.
// `agentic-eval-matrix-runner.test.js` calls this function directly.
export function isJunitEvidenceOutcome(outcomeKind) {
  // coverage_threshold_exceeded included: parallel genuinely runs tests for this outcome too, and
  // a Gradle corroborating attempt needs real JUnit XML for its own outcomeMatches to be genuine
  // (graders.mjs's evaluateGradleAttempt), not fabricated.
  return outcomeKind === 'tests_executed' || outcomeKind === 'tests_failed' || outcomeKind === 'coverage_threshold_exceeded';
}

export async function runScenarioMatrix({ scenario, repeats, seed, model, allowedGradleTasks, allowedKmpTestSubcommands, repoRoot, pinnedSkillSha, runPluginValidator, materializeFixture, cleanupFixture, targetPluginName, targetSkillName, timeoutMs }) {
  // Decision attribution (allow/deny per Bash attempt) is needed for EVERY scenario regardless of
  // outcome_kind (round-7 fix): a no_applicable_tests condition's denied kmp-test-parallel
  // attempts were previously phantom-counted as real executions (test_invocations_total/retries),
  // since decisionByAttempt was never populated at all for that outcome_kind. Real JUnit-XML
  // attribution, in contrast, is only ever relevant for a scenario whose evidence genuinely
  // involves real test execution -- see isJunitEvidenceOutcome, above -- a `no_applicable_tests`
  // scenario never reads JUnit XML at all (three independent layers already guarantee this;
  // junitEvidenceEnabled additionally keeps junit-evidence-hook.mjs unregistered and its two
  // Gradle-specific env vars unset for that outcome_kind, not merely inert internally).
  const decisionAttributionEnabled = true;
  const junitEvidenceEnabled = isJunitEvidenceOutcome(scenario.expected?.outcome_kind);
  const evidenceTask = scenario.expected?.gradle?.evidence_task ?? null;
  const allowedInvocations = scenario.expected?.gradle?.allowed_invocations ?? null;
  const fixtureSetup = scenario.fixture_setup ?? null;
  const shared = await acquireSharedEvalResources({ allowedGradleTasks, allowedKmpTestSubcommands, repoRoot, pinnedSkillSha, runPluginValidator, junitEvidenceEnabled });
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
          targetPluginName,
          targetSkillName,
          timeoutMs,
          decisionAttributionEnabled,
          junitEvidenceEnabled,
          evidenceTask,
          allowedInvocations,
          registerCleanup,
          fixtureSetup,
        });
        fixtureDir = conditionResult.fixtureDir;
        const junitAttribution = decisionAttributionEnabled
          ? attributeCondition(conditionResult.evidenceDir, scenario, conditionResult.bashResults, {
              terminated: conditionResult.spawnResult.terminated,
              terminationReason: conditionResult.spawnResult.terminationReason,
            }, junitEvidenceEnabled)
          : null;
        // The scratch directory has now been fully consumed by attributeCondition -- eagerly
        // remove it right away (a safe no-op if already gone) rather than leaving it until the
        // whole matrix's deferred cleanup runs at the very end; the registerCleanup call inside
        // runSingleCondition already covers the "failed before reaching this point" case.
        if (conditionResult.evidenceDir) {
          rmSync(conditionResult.evidenceDir, { recursive: true, force: true });
        }
        cellResults.push({ repetitionIndex, orderIndex, seed, conditionResult: { ...conditionResult, junitAttribution } });
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

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
import { join } from 'node:path';

import { buildPathShim } from './path-shim.mjs';
import { materializeSkillSnapshot, materializeGradleUserHome, realpath, applyFixtureSetup } from './materialize.mjs';
import { computeSkillSnapshotArtifact } from './input-artifacts.mjs';
import { buildRunMatrix, buildConditionOrders } from './randomizer.mjs';
import { attributeCondition } from './junit-evidence.mjs';
import { buildBashDispatchAccounting } from './dispatch-accounting.mjs';
import { cellTranscriptIntegrityOk } from './cell-integrity.mjs';
import { tagIncidentPhase } from './durable-journal.mjs';
import { validateRuntimeAdapter, validateObservation, freezeObservation, selectShellAttempts } from './runtimes/contract.mjs';
// registries.mjs is now the ONE module allowed to import runtimes/claude-code.mjs directly
// (agentic-eval-runtime-neutral-records-v1) -- this module no longer defaults runtimeAdapter to
// the Claude singleton; every caller must resolve a selection (registries.mjs's resolveSelection)
// and pass the resulting adapter in explicitly. An omitted adapter is a contract error
// (validateRuntimeAdapter below rejects `undefined`), never a silent fallback.

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
 * @returns {Promise<{settingsPath, shimDir, snapshotDir, skillSnapshotArtifact, gradleUserHome,
 *   gradleSnapshotDir, resetGradleToSnapshot, daemonPolicy, kmpEvalTempHome, sharedEnv,
 *   registerCleanup, runCleanup}>}
 */
export async function acquireSharedEvalResources({ allowedGradleTasks, allowedKmpTestSubcommands, repoRoot, pinnedSkillSha, runPluginValidator, junitEvidenceEnabled = false, runtimeAdapter }) {
  // Validated BEFORE any resource below is created (post-review hardening, round 1): the default
  // (claudeCodeRuntimeAdapter) is already validated once, at module load, by defineRuntimeAdapter
  // -- but that guarantee is specific to the DEFAULT instance, not to whatever an individual
  // caller injects here. A malformed injected adapter (a caller's typo, a stale test double, a
  // real integration bug) must be rejected before a shim/snapshot/Gradle-home/temp-dir is ever
  // created, not discovered only once one of its methods happens to be called.
  const { ok: adapterOk, errors: adapterErrors } = validateRuntimeAdapter(runtimeAdapter);
  if (!adapterOk) {
    throw new Error(`invalid runtime adapter: ${adapterErrors.map((e) => `${e.field}:${e.code}`).join(', ')}`);
  }
  const { registerCleanup, runCleanup } = createCleanupAccumulator();
  try {
    const { shimDir } = buildPathShim({ worktreeRoot: repoRoot });
    registerCleanup(() => rmSync(shimDir, { recursive: true, force: true }));
    const { snapshotDir } = await materializeSkillSnapshot({ repoRoot, sha: pinnedSkillSha, validateFn: runPluginValidator });
    registerCleanup(() => rmSync(snapshotDir, { recursive: true, force: true }));
    // Computed here, immediately after materialization and its cleanup registration, and before
    // any adapter/spawn work below -- a Git or canonicalization failure must fail closed before
    // any live session starts, but this must run AFTER materializeSkillSnapshot, never before:
    // that call's own ensureCommitAvailable (materialize.mjs) is the ONE mechanism that backfills
    // the pinned commit into a shallow CI checkout (`git fetch --depth 1 origin <sha>`) when it
    // isn't already present locally -- computing the artifact any earlier would race a shallow
    // clone that hasn't been backfilled yet (the real CI failure mode
    // agentic-eval-materialize.test.js's own "backfills a commit missing from a shallow clone"
    // test guards). Explicitly phase-tagged, mirroring the auth-preflight throw below: an untagged
    // throw here would default to incidentPhaseOf's own 'finalizing_matrix' fallback, misclassifying
    // a resource-acquisition failure as something that happened at the very end of a whole matrix.
    let skillSnapshotArtifact;
    try {
      skillSnapshotArtifact = computeSkillSnapshotArtifact({ repoRoot, sha: pinnedSkillSha, root: '.skills/kmp-test-runner' });
    } catch (err) {
      throw tagIncidentPhase(err, 'acquiring_shared_resources');
    }
    // materializeGradleUserHome creates TWO temp directories (gradleUserHome itself, plus its own
    // internal snapshotDir it resets from) -- gradleSnapshotDir here is deliberately distinctly
    // named from the skill snapshot's `snapshotDir` above; conflating the two previously meant the
    // Gradle module's own snapshot directory was never captured at all and leaked on every run.
    const { gradleUserHome, snapshotDir: gradleSnapshotDir, resetToSnapshot, daemonPolicy } = materializeGradleUserHome({});
    registerCleanup(() => rmSync(gradleUserHome, { recursive: true, force: true }));
    registerCleanup(() => rmSync(gradleSnapshotDir, { recursive: true, force: true }));
    const kmpEvalTempHome = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-home-'));
    registerCleanup(() => rmSync(kmpEvalTempHome, { recursive: true, force: true }));

    // prepareIsolatedHome builds the same runtime environment/config as before (buildPolicySettingsFile
    // + buildSharedEnv, composed behind the adapter) -- core stays the owner of path shim, Gradle
    // home, skill snapshot, fixture and this cleanup accumulator; cleanupPaths (the settings
    // directory the adapter itself created) is registered here, immediately, exactly like every
    // other resource above.
    const { sharedEnv, settingsPath, cleanupPaths } = await runtimeAdapter.prepareIsolatedHome({
      shimDir, gradleUserHome, kmpEvalTempHome,
      expectedFixtureRoot: null, // set per-condition once the fixture dir is materialized
      allowedGradleTasks, allowedKmpTestSubcommands, junitEvidenceEnabled,
    });
    for (const p of cleanupPaths) registerCleanup(() => rmSync(p, { recursive: true, force: true }));

    // Confirms the runtime can actually authenticate BEFORE the first live spawn -- the exact same
    // sharedEnv/PATH every measured session will receive, so a broken environment is caught here,
    // once, rather than burning every planned cell on a pre-inference failure (the macOS
    // incident this preflight exists to close). Self-tags 'acquiring_shared_resources': the
    // existing catch below has no phase-tagging of its own for other failures in this function
    // either, but this throw must not silently inherit the outer incidentPhaseOf() fallback.
    const preflight = await runtimeAdapter.preflight({ sharedEnv, repoRoot });
    if (!preflight.ok) {
      throw tagIncidentPhase(
        new Error(`Auth preflight failed: reason=${preflight.reasonCode}, exit_code=${Number.isInteger(preflight.exitCode) ? preflight.exitCode : 'null'}, logged_in=${preflight.loggedIn === true}`),
        'acquiring_shared_resources',
      );
    }

    return {
      settingsPath, shimDir, snapshotDir, skillSnapshotArtifact, gradleUserHome, gradleSnapshotDir,
      resetGradleToSnapshot: resetToSnapshot, daemonPolicy, kmpEvalTempHome, sharedEnv,
      registerCleanup, runCleanup,
      // The RESOLVED adapter instance (default or test-injected) -- returned so a caller outside
      // this module (cli.mjs's runConditionPair) can reuse the exact same instance for its own
      // buildInvocation() call without importing runtimes/claude-code.mjs itself, which only this
      // module is allowed to do (contract.mjs's own "matrix-runner.mjs may import the Claude
      // singleton as default" exception).
      runtimeAdapter,
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
export async function runSingleCondition({ condition, materializeFixture, previousFixtureDir, cleanupFixtureOnce, resetGradleToSnapshot, kmpEvalTempHome, sharedEnv, baseArgv, snapshotDir, targetPluginName, targetSkillName, timeoutMs, decisionAttributionEnabled = false, junitEvidenceEnabled = false, evidenceTask = null, allowedInvocations = null, registerCleanup = null, fixtureSetup = null, journal = null, cellOrdinal = null, runtimeAdapter }) {
  // Validated BEFORE any per-condition resource is created (P1 architectural review): every
  // condition within a matrix reuses the SAME runtimeAdapter acquireSharedEvalResources already
  // validated once upfront, but this function's own materialization work (fixture materialize,
  // Gradle reset-to-snapshot, scratch directories) is exactly the same class of expensive,
  // hard-to-unwind side effect acquireSharedEvalResources refuses to start before validating -- so
  // this applies the identical fail-fast discipline locally, rather than trusting a caller never to
  // regress it. Mirrors acquireSharedEvalResources's own un-tagged throw (line ~98): this happens
  // before the try block below and before any cleanup accumulator exists for this cell, so there is
  // nothing yet for tagIncidentPhase's rollback context to describe.
  const { ok: adapterOk, errors: adapterErrors } = validateRuntimeAdapter(runtimeAdapter);
  if (!adapterOk) {
    throw new Error(`invalid runtime adapter: ${adapterErrors.map((e) => `${e.field}:${e.code}`).join(', ')}`);
  }
  let fixtureDir;
  try {
    const materialized = materializeFixture(previousFixtureDir);
    fixtureDir = materialized.fixtureDir;
    cleanupFixtureOnce(fixtureDir);
    resetGradleToSnapshot();
    // Applied after every reset, before the condition ever spawns -- materializeFixture above
    // always yields a byte-for-byte pristine tree first (a fresh worktree, or `git clean -fdx &&
    // git reset --hard`), so re-applying this on every repetition x condition is naturally
    // idempotent: any leftover from a prior cell is already gone by this point, and the mutation
    // reproduces identically every time (see materialize.mjs's own applyFixtureSetup doc comment).
    if (fixtureSetup) applyFixtureSetup({ fixtureDir, fixtureSetup });
    // KMP_EVAL_TEMP_HOME is reused (same path) across every condition sharing this resource set,
    // like fixtureDir/GRADLE_USER_HOME -- wiped back to empty before EACH condition's run, so
    // whatever one condition wrote under ~/.kmp-test/ can never leak into the next.
    rmSync(kmpEvalTempHome, { recursive: true, force: true });
    mkdirSync(kmpEvalTempHome, { recursive: true });
  } catch (err) {
    throw tagIncidentPhase(err, 'materializing_cell', cellOrdinal ?? undefined);
  }
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
  const argv = runtimeAdapter.prepareSkillDelivery(baseArgv, condition, condition === 'current-skill' ? snapshotDir : null);
  const startedAt = new Date();
  // onSpawned performs ZERO I/O and can never throw -- Node's EventEmitter dispatch does not
  // protect a listener from its own exception, so a callback that did fallible I/O here could
  // crash the whole process while this live session is still running. It only captures whether the
  // OS-level process actually started and when -- the real journal write happens below, as ordinary
  // `await`ed code inside a real try/catch, safe to fail without taking the process down with it.
  let didSpawn = false;
  let spawnStartedAt = null;
  const sources = await runtimeAdapter.collectObservationSources(argv, {
    env: conditionEnv, cwd: fixtureDir, timeoutMs,
    onSpawned: () => { didSpawn = true; spawnStartedAt = Date.now(); },
  });
  const endedAt = new Date();

  // The next operation after collectObservationSources resolves, before any normalization touches
  // anything -- persists spawn_started/spawn_failed through raw_persisted as one journal operation.
  // A failure here is tagged so finalizeIncident's own emergency raw fallback has a real chance to
  // preserve this cell's raw capture even though the journal's own bookkeeping is what broke.
  // sources.capture is the adapter's ephemeral {primaryText, stderrText} envelope -- it exists
  // solely for this persistence call and the normalize step below; it is never placed on the
  // returned condition result.
  if (journal) {
    try {
      journal.persistSpawnOutcome(cellOrdinal, { didSpawn, spawnStartedAt, rawStdout: sources.capture.primaryText, stderr: sources.capture.stderrText });
    } catch (err) {
      throw tagIncidentPhase(err, 'persisting_cell_journal', cellOrdinal, sources.capture.primaryText);
    }
  }

  let observation;
  try {
    observation = runtimeAdapter.normalizeObservations(sources, {
      condition, targetPluginName, targetSkillName,
      expectedSnapshotDir: condition === 'current-skill' ? snapshotDir : undefined,
    });
    const { ok, errors } = validateObservation(observation);
    if (!ok) {
      throw new Error(`normalized observation failed contract validation: ${errors.map((e) => `${e.field}:${e.code}`).join(', ')}`);
    }
    // The observation's own self-reported runtime identity (RUNTIME_REF_KEYS, contract.mjs) must
    // match the adapter that actually produced it (post-review hardening, round 1) -- shape-only
    // validation above cannot catch an adapter that is internally coherent but simply wrong (or
    // lying) about which runtime it claims to be.
    // A closed literal code only (post-review hardening, round 3) -- never adapter/observation
    // content. This check exists PRECISELY to catch an adapter that is internally coherent but
    // simply wrong (or lying) about its own identity, so observation.runtime.id itself is not yet
    // trusted content at the moment this fires; interpolating it into the thrown message would
    // contradict this whole module's own established discipline (see the comment on the catch
    // block below, which deliberately stopped attaching raw content to a thrown error for the same
    // reason) and contract.mjs's own {field, code}-only error contract.
    if (observation.runtime.id !== runtimeAdapter.id || observation.runtime.protocolVersion !== runtimeAdapter.protocolVersion) {
      throw new Error('observation_runtime_identity_mismatch');
    }
    observation = freezeObservation(observation);
  } catch (err) {
    // No raw 4th argument here (post-review hardening, round 1): by this point
    // journal.persistSpawnOutcome has ALREADY succeeded (a failure there is caught separately,
    // above, and DOES still carry raw as the legitimate last-resort recovery path) -- raw is
    // durably in the journal already, so re-attaching a second copy onto the thrown error is an
    // unnecessary extra raw-content pathway, not a recovery mechanism.
    throw tagIncidentPhase(err, 'parsing_or_attributing_cell', cellOrdinal ?? undefined);
  }

  if (journal && didSpawn) {
    try {
      journal.recordParsed(cellOrdinal);
    } catch (err) {
      // Same reasoning as above -- persistSpawnOutcome already succeeded by this point too.
      throw tagIncidentPhase(err, 'persisting_cell_journal', cellOrdinal);
    }
  }

  return {
    condition, fixtureDir, observation, startedAt, endedAt,
    evidenceDir,
    // Stamped so promotion-time raw read-back (cli.mjs) always keys off THIS, never off array
    // position or an assumed A/B convention -- the journal's own ordinal assignment does not match
    // this codebase's historical recordA/recordB parameter ordering.
    cellOrdinal,
    // Callers must check this before calling journal.recordEvaluated(cellOrdinal): spawn_failed is
    // a terminal journal state with no legal next transition -- the journal's own state machine
    // would throw (correctly) if a caller blindly tried to record `evaluated` on top of it.
    didSpawn,
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
 *   conditionResult: object, localIntegrity: object}>, snapshotDir: string, daemonPolicy: string,
 *   allowedGradleTasks: string[], allowedKmpTestSubcommands: string[], cleanup: () => Promise<string[]>,
 *   plannedCellCount: number, executedCellCount: number, matrixComplete: boolean,
 *   failFastStop: {orderIndex: number, repetitionIndex: number, condition: string, reason: string}|null}>}
 *
 * Fail-fast (preserve rejected matrix forensics): after each cell, `cellTranscriptIntegrityOk`
 * (cell-integrity.mjs) evaluates the same canonical, matrix-consensus-free checks the final
 * whole-matrix gate uses -- if a cell fails locally, the loop stops immediately, before spawning
 * any further live Claude session. `cellResults` always carries an entry for EVERY cell that
 * actually executed (not only the one that failed), each with its own `localIntegrity` verdict --
 * this is the authoritative per-cell data a caller building a partial rejection diagnostic reads,
 * never re-derived. The cell loop is a SINGLE flat iteration (never two nested `for` loops) so a
 * `break` on failure unambiguously abandons every remaining cell in the whole matrix, not just the
 * remainder of one repetition slot.
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

export async function runScenarioMatrix({ scenario, repeats, seed, model, allowedGradleTasks, allowedKmpTestSubcommands, repoRoot, pinnedSkillSha, runPluginValidator, materializeFixture, cleanupFixture, targetPluginName, targetSkillName, timeoutMs, journal = null, runtimeAdapter }) {
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
  const shared = await acquireSharedEvalResources({ allowedGradleTasks, allowedKmpTestSubcommands, repoRoot, pinnedSkillSha, runPluginValidator, junitEvidenceEnabled, runtimeAdapter });
  const { registerCleanup, runCleanup } = shared;

  try {
    // Shuffled EXECUTION order of the `repeats` repetition slots -- a single-element
    // scenarios/conditions array means buildRunMatrix's only real effect here is permuting WHICH
    // repetition index runs at each time-slot (see this function's own doc comment).
    const repetitionSlots = buildRunMatrix([scenario.id], ['trial'], repeats, seed);
    const conditionOrders = buildConditionOrders(repeats, seed);
    const baseArgv = runtimeAdapter.buildInvocation({ prompt: scenario.prompt, model, settingsPath: shared.settingsPath });

    let fixtureDir;
    let fixtureCleanupQueued = false;
    const cleanupFixtureOnce = (dir) => {
      if (!fixtureCleanupQueued && cleanupFixture) {
        fixtureCleanupQueued = true;
        registerCleanup(() => cleanupFixture(dir));
      }
    };

    // Flattened once, up front, into a single ordered list -- never two nested loops during
    // execution. A `break` partway through a doubly-nested `for (slot) { for (condition) { ... } }`
    // would only abandon the INNER loop, leaving the outer loop free to keep starting further
    // repetitions -- exactly the bug fail-fast exists to avoid. `orderIndex` is assigned here by
    // flat position (0..2*repeats-1), identical to what the un-flattened loop always produced,
    // since planned order and execution order coincide for every cell that actually runs.
    const cellPlan = [];
    for (const slot of repetitionSlots) {
      const repetitionIndex = slot.repetition;
      const [firstCondition, secondCondition] = conditionOrders[repetitionIndex];
      cellPlan.push({ repetitionIndex, condition: firstCondition });
      cellPlan.push({ repetitionIndex, condition: secondCondition });
    }
    cellPlan.forEach((cell, i) => { cell.orderIndex = i; });
    const plannedCellCount = cellPlan.length;

    const cellResults = [];
    let failFastStop = null;
    for (const { repetitionIndex, condition, orderIndex } of cellPlan) {
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
        journal,
        cellOrdinal: orderIndex,
        runtimeAdapter,
      });
      fixtureDir = conditionResult.fixtureDir;
      let fullConditionResult;
      let localIntegrity;
      try {
        // Canonical shell attempts, in the legacy {id, command, index, resultFound, preDispatchBlock}
        // shape junit-evidence.mjs's attributeCondition/resolveDecisions and dispatch-accounting.mjs's
        // buildBashDispatchAccounting still expect -- derived from observation.toolAttempts, never a
        // second, independent transcript scan.
        const shellAttempts = selectShellAttempts(conditionResult.observation.toolAttempts).map((a) => ({
          id: a.id, command: a.command, index: a.eventIndex, resultFound: a.result.found, preDispatchBlock: a.preDispatchBlock,
        }));
        const junitAttribution = decisionAttributionEnabled
          ? attributeCondition(conditionResult.evidenceDir, scenario, shellAttempts, {
              terminated: conditionResult.observation.process.terminated,
              terminationReason: conditionResult.observation.process.terminationReason,
            }, junitEvidenceEnabled)
          : null;
        // The scratch directory has now been fully consumed by attributeCondition -- eagerly
        // remove it right away (a safe no-op if already gone) rather than leaving it until the
        // whole matrix's deferred cleanup runs at the very end; the registerCleanup call inside
        // runSingleCondition already covers the "failed before reaching this point" case.
        if (conditionResult.evidenceDir) {
          rmSync(conditionResult.evidenceDir, { recursive: true, force: true });
        }
        // Canonical per-tool_use_id dispatch accounting. Built HERE, after attributeCondition, and
        // never from the hookStats computed back in runSingleCondition's parse step: the
        // per-attempt decision map does not exist until attributeCondition has run, so this is the
        // earliest point the classification is derivable at all -- and it must exist before the
        // cell gate below reads it.
        const dispatchAccounting = junitAttribution
          ? buildBashDispatchAccounting({
              bashResults: shellAttempts,
              hookStats: conditionResult.observation.hookStats,
              decisionByAttempt: junitAttribution.decisionByAttempt,
              preDispatchBlockedAttemptIds: junitAttribution.preDispatchBlockedAttemptIds,
            })
          : null;
        fullConditionResult = { ...conditionResult, junitAttribution, dispatchAccounting };
        // Fail-fast integrity check -- evaluated for EVERY executed cell (not only ones that fail),
        // so a caller building a partial rejection diagnostic has a real verdict for every cell
        // that ran, never just the one that stopped the matrix.
        localIntegrity = cellTranscriptIntegrityOk(fullConditionResult, { targetPluginName, targetSkillName, requireDispatchAccounting: true });
      } catch (err) {
        // No raw-text 4th argument here (unlike runSingleCondition's own persistSpawnOutcome-failure
        // catch): persistSpawnOutcome already succeeded for this cell by the time this loop body
        // runs (it happens inside the runSingleCondition call above), so raw custody has already
        // moved to the journal -- a later failure here depends on the journal, never a raw copy
        // still held in memory (raw-custody rule: only a persistSpawnOutcome failure itself gets the
        // emergency in-memory fallback).
        throw tagIncidentPhase(err, 'parsing_or_attributing_cell', orderIndex);
      }
      if (journal && conditionResult.didSpawn) {
        try {
          journal.recordEvaluated(orderIndex);
        } catch (err) {
          throw tagIncidentPhase(err, 'persisting_cell_journal', orderIndex);
        }
      }
      cellResults.push({ repetitionIndex, orderIndex, seed, conditionResult: fullConditionResult, localIntegrity });
      if (!localIntegrity.ok) {
        failFastStop = { orderIndex, repetitionIndex, condition, reason: localIntegrity.reason };
        break;
      }
    }

    const executedCellCount = cellResults.length;
    const matrixComplete = executedCellCount === plannedCellCount;

    return {
      cellResults, snapshotDir: shared.snapshotDir, skillSnapshotArtifact: shared.skillSnapshotArtifact,
      daemonPolicy: shared.daemonPolicy,
      allowedGradleTasks, allowedKmpTestSubcommands, cleanup: runCleanup,
      plannedCellCount, executedCellCount, matrixComplete, failFastStop,
    };
  } catch (err) {
    reportCleanupFailures(await runCleanup(), 'during scenario-matrix execution rollback');
    throw err;
  }
}

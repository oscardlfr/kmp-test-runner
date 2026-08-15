#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/cell-integrity.mjs -- canonical per-cell harness-integrity evaluation, shared
// by the fail-fast hook (matrix-runner.mjs's runScenarioMatrix loop, cli.mjs's runConditionPair)
// and the final whole-matrix gate (cli.mjs's scenarioCellIntegrityOk/scenarioHardGate). Exists so
// there is exactly ONE place that (a) decides which checks are safe to evaluate on a single,
// possibly-still-executing cell -- no matrix-wide consensus, no already-built run record, no
// grading result needed -- and (b) turns findUnexpectedToolUses' raw output into the
// {count, tools} structural detail every rejection diagnostic and every hard gate consumes (see
// summarizeUnexpectedToolUses below) -- fixing the gap that made a real 2026-08 canary rejection's
// root cause (which tool, at which transcript index) permanently unrecoverable: only the boolean
// `noUnexpectedToolsOk:false` ever survived past this evaluation.
//
// Deliberately self-contained (only node:fs + stream-parser.mjs) so both cli.mjs and
// matrix-runner.mjs can import it without creating a cycle -- matrix-runner.mjs's own header
// comment explains why it never imports FROM cli.mjs.
import { statSync } from 'node:fs';
import {
  isSkillAvailable, findUnexpectedToolUses, hasExpectedToolProfile, hasExpectedPluginProfile,
  classifyForeignSkillUses, findTranscriptStructuralIssuesToleratingTimeout,
  findIncompleteToolResultsToleratingTimeout, computeAmbientSkillProfile,
  extractTokenUsage, findAllToolUses,
} from './stream-parser.mjs';

// The ONLY tools either condition's own --tools argv value ever grants -- moved here verbatim from
// cli.mjs (was a private module-level const there); cli.mjs now imports it FROM here so the
// allowlist can never independently drift between the two modules that need it.
export const EXPECTED_TOOL_NAMES = new Set(['Bash', 'Skill']);

/**
 * Moved here verbatim from cli.mjs (was a private, unexported function) -- proves the loaded
 * plugin's own reported path is the SAME physical directory as this run's materialized skill
 * snapshot, not merely a same-named plugin loaded from somewhere else. Compared via filesystem
 * identity (device+inode from statSync), never a string path comparison -- NTFS supports
 * per-directory case sensitivity, so a case-folded compare could wrongly treat two genuinely
 * distinct directories as the same snapshot. Fails closed on any unresolvable path. Deliberately
 * returns ONLY a boolean -- the actual paths (which could themselves be privacy-sensitive, e.g.
 * containing the real OS username) are never included in the return value.
 */
export function isPluginBoundToSnapshot(initEvent, expectedSnapshotDir) {
  if (initEvent == null || !Array.isArray(initEvent.plugins) || initEvent.plugins.length !== 1) return false;
  const reportedPath = initEvent.plugins[0]?.path;
  if (typeof reportedPath !== 'string' || reportedPath.length === 0) return false;
  if (typeof expectedSnapshotDir !== 'string' || expectedSnapshotDir.length === 0) return false;
  let reportedStat;
  let expectedStat;
  try {
    reportedStat = statSync(reportedPath, { bigint: true });
  } catch {
    return false; // reported path doesn't exist / unresolvable -- fail closed, never assume a match
  }
  try {
    expectedStat = statSync(expectedSnapshotDir, { bigint: true });
  } catch {
    return false; // the harness's OWN expected snapshot vanished -- also fail closed
  }
  return reportedStat.dev === expectedStat.dev && reportedStat.ino === expectedStat.ino;
}

/**
 * Moved here verbatim from cli.mjs (was a private function) -- the single source of truth for
 * deriving {ok, reason, failedChecks} from ONE shared ordered list of named [name, boolean]
 * checks, so a hand-built failedChecks array can never drift out of sync with a hand-written
 * reason string.
 */
export function evaluateNamedChecks(checks) {
  const failedChecks = checks.filter(([, passed]) => !passed).map(([name]) => name);
  return {
    ok: failedChecks.length === 0,
    reason: failedChecks.length === 0 ? null : checks.map(([name, passed]) => `${name}:${passed}`).join(' '),
    failedChecks,
  };
}

/**
 * The single implementation, in this whole repo, of "what does an unexpected tool_use look like,
 * structurally" -- both cellTranscriptIntegrityOk (below, for the scenario/matrix path) and
 * cli.mjs's calibrationHardGate/smokeHardGate (for the pair path) call this rather than each
 * independently calling findUnexpectedToolUses and hand-rolling their own projection. The explicit
 * destructure-and-rebuild (never a raw passthrough of findUnexpectedToolUses' own output) is
 * load-bearing: it structurally guarantees `id`/`receiptNs` can never reach any diagnostic tier,
 * even if a future caller passed the raw array straight through.
 * @returns {{ok: boolean, count: number, tools: Array<{name: string, event_index: number}>}}
 */
export function summarizeUnexpectedToolUses(events, expectedToolNames) {
  const found = findUnexpectedToolUses(events, expectedToolNames);
  return {
    ok: found.length === 0,
    count: found.length,
    tools: found.map(({ name, index }) => ({ name, event_index: index })),
  };
}

/**
 * Detects the exact pre-inference-failure signature a live macOS canary exposed: a terminal
 * `result` event with is_error:true, num_turns in [0,1], every usage counter exactly zero, and
 * zero tool_use of any kind -- the process spawned and Claude Code emitted a well-formed
 * transcript, but the model never got a genuine turn (auth broken before the first turn, in the
 * canary's case). All 4 conjuncts are required at once (AND): a real negative-outcome cell that
 * genuinely engaged -- more than one turn, any tool_use, or any non-zero usage counter, even with
 * is_error:true -- must never match this, since a wrong answer via legitimate engagement is data,
 * not a harness defect (see cli.mjs's scenarioHardGate doc comment on that same distinction).
 * Never inspects duration_ms, exit code in isolation, or any English-language text.
 *
 * The usage conjunct fails CLOSED on ambiguity (post-adversarial-review fix): an entirely absent
 * `usage` block, or one missing even a single one of its 4 counters, is treated as CONSISTENT
 * with -- never as ruling out -- the failure signature, given the other 3 conjuncts already hold.
 * The only observed incident shape has `usage` present with every counter at an explicit 0, but
 * that is the sole evidence this repo has for the real CLI's error-path JSON; failing open on a
 * missing counter would silently promote the exact class of cell this check exists to catch, the
 * first time a real failure's JSON happens to omit rather than zero a field. A genuinely non-zero
 * counter is checked first and still unconditionally rules this out, regardless of any OTHER
 * counter being absent -- real engagement is real engagement.
 * @param {object} conditionResult - reads .result (the raw stream-json `result` event) and .events
 * @returns {boolean}
 */
function isPreInferenceFailureSignature(conditionResult) {
  const result = conditionResult.result;
  if (result == null || result.is_error !== true) return false;
  if (!Number.isInteger(result.num_turns) || result.num_turns < 0 || result.num_turns > 1) return false;
  const usage = extractTokenUsage(result);
  const counters = usage == null ? [] : [usage.input, usage.output, usage.cache_read, usage.cache_creation];
  if (counters.some((v) => typeof v === 'number' && v !== 0)) return false;
  if (findAllToolUses(conditionResult.events).length !== 0) return false;
  return true;
}

/**
 * Canonical per-cell harness-integrity evaluation -- exactly the 16 checks from cli.mjs's
 * scenarioCellIntegrityOk that are computable from `conditionResult` ALONE: no matrix-wide
 * consensus, no already-built run record, no grading result. Deliberately EXCLUDES:
 *  - `skillSelectionOk` -- needs `sharedAmbientNames`, a matrix-wide consensus value that doesn't
 *    exist until every cell in the matrix has run. A caller using this for fail-fast (where only a
 *    prefix of the matrix has executed) has no legitimate value to pass here; defaulting to an
 *    empty set would be UNSAFE, not merely incomplete -- a real accepted-matrix regression test
 *    (agentic-eval-run-command.test.js's shared-bundled-skill-confirmed case) depends on a
 *    confirmed-but-shared foreign use being tolerated, which an empty-set default would wrongly
 *    reject, turning a legitimate accept into a fail-fast rejection.
 *  - `ambientProfileMatrixOk` -- by definition a matrix-wide consensus fact, computed once and
 *    passed into the whole-matrix gate from outside; meaningless for a single cell evaluated in
 *    isolation, and evaluating it mid-matrix (before every cell has run) would be a claim about
 *    consensus that was never actually checked.
 *  - `junitEvidenceOk`/`parallelEvidenceOk`/`changedEvidenceOk`/`junitSkipEvidenceOk`/
 *    `junitCaptureCompleteOk` -- all read `record.errors`, populated by gradeScenarioCondition/
 *    buildRunRecord, which today run only AFTER the whole matrix loop completes (cmdRun's own
 *    per-cell grading loop, reached only once runScenarioMatrix returns). These 5 remain covered
 *    only by the final scenarioHardGate once records exist -- fail-fast never sees them, by
 *    design; interleaving record construction into the matrix loop itself would be a much larger,
 *    riskier change to a currently self-contained module, for a class of check that can only ever
 *    fire on `tests_executed`/`tests_failed`/`coverage_threshold_exceeded` scenarios in the first
 *    place.
 *
 * `availabilityOk`/`noSkillSafetyOk` ARE included below, computed directly from
 * `conditionResult.init`/`conditionResult.invocation` via the exact same primitives
 * (isSkillAvailable, invocation?.confirmed) buildRunRecord itself uses to populate
 * `record.skill_available.value`/`record.skill_invoked.value` -- a pure, untransformed
 * passthrough, so this function's verdict for these two checks is provably identical to what the
 * final gate would compute from a built record. cli.mjs's own scenarioCellIntegrityOk
 * deliberately does NOT delegate these two specific checks to `checksByName` below -- it keeps
 * reading them off the already-built `record` directly, because several existing tests mutate
 * `record.skill_available.value`/`record.skill_invoked.value` to prove the check fails; delegating
 * would silently stop honoring that mutation. The redundancy (this function still computes both)
 * is harmless -- only fail-fast (which has no `record` to read) actually uses these two fields off
 * `checksByName`.
 *
 * @param {object} conditionResult - matrix-runner.mjs's runSingleCondition() return shape (or
 *   cli.mjs's runConditionPair equivalent) -- reads .condition, .init, .events, .hookStats,
 *   .malformedLines, .spawnResult, .snapshotDir, .invocation.
 * @param {{targetPluginName: string, targetSkillName: string, expectedToolNames?: Set<string>,
 *   requireDispatchAccounting: boolean}} opts - `requireDispatchAccounting` is REQUIRED and selects how
 *   `hookAccountingOk` is proven, and is deliberately EXPLICIT rather than inferred from whether
 *   the accounting happens to be present. `true` (scenario matrices and the scenario hard gate)
 *   demands the canonical per-tool_use_id dispatch accounting: a missing or malformed
 *   `dispatchAccounting` fails closed. `false` (runConditionPair / calibrate / smoke) keeps the
 *   pre-existing aggregate `hookStats.everyCallHooked` proof, because those run kinds have no
 *   per-attempt decision channel at all (no KMP_EVAL_JUNIT_EVIDENCE_DIR, hence no decision
 *   sidecars), so a per-attempt classification is not derivable there. There is deliberately NO
 *   default: omitting the flag, or passing a non-boolean, yields `hookAccountingOk:false` rather
 *   than quietly selecting the weaker proof. Making the choice mandatory is the point -- no caller
 *   can drop back to the aggregate mechanism by forgetting to wire the accounting through.
 * @returns {{ok: boolean, reason: string|null, failedChecks: string[], unexpectedToolUsesCount: number,
 *   unexpectedTools: Array<{name: string, event_index: number}>, checksByName: Record<string, boolean>,
 *   foreignSkillUses: Array<object>}}
 */
export function cellTranscriptIntegrityOk(conditionResult, { targetPluginName, targetSkillName, expectedToolNames = EXPECTED_TOOL_NAMES, requireDispatchAccounting }) {
  const expectSkillAvailable = conditionResult.condition === 'current-skill';
  const availabilityOk = isSkillAvailable(conditionResult.init, targetPluginName) === expectSkillAvailable;
  const noSkillSafetyOk = expectSkillAvailable || (conditionResult.invocation?.confirmed ?? false) === false;
  const pluginProfileOk = hasExpectedPluginProfile(conditionResult.init, targetPluginName, expectSkillAvailable);
  const pluginSnapshotBindingOk = !expectSkillAvailable || isPluginBoundToSnapshot(conditionResult.init, conditionResult.snapshotDir);
  const foreignSkillUses = classifyForeignSkillUses(conditionResult.events, targetPluginName, targetSkillName);
  const foreignSkillToolResultsCompleteOk = !foreignSkillUses.some((u) => u.resultIsError === null);
  const initOk = conditionResult.init != null;
  const toolProfileOk = hasExpectedToolProfile(conditionResult.init, expectedToolNames);
  const unexpectedTools = summarizeUnexpectedToolUses(conditionResult.events, expectedToolNames);
  const noUnexpectedToolsOk = unexpectedTools.ok;
  // Mechanism integrity only -- never `hook_deny_count === 0`; a denial is the policy hook working
  // as intended and is itself valid data. Under requireDispatchAccounting the proof is the
  // canonical per-attempt accounting (which additionally admits the exact recognized Claude Code
  // pre-dispatch tool block, where no hook could ever have run); otherwise it is the historical
  // aggregate proof, unchanged.
  // No default: an omitted (or non-boolean) flag is NOT "assume the weak mechanism" -- that is
  // precisely the implicit fallback this parameter exists to make impossible. A caller that forgets
  // to state which proof it wants gets hookAccountingOk:false and finds out immediately.
  const hookAccountingOk = requireDispatchAccounting === true
    ? conditionResult.dispatchAccounting?.everyCallAccountedFor === true
    : requireDispatchAccounting === false
      ? conditionResult.hookStats.everyCallHooked === true
      : false;
  const cleanTranscriptOk = conditionResult.malformedLines.length === 0;
  const timeoutCtx = { terminated: conditionResult.spawnResult.terminated, terminationReason: conditionResult.spawnResult.terminationReason };
  const transcriptStructureOk = findTranscriptStructuralIssuesToleratingTimeout(conditionResult.events, timeoutCtx).length === 0;
  const toolResultsCompleteOk = findIncompleteToolResultsToleratingTimeout(conditionResult.events, timeoutCtx).length === 0;
  const terminationOk = conditionResult.spawnResult.terminated === false || conditionResult.spawnResult.terminationReason === 'timeout';
  const ambientProfile = computeAmbientSkillProfile(conditionResult.init, targetPluginName, targetSkillName, { expectTargetPresent: expectSkillAvailable });
  const ambientSkillProfileOk = ambientProfile.structurallyWellFormed;
  const targetSkillAmbientIdentityOk = ambientProfile.targetIdentityOk;
  const noPreInferenceFailureOk = !isPreInferenceFailureSignature(conditionResult);

  const checksByName = {
    availabilityOk, noSkillSafetyOk, pluginProfileOk, pluginSnapshotBindingOk,
    foreignSkillToolResultsCompleteOk, initOk, toolProfileOk, noUnexpectedToolsOk,
    hookAccountingOk, cleanTranscriptOk, transcriptStructureOk, toolResultsCompleteOk,
    terminationOk, ambientSkillProfileOk, targetSkillAmbientIdentityOk, noPreInferenceFailureOk,
  };
  const evaluation = evaluateNamedChecks(Object.entries(checksByName));

  return {
    ok: evaluation.ok,
    reason: evaluation.reason,
    failedChecks: evaluation.failedChecks,
    unexpectedToolUsesCount: unexpectedTools.count,
    unexpectedTools: unexpectedTools.tools,
    checksByName,
    foreignSkillUses,
  };
}

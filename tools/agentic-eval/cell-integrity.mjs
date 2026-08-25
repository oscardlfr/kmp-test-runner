#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/cell-integrity.mjs -- canonical per-cell harness-integrity evaluation, shared
// by the fail-fast hook (matrix-runner.mjs's runScenarioMatrix loop, cli.mjs's runConditionPair)
// and the final whole-matrix gate (cli.mjs's scenarioCellIntegrityOk/scenarioHardGate). Exists so
// there is exactly ONE place that (a) decides which checks are safe to evaluate on a single,
// possibly-still-executing cell -- no matrix-wide consensus, no already-built run record, no
// grading result needed -- and (b) turns an unexpected tool attempt into the {count, tools}
// structural detail every rejection diagnostic and every hard gate consumes (see
// summarizeUnexpectedToolUses below) -- fixing the gap that made a real 2026-08 canary rejection's
// root cause (which tool, at which transcript index) permanently unrecoverable: only the boolean
// `noUnexpectedToolsOk:false` ever survived past this evaluation.
//
// Reads exclusively from `conditionResult.observation` (the runtime-adapter-normalized
// condition-observation-v1 contract) and `conditionResult.dispatchAccounting` -- never a raw
// provider event, never a re-parse. isPluginBoundToSnapshot and the literal Claude tools profile
// (EXPECTED_TOOL_NAMES) moved to runtimes/claude-code.mjs: both are genuinely Claude-specific facts
// (a real plugin.json path on disk; the exact --tools value this harness launches Claude with),
// already folded into the observation's own skill.snapshotBindingMatches/session
// .toolProfileMatchesExpected/toolAttempts[].profileAllowed fields -- this module no longer needs
// its own copies.
//
// Deliberately self-contained (no imports beyond this doc comment describes) so both cli.mjs and
// matrix-runner.mjs can import it without creating a cycle -- matrix-runner.mjs's own header
// comment explains why it never imports FROM cli.mjs.

/**
 * Moved here verbatim from cli.mjs (was a private, unexported function) -- the single source of truth for
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
 * The single implementation, in this whole repo, of "what does an unexpected tool attempt look
 * like, structurally" -- both cellTranscriptIntegrityOk (below, for the scenario/matrix path) and
 * cli.mjs's calibrationHardGate/smokeHardGate (for the pair path) call this rather than each
 * independently filtering `toolAttempts` and hand-rolling their own projection. `profileAllowed`
 * is the adapter's own per-attempt fact (computed once, at normalization time, against the exact
 * tool profile this harness actually launched with) -- never re-derived here against a
 * caller-supplied allowlist, so it can never independently drift from what the observation itself
 * already proved.
 * @param {Array} toolAttempts - observation.toolAttempts
 * @returns {{ok: boolean, count: number, tools: Array<{name: string, event_index: number}>}}
 */
export function summarizeUnexpectedToolUses(toolAttempts) {
  const found = toolAttempts.filter((a) => !a.profileAllowed);
  return {
    ok: found.length === 0,
    count: found.length,
    tools: found.map(({ runtimeName, eventIndex }) => ({ name: runtimeName, event_index: eventIndex })),
  };
}

/**
 * Detects the exact pre-inference-failure signature a live macOS canary exposed: a terminal result
 * with is_error:true, turn count in [0,1], every usage counter exactly zero, and zero tool
 * attempts of any kind -- the process spawned and the runtime emitted a well-formed transcript, but
 * the model never got a genuine turn (auth broken before the first turn, in the canary's case). All
 * 4 conjuncts are required at once (AND): a real negative-outcome cell that genuinely engaged --
 * more than one turn, any tool attempt, or any non-zero usage counter, even with terminal
 * isError:true -- must never match this, since a wrong answer via legitimate engagement is data,
 * not a harness defect (see cli.mjs's scenarioHardGate doc comment on that same distinction). Never
 * inspects duration, exit code in isolation, or any English-language text.
 *
 * The usage conjunct fails CLOSED on ambiguity (post-adversarial-review fix): an entirely absent
 * terminal (present:false), or a usage counter that is null, is treated as CONSISTENT with -- never
 * as ruling out -- the failure signature, given the other 3 conjuncts already hold. The only
 * observed incident shape has every usage counter at an explicit 0, but that is the sole evidence
 * this repo has for the real runtime's error-path JSON; failing open on a null counter would
 * silently promote the exact class of cell this check exists to catch, the first time a real
 * failure's JSON happens to omit rather than zero a field. A genuinely non-zero counter is checked
 * first and still unconditionally rules this out, regardless of any OTHER counter being null --
 * real engagement is real engagement.
 * @param {object} observation - conditionResult.observation
 * @returns {boolean}
 */
export function summarizePreInferenceFailure(observation) {
  const terminal = observation?.terminal ?? {};
  const terminalUsage = terminal.usage && typeof terminal.usage === 'object' ? terminal.usage : {};
  const usageStatus = (value) => {
    if (typeof value === 'number') return value === 0 ? 'zero' : 'nonzero';
    return 'null';
  };
  const usage = {
    input: usageStatus(terminalUsage.input),
    output: usageStatus(terminalUsage.output),
    cached_input: usageStatus(terminalUsage.cached_input),
    cache_write: usageStatus(terminalUsage.cache_write),
  };
  const terminalPresent = terminal.present === true;
  const terminalIsError = terminalPresent ? terminal.isError === true : null;
  const terminalTurnCount = terminalPresent && Number.isInteger(terminal.turnCount) ? terminal.turnCount : null;
  const toolAttemptCount = Array.isArray(observation?.toolAttempts) ? observation.toolAttempts.length : 0;
  const hasNonZeroUsage = Object.values(usage).some((v) => v === 'nonzero');
  const signatureMatched = terminalPresent
    && terminalIsError === true
    && Number.isInteger(terminalTurnCount)
    && terminalTurnCount >= 0
    && terminalTurnCount <= 1
    && !hasNonZeroUsage
    && toolAttemptCount === 0;
  return {
    schema: 1,
    signature_matched: signatureMatched,
    terminal_present: terminalPresent,
    terminal_is_error: terminalIsError,
    terminal_result_subtype: terminalPresent && typeof terminal.resultSubtype === 'string' ? terminal.resultSubtype : null,
    terminal_turn_count: terminalTurnCount,
    usage,
    tool_attempt_count: toolAttemptCount,
  };
}

function isPreInferenceFailureSignature(observation) {
  return summarizePreInferenceFailure(observation).signature_matched;
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
 * `observation.skill` via the exact same fields buildRunRecord itself uses to populate
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
 *   cli.mjs's runConditionPair equivalent) -- reads .condition, .observation, .dispatchAccounting.
 * @param {{requireDispatchAccounting: boolean}} opts - a caller may still pass targetPluginName/
 *   targetSkillName alongside this (matrix-runner.mjs and cli.mjs's own call sites do, for
 *   readability at the call site) -- harmlessly ignored, since every check that used to need them
 *   now reads the adapter's own already-target-aware observation fields instead.
 *   `requireDispatchAccounting` is REQUIRED and selects how `hookAccountingOk` is proven, and is
 *   deliberately EXPLICIT rather than inferred from
 *   whether the accounting happens to be present. `true` (scenario matrices and the scenario hard
 *   gate) demands the canonical per-tool_use_id dispatch accounting: a missing or malformed
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
export function cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting }) {
  const observation = conditionResult.observation;
  const expectSkillAvailable = conditionResult.condition === 'current-skill';
  const availabilityOk = observation.skill.available === expectSkillAvailable;
  const noSkillSafetyOk = expectSkillAvailable || (observation.skill.targetInvocation?.confirmed ?? false) === false;
  const pluginProfileOk = observation.skill.profileMatchesCondition;
  const pluginSnapshotBindingOk = !expectSkillAvailable || observation.skill.snapshotBindingMatches;
  const foreignSkillUses = observation.skill.foreignInvocations;
  const foreignSkillToolResultsCompleteOk = !foreignSkillUses.some((u) => u.resultIsError === null);
  const initOk = observation.session.initPresent;
  const toolProfileOk = observation.session.toolProfileMatchesExpected;
  const unexpectedTools = summarizeUnexpectedToolUses(observation.toolAttempts);
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
      ? observation.hookStats.everyCallHooked === true
      : false;
  const cleanTranscriptOk = observation.transcript.malformedLineCount === 0;
  const transcriptStructureOk = observation.transcript.effectiveStructuralIssues.length === 0;
  const toolResultsCompleteOk = observation.transcript.effectiveIncompleteToolResults.length === 0;
  const terminationOk = observation.process.terminated === false || observation.process.terminationReason === 'timeout';
  const ambientSkillProfileOk = observation.skill.ambient.structurallyWellFormed;
  const targetSkillAmbientIdentityOk = observation.skill.ambient.targetIdentityOk;
  const noPreInferenceFailureOk = !isPreInferenceFailureSignature(observation);

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

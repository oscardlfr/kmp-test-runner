#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/dispatch-accounting.mjs -- the CANONICAL per-Bash-attempt dispatch
// classification, and the only place `everyCallAccountedFor` is decided.
//
// Why this exists: countHookEvents() proves hook coverage by comparing AGGREGATE counts, which
// cannot distinguish "a Bash call Claude Code rejected at its own tool layer before the hook ever
// ran" from "a Bash call that genuinely bypassed the policy hook". Both simply make
// bashCallCount > hookStarted.length. Resolving that by subtracting counters would be worse than
// useless: one pre-blocked call could silently offset one genuinely unhooked call and the totals
// would balance. So the classification is per `tool_use_id`, and every consumer reads the SAME
// map rather than re-deriving its own.
//
// Evidentiary rule this module enforces: an on-disk decision sidecar is NEVER accepted as proof
// that the transcript contained the corresponding hook_started/hook_response pair. The sidecar is
// written by the hook, but a residual sidecar from an earlier run (or a fabricated one) must not be
// able to mask a hook that never fired. Hook-event evidence and decision-sidecar evidence are
// cross-checked against each other as exact totals.
//
// What this module deliberately does NOT do: assert an individual hook_id -> tool_use_id
// correlation. The stream provides no such link -- hook events carry only their own hook_id. The
// available proof is (a) hook ids are unique and the started/response SETS are identical, and
// (b) the stream's own allow/deny totals agree with the decision map's. That is what is checked.

const DISPATCH_STATUS = Object.freeze({
  HOOK_EVALUATED: 'hook_evaluated',
  PRE_DISPATCH_BLOCKED: 'pre_dispatch_blocked',
  // PR 4 (agentic-eval-isolated-unrestricted-profile-v1): the ONE new status, exclusive to
  // policyMode:"not_applicable" -- a Bash attempt with a correlated tool_result, where no policy
  // hook ever existed to evaluate it. Never emitted under policyMode:"required".
  RESULT_CORRELATED_NO_POLICY: 'result_correlated_no_policy',
  // The runtime adapter proved that this was the sole chronologically-final incomplete Bash
  // result removed by its strict timeout tolerance. This records interruption, never completion.
  TIMEOUT_INTERRUPTED_NO_POLICY: 'timeout_interrupted_no_policy',
  UNACCOUNTED: 'unaccounted',
});

export const DISPATCH_STATUS_VALUES = Object.freeze([
  DISPATCH_STATUS.HOOK_EVALUATED,
  DISPATCH_STATUS.PRE_DISPATCH_BLOCKED,
  DISPATCH_STATUS.RESULT_CORRELATED_NO_POLICY,
  DISPATCH_STATUS.TIMEOUT_INTERRUPTED_NO_POLICY,
  DISPATCH_STATUS.UNACCOUNTED,
]);

export const POLICY_MODE_VALUES = Object.freeze(['required', 'not_applicable']);

/**
 * Classifies every Bash attempt in one condition and decides whether the whole condition's Bash
 * dispatch is fully accounted for.
 *
 * @param {object[]} bashResults - findBashToolUsesWithResults entries for this condition.
 * @param {object} hookStats - countHookEvents() output (needs hookPairingOk / hookCallCount /
 *   hookResponseCount / hookAllowCount / hookDenyCount). Never re-parsed here.
 * @param {Map<string, string|null>} decisionByAttempt - resolveDecisions() output, keyed by
 *   tool_use_id: 'allow' | 'deny' | null. Ignored entirely when policyMode is "not_applicable"
 *   (no policy hook ever produces a decision under that profile) -- a caller may pass an empty Map.
 * @param {Set<string>} preDispatchBlockedAttemptIds - the ids the STRICT transcript matcher
 *   recognized. Profile-independent (Claude Code's own tool-layer rejection, never gated on
 *   whether a policy hook exists) -- computed once, upstream, either by resolveDecisions
 *   (policyMode:"required") or directly from each attempt's own `preDispatchBlock.recognized`
 *   (policyMode:"not_applicable" callers that never invoke junit-evidence.mjs's machinery at all,
 *   e.g. cli.mjs's runConditionPair for calibrate/smoke).
 * @param {'required'|'not_applicable'} [policyMode] - default 'required' preserves this function's
 *   exact pre-existing behavior/return shape for every caller that predates this parameter.
 *   "required": byte-for-byte the pre-existing classification (hook_evaluated/pre_dispatch_blocked/
 *   unaccounted, driven by decisionByAttempt). "not_applicable": every attempt is classified from
 *   `bashResults[].resultFound` instead -- a correlated tool_result means real, observed execution
 *   even though no policy hook ever evaluated it; decisionByAttempt is never consulted. A caller
 *   that forgets to pass "not_applicable" for an actually-not_applicable condition still fails
 *   CLOSED, never open: under the "required" branch, decisionByAttempt is empty (no policy hook
 *   ever ran), so every non-pre-dispatch-blocked attempt becomes unaccounted and
 *   everyCallAccountedFor is false -- the caller-level "no silent default" guarantee Decision G
 *   actually mandates lives one layer up, at cellTranscriptIntegrityOk's own
 *   requireDispatchAccounting parameter (still REQUIRED there, unchanged).
 * @returns {{dispatchStatusByAttempt: Map<string,string>, hookEvaluatedCount: number,
 *   preDispatchBlockedCount: number, resultCorrelatedNoPolicyCount: number, unaccountedCount: number,
 *   everyCallAccountedFor: boolean}}
 */
export function buildBashDispatchAccounting({
  bashResults,
  hookStats,
  decisionByAttempt,
  preDispatchBlockedAttemptIds,
  timeoutInterruptedAttemptIds = new Set(),
  policyMode = 'required',
}) {
  if (policyMode !== 'required' && policyMode !== 'not_applicable') {
    throw new Error(`buildBashDispatchAccounting: policyMode must be "required" or "not_applicable" -- got ${JSON.stringify(policyMode)}`);
  }
  const calls = Array.isArray(bashResults) ? bashResults : [];
  const decisions = decisionByAttempt instanceof Map ? decisionByAttempt : new Map();
  const recognized = preDispatchBlockedAttemptIds instanceof Set ? preDispatchBlockedAttemptIds : new Set();
  const timeoutInterrupted = timeoutInterruptedAttemptIds instanceof Set ? timeoutInterruptedAttemptIds : new Set();
  const callsById = new Map();
  for (const call of calls) {
    if (typeof call?.id === 'string' && call.id.length > 0) callsById.set(call.id, call);
  }

  // ---- identity invariants (shared by both policy modes) -----------------------------------
  // A Map silently collapses duplicate keys, so "every call got a status" cannot be proven by the
  // map's own size alone. Establish the id set's own integrity first, and let any violation force
  // everyCallAccountedFor:false rather than throwing (this runs on the fail-fast path, where a
  // structured false is the actionable outcome).
  let identityOk = true;
  const seenIds = new Set();
  for (const call of calls) {
    const id = call?.id;
    if (typeof id !== 'string' || id.length === 0) { identityOk = false; continue; }
    if (seenIds.has(id)) { identityOk = false; continue; }
    seenIds.add(id);
  }
  if (seenIds.size !== calls.length) identityOk = false;
  // The recognized-block set must describe calls that actually exist in this transcript.
  for (const id of recognized) {
    if (!seenIds.has(id)) identityOk = false;
  }
  // The adapter tolerance can remove at most one final incomplete result. The accounting consumes
  // that already-proven identity; it never infers a timeout from a missing result on its own.
  if (timeoutInterrupted.size > 1) identityOk = false;
  for (const id of timeoutInterrupted) {
    const call = callsById.get(id);
    if (!seenIds.has(id) || call?.resultFound !== false || recognized.has(id)) identityOk = false;
  }

  const dispatchStatusByAttempt = new Map();

  if (policyMode === 'not_applicable') {
    // ---- no-policy per-attempt classification -----------------------------------------------
    // No decisionByAttempt/hookStats cross-check at all -- there is no policy hook whose
    // allow/deny/pairing counts could ever be meaningful here (every one of them is genuinely
    // zero, always, since PreToolUse:Bash was never wired for this profile -- see
    // runtimes/claude-code.mjs's prepareIsolatedHome). Every attempt is real, observed data or it
    // is unaccounted; there is no third "policy said no" outcome under this profile.
    let preDispatchBlockedCount = 0;
    let resultCorrelatedNoPolicyCount = 0;
    let timeoutInterruptedNoPolicyCount = 0;
    let unaccountedCount = 0;
    for (const id of seenIds) {
      const isRecognizedBlock = recognized.has(id);
      const call = callsById.get(id);
      let status;
      if (isRecognizedBlock) {
        status = DISPATCH_STATUS.PRE_DISPATCH_BLOCKED;
        preDispatchBlockedCount += 1;
      } else if (call?.resultFound === true) {
        status = DISPATCH_STATUS.RESULT_CORRELATED_NO_POLICY;
        resultCorrelatedNoPolicyCount += 1;
      } else if (timeoutInterrupted.has(id)) {
        status = DISPATCH_STATUS.TIMEOUT_INTERRUPTED_NO_POLICY;
        timeoutInterruptedNoPolicyCount += 1;
      } else {
        status = DISPATCH_STATUS.UNACCOUNTED;
        unaccountedCount += 1;
      }
      dispatchStatusByAttempt.set(id, status);
    }
    const everyCallAccountedFor = identityOk
      && dispatchStatusByAttempt.size === calls.length
      && calls.length === preDispatchBlockedCount + resultCorrelatedNoPolicyCount + timeoutInterruptedNoPolicyCount + unaccountedCount
      // An empty array is valid ONLY when there really were no Bash attempts -- calls.length===0
      // makes this trivially true, never masking attempts this function was never shown.
      && unaccountedCount === 0;
    return {
      dispatchStatusByAttempt,
      hookEvaluatedCount: 0,
      preDispatchBlockedCount,
      resultCorrelatedNoPolicyCount,
      timeoutInterruptedNoPolicyCount,
      unaccountedCount,
      everyCallAccountedFor,
    };
  }

  // ---- policyMode:"required" -- byte-for-byte the pre-existing implementation ------------------
  let hookEvaluatedCount = 0;
  let preDispatchBlockedCount = 0;
  let unaccountedCount = 0;
  let contradictionFree = true;

  for (const id of seenIds) {
    const decision = decisions.get(id);
    const hasDecision = decision === 'allow' || decision === 'deny';
    const isRecognizedBlock = recognized.has(id);
    // A call cannot both have been evaluated by the hook and have been blocked before dispatch.
    if (hasDecision && isRecognizedBlock) contradictionFree = false;

    let status;
    if (hasDecision) {
      status = DISPATCH_STATUS.HOOK_EVALUATED;
      hookEvaluatedCount += 1;
    } else if (isRecognizedBlock) {
      status = DISPATCH_STATUS.PRE_DISPATCH_BLOCKED;
      preDispatchBlockedCount += 1;
    } else {
      status = DISPATCH_STATUS.UNACCOUNTED;
      unaccountedCount += 1;
    }
    dispatchStatusByAttempt.set(id, status);
  }

  // ---- cross-channel coherence ----------------------------------------------------------------
  const allowTotal = [...decisions.values()].filter((d) => d === 'allow').length;
  const denyTotal = [...decisions.values()].filter((d) => d === 'deny').length;
  const hookPairCount = hookStats?.hookCallCount;

  const everyCallAccountedFor = identityOk
    && contradictionFree
    && hookStats?.hookPairingOk === true
    && Number.isInteger(hookPairCount)
    && hookPairCount === hookStats?.hookResponseCount
    // Every hook pair in the stream must correspond to a hook-evaluated call, and vice versa.
    && hookPairCount === hookEvaluatedCount
    // ...and the decisions those pairs reported must match the decisions recorded per attempt.
    && hookStats?.hookAllowCount === allowTotal
    && hookStats?.hookDenyCount === denyTotal
    && dispatchStatusByAttempt.size === calls.length
    && calls.length === hookEvaluatedCount + preDispatchBlockedCount + unaccountedCount
    && unaccountedCount === 0;

  return {
    dispatchStatusByAttempt,
    hookEvaluatedCount,
    preDispatchBlockedCount,
    resultCorrelatedNoPolicyCount: 0,
    timeoutInterruptedNoPolicyCount: 0,
    unaccountedCount,
    everyCallAccountedFor,
  };
}

/**
 * Projects the runtime adapter's existing strict-vs-effective timeout decision onto Bash ids.
 * It returns a non-empty set only for the exact one-entry shape already accepted by
 * findIncompleteToolResultsToleratingTimeout; malformed or ambiguous input fails closed.
 */
export function deriveTimeoutInterruptedBashAttemptIds(observation) {
  if (observation?.process?.terminated !== true || observation.process.terminationReason !== 'timeout') return new Set();
  const strict = observation?.transcript?.strictIncompleteToolResults;
  const effective = observation?.transcript?.effectiveIncompleteToolResults;
  if (!Array.isArray(strict) || !Array.isArray(effective) || strict.length !== 1 || effective.length !== 0) return new Set();
  const entry = strict[0];
  if (entry?.name !== 'Bash' || typeof entry.id !== 'string' || entry.id.length === 0) return new Set();
  return new Set([entry.id]);
}

/**
 * Canonical observation-aware entrypoint used by every runtime path. Keeping the timeout projection
 * here prevents campaign, matrix and pair execution from drifting in how they account for the same
 * normalized observation.
 */
export function buildObservationBashDispatchAccounting({
  observation,
  bashResults,
  hookStats,
  decisionByAttempt,
  preDispatchBlockedAttemptIds,
  policyMode = 'required',
}) {
  return buildBashDispatchAccounting({
    bashResults,
    hookStats,
    decisionByAttempt,
    preDispatchBlockedAttemptIds,
    timeoutInterruptedAttemptIds: deriveTimeoutInterruptedBashAttemptIds(observation),
    policyMode,
  });
}

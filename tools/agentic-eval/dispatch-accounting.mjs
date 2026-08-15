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
  UNACCOUNTED: 'unaccounted',
});

export const DISPATCH_STATUS_VALUES = Object.freeze([
  DISPATCH_STATUS.HOOK_EVALUATED,
  DISPATCH_STATUS.PRE_DISPATCH_BLOCKED,
  DISPATCH_STATUS.UNACCOUNTED,
]);

/**
 * Classifies every Bash attempt in one condition and decides whether the whole condition's Bash
 * dispatch is fully accounted for.
 *
 * @param {object[]} bashResults - findBashToolUsesWithResults entries for this condition.
 * @param {object} hookStats - countHookEvents() output (needs hookPairingOk / hookCallCount /
 *   hookResponseCount / hookAllowCount / hookDenyCount). Never re-parsed here.
 * @param {Map<string, string|null>} decisionByAttempt - resolveDecisions() output, keyed by
 *   tool_use_id: 'allow' | 'deny' | null.
 * @param {Set<string>} preDispatchBlockedAttemptIds - the ids the STRICT transcript matcher
 *   recognized, computed once in resolveDecisions. Never re-derived downstream.
 * @returns {{dispatchStatusByAttempt: Map<string,string>, hookEvaluatedCount: number,
 *   preDispatchBlockedCount: number, unaccountedCount: number, everyCallAccountedFor: boolean}}
 */
export function buildBashDispatchAccounting({ bashResults, hookStats, decisionByAttempt, preDispatchBlockedAttemptIds }) {
  const calls = Array.isArray(bashResults) ? bashResults : [];
  const decisions = decisionByAttempt instanceof Map ? decisionByAttempt : new Map();
  const recognized = preDispatchBlockedAttemptIds instanceof Set ? preDispatchBlockedAttemptIds : new Set();

  // ---- identity invariants -------------------------------------------------------------------
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

  // ---- per-attempt classification -------------------------------------------------------------
  const dispatchStatusByAttempt = new Map();
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
    unaccountedCount,
    everyCallAccountedFor,
  };
}

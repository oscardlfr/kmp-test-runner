#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/analysis.mjs -- deterministic, offline, axis-separated analysis over already-
// committed schema-v5 scenario run records and their validated accepted-run-audit sidecars. See
// cli.mjs's `analyze --runs-dir <dir>` subcommand.
//
// Separates 5 axes a single benchmark_eligible/success pair otherwise collapses together:
//   1. target-skill activation      (activation_expected, target_skill_invoked, ...ordinal)
//   2. post-invocation execution    (post_skill_tool_calls_total, post_signal_tool_calls)
//   3. policy interaction           (pre/post-skill policy denial counts)
//   4. authoritative evidence       (terminal_authoritative_evidence_present/well_formed)
//   5. final task outcome           (expected_outcome_matched, final_answer_consistent, success)
// plus one closed-vocabulary `failure_class` per run, resolved by an explicit, tested precedence
// (classifyFailure) so a single run can never carry two competing causes.
//
// Reuses run-record-loader.mjs's validateRunRecordFile() (schema + accepted-run-audit sidecar
// validation, returning the already-parsed sidecar object) as the ONLY gate for trusting a file --
// this module never re-implements or loosens that check, and never re-reads the sidecar file a
// second time (no TOCTOU window, no circular import with cli.mjs). Pure analysis
// (classifyFailure/deriveSkillRelativeFields/analyzeRunRecord/buildSummary) is kept entirely
// separate from I/O (analyzeRunsDir), mirroring accepted-run-audit.mjs's own "pure builder vs. I/O
// orchestrator" split -- every pure function here is directly unit-testable with plain objects, no
// filesystem required.
//
// Structural only, exactly like the sidecar it reads: every field this module emits is a boolean,
// a non-negative integer, a closed-vocabulary string, or null -- never a raw command, tool input,
// path, or skill name. scenario_id/run_id are the only free-form-looking strings surfaced, and both
// are already treated as safe/loggable everywhere else in this harness (corpus scenario ids are
// public and committed; a validated record's run_id is additionally charset-constrained by its own
// accepted_audit.relative_path cross-check). A file that FAILS validation never has its own
// self-reported fields echoed back (see analyzeRunsDir's errors[] contract) -- an untrusted file's
// content, including a tampered run_id, is never trustworthy enough to display.
//
// A final defense-in-depth privacy pass (tools/lib/redact.mjs's PUBLIC_SHAPE_RULES, via
// privacy.mjs) scans the complete output object before analyzeRunsDir returns it -- structurally
// this module should never emit a leak-shaped value, but this closes the gap for a group_key field
// (inherited verbatim from HARD_PARTITION_FIELDS) that happens to contain one anyway.
//
// No subprocess, network access, filesystem write, or live Claude call happens anywhere in this
// module -- readFileSync/readdirSync only.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateRunRecordFile } from './run-record-loader.mjs';
import { HARD_PARTITION_FIELDS, canonicalStructuredValue, findScenarioBenchmarkCompletenessViolations } from './schemas.mjs';
import { redactObjectAndVerify } from './privacy.mjs';
import { withPartitionView, agentRuntimeView, executionProfileView, skillObservationView, usageView, targetSkillInvokedView, productAccessModeView } from './run-record-view.mjs';
import {
  PRODUCT_ACCESS_MODE_VALUES,
  PRODUCT_USAGE_MODE_VALUES,
} from './product-access.mjs';

// v1 -> v2 (Section F, agentic-eval-runtime-neutral-records-v1): per-run entries and group
// summaries both gained agent_runtime/execution_profile/skill_observation/usage reporting fields,
// group_key gained the same 3 new structural partition keys aggregate.mjs's own
// CURRENT_AGGREGATE_SCHEMA bump already covers, and group summaries gained 5 usage-dimension
// distributions plus usage_source_counts. No historical committed analysis-output files exist to
// preserve compatibility with (analysis output is always computed on demand), so this is a plain
// constant bump, not a versioned dispatch.
//
// v2 -> v3 (Evidence 1 measurement-contract hardening): per-run entries and group summaries gain
// product-access / product-usage reporting fields so product behavior, baseline behavior, and
// final-answer protocol compliance stay separate axes. Every new field is derived only from
// already-validated record fields and accepted-run-audit tool-kind counts; no raw transcript
// content is read.
//
// v3 -> v4 (product-vs-free-baseline observability): product_access_mode is now read from schema:7
// records when available (falling back to the legacy condition-derived value for older records),
// and product CLI usage is broken down by accepted-run-audit's closed recognized_operation field.
//
// v4 -> v5 (outcome/evidence/protocol axes): per-run entries and group summaries now publish
// task_outcome_matched, evidence_quality, answer_protocol_matched, and canonical-output availability
// as separate privacy-safe axes. This keeps the historical `success` gate strict while making
// product-vs-free-baseline interpretation explicit: product runs can be credited for canonical
// programmatic evidence, and free-baseline runs can be reported as claim-only rather than silently
// forced into the same product evidence contract.
export const ANALYSIS_SCHEMA = 5;

/** Closed vocabulary for `failure_class` -- exactly one per run, resolved by classifyFailure's own
 * documented precedence. `success` is not a "failure" in the literal sense; it is included so every
 * run gets exactly one label from one enum, rather than a separate is-it-a-failure boolean plus a
 * conditionally-present reason string. Deliberately NON-CAUSAL: every class describes WHAT was
 * observed (a denial occurred, evidence was absent, outcomes disagreed), never asserts that one
 * observation CAUSED another -- `pre_skill_tool_calls` remains an independent per-run field, never a
 * failure_class trigger, and `policy-denial-observed-without-terminal-evidence` names the
 * correlation it actually proves, not an unproven causal claim. */
export const FAILURE_CLASS_VALUES = [
  'success', 'target-skill-not-invoked', 'policy-denial-observed-without-terminal-evidence',
  'no-authoritative-evidence', 'wrong-target', 'outcome-mismatch', 'final-answer-mismatch', 'unclassified',
];

/** Closed vocabulary for how independently verifiable a run's evidence is, separate from whether
 * the task outcome matched or whether the final answer followed the requested protocol. */
export const EVIDENCE_QUALITY_VALUES = [
  'product-canonical', 'baseline-verifiable', 'malformed-evidence', 'claim-only', 'no-evidence',
];

export { PRODUCT_ACCESS_MODE_VALUES, PRODUCT_USAGE_MODE_VALUES };

const CHECK_EVIDENCE_WELL_FORMED = 'authoritative_evidence_well_formed';
const CHECK_TARGET_MATCHES = 'authoritative_target_matches_expected';
const CHECK_OUTCOME_MATCHES = 'authoritative_outcome_matches_expected';
const CHECK_FINAL_ANSWER = 'final_answer_consistent_with_evidence';

const MID_PHASE_VALUES = new Set(['pre-signal', 'produced-signal']);
// A run_id is only ever echoed (per-run entries, or an errors[] entry for an OTHERWISE-validated
// duplicate) once it matches this closed charset -- mirrors the charset schemas.mjs's own
// ACCEPTED_AUDIT_RELATIVE_PATH_RE indirectly enforces on any schema-5 scenario record's run_id
// (via audit/<run_id>.json), applied defensively here too since that constraint does not exist for
// pre-v5/non-scenario records or a record that failed validation before ever reaching that check.
const SAFE_RUN_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function findCheck(checks, name) {
  return (checks ?? []).find((c) => c?.name === name) ?? null;
}

/** Returns `runId` unchanged only if it is a non-empty string in the closed safe-identifier
 * charset; `null` otherwise. Used anywhere a run_id's OWN trustworthiness has not already been
 * established by a full, passing validateRunRecordFile() call -- never assume content from an
 * unvalidated or partially-invalid record is safe to display. */
function safeRunIdOrNull(runId) {
  return typeof runId === 'string' && SAFE_RUN_ID_RE.test(runId) ? runId : null;
}

/**
 * Resolves exactly one closed-vocabulary failure_class per run, per this module's own documented
 * precedence (checked top to bottom, first match wins -- so one run can never receive two competing
 * causes). Walks the 5 axes in causal/upstream-first order: activation, then (only when no usable
 * terminal evidence resulted at all) a policy denial observation, then the evidence-chain checks
 * (target -> outcome -> final-answer) in the same dependency order graders.mjs's own checks
 * 4/5/6/8 already encode.
 *
 * Deliberately non-causal: `policy-denial-observed-without-terminal-evidence` states a correlation
 * (a denial occurred AND no usable terminal evidence resulted), never a proven cause -- this harness
 * has no attempt-level mechanism to prove a SPECIFIC denial was the reason a LATER attempt never
 * happened. A denial that happened but did NOT prevent well-formed, correctly-targeted evidence is
 * never treated as the story once that evidence exists -- verified directly against a real
 * committed record (kampkit-android-host-test-discovery): 4 policy denials occurred, but the run
 * still produced well-formed evidence for the WRONG module, so `wrong-target` is reported, not the
 * policy-denial class. `outcome-mismatch` and `final-answer-mismatch` are deliberately split (never
 * folded together) -- a run can have `expected_outcome_matched:true` while still failing on final-
 * answer consistency alone, and a single combined class would silently contradict that field.
 * `pre_skill_tool_calls` is intentionally NOT a parameter here -- it remains an independent,
 * always-visible per-run field, never promoted into a causal failure label.
 * @returns {string} one of FAILURE_CLASS_VALUES
 */
export function classifyFailure({
  success, activationExpected, targetSkillInvoked, hookDenyCount,
  terminalEvidencePresent, terminalEvidenceWellFormed, targetMatchesExpected, outcomeMatchesExpected, finalAnswerConsistent,
}) {
  if (success === true) return 'success';
  if (activationExpected && targetSkillInvoked !== true) return 'target-skill-not-invoked';
  const hasUsableEvidence = terminalEvidencePresent === true && terminalEvidenceWellFormed === true;
  if (!hasUsableEvidence) {
    if ((hookDenyCount ?? 0) > 0) return 'policy-denial-observed-without-terminal-evidence';
    return 'no-authoritative-evidence';
  }
  if (targetMatchesExpected === false) return 'wrong-target';
  if (outcomeMatchesExpected === false) return 'outcome-mismatch';
  if (finalAnswerConsistent === false) return 'final-answer-mismatch';
  return 'unclassified';
}

function finalAnswerBlockView(sidecar, finalAnswerConsistent) {
  const block = sidecar?.terminal_evidence?.final_answer_block ?? null;
  if (block != null && typeof block === 'object' && !Array.isArray(block)) {
    return {
      found: typeof block.found === 'boolean' ? block.found : null,
      parsed: typeof block.parsed === 'boolean' ? block.parsed : null,
      matches_observed: typeof block.matches_observed === 'boolean' ? block.matches_observed : null,
    };
  }
  // Legacy sidecars (v1-v5) did not carry terminal_evidence.final_answer_block. Preserve a useful
  // boolean for old passing records, but never infer a parsed claim from a failure.
  return {
    found: finalAnswerConsistent === true ? true : null,
    parsed: finalAnswerConsistent === true ? true : null,
    matches_observed: finalAnswerConsistent === true ? true : null,
  };
}

function evidenceQualityFor({
  productCliUsed, terminalEvidencePresent, terminalEvidenceWellFormed, finalAnswerBlockFound, finalAnswerBlockParsed,
}) {
  if (terminalEvidencePresent === true && terminalEvidenceWellFormed === true) {
    return productCliUsed === true ? 'product-canonical' : 'baseline-verifiable';
  }
  if (terminalEvidencePresent === true) return 'malformed-evidence';
  if (finalAnswerBlockFound === true && finalAnswerBlockParsed === true) return 'claim-only';
  return 'no-evidence';
}

/**
 * Derives every skill-relative field from the accepted-run-audit sidecar's own `tool_calls[]` --
 * never from a raw transcript, which this harness never reads here at all. Null (`{ok:true,
 * ...allNull}`) whenever activation was not expected (a no-skill/candidate-skill condition run) --
 * "never infer, never guess" extends here: a condition where activation is out of scope has no
 * invocation-relative boundary to split calls around.
 *
 * Enforces BIDIRECTIONAL record<->sidecar coherence, failing closed (`{ok:false, error}`) on
 * disagreement rather than trusting either side alone: `targetSkillInvoked !== true` requires the
 * sidecar to show ZERO confirmed (`tool_kind:'target-skill'`, `result_status:'success'`) entries
 * anywhere; `targetSkillInvoked === true` requires AT LEAST ONE confirmed entry whose own
 * `tool_use_event_index` correlates to `record.skill_invocation_event.index` (ties on that index
 * are disambiguated by the sidecar's own unique `ordinal` -- one assistant turn can dispatch
 * several tool_use blocks) -- and, whenever more than one confirmed target-skill entry exists
 * ANYWHERE in the sidecar, the correlated one must be the ordinal-earliest of them, matching
 * `findSkillInvocation()`'s own documented "first confirmed match wins" contract (stream-
 * parser.mjs). A record and sidecar that disagree on any of this can only mean the two files were
 * tampered independently in a way validateRunRecordFile's own schema+hash checks didn't happen to
 * catch -- never in normal operation, and never silently resolved by trusting one side over the
 * other.
 *
 * `target_skill_invocation_ordinal` is the sidecar's OWN global, zero-based `tool_calls[].ordinal`
 * for the confirmed entry -- the SAME convention the sidecar already uses for every other entry, so
 * a delayed activation (several unrelated calls before it) is directly visible as ordinal 3, 4, ...
 * rather than collapsing to a constant. `target_skill_attempt_ordinal` is the SEPARATE, 1-based
 * count of attempts AT THE TARGET SKILL SPECIFICALLY up to and including the confirmed one --
 * answers "did it take multiple tries at the skill itself" as opposed to "how much unrelated work
 * happened first" (the global ordinal / `pre_skill_tool_calls` question). The two are independent:
 * a run can have global ordinal 4 (four unrelated calls first) with attempt ordinal 1 (succeeded on
 * its only try at the skill), or global ordinal 0 with attempt ordinal 2 (an immediate first call
 * that failed, immediately retried and confirmed).
 *
 * `post_skill_tool_calls_total`/`post_skill_policy_denials_total` are ALWAYS populated once
 * `targetSkillInvoked === true`, independent of whether any signal boundary exists -- a failed run
 * that never reached a correct signal still shows real, non-null counts here; only the additional
 * `..._through_signal` pair (calls after invocation up to and including whichever attempt produced
 * the first useful signal -- "through", not "pre", since the signal-producing call itself is
 * included) is null when there is no signal boundary to bound it against.
 * @returns {{ok:true, target_skill_invocation_ordinal:number|null, target_skill_attempt_ordinal:number|null, pre_skill_tool_calls:number|null, pre_skill_policy_denials:number|null, post_skill_tool_calls_total:number|null, post_skill_policy_denials_total:number|null, post_skill_tool_calls_through_signal:number|null, post_skill_policy_denials_through_signal:number|null} | {ok:false, error:string}}
 */
export function deriveSkillRelativeFields(record, sidecar, activationExpected, targetSkillInvoked) {
  const allNull = {
    ok: true, target_skill_invocation_ordinal: null, target_skill_attempt_ordinal: null,
    pre_skill_tool_calls: null, pre_skill_policy_denials: null,
    post_skill_tool_calls_total: null, post_skill_policy_denials_total: null,
    post_skill_tool_calls_through_signal: null, post_skill_policy_denials_through_signal: null,
  };
  if (!activationExpected) return allNull;

  const toolCalls = Array.isArray(sidecar?.tool_calls) ? sidecar.tool_calls : null;
  if (toolCalls == null) {
    return { ok: false, error: 'accepted-run-audit sidecar tool_calls is missing or not an array' };
  }
  const confirmedTargetSkillCalls = toolCalls.filter((tc) => tc?.tool_kind === 'target-skill' && tc?.result_status === 'success');

  if (targetSkillInvoked !== true) {
    if (confirmedTargetSkillCalls.length > 0) {
      return { ok: false, error: 'record reports the target skill as not invoked, but the sidecar shows a confirmed target-skill entry' };
    }
    return allNull;
  }

  const invocationIndex = record.skill_invocation_event?.index;
  if (!Number.isInteger(invocationIndex)) {
    return { ok: false, error: 'skill_invoked is true but skill_invocation_event.index is missing or not an integer' };
  }
  // Matched by tool_use_event_index first (this is the only correlation record<->sidecar share),
  // but ONE assistant event can carry several tool_use blocks -- the sidecar schema only requires
  // `ordinal` to be non-decreasing across entries sharing an event index, never unique per event.
  // When more than one confirmed target-skill entry shares this exact event index, `ordinal` (the
  // sidecar's own unique, strictly 0..N-1 position) is the only reliable disambiguator; falling
  // back to the first `tool_use_event_index` match alone previously misidentified the wrong entry.
  const candidateInvocationEntries = confirmedTargetSkillCalls.filter((tc) => tc.tool_use_event_index === invocationIndex);
  if (candidateInvocationEntries.length === 0) {
    return { ok: false, error: 'record reports the target skill as invoked, but no confirmed sidecar entry correlates to skill_invocation_event.index' };
  }
  const invocationEntry = candidateInvocationEntries.length === 1
    ? candidateInvocationEntries[0]
    : candidateInvocationEntries.reduce((min, tc) => (Number.isInteger(tc.ordinal) && tc.ordinal < min.ordinal ? tc : min));
  if (!Number.isInteger(invocationEntry.ordinal)) {
    return { ok: false, error: 'the correlated sidecar entry is missing a valid ordinal' };
  }
  // findSkillInvocation()'s own documented contract (stream-parser.mjs): the record's
  // skill_invocation_event always represents the FIRST confirmed match in transcript order, never
  // a later one, whenever more than one confirmed target-skill entry exists anywhere in the
  // sidecar. A record correlating to anything but the ordinal-earliest confirmed entry disagrees
  // with that contract -- fail closed rather than silently accept a later one.
  const earliestConfirmedOrdinal = Math.min(...confirmedTargetSkillCalls.filter((tc) => Number.isInteger(tc.ordinal)).map((tc) => tc.ordinal));
  if (invocationEntry.ordinal !== earliestConfirmedOrdinal) {
    return { ok: false, error: 'record correlates to a confirmed target-skill entry that is not the ordinal-earliest one, contradicting findSkillInvocation\'s own representative-match contract' };
  }

  const target_skill_invocation_ordinal = invocationEntry.ordinal;
  // Already in strictly ascending ordinal order by construction (validateAcceptedRunAuditSidecar
  // guarantees `tool_calls[]` ordinals are exactly 0..N-1 in order) -- filtering preserves that
  // order, so no separate sort is needed; a defensive sort-by-ordinal (never by the possibly-tied
  // tool_use_event_index) is kept anyway in case a caller ever hands this function an unordered array.
  const allTargetSkillAttempts = toolCalls
    .filter((tc) => tc?.tool_kind === 'target-skill' && Number.isInteger(tc?.ordinal))
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal);
  const attemptIdx = allTargetSkillAttempts.findIndex((tc) => tc.ordinal === invocationEntry.ordinal);
  const target_skill_attempt_ordinal = attemptIdx + 1;

  // Pre/post-skill counts partition by ORDINAL (the sidecar's own unique position marker), never
  // by tool_use_event_index -- ties on the event index would otherwise silently vanish from BOTH
  // the pre and post buckets (neither `<` nor `>` an equal value), exactly the gap a real repro
  // (a failed attempt, its successful retry, and a third call all dispatched in one assistant
  // turn) demonstrated.
  const preEntries = toolCalls.filter((tc) => Number.isInteger(tc?.ordinal) && tc.ordinal < invocationEntry.ordinal);
  const pre_skill_tool_calls = preEntries.length;
  const pre_skill_policy_denials = preEntries.filter((tc) => tc.policy_decision === 'deny').length;

  const postEntries = toolCalls.filter((tc) => Number.isInteger(tc?.ordinal) && tc.ordinal > invocationEntry.ordinal);
  const post_skill_tool_calls_total = postEntries.length;
  const post_skill_policy_denials_total = postEntries.filter((tc) => tc.policy_decision === 'deny').length;

  const hasSignalBoundary = sidecar.first_useful_signal_event != null;
  let post_skill_tool_calls_through_signal = null;
  let post_skill_policy_denials_through_signal = null;
  if (hasSignalBoundary) {
    const throughSignal = postEntries.filter((tc) => MID_PHASE_VALUES.has(tc.phase));
    post_skill_tool_calls_through_signal = throughSignal.length;
    post_skill_policy_denials_through_signal = throughSignal.filter((tc) => tc.policy_decision === 'deny').length;
  }

  return {
    ok: true, target_skill_invocation_ordinal, target_skill_attempt_ordinal,
    pre_skill_tool_calls, pre_skill_policy_denials,
    post_skill_tool_calls_total, post_skill_policy_denials_total,
    post_skill_tool_calls_through_signal, post_skill_policy_denials_through_signal,
  };
}

/**
 * Pure per-run analysis -- never touches the filesystem. Assumes `record` already passed
 * validateRunRecordFile with zero errors (schema>=5, run_kind:'scenario') and `sidecar` is that
 * SAME record's own already-validated accepted-run-audit sidecar object; callers (analyzeRunsDir)
 * are responsible for that gate. Returns `{ok:false, error}` (content-free) on an internal
 * inconsistency deriveSkillRelativeFields or a missing grading check surfaces -- callers must treat
 * this exactly like a malformed sibling (excluded from per_run, reported in errors[]).
 * @returns {{ok:true, entry:object} | {ok:false, error:string}}
 */
export function analyzeRunRecord(record, sidecar) {
  const activation_expected = record.condition === 'current-skill';
  // targetSkillInvokedView (run-record-view.mjs): for schema>=6, reads
  // skill_observation.activation.status (canonical activation, Section F); below schema 6, reads
  // the legacy skill_invoked.value field exactly as before. Schema invariant 8 already requires the
  // two sources to agree for claude-code, so this is a behavior-preserving read for every record
  // this PR can produce today.
  const rawInvoked = targetSkillInvokedView(record);
  const target_skill_invoked = activation_expected ? rawInvoked : null;

  const skillFields = deriveSkillRelativeFields(record, sidecar, activation_expected, target_skill_invoked);
  if (!skillFields.ok) return { ok: false, error: skillFields.error };
  const productUsage = deriveProductUsage(sidecar);
  if (!productUsage.ok) return { ok: false, error: productUsage.error };

  const checks = record.grading_checks?.value ?? null;
  const evidenceCheck = findCheck(checks, CHECK_EVIDENCE_WELL_FORMED);
  const targetCheck = findCheck(checks, CHECK_TARGET_MATCHES);
  const outcomeCheck = findCheck(checks, CHECK_OUTCOME_MATCHES);
  const finalAnswerCheck = findCheck(checks, CHECK_FINAL_ANSWER);
  if (evidenceCheck == null || targetCheck == null || outcomeCheck == null || finalAnswerCheck == null) {
    return { ok: false, error: 'grading_checks is missing one or more required check names' };
  }

  const first_useful_signal_present = record.first_useful_signal_event != null;
  const terminal_authoritative_evidence_present = sidecar?.terminal_authoritative_event != null;
  const terminal_authoritative_evidence_well_formed = evidenceCheck.passed === true;
  const expected_outcome_matched = record.expected_outcome_matched?.value ?? null;
  const final_answer_consistent = finalAnswerCheck.passed === true;
  const success = record.success?.value ?? null;
  const post_signal_tool_calls = record.post_signal_tool_calls?.value ?? null;
  const finalAnswerBlock = finalAnswerBlockView(sidecar, final_answer_consistent);
  const coverage_gate_diagnostic = typeof sidecar?.terminal_evidence?.coverage_gate_diagnostic === 'string'
    ? sidecar.terminal_evidence.coverage_gate_diagnostic
    : 'not-recorded';
  const task_outcome_matched = expected_outcome_matched;
  const answer_protocol_matched = final_answer_consistent;
  const programmatic_evidence_available = terminal_authoritative_evidence_present === true
    && terminal_authoritative_evidence_well_formed === true;
  const canonical_final_answer_available = finalAnswerBlock.found === true
    && finalAnswerBlock.parsed === true
    && finalAnswerBlock.matches_observed === true;
  const canonical_output_available = programmatic_evidence_available === true
    && canonical_final_answer_available === true;
  const evidence_quality = evidenceQualityFor({
    productCliUsed: productUsage.product_cli_used,
    terminalEvidencePresent: terminal_authoritative_evidence_present,
    terminalEvidenceWellFormed: terminal_authoritative_evidence_well_formed,
    finalAnswerBlockFound: finalAnswerBlock.found,
    finalAnswerBlockParsed: finalAnswerBlock.parsed,
  });
  const programmatic_product_outcome_matched = productUsage.product_cli_used === true
    && terminal_authoritative_evidence_present === true
    && terminal_authoritative_evidence_well_formed === true
    && expected_outcome_matched === true;
  const final_answer_protocol_only_failure = expected_outcome_matched === true
    && final_answer_consistent === false
    && success === false;

  const failure_class = classifyFailure({
    success,
    activationExpected: activation_expected,
    targetSkillInvoked: target_skill_invoked,
    hookDenyCount: record.hook_deny_count,
    terminalEvidencePresent: terminal_authoritative_evidence_present,
    terminalEvidenceWellFormed: terminal_authoritative_evidence_well_formed,
    targetMatchesExpected: targetCheck.passed,
    outcomeMatchesExpected: outcomeCheck.passed,
    finalAnswerConsistent: final_answer_consistent,
  });

  return {
    ok: true,
    entry: {
      run_id: record.run_id,
      scenario_id: record.scenario_id,
      condition: record.condition,
      activation_expected,
      target_skill_invoked,
      target_skill_invocation_ordinal: skillFields.target_skill_invocation_ordinal,
      target_skill_attempt_ordinal: skillFields.target_skill_attempt_ordinal,
      pre_skill_tool_calls: skillFields.pre_skill_tool_calls,
      pre_skill_policy_denials: skillFields.pre_skill_policy_denials,
      post_skill_tool_calls_total: skillFields.post_skill_tool_calls_total,
      post_skill_policy_denials_total: skillFields.post_skill_policy_denials_total,
      post_skill_tool_calls_through_signal: skillFields.post_skill_tool_calls_through_signal,
      post_skill_policy_denials_through_signal: skillFields.post_skill_policy_denials_through_signal,
      post_signal_tool_calls,
      first_useful_signal_present,
      terminal_authoritative_evidence_present,
      terminal_authoritative_evidence_well_formed,
      expected_outcome_matched,
      final_answer_consistent,
      task_outcome_matched,
      answer_protocol_matched,
      programmatic_evidence_available,
      canonical_final_answer_available,
      canonical_output_available,
      evidence_quality,
      coverage_gate_diagnostic,
      success,
      failure_class,
      product_access_mode: productAccessModeFor(record),
      product_usage_mode: productUsage.product_usage_mode,
      product_cli_command_count: productUsage.product_cli_command_count,
      product_cli_recognized_operation_distribution: productUsage.product_cli_recognized_operation_distribution,
      product_cli_parallel_command_count: productUsage.product_cli_parallel_command_count,
      product_cli_coverage_command_count: productUsage.product_cli_coverage_command_count,
      product_cli_describe_command_count: productUsage.product_cli_describe_command_count,
      product_cli_doctor_command_count: productUsage.product_cli_doctor_command_count,
      product_cli_other_recognized_command_count: productUsage.product_cli_other_recognized_command_count,
      product_cli_unrecognized_operation_count: productUsage.product_cli_unrecognized_operation_count,
      direct_build_tool_command_count: productUsage.direct_build_tool_command_count,
      other_bash_command_count: productUsage.other_bash_command_count,
      product_cli_used: productUsage.product_cli_used,
      programmatic_product_outcome_matched,
      final_answer_protocol_only_failure,
      // agent_runtime/execution_profile/skill_observation (Section F): the FULL real object for
      // schema>=6, or the literal "not-recorded" sentinel below schema 6 -- never narrowed the way
      // aggregate.mjs's own partition-key projection is, since these are human-readable reporting
      // fields, not a bucketing key.
      agent_runtime: agentRuntimeView(record),
      execution_profile: executionProfileView(record),
      skill_observation: skillObservationView(record),
      // usage: the real v6 usage object, or run-record-view.mjs's canonical not-recorded shape
      // (every dimension null, never zero) below schema 6.
      usage: usageView(record),
    },
  };
}

function rate(count, total) {
  return total > 0 ? count / total : null;
}

/** Compact frequency map -- e.g. {0: 3, 1: 2, null: 1} rendered as string keys for JSON safety.
 * Never a raw array of every value (which would grow unboundedly with run count); a distribution is
 * exactly as informative and stays flat regardless of how many runs share a value. */
function buildDistribution(values) {
  const dist = {};
  for (const v of values) {
    const key = v === null ? 'null' : String(v);
    dist[key] = (dist[key] ?? 0) + 1;
  }
  return dist;
}

/** Compact {source_value: count} map over a group's own entries -- e.g. {"runtime-reported": 4,
 * "not-recorded": 2}. Mirrors buildDistribution's own flat-map shape/rationale, scoped to
 * usage.source specifically (never a raw per-run array). */
function buildUsageSourceCounts(entries) {
  const counts = {};
  for (const e of entries) {
    const src = e.usage?.source ?? 'not-recorded';
    counts[src] = (counts[src] ?? 0) + 1;
  }
  return counts;
}

function productAccessModeFor(record) {
  if (PRODUCT_ACCESS_MODE_VALUES.includes(record?.product_access_mode)) return record.product_access_mode;
  return productAccessModeView(record);
}

function incrementCount(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function sumCountMaps(entries, field) {
  const counts = {};
  for (const entry of entries) {
    const source = entry[field];
    if (source == null || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (Number.isInteger(value) && value >= 0) counts[key] = (counts[key] ?? 0) + value;
    }
  }
  return counts;
}

function deriveProductUsage(sidecar) {
  const toolCalls = Array.isArray(sidecar?.tool_calls) ? sidecar.tool_calls : null;
  if (toolCalls == null) return { ok: false, error: 'accepted-run-audit sidecar tool_calls is missing or not an array' };
  const productCalls = toolCalls.filter((tc) => tc?.tool_kind === 'kmp-test');
  const productCount = productCalls.length;
  const gradleCount = toolCalls.filter((tc) => tc?.tool_kind === 'gradle').length;
  const otherBashCount = toolCalls.filter((tc) => tc?.tool_kind === 'other-bash').length;
  const recognizedOperationCounts = {};
  let unrecognizedOperationCount = 0;
  for (const tc of productCalls) {
    if (typeof tc.recognized_operation === 'string' && tc.recognized_operation.length > 0) {
      incrementCount(recognizedOperationCounts, tc.recognized_operation);
    } else {
      unrecognizedOperationCount += 1;
    }
  }
  let product_usage_mode = 'none';
  if (productCount > 0 && gradleCount > 0) product_usage_mode = 'mixed-product-and-build-tool';
  else if (productCount > 0) product_usage_mode = 'product-cli';
  else if (gradleCount > 0) product_usage_mode = 'direct-build-tool';
  else if (otherBashCount > 0) product_usage_mode = 'manual-other';
  return {
    ok: true,
    product_usage_mode,
    product_cli_command_count: productCount,
    product_cli_recognized_operation_distribution: recognizedOperationCounts,
    product_cli_parallel_command_count: recognizedOperationCounts.parallel ?? 0,
    product_cli_coverage_command_count: recognizedOperationCounts.coverage ?? 0,
    product_cli_describe_command_count: recognizedOperationCounts.describe ?? 0,
    product_cli_doctor_command_count: recognizedOperationCounts.doctor ?? 0,
    product_cli_other_recognized_command_count: recognizedOperationCounts.other ?? 0,
    product_cli_unrecognized_operation_count: unrecognizedOperationCount,
    direct_build_tool_command_count: gradleCount,
    other_bash_command_count: otherBashCount,
    product_cli_used: productCount > 0,
  };
}

function buildGroupSummary(groupKey, entries, record) {
  const total = entries.length;
  const activationExpectedEntries = entries.filter((e) => e.activation_expected === true);
  // P1 architectural review: null (an indirect/not-observable activation -- see
  // targetSkillInvokedView's own doc comment) must be excluded from BOTH the numerator and the
  // denominator, never merely left out of the numerator while still diluting the denominator --
  // that would silently treat "unobservable" as "not invoked", the exact null-becomes-zero
  // coercion this harness refuses everywhere else. Only a real boolean is an "observable" verdict.
  const observableEntries = activationExpectedEntries.filter((e) => typeof e.target_skill_invoked === 'boolean');
  const invokedCount = observableEntries.filter((e) => e.target_skill_invoked === true).length;
  const evidencePresentCount = entries.filter((e) => e.terminal_authoritative_evidence_present === true).length;
  const evidenceWellFormedCount = entries.filter((e) => e.terminal_authoritative_evidence_well_formed === true).length;
  const outcomeMatchedCount = entries.filter((e) => e.expected_outcome_matched === true).length;
  const taskOutcomeMatchedCount = entries.filter((e) => e.task_outcome_matched === true).length;
  const answerProtocolMatchedCount = entries.filter((e) => e.answer_protocol_matched === true).length;
  const programmaticEvidenceAvailableCount = entries.filter((e) => e.programmatic_evidence_available === true).length;
  const canonicalFinalAnswerAvailableCount = entries.filter((e) => e.canonical_final_answer_available === true).length;
  const canonicalOutputAvailableCount = entries.filter((e) => e.canonical_output_available === true).length;
  const successCount = entries.filter((e) => e.success === true).length;
  const productCliUsedCount = entries.filter((e) => e.product_cli_used === true).length;
  const programmaticProductOutcomeMatchedCount = entries.filter((e) => e.programmatic_product_outcome_matched === true).length;
  const finalAnswerProtocolOnlyFailureCount = entries.filter((e) => e.final_answer_protocol_only_failure === true).length;

  const failure_class_counts = {};
  for (const cls of FAILURE_CLASS_VALUES) failure_class_counts[cls] = 0;
  for (const e of entries) failure_class_counts[e.failure_class] = (failure_class_counts[e.failure_class] ?? 0) + 1;

  // P1 architectural review: execution_profile.isolation_attestation_sha256 and
  // skill_observation.{availability,activation} are OBSERVED OUTCOMES/per-execution evidence,
  // deliberately excluded from the hard partition key (run-record-view.mjs's own documented
  // rationale) -- two entries in this SAME group (same partition key) can genuinely disagree on
  // them, so publishing entries[0]'s own full value would misrepresent it as if every entry shared
  // the identical result. Reported as counts/distributions instead; the exact per-run value stays
  // available on each individual entry (never summarized away).
  const attestationRecordedCount = entries.filter((e) => typeof e.execution_profile?.isolation_attestation_sha256 === 'string').length;
  const availabilityStatusDistribution = buildDistribution(entries.map((e) => e.skill_observation?.availability?.status ?? null));
  const activationStatusDistribution = buildDistribution(entries.map((e) => e.skill_observation?.activation?.status ?? null));

  return {
    group_key: groupKey,
    run_count: total,
    // agent_runtime (Section F): every field is an identity/request-time fact, never an observed
    // outcome, and the whole object is itself a hard partition key -- genuinely identical across
    // every entry in this group by construction, so entries[0]'s own value IS the group's value.
    agent_runtime: entries[0].agent_runtime,
    // execution_profile / skill_observation (P1 architectural review): the NARROWED partition
    // views already computed once by withPartitionView onto this bucket's own `record` (never
    // re-derived here, never entries[0]'s own FULL, potentially-outcome-carrying value) -- sha256
    // is (Phase 2 of this PR) now guaranteed to be the canonical hash of every semantic field on
    // the profile, so it alone already fully captures identity; skill_treatment excludes
    // availability/activation for the exact same reason.
    execution_profile: record.execution_profile,
    execution_profile_attestation_recorded_count: attestationRecordedCount,
    execution_profile_attestation_missing_count: total - attestationRecordedCount,
    skill_observation: record.skill_treatment,
    skill_observation_availability_status_distribution: availabilityStatusDistribution,
    skill_observation_activation_status_distribution: activationStatusDistribution,
    activation_expected_count: activationExpectedEntries.length,
    target_skill_invoked_observable_count: observableEntries.length,
    target_skill_invoked_unknown_count: activationExpectedEntries.length - observableEntries.length,
    target_skill_invoked_count: invokedCount,
    target_skill_invoked_rate: rate(invokedCount, observableEntries.length),
    terminal_authoritative_evidence_present_count: evidencePresentCount,
    terminal_authoritative_evidence_present_rate: rate(evidencePresentCount, total),
    terminal_authoritative_evidence_well_formed_count: evidenceWellFormedCount,
    terminal_authoritative_evidence_well_formed_rate: rate(evidenceWellFormedCount, total),
    expected_outcome_matched_count: outcomeMatchedCount,
    expected_outcome_matched_rate: rate(outcomeMatchedCount, total),
    task_outcome_matched_count: taskOutcomeMatchedCount,
    task_outcome_matched_rate: rate(taskOutcomeMatchedCount, total),
    answer_protocol_matched_count: answerProtocolMatchedCount,
    answer_protocol_matched_rate: rate(answerProtocolMatchedCount, total),
    programmatic_evidence_available_count: programmaticEvidenceAvailableCount,
    programmatic_evidence_available_rate: rate(programmaticEvidenceAvailableCount, total),
    canonical_final_answer_available_count: canonicalFinalAnswerAvailableCount,
    canonical_final_answer_available_rate: rate(canonicalFinalAnswerAvailableCount, total),
    canonical_output_available_count: canonicalOutputAvailableCount,
    canonical_output_available_rate: rate(canonicalOutputAvailableCount, total),
    evidence_quality_distribution: buildDistribution(entries.map((e) => e.evidence_quality)),
    coverage_gate_diagnostic_distribution: buildDistribution(entries.map((e) => e.coverage_gate_diagnostic)),
    success_count: successCount,
    success_rate: rate(successCount, total),
    product_access_mode_distribution: buildDistribution(entries.map((e) => e.product_access_mode)),
    product_usage_mode_distribution: buildDistribution(entries.map((e) => e.product_usage_mode)),
    product_cli_used_count: productCliUsedCount,
    product_cli_used_rate: rate(productCliUsedCount, total),
    product_cli_recognized_operation_distribution: sumCountMaps(entries, 'product_cli_recognized_operation_distribution'),
    product_cli_parallel_command_count: entries.reduce((sum, e) => sum + (e.product_cli_parallel_command_count ?? 0), 0),
    product_cli_coverage_command_count: entries.reduce((sum, e) => sum + (e.product_cli_coverage_command_count ?? 0), 0),
    product_cli_describe_command_count: entries.reduce((sum, e) => sum + (e.product_cli_describe_command_count ?? 0), 0),
    product_cli_doctor_command_count: entries.reduce((sum, e) => sum + (e.product_cli_doctor_command_count ?? 0), 0),
    product_cli_other_recognized_command_count: entries.reduce((sum, e) => sum + (e.product_cli_other_recognized_command_count ?? 0), 0),
    product_cli_unrecognized_operation_count: entries.reduce((sum, e) => sum + (e.product_cli_unrecognized_operation_count ?? 0), 0),
    programmatic_product_outcome_matched_count: programmaticProductOutcomeMatchedCount,
    programmatic_product_outcome_matched_rate: rate(programmaticProductOutcomeMatchedCount, total),
    final_answer_protocol_only_failure_count: finalAnswerProtocolOnlyFailureCount,
    final_answer_protocol_only_failure_rate: rate(finalAnswerProtocolOnlyFailureCount, total),
    failure_class_counts,
    target_skill_invocation_ordinal_distribution: buildDistribution(entries.map((e) => e.target_skill_invocation_ordinal)),
    target_skill_attempt_ordinal_distribution: buildDistribution(entries.map((e) => e.target_skill_attempt_ordinal)),
    pre_skill_tool_calls_distribution: buildDistribution(entries.map((e) => e.pre_skill_tool_calls)),
    post_skill_tool_calls_total_distribution: buildDistribution(entries.map((e) => e.post_skill_tool_calls_total)),
    // usage (Section F): 5 dimensions reported SEPARATELY, deliberately no summed "tokens_total" --
    // runtime-native token counts are never rankable as if they shared a tokenizer or hidden
    // prompt, so a single combined number would misleadingly imply they are.
    usage_source_counts: buildUsageSourceCounts(entries),
    usage_input_distribution: buildDistribution(entries.map((e) => e.usage?.input ?? null)),
    usage_cached_input_distribution: buildDistribution(entries.map((e) => e.usage?.cached_input ?? null)),
    usage_cache_write_distribution: buildDistribution(entries.map((e) => e.usage?.cache_write ?? null)),
    usage_output_distribution: buildDistribution(entries.map((e) => e.usage?.output ?? null)),
    usage_reasoning_output_distribution: buildDistribution(entries.map((e) => e.usage?.reasoning_output ?? null)),
  };
}

/**
 * Aggregates {record, entry} pairs into one summary group per distinct HARD_PARTITION_FIELDS tuple
 * (schemas.mjs's own Fairness Contract key -- scenario_id and condition are 2 of its 17 fields,
 * satisfying "aggregate by scenario_id and condition" while every OTHER field in that same tuple
 * -- schema, platform, skill_source_sha, model_resolved, policy_sha256, ... -- keeps a differing
 * schema/provenance run in its OWN separate group rather than silently pooled together). Reuses the
 * EXACT canonical-value serialization aggregate.mjs's own bucketing already relies on
 * (canonicalStructuredValue) rather than inventing a second, independently-drifting notion of "the
 * same partition". Never computes a cross-condition comparison (e.g. a current-skill-vs-no-skill
 * lift) -- each condition's runs land in their own group, exactly like aggregate.mjs's Fairness
 * Contract already treats `condition` as a hard partition key.
 * @param {Array<{record:object, entry:object}>} pairs
 */
export function buildSummary(pairs) {
  const buckets = new Map();
  for (const { record, entry } of pairs) {
    // withPartitionView (Section F): projects the 3 new structural partition fields (real value for
    // schema>=6, the literal "not-recorded" sentinel below schema 6) onto a COPY of `record`, the
    // exact same projection aggregate.mjs's own bucketing already applies -- never a second,
    // independently-drifting notion of "legacy vs v6" for this module's own bucketing.
    const view = withPartitionView(record);
    const key = JSON.stringify(HARD_PARTITION_FIELDS.map((f) => canonicalStructuredValue(view[f])));
    if (!buckets.has(key)) buckets.set(key, { record: view, entries: [], sortKey: key });
    buckets.get(key).entries.push(entry);
  }
  const groups = [];
  for (const { record, entries, sortKey } of buckets.values()) {
    const groupKey = {};
    for (const f of HARD_PARTITION_FIELDS) groupKey[f] = record[f];
    groups.push({ ...buildGroupSummary(groupKey, entries, record), __sortKey: sortKey });
  }
  // Tie-break with the FULL canonical bucket key (every HARD_PARTITION_FIELDS value, the exact
  // same string already used to construct the bucket -- never re-derived a second way), not just
  // scenario_id/condition -- two groups differing only in, say, `platform` or `schema` otherwise
  // preserved Map/JS-engine insertion order, which is a function of which record was PROCESSED
  // first (itself downstream of file-listing order), not a property of the data itself: reordering
  // which file happens to come first for an otherwise-identical set of records could silently
  // reorder the output. Plain code-point comparison (`<`/`>`), never localeCompare() -- ICU
  // collation is locale/Node-build-dependent (e.g. "a_b" vs "a-b" can order oppositely across
  // environments), which would make this command's own claimed deterministic JSON output vary by
  // machine; this matches the exact ordering plain Array.prototype.sort() already uses for `files`
  // in analyzeRunsDir. The bucketing key is guaranteed unique per group (two groups sharing every
  // HARD_PARTITION_FIELDS value would have been the SAME bucket), so this comparator can never
  // return 0 for two genuinely different groups.
  groups.sort((a, b) => codePointCompare(a.__sortKey, b.__sortKey));
  return { groups: groups.map(({ __sortKey, ...group }) => group) };
}

function codePointCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Lists `runsDir`'s own top-level `*.json` FILES (never a directory merely named `*.json/`, and
 * never recursing into `audit/`) in deterministic sorted-filename order. `withFileTypes: true`
 * prefilters non-file entries at the listing stage itself, rather than letting one reach
 * validateRunRecordFile's own readFileSync and rely on its EISDIR catch to paper over it. */
function listCandidateFiles(runsDir) {
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.json'))
    .map((d) => d.name)
    .sort();
}

/**
 * The I/O orchestrator cmdAnalyze (cli.mjs) calls directly. Never throws: `--runs-dir` itself is
 * verified to be a readable directory before any listing is attempted (mirrors cmdAnalyze's own
 * pre-flight check, duplicated defensively here so a direct caller bypassing that CLI wrapper gets
 * the identical guarantee); a listing/stat failure on an otherwise-existing path is reported as a
 * single root-level error rather than propagating an uncaught exception.
 *
 * Per file: validateRunRecordFile (schema + sidecar validation, reused verbatim, now returning the
 * already-parsed sidecar so this function never re-reads the file) fails closed into `errors[]` and
 * continues past that ONE file, exactly like cmdAggregate's own preFilterErrors precedent. errors[]
 * entries never echo a file's own self-reported content until that file has already fully
 * validated -- `run_id` is `null` for any entry produced by a file that failed validateRunRecordFile
 * itself (a tampered run_id is exactly the kind of untrusted value that must never round-trip into
 * this command's own output); `file_index` (the file's 0-based position in sorted order) is the
 * always-safe, content-free identifier every entry carries instead.
 *
 * A schema-valid record that is not (schema>=5 AND run_kind:'scenario') is silently out of this
 * command's domain -- counted in `files_excluded_not_applicable`, never erroed (it never had an
 * accepted-run-audit sidecar to read in the first place). A schema-valid, in-domain record whose
 * OWN `benchmark_eligible` is `false` is separately excluded (`files_excluded_benchmark_ineligible`)
 * -- mirroring aggregate.mjs's Fairness Contract, which refuses to fold a benchmark-ineligible run
 * into measurement data outright; this command never pools eligible and ineligible records either.
 * A run_id already seen earlier in this same sorted pass is rejected as a duplicate (never silently
 * inflating a group's own counts) -- the earlier file keeps its per_run entry, the later duplicate
 * is excluded and reported.
 *
 * Every file is accounted for exactly once: files_seen === files_analyzed +
 * files_excluded_not_applicable + files_excluded_benchmark_ineligible + files_errored.
 *
 * The complete return value is passed through a final defense-in-depth privacy scan
 * (tools/lib/redact.mjs's PUBLIC_SHAPE_RULES) before being returned -- see this module's own header
 * for why group_key specifically motivates this even though every other emitted field is already
 * structural-only by construction.
 * @returns {{schema:number, per_run:object[], summary:object, errors:Array<{file_index:number, run_id:string|null, errors:Array}>}}
 */
export function analyzeRunsDir(runsDir) {
  let dirStat;
  try {
    dirStat = statSync(runsDir);
  } catch {
    dirStat = null;
  }
  if (dirStat == null || !dirStat.isDirectory()) {
    return {
      schema: ANALYSIS_SCHEMA, per_run: [],
      summary: { groups: [], files_seen: 0, files_analyzed: 0, files_excluded_not_applicable: 0, files_excluded_benchmark_ineligible: 0, files_errored: 1 },
      errors: [{ file_index: null, run_id: null, errors: [{ field: 'runs-dir', message: '--runs-dir must be an existing, readable directory' }] }],
    };
  }

  let files;
  try {
    files = listCandidateFiles(runsDir);
  } catch {
    return {
      schema: ANALYSIS_SCHEMA, per_run: [],
      summary: { groups: [], files_seen: 0, files_analyzed: 0, files_excluded_not_applicable: 0, files_excluded_benchmark_ineligible: 0, files_errored: 1 },
      errors: [{ file_index: null, run_id: null, errors: [{ field: 'runs-dir', message: 'could not list --runs-dir' }] }],
    };
  }

  const errors = [];
  const perRun = [];
  const pairs = [];
  const seenRunIds = new Set();
  let filesExcludedNotApplicable = 0;
  let filesExcludedBenchmarkIneligible = 0;

  files.forEach((file, fileIndex) => {
    const runPath = join(runsDir, file);
    const { record, sidecar, errors: fileErrors } = validateRunRecordFile(runPath);
    if (fileErrors.length > 0) {
      errors.push({ file_index: fileIndex, run_id: null, errors: fileErrors });
      return;
    }
    if (!(record.schema >= 5 && record.run_kind === 'scenario')) {
      filesExcludedNotApplicable++;
      return;
    }
    if (record.benchmark_eligible !== true) {
      filesExcludedBenchmarkIneligible++;
      return;
    }
    const completenessViolations = findScenarioBenchmarkCompletenessViolations(record);
    if (completenessViolations.length > 0) {
      errors.push({
        file_index: fileIndex, run_id: safeRunIdOrNull(record.run_id),
        errors: completenessViolations.map((field) => ({ field, message: 'benchmark_eligible:true but this field is incomplete, per the same completeness matrix aggregate.mjs enforces' })),
      });
      return;
    }
    const safeRunId = safeRunIdOrNull(record.run_id);
    if (safeRunId != null && seenRunIds.has(safeRunId)) {
      errors.push({ file_index: fileIndex, run_id: safeRunId, errors: [{ field: 'run_id', message: 'duplicate run_id already analyzed earlier in this batch' }] });
      return;
    }
    if (safeRunId != null) seenRunIds.add(safeRunId);

    const analyzed = analyzeRunRecord(record, sidecar);
    if (!analyzed.ok) {
      errors.push({ file_index: fileIndex, run_id: safeRunId, errors: [{ field: '(root)', message: analyzed.error }] });
      return;
    }
    perRun.push(analyzed.entry);
    pairs.push({ record, entry: analyzed.entry });
  });

  const summary = buildSummary(pairs);
  summary.files_seen = files.length;
  summary.files_analyzed = perRun.length;
  summary.files_excluded_not_applicable = filesExcludedNotApplicable;
  summary.files_excluded_benchmark_ineligible = filesExcludedBenchmarkIneligible;
  summary.files_errored = errors.length;

  const result = { schema: ANALYSIS_SCHEMA, per_run: perRun, summary, errors };
  const { ok, redactedObj } = redactObjectAndVerify(result);
  if (ok) return redactedObj;
  // Unreachable by this module's own structural design (every emitted value is already a boolean,
  // integer, closed-vocabulary string, or null) -- kept as a hard, fail-closed backstop rather than
  // an assumption: if the privacy scan ever finds something even AFTER redaction, withhold the
  // batch entirely instead of returning content that failed its own final safety check.
  return {
    schema: ANALYSIS_SCHEMA, per_run: [],
    summary: { groups: [], files_seen: files.length, files_analyzed: 0, files_excluded_not_applicable: 0, files_excluded_benchmark_ineligible: 0, files_errored: 1 },
    errors: [{ file_index: null, run_id: null, errors: [{ field: '(root)', message: 'output failed a final privacy verification and was withheld' }] }],
  };
}

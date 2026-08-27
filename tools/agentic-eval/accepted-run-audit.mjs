#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/accepted-run-audit.mjs -- the privacy-safe structural audit sidecar for an
// accepted (promoted) scenario run record. Makes future accepted-run evidence auditable after the
// gitignored raw transcript is gone: it proves the post-signal/order facts a record's own
// post_signal_ms/post_signal_tool_calls/policy_denials_* metrics claim, from a committed,
// structural derivation of the transcript -- never the raw transcript itself.
//
// Deliberately structural, never content-bearing: every tool_calls[] entry is a category (which
// KIND of call, which broad OPERATION bucket, allow/deny/missing, success/error/missing, and which
// phase relative to the first-useful-signal boundary) -- never a raw command string, task name,
// module filter, path, skill name, or any other free-text/content value. This is what lets the
// sidecar be committed to git at all (unlike the raw stream-json transcript, which stays
// gitignored) without becoming a second copy of the same privacy-sensitive data.
//
// Three independently-testable concerns, deliberately kept separate (mirroring schemas.mjs's own
// validateRun/buildAggregateGroup split):
//  - buildAcceptedRunAuditSidecar: pure builder, from an already-built run record + its own
//    conditionResult + the grader's additive terminalAuthoritativeEventIndex. Never does I/O.
//  - validateAcceptedRunAuditSidecar: self-contained structural/shape/internal-coherence validator
//    -- everything checkable from the sidecar object alone (closed key sets at every nesting
//    level, enum domains, ordinal/index/phase agreement, summary counts matching actual entries).
//  - crossValidateAcceptedRunAuditAgainstRecord: the record-comparison half -- identity fields and
//    metric totals must agree between the sidecar and the run record it was built from.
// finalizeAcceptedRunAuditSidecar wires build->validate->redact->revalidate->hash into the one
// sequence cli.mjs's matrix finalization needs before it can attach `accepted_audit` to a record.
import { createHash } from 'node:crypto';
import { msSinceOrigin } from './runtimes/contract.mjs';
import { classifyBashCommand } from './command-classify.mjs';
import { assertCleanOrThrowObject } from './privacy.mjs';
import { DISPATCH_STATUS_VALUES as BASH_DISPATCH_STATUS_VALUES } from './dispatch-accounting.mjs';
import { canonicalJsonSha256 } from './canonical-json.mjs';

/**
 * Sidecar schema versions. v1 and v2 are FROZEN -- their field lists and validation rules must
 * keep accepting (and keep rejecting) exactly what they did when the 92 v1 + 64 v2 historical
 * sidecars were written, and both still require literally `run_schema:5` (a v5 scenario record
 * accepts only sidecar schema 1 or 2). v2 added per-call `dispatch_status` and the
 * `pre_dispatch_blocked_total` summary counter. v3 (agentic-eval-runtime-neutral-records-v1)
 * conserves v2's `tool_calls`/`summary` shape verbatim, requires the runtime-neutral record family
 * (`run_schema >= 6`), and adds exactly one new top-level field: `run_provenance_sha256`.
 * Extending v2 to accept run_schema 6+ would silently rewrite its own frozen historical contract,
 * which is exactly why v3 exists as its own version instead.
 *
 * Deliberately explicit named constants and no bare `ACCEPTED_AUDIT_SIDECAR_SCHEMA`: a single
 * unversioned name cannot say whether a caller means "a specific historical shape" or "whatever is
 * current", and test builders constructing genuinely v1/v2-shaped sidecars would have had their
 * meaning rewritten underneath them the moment LATEST moved on to a newer version. Use V1/V2 for
 * historical fixtures, LATEST for newly built sidecars, and SUPPORTED for validation -- never
 * convert the LATEST alias into how a historical fixture gets built.
 */
export const ACCEPTED_AUDIT_SIDECAR_SCHEMA_V1 = 1;
export const ACCEPTED_AUDIT_SIDECAR_SCHEMA_V2 = 2;
export const ACCEPTED_AUDIT_SIDECAR_SCHEMA_V3 = 3;
// PR 4 (agentic-eval-isolated-unrestricted-profile-v1): v4 -- the ONE new sidecar version, exclusive
// to a schema:6 record whose execution_profile.policy_mode is "not_applicable". v1/v2/v3 stay
// FROZEN (Section E's own historical contract, now joined by v3's own runtime-neutral-records
// contract): none of their field lists/enums/validators are widened by this PR. See
// expectedAcceptedAuditSchemaFor's own doc comment for the explicit per-record/profile dispatch --
// deliberately never `schema === LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA` as a selector anywhere in
// this module (bumping LATEST to 4 must never silently redirect strict/policy-required schema:6
// records away from v3).
export const ACCEPTED_AUDIT_SIDECAR_SCHEMA_V4 = 4;
// PR observability follow-up: v5 is exclusive to schema:6 + policy_mode:"not_applicable" and
// preserves v4's fields while adding one closed-vocabulary structural operation field per
// tool_calls[] entry. `operation` remains policy/allowlist-sensitive; `recognized_operation` is
// privacy-safe structural visibility for no-policy runs whose record-level allowlists are null by
// design.
export const ACCEPTED_AUDIT_SIDECAR_SCHEMA_V5 = 5;
// PR evidence1-product-vs-free diagnostics: v6 is exclusive to schema:6 +
// policy_mode:"not_applicable". It preserves v5 and adds one privacy-safe terminal_evidence
// object so a failed accepted run can explain its lower cause without opening raw transcripts.
export const ACCEPTED_AUDIT_SIDECAR_SCHEMA_V6 = 6;
// PR evidence1-coverage-gate-diagnostics: v7 is exclusive to schema:6 +
// policy_mode:"not_applicable". It preserves v6 and adds one closed-vocabulary
// coverage_gate_diagnostic leaf to terminal_evidence so coverage-threshold failures can be
// explained without raw commands, paths, or prose.
export const ACCEPTED_AUDIT_SIDECAR_SCHEMA_V7 = 7;
// PR coverage-outcome-observability: v8 is exclusive to schema:6 +
// policy_mode:"not_applicable". It preserves v7 and adds closed, privacy-safe outcome mismatch
// diagnostics for the final KMP_EVAL_RESULT block plus per-attempt coverage-gate
// canonicalization/contract summaries. v1-v7 remain frozen.
export const ACCEPTED_AUDIT_SIDECAR_SCHEMA_V8 = 8;
export const LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA = 8;
export const SUPPORTED_ACCEPTED_AUDIT_SIDECAR_SCHEMAS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);

const SIDECAR_TOP_FIELDS_V1V2 = [
  'schema', 'run_id', 'run_schema', 'run_kind', 'condition', 'scenario_id',
  'first_useful_signal_event', 'terminal_authoritative_event', 'tool_calls', 'summary',
];
const SIDECAR_TOP_FIELDS_V3 = [...SIDECAR_TOP_FIELDS_V1V2, 'run_provenance_sha256'];
// v4 extends v3 with EXACTLY these 3 new top-level fields (Decision H) -- never inside a nested
// execution_profile object (that would duplicate the record's own group under a different key,
// exactly the ambiguity the runbook's own dry-run rule warns against elsewhere).
const SIDECAR_TOP_FIELDS_V4 = [...SIDECAR_TOP_FIELDS_V3, 'execution_profile_id', 'policy_mode', 'isolation_attestation_sha256'];
const SIDECAR_TOP_FIELDS_V6 = [...SIDECAR_TOP_FIELDS_V4, 'terminal_evidence'];
const TOOL_CALL_FIELDS_V1 = [
  'ordinal', 'tool_use_event_index', 'tool_result_event_index', 'tool_kind', 'operation',
  'plan_only', 'policy_decision', 'result_status', 'phase',
];
const TOOL_CALL_FIELDS_V2 = [...TOOL_CALL_FIELDS_V1, 'dispatch_status'];
const TOOL_CALL_FIELDS_V5 = [...TOOL_CALL_FIELDS_V2, 'recognized_operation'];
const SUMMARY_FIELDS_V1 = [
  'tool_calls_total', 'shell_commands_total', 'post_signal_ms', 'post_signal_tool_calls',
  'policy_denials_total', 'policy_denials_before_first_signal', 'policy_denials_after_first_signal',
  'policy_decisions_missing',
];
const SUMMARY_FIELDS_V2 = [...SUMMARY_FIELDS_V1, 'pre_dispatch_blocked_total'];
// v4 adds EXACTLY dispatch_unaccounted_total (Decision H) -- the real acceptance-gate counter under
// not_applicable, where policy_decisions_missing is trivially always 0 (no Bash entry ever carries
// policy_decision:"missing" under this profile, so that field can no longer serve as the gate).
const SUMMARY_FIELDS_V4 = [...SUMMARY_FIELDS_V2, 'dispatch_unaccounted_total'];

/**
 * The ONE explicit per-record/profile dispatch (Decision H: "introduce un helper de dispatch
 * explicito"). Never `record.schema >= 6 ? LATEST : V2` -- that pattern silently breaks the moment
 * LATEST advances (for example, a policy-required schema:6 record must still get v3,
 * byte-identically to before no-policy sidecars existed). schema<6 always gets v2 (the only
 * sidecar version a v5 scenario record's own accepted_audit.schema may point at); schema:6+ gets
 * the current no-policy sidecar only when the record's own execution_profile.policy_mode is
 * genuinely "not_applicable", v3 otherwise (including when execution_profile is missing/malformed
 * -- fails toward the existing, more-constrained v3 contract, never toward the newer no-policy one).
 */
export function expectedAcceptedAuditSchemaFor(record) {
  if (!(record?.schema >= 6)) return ACCEPTED_AUDIT_SIDECAR_SCHEMA_V2;
  if (record.execution_profile?.policy_mode === 'not_applicable') return ACCEPTED_AUDIT_SIDECAR_SCHEMA_V8;
  return ACCEPTED_AUDIT_SIDECAR_SCHEMA_V3;
}

// The exact canonical projection of a run record that identity-binds a v3 sidecar to it
// (Section E) -- excludes accepted_audit itself (the record's own pointer back to this sidecar) to
// avoid a hashing cycle. Runtime/model/profile/platform/commits/delivery/availability/activation
// evidence/source SHA/snapshot identity+size/prompt identity+size are all reachable transitively
// through agent_runtime/execution_profile/skill_observation, so listing those three whole groups
// (rather than picking individual leaf fields out of them) is what actually binds all of it.
const RUN_PROVENANCE_PROJECTION_KEYS = [
  'schema', 'run_id', 'run_kind', 'condition', 'scenario_id',
  'agent_runtime', 'execution_profile', 'skill_observation',
  'platform', 'repo_commit', 'kmp_test_cli_source_sha', 'project_commit',
];

/** SHA-256 of the canonical JSON of exactly RUN_PROVENANCE_PROJECTION_KEYS, taken from `record`.
 * The ONE implementation -- the v3 builder calls this to stamp `run_provenance_sha256`, and
 * crossValidateAcceptedRunAuditAgainstRecord recomputes it from the re-read record and requires
 * exact equality, so a sidecar can never be self-consistent while pointing at a DIFFERENT record's
 * provenance. */
export function computeRunProvenanceSha256(record) {
  const projection = {};
  for (const k of RUN_PROVENANCE_PROJECTION_KEYS) projection[k] = record[k];
  return canonicalJsonSha256(projection);
}

/** Explicit per-version dispatch -- never a fallthrough default, so an unknown version can never
 * silently borrow another version's field list. v3 reuses v2's tool_calls/summary shape verbatim
 * (Section E: "V3 conserva tool calls y summary de v2"). */
function topFieldsFor(schema) {
  if (schema === 8) return SIDECAR_TOP_FIELDS_V6;
  if (schema === 7) return SIDECAR_TOP_FIELDS_V6;
  if (schema === 6) return SIDECAR_TOP_FIELDS_V6;
  if (schema === 4 || schema === 5) return SIDECAR_TOP_FIELDS_V4;
  if (schema === 3) return SIDECAR_TOP_FIELDS_V3;
  return SIDECAR_TOP_FIELDS_V1V2;
}
function toolCallFieldsFor(schema) {
  if (schema === 1) return TOOL_CALL_FIELDS_V1;
  if (schema === 2 || schema === 3 || schema === 4) return TOOL_CALL_FIELDS_V2;
  if (schema === 5 || schema === 6 || schema === 7 || schema === 8) return TOOL_CALL_FIELDS_V5;
  return null;
}
function summaryFieldsFor(schema) {
  if (schema === 1) return SUMMARY_FIELDS_V1;
  if (schema === 2 || schema === 3) return SUMMARY_FIELDS_V2;
  if (schema === 4 || schema === 5 || schema === 6 || schema === 7 || schema === 8) return SUMMARY_FIELDS_V4;
  return null;
}
/** The run record schema compatibility a given sidecar schema requires (Section E's compatibility
 * matrix) -- v1/v2 require exactly 5 (frozen); v3/v4/v5/v6 require the runtime-neutral record
 * family, schema >= 6. An unknown sidecar schema has no required run_schema of its own (validated
 * separately as an unknown version). */
function runSchemaRequirementFor(sidecarSchema) {
  if (sidecarSchema === 1 || sidecarSchema === 2) return { exact: 5 };
  if (sidecarSchema === 3 || sidecarSchema === 4 || sidecarSchema === 5 || sidecarSchema === 6 || sidecarSchema === 7 || sidecarSchema === 8) return { min: 6 };
  return null;
}

const TOOL_KIND_VALUES = ['target-skill', 'non-target-skill', 'kmp-test', 'gradle', 'other-bash', 'unexpected-tool'];
const BASH_FAMILY_TOOL_KINDS = new Set(['kmp-test', 'gradle', 'other-bash']);
const KMP_TEST_RECOGNIZED_OPERATION_VALUES = ['android', 'benchmark', 'changed', 'clean', 'coverage', 'describe', 'doctor', 'info', 'parallel', 'update', 'other'];
const KMP_TEST_RECOGNIZED_OPERATION_SET = new Set(KMP_TEST_RECOGNIZED_OPERATION_VALUES);
const POLICY_DECISION_VALUES = ['allow', 'deny', 'missing', 'not-applicable'];
const RESULT_STATUS_VALUES = ['success', 'error', 'missing'];
const PHASE_VALUES = ['pre-signal', 'produced-signal', 'post-signal', 'no-signal'];
const TERMINAL_EVIDENCE_PROVIDER_VALUES = ['kmp-test', 'gradle'];
const TERMINAL_EVIDENCE_TOP_FIELDS_V6 = [
  'present', 'provider', 'tool_result_event_index', 'evidence_well_formed',
  'target_matches_expected', 'outcome_matches_expected', 'malformed',
  'parallel_evidence_invalid', 'changed_evidence_invalid', 'observed_result',
  'final_answer_block',
];
const TERMINAL_EVIDENCE_TOP_FIELDS_V7 = [...TERMINAL_EVIDENCE_TOP_FIELDS_V6, 'coverage_gate_diagnostic'];
const TERMINAL_EVIDENCE_TOP_FIELDS_V8 = [...TERMINAL_EVIDENCE_TOP_FIELDS_V7, 'coverage_gate_attempts'];
const TERMINAL_OBSERVED_RESULT_FIELDS = [
  'outcome_kind', 'module_matches_expected', 'total', 'passed', 'failed',
  'missed_lines', 'threshold', 'modules_contributing',
];
const TERMINAL_FINAL_ANSWER_BLOCK_FIELDS_V6V7 = ['found', 'parsed', 'ambiguous', 'matches_observed'];
const TERMINAL_FINAL_ANSWER_BLOCK_FIELDS_V8 = [
  ...TERMINAL_FINAL_ANSWER_BLOCK_FIELDS_V6V7,
  'comparison_status',
  'declared_outcome_kind',
  'observed_outcome_kind',
  'missing_fields',
  'mismatch_fields',
  'unexpected_key_count',
];
const TERMINAL_OUTCOME_KIND_VALUES = ['tests_executed', 'no_applicable_tests', 'tests_failed', 'coverage_threshold_exceeded'];
const TERMINAL_FINAL_ANSWER_COMPARISON_STATUS_VALUES = [
  'no-final-text',
  'missing-block',
  'ambiguous-block',
  'invalid-json',
  'no-observed-result',
  'field-mismatch',
  'matched',
];
const TERMINAL_FINAL_ANSWER_MISMATCH_FIELD_VALUES = [
  'module',
  'outcome_kind',
  'total',
  'passed',
  'failed',
  'missed_lines',
  'threshold',
  'modules_contributing',
];
const TERMINAL_COVERAGE_GATE_DIAGNOSTIC_VALUES = [
  'not-applicable',
  'matched',
  'no-terminal-evidence',
  'non-kmp-test-terminal',
  'coverage-only-not-terminal',
  'missing-threshold-gate',
  'coverage-disabled',
  'threshold-mismatch',
  'observed-clean-tests',
  'coverage-evidence-malformed',
  'coverage-outcome-mismatch',
];
const TERMINAL_COVERAGE_GATE_ATTEMPT_FIELDS = [
  'tool_call_ordinal',
  'recognized_operation',
  'terminal_authoritative',
  'canonicalization_status',
  'canonicalization_reason',
  'threshold_relation',
  'tests_contract',
  'coverage_contract',
  'error_contract',
  'exit_code_contract',
  'target_matches_expected',
  'observed_outcome_kind',
  'outcome_matches_expected',
];
const TERMINAL_COVERAGE_GATE_RECOGNIZED_OPERATION_VALUES = ['parallel', 'coverage'];
const TERMINAL_COVERAGE_GATE_THRESHOLD_RELATION_VALUES = ['matches', 'differs', 'missing', 'not-applicable'];
const TERMINAL_COVERAGE_GATE_CANONICALIZATION_STATUS_VALUES = ['canonical', 'uncanonicalizable', 'not-applicable'];
const TERMINAL_COVERAGE_GATE_CANONICALIZATION_REASON_VALUES = [
  'canonical',
  'operation-not-eligible',
  'subcommand-mismatch',
  'plan-mode-contradiction',
  'result-status-contradiction',
  'test-counters-incoherent',
  'warnings-malformed',
  'skipped-malformed',
  'oversized-junit-incomplete',
  'module-scope-incoherent',
  'dispatch-evidence-incoherent',
  'test-detail-incoherent',
  'threshold-missing',
  'threshold-mismatch',
  'coverage-block-incoherent',
  'error-contract-incoherent',
  'exit-code-incoherent',
  'outcome-not-canonicalizable',
];
const TERMINAL_COVERAGE_GATE_CONTRACT_VALUES = ['matches', 'differs', 'unavailable', 'not-applicable'];
/** v2 only. DERIVED from dispatch-accounting.mjs's own canonical Bash vocabulary rather than
 * restated, so the two can never drift: the sidecar's set is exactly that set plus
 * `not_applicable`, which is the non-Bash case (Skill / unexpected-tool) and never a Bash call
 * whose decision went missing -- that is `unaccounted`. Adding a Bash dispatch status in the
 * accounting module therefore widens this vocabulary automatically. */
const DISPATCH_STATUS_VALUES = [...BASH_DISPATCH_STATUS_VALUES, 'not_applicable'];

/** The deterministic, POSIX-style relative path every accepted scenario record's own
 * `accepted_audit.relative_path` must equal exactly -- shared by the builder (cli.mjs's matrix
 * finalization) and cmdValidate's offline resolution, so the two can never independently drift on
 * what "the sidecar's own path" means. */
export function acceptedAuditRelativePathFor(runId) {
  return `audit/${runId}.json`;
}

function rejectUnrecognizedKeys(obj, allowedKeys, field, errors) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const k of Object.keys(obj)) {
    if (!allowedKeys.includes(k)) {
      errors.push({ field: `${field}.${k}`, message: `unrecognized field -- only ${allowedKeys.join(', ')} allowed on ${field}` });
    }
  }
}

function recognizedKmpTestOperation(classification) {
  if (classification?.kind !== 'kmp-test') return null;
  return KMP_TEST_RECOGNIZED_OPERATION_SET.has(classification.subcommand) ? classification.subcommand : 'other';
}

/**
 * Classifies one canonical observation.toolAttempts[] entry into the sidecar's own closed-vocabulary
 * tool_calls[] entry shape -- structural categories only, never the entry's own raw command/input.
 *
 * `dispatchStatusByAttempt` is CONSUMED, never re-derived: it is the canonical per-attempt
 * classification buildBashDispatchAccounting already produced for this condition. This function
 * never recombines `decisionByAttempt` with a recognized-id set of its own, and never infers a
 * status the map did not supply -- two independent derivations of the same fact is exactly how the
 * two channels would drift apart. The one place the matcher is re-consulted is a COHERENCE check on
 * a `pre_dispatch_blocked` entry (does the observation's own `preDispatchBlock.recognized` still
 * agree?), reading the runtime adapter's already-computed verdict rather than re-running the strict
 * transcript matcher itself -- which can only ever reject, never assign.
 */
function classifyToolCall(a, { acceptedAuditSchema, allowedGradleTasks, allowedKmpTestSubcommands, decisionByAttempt, dispatchStatusByAttempt, firstUsefulSignalEventIndex, policyMode }) {
  let toolKind;
  let operation = null;
  let recognizedOperation = null;
  let planOnly = null;
  let policyDecision = 'not-applicable';
  // Non-Bash tools never enter hook dispatch at all.
  let dispatchStatus = 'not_applicable';

  if (a.kind === 'skill') {
    toolKind = a.targetsExpectedSkill ? 'target-skill' : 'non-target-skill';
  } else if (a.kind === 'shell') {
    const classification = classifyBashCommand(a.command);
    if (classification.kind === 'kmp-test') {
      toolKind = 'kmp-test';
      operation = classification.subcommand != null && allowedKmpTestSubcommands.includes(classification.subcommand) ? classification.subcommand : 'other';
      recognizedOperation = recognizedKmpTestOperation(classification);
      planOnly = classification.isPlanOnly === true;
    } else if (classification.kind === 'gradle') {
      toolKind = 'gradle';
      operation = classification.taskTokens.some((t) => allowedGradleTasks.includes(t)) ? 'allowed-task' : 'other';
      planOnly = classification.isPlanOnly === true;
    } else {
      toolKind = 'other-bash';
      planOnly = false;
    }
    const decision = decisionByAttempt.get(a.id);
    // The canonical accounting is the ONLY source of dispatch_status. A missing map, or a missing
    // entry within it, yields `unaccounted` -- deliberately even when decisionByAttempt holds an
    // allow/deny. Re-deriving `hook_evaluated` from the decision here would be a SECOND, independent
    // derivation of the same fact, which is exactly what having a canonical map exists to prevent:
    // it would let a sidecar built without the accounting certify itself as fully hook-evaluated.
    // Because policy_decision below still reports the real decision, that combination
    // (policy_decision:allow + dispatch_status:unaccounted) violates the validator's biconditional
    // and the sidecar fails closed -- which is the intended outcome, not an oversight.
    // Calibrate/smoke never build accepted-run sidecars at all, so they justify no fallback here.
    dispatchStatus = dispatchStatusByAttempt?.get(a.id) ?? 'unaccounted';
    // Coherence check, NOT a second classification: if the map claims this call was blocked before
    // dispatch, the observation's own preDispatchBlock must still agree it was recognized. This
    // catches a corrupted or fabricated map, and throws rather than silently downgrading --
    // downgrading to `unaccounted` would pair with policy_decision:missing and quietly VALIDATE.
    if (dispatchStatus === 'pre_dispatch_blocked' && a.preDispatchBlock?.recognized !== true) {
      throw new Error(`accepted-run-audit: dispatch accounting claims pre_dispatch_blocked for tool_use ordinal at event index ${a.eventIndex}, but the observation's own preDispatchBlock does not agree it was recognized`);
    }
    // PR 4: under policyMode:"not_applicable", policy_decision is ALWAYS "not-applicable" for
    // every Bash entry, REGARDLESS of decisionByAttempt's own value -- decisionByAttempt may carry
    // a synthesized 'allow' under this profile (junit-evidence.mjs's resolveDecisions, driving
    // graders.mjs's own unrelated inclusion logic), which must never leak into this sidecar's
    // policy_decision field as if it were a real policy-hook decision (Decision G/H: "policy no
    // aplicable no puede convertir accounting ausente en aceptable" / "no-policy Bash:
    // policy_decision:not-applicable").
    if (policyMode === 'not_applicable') {
      policyDecision = 'not-applicable';
    } else if (decision === 'allow') policyDecision = 'allow';
    else if (decision === 'deny') policyDecision = 'deny';
    // A recognized pre-dispatch block has no policy decision to report, and calling it 'missing'
    // would be false: nothing went missing -- the hook was never reached, so no decision was ever
    // due. 'not-applicable' is the honest value, and the validator only permits it on a Bash call
    // whose dispatch_status is exactly pre_dispatch_blocked.
    else if (dispatchStatus === 'pre_dispatch_blocked') policyDecision = 'not-applicable';
    else policyDecision = 'missing';
  } else {
    toolKind = 'unexpected-tool';
  }

  const resultStatus = !a.result.found ? 'missing' : (a.result.isError === true ? 'error' : 'success');

  let phase;
  if (firstUsefulSignalEventIndex == null) {
    phase = 'no-signal';
  } else if (a.result.found && a.result.eventIndex === firstUsefulSignalEventIndex) {
    phase = 'produced-signal';
  } else if (a.eventIndex > firstUsefulSignalEventIndex) {
    phase = 'post-signal';
  } else {
    phase = 'pre-signal';
  }

  const out = {
    tool_use_event_index: a.eventIndex,
    tool_result_event_index: a.result.found ? a.result.eventIndex : null,
    tool_kind: toolKind,
    operation,
    plan_only: planOnly,
    policy_decision: policyDecision,
    result_status: resultStatus,
    phase,
    dispatch_status: dispatchStatus,
  };
  if (acceptedAuditSchema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V5
    || acceptedAuditSchema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V6
    || acceptedAuditSchema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V7
    || acceptedAuditSchema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V8) out.recognized_operation = recognizedOperation;
  return out;
}

function materializeCoverageGateAttemptsForSidecar(coverageGateAttempts, toolCalls) {
  if (!Array.isArray(coverageGateAttempts)) return [];
  return coverageGateAttempts.map((attempt) => {
    const ordinal = toolCalls.find((tc) => tc.tool_result_event_index === attempt.tool_result_event_index)?.ordinal ?? -1;
    return {
      tool_call_ordinal: ordinal,
      recognized_operation: attempt.recognized_operation ?? null,
      terminal_authoritative: attempt.terminal_authoritative === true,
      canonicalization_status: attempt.canonicalization_status ?? 'uncanonicalizable',
      canonicalization_reason: attempt.canonicalization_reason ?? 'outcome-not-canonicalizable',
      threshold_relation: attempt.threshold_relation ?? 'missing',
      tests_contract: attempt.tests_contract ?? 'unavailable',
      coverage_contract: attempt.coverage_contract ?? 'unavailable',
      error_contract: attempt.error_contract ?? 'unavailable',
      exit_code_contract: attempt.exit_code_contract ?? 'unavailable',
      target_matches_expected: attempt.target_matches_expected ?? null,
      observed_outcome_kind: attempt.observed_outcome_kind ?? null,
      outcome_matches_expected: attempt.outcome_matches_expected ?? null,
    };
  });
}

function materializeTerminalEvidenceForSidecar(terminalEvidence, toolCalls, sidecarSchema) {
  if (terminalEvidence == null || sidecarSchema !== ACCEPTED_AUDIT_SIDECAR_SCHEMA_V8) return terminalEvidence;
  return {
    ...terminalEvidence,
    coverage_gate_attempts: materializeCoverageGateAttemptsForSidecar(terminalEvidence.coverage_gate_attempts, toolCalls),
  };
}

/**
 * Builds the structural audit sidecar for one accepted scenario run record. Pure -- never touches
 * the filesystem, never redacts (see finalizeAcceptedRunAuditSidecar for that). `record` supplies
 * identity fields (run_id/schema/run_kind/condition/scenario_id), the first-useful-signal event
 * ref, and the policy-allowed lists it already carries; `conditionResult` supplies the canonical
 * observation this record's own condition produced plus its decision-attribution map;
 * `terminalAuthoritativeEventIndex` is graders.mjs's own additive gradeScenarioCondition() field --
 * taken directly, never re-derived by guessing from the last Bash call.
 *
 * post_signal_ms/post_signal_tool_calls/policy_denials_{before,after}_first_signal in `summary` are
 * independently RE-DERIVED here from the same observation data buildRunRecord() itself used (not
 * copied from `record`) -- this is what makes crossValidateAcceptedRunAuditAgainstRecord a genuine
 * redundant check, not a tautology.
 * @param {object} opts
 * @param {object} opts.record - an already-built schema-v5 scenario run record
 * @param {object} opts.conditionResult - this record's own conditionResult (observation.toolAttempts,
 *   junitAttribution.decisionByAttempt, observation.process.endedHrtimeNs, observation.timing)
 * @param {number|null} opts.terminalAuthoritativeEventIndex - graders.mjs's gradeScenarioCondition() additive field
 * @param {object|null} opts.terminalEvidence - graders.mjs's privacy-safe terminalEvidence diagnostic
 */
export function buildAcceptedRunAuditSidecar({ record, conditionResult, terminalAuthoritativeEventIndex, terminalEvidence = null }) {
  const observation = conditionResult.observation;
  const decisionByAttempt = conditionResult.junitAttribution?.decisionByAttempt ?? new Map();
  // The canonical per-attempt classification, consumed as-is and never re-derived. If it is absent
  // every Bash call reads as `unaccounted`, so a sidecar built without it cannot validate -- see
  // classifyToolCall for why that is the intended failure mode rather than a gap.
  const dispatchStatusByAttempt = conditionResult.dispatchAccounting?.dispatchStatusByAttempt ?? new Map();
  const firstUsefulSignalEventIndex = record.first_useful_signal_event?.index ?? null;
  const allToolAttempts = observation.toolAttempts ?? [];
  // PR 4: the ONE semantic switch classifyToolCall's own policy_decision derivation keys off.
  const policyMode = record.execution_profile?.policy_mode === 'not_applicable' ? 'not_applicable' : 'required';
  const sidecarSchema = expectedAcceptedAuditSchemaFor(record);

  const toolCalls = allToolAttempts.map((a, ordinal) => ({
    ordinal,
    ...classifyToolCall(a, {
      acceptedAuditSchema: sidecarSchema,
      allowedGradleTasks: record.policy_allowed_gradle_tasks ?? [],
      allowedKmpTestSubcommands: record.policy_allowed_kmptest_subcommands ?? [],
      decisionByAttempt, dispatchStatusByAttempt, firstUsefulSignalEventIndex, policyMode,
    }),
  }));

  const isBashKind = (tc) => BASH_FAMILY_TOOL_KINDS.has(tc.tool_kind);
  const shellCommandsTotal = toolCalls.filter(isBashKind).length;
  const preDispatchBlockedTotal = toolCalls.filter((tc) => isBashKind(tc) && tc.dispatch_status === 'pre_dispatch_blocked').length;
  // dispatch_unaccounted_total (no-policy only, but always computed -- cheap, and keeps this one true
  // source of the count regardless of which sidecar version ends up using it): exact cardinality of
  // genuinely unaccounted Bash calls, the real acceptance-gate under not_applicable (Decision H).
  const dispatchUnaccountedTotal = toolCalls.filter((tc) => isBashKind(tc) && tc.dispatch_status === 'unaccounted').length;

  const hasBoundary = firstUsefulSignalEventIndex != null;
  const postSignalMs = hasBoundary ? msSinceOrigin(observation.process.endedHrtimeNs, observation.timing.receiptNsByEventIndex.get(firstUsefulSignalEventIndex)) : null;
  const postSignalToolCalls = hasBoundary ? toolCalls.filter((tc) => tc.tool_use_event_index > firstUsefulSignalEventIndex).length : null;

  // Decision H: no-policy carries policy_denials_total/policy_denials_before_first_signal/
  // policy_denials_after_first_signal/policy_decisions_missing as null, never a trivially-zero real
  // count (a Bash entry's policy_decision is always exactly "not-applicable" under not_applicable,
  // so "deny"/"missing" can never occur -- a real 0 would misleadingly claim these were genuinely
  // evaluated and found clean, rather than never evaluated at all).
  const isNoPolicySidecarSchema = sidecarSchema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V4
    || sidecarSchema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V5
    || sidecarSchema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V6
    || sidecarSchema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V7
    || sidecarSchema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V8;
  const policyApplies = !isNoPolicySidecarSchema;
  const policyDenialsTotal = policyApplies ? toolCalls.filter((tc) => isBashKind(tc) && tc.policy_decision === 'deny').length : null;
  // Counts ONLY genuinely unaccounted Bash calls under policyApplies (v1-v3's own historical
  // meaning). A recognized pre-dispatch block is deliberately excluded: no decision was ever due
  // for it, so counting it here would report a capture failure that did not happen -- and would
  // keep the accepted-sidecar invariant (must be exactly 0) firing on a run whose dispatch is in
  // fact fully accounted for.
  const policyDecisionsMissing = policyApplies ? toolCalls.filter((tc) => isBashKind(tc) && tc.dispatch_status === 'unaccounted').length : null;
  const policyDenialsBefore = policyApplies && hasBoundary ? toolCalls.filter((tc) => isBashKind(tc) && tc.policy_decision === 'deny' && tc.tool_use_event_index <= firstUsefulSignalEventIndex).length : null;
  const policyDenialsAfter = policyApplies && hasBoundary ? toolCalls.filter((tc) => isBashKind(tc) && tc.policy_decision === 'deny' && tc.tool_use_event_index > firstUsefulSignalEventIndex).length : null;

  const built = {
    schema: sidecarSchema,
    run_id: record.run_id,
    run_schema: record.schema,
    run_kind: record.run_kind,
    condition: record.condition,
    scenario_id: record.scenario_id,
    first_useful_signal_event: record.first_useful_signal_event ?? null,
    terminal_authoritative_event: terminalAuthoritativeEventIndex != null ? { type: 'user.tool_result', index: terminalAuthoritativeEventIndex } : null,
    tool_calls: toolCalls,
    summary: {
      tool_calls_total: toolCalls.length,
      shell_commands_total: shellCommandsTotal,
      post_signal_ms: postSignalMs,
      post_signal_tool_calls: postSignalToolCalls,
      policy_denials_total: policyDenialsTotal,
      policy_denials_before_first_signal: policyDenialsBefore,
      policy_denials_after_first_signal: policyDenialsAfter,
      policy_decisions_missing: policyDecisionsMissing,
      pre_dispatch_blocked_total: preDispatchBlockedTotal,
      ...(isNoPolicySidecarSchema ? { dispatch_unaccounted_total: dispatchUnaccountedTotal } : {}),
    },
  };
  // Decision H: provenance SHA is recomputed for strict and no-policy sidecars -- never gated on
  // `sidecarSchema === LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA` (LATEST can advance independently;
  // that comparison would silently stop stamping it on every v3/strict sidecar the moment it does).
  if (sidecarSchema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V3 || isNoPolicySidecarSchema) {
    built.run_provenance_sha256 = computeRunProvenanceSha256(record);
  }
  if (isNoPolicySidecarSchema) {
    built.execution_profile_id = record.execution_profile.id;
    built.policy_mode = record.execution_profile.policy_mode;
    built.isolation_attestation_sha256 = record.execution_profile.isolation_attestation_sha256;
  }
  if (sidecarSchema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V6
    || sidecarSchema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V7
    || sidecarSchema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V8) {
    built.terminal_evidence = materializeTerminalEvidenceForSidecar(terminalEvidence, toolCalls, sidecarSchema);
  }
  return built;
}

const EVENT_REF_KEYS = ['type', 'index'];

/**
 * Strict event-ref shape (review finding 1a) -- must be null, or an object with EXACTLY the keys
 * type/index (no more, no less), `type` exactly the literal `"user.tool_result"` (not merely any
 * string), and `index` a non-negative INTEGER (not merely any number -- a fractional or negative
 * value can never correlate to a real event position). Applies identically to both
 * first_useful_signal_event and terminal_authoritative_event.
 */
function validateEventRefField(ref, field, errors) {
  if (ref == null) return;
  if (typeof ref !== 'object' || Array.isArray(ref)) {
    errors.push({ field, message: 'must be null or an object with exactly the keys type/index' });
    return;
  }
  const keys = Object.keys(ref);
  if (keys.length !== EVENT_REF_KEYS.length || !EVENT_REF_KEYS.every((k) => keys.includes(k))) {
    errors.push({ field, message: `must have exactly the keys ${EVENT_REF_KEYS.join('/')}, got ${JSON.stringify(keys)}` });
  }
  if (ref.type !== 'user.tool_result') {
    errors.push({ field: `${field}.type`, message: 'must be exactly "user.tool_result"' });
  }
  if (!Number.isInteger(ref.index) || ref.index < 0) {
    errors.push({ field: `${field}.index`, message: 'must be a non-negative integer' });
  }
}

function validateNullableNonNegativeInteger(value, field, errors) {
  if (value !== null && !(Number.isInteger(value) && value >= 0)) {
    errors.push({ field, message: 'must be null or a non-negative integer' });
  }
}

function validateNullableBoolean(value, field, errors) {
  if (value !== null && typeof value !== 'boolean') {
    errors.push({ field, message: 'must be null or a boolean' });
  }
}

function terminalEvidenceFieldsForSidecarSchema(schema) {
  if (schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V6) return TERMINAL_EVIDENCE_TOP_FIELDS_V6;
  if (schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V7) return TERMINAL_EVIDENCE_TOP_FIELDS_V7;
  if (schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V8) return TERMINAL_EVIDENCE_TOP_FIELDS_V8;
  return null;
}

function validateNullableOutcomeKind(value, field, errors) {
  if (value !== null && !TERMINAL_OUTCOME_KIND_VALUES.includes(value)) {
    errors.push({ field, message: `must be null or one of ${TERMINAL_OUTCOME_KIND_VALUES.join('|')}` });
  }
}

function validateNullableDeclaredOutcomeKind(value, field, errors) {
  if (value !== null && value !== 'unrecognized' && !TERMINAL_OUTCOME_KIND_VALUES.includes(value)) {
    errors.push({ field, message: `must be null, unrecognized, or one of ${TERMINAL_OUTCOME_KIND_VALUES.join('|')}` });
  }
}

function validateFieldNameArray(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push({ field, message: 'must be an array' });
    return;
  }
  for (const [i, item] of value.entries()) {
    if (!TERMINAL_FINAL_ANSWER_MISMATCH_FIELD_VALUES.includes(item)) {
      errors.push({ field: `${field}[${i}]`, message: `must be one of ${TERMINAL_FINAL_ANSWER_MISMATCH_FIELD_VALUES.join('|')}` });
    }
  }
}

function validateFinalAnswerBlock(finalBlock, field, errors, schema) {
  if (finalBlock == null || typeof finalBlock !== 'object' || Array.isArray(finalBlock)) {
    errors.push({ field, message: 'must be an object' });
    return;
  }
  const fields = schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V8
    ? TERMINAL_FINAL_ANSWER_BLOCK_FIELDS_V8
    : TERMINAL_FINAL_ANSWER_BLOCK_FIELDS_V6V7;
  rejectUnrecognizedKeys(finalBlock, fields, field, errors);
  for (const f of fields) {
    if (!(f in finalBlock)) errors.push({ field: `${field}.${f}`, message: 'missing required field' });
  }
  for (const f of TERMINAL_FINAL_ANSWER_BLOCK_FIELDS_V6V7) {
    if (f in finalBlock) validateNullableBoolean(finalBlock[f], `${field}.${f}`, errors);
  }
  if (schema !== ACCEPTED_AUDIT_SIDECAR_SCHEMA_V8) return;
  if (!TERMINAL_FINAL_ANSWER_COMPARISON_STATUS_VALUES.includes(finalBlock.comparison_status)) {
    errors.push({ field: `${field}.comparison_status`, message: `must be one of ${TERMINAL_FINAL_ANSWER_COMPARISON_STATUS_VALUES.join('|')}` });
  }
  validateNullableDeclaredOutcomeKind(finalBlock.declared_outcome_kind, `${field}.declared_outcome_kind`, errors);
  validateNullableOutcomeKind(finalBlock.observed_outcome_kind, `${field}.observed_outcome_kind`, errors);
  validateFieldNameArray(finalBlock.missing_fields, `${field}.missing_fields`, errors);
  validateFieldNameArray(finalBlock.mismatch_fields, `${field}.mismatch_fields`, errors);
  if (!(Number.isInteger(finalBlock.unexpected_key_count) && finalBlock.unexpected_key_count >= 0)) {
    errors.push({ field: `${field}.unexpected_key_count`, message: 'must be a non-negative integer' });
  }
  if (finalBlock.matches_observed === true && finalBlock.comparison_status !== 'matched') {
    errors.push({ field: `${field}.comparison_status`, message: 'must be matched when matches_observed is true' });
  }
  if (finalBlock.matches_observed === false && finalBlock.comparison_status === 'matched') {
    errors.push({ field: `${field}.matches_observed`, message: 'must be true when comparison_status is matched' });
  }
}

function validateCoverageGateAttempts(coverageGateAttempts, field, errors, toolCalls, terminalAuthoritativeEvent) {
  if (!Array.isArray(coverageGateAttempts)) {
    errors.push({ field, message: 'must be an array' });
    return;
  }
  let previousOrdinal = -1;
  const seenOrdinals = new Set();
  let terminalCount = 0;
  coverageGateAttempts.forEach((attempt, i) => {
    const label = `${field}[${i}]`;
    if (attempt == null || typeof attempt !== 'object' || Array.isArray(attempt)) {
      errors.push({ field: label, message: 'must be an object' });
      return;
    }
    rejectUnrecognizedKeys(attempt, TERMINAL_COVERAGE_GATE_ATTEMPT_FIELDS, label, errors);
    for (const f of TERMINAL_COVERAGE_GATE_ATTEMPT_FIELDS) {
      if (!(f in attempt)) errors.push({ field: `${label}.${f}`, message: 'missing required field' });
    }
    if (!Number.isInteger(attempt.tool_call_ordinal) || attempt.tool_call_ordinal < 0) {
      errors.push({ field: `${label}.tool_call_ordinal`, message: 'must be a non-negative integer' });
    } else {
      if (attempt.tool_call_ordinal <= previousOrdinal) {
        errors.push({ field: `${label}.tool_call_ordinal`, message: 'must be unique and strictly increasing' });
      }
      previousOrdinal = attempt.tool_call_ordinal;
      if (seenOrdinals.has(attempt.tool_call_ordinal)) {
        errors.push({ field: `${label}.tool_call_ordinal`, message: 'must be unique' });
      }
      seenOrdinals.add(attempt.tool_call_ordinal);
      const tc = toolCalls?.[attempt.tool_call_ordinal];
      if (tc == null) {
        errors.push({ field: `${label}.tool_call_ordinal`, message: 'does not point to an existing tool_calls[] entry' });
      } else {
        if (tc.tool_kind !== 'kmp-test') errors.push({ field: `${label}.tool_call_ordinal`, message: 'must point to a kmp-test tool call' });
        if (attempt.recognized_operation !== tc.recognized_operation) {
          errors.push({ field: `${label}.recognized_operation`, message: 'must match the pointed tool_calls[] recognized_operation' });
        }
        if (attempt.terminal_authoritative && terminalAuthoritativeEvent != null && tc.tool_result_event_index !== terminalAuthoritativeEvent.index) {
          errors.push({ field: `${label}.terminal_authoritative`, message: 'must point to terminal_authoritative_event when true' });
        }
      }
    }
    if (!TERMINAL_COVERAGE_GATE_RECOGNIZED_OPERATION_VALUES.includes(attempt.recognized_operation)) {
      errors.push({ field: `${label}.recognized_operation`, message: `must be one of ${TERMINAL_COVERAGE_GATE_RECOGNIZED_OPERATION_VALUES.join('|')}` });
    }
    if (typeof attempt.terminal_authoritative !== 'boolean') {
      errors.push({ field: `${label}.terminal_authoritative`, message: 'must be a boolean' });
    }
    for (const f of ['target_matches_expected', 'outcome_matches_expected']) {
      validateNullableBoolean(attempt[f], `${label}.${f}`, errors);
    }
    validateNullableOutcomeKind(attempt.observed_outcome_kind, `${label}.observed_outcome_kind`, errors);
    for (const f of ['tests_contract', 'coverage_contract', 'error_contract', 'exit_code_contract']) {
      if (!TERMINAL_COVERAGE_GATE_CONTRACT_VALUES.includes(attempt[f])) {
        errors.push({ field: `${label}.${f}`, message: `must be one of ${TERMINAL_COVERAGE_GATE_CONTRACT_VALUES.join('|')}` });
      }
    }
    if (!TERMINAL_COVERAGE_GATE_THRESHOLD_RELATION_VALUES.includes(attempt.threshold_relation)) {
      errors.push({ field: `${label}.threshold_relation`, message: `must be one of ${TERMINAL_COVERAGE_GATE_THRESHOLD_RELATION_VALUES.join('|')}` });
    }
    if (!TERMINAL_COVERAGE_GATE_CANONICALIZATION_STATUS_VALUES.includes(attempt.canonicalization_status)) {
      errors.push({ field: `${label}.canonicalization_status`, message: `must be one of ${TERMINAL_COVERAGE_GATE_CANONICALIZATION_STATUS_VALUES.join('|')}` });
    }
    if (!TERMINAL_COVERAGE_GATE_CANONICALIZATION_REASON_VALUES.includes(attempt.canonicalization_reason)) {
      errors.push({ field: `${label}.canonicalization_reason`, message: `must be one of ${TERMINAL_COVERAGE_GATE_CANONICALIZATION_REASON_VALUES.join('|')}` });
    }
    if (attempt.canonicalization_status === 'canonical' && attempt.canonicalization_reason !== 'canonical') {
      errors.push({ field: `${label}.canonicalization_reason`, message: 'must be canonical when canonicalization_status is canonical' });
    }
    if (attempt.canonicalization_status === 'not-applicable' && attempt.canonicalization_reason !== 'operation-not-eligible') {
      errors.push({ field: `${label}.canonicalization_reason`, message: 'must be operation-not-eligible when canonicalization_status is not-applicable' });
    }
    if (attempt.canonicalization_status === 'uncanonicalizable' && attempt.canonicalization_reason === 'canonical') {
      errors.push({ field: `${label}.canonicalization_reason`, message: 'cannot be canonical when canonicalization_status is uncanonicalizable' });
    }
    if (attempt.recognized_operation === 'coverage') {
      for (const f of ['tests_contract', 'coverage_contract', 'error_contract', 'exit_code_contract']) {
        if (attempt[f] !== 'not-applicable') errors.push({ field: `${label}.${f}`, message: 'must be not-applicable for coverage-only attempts' });
      }
      if (attempt.threshold_relation !== 'not-applicable') errors.push({ field: `${label}.threshold_relation`, message: 'must be not-applicable for coverage-only attempts' });
      if (attempt.target_matches_expected !== null) errors.push({ field: `${label}.target_matches_expected`, message: 'must be null for coverage-only attempts' });
      if (attempt.outcome_matches_expected !== null) errors.push({ field: `${label}.outcome_matches_expected`, message: 'must be null for coverage-only attempts' });
    }
    if (attempt.terminal_authoritative) terminalCount += 1;
  });
  if (terminalCount > 1) {
    errors.push({ field, message: 'must contain at most one terminal_authoritative attempt' });
  }
  if (terminalAuthoritativeEvent == null && terminalCount !== 0) {
    errors.push({ field, message: 'must contain zero terminal_authoritative attempts when terminal_authoritative_event is null' });
  }
}

function validateTerminalEvidence(terminalEvidence, field, errors, schema) {
  if (terminalEvidence == null || typeof terminalEvidence !== 'object' || Array.isArray(terminalEvidence)) {
    errors.push({ field, message: 'must be an object' });
    return;
  }
  const terminalEvidenceFields = terminalEvidenceFieldsForSidecarSchema(schema);
  rejectUnrecognizedKeys(terminalEvidence, terminalEvidenceFields, field, errors);
  for (const f of terminalEvidenceFields) {
    if (!(f in terminalEvidence)) errors.push({ field: `${field}.${f}`, message: 'missing required field' });
  }
  if (typeof terminalEvidence.present !== 'boolean') errors.push({ field: `${field}.present`, message: 'must be a boolean' });
  if (terminalEvidence.present) {
    if (!TERMINAL_EVIDENCE_PROVIDER_VALUES.includes(terminalEvidence.provider)) {
      errors.push({ field: `${field}.provider`, message: `must be one of ${TERMINAL_EVIDENCE_PROVIDER_VALUES.join('|')} when present is true` });
    }
    if (!(Number.isInteger(terminalEvidence.tool_result_event_index) && terminalEvidence.tool_result_event_index >= 0)) {
      errors.push({ field: `${field}.tool_result_event_index`, message: 'must be a non-negative integer when present is true' });
    }
    for (const f of ['evidence_well_formed', 'target_matches_expected', 'outcome_matches_expected', 'malformed', 'parallel_evidence_invalid', 'changed_evidence_invalid']) {
      if (typeof terminalEvidence[f] !== 'boolean') errors.push({ field: `${field}.${f}`, message: 'must be a boolean when present is true' });
    }
  } else {
    if (terminalEvidence.provider !== null) errors.push({ field: `${field}.provider`, message: 'must be null when present is false' });
    if (terminalEvidence.tool_result_event_index !== null) errors.push({ field: `${field}.tool_result_event_index`, message: 'must be null when present is false' });
    if (terminalEvidence.evidence_well_formed !== false) errors.push({ field: `${field}.evidence_well_formed`, message: 'must be exactly false when present is false' });
    for (const f of ['target_matches_expected', 'outcome_matches_expected', 'malformed', 'parallel_evidence_invalid', 'changed_evidence_invalid']) {
      if (terminalEvidence[f] !== null) errors.push({ field: `${field}.${f}`, message: 'must be null when present is false' });
    }
  }

  const observed = terminalEvidence.observed_result;
  if (!terminalEvidence.present && observed !== null) {
    errors.push({ field: `${field}.observed_result`, message: 'must be null when present is false' });
  }
  if (observed != null) {
    if (typeof observed !== 'object' || Array.isArray(observed)) {
      errors.push({ field: `${field}.observed_result`, message: 'must be null or an object' });
    } else {
      rejectUnrecognizedKeys(observed, TERMINAL_OBSERVED_RESULT_FIELDS, `${field}.observed_result`, errors);
      for (const f of TERMINAL_OBSERVED_RESULT_FIELDS) {
        if (!(f in observed)) errors.push({ field: `${field}.observed_result.${f}`, message: 'missing required field' });
      }
      if (!TERMINAL_OUTCOME_KIND_VALUES.includes(observed.outcome_kind)) {
        errors.push({ field: `${field}.observed_result.outcome_kind`, message: `must be one of ${TERMINAL_OUTCOME_KIND_VALUES.join('|')}` });
      }
      if (typeof observed.module_matches_expected !== 'boolean') {
        errors.push({ field: `${field}.observed_result.module_matches_expected`, message: 'must be a boolean' });
      }
      for (const f of ['total', 'passed', 'failed', 'missed_lines', 'threshold', 'modules_contributing']) {
        validateNullableNonNegativeInteger(observed[f], `${field}.observed_result.${f}`, errors);
      }
    }
  }

  validateFinalAnswerBlock(terminalEvidence.final_answer_block, `${field}.final_answer_block`, errors, schema);
  if ((schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V7 || schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V8)
    && !TERMINAL_COVERAGE_GATE_DIAGNOSTIC_VALUES.includes(terminalEvidence.coverage_gate_diagnostic)) {
    errors.push({ field: `${field}.coverage_gate_diagnostic`, message: `must be one of ${TERMINAL_COVERAGE_GATE_DIAGNOSTIC_VALUES.join('|')}` });
  }
}

/**
 * Self-contained structural validator -- every check derivable from the sidecar object alone,
 * without needing the run record or the original transcript. Closed key sets at every nesting
 * level; every enum domain; ordinals exactly 0..N-1; tool_use_event_index non-decreasing across
 * ordinals (transcript order is stable); result index null iff result status is missing; a
 * non-null result index strictly after its own tool-use index; every Bash-family entry has a real
 * decision category (never not-applicable); every Skill/unexpected-tool entry has EXACTLY
 * not-applicable; summary counts equal the actual tool_calls[] entries; and, when non-null,
 * terminal_authoritative_event correlates to a real tool_calls[] entry's own result index (the
 * only terminal-event coherence check achievable without a second, independent record field to
 * compare against -- see crossValidateAcceptedRunAuditAgainstRecord for the record-comparison half).
 * @returns {{errors: Array<{field:string,message:string}>, warnings: Array}}
 */
export function validateAcceptedRunAuditSidecar(sidecar) {
  const errors = [];
  const warnings = [];
  if (sidecar == null || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
    errors.push({ field: '(root)', message: 'sidecar is not an object' });
    return { errors, warnings };
  }

  // Version dispatch, not a single pinned constant: the 92 v1 + 64 v2 historical sidecars are
  // genuinely v1/v2 and must keep validating under their own frozen rules. An unrecognized version
  // fails closed here and the per-version field lists below resolve to null/a v1/v2 default, so
  // nothing borrows another version's shape. `schema` is read before the top-level key-set check
  // (never validated yet at that point) specifically so that check can itself be schema-aware --
  // v3's own extra `run_provenance_sha256` key is unrecognized for v1/v2, required for v3.
  const schema = sidecar.schema;
  const isKnownSchema = SUPPORTED_ACCEPTED_AUDIT_SIDECAR_SCHEMAS.includes(schema);
  if (!isKnownSchema) errors.push({ field: 'schema', message: `must be one of ${SUPPORTED_ACCEPTED_AUDIT_SIDECAR_SCHEMAS.join('|')}` });
  const topFields = topFieldsFor(schema);
  rejectUnrecognizedKeys(sidecar, topFields, '(root)', errors);
  for (const f of topFields) {
    if (!(f in sidecar)) errors.push({ field: f, message: 'missing required field' });
  }

  const toolCallFields = toolCallFieldsFor(schema) ?? TOOL_CALL_FIELDS_V1;
  const summaryFields = summaryFieldsFor(schema) ?? SUMMARY_FIELDS_V1;
  // v2+ carry dispatch_status. v4/v5 are legacy no-policy sidecars; v6 keeps that contract and
  // adds terminal evidence; v7 keeps v6 and adds the closed coverage-gate diagnostic leaf; v8
  // keeps v7 and adds per-attempt coverage/final-answer mismatch observability.
  const hasDispatchStatusShape = schema === 2 || schema === 3 || schema === 4 || schema === 5 || schema === 6 || schema === 7 || schema === 8;
  const hasProvenanceHash = schema === 3 || schema === 4 || schema === 5 || schema === 6 || schema === 7 || schema === 8;
  const isV4 = schema === 4;
  const isV5OrLaterNoPolicy = schema === 5 || schema === 6 || schema === 7 || schema === 8;
  const hasTerminalEvidence = schema === 6 || schema === 7 || schema === 8;
  const isNoPolicySidecar = isV4 || isV5OrLaterNoPolicy;
  if (typeof sidecar.run_id !== 'string' || sidecar.run_id.length === 0) errors.push({ field: 'run_id', message: 'must be a non-empty string' });
  const runSchemaRequirement = runSchemaRequirementFor(schema);
  if (runSchemaRequirement?.exact != null && sidecar.run_schema !== runSchemaRequirement.exact) {
    errors.push({ field: 'run_schema', message: `must be exactly ${runSchemaRequirement.exact} for sidecar schema ${schema}` });
  }
  if (runSchemaRequirement?.min != null && !(Number.isInteger(sidecar.run_schema) && sidecar.run_schema >= runSchemaRequirement.min)) {
    errors.push({ field: 'run_schema', message: `must be an integer >= ${runSchemaRequirement.min} for sidecar schema ${schema}` });
  }
  if (hasProvenanceHash) {
    if (!/^[0-9a-f]{64}$/.test(sidecar.run_provenance_sha256)) {
      errors.push({ field: 'run_provenance_sha256', message: 'must be a lowercase 64-char hex SHA-256 string' });
    }
  }
  // No-policy top-level fields (Decision H). policy_mode is a closed LITERAL here (not merely one of
  // the 2 registry-level enum values) -- v4/v5 exist exclusively for "not_applicable"; a no-policy
  // sidecar claiming "required" would be a self-contradiction (schema6+policy_mode:required always
  // selects v3 -- see expectedAcceptedAuditSchemaFor).
  if (isNoPolicySidecar) {
    if (typeof sidecar.execution_profile_id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(sidecar.execution_profile_id)) {
      errors.push({ field: 'execution_profile_id', message: 'must be a lowercase-slug execution profile id' });
    }
    if (sidecar.policy_mode !== 'not_applicable') {
      errors.push({ field: 'policy_mode', message: `must be exactly "not_applicable" for sidecar schema ${schema}` });
    }
    if (!/^[0-9a-f]{64}$/.test(sidecar.isolation_attestation_sha256)) {
      errors.push({ field: 'isolation_attestation_sha256', message: `must be a lowercase 64-char hex SHA-256 string -- never null for a schema-${schema} sidecar` });
    }
  }
  if (sidecar.run_kind !== 'scenario') errors.push({ field: 'run_kind', message: 'must be exactly "scenario" -- a sidecar only ever exists for a scenario record' });
  if (typeof sidecar.condition !== 'string' || sidecar.condition.length === 0) errors.push({ field: 'condition', message: 'must be a non-empty string' });
  if (typeof sidecar.scenario_id !== 'string' || sidecar.scenario_id.length === 0) errors.push({ field: 'scenario_id', message: 'must be a non-empty string' });
  validateEventRefField(sidecar.first_useful_signal_event, 'first_useful_signal_event', errors);
  validateEventRefField(sidecar.terminal_authoritative_event, 'terminal_authoritative_event', errors);

  const toolCalls = Array.isArray(sidecar.tool_calls) ? sidecar.tool_calls : null;
  if (toolCalls == null) {
    errors.push({ field: 'tool_calls', message: 'must be an array' });
  } else {
    let lastToolUseEventIndex = -Infinity;
    toolCalls.forEach((tc, i) => {
      const label = `tool_calls[${i}]`;
      if (tc == null || typeof tc !== 'object' || Array.isArray(tc)) {
        errors.push({ field: label, message: 'must be an object' });
        return;
      }
      rejectUnrecognizedKeys(tc, toolCallFields, label, errors);
      for (const f of toolCallFields) if (!(f in tc)) errors.push({ field: `${label}.${f}`, message: 'missing required field' });

      if (tc.ordinal !== i) errors.push({ field: `${label}.ordinal`, message: `ordinals must be exactly 0..N-1 in order, expected ${i} got ${tc.ordinal}` });
      if (!Number.isInteger(tc.tool_use_event_index) || tc.tool_use_event_index < 0) errors.push({ field: `${label}.tool_use_event_index`, message: 'must be a non-negative integer' });
      else if (tc.tool_use_event_index < lastToolUseEventIndex) errors.push({ field: `${label}.tool_use_event_index`, message: 'transcript order is not stable -- must be non-decreasing across ordinals' });
      else lastToolUseEventIndex = tc.tool_use_event_index;

      if (!TOOL_KIND_VALUES.includes(tc.tool_kind)) errors.push({ field: `${label}.tool_kind`, message: `must be one of ${TOOL_KIND_VALUES.join('|')}` });
      if (!POLICY_DECISION_VALUES.includes(tc.policy_decision)) errors.push({ field: `${label}.policy_decision`, message: `must be one of ${POLICY_DECISION_VALUES.join('|')}` });
      if (!RESULT_STATUS_VALUES.includes(tc.result_status)) errors.push({ field: `${label}.result_status`, message: `must be one of ${RESULT_STATUS_VALUES.join('|')}` });
      if (!PHASE_VALUES.includes(tc.phase)) errors.push({ field: `${label}.phase`, message: `must be one of ${PHASE_VALUES.join('|')}` });

      const isBash = BASH_FAMILY_TOOL_KINDS.has(tc.tool_kind);

      // v2 dispatch_status <-> policy_decision biconditionals. STRUCTURAL ONLY, by necessity: the
      // sidecar carries no command, no tool_result content and no tool_use_result, so this
      // validator cannot -- and must not pretend to -- prove that the strict pre-dispatch matcher
      // actually matched. That proof exists only at construction time, where the transcript is in
      // hand (see buildAcceptedRunAuditSidecar, which derives pre_dispatch_blocked exclusively from
      // buildBashDispatchAccounting's own id set). What IS checkable at rest is that the two closed
      // vocabularies agree, which is what this enforces.
      if (hasDispatchStatusShape) {
        if (!DISPATCH_STATUS_VALUES.includes(tc.dispatch_status)) {
          errors.push({ field: `${label}.dispatch_status`, message: `must be one of ${DISPATCH_STATUS_VALUES.join('|')}` });
        } else if (isBash) {
          if (tc.dispatch_status === 'not_applicable') {
            errors.push({ field: `${label}.dispatch_status`, message: 'not_applicable is only for non-Bash tools -- a Bash entry is hook_evaluated, pre_dispatch_blocked, result_correlated_no_policy, or unaccounted' });
          }
          // PR 4: result_correlated_no_policy is exclusive to no-policy sidecars
          // (policyMode:"not_applicable") -- never reachable for v1/v2/v3, whose only Bash
          // dispatch statuses remain exactly
          // hook_evaluated/pre_dispatch_blocked/unaccounted (frozen, unchanged).
          if (tc.dispatch_status === 'result_correlated_no_policy' && !isNoPolicySidecar) {
            errors.push({ field: `${label}.dispatch_status`, message: 'result_correlated_no_policy is only valid on a no-policy sidecar' });
          }
          // hook_evaluated (a real policy-hook decision) can never appear on a no-policy sidecar -- no
          // PreToolUse:Bash hook is ever wired for policyMode:"not_applicable".
          if (tc.dispatch_status === 'hook_evaluated' && isNoPolicySidecar) {
            errors.push({ field: `${label}.dispatch_status`, message: `hook_evaluated can never appear on a schema-${schema} (not_applicable) sidecar` });
          }
          const decisionIsAllowDeny = tc.policy_decision === 'allow' || tc.policy_decision === 'deny';
          if (tc.dispatch_status === 'hook_evaluated' && !decisionIsAllowDeny) {
            errors.push({ field: `${label}.dispatch_status`, message: 'hook_evaluated requires policy_decision allow or deny' });
          }
          if (decisionIsAllowDeny && tc.dispatch_status !== 'hook_evaluated') {
            errors.push({ field: `${label}.dispatch_status`, message: 'a policy_decision of allow/deny requires dispatch_status hook_evaluated' });
          }
          if (tc.dispatch_status === 'pre_dispatch_blocked') {
            if (tc.policy_decision !== 'not-applicable') errors.push({ field: `${label}.policy_decision`, message: 'must be not-applicable when dispatch_status is pre_dispatch_blocked -- no policy decision was ever due' });
            if (tc.result_status !== 'error') errors.push({ field: `${label}.result_status`, message: 'must be error when dispatch_status is pre_dispatch_blocked' });
          }
          if (tc.dispatch_status === 'result_correlated_no_policy') {
            if (tc.policy_decision !== 'not-applicable') errors.push({ field: `${label}.policy_decision`, message: 'must be not-applicable when dispatch_status is result_correlated_no_policy -- no policy hook ever evaluated it' });
            if (tc.result_status === 'missing') errors.push({ field: `${label}.result_status`, message: 'must not be missing when dispatch_status is result_correlated_no_policy -- this status means a correlated result WAS found' });
          }
          // unaccounted's own required policy_decision is schema-aware: v1/v2/v3 (policyMode:
          // "required") pair it with "missing" (a real decision was due and never arrived); v4
          // (policyMode:"not_applicable") pairs it with "not-applicable" (no decision was ever due
          // in the first place) -- see classifyToolCall's own identical branch.
          if (tc.dispatch_status === 'unaccounted') {
            const expectedMissingDecision = isNoPolicySidecar ? 'not-applicable' : 'missing';
            if (tc.policy_decision !== expectedMissingDecision) {
              errors.push({ field: `${label}.policy_decision`, message: `must be ${expectedMissingDecision} when dispatch_status is unaccounted on a schema-${schema} sidecar` });
            }
          }
        } else if (tc.dispatch_status !== 'not_applicable') {
          errors.push({ field: `${label}.dispatch_status`, message: 'must be not_applicable for a Skill/unexpected-tool tool_kind' });
        }
      }

      if (isBash) {
        if (typeof tc.plan_only !== 'boolean') errors.push({ field: `${label}.plan_only`, message: 'must be a boolean for a Bash-family tool_kind' });
        // v1: a Bash entry always had a real decision category. v2 adds exactly one narrow
        // exception -- a recognized pre-dispatch block, where no decision was ever due -- and that
        // exception is admissible ONLY together with dispatch_status pre_dispatch_blocked, checked
        // above. A normal Bash call still can never be not-applicable UNDER POLICY-REQUIRED (v1/v2/
        // v3). PR 4: on a no-policy sidecar, EVERY Bash entry legitimately carries policy_decision:
        // not-applicable regardless of dispatch_status (result_correlated_no_policy/
        // pre_dispatch_blocked/unaccounted alike) -- no policy hook ever existed to produce a real
        // allow/deny/missing category under that profile.
        const notApplicableExempt = isNoPolicySidecar || (hasDispatchStatusShape && tc.dispatch_status === 'pre_dispatch_blocked');
        if (tc.policy_decision === 'not-applicable' && !notApplicableExempt) errors.push({ field: `${label}.policy_decision`, message: 'a Bash-family entry must have a real decision category (allow/deny/missing), never not-applicable' });
        // Per-tool_kind operation domain (review finding 1b/1c/1d) -- previously unchecked for
        // EVERY Bash-family entry, so an arbitrary or contradictory operation string (or even a
        // non-string value) silently passed. kmp-test's FULL domain (its own value must be "other"
        // or a member of the record's policy_allowed_kmptest_subcommands) can only be checked
        // during cross-validation, which has the record on hand -- this is the basic shape half.
        if (tc.tool_kind === 'other-bash') {
          if (tc.operation !== null) errors.push({ field: `${label}.operation`, message: 'must be null for tool_kind other-bash' });
        } else if (tc.tool_kind === 'gradle') {
          if (tc.operation !== 'allowed-task' && tc.operation !== 'other') {
            errors.push({ field: `${label}.operation`, message: 'must be exactly "allowed-task" or "other" for tool_kind gradle' });
          }
        } else if (tc.tool_kind === 'kmp-test') {
          if (typeof tc.operation !== 'string' || tc.operation.length === 0) {
            errors.push({ field: `${label}.operation`, message: 'must be a non-empty string for tool_kind kmp-test (membership against the record\'s own allowlist is checked during cross-validation)' });
          }
        }
        if (isV5OrLaterNoPolicy) {
          if (tc.tool_kind === 'kmp-test') {
            if (!KMP_TEST_RECOGNIZED_OPERATION_VALUES.includes(tc.recognized_operation)) {
              errors.push({ field: `${label}.recognized_operation`, message: `must be one of ${KMP_TEST_RECOGNIZED_OPERATION_VALUES.join('|')} for tool_kind kmp-test on a schema-${schema} sidecar` });
            }
          } else if (tc.recognized_operation !== null) {
            errors.push({ field: `${label}.recognized_operation`, message: `must be null except for tool_kind kmp-test on a schema-${schema} sidecar` });
          }
        }
      } else {
        if (tc.plan_only !== null) errors.push({ field: `${label}.plan_only`, message: 'must be null for a Skill/unexpected-tool tool_kind' });
        if (tc.operation !== null) errors.push({ field: `${label}.operation`, message: 'must be null for a Skill/unexpected-tool tool_kind' });
        if (isV5OrLaterNoPolicy && tc.recognized_operation !== null) errors.push({ field: `${label}.recognized_operation`, message: `must be null except for tool_kind kmp-test on a schema-${schema} sidecar` });
        if (tc.policy_decision !== 'not-applicable') errors.push({ field: `${label}.policy_decision`, message: 'must be exactly not-applicable for a Skill/unexpected-tool tool_kind' });
      }

      const resultIndex = tc.tool_result_event_index;
      if (tc.result_status === 'missing') {
        if (resultIndex !== null) errors.push({ field: `${label}.tool_result_event_index`, message: 'must be null when result_status is missing' });
      } else {
        if (resultIndex === null) {
          errors.push({ field: `${label}.tool_result_event_index`, message: 'must be non-null when result_status is not missing' });
        } else if (!Number.isInteger(resultIndex) || resultIndex <= tc.tool_use_event_index) {
          errors.push({ field: `${label}.tool_result_event_index`, message: 'a non-null result index must be a later event than its own tool-use index' });
        }
      }
    });
  }

  const summary = sidecar.summary;
  if (summary == null || typeof summary !== 'object' || Array.isArray(summary)) {
    errors.push({ field: 'summary', message: 'must be an object' });
  } else {
    rejectUnrecognizedKeys(summary, summaryFields, 'summary', errors);
    for (const f of summaryFields) if (!(f in summary)) errors.push({ field: `summary.${f}`, message: 'missing required field' });
    if (toolCalls != null) {
      const isBash = (tc) => BASH_FAMILY_TOOL_KINDS.has(tc?.tool_kind);
      if (summary.tool_calls_total !== toolCalls.length) errors.push({ field: 'summary.tool_calls_total', message: 'must equal the actual number of tool_calls[] entries' });
      const bashEntries = toolCalls.filter(isBash);
      if (summary.shell_commands_total !== bashEntries.length) errors.push({ field: 'summary.shell_commands_total', message: 'must equal the number of Bash-family tool_calls[] entries' });
      // PR 4: policy_denials_total/policy_decisions_missing are only meaningful (real counts) when
      // policy applies -- a no-policy sidecar carries both as null instead (checked separately, below),
      // never a trivially-zero real count (no Bash entry can ever have policy_decision:deny/missing
      // under not_applicable, so a real 0 here would misleadingly claim these were genuinely
      // evaluated and found clean).
      if (!isNoPolicySidecar) {
        const deniedCount = bashEntries.filter((tc) => tc.policy_decision === 'deny').length;
        if (summary.policy_denials_total !== deniedCount) errors.push({ field: 'summary.policy_denials_total', message: 'must equal the number of Bash-family entries with policy_decision:deny' });
        const missingCount = bashEntries.filter((tc) => tc.policy_decision === 'missing').length;
        if (summary.policy_decisions_missing !== missingCount) errors.push({ field: 'summary.policy_decisions_missing', message: 'must equal the number of Bash-family entries with policy_decision:missing' });
      }
      if (hasDispatchStatusShape) {
        // Exact cardinality against tool_calls[], the same discipline every other summary counter
        // gets -- a standalone total nobody cross-checks is a number that can quietly go wrong.
        const preDispatchCount = bashEntries.filter((tc) => tc.dispatch_status === 'pre_dispatch_blocked').length;
        if (summary.pre_dispatch_blocked_total !== preDispatchCount) {
          errors.push({ field: 'summary.pre_dispatch_blocked_total', message: 'must equal the number of Bash-family entries with dispatch_status:pre_dispatch_blocked' });
        }
      }
      if (isNoPolicySidecar) {
        // dispatch_unaccounted_total (Decision H): exact cardinality of genuinely unaccounted
        // Bash-family entries -- the REAL acceptance-gate counter under not_applicable, where
        // policy_decisions_missing can no longer serve that role (it is unconditionally null).
        const unaccountedCount = bashEntries.filter((tc) => tc.dispatch_status === 'unaccounted').length;
        if (summary.dispatch_unaccounted_total !== unaccountedCount) {
          errors.push({ field: 'summary.dispatch_unaccounted_total', message: 'must equal the number of Bash-family entries with dispatch_status:unaccounted' });
        }
      }
    }
    if (isNoPolicySidecar) {
      for (const f of ['policy_denials_total', 'policy_decisions_missing', 'policy_denials_before_first_signal', 'policy_denials_after_first_signal']) {
        if (summary[f] !== null) {
          errors.push({ field: `summary.${f}`, message: `must be exactly null on a schema-${schema} sidecar -- no policy hook ever evaluated this run` });
        }
      }
      if (!(Number.isInteger(summary.dispatch_unaccounted_total) && summary.dispatch_unaccounted_total >= 0)) {
        errors.push({ field: 'summary.dispatch_unaccounted_total', message: `must be a non-negative integer -- never null, this is the real acceptance-gate counter for a schema-${schema} sidecar` });
      }
    }
    const hasBoundary = sidecar.first_useful_signal_event != null;
    for (const f of ['post_signal_ms', 'post_signal_tool_calls', 'policy_denials_before_first_signal', 'policy_denials_after_first_signal']) {
      if (!hasBoundary && summary[f] !== null) {
        errors.push({ field: `summary.${f}`, message: 'must be null when there is no first-useful-signal boundary' });
      }
    }
    if (summary.post_signal_ms != null && !(typeof summary.post_signal_ms === 'number' && Number.isFinite(summary.post_signal_ms) && summary.post_signal_ms >= 0)) {
      errors.push({ field: 'summary.post_signal_ms', message: 'must be null or a non-negative finite number' });
    }
    for (const f of ['post_signal_tool_calls', 'policy_denials_before_first_signal', 'policy_denials_after_first_signal', 'policy_denials_total', 'policy_decisions_missing', 'tool_calls_total', 'shell_commands_total', ...(hasDispatchStatusShape ? ['pre_dispatch_blocked_total'] : [])]) {
      const v = summary[f];
      if (v != null && !(Number.isInteger(v) && v >= 0)) {
        errors.push({ field: `summary.${f}`, message: 'must be null (only for the 3 boundary-dependent fields) or a non-negative integer' });
      }
    }
  }

  // terminal_authoritative_event coherence -- the only check achievable WITHOUT the run record
  // (which has no independent field to compare it to): when non-null, it must correlate to some
  // real tool_calls[] entry's own (non-null) result index.
  if (sidecar.terminal_authoritative_event != null && toolCalls != null) {
    const matches = toolCalls.some((tc) => tc.tool_result_event_index === sidecar.terminal_authoritative_event.index);
    if (!matches) {
      errors.push({ field: 'terminal_authoritative_event', message: 'does not correlate to any tool_calls[] entry\'s own result event index' });
    }
  }

  const summaryIsObject = summary != null && typeof summary === 'object' && !Array.isArray(summary);

  // Accepted-sidecar invariant (review finding 1h): a sidecar only ever accompanies an ACCEPTED
  // run (see finalizeAndWriteMatrixRecords's gate-then-sidecar ordering) -- an unresolved
  // ("missing") policy decision on it is itself a defect this sidecar must surface, never
  // tolerate. Checked only once the field is already known to be a well-typed non-negative
  // integer, to avoid piling a second, redundant error onto an already-wrong-typed field.
  if (summaryIsObject && Number.isInteger(summary.policy_decisions_missing) && summary.policy_decisions_missing !== 0) {
    errors.push({ field: 'summary.policy_decisions_missing', message: 'must be exactly 0 -- a sidecar only ever accompanies an accepted run, so every Bash-family policy decision must have resolved to allow or deny' });
  }
  // PR 4: the identical acceptance-gate, for a no-policy sidecar's own real counter -- Decision H:
  // "dispatch_unaccounted_total ... debe ser 0 en todo sidecar aceptado, strict o no-policy". A
  // missing result must never be accepted just because policy does not apply.
  if (isNoPolicySidecar && Number.isInteger(summary.dispatch_unaccounted_total) && summary.dispatch_unaccounted_total !== 0) {
    errors.push({ field: 'summary.dispatch_unaccounted_total', message: 'must be exactly 0 -- a sidecar only ever accompanies an accepted run, so every Bash-family attempt must have a correlated result or a recognized pre-dispatch block' });
  }
  if (hasTerminalEvidence) {
    validateTerminalEvidence(sidecar.terminal_evidence, 'terminal_evidence', errors, sidecar.schema);
    if (schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V8 && sidecar.terminal_evidence != null && typeof sidecar.terminal_evidence === 'object' && !Array.isArray(sidecar.terminal_evidence)) {
      validateCoverageGateAttempts(sidecar.terminal_evidence.coverage_gate_attempts, 'terminal_evidence.coverage_gate_attempts', errors, toolCalls, sidecar.terminal_authoritative_event);
    }
  }

  // Phase correctness + post-signal summary recompute (review finding 1e/1f) -- previously only
  // the NULL-when-no-boundary direction was checked; neither each entry's own claimed `phase` nor
  // the ACTUAL numeric value of the 3 boundary-dependent summary counts was ever cross-checked
  // against the tool_calls[] entries that are supposed to justify them -- an arbitrary/incoherent
  // phase or count silently passed as long as it was one of the 4 enum values / a non-negative
  // integer.
  if (toolCalls != null && summaryIsObject) {
    const firstSignalIndex = sidecar.first_useful_signal_event != null && typeof sidecar.first_useful_signal_event === 'object' ? sidecar.first_useful_signal_event.index : null;
    if (firstSignalIndex == null) {
      toolCalls.forEach((tc, i) => {
        if (tc != null && typeof tc === 'object' && tc.phase !== 'no-signal') {
          errors.push({ field: `tool_calls[${i}].phase`, message: 'must be exactly no-signal when there is no first_useful_signal_event boundary' });
        }
      });
    } else {
      const correlates = toolCalls.some((tc) => tc?.tool_result_event_index === firstSignalIndex);
      if (!correlates) {
        errors.push({ field: 'first_useful_signal_event', message: 'does not correlate to any tool_calls[] entry\'s own result event index' });
      }
      const isBashKind = (tc) => BASH_FAMILY_TOOL_KINDS.has(tc?.tool_kind);
      toolCalls.forEach((tc, i) => {
        if (tc == null || typeof tc !== 'object' || !Number.isInteger(tc.tool_use_event_index)) return;
        const expectedPhase = tc.tool_result_event_index === firstSignalIndex ? 'produced-signal'
          : tc.tool_use_event_index > firstSignalIndex ? 'post-signal' : 'pre-signal';
        if (tc.phase !== expectedPhase) {
          errors.push({ field: `tool_calls[${i}].phase`, message: `must be exactly ${expectedPhase} given tool_use_event_index=${tc.tool_use_event_index}, tool_result_event_index=${tc.tool_result_event_index}, boundary=${firstSignalIndex}` });
        }
      });
      const expectedPostSignalToolCalls = toolCalls.filter((tc) => Number.isInteger(tc?.tool_use_event_index) && tc.tool_use_event_index > firstSignalIndex).length;
      if (summary.post_signal_tool_calls !== expectedPostSignalToolCalls) {
        errors.push({ field: 'summary.post_signal_tool_calls', message: `must equal the number of tool_calls[] entries with tool_use_event_index > ${firstSignalIndex} (expected ${expectedPostSignalToolCalls}, got ${JSON.stringify(summary.post_signal_tool_calls)})` });
      }
      // PR 4: skipped for a no-policy sidecar -- policy_denials_before/after_first_signal are
      // unconditionally null there (checked separately, above), so there is nothing to recompute
      // against; no Bash entry can ever have policy_decision:deny under not_applicable.
      if (!isNoPolicySidecar) {
        const bashEntries = toolCalls.filter(isBashKind);
        const expectedBefore = bashEntries.filter((tc) => tc.policy_decision === 'deny' && Number.isInteger(tc.tool_use_event_index) && tc.tool_use_event_index <= firstSignalIndex).length;
        if (summary.policy_denials_before_first_signal !== expectedBefore) {
          errors.push({ field: 'summary.policy_denials_before_first_signal', message: `must equal the number of denied Bash-family entries at or before the boundary (expected ${expectedBefore}, got ${JSON.stringify(summary.policy_denials_before_first_signal)})` });
        }
        const expectedAfter = bashEntries.filter((tc) => tc.policy_decision === 'deny' && Number.isInteger(tc.tool_use_event_index) && tc.tool_use_event_index > firstSignalIndex).length;
        if (summary.policy_denials_after_first_signal !== expectedAfter) {
          errors.push({ field: 'summary.policy_denials_after_first_signal', message: `must equal the number of denied Bash-family entries after the boundary (expected ${expectedAfter}, got ${JSON.stringify(summary.policy_denials_after_first_signal)})` });
        }
      }
    }
  }

  return { errors, warnings };
}

/**
 * The record-comparison half of cross-validation -- identity fields and metric totals the sidecar
 * independently re-derived must agree with the run record it was built from (and, for
 * first_useful_signal_event, must be the identical event ref -- the ONE field both the sidecar and
 * the record carry independently). Returns a flat array of {field,message} errors (empty if
 * everything agrees).
 */
export function crossValidateAcceptedRunAuditAgainstRecord(sidecar, record) {
  const errors = [];
  // Defensive guard (review finding 5): a caller may invoke this directly without first running
  // validateAcceptedRunAuditSidecar's own shape check -- a null sidecar previously reached a bare
  // `sidecar.run_id` dereference below and threw a TypeError instead of returning a structured
  // error. Scalars/arrays never threw here (property access on them just yields `undefined`,
  // which then legitimately mismatches every real record field), but are still rejected up front
  // for the same reason: none of them is a real sidecar object.
  if (sidecar == null || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
    errors.push({ field: '(root)', message: 'sidecar is not an object' });
    return errors;
  }
  if (sidecar.run_id !== record.run_id) errors.push({ field: 'run_id', message: `sidecar run_id (${sidecar.run_id}) does not match record run_id (${record.run_id})` });
  // The sidecar's OWN version must match the version the record points at. Note this is a genuinely
  // different field from run_schema below (that one is the RUN record's schema, which the sidecar
  // also carries). While only one sidecar version existed the equality was implicit; with v1 and v2
  // coexisting it has to be asserted, or a record could point at v1 while the file on disk is v2
  // (or the reverse) and every other cross-check would still pass.
  if (sidecar.schema !== record.accepted_audit?.schema) {
    errors.push({ field: 'schema', message: `sidecar schema (${sidecar.schema}) does not match record accepted_audit.schema (${record.accepted_audit?.schema})` });
  }
  if (sidecar.run_schema !== record.schema) errors.push({ field: 'run_schema', message: `sidecar run_schema (${sidecar.run_schema}) does not match record schema (${record.schema})` });
  if (sidecar.run_kind !== record.run_kind) errors.push({ field: 'run_kind', message: `sidecar run_kind (${sidecar.run_kind}) does not match record run_kind (${record.run_kind})` });
  if (sidecar.condition !== record.condition) errors.push({ field: 'condition', message: `sidecar condition (${sidecar.condition}) does not match record condition (${record.condition})` });
  if (sidecar.scenario_id !== record.scenario_id) errors.push({ field: 'scenario_id', message: `sidecar scenario_id (${sidecar.scenario_id}) does not match record scenario_id (${record.scenario_id})` });
  if (JSON.stringify(sidecar.first_useful_signal_event ?? null) !== JSON.stringify(record.first_useful_signal_event ?? null)) {
    errors.push({ field: 'first_useful_signal_event', message: 'sidecar first_useful_signal_event does not match the record\'s own field' });
  }

  const recordMetric = (name) => record[name]?.value ?? null;
  for (const field of ['tool_calls_total', 'shell_commands_total', 'post_signal_ms', 'post_signal_tool_calls', 'policy_denials_before_first_signal', 'policy_denials_after_first_signal']) {
    if ((sidecar.summary?.[field] ?? null) !== recordMetric(field)) {
      errors.push({ field: `summary.${field}`, message: `sidecar summary.${field} does not match record.${field}.value` });
    }
  }

  // hook_deny_count (review finding 1g) -- a PLAIN integer field on the record (never a
  // {value,reason} metric, unlike every field in the loop above), so it was never part of that
  // comparison and had no cross-check against the sidecar's own independently re-derived
  // policy_denials_total at all.
  if ((sidecar.summary?.policy_denials_total ?? null) !== (record.hook_deny_count ?? null)) {
    errors.push({ field: 'summary.policy_denials_total', message: `sidecar summary.policy_denials_total (${sidecar.summary?.policy_denials_total}) does not match record hook_deny_count (${record.hook_deny_count})` });
  }

  // run_provenance_sha256 (v3/v4/v5/v6/v7, Decision H: provenance SHA is recomputed for every schema:6
  // sidecar)
  // -- recomputed from the RE-READ record and required to match exactly, so neither sidecar version
  // can ever be self-consistent while pointing at a different record's provenance (the same
  // identity-binding role sha256/blob hashes play elsewhere in this repo). Deliberately never
  // `sidecar.schema === LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA` -- LATEST can advance, and that comparison
  // would stop checking v3 sidecars entirely. Only checked for schema 3/4/5: a v1/v2 sidecar carries
  // no such field at all.
  if (sidecar.schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V3
    || sidecar.schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V4
    || sidecar.schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V5
    || sidecar.schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V6
    || sidecar.schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V7
    || sidecar.schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V8) {
    const expected = computeRunProvenanceSha256(record);
    if (sidecar.run_provenance_sha256 !== expected) {
      errors.push({ field: 'run_provenance_sha256', message: `sidecar run_provenance_sha256 (${sidecar.run_provenance_sha256}) does not match recomputed value from record (${expected})` });
    }
  }

  // no-policy only: execution_profile_id/policy_mode/isolation_attestation_sha256 cross-validate against
  // the record's OWN execution_profile group (Decision H) -- a v4/v5/v6/v7 sidecar can never be
  // self-consistent while claiming a DIFFERENT profile identity/attestation than the record it was
  // built from actually carries.
  if (sidecar.schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V4
    || sidecar.schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V5
    || sidecar.schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V6
    || sidecar.schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V7
    || sidecar.schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V8) {
    const ep = record.execution_profile ?? {};
    if (sidecar.execution_profile_id !== ep.id) {
      errors.push({ field: 'execution_profile_id', message: `sidecar execution_profile_id (${sidecar.execution_profile_id}) does not match record execution_profile.id (${ep.id})` });
    }
    if (sidecar.policy_mode !== ep.policy_mode) {
      errors.push({ field: 'policy_mode', message: `sidecar policy_mode (${sidecar.policy_mode}) does not match record execution_profile.policy_mode (${ep.policy_mode})` });
    }
    if (sidecar.isolation_attestation_sha256 !== ep.isolation_attestation_sha256) {
      errors.push({ field: 'isolation_attestation_sha256', message: 'sidecar isolation_attestation_sha256 does not match record execution_profile.isolation_attestation_sha256' });
    }
  }

  // kmp-test operation membership against the record's OWN policy_allowed_kmptest_subcommands
  // (review finding 1d) -- can only be checked here, never in the self-contained validator, which
  // has no access to the record at all.
  if (Array.isArray(sidecar.tool_calls)) {
    const allowedKmpTestSubcommands = Array.isArray(record.policy_allowed_kmptest_subcommands) ? record.policy_allowed_kmptest_subcommands : [];
    sidecar.tool_calls.forEach((tc, i) => {
      if (tc?.tool_kind !== 'kmp-test') return;
      if (tc.operation !== 'other' && !allowedKmpTestSubcommands.includes(tc.operation)) {
        errors.push({ field: `tool_calls[${i}].operation`, message: `kmp-test operation "${tc.operation}" is neither "other" nor a member of the record's own policy_allowed_kmptest_subcommands (${JSON.stringify(allowedKmpTestSubcommands)})` });
      }
    });
  }

  return errors;
}

/**
 * Wires build->validate->redact->revalidate->hash (privacy/binding steps 1-5) into the one
 * sequence cli.mjs's matrix finalization needs: validate the freshly-built sidecar, run it through
 * assertCleanOrThrowObject field-by-field, validate the REDACTED object again (redaction could in
 * principle corrupt a field's own type/domain), then SHA-256 the exact final redacted text. Never
 * throws -- returns {ok:false, reason} for any failure, exactly like cli.mjs's own
 * finalizeAndWrite{Records,MatrixRecords} contract, so a caller can report a clean reason and write
 * nothing rather than propagating an uncaught exception.
 * @returns {{ok:true, redactedObj:object, redactedText:string, sha256:string} | {ok:false, reason:string}}
 */
export function finalizeAcceptedRunAuditSidecar(built, { privatePatternsFile } = {}) {
  const { errors: builtErrors } = validateAcceptedRunAuditSidecar(built);
  if (builtErrors.length > 0) {
    return { ok: false, reason: `sidecar failed schema validation before redaction: ${JSON.stringify(builtErrors)}` };
  }
  let redactedObj;
  let redactedText;
  try {
    ({ redactedObj, redactedText } = assertCleanOrThrowObject(built, { privatePatternsFile }));
  } catch (err) {
    return { ok: false, reason: `sidecar privacy check refused: ${err.message}` };
  }
  const { errors: redactedErrors } = validateAcceptedRunAuditSidecar(redactedObj);
  if (redactedErrors.length > 0) {
    return { ok: false, reason: `redacted sidecar failed schema validation (redaction corrupted a field): ${JSON.stringify(redactedErrors)}` };
  }
  const sha256 = createHash('sha256').update(redactedText, 'utf8').digest('hex');
  return { ok: true, redactedObj, redactedText, sha256 };
}

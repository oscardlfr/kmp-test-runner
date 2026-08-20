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
 * conserves v2's `tool_calls`/`summary` shape verbatim, requires literally `run_schema:6`, and adds
 * exactly one new top-level field: `run_provenance_sha256` -- a v6 scenario record accepts only
 * sidecar schema 3. Extending v2 to accept run_schema 6 would silently rewrite its own frozen
 * historical contract, which is exactly why v3 exists as its own version instead.
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
export const LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA = 3;
export const SUPPORTED_ACCEPTED_AUDIT_SIDECAR_SCHEMAS = Object.freeze([1, 2, 3]);

const SIDECAR_TOP_FIELDS_V1V2 = [
  'schema', 'run_id', 'run_schema', 'run_kind', 'condition', 'scenario_id',
  'first_useful_signal_event', 'terminal_authoritative_event', 'tool_calls', 'summary',
];
const SIDECAR_TOP_FIELDS_V3 = [...SIDECAR_TOP_FIELDS_V1V2, 'run_provenance_sha256'];
const TOOL_CALL_FIELDS_V1 = [
  'ordinal', 'tool_use_event_index', 'tool_result_event_index', 'tool_kind', 'operation',
  'plan_only', 'policy_decision', 'result_status', 'phase',
];
const TOOL_CALL_FIELDS_V2 = [...TOOL_CALL_FIELDS_V1, 'dispatch_status'];
const SUMMARY_FIELDS_V1 = [
  'tool_calls_total', 'shell_commands_total', 'post_signal_ms', 'post_signal_tool_calls',
  'policy_denials_total', 'policy_denials_before_first_signal', 'policy_denials_after_first_signal',
  'policy_decisions_missing',
];
const SUMMARY_FIELDS_V2 = [...SUMMARY_FIELDS_V1, 'pre_dispatch_blocked_total'];

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
  if (schema === 3) return SIDECAR_TOP_FIELDS_V3;
  return SIDECAR_TOP_FIELDS_V1V2;
}
function toolCallFieldsFor(schema) {
  if (schema === 1) return TOOL_CALL_FIELDS_V1;
  if (schema === 2 || schema === 3) return TOOL_CALL_FIELDS_V2;
  return null;
}
function summaryFieldsFor(schema) {
  if (schema === 1) return SUMMARY_FIELDS_V1;
  if (schema === 2 || schema === 3) return SUMMARY_FIELDS_V2;
  return null;
}
/** The run record schema a given sidecar schema requires literally (Section E's exact
 * compatibility matrix) -- v1/v2 require exactly 5 (frozen); v3 requires exactly 6. An unknown
 * sidecar schema has no required run_schema of its own (validated separately as an unknown
 * version). */
function requiredRunSchemaFor(sidecarSchema) {
  if (sidecarSchema === 1 || sidecarSchema === 2) return 5;
  if (sidecarSchema === 3) return 6;
  return null;
}

const TOOL_KIND_VALUES = ['target-skill', 'non-target-skill', 'kmp-test', 'gradle', 'other-bash', 'unexpected-tool'];
const BASH_FAMILY_TOOL_KINDS = new Set(['kmp-test', 'gradle', 'other-bash']);
const POLICY_DECISION_VALUES = ['allow', 'deny', 'missing', 'not-applicable'];
const RESULT_STATUS_VALUES = ['success', 'error', 'missing'];
const PHASE_VALUES = ['pre-signal', 'produced-signal', 'post-signal', 'no-signal'];
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
function classifyToolCall(a, { allowedGradleTasks, allowedKmpTestSubcommands, decisionByAttempt, dispatchStatusByAttempt, firstUsefulSignalEventIndex }) {
  let toolKind;
  let operation = null;
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
    if (decision === 'allow') policyDecision = 'allow';
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

  return {
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
 */
export function buildAcceptedRunAuditSidecar({ record, conditionResult, terminalAuthoritativeEventIndex }) {
  const observation = conditionResult.observation;
  const decisionByAttempt = conditionResult.junitAttribution?.decisionByAttempt ?? new Map();
  // The canonical per-attempt classification, consumed as-is and never re-derived. If it is absent
  // every Bash call reads as `unaccounted`, so a sidecar built without it cannot validate -- see
  // classifyToolCall for why that is the intended failure mode rather than a gap.
  const dispatchStatusByAttempt = conditionResult.dispatchAccounting?.dispatchStatusByAttempt ?? new Map();
  const firstUsefulSignalEventIndex = record.first_useful_signal_event?.index ?? null;
  const allToolAttempts = observation.toolAttempts ?? [];

  const toolCalls = allToolAttempts.map((a, ordinal) => ({
    ordinal,
    ...classifyToolCall(a, {
      allowedGradleTasks: record.policy_allowed_gradle_tasks ?? [],
      allowedKmpTestSubcommands: record.policy_allowed_kmptest_subcommands ?? [],
      decisionByAttempt, dispatchStatusByAttempt, firstUsefulSignalEventIndex,
    }),
  }));

  const isBashKind = (tc) => BASH_FAMILY_TOOL_KINDS.has(tc.tool_kind);
  const shellCommandsTotal = toolCalls.filter(isBashKind).length;
  const policyDenialsTotal = toolCalls.filter((tc) => isBashKind(tc) && tc.policy_decision === 'deny').length;
  // Counts ONLY genuinely unaccounted Bash calls. A recognized pre-dispatch block is deliberately
  // excluded: no decision was ever due for it, so counting it here would report a capture failure
  // that did not happen -- and would keep the accepted-sidecar invariant (must be exactly 0) firing
  // on a run whose dispatch is in fact fully accounted for.
  const policyDecisionsMissing = toolCalls.filter((tc) => isBashKind(tc) && tc.dispatch_status === 'unaccounted').length;
  const preDispatchBlockedTotal = toolCalls.filter((tc) => isBashKind(tc) && tc.dispatch_status === 'pre_dispatch_blocked').length;

  const hasBoundary = firstUsefulSignalEventIndex != null;
  const postSignalMs = hasBoundary ? msSinceOrigin(observation.process.endedHrtimeNs, observation.timing.receiptNsByEventIndex.get(firstUsefulSignalEventIndex)) : null;
  const postSignalToolCalls = hasBoundary ? toolCalls.filter((tc) => tc.tool_use_event_index > firstUsefulSignalEventIndex).length : null;
  const policyDenialsBefore = hasBoundary ? toolCalls.filter((tc) => isBashKind(tc) && tc.policy_decision === 'deny' && tc.tool_use_event_index <= firstUsefulSignalEventIndex).length : null;
  const policyDenialsAfter = hasBoundary ? toolCalls.filter((tc) => isBashKind(tc) && tc.policy_decision === 'deny' && tc.tool_use_event_index > firstUsefulSignalEventIndex).length : null;

  // Schema-aware (Section E): a schema:6+ record gets a v3 sidecar (LATEST); every earlier record
  // (v5, still the only other schema a real accepted-run scenario record ever carries) gets v2 --
  // the version that record's own accepted_audit.schema pointer actually requires. tool_calls/
  // summary are computed identically either way (v3 conserves v2's shape verbatim); only the
  // schema stamp and the presence of run_provenance_sha256 differ.
  const sidecarSchema = record.schema >= 6 ? LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA : ACCEPTED_AUDIT_SIDECAR_SCHEMA_V2;
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
    },
  };
  if (sidecarSchema === LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA) {
    built.run_provenance_sha256 = computeRunProvenanceSha256(record);
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
  // v2 AND v3 both carry the dispatch_status shape (v3 conserves v2's tool_calls/summary verbatim).
  const hasDispatchStatusShape = schema === 2 || schema === 3;
  const isV3 = schema === 3;
  if (typeof sidecar.run_id !== 'string' || sidecar.run_id.length === 0) errors.push({ field: 'run_id', message: 'must be a non-empty string' });
  const requiredRunSchema = requiredRunSchemaFor(schema);
  if (requiredRunSchema != null && sidecar.run_schema !== requiredRunSchema) {
    errors.push({ field: 'run_schema', message: `must be exactly ${requiredRunSchema} for sidecar schema ${schema}` });
  }
  if (isV3) {
    if (!/^[0-9a-f]{64}$/.test(sidecar.run_provenance_sha256)) {
      errors.push({ field: 'run_provenance_sha256', message: 'must be a lowercase 64-char hex SHA-256 string' });
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
            errors.push({ field: `${label}.dispatch_status`, message: 'not_applicable is only for non-Bash tools -- a Bash entry is hook_evaluated, pre_dispatch_blocked, or unaccounted' });
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
          if (tc.dispatch_status === 'unaccounted' && tc.policy_decision !== 'missing') {
            errors.push({ field: `${label}.policy_decision`, message: 'must be missing when dispatch_status is unaccounted' });
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
        // above. A normal Bash call still can never be not-applicable.
        const preDispatchExempt = hasDispatchStatusShape && tc.dispatch_status === 'pre_dispatch_blocked';
        if (tc.policy_decision === 'not-applicable' && !preDispatchExempt) errors.push({ field: `${label}.policy_decision`, message: 'a Bash-family entry must have a real decision category (allow/deny/missing), never not-applicable' });
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
      } else {
        if (tc.plan_only !== null) errors.push({ field: `${label}.plan_only`, message: 'must be null for a Skill/unexpected-tool tool_kind' });
        if (tc.operation !== null) errors.push({ field: `${label}.operation`, message: 'must be null for a Skill/unexpected-tool tool_kind' });
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
      const deniedCount = bashEntries.filter((tc) => tc.policy_decision === 'deny').length;
      if (summary.policy_denials_total !== deniedCount) errors.push({ field: 'summary.policy_denials_total', message: 'must equal the number of Bash-family entries with policy_decision:deny' });
      const missingCount = bashEntries.filter((tc) => tc.policy_decision === 'missing').length;
      if (summary.policy_decisions_missing !== missingCount) errors.push({ field: 'summary.policy_decisions_missing', message: 'must equal the number of Bash-family entries with policy_decision:missing' });
      if (hasDispatchStatusShape) {
        // Exact cardinality against tool_calls[], the same discipline every other summary counter
        // gets -- a standalone total nobody cross-checks is a number that can quietly go wrong.
        const preDispatchCount = bashEntries.filter((tc) => tc.dispatch_status === 'pre_dispatch_blocked').length;
        if (summary.pre_dispatch_blocked_total !== preDispatchCount) {
          errors.push({ field: 'summary.pre_dispatch_blocked_total', message: 'must equal the number of Bash-family entries with dispatch_status:pre_dispatch_blocked' });
        }
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

  // run_provenance_sha256 (v3 only) -- recomputed from the RE-READ record and required to match
  // exactly, so a v3 sidecar can never be self-consistent while pointing at a different record's
  // provenance (the same identity-binding role sha256/blob hashes play elsewhere in this repo).
  // Only checked for schema 3: a v1/v2 sidecar carries no such field at all.
  if (sidecar.schema === LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA) {
    const expected = computeRunProvenanceSha256(record);
    if (sidecar.run_provenance_sha256 !== expected) {
      errors.push({ field: 'run_provenance_sha256', message: `sidecar run_provenance_sha256 (${sidecar.run_provenance_sha256}) does not match recomputed value from record (${expected})` });
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

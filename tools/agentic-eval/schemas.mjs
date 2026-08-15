#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/schemas.mjs -- versioned scenario/condition/run/aggregate schemas.
//
// Hand-rolled (CURRENT_SCHEMA int + CANONICAL_FIELDS array + typeof/enum/regex validators
// returning {errors, warnings}), matching tools/measurement-registry.mjs's existing pattern --
// no JSON-schema library exists anywhere in this repo's own code, so none is added here.
//
// "Never infer missing metrics; store null with a reason": every metric that can be
// legitimately unavailable is {value: T|null, reason: string|null} -- the validator rejects
// value:null paired with reason:null.
import { GRADLE_TASK_ENTRY_RE, KMPTEST_SUBCOMMAND_ENTRY_RE } from './policy-hook.mjs';
import { GRADING_CHECK_NAMES } from './graders.mjs';
import { normalizeModuleName } from './command-classify.mjs';
import { SUPPORTED_ACCEPTED_AUDIT_SIDECAR_SCHEMAS } from './accepted-run-audit.mjs';
import { classifyExitCode, EXIT } from '../../lib/envelope/exit-codes.js';

// Run schema went from a single CURRENT_RUN_SCHEMA equality check to explicit per-version
// dispatch (SUPPORTED_RUN_SCHEMAS / LATEST_RUN_SCHEMA) -- a real bug found on review: a naive
// bump of the old single constant to 2 would have made validateRun() reject every one of the 8
// historical schema:1 run records committed by PR #373/#378 at its very first check, before
// anything else even ran. `LATEST_RUN_SCHEMA` is what every subcommand (calibrate/smoke/run
// alike) stamps on NEW records going forward; `SUPPORTED_RUN_SCHEMAS` is what validateRun()
// still accepts, so the 8 historical files keep validating under their original v1 rules
// unchanged (see the RUN_CANONICAL_FIELDS_V1/_V2/_V3 split and validateRun's dispatch, below).
export const SUPPORTED_RUN_SCHEMAS = [1, 2, 3, 4, 5];
export const LATEST_RUN_SCHEMA = 5;
export const CURRENT_SCENARIO_SCHEMA = 1;
// v1 -> v2 (review-round-2 fix): group_key's own SHAPE changed -- it gained the
// `ambient_skill_profile` partition field -- so this is bumped exactly like LATEST_RUN_SCHEMA is
// whenever a run record's own shape changes. No historical committed aggregate-output files exist
// to preserve compatibility with (aggregate output is always computed on demand, never persisted
// under tools/runs/), so this is a plain constant bump, not a versioned dispatch.
export const CURRENT_AGGREGATE_SCHEMA = 2;

export const RUN_KIND_VALUES = ['calibration', 'corpus-probe', 'scenario', 'smoke'];
export const CONDITION_VALUES = ['no-skill', 'current-skill', 'candidate-skill'];
export const FAMILY_VALUES = ['test-only', 'coverage', 'trigger-only'];
export const CACHE_STATE_VALUES = ['cold', 'warm', 'mixed', 'unknown'];
export const PLATFORM_VALUES = ['windows', 'macos', 'linux', 'not-recorded'];
export const TERMINATION_REASON_VALUES = [null, 'timeout', 'error', 'unsupported-platform-profile'];
export const PRIVACY_STATUS_VALUES = ['public', 'redacted-private'];
export const DAEMON_POLICY_VALUES = ['disabled-via-gradle-user-home-properties', 'default', 'unknown'];

// Schema v1 -- unchanged from every historical record's own shape (the 8 files committed by
// PR #373/#378). Never edit this list; a v1 record must keep validating exactly as it always has.
const RUN_CANONICAL_FIELDS_V1 = [
  'schema', 'run_id', 'run_kind', 'benchmark_eligible', 'scenario_id', 'query_id', 'condition',
  'skill_source_sha', 'kmp_test_cli_version', 'kmp_test_cli_source_sha',
  'resolved_kmp_test_executable_path', 'model_requested', 'model_resolved', 'session_id_observed',
  'claude_code_version', 'repo_commit', 'project_alias', 'project_commit', 'project_url', 'platform', 'family', 'cache_state',
  'daemon_policy', 'env_allowlist_profile', 'seed', 'order_index', 'started_at', 'ended_at',
  'wall_clock_ms', 'skill_available', 'skill_invocation_attempted', 'skill_invoked', 'skill_invocation_event', 'success',
  'expected_outcome_matched', 'first_useful_signal_ms', 'first_useful_signal_event', 'tokens',
  'tool_calls_total', 'shell_commands_total', 'test_invocations_total', 'retries', 'output_bytes',
  'stream_json_bytes', 'human_interventions', 'terminated', 'termination_reason', 'exit_code',
  'permission_mode_used', 'policy_allowed_gradle_tasks', 'policy_allowed_kmptest_subcommands',
  'policy_sha256', 'hook_call_count', 'hook_deny_count', 'privacy_status', 'raw_capture_committed',
  'raw_capture_location', 'notes', 'errors',
];

// Schema v2 = v1 + grading_checks (structured per-check grading detail, never overloaded into
// notes/errors) + repetition_index (which trial within a scenario matrix a record belongs to --
// decision 11's set-equality completeness proof needs this to exist as an actual field, not just
// be inferred). Every subcommand (calibrate/smoke/run alike) stamps LATEST_RUN_SCHEMA on new
// records going forward; calibrate/smoke's own records simply report both new fields as
// legitimately not-applicable (null + reason), the same "never infer, store null with a reason"
// convention every other optional field in this schema already follows.
const RUN_CANONICAL_FIELDS_V2 = [...RUN_CANONICAL_FIELDS_V1, 'grading_checks', 'repetition_index'];

// Schema v3 = v2 + foreign_skill_summary (categorized {rejected, confirmed, incomplete} counts of
// any Skill tool_use targeting something other than the expected skill -- see
// classifyForeignSkillUses in stream-parser.mjs). Unlike grading_checks/repetition_index, this is
// NOT scenario-only and NOT a nullable metric -- it's always computable from the transcript
// (an empty classification correctly yields all-zero counts), so every run_kind carries a real,
// non-null value on every schema:3 record.
const RUN_CANONICAL_FIELDS_V3 = [...RUN_CANONICAL_FIELDS_V2, 'foreign_skill_summary'];

// Schema v4 = v3 + ambient_skill_profile ({count, scope_id, fingerprint_hmac} -- a privacy-safe,
// invocation-scoped-keyed summary of the init event's `skills[]` array with the target skill's own
// identity stripped out, see stream-parser.mjs's computeAmbientSkillProfile/
// fingerprintAmbientSkillNames). Like foreign_skill_summary (and unlike grading_checks/
// repetition_index), NOT scenario-only -- always computable from any condition's init event, so
// every run_kind carries a real, non-null value on every schema:4 record.
const RUN_CANONICAL_FIELDS_V4 = [...RUN_CANONICAL_FIELDS_V3, 'ambient_skill_profile'];

// Schema v5 (accepted-run-observability PR) = v4 + 4 post-first-signal {value,reason} nullable
// metrics (post_signal_ms/post_signal_tool_calls/policy_denials_before_first_signal/
// policy_denials_after_first_signal) + accepted_audit (a plain nullable structured field -- the
// record-to-sidecar SHA-256 binding, never a {value,reason} metric). Like ambient_skill_profile/
// foreign_skill_summary (and unlike grading_checks/repetition_index), the 4 metrics are NOT
// scenario-only fields -- they are always PRESENT on every schema:5 record (every run_kind), just
// null+reason for a run_kind/condition where the underlying boundary doesn't apply. accepted_audit
// itself IS scenario-only in VALUE (null for non-scenario, a real object for scenario) but the key
// is still always present.
// The 4 new v5 post-signal {value,reason} nullable metrics -- named ONCE here. RUN_CANONICAL_FIELDS_V5
// spreads this array rather than re-listing the 4 names itself, and validateRun's own "forbidden
// below v5" gate imports this same constant -- so the two can never independently drift apart the
// way a second, separately-typed-out copy of the same 4 strings could.
const V5_METRIC_FIELDS = ['post_signal_ms', 'post_signal_tool_calls', 'policy_denials_before_first_signal', 'policy_denials_after_first_signal'];

const RUN_CANONICAL_FIELDS_V5 = [
  ...RUN_CANONICAL_FIELDS_V4,
  ...V5_METRIC_FIELDS,
  'accepted_audit',
];

// Closed charset (no `/`, no `\`) so a traversal sequence or absolute path can never match this
// regex regardless of what a (possibly tampered) run_id contains -- see this regex's own call site
// in validateRun for the full rationale.
const ACCEPTED_AUDIT_RELATIVE_PATH_RE = /^audit\/[A-Za-z0-9._-]+\.json$/;

// Explicit if-chain, not a ternary -- a bare `schema === 2 ? V2 : V1`-shaped chain, naively
// extended with one more ternary branch per version, silently falls through an unrecognized/future
// schema number to V1 instead of the LATEST fields, which would make a schema:5 record validate
// against the wrong (v1) field list entirely. schema===5 must resolve to V5, never V1.
function runCanonicalFieldsFor(schema) {
  if (schema === 5) return RUN_CANONICAL_FIELDS_V5;
  if (schema === 4) return RUN_CANONICAL_FIELDS_V4;
  if (schema === 3) return RUN_CANONICAL_FIELDS_V3;
  if (schema === 2) return RUN_CANONICAL_FIELDS_V2;
  return RUN_CANONICAL_FIELDS_V1;
}

// Fields using the {value, reason} nullable-metric shape -- "never infer, store null with a reason".
// grading_checks is v2-only (schema dispatch below decides whether it's even inspected); listed
// here unconditionally is harmless since validateNullableMetric is only ever invoked for fields
// present on the record (`for (const f of NULLABLE_METRIC_FIELDS) if (f in run) ...`).
const NULLABLE_METRIC_FIELDS = [
  'skill_available', 'skill_invocation_attempted', 'skill_invoked', 'success', 'expected_outcome_matched',
  'first_useful_signal_ms', 'tool_calls_total', 'shell_commands_total', 'test_invocations_total',
  'retries', 'output_bytes', 'stream_json_bytes', 'human_interventions', 'grading_checks',
  'post_signal_ms', 'post_signal_tool_calls', 'policy_denials_before_first_signal', 'policy_denials_after_first_signal',
];

// Per-field value domain: 'boolean' for status metrics, 'count' for non-negative integer
// counts/bytes, 'timing' for non-negative (possibly fractional) millisecond values, 'checks-array'
// for grading_checks's structured array (decision 14 -- exactly GRADING_CHECK_NAMES, no more, no
// fewer, no duplicates). A non-null value failing its domain (e.g. skill_invoked: "false" as a
// string, or a negative byte count) passes the {value,reason} shape check but is still wrong data
// -- validated separately so a malformed value can't silently corrupt grading/aggregation
// downstream.
const NULLABLE_METRIC_KIND = {
  skill_available: 'boolean', skill_invocation_attempted: 'boolean', skill_invoked: 'boolean', success: 'boolean',
  expected_outcome_matched: 'boolean', first_useful_signal_ms: 'timing',
  tool_calls_total: 'count', shell_commands_total: 'count', test_invocations_total: 'count',
  retries: 'count', output_bytes: 'count', stream_json_bytes: 'count', human_interventions: 'count',
  'tokens.input': 'count', 'tokens.output': 'count', 'tokens.cache_read': 'count', 'tokens.cache_creation': 'count',
  grading_checks: 'checks-array',
  post_signal_ms: 'timing', post_signal_tool_calls: 'count',
  policy_denials_before_first_signal: 'count', policy_denials_after_first_signal: 'count',
};

function isNullableMetric(m) {
  return m != null && typeof m === 'object' && 'value' in m && 'reason' in m;
}

/** Validates one grading_checks.value array against the fixed GRADING_CHECK_NAMES set (decision
 * 14): every name present exactly once, no unrecognized names, `passed` strictly boolean per
 * entry, `evidence_event_indices` an array of non-negative integers. A grader that silently
 * dropped a check, or a future edit that renamed one without updating GRADING_CHECK_NAMES, fails
 * validation immediately instead of silently producing an incomplete/malformed record. */
function validateGradingChecksArray(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push({ field, message: 'value must be an array' });
    return;
  }
  const seenNames = new Set();
  for (const [i, entry] of value.entries()) {
    const label = `${field}[${i}]`;
    if (entry == null || typeof entry !== 'object') {
      errors.push({ field: label, message: 'must be an object' });
      continue;
    }
    if (typeof entry.name !== 'string' || !GRADING_CHECK_NAMES.includes(entry.name)) {
      errors.push({ field: `${label}.name`, message: `must be one of ${GRADING_CHECK_NAMES.join('|')}` });
    } else if (seenNames.has(entry.name)) {
      errors.push({ field: `${label}.name`, message: `duplicate check name: ${entry.name}` });
    } else {
      seenNames.add(entry.name);
    }
    if (typeof entry.passed !== 'boolean') errors.push({ field: `${label}.passed`, message: 'must be a boolean' });
    if (typeof entry.detail !== 'string') errors.push({ field: `${label}.detail`, message: 'must be a string' });
    if (!Array.isArray(entry.evidence_event_indices) || entry.evidence_event_indices.some((n) => !Number.isInteger(n) || n < 0)) {
      errors.push({ field: `${label}.evidence_event_indices`, message: 'must be an array of non-negative integers' });
    }
  }
  for (const name of GRADING_CHECK_NAMES) {
    if (!seenNames.has(name)) errors.push({ field, message: `missing required check: ${name}` });
  }
}

function validateMetricValueDomain(value, kind, field, errors) {
  if (value === null || kind == null) return;
  if (kind === 'boolean' && typeof value !== 'boolean') {
    errors.push({ field, message: `value must be a boolean, got ${typeof value}` });
  } else if (kind === 'count' && !(Number.isInteger(value) && value >= 0)) {
    errors.push({ field, message: `value must be a non-negative integer` });
  } else if (kind === 'timing' && !(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
    errors.push({ field, message: `value must be a non-negative finite number` });
  } else if (kind === 'checks-array') {
    validateGradingChecksArray(value, field, errors);
  }
}

function validateNullableMetric(m, field, errors, kind = NULLABLE_METRIC_KIND[field] ?? null) {
  if (!isNullableMetric(m)) {
    errors.push({ field, message: `must be a {value, reason} object` });
    return;
  }
  if (m.value === null && (m.reason == null || m.reason === '')) {
    errors.push({ field, message: `value is null but reason is missing -- never infer, always explain` });
  }
  if (m.value !== null && m.reason != null) {
    errors.push({ field, message: `reason must be null when value is present -- reason is only for explaining an absence` });
  }
  validateMetricValueDomain(m.value, kind, field, errors);
}

function validateEventRef(ref, field, errors) {
  if (ref == null) return; // legitimately absent (e.g. skill never invoked)
  if (typeof ref !== 'object' || typeof ref.type !== 'string' || typeof ref.index !== 'number') {
    errors.push({ field, message: `must be null or {type: string, index: number}` });
  }
}

function validateTokens(tokens, errors) {
  if (tokens == null || typeof tokens !== 'object') {
    errors.push({ field: 'tokens', message: 'must be an object' });
    return;
  }
  for (const key of ['input', 'output', 'cache_read', 'cache_creation']) {
    validateNullableMetric(tokens[key], `tokens.${key}`, errors);
  }
}

export function validateRun(run) {
  const errors = [];
  const warnings = [];
  if (run == null || typeof run !== 'object') {
    errors.push({ field: '(root)', message: 'run record is not an object' });
    return { errors, warnings };
  }

  // Schema-version dispatch (decision 6) -- picks the v1 or v2 field-presence list based on the
  // record's OWN declared schema, never a single global comparison. This is what lets the 8
  // historical schema:1 records keep validating exactly as they always have, unaffected by v2's
  // addition.
  if (!SUPPORTED_RUN_SCHEMAS.includes(run.schema)) {
    errors.push({ field: 'schema', message: `expected one of ${SUPPORTED_RUN_SCHEMAS.join('|')}, got ${run.schema}` });
  }
  const canonicalFields = runCanonicalFieldsFor(run.schema);
  const keys = new Set(Object.keys(run));
  for (const f of canonicalFields) if (!keys.has(f)) errors.push({ field: f, message: 'missing required field' });
  for (const k of keys) if (!canonicalFields.includes(k)) warnings.push({ field: k, message: 'unrecognized field' });

  if (typeof run.run_id !== 'string' || run.run_id.length === 0) errors.push({ field: 'run_id', message: 'must be a non-empty string' });
  if (!RUN_KIND_VALUES.includes(run.run_kind)) errors.push({ field: 'run_kind', message: `must be one of ${RUN_KIND_VALUES.join('|')}` });
  if (typeof run.benchmark_eligible !== 'boolean') errors.push({ field: 'benchmark_eligible', message: 'must be a boolean' });
  if (run.run_kind !== 'scenario' && run.benchmark_eligible !== false) {
    errors.push({ field: 'benchmark_eligible', message: `must be false for run_kind "${run.run_kind}" -- only future controlled scenario runs may be true` });
  }
  if (!CONDITION_VALUES.includes(run.condition)) errors.push({ field: 'condition', message: `must be one of ${CONDITION_VALUES.join('|')}` });
  if (run.condition === 'current-skill' && typeof run.skill_source_sha !== 'string') {
    errors.push({ field: 'skill_source_sha', message: 'required (non-null) when condition is current-skill' });
  }
  if (run.condition !== 'current-skill' && run.skill_source_sha !== null) {
    errors.push({ field: 'skill_source_sha', message: 'must be null when condition is not current-skill' });
  }
  if (!FAMILY_VALUES.includes(run.family)) errors.push({ field: 'family', message: `must be one of ${FAMILY_VALUES.join('|')}` });
  if (!CACHE_STATE_VALUES.includes(run.cache_state)) errors.push({ field: 'cache_state', message: `must be one of ${CACHE_STATE_VALUES.join('|')}` });
  if (!PLATFORM_VALUES.includes(run.platform)) errors.push({ field: 'platform', message: `must be one of ${PLATFORM_VALUES.join('|')}` });
  if (!TERMINATION_REASON_VALUES.includes(run.termination_reason)) errors.push({ field: 'termination_reason', message: `must be one of ${TERMINATION_REASON_VALUES.map(String).join('|')}` });
  if (typeof run.terminated !== 'boolean') errors.push({ field: 'terminated', message: 'must be a boolean' });
  if (run.terminated === false && run.termination_reason !== null) errors.push({ field: 'termination_reason', message: 'must be null when terminated is false' });
  if (run.exit_code !== null && !(Number.isInteger(run.exit_code))) {
    errors.push({ field: 'exit_code', message: 'must be null or an integer' });
  }
  const startedAtMs = typeof run.started_at === 'string' ? Date.parse(run.started_at) : NaN;
  const endedAtMs = typeof run.ended_at === 'string' ? Date.parse(run.ended_at) : NaN;
  if (Number.isNaN(startedAtMs)) errors.push({ field: 'started_at', message: 'must be a valid ISO timestamp string' });
  if (Number.isNaN(endedAtMs)) errors.push({ field: 'ended_at', message: 'must be a valid ISO timestamp string' });
  if (!Number.isNaN(startedAtMs) && !Number.isNaN(endedAtMs) && endedAtMs < startedAtMs) {
    errors.push({ field: 'ended_at', message: 'must not be before started_at' });
  }
  if (!(typeof run.wall_clock_ms === 'number' && Number.isFinite(run.wall_clock_ms) && run.wall_clock_ms >= 0)) {
    errors.push({ field: 'wall_clock_ms', message: 'must be a non-negative finite number' });
  }
  if (!PRIVACY_STATUS_VALUES.includes(run.privacy_status)) errors.push({ field: 'privacy_status', message: `must be one of ${PRIVACY_STATUS_VALUES.join('|')}` });
  if (typeof run.raw_capture_committed !== 'boolean') errors.push({ field: 'raw_capture_committed', message: 'must be a boolean' });
  if (run.raw_capture_committed !== false) errors.push({ field: 'raw_capture_committed', message: 'must always be false -- raw transcripts are never committed' });
  if (typeof run.raw_capture_location === 'string' && /^[a-zA-Z]:[\\/]|^\//.test(run.raw_capture_location)) {
    errors.push({ field: 'raw_capture_location', message: 'must be a relative path, never absolute' });
  }
  // A CONFIRMED invocation is only ever derived from an attempt that also succeeded (see
  // stream-parser.mjs's findSkillInvocation) -- invoked:true without attempted:true is never
  // truthfully producible and signals a construction bug upstream, not legitimate data.
  if (run.skill_invoked?.value === true && run.skill_invocation_attempted?.value !== true) {
    errors.push({ field: 'skill_invoked', message: 'cannot be true when skill_invocation_attempted is not true' });
  }

  // grading_checks (v2-introduced field) -- conditionally required, not merely optional: a real,
  // non-null checks array whenever this IS a schema:2+ scenario record (grading genuinely applies
  // and must have actually run), null+reason for every other run_kind/schema combination
  // (calibrate/smoke's own v2+ records, and any v1 record where the field doesn't exist at all).
  // `>= 2`, not `=== 2` -- a v3 record inherits every v2 semantic rule, not just v2's field LIST;
  // a bare `=== 2` here would silently stop validating this field the moment schema v3 records
  // started existing (round-4 audit finding: this was the actual bug in an earlier draft of the
  // v3 bump, found by inspecting this exact line, not assumed from the field-list change alone).
  if (run.schema >= 2) {
    if (run.run_kind === 'scenario') {
      if (run.grading_checks?.value == null) {
        errors.push({ field: 'grading_checks', message: 'required (non-null) for a schema:2+ run_kind:scenario record -- grading must have actually run' });
      }
    } else if (run.grading_checks?.value != null) {
      errors.push({ field: 'grading_checks', message: `must be null for run_kind "${run.run_kind}" -- grading only applies to scenario records` });
    }
  }

  // repetition_index (v2-introduced field, plain nullable -- like scenario_id, not a
  // {value,reason} metric) -- required (a real non-negative integer identifying which trial this
  // record belongs to) for a schema:2+ scenario record, null for every other run_kind (no
  // repetition concept applies). `>= 2`, not `=== 2` -- see grading_checks's identical rationale
  // immediately above; a schema:1 record (even a hypothetical/test-constructed
  // run_kind:'scenario' one) was never expected to carry this field at all, since
  // RUN_CANONICAL_FIELDS_V1 doesn't include it -- only v2+ introduces the concept.
  if (run.schema >= 2) {
    if (run.run_kind === 'scenario') {
      if (!(Number.isInteger(run.repetition_index) && run.repetition_index >= 0)) {
        errors.push({ field: 'repetition_index', message: 'must be a non-negative integer for a schema:2+ run_kind:scenario record' });
      }
    } else if ('repetition_index' in run && run.repetition_index !== null) {
      errors.push({ field: 'repetition_index', message: `must be null for run_kind "${run.run_kind}"` });
    }
  }

  // foreign_skill_summary (v3-introduced field) -- unlike grading_checks/repetition_index, this
  // applies to EVERY run_kind (never scenario-only) and is always required once schema>=3, since
  // it's always computable from the transcript (an empty classification legitimately yields
  // all-zero counts, never null). Below schema 3 the field must be entirely absent -- it did not
  // exist in RUN_CANONICAL_FIELDS_V1/_V2, so a v1/v2 record carrying it at all would be
  // self-contradictory relative to its own declared schema version.
  if (run.schema >= 3) {
    const summary = run.foreign_skill_summary;
    if (summary == null || typeof summary !== 'object' || Array.isArray(summary)) {
      errors.push({ field: 'foreign_skill_summary', message: 'required (non-null object) for a schema:3+ record' });
    } else {
      const allowedKeys = new Set(['rejected', 'confirmed', 'incomplete']);
      const actualKeys = Object.keys(summary);
      if (actualKeys.some((k) => !allowedKeys.has(k)) || actualKeys.length !== allowedKeys.size) {
        errors.push({ field: 'foreign_skill_summary', message: `must have exactly the keys rejected/confirmed/incomplete, got ${JSON.stringify(actualKeys)}` });
      }
      for (const key of allowedKeys) {
        if (!(Number.isInteger(summary[key]) && summary[key] >= 0)) {
          errors.push({ field: `foreign_skill_summary.${key}`, message: 'must be a non-negative integer' });
        }
      }
    }
  } else if ('foreign_skill_summary' in run && run.foreign_skill_summary != null) {
    errors.push({ field: 'foreign_skill_summary', message: `must be absent or null for schema ${run.schema} -- foreign_skill_summary was introduced in schema v3` });
  }

  // ambient_skill_profile (v4-introduced field) -- mirrors foreign_skill_summary's identical v3
  // gate one version up: applies to EVERY run_kind (never scenario-only), always required once
  // schema>=4, and must be entirely absent below schema v4 -- it did not exist in
  // RUN_CANONICAL_FIELDS_V1/_V2/_V3, so a v1-v3 record carrying it would be self-contradictory
  // relative to its own declared schema version.
  //
  // Review-round-2 fix: {count, scope_id, fingerprint_hmac} (3 keys, not the original 2) --
  // `scope_id` is an opaque, per-invocation UUID (see cli.mjs's generateAmbientProfileScope) that
  // makes explicit which records are even comparable to each other (fingerprint_hmac is keyed by a
  // random, never-persisted, per-invocation secret -- see stream-parser.mjs's
  // fingerprintAmbientSkillNames -- so two records sharing the SAME scope_id came from the SAME
  // invocation and used the SAME key; two different scope_ids can never be meaningfully compared,
  // regardless of what their fingerprints happen to look like). `fingerprint_hmac` replaces the
  // original `fingerprint_sha256` name to be honest that this is now a KEYED digest, not a bare
  // content hash.
  if (run.schema >= 4) {
    const profile = run.ambient_skill_profile;
    if (profile == null || typeof profile !== 'object' || Array.isArray(profile)) {
      errors.push({ field: 'ambient_skill_profile', message: 'required (non-null object) for a schema:4+ record' });
    } else {
      const allowedKeys = new Set(['count', 'scope_id', 'fingerprint_hmac']);
      const actualKeys = Object.keys(profile);
      if (actualKeys.some((k) => !allowedKeys.has(k)) || actualKeys.length !== allowedKeys.size) {
        errors.push({ field: 'ambient_skill_profile', message: `must have exactly the keys count/scope_id/fingerprint_hmac, got ${JSON.stringify(actualKeys)}` });
      }
      if (!(Number.isInteger(profile.count) && profile.count >= 0)) {
        errors.push({ field: 'ambient_skill_profile.count', message: 'must be a non-negative integer' });
      }
      if (typeof profile.scope_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profile.scope_id)) {
        errors.push({ field: 'ambient_skill_profile.scope_id', message: 'must be a full (36-char) UUID string' });
      }
      if (typeof profile.fingerprint_hmac !== 'string' || !/^[0-9a-f]{64}$/.test(profile.fingerprint_hmac)) {
        errors.push({ field: 'ambient_skill_profile.fingerprint_hmac', message: 'must be a lowercase 64-char hex HMAC-SHA256 string' });
      }
    }
  } else if ('ambient_skill_profile' in run && run.ambient_skill_profile != null) {
    errors.push({ field: 'ambient_skill_profile', message: `must be absent or null for schema ${run.schema} -- ambient_skill_profile was introduced in schema v4` });
  }

  // accepted_audit (v5-introduced field) -- mirrors ambient_skill_profile's identical v4 gate one
  // version up, but the VALUE relationship is scenario-only (unlike ambient_skill_profile, which
  // is a real object for every run_kind): required as a non-null, well-formed object for a
  // schema:5 scenario record (one sidecar per accepted scenario record), and required to be
  // exactly null for every other run_kind (no scenario grader, no sidecar). Must be entirely
  // absent below schema v5 -- it did not exist in RUN_CANONICAL_FIELDS_V1-4, so a pre-v5 record
  // carrying it would be self-contradictory relative to its own declared schema version.
  //
  // relative_path is validated via a STRICT, closed charset regex (never merely "equals a value
  // derived from run.run_id") -- run_id itself is only checked elsewhere for non-emptiness, never
  // for a safe charset, so a tampered/malicious record could otherwise smuggle a traversal
  // sequence or an absolute path through by crafting a matching run_id. The regex's charset has no
  // `/` or `\` at all, so a path with either can never match regardless of what run_id contains.
  if (run.schema >= 5) {
    if (run.run_kind === 'scenario') {
      const audit = run.accepted_audit;
      if (audit == null || typeof audit !== 'object' || Array.isArray(audit)) {
        errors.push({ field: 'accepted_audit', message: 'required (non-null object) for a schema:5+ run_kind:scenario record' });
      } else {
        const allowedKeys = new Set(['schema', 'relative_path', 'sha256']);
        const actualKeys = Object.keys(audit);
        if (actualKeys.some((k) => !allowedKeys.has(k)) || actualKeys.length !== allowedKeys.size) {
          errors.push({ field: 'accepted_audit', message: `must have exactly the keys schema/relative_path/sha256, got ${JSON.stringify(actualKeys)}` });
        }
        // A SET, not a pinned constant: the 92 historical records point at v1 sidecars and must
        // keep validating verbatim, while newly built records point at v2. The loader/validator
        // dispatches on the sidecar's real version; an unknown version fails closed there.
        if (!SUPPORTED_ACCEPTED_AUDIT_SIDECAR_SCHEMAS.includes(audit.schema)) {
          errors.push({ field: 'accepted_audit.schema', message: `must be one of ${SUPPORTED_ACCEPTED_AUDIT_SIDECAR_SCHEMAS.join('|')}` });
        }
        const expectedRelativePath = typeof run.run_id === 'string' ? `audit/${run.run_id}.json` : null;
        if (typeof audit.relative_path !== 'string' || !ACCEPTED_AUDIT_RELATIVE_PATH_RE.test(audit.relative_path) || audit.relative_path !== expectedRelativePath) {
          errors.push({ field: 'accepted_audit.relative_path', message: `must be exactly "audit/<run_id>.json" derived from this record's own run_id, POSIX-style, no traversal/backslash/absolute path, got ${JSON.stringify(audit.relative_path)}` });
        }
        if (typeof audit.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(audit.sha256)) {
          errors.push({ field: 'accepted_audit.sha256', message: 'must be a lowercase 64-char hex SHA-256 string' });
        }
      }
    } else if (run.accepted_audit !== null) {
      errors.push({ field: 'accepted_audit', message: `must be null for run_kind "${run.run_kind}" -- a sidecar only ever exists for a scenario record` });
    }
  } else if ('accepted_audit' in run && run.accepted_audit != null) {
    errors.push({ field: 'accepted_audit', message: `must be absent or null for schema ${run.schema} -- accepted_audit was introduced in schema v5` });
  }

  // The 4 new v5 post-signal metrics -- like foreign_skill_summary/ambient_skill_profile (and
  // unlike grading_checks/repetition_index), forbidden below the schema version that introduces
  // them via a DEDICATED error, not merely the generic unrecognized-field warning every
  // not-yet-canonical field already gets.
  if (run.schema < 5) {
    for (const f of V5_METRIC_FIELDS) {
      if (f in run && run[f] != null) {
        errors.push({ field: f, message: `must be absent or null for schema ${run.schema} -- ${f} was introduced in schema v5` });
      }
    }
  }

  for (const f of NULLABLE_METRIC_FIELDS) if (f in run) validateNullableMetric(run[f], f, errors);
  if ('tokens' in run) validateTokens(run.tokens, errors);
  validateEventRef(run.skill_invocation_event, 'skill_invocation_event', errors);
  validateEventRef(run.first_useful_signal_event, 'first_useful_signal_event', errors);

  // hook_call_count/hook_deny_count are ALWAYS real, non-negative integers in production --
  // countHookEvents() derives both as array .length values, never null/undefined -- so both are
  // validated unconditionally, independently of one another. A previous version only validated
  // this PAIR when BOTH were non-null, which meant e.g. hook_call_count:"bad" alongside
  // hook_deny_count:null produced ZERO errors (the outer `!= null` guard on hook_deny_count was
  // false, so the whole block -- including hook_call_count's own check -- was skipped entirely).
  const hookCallCountOk = Number.isInteger(run.hook_call_count) && run.hook_call_count >= 0;
  if (!hookCallCountOk) errors.push({ field: 'hook_call_count', message: 'must be a non-negative integer' });
  const hookDenyCountOk = Number.isInteger(run.hook_deny_count) && run.hook_deny_count >= 0;
  if (!hookDenyCountOk) errors.push({ field: 'hook_deny_count', message: 'must be a non-negative integer' });
  if (hookCallCountOk && hookDenyCountOk && run.hook_deny_count > run.hook_call_count) {
    errors.push({ field: 'hook_deny_count', message: 'cannot exceed hook_call_count' });
  }
  for (const field of ['policy_allowed_gradle_tasks', 'policy_allowed_kmptest_subcommands']) {
    if (!Array.isArray(run[field])) {
      errors.push({ field, message: 'must be an array' });
    } else if (run[field].some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      errors.push({ field, message: 'every entry must be a non-empty string' });
    }
  }
  if (typeof run.policy_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(run.policy_sha256)) {
    errors.push({ field: 'policy_sha256', message: 'must be a lowercase 64-char hex SHA-256 string' });
  }
  if (!Array.isArray(run.errors)) {
    errors.push({ field: 'errors', message: 'must be an array' });
  } else if (run.errors.some((entry) => entry == null || typeof entry !== 'object' || Array.isArray(entry))) {
    errors.push({ field: 'errors', message: 'every entry must be an object' });
  }

  return { errors, warnings };
}

const SCENARIO_CANONICAL_FIELDS = [
  'schema', 'id', 'family', 'project_alias', 'project_url', 'project_commit', 'prompt',
  'expected_outcome', 'policy', 'expected', 'first_useful_signal_predicate', 'tags', 'fixture_setup',
];
// The first-ever OPTIONAL canonical field -- every other entry above is unconditionally required.
// `fixture_setup` only applies to a scenario that mutates its own pinned checkout before the agent
// runs (today: exactly the changed-module-verification shape) -- absent for every other scenario.
const OPTIONAL_SCENARIO_FIELDS = ['fixture_setup'];

const OUTCOME_KIND_VALUES = ['tests_executed', 'no_applicable_tests', 'tests_failed', 'coverage_threshold_exceeded'];
const GRADLE_MARKER_VALUES = ['NO-SOURCE'];
// Mirrors TRIGGER_QUERY_PARTITION_VALUES's own train/held-out split for a conceptually identical
// purpose (which corpus subset a scenario belongs to) -- a fresh review reproduced `tags` never
// being validated at all: `"train"` (a bare string, not an array) and `null` `project_alias` both
// passed `validateScenario()` with zero errors.
const SCENARIO_TAG_VALUES = ['train', 'held-out'];

// Exact, closed key sets for `expected` and its per-provider/outcome_kind contracts (a real gap
// found on review: `expected.kmp_test.task=':wrong:test'` and `expected.gradle.tests.flaky=99` both
// previously validated with zero errors -- unrecognized fields were silently accepted rather than
// rejected). Enforced via `rejectUnrecognizedKeys`, below, which reads `Object.keys()` -- NOT the
// `'k' in obj && obj.k != null` presence pattern used elsewhere in this file for OPTIONAL fields --
// specifically so a forbidden key explicitly set to `null` (e.g. `expected.gradle.tests.skipped:
// null`) is still caught: `Object.keys({skipped: null})` reports `skipped` as present regardless of
// its value, while the old `!= null` presence check would have silently treated it as absent.
const EXPECTED_TOP_LEVEL_KEYS = ['module', 'outcome_kind', 'kmp_test', 'gradle', 'changed'];
// Reused for BOTH 'tests_executed' and 'tests_failed' -- the two outcome_kinds share an identical
// KEY SET (the task/build genuinely ran to completion either way); only the VALUE requirements on
// `tests.failed`/`exit_code` differ, enforced inside validateProviderContract itself.
const KMP_TEST_CONTRACT_KEYS_TESTS_EXECUTED = ['tests', 'exit_code'];
const KMP_TEST_CONTRACT_KEYS_NO_APPLICABLE = ['error_code', 'exit_code', 'caused_by_filter'];
const GRADLE_CONTRACT_KEYS_TESTS_EXECUTED = ['allowed_invocations', 'evidence_task', 'tests', 'exit_code'];
const GRADLE_CONTRACT_KEYS_NO_APPLICABLE = ['allowed_invocations', 'evidence_task', 'exit_code', 'marker'];
const KMP_TEST_TESTS_SHAPE_KEYS = ['total', 'passed', 'failed', 'individual_total', 'skipped'];
const GRADLE_TESTS_SHAPE_KEYS = ['total', 'passed', 'failed'];

// coverage_threshold_exceeded -- `tests`/`exit_code` are required exactly like tests_executed
// (this outcome is NEVER a test failure; tests.failed must be exactly 0), plus a `coverage`
// sub-object naming the real threshold/missed-line claim. Gradle has no coverage-threshold
// concept at all (--min-missed-lines is a kmp-test-only flag, no raw Gradle task ever evaluates
// it) -- its contract deliberately REUSES GRADLE_CONTRACT_KEYS_TESTS_EXECUTED verbatim (a clean,
// ordinary test-task pass, nothing coverage-specific) rather than declaring a parallel, unused
// `coverage` key set of its own.
const KMP_TEST_CONTRACT_KEYS_COVERAGE_THRESHOLD_EXCEEDED = ['tests', 'exit_code', 'coverage'];
const KMP_TEST_COVERAGE_SHAPE_KEYS = ['tool', 'min_missed_lines', 'missed_lines', 'with_data'];
// Only 'auto' -- policy-hook.mjs has NO --coverage-tool flag category at all (a review-round
// finding: this contract previously also allowed 'jacoco'/'kover', which describe a command the
// current policy grammar could never actually admit -- an unreachable state under this minimal
// PR's own policy). 'none' is separately impossible on different grounds: --coverage-tool none /
// --no-coverage disables aggregation entirely (coverage-orchestrator.js's
// coverage_aggregation_skipped path), so the gate could never fire under it either way. Widening
// this back to include 'jacoco'/'kover' is a real future option once policy-hook grows a
// --coverage-tool category of its own -- not merely a leftover value worth keeping for its own
// sake.
const COVERAGE_TOOL_EXPECTED_VALUES = ['auto'];

// expected.changed -- the changed-module-verification contract (ground truth independently
// re-verified live, 6x -- 3x kmp-test changed, 3x direct Gradle, cold GRADLE_USER_HOME + JDK 17
// each -- against android/nowinandroid @ 7d45eae4f8720a0c77f507712ba2437ff974b6ed, :core:common
// module). Confirmed via a direct hasOwnProperty check on the raw envelope in all 3 `changed` runs:
// a real `changed` envelope's `detected_modules` entries are BARE, colon-LESS strings (e.g.
// "core:common") -- a deliberately different string convention from `expected.module`'s own
// colon-prefixed one (":core:common") -- see command-classify.mjs's normalizeModuleName, which
// strips at most one leading colon, for the shared reconciliation point between the two.
const CHANGED_CONTRACT_KEYS = ['detected_modules', 'staged_only', 'base_ref'];
// No leading colon (unlike GRADLE_TASK_ENTRY_RE-shaped values) -- see this block's own doc comment.
const CHANGED_MODULE_NAME_RE = /^[A-Za-z0-9_-]+(:[A-Za-z0-9_-]+)*$/;
// Every real construction site in changed-orchestrator.js hard-codes 'HEAD' unconditionally
// (working-tree mode and --staged-only alike) -- mirrors COVERAGE_TOOL_EXPECTED_VALUES's own
// "only what the real code can produce" precedent, not a speculative future value.
const CHANGED_BASE_REF_EXPECTED_VALUES = ['HEAD'];

// fixture_setup -- the only OPTIONAL canonical scenario field (see SCENARIO_CANONICAL_FIELDS'
// own doc comment). Closed to exactly one operation today; the mutation content itself is always
// a harness-owned constant (tools/agentic-eval/materialize.mjs's own applyFixtureSetup), never
// scenario-supplied free text -- this field only ever names WHICH tracked file to mutate and what
// its pre-mutation blob must be, never the mutation's own bytes.
const FIXTURE_SETUP_KEYS = ['operation', 'relative_path', 'expected_blob_oid'];
const FIXTURE_SETUP_OPERATION_VALUES = ['append_comment'];

/** Closed, defense-in-depth safety check for `fixture_setup.relative_path` -- rejects absolute
 * paths (POSIX leading `/` or a Windows drive-letter prefix), any backslash, and any `.`/`..`
 * path segment, on top of a narrow safe charset per segment. Deliberately does NOT rely on the
 * charset regex alone to reject traversal: `.`/`-`/`_` are all individually charset-legal, so a
 * bare `/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/`-only check would let a literal `..` SEGMENT
 * through (each character is legal; the segment as a whole is what must be rejected) -- mirrors
 * policy-hook.mjs's own realpathWithinFixture, which never trusts a single regex pass either. */
function isSafeFixtureRelativePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.includes('\\')) return false;
  if (p.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  const segments = p.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  return segments.every((seg) => /^[A-Za-z0-9._-]+$/.test(seg));
}

/** Validates `fixture_setup`'s own closed shape -- never compares it against `expected.changed`
 * (that cross-check is validateFixtureSetupCoupling's job, which needs the whole scenario). */
function validateFixtureSetup(fixtureSetup, errors) {
  if (fixtureSetup == null || typeof fixtureSetup !== 'object' || Array.isArray(fixtureSetup)) {
    errors.push({ field: 'fixture_setup', message: 'must be an object' });
    return;
  }
  rejectUnrecognizedKeys(fixtureSetup, FIXTURE_SETUP_KEYS, 'fixture_setup', errors);
  if (!FIXTURE_SETUP_OPERATION_VALUES.includes(fixtureSetup.operation)) {
    errors.push({ field: 'fixture_setup.operation', message: `must be one of ${FIXTURE_SETUP_OPERATION_VALUES.join('|')}` });
  }
  if (!isSafeFixtureRelativePath(fixtureSetup.relative_path)) {
    errors.push({ field: 'fixture_setup.relative_path', message: 'must be a safe relative POSIX path -- no leading slash, no backslash, no drive letter, no ./.. segment' });
  }
  if (typeof fixtureSetup.expected_blob_oid !== 'string' || !/^[0-9a-f]{40}$/.test(fixtureSetup.expected_blob_oid)) {
    errors.push({ field: 'fixture_setup.expected_blob_oid', message: 'must be a real 40-hex-character git blob SHA' });
  }
}

/** Validates `expected.changed`'s own closed shape -- called unconditionally whenever the key is
 * present (independent of fixture_setup's own presence, mirroring every other provider-contract
 * validator in this file); the fixture_setup<->expected.changed COUPLING itself is a separate,
 * scenario-level concern (validateFixtureSetupCoupling, below). */
function validateChangedContract(changed, errors) {
  if (changed == null || typeof changed !== 'object' || Array.isArray(changed)) {
    errors.push({ field: 'expected.changed', message: 'must be an object' });
    return;
  }
  rejectUnrecognizedKeys(changed, CHANGED_CONTRACT_KEYS, 'expected.changed', errors);
  const modules = changed.detected_modules;
  if (!Array.isArray(modules) || modules.length !== 1 || typeof modules[0] !== 'string' || !CHANGED_MODULE_NAME_RE.test(modules[0])) {
    errors.push({ field: 'expected.changed.detected_modules', message: `must be an array with EXACTLY one entry matching ${CHANGED_MODULE_NAME_RE} -- multi-module is out of scope for this contract` });
  }
  if (typeof changed.staged_only !== 'boolean') {
    errors.push({ field: 'expected.changed.staged_only', message: 'must be a boolean' });
  }
  if (!CHANGED_BASE_REF_EXPECTED_VALUES.includes(changed.base_ref)) {
    errors.push({ field: 'expected.changed.base_ref', message: `must be one of ${CHANGED_BASE_REF_EXPECTED_VALUES.join('|')} -- the only value the real CLI ever produces` });
  }
}

/** Cross-field coupling between `fixture_setup` and `expected.changed` -- lives here, not inside
 * validateExpected, because it genuinely needs the WHOLE scenario object (fixture_setup is a
 * sibling of `expected`, not nested inside it; the policy/family checks below need scenario.policy
 * and scenario.family too). Both-or-neither, and when both are present, locks the contract shape
 * to exactly what THIS scenario needs (not generically future-proofed): a real
 * changed-module-verification cell can only ever be `family:"test-only"`,
 * `outcome_kind:"tests_executed"`, requires the agent's own policy to actually permit the
 * `changed` subcommand, and the setup's own mechanics (an always-UNSTAGED mutation) mean
 * `staged_only` can only ever legitimately be `false`. */
function validateFixtureSetupCoupling(scenario, errors) {
  const hasFixtureSetup = 'fixture_setup' in scenario && scenario.fixture_setup != null;
  const expected = scenario.expected;
  const hasExpectedChanged = expected != null && typeof expected === 'object' && !Array.isArray(expected) && expected.changed != null;
  if (hasFixtureSetup !== hasExpectedChanged) {
    errors.push({
      field: hasFixtureSetup ? 'expected.changed' : 'fixture_setup',
      message: 'fixture_setup and expected.changed must both be present or both be absent',
    });
    return;
  }
  if (!hasFixtureSetup) return;

  if (scenario.family !== 'test-only') {
    errors.push({ field: 'family', message: 'must be "test-only" when fixture_setup/expected.changed are present' });
  }
  if (expected.outcome_kind !== 'tests_executed') {
    errors.push({ field: 'expected.outcome_kind', message: 'must be "tests_executed" when fixture_setup/expected.changed are present' });
  }
  const policy = scenario.policy;
  const allowsChanged = policy != null && typeof policy === 'object' && Array.isArray(policy.allowed_kmptest_subcommands) && policy.allowed_kmptest_subcommands.includes('changed');
  if (!allowsChanged) {
    errors.push({ field: 'policy.allowed_kmptest_subcommands', message: `must include 'changed' when fixture_setup/expected.changed are present` });
  }

  const changed = expected.changed;
  if (changed != null && typeof changed === 'object' && !Array.isArray(changed)) {
    if (changed.staged_only !== false) {
      errors.push({ field: 'expected.changed.staged_only', message: 'must be exactly false when fixture_setup is present -- the setup always produces an unstaged change' });
    }
    if (Array.isArray(changed.detected_modules) && changed.detected_modules.length === 1 && typeof changed.detected_modules[0] === 'string' && typeof expected.module === 'string'
      && normalizeModuleName(changed.detected_modules[0]) !== normalizeModuleName(expected.module)) {
      errors.push({ field: 'expected.changed.detected_modules', message: `must name the same module as expected.module (${expected.module})` });
    }
  }
}

function rejectUnrecognizedKeys(obj, allowedKeys, field, errors) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const k of Object.keys(obj)) {
    if (!allowedKeys.includes(k)) {
      errors.push({ field: `${field}.${k}`, message: `unrecognized field -- only ${allowedKeys.join(', ')} allowed on ${field}` });
    }
  }
}

/** Validates `policy.{allowed_kmptest_subcommands,allowed_gradle_tasks}` -- the ONLY place a
 * scenario field is ever interpreted as something that reaches a shell/exec call (decision 9),
 * so this is the ONLY place scenario validation enforces an executable-content grammar. Reuses
 * the real policy hook's OWN entry-grammar regexes (imported from policy-hook.mjs, never
 * duplicated) -- a scenario can never declare a policy shape the hook itself would treat as
 * malformed. */
function validatePolicy(policy, errors) {
  if (policy == null || typeof policy !== 'object') {
    errors.push({ field: 'policy', message: 'must be an object' });
    return;
  }
  if (!Array.isArray(policy.allowed_kmptest_subcommands) || policy.allowed_kmptest_subcommands.some((s) => typeof s !== 'string' || !KMPTEST_SUBCOMMAND_ENTRY_RE.test(s))) {
    errors.push({ field: 'policy.allowed_kmptest_subcommands', message: `every entry must match ${KMPTEST_SUBCOMMAND_ENTRY_RE}` });
  }
  if (!Array.isArray(policy.allowed_gradle_tasks) || policy.allowed_gradle_tasks.some((s) => typeof s !== 'string' || !GRADLE_TASK_ENTRY_RE.test(s))) {
    errors.push({ field: 'policy.allowed_gradle_tasks', message: `every entry must match ${GRADLE_TASK_ENTRY_RE}` });
  }
}

/** Validates one provider's `expected.kmp_test`/`expected.gradle` contract against the
 * `outcome_kind`-keyed cross-field invariant (a real bug found on review: the first version of
 * this invariant FORBADE `exit_code` for `tests_executed`, which would have made a process that
 * ran the tests successfully but then crashed on some LATER step undetectable -- a stale-but-
 * still-passing JUnit XML would satisfy `tests` while nothing checked the process's own exit
 * status). `tests_executed`: `tests` AND `exit_code` (must be exactly 0) are both REQUIRED on
 * both providers; `error_code`/`caused_by_filter`/`marker` are FORBIDDEN. `no_applicable_tests`:
 * kmp_test requires `error_code`+`exit_code`+`caused_by_filter`; gradle requires `exit_code`+
 * `marker`; `tests` is FORBIDDEN on both. No hybrid combination validates either way.
 *
 * A fresh review reproduced two further gaps, both closed with genuinely PROVIDER-SPECIFIC
 * contracts rather than one shared shape:
 * 1. `individual_total`/`skipped` were optional-if-present on BOTH providers, with no distinction
 *    between them -- but `graders.mjs`'s Gradle-path evaluation (`evaluateGradleAttempt`) never
 *    reads either field at all (the JUnit-XML capture mechanism, `junit-evidence.mjs`'s
 *    `countEvidenceTaskJunit`, cannot verify them). A scenario file could declare completely
 *    FALSE values for `expected.gradle.tests.skipped`/`individual_total` and neither the schema
 *    nor the grader would ever notice -- confirmed by direct reproduction (`skipped:99,
 *    individual_total:999` added to a real scenario's gradle contract: zero validation errors,
 *    grading still `success:true`). Worse, because they were merely OPTIONAL (not required) on
 *    the kmp_test side too, omitting them from BOTH the scenario file AND an incomplete envelope
 *    let `graders.mjs`'s own `envelope.tests?.skipped === kt.tests.skipped` comparison pass
 *    VACUOUSLY (`undefined === undefined`), silently defeating the very check that field exists
 *    to enforce. Fixed: `kmp_test` now REQUIRES all five counters (`total`, `passed`, `failed`,
 *    `individual_total`, `skipped`) -- an absent counter is a schema error, never a silent
 *    vacuous match. `gradle` now FORBIDS `individual_total`/`skipped` entirely -- an unenforced
 *    claim a scenario author can never even accidentally make, mirroring how the earlier
 *    unenforced `kmp_test.task` claim was retired rather than left as decoration.
 * 2. `total` only required a non-negative integer (`>= 0`), so a `tests_executed` contract could
 *    legitimately claim `{total:0, passed:0, failed:0}` -- a self-contradictory claim (if
 *    `outcome_kind` is `tests_executed`, by definition at least one test ran; zero tests executed
 *    is a `no_applicable_tests` claim, not a degenerate `tests_executed` one) that also happens to
 *    exactly match what an ABSENT JUnit-XML directory produces (see `junit-evidence.mjs`'s
 *    `countEvidenceTaskJunit`, which distinguishes "no XML at all" (`status:'no_xml'`) from "real XML
 *    showing zero"). `total` is now required to be a POSITIVE integer (`>= 1`) for `tests_executed`
 *    on both providers -- closing the schema-level half of that finding; `passed`/`failed`
 *    individually may still legitimately be zero. */
function validateProviderContract(provider, contractName, outcomeKind, errors) {
  const field = `expected.${contractName}`;
  if (provider == null || typeof provider !== 'object') {
    errors.push({ field, message: 'must be an object' });
    return;
  }
  // Exact, closed key set for the provider object itself -- see this constants block's own doc
  // comment. Applied before the branch-specific checks below so an unrecognized field (e.g. a
  // resurrected `task`) is always reported regardless of what else is wrong. `tests_failed` shares
  // `tests_executed`'s own key set -- see KMP_TEST_CONTRACT_KEYS_TESTS_EXECUTED's own doc comment.
  const ranOutcome = outcomeKind === 'tests_executed' || outcomeKind === 'tests_failed';
  if (ranOutcome) {
    rejectUnrecognizedKeys(provider, contractName === 'kmp_test' ? KMP_TEST_CONTRACT_KEYS_TESTS_EXECUTED : GRADLE_CONTRACT_KEYS_TESTS_EXECUTED, field, errors);
  } else if (outcomeKind === 'no_applicable_tests') {
    rejectUnrecognizedKeys(provider, contractName === 'kmp_test' ? KMP_TEST_CONTRACT_KEYS_NO_APPLICABLE : GRADLE_CONTRACT_KEYS_NO_APPLICABLE, field, errors);
  } else if (outcomeKind === 'coverage_threshold_exceeded') {
    // Gradle reuses tests_executed's own key set verbatim (see KMP_TEST_CONTRACT_KEYS_COVERAGE_THRESHOLD_EXCEEDED's doc comment) -- no coverage sub-object on this provider.
    rejectUnrecognizedKeys(provider, contractName === 'kmp_test' ? KMP_TEST_CONTRACT_KEYS_COVERAGE_THRESHOLD_EXCEEDED : GRADLE_CONTRACT_KEYS_TESTS_EXECUTED, field, errors);
  }

  const hasTests = 'tests' in provider && provider.tests != null;
  const hasErrorCode = 'error_code' in provider && provider.error_code != null;
  const hasCausedByFilter = 'caused_by_filter' in provider && provider.caused_by_filter != null;
  const hasMarker = 'marker' in provider && provider.marker != null;
  // Hoisted out of the `if (ranOutcome)` block below -- shared with the coverage_threshold_exceeded
  // branch, which also needs the exact-integer domain checks but has its own `exit_code`/`tests`
  // requirements (asymmetric between providers for the SAME outcome_kind, unlike the ranOutcome pair).
  const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
  const isPositiveInt = (v) => Number.isInteger(v) && v >= 1;

  if (ranOutcome) {
    // Non-negative INTEGER, not just typeof 'number' -- a review pass reproduced total:-1,
    // passed:1.5, failed:-2 all passing validation under a bare typeof check. `total` specifically
    // must be POSITIVE (>=1), not merely non-negative -- see this function's own doc comment,
    // finding 2. total===passed+failed is checked only once the individual fields are confirmed
    // well-shaped (comparing potentially-non-numeric values would be meaningless).
    //
    // `tests_failed` (ground-truth-verified against android/nowinandroid's :lint module -- see
    // corpus/scenarios/deterministic-unit-test-failure.json) shares `tests_executed`'s shape almost
    // exactly -- both represent "the task genuinely ran to completion", never a compile/setup/env
    // failure. `exit_code` must be exactly 1 (a real kmp-test envelope's own `classifyExitCode`
    // maps `testsFailed>0 -> TEST_FAIL(1)`; a real Gradle build with genuine test failures always
    // reports BUILD FAILED, exit 1) rather than exactly 0. `tests_failed` never equates kmp-test's
    // TASK-level total/passed/failed with Gradle/JUnit's per-testcase counts -- see the
    // individual_total<->gradle.tests.total cross-check in validateExpected, below, the one place
    // the two are required to agree (both describing the SAME real test execution).
    //
    // Round-2 review finding: this scenario shape is deliberately scoped to EXACTLY one target
    // task, every one of whose individual test cases failed -- graders.mjs's own tests_failed
    // branch can only ever validate that exact shape (exactly one `module_failed` entry, never
    // more; see its own doc comment) -- never a genuinely mixed/multi-task result. An earlier
    // version of this schema only required kmp_test.tests.failed to be POSITIVE (>=1) and
    // gradle.tests.failed likewise, independently of one another and of `total`/`passed` -- which
    // let a scenario declare e.g. kmp_test `{total:3,passed:1,failed:2}` alongside gradle
    // `{total:6,passed:2,failed:4}`, a schema-valid contract the grader could never actually grade
    // correctly (no single `test_failures` array length can satisfy both a task-level failed count
    // and a per-testcase failed count that disagree). Tightened to the exact single-task/all-failed
    // contract instead of broadening the grader to match the old, wider schema -- mixed
    // results/skips remain explicitly out of scope for this PR (see this PR's own "Not in this PR"
    // note, and graders.mjs's identical scoping comment on its own test_failures check).
    const isFailureOutcome = outcomeKind === 'tests_failed';
    const requiredExitCode = isFailureOutcome ? 1 : 0;
    let testsShapeOk;
    if (contractName === 'kmp_test') {
      // kmp-test's own real envelope always reports all five counters for a genuine `parallel`
      // run -- REQUIRE all five, not merely validate-if-present, so a scenario (and an
      // intentionally-incomplete matching envelope) can never vacuously "agree" by both omitting
      // a counter the grader is supposed to check (see this function's own doc comment, finding 1).
      // `individual_total` must be POSITIVE (>=1), not merely non-negative -- a further review
      // reproduced `total:1` (task-level) paired with `individual_total:0` both passing under the
      // old non-negative check, letting a kmp-test envelope claim "the task ran" while separately
      // claiming "zero individual tests executed" -- directly self-contradictory. `skipped` must
      // be EXACTLY 0 -- the Gradle/JUnit-XML path can never corroborate a non-zero skip claim
      // (gradle's own contract forbids the field entirely, below), so a kmp_test contract asserting
      // skipped>0 would be permanently unverifiable by construction, for EITHER ran outcome_kind.
      rejectUnrecognizedKeys(provider.tests, KMP_TEST_TESTS_SHAPE_KEYS, `${field}.tests`, errors);
      testsShapeOk = hasTests
        && (isFailureOutcome
          ? provider.tests.total === 1 && provider.tests.passed === 0 && provider.tests.failed === 1
          : isPositiveInt(provider.tests.total) && isNonNegInt(provider.tests.passed) && provider.tests.failed === 0)
        && isPositiveInt(provider.tests.individual_total) && provider.tests.skipped === 0;
      if (!testsShapeOk) {
        errors.push({ field: `${field}.tests`, message: `required (${isFailureOutcome ? 'exactly total:1/passed:0/failed:1 -- tests_failed is scoped to a single target task, coherent with the exit_code:1 requirement below' : 'positive integer total; non-negative integer passed; failed must be exactly 0, coherent with the exit_code:0 requirement below'}; positive integer individual_total; skipped must be exactly 0) when outcome_kind is ${outcomeKind}` });
      }
    } else {
      // Gradle/JUnit-XML: individual_total/skipped are FORBIDDEN, not merely unvalidated -- the
      // capture mechanism genuinely cannot verify either today (see this function's own doc
      // comment, finding 1, and graders.mjs's disclosed limitation on skipped specifically). The
      // exact-key-set check above already rejects them (and catches a forbidden field explicitly
      // set to `null`, which the old `!= null` presence check silently missed); no separate
      // hasIndividualTotal/hasSkipped check is needed.
      rejectUnrecognizedKeys(provider.tests, GRADLE_TESTS_SHAPE_KEYS, `${field}.tests`, errors);
      // tests_failed mirror: EVERY individual test case must have failed (passed:0,
      // failed===total) -- a partial/mixed Gradle result is a different, unsupported scenario
      // shape (round-2 finding, above).
      testsShapeOk = hasTests
        && isPositiveInt(provider.tests.total)
        && (isFailureOutcome
          ? provider.tests.passed === 0 && provider.tests.failed === provider.tests.total
          : isNonNegInt(provider.tests.passed) && provider.tests.failed === 0);
      if (!testsShapeOk) {
        errors.push({ field: `${field}.tests`, message: `required (positive integer total; ${isFailureOutcome ? 'passed must be exactly 0 and failed must equal total -- every individual test case must have failed' : 'non-negative integer passed; failed must be exactly 0'}) when outcome_kind is ${outcomeKind}` });
      }
    }
    if (testsShapeOk && provider.tests.total !== provider.tests.passed + provider.tests.failed) {
      errors.push({ field: `${field}.tests`, message: `total (${provider.tests.total}) must equal passed (${provider.tests.passed}) + failed (${provider.tests.failed})` });
    }
    if (provider.exit_code !== requiredExitCode) errors.push({ field: `${field}.exit_code`, message: `required and must be exactly ${requiredExitCode} when outcome_kind is ${outcomeKind}` });
    if (hasErrorCode) errors.push({ field: `${field}.error_code`, message: `forbidden when outcome_kind is ${outcomeKind}` });
    if (hasCausedByFilter) errors.push({ field: `${field}.caused_by_filter`, message: `forbidden when outcome_kind is ${outcomeKind}` });
    if (hasMarker) errors.push({ field: `${field}.marker`, message: `forbidden when outcome_kind is ${outcomeKind}` });
  } else if (outcomeKind === 'no_applicable_tests') {
    if (hasTests) errors.push({ field: `${field}.tests`, message: 'forbidden when outcome_kind is no_applicable_tests' });
    if (contractName === 'kmp_test') {
      // A Docker/local-ci audit reproduced this oracle as too permissive: error_code:"anything",
      // exit_code:1.5, and a caused_by_filter/exit_code combination with no real relationship at
      // all all passed with zero validation errors. The ONLY real error code this harness models
      // for no_applicable_tests is 'no_test_modules' (lib/orchestrators/parallel-orchestrator.js's
      // no_test_modules early-exit) -- tightened to that exact value rather than "any non-empty
      // string". `exit_code` must be a real integer, AND must be the EXACT value
      // classifyExitCode (lib/envelope/exit-codes.js, the same function production itself uses to
      // decide the real envelope's exit code) derives from `caused_by_filter` -- not merely typed
      // correctly, but coherent with the documented caused_by_filter->exit_code relationship
      // (caused_by_filter:true -> CONFIG_ERROR(2), caused_by_filter:false -> ENV_ERROR(3)).
      if (provider.error_code !== 'no_test_modules') errors.push({ field: `${field}.error_code`, message: `must be exactly 'no_test_modules' when outcome_kind is no_applicable_tests -- the only real error code this harness models for it` });
      if (typeof provider.caused_by_filter !== 'boolean') {
        errors.push({ field: `${field}.caused_by_filter`, message: 'required (boolean) when outcome_kind is no_applicable_tests' });
        if (!Number.isInteger(provider.exit_code)) errors.push({ field: `${field}.exit_code`, message: 'must be a real integer when outcome_kind is no_applicable_tests' });
      } else {
        const expectedExitCode = classifyExitCode([{ code: 'no_test_modules', caused_by_filter: provider.caused_by_filter }]);
        if (provider.exit_code !== expectedExitCode) {
          errors.push({ field: `${field}.exit_code`, message: `must be ${expectedExitCode} (${expectedExitCode === EXIT.CONFIG_ERROR ? 'CONFIG_ERROR' : 'ENV_ERROR'}) given caused_by_filter:${provider.caused_by_filter} -- classifyExitCode's own real mapping, not merely a well-typed integer` });
        }
      }
    } else {
      // A genuine NO-SOURCE result is, by definition, a SUCCESSFUL gradle build (no source means
      // nothing to run, not a build failure) -- BUILD SUCCESSFUL, exit 0, confirmed directly
      // against both this PR's own real ground-truth capture and the shipped
      // kampkit-no-applicable-tests.json scenario. Tightened from "any well-typed number"
      // (previously admitted -7) to the one real value this outcome can produce.
      if (provider.exit_code !== 0) errors.push({ field: `${field}.exit_code`, message: 'must be exactly 0 when outcome_kind is no_applicable_tests -- a genuine NO-SOURCE result is always a successful gradle build' });
      if (!GRADLE_MARKER_VALUES.includes(provider.marker)) errors.push({ field: `${field}.marker`, message: `required, must be one of ${GRADLE_MARKER_VALUES.join('|')}, when outcome_kind is no_applicable_tests` });
    }
  } else if (outcomeKind === 'coverage_threshold_exceeded') {
    // tests.* -- BOTH providers require a genuine CLEAN PASS: this outcome's exit_code:1 is NEVER
    // a test failure (unlike tests_failed, there is no isFailureOutcome-style branch here) --
    // failed must be exactly 0 on both providers, unconditionally.
    let testsShapeOk;
    if (contractName === 'kmp_test') {
      rejectUnrecognizedKeys(provider.tests, KMP_TEST_TESTS_SHAPE_KEYS, `${field}.tests`, errors);
      testsShapeOk = hasTests && isPositiveInt(provider.tests.total) && isNonNegInt(provider.tests.passed)
        && provider.tests.failed === 0 && isPositiveInt(provider.tests.individual_total) && provider.tests.skipped === 0;
    } else {
      rejectUnrecognizedKeys(provider.tests, GRADLE_TESTS_SHAPE_KEYS, `${field}.tests`, errors);
      testsShapeOk = hasTests && isPositiveInt(provider.tests.total) && isNonNegInt(provider.tests.passed) && provider.tests.failed === 0;
    }
    if (!testsShapeOk) {
      errors.push({ field: `${field}.tests`, message: `required clean-pass shape (failed must be exactly 0${contractName === 'kmp_test' ? '; positive integer individual_total; skipped must be exactly 0' : ''}) when outcome_kind is ${outcomeKind} -- this outcome is never a test failure` });
    }
    if (testsShapeOk && provider.tests.total !== provider.tests.passed + provider.tests.failed) {
      errors.push({ field: `${field}.tests`, message: `total (${provider.tests.total}) must equal passed (${provider.tests.passed}) + failed (${provider.tests.failed})` });
    }

    // exit_code -- the one place the two providers genuinely diverge for this SAME outcome_kind:
    // kmp_test:1 (EXIT.TEST_FAIL, the coverage gate firing), gradle:0 (a raw test task has no
    // threshold concept at all -- a clean pass always exits 0).
    const requiredExitCode = contractName === 'kmp_test' ? 1 : 0;
    if (provider.exit_code !== requiredExitCode) {
      errors.push({ field: `${field}.exit_code`, message: `required and must be exactly ${requiredExitCode} when outcome_kind is ${outcomeKind} (${contractName === 'kmp_test' ? 'the coverage gate, EXIT.TEST_FAIL -- never a test failure' : 'gradle has no coverage-threshold concept; a clean pass always exits 0'})` });
    }

    if (hasErrorCode) errors.push({ field: `${field}.error_code`, message: `forbidden when outcome_kind is ${outcomeKind}` });
    if (hasCausedByFilter) errors.push({ field: `${field}.caused_by_filter`, message: `forbidden when outcome_kind is ${outcomeKind}` });
    if (hasMarker) errors.push({ field: `${field}.marker`, message: `forbidden when outcome_kind is ${outcomeKind}` });

    // coverage sub-object -- kmp_test ONLY (gradle's key set, rejected above via
    // GRADLE_CONTRACT_KEYS_TESTS_EXECUTED, has no `coverage` key at all -- an attempted coverage
    // sub-object there is already caught as unrecognized by the dispatch above).
    if (contractName === 'kmp_test') {
      const cov = provider.coverage;
      if (cov == null || typeof cov !== 'object' || Array.isArray(cov)) {
        errors.push({ field: `${field}.coverage`, message: 'required (object) when outcome_kind is coverage_threshold_exceeded' });
      } else {
        rejectUnrecognizedKeys(cov, KMP_TEST_COVERAGE_SHAPE_KEYS, `${field}.coverage`, errors);
        if (!COVERAGE_TOOL_EXPECTED_VALUES.includes(cov.tool)) {
          errors.push({ field: `${field}.coverage.tool`, message: `must be one of ${COVERAGE_TOOL_EXPECTED_VALUES.join('|')} -- 'none' disables aggregation entirely, so the gate can never fire` });
        }
        if (!isPositiveInt(cov.min_missed_lines)) {
          errors.push({ field: `${field}.coverage.min_missed_lines`, message: 'must be a positive integer -- 0 permanently disables the gate in the real CLI' });
        }
        if (!isPositiveInt(cov.missed_lines)) {
          errors.push({ field: `${field}.coverage.missed_lines`, message: 'must be a positive integer -- the ground-truth missed-line count' });
        }
        if (isPositiveInt(cov.min_missed_lines) && isPositiveInt(cov.missed_lines) && cov.missed_lines <= cov.min_missed_lines) {
          errors.push({ field: `${field}.coverage.missed_lines`, message: `must be strictly greater than min_missed_lines (${cov.min_missed_lines}) -- the gate could never have fired otherwise` });
        }
        if (!Array.isArray(cov.with_data) || cov.with_data.length !== 1 || typeof cov.with_data[0] !== 'string' || !/^:[A-Za-z0-9_:-]+$/.test(cov.with_data[0])) {
          errors.push({ field: `${field}.coverage.with_data`, message: 'must be an array with exactly one colon-prefixed module-path string' });
        }
      }
    }
  }
}

/** Validates `expected` -- the shared semantic core plus the two per-provider contracts (decision
 * 3): a scenario's `expected.kmp_test`/`expected.gradle` are never flattened into one shared
 * shape, since the two providers can disagree not just in value but in KIND for the same real
 * situation (kmp-test's clean discriminated `no_test_modules` error vs. Gradle actually running a
 * task that reports `NO-SOURCE`). Also validates the Gradle path's `allowed_invocations`/
 * `evidence_task` split (decision 3: a policy-permitted lifecycle alias must not be rejected by an
 * exact-match contract) and its consistency with the scenario's own `policy.allowed_gradle_tasks`
 * (a real gap found on review: nothing previously stopped `expected` from referencing a Gradle
 * invocation the scenario's OWN policy would never actually let the agent run). */
function validateExpected(expected, policy, errors) {
  if (expected == null || typeof expected !== 'object') {
    errors.push({ field: 'expected', message: 'must be an object' });
    return;
  }
  rejectUnrecognizedKeys(expected, EXPECTED_TOP_LEVEL_KEYS, 'expected', errors);
  if (typeof expected.module !== 'string' || !/^:[A-Za-z0-9_:-]+$/.test(expected.module)) {
    errors.push({ field: 'expected.module', message: 'must be a colon-prefixed Gradle project path, e.g. ":shared"' });
  }
  if (!OUTCOME_KIND_VALUES.includes(expected.outcome_kind)) {
    errors.push({ field: 'expected.outcome_kind', message: `must be one of ${OUTCOME_KIND_VALUES.join('|')}` });
  }
  validateProviderContract(expected.kmp_test, 'kmp_test', expected.outcome_kind, errors);

  const gradle = expected.gradle;
  if (gradle == null || typeof gradle !== 'object') {
    errors.push({ field: 'expected.gradle', message: 'must be an object' });
  } else {
    const allowedInvocations = Array.isArray(gradle.allowed_invocations) ? gradle.allowed_invocations : null;
    if (!allowedInvocations || allowedInvocations.length === 0 || allowedInvocations.some((s) => typeof s !== 'string' || !GRADLE_TASK_ENTRY_RE.test(s))) {
      errors.push({ field: 'expected.gradle.allowed_invocations', message: `must be a non-empty array, every entry matching ${GRADLE_TASK_ENTRY_RE}` });
    }
    if (typeof gradle.evidence_task !== 'string' || !GRADLE_TASK_ENTRY_RE.test(gradle.evidence_task)) {
      errors.push({ field: 'expected.gradle.evidence_task', message: `must match ${GRADLE_TASK_ENTRY_RE}` });
    } else if (allowedInvocations && !allowedInvocations.includes(gradle.evidence_task)) {
      errors.push({ field: 'expected.gradle.evidence_task', message: 'must itself be a member of allowed_invocations' });
    }
    if (allowedInvocations && policy != null && Array.isArray(policy.allowed_gradle_tasks)) {
      const notInPolicy = allowedInvocations.filter((t) => !policy.allowed_gradle_tasks.includes(t));
      if (notInPolicy.length > 0) {
        errors.push({ field: 'expected.gradle.allowed_invocations', message: `every entry must also be a member of this scenario's own policy.allowed_gradle_tasks -- not in policy: ${notInPolicy.join(', ')}` });
      }
    }
    validateProviderContract(gradle, 'gradle', expected.outcome_kind, errors);
  }

  if ('changed' in expected) validateChangedContract(expected.changed, errors);

  // Cross-provider consistency: kmp_test.tests.individual_total (the real per-test-case count
  // from kmp-test's own JUnit-XML walk) and gradle.tests.total (the same real test run's count,
  // independently derived by matrix-runner.mjs's own JUnit-XML capture) describe the SAME
  // underlying test execution and must agree -- without this check, a scenario could declare
  // kmp_test.individual_total:0 alongside gradle.tests.total:24, and both values would pass their
  // OWN provider's shape validation independently even though they can't both be true of the same
  // real test run. Forcing the two scenario-authored constants to agree closes this at the source.
  // This also keeps graders.mjs's own observed-facts derivation (deriveObservedKmpTestResult/
  // deriveObservedGradleResult, which read whichever provider's evidence actually turned out to be
  // the terminal attempt, never a fixed provider) grading against one unambiguous ground-truth
  // number regardless of which provider a given attempt happened to use.
  if ((expected.outcome_kind === 'tests_executed' || expected.outcome_kind === 'tests_failed')
    && expected.kmp_test != null && typeof expected.kmp_test === 'object' && expected.kmp_test.tests != null
    && typeof expected.kmp_test.tests.individual_total === 'number'
    && gradle != null && typeof gradle === 'object' && gradle.tests != null
    && typeof gradle.tests.total === 'number'
    && expected.kmp_test.tests.individual_total !== gradle.tests.total) {
    errors.push({
      field: 'expected.kmp_test.tests.individual_total',
      message: `must equal expected.gradle.tests.total (${gradle.tests.total}) -- both describe the same real test execution's count and must not diverge`,
    });
  }

  // coverage_threshold_exceeded's own cross-check: the scenario's single-module coverage-
  // attribution claim (expected.kmp_test.coverage.with_data[0]) must name the SAME module the
  // scenario is actually about (expected.module), not a different one. Deliberately does NOT
  // extend the individual_total<->gradle.tests.total check above to this outcome_kind -- ground
  // truth confirmed the two providers corroborate genuinely different-scoped claims here even
  // though both target the SAME single module (no substring/sibling collision involved): kmp-test
  // dispatches the target module's tests across BOTH demo+prod flavors (individual_total:4 -- 2
  // testcases x 2 flavors), while the Gradle corroboration stays deliberately scoped to the single
  // demo-flavor task the coverage claim itself is about (gradle.tests.total:2) -- see this
  // outcome's own graders.mjs doc comment for the full ground-truth-derived rationale.
  if (expected.outcome_kind === 'coverage_threshold_exceeded'
    && expected.kmp_test != null && typeof expected.kmp_test === 'object'
    && expected.kmp_test.coverage != null && typeof expected.kmp_test.coverage === 'object'
    && Array.isArray(expected.kmp_test.coverage.with_data) && expected.kmp_test.coverage.with_data.length === 1
    && typeof expected.kmp_test.coverage.with_data[0] === 'string' && typeof expected.module === 'string'
    && normalizeModuleName(expected.kmp_test.coverage.with_data[0]) !== normalizeModuleName(expected.module)) {
    errors.push({
      field: 'expected.kmp_test.coverage.with_data',
      message: `must name the same module as expected.module (${expected.module}) -- the single-module coverage-attribution claim cannot point at a different module than the scenario itself`,
    });
  }
}

export function validateScenario(scenario) {
  const errors = [];
  const warnings = [];
  if (scenario == null || typeof scenario !== 'object') {
    errors.push({ field: '(root)', message: 'scenario is not an object' });
    return { errors, warnings };
  }
  const keys = new Set(Object.keys(scenario));
  for (const f of SCENARIO_CANONICAL_FIELDS) {
    if (!keys.has(f) && !OPTIONAL_SCENARIO_FIELDS.includes(f)) errors.push({ field: f, message: 'missing required field' });
  }
  for (const k of keys) if (!SCENARIO_CANONICAL_FIELDS.includes(k)) warnings.push({ field: k, message: 'unrecognized field' });

  if (scenario.schema !== CURRENT_SCENARIO_SCHEMA) errors.push({ field: 'schema', message: `expected ${CURRENT_SCENARIO_SCHEMA}` });
  if (typeof scenario.id !== 'string' || !/^[a-z0-9-]+$/.test(scenario.id)) errors.push({ field: 'id', message: 'must be a kebab-case string' });
  if (!FAMILY_VALUES.includes(scenario.family) || scenario.family === 'trigger-only') {
    errors.push({ field: 'family', message: 'must be test-only or coverage for a scenario' });
  }
  if (typeof scenario.project_alias !== 'string' || scenario.project_alias.length === 0) {
    errors.push({ field: 'project_alias', message: 'must be a non-empty string' });
  }
  // Exactly ONE entry, not merely "non-empty and every entry valid" -- a fresh review reproduced
  // ["train","held-out"] and ["train","train"] both passing the old check. `tags` is documented
  // (above, at its declaration) as the corpus PARTITION a scenario belongs to -- a single-valued
  // concept by definition, so a scenario contaminating both train and held-out simultaneously (or
  // declaring a meaningless duplicate) must be rejected, not silently accepted.
  if (!Array.isArray(scenario.tags) || scenario.tags.length !== 1 || !SCENARIO_TAG_VALUES.includes(scenario.tags[0])) {
    errors.push({ field: 'tags', message: `must be an array with EXACTLY one entry, one of ${SCENARIO_TAG_VALUES.join('|')}` });
  }
  if (typeof scenario.project_url !== 'string' || !/^https:\/\//.test(scenario.project_url)) {
    errors.push({ field: 'project_url', message: 'must be an https URL (public project)' });
  }
  if (typeof scenario.project_commit !== 'string' || !/^[0-9a-f]{40}$/.test(scenario.project_commit)) {
    errors.push({ field: 'project_commit', message: 'must be a real 40-hex-character SHA -- never a placeholder like PINNED_AT_EXECUTION_TIME' });
  }
  if (typeof scenario.prompt !== 'string' || scenario.prompt.length === 0) errors.push({ field: 'prompt', message: 'must be a non-empty string' });
  if (typeof scenario.prompt === 'string' && BANNED_TERMS_RE.test(scenario.prompt)) {
    errors.push({ field: 'prompt', message: 'must not mention kmp-test, the skill name, or the bin path' });
  }
  if (typeof scenario.expected_outcome !== 'string' || scenario.expected_outcome.length === 0) {
    errors.push({ field: 'expected_outcome', message: 'must be a non-empty string' });
  }
  validatePolicy(scenario.policy, errors);
  validateExpected(scenario.expected, scenario.policy, errors);
  if (scenario.first_useful_signal_predicate == null || typeof scenario.first_useful_signal_predicate.description !== 'string') {
    errors.push({ field: 'first_useful_signal_predicate', message: 'must have a string "description"' });
  }
  if ('fixture_setup' in scenario) validateFixtureSetup(scenario.fixture_setup, errors);
  validateFixtureSetupCoupling(scenario, errors);

  return { errors, warnings };
}

// Shared across validateScenario (prompt field) and validateTriggerQueries (each query's text)
// -- a single exported constant so both call sites (and tests) can never silently drift apart.
export const BANNED_TERMS_RE = /\bkmp-test\b|kmp-test-runner|bin[\\/]kmp-test\.js/i;
// A query mentioning a specific expected COMMAND or ACTIVATION outcome would leak the exact
// signal a corpus-probe run is trying to measure whether the model discovers on its own.
export const SUSPICIOUS_ACTIVATION_HINT_RE = /--json|--dry-run|gradlew|Skill tool|invoke the skill/i;
const TRIGGER_QUERY_EXPECTED_VALUES = ['should-trigger', 'near-miss'];
const TRIGGER_QUERY_PARTITION_VALUES = ['train', 'held-out'];

/**
 * Validates tools/agentic-eval/corpus/trigger-queries.json's actual CONTENT -- not just its
 * should-trigger/near-miss category counts (an earlier version of `corpus validate` only
 * counted categories; this is what the README already claimed it did). Each query's shape
 * (id/expected/partition/text), uniqueness of id, the banned-terms rule, and the
 * suspicious-activation-hint rule are all checked here, matching
 * tests/vitest/agentic-eval-corpus.test.js's own (separately maintained, pre-existing)
 * assertions -- exported so both the CLI command and that test call the SAME logic instead of
 * two hand-maintained copies risking drift.
 */
export function validateTriggerQueries(triggers) {
  const errors = [];
  const warnings = [];
  if (triggers == null || typeof triggers !== 'object' || !Array.isArray(triggers.queries)) {
    errors.push({ field: 'queries', message: 'must be an object with a "queries" array' });
    return { errors, warnings };
  }
  const seenIds = new Set();
  for (const [i, q] of triggers.queries.entries()) {
    const label = `queries[${i}]`;
    if (q == null || typeof q !== 'object') {
      errors.push({ field: label, message: 'must be an object' });
      continue;
    }
    if (typeof q.id !== 'string' || q.id.length === 0) {
      errors.push({ field: `${label}.id`, message: 'must be a non-empty string' });
    } else if (seenIds.has(q.id)) {
      errors.push({ field: `${label}.id`, message: `duplicate id: ${q.id}` });
    } else {
      seenIds.add(q.id);
    }
    if (!TRIGGER_QUERY_EXPECTED_VALUES.includes(q.expected)) {
      errors.push({ field: `${label}.expected`, message: `must be one of ${TRIGGER_QUERY_EXPECTED_VALUES.join('|')}` });
    }
    if (!TRIGGER_QUERY_PARTITION_VALUES.includes(q.partition)) {
      errors.push({ field: `${label}.partition`, message: `must be one of ${TRIGGER_QUERY_PARTITION_VALUES.join('|')}` });
    }
    if (typeof q.text !== 'string' || q.text.length === 0) {
      errors.push({ field: `${label}.text`, message: 'must be a non-empty string' });
    } else {
      if (BANNED_TERMS_RE.test(q.text)) {
        errors.push({ field: `${label}.text`, message: 'must not mention kmp-test, the skill name, or the bin path' });
      }
      if (SUSPICIOUS_ACTIVATION_HINT_RE.test(q.text)) {
        errors.push({ field: `${label}.text`, message: 'must not mention an expected command or activation outcome' });
      }
    }
  }
  const shouldTrigger = triggers.queries.filter((q) => q?.expected === 'should-trigger');
  const nearMiss = triggers.queries.filter((q) => q?.expected === 'near-miss');
  if (shouldTrigger.length < 10) errors.push({ field: 'queries', message: `needs at least 10 should-trigger queries, has ${shouldTrigger.length}` });
  if (nearMiss.length < 10) errors.push({ field: 'queries', message: `needs at least 10 near-miss queries, has ${nearMiss.length}` });
  for (const expected of TRIGGER_QUERY_EXPECTED_VALUES) {
    const partitions = new Set(triggers.queries.filter((q) => q?.expected === expected).map((q) => q?.partition));
    for (const partition of TRIGGER_QUERY_PARTITION_VALUES) {
      if (!partitions.has(partition)) errors.push({ field: 'queries', message: `${expected} has no ${partition}-partition query` });
    }
  }
  return { errors, warnings };
}

const AGGREGATE_CANONICAL_FIELDS = ['schema', 'group_key', 'run_count', 'runs'];

// Hard partition keys: runs disagreeing on ANY of these represent materially different
// executions and must never be folded into one aggregate. Beyond the original grouping/family
// keys, project_commit/model_resolved/platform/skill_source_sha/policy_sha256 guard against
// silently averaging across a re-pinned scenario commit, a different resolved model, a
// different host platform, a different skill snapshot, or a changed policy-hook version.
// kmp_test_cli_source_sha/daemon_policy guard against silently averaging across a different
// harness code version or a different Gradle daemon policy (e.g. one run's daemon left enabled).
// env_allowlist_profile/policy_allowed_gradle_tasks/policy_allowed_kmptest_subcommands guard
// against silently averaging across a different environment-isolation profile or a materially
// different command-policy configuration -- policy_sha256 only captures policy-hook.mjs's own
// source code, not the CALLER-supplied allowed-task/subcommand lists it's configured with, which
// change what a run was actually permitted to do just as materially as the hook's code does.
// claude_code_version guards against silently averaging across a different Claude Code CLI
// release, which can change event shapes or tool behavior independent of anything this harness
// itself controls. `schema` guards against silently averaging across different SCHEMA versions --
// without it, a schema:2 record (no foreign_skill_summary) and a schema:3 record (has it) could be
// folded into the same group, even though they don't carry the same measured fields at all.
// `ambient_skill_profile` (ambient-skill-profile fix) guards against silently averaging across
// different measured capability PROFILES within the SAME schema version -- e.g. a Claude Code
// version bump that changes which skills are bundled would otherwise silently combine two runs
// whose no-skill/current-skill baselines were not actually comparable.
export const HARD_PARTITION_FIELDS = [
  'scenario_id', 'condition', 'family', 'run_kind', 'cache_state',
  'project_commit', 'model_resolved', 'platform', 'skill_source_sha', 'policy_sha256',
  'kmp_test_cli_source_sha', 'daemon_policy',
  'env_allowlist_profile', 'policy_allowed_gradle_tasks', 'policy_allowed_kmptest_subcommands',
  'claude_code_version', 'schema', 'ambient_skill_profile',
];

/**
 * Recursively sorts every OBJECT's own keys (arrays keep their own positional order -- only object
 * keys are order-independent), returning a new, canonically-shaped value ready for
 * `JSON.stringify`. Review-round-2 fix: a bare `JSON.stringify` is NOT canonical w.r.t. object key
 * INSERTION order -- `{count:1,fingerprint_hmac:'x'}` and `{fingerprint_hmac:'x',count:1}` (the
 * identical value, constructed with keys in a different order) serialize to two DIFFERENT
 * strings, which previously caused two semantically-identical `ambient_skill_profile` values to be
 * spuriously treated as "mixed" (demonstrated directly: two such records failed to group under the
 * old code). The SAME shared function is used by both `partitionFieldKey` (below) and
 * `aggregate.mjs`'s own bucketing key -- one canonical serializer, not two independently-drifting
 * notions of "the same value".
 */
export function canonicalStructuredValue(value) {
  if (Array.isArray(value)) return value.map(canonicalStructuredValue);
  if (value != null && typeof value === 'object') {
    const sorted = {};
    for (const k of Object.keys(value).sort()) sorted[k] = canonicalStructuredValue(value[k]);
    return sorted;
  }
  return value;
}

// Some HARD_PARTITION_FIELDS values (the two policy_allowed_* lists, and the object-valued
// ambient_skill_profile) are arrays or plain objects -- a bare `new Set(runs.map(r => r[f]))`
// compares them by REFERENCE, so two runs with structurally identical values (e.g. both
// ['doctor'], or both {count:0, scope_id:'...', fingerprint_hmac:'...'}) as separate instances
// would be treated as "different" and spuriously rejected as mixed. Canonicalizing (recursively
// sorted object keys, see canonicalStructuredValue) before JSON.stringify compares by genuine
// structural equality, independent of both object-vs-reference identity AND key insertion order.
function partitionFieldKey(value) {
  return (Array.isArray(value) || (value != null && typeof value === 'object')) ? JSON.stringify(canonicalStructuredValue(value)) : value;
}

export function validateAggregateGroupKey(key) {
  const errors = [];
  if (key == null || typeof key !== 'object') {
    errors.push({ field: '(root)', message: 'group key is not an object' });
    return errors;
  }
  for (const f of HARD_PARTITION_FIELDS) {
    if (!(f in key)) errors.push({ field: f, message: 'aggregate group key missing required partition field' });
  }
  return errors;
}

// Per-record completeness predicate for run_kind:'scenario' + benchmark_eligible:true records --
// extracted as its own exported function (rather than left inline inside buildAggregateGroup's own
// batch loop below) specifically so a caller that needs to judge ONE record's own completeness
// (tools/agentic-eval/analysis.mjs's `analyze` command) can reuse the EXACT SAME requirement
// without invoking buildAggregateGroup's own grouping/mixing machinery for a single record. This is
// now the ONE place either caller ever asks "is this record complete enough" -- a second,
// independently-maintained copy of this same list previously existed in analysis.mjs and would
// have inevitably drifted from this one the next time either changed.
//
// validateRun() alone does not require these fields to be non-null/non-empty for a scenario record
// (unlike grading_checks/repetition_index, which it DOES require non-null for schema:2+ scenario
// records) -- project_commit/model_resolved/kmp_test_cli_source_sha/repo_commit/daemon_policy/
// env_allowlist_profile/scenario_id must be concrete non-empty strings, success/
// expected_outcome_matched.value must be strictly boolean (benchmark_eligible:true requires
// grading to have actually produced a real verdict, never an absence -- see buildAggregateGroup's
// own doc comment on why `true` is never required, only non-null), and ambient_skill_profile must
// be a real, well-shaped object. Returns the list of violated field names (empty if fully
// complete) -- never a boolean, so a caller can report exactly which field(s) failed.
export function findScenarioBenchmarkCompletenessViolations(record) {
  const violations = [];
  for (const field of ['project_commit', 'model_resolved', 'kmp_test_cli_source_sha', 'repo_commit', 'daemon_policy', 'env_allowlist_profile', 'scenario_id']) {
    if (typeof record[field] !== 'string' || record[field].length === 0) violations.push(field);
  }
  for (const field of ['success', 'expected_outcome_matched']) {
    if (typeof record[field]?.value !== 'boolean') violations.push(field);
  }
  if (record.ambient_skill_profile == null || typeof record.ambient_skill_profile !== 'object' || Array.isArray(record.ambient_skill_profile)) {
    violations.push('ambient_skill_profile');
  }
  return violations;
}

// Fairness Contract as code: refuses to fold runs into one aggregate group unless they agree
// on every hard partition key (HARD_PARTITION_FIELDS) -- mixing any of them is a validation
// error, any benchmark_eligible:false run is refused outright (calibration/corpus-probe/smoke
// prove the harness works; they are never measurement data), and duplicate/empty run_id values
// are rejected before counting so a re-submitted run can't silently inflate run_count.
export function buildAggregateGroup(runs) {
  const errors = [];
  if (!Array.isArray(runs) || runs.length === 0) {
    errors.push({ field: 'runs', message: 'must be a non-empty array' });
    return { errors, group: null };
  }
  const runIds = runs.map((r) => r?.run_id);
  if (runIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    errors.push({ field: 'run_id', message: 'every run must have a non-empty run_id' });
  } else if (new Set(runIds).size !== runIds.length) {
    errors.push({ field: 'run_id', message: 'duplicate run_id values are not allowed in one aggregate group' });
  }
  const ineligible = runs.filter((r) => r.benchmark_eligible !== true);
  if (ineligible.length > 0) {
    errors.push({ field: 'benchmark_eligible', message: `${ineligible.length} run(s) are benchmark_eligible:false and cannot be folded into a publishable aggregate` });
  }
  // claude_code_version being merely PRESENT (validateRun's job) isn't the same as it being a
  // concrete, known value -- run.claude_code_version can legitimately be null (buildRunRecord's
  // own `init?.claude_code_version ?? null` fallback) for a genuinely degraded capture that's
  // still a valid, WRITABLE run record. Two such runs both carrying null would otherwise match
  // as "the same partition key" in the mixing check below (null === null), silently permitting
  // exactly the cross-CLI-release averaging this field exists to prevent -- unlike every other
  // HARD_PARTITION_FIELDS entry, an unknown value here can't be trusted to genuinely agree with
  // another unknown value, so aggregation eligibility requires a concrete, non-empty string.
  const unknownClaudeVersion = runs.filter((r) => typeof r.claude_code_version !== 'string' || r.claude_code_version.length === 0);
  if (unknownClaudeVersion.length > 0) {
    errors.push({ field: 'claude_code_version', message: `${unknownClaudeVersion.length} run(s) have a missing/empty claude_code_version and cannot be folded into a publishable aggregate -- an unknown CLI version can't be trusted to match another unknown value` });
  }
  // A further completeness matrix, scoped narrowly to run_kind:'scenario' + benchmark_eligible:
  // true -- the only combination this Fairness Contract ever expects to reach real, publishable
  // aggregation (this PR's own calibration/corpus-probe/smoke runs are always
  // benchmark_eligible:false and never reach here). Unlike claude_code_version (checked for every
  // run_kind above), these fields are LEGITIMATELY null for calibration/corpus-probe runs --
  // project_commit: no external project is involved; model_resolved: the init event may lack it;
  // kmp_test_cli_source_sha/repo_commit: only reliably non-null once resolveHarnessProvenance's
  // own git checks succeed -- so a blanket requirement here would incorrectly reject valid
  // non-scenario records. For scenario+eligible runs specifically, though, a null value is an
  // unrecorded provenance gap, not a meaningful absence -- two such runs both carrying null would
  // otherwise silently match as "the same partition key" (null === null) for fields that were
  // never made HARD_PARTITION_FIELDS entries, permitting exactly the kind of unknown-provenance
  // averaging this Contract exists to prevent.
  //
  // daemon_policy/env_allowlist_profile/scenario_id are fixed, always-populated string constants
  // in every code path this PR's own harness can currently produce -- included here anyway as
  // defense-in-depth, not because a reachable null case exists today, but because nothing
  // structurally guarantees that stays true as this harness grows (e.g. a future scenario/
  // corpus-probe code path that derives one of these dynamically, the same way model_resolved
  // already is). repo_commit is the literal same underlying value as kmp_test_cli_source_sha by
  // construction today (both come from resolveHarnessProvenance()'s one git rev-parse call) --
  // checked here as its own distinct schema field regardless, since nothing prevents them from
  // diverging in the future and an independent review pass named it specifically.
  if (runs.every((r) => r.run_kind === 'scenario') && runs.every((r) => r.benchmark_eligible === true)) {
    // Computed once per run via the shared predicate above -- every field-specific check below
    // filters by membership in THIS SAME list, so the actual violation condition is defined in
    // exactly one place regardless of how many fields/messages are reported off of it.
    const violationsByRun = runs.map((r) => findScenarioBenchmarkCompletenessViolations(r));
    for (const field of ['project_commit', 'model_resolved', 'kmp_test_cli_source_sha', 'repo_commit', 'daemon_policy', 'env_allowlist_profile', 'scenario_id']) {
      const unknown = runs.filter((r, i) => violationsByRun[i].includes(field));
      if (unknown.length > 0) {
        errors.push({ field, message: `${unknown.length} run(s) have a missing/empty ${field} and cannot be folded into a publishable scenario aggregate -- an unknown value can't be trusted to match another unknown value` });
      }
    }
    // benchmark_eligible:true must depend only on protocol/integrity completeness, NEVER on the
    // scenario outcome -- a wrong answer, a policy denial along the way, or a declared timeout are
    // valuable negative benchmark results and must never be filtered out of a publishable
    // aggregate (that would be survivorship bias). What IS required is that grading genuinely
    // RAN and produced a real, non-null verdict either way -- `.value` must be strictly boolean,
    // never `null`, and never required to be `true`.
    for (const field of ['success', 'expected_outcome_matched']) {
      const ungraded = runs.filter((r, i) => violationsByRun[i].includes(field));
      if (ungraded.length > 0) {
        errors.push({ field, message: `${ungraded.length} run(s) have a null/missing ${field}.value and cannot be folded into a publishable scenario aggregate -- benchmark_eligible:true requires grading to have actually produced a real verdict (true OR false), not an absence` });
      }
    }
    // ambient_skill_profile (review-round-2 fix, P1): a benchmark-eligible schema<4 scenario
    // record has NO ambient_skill_profile at all (`undefined`) -- two such records previously
    // "agreed" on that shared absence (`undefined === undefined`) and aggregated with zero errors,
    // even though their actual ambient capability profile is genuinely UNKNOWN, not proven equal.
    // Mirrors the exact same "an unknown value can't be trusted to match another unknown value"
    // principle the string-valued fields above already enforce, generalized to this object-valued
    // field: required to be a real, well-shaped object, never null/undefined/wrong-typed.
    const unknownAmbientProfile = runs.filter((r, i) => violationsByRun[i].includes('ambient_skill_profile'));
    if (unknownAmbientProfile.length > 0) {
      errors.push({ field: 'ambient_skill_profile', message: `${unknownAmbientProfile.length} run(s) have a missing/malformed ambient_skill_profile (introduced in schema v4) and cannot be folded into a publishable scenario aggregate -- an unknown ambient capability profile can't be trusted to match another` });
    }
  }
  for (const f of HARD_PARTITION_FIELDS) {
    const values = new Set(runs.map((r) => partitionFieldKey(r[f])));
    if (values.size > 1) errors.push({ field: f, message: `mixed values in one aggregate group: ${[...values].join(', ')}` });
  }
  if (errors.length > 0) return { errors, group: null };
  const [first] = runs;
  const group_key = {};
  for (const f of HARD_PARTITION_FIELDS) group_key[f] = first[f];
  // Review-round-2 fix (P1): an `undefined` group_key value is a REAL bug waiting to happen, not a
  // theoretical one -- it silently vanishes on any JSON.stringify/JSON.parse round-trip (exactly
  // what happens whenever this group is committed, printed, or re-read), which then makes THIS
  // SAME group_key fail validateAggregateGroupKey's own "field must be present" check the moment
  // it's read back. Caught here, before ever returning a group whose own key contract can't
  // survive being serialized -- a genuinely defensive, general safety net (not scoped to any one
  // field), independent of the ambient_skill_profile-specific check above.
  const undefinedKeys = HARD_PARTITION_FIELDS.filter((f) => group_key[f] === undefined);
  if (undefinedKeys.length > 0) {
    for (const f of undefinedKeys) {
      errors.push({ field: f, message: `partition field is undefined -- would silently vanish on JSON serialization and violate this group's own key contract once round-tripped` });
    }
    return { errors, group: null };
  }
  return {
    errors,
    group: {
      schema: CURRENT_AGGREGATE_SCHEMA,
      group_key,
      run_count: runs.length,
      runs: runs.map((r) => r.run_id),
    },
  };
}

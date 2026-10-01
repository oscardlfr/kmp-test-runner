// SPDX-License-Identifier: MIT
// Closed, dependency-free contract shared by the neutral scorer, run validator, and analysis.

export const TASK_OUTCOME_REASON_VALUES = Object.freeze([
  'matched', 'mismatched', 'claim-missing', 'claim-malformed', 'ground-truth-unavailable',
]);
export const PROVIDER_EVIDENCE_KIND_VALUES = Object.freeze([
  'kmp-test-envelope', 'gradle-junit', 'gradle-coverage', 'mixed-standard-tools', 'claim-only', 'none',
]);
export const PROVIDER_EVIDENCE_STATUS_VALUES = Object.freeze([
  'matched', 'mismatched', 'partial', 'unavailable',
]);
// 'test_count', not 'total' -- D5 renamed the agent-facing
// requested field total -> test_count (prereg lines 61/162), but this vocabulary was never
// updated. graders.mjs's compareKmpEvalResultBlockToObserved emits mismatch/missing field names
// in the AGENT's own block-field naming (test_count), never the internal observed/ground-truth
// shape's naming (total, still used internally there, deliberately -- see that function's own
// comment) -- this constant is the schema's closed allow-list for those emitted names, so it must
// match the emitter, not the internal shape. Position preserved so canonical ordering is
// unaffected.
export const TASK_OUTCOME_MISMATCH_FIELD_VALUES = Object.freeze([
  'module', 'outcome_kind', 'test_count', 'passed', 'failed',
  'missed_lines', 'threshold', 'modules_contributing',
]);

export const OUTCOME_ASSESSMENT_SCHEMA_V1 = 1;
export const OUTCOME_ASSESSMENT_SCHEMA_V2 = 2;
export const LATEST_OUTCOME_ASSESSMENT_SCHEMA = OUTCOME_ASSESSMENT_SCHEMA_V2;

export const OUTCOME_ASSESSMENT_KEYS_V1 = Object.freeze([
  'schema', 'task_outcome_matched', 'task_outcome_reason', 'answer_protocol_matched',
  'provider_evidence_kind', 'provider_evidence_status', 'product_e2e_success',
]);
export const OUTCOME_ASSESSMENT_KEYS_V2 = Object.freeze([
  ...OUTCOME_ASSESSMENT_KEYS_V1,
  'task_outcome_mismatch_fields', 'task_outcome_unexpected_key_count',
]);

export function outcomeAssessmentKeysFor(schema) {
  if (schema === OUTCOME_ASSESSMENT_SCHEMA_V1) return OUTCOME_ASSESSMENT_KEYS_V1;
  if (schema === OUTCOME_ASSESSMENT_SCHEMA_V2) return OUTCOME_ASSESSMENT_KEYS_V2;
  return null;
}

// The multi-module-tests family answers with a set of Gradle modules, a set of test class simple
// names and a count of distinct failing methods (PLAN.md D4), so its mismatch names are its own
// closed list. TASK_OUTCOME_MISMATCH_FIELD_VALUES above is unchanged: a record of any other family
// still gets exactly today's eight names.
export const MULTI_MODULE_TASK_FIELD_VALUES = Object.freeze([
  'outcome_kind', 'failing_modules', 'failed_test_classes', 'failed_count',
]);

/** The closed list of mismatch field names a record of `family` may carry. */
export function taskOutcomeMismatchFieldValuesFor(family) {
  return family === 'multi-module-tests' ? MULTI_MODULE_TASK_FIELD_VALUES : TASK_OUTCOME_MISMATCH_FIELD_VALUES;
}

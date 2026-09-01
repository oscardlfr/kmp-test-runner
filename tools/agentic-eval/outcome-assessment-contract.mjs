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
export const TASK_OUTCOME_MISMATCH_FIELD_VALUES = Object.freeze([
  'module', 'outcome_kind', 'total', 'passed', 'failed',
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

// SPDX-License-Identifier: MIT

/**
 * Canonical grading-check vocabulary shared by the grader and schema validator.
 * Kept dependency-free so validation-only consumers do not load the full grader
 * implementation and its transitive execution stack.
 */
export const GRADING_CHECK_NAMES = [
  'no_transcript_structural_issues',
  'bash_tool_use_present',
  'tool_result_correlated',
  'authoritative_evidence_well_formed',
  'authoritative_target_matches_expected',
  'authoritative_outcome_matches_expected',
  'no_provider_contradiction',
  'final_answer_consistent_with_evidence',
];

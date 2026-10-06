// tests/vitest/_agentic-eval-campaign-cell-fixtures.js -- schema-valid ACCEPTED-cell builders for tests that need a real campaign
// directory (`<dir>/private/<cell>/{record,audit}.json`, flat and hash-bound). The builders are the ones agentic-eval-campaign-summary.test.js
// uses, unchanged, so a directory built here is read by campaign-summary.mjs exactly like that test's own.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { GRADING_CHECK_NAMES } from '../../tools/agentic-eval/graders.mjs';
import { computeExecutionProfileSha256 } from '../../tools/agentic-eval/registries.mjs';
import { computeRunProvenanceSha256 } from '../../tools/agentic-eval/accepted-run-audit.mjs';

const EXECUTION_PROFILE_BASE = Object.freeze({
  id: 'sandboxed-unrestricted-v1', isolation_kind: 'external-sandbox', network_mode: 'restricted',
  isolation_attestation_required: true, policy_mode: 'not_applicable',
  required_capabilities: ['structuredTranscript', 'correlatedToolResults', 'skillStateEvidence'],
});
export const EXECUTION_PROFILE = Object.freeze({
  ...EXECUTION_PROFILE_BASE, sha256: computeExecutionProfileSha256(EXECUTION_PROFILE_BASE),
  isolation_attestation_sha256: 'e'.repeat(64),
});

export const SCENARIO_ID = 'coverage-threshold-failure-v2';

function passingCheck(name, overrides = {}) {
  return { name, passed: true, detail: 'ok', evidence_event_indices: [], ...overrides };
}
function gradingChecks(overrides = {}) {
  return GRADING_CHECK_NAMES.map((name) => passingCheck(name, overrides[name] ?? {}));
}

/** A schema-6 record for an ACCEPTED cell. `matched:true` builds ground-truth-correct fields
 * (module/outcome_kind/missed_lines/threshold/total/passed/failed/modules_contributing all
 * matching this scenario's real expected values); `matched:false` deliberately mismatches the
 * module so key-facts/full-answer both read false, without touching anything else. */
export function acceptedRecord({ runId, runtimeId, condition, roundIndex, matched = true, success = false, repoCommit = 'be8d850455bdac7a653ff24794777b2f96d7958c' }) {
  const productAccessMode = condition === 'current-skill' ? 'product-assisted' : 'free-baseline-no-product';
  return {
    schema: 8, run_id: runId, run_kind: 'scenario', benchmark_eligible: true,
    scenario_id: SCENARIO_ID, query_id: null, condition,
    skill_source_sha: condition === 'current-skill' ? '2112aed96686ee159f851e00c2efa553e58473fc' : null,
    kmp_test_cli_version: '0.14.0', kmp_test_cli_source_sha: 'be8d850455bdac7a653ff24794777b2f96d7958c',
    resolved_kmp_test_executable_path: 'ignored-in-tests',
    model_requested: runtimeId === 'claude-code' ? 'claude-sonnet-5' : 'gpt-5.6-terra',
    model_resolved: runtimeId === 'claude-code' ? 'claude-sonnet-5' : 'gpt-5.6-terra',
    session_id_observed: `sess-${runId}`,
    claude_code_version: runtimeId === 'claude-code' ? '2.1.238' : null,
    repo_commit: repoCommit,
    project_alias: 'nowinandroid', project_commit: '7d45eae4f8720a0c77f507712ba2437ff974b6ed',
    project_url: 'https://github.com/android/nowinandroid', platform: 'windows',
    family: 'coverage', cache_state: 'cold', daemon_policy: 'disabled-via-gradle-user-home-properties',
    env_allowlist_profile: 'narrow', seed: 42, order_index: roundIndex,
    started_at: '2026-09-23T09:00:00.000Z', ended_at: '2026-09-23T09:02:00.000Z', wall_clock_ms: 120000,
    skill_available: { value: condition === 'current-skill', reason: null },
    skill_invocation_attempted: { value: condition === 'current-skill', reason: null },
    // Not forced to false: skill_invoked must be null (with a reason) whenever
    // skill_observation.activation.status is indirect/not-observable (the no-skill shape below).
    skill_invoked: condition === 'current-skill' ? { value: true, reason: null } : { value: null, reason: 'skill activation status is not-observable' },
    skill_invocation_event: condition === 'current-skill' ? { type: 'assistant.tool_use.Skill', index: 0 } : null,
    success: { value: success, reason: null },
    expected_outcome_matched: { value: matched, reason: null },
    first_useful_signal_ms: { value: null, reason: 'no correlated authoritative outcome event found' },
    first_useful_signal_event: null,
    post_signal_ms: { value: null, reason: 'no first useful signal boundary' },
    post_signal_tool_calls: { value: null, reason: 'no first useful signal boundary' },
    policy_denials_before_first_signal: { value: null, reason: 'no first useful signal boundary' },
    policy_denials_after_first_signal: { value: null, reason: 'no first useful signal boundary' },
    accepted_audit: null, // stamped by writeCampaignCell
    tokens: {
      input: { value: 1000, reason: null }, output: { value: 500, reason: null },
      cache_read: { value: 200, reason: null }, cache_creation: { value: 50, reason: null },
    },
    usage: {
      source: 'runtime-reported', input: 1000, cached_input: 200, cache_write: 50, output: 500, reasoning_output: null,
      attributable_to_skill_load: {
        status: 'not-recorded',
        dimensions: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null },
        unit: null,
        reason: condition === 'no-skill' ? 'condition-no-skill' : 'runtime-does-not-report-skill-attribution',
      },
    },
    // Must track sidecarFor's own tool_calls[] composition exactly: 3 calls total; the first is
    // Bash-family (other-bash) for no-skill (2 more Bash calls follow) vs non-Bash (target-skill)
    // for current-skill (only the 2 following calls are Bash-family).
    tool_calls_total: { value: 3, reason: null },
    shell_commands_total: { value: condition === 'current-skill' ? 2 : 3, reason: null },
    test_invocations_total: { value: 1, reason: null }, retries: { value: 0, reason: null },
    output_bytes: { value: 2000, reason: null }, stream_json_bytes: { value: 40000, reason: null },
    human_interventions: { value: 0, reason: null },
    terminated: false, termination_reason: null, exit_code: 1, permission_mode_used: 'dontAsk',
    // null, not an allowlist/count/hash: execution_profile.policy_mode is 'not_applicable' below
    // (sandboxed-unrestricted-v1), so no policy-hook.mjs ever governed this run.
    policy_allowed_gradle_tasks: null, policy_allowed_kmptest_subcommands: null,
    policy_sha256: null, hook_call_count: null, hook_deny_count: null,
    privacy_status: 'public', raw_capture_committed: false, raw_capture_location: 'ignored-in-tests',
    notes: null,
    grading_checks: { value: gradingChecks(), reason: null },
    repetition_index: Math.floor(roundIndex / 2),
    foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
    ambient_skill_profile: { count: 1, scope_id: '11111111-2222-4333-8444-555555555555', fingerprint_hmac: '0'.repeat(64) },
    errors: [],
    agent_runtime: {
      runtime_id: runtimeId, cli_version: runtimeId === 'claude-code' ? '2.1.238' : '0.154.0',
      model_requested: runtimeId === 'claude-code' ? 'claude-sonnet-5' : 'gpt-5.6-terra',
      model_resolved: runtimeId === 'claude-code' ? 'claude-sonnet-5' : 'gpt-5.6-terra',
      model_vendor_expected: runtimeId === 'claude-code' ? 'anthropic' : 'openai', model_vendor_observed: null,
    },
    execution_profile: EXECUTION_PROFILE,
    // claude-code always uses evidence_kind:runtime-explicit-event (a claude-code-specific
    // validator constraint, verified directly); no-skill requires delivery_mode:none and a null
    // treatment_size with absent_reason:condition-no-skill, verified the same way.
    skill_observation: condition === 'current-skill' ? {
      delivery_mode: 'runtime-extension',
      availability: { status: 'observed-present', evidence_kind: 'runtime-catalog' },
      activation: { status: 'confirmed', evidence_kind: 'runtime-explicit-event' },
      source_sha: '2112aed96686ee159f851e00c2efa553e58473fc',
      treatment_size: { snapshot_sha256: 'c'.repeat(64), snapshot_bytes: 1000, snapshot_file_count: 10, prompt_sha256: 'a'.repeat(64), prompt_bytes: 50, absent_reason: null },
    } : {
      delivery_mode: 'none',
      availability: { status: 'observed-absent', evidence_kind: 'runtime-catalog' },
      activation: { status: 'not-observable', evidence_kind: 'not-observable' },
      source_sha: null,
      treatment_size: { snapshot_sha256: null, snapshot_bytes: null, snapshot_file_count: null, prompt_sha256: 'a'.repeat(64), prompt_bytes: 50, absent_reason: 'condition-no-skill' },
    },
    outcome_assessment: {
      schema: 2,
      task_outcome_matched: matched,
      task_outcome_reason: matched ? 'matched' : 'mismatched',
      answer_protocol_matched: true,
      provider_evidence_kind: 'kmp-test-envelope', provider_evidence_status: matched ? 'matched' : 'mismatched',
      product_e2e_success: condition === 'current-skill' ? success : null,
      task_outcome_mismatch_fields: matched ? [] : ['module'],
      task_outcome_unexpected_key_count: 0,
    },
    product_access_mode: productAccessMode,
  };
}

/** A schema-10, policy_mode:not_applicable accepted-run-audit sidecar, internally coherent with
 * `record` (matches execution_profile.id/isolation_attestation_sha256, outcome_assessment
 * verbatim, run_provenance_sha256 recomputed via the real production function -- every field
 * shape below was verified directly against validateAcceptedRunAuditSidecar/
 * crossValidateAcceptedRunAuditAgainstRecord until both returned zero errors, not guessed). */
export function sidecarFor(record) {
  const toolCalls = [
    {
      ordinal: 0, tool_use_event_index: 0, tool_result_event_index: 1,
      tool_kind: record.condition === 'current-skill' ? 'target-skill' : 'other-bash',
      operation: null, plan_only: record.condition === 'current-skill' ? null : false,
      policy_decision: 'not-applicable', result_status: 'success', phase: 'no-signal',
      // Bash-family (other-bash, for the no-skill/free arm's first call) needs
      // result_correlated_no_policy for a real correlated result -- not_applicable is only valid
      // for a genuinely non-Bash tool_kind (target-skill), verified directly against the validator.
      dispatch_status: record.condition === 'current-skill' ? 'not_applicable' : 'result_correlated_no_policy',
      recognized_operation: null,
    },
    {
      ordinal: 1, tool_use_event_index: 2, tool_result_event_index: 3, tool_kind: 'kmp-test',
      operation: 'other', plan_only: false, policy_decision: 'not-applicable', result_status: 'success',
      phase: 'no-signal', dispatch_status: 'result_correlated_no_policy', recognized_operation: 'parallel',
    },
    {
      ordinal: 2, tool_use_event_index: 4, tool_result_event_index: 5, tool_kind: 'gradle',
      operation: 'other', plan_only: false, policy_decision: 'not-applicable', result_status: 'success',
      phase: 'no-signal', dispatch_status: 'result_correlated_no_policy', recognized_operation: null,
    },
  ];
  return {
    schema: 10, run_id: record.run_id, run_schema: record.schema, run_kind: 'scenario',
    condition: record.condition, scenario_id: record.scenario_id,
    first_useful_signal_event: null, terminal_authoritative_event: null,
    run_provenance_sha256: computeRunProvenanceSha256(record),
    execution_profile_id: record.execution_profile.id,
    policy_mode: 'not_applicable',
    isolation_attestation_sha256: record.execution_profile.isolation_attestation_sha256,
    terminal_evidence: {
      present: false, provider: null, tool_result_event_index: null, evidence_well_formed: false,
      target_matches_expected: null, outcome_matches_expected: null, malformed: null,
      parallel_evidence_invalid: null, changed_evidence_invalid: null, observed_result: null,
      final_answer_block: {
        found: false, parsed: null, ambiguous: false, matches_observed: null,
        comparison_status: 'no-final-text', declared_outcome_kind: null, observed_outcome_kind: null,
        missing_fields: [], mismatch_fields: [], unexpected_key_count: 0,
      },
      coverage_gate_diagnostic: 'not-applicable', coverage_gate_attempts: [],
    },
    outcome_assessment: record.outcome_assessment,
    outcome_observability_summary: {
      schema: 1, flavor_relation: 'not-applicable', test_type_relation: 'not-applicable',
      coverage_target_status: 'not-applicable', coverage_report_status: 'not-recorded',
      warning_code_counts: {
        no_coverage_data: 0, coverage_xml_disabled: 0, coverage_xml_oversized: 0, coverage_parse_failed: 0,
        coverage_aggregation_drift: 0, coverage_report_write_failed: 0, coverage_report_dispatch_failed: 0,
        coverage_aggregation_failed: 0, coverage_aggregation_skipped: 0,
      },
      module_failed_setup_count: null,
      execution_mode_counts: { fresh: 0, 'from-cache': 0, 'up-to-date': 0, 'no-evidence': 0, 'not-recorded': 0 },
    },
    tool_calls: toolCalls,
    summary: {
      tool_calls_total: toolCalls.length,
      shell_commands_total: toolCalls.filter((tc) => ['kmp-test', 'gradle', 'other-bash'].includes(tc.tool_kind)).length,
      post_signal_ms: null, post_signal_tool_calls: null,
      policy_denials_total: null, policy_denials_before_first_signal: null, policy_denials_after_first_signal: null,
      policy_decisions_missing: null, pre_dispatch_blocked_total: 0, dispatch_unaccounted_total: 0,
    },
  };
}

/** Writes one ACCEPTED cell (record.json + audit.json, flat, hash-bound) at `<campaignDir>/private/<cellKey>/`. */
export function writeAcceptedCell(campaignDir, cellKey, recordOverrides) {
  const cellDir = path.join(campaignDir, 'private', cellKey);
  mkdirSync(cellDir, { recursive: true });
  const record = acceptedRecord({ runId: `run-${cellKey}`, ...recordOverrides });
  const audit = sidecarFor(record);
  const auditText = JSON.stringify(audit, null, 2);
  const sha256 = createHash('sha256').update(auditText, 'utf8').digest('hex');
  record.accepted_audit = { schema: 10, relative_path: `audit/${record.run_id}.json`, sha256 };
  writeFileSync(path.join(cellDir, 'audit.json'), auditText);
  writeFileSync(path.join(cellDir, 'record.json'), JSON.stringify(record, null, 2));
}

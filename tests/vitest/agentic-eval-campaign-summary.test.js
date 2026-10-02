// tests/vitest/agentic-eval-campaign-summary.test.js -- direct unit coverage for
// tools/agentic-eval/campaign-summary.mjs. Fixture style mirrors agentic-eval-analysis.test.js's
// own schema-valid record+sidecar builders (scenarioRecord6/sidecarFor/GRADING_CHECK_NAMES),
// adapted for campaign-summary.mjs's flat `<cellDir>/{record,audit}.json` layout (no `audit/`
// subdirectory, no `relative_path` resolution) instead of the `tools/runs/` convention.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

import { summarizeCampaign, renderMarkdown, accessScanEffects, CAMPAIGN_SUMMARY_SCHEMA } from '../../tools/agentic-eval/campaign-summary.mjs';
import { validateSummary } from '../../tools/agentic-eval/readme-evidence.mjs';
import { GRADING_CHECK_NAMES } from '../../tools/agentic-eval/graders.mjs';
import { computeExecutionProfileSha256 } from '../../tools/agentic-eval/registries.mjs';
import { computeRunProvenanceSha256 } from '../../tools/agentic-eval/accepted-run-audit.mjs';
import { nullableMetric } from '../../tools/agentic-eval/cli.mjs';

const EXECUTION_PROFILE_BASE = Object.freeze({
  id: 'sandboxed-unrestricted-v1', isolation_kind: 'external-sandbox', network_mode: 'restricted',
  isolation_attestation_required: true, policy_mode: 'not_applicable',
  required_capabilities: ['structuredTranscript', 'correlatedToolResults', 'skillStateEvidence'],
});
const EXECUTION_PROFILE = Object.freeze({
  ...EXECUTION_PROFILE_BASE, sha256: computeExecutionProfileSha256(EXECUTION_PROFILE_BASE),
  isolation_attestation_sha256: 'e'.repeat(64),
});

const SCENARIO_ID = 'coverage-threshold-failure-v2';
const MODULE = ':core:domain';
const CAMPAIGN_SUMMARY_SCRIPT = fileURLToPath(new URL('../../tools/agentic-eval/campaign-summary.mjs', import.meta.url));

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aecs-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
function acceptedRecord({ runId, runtimeId, condition, roundIndex, matched = true, success = false, repoCommit = 'be8d850455bdac7a653ff24794777b2f96d7958c' }) {
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
function sidecarFor(record) {
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
function writeAcceptedCell(campaignDir, cellKey, recordOverrides) {
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

// The 13 schema-v9 recording fields (design.md (d)), every one required once schema >= 9 --
// validateRun's own presence/absence gate (schemas.mjs) forbids a non-null value below v9, so
// acceptedRecord's schema-8 default is left untouched for every existing fixture; only a cell that
// opts into v9 (via writeAcceptedCellV9) carries these. Values chosen to be domain-valid per
// NULLABLE_METRIC_KIND (schemas.mjs) -- 'text'/'count'/'amount' -- not just shape-valid.
function v9RecordFields({ reasoningEffortRequested }) {
  return {
    schema: 9,
    reasoning_effort_requested: reasoningEffortRequested,
    reasoning_effort_source: 'harness-pinned-cli-flag',
    served_model_snapshot: nullableMetric(null, 'no assistant turn observed'),
    argv_sha256: 'a'.repeat(64),
    delivered_prompt_sha256: 'b'.repeat(64),
    treatment_delivery_sha256: nullableMetric(null, 'condition-no-skill'),
    env_keys: ['PATH'],
    executed_commands: [],
    max_budget_usd: nullableMetric(0.6),
    timeout_ms: 300000,
    result_subtype: nullableMetric('success'),
    num_turns: nullableMetric(1),
    total_cost_usd: nullableMetric(null, 'not recorded'),
  };
}

/** Writes one ACCEPTED, schema-v9 cell -- same layout as writeAcceptedCell, plus the 13 v9
 * recording fields so provenance.reasoning_effort has real data to aggregate over.
 * `extraRecordFields` (default none) are merged over the record before the audit sidecar is built, so
 * a test can set session_id_observed or the optional agent_state. */
function writeAcceptedCellV9(campaignDir, cellKey, recordOverrides, { reasoningEffortRequested, extraRecordFields = {} }) {
  const cellDir = path.join(campaignDir, 'private', cellKey);
  mkdirSync(cellDir, { recursive: true });
  const record = { ...acceptedRecord({ runId: `run-${cellKey}`, ...recordOverrides }), ...v9RecordFields({ reasoningEffortRequested }), ...extraRecordFields };
  const audit = sidecarFor(record);
  const auditText = JSON.stringify(audit, null, 2);
  const sha256 = createHash('sha256').update(auditText, 'utf8').digest('hex');
  record.accepted_audit = { schema: 10, relative_path: `audit/${record.run_id}.json`, sha256 };
  writeFileSync(path.join(cellDir, 'audit.json'), auditText);
  writeFileSync(path.join(cellDir, 'record.json'), JSON.stringify(record, null, 2));
}

/** Writes one REJECTED cell (rejection.json, single-entry `cells[]`) at `<campaignDir>/private/<cellKey>/`.
 * `d3Qualifying:true` builds the exact real-world-verified shape (689b7772/codex-cli-3) that
 * qualifies for D3 negative reclassification; pass overrides to break any one condition. */
function writeRejectedCell(campaignDir, cellKey, { runtimeId, condition, roundIndex, d3Qualifying = false, cellOverrides = {} }) {
  const cellDir = path.join(campaignDir, 'private', cellKey);
  mkdirSync(cellDir, { recursive: true });
  const cell = {
    ambient_skill_profile: { count: 1, scope_id: '11111111-2222-4333-8444-555555555555', fingerprint_hmac: '0'.repeat(64) },
    cell_metrics: {
      schema: 1, started_at: '2026-09-23T09:00:00.000Z', ended_at: '2026-09-23T09:01:00.000Z',
      wall_clock_ms: 60000, first_useful_signal_ms: null, post_signal_ms: null,
      usage: { source: 'runtime-reported', input: 400, cached_input: 0, cache_write: 0, output: 100, reasoning_output: 10 },
      tokens: { input: { value: 400, reason: null }, output: { value: 100, reason: null }, cache_read: { value: 0, reason: null }, cache_creation: { value: 0, reason: null } },
      tool_calls_total: 3, shell_commands_total: 2,
    },
    claude_code_version: runtimeId === 'claude-code' ? '2.1.238' : '0.154.0',
    condition,
    correlation_observability: {
      schema: 1, condition, policy_mode: 'not_applicable',
      tool_use_counts_by_kind: { shell: 3, skill: 0, other: 0 },
      missing_id_counts_by_kind: { shell: 0, skill: 0, other: 0 },
      missing_result_counts_by_kind: d3Qualifying ? { shell: 1, skill: 0, other: 0 } : { shell: 0, skill: 0, other: 0 },
      dispatch_status_counts: { hook_evaluated: 0, pre_dispatch_blocked: 0, result_correlated_no_policy: 2, unaccounted: d3Qualifying ? 1 : 0, unclassified: 0 },
      correlation_issue_counts: { duplicate_tool_use_id: 0, orphan_tool_result_missing_id: 0, orphan_tool_result_unknown_id: 0, duplicate_tool_result: 0, malformed_stream_line: 0 },
      timeout_tolerance_applied: false,
    },
    coverage_gate_attempt_summary: null,
    failed_checks: d3Qualifying ? ['hookAccountingOk', 'toolResultsCompleteOk'] : ['hookAccountingOk', 'toolResultsCompleteOk', 'cleanTranscriptOk'],
    foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
    grading_summary: null,
    model_resolved: runtimeId === 'claude-code' ? 'claude-sonnet-5' : 'gpt-5.6-terra',
    order_index: roundIndex,
    outcome_assessment: {
      schema: 2, task_outcome_matched: false, task_outcome_reason: 'claim-missing',
      answer_protocol_matched: false, provider_evidence_kind: null, provider_evidence_status: null,
      product_e2e_success: null, task_outcome_mismatch_fields: null, task_outcome_unexpected_key_count: 0,
    },
    outcome_observability_summary: null,
    pre_inference_failure: {
      schema: 3, signature_matched: false, terminal_present: true, terminal_is_error: false,
      terminal_result_subtype: 'success', terminal_turn_count: 1,
      usage: { input: 'nonzero', output: 'nonzero', cached_input: 'nonzero', cache_write: 'null' },
      tool_attempt_count: 3, cause_code: 'not_matched', runtime_error_code: 'not_matched',
    },
    record_error_codes: [],
    repetition_index: Math.floor(roundIndex / 2),
    run_id: `run-${cellKey}`,
    skill_source_sha: condition === 'current-skill' ? '2112aed96686ee159f851e00c2efa553e58473fc' : null,
    terminal_evidence_summary: null,
    unexpected_tool_uses_count: 0,
    ...cellOverrides,
  };
  const rejection = {
    schema: 13, rejection_id: `${cellKey}-rejection`, timestamp: '2026-09-23T09:01:05.000Z',
    run_kind: 'scenario', run_ids: [cell.run_id], model_requested: cell.model_resolved,
    repo_commit: 'be8d850455bdac7a653ff24794777b2f96d7958c', scenario_id: SCENARIO_ID,
    project_alias: 'nowinandroid', project_commit: '7d45eae4f8720a0c77f507712ba2437ff974b6ed',
    seed: 42, policy_sha256: 'f'.repeat(64), platform: 'windows', privacy_status: 'public',
    cells: [cell],
    foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
    ambient_profile_matrix_ok: true,
    matrix_complete: true, planned_cell_count: 1, executed_cell_count: 1, raw_transcripts_persisted: false,
  };
  writeFileSync(path.join(cellDir, 'rejection.json'), JSON.stringify(rejection, null, 2));
}

function writeManifest(campaignDir, { campaignId = 'campaign-under-test', providerMode = 'live', runtimes } = {}) {
  const manifest = {
    schema: 1, campaign_id: campaignId, scenario_id: SCENARIO_ID, seed: 42, provider_mode: providerMode,
    runtimes: runtimes ?? [
      { runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0, 1], max_budget_usd: 2.0 },
      { runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-baseline-v2', campaign_cell_indices: [0, 1], max_budget_usd: null },
    ],
  };
  writeFileSync(path.join(campaignDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

describe('summarizeCampaign -- provider_mode gate', () => {
  it('a non-live (fake) manifest is refused outright: no cells read at all', () => {
    withTempDir((dir) => {
      writeManifest(dir, { providerMode: 'fake' });
      // Deliberately do NOT create private/ at all -- proves the gate fires before any cell read.
      const result = summarizeCampaign(dir);
      expect(result.summary_status).toBe('refused');
      expect(result.reason_code).toBe('campaign_not_live');
      expect(result.by_runtime_arm).toEqual([]);
      expect(result.cells).toEqual([]);
    });
  });
});

describe('summarizeCampaign -- a genuinely live example campaign', () => {
  it('accepted cells in both arms, both runtimes: correct per-arm counts, key facts, and product-only success', () => {
    withTempDir((dir) => {
      writeManifest(dir);
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0, matched: true, success: true });
      writeAcceptedCell(dir, 'claude-code-1', { runtimeId: 'claude-code', condition: 'no-skill', roundIndex: 1, matched: true, success: false });
      writeAcceptedCell(dir, 'codex-cli-0', { runtimeId: 'codex-cli', condition: 'current-skill', roundIndex: 0, matched: false, success: false });
      writeAcceptedCell(dir, 'codex-cli-1', { runtimeId: 'codex-cli', condition: 'no-skill', roundIndex: 1, matched: true, success: false });

      const result = summarizeCampaign(dir);
      expect(result.summary_status).toBe('ok');
      expect(result.schema).toBe(CAMPAIGN_SUMMARY_SCHEMA);
      // summary_status:'ok' means "this computed successfully" -- never "the data looks good".
      // benchmark_eligible_counts is the separate, descriptive, per-runtime tally of what the
      // records THEMSELVES say (H20/H21's own promotion flag, always true in this fixture),
      // never conflated with the former.
      expect(result.benchmark_eligible_counts['claude-code']).toEqual({ true: 2, false: 0 });
      expect(result.benchmark_eligible_counts['codex-cli']).toEqual({ true: 2, false: 0 });

      const claudeProduct = result.by_runtime_arm.find((g) => g.runtime_id === 'claude-code' && g.arm === 'product');
      expect(claudeProduct.declared).toBe(1);
      expect(claudeProduct.accepted).toBe(1);
      expect(claudeProduct.key_facts_match).toEqual({ matched: 1, of: 1 });
      // success is reported ONLY for product, and this cell's success:true.
      expect(claudeProduct.success).toEqual({ matched: 1, of: 1, label: expect.any(String) });

      const claudeFree = result.by_runtime_arm.find((g) => g.runtime_id === 'claude-code' && g.arm === 'free');
      expect(claudeFree.success).toBeNull(); // never reported for the free arm

      const codexProduct = result.by_runtime_arm.find((g) => g.runtime_id === 'codex-cli' && g.arm === 'product');
      expect(codexProduct.key_facts_match).toEqual({ matched: 0, of: 1 }); // matched:false fixture

      // kmp-test vs Gradle counts ARE available here (every counted cell is accepted).
      expect(claudeProduct.kmp_test_vs_gradle.available).toBe(true);
      expect(claudeProduct.kmp_test_vs_gradle.kmp_test_count).toBeGreaterThan(0);
    });
  });
});

// 2026-09-30 (auditor-directed fix): loadCell required an EXACT {audit.json, record.json} or
// {rejection.json} directory listing -- a real campaign's own private evidence directory can
// legitimately carry more than that (transcript.jsonl, copied post-hoc by
// agentic-eval-accepted-raw-transcript/agentic-eval-rejected-raw-transcript for infra-flake
// classification, which reads it from this exact path). RED against the pre-fix code: all three
// cases below failed -- the two "still works" cases came back status:'missing' with
// reason:'cell_directory_shape_unrecognized' (a real cell misread as absent evidence), and the
// unknown-file case had no distinct reason of its own to assert on at all.
describe('summarizeCampaign -- tolerates known extra evidence files in a cell directory (loadCell allowlist)', () => {
  it('an accepted cell also carrying transcript.jsonl is still accepted, not misread as missing', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0] }] });
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0, matched: true, success: true });
      writeFileSync(path.join(dir, 'private', 'claude-code-0', 'transcript.jsonl'), '{"type":"fake"}\n');
      const result = summarizeCampaign(dir);
      const row = result.cells.find((c) => c.cell_key === 'claude-code-0');
      expect(row.status).toBe('accepted');
      const group = result.by_runtime_arm.find((g) => g.runtime_id === 'claude-code' && g.arm === 'product');
      expect(group.accepted).toBe(1);
      expect(group.missing).toBe(0);
    });
  });

  it('a rejected cell also carrying transcript.jsonl still counts correctly (missing or negative-d3, never a shape-unrecognized false miss)', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-baseline-v2', campaign_cell_indices: [0] }] });
      writeRejectedCell(dir, 'codex-cli-0', { runtimeId: 'codex-cli', condition: 'current-skill', roundIndex: 0, d3Qualifying: true });
      writeFileSync(path.join(dir, 'private', 'codex-cli-0', 'transcript.jsonl'), '{"type":"fake"}\n');
      const result = summarizeCampaign(dir);
      const row = result.cells.find((c) => c.cell_key === 'codex-cli-0');
      expect(row.status).toBe('negative-d3');
      expect(row.status).not.toBe('missing');
    });
  });

  it('an unrecognized extra file still fails closed, with the offending filename in the reason', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0] }] });
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0, matched: true, success: true });
      writeFileSync(path.join(dir, 'private', 'claude-code-0', 'unexpected-file.txt'), 'not a recognized evidence file');
      const result = summarizeCampaign(dir);
      const row = result.cells.find((c) => c.cell_key === 'claude-code-0');
      expect(row.status).toBe('missing');
      expect(row.reason).toBe('cell_directory_unknown_file:unexpected-file.txt');
    });
  });
});

describe('summarizeCampaign -- rejected cells', () => {
  it('a rejected cell NOT matching the D3 criteria is counted as missing, with its reason', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-baseline-v2', campaign_cell_indices: [0] }] });
      writeRejectedCell(dir, 'codex-cli-0', { runtimeId: 'codex-cli', condition: 'current-skill', roundIndex: 0, d3Qualifying: false });
      const result = summarizeCampaign(dir);
      const group = result.by_runtime_arm.find((g) => g.runtime_id === 'codex-cli' && g.arm === 'product');
      expect(group.declared).toBe(1);
      expect(group.accepted).toBe(0);
      expect(group.negative_d3).toBe(0);
      expect(group.missing).toBe(1);
      expect(group.missing_reasons).toEqual([{ cell_key: 'codex-cli-0', reason: 'rejected_not_reclassifiable' }]);
      const row = result.cells.find((c) => c.cell_key === 'codex-cli-0');
      expect(row.status).toBe('missing');
    });
  });

  // D3 (the plan's own literal criteria; this fixture mirrors the real, auditor-verified
  // 689b7772/codex-cli-3 rejection.json shape exactly).
  it('a rejected Codex cell matching ALL 5 D3 criteria counts as a negative observation, not missing data', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-baseline-v2', campaign_cell_indices: [0] }] });
      writeRejectedCell(dir, 'codex-cli-0', { runtimeId: 'codex-cli', condition: 'current-skill', roundIndex: 0, d3Qualifying: true });
      const result = summarizeCampaign(dir);
      const group = result.by_runtime_arm.find((g) => g.runtime_id === 'codex-cli' && g.arm === 'product');
      expect(group.accepted).toBe(0);
      expect(group.negative_d3).toBe(1);
      expect(group.missing).toBe(0);
      expect(group.counted).toBe(1);
      const row = result.cells.find((c) => c.cell_key === 'codex-cli-0');
      expect(row.status).toBe('negative-d3');
      // claim-missing outcome_assessment -> key facts / full answer both read false, never fabricated true.
      expect(row.key_facts_match).toBe(false);
      expect(row.full_answer_match).toBe(false);
    });
  });

  it('D3 criterion 3 violated (an orphaned tool result, a real correlation_issue) -> missing, not negative', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-baseline-v2', campaign_cell_indices: [0] }] });
      writeRejectedCell(dir, 'codex-cli-0', {
        runtimeId: 'codex-cli', condition: 'current-skill', roundIndex: 0, d3Qualifying: true,
        cellOverrides: {
          correlation_observability: {
            schema: 1, condition: 'current-skill', policy_mode: 'not_applicable',
            tool_use_counts_by_kind: { shell: 3, skill: 0, other: 0 },
            missing_id_counts_by_kind: { shell: 0, skill: 0, other: 0 },
            missing_result_counts_by_kind: { shell: 1, skill: 0, other: 0 },
            dispatch_status_counts: { hook_evaluated: 0, pre_dispatch_blocked: 0, result_correlated_no_policy: 2, unaccounted: 1, unclassified: 0 },
            correlation_issue_counts: { duplicate_tool_use_id: 0, orphan_tool_result_missing_id: 0, orphan_tool_result_unknown_id: 1, duplicate_tool_result: 0, malformed_stream_line: 0 },
            timeout_tolerance_applied: false,
          },
        },
      });
      const result = summarizeCampaign(dir);
      const group = result.by_runtime_arm.find((g) => g.runtime_id === 'codex-cli' && g.arm === 'product');
      expect(group.negative_d3).toBe(0);
      expect(group.missing).toBe(1);
    });
  });

  it('D3 criterion 5 violated (terminal_result_subtype not "success") -> missing, not negative', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-baseline-v2', campaign_cell_indices: [0] }] });
      writeRejectedCell(dir, 'codex-cli-0', {
        runtimeId: 'codex-cli', condition: 'current-skill', roundIndex: 0, d3Qualifying: true,
        cellOverrides: {
          pre_inference_failure: {
            schema: 3, signature_matched: false, terminal_present: true, terminal_is_error: false,
            terminal_result_subtype: null, terminal_turn_count: 1,
            usage: { input: 'nonzero', output: 'nonzero', cached_input: 'nonzero', cache_write: 'null' },
            tool_attempt_count: 3, cause_code: 'not_matched', runtime_error_code: 'not_matched',
          },
        },
      });
      const result = summarizeCampaign(dir);
      const group = result.by_runtime_arm.find((g) => g.runtime_id === 'codex-cli' && g.arm === 'product');
      expect(group.negative_d3).toBe(0);
      expect(group.missing).toBe(1);
    });
  });

  it('a rejected Claude cell matching the D3 shape is STILL missing -- D3 is codex-cli only', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0] }] });
      writeRejectedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0, d3Qualifying: true });
      const result = summarizeCampaign(dir);
      const group = result.by_runtime_arm.find((g) => g.runtime_id === 'claude-code' && g.arm === 'product');
      expect(group.negative_d3).toBe(0);
      expect(group.missing).toBe(1);
    });
  });

  it('a malformed rejection.json (cells[] with 0 or 2+ entries) is missing, with that specific reason', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-baseline-v2', campaign_cell_indices: [0] }] });
      const cellDir = path.join(dir, 'private', 'codex-cli-0');
      mkdirSync(cellDir, { recursive: true });
      writeFileSync(path.join(cellDir, 'rejection.json'), JSON.stringify({ schema: 13, cells: [] }));
      const result = summarizeCampaign(dir);
      const row = result.cells.find((c) => c.cell_key === 'codex-cli-0');
      expect(row.status).toBe('missing');
      expect(row.reason).toBe('rejection_malformed_cell_count');
    });
  });

  it('a wholly absent cell directory is missing, with that specific reason', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-baseline-v2', campaign_cell_indices: [0] }] });
      mkdirSync(path.join(dir, 'private'), { recursive: true }); // no cell subdirectory at all
      const result = summarizeCampaign(dir);
      const row = result.cells.find((c) => c.cell_key === 'codex-cli-0');
      expect(row.status).toBe('missing');
      expect(row.reason).toBe('cell_directory_absent');
    });
  });
});

// A cell that left neither a record nor a rejection (a session lost to a failed guest call, say) has no condition to take an arm from. When the
// manifest says what the design put at that position (`round_order`), the cell is declared in that arm and not counted; a manifest without a
// round_order, which every earlier campaign has, keeps the old grouping (arm null) byte for byte.
describe('summarizeCampaign -- a cell with neither a record nor a rejection takes its arm from the manifest\'s round_order', () => {
  const ORDER = ['product', 'free', 'free', 'product'];
  const conditionOf = (arm) => (arm === 'product' ? 'current-skill' : 'no-skill');
  const writeOrderedManifest = (dir, roundOrder) => {
    const runtimes = [
      { runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0, 1, 2, 3], max_budget_usd: 2.0 },
      { runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-baseline-v2', campaign_cell_indices: [0, 1, 2, 3], max_budget_usd: null },
    ];
    const manifest = { schema: 1, campaign_id: 'campaign-under-test', scenario_id: SCENARIO_ID, seed: 42, provider_mode: 'live', runtimes, ...(roundOrder ? { round_order: roundOrder } : {}) };
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  };
  // every cell has a record, except the keys in `absent` (no directory at all) and the keys in `rejected` (a rejection of the arm in `rejectedArm`)
  const writeCampaignDir = (dir, { roundOrder = ORDER, absent = [], rejected = [], rejectedArm = 'free' } = {}) => {
    writeOrderedManifest(dir, roundOrder);
    for (const runtimeId of ['claude-code', 'codex-cli']) {
      ORDER.forEach((arm, i) => {
        const key = `${runtimeId}-${i}`;
        if (absent.includes(key)) return;
        if (rejected.includes(key)) {
          writeRejectedCell(dir, key, { runtimeId, condition: conditionOf(rejectedArm), roundIndex: i });
          return;
        }
        writeAcceptedCell(dir, key, { runtimeId, condition: conditionOf(arm), roundIndex: i });
      });
    }
  };
  const group = (summary, runtimeId, arm) => summary.by_runtime_arm.find((g) => g.runtime_id === runtimeId && g.arm === arm);

  it('declares the absent cell in its design arm, counts the arm without it, names the reason, and leaves no group of unknown arm', () => {
    withTempDir((dir) => {
      writeCampaignDir(dir, { absent: ['codex-cli-1'] });
      const summary = summarizeCampaign(dir);
      expect(summary.by_runtime_arm.map((g) => `${g.runtime_id}/${g.arm}`)).toEqual(['claude-code/free', 'claude-code/product', 'codex-cli/free', 'codex-cli/product']);
      expect(group(summary, 'codex-cli', 'free')).toMatchObject({ declared: 2, accepted: 1, counted: 1, missing: 1, missing_reasons: [{ cell_key: 'codex-cli-1', reason: 'cell_directory_absent' }] });
      expect(group(summary, 'codex-cli', 'product')).toMatchObject({ declared: 2, accepted: 2, counted: 2, missing: 0 });
      expect(group(summary, 'claude-code', 'free')).toMatchObject({ declared: 2, accepted: 2, counted: 2, missing: 0 });
      expect(summary.cells.find((c) => c.cell_key === 'codex-cli-1')).toMatchObject({ runtime_id: 'codex-cli', arm: 'free', round_index: 1, status: 'missing', reason: 'cell_directory_absent' });
    });
  });

  it('puts the absent cell\'s row among its arm\'s cells in round order', () => {
    withTempDir((dir) => {
      writeCampaignDir(dir, { absent: ['codex-cli-1'] });
      const keys = summarizeCampaign(dir).cells.filter((c) => c.runtime_id === 'codex-cli').map((c) => c.cell_key);
      expect(keys).toEqual(['codex-cli-1', 'codex-cli-2', 'codex-cli-0', 'codex-cli-3']);
    });
  });

  it('a manifest without a round_order keeps the old grouping: the absent cell has no arm and sits in a group of arm null', () => {
    withTempDir((dir) => {
      writeCampaignDir(dir, { roundOrder: null, absent: ['codex-cli-1'] });
      const summary = summarizeCampaign(dir);
      expect(group(summary, 'codex-cli', null)).toMatchObject({ declared: 1, accepted: 0, counted: 0, missing: 1 });
      expect(group(summary, 'codex-cli', 'free')).toMatchObject({ declared: 1, counted: 1 });
      expect(summary.cells.find((c) => c.cell_key === 'codex-cli-1').arm).toBeNull();
    });
  });

  it('a cell that has a record or a rejection keeps the arm its own condition gives, whatever the round_order says', () => {
    withTempDir((dir) => {
      // the manifest says product at position 1, the rejection of codex-cli-1 says no-skill (free)
      writeCampaignDir(dir, { roundOrder: ['product', 'product', 'free', 'product'], rejected: ['codex-cli-1'], rejectedArm: 'free' });
      const summary = summarizeCampaign(dir);
      expect(summary.cells.find((c) => c.cell_key === 'codex-cli-1')).toMatchObject({ arm: 'free', status: 'missing', reason: 'rejected_not_reclassifiable' });
      expect(group(summary, 'codex-cli', 'free')).toMatchObject({ declared: 2, missing: 1 });
      expect(summary.cells.find((c) => c.cell_key === 'claude-code-1').arm).toBe('free'); // its record says no-skill
    });
  });

  it('changes nothing when every cell has evidence: the summary is the same with and without a round_order', () => {
    withTempDir((withOrder) => {
      withTempDir((withoutOrder) => {
        writeCampaignDir(withOrder);
        writeCampaignDir(withoutOrder, { roundOrder: null });
        expect(JSON.stringify(summarizeCampaign(withOrder))).toBe(JSON.stringify(summarizeCampaign(withoutOrder)));
      });
    });
  });

  it('a rejected cell and an absent cell of the same arm are both declared there, and neither is counted', () => {
    withTempDir((dir) => {
      writeCampaignDir(dir, { rejected: ['claude-code-2'], absent: ['codex-cli-2'] });
      const summary = summarizeCampaign(dir);
      expect(group(summary, 'claude-code', 'free')).toMatchObject({ declared: 2, counted: 1, missing: 1 });
      expect(group(summary, 'codex-cli', 'free')).toMatchObject({ declared: 2, counted: 1, missing: 1 });
      expect(summary.by_runtime_arm).toHaveLength(4);
    });
  });

  it('the sensitivity summary keeps the absent cell in its design arm too', () => {
    withTempDir((dir) => {
      writeCampaignDir(dir, { absent: ['codex-cli-1'] });
      const summary = summarizeCampaign(dir, new Set(['claude-code-0']));
      expect(group(summary, 'claude-code', 'product')).toMatchObject({ declared: 1, counted: 1 });
      expect(group(summary, 'codex-cli', 'free')).toMatchObject({ declared: 2, counted: 1, missing: 1 });
      expect(summary.by_runtime_arm.every((g) => g.arm !== null)).toBe(true);
    });
  });
});

describe('summarizeCampaign -- determinism and privacy', () => {
  it('two summarizations of the identical campaign directory produce byte-identical JSON output', () => {
    withTempDir((dir) => {
      writeManifest(dir);
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0 });
      writeAcceptedCell(dir, 'claude-code-1', { runtimeId: 'claude-code', condition: 'no-skill', roundIndex: 1 });
      writeRejectedCell(dir, 'codex-cli-0', { runtimeId: 'codex-cli', condition: 'current-skill', roundIndex: 0, d3Qualifying: true });
      writeAcceptedCell(dir, 'codex-cli-1', { runtimeId: 'codex-cli', condition: 'no-skill', roundIndex: 1 });
      const first = JSON.stringify(summarizeCampaign(dir));
      const second = JSON.stringify(summarizeCampaign(dir));
      expect(first).toBe(second);
    });
  });

  it('cells[] is ordered runtime -> arm -> round_index', () => {
    withTempDir((dir) => {
      writeManifest(dir);
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0 });
      writeAcceptedCell(dir, 'claude-code-1', { runtimeId: 'claude-code', condition: 'no-skill', roundIndex: 1 });
      writeAcceptedCell(dir, 'codex-cli-0', { runtimeId: 'codex-cli', condition: 'current-skill', roundIndex: 0 });
      writeAcceptedCell(dir, 'codex-cli-1', { runtimeId: 'codex-cli', condition: 'no-skill', roundIndex: 1 });
      const result = summarizeCampaign(dir);
      const order = result.cells.map((c) => `${c.runtime_id}:${c.arm}:${c.round_index}`);
      const sorted = [...order].sort();
      expect(order).toEqual(sorted);
    });
  });

  it('the Markdown report never contains a raw filesystem path -- no "C:\\\\", no guest-VM naming', () => {
    withTempDir((dir) => {
      writeManifest(dir);
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0 });
      writeAcceptedCell(dir, 'claude-code-1', { runtimeId: 'claude-code', condition: 'no-skill', roundIndex: 1 });
      writeRejectedCell(dir, 'codex-cli-0', { runtimeId: 'codex-cli', condition: 'current-skill', roundIndex: 0, d3Qualifying: true });
      writeAcceptedCell(dir, 'codex-cli-1', { runtimeId: 'codex-cli', condition: 'no-skill', roundIndex: 1 });
      const markdown = renderMarkdown(summarizeCampaign(dir));
      expect(markdown).not.toMatch(/C:\\/);
      expect(markdown).not.toMatch(/Evidence1E2E/i);
      expect(markdown).not.toMatch(/resolved_kmp_test_executable_path/);
    });
  });

  it('a non-eligible (fake) campaign renders a minimal Markdown stub, no path leakage there either', () => {
    withTempDir((dir) => {
      writeManifest(dir, { providerMode: 'fake' });
      const markdown = renderMarkdown(summarizeCampaign(dir));
      expect(markdown).toContain('campaign_not_live');
      expect(markdown).not.toMatch(/C:\\/);
    });
  });

  // WO-C16 follow-up: both table row builders used ['', ...fields, ''].join(' | '), producing
  // " | a | b | c | " (a leading space, a trailing "| ") instead of the clean "| a | b | c |" every
  // other Markdown table in this file family (readme-evidence.mjs's own scorecard/grid legends,
  // evidence2-tables.mjs) already produces. Cosmetic, but the auditor flagged it as unprofessional
  // in the generated evidence doc -- checked here on a real row, not just "doesn't crash".
  it('every data row in both tables (By runtime/arm, Per-cell detail) has no leading space and no trailing "| " -- starts "| ", ends "|" with no space before it', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0] }] });
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0 });
      const markdown = renderMarkdown(summarizeCampaign(dir));
      // Filtered by the TRIMMED line starting with '|' (a leading-space bug would still trim to
      // that), so a still-buggy row is caught by the assertions below rather than filtered out --
      // filtering on the raw, untrimmed line would silently exclude exactly the buggy rows this
      // test exists to catch (they start with a space, not '|').
      const dataRows = markdown.split('\n').filter((l) => l.trim().startsWith('|') && !l.includes('---') && !l.includes('runtime | arm'));
      expect(dataRows.length).toBe(2); // one By-runtime/arm row + one Per-cell-detail row
      for (const row of dataRows) {
        expect(row, `row "${row}" does not start exactly with "| " (no leading space, no double space)`).toMatch(/^\| \S/);
        expect(row, `row "${row}" does not end exactly with " |" (no trailing "| ", no double space)`).toMatch(/\S \|$/);
      }
    });
  });
});

describe('summarizeCampaign -- provenance and limitations', () => {
  it('a single, consistent repo_commit/skill_source_sha across all cells reports no "mixed" limitation', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0, 1] }] });
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0 });
      writeAcceptedCell(dir, 'claude-code-1', { runtimeId: 'claude-code', condition: 'no-skill', roundIndex: 1 });
      const result = summarizeCampaign(dir);
      expect(result.provenance.repo_commit.mixed).toBe(false);
      expect(result.limitations.some((l) => l.includes('mixed revisions'))).toBe(false);
    });
  });

  it('two distinct repo_commit values across cells produces a "mixed revisions" limitation line', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0, 1] }] });
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0 });
      // A different repo_commit set BEFORE writing (not mutated after the fact) -- run_provenance_sha256
      // is itself computed from the record's own content, so a post-hoc file mutation would only
      // break that unrelated cross-check, not exercise the provenance-tracking logic under test.
      writeAcceptedCell(dir, 'claude-code-1', { runtimeId: 'claude-code', condition: 'no-skill', roundIndex: 1, repoCommit: '0000000000000000000000000000000000000000' });
      const result = summarizeCampaign(dir);
      expect(result.provenance.repo_commit.mixed).toBe(true);
      expect(result.limitations.some((l) => l.includes('mixed revisions') && l.includes('repo_commit'))).toBe(true);
    });
  });

  it('CAMPAIGN_SUMMARY_SCHEMA is 2 (Evidence2: reasoning_effort provenance)', () => {
    expect(CAMPAIGN_SUMMARY_SCHEMA).toBe(2);
  });

  it('reasoning_effort_requested is aggregated per runtime into provenance.reasoning_effort, {values,mixed} shaped', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [
        { runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0, 1] },
        { runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-baseline-v2', campaign_cell_indices: [0] },
      ] });
      writeAcceptedCellV9(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0 }, { reasoningEffortRequested: 'high' });
      writeAcceptedCellV9(dir, 'claude-code-1', { runtimeId: 'claude-code', condition: 'no-skill', roundIndex: 1 }, { reasoningEffortRequested: 'high' });
      writeAcceptedCellV9(dir, 'codex-cli-0', { runtimeId: 'codex-cli', condition: 'current-skill', roundIndex: 0 }, { reasoningEffortRequested: 'low' });
      const result = summarizeCampaign(dir);
      expect(result.summary_status).toBe('ok');
      expect(result.provenance.reasoning_effort['claude-code']).toEqual({ values: ['high'], mixed: false });
      expect(result.provenance.reasoning_effort['codex-cli']).toEqual({ values: ['low'], mixed: false });
      expect(result.limitations.some((l) => l.includes('mixed revisions') && l.includes('reasoning_effort'))).toBe(false);
      // WO-C16: reasoning_effort_source (the sibling field naming WHERE the requested effort came
      // from, e.g. a pinned CLI flag vs a runtime default) aggregates the same way, alongside the
      // value itself -- v9RecordFields hardcodes 'harness-pinned-cli-flag' for every fixture cell.
      expect(result.provenance.reasoning_effort_source['claude-code']).toEqual({ values: ['harness-pinned-cli-flag'], mixed: false });
      expect(result.provenance.reasoning_effort_source['codex-cli']).toEqual({ values: ['harness-pinned-cli-flag'], mixed: false });
    });
  });

  it('two distinct reasoning_effort_requested values for the SAME runtime produce a "mixed revisions" limitation line, scoped to that runtime only', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0, 1] }] });
      writeAcceptedCellV9(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0 }, { reasoningEffortRequested: 'high' });
      writeAcceptedCellV9(dir, 'claude-code-1', { runtimeId: 'claude-code', condition: 'no-skill', roundIndex: 1 }, { reasoningEffortRequested: 'medium' });
      const result = summarizeCampaign(dir);
      expect(result.provenance.reasoning_effort['claude-code']).toEqual({ values: ['high', 'medium'], mixed: true });
      // codex-cli has no cells at all in this campaign -- must report cleanly empty, never crash on
      // an absent bucket (the same optional-chaining guard runtime_cli_version/model_resolved use).
      expect(result.provenance.reasoning_effort['codex-cli']).toEqual({ values: [], mixed: false });
      const line = result.limitations.find((l) => l.includes('mixed revisions') && l.includes('reasoning_effort'));
      expect(line).toBeDefined();
      expect(line).toContain('claude-code reasoning_effort');
    });
  });

  it('a schema-8 (pre-v9) accepted cell contributes nothing to reasoning_effort -- never inferred, never a false "high"', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0] }] });
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0 }); // schema 8, no v9 fields
      const result = summarizeCampaign(dir);
      expect(result.provenance.reasoning_effort['claude-code']).toEqual({ values: [], mixed: false });
    });
  });

  it('always reports the cost/kmp-test-vs-gradle/JUnit limitations honestly, never a fabricated figure', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0] }] });
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0 });
      const result = summarizeCampaign(dir);
      expect(result.limitations.some((l) => l.startsWith('cost: not-recorded'))).toBe(true);
      expect(result.limitations.some((l) => l.includes('kmp-test vs Gradle'))).toBe(true);
      expect(result.limitations.some((l) => l.includes('JUnit-XML capture is not verified for codex-cli'))).toBe(true);
    });
  });
});

// Real subprocess invocation, not an imported-function call: `import.meta.url === \`file://${argv[1]}\``
// (the pre-fix guard) never matches on Windows, since import.meta.url is file:///C:/... -- the
// script's main() never ran there at all, silently exiting 0 with zero output. Every other test in
// this file calls summarizeCampaign/renderMarkdown as imported functions and would never have
// caught this: it's specifically the `node campaign-summary.mjs <dir>` entry point that was dead.
// Without this test, "freeze the campaign-summary output" (a later phase of this plan) would have
// silently produced an empty file, no error.
describe('summarizeCampaign -- excludeCellKeys (Amendment A2 D13/R8 sensitivity seam)', () => {
  it('an empty (default) exclusion set reproduces byte-identical output to no argument at all (A2 R7)', () => {
    withTempDir((dir) => {
      writeManifest(dir);
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0, matched: true, success: true });
      writeAcceptedCell(dir, 'claude-code-1', { runtimeId: 'claude-code', condition: 'no-skill', roundIndex: 1, matched: true, success: false });
      writeAcceptedCell(dir, 'codex-cli-0', { runtimeId: 'codex-cli', condition: 'current-skill', roundIndex: 0, matched: false, success: false });
      writeAcceptedCell(dir, 'codex-cli-1', { runtimeId: 'codex-cli', condition: 'no-skill', roundIndex: 1, matched: true, success: false });

      const withoutArg = JSON.stringify(summarizeCampaign(dir));
      const withEmptySet = JSON.stringify(summarizeCampaign(dir, new Set()));
      expect(withEmptySet).toBe(withoutArg);
    });
  });

  it('excludes a named cell entirely: gone from cells[], declared count, and every aggregate', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0, 1] }] });
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0, matched: true, success: true });
      writeAcceptedCell(dir, 'claude-code-1', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 1, matched: true, success: true });

      const primary = summarizeCampaign(dir);
      const productPrimary = primary.by_runtime_arm.find((g) => g.runtime_id === 'claude-code' && g.arm === 'product');
      expect(productPrimary.declared).toBe(2);
      expect(primary.cells.map((c) => c.cell_key)).toContain('claude-code-1');

      const sensitivity = summarizeCampaign(dir, new Set(['claude-code-1']));
      const productSensitivity = sensitivity.by_runtime_arm.find((g) => g.runtime_id === 'claude-code' && g.arm === 'product');
      expect(productSensitivity.declared).toBe(1);
      expect(productSensitivity.accepted).toBe(1);
      expect(sensitivity.cells.map((c) => c.cell_key)).not.toContain('claude-code-1');
      expect(sensitivity.cells.map((c) => c.cell_key)).toContain('claude-code-0');
    });
  });
});

describe('CLI entry point -- real `node campaign-summary.mjs <dir>` subprocess invocation', () => {
  it('prints non-empty JSON and exits 0 for a valid live campaign directory', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0] }] });
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0 });
      const result = spawnSync(process.execPath, [CAMPAIGN_SUMMARY_SCRIPT, dir], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.summary_status).toBe('ok');
      expect(parsed.schema).toBe(CAMPAIGN_SUMMARY_SCHEMA);
    });
  });

  it('--markdown <file> writes a real, non-empty Markdown file', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0] }] });
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0 });
      const markdownPath = path.join(dir, 'out.md');
      const result = spawnSync(process.execPath, [CAMPAIGN_SUMMARY_SCRIPT, dir, '--markdown', markdownPath], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(existsSync(markdownPath)).toBe(true);
      expect(readFileSync(markdownPath, 'utf8').length).toBeGreaterThan(0);
    });
  });

  it('exits 1 (never 0) for a non-live campaign', () => {
    withTempDir((dir) => {
      writeManifest(dir, { providerMode: 'fake' });
      const result = spawnSync(process.execPath, [CAMPAIGN_SUMMARY_SCRIPT, dir], { encoding: 'utf8' });
      expect(result.status).toBe(1);
    });
  });

  it('--exclude-cells <infra-flake-classification.json> composes directly with infra-flake-classifier.mjs\'s own output shape', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0, 1] }] });
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0 });
      writeAcceptedCell(dir, 'claude-code-1', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 1 });

      const classificationPath = path.join(dir, 'infra-flake-classification.json');
      writeFileSync(classificationPath, JSON.stringify({
        schema: 1, classifier_version: 1,
        cells: [
          { cell_key: 'claude-code-0', runtime_id: 'claude-code', arm: 'product', infra_flake_suspected: true, reason: 'signature_match' },
          { cell_key: 'claude-code-1', runtime_id: 'claude-code', arm: 'product', infra_flake_suspected: false, reason: 'clean' },
        ],
        rollup: [],
      }));

      const result = spawnSync(process.execPath, [CAMPAIGN_SUMMARY_SCRIPT, dir, '--exclude-cells', classificationPath], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.cells.map((c) => c.cell_key)).not.toContain('claude-code-0');
      expect(parsed.cells.map((c) => c.cell_key)).toContain('claude-code-1');
    });
  });
});

// WO-C7: additive schema-2 per-cell fields for the README's per-session metrics grid -- tokens by
// type (incl. Codex reasoning_output), num_turns, total_cost_usd, output_bytes, and the 3-way
// command mix. Every test here asserts on the NEW cells[] keys only; none touches an existing
// assertion, and the full pre-existing suite above (26 tests, run unmodified) is the "schema-1
// output byte-identical" proof -- these fields are pure additions to the same cellRows.push object.
describe('summarizeCampaign -- WO-C7 per-cell schema-2 fields', () => {
  it('a v9 accepted cell (current-skill, real usage/num_turns) carries tokens, num_turns, and the exact tool_kind mix sidecarFor always produces (1 kmp-test, 1 gradle, 0 other for current-skill)', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0] }] });
      writeAcceptedCellV9(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0 }, { reasoningEffortRequested: 'high' });
      const result = summarizeCampaign(dir);
      const cell = result.cells.find((c) => c.cell_key === 'claude-code-0');
      expect(cell.status).toBe('accepted');
      expect(cell.tokens).toEqual({ input: 1000, cached_input: 200, cache_write: 50, output: 500, reasoning_output: null });
      expect(cell.num_turns).toBe(1); // v9RecordFields' own fixed value
      expect(cell.total_cost_usd).toBeNull(); // v9RecordFields' own "not recorded" default
      expect(cell.output_bytes).toBe(2000); // acceptedRecord's own fixed value, a v1 field
      expect(cell.command_kind_counts).toEqual({ kmp_test: 1, gradle: 1, other: 0 });
    });
  });

  it('a v9 accepted cell under the no-skill/free condition gets the other-bash-inclusive mix sidecarFor produces there (1 kmp-test, 1 gradle, 1 other)', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0] }] });
      writeAcceptedCellV9(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'no-skill', roundIndex: 0 }, { reasoningEffortRequested: 'high' });
      const result = summarizeCampaign(dir);
      const cell = result.cells.find((c) => c.cell_key === 'claude-code-0');
      expect(cell.command_kind_counts).toEqual({ kmp_test: 1, gradle: 1, other: 1 });
    });
  });

  it('a real (non-null) total_cost_usd passes through when the record actually has one', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-baseline-v2', campaign_cell_indices: [0] }] });
      const cellDir = path.join(dir, 'private', 'codex-cli-0');
      mkdirSync(cellDir, { recursive: true });
      const record = {
        ...acceptedRecord({ runId: 'run-codex-cli-0', runtimeId: 'codex-cli', condition: 'current-skill', roundIndex: 0 }),
        ...v9RecordFields({ reasoningEffortRequested: 'low' }),
        total_cost_usd: nullableMetric(0.42),
        // usage.* must exactly equal the legacy tokens.* projection (schema v6 cross-field
        // constraint, validateRun) -- overriding one without the other is shape-invalid and falls
        // the whole cell through to status:'missing', which the assertion below would have caught,
        // but tokens is updated here too so this test actually exercises an accepted cell.
        usage: { source: 'runtime-reported', input: 900, cached_input: 150, cache_write: 0, output: 300, reasoning_output: 120, attributable_to_skill_load: { status: 'not-recorded', dimensions: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null }, unit: null, reason: 'runtime-does-not-report-skill-attribution' } },
        tokens: {
          input: { value: 900, reason: null }, output: { value: 300, reason: null },
          cache_read: { value: 150, reason: null }, cache_creation: { value: 0, reason: null },
        },
        // acceptedRecord's own default grading_checks:{value:[],reason:null} isn't enough on its
        // own -- validateRun requires the full GRADING_CHECK_NAMES set once schema>=5 (every real
        // helper above this test uses gradingChecks() precisely to satisfy this; this manual
        // construction was missing it, which silently made the record shape-invalid and fell it
        // through to status:'missing' entirely -- caught by asserting cell.status below).
        grading_checks: { value: gradingChecks(), reason: null },
      };
      const audit = sidecarFor(record);
      const auditText = JSON.stringify(audit, null, 2);
      record.accepted_audit = { schema: 10, relative_path: `audit/${record.run_id}.json`, sha256: createHash('sha256').update(auditText, 'utf8').digest('hex') };
      writeFileSync(path.join(cellDir, 'audit.json'), auditText);
      writeFileSync(path.join(cellDir, 'record.json'), JSON.stringify(record, null, 2));

      const result = summarizeCampaign(dir);
      const cell = result.cells.find((c) => c.cell_key === 'codex-cli-0');
      // A shape-invalid record silently falls through to status:'missing' (every new field then
      // reads as null too) -- asserting 'accepted' here is what would have caught this test's own
      // first draft, which had an incomplete grading_checks and silently asserted against a
      // 'missing' cell's nulls instead of a real accepted cell's values.
      expect(cell.status).toBe('accepted');
      expect(cell.total_cost_usd).toBe(0.42);
      // Codex DOES report reasoning_output -- confirms it is passed through, not hardcoded null
      // (the claude-code test above proves the null-for-claude direction).
      expect(cell.tokens.reasoning_output).toBe(120);
    });
  });

  it('a schema-8 (pre-v9) accepted cell gets tokens/output_bytes/command_kind_counts (v1-era fields, never gated on v9) but null num_turns/total_cost_usd (genuinely v9-only)', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0] }] });
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0 }); // schema 8, no v9 fields at all
      const result = summarizeCampaign(dir);
      const cell = result.cells.find((c) => c.cell_key === 'claude-code-0');
      expect(cell.tokens).toEqual({ input: 1000, cached_input: 200, cache_write: 50, output: 500, reasoning_output: null });
      expect(cell.output_bytes).toBe(2000);
      expect(cell.command_kind_counts).toEqual({ kmp_test: 1, gradle: 1, other: 0 });
      expect(cell.num_turns).toBeNull();
      expect(cell.total_cost_usd).toBeNull();
    });
  });

  it('a D3-negative-reclassified rejected cell gets real tokens (cell_metrics.usage IS available on a rejection) but null for the 4 accepted-only fields', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-baseline-v2', campaign_cell_indices: [0] }] });
      writeRejectedCell(dir, 'codex-cli-0', { runtimeId: 'codex-cli', condition: 'current-skill', roundIndex: 0, d3Qualifying: true });
      const result = summarizeCampaign(dir);
      const cell = result.cells.find((c) => c.cell_key === 'codex-cli-0');
      expect(cell.status).toBe('negative-d3');
      // writeRejectedCell's own fixed cell_metrics.usage values (input:400, cached_input:0,
      // cache_write:0, output:100, reasoning_output:10) -- confirms a rejection's real usage
      // survives through, not just an accepted cell's.
      expect(cell.tokens).toEqual({ input: 400, cached_input: 0, cache_write: 0, output: 100, reasoning_output: 10 });
      expect(cell.num_turns).toBeNull();
      expect(cell.total_cost_usd).toBeNull();
      expect(cell.output_bytes).toBeNull();
      expect(cell.command_kind_counts).toBeNull();
    });
  });

  it('a genuinely missing cell (no directory at all) gets null for every one of the new fields, including tokens', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0] }] });
      // Deliberately create no cell directory at all for claude-code-0.
      const result = summarizeCampaign(dir);
      const cell = result.cells.find((c) => c.cell_key === 'claude-code-0');
      expect(cell.status).toBe('missing');
      expect(cell.tokens).toBeNull();
      expect(cell.num_turns).toBeNull();
      expect(cell.total_cost_usd).toBeNull();
      expect(cell.output_bytes).toBeNull();
      expect(cell.command_kind_counts).toBeNull();
    });
  });

  it('the by_runtime_arm aggregates are unaffected by the new per-cell fields -- byte-identical to the same campaign summarized before this change would have produced', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0, 1] }] });
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0, matched: true, success: true });
      writeAcceptedCell(dir, 'claude-code-1', { runtimeId: 'claude-code', condition: 'no-skill', roundIndex: 1, matched: true, success: false });
      const result = summarizeCampaign(dir);
      const group = result.by_runtime_arm.find((g) => g.runtime_id === 'claude-code' && g.arm === 'product');
      // Exactly the same key set summarizeCampaign has always produced for by_runtime_arm -- no new
      // key leaked in here; the new fields live ONLY on cells[], never on the aggregate groups.
      expect(Object.keys(group).sort()).toEqual([
        'accepted', 'arm', 'counted', 'declared', 'duration_ms', 'full_answer_match', 'key_facts_match',
        'kmp_test_vs_gradle', 'missing', 'missing_reasons', 'negative_d3', 'runtime_id',
        'shell_commands_total', 'success', 'tokens', 'tool_calls_total',
      ].sort());
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Session isolation as evidence: cells[] publishes each cell's provider
// session id and whether its agent-state listing showed a change to anything a later session would
// load; an access scan of the transcripts (transcript-access-scan.mjs) excludes every cell that
// reached the corpus, the preregistration or a private-evidence path.
// ---------------------------------------------------------------------------------------------

const AGENT_STATE_CLEAN = {
  listed: true, files_before: 12,
  created: ['projects/p/sessions/s1.jsonl'], deleted: [], modified: ['history.jsonl'],
  context_relevant_before: [{ path: 'settings.json', size: 10, mtimeMs: 1700000000000 }],
  context_relevant_changed: [],
};
const AGENT_STATE_DIRTY = {
  listed: true, files_before: 12,
  created: ['projects/p/memory/MEMORY.md'], deleted: [], modified: [],
  context_relevant_before: [],
  context_relevant_changed: ['projects/p/memory/MEMORY.md'],
};
const AGENT_STATE_UNLISTED = { listed: false, reason: 'dir_unavailable' };

const claudeCampaignRuntimes = (count) => [{
  runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1',
  campaign_cell_indices: Array.from({ length: count }, (_, i) => i),
}];
/** A schema-v9 product cell `claude-code-<n>` with the given extra record fields. */
function writeV9Cell(dir, cellKey, extraRecordFields) {
  writeAcceptedCellV9(
    dir, cellKey,
    { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: Number(cellKey.split('-').pop()) },
    { reasoningEffortRequested: 'high', extraRecordFields },
  );
}
const cellOf = (result, key) => result.cells.find((c) => c.cell_key === key);

describe('summarizeCampaign -- session-isolation evidence on cells[] (session_id, agent_state_clean)', () => {
  it('an accepted cell publishes its provider session id, taken from record.session_id_observed', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: claudeCampaignRuntimes(1) });
      writeV9Cell(dir, 'claude-code-0', { session_id_observed: 'd3adb33f-0000-4000-8000-000000000001' });
      expect(cellOf(summarizeCampaign(dir), 'claude-code-0').session_id).toBe('d3adb33f-0000-4000-8000-000000000001');
    });
  });

  it('an older (schema 8) record publishes its session id too', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: claudeCampaignRuntimes(1) });
      writeAcceptedCell(dir, 'claude-code-0', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 0 });
      const cell = cellOf(summarizeCampaign(dir), 'claude-code-0');
      expect(cell.status).toBe('accepted');
      expect(cell.session_id).toBe('sess-run-claude-code-0');
    });
  });

  it('session_id is null when the record observed no session', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: claudeCampaignRuntimes(1) });
      writeV9Cell(dir, 'claude-code-0', { session_id_observed: null });
      const cell = cellOf(summarizeCampaign(dir), 'claude-code-0');
      expect(cell.status).toBe('accepted');
      expect(cell.session_id).toBeNull();
    });
  });

  it('agent_state_clean is true when the listing succeeded and no context-relevant file changed, although other files did', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: claudeCampaignRuntimes(1) });
      writeV9Cell(dir, 'claude-code-0', { agent_state: AGENT_STATE_CLEAN });
      const cell = cellOf(summarizeCampaign(dir), 'claude-code-0');
      expect(cell.status).toBe('accepted');
      expect(cell.agent_state_clean).toBe(true);
    });
  });

  it('agent_state_clean is false when the listing shows a change to a context-relevant file', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: claudeCampaignRuntimes(1) });
      writeV9Cell(dir, 'claude-code-0', { agent_state: AGENT_STATE_DIRTY });
      const cell = cellOf(summarizeCampaign(dir), 'claude-code-0');
      expect(cell.status).toBe('accepted');
      expect(cell.agent_state_clean).toBe(false);
    });
  });

  it('agent_state_clean is null when the config directory could not be listed', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: claudeCampaignRuntimes(1) });
      writeV9Cell(dir, 'claude-code-0', { agent_state: AGENT_STATE_UNLISTED });
      const cell = cellOf(summarizeCampaign(dir), 'claude-code-0');
      expect(cell.status).toBe('accepted');
      expect(cell.agent_state_clean).toBeNull();
    });
  });

  it('agent_state_clean is null on a record that has no agent_state (every record older than the field)', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: claudeCampaignRuntimes(2) });
      writeV9Cell(dir, 'claude-code-0', {});
      writeAcceptedCell(dir, 'claude-code-1', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 1 });
      const result = summarizeCampaign(dir);
      expect(cellOf(result, 'claude-code-0').status).toBe('accepted');
      expect(cellOf(result, 'claude-code-0').agent_state_clean).toBeNull();
      expect(cellOf(result, 'claude-code-1').status).toBe('accepted');
      expect(cellOf(result, 'claude-code-1').agent_state_clean).toBeNull();
    });
  });

  it('a record whose agent_state is malformed is a missing cell, never a clean one', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: claudeCampaignRuntimes(1) });
      writeV9Cell(dir, 'claude-code-0', { agent_state: { listed: true } });
      const cell = cellOf(summarizeCampaign(dir), 'claude-code-0');
      expect(cell.status).toBe('missing');
      expect(cell.reason).toBe('record_shape_invalid');
      expect(cell.agent_state_clean).toBeNull();
      expect(cell.session_id).toBeNull();
    });
  });

  it('a D3-negative rejected cell and a missing cell publish null for both keys: a rejection carries neither', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: [{ runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-baseline-v2', campaign_cell_indices: [0, 1] }] });
      writeRejectedCell(dir, 'codex-cli-0', { runtimeId: 'codex-cli', condition: 'current-skill', roundIndex: 0, d3Qualifying: true });
      // codex-cli-1 has no directory at all.
      const result = summarizeCampaign(dir);
      expect(cellOf(result, 'codex-cli-0').status).toBe('negative-d3');
      expect(cellOf(result, 'codex-cli-0').session_id).toBeNull();
      expect(cellOf(result, 'codex-cli-0').agent_state_clean).toBeNull();
      expect(cellOf(result, 'codex-cli-1').status).toBe('missing');
      expect(cellOf(result, 'codex-cli-1').session_id).toBeNull();
      expect(cellOf(result, 'codex-cli-1').agent_state_clean).toBeNull();
    });
  });

  it('adds no top-level key and keeps the summary schema number: the new keys live on cells[] only', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: claudeCampaignRuntimes(1) });
      writeV9Cell(dir, 'claude-code-0', { agent_state: AGENT_STATE_CLEAN });
      const result = summarizeCampaign(dir);
      expect(CAMPAIGN_SUMMARY_SCHEMA).toBe(2);
      expect(result.schema).toBe(2);
      expect(Object.keys(result).sort()).toEqual([
        'benchmark_eligible_counts', 'by_runtime_arm', 'campaign_id', 'cells', 'limitations', 'provenance',
        'provider_mode', 'reason_code', 'scenario_id', 'schema', 'summary_status',
      ]);
      for (const group of result.by_runtime_arm) {
        expect(Object.keys(group)).not.toContain('session_id');
        expect(Object.keys(group)).not.toContain('agent_state_clean');
      }
    });
  });
});

describe('the Evidence2 committed campaign summary', () => {
  const EVIDENCE2_SUMMARY = path.join(fileURLToPath(new URL('../..', import.meta.url)), 'tools', 'runs', 'evidence2-agentic-benchmark-2026-09-30', 'campaign-summary.json');

  it('still validates: the new cell keys are optional, and it carries neither', () => {
    const committed = JSON.parse(readFileSync(EVIDENCE2_SUMMARY, 'utf8'));
    expect(committed.schema).toBe(CAMPAIGN_SUMMARY_SCHEMA);
    expect(validateSummary(committed)).toEqual([]);
    expect(committed.cells.length).toBeGreaterThan(0);
    expect(committed.cells.some((c) => 'session_id' in c || 'agent_state_clean' in c)).toBe(false);
  });
});

describe('accessScanEffects -- what an access scan does to a campaign summary', () => {
  const CAMPAIGN = 'campaign-under-test';
  const scan = (cells, extra = {}) => ({ schema: 1, campaign_id: CAMPAIGN, patterns: ['corpus', 'preregistration', 'private_evidence'], cells, ...extra });
  const hitCell = (cell_key, hits = [{ label: 'corpus', count: 2 }]) => ({ cell_key, scanned: true, hits });
  const cleanCell = (cell_key) => ({ cell_key, scanned: true, hits: [] });
  const missingCell = (cell_key) => ({ cell_key, scanned: false, hits: [] });

  it('excludes a cell with a hit and names it in a ground_truth_access limitation that carries the labels and counts', () => {
    const effects = accessScanEffects(scan([hitCell('claude-code-1', [{ label: 'corpus', count: 2 }, { label: 'private_root', count: 1 }])]), CAMPAIGN);
    expect([...effects.excludeCellKeys]).toEqual(['claude-code-1']);
    expect(effects.limitations).toHaveLength(1);
    expect(effects.limitations[0]).toContain('ground_truth_access');
    expect(effects.limitations[0]).toContain('claude-code-1');
    expect(effects.limitations[0]).toContain('corpus x2');
    expect(effects.limitations[0]).toContain('private_root x1');
  });

  it('leaves a clean, scanned cell alone: nothing excluded, nothing reported', () => {
    const effects = accessScanEffects(scan([cleanCell('claude-code-0')]), CAMPAIGN);
    expect(effects.excludeCellKeys.size).toBe(0);
    expect(effects.limitations).toEqual([]);
  });

  it('accepts a scan with no cells at all', () => {
    const effects = accessScanEffects(scan([]), CAMPAIGN);
    expect(effects.excludeCellKeys.size).toBe(0);
    expect(effects.limitations).toEqual([]);
  });

  it('keeps a cell whose transcript is missing and reports that access was not verified for it', () => {
    const effects = accessScanEffects(scan([missingCell('codex-cli-1')]), CAMPAIGN);
    expect(effects.excludeCellKeys.size).toBe(0);
    expect(effects.limitations).toHaveLength(1);
    expect(effects.limitations[0]).toContain('transcript missing: access not verified');
    expect(effects.limitations[0]).toContain('codex-cli-1');
  });

  it('orders the limitations by cell key, whatever the order of the scan', () => {
    const effects = accessScanEffects(scan([missingCell('codex-cli-0'), hitCell('claude-code-2'), hitCell('claude-code-0')]), CAMPAIGN);
    expect(effects.limitations.map((l) => /(claude-code-\d|codex-cli-\d)/.exec(l)[1])).toEqual(['claude-code-0', 'claude-code-2', 'codex-cli-0']);
    expect([...effects.excludeCellKeys].sort()).toEqual(['claude-code-0', 'claude-code-2']);
  });

  it('rejects a scan made for another campaign instead of applying it', () => {
    expect(() => accessScanEffects(scan([hitCell('claude-code-0')], { campaign_id: 'another-campaign' }), CAMPAIGN)).toThrow(/access scan.*campaign/);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'scan'],
    ['another schema number', scan([], { schema: 2 })],
    ['cells that is not an array', scan('nope')],
    ['a cell with no cell_key', scan([{ scanned: true, hits: [] }])],
    ['a cell whose scanned is not a boolean', scan([{ cell_key: 'a', scanned: 'yes', hits: [] }])],
    ['a cell whose hits is not an array', scan([{ cell_key: 'a', scanned: true, hits: 'x' }])],
    ['a hit with a zero count', scan([hitCell('a', [{ label: 'corpus', count: 0 }])])],
    ['a hit with a fractional count', scan([hitCell('a', [{ label: 'corpus', count: 1.5 }])])],
    ['a hit with an empty label', scan([hitCell('a', [{ label: '', count: 1 }])])],
    ['a hit with no label at all', scan([hitCell('a', [{ count: 1 }])])],
    ['a hit whose label is free text rather than a lowercase word', scan([hitCell('a', [{ label: 'C:\\some\\path', count: 1 }])])],
    ['a cell listed twice', scan([cleanCell('a'), cleanCell('a')])],
    ['hits on a cell that was not scanned', scan([{ cell_key: 'a', scanned: false, hits: [{ label: 'corpus', count: 1 }] }])],
  ])('rejects a malformed scan: %s', (_what, bad) => {
    expect(() => accessScanEffects(bad, CAMPAIGN)).toThrow(/access scan/);
  });
});

describe('summarizeCampaign -- { accessScan }', () => {
  const scan = (cells, extra = {}) => ({ schema: 1, campaign_id: 'campaign-under-test', patterns: ['corpus'], cells, ...extra });
  const hitCell = (cell_key) => ({ cell_key, scanned: true, hits: [{ label: 'corpus', count: 1 }] });

  function threeCellCampaign(dir) {
    writeManifest(dir, { runtimes: claudeCampaignRuntimes(3) });
    for (const i of [0, 1, 2]) writeAcceptedCell(dir, `claude-code-${i}`, { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: i });
  }

  it('drops a cell with a hit exactly as excludeCellKeys drops it: same cells, groups and provenance, plus one limitation', () => {
    withTempDir((dir) => {
      threeCellCampaign(dir);
      const viaScan = summarizeCampaign(dir, new Set(), { accessScan: scan([hitCell('claude-code-1')]) });
      const viaExclusion = summarizeCampaign(dir, new Set(['claude-code-1']));
      expect(viaScan.cells.map((c) => c.cell_key)).toEqual(['claude-code-0', 'claude-code-2']);
      expect(viaScan.cells).toEqual(viaExclusion.cells);
      expect(viaScan.by_runtime_arm).toEqual(viaExclusion.by_runtime_arm);
      expect(viaScan.provenance).toEqual(viaExclusion.provenance);
      expect(viaScan.by_runtime_arm[0].declared).toBe(2);
      expect(viaScan.limitations.slice(0, viaExclusion.limitations.length)).toEqual(viaExclusion.limitations);
      expect(viaScan.limitations).toHaveLength(viaExclusion.limitations.length + 1);
      expect(viaScan.limitations.at(-1)).toContain('ground_truth_access');
      expect(viaScan.limitations.at(-1)).toContain('claude-code-1');
    });
  });

  it('composes with excludeCellKeys: a cell flagged by either is excluded', () => {
    withTempDir((dir) => {
      threeCellCampaign(dir);
      const result = summarizeCampaign(dir, new Set(['claude-code-0']), { accessScan: scan([hitCell('claude-code-2')]) });
      expect(result.cells.map((c) => c.cell_key)).toEqual(['claude-code-1']);
    });
  });

  it('keeps a cell whose transcript is missing in the summary, and says access was not verified for it', () => {
    withTempDir((dir) => {
      threeCellCampaign(dir);
      const result = summarizeCampaign(dir, new Set(), { accessScan: scan([{ cell_key: 'claude-code-1', scanned: false, hits: [] }]) });
      expect(result.cells.map((c) => c.cell_key)).toEqual(['claude-code-0', 'claude-code-1', 'claude-code-2']);
      expect(result.limitations.at(-1)).toContain('transcript missing: access not verified');
      expect(result.limitations.at(-1)).toContain('claude-code-1');
    });
  });

  it('a scan with nothing to report reproduces the output of no scan at all, byte for byte', () => {
    withTempDir((dir) => {
      threeCellCampaign(dir);
      const clean = scan([0, 1, 2].map((i) => ({ cell_key: `claude-code-${i}`, scanned: true, hits: [] })));
      expect(JSON.stringify(summarizeCampaign(dir, new Set(), { accessScan: clean }))).toBe(JSON.stringify(summarizeCampaign(dir)));
    });
  });

  it('throws on a scan made for another campaign, rather than silently applying it', () => {
    withTempDir((dir) => {
      threeCellCampaign(dir);
      expect(() => summarizeCampaign(dir, new Set(), { accessScan: scan([hitCell('claude-code-1')], { campaign_id: 'another-campaign' }) })).toThrow(/access scan.*campaign/);
    });
  });

  it('leaves a refused (not live) summary exactly as it was, whatever the scan says', () => {
    withTempDir((dir) => {
      writeManifest(dir, { providerMode: 'fake' });
      const result = summarizeCampaign(dir, new Set(), { accessScan: scan([hitCell('claude-code-1')]) });
      expect(result.summary_status).toBe('refused');
      expect(result.limitations).toEqual([]);
    });
  });
});

describe('CLI entry point -- --access-scan <file>', () => {
  const runSummary = (...args) => spawnSync(process.execPath, [CAMPAIGN_SUMMARY_SCRIPT, ...args], { encoding: 'utf8' });
  function campaign(dir, count) {
    writeManifest(dir, { runtimes: claudeCampaignRuntimes(count) });
    for (let i = 0; i < count; i += 1) writeAcceptedCell(dir, `claude-code-${i}`, { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: i });
  }
  function writeScan(dir, cells, extra = {}) {
    const scanPath = path.join(dir, 'access-scan.json');
    writeFileSync(scanPath, JSON.stringify({ schema: 1, campaign_id: 'campaign-under-test', patterns: ['corpus'], cells, ...extra }));
    return scanPath;
  }
  const hitCell = (cell_key) => ({ cell_key, scanned: true, hits: [{ label: 'corpus', count: 3 }] });

  it('excludes a cell the scan flags: gone from cells[] and from the declared count', () => {
    withTempDir((dir) => {
      campaign(dir, 2);
      const result = runSummary(dir, '--access-scan', writeScan(dir, [hitCell('claude-code-1')]));
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.cells.map((c) => c.cell_key)).toEqual(['claude-code-0']);
      expect(parsed.by_runtime_arm[0].declared).toBe(1);
    });
  });

  it('reports the exclusion as a ground_truth_access limitation that names the cell', () => {
    withTempDir((dir) => {
      campaign(dir, 2);
      const parsed = JSON.parse(runSummary(dir, '--access-scan', writeScan(dir, [hitCell('claude-code-1')])).stdout);
      const entry = parsed.limitations.find((l) => l.includes('ground_truth_access'));
      expect(entry).toContain('claude-code-1');
    });
  });

  it('composes with --exclude-cells: a cell flagged by either file is excluded', () => {
    withTempDir((dir) => {
      campaign(dir, 3);
      const classificationPath = path.join(dir, 'infra-flake-classification.json');
      writeFileSync(classificationPath, JSON.stringify({
        schema: 1, classifier_version: 1,
        cells: [{ cell_key: 'claude-code-0', runtime_id: 'claude-code', arm: 'product', infra_flake_suspected: true, reason: 'signature_match' }],
        rollup: [],
      }));
      const result = runSummary(dir, '--access-scan', writeScan(dir, [hitCell('claude-code-2')]), '--exclude-cells', classificationPath);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).cells.map((c) => c.cell_key)).toEqual(['claude-code-1']);
    });
  });

  it('keeps a cell whose transcript is missing, with a "transcript missing: access not verified" limitation', () => {
    withTempDir((dir) => {
      campaign(dir, 2);
      const parsed = JSON.parse(runSummary(dir, '--access-scan', writeScan(dir, [{ cell_key: 'claude-code-1', scanned: false, hits: [] }])).stdout);
      expect(parsed.cells.map((c) => c.cell_key)).toEqual(['claude-code-0', 'claude-code-1']);
      expect(parsed.limitations.some((l) => l.includes('transcript missing: access not verified') && l.includes('claude-code-1'))).toBe(true);
    });
  });

  it('a scan with nothing to report leaves the output byte-identical to a run without --access-scan', () => {
    withTempDir((dir) => {
      campaign(dir, 2);
      const clean = writeScan(dir, [0, 1].map((i) => ({ cell_key: `claude-code-${i}`, scanned: true, hits: [] })));
      expect(runSummary(dir, '--access-scan', clean).stdout).toBe(runSummary(dir).stdout);
    });
  });

  it('--markdown lists the access-scan limitations too', () => {
    withTempDir((dir) => {
      campaign(dir, 2);
      const markdownPath = path.join(dir, 'out.md');
      const result = runSummary(dir, '--access-scan', writeScan(dir, [hitCell('claude-code-1')]), '--markdown', markdownPath);
      expect(result.status).toBe(0);
      expect(readFileSync(markdownPath, 'utf8')).toContain('ground_truth_access');
    });
  });

  it('exits 1 and prints no summary when the scan was made for another campaign', () => {
    withTempDir((dir) => {
      campaign(dir, 2);
      const result = runSummary(dir, '--access-scan', writeScan(dir, [hitCell('claude-code-1')], { campaign_id: 'another-campaign' }));
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/access scan/);
    });
  });

  it.each([
    ['is not JSON', 'this is not json'],
    ['has another schema number', JSON.stringify({ schema: 2, campaign_id: 'campaign-under-test', cells: [] })],
    ['has a malformed cell', JSON.stringify({ schema: 1, campaign_id: 'campaign-under-test', cells: [{ scanned: true, hits: [] }] })],
  ])('exits 1 and prints no summary when the scan file %s', (_what, text) => {
    withTempDir((dir) => {
      campaign(dir, 2);
      const scanPath = path.join(dir, 'access-scan.json');
      writeFileSync(scanPath, text);
      const result = runSummary(dir, '--access-scan', scanPath);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/access scan/);
    });
  });

  it('exits 1 and prints no summary when the scan file does not exist', () => {
    withTempDir((dir) => {
      campaign(dir, 2);
      const result = runSummary(dir, '--access-scan', path.join(dir, 'no-such-scan.json'));
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
    });
  });

  it('exits 1 with the usage line when --access-scan has no value', () => {
    withTempDir((dir) => {
      campaign(dir, 2);
      const result = runSummary(dir, '--access-scan');
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/usage/i);
    });
  });

  it('names --access-scan in its usage line, next to the options it already had', () => {
    const result = runSummary(path.join(os.tmpdir(), 'aecs-never-created'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--access-scan');
    expect(result.stderr).toContain('--exclude-cells');
    expect(result.stderr).toContain('--markdown');
  });
});

// output_bytes_kind on cells[]: what the cell's output_bytes measures -- the tool results returned to the
// model (claude-code) or the command output as logged (codex-cli). Copied from an accepted record; null for
// a record that predates the field, and for a rejected or missing cell, which carry no such field.
describe('summarizeCampaign -- output_bytes_kind on cells[]', () => {
  const codexRuntimes = (count) => [{
    runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-baseline-v2',
    campaign_cell_indices: Array.from({ length: count }, (_, i) => i),
  }];
  const writeCodexV9Cell = (dir, cellKey, extraRecordFields) => writeAcceptedCellV9(
    dir, cellKey,
    { runtimeId: 'codex-cli', condition: 'current-skill', roundIndex: Number(cellKey.split('-').pop()) },
    { reasoningEffortRequested: 'low', extraRecordFields },
  );

  it('an accepted claude-code cell carries its record\'s output_bytes_kind: tool_results', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: claudeCampaignRuntimes(1) });
      writeV9Cell(dir, 'claude-code-0', { output_bytes_kind: 'tool_results' });
      const cell = cellOf(summarizeCampaign(dir), 'claude-code-0');
      expect(cell.status).toBe('accepted');
      expect(cell.output_bytes_kind).toBe('tool_results');
    });
  });

  it('an accepted codex-cli cell carries its record\'s output_bytes_kind: command_output', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: codexRuntimes(1) });
      writeCodexV9Cell(dir, 'codex-cli-0', { output_bytes_kind: 'command_output' });
      const cell = cellOf(summarizeCampaign(dir), 'codex-cli-0');
      expect(cell.status).toBe('accepted');
      expect(cell.output_bytes_kind).toBe('command_output');
    });
  });

  it('is null on a record that predates the field, whether schema 9 without it or schema 8', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: claudeCampaignRuntimes(2) });
      writeV9Cell(dir, 'claude-code-0', {});
      writeAcceptedCell(dir, 'claude-code-1', { runtimeId: 'claude-code', condition: 'current-skill', roundIndex: 1 });
      const result = summarizeCampaign(dir);
      expect(cellOf(result, 'claude-code-0').status).toBe('accepted');
      expect(cellOf(result, 'claude-code-0').output_bytes_kind).toBeNull();
      expect(cellOf(result, 'claude-code-1').status).toBe('accepted');
      expect(cellOf(result, 'claude-code-1').output_bytes_kind).toBeNull();
    });
  });

  it('a record whose label does not match its runtime is a missing cell, never a labelled one', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: claudeCampaignRuntimes(1) });
      writeV9Cell(dir, 'claude-code-0', { output_bytes_kind: 'command_output' });
      const cell = cellOf(summarizeCampaign(dir), 'claude-code-0');
      expect(cell.status).toBe('missing');
      expect(cell.reason).toBe('record_shape_invalid');
      expect(cell.output_bytes_kind).toBeNull();
    });
  });

  it('a D3-negative rejected cell and a missing cell publish null: a rejection carries no such field', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: codexRuntimes(2) });
      writeRejectedCell(dir, 'codex-cli-0', { runtimeId: 'codex-cli', condition: 'current-skill', roundIndex: 0, d3Qualifying: true });
      const result = summarizeCampaign(dir);
      expect(cellOf(result, 'codex-cli-0').status).toBe('negative-d3');
      expect(cellOf(result, 'codex-cli-0').output_bytes_kind).toBeNull();
      expect(cellOf(result, 'codex-cli-1').status).toBe('missing');
      expect(cellOf(result, 'codex-cli-1').output_bytes_kind).toBeNull();
    });
  });

  it('adds no top-level or by_runtime_arm key: the new key lives on cells[] only, and the schema number stays', () => {
    withTempDir((dir) => {
      writeManifest(dir, { runtimes: codexRuntimes(1) });
      writeCodexV9Cell(dir, 'codex-cli-0', { output_bytes_kind: 'command_output' });
      const result = summarizeCampaign(dir);
      expect(result.schema).toBe(CAMPAIGN_SUMMARY_SCHEMA);
      expect(Object.keys(result).sort()).toEqual([
        'benchmark_eligible_counts', 'by_runtime_arm', 'campaign_id', 'cells', 'limitations', 'provenance',
        'provider_mode', 'reason_code', 'scenario_id', 'schema', 'summary_status',
      ]);
      for (const group of result.by_runtime_arm) expect(Object.keys(group)).not.toContain('output_bytes_kind');
    });
  });
});

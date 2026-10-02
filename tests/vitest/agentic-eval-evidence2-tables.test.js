// tests/vitest/agentic-eval-evidence2-tables.test.js -- direct unit + golden-table coverage for
// tools/agentic-eval/evidence2-tables.mjs (WO-C16). Fixture style mirrors
// agentic-eval-campaign-summary.test.js's own schema-valid record+sidecar builders
// (acceptedRecord/sidecarFor/v9RecordFields/writeAcceptedCellV9/writeManifest), duplicated and
// extended here (not imported -- each of these sibling files stays independently runnable, the
// same policy this whole file family already follows) to write a REAL, on-disk, n=4-per-arm-per-
// runtime campaign and run it through the real summarizeCampaign/buildCostEstimate/classifyCampaign
// -- never a hand-relaxed n=4 gate, never a hand-built summary object standing in for one.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

import { summarizeCampaign } from '../../tools/agentic-eval/campaign-summary.mjs';
import { buildCostEstimate } from '../../tools/agentic-eval/cost-estimate.mjs';
import { classifyCampaign } from '../../tools/agentic-eval/infra-flake-classifier.mjs';
import { GRADING_CHECK_NAMES } from '../../tools/agentic-eval/graders.mjs';
import { computeExecutionProfileSha256 } from '../../tools/agentic-eval/registries.mjs';
import { computeRunProvenanceSha256 } from '../../tools/agentic-eval/accepted-run-audit.mjs';
import {
  buildPerCellTableLines, buildAggregateTableLines, buildSensitivityLines, buildProvenanceLines,
  buildCostLines, renderEvidence2TablesBlock, buildEvidence2TablesFromCampaign, insertBetweenMarkers,
  loadFamilyFields, evidenceNumberOfTargetDoc, EVIDENCE2_TABLES_START, EVIDENCE2_TABLES_END,
} from '../../tools/agentic-eval/evidence2-tables.mjs';

const EVIDENCE2_TABLES_SCRIPT = fileURLToPath(new URL('../../tools/agentic-eval/evidence2-tables.mjs', import.meta.url));

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
const MULTI_MODULE_SCENARIO_ID = 'multi-module-test-failures';

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aeet-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function passingCheck(name) {
  return { name, passed: true, detail: 'ok', evidence_event_indices: [] };
}
function gradingChecks() {
  return GRADING_CHECK_NAMES.map((name) => passingCheck(name));
}

// A schema-9, ACCEPTED record -- v8 base (acceptedRecord) + the 13 v9 recording fields, plus the
// per-cell overrides (usage/duration/tool-calls/turns/cost) this file's own fixture needs to produce
// non-degenerate medians and ranges (the shared sibling helpers this pattern is adapted from always
// use one fixed value per field; WO-C16's golden tables need real variation to be a meaningful test).
// multiModule: the record of a multi-module-tests campaign (the family's own scenario id, family label and claim-only
// outcome assessment); mismatchFields: the answer fields the grader found mismatched (default: the coverage family's one).
function acceptedRecordV9({ runId, runtimeId, condition, roundIndex, matched, success, usage, durationMs, toolCallsValue, numTurns, reasoningEffortRequested, reasoningEffortSource, totalCostUsd = null, multiModule = false, mismatchFields = null }) {
  const productAccessMode = condition === 'current-skill' ? 'product-assisted' : 'free-baseline-no-product';
  return {
    schema: 9, run_id: runId, run_kind: 'scenario', benchmark_eligible: true,
    scenario_id: multiModule ? MULTI_MODULE_SCENARIO_ID : SCENARIO_ID, query_id: null, condition,
    skill_source_sha: condition === 'current-skill' ? '2112aed96686ee159f851e00c2efa553e58473fc' : null,
    kmp_test_cli_version: '0.16.0', kmp_test_cli_source_sha: 'c1cd93898b810601e1494e84c75d9ef354927afd',
    resolved_kmp_test_executable_path: 'ignored-in-tests',
    model_requested: runtimeId === 'claude-code' ? 'claude-sonnet-5' : 'gpt-5.6-terra',
    model_resolved: runtimeId === 'claude-code' ? 'claude-sonnet-5' : 'gpt-5.6-terra',
    session_id_observed: `sess-${runId}`,
    claude_code_version: runtimeId === 'claude-code' ? '2.1.238' : null,
    repo_commit: 'c1cd93898b810601e1494e84c75d9ef354927afd',
    project_alias: 'nowinandroid', project_commit: '7d45eae4f8720a0c77f507712ba2437ff974b6ed',
    project_url: 'https://github.com/android/nowinandroid', platform: 'windows',
    family: multiModule ? 'multi-module-tests' : 'coverage', cache_state: 'cold', daemon_policy: 'disabled-via-gradle-user-home-properties',
    env_allowlist_profile: 'narrow', seed: 20260929, order_index: roundIndex,
    started_at: '2026-09-29T09:00:00.000Z', ended_at: '2026-09-29T09:02:00.000Z', wall_clock_ms: durationMs,
    skill_available: { value: condition === 'current-skill', reason: null },
    skill_invocation_attempted: { value: condition === 'current-skill', reason: null },
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
    accepted_audit: null, // stamped by writeAcceptedCellV9
    tokens: {
      input: { value: usage.input, reason: null }, output: { value: usage.output, reason: null },
      cache_read: { value: usage.cached_input, reason: null }, cache_creation: { value: usage.cache_write ?? 0, reason: null },
    },
    usage: {
      source: 'runtime-reported', input: usage.input, cached_input: usage.cached_input,
      cache_write: usage.cache_write ?? 0, output: usage.output, reasoning_output: usage.reasoning_output ?? null,
      attributable_to_skill_load: {
        status: 'not-recorded',
        dimensions: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null },
        unit: null,
        reason: condition === 'no-skill' ? 'condition-no-skill' : 'runtime-does-not-report-skill-attribution',
      },
    },
    tool_calls_total: { value: toolCallsValue, reason: null },
    shell_commands_total: { value: condition === 'current-skill' ? 2 : 3, reason: null },
    test_invocations_total: { value: 1, reason: null }, retries: { value: 0, reason: null },
    output_bytes: { value: 2000, reason: null }, stream_json_bytes: { value: 40000, reason: null },
    human_interventions: { value: 0, reason: null },
    terminated: false, termination_reason: null, exit_code: 0, permission_mode_used: 'bypassPermissions',
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
      schema: 2, task_outcome_matched: matched, task_outcome_reason: matched ? 'matched' : 'mismatched',
      answer_protocol_matched: true,
      // The multi-module family binds no provider evidence to the answer: claim only.
      provider_evidence_kind: multiModule ? 'claim-only' : 'kmp-test-envelope',
      provider_evidence_status: multiModule ? 'unavailable' : matched ? 'matched' : 'mismatched',
      product_e2e_success: multiModule ? null : condition === 'current-skill' ? success : null,
      task_outcome_mismatch_fields: mismatchFields ?? (matched ? [] : ['module']),
      task_outcome_unexpected_key_count: 0,
    },
    product_access_mode: productAccessMode,
    reasoning_effort_requested: reasoningEffortRequested,
    reasoning_effort_source: reasoningEffortSource,
    served_model_snapshot: { value: runtimeId === 'claude-code' ? 'claude-sonnet-5' : 'gpt-5.6-terra', reason: null },
    argv_sha256: 'a'.repeat(64), delivered_prompt_sha256: 'b'.repeat(64),
    treatment_delivery_sha256: condition === 'current-skill' ? { value: 'd'.repeat(64), reason: null } : { value: null, reason: 'condition-no-skill' },
    env_keys: ['PATH'], executed_commands: [],
    max_budget_usd: { value: 2, reason: null }, timeout_ms: 1800000,
    result_subtype: { value: 'success', reason: null },
    num_turns: { value: numTurns, reason: null },
    total_cost_usd: { value: totalCostUsd, reason: totalCostUsd === null ? 'not present on this runtime\'s result event schema' : null },
  };
}

// Same tool_calls[] shape (1 skill/other-bash + 1 kmp-test + 1 gradle) as
// agentic-eval-campaign-summary.test.js's own sidecarFor -- verified valid there; kept fixed here
// since this file varies OTHER fields (duration/usage/turns) for meaningful medians, not the
// command-kind mix itself.
function sidecarFor(record) {
  const toolCalls = [
    {
      ordinal: 0, tool_use_event_index: 0, tool_result_event_index: 1,
      tool_kind: record.condition === 'current-skill' ? 'target-skill' : 'other-bash',
      operation: null, plan_only: record.condition === 'current-skill' ? null : false,
      policy_decision: 'not-applicable', result_status: 'success', phase: 'no-signal',
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

function writeAcceptedCellV9(campaignDir, cellKey, fields) {
  const cellDir = path.join(campaignDir, 'private', cellKey);
  mkdirSync(cellDir, { recursive: true });
  const record = acceptedRecordV9({ runId: `run-${cellKey}`, ...fields });
  const audit = sidecarFor(record);
  const auditText = JSON.stringify(audit, null, 2);
  const sha256 = createHash('sha256').update(auditText, 'utf8').digest('hex');
  record.accepted_audit = { schema: 10, relative_path: `audit/${record.run_id}.json`, sha256 };
  writeFileSync(path.join(cellDir, 'audit.json'), auditText);
  writeFileSync(path.join(cellDir, 'record.json'), JSON.stringify(record, null, 2));
}

function writeManifest(campaignDir) {
  const manifest = {
    schema: 1, campaign_id: 'wo-c16-golden-campaign', scenario_id: SCENARIO_ID, seed: 20260929, provider_mode: 'live',
    runtimes: [
      { runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: [0, 1, 2, 3, 4, 5, 6, 7], max_budget_usd: 2.0 },
      { runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-baseline-v2', campaign_cell_indices: [0, 1, 2, 3, 4, 5, 6, 7], max_budget_usd: null },
    ],
  };
  writeFileSync(path.join(campaignDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

// A real, on-disk, n=4-per-arm-per-runtime golden campaign (8 cells x 2 runtimes = 16 total).
// order_index 0,2,4,6 = product (current-skill); 1,3,5,7 = free (no-skill) -- armFor's own mapping.
// Deliberately varied duration/usage/turns per replicate (base + i*step) so medians/ranges are real,
// not degenerate; Codex carries a real reasoning_output on every cell (schema-2 per-cell shape);
// Claude and Codex use DIFFERENT reasoning_effort_source, so the provenance table's own two rows are
// a genuine, discriminating check, not coincidentally-equal values.
function writeGoldenCampaign(dir) {
  writeManifest(dir);
  for (let i = 0; i < 8; i++) {
    const condition = i % 2 === 0 ? 'current-skill' : 'no-skill';
    const arm = condition === 'current-skill' ? 'product' : 'free';
    const rep = Math.floor(i / 2); // 0..3 within each arm

    writeAcceptedCellV9(dir, `claude-code-${i}`, {
      runtimeId: 'claude-code', condition, roundIndex: i, matched: true, success: condition === 'current-skill',
      usage: { input: 1000 + rep * 100, cached_input: 200 + rep * 10, cache_write: 50, output: 500 + rep * 20 },
      durationMs: 100000 + rep * 10000, toolCallsValue: 3, numTurns: 1 + rep,
      reasoningEffortRequested: 'high', reasoningEffortSource: 'harness-pinned-cli-flag',
    });

    writeAcceptedCellV9(dir, `codex-cli-${i}`, {
      runtimeId: 'codex-cli', condition, roundIndex: i, matched: true, success: condition === 'current-skill',
      usage: { input: 4000 + rep * 200, cached_input: 3000 + rep * 100, cache_write: 0, output: 300 + rep * 15, reasoning_output: 40 + rep * 5 },
      durationMs: 150000 + rep * 12000, toolCallsValue: 3, numTurns: 2 + rep,
      reasoningEffortRequested: 'low', reasoningEffortSource: 'model-registry-default-reasoning-mode',
    });
  }
}

describe('evidence2-tables.mjs (WO-C16): golden n=4-per-arm campaign, real summarizeCampaign/buildCostEstimate/classifyCampaign', () => {
  it('buildPerCellTableLines: 16 real rows (2 header + 16 data), every declared column present and correctly sourced', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const summary = summarizeCampaign(dir);
      expect(summary.summary_status).toBe('ok');
      const costResult = buildCostEstimate(dir);
      expect(costResult.ok, costResult.reason).toBe(true);
      const infraFlake = classifyCampaign(dir);

      const lines = buildPerCellTableLines(summary, costResult.doc, infraFlake);
      expect(lines).toHaveLength(2 + 16);
      expect(lines[0]).toBe('| runtime | arm | round | status | key facts | full answer | success | duration ms | tool calls | shell commands | tokens | turns | cost | infra-flake |');

      // Codex round 0 (product, rep 0): reasoning_output 40 is real and tracked -> shown, never
      // omitted or zero-filled (WO-C13 residual's own guarantee, exercised here through real data).
      const codex0 = lines.find((l) => l.includes('| codex-cli | product | 0 |'));
      expect(codex0).toBeDefined();
      expect(codex0).toContain('reasoning 40');
      expect(codex0).toContain('kmp-test 1, gradle 1, other 0'); // target-skill isn't a shell command; kmp-test+gradle from the 2 Bash calls
      expect(codex0).toContain('| yes | yes | yes |'); // matched:true, success:true on a product cell
      expect(codex0).toContain('| unknown |'); // no transcript.jsonl written -> infra-flake-classifier can't rule it in or out

      // Claude round 1 (free, rep 0): success is n/a off the product arm, never a fabricated yes/no.
      const claude1 = lines.find((l) => l.includes('| claude-code | free | 1 |'));
      expect(claude1).toContain('| n/a |'); // success column, free arm
      expect(claude1).toContain('kmp-test 1, gradle 1, other 1'); // no-skill: other-bash IS a shell command here
      expect(claude1).not.toContain('reasoning'); // Claude never carries reasoning_output at all
    });
  });

  it('buildAggregateTableLines: real x/n rates and median/min/max ranges across the 4 replicates per arm', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const summary = summarizeCampaign(dir);
      const lines = buildAggregateTableLines(summary);
      expect(lines).toHaveLength(2 + 4); // header + sep + 4 (runtime x arm) groups

      // Claude product: duration_ms = 100000,110000,120000,130000 -> median 115000, min 100000, max 130000.
      const claudeProduct = lines.find((l) => l.includes('| claude-code | product |'));
      expect(claudeProduct).toContain('4/4'); // key facts (all matched:true)
      expect(claudeProduct).toContain('median 115000, min 100000, max 130000 (n=4)');
      // turns = 1,2,3,4 -> median 2.5.
      expect(claudeProduct).toContain('median 2.5, min 1, max 4 (n=4)');

      // Codex free: duration_ms = 150000,162000,174000,186000 -> median 168000.
      const codexFree = lines.find((l) => l.includes('| codex-cli | free |'));
      expect(codexFree).toContain('median 168000, min 150000, max 186000 (n=4)');
      expect(codexFree).toContain('reasoning'); // tokens-by-type median includes a real reasoning figure
    });
  });

  it('buildSensitivityLines: excludes a real infra-flake-suspected cell end to end -- fewer cells, a named exclusion line, and the group it belonged to shrinks from n=4 to n=3', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const summary = summarizeCampaign(dir);
      const infraFlake = classifyCampaign(dir);
      // Real classifier output is "unknown" for every cell here (no transcript.jsonl was written --
      // this fixture's point is the aggregate/cost machinery, not flake DETECTION, which is
      // infra-flake-classifier.mjs's own test suite's job) -- force ONE cell to true so the
      // exclusion PATH itself is genuinely exercised end to end, clearly labeled as such.
      const target = infraFlake.cells.find((c) => c.cell_key === 'codex-cli-0');
      target.infra_flake_suspected = true;

      const excludedCellKeys = infraFlake.cells.filter((c) => c.infra_flake_suspected === true).map((c) => c.cell_key);
      expect(excludedCellKeys).toEqual(['codex-cli-0']);
      const sensitivitySummary = summarizeCampaign(dir, new Set(excludedCellKeys));

      const lines = buildSensitivityLines(sensitivitySummary, excludedCellKeys);
      expect(lines[0]).toBe('### Sensitivity (infra-flake-suspected cells excluded)');
      expect(lines).toContain('Excluded cells: codex-cli-0.');
      const codexProduct = lines.find((l) => l.includes('| codex-cli | product |'));
      expect(codexProduct).toContain('3/3'); // was 4/4 in the primary summary
    });
  });

  it('buildSensitivityLines: "Excluded cells: none." when nothing is flagged', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const summary = summarizeCampaign(dir);
      const lines = buildSensitivityLines(summary, []);
      expect(lines).toContain('Excluded cells: none.');
    });
  });

  it('buildProvenanceLines: real model_resolved/cli_version/reasoning_effort/reasoning_effort_source for both runtimes, Claude and Codex genuinely differing on effort and its source', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const summary = summarizeCampaign(dir);
      const lines = buildProvenanceLines(summary);
      expect(lines).toContain('- claude-code model_resolved: claude-sonnet-5');
      expect(lines).toContain('- codex-cli model_resolved: gpt-5.6-terra');
      expect(lines).toContain('- claude-code reasoning_effort (requested): high');
      expect(lines).toContain('- codex-cli reasoning_effort (requested): low');
      expect(lines).toContain('- claude-code reasoning_effort_source: harness-pinned-cli-flag');
      expect(lines).toContain('- codex-cli reasoning_effort_source: model-registry-default-reasoning-mode');
    });
  });

  it('buildCostLines: real low/high per runtime x arm from the real buildCostEstimate output, plus its pricing source/date', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const costResult = buildCostEstimate(dir);
      expect(costResult.ok, costResult.reason).toBe(true);
      const lines = buildCostLines(costResult.doc);
      expect(lines[0]).toBe('### Cost');
      const header = lines.find((l) => l.startsWith('| runtime |'));
      expect(header).toBe('| runtime | arm | low | high | pricing source | retrieved |');
      for (const runtimeId of ['claude-code', 'codex-cli']) {
        for (const arm of ['product', 'free']) {
          const row = lines.find((l) => l.includes(`| ${runtimeId} | ${arm} |`));
          expect(row, `${runtimeId}/${arm} row`).toBeDefined();
          expect(row).toMatch(/\$0\.0\d{3}/); // a real, non-zero, 4-decimal dollar figure
          expect(row).toContain(costResult.doc.runtimes[runtimeId].source);
          expect(row).toContain(costResult.doc.runtimes[runtimeId].retrieved);
        }
      }
    });
  });

  it('a runtime/campaign with no cost-estimate.json at all: cost section says so, per-cell cost column says "not recorded", nothing crashes', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const summary = summarizeCampaign(dir);
      const costLines = buildCostLines(null);
      expect(costLines).toContain('Not recorded: no cost-estimate.json for this campaign.');
      const perCellLines = buildPerCellTableLines(summary, null, null);
      const codex0 = perCellLines.find((l) => l.includes('| codex-cli | product | 0 |'));
      expect(codex0).toContain('| not recorded |');
      expect(codex0).toContain('| not classified |'); // infra-flake column, no classification result passed
    });
  });

  it('renderEvidence2TablesBlock / insertBetweenMarkers: full block round-trips through a target-doc skeleton, --write then --check agree', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const summary = summarizeCampaign(dir);
      const costResult = buildCostEstimate(dir);
      const infraFlake = classifyCampaign(dir);
      const sensitivitySummary = summarizeCampaign(dir, new Set());

      const block = renderEvidence2TablesBlock(summary, costResult.doc, infraFlake, sensitivitySummary, []);
      expect(block.startsWith(EVIDENCE2_TABLES_START)).toBe(true);
      expect(block.trimEnd().endsWith(EVIDENCE2_TABLES_END)).toBe(true);

      const skeleton = `# Evidence2 results doc\n\nSome intro prose.\n\n${EVIDENCE2_TABLES_START}\nstale placeholder content\n${EVIDENCE2_TABLES_END}\n\nSome trailing prose.\n`;
      const updated = insertBetweenMarkers(skeleton, block);
      expect(updated).not.toBeNull();
      expect(updated).toContain('# Evidence2 results doc');
      expect(updated).toContain('Some trailing prose.');
      expect(updated).not.toContain('stale placeholder content');
      expect(updated).toContain(block);

      // A doc with no markers at all is refused, not silently ignored.
      expect(insertBetweenMarkers('# no markers here', block)).toBeNull();
    });
  });

  it('buildEvidence2TablesFromCampaign runs BOTH summarizeCampaign calls (primary, sensitivity) for real and assembles all 5 sections', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const costResult = buildCostEstimate(dir);
      const infraFlake = classifyCampaign(dir);
      const block = buildEvidence2TablesFromCampaign(dir, costResult.doc, infraFlake);
      for (const heading of ['### Per-cell detail', '### Runtime × arm aggregates', '### Sensitivity', '### Provenance and controls', '### Cost']) {
        expect(block).toContain(heading);
      }
      expect(block).toContain('Excluded cells: none.'); // real classifier output on this fixture: every cell "unknown"
    });
  });

  // WO-C16 follow-up: every table-row builder here used ['', ...fields, ''].join(' | '), producing
  // " | a | b | c | " (leading space, trailing "| ") instead of a clean "| a | b | c |". Checked
  // across all four row-producing tables (per-cell, aggregate, sensitivity -- which reuses the
  // aggregate builder -- and cost), on the TRIMMED line (a still-buggy row still trims to start
  // with '|', so filtering on the raw line would silently exclude exactly the rows this exists to
  // catch, the same mistake almost made in campaign-summary.mjs's own version of this test).
  it('every data row in every table has no leading space and no trailing "| "', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const costResult = buildCostEstimate(dir);
      const infraFlake = classifyCampaign(dir);
      const block = buildEvidence2TablesFromCampaign(dir, costResult.doc, infraFlake);
      const dataRows = block.split('\n').filter((l) => l.trim().startsWith('|') && !l.includes('---') && !l.trim().startsWith('| runtime'));
      expect(dataRows.length).toBeGreaterThan(0);
      for (const row of dataRows) {
        expect(row, `row "${row}" does not start exactly with "| "`).toMatch(/^\| \S/);
        expect(row, `row "${row}" does not end exactly with " |"`).toMatch(/\S \|$/);
      }
    });
  });
});

describe('CLI entry point -- real `node evidence2-tables.mjs <campaign-dir> <target-doc>` subprocess invocation', () => {
  it('--write inserts the block into a real target-doc file on disk; --check then agrees (exit 0)', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const costResult = buildCostEstimate(dir);
      expect(costResult.ok, costResult.reason).toBe(true);
      const costPath = path.join(dir, 'cost-estimate.json');
      writeFileSync(costPath, JSON.stringify(costResult.doc, null, 2));
      const infraFlakePath = path.join(dir, 'infra-flake-classification.json');
      writeFileSync(infraFlakePath, JSON.stringify(classifyCampaign(dir), null, 2));
      const targetDoc = path.join(dir, 'evidence2-results.md');
      writeFileSync(targetDoc, `# Evidence2 results\n\n${EVIDENCE2_TABLES_START}\n${EVIDENCE2_TABLES_END}\n`);

      const writeResult = spawnSync(process.execPath, [
        EVIDENCE2_TABLES_SCRIPT, dir, targetDoc, '--cost-estimate', costPath, '--infra-flake', infraFlakePath, '--write',
      ], { encoding: 'utf8' });
      expect(writeResult.status, `stderr: ${writeResult.stderr}`).toBe(0);
      const written = readFileSync(targetDoc, 'utf8');
      expect(written).toContain('### Per-cell detail');
      expect(written).toContain('# Evidence2 results'); // surrounding doc content preserved

      const checkResult = spawnSync(process.execPath, [
        EVIDENCE2_TABLES_SCRIPT, dir, targetDoc, '--cost-estimate', costPath, '--infra-flake', infraFlakePath,
      ], { encoding: 'utf8' });
      expect(checkResult.status, `stderr: ${checkResult.stderr}`).toBe(0);
    });
  });

  it('--check (default mode) exits 1 when the target doc is stale', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const targetDoc = path.join(dir, 'evidence2-results.md');
      writeFileSync(targetDoc, `# Evidence2 results\n\n${EVIDENCE2_TABLES_START}\nstale\n${EVIDENCE2_TABLES_END}\n`);
      const result = spawnSync(process.execPath, [EVIDENCE2_TABLES_SCRIPT, dir, targetDoc], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('out of date');
    });
  });

  // WO-C16 follow-up: target-doc is now optional, defaulting to
  // tools/runs/evidence2-agentic-benchmark-<date>/README.md (REPO_ROOT-relative, mirroring
  // Evidence1's own layout -- the auditor's own instruction; that path doesn't exist in this repo
  // checkout yet, confirmed directly, since the real campaign it's built from hasn't run). Checked
  // via the check-mode error message naming the exact computed path, not by requiring the file to
  // exist -- this test only needs to prove the DEFAULT PATH ITSELF is computed correctly.
  it('omitting target-doc falls back to the default tools/runs/evidence2-agentic-benchmark-<date>/README.md path', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const result = spawnSync(process.execPath, [EVIDENCE2_TABLES_SCRIPT, dir], { encoding: 'utf8' });
      expect(result.status).toBe(1); // that default doc doesn't exist pre-campaign -- "out of date", not a crash
      expect(result.stderr).toContain(path.join('tools', 'runs', 'evidence2-agentic-benchmark-2026-09-30', 'README.md'));
    });
  });

  it('--date=<yyyy-mm-dd> changes the default target-doc path to that date', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const result = spawnSync(process.execPath, [EVIDENCE2_TABLES_SCRIPT, dir, '--date=2027-01-01'], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(path.join('tools', 'runs', 'evidence2-agentic-benchmark-2027-01-01', 'README.md'));
    });
  });

  it('an explicit target-doc argument still overrides the default', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const explicitDoc = path.join(dir, 'explicit-target.md');
      const result = spawnSync(process.execPath, [EVIDENCE2_TABLES_SCRIPT, dir, explicitDoc], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(explicitDoc);
      expect(result.stderr).not.toContain('evidence2-agentic-benchmark-2026-09-30');
    });
  });

  it('exits 1 with usage text when campaign-dir itself is missing -- never a silent no-op', () => {
    const result = spawnSync(process.execPath, [EVIDENCE2_TABLES_SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('usage:');
  });

  it('--cost-estimate/--infra-flake value tokens never leak into the positional target-doc slot when target-doc is omitted', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const costResult = buildCostEstimate(dir);
      const costPath = path.join(dir, 'cost-estimate.json');
      writeFileSync(costPath, JSON.stringify(costResult.doc, null, 2));
      // No target-doc given -- --cost-estimate's OWN value (costPath) must never be mistaken for it.
      const result = spawnSync(process.execPath, [EVIDENCE2_TABLES_SCRIPT, dir, '--cost-estimate', costPath], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain(costPath);
      expect(result.stderr).toContain(path.join('tools', 'runs', 'evidence2-agentic-benchmark-2026-09-30', 'README.md'));
    });
  });

  it('--write refuses a target-doc that does not exist yet, rather than fabricating a skeleton', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const missingDoc = path.join(dir, 'does-not-exist.md');
      const result = spawnSync(process.execPath, [EVIDENCE2_TABLES_SCRIPT, dir, missingDoc, '--write'], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('does not exist');
      expect(existsSync(missingDoc)).toBe(false);
    });
  });
});

// Amendment A9: num_turns is not comparable across runtimes (Claude counts assistant turns, Codex
// always reports 1 non-interactive user turn per session). Every table here is already scoped to
// ONE runtime per row (buildPerCellTableLines: one cell; buildAggregateTableLines: one runtime x
// arm group) -- "the per-runtime tables are fine" per the auditor. Defensive: this guards against a
// future change introducing an explicit cross-runtime turns comparison (the "N vs M" phrasing
// buildCrossAgentBullet and the composition-row legends both use elsewhere) without the A9 caveat,
// not a fix for a live bug -- confirmed by real, very different Claude/Codex turn counts in the
// golden fixture, not just fixture values too similar to tell the two cases apart.
describe('evidence2-tables.mjs (WO-C17, Amendment A9): turns is never compared across runtimes', () => {
  it('no line in the full rendered block puts two runtimes\' turns side by side ("N vs M" phrasing near the word "turns")', () => {
    withTempDir((dir) => {
      writeManifest(dir);
      for (let i = 0; i < 8; i++) {
        const condition = i % 2 === 0 ? 'current-skill' : 'no-skill';
        const rep = Math.floor(i / 2);
        writeAcceptedCellV9(dir, `claude-code-${i}`, {
          runtimeId: 'claude-code', condition, roundIndex: i, matched: true, success: condition === 'current-skill',
          usage: { input: 1000, cached_input: 200, cache_write: 50, output: 500 },
          durationMs: 100000, toolCallsValue: 3, numTurns: 2 + rep, // small, tight range
          reasoningEffortRequested: 'high', reasoningEffortSource: 'harness-pinned-cli-flag',
        });
        writeAcceptedCellV9(dir, `codex-cli-${i}`, {
          runtimeId: 'codex-cli', condition, roundIndex: i, matched: true, success: condition === 'current-skill',
          usage: { input: 4000, cached_input: 3000, cache_write: 0, output: 300, reasoning_output: 40 },
          durationMs: 150000, toolCallsValue: 3, numTurns: 9 + rep, // large, tight range -- deliberately far from Claude's
          reasoningEffortRequested: 'low', reasoningEffortSource: 'model-registry-default-reasoning-mode',
        });
      }
      const costResult = buildCostEstimate(dir);
      const infraFlake = classifyCampaign(dir);
      const block = buildEvidence2TablesFromCampaign(dir, costResult.doc, infraFlake);
      expect(block).toContain('turns'); // sanity: the fixture's turns data really is present and rendered
      for (const line of block.split('\n')) {
        if (/\bturns?\b/i.test(line) && /\bvs\b/i.test(line)) {
          throw new Error(`line compares turns across runtimes: "${line}"`);
        }
      }
    });
  });
});

// A session that left no record and no rejection (lost to a failed guest call) takes the arm the manifest's round_order gives its position
// (campaign-summary.mjs), so the tables show it as one declared, missing cell of that arm and no row of unknown arm.
describe('evidence2-tables.mjs: a session without a record is shown under its design arm', () => {
  const aggregateRows = (block) => block.slice(block.indexOf('### Runtime × arm aggregates'), block.indexOf('### Sensitivity'))
    .split('\n').filter((l) => /^\| (claude-code|codex-cli) \|/.test(l));

  it('a cell directory that does not exist gives four aggregate rows, no row of unknown arm, and a per-cell row with its design arm', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const manifestPath = path.join(dir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, round_order: ['product', 'free', 'product', 'free', 'product', 'free', 'product', 'free'] }, null, 2));
      rmSync(path.join(dir, 'private', 'codex-cli-3'), { recursive: true });
      const costResult = buildCostEstimate(dir);
      const block = buildEvidence2TablesFromCampaign(dir, costResult.doc, classifyCampaign(dir));
      expect(aggregateRows(block).map((l) => l.split(' | ').slice(0, 2).join(' | '))).toEqual(['| claude-code | free', '| claude-code | product', '| codex-cli | free', '| codex-cli | product']);
      expect(block).not.toMatch(/\| codex-cli \| (null|unknown) \|/);
      expect(block).toMatch(/\| codex-cli \| free \| 3 \| missing: cell_directory_absent \|/);
    });
  });
});

// Evidence3: the block's heading names the evidence of the target doc, and a multi-module-tests campaign shows its
// answer fields as per-cell columns. A coverage-family campaign at an Evidence2 path keeps its output byte for byte.
describe('evidence2-tables.mjs (Evidence3): the heading names the evidence of the target doc', () => {
  it('evidenceNumberOfTargetDoc reads the number from tools/runs/evidence<N>-agentic-benchmark-<date>/<doc>, with either slash, and defaults to 2', () => {
    expect(evidenceNumberOfTargetDoc('tools/runs/evidence3-agentic-benchmark-2026-10-02/README.md')).toBe(3);
    expect(evidenceNumberOfTargetDoc('C:\\work\\tools\\runs\\evidence3-agentic-benchmark-2026-10-02\\README.md')).toBe(3);
    expect(evidenceNumberOfTargetDoc('/repo/tools/runs/evidence2-agentic-benchmark-2026-09-30/README.md')).toBe(2);
    expect(evidenceNumberOfTargetDoc('/repo/tools/runs/evidence12-agentic-benchmark-2027-01-01/README.md')).toBe(12);
    // Anything else keeps the number this generator always wrote.
    expect(evidenceNumberOfTargetDoc('/tmp/scratch/evidence-results.md')).toBe(2);
    expect(evidenceNumberOfTargetDoc('/repo/tools/runs/evidence3-notes/README.md')).toBe(2);
    expect(evidenceNumberOfTargetDoc('README.md')).toBe(2);
  });

  it('renderEvidence2TablesBlock: the heading carries the evidence number, and without an option the block is byte-identical to evidenceN 2', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const summary = summarizeCampaign(dir);
      const costResult = buildCostEstimate(dir);
      const infraFlake = classifyCampaign(dir);
      const sensitivitySummary = summarizeCampaign(dir, new Set());
      const defaultBlock = renderEvidence2TablesBlock(summary, costResult.doc, infraFlake, sensitivitySummary, []);
      const evidence2Block = renderEvidence2TablesBlock(summary, costResult.doc, infraFlake, sensitivitySummary, [], { evidenceN: 2 });
      const evidence3Block = renderEvidence2TablesBlock(summary, costResult.doc, infraFlake, sensitivitySummary, [], { evidenceN: 3 });
      expect(defaultBlock).toBe(evidence2Block);
      expect(defaultBlock).toContain('## Evidence2 results (mechanically generated -- do not hand-edit; see evidence2-tables.mjs)');
      expect(evidence3Block).toContain('## Evidence3 results (mechanically generated -- do not hand-edit; see evidence2-tables.mjs)');
      expect(evidence3Block).not.toContain('## Evidence2 results');
      // The heading is the only difference.
      expect(evidence3Block.replace('## Evidence3 results', '## Evidence2 results')).toBe(evidence2Block);
    });
  });

  it('the CLI writes "Evidence3 results" under an evidence3 run directory, keeps "Evidence2 results" elsewhere, and --check agrees with each', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const skeleton = `# Record\n\n## Results\n\n${EVIDENCE2_TABLES_START}\n${EVIDENCE2_TABLES_END}\n`;
      const evidence3Doc = path.join(dir, 'tools', 'runs', 'evidence3-agentic-benchmark-2026-10-02', 'README.md');
      const otherDoc = path.join(dir, 'scratch-record.md');
      mkdirSync(path.dirname(evidence3Doc), { recursive: true });
      writeFileSync(evidence3Doc, skeleton);
      writeFileSync(otherDoc, skeleton);

      for (const [doc, heading, message] of [
        [evidence3Doc, '## Evidence3 results (mechanically generated', 'Evidence3 tables are up to date.'],
        [otherDoc, '## Evidence2 results (mechanically generated', 'Evidence2 tables are up to date.'],
      ]) {
        const write = spawnSync(process.execPath, [EVIDENCE2_TABLES_SCRIPT, dir, doc, '--write'], { encoding: 'utf8' });
        expect(write.status, `stderr: ${write.stderr}`).toBe(0);
        const written = readFileSync(doc, 'utf8');
        expect(written).toContain(heading);
        expect(written).toContain('## Results\n'); // the doc's own heading is untouched
        const check = spawnSync(process.execPath, [EVIDENCE2_TABLES_SCRIPT, dir, doc], { encoding: 'utf8' });
        expect(check.status, `stderr: ${check.stderr}`).toBe(0);
        expect(check.stdout).toContain(message);
      }
    });
  });
});

// A real, on-disk multi-module-tests campaign: 4 cells per runtime on the n8 designs (the product arm at order indices 0
// and 3, the free arm at 1 and 2). The wrong answers are chosen so each answer field is told apart: Claude's round 1 is
// wrong in the count only, Claude's round 2 in the outcome kind only (all three answer-field columns match, key facts
// does not), Codex's round 1 in the failing modules and the failing classes.
const MULTI_MODULE_MISMATCHES = Object.freeze({
  'claude-code': Object.freeze({ 1: ['failed_count'], 2: ['outcome_kind'] }),
  'codex-cli': Object.freeze({ 1: ['failing_modules', 'failed_test_classes'] }),
});

function writeMultiModuleCampaign(dir) {
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schema: 1, campaign_id: 'evidence3-tables-multi-module', scenario_id: MULTI_MODULE_SCENARIO_ID, seed: 20260929, provider_mode: 'live',
    runtimes: [
      { runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-n8-v1', campaign_cell_indices: [0, 1, 2, 3], max_budget_usd: 6 },
      { runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-n8-v1', campaign_cell_indices: [0, 1, 2, 3], max_budget_usd: null },
    ],
  }, null, 2));
  for (let i = 0; i < 4; i++) {
    const condition = i === 0 || i === 3 ? 'current-skill' : 'no-skill';
    for (const runtimeId of ['claude-code', 'codex-cli']) {
      const mismatchFields = MULTI_MODULE_MISMATCHES[runtimeId][i] ?? [];
      const codex = runtimeId === 'codex-cli';
      writeAcceptedCellV9(dir, `${runtimeId}-${i}`, {
        runtimeId, condition, roundIndex: i, matched: mismatchFields.length === 0, mismatchFields, multiModule: true,
        success: condition === 'current-skill' && mismatchFields.length === 0,
        usage: codex ? { input: 4000 + i * 100, cached_input: 3000, cache_write: 0, output: 300, reasoning_output: 40 } : { input: 1000 + i * 50, cached_input: 200, cache_write: 50, output: 500 },
        durationMs: (codex ? 150000 : 100000) + i * 5000, toolCallsValue: 3, numTurns: codex ? 1 : 3 + i,
        reasoningEffortRequested: 'high', reasoningEffortSource: codex ? 'model-registry-default-reasoning-mode' : 'harness-pinned-cli-flag',
      });
    }
  }
}

describe('evidence2-tables.mjs (Evidence3): the multi-module-tests family shows its answer fields', () => {
  const MULTI_MODULE_HEADER = '| runtime | arm | round | status | key facts | failing modules | failing classes | count | success | duration ms | tool calls | shell commands | tokens | turns | cost | infra-flake |';
  const COVERAGE_HEADER = '| runtime | arm | round | status | key facts | full answer | success | duration ms | tool calls | shell commands | tokens | turns | cost | infra-flake |';

  it('loadFamilyFields reads each answer field from the closure with the summary\'s own analysis; it is null for the coverage family', () => {
    withTempDir((dir) => {
      writeMultiModuleCampaign(dir);
      const summary = summarizeCampaign(dir);
      expect(summary.summary_status).toBe('ok');
      expect(summary.cells.every((c) => c.status === 'accepted')).toBe(true);
      const fields = loadFamilyFields(dir, summary);
      expect(fields.family).toBe('multi-module-tests');
      expect(fields.columns.map(([field]) => field)).toEqual(['failing_modules', 'failed_test_classes', 'failed_count']);
      expect(fields.byCell.get('claude-code-1')).toEqual({ outcome_kind: 'matched', failing_modules: 'matched', failed_test_classes: 'matched', failed_count: 'mismatched' });
      expect(fields.byCell.get('codex-cli-1')).toEqual({ outcome_kind: 'matched', failing_modules: 'mismatched', failed_test_classes: 'mismatched', failed_count: 'matched' });
      expect(fields.byCell.get('claude-code-0')).toEqual({ outcome_kind: 'matched', failing_modules: 'matched', failed_test_classes: 'matched', failed_count: 'matched' });
    });
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      expect(loadFamilyFields(dir, summarizeCampaign(dir))).toBeNull();
    });
  });

  it('the per-cell table swaps "full answer" for failing modules, failing classes and count, and each cell says which field failed', () => {
    withTempDir((dir) => {
      writeMultiModuleCampaign(dir);
      const summary = summarizeCampaign(dir);
      const lines = buildPerCellTableLines(summary, null, null, loadFamilyFields(dir, summary));
      expect(lines[0]).toBe(MULTI_MODULE_HEADER);
      expect(lines[1]).toBe(`|${'---|'.repeat(16)}`);
      expect(lines).toHaveLength(2 + 8);
      const row = (runtime, arm, round) => lines.find((l) => l.startsWith(`| ${runtime} | ${arm} | ${round} |`));
      // key facts | failing modules | failing classes | count | success
      expect(row('claude-code', 'product', 0)).toContain('| accepted | yes | yes | yes | yes | yes |');
      expect(row('claude-code', 'free', 1)).toContain('| accepted | no | yes | yes | no | n/a |'); // the count only
      expect(row('claude-code', 'free', 2)).toContain('| accepted | no | yes | yes | yes | n/a |'); // the outcome kind only: key facts fails, the three columns do not
      expect(row('claude-code', 'product', 3)).toContain('| accepted | yes | yes | yes | yes | yes |');
      expect(row('codex-cli', 'free', 1)).toContain('| accepted | no | no | no | yes | n/a |'); // modules and classes
      expect(row('codex-cli', 'free', 2)).toContain('| accepted | yes | yes | yes | yes | n/a |');
      // Every data row has as many cells as the header.
      for (const line of lines.slice(2)) expect(line.split(' | ').length).toBe(MULTI_MODULE_HEADER.split(' | ').length);
    });
  });

  it('a cell with no record shows n/a in every answer field, and an unobserved answer shows "not given"', () => {
    withTempDir((dir) => {
      writeMultiModuleCampaign(dir);
      const summary = summarizeCampaign(dir);
      const fields = loadFamilyFields(dir, summary);
      const unobserved = { ...fields, byCell: new Map([...fields.byCell, ['claude-code-2', { outcome_kind: 'not-observed', failing_modules: 'not-observed', failed_test_classes: 'not-observed', failed_count: 'not-observed' }]]) };
      unobserved.byCell.delete('codex-cli-3');
      const lines = buildPerCellTableLines(summary, null, null, unobserved);
      expect(lines.find((l) => l.startsWith('| claude-code | free | 2 |'))).toContain('| accepted | no | not given | not given | not given | n/a |');
      expect(lines.find((l) => l.startsWith('| codex-cli | product | 3 |'))).toContain('| accepted | yes | n/a | n/a | n/a | yes |');
    });
  });

  it('the whole generated block (the Evidence3 heading, the family columns, then the same sections as Evidence2) comes out of the campaign directory', () => {
    withTempDir((dir) => {
      writeMultiModuleCampaign(dir);
      const costResult = buildCostEstimate(dir);
      expect(costResult.ok, costResult.reason).toBe(true);
      const block = buildEvidence2TablesFromCampaign(dir, costResult.doc, classifyCampaign(dir), { evidenceN: 3 });
      expect(block).toContain('## Evidence3 results (mechanically generated');
      expect(block).toContain(MULTI_MODULE_HEADER);
      expect(block).not.toContain(COVERAGE_HEADER);
      for (const heading of ['### Per-cell detail', '### Runtime × arm aggregates', '### Sensitivity', '### Provenance and controls', '### Cost']) {
        expect(block).toContain(heading);
      }
      expect(block).toContain('Scenario: `multi-module-test-failures`.');
    });
  });

  it('coverage-family output stays byte-identical: the old header, no family columns, whatever the evidence number', () => {
    withTempDir((dir) => {
      writeGoldenCampaign(dir);
      const costResult = buildCostEstimate(dir);
      const infraFlake = classifyCampaign(dir);
      const lines = buildPerCellTableLines(summarizeCampaign(dir), costResult.doc, infraFlake);
      expect(lines[0]).toBe(COVERAGE_HEADER);
      expect(lines[1]).toBe(`|${'---|'.repeat(14)}`);
      const block = buildEvidence2TablesFromCampaign(dir, costResult.doc, infraFlake, { evidenceN: 3 });
      expect(block).toContain(COVERAGE_HEADER);
      expect(block).not.toContain('failing modules');
    });
  });
});

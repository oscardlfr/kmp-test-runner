// tests/vitest/agentic-eval-cost-estimate.test.js -- direct unit coverage for
// tools/agentic-eval/cost-estimate.mjs. Fixture style mirrors
// agentic-eval-campaign-summary.test.js's own schema-valid record+sidecar builders
// (acceptedRecord/sidecarFor/writeManifest/writeAcceptedCell), duplicated here (not imported --
// each of these two sibling files stays independently runnable) with one addition: a `usage`
// override, since this file's whole point is exercising specific token counts.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

import { buildCostEstimate, tokensForRow, RUNTIME_PRICING, COST_ESTIMATE_SCHEMA } from '../../tools/agentic-eval/cost-estimate.mjs';
import { nullableMetric } from '../../tools/agentic-eval/cli.mjs';
import { GRADING_CHECK_NAMES } from '../../tools/agentic-eval/graders.mjs';
import { computeExecutionProfileSha256 } from '../../tools/agentic-eval/registries.mjs';
import { computeRunProvenanceSha256 } from '../../tools/agentic-eval/accepted-run-audit.mjs';
import { validateCostEstimate } from '../../tools/agentic-eval/readme-evidence.mjs';

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
const DEFAULT_USAGE = Object.freeze({ input: 1000, cached_input: 200, cache_write: 50, output: 500 });
const COST_ESTIMATE_SCRIPT = fileURLToPath(new URL('../../tools/agentic-eval/cost-estimate.mjs', import.meta.url));

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aece-'));
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

function acceptedRecord({ runId, runtimeId, condition, roundIndex, usage = DEFAULT_USAGE }) {
  const productAccessMode = condition === 'current-skill' ? 'product-assisted' : 'free-baseline-no-product';
  return {
    schema: 8, run_id: runId, run_kind: 'scenario', benchmark_eligible: true,
    scenario_id: SCENARIO_ID, query_id: null, condition,
    skill_source_sha: condition === 'current-skill' ? '2112aed96686ee159f851e00c2efa553e58473fc' : null,
    kmp_test_cli_version: '0.16.0', kmp_test_cli_source_sha: 'be8d850455bdac7a653ff24794777b2f96d7958c',
    resolved_kmp_test_executable_path: 'ignored-in-tests',
    model_requested: runtimeId === 'claude-code' ? 'claude-sonnet-5' : 'gpt-5.6-terra',
    model_resolved: runtimeId === 'claude-code' ? 'claude-sonnet-5' : 'gpt-5.6-terra',
    session_id_observed: `sess-${runId}`,
    claude_code_version: runtimeId === 'claude-code' ? '2.1.238' : null,
    repo_commit: 'be8d850455bdac7a653ff24794777b2f96d7958c',
    project_alias: 'nowinandroid', project_commit: '7d45eae4f8720a0c77f507712ba2437ff974b6ed',
    project_url: 'https://github.com/android/nowinandroid', platform: 'windows',
    family: 'coverage', cache_state: 'cold', daemon_policy: 'disabled-via-gradle-user-home-properties',
    env_allowlist_profile: 'narrow', seed: 42, order_index: roundIndex,
    started_at: '2026-09-23T09:00:00.000Z', ended_at: '2026-09-23T09:02:00.000Z', wall_clock_ms: 120000,
    skill_available: { value: condition === 'current-skill', reason: null },
    skill_invocation_attempted: { value: condition === 'current-skill', reason: null },
    skill_invoked: condition === 'current-skill' ? { value: true, reason: null } : { value: null, reason: 'skill activation status is not-observable' },
    skill_invocation_event: condition === 'current-skill' ? { type: 'assistant.tool_use.Skill', index: 0 } : null,
    success: { value: false, reason: null },
    expected_outcome_matched: { value: true, reason: null },
    first_useful_signal_ms: { value: null, reason: 'no correlated authoritative outcome event found' },
    first_useful_signal_event: null,
    post_signal_ms: { value: null, reason: 'no first useful signal boundary' },
    post_signal_tool_calls: { value: null, reason: 'no first useful signal boundary' },
    policy_denials_before_first_signal: { value: null, reason: 'no first useful signal boundary' },
    policy_denials_after_first_signal: { value: null, reason: 'no first useful signal boundary' },
    accepted_audit: null, // stamped by writeAcceptedCell
    // Invariant 9 (schemas.mjs): legacy tokens.* must be an EXACT projection of usage.input/
    // output/cached_input/cache_write -- derived from the same `usage` override, never
    // independently hardcoded, or a non-default usage value fails validateRun and the whole cell
    // silently becomes status:'missing' (which is exactly the bug this comment prevents reintroducing).
    tokens: {
      input: nullableMetric(usage.input), output: nullableMetric(usage.output),
      cache_read: nullableMetric(usage.cached_input), cache_creation: nullableMetric(usage.cache_write),
    },
    usage: {
      source: 'runtime-reported', input: usage.input, cached_input: usage.cached_input,
      cache_write: usage.cache_write, output: usage.output, reasoning_output: null,
      attributable_to_skill_load: {
        status: 'not-recorded',
        dimensions: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null },
        unit: null,
        reason: condition === 'no-skill' ? 'condition-no-skill' : 'runtime-does-not-report-skill-attribution',
      },
    },
    tool_calls_total: { value: 3, reason: null },
    shell_commands_total: { value: condition === 'current-skill' ? 2 : 3, reason: null },
    test_invocations_total: { value: 1, reason: null }, retries: { value: 0, reason: null },
    output_bytes: { value: 2000, reason: null }, stream_json_bytes: { value: 40000, reason: null },
    human_interventions: { value: 0, reason: null },
    terminated: false, termination_reason: null, exit_code: 1, permission_mode_used: 'dontAsk',
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
      schema: 2, task_outcome_matched: true, task_outcome_reason: 'matched',
      answer_protocol_matched: true,
      provider_evidence_kind: 'kmp-test-envelope', provider_evidence_status: 'matched',
      product_e2e_success: null, task_outcome_mismatch_fields: [], task_outcome_unexpected_key_count: 0,
    },
    product_access_mode: productAccessMode,
  };
}

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

// cellCount: the number of cells declared per runtime (default 8, the Evidence2 shape: 4 per arm).
function writeManifest(campaignDir, { providerMode = 'live', cellCount = 8 } = {}) {
  const cellIndices = Array.from({ length: cellCount }, (_, i) => i);
  const manifest = {
    schema: 1, campaign_id: 'campaign-under-test', scenario_id: SCENARIO_ID, seed: 42, provider_mode: providerMode,
    runtimes: [
      { runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-baseline-v1', campaign_cell_indices: cellIndices, max_budget_usd: 2.0 },
      { runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-baseline-v2', campaign_cell_indices: cellIndices, max_budget_usd: null },
    ],
  };
  writeFileSync(path.join(campaignDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

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

// A full, real campaign: 8 cells per runtime (4 product, 4 free) -- readme-evidence.mjs's
// validateCostEstimate requires exactly 4 PER ARM, so 4+4 = 8 per runtime, 16 total, matching the
// real anchor-scenario campaign shape. writeAcceptedCell's own roundIndex determines arm via
// campaign-summary.mjs's armFor(condition), not roundIndex directly, so alternating condition here
// is what actually produces 4 product + 4 free.
function writeFullCampaign(dir, { claudeUsage = DEFAULT_USAGE, codexUsage = DEFAULT_USAGE } = {}) {
  writeManifest(dir);
  const conditions = ['current-skill', 'no-skill', 'current-skill', 'no-skill', 'current-skill', 'no-skill', 'current-skill', 'no-skill'];
  conditions.forEach((condition, i) => {
    writeAcceptedCell(dir, `claude-code-${i}`, { runtimeId: 'claude-code', condition, roundIndex: i, usage: claudeUsage });
    writeAcceptedCell(dir, `codex-cli-${i}`, { runtimeId: 'codex-cli', condition, roundIndex: i, usage: codexUsage });
  });
}

describe('RUNTIME_PRICING', () => {
  it('pins claude-sonnet-5 and gpt-5.6-terra with a source URL and retrieved date each', () => {
    for (const [runtimeId, pricing] of Object.entries(RUNTIME_PRICING)) {
      expect(typeof pricing.model).toBe('string');
      expect(pricing.model.length).toBeGreaterThan(0);
      expect(pricing.source).toMatch(/^https:\/\//);
      expect(pricing.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const key of ['input', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'output']) {
        expect(typeof pricing.per_million_tokens[key], `${runtimeId}.${key}`).toBe('number');
      }
    }
  });

  it('pins both Codex cache-write price fields to the real published rate (2.5), not 0 -- OpenAI prices the uncached portion ambiguously (input OR cache-write), so a zeroed price would be wrong, not just inert', () => {
    expect(RUNTIME_PRICING['codex-cli'].per_million_tokens.cache_write_5m).toBe(2.5);
    expect(RUNTIME_PRICING['codex-cli'].per_million_tokens.cache_write_1h).toBe(2.5);
  });

  it('flags codex-cli uncached_input_may_be_cache_writes:true with the quoted OpenAI tooltip as pricing_note; claude-code carries neither field', () => {
    expect(RUNTIME_PRICING['codex-cli'].uncached_input_may_be_cache_writes).toBe(true);
    expect(RUNTIME_PRICING['codex-cli'].pricing_note).toContain('Input tokens are either Input, Cached Input, or Cache Write and writes are not an additive fee.');
    expect(RUNTIME_PRICING['claude-code'].uncached_input_may_be_cache_writes).toBeUndefined();
    expect(RUNTIME_PRICING['claude-code'].pricing_note).toBeUndefined();
  });
});

describe('tokensForRow -- binding per-runtime token mapping', () => {
  it('Codex: subtracts cached_input out of input (avoids double-counting), cache_creation always 0', () => {
    const tokens = tokensForRow('codex-cli', { input: 1000, cached_input: 300, cache_write: 999, output: 500 });
    expect(tokens).toEqual({ input: 700, cache_read: 300, output: 500, cache_creation: 0 });
  });

  it('Claude: input passes through unchanged (already cache-exclusive), cache_creation from cache_write', () => {
    const tokens = tokensForRow('claude-code', { input: 700, cached_input: 300, cache_write: 999, output: 500 });
    expect(tokens).toEqual({ input: 700, cache_read: 300, output: 500, cache_creation: 999 });
  });

  it('a missing/non-number usage dimension reads as 0, never inferred', () => {
    expect(tokensForRow('claude-code', {})).toEqual({ input: 0, cache_read: 0, output: 0, cache_creation: 0 });
    expect(tokensForRow('codex-cli', null)).toEqual({ input: 0, cache_read: 0, output: 0, cache_creation: 0 });
  });

  it('Codex: input never goes negative even if cached_input somehow exceeds input', () => {
    const tokens = tokensForRow('codex-cli', { input: 100, cached_input: 150, cache_write: null, output: 10 });
    expect(tokens.input).toBe(0);
  });
});

describe('buildCostEstimate', () => {
  it('a genuinely live, complete campaign produces a schema-2 doc that passes validateCostEstimate', () => {
    withTempDir((dir) => {
      writeFullCampaign(dir);
      const result = buildCostEstimate(dir);
      expect(result.ok).toBe(true);
      expect(result.doc.schema).toBe(COST_ESTIMATE_SCHEMA);
      expect(validateCostEstimate(result.doc)).toEqual([]);
      expect(Object.keys(result.doc.runtimes).sort()).toEqual(['claude-code', 'codex-cli']);
      for (const runtimeId of ['claude-code', 'codex-cli']) {
        expect(result.doc.runtimes[runtimeId].cells).toHaveLength(8);
        expect(result.doc.runtimes[runtimeId].cells.filter((c) => c.arm === 'product')).toHaveLength(4);
        expect(result.doc.runtimes[runtimeId].cells.filter((c) => c.arm === 'free')).toHaveLength(4);
      }
      // The ambiguity flag/price/note propagate end to end into the emitted document, not just the
      // RUNTIME_PRICING constant -- codex-cli only, claude-code carries neither key.
      expect(result.doc.runtimes['codex-cli'].per_million_tokens.cache_write_5m).toBe(2.5);
      expect(result.doc.runtimes['codex-cli'].per_million_tokens.cache_write_1h).toBe(2.5);
      expect(result.doc.runtimes['codex-cli'].uncached_input_may_be_cache_writes).toBe(true);
      expect(result.doc.runtimes['codex-cli'].pricing_note).toContain('not an additive fee');
      // In-memory, claude-code's object still carries both keys with value undefined (JS object
      // identity, not yet serialized) -- toHaveProperty would see them as present. What actually
      // matters is the real committed artifact's shape, so assert against the round-tripped JSON.
      const claudeSerialized = JSON.parse(JSON.stringify(result.doc.runtimes['claude-code']));
      expect(claudeSerialized).not.toHaveProperty('uncached_input_may_be_cache_writes');
      expect(claudeSerialized).not.toHaveProperty('pricing_note');
    });
  });

  it('the real per-cell usage flows through to the correct runtime-mapped tokens, not fabricated', () => {
    withTempDir((dir) => {
      writeFullCampaign(dir, {
        claudeUsage: { input: 10, cached_input: 105505, cache_write: 23185, output: 1293 },
        codexUsage: { input: 4000, cached_input: 3500, cache_write: null, output: 200 },
      });
      const result = buildCostEstimate(dir);
      expect(result.ok).toBe(true);
      const claudeCell = result.doc.runtimes['claude-code'].cells[0];
      expect(claudeCell.tokens).toEqual({ input: 10, cache_read: 105505, cache_creation: 23185, output: 1293 });
      const codexCell = result.doc.runtimes['codex-cli'].cells[0];
      // Codex's raw input_tokens (4000) INCLUDES the cached portion (3500) -- the binding mapping
      // subtracts it out so the cost formula's two terms (input * price.input, cache_read *
      // price.cache_read) never double-count the same tokens.
      expect(codexCell.tokens).toEqual({ input: 500, cache_read: 3500, cache_creation: 0, output: 200 });
    });
  });

  it('a non-live campaign is refused outright, never a partial/guessed estimate', () => {
    withTempDir((dir) => {
      writeManifest(dir, { providerMode: 'fake' });
      const result = buildCostEstimate(dir);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('campaign_not_live_or_unreadable');
    });
  });

  it('a campaign directory with no manifest at all is refused, not thrown', () => {
    withTempDir((dir) => {
      const result = buildCostEstimate(dir);
      expect(result.ok).toBe(false);
    });
  });

  // Was "fewer than 4 counted cells in one arm is refused": the number of counted cells per arm is no
  // longer fixed at 4, and the arms of one runtime may differ in count (a rejected session is never
  // replaced). Only an arm with no counted cell at all is refused.
  it('an arm with fewer counted cells than the other (3 product, 4 free) is accepted: arms may differ in count', () => {
    withTempDir((dir) => {
      writeManifest(dir);
      // Only 7 of the 8 declared claude-code cells are written (3 product, 4 free); the 8th's cell
      // directory is absent entirely (loadCell's own cell_directory_absent path), so it counts as missing,
      // not counted. codex-cli gets a full, valid 4+4 set.
      const claudeConditions = ['current-skill', 'no-skill', 'current-skill', 'no-skill', 'no-skill', 'current-skill', 'no-skill'];
      claudeConditions.forEach((condition, i) => writeAcceptedCell(dir, `claude-code-${i}`, { runtimeId: 'claude-code', condition, roundIndex: i }));
      const codexConditions = ['current-skill', 'no-skill', 'current-skill', 'no-skill', 'current-skill', 'no-skill', 'current-skill', 'no-skill'];
      codexConditions.forEach((condition, i) => writeAcceptedCell(dir, `codex-cli-${i}`, { runtimeId: 'codex-cli', condition, roundIndex: i }));
      const result = buildCostEstimate(dir);
      expect(result.ok).toBe(true);
      const claudeCells = result.doc.runtimes['claude-code'].cells;
      expect(claudeCells.filter((c) => c.arm === 'product')).toHaveLength(3);
      expect(claudeCells.filter((c) => c.arm === 'free')).toHaveLength(4);
      expect(result.doc.runtimes['codex-cli'].cells).toHaveLength(8);
      expect(validateCostEstimate(result.doc)).toEqual([]);
    });
  });

  // Alternating arms: even cell index current-skill (product), odd no-skill (free).
  const alternating = (count) => Array.from({ length: count }, (_, i) => (i % 2 === 0 ? 'current-skill' : 'no-skill'));
  function writeAlternatingCampaign(dir, { cellCount, claudeCells = cellCount, codexCells = cellCount }) {
    writeManifest(dir, { cellCount });
    alternating(claudeCells).forEach((condition, i) => writeAcceptedCell(dir, `claude-code-${i}`, { runtimeId: 'claude-code', condition, roundIndex: i }));
    alternating(codexCells).forEach((condition, i) => writeAcceptedCell(dir, `codex-cli-${i}`, { runtimeId: 'codex-cli', condition, roundIndex: i }));
  }
  const armCounts = (doc, runtimeId) => {
    const cells = doc.runtimes[runtimeId].cells;
    return { product: cells.filter((c) => c.arm === 'product').length, free: cells.filter((c) => c.arm === 'free').length };
  };

  it('a canary-sized campaign (1 counted cell per arm) builds an estimate that validates', () => {
    withTempDir((dir) => {
      writeAlternatingCampaign(dir, { cellCount: 2 });
      const result = buildCostEstimate(dir);
      expect(result.ok).toBe(true);
      for (const runtimeId of ['claude-code', 'codex-cli']) expect(armCounts(result.doc, runtimeId)).toEqual({ product: 1, free: 1 });
      expect(validateCostEstimate(result.doc)).toEqual([]);
    });
  });

  it('a campaign of 8 counted cells per arm builds an estimate that validates', () => {
    withTempDir((dir) => {
      writeAlternatingCampaign(dir, { cellCount: 16 });
      const result = buildCostEstimate(dir);
      expect(result.ok).toBe(true);
      for (const runtimeId of ['claude-code', 'codex-cli']) expect(armCounts(result.doc, runtimeId)).toEqual({ product: 8, free: 8 });
      expect(validateCostEstimate(result.doc)).toEqual([]);
    });
  });

  it('arms of 8 and 7 counted cells (one session of the 16 is missing) build an estimate with 8 product and 7 free cells', () => {
    withTempDir((dir) => {
      // claude-code: 15 of 16 declared cells written, so the last free cell (index 15) is missing.
      writeAlternatingCampaign(dir, { cellCount: 16, claudeCells: 15 });
      const result = buildCostEstimate(dir);
      expect(result.ok).toBe(true);
      expect(armCounts(result.doc, 'claude-code')).toEqual({ product: 8, free: 7 });
      expect(armCounts(result.doc, 'codex-cli')).toEqual({ product: 8, free: 8 });
      expect(validateCostEstimate(result.doc)).toEqual([]);
    });
  });

  it('an arm with 0 counted cells is refused, naming the runtime and the arm, never a partial estimate', () => {
    withTempDir((dir) => {
      writeManifest(dir, { cellCount: 4 });
      // claude-code has free cells only: its product arm has nothing counted.
      ['no-skill', 'no-skill', 'no-skill', 'no-skill'].forEach((condition, i) => writeAcceptedCell(dir, `claude-code-${i}`, { runtimeId: 'claude-code', condition, roundIndex: i }));
      alternating(4).forEach((condition, i) => writeAcceptedCell(dir, `codex-cli-${i}`, { runtimeId: 'codex-cli', condition, roundIndex: i }));
      const result = buildCostEstimate(dir);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('claude-code');
      expect(result.reason).toContain('product');
    });
  });

  it('a cell whose recorded model_id does not match the pinned RUNTIME_PRICING model is refused, not silently mispriced', () => {
    withTempDir((dir) => {
      writeManifest(dir, {});
      // Overwrite the manifest with a mismatched model_id for claude-code after the standard write.
      // The mismatch check runs before the per-arm completeness check, so an otherwise-complete,
      // fully-valid campaign still refuses on the model mismatch alone.
      const manifestPath = path.join(dir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.runtimes[0].model_id = 'claude-opus-5-5';
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      const conditions = ['current-skill', 'no-skill', 'current-skill', 'no-skill', 'current-skill', 'no-skill', 'current-skill', 'no-skill'];
      conditions.forEach((condition, i) => writeAcceptedCell(dir, `claude-code-${i}`, { runtimeId: 'claude-code', condition, roundIndex: i }));
      conditions.forEach((condition, i) => writeAcceptedCell(dir, `codex-cli-${i}`, { runtimeId: 'codex-cli', condition, roundIndex: i }));
      const result = buildCostEstimate(dir);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('claude-opus-5-5');
    });
  });
});

// Real subprocess invocation, not an imported-function call -- same rationale as
// agentic-eval-campaign-summary.test.js's own identical describe block: a bare
// `file://${argv[1]}` guard never matches on Windows (import.meta.url is file:///C:/...), so
// main() would silently never run there. cost-estimate.mjs copies campaign-summary.mjs's own
// FIXED guard (resolve(process.argv[1]) === fileURLToPath(import.meta.url)); this proves that
// claim by executing the real script, not by pattern-matching the source.
describe('CLI entry point -- real `node cost-estimate.mjs <dir>` subprocess invocation', () => {
  it('prints non-empty, schema-2 JSON and exits 0 for a valid, complete live campaign', () => {
    withTempDir((dir) => {
      writeFullCampaign(dir);
      const result = spawnSync(process.execPath, [COST_ESTIMATE_SCRIPT, dir], { encoding: 'utf8' });
      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.schema).toBe(COST_ESTIMATE_SCHEMA);
      expect(Object.keys(parsed.runtimes).sort()).toEqual(['claude-code', 'codex-cli']);
    });
  });

  it('exits 1 with no campaign-dir argument, printing usage -- never a silent no-op', () => {
    const result = spawnSync(process.execPath, [COST_ESTIMATE_SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('usage:');
  });

  it('exits 1 on a non-live campaign, with the refusal reason on stderr', () => {
    withTempDir((dir) => {
      writeManifest(dir, { providerMode: 'fake' });
      const result = spawnSync(process.execPath, [COST_ESTIMATE_SCRIPT, dir], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('campaign_not_live_or_unreadable');
    });
  });

  it('--out <file> writes the same JSON to disk', () => {
    withTempDir((dir) => {
      writeFullCampaign(dir);
      const outPath = path.join(dir, 'cost-estimate.json');
      const result = spawnSync(process.execPath, [COST_ESTIMATE_SCRIPT, dir, '--out', outPath], { encoding: 'utf8' });
      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      expect(existsSync(outPath)).toBe(true);
      const written = JSON.parse(readFileSync(outPath, 'utf8'));
      expect(written.schema).toBe(COST_ESTIMATE_SCHEMA);
    });
  });
});

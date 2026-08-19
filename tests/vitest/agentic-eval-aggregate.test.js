// tests/vitest/agentic-eval-aggregate.test.js
// Unit tests for tools/agentic-eval/aggregate.mjs -- Fairness Contract enforcement across a
// flat list of run records (bucketing + per-bucket validation). aggregateRuns() validates
// every record against the FULL run schema before bucketing, so these fixtures must be
// completely schema-valid, not just carry the partition/benchmark_eligible fields.
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { aggregateRuns, summarizeGroup } from '../../tools/agentic-eval/aggregate.mjs';
import { GRADING_CHECK_NAMES } from '../../tools/agentic-eval/graders.mjs';
import { agentRuntimeView } from '../../tools/agentic-eval/run-record-view.mjs';
import { validateRunRecordFile } from '../../tools/agentic-eval/run-record-loader.mjs';
import { canonicalStructuredValue } from '../../tools/agentic-eval/canonical-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_RUNS_DIR = join(__dirname, '..', '..', 'tools', 'runs', 'agentic-eval-scenario');

// schema:4 (review-round-2 fix) -- a benchmark-eligible scenario record now REQUIRES a real,
// well-shaped ambient_skill_profile to aggregate at all (schemas.mjs's buildAggregateGroup
// refuses schema<4 scenario+eligible records outright, since their ambient profile is genuinely
// unknown, not "agreeing on absence"). Bumped from the historical schema:1 default this file used
// to a fully valid CURRENT shape -- grading_checks/repetition_index (v2)/foreign_skill_summary
// (v3)/ambient_skill_profile (v4) all added together, matching what a real current
// buildRunRecord() output actually looks like end to end.
function run(overrides = {}) {
  return {
    schema: 4,
    grading_checks: { value: GRADING_CHECK_NAMES.map((name) => ({ name, passed: true, detail: 'ok', evidence_event_indices: [] })), reason: null },
    repetition_index: 0,
    foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
    ambient_skill_profile: { count: 0, scope_id: '00000000-0000-4000-8000-000000000000', fingerprint_hmac: '0'.repeat(64) },
    run_id: `r-${Math.random().toString(36).slice(2)}`,
    run_kind: 'scenario',
    benchmark_eligible: true,
    scenario_id: 's1',
    query_id: null,
    condition: 'no-skill',
    skill_source_sha: null,
    kmp_test_cli_version: '0.14.0',
    kmp_test_cli_source_sha: 'c5c0661852f7c9da145ef56892048e706216a6ce',
    resolved_kmp_test_executable_path: 'tools/agentic-eval/fixtures/calibration-project',
    model_requested: 'claude-sonnet-5',
    model_resolved: 'claude-sonnet-5',
    session_id_observed: 'sess-0001',
    claude_code_version: '1.2.3-fake',
    repo_commit: 'c5c0661852f7c9da145ef56892048e706216a6ce',
    project_alias: 'sample',
    project_commit: 'abc123',
    project_url: 'https://github.com/example/sample',
    platform: 'windows',
    family: 'test-only',
    cache_state: 'warm',
    daemon_policy: 'disabled-via-gradle-user-home-properties',
    env_allowlist_profile: 'narrow',
    seed: null,
    order_index: null,
    started_at: '2026-07-18T00:00:00.000Z',
    ended_at: '2026-07-18T00:00:01.000Z',
    wall_clock_ms: 1000,
    skill_available: { value: true, reason: null },
    skill_invocation_attempted: { value: false, reason: null },
    skill_invoked: { value: false, reason: null },
    skill_invocation_event: null,
    success: { value: true, reason: null },
    expected_outcome_matched: { value: true, reason: null },
    first_useful_signal_ms: { value: 100, reason: null },
    first_useful_signal_event: null,
    tokens: {
      input: { value: 2, reason: null }, output: { value: 4, reason: null },
      cache_read: { value: 0, reason: null }, cache_creation: { value: 0, reason: null },
    },
    tool_calls_total: { value: 1, reason: null },
    shell_commands_total: { value: 1, reason: null },
    test_invocations_total: { value: 1, reason: null },
    retries: { value: 0, reason: null },
    output_bytes: { value: 100, reason: null },
    stream_json_bytes: { value: 1000, reason: null },
    human_interventions: { value: 0, reason: null },
    terminated: false,
    termination_reason: null,
    exit_code: 0,
    permission_mode_used: 'dontAsk',
    policy_allowed_gradle_tasks: ['build'],
    policy_allowed_kmptest_subcommands: ['doctor'],
    policy_sha256: 'a'.repeat(64),
    hook_call_count: 1,
    hook_deny_count: 0,
    privacy_status: 'public',
    raw_capture_committed: false,
    raw_capture_location: 'tools/runs/agentic-eval-scenario/raw/',
    notes: '',
    errors: [],
    ...overrides,
  };
}

describe('aggregateRuns', () => {
  it('groups homogeneous benchmark_eligible runs into one clean bucket', () => {
    const { groups, errors } = aggregateRuns([run(), run(), run()]);
    expect(errors).toEqual([]);
    expect(groups.length).toBe(1);
    expect(groups[0].run_count).toBe(3);
  });

  it('splits into separate buckets by scenario_id/condition/family/run_kind/cache_state', () => {
    const { groups, errors } = aggregateRuns([
      run({ scenario_id: 's1' }),
      run({ scenario_id: 's2' }),
    ]);
    expect(errors).toEqual([]);
    expect(groups.length).toBe(2);
  });

  // accepted-run-observability PR: `schema` is already a HARD_PARTITION_FIELDS entry (pre-existing,
  // guards against averaging a v2 record together with a v3 one) -- this proves the identical
  // guarantee extends to v4 vs v5 with zero code changes needed, since a v5 record carries 5 new
  // fields (and a genuinely different accepted_audit binding) a v4 record doesn't have at all.
  it('keeps schema:4 and schema:5 records in SEPARATE buckets, never merged', () => {
    const v4 = run({ schema: 4, run_id: 'r-v4' });
    const v5RunId = 'r-v5';
    const v5 = run({
      schema: 5, run_id: v5RunId,
      post_signal_ms: { value: null, reason: 'no first useful signal boundary' },
      post_signal_tool_calls: { value: null, reason: 'no first useful signal boundary' },
      policy_denials_before_first_signal: { value: null, reason: 'no first useful signal boundary' },
      policy_denials_after_first_signal: { value: null, reason: 'no first useful signal boundary' },
      accepted_audit: { schema: 1, relative_path: `audit/${v5RunId}.json`, sha256: 'a'.repeat(64) },
    });
    const { groups, errors } = aggregateRuns([v4, v5]);
    expect(errors).toEqual([]);
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.group_key.schema).sort()).toEqual([4, 5]);
  });

  it('surfaces a per-bucket error for benchmark_eligible:false runs without dropping other buckets', () => {
    const { groups, errors } = aggregateRuns([
      run({ scenario_id: 's1' }), // clean bucket
      run({ scenario_id: 's2', benchmark_eligible: false }), // ineligible bucket
    ]);
    expect(groups.length).toBe(1);
    expect(errors.length).toBe(1);
  });

  it('handles an empty run list without throwing', () => {
    const { groups, errors } = aggregateRuns([]);
    expect(groups).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('excludes a schema-invalid record from every bucket and reports it per-record, without dropping the valid ones', () => {
    const broken = run({ run_id: 'r-broken', retries: { value: -1, reason: null } }); // fails value-domain validation
    const { groups, errors } = aggregateRuns([run({ scenario_id: 's1' }), broken]);
    expect(groups.length).toBe(1);
    expect(groups[0].run_count).toBe(1);
    expect(errors.some((e) => e.run_id === 'r-broken')).toBe(true);
  });

  // Regression guard for a real bucket-key construction bug: the original bucket key was
  // HARD_PARTITION_FIELDS.map(f => run[f]).join(' '), which two DIFFERENT field-value tuples can
  // produce identically whenever a space moves across a field boundary. project_commit/
  // model_resolved are adjacent, free-text (non-enum) hard-partition fields, so shifting the
  // space between 'abc def'/'claude-sonnet-5' and 'abc'/'def claude-sonnet-5' produces the exact
  // same joined string under the old scheme while the two runs' actual field values differ. Under
  // the old .join(' ') key, these collided into ONE bucket, and buildAggregateGroup's own
  // per-field mixing check then correctly rejected that bucket as "mixed values" -- meaning two
  // fully legitimate, independently groupable runs spuriously failed aggregation entirely (zero
  // valid groups) purely because of where a space fell in unrelated data. The JSON.stringify key
  // keeps them in two separate, independently valid, error-free groups.
  it('does not collide two runs whose partition field values differ only in where a space falls', () => {
    const runX = run({ run_id: 'r-x', project_commit: 'abc def', model_resolved: 'claude-sonnet-5' });
    const runY = run({ run_id: 'r-y', project_commit: 'abc', model_resolved: 'def claude-sonnet-5' });
    const { groups, errors } = aggregateRuns([runX, runY]);
    expect(errors).toEqual([]);
    expect(groups.length).toBe(2);
    expect(groups.every((g) => g.run_count === 1)).toBe(true);
  });

  // Review-round-2 finding (P2): the bucket key here is built via
  // JSON.stringify(HARD_PARTITION_FIELDS.map(f => run[f])) -- a bare JSON.stringify is NOT
  // canonical w.r.t. an OBJECT field's own key insertion order, so two runs whose
  // ambient_skill_profile is the SAME value but constructed with keys in a different order
  // previously landed in two SEPARATE buckets here (never even reaching buildAggregateGroup's own
  // mixing check, which would otherwise have treated them as comparable). Fixed by using the SAME
  // canonicalStructuredValue serializer schemas.mjs's own partitionFieldKey uses, not a second,
  // independently-drifting notion of "the same value".
  it('does not bucket two runs whose ambient_skill_profile has the SAME values in a DIFFERENT key order into separate buckets', () => {
    const scopeId = '00000000-0000-4000-8000-000000000000';
    const runX = run({ run_id: 'r-x', ambient_skill_profile: { count: 1, scope_id: scopeId, fingerprint_hmac: 'f'.repeat(64) } });
    const runY = run({ run_id: 'r-y', ambient_skill_profile: { fingerprint_hmac: 'f'.repeat(64), scope_id: scopeId, count: 1 } });
    const { groups, errors } = aggregateRuns([runX, runY]);
    expect(errors).toEqual([]);
    expect(groups.length).toBe(1);
    expect(groups[0].run_count).toBe(2);
  });
});

// Section F (agentic-eval-runtime-neutral-records-v1): agent_runtime/execution_profile/
// skill_treatment become 3 new structural Fairness Contract partition keys. run6() extends run()'s
// own schema:4 base into a fully well-formed, aggregable schema:6 no-skill record (v5's 4 metrics +
// accepted_audit pointing at a v3 sidecar, plus the 4 new v6 groups) -- mirroring exactly how the
// pre-existing "keeps schema:4 and schema:5 in SEPARATE buckets" test above builds its own v5
// fixture inline.
function run6(overrides = {}) {
  const runId = overrides.run_id ?? `r-${Math.random().toString(36).slice(2)}`;
  return run({
    schema: 6,
    run_id: runId,
    post_signal_ms: { value: null, reason: 'no first useful signal boundary' },
    post_signal_tool_calls: { value: null, reason: 'no first useful signal boundary' },
    policy_denials_before_first_signal: { value: null, reason: 'no first useful signal boundary' },
    policy_denials_after_first_signal: { value: null, reason: 'no first useful signal boundary' },
    accepted_audit: { schema: 3, relative_path: `audit/${runId}.json`, sha256: 'a'.repeat(64) },
    agent_runtime: {
      runtime_id: 'claude-code', cli_version: '1.2.3-fake', model_requested: 'claude-sonnet-5',
      model_resolved: 'claude-sonnet-5', model_vendor_expected: 'anthropic', model_vendor_observed: null,
    },
    execution_profile: {
      id: 'strict-policy-v1', sha256: 'd'.repeat(64), isolation_kind: 'runtime-policy-hooks',
      isolation_attestation_sha256: null, network_mode: 'runtime-default',
    },
    skill_observation: {
      delivery_mode: 'none',
      availability: { status: 'observed-absent', evidence_kind: 'runtime-catalog' },
      activation: { status: 'not-observed', evidence_kind: 'runtime-explicit-event' },
      source_sha: null,
      treatment_size: {
        snapshot_sha256: null, snapshot_bytes: null, snapshot_file_count: null,
        prompt_sha256: 'e'.repeat(64), prompt_bytes: 55,
        absent_reason: 'condition-no-skill',
      },
    },
    usage: {
      source: 'runtime-reported', input: 2, cached_input: 0, cache_write: 0, output: 4, reasoning_output: null,
      attributable_to_skill_load: {
        status: 'not-recorded',
        dimensions: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null },
        unit: null, reason: 'condition-no-skill',
      },
    },
    ...overrides,
  });
}

// A well-formed schema:6 current-skill record -- delivery_mode is strictly gated by condition on
// claude-code (validateRun: 'must be runtime-extension for condition current-skill on claude-code'),
// so there is no way to vary delivery_mode while holding condition fixed; this helper builds the
// full, mutually-consistent current-skill shape (skill_source_sha/skill_invoked/
// skill_invocation_attempted/skill_invocation_event/skill_observation/usage attribution reason all
// move together) so individual tests only need to override the ONE field they are exercising.
function run6CurrentSkill(overrides = {}) {
  return run6({
    condition: 'current-skill',
    skill_source_sha: 'a'.repeat(40),
    skill_available: { value: true, reason: null },
    skill_invocation_attempted: { value: true, reason: null },
    skill_invoked: { value: true, reason: null },
    skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 3 },
    skill_observation: {
      delivery_mode: 'runtime-extension',
      availability: { status: 'observed-present', evidence_kind: 'runtime-catalog' },
      activation: { status: 'confirmed', evidence_kind: 'runtime-explicit-event' },
      source_sha: 'a'.repeat(40),
      treatment_size: {
        snapshot_sha256: 'c'.repeat(64), snapshot_bytes: 234997, snapshot_file_count: 28,
        prompt_sha256: 'e'.repeat(64), prompt_bytes: 55,
        absent_reason: null,
      },
    },
    usage: {
      source: 'runtime-reported', input: 2, cached_input: 0, cache_write: 0, output: 4, reasoning_output: null,
      attributable_to_skill_load: {
        status: 'not-recorded',
        dimensions: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null },
        unit: null, reason: 'runtime-does-not-report-skill-attribution',
      },
    },
    ...overrides,
  });
}

describe('aggregateRuns -- agent_runtime/execution_profile/skill_treatment structural partition keys (Section F)', () => {
  it('a schema<=5 record projects all 3 new fields as the literal "not-recorded" sentinel in group_key', () => {
    const { groups, errors } = aggregateRuns([run(), run()]);
    expect(errors).toEqual([]);
    expect(groups.length).toBe(1);
    expect(groups[0].group_key.agent_runtime).toBe('not-recorded');
    expect(groups[0].group_key.execution_profile).toBe('not-recorded');
    expect(groups[0].group_key.skill_treatment).toBe('not-recorded');
  });

  it('a well-formed schema:6 record aggregates cleanly with real (non-sentinel) values in group_key', () => {
    const { groups, errors } = aggregateRuns([run6(), run6()]);
    expect(errors).toEqual([]);
    expect(groups.length).toBe(1);
    expect(groups[0].group_key.agent_runtime).toEqual(run6().agent_runtime);
    expect(groups[0].group_key.execution_profile).toEqual({ id: 'strict-policy-v1', sha256: 'd'.repeat(64), isolation_kind: 'runtime-policy-hooks', network_mode: 'runtime-default' });
    expect(groups[0].group_key.skill_treatment).toEqual({ delivery_mode: 'none', source_sha: null, treatment_size: run6().skill_observation.treatment_size });
  });

  it('never pools a schema:5 record with a schema:6 record, even with identical scenario_id/condition', () => {
    const v5RunId = 'r-v5-pool-check';
    const v5 = run({
      schema: 5, run_id: v5RunId,
      post_signal_ms: { value: null, reason: 'no first useful signal boundary' },
      post_signal_tool_calls: { value: null, reason: 'no first useful signal boundary' },
      policy_denials_before_first_signal: { value: null, reason: 'no first useful signal boundary' },
      policy_denials_after_first_signal: { value: null, reason: 'no first useful signal boundary' },
      accepted_audit: { schema: 1, relative_path: `audit/${v5RunId}.json`, sha256: 'a'.repeat(64) },
    });
    const v6 = run6({ run_id: 'r-v6-pool-check' });
    const { groups, errors } = aggregateRuns([v5, v6]);
    expect(errors).toEqual([]);
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.group_key.schema).sort()).toEqual([5, 6]);
  });

  it('changing ONLY an outcome field (success/expected_outcome_matched) never separates buckets', () => {
    const a = run6({ run_id: 'r-outcome-a', success: { value: true, reason: null }, expected_outcome_matched: { value: true, reason: null } });
    const b = run6({ run_id: 'r-outcome-b', success: { value: false, reason: null }, expected_outcome_matched: { value: false, reason: null } });
    const { groups, errors } = aggregateRuns([a, b]);
    expect(errors).toEqual([]);
    expect(groups.length).toBe(1);
    expect(groups[0].run_count).toBe(2);
  });

  it('is insensitive to property insertion order in agent_runtime/execution_profile/skill_observation -- semantically equal records still group together', () => {
    const a = run6({ run_id: 'r-order-a' });
    const reorderedAgentRuntime = {};
    for (const k of Object.keys(a.agent_runtime).reverse()) reorderedAgentRuntime[k] = a.agent_runtime[k];
    const reorderedExecutionProfile = {};
    for (const k of Object.keys(a.execution_profile).reverse()) reorderedExecutionProfile[k] = a.execution_profile[k];
    const reorderedSkillObservation = {};
    for (const k of Object.keys(a.skill_observation).reverse()) reorderedSkillObservation[k] = a.skill_observation[k];
    const b = run6({
      run_id: 'r-order-b', agent_runtime: reorderedAgentRuntime,
      execution_profile: reorderedExecutionProfile, skill_observation: reorderedSkillObservation,
    });
    const { groups, errors } = aggregateRuns([a, b]);
    expect(errors).toEqual([]);
    expect(groups.length).toBe(1);
    expect(groups[0].run_count).toBe(2);
  });

  it('a malformed v6 agent_runtime is rejected by validateRun and never reaches aggregation', () => {
    const broken = run6({ run_id: 'r-broken-runtime', agent_runtime: { runtime_id: 'claude-code' } }); // missing required keys
    const { groups, errors } = aggregateRuns([run6({ run_id: 'r-ok' }), broken]);
    expect(groups.length).toBe(1);
    expect(groups[0].run_count).toBe(1);
    expect(errors.some((e) => e.run_id === 'r-broken-runtime')).toBe(true);
  });

  describe('agent_runtime -- each sub-field independently separates buckets', () => {
    // cli_version/model_requested/model_resolved mirror a legacy top-level field 1:1 for
    // runtime_id:claude-code (schema invariant 3) -- varying the agent_runtime sub-field ALONE
    // without also moving its legacy counterpart is itself a schema violation, not a valid
    // "same record, one field different" fixture. legacyField is null when no such mirror exists
    // (model_vendor_expected, model_vendor_observed -- neither has a pre-v6 legacy counterpart).
    //
    // runtime_id itself is deliberately NOT a case here: a genuinely non-claude-code runtime_id
    // requires claude_code_version:null (schema invariant 3's else-branch), but
    // buildAggregateGroup's own PRE-EXISTING, runtime-agnostic completeness gate separately
    // requires claude_code_version to be a non-empty string for EVERY run regardless of runtime_id
    // (predates this PR; not part of Section F) -- so no record can satisfy both today, and
    // end-to-end aggregateRuns() is genuinely not reachable for any non-claude-code runtime_id yet.
    // runtime_id's own participation in the projected/partitioned value is covered directly below,
    // at the run-record-view.mjs level, without going through that unrelated gate.
    it.each([
      ['cli_version', 'claude_code_version', '1.2.3-fake', '9.9.9-different'],
      ['model_requested', 'model_requested', 'claude-sonnet-5', 'claude-sonnet-5-different'],
      ['model_resolved', 'model_resolved', 'claude-sonnet-5', 'claude-sonnet-5-different'],
      ['model_vendor_expected', null, 'anthropic', 'openai'],
    ])('varying agent_runtime.%s alone separates the two runs into different buckets', (field, legacyField, baseValue, otherValue) => {
      const legacyOverrideA = legacyField ? { [legacyField]: baseValue } : {};
      const legacyOverrideB = legacyField ? { [legacyField]: otherValue } : {};
      const a = run6({ run_id: 'r-a', ...legacyOverrideA, agent_runtime: { ...run6().agent_runtime, [field]: baseValue } });
      const b = run6({ run_id: 'r-b', ...legacyOverrideB, agent_runtime: { ...run6().agent_runtime, [field]: otherValue } });
      const { groups, errors } = aggregateRuns([a, b]);
      expect(errors).toEqual([]);
      expect(groups.length).toBe(2);
    });

    it('agent_runtime.runtime_id is included verbatim in agentRuntimeView -- two otherwise-identical records with different runtime_id project different partition values', () => {
      const a = run6({ run_id: 'r-a' });
      const b = run6({ run_id: 'r-b', agent_runtime: { ...run6().agent_runtime, runtime_id: 'codex-cli' } });
      expect(agentRuntimeView(a)).not.toEqual(agentRuntimeView(b));
      expect(agentRuntimeView(a).runtime_id).toBe('claude-code');
      expect(agentRuntimeView(b).runtime_id).toBe('codex-cli');
    });

    it('varying agent_runtime.model_vendor_observed (null vs a string) alone separates the two runs into different buckets', () => {
      const a = run6({ run_id: 'r-a', agent_runtime: { ...run6().agent_runtime, model_vendor_observed: null } });
      const b = run6({ run_id: 'r-b', agent_runtime: { ...run6().agent_runtime, model_vendor_observed: 'anthropic' } });
      const { groups, errors } = aggregateRuns([a, b]);
      expect(errors).toEqual([]);
      expect(groups.length).toBe(2);
    });
  });

  describe('execution_profile -- each partition-relevant sub-field independently separates buckets; attestation does not', () => {
    it.each([
      ['id', 'strict-policy-v1', 'sandboxed-unrestricted-v1'],
      ['sha256', 'd'.repeat(64), 'f'.repeat(64)],
      ['isolation_kind', 'runtime-policy-hooks', 'external-sandbox'],
      ['network_mode', 'runtime-default', 'restricted'],
    ])('varying execution_profile.%s alone separates the two runs into different buckets', (field, baseValue, otherValue) => {
      const a = run6({ run_id: 'r-a', execution_profile: { ...run6().execution_profile, [field]: baseValue } });
      const b = run6({ run_id: 'r-b', execution_profile: { ...run6().execution_profile, [field]: otherValue } });
      const { groups, errors } = aggregateRuns([a, b]);
      expect(errors).toEqual([]);
      expect(groups.length).toBe(2);
    });

    // strict-policy-v1's own frozen registry semantics force isolation_attestation_sha256 to null
    // unconditionally (schema-level hardcoded rule) -- sandboxed-unrestricted-v1 carries no such
    // rule, so it is the only id attestation can vary under at all.
    it('varying ONLY execution_profile.isolation_attestation_sha256 does NOT separate buckets -- it is bound/validated evidence, never a partition key', () => {
      const base = { ...run6().execution_profile, id: 'sandboxed-unrestricted-v1' };
      const a = run6({ run_id: 'r-a', execution_profile: { ...base, isolation_attestation_sha256: null } });
      const b = run6({ run_id: 'r-b', execution_profile: { ...base, isolation_attestation_sha256: 'b'.repeat(64) } });
      const { groups, errors } = aggregateRuns([a, b]);
      expect(errors).toEqual([]);
      expect(groups.length).toBe(1);
      expect(groups[0].run_count).toBe(2);
    });
  });

  describe('skill_treatment -- each sub-field independently separates buckets; availability/activation do not', () => {
    it('varying skill_observation.delivery_mode (via condition, the only way it can differ on claude-code) separates the two runs into different buckets', () => {
      const a = run6CurrentSkill({ run_id: 'r-a' });
      const b = run6({ run_id: 'r-b' }); // no-skill -> delivery_mode:'none'
      const { groups, errors } = aggregateRuns([a, b]);
      expect(errors).toEqual([]);
      expect(groups.length).toBe(2);
    });

    it('varying skill_observation.source_sha alone (both current-skill) separates the two runs into different buckets', () => {
      const a = run6CurrentSkill({ run_id: 'r-a' });
      const b = run6CurrentSkill({
        run_id: 'r-b', skill_source_sha: 'b'.repeat(40),
        skill_observation: { ...run6CurrentSkill().skill_observation, source_sha: 'b'.repeat(40) },
      });
      const { groups, errors } = aggregateRuns([a, b]);
      expect(errors).toEqual([]);
      expect(groups.length).toBe(2);
    });

    it('varying skill_observation.treatment_size alone (both current-skill, same source_sha) separates the two runs into different buckets -- the same source SHA is not enough on its own', () => {
      const a = run6CurrentSkill({ run_id: 'r-a' });
      const b = run6CurrentSkill({
        run_id: 'r-b',
        skill_observation: { ...run6CurrentSkill().skill_observation, treatment_size: { ...run6CurrentSkill().skill_observation.treatment_size, prompt_bytes: 99 } },
      });
      const { groups, errors } = aggregateRuns([a, b]);
      expect(errors).toEqual([]);
      expect(groups.length).toBe(2);
    });

    it('varying ONLY skill_observation.availability/activation (delivery_mode/source_sha/treatment_size held identical) does NOT separate buckets -- they are observed outcomes, never the treatment itself', () => {
      const a = run6CurrentSkill({ run_id: 'r-a' });
      const b = run6CurrentSkill({
        run_id: 'r-b',
        skill_invoked: { value: false, reason: null },
        skill_observation: {
          ...run6CurrentSkill().skill_observation,
          availability: { status: 'observed-absent', evidence_kind: 'runtime-catalog' },
          activation: { status: 'not-observed', evidence_kind: 'runtime-explicit-event' },
        },
      });
      const { groups, errors } = aggregateRuns([a, b]);
      expect(errors).toEqual([]);
      expect(groups.length).toBe(1);
      expect(groups[0].run_count).toBe(2);
    });
  });
});

describe('summarizeGroup', () => {
  it('computes skill_invoked_rate and success_rate', () => {
    const runs = [
      run({ skill_invocation_attempted: { value: true, reason: null }, skill_invoked: { value: true, reason: null }, success: { value: true, reason: null } }),
      run({ skill_invoked: { value: false, reason: null }, success: { value: false, reason: null } }),
    ];
    const summary = summarizeGroup(runs);
    expect(summary.run_count).toBe(2);
    expect(summary.skill_invoked_rate).toBe(0.5);
    expect(summary.success_rate).toBe(0.5);
  });

  it('returns null rates for an empty run list rather than dividing by zero', () => {
    const summary = summarizeGroup([]);
    expect(summary.skill_invoked_rate).toBeNull();
    expect(summary.success_rate).toBeNull();
  });
});

// Compatibility regression fix (agentic-eval-runtime-neutral-records-v1, Stage 1): canonical-
// json.mjs's extraction tightened canonicalStructuredValue to THROW on `undefined` (correct for its
// real security-relevant callers -- execution-profile/provenance hashing), but aggregateRuns()'s own
// bucket-key computation used to rely on the OLD, silently-tolerant behavior to let a schema<4
// record's genuinely-absent ambient_skill_profile (introduced in schema v4, never present before)
// flow through harmlessly into buildAggregateGroup's own graceful completeness error, instead of
// hard-crashing the entire aggregateRuns() call. Fixed by restricting canonicalization to
// object/array values only in the bucket-key computation (mirroring schemas.mjs's own unexported
// partitionFieldKey predicate) -- canonical-json.mjs itself is untouched.
describe('aggregateRuns -- bucket-key computation tolerates a genuinely absent (undefined) primitive field (compatibility regression fix)', () => {
  it('a schema:3 record with NO ambient_skill_profile key at all does not throw during bucketing, and reaches buildAggregateGroup\'s own graceful completeness error', () => {
    const a = run({ schema: 3, run_id: 'r-schema3-a' });
    const b = run({ schema: 3, run_id: 'r-schema3-b' });
    delete a.ambient_skill_profile;
    delete b.ambient_skill_profile;
    expect('ambient_skill_profile' in a).toBe(false);
    let result;
    expect(() => { result = aggregateRuns([a, b]); }).not.toThrow();
    expect(result.groups).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].errors.some((e) => e.field === 'ambient_skill_profile')).toBe(true);
  });

  it('canonicalStructuredValue(undefined) itself still throws -- canonical-json.mjs\'s own contract is untouched by this fix', () => {
    expect(() => canonicalStructuredValue(undefined)).toThrow(TypeError);
  });

  it('is insensitive to property insertion order for an object-valued field (ambient_skill_profile) -- the object/array canonicalization path still runs', () => {
    const scopeId = '00000000-0000-4000-8000-000000000000';
    const a = run({ run_id: 'r-order-x', ambient_skill_profile: { count: 1, scope_id: scopeId, fingerprint_hmac: 'f'.repeat(64) } });
    const b = run({ run_id: 'r-order-y', ambient_skill_profile: { fingerprint_hmac: 'f'.repeat(64), scope_id: scopeId, count: 1 } });
    const { groups, errors } = aggregateRuns([a, b]);
    expect(errors).toEqual([]);
    expect(groups.length).toBe(1);
    expect(groups[0].run_count).toBe(2);
  });

  // The real committed corpus (read-only) -- the actual failure this fix closes: before it,
  // aggregateRuns() crashed outright on this exact directory (8 real schema:3 records missing
  // ambient_skill_profile) instead of ever reaching buildAggregateGroup's own per-bucket error.
  // Pinned counts mirror Stage 0's own recorded baseline sanity anchors for this corpus.
  describe('real committed corpus (read-only, tools/runs/agentic-eval-scenario)', () => {
    const files = readdirSync(REAL_RUNS_DIR, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.json')).map((d) => d.name);
    const records = files.map((f) => validateRunRecordFile(join(REAL_RUNS_DIR, f))).filter((r) => r.errors.length === 0).map((r) => r.record);

    it('the corpus is non-empty (a silent zero would make every assertion below vacuously true)', () => {
      expect(records.length).toBeGreaterThan(0);
    });

    it('aggregateRuns() does not throw against the full real corpus', () => {
      expect(() => aggregateRuns(records)).not.toThrow();
    });

    it('produces exactly 78 groups and the same 4 historical "missing ambient_skill_profile" errors -- the 8 schema:3 records are reported, never silently excluded or silently included', () => {
      const { groups, errors } = aggregateRuns(records);
      expect(groups.length).toBe(78);
      const ambientProfileErrors = errors.filter((e) => e.errors.some((er) => er.field === 'ambient_skill_profile'));
      expect(ambientProfileErrors.length).toBe(4);
      const totalFlaggedRecords = ambientProfileErrors.reduce((sum, e) => {
        const match = e.errors.find((er) => er.field === 'ambient_skill_profile').message.match(/^(\d+) run\(s\)/);
        return sum + Number(match[1]);
      }, 0);
      expect(totalFlaggedRecords).toBe(8);
    });
  });
});

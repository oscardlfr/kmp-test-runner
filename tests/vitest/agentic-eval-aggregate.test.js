// tests/vitest/agentic-eval-aggregate.test.js
// Unit tests for tools/agentic-eval/aggregate.mjs -- Fairness Contract enforcement across a
// flat list of run records (bucketing + per-bucket validation). aggregateRuns() validates
// every record against the FULL run schema before bucketing, so these fixtures must be
// completely schema-valid, not just carry the partition/benchmark_eligible fields.
import { describe, it, expect } from 'vitest';
import { aggregateRuns, summarizeGroup } from '../../tools/agentic-eval/aggregate.mjs';
import { GRADING_CHECK_NAMES } from '../../tools/agentic-eval/graders.mjs';

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

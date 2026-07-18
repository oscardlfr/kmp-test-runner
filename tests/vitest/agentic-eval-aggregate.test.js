// tests/vitest/agentic-eval-aggregate.test.js
// Unit tests for tools/agentic-eval/aggregate.mjs -- Fairness Contract enforcement across a
// flat list of run records (bucketing + per-bucket validation). aggregateRuns() validates
// every record against the FULL run schema before bucketing, so these fixtures must be
// completely schema-valid, not just carry the partition/benchmark_eligible fields.
import { describe, it, expect } from 'vitest';
import { aggregateRuns, summarizeGroup } from '../../tools/agentic-eval/aggregate.mjs';

function run(overrides = {}) {
  return {
    schema: 1,
    run_id: `r-${Math.random().toString(36).slice(2)}`,
    run_kind: 'scenario',
    benchmark_eligible: true,
    scenario_id: 's1',
    query_id: null,
    condition: 'no-skill',
    skill_source_sha: null,
    kmp_test_cli_version: null,
    kmp_test_cli_source_sha: null,
    resolved_kmp_test_executable_path: null,
    model_requested: 'claude-sonnet-5',
    model_resolved: 'claude-sonnet-5',
    session_id_observed: 'sess-0001',
    repo_commit: 'c5c0661852f7c9da145ef56892048e706216a6ce',
    project_alias: 'sample',
    project_commit: 'abc123',
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

// tests/vitest/agentic-eval-aggregate.test.js
// Unit tests for tools/agentic-eval/aggregate.mjs -- Fairness Contract enforcement across a
// flat list of run records (bucketing + per-bucket validation).
import { describe, it, expect } from 'vitest';
import { aggregateRuns, summarizeGroup } from '../../tools/agentic-eval/aggregate.mjs';

function run(overrides = {}) {
  return {
    run_id: `r-${Math.random().toString(36).slice(2)}`,
    scenario_id: 's1', condition: 'no-skill', family: 'test-only',
    run_kind: 'scenario', cache_state: 'warm', benchmark_eligible: true,
    skill_invoked: { value: false, reason: null }, success: { value: true, reason: null },
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
});

describe('summarizeGroup', () => {
  it('computes skill_invoked_rate and success_rate', () => {
    const runs = [
      run({ skill_invoked: { value: true, reason: null }, success: { value: true, reason: null } }),
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

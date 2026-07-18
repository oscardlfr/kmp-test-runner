// tests/vitest/agentic-eval-schemas.test.js
// Unit tests for tools/agentic-eval/schemas.mjs.
import { describe, it, expect } from 'vitest';
import {
  CURRENT_RUN_SCHEMA,
  validateRun,
  validateScenario,
  buildAggregateGroup,
} from '../../tools/agentic-eval/schemas.mjs';

function baseRun(overrides = {}) {
  return {
    schema: CURRENT_RUN_SCHEMA,
    run_id: 'calibration-no-skill-abcd1234',
    run_kind: 'calibration',
    benchmark_eligible: false,
    scenario_id: 'calibration-explicit-invocation',
    query_id: null,
    condition: 'no-skill',
    skill_source_sha: null,
    kmp_test_cli_version: '0.14.0',
    kmp_test_cli_source_sha: 'c5c0661852f7c9da145ef56892048e706216a6ce',
    resolved_kmp_test_executable_path: 'tools/agentic-eval/fixtures/calibration-project',
    model_requested: 'claude-sonnet-5',
    model_resolved: 'claude-sonnet-5',
    session_id_observed: 'sess-0001',
    repo_commit: 'c5c0661852f7c9da145ef56892048e706216a6ce',
    project_alias: 'calibration-project',
    project_commit: null,
    platform: 'windows',
    family: 'trigger-only',
    cache_state: 'unknown',
    daemon_policy: 'disabled-via-gradle-user-home-properties',
    env_allowlist_profile: 'narrow',
    seed: null,
    order_index: null,
    started_at: '2026-07-18T00:00:00.000Z',
    ended_at: '2026-07-18T00:00:01.000Z',
    wall_clock_ms: 1000,
    skill_available: { value: false, reason: null },
    skill_invoked: { value: false, reason: null },
    skill_invocation_event: null,
    success: { value: null, reason: 'calibration run -- success grading not applicable' },
    expected_outcome_matched: { value: null, reason: 'calibration run -- no scenario grader applies' },
    first_useful_signal_ms: { value: null, reason: 'calibration run -- no signal predicate applies' },
    first_useful_signal_event: null,
    tokens: {
      input: { value: 2, reason: null },
      output: { value: 4, reason: null },
      cache_read: { value: 0, reason: null },
      cache_creation: { value: 0, reason: null },
    },
    tool_calls_total: { value: 1, reason: null },
    shell_commands_total: { value: 1, reason: null },
    test_invocations_total: { value: null, reason: 'not tracked for calibration runs' },
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
    privacy_status: 'redacted-private',
    raw_capture_committed: false,
    raw_capture_location: 'tools/runs/agentic-eval-calibration/raw/',
    notes: '',
    errors: [],
    ...overrides,
  };
}

describe('validateRun', () => {
  it('accepts a well-formed record', () => {
    const { errors } = validateRun(baseRun());
    expect(errors).toEqual([]);
  });

  it('rejects a missing required field', () => {
    const run = baseRun();
    delete run.run_kind;
    const { errors } = validateRun(run);
    expect(errors.some((e) => e.field === 'run_kind')).toBe(true);
  });

  it('warns (does not error) on an unrecognized extra field', () => {
    const run = { ...baseRun(), unexpected_extra_field: 'x' };
    const { errors, warnings } = validateRun(run);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.field === 'unexpected_extra_field')).toBe(true);
  });

  it('rejects wrong schema version', () => {
    const { errors } = validateRun(baseRun({ schema: 999 }));
    expect(errors.some((e) => e.field === 'schema')).toBe(true);
  });

  it('rejects an invalid run_kind', () => {
    const { errors } = validateRun(baseRun({ run_kind: 'not-a-real-kind' }));
    expect(errors.some((e) => e.field === 'run_kind')).toBe(true);
  });

  it('rejects benchmark_eligible:true for a non-scenario run_kind', () => {
    const { errors } = validateRun(baseRun({ run_kind: 'calibration', benchmark_eligible: true }));
    expect(errors.some((e) => e.field === 'benchmark_eligible')).toBe(true);
  });

  it('allows benchmark_eligible:true for run_kind scenario', () => {
    const { errors } = validateRun(baseRun({ run_kind: 'scenario', benchmark_eligible: true }));
    expect(errors.filter((e) => e.field === 'benchmark_eligible')).toEqual([]);
  });

  it('requires skill_source_sha when condition is current-skill', () => {
    const { errors } = validateRun(baseRun({ condition: 'current-skill', skill_source_sha: null }));
    expect(errors.some((e) => e.field === 'skill_source_sha')).toBe(true);
  });

  it('rejects a non-null skill_source_sha when condition is no-skill', () => {
    const { errors } = validateRun(baseRun({ condition: 'no-skill', skill_source_sha: 'deadbeef' }));
    expect(errors.some((e) => e.field === 'skill_source_sha')).toBe(true);
  });

  it('accepts candidate-skill as a valid enum value', () => {
    const { errors } = validateRun(baseRun({ condition: 'candidate-skill', skill_source_sha: null }));
    expect(errors.filter((e) => e.field === 'condition')).toEqual([]);
  });

  describe('nullable-metric {value, reason} contract', () => {
    it('rejects value:null paired with reason:null -- never infer, always explain', () => {
      const { errors } = validateRun(baseRun({ skill_invoked: { value: null, reason: null } }));
      expect(errors.some((e) => e.field === 'skill_invoked')).toBe(true);
    });

    it('accepts value:null when a reason is given', () => {
      const { errors } = validateRun(baseRun({ skill_invoked: { value: null, reason: 'session terminated before invocation' } }));
      expect(errors.filter((e) => e.field === 'skill_invoked')).toEqual([]);
    });

    it('rejects a reason present alongside a non-null value', () => {
      const { errors } = validateRun(baseRun({ retries: { value: 0, reason: 'should not be here' } }));
      expect(errors.some((e) => e.field === 'retries')).toBe(true);
    });

    it('rejects a field missing the {value,reason} shape entirely', () => {
      const { errors } = validateRun(baseRun({ retries: 0 }));
      expect(errors.some((e) => e.field === 'retries')).toBe(true);
    });

    it('validates every tokens.* sub-field independently', () => {
      const { errors } = validateRun(baseRun({ tokens: { input: { value: null, reason: null }, output: { value: 1, reason: null }, cache_read: { value: 0, reason: null }, cache_creation: { value: 0, reason: null } } }));
      expect(errors.some((e) => e.field === 'tokens.input')).toBe(true);
    });
  });

  it('rejects raw_capture_committed:true -- raw transcripts are never committed', () => {
    const { errors } = validateRun(baseRun({ raw_capture_committed: true }));
    expect(errors.some((e) => e.field === 'raw_capture_committed')).toBe(true);
  });

  it('rejects an absolute raw_capture_location', () => {
    const { errors } = validateRun(baseRun({ raw_capture_location: 'C:\\Users\\someone\\raw.jsonl' }));
    expect(errors.some((e) => e.field === 'raw_capture_location')).toBe(true);
  });

  it('rejects hook_deny_count exceeding hook_call_count', () => {
    const { errors } = validateRun(baseRun({ hook_call_count: 1, hook_deny_count: 2 }));
    expect(errors.some((e) => e.field === 'hook_deny_count')).toBe(true);
  });

  it('rejects a malformed policy_sha256', () => {
    const { errors } = validateRun(baseRun({ policy_sha256: 'not-a-hash' }));
    expect(errors.some((e) => e.field === 'policy_sha256')).toBe(true);
  });

  it('rejects terminated:false paired with a non-null termination_reason', () => {
    const { errors } = validateRun(baseRun({ terminated: false, termination_reason: 'timeout' }));
    expect(errors.some((e) => e.field === 'termination_reason')).toBe(true);
  });
});

describe('validateScenario', () => {
  function baseScenario(overrides = {}) {
    return {
      schema: 1,
      id: 'sample-scenario',
      family: 'test-only',
      project_alias: 'sample',
      project_url: 'https://github.com/example/sample',
      project_commit: 'abc123',
      prompt: 'Run the tests for this project.',
      expected_outcome: 'Tests run and results are reported.',
      grader: { kind: 'text-contains' },
      first_useful_signal_predicate: { description: 'first mention of test results' },
      tags: ['train'],
      ...overrides,
    };
  }

  it('accepts a well-formed scenario', () => {
    const { errors } = validateScenario(baseScenario());
    expect(errors).toEqual([]);
  });

  it('rejects a prompt mentioning kmp-test by name', () => {
    const { errors } = validateScenario(baseScenario({ prompt: 'Run kmp-test parallel --json on this project.' }));
    expect(errors.some((e) => e.field === 'prompt')).toBe(true);
  });

  it('rejects a prompt mentioning the skill name', () => {
    const { errors } = validateScenario(baseScenario({ prompt: 'Use the kmp-test-runner skill here.' }));
    expect(errors.some((e) => e.field === 'prompt')).toBe(true);
  });

  it('rejects a prompt mentioning the bin path', () => {
    const { errors } = validateScenario(baseScenario({ prompt: 'Run node bin/kmp-test.js parallel.' }));
    expect(errors.some((e) => e.field === 'prompt')).toBe(true);
  });

  it('rejects a non-https project_url', () => {
    const { errors } = validateScenario(baseScenario({ project_url: 'http://example.com/repo' }));
    expect(errors.some((e) => e.field === 'project_url')).toBe(true);
  });

  it('rejects family "trigger-only" for a scenario (that value is run-record-only)', () => {
    const { errors } = validateScenario(baseScenario({ family: 'trigger-only' }));
    expect(errors.some((e) => e.field === 'family')).toBe(true);
  });
});

describe('buildAggregateGroup -- Fairness Contract as code', () => {
  function run(overrides = {}) {
    return {
      run_id: 'r1', scenario_id: 's1', condition: 'no-skill', family: 'test-only',
      run_kind: 'scenario', cache_state: 'warm', benchmark_eligible: true,
      skill_invoked: { value: false, reason: null }, success: { value: true, reason: null },
      ...overrides,
    };
  }

  it('groups a homogeneous, benchmark_eligible set of runs cleanly', () => {
    const { errors, group } = buildAggregateGroup([run({ run_id: 'r1' }), run({ run_id: 'r2' })]);
    expect(errors).toEqual([]);
    expect(group.run_count).toBe(2);
  });

  it('refuses to mix family within one aggregate group', () => {
    const { errors } = buildAggregateGroup([run({ family: 'test-only' }), run({ family: 'coverage' })]);
    expect(errors.some((e) => e.field === 'family')).toBe(true);
  });

  it('refuses to mix cache_state within one aggregate group', () => {
    const { errors } = buildAggregateGroup([run({ cache_state: 'warm' }), run({ cache_state: 'cold' })]);
    expect(errors.some((e) => e.field === 'cache_state')).toBe(true);
  });

  it('refuses to mix run_kind within one aggregate group', () => {
    const { errors } = buildAggregateGroup([run({ run_kind: 'scenario' }), run({ run_kind: 'smoke', benchmark_eligible: true })]);
    expect(errors.some((e) => e.field === 'run_kind')).toBe(true);
  });

  it('refuses any benchmark_eligible:false run outright', () => {
    const { errors } = buildAggregateGroup([run({ benchmark_eligible: false })]);
    expect(errors.some((e) => e.field === 'benchmark_eligible')).toBe(true);
  });

  it('refuses an empty run list', () => {
    const { errors, group } = buildAggregateGroup([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(group).toBeNull();
  });
});

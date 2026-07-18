// tests/vitest/agentic-eval-schemas.test.js
// Unit tests for tools/agentic-eval/schemas.mjs.
import { describe, it, expect } from 'vitest';
import {
  CURRENT_RUN_SCHEMA,
  validateRun,
  validateScenario,
  validateTriggerQueries,
  buildAggregateGroup,
  HARD_PARTITION_FIELDS,
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
    claude_code_version: '1.2.3-fake',
    repo_commit: 'c5c0661852f7c9da145ef56892048e706216a6ce',
    project_alias: 'calibration-project',
    project_commit: null,
    project_url: null,
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
    skill_invocation_attempted: { value: false, reason: null },
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

  // Regression coverage for a real schema bypass CodeRabbit independently confirmed: the
  // original check only validated hook_call_count/hook_deny_count as a PAIR, gated on BOTH
  // being non-null (`run.hook_call_count != null && run.hook_deny_count != null`). If one field
  // was a wrong type while the OTHER was null, the outer guard was false and the ENTIRE check
  // block -- including the wrong-typed field's own validation -- was skipped, silently
  // accepting the malformed value.
  describe('hook_call_count/hook_deny_count are validated independently, never gated on the other', () => {
    it('rejects a non-integer hook_call_count even when hook_deny_count is null', () => {
      const { errors } = validateRun(baseRun({ hook_call_count: 'bad', hook_deny_count: null }));
      expect(errors.some((e) => e.field === 'hook_call_count')).toBe(true);
    });

    it('rejects a non-integer hook_deny_count even when hook_call_count is null', () => {
      const { errors } = validateRun(baseRun({ hook_call_count: null, hook_deny_count: 'bad' }));
      expect(errors.some((e) => e.field === 'hook_deny_count')).toBe(true);
    });

    it('rejects hook_call_count being null outright -- it is never legitimately absent', () => {
      const { errors } = validateRun(baseRun({ hook_call_count: null }));
      expect(errors.some((e) => e.field === 'hook_call_count')).toBe(true);
    });

    it('rejects a negative hook_deny_count', () => {
      const { errors } = validateRun(baseRun({ hook_deny_count: -1 }));
      expect(errors.some((e) => e.field === 'hook_deny_count')).toBe(true);
    });

    it('accepts well-formed, independently-valid non-negative integers', () => {
      const { errors } = validateRun(baseRun({ hook_call_count: 5, hook_deny_count: 2 }));
      expect(errors.filter((e) => e.field === 'hook_call_count' || e.field === 'hook_deny_count')).toEqual([]);
    });
  });

  it('rejects a malformed policy_sha256', () => {
    const { errors } = validateRun(baseRun({ policy_sha256: 'not-a-hash' }));
    expect(errors.some((e) => e.field === 'policy_sha256')).toBe(true);
  });

  it('rejects terminated:false paired with a non-null termination_reason', () => {
    const { errors } = validateRun(baseRun({ terminated: false, termination_reason: 'timeout' }));
    expect(errors.some((e) => e.field === 'termination_reason')).toBe(true);
  });

  describe('exit_code domain', () => {
    it('accepts a null exit_code', () => {
      const { errors } = validateRun(baseRun({ exit_code: null }));
      expect(errors.filter((e) => e.field === 'exit_code')).toEqual([]);
    });

    it('accepts a nonzero integer exit_code', () => {
      const { errors } = validateRun(baseRun({ exit_code: 7 }));
      expect(errors.filter((e) => e.field === 'exit_code')).toEqual([]);
    });

    it('rejects a non-integer exit_code', () => {
      const { errors } = validateRun(baseRun({ exit_code: 1.5 }));
      expect(errors.some((e) => e.field === 'exit_code')).toBe(true);
    });

    it('rejects a string exit_code', () => {
      const { errors } = validateRun(baseRun({ exit_code: '0' }));
      expect(errors.some((e) => e.field === 'exit_code')).toBe(true);
    });
  });

  describe('started_at/ended_at/wall_clock_ms domain', () => {
    it('rejects a non-ISO started_at', () => {
      const { errors } = validateRun(baseRun({ started_at: 'not-a-timestamp' }));
      expect(errors.some((e) => e.field === 'started_at')).toBe(true);
    });

    it('rejects a non-ISO ended_at', () => {
      const { errors } = validateRun(baseRun({ ended_at: 'not-a-timestamp' }));
      expect(errors.some((e) => e.field === 'ended_at')).toBe(true);
    });

    it('rejects ended_at before started_at', () => {
      const { errors } = validateRun(baseRun({ started_at: '2026-07-18T00:00:05.000Z', ended_at: '2026-07-18T00:00:00.000Z' }));
      expect(errors.some((e) => e.field === 'ended_at')).toBe(true);
    });

    it('accepts ended_at equal to started_at', () => {
      const { errors } = validateRun(baseRun({ started_at: '2026-07-18T00:00:00.000Z', ended_at: '2026-07-18T00:00:00.000Z' }));
      expect(errors.filter((e) => e.field === 'ended_at')).toEqual([]);
    });

    it('rejects a null wall_clock_ms -- it is always computed from real timestamps, never legitimately absent', () => {
      const { errors } = validateRun(baseRun({ wall_clock_ms: null }));
      expect(errors.some((e) => e.field === 'wall_clock_ms')).toBe(true);
    });

    it('rejects a negative wall_clock_ms', () => {
      const { errors } = validateRun(baseRun({ wall_clock_ms: -1 }));
      expect(errors.some((e) => e.field === 'wall_clock_ms')).toBe(true);
    });
  });

  describe('skill_invoked / skill_invocation_attempted correlation contract', () => {
    it('rejects skill_invoked:true when skill_invocation_attempted is not true -- a confirmed invocation always implies an attempt', () => {
      const { errors } = validateRun(baseRun({
        skill_invocation_attempted: { value: false, reason: null },
        skill_invoked: { value: true, reason: null },
      }));
      expect(errors.some((e) => e.field === 'skill_invoked')).toBe(true);
    });

    it('accepts skill_invoked:true when skill_invocation_attempted is also true', () => {
      const { errors } = validateRun(baseRun({
        skill_invocation_attempted: { value: true, reason: null },
        skill_invoked: { value: true, reason: null },
      }));
      expect(errors.filter((e) => e.field === 'skill_invoked')).toEqual([]);
    });

    it('accepts an attempt that was not confirmed (attempted:true, invoked:false) -- the real "Unknown skill" shape', () => {
      const { errors } = validateRun(baseRun({
        skill_invocation_attempted: { value: true, reason: null },
        skill_invoked: { value: false, reason: null },
      }));
      expect(errors.filter((e) => e.field === 'skill_invoked')).toEqual([]);
    });
  });

  describe('policy_allowed_* array and errors[] domain', () => {
    it('rejects a non-array policy_allowed_gradle_tasks', () => {
      const { errors } = validateRun(baseRun({ policy_allowed_gradle_tasks: 'build' }));
      expect(errors.some((e) => e.field === 'policy_allowed_gradle_tasks')).toBe(true);
    });

    it('rejects an empty-string entry in policy_allowed_kmptest_subcommands', () => {
      const { errors } = validateRun(baseRun({ policy_allowed_kmptest_subcommands: ['doctor', ''] }));
      expect(errors.some((e) => e.field === 'policy_allowed_kmptest_subcommands')).toBe(true);
    });

    it('accepts an empty array for either policy list -- "nothing in this category is allowed" is valid config', () => {
      const { errors } = validateRun(baseRun({ policy_allowed_gradle_tasks: [], policy_allowed_kmptest_subcommands: [] }));
      expect(errors.filter((e) => e.field === 'policy_allowed_gradle_tasks' || e.field === 'policy_allowed_kmptest_subcommands')).toEqual([]);
    });

    it('rejects a non-array errors field', () => {
      const { errors } = validateRun(baseRun({ errors: 'oops' }));
      expect(errors.some((e) => e.field === 'errors')).toBe(true);
    });

    it('rejects a string entry inside errors[]', () => {
      const { errors } = validateRun(baseRun({ errors: ['plain string error'] }));
      expect(errors.some((e) => e.field === 'errors')).toBe(true);
    });

    it('accepts a well-formed errors[] entry', () => {
      const { errors } = validateRun(baseRun({ errors: [{ code: 'timeout', message: 'exceeded 180000ms' }] }));
      expect(errors.filter((e) => e.field === 'errors')).toEqual([]);
    });
  });

  describe('nullable-metric value type/domain validation', () => {
    it('rejects a string value for a boolean-typed metric (e.g. skill_invoked: "false")', () => {
      const { errors } = validateRun(baseRun({ skill_invoked: { value: 'false', reason: null } }));
      expect(errors.some((e) => e.field === 'skill_invoked')).toBe(true);
    });

    it('rejects a negative value for a count-typed metric', () => {
      const { errors } = validateRun(baseRun({ retries: { value: -1, reason: null } }));
      expect(errors.some((e) => e.field === 'retries')).toBe(true);
    });

    it('rejects a fractional value for a count-typed metric', () => {
      const { errors } = validateRun(baseRun({ output_bytes: { value: 1.5, reason: null } }));
      expect(errors.some((e) => e.field === 'output_bytes')).toBe(true);
    });

    it('accepts a fractional non-negative value for the timing-typed metric', () => {
      const { errors } = validateRun(baseRun({ first_useful_signal_ms: { value: 12.5, reason: null } }));
      expect(errors.filter((e) => e.field === 'first_useful_signal_ms')).toEqual([]);
    });

    it('rejects a negative value for the timing-typed metric', () => {
      const { errors } = validateRun(baseRun({ first_useful_signal_ms: { value: -1, reason: null } }));
      expect(errors.some((e) => e.field === 'first_useful_signal_ms')).toBe(true);
    });

    it('rejects a negative token count', () => {
      const { errors } = validateRun(baseRun({ tokens: { input: { value: -5, reason: null }, output: { value: 1, reason: null }, cache_read: { value: 0, reason: null }, cache_creation: { value: 0, reason: null } } }));
      expect(errors.some((e) => e.field === 'tokens.input')).toBe(true);
    });

    it('a null value still skips domain validation (governed by the {value,reason} contract instead)', () => {
      const { errors } = validateRun(baseRun({ retries: { value: null, reason: 'not tracked' } }));
      expect(errors.filter((e) => e.field === 'retries')).toEqual([]);
    });
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
      project_commit: 'abc123', model_resolved: 'claude-sonnet-5', platform: 'windows',
      skill_source_sha: null, policy_sha256: 'a'.repeat(64), claude_code_version: '1.2.3-fake',
      kmp_test_cli_source_sha: 'c5c0661852f7c9da145ef56892048e706216a6ce',
      skill_invoked: { value: false, reason: null }, success: { value: true, reason: null },
      ...overrides,
    };
  }

  it('groups a homogeneous, benchmark_eligible set of runs cleanly', () => {
    const { errors, group } = buildAggregateGroup([run({ run_id: 'r1' }), run({ run_id: 'r2' })]);
    expect(errors).toEqual([]);
    expect(group.run_count).toBe(2);
  });

  it('rejects duplicate run_id values -- a re-submitted run must not inflate run_count', () => {
    const { errors, group } = buildAggregateGroup([run({ run_id: 'r1' }), run({ run_id: 'r1' })]);
    expect(errors.some((e) => e.field === 'run_id')).toBe(true);
    expect(group).toBeNull();
  });

  it('rejects an empty run_id', () => {
    const { errors } = buildAggregateGroup([run({ run_id: '' }), run({ run_id: 'r2' })]);
    expect(errors.some((e) => e.field === 'run_id')).toBe(true);
  });

  it('refuses to mix project_commit within one aggregate group', () => {
    const { errors } = buildAggregateGroup([run({ run_id: 'r1', project_commit: 'abc123' }), run({ run_id: 'r2', project_commit: 'def456' })]);
    expect(errors.some((e) => e.field === 'project_commit')).toBe(true);
  });

  it('refuses to mix model_resolved within one aggregate group', () => {
    const { errors } = buildAggregateGroup([run({ run_id: 'r1', model_resolved: 'claude-sonnet-5' }), run({ run_id: 'r2', model_resolved: 'claude-opus-4-8' })]);
    expect(errors.some((e) => e.field === 'model_resolved')).toBe(true);
  });

  it('refuses to mix platform within one aggregate group', () => {
    const { errors } = buildAggregateGroup([run({ run_id: 'r1', platform: 'windows' }), run({ run_id: 'r2', platform: 'linux' })]);
    expect(errors.some((e) => e.field === 'platform')).toBe(true);
  });

  it('refuses to mix skill_source_sha within one aggregate group (a re-pinned skill snapshot)', () => {
    const { errors } = buildAggregateGroup([run({ run_id: 'r1', skill_source_sha: 'sha-a' }), run({ run_id: 'r2', skill_source_sha: 'sha-b' })]);
    expect(errors.some((e) => e.field === 'skill_source_sha')).toBe(true);
  });

  it('refuses to mix policy_sha256 within one aggregate group (a changed policy-hook version)', () => {
    const { errors } = buildAggregateGroup([run({ run_id: 'r1', policy_sha256: 'a'.repeat(64) }), run({ run_id: 'r2', policy_sha256: 'b'.repeat(64) })]);
    expect(errors.some((e) => e.field === 'policy_sha256')).toBe(true);
  });

  it('refuses to mix claude_code_version within one aggregate group (a different Claude Code CLI release)', () => {
    const { errors } = buildAggregateGroup([run({ run_id: 'r1', claude_code_version: '1.2.3' }), run({ run_id: 'r2', claude_code_version: '1.3.0' })]);
    expect(errors.some((e) => e.field === 'claude_code_version')).toBe(true);
  });

  // Regression coverage for a real gap an independent review pass found: claude_code_version
  // being merely PRESENT was validateRun's job; buildAggregateGroup's own mixing check treats
  // `null`/`null` as "agreeing" (same partition key), which would otherwise silently permit
  // folding two runs with genuinely unknown -- and possibly DIFFERENT -- Claude Code CLI
  // releases into one aggregate, exactly the cross-release averaging this field exists to
  // prevent. Aggregation eligibility now requires a concrete, non-empty string.
  it('refuses aggregation when claude_code_version is null on any run, even if every run agrees it is null', () => {
    const { errors, group } = buildAggregateGroup([run({ run_id: 'r1', claude_code_version: null }), run({ run_id: 'r2', claude_code_version: null })]);
    expect(errors.some((e) => e.field === 'claude_code_version')).toBe(true);
    expect(group).toBeNull();
  });

  it('refuses aggregation when claude_code_version is an empty string on every run (not just caught incidentally by the mixing check)', () => {
    const { errors } = buildAggregateGroup([run({ run_id: 'r1', claude_code_version: '' }), run({ run_id: 'r2', claude_code_version: '' })]);
    expect(errors.some((e) => e.field === 'claude_code_version')).toBe(true);
  });

  it('accepts aggregation when every run has the same concrete, non-empty claude_code_version', () => {
    const { errors, group } = buildAggregateGroup([run({ run_id: 'r1', claude_code_version: '1.2.3' }), run({ run_id: 'r2', claude_code_version: '1.2.3' })]);
    expect(errors.filter((e) => e.field === 'claude_code_version')).toEqual([]);
    expect(group.group_key.claude_code_version).toBe('1.2.3');
  });

  // Regression coverage for a real gap an independent review pass found: the claude_code_version
  // fix above closed ONE field, but the SAME "null === null falsely agrees" risk applies to any
  // HARD_PARTITION_FIELDS-adjacent field that can legitimately be null on a per-record basis.
  // Scoped narrowly to run_kind:'scenario' + benchmark_eligible:true (the fixture's own defaults)
  // -- this PR's own calibration/corpus-probe/smoke runs are always benchmark_eligible:false and
  // legitimately carry null project_commit/model_resolved, so a blanket requirement would
  // incorrectly reject them.
  describe('scenario + benchmark_eligible completeness matrix (project_commit, model_resolved, kmp_test_cli_source_sha)', () => {
    for (const field of ['project_commit', 'model_resolved', 'kmp_test_cli_source_sha']) {
      it(`refuses aggregation when ${field} is null on every scenario+eligible run, even though every run agrees it is null`, () => {
        const { errors, group } = buildAggregateGroup([run({ run_id: 'r1', [field]: null }), run({ run_id: 'r2', [field]: null })]);
        expect(errors.some((e) => e.field === field)).toBe(true);
        expect(group).toBeNull();
      });
    }

    it('does NOT apply to calibration runs (run_kind !== scenario), where project_commit/model_resolved are legitimately null', () => {
      const { errors } = buildAggregateGroup([
        run({ run_id: 'r1', run_kind: 'calibration', project_commit: null, model_resolved: null, kmp_test_cli_source_sha: null }),
        run({ run_id: 'r2', run_kind: 'calibration', project_commit: null, model_resolved: null, kmp_test_cli_source_sha: null }),
      ]);
      expect(errors.filter((e) => ['project_commit', 'model_resolved', 'kmp_test_cli_source_sha'].includes(e.field))).toEqual([]);
    });

    it('does NOT apply when benchmark_eligible is false (already refused outright by the existing check)', () => {
      const { errors } = buildAggregateGroup([
        run({ run_id: 'r1', benchmark_eligible: false, project_commit: null, model_resolved: null, kmp_test_cli_source_sha: null }),
      ]);
      // The pre-existing benchmark_eligible refusal fires; the completeness matrix specifically
      // must not ALSO fire redundantly for a group that's already rejected for a different reason.
      expect(errors.some((e) => e.field === 'benchmark_eligible')).toBe(true);
      expect(errors.filter((e) => ['project_commit', 'model_resolved', 'kmp_test_cli_source_sha'].includes(e.field))).toEqual([]);
    });

    it('accepts a scenario+eligible group when every completeness-matrix field is concrete', () => {
      const { errors, group } = buildAggregateGroup([
        run({ run_id: 'r1', project_commit: 'abc123', model_resolved: 'claude-sonnet-5', kmp_test_cli_source_sha: 'c5c0661852f7c9da145ef56892048e706216a6ce' }),
        run({ run_id: 'r2', project_commit: 'abc123', model_resolved: 'claude-sonnet-5', kmp_test_cli_source_sha: 'c5c0661852f7c9da145ef56892048e706216a6ce' }),
      ]);
      expect(errors).toEqual([]);
      expect(group.run_count).toBe(2);
    });
  });

  it('group_key carries every hard partition field, not just the original five', () => {
    const { group } = buildAggregateGroup([run({ run_id: 'r1' }), run({ run_id: 'r2' })]);
    expect(group.group_key.project_commit).toBe('abc123');
    expect(group.group_key.model_resolved).toBe('claude-sonnet-5');
    expect(group.group_key.platform).toBe('windows');
    expect(group.group_key.policy_sha256).toBe('a'.repeat(64));
  });

  it('HARD_PARTITION_FIELDS includes env_allowlist_profile/policy_allowed_gradle_tasks/policy_allowed_kmptest_subcommands', () => {
    expect(HARD_PARTITION_FIELDS).toContain('env_allowlist_profile');
    expect(HARD_PARTITION_FIELDS).toContain('policy_allowed_gradle_tasks');
    expect(HARD_PARTITION_FIELDS).toContain('policy_allowed_kmptest_subcommands');
    expect(HARD_PARTITION_FIELDS).toContain('claude_code_version');
    expect(HARD_PARTITION_FIELDS.length).toBe(16);
  });

  it('refuses to mix policy_allowed_gradle_tasks within one aggregate group (a materially different command policy)', () => {
    const { errors } = buildAggregateGroup([
      run({ run_id: 'r1', policy_allowed_gradle_tasks: ['build'] }),
      run({ run_id: 'r2', policy_allowed_gradle_tasks: ['build', 'test'] }),
    ]);
    expect(errors.some((e) => e.field === 'policy_allowed_gradle_tasks')).toBe(true);
  });

  // Regression coverage: a plain `new Set(runs.map(r => r[f]))` compares array VALUES by
  // object reference, so two runs with a STRUCTURALLY IDENTICAL array as two separate object
  // instances would previously be spuriously flagged as "mixed" even though they represent the
  // exact same policy configuration.
  it('does NOT mix two runs whose policy_allowed_gradle_tasks are structurally identical but separate array instances', () => {
    const { errors, group } = buildAggregateGroup([
      run({ run_id: 'r1', policy_allowed_gradle_tasks: ['build', 'test'] }),
      run({ run_id: 'r2', policy_allowed_gradle_tasks: ['build', 'test'] }),
    ]);
    expect(errors.filter((e) => e.field === 'policy_allowed_gradle_tasks')).toEqual([]);
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

// Regression coverage for a real contradiction an independent review pass found: `corpus
// validate` only counted should-trigger/near-miss categories, even though the README claims it
// validates shape and banned terms too. validateTriggerQueries() is the fix -- ported from
// tests/vitest/agentic-eval-corpus.test.js's own (pre-existing) assertions into a single,
// shared, exported function both the CLI command and that test now call.
describe('validateTriggerQueries', () => {
  function baseQuery(overrides = {}) {
    return { id: 'q-01', expected: 'should-trigger', partition: 'train', text: 'Run the tests for this project and tell me what failed.', ...overrides };
  }
  function trainAndHeldOut(expected, startId) {
    return [
      baseQuery({ id: `${startId}-train`, expected, partition: 'train' }),
      baseQuery({ id: `${startId}-held`, expected, partition: 'held-out' }),
    ];
  }
  function tenOfEach() {
    const queries = [];
    for (let i = 0; i < 10; i++) queries.push(baseQuery({ id: `st-${i}`, expected: 'should-trigger', partition: i % 2 === 0 ? 'train' : 'held-out' }));
    for (let i = 0; i < 10; i++) queries.push(baseQuery({ id: `nm-${i}`, expected: 'near-miss', partition: i % 2 === 0 ? 'train' : 'held-out' }));
    return { schema: 1, queries };
  }

  it('accepts a well-formed trigger-queries document', () => {
    const { errors } = validateTriggerQueries(tenOfEach());
    expect(errors).toEqual([]);
  });

  it('rejects a non-object / missing queries array', () => {
    expect(validateTriggerQueries(null).errors.length).toBeGreaterThan(0);
    expect(validateTriggerQueries({}).errors.length).toBeGreaterThan(0);
  });

  it('rejects a query with a missing/empty id', () => {
    const doc = tenOfEach();
    doc.queries[0].id = '';
    const { errors } = validateTriggerQueries(doc);
    expect(errors.some((e) => e.field.endsWith('.id'))).toBe(true);
  });

  it('rejects a duplicate id', () => {
    const doc = tenOfEach();
    doc.queries[1].id = doc.queries[0].id;
    const { errors } = validateTriggerQueries(doc);
    expect(errors.some((e) => e.field.endsWith('.id') && e.message.includes('duplicate'))).toBe(true);
  });

  it('rejects an invalid expected value', () => {
    const doc = tenOfEach();
    doc.queries[0].expected = 'sometimes-triggers';
    const { errors } = validateTriggerQueries(doc);
    expect(errors.some((e) => e.field.endsWith('.expected'))).toBe(true);
  });

  it('rejects an invalid partition value', () => {
    const doc = tenOfEach();
    doc.queries[0].partition = 'validation';
    const { errors } = validateTriggerQueries(doc);
    expect(errors.some((e) => e.field.endsWith('.partition'))).toBe(true);
  });

  it('rejects query text mentioning kmp-test by name', () => {
    const doc = tenOfEach();
    doc.queries[0].text = 'Run kmp-test parallel --json on this project.';
    const { errors } = validateTriggerQueries(doc);
    expect(errors.some((e) => e.field.endsWith('.text') && e.message.includes('kmp-test'))).toBe(true);
  });

  it('rejects query text hinting at an expected command or activation outcome', () => {
    const doc = tenOfEach();
    doc.queries[0].text = 'Please invoke the skill and run gradlew for me.';
    const { errors } = validateTriggerQueries(doc);
    expect(errors.some((e) => e.field.endsWith('.text') && e.message.includes('activation'))).toBe(true);
  });

  it('rejects fewer than 10 should-trigger queries', () => {
    const doc = tenOfEach();
    doc.queries = doc.queries.filter((q) => q.expected !== 'should-trigger' || q.id !== 'st-9');
    const { errors } = validateTriggerQueries(doc);
    expect(errors.some((e) => e.message.includes('should-trigger'))).toBe(true);
  });

  it('rejects fewer than 10 near-miss queries', () => {
    const doc = tenOfEach();
    doc.queries = doc.queries.filter((q) => q.expected !== 'near-miss' || q.id !== 'nm-9');
    const { errors } = validateTriggerQueries(doc);
    expect(errors.some((e) => e.message.includes('near-miss'))).toBe(true);
  });

  it('rejects a category missing train or held-out partition coverage', () => {
    const doc = tenOfEach();
    // Force every should-trigger query onto the same partition.
    for (const q of doc.queries) if (q.expected === 'should-trigger') q.partition = 'train';
    const { errors } = validateTriggerQueries(doc);
    expect(errors.some((e) => e.message.includes('held-out'))).toBe(true);
  });
});

// tests/vitest/agentic-eval-schemas.test.js
// Unit tests for tools/agentic-eval/schemas.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUPPORTED_RUN_SCHEMAS,
  LATEST_RUN_SCHEMA,
  validateRun,
  validateScenario,
  validateTriggerQueries,
  buildAggregateGroup,
  validateAggregateGroupKey,
  HARD_PARTITION_FIELDS,
  CURRENT_AGGREGATE_SCHEMA,
  canonicalStructuredValue,
} from '../../tools/agentic-eval/schemas.mjs';
import { GRADING_CHECK_NAMES } from '../../tools/agentic-eval/graders.mjs';
import { canonicalJsonSha256 } from '../../tools/agentic-eval/canonical-json.mjs';

// The real strict-policy-v1 projection computeExecutionProfileSha256 (registries.mjs) hashes --
// computed here rather than hardcoded, so this fixture can never silently drift from the actual
// hash algorithm schemas.mjs's own execution_profile validator now recomputes and checks against.
const STRICT_POLICY_V1_SHA256 = canonicalJsonSha256({
  id: 'strict-policy-v1', isolation_kind: 'runtime-policy-hooks', network_mode: 'runtime-default',
  isolation_attestation_required: false, policy_mode: 'required', required_capabilities: ['softPermissionDenial'],
});

// PR 4: the real sandboxed-unrestricted-v1 projection, computed the identical way -- never
// hardcoded, so this fixture can never silently drift from the real hash algorithm either.
const UNRESTRICTED_POLICY_V1_SHA256 = canonicalJsonSha256({
  id: 'sandboxed-unrestricted-v1', isolation_kind: 'external-sandbox', network_mode: 'restricted',
  isolation_attestation_required: true, policy_mode: 'not_applicable',
  required_capabilities: ['structuredTranscript', 'correlatedToolResults', 'skillStateEvidence'],
});
const FAKE_ATTESTATION_SHA256 = 'f'.repeat(64);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function baseRun(overrides = {}) {
  return {
    schema: 1,
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

// Module-scope (not describe-body-scope) so both the v1-v5 describe block below AND the sibling
// schema-v6 describe block can share them without a second, independently-drifting copy.
const VALID_SCOPE_ID = '11111111-2222-4333-8444-555555555555';
function v4Base(overrides = {}) {
  return {
    ...baseRun({ schema: 4, run_kind: 'calibration', ...overrides }),
    grading_checks: { value: null, reason: 'not applicable for run_kind calibration' },
    repetition_index: null,
    foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
    ambient_skill_profile: { count: 0, scope_id: VALID_SCOPE_ID, fingerprint_hmac: '0'.repeat(64) },
    ...overrides,
  };
}
const V5_METRIC_NOT_APPLICABLE = { value: null, reason: 'calibration run -- no first-useful-signal predicate applies' };
function v5Base(overrides = {}) {
  return {
    ...v4Base(overrides),
    schema: 5,
    post_signal_ms: V5_METRIC_NOT_APPLICABLE,
    post_signal_tool_calls: V5_METRIC_NOT_APPLICABLE,
    policy_denials_before_first_signal: V5_METRIC_NOT_APPLICABLE,
    policy_denials_after_first_signal: V5_METRIC_NOT_APPLICABLE,
    accepted_audit: null,
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

// Decision 6: a real bug found on review -- naively bumping a single CURRENT_RUN_SCHEMA constant
// to 2 would have made validateRun() reject every historical schema:1 record at its very first
// check. This is the fix: explicit per-version dispatch, proven both synthetically (this describe
// block) and against the actual 8 committed files (the next describe block).
describe('schema v1/v2/v3/v4/v5 dispatch (decision 6, extended for v3 -- foreign_skill_summary, v4 -- ambient_skill_profile, v5 -- accepted-run-observability)', () => {
  it('SUPPORTED_RUN_SCHEMAS accepts 1 through 5 (schema v6 is a separate, additive describe block below)', () => {
    expect(SUPPORTED_RUN_SCHEMAS).toEqual(expect.arrayContaining([1, 2, 3, 4, 5]));
  });

  // Characterization freeze (runtime-contract PR): the v5 record's top-level field set, written
  // out literally rather than imported. RUN_CANONICAL_FIELDS_V5 is deliberately NOT exported and
  // is deliberately NOT imported here -- asserting a list against the very constant that produces
  // it proves nothing. The binding comes from validateRun instead, and it is bidirectional:
  // validateRun raises an error for every canonical field the record is MISSING, and a warning
  // for every record key it does NOT recognize. Zero of both therefore proves
  //     (production canonical set) == (this record's keys) == (the literal list below).
  // Removing a field from production surfaces as an unrecognized-field warning; adding one
  // surfaces as a missing-field error. Either way this test goes red, which is exactly what a
  // later schema v6 extraction needs it to do.
  it('freezes the exact v5 top-level field inventory, the tokens sub-keys, and the absence of the prospective v6 groups', () => {
    const run = v5Base();

    // Bidirectional binding to production's own canonical list (see comment above).
    expect(validateRun(run)).toEqual({ errors: [], warnings: [] });

    expect(Object.keys(run.tokens).sort()).toEqual(['cache_creation', 'cache_read', 'input', 'output']);

    expect(Object.keys(run).sort()).toEqual([
      'accepted_audit', 'ambient_skill_profile', 'benchmark_eligible',
      'cache_state', 'claude_code_version', 'condition', 'daemon_policy',
      'ended_at', 'env_allowlist_profile', 'errors', 'exit_code',
      'expected_outcome_matched', 'family', 'first_useful_signal_event',
      'first_useful_signal_ms', 'foreign_skill_summary', 'grading_checks',
      'hook_call_count', 'hook_deny_count', 'human_interventions',
      'kmp_test_cli_source_sha', 'kmp_test_cli_version', 'model_requested',
      'model_resolved', 'notes', 'order_index', 'output_bytes',
      'permission_mode_used', 'platform', 'policy_allowed_gradle_tasks',
      'policy_allowed_kmptest_subcommands',
      'policy_denials_after_first_signal',
      'policy_denials_before_first_signal', 'policy_sha256', 'post_signal_ms',
      'post_signal_tool_calls', 'privacy_status', 'project_alias',
      'project_commit', 'project_url', 'query_id', 'raw_capture_committed',
      'raw_capture_location', 'repetition_index', 'repo_commit',
      'resolved_kmp_test_executable_path', 'retries', 'run_id', 'run_kind',
      'scenario_id', 'schema', 'seed', 'session_id_observed',
      'shell_commands_total', 'skill_available',
      'skill_invocation_attempted', 'skill_invocation_event', 'skill_invoked',
      'skill_source_sha', 'started_at', 'stream_json_bytes', 'success',
      'terminated', 'termination_reason', 'test_invocations_total', 'tokens',
      'tool_calls_total', 'wall_clock_ms',
    ]);

    // The four top-level groups the prospective schema v6 would introduce (see
    // docs/audits/agentic-eval-claude-codex-v1-plan.md). v6 is NOT implemented, and this PR must
    // not introduce any of them by accident. Because the inventory above is bound to production's
    // canonical set bidirectionally, their absence here IS their absence from schema v5.
    for (const v6Group of ['agent_runtime', 'execution_profile', 'skill_observation', 'usage']) {
      expect(v6Group in run).toBe(false);
    }
  });

  it('a schema:1 record WITHOUT grading_checks/repetition_index still validates cleanly -- those fields are never required for v1', () => {
    const run = baseRun({ schema: 1 });
    expect('grading_checks' in run).toBe(false);
    expect('repetition_index' in run).toBe(false);
    const { errors } = validateRun(run);
    expect(errors).toEqual([]);
  });

  it('a schema:1 record is rejected if it DOES carry grading_checks -- v1\'s canonical field list has no such field, so its presence is unrecognized/malformed for that version', () => {
    const run = { ...baseRun({ schema: 1 }), grading_checks: { value: null, reason: 'x' } };
    const { warnings } = validateRun(run);
    expect(warnings.some((w) => w.field === 'grading_checks')).toBe(true);
  });

  it('a schema:2 calibration record requires grading_checks/repetition_index present but null (not applicable)', () => {
    const run = {
      ...baseRun({ schema: 2, run_kind: 'calibration' }),
      grading_checks: { value: null, reason: 'not applicable for run_kind calibration' },
      repetition_index: null,
    };
    const { errors } = validateRun(run);
    expect(errors).toEqual([]);
  });

  it('a schema:2 scenario record REQUIRES a non-null grading_checks.value -- grading must have actually run', () => {
    const run = {
      ...baseRun({ schema: 2, run_kind: 'scenario', benchmark_eligible: true }),
      grading_checks: { value: null, reason: 'not applicable' },
      repetition_index: 0,
    };
    const { errors } = validateRun(run);
    expect(errors.some((e) => e.field === 'grading_checks')).toBe(true);
  });

  it('a schema:2 scenario record REQUIRES a non-negative integer repetition_index', () => {
    const run = {
      ...baseRun({ schema: 2, run_kind: 'scenario', benchmark_eligible: true }),
      grading_checks: { value: GRADING_CHECK_NAMES.map((name) => ({ name, passed: true, detail: 'ok', evidence_event_indices: [] })), reason: null },
      repetition_index: null,
    };
    const { errors } = validateRun(run);
    expect(errors.some((e) => e.field === 'repetition_index')).toBe(true);
  });

  it('a non-scenario schema:2 record REJECTS a non-null repetition_index -- no repetition concept applies', () => {
    const run = {
      ...baseRun({ schema: 2, run_kind: 'calibration' }),
      grading_checks: { value: null, reason: 'not applicable for run_kind calibration' },
      repetition_index: 0,
    };
    const { errors } = validateRun(run);
    expect(errors.some((e) => e.field === 'repetition_index')).toBe(true);
  });

  it('a fully well-formed schema:2 scenario record validates cleanly', () => {
    const run = {
      ...baseRun({ schema: 2, run_kind: 'scenario', benchmark_eligible: true, scenario_id: 'kampkit-android-host-test-discovery' }),
      grading_checks: { value: GRADING_CHECK_NAMES.map((name) => ({ name, passed: true, detail: 'ok', evidence_event_indices: [1, 2] })), reason: null },
      repetition_index: 0,
    };
    const { errors } = validateRun(run);
    expect(errors).toEqual([]);
  });

  // foreign_skill_summary (v3-introduced field) -- mirrors the v1-without-grading_checks/
  // v1-rejected-with-grading_checks pair immediately above, one schema level up.
  it('a schema:2 record WITHOUT foreign_skill_summary still validates cleanly -- the field is never required below v3', () => {
    const run = {
      ...baseRun({ schema: 2, run_kind: 'calibration' }),
      grading_checks: { value: null, reason: 'not applicable for run_kind calibration' },
      repetition_index: null,
    };
    expect('foreign_skill_summary' in run).toBe(false);
    const { errors } = validateRun(run);
    expect(errors).toEqual([]);
  });

  it('a schema:2 record is rejected if it DOES carry foreign_skill_summary -- introduced in v3, forbidden below it', () => {
    const run = {
      ...baseRun({ schema: 2, run_kind: 'calibration' }),
      grading_checks: { value: null, reason: 'not applicable for run_kind calibration' },
      repetition_index: null,
      foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
    };
    const { errors, warnings } = validateRun(run);
    // Two independent signals fire for the same malformed field: the generic canonical-fields
    // mechanism (unrecognized-for-v2 -- a warning, same as the v1/grading_checks precedent above)
    // AND foreign_skill_summary's OWN schema-gate gets to its `else if` branch and pushes a
    // dedicated ERROR, since a v2 record carrying it is self-contradictory relative to its own
    // declared schema version, not merely an unknown extra field.
    expect(warnings.some((w) => w.field === 'foreign_skill_summary')).toBe(true);
    expect(errors.some((e) => e.field === 'foreign_skill_summary')).toBe(true);
  });

  // Inheritance proof (round-4 audit finding: this is the actual bug class the `>= 2` fix guards
  // against -- must be proven directly against a real schema:3 record, not assumed from the
  // schema:2 tests above still passing). Mirrors the schema:2-scenario-REQUIRES tests exactly, one
  // schema level up.
  it('a schema:3 scenario record REQUIRES a non-null grading_checks.value -- v2 semantics inherited, not just v2 fields', () => {
    const run = {
      ...baseRun({ schema: 3, run_kind: 'scenario', benchmark_eligible: true }),
      grading_checks: { value: null, reason: 'not applicable' },
      repetition_index: 0,
      foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
    };
    const { errors } = validateRun(run);
    expect(errors.some((e) => e.field === 'grading_checks')).toBe(true);
  });

  it('a schema:3 scenario record REQUIRES a non-negative integer repetition_index -- v2 semantics inherited, not just v2 fields', () => {
    const run = {
      ...baseRun({ schema: 3, run_kind: 'scenario', benchmark_eligible: true }),
      grading_checks: { value: GRADING_CHECK_NAMES.map((name) => ({ name, passed: true, detail: 'ok', evidence_event_indices: [] })), reason: null },
      repetition_index: null,
      foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
    };
    const { errors } = validateRun(run);
    expect(errors.some((e) => e.field === 'repetition_index')).toBe(true);
  });

  it('a schema:3 record REQUIRES foreign_skill_summary as a non-null object -- unlike grading_checks/repetition_index, applies to EVERY run_kind, not just scenario', () => {
    const run = { ...baseRun({ schema: 3, run_kind: 'calibration' }), grading_checks: { value: null, reason: 'not applicable for run_kind calibration' }, repetition_index: null };
    expect('foreign_skill_summary' in run).toBe(false);
    const { errors } = validateRun(run);
    expect(errors.some((e) => e.field === 'foreign_skill_summary')).toBe(true);
  });

  it('a schema:3 record REJECTS a foreign_skill_summary with the wrong key set', () => {
    const run = {
      ...baseRun({ schema: 3, run_kind: 'calibration' }),
      grading_checks: { value: null, reason: 'not applicable for run_kind calibration' },
      repetition_index: null,
      foreign_skill_summary: { rejected: 0, confirmed: 0 }, // missing incomplete
    };
    const { errors } = validateRun(run);
    expect(errors.some((e) => e.field === 'foreign_skill_summary')).toBe(true);
  });

  it('a schema:3 record REJECTS a foreign_skill_summary with a negative or non-integer count', () => {
    const run = {
      ...baseRun({ schema: 3, run_kind: 'calibration' }),
      grading_checks: { value: null, reason: 'not applicable for run_kind calibration' },
      repetition_index: null,
      foreign_skill_summary: { rejected: -1, confirmed: 0, incomplete: 0 },
    };
    const { errors } = validateRun(run);
    expect(errors.some((e) => e.field === 'foreign_skill_summary.rejected')).toBe(true);
  });

  it('a fully well-formed schema:3 calibration record (all-zero foreign_skill_summary -- the common case) validates cleanly', () => {
    const run = {
      ...baseRun({ schema: 3, run_kind: 'calibration' }),
      grading_checks: { value: null, reason: 'not applicable for run_kind calibration' },
      repetition_index: null,
      foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
    };
    const { errors } = validateRun(run);
    expect(errors).toEqual([]);
  });

  it('a fully well-formed schema:3 scenario record (a real REJECTED foreign attempt counted) validates cleanly', () => {
    const run = {
      ...baseRun({ schema: 3, run_kind: 'scenario', benchmark_eligible: true, scenario_id: 'kampkit-android-host-test-discovery' }),
      grading_checks: { value: GRADING_CHECK_NAMES.map((name) => ({ name, passed: true, detail: 'ok', evidence_event_indices: [1, 2] })), reason: null },
      repetition_index: 0,
      foreign_skill_summary: { rejected: 1, confirmed: 0, incomplete: 0 },
    };
    const { errors } = validateRun(run);
    expect(errors).toEqual([]);
  });

  // ambient_skill_profile (v4-introduced field) -- mirrors the v2-without-foreign_skill_summary/
  // v2-rejected-with-foreign_skill_summary pair above, one schema level up. Like
  // foreign_skill_summary (and unlike grading_checks/repetition_index), applies to EVERY run_kind,
  // never scenario-only -- always computable from any condition's init event.
  //
  // Review-round-2 fix: the field is now {count, scope_id, fingerprint_hmac} (3 keys, not 2) --
  // scope_id is an opaque per-invocation UUID (never reused across separate harness invocations,
  // making clear that fingerprint_hmac is comparable only within one invocation);
  // fingerprint_hmac replaces the old unkeyed fingerprint_sha256 name to be honest about the new
  // keyed-HMAC construction (see stream-parser.mjs's fingerprintAmbientSkillNames).
  // VALID_SCOPE_ID is now module-scope (see its own comment above baseRun's callers) -- shared with
  // the sibling schema-v6 describe block.

  it('a schema:3 record WITHOUT ambient_skill_profile still validates cleanly -- the field is never required below v4', () => {
    const run = {
      ...baseRun({ schema: 3, run_kind: 'calibration' }),
      grading_checks: { value: null, reason: 'not applicable for run_kind calibration' },
      repetition_index: null,
      foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
    };
    expect('ambient_skill_profile' in run).toBe(false);
    const { errors } = validateRun(run);
    expect(errors).toEqual([]);
  });

  it('a schema:3 record is rejected if it DOES carry ambient_skill_profile -- introduced in v4, forbidden below it', () => {
    const run = {
      ...baseRun({ schema: 3, run_kind: 'calibration' }),
      grading_checks: { value: null, reason: 'not applicable for run_kind calibration' },
      repetition_index: null,
      foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
      ambient_skill_profile: { count: 0, scope_id: VALID_SCOPE_ID, fingerprint_hmac: 'a'.repeat(64) },
    };
    const { errors, warnings } = validateRun(run);
    expect(warnings.some((w) => w.field === 'ambient_skill_profile')).toBe(true);
    expect(errors.some((e) => e.field === 'ambient_skill_profile')).toBe(true);
  });

  it('a schema:4 record REQUIRES ambient_skill_profile as a non-null object -- applies to EVERY run_kind, not just scenario', () => {
    const run = {
      ...baseRun({ schema: 4, run_kind: 'calibration' }),
      grading_checks: { value: null, reason: 'not applicable for run_kind calibration' },
      repetition_index: null,
      foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
    };
    expect('ambient_skill_profile' in run).toBe(false);
    const { errors } = validateRun(run);
    expect(errors.some((e) => e.field === 'ambient_skill_profile')).toBe(true);
  });

  it('a schema:4 record REJECTS an ambient_skill_profile with the wrong key set', () => {
    const run = {
      ...baseRun({ schema: 4, run_kind: 'calibration' }),
      grading_checks: { value: null, reason: 'not applicable for run_kind calibration' },
      repetition_index: null,
      foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
      ambient_skill_profile: { count: 0, fingerprint_hmac: 'a'.repeat(64) }, // missing scope_id
    };
    const { errors } = validateRun(run);
    expect(errors.some((e) => e.field === 'ambient_skill_profile')).toBe(true);
  });

  it('a schema:4 record REJECTS a negative or non-integer count', () => {
    const run = {
      ...baseRun({ schema: 4, run_kind: 'calibration' }),
      grading_checks: { value: null, reason: 'not applicable for run_kind calibration' },
      repetition_index: null,
      foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
      ambient_skill_profile: { count: -1, scope_id: VALID_SCOPE_ID, fingerprint_hmac: 'a'.repeat(64) },
    };
    const { errors } = validateRun(run);
    expect(errors.some((e) => e.field === 'ambient_skill_profile.count')).toBe(true);
  });

  it('a schema:4 record REJECTS a fingerprint_hmac that is not a lowercase 64-hex-char string', () => {
    const run = {
      ...baseRun({ schema: 4, run_kind: 'calibration' }),
      grading_checks: { value: null, reason: 'not applicable for run_kind calibration' },
      repetition_index: null,
      foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
      ambient_skill_profile: { count: 0, scope_id: VALID_SCOPE_ID, fingerprint_hmac: 'NOT-HEX' },
    };
    const { errors } = validateRun(run);
    expect(errors.some((e) => e.field === 'ambient_skill_profile.fingerprint_hmac')).toBe(true);
  });

  it('a schema:4 record REJECTS a scope_id that is not a well-formed UUID string', () => {
    const run = {
      ...baseRun({ schema: 4, run_kind: 'calibration' }),
      grading_checks: { value: null, reason: 'not applicable for run_kind calibration' },
      repetition_index: null,
      foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
      ambient_skill_profile: { count: 0, scope_id: 'not-a-uuid', fingerprint_hmac: 'a'.repeat(64) },
    };
    const { errors } = validateRun(run);
    expect(errors.some((e) => e.field === 'ambient_skill_profile.scope_id')).toBe(true);
  });

  it('a fully well-formed schema:4 calibration record (no ambient skills -- the common case) validates cleanly', () => {
    const run = {
      ...baseRun({ schema: 4, run_kind: 'calibration' }),
      grading_checks: { value: null, reason: 'not applicable for run_kind calibration' },
      repetition_index: null,
      foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
      ambient_skill_profile: { count: 0, scope_id: VALID_SCOPE_ID, fingerprint_hmac: 'e'.repeat(64) },
    };
    const { errors } = validateRun(run);
    expect(errors).toEqual([]);
  });

  it('a fully well-formed schema:4 scenario record (a real shared-ambient-skill count) validates cleanly', () => {
    const run = {
      ...baseRun({ schema: 4, run_kind: 'scenario', benchmark_eligible: true, scenario_id: 'kampkit-android-host-test-discovery' }),
      grading_checks: { value: GRADING_CHECK_NAMES.map((name) => ({ name, passed: true, detail: 'ok', evidence_event_indices: [1, 2] })), reason: null },
      repetition_index: 0,
      foreign_skill_summary: { rejected: 0, confirmed: 1, incomplete: 0 },
      ambient_skill_profile: { count: 1, scope_id: VALID_SCOPE_ID, fingerprint_hmac: 'f'.repeat(64) },
    };
    const { errors } = validateRun(run);
    expect(errors).toEqual([]);
  });

  // Schema v5 (accepted-run-observability PR) = v4 + post_signal_ms, post_signal_tool_calls,
  // policy_denials_before_first_signal, policy_denials_after_first_signal (all {value,reason}
  // nullable metrics), and accepted_audit (a plain nullable structured field, mirroring
  // ambient_skill_profile's own v4-introduced gate one version up). v4Base/v5Base/
  // V5_METRIC_NOT_APPLICABLE are now module-scope -- see the comment above baseRun's callers.

  it('a schema:4 record WITHOUT any of the 5 new v5 fields still validates cleanly -- none are required below v5', () => {
    const run = v4Base();
    for (const f of ['post_signal_ms', 'post_signal_tool_calls', 'policy_denials_before_first_signal', 'policy_denials_after_first_signal', 'accepted_audit']) {
      expect(f in run).toBe(false);
    }
    const { errors } = validateRun(run);
    expect(errors).toEqual([]);
  });

  it('a schema:4 record is rejected if it DOES carry any of the 5 new v5 fields -- forbidden below v5', () => {
    for (const [field, value] of [
      ['post_signal_ms', { value: null, reason: 'x' }],
      ['post_signal_tool_calls', { value: null, reason: 'x' }],
      ['policy_denials_before_first_signal', { value: null, reason: 'x' }],
      ['policy_denials_after_first_signal', { value: null, reason: 'x' }],
      ['accepted_audit', null],
    ]) {
      const run = { ...v4Base(), [field]: value };
      const { errors, warnings } = validateRun(run);
      expect(warnings.some((w) => w.field === field)).toBe(true);
      if (value !== null) expect(errors.some((e) => e.field === field)).toBe(true);
    }
  });

  it('a fully well-formed schema:5 non-scenario record (all 5 new fields null/not-applicable) validates cleanly', () => {
    const { errors } = validateRun(v5Base());
    expect(errors).toEqual([]);
  });

  it('a fully well-formed schema:5 scenario record (all 4 metrics real values, accepted_audit populated) validates cleanly', () => {
    const run = v5Base({
      run_kind: 'scenario', benchmark_eligible: true, scenario_id: 'kampkit-android-host-test-discovery',
      grading_checks: { value: GRADING_CHECK_NAMES.map((name) => ({ name, passed: true, detail: 'ok', evidence_event_indices: [1, 2] })), reason: null },
      repetition_index: 0,
      post_signal_ms: { value: 42.5, reason: null },
      post_signal_tool_calls: { value: 2, reason: null },
      policy_denials_before_first_signal: { value: 0, reason: null },
      policy_denials_after_first_signal: { value: 1, reason: null },
      accepted_audit: { schema: 1, relative_path: 'audit/scenario-current-skill-abcd1234.json', sha256: 'a'.repeat(64) },
      run_id: 'scenario-current-skill-abcd1234',
    });
    const { errors } = validateRun(run);
    expect(errors).toEqual([]);
  });

  describe('post_signal_ms / post_signal_tool_calls / policy_denials_{before,after}_first_signal -- nullable metric domains', () => {
    it('post_signal_ms accepts a non-negative finite timing value', () => {
      const run = v5Base({ post_signal_ms: { value: 0, reason: null } });
      expect(validateRun(run).errors).toEqual([]);
      const run2 = v5Base({ post_signal_ms: { value: 1234.5, reason: null } });
      expect(validateRun(run2).errors).toEqual([]);
    });

    it('post_signal_ms rejects a negative value', () => {
      const run = v5Base({ post_signal_ms: { value: -1, reason: null } });
      expect(validateRun(run).errors.some((e) => e.field === 'post_signal_ms')).toBe(true);
    });

    it('post_signal_ms rejects a non-numeric value', () => {
      const run = v5Base({ post_signal_ms: { value: 'soon', reason: null } });
      expect(validateRun(run).errors.some((e) => e.field === 'post_signal_ms')).toBe(true);
    });

    for (const field of ['post_signal_tool_calls', 'policy_denials_before_first_signal', 'policy_denials_after_first_signal']) {
      it(`${field} accepts a non-negative integer count`, () => {
        expect(validateRun(v5Base({ [field]: { value: 0, reason: null } })).errors).toEqual([]);
        expect(validateRun(v5Base({ [field]: { value: 5, reason: null } })).errors).toEqual([]);
      });

      it(`${field} rejects a negative integer`, () => {
        expect(validateRun(v5Base({ [field]: { value: -1, reason: null } })).errors.some((e) => e.field === field)).toBe(true);
      });

      it(`${field} rejects a non-integer (fractional) value`, () => {
        expect(validateRun(v5Base({ [field]: { value: 1.5, reason: null } })).errors.some((e) => e.field === field)).toBe(true);
      });
    }

    it('rejects value:null paired with reason:null on any of the 4 new metrics (never infer, always explain)', () => {
      for (const field of ['post_signal_ms', 'post_signal_tool_calls', 'policy_denials_before_first_signal', 'policy_denials_after_first_signal']) {
        const run = v5Base({ [field]: { value: null, reason: null } });
        expect(validateRun(run).errors.some((e) => e.field === field)).toBe(true);
      }
    });
  });

  describe('accepted_audit -- scenario/non-scenario relationship, exact path/SHA/closed-key validation', () => {
    it('is REQUIRED to be null for a non-scenario schema:5 record', () => {
      const run = v5Base({ run_kind: 'smoke' });
      expect(validateRun(run).errors).toEqual([]);
    });

    it('REJECTS a non-null accepted_audit on a non-scenario record', () => {
      const run = v5Base({ run_kind: 'smoke', accepted_audit: { schema: 1, relative_path: 'audit/x.json', sha256: 'a'.repeat(64) } });
      expect(validateRun(run).errors.some((e) => e.field === 'accepted_audit')).toBe(true);
    });

    function scenarioBase(overrides = {}) {
      return v5Base({
        run_kind: 'scenario', benchmark_eligible: true, scenario_id: 'kampkit-android-host-test-discovery',
        grading_checks: { value: GRADING_CHECK_NAMES.map((name) => ({ name, passed: true, detail: 'ok', evidence_event_indices: [] })), reason: null },
        repetition_index: 0, run_id: 'scenario-current-skill-abcd1234',
        ...overrides,
      });
    }

    it('is REQUIRED (non-null) for a schema:5 scenario record', () => {
      const run = scenarioBase({ accepted_audit: null });
      expect(validateRun(run).errors.some((e) => e.field === 'accepted_audit')).toBe(true);
    });

    it('REQUIRES exactly the keys schema/relative_path/sha256 -- no more, no fewer', () => {
      const missingKey = scenarioBase({ accepted_audit: { relative_path: 'audit/scenario-current-skill-abcd1234.json', sha256: 'a'.repeat(64) } });
      expect(validateRun(missingKey).errors.some((e) => e.field === 'accepted_audit')).toBe(true);
      const extraKey = scenarioBase({ accepted_audit: { schema: 1, relative_path: 'audit/scenario-current-skill-abcd1234.json', sha256: 'a'.repeat(64), extra: 'nope' } });
      expect(validateRun(extraKey).errors.some((e) => e.field === 'accepted_audit')).toBe(true);
    });

    // Sidecar schemas 1 and 2 now coexist: the 92 historical records point at v1, newly built ones
    // at v2. Both must validate; anything outside that closed set must not.
    it.each([1, 2])('ACCEPTS a supported sidecar schema (%i)', (schema) => {
      const run = scenarioBase({ accepted_audit: { schema, relative_path: 'audit/scenario-current-skill-abcd1234.json', sha256: 'a'.repeat(64) } });
      expect(validateRun(run).errors.some((e) => e.field === 'accepted_audit.schema')).toBe(false);
    });

    it.each([0, 3, -1, '1', 1.5, null])('REJECTS an unsupported sidecar schema (%j)', (schema) => {
      const run = scenarioBase({ accepted_audit: { schema, relative_path: 'audit/scenario-current-skill-abcd1234.json', sha256: 'a'.repeat(64) } });
      expect(validateRun(run).errors.some((e) => e.field === 'accepted_audit.schema')).toBe(true);
    });

    it('REQUIRES relative_path to equal exactly audit/<this record\'s run_id>.json', () => {
      const wrongId = scenarioBase({ accepted_audit: { schema: 1, relative_path: 'audit/some-other-run-id.json', sha256: 'a'.repeat(64) } });
      expect(validateRun(wrongId).errors.some((e) => e.field === 'accepted_audit.relative_path')).toBe(true);
    });

    it('REJECTS an absolute path', () => {
      const run = scenarioBase({ accepted_audit: { schema: 1, relative_path: '/audit/scenario-current-skill-abcd1234.json', sha256: 'a'.repeat(64) } });
      expect(validateRun(run).errors.some((e) => e.field === 'accepted_audit.relative_path')).toBe(true);
    });

    it('REJECTS a Windows-drive-absolute path', () => {
      const run = scenarioBase({ accepted_audit: { schema: 1, relative_path: 'C:\\audit\\scenario-current-skill-abcd1234.json', sha256: 'a'.repeat(64) } });
      expect(validateRun(run).errors.some((e) => e.field === 'accepted_audit.relative_path')).toBe(true);
    });

    it('REJECTS a backslash path separator', () => {
      const run = scenarioBase({ run_id: 'scenario-current-skill-abcd1234', accepted_audit: { schema: 1, relative_path: 'audit\\scenario-current-skill-abcd1234.json', sha256: 'a'.repeat(64) } });
      expect(validateRun(run).errors.some((e) => e.field === 'accepted_audit.relative_path')).toBe(true);
    });

    it('REJECTS a traversal path even when it would otherwise "equal" a maliciously-crafted run_id', () => {
      const run = scenarioBase({ run_id: '../../../etc/passwd', accepted_audit: { schema: 1, relative_path: 'audit/../../../etc/passwd.json', sha256: 'a'.repeat(64) } });
      expect(validateRun(run).errors.some((e) => e.field === 'accepted_audit.relative_path')).toBe(true);
    });

    it('REJECTS an alternate filename (not literally "<run_id>.json")', () => {
      const run = scenarioBase({ accepted_audit: { schema: 1, relative_path: 'audit/some-other-name.json', sha256: 'a'.repeat(64) } });
      expect(validateRun(run).errors.some((e) => e.field === 'accepted_audit.relative_path')).toBe(true);
    });

    it('REQUIRES sha256 to be a lowercase 64-char hex string', () => {
      const tooShort = scenarioBase({ accepted_audit: { schema: 1, relative_path: 'audit/scenario-current-skill-abcd1234.json', sha256: 'a'.repeat(10) } });
      expect(validateRun(tooShort).errors.some((e) => e.field === 'accepted_audit.sha256')).toBe(true);
      const uppercase = scenarioBase({ accepted_audit: { schema: 1, relative_path: 'audit/scenario-current-skill-abcd1234.json', sha256: 'A'.repeat(64) } });
      expect(validateRun(uppercase).errors.some((e) => e.field === 'accepted_audit.sha256')).toBe(true);
    });
  });

  // Inheritance proof (mirrors the round-4 audit-finding pattern already applied at v3): a
  // schema:5 record must still enforce every v2/v3/v4 semantic rule, not just the v5 field list.
  it('a schema:5 scenario record still REQUIRES a non-null grading_checks.value -- v2 semantics inherited', () => {
    const run = v5Base({ run_kind: 'scenario', benchmark_eligible: true, grading_checks: { value: null, reason: 'x' }, repetition_index: 0 });
    expect(validateRun(run).errors.some((e) => e.field === 'grading_checks')).toBe(true);
  });

  it('a schema:5 record still REQUIRES ambient_skill_profile as a non-null object -- v4 semantics inherited', () => {
    const { ambient_skill_profile, ...run } = v5Base();
    expect(validateRun(run).errors.some((e) => e.field === 'ambient_skill_profile')).toBe(true);
  });

  describe('grading_checks canonical 8-name-set (decision 14)', () => {
    function fullGradingChecks(overrides = {}) {
      const checks = GRADING_CHECK_NAMES.map((name) => ({ name, passed: true, detail: 'ok', evidence_event_indices: [] }));
      return { value: checks, reason: null, ...overrides };
    }
    function scenarioRunWith(gradingChecksValue) {
      return {
        ...baseRun({ schema: 2, run_kind: 'scenario', benchmark_eligible: true }),
        grading_checks: { value: gradingChecksValue, reason: null },
        repetition_index: 0,
      };
    }

    it('accepts exactly the 8 canonical names, each once', () => {
      const { errors } = validateRun(scenarioRunWith(fullGradingChecks().value));
      expect(errors.filter((e) => e.field.startsWith('grading_checks'))).toEqual([]);
    });

    it('rejects a missing check name', () => {
      const checks = fullGradingChecks().value.filter((c) => c.name !== 'no_provider_contradiction');
      const { errors } = validateRun(scenarioRunWith(checks));
      expect(errors.some((e) => e.field === 'grading_checks' && e.message.includes('no_provider_contradiction'))).toBe(true);
    });

    it('rejects an unrecognized extra check name', () => {
      const checks = [...fullGradingChecks().value, { name: 'made_up_check', passed: true, detail: 'x', evidence_event_indices: [] }];
      const { errors } = validateRun(scenarioRunWith(checks));
      expect(errors.some((e) => e.field.endsWith('.name'))).toBe(true);
    });

    it('rejects a duplicate check name', () => {
      const checks = fullGradingChecks().value;
      checks[1] = { ...checks[0] }; // duplicate the first name into the second slot
      const { errors } = validateRun(scenarioRunWith(checks));
      expect(errors.some((e) => e.message.includes('duplicate check name'))).toBe(true);
    });

    it('rejects a non-boolean passed field', () => {
      const checks = fullGradingChecks().value;
      checks[0] = { ...checks[0], passed: 'yes' };
      const { errors } = validateRun(scenarioRunWith(checks));
      expect(errors.some((e) => e.field.endsWith('.passed'))).toBe(true);
    });

    it('rejects a non-array evidence_event_indices', () => {
      const checks = fullGradingChecks().value;
      checks[0] = { ...checks[0], evidence_event_indices: 3 };
      const { errors } = validateRun(scenarioRunWith(checks));
      expect(errors.some((e) => e.field.endsWith('.evidence_event_indices'))).toBe(true);
    });

    it('rejects a negative evidence_event_indices entry', () => {
      const checks = fullGradingChecks().value;
      checks[0] = { ...checks[0], evidence_event_indices: [-1] };
      const { errors } = validateRun(scenarioRunWith(checks));
      expect(errors.some((e) => e.field.endsWith('.evidence_event_indices'))).toBe(true);
    });
  });
});

// Schema v6 (agentic-eval-runtime-neutral-records-v1): additive over v5 -- every legacy field
// stays exactly as v5 defined it (proven by reusing v5Base/v4Base/baseRun verbatim below, never a
// second, independently-typed-out legacy field list), plus exactly four new top-level groups:
// agent_runtime, execution_profile, skill_observation, usage. No selection is ever inferred from
// legacy fields -- these four groups are the sole canonical source for runtime/profile/skill/
// usage identity going forward.
describe('schema v6/v7 (agentic-eval-runtime-neutral-records-v1 + product-access mode) -- agent_runtime/execution_profile/skill_observation/usage/product_access_mode', () => {
  it('SUPPORTED_RUN_SCHEMAS accepts 1 through 7; LATEST_RUN_SCHEMA is 7', () => {
    expect(SUPPORTED_RUN_SCHEMAS).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(LATEST_RUN_SCHEMA).toBe(7);
  });

  const VALID_SCOPE_ID_V6 = '22222222-3333-4444-8555-666666666666';
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);
  const HASH_C = 'c'.repeat(64);
  const HASH_D = 'd'.repeat(64);

  const NO_SKILL_SKILL_OBSERVATION = Object.freeze({
    delivery_mode: 'none',
    availability: { status: 'observed-absent', evidence_kind: 'runtime-catalog' },
    activation: { status: 'not-observed', evidence_kind: 'runtime-explicit-event' },
    source_sha: null,
    treatment_size: {
      snapshot_sha256: null, snapshot_bytes: null, snapshot_file_count: null,
      prompt_sha256: HASH_D, prompt_bytes: 55,
      absent_reason: 'condition-no-skill',
    },
  });
  function currentSkillObservation(overrides = {}) {
    return {
      delivery_mode: 'runtime-extension',
      availability: { status: 'observed-present', evidence_kind: 'runtime-catalog' },
      activation: { status: 'confirmed', evidence_kind: 'runtime-explicit-event' },
      source_sha: '0bb958d464ccd4b2f463aa10a4101d726e2154c4',
      treatment_size: {
        snapshot_sha256: HASH_C, snapshot_bytes: 234997, snapshot_file_count: 28,
        prompt_sha256: HASH_D, prompt_bytes: 55,
        absent_reason: null,
      },
      ...overrides,
    };
  }
  const NO_SKILL_USAGE = Object.freeze({
    source: 'runtime-reported',
    input: 2, cached_input: 0, cache_write: 0, output: 4, reasoning_output: null,
    attributable_to_skill_load: {
      status: 'not-recorded',
      dimensions: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null },
      unit: null,
      reason: 'condition-no-skill',
    },
  });
  function currentSkillUsage(overrides = {}) {
    return {
      source: 'runtime-reported',
      input: 2, cached_input: 0, cache_write: 0, output: 4, reasoning_output: null,
      attributable_to_skill_load: {
        status: 'not-recorded',
        dimensions: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null },
        unit: null,
        reason: 'runtime-does-not-report-skill-attribution',
      },
      ...overrides,
    };
  }

  function v6Base(overrides = {}) {
    return {
      ...v5Base(overrides),
      schema: 6,
      agent_runtime: {
        runtime_id: 'claude-code',
        cli_version: '1.2.3-fake',
        model_requested: 'claude-sonnet-5',
        model_resolved: 'claude-sonnet-5',
        model_vendor_expected: 'anthropic',
        model_vendor_observed: null,
      },
      execution_profile: {
        id: 'strict-policy-v1',
        sha256: STRICT_POLICY_V1_SHA256,
        isolation_kind: 'runtime-policy-hooks',
        isolation_attestation_sha256: null,
        isolation_attestation_required: false,
        network_mode: 'runtime-default',
        policy_mode: 'required',
        required_capabilities: ['softPermissionDenial'],
      },
      skill_observation: NO_SKILL_SKILL_OBSERVATION,
      usage: NO_SKILL_USAGE,
      ...overrides,
    };
  }
  function v7Base(overrides = {}) {
    return {
      ...v6Base(overrides),
      schema: 7,
      product_access_mode: 'product-visible-no-skill',
      ...overrides,
    };
  }
  function v6CurrentSkillBase(overrides = {}) {
    return v6Base({
      condition: 'current-skill',
      skill_source_sha: '0bb958d464ccd4b2f463aa10a4101d726e2154c4',
      skill_available: { value: true, reason: null },
      skill_invocation_attempted: { value: true, reason: null },
      skill_invoked: { value: true, reason: null },
      skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 3 },
      skill_observation: currentSkillObservation(),
      usage: currentSkillUsage(),
      ...overrides,
    });
  }

  // PR 4 (agentic-eval-isolated-unrestricted-profile-v1): the ONE well-formed policy_mode:
  // "not_applicable" shape -- sandboxed-unrestricted-v1's real projection/hash, a real-looking
  // attestation hash, bypassPermissions, and every one of the 5 policy-metric top-level fields
  // (hook_call_count/hook_deny_count/policy_allowed_gradle_tasks/policy_allowed_kmptest_subcommands/
  // policy_sha256) set to null -- no policy hook ever governs this profile's Bash dispatch.
  function v6UnrestrictedBase(overrides = {}) {
    return v6Base({
      execution_profile: {
        id: 'sandboxed-unrestricted-v1', sha256: UNRESTRICTED_POLICY_V1_SHA256,
        isolation_kind: 'external-sandbox', isolation_attestation_sha256: FAKE_ATTESTATION_SHA256,
        isolation_attestation_required: true, network_mode: 'restricted', policy_mode: 'not_applicable',
        required_capabilities: ['structuredTranscript', 'correlatedToolResults', 'skillStateEvidence'],
      },
      permission_mode_used: 'bypassPermissions',
      policy_allowed_gradle_tasks: null,
      policy_allowed_kmptest_subcommands: null,
      policy_sha256: null,
      hook_call_count: null,
      hook_deny_count: null,
      ...overrides,
    });
  }

  it('a fully well-formed schema:6 no-skill calibration record validates cleanly', () => {
    expect(validateRun(v6Base())).toEqual({ errors: [], warnings: [] });
  });

  it('a fully well-formed schema:7 no-skill record requires and validates product_access_mode', () => {
    expect(validateRun(v7Base())).toEqual({ errors: [], warnings: [] });
  });

  it('schema:7 rejects a missing product_access_mode', () => {
    const { product_access_mode: _omit, ...run } = v7Base();
    expect(validateRun(run).errors.some((e) => e.field === 'product_access_mode')).toBe(true);
  });

  it('schema:7 rejects an unrecognized product_access_mode', () => {
    const run = v7Base({ product_access_mode: 'whatever-the-agent-did' });
    expect(validateRun(run).errors.some((e) => e.field === 'product_access_mode')).toBe(true);
  });

  it('schema:7 rejects product_access_mode values incompatible with condition', () => {
    const noSkill = v7Base({ condition: 'no-skill', product_access_mode: 'product-assisted' });
    const currentSkill = v7Base({
      ...v6CurrentSkillBase(),
      schema: 7,
      product_access_mode: 'free-baseline-no-product',
    });
    expect(validateRun(noSkill).errors.some((e) => e.field === 'product_access_mode')).toBe(true);
    expect(validateRun(currentSkill).errors.some((e) => e.field === 'product_access_mode')).toBe(true);
  });

  it('schema<7 rejects product_access_mode as not-yet-canonical, never silently accepting a future treatment axis', () => {
    const { errors, warnings } = validateRun(v6Base({ product_access_mode: 'free-baseline-no-product' }));
    expect(errors.some((e) => e.field === 'product_access_mode')).toBe(true);
    expect(warnings.some((w) => w.field === 'product_access_mode')).toBe(true);
  });

  describe('schema:6 policy_mode:"not_applicable" (sandboxed-unrestricted-v1) -- 5 policy-metric fields must be exactly null, never a real/fabricated value (PR 4)', () => {
    it('a fully well-formed not_applicable record validates cleanly', () => {
      expect(validateRun(v6UnrestrictedBase())).toEqual({ errors: [], warnings: [] });
    });

    const REAL_VALUE_BY_FIELD = {
      hook_call_count: 0, hook_deny_count: 0, policy_allowed_gradle_tasks: [],
      policy_allowed_kmptest_subcommands: [], policy_sha256: 'a'.repeat(64),
    };
    for (const field of Object.keys(REAL_VALUE_BY_FIELD)) {
      it(`rejects a REAL (non-null) ${field} under policy_mode:"not_applicable" -- fabricating policy evidence that was never produced`, () => {
        const run = v6UnrestrictedBase({ [field]: REAL_VALUE_BY_FIELD[field] });
        expect(validateRun(run).errors.some((e) => e.field === field)).toBe(true);
      });
    }

    for (const field of Object.keys(REAL_VALUE_BY_FIELD)) {
      it(`rejects a null ${field} under policy_mode:"required" (strict) -- these 5 fields stay mandatory real values for schema6 strict, unchanged from before this PR`, () => {
        const run = v6Base({ [field]: null });
        expect(validateRun(run).errors.some((e) => e.field === field)).toBe(true);
      });
    }

    it('an empty array is NOT the same as null -- policy_allowed_gradle_tasks:[] under not_applicable is still rejected', () => {
      const run = v6UnrestrictedBase({ policy_allowed_gradle_tasks: [] });
      expect(validateRun(run).errors.some((e) => e.field === 'policy_allowed_gradle_tasks')).toBe(true);
    });

    it('schema<6 is completely unaffected by this branch -- schema:1 still requires real top-level policy values regardless of execution_profile-shaped content', () => {
      const run = baseRun({ hook_call_count: null });
      expect(validateRun(run).errors.some((e) => e.field === 'hook_call_count')).toBe(true);
    });
  });

  it('a fully well-formed schema:6 current-skill record validates cleanly', () => {
    expect(validateRun(v6CurrentSkillBase())).toEqual({ errors: [], warnings: [] });
  });

  it('v1-v5 REJECT all four v6 groups as unrecognized (schema<=5 never carries them)', () => {
    for (const schema of [1, 2, 3, 4, 5]) {
      const run = { ...v5Base({ schema }), agent_runtime: v6Base().agent_runtime };
      const { warnings } = validateRun(run);
      expect(warnings.some((w) => w.field === 'agent_runtime')).toBe(true);
    }
  });

  it('schema:6 REQUIRES all four groups -- each is a missing-field error when absent', () => {
    for (const group of ['agent_runtime', 'execution_profile', 'skill_observation', 'usage']) {
      const { [group]: _omit, ...run } = v6Base();
      const { errors } = validateRun(run);
      expect(errors.some((e) => e.field === group)).toBe(true);
    }
  });

  it('the exact schema:6 top-level field inventory is v5\'s set plus exactly the 4 new groups, nothing else', () => {
    const run = v6Base();
    const keys = new Set(Object.keys(run));
    for (const g of ['agent_runtime', 'execution_profile', 'skill_observation', 'usage']) expect(keys.has(g)).toBe(true);
    keys.delete('agent_runtime'); keys.delete('execution_profile'); keys.delete('skill_observation'); keys.delete('usage');
    const v5Keys = new Set(Object.keys(v5Base()));
    expect([...keys].sort()).toEqual([...v5Keys].sort());
  });

  it('the exact schema:7 top-level field inventory is schema:6 plus product_access_mode, nothing else', () => {
    const run = v7Base();
    const keys = new Set(Object.keys(run));
    expect(keys.has('product_access_mode')).toBe(true);
    keys.delete('product_access_mode');
    const v6Keys = new Set(Object.keys(v6Base()));
    expect([...keys].sort()).toEqual([...v6Keys].sort());
  });

  describe('agent_runtime -- exact keys, closed IDs, enums, and hash formats', () => {
    it('rejects a missing key', () => {
      for (const key of ['runtime_id', 'cli_version', 'model_requested', 'model_resolved', 'model_vendor_expected', 'model_vendor_observed']) {
        const agent_runtime = { ...v6Base().agent_runtime };
        delete agent_runtime[key];
        const { errors } = validateRun(v6Base({ agent_runtime }));
        expect(errors.some((e) => e.field.startsWith('agent_runtime'))).toBe(true);
      }
    });

    it('rejects an unrecognized extra key', () => {
      const run = v6Base({ agent_runtime: { ...v6Base().agent_runtime, extra_field: 'nope' } });
      expect(validateRun(run).errors.some((e) => e.field.startsWith('agent_runtime'))).toBe(true);
    });

    it('accepts the two v1-permitted runtime ids: claude-code and codex-cli (schema shape only -- the registry independently gates which is actually selectable)', () => {
      const run = v6Base({ agent_runtime: { ...v6Base().agent_runtime, runtime_id: 'codex-cli' }, execution_profile: { ...v6Base().execution_profile, isolation_attestation_sha256: null } });
      // codex-cli is a valid SHAPE per schema; claude_code_version must be null for a non-Claude runtime (invariant 3).
      const withNullClaudeVersion = { ...run, claude_code_version: null };
      const { errors } = validateRun(withNullClaudeVersion);
      expect(errors.filter((e) => e.field === 'agent_runtime.runtime_id')).toEqual([]);
    });

    it('rejects an unknown runtime_id', () => {
      const run = v6Base({ agent_runtime: { ...v6Base().agent_runtime, runtime_id: 'made-up-runtime' } });
      expect(validateRun(run).errors.some((e) => e.field === 'agent_runtime.runtime_id')).toBe(true);
    });

    it('rejects an uppercase runtime_id -- closed lowercase charset', () => {
      const run = v6Base({ agent_runtime: { ...v6Base().agent_runtime, runtime_id: 'Claude-Code' } });
      expect(validateRun(run).errors.some((e) => e.field === 'agent_runtime.runtime_id')).toBe(true);
    });

    it('rejects an empty cli_version', () => {
      const run = v6Base({ agent_runtime: { ...v6Base().agent_runtime, cli_version: '' } });
      expect(validateRun(run).errors.some((e) => e.field === 'agent_runtime.cli_version')).toBe(true);
    });

    it('rejects an empty model_requested', () => {
      const run = v6Base({ agent_runtime: { ...v6Base().agent_runtime, model_requested: '' } });
      expect(validateRun(run).errors.some((e) => e.field === 'agent_runtime.model_requested')).toBe(true);
    });

    it('accepts a null model_resolved but rejects an empty-string one', () => {
      // Legacy model_resolved must stay in lockstep (invariant 3) -- overridden on BOTH sides so
      // this test isolates model_resolved's own null/empty-string domain, not the cross-field check.
      const okRun = v6Base({ model_resolved: null, agent_runtime: { ...v6Base().agent_runtime, model_resolved: null } });
      expect(validateRun(okRun).errors.filter((e) => e.field === 'agent_runtime.model_resolved')).toEqual([]);
      const badRun = v6Base({ agent_runtime: { ...v6Base().agent_runtime, model_resolved: '' } });
      expect(validateRun(badRun).errors.some((e) => e.field === 'agent_runtime.model_resolved')).toBe(true);
    });

    it('accepts every closed model_vendor_expected value and rejects an unknown one', () => {
      for (const vendor of ['anthropic', 'openai', 'google', 'microsoft', 'other']) {
        const run = v6Base({ agent_runtime: { ...v6Base().agent_runtime, model_vendor_expected: vendor } });
        expect(validateRun(run).errors.filter((e) => e.field === 'agent_runtime.model_vendor_expected')).toEqual([]);
      }
      const bad = v6Base({ agent_runtime: { ...v6Base().agent_runtime, model_vendor_expected: 'made-up' } });
      expect(validateRun(bad).errors.some((e) => e.field === 'agent_runtime.model_vendor_expected')).toBe(true);
    });

    it('model_vendor_expected accepts null (a runtime that does not declare an expected vendor)', () => {
      const run = v6Base({ agent_runtime: { ...v6Base().agent_runtime, model_vendor_expected: null } });
      expect(validateRun(run).errors.filter((e) => e.field === 'agent_runtime.model_vendor_expected')).toEqual([]);
    });

    it('model_vendor_observed accepts null and a bounded non-empty runtime-reported string, never auto-normalized to model_vendor_expected', () => {
      const nullRun = v6Base();
      expect(validateRun(nullRun).errors.filter((e) => e.field === 'agent_runtime.model_vendor_observed')).toEqual([]);
      const observedRun = v6Base({ agent_runtime: { ...v6Base().agent_runtime, model_vendor_observed: 'Anthropic (observed)' } });
      expect(validateRun(observedRun).errors.filter((e) => e.field === 'agent_runtime.model_vendor_observed')).toEqual([]);
    });

    it('rejects an empty-string model_vendor_observed (must be null, never an empty string)', () => {
      const run = v6Base({ agent_runtime: { ...v6Base().agent_runtime, model_vendor_observed: '' } });
      expect(validateRun(run).errors.some((e) => e.field === 'agent_runtime.model_vendor_observed')).toBe(true);
    });

    it('rejects a model_vendor_observed containing a control character', () => {
      const run = v6Base({ agent_runtime: { ...v6Base().agent_runtime, model_vendor_observed: 'anthropic\n' } });
      expect(validateRun(run).errors.some((e) => e.field === 'agent_runtime.model_vendor_observed')).toBe(true);
    });

    // Invariant 3: for runtime_id claude-code, legacy model_requested/model_resolved/
    // claude_code_version must coincide EXACTLY with agent_runtime's own fields.
    it('REQUIRES legacy model_requested to exactly equal agent_runtime.model_requested for claude-code', () => {
      const run = v6Base({ model_requested: 'a-different-model' });
      expect(validateRun(run).errors.some((e) => e.field === 'agent_runtime.model_requested')).toBe(true);
    });

    it('REQUIRES legacy model_resolved to exactly equal agent_runtime.model_resolved for claude-code', () => {
      const run = v6Base({ model_resolved: 'a-different-resolved-model' });
      expect(validateRun(run).errors.some((e) => e.field === 'agent_runtime.model_resolved')).toBe(true);
    });

    it('REQUIRES legacy claude_code_version to exactly equal agent_runtime.cli_version for claude-code', () => {
      const run = v6Base({ claude_code_version: '9.9.9-different' });
      expect(validateRun(run).errors.some((e) => e.field === 'agent_runtime.cli_version')).toBe(true);
    });

    // Invariant 3 (non-Claude branch): claude_code_version must be null for any OTHER runtime_id
    // until a future PR retires the last legacy consumer -- never filled with a non-Claude version.
    it('REQUIRES legacy claude_code_version to be null for a non-claude-code runtime_id', () => {
      const run = v6Base({
        claude_code_version: '1.2.3-fake',
        agent_runtime: { ...v6Base().agent_runtime, runtime_id: 'codex-cli' },
      });
      expect(validateRun(run).errors.some((e) => e.field === 'claude_code_version')).toBe(true);
    });
  });

  describe('execution_profile -- exact keys, closed enums, hash format, strict-policy attestation invariant', () => {
    it('rejects a missing key', () => {
      for (const key of ['id', 'sha256', 'isolation_kind', 'isolation_attestation_sha256', 'isolation_attestation_required', 'network_mode', 'policy_mode', 'required_capabilities']) {
        const execution_profile = { ...v6Base().execution_profile };
        delete execution_profile[key];
        const { errors } = validateRun(v6Base({ execution_profile }));
        expect(errors.some((e) => e.field.startsWith('execution_profile'))).toBe(true);
      }
    });

    it('rejects an unrecognized extra key', () => {
      const run = v6Base({ execution_profile: { ...v6Base().execution_profile, extra: 1 } });
      expect(validateRun(run).errors.some((e) => e.field.startsWith('execution_profile'))).toBe(true);
    });

    it('accepts the two v1-permitted profile ids: strict-policy-v1 and sandboxed-unrestricted-v1 (schema shape only -- the registry does not enable the latter yet)', () => {
      const run = v6Base({ execution_profile: { ...v6Base().execution_profile, id: 'sandboxed-unrestricted-v1' } });
      expect(validateRun(run).errors.filter((e) => e.field === 'execution_profile.id')).toEqual([]);
    });

    it('rejects an unknown profile id', () => {
      const run = v6Base({ execution_profile: { ...v6Base().execution_profile, id: 'made-up-profile' } });
      expect(validateRun(run).errors.some((e) => e.field === 'execution_profile.id')).toBe(true);
    });

    it('rejects a malformed sha256 (wrong length / uppercase)', () => {
      const shortRun = v6Base({ execution_profile: { ...v6Base().execution_profile, sha256: 'a'.repeat(10) } });
      expect(validateRun(shortRun).errors.some((e) => e.field === 'execution_profile.sha256')).toBe(true);
      const upperRun = v6Base({ execution_profile: { ...v6Base().execution_profile, sha256: 'A'.repeat(64) } });
      expect(validateRun(upperRun).errors.some((e) => e.field === 'execution_profile.sha256')).toBe(true);
    });

    it('accepts every closed isolation_kind value and rejects an unknown one', () => {
      for (const kind of ['runtime-policy-hooks', 'external-sandbox', 'runtime-native-sandbox']) {
        const run = v6Base({ execution_profile: { ...v6Base().execution_profile, isolation_kind: kind } });
        expect(validateRun(run).errors.filter((e) => e.field === 'execution_profile.isolation_kind')).toEqual([]);
      }
      const bad = v6Base({ execution_profile: { ...v6Base().execution_profile, isolation_kind: 'made-up' } });
      expect(validateRun(bad).errors.some((e) => e.field === 'execution_profile.isolation_kind')).toBe(true);
    });

    it('accepts every closed network_mode value and rejects an unknown one', () => {
      for (const mode of ['runtime-default', 'restricted', 'disabled']) {
        const run = v6Base({ execution_profile: { ...v6Base().execution_profile, network_mode: mode } });
        expect(validateRun(run).errors.filter((e) => e.field === 'execution_profile.network_mode')).toEqual([]);
      }
      const bad = v6Base({ execution_profile: { ...v6Base().execution_profile, network_mode: 'made-up' } });
      expect(validateRun(bad).errors.some((e) => e.field === 'execution_profile.network_mode')).toBe(true);
    });

    it('isolation_attestation_sha256 accepts null or a well-formed hash, rejects a malformed one', () => {
      const nullRun = v6Base();
      expect(validateRun(nullRun).errors.filter((e) => e.field === 'execution_profile.isolation_attestation_sha256')).toEqual([]);
      const malformed = v6Base({ execution_profile: { ...v6Base().execution_profile, isolation_attestation_sha256: 'not-a-hash' } });
      expect(validateRun(malformed).errors.some((e) => e.field === 'execution_profile.isolation_attestation_sha256')).toBe(true);
    });

    // Invariant 4: strict-policy-v1's own frozen semantics (registry: isolation_attestation_required
    // false) mean every record citing it must carry a null attestation -- never a real hash.
    it('REQUIRES isolation_attestation_sha256 to be null when id is strict-policy-v1', () => {
      const run = v6Base({ execution_profile: { ...v6Base().execution_profile, isolation_attestation_sha256: HASH_B } });
      expect(validateRun(run).errors.some((e) => e.field === 'execution_profile.isolation_attestation_sha256')).toBe(true);
    });

    // P1 architectural review: the record now carries every field computeExecutionProfileSha256
    // (registries.mjs) hashes, and this validator recomputes+compares it independently -- never
    // consulting the live registry -- so a historical record's own execution_profile group stays
    // self-verifying even if the registry's strict-policy-v1 entry is later edited or removed.
    describe('self-contained hash verification and isolation_attestation_required (P1 architectural review)', () => {
      it('accepts a record whose sha256 is the real canonical hash of its own projection', () => {
        expect(validateRun(v6Base()).errors.filter((e) => e.field === 'execution_profile.sha256')).toEqual([]);
      });

      it('rejects a sha256 that does not match the recomputed canonical hash of isolation_kind/network_mode/isolation_attestation_required/policy_mode/required_capabilities, even though it is a well-formed 64-hex string', () => {
        const run = v6Base({ execution_profile: { ...v6Base().execution_profile, sha256: HASH_B } });
        expect(validateRun(run).errors.some((e) => e.field === 'execution_profile.sha256')).toBe(true);
      });

      it('the hash is sensitive to EVERY field in the projection -- changing isolation_kind, network_mode, isolation_attestation_required, policy_mode, or required_capabilities alone (while keeping the old sha256) is caught as a mismatch', () => {
        const changes = [
          { isolation_kind: 'external-sandbox' },
          { network_mode: 'restricted' },
          { isolation_attestation_required: true, isolation_attestation_sha256: HASH_B },
          { policy_mode: 'not_applicable' },
          { required_capabilities: [] },
        ];
        for (const change of changes) {
          const run = v6Base({ execution_profile: { ...v6Base().execution_profile, ...change } });
          expect(validateRun(run).errors.some((e) => e.field === 'execution_profile.sha256')).toBe(true);
        }
      });

      it('isolation_attestation_required must be a boolean', () => {
        const run = v6Base({ execution_profile: { ...v6Base().execution_profile, isolation_attestation_required: 'false' } });
        expect(validateRun(run).errors.some((e) => e.field === 'execution_profile.isolation_attestation_required')).toBe(true);
      });

      it('isolation_attestation_required:true REQUIRES a real isolation_attestation_sha256 (never null)', () => {
        const projection = {
          id: 'strict-policy-v1', isolation_kind: 'external-sandbox', network_mode: 'restricted',
          isolation_attestation_required: true, policy_mode: 'required', required_capabilities: [],
        };
        const sha256 = canonicalJsonSha256(projection);
        const withNull = v6Base({ execution_profile: { ...projection, sha256, isolation_attestation_sha256: null } });
        expect(validateRun(withNull).errors.some((e) => e.field === 'execution_profile.isolation_attestation_sha256')).toBe(true);
        const withHash = v6Base({ execution_profile: { ...projection, sha256, isolation_attestation_sha256: HASH_B } });
        expect(validateRun(withHash).errors.filter((e) => e.field === 'execution_profile.isolation_attestation_sha256')).toEqual([]);
      });

      it('policy_mode accepts the 2 closed values and rejects an unknown one', () => {
        for (const mode of ['required', 'not_applicable']) {
          const projection = {
            id: 'strict-policy-v1', isolation_kind: 'runtime-policy-hooks', network_mode: 'runtime-default',
            isolation_attestation_required: false, policy_mode: mode, required_capabilities: ['softPermissionDenial'],
          };
          const run = v6Base({ execution_profile: { ...projection, sha256: canonicalJsonSha256(projection), isolation_attestation_sha256: null } });
          expect(validateRun(run).errors.filter((e) => e.field === 'execution_profile.policy_mode')).toEqual([]);
        }
        const bad = v6Base({ execution_profile: { ...v6Base().execution_profile, policy_mode: 'made-up' } });
        expect(validateRun(bad).errors.some((e) => e.field === 'execution_profile.policy_mode')).toBe(true);
      });

      it('required_capabilities rejects an unknown capability name and a duplicate', () => {
        const unknown = v6Base({ execution_profile: { ...v6Base().execution_profile, required_capabilities: ['notARealCapability'] } });
        expect(validateRun(unknown).errors.some((e) => e.field === 'execution_profile.required_capabilities')).toBe(true);
        const duplicate = v6Base({ execution_profile: { ...v6Base().execution_profile, required_capabilities: ['softPermissionDenial', 'softPermissionDenial'] } });
        expect(validateRun(duplicate).errors.some((e) => e.field === 'execution_profile.required_capabilities')).toBe(true);
      });

      // P1 architectural review (Codex round 2): contract.mjs's CAPABILITY_KEYS describes the FULL
      // adapter capabilities shape -- 3 of its 7 members (observationSources, skillDeliveryModes,
      // usageDimensions) are array-valued, not a single true/false an execution profile could ever
      // "require". registries.mjs's own REQUIRABLE_CAPABILITY_KEYS already excludes these 3; schema
      // v6 must reject them here too, from the SAME shared vocabulary (contract.mjs's
      // REQUIRED_CAPABILITY_KEYS), not the wider CAPABILITY_KEYS list.
      it.each(['observationSources', 'skillDeliveryModes', 'usageDimensions'])(
        'required_capabilities rejects "%s" -- a real CAPABILITY_KEYS member, but not boolean-valued/requirable',
        (nonBooleanCapability) => {
          const run = v6Base({ execution_profile: { ...v6Base().execution_profile, required_capabilities: [nonBooleanCapability] } });
          expect(validateRun(run).errors.some((e) => e.field === 'execution_profile.required_capabilities')).toBe(true);
        },
      );
    });
  });

  describe('skill_observation -- exact keys, closed enums, no-skill/current-skill treatment_size shapes', () => {
    it('rejects a missing top-level key', () => {
      for (const key of ['delivery_mode', 'availability', 'activation', 'source_sha', 'treatment_size']) {
        const skill_observation = { ...v6Base().skill_observation };
        delete skill_observation[key];
        const { errors } = validateRun(v6Base({ skill_observation }));
        expect(errors.some((e) => e.field.startsWith('skill_observation'))).toBe(true);
      }
    });

    it('rejects an unrecognized extra key at the top level', () => {
      const run = v6Base({ skill_observation: { ...v6Base().skill_observation, extra: 1 } });
      expect(validateRun(run).errors.some((e) => e.field.startsWith('skill_observation'))).toBe(true);
    });

    it('accepts every closed delivery_mode value at the enum-domain level', () => {
      // claude-code's OWN invariant (delivery_mode must be exactly none/runtime-extension for its
      // two real conditions) is proven separately by the no-skill/current-skill describe blocks
      // below. This test isolates the SCHEMA-level enum domain itself -- project-instructions/
      // inline-context are reserved shapes for a future non-Claude runtime, so they are exercised
      // against a non-claude-code runtime_id, where claude's own delivery_mode invariant does not
      // apply (invariant 3's non-Claude branch only constrains claude_code_version).
      expect(validateRun(v6Base()).errors.filter((e) => e.field === 'skill_observation.delivery_mode')).toEqual([]); // 'none'
      expect(validateRun(v6CurrentSkillBase()).errors.filter((e) => e.field === 'skill_observation.delivery_mode')).toEqual([]); // 'runtime-extension'
      for (const mode of ['project-instructions', 'inline-context']) {
        // no-skill's delivery_mode:'none' requirement is universal (not Claude-scoped -- absence of
        // delivery is a runtime-independent fact), so these two reserved modes are exercised on a
        // CURRENT-skill condition instead, where the runtime-extension requirement IS Claude-scoped.
        const run = v6CurrentSkillBase({
          claude_code_version: null,
          agent_runtime: { ...v6Base().agent_runtime, runtime_id: 'codex-cli' },
          skill_observation: currentSkillObservation({ delivery_mode: mode }),
        });
        expect(validateRun(run).errors.filter((e) => e.field === 'skill_observation.delivery_mode')).toEqual([]);
      }
    });

    it('rejects an unknown delivery_mode', () => {
      const run = v6Base({ skill_observation: { ...v6Base().skill_observation, delivery_mode: 'made-up' } });
      expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.delivery_mode')).toBe(true);
    });

    it('availability.status accepts the 3 closed values and rejects an unknown one', () => {
      // Paired with the matching skill_available.value for each status (the new biconditional
      // invariant requires the two to agree) -- this test's own point is "each status value is
      // individually accepted", not "any status is accepted regardless of skill_available".
      const legacyValueFor = { 'observed-present': true, 'observed-absent': false, 'not-observable': null };
      for (const status of ['observed-present', 'observed-absent', 'not-observable']) {
        const availability = { status, evidence_kind: status === 'not-observable' ? 'not-observable' : 'runtime-catalog' };
        const run = v6Base({
          skill_observation: { ...v6Base().skill_observation, availability },
          skill_available: { value: legacyValueFor[status], reason: legacyValueFor[status] === null ? 'not observable' : null },
        });
        expect(validateRun(run).errors.filter((e) => e.field === 'skill_observation.availability.status')).toEqual([]);
      }
      const bad = v6Base({ skill_observation: { ...v6Base().skill_observation, availability: { status: 'made-up', evidence_kind: 'runtime-catalog' } } });
      expect(validateRun(bad).errors.some((e) => e.field === 'skill_observation.availability.status')).toBe(true);
    });

    it('activation.status accepts the 4 closed values and rejects an unknown one', () => {
      for (const status of ['confirmed', 'indirect', 'not-observed', 'not-observable']) {
        const activation = {
          status,
          evidence_kind: status === 'not-observable' ? 'not-observable' : status === 'indirect' ? 'behavioral-indirect' : 'runtime-explicit-event',
        };
        const run = v6Base({ skill_observation: { ...v6Base().skill_observation, activation } });
        expect(validateRun(run).errors.filter((e) => e.field === 'skill_observation.activation.status')).toEqual([]);
      }
      const bad = v6Base({ skill_observation: { ...v6Base().skill_observation, activation: { status: 'made-up', evidence_kind: 'runtime-explicit-event' } } });
      expect(validateRun(bad).errors.some((e) => e.field === 'skill_observation.activation.status')).toBe(true);
    });

    // Invariant 7: not-observable REQUIRES evidence_kind not-observable; an OBSERVED status may
    // never use the not-observable evidence_kind (it would contradict having actually observed it).
    it('REQUIRES evidence_kind:not-observable when availability.status is not-observable', () => {
      const run = v6Base({ skill_observation: { ...v6Base().skill_observation, availability: { status: 'not-observable', evidence_kind: 'runtime-catalog' } } });
      expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.availability.evidence_kind')).toBe(true);
    });

    it('REJECTS evidence_kind:not-observable when availability.status is an OBSERVED status', () => {
      const run = v6Base({ skill_observation: { ...v6Base().skill_observation, availability: { status: 'observed-absent', evidence_kind: 'not-observable' } } });
      expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.availability.evidence_kind')).toBe(true);
    });

    it('REQUIRES evidence_kind:not-observable when activation.status is not-observable', () => {
      const run = v6Base({ skill_observation: { ...v6Base().skill_observation, activation: { status: 'not-observable', evidence_kind: 'runtime-explicit-event' } } });
      expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.activation.evidence_kind')).toBe(true);
    });

    it('REJECTS evidence_kind:not-observable when activation.status is confirmed/not-observed', () => {
      const run = v6Base({ skill_observation: { ...v6Base().skill_observation, activation: { status: 'not-observed', evidence_kind: 'not-observable' } } });
      expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.activation.evidence_kind')).toBe(true);
    });

    // Claude specifically: availability always runtime-catalog, activation always runtime-explicit-event.
    it('REQUIRES availability.evidence_kind runtime-catalog for claude-code', () => {
      const run = v6Base({ skill_observation: { ...v6Base().skill_observation, availability: { status: 'observed-absent', evidence_kind: 'isolated-filesystem' } } });
      expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.availability.evidence_kind')).toBe(true);
    });

    it('REQUIRES activation.evidence_kind runtime-explicit-event for claude-code (never behavioral-indirect)', () => {
      const run = v6Base({ skill_observation: { ...v6Base().skill_observation, activation: { status: 'not-observed', evidence_kind: 'behavioral-indirect' } } });
      expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.activation.evidence_kind')).toBe(true);
    });

    // Invariant 5: no-skill's exact closed shape.
    describe('no-skill treatment_size (invariant 5)', () => {
      it('a fully well-formed no-skill skill_observation validates cleanly', () => {
        expect(validateRun(v6Base())).toEqual({ errors: [], warnings: [] });
      });
      it('rejects delivery_mode !== none for a no-skill condition\'s skill_observation with source_sha non-null', () => {
        const run = v6Base({ skill_observation: { ...NO_SKILL_SKILL_OBSERVATION, source_sha: '0bb958d464ccd4b2f463aa10a4101d726e2154c4' } });
        expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.source_sha')).toBe(true);
      });
      it('rejects a non-null snapshot_sha256 when absent_reason is condition-no-skill', () => {
        const run = v6Base({ skill_observation: { ...v6Base().skill_observation, treatment_size: { ...NO_SKILL_SKILL_OBSERVATION.treatment_size, snapshot_sha256: HASH_A } } });
        expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.treatment_size.snapshot_sha256')).toBe(true);
      });
      it('rejects snapshot_bytes:0 (zero) in place of null for the no-skill case -- never coerce absence to zero', () => {
        const run = v6Base({ skill_observation: { ...v6Base().skill_observation, treatment_size: { ...NO_SKILL_SKILL_OBSERVATION.treatment_size, snapshot_bytes: 0 } } });
        expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.treatment_size.snapshot_bytes')).toBe(true);
      });
      it('rejects a null absent_reason when snapshot fields are also null but delivery_mode is none (absent_reason is required exactly then)', () => {
        const run = v6Base({ skill_observation: { ...v6Base().skill_observation, treatment_size: { ...NO_SKILL_SKILL_OBSERVATION.treatment_size, absent_reason: null } } });
        expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.treatment_size.absent_reason')).toBe(true);
      });
    });

    // Invariant 6: current-skill's exact closed shape.
    describe('current-skill treatment_size (invariant 6)', () => {
      it('a fully well-formed current-skill skill_observation validates cleanly', () => {
        expect(validateRun(v6CurrentSkillBase())).toEqual({ errors: [], warnings: [] });
      });
      it('REQUIRES source_sha to equal the pin (non-null) for current-skill', () => {
        const run = v6CurrentSkillBase({ skill_observation: currentSkillObservation({ source_sha: null }) });
        expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.source_sha')).toBe(true);
      });
      it('REQUIRES a real (non-null) snapshot_sha256 for current-skill', () => {
        const run = v6CurrentSkillBase({ skill_observation: currentSkillObservation({ treatment_size: { ...currentSkillObservation().treatment_size, snapshot_sha256: null } }) });
        expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.treatment_size.snapshot_sha256')).toBe(true);
      });
      it('REQUIRES a positive integer snapshot_bytes for current-skill -- never zero, never null', () => {
        for (const bad of [0, null, -1]) {
          const run = v6CurrentSkillBase({ skill_observation: currentSkillObservation({ treatment_size: { ...currentSkillObservation().treatment_size, snapshot_bytes: bad } }) });
          expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.treatment_size.snapshot_bytes')).toBe(true);
        }
      });
      it('REQUIRES a positive integer snapshot_file_count for current-skill', () => {
        const run = v6CurrentSkillBase({ skill_observation: currentSkillObservation({ treatment_size: { ...currentSkillObservation().treatment_size, snapshot_file_count: 0 } }) });
        expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.treatment_size.snapshot_file_count')).toBe(true);
      });
      it('REQUIRES absent_reason to be null for current-skill', () => {
        const run = v6CurrentSkillBase({ skill_observation: currentSkillObservation({ treatment_size: { ...currentSkillObservation().treatment_size, absent_reason: 'condition-no-skill' } }) });
        expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.treatment_size.absent_reason')).toBe(true);
      });
    });

    it('prompt_sha256 is REQUIRED (a real hash) regardless of condition', () => {
      const run = v6Base({ skill_observation: { ...v6Base().skill_observation, treatment_size: { ...v6Base().skill_observation.treatment_size, prompt_sha256: null } } });
      expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.treatment_size.prompt_sha256')).toBe(true);
    });

    it('prompt_bytes is REQUIRED (a non-negative integer) regardless of condition', () => {
      const run = v6Base({ skill_observation: { ...v6Base().skill_observation, treatment_size: { ...v6Base().skill_observation.treatment_size, prompt_bytes: -1 } } });
      expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.treatment_size.prompt_bytes')).toBe(true);
    });

    // Invariant 8: confirmed<->legacy skill_invoked:true; not-observed<->false; indirect/
    // not-observable never forced to false -- legacy value must be null with a reason instead.
    describe('activation.status <-> legacy skill_invoked coherence (invariant 8)', () => {
      it('confirmed REQUIRES legacy skill_invoked.value:true and skill_invocation_attempted.value:true', () => {
        const run = v6CurrentSkillBase({ skill_invoked: { value: false, reason: null } });
        expect(validateRun(run).errors.some((e) => e.field === 'skill_invoked' || e.field === 'skill_observation.activation.status')).toBe(true);
      });
      it('not-observed REQUIRES legacy skill_invoked.value:false', () => {
        const run = v6Base({
          skill_observation: { ...v6Base().skill_observation, activation: { status: 'not-observed', evidence_kind: 'runtime-explicit-event' } },
          skill_invoked: { value: true, reason: null },
          skill_invocation_attempted: { value: true, reason: null },
        });
        expect(validateRun(run).errors.some((e) => e.field === 'skill_invoked' || e.field === 'skill_observation.activation.status')).toBe(true);
      });
      it('indirect/not-observable REQUIRE legacy skill_invoked.value to be null (never forced false)', () => {
        const run = v6Base({
          skill_observation: { ...v6Base().skill_observation, activation: { status: 'indirect', evidence_kind: 'behavioral-indirect' } },
          skill_invoked: { value: false, reason: null },
        });
        expect(validateRun(run).errors.some((e) => e.field === 'skill_invoked')).toBe(true);
      });
    });

    // P1 architectural review: availability.status and the legacy skill_available.value must never
    // independently drift -- each of the 3 possible legacy values has EXACTLY one correct status.
    describe('availability is biconditional with the legacy skill_available.value (P1 architectural review)', () => {
      it.each([
        ['observed-present', false], ['observed-present', null],
        ['observed-absent', true], ['observed-absent', null],
        ['not-observable', true], ['not-observable', false],
      ])('rejects status %s when skill_available.value is %s', (status, mismatchedValue) => {
        const run = v6Base({
          skill_observation: { ...v6Base().skill_observation, availability: { status, evidence_kind: status === 'not-observable' ? 'not-observable' : 'runtime-catalog' } },
          skill_available: { value: mismatchedValue, reason: mismatchedValue === null ? 'not observable' : null },
        });
        expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.availability.status')).toBe(true);
      });
    });

    // P1 architectural review: source_sha and the legacy skill_source_sha must never independently
    // drift, even when BOTH individually satisfy their own condition-based shape rule.
    describe('source_sha exactly equals the legacy skill_source_sha (P1 architectural review)', () => {
      it('rejects source_sha disagreeing with skill_source_sha for condition current-skill (both individually well-shaped, non-empty strings, but different)', () => {
        const run = v6CurrentSkillBase({
          skill_observation: { ...v6CurrentSkillBase().skill_observation, source_sha: 'deadbeef00000000000000000000000000000000' },
        });
        expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.source_sha')).toBe(true);
      });

      it('rejects skill_observation.source_sha non-null when the legacy skill_source_sha is null (no-skill)', () => {
        const run = v6Base({ skill_observation: { ...v6Base().skill_observation, source_sha: 'some-value' } });
        expect(validateRun(run).errors.some((e) => e.field === 'skill_observation.source_sha')).toBe(true);
      });

      it('accepts equal, non-empty source_sha/skill_source_sha for condition current-skill', () => {
        expect(validateRun(v6CurrentSkillBase()).errors.filter((e) => e.field === 'skill_observation.source_sha')).toEqual([]);
      });
    });
  });

  describe('usage -- exact keys, source enum, dimension domains, attributable_to_skill_load', () => {
    it('rejects a missing top-level key', () => {
      for (const key of ['source', 'input', 'cached_input', 'cache_write', 'output', 'reasoning_output', 'attributable_to_skill_load']) {
        const usage = { ...v6Base().usage };
        delete usage[key];
        const { errors } = validateRun(v6Base({ usage }));
        expect(errors.some((e) => e.field.startsWith('usage'))).toBe(true);
      }
    });

    it('rejects an unrecognized extra key', () => {
      const run = v6Base({ usage: { ...v6Base().usage, extra: 1 } });
      expect(validateRun(run).errors.some((e) => e.field.startsWith('usage'))).toBe(true);
    });

    it('rejects an unknown source value', () => {
      const run = v6Base({ usage: { ...v6Base().usage, source: 'made-up-source' } });
      expect(validateRun(run).errors.some((e) => e.field === 'usage.source')).toBe(true);
    });

    // Invariant 9: runtime-reported requires >=1 real dimension; legacy tokens.* are exact
    // projections of the 4 Claude-reported values.
    it('runtime-reported REQUIRES at least one dimension to be a non-negative integer', () => {
      const run = v6Base({ usage: { ...NO_SKILL_USAGE, input: null, cached_input: null, cache_write: null, output: null } });
      expect(validateRun(run).errors.some((e) => e.field === 'usage')).toBe(true);
    });

    it('REQUIRES legacy tokens.input/output/cache_read/cache_creation to be exact projections of usage.input/output/cached_input/cache_write', () => {
      const run = v6Base({ tokens: { input: { value: 999, reason: null }, output: { value: 4, reason: null }, cache_read: { value: 0, reason: null }, cache_creation: { value: 0, reason: null } } });
      expect(validateRun(run).errors.some((e) => e.field === 'tokens.input' || e.field === 'usage.input')).toBe(true);
    });

    // Invariant 10: not-recorded requires ALL dimensions null.
    it('not-recorded REQUIRES every dimension to be null', () => {
      const run = v6Base({ usage: { source: 'not-recorded', input: 2, cached_input: null, cache_write: null, output: null, reasoning_output: null, attributable_to_skill_load: NO_SKILL_USAGE.attributable_to_skill_load } });
      expect(validateRun(run).errors.some((e) => e.field === 'usage.input')).toBe(true);
    });

    it('not-recorded with all dimensions null validates cleanly for the shape (paired with matching null tokens)', () => {
      const run = v6Base({
        usage: { source: 'not-recorded', input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null, attributable_to_skill_load: { status: 'not-recorded', dimensions: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null }, unit: null, reason: 'condition-no-skill' } },
        tokens: { input: { value: null, reason: 'not recorded' }, output: { value: null, reason: 'not recorded' }, cache_read: { value: null, reason: 'not recorded' }, cache_creation: { value: null, reason: 'not recorded' } },
      });
      expect(validateRun(run).errors.filter((e) => e.field.startsWith('usage') || e.field.startsWith('tokens'))).toEqual([]);
    });

    // Invariant 10 (offline-estimate forward shape): only input may be a non-null integer.
    it('offline-estimate permits only the input dimension to be non-null; a non-null cached_input/cache_write/output/reasoning_output is rejected', () => {
      const base = { source: 'offline-estimate', input: 10, cached_input: null, cache_write: null, output: null, reasoning_output: null, attributable_to_skill_load: NO_SKILL_USAGE.attributable_to_skill_load };
      const okRun = v6Base({ usage: base, tokens: { input: { value: 10, reason: null }, output: { value: null, reason: 'offline estimate only' }, cache_read: { value: null, reason: 'offline estimate only' }, cache_creation: { value: null, reason: 'offline estimate only' } } });
      expect(validateRun(okRun).errors.filter((e) => e.field.startsWith('usage'))).toEqual([]);
      const badRun = v6Base({ usage: { ...base, output: 5 } });
      expect(validateRun(badRun).errors.some((e) => e.field === 'usage.output')).toBe(true);
    });

    // Invariant 11: reasoning_output is always null for Claude, never zero.
    it('REQUIRES usage.reasoning_output to be null for claude-code -- rejects zero', () => {
      const run = v6Base({ usage: { ...NO_SKILL_USAGE, reasoning_output: 0 } });
      expect(validateRun(run).errors.some((e) => e.field === 'usage.reasoning_output')).toBe(true);
    });

    // Invariant 12/13: attributable_to_skill_load domains + Claude's fixed reason-per-condition.
    describe('attributable_to_skill_load (invariants 12/13)', () => {
      it('runtime-reported REQUIRES at least one dimension, unit tokens, reason null', () => {
        const run = v6Base({ usage: { ...NO_SKILL_USAGE, attributable_to_skill_load: { status: 'runtime-reported', dimensions: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null }, unit: 'tokens', reason: null } } });
        // (claude-code also independently rejects status:runtime-reported outright -- see the
        // dedicated test below; this test isolates the "at least one dimension" shape requirement.)
        expect(validateRun(run).errors.some((e) => e.field.startsWith('usage.attributable_to_skill_load'))).toBe(true);
      });
      it('claude-code NEVER produces attributable_to_skill_load.status runtime-reported in this PR', () => {
        const run = v6Base({ usage: { ...NO_SKILL_USAGE, attributable_to_skill_load: { status: 'runtime-reported', dimensions: { input: 5, cached_input: null, cache_write: null, output: null, reasoning_output: null }, unit: 'tokens', reason: null } } });
        expect(validateRun(run).errors.some((e) => e.field === 'usage.attributable_to_skill_load.status')).toBe(true);
      });
      it('not-recorded REQUIRES every dimension null, unit null, and a non-empty reason', () => {
        const run = v6Base({ usage: { ...NO_SKILL_USAGE, attributable_to_skill_load: { status: 'not-recorded', dimensions: { input: 1, cached_input: null, cache_write: null, output: null, reasoning_output: null }, unit: null, reason: 'condition-no-skill' } } });
        expect(validateRun(run).errors.some((e) => e.field.startsWith('usage.attributable_to_skill_load'))).toBe(true);
      });
      it('REQUIRES reason condition-no-skill for a no-skill condition record', () => {
        const run = v6Base({ usage: { ...NO_SKILL_USAGE, attributable_to_skill_load: { ...NO_SKILL_USAGE.attributable_to_skill_load, reason: 'runtime-does-not-report-skill-attribution' } } });
        expect(validateRun(run).errors.some((e) => e.field === 'usage.attributable_to_skill_load.reason')).toBe(true);
      });
      it('REQUIRES reason runtime-does-not-report-skill-attribution for a current-skill condition record', () => {
        const run = v6CurrentSkillBase({ usage: currentSkillUsage({ attributable_to_skill_load: { ...currentSkillUsage().attributable_to_skill_load, reason: 'condition-no-skill' } }) });
        expect(validateRun(run).errors.some((e) => e.field === 'usage.attributable_to_skill_load.reason')).toBe(true);
      });
    });
  });

  // accepted_audit compatibility matrix (Section E): a schema:5 record accepts only a v1/v2
  // sidecar (frozen); a schema:6+ record accepts only v3/v4/v5/v6 (the versions that stamp
  // run_provenance_sha256). Symmetric with the v1-v5 describe block's own
  // `it.each([0, 3, -1, '1', 1.5, null])('REJECTS an unsupported sidecar schema (%j)')`, which
  // already covers the v5-rejects-3 direction as one case among several out-of-range values --
  // this block makes both directions of the v5/v6 pairing explicit and independently readable.
  describe('accepted_audit -- v6 requires sidecar schema 3, 4, 5, or 6 (never 1 or 2)', () => {
    function v6ScenarioBase(overrides = {}) {
      return v6Base({
        run_kind: 'scenario', benchmark_eligible: true, scenario_id: 'kampkit-android-host-test-discovery',
        grading_checks: { value: GRADING_CHECK_NAMES.map((name) => ({ name, passed: true, detail: 'ok', evidence_event_indices: [] })), reason: null },
        repetition_index: 0, run_id: 'scenario-current-skill-abcd1234',
        ...overrides,
      });
    }

    it.each([3, 4, 5, 6])('ACCEPTS sidecar schema %i for a schema:6 scenario record', (schema) => {
      const run = v6ScenarioBase({ accepted_audit: { schema, relative_path: 'audit/scenario-current-skill-abcd1234.json', sha256: 'a'.repeat(64) } });
      expect(validateRun(run).errors.some((e) => e.field === 'accepted_audit.schema')).toBe(false);
    });

    it.each([1, 2])('REJECTS sidecar schema %i for a schema:6 scenario record (v6 requires v3/v4/v5/v6)', (schema) => {
      const run = v6ScenarioBase({ accepted_audit: { schema, relative_path: 'audit/scenario-current-skill-abcd1234.json', sha256: 'a'.repeat(64) } });
      expect(validateRun(run).errors.some((e) => e.field === 'accepted_audit.schema')).toBe(true);
    });

    it.each([3, 4, 5, 6])('REJECTS sidecar schema %i for a schema:5 scenario record (v5 requires v1 or v2)', (schema) => {
      const run = v5Base({
        run_kind: 'scenario', benchmark_eligible: true, scenario_id: 'kampkit-android-host-test-discovery',
        grading_checks: { value: GRADING_CHECK_NAMES.map((name) => ({ name, passed: true, detail: 'ok', evidence_event_indices: [] })), reason: null },
        repetition_index: 0, run_id: 'scenario-current-skill-abcd1234',
        accepted_audit: { schema, relative_path: 'audit/scenario-current-skill-abcd1234.json', sha256: 'a'.repeat(64) },
      });
      expect(validateRun(run).errors.some((e) => e.field === 'accepted_audit.schema')).toBe(true);
    });
  });
});

// Explicit backward-validation proof (task requirement): loads and validates all 8 historical
// PR #373/#378 run records BY THEIR EXACT COMMITTED PATH ON DISK, proving the v1 path genuinely
// still passes -- not merely "the validator code looks backward-compatible" by inspection.
describe('backward validation of every PR #373/#378 committed run record', () => {
  const HISTORICAL_RUN_RECORD_PATHS = [
    'tools/runs/agentic-eval-calibration/calibration-current-skill-286d46d9.json',
    'tools/runs/agentic-eval-calibration/calibration-no-skill-83e03ae5.json',
    'tools/runs/agentic-eval-smoke/smoke-current-skill-a3cd7530.json',
    'tools/runs/agentic-eval-smoke/smoke-no-skill-a4990a7b.json',
    'tools/runs/agentic-eval-calibration/calibration-current-skill-a557bea6.json',
    'tools/runs/agentic-eval-calibration/calibration-no-skill-4b88b7da.json',
    'tools/runs/agentic-eval-smoke/smoke-current-skill-00dd1291.json',
    'tools/runs/agentic-eval-smoke/smoke-no-skill-e9c6ef18.json',
  ];

  it('all 8 files exist at their exact committed paths', () => {
    for (const relPath of HISTORICAL_RUN_RECORD_PATHS) {
      expect(readdirSync(path.dirname(path.join(REPO_ROOT, relPath)))).toContain(path.basename(relPath));
    }
  });

  for (const relPath of HISTORICAL_RUN_RECORD_PATHS) {
    it(`${relPath} validates cleanly under the (unchanged) v1 path`, () => {
      const record = JSON.parse(readFileSync(path.join(REPO_ROOT, relPath), 'utf8'));
      expect(record.schema).toBe(1);
      const { errors } = validateRun(record);
      expect(errors).toEqual([]);
    });
  }
});

// Generic scan of EVERY currently committed run-record directory (accepted-run-observability PR)
// -- the historical-8 block above only ever covered calibration/smoke's schema:1 files; this
// walks agentic-eval-{calibration,scenario,smoke}/*.json generically (top-level only, mirroring
// cmdAggregate's own non-recursive readdirSync), so the 16 schema:3/4 scenario records this repo
// already has committed are proven to still validate too -- not merely assumed from the
// hand-picked historical-8 list still passing.
describe('every currently committed agentic-eval run record validates cleanly (generic scan)', () => {
  const RUN_KIND_DIRS = ['agentic-eval-calibration', 'agentic-eval-scenario', 'agentic-eval-smoke'];
  const runsRoot = path.join(REPO_ROOT, 'tools', 'runs');

  const allCommittedRecordPaths = RUN_KIND_DIRS.flatMap((dirName) => {
    const dir = path.join(runsRoot, dirName);
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(dir, f));
  });

  it('finds at least the 24 records already known to be committed as of this PR', () => {
    expect(allCommittedRecordPaths.length).toBeGreaterThanOrEqual(24);
  });

  for (const p of allCommittedRecordPaths) {
    it(`${path.relative(REPO_ROOT, p)} validates cleanly under its own declared schema`, () => {
      const record = JSON.parse(readFileSync(p, 'utf8'));
      expect(SUPPORTED_RUN_SCHEMAS).toContain(record.schema);
      const { errors } = validateRun(record);
      expect(errors).toEqual([]);
    });
  }
});

describe('validateScenario', () => {
  const REAL_SHA = 'b3a7784fb969a8558b88c80674c8b596944cdab7';

  function baseScenario(overrides = {}) {
    return {
      schema: 1,
      id: 'sample-scenario',
      family: 'test-only',
      project_alias: 'sample',
      project_url: 'https://github.com/example/sample',
      project_commit: REAL_SHA,
      prompt: 'Run the tests for this project.',
      expected_outcome: 'Tests run and results are reported.',
      policy: {
        allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel'],
        allowed_gradle_tasks: [':shared:tasks', ':shared:testAndroidHostTest'],
      },
      expected: {
        module: ':shared',
        outcome_kind: 'tests_executed',
        kmp_test: { tests: { total: 1, passed: 1, failed: 0, individual_total: 24, skipped: 0 }, exit_code: 0 },
        gradle: { allowed_invocations: [':shared:testAndroidHostTest'], evidence_task: ':shared:testAndroidHostTest', tests: { total: 24, passed: 24, failed: 0 }, exit_code: 0 },
      },
      first_useful_signal_predicate: { description: 'first mention of test results' },
      tags: ['train'],
      ...overrides,
    };
  }

  function baseScenarioNoTests(overrides = {}) {
    return baseScenario({
      id: 'sample-no-test-scenario',
      expected: {
        module: ':app',
        outcome_kind: 'no_applicable_tests',
        kmp_test: { error_code: 'no_test_modules', exit_code: 2, caused_by_filter: true },
        gradle: { allowed_invocations: [':app:testDebugUnitTest', ':app:test'], evidence_task: ':app:testDebugUnitTest', exit_code: 0, marker: 'NO-SOURCE' },
      },
      policy: {
        allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel'],
        allowed_gradle_tasks: [':app:tasks', ':app:testDebugUnitTest', ':app:test'],
      },
      ...overrides,
    });
  }

  // Ground truth (independently verified 6x -- 3x kmp-test, 3x direct Gradle, cold
  // GRADLE_USER_HOME each -- against android/nowinandroid @
  // 058f0e4375ec51ff8811ba2d0bb10bc4c1b4fdb8, :lint module): kmp_test.tests is TASK-level (one
  // :lint:test Gradle task ran and was classified failed), gradle.tests is the real per-testcase
  // JUnit count (3 individual tests in TestMethodDetectorTest, all failing on stale expected
  // literals) -- the two intentionally differ, per decision "never equate kmp-test task-level
  // counts with Gradle/JUnit testcase counts".
  function baseScenarioTestsFailed(overrides = {}) {
    return baseScenario({
      id: 'sample-tests-failed-scenario',
      expected: {
        module: ':lint',
        outcome_kind: 'tests_failed',
        kmp_test: { tests: { total: 1, passed: 0, failed: 1, individual_total: 3, skipped: 0 }, exit_code: 1 },
        gradle: { allowed_invocations: [':lint:test'], evidence_task: ':lint:test', tests: { total: 3, passed: 0, failed: 3 }, exit_code: 1 },
      },
      policy: {
        allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel'],
        allowed_gradle_tasks: [':lint:tasks', ':lint:test'],
      },
      ...overrides,
    });
  }

  it('accepts a well-formed tests_executed scenario', () => {
    const { errors } = validateScenario(baseScenario());
    expect(errors).toEqual([]);
  });

  it('accepts a well-formed no_applicable_tests scenario', () => {
    const { errors } = validateScenario(baseScenarioNoTests());
    expect(errors).toEqual([]);
  });

  describe('expected -- tests_failed outcome_kind (a genuine, deterministic test failure)', () => {
    it('accepts a well-formed tests_failed scenario', () => {
      const { errors } = validateScenario(baseScenarioTestsFailed());
      expect(errors).toEqual([]);
    });

    it('rejects tests_failed missing tests on kmp_test', () => {
      const s = baseScenarioTestsFailed();
      delete s.expected.kmp_test.tests;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
    });

    it('rejects tests_failed missing exit_code', () => {
      const s = baseScenarioTestsFailed();
      delete s.expected.kmp_test.exit_code;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.exit_code')).toBe(true);
    });

    it('rejects tests_failed with kmp_test.exit_code:0 -- a genuine failure can never cleanly exit', () => {
      const s = baseScenarioTestsFailed();
      s.expected.kmp_test.exit_code = 0;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.exit_code')).toBe(true);
    });

    it('rejects tests_failed with kmp_test.exit_code:2 (CONFIG_ERROR) -- must be exactly 1, never a different real exit code', () => {
      const s = baseScenarioTestsFailed();
      s.expected.kmp_test.exit_code = 2;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.exit_code')).toBe(true);
    });

    it('rejects tests_failed with kmp_test.exit_code:3 (ENV_ERROR) -- must be exactly 1', () => {
      const s = baseScenarioTestsFailed();
      s.expected.kmp_test.exit_code = 3;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.exit_code')).toBe(true);
    });

    it('rejects tests_failed with kmp_test.tests.failed:0 -- zero failures contradicts tests_failed by definition', () => {
      const s = baseScenarioTestsFailed();
      s.expected.kmp_test.tests = { total: 1, passed: 1, failed: 0, individual_total: 3, skipped: 0 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
    });

    // Round-2 review finding: this scenario shape is deliberately scoped to exactly ONE target
    // task whose individual test cases ALL fail (see graders.mjs's own "exactly one target task"
    // doc comment on its tests_failed branch) -- multi-task/mixed-result scope is explicitly OUT
    // for this PR, not merely undocumented. The schema previously allowed
    // kmp_test.tests.failed > 1 (any positive count) even though the grader can only ever validate
    // the single-task shape (exactly one module_failed entry, never more) -- a scenario author
    // could have authored a schema-valid contract the grader could never correctly grade. Tightened
    // to total===1/passed===0/failed===1 EXACTLY, closing that gap at the source rather than
    // broadening the grader to match the old, wider schema.
    it('rejects kmp_test.tests.failed > 1 -- this scenario shape is exactly one target task, all its cases failed, never a multi-task claim', () => {
      const s = baseScenarioTestsFailed();
      s.expected.kmp_test.tests = { total: 2, passed: 0, failed: 2, individual_total: 6, skipped: 0 };
      s.expected.gradle.tests = { total: 6, passed: 0, failed: 6 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
    });

    it('rejects a Gradle mixed result (passed > 0) -- every individual test case must have failed, never a partial/mixed run', () => {
      const s = baseScenarioTestsFailed();
      s.expected.gradle.tests = { total: 3, passed: 1, failed: 2 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.tests')).toBe(true);
    });

    it('rejects tests_failed with a negative failed count', () => {
      const s = baseScenarioTestsFailed();
      s.expected.kmp_test.tests = { total: -1, passed: 0, failed: -1, individual_total: 3, skipped: 0 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
    });

    it('rejects tests_failed with kmp_test total not equal to passed + failed', () => {
      const s = baseScenarioTestsFailed();
      s.expected.kmp_test.tests = { ...s.expected.kmp_test.tests, total: 5 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
    });

    it('rejects tests_failed with kmp_test.tests.individual_total:0 -- must be positive, same as tests_executed', () => {
      const s = baseScenarioTestsFailed();
      s.expected.kmp_test.tests = { ...s.expected.kmp_test.tests, individual_total: 0 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
    });

    it('rejects tests_failed with a non-zero kmp_test.tests.skipped -- the Gradle/JUnit-XML path can never corroborate a non-zero skip claim', () => {
      const s = baseScenarioTestsFailed();
      s.expected.kmp_test.tests = { ...s.expected.kmp_test.tests, skipped: 1 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
    });

    it('rejects tests_failed with a forbidden error_code present (hybrid record)', () => {
      const s = baseScenarioTestsFailed();
      s.expected.kmp_test.error_code = 'no_test_modules';
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.error_code')).toBe(true);
    });

    it('rejects tests_failed with a forbidden caused_by_filter present (hybrid record)', () => {
      const s = baseScenarioTestsFailed();
      s.expected.kmp_test.caused_by_filter = true;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.caused_by_filter')).toBe(true);
    });

    it('rejects tests_failed with a forbidden gradle marker present (hybrid record)', () => {
      const s = baseScenarioTestsFailed();
      s.expected.gradle.marker = 'NO-SOURCE';
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.marker')).toBe(true);
    });

    it('rejects tests_failed with gradle.tests.failed:0 -- zero failures contradicts tests_failed by definition', () => {
      const s = baseScenarioTestsFailed();
      s.expected.gradle.tests = { total: 3, passed: 3, failed: 0 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.tests')).toBe(true);
    });

    it('rejects tests_failed with gradle.exit_code:0 -- a genuine test failure always fails the Gradle build', () => {
      const s = baseScenarioTestsFailed();
      s.expected.gradle.exit_code = 0;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.exit_code')).toBe(true);
    });

    it('rejects tests_failed with gradle individual_total/skipped present -- forbidden on the gradle provider exactly like tests_executed (the capture mechanism cannot verify either)', () => {
      const s = baseScenarioTestsFailed();
      s.expected.gradle.tests = { ...s.expected.gradle.tests, skipped: 0, individual_total: 3 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.tests.skipped')).toBe(true);
      expect(errors.some((e) => e.field === 'expected.gradle.tests.individual_total')).toBe(true);
    });

    it('cross-provider consistency: kmp_test.tests.individual_total must equal gradle.tests.total for tests_failed too', () => {
      const s = baseScenarioTestsFailed();
      s.expected.gradle.tests = { ...s.expected.gradle.tests, total: 4, passed: 1 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests.individual_total')).toBe(true);
    });
  });

  // Ground truth (independently verified 6x -- 3x kmp-test, 3x direct Gradle + independent XML
  // parse, cold GRADLE_USER_HOME each, fixed JDK 17 -- against android/nowinandroid @
  // 7d45eae4f8720a0c77f507712ba2437ff974b6ed, :core:domain module -- a review round rejected an
  // earlier candidate, :core:datastore, whose --module-filter substring-collided with a sibling
  // test-fixtures module; :core:domain has zero substring collision with any other real module in
  // this project, verified against the full module list): tests genuinely pass on both providers
  // (kmp_test's own single-module envelope, 4 individual testcases across demo+prod flavors;
  // gradle corroboration deliberately scoped to the SAME flavor/variant the coverage claim is
  // about, :core:domain:testDemoDebugUnitTest, 2 testcases) -- missed_lines (23) exceeds
  // min_missed_lines (15) on both providers' independently-derived JaCoCo XML.
  function baseScenarioCoverageThresholdExceeded(overrides = {}) {
    return baseScenario({
      id: 'sample-coverage-threshold-exceeded-scenario',
      family: 'coverage',
      expected: {
        module: ':core:domain',
        outcome_kind: 'coverage_threshold_exceeded',
        kmp_test: {
          tests: { total: 1, passed: 1, failed: 0, individual_total: 4, skipped: 0 },
          exit_code: 1,
          coverage: { tool: 'auto', min_missed_lines: 15, missed_lines: 23, with_data: [':core:domain'] },
        },
        gradle: {
          allowed_invocations: [':core:domain:testDemoDebugUnitTest'],
          evidence_task: ':core:domain:testDemoDebugUnitTest',
          tests: { total: 2, passed: 2, failed: 0 },
          exit_code: 0,
        },
      },
      policy: {
        allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel'],
        allowed_gradle_tasks: [':core:domain:testDemoDebugUnitTest'],
      },
      ...overrides,
    });
  }

  describe('expected -- coverage_threshold_exceeded outcome_kind (a genuine, deterministic coverage-gate failure)', () => {
    it('accepts a well-formed coverage_threshold_exceeded scenario', () => {
      const { errors } = validateScenario(baseScenarioCoverageThresholdExceeded());
      expect(errors).toEqual([]);
    });

    it('rejects missing coverage sub-object on kmp_test', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      delete s.expected.kmp_test.coverage;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.coverage')).toBe(true);
    });

    it('rejects coverage.min_missed_lines absent -- threshold must be declared', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      delete s.expected.kmp_test.coverage.min_missed_lines;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.coverage.min_missed_lines')).toBe(true);
    });

    it('rejects coverage.min_missed_lines:0 -- a threshold of 0 permanently disables the real gate', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.kmp_test.coverage.min_missed_lines = 0;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.coverage.min_missed_lines')).toBe(true);
    });

    it('rejects coverage.min_missed_lines negative', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.kmp_test.coverage.min_missed_lines = -5;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.coverage.min_missed_lines')).toBe(true);
    });

    it('rejects coverage.missed_lines <= min_missed_lines -- the gate could never have fired', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.kmp_test.coverage.missed_lines = 15;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.coverage.missed_lines')).toBe(true);
    });

    it('rejects coverage.missed_lines absent', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      delete s.expected.kmp_test.coverage.missed_lines;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.coverage.missed_lines')).toBe(true);
    });

    it('rejects coverage.with_data with zero entries', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.kmp_test.coverage.with_data = [];
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.coverage.with_data')).toBe(true);
    });

    it('rejects coverage.with_data with more than one entry', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.kmp_test.coverage.with_data = [':core:domain', ':core:model'];
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.coverage.with_data')).toBe(true);
    });

    it('rejects coverage.with_data not matching expected.module (cross-check)', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.kmp_test.coverage.with_data = [':core:common'];
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.coverage.with_data')).toBe(true);
    });

    it('rejects coverage.tool "none" -- aggregation disabled entirely, the gate could never fire', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.kmp_test.coverage.tool = 'none';
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.coverage.tool')).toBe(true);
    });

    // Review-round finding: policy-hook.mjs has NO --coverage-tool flag category at all, so a
    // scenario could never legitimately reach a command that resolves to 'jacoco'/'kover'
    // explicitly (only the default 'auto' is reachable under this minimal PR's own policy) --
    // COVERAGE_TOOL_EXPECTED_VALUES narrowed to ['auto'] only; these two values describe a
    // command the current policy grammar could never actually admit.
    it('rejects coverage.tool "jacoco" -- unreachable under this policy (no --coverage-tool flag category exists)', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.kmp_test.coverage.tool = 'jacoco';
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.coverage.tool')).toBe(true);
    });

    it('rejects coverage.tool "kover" -- unreachable under this policy (no --coverage-tool flag category exists)', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.kmp_test.coverage.tool = 'kover';
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.coverage.tool')).toBe(true);
    });

    it('rejects an unrecognized key on the coverage sub-object', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.kmp_test.coverage.modules_contributing = 1;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.coverage.modules_contributing')).toBe(true);
    });

    it('rejects kmp_test.tests.failed non-zero -- this outcome is never a test failure, unlike tests_failed', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.kmp_test.tests = { ...s.expected.kmp_test.tests, total: 2, passed: 1, failed: 1 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
    });

    it('rejects kmp_test.exit_code:0 -- must be exactly 1 (the coverage gate), never a clean exit', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.kmp_test.exit_code = 0;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.exit_code')).toBe(true);
    });

    it('rejects a forbidden error_code present (hybrid record)', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.kmp_test.error_code = 'no_test_modules';
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.error_code')).toBe(true);
    });

    it('rejects a forbidden caused_by_filter present (hybrid record)', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.kmp_test.caused_by_filter = true;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.caused_by_filter')).toBe(true);
    });

    it('rejects a forbidden gradle marker present (hybrid record)', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.gradle.marker = 'NO-SOURCE';
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.marker')).toBe(true);
    });

    it('rejects a coverage sub-object on the gradle contract -- gradle has no coverage-threshold concept', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.gradle.coverage = { tool: 'auto', min_missed_lines: 15, missed_lines: 23, with_data: [':core:domain'] };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.coverage')).toBe(true);
    });

    it('rejects gradle.tests.failed non-zero -- a clean corroborating pass is required', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.gradle.tests = { total: 14, passed: 13, failed: 1 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.tests')).toBe(true);
    });

    it('rejects gradle.exit_code non-zero -- gradle has no threshold concept, a clean run always exits 0', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.gradle.exit_code = 1;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.exit_code')).toBe(true);
    });

    it('rejects gradle individual_total/skipped present -- forbidden exactly like tests_executed/tests_failed', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      s.expected.gradle.tests = { ...s.expected.gradle.tests, skipped: 0, individual_total: 14 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.tests.skipped')).toBe(true);
      expect(errors.some((e) => e.field === 'expected.gradle.tests.individual_total')).toBe(true);
    });

    // Deliberately DIFFERENT from tests_executed/tests_failed: kmp_test.tests.individual_total
    // (the real multi-flavor aggregate, 4 -- ground-truth confirmed to span BOTH demo+prod
    // flavors) is NOT required to equal gradle.tests.total (deliberately scoped to the single
    // demo-flavor task the coverage claim itself is about, 2) for this outcome_kind -- the two
    // providers corroborate genuinely different-scoped claims by design here, unlike
    // tests_executed/tests_failed where they describe the identical real execution.
    it('does NOT apply the individual_total===gradle.tests.total cross-check to this outcome_kind', () => {
      const s = baseScenarioCoverageThresholdExceeded();
      expect(s.expected.kmp_test.tests.individual_total).not.toBe(s.expected.gradle.tests.total);
      const { errors } = validateScenario(s);
      expect(errors).toEqual([]);
    });
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

  describe('project_commit -- no placeholders, ever', () => {
    it('rejects the literal placeholder that caused the original PR #372 draft to be rejected', () => {
      const { errors } = validateScenario(baseScenario({ project_commit: 'PINNED_AT_EXECUTION_TIME' }));
      expect(errors.some((e) => e.field === 'project_commit')).toBe(true);
    });

    it('rejects a short/abbreviated SHA -- must be the full 40 hex characters', () => {
      const { errors } = validateScenario(baseScenario({ project_commit: 'b3a7784' }));
      expect(errors.some((e) => e.field === 'project_commit')).toBe(true);
    });

    it('rejects a non-hex string of the right length', () => {
      const { errors } = validateScenario(baseScenario({ project_commit: 'g'.repeat(40) }));
      expect(errors.some((e) => e.field === 'project_commit')).toBe(true);
    });

    it('accepts a real, full 40-hex-character SHA', () => {
      const { errors } = validateScenario(baseScenario({ project_commit: REAL_SHA }));
      expect(errors.filter((e) => e.field === 'project_commit')).toEqual([]);
    });
  });

  describe('policy -- the only fields ever validated against an executable-content grammar (decision 9)', () => {
    it('rejects a kmp-test subcommand entry not matching the real policy hook grammar', () => {
      const { errors } = validateScenario(baseScenario({ policy: { allowed_kmptest_subcommands: ['Doctor'], allowed_gradle_tasks: [] } }));
      expect(errors.some((e) => e.field === 'policy.allowed_kmptest_subcommands')).toBe(true);
    });

    it('rejects a gradle task entry containing shell metacharacters', () => {
      const { errors } = validateScenario(baseScenario({ policy: { allowed_kmptest_subcommands: ['doctor'], allowed_gradle_tasks: [':app:test; rm -rf /'] } }));
      expect(errors.some((e) => e.field === 'policy.allowed_gradle_tasks')).toBe(true);
    });

    it('rejects a non-array policy field', () => {
      const { errors } = validateScenario(baseScenario({ policy: { allowed_kmptest_subcommands: 'doctor', allowed_gradle_tasks: [] } }));
      expect(errors.some((e) => e.field === 'policy.allowed_kmptest_subcommands')).toBe(true);
    });

    it('accepts an empty allowed_gradle_tasks array -- "no raw gradle commands needed" is valid', () => {
      const { errors } = validateScenario(baseScenario({
        policy: { allowed_kmptest_subcommands: ['doctor', 'parallel'], allowed_gradle_tasks: [] },
        expected: { ...baseScenario().expected, gradle: undefined },
      }));
      // (gradle contract itself still required -- this only proves the policy array can be empty)
      expect(errors.filter((e) => e.field === 'policy.allowed_gradle_tasks')).toEqual([]);
    });
  });

  describe('prose fields are never swept for metacharacters (decision 9) -- only policy is', () => {
    it('a prompt containing punctuation/parens/question-marks that would fail a blanket sweep still validates', () => {
      const { errors } = validateScenario(baseScenario({ prompt: 'Can you check (carefully!) whether tests exist here? Report back w/ counts, please.' }));
      expect(errors.filter((e) => e.field === 'prompt')).toEqual([]);
    });

    it('an expected_outcome containing similar punctuation still validates', () => {
      const { errors } = validateScenario(baseScenario({ expected_outcome: 'Agent finds & runs the right task; reports pass/fail (accurately).' }));
      expect(errors).toEqual([]);
    });
  });

  describe('expected -- outcome_kind-keyed cross-field invariant (no hybrid records)', () => {
    it('rejects tests_executed missing tests on kmp_test', () => {
      const s = baseScenario();
      delete s.expected.kmp_test.tests;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
    });

    it('rejects tests_executed missing exit_code (the real bug found on review -- exit_code must be REQUIRED, not forbidden)', () => {
      const s = baseScenario();
      delete s.expected.kmp_test.exit_code;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.exit_code')).toBe(true);
    });

    // Round 11 (Docker/local-ci audit): tests_executed already unconditionally requires
    // exit_code:0, but nothing previously stopped a scenario from ALSO declaring a positive
    // `failed` count -- a real-world-impossible combination (classifyExitCode's own
    // testsFailed>0 -> TEST_FAIL(1) rule means a real envelope can never have both). Coherent with
    // the exit_code:0 requirement above: tests_executed represents a clean, all-passing run.
    it('EXACT REPRODUCTION: rejects kmp_test.tests.failed > 0 alongside the required exit_code:0 (impossible combination)', () => {
      const s = baseScenario();
      s.expected.kmp_test.tests = { ...s.expected.kmp_test.tests, total: 2, passed: 1, failed: 1 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
    });

    it('EXACT REPRODUCTION: rejects gradle.tests.failed > 0 alongside the required exit_code:0 (impossible combination)', () => {
      const s = baseScenario();
      s.expected.gradle.tests = { ...s.expected.gradle.tests, total: 25, passed: 24, failed: 1 };
      s.expected.kmp_test.tests = { ...s.expected.kmp_test.tests, individual_total: 25 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.tests')).toBe(true);
    });

    it('rejects tests_executed with a non-zero exit_code -- a "tests executed" claim requires a clean process exit', () => {
      const s = baseScenario();
      s.expected.kmp_test.exit_code = 1;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.exit_code')).toBe(true);
    });

    it('rejects tests_executed with a forbidden error_code present (hybrid record)', () => {
      const s = baseScenario();
      s.expected.kmp_test.error_code = 'no_test_modules';
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.error_code')).toBe(true);
    });

    it('rejects tests_executed with a forbidden gradle marker present (hybrid record)', () => {
      const s = baseScenario();
      s.expected.gradle.marker = 'NO-SOURCE';
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.marker')).toBe(true);
    });

    it('rejects no_applicable_tests missing kmp_test.error_code/exit_code/caused_by_filter', () => {
      const s = baseScenarioNoTests();
      delete s.expected.kmp_test.error_code;
      delete s.expected.kmp_test.caused_by_filter;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.error_code')).toBe(true);
      expect(errors.some((e) => e.field === 'expected.kmp_test.caused_by_filter')).toBe(true);
    });

    it('rejects no_applicable_tests missing gradle.marker', () => {
      const s = baseScenarioNoTests();
      delete s.expected.gradle.marker;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.marker')).toBe(true);
    });

    it('rejects no_applicable_tests with a forbidden tests object present on either provider (hybrid record)', () => {
      const s = baseScenarioNoTests();
      s.expected.kmp_test.tests = { total: 0, passed: 0, failed: 0 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
    });

    // Round 11 (Docker/local-ci audit): a fresh review reproduced this oracle as too permissive --
    // error_code:"anything", kmp_test.exit_code:1.5, and gradle.exit_code:-7 all previously passed
    // with zero validation errors.
    it('EXACT REPRODUCTION: rejects an arbitrary kmp_test.error_code instead of the one real value (no_test_modules)', () => {
      const s = baseScenarioNoTests();
      s.expected.kmp_test.error_code = 'anything';
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.error_code')).toBe(true);
    });

    it('EXACT REPRODUCTION: rejects kmp_test.exit_code as a non-integer (1.5)', () => {
      const s = baseScenarioNoTests();
      s.expected.kmp_test.exit_code = 1.5;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.exit_code')).toBe(true);
    });

    it('rejects kmp_test.exit_code incoherent with caused_by_filter (caused_by_filter:true requires CONFIG_ERROR(2), not ENV_ERROR(3))', () => {
      const s = baseScenarioNoTests();
      s.expected.kmp_test.caused_by_filter = true;
      s.expected.kmp_test.exit_code = 3;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.exit_code')).toBe(true);
    });

    it('accepts kmp_test.exit_code:3 (ENV_ERROR) when caused_by_filter:false, the other real coherent variant', () => {
      const s = baseScenarioNoTests();
      s.expected.kmp_test.caused_by_filter = false;
      s.expected.kmp_test.exit_code = 3;
      const { errors } = validateScenario(s);
      expect(errors.filter((e) => e.field.startsWith('expected.kmp_test'))).toEqual([]);
    });

    it('EXACT REPRODUCTION: rejects gradle.exit_code:-7 -- a genuine NO-SOURCE result is always a successful (exit 0) gradle build', () => {
      const s = baseScenarioNoTests();
      s.expected.gradle.exit_code = -7;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.exit_code')).toBe(true);
    });

    it('rejects an unrecognized outcome_kind', () => {
      const { errors } = validateScenario(baseScenario({ expected: { ...baseScenario().expected, outcome_kind: 'something-else' } }));
      expect(errors.some((e) => e.field === 'expected.outcome_kind')).toBe(true);
    });

    it('rejects a gradle marker value outside the fixed enum', () => {
      const s = baseScenarioNoTests();
      s.expected.gradle.marker = 'SOMETHING-ELSE';
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.marker')).toBe(true);
    });

    // Review-fix regression: the docstring already claimed "non-negative integer
    // total/passed/failed" but the code only checked `typeof === 'number'` -- total:-1,
    // passed:1.5, failed:-2 all passed validation with zero errors under the old check.
    describe('tests.{total,passed,failed,individual_total} must be non-negative INTEGERS, not merely typeof number', () => {
      it('rejects a negative total', () => {
        const s = baseScenario();
        s.expected.kmp_test.tests = { total: -1, passed: 1, failed: 0, individual_total: 24 };
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
      });

      it('rejects a fractional passed', () => {
        const s = baseScenario();
        s.expected.kmp_test.tests = { total: 1, passed: 1.5, failed: 0, individual_total: 24 };
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
      });

      it('rejects a negative failed', () => {
        const s = baseScenario();
        s.expected.kmp_test.tests = { total: 1, passed: 1, failed: -2, individual_total: 24 };
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
      });

      it('rejects a negative individual_total (present, but never validated by the old code)', () => {
        const s = baseScenario();
        s.expected.kmp_test.tests = { total: 1, passed: 1, failed: 0, individual_total: -24 };
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
      });

      it('rejects a fractional individual_total', () => {
        const s = baseScenario();
        s.expected.kmp_test.tests = { total: 1, passed: 1, failed: 0, individual_total: 24.5 };
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
      });

      it('the EXACT adversarial repro from review (total:-1, passed:1.5, failed:-2) produces at least one error, not zero', () => {
        const s = baseScenario();
        s.expected.kmp_test.tests = { total: -1, passed: 1.5, failed: -2, individual_total: 24 };
        const { errors } = validateScenario(s);
        expect(errors.length).toBeGreaterThan(0);
      });

      it('still accepts well-formed non-negative integers (the fix does not regress the happy path)', () => {
        const { errors } = validateScenario(baseScenario());
        expect(errors.filter((e) => e.field === 'expected.kmp_test.tests')).toEqual([]);
      });
    });

    describe('tests.total must equal passed + failed (arithmetic consistency invariant)', () => {
      it('rejects total that does not equal passed + failed', () => {
        const s = baseScenario();
        s.expected.kmp_test.tests = { total: 10, passed: 1, failed: 0, individual_total: 24 };
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
      });

      it('accepts total that correctly equals passed + failed', () => {
        const s = baseScenario();
        s.expected.kmp_test.tests = { total: 1, passed: 1, failed: 0, individual_total: 24, skipped: 0 };
        const { errors } = validateScenario(s);
        expect(errors.filter((e) => e.field === 'expected.kmp_test.tests')).toEqual([]);
      });

      it('applies the same invariant to the gradle provider', () => {
        const s = baseScenario();
        s.expected.gradle.tests = { total: 24, passed: 20, failed: 0 }; // 20 != 24
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.gradle.tests')).toBe(true);
      });
    });
  });

  describe('expected.gradle -- allowed_invocations/evidence_task consistency (decisions 3/round-4)', () => {
    it('rejects evidence_task not being a member of allowed_invocations', () => {
      const s = baseScenarioNoTests();
      s.expected.gradle.evidence_task = ':app:someOtherTask';
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.evidence_task')).toBe(true);
    });

    it('rejects an allowed_invocations entry that is not also in the scenario\'s own policy.allowed_gradle_tasks', () => {
      const s = baseScenarioNoTests();
      s.expected.gradle.allowed_invocations = [':app:testDebugUnitTest', ':app:test', ':app:somethingNotInPolicy'];
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.allowed_invocations')).toBe(true);
    });

    it('accepts the real lifecycle-alias shape (both the direct task and :app:test in allowed_invocations, both in policy)', () => {
      const { errors } = validateScenario(baseScenarioNoTests());
      expect(errors).toEqual([]);
    });

    it('rejects an empty allowed_invocations array', () => {
      const s = baseScenarioNoTests();
      s.expected.gradle.allowed_invocations = [];
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.allowed_invocations')).toBe(true);
    });
  });

  it('rejects an id containing a path-traversal shape', () => {
    const { errors } = validateScenario(baseScenario({ id: '../../etc/passwd' }));
    expect(errors.some((e) => e.field === 'id')).toBe(true);
  });

  it('rejects a module not shaped like a colon-prefixed Gradle project path', () => {
    const { errors } = validateScenario(baseScenario({ expected: { ...baseScenario().expected, module: 'shared' } }));
    expect(errors.some((e) => e.field === 'expected.module')).toBe(true);
  });

  // A fresh review reproduced the oracle accepting ground truth the grader itself never
  // verifies: `skipped`/`individual_total` were optional-if-present on BOTH providers, but
  // graders.mjs's Gradle-path evaluation never reads either field at all (the JUnit-XML capture
  // mechanism can't verify them). Provider-specific contracts close this: kmp_test REQUIRES all
  // five counters; gradle FORBIDS the two it can't verify.
  describe('provider-specific tests contracts (a fresh review reproduced an unenforced oracle)', () => {
    it('EXACT REPRODUCTION: adding skipped:99/individual_total:999 to a real gradle contract now fails validation -- previously accepted with zero errors', () => {
      const s = baseScenario();
      s.expected.gradle.tests = { ...s.expected.gradle.tests, skipped: 99, individual_total: 999 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.tests.skipped')).toBe(true);
      expect(errors.some((e) => e.field === 'expected.gradle.tests.individual_total')).toBe(true);
    });

    it('gradle contract with ONLY skipped present (no individual_total) is still rejected', () => {
      const s = baseScenario();
      s.expected.gradle.tests = { ...s.expected.gradle.tests, skipped: 0 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.tests.skipped')).toBe(true);
    });

    it('gradle contract with ONLY individual_total present (no skipped) is still rejected', () => {
      const s = baseScenario();
      s.expected.gradle.tests = { ...s.expected.gradle.tests, individual_total: 24 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.tests.individual_total')).toBe(true);
    });

    it('kmp_test contract MISSING skipped is rejected (was merely optional before -- an absent counter on both scenario and envelope let the comparison pass vacuously)', () => {
      const s = baseScenario();
      const { skipped, ...withoutSkipped } = s.expected.kmp_test.tests;
      s.expected.kmp_test.tests = withoutSkipped;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
    });

    it('kmp_test contract MISSING individual_total is rejected', () => {
      const s = baseScenario();
      const { individual_total, ...withoutIndividualTotal } = s.expected.kmp_test.tests;
      s.expected.kmp_test.tests = withoutIndividualTotal;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
    });

    it('regression guard: a kmp_test contract with all five counters present and well-formed still validates cleanly', () => {
      const { errors } = validateScenario(baseScenario());
      expect(errors.filter((e) => e.field.startsWith('expected.kmp_test'))).toEqual([]);
    });
  });

  // Round 8: a fresh review reproduced the oracle still open in a sharper form -- individual_total
  // (the real per-test-case count) was merely non-negative, so total:1 (task-level)/
  // individual_total:0 both passed shape validation, letting a kmp-test envelope claim "the task
  // ran" while separately claiming "zero individual tests executed". Worse, nothing ever required
  // kmp_test.individual_total to agree with gradle.tests.total -- the two providers' own counts of
  // the SAME real test run could silently diverge in a scenario file with zero errors.
  describe('round 8: kmp_test.tests.individual_total must be POSITIVE and must equal gradle.tests.total; skipped must be exactly 0', () => {
    it('EXACT REPRODUCTION: individual_total:0 (a task ran, but zero individual tests) is rejected -- previously merely required non-negative', () => {
      const s = baseScenario();
      s.expected.kmp_test.tests = { ...s.expected.kmp_test.tests, individual_total: 0 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
    });

    it('EXACT REPRODUCTION: kmp_test.individual_total (24) disagreeing with gradle.tests.total (25) is rejected -- previously no cross-provider check existed at all', () => {
      const s = baseScenario();
      s.expected.gradle.tests = { ...s.expected.gradle.tests, total: 25, passed: 25 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests.individual_total')).toBe(true);
    });

    it('EXACT REPRODUCTION: the combined attack -- kmp_test.individual_total:0 alongside gradle.tests.total:24 -- is rejected both by the positivity check and the cross-provider check', () => {
      const s = baseScenario();
      s.expected.kmp_test.tests = { ...s.expected.kmp_test.tests, individual_total: 0 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests.individual_total')).toBe(true);
    });

    it('kmp_test.tests.skipped:1 (non-zero) is rejected -- the Gradle/JUnit-XML path can never corroborate a non-zero skip claim', () => {
      const s = baseScenario();
      s.expected.kmp_test.tests = { ...s.expected.kmp_test.tests, skipped: 1 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
    });

    it('regression guard: individual_total equal to gradle.tests.total and skipped:0 (the real, shipped scenario shape) still validates cleanly', () => {
      const { errors } = validateScenario(baseScenario());
      expect(errors.filter((e) => e.field.startsWith('expected.kmp_test') || e.field.startsWith('expected.gradle'))).toEqual([]);
    });
  });

  // Round 8: a fresh review reproduced unrecognized fields on `expected`/`expected.kmp_test`/
  // `expected.gradle`/their `.tests` objects being silently accepted rather than rejected --
  // including a FORBIDDEN field explicitly set to `null` (e.g. `tests.skipped: null`), which the
  // old `'k' in obj && obj.k != null` presence pattern treated as absent, silently skipping the
  // forbidden-field check entirely.
  describe('round 8: closed key sets on expected/kmp_test/gradle -- unrecognized fields (including forbidden fields explicitly set to null) are rejected', () => {
    it('EXACT REPRODUCTION: a resurrected expected.kmp_test.task field is rejected -- previously silently accepted', () => {
      const s = baseScenario();
      s.expected.kmp_test.task = ':wrong:test';
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.task')).toBe(true);
    });

    it('EXACT REPRODUCTION: an unrecognized expected.gradle.tests.flaky counter is rejected -- previously silently accepted', () => {
      const s = baseScenario();
      s.expected.gradle.tests.flaky = 99;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.tests.flaky')).toBe(true);
    });

    it('EXACT REPRODUCTION: expected.gradle.tests.skipped explicitly set to null still triggers the forbidden-field check -- previously the `!= null` presence pattern silently treated this as absent', () => {
      const s = baseScenario();
      s.expected.gradle.tests.skipped = null;
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.tests.skipped')).toBe(true);
    });

    it('an unrecognized top-level key on expected itself is rejected', () => {
      const s = baseScenario();
      s.expected.extra_field = 'unexpected';
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.extra_field')).toBe(true);
    });

    it('an unrecognized key on expected.kmp_test for a no_applicable_tests contract is rejected', () => {
      const s = baseScenarioNoTests();
      s.expected.kmp_test.unexpected_field = 'x';
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.unexpected_field')).toBe(true);
    });

    it('an unrecognized key on expected.gradle for a no_applicable_tests contract is rejected', () => {
      const s = baseScenarioNoTests();
      s.expected.gradle.unexpected_field = 'x';
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.unexpected_field')).toBe(true);
    });

    it('regression guard: well-formed tests_executed and no_applicable_tests scenarios with no extra keys anywhere still validate cleanly', () => {
      expect(validateScenario(baseScenario()).errors).toEqual([]);
      expect(validateScenario(baseScenarioNoTests()).errors).toEqual([]);
    });
  });

  // A fresh review reproduced tests_executed contracts legitimately claiming {total:0,...} --
  // self-contradictory (if outcome_kind is tests_executed, at least one test ran by definition),
  // and indistinguishable at the schema level from an absent-XML false positive (fixed separately
  // in matrix-runner.mjs's captureGradleJunitEvidence).
  describe('tests_executed requires a POSITIVE total, not merely non-negative (a fresh review reproduced total:0 as schema-legal)', () => {
    it('rejects kmp_test.tests.total:0 for a tests_executed contract', () => {
      const s = baseScenario();
      s.expected.kmp_test.tests = { total: 0, passed: 0, failed: 0, individual_total: 0, skipped: 0 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.kmp_test.tests')).toBe(true);
    });

    it('rejects gradle.tests.total:0 for a tests_executed contract', () => {
      const s = baseScenario();
      s.expected.gradle.tests = { total: 0, passed: 0, failed: 0 };
      const { errors } = validateScenario(s);
      expect(errors.some((e) => e.field === 'expected.gradle.tests')).toBe(true);
    });
  });

  // A fresh review reproduced project_alias:null and tags:"train" (a bare string, not an array)
  // both passing validateScenario() with zero errors.
  describe('project_alias / tags metadata validation (a fresh review reproduced these as entirely unvalidated)', () => {
    it('rejects project_alias:null', () => {
      const { errors } = validateScenario(baseScenario({ project_alias: null }));
      expect(errors.some((e) => e.field === 'project_alias')).toBe(true);
    });

    it('rejects project_alias as an empty string', () => {
      const { errors } = validateScenario(baseScenario({ project_alias: '' }));
      expect(errors.some((e) => e.field === 'project_alias')).toBe(true);
    });

    it('EXACT REPRODUCTION: rejects tags as a bare string ("train") instead of an array', () => {
      const { errors } = validateScenario(baseScenario({ tags: 'train' }));
      expect(errors.some((e) => e.field === 'tags')).toBe(true);
    });

    it('rejects an empty tags array', () => {
      const { errors } = validateScenario(baseScenario({ tags: [] }));
      expect(errors.some((e) => e.field === 'tags')).toBe(true);
    });

    it('rejects a tag value outside the known enum', () => {
      const { errors } = validateScenario(baseScenario({ tags: ['not-a-real-tag'] }));
      expect(errors.some((e) => e.field === 'tags')).toBe(true);
    });

    it('accepts a well-formed tags array (regression guard)', () => {
      const { errors } = validateScenario(baseScenario({ tags: ['held-out'] }));
      expect(errors.some((e) => e.field === 'tags')).toBe(false);
    });

    // Round 9: a fresh review reproduced tags NOT guaranteeing an exclusive train/held-out
    // partition -- ["train","held-out"] (contaminating both partitions at once) and
    // ["train","train"] (a meaningless duplicate) both previously passed with zero errors, despite
    // tags being documented as THE corpus partition a scenario belongs to -- a single-valued
    // concept by definition.
    it('EXACT REPRODUCTION: rejects tags containing BOTH train and held-out simultaneously', () => {
      const { errors } = validateScenario(baseScenario({ tags: ['train', 'held-out'] }));
      expect(errors.some((e) => e.field === 'tags')).toBe(true);
    });

    it('EXACT REPRODUCTION: rejects tags with a duplicate entry (["train","train"])', () => {
      const { errors } = validateScenario(baseScenario({ tags: ['train', 'train'] }));
      expect(errors.some((e) => e.field === 'tags')).toBe(true);
    });

    it('regression guard: a single-entry tags array for each known value still validates cleanly', () => {
      expect(validateScenario(baseScenario({ tags: ['train'] })).errors.some((e) => e.field === 'tags')).toBe(false);
      expect(validateScenario(baseScenario({ tags: ['held-out'] })).errors.some((e) => e.field === 'tags')).toBe(false);
    });
  });

  // Ground truth (independently re-verified live, 6x -- 3x kmp-test changed, 3x direct Gradle, cold
  // GRADLE_USER_HOME + JDK 17 each -- against android/nowinandroid @
  // 7d45eae4f8720a0c77f507712ba2437ff974b6ed, :core:common module): `changed`'s own real envelope
  // has NO top-level `parallel` key at all (confirmed via a direct `hasOwnProperty` check on the
  // raw JSON in every one of the 3 `changed` runs) and reports `changed.detected_modules` as bare,
  // colon-LESS strings (e.g. "core:common", never ":core:common") -- both load-bearing facts for
  // this contract's shape below.
  describe('expected.changed + fixture_setup (changed-module-verification contract)', () => {
    const CHANGED_FIXTURE_RELATIVE_PATH = 'core/common/src/main/kotlin/com/google/samples/apps/nowinandroid/core/common/result/Result.kt';
    const CHANGED_FIXTURE_BLOB = '934b6dfb2bb6ad97453094b72a67daa1aab590df';

    function baseScenarioChangedVerification(overrides = {}) {
      return baseScenario({
        id: 'sample-changed-verification-scenario',
        family: 'test-only',
        policy: {
          allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel', 'changed'],
          allowed_gradle_tasks: [':core:common:tasks', ':core:common:test'],
        },
        expected: {
          module: ':core:common',
          outcome_kind: 'tests_executed',
          kmp_test: { tests: { total: 1, passed: 1, failed: 0, individual_total: 1, skipped: 0 }, exit_code: 0 },
          gradle: { allowed_invocations: [':core:common:test'], evidence_task: ':core:common:test', tests: { total: 1, passed: 1, failed: 0 }, exit_code: 0 },
          changed: { detected_modules: ['core:common'], staged_only: false, base_ref: 'HEAD' },
        },
        fixture_setup: {
          operation: 'append_comment',
          relative_path: CHANGED_FIXTURE_RELATIVE_PATH,
          expected_blob_oid: CHANGED_FIXTURE_BLOB,
        },
        tags: ['held-out'],
        ...overrides,
      });
    }

    it('accepts a well-formed changed-verification scenario', () => {
      const { errors } = validateScenario(baseScenarioChangedVerification());
      expect(errors).toEqual([]);
    });

    describe('fixture_setup is optional -- the only optional canonical field', () => {
      it('accepts a scenario with no fixture_setup and no expected.changed at all (regression: the other 5 shipped scenarios)', () => {
        const { errors } = validateScenario(baseScenario());
        expect(errors.some((e) => e.field === 'fixture_setup')).toBe(false);
      });

      it('rejects fixture_setup that is not an object', () => {
        const s = baseScenarioChangedVerification({ fixture_setup: 'append_comment' });
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'fixture_setup')).toBe(true);
      });

      it('rejects fixture_setup with an unrecognized extra key', () => {
        const s = baseScenarioChangedVerification();
        s.fixture_setup.extra = 'nope';
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'fixture_setup.extra')).toBe(true);
      });

      it('rejects fixture_setup.operation missing', () => {
        const s = baseScenarioChangedVerification();
        delete s.fixture_setup.operation;
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'fixture_setup.operation')).toBe(true);
      });

      it('rejects fixture_setup.operation outside the closed enum-of-1', () => {
        const s = baseScenarioChangedVerification();
        s.fixture_setup.operation = 'delete_file';
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'fixture_setup.operation')).toBe(true);
      });

      it('rejects fixture_setup.relative_path missing', () => {
        const s = baseScenarioChangedVerification();
        delete s.fixture_setup.relative_path;
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'fixture_setup.relative_path')).toBe(true);
      });

      it('rejects fixture_setup.relative_path with a leading traversal segment', () => {
        const s = baseScenarioChangedVerification();
        s.fixture_setup.relative_path = '../../../etc/passwd';
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'fixture_setup.relative_path')).toBe(true);
      });

      it('rejects fixture_setup.relative_path with a traversal segment buried mid-path', () => {
        const s = baseScenarioChangedVerification();
        s.fixture_setup.relative_path = 'core/common/../../../etc/passwd';
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'fixture_setup.relative_path')).toBe(true);
      });

      it('rejects fixture_setup.relative_path as a POSIX absolute path', () => {
        const s = baseScenarioChangedVerification();
        s.fixture_setup.relative_path = '/etc/passwd';
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'fixture_setup.relative_path')).toBe(true);
      });

      it('rejects fixture_setup.relative_path with a Windows drive-letter prefix', () => {
        const s = baseScenarioChangedVerification();
        s.fixture_setup.relative_path = 'C:/fake-drive/secrets.txt';
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'fixture_setup.relative_path')).toBe(true);
      });

      it('rejects fixture_setup.relative_path containing a backslash', () => {
        const s = baseScenarioChangedVerification();
        s.fixture_setup.relative_path = 'core\\common\\Result.kt';
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'fixture_setup.relative_path')).toBe(true);
      });

      it('rejects fixture_setup.expected_blob_oid missing', () => {
        const s = baseScenarioChangedVerification();
        delete s.fixture_setup.expected_blob_oid;
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'fixture_setup.expected_blob_oid')).toBe(true);
      });

      it('rejects fixture_setup.expected_blob_oid the wrong length', () => {
        const s = baseScenarioChangedVerification();
        s.fixture_setup.expected_blob_oid = 'deadbeef';
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'fixture_setup.expected_blob_oid')).toBe(true);
      });

      it('rejects fixture_setup.expected_blob_oid with non-hex characters', () => {
        const s = baseScenarioChangedVerification();
        s.fixture_setup.expected_blob_oid = 'g'.repeat(40);
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'fixture_setup.expected_blob_oid')).toBe(true);
      });
    });

    describe('expected.changed shape', () => {
      it('rejects expected.changed with an unrecognized extra key', () => {
        const s = baseScenarioChangedVerification();
        s.expected.changed.extra = 'nope';
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.changed.extra')).toBe(true);
      });

      it('rejects expected.changed.detected_modules missing', () => {
        const s = baseScenarioChangedVerification();
        delete s.expected.changed.detected_modules;
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.changed.detected_modules')).toBe(true);
      });

      it('rejects expected.changed.detected_modules as an empty array', () => {
        const s = baseScenarioChangedVerification();
        s.expected.changed.detected_modules = [];
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.changed.detected_modules')).toBe(true);
      });

      it('rejects expected.changed.detected_modules with more than one entry -- multi-module is out of scope for this contract', () => {
        const s = baseScenarioChangedVerification();
        s.expected.changed.detected_modules = ['core:common', 'core:domain'];
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.changed.detected_modules')).toBe(true);
      });

      it('rejects expected.changed.detected_modules with a colon-PREFIXED entry -- the real envelope is colon-less (ground truth, above)', () => {
        const s = baseScenarioChangedVerification();
        s.expected.changed.detected_modules = [':core:common'];
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.changed.detected_modules')).toBe(true);
      });

      it('rejects expected.changed.staged_only missing', () => {
        const s = baseScenarioChangedVerification();
        delete s.expected.changed.staged_only;
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.changed.staged_only')).toBe(true);
      });

      it('rejects expected.changed.staged_only as a non-boolean', () => {
        const s = baseScenarioChangedVerification();
        s.expected.changed.staged_only = 'false';
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.changed.staged_only')).toBe(true);
      });

      it('rejects expected.changed.base_ref missing', () => {
        const s = baseScenarioChangedVerification();
        delete s.expected.changed.base_ref;
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.changed.base_ref')).toBe(true);
      });

      it('rejects expected.changed.base_ref anything other than "HEAD" -- the real CLI never produces another value (ground truth, above)', () => {
        const s = baseScenarioChangedVerification();
        s.expected.changed.base_ref = 'main';
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.changed.base_ref')).toBe(true);
      });
    });

    describe('fixture_setup <-> expected.changed coupling (validateFixtureSetupCoupling)', () => {
      it('rejects fixture_setup present without expected.changed', () => {
        const s = baseScenarioChangedVerification();
        delete s.expected.changed;
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.changed')).toBe(true);
      });

      it('rejects expected.changed present without fixture_setup', () => {
        const s = baseScenarioChangedVerification();
        delete s.fixture_setup;
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'fixture_setup')).toBe(true);
      });

      it('rejects family other than test-only when fixture_setup is present', () => {
        const s = baseScenarioChangedVerification({ family: 'coverage' });
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'family')).toBe(true);
      });

      it('rejects outcome_kind other than tests_executed when fixture_setup is present', () => {
        const s = baseScenarioChangedVerification();
        s.expected.outcome_kind = 'tests_failed';
        s.expected.kmp_test = { tests: { total: 1, passed: 0, failed: 1, individual_total: 3, skipped: 0 }, exit_code: 1 };
        s.expected.gradle.tests = { total: 3, passed: 0, failed: 3 };
        s.expected.gradle.exit_code = 1;
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.outcome_kind')).toBe(true);
      });

      it("rejects policy.allowed_kmptest_subcommands NOT including 'changed' when fixture_setup is present", () => {
        const s = baseScenarioChangedVerification();
        s.policy.allowed_kmptest_subcommands = ['doctor', 'describe', 'parallel'];
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'policy.allowed_kmptest_subcommands')).toBe(true);
      });

      it('rejects expected.changed.staged_only:true when fixture_setup is present -- the setup only ever produces an unstaged change', () => {
        const s = baseScenarioChangedVerification();
        s.expected.changed.staged_only = true;
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.changed.staged_only')).toBe(true);
      });

      it('rejects expected.changed.detected_modules[0] not matching expected.module (cross-check)', () => {
        const s = baseScenarioChangedVerification();
        s.expected.changed.detected_modules = ['core:domain'];
        const { errors } = validateScenario(s);
        expect(errors.some((e) => e.field === 'expected.changed.detected_modules')).toBe(true);
      });

      it('accepts the well-formed pairing (regression guard)', () => {
        const { errors } = validateScenario(baseScenarioChangedVerification());
        expect(errors).toEqual([]);
      });
    });
  });
});

// canonicalStructuredValue (review-round-2 fix): a bare JSON.stringify is NOT canonical w.r.t.
// object key insertion order -- {a:1,b:2} and {b:2,a:1} serialize to different strings despite
// being semantically identical. This recursively sorts object keys at every nesting level (arrays
// keep their own order/positional identity -- only OBJECT keys are order-independent) so
// partitionFieldKey/aggregate.mjs's own bucketing can use ONE shared, genuinely canonical
// serializer in both places, instead of two independently-drifting notions of "the same value".
describe('canonicalStructuredValue -- recursively sorted, order-independent structured serialization', () => {
  it('primitives pass through unchanged', () => {
    expect(canonicalStructuredValue('x')).toBe('x');
    expect(canonicalStructuredValue(1)).toBe(1);
    expect(canonicalStructuredValue(null)).toBeNull();
  });

  it('object key order does not affect the canonical form', () => {
    const a = canonicalStructuredValue({ count: 1, fingerprint_hmac: 'x' });
    const b = canonicalStructuredValue({ fingerprint_hmac: 'x', count: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('recurses into nested objects, not just the top level', () => {
    const a = canonicalStructuredValue({ outer: { z: 1, a: 2 } });
    const b = canonicalStructuredValue({ outer: { a: 2, z: 1 } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('arrays keep their own positional order -- only object keys are reordered', () => {
    const a = canonicalStructuredValue(['x', 'y']);
    const b = canonicalStructuredValue(['y', 'x']);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('genuinely different values still produce different canonical serializations', () => {
    const a = canonicalStructuredValue({ count: 1 });
    const b = canonicalStructuredValue({ count: 2 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
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
      repo_commit: 'c5c0661852f7c9da145ef56892048e706216a6ce',
      daemon_policy: 'disabled-via-gradle-user-home-properties', env_allowlist_profile: 'narrow',
      skill_invoked: { value: false, reason: null }, success: { value: true, reason: null },
      expected_outcome_matched: { value: true, reason: null },
      // schema:4 + a well-formed ambient_skill_profile/policy_allowed_* by default -- matches what
      // a REAL current buildRunRecord() output always carries (review-round-2 fix: these three
      // fields are now genuinely REQUIRED for a scenario+eligible record to aggregate at all, so a
      // shared default that leaves them `undefined` is no longer a realistic baseline -- individual
      // tests below override only the ONE field they're specifically exercising).
      schema: 4,
      policy_allowed_gradle_tasks: ['build'],
      policy_allowed_kmptest_subcommands: ['doctor'],
      ambient_skill_profile: { count: 0, scope_id: '00000000-0000-4000-8000-000000000000', fingerprint_hmac: '0'.repeat(64) },
      product_access_mode: 'product-visible-no-skill',
      // agent_runtime/execution_profile/skill_treatment (Section F): buildAggregateGroup is called
      // DIRECTLY here, bypassing aggregate.mjs's own withPartitionView() projection step -- a real
      // caller always pre-projects these 3 onto every record (including a schema<4 one, which gets
      // the literal "not-recorded" sentinel for each), so this fixture mirrors that exactly rather
      // than leaving them genuinely undefined (which buildAggregateGroup now correctly refuses).
      agent_runtime: 'not-recorded',
      execution_profile: 'not-recorded',
      skill_treatment: 'not-recorded',
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

  it('refuses to mix product_access_mode within one aggregate group (product-visible no-skill vs true free baseline)', () => {
    const { errors } = buildAggregateGroup([
      run({ run_id: 'r1', product_access_mode: 'product-visible-no-skill' }),
      run({ run_id: 'r2', product_access_mode: 'free-baseline-no-product' }),
    ]);
    expect(errors.some((e) => e.field === 'product_access_mode')).toBe(true);
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
  // incorrectly reject them. A follow-up review pass found the fix itself was still partial --
  // daemon_policy/env_allowlist_profile/scenario_id/repo_commit could ALSO silently agree on null
  // -- extended to the same completeness matrix below.
  describe('scenario + benchmark_eligible completeness matrix', () => {
    const MATRIX_FIELDS = ['project_commit', 'model_resolved', 'kmp_test_cli_source_sha', 'repo_commit', 'daemon_policy', 'env_allowlist_profile', 'scenario_id'];

    for (const field of MATRIX_FIELDS) {
      it(`refuses aggregation when ${field} is null on every scenario+eligible run, even though every run agrees it is null`, () => {
        const { errors, group } = buildAggregateGroup([run({ run_id: 'r1', [field]: null }), run({ run_id: 'r2', [field]: null })]);
        expect(errors.some((e) => e.field === field)).toBe(true);
        expect(group).toBeNull();
      });
    }

    it('does NOT apply to calibration runs (run_kind !== scenario), where these fields are legitimately null', () => {
      const allNull = Object.fromEntries(MATRIX_FIELDS.map((f) => [f, null]));
      const { errors } = buildAggregateGroup([
        run({ run_id: 'r1', run_kind: 'calibration', ...allNull }),
        run({ run_id: 'r2', run_kind: 'calibration', ...allNull }),
      ]);
      expect(errors.filter((e) => MATRIX_FIELDS.includes(e.field))).toEqual([]);
    });

    it('does NOT apply when benchmark_eligible is false (already refused outright by the existing check)', () => {
      const allNull = Object.fromEntries(MATRIX_FIELDS.map((f) => [f, null]));
      const { errors } = buildAggregateGroup([
        run({ run_id: 'r1', benchmark_eligible: false, ...allNull }),
      ]);
      // The pre-existing benchmark_eligible refusal fires; the completeness matrix specifically
      // must not ALSO fire redundantly for a group that's already rejected for a different reason.
      expect(errors.some((e) => e.field === 'benchmark_eligible')).toBe(true);
      expect(errors.filter((e) => MATRIX_FIELDS.includes(e.field))).toEqual([]);
    });

    it('accepts a scenario+eligible group when every completeness-matrix field is concrete', () => {
      const { errors, group } = buildAggregateGroup([run({ run_id: 'r1' }), run({ run_id: 'r2' })]);
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

  it('HARD_PARTITION_FIELDS includes env_allowlist_profile/policy_allowed_gradle_tasks/policy_allowed_kmptest_subcommands/schema', () => {
    expect(HARD_PARTITION_FIELDS).toContain('env_allowlist_profile');
    expect(HARD_PARTITION_FIELDS).toContain('policy_allowed_gradle_tasks');
    expect(HARD_PARTITION_FIELDS).toContain('policy_allowed_kmptest_subcommands');
    expect(HARD_PARTITION_FIELDS).toContain('claude_code_version');
    // schema (round-5 audit finding): without this, aggregate could silently fold schema:2
    // evidence (no foreign_skill_summary) together with schema:3 evidence (has it).
    expect(HARD_PARTITION_FIELDS).toContain('schema');
    // ambient_skill_profile (ambient-skill-profile fix): without this, aggregate could silently
    // fold two schema:4 runs together even when a Claude Code version bump changed the bundled-
    // skill set between them -- `schema` alone only guards cross-SCHEMA-VERSION mixing, not two
    // same-version runs with genuinely different measured ambient profiles.
    expect(HARD_PARTITION_FIELDS).toContain('ambient_skill_profile');
    // agent_runtime/execution_profile/skill_treatment (Section F, agentic-eval-runtime-neutral-
    // records-v1): without these, aggregate could silently fold two runs together across a
    // different runtime/model/vendor, execution profile, or measured skill treatment -- none of
    // which any pre-existing field above captures.
    expect(HARD_PARTITION_FIELDS).toContain('agent_runtime');
    expect(HARD_PARTITION_FIELDS).toContain('execution_profile');
    expect(HARD_PARTITION_FIELDS).toContain('skill_treatment');
    expect(HARD_PARTITION_FIELDS).toContain('product_access_mode');
    expect(HARD_PARTITION_FIELDS.length).toBe(22);
  });

  it('refuses to mix schema within one aggregate group -- a schema:2 record (no foreign_skill_summary) must never fold in with a schema:3 record (has it)', () => {
    const { errors } = buildAggregateGroup([run({ run_id: 'r1', schema: 2 }), run({ run_id: 'r2', schema: 3 })]);
    expect(errors.some((e) => e.field === 'schema')).toBe(true);
  });

  it('refuses to mix ambient_skill_profile within one aggregate group -- two runs with genuinely different ambient counts/fingerprints must never fold together', () => {
    const { errors } = buildAggregateGroup([
      run({ run_id: 'r1', ambient_skill_profile: { count: 0, scope_id: 'a'.repeat(8) + '-aaaa-4aaa-8aaa-' + 'a'.repeat(12), fingerprint_hmac: 'a'.repeat(64) } }),
      run({ run_id: 'r2', ambient_skill_profile: { count: 1, scope_id: 'b'.repeat(8) + '-bbbb-4bbb-8bbb-' + 'b'.repeat(12), fingerprint_hmac: 'b'.repeat(64) } }),
    ]);
    expect(errors.some((e) => e.field === 'ambient_skill_profile')).toBe(true);
  });

  // Regression coverage mirroring the identical policy_allowed_gradle_tasks precedent below: a
  // plain `new Set(runs.map(r => r[f]))` compares OBJECT values by reference, so two runs with a
  // structurally identical ambient_skill_profile as two separate object instances would be
  // spuriously flagged as "mixed" without partitionFieldKey's object-vs-reference generalization.
  it('does NOT mix two runs whose ambient_skill_profile is structurally identical but separate object instances', () => {
    const scopeId = 'c'.repeat(8) + '-cccc-4ccc-8ccc-' + 'c'.repeat(12);
    const { errors, group } = buildAggregateGroup([
      run({ run_id: 'r1', ambient_skill_profile: { count: 1, scope_id: scopeId, fingerprint_hmac: 'c'.repeat(64) } }),
      run({ run_id: 'r2', ambient_skill_profile: { count: 1, scope_id: scopeId, fingerprint_hmac: 'c'.repeat(64) } }),
    ]);
    expect(errors.filter((e) => e.field === 'ambient_skill_profile')).toEqual([]);
    expect(group.run_count).toBe(2);
  });

  // Review-round-2 finding (P2): JSON.stringify is NOT canonical w.r.t. object key insertion
  // order -- {count,fingerprint_hmac} and {fingerprint_hmac,count} (same values, different key
  // order) previously produced two DIFFERENT serialized strings, spuriously splitting two
  // semantically identical profiles into separate groups. partitionFieldKey now recursively sorts
  // object keys before stringifying (canonicalStructuredValue), independent of insertion order.
  it('does NOT mix two runs whose ambient_skill_profile has the SAME values in a DIFFERENT key order', () => {
    const scopeId = 'd'.repeat(8) + '-dddd-4ddd-8ddd-' + 'd'.repeat(12);
    const { errors, group } = buildAggregateGroup([
      run({ run_id: 'r1', ambient_skill_profile: { count: 1, scope_id: scopeId, fingerprint_hmac: 'd'.repeat(64) } }),
      run({ run_id: 'r2', ambient_skill_profile: { fingerprint_hmac: 'd'.repeat(64), scope_id: scopeId, count: 1 } }),
    ]);
    expect(errors.filter((e) => e.field === 'ambient_skill_profile')).toEqual([]);
    expect(group.run_count).toBe(2);
  });

  // Review-round-2 finding (P1): two real schema:3 records (predating ambient_skill_profile)
  // previously aggregated with ZERO errors because `undefined === undefined` "agreed" -- but the
  // resulting group_key SILENTLY LOSES the key entirely once JSON-round-tripped (a real consequence
  // of ANY committed/printed aggregate output), which then fails validateAggregateGroupKey against
  // its own contract. Fixed at the source: a benchmark-eligible scenario record missing
  // ambient_skill_profile entirely (schema<4) is now explicitly refused from aggregation, exactly
  // like the existing project_commit/model_resolved/etc. completeness-matrix fields.
  it('refuses to aggregate benchmark-eligible schema<4 scenario records -- their ambient profile is genuinely unknown, not "agreeing on absence"', () => {
    for (const schema of [1, 2, 3]) {
      // A real schema<4 record never carries this field at all -- explicitly undefined here
      // (overriding run()'s own realistic schema:4 default) to match that real shape exactly.
      const { errors, group } = buildAggregateGroup([
        run({ run_id: 'r1', schema, ambient_skill_profile: undefined }),
        run({ run_id: 'r2', schema, ambient_skill_profile: undefined }),
      ]);
      expect(errors.some((e) => e.field === 'ambient_skill_profile')).toBe(true);
      expect(group).toBeNull();
    }
  });

  // Direct proof of the round-trip failure mode the above fix closes -- a successful group's OWN
  // group_key must survive JSON.stringify/JSON.parse and still satisfy validateAggregateGroupKey.
  it('a successful group_key survives a real JSON round-trip and still validates against its own key contract', () => {
    const scopeId = 'e'.repeat(8) + '-eeee-4eee-8eee-' + 'e'.repeat(12);
    const { errors, group } = buildAggregateGroup([
      run({ run_id: 'r1', schema: 4, ambient_skill_profile: { count: 0, scope_id: scopeId, fingerprint_hmac: 'e'.repeat(64) } }),
      run({ run_id: 'r2', schema: 4, ambient_skill_profile: { count: 0, scope_id: scopeId, fingerprint_hmac: 'e'.repeat(64) } }),
    ]);
    expect(errors).toEqual([]);
    const roundTripped = JSON.parse(JSON.stringify(group.group_key));
    expect(validateAggregateGroupKey(roundTripped)).toEqual([]);
  });

  // group_key's own SHAPE changed (gained ambient_skill_profile, then agent_runtime/
  // execution_profile/skill_treatment) -- CURRENT_AGGREGATE_SCHEMA must reflect that, mirroring the
  // exact discipline already applied to LATEST_RUN_SCHEMA whenever a run record's own shape changes.
  it('CURRENT_AGGREGATE_SCHEMA is 4 -- group_key gained product_access_mode and must be versioned', () => {
    expect(CURRENT_AGGREGATE_SCHEMA).toBe(4);
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

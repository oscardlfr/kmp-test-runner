#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/schemas.mjs -- versioned scenario/condition/run/aggregate schemas.
//
// Hand-rolled (CURRENT_SCHEMA int + CANONICAL_FIELDS array + typeof/enum/regex validators
// returning {errors, warnings}), matching tools/measurement-registry.mjs's existing pattern --
// no JSON-schema library exists anywhere in this repo's own code, so none is added here.
//
// "Never infer missing metrics; store null with a reason": every metric that can be
// legitimately unavailable is {value: T|null, reason: string|null} -- the validator rejects
// value:null paired with reason:null.

export const CURRENT_RUN_SCHEMA = 1;
export const CURRENT_SCENARIO_SCHEMA = 1;
export const CURRENT_AGGREGATE_SCHEMA = 1;

export const RUN_KIND_VALUES = ['calibration', 'corpus-probe', 'scenario', 'smoke'];
export const CONDITION_VALUES = ['no-skill', 'current-skill', 'candidate-skill'];
export const FAMILY_VALUES = ['test-only', 'coverage', 'trigger-only'];
export const CACHE_STATE_VALUES = ['cold', 'warm', 'mixed', 'unknown'];
export const PLATFORM_VALUES = ['windows', 'macos', 'linux', 'not-recorded'];
export const TERMINATION_REASON_VALUES = [null, 'timeout', 'error', 'unsupported-platform-profile'];
export const PRIVACY_STATUS_VALUES = ['public', 'redacted-private'];
export const DAEMON_POLICY_VALUES = ['disabled-via-gradle-user-home-properties', 'default', 'unknown'];

const RUN_CANONICAL_FIELDS = [
  'schema', 'run_id', 'run_kind', 'benchmark_eligible', 'scenario_id', 'query_id', 'condition',
  'skill_source_sha', 'kmp_test_cli_version', 'kmp_test_cli_source_sha',
  'resolved_kmp_test_executable_path', 'model_requested', 'model_resolved', 'session_id_observed',
  'repo_commit', 'project_alias', 'project_commit', 'platform', 'family', 'cache_state',
  'daemon_policy', 'env_allowlist_profile', 'seed', 'order_index', 'started_at', 'ended_at',
  'wall_clock_ms', 'skill_available', 'skill_invocation_attempted', 'skill_invoked', 'skill_invocation_event', 'success',
  'expected_outcome_matched', 'first_useful_signal_ms', 'first_useful_signal_event', 'tokens',
  'tool_calls_total', 'shell_commands_total', 'test_invocations_total', 'retries', 'output_bytes',
  'stream_json_bytes', 'human_interventions', 'terminated', 'termination_reason', 'exit_code',
  'permission_mode_used', 'policy_allowed_gradle_tasks', 'policy_allowed_kmptest_subcommands',
  'policy_sha256', 'hook_call_count', 'hook_deny_count', 'privacy_status', 'raw_capture_committed',
  'raw_capture_location', 'notes', 'errors',
];

// Fields using the {value, reason} nullable-metric shape -- "never infer, store null with a reason".
const NULLABLE_METRIC_FIELDS = [
  'skill_available', 'skill_invocation_attempted', 'skill_invoked', 'success', 'expected_outcome_matched',
  'first_useful_signal_ms', 'tool_calls_total', 'shell_commands_total', 'test_invocations_total',
  'retries', 'output_bytes', 'stream_json_bytes', 'human_interventions',
];

// Per-field value domain: 'boolean' for status metrics, 'count' for non-negative integer
// counts/bytes, 'timing' for non-negative (possibly fractional) millisecond values. A
// non-null value failing its domain (e.g. skill_invoked: "false" as a string, or a negative
// byte count) passes the {value,reason} shape check but is still wrong data -- validated
// separately so a malformed value can't silently corrupt grading/aggregation downstream.
const NULLABLE_METRIC_KIND = {
  skill_available: 'boolean', skill_invocation_attempted: 'boolean', skill_invoked: 'boolean', success: 'boolean',
  expected_outcome_matched: 'boolean', first_useful_signal_ms: 'timing',
  tool_calls_total: 'count', shell_commands_total: 'count', test_invocations_total: 'count',
  retries: 'count', output_bytes: 'count', stream_json_bytes: 'count', human_interventions: 'count',
  'tokens.input': 'count', 'tokens.output': 'count', 'tokens.cache_read': 'count', 'tokens.cache_creation': 'count',
};

function isNullableMetric(m) {
  return m != null && typeof m === 'object' && 'value' in m && 'reason' in m;
}

function validateMetricValueDomain(value, kind, field, errors) {
  if (value === null || kind == null) return;
  if (kind === 'boolean' && typeof value !== 'boolean') {
    errors.push({ field, message: `value must be a boolean, got ${typeof value}` });
  } else if (kind === 'count' && !(Number.isInteger(value) && value >= 0)) {
    errors.push({ field, message: `value must be a non-negative integer` });
  } else if (kind === 'timing' && !(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
    errors.push({ field, message: `value must be a non-negative finite number` });
  }
}

function validateNullableMetric(m, field, errors, kind = NULLABLE_METRIC_KIND[field] ?? null) {
  if (!isNullableMetric(m)) {
    errors.push({ field, message: `must be a {value, reason} object` });
    return;
  }
  if (m.value === null && (m.reason == null || m.reason === '')) {
    errors.push({ field, message: `value is null but reason is missing -- never infer, always explain` });
  }
  if (m.value !== null && m.reason != null) {
    errors.push({ field, message: `reason must be null when value is present -- reason is only for explaining an absence` });
  }
  validateMetricValueDomain(m.value, kind, field, errors);
}

function validateEventRef(ref, field, errors) {
  if (ref == null) return; // legitimately absent (e.g. skill never invoked)
  if (typeof ref !== 'object' || typeof ref.type !== 'string' || typeof ref.index !== 'number') {
    errors.push({ field, message: `must be null or {type: string, index: number}` });
  }
}

function validateTokens(tokens, errors) {
  if (tokens == null || typeof tokens !== 'object') {
    errors.push({ field: 'tokens', message: 'must be an object' });
    return;
  }
  for (const key of ['input', 'output', 'cache_read', 'cache_creation']) {
    validateNullableMetric(tokens[key], `tokens.${key}`, errors);
  }
}

export function validateRun(run) {
  const errors = [];
  const warnings = [];
  if (run == null || typeof run !== 'object') {
    errors.push({ field: '(root)', message: 'run record is not an object' });
    return { errors, warnings };
  }

  const keys = new Set(Object.keys(run));
  for (const f of RUN_CANONICAL_FIELDS) if (!keys.has(f)) errors.push({ field: f, message: 'missing required field' });
  for (const k of keys) if (!RUN_CANONICAL_FIELDS.includes(k)) warnings.push({ field: k, message: 'unrecognized field' });

  if (run.schema !== CURRENT_RUN_SCHEMA) errors.push({ field: 'schema', message: `expected ${CURRENT_RUN_SCHEMA}, got ${run.schema}` });
  if (typeof run.run_id !== 'string' || run.run_id.length === 0) errors.push({ field: 'run_id', message: 'must be a non-empty string' });
  if (!RUN_KIND_VALUES.includes(run.run_kind)) errors.push({ field: 'run_kind', message: `must be one of ${RUN_KIND_VALUES.join('|')}` });
  if (typeof run.benchmark_eligible !== 'boolean') errors.push({ field: 'benchmark_eligible', message: 'must be a boolean' });
  if (run.run_kind !== 'scenario' && run.benchmark_eligible !== false) {
    errors.push({ field: 'benchmark_eligible', message: `must be false for run_kind "${run.run_kind}" -- only future controlled scenario runs may be true` });
  }
  if (!CONDITION_VALUES.includes(run.condition)) errors.push({ field: 'condition', message: `must be one of ${CONDITION_VALUES.join('|')}` });
  if (run.condition === 'current-skill' && typeof run.skill_source_sha !== 'string') {
    errors.push({ field: 'skill_source_sha', message: 'required (non-null) when condition is current-skill' });
  }
  if (run.condition !== 'current-skill' && run.skill_source_sha !== null) {
    errors.push({ field: 'skill_source_sha', message: 'must be null when condition is not current-skill' });
  }
  if (!FAMILY_VALUES.includes(run.family)) errors.push({ field: 'family', message: `must be one of ${FAMILY_VALUES.join('|')}` });
  if (!CACHE_STATE_VALUES.includes(run.cache_state)) errors.push({ field: 'cache_state', message: `must be one of ${CACHE_STATE_VALUES.join('|')}` });
  if (!PLATFORM_VALUES.includes(run.platform)) errors.push({ field: 'platform', message: `must be one of ${PLATFORM_VALUES.join('|')}` });
  if (!TERMINATION_REASON_VALUES.includes(run.termination_reason)) errors.push({ field: 'termination_reason', message: `must be one of ${TERMINATION_REASON_VALUES.map(String).join('|')}` });
  if (typeof run.terminated !== 'boolean') errors.push({ field: 'terminated', message: 'must be a boolean' });
  if (run.terminated === false && run.termination_reason !== null) errors.push({ field: 'termination_reason', message: 'must be null when terminated is false' });
  if (run.exit_code !== null && !(Number.isInteger(run.exit_code))) {
    errors.push({ field: 'exit_code', message: 'must be null or an integer' });
  }
  const startedAtMs = typeof run.started_at === 'string' ? Date.parse(run.started_at) : NaN;
  const endedAtMs = typeof run.ended_at === 'string' ? Date.parse(run.ended_at) : NaN;
  if (Number.isNaN(startedAtMs)) errors.push({ field: 'started_at', message: 'must be a valid ISO timestamp string' });
  if (Number.isNaN(endedAtMs)) errors.push({ field: 'ended_at', message: 'must be a valid ISO timestamp string' });
  if (!Number.isNaN(startedAtMs) && !Number.isNaN(endedAtMs) && endedAtMs < startedAtMs) {
    errors.push({ field: 'ended_at', message: 'must not be before started_at' });
  }
  if (!(typeof run.wall_clock_ms === 'number' && Number.isFinite(run.wall_clock_ms) && run.wall_clock_ms >= 0)) {
    errors.push({ field: 'wall_clock_ms', message: 'must be a non-negative finite number' });
  }
  if (!PRIVACY_STATUS_VALUES.includes(run.privacy_status)) errors.push({ field: 'privacy_status', message: `must be one of ${PRIVACY_STATUS_VALUES.join('|')}` });
  if (typeof run.raw_capture_committed !== 'boolean') errors.push({ field: 'raw_capture_committed', message: 'must be a boolean' });
  if (run.raw_capture_committed !== false) errors.push({ field: 'raw_capture_committed', message: 'must always be false -- raw transcripts are never committed' });
  if (typeof run.raw_capture_location === 'string' && /^[a-zA-Z]:[\\/]|^\//.test(run.raw_capture_location)) {
    errors.push({ field: 'raw_capture_location', message: 'must be a relative path, never absolute' });
  }
  // A CONFIRMED invocation is only ever derived from an attempt that also succeeded (see
  // stream-parser.mjs's findSkillInvocation) -- invoked:true without attempted:true is never
  // truthfully producible and signals a construction bug upstream, not legitimate data.
  if (run.skill_invoked?.value === true && run.skill_invocation_attempted?.value !== true) {
    errors.push({ field: 'skill_invoked', message: 'cannot be true when skill_invocation_attempted is not true' });
  }

  for (const f of NULLABLE_METRIC_FIELDS) if (f in run) validateNullableMetric(run[f], f, errors);
  if ('tokens' in run) validateTokens(run.tokens, errors);
  validateEventRef(run.skill_invocation_event, 'skill_invocation_event', errors);
  validateEventRef(run.first_useful_signal_event, 'first_useful_signal_event', errors);

  // hook_call_count/hook_deny_count are ALWAYS real, non-negative integers in production --
  // countHookEvents() derives both as array .length values, never null/undefined -- so both are
  // validated unconditionally, independently of one another. A previous version only validated
  // this PAIR when BOTH were non-null, which meant e.g. hook_call_count:"bad" alongside
  // hook_deny_count:null produced ZERO errors (the outer `!= null` guard on hook_deny_count was
  // false, so the whole block -- including hook_call_count's own check -- was skipped entirely).
  const hookCallCountOk = Number.isInteger(run.hook_call_count) && run.hook_call_count >= 0;
  if (!hookCallCountOk) errors.push({ field: 'hook_call_count', message: 'must be a non-negative integer' });
  const hookDenyCountOk = Number.isInteger(run.hook_deny_count) && run.hook_deny_count >= 0;
  if (!hookDenyCountOk) errors.push({ field: 'hook_deny_count', message: 'must be a non-negative integer' });
  if (hookCallCountOk && hookDenyCountOk && run.hook_deny_count > run.hook_call_count) {
    errors.push({ field: 'hook_deny_count', message: 'cannot exceed hook_call_count' });
  }
  for (const field of ['policy_allowed_gradle_tasks', 'policy_allowed_kmptest_subcommands']) {
    if (!Array.isArray(run[field])) {
      errors.push({ field, message: 'must be an array' });
    } else if (run[field].some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      errors.push({ field, message: 'every entry must be a non-empty string' });
    }
  }
  if (typeof run.policy_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(run.policy_sha256)) {
    errors.push({ field: 'policy_sha256', message: 'must be a lowercase 64-char hex SHA-256 string' });
  }
  if (!Array.isArray(run.errors)) {
    errors.push({ field: 'errors', message: 'must be an array' });
  } else if (run.errors.some((entry) => entry == null || typeof entry !== 'object' || Array.isArray(entry))) {
    errors.push({ field: 'errors', message: 'every entry must be an object' });
  }

  return { errors, warnings };
}

const SCENARIO_CANONICAL_FIELDS = [
  'schema', 'id', 'family', 'project_alias', 'project_url', 'project_commit', 'prompt',
  'expected_outcome', 'grader', 'first_useful_signal_predicate', 'tags',
];

export function validateScenario(scenario) {
  const errors = [];
  const warnings = [];
  if (scenario == null || typeof scenario !== 'object') {
    errors.push({ field: '(root)', message: 'scenario is not an object' });
    return { errors, warnings };
  }
  const keys = new Set(Object.keys(scenario));
  for (const f of SCENARIO_CANONICAL_FIELDS) if (!keys.has(f)) errors.push({ field: f, message: 'missing required field' });
  for (const k of keys) if (!SCENARIO_CANONICAL_FIELDS.includes(k)) warnings.push({ field: k, message: 'unrecognized field' });

  if (scenario.schema !== CURRENT_SCENARIO_SCHEMA) errors.push({ field: 'schema', message: `expected ${CURRENT_SCENARIO_SCHEMA}` });
  if (typeof scenario.id !== 'string' || !/^[a-z0-9-]+$/.test(scenario.id)) errors.push({ field: 'id', message: 'must be a kebab-case string' });
  if (!FAMILY_VALUES.includes(scenario.family) || scenario.family === 'trigger-only') {
    errors.push({ field: 'family', message: 'must be test-only or coverage for a scenario' });
  }
  if (typeof scenario.project_url !== 'string' || !/^https:\/\//.test(scenario.project_url)) {
    errors.push({ field: 'project_url', message: 'must be an https URL (public project)' });
  }
  if (typeof scenario.prompt !== 'string' || scenario.prompt.length === 0) errors.push({ field: 'prompt', message: 'must be a non-empty string' });
  const bannedTermsRe = /\bkmp-test\b|kmp-test-runner|bin[\\/]kmp-test\.js/i;
  if (typeof scenario.prompt === 'string' && bannedTermsRe.test(scenario.prompt)) {
    errors.push({ field: 'prompt', message: 'must not mention kmp-test, the skill name, or the bin path' });
  }
  if (scenario.grader == null || typeof scenario.grader.kind !== 'string') errors.push({ field: 'grader', message: 'must have a string "kind"' });
  if (scenario.first_useful_signal_predicate == null || typeof scenario.first_useful_signal_predicate.description !== 'string') {
    errors.push({ field: 'first_useful_signal_predicate', message: 'must have a string "description"' });
  }

  return { errors, warnings };
}

const AGGREGATE_CANONICAL_FIELDS = ['schema', 'group_key', 'run_count', 'runs'];

// Hard partition keys: runs disagreeing on ANY of these represent materially different
// executions and must never be folded into one aggregate. Beyond the original grouping/family
// keys, project_commit/model_resolved/platform/skill_source_sha/policy_sha256 guard against
// silently averaging across a re-pinned scenario commit, a different resolved model, a
// different host platform, a different skill snapshot, or a changed policy-hook version.
// kmp_test_cli_source_sha/daemon_policy guard against silently averaging across a different
// harness code version or a different Gradle daemon policy (e.g. one run's daemon left enabled).
// env_allowlist_profile/policy_allowed_gradle_tasks/policy_allowed_kmptest_subcommands guard
// against silently averaging across a different environment-isolation profile or a materially
// different command-policy configuration -- policy_sha256 only captures policy-hook.mjs's own
// source code, not the CALLER-supplied allowed-task/subcommand lists it's configured with, which
// change what a run was actually permitted to do just as materially as the hook's code does.
export const HARD_PARTITION_FIELDS = [
  'scenario_id', 'condition', 'family', 'run_kind', 'cache_state',
  'project_commit', 'model_resolved', 'platform', 'skill_source_sha', 'policy_sha256',
  'kmp_test_cli_source_sha', 'daemon_policy',
  'env_allowlist_profile', 'policy_allowed_gradle_tasks', 'policy_allowed_kmptest_subcommands',
];

// Some HARD_PARTITION_FIELDS values (the two policy_allowed_* lists) are arrays -- a plain
// `new Set(runs.map(r => r[f]))` compares array VALUES by reference, so two runs with
// structurally identical arrays (e.g. both ['doctor']) as separate object instances would be
// treated as "different" and spuriously rejected as mixed. Comparing the JSON.stringify
// representation instead compares by structural equality, matching how aggregate.mjs's own
// bucket key already treats array-valued fields.
function partitionFieldKey(value) {
  return Array.isArray(value) ? JSON.stringify(value) : value;
}

export function validateAggregateGroupKey(key) {
  const errors = [];
  if (key == null || typeof key !== 'object') {
    errors.push({ field: '(root)', message: 'group key is not an object' });
    return errors;
  }
  for (const f of HARD_PARTITION_FIELDS) {
    if (!(f in key)) errors.push({ field: f, message: 'aggregate group key missing required partition field' });
  }
  return errors;
}

// Fairness Contract as code: refuses to fold runs into one aggregate group unless they agree
// on every hard partition key (HARD_PARTITION_FIELDS) -- mixing any of them is a validation
// error, any benchmark_eligible:false run is refused outright (calibration/corpus-probe/smoke
// prove the harness works; they are never measurement data), and duplicate/empty run_id values
// are rejected before counting so a re-submitted run can't silently inflate run_count.
export function buildAggregateGroup(runs) {
  const errors = [];
  if (!Array.isArray(runs) || runs.length === 0) {
    errors.push({ field: 'runs', message: 'must be a non-empty array' });
    return { errors, group: null };
  }
  const runIds = runs.map((r) => r?.run_id);
  if (runIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    errors.push({ field: 'run_id', message: 'every run must have a non-empty run_id' });
  } else if (new Set(runIds).size !== runIds.length) {
    errors.push({ field: 'run_id', message: 'duplicate run_id values are not allowed in one aggregate group' });
  }
  const ineligible = runs.filter((r) => r.benchmark_eligible !== true);
  if (ineligible.length > 0) {
    errors.push({ field: 'benchmark_eligible', message: `${ineligible.length} run(s) are benchmark_eligible:false and cannot be folded into a publishable aggregate` });
  }
  for (const f of HARD_PARTITION_FIELDS) {
    const values = new Set(runs.map((r) => partitionFieldKey(r[f])));
    if (values.size > 1) errors.push({ field: f, message: `mixed values in one aggregate group: ${[...values].join(', ')}` });
  }
  if (errors.length > 0) return { errors, group: null };
  const [first] = runs;
  const group_key = {};
  for (const f of HARD_PARTITION_FIELDS) group_key[f] = first[f];
  return {
    errors,
    group: {
      schema: CURRENT_AGGREGATE_SCHEMA,
      group_key,
      run_count: runs.length,
      runs: runs.map((r) => r.run_id),
    },
  };
}

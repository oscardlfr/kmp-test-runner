// tests/vitest/agentic-eval-accepted-run-audit.test.js
// Unit tests for tools/agentic-eval/accepted-run-audit.mjs -- the privacy-safe structural audit
// sidecar for accepted scenario run records (accepted-run-observability PR). Pure builder +
// validator + cross-validator + a thin build/redact/hash orchestration helper, all exercised here
// with synthetic conditionResult/record inputs -- no real Claude session, no subprocess.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCEPTED_AUDIT_SIDECAR_SCHEMA_V1,
  ACCEPTED_AUDIT_SIDECAR_SCHEMA_V2,
  ACCEPTED_AUDIT_SIDECAR_SCHEMA_V3,
  ACCEPTED_AUDIT_SIDECAR_SCHEMA_V4,
  ACCEPTED_AUDIT_SIDECAR_SCHEMA_V5,
  ACCEPTED_AUDIT_SIDECAR_SCHEMA_V6,
  ACCEPTED_AUDIT_SIDECAR_SCHEMA_V7,
  ACCEPTED_AUDIT_SIDECAR_SCHEMA_V8,
  ACCEPTED_AUDIT_SIDECAR_SCHEMA_V9,
  LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA,
  SUPPORTED_ACCEPTED_AUDIT_SIDECAR_SCHEMAS,
  acceptedAuditRelativePathFor,
  buildAcceptedRunAuditSidecar,
  validateAcceptedRunAuditSidecar,
  crossValidateAcceptedRunAuditAgainstRecord,
  finalizeAcceptedRunAuditSidecar,
  computeRunProvenanceSha256,
  expectedAcceptedAuditSchemaFor,
} from '../../tools/agentic-eval/accepted-run-audit.mjs';
// Test-only: a test file constructing fixtures is not a "core consumer" under the runtime-adapter
// boundary (that rule scopes production files only -- see agentic-eval-runtime-boundary.test.js's
// own CORE_CONSUMERS list, which never includes test files). Reusing the REAL, frozen
// stream-parser.mjs functions to convert this file's existing raw-event fixtures into canonical
// toolAttempts[] is deliberately safer than hand-computing the mapping per fixture: it is the exact
// same parsing logic runtimes/claude-code.mjs's own normalizeObservations composes, so there is no
// risk of this file's mapping silently diverging from the real one.
import { findAllToolUsesWithResults, isTargetSkillReference, isRecognizedPreDispatchBlock } from '../../tools/agentic-eval/stream-parser.mjs';
// Evidence1 success-recovery PR B, Stage B2 (review-round finding): the single authorized module
// for Section 9.9's closed enums and shared validator -- imported here verbatim, never
// re-declared, so this file's own enum expectations can never silently drift from
// rejection-diagnostics.mjs's identical import of the same symbols.
import {
  FLAVOR_RELATION_VALUES, TEST_TYPE_RELATION_VALUES, COVERAGE_TARGET_STATUS_VALUES,
  COVERAGE_REPORT_STATUS_VALUES, EXECUTION_MODE_VALUES, COVERAGE_GATE_WARNING_BUCKET_FIELDS,
  validateOutcomeObservabilitySummary,
} from '../../tools/agentic-eval/coverage-gate-observability.mjs';

const TARGET_PLUGIN_NAME = 'kmp-test-runner';
const TARGET_SKILL_NAME = 'kmp-test-runner';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function initEventStub() {
  return { type: 'system', subtype: 'init' };
}
function resultEventStub() {
  return { type: 'result', subtype: 'success' };
}
function bashToolUseEvent(id, command) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] } };
}
function multiCallEvent(calls) {
  return { type: 'assistant', message: { content: calls.map(({ id, command }) => ({ type: 'tool_use', name: 'Bash', id, input: { command } })) } };
}
function skillToolUseEvent(id, skill) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id, input: { skill } }] } };
}
function otherToolUseEvent(id, name) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input: {} }] } };
}
function toolResultEvent(id, { isError = false, content = 'ok' } = {}) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content, is_error: isError, tool_use_id: id }] } };
}

/** A minimal, schema-v5-shaped run record -- just enough for the sidecar builder/cross-validator
 * to read the identity fields, the first-signal boundary, and the 4 metrics. */
function baseRecord(overrides = {}) {
  return {
    schema: 5,
    run_id: 'scenario-current-skill-abcd1234',
    run_kind: 'scenario',
    condition: 'current-skill',
    scenario_id: 'kampkit-android-host-test-discovery',
    first_useful_signal_event: null,
    policy_allowed_gradle_tasks: [':shared:testAndroidHostTest'],
    policy_allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel'],
    hook_call_count: 0,
    hook_deny_count: 0,
    tool_calls_total: { value: 0, reason: null },
    shell_commands_total: { value: 0, reason: null },
    post_signal_ms: { value: null, reason: 'no first useful signal boundary' },
    post_signal_tool_calls: { value: null, reason: 'no first useful signal boundary' },
    policy_denials_before_first_signal: { value: null, reason: 'no first useful signal boundary' },
    policy_denials_after_first_signal: { value: null, reason: 'no first useful signal boundary' },
    ...overrides,
  };
}

/** Converts this file's existing raw `events` array fixtures into the canonical
 * observation.toolAttempts[] shape, via the same real, frozen stream-parser.mjs functions
 * runtimes/claude-code.mjs's own normalizeObservations composes -- every one of this file's
 * existing event-array fixtures (built via initEventStub/bashToolUseEvent/skillToolUseEvent/
 * multiCallEvent/otherToolUseEvent/toolResultEvent, unchanged below) keeps working exactly as
 * before; only how the resulting conditionResult is SHAPED for accepted-run-audit.mjs to consume
 * changed. receiptNs mirrors parseStreamJsonl's own no-taggedLines fallback (BigInt(event index)). */
function toolAttemptsFromEvents(events) {
  return findAllToolUsesWithResults(events).map((u) => {
    const kind = u.name === 'Skill' ? 'skill' : u.name === 'Bash' ? 'shell' : 'other';
    const command = kind === 'shell' ? (typeof u.input?.command === 'string' ? u.input.command : null) : null;
    const skillReference = kind === 'skill' && typeof u.input?.skill === 'string' ? u.input.skill : null;
    const targetsExpectedSkill = kind === 'skill' ? isTargetSkillReference(u.input?.skill, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME) : null;
    const textStatus = !u.resultFound ? 'missing' : (typeof u.resultContent === 'string' ? 'text' : 'unsupported');
    const recognized = isRecognizedPreDispatchBlock(u);
    return {
      id: u.id ?? null, kind, runtimeName: u.name ?? null, eventIndex: u.index, receiptNs: BigInt(u.index),
      profileAllowed: true, command, skillReference, targetsExpectedSkill,
      result: {
        found: u.resultFound,
        eventIndex: u.resultFound ? u.resultIndex : null,
        isError: u.resultFound ? u.resultIsError : null,
        text: textStatus === 'text' ? u.resultContent : null,
        textStatus,
      },
      preDispatchBlock: { recognized, signature: recognized ? 'claude-code/bash-pre-dispatch-block/v1' : null },
    };
  });
}

/**
 * `dispatchAccounting` mirrors what buildBashDispatchAccounting produces in production: every Bash
 * call carrying an allow/deny decision is `hook_evaluated`. It must be supplied explicitly, because
 * the sidecar builder takes dispatch_status EXCLUSIVELY from this map and never re-derives it from
 * decisionByAttempt -- a sidecar built without it reads every Bash call as `unaccounted` and fails
 * validation, which is the intended fail-closed behaviour (asserted directly further down).
 * Pass `dispatchAccounting: null` to exercise that path.
 */
/** A minimal, schema-v6-shaped run record -- baseRecord() plus the 4 new v6 groups and the
 * remaining fields computeRunProvenanceSha256's own RUN_PROVENANCE_PROJECTION_KEYS projects
 * (platform/repo_commit/kmp_test_cli_source_sha/project_commit). Every one of those 12 projected
 * keys must be a real value, never undefined: canonicalStructuredValue throws on an
 * undefined-valued object key even when the key itself is present (assigning `undefined` to a
 * property does not remove it), so a real schema:6 record (and this fixture) must always populate
 * all of them. Deliberately does not mirror record-level semantic consistency (e.g. condition vs.
 * skill_observation.delivery_mode) beyond what buildAcceptedRunAuditSidecar/
 * crossValidateAcceptedRunAuditAgainstRecord themselves read -- schemas.mjs's own validateRun is
 * what enforces that, and is exercised separately in agentic-eval-schemas.test.js. */
function v6Record(overrides = {}) {
  return {
    ...baseRecord(overrides),
    schema: 6,
    platform: 'windows',
    repo_commit: 'a'.repeat(40),
    kmp_test_cli_source_sha: 'b'.repeat(40),
    project_commit: 'c'.repeat(40),
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
    ...overrides,
  };
}

function conditionResultFrom(events, { decisionByAttempt = new Map(), endedHrtimeNs, dispatchAccounting } = {}) {
  const derived = dispatchAccounting !== undefined
    ? dispatchAccounting
    : { dispatchStatusByAttempt: new Map([...decisionByAttempt].map(([id, d]) => [id, (d === 'allow' || d === 'deny') ? 'hook_evaluated' : 'unaccounted'])) };
  return {
    observation: {
      toolAttempts: toolAttemptsFromEvents(events),
      timing: { receiptNsByEventIndex: new Map(events.map((_, i) => [i, BigInt(i)])) },
      process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs },
    },
    junitAttribution: { decisionByAttempt },
    dispatchAccounting: derived,
  };
}

function terminalEvidence(overrides = {}) {
  return {
    present: true,
    provider: 'kmp-test',
    tool_result_event_index: 2,
    evidence_well_formed: true,
    target_matches_expected: true,
    outcome_matches_expected: true,
    malformed: false,
    parallel_evidence_invalid: false,
    changed_evidence_invalid: false,
    observed_result: {
      outcome_kind: 'tests_executed',
      module_matches_expected: true,
      total: 4,
      passed: 4,
      failed: 0,
      missed_lines: null,
      threshold: null,
      modules_contributing: null,
    },
    final_answer_block: {
      found: true,
      parsed: true,
      ambiguous: false,
      matches_observed: true,
      comparison_status: 'matched',
      declared_outcome_kind: 'tests_executed',
      observed_outcome_kind: 'tests_executed',
      missing_fields: [],
      mismatch_fields: [],
      unexpected_key_count: 0,
    },
    coverage_gate_diagnostic: 'not-applicable',
    coverage_gate_attempts: [],
    ...overrides,
  };
}

describe('acceptedAuditRelativePathFor', () => {
  it('is exactly "audit/<run_id>.json", POSIX-style', () => {
    expect(acceptedAuditRelativePathFor('scenario-current-skill-abcd1234')).toBe('audit/scenario-current-skill-abcd1234.json');
  });
});

describe('buildAcceptedRunAuditSidecar -- top-level identity + shape', () => {
  it('carries schema/run_id/run_schema/run_kind/condition/scenario_id mirrored from the record', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    // baseRecord() is schema:5 (still the only run schema a v1/v2 sidecar is compatible with) --
    // the schema-aware builder therefore emits v2 here, never LATEST (which now means "v3, for a
    // schema:6+ record only"). See the dedicated schema:6 describe block below for the v3 case.
    expect(sidecar.schema).toBe(ACCEPTED_AUDIT_SIDECAR_SCHEMA_V2);
    expect(sidecar.run_id).toBe(record.run_id);
    expect(sidecar.run_schema).toBe(5);
    expect(sidecar.run_kind).toBe('scenario');
    expect(sidecar.condition).toBe('current-skill');
    expect(sidecar.scenario_id).toBe(record.scenario_id);
    expect(Object.keys(sidecar).sort()).toEqual([
      'condition', 'first_useful_signal_event', 'run_id', 'run_kind', 'run_schema', 'scenario_id',
      'schema', 'summary', 'terminal_authoritative_event', 'tool_calls',
    ]);
  });

  // Characterization freeze (runtime-contract PR): the test above pins the sidecar's TOP-LEVEL
  // keys, but says nothing about what is inside `summary` or inside each `tool_calls[]` entry --
  // a silently dropped summary counter, or a tool-call entry that stopped carrying its
  // dispatch_status, would leave it green. These two nested inventories are the remaining gap,
  // plus the sidecar's own schema version constants. Every expected list is written out
  // literally and sorted before comparison; none is derived from the produced sidecar or from a
  // private constant in the module under test.
  //
  // The transcript below carries a real Bash tool_use WITH its correlated result and explicit
  // synthetic dispatch accounting, so tool_calls is genuinely non-empty -- an empty array would
  // make the per-entry inventory vacuously true.
  it('freezes the sidecar schema constants and the nested summary / tool_calls[] field inventories', () => {
    expect(ACCEPTED_AUDIT_SIDECAR_SCHEMA_V1).toBe(1);
    expect(ACCEPTED_AUDIT_SIDECAR_SCHEMA_V2).toBe(2);
    // Evidence1 success-recovery PR B: LATEST is now 10 (v10, the first schema exclusive to a run
    // schema:8+ record, produced for BOTH policy_mode values) -- this record has schema:6 (not 8)
    // and no not_applicable execution_profile, so it still produces a byte-for-byte v3 sidecar
    // below (expectedAcceptedAuditSchemaFor's own fallback), proving LATEST advancing never
    // silently redirects a schema<8, strict/policy-required record away from v3.
    expect(LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA).toBe(10);
    expect([...SUPPORTED_ACCEPTED_AUDIT_SIDECAR_SCHEMAS]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const record = baseRecord({
      hook_call_count: 1,
      tool_calls_total: { value: 1, reason: null },
      shell_commands_total: { value: 1, reason: null },
    });
    const cr = conditionResultFrom(
      [initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()],
      { decisionByAttempt: new Map([['t1', 'allow']]) },
    );
    const sidecar = buildAcceptedRunAuditSidecar({
      record, conditionResult: cr, terminalAuthoritativeEventIndex: null,
      targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
    });

    expect(Object.keys(sidecar.summary).sort()).toEqual([
      'policy_decisions_missing',
      'policy_denials_after_first_signal',
      'policy_denials_before_first_signal',
      'policy_denials_total',
      'post_signal_ms',
      'post_signal_tool_calls',
      'pre_dispatch_blocked_total',
      'shell_commands_total',
      'tool_calls_total',
    ]);

    expect(sidecar.tool_calls.length).toBe(1);
    for (const toolCall of sidecar.tool_calls) {
      expect(Object.keys(toolCall).sort()).toEqual([
        'dispatch_status',
        'operation',
        'ordinal',
        'phase',
        'plan_only',
        'policy_decision',
        'result_status',
        'tool_kind',
        'tool_result_event_index',
        'tool_use_event_index',
      ]);
    }
  });

  it('first_useful_signal_event mirrors the record\'s own field exactly (or null)', () => {
    const record = baseRecord({ first_useful_signal_event: { type: 'user.tool_result', index: 2 } });
    const cr = conditionResultFrom([initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: 2, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.first_useful_signal_event).toEqual({ type: 'user.tool_result', index: 2 });
  });

  it('terminal_authoritative_event is null when terminalAuthoritativeEventIndex is null', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.terminal_authoritative_event).toBeNull();
  });

  // The grader's own selected terminal attempt is NOT necessarily the chronologically last Bash
  // call -- an unrelated trailing call (e.g. a double-check of something else) must never silently
  // become "terminal" in the sidecar either, since this field is taken directly from the caller's
  // explicit terminalAuthoritativeEventIndex, never re-derived from "the last Bash call" here.
  it('terminal_authoritative_event reflects the EXPLICITLY PASSED terminal index, not the last Bash call in the transcript', () => {
    const record = baseRecord({ first_useful_signal_event: { type: 'user.tool_result', index: 2 } });
    const cr = conditionResultFrom([
      initEventStub(),
      bashToolUseEvent('t1', 'kmp-test parallel --module-filter shared --json'), // terminal (per grader) -- event 2 is its result
      toolResultEvent('t1'),
      bashToolUseEvent('t2', 'kmp-test describe --json'), // a later, unrelated trailing call
      toolResultEvent('t2'),
      resultEventStub(),
    ]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: 2, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.terminal_authoritative_event).toEqual({ type: 'user.tool_result', index: 2 });
    expect(sidecar.terminal_authoritative_event.index).not.toBe(4); // NOT the later call's own result index
  });
});

describe('buildAcceptedRunAuditSidecar -- tool_calls[] classification', () => {
  it('classifies a target-Skill call WITHOUT storing the raw skill name anywhere', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), skillToolUseEvent('t1', TARGET_SKILL_NAME), toolResultEvent('t1'), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0].tool_kind).toBe('target-skill');
    expect(sidecar.tool_calls[0].operation).toBeNull();
    expect(sidecar.tool_calls[0].plan_only).toBeNull();
    expect(sidecar.tool_calls[0].policy_decision).toBe('not-applicable');
    expect(JSON.stringify(sidecar)).not.toContain(TARGET_SKILL_NAME);
  });

  it('classifies a non-target-Skill call WITHOUT storing the raw (foreign) skill name anywhere', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), skillToolUseEvent('t1', 'some-other-secret-skill-xyz'), toolResultEvent('t1', { isError: true }), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0].tool_kind).toBe('non-target-skill');
    expect(sidecar.tool_calls[0].result_status).toBe('error');
    expect(JSON.stringify(sidecar)).not.toContain('some-other-secret-skill-xyz');
  });

  it('classifies an unexpected tool (name outside Bash/Skill) as unexpected-tool, not-applicable decision', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), otherToolUseEvent('t1', 'Read'), toolResultEvent('t1'), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0].tool_kind).toBe('unexpected-tool');
    expect(sidecar.tool_calls[0].operation).toBeNull();
    expect(sidecar.tool_calls[0].plan_only).toBeNull();
    expect(sidecar.tool_calls[0].policy_decision).toBe('not-applicable');
  });

  it('an ALLOWED kmp-test subcommand reports its own subcommand as operation; a NOT-allowed one reports "other" -- never the raw command/module-filter', () => {
    const record = baseRecord({ policy_allowed_kmptest_subcommands: ['doctor', 'parallel'] });
    const decisionByAttempt = new Map([['t1', 'allow'], ['t2', 'allow']]);
    const cr = conditionResultFrom([
      initEventStub(),
      bashToolUseEvent('t1', 'kmp-test parallel --module-filter secretmodule123 --json'),
      toolResultEvent('t1'),
      bashToolUseEvent('t2', 'kmp-test describe --json'), // describe is NOT in allowed_kmptest_subcommands here
      toolResultEvent('t2'),
      resultEventStub(),
    ], { decisionByAttempt });
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0]).toMatchObject({ tool_kind: 'kmp-test', operation: 'parallel', plan_only: false, policy_decision: 'allow' });
    expect(sidecar.tool_calls[1]).toMatchObject({ tool_kind: 'kmp-test', operation: 'other', policy_decision: 'allow' });
    expect(JSON.stringify(sidecar)).not.toContain('secretmodule123');
    expect(JSON.stringify(sidecar)).not.toContain('--module-filter');
  });

  it('an ALLOWED Gradle task reports "allowed-task"; a NOT-allowed one reports "other" -- never the raw task name', () => {
    const record = baseRecord({ policy_allowed_gradle_tasks: [':shared:testAndroidHostTest'] });
    const decisionByAttempt = new Map([['t1', 'allow'], ['t2', 'allow']]);
    const cr = conditionResultFrom([
      initEventStub(),
      bashToolUseEvent('t1', './gradlew :shared:testAndroidHostTest --console=plain'),
      toolResultEvent('t1', { content: 'BUILD SUCCESSFUL in 8s' }),
      bashToolUseEvent('t2', './gradlew :secretmodule123:test --console=plain'),
      toolResultEvent('t2', { content: 'BUILD SUCCESSFUL in 1s' }),
      resultEventStub(),
    ], { decisionByAttempt });
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0]).toMatchObject({ tool_kind: 'gradle', operation: 'allowed-task' });
    expect(sidecar.tool_calls[1]).toMatchObject({ tool_kind: 'gradle', operation: 'other' });
    expect(JSON.stringify(sidecar)).not.toContain('secretmodule123');
    expect(JSON.stringify(sidecar)).not.toContain(':shared:testAndroidHostTest');
  });

  it('a command that is neither kmp-test nor Gradle classifies as other-bash, operation null, plan_only false', () => {
    const record = baseRecord();
    const decisionByAttempt = new Map([['t1', 'deny']]);
    const cr = conditionResultFrom([initEventStub(), bashToolUseEvent('t1', 'ls -la /some/secret/path'), toolResultEvent('t1', { isError: true }), resultEventStub()], { decisionByAttempt });
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0]).toMatchObject({ tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'deny', result_status: 'error' });
    expect(JSON.stringify(sidecar)).not.toContain('/some/secret/path');
  });

  it('plan_only reflects a --dry-run kmp-test invocation', () => {
    const record = baseRecord();
    const decisionByAttempt = new Map([['t1', 'allow']]);
    const cr = conditionResultFrom([initEventStub(), bashToolUseEvent('t1', 'kmp-test parallel --module-filter shared --dry-run --json'), toolResultEvent('t1'), resultEventStub()], { decisionByAttempt });
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0].plan_only).toBe(true);
  });

  it('policy_decision is "missing" when decisionByAttempt has no entry for this attempt (never invents allow)', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()]); // empty decisionByAttempt
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0].policy_decision).toBe('missing');
  });

  it('result_status is "missing" when no tool_result was ever found, "error" when is_error:true, "success" otherwise', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([
      initEventStub(),
      bashToolUseEvent('t1', 'kmp-test doctor --json'), // no result at all
      bashToolUseEvent('t2', 'kmp-test describe --json'),
      toolResultEvent('t2', { isError: true }),
      resultEventStub(),
    ]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0].result_status).toBe('missing');
    expect(sidecar.tool_calls[0].tool_result_event_index).toBeNull();
    expect(sidecar.tool_calls[1].result_status).toBe('error');
  });

  it('multiple tool_use blocks dispatched in ONE assistant event share the same tool_use_event_index, in stable order', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([
      initEventStub(),
      multiCallEvent([{ id: 'a1', command: 'kmp-test doctor --json' }, { id: 'a2', command: 'kmp-test describe --json' }]),
      toolResultEvent('a1'),
      toolResultEvent('a2'),
      resultEventStub(),
    ]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls.length).toBe(2);
    expect(sidecar.tool_calls[0].tool_use_event_index).toBe(sidecar.tool_calls[1].tool_use_event_index);
    expect(sidecar.tool_calls[0].ordinal).toBe(0);
    expect(sidecar.tool_calls[1].ordinal).toBe(1);
  });
});

describe('buildAcceptedRunAuditSidecar -- phase classification', () => {
  it('every entry is "no-signal" when there is no first-useful-signal boundary at all', () => {
    const record = baseRecord({ first_useful_signal_event: null });
    const cr = conditionResultFrom([initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls.every((tc) => tc.phase === 'no-signal')).toBe(true);
  });

  it('classifies pre-signal, produced-signal, and post-signal correctly around a real boundary', () => {
    // index 0=init,1=tool_use(t1),2=result(t1, THE signal),3=tool_use(t2),4=result(t2),5=terminal result
    const record = baseRecord({ first_useful_signal_event: { type: 'user.tool_result', index: 2 } });
    const cr = conditionResultFrom([
      initEventStub(),
      bashToolUseEvent('t1', 'kmp-test parallel --module-filter shared --json'), // pre-signal (dispatch before its own result)
      toolResultEvent('t1'), // index 2 -- THE first useful signal
      bashToolUseEvent('t2', 'kmp-test parallel --module-filter shared --json'), // dispatched AFTER the signal -> post-signal
      toolResultEvent('t2'),
      resultEventStub(),
    ]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: 4, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0].phase).toBe('produced-signal'); // t1: its OWN result IS the signal
    expect(sidecar.tool_calls[1].phase).toBe('post-signal'); // t2: dispatched at index 3 > signal index 2
  });

  it('a call dispatched BEFORE the signal but whose result arrives AFTER it is still pre-signal, never post-signal', () => {
    // index 0=init,1=tool_use(t1, dispatched first),2=tool_use(t2),3=result(t2, THE signal),4=result(t1, arrives late),5=terminal
    const record = baseRecord({ first_useful_signal_event: { type: 'user.tool_result', index: 3 } });
    const events = [
      initEventStub(),
      bashToolUseEvent('t1', 'kmp-test describe --json'), // dispatched BEFORE the signal
      bashToolUseEvent('t2', 'kmp-test parallel --module-filter shared --json'),
      toolResultEvent('t2'), // index 3 -- THE signal
      toolResultEvent('t1'), // t1's own result arrives AFTER the signal
      resultEventStub(),
    ];
    const cr = conditionResultFrom(events);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: 3, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    const t1Entry = sidecar.tool_calls.find((tc) => tc.tool_use_event_index === 1);
    expect(t1Entry.phase).toBe('pre-signal'); // dispatched (index 1) before the boundary (index 3), regardless of when its result lands
  });
});

describe('buildAcceptedRunAuditSidecar -- summary', () => {
  it('tool_calls_total/shell_commands_total equal the actual entries', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([
      initEventStub(),
      bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'),
      skillToolUseEvent('t2', TARGET_SKILL_NAME), toolResultEvent('t2'),
      resultEventStub(),
    ]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.summary.tool_calls_total).toBe(2);
    expect(sidecar.summary.shell_commands_total).toBe(1);
  });

  it('policy_denials_total/policy_decisions_missing count only Bash-family entries', () => {
    const record = baseRecord();
    const decisionByAttempt = new Map([['t1', 'deny'], ['t3', 'allow']]);
    const cr = conditionResultFrom([
      initEventStub(),
      bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1', { isError: true }), // denied
      bashToolUseEvent('t2', 'kmp-test describe --json'), toolResultEvent('t2'), // missing decision
      bashToolUseEvent('t3', 'kmp-test parallel --module-filter shared --json'), toolResultEvent('t3'), // allowed
      resultEventStub(),
    ], { decisionByAttempt });
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.summary.policy_denials_total).toBe(1);
    expect(sidecar.summary.policy_decisions_missing).toBe(1);
  });

  it('post_signal_ms/post_signal_tool_calls/policy_denials_{before,after}_first_signal are all null when there is no boundary', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.summary.post_signal_ms).toBeNull();
    expect(sidecar.summary.post_signal_tool_calls).toBeNull();
    expect(sidecar.summary.policy_denials_before_first_signal).toBeNull();
    expect(sidecar.summary.policy_denials_after_first_signal).toBeNull();
  });

  it('post_signal_tool_calls / denials before+after are real numbers, independently re-derived, around a real boundary', () => {
    const record = baseRecord({ first_useful_signal_event: { type: 'user.tool_result', index: 2 } });
    const decisionByAttempt = new Map([['t2', 'deny']]);
    const events = [
      initEventStub(),
      bashToolUseEvent('t1', 'kmp-test parallel --module-filter shared --json'),
      toolResultEvent('t1'), // index 2 -- the signal
      bashToolUseEvent('t2', 'kmp-test doctor --json'), // dispatched AFTER the signal, denied
      toolResultEvent('t2', { isError: true }),
      resultEventStub(),
    ];
    const cr = conditionResultFrom(events, { decisionByAttempt, endedHrtimeNs: undefined });
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: 2, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.summary.post_signal_tool_calls).toBe(1); // only t2 (index 3 > 2)
    expect(sidecar.summary.policy_denials_before_first_signal).toBe(0);
    expect(sidecar.summary.policy_denials_after_first_signal).toBe(1);
  });
});

// Builder-to-validator contract: every EARLIER test in this file feeds either an empty/near-empty
// conditionResult into the builder, or a hand-constructed fixture directly into the validator --
// never a REALISTIC, populated builder OUTPUT (several distinct tool_kinds at once) through the
// validator. That gap matters specifically because validateAcceptedRunAuditSidecar's own
// enum/operation-domain/phase-recompute checks are tightened below (accepted-run-observability PR
// review round) to reject arbitrary/incoherent content -- this is the one test proving the
// BUILDER's own legitimate output still satisfies its own VALIDATOR after that tightening, not a
// tautology (the builder and validator are independently written, so they CAN drift).
describe('buildAcceptedRunAuditSidecar -> validateAcceptedRunAuditSidecar (populated, multi-kind contract)', () => {
  it('a realistic multi-tool-kind transcript, once built, validates with ZERO errors', () => {
    const record = baseRecord({
      first_useful_signal_event: { type: 'user.tool_result', index: 6 },
      policy_allowed_gradle_tasks: [':shared:testAndroidHostTest'],
      policy_allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel'],
    });
    const events = [
      initEventStub(),
      skillToolUseEvent('s1', 'kmp-test-runner'), // target-skill
      toolResultEvent('s1'),
      otherToolUseEvent('r1', 'Read'), // unexpected-tool
      toolResultEvent('r1'),
      bashToolUseEvent('k1', 'kmp-test doctor --json'), // kmp-test, allowed subcommand
      toolResultEvent('k1'), // index 6 -- this IS the first-useful-signal event
      bashToolUseEvent('k2', 'kmp-test clean'), // kmp-test, NOT in the allowlist -> 'other'
      toolResultEvent('k2'),
      bashToolUseEvent('g1', './gradlew :shared:testAndroidHostTest'), // gradle, allowed task
      toolResultEvent('g1'),
      bashToolUseEvent('g2', './gradlew :other:task'), // gradle, NOT allowed -> 'other'
      toolResultEvent('g2'),
      bashToolUseEvent('o1', 'ls -la'), // other-bash
      toolResultEvent('o1'),
      skillToolUseEvent('s2', 'some-foreign-skill'), // non-target-skill
      toolResultEvent('s2'),
      resultEventStub(),
    ];
    const cr = conditionResultFrom(events, { decisionByAttempt: new Map([['k1', 'allow'], ['k2', 'allow'], ['g1', 'allow'], ['g2', 'deny'], ['o1', 'allow']]) });
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: 6, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    const { errors } = validateAcceptedRunAuditSidecar(sidecar);
    expect(errors).toEqual([]);
    // Sanity on the fixture itself -- proves the test actually exercises every tool_kind/phase it
    // claims to, rather than accidentally validating a degenerate all-one-kind transcript clean.
    expect(new Set(sidecar.tool_calls.map((tc) => tc.tool_kind))).toEqual(
      new Set(['target-skill', 'unexpected-tool', 'kmp-test', 'gradle', 'other-bash', 'non-target-skill']),
    );
    expect(sidecar.tool_calls.some((tc) => tc.phase === 'pre-signal')).toBe(true);
    expect(sidecar.tool_calls.some((tc) => tc.phase === 'produced-signal')).toBe(true);
    expect(sidecar.tool_calls.some((tc) => tc.phase === 'post-signal')).toBe(true);
  });
});

describe('validateAcceptedRunAuditSidecar', () => {
  function validSidecar(overrides = {}) {
    return {
      schema: 1, run_id: 'scenario-current-skill-abcd1234', run_schema: 5, run_kind: 'scenario',
      condition: 'current-skill', scenario_id: 'kampkit-android-host-test-discovery',
      first_useful_signal_event: null, terminal_authoritative_event: null,
      tool_calls: [],
      summary: {
        tool_calls_total: 0, shell_commands_total: 0, post_signal_ms: null, post_signal_tool_calls: null,
        policy_denials_total: 0, policy_denials_before_first_signal: null, policy_denials_after_first_signal: null,
        policy_decisions_missing: 0,
      },
      ...overrides,
    };
  }

  it('accepts a minimal, empty-tool_calls sidecar', () => {
    expect(validateAcceptedRunAuditSidecar(validSidecar()).errors).toEqual([]);
  });

  it('rejects an unrecognized top-level key', () => {
    const sidecar = { ...validSidecar(), extra: 'nope' };
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
  });

  it('rejects a missing required top-level key', () => {
    const { scenario_id, ...sidecar } = validSidecar();
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
  });

  it('rejects an unrecognized key inside a tool_calls[] entry', () => {
    const sidecar = validSidecar({
      tool_calls: [{ ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'no-signal', extra: 'nope' }],
    });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
  });

  it('rejects an unrecognized key inside summary', () => {
    const sidecar = validSidecar({ summary: { ...validSidecar().summary, extra: 'nope' } });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
  });

  it('rejects an invalid tool_kind enum value', () => {
    const sidecar = validSidecar({ tool_calls: [{ ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'made-up-kind', operation: null, plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'no-signal' }] });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
  });

  it('rejects an invalid policy_decision enum value', () => {
    const sidecar = validSidecar({ tool_calls: [{ ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'maybe', result_status: 'success', phase: 'no-signal' }] });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
  });

  it('rejects an invalid phase enum value', () => {
    const sidecar = validSidecar({ tool_calls: [{ ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'sometime' }] });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
  });

  it('rejects ordinals that are not exactly 0..N-1', () => {
    const entry = (ordinal) => ({ ordinal, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'no-signal' });
    const sidecar = validSidecar({ tool_calls: [entry(0), entry(2)], summary: { ...validSidecar().summary, tool_calls_total: 2 } });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field.includes('ordinal'))).toBe(true);
  });

  it('rejects tool_result_event_index non-null when result_status is "missing" (must be null iff missing)', () => {
    const sidecar = validSidecar({ tool_calls: [{ ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'allow', result_status: 'missing', phase: 'no-signal' }] });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-null result index that is NOT after its own tool-use index', () => {
    const sidecar = validSidecar({ tool_calls: [{ ordinal: 0, tool_use_event_index: 5, tool_result_event_index: 2, tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'no-signal' }] });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
  });

  it('rejects a Skill-kind entry with a non-not-applicable policy_decision', () => {
    const sidecar = validSidecar({ tool_calls: [{ ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'target-skill', operation: null, plan_only: null, policy_decision: 'allow', result_status: 'success', phase: 'no-signal' }] });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
  });

  it('rejects a Bash-kind entry with policy_decision:not-applicable -- every Bash call needs a real decision category', () => {
    const sidecar = validSidecar({ tool_calls: [{ ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'gradle', operation: 'other', plan_only: false, policy_decision: 'not-applicable', result_status: 'success', phase: 'no-signal' }] });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
  });

  it('rejects summary counts that do not equal the actual tool_calls[] entries', () => {
    const entry = { ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'deny', result_status: 'success', phase: 'no-signal' };
    const sidecar = validSidecar({ tool_calls: [entry], summary: { ...validSidecar().summary, tool_calls_total: 1, shell_commands_total: 1, policy_denials_total: 0 } }); // should be 1, not 0
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-null terminal_authoritative_event that does not correlate to any tool_calls[] entry\'s own result index', () => {
    const sidecar = validSidecar({ terminal_authoritative_event: { type: 'user.tool_result', index: 99 } });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
  });

  it('accepts a non-null terminal_authoritative_event that DOES correlate to a real tool_calls[] entry', () => {
    const sidecar = validSidecar({
      terminal_authoritative_event: { type: 'user.tool_result', index: 2 },
      tool_calls: [{ ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'gradle', operation: 'allowed-task', plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'produced-signal' }],
      first_useful_signal_event: { type: 'user.tool_result', index: 2 },
      summary: { tool_calls_total: 1, shell_commands_total: 1, post_signal_ms: 0, post_signal_tool_calls: 0, policy_denials_total: 0, policy_denials_before_first_signal: 0, policy_denials_after_first_signal: 0, policy_decisions_missing: 0 },
    });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors).toEqual([]);
  });

  // Event-ref strictness (review finding 1a) -- applies identically to BOTH
  // first_useful_signal_event and terminal_authoritative_event, since both go through the same
  // validateEventRefField helper.
  describe('event ref strictness (first_useful_signal_event / terminal_authoritative_event)', () => {
    const validEntryForSignal = (index) => ({ ordinal: 0, tool_use_event_index: 1, tool_result_event_index: index, tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'produced-signal' });

    it('rejects an event ref with an extra key beyond type/index', () => {
      const sidecar = validSidecar({ first_useful_signal_event: { type: 'user.tool_result', index: 2, extra: 'nope' }, tool_calls: [validEntryForSignal(2)], summary: { ...validSidecar().summary, tool_calls_total: 1, shell_commands_total: 1 } });
      expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
    });

    it('rejects an event ref missing the index key', () => {
      const sidecar = validSidecar({ terminal_authoritative_event: { type: 'user.tool_result' } });
      expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
    });

    it('rejects an event ref whose type is not exactly "user.tool_result"', () => {
      const sidecar = validSidecar({ terminal_authoritative_event: { type: 'assistant.tool_use', index: 2 } });
      expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
    });

    it('rejects a negative event-ref index', () => {
      const sidecar = validSidecar({ terminal_authoritative_event: { type: 'user.tool_result', index: -1 } });
      expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
    });

    it('rejects a fractional event-ref index', () => {
      const sidecar = validSidecar({ terminal_authoritative_event: { type: 'user.tool_result', index: 1.5 } });
      expect(validateAcceptedRunAuditSidecar(sidecar).errors.length).toBeGreaterThan(0);
    });
  });

  // Per-tool_kind operation domain (review finding 1b/1c/1d) -- validateAcceptedRunAuditSidecar
  // previously only checked `operation === null` for the non-Bash branch; a Bash-family entry's
  // operation value was never checked against any domain at all, so an arbitrary/contradictory
  // string (or an object) silently passed.
  describe('per-tool_kind operation domain', () => {
    const entry = (overrides) => ({ ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'no-signal', ...overrides });

    it('rejects other-bash with a non-null operation', () => {
      const sidecar = validSidecar({ tool_calls: [entry({ tool_kind: 'other-bash', operation: 'ls' })] });
      expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field.endsWith('.operation'))).toBe(true);
    });

    it('rejects gradle with an operation outside allowed-task|other', () => {
      const sidecar = validSidecar({ tool_calls: [entry({ tool_kind: 'gradle', operation: 'made-up-operation' })] });
      expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field.endsWith('.operation'))).toBe(true);
    });

    it('accepts gradle with operation exactly "allowed-task"', () => {
      const sidecar = validSidecar({ tool_calls: [entry({ tool_kind: 'gradle', operation: 'allowed-task' })], summary: { ...validSidecar().summary, tool_calls_total: 1, shell_commands_total: 1 } });
      expect(validateAcceptedRunAuditSidecar(sidecar).errors).toEqual([]);
    });

    it('accepts gradle with operation exactly "other"', () => {
      const sidecar = validSidecar({ tool_calls: [entry({ tool_kind: 'gradle', operation: 'other' })], summary: { ...validSidecar().summary, tool_calls_total: 1, shell_commands_total: 1 } });
      expect(validateAcceptedRunAuditSidecar(sidecar).errors).toEqual([]);
    });

    it('rejects kmp-test with a null operation (basic shape -- membership is checked during cross-validation)', () => {
      const sidecar = validSidecar({ tool_calls: [entry({ tool_kind: 'kmp-test', operation: null })] });
      expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field.endsWith('.operation'))).toBe(true);
    });

    it('rejects kmp-test with a non-string (object) operation', () => {
      const sidecar = validSidecar({ tool_calls: [entry({ tool_kind: 'kmp-test', operation: { nope: true } })] });
      expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field.endsWith('.operation'))).toBe(true);
    });
  });

  // Phase correctness + summary recompute (review finding 1e/1f) -- previously only the
  // NULL-when-no-boundary direction was checked; the actual VALUE when a boundary exists (both
  // per-entry phase and the 3 boundary-dependent summary counts) was never cross-checked against
  // the tool_calls[] entries that are supposed to justify it.
  describe('phase correctness + post-signal summary recompute', () => {
    it('rejects any non-no-signal phase when there is no first_useful_signal_event boundary', () => {
      const sidecar = validSidecar({
        tool_calls: [{ ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'pre-signal' }],
        summary: { ...validSidecar().summary, tool_calls_total: 1, shell_commands_total: 1 },
      });
      expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field.includes('phase'))).toBe(true);
    });

    it('rejects a phase claiming pre-signal when the entry\'s own indices imply post-signal', () => {
      const sidecar = validSidecar({
        first_useful_signal_event: { type: 'user.tool_result', index: 2 },
        tool_calls: [
          { ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'produced-signal' },
          { ordinal: 1, tool_use_event_index: 5, tool_result_event_index: 6, tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'pre-signal' }, // WRONG -- should be post-signal
        ],
        summary: { ...validSidecar().summary, tool_calls_total: 2, shell_commands_total: 2, post_signal_tool_calls: 1 },
      });
      expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field.includes('phase'))).toBe(true);
    });

    it('rejects a first_useful_signal_event that does not correlate to any tool_calls[] entry\'s own result index', () => {
      const sidecar = validSidecar({
        first_useful_signal_event: { type: 'user.tool_result', index: 99 },
        tool_calls: [{ ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'post-signal' }],
        summary: { ...validSidecar().summary, tool_calls_total: 1, shell_commands_total: 1, post_signal_tool_calls: 1 },
      });
      expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field === 'first_useful_signal_event')).toBe(true);
    });

    it('rejects a post_signal_tool_calls count that does not match the actual post-signal entries', () => {
      const sidecar = validSidecar({
        first_useful_signal_event: { type: 'user.tool_result', index: 2 },
        tool_calls: [
          { ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'produced-signal' },
          { ordinal: 1, tool_use_event_index: 5, tool_result_event_index: 6, tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'post-signal' },
        ],
        summary: { ...validSidecar().summary, tool_calls_total: 2, shell_commands_total: 2, post_signal_tool_calls: 0 }, // should be 1
      });
      expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field === 'summary.post_signal_tool_calls')).toBe(true);
    });

    it('rejects a policy_denials_before/after_first_signal split that does not match the actual denied entries', () => {
      const sidecar = validSidecar({
        first_useful_signal_event: { type: 'user.tool_result', index: 2 },
        tool_calls: [
          { ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'produced-signal' },
          { ordinal: 1, tool_use_event_index: 5, tool_result_event_index: 6, tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'deny', result_status: 'success', phase: 'post-signal' },
        ],
        summary: { ...validSidecar().summary, tool_calls_total: 2, shell_commands_total: 2, post_signal_tool_calls: 1, policy_denials_total: 1, policy_denials_before_first_signal: 1, policy_denials_after_first_signal: 0 }, // swapped -- the real denial is AFTER, not before
      });
      expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field === 'summary.policy_denials_before_first_signal' || e.field === 'summary.policy_denials_after_first_signal')).toBe(true);
    });
  });

  // Accepted-sidecar invariant (review finding 1h) -- a sidecar only ever accompanies an ACCEPTED
  // run (see finalizeAndWriteMatrixRecords's gate-then-sidecar ordering), so an unresolved
  // ("missing") policy decision on it is itself a defect the sidecar must surface, never tolerate.
  it('rejects a non-zero policy_decisions_missing even when it correctly matches the actual missing-decision entries', () => {
    const sidecar = validSidecar({
      tool_calls: [{ ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'missing', result_status: 'success', phase: 'no-signal' }],
      summary: { ...validSidecar().summary, tool_calls_total: 1, shell_commands_total: 1, policy_decisions_missing: 1 },
    });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field === 'summary.policy_decisions_missing')).toBe(true);
  });
});

describe('crossValidateAcceptedRunAuditAgainstRecord', () => {
  it('returns no errors when a genuinely built sidecar is cross-validated against its own source record', () => {
    // post_signal_ms stays null here -- this test's synthetic events carry no real _receiptNs
    // tagging, so derivePostSignalMs() genuinely resolves to null on the sidecar's own
    // independently-recomputed side too; a real record.post_signal_ms.value MUST match whatever
    // the sidecar actually re-derives, not an arbitrarily hand-picked number.
    const record = baseRecord({ first_useful_signal_event: { type: 'user.tool_result', index: 2 }, tool_calls_total: { value: 1, reason: null }, shell_commands_total: { value: 1, reason: null }, post_signal_ms: { value: null, reason: 'not recorded' }, post_signal_tool_calls: { value: 0, reason: null }, policy_denials_before_first_signal: { value: 0, reason: null }, policy_denials_after_first_signal: { value: 0, reason: null } });
    const cr = conditionResultFrom([initEventStub(), bashToolUseEvent('t1', 'kmp-test parallel --module-filter shared --json'), toolResultEvent('t1'), resultEventStub()], { endedHrtimeNs: undefined });
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: 2, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    // Mirrors production ordering exactly: cli.mjs's buildSidecarsFn attaches the pointer (with the
    // BUILT sidecar's own schema) before finalizeAndWriteMatrixRecords cross-validates the pair.
    record.accepted_audit = { schema: sidecar.schema, relative_path: `audit/${record.run_id}.json`, sha256: 'f'.repeat(64) };
    expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record)).toEqual([]);
  });

  it('rejects a record pointing at a different sidecar schema than the sidecar itself carries', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), resultEventStub()], { endedHrtimeNs: undefined });
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    // baseRecord() is schema:5 -- the schema-aware builder emits v2 here (see the note on the first
    // test in this describe block for why this is not LATEST).
    expect(sidecar.schema).toBe(ACCEPTED_AUDIT_SIDECAR_SCHEMA_V2);

    // Record says v1, file on disk is v2.
    record.accepted_audit = { schema: ACCEPTED_AUDIT_SIDECAR_SCHEMA_V1, relative_path: `audit/${record.run_id}.json`, sha256: 'f'.repeat(64) };
    expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record).map((e) => e.field)).toContain('schema');

    // ...and the reverse: record says v2, file on disk is v1.
    record.accepted_audit.schema = ACCEPTED_AUDIT_SIDECAR_SCHEMA_V2;
    const v1Sidecar = { ...sidecar, schema: ACCEPTED_AUDIT_SIDECAR_SCHEMA_V1 };
    expect(crossValidateAcceptedRunAuditAgainstRecord(v1Sidecar, record).map((e) => e.field)).toContain('schema');
  });

  it('flags a run_id mismatch', () => {
    const record = baseRecord();
    const sidecar = { run_id: 'DIFFERENT', run_schema: 5, run_kind: 'scenario', condition: 'current-skill', scenario_id: record.scenario_id, first_useful_signal_event: null, summary: { tool_calls_total: 0, shell_commands_total: 0, post_signal_ms: null, post_signal_tool_calls: null, policy_denials_before_first_signal: null, policy_denials_after_first_signal: null } };
    expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record).some((e) => e.field === 'run_id')).toBe(true);
  });

  it('flags a first_useful_signal_event mismatch', () => {
    const record = baseRecord({ first_useful_signal_event: { type: 'user.tool_result', index: 2 } });
    const sidecar = { run_id: record.run_id, run_schema: 5, run_kind: 'scenario', condition: 'current-skill', scenario_id: record.scenario_id, first_useful_signal_event: null, summary: { tool_calls_total: 0, shell_commands_total: 0, post_signal_ms: null, post_signal_tool_calls: null, policy_denials_before_first_signal: null, policy_denials_after_first_signal: null } };
    expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record).some((e) => e.field === 'first_useful_signal_event')).toBe(true);
  });

  it('flags a summary metric that disagrees with the record\'s own metric value', () => {
    const record = baseRecord({ tool_calls_total: { value: 5, reason: null } });
    const sidecar = { run_id: record.run_id, run_schema: 5, run_kind: 'scenario', condition: 'current-skill', scenario_id: record.scenario_id, first_useful_signal_event: null, summary: { tool_calls_total: 1, shell_commands_total: 0, post_signal_ms: null, post_signal_tool_calls: null, policy_denials_before_first_signal: null, policy_denials_after_first_signal: null } };
    expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record).some((e) => e.field === 'summary.tool_calls_total')).toBe(true);
  });

  // Review finding 1g -- policy_denials_total (a real, independently re-derived count) previously
  // had no cross-check at all against the record's own hook_deny_count (a plain integer, not a
  // {value,reason} metric -- so it was never part of the existing recordMetric() comparison loop).
  it('flags a policy_denials_total that disagrees with the record\'s own hook_deny_count', () => {
    const record = baseRecord({ hook_deny_count: 99, hook_call_count: 99 });
    const sidecar = { run_id: record.run_id, run_schema: 5, run_kind: 'scenario', condition: 'current-skill', scenario_id: record.scenario_id, first_useful_signal_event: null, summary: { tool_calls_total: 0, shell_commands_total: 0, post_signal_ms: null, post_signal_tool_calls: null, policy_denials_before_first_signal: null, policy_denials_after_first_signal: null, policy_denials_total: 1 } };
    expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record).some((e) => e.field === 'summary.policy_denials_total')).toBe(true);
  });

  it('accepts a policy_denials_total that DOES match the record\'s own hook_deny_count', () => {
    const record = baseRecord({ hook_deny_count: 1, hook_call_count: 3 });
    const sidecar = { run_id: record.run_id, run_schema: 5, run_kind: 'scenario', condition: 'current-skill', scenario_id: record.scenario_id, first_useful_signal_event: null, summary: { tool_calls_total: 0, shell_commands_total: 0, post_signal_ms: null, post_signal_tool_calls: null, policy_denials_before_first_signal: null, policy_denials_after_first_signal: null, policy_denials_total: 1 } };
    expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record).some((e) => e.field === 'summary.policy_denials_total')).toBe(false);
  });

  // Review finding 1d -- kmp-test's operation membership against the record's OWN
  // policy_allowed_kmptest_subcommands allowlist can only be checked here (cross-validation),
  // never in the self-contained validator, which has no access to the record at all.
  describe('kmp-test operation membership against the record\'s own allowlist', () => {
    it('flags a kmp-test operation that is neither "other" nor a member of policy_allowed_kmptest_subcommands', () => {
      const record = baseRecord({ policy_allowed_kmptest_subcommands: ['doctor', 'describe'] });
      const sidecar = { run_id: record.run_id, run_schema: 5, run_kind: 'scenario', condition: 'current-skill', scenario_id: record.scenario_id, first_useful_signal_event: null, tool_calls: [{ ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'kmp-test', operation: 'clean', plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'no-signal' }], summary: { tool_calls_total: 1, shell_commands_total: 1, post_signal_ms: null, post_signal_tool_calls: null, policy_denials_before_first_signal: null, policy_denials_after_first_signal: null } };
      expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record).some((e) => e.field.includes('operation'))).toBe(true);
    });

    it('accepts a kmp-test operation that IS a member of policy_allowed_kmptest_subcommands', () => {
      const record = baseRecord({ policy_allowed_kmptest_subcommands: ['doctor', 'describe'] });
      const sidecar = { run_id: record.run_id, run_schema: 5, run_kind: 'scenario', condition: 'current-skill', scenario_id: record.scenario_id, first_useful_signal_event: null, tool_calls: [{ ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'kmp-test', operation: 'doctor', plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'no-signal' }], summary: { tool_calls_total: 1, shell_commands_total: 1, post_signal_ms: null, post_signal_tool_calls: null, policy_denials_before_first_signal: null, policy_denials_after_first_signal: null } };
      expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record).some((e) => e.field.includes('operation'))).toBe(false);
    });

    it('accepts a kmp-test operation of exactly "other" regardless of the allowlist', () => {
      const record = baseRecord({ policy_allowed_kmptest_subcommands: ['doctor', 'describe'] });
      const sidecar = { run_id: record.run_id, run_schema: 5, run_kind: 'scenario', condition: 'current-skill', scenario_id: record.scenario_id, first_useful_signal_event: null, tool_calls: [{ ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'kmp-test', operation: 'other', plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'no-signal' }], summary: { tool_calls_total: 1, shell_commands_total: 1, post_signal_ms: null, post_signal_tool_calls: null, policy_denials_before_first_signal: null, policy_denials_after_first_signal: null } };
      expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record).some((e) => e.field.includes('operation'))).toBe(false);
    });
  });

  // Review finding 5 -- defense in depth: crossValidateAcceptedRunAuditAgainstRecord must never
  // throw even when called directly (bypassing validateAcceptedAuditOnDisk's own
  // shape-check-then-skip guard) with a non-object sidecar. null is the concrete case that threw
  // (TypeError: Cannot read properties of null) via a bare `sidecar.run_id` dereference; scalars
  // and arrays are covered too since they're equally "not a real sidecar object".
  describe('defensive guard against a non-object sidecar (never throws)', () => {
    it.each([null, 42, 'a string', [], [1, 2, 3]])('does not throw when sidecar is %j', (badSidecar) => {
      const record = baseRecord();
      expect(() => crossValidateAcceptedRunAuditAgainstRecord(badSidecar, record)).not.toThrow();
    });

    it('returns a non-empty, structured error array (never silently empty) for a null sidecar', () => {
      const record = baseRecord();
      const errors = crossValidateAcceptedRunAuditAgainstRecord(null, record);
      expect(Array.isArray(errors)).toBe(true);
      expect(errors.length).toBeGreaterThan(0);
      for (const e of errors) {
        expect(typeof e.field).toBe('string');
        expect(typeof e.message).toBe('string');
      }
    });
  });
});

describe('finalizeAcceptedRunAuditSidecar -- validate -> redact -> revalidate -> hash', () => {
  it('returns ok:true with a redacted text and a real sha256 for a clean sidecar', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), resultEventStub()]);
    const built = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    const result = finalizeAcceptedRunAuditSidecar(built);
    expect(result.ok).toBe(true);
    expect(typeof result.redactedText).toBe('string');
    expect(/^[0-9a-f]{64}$/.test(result.sha256)).toBe(true);
  });

  it('the redacted text\'s own SHA-256 matches the returned sha256 exactly', async () => {
    const { createHash } = await import('node:crypto');
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), resultEventStub()]);
    const built = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    const result = finalizeAcceptedRunAuditSidecar(built);
    const recomputed = createHash('sha256').update(result.redactedText, 'utf8').digest('hex');
    expect(recomputed).toBe(result.sha256);
  });

  // Adversarial redaction proof: a supplied private-patterns rule matching content that genuinely
  // appears in the sidecar (scenario_id, a plain identifier -- not a raw command/path/skill name,
  // none of which the sidecar ever stores in the first place) is actually applied by
  // assertCleanOrThrowObject, and the validate -> redact -> revalidate cycle is genuinely exercised
  // end-to-end, not skipped.
  it('a supplied private-patterns rule is actually applied to sidecar content -- validate->redact->revalidate genuinely runs', async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'aera-privpat-'));
    try {
      const patternsFile = path.join(dir, 'patterns.json');
      writeFileSync(patternsFile, JSON.stringify([{ class: 'test_scenario_id', literal: 'kampkit-android-host-test-discovery', replacement: '<redacted-scenario>' }]));
      const record = baseRecord();
      const cr = conditionResultFrom([initEventStub(), resultEventStub()]);
      const built = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
      expect(built.scenario_id).toBe('kampkit-android-host-test-discovery');
      const result = finalizeAcceptedRunAuditSidecar(built, { privatePatternsFile: patternsFile });
      expect(result.ok).toBe(true);
      expect(result.redactedObj.scenario_id).not.toBe('kampkit-android-host-test-discovery');
      expect(result.redactedText).not.toContain('kampkit-android-host-test-discovery');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns ok:false (never throws) when the built sidecar itself fails its own schema validation', () => {
    const malformed = { schema: 1 }; // missing every other required key
    const result = finalizeAcceptedRunAuditSidecar(malformed);
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe('string');
  });
});

describe('buildAcceptedRunAuditSidecar -- schema:6 record produces a v3 sidecar', () => {
  it('stamps sidecar schema 3, run_schema 6, and a real run_provenance_sha256; keys are exactly the v1/v2 set plus run_provenance_sha256', () => {
    const record = v6Record();
    const cr = conditionResultFrom([initEventStub(), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    // PR 4: explicitly V3, never LATEST (now 4) -- this record's execution_profile.policy_mode is
    // "required" (v6Record()'s own default), so it must always produce v3, byte-identically,
    // regardless of what LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA happens to equal.
    expect(sidecar.schema).toBe(ACCEPTED_AUDIT_SIDECAR_SCHEMA_V3);
    expect(sidecar.schema).toBe(expectedAcceptedAuditSchemaFor(record));
    expect(sidecar.run_schema).toBe(6);
    expect(sidecar.run_provenance_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sidecar.run_provenance_sha256).toBe(computeRunProvenanceSha256(record));
    expect(Object.keys(sidecar).sort()).toEqual([
      'condition', 'first_useful_signal_event', 'run_id', 'run_kind', 'run_provenance_sha256',
      'run_schema', 'scenario_id', 'schema', 'summary', 'terminal_authoritative_event', 'tool_calls',
    ]);
  });

  it('the built sidecar validates with zero errors', () => {
    const record = v6Record();
    const cr = conditionResultFrom([initEventStub(), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors).toEqual([]);
  });

  it('accepts the same v3 sidecar shape for later runtime-neutral run schemas', () => {
    const record = v6Record({ schema: 7 });
    const cr = conditionResultFrom([initEventStub(), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.schema).toBe(ACCEPTED_AUDIT_SIDECAR_SCHEMA_V3);
    expect(sidecar.run_schema).toBe(7);
    expect(validateAcceptedRunAuditSidecar(sidecar).errors).toEqual([]);
    record.accepted_audit = { schema: sidecar.schema, relative_path: `audit/${record.run_id}.json`, sha256: 'f'.repeat(64) };
    expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record)).toEqual([]);
  });

  it('cross-validates with zero errors against its own source record (including run_provenance_sha256)', () => {
    const record = v6Record();
    const cr = conditionResultFrom([initEventStub(), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    record.accepted_audit = { schema: sidecar.schema, relative_path: `audit/${record.run_id}.json`, sha256: 'f'.repeat(64) };
    expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record)).toEqual([]);
  });
});

describe('validateAcceptedRunAuditSidecar -- v3-specific run_provenance_sha256 shape', () => {
  function v3Sidecar(overrides = {}) {
    const record = v6Record();
    const sidecar = buildAcceptedRunAuditSidecar({
      record, conditionResult: conditionResultFrom([initEventStub(), resultEventStub()]),
      terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
    });
    return { ...sidecar, ...overrides };
  }

  it('rejects a non-hex run_provenance_sha256', () => {
    const sidecar = v3Sidecar({ run_provenance_sha256: 'not-hex-at-all-'.repeat(5).slice(0, 64) });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field === 'run_provenance_sha256')).toBe(true);
  });

  it('rejects an uppercase run_provenance_sha256', () => {
    const sidecar = v3Sidecar({ run_provenance_sha256: 'A'.repeat(64) });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field === 'run_provenance_sha256')).toBe(true);
  });

  it('rejects a run_provenance_sha256 of the wrong length', () => {
    const sidecar = v3Sidecar({ run_provenance_sha256: 'a'.repeat(63) });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field === 'run_provenance_sha256')).toBe(true);
  });

  it('rejects a v3 sidecar missing run_provenance_sha256 entirely', () => {
    const sidecar = v3Sidecar();
    delete sidecar.run_provenance_sha256;
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field === 'run_provenance_sha256' || e.field === '(root)')).toBe(true);
  });

  it('rejects run_provenance_sha256 present on a v1 or v2 sidecar (unrecognized key)', () => {
    const record = baseRecord(); // schema:5
    const v2Sidecar = buildAcceptedRunAuditSidecar({
      record, conditionResult: conditionResultFrom([initEventStub(), resultEventStub()]),
      terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
    });
    const tampered = { ...v2Sidecar, run_provenance_sha256: 'a'.repeat(64) };
    expect(validateAcceptedRunAuditSidecar(tampered).errors.some((e) => e.field === '(root).run_provenance_sha256')).toBe(true);
  });
});

describe('computeRunProvenanceSha256 -- provenance hash sensitivity + stability', () => {
  it('changes when any ONE of the 11 non-schema bound fields changes', () => {
    const base = v6Record();
    const baseHash = computeRunProvenanceSha256(base);
    const mutations = {
      run_id: { ...base, run_id: 'scenario-current-skill-DIFFERENT' },
      run_kind: { ...base, run_kind: 'calibration' },
      condition: { ...base, condition: 'no-skill' },
      scenario_id: { ...base, scenario_id: 'a-different-scenario-id' },
      agent_runtime: { ...base, agent_runtime: { ...base.agent_runtime, cli_version: '9.9.9-different' } },
      execution_profile: { ...base, execution_profile: { ...base.execution_profile, sha256: 'f'.repeat(64) } },
      skill_observation: { ...base, skill_observation: { ...base.skill_observation, source_sha: 'f'.repeat(40) } },
      platform: { ...base, platform: 'linux' },
      repo_commit: { ...base, repo_commit: 'f'.repeat(40) },
      kmp_test_cli_source_sha: { ...base, kmp_test_cli_source_sha: 'f'.repeat(40) },
      project_commit: { ...base, project_commit: 'f'.repeat(40) },
    };
    for (const [field, mutated] of Object.entries(mutations)) {
      expect(computeRunProvenanceSha256(mutated), `mutating ${field} should change the provenance hash`).not.toBe(baseHash);
    }
  });

  it('does NOT change when a field outside the projection changes (wall_clock_ms, notes, errors)', () => {
    const base = v6Record();
    const baseHash = computeRunProvenanceSha256(base);
    const mutated = { ...base, wall_clock_ms: 999999, notes: 'a completely different note', errors: [{ code: 'something_else', message: 'x' }] };
    expect(computeRunProvenanceSha256(mutated)).toBe(baseHash);
  });

  it('is insensitive to the record\'s own accepted_audit field (avoids a hashing cycle -- the sidecar cannot bind its own not-yet-known sha256)', () => {
    const base = v6Record();
    const baseHash = computeRunProvenanceSha256(base);
    const mutated = { ...base, accepted_audit: { schema: 3, relative_path: 'audit/whatever.json', sha256: 'z'.repeat(64) } };
    expect(computeRunProvenanceSha256(mutated)).toBe(baseHash);
  });

  it('is insensitive to property insertion order (canonical JSON sorts object keys at every level)', () => {
    const base = v6Record();
    const baseHash = computeRunProvenanceSha256(base);
    const reordered = {};
    for (const k of Object.keys(base).reverse()) reordered[k] = base[k];
    reordered.agent_runtime = {};
    for (const k of Object.keys(base.agent_runtime).reverse()) reordered.agent_runtime[k] = base.agent_runtime[k];
    expect(computeRunProvenanceSha256(reordered)).toBe(baseHash);
  });
});

describe('crossValidateAcceptedRunAuditAgainstRecord -- run_provenance_sha256 (v3 only)', () => {
  it('accepts a v3 sidecar whose run_provenance_sha256 matches the recomputed value', () => {
    const record = v6Record();
    const cr = conditionResultFrom([initEventStub(), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record).some((e) => e.field === 'run_provenance_sha256')).toBe(false);
  });

  it('rejects a syntactically well-formed but WRONG run_provenance_sha256 -- self-consistent alone, but points at a different record', () => {
    const record = v6Record();
    const cr = conditionResultFrom([initEventStub(), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    // Individually well-formed (64 lowercase hex) -- passes validateAcceptedRunAuditSidecar's own
    // shape check in isolation -- but was not actually derived from THIS record (e.g. copied from a
    // sibling run's sidecar by mistake). Only the record-comparison half can catch this.
    const tamperedSidecar = { ...sidecar, run_provenance_sha256: '0'.repeat(64) };
    expect(validateAcceptedRunAuditSidecar(tamperedSidecar).errors).toEqual([]);
    const crossErrors = crossValidateAcceptedRunAuditAgainstRecord(tamperedSidecar, record);
    expect(crossErrors.some((e) => e.field === 'run_provenance_sha256')).toBe(true);
  });

  it('is not checked at all for a v1/v2 sidecar (no such field exists on the sidecar or the check)', () => {
    const record = baseRecord(); // schema:5
    const cr = conditionResultFrom([initEventStub(), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    record.accepted_audit = { schema: sidecar.schema, relative_path: `audit/${record.run_id}.json`, sha256: 'f'.repeat(64) };
    expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record).some((e) => e.field === 'run_provenance_sha256')).toBe(false);
  });
});

// PR coverage-outcome-observability: sidecar v8 is now the produced no-policy sidecar. v4-v7
// remain supported as frozen legacy no-policy sidecars.
describe('expectedAcceptedAuditSchemaFor -- explicit per-record/profile dispatch (Decision H)', () => {
  it('schema<6 always resolves to v2, regardless of any execution_profile content', () => {
    expect(expectedAcceptedAuditSchemaFor(baseRecord())).toBe(ACCEPTED_AUDIT_SIDECAR_SCHEMA_V2);
  });
  it('schema:6 with policy_mode:"required" (or execution_profile absent/malformed) resolves to v3', () => {
    expect(expectedAcceptedAuditSchemaFor(v6Record())).toBe(ACCEPTED_AUDIT_SIDECAR_SCHEMA_V3);
    expect(expectedAcceptedAuditSchemaFor({ schema: 6 })).toBe(ACCEPTED_AUDIT_SIDECAR_SCHEMA_V3);
  });
  it('schema:6 with policy_mode:"not_applicable" resolves to v9', () => {
    const record = v6Record({ execution_profile: { ...v6Record().execution_profile, policy_mode: 'not_applicable' } });
    expect(expectedAcceptedAuditSchemaFor(record)).toBe(ACCEPTED_AUDIT_SIDECAR_SCHEMA_V9);
  });
  it('never uses LATEST as a selector -- LATEST=10 today, but a required-policy schema:6 record still resolves to v3', () => {
    expect(LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA).toBe(10);
    expect(expectedAcceptedAuditSchemaFor(v6Record())).toBe(3);
  });
});

describe('buildAcceptedRunAuditSidecar / validateAcceptedRunAuditSidecar / crossValidateAcceptedRunAuditAgainstRecord -- sidecar v9 no-policy observability', () => {
  const FAKE_ATTESTATION_SHA256 = 'f'.repeat(64);

  // Mirrors what buildRunRecord (cli.mjs) actually produces for a policy_mode:"not_applicable"
  // record (Stage 4) -- hook_call_count/hook_deny_count/policy_allowed_* are null, never a real
  // (even trivially-zero) value; tool_calls_total/shell_commands_total default to 1 to match the
  // 1-Bash-call conditionResult this describe block's own helpers build by default.
  function notApplicableRecord(overrides = {}) {
    return v6Record({
      execution_profile: {
        ...v6Record().execution_profile,
        id: 'sandboxed-unrestricted-v1', policy_mode: 'not_applicable',
        isolation_attestation_sha256: FAKE_ATTESTATION_SHA256,
      },
      hook_call_count: null, hook_deny_count: null,
      policy_allowed_gradle_tasks: null, policy_allowed_kmptest_subcommands: null,
      tool_calls_total: { value: 1, reason: null }, shell_commands_total: { value: 1, reason: null },
      ...overrides,
    });
  }

  // A dispatchAccounting shaped the way buildBashDispatchAccounting's own not_applicable branch
  // produces it -- result_correlated_no_policy for a correlated Bash call.
  function notApplicableConditionResult(events) {
    const attempts = toolAttemptsFromEvents(events);
    const dispatchStatusByAttempt = new Map(
      attempts.filter((a) => a.kind === 'shell').map((a) => [a.id, a.result.found ? 'result_correlated_no_policy' : 'unaccounted']),
    );
    return conditionResultFrom(events, { decisionByAttempt: new Map(), dispatchAccounting: { dispatchStatusByAttempt } });
  }

  it('builds schema 9 with the 3 no-policy top-level fields, dispatch_unaccounted_total, structural recognized_operation, terminal_evidence, coverage_gate_diagnostic, and coverage_gate_attempts', () => {
    const record = notApplicableRecord();
    const cr = notApplicableConditionResult([initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.schema).toBe(ACCEPTED_AUDIT_SIDECAR_SCHEMA_V9);
    expect(sidecar.execution_profile_id).toBe('sandboxed-unrestricted-v1');
    expect(sidecar.policy_mode).toBe('not_applicable');
    expect(sidecar.isolation_attestation_sha256).toBe(FAKE_ATTESTATION_SHA256);
    expect(sidecar.run_provenance_sha256).toBe(computeRunProvenanceSha256(record));
    expect(sidecar.tool_calls[0].dispatch_status).toBe('result_correlated_no_policy');
    expect(sidecar.tool_calls[0].policy_decision).toBe('not-applicable');
    expect(sidecar.tool_calls[0].operation).toBe('other');
    expect(sidecar.tool_calls[0].recognized_operation).toBe('doctor');
    expect(sidecar.summary.dispatch_unaccounted_total).toBe(0);
    expect(sidecar.summary.policy_denials_total).toBeNull();
    expect(sidecar.summary.policy_decisions_missing).toBeNull();
    expect(sidecar.summary.policy_denials_before_first_signal).toBeNull();
    expect(sidecar.summary.policy_denials_after_first_signal).toBeNull();
    expect(sidecar.terminal_evidence).toEqual(terminalEvidence());
  });

  it('preserves the sole terminal timeout-truncated Bash result without treating it as unaccounted', () => {
    const record = notApplicableRecord();
    const events = [initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), resultEventStub()];
    const cr = conditionResultFrom(events, {
      decisionByAttempt: new Map(),
      dispatchAccounting: { dispatchStatusByAttempt: new Map([['t1', 'timeout_interrupted_no_policy']]) },
    });
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });

    expect(sidecar.tool_calls[0]).toMatchObject({
      dispatch_status: 'timeout_interrupted_no_policy',
      policy_decision: 'not-applicable',
      result_status: 'missing',
      tool_result_event_index: null,
    });
    expect(sidecar.summary.dispatch_unaccounted_total).toBe(0);
    expect(validateAcceptedRunAuditSidecar(sidecar).errors).toEqual([]);
  });

  it('rejects timeout_interrupted_no_policy when its result is present', () => {
    const record = notApplicableRecord();
    const events = [initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()];
    const cr = conditionResultFrom(events, {
      decisionByAttempt: new Map(),
      dispatchAccounting: { dispatchStatusByAttempt: new Map([['t1', 'timeout_interrupted_no_policy']]) },
    });
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });

    expect(validateAcceptedRunAuditSidecar(sidecar).errors).toContainEqual(expect.objectContaining({ field: 'tool_calls[0].result_status' }));
  });

  it('keeps no-policy operation allowlist-neutral while exposing a privacy-safe recognized kmp-test subcommand', () => {
    const record = notApplicableRecord();
    const cr = notApplicableConditionResult([
      initEventStub(),
      bashToolUseEvent('t1', 'kmp-test parallel --module-filter secretmodule123 --json'),
      toolResultEvent('t1'),
      bashToolUseEvent('t2', 'kmp-test describe --project-root C:/secret/project --json'),
      toolResultEvent('t2'),
      resultEventStub(),
    ]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });

    expect(sidecar.schema).toBe(ACCEPTED_AUDIT_SIDECAR_SCHEMA_V9);
    expect(sidecar.tool_calls[0]).toMatchObject({ tool_kind: 'kmp-test', operation: 'other', recognized_operation: 'parallel' });
    expect(sidecar.tool_calls[1]).toMatchObject({ tool_kind: 'kmp-test', operation: 'other', recognized_operation: 'describe' });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors).toEqual([]);
    expect(JSON.stringify(sidecar)).not.toContain('secretmodule123');
    expect(JSON.stringify(sidecar)).not.toContain('--module-filter');
    expect(JSON.stringify(sidecar)).not.toContain('C:/secret/project');
  });

  it('accepts schema 9 coverage_gate_attempts with closed privacy-safe error buckets', () => {
    const record = notApplicableRecord();
    const cr = notApplicableConditionResult([
      initEventStub(),
      bashToolUseEvent('t1', 'kmp-test parallel --module-filter secretmodule123 --min-missed-lines 15 --json'),
      toolResultEvent('t1'),
      resultEventStub(),
    ]);
    const terminal = terminalEvidence({
      tool_result_event_index: 2,
      coverage_gate_diagnostic: 'matched',
      coverage_gate_attempts: [{
        tool_result_event_index: 2,
        recognized_operation: 'parallel',
        terminal_authoritative: true,
        canonicalization_status: 'canonical',
        canonicalization_reason: 'canonical',
        threshold_relation: 'matches',
        tests_contract: 'matches',
        coverage_contract: 'matches',
        error_contract: 'matches',
        exit_code_contract: 'matches',
        error_count: 1,
        error_code_buckets: {
          coverage_threshold_exceeded: 1,
          module_failed: 0,
          gradle_timeout: 0,
          no_test_modules: 0,
          environment_other: 0,
          configuration: 0,
          other: 0,
        },
        target_matches_expected: true,
        observed_outcome_kind: 'coverage_threshold_exceeded',
        outcome_matches_expected: true,
      }],
      final_answer_block: {
        ...terminalEvidence().final_answer_block,
        comparison_status: 'matched',
        declared_outcome_kind: 'coverage_threshold_exceeded',
        observed_outcome_kind: 'coverage_threshold_exceeded',
      },
    });
    const sidecar = buildAcceptedRunAuditSidecar({
      record, conditionResult: cr, terminalAuthoritativeEventIndex: 2, terminalEvidence: terminal,
      targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
    });
    expect(sidecar.terminal_evidence.coverage_gate_attempts).toEqual([{
      tool_call_ordinal: 0,
      recognized_operation: 'parallel',
      terminal_authoritative: true,
      canonicalization_status: 'canonical',
      canonicalization_reason: 'canonical',
      threshold_relation: 'matches',
      tests_contract: 'matches',
      coverage_contract: 'matches',
      error_contract: 'matches',
      exit_code_contract: 'matches',
      error_count: 1,
      error_code_buckets: {
        coverage_threshold_exceeded: 1,
        module_failed: 0,
        gradle_timeout: 0,
        no_test_modules: 0,
        environment_other: 0,
        configuration: 0,
        other: 0,
      },
      target_matches_expected: true,
      observed_outcome_kind: 'coverage_threshold_exceeded',
      outcome_matches_expected: true,
    }]);
    expect(validateAcceptedRunAuditSidecar(sidecar).errors).toEqual([]);
    expect(JSON.stringify(sidecar)).not.toContain('secretmodule123');
    expect(JSON.stringify(sidecar)).not.toContain('--min-missed-lines');
  });

  it.each([
    ['a partial null pair', (attempt) => { attempt.error_code_buckets = null; }],
    ['a negative bucket', (attempt) => { attempt.error_code_buckets.module_failed = -1; }],
    ['a bucket sum different from error_count', (attempt) => { attempt.error_count = 2; }],
    ['an unknown bucket without echoing its private key', (attempt) => { attempt.error_code_buckets.private_secret_code = 1; }],
  ])('rejects schema 9 error summaries with %s', (_label, mutate) => {
    const record = notApplicableRecord();
    const cr = notApplicableConditionResult([
      initEventStub(),
      bashToolUseEvent('t1', 'kmp-test parallel --min-missed-lines 15 --json'),
      toolResultEvent('t1'),
      resultEventStub(),
    ]);
    const sidecar = buildAcceptedRunAuditSidecar({
      record,
      conditionResult: cr,
      terminalAuthoritativeEventIndex: 2,
      terminalEvidence: terminalEvidence({
        coverage_gate_attempts: [{
          tool_result_event_index: 2,
          recognized_operation: 'parallel',
          terminal_authoritative: true,
          canonicalization_status: 'canonical',
          canonicalization_reason: 'canonical',
          threshold_relation: 'matches',
          tests_contract: 'matches',
          coverage_contract: 'matches',
          error_contract: 'matches',
          exit_code_contract: 'matches',
          error_count: 1,
          error_code_buckets: {
            coverage_threshold_exceeded: 1,
            module_failed: 0,
            gradle_timeout: 0,
            no_test_modules: 0,
            environment_other: 0,
            configuration: 0,
            other: 0,
          },
          target_matches_expected: true,
          observed_outcome_kind: 'coverage_threshold_exceeded',
          outcome_matches_expected: true,
        }],
      }),
      targetPluginName: TARGET_PLUGIN_NAME,
      targetSkillName: TARGET_SKILL_NAME,
    });

    mutate(sidecar.terminal_evidence.coverage_gate_attempts[0]);
    const serializedErrors = JSON.stringify(validateAcceptedRunAuditSidecar(sidecar).errors);
    expect(serializedErrors).not.toBe('[]');
    expect(serializedErrors).not.toContain('private_secret_code');
  });

  it('preserves a typed uncanonicalizable reason without copying private attempt data', () => {
    const record = notApplicableRecord();
    const cr = notApplicableConditionResult([
      initEventStub(),
      bashToolUseEvent('t1', 'kmp-test parallel --module-filter secretmodule123 --min-missed-lines 15 --json'),
      toolResultEvent('t1'),
      resultEventStub(),
    ]);
    const sidecar = buildAcceptedRunAuditSidecar({
      record,
      conditionResult: cr,
      terminalAuthoritativeEventIndex: 2,
      terminalEvidence: terminalEvidence({
        coverage_gate_attempts: [{
          tool_result_event_index: 2,
          recognized_operation: 'parallel',
          terminal_authoritative: true,
          canonicalization_status: 'uncanonicalizable',
          canonicalization_reason: 'coverage-block-incoherent',
          threshold_relation: 'matches',
          tests_contract: 'matches',
          coverage_contract: 'differs',
          error_contract: 'matches',
          exit_code_contract: 'matches',
          error_count: 1,
          error_code_buckets: {
            coverage_threshold_exceeded: 1,
            module_failed: 0,
            gradle_timeout: 0,
            no_test_modules: 0,
            environment_other: 0,
            configuration: 0,
            other: 0,
          },
          target_matches_expected: true,
          observed_outcome_kind: null,
          outcome_matches_expected: false,
        }],
      }),
      targetPluginName: TARGET_PLUGIN_NAME,
      targetSkillName: TARGET_SKILL_NAME,
    });

    expect(sidecar.terminal_evidence.coverage_gate_attempts[0].canonicalization_reason).toBe('coverage-block-incoherent');
    expect(validateAcceptedRunAuditSidecar(sidecar).errors).toEqual([]);
    expect(JSON.stringify(sidecar)).not.toContain('secretmodule123');
    expect(JSON.stringify(sidecar)).not.toContain('--min-missed-lines');
  });

  it('rejects stale coverage_gate_attempts fields from the pre-v8 draft shape', () => {
    const record = notApplicableRecord();
    const cr = notApplicableConditionResult([initEventStub(), bashToolUseEvent('t1', 'kmp-test parallel --json'), toolResultEvent('t1'), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({
      record, conditionResult: cr, terminalAuthoritativeEventIndex: 2,
      terminalEvidence: terminalEvidence({
        coverage_gate_attempts: [{
          tool_result_event_index: 2,
          recognized_operation: 'parallel',
          terminal_authoritative: true,
          canonicalization_status: 'canonical',
          canonicalization_reason: 'canonical',
          threshold_relation: 'matches',
          tests_contract: 'matches',
          coverage_contract: 'matches',
          error_contract: 'matches',
          exit_code_contract: 'matches',
          target_matches_expected: true,
          observed_outcome_kind: 'coverage_threshold_exceeded',
          outcome_matches_expected: true,
        }],
      }),
      targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
    });
    sidecar.terminal_evidence.coverage_gate_attempts[0].coverage_disabled = false;
    sidecar.terminal_evidence.coverage_gate_attempts[0].canonicalization_status = 'canonicalized';
    const errors = validateAcceptedRunAuditSidecar(sidecar).errors;
    expect(errors.some((e) => e.field === 'terminal_evidence.coverage_gate_attempts[0].coverage_disabled')).toBe(true);
    expect(errors.some((e) => e.field === 'terminal_evidence.coverage_gate_attempts[0].canonicalization_status')).toBe(true);
  });

  it('maps unknown kmp-test subcommands to the closed structural "other" bucket, never the raw token', () => {
    const record = notApplicableRecord();
    const cr = notApplicableConditionResult([initEventStub(), bashToolUseEvent('t1', 'kmp-test private-secret-subcommand --json'), toolResultEvent('t1'), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0]).toMatchObject({ tool_kind: 'kmp-test', operation: 'other', recognized_operation: 'other' });
    expect(JSON.stringify(sidecar)).not.toContain('private-secret-subcommand');
  });

  it('still accepts frozen legacy v4-v8 sidecars without widening their closed contracts', () => {
    const record = notApplicableRecord();
    const cr = notApplicableConditionResult([initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    const legacyV4 = {
      ...sidecar,
      schema: ACCEPTED_AUDIT_SIDECAR_SCHEMA_V4,
    };
    delete legacyV4.terminal_evidence;
    legacyV4.tool_calls = sidecar.tool_calls.map(({ recognized_operation: _recognizedOperation, ...tc }) => tc);
    const legacyV5 = { ...sidecar, schema: ACCEPTED_AUDIT_SIDECAR_SCHEMA_V5 };
    delete legacyV5.terminal_evidence;
    const legacyV6 = {
      ...sidecar,
      schema: ACCEPTED_AUDIT_SIDECAR_SCHEMA_V6,
      terminal_evidence: { ...sidecar.terminal_evidence, final_answer_block: { ...sidecar.terminal_evidence.final_answer_block } },
    };
    delete legacyV6.terminal_evidence.coverage_gate_diagnostic;
    delete legacyV6.terminal_evidence.coverage_gate_attempts;
    delete legacyV6.terminal_evidence.final_answer_block.comparison_status;
    delete legacyV6.terminal_evidence.final_answer_block.declared_outcome_kind;
    delete legacyV6.terminal_evidence.final_answer_block.observed_outcome_kind;
    delete legacyV6.terminal_evidence.final_answer_block.missing_fields;
    delete legacyV6.terminal_evidence.final_answer_block.mismatch_fields;
    delete legacyV6.terminal_evidence.final_answer_block.unexpected_key_count;
    const legacyV7 = {
      ...sidecar,
      schema: ACCEPTED_AUDIT_SIDECAR_SCHEMA_V7,
      terminal_evidence: { ...sidecar.terminal_evidence, final_answer_block: { ...sidecar.terminal_evidence.final_answer_block } },
    };
    delete legacyV7.terminal_evidence.coverage_gate_attempts;
    delete legacyV7.terminal_evidence.final_answer_block.comparison_status;
    delete legacyV7.terminal_evidence.final_answer_block.declared_outcome_kind;
    delete legacyV7.terminal_evidence.final_answer_block.observed_outcome_kind;
    delete legacyV7.terminal_evidence.final_answer_block.missing_fields;
    delete legacyV7.terminal_evidence.final_answer_block.mismatch_fields;
    delete legacyV7.terminal_evidence.final_answer_block.unexpected_key_count;
    const legacyV8 = {
      ...sidecar,
      schema: ACCEPTED_AUDIT_SIDECAR_SCHEMA_V8,
      terminal_evidence: {
        ...sidecar.terminal_evidence,
        coverage_gate_attempts: sidecar.terminal_evidence.coverage_gate_attempts.map(({ error_count: _errorCount, error_code_buckets: _errorCodeBuckets, ...attempt }) => attempt),
      },
    };
    expect(validateAcceptedRunAuditSidecar(legacyV4).errors).toEqual([]);
    expect(validateAcceptedRunAuditSidecar(legacyV5).errors).toEqual([]);
    expect(validateAcceptedRunAuditSidecar(legacyV6).errors).toEqual([]);
    expect(validateAcceptedRunAuditSidecar(legacyV7).errors).toEqual([]);
    expect(validateAcceptedRunAuditSidecar(legacyV8).errors).toEqual([]);
  });

  it('rejects terminal_evidence keys outside the closed privacy-safe schema', () => {
    const record = notApplicableRecord();
    const cr = notApplicableConditionResult([initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({
      record, conditionResult: cr, terminalAuthoritativeEventIndex: null,
      terminalEvidence: terminalEvidence({ command_text: 'kmp-test parallel --module-filter secretmodule123' }),
      targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
    });
    const errors = validateAcceptedRunAuditSidecar(sidecar).errors;
    expect(errors.some((e) => e.field === 'terminal_evidence.command_text')).toBe(true);
    expect(JSON.stringify({ errors })).not.toContain('secretmodule123');
  });

  it('rejects a coverage_gate_diagnostic outside the closed privacy-safe vocabulary', () => {
    const record = notApplicableRecord();
    const cr = notApplicableConditionResult([initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({
      record, conditionResult: cr, terminalAuthoritativeEventIndex: null,
      terminalEvidence: terminalEvidence({ coverage_gate_diagnostic: 'raw command said secretmodule123' }),
      targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
    });
    const errors = validateAcceptedRunAuditSidecar(sidecar).errors;
    expect(errors.some((e) => e.field === 'terminal_evidence.coverage_gate_diagnostic')).toBe(true);
    expect(JSON.stringify({ errors })).not.toContain('secretmodule123');
  });

  it('rejects observed_result payload fields that would smuggle path or module prose', () => {
    const record = notApplicableRecord();
    const cr = notApplicableConditionResult([initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({
      record, conditionResult: cr, terminalAuthoritativeEventIndex: null,
      terminalEvidence: terminalEvidence({
        observed_result: { ...terminalEvidence().observed_result, module: 'secretmodule123', project_root: 'C:/secret/project' },
      }),
      targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
    });
    const errors = validateAcceptedRunAuditSidecar(sidecar).errors;
    expect(errors.some((e) => e.field === 'terminal_evidence.observed_result.module')).toBe(true);
    expect(errors.some((e) => e.field === 'terminal_evidence.observed_result.project_root')).toBe(true);
    expect(JSON.stringify({ errors })).not.toContain('secretmodule123');
    expect(JSON.stringify({ errors })).not.toContain('C:/secret/project');
  });

  it('rejects present:false terminal_evidence when observed_result is not null', () => {
    const record = notApplicableRecord();
    const cr = notApplicableConditionResult([initEventStub(), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({
      record, conditionResult: cr, terminalAuthoritativeEventIndex: null,
      terminalEvidence: terminalEvidence({
        present: false,
        provider: null,
        tool_result_event_index: null,
        evidence_well_formed: false,
        target_matches_expected: null,
        outcome_matches_expected: null,
        malformed: null,
        parallel_evidence_invalid: null,
        changed_evidence_invalid: null,
      }),
      targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
    });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field === 'terminal_evidence.observed_result')).toBe(true);
  });

  it('rejects a schema 7 recognized_operation outside the closed privacy-safe vocabulary', () => {
    const record = notApplicableRecord();
    const cr = notApplicableConditionResult([initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    const tampered = { ...sidecar, tool_calls: [{ ...sidecar.tool_calls[0], recognized_operation: 'secretmodule123' }] };
    expect(validateAcceptedRunAuditSidecar(tampered).errors.some((e) => e.field.endsWith('.recognized_operation'))).toBe(true);
  });

  it('validates with zero errors, and cross-validates cleanly against the record', () => {
    const record = notApplicableRecord();
    const cr = notApplicableConditionResult([initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(validateAcceptedRunAuditSidecar(sidecar).errors).toEqual([]);
    record.accepted_audit = { schema: sidecar.schema, relative_path: `audit/${record.run_id}.json`, sha256: 'f'.repeat(64) };
    expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record)).toEqual([]);
  });

  it('a decisionByAttempt claiming "allow" (junit-evidence.mjs\'s own internal synthesis) never leaks into policy_decision -- stays exactly not-applicable', () => {
    const record = notApplicableRecord();
    const events = [initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()];
    const cr = conditionResultFrom(events, {
      decisionByAttempt: new Map([['t1', 'allow']]),
      dispatchAccounting: { dispatchStatusByAttempt: new Map([['t1', 'result_correlated_no_policy']]) },
    });
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0].policy_decision).toBe('not-applicable');
  });

  it('a missing result (unaccounted) is rejected -- dispatch_unaccounted_total must be exactly 0 for an accepted sidecar', () => {
    const record = notApplicableRecord();
    const events = [initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), resultEventStub()]; // no toolResultEvent -- missing result
    const cr = notApplicableConditionResult(events);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0].dispatch_status).toBe('unaccounted');
    expect(sidecar.tool_calls[0].policy_decision).toBe('not-applicable');
    expect(sidecar.summary.dispatch_unaccounted_total).toBe(1);
    const errors = validateAcceptedRunAuditSidecar(sidecar).errors;
    expect(errors.some((e) => e.field === 'summary.dispatch_unaccounted_total')).toBe(true);
  });

  it('hook_evaluated can never appear on a v6 sidecar, even if fabricated directly', () => {
    const record = notApplicableRecord();
    const cr = notApplicableConditionResult([initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    const tampered = { ...sidecar, tool_calls: [{ ...sidecar.tool_calls[0], dispatch_status: 'hook_evaluated', policy_decision: 'allow' }] };
    expect(validateAcceptedRunAuditSidecar(tampered).errors.some((e) => e.field.endsWith('.dispatch_status'))).toBe(true);
  });

  it('a real result_correlated_no_policy Bash entry is rejected on a v1/v2/v3 sidecar', () => {
    const record = v6Record(); // policy_mode:"required" -- produces v3
    const cr = conditionResultFrom(
      [initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()],
      { decisionByAttempt: new Map([['t1', 'allow']]), dispatchAccounting: { dispatchStatusByAttempt: new Map([['t1', 'result_correlated_no_policy']]) } },
    );
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.schema).toBe(ACCEPTED_AUDIT_SIDECAR_SCHEMA_V3);
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field.endsWith('.dispatch_status'))).toBe(true);
  });

  it('a timeout_interrupted_no_policy Bash entry is rejected on a v1/v2/v3 sidecar', () => {
    const record = v6Record();
    const cr = conditionResultFrom(
      [initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), resultEventStub()],
      { decisionByAttempt: new Map(), dispatchAccounting: { dispatchStatusByAttempt: new Map([['t1', 'timeout_interrupted_no_policy']]) } },
    );
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });

    expect(sidecar.schema).toBe(ACCEPTED_AUDIT_SIDECAR_SCHEMA_V3);
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field.endsWith('.dispatch_status'))).toBe(true);
  });

  for (const field of ['execution_profile_id', 'policy_mode', 'isolation_attestation_sha256']) {
    it(`cross-validation rejects a mismatched ${field}`, () => {
      const record = notApplicableRecord();
      const cr = notApplicableConditionResult([initEventStub(), resultEventStub()]);
      const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
      const tampered = { ...sidecar, [field]: field === 'policy_mode' ? 'required' : field === 'execution_profile_id' ? 'strict-policy-v1' : 'a'.repeat(64) };
      expect(crossValidateAcceptedRunAuditAgainstRecord(tampered, record).some((e) => e.field === field)).toBe(true);
    });
  }

  it('a schema:6 policy-required record never produces a no-policy sidecar, even with a real Bash attempt', () => {
    const record = v6Record();
    const cr = conditionResultFrom(
      [initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()],
      { decisionByAttempt: new Map([['t1', 'allow']]) },
    );
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, terminalEvidence: terminalEvidence(), targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.schema).toBe(ACCEPTED_AUDIT_SIDECAR_SCHEMA_V3);
    expect(sidecar).not.toHaveProperty('execution_profile_id');
    expect(sidecar).not.toHaveProperty('policy_mode');
    expect(sidecar).not.toHaveProperty('isolation_attestation_sha256');
  });
});

// Evidence1 success-recovery PR B, Stage B2 (docs/audits/agentic-eval-evidence1-success-recovery-
// v1-runbook.md, Section 9.11): accepted sidecar schema 10 -- requirement 4 (schema 10 projects
// BOTH the record's own outcome_assessment object AND the new common observability summary, for
// BOTH policy modes) and requirement 7 (accepted and rejected diagnostics share the exact same
// closed enums -- imported here from the single authorized module, coverage-gate-observability.mjs,
// never a second independently-maintained copy; see agentic-eval-coverage-gate-observability.test.js
// for that module's own direct tests). Deliberately contrasts with the v3 test just above: unlike
// v3 (policy-required, fields absent entirely), schema 10 is self-describing in BOTH policy modes.
//
// Review-round finding: the schema:8 fixtures below MUST be records `validateRun` (schemas.mjs)
// would actually accept -- v6Record()'s default run_kind is 'scenario' (this whole file's own
// domain), so schema 8 REQUIRES a real, non-null outcome_assessment object (never omitted); a
// calibration-shaped fixture would instead require outcome_assessment:null explicitly. Building
// sidecars from a run-record shape `validateRun` would itself reject proves nothing about how the
// real pipeline behaves.
describe('accepted sidecar schema 10 (Evidence1 success-recovery PR B, Section 9.4.3/9.9) -- any policy_mode, run schema 8+', () => {
  const FAKE_ATTESTATION_SHA256_V10 = 'f'.repeat(64);
  const REAL_OUTCOME_ASSESSMENT = Object.freeze({
    schema: 1, task_outcome_matched: true, task_outcome_reason: 'matched',
    answer_protocol_matched: true, provider_evidence_kind: 'kmp-test-envelope',
    provider_evidence_status: 'matched', product_e2e_success: true,
  });

  function schema8PolicyRequiredRecord(overrides = {}) {
    return v6Record({ schema: 8, outcome_assessment: REAL_OUTCOME_ASSESSMENT, ...overrides });
  }
  function schema8NotApplicableRecord(overrides = {}) {
    return v6Record({
      schema: 8, outcome_assessment: REAL_OUTCOME_ASSESSMENT,
      execution_profile: {
        ...v6Record().execution_profile,
        id: 'sandboxed-unrestricted-v1', policy_mode: 'not_applicable',
        isolation_attestation_sha256: FAKE_ATTESTATION_SHA256_V10,
      },
      hook_call_count: null, hook_deny_count: null,
      policy_allowed_gradle_tasks: null, policy_allowed_kmptest_subcommands: null,
      ...overrides,
    });
  }
  function minimalConditionResult() {
    return conditionResultFrom(
      [initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()],
      { decisionByAttempt: new Map([['t1', 'allow']]) },
    );
  }
  function buildFor(record, terminal = terminalEvidence(), conditionResult = minimalConditionResult()) {
    return buildAcceptedRunAuditSidecar({
      record, conditionResult, terminalAuthoritativeEventIndex: null,
      terminalEvidence: terminal, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
    });
  }

  it('expectedAcceptedAuditSchemaFor resolves schema:8 to 10 for BOTH policy_mode values, checked before the policy_mode dispatch', () => {
    expect(expectedAcceptedAuditSchemaFor(schema8PolicyRequiredRecord())).toBe(10);
    expect(expectedAcceptedAuditSchemaFor(schema8NotApplicableRecord())).toBe(10);
  });

  it('never uses LATEST as a selector -- a schema:8 record resolves to exactly 10 regardless of LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA\'s own value', () => {
    expect(expectedAcceptedAuditSchemaFor(schema8PolicyRequiredRecord())).toBe(10);
  });

  it('builds schema 10 for a policy-required schema:8 record WITH execution_profile_id/policy_mode/isolation_attestation_sha256 present -- unlike v3, schema 10 is self-describing regardless of policy mode', () => {
    const sidecar = buildFor(schema8PolicyRequiredRecord());
    expect(sidecar.schema).toBe(10);
    expect(sidecar.execution_profile_id).toBe('strict-policy-v1');
    expect(sidecar.policy_mode).toBe('required');
    expect(sidecar.isolation_attestation_sha256).toBeNull();
  });

  it('builds schema 10 for a not_applicable schema:8 record with a real isolation_attestation_sha256', () => {
    const sidecar = buildFor(schema8NotApplicableRecord());
    expect(sidecar.schema).toBe(10);
    expect(sidecar.execution_profile_id).toBe('sandboxed-unrestricted-v1');
    expect(sidecar.policy_mode).toBe('not_applicable');
    expect(sidecar.isolation_attestation_sha256).toBe(FAKE_ATTESTATION_SHA256_V10);
  });

  // Requirement 4 (review-round finding): schema 10 projects the record's OWN outcome_assessment
  // object verbatim -- entirely structural/closed-vocabulary by its own schema design (9.5), so a
  // straight passthrough carries zero privacy risk, unlike terminal_evidence's raw content.
  it.each(['policy-required', 'not_applicable'])('preserves the record\'s own outcome_assessment object verbatim (%s)', (mode) => {
    const record = mode === 'policy-required' ? schema8PolicyRequiredRecord() : schema8NotApplicableRecord();
    const sidecar = buildFor(record);
    expect(sidecar.outcome_assessment).toEqual(REAL_OUTCOME_ASSESSMENT);
  });

  it('every schema:10 sidecar carries its own outcome_observability_summary object, in both policy modes', () => {
    for (const record of [schema8PolicyRequiredRecord(), schema8NotApplicableRecord()]) {
      const sidecar = buildFor(record);
      expect(sidecar.outcome_observability_summary).toBeTruthy();
      expect(sidecar.outcome_observability_summary.schema).toBe(1);
      expect(validateOutcomeObservabilitySummary(sidecar.outcome_observability_summary, 'outcome_observability_summary')).toEqual([]);
    }
  });

  // Requirement 2/7 (review-round finding): every allowed enum value is genuinely ACCEPTED by
  // THIS file's real validator (not merely a member of a locally-duplicated array), and one
  // unrecognized value is genuinely REJECTED -- both checked against the single shared module
  // both accepted-run-audit.mjs and rejection-diagnostics.mjs import from, so the two consumers
  // can never silently diverge on vocabulary.
  const ENUM_FIELDS = [
    ['flavor_relation', FLAVOR_RELATION_VALUES],
    ['test_type_relation', TEST_TYPE_RELATION_VALUES],
    ['coverage_target_status', COVERAGE_TARGET_STATUS_VALUES],
    ['coverage_report_status', COVERAGE_REPORT_STATUS_VALUES],
  ];
  for (const [field, values] of ENUM_FIELDS) {
    // A single test with an internal loop, not it.each(values) -- values is undefined until
    // coverage-gate-observability.mjs actually exports it, and it.each(undefined) would crash
    // this whole FILE at collection time (before any test runs), taking every one of this file's
    // 125+ pre-existing tests down with it. A for-of over undefined throws INSIDE this one test
    // body instead -- a clean, isolated RED failure.
    it(`${field} accepts every allowed value once forced into the built sidecar`, () => {
      for (const value of values) {
        const sidecar = buildFor(schema8PolicyRequiredRecord(), null);
        sidecar.outcome_observability_summary[field] = value;
        expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field.endsWith(field))).toBe(false);
      }
    });
    it(`validateAcceptedRunAuditSidecar rejects an unrecognized ${field}`, () => {
      const sidecar = buildFor(schema8PolicyRequiredRecord(), null);
      sidecar.outcome_observability_summary[field] = 'totally-not-a-real-value';
      expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field.endsWith(field))).toBe(true);
    });
  }

  it('execution_mode_counts falls back to a closed map keyed by Section 9.9\'s enum, all zero, when no source data exists', () => {
    const sidecar = buildFor(schema8PolicyRequiredRecord(), null);
    expect(sidecar.outcome_observability_summary.execution_mode_counts).toEqual(
      Object.fromEntries(EXECUTION_MODE_VALUES.map((v) => [v, 0])),
    );
  });

  it('warning_code_counts is a closed map of exactly the approved coverage warning codes to non-negative integers', () => {
    const sidecar = buildFor(schema8PolicyRequiredRecord(), null);
    expect(Object.keys(sidecar.outcome_observability_summary.warning_code_counts).sort()).toEqual(COVERAGE_GATE_WARNING_BUCKET_FIELDS.slice().sort());
  });

  it('module_failed_setup_count is a non-negative integer or null when no source data exists', () => {
    const sidecar = buildFor(schema8PolicyRequiredRecord(), null);
    const value = sidecar.outcome_observability_summary.module_failed_setup_count;
    expect(value === null || (Number.isInteger(value) && value >= 0)).toBe(true);
  });

  // Requirement 9: counts negativos o floats se rechazan (via the shared validator, exercised
  // through this file's own validateAcceptedRunAuditSidecar).
  it.each([-1, 1.5, '2', true])('validateAcceptedRunAuditSidecar rejects a module_failed_setup_count of %j', (bad) => {
    const sidecar = buildFor(schema8PolicyRequiredRecord(), null);
    sidecar.outcome_observability_summary.module_failed_setup_count = bad;
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field.includes('module_failed_setup_count'))).toBe(true);
  });

  it.each([-1, 1.5, '2', true])('validateAcceptedRunAuditSidecar rejects a warning_code_counts entry of %j', (bad) => {
    const sidecar = buildFor(schema8PolicyRequiredRecord(), null);
    sidecar.outcome_observability_summary.warning_code_counts.coverage_xml_disabled = bad;
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field.includes('warning_code_counts'))).toBe(true);
  });

  it('validateAcceptedRunAuditSidecar rejects an unrecognized key inside outcome_observability_summary', () => {
    const sidecar = buildFor(schema8PolicyRequiredRecord(), null);
    sidecar.outcome_observability_summary.raw_command = 'kmp-test parallel --module-filter secret';
    expect(validateAcceptedRunAuditSidecar(sidecar).errors.some((e) => e.field.includes('outcome_observability_summary'))).toBe(true);
  });

  // Requirement 8 (review-round finding, corrected): this file's own terminalEvidence() fixture
  // has NO final_answer_block.detail field at all -- unlike rejection-diagnostics.mjs's version,
  // accepted-run-audit.mjs's final_answer_block is already fully structural (found/parsed/
  // matches_observed/comparison_status/mismatch_fields, no raw text), confirmed by reading the
  // fixture above. The genuinely free-text surface for THIS file is the raw Bash tool-result
  // content itself -- exactly the kind of prose/timestamp content buildAcceptedRunAuditSidecar's
  // whole job is to classify into structure and never echo raw. Sentinels: a distinctive module
  // name + path in the command, the conditionResult's own tool-use id, and a distinctive
  // timestamp + prose string in the tool RESULT content.
  it('outcome_observability_summary discards a sentinel module name, path, tool-use id, timestamp, and prose present in the real input', () => {
    const SENTINEL_TIMESTAMP = '2027-01-15T03:22:47.123Z';
    const SENTINEL_PROSE = 'sentinel-free-text-prose-detail-should-never-leak';
    const sentinelConditionResult = conditionResultFrom(
      [
        initEventStub(),
        bashToolUseEvent('sentinel-tool-use-id-99', 'kmp-test parallel --module-filter sentinel-secret-module-77 --project-root /srv/sentinel-fixture/secret-path --json'),
        toolResultEvent('sentinel-tool-use-id-99', { content: `Ran at ${SENTINEL_TIMESTAMP} -- ${SENTINEL_PROSE}` }),
        resultEventStub(),
      ],
      { decisionByAttempt: new Map([['sentinel-tool-use-id-99', 'allow']]) },
    );
    const sentinelTerminal = terminalEvidence({
      observed_result: { ...terminalEvidence().observed_result, module_matches_expected: true },
    });
    const sidecar = buildFor(schema8PolicyRequiredRecord(), sentinelTerminal, sentinelConditionResult);
    const json = JSON.stringify(sidecar.outcome_observability_summary);
    expect(json).not.toMatch(/sentinel-secret-module-77|sentinel-tool-use-id-99|\/srv\/sentinel-fixture\/secret-path|--module-filter|--project-root|2027-01-15T03:22:47|sentinel-free-text-prose-detail-should-never-leak/i);
  });

  // Requirement 10 (P2 review-round finding): buildAcceptedRunAuditSidecar's own
  // outcome_observability_summary assembly never parses a transcript or reads a file -- mirrors
  // the identical static-source-guard pattern already established for buildRejectionDiagnostics.
  it('outcome_observability_summary is assembled from already-computed structured data -- never a parser or raw file read', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'tools', 'agentic-eval', 'accepted-run-audit.mjs'), 'utf8');
    const start = source.indexOf('export function buildAcceptedRunAuditSidecar');
    const end = source.indexOf('export function validateAcceptedRunAuditSidecar');
    const builder = source.slice(start, end);
    expect(builder).not.toMatch(/parse(?:Stream|Transcript)|readFileSync\(/i);
  });
});

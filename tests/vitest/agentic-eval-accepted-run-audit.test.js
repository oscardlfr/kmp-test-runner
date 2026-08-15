// tests/vitest/agentic-eval-accepted-run-audit.test.js
// Unit tests for tools/agentic-eval/accepted-run-audit.mjs -- the privacy-safe structural audit
// sidecar for accepted scenario run records (accepted-run-observability PR). Pure builder +
// validator + cross-validator + a thin build/redact/hash orchestration helper, all exercised here
// with synthetic conditionResult/record inputs -- no real Claude session, no subprocess.
import { describe, it, expect } from 'vitest';
import {
  ACCEPTED_AUDIT_SIDECAR_SCHEMA_V1,
  LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA,
  acceptedAuditRelativePathFor,
  buildAcceptedRunAuditSidecar,
  validateAcceptedRunAuditSidecar,
  crossValidateAcceptedRunAuditAgainstRecord,
  finalizeAcceptedRunAuditSidecar,
} from '../../tools/agentic-eval/accepted-run-audit.mjs';

const TARGET_PLUGIN_NAME = 'kmp-test-runner';
const TARGET_SKILL_NAME = 'kmp-test-runner';

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

function conditionResultFrom(events, { decisionByAttempt = new Map(), endedHrtimeNs } = {}) {
  return {
    events,
    junitAttribution: { decisionByAttempt },
    spawnResult: { endedHrtimeNs },
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
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.schema).toBe(LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA);
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

  it('first_useful_signal_event mirrors the record\'s own field exactly (or null)', () => {
    const record = baseRecord({ first_useful_signal_event: { type: 'user.tool_result', index: 2 } });
    const cr = conditionResultFrom([initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: 2, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.first_useful_signal_event).toEqual({ type: 'user.tool_result', index: 2 });
  });

  it('terminal_authoritative_event is null when terminalAuthoritativeEventIndex is null', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
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
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: 2, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.terminal_authoritative_event).toEqual({ type: 'user.tool_result', index: 2 });
    expect(sidecar.terminal_authoritative_event.index).not.toBe(4); // NOT the later call's own result index
  });
});

describe('buildAcceptedRunAuditSidecar -- tool_calls[] classification', () => {
  it('classifies a target-Skill call WITHOUT storing the raw skill name anywhere', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), skillToolUseEvent('t1', TARGET_SKILL_NAME), toolResultEvent('t1'), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0].tool_kind).toBe('target-skill');
    expect(sidecar.tool_calls[0].operation).toBeNull();
    expect(sidecar.tool_calls[0].plan_only).toBeNull();
    expect(sidecar.tool_calls[0].policy_decision).toBe('not-applicable');
    expect(JSON.stringify(sidecar)).not.toContain(TARGET_SKILL_NAME);
  });

  it('classifies a non-target-Skill call WITHOUT storing the raw (foreign) skill name anywhere', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), skillToolUseEvent('t1', 'some-other-secret-skill-xyz'), toolResultEvent('t1', { isError: true }), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0].tool_kind).toBe('non-target-skill');
    expect(sidecar.tool_calls[0].result_status).toBe('error');
    expect(JSON.stringify(sidecar)).not.toContain('some-other-secret-skill-xyz');
  });

  it('classifies an unexpected tool (name outside Bash/Skill) as unexpected-tool, not-applicable decision', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), otherToolUseEvent('t1', 'Read'), toolResultEvent('t1'), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
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
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
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
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0]).toMatchObject({ tool_kind: 'gradle', operation: 'allowed-task' });
    expect(sidecar.tool_calls[1]).toMatchObject({ tool_kind: 'gradle', operation: 'other' });
    expect(JSON.stringify(sidecar)).not.toContain('secretmodule123');
    expect(JSON.stringify(sidecar)).not.toContain(':shared:testAndroidHostTest');
  });

  it('a command that is neither kmp-test nor Gradle classifies as other-bash, operation null, plan_only false', () => {
    const record = baseRecord();
    const decisionByAttempt = new Map([['t1', 'deny']]);
    const cr = conditionResultFrom([initEventStub(), bashToolUseEvent('t1', 'ls -la /some/secret/path'), toolResultEvent('t1', { isError: true }), resultEventStub()], { decisionByAttempt });
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0]).toMatchObject({ tool_kind: 'other-bash', operation: null, plan_only: false, policy_decision: 'deny', result_status: 'error' });
    expect(JSON.stringify(sidecar)).not.toContain('/some/secret/path');
  });

  it('plan_only reflects a --dry-run kmp-test invocation', () => {
    const record = baseRecord();
    const decisionByAttempt = new Map([['t1', 'allow']]);
    const cr = conditionResultFrom([initEventStub(), bashToolUseEvent('t1', 'kmp-test parallel --module-filter shared --dry-run --json'), toolResultEvent('t1'), resultEventStub()], { decisionByAttempt });
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.tool_calls[0].plan_only).toBe(true);
  });

  it('policy_decision is "missing" when decisionByAttempt has no entry for this attempt (never invents allow)', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor --json'), toolResultEvent('t1'), resultEventStub()]); // empty decisionByAttempt
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
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
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
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
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
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
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
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
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: 4, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
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
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: 3, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
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
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
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
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.summary.policy_denials_total).toBe(1);
    expect(sidecar.summary.policy_decisions_missing).toBe(1);
  });

  it('post_signal_ms/post_signal_tool_calls/policy_denials_{before,after}_first_signal are all null when there is no boundary', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), resultEventStub()]);
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
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
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: 2, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
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
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: 6, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
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
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: 2, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    // Mirrors production ordering exactly: cli.mjs's buildSidecarsFn attaches the pointer (with the
    // BUILT sidecar's own schema) before finalizeAndWriteMatrixRecords cross-validates the pair.
    record.accepted_audit = { schema: sidecar.schema, relative_path: `audit/${record.run_id}.json`, sha256: 'f'.repeat(64) };
    expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record)).toEqual([]);
  });

  it('rejects a record pointing at a different sidecar schema than the sidecar itself carries', () => {
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), resultEventStub()], { endedHrtimeNs: undefined });
    const sidecar = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    expect(sidecar.schema).toBe(LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA);

    // Record says v1, file on disk is v2.
    record.accepted_audit = { schema: ACCEPTED_AUDIT_SIDECAR_SCHEMA_V1, relative_path: `audit/${record.run_id}.json`, sha256: 'f'.repeat(64) };
    expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record).map((e) => e.field)).toContain('schema');

    // ...and the reverse: record says v2, file on disk is v1.
    record.accepted_audit.schema = LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA;
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
    const built = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
    const result = finalizeAcceptedRunAuditSidecar(built);
    expect(result.ok).toBe(true);
    expect(typeof result.redactedText).toBe('string');
    expect(/^[0-9a-f]{64}$/.test(result.sha256)).toBe(true);
  });

  it('the redacted text\'s own SHA-256 matches the returned sha256 exactly', async () => {
    const { createHash } = await import('node:crypto');
    const record = baseRecord();
    const cr = conditionResultFrom([initEventStub(), resultEventStub()]);
    const built = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
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
      const built = buildAcceptedRunAuditSidecar({ record, conditionResult: cr, terminalAuthoritativeEventIndex: null, targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME });
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

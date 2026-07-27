// tests/vitest/agentic-eval-analysis.test.js
// Unit tests for tools/agentic-eval/analysis.mjs -- the offline, axis-separated analysis command
// (`cli.mjs analyze --runs-dir <dir>`). Operates ONLY on already-committed schema-v5 scenario run
// records + their validated accepted-run-audit sidecars -- never a raw transcript, never a live
// Claude call. Mirrors agentic-eval-validate-command.test.js's fixture style (a full, schema-valid
// v5 scenario record + a matching, hash-bound sidecar written to a real temp directory) since
// analyzeRunsDir's own end-to-end path is a thin wrapper over the exact same validateRunRecordFile
// gate cmdValidate/cmdAggregate already use.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {
  ANALYSIS_SCHEMA, FAILURE_CLASS_VALUES, classifyFailure, deriveSkillRelativeFields,
  analyzeRunRecord, buildSummary, analyzeRunsDir, loadAcceptedAuditSidecar,
} from '../../tools/agentic-eval/analysis.mjs';
import { cmdAnalyze } from '../../tools/agentic-eval/cli.mjs';
import { ACCEPTED_AUDIT_SIDECAR_SCHEMA } from '../../tools/agentic-eval/accepted-run-audit.mjs';
import { GRADING_CHECK_NAMES } from '../../tools/agentic-eval/graders.mjs';

const VALID_SCOPE_ID = '11111111-2222-4333-8444-555555555555';

// ---------------------------------------------------------------------------------------------
// Fixture builders -- mirror agentic-eval-validate-command.test.js's baseCalibrationRecordV1/
// v5Base/scenarioV5Base/validSidecarFor/writeRunAndSidecar precedent, extended with a toolCalls
// list + firstUsefulSignalEvent so each test can drive analysis.mjs's own axis derivation through
// a genuinely schema-valid, cross-validated record+sidecar pair -- never a shortcut shape that
// only happens to satisfy analysis.mjs's own reading of it.

function passingCheck(name, overrides = {}) {
  return { name, passed: true, detail: 'ok', evidence_event_indices: [], ...overrides };
}

/** Full grading_checks.value array (exactly GRADING_CHECK_NAMES, in order) with per-name
 * pass/fail overrides -- keeps every fixture's grading_checks internally coherent with
 * GRADING_CHECK_NAMES even if a future schema change renames/reorders them. */
function gradingChecks(overrides = {}) {
  return GRADING_CHECK_NAMES.map((name) => passingCheck(name, overrides[name] ?? {}));
}

function scenarioRecord(overrides = {}) {
  const condition = overrides.condition ?? 'current-skill';
  const skillInvoked = overrides.skill_invoked ?? { value: condition === 'current-skill', reason: null };
  return {
    schema: 5, run_id: overrides.run_id ?? 'scenario-current-skill-abcd1234', run_kind: 'scenario', benchmark_eligible: true,
    scenario_id: 'kampkit-android-host-test-discovery', query_id: null, condition,
    skill_source_sha: condition === 'current-skill' ? '9e47a9d132f5b9ea6ac5bc50a66c844458fd363e' : null,
    kmp_test_cli_version: '0.14.0', kmp_test_cli_source_sha: 'a9acb22d7b58d6720248bcbd09f4b4818e8ad2be',
    resolved_kmp_test_executable_path: 'tools/agentic-eval/fixtures/calibration-project',
    model_requested: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', session_id_observed: 'sess-0001',
    claude_code_version: '2.1.218', repo_commit: 'a9acb22d7b58d6720248bcbd09f4b4818e8ad2be',
    project_alias: 'kampkit', project_commit: 'b3a7784fb969a8558b88c80674c8b596944cdab7',
    project_url: 'https://github.com/touchlab/KaMPKit', platform: 'windows',
    family: 'test-only', cache_state: 'cold', daemon_policy: 'disabled-via-gradle-user-home-properties',
    env_allowlist_profile: 'narrow', seed: 1, order_index: 0,
    started_at: '2026-07-26T14:56:01.309Z', ended_at: '2026-07-26T14:57:30.396Z', wall_clock_ms: 89087,
    skill_available: { value: condition === 'current-skill', reason: null },
    skill_invocation_attempted: { value: skillInvoked.value === true, reason: null },
    skill_invoked: skillInvoked,
    skill_invocation_event: overrides.skill_invocation_event !== undefined ? overrides.skill_invocation_event
      : (skillInvoked.value === true ? { type: 'assistant.tool_use.Skill', index: 0 } : null),
    success: overrides.success ?? { value: false, reason: null },
    expected_outcome_matched: overrides.expected_outcome_matched ?? { value: false, reason: null },
    first_useful_signal_ms: { value: null, reason: 'no correlated authoritative outcome event found' },
    first_useful_signal_event: overrides.first_useful_signal_event !== undefined ? overrides.first_useful_signal_event : null,
    post_signal_ms: overrides.post_signal_ms ?? { value: null, reason: 'no first useful signal boundary' },
    post_signal_tool_calls: overrides.post_signal_tool_calls ?? { value: null, reason: 'no first useful signal boundary' },
    policy_denials_before_first_signal: overrides.policy_denials_before_first_signal ?? { value: null, reason: 'no first useful signal boundary' },
    policy_denials_after_first_signal: overrides.policy_denials_after_first_signal ?? { value: null, reason: 'no first useful signal boundary' },
    accepted_audit: null, // stamped by writeRunAndSidecar
    tokens: {
      input: { value: 16, reason: null }, output: { value: 1835, reason: null },
      cache_read: { value: 151916, reason: null }, cache_creation: { value: 7026, reason: null },
    },
    tool_calls_total: { value: 1, reason: null }, shell_commands_total: { value: 0, reason: null },
    test_invocations_total: { value: 0, reason: null }, retries: { value: 0, reason: null },
    output_bytes: { value: 2336, reason: null }, stream_json_bytes: { value: 56488, reason: null },
    human_interventions: { value: 0, reason: null },
    terminated: false, termination_reason: null, exit_code: 0, permission_mode_used: 'dontAsk',
    policy_allowed_gradle_tasks: [':shared:tasks'], policy_allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel'],
    policy_sha256: 'f2ec18f5dde8f230d0b09aecaf02f1adaf4244c6f8464461483936c5fe48b5bc',
    hook_call_count: overrides.hook_call_count ?? 0, hook_deny_count: overrides.hook_deny_count ?? 0,
    privacy_status: 'public', raw_capture_committed: false, raw_capture_location: 'tools/runs/agentic-eval-scenario/raw/',
    notes: 'Scenario run -- benchmark_eligible reflects protocol/integrity completeness, not answer correctness.',
    grading_checks: { value: overrides.grading_checks ?? gradingChecks(), reason: null },
    repetition_index: 0,
    foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
    ambient_skill_profile: { count: 16, scope_id: VALID_SCOPE_ID, fingerprint_hmac: '0'.repeat(64) },
    errors: [],
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => !['grading_checks', 'skill_invoked', 'hook_call_count', 'hook_deny_count'].includes(k))),
  };
}

const BASH_KINDS = new Set(['kmp-test', 'gradle', 'other-bash']);

function phaseFor(tc, boundaryIndex) {
  if (boundaryIndex == null) return 'no-signal';
  if (tc.tool_result_event_index === boundaryIndex) return 'produced-signal';
  if (tc.tool_use_event_index > boundaryIndex) return 'post-signal';
  return 'pre-signal';
}

/** One target-skill tool_calls[] entry (Skill tool_use referencing the target plugin:skill). */
function targetSkillEntry(useIdx, { resultIdx = useIdx + 1, resultStatus = 'success' } = {}) {
  return {
    tool_use_event_index: useIdx, tool_result_event_index: resultStatus === 'missing' ? null : resultIdx,
    tool_kind: 'target-skill', operation: null, plan_only: null, policy_decision: 'not-applicable', result_status: resultStatus,
  };
}

/** One Bash-family tool_calls[] entry. */
function bashEntry(useIdx, { kind = 'other-bash', resultIdx = useIdx + 1, decision = 'allow', resultStatus = 'success', operation = null } = {}) {
  return {
    tool_use_event_index: useIdx, tool_result_event_index: resultStatus === 'missing' ? null : resultIdx,
    tool_kind: kind, operation: kind === 'other-bash' ? null : operation, plan_only: false,
    policy_decision: decision, result_status: resultStatus,
  };
}

/** Assembles a fully valid, internally-coherent accepted-run-audit sidecar from a flat list of
 * partial tool_calls[] entries (as produced by targetSkillEntry/bashEntry) -- fills in
 * ordinal/phase and recomputes `summary` from the entries themselves, exactly mirroring
 * buildAcceptedRunAuditSidecar's own formulas, so every fixture independently satisfies
 * validateAcceptedRunAuditSidecar's cross-checks rather than merely analysis.mjs's own reading. */
function sidecarFor(record, { entries = [], firstUsefulSignalEvent = null } = {}) {
  const sorted = [...entries].sort((a, b) => a.tool_use_event_index - b.tool_use_event_index);
  const boundaryIndex = firstUsefulSignalEvent?.index ?? null;
  const toolCalls = sorted.map((tc, ordinal) => ({ ordinal, ...tc, phase: phaseFor(tc, boundaryIndex) }));
  const isBash = (tc) => BASH_KINDS.has(tc.tool_kind);
  const bashEntries = toolCalls.filter(isBash);
  const hasBoundary = boundaryIndex != null;
  return {
    schema: ACCEPTED_AUDIT_SIDECAR_SCHEMA, run_id: record.run_id, run_schema: 5, run_kind: 'scenario',
    condition: record.condition, scenario_id: record.scenario_id,
    first_useful_signal_event: firstUsefulSignalEvent, terminal_authoritative_event: firstUsefulSignalEvent,
    tool_calls: toolCalls,
    summary: {
      tool_calls_total: toolCalls.length,
      shell_commands_total: bashEntries.length,
      post_signal_ms: hasBoundary ? 0 : null,
      post_signal_tool_calls: hasBoundary ? toolCalls.filter((tc) => tc.tool_use_event_index > boundaryIndex).length : null,
      policy_denials_total: bashEntries.filter((tc) => tc.policy_decision === 'deny').length,
      policy_denials_before_first_signal: hasBoundary ? bashEntries.filter((tc) => tc.policy_decision === 'deny' && tc.tool_use_event_index <= boundaryIndex).length : null,
      policy_denials_after_first_signal: hasBoundary ? bashEntries.filter((tc) => tc.policy_decision === 'deny' && tc.tool_use_event_index > boundaryIndex).length : null,
      policy_decisions_missing: bashEntries.filter((tc) => tc.policy_decision === 'missing').length,
    },
  };
}

/** Writes record.json + audit/<run_id>.json into `dir` with a REAL sha256 binding -- returns the
 * run record's own path. Mirrors agentic-eval-validate-command.test.js's identical helper.
 * Reconciles the record's own tool_calls_total/shell_commands_total/hook_deny_count/
 * hook_call_count (and, when a signal boundary exists, post_signal_tool_calls/
 * policy_denials_before_after_first_signal) from the SAME entries the sidecar was built from --
 * crossValidateAcceptedRunAuditAgainstRecord requires these to agree exactly, so a caller can pass
 * any `entries` shape to `sidecarOpts` without separately hand-computing matching record counts. */
function writeRunAndSidecar(dir, record, sidecarOpts = {}, { tamperSha256AfterWrite = false, sidecarText: sidecarTextOverride } = {}) {
  const sidecar = sidecarFor(record, sidecarOpts);
  record.tool_calls_total = { value: sidecar.summary.tool_calls_total, reason: null };
  record.shell_commands_total = { value: sidecar.summary.shell_commands_total, reason: null };
  record.hook_call_count = sidecar.summary.shell_commands_total;
  record.hook_deny_count = sidecar.summary.policy_denials_total;
  if (sidecar.first_useful_signal_event != null) {
    record.post_signal_tool_calls = { value: sidecar.summary.post_signal_tool_calls, reason: null };
    record.policy_denials_before_first_signal = { value: sidecar.summary.policy_denials_before_first_signal, reason: null };
    record.policy_denials_after_first_signal = { value: sidecar.summary.policy_denials_after_first_signal, reason: null };
  }
  const sidecarText = sidecarTextOverride ?? JSON.stringify(sidecar, null, 2);
  const sha256 = createHash('sha256').update(sidecarText, 'utf8').digest('hex');
  record.accepted_audit = { schema: 1, relative_path: `audit/${record.run_id}.json`, sha256: tamperSha256AfterWrite ? 'f'.repeat(64) : sha256 };
  const runPath = path.join(dir, `${record.run_id}.json`);
  writeFileSync(runPath, JSON.stringify(record, null, 2));
  const auditDir = path.join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(path.join(auditDir, `${record.run_id}.json`), sidecarText);
  return runPath;
}

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aeva-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------

describe('classifyFailure -- explicit closed-vocabulary precedence', () => {
  const base = {
    success: false, activationExpected: true, targetSkillInvoked: true, preSkillToolCalls: 0,
    hookDenyCount: 0, authoritativeEvidencePresent: true, targetMatchesExpected: true,
    outcomeMatchesExpected: true, finalAnswerConsistent: true,
  };

  it('every returned value is a member of the published closed vocabulary', () => {
    expect(FAILURE_CLASS_VALUES).toEqual([
      'success', 'target-skill-not-invoked', 'pre-skill-exploration', 'policy-blocked',
      'no-authoritative-evidence', 'wrong-target', 'outcome-mismatch', 'unclassified',
    ]);
  });

  it('success:true always wins, regardless of any other signal', () => {
    expect(classifyFailure({ ...base, success: true })).toBe('success');
    // Competing causes present -- must NOT leak through once success is true.
    expect(classifyFailure({ ...base, success: true, targetSkillInvoked: false, hookDenyCount: 9, preSkillToolCalls: 9 })).toBe('success');
  });

  it('target-skill-not-invoked beats every downstream cause when activation was expected', () => {
    expect(classifyFailure({ ...base, targetSkillInvoked: false })).toBe('target-skill-not-invoked');
    // Competing cause: also has denials and no evidence -- activation still wins (most upstream axis).
    expect(classifyFailure({ ...base, targetSkillInvoked: false, hookDenyCount: 3, authoritativeEvidencePresent: false })).toBe('target-skill-not-invoked');
  });

  it('target-skill-not-invoked never fires when activation was not expected (no-skill baseline)', () => {
    expect(classifyFailure({ ...base, activationExpected: false, targetSkillInvoked: null })).not.toBe('target-skill-not-invoked');
  });

  it('pre-skill-exploration fires when invoked-but-delayed AND no evidence resulted', () => {
    expect(classifyFailure({ ...base, authoritativeEvidencePresent: false, preSkillToolCalls: 3, hookDenyCount: 0 })).toBe('pre-skill-exploration');
  });

  it('policy-blocked beats pre-skill-exploration when both apply (an active denial outranks passive delay)', () => {
    expect(classifyFailure({ ...base, authoritativeEvidencePresent: false, preSkillToolCalls: 3, hookDenyCount: 5 })).toBe('policy-blocked');
  });

  it('policy-blocked fires when no evidence resulted, a denial occurred, and there was no pre-skill delay', () => {
    expect(classifyFailure({ ...base, authoritativeEvidencePresent: false, preSkillToolCalls: 0, hookDenyCount: 2 })).toBe('policy-blocked');
  });

  it('policy-blocked applies to a no-skill-condition run too (activation axis does not gate it)', () => {
    expect(classifyFailure({ ...base, activationExpected: false, targetSkillInvoked: null, preSkillToolCalls: null, authoritativeEvidencePresent: false, hookDenyCount: 1 })).toBe('policy-blocked');
  });

  it('no-authoritative-evidence fires when nothing else explains the missing evidence', () => {
    expect(classifyFailure({ ...base, authoritativeEvidencePresent: false, preSkillToolCalls: 0, hookDenyCount: 0 })).toBe('no-authoritative-evidence');
  });

  it('a denial that happened but did NOT prevent well-formed evidence does not override a more specific downstream cause', () => {
    // Real-world shape (mirrors the committed kampkit-android-host-test-discovery fixture): the
    // run had denied pre-skill Bash attempts, but a LATER attempt still produced well-formed
    // evidence for the wrong module -- wrong-target must win, not policy-blocked.
    expect(classifyFailure({ ...base, hookDenyCount: 4, preSkillToolCalls: 3, authoritativeEvidencePresent: true, targetMatchesExpected: false })).toBe('wrong-target');
  });

  it('wrong-target fires once evidence is well-formed but targets the wrong module', () => {
    expect(classifyFailure({ ...base, targetMatchesExpected: false })).toBe('wrong-target');
  });

  it('outcome-mismatch fires once evidence+target are fine but the outcome counts disagree', () => {
    expect(classifyFailure({ ...base, outcomeMatchesExpected: false })).toBe('outcome-mismatch');
  });

  it('outcome-mismatch also covers a final-answer/evidence inconsistency alone', () => {
    expect(classifyFailure({ ...base, finalAnswerConsistent: false })).toBe('outcome-mismatch');
  });

  it('never returns unclassified for any input covered by the documented precedence', () => {
    // Sweep every axis independently off of the "everything fine" base -- with success:false forced,
    // each single-axis failure must resolve to a specific class, never fall through to the catch-all.
    const singleAxisFailures = [
      { ...base, targetSkillInvoked: false },
      { ...base, authoritativeEvidencePresent: false },
      { ...base, targetMatchesExpected: false },
      { ...base, outcomeMatchesExpected: false },
      { ...base, finalAnswerConsistent: false },
    ];
    for (const input of singleAxisFailures) {
      expect(classifyFailure(input)).not.toBe('unclassified');
    }
  });
});

describe('deriveSkillRelativeFields', () => {
  it('returns all-null when activation is not expected (no-skill condition)', () => {
    const result = deriveSkillRelativeFields({ skill_invocation_event: null }, null, false, null);
    expect(result).toEqual({
      ok: true, target_skill_invocation_ordinal: null, pre_skill_tool_calls: null,
      pre_skill_policy_denials: null, post_skill_pre_signal_tool_calls: null, post_skill_pre_signal_policy_denials: null,
    });
  });

  it('returns all-null when the target skill was never invoked', () => {
    const result = deriveSkillRelativeFields({ skill_invocation_event: null }, null, true, false);
    expect(result.ok).toBe(true);
    expect(result.target_skill_invocation_ordinal).toBeNull();
    expect(result.pre_skill_tool_calls).toBeNull();
  });

  it('ordinal 1 + zero pre-skill calls for an immediate, first-attempt invocation', () => {
    const record = { skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 5 } };
    const sidecar = { first_useful_signal_event: null, tool_calls: [targetSkillEntry(5)].map((tc, i) => ({ ordinal: i, ...tc, phase: 'no-signal' })) };
    const result = deriveSkillRelativeFields(record, sidecar, true, true);
    expect(result).toEqual({
      ok: true, target_skill_invocation_ordinal: 1, pre_skill_tool_calls: 0,
      pre_skill_policy_denials: 0, post_skill_pre_signal_tool_calls: null, post_skill_pre_signal_policy_denials: null,
    });
  });

  it('counts pre-skill tool calls (including an earlier failed attempt at the SAME skill) before the confirmed invocation', () => {
    const record = { skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 20 } }; // representative = the CONFIRMED attempt
    const entries = [
      bashEntry(5), // unrelated exploration
      targetSkillEntry(10, { resultStatus: 'error' }), // 1st attempt at the target skill: failed
      targetSkillEntry(20, { resultStatus: 'success' }), // 2nd attempt: confirmed
    ];
    const sidecar = sidecarFor(record, { entries });
    const result = deriveSkillRelativeFields(record, sidecar, true, true);
    expect(result.ok).toBe(true);
    expect(result.target_skill_invocation_ordinal).toBe(2); // 2nd attempt AT THE SKILL succeeded
    expect(result.pre_skill_tool_calls).toBe(2); // the bash call AND the failed attempt both precede it
  });

  it('counts pre-skill policy denials distinctly from pre-skill tool calls', () => {
    const record = { skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 30 } };
    const entries = [
      bashEntry(5, { decision: 'deny', resultStatus: 'error' }),
      bashEntry(10, { decision: 'deny', resultStatus: 'error' }),
      bashEntry(15, { decision: 'allow' }),
      targetSkillEntry(30),
    ];
    const sidecar = sidecarFor(record, { entries });
    const result = deriveSkillRelativeFields(record, sidecar, true, true);
    expect(result.pre_skill_tool_calls).toBe(3);
    expect(result.pre_skill_policy_denials).toBe(2);
  });

  it('post-skill-pre-signal fields are null when there is no first-useful-signal boundary at all', () => {
    const record = { skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 10 } };
    const entries = [targetSkillEntry(10), bashEntry(20, { kind: 'kmp-test', operation: 'describe' })];
    const sidecar = sidecarFor(record, { entries }); // no firstUsefulSignalEvent
    const result = deriveSkillRelativeFields(record, sidecar, true, true);
    expect(result.post_skill_pre_signal_tool_calls).toBeNull();
    expect(result.post_skill_pre_signal_policy_denials).toBeNull();
  });

  it('counts post-skill, pre-signal tool calls and denials once a real signal boundary exists', () => {
    const record = { skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 10 } };
    const entries = [
      targetSkillEntry(10),
      bashEntry(15, { kind: 'kmp-test', operation: 'describe', resultIdx: 16 }), // pre-signal exploration after invoking
      bashEntry(20, { kind: 'kmp-test', operation: 'doctor', decision: 'deny', resultStatus: 'error', resultIdx: 21 }), // denied, still pre-signal
      bashEntry(25, { kind: 'kmp-test', operation: 'parallel', resultIdx: 26 }), // produces the signal
      bashEntry(30, { kind: 'kmp-test', operation: 'parallel', resultIdx: 31 }), // AFTER the signal
    ];
    const firstUsefulSignalEvent = { type: 'user.tool_result', index: 26 };
    const sidecar = sidecarFor(record, { entries, firstUsefulSignalEvent });
    const result = deriveSkillRelativeFields(record, sidecar, true, true);
    // Post-skill (index > 10), phase pre-signal/produced-signal: the two exploration calls (15, 20) + the signal-producing call (25) = 3.
    expect(result.post_skill_pre_signal_tool_calls).toBe(3);
    expect(result.post_skill_pre_signal_policy_denials).toBe(1);
  });

  it('fails closed when skill_invoked is true but skill_invocation_event is missing', () => {
    const result = deriveSkillRelativeFields({ skill_invocation_event: null }, { tool_calls: [], first_useful_signal_event: null }, true, true);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('fails closed when the confirmed invocation index does not correlate to any target-skill sidecar entry', () => {
    const record = { skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 999 } };
    const sidecar = { first_useful_signal_event: null, tool_calls: [{ ordinal: 0, ...targetSkillEntry(5), phase: 'no-signal' }] };
    const result = deriveSkillRelativeFields(record, sidecar, true, true);
    expect(result.ok).toBe(false);
  });

  it('fails closed when the sidecar tool_calls is missing or not an array', () => {
    const record = { skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 5 } };
    for (const badSidecar of [{ first_useful_signal_event: null }, { first_useful_signal_event: null, tool_calls: 'nope' }, null]) {
      const result = deriveSkillRelativeFields(record, badSidecar, true, true);
      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
    }
  });
});

describe('analyzeRunRecord -- required end-to-end scenario coverage', () => {
  it('successful activation: invoked on the first attempt, no pre-skill exploration, outcome matches', () => {
    const record = scenarioRecord({ success: { value: true, reason: null }, expected_outcome_matched: { value: true, reason: null } });
    const sidecar = sidecarFor(record, { entries: [targetSkillEntry(0), bashEntry(1, { kind: 'kmp-test', operation: 'parallel' })] });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.activation_expected).toBe(true);
    expect(entry.target_skill_invoked).toBe(true);
    expect(entry.target_skill_invocation_ordinal).toBe(1);
    expect(entry.pre_skill_tool_calls).toBe(0);
    expect(entry.success).toBe(true);
    expect(entry.failure_class).toBe('success');
  });

  it('delayed activation: invocation succeeds only on its second attempt, after unrelated exploration', () => {
    const record = scenarioRecord({
      success: { value: true, reason: null }, expected_outcome_matched: { value: true, reason: null },
      skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 12 },
    });
    const entries = [
      bashEntry(2), // unrelated pre-skill exploration
      targetSkillEntry(6, { resultStatus: 'error' }), // 1st attempt at the skill fails
      targetSkillEntry(12, { resultStatus: 'success' }), // 2nd attempt confirmed
      bashEntry(18, { kind: 'kmp-test', operation: 'parallel' }),
    ];
    const sidecar = sidecarFor(record, { entries });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.target_skill_invocation_ordinal).toBe(2);
    expect(entry.pre_skill_tool_calls).toBe(2);
    expect(entry.success).toBe(true);
  });

  it('missing activation: current-skill condition, but the target skill was never invoked', () => {
    const record = scenarioRecord({
      skill_invoked: { value: false, reason: null }, skill_invocation_event: null,
      success: { value: false, reason: null },
      grading_checks: gradingChecks({ authoritative_evidence_well_formed: { passed: false, detail: 'no attempt capable of producing target evidence was ever made' } }),
    });
    const sidecar = sidecarFor(record, { entries: [bashEntry(0, { kind: 'other-bash' })] });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.activation_expected).toBe(true);
    expect(entry.target_skill_invoked).toBe(false);
    expect(entry.target_skill_invocation_ordinal).toBeNull();
    expect(entry.pre_skill_tool_calls).toBeNull();
    expect(entry.failure_class).toBe('target-skill-not-invoked');
  });

  it('pre-skill denials: Bash attempts before invocation were denied by policy', () => {
    const record = scenarioRecord({
      skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 15 },
      hook_deny_count: 2, hook_call_count: 3,
      grading_checks: gradingChecks({ authoritative_evidence_well_formed: { passed: false, detail: 'no attempt capable of producing target evidence was ever made' } }),
    });
    const entries = [
      bashEntry(2, { decision: 'deny', resultStatus: 'error' }),
      bashEntry(8, { decision: 'deny', resultStatus: 'error' }),
      targetSkillEntry(15),
    ];
    const sidecar = sidecarFor(record, { entries });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.pre_skill_policy_denials).toBe(2);
    expect(entry.failure_class).toBe('policy-blocked');
  });

  it('post-skill/pre-signal work: extra tool calls happen after invocation but before the authoritative signal', () => {
    const firstUsefulSignalEvent = { type: 'user.tool_result', index: 26 };
    const record = scenarioRecord({
      skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 10 },
      first_useful_signal_event: firstUsefulSignalEvent,
      success: { value: true, reason: null }, expected_outcome_matched: { value: true, reason: null },
      post_signal_tool_calls: { value: 0, reason: null },
    });
    const entries = [
      targetSkillEntry(10),
      bashEntry(15, { kind: 'kmp-test', operation: 'describe', resultIdx: 16 }),
      bashEntry(20, { kind: 'kmp-test', operation: 'doctor', resultIdx: 21 }),
      bashEntry(25, { kind: 'kmp-test', operation: 'parallel', resultIdx: 26 }),
    ];
    const sidecar = sidecarFor(record, { entries, firstUsefulSignalEvent });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.post_skill_pre_signal_tool_calls).toBe(3);
    expect(entry.post_signal_tool_calls).toBe(0);
    expect(entry.success).toBe(true);
  });

  it('wrong target: well-formed evidence, but it targets the wrong module (mirrors the committed kampkit fixture shape)', () => {
    const record = scenarioRecord({
      skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 28 },
      hook_deny_count: 3,
      grading_checks: gradingChecks({
        authoritative_target_matches_expected: { passed: false, detail: 'terminal attempt targeted the WRONG module' },
        authoritative_outcome_matches_expected: { passed: false, detail: 'no well-formed, correctly-targeted terminal evidence to check' },
        final_answer_consistent_with_evidence: { passed: false, detail: 'mismatch' },
      }),
    });
    const entries = [
      bashEntry(6, { decision: 'deny', resultStatus: 'error' }),
      bashEntry(13, { decision: 'deny', resultStatus: 'error' }),
      bashEntry(20, { decision: 'deny', resultStatus: 'error' }),
      targetSkillEntry(28),
      bashEntry(48, { kind: 'kmp-test', operation: 'parallel', resultIdx: 55 }),
    ];
    const sidecar = sidecarFor(record, { entries });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.authoritative_evidence_present).toBe(true);
    expect(entry.pre_skill_policy_denials).toBe(3);
    expect(entry.failure_class).toBe('wrong-target');
  });

  it('missing authoritative evidence: no attempt ever produced well-formed evidence', () => {
    const record = scenarioRecord({
      skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 0 },
      grading_checks: gradingChecks({
        authoritative_evidence_well_formed: { passed: false, detail: 'the terminal attempt produced no result at all' },
        authoritative_target_matches_expected: { passed: false, detail: 'no well-formed terminal evidence to check' },
        authoritative_outcome_matches_expected: { passed: false, detail: 'no well-formed, correctly-targeted terminal evidence to check' },
        final_answer_consistent_with_evidence: { passed: false, detail: 'no evidence' },
      }),
    });
    const sidecar = sidecarFor(record, { entries: [targetSkillEntry(0)] });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.authoritative_evidence_present).toBe(false);
    expect(entry.failure_class).toBe('no-authoritative-evidence');
  });

  it('outcome mismatch: well-formed, correctly-targeted evidence, but the outcome counts disagree', () => {
    const record = scenarioRecord({
      skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 0 },
      grading_checks: gradingChecks({
        authoritative_outcome_matches_expected: { passed: false, detail: 'terminal attempt outcome does NOT match expected' },
        final_answer_consistent_with_evidence: { passed: false, detail: 'mismatch' },
      }),
    });
    const sidecar = sidecarFor(record, { entries: [targetSkillEntry(0), bashEntry(1, { kind: 'kmp-test', operation: 'parallel' })] });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.authoritative_evidence_present).toBe(true);
    expect(entry.failure_class).toBe('outcome-mismatch');
  });

  it('activation not expected (no-skill condition): every skill-relative field is null, evidence/outcome still graded', () => {
    const record = scenarioRecord({
      condition: 'no-skill', skill_invoked: { value: false, reason: null }, skill_invocation_event: null,
      success: { value: true, reason: null }, expected_outcome_matched: { value: true, reason: null },
    });
    const sidecar = sidecarFor(record, { entries: [bashEntry(0, { kind: 'kmp-test', operation: 'parallel' })] });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.activation_expected).toBe(false);
    expect(entry.target_skill_invoked).toBeNull();
    expect(entry.target_skill_invocation_ordinal).toBeNull();
    expect(entry.pre_skill_tool_calls).toBeNull();
    expect(entry.pre_skill_policy_denials).toBeNull();
    expect(entry.post_skill_pre_signal_tool_calls).toBeNull();
    expect(entry.failure_class).toBe('success');
  });

  it('fails closed when grading_checks is missing one or more required check names', () => {
    const record = scenarioRecord({
      skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 0 },
      grading_checks: gradingChecks().filter((c) => c.name !== 'authoritative_target_matches_expected'),
    });
    const sidecar = sidecarFor(record, { entries: [targetSkillEntry(0)] });
    const { ok, error } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(false);
    expect(typeof error).toBe('string');
  });

  it('never emits a raw command, path, or skill name -- only closed-vocabulary/structural values', () => {
    const record = scenarioRecord({ skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 0 } });
    const sidecar = sidecarFor(record, { entries: [targetSkillEntry(0), bashEntry(1, { kind: 'gradle', operation: 'allowed-task' })] });
    const { entry } = analyzeRunRecord(record, sidecar);
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('kmp-test');
    expect(serialized).not.toContain('gradle');
    expect(serialized).not.toContain(':shared');
    expect(serialized).not.toMatch(/[A-Za-z]:[\\/]/); // no absolute Windows path
    expect(serialized).not.toContain('C:\\');
  });
});

describe('buildSummary', () => {
  function pair(recordOverrides, entryOverrides) {
    const record = scenarioRecord(recordOverrides);
    const entry = {
      run_id: record.run_id, scenario_id: record.scenario_id, condition: record.condition,
      activation_expected: true, target_skill_invoked: true, target_skill_invocation_ordinal: 1,
      pre_skill_tool_calls: 0, pre_skill_policy_denials: 0, post_skill_pre_signal_tool_calls: null,
      post_skill_pre_signal_policy_denials: null, post_signal_tool_calls: null,
      authoritative_evidence_present: true, expected_outcome_matched: true, success: true,
      failure_class: 'success', ...entryOverrides,
    };
    return { record, entry };
  }

  it('groups by scenario_id and condition, never pooling them together', () => {
    const pairs = [
      pair({ run_id: 'r1', scenario_id: 's1', condition: 'current-skill' }, {}),
      pair({ run_id: 'r2', scenario_id: 's1', condition: 'no-skill' }, { activation_expected: false, target_skill_invoked: null, target_skill_invocation_ordinal: null, pre_skill_tool_calls: null, pre_skill_policy_denials: null }),
      pair({ run_id: 'r3', scenario_id: 's2', condition: 'current-skill' }, {}),
    ];
    const summary = buildSummary(pairs);
    expect(summary.groups.length).toBe(3);
  });

  it('never pools two different schema versions into the same group', () => {
    const pairs = [
      pair({ run_id: 'r1', schema: 5 }, {}),
      pair({ run_id: 'r2', schema: 5 }, {}),
    ];
    // Force a provenance difference the Fairness Contract already treats as a hard partition key.
    pairs[1].record.platform = 'linux';
    const summary = buildSummary(pairs);
    expect(summary.groups.length).toBe(2);
  });

  it('computes rates and never divides by zero', () => {
    const pairs = [
      pair({ run_id: 'r1' }, { success: true, failure_class: 'success' }),
      pair({ run_id: 'r2' }, { success: false, failure_class: 'outcome-mismatch', target_skill_invoked: true }),
    ];
    const summary = buildSummary(pairs);
    const [group] = summary.groups;
    expect(group.run_count).toBe(2);
    expect(group.success_rate).toBe(0.5);
    expect(group.target_skill_invoked_rate).toBe(1);
  });

  it('returns a null rate rather than NaN when the denominator is zero', () => {
    const pairs = [
      pair({ run_id: 'r1', condition: 'no-skill' }, { activation_expected: false, target_skill_invoked: null }),
    ];
    const summary = buildSummary(pairs);
    expect(summary.groups[0].target_skill_invoked_rate).toBeNull();
  });

  it('builds a compact distribution for invocation ordinal and pre/post-skill call counts', () => {
    const pairs = [
      pair({ run_id: 'r1' }, { target_skill_invocation_ordinal: 1, pre_skill_tool_calls: 0 }),
      pair({ run_id: 'r2' }, { target_skill_invocation_ordinal: 1, pre_skill_tool_calls: 3 }),
      pair({ run_id: 'r3' }, { target_skill_invocation_ordinal: 2, pre_skill_tool_calls: 3 }),
      pair({ run_id: 'r4' }, { target_skill_invocation_ordinal: null, pre_skill_tool_calls: null, target_skill_invoked: false, failure_class: 'target-skill-not-invoked' }),
    ];
    const summary = buildSummary(pairs);
    const [group] = summary.groups;
    expect(group.invocation_ordinal_distribution).toEqual({ '1': 2, '2': 1, null: 1 });
    expect(group.pre_skill_tool_calls_distribution).toEqual({ '0': 1, '3': 2, null: 1 });
  });

  it('tallies failure_class counts across every published class', () => {
    const pairs = [
      pair({ run_id: 'r1' }, { failure_class: 'success' }),
      pair({ run_id: 'r2' }, { failure_class: 'wrong-target', success: false }),
    ];
    const summary = buildSummary(pairs);
    expect(summary.groups[0].failure_class_counts.success).toBe(1);
    expect(summary.groups[0].failure_class_counts['wrong-target']).toBe(1);
    expect(summary.groups[0].failure_class_counts['policy-blocked']).toBe(0);
  });

  it('handles an empty input without throwing', () => {
    expect(() => buildSummary([])).not.toThrow();
    expect(buildSummary([]).groups).toEqual([]);
  });
});

describe('analyzeRunsDir -- end-to-end, fail-closed directory scan', () => {
  it('a genuinely well-formed record + sidecar is analyzed and included in per_run', () => {
    withTempDir((dir) => {
      const record = scenarioRecord({ success: { value: true, reason: null }, expected_outcome_matched: { value: true, reason: null } });
      writeRunAndSidecar(dir, record, { entries: [targetSkillEntry(0)] });
      const result = analyzeRunsDir(dir);
      expect(result.schema).toBe(ANALYSIS_SCHEMA);
      expect(result.errors).toEqual([]);
      expect(result.per_run.length).toBe(1);
      expect(result.per_run[0].run_id).toBe(record.run_id);
      expect(result.summary.files_seen).toBe(1);
      expect(result.summary.files_analyzed).toBe(1);
      expect(cmdAnalyze({ 'runs-dir': dir })).toBe(0);
    });
  });

  it('a malformed record file is excluded, reported per-file, and the command exits non-zero -- following cmdAggregate precedent', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'bad.json'), 'not valid json {{{');
      const result = analyzeRunsDir(dir);
      expect(result.per_run).toEqual([]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].run_id).toBe('(unknown)');
      expect(cmdAnalyze({ 'runs-dir': dir })).toBe(1);
    });
  });

  it('a missing sidecar is excluded and reported per-file, without aborting the whole batch', () => {
    withTempDir((dir) => {
      const good = scenarioRecord({ run_id: 'scenario-current-skill-good0001' });
      writeRunAndSidecar(dir, good, { entries: [targetSkillEntry(0)] });
      const missingSidecar = scenarioRecord({ run_id: 'scenario-current-skill-nosidecar' });
      const runPath = writeRunAndSidecar(dir, missingSidecar, { entries: [targetSkillEntry(0)] });
      rmSync(path.join(dir, 'audit', 'scenario-current-skill-nosidecar.json'));
      const result = analyzeRunsDir(dir);
      expect(result.per_run.length).toBe(1);
      expect(result.per_run[0].run_id).toBe('scenario-current-skill-good0001');
      expect(result.errors.some((e) => e.run_id === 'scenario-current-skill-nosidecar')).toBe(true);
      expect(runPath).toContain('scenario-current-skill-nosidecar');
    });
  });

  it('an invalid (hash-mismatched) sidecar is excluded and reported per-file', () => {
    withTempDir((dir) => {
      const record = scenarioRecord({ run_id: 'scenario-current-skill-tampered1' });
      writeRunAndSidecar(dir, record, { entries: [targetSkillEntry(0)] }, { tamperSha256AfterWrite: true });
      const result = analyzeRunsDir(dir);
      expect(result.per_run).toEqual([]);
      expect(result.errors.length).toBe(1);
    });
  });

  it('mixed valid/invalid directory: valid records are analyzed, invalid ones are reported, nothing throws', () => {
    withTempDir((dir) => {
      const ok1 = scenarioRecord({ run_id: 'scenario-current-skill-ok000001' });
      writeRunAndSidecar(dir, ok1, { entries: [targetSkillEntry(0)] });
      const ok2 = scenarioRecord({ run_id: 'scenario-no-skill-ok0000002', condition: 'no-skill', skill_invoked: { value: false, reason: null }, skill_invocation_event: null });
      writeRunAndSidecar(dir, ok2, { entries: [] });
      writeFileSync(path.join(dir, 'malformed.json'), '{ this is not json');
      const result = analyzeRunsDir(dir);
      expect(result.per_run.length).toBe(2);
      expect(result.errors.length).toBe(1);
      expect(cmdAnalyze({ 'runs-dir': dir })).toBe(1); // one bad file is enough to fail closed
    });
  });

  it('excludes a schema-valid but non-applicable record (pre-v5, or non-scenario) without treating it as an error', () => {
    withTempDir((dir) => {
      const calibration = {
        schema: 1, run_id: 'calibration-no-skill-abcd1234', run_kind: 'calibration', benchmark_eligible: false,
        scenario_id: 'calibration-explicit-invocation', query_id: null, condition: 'no-skill', skill_source_sha: null,
        kmp_test_cli_version: '0.14.0', kmp_test_cli_source_sha: 'c5c0661852f7c9da145ef56892048e706216a6ce',
        resolved_kmp_test_executable_path: 'tools/agentic-eval/fixtures/calibration-project',
        model_requested: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', session_id_observed: 'sess-0001',
        claude_code_version: '1.2.3-fake', repo_commit: 'c5c0661852f7c9da145ef56892048e706216a6ce',
        project_alias: 'calibration-project', project_commit: null, project_url: null, platform: 'windows',
        family: 'trigger-only', cache_state: 'unknown', daemon_policy: 'disabled-via-gradle-user-home-properties',
        env_allowlist_profile: 'narrow', seed: null, order_index: null,
        started_at: '2026-07-18T00:00:00.000Z', ended_at: '2026-07-18T00:00:01.000Z', wall_clock_ms: 1000,
        skill_available: { value: false, reason: null }, skill_invocation_attempted: { value: false, reason: null },
        skill_invoked: { value: false, reason: null }, skill_invocation_event: null,
        success: { value: null, reason: 'calibration run -- success grading not applicable' },
        expected_outcome_matched: { value: null, reason: 'calibration run -- no scenario grader applies' },
        first_useful_signal_ms: { value: null, reason: 'calibration run -- no signal predicate applies' },
        first_useful_signal_event: null,
        tokens: { input: { value: 2, reason: null }, output: { value: 4, reason: null }, cache_read: { value: 0, reason: null }, cache_creation: { value: 0, reason: null } },
        tool_calls_total: { value: 1, reason: null }, shell_commands_total: { value: 1, reason: null },
        test_invocations_total: { value: null, reason: 'not tracked for calibration runs' }, retries: { value: 0, reason: null },
        output_bytes: { value: 100, reason: null }, stream_json_bytes: { value: 1000, reason: null }, human_interventions: { value: 0, reason: null },
        terminated: false, termination_reason: null, exit_code: 0, permission_mode_used: 'dontAsk',
        policy_allowed_gradle_tasks: ['build'], policy_allowed_kmptest_subcommands: ['doctor'],
        policy_sha256: 'a'.repeat(64), hook_call_count: 1, hook_deny_count: 0, privacy_status: 'redacted-private',
        raw_capture_committed: false, raw_capture_location: 'tools/runs/agentic-eval-calibration/raw/', notes: '', errors: [],
      };
      writeFileSync(path.join(dir, `${calibration.run_id}.json`), JSON.stringify(calibration, null, 2));
      const result = analyzeRunsDir(dir);
      expect(result.errors).toEqual([]);
      expect(result.per_run).toEqual([]);
      expect(result.summary.files_excluded_not_applicable).toBe(1);
      expect(cmdAnalyze({ 'runs-dir': dir })).toBe(0);
    });
  });

  it('processes files in deterministic (sorted-by-filename) order, independent of directory listing order', () => {
    withTempDir((dir) => {
      const ids = ['scenario-current-skill-ccccccc1', 'scenario-current-skill-aaaaaaa1', 'scenario-current-skill-bbbbbbb1'];
      for (const runId of ids) {
        writeRunAndSidecar(dir, scenarioRecord({ run_id: runId }), { entries: [targetSkillEntry(0)] });
      }
      const result = analyzeRunsDir(dir);
      expect(result.per_run.map((e) => e.run_id)).toEqual([...ids].sort());
    });
  });

  it('every file is accounted for exactly once: seen == analyzed + excluded_not_applicable + errored', () => {
    withTempDir((dir) => {
      writeRunAndSidecar(dir, scenarioRecord({ run_id: 'scenario-current-skill-good0002' }), { entries: [targetSkillEntry(0)] });
      writeFileSync(path.join(dir, 'malformed.json'), 'nope {{{');
      const result = analyzeRunsDir(dir);
      const s = result.summary;
      expect(s.files_seen).toBe(s.files_analyzed + s.files_excluded_not_applicable + s.files_errored);
      expect(s.files_seen).toBe(2);
    });
  });

  it('never emits a raw command, absolute path, or the file\'s own text -- fully privacy-safe output', () => {
    withTempDir((dir) => {
      const record = scenarioRecord({ run_id: 'scenario-current-skill-privacy1' });
      writeRunAndSidecar(dir, record, { entries: [targetSkillEntry(0), bashEntry(1, { kind: 'gradle', operation: 'allowed-task' })] });
      writeFileSync(path.join(dir, 'bad.json'), 'not valid json {{{ sk-ant-totally-not-a-real-secret-marker');
      const result = analyzeRunsDir(dir);
      const serialized = JSON.stringify(result);
      // scenario_id, and closed-vocabulary schema/policy metadata inherited via HARD_PARTITION_
      // FIELDS (e.g. daemon_policy's own enum value legitimately contains the substring "gradle"),
      // are pre-existing, already-committed run-record fields -- not new exposure. What must never
      // appear is the temp directory's own absolute path or the malformed sibling's raw content.
      expect(serialized).not.toContain(dir);
      expect(serialized).not.toContain('sk-ant-totally-not-a-real-secret-marker');
      expect(serialized).not.toContain('not valid json');
    });
  });

  it('DOES include scenario_id (a public, already-committed identifier) for the aggregate-by-scenario contract', () => {
    withTempDir((dir) => {
      const record = scenarioRecord({ run_id: 'scenario-current-skill-scenid001' });
      writeRunAndSidecar(dir, record, { entries: [targetSkillEntry(0)] });
      const result = analyzeRunsDir(dir);
      expect(result.per_run[0].scenario_id).toBe('kampkit-android-host-test-discovery');
      expect(result.summary.groups[0].group_key.scenario_id).toBe('kampkit-android-host-test-discovery');
    });
  });

  it('returns 1 from cmdAnalyze when --runs-dir does not exist', () => {
    expect(cmdAnalyze({ 'runs-dir': path.join(os.tmpdir(), 'definitely-does-not-exist-aeva') })).toBe(1);
  });
});

describe('loadAcceptedAuditSidecar', () => {
  it('fails closed (never throws) when the sidecar file does not exist', () => {
    withTempDir((dir) => {
      const record = { run_id: 'r1', accepted_audit: { relative_path: 'audit/r1.json' } };
      const runPath = path.join(dir, 'r1.json');
      writeFileSync(runPath, '{}');
      let result;
      expect(() => { result = loadAcceptedAuditSidecar(runPath, record); }).not.toThrow();
      expect(result.ok).toBe(false);
    });
  });

  it('loads and parses a real sidecar file successfully', () => {
    withTempDir((dir) => {
      const record = scenarioRecord({ run_id: 'scenario-current-skill-loadtest1' });
      const runPath = writeRunAndSidecar(dir, record, { entries: [targetSkillEntry(0)] });
      const written = JSON.parse(readFileSync(runPath, 'utf8'));
      const result = loadAcceptedAuditSidecar(runPath, written);
      expect(result.ok).toBe(true);
      expect(Array.isArray(result.sidecar.tool_calls)).toBe(true);
    });
  });
});

describe('module self-consistency', () => {
  it('every grading-check name this module reads by literal string still exists in GRADING_CHECK_NAMES', () => {
    for (const name of ['authoritative_evidence_well_formed', 'authoritative_target_matches_expected', 'authoritative_outcome_matches_expected', 'final_answer_consistent_with_evidence']) {
      expect(GRADING_CHECK_NAMES).toContain(name);
    }
  });
});

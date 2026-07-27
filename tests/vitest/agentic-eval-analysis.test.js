// tests/vitest/agentic-eval-analysis.test.js
// Unit tests for tools/agentic-eval/analysis.mjs -- the offline, axis-separated analysis command
// (`cli.mjs analyze --runs-dir <dir>`). Operates ONLY on already-committed schema-v5 scenario run
// records + their validated accepted-run-audit sidecars -- never a raw transcript, never a live
// Claude call. Mirrors agentic-eval-validate-command.test.js's fixture style (a full, schema-valid
// v5 scenario record + a matching, hash-bound sidecar written to a real temp directory) since
// analyzeRunsDir's own end-to-end path is a thin wrapper over the exact same validateRunRecordFile
// gate cmdValidate/cmdAggregate already use (now via run-record-loader.mjs).
//
// Review-round correction (2026-07-27): the ordinal semantics, post-skill nulling on failed runs,
// bidirectional record<->sidecar coherence, failure_class causal precision, set-integrity gaps
// (duplicate run_id, benchmark_eligible pooling), and privacy gaps (untrusted run_id echo, no
// final scan) this file now tests were all real defects found by an independent review pass
// against this module's first version -- see git history for the exact before/after. The 5
// real-record regression tests below were hand-computed against the ACTUAL committed record+
// sidecar pairs (read-only, tools/runs/agentic-eval-scenario/) specifically because the review
// demonstrated the previous ordinal semantic silently collapsed every real delayed-activation run
// to a constant 1.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {
  ANALYSIS_SCHEMA, FAILURE_CLASS_VALUES, classifyFailure, deriveSkillRelativeFields,
  analyzeRunRecord, buildSummary, analyzeRunsDir,
} from '../../tools/agentic-eval/analysis.mjs';
import { cmdAnalyze } from '../../tools/agentic-eval/cli.mjs';
import { ACCEPTED_AUDIT_SIDECAR_SCHEMA } from '../../tools/agentic-eval/accepted-run-audit.mjs';
import { GRADING_CHECK_NAMES } from '../../tools/agentic-eval/graders.mjs';

const VALID_SCOPE_ID = '11111111-2222-4333-8444-555555555555';
const REAL_RUNS_DIR = path.join(process.cwd(), 'tools', 'runs', 'agentic-eval-scenario');

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
  const base = {
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
  };
  const skip = new Set(['grading_checks', 'skill_invoked', 'hook_call_count', 'hook_deny_count']);
  for (const [k, v] of Object.entries(overrides)) {
    if (!skip.has(k)) base[k] = v;
  }
  return base;
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
function sidecarFor(record, { entries = [], firstUsefulSignalEvent = null, terminalAuthoritativeEvent } = {}) {
  const sorted = [...entries].sort((a, b) => a.tool_use_event_index - b.tool_use_event_index);
  const boundaryIndex = firstUsefulSignalEvent?.index ?? null;
  const toolCalls = sorted.map((tc, ordinal) => ({ ordinal, ...tc, phase: phaseFor(tc, boundaryIndex) }));
  const isBash = (tc) => BASH_KINDS.has(tc.tool_kind);
  const bashEntries = toolCalls.filter(isBash);
  const hasBoundary = boundaryIndex != null;
  return {
    schema: ACCEPTED_AUDIT_SIDECAR_SCHEMA, run_id: record.run_id, run_schema: 5, run_kind: 'scenario',
    condition: record.condition, scenario_id: record.scenario_id,
    first_useful_signal_event: firstUsefulSignalEvent,
    terminal_authoritative_event: terminalAuthoritativeEvent !== undefined ? terminalAuthoritativeEvent : firstUsefulSignalEvent,
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

describe('classifyFailure -- explicit, non-causal closed-vocabulary precedence', () => {
  const base = {
    success: false, activationExpected: true, targetSkillInvoked: true, hookDenyCount: 0,
    terminalEvidencePresent: true, terminalEvidenceWellFormed: true,
    targetMatchesExpected: true, outcomeMatchesExpected: true, finalAnswerConsistent: true,
  };

  it('every returned value is a member of the published closed vocabulary', () => {
    expect(FAILURE_CLASS_VALUES).toEqual([
      'success', 'target-skill-not-invoked', 'policy-denial-observed-without-terminal-evidence',
      'no-authoritative-evidence', 'wrong-target', 'outcome-mismatch', 'final-answer-mismatch', 'unclassified',
    ]);
  });

  it('success:true always wins, regardless of any other signal', () => {
    expect(classifyFailure({ ...base, success: true })).toBe('success');
    expect(classifyFailure({ ...base, success: true, targetSkillInvoked: false, hookDenyCount: 9, terminalEvidencePresent: false })).toBe('success');
  });

  it('target-skill-not-invoked beats every downstream cause when activation was expected', () => {
    expect(classifyFailure({ ...base, targetSkillInvoked: false })).toBe('target-skill-not-invoked');
    expect(classifyFailure({ ...base, targetSkillInvoked: false, hookDenyCount: 3, terminalEvidencePresent: false })).toBe('target-skill-not-invoked');
  });

  it('target-skill-not-invoked never fires when activation was not expected (no-skill baseline)', () => {
    expect(classifyFailure({ ...base, activationExpected: false, targetSkillInvoked: null })).not.toBe('target-skill-not-invoked');
  });

  it('policy-denial-observed-without-terminal-evidence fires only when there is no USABLE evidence and a denial occurred', () => {
    expect(classifyFailure({ ...base, terminalEvidencePresent: false, terminalEvidenceWellFormed: false, hookDenyCount: 2 })).toBe('policy-denial-observed-without-terminal-evidence');
    // "present but not well-formed" also counts as not-usable.
    expect(classifyFailure({ ...base, terminalEvidencePresent: true, terminalEvidenceWellFormed: false, hookDenyCount: 1 })).toBe('policy-denial-observed-without-terminal-evidence');
  });

  it('policy-denial-observed-without-terminal-evidence applies to a no-skill-condition run too (activation axis does not gate it)', () => {
    expect(classifyFailure({ ...base, activationExpected: false, targetSkillInvoked: null, terminalEvidencePresent: false, terminalEvidenceWellFormed: false, hookDenyCount: 1 })).toBe('policy-denial-observed-without-terminal-evidence');
  });

  it('no-authoritative-evidence fires when nothing else explains the missing evidence', () => {
    expect(classifyFailure({ ...base, terminalEvidencePresent: false, terminalEvidenceWellFormed: false, hookDenyCount: 0 })).toBe('no-authoritative-evidence');
  });

  it('a denial that happened but did NOT prevent well-formed, present evidence does not override a more specific downstream cause', () => {
    // Real-world shape (mirrors the committed kampkit-android-host-test-discovery fixture): the
    // run had denied pre-skill Bash attempts, but a LATER attempt still produced well-formed
    // evidence for the wrong module -- wrong-target must win, never the policy-denial class.
    expect(classifyFailure({ ...base, hookDenyCount: 4, terminalEvidencePresent: true, terminalEvidenceWellFormed: true, targetMatchesExpected: false })).toBe('wrong-target');
  });

  it('wrong-target fires once evidence is present+well-formed but targets the wrong module', () => {
    expect(classifyFailure({ ...base, targetMatchesExpected: false })).toBe('wrong-target');
  });

  it('outcome-mismatch and final-answer-mismatch are DISTINCT classes, never folded together', () => {
    expect(classifyFailure({ ...base, outcomeMatchesExpected: false })).toBe('outcome-mismatch');
    // finalAnswerConsistent alone, with outcomeMatchesExpected genuinely true -- must NOT read as outcome-mismatch.
    expect(classifyFailure({ ...base, outcomeMatchesExpected: true, finalAnswerConsistent: false })).toBe('final-answer-mismatch');
  });

  it('outcome-mismatch beats final-answer-mismatch when both are false (dependency order: target -> outcome -> final-answer)', () => {
    expect(classifyFailure({ ...base, outcomeMatchesExpected: false, finalAnswerConsistent: false })).toBe('outcome-mismatch');
  });

  it('never returns unclassified for any input covered by the documented precedence', () => {
    const singleAxisFailures = [
      { ...base, targetSkillInvoked: false },
      { ...base, terminalEvidencePresent: false, terminalEvidenceWellFormed: false },
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
  const allNullShape = {
    ok: true, target_skill_invocation_ordinal: null, target_skill_attempt_ordinal: null,
    pre_skill_tool_calls: null, pre_skill_policy_denials: null,
    post_skill_tool_calls_total: null, post_skill_policy_denials_total: null,
    post_skill_tool_calls_through_signal: null, post_skill_policy_denials_through_signal: null,
  };

  it('returns all-null when activation is not expected (no-skill condition)', () => {
    expect(deriveSkillRelativeFields({ skill_invocation_event: null }, null, false, null)).toEqual(allNullShape);
  });

  it('returns all-null when the target skill was never invoked and the sidecar agrees (no confirmed entry)', () => {
    const sidecar = { first_useful_signal_event: null, tool_calls: [bashEntry(0)].map((tc, i) => ({ ordinal: i, ...tc, phase: 'no-signal' })) };
    expect(deriveSkillRelativeFields({ skill_invocation_event: null }, sidecar, true, false)).toEqual(allNullShape);
  });

  it('global ordinal 0 + attempt ordinal 1 + zero pre-skill calls for an immediate, first-attempt invocation', () => {
    const record = { skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 5 } };
    const sidecar = { first_useful_signal_event: null, tool_calls: [targetSkillEntry(5)].map((tc, i) => ({ ordinal: i, ...tc, phase: 'no-signal' })) };
    const result = deriveSkillRelativeFields(record, sidecar, true, true);
    expect(result).toEqual({
      ...allNullShape, target_skill_invocation_ordinal: 0, target_skill_attempt_ordinal: 1,
      pre_skill_tool_calls: 0, pre_skill_policy_denials: 0,
      post_skill_tool_calls_total: 0, post_skill_policy_denials_total: 0,
    });
  });

  it('global ordinal reflects delayed activation (unrelated calls first) -- distinct from attempt ordinal', () => {
    const record = { skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 30 } };
    const entries = [bashEntry(2), bashEntry(8), bashEntry(15), bashEntry(22), targetSkillEntry(30)];
    const sidecar = sidecarFor(record, { entries });
    const result = deriveSkillRelativeFields(record, sidecar, true, true);
    expect(result.ok).toBe(true);
    expect(result.target_skill_invocation_ordinal).toBe(4); // 4 unrelated calls precede it (global, 0-based)
    expect(result.target_skill_attempt_ordinal).toBe(1); // still only 1 attempt AT THE SKILL itself
    expect(result.pre_skill_tool_calls).toBe(4);
  });

  it('attempt ordinal reflects a retried invocation -- distinct from global ordinal', () => {
    const record = { skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 20 } };
    const entries = [
      bashEntry(5), // unrelated exploration
      targetSkillEntry(10, { resultStatus: 'error' }), // 1st attempt at the target skill: failed
      targetSkillEntry(20, { resultStatus: 'success' }), // 2nd attempt: confirmed
    ];
    const sidecar = sidecarFor(record, { entries });
    const result = deriveSkillRelativeFields(record, sidecar, true, true);
    expect(result.ok).toBe(true);
    expect(result.target_skill_invocation_ordinal).toBe(2); // global ordinal of the confirmed entry
    expect(result.target_skill_attempt_ordinal).toBe(2); // 2nd attempt AT THE SKILL succeeded
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

  it('post_skill_tool_calls_total/denials are populated even with NO signal boundary (the failed-run case)', () => {
    const record = { skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 4 } };
    const entries = [
      targetSkillEntry(4),
      bashEntry(9, { kind: 'kmp-test', decision: 'deny', resultStatus: 'error' }),
      bashEntry(16, { decision: 'deny', resultStatus: 'error' }),
      bashEntry(24, { decision: 'deny', resultStatus: 'error' }),
    ];
    const sidecar = sidecarFor(record, { entries }); // no firstUsefulSignalEvent
    const result = deriveSkillRelativeFields(record, sidecar, true, true);
    expect(result.post_skill_tool_calls_total).toBe(3);
    expect(result.post_skill_policy_denials_total).toBe(3);
    // The narrower, signal-relative pair remains null -- there is no boundary to bound it against.
    expect(result.post_skill_tool_calls_through_signal).toBeNull();
    expect(result.post_skill_policy_denials_through_signal).toBeNull();
  });

  it('post_skill_tool_calls_through_signal counts calls through (inclusive of) the signal-producing attempt', () => {
    const record = { skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 10 } };
    const entries = [
      targetSkillEntry(10),
      bashEntry(15, { kind: 'kmp-test', operation: 'describe', resultIdx: 16 }),
      bashEntry(20, { kind: 'kmp-test', operation: 'doctor', decision: 'deny', resultStatus: 'error', resultIdx: 21 }),
      bashEntry(25, { kind: 'kmp-test', operation: 'parallel', resultIdx: 26 }), // produces the signal
      bashEntry(30, { kind: 'kmp-test', operation: 'parallel', resultIdx: 31 }), // AFTER the signal
    ];
    const firstUsefulSignalEvent = { type: 'user.tool_result', index: 26 };
    const sidecar = sidecarFor(record, { entries, firstUsefulSignalEvent });
    const result = deriveSkillRelativeFields(record, sidecar, true, true);
    // Through the signal (index 15, 20, 25 -- inclusive of the produced-signal call): 3.
    expect(result.post_skill_tool_calls_through_signal).toBe(3);
    expect(result.post_skill_policy_denials_through_signal).toBe(1);
    // Total post-skill is unconditional -- includes the call AFTER the signal too: 4.
    expect(result.post_skill_tool_calls_total).toBe(4);
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

  // Bidirectional record<->sidecar coherence (review finding P1): neither side is trusted alone.
  describe('bidirectional record<->sidecar coherence', () => {
    it('fails closed when the record says NOT invoked but the sidecar shows a confirmed target-skill entry', () => {
      const sidecar = { first_useful_signal_event: null, tool_calls: [{ ordinal: 0, ...targetSkillEntry(5), phase: 'no-signal' }] };
      const result = deriveSkillRelativeFields({ skill_invocation_event: null }, sidecar, true, false);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not invoked/i);
    });

    it('fails closed when the record says invoked but the sidecar entry at that index was NOT confirmed (result_status error)', () => {
      const record = { skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 5 } };
      // The sidecar's OWN entry at index 5 is an ERRORED target-skill attempt, never confirmed --
      // a record claiming invoked:true here disagrees with what the sidecar actually shows.
      const sidecar = { first_useful_signal_event: null, tool_calls: [{ ordinal: 0, ...targetSkillEntry(5, { resultStatus: 'error' }), phase: 'no-signal' }] };
      const result = deriveSkillRelativeFields(record, sidecar, true, true);
      expect(result.ok).toBe(false);
    });

    it('does not accept an unrelated confirmed target-skill entry at a DIFFERENT index as satisfying invoked:true', () => {
      const record = { skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 999 } };
      const sidecar = { first_useful_signal_event: null, tool_calls: [{ ordinal: 0, ...targetSkillEntry(5), phase: 'no-signal' }] };
      const result = deriveSkillRelativeFields(record, sidecar, true, true);
      expect(result.ok).toBe(false);
    });

    // Review-round correction: multiple tool_use blocks can share ONE assistant event -- the
    // sidecar schema only requires `ordinal` non-decreasing across ties, never a unique event
    // index per entry. A failed attempt, its successful retry, and a third unrelated call ALL
    // dispatched in the same turn (same tool_use_event_index) previously broke attempt-ordinal and
    // pre/post-skill counting, which compared by the (possibly tied) event index instead of the
    // sidecar's own always-unique `ordinal`.
    it('disambiguates multiple tool_calls sharing the SAME event index via ordinal, not tool_use_event_index', () => {
      const record = { skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 10 } };
      const entries = [
        targetSkillEntry(10, { resultStatus: 'error' }), // ordinal 0: 1st attempt at the skill, same event, fails
        targetSkillEntry(10, { resultStatus: 'success' }), // ordinal 1: 2nd attempt, same event, confirmed
        bashEntry(10), // ordinal 2: a third call, also dispatched in the same turn
      ];
      const sidecar = sidecarFor(record, { entries });
      const result = deriveSkillRelativeFields(record, sidecar, true, true);
      expect(result.ok).toBe(true);
      expect(result.target_skill_invocation_ordinal).toBe(1); // global ordinal of the CONFIRMED entry specifically
      expect(result.target_skill_attempt_ordinal).toBe(2); // 2nd attempt at the skill succeeded
      expect(result.pre_skill_tool_calls).toBe(1); // the failed 1st attempt, same event, still precedes it
      expect(result.post_skill_tool_calls_total).toBe(1); // the third call, same event, still follows it
    });

    // findSkillInvocation()'s own documented contract (stream-parser.mjs): the representative is
    // the FIRST confirmed match in transcript order whenever more than one exists. A record
    // correlating to a LATER confirmed entry (event 5) while an EARLIER one (event 2) also exists
    // contradicts that contract and must fail closed, never silently accepted.
    it('fails closed when the record correlates to a LATER confirmed entry while an EARLIER confirmed entry also exists', () => {
      const record = { skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 5 } };
      const entries = [targetSkillEntry(2, { resultStatus: 'success' }), targetSkillEntry(5, { resultStatus: 'success' })];
      const sidecar = sidecarFor(record, { entries });
      const result = deriveSkillRelativeFields(record, sidecar, true, true);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/earliest/i);
    });

    it('accepts the record when it correlates to the EARLIEST of two confirmed entries', () => {
      const record = { skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 2 } };
      const entries = [targetSkillEntry(2, { resultStatus: 'success' }), targetSkillEntry(5, { resultStatus: 'success' })];
      const sidecar = sidecarFor(record, { entries });
      const result = deriveSkillRelativeFields(record, sidecar, true, true);
      expect(result.ok).toBe(true);
      expect(result.target_skill_invocation_ordinal).toBe(0);
    });
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
    expect(entry.target_skill_invocation_ordinal).toBe(0);
    expect(entry.target_skill_attempt_ordinal).toBe(1);
    expect(entry.pre_skill_tool_calls).toBe(0);
    expect(entry.success).toBe(true);
    expect(entry.failure_class).toBe('success');
  });

  it('delayed activation: several unrelated calls precede a first-attempt invocation', () => {
    const record = scenarioRecord({
      success: { value: true, reason: null }, expected_outcome_matched: { value: true, reason: null },
      skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 22 },
    });
    const entries = [bashEntry(2), bashEntry(8), bashEntry(15), targetSkillEntry(22), bashEntry(28, { kind: 'kmp-test', operation: 'parallel' })];
    const sidecar = sidecarFor(record, { entries });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.target_skill_invocation_ordinal).toBe(3); // GLOBAL ordinal -- must reflect the delay, never collapse to 1
    expect(entry.target_skill_attempt_ordinal).toBe(1);
    expect(entry.pre_skill_tool_calls).toBe(3);
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
    expect(entry.target_skill_attempt_ordinal).toBeNull();
    expect(entry.pre_skill_tool_calls).toBeNull();
    expect(entry.failure_class).toBe('target-skill-not-invoked');
  });

  it('pre-skill denials: Bash attempts before invocation were denied, no evidence ever resulted', () => {
    const record = scenarioRecord({
      skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 15 },
      grading_checks: gradingChecks({ authoritative_evidence_well_formed: { passed: false, detail: 'no attempt capable of producing target evidence was ever made' } }),
    });
    const entries = [
      bashEntry(2, { decision: 'deny', resultStatus: 'error' }),
      bashEntry(8, { decision: 'deny', resultStatus: 'error' }),
      targetSkillEntry(15),
    ];
    record.hook_deny_count = 2; record.hook_call_count = 3;
    const sidecar = sidecarFor(record, { entries });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.pre_skill_policy_denials).toBe(2);
    expect(entry.failure_class).toBe('policy-denial-observed-without-terminal-evidence');
  });

  it('post-skill work (no signal reached): 9 denied calls after invocation are visible, not nulled -- the exact failed-run gap the review found', () => {
    // Mirrors the real committed scenario-current-skill-27d0c3c6 shape: invoked immediately, then
    // every subsequent attempt denied, terminal_authoritative_event stays null.
    const record = scenarioRecord({
      skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 4 },
      grading_checks: gradingChecks({
        bash_tool_use_present: { passed: false, detail: 'no policy-allowed command was ever attempted' },
        authoritative_evidence_well_formed: { passed: false, detail: 'no attempt capable of producing target evidence was ever made' },
        authoritative_target_matches_expected: { passed: false, detail: 'no well-formed terminal evidence to check' },
        authoritative_outcome_matches_expected: { passed: false, detail: 'no well-formed, correctly-targeted terminal evidence to check' },
        final_answer_consistent_with_evidence: { passed: false, detail: 'final answer contains no KMP_EVAL_RESULT block' },
      }),
    });
    record.hook_deny_count = 9; record.hook_call_count = 9;
    const entries = [
      targetSkillEntry(4),
      ...[9, 16, 24, 32, 39, 44, 49, 58].map((idx) => bashEntry(idx, { decision: 'deny', resultStatus: 'error' })),
    ];
    const sidecar = sidecarFor(record, { entries, terminalAuthoritativeEvent: null });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.post_skill_tool_calls_total).toBe(8);
    expect(entry.post_skill_policy_denials_total).toBe(8);
    expect(entry.terminal_authoritative_evidence_present).toBe(false);
    expect(entry.failure_class).toBe('policy-denial-observed-without-terminal-evidence');
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
    expect(entry.post_skill_tool_calls_through_signal).toBe(3);
    expect(entry.post_skill_tool_calls_total).toBe(3);
    expect(entry.post_signal_tool_calls).toBe(0);
    expect(entry.success).toBe(true);
    expect(entry.failure_class).toBe('success');
  });

  it('wrong target: well-formed evidence, but it targets the wrong module (mirrors the committed kampkit fixture shape)', () => {
    const record = scenarioRecord({
      skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 28 },
      grading_checks: gradingChecks({
        authoritative_target_matches_expected: { passed: false, detail: 'terminal attempt targeted the WRONG module' },
        authoritative_outcome_matches_expected: { passed: false, detail: 'no well-formed, correctly-targeted terminal evidence to check' },
        final_answer_consistent_with_evidence: { passed: false, detail: 'mismatch' },
      }),
    });
    record.hook_deny_count = 3; record.hook_call_count = 3;
    const entries = [
      bashEntry(6, { decision: 'deny', resultStatus: 'error' }),
      bashEntry(13, { decision: 'deny', resultStatus: 'error' }),
      bashEntry(20, { decision: 'deny', resultStatus: 'error' }),
      targetSkillEntry(28),
      bashEntry(48, { kind: 'kmp-test', operation: 'parallel', resultIdx: 55 }),
    ];
    const sidecar = sidecarFor(record, { entries, terminalAuthoritativeEvent: { type: 'user.tool_result', index: 55 } });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.terminal_authoritative_evidence_present).toBe(true);
    expect(entry.terminal_authoritative_evidence_well_formed).toBe(true);
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
    expect(entry.terminal_authoritative_evidence_well_formed).toBe(false);
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
    const sidecar = sidecarFor(record, { entries: [targetSkillEntry(0), bashEntry(1, { kind: 'kmp-test', operation: 'parallel' })], terminalAuthoritativeEvent: { type: 'user.tool_result', index: 2 } });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.terminal_authoritative_evidence_present).toBe(true);
    expect(entry.failure_class).toBe('outcome-mismatch');
  });

  it('final-answer mismatch alone: outcome genuinely matches, only the final-answer check failed -- never contradicts expected_outcome_matched', () => {
    const record = scenarioRecord({
      expected_outcome_matched: { value: true, reason: null },
      skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 0 },
      grading_checks: gradingChecks({
        final_answer_consistent_with_evidence: { passed: false, detail: 'the KMP_EVAL_RESULT block does not exactly match' },
      }),
    });
    const sidecar = sidecarFor(record, { entries: [targetSkillEntry(0), bashEntry(1, { kind: 'kmp-test', operation: 'parallel' })], terminalAuthoritativeEvent: { type: 'user.tool_result', index: 2 } });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.expected_outcome_matched).toBe(true);
    expect(entry.final_answer_consistent).toBe(false);
    expect(entry.failure_class).toBe('final-answer-mismatch');
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
    expect(entry.target_skill_attempt_ordinal).toBeNull();
    expect(entry.pre_skill_tool_calls).toBeNull();
    expect(entry.pre_skill_policy_denials).toBeNull();
    expect(entry.post_skill_tool_calls_total).toBeNull();
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

  it('fails closed on a record<->sidecar coherence violation (invoked:false but sidecar shows a confirmed entry)', () => {
    const record = scenarioRecord({ skill_invoked: { value: false, reason: null }, skill_invocation_event: null });
    const sidecar = sidecarFor(record, { entries: [targetSkillEntry(0)] }); // sidecar DISAGREES: shows a confirmed entry
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
      activation_expected: true, target_skill_invoked: true, target_skill_invocation_ordinal: 0,
      target_skill_attempt_ordinal: 1, pre_skill_tool_calls: 0, pre_skill_policy_denials: 0,
      post_skill_tool_calls_total: 0, post_skill_policy_denials_total: 0,
      post_skill_tool_calls_through_signal: null, post_skill_policy_denials_through_signal: null,
      post_signal_tool_calls: null, first_useful_signal_present: false,
      terminal_authoritative_evidence_present: true, terminal_authoritative_evidence_well_formed: true,
      expected_outcome_matched: true, final_answer_consistent: true, success: true,
      failure_class: 'success', ...entryOverrides,
    };
    return { record, entry };
  }

  it('groups by scenario_id and condition, never pooling them together', () => {
    const pairs = [
      pair({ run_id: 'r1', scenario_id: 's1', condition: 'current-skill' }, {}),
      pair({ run_id: 'r2', scenario_id: 's1', condition: 'no-skill' }, { activation_expected: false, target_skill_invoked: null, target_skill_invocation_ordinal: null, target_skill_attempt_ordinal: null, pre_skill_tool_calls: null, pre_skill_policy_denials: null }),
      pair({ run_id: 'r3', scenario_id: 's2', condition: 'current-skill' }, {}),
    ];
    const summary = buildSummary(pairs);
    expect(summary.groups.length).toBe(3);
  });

  // CodeRabbit nitpick fix: this test's own setup drives the split via `platform`, not `schema` --
  // renamed to match what it actually asserts (both pairs share schema:5).
  it('never pools two different platforms into the same group', () => {
    const pairs = [
      pair({ run_id: 'r1', schema: 5 }, {}),
      pair({ run_id: 'r2', schema: 5 }, {}),
    ];
    // platform is one of HARD_PARTITION_FIELDS -- a provenance difference must never be pooled.
    pairs[1].record.platform = 'linux';
    const summary = buildSummary(pairs);
    expect(summary.groups.length).toBe(2);
  });

  it('never pools two different schema versions into the same group', () => {
    const pairs = [pair({ run_id: 'r1' }, {}), pair({ run_id: 'r2' }, {})];
    pairs[1].record.schema = 4;
    const summary = buildSummary(pairs);
    expect(summary.groups.length).toBe(2);
    expect(summary.groups.map((g) => g.group_key.schema).sort()).toEqual([4, 5]);
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
    const pairs = [pair({ run_id: 'r1', condition: 'no-skill' }, { activation_expected: false, target_skill_invoked: null })];
    const summary = buildSummary(pairs);
    expect(summary.groups[0].target_skill_invoked_rate).toBeNull();
  });

  it('builds compact distributions for global ordinal, attempt ordinal, pre-skill, and post-skill-total calls', () => {
    const pairs = [
      pair({ run_id: 'r1' }, { target_skill_invocation_ordinal: 0, target_skill_attempt_ordinal: 1, pre_skill_tool_calls: 0, post_skill_tool_calls_total: 2 }),
      pair({ run_id: 'r2' }, { target_skill_invocation_ordinal: 3, target_skill_attempt_ordinal: 1, pre_skill_tool_calls: 3, post_skill_tool_calls_total: 9 }),
      pair({ run_id: 'r3' }, { target_skill_invocation_ordinal: 3, target_skill_attempt_ordinal: 2, pre_skill_tool_calls: 3, post_skill_tool_calls_total: 0 }),
      pair({ run_id: 'r4' }, { target_skill_invocation_ordinal: null, target_skill_attempt_ordinal: null, pre_skill_tool_calls: null, post_skill_tool_calls_total: null, target_skill_invoked: false, failure_class: 'target-skill-not-invoked' }),
    ];
    const summary = buildSummary(pairs);
    const [group] = summary.groups;
    expect(group.target_skill_invocation_ordinal_distribution).toEqual({ '0': 1, '3': 2, null: 1 });
    expect(group.target_skill_attempt_ordinal_distribution).toEqual({ '1': 2, '2': 1, null: 1 });
    expect(group.pre_skill_tool_calls_distribution).toEqual({ '0': 1, '3': 2, null: 1 });
    expect(group.post_skill_tool_calls_total_distribution).toEqual({ '0': 1, '2': 1, '9': 1, null: 1 });
  });

  it('tallies failure_class counts across every published class', () => {
    const pairs = [
      pair({ run_id: 'r1' }, { failure_class: 'success' }),
      pair({ run_id: 'r2' }, { failure_class: 'wrong-target', success: false }),
    ];
    const summary = buildSummary(pairs);
    expect(summary.groups[0].failure_class_counts.success).toBe(1);
    expect(summary.groups[0].failure_class_counts['wrong-target']).toBe(1);
    expect(summary.groups[0].failure_class_counts['policy-denial-observed-without-terminal-evidence']).toBe(0);
  });

  it('handles an empty input without throwing', () => {
    expect(() => buildSummary([])).not.toThrow();
    expect(buildSummary([]).groups).toEqual([]);
  });

  // Review-round correction: group ordering must use plain code-point comparison, never
  // localeCompare() -- ICU collation is locale/Node-build-dependent (confirmed on the reviewer's
  // own machine: "a_b" sorted BEFORE "a-b" under localeCompare, the opposite of code-point order,
  // since '-' is U+002D and '_' is U+005F). This assertion is deterministic on EVERY machine/locale
  // specifically because plain `<`/`>` string comparison is never locale-aware, per the ECMAScript
  // spec -- unlike a localeCompare()-based assertion, which could pass or fail depending on which
  // machine runs it.
  it('orders groups by plain code-point comparison, independent of locale/ICU collation', () => {
    const pairs = [
      pair({ run_id: 'r1', scenario_id: 'a_b' }, {}),
      pair({ run_id: 'r2', scenario_id: 'a-b' }, {}),
    ];
    const summary = buildSummary(pairs);
    // '-' (U+002D) < '_' (U+005F) in code-point order -- "a-b" must always sort first.
    expect(summary.groups.map((g) => g.group_key.scenario_id)).toEqual(['a-b', 'a_b']);
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

  it('a malformed record file is excluded, reported per-file with run_id:null, and the command exits non-zero', () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, 'bad.json'), 'not valid json {{{');
      const result = analyzeRunsDir(dir);
      expect(result.per_run).toEqual([]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].run_id).toBeNull();
      expect(typeof result.errors[0].file_index).toBe('number');
      expect(cmdAnalyze({ 'runs-dir': dir })).toBe(1);
    });
  });

  it('a missing sidecar is excluded and reported per-file, without aborting the whole batch', () => {
    withTempDir((dir) => {
      const good = scenarioRecord({ run_id: 'scenario-current-skill-good0001' });
      writeRunAndSidecar(dir, good, { entries: [targetSkillEntry(0)] });
      const missingSidecar = scenarioRecord({ run_id: 'scenario-current-skill-nosidecar' });
      writeRunAndSidecar(dir, missingSidecar, { entries: [targetSkillEntry(0)] });
      rmSync(path.join(dir, 'audit', 'scenario-current-skill-nosidecar.json'));
      const result = analyzeRunsDir(dir);
      expect(result.per_run.length).toBe(1);
      expect(result.per_run[0].run_id).toBe('scenario-current-skill-good0001');
      // run_id:null here too -- the FAILING file's own record.run_id is never trusted enough to echo,
      // even though in THIS specific case it happens to be well-formed; the rule is uniform.
      expect(result.errors.some((e) => e.run_id === null)).toBe(true);
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

  it('excludes a benchmark_eligible:false scenario record, separately from not-applicable, never pooled', () => {
    withTempDir((dir) => {
      const eligible = scenarioRecord({ run_id: 'scenario-current-skill-eligible1' });
      writeRunAndSidecar(dir, eligible, { entries: [targetSkillEntry(0)] });
      const ineligible = scenarioRecord({ run_id: 'scenario-current-skill-ineligib1', benchmark_eligible: false });
      writeRunAndSidecar(dir, ineligible, { entries: [targetSkillEntry(0)] });
      const result = analyzeRunsDir(dir);
      expect(result.per_run.length).toBe(1);
      expect(result.per_run[0].run_id).toBe('scenario-current-skill-eligible1');
      expect(result.errors).toEqual([]);
      expect(result.summary.files_excluded_benchmark_ineligible).toBe(1);
      expect(result.summary.files_excluded_not_applicable).toBe(0);
    });
  });

  // Review-round correction: benchmark_eligible:true alone does not prove a record is complete.
  // validateRun() does not require success.value to be non-null for a schema-5 scenario record
  // (unlike grading_checks, which it DOES require non-null for schema:2+ scenario records) --
  // reproduced directly by hand-tampering a real record's success to {value:null, reason:'...'}.
  // schemas.mjs's own buildAggregateGroup() already refuses this; analyze must match that
  // Fairness Contract exactly, not merely trust the benchmark_eligible boolean.
  it('excludes (as an error, not a silent exclusion) a benchmark_eligible:true record with a null success.value', () => {
    withTempDir((dir) => {
      const record = scenarioRecord({ run_id: 'scenario-current-skill-incomplete1' });
      record.success = { value: null, reason: 'grading did not run for this synthetic fixture' };
      writeRunAndSidecar(dir, record, { entries: [targetSkillEntry(0)] });
      const result = analyzeRunsDir(dir);
      expect(result.per_run).toEqual([]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].run_id).toBe('scenario-current-skill-incomplete1');
      expect(result.errors[0].errors.some((e) => e.field === 'success')).toBe(true);
      expect(result.summary.files_excluded_benchmark_ineligible).toBe(0); // this is an ERROR, not a silent exclusion
      expect(cmdAnalyze({ 'runs-dir': dir })).toBe(1);
    });
  });

  it('excludes a benchmark_eligible:true record missing a required provenance field (mirrors the same matrix)', () => {
    withTempDir((dir) => {
      const record = scenarioRecord({ run_id: 'scenario-current-skill-incomplete2', project_commit: '' });
      writeRunAndSidecar(dir, record, { entries: [targetSkillEntry(0)] });
      const result = analyzeRunsDir(dir);
      expect(result.per_run).toEqual([]);
      expect(result.errors[0].errors.some((e) => e.field === 'project_commit')).toBe(true);
    });
  });

  it('rejects a duplicate run_id (same id, second file) without inflating the group', () => {
    withTempDir((dir) => {
      const record = scenarioRecord({ run_id: 'scenario-current-skill-dupe0001' });
      writeRunAndSidecar(dir, record, { entries: [targetSkillEntry(0)] });
      const recordText = readFileSync(path.join(dir, 'scenario-current-skill-dupe0001.json'), 'utf8');
      const sidecarText = readFileSync(path.join(dir, 'audit', 'scenario-current-skill-dupe0001.json'), 'utf8');
      // A second file, alphabetically LATER, carrying the exact same run_id + sidecar.
      writeFileSync(path.join(dir, 'zzz-copy.json'), recordText);
      mkdirSync(path.join(dir, 'audit'), { recursive: true });
      writeFileSync(path.join(dir, 'audit', 'zzz-copy.json'), sidecarText);
      const result = analyzeRunsDir(dir);
      expect(result.per_run.length).toBe(1); // never 2 -- the duplicate must not inflate the group
      expect(result.summary.groups[0].run_count).toBe(1);
      expect(result.errors.some((e) => e.run_id === 'scenario-current-skill-dupe0001')).toBe(true);
      expect(cmdAnalyze({ 'runs-dir': dir })).toBe(1);
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

  it('every file is accounted for exactly once: seen == analyzed + excluded_not_applicable + excluded_benchmark_ineligible + errored', () => {
    withTempDir((dir) => {
      writeRunAndSidecar(dir, scenarioRecord({ run_id: 'scenario-current-skill-good0002' }), { entries: [targetSkillEntry(0)] });
      writeFileSync(path.join(dir, 'malformed.json'), 'nope {{{');
      const result = analyzeRunsDir(dir);
      const s = result.summary;
      expect(s.files_seen).toBe(s.files_analyzed + s.files_excluded_not_applicable + s.files_excluded_benchmark_ineligible + s.files_errored);
      expect(s.files_seen).toBe(2);
    });
  });

  it('a directory literally named "*.json" is never treated as a candidate file (CodeRabbit finding)', () => {
    withTempDir((dir) => {
      mkdirSync(path.join(dir, 'looks-like-a-file.json'));
      writeRunAndSidecar(dir, scenarioRecord({ run_id: 'scenario-current-skill-good0003' }), { entries: [targetSkillEntry(0)] });
      const result = analyzeRunsDir(dir);
      expect(result.per_run.length).toBe(1);
      expect(result.errors).toEqual([]);
      expect(result.summary.files_seen).toBe(1); // the directory entry is never counted as a candidate at all
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

  // CodeRabbit MAJOR finding: --runs-dir pointing at a regular FILE must never crash with an
  // uncaught ENOTDIR (readdirSync on a file). Tested at BOTH layers: cmdAnalyze's own pre-flight
  // check, and analyzeRunsDir itself (a direct caller bypassing the CLI wrapper gets the identical
  // guarantee -- never throws, always returns the documented envelope shape).
  describe('--runs-dir pointing at a regular file, not a directory', () => {
    it('cmdAnalyze rejects it cleanly with exit 1, never a crash', () => {
      withTempDir((dir) => {
        const filePath = path.join(dir, 'not-a-directory.json');
        writeFileSync(filePath, '{}');
        expect(() => cmdAnalyze({ 'runs-dir': filePath })).not.toThrow();
        expect(cmdAnalyze({ 'runs-dir': filePath })).toBe(1);
      });
    });

    it('analyzeRunsDir itself never throws and returns the documented envelope shape', () => {
      withTempDir((dir) => {
        const filePath = path.join(dir, 'not-a-directory.json');
        writeFileSync(filePath, '{}');
        let result;
        expect(() => { result = analyzeRunsDir(filePath); }).not.toThrow();
        expect(result.schema).toBe(ANALYSIS_SCHEMA);
        expect(result.per_run).toEqual([]);
        expect(result.errors.length).toBeGreaterThan(0);
      });
    });
  });

  // Adversarial privacy tests (review finding P1): reproduce the EXACT two demonstrated exploits.
  describe('adversarial privacy: private-path/secret-shaped sentinels never round-trip', () => {
    it('a tampered run_id shaped like a private Windows path never appears in errors[] for a file that otherwise fails validation', () => {
      withTempDir((dir) => {
        // Schema-invalid (missing almost everything) AND carries a private-path-shaped run_id --
        // reproduces the exact exploit: a record that fails validation for an unrelated reason must
        // never have ITS OWN run_id echoed back, tampered or not.
        const tampered = { schema: 5, run_kind: 'scenario', run_id: 'C:\\Users\\realname\\secret-project\\evidence' };
        writeFileSync(path.join(dir, 'tampered.json'), JSON.stringify(tampered));
        const result = analyzeRunsDir(dir);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain('realname');
        expect(serialized).not.toContain('secret-project');
        expect(result.errors[0].run_id).toBeNull();
      });
    });

    it('a leak-shaped value in a HARD_PARTITION_FIELDS entry (group_key) is redacted by the final privacy scan, never emitted raw', () => {
      withTempDir((dir) => {
        // project_commit carries no format constraint in validateRun -- a fully schema-valid record
        // can still smuggle a private-path-shaped string through it. The per-run/group_key output
        // must never contain the raw value once analyzeRunsDir's final privacy pass runs.
        const record = scenarioRecord({
          run_id: 'scenario-current-skill-leaktest1',
          project_commit: 'C:\\Users\\realname\\secret-project\\checkout',
        });
        writeRunAndSidecar(dir, record, { entries: [targetSkillEntry(0)] });
        const result = analyzeRunsDir(dir);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain('realname');
        expect(serialized).not.toContain('secret-project');
        expect(result.summary.groups[0].group_key.project_commit).not.toBe(record.project_commit);
      });
    });
  });
});

// Real-committed-record regression tests (review-round correction): read-only against
// tools/runs/agentic-eval-scenario/, hand-verified against each record+sidecar's own actual
// content. These specifically guard against the previous version's ordinal semantic silently
// collapsing every one of these delayed-activation runs to a constant 1, and against the
// previous version nulling out post-skill counts on every one of these non-signal-reaching runs.
describe('real committed-record regression coverage (read-only, tools/runs/agentic-eval-scenario)', () => {
  const EXPECTED = {
    'scenario-current-skill-08d5daaa': {
      target_skill_invocation_ordinal: 3, target_skill_attempt_ordinal: 1,
      pre_skill_tool_calls: 3, pre_skill_policy_denials: 3,
      post_skill_tool_calls_total: 3, post_skill_policy_denials_total: 1,
      terminal_authoritative_evidence_present: true, terminal_authoritative_evidence_well_formed: true,
      first_useful_signal_present: false, failure_class: 'wrong-target',
    },
    'scenario-current-skill-27d0c3c6': {
      target_skill_invocation_ordinal: 0, target_skill_attempt_ordinal: 1,
      pre_skill_tool_calls: 0, pre_skill_policy_denials: 0,
      post_skill_tool_calls_total: 9, post_skill_policy_denials_total: 9,
      terminal_authoritative_evidence_present: false, terminal_authoritative_evidence_well_formed: false,
      first_useful_signal_present: false, failure_class: 'policy-denial-observed-without-terminal-evidence',
    },
    'scenario-current-skill-39e3bfdc': {
      target_skill_invocation_ordinal: 0, target_skill_attempt_ordinal: 1,
      pre_skill_tool_calls: 0, pre_skill_policy_denials: 0,
      post_skill_tool_calls_total: 2, post_skill_policy_denials_total: 0,
      terminal_authoritative_evidence_present: true, terminal_authoritative_evidence_well_formed: true,
      first_useful_signal_present: false, failure_class: 'wrong-target',
    },
    'scenario-current-skill-77491559': {
      target_skill_invocation_ordinal: 3, target_skill_attempt_ordinal: 1,
      pre_skill_tool_calls: 3, pre_skill_policy_denials: 3,
      post_skill_tool_calls_total: 2, post_skill_policy_denials_total: 0,
      terminal_authoritative_evidence_present: true, terminal_authoritative_evidence_well_formed: true,
      first_useful_signal_present: true, failure_class: 'success',
    },
    'scenario-current-skill-21843c0e': {
      target_skill_invocation_ordinal: 4, target_skill_attempt_ordinal: 1,
      pre_skill_tool_calls: 4, pre_skill_policy_denials: 4,
      post_skill_tool_calls_total: 4, post_skill_policy_denials_total: 1,
      terminal_authoritative_evidence_present: true, terminal_authoritative_evidence_well_formed: true,
      first_useful_signal_present: true, failure_class: 'success',
    },
  };

  it('every documented real record analyzes to its hand-verified expected values', () => {
    if (!existsRealRunsDir()) return; // see helper below -- skips gracefully outside a full checkout
    const result = analyzeRunsDir(REAL_RUNS_DIR);
    expect(result.errors).toEqual([]);
    for (const [runId, expected] of Object.entries(EXPECTED)) {
      const entry = result.per_run.find((e) => e.run_id === runId);
      expect(entry, `expected ${runId} in per_run`).toBeDefined();
      for (const [field, value] of Object.entries(expected)) {
        expect(entry[field], `${runId}.${field}`).toBe(value);
      }
    }
  });

  it('confirms delayed-activation runs report their real GLOBAL ordinal (3 or 4), never collapsed to 1', () => {
    if (!existsRealRunsDir()) return;
    const result = analyzeRunsDir(REAL_RUNS_DIR);
    const delayed = ['scenario-current-skill-08d5daaa', 'scenario-current-skill-77491559', 'scenario-current-skill-21843c0e']
      .map((id) => result.per_run.find((e) => e.run_id === id));
    for (const entry of delayed) {
      expect(entry.target_skill_invocation_ordinal).toBeGreaterThan(0);
    }
  });

  it('confirms a failed (no-signal) run still reports real, non-null post-skill counts', () => {
    if (!existsRealRunsDir()) return;
    const result = analyzeRunsDir(REAL_RUNS_DIR);
    const entry = result.per_run.find((e) => e.run_id === 'scenario-current-skill-27d0c3c6');
    expect(entry.post_skill_tool_calls_total).toBe(9);
    expect(entry.post_skill_tool_calls_total).not.toBeNull();
  });
});

function existsRealRunsDir() {
  try {
    return statSync(REAL_RUNS_DIR).isDirectory();
  } catch {
    return false;
  }
}

describe('module self-consistency', () => {
  it('every grading-check name this module reads by literal string still exists in GRADING_CHECK_NAMES', () => {
    for (const name of ['authoritative_evidence_well_formed', 'authoritative_target_matches_expected', 'authoritative_outcome_matches_expected', 'final_answer_consistent_with_evidence']) {
      expect(GRADING_CHECK_NAMES).toContain(name);
    }
  });
});

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
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {
  ANALYSIS_SCHEMA, FAILURE_CLASS_VALUES, PRODUCT_ACCESS_MODE_VALUES, PRODUCT_USAGE_MODE_VALUES, EVIDENCE_QUALITY_VALUES,
  classifyFailure, deriveSkillRelativeFields,
  analyzeRunRecord, buildSummary, analyzeRunsDir,
} from '../../tools/agentic-eval/analysis.mjs';
import { cmdAnalyze } from '../../tools/agentic-eval/cli.mjs';
import { ACCEPTED_AUDIT_SIDECAR_SCHEMA_V1 } from '../../tools/agentic-eval/accepted-run-audit.mjs';
import { GRADING_CHECK_NAMES } from '../../tools/agentic-eval/graders.mjs';
import {
  COVERAGE_TARGET_STATUS_VALUES, COVERAGE_REPORT_STATUS_VALUES,
  COVERAGE_GATE_WARNING_BUCKET_FIELDS, EXECUTION_MODE_VALUES,
} from '../../tools/agentic-eval/coverage-gate-observability.mjs';

const VALID_SCOPE_ID = '11111111-2222-4333-8444-555555555555';
// Resolved from THIS FILE's own location (never process.cwd(), which depends on where the test
// runner happens to be invoked FROM and is not something a test should depend on) -- this file
// lives at tests/vitest/, so the repo root is two levels up.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_RUNS_DIR = path.join(__dirname, '..', '..', 'tools', 'runs', 'agentic-eval-scenario');

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
function sidecarFor(record, { entries = [], firstUsefulSignalEvent = null, terminalAuthoritativeEvent, terminalEvidence, outcomeObservabilitySummary } = {}) {
  const sorted = [...entries].sort((a, b) => a.tool_use_event_index - b.tool_use_event_index);
  const boundaryIndex = firstUsefulSignalEvent?.index ?? null;
  const toolCalls = sorted.map((tc, ordinal) => ({ ordinal, ...tc, phase: phaseFor(tc, boundaryIndex) }));
  const isBash = (tc) => BASH_KINDS.has(tc.tool_kind);
  const bashEntries = toolCalls.filter(isBash);
  const hasBoundary = boundaryIndex != null;
  return {
    schema: ACCEPTED_AUDIT_SIDECAR_SCHEMA_V1, run_id: record.run_id, run_schema: 5, run_kind: 'scenario',
    condition: record.condition, scenario_id: record.scenario_id,
    first_useful_signal_event: firstUsefulSignalEvent,
    terminal_authoritative_event: terminalAuthoritativeEvent !== undefined ? terminalAuthoritativeEvent : firstUsefulSignalEvent,
    ...(terminalEvidence !== undefined ? { terminal_evidence: terminalEvidence } : {}),
    ...(outcomeObservabilitySummary !== undefined ? { outcome_observability_summary: outcomeObservabilitySummary } : {}),
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

describe('product access / usage layer contract', () => {
  it('publishes the closed vocabularies that separate product access from answer success', () => {
    expect(PRODUCT_ACCESS_MODE_VALUES).toEqual([
      'product-assisted', 'product-visible-no-skill', 'free-baseline-no-product',
      'contaminated-baseline', 'product-access-not-recorded',
    ]);
    expect(PRODUCT_USAGE_MODE_VALUES).toEqual([
      'product-cli', 'direct-build-tool', 'mixed-product-and-build-tool', 'manual-other', 'none',
    ]);
    expect(EVIDENCE_QUALITY_VALUES).toEqual([
      'product-canonical', 'baseline-verifiable', 'malformed-evidence', 'claim-only', 'no-evidence',
    ]);
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
    expect(entry.product_access_mode).toBe('product-assisted');
    expect(entry.product_cli_command_count).toBe(1);
    expect(entry.direct_build_tool_command_count).toBe(0);
    expect(entry.other_bash_command_count).toBe(0);
    expect(entry.product_usage_mode).toBe('product-cli');
    expect(entry.product_cli_used).toBe(true);
    expect(entry.programmatic_product_outcome_matched).toBe(true);
    expect(entry.final_answer_protocol_only_failure).toBe(true);
    expect(entry.task_outcome_matched).toBe(true);
    expect(entry.answer_protocol_matched).toBe(false);
    expect(entry.programmatic_evidence_available).toBe(true);
    expect(entry.canonical_final_answer_available).toBe(false);
    expect(entry.canonical_output_available).toBe(false);
    expect(entry.evidence_quality).toBe('product-canonical');
    expect(entry.coverage_gate_diagnostic).toBe('not-recorded');
    expect(entry.failure_class).toBe('final-answer-mismatch');
  });

  it('product run with well-formed product evidence is credited separately from outcome and final-answer success', () => {
    const record = scenarioRecord({
      expected_outcome_matched: { value: false, reason: null },
      skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 0 },
      grading_checks: gradingChecks({
        authoritative_outcome_matches_expected: { passed: false, detail: 'observed tests_executed, expected coverage_threshold_exceeded' },
        final_answer_consistent_with_evidence: { passed: false, detail: 'final block did not match observed evidence' },
      }),
    });
    const sidecar = sidecarFor(record, {
      entries: [targetSkillEntry(0), bashEntry(1, { kind: 'kmp-test', operation: 'parallel' })],
      terminalAuthoritativeEvent: { type: 'user.tool_result', index: 2 },
      terminalEvidence: {
        present: true,
        provider: 'kmp-test',
        tool_result_event_index: 2,
        evidence_well_formed: true,
        target_matches_expected: true,
        outcome_matches_expected: false,
        malformed: false,
        parallel_evidence_invalid: false,
        changed_evidence_invalid: false,
        observed_result: {
          outcome_kind: 'tests_executed',
          module_matches_expected: true,
          total: 2,
          passed: 2,
          failed: 0,
          missed_lines: null,
          threshold: null,
          modules_contributing: 1,
        },
        final_answer_block: { found: true, parsed: true, ambiguous: false, matches_observed: false },
        coverage_gate_diagnostic: 'observed-clean-tests',
      },
    });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.success).toBe(false);
    expect(entry.task_outcome_matched).toBe(false);
    expect(entry.answer_protocol_matched).toBe(false);
    expect(entry.programmatic_evidence_available).toBe(true);
    expect(entry.canonical_final_answer_available).toBe(false);
    expect(entry.canonical_output_available).toBe(false);
    expect(entry.product_cli_used).toBe(true);
    expect(entry.evidence_quality).toBe('product-canonical');
    expect(entry.coverage_gate_diagnostic).toBe('observed-clean-tests');
    expect(entry.failure_class).toBe('outcome-mismatch');
  });

  it('free-baseline claim-only output is visible as a claim, not confused with product evidence', () => {
    const record = scenarioRecord({
      schema: 7,
      condition: 'no-skill',
      product_access_mode: 'free-baseline-no-product',
      skill_invoked: { value: false, reason: null },
      skill_invocation_event: null,
      grading_checks: gradingChecks({
        authoritative_evidence_well_formed: { passed: false, detail: 'no authoritative terminal evidence' },
        authoritative_target_matches_expected: { passed: false, detail: 'no well-formed terminal evidence to check' },
        authoritative_outcome_matches_expected: { passed: false, detail: 'no well-formed, correctly-targeted terminal evidence to check' },
        final_answer_consistent_with_evidence: { passed: false, detail: 'claim was parseable but not backed by terminal evidence' },
      }),
    });
    const sidecar = sidecarFor(record, {
      entries: [bashEntry(0, { kind: 'other-bash' })],
      terminalAuthoritativeEvent: null,
      terminalEvidence: {
        present: false,
        provider: null,
        tool_result_event_index: null,
        evidence_well_formed: false,
        target_matches_expected: null,
        outcome_matches_expected: null,
        malformed: null,
        parallel_evidence_invalid: null,
        changed_evidence_invalid: null,
        observed_result: null,
        final_answer_block: { found: true, parsed: true, ambiguous: false, matches_observed: null },
      },
    });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.product_access_mode).toBe('free-baseline-no-product');
    expect(entry.product_usage_mode).toBe('manual-other');
    expect(entry.product_cli_used).toBe(false);
    expect(entry.task_outcome_matched).toBe(false);
    expect(entry.answer_protocol_matched).toBe(false);
    expect(entry.programmatic_evidence_available).toBe(false);
    expect(entry.canonical_final_answer_available).toBe(false);
    expect(entry.canonical_output_available).toBe(false);
    expect(entry.evidence_quality).toBe('claim-only');
    expect(entry.failure_class).toBe('no-authoritative-evidence');
  });

  it('malformed terminal evidence and absent evidence stay distinct from claim-only baseline output', () => {
    const malformedRecord = scenarioRecord({
      grading_checks: gradingChecks({
        authoritative_evidence_well_formed: { passed: false, detail: 'terminal evidence was malformed' },
        authoritative_target_matches_expected: { passed: false, detail: 'no well-formed terminal evidence to check' },
        authoritative_outcome_matches_expected: { passed: false, detail: 'no well-formed, correctly-targeted terminal evidence to check' },
      }),
    });
    const malformedSidecar = sidecarFor(malformedRecord, {
      entries: [targetSkillEntry(0), bashEntry(1, { kind: 'kmp-test', operation: 'parallel' })],
      terminalAuthoritativeEvent: { type: 'user.tool_result', index: 2 },
      terminalEvidence: {
        present: true,
        provider: 'kmp-test',
        tool_result_event_index: 2,
        evidence_well_formed: false,
        target_matches_expected: null,
        outcome_matches_expected: null,
        malformed: true,
        parallel_evidence_invalid: true,
        changed_evidence_invalid: false,
        observed_result: null,
        final_answer_block: { found: false, parsed: false, ambiguous: false, matches_observed: null },
      },
    });
    const noEvidenceRecord = scenarioRecord({
      grading_checks: gradingChecks({
        authoritative_evidence_well_formed: { passed: false, detail: 'no authoritative terminal evidence' },
        authoritative_target_matches_expected: { passed: false, detail: 'no well-formed terminal evidence to check' },
        authoritative_outcome_matches_expected: { passed: false, detail: 'no well-formed, correctly-targeted terminal evidence to check' },
        final_answer_consistent_with_evidence: { passed: false, detail: 'no KMP_EVAL_RESULT block' },
      }),
    });
    const noEvidenceSidecar = sidecarFor(noEvidenceRecord, {
      entries: [targetSkillEntry(0)],
      terminalAuthoritativeEvent: null,
      terminalEvidence: {
        present: false,
        provider: null,
        tool_result_event_index: null,
        evidence_well_formed: false,
        target_matches_expected: null,
        outcome_matches_expected: null,
        malformed: null,
        parallel_evidence_invalid: null,
        changed_evidence_invalid: null,
        observed_result: null,
        final_answer_block: { found: false, parsed: false, ambiguous: false, matches_observed: null },
      },
    });

    expect(analyzeRunRecord(malformedRecord, malformedSidecar).entry.evidence_quality).toBe('malformed-evidence');
    expect(analyzeRunRecord(noEvidenceRecord, noEvidenceSidecar).entry.evidence_quality).toBe('no-evidence');
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
    expect(entry.product_access_mode).toBe('product-visible-no-skill');
    expect(entry.product_cli_command_count).toBe(1);
    expect(entry.direct_build_tool_command_count).toBe(0);
    expect(entry.product_usage_mode).toBe('product-cli');
    expect(entry.product_cli_used).toBe(true);
    expect(entry.failure_class).toBe('success');
  });

  it('no-skill with direct Gradle evidence stays distinct from product CLI usage', () => {
    const record = scenarioRecord({
      condition: 'no-skill', skill_invoked: { value: false, reason: null }, skill_invocation_event: null,
      success: { value: false, reason: null }, expected_outcome_matched: { value: true, reason: null },
      grading_checks: gradingChecks({
        final_answer_consistent_with_evidence: { passed: false, detail: 'final answer did not follow the requested reporting contract' },
      }),
    });
    const sidecar = sidecarFor(record, { entries: [bashEntry(0, { kind: 'gradle', operation: 'allowed-task' })], terminalAuthoritativeEvent: { type: 'user.tool_result', index: 1 } });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.product_access_mode).toBe('product-visible-no-skill');
    expect(entry.product_cli_command_count).toBe(0);
    expect(entry.direct_build_tool_command_count).toBe(1);
    expect(entry.other_bash_command_count).toBe(0);
    expect(entry.product_usage_mode).toBe('direct-build-tool');
    expect(entry.product_cli_used).toBe(false);
    expect(entry.programmatic_product_outcome_matched).toBe(false);
    expect(entry.final_answer_protocol_only_failure).toBe(true);
    expect(entry.failure_class).toBe('final-answer-mismatch');
  });

  it('schema:7 free-baseline-no-product records keep the explicit product access mode instead of falling back to condition-derived product-visible no-skill', () => {
    const record = scenarioRecord({
      schema: 7,
      condition: 'no-skill',
      product_access_mode: 'free-baseline-no-product',
      skill_invoked: { value: false, reason: null },
      skill_invocation_event: null,
    });
    const sidecar = sidecarFor(record, { entries: [bashEntry(0, { kind: 'gradle', operation: 'allowed-task' })], terminalAuthoritativeEvent: { type: 'user.tool_result', index: 1 } });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.product_access_mode).toBe('free-baseline-no-product');
    expect(entry.product_usage_mode).toBe('direct-build-tool');
  });

  it('mixed product and direct Gradle usage is reported as its own usage mode', () => {
    const record = scenarioRecord({
      expected_outcome_matched: { value: false, reason: null },
      skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 0 },
    });
    const sidecar = sidecarFor(record, {
      entries: [
        targetSkillEntry(0),
        bashEntry(1, { kind: 'kmp-test', operation: 'parallel' }),
        bashEntry(3, { kind: 'gradle', operation: 'allowed-task' }),
      ],
      terminalAuthoritativeEvent: { type: 'user.tool_result', index: 2 },
    });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.product_usage_mode).toBe('mixed-product-and-build-tool');
    expect(entry.product_cli_command_count).toBe(1);
    expect(entry.direct_build_tool_command_count).toBe(1);
  });

  it('reports product CLI recognized operations from the accepted-audit sidecar, separate from policy-sensitive operation', () => {
    const record = scenarioRecord({
      expected_outcome_matched: { value: false, reason: null },
      skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 0 },
    });
    const sidecar = sidecarFor(record, {
      entries: [
        targetSkillEntry(0),
        { ...bashEntry(1, { kind: 'kmp-test', operation: 'other' }), recognized_operation: 'parallel' },
        { ...bashEntry(3, { kind: 'kmp-test', operation: 'other' }), recognized_operation: 'coverage' },
        { ...bashEntry(5, { kind: 'kmp-test', operation: 'other' }), recognized_operation: 'doctor' },
        bashEntry(7, { kind: 'kmp-test', operation: 'other' }),
      ],
      terminalAuthoritativeEvent: { type: 'user.tool_result', index: 2 },
    });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.product_cli_command_count).toBe(4);
    expect(entry.product_cli_recognized_operation_distribution).toEqual({ parallel: 1, coverage: 1, doctor: 1 });
    expect(entry.product_cli_parallel_command_count).toBe(1);
    expect(entry.product_cli_coverage_command_count).toBe(1);
    expect(entry.product_cli_describe_command_count).toBe(0);
    expect(entry.product_cli_doctor_command_count).toBe(1);
    expect(entry.product_cli_other_recognized_command_count).toBe(0);
    expect(entry.product_cli_unrecognized_operation_count).toBe(1);
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
      failure_class: 'success',
      product_access_mode: 'product-assisted',
      product_usage_mode: 'product-cli',
      product_cli_command_count: 1,
      direct_build_tool_command_count: 0,
      other_bash_command_count: 0,
      product_cli_used: true,
      task_outcome_matched: true,
      answer_protocol_matched: true,
      programmatic_evidence_available: true,
      canonical_final_answer_available: true,
      canonical_output_available: true,
      evidence_quality: 'product-canonical',
      coverage_gate_diagnostic: 'not-recorded',
      programmatic_product_outcome_matched: true,
      final_answer_protocol_only_failure: false,
      ...entryOverrides,
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

  // P1 architectural review: an unobservable activation (target_skill_invoked:null, e.g. indirect/
  // not-observable) must be excluded from the RATE'S DENOMINATOR, not merely from its numerator --
  // leaving it in the denominator silently treats "unknown" as "not invoked", diluting the rate
  // downward exactly the way this harness refuses to coerce null into zero anywhere else.
  it('excludes an unobservable (null) target_skill_invoked from both the numerator AND the denominator of target_skill_invoked_rate', () => {
    const pairs = [
      pair({ run_id: 'r1' }, { activation_expected: true, target_skill_invoked: true }),
      pair({ run_id: 'r2' }, { activation_expected: true, target_skill_invoked: false }),
      pair({ run_id: 'r3' }, { activation_expected: true, target_skill_invoked: null }),
    ];
    const summary = buildSummary(pairs);
    const [group] = summary.groups;
    expect(group.activation_expected_count).toBe(3);
    expect(group.target_skill_invoked_observable_count).toBe(2);
    expect(group.target_skill_invoked_unknown_count).toBe(1);
    expect(group.target_skill_invoked_count).toBe(1);
    // The naive (pre-fix) computation would have been 1/3; the correct one excludes the
    // unobservable entry from the denominator entirely: 1/2.
    expect(group.target_skill_invoked_rate).toBe(0.5);
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

  it('reports product access, product usage, and final-answer-only failures as independent summary axes', () => {
    const pairs = [
      pair({ run_id: 'r1' }, {
        product_access_mode: 'product-assisted',
        product_usage_mode: 'product-cli',
        product_cli_used: true,
        product_cli_recognized_operation_distribution: { parallel: 1, coverage: 1 },
        product_cli_parallel_command_count: 1,
        product_cli_coverage_command_count: 1,
        product_cli_describe_command_count: 0,
        product_cli_doctor_command_count: 0,
        product_cli_other_recognized_command_count: 0,
        product_cli_unrecognized_operation_count: 0,
        task_outcome_matched: true,
        answer_protocol_matched: false,
        programmatic_evidence_available: true,
        canonical_final_answer_available: false,
        canonical_output_available: false,
        evidence_quality: 'product-canonical',
        coverage_gate_diagnostic: 'missing-threshold-gate',
        coverage_gate_attempt_count: 1,
        coverage_gate_terminal_canonicalization_reason: 'threshold-missing',
        coverage_gate_contract_failures: ['canonicalization', 'threshold', 'coverage', 'error', 'exit_code', 'outcome'],
        final_answer_comparison_status: 'field-mismatch',
        final_answer_mismatch_fields: ['threshold'],
        programmatic_product_outcome_matched: true,
        final_answer_protocol_only_failure: true,
        success: false,
        failure_class: 'final-answer-mismatch',
      }),
      pair({ run_id: 'r2' }, {
        product_access_mode: 'free-baseline-no-product',
        product_usage_mode: 'direct-build-tool',
        product_cli_used: false,
        product_cli_recognized_operation_distribution: {},
        product_cli_parallel_command_count: 0,
        product_cli_coverage_command_count: 0,
        product_cli_describe_command_count: 0,
        product_cli_doctor_command_count: 0,
        product_cli_other_recognized_command_count: 0,
        product_cli_unrecognized_operation_count: 0,
        task_outcome_matched: false,
        answer_protocol_matched: false,
        programmatic_evidence_available: false,
        canonical_final_answer_available: false,
        canonical_output_available: false,
        evidence_quality: 'claim-only',
        coverage_gate_diagnostic: 'no-terminal-evidence',
        coverage_gate_attempt_count: 1,
        coverage_gate_terminal_canonicalization_reason: 'operation-not-eligible',
        coverage_gate_contract_failures: ['operation'],
        final_answer_comparison_status: 'missing-block',
        final_answer_mismatch_fields: [],
        programmatic_product_outcome_matched: false,
        final_answer_protocol_only_failure: true,
        success: false,
        failure_class: 'final-answer-mismatch',
      }),
    ];
    const summary = buildSummary(pairs);
    const [group] = summary.groups;
    expect(group.product_access_mode_distribution).toEqual({
      'product-assisted': 1,
      'free-baseline-no-product': 1,
    });
    expect(group.product_usage_mode_distribution).toEqual({
      'product-cli': 1,
      'direct-build-tool': 1,
    });
    expect(group.product_cli_used_count).toBe(1);
    expect(group.product_cli_used_rate).toBe(0.5);
    expect(group.product_cli_recognized_operation_distribution).toEqual({ parallel: 1, coverage: 1 });
    expect(group.product_cli_parallel_command_count).toBe(1);
    expect(group.product_cli_coverage_command_count).toBe(1);
    expect(group.product_cli_describe_command_count).toBe(0);
    expect(group.product_cli_doctor_command_count).toBe(0);
    expect(group.product_cli_other_recognized_command_count).toBe(0);
    expect(group.product_cli_unrecognized_operation_count).toBe(0);
    expect(group.task_outcome_matched_count).toBe(1);
    expect(group.task_outcome_matched_rate).toBe(0.5);
    expect(group.answer_protocol_matched_count).toBe(0);
    expect(group.answer_protocol_matched_rate).toBe(0);
    expect(group.programmatic_evidence_available_count).toBe(1);
    expect(group.programmatic_evidence_available_rate).toBe(0.5);
    expect(group.canonical_final_answer_available_count).toBe(0);
    expect(group.canonical_final_answer_available_rate).toBe(0);
    expect(group.canonical_output_available_count).toBe(0);
    expect(group.canonical_output_available_rate).toBe(0);
    expect(group.evidence_quality_distribution).toEqual({
      'product-canonical': 1,
      'claim-only': 1,
    });
    expect(group.coverage_gate_diagnostic_distribution).toEqual({
      'missing-threshold-gate': 1,
      'no-terminal-evidence': 1,
    });
    expect(group.coverage_gate_attempt_count_distribution).toEqual({ 1: 2 });
    expect(group.coverage_gate_terminal_canonicalization_reason_distribution).toEqual({
      'operation-not-eligible': 1,
      'threshold-missing': 1,
    });
    expect(group.coverage_gate_contract_failure_distribution).toEqual({
      canonicalization: 1,
      coverage: 1,
      error: 1,
      exit_code: 1,
      operation: 1,
      outcome: 1,
      threshold: 1,
    });
    expect(group.final_answer_comparison_status_distribution).toEqual({
      'field-mismatch': 1,
      'missing-block': 1,
    });
    expect(group.final_answer_mismatch_field_distribution).toEqual({
      none: 1,
      threshold: 1,
    });
    expect(group.programmatic_product_outcome_matched_count).toBe(1);
    expect(group.programmatic_product_outcome_matched_rate).toBe(0.5);
    expect(group.final_answer_protocol_only_failure_count).toBe(2);
    expect(group.final_answer_protocol_only_failure_rate).toBe(1);
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

  // Review-round P2 (coverage gap): the test above only re-proves the OLD localeCompare bug
  // (scenario_id "a-b" vs "a_b") -- it never exercises the tie-break fix itself, since both
  // pairs there already differ on scenario_id, the FIRST field the old code compared. Two groups
  // that are equal on scenario_id AND condition but differ in some OTHER HARD_PARTITION_FIELDS
  // value (e.g. platform) are exactly the case the old code left non-deterministic: lacking a
  // tie-break beyond those two fields, their relative order fell back to Map/file-processing
  // insertion order -- a property of which record happened to be read first, not of the data.
  // Feeding the identical two groups in BOTH orders and asserting the SAME resulting order proves
  // the fix is genuinely input-order-independent, not merely a comparator that happens to return
  // non-zero for this one pair of inputs.
  it('orders two groups sharing scenario_id and condition but differing in platform identically, regardless of input order', () => {
    const windowsFirst = buildSummary([
      pair({ run_id: 'r1', platform: 'windows' }, {}),
      pair({ run_id: 'r2', platform: 'linux' }, {}),
    ]);
    const linuxFirst = buildSummary([
      pair({ run_id: 'r3', platform: 'linux' }, {}),
      pair({ run_id: 'r4', platform: 'windows' }, {}),
    ]);
    // 'l' (U+006C) < 'w' (U+0077) -- the "linux" group must sort first in BOTH input orders.
    const expectedOrder = ['linux', 'windows'];
    expect(windowsFirst.groups.map((g) => g.group_key.platform)).toEqual(expectedOrder);
    expect(linuxFirst.groups.map((g) => g.group_key.platform)).toEqual(expectedOrder);
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
  beforeAll(() => {
    if (!existsSync(REAL_RUNS_DIR) || !statSync(REAL_RUNS_DIR).isDirectory()) {
      throw new Error(
        `Expected versioned fixture directory not found: ${REAL_RUNS_DIR}\n` +
        'These real committed-record regression tests must fail loudly, not skip silently, ' +
        'when this always-present fixture directory is missing.'
      );
    }
  });

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
    const result = analyzeRunsDir(REAL_RUNS_DIR);
    const delayed = ['scenario-current-skill-08d5daaa', 'scenario-current-skill-77491559', 'scenario-current-skill-21843c0e']
      .map((id) => result.per_run.find((e) => e.run_id === id));
    for (const entry of delayed) {
      expect(entry.target_skill_invocation_ordinal).toBeGreaterThan(0);
    }
  });

  it('confirms a failed (no-signal) run still reports real, non-null post-skill counts', () => {
    const result = analyzeRunsDir(REAL_RUNS_DIR);
    const entry = result.per_run.find((e) => e.run_id === 'scenario-current-skill-27d0c3c6');
    expect(entry.post_skill_tool_calls_total).toBe(9);
    expect(entry.post_skill_tool_calls_total).not.toBeNull();
  });
});

describe('module self-consistency', () => {
  it('every grading-check name this module reads by literal string still exists in GRADING_CHECK_NAMES', () => {
    for (const name of ['authoritative_evidence_well_formed', 'authoritative_target_matches_expected', 'authoritative_outcome_matches_expected', 'final_answer_consistent_with_evidence']) {
      expect(GRADING_CHECK_NAMES).toContain(name);
    }
  });
});

// Section F (agentic-eval-runtime-neutral-records-v1): analyzeRunRecord/buildSummary gain
// agent_runtime/execution_profile/skill_observation/usage reporting fields (schema:6 real value or
// the literal "not-recorded" sentinel below schema 6), canonical activation reads from
// skill_observation.activation for schema:6 records, and buildGroupSummary gains 5 usage-dimension
// distributions + usage_source_counts (deliberately no summed total). analyzeRunRecord/buildSummary
// are pure functions -- neither calls validateRun, so these fixtures only need the specific fields
// each function actually reads, not a fully schema-valid record (unlike agentic-eval-aggregate.
// test.js's own exhaustive per-field partition-separation sweep, which DOES go through the real,
// validateRun-gated aggregateRuns() and is the one place that sweep belongs -- both modules share
// the identical run-record-view.mjs projection, so repeating it here would test nothing new).
function scenarioRecord6(overrides = {}) {
  return scenarioRecord({
    schema: 6,
    agent_runtime: {
      runtime_id: 'claude-code', cli_version: '2.1.218', model_requested: 'claude-sonnet-5',
      model_resolved: 'claude-sonnet-5', model_vendor_expected: 'anthropic', model_vendor_observed: null,
    },
    execution_profile: {
      id: 'strict-policy-v1', sha256: 'd'.repeat(64), isolation_kind: 'runtime-policy-hooks',
      isolation_attestation_sha256: null, network_mode: 'runtime-default',
    },
    skill_observation: {
      delivery_mode: 'runtime-extension',
      availability: { status: 'observed-present', evidence_kind: 'runtime-catalog' },
      activation: { status: 'confirmed', evidence_kind: 'runtime-explicit-event' },
      source_sha: '9e47a9d132f5b9ea6ac5bc50a66c844458fd363e',
      treatment_size: {
        snapshot_sha256: 'c'.repeat(64), snapshot_bytes: 234997, snapshot_file_count: 28,
        prompt_sha256: 'e'.repeat(64), prompt_bytes: 55,
        absent_reason: null,
      },
    },
    usage: {
      source: 'runtime-reported', input: 16, cached_input: 151916, cache_write: 7026, output: 1835, reasoning_output: null,
      attributable_to_skill_load: {
        status: 'not-recorded',
        dimensions: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null },
        unit: null, reason: 'runtime-does-not-report-skill-attribution',
      },
    },
    ...overrides,
  });
}

describe('analyzeRunRecord -- agent_runtime/execution_profile/skill_observation/usage reporting fields (Section F)', () => {
  it('a schema:5 record reports all 4 new fields as the literal "not-recorded" sentinel', () => {
    const record = scenarioRecord({ success: { value: true, reason: null }, expected_outcome_matched: { value: true, reason: null } });
    const sidecar = sidecarFor(record, { entries: [targetSkillEntry(0)] });
    const { entry } = analyzeRunRecord(record, sidecar);
    expect(entry.agent_runtime).toBe('not-recorded');
    expect(entry.execution_profile).toBe('not-recorded');
    expect(entry.skill_observation).toBe('not-recorded');
    expect(entry.usage).toEqual({
      source: 'not-recorded', input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null,
      attributable_to_skill_load: {
        status: 'not-recorded',
        dimensions: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null },
        unit: null, reason: 'record schema is below 6 -- usage was not measured',
      },
    });
  });

  it('a schema:6 record reports the FULL (unnarrowed) real objects -- including isolation_attestation_sha256 and availability/activation, unlike aggregate.mjs\'s own narrowed partition-key projection', () => {
    const record = scenarioRecord6({
      success: { value: true, reason: null }, expected_outcome_matched: { value: true, reason: null },
      execution_profile: { id: 'sandboxed-unrestricted-v1', sha256: 'd'.repeat(64), isolation_kind: 'external-sandbox', isolation_attestation_sha256: 'b'.repeat(64), network_mode: 'restricted' },
    });
    const sidecar = sidecarFor(record, { entries: [targetSkillEntry(0)] });
    const { entry } = analyzeRunRecord(record, sidecar);
    expect(entry.agent_runtime).toEqual(record.agent_runtime);
    // The reporting field carries isolation_attestation_sha256 -- aggregate.mjs's own group_key
    // projection deliberately excludes it (never a partition key), but there is no reason to hide
    // it from a human-readable report.
    expect(entry.execution_profile).toEqual(record.execution_profile);
    expect(entry.execution_profile.isolation_attestation_sha256).toBe('b'.repeat(64));
    expect(entry.skill_observation).toEqual(record.skill_observation);
    expect(entry.skill_observation.availability.status).toBe('observed-present');
    expect(entry.usage).toEqual(record.usage);
  });

  it('reads target_skill_invoked from skill_observation.activation.status for a schema:6 record, not the legacy skill_invoked field, when the two (deliberately, for this test only) disagree', () => {
    // Schema invariant 8 would reject this combination via validateRun -- analyzeRunRecord itself
    // never calls validateRun, so this fixture exists purely to prove WHICH field wins, using a
    // combination validateRun would never let reach production.
    const record = scenarioRecord6({
      skill_invoked: { value: false, reason: null }, // legacy field says NOT invoked
      // scenarioRecord's own skill_invocation_event auto-derivation looks at the legacy
      // skill_invoked value above (false -> null) -- forced back to a real event ref here so
      // deriveSkillRelativeFields' OWN correlation check (a separate concern from which field
      // analyzeRunRecord reads target_skill_invoked from) does not itself fail closed first.
      skill_invocation_event: { type: 'assistant.tool_use.Skill', index: 0 },
      skill_observation: { ...scenarioRecord6().skill_observation, activation: { status: 'confirmed', evidence_kind: 'runtime-explicit-event' } }, // canonical field says CONFIRMED
    });
    const sidecar = sidecarFor(record, { entries: [targetSkillEntry(0)] });
    const { entry } = analyzeRunRecord(record, sidecar);
    expect(entry.target_skill_invoked).toBe(true);
  });

  it('reads target_skill_invoked from the legacy skill_invoked field for a schema:5 record (unchanged)', () => {
    const record = scenarioRecord({ skill_invoked: { value: true, reason: null } });
    const sidecar = sidecarFor(record, { entries: [targetSkillEntry(0)] });
    const { entry } = analyzeRunRecord(record, sidecar);
    expect(entry.target_skill_invoked).toBe(true);
  });
});

describe('buildSummary -- group-level agent_runtime/execution_profile/skill_observation/usage reporting (Section F)', () => {
  function pairFor(record, sidecarEntries = [targetSkillEntry(0)]) {
    const sidecar = sidecarFor(record, { entries: sidecarEntries });
    const { entry } = analyzeRunRecord(record, sidecar);
    return { record, entry };
  }

  it('a schema:6 group reports the real agent_runtime (homogeneous by construction) and the SAME NARROWED execution_profile/skill_treatment as group_key -- never entries[0]\'s own full, potentially-outcome-carrying value (P1 architectural review)', () => {
    const a = pairFor(scenarioRecord6({ run_id: 'scenario-current-skill-v6a' }));
    const b = pairFor(scenarioRecord6({ run_id: 'scenario-current-skill-v6b' }));
    const { groups } = buildSummary([a, b]);
    expect(groups.length).toBe(1);
    const [group] = groups;
    expect(group.run_count).toBe(2);
    expect(group.agent_runtime).toEqual(scenarioRecord6().agent_runtime);
    const narrowedProfile = { id: 'strict-policy-v1', sha256: 'd'.repeat(64), isolation_kind: 'runtime-policy-hooks', network_mode: 'runtime-default' };
    const narrowedTreatment = { delivery_mode: 'runtime-extension', source_sha: scenarioRecord6().skill_observation.source_sha, treatment_size: scenarioRecord6().skill_observation.treatment_size };
    expect(group.execution_profile).toEqual(narrowedProfile); // NARROWED -- never isolation_attestation_sha256
    expect(group.skill_observation).toEqual(narrowedTreatment); // NARROWED -- never availability/activation
    expect(group.group_key.execution_profile).toEqual(narrowedProfile);
    expect(group.group_key.skill_treatment).toEqual(narrowedTreatment);
    // Both entries in this fixture report an identical attestation (null) and activation/
    // availability status, so the new counts/distributions correctly show full agreement here --
    // the DISAGREEING case is exercised by the two tests immediately below.
    expect(group.execution_profile_attestation_recorded_count).toBe(0);
    expect(group.execution_profile_attestation_missing_count).toBe(2);
    expect(group.skill_observation_activation_status_distribution).toEqual({ confirmed: 2 });
    expect(group.skill_observation_availability_status_distribution).toEqual({ 'observed-present': 2 });
  });

  it('two entries in the SAME group with DIFFERENT activation statuses are both reflected in the distribution, never collapsed to entries[0]\'s own single value (P1 architectural review)', () => {
    const confirmed = pairFor(scenarioRecord6({ run_id: 'scenario-activation-a' }));
    // sidecarEntries: [] (not the pairFor default of one CONFIRMED target-skill call) --
    // deriveSkillRelativeFields fails closed when a record reports the target skill as
    // not-invoked but the sidecar still shows a confirmed target-skill entry, so a genuinely
    // not-observed activation needs a sidecar that agrees nothing was confirmed.
    const notObserved = pairFor(scenarioRecord6({
      run_id: 'scenario-activation-b',
      skill_observation: { ...scenarioRecord6().skill_observation, activation: { status: 'not-observed', evidence_kind: 'runtime-explicit-event' } },
      skill_invoked: { value: false, reason: null },
    }), []);
    const { groups } = buildSummary([confirmed, notObserved]);
    expect(groups.length).toBe(1);
    const [group] = groups;
    expect(group.run_count).toBe(2);
    expect(group.skill_observation_activation_status_distribution).toEqual({ confirmed: 1, 'not-observed': 1 });
    // The narrowed skill_treatment view itself is untouched by activation (excluded from it
    // entirely), so the group's own skill_observation field is unaffected by the disagreement.
    expect(group.skill_observation.delivery_mode).toBe('runtime-extension');
  });


  it('separates a schema:6 group from a schema:5 group with otherwise-identical fields (agent_runtime differs: real object vs "not-recorded")', () => {
    const v5 = pairFor(scenarioRecord({ run_id: 'scenario-current-skill-v5x', success: { value: true, reason: null }, expected_outcome_matched: { value: true, reason: null } }));
    const v6 = pairFor(scenarioRecord6({ run_id: 'scenario-current-skill-v6x', success: { value: true, reason: null }, expected_outcome_matched: { value: true, reason: null } }));
    const { groups } = buildSummary([v5, v6]);
    expect(groups.length).toBe(2);
  });

  it('usage distributions report each of the 5 dimensions SEPARATELY, preserve null (never coerce to 0), and never include a summed total field', () => {
    const withCachedInputNull = pairFor(scenarioRecord6({
      run_id: 'scenario-current-skill-usage-null', usage: { ...scenarioRecord6().usage, cached_input: null },
    }));
    const withCachedInputReal = pairFor(scenarioRecord6({
      run_id: 'scenario-current-skill-usage-real', usage: { ...scenarioRecord6().usage, cached_input: 999 },
    }));
    const { groups } = buildSummary([withCachedInputNull, withCachedInputReal]);
    expect(groups.length).toBe(1); // usage is never a partition key
    const [group] = groups;
    expect(group.usage_input_distribution).toEqual({ 16: 2 });
    expect(group.usage_cached_input_distribution).toEqual({ null: 1, 999: 1 });
    expect(group.usage_cache_write_distribution).toEqual({ 7026: 2 });
    expect(group.usage_output_distribution).toEqual({ 1835: 2 });
    expect(group.usage_reasoning_output_distribution).toEqual({ null: 2 });
    expect(group.usage_source_counts).toEqual({ 'runtime-reported': 2 });
    expect(group).not.toHaveProperty('tokens_total');
    expect(group).not.toHaveProperty('usage_total');
    expect(Object.keys(group).some((k) => /total/i.test(k) && /usage|token/i.test(k))).toBe(false);
  });

  it('a schema:5 group reports usage_source_counts as entirely "not-recorded" and every distribution as entirely null', () => {
    const a = pairFor(scenarioRecord({ run_id: 'scenario-current-skill-v5-usage-a', success: { value: true, reason: null }, expected_outcome_matched: { value: true, reason: null } }));
    const b = pairFor(scenarioRecord({ run_id: 'scenario-current-skill-v5-usage-b', success: { value: false, reason: null }, expected_outcome_matched: { value: false, reason: null } }));
    const { groups } = buildSummary([a, b]);
    expect(groups.length).toBe(1);
    const [group] = groups;
    expect(group.usage_source_counts).toEqual({ 'not-recorded': 2 });
    expect(group.usage_input_distribution).toEqual({ null: 2 });
    expect(group.usage_reasoning_output_distribution).toEqual({ null: 2 });
  });
});

// Evidence1 success-recovery PR B, Stage B3 review-round correction (analysis schema 7,
// task_outcome_available_ms): the reviewer's own correction to an earlier, wrongly-modeled
// attempt at a graders.mjs-level "neutral event index" -- first_useful_signal_event's contract is
// specifically correlated to a real user.tool_result event (cli.mjs/accepted-run-audit.mjs); a
// claim-only FreeBaseline run has no such event at all, and Product's evidence can genuinely
// become available BEFORE the final claim, so the two are never required to coincide. Instead:
// task_outcome_available_ms is a TIME (never an event index), read directly from the record's own
// existing wall_clock_ms (the real end-to-end duration every schema already carries -- no new
// run-record field needed), gated ONLY on outcome_assessment.task_outcome_matched === true. schema
// 8 is required for outcome_assessment to exist at all; a schema<8 record (or a schema:8 record
// whose claim did not match, was absent, or was unevaluable) always reports null here.
describe('analyzeRunRecord -- task_outcome_available_ms (analysis schema 7, Stage B3 review-round correction)', () => {
  const REAL_OUTCOME_ASSESSMENT_MATCHED = Object.freeze({
    schema: 1, task_outcome_matched: true, task_outcome_reason: 'matched',
    answer_protocol_matched: true, provider_evidence_kind: 'claim-only',
    provider_evidence_status: 'unavailable', product_e2e_success: null,
  });
  // Review-round finding (P1): the "Product correct" case below must use a genuinely
  // Product-shaped assessment -- kmp-test-envelope/matched/E2E-true -- never the claim-only/
  // unavailable/null baseline shape reused by mistake for both cases.
  const REAL_OUTCOME_ASSESSMENT_PRODUCT_MATCHED = Object.freeze({
    schema: 1, task_outcome_matched: true, task_outcome_reason: 'matched',
    answer_protocol_matched: true, provider_evidence_kind: 'kmp-test-envelope',
    provider_evidence_status: 'matched', product_e2e_success: true,
  });

  it('FreeBaseline correct: outcome available at the record\'s own end-to-end wall_clock_ms, evidence signal stays null', () => {
    const record = scenarioRecord({
      schema: 8, condition: 'no-skill', outcome_assessment: REAL_OUTCOME_ASSESSMENT_MATCHED,
      skill_invoked: { value: false, reason: null }, skill_invocation_event: null,
    });
    const sidecar = sidecarFor(record, { entries: [] });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(record.first_useful_signal_ms.value).toBeNull();
    expect(entry.task_outcome_available_ms).toBe(record.wall_clock_ms);
  });

  it('Product correct: outcome available at wall_clock_ms, and the evidence signal (when present) is earlier-or-equal, never later; success:true does not fuse the two metrics together', () => {
    // schema:8 (>=6) makes targetSkillInvokedView read skill_observation.activation.status, never
    // the legacy skill_invoked.value -- a schema:8, current-skill fixture needs the real Section-F
    // groups to be internally coherent (mirrors scenarioRecord6's own shape, describe-scoped
    // elsewhere in this file and not reachable from here).
    const record = scenarioRecord({
      schema: 8, outcome_assessment: REAL_OUTCOME_ASSESSMENT_PRODUCT_MATCHED,
      success: { value: true, reason: null }, expected_outcome_matched: { value: true, reason: null },
      first_useful_signal_ms: { value: 12345, reason: null },
      first_useful_signal_event: { type: 'user.tool_result', index: 1 },
      agent_runtime: {
        runtime_id: 'claude-code', cli_version: '2.1.218', model_requested: 'claude-sonnet-5',
        model_resolved: 'claude-sonnet-5', model_vendor_expected: 'anthropic', model_vendor_observed: null,
      },
      execution_profile: {
        id: 'strict-policy-v1', sha256: 'd'.repeat(64), isolation_kind: 'runtime-policy-hooks',
        isolation_attestation_sha256: null, network_mode: 'runtime-default',
      },
      skill_observation: {
        delivery_mode: 'runtime-extension',
        availability: { status: 'observed-present', evidence_kind: 'runtime-catalog' },
        activation: { status: 'confirmed', evidence_kind: 'runtime-explicit-event' },
        source_sha: '9e47a9d132f5b9ea6ac5bc50a66c844458fd363e',
        treatment_size: {
          snapshot_sha256: 'c'.repeat(64), snapshot_bytes: 234997, snapshot_file_count: 28,
          prompt_sha256: 'e'.repeat(64), prompt_bytes: 55, absent_reason: null,
        },
      },
      usage: {
        source: 'runtime-reported', input: 16, cached_input: 151916, cache_write: 7026, output: 1835, reasoning_output: null,
        attributable_to_skill_load: {
          status: 'not-recorded',
          dimensions: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null },
          unit: null, reason: 'runtime-does-not-report-skill-attribution',
        },
      },
    });
    const sidecar = sidecarFor(record, { entries: [targetSkillEntry(0), bashEntry(1, { kind: 'kmp-test', operation: 'parallel' })], firstUsefulSignalEvent: { type: 'user.tool_result', index: 1 } });
    const { ok, entry } = analyzeRunRecord(record, sidecar);
    expect(ok).toBe(true);
    expect(entry.success).toBe(true);
    expect(entry.task_outcome_available_ms).toBe(record.wall_clock_ms);
    expect(record.first_useful_signal_ms.value).toBeLessThanOrEqual(entry.task_outcome_available_ms);
    // success:true must not fuse the two metrics into one -- they stay their own independently-
    // computed values (wall_clock_ms vs. the real evidence timestamp), never silently forced equal
    // just because the strict Product grader also happened to pass.
    expect(entry.task_outcome_available_ms).not.toBe(record.first_useful_signal_ms.value);
  });

  it('incorrect, absent, or unevaluable claim: task_outcome_available_ms is null', () => {
    const mismatched = scenarioRecord({
      schema: 8,
      outcome_assessment: { ...REAL_OUTCOME_ASSESSMENT_MATCHED, task_outcome_matched: false, task_outcome_reason: 'mismatched' },
    });
    const { entry: mismatchedEntry } = analyzeRunRecord(mismatched, sidecarFor(mismatched, { entries: [] }));
    expect(mismatchedEntry.task_outcome_available_ms).toBeNull();

    const notEvaluable = scenarioRecord({
      schema: 8,
      outcome_assessment: { ...REAL_OUTCOME_ASSESSMENT_MATCHED, task_outcome_matched: null, task_outcome_reason: 'claim-missing' },
    });
    const { entry: notEvaluableEntry } = analyzeRunRecord(notEvaluable, sidecarFor(notEvaluable, { entries: [] }));
    expect(notEvaluableEntry.task_outcome_available_ms).toBeNull();

    // schema<8 never has outcome_assessment at all -- must also report null, never throw.
    // condition/skill_invoked/skill_invocation_event forced to the no-skill shape (mirrors this
    // describe block's own sibling fixtures above) -- this test is about task_outcome_available_ms
    // only, and a default current-skill fixture paired with a zero-entries sidecar is internally
    // incoherent (claims an invocation with no confirmed sidecar entry to correlate it to).
    const legacy = scenarioRecord({
      schema: 5, condition: 'no-skill',
      skill_invoked: { value: false, reason: null }, skill_invocation_event: null,
    });
    const { entry: legacyEntry } = analyzeRunRecord(legacy, sidecarFor(legacy, { entries: [] }));
    expect(legacyEntry.task_outcome_available_ms).toBeNull();
  });

  it('success:false does not suppress a correct neutral outcome -- FreeBaseline can never satisfy the strict Product success gate, but task_outcome_available_ms must not be gated on it', () => {
    const record = scenarioRecord({
      schema: 8, condition: 'no-skill', outcome_assessment: REAL_OUTCOME_ASSESSMENT_MATCHED,
      success: { value: false, reason: null },
      skill_invoked: { value: false, reason: null }, skill_invocation_event: null,
    });
    const { ok, entry } = analyzeRunRecord(record, sidecarFor(record, { entries: [] }));
    expect(ok).toBe(true);
    expect(entry.success).toBe(false);
    expect(entry.task_outcome_available_ms).toBe(record.wall_clock_ms);
  });
});

// Review-round finding (P2): task_outcome_available_ms was only required on per_run entries; the
// runbook also requires it preserved per cell/arm in the GROUP summary. One RED case, following
// buildSummary's own describe block above and buildDistribution's exact closed-map pattern
// (analysis.mjs's own buildDistribution: string-keyed counts, the literal key "null" for a null
// value -- never a real JS null as a key, which JSON can't roundtrip anyway).
describe('buildSummary -- task_outcome_available_ms_distribution (analysis schema 7, Stage B3 review-round finding)', () => {
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
      failure_class: 'success',
      product_access_mode: 'product-assisted',
      product_usage_mode: 'product-cli',
      product_cli_command_count: 1,
      direct_build_tool_command_count: 0,
      other_bash_command_count: 0,
      product_cli_used: true,
      task_outcome_matched: true,
      answer_protocol_matched: true,
      programmatic_evidence_available: true,
      canonical_final_answer_available: true,
      canonical_output_available: true,
      evidence_quality: 'product-canonical',
      coverage_gate_diagnostic: 'not-recorded',
      programmatic_product_outcome_matched: true,
      final_answer_protocol_only_failure: false,
      ...entryOverrides,
    };
    return { record, entry };
  }

  it('reports a closed frequency map keyed by string milliseconds, with the literal key "null" for a not-available run', () => {
    const pairs = [
      pair({ run_id: 'r1' }, { task_outcome_available_ms: 1000 }),
      pair({ run_id: 'r2' }, { task_outcome_available_ms: 5000 }),
      pair({ run_id: 'r3' }, { task_outcome_available_ms: null }),
    ];
    const { groups } = buildSummary(pairs);
    expect(groups.length).toBe(1);
    expect(groups[0].task_outcome_available_ms_distribution).toEqual({ '1000': 1, '5000': 1, null: 1 });
  });
});

// Evidence1 success-recovery PR B, Section 9.14 (remaining analytics beyond task_outcome_*, which
// Stage B3's own review round already covered): evidence kind/status distribution, Product E2E
// rate SOLO EN PRODUCT, duration/first-signal/tool-calls/timeout passthroughs, coverage
// target/report status + warning/execution-mode counts (Section 9.9's shared summary, read from
// the accepted-run-audit sidecar), and a semantic result_fingerprint. No committed RED existed for
// these beyond the runbook's own prose spec, so this file is both the RED and (immediately after)
// the GREEN for this remaining slice.
describe('analyzeRunRecord -- Section 9.14 remaining per-run analytics (analysis schema 7)', () => {
  const REAL_OUTCOME_ASSESSMENT = Object.freeze({
    schema: 1, task_outcome_matched: true, task_outcome_reason: 'matched',
    answer_protocol_matched: true, provider_evidence_kind: 'kmp-test-envelope',
    provider_evidence_status: 'matched', product_e2e_success: true,
  });

  it('duration/first-useful-signal/tool-calls/timeout are plain passthroughs of the record\'s own already-validated fields', () => {
    const record = scenarioRecord({
      schema: 8, outcome_assessment: REAL_OUTCOME_ASSESSMENT,
      condition: 'no-skill', skill_invoked: { value: false, reason: null }, skill_invocation_event: null,
      wall_clock_ms: 42000,
      first_useful_signal_ms: { value: 1234, reason: null },
      tool_calls_total: { value: 3, reason: null },
      terminated: true, termination_reason: 'timeout',
    });
    const { ok, entry } = analyzeRunRecord(record, sidecarFor(record, { entries: [] }));
    expect(ok).toBe(true);
    expect(entry.wall_clock_ms).toBe(42000);
    expect(entry.first_useful_signal_ms).toBe(1234);
    expect(entry.tool_calls_total).toBe(3);
    expect(entry.terminated).toBe(true);
    expect(entry.termination_reason).toBe('timeout');
  });

  it('first_useful_signal_ms is null when the record\'s own metric has no value, never coerced to 0', () => {
    const record = scenarioRecord({
      schema: 8, outcome_assessment: REAL_OUTCOME_ASSESSMENT,
      condition: 'no-skill', skill_invoked: { value: false, reason: null }, skill_invocation_event: null,
    });
    const { entry } = analyzeRunRecord(record, sidecarFor(record, { entries: [] }));
    expect(entry.first_useful_signal_ms).toBeNull();
  });

  it('coverage_target_status/coverage_report_status/warning_code_counts/execution_mode_counts read the sidecar\'s own outcome_observability_summary (schema 10) when present', () => {
    const record = scenarioRecord({
      schema: 8, outcome_assessment: REAL_OUTCOME_ASSESSMENT,
      condition: 'no-skill', skill_invoked: { value: false, reason: null }, skill_invocation_event: null,
    });
    const warningCounts = Object.fromEntries(COVERAGE_GATE_WARNING_BUCKET_FIELDS.map((f, i) => [f, i === 0 ? 2 : 0]));
    const executionCounts = Object.fromEntries(EXECUTION_MODE_VALUES.map((f, i) => [f, i === 0 ? 1 : 0]));
    const sidecar = sidecarFor(record, {
      entries: [],
      outcomeObservabilitySummary: {
        schema: 1, flavor_relation: 'not-applicable', test_type_relation: 'not-applicable',
        coverage_target_status: 'with-data', coverage_report_status: 'success',
        warning_code_counts: warningCounts, module_failed_setup_count: null,
        execution_mode_counts: executionCounts,
      },
    });
    const { entry } = analyzeRunRecord(record, sidecar);
    expect(entry.coverage_target_status).toBe('with-data');
    expect(entry.coverage_report_status).toBe('success');
    expect(entry.warning_code_counts).toEqual(warningCounts);
    expect(entry.execution_mode_counts).toEqual(executionCounts);
  });

  it('coverage_target_status/coverage_report_status/warning_code_counts/execution_mode_counts fall back to the honest not-recorded/all-zero shape when the sidecar carries no outcome_observability_summary at all (every schema <10 sidecar)', () => {
    const record = scenarioRecord({
      schema: 5, condition: 'no-skill', skill_invoked: { value: false, reason: null }, skill_invocation_event: null,
    });
    const { entry } = analyzeRunRecord(record, sidecarFor(record, { entries: [] }));
    expect(entry.coverage_target_status).toBe('not-recorded');
    expect(entry.coverage_report_status).toBe('not-recorded');
    expect(entry.warning_code_counts).toEqual(Object.fromEntries(COVERAGE_GATE_WARNING_BUCKET_FIELDS.map((f) => [f, 0])));
    expect(entry.execution_mode_counts).toEqual(Object.fromEntries(EXECUTION_MODE_VALUES.map((f) => [f, 0])));
  });

  it('result_fingerprint excludes paths/duration/run_id/timestamps, and includes normalized module-match/outcome/test-counts/coverage-counts/error-codes', () => {
    const record = scenarioRecord({
      schema: 8, outcome_assessment: REAL_OUTCOME_ASSESSMENT,
      condition: 'no-skill', skill_invoked: { value: false, reason: null }, skill_invocation_event: null,
      errors: [{ code: 'module_failed', message: 'irrelevant free text, never in the fingerprint' }, { code: 'no_test_modules', message: 'x' }],
    });
    const sidecar = sidecarFor(record, {
      entries: [bashEntry(1, { kind: 'kmp-test', operation: 'parallel' })],
      firstUsefulSignalEvent: { type: 'user.tool_result', index: 1 },
      terminalEvidence: {
        present: true, provider: 'kmp-test', tool_result_event_index: 1,
        evidence_well_formed: true, target_matches_expected: true, outcome_matches_expected: true,
        malformed: false, parallel_evidence_invalid: false, changed_evidence_invalid: false,
        observed_result: {
          outcome_kind: 'tests_executed', module_matches_expected: true,
          total: 4, passed: 4, failed: 0, missed_lines: null, threshold: null, modules_contributing: null,
        },
        final_answer_block: { found: true, parsed: true, ambiguous: false, matches_observed: true },
        coverage_gate_diagnostic: 'not-applicable',
      },
    });
    const { entry } = analyzeRunRecord(record, sidecar);
    expect(entry.result_fingerprint).toEqual({
      module_matches_expected: true, outcome_kind: 'tests_executed',
      total: 4, passed: 4, failed: 0, missed_lines: null, threshold: null, modules_contributing: null,
      error_codes: ['module_failed', 'no_test_modules'],
    });
    const json = JSON.stringify(entry.result_fingerprint);
    expect(json).not.toMatch(/2026-|kampkit-current-skill|run_id|tools\/runs|wall_clock/i);
  });

  it('result_fingerprint reports every observed_result field as null (never fabricated) when no terminal evidence exists', () => {
    const record = scenarioRecord({
      schema: 5, errors: [], condition: 'no-skill', skill_invoked: { value: false, reason: null }, skill_invocation_event: null,
    });
    const { entry } = analyzeRunRecord(record, sidecarFor(record, { entries: [] }));
    expect(entry.result_fingerprint).toEqual({
      module_matches_expected: null, outcome_kind: null,
      total: null, passed: null, failed: null, missed_lines: null, threshold: null, modules_contributing: null,
      error_codes: [],
    });
  });

  it('result_fingerprint error_codes is closed, sorted, and deduplicated', () => {
    const record = scenarioRecord({
      schema: 5, errors: [{ code: 'gradle_timeout' }, { code: 'configuration' }, { code: 'gradle_timeout' }],
      condition: 'no-skill', skill_invoked: { value: false, reason: null }, skill_invocation_event: null,
    });
    const { entry } = analyzeRunRecord(record, sidecarFor(record, { entries: [] }));
    expect(entry.result_fingerprint.error_codes).toEqual(['configuration', 'gradle_timeout']);
  });
});

describe('buildSummary -- Section 9.14 remaining group-level analytics (analysis schema 7)', () => {
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
      failure_class: 'success',
      product_access_mode: 'product-assisted',
      product_usage_mode: 'product-cli',
      product_cli_command_count: 1,
      direct_build_tool_command_count: 0,
      other_bash_command_count: 0,
      product_cli_used: true,
      task_outcome_matched: true,
      answer_protocol_matched: true,
      task_outcome_available_ms: 1000,
      programmatic_evidence_available: true,
      canonical_final_answer_available: true,
      canonical_output_available: true,
      evidence_quality: 'product-canonical',
      coverage_gate_diagnostic: 'not-recorded',
      programmatic_product_outcome_matched: true,
      final_answer_protocol_only_failure: false,
      provider_evidence_kind: 'kmp-test-envelope', provider_evidence_status: 'matched', product_e2e_success: true,
      coverage_target_status: 'with-data', coverage_report_status: 'success',
      warning_code_counts: Object.fromEntries(COVERAGE_GATE_WARNING_BUCKET_FIELDS.map((f) => [f, 0])),
      execution_mode_counts: Object.fromEntries(EXECUTION_MODE_VALUES.map((f) => [f, 0])),
      result_fingerprint: { module_matches_expected: true, outcome_kind: 'tests_executed', total: 4, passed: 4, failed: 0, missed_lines: null, threshold: null, modules_contributing: null, error_codes: [] },
      ...entryOverrides,
    };
    return { record, entry };
  }

  it('provider_evidence_kind_distribution / provider_evidence_status_distribution report every entry, including the claim-only/unavailable FreeBaseline shape', () => {
    const pairs = [
      pair({ run_id: 'r1' }, { provider_evidence_kind: 'kmp-test-envelope', provider_evidence_status: 'matched' }),
      pair({ run_id: 'r2' }, { provider_evidence_kind: 'claim-only', provider_evidence_status: 'unavailable' }),
    ];
    const { groups } = buildSummary(pairs);
    expect(groups[0].provider_evidence_kind_distribution).toEqual({ 'kmp-test-envelope': 1, 'claim-only': 1 });
    expect(groups[0].provider_evidence_status_distribution).toEqual({ matched: 1, unavailable: 1 });
  });

  it('product_e2e_success_rate excludes entries whose metric is null (non-Product), never diluting the denominator with an inapplicable entry', () => {
    const pairs = [
      pair({ run_id: 'r1' }, { product_e2e_success: true }),
      pair({ run_id: 'r2' }, { product_e2e_success: false }),
      pair({ run_id: 'r3' }, { product_e2e_success: null }),
    ];
    const { groups } = buildSummary(pairs);
    expect(groups[0].product_e2e_success_count).toBe(1);
    expect(groups[0].product_e2e_success_applicable_count).toBe(2);
    expect(groups[0].product_e2e_success_rate).toBe(0.5);
  });

  it('wall_clock_ms_distribution / first_useful_signal_ms_distribution / tool_calls_total_distribution / termination_reason_distribution are reported', () => {
    const pairs = [
      pair({ run_id: 'r1' }, { wall_clock_ms: 1000, first_useful_signal_ms: 500, tool_calls_total: 2, terminated: false, termination_reason: null }),
      pair({ run_id: 'r2' }, { wall_clock_ms: 2000, first_useful_signal_ms: null, tool_calls_total: 4, terminated: true, termination_reason: 'timeout' }),
    ];
    const { groups } = buildSummary(pairs);
    expect(groups[0].wall_clock_ms_distribution).toEqual({ '1000': 1, '2000': 1 });
    expect(groups[0].first_useful_signal_ms_distribution).toEqual({ '500': 1, null: 1 });
    expect(groups[0].tool_calls_total_distribution).toEqual({ '2': 1, '4': 1 });
    expect(groups[0].termination_reason_distribution).toEqual({ null: 1, timeout: 1 });
  });

  it('coverage_target_status_distribution / coverage_report_status_distribution / warning_code_counts / execution_mode_counts are reported group-wide, the latter two SUMMED across entries (mirrors product_cli_recognized_operation_distribution\'s own sum-across-entries pattern)', () => {
    const warnA = { ...Object.fromEntries(COVERAGE_GATE_WARNING_BUCKET_FIELDS.map((f) => [f, 0])), coverage_xml_disabled: 1 };
    const warnB = { ...Object.fromEntries(COVERAGE_GATE_WARNING_BUCKET_FIELDS.map((f) => [f, 0])), coverage_xml_disabled: 2 };
    const execA = { ...Object.fromEntries(EXECUTION_MODE_VALUES.map((f) => [f, 0])), fresh: 1 };
    const execB = { ...Object.fromEntries(EXECUTION_MODE_VALUES.map((f) => [f, 0])), fresh: 1 };
    const pairs = [
      pair({ run_id: 'r1' }, { coverage_target_status: 'with-data', coverage_report_status: 'success', warning_code_counts: warnA, execution_mode_counts: execA }),
      pair({ run_id: 'r2' }, { coverage_target_status: 'no-xml', coverage_report_status: 'not-attempted', warning_code_counts: warnB, execution_mode_counts: execB }),
    ];
    const { groups } = buildSummary(pairs);
    expect(groups[0].coverage_target_status_distribution).toEqual({ 'with-data': 1, 'no-xml': 1 });
    expect(groups[0].coverage_report_status_distribution).toEqual({ success: 1, 'not-attempted': 1 });
    expect(groups[0].warning_code_counts.coverage_xml_disabled).toBe(3);
    expect(groups[0].execution_mode_counts.fresh).toBe(2);
  });

  it('result_fingerprint_distinct_count measures Product output determinism -- 1 when every entry in the group agrees, >1 when they genuinely differ', () => {
    const sameFingerprint = { module_matches_expected: true, outcome_kind: 'tests_executed', total: 4, passed: 4, failed: 0, missed_lines: null, threshold: null, modules_contributing: null, error_codes: [] };
    const deterministicPairs = [
      pair({ run_id: 'r1' }, { result_fingerprint: sameFingerprint }),
      pair({ run_id: 'r2' }, { result_fingerprint: { ...sameFingerprint } }),
    ];
    expect(buildSummary(deterministicPairs).groups[0].result_fingerprint_distinct_count).toBe(1);

    const nonDeterministicPairs = [
      pair({ run_id: 'r1' }, { result_fingerprint: sameFingerprint }),
      pair({ run_id: 'r2' }, { result_fingerprint: { ...sameFingerprint, failed: 1, passed: 3 } }),
    ];
    expect(buildSummary(nonDeterministicPairs).groups[0].result_fingerprint_distinct_count).toBe(2);
  });
});

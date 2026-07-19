// tests/vitest/agentic-eval-hard-gates.test.js
// Isolated unit tests for calibrationHardGate/smokeHardGate (tools/agentic-eval/cli.mjs).
//
// Both gates were extracted from inline closures into named, exported functions specifically so
// each sub-check could be unit-tested in isolation with precise synthetic inputs -- an
// independent review pass found the ORIGINAL inline gates insufficient (missing several checks
// entirely) and separately observed that real subprocess fixtures tend to fail for MULTIPLE
// simultaneous reasons at once, so a negative fixture couldn't prove it isolates the ONE failure
// mode it claims to. Constructing a real subprocess fixture that fails EXACTLY one sub-check and
// none of the others is fragile in a different way too: it's not actually verified anywhere what,
// say, a denied command's own tool_result looks like on a real transcript, so fabricating one for
// a fixture risks encoding an unverified guess as if it were confirmed fact. Testing the gate
// FUNCTIONS directly with synthetic data sidesteps both problems -- each test below flips exactly
// one input, asserts exactly one named sub-check goes false, and asserts every OTHER named
// sub-check stays true in the same failure-reason string.
//
// The real-subprocess fake-claude fixtures (agentic-eval-cli-integration.test.js) remain
// necessary too, for a different reason: they prove the gate is actually WIRED UP end-to-end
// (real stream-json parsing -> real hookStats/bashResults -> this gate -> exit code/evidence
// writing). Where a single fake-claude scenario trips more than one sub-check at once, that's
// disclosed inline in that file's scenario comments, not presented as single-cause isolation.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calibrationHardGate, smokeHardGate } from '../../tools/agentic-eval/cli.mjs';

function bashToolUseEvent(id, command) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] } };
}

function toolResultEvent(id, isError = false) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: isError ? 'error' : 'ok', is_error: isError, tool_use_id: id }] } };
}

function initEventStub() {
  return { type: 'system', subtype: 'init' };
}

function resultEventStub() {
  return { type: 'result', subtype: 'success' };
}

function assistantTextEvent(text) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

// isPluginBoundToSnapshot (cli.mjs) compares the plugin's own reported `path` against the run's
// actually-materialized snapshotDir by filesystem IDENTITY (dev+ino via statSync) -- both sides
// must exist as a REAL path on disk, so a hardcoded string like the old '/fake' placeholder can
// never satisfy it. A real, empty temp directory is enough: only its filesystem identity matters,
// never its contents. (An earlier version of this comment said "realpath-based comparison" --
// stale since a review-round-5 fix replaced that with the dev+ino comparison described above;
// see agentic-eval-plugin-snapshot-identity.test.js for dedicated coverage of that comparison
// itself.) WRONG_SNAPSHOT_DIR is a SECOND, distinct real directory -- used only by
// pluginSnapshotBindingOk's own negative test, to prove a same-named plugin loaded from the wrong
// (but still real, resolvable) location is rejected, not just an unresolvable one.
const FAKE_SNAPSHOT_DIR = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-test-snapshot-'));
const WRONG_SNAPSHOT_DIR = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-test-wrong-snapshot-'));

afterAll(() => {
  rmSync(FAKE_SNAPSHOT_DIR, { recursive: true, force: true });
  rmSync(WRONG_SNAPSHOT_DIR, { recursive: true, force: true });
});

const KMP_TEST_RUNNER_PLUGIN = [{ name: 'kmp-test-runner', path: FAKE_SNAPSHOT_DIR, source: 'fake' }];

function passA(overrides = {}) {
  return {
    skill_available: { value: false, reason: null },
    skill_invocation_attempted: { value: true, reason: null },
    skill_invoked: { value: false, reason: null },
    terminated: false,
    exit_code: 0,
    hook_call_count: 2,
    hook_deny_count: 0,
    ...overrides,
  };
}

function passB(overrides = {}) {
  return {
    skill_available: { value: true, reason: null },
    skill_invocation_attempted: { value: true, reason: null },
    skill_invoked: { value: true, reason: null },
    terminated: false,
    exit_code: 0,
    hook_call_count: 2,
    hook_deny_count: 0,
    ...overrides,
  };
}

function passRunResult(overrides = {}) {
  return {
    init: {
      model: 'claude-sonnet-5-fake-resolved',
      plugins: [],
      tools: ['Bash', 'Skill'],
      mcp_servers: [],
      permissionMode: 'dontAsk',
    },
    result: { subtype: 'success', is_error: false },
    hookStats: { everyCallHooked: true, hookAllowCount: 2 },
    bashResults: [
      { command: 'kmp-test doctor --json', resultFound: true, resultIsError: false },
      { command: 'kmp-test describe --json', resultFound: true, resultIsError: false },
    ],
    events: [
      initEventStub(),
      bashToolUseEvent('toolu_1', 'kmp-test doctor --json'),
      toolResultEvent('toolu_1'),
      bashToolUseEvent('toolu_2', 'kmp-test describe --json'),
      toolResultEvent('toolu_2'),
      resultEventStub(),
    ],
    malformedLines: [],
    // Only meaningful when this object is used as the CURRENT-SKILL (B) side -- see
    // isPluginBoundToSnapshot's own doc comment (cli.mjs). Defaults to FAKE_SNAPSHOT_DIR so every
    // existing "good" B-shape override (which sets plugins: KMP_TEST_RUNNER_PLUGIN but does not
    // otherwise touch snapshotDir) is automatically bound correctly, with zero changes needed at
    // those call sites; only pluginSnapshotBindingOk's own dedicated negative tests override this.
    snapshotDir: FAKE_SNAPSHOT_DIR,
    ...overrides,
  };
}

describe('calibrationHardGate', () => {
  it('passes when every sub-check is satisfied', () => {
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  it('isolates currentInvocationOk -- B never confirms invocation (the real "Unknown skill" shape: attempted but not invoked)', () => {
    const b = passB({ skill_invoked: { value: false, reason: 'attempted but not confirmed' } });
    const { ok, reason } = calibrationHardGate(passA(), b, passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:false');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
  });

  it('isolates availabilityOk -- A shows the skill as available (breaks the no-skill/current-skill contrast)', () => {
    const a = passA({ skill_available: { value: true, reason: null } });
    const { ok, reason } = calibrationHardGate(a, passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:false');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
  });

  it('isolates processOk -- B exits nonzero', () => {
    const b = passB({ exit_code: 1 });
    const { ok, reason } = calibrationHardGate(passA(), b, passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('processOk:false');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
  });

  it('isolates processOk -- A was terminated (timeout/signal)', () => {
    const a = passA({ terminated: true });
    const { ok, reason } = calibrationHardGate(a, passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('processOk:false');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
  });

  it('isolates resultOk -- B\'s own result event reports is_error:true', () => {
    const runB = passRunResult({ result: { is_error: true }, init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:false');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
  });

  it('isolates resultOk -- no result event was ever found (undefined, not false)', () => {
    const runA = passRunResult({ result: null });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('resultOk:false');
  });

  // Regression coverage for a real bypass an independent review pass demonstrated: a session
  // truncated by, say, the budget cap can report a distinct result.subtype (confirmed:
  // 'error_max_budget_usd') that is NOT necessarily paired with is_error:true -- so is_error
  // alone previously let a genuinely-interrupted session pass resultOk.
  it('isolates resultOk -- B\'s result event has is_error:false but subtype is NOT success (the budget-cap-truncation shape)', () => {
    const runB = passRunResult({ result: { subtype: 'error_max_budget_usd', is_error: false }, init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('initOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:false');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
  });

  // Regression coverage for a real bypass: a session with NO init event at all is a
  // fundamentally broken/incomplete capture -- without initOk, a no-init run's derived
  // skill_available:false for the no-skill arm could coincidentally match the EXPECTED value,
  // passing availabilityOk for the wrong reason (nothing to derive availability from, not a
  // genuine observation).
  it('isolates initOk -- A never produced an init event at all', () => {
    const runA = passRunResult({ init: null });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    // pluginProfileOk is NOT asserted here (same as toolProfileOk below) -- A's init is null, so
    // pluginProfileOk cascades to false too via the same guard clause, for the same underlying
    // reason (nothing to check plugins on), not a second independent cause.
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('initOk:false');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
  });

  // Regression coverage for a real gap an independent review pass demonstrated: a hard gate
  // that only checks init!=null can't distinguish a genuinely narrow session from one that
  // regressed to a wider tool/MCP/permission profile.
  it('isolates toolProfileOk -- B\'s init event declares Read alongside Bash/Skill', () => {
    const runB = passRunResult({ init: { ...passRunResult().init, tools: ['Bash', 'Skill', 'Read'], plugins: KMP_TEST_RUNNER_PLUGIN } });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('initOk:true');
    expect(reason).toContain('toolProfileOk:false');
    expect(reason).toContain('noUnexpectedToolsOk:true');
    expect(reason).toContain('processOk:true');
  });

  it('isolates toolProfileOk -- A\'s init event declares a non-empty mcp_servers list', () => {
    const runA = passRunResult({ init: { ...passRunResult().init, mcp_servers: [{ name: 'unexpected' }] } });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('toolProfileOk:false');
    expect(reason).toContain('noUnexpectedToolsOk:true');
  });

  it('isolates toolProfileOk -- B\'s init event has permissionMode !== dontAsk', () => {
    const runB = passRunResult({ init: { ...passRunResult().init, permissionMode: 'bypassPermissions' } });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('toolProfileOk:false');
  });

  // Regression coverage for the real adversarial transcript an independent review pass
  // constructed: Read enabled AND invoked, alongside both expected Bash calls succeeding --
  // the OLD gate returned {ok:true} for exactly this transcript.
  it('isolates noUnexpectedToolsOk -- B invoked Read alongside the expected Bash calls', () => {
    const base = passRunResult();
    // The Read call gets its own correlated tool_result too -- otherwise it would ALSO trip
    // toolResultsCompleteOk, muddying this test's single-cause isolation of noUnexpectedToolsOk.
    const runB = passRunResult({
      events: [...base.events, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id: 'toolu_evil', input: { file_path: '/etc/passwd' } }] } }, toolResultEvent('toolu_evil')],
      init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN },
    });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('initOk:true');
    expect(reason).toContain('toolProfileOk:true');
    expect(reason).toContain('noUnexpectedToolsOk:false');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
  });

  it('isolates hookAccountingOk -- not every Bash call in B reached the policy hook', () => {
    const runB = passRunResult({ hookStats: { everyCallHooked: false, hookAllowCount: 2 }, init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:false');
  });

  // Regression coverage for a real live finding (agentic-eval revalidation, 2026-07-19): a live
  // no-skill run came back attempted:false, invoked:false -- the model correctly recognized the
  // skill wasn't in its available tool list and didn't try it at all. The OLD gate rejected this
  // as a failure; it's actually just as legitimate isolation proof as attempt-then-"Unknown skill".
  it('passes when A never attempted the skill at all (legitimate -- correctly recognized as unavailable without trying)', () => {
    const a = passA({ skill_invocation_attempted: { value: false, reason: null } });
    const { ok, reason } = calibrationHardGate(a, passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  it('passes when A attempted the skill and got a clean non-invocation (the "Unknown skill" shape -- also legitimate)', () => {
    const a = passA({ skill_invocation_attempted: { value: true, reason: null }, skill_invoked: { value: false, reason: null } });
    const { ok, reason } = calibrationHardGate(a, passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  it('isolates noSkillSafetyOk -- A somehow shows a confirmed invocation despite being the no-skill arm (contradictory input, must still fail)', () => {
    const a = passA({ skill_invoked: { value: true, reason: null } });
    const { ok, reason } = calibrationHardGate(a, passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('noSkillSafetyOk:false');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
  });

  // Regression coverage for a review-round-2 finding: skill_invocation_attempted is a nullable
  // metric and CAN legitimately be unobserved -- a null value must not silently pass just because
  // invoked happens to read false. Distinct from attempted:false, which is a genuine, positive
  // "did not attempt" observation, not a capture gap.
  it('isolates noSkillSafetyOk -- A\'s skill_invocation_attempted is null (unobserved capture, not a genuine "did not attempt" observation)', () => {
    const a = passA({ skill_invocation_attempted: { value: null, reason: 'capture incomplete' } });
    const { ok, reason } = calibrationHardGate(a, passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('noSkillSafetyOk:false');
    expect(reason).toContain('currentInvocationOk:true');
  });

  // Regression coverage for a review-round-2 finding: B's contract stays strict even though A's
  // was relaxed -- this is the exact counterpart of the newly-tolerated A shape and must still
  // fail, specifically via currentInvocationOk, not be accidentally tolerated by symmetry with A.
  it('isolates currentInvocationOk -- B never attempts the skill at all (unlike A, B\'s contract stays strict)', () => {
    const b = passB({ skill_invocation_attempted: { value: false, reason: null }, skill_invoked: { value: false, reason: null } });
    const { ok, reason } = calibrationHardGate(passA(), b, passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:false');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
  });

  // Regression coverage for a real bypass an independent review pass demonstrated against the
  // relaxed no-skill contract: the OLD single invocationOk check happened to catch this
  // accidentally (it required A to show attempted:true, which a foreign-skill-only transcript
  // never does); relaxing to tolerate attempted:false made this reachable. A no-skill arm that
  // calls an entirely UNRELATED skill still shows attempted:false/invoked:false for
  // kmp-test-runner (that call is invisible to findSkillInvocation) and must not silently pass.
  function foreignSkillToolUseEvent(skillArg) {
    const input = skillArg === undefined ? {} : { skill: skillArg };
    return { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_foreign', name: 'Skill', input }] } };
  }

  it('isolates skillSelectionOk -- A calls an entirely unrelated Skill (evidence-contamination bypass)', () => {
    const base = passRunResult();
    const runA = passRunResult({ events: [...base.events, foreignSkillToolUseEvent('some-other-skill')] });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:false');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
  });

  it('isolates skillSelectionOk -- B calls an entirely unrelated Skill in addition to the real one', () => {
    const base = passRunResult();
    const runB = passRunResult({ events: [...base.events, foreignSkillToolUseEvent('some-other-skill')] });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('skillSelectionOk:false');
  });

  it('isolates skillSelectionOk -- A calls Skill with a missing input.skill', () => {
    const base = passRunResult();
    const runA = passRunResult({ events: [...base.events, foreignSkillToolUseEvent(undefined)] });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('skillSelectionOk:false');
  });

  // Regression coverage for a review-round-3 finding: only smokeHardGate had cleanTranscriptOk --
  // a malformed/truncated JSONL line could hide exactly a Skill tool_use or its result,
  // artificially producing attempted:false for A, which the relaxed no-skill contract now
  // legitimately tolerates. Calibration needs the same protection smoke already had.
  it('isolates cleanTranscriptOk -- A has a malformed/truncated JSONL line', () => {
    const runA = passRunResult({ malformedLines: ['{not valid json'] });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('cleanTranscriptOk:false');
  });

  it('isolates cleanTranscriptOk -- B has a malformed/truncated JSONL line', () => {
    const runB = passRunResult({ malformedLines: ['{not valid json'], init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('cleanTranscriptOk:false');
  });

  // Regression coverage for a review-round-3 finding: neither isSkillAvailable nor
  // hasExpectedToolProfile ever inspects init.plugins[] itself -- an unexpected third-party
  // plugin, or a missing plugins field, went completely undetected as long as skill_available
  // for the TARGET skill happened to derive correctly.
  it('isolates pluginProfileOk -- A has a foreign plugin loaded (real isolation break, not a scoring artifact)', () => {
    const runA = passRunResult({ init: { ...passRunResult().init, plugins: [{ name: 'some-other-plugin', path: '/fake', source: 'fake' }] } });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:false');
  });

  it('isolates pluginProfileOk -- A has no plugins field at all (undefined, not a genuine empty-array observation)', () => {
    const runA = passRunResult({ init: { model: 'claude-sonnet-5-fake-resolved', tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' } });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:false');
  });

  it('isolates pluginProfileOk -- B has kmp-test-runner PLUS an extra, unexpected plugin', () => {
    const runB = passRunResult({ init: { ...passRunResult().init, plugins: [...KMP_TEST_RUNNER_PLUGIN, { name: 'some-other-plugin', path: '/fake', source: 'fake' }] } });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:false');
  });

  it('isolates pluginProfileOk -- B has zero plugins loaded (should have exactly kmp-test-runner)', () => {
    const runB = passRunResult({ init: { ...passRunResult().init, plugins: [] } });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:false');
  });

  // Regression coverage for a review-round-3 finding, the sharpest one: findSkillInvocation
  // correctly reports confirmed:false for a Skill attempt with NO correlated tool_result (a
  // dangling attempt, transcript cut short before a result arrived) -- but the gate previously
  // treated attempted:true/invoked:false UNIFORMLY as the "clean Unknown skill" shape, regardless
  // of WHETHER a real result was ever found. A dangling attempt is an INCOMPLETE capture, not a
  // demonstrated rejection, and must not be silently accepted as equivalent.
  it('isolates toolResultsCompleteOk -- A attempted the skill but no correlated tool_result exists anywhere (dangling attempt, not a demonstrated Unknown-skill rejection)', () => {
    const danglingSkillAttempt = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_dangling', name: 'Skill', input: { skill: 'kmp-test-runner' } }] } };
    const base = passRunResult();
    const runA = passRunResult({ events: [...base.events, danglingSkillAttempt] });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('toolResultsCompleteOk:false');
  });

  it('isolates toolResultsCompleteOk -- B has a dangling Bash call with no correlated tool_result', () => {
    const danglingBash = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_dangling_bash', name: 'Bash', input: { command: 'kmp-test parallel --json' } }] } };
    const base = passRunResult();
    const runB = passRunResult({ events: [...base.events, danglingBash], init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('toolResultsCompleteOk:false');
  });

  // A tool_use with NO id at all also has no way to be UNIQUELY identified, so this fixture
  // necessarily also cascades into transcriptStructureOk's own empty_tool_use_id check (added
  // later, see below) -- not asserted here since this test's own point is toolResultsCompleteOk,
  // but disclosed rather than left as an unexplained coincidence between the two.
  it('isolates toolResultsCompleteOk -- A has a tool_use with no id at all (cannot be correlated, so it can never be proven complete)', () => {
    const noIdToolUse = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'kmp-test parallel --json' } }] } };
    const base = passRunResult();
    const runA = passRunResult({ events: [...base.events, noIdToolUse] });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('toolResultsCompleteOk:false');
  });

  // Regression coverage for a review-round-4 finding: hasExpectedPluginProfile only checks the
  // loaded plugin's NAME and count, never its own `path` -- a same-named "kmp-test-runner" plugin
  // loaded from a completely unrelated directory satisfied pluginProfileOk outright, while the
  // record still published skill_source_sha as the pinned SHA regardless. Reproduced directly
  // against the gate as it stood: a plugin named correctly but loaded from an arbitrary wrong
  // directory passed calibrationHardGate entirely. See isPluginBoundToSnapshot's own doc comment
  // (cli.mjs) for the full provenance rationale.
  it('isolates pluginSnapshotBindingOk -- B loads a correctly-NAMED plugin from the WRONG directory (the exact evidence-contamination bypass this closes)', () => {
    const runB = passRunResult({
      init: { ...passRunResult().init, plugins: [{ name: 'kmp-test-runner', path: WRONG_SNAPSHOT_DIR, source: 'fake' }] },
    });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('pluginSnapshotBindingOk:false');
  });

  it('isolates pluginSnapshotBindingOk -- B\'s own snapshotDir is missing (null), so a correctly-named-and-pathed plugin still cannot be bound', () => {
    const runB = passRunResult({
      init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN },
      snapshotDir: null,
    });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('pluginSnapshotBindingOk:false');
  });

  // Regression coverage for a review-round-4 finding: findInitEvent/findResultEvent silently take
  // the FIRST event of their kind, and findIncompleteToolResults only proves "at least one"
  // tool_use<->tool_result correlation exists -- neither catches a transcript with a SECOND,
  // contradictory init+result pair appended after a legitimate first one, or two tool_use blocks
  // sharing one id satisfied by a single tool_result. Both reproductions returned {ok:true}
  // against the gate as it stood. See findTranscriptStructuralIssues's own doc comment
  // (stream-parser.mjs) for the full rationale.
  it('isolates transcriptStructureOk -- A has a second, contradictory init event later in the transcript', () => {
    const base = passRunResult();
    const runA = passRunResult({ events: [...base.events, initEventStub()] });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('initOk:true');
    expect(reason).toContain('transcriptStructureOk:false');
  });

  it('isolates transcriptStructureOk -- B has a second, contradictory result event later in the transcript', () => {
    const base = passRunResult();
    const runB = passRunResult({
      events: [...base.events, resultEventStub()],
      init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN },
    });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('transcriptStructureOk:false');
  });

  it('isolates transcriptStructureOk -- A has two tool_use blocks sharing the same id (a single tool_result cannot unambiguously satisfy both)', () => {
    const base = passRunResult();
    // Both duplicate-id tool_use blocks come BEFORE the one tool_result that answers 'toolu_dup',
    // so each one's own forward-scan for a correlated result still finds (the same) one -- this
    // isolates transcriptStructureOk's duplicate_tool_use_id check specifically, without also
    // tripping toolResultsCompleteOk (which only asks "does some result exist", not "is the id
    // actually unique").
    const dup1 = bashToolUseEvent('toolu_dup', 'kmp-test parallel --json');
    const dup2 = bashToolUseEvent('toolu_dup', 'kmp-test parallel --json');
    const runA = passRunResult({ events: [...base.events, dup1, dup2, toolResultEvent('toolu_dup')] });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('transcriptStructureOk:false');
  });

  it('isolates transcriptStructureOk -- B has two tool_result blocks answering the same tool_use id', () => {
    const base = passRunResult();
    const runB = passRunResult({
      events: [...base.events, toolResultEvent('toolu_1')],
      init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN },
    });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('transcriptStructureOk:false');
  });

  it('isolates transcriptStructureOk -- A has an orphan tool_result referencing a tool_use id that was never called', () => {
    const base = passRunResult();
    const runA = passRunResult({ events: [...base.events, toolResultEvent('toolu_never_called')] });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('transcriptStructureOk:false');
  });

  // Regression coverage for a review-round-5 finding: findTranscriptStructuralIssues proved
  // exactly one init and one result exist SOMEWHERE in the transcript, but never checked WHERE.
  // This is the reviewer's own exact reproduction: result before init, with a Skill invocation
  // trailing the supposedly-terminal result -- findTranscriptStructuralIssues() returned zero
  // issues and calibrationHardGate() returned {ok:true} against the pre-fix code.
  it('isolates transcriptStructureOk -- A\'s result event appears BEFORE its own init event, with a tool_use trailing the supposedly-terminal result', () => {
    const runA = passRunResult({
      events: [
        resultEventStub(),
        initEventStub(),
        bashToolUseEvent('toolu_late', 'kmp-test parallel --json'),
        toolResultEvent('toolu_late'),
      ],
    });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    // init/result stay valid on their own SEPARATE fields (unaffected by the events array shape),
    // and the dangling-looking Bash call still has its own correlated result -- isolates this to
    // transcriptStructureOk specifically, not a pile-up of unrelated cascading failures.
    expect(reason).toContain('initOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('transcriptStructureOk:false');
  });

  it('isolates transcriptStructureOk -- B has a tool_use/tool_result pair BEFORE its own init event, even though result is correctly last', () => {
    const runB = passRunResult({
      events: [
        bashToolUseEvent('toolu_early', 'kmp-test parallel --json'),
        toolResultEvent('toolu_early'),
        initEventStub(),
        bashToolUseEvent('toolu_1', 'kmp-test doctor --json'),
        toolResultEvent('toolu_1'),
        bashToolUseEvent('toolu_2', 'kmp-test describe --json'),
        toolResultEvent('toolu_2'),
        resultEventStub(),
      ],
      init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN },
    });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('transcriptStructureOk:false');
  });

  it('isolates transcriptStructureOk -- A has a tool_use/tool_result pair AFTER what should have been the terminal result event', () => {
    const runA = passRunResult({
      events: [
        initEventStub(),
        bashToolUseEvent('toolu_1', 'kmp-test doctor --json'),
        toolResultEvent('toolu_1'),
        bashToolUseEvent('toolu_2', 'kmp-test describe --json'),
        toolResultEvent('toolu_2'),
        resultEventStub(),
        bashToolUseEvent('toolu_late', 'kmp-test parallel --json'),
        toolResultEvent('toolu_late'),
      ],
    });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('transcriptStructureOk:false');
  });

  // Regression coverage for a review-round-6 finding: the round-5 ordering fix only checked that
  // init precedes every tool_use/tool_result -- a plain assistant TEXT message (no tool call at
  // all) sitting before init was invisible to it. Reproduced directly: findTranscriptStructuralIssues()
  // returned [] and calibrationHardGate() returned {"ok":true,"reason":null}. The real stream-json
  // protocol begins with init and ends with result, with nothing of any kind preceding the
  // former -- init_not_first (stream-parser.mjs) now requires init to be the literal first event,
  // not just "before every tool call".
  it('isolates transcriptStructureOk -- A has a plain assistant text message BEFORE its own init event (no tool_use at all, still structurally invalid)', () => {
    const runA = passRunResult({
      events: [
        assistantTextEvent('stray pre-init content'),
        initEventStub(),
        bashToolUseEvent('toolu_1', 'kmp-test doctor --json'),
        toolResultEvent('toolu_1'),
        bashToolUseEvent('toolu_2', 'kmp-test describe --json'),
        toolResultEvent('toolu_2'),
        resultEventStub(),
      ],
    });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('transcriptStructureOk:false');
  });

});

describe('smokeHardGate', () => {
  it('passes when every sub-check is satisfied', () => {
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  it('isolates availabilityOk -- A shows the skill as available (breaks the no-skill/current-skill contrast)', () => {
    const a = passA({ skill_available: { value: true, reason: null } });
    const { ok, reason } = smokeHardGate(a, passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:false');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('realWorkOk:true');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:true');
  });

  it('isolates processOk -- B exits nonzero', () => {
    const b = passB({ exit_code: 1 });
    const { ok, reason } = smokeHardGate(passA(), b, passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('processOk:false');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('realWorkOk:true');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:true');
  });

  it('isolates resultOk -- A\'s own result event reports is_error:true', () => {
    const runA = passRunResult({ result: { is_error: true } });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:false');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('realWorkOk:true');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:true');
  });

  // Regression coverage -- see calibrationHardGate's identical test for the full rationale
  // (a budget-cap-truncated session reports is_error:false with a non-'success' subtype).
  it('isolates resultOk -- B\'s result event has is_error:false but subtype is NOT success', () => {
    const runB = passRunResult({ result: { subtype: 'error_max_budget_usd', is_error: false }, init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } });
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('initOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:false');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('realWorkOk:true');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:true');
  });

  // Regression coverage -- see calibrationHardGate's identical test for the full rationale.
  it('isolates initOk -- B never produced an init event at all', () => {
    const runB = passRunResult({ init: null });
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    // pluginProfileOk not asserted here (same as toolProfileOk) -- B's init is null, cascading to
    // false via the same guard clause, not a second independent cause.
    expect(reason).toContain('initOk:false');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('realWorkOk:true');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:true');
  });

  // Regression coverage -- see calibrationHardGate's identical tests for the full rationale.
  it('isolates toolProfileOk -- A\'s init event declares Read alongside Bash/Skill', () => {
    const runA = passRunResult({ init: { ...passRunResult().init, tools: ['Bash', 'Skill', 'Read'] } });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('initOk:true');
    expect(reason).toContain('toolProfileOk:false');
    expect(reason).toContain('noUnexpectedToolsOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('realWorkOk:true');
    expect(reason).toContain('exactCommandsOk:true');
  });

  it('isolates toolProfileOk -- B\'s init event has permissionMode !== dontAsk', () => {
    const runB = passRunResult({ init: { ...passRunResult().init, permissionMode: 'acceptEdits' } });
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('toolProfileOk:false');
  });

  // Regression coverage for the exact real adversarial transcript an independent review pass
  // constructed: Read enabled AND invoked, alongside both expected Bash calls succeeding -- the
  // OLD gate returned {ok:true} for exactly this transcript, since it never inspected anything
  // beyond the two expected Bash calls.
  it('isolates noUnexpectedToolsOk -- A invoked Read alongside the expected Bash calls', () => {
    const base = passRunResult();
    // The Read call gets its own correlated tool_result too -- otherwise it would ALSO trip
    // toolResultsCompleteOk, muddying this test's single-cause isolation of noUnexpectedToolsOk.
    const runA = passRunResult({ events: [...base.events, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id: 'toolu_evil', input: { file_path: '/etc/passwd' } }] } }, toolResultEvent('toolu_evil')] });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('initOk:true');
    expect(reason).toContain('toolProfileOk:true');
    expect(reason).toContain('noUnexpectedToolsOk:false');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('realWorkOk:true');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:true');
  });

  it('isolates hookAccountingOk -- not every Bash call in A reached the policy hook', () => {
    const runA = passRunResult({ hookStats: { everyCallHooked: false, hookAllowCount: 2 } });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:false');
    expect(reason).toContain('realWorkOk:true');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:true');
  });

  it('isolates realWorkOk -- B had at least one denied command (hook_deny_count>0)', () => {
    const b = passB({ hook_deny_count: 1 });
    const { ok, reason } = smokeHardGate(passA(), b, passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('realWorkOk:false');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:true');
  });

  it('isolates realWorkOk -- A never attempted any real command (hook_call_count:0)', () => {
    const a = passA({ hook_call_count: 0 });
    const runA = passRunResult({ hookStats: { everyCallHooked: true, hookAllowCount: 0 }, bashResults: [] });
    const { ok, reason } = smokeHardGate(a, passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('realWorkOk:false');
    // bashResults is empty in this fixture too, so exactCommandsOk is honestly also false here --
    // "zero commands run" cannot satisfy "the two expected commands ran successfully" no matter
    // how the check is phrased. This is a case where two sub-checks are causally the same fact
    // (no commands at all), not a fixture-isolation failure.
    expect(reason).toContain('exactCommandsOk:false');
  });

  it('isolates realWorkOk -- B has a malformed hook decision (hookAllowCount does not match hook_call_count even though hook_deny_count is 0)', () => {
    const runB = passRunResult({ hookStats: { everyCallHooked: true, hookAllowCount: 1 }, init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }); // 1 allow for 2 calls, 0 denies
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('realWorkOk:false');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:true');
  });

  it('isolates exactCommandsOk -- B ran doctor twice instead of doctor+describe', () => {
    const runB = passRunResult({
      bashResults: [
        { command: 'kmp-test doctor --json', resultFound: true, resultIsError: false },
        { command: 'kmp-test doctor --json', resultFound: true, resultIsError: false },
      ],
      init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN },
    });
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('realWorkOk:true');
    expect(reason).toContain('exactCommandsOk:false');
    expect(reason).toContain('cleanTranscriptOk:true');
  });

  it('isolates exactCommandsOk -- B ran both expected commands but describe\'s own result was an error', () => {
    const runB = passRunResult({
      bashResults: [
        { command: 'kmp-test doctor --json', resultFound: true, resultIsError: false },
        { command: 'kmp-test describe --json', resultFound: true, resultIsError: true },
      ],
    });
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('exactCommandsOk:false');
    // A denied/errored command still reaches the hook and can still be an explicit "allow"
    // decision at the hook layer (the hook approves the command; the command itself then fails
    // for an unrelated reason) -- realWorkOk and exactCommandsOk are independent facts here.
    expect(reason).toContain('realWorkOk:true');
  });

  it('isolates cleanTranscriptOk -- A has a malformed/truncated JSONL line', () => {
    const runA = passRunResult({ malformedLines: ['{not valid json'] });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:true');
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('realWorkOk:true');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:false');
  });

  // See calibrationHardGate's identical tests + rationale -- the same gap (noUnexpectedToolsOk
  // only checks tool NAME, never a Skill call's own input.skill argument) applies to smoke too.
  function foreignSkillToolUseEvent(skillArg) {
    const input = skillArg === undefined ? {} : { skill: skillArg };
    return { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_foreign', name: 'Skill', input }] } };
  }

  it('isolates skillSelectionOk -- A calls an entirely unrelated Skill (evidence-contamination bypass)', () => {
    const base = passRunResult();
    const runA = passRunResult({ events: [...base.events, foreignSkillToolUseEvent('some-other-skill')] });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:false');
  });

  it('isolates skillSelectionOk -- B calls an entirely unrelated Skill in addition to real diagnostic work', () => {
    const base = passRunResult();
    const runB = passRunResult({ events: [...base.events, foreignSkillToolUseEvent('some-other-skill')] });
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('skillSelectionOk:false');
  });

  it('isolates skillSelectionOk -- A calls Skill with a non-string, malformed input.skill', () => {
    const base = passRunResult();
    const runA = passRunResult({ events: [...base.events, foreignSkillToolUseEvent(42)] });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('skillSelectionOk:false');
  });

  // See calibrationHardGate's identical tests + rationale -- the same gaps (plugins[] never
  // inspected; a dangling tool_use with no correlated result treated as safe) apply to smoke too.
  it('isolates pluginProfileOk -- A has a foreign plugin loaded (real isolation break, not a scoring artifact)', () => {
    const runA = passRunResult({ init: { ...passRunResult().init, plugins: [{ name: 'some-other-plugin', path: '/fake', source: 'fake' }] } });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:false');
  });

  it('isolates pluginProfileOk -- A has no plugins field at all (undefined, not a genuine empty-array observation)', () => {
    const runA = passRunResult({ init: { model: 'claude-sonnet-5-fake-resolved', tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' } });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:false');
  });

  it('isolates pluginProfileOk -- B has kmp-test-runner PLUS an extra, unexpected plugin', () => {
    const runB = passRunResult({ init: { ...passRunResult().init, plugins: [...KMP_TEST_RUNNER_PLUGIN, { name: 'some-other-plugin', path: '/fake', source: 'fake' }] } });
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:false');
  });

  it('isolates pluginProfileOk -- B has zero plugins loaded (should have exactly kmp-test-runner)', () => {
    const runB = passRunResult({ init: { ...passRunResult().init, plugins: [] } });
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:false');
  });

  it('isolates toolResultsCompleteOk -- A has a dangling Bash call with no correlated tool_result', () => {
    const danglingBash = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_dangling_bash', name: 'Bash', input: { command: 'kmp-test doctor --json' } }] } };
    const base = passRunResult();
    const runA = passRunResult({ events: [...base.events, danglingBash] });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('toolResultsCompleteOk:false');
  });

  // See calibrationHardGate's identical test's own comment -- a tool_use with no id also
  // cascades into transcriptStructureOk's empty_tool_use_id check, not just toolResultsCompleteOk.
  it('isolates toolResultsCompleteOk -- B has a tool_use with no id at all (cannot be correlated, so it can never be proven complete)', () => {
    const noIdToolUse = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'kmp-test doctor --json' } }] } };
    const base = passRunResult();
    const runB = passRunResult({ events: [...base.events, noIdToolUse], init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } });
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('toolResultsCompleteOk:false');
  });

  // See calibrationHardGate's identical tests + rationale -- the same gap (pluginProfileOk never
  // checks the loaded plugin's own path) applies to smoke too.
  it('isolates pluginSnapshotBindingOk -- B loads a correctly-NAMED plugin from the WRONG directory (the exact evidence-contamination bypass this closes)', () => {
    const runB = passRunResult({
      init: { ...passRunResult().init, plugins: [{ name: 'kmp-test-runner', path: WRONG_SNAPSHOT_DIR, source: 'fake' }] },
    });
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('pluginSnapshotBindingOk:false');
  });

  it('isolates pluginSnapshotBindingOk -- B\'s own snapshotDir is missing (null), so a correctly-named-and-pathed plugin still cannot be bound', () => {
    const runB = passRunResult({
      init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN },
      snapshotDir: null,
    });
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('pluginSnapshotBindingOk:false');
  });

  // See calibrationHardGate's identical tests + rationale -- the same gaps (findInitEvent/
  // findResultEvent take "the first" event of a kind; findIncompleteToolResults only proves "at
  // least one" correlation) apply to smoke too.
  it('isolates transcriptStructureOk -- A has a second, contradictory init event later in the transcript', () => {
    const base = passRunResult();
    const runA = passRunResult({ events: [...base.events, initEventStub()] });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('initOk:true');
    expect(reason).toContain('transcriptStructureOk:false');
  });

  it('isolates transcriptStructureOk -- B has a second, contradictory result event later in the transcript', () => {
    const base = passRunResult();
    const runB = passRunResult({
      events: [...base.events, resultEventStub()],
      init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN },
    });
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('transcriptStructureOk:false');
  });

  it('isolates transcriptStructureOk -- A has two tool_use blocks sharing the same id (a single tool_result cannot unambiguously satisfy both)', () => {
    const base = passRunResult();
    const dup1 = bashToolUseEvent('toolu_dup', 'kmp-test parallel --json');
    const dup2 = bashToolUseEvent('toolu_dup', 'kmp-test parallel --json');
    const runA = passRunResult({ events: [...base.events, dup1, dup2, toolResultEvent('toolu_dup')] });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('transcriptStructureOk:false');
  });

  it('isolates transcriptStructureOk -- B has two tool_result blocks answering the same tool_use id', () => {
    const base = passRunResult();
    const runB = passRunResult({
      events: [...base.events, toolResultEvent('toolu_1')],
      init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN },
    });
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('transcriptStructureOk:false');
  });

  it('isolates transcriptStructureOk -- A has an orphan tool_result referencing a tool_use id that was never called', () => {
    const base = passRunResult();
    const runA = passRunResult({ events: [...base.events, toolResultEvent('toolu_never_called')] });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('transcriptStructureOk:false');
  });

  // See calibrationHardGate's identical tests + rationale -- the same ordering gap (exactly one
  // init/result proven to exist, but never checked WHERE) applies to smoke too.
  it('isolates transcriptStructureOk -- A\'s result event appears BEFORE its own init event, with a tool_use trailing the supposedly-terminal result', () => {
    const runA = passRunResult({
      events: [
        resultEventStub(),
        initEventStub(),
        bashToolUseEvent('toolu_late', 'kmp-test parallel --json'),
        toolResultEvent('toolu_late'),
      ],
    });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('initOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('transcriptStructureOk:false');
  });

  it('isolates transcriptStructureOk -- B has a tool_use/tool_result pair BEFORE its own init event, even though result is correctly last', () => {
    const runB = passRunResult({
      events: [
        bashToolUseEvent('toolu_early', 'kmp-test parallel --json'),
        toolResultEvent('toolu_early'),
        initEventStub(),
        bashToolUseEvent('toolu_1', 'kmp-test doctor --json'),
        toolResultEvent('toolu_1'),
        bashToolUseEvent('toolu_2', 'kmp-test describe --json'),
        toolResultEvent('toolu_2'),
        resultEventStub(),
      ],
      init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN },
    });
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('transcriptStructureOk:false');
  });

  it('isolates transcriptStructureOk -- A has a tool_use/tool_result pair AFTER what should have been the terminal result event', () => {
    const runA = passRunResult({
      events: [
        initEventStub(),
        bashToolUseEvent('toolu_1', 'kmp-test doctor --json'),
        toolResultEvent('toolu_1'),
        bashToolUseEvent('toolu_2', 'kmp-test describe --json'),
        toolResultEvent('toolu_2'),
        resultEventStub(),
        bashToolUseEvent('toolu_late', 'kmp-test parallel --json'),
        toolResultEvent('toolu_late'),
      ],
    });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('transcriptStructureOk:false');
  });

  // See calibrationHardGate's identical test + rationale -- the same gap (init_not_first catches
  // ANY event preceding init, not just a tool_use/tool_result) applies to smoke too.
  it('isolates transcriptStructureOk -- A has a plain assistant text message BEFORE its own init event (no tool_use at all, still structurally invalid)', () => {
    const runA = passRunResult({
      events: [
        assistantTextEvent('stray pre-init content'),
        initEventStub(),
        bashToolUseEvent('toolu_1', 'kmp-test doctor --json'),
        toolResultEvent('toolu_1'),
        bashToolUseEvent('toolu_2', 'kmp-test describe --json'),
        toolResultEvent('toolu_2'),
        resultEventStub(),
      ],
    });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN } }));
    expect(ok).toBe(false);
    expect(reason).toContain('transcriptStructureOk:false');
  });

});

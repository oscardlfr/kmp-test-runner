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
import { describe, it, expect } from 'vitest';
import { calibrationHardGate, smokeHardGate } from '../../tools/agentic-eval/cli.mjs';

function bashToolUseEvent(id, command) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] } };
}

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
      bashToolUseEvent('toolu_1', 'kmp-test doctor --json'),
      bashToolUseEvent('toolu_2', 'kmp-test describe --json'),
    ],
    malformedLines: [],
    ...overrides,
  };
}

describe('calibrationHardGate', () => {
  it('passes when every sub-check is satisfied', () => {
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), passRunResult());
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  it('isolates currentInvocationOk -- B never confirms invocation (the real "Unknown skill" shape: attempted but not invoked)', () => {
    const b = passB({ skill_invoked: { value: false, reason: 'attempted but not confirmed' } });
    const { ok, reason } = calibrationHardGate(passA(), b, passRunResult(), passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:false');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
  });

  it('isolates availabilityOk -- A shows the skill as available (breaks the no-skill/current-skill contrast)', () => {
    const a = passA({ skill_available: { value: true, reason: null } });
    const { ok, reason } = calibrationHardGate(a, passB(), passRunResult(), passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:false');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
  });

  it('isolates processOk -- B exits nonzero', () => {
    const b = passB({ exit_code: 1 });
    const { ok, reason } = calibrationHardGate(passA(), b, passRunResult(), passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('processOk:false');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
  });

  it('isolates processOk -- A was terminated (timeout/signal)', () => {
    const a = passA({ terminated: true });
    const { ok, reason } = calibrationHardGate(a, passB(), passRunResult(), passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('processOk:false');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
  });

  it('isolates resultOk -- B\'s own result event reports is_error:true', () => {
    const runB = passRunResult({ result: { is_error: true } });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:false');
    expect(reason).toContain('hookAccountingOk:true');
  });

  it('isolates resultOk -- no result event was ever found (undefined, not false)', () => {
    const runA = passRunResult({ result: null });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('resultOk:false');
  });

  // Regression coverage for a real bypass an independent review pass demonstrated: a session
  // truncated by, say, the budget cap can report a distinct result.subtype (confirmed:
  // 'error_max_budget_usd') that is NOT necessarily paired with is_error:true -- so is_error
  // alone previously let a genuinely-interrupted session pass resultOk.
  it('isolates resultOk -- B\'s result event has is_error:false but subtype is NOT success (the budget-cap-truncation shape)', () => {
    const runB = passRunResult({ result: { subtype: 'error_max_budget_usd', is_error: false } });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('initOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:false');
    expect(reason).toContain('hookAccountingOk:true');
  });

  // Regression coverage for a real bypass: a session with NO init event at all is a
  // fundamentally broken/incomplete capture -- without initOk, a no-init run's derived
  // skill_available:false for the no-skill arm could coincidentally match the EXPECTED value,
  // passing availabilityOk for the wrong reason (nothing to derive availability from, not a
  // genuine observation).
  it('isolates initOk -- A never produced an init event at all', () => {
    const runA = passRunResult({ init: null });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('initOk:false');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
  });

  // Regression coverage for a real gap an independent review pass demonstrated: a hard gate
  // that only checks init!=null can't distinguish a genuinely narrow session from one that
  // regressed to a wider tool/MCP/permission profile.
  it('isolates toolProfileOk -- B\'s init event declares Read alongside Bash/Skill', () => {
    const runB = passRunResult({ init: { ...passRunResult().init, tools: ['Bash', 'Skill', 'Read'] } });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('initOk:true');
    expect(reason).toContain('toolProfileOk:false');
    expect(reason).toContain('noUnexpectedToolsOk:true');
    expect(reason).toContain('processOk:true');
  });

  it('isolates toolProfileOk -- A\'s init event declares a non-empty mcp_servers list', () => {
    const runA = passRunResult({ init: { ...passRunResult().init, mcp_servers: [{ name: 'unexpected' }] } });
    const { ok, reason } = calibrationHardGate(passA(), passB(), runA, passRunResult());
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
    const runB = passRunResult({ events: [...base.events, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id: 'toolu_evil', input: { file_path: '/etc/passwd' } }] } }] });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('initOk:true');
    expect(reason).toContain('toolProfileOk:true');
    expect(reason).toContain('noUnexpectedToolsOk:false');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
  });

  it('isolates hookAccountingOk -- not every Bash call in B reached the policy hook', () => {
    const runB = passRunResult({ hookStats: { everyCallHooked: false, hookAllowCount: 2 } });
    const { ok, reason } = calibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
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
    const { ok, reason } = calibrationHardGate(a, passB(), passRunResult(), passRunResult());
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  it('passes when A attempted the skill and got a clean non-invocation (the "Unknown skill" shape -- also legitimate)', () => {
    const a = passA({ skill_invocation_attempted: { value: true, reason: null }, skill_invoked: { value: false, reason: null } });
    const { ok, reason } = calibrationHardGate(a, passB(), passRunResult(), passRunResult());
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  it('isolates noSkillSafetyOk -- A somehow shows a confirmed invocation despite being the no-skill arm (contradictory input, must still fail)', () => {
    const a = passA({ skill_invoked: { value: true, reason: null } });
    const { ok, reason } = calibrationHardGate(a, passB(), passRunResult(), passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('noSkillSafetyOk:false');
    expect(reason).toContain('currentInvocationOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
  });

  // Regression coverage for a review-round-2 finding: skill_invocation_attempted is a nullable
  // metric and CAN legitimately be unobserved -- a null value must not silently pass just because
  // invoked happens to read false. Distinct from attempted:false, which is a genuine, positive
  // "did not attempt" observation, not a capture gap.
  it('isolates noSkillSafetyOk -- A\'s skill_invocation_attempted is null (unobserved capture, not a genuine "did not attempt" observation)', () => {
    const a = passA({ skill_invocation_attempted: { value: null, reason: 'capture incomplete' } });
    const { ok, reason } = calibrationHardGate(a, passB(), passRunResult(), passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('noSkillSafetyOk:false');
    expect(reason).toContain('currentInvocationOk:true');
  });

  // Regression coverage for a review-round-2 finding: B's contract stays strict even though A's
  // was relaxed -- this is the exact counterpart of the newly-tolerated A shape and must still
  // fail, specifically via currentInvocationOk, not be accidentally tolerated by symmetry with A.
  it('isolates currentInvocationOk -- B never attempts the skill at all (unlike A, B\'s contract stays strict)', () => {
    const b = passB({ skill_invocation_attempted: { value: false, reason: null }, skill_invoked: { value: false, reason: null } });
    const { ok, reason } = calibrationHardGate(passA(), b, passRunResult(), passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:false');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
  });
});

describe('smokeHardGate', () => {
  it('passes when every sub-check is satisfied', () => {
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), passRunResult());
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  it('isolates availabilityOk -- A shows the skill as available (breaks the no-skill/current-skill contrast)', () => {
    const a = passA({ skill_available: { value: true, reason: null } });
    const { ok, reason } = smokeHardGate(a, passB(), passRunResult(), passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:false');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('realWorkOk:true');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:true');
  });

  it('isolates processOk -- B exits nonzero', () => {
    const b = passB({ exit_code: 1 });
    const { ok, reason } = smokeHardGate(passA(), b, passRunResult(), passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('processOk:false');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('realWorkOk:true');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:true');
  });

  it('isolates resultOk -- A\'s own result event reports is_error:true', () => {
    const runA = passRunResult({ result: { is_error: true } });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:false');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('realWorkOk:true');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:true');
  });

  // Regression coverage -- see calibrationHardGate's identical test for the full rationale
  // (a budget-cap-truncated session reports is_error:false with a non-'success' subtype).
  it('isolates resultOk -- B\'s result event has is_error:false but subtype is NOT success', () => {
    const runB = passRunResult({ result: { subtype: 'error_max_budget_usd', is_error: false } });
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('initOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:false');
    expect(reason).toContain('hookAccountingOk:true');
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
    expect(reason).toContain('initOk:false');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('realWorkOk:true');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:true');
  });

  // Regression coverage -- see calibrationHardGate's identical tests for the full rationale.
  it('isolates toolProfileOk -- A\'s init event declares Read alongside Bash/Skill', () => {
    const runA = passRunResult({ init: { ...passRunResult().init, tools: ['Bash', 'Skill', 'Read'] } });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
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
    const runA = passRunResult({ events: [...base.events, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id: 'toolu_evil', input: { file_path: '/etc/passwd' } }] } }] });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('initOk:true');
    expect(reason).toContain('toolProfileOk:true');
    expect(reason).toContain('noUnexpectedToolsOk:false');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('realWorkOk:true');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:true');
  });

  it('isolates hookAccountingOk -- not every Bash call in A reached the policy hook', () => {
    const runA = passRunResult({ hookStats: { everyCallHooked: false, hookAllowCount: 2 } });
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:false');
    expect(reason).toContain('realWorkOk:true');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:true');
  });

  it('isolates realWorkOk -- B had at least one denied command (hook_deny_count>0)', () => {
    const b = passB({ hook_deny_count: 1 });
    const { ok, reason } = smokeHardGate(passA(), b, passRunResult(), passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('realWorkOk:false');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:true');
  });

  it('isolates realWorkOk -- A never attempted any real command (hook_call_count:0)', () => {
    const a = passA({ hook_call_count: 0 });
    const runA = passRunResult({ hookStats: { everyCallHooked: true, hookAllowCount: 0 }, bashResults: [] });
    const { ok, reason } = smokeHardGate(a, passB(), runA, passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('realWorkOk:false');
    // bashResults is empty in this fixture too, so exactCommandsOk is honestly also false here --
    // "zero commands run" cannot satisfy "the two expected commands ran successfully" no matter
    // how the check is phrased. This is a case where two sub-checks are causally the same fact
    // (no commands at all), not a fixture-isolation failure.
    expect(reason).toContain('exactCommandsOk:false');
  });

  it('isolates realWorkOk -- B has a malformed hook decision (hookAllowCount does not match hook_call_count even though hook_deny_count is 0)', () => {
    const runB = passRunResult({ hookStats: { everyCallHooked: true, hookAllowCount: 1 } }); // 1 allow for 2 calls, 0 denies
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
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
    });
    const { ok, reason } = smokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
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
    const { ok, reason } = smokeHardGate(passA(), passB(), runA, passRunResult());
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('processOk:true');
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('hookAccountingOk:true');
    expect(reason).toContain('realWorkOk:true');
    expect(reason).toContain('exactCommandsOk:true');
    expect(reason).toContain('cleanTranscriptOk:false');
  });
});

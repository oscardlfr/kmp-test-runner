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
import { calibrationHardGate as realCalibrationHardGate, smokeHardGate as realSmokeHardGate, scenarioCellIntegrityOk, scenarioHardGate } from '../../tools/agentic-eval/cli.mjs';
import {
  findAllToolUsesWithResults, findTranscriptStructuralIssues, findTranscriptStructuralIssuesToleratingTimeout,
  findIncompleteToolResults, findIncompleteToolResultsToleratingTimeout, isSkillAvailable,
  hasExpectedPluginProfile, hasExpectedToolProfile, findSkillInvocation, classifyForeignSkillUses,
  computeAmbientSkillProfile, isRecognizedPreDispatchBlock,
} from '../../tools/agentic-eval/stream-parser.mjs';
import { isPluginBoundToSnapshot, EXPECTED_TOOL_NAMES } from '../../tools/agentic-eval/runtimes/claude-code.mjs';

const TARGET_PLUGIN_NAME = 'kmp-test-runner';
const TARGET_SKILL_NAME = 'kmp-test-runner';

/**
 * Converts this file's own pre-existing raw fixture shape ({init, result, hookStats, bashResults,
 * events, malformedLines, snapshotDir}, unchanged from before the Claude-runtime-adapter refactor)
 * into the canonical condition-observation-v1 shape calibrationHardGate/smokeHardGate now read
 * exclusively -- built via the REAL frozen stream-parser.mjs primitives (test files may import
 * stream-parser.mjs directly; only production consumers are bound by the core-consumer boundary),
 * exactly mirroring runtimes/claude-code.mjs's own normalizeObservations construction. `bashResults`
 * is deliberately NOT consulted here -- toolAttempts (and hence shell-attempt-derived fields) now
 * derive purely from `events` via findAllToolUsesWithResults, matching the new architecture; every
 * pre-existing bashResults override already agrees with its own sibling `events` override at every
 * call site in this file (both were always hand-kept in sync), so this never changes what any test
 * observes.
 * `expectSkillAvailable` must be supplied explicitly by the caller -- it is no longer inferable from
 * fixture content (the observation contract bakes condition-awareness in at construction time, via
 * the runtime adapter's own `context.condition`, which these hand-built fixtures must now replicate
 * by hand): true for the current-skill (B) side, false for the no-skill (A) side.
 */
function toObservation({ init = null, result = null, hookStats = {}, events = [], malformedLines = [], snapshotDir = null, spawnResult = {}, bashResults = null } = {}, { expectSkillAvailable }) {
  const timeoutCtx = { terminated: spawnResult.terminated ?? false, terminationReason: spawnResult.terminationReason ?? null };
  // Shell-kind toolAttempts come from `bashResults` (this file's own pre-existing, INDEPENDENT
  // channel for exactCommandsOk/realWorkOk-adjacent assertions -- many tests here override `events`
  // for Skill/structural purposes while relying on bashResults' untouched default to keep
  // exactCommandsOk passing, and vice versa: a handful of dedicated exactCommandsOk tests override
  // ONLY bashResults). Non-shell toolAttempts (Skill/other) come from `events`, exactly as before --
  // exactCommandsOk/noUnexpectedToolsOk's shell portion is the ONLY thing that ever reads a shell
  // toolAttempt; every other check either reads `events` directly (transcript/skill checks) or a
  // separate top-level field (hookStats), so this split changes nothing else.
  const nonShellToolAttempts = findAllToolUsesWithResults(events).filter((u) => u.name !== 'Bash').map((u) => {
    const kind = u.name === 'Skill' ? 'skill' : 'other';
    const textStatus = !u.resultFound ? 'missing' : (typeof u.resultContent === 'string' ? 'text' : 'unsupported');
    return {
      id: u.id ?? null, kind, runtimeName: u.name ?? null, eventIndex: u.index,
      receiptNs: typeof u.receiptNs === 'bigint' ? u.receiptNs : null,
      profileAllowed: EXPECTED_TOOL_NAMES.has(u.name), command: null,
      skillReference: kind === 'skill' && typeof u.input?.skill === 'string' ? u.input.skill : null,
      targetsExpectedSkill: kind === 'skill' ? (u.input?.skill === TARGET_SKILL_NAME || u.input?.skill === `${TARGET_PLUGIN_NAME}:${TARGET_SKILL_NAME}`) : null,
      result: { found: u.resultFound, eventIndex: u.resultFound ? u.resultIndex : null, isError: u.resultFound ? u.resultIsError : null, text: textStatus === 'text' ? u.resultContent : null, textStatus },
      preDispatchBlock: { recognized: false, signature: null },
    };
  });
  // `bashResults` is only ever a real, non-null array in the calibrationHardGate/smokeHardGate
  // section (passRunResult ALWAYS sets it, base default or override); the scenarioCellIntegrityOk/
  // scenarioHardGate section's own fixtures (passConditionResult/cell) never had this field at all
  // -- for those, shell toolAttempts derive from `events` directly, matching the OLD
  // cellTranscriptIntegrityOk's actual (bashResults-agnostic) behavior exactly.
  const shellToolAttempts = bashResults != null
    ? bashResults.map((b, i) => {
      const recognized = isRecognizedPreDispatchBlock({ name: 'Bash', resultFound: b.resultFound, resultContent: b.resultContent, resultIsError: b.resultIsError });
      return {
        id: null, kind: 'shell', runtimeName: 'Bash', eventIndex: i, receiptNs: null,
        profileAllowed: true, command: b.command ?? null, skillReference: null, targetsExpectedSkill: null,
        result: { found: b.resultFound, eventIndex: b.resultFound ? i : null, isError: b.resultFound ? b.resultIsError : null, text: typeof b.resultContent === 'string' ? b.resultContent : null, textStatus: !b.resultFound ? 'missing' : (typeof b.resultContent === 'string' ? 'text' : 'unsupported') },
        preDispatchBlock: { recognized, signature: recognized ? 'claude-code/bash-pre-dispatch-block/v1' : null },
      };
    })
    : findAllToolUsesWithResults(events).filter((u) => u.name === 'Bash').map((u) => {
      const textStatus = !u.resultFound ? 'missing' : (typeof u.resultContent === 'string' ? 'text' : 'unsupported');
      const recognized = isRecognizedPreDispatchBlock(u);
      return {
        id: u.id ?? null, kind: 'shell', runtimeName: 'Bash', eventIndex: u.index,
        receiptNs: typeof u.receiptNs === 'bigint' ? u.receiptNs : null,
        profileAllowed: true, command: typeof u.input?.command === 'string' ? u.input.command : null,
        skillReference: null, targetsExpectedSkill: null,
        result: { found: u.resultFound, eventIndex: u.resultFound ? u.resultIndex : null, isError: u.resultFound ? u.resultIsError : null, text: textStatus === 'text' ? u.resultContent : null, textStatus },
        preDispatchBlock: { recognized, signature: recognized ? 'claude-code/bash-pre-dispatch-block/v1' : null },
      };
    });
  const toolAttempts = [...shellToolAttempts, ...nonShellToolAttempts];
  const invocation = findSkillInvocation(events, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME);
  const targetInvocation = invocation == null ? null : {
    attempted: true, confirmed: invocation.confirmed, attemptCount: invocation.attemptCount,
    eventIndex: invocation.index, receiptNs: typeof invocation.receiptNs === 'bigint' ? invocation.receiptNs : null,
    resultIsError: invocation.resultIsError,
  };
  const foreignInvocations = classifyForeignSkillUses(events, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME).map((f) => ({
    eventIndex: f.index, receiptNs: typeof f.receiptNs === 'bigint' ? f.receiptNs : null,
    id: f.id ?? null, skillReference: f.skillArg ?? null, resultIsError: f.resultIsError, confirmed: f.confirmed,
  }));
  const ambientProfile = computeAmbientSkillProfile(init, TARGET_PLUGIN_NAME, TARGET_SKILL_NAME, { expectTargetPresent: expectSkillAvailable });
  return {
    schema: 1,
    runtime: { id: 'claude-code', protocolVersion: 1 },
    process: { exitCode: 0, terminated: spawnResult.terminated ?? false, terminationReason: spawnResult.terminationReason ?? null, spawnHrtimeNs: 0n, endedHrtimeNs: 1000n },
    session: {
      initPresent: init != null, modelResolved: init?.model ?? null, sessionIdObserved: null,
      runtimeVersion: null, toolProfileMatchesExpected: hasExpectedToolProfile(init, EXPECTED_TOOL_NAMES),
    },
    transcript: {
      malformedLineCount: malformedLines.length,
      strictStructuralIssues: findTranscriptStructuralIssues(events),
      effectiveStructuralIssues: findTranscriptStructuralIssuesToleratingTimeout(events, timeoutCtx),
      strictIncompleteToolResults: findIncompleteToolResults(events),
      effectiveIncompleteToolResults: findIncompleteToolResultsToleratingTimeout(events, timeoutCtx),
    },
    terminal: {
      present: result != null, isError: result?.is_error ?? null, turnCount: 1, finalText: null,
      resultSubtype: result?.subtype ?? null,
      usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null },
    },
    toolAttempts,
    skill: {
      available: isSkillAvailable(init, TARGET_PLUGIN_NAME),
      profileMatchesCondition: hasExpectedPluginProfile(init, TARGET_PLUGIN_NAME, expectSkillAvailable),
      snapshotBindingMatches: isPluginBoundToSnapshot(init, snapshotDir),
      targetInvocation, foreignInvocations,
      ambient: { names: ambientProfile.names, structurallyWellFormed: ambientProfile.structurallyWellFormed, targetIdentityOk: ambientProfile.targetIdentityOk },
    },
    hookStats: {
      hookCallCount: hookStats.hookCallCount ?? 0, hookResponseCount: hookStats.hookResponseCount ?? 0,
      hookDenyCount: hookStats.hookDenyCount ?? 0, hookAllowCount: hookStats.hookAllowCount ?? 0,
      hookPairingOk: hookStats.hookPairingOk ?? true, everyCallHooked: hookStats.everyCallHooked ?? true,
    },
    byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
    timing: { receiptNsByEventIndex: new Map() },
  };
}

/** Thin call-site wrappers -- every calibrationHardGate/smokeHardGate call in this file passes its
 * raw runA/runB fixtures (built by passRunResult, unchanged) positionally; these wrappers convert
 * them to observations with the correct per-side expectSkillAvailable (A=false, B=true, matching
 * this file's own universal convention -- the 3rd positional arg is always the no-skill side, the
 * 4th always current-skill) without requiring any change to the ~100 individual fixture call sites
 * or their override literals. */
function callCalibrationHardGate(a, b, runA, runB) {
  return realCalibrationHardGate(a, b, { observation: toObservation(runA, { expectSkillAvailable: false }) }, { observation: toObservation(runB, { expectSkillAvailable: true }) });
}
function callSmokeHardGate(a, b, runA, runB) {
  return realSmokeHardGate(a, b, { observation: toObservation(runA, { expectSkillAvailable: false }) }, { observation: toObservation(runB, { expectSkillAvailable: true }) });
}

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
      // Round-3 audit finding (P1): an EARLIER version of this comment claimed an empty skills[]
      // satisfies targetIdentityOk "vacuously" for current-skill too -- that was describing a real
      // bug (computeAmbientSkillProfile's pre-fix `expectTargetPresent || !targetPresent` never
      // actually checked presence when true), not a real invariant. The default here is correct
      // ONLY for the no-skill side (zero target references is exactly what's required); every
      // call site building the CURRENT-SKILL (B) side must now ALSO override `skills` to include
      // the target's own identity (`plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner']`)
      // -- see the many such call sites below.
      skills: [],
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
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  // Required final coverage (post-#385 review): B's REAL event stream confirming the invocation
  // via the plugin-namespaced wire form must still pass -- skillSelectionOkB reads runBResult's
  // own events (re-scanning the transcript), independently of passB()'s record-level defaults.
  it('B confirming the invocation via the plugin-namespaced wire form still passes -- not classified as foreign', () => {
    const runB = passRunResult({
      init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner:kmp-test-runner'] },
      events: [
        initEventStub(),
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id: 's1', input: { skill: 'kmp-test-runner:kmp-test-runner' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', is_error: false, content: 'real skill output' }] } },
        resultEventStub(),
      ],
    });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  it('isolates currentInvocationOk -- B never confirms invocation (the real "Unknown skill" shape: attempted but not invoked)', () => {
    const b = passB({ skill_invoked: { value: false, reason: 'attempted but not confirmed' } });
    const { ok, reason } = callCalibrationHardGate(passA(), b, passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callCalibrationHardGate(a, passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callCalibrationHardGate(passA(), b, passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callCalibrationHardGate(a, passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const runB = passRunResult({ result: { is_error: true }, init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
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
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('resultOk:false');
  });

  // Regression coverage for a real bypass an independent review pass demonstrated: a session
  // truncated by, say, the budget cap can report a distinct result.subtype (confirmed:
  // 'error_max_budget_usd') that is NOT necessarily paired with is_error:true -- so is_error
  // alone previously let a genuinely-interrupted session pass resultOk.
  it('isolates resultOk -- B\'s result event has is_error:false but subtype is NOT success (the budget-cap-truncation shape)', () => {
    const runB = passRunResult({ result: { subtype: 'error_max_budget_usd', is_error: false }, init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
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
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const runB = passRunResult({ init: { ...passRunResult().init, tools: ['Bash', 'Skill', 'Read'], plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
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
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('toolProfileOk:false');
    expect(reason).toContain('noUnexpectedToolsOk:true');
  });

  // PR 4 follow-up (P1 finding): restored to 'bypassPermissions' -- passRunResult's own
  // hasExpectedToolProfile(init, EXPECTED_TOOL_NAMES) call (line ~123, above) uses the function's
  // now-restored, profile-aware default (expectedPermissionMode:'dontAsk'), so 'bypassPermissions'
  // is once again genuinely wrong here, and is the single most direct regression proof: a
  // strict-shaped transcript reporting the OTHER profile's own permission mode must fail
  // toolProfileOk, not be silently accepted (the exact P1 gap a prior, too-broad revision of
  // hasExpectedToolProfile introduced by accepting either value unconditionally, for every caller).
  it('isolates toolProfileOk -- B\'s init event has permissionMode !== dontAsk', () => {
    const runB = passRunResult({ init: { ...passRunResult().init, permissionMode: 'bypassPermissions' } });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
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
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
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
    const runB = passRunResult({ hookStats: { everyCallHooked: false, hookAllowCount: 2 }, init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
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
    const { ok, reason } = callCalibrationHardGate(a, passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  it('passes when A attempted the skill and got a clean non-invocation (the "Unknown skill" shape -- also legitimate)', () => {
    const a = passA({ skill_invocation_attempted: { value: true, reason: null }, skill_invoked: { value: false, reason: null } });
    const { ok, reason } = callCalibrationHardGate(a, passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  it('isolates noSkillSafetyOk -- A somehow shows a confirmed invocation despite being the no-skill arm (contradictory input, must still fail)', () => {
    const a = passA({ skill_invoked: { value: true, reason: null } });
    const { ok, reason } = callCalibrationHardGate(a, passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callCalibrationHardGate(a, passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callCalibrationHardGate(passA(), b, passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:false');
    expect(reason).toContain('noSkillSafetyOk:true');
    expect(reason).toContain('currentInvocationOk:true');
  });

  it('isolates skillSelectionOk -- B calls an entirely unrelated Skill in addition to the real one', () => {
    const base = passRunResult();
    const runB = passRunResult({ events: [...base.events, foreignSkillToolUseEvent('some-other-skill')] });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('skillSelectionOk:false');
  });

  it('isolates skillSelectionOk -- A calls Skill with a missing input.skill', () => {
    const base = passRunResult();
    const runA = passRunResult({ events: [...base.events, foreignSkillToolUseEvent(undefined)] });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('skillSelectionOk:false');
  });

  // Regression coverage for a review-round-3 finding: only smokeHardGate had cleanTranscriptOk --
  // a malformed/truncated JSONL line could hide exactly a Skill tool_use or its result,
  // artificially producing attempted:false for A, which the relaxed no-skill contract now
  // legitimately tolerates. Calibration needs the same protection smoke already had.
  it('isolates cleanTranscriptOk -- A has a malformed/truncated JSONL line', () => {
    const runA = passRunResult({ malformedLines: ['{not valid json'] });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('cleanTranscriptOk:false');
  });

  it('isolates cleanTranscriptOk -- B has a malformed/truncated JSONL line', () => {
    const runB = passRunResult({ malformedLines: ['{not valid json'], init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('cleanTranscriptOk:false');
  });

  // Regression coverage for a review-round-3 finding: neither isSkillAvailable nor
  // hasExpectedToolProfile ever inspects init.plugins[] itself -- an unexpected third-party
  // plugin, or a missing plugins field, went completely undetected as long as skill_available
  // for the TARGET skill happened to derive correctly.
  it('isolates pluginProfileOk -- A has a foreign plugin loaded (real isolation break, not a scoring artifact)', () => {
    const runA = passRunResult({ init: { ...passRunResult().init, plugins: [{ name: 'some-other-plugin', path: '/fake', source: 'fake' }] } });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:false');
  });

  it('isolates pluginProfileOk -- A has no plugins field at all (undefined, not a genuine empty-array observation)', () => {
    const runA = passRunResult({ init: { model: 'claude-sonnet-5-fake-resolved', tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' } });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:false');
  });

  it('isolates pluginProfileOk -- B has kmp-test-runner PLUS an extra, unexpected plugin', () => {
    const runB = passRunResult({ init: { ...passRunResult().init, plugins: [...KMP_TEST_RUNNER_PLUGIN, { name: 'some-other-plugin', path: '/fake', source: 'fake' }] } });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:false');
  });

  it('isolates pluginProfileOk -- B has zero plugins loaded (should have exactly kmp-test-runner)', () => {
    const runB = passRunResult({ init: { ...passRunResult().init, plugins: [] } });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
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
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('toolResultsCompleteOk:false');
  });

  it('isolates toolResultsCompleteOk -- B has a dangling Bash call with no correlated tool_result', () => {
    const danglingBash = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_dangling_bash', name: 'Bash', input: { command: 'kmp-test parallel --json' } }] } };
    const base = passRunResult();
    const runB = passRunResult({ events: [...base.events, danglingBash], init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
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
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('pluginSnapshotBindingOk:false');
  });

  it('isolates pluginSnapshotBindingOk -- B\'s own snapshotDir is missing (null), so a correctly-named-and-pathed plugin still cannot be bound', () => {
    const runB = passRunResult({
      init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN },
      snapshotDir: null,
    });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
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
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
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
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('transcriptStructureOk:false');
  });

  it('isolates transcriptStructureOk -- A has an orphan tool_result referencing a tool_use id that was never called', () => {
    const base = passRunResult();
    const runA = passRunResult({ events: [...base.events, toolResultEvent('toolu_never_called')] });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('transcriptStructureOk:false');
  });

  // Regression coverage for a review-round-5 finding: findTranscriptStructuralIssues proved
  // exactly one init and one result exist SOMEWHERE in the transcript, but never checked WHERE.
  // This is the reviewer's own exact reproduction: result before init, with a Skill invocation
  // trailing the supposedly-terminal result -- findTranscriptStructuralIssues() returned zero
  // issues and callCalibrationHardGate() returned {ok:true} against the pre-fix code.
  it('isolates transcriptStructureOk -- A\'s result event appears BEFORE its own init event, with a tool_use trailing the supposedly-terminal result', () => {
    const runA = passRunResult({
      events: [
        resultEventStub(),
        initEventStub(),
        bashToolUseEvent('toolu_late', 'kmp-test parallel --json'),
        toolResultEvent('toolu_late'),
      ],
    });
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
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
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('transcriptStructureOk:false');
  });

  // Regression coverage for a review-round-6 finding: the round-5 ordering fix only checked that
  // init precedes every tool_use/tool_result -- a plain assistant TEXT message (no tool call at
  // all) sitting before init was invisible to it. Reproduced directly: findTranscriptStructuralIssues()
  // returned [] and callCalibrationHardGate() returned {"ok":true,"reason":null}. The real stream-json
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
    const { ok, reason } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('transcriptStructureOk:false');
  });

  // Property-style equivalence proof for the A/B-split restructure (round 5's amendment): the
  // pre-restructure code (a single flat AND of all 15 checks) no longer exists to diff against
  // directly, so this proves the invariant the restructure is supposed to preserve -- ok is
  // EXACTLY (failedChecksA.length===0 && failedChecksB.length===0), with every failing check
  // attributed to the correct side, none dropped, none duplicated, none misattributed to the
  // wrong side -- across combinations where BOTH sides fail simultaneously on DIFFERENT checks
  // (the case none of the single-check "isolates X" tests above exercise, and exactly the shape a
  // checksA/checksB merge-order or copy-paste mistake would corrupt).
  it('property: ok === (failedChecksA.length===0 && failedChecksB.length===0), with correct per-side attribution, when BOTH sides fail on DIFFERENT checks simultaneously', () => {
    const a = passA({ skill_available: { value: true, reason: null }, exit_code: 1 });
    const b = passB({ hook_call_count: 2, hook_deny_count: 0 });
    const runA = passRunResult();
    const runB = passRunResult({
      result: { subtype: 'success', is_error: true },
      hookStats: { everyCallHooked: false, hookAllowCount: 2 },
      init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] },
    });
    const { ok, reason, failedChecksA, failedChecksB } = callCalibrationHardGate(a, b, runA, runB);
    expect(ok).toBe(false);
    expect(ok).toBe(failedChecksA.length === 0 && failedChecksB.length === 0);
    expect([...failedChecksA].sort()).toEqual(['availabilityOk', 'processOk'].sort());
    expect([...failedChecksB].sort()).toEqual(['hookAccountingOk', 'resultOk'].sort());
    // Every OTHER check, on both sides, still reports true in the verbose reason -- confirming
    // the two simultaneous failures didn't cascade into (or mask) unrelated checks.
    for (const stillOk of ['skillSelectionOk', 'pluginProfileOk', 'initOk', 'toolProfileOk', 'noUnexpectedToolsOk', 'toolResultsCompleteOk', 'cleanTranscriptOk', 'transcriptStructureOk']) {
      expect(reason).toContain(`${stillOk}:true`);
    }
  });

  it('property: ok===true and both failedChecks arrays are empty precisely when every individual check passes', () => {
    const { ok, failedChecksA, failedChecksB } = callCalibrationHardGate(passA(), passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(true);
    expect(failedChecksA).toEqual([]);
    expect(failedChecksB).toEqual([]);
  });

  // Mandatory RED->GREEN reproduction (review-round-2, correction 4): calibration never checked
  // init.skills[] validity at all before this fix -- a missing/malformed array silently produced a
  // "valid" {count:0, ...} ambient_skill_profile on the record (buildRunRecord), masking a genuine
  // capture defect as confidently-measured "zero ambient skills". Proven for BOTH sides
  // independently, and for BOTH the structural check and the condition-aware target-identity check.
  describe('ambient-skill-profile validity (correction 4 -- previously unchecked)', () => {
    it('isolates ambientSkillProfileOk -- A (no-skill) with a malformed (non-array) skills[] fails closed', () => {
      const runA = passRunResult({ init: { ...passRunResult().init, skills: 'not-an-array' } });
      const { ok, failedChecksA } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
      expect(ok).toBe(false);
      expect(failedChecksA).toContain('ambientSkillProfileOk');
    });

    it('isolates ambientSkillProfileOk -- B (current-skill) with a malformed (non-array) skills[] fails closed', () => {
      const runB = passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: 'not-an-array' } });
      const { ok, failedChecksB } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
      expect(ok).toBe(false);
      expect(failedChecksB).toContain('ambientSkillProfileOk');
    });

    it('isolates targetSkillAmbientIdentityOk -- A (no-skill) whose skills[] anomalously advertises the target fails closed, even though it was never invoked', () => {
      const runA = passRunResult({ init: { ...passRunResult().init, skills: ['kmp-test-runner'] } });
      const { ok, failedChecksA } = callCalibrationHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
      expect(ok).toBe(false);
      expect(failedChecksA).toContain('targetSkillAmbientIdentityOk');
    });

    // --- Mandatory RED->GREEN reproduction (round-3 audit finding, P1): "current-skill accepts
    // target absence" -- skill_available (isSkillAvailable/hasExpectedPluginProfile) only
    // inspects plugins[], never skills[], so a current-skill condition with the plugin genuinely
    // loaded (availabilityOk passes) but the target itself never advertised in skills[] previously
    // slipped through: targetIdentityOk's pre-fix expression short-circuited to "not duplicated"
    // alone whenever expectTargetPresent was true, never actually checking presence.
    it('isolates targetSkillAmbientIdentityOk -- B (current-skill) whose skills[] does NOT include the target fails closed, even though the plugin loaded', () => {
      const runB = passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['run'] } });
      const { ok, failedChecksB } = callCalibrationHardGate(passA(), passB(), passRunResult(), runB);
      expect(ok).toBe(false);
      expect(failedChecksB).toContain('targetSkillAmbientIdentityOk');
    });

    it('a well-formed skills[] carrying real ambient (non-target) entries still passes cleanly on both sides', () => {
      const runA = passRunResult({ init: { ...passRunResult().init, skills: ['run'] } });
      const runB = passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['run', 'kmp-test-runner'] } });
      const { ok } = callCalibrationHardGate(passA(), passB(), runA, runB);
      expect(ok).toBe(true);
    });
  });
});

describe('smokeHardGate', () => {
  it('passes when every sub-check is satisfied', () => {
    const { ok, reason } = callSmokeHardGate(passA(), passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  // P1 (post-#385 review): same gap, same fix, as scenarioCellIntegrityOk's identical new tests
  // above -- A's plugin is never loaded, but a CONFIRMED invocation (now correctly recognized as
  // the target skill under either wire form, never foreign) is real evidence contamination that
  // skillSelectionOk alone no longer catches. B is deliberately exempt (see this function's own
  // doc comment -- skill_invoked is never required for B).
  it('A (no-skill) with a CONFIRMED Skill call (bare form) is real evidence contamination -- ok:false', () => {
    const a = passA({ skill_invoked: { value: true, reason: null } });
    const runA = passRunResult({
      events: [
        initEventStub(),
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id: 's1', input: { skill: 'kmp-test-runner' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', is_error: false, content: 'real skill output' }] } },
        resultEventStub(),
      ],
    });
    const { ok, reason } = callSmokeHardGate(a, passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('noSkillSafetyOk:false');
  });

  it('A (no-skill) with a CONFIRMED Skill call (plugin-namespaced form) is real evidence contamination -- ok:false', () => {
    const a = passA({ skill_invoked: { value: true, reason: null } });
    const runA = passRunResult({
      events: [
        initEventStub(),
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id: 's1', input: { skill: 'kmp-test-runner:kmp-test-runner' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', is_error: false, content: 'real skill output' }] } },
        resultEventStub(),
      ],
    });
    const { ok, reason } = callSmokeHardGate(a, passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('noSkillSafetyOk:false');
  });

  it('A (no-skill) with a REJECTED Skill call ("Unknown skill", either wire form) still passes -- valid, measured behavior', () => {
    for (const skillArg of ['kmp-test-runner', 'kmp-test-runner:kmp-test-runner']) {
      const a = passA({ skill_invoked: { value: false, reason: null } });
      const runA = passRunResult({
        events: [
          initEventStub(),
          { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id: 's1', input: { skill: skillArg } }] } },
          { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', is_error: true, content: `<tool_use_error>Unknown skill: ${skillArg}</tool_use_error>` }] } },
          resultEventStub(),
        ],
      });
      const { ok, reason } = callSmokeHardGate(a, passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
      expect(ok).toBe(true);
      expect(reason).toBeNull();
    }
  });

  it('isolates availabilityOk -- A shows the skill as available (breaks the no-skill/current-skill contrast)', () => {
    const a = passA({ skill_available: { value: true, reason: null } });
    const { ok, reason } = callSmokeHardGate(a, passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callSmokeHardGate(passA(), b, passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const runB = passRunResult({ result: { subtype: 'error_max_budget_usd', is_error: false }, init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } });
    const { ok, reason } = callSmokeHardGate(passA(), passB(), passRunResult(), runB);
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
    const { ok, reason } = callSmokeHardGate(passA(), passB(), passRunResult(), runB);
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
    const { ok, reason } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callSmokeHardGate(passA(), passB(), passRunResult(), runB);
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
    const { ok, reason } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callSmokeHardGate(passA(), b, passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const runA = passRunResult({ hookStats: { everyCallHooked: true, hookAllowCount: 0 }, bashResults: [], events: [initEventStub(), resultEventStub()] });
    const { ok, reason } = callSmokeHardGate(a, passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('realWorkOk:false');
    // bashResults is empty in this fixture too, so exactCommandsOk is honestly also false here --
    // "zero commands run" cannot satisfy "the two expected commands ran successfully" no matter
    // how the check is phrased. This is a case where two sub-checks are causally the same fact
    // (no commands at all), not a fixture-isolation failure.
    expect(reason).toContain('exactCommandsOk:false');
  });

  it('isolates realWorkOk -- B has a malformed hook decision (hookAllowCount does not match hook_call_count even though hook_deny_count is 0)', () => {
    const runB = passRunResult({ hookStats: { everyCallHooked: true, hookAllowCount: 1 }, init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }); // 1 allow for 2 calls, 0 denies
    const { ok, reason } = callSmokeHardGate(passA(), passB(), passRunResult(), runB);
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
      events: [
        initEventStub(),
        bashToolUseEvent('toolu_1', 'kmp-test doctor --json'),
        toolResultEvent('toolu_1'),
        bashToolUseEvent('toolu_2', 'kmp-test doctor --json'),
        toolResultEvent('toolu_2'),
        resultEventStub(),
      ],
      init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN },
    });
    const { ok, reason } = callSmokeHardGate(passA(), passB(), passRunResult(), runB);
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
      events: [
        initEventStub(),
        bashToolUseEvent('toolu_1', 'kmp-test doctor --json'),
        toolResultEvent('toolu_1', false),
        bashToolUseEvent('toolu_2', 'kmp-test describe --json'),
        toolResultEvent('toolu_2', true),
        resultEventStub(),
      ],
    });
    const { ok, reason } = callSmokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('exactCommandsOk:false');
    // A denied/errored command still reaches the hook and can still be an explicit "allow"
    // decision at the hook layer (the hook approves the command; the command itself then fails
    // for an unrelated reason) -- realWorkOk and exactCommandsOk are independent facts here.
    expect(reason).toContain('realWorkOk:true');
  });

  it('isolates cleanTranscriptOk -- A has a malformed/truncated JSONL line', () => {
    const runA = passRunResult({ malformedLines: ['{not valid json'] });
    const { ok, reason } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:true');
    expect(reason).toContain('skillSelectionOk:false');
  });

  it('isolates skillSelectionOk -- B calls an entirely unrelated Skill in addition to real diagnostic work', () => {
    const base = passRunResult();
    const runB = passRunResult({ events: [...base.events, foreignSkillToolUseEvent('some-other-skill')] });
    const { ok, reason } = callSmokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('skillSelectionOk:false');
  });

  it('isolates skillSelectionOk -- A calls Skill with a non-string, malformed input.skill', () => {
    const base = passRunResult();
    const runA = passRunResult({ events: [...base.events, foreignSkillToolUseEvent(42)] });
    const { ok, reason } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('skillSelectionOk:false');
  });

  // See calibrationHardGate's identical tests + rationale -- the same gaps (plugins[] never
  // inspected; a dangling tool_use with no correlated result treated as safe) apply to smoke too.
  it('isolates pluginProfileOk -- A has a foreign plugin loaded (real isolation break, not a scoring artifact)', () => {
    const runA = passRunResult({ init: { ...passRunResult().init, plugins: [{ name: 'some-other-plugin', path: '/fake', source: 'fake' }] } });
    const { ok, reason } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:false');
  });

  it('isolates pluginProfileOk -- A has no plugins field at all (undefined, not a genuine empty-array observation)', () => {
    const runA = passRunResult({ init: { model: 'claude-sonnet-5-fake-resolved', tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' } });
    const { ok, reason } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:false');
  });

  it('isolates pluginProfileOk -- B has kmp-test-runner PLUS an extra, unexpected plugin', () => {
    const runB = passRunResult({ init: { ...passRunResult().init, plugins: [...KMP_TEST_RUNNER_PLUGIN, { name: 'some-other-plugin', path: '/fake', source: 'fake' }] } });
    const { ok, reason } = callSmokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:false');
  });

  it('isolates pluginProfileOk -- B has zero plugins loaded (should have exactly kmp-test-runner)', () => {
    const runB = passRunResult({ init: { ...passRunResult().init, plugins: [] } });
    const { ok, reason } = callSmokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:false');
  });

  it('isolates toolResultsCompleteOk -- A has a dangling Bash call with no correlated tool_result', () => {
    const danglingBash = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_dangling_bash', name: 'Bash', input: { command: 'kmp-test doctor --json' } }] } };
    const base = passRunResult();
    const runA = passRunResult({ events: [...base.events, danglingBash] });
    const { ok, reason } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('toolResultsCompleteOk:false');
  });

  // See calibrationHardGate's identical test's own comment -- a tool_use with no id also
  // cascades into transcriptStructureOk's empty_tool_use_id check, not just toolResultsCompleteOk.
  it('isolates toolResultsCompleteOk -- B has a tool_use with no id at all (cannot be correlated, so it can never be proven complete)', () => {
    const noIdToolUse = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'kmp-test doctor --json' } }] } };
    const base = passRunResult();
    const runB = passRunResult({ events: [...base.events, noIdToolUse], init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } });
    const { ok, reason } = callSmokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('toolResultsCompleteOk:false');
  });

  // See calibrationHardGate's identical tests + rationale -- the same gap (pluginProfileOk never
  // checks the loaded plugin's own path) applies to smoke too.
  it('isolates pluginSnapshotBindingOk -- B loads a correctly-NAMED plugin from the WRONG directory (the exact evidence-contamination bypass this closes)', () => {
    const runB = passRunResult({
      init: { ...passRunResult().init, plugins: [{ name: 'kmp-test-runner', path: WRONG_SNAPSHOT_DIR, source: 'fake' }] },
    });
    const { ok, reason } = callSmokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('pluginProfileOk:true');
    expect(reason).toContain('pluginSnapshotBindingOk:false');
  });

  it('isolates pluginSnapshotBindingOk -- B\'s own snapshotDir is missing (null), so a correctly-named-and-pathed plugin still cannot be bound', () => {
    const runB = passRunResult({
      init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN },
      snapshotDir: null,
    });
    const { ok, reason } = callSmokeHardGate(passA(), passB(), passRunResult(), runB);
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
    const { ok, reason } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callSmokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('resultOk:true');
    expect(reason).toContain('transcriptStructureOk:false');
  });

  it('isolates transcriptStructureOk -- A has two tool_use blocks sharing the same id (a single tool_result cannot unambiguously satisfy both)', () => {
    const base = passRunResult();
    const dup1 = bashToolUseEvent('toolu_dup', 'kmp-test parallel --json');
    const dup2 = bashToolUseEvent('toolu_dup', 'kmp-test parallel --json');
    const runA = passRunResult({ events: [...base.events, dup1, dup2, toolResultEvent('toolu_dup')] });
    const { ok, reason } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callSmokeHardGate(passA(), passB(), passRunResult(), runB);
    expect(ok).toBe(false);
    expect(reason).toContain('toolResultsCompleteOk:true');
    expect(reason).toContain('transcriptStructureOk:false');
  });

  it('isolates transcriptStructureOk -- A has an orphan tool_result referencing a tool_use id that was never called', () => {
    const base = passRunResult();
    const runA = passRunResult({ events: [...base.events, toolResultEvent('toolu_never_called')] });
    const { ok, reason } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callSmokeHardGate(passA(), passB(), passRunResult(), runB);
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
    const { ok, reason } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
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
    const { ok, reason } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(false);
    expect(reason).toContain('transcriptStructureOk:false');
  });

  // Property-style equivalence proof -- see calibrationHardGate's identical rationale. Exercises
  // BOTH sides failing simultaneously on DIFFERENT checks, including smoke-specific realWorkOk/
  // exactCommandsOk (not present in calibrationHardGate at all), proving the merge didn't drop or
  // misattribute either gate's own distinct check set.
  it('property: ok === (failedChecksA.length===0 && failedChecksB.length===0), with correct per-side attribution, when BOTH sides fail on DIFFERENT checks simultaneously', () => {
    const a = passA({ skill_available: { value: true, reason: null } });
    const b = passB({ hook_deny_count: 1 });
    const runA = passRunResult({
      bashResults: [{ command: 'kmp-test doctor --json', resultFound: true, resultIsError: false }],
      events: [initEventStub(), bashToolUseEvent('toolu_1', 'kmp-test doctor --json'), toolResultEvent('toolu_1'), resultEventStub()],
    });
    const runB = passRunResult({
      malformedLines: [{ line: 'not valid json', error: 'simulated' }],
      init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] },
    });
    const { ok, reason, failedChecksA, failedChecksB } = callSmokeHardGate(a, b, runA, runB);
    expect(ok).toBe(false);
    expect(ok).toBe(failedChecksA.length === 0 && failedChecksB.length === 0);
    expect([...failedChecksA].sort()).toEqual(['availabilityOk', 'exactCommandsOk'].sort());
    expect([...failedChecksB].sort()).toEqual(['cleanTranscriptOk', 'realWorkOk'].sort());
    for (const stillOk of ['skillSelectionOk', 'pluginProfileOk', 'initOk', 'toolProfileOk', 'noUnexpectedToolsOk', 'processOk', 'resultOk', 'hookAccountingOk', 'toolResultsCompleteOk', 'transcriptStructureOk']) {
      expect(reason).toContain(`${stillOk}:true`);
    }
  });

  it('property: ok===true and both failedChecks arrays are empty precisely when every individual check passes', () => {
    const { ok, failedChecksA, failedChecksB } = callSmokeHardGate(passA(), passB(), passRunResult(), passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
    expect(ok).toBe(true);
    expect(failedChecksA).toEqual([]);
    expect(failedChecksB).toEqual([]);
  });

  // Mandatory RED->GREEN reproduction (review-round-2, correction 4): smoke's own gate, like
  // calibration's, never checked init.skills[] validity at all before this fix -- see
  // calibrationHardGate's identical describe block for the full rationale.
  describe('ambient-skill-profile validity (correction 4 -- previously unchecked)', () => {
    it('isolates ambientSkillProfileOk -- A (no-skill) with a malformed (non-array) skills[] fails closed', () => {
      const runA = passRunResult({ init: { ...passRunResult().init, skills: 'not-an-array' } });
      const { ok, failedChecksA } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
      expect(ok).toBe(false);
      expect(failedChecksA).toContain('ambientSkillProfileOk');
    });

    it('isolates ambientSkillProfileOk -- B (current-skill) with a malformed (non-array) skills[] fails closed', () => {
      const runB = passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: 'not-an-array' } });
      const { ok, failedChecksB } = callSmokeHardGate(passA(), passB(), passRunResult(), runB);
      expect(ok).toBe(false);
      expect(failedChecksB).toContain('ambientSkillProfileOk');
    });

    it('isolates targetSkillAmbientIdentityOk -- A (no-skill) whose skills[] anomalously advertises the target fails closed, even though it was never invoked', () => {
      const runA = passRunResult({ init: { ...passRunResult().init, skills: ['kmp-test-runner'] } });
      const { ok, failedChecksA } = callSmokeHardGate(passA(), passB(), runA, passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner'] } }));
      expect(ok).toBe(false);
      expect(failedChecksA).toContain('targetSkillAmbientIdentityOk');
    });

    // --- Mandatory RED->GREEN reproduction (round-3 audit finding, P1) -- see
    // calibrationHardGate's identical describe block for the full rationale.
    it('isolates targetSkillAmbientIdentityOk -- B (current-skill) whose skills[] does NOT include the target fails closed, even though the plugin loaded', () => {
      const runB = passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['run'] } });
      const { ok, failedChecksB } = callSmokeHardGate(passA(), passB(), passRunResult(), runB);
      expect(ok).toBe(false);
      expect(failedChecksB).toContain('targetSkillAmbientIdentityOk');
    });

    it('a well-formed skills[] carrying real ambient (non-target) entries still passes cleanly on both sides', () => {
      const runA = passRunResult({ init: { ...passRunResult().init, skills: ['run'] } });
      const runB = passRunResult({ init: { ...passRunResult().init, plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['run', 'kmp-test-runner'] } });
      const { ok } = callSmokeHardGate(passA(), passB(), runA, runB);
      expect(ok).toBe(true);
    });
  });
});

// scenarioCellIntegrityOk/scenarioHardGate (decision 4 of the design): harness-integrity ONLY,
// never the scenario OUTCOME (that's graders.mjs's job) -- a wrong answer, a policy denial, or a
// declared timeout must all still PASS this gate, since they're legitimate data, not harness
// defects. Same isolated-synthetic-input testing philosophy as calibrationHardGate/smokeHardGate
// above.
describe('scenarioCellIntegrityOk', () => {
  // skill_invoked defaults to false regardless of condition -- current-skill is exempt from
  // noSkillSafetyOk (see the check itself), so its value doesn't affect that check either way;
  // no-skill's clean baseline genuinely needs false to pass.
  function passRecord(condition, overrides = {}) {
    return {
      condition,
      skill_available: { value: condition === 'current-skill', reason: null },
      skill_invoked: { value: false, reason: null },
      ...overrides,
    };
  }
  // Extracted so nested test-local helpers can still build a "the default init, plus one tweaked
  // field" override (`{...defaultInitFor(condition), skills:[...]}`) -- passConditionResult's own
  // return shape no longer exposes a top-level `.init` to read back (it's folded into `.observation`
  // now), unlike before this refactor.
  function defaultInitFor(condition) {
    const isCurrentSkill = condition === 'current-skill';
    return {
      model: 'claude-sonnet-5-fake-resolved',
      plugins: isCurrentSkill ? KMP_TEST_RUNNER_PLUGIN : [],
      // Mirrors the real fixture's own convention (agentic-eval-stream-current-skill.jsonl) -- a
      // current-skill init event's skills[] naturally includes the target's own namespaced
      // identity once loaded; a no-skill one never has it. Both are well-formed, empty-after-
      // stripping ambient profiles, matching by construction across every existing test here.
      skills: isCurrentSkill ? ['kmp-test-runner:kmp-test-runner'] : [],
      tools: ['Bash', 'Skill'],
      mcp_servers: [],
      permissionMode: 'dontAsk',
    };
  }
  function passConditionResult(condition, overrides = {}) {
    const isCurrentSkill = condition === 'current-skill';
    const raw = {
      init: defaultInitFor(condition),
      snapshotDir: isCurrentSkill ? FAKE_SNAPSHOT_DIR : null,
      hookStats: { everyCallHooked: true, hookAllowCount: 1, hookDenyCount: 0 },
      events: [
        initEventStub(),
        bashToolUseEvent('toolu_1', 'kmp-test parallel --module-filter shared --json'),
        toolResultEvent('toolu_1'),
        resultEventStub(),
      ],
      malformedLines: [],
      spawnResult: { terminated: false, terminationReason: null },
      ...overrides,
    };
    return {
      // Real runSingleCondition() (matrix-runner.mjs) return objects always carry `condition` as
      // their own first field -- cell-integrity.mjs's cellTranscriptIntegrityOk (unlike the
      // pre-fix scenarioCellIntegrityOk, which derived expectSkillAvailable from the SEPARATE
      // `record.condition` instead) must be able to determine expectSkillAvailable from
      // conditionResult ALONE, since it also runs during fail-fast, before any record exists.
      // Omitted here previously only because nothing read it before this fix.
      condition,
      observation: toObservation(raw, { expectSkillAvailable: isCurrentSkill }),
      // scenarioCellIntegrityOk now proves hookAccountingOk via the canonical per-tool_use_id
      // dispatch accounting (requireDispatchAccounting:true) rather than the aggregate
      // hookStats.everyCallHooked. Every pre-existing test here expresses a hook-accounting
      // failure by overriding hookStats.everyCallHooked, so mirror that override into the
      // accounting unless a test supplies its own -- otherwise those tests would silently stop
      // discriminating (they would still fail, but for the wrong reason: absent accounting).
      dispatchAccounting: overrides.dispatchAccounting !== undefined
        ? overrides.dispatchAccounting
        : { everyCallAccountedFor: (overrides.hookStats ?? { everyCallHooked: true }).everyCallHooked === true },
    };
  }

  it('passes for a clean no-skill cell', () => {
    const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), passConditionResult('no-skill'));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  // Independence guard. Tightening hookAccountingOk (it now fails on a Bash call whose hook events
  // and decision record disagree) means fail-fast catches the DECISION half of captureIncomplete
  // earlier than before. junitCaptureCompleteOk must keep its own separate reach for the half
  // fail-fast can never preempt -- the Gradle EVIDENCE record -- so neither check masks the other.
  it('junitCaptureCompleteOk still fails independently on a cell whose dispatch accounting is clean', () => {
    const record = passRecord('no-skill', {
      errors: [{ code: 'junit_evidence_capture_incomplete', message: 'evidence record missing for a relevant attempt' }],
    });
    const conditionResult = passConditionResult('no-skill');
    const { ok, reason } = scenarioCellIntegrityOk(record, conditionResult);
    expect(ok).toBe(false);
    expect(reason).toContain('junitCaptureCompleteOk:false');
    // ...and specifically NOT because hook accounting also tripped.
    expect(reason).toContain('hookAccountingOk:true');
  });

  it('passes for a clean current-skill cell', () => {
    const { ok, reason } = scenarioCellIntegrityOk(passRecord('current-skill'), passConditionResult('current-skill'));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  // RED proof (pre-fix, confirmed against a real 2026-07-22 live rejection): a current-skill
  // cell's ONLY Skill call used Claude Code's plugin-namespaced form (kmp-test-runner:kmp-test-runner,
  // per plugin.json's own documented addressing scheme), not the bare form -- a genuine invocation
  // of the harness's own target skill, wrongly classified as confirmed foreign-skill contamination.
  it('a current-skill cell whose ONLY Skill call uses the plugin-namespaced form is a genuine target-skill invocation, not foreign contamination', () => {
    const cr = passConditionResult('current-skill', {
      events: [
        initEventStub(),
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id: 's1', input: { skill: 'kmp-test-runner:kmp-test-runner' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', is_error: false, content: 'real skill output' }] } },
        resultEventStub(),
      ],
    });
    const { ok, reason } = scenarioCellIntegrityOk(passRecord('current-skill'), cr);
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  // P1 (post-#385 review): now that isTargetSkillReference correctly recognizes BOTH the bare and
  // plugin-namespaced forms as the target skill (never foreign), skillSelectionOk alone no longer
  // catches a no-skill cell whose Skill call was genuinely CONFIRMED -- real evidence
  // contamination (an environmental same-named skill, or a Claude Code inconsistency), mirroring
  // exactly why calibrationHardGate has its own noSkillSafetyOk. Proven for BOTH accepted wire
  // forms -- the bare form was always a real invocation (this bug predates #385); the namespaced
  // form is newly a real invocation as of #385's own fix.
  it('a no-skill cell whose Skill call is CONFIRMED (bare form) is real evidence contamination -- ok:false', () => {
    const cr = passConditionResult('no-skill', {
      events: [
        initEventStub(),
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id: 's1', input: { skill: 'kmp-test-runner' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', is_error: false, content: 'real skill output' }] } },
        resultEventStub(),
      ],
    });
    const record = passRecord('no-skill', { skill_invoked: { value: true, reason: null } });
    const { ok, reason } = scenarioCellIntegrityOk(record, cr);
    expect(ok).toBe(false);
    expect(reason).toContain('noSkillSafetyOk:false');
  });

  it('a no-skill cell whose Skill call is CONFIRMED (plugin-namespaced form) is real evidence contamination -- ok:false', () => {
    const cr = passConditionResult('no-skill', {
      events: [
        initEventStub(),
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id: 's1', input: { skill: 'kmp-test-runner:kmp-test-runner' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', is_error: false, content: 'real skill output' }] } },
        resultEventStub(),
      ],
    });
    const record = passRecord('no-skill', { skill_invoked: { value: true, reason: null } });
    const { ok, reason } = scenarioCellIntegrityOk(record, cr);
    expect(ok).toBe(false);
    expect(reason).toContain('noSkillSafetyOk:false');
  });

  it('a no-skill cell whose Skill call is REJECTED ("Unknown skill", either wire form) is still valid, measured agent behavior -- ok:true', () => {
    for (const skillArg of ['kmp-test-runner', 'kmp-test-runner:kmp-test-runner']) {
      const cr = passConditionResult('no-skill', {
        events: [
          initEventStub(),
          { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id: 's1', input: { skill: skillArg } }] } },
          { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', is_error: true, content: `<tool_use_error>Unknown skill: ${skillArg}</tool_use_error>` }] } },
          resultEventStub(),
        ],
      });
      // A rejected attempt never confirms the invocation -- skill_invoked stays false, matching
      // what findSkillInvocation would really report for this transcript.
      const record = passRecord('no-skill', { skill_invoked: { value: false, reason: null } });
      const { ok, reason } = scenarioCellIntegrityOk(record, cr);
      expect(ok).toBe(true);
      expect(reason).toBeNull();
    }
  });

  it('isolates availabilityOk -- a no-skill cell whose environment shows the skill as available', () => {
    const record = passRecord('no-skill', { skill_available: { value: true, reason: null } });
    const { ok, reason } = scenarioCellIntegrityOk(record, passConditionResult('no-skill'));
    expect(ok).toBe(false);
    expect(reason).toContain('availabilityOk:false');
  });

  // The key distinguishing behavior from smoke's stricter gate: a policy DENIAL is the hook
  // working as intended and must never disqualify a cell, only the MECHANISM (every call actually
  // reached the hook) matters here.
  it('a policy denial (hook_deny_count > 0) does NOT fail hookAccountingOk -- only mechanism integrity (everyCallHooked) does', () => {
    const cr = passConditionResult('no-skill', { hookStats: { everyCallHooked: true, hookAllowCount: 0, hookDenyCount: 1 } });
    const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), cr);
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  it('isolates hookAccountingOk -- a Bash call that never reached the hook at all (mechanism failure)', () => {
    const cr = passConditionResult('no-skill', { hookStats: { everyCallHooked: false, hookAllowCount: 1, hookDenyCount: 0 } });
    const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), cr);
    expect(ok).toBe(false);
    expect(reason).toContain('hookAccountingOk:false');
  });

  // A declared timeout is legitimate data (decision 7) -- must pass, using the timeout-tolerant
  // structural checks.
  it('a legitimate timeout (terminated:true, reason:timeout) still passes -- structural checks are timeout-tolerant', () => {
    const cr = passConditionResult('no-skill', {
      events: [initEventStub(), bashToolUseEvent('toolu_1', 'kmp-test parallel --json')], // no result, no terminal result event
      spawnResult: { terminated: true, terminationReason: 'timeout' },
    });
    const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), cr);
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  it('isolates terminationOk -- an "error" termination (not timeout) is a harness-trustworthiness signal and fails', () => {
    const cr = passConditionResult('no-skill', { spawnResult: { terminated: true, terminationReason: 'error' } });
    const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), cr);
    expect(ok).toBe(false);
    expect(reason).toContain('terminationOk:false');
  });

  // Review-round-2 fix: ambiguous JUnit evidence (more than one Gradle attempt in a condition
  // could have produced the single per-condition XML snapshot) is a HARNESS-integrity defect, not
  // a legitimate agent outcome -- it must block promotion here, not merely degrade that one cell's
  // outcomeMatches to false (which would let it read as valid negative data).
  it('isolates junitEvidenceOk -- a record carrying an ambiguous_junit_evidence error fails, even though everything else is clean', () => {
    const record = passRecord('no-skill', { errors: [{ code: 'ambiguous_junit_evidence', message: 'ambiguous' }] });
    const { ok, reason } = scenarioCellIntegrityOk(record, passConditionResult('no-skill'));
    expect(ok).toBe(false);
    expect(reason).toContain('junitEvidenceOk:false');
  });

  it('a record with a DIFFERENT, unrelated error code does not trip junitEvidenceOk', () => {
    const record = passRecord('no-skill', { errors: [{ code: 'raw_capture_location_overridden', message: 'unrelated' }] });
    const { ok, reason } = scenarioCellIntegrityOk(record, passConditionResult('no-skill'));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  it('a record with no errors[] field at all (the common case) does not trip junitEvidenceOk', () => {
    const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), passConditionResult('no-skill'));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  // Round 10 (systematic-closure pass): the identical HARNESS-integrity treatment applied to a
  // malformed parallel.legs[] structure -- a fresh review found this was previously laundered
  // only through expected_outcome_matched:false, reading as a legitimate negative result rather
  // than "the tool's own JSON output cannot be trusted at all."
  it('isolates parallelEvidenceOk -- a record carrying a malformed_parallel_evidence error fails, even though everything else is clean', () => {
    const record = passRecord('no-skill', { errors: [{ code: 'malformed_parallel_evidence', message: 'incoherent' }] });
    const { ok, reason } = scenarioCellIntegrityOk(record, passConditionResult('no-skill'));
    expect(ok).toBe(false);
    expect(reason).toContain('parallelEvidenceOk:false');
  });

  it('a record with a DIFFERENT, unrelated error code does not trip parallelEvidenceOk', () => {
    const record = passRecord('no-skill', { errors: [{ code: 'raw_capture_location_overridden', message: 'unrelated' }] });
    const { ok, reason } = scenarioCellIntegrityOk(record, passConditionResult('no-skill'));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  // Round 11 (Docker/local-ci audit): the identical HARNESS-integrity treatment applied to a real
  // JUnit XML the harness could not fully trust (a genuine <skipped> testcase, or an oversized/
  // unreadable file) -- a fresh review found matrix-runner.mjs's captureGradleJunitEvidence
  // previously miscounted a skip as a pass, which would have laundered a real evidence-completeness
  // gap through expected_outcome_matched alone, exactly the mistake junitEvidenceOk/
  // parallelEvidenceOk already exist to avoid for their own respective evidence shapes.
  it('isolates junitSkipEvidenceOk -- a record carrying an unreliable_gradle_junit_evidence error fails, even though everything else is clean', () => {
    const record = passRecord('no-skill', { errors: [{ code: 'unreliable_gradle_junit_evidence', message: 'skip/anomaly' }] });
    const { ok, reason } = scenarioCellIntegrityOk(record, passConditionResult('no-skill'));
    expect(ok).toBe(false);
    expect(reason).toContain('junitSkipEvidenceOk:false');
  });

  it('a record with a DIFFERENT, unrelated error code does not trip junitSkipEvidenceOk', () => {
    const record = passRecord('no-skill', { errors: [{ code: 'raw_capture_location_overridden', message: 'unrelated' }] });
    const { ok, reason } = scenarioCellIntegrityOk(record, passConditionResult('no-skill'));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  it('a record with no errors[] field at all (the common case) does not trip junitSkipEvidenceOk', () => {
    const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), passConditionResult('no-skill'));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  // "bind junit evidence to authoritative attempts" fix: junit_evidence_capture_incomplete is a
  // capture-MECHANISM failure (a missing/incoherent decision/evidence record, a command cross-check
  // mismatch, or a duplicate-write anomaly on some relevant attempt) -- distinct from, and never
  // merged with, ambiguous_junit_evidence (a proven same-turn conflict) or
  // unreliable_gradle_junit_evidence (real-but-untrustworthy XML). Each gets its own independently-
  // toggleable check so a caller can tell precisely which of the three failed.
  it('isolates junitCaptureCompleteOk -- a record carrying a junit_evidence_capture_incomplete error fails, even though everything else is clean', () => {
    const record = passRecord('no-skill', { errors: [{ code: 'junit_evidence_capture_incomplete', message: 'missing decision record' }] });
    const { ok, reason } = scenarioCellIntegrityOk(record, passConditionResult('no-skill'));
    expect(ok).toBe(false);
    expect(reason).toContain('junitCaptureCompleteOk:false');
  });

  it('a record with a DIFFERENT, unrelated error code does not trip junitCaptureCompleteOk', () => {
    const record = passRecord('no-skill', { errors: [{ code: 'raw_capture_location_overridden', message: 'unrelated' }] });
    const { ok, reason } = scenarioCellIntegrityOk(record, passConditionResult('no-skill'));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  it('a record with no errors[] field at all (the common case) does not trip junitCaptureCompleteOk', () => {
    const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), passConditionResult('no-skill'));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  // junit_evidence_capture_incomplete and ambiguous_junit_evidence are two INDEPENDENT checks --
  // both codes present on the same record must fail BOTH junitCaptureCompleteOk and junitEvidenceOk
  // simultaneously, never conflated into one.
  it('junit_evidence_capture_incomplete and ambiguous_junit_evidence on the SAME record independently fail their own respective checks', () => {
    const record = passRecord('no-skill', {
      errors: [
        { code: 'junit_evidence_capture_incomplete', message: 'missing decision record' },
        { code: 'ambiguous_junit_evidence', message: 'ambiguous' },
      ],
    });
    const { ok, reason } = scenarioCellIntegrityOk(record, passConditionResult('no-skill'));
    expect(ok).toBe(false);
    expect(reason).toContain('junitCaptureCompleteOk:false');
    expect(reason).toContain('junitEvidenceOk:false');
  });

  // Result-aware foreign-skill classification (see stream-parser.mjs's classifyForeignSkillUses):
  // this fixture's foreign Skill call has NO correlated tool_result anywhere in the transcript --
  // that is the MISSING/INCOMPLETE case, not a confirmed contamination. Previously (when
  // scenarioCellIntegrityOk used the plain, argument-only findForeignSkillUses) this same fixture
  // failed via skillSelectionOk; it now fails via the new, distinct foreignSkillToolResultsCompleteOk
  // check instead -- skillSelectionOk itself correctly reads true, since nothing here CONFIRMS a
  // foreign invocation happened.
  it('isolates foreignSkillToolResultsCompleteOk -- a foreign Skill call with no correlated tool_result at all (missing/incomplete)', () => {
    const cr = passConditionResult('no-skill', {
      events: [
        initEventStub(),
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id: 's1', input: { skill: 'some-other-skill' } }] } },
        resultEventStub(),
      ],
    });
    const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), cr);
    expect(ok).toBe(false);
    expect(reason).toContain('foreignSkillToolResultsCompleteOk:false');
    expect(reason).toContain('skillSelectionOk:true');
  });

  // The genuinely-confirmed case the original test's name implied: a foreign Skill call WITH a
  // real, correlated, non-error tool_result. This is the one case that must still fail closed --
  // a rejected ("Unknown skill") foreign attempt no longer fails skillSelectionOk (see the
  // "tolerates a REJECTED foreign attempt" test below), but a CONFIRMED one still must.
  it('isolates skillSelectionOk -- a foreign Skill call that was actually CONFIRMED (real, non-error tool_result)', () => {
    const cr = passConditionResult('no-skill', {
      events: [
        initEventStub(),
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id: 's1', input: { skill: 'some-other-skill' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', is_error: false, content: 'some real skill output' }] } },
        resultEventStub(),
      ],
    });
    const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), cr);
    expect(ok).toBe(false);
    expect(reason).toContain('skillSelectionOk:false');
    expect(reason).toContain('foreignSkillToolResultsCompleteOk:true');
  });

  // The headline new behavior this whole PR exists to enable: a REJECTED foreign attempt ("Unknown
  // skill") on an otherwise-clean cell is measured agent behavior, not contamination, and must no
  // longer block promotion.
  it('tolerates a REJECTED foreign Skill attempt (is_error:true) on an otherwise-clean cell -- ok:true', () => {
    const cr = passConditionResult('no-skill', {
      events: [
        initEventStub(),
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id: 's1', input: { skill: 'some-other-skill' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', is_error: true, content: '<tool_use_error>Unknown skill: some-other-skill</tool_use_error>' }] } },
        resultEventStub(),
      ],
    });
    const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), cr);
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  // Ambient-skill-profile fix: a real live scenario run failed its hard gate because a CONFIRMED
  // invocation of Claude Code's own bundled "run" skill (present in init.skills[] regardless of
  // --plugin-dir) was indistinguishable from genuine third-party contamination. skillSelectionOk
  // is now tolerant of a confirmed non-target Skill call ONLY when that exact skillArg was
  // advertised in the matrix-wide shared ambient profile (3rd, optional constructor arg -- callers
  // that omit it, like every test above, get the empty-Set fail-closed default, so none of those
  // existing tests are affected).
  describe('ambient-skill-profile tolerance (3rd, optional context argument)', () => {
    function confirmedForeignSkillCr(skillArg, overrides = {}) {
      return passConditionResult('no-skill', {
        events: [
          initEventStub(),
          { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id: 's1', input: { skill: skillArg } }] } },
          { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', is_error: false, content: 'real bundled skill output' }] } },
          resultEventStub(),
        ],
        ...overrides,
      });
    }

    it('tolerates a CONFIRMED non-target Skill call when it IS a member of the shared ambient profile -- ok:true', () => {
      const cr = confirmedForeignSkillCr('run');
      const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), cr, { sharedAmbientNames: new Set(['run']) });
      expect(ok).toBe(true);
      expect(reason).toBeNull();
    });

    it('still rejects a CONFIRMED non-target Skill call when it is NOT a member of the (non-empty) shared ambient profile', () => {
      const cr = confirmedForeignSkillCr('some-unadvertised-skill');
      const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), cr, { sharedAmbientNames: new Set(['run']) });
      expect(ok).toBe(false);
      expect(reason).toContain('skillSelectionOk:false');
    });

    it('never tolerates it via a hardcoded "run" special-case -- a differently-named shared ambient skill is tolerated identically', () => {
      const cr = confirmedForeignSkillCr('some-other-bundled-capability');
      const { ok } = scenarioCellIntegrityOk(passRecord('no-skill'), cr, { sharedAmbientNames: new Set(['some-other-bundled-capability']) });
      expect(ok).toBe(true);
    });

    it('omitting the 3rd argument entirely defaults to the empty Set (fail-closed) -- identical to the pre-fix zero-tolerance behavior', () => {
      const cr = confirmedForeignSkillCr('run');
      const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), cr);
      expect(ok).toBe(false);
      expect(reason).toContain('skillSelectionOk:false');
    });

    it('ambientProfileMatrixOk defaults to true when omitted -- an isolated single-cell call is never penalized for a matrix-wide fact it cannot know', () => {
      const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), passConditionResult('no-skill'));
      expect(ok).toBe(true);
      expect(reason).toBeNull();
    });

    it('an explicit ambientProfileMatrixOk:false fails the cell even with an otherwise-clean transcript', () => {
      const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), passConditionResult('no-skill'), { ambientProfileMatrixOk: false });
      expect(ok).toBe(false);
      expect(reason).toContain('ambientProfileMatrixOk:false');
    });
  });

  // Ambient-skill-profile fix: computeAmbientSkillProfile's own strict validation, wired into
  // this gate as a new, independent named check (ambientSkillProfileOk) -- proven here at the
  // gate level (not just stream-parser.mjs's own direct unit tests), since a malformed
  // conditionResult.init.skills[] must actually block promotion, not merely be detectable.
  describe('ambientSkillProfileOk -- init.skills[] parse/validation wired into the gate', () => {
    function crWithSkills(skills) {
      return passConditionResult('no-skill', { init: { ...defaultInitFor('no-skill'), skills } });
    }

    it('a well-formed (even empty) skills[] passes -- ok:true', () => {
      const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), crWithSkills([]));
      expect(ok).toBe(true);
      expect(reason).toBeNull();
    });

    it('isolates ambientSkillProfileOk -- skills present but not an array fails closed', () => {
      const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), crWithSkills('not-an-array'));
      expect(ok).toBe(false);
      expect(reason).toContain('ambientSkillProfileOk:false');
    });

    it('isolates ambientSkillProfileOk -- a non-string entry fails closed', () => {
      const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), crWithSkills(['run', 42]));
      expect(ok).toBe(false);
      expect(reason).toContain('ambientSkillProfileOk:false');
    });

    it('isolates ambientSkillProfileOk -- a duplicate entry fails closed', () => {
      const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), crWithSkills(['run', 'run']));
      expect(ok).toBe(false);
      expect(reason).toContain('ambientSkillProfileOk:false');
    });

    it('isolates ambientSkillProfileOk -- a completely missing skills key fails closed', () => {
      const init = { ...defaultInitFor('no-skill') };
      delete init.skills;
      const cr = passConditionResult('no-skill', { init });
      const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), cr);
      expect(ok).toBe(false);
      expect(reason).toContain('ambientSkillProfileOk:false');
    });
  });

  // Mandatory RED->GREEN reproduction (review-round-2, correction 1) -- THE original finding: a
  // no-skill cell whose skills[] anomalously advertises the target's own identity (bare or
  // namespaced) passed this exact gate with ok:true/failedChecks:[] before this fix, because
  // computeAmbientSkillProfile stripped the target's identity unconditionally regardless of
  // condition, and nothing else here inspects skills[] for the target's own presence (only
  // plugins[], via pluginProfileOk, and actual invocation, via noSkillSafetyOk). Directly
  // reproduced against the pre-fix code before this fix existed.
  describe('targetSkillAmbientIdentityOk -- condition-aware target-identity handling (correction 1)', () => {
    function noSkillCrWithSkills(skills) {
      return passConditionResult('no-skill', { init: { ...defaultInitFor('no-skill'), skills } });
    }

    it('a no-skill cell whose skills[] anomalously advertises the BARE target identity fails closed, even though never invoked', () => {
      const cr = noSkillCrWithSkills(['kmp-test-runner']);
      const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), cr);
      expect(ok).toBe(false);
      expect(reason).toContain('targetSkillAmbientIdentityOk:false');
    });

    it('a no-skill cell whose skills[] anomalously advertises the NAMESPACED target identity fails closed too', () => {
      const cr = noSkillCrWithSkills(['kmp-test-runner:kmp-test-runner']);
      const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), cr);
      expect(ok).toBe(false);
      expect(reason).toContain('targetSkillAmbientIdentityOk:false');
    });

    it('a no-skill cell whose skills[] carries only OTHER ambient names (no target reference at all) passes cleanly', () => {
      const cr = noSkillCrWithSkills(['run']);
      const { ok, reason } = scenarioCellIntegrityOk(passRecord('no-skill'), cr);
      expect(ok).toBe(true);
      expect(reason).toBeNull();
    });

    it('a current-skill cell whose skills[] carries exactly one target representation (either form) passes cleanly', () => {
      const crBare = passConditionResult('current-skill', { init: { ...defaultInitFor('current-skill'), skills: ['run', 'kmp-test-runner'] } });
      const { ok: okBare } = scenarioCellIntegrityOk(passRecord('current-skill'), crBare);
      expect(okBare).toBe(true);
    });

    // --- Mandatory RED->GREEN reproduction (round-3 audit finding, P1): "current-skill accepts
    // target absence" -- pluginProfileOk only inspects init.plugins[], never skills[], so a
    // current-skill cell with the plugin genuinely loaded but the target never advertised in
    // skills[] previously slipped through targetSkillAmbientIdentityOk entirely.
    it('a current-skill cell whose skills[] does NOT include the target at all fails closed, even though the plugin loaded', () => {
      const cr = passConditionResult('current-skill', { init: { ...defaultInitFor('current-skill'), skills: ['run'] } });
      const { ok, reason } = scenarioCellIntegrityOk(passRecord('current-skill'), cr);
      expect(ok).toBe(false);
      expect(reason).toContain('targetSkillAmbientIdentityOk:false');
    });

    it('duplicate LOGICAL target representations (bare AND namespaced simultaneously) fail closed, regardless of condition', () => {
      for (const condition of ['no-skill', 'current-skill']) {
        const cr = passConditionResult(condition, { init: { ...defaultInitFor(condition), skills: ['kmp-test-runner', 'kmp-test-runner:kmp-test-runner'] } });
        const { ok, reason } = scenarioCellIntegrityOk(passRecord(condition), cr);
        expect(ok).toBe(false);
        expect(reason).toContain('targetSkillAmbientIdentityOk:false');
      }
    });
  });

  // Wiring-point regression lock (Diseño 3, noPreInferenceFailureOk): this function does NOT
  // spread shared.checksByName generically -- it hand-lists every tuple explicitly. A check added
  // only inside cellTranscriptIntegrityOk's own checksByName is computed but silently never
  // enforced here unless it ALSO gets its own tuple in this function's evaluateNamedChecks call.
  // This is precisely the gap that would let a pre-inference failure on the LAST planned cell of a
  // matrix (matrixComplete:true, so the fail-fast break in runScenarioMatrix's loop never fires --
  // only this function's own re-evaluation decides) slip through undetected.
  it('rejects a cell matching the pre-inference-failure signature -- proves the manual tuple list was updated, not just cellTranscriptIntegrityOk', () => {
    const cr = passConditionResult('current-skill', {
      events: [initEventStub(), { type: 'assistant', message: { content: [{ type: 'text', text: 'Not logged in.' }], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }, resultEventStub()],
      result: { subtype: 'error_during_execution', is_error: true, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });
    const { ok, reason, failedChecks } = scenarioCellIntegrityOk(passRecord('current-skill'), cr);
    expect(ok).toBe(false);
    expect(failedChecks).toContain('noPreInferenceFailureOk');
    expect(reason).toContain('noPreInferenceFailureOk:false');
  });

  it('a real negative-outcome cell (is_error:true, genuine engagement) is never rejected by noPreInferenceFailureOk here either', () => {
    const cr = passConditionResult('current-skill', {
      result: { subtype: 'error_during_execution', is_error: true, num_turns: 4, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });
    const { failedChecks } = scenarioCellIntegrityOk(passRecord('current-skill'), cr);
    expect(failedChecks).not.toContain('noPreInferenceFailureOk');
  });
});

describe('scenarioHardGate', () => {
  function cell(condition, repetitionIndex, integrityOverrides = {}) {
    const record = {
      condition, repetition_index: repetitionIndex,
      skill_available: { value: condition === 'current-skill', reason: null },
      skill_invoked: { value: false, reason: null },
    };
    const isCurrentSkill = condition === 'current-skill';
    const raw = {
      init: {
        plugins: isCurrentSkill ? KMP_TEST_RUNNER_PLUGIN : [],
        skills: isCurrentSkill ? ['kmp-test-runner:kmp-test-runner'] : [],
        tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk',
      },
      snapshotDir: isCurrentSkill ? FAKE_SNAPSHOT_DIR : null,
      hookStats: { everyCallHooked: true, hookAllowCount: 1, hookDenyCount: 0 },
      events: [initEventStub(), bashToolUseEvent('t1', 'kmp-test parallel --json'), toolResultEvent('t1'), resultEventStub()],
      malformedLines: [],
      spawnResult: { terminated: false, terminationReason: null },
      ...integrityOverrides,
    };
    const conditionResult = {
      // See passConditionResult's identical fix/comment above -- real runSingleCondition() return
      // objects always carry `condition`, and cellTranscriptIntegrityOk (cell-integrity.mjs) now
      // derives expectSkillAvailable from THIS field (it has no `record` to fall back to).
      condition,
      observation: toObservation(raw, { expectSkillAvailable: isCurrentSkill }),
      // Same rationale as passConditionResult's own identical line: hookAccountingOk is now proven
      // via the canonical dispatch accounting, so mirror any hookStats.everyCallHooked override
      // into it unless the test supplies its own accounting.
      dispatchAccounting: integrityOverrides.dispatchAccounting !== undefined
        ? integrityOverrides.dispatchAccounting
        : { everyCallAccountedFor: (integrityOverrides.hookStats ?? { everyCallHooked: true }).everyCallHooked === true },
    };
    return { record, conditionResult };
  }

  it('passes when every cell is harness-integrity-clean', () => {
    const cells = [cell('current-skill', 0), cell('no-skill', 0), cell('current-skill', 1), cell('no-skill', 1)];
    const { ok, reason } = scenarioHardGate(cells.map((c) => c.record), cells.map((c) => c.conditionResult));
    expect(ok).toBe(true);
    expect(reason).toBeNull();
  });

  // Mandatory RED->GREEN reproduction (review-round-2, correction 5): the pre-fix version
  // returned a vacuous {ok:true, cellResults:[]} for records:[] paired with a non-empty
  // conditionResults (directly demonstrated), and threw an UNCAUGHT TypeError for the reverse
  // mismatch (conditionResults:[] with a non-empty records, since ambientProfiles[0] was then
  // undefined -- also directly demonstrated). A real hard gate must fail closed, without ever
  // throwing, whenever its own two inputs aren't both non-empty arrays of matching length.
  describe('cardinality fail-closed (correction 5 -- previously vacuous-pass or uncaught-throw)', () => {
    it('records:[] with a non-empty conditionResults fails closed -- never the old vacuous ok:true', () => {
      const oneCell = cell('no-skill', 0);
      const { ok, reason, cellResults } = scenarioHardGate([], [oneCell.conditionResult]);
      expect(ok).toBe(false);
      expect(reason).toMatch(/invalid matrix shape/);
      expect(cellResults).toEqual([]);
    });

    it('a non-empty records with conditionResults:[] fails closed -- never throws uncaught', () => {
      const oneCell = cell('no-skill', 0);
      expect(() => scenarioHardGate([oneCell.record], [])).not.toThrow();
      const { ok, reason } = scenarioHardGate([oneCell.record], []);
      expect(ok).toBe(false);
      expect(reason).toMatch(/invalid matrix shape/);
    });

    it('both empty fails closed, never throws', () => {
      expect(() => scenarioHardGate([], [])).not.toThrow();
      const { ok } = scenarioHardGate([], []);
      expect(ok).toBe(false);
    });

    it('mismatched non-zero lengths (e.g. 2 records, 3 conditionResults) fails closed', () => {
      const cells = [cell('current-skill', 0), cell('no-skill', 0)];
      const extra = cell('current-skill', 1);
      const { ok, reason } = scenarioHardGate(cells.map((c) => c.record), [...cells.map((c) => c.conditionResult), extra.conditionResult]);
      expect(ok).toBe(false);
      expect(reason).toMatch(/invalid matrix shape/);
    });

    it('non-array inputs fail closed rather than throwing', () => {
      expect(() => scenarioHardGate(null, undefined)).not.toThrow();
      const { ok, reason } = scenarioHardGate(null, undefined);
      expect(ok).toBe(false);
      expect(reason).toMatch(/invalid matrix shape/);
    });
  });

  it('one bad cell blocks the WHOLE batch -- never a partial pass', () => {
    const badCell = cell('no-skill', 1, { hookStats: { everyCallHooked: false, hookAllowCount: 1, hookDenyCount: 0 } });
    const cells = [cell('current-skill', 0), cell('no-skill', 0), cell('current-skill', 1), badCell];
    const { ok, reason } = scenarioHardGate(cells.map((c) => c.record), cells.map((c) => c.conditionResult));
    expect(ok).toBe(false);
    expect(reason).toContain('failed for 1/4 cell(s)');
  });

  it('identifies WHICH cell failed (repetition + condition), not just an aggregate boolean', () => {
    const badCell = cell('no-skill', 1, { hookStats: { everyCallHooked: false, hookAllowCount: 1, hookDenyCount: 0 } });
    const cells = [cell('current-skill', 0), cell('no-skill', 0), cell('current-skill', 1), badCell];
    const { reason } = scenarioHardGate(cells.map((c) => c.record), cells.map((c) => c.conditionResult));
    expect(reason).toContain('repetition 1');
    expect(reason).toContain('condition no-skill');
  });

  // The load-bearing distinction (decision 4): scenarioHardGate never looks at
  // success/expected_outcome_matched at all -- a "wrong answer" cell with otherwise-clean
  // integrity passes this gate exactly like a "right answer" cell would.
  it('does not inspect scenario outcome at all -- a cell is judged purely on integrity, regardless of any outcome-shaped fields present', () => {
    const wrongAnswerCell = cell('current-skill', 0, {});
    wrongAnswerCell.record.success = { value: false, reason: null };
    wrongAnswerCell.record.expected_outcome_matched = { value: false, reason: null };
    const { ok } = scenarioHardGate([wrongAnswerCell.record], [wrongAnswerCell.conditionResult]);
    expect(ok).toBe(true);
  });

  // Ambient-skill-profile fix (mandatory regression matrix): the real live-run incident and its
  // fix, proven end-to-end through the real cross-cell consensus computation scenarioHardGate
  // itself performs (never hand-passed into scenarioCellIntegrityOk, unlike the isolated unit
  // tests above) -- every cell's own init.skills[] genuinely agrees (mirroring the real incident's
  // shape: the bundled skill is present identically regardless of --plugin-dir), and the
  // CONFIRMED use is proven to be tolerated regardless of which arm(s) it appears in.
  describe('ambient-skill-profile mandatory regression matrix (real cross-cell consensus, not hand-passed)', () => {
    function confirmedBundledSkillCell(condition, repetitionIndex, skillArg, ambientSkills) {
      const base = cell(condition, repetitionIndex, {
        init: {
          plugins: condition === 'current-skill' ? KMP_TEST_RUNNER_PLUGIN : [],
          skills: ambientSkills,
          tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk',
        },
        events: [
          initEventStub(),
          { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id: 's1', input: { skill: skillArg } }] } },
          { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', is_error: false, content: 'real bundled skill output' }] } },
          resultEventStub(),
        ],
      });
      return base;
    }

    // Ambient skills present identically regardless of --plugin-dir (the real incident's shape):
    // no-skill shows just the bundled skill; current-skill shows it PLUS the target's own
    // namespaced identity, which strips to the identical set once computeAmbientSkillProfile
    // removes it.
    const AMBIENT_NO_SKILL = ['run'];
    const AMBIENT_CURRENT_SKILL = ['run', 'kmp-test-runner:kmp-test-runner'];

    it('shared bundled skill, confirmed ONLY in no-skill: accepted', () => {
      const cells = [
        cell('current-skill', 0, { init: { plugins: KMP_TEST_RUNNER_PLUGIN, skills: AMBIENT_CURRENT_SKILL, tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' } }),
        confirmedBundledSkillCell('no-skill', 0, 'run', AMBIENT_NO_SKILL),
        cell('current-skill', 1, { init: { plugins: KMP_TEST_RUNNER_PLUGIN, skills: AMBIENT_CURRENT_SKILL, tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' } }),
        confirmedBundledSkillCell('no-skill', 1, 'run', AMBIENT_NO_SKILL),
      ];
      const { ok, reason } = scenarioHardGate(cells.map((c) => c.record), cells.map((c) => c.conditionResult));
      expect(ok).toBe(true);
      expect(reason).toBeNull();
    });

    it('shared bundled skill, confirmed in CURRENT-SKILL only: accepted', () => {
      const cells = [
        confirmedBundledSkillCell('current-skill', 0, 'run', AMBIENT_CURRENT_SKILL),
        cell('no-skill', 0, { init: { plugins: [], skills: AMBIENT_NO_SKILL, tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' } }),
        confirmedBundledSkillCell('current-skill', 1, 'run', AMBIENT_CURRENT_SKILL),
        cell('no-skill', 1, { init: { plugins: [], skills: AMBIENT_NO_SKILL, tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' } }),
      ];
      const { ok, reason } = scenarioHardGate(cells.map((c) => c.record), cells.map((c) => c.conditionResult));
      expect(ok).toBe(true);
      expect(reason).toBeNull();
    });

    it('shared bundled skill, confirmed in BOTH arms: accepted', () => {
      const cells = [
        confirmedBundledSkillCell('current-skill', 0, 'run', AMBIENT_CURRENT_SKILL),
        confirmedBundledSkillCell('no-skill', 0, 'run', AMBIENT_NO_SKILL),
      ];
      const { ok, reason } = scenarioHardGate(cells.map((c) => c.record), cells.map((c) => c.conditionResult));
      expect(ok).toBe(true);
      expect(reason).toBeNull();
    });

    it('confirmed UNADVERTISED skill (not present in ANY cell\'s ambient profile): rejected', () => {
      const cells = [
        cell('current-skill', 0, { init: { plugins: KMP_TEST_RUNNER_PLUGIN, skills: AMBIENT_CURRENT_SKILL, tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' } }),
        confirmedBundledSkillCell('no-skill', 0, 'totally-unadvertised-skill', AMBIENT_NO_SKILL),
      ];
      const { ok, reason } = scenarioHardGate(cells.map((c) => c.record), cells.map((c) => c.conditionResult));
      expect(ok).toBe(false);
      expect(reason).toContain('skillSelectionOk:false');
    });

    it('ambient profiles differ between repetitions of the SAME condition: rejected -- every cell reports ambientProfileMatrixOk:false', () => {
      const cells = [
        cell('no-skill', 0, { init: { plugins: [], skills: ['run'], tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' } }),
        cell('no-skill', 1, { init: { plugins: [], skills: ['run', 'review'], tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' } }),
      ];
      const { ok, reason } = scenarioHardGate(cells.map((c) => c.record), cells.map((c) => c.conditionResult));
      expect(ok).toBe(false);
      expect(reason).toContain('ambientProfileMatrixOk:false');
      // Genuinely a matrix-wide fact, not attributable to either cell alone -- both cells' own
      // ambientSkillProfileOk (their OWN list is individually well-formed) stays true.
      expect(reason).not.toContain('ambientSkillProfileOk:false');
    });

    it('a malformed init.skills[] on just ONE cell blocks the WHOLE matrix -- that cell shows its OWN ambientSkillProfileOk:false too', () => {
      const cells = [
        cell('no-skill', 0, { init: { plugins: [], skills: ['run'], tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' } }),
        cell('no-skill', 1, { init: { plugins: [], skills: ['run', 'run'], tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' } }), // duplicate entry
      ];
      const { ok, reason } = scenarioHardGate(cells.map((c) => c.record), cells.map((c) => c.conditionResult));
      expect(ok).toBe(false);
      expect(reason).toContain('ambientProfileMatrixOk:false');
      expect(reason).toContain('ambientSkillProfileOk:false');
    });
  });
});

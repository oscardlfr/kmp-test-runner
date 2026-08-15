// tests/vitest/agentic-eval-cell-integrity.test.js
// Direct unit tests for tools/agentic-eval/cell-integrity.mjs -- the canonical per-cell
// harness-integrity evaluation this fix (preserve rejected matrix forensics) extracted so both the
// fail-fast hook (matrix-runner.mjs's runScenarioMatrix loop, cli.mjs's runConditionPair) and the
// final whole-matrix gate (cli.mjs's scenarioCellIntegrityOk/scenarioHardGate) share exactly one
// implementation. Complements (never duplicates) agentic-eval-hard-gates.test.js's own coverage of
// calibrationHardGate/smokeHardGate/scenarioCellIntegrityOk/scenarioHardGate (which exercise this
// module INDIRECTLY, through cli.mjs's own delegation) and agentic-eval-run-command.test.js's real-
// subprocess fail-fast tests (which exercise it end-to-end, including its wiring into
// runScenarioMatrix) -- this file is the one place that calls
// cellTranscriptIntegrityOk/summarizeUnexpectedToolUses/evaluateNamedChecks/isPluginBoundToSnapshot
// directly, with precise synthetic inputs, mirroring agentic-eval-hard-gates.test.js's own
// established fixture-construction convention.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXPECTED_TOOL_NAMES, isPluginBoundToSnapshot, evaluateNamedChecks,
  summarizeUnexpectedToolUses, cellTranscriptIntegrityOk,
} from '../../tools/agentic-eval/cell-integrity.mjs';

const TARGET_PLUGIN_NAME = 'kmp-test-runner';
const TARGET_SKILL_NAME = 'kmp-test-runner';

function bashToolUseEvent(id, command) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] } };
}
function toolResultEvent(id, isError = false) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: isError ? 'error' : 'ok', is_error: isError, tool_use_id: id }] } };
}
function skillToolUseEvent(id, skillArg) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id, input: { skill: skillArg } }] } };
}
function readToolUseEvent(id) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id, input: { file_path: '/fake/unexpected.txt' } }] } };
}
function initEventStub() {
  return { type: 'system', subtype: 'init' };
}
function resultEventStub() {
  return { type: 'result', subtype: 'success' };
}

// isPluginBoundToSnapshot compares by filesystem IDENTITY (dev+ino) -- both sides must exist as a
// real path on disk, so a hardcoded placeholder string can never satisfy it. Mirrors
// agentic-eval-hard-gates.test.js's own identical FAKE_SNAPSHOT_DIR/WRONG_SNAPSHOT_DIR convention.
const FAKE_SNAPSHOT_DIR = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-cell-integrity-snapshot-'));
const WRONG_SNAPSHOT_DIR = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-cell-integrity-wrong-snapshot-'));
afterAll(() => {
  rmSync(FAKE_SNAPSHOT_DIR, { recursive: true, force: true });
  rmSync(WRONG_SNAPSHOT_DIR, { recursive: true, force: true });
});

const KMP_TEST_RUNNER_PLUGIN = [{ name: 'kmp-test-runner', path: FAKE_SNAPSHOT_DIR, source: 'fake' }];

function cleanConditionResult(condition, overrides = {}) {
  const isCurrentSkill = condition === 'current-skill';
  return {
    condition,
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
    invocation: null,
    ...overrides,
  };
}

describe('evaluateNamedChecks', () => {
  it('ok:true, reason:null, failedChecks:[] when every check passes', () => {
    const result = evaluateNamedChecks([['a', true], ['b', true]]);
    expect(result).toEqual({ ok: true, reason: null, failedChecks: [] });
  });

  it('reports every failed check by name, in original order, in both reason and failedChecks', () => {
    const result = evaluateNamedChecks([['a', true], ['b', false], ['c', false]]);
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(['b', 'c']);
    expect(result.reason).toBe('a:true b:false c:false');
  });
});

describe('isPluginBoundToSnapshot', () => {
  it('true when the reported path and the expected snapshot dir are the SAME real directory', () => {
    const init = { plugins: [{ name: 'kmp-test-runner', path: FAKE_SNAPSHOT_DIR }] };
    expect(isPluginBoundToSnapshot(init, FAKE_SNAPSHOT_DIR)).toBe(true);
  });

  it('false when the reported path is a DIFFERENT real directory than the expected snapshot', () => {
    const init = { plugins: [{ name: 'kmp-test-runner', path: WRONG_SNAPSHOT_DIR }] };
    expect(isPluginBoundToSnapshot(init, FAKE_SNAPSHOT_DIR)).toBe(false);
  });

  it('false (fail closed) when the reported path does not exist on disk', () => {
    const init = { plugins: [{ name: 'kmp-test-runner', path: '/definitely/does/not/exist' }] };
    expect(isPluginBoundToSnapshot(init, FAKE_SNAPSHOT_DIR)).toBe(false);
  });

  it('false when init has no plugins at all', () => {
    expect(isPluginBoundToSnapshot({ plugins: [] }, FAKE_SNAPSHOT_DIR)).toBe(false);
  });

  it('false when init has more than one plugin', () => {
    const init = { plugins: [{ name: 'kmp-test-runner', path: FAKE_SNAPSHOT_DIR }, { name: 'other', path: FAKE_SNAPSHOT_DIR }] };
    expect(isPluginBoundToSnapshot(init, FAKE_SNAPSHOT_DIR)).toBe(false);
  });

  it('false when initEvent is null', () => {
    expect(isPluginBoundToSnapshot(null, FAKE_SNAPSHOT_DIR)).toBe(false);
  });
});

describe('summarizeUnexpectedToolUses', () => {
  it('ok:true, count:0, tools:[] when no unexpected tool is used', () => {
    const events = [initEventStub(), bashToolUseEvent('t1', 'kmp-test doctor'), toolResultEvent('t1'), resultEventStub()];
    expect(summarizeUnexpectedToolUses(events, EXPECTED_TOOL_NAMES)).toEqual({ ok: true, count: 0, tools: [] });
  });

  it('maps findUnexpectedToolUses\' raw {index, name} output to {name, event_index}, discarding id/receiptNs entirely', () => {
    const events = [initEventStub(), readToolUseEvent('toolu_read1'), toolResultEvent('toolu_read1')];
    const result = summarizeUnexpectedToolUses(events, EXPECTED_TOOL_NAMES);
    expect(result.ok).toBe(false);
    expect(result.count).toBe(1);
    expect(result.tools).toEqual([{ name: 'Read', event_index: 1 }]);
    expect(Object.keys(result.tools[0]).sort()).toEqual(['event_index', 'name']);
  });

  it('counts EVERY unexpected use, preserving order and duplicates -- never deduplicated', () => {
    const events = [
      initEventStub(),
      readToolUseEvent('r1'), toolResultEvent('r1'),
      readToolUseEvent('r2'), toolResultEvent('r2'),
    ];
    const result = summarizeUnexpectedToolUses(events, EXPECTED_TOOL_NAMES);
    expect(result.count).toBe(2);
    expect(result.tools.map((t) => t.event_index)).toEqual([1, 3]);
  });
});

describe('cellTranscriptIntegrityOk', () => {
  it('ok:true for a clean current-skill cell', () => {
    const result = cellTranscriptIntegrityOk(cleanConditionResult('current-skill'), { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.failedChecks).toEqual([]);
    expect(result.unexpectedToolUsesCount).toBe(0);
    expect(result.unexpectedTools).toEqual([]);
  });

  it('ok:true for a clean no-skill cell', () => {
    const result = cellTranscriptIntegrityOk(cleanConditionResult('no-skill'), { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.ok).toBe(true);
  });

  it('exposes all 16 canonical checks by name via checksByName, every one true for a clean cell', () => {
    const result = cellTranscriptIntegrityOk(cleanConditionResult('current-skill'), { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(Object.keys(result.checksByName).sort()).toEqual([
      'ambientSkillProfileOk', 'availabilityOk', 'cleanTranscriptOk', 'foreignSkillToolResultsCompleteOk',
      'hookAccountingOk', 'initOk', 'noPreInferenceFailureOk', 'noSkillSafetyOk', 'noUnexpectedToolsOk', 'pluginProfileOk',
      'pluginSnapshotBindingOk', 'targetSkillAmbientIdentityOk', 'terminationOk', 'toolProfileOk',
      'toolResultsCompleteOk', 'transcriptStructureOk',
    ].sort());
    expect(Object.values(result.checksByName).every((v) => v === true)).toBe(true);
  });

  it('ok:false with noUnexpectedToolsOk + toolProfileOk failing when an unexpected Read tool is invoked, and unexpectedTools/unexpectedToolUsesCount reflect it precisely', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      init: { plugins: KMP_TEST_RUNNER_PLUGIN, skills: ['kmp-test-runner:kmp-test-runner'], tools: ['Bash', 'Skill', 'Read'], mcp_servers: [], permissionMode: 'dontAsk' },
      events: [initEventStub(), bashToolUseEvent('t1', 'kmp-test parallel --json'), toolResultEvent('t1'), readToolUseEvent('t2'), toolResultEvent('t2'), resultEventStub()],
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(expect.arrayContaining(['toolProfileOk', 'noUnexpectedToolsOk']));
    expect(result.unexpectedToolUsesCount).toBe(1);
    expect(result.unexpectedTools).toEqual([{ name: 'Read', event_index: 3 }]);
  });

  it('ok:false when the transcript has a malformed line (cleanTranscriptOk)', () => {
    const conditionResult = cleanConditionResult('current-skill', { malformedLines: ['not valid json'] });
    const result = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('cleanTranscriptOk');
  });

  it('ok:false when a no-skill cell CONFIRMS the target skill (noSkillSafetyOk) -- real evidence contamination', () => {
    const conditionResult = cleanConditionResult('no-skill', {
      events: [initEventStub(), skillToolUseEvent('s1', 'kmp-test-runner'), toolResultEvent('s1'), resultEventStub()],
      invocation: { confirmed: true },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('noSkillSafetyOk');
  });

  // G9 (preserve rejected matrix forensics review): skillSelectionOk needs matrix-wide
  // sharedAmbientNames that don't exist during fail-fast -- deliberately excluded from this
  // function's 15 checks (see its own doc comment). A CONFIRMED but ambient (ubiquitous, bundled)
  // Skill invocation -- e.g. "run", present regardless of --plugin-dir, the exact real regression
  // this proves -- must NEVER cause this function alone to reject a cell; only the final
  // scenarioHardGate (with real cross-cell consensus) decides whether it's tolerated. Reproduces
  // fake-claude-run-shared-bundled-skill-confirmed's own shape directly, rather than only through
  // the full real-subprocess test (agentic-eval-run-command.test.js's identically-motivated
  // describe block) that already covers it end-to-end -- a regression here would silently turn
  // that accepted-matrix test into a fail-fast rejection instead, which is a different, less
  // specific failure signature than a direct unit assertion on this function alone.
  it('ok:true for a cell that confirms an ambient, non-target Skill ("run") -- skillSelectionOk is matrix-wide, never evaluated here', () => {
    const conditionResult = cleanConditionResult('no-skill', {
      events: [initEventStub(), skillToolUseEvent('s1', 'run'), toolResultEvent('s1'), resultEventStub()],
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.ok).toBe(true);
    // foreignSkillUses is still exposed (scenarioCellIntegrityOk's own skillSelectionOk reads it
    // via shared.foreignSkillUses) -- this function computes it, just never gates on it itself.
    expect(result.foreignSkillUses.length).toBe(1);
    expect(result.foreignSkillUses[0].confirmed).toBe(true);
  });

  it('ok:false when init is missing entirely (initOk)', () => {
    const conditionResult = cleanConditionResult('current-skill', { init: null });
    const result = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('initOk');
  });

  it('ok:false when the process was terminated with a genuine error (not a timeout)', () => {
    const conditionResult = cleanConditionResult('current-skill', { spawnResult: { terminated: true, terminationReason: 'error' } });
    const result = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('terminationOk');
  });

  it('a legitimate timeout (terminationOk/toolResultsCompleteOk/transcriptStructureOk all tolerate it, unlike a genuine error)', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      spawnResult: { terminated: true, terminationReason: 'timeout' },
      events: [initEventStub(), bashToolUseEvent('t1', 'kmp-test parallel --json')],
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.failedChecks).not.toContain('terminationOk');
    expect(result.failedChecks).not.toContain('toolResultsCompleteOk');
    expect(result.failedChecks).not.toContain('transcriptStructureOk');
  });

  // noPreInferenceFailureOk -- detects the exact macOS-canary signature (auth broken before the
  // model's first turn): a terminal `result` event with is_error:true, num_turns<=1, every usage
  // counter exactly zero, and zero tool_use of any kind. All 4 conjuncts are required at once
  // (AND, never any single one alone) so a real negative-outcome cell that consumed tokens or used
  // tools is never misclassified -- see the "Case C" tests below.
  const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  function preInferenceFailureResult(overrides = {}) {
    return { subtype: 'error_during_execution', is_error: true, num_turns: 1, usage: { ...ZERO_USAGE }, ...overrides };
  }

  it('ok:false (noPreInferenceFailureOk) for the exact incident signature: is_error:true, num_turns:1, usage all zero, zero tool_use', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      events: [initEventStub(), { type: 'assistant', message: { content: [{ type: 'text', text: 'Not logged in.' }], usage: ZERO_USAGE } }, resultEventStub()],
      result: preInferenceFailureResult(),
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('noPreInferenceFailureOk');
  });

  it('ok:true (noPreInferenceFailureOk) when is_error:false -- a normal success is never flagged', () => {
    const conditionResult = cleanConditionResult('current-skill', { result: { subtype: 'success', is_error: false, num_turns: 1, usage: ZERO_USAGE } });
    const result = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(true);
  });

  it('ok:true (noPreInferenceFailureOk) when conditionResult.result is absent entirely -- never claims a signature without evidence', () => {
    const conditionResult = cleanConditionResult('current-skill'); // no `result` override at all
    const result = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(true);
  });

  // Case C (plan Diseño 3 / Diseño 5): a REAL negative-outcome cell -- is_error:true, but the
  // model genuinely engaged (multiple turns, or spent tokens, or used a tool) -- must never be
  // misclassified as a pre-inference failure. Each test below violates exactly one of the 4
  // conjuncts, proving the AND is load-bearing on every axis independently.
  it('Case C -- ok:true (noPreInferenceFailureOk) when num_turns > 1, even with is_error:true and zero usage/tools', () => {
    const conditionResult = cleanConditionResult('current-skill', { result: preInferenceFailureResult({ num_turns: 3 }) });
    const result = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(true);
  });

  it('Case C -- ok:true (noPreInferenceFailureOk) when num_turns is a negative integer -- the range is 0<=n<=1, never just "<=1"', () => {
    const conditionResult = cleanConditionResult('current-skill', { result: preInferenceFailureResult({ num_turns: -1 }) });
    const result = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(true);
  });

  it('Case C -- ok:true (noPreInferenceFailureOk) when the cell used a real tool, even with is_error:true, num_turns:1, zero usage', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      events: [initEventStub(), bashToolUseEvent('t1', 'kmp-test parallel --json'), toolResultEvent('t1', true), resultEventStub()],
      result: preInferenceFailureResult(),
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(true);
  });

  it('Case C -- ok:true (noPreInferenceFailureOk) when any single usage counter is non-zero, even with is_error:true, num_turns:1, zero tools', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      result: preInferenceFailureResult({ usage: { ...ZERO_USAGE, output_tokens: 5 } }),
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(true);
  });

  // Post-adversarial-review fix: the usage conjunct must fail CLOSED on ambiguity, never open.
  // The only observed incident shape has `usage` present with every counter at an explicit 0 --
  // that is the sole evidence this repo has for the real CLI's error-path JSON. Failing open on a
  // missing/absent counter would silently promote the exact class of cell this check exists to
  // catch, the moment a real failure's JSON happens to omit rather than zero a field.
  // NOTE: cleanConditionResult's own DEFAULT events include a real Bash tool_use (see its
  // definition above) -- every test below must explicitly override events to the same
  // zero-tool-use shape the first noPreInferenceFailureOk test uses, or findAllToolUses' own
  // conjunct would independently rule the signature out regardless of the usage-conjunct fix
  // these tests exist to prove.
  const NO_TOOL_USE_EVENTS = [initEventStub(), { type: 'assistant', message: { content: [{ type: 'text', text: 'Not logged in.' }], usage: ZERO_USAGE } }, resultEventStub()];

  it('ok:false (noPreInferenceFailureOk) when usage is absent entirely, with the other 3 conjuncts holding -- fails closed, never open, on missing data', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      events: NO_TOOL_USE_EVENTS,
      result: preInferenceFailureResult({ usage: undefined }),
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(false);
  });

  it('ok:false (noPreInferenceFailureOk) when usage is present but missing a single counter (e.g. cache_read_input_tokens absent, not zero), with the other 3 conjuncts holding', () => {
    const { cache_read_input_tokens, ...usageMissingOneCounter } = ZERO_USAGE;
    const conditionResult = cleanConditionResult('current-skill', {
      events: NO_TOOL_USE_EVENTS,
      result: preInferenceFailureResult({ usage: usageMissingOneCounter }),
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(false);
  });

  it('ok:true (noPreInferenceFailureOk) when usage is missing a counter AND a DIFFERENT counter is genuinely non-zero -- real engagement still rules it out regardless of the missing field', () => {
    const { cache_read_input_tokens, ...usageMissingOneCounter } = ZERO_USAGE;
    const conditionResult = cleanConditionResult('current-skill', {
      events: NO_TOOL_USE_EVENTS,
      result: preInferenceFailureResult({ usage: { ...usageMissingOneCounter, output_tokens: 5 } }),
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(true);
  });
});

// Claude Code pre-dispatch tool blocks: hookAccountingOk's proof mechanism is now selected by an
// EXPLICIT option rather than inferred from whether the accounting happens to be present, so no
// caller can silently fall back to the weaker aggregate proof by forgetting to wire it through.
describe('cellTranscriptIntegrityOk -- requireDispatchAccounting mode selection', () => {
  const OPTS = { targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME, requireDispatchAccounting: false };

  it('scenario mode: hookAccountingOk follows the dispatch accounting, not everyCallHooked', () => {
    // everyCallHooked:false is exactly the incident's aggregate signature -- the accounting is what
    // decides, and here it says the transcript is fully accounted for.
    const conditionResult = cleanConditionResult('current-skill', {
      hookStats: { everyCallHooked: false, hookAllowCount: 1, hookDenyCount: 0 },
      dispatchAccounting: { everyCallAccountedFor: true },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { ...OPTS, requireDispatchAccounting: true });
    expect(result.checksByName.hookAccountingOk).toBe(true);
  });

  it('scenario mode: still fails on a genuinely unaccounted call', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      hookStats: { everyCallHooked: true, hookAllowCount: 1, hookDenyCount: 0 },
      dispatchAccounting: { everyCallAccountedFor: false },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { ...OPTS, requireDispatchAccounting: true });
    expect(result.checksByName.hookAccountingOk).toBe(false);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['malformed (no everyCallAccountedFor)', {}],
    ['malformed (non-boolean)', { everyCallAccountedFor: 'yes' }],
  ])('scenario mode fails closed when the accounting is %s', (_label, dispatchAccounting) => {
    const conditionResult = cleanConditionResult('current-skill', {
      hookStats: { everyCallHooked: true, hookAllowCount: 1, hookDenyCount: 0 },
      dispatchAccounting,
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { ...OPTS, requireDispatchAccounting: true });
    expect(result.checksByName.hookAccountingOk).toBe(false);
  });

  // Characterization: calibrate/smoke have no per-attempt decision channel at all, so they keep the
  // historical aggregate proof. This must behave exactly as it did before the change.
  it('calibrate/smoke mode: hookAccountingOk still follows everyCallHooked', () => {
    const passing = cleanConditionResult('current-skill', { hookStats: { everyCallHooked: true, hookAllowCount: 1, hookDenyCount: 0 } });
    expect(cellTranscriptIntegrityOk(passing, { ...OPTS, requireDispatchAccounting: false }).checksByName.hookAccountingOk).toBe(true);

    const failing = cleanConditionResult('current-skill', { hookStats: { everyCallHooked: false, hookAllowCount: 1, hookDenyCount: 0 } });
    expect(cellTranscriptIntegrityOk(failing, { ...OPTS, requireDispatchAccounting: false }).checksByName.hookAccountingOk).toBe(false);
  });

  it('calibrate/smoke mode ignores dispatch accounting entirely', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      hookStats: { everyCallHooked: true, hookAllowCount: 1, hookDenyCount: 0 },
      dispatchAccounting: { everyCallAccountedFor: false },
    });
    expect(cellTranscriptIntegrityOk(conditionResult, { ...OPTS, requireDispatchAccounting: false }).checksByName.hookAccountingOk).toBe(true);
  });
});

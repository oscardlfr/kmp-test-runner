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
// cellTranscriptIntegrityOk/summarizeUnexpectedToolUses/evaluateNamedChecks directly, with precise
// synthetic inputs, mirroring agentic-eval-hard-gates.test.js's own established fixture-construction
// convention.
//
// Runtime-adapter migration: fixtures now construct a canonical condition-observation-v1 object
// directly (cleanObservation/cleanConditionResult below) instead of a raw findBashToolUsesWithResults-
// style event array -- cellTranscriptIntegrityOk reads exclusively from conditionResult.observation
// now. isPluginBoundToSnapshot's own dedicated describe block moved to
// agentic-eval-claude-runtime-adapter.test.js (the function itself moved to runtimes/claude-code.mjs
// -- see that file's own header note). No case's outcome changed, only where/how each fixture is
// built.
import { describe, it, expect } from 'vitest';
import {
  evaluateNamedChecks, summarizeUnexpectedToolUses, cellTranscriptIntegrityOk,
  summarizePreInferenceFailure,
} from '../../tools/agentic-eval/cell-integrity.mjs';

function cleanToolAttempt(overrides = {}) {
  return {
    id: 't1', kind: 'shell', runtimeName: 'Bash', eventIndex: 1, receiptNs: 1n, profileAllowed: true,
    command: 'kmp-test parallel --json', skillReference: null, targetsExpectedSkill: null,
    result: { found: true, eventIndex: 2, isError: false, text: 'ok', textStatus: 'text' },
    preDispatchBlock: { recognized: false, signature: null },
    ...overrides,
  };
}

/** A clean, fully-populated condition-observation-v1 object -- one successful Bash call, a
 * result-ABSENT terminal by default (present:false), matching cleanConditionResult's own historical
 * default of not setting a `result` field at all unless a test cares about it. Every top-level key
 * a caller passes in `overrides` REPLACES the default wholesale (shallow merge, matching the
 * contract's own top-level shape) -- callers overriding e.g. `terminal` must supply the complete
 * sub-object, not a partial one. */
function cleanObservation(condition, overrides = {}) {
  const isCurrentSkill = condition === 'current-skill';
  return {
    schema: 1,
    runtime: { id: 'claude-code', protocolVersion: 1 },
    process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 100n },
    session: { initPresent: true, modelResolved: 'claude-sonnet-5', sessionIdObserved: 'sess-1', runtimeVersion: '2.1.212', toolProfileMatchesExpected: true },
    transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    terminal: { present: false, isError: null, turnCount: null, finalText: null, resultSubtype: null, usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
    toolAttempts: [cleanToolAttempt()],
    skill: {
      available: isCurrentSkill, profileMatchesCondition: true, snapshotBindingMatches: isCurrentSkill,
      targetInvocation: null, foreignInvocations: [],
      ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
    },
    hookStats: { hookCallCount: 1, hookResponseCount: 1, hookDenyCount: 0, hookAllowCount: 1, hookPairingOk: true, everyCallHooked: true },
    byteMetrics: { outputBytes: 2, streamJsonBytes: 100 },
    timing: { receiptNsByEventIndex: new Map([[0, 0n], [1, 1n], [2, 2n], [3, 3n]]) },
    ...overrides,
  };
}

/** `observation` (a partial condition-observation-v1, merged onto cleanObservation's defaults) and
 * `dispatchAccounting` are the two override channels cellTranscriptIntegrityOk actually reads;
 * every other top-level key stays a realistic constant no test here varies. */
function cleanConditionResult(condition, { observation: observationOverrides = {}, dispatchAccounting = null, ...rest } = {}) {
  return {
    condition,
    fixtureDir: '/fake-fixture',
    startedAt: new Date(0),
    endedAt: new Date(1),
    evidenceDir: null,
    cellOrdinal: 0,
    didSpawn: true,
    junitAttribution: null,
    dispatchAccounting,
    observation: cleanObservation(condition, observationOverrides),
    ...rest,
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

describe('summarizeUnexpectedToolUses', () => {
  it('ok:true, count:0, tools:[] when no unexpected tool is used', () => {
    const toolAttempts = [{ profileAllowed: true, runtimeName: 'Bash', eventIndex: 1 }];
    expect(summarizeUnexpectedToolUses(toolAttempts)).toEqual({ ok: true, count: 0, tools: [] });
  });

  it('maps an unexpected attempt to {name, event_index}, reading profileAllowed/runtimeName/eventIndex only', () => {
    const toolAttempts = [{ profileAllowed: false, runtimeName: 'Read', eventIndex: 1 }];
    const result = summarizeUnexpectedToolUses(toolAttempts);
    expect(result.ok).toBe(false);
    expect(result.count).toBe(1);
    expect(result.tools).toEqual([{ name: 'Read', event_index: 1 }]);
    expect(Object.keys(result.tools[0]).sort()).toEqual(['event_index', 'name']);
  });

  it('counts EVERY unexpected use, preserving order and duplicates -- never deduplicated', () => {
    const toolAttempts = [
      { profileAllowed: false, runtimeName: 'Read', eventIndex: 1 },
      { profileAllowed: true, runtimeName: 'Bash', eventIndex: 2 },
      { profileAllowed: false, runtimeName: 'Read', eventIndex: 3 },
    ];
    const result = summarizeUnexpectedToolUses(toolAttempts);
    expect(result.count).toBe(2);
    expect(result.tools.map((t) => t.event_index)).toEqual([1, 3]);
  });
});

describe('cellTranscriptIntegrityOk', () => {
  it('ok:true for a clean current-skill cell', () => {
    const result = cellTranscriptIntegrityOk(cleanConditionResult('current-skill'), { requireDispatchAccounting: false });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.failedChecks).toEqual([]);
    expect(result.unexpectedToolUsesCount).toBe(0);
    expect(result.unexpectedTools).toEqual([]);
  });

  it('ok:true for a clean no-skill cell', () => {
    const result = cellTranscriptIntegrityOk(cleanConditionResult('no-skill'), { requireDispatchAccounting: false });
    expect(result.ok).toBe(true);
  });

  it('exposes all 16 canonical checks by name via checksByName, every one true for a clean cell', () => {
    const result = cellTranscriptIntegrityOk(cleanConditionResult('current-skill'), { requireDispatchAccounting: false });
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
      observation: {
        session: { initPresent: true, modelResolved: 'claude-sonnet-5', sessionIdObserved: 'sess-1', runtimeVersion: '2.1.212', toolProfileMatchesExpected: false },
        toolAttempts: [
          cleanToolAttempt(),
          cleanToolAttempt({ id: 't2', kind: 'other', runtimeName: 'Read', eventIndex: 3, receiptNs: 3n, profileAllowed: false, command: null, result: { found: true, eventIndex: 4, isError: false, text: 'ok', textStatus: 'text' } }),
        ],
      },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toEqual(expect.arrayContaining(['toolProfileOk', 'noUnexpectedToolsOk']));
    expect(result.unexpectedToolUsesCount).toBe(1);
    expect(result.unexpectedTools).toEqual([{ name: 'Read', event_index: 3 }]);
  });

  it('ok:false when the transcript has a malformed line (cleanTranscriptOk)', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      observation: { transcript: { malformedLineCount: 1, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] } },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('cleanTranscriptOk');
  });

  it('ok:false when a no-skill cell CONFIRMS the target skill (noSkillSafetyOk) -- real evidence contamination', () => {
    const conditionResult = cleanConditionResult('no-skill', {
      observation: {
        skill: {
          available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
          targetInvocation: { attempted: true, confirmed: true, attemptCount: 1, eventIndex: 1, receiptNs: 1n, resultIsError: false },
          foreignInvocations: [], ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        },
      },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('noSkillSafetyOk');
  });

  // G9 (preserve rejected matrix forensics review): skillSelectionOk needs matrix-wide
  // sharedAmbientNames that don't exist during fail-fast -- deliberately excluded from this
  // function's 16 checks (see its own doc comment). A CONFIRMED but ambient (ubiquitous, bundled)
  // Skill invocation -- e.g. "run", present regardless of --plugin-dir, the exact real regression
  // this proves -- must NEVER cause this function alone to reject a cell; only the final
  // scenarioHardGate (with real cross-cell consensus) decides whether it's tolerated.
  it('ok:true for a cell that confirms an ambient, non-target Skill ("run") -- skillSelectionOk is matrix-wide, never evaluated here', () => {
    const conditionResult = cleanConditionResult('no-skill', {
      observation: {
        skill: {
          available: false, profileMatchesCondition: true, snapshotBindingMatches: false, targetInvocation: null,
          foreignInvocations: [{ eventIndex: 1, receiptNs: 1n, id: 's1', skillReference: 'run', resultIsError: false, confirmed: true }],
          ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        },
      },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false });
    expect(result.ok).toBe(true);
    // foreignSkillUses is still exposed (scenarioCellIntegrityOk's own skillSelectionOk reads it
    // via shared.foreignSkillUses) -- this function computes it, just never gates on it itself.
    expect(result.foreignSkillUses.length).toBe(1);
    expect(result.foreignSkillUses[0].confirmed).toBe(true);
  });

  it('ok:false when init is missing entirely (initOk)', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      observation: { session: { initPresent: false, modelResolved: null, sessionIdObserved: null, runtimeVersion: null, toolProfileMatchesExpected: false } },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('initOk');
  });

  it('ok:false when the process was terminated with a genuine error (not a timeout)', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      observation: { process: { exitCode: 1, terminated: true, terminationReason: 'error', spawnHrtimeNs: 0n, endedHrtimeNs: 100n } },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('terminationOk');
  });

  it('a legitimate timeout (terminationOk/toolResultsCompleteOk/transcriptStructureOk all tolerate it, unlike a genuine error)', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      observation: {
        process: { exitCode: null, terminated: true, terminationReason: 'timeout', spawnHrtimeNs: 0n, endedHrtimeNs: 100n },
        // strict fields still show the real dangling call; effective fields tolerate exactly this
        // one legitimate-timeout shape (the adapter's own timeout-tolerant derivation).
        transcript: {
          malformedLineCount: 0,
          strictStructuralIssues: [{ type: 'result_count', count: 0 }],
          effectiveStructuralIssues: [],
          strictIncompleteToolResults: [{ index: 1, receiptNs: 1n, name: 'Bash', id: 't1' }],
          effectiveIncompleteToolResults: [],
        },
        toolAttempts: [cleanToolAttempt({ result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' } })],
      },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false });
    expect(result.failedChecks).not.toContain('terminationOk');
    expect(result.failedChecks).not.toContain('toolResultsCompleteOk');
    expect(result.failedChecks).not.toContain('transcriptStructureOk');
  });

  // noPreInferenceFailureOk -- detects the exact macOS-canary signature (auth broken before the
  // model's first turn): a terminal with isError:true, turnCount<=1, every usage counter exactly
  // zero, and zero tool attempts of any kind. All 4 conjuncts are required at once (AND, never any
  // single one alone) so a real negative-outcome cell that consumed tokens or used tools is never
  // misclassified -- see the "Case C" tests below.
  const ZERO_USAGE = { input: 0, cached_input: 0, cache_write: 0, output: 0, reasoning_output: null };
  function preInferenceFailureTerminal(overrides = {}) {
    return { present: true, isError: true, turnCount: 1, finalText: null, resultSubtype: 'error_during_execution', usage: { ...ZERO_USAGE }, ...overrides };
  }

  it('ok:false (noPreInferenceFailureOk) for the exact incident signature: isError:true, turnCount:1, usage all zero, zero tool attempts', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      observation: { terminal: preInferenceFailureTerminal(), toolAttempts: [] },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain('noPreInferenceFailureOk');
    expect(summarizePreInferenceFailure(conditionResult.observation)).toMatchObject({
      schema: 2,
      signature_matched: true,
      cause_code: 'pre_inference_terminal_error_zero_usage_zero_tools',
    });
  });

  it('ok:true (noPreInferenceFailureOk) when isError:false -- a normal success is never flagged', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      observation: { terminal: { present: true, isError: false, turnCount: 1, finalText: 'ok', resultSubtype: 'success', usage: { ...ZERO_USAGE } } },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(true);
    expect(summarizePreInferenceFailure(conditionResult.observation).cause_code).toBe('not_matched');
  });

  it('ok:true (noPreInferenceFailureOk) when the terminal is absent entirely -- never claims a signature without evidence', () => {
    const conditionResult = cleanConditionResult('current-skill'); // terminal.present:false by default
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(true);
  });

  // Case C (plan Diseño 3 / Diseño 5): a REAL negative-outcome cell -- isError:true, but the model
  // genuinely engaged (multiple turns, or spent tokens, or used a tool) -- must never be
  // misclassified as a pre-inference failure. Each test below violates exactly one of the 4
  // conjuncts, proving the AND is load-bearing on every axis independently.
  it('Case C -- ok:true (noPreInferenceFailureOk) when turnCount > 1, even with isError:true and zero usage/tools', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      observation: { terminal: preInferenceFailureTerminal({ turnCount: 3 }), toolAttempts: [] },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(true);
  });

  it('Case C -- ok:true (noPreInferenceFailureOk) when turnCount is a negative integer -- the range is 0<=n<=1, never just "<=1"', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      observation: { terminal: preInferenceFailureTerminal({ turnCount: -1 }), toolAttempts: [] },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(true);
  });

  it('Case C -- ok:true (noPreInferenceFailureOk) when the cell used a real tool, even with isError:true, turnCount:1, zero usage', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      observation: {
        terminal: preInferenceFailureTerminal(),
        toolAttempts: [cleanToolAttempt({ result: { found: true, eventIndex: 2, isError: true, text: 'error', textStatus: 'text' } })],
      },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(true);
  });

  it('Case C -- ok:true (noPreInferenceFailureOk) when any single usage counter is non-zero, even with isError:true, turnCount:1, zero tools', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      observation: { terminal: preInferenceFailureTerminal({ usage: { ...ZERO_USAGE, output: 5 } }), toolAttempts: [] },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(true);
  });

  // Post-adversarial-review fix: the usage conjunct must fail CLOSED on ambiguity, never open. The
  // only observed incident shape has `usage` present with every counter at an explicit 0 -- that is
  // the sole evidence this repo has for the real runtime's error-path JSON. Failing open on a
  // null/missing counter would silently promote the exact class of cell this check exists to catch,
  // the moment a real failure's JSON happens to omit rather than zero a field.
  it('ok:false (noPreInferenceFailureOk) when every usage counter is null, with the other 3 conjuncts holding -- fails closed, never open, on missing data', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      observation: { terminal: preInferenceFailureTerminal({ usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } }), toolAttempts: [] },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(false);
  });

  it('ok:false (noPreInferenceFailureOk) when usage is missing a single counter (null, not zero), with the other 3 conjuncts holding', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      observation: { terminal: preInferenceFailureTerminal({ usage: { ...ZERO_USAGE, cached_input: null } }), toolAttempts: [] },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(false);
  });

  it('ok:true (noPreInferenceFailureOk) when usage is missing a counter AND a DIFFERENT counter is genuinely non-zero -- real engagement still rules it out regardless of the missing field', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      observation: { terminal: preInferenceFailureTerminal({ usage: { ...ZERO_USAGE, cached_input: null, output: 5 } }), toolAttempts: [] },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false });
    expect(result.checksByName.noPreInferenceFailureOk).toBe(true);
  });
});

// Claude Code pre-dispatch tool blocks: hookAccountingOk's proof mechanism is now selected by an
// EXPLICIT option rather than inferred from whether the accounting happens to be present, so no
// caller can silently fall back to the weaker aggregate proof by forgetting to wire it through.
describe('cellTranscriptIntegrityOk -- requireDispatchAccounting mode selection', () => {
  function hookStats(overrides = {}) {
    return { hookCallCount: 1, hookResponseCount: 1, hookDenyCount: 0, hookAllowCount: 1, hookPairingOk: true, everyCallHooked: true, ...overrides };
  }

  it('scenario mode: hookAccountingOk follows the dispatch accounting, not everyCallHooked', () => {
    // everyCallHooked:false is exactly the incident's aggregate signature -- the accounting is what
    // decides, and here it says the transcript is fully accounted for.
    const conditionResult = cleanConditionResult('current-skill', {
      observation: { hookStats: hookStats({ everyCallHooked: false }) },
      dispatchAccounting: { everyCallAccountedFor: true },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: true });
    expect(result.checksByName.hookAccountingOk).toBe(true);
  });

  it('scenario mode: still fails on a genuinely unaccounted call', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      observation: { hookStats: hookStats() },
      dispatchAccounting: { everyCallAccountedFor: false },
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: true });
    expect(result.checksByName.hookAccountingOk).toBe(false);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['malformed (no everyCallAccountedFor)', {}],
    ['malformed (non-boolean)', { everyCallAccountedFor: 'yes' }],
  ])('scenario mode fails closed when the accounting is %s', (_label, dispatchAccounting) => {
    const conditionResult = cleanConditionResult('current-skill', {
      observation: { hookStats: hookStats() },
      dispatchAccounting,
    });
    const result = cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: true });
    expect(result.checksByName.hookAccountingOk).toBe(false);
  });

  // Characterization: calibrate/smoke have no per-attempt decision channel at all, so they keep the
  // historical aggregate proof. This must behave exactly as it did before the change.
  it('calibrate/smoke mode: hookAccountingOk still follows everyCallHooked', () => {
    const passing = cleanConditionResult('current-skill', { observation: { hookStats: hookStats({ everyCallHooked: true }) } });
    expect(cellTranscriptIntegrityOk(passing, { requireDispatchAccounting: false }).checksByName.hookAccountingOk).toBe(true);

    const failing = cleanConditionResult('current-skill', { observation: { hookStats: hookStats({ everyCallHooked: false }) } });
    expect(cellTranscriptIntegrityOk(failing, { requireDispatchAccounting: false }).checksByName.hookAccountingOk).toBe(false);
  });

  it('calibrate/smoke mode ignores dispatch accounting entirely', () => {
    const conditionResult = cleanConditionResult('current-skill', {
      observation: { hookStats: hookStats({ everyCallHooked: true }) },
      dispatchAccounting: { everyCallAccountedFor: false },
    });
    expect(cellTranscriptIntegrityOk(conditionResult, { requireDispatchAccounting: false }).checksByName.hookAccountingOk).toBe(true);
  });
});

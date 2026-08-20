// tests/vitest/agentic-eval-runtime-contract.test.js
// Unit tests for tools/agentic-eval/runtimes/contract.mjs -- the runtime-agnostic adapter
// contract validator and the generic helpers core consumers (cli.mjs, matrix-runner.mjs,
// cell-integrity.mjs, graders.mjs, accepted-run-audit.mjs, junit-evidence.mjs) use instead of
// reaching into a provider's own wire format. Exercised entirely against synthetic data --
// this file never imports runtimes/claude-code.mjs. The one exception is a dynamic import of
// stream-parser.mjs, scoped to a single describe block near the end of this file, solely to prove
// contract.mjs's own canonicalNamesKey/fingerprintNames stay byte-for-byte equivalent to
// stream-parser.mjs's analogous (frozen, unmodifiable) functions -- see that block's own comment.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADAPTER_KEYS,
  CAPABILITY_KEYS,
  USAGE_DIMENSIONS,
  OBSERVATION_KEYS,
  TOOL_ATTEMPT_KEYS,
  validateRuntimeAdapter,
  defineRuntimeAdapter,
  validateObservation,
  freezeObservation,
  selectShellAttempts,
  msSinceOrigin,
  canonicalNamesKey,
  fingerprintNames,
} from '../../tools/agentic-eval/runtimes/contract.mjs';

function noop() {}
async function asyncNoop() {}

function validCapabilities(overrides = {}) {
  return {
    observationSources: ['source-a', 'source-b'],
    structuredTranscript: true,
    correlatedToolResults: true,
    skillDeliveryModes: ['mode-a'],
    skillStateEvidence: true,
    usageDimensions: ['input', 'output'],
    softPermissionDenial: true,
    ...overrides,
  };
}

function validAdapter(overrides = {}) {
  return {
    id: 'synthetic-runtime',
    protocolVersion: 1,
    capabilities: validCapabilities(),
    // P1 architectural review (Codex round 2): a synthetic test adapter is a permissive stand-in
    // -- it supports whatever configuration it's asked about, matching the previous (implicit)
    // behavior before these 2 gating methods existed, so no OTHER test in this file needs to know
    // or care about them.
    supportsModelConfiguration: () => true,
    supportsExecutionProfile: () => true,
    probeInstallation: asyncNoop,
    preflight: asyncNoop,
    prepareIsolatedHome: asyncNoop,
    prepareSkillDelivery: noop,
    buildInvocation: noop,
    collectObservationSources: asyncNoop,
    normalizeObservations: noop,
    redactRuntimeDiagnostics: noop,
    ...overrides,
  };
}

function validToolAttempt(overrides = {}) {
  return {
    id: 'attempt-1',
    kind: 'shell',
    runtimeName: 'Bash',
    eventIndex: 3,
    receiptNs: 100n,
    profileAllowed: true,
    command: 'echo hi',
    skillReference: null,
    targetsExpectedSkill: null,
    result: { found: true, eventIndex: 4, isError: false, text: 'ok', textStatus: 'text' },
    preDispatchBlock: { recognized: false, signature: null },
    ...overrides,
  };
}

function validObservation(overrides = {}) {
  return {
    schema: 1,
    runtime: { id: 'synthetic-runtime', protocolVersion: 1 },
    process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 500n },
    session: { initPresent: true, modelResolved: 'synthetic-model', sessionIdObserved: 'sess-synthetic-0001', runtimeVersion: '9.9.9', toolProfileMatchesExpected: true },
    transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    terminal: { present: true, isError: false, turnCount: 2, finalText: 'done', resultSubtype: 'success', usage: { input: 1, cached_input: 2, cache_write: 3, output: 4, reasoning_output: null } },
    toolAttempts: [validToolAttempt()],
    skill: { available: true, profileMatchesCondition: true, snapshotBindingMatches: true, targetInvocation: null, foreignInvocations: [], ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true } },
    hookStats: { hookCallCount: 1, hookResponseCount: 1, hookDenyCount: 0, hookAllowCount: 1, hookPairingOk: true, everyCallHooked: true },
    byteMetrics: { outputBytes: 10, streamJsonBytes: 100 },
    // Key 3, not 4 -- must match validToolAttempt()'s own eventIndex:3/receiptNs:100n (the tool_use
    // event's own index), not its nested result.eventIndex:4 (a different event). Round-3 fix: this
    // was silently 4 before, a latent fixture inconsistency the new cross-field
    // toolAttempts<->timing.receiptNsByEventIndex check now correctly catches.
    timing: { receiptNsByEventIndex: new Map([[3, 100n]]) },
    ...overrides,
  };
}

describe('ADAPTER_KEYS / CAPABILITY_KEYS -- exact literal inventories', () => {
  // P1 architectural review (Codex round 2): supportsModelConfiguration/supportsExecutionProfile
  // are 2 new REQUIRED keys -- the registry accepted treatments an adapter never actually applies
  // (buildInvocation only ever receives {prompt, model, settingsPath}), so an adapter must now
  // declare, per model/execution-profile entry, whether it genuinely implements that entry's own
  // configuration before registries.mjs/resolveSelection will ever select it.
  it('is exactly these 13 keys, in this order', () => {
    expect([...ADAPTER_KEYS]).toEqual([
      'id', 'protocolVersion', 'capabilities', 'supportsModelConfiguration', 'supportsExecutionProfile',
      'probeInstallation', 'preflight', 'prepareIsolatedHome', 'prepareSkillDelivery', 'buildInvocation',
      'collectObservationSources', 'normalizeObservations', 'redactRuntimeDiagnostics',
    ]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ADAPTER_KEYS)).toBe(true);
  });

  it('is exactly these 7 capability keys, in this order', () => {
    expect([...CAPABILITY_KEYS]).toEqual([
      'observationSources', 'structuredTranscript', 'correlatedToolResults',
      'skillDeliveryModes', 'skillStateEvidence', 'usageDimensions', 'softPermissionDenial',
    ]);
  });

  it('USAGE_DIMENSIONS is the closed, ordered universe', () => {
    expect([...USAGE_DIMENSIONS]).toEqual(['input', 'cached_input', 'cache_write', 'output', 'reasoning_output']);
  });
});

describe('validateRuntimeAdapter -- accepts a well-formed synthetic adapter', () => {
  it('a fully-populated adapter validates clean', () => {
    const result = validateRuntimeAdapter(validAdapter());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe('validateRuntimeAdapter -- rejections', () => {
  it('rejects a missing required key', () => {
    const adapter = validAdapter();
    delete adapter.preflight;
    const result = validateRuntimeAdapter(adapter);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'preflight')).toBe(true);
  });

  it('rejects each of the 13 required keys individually when missing', () => {
    for (const key of ADAPTER_KEYS) {
      const adapter = validAdapter();
      delete adapter[key];
      const result = validateRuntimeAdapter(adapter);
      expect(result.ok, `expected missing "${key}" to fail`).toBe(false);
      expect(result.errors.some((e) => e.field === key)).toBe(true);
    }
  });

  it('rejects an unknown extra top-level key', () => {
    const adapter = validAdapter({ someExtraField: 'nope' });
    const result = validateRuntimeAdapter(adapter);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'someExtraField')).toBe(true);
  });

  it('rejects id that is empty or not a string', () => {
    expect(validateRuntimeAdapter(validAdapter({ id: '' })).ok).toBe(false);
    expect(validateRuntimeAdapter(validAdapter({ id: 42 })).ok).toBe(false);
    expect(validateRuntimeAdapter(validAdapter({ id: null })).ok).toBe(false);
  });

  it('rejects a non-positive or non-integer protocolVersion', () => {
    expect(validateRuntimeAdapter(validAdapter({ protocolVersion: 0 })).ok).toBe(false);
    expect(validateRuntimeAdapter(validAdapter({ protocolVersion: -1 })).ok).toBe(false);
    expect(validateRuntimeAdapter(validAdapter({ protocolVersion: 1.5 })).ok).toBe(false);
    expect(validateRuntimeAdapter(validAdapter({ protocolVersion: '1' })).ok).toBe(false);
  });

  it('accepts any positive integer protocolVersion, not just 1', () => {
    expect(validateRuntimeAdapter(validAdapter({ protocolVersion: 7 })).ok).toBe(true);
  });

  for (const method of ['supportsModelConfiguration', 'supportsExecutionProfile', 'probeInstallation', 'preflight', 'prepareIsolatedHome', 'prepareSkillDelivery', 'buildInvocation', 'collectObservationSources', 'normalizeObservations', 'redactRuntimeDiagnostics']) {
    it(`rejects a non-function value for the "${method}" operation`, () => {
      const result = validateRuntimeAdapter(validAdapter({ [method]: 'not-a-function' }));
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.field === method)).toBe(true);
    });
  }

  it('rejects capabilities missing a required key', () => {
    const caps = validCapabilities();
    delete caps.softPermissionDenial;
    const result = validateRuntimeAdapter(validAdapter({ capabilities: caps }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field.includes('softPermissionDenial'))).toBe(true);
  });

  it('rejects capabilities with an unknown extra key', () => {
    const caps = { ...validCapabilities(), unknownCapability: true };
    const result = validateRuntimeAdapter(validAdapter({ capabilities: caps }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field.includes('unknownCapability'))).toBe(true);
  });

  it('rejects an empty observationSources array', () => {
    const result = validateRuntimeAdapter(validAdapter({ capabilities: validCapabilities({ observationSources: [] }) }));
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate values within observationSources', () => {
    const result = validateRuntimeAdapter(validAdapter({ capabilities: validCapabilities({ observationSources: ['a', 'a'] }) }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'capabilities.observationSources')).toBe(true);
  });

  it('rejects duplicate values within skillDeliveryModes', () => {
    const result = validateRuntimeAdapter(validAdapter({ capabilities: validCapabilities({ skillDeliveryModes: ['mode-a', 'mode-a'] }) }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'capabilities.skillDeliveryModes')).toBe(true);
  });

  it('rejects a non-empty-string entry inside observationSources/skillDeliveryModes', () => {
    expect(validateRuntimeAdapter(validAdapter({ capabilities: validCapabilities({ observationSources: [''] }) })).ok).toBe(false);
    expect(validateRuntimeAdapter(validAdapter({ capabilities: validCapabilities({ observationSources: [42] }) })).ok).toBe(false);
    expect(validateRuntimeAdapter(validAdapter({ capabilities: validCapabilities({ skillDeliveryModes: [null] }) })).ok).toBe(false);
  });

  it('rejects a non-boolean for structuredTranscript/correlatedToolResults/skillStateEvidence/softPermissionDenial', () => {
    for (const field of ['structuredTranscript', 'correlatedToolResults', 'skillStateEvidence', 'softPermissionDenial']) {
      const result = validateRuntimeAdapter(validAdapter({ capabilities: validCapabilities({ [field]: 'yes' }) }));
      expect(result.ok, `expected non-boolean ${field} to fail`).toBe(false);
    }
  });

  it('rejects an unknown usage dimension', () => {
    const result = validateRuntimeAdapter(validAdapter({ capabilities: validCapabilities({ usageDimensions: ['input', 'made_up_dimension'] }) }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'capabilities.usageDimensions')).toBe(true);
  });

  it('rejects a duplicate usage dimension', () => {
    const result = validateRuntimeAdapter(validAdapter({ capabilities: validCapabilities({ usageDimensions: ['input', 'input'] }) }));
    expect(result.ok).toBe(false);
  });

  it('rejects usageDimensions out of the USAGE_DIMENSIONS canonical order', () => {
    const result = validateRuntimeAdapter(validAdapter({ capabilities: validCapabilities({ usageDimensions: ['output', 'input'] }) }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'capabilities.usageDimensions')).toBe(true);
  });

  it('accepts an empty usageDimensions array (a runtime that reports no usage at all)', () => {
    const result = validateRuntimeAdapter(validAdapter({ capabilities: validCapabilities({ usageDimensions: [] }) }));
    expect(result.ok).toBe(true);
  });

  it('accepts the full 5-dimension set in canonical order', () => {
    const result = validateRuntimeAdapter(validAdapter({ capabilities: validCapabilities({ usageDimensions: [...USAGE_DIMENSIONS] }) }));
    expect(result.ok).toBe(true);
  });

  it('never includes adapter/env/path/content values in error entries -- codes and field names only', () => {
    const adapter = validAdapter({ id: 'C:\\Users\\secret\\path' });
    delete adapter.preflight;
    const result = validateRuntimeAdapter(adapter);
    const serialized = JSON.stringify(result.errors);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('C:\\Users');
    for (const err of result.errors) {
      expect(typeof err.code).toBe('string');
      expect(err.code.length).toBeGreaterThan(0);
    }
  });
});

describe('defineRuntimeAdapter -- validate + freeze', () => {
  it('returns the adapter, deeply frozen, for a valid input', () => {
    const adapter = defineRuntimeAdapter(validAdapter());
    expect(Object.isFrozen(adapter)).toBe(true);
    expect(Object.isFrozen(adapter.capabilities)).toBe(true);
    expect(Object.isFrozen(adapter.capabilities.observationSources)).toBe(true);
    expect(Object.isFrozen(adapter.capabilities.skillDeliveryModes)).toBe(true);
    expect(Object.isFrozen(adapter.capabilities.usageDimensions)).toBe(true);
  });

  it('throws on an invalid adapter, and the thrown message carries no raw adapter content', () => {
    const adapter = validAdapter({ id: '' });
    let thrown = null;
    try {
      defineRuntimeAdapter(adapter);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.message).not.toContain('probeInstallation');
    expect(typeof thrown.message).toBe('string');
  });

  it('mutating a returned frozen adapter is a no-op (strict-mode throw not required, but the value must not change)', () => {
    const adapter = defineRuntimeAdapter(validAdapter());
    try { adapter.id = 'mutated'; } catch { /* strict mode may throw -- either way, value must not change */ }
    expect(adapter.id).toBe('synthetic-runtime');
  });
});

describe('validateObservation -- accepts a well-formed synthetic observation', () => {
  it('a fully-populated observation validates clean', () => {
    const result = validateObservation(validObservation());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe('validateObservation -- top-level shape', () => {
  it('rejects each of the 11 required top-level keys individually when missing', () => {
    for (const key of OBSERVATION_KEYS) {
      const observation = validObservation();
      delete observation[key];
      const result = validateObservation(observation);
      expect(result.ok, `expected missing top-level "${key}" to fail`).toBe(false);
    }
  });

  it('rejects an unknown extra top-level key', () => {
    const result = validateObservation(validObservation({ extraTopLevelField: 1 }));
    expect(result.ok).toBe(false);
  });

  it('rejects schema values other than the literal 1', () => {
    expect(validateObservation(validObservation({ schema: 2 })).ok).toBe(false);
    expect(validateObservation(validObservation({ schema: '1' })).ok).toBe(false);
  });
});

describe('validateObservation -- rejects legacy/provider-native containers anywhere', () => {
  const legacyTopLevel = ['events', 'init', 'result', 'malformedLines', 'invocation', 'bashResults', 'spawnResult'];
  for (const key of legacyTopLevel) {
    it(`rejects a legacy top-level container key "${key}"`, () => {
      const result = validateObservation(validObservation({ [key]: [] }));
      expect(result.ok).toBe(false);
    });
  }

  const providerNativeKeys = ['message', 'tool_use_result', 'is_error', 'num_turns', 'permissionMode', 'mcp_servers', 'hook_id', 'rawStdout', 'stderr', 'taggedLines'];
  for (const key of providerNativeKeys) {
    it(`rejects a provider-native key "${key}" nested inside terminal`, () => {
      const observation = validObservation();
      observation.terminal = { ...observation.terminal, [key]: 'leaked' };
      const result = validateObservation(observation);
      expect(result.ok).toBe(false);
    });

    it(`rejects a provider-native key "${key}" nested inside session`, () => {
      const observation = validObservation();
      observation.session = { ...observation.session, [key]: 'leaked' };
      const result = validateObservation(observation);
      expect(result.ok).toBe(false);
    });

    it(`rejects a provider-native key "${key}" nested inside a toolAttempts[] entry`, () => {
      const observation = validObservation();
      observation.toolAttempts = [validToolAttempt({ [key]: 'leaked' })];
      const result = validateObservation(observation);
      expect(result.ok).toBe(false);
    });
  }
});

describe('validateObservation -- toolAttempts invariants', () => {
  it('rejects a missing key on a toolAttempts[] entry', () => {
    const attempt = validToolAttempt();
    delete attempt.preDispatchBlock;
    const result = validateObservation(validObservation({ toolAttempts: [attempt] }));
    expect(result.ok).toBe(false);
  });

  it('rejects an unrecognized toolAttempts[] key', () => {
    const result = validateObservation(validObservation({ toolAttempts: [validToolAttempt({ extra: 1 })] }));
    expect(result.ok).toBe(false);
  });

  it('rejects a kind outside shell|skill|other', () => {
    const result = validateObservation(validObservation({ toolAttempts: [validToolAttempt({ kind: 'weird' })] }));
    expect(result.ok).toBe(false);
  });

  it('rejects a non-null command on a non-shell attempt', () => {
    const result = validateObservation(validObservation({ toolAttempts: [validToolAttempt({ kind: 'skill', command: 'echo', skillReference: 'x', targetsExpectedSkill: true })] }));
    expect(result.ok).toBe(false);
  });

  it('accepts a null command on a shell attempt (the transcript can be structurally incomplete)', () => {
    const result = validateObservation(validObservation({ toolAttempts: [validToolAttempt({ id: null, command: null })] }));
    expect(result.ok).toBe(true);
  });

  it('rejects skillReference/targetsExpectedSkill set on a shell attempt', () => {
    const result = validateObservation(validObservation({ toolAttempts: [validToolAttempt({ skillReference: 'x' })] }));
    expect(result.ok).toBe(false);
  });

  it('rejects toolAttempts out of transcript (eventIndex) order', () => {
    const a = validToolAttempt({ id: 'a', eventIndex: 5, result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' } });
    const b = validToolAttempt({ id: 'b', eventIndex: 2, result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' } });
    const result = validateObservation(validObservation({ toolAttempts: [a, b] }));
    expect(result.ok).toBe(false);
  });

  it('preserves duplicate eventIndex values for concurrent same-turn tool calls (not an ordering violation)', () => {
    const a = validToolAttempt({ id: 'a', eventIndex: 5, result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' } });
    const b = validToolAttempt({ id: 'b', eventIndex: 5, result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' } });
    // Both share eventIndex 5 (a real same-turn-batch shape) AND the same inherited receiptNs
    // (100n, from validToolAttempt()'s default) -- the timing map must carry exactly ONE entry for
    // that shared index, matching real production (both attempts' receiptNs come from the SAME
    // source event's _receiptNs).
    // Both a and b have result.found:false -- the producer emits ONE incomplete-tool-result entry
    // PER tool_use block, so two concurrent incomplete calls sharing an eventIndex need TWO
    // entries (round-5 fix: the round-4 SET-by-index comparison wrongly let one entry "cover" both;
    // this is now an exact ordered projection with multiplicity), each carrying its OWN attempt id.
    const incomplete = [
      { index: 5, receiptNs: 100n, name: 'Bash', id: 'a' },
      { index: 5, receiptNs: 100n, name: 'Bash', id: 'b' },
    ];
    const result = validateObservation(validObservation({
      toolAttempts: [a, b],
      timing: { receiptNsByEventIndex: new Map([[5, 100n]]) },
      transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: incomplete, effectiveIncompleteToolResults: incomplete },
      // Both are shell attempts (validToolAttempt()'s default kind) -- 2 real shell calls now,
      // not validObservation()'s own default 1, so hookStats must be reset to stay consistent
      // (round-4 everyCallHooked<->real-shell-count relation).
      hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: false },
    }));
    expect(result.ok).toBe(true);
  });

  it('rejects a negative or non-integer eventIndex', () => {
    expect(validateObservation(validObservation({ toolAttempts: [validToolAttempt({ eventIndex: -1 })] })).ok).toBe(false);
    expect(validateObservation(validObservation({ toolAttempts: [validToolAttempt({ eventIndex: 1.5 })] })).ok).toBe(false);
  });

  it('rejects a receiptNs that is neither bigint nor null', () => {
    expect(validateObservation(validObservation({ toolAttempts: [validToolAttempt({ receiptNs: 100 })] })).ok).toBe(false);
    expect(validateObservation(validObservation({ toolAttempts: [validToolAttempt({ receiptNs: '100' })] })).ok).toBe(false);
  });

  it('accepts a null receiptNs', () => {
    // A null receiptNs must correspond to NO entry in the timing map for that index (the
    // null-together convention both fields share, per the one real producer) -- not the default
    // observation's own 3->100n entry, which would otherwise contradict this attempt's own null.
    const result = validateObservation(validObservation({ toolAttempts: [validToolAttempt({ receiptNs: null })], timing: { receiptNsByEventIndex: new Map() } }));
    expect(result.ok).toBe(true);
  });
});

describe('validateObservation -- tool result invariants', () => {
  it('rejects a result.textStatus outside text|missing|unsupported', () => {
    const attempt = validToolAttempt({ result: { found: true, eventIndex: 4, isError: false, text: 'x', textStatus: 'weird' } });
    expect(validateObservation(validObservation({ toolAttempts: [attempt] })).ok).toBe(false);
  });

  it('never silently coerces a non-string result body into text -- textStatus:unsupported carries text:null', () => {
    const attempt = validToolAttempt({ result: { found: true, eventIndex: 4, isError: false, text: 'not-actually-null-and-should-fail', textStatus: 'unsupported' } });
    const result = validateObservation(validObservation({ toolAttempts: [attempt] }));
    expect(result.ok).toBe(false);
  });

  it('accepts textStatus:unsupported paired with text:null', () => {
    const attempt = validToolAttempt({ result: { found: true, eventIndex: 4, isError: false, text: null, textStatus: 'unsupported' } });
    expect(validateObservation(validObservation({ toolAttempts: [attempt] })).ok).toBe(true);
  });

  it('rejects result.found:false paired with a non-null eventIndex', () => {
    const attempt = validToolAttempt({ result: { found: false, eventIndex: 4, isError: null, text: null, textStatus: 'missing' } });
    expect(validateObservation(validObservation({ toolAttempts: [attempt] })).ok).toBe(false);
  });

  it('rejects result.found:false paired with textStatus other than missing', () => {
    const attempt = validToolAttempt({ result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'text' } });
    expect(validateObservation(validObservation({ toolAttempts: [attempt] })).ok).toBe(false);
  });
});

describe('validateObservation -- pre-dispatch block invariants', () => {
  it('rejects preDispatchBlock.recognized:true on a non-shell attempt', () => {
    const attempt = validToolAttempt({ kind: 'skill', command: null, skillReference: 'x', targetsExpectedSkill: true, preDispatchBlock: { recognized: true, signature: 'claude-code/bash-pre-dispatch-block/v1' } });
    expect(validateObservation(validObservation({ toolAttempts: [attempt] })).ok).toBe(false);
  });

  it('rejects preDispatchBlock.recognized:true without a result correlation (result.found:false)', () => {
    const attempt = validToolAttempt({
      result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' },
      preDispatchBlock: { recognized: true, signature: 'claude-code/bash-pre-dispatch-block/v1' },
    });
    expect(validateObservation(validObservation({ toolAttempts: [attempt] })).ok).toBe(false);
  });

  it('rejects preDispatchBlock.recognized:true with an empty/missing signature', () => {
    const attempt = validToolAttempt({ preDispatchBlock: { recognized: true, signature: '' } });
    expect(validateObservation(validObservation({ toolAttempts: [attempt] })).ok).toBe(false);
    const attempt2 = validToolAttempt({ preDispatchBlock: { recognized: true, signature: null } });
    expect(validateObservation(validObservation({ toolAttempts: [attempt2] })).ok).toBe(false);
  });

  it('rejects preDispatchBlock.recognized:false paired with a non-null signature', () => {
    const attempt = validToolAttempt({ preDispatchBlock: { recognized: false, signature: 'claude-code/bash-pre-dispatch-block/v1' } });
    expect(validateObservation(validObservation({ toolAttempts: [attempt] })).ok).toBe(false);
  });

  it('accepts recognized:true with a well-formed shell attempt and a real signature', () => {
    const attempt = validToolAttempt({ preDispatchBlock: { recognized: true, signature: 'claude-code/bash-pre-dispatch-block/v1' } });
    expect(validateObservation(validObservation({ toolAttempts: [attempt] })).ok).toBe(true);
  });
});

describe('validateObservation -- terminal.usage null vs zero', () => {
  it('accepts null for every usage dimension (a runtime that never reports usage)', () => {
    const observation = validObservation();
    observation.terminal = { ...observation.terminal, usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } };
    expect(validateObservation(observation).ok).toBe(true);
  });

  it('never coerces null to 0, and never coerces 0 to null -- both are independently valid and distinct', () => {
    const zeroObservation = validObservation();
    zeroObservation.terminal = { ...zeroObservation.terminal, usage: { input: 0, cached_input: 0, cache_write: 0, output: 0, reasoning_output: null } };
    const result = validateObservation(zeroObservation);
    expect(result.ok).toBe(true);
  });

  it('rejects a negative usage number', () => {
    const observation = validObservation();
    observation.terminal = { ...observation.terminal, usage: { ...observation.terminal.usage, input: -1 } };
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects a non-integer usage number', () => {
    const observation = validObservation();
    observation.terminal = { ...observation.terminal, usage: { ...observation.terminal.usage, output: 1.5 } };
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects an unrecognized key inside terminal.usage', () => {
    const observation = validObservation();
    observation.terminal = { ...observation.terminal, usage: { ...observation.terminal.usage, extra_dimension: 1 } };
    expect(validateObservation(observation).ok).toBe(false);
  });
});

describe('validateObservation -- transcript structural-issue / incomplete-result arrays', () => {
  it('accepts a real structural-issue shape per known type (ordering + id-keyed types, mutually compatible)', () => {
    const observation = validObservation();
    // init_not_first/result_not_last (round-5: mutually compatible with EACH OTHER -- both fire
    // independently once initIndices.length===1 && resultIndices.length===1) and the 3 id-keyed
    // types (each with a DISTINCT id, since round-5 requires per-type id uniqueness) + empty_tool_use_id
    // -- deliberately excludes init_count/result_count, which round 5 proved mutually exclusive with
    // BOTH ordering issues (see the dedicated count-vs-ordering tests below).
    const issues = [
      { type: 'duplicate_tool_use_id', id: 'toolu_1', count: 2 },
      { type: 'duplicate_tool_result', id: 'toolu_2', count: 2 },
      { type: 'orphan_tool_result', id: null },
      { type: 'result_not_last', resultIndex: 3, eventsLength: 5 },
      { type: 'init_not_first', initIndex: 1 },
      { type: 'empty_tool_use_id' },
    ];
    observation.transcript = {
      // effectiveStructuralIssues mirrors strict exactly -- not a legitimate timeout (default
      // process.terminated:false), so nothing is tolerated away (round-4 strict/effective relation).
      ...observation.transcript,
      strictStructuralIssues: issues,
      effectiveStructuralIssues: issues,
    };
    expect(validateObservation(observation).ok).toBe(true);
  });

  it('accepts init_count and result_count together (the two count-mismatch types are mutually compatible with EACH OTHER, just not with either ordering type)', () => {
    const observation = validObservation();
    const issues = [{ type: 'init_count', count: 2 }, { type: 'result_count', count: 0 }];
    observation.session = { ...observation.session, initPresent: true };
    observation.terminal = { present: false, isError: null, turnCount: null, finalText: null, resultSubtype: null, usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } };
    observation.transcript = { ...observation.transcript, strictStructuralIssues: issues, effectiveStructuralIssues: issues };
    expect(validateObservation(observation).ok).toBe(true);
  });

  it('rejects a structural issue with an unknown type', () => {
    const observation = validObservation();
    observation.transcript = { ...observation.transcript, strictStructuralIssues: [{ type: 'made_up_issue' }] };
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects a structural issue carrying an unrecognized extra key', () => {
    const observation = validObservation();
    observation.transcript = { ...observation.transcript, strictStructuralIssues: [{ type: 'empty_tool_use_id', unexpected: 1 }] };
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects strictStructuralIssues that is not an array', () => {
    const observation = validObservation();
    observation.transcript = { ...observation.transcript, strictStructuralIssues: 3 };
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts a real incomplete-tool-result entry', () => {
    const observation = validObservation();
    // id:null on BOTH sides -- round 5 compares strictIncompleteToolResults' own id field EXACTLY
    // against the matching toolAttempt's id (not just its eventIndex), so the toolAttempt below must
    // also carry id:null, not validToolAttempt()'s own default 'attempt-1'.
    const incomplete = [{ index: 8, receiptNs: 8n, name: 'Bash', id: null }];
    // effectiveIncompleteToolResults mirrors strict (not a legitimate timeout). The entry's own
    // index:8 must correspond to a REAL toolAttempt with result.found:false at that exact
    // eventIndex (round-4 strictIncompleteToolResults<->toolAttempts relation) -- replaces
    // validObservation()'s own default (found:true) shell attempt with a matching incomplete one.
    observation.transcript = { ...observation.transcript, strictIncompleteToolResults: incomplete, effectiveIncompleteToolResults: incomplete };
    observation.toolAttempts = [validToolAttempt({
      id: null, eventIndex: 8, receiptNs: 8n,
      result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' },
    })];
    observation.timing = { receiptNsByEventIndex: new Map([[8, 8n]]) };
    observation.hookStats = { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: false };
    expect(validateObservation(observation).ok).toBe(true);
  });

  it('rejects an incomplete-tool-result entry missing a required key', () => {
    const observation = validObservation();
    observation.transcript = { ...observation.transcript, strictIncompleteToolResults: [{ index: 8, receiptNs: 8n, name: 'Bash' }] };
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects effectiveIncompleteToolResults that is not an array', () => {
    const observation = validObservation();
    observation.transcript = { ...observation.transcript, effectiveIncompleteToolResults: 'nope' };
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('malformedLineCount stays a plain non-negative integer count, never an array', () => {
    const observation = validObservation();
    observation.transcript = { ...observation.transcript, malformedLineCount: [1, 2] };
    expect(validateObservation(observation).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Post-review hardening (round 1): the contract's "closed" keyset check used `key in obj`
// (traverses the prototype chain) instead of an own-property check, and several sub-validators
// checked a key's NAME/TYPE without checking its VALUE or its coherence with a sibling field --
// both let synthetic-but-adversarial input validate clean. Each case below is reproduced first
// (RED), then closed.
// ---------------------------------------------------------------------------

describe('validateRuntimeAdapter -- rejects prototype-inherited shapes (own-properties only)', () => {
  it('an adapter with ZERO own properties, fully backed by a well-formed prototype, is rejected', () => {
    const proto = validAdapter();
    const evilAdapter = Object.create(proto);
    expect(Object.keys(evilAdapter)).toEqual([]); // sanity: genuinely zero own keys
    const result = validateRuntimeAdapter(evilAdapter);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('capabilities backed only by an inherited prototype is also rejected, not just the adapter root', () => {
    const evilCaps = Object.create(validCapabilities());
    const adapter = validAdapter({ capabilities: evilCaps });
    expect(validateRuntimeAdapter(adapter).ok).toBe(false);
  });
});

describe('validateObservation -- rejects prototype-inherited shapes (own-properties only)', () => {
  it('an observation with ZERO own properties, fully backed by a well-formed prototype, is rejected', () => {
    const proto = validObservation();
    const evilObservation = Object.create(proto);
    expect(Object.keys(evilObservation)).toEqual([]);
    expect(validateObservation(evilObservation).ok).toBe(false);
  });

  it('a null-prototype object with every key as an OWN property still validates normally (not a false positive)', () => {
    const observation = Object.assign(Object.create(null), validObservation());
    // toolAttempts/skill/etc. are themselves still ordinary objects with Object.prototype --
    // only the root got a null prototype, which the contract explicitly allows.
    expect(validateObservation(observation).ok).toBe(true);
  });
});

describe('validateObservation -- timing.receiptNsByEventIndex Map contents are validated, not just its type', () => {
  it('accepts a well-formed map (non-negative integer keys, bigint values)', () => {
    const observation = validObservation();
    // Isolates the map-shape property under test: no toolAttempts means nothing for the
    // toolAttempts<->timing cross-field check to compare this map's arbitrary content against.
    // hookStats reset alongside it -- validObservation()'s own default hookCallCount:1/
    // everyCallHooked:true was only consistent with ITS default single shell toolAttempt.
    observation.toolAttempts = [];
    observation.hookStats = { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: true };
    observation.timing = { receiptNsByEventIndex: new Map([[0, 10n], [4, 100n]]) };
    expect(validateObservation(observation).ok).toBe(true);
  });

  it('rejects a map value that is not a bigint (e.g. a raw provider-shaped object)', () => {
    const observation = validObservation();
    observation.timing = { receiptNsByEventIndex: new Map([[4, { message: 'provider-native leaked here' }]]) };
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects a map key that is not a non-negative integer', () => {
    const observation = validObservation();
    observation.timing = { receiptNsByEventIndex: new Map([[-1, 10n]]) };
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects a non-integer map key', () => {
    const observation = validObservation();
    observation.timing = { receiptNsByEventIndex: new Map([['not-a-number', 10n]]) };
    expect(validateObservation(observation).ok).toBe(false);
  });
});

describe('validateObservation -- structural issue extra-key VALUES are validated per type, not just key names', () => {
  it('rejects provider data smuggled into an allowed extra key (id) via a type that never carries an id', () => {
    const observation = validObservation();
    // init_count's only allowed extra key is `count` -- `id` is not a member of ITS shape, even
    // though `id` is a valid extra key name for a DIFFERENT issue type.
    observation.transcript = { ...observation.transcript, strictStructuralIssues: [{ type: 'init_count', count: 2, id: 'toolu_smuggled' }] };
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects a nested object where a real structural issue only ever carries a string id', () => {
    const observation = validObservation();
    observation.transcript = { ...observation.transcript, strictStructuralIssues: [{ type: 'duplicate_tool_use_id', id: { message: 'nested provider content' }, count: 2 }] };
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects a negative count', () => {
    const observation = validObservation();
    observation.transcript = { ...observation.transcript, strictStructuralIssues: [{ type: 'init_count', count: -1 }] };
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts orphan_tool_result with a null id (the one type/key combination allowed to be null)', () => {
    const observation = validObservation();
    const issues = [{ type: 'orphan_tool_result', id: null }];
    observation.transcript = { ...observation.transcript, strictStructuralIssues: issues, effectiveStructuralIssues: issues };
    expect(validateObservation(observation).ok).toBe(true);
  });

  it('rejects duplicate_tool_use_id with a null id (unlike orphan_tool_result, this type never has a null id in practice)', () => {
    const observation = validObservation();
    observation.transcript = { ...observation.transcript, strictStructuralIssues: [{ type: 'duplicate_tool_use_id', id: null, count: 2 }] };
    expect(validateObservation(observation).ok).toBe(false);
  });
});

describe('validateObservation -- terminal.present coherence with its sibling fields', () => {
  it('rejects present:false with a non-null isError/turnCount/finalText/resultSubtype', () => {
    const observation = validObservation();
    observation.terminal = { present: false, isError: true, turnCount: 1, finalText: 'leaked result text', resultSubtype: 'success', usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } };
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects present:false with non-null usage dimensions', () => {
    const observation = validObservation();
    observation.terminal = { present: false, isError: null, turnCount: null, finalText: null, resultSubtype: null, usage: { input: 5, cached_input: null, cache_write: null, output: null, reasoning_output: null } };
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts a genuinely absent terminal (present:false, everything else null)', () => {
    const observation = validObservation();
    observation.terminal = { present: false, isError: null, turnCount: null, finalText: null, resultSubtype: null, usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } };
    // A genuine result_count:0 issue is what makes terminal.present:false valid at all (round-4
    // terminal.present<->strictStructuralIssues relation) -- not a legitimate timeout here, so
    // effective must mirror strict exactly.
    const issues = [{ type: 'result_count', count: 0 }];
    observation.transcript = { ...observation.transcript, strictStructuralIssues: issues, effectiveStructuralIssues: issues };
    expect(validateObservation(observation).ok).toBe(true);
  });

  it('rejects present:true with a null isError (the one field that must always resolve to a real boolean once a result exists)', () => {
    const observation = validObservation();
    observation.terminal = { ...observation.terminal, present: true, isError: null };
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts present:true with turnCount/finalText/resultSubtype independently null (a real, degraded-but-present result)', () => {
    const observation = validObservation();
    observation.terminal = { present: true, isError: false, turnCount: null, finalText: null, resultSubtype: null, usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } };
    expect(validateObservation(observation).ok).toBe(true);
  });
});

describe('validateObservation -- process hrtime ordering', () => {
  it('rejects endedHrtimeNs before spawnHrtimeNs', () => {
    const observation = validObservation();
    observation.process = { ...observation.process, spawnHrtimeNs: 1000n, endedHrtimeNs: 500n };
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts endedHrtimeNs exactly equal to spawnHrtimeNs (an immeasurably fast process)', () => {
    const observation = validObservation();
    observation.process = { ...observation.process, spawnHrtimeNs: 1000n, endedHrtimeNs: 1000n };
    expect(validateObservation(observation).ok).toBe(true);
  });
});

describe('validateObservation -- does not silently absorb anomalies', () => {
  it('a malformed shape still reports errors rather than validating clean by omission', () => {
    const observation = validObservation({ toolAttempts: 'not-an-array' });
    const result = validateObservation(observation);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('every reported error carries a closed code, never free-form provider text', () => {
    const observation = validObservation({ toolAttempts: 'not-an-array' });
    const result = validateObservation(observation);
    for (const err of result.errors) {
      expect(typeof err.code).toBe('string');
      expect(err.code.length).toBeGreaterThan(0);
    }
  });
});

describe('freezeObservation -- deep freeze', () => {
  it('freezes the observation object and its nested plain objects/arrays', () => {
    const observation = freezeObservation(validObservation());
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.terminal)).toBe(true);
    expect(Object.isFrozen(observation.terminal.usage)).toBe(true);
    expect(Object.isFrozen(observation.toolAttempts)).toBe(true);
    expect(Object.isFrozen(observation.toolAttempts[0])).toBe(true);
    expect(Object.isFrozen(observation.toolAttempts[0].result)).toBe(true);
    expect(Object.isFrozen(observation.skill)).toBe(true);
    expect(Object.isFrozen(observation.skill.foreignInvocations)).toBe(true);
  });

  it('does not throw when freezing Map/Set-bearing fields (timing.receiptNsByEventIndex, skill.ambient.names) -- they remain read-only by contract, not by Object.freeze', () => {
    const observation = freezeObservation(validObservation());
    expect(observation.timing.receiptNsByEventIndex instanceof Map).toBe(true);
    expect(observation.skill.ambient.names instanceof Set).toBe(true);
    // Object.freeze on the wrapper object holding the Map/Set does not itself change the Map/Set
    // instance identity, and mutating the Map/Set's own contents is a contract violation the
    // validator (not the runtime) is responsible for catching -- never asserted as a runtime throw.
    expect(observation.timing.receiptNsByEventIndex.get(3)).toBe(100n);
  });
});

describe('selectShellAttempts -- canonical shell selector', () => {
  it('returns only kind:shell entries, preserving order', () => {
    const attempts = [
      validToolAttempt({ id: 'a', kind: 'shell' }),
      validToolAttempt({ id: 'b', kind: 'skill', command: null, skillReference: 'x', targetsExpectedSkill: true }),
      validToolAttempt({ id: 'c', kind: 'shell' }),
      validToolAttempt({ id: 'd', kind: 'other', command: null }),
    ];
    const result = selectShellAttempts(attempts);
    expect(result.map((a) => a.id)).toEqual(['a', 'c']);
  });

  it('returns an empty array for no shell attempts', () => {
    expect(selectShellAttempts([validToolAttempt({ kind: 'other', command: null })])).toEqual([]);
  });
});

describe('msSinceOrigin -- generic timing helper', () => {
  it('computes elapsed milliseconds from two absolute bigint hrtime values', () => {
    expect(msSinceOrigin(5_000_000n, 1_000_000n)).toBe(4);
  });

  it('returns null when the receipt is null', () => {
    expect(msSinceOrigin(null, 1_000_000n)).toBeNull();
  });

  it('returns null when the origin is not a bigint', () => {
    expect(msSinceOrigin(5_000_000n, undefined)).toBeNull();
  });

  it('returns null rather than a negative number when the origin is later than the receipt', () => {
    expect(msSinceOrigin(1_000_000n, 5_000_000n)).toBeNull();
  });
});

describe('canonicalNamesKey / fingerprintNames -- generic ambient HMAC helpers', () => {
  it('canonicalNamesKey is order-independent', () => {
    expect(canonicalNamesKey(new Set(['b', 'a']))).toBe(canonicalNamesKey(new Set(['a', 'b'])));
  });

  it('canonicalNamesKey is a JSON array of the sorted names', () => {
    expect(canonicalNamesKey(new Set(['zeta', 'alpha']))).toBe(JSON.stringify(['alpha', 'zeta']));
  });

  it('fingerprintNames is deterministic for the same names + key', () => {
    const key = Buffer.from('synthetic-key-material');
    const a = fingerprintNames(new Set(['skill-a', 'skill-b']), key);
    const b = fingerprintNames(new Set(['skill-b', 'skill-a']), key);
    expect(a).toBe(b);
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
  });

  it('fingerprintNames differs for two different keys over the same names', () => {
    const names = new Set(['skill-a']);
    const a = fingerprintNames(names, Buffer.from('key-one'));
    const b = fingerprintNames(names, Buffer.from('key-two'));
    expect(a).not.toBe(b);
  });

  it('fingerprintNames never leaks a raw skill name into its own output', () => {
    const digest = fingerprintNames(new Set(['a-very-distinctive-skill-name']), Buffer.from('key'));
    expect(digest).not.toContain('a-very-distinctive-skill-name');
  });
});

// Post-review hardening (round 3, correcting round 1's wrong framing): canonicalNamesKey/
// fingerprintNames are now the ONE real implementation -- stream-parser.mjs's own
// canonicalAmbientSkillNamesKey/fingerprintAmbientSkillNames are re-exports of these exact
// functions, not an independent copy. Round 1 believed stream-parser.mjs was unconditionally
// frozen and treated the duplication as unavoidable within scope; the runbook's own file-scope
// allowlist explicitly authorizes editing stream-parser.mjs "solo para importar/re-exportar los
// helpers genericos de canonical ambient names si evitar duplicacion lo exige" -- exactly this
// case, missed on the first pass. The equivalence proven below is consequently closer to tautological
// now (both sides resolve to the same function object) -- kept anyway as a regression guard on the
// re-export wiring itself (both names stay callable with the same signature/behavior), not as the
// drift-prevention mechanism round 1 described. This remains the ONE deliberate exception to this
// file's own header comment ("never imports runtimes/claude-code.mjs or any Claude-specific
// module") -- stream-parser.mjs is imported here solely to prove the re-export identity, not to
// make any contract behavior itself depend on Claude-specific parsing.
describe('canonicalNamesKey/fingerprintNames (contract.mjs) vs. canonicalAmbientSkillNamesKey/fingerprintAmbientSkillNames (stream-parser.mjs) -- byte-for-byte equivalence', () => {
  it('canonicalNamesKey produces the SAME output as canonicalAmbientSkillNamesKey for a representative range of inputs', async () => {
    const { canonicalAmbientSkillNamesKey } = await import('../../tools/agentic-eval/stream-parser.mjs');
    const cases = [
      new Set(),
      new Set(['solo']),
      new Set(['b', 'a']),
      new Set(['a', 'b']), // same members, different insertion order
      new Set(['zeta', 'alpha', 'mid-name']),
      new Set(['kmp-test-runner', 'kmp-test-runner-namespaced/kmp-test-runner']),
      new Set(['name with spaces', 'name"with"quotes', "name'with'apostrophes"]),
    ];
    for (const names of cases) {
      expect(canonicalNamesKey(names)).toBe(canonicalAmbientSkillNamesKey(names));
    }
  });

  it('fingerprintNames produces the SAME digest as fingerprintAmbientSkillNames for the same names + key', async () => {
    const { fingerprintAmbientSkillNames } = await import('../../tools/agentic-eval/stream-parser.mjs');
    const key = Buffer.from('synthetic-shared-equivalence-key');
    const cases = [
      new Set(),
      new Set(['skill-a']),
      new Set(['skill-b', 'skill-a']),
      new Set(['kmp-test-runner']),
    ];
    for (const names of cases) {
      expect(fingerprintNames(names, key)).toBe(fingerprintAmbientSkillNames(names, key));
    }
  });
});

// Stage 5 (synthetic contract conformance) -- proves runtimes/contract.mjs's validators and
// generic helpers are genuinely runtime-agnostic by normalizing TWO fixtures with wire shapes
// that resemble neither Claude Code's stream-jsonl nor each other, using adapters defined ONLY in
// this test file (never a production runtimes/<id>.mjs module -- see the runbook's own Stage 5
// instruction). Neither fixture represents, and neither this file nor its fixtures claim to
// represent, any real coding-agent product's actual wire format; both fixture JSON files carry
// their own explicit "note" field saying so. No vendor CLI is ever imported, spawned, or
// referenced anywhere in this block.
describe('Stage 5 -- synthetic multi-source and typed-step fixtures both satisfy the contract', () => {
  const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const MULTI_SOURCE_RAW = JSON.parse(readFileSync(join(FIXTURES_DIR, 'agentic-eval-runtime-multi-source.synthetic.json'), 'utf8'));
  const TYPED_STEP_RAW = JSON.parse(readFileSync(join(FIXTURES_DIR, 'agentic-eval-runtime-typed-step.synthetic.json'), 'utf8'));

  /**
   * `synthetic-multi-source`'s own normalizer: the fixture's primary stream, hook ledger, and
   * usage telemetry are three SEPARATE source objects (never one combined stream) -- this proves
   * the contract doesn't assume a single-stream shape. Fails closed (returns a deliberately
   * incomplete/invalid observation shell, never a silently-defaulted "valid" one) on: a missing
   * source, two hook-ledger entries claiming the same callId (an unresolvable conflict -- which
   * decision governs?), or a tool-outcome step whose callId was never invoked (an orphan result).
   */
  function normalizeSyntheticMultiSource(sources) {
    const { primaryStream, hookLedger, usageTelemetry } = sources ?? {};
    if (primaryStream == null || hookLedger == null || usageTelemetry == null) {
      return { schema: 1, runtime: { id: 'synthetic-multi-source', protocolVersion: 1 } };
    }
    const entries = hookLedger.entries ?? [];
    const seenCallIds = new Set();
    for (const e of entries) {
      if (seenCallIds.has(e.callId)) {
        return { schema: 1, runtime: { id: 'synthetic-multi-source', protocolVersion: 1 }, hookStats: null };
      }
      seenCallIds.add(e.callId);
    }
    const steps = primaryStream.steps ?? [];
    const invokedCallIds = new Set(steps.filter((s) => s.kind === 'tool-invoke').map((s) => s.callId));
    const orphanOutcome = steps.some((s) => s.kind === 'tool-outcome' && !invokedCallIds.has(s.callId));
    if (orphanOutcome) {
      return { schema: 1, runtime: { id: 'synthetic-multi-source', protocolVersion: 1 }, toolAttempts: null };
    }
    const toolAttempts = [];
    const receiptNsByEventIndex = new Map();
    steps.forEach((step, eventIndex) => {
      receiptNsByEventIndex.set(eventIndex, BigInt(eventIndex));
      if (step.kind !== 'tool-invoke') return;
      const outcome = steps.find((s) => s.kind === 'tool-outcome' && s.callId === step.callId);
      toolAttempts.push({
        id: step.callId, kind: 'shell', runtimeName: step.tool ?? null, eventIndex,
        receiptNs: BigInt(eventIndex), profileAllowed: true, command: step.command ?? null,
        skillReference: null, targetsExpectedSkill: null,
        result: outcome
          ? { found: true, eventIndex: steps.indexOf(outcome), isError: outcome.ok !== true, text: typeof outcome.output === 'string' ? outcome.output : null, textStatus: typeof outcome.output === 'string' ? 'text' : 'unsupported' }
          : { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' },
        preDispatchBlock: { recognized: false, signature: null },
      });
    });
    const sessionEnd = steps.find((s) => s.kind === 'session-end');
    const hookAllowCount = entries.filter((e) => e.decision === 'allow').length;
    const hookDenyCount = entries.filter((e) => e.decision === 'deny').length;
    return {
      schema: 1,
      runtime: { id: 'synthetic-multi-source', protocolVersion: 1 },
      process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: BigInt(steps.length) },
      session: {
        initPresent: true, modelResolved: primaryStream.modelResolved ?? null,
        sessionIdObserved: primaryStream.sessionId ?? null, runtimeVersion: 'synthetic-multi-source-v1',
        toolProfileMatchesExpected: true,
      },
      transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
      terminal: {
        present: sessionEnd != null, isError: sessionEnd ? sessionEnd.outcome !== 'completed' : null,
        turnCount: 1, finalText: sessionEnd?.finalMessage ?? null,
        resultSubtype: sessionEnd ? sessionEnd.outcome : null,
        usage: { input: usageTelemetry.inputUnits ?? null, cached_input: usageTelemetry.cachedInputUnits ?? null, cache_write: usageTelemetry.cacheWriteUnits ?? null, output: usageTelemetry.outputUnits ?? null, reasoning_output: null },
      },
      toolAttempts,
      skill: {
        available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
        targetInvocation: null, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
      },
      hookStats: {
        hookCallCount: entries.length, hookResponseCount: entries.length, hookDenyCount, hookAllowCount,
        hookPairingOk: true, everyCallHooked: entries.length === toolAttempts.length,
      },
      byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
      timing: { receiptNsByEventIndex },
    };
  }

  /**
   * `synthetic-typed-step`'s own normalizer: a typed-step stream (each entry discriminated by an
   * explicit `type` field, structurally unlike both Claude's stream-jsonl AND the multi-source
   * fixture above) carrying a SOFT permission denial -- normalized to exactly one shell toolAttempt
   * with a correlated result (the denial text itself) and canonical pre-dispatch evidence
   * (recognized:true, a non-empty synthetic signature). Fails closed when the request/denial pair
   * can't be correlated (a malformed-tool-result shape: a denial with no matching request, or vice
   * versa).
   */
  function normalizeSyntheticTypedStep(sources) {
    const { typedSteps } = sources ?? {};
    if (typedSteps == null) {
      return { schema: 1, runtime: { id: 'synthetic-typed-step', protocolVersion: 1 } };
    }
    const begin = typedSteps.find((s) => s.type === 'session-begin');
    const request = typedSteps.find((s) => s.type === 'shell-request');
    const denial = typedSteps.find((s) => s.type === 'shell-soft-denied' && s.stepId === request?.stepId);
    const finish = typedSteps.find((s) => s.type === 'session-finish');
    if (request == null || denial == null) {
      return { schema: 1, runtime: { id: 'synthetic-typed-step', protocolVersion: 1 }, toolAttempts: null };
    }
    const requestIndex = typedSteps.indexOf(request);
    const denialIndex = typedSteps.indexOf(denial);
    const receiptNsByEventIndex = new Map(typedSteps.map((_, i) => [i, BigInt(i)]));
    return {
      schema: 1,
      runtime: { id: 'synthetic-typed-step', protocolVersion: 1 },
      process: { exitCode: 1, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: BigInt(typedSteps.length) },
      session: {
        initPresent: begin != null, modelResolved: begin?.modelResolved ?? null,
        sessionIdObserved: begin?.sessionId ?? null, runtimeVersion: 'synthetic-typed-step-v1',
        toolProfileMatchesExpected: true,
      },
      transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
      terminal: {
        present: finish != null, isError: finish ? finish.outcome !== 'completed' : null,
        turnCount: 1, finalText: finish?.finalMessage ?? null,
        resultSubtype: finish ? finish.outcome : null,
        usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null },
      },
      toolAttempts: [{
        id: request.stepId, kind: 'shell', runtimeName: 'shell', eventIndex: requestIndex,
        receiptNs: BigInt(requestIndex), profileAllowed: true, command: request.command ?? null,
        skillReference: null, targetsExpectedSkill: null,
        result: { found: true, eventIndex: denialIndex, isError: true, text: denial.policyNote ?? null, textStatus: typeof denial.policyNote === 'string' ? 'text' : 'unsupported' },
        preDispatchBlock: { recognized: true, signature: 'synthetic/shell-soft-denial/v1' },
      }],
      skill: {
        available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
        targetInvocation: null, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
      },
      // everyCallHooked:false, not true -- this synthetic source models no hook evidence at all
      // (hookCallCount:0), while toolAttempts above genuinely carries one real shell attempt; the
      // round-4 everyCallHooked<->real-shell-count relation requires the two to agree.
      hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: false },
      byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
      timing: { receiptNsByEventIndex },
    };
  }

  function syntheticAsyncNoop() { return async () => ({}); }

  const MULTI_SOURCE_ADAPTER = defineRuntimeAdapter({
    id: 'synthetic-multi-source',
    protocolVersion: 1,
    capabilities: {
      observationSources: ['primary-stream', 'hook-ledger', 'usage-telemetry'],
      structuredTranscript: true,
      correlatedToolResults: true,
      skillDeliveryModes: [],
      skillStateEvidence: false,
      usageDimensions: ['input', 'cached_input', 'output'],
      softPermissionDenial: false,
    },
    supportsModelConfiguration: () => true,
    supportsExecutionProfile: () => true,
    probeInstallation: syntheticAsyncNoop(),
    preflight: syntheticAsyncNoop(),
    prepareIsolatedHome: syntheticAsyncNoop(),
    prepareSkillDelivery: () => ({}),
    buildInvocation: () => [],
    collectObservationSources: syntheticAsyncNoop(),
    normalizeObservations: normalizeSyntheticMultiSource,
    redactRuntimeDiagnostics: (x) => x,
  });

  const TYPED_STEP_ADAPTER = defineRuntimeAdapter({
    id: 'synthetic-typed-step',
    protocolVersion: 1,
    capabilities: {
      observationSources: ['typed-step-stream'],
      structuredTranscript: true,
      correlatedToolResults: true,
      skillDeliveryModes: [],
      skillStateEvidence: false,
      usageDimensions: [],
      softPermissionDenial: true,
    },
    supportsModelConfiguration: () => true,
    supportsExecutionProfile: () => true,
    probeInstallation: syntheticAsyncNoop(),
    preflight: syntheticAsyncNoop(),
    prepareIsolatedHome: syntheticAsyncNoop(),
    prepareSkillDelivery: () => ({}),
    buildInvocation: () => [],
    collectObservationSources: syntheticAsyncNoop(),
    normalizeObservations: normalizeSyntheticTypedStep,
    redactRuntimeDiagnostics: (x) => x,
  });

  it('both fixtures\' ids match their own declared adapter id (sanity, catches fixture/adapter drift)', () => {
    expect(MULTI_SOURCE_RAW.id).toBe('synthetic-multi-source');
    expect(TYPED_STEP_RAW.id).toBe('synthetic-typed-step');
  });

  it('both adapters pass the SAME adapter validator', () => {
    expect(validateRuntimeAdapter(MULTI_SOURCE_ADAPTER)).toEqual({ ok: true, errors: [] });
    expect(validateRuntimeAdapter(TYPED_STEP_ADAPTER)).toEqual({ ok: true, errors: [] });
  });

  it('both normalize their own real fixture to a valid observation under the SAME top-level contract', () => {
    const multiSourceObs = normalizeSyntheticMultiSource(MULTI_SOURCE_RAW);
    const typedStepObs = normalizeSyntheticTypedStep(TYPED_STEP_RAW);
    expect(validateObservation(multiSourceObs)).toEqual({ ok: true, errors: [] });
    expect(validateObservation(typedStepObs)).toEqual({ ok: true, errors: [] });
    // Not just "both individually valid" -- both share the EXACT same top-level key set, proving
    // the contract is one shape, not two coincidentally-overlapping ones.
    expect(Object.keys(multiSourceObs).sort()).toEqual([...OBSERVATION_KEYS].sort());
    expect(Object.keys(typedStepObs).sort()).toEqual([...OBSERVATION_KEYS].sort());
  });

  it('source-specific keys/vocabulary never appear anywhere in either normalized observation', () => {
    const bigintSafe = (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Set ? [...v] : v);
    const multiSourceText = JSON.stringify(normalizeSyntheticMultiSource(MULTI_SOURCE_RAW), bigintSafe);
    const typedStepText = JSON.stringify(normalizeSyntheticTypedStep(TYPED_STEP_RAW), bigintSafe);
    const forbidden = [
      'primaryStream', 'hookLedger', 'usageTelemetry', 'typedSteps', 'callId', 'stepId',
      'tool-invoke', 'tool-outcome', 'shell-request', 'shell-soft-denied',
      'session-start', 'session-end', 'session-begin', 'session-finish', 'policyNote', 'decision',
    ];
    for (const term of forbidden) {
      expect(multiSourceText).not.toContain(term);
      expect(typedStepText).not.toContain(term);
    }
  });

  it('fails closed: a missing source (usageTelemetry absent) never silently defaults to a valid observation', () => {
    const { usageTelemetry, ...withoutUsage } = MULTI_SOURCE_RAW;
    expect(usageTelemetry).toBeDefined(); // sanity: the real fixture genuinely had it
    const obs = normalizeSyntheticMultiSource(withoutUsage);
    expect(validateObservation(obs).ok).toBe(false);
  });

  it('fails closed: a duplicate source (two hook-ledger entries for the same callId) never silently resolves', () => {
    const mutated = {
      ...MULTI_SOURCE_RAW,
      hookLedger: { entries: [{ callId: 'c1', decision: 'allow' }, { callId: 'c1', decision: 'deny' }] },
    };
    const obs = normalizeSyntheticMultiSource(mutated);
    expect(validateObservation(obs).ok).toBe(false);
  });

  it('fails closed: an unknown capability value never passes the adapter validator', () => {
    const mutated = { ...MULTI_SOURCE_ADAPTER, capabilities: { ...MULTI_SOURCE_ADAPTER.capabilities, usageDimensions: ['input', 'made-up-dimension'] } };
    const result = validateRuntimeAdapter(mutated);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'unknown_dimension')).toBe(true);
  });

  it('fails closed: a malformed tool result (an outcome/denial with no correlated request) never silently drops', () => {
    // Multi-source: a tool-outcome for a callId that was never invoked (orphan result).
    const orphanOutcome = {
      ...MULTI_SOURCE_RAW,
      primaryStream: { ...MULTI_SOURCE_RAW.primaryStream, steps: [...MULTI_SOURCE_RAW.primaryStream.steps, { kind: 'tool-outcome', callId: 'never-invoked', ok: true, output: 'x' }] },
    };
    expect(validateObservation(normalizeSyntheticMultiSource(orphanOutcome)).ok).toBe(false);
    // Typed-step: a shell-soft-denied step whose stepId matches no shell-request.
    const orphanDenial = {
      ...TYPED_STEP_RAW,
      typedSteps: TYPED_STEP_RAW.typedSteps.filter((s) => s.type !== 'shell-request'),
    };
    expect(validateObservation(normalizeSyntheticTypedStep(orphanDenial)).ok).toBe(false);
  });

  it('fails closed: a fabricated pre-dispatch signature with no correlated (found) result never passes observation validation', () => {
    const obs = normalizeSyntheticTypedStep(TYPED_STEP_RAW);
    const fabricated = {
      ...obs,
      toolAttempts: [{
        ...obs.toolAttempts[0],
        result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' },
        preDispatchBlock: { recognized: true, signature: 'fabricated-signature-never-really-recognized' },
      }],
    };
    const result = validateObservation(fabricated);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'toolAttempts[0].preDispatchBlock')).toBe(true);
  });

  it('the generic shell/timing/usage selectors work on BOTH observations without knowing which fixture produced them', () => {
    for (const obs of [normalizeSyntheticMultiSource(MULTI_SOURCE_RAW), normalizeSyntheticTypedStep(TYPED_STEP_RAW)]) {
      const shellAttempts = selectShellAttempts(obs.toolAttempts);
      expect(shellAttempts.length).toBe(1);
      expect(shellAttempts[0].kind).toBe('shell');
      const receiptNs = obs.timing.receiptNsByEventIndex.get(shellAttempts[0].eventIndex);
      expect(typeof msSinceOrigin(obs.process.endedHrtimeNs, receiptNs)).toBe('number');
    }
  });

  it('the multi-source usage telemetry is readable via the exact same terminal.usage shape the Claude adapter populates', () => {
    const obs = normalizeSyntheticMultiSource(MULTI_SOURCE_RAW);
    expect(obs.terminal.usage.input).toBe(MULTI_SOURCE_RAW.usageTelemetry.inputUnits);
    expect(obs.terminal.usage.output).toBe(MULTI_SOURCE_RAW.usageTelemetry.outputUnits);
    expect(obs.terminal.usage.cached_input).toBe(MULTI_SOURCE_RAW.usageTelemetry.cachedInputUnits);
  });

  it('the typed-step soft denial normalizes to a recognized pre-dispatch block on a correlated (found) result', () => {
    const obs = normalizeSyntheticTypedStep(TYPED_STEP_RAW);
    const [attempt] = obs.toolAttempts;
    expect(attempt.preDispatchBlock.recognized).toBe(true);
    expect(typeof attempt.preDispatchBlock.signature).toBe('string');
    expect(attempt.preDispatchBlock.signature.length).toBeGreaterThan(0);
    expect(attempt.result.found).toBe(true);
    expect(attempt.result.isError).toBe(true);
  });
});

// Round 4: a fully self-consistent minimal fixture satisfying every cross-field invariant below by
// construction (emptiness/absence on every dimension) -- used instead of validObservation() for
// these tests specifically, since validObservation()'s own non-empty defaults (a shell toolAttempt,
// terminal.present:true, etc.) are now ALSO subject to these same cross-field checks and would
// require careful co-adjustment on every override otherwise.
function minimalConsistentObservation(overrides = {}) {
  return {
    schema: 1,
    runtime: { id: 'synthetic-runtime', protocolVersion: 1 },
    process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 1n },
    session: { initPresent: true, modelResolved: null, sessionIdObserved: null, runtimeVersion: null, toolProfileMatchesExpected: true },
    // No structural issues at all -- absence of init_count/result_count means exactly one init and
    // one result event were found, so session.initPresent/terminal.present must both be true.
    transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    terminal: { present: true, isError: false, turnCount: 1, finalText: 'done', resultSubtype: 'success', usage: { input: 1, cached_input: 0, cache_write: 0, output: 1, reasoning_output: null } },
    toolAttempts: [],
    skill: { available: false, profileMatchesCondition: true, snapshotBindingMatches: false, targetInvocation: null, foreignInvocations: [], ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true } },
    // hookCallCount(0) === shell-attempt count(0) and hookPairingOk:true -- everyCallHooked:true is
    // the ONLY value consistent with the real formula here (vacuously: zero calls, zero hooks).
    hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: true },
    byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
    timing: { receiptNsByEventIndex: new Map() },
    ...overrides,
  };
}

describe('validateObservation -- hookStats.everyCallHooked cross-checked against the real shell toolAttempt count (round 4)', () => {
  it('rejects everyCallHooked:true when hookCallCount does not match the real shell-attempt count', () => {
    const attempt = validToolAttempt({ kind: 'shell', eventIndex: 0, receiptNs: 10n });
    const observation = minimalConsistentObservation({
      toolAttempts: [attempt],
      timing: { receiptNsByEventIndex: new Map([[0, 10n]]) },
      hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: true },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects everyCallHooked:false when hookCallCount/hookPairingOk actually satisfy the real formula (the reverse IFF direction)', () => {
    const attempt = validToolAttempt({ kind: 'shell', eventIndex: 0, receiptNs: 10n });
    const observation = minimalConsistentObservation({
      toolAttempts: [attempt],
      timing: { receiptNsByEventIndex: new Map([[0, 10n]]) },
      hookStats: { hookCallCount: 1, hookResponseCount: 1, hookDenyCount: 0, hookAllowCount: 1, hookPairingOk: true, everyCallHooked: false },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts everyCallHooked:true when hookCallCount genuinely matches the real shell-attempt count', () => {
    const attempt = validToolAttempt({ kind: 'shell', eventIndex: 0, receiptNs: 10n });
    const observation = minimalConsistentObservation({
      toolAttempts: [attempt],
      timing: { receiptNsByEventIndex: new Map([[0, 10n]]) },
      hookStats: { hookCallCount: 1, hookResponseCount: 1, hookDenyCount: 0, hookAllowCount: 1, hookPairingOk: true, everyCallHooked: true },
    });
    expect(validateObservation(observation).ok).toBe(true);
  });
});

describe('validateObservation -- skill.targetInvocation full projection against toolAttempts (round 4)', () => {
  it('rejects confirmed:true when no matching toolAttempt has a found, non-error result', () => {
    const attempt = validToolAttempt({
      kind: 'skill', eventIndex: 3, receiptNs: 42n, targetsExpectedSkill: true, command: null,
      result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' },
    });
    const observation = minimalConsistentObservation({
      toolAttempts: [attempt],
      timing: { receiptNsByEventIndex: new Map([[3, 42n]]) },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        targetInvocation: { attempted: true, confirmed: true, attemptCount: 1, eventIndex: 3, receiptNs: 42n, resultIsError: null },
      },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects a receiptNs that disagrees with the timing map at the same eventIndex', () => {
    const attempt = validToolAttempt({
      kind: 'skill', eventIndex: 3, receiptNs: 42n, targetsExpectedSkill: true, command: null,
      result: { found: true, eventIndex: 4, isError: false, text: 'ok', textStatus: 'text' },
    });
    const observation = minimalConsistentObservation({
      toolAttempts: [attempt],
      timing: { receiptNsByEventIndex: new Map([[3, 42n]]) },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        targetInvocation: { attempted: true, confirmed: true, attemptCount: 1, eventIndex: 3, receiptNs: 999999n, resultIsError: false },
      },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it("rejects a resultIsError that disagrees with the matching toolAttempt's own result.isError", () => {
    const attempt = validToolAttempt({
      kind: 'skill', eventIndex: 3, receiptNs: 42n, targetsExpectedSkill: true, command: null,
      result: { found: true, eventIndex: 4, isError: false, text: 'ok', textStatus: 'text' },
    });
    const observation = minimalConsistentObservation({
      toolAttempts: [attempt],
      timing: { receiptNsByEventIndex: new Map([[3, 42n]]) },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        targetInvocation: { attempted: true, confirmed: true, attemptCount: 1, eventIndex: 3, receiptNs: 42n, resultIsError: true },
      },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts a fully consistent targetInvocation projection', () => {
    const attempt = validToolAttempt({
      kind: 'skill', eventIndex: 3, receiptNs: 42n, targetsExpectedSkill: true, command: null,
      result: { found: true, eventIndex: 4, isError: false, text: 'ok', textStatus: 'text' },
    });
    const observation = minimalConsistentObservation({
      toolAttempts: [attempt],
      timing: { receiptNsByEventIndex: new Map([[3, 42n]]) },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        targetInvocation: { attempted: true, confirmed: true, attemptCount: 1, eventIndex: 3, receiptNs: 42n, resultIsError: false },
      },
    });
    expect(validateObservation(observation).ok).toBe(true);
  });
});

describe('validateObservation -- skill.foreignInvocations cross-checked against toolAttempts, both directions (round 4)', () => {
  it('rejects a foreignInvocations entry with no corresponding toolAttempt at all', () => {
    const observation = minimalConsistentObservation({
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, targetInvocation: null,
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        foreignInvocations: [{ eventIndex: 5, receiptNs: 50n, id: 'f1', skillReference: 'other:other', resultIsError: true, confirmed: false }],
      },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects a foreign-skill toolAttempt with no corresponding foreignInvocations entry (reverse direction)', () => {
    const foreignAttempt = validToolAttempt({
      id: 'f1', kind: 'skill', eventIndex: 5, receiptNs: 50n, targetsExpectedSkill: false, skillReference: 'other:other', command: null,
      result: { found: true, eventIndex: 6, isError: true, text: 'nope', textStatus: 'text' },
    });
    const observation = minimalConsistentObservation({
      toolAttempts: [foreignAttempt],
      timing: { receiptNsByEventIndex: new Map([[5, 50n]]) },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, targetInvocation: null, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
      },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it("rejects a foreignInvocations entry whose fields disagree with its matching toolAttempt's own result", () => {
    const foreignAttempt = validToolAttempt({
      id: 'f1', kind: 'skill', eventIndex: 5, receiptNs: 50n, targetsExpectedSkill: false, skillReference: 'other:other', command: null,
      result: { found: true, eventIndex: 6, isError: true, text: 'nope', textStatus: 'text' },
    });
    const observation = minimalConsistentObservation({
      toolAttempts: [foreignAttempt],
      timing: { receiptNsByEventIndex: new Map([[5, 50n]]) },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, targetInvocation: null,
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        // resultIsError/confirmed flipped vs. the real, correlated result (found:true, isError:true).
        foreignInvocations: [{ eventIndex: 5, receiptNs: 50n, id: 'f1', skillReference: 'other:other', resultIsError: false, confirmed: true }],
      },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts a fully consistent foreignInvocations projection', () => {
    const foreignAttempt = validToolAttempt({
      id: 'f1', kind: 'skill', eventIndex: 5, receiptNs: 50n, targetsExpectedSkill: false, skillReference: 'other:other', command: null,
      result: { found: true, eventIndex: 6, isError: true, text: 'nope', textStatus: 'text' },
    });
    const observation = minimalConsistentObservation({
      toolAttempts: [foreignAttempt],
      timing: { receiptNsByEventIndex: new Map([[5, 50n]]) },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, targetInvocation: null,
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        foreignInvocations: [{ eventIndex: 5, receiptNs: 50n, id: 'f1', skillReference: 'other:other', resultIsError: true, confirmed: false }],
      },
    });
    expect(validateObservation(observation).ok).toBe(true);
  });
});

describe('validateObservation -- strict/effective structuralIssues relation, keyed on legitimate timeout (round 4)', () => {
  it('rejects effective UNCHANGED from strict when a legitimate timeout should have tolerated the result_count:0 issue', () => {
    const observation = minimalConsistentObservation({
      process: { exitCode: null, terminated: true, terminationReason: 'timeout', spawnHrtimeNs: 0n, endedHrtimeNs: 1n },
      terminal: { present: false, isError: null, turnCount: null, finalText: null, resultSubtype: null, usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
      transcript: { malformedLineCount: 0, strictStructuralIssues: [{ type: 'result_count', count: 0 }], effectiveStructuralIssues: [{ type: 'result_count', count: 0 }], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts effective with the result_count:0 issue correctly filtered out under a legitimate timeout', () => {
    const observation = minimalConsistentObservation({
      process: { exitCode: null, terminated: true, terminationReason: 'timeout', spawnHrtimeNs: 0n, endedHrtimeNs: 1n },
      terminal: { present: false, isError: null, turnCount: null, finalText: null, resultSubtype: null, usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
      transcript: { malformedLineCount: 0, strictStructuralIssues: [{ type: 'result_count', count: 0 }], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    });
    expect(validateObservation(observation).ok).toBe(true);
  });

  it('rejects effective missing the result_count:0 issue when NOT a legitimate timeout (nothing should be filtered)', () => {
    const observation = minimalConsistentObservation({
      process: { exitCode: 1, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 1n },
      terminal: { present: false, isError: null, turnCount: null, finalText: null, resultSubtype: null, usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
      transcript: { malformedLineCount: 0, strictStructuralIssues: [{ type: 'result_count', count: 0 }], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects an effective structural issue that does not appear in strict at all', () => {
    const observation = minimalConsistentObservation({
      session: { initPresent: false, modelResolved: null, sessionIdObserved: null, runtimeVersion: null, toolProfileMatchesExpected: true },
      transcript: { malformedLineCount: 0, strictStructuralIssues: [{ type: 'init_count', count: 0 }], effectiveStructuralIssues: [{ type: 'init_not_first', initIndex: 3 }], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });
});

describe('validateObservation -- strict/effective incompleteToolResults relation, keyed on legitimate timeout + last-tool-use (round 4)', () => {
  it('rejects effective UNCHANGED from strict when a legitimate timeout should have tolerated the one, LAST incomplete result', () => {
    const attempt = validToolAttempt({
      kind: 'shell', eventIndex: 7, receiptNs: 70n,
      result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' },
    });
    const observation = minimalConsistentObservation({
      process: { exitCode: null, terminated: true, terminationReason: 'timeout', spawnHrtimeNs: 0n, endedHrtimeNs: 1n },
      toolAttempts: [attempt],
      timing: { receiptNsByEventIndex: new Map([[7, 70n]]) },
      hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: false },
      transcript: {
        malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [],
        strictIncompleteToolResults: [{ index: 7, receiptNs: 70n, name: 'Bash', id: null }],
        effectiveIncompleteToolResults: [{ index: 7, receiptNs: 70n, name: 'Bash', id: null }],
      },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts effective with the one, LAST incomplete result correctly tolerated under a legitimate timeout', () => {
    const attempt = validToolAttempt({
      id: null, kind: 'shell', eventIndex: 7, receiptNs: 70n,
      result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' },
    });
    const observation = minimalConsistentObservation({
      process: { exitCode: null, terminated: true, terminationReason: 'timeout', spawnHrtimeNs: 0n, endedHrtimeNs: 1n },
      toolAttempts: [attempt],
      timing: { receiptNsByEventIndex: new Map([[7, 70n]]) },
      hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: false },
      transcript: {
        malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [],
        strictIncompleteToolResults: [{ index: 7, receiptNs: 70n, name: 'Bash', id: null }],
        effectiveIncompleteToolResults: [],
      },
    });
    expect(validateObservation(observation).ok).toBe(true);
  });

  it('rejects effective tolerating an incomplete result that is NOT the last tool_use, even under a legitimate timeout', () => {
    const earlier = validToolAttempt({
      id: 'earlier', kind: 'shell', eventIndex: 2, receiptNs: 20n,
      result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' },
    });
    const later = validToolAttempt({
      id: 'later', kind: 'shell', eventIndex: 7, receiptNs: 70n,
      result: { found: true, eventIndex: 8, isError: false, text: 'ok', textStatus: 'text' },
    });
    const observation = minimalConsistentObservation({
      process: { exitCode: null, terminated: true, terminationReason: 'timeout', spawnHrtimeNs: 0n, endedHrtimeNs: 1n },
      toolAttempts: [earlier, later],
      timing: { receiptNsByEventIndex: new Map([[2, 20n], [7, 70n]]) },
      hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: false },
      transcript: {
        malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [],
        // index:2 is NOT the last tool_use (index:7 is) -- must stay fully blocking regardless of timeout.
        strictIncompleteToolResults: [{ index: 2, receiptNs: 20n, name: 'Bash', id: null }],
        effectiveIncompleteToolResults: [],
      },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });
});

describe('validateObservation -- strictIncompleteToolResults eventIndex-set matches toolAttempts with result.found:false (round 4)', () => {
  it('rejects a toolAttempt with result.found:false that has no corresponding strictIncompleteToolResults entry', () => {
    const attempt = validToolAttempt({
      kind: 'shell', eventIndex: 2, receiptNs: 20n,
      result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' },
    });
    const observation = minimalConsistentObservation({
      toolAttempts: [attempt],
      timing: { receiptNsByEventIndex: new Map([[2, 20n]]) },
      hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: false },
      // strictIncompleteToolResults left empty -- should have an entry at index:2.
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects a strictIncompleteToolResults entry whose index has no corresponding result.found:false toolAttempt', () => {
    const attempt = validToolAttempt({
      kind: 'shell', eventIndex: 2, receiptNs: 20n,
      result: { found: true, eventIndex: 3, isError: false, text: 'ok', textStatus: 'text' },
    });
    const observation = minimalConsistentObservation({
      toolAttempts: [attempt],
      timing: { receiptNsByEventIndex: new Map([[2, 20n]]) },
      hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: false },
      transcript: {
        malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [],
        strictIncompleteToolResults: [{ index: 2, receiptNs: 20n, name: 'Bash', id: null }],
        effectiveIncompleteToolResults: [{ index: 2, receiptNs: 20n, name: 'Bash', id: null }],
      },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts a fully consistent result.found:false <-> strictIncompleteToolResults correspondence', () => {
    const attempt = validToolAttempt({
      id: null, kind: 'shell', eventIndex: 2, receiptNs: 20n,
      result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' },
    });
    const observation = minimalConsistentObservation({
      toolAttempts: [attempt],
      timing: { receiptNsByEventIndex: new Map([[2, 20n]]) },
      hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: false },
      transcript: {
        malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [],
        strictIncompleteToolResults: [{ index: 2, receiptNs: 20n, name: 'Bash', id: null }],
        effectiveIncompleteToolResults: [{ index: 2, receiptNs: 20n, name: 'Bash', id: null }],
      },
    });
    expect(validateObservation(observation).ok).toBe(true);
  });
});

describe('validateObservation -- session.initPresent cross-checked against strictStructuralIssues\' init_count (round 4)', () => {
  it('rejects initPresent:false with no init_count issue reported at all', () => {
    const observation = minimalConsistentObservation({
      session: { initPresent: false, modelResolved: null, sessionIdObserved: null, runtimeVersion: null, toolProfileMatchesExpected: true },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects initPresent:true when strictStructuralIssues reports init_count:0', () => {
    const observation = minimalConsistentObservation({
      transcript: { malformedLineCount: 0, strictStructuralIssues: [{ type: 'init_count', count: 0 }], effectiveStructuralIssues: [{ type: 'init_count', count: 0 }], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts initPresent:false paired with a genuine init_count:0 issue', () => {
    const observation = minimalConsistentObservation({
      session: { initPresent: false, modelResolved: null, sessionIdObserved: null, runtimeVersion: null, toolProfileMatchesExpected: true },
      transcript: { malformedLineCount: 0, strictStructuralIssues: [{ type: 'init_count', count: 0 }], effectiveStructuralIssues: [{ type: 'init_count', count: 0 }], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    });
    expect(validateObservation(observation).ok).toBe(true);
  });

  it('accepts initPresent:true paired with an init_count:2 issue (init present, just duplicated)', () => {
    const observation = minimalConsistentObservation({
      transcript: { malformedLineCount: 0, strictStructuralIssues: [{ type: 'init_count', count: 2 }], effectiveStructuralIssues: [{ type: 'init_count', count: 2 }], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    });
    expect(validateObservation(observation).ok).toBe(true);
  });
});

describe('validateObservation -- terminal.present cross-checked against strictStructuralIssues\' result_count (round 4)', () => {
  it('rejects terminal.present:true when strictStructuralIssues reports result_count:0', () => {
    const observation = minimalConsistentObservation({
      transcript: { malformedLineCount: 0, strictStructuralIssues: [{ type: 'result_count', count: 0 }], effectiveStructuralIssues: [{ type: 'result_count', count: 0 }], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects terminal.present:false with no result_count issue reported at all', () => {
    const observation = minimalConsistentObservation({
      terminal: { present: false, isError: null, turnCount: null, finalText: null, resultSubtype: null, usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts terminal.present:false paired with a genuine result_count:0 issue (using strict, even when effective tolerated it away)', () => {
    const observation = minimalConsistentObservation({
      process: { exitCode: null, terminated: true, terminationReason: 'timeout', spawnHrtimeNs: 0n, endedHrtimeNs: 1n },
      terminal: { present: false, isError: null, turnCount: null, finalText: null, resultSubtype: null, usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
      transcript: { malformedLineCount: 0, strictStructuralIssues: [{ type: 'result_count', count: 0 }], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    });
    expect(validateObservation(observation).ok).toBe(true);
  });
});

// Round 4, finding 14: round 3's own new invariants were verified via a throwaway script and
// deleted, never persisted -- pinned here as durable regressions, each reproducing exactly one of
// the 6 examples confirmed live against the pre-round-3 contract.mjs.
describe('validateObservation -- round-3 P1 bypass examples, pinned as durable regressions', () => {
  it('rejects duplicate_tool_use_id with count:0 (a "duplicate" requires count>=2)', () => {
    const observation = minimalConsistentObservation({
      transcript: { malformedLineCount: 0, strictStructuralIssues: [{ type: 'duplicate_tool_use_id', id: 'x', count: 0 }], effectiveStructuralIssues: [{ type: 'duplicate_tool_use_id', id: 'x', count: 0 }], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects result_not_last with resultIndex at eventsLength-1 (contradicts "not last")', () => {
    const observation = minimalConsistentObservation({
      transcript: { malformedLineCount: 0, strictStructuralIssues: [{ type: 'result_not_last', resultIndex: 4, eventsLength: 5 }], effectiveStructuralIssues: [{ type: 'result_not_last', resultIndex: 4, eventsLength: 5 }], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects a negative receiptNs on a toolAttempt', () => {
    const attempt = validToolAttempt({ kind: 'shell', eventIndex: 0, receiptNs: -5n });
    const observation = minimalConsistentObservation({ toolAttempts: [attempt] });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects terminated:true with terminationReason:null', () => {
    const observation = minimalConsistentObservation({
      process: { exitCode: null, terminated: true, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 1n },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects everyCallHooked:true paired with hookPairingOk:false', () => {
    const observation = minimalConsistentObservation({
      hookStats: { hookCallCount: 2, hookResponseCount: 1, hookDenyCount: 0, hookAllowCount: 1, hookPairingOk: false, everyCallHooked: true },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects a targetInvocation with zero matching toolAttempts at all', () => {
    const observation = minimalConsistentObservation({
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        targetInvocation: { attempted: true, confirmed: true, attemptCount: 1, eventIndex: 7, receiptNs: 1n, resultIsError: false },
      },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });
});

// Round 4, finding 15: the round-1/round-3 equivalence test only compared OUTPUTS -- a future
// independent reimplementation producing byte-identical output would still pass silently. Pins the
// actual re-export IDENTITY (the same function object), not just equal behavior.
describe('canonicalNamesKey/fingerprintNames -- stream-parser.mjs re-exports the EXACT SAME function objects, not just equal-output copies', () => {
  it('canonicalAmbientSkillNamesKey IS canonicalNamesKey (reference equality)', async () => {
    const { canonicalAmbientSkillNamesKey } = await import('../../tools/agentic-eval/stream-parser.mjs');
    expect(canonicalAmbientSkillNamesKey).toBe(canonicalNamesKey);
  });

  it('fingerprintAmbientSkillNames IS fingerprintNames (reference equality)', async () => {
    const { fingerprintAmbientSkillNames } = await import('../../tools/agentic-eval/stream-parser.mjs');
    expect(fingerprintAmbientSkillNames).toBe(fingerprintNames);
  });
});

// Round 5: the canonical projection for targetInvocation/foreignInvocations/strictIncompleteToolResults
// must be a full ORDERED, ONE-TO-ONE match against the real producer's own selection algorithm --
// existence/count/Set-based checks (round 4) are not enough, since they can both under-reject
// (accept a wrong representative, or a collapsed/reordered array) AND over-reject (a find(eventIndex)
// grabbing the WRONG concurrent attempt at a shared index, rejecting genuinely valid producer output).
describe('validateObservation -- skill.targetInvocation is the CANONICAL first-confirmed-else-last representative, not just any same-eventIndex match (round 5)', () => {
  it('rejects targetInvocation pointing to the SECOND of two confirmed attempts (findSkillInvocation picks the FIRST confirmed)', () => {
    const a1 = validToolAttempt({ id: 'a1', kind: 'skill', eventIndex: 3, receiptNs: 3n, targetsExpectedSkill: true, command: null, result: { found: true, eventIndex: 4, isError: false, text: 'ok', textStatus: 'text' } });
    const a2 = validToolAttempt({ id: 'a2', kind: 'skill', eventIndex: 7, receiptNs: 7n, targetsExpectedSkill: true, command: null, result: { found: true, eventIndex: 8, isError: false, text: 'ok', textStatus: 'text' } });
    const observation = minimalConsistentObservation({
      toolAttempts: [a1, a2],
      timing: { receiptNsByEventIndex: new Map([[3, 3n], [7, 7n]]) },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        targetInvocation: { attempted: true, confirmed: true, attemptCount: 2, eventIndex: 7, receiptNs: 7n, resultIsError: false },
      },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts targetInvocation correctly pointing to the FIRST of two confirmed attempts', () => {
    const a1 = validToolAttempt({ id: 'a1', kind: 'skill', eventIndex: 3, receiptNs: 3n, targetsExpectedSkill: true, command: null, result: { found: true, eventIndex: 4, isError: false, text: 'ok', textStatus: 'text' } });
    const a2 = validToolAttempt({ id: 'a2', kind: 'skill', eventIndex: 7, receiptNs: 7n, targetsExpectedSkill: true, command: null, result: { found: true, eventIndex: 8, isError: false, text: 'ok', textStatus: 'text' } });
    const observation = minimalConsistentObservation({
      toolAttempts: [a1, a2],
      timing: { receiptNsByEventIndex: new Map([[3, 3n], [7, 7n]]) },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        targetInvocation: { attempted: true, confirmed: true, attemptCount: 2, eventIndex: 3, receiptNs: 3n, resultIsError: false },
      },
    });
    expect(validateObservation(observation).ok).toBe(true);
  });

  it('accepts targetInvocation correctly reflecting the CONFIRMED attempt when a concurrent one at the SAME eventIndex failed first (a real producer shape that a naive find(eventIndex) would wrongly reject)', () => {
    const fail = validToolAttempt({ id: 'fail', kind: 'skill', eventIndex: 5, receiptNs: 5n, targetsExpectedSkill: true, command: null, result: { found: true, eventIndex: 6, isError: true, text: 'err', textStatus: 'text' } });
    const ok2 = validToolAttempt({ id: 'ok2', kind: 'skill', eventIndex: 5, receiptNs: 5n, targetsExpectedSkill: true, command: null, result: { found: true, eventIndex: 9, isError: false, text: 'ok', textStatus: 'text' } });
    const observation = minimalConsistentObservation({
      toolAttempts: [fail, ok2],
      timing: { receiptNsByEventIndex: new Map([[5, 5n]]) },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        targetInvocation: { attempted: true, confirmed: true, attemptCount: 2, eventIndex: 5, receiptNs: 5n, resultIsError: false },
      },
    });
    expect(validateObservation(observation).ok).toBe(true);
  });

  it('rejects targetInvocation reflecting the FAILED attempt when a concurrent one at the same eventIndex actually confirmed', () => {
    const fail = validToolAttempt({ id: 'fail', kind: 'skill', eventIndex: 5, receiptNs: 5n, targetsExpectedSkill: true, command: null, result: { found: true, eventIndex: 6, isError: true, text: 'err', textStatus: 'text' } });
    const ok2 = validToolAttempt({ id: 'ok2', kind: 'skill', eventIndex: 5, receiptNs: 5n, targetsExpectedSkill: true, command: null, result: { found: true, eventIndex: 9, isError: false, text: 'ok', textStatus: 'text' } });
    const observation = minimalConsistentObservation({
      toolAttempts: [fail, ok2],
      timing: { receiptNsByEventIndex: new Map([[5, 5n]]) },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        // resultIsError:true would match the FAILED attempt, not the confirmed one -- wrong.
        targetInvocation: { attempted: true, confirmed: true, attemptCount: 2, eventIndex: 5, receiptNs: 5n, resultIsError: true },
      },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts targetInvocation correctly pointing to the LAST attempt when NONE are confirmed', () => {
    const a1 = validToolAttempt({ id: 'a1', kind: 'skill', eventIndex: 3, receiptNs: 3n, targetsExpectedSkill: true, command: null, result: { found: true, eventIndex: 4, isError: true, text: 'no', textStatus: 'text' } });
    const a2 = validToolAttempt({ id: 'a2', kind: 'skill', eventIndex: 7, receiptNs: 7n, targetsExpectedSkill: true, command: null, result: { found: true, eventIndex: 8, isError: true, text: 'no', textStatus: 'text' } });
    const observation = minimalConsistentObservation({
      toolAttempts: [a1, a2],
      timing: { receiptNsByEventIndex: new Map([[3, 3n], [7, 7n]]) },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        targetInvocation: { attempted: true, confirmed: false, attemptCount: 2, eventIndex: 7, receiptNs: 7n, resultIsError: true },
      },
    });
    expect(validateObservation(observation).ok).toBe(true);
  });

  it('rejects targetInvocation pointing to the FIRST (unconfirmed) attempt when none are confirmed (should point to the LAST)', () => {
    const a1 = validToolAttempt({ id: 'a1', kind: 'skill', eventIndex: 3, receiptNs: 3n, targetsExpectedSkill: true, command: null, result: { found: true, eventIndex: 4, isError: true, text: 'no', textStatus: 'text' } });
    const a2 = validToolAttempt({ id: 'a2', kind: 'skill', eventIndex: 7, receiptNs: 7n, targetsExpectedSkill: true, command: null, result: { found: true, eventIndex: 8, isError: true, text: 'no', textStatus: 'text' } });
    const observation = minimalConsistentObservation({
      toolAttempts: [a1, a2],
      timing: { receiptNsByEventIndex: new Map([[3, 3n], [7, 7n]]) },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        targetInvocation: { attempted: true, confirmed: false, attemptCount: 2, eventIndex: 3, receiptNs: 3n, resultIsError: true },
      },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  // Round 6: the receiptNs comparison above was only ever enforced when the representative's own
  // receiptNs was a bigint (`typeof representative.receiptNs === 'bigint' && ...`) -- when the real
  // producer legitimately emits receiptNs:null (no _receiptNs captured on that event), the whole
  // check was skipped, so targetInvocation.receiptNs could claim ANY bigint unchecked. Fixed to an
  // unconditional `ti.receiptNs !== representative.receiptNs` (correct for both bigint and null).
  it('rejects targetInvocation.receiptNs:999n when the real representative attempt has receiptNs:null', () => {
    const a1 = validToolAttempt({ id: 'a1', kind: 'skill', eventIndex: 3, receiptNs: null, targetsExpectedSkill: true, command: null, result: { found: true, eventIndex: 4, isError: false, text: 'ok', textStatus: 'text' } });
    const observation = minimalConsistentObservation({
      toolAttempts: [a1],
      timing: { receiptNsByEventIndex: new Map() },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        targetInvocation: { attempted: true, confirmed: true, attemptCount: 1, eventIndex: 3, receiptNs: 999n, resultIsError: false },
      },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts targetInvocation.receiptNs:null correctly matching a real representative attempt with receiptNs:null', () => {
    const a1 = validToolAttempt({ id: 'a1', kind: 'skill', eventIndex: 3, receiptNs: null, targetsExpectedSkill: true, command: null, result: { found: true, eventIndex: 4, isError: false, text: 'ok', textStatus: 'text' } });
    const observation = minimalConsistentObservation({
      toolAttempts: [a1],
      timing: { receiptNsByEventIndex: new Map() },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        targetInvocation: { attempted: true, confirmed: true, attemptCount: 1, eventIndex: 3, receiptNs: null, resultIsError: false },
      },
    });
    expect(validateObservation(observation).ok).toBe(true);
  });
});

describe('validateObservation -- skill.foreignInvocations is an exact ORDERED 1:1 projection of foreign toolAttempts, not a Set/find(eventIndex) match (round 5)', () => {
  function foreignAttempts() {
    const f1 = validToolAttempt({ id: 'f1', kind: 'skill', eventIndex: 2, receiptNs: 2n, targetsExpectedSkill: false, command: null, skillReference: 'other:a', result: { found: true, eventIndex: 10, isError: true, text: 'no', textStatus: 'text' } });
    const f2 = validToolAttempt({ id: 'f2', kind: 'skill', eventIndex: 2, receiptNs: 2n, targetsExpectedSkill: false, command: null, skillReference: 'other:b', result: { found: true, eventIndex: 11, isError: false, text: 'ok', textStatus: 'text' } });
    return [f1, f2];
  }
  function correctProjection() {
    return [
      { eventIndex: 2, receiptNs: 2n, id: 'f1', skillReference: 'other:a', resultIsError: true, confirmed: false },
      { eventIndex: 2, receiptNs: 2n, id: 'f2', skillReference: 'other:b', resultIsError: false, confirmed: true },
    ];
  }
  function withForeign(toolAttempts, foreignInvocations) {
    return minimalConsistentObservation({
      toolAttempts,
      timing: { receiptNsByEventIndex: new Map([[2, 2n]]) },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, targetInvocation: null,
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        foreignInvocations,
      },
    });
  }

  it('rejects MISSING a foreignInvocations entry (2 real foreign attempts, only 1 entry -- two concurrent foreign calls collapsed to one)', () => {
    const observation = withForeign(foreignAttempts(), correctProjection().slice(0, 1));
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects an EXTRA foreignInvocations entry (1 real foreign attempt, 2 entries -- a phantom invocation)', () => {
    const [f1] = foreignAttempts();
    const observation = withForeign([f1], [
      { eventIndex: 2, receiptNs: 2n, id: 'f1', skillReference: 'other:a', resultIsError: true, confirmed: false },
      { eventIndex: 2, receiptNs: 2n, id: 'phantom', skillReference: 'other:z', resultIsError: false, confirmed: true },
    ]);
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects a REORDERED foreignInvocations array (same 2 entries, swapped relative to real event order)', () => {
    const attempts = foreignAttempts();
    const projection = correctProjection();
    const observation = withForeign(attempts, [projection[1], projection[0]]);
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects a foreignInvocations entry with a FALSIFIED skillReference', () => {
    const [f1] = foreignAttempts();
    const observation = withForeign([f1], [
      { eventIndex: 2, receiptNs: 2n, id: 'f1', skillReference: 'FALSIFIED:not-real', resultIsError: true, confirmed: false },
    ]);
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts a correctly-ordered, fully-consistent 2-entry foreignInvocations projection', () => {
    const observation = withForeign(foreignAttempts(), correctProjection());
    expect(validateObservation(observation).ok).toBe(true);
  });

  // Round 6: `receiptOk` above was only ever enforced when the attempt's own receiptNs was a bigint
  // (`typeof attempt.receiptNs !== 'bigint' || ...`) -- when the real producer legitimately emits
  // receiptNs:null, receiptOk was unconditionally true, so a foreignInvocations entry could claim
  // ANY bigint unchecked. Fixed to an unconditional `fi.receiptNs !== attempt.receiptNs`.
  it('rejects a foreignInvocations entry with receiptNs:999n when the real attempt has receiptNs:null', () => {
    // Not using withForeign() here -- its own timing map is hardcoded to [[2, 2n]], which would
    // itself conflict with a receiptNs:null attempt (a DIFFERENT, already-covered invariant) and
    // stop this test from isolating the ONE property under test. An empty timing map is the
    // consistent counterpart to a null attempt.receiptNs.
    const f1 = validToolAttempt({ id: 'f1', kind: 'skill', eventIndex: 2, receiptNs: null, targetsExpectedSkill: false, command: null, skillReference: 'other:a', result: { found: true, eventIndex: 10, isError: true, text: 'no', textStatus: 'text' } });
    const observation = minimalConsistentObservation({
      toolAttempts: [f1],
      timing: { receiptNsByEventIndex: new Map() },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, targetInvocation: null,
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        foreignInvocations: [{ eventIndex: 2, receiptNs: 999n, id: 'f1', skillReference: 'other:a', resultIsError: true, confirmed: false }],
      },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts a foreignInvocations entry with receiptNs:null correctly matching a real attempt with receiptNs:null', () => {
    const f1 = validToolAttempt({ id: 'f1', kind: 'skill', eventIndex: 2, receiptNs: null, targetsExpectedSkill: false, command: null, skillReference: 'other:a', result: { found: true, eventIndex: 10, isError: true, text: 'no', textStatus: 'text' } });
    const observation = minimalConsistentObservation({
      toolAttempts: [f1],
      timing: { receiptNsByEventIndex: new Map() },
      skill: {
        available: true, profileMatchesCondition: true, snapshotBindingMatches: true, targetInvocation: null,
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        foreignInvocations: [{ eventIndex: 2, receiptNs: null, id: 'f1', skillReference: 'other:a', resultIsError: true, confirmed: false }],
      },
    });
    expect(validateObservation(observation).ok).toBe(true);
  });
});

describe('validateObservation -- strictIncompleteToolResults is an exact ORDERED projection WITH multiplicity, not a Set of indices (round 5)', () => {
  function incompleteAttempts() {
    const i1 = validToolAttempt({ id: 'i1', kind: 'shell', eventIndex: 5, receiptNs: 5n, skillReference: null, targetsExpectedSkill: null, result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' } });
    const i2 = validToolAttempt({ id: 'i2', kind: 'shell', eventIndex: 5, receiptNs: 5n, skillReference: null, targetsExpectedSkill: null, result: { found: false, eventIndex: null, isError: null, text: null, textStatus: 'missing' } });
    return [i1, i2];
  }
  function withIncomplete(toolAttempts, incomplete) {
    return minimalConsistentObservation({
      toolAttempts,
      timing: { receiptNsByEventIndex: new Map([[5, 5n]]) },
      hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: false },
      transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: incomplete, effectiveIncompleteToolResults: incomplete },
    });
  }

  it('rejects TWO concurrent result.found:false toolAttempts represented by only ONE strictIncompleteToolResults entry', () => {
    const observation = withIncomplete(incompleteAttempts(), [{ index: 5, receiptNs: 5n, name: 'Bash', id: 'i1' }]);
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts TWO concurrent incomplete attempts represented by TWO matching entries, in order', () => {
    const observation = withIncomplete(incompleteAttempts(), [
      { index: 5, receiptNs: 5n, name: 'Bash', id: 'i1' },
      { index: 5, receiptNs: 5n, name: 'Bash', id: 'i2' },
    ]);
    expect(validateObservation(observation).ok).toBe(true);
  });

  it('rejects the same TWO entries in REORDERED form (id i2 before i1, contradicting real event order)', () => {
    const observation = withIncomplete(incompleteAttempts(), [
      { index: 5, receiptNs: 5n, name: 'Bash', id: 'i2' },
      { index: 5, receiptNs: 5n, name: 'Bash', id: 'i1' },
    ]);
    expect(validateObservation(observation).ok).toBe(false);
  });
});

describe('validateObservation -- structurally impossible combinations within strictStructuralIssues (round 5)', () => {
  it('rejects init_count and init_not_first co-occurring (the producer only computes init_not_first when initIndices.length===1, contradicting any init_count issue)', () => {
    const issues = [{ type: 'init_count', count: 2 }, { type: 'init_not_first', initIndex: 3 }];
    const observation = minimalConsistentObservation({
      transcript: { malformedLineCount: 0, strictStructuralIssues: issues, effectiveStructuralIssues: issues, strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects result_count and result_not_last co-occurring (same exclusion, the result-side pair)', () => {
    const issues = [{ type: 'result_count', count: 0 }, { type: 'result_not_last', resultIndex: 2, eventsLength: 5 }];
    const observation = minimalConsistentObservation({
      terminal: { present: false, isError: null, turnCount: null, finalText: null, resultSubtype: null, usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
      transcript: { malformedLineCount: 0, strictStructuralIssues: issues, effectiveStructuralIssues: issues, strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('accepts init_not_first and result_not_last co-occurring (both legitimately fire together when exactly one init/result exist but are misplaced)', () => {
    const issues = [{ type: 'init_not_first', initIndex: 1 }, { type: 'result_not_last', resultIndex: 2, eventsLength: 5 }];
    const observation = minimalConsistentObservation({
      transcript: { malformedLineCount: 0, strictStructuralIssues: issues, effectiveStructuralIssues: issues, strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    });
    expect(validateObservation(observation).ok).toBe(true);
  });

  it('rejects two duplicate_tool_use_id issues sharing the same id (toolUseIdCounts is a Map -- one issue per unique id, never two)', () => {
    const issues = [{ type: 'duplicate_tool_use_id', id: 'toolu_1', count: 2 }, { type: 'duplicate_tool_use_id', id: 'toolu_1', count: 3 }];
    const observation = minimalConsistentObservation({
      transcript: { malformedLineCount: 0, strictStructuralIssues: issues, effectiveStructuralIssues: issues, strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });

  it('rejects two orphan_tool_result issues both with id:null (toolResultIdCounts keys id:null once -- at most one such issue)', () => {
    const issues = [{ type: 'orphan_tool_result', id: null }, { type: 'orphan_tool_result', id: null }];
    const observation = minimalConsistentObservation({
      transcript: { malformedLineCount: 0, strictStructuralIssues: issues, effectiveStructuralIssues: issues, strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    });
    expect(validateObservation(observation).ok).toBe(false);
  });
});

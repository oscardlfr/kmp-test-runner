// tests/vitest/agentic-eval-stream-parser.test.js
// Unit tests for tools/agentic-eval/stream-parser.mjs, using the sanitized synthetic fixtures
// derived from real Step-1 captures (never the raw capture itself -- see fixtures/README notes).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseStreamJsonl,
  findInitEvent,
  findResultEvent,
  isSkillAvailable,
  findSkillInvocation,
  findBashToolUses,
  countHookEvents,
  computeByteMetrics,
  extractTokenUsage,
  deriveFirstUsefulSignalMs,
} from '../../tools/agentic-eval/stream-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const currentSkillRaw = readFileSync(path.join(__dirname, 'fixtures', 'agentic-eval-stream-current-skill.jsonl'), 'utf8');
const noSkillRaw = readFileSync(path.join(__dirname, 'fixtures', 'agentic-eval-stream-no-skill.jsonl'), 'utf8');
const malformedRaw = '{"type":"system","subtype":"init","tools":["Bash"]}\nnot valid json at all\n{"type":"result","subtype":"success"}\n';

describe('parseStreamJsonl', () => {
  it('parses every well-formed line of a real (sanitized) current-skill capture', () => {
    const { events, malformedLines } = parseStreamJsonl(currentSkillRaw);
    expect(events.length).toBeGreaterThan(0);
    expect(malformedLines).toEqual([]);
  });

  it('tags every event with a receipt index/ns', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    for (const ev of events) expect(ev._receiptNs).toBeDefined();
  });

  it('isolates malformed lines instead of throwing, and still parses the well-formed ones around them', () => {
    const { events, malformedLines } = parseStreamJsonl(malformedRaw);
    expect(events.length).toBe(2);
    expect(malformedLines.length).toBe(1);
    expect(malformedLines[0].line).toContain('not valid json');
  });

  it('handles a fully empty capture without throwing', () => {
    const { events, malformedLines } = parseStreamJsonl('');
    expect(events).toEqual([]);
    expect(malformedLines).toEqual([]);
  });

  it('isolates syntactically-valid JSON that is not an event object (null/string/number/array), instead of crashing on the whole parse', () => {
    // Each of these parses successfully via JSON.parse -- assigning _receiptNs to a
    // non-object throws in strict mode (every .mjs is strict), which would previously abort
    // the entire parse rather than just skipping the one malformed line.
    const raw = [
      '{"type":"system","subtype":"init","tools":["Bash"]}',
      'null',
      '"just a string"',
      '42',
      '[1,2,3]',
      '{"type":"result","subtype":"success"}',
    ].join('\n');
    const { events, malformedLines } = parseStreamJsonl(raw);
    expect(events.length).toBe(2);
    expect(events[0].type).toBe('system');
    expect(events[1].type).toBe('result');
    expect(malformedLines.length).toBe(4);
    for (const m of malformedLines) expect(m.error).toContain('must be a JSON object');
  });
});

describe('skill availability and invocation detection (real captured event shapes)', () => {
  it('current-skill fixture: skill is available in init.plugins', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    const init = findInitEvent(events);
    expect(isSkillAvailable(init, 'kmp-test-runner')).toBe(true);
  });

  it('current-skill fixture: a real Skill tool_use event is found, not inferred', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    const invocation = findSkillInvocation(events, 'kmp-test-runner');
    expect(invocation).not.toBeNull();
    expect(invocation.type).toBe('assistant.tool_use.Skill');
    expect(typeof invocation.index).toBe('number');
  });

  it('no-skill fixture: skill is absent from init.plugins', () => {
    const { events } = parseStreamJsonl(noSkillRaw);
    const init = findInitEvent(events);
    expect(isSkillAvailable(init, 'kmp-test-runner')).toBe(false);
  });

  it('no-skill fixture: no Skill tool_use event is found', () => {
    const { events } = parseStreamJsonl(noSkillRaw);
    expect(findSkillInvocation(events, 'kmp-test-runner')).toBeNull();
  });

  it('does not match a differently-named skill', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    expect(findSkillInvocation(events, 'some-other-skill')).toBeNull();
  });
});

describe('hook accounting -- proves every Bash call reached the policy hook', () => {
  it('counts hook_started/hook_response 1:1 with Bash tool_use calls in a real capture', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    const bashCalls = findBashToolUses(events);
    const hookStats = countHookEvents(events);
    expect(hookStats.hookCallCount).toBe(bashCalls.length);
    expect(hookStats.hookResponseCount).toBe(bashCalls.length);
    expect(hookStats.everyCallHooked).toBe(true);
  });

  it('reports everyCallHooked:false when counts diverge', () => {
    const events = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'x' } }] } },
    ];
    expect(countHookEvents(events).everyCallHooked).toBe(false);
  });

  function hookEvent(subtype, hookId, extra = {}) {
    return { type: 'system', subtype, hook_id: hookId, hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', ...extra };
  }
  function bashUse() {
    return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'x' } }] } };
  }
  const allowResponse = { output: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }) };

  it('reports everyCallHooked:false when a duplicate hook_id makes aggregate counts balance despite one Bash call never being hooked', () => {
    // 2 real Bash calls, but the SAME hook_id fires twice for the first one while the second
    // call is never hooked at all -- a pure count comparison (2 Bash === 2 started === 2
    // response) would wrongly report true; id-set/uniqueness checking must catch this.
    const events = [
      bashUse(),
      hookEvent('hook_started', 'dup-id'), hookEvent('hook_started', 'dup-id'),
      hookEvent('hook_response', 'dup-id', allowResponse), hookEvent('hook_response', 'dup-id', allowResponse),
      bashUse(),
    ];
    const stats = countHookEvents(events);
    expect(stats.hookCallCount).toBe(2);
    expect(stats.hookResponseCount).toBe(2);
    expect(stats.everyCallHooked).toBe(false);
  });

  it('ignores hook events for a different hook_name (non-Bash tool) when counting', () => {
    const events = [
      bashUse(),
      hookEvent('hook_started', 'id-1'), hookEvent('hook_response', 'id-1', allowResponse),
      { type: 'system', subtype: 'hook_started', hook_id: 'id-unrelated', hook_name: 'PreToolUse:SomeOtherTool', hook_event: 'PreToolUse' },
      { type: 'system', subtype: 'hook_response', hook_id: 'id-unrelated', hook_name: 'PreToolUse:SomeOtherTool', hook_event: 'PreToolUse', ...allowResponse },
    ];
    const stats = countHookEvents(events);
    expect(stats.hookCallCount).toBe(1);
    expect(stats.hookResponseCount).toBe(1);
    expect(stats.everyCallHooked).toBe(true);
  });

  it('reports everyCallHooked:true for genuinely distinct, correctly-paired hook ids (real fixture, post-fix)', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    const stats = countHookEvents(events);
    expect(stats.hookCallCount).toBe(2);
    expect(new Set(events.filter((e) => e.subtype === 'hook_started').map((e) => e.hook_id)).size).toBe(2);
    expect(stats.everyCallHooked).toBe(true);
  });
});

describe('byte metrics -- output_bytes vs stream_json_bytes are distinct numbers', () => {
  it('computes two different, correctly-scoped values from the same capture', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    const { outputBytes, streamJsonBytes } = computeByteMetrics(currentSkillRaw, events);
    expect(typeof outputBytes).toBe('number');
    expect(typeof streamJsonBytes).toBe('number');
    expect(streamJsonBytes).toBeGreaterThan(outputBytes);
    expect(streamJsonBytes).toBe(Buffer.byteLength(currentSkillRaw, 'utf8'));
  });
});

describe('extractTokenUsage', () => {
  it('extracts the four token fields from a real result event', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    const result = findResultEvent(events);
    const usage = extractTokenUsage(result);
    expect(usage).toHaveProperty('input');
    expect(usage).toHaveProperty('output');
    expect(usage).toHaveProperty('cache_read');
    expect(usage).toHaveProperty('cache_creation');
  });

  it('returns null when there is no result event', () => {
    expect(extractTokenUsage(null)).toBeNull();
  });
});

describe('deriveFirstUsefulSignalMs -- index-to-ms derivation is the only place timing happens', () => {
  it('derives a non-negative ms value from a valid event index', () => {
    const { events } = parseStreamJsonl(currentSkillRaw, {
      taggedLines: currentSkillRaw.split('\n').filter(Boolean).map((line, i) => ({ line, receiptNs: BigInt(i) * 1000000n })),
    });
    const ms = deriveFirstUsefulSignalMs(events, 2, 0n);
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it('returns null for a null index', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    expect(deriveFirstUsefulSignalMs(events, null, 0n)).toBeNull();
  });

  it('returns null for an out-of-range index', () => {
    const { events } = parseStreamJsonl(currentSkillRaw);
    expect(deriveFirstUsefulSignalMs(events, 99999, 0n)).toBeNull();
  });
});

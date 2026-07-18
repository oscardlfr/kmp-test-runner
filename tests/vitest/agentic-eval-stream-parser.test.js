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

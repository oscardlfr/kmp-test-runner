// tests/vitest/agentic-eval-graders.test.js
// Unit tests for tools/agentic-eval/graders.mjs -- deterministic, index-returning predicates
// against synthetic transcript text. No LLM judge, no Claude call.
import { describe, it, expect } from 'vitest';
import {
  makeTextContainsGrader,
  makeFirstMatchSignalPredicate,
  getGrader,
  registerGrader,
} from '../../tools/agentic-eval/graders.mjs';

describe('makeTextContainsGrader', () => {
  it('matches when all patterns are present', () => {
    const grade = makeTextContainsGrader(['pass', /module/i]);
    const result = grade({ result: 'all tests pass in the shared module' });
    expect(result.matched).toBe(true);
  });

  it('does not match when a pattern is missing', () => {
    const grade = makeTextContainsGrader(['pass', 'coverage']);
    const result = grade({ result: 'all tests pass' });
    expect(result.matched).toBe(false);
  });

  it('handles a missing/non-string result gracefully (never throws)', () => {
    const grade = makeTextContainsGrader(['pass']);
    expect(() => grade(null)).not.toThrow();
    expect(grade(null).matched).toBe(false);
    expect(grade({}).matched).toBe(false);
  });

  it('always returns a {matched, reason} shape', () => {
    const grade = makeTextContainsGrader(['x']);
    const result = grade({ result: 'x' });
    expect(result).toHaveProperty('matched');
    expect(result).toHaveProperty('reason');
    expect(typeof result.reason).toBe('string');
  });
});

describe('makeFirstMatchSignalPredicate', () => {
  it('returns the index of the first matching event, not the first event overall', () => {
    const findSignal = makeFirstMatchSignalPredicate(['FAIL']);
    const events = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'checking' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'test FAIL' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'also FAIL mentioned here' }] } },
    ];
    const signal = findSignal(events);
    expect(signal.index).toBe(1);
  });

  it('returns null when nothing matches', () => {
    const findSignal = makeFirstMatchSignalPredicate(['this-will-never-appear']);
    const events = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'all clean' }] } }];
    expect(findSignal(events)).toBeNull();
  });

  it('returns an event index, never a timestamp -- timing is derived elsewhere (stream-parser.mjs)', () => {
    const findSignal = makeFirstMatchSignalPredicate(['x']);
    const events = [{ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }];
    const signal = findSignal(events);
    expect(typeof signal.index).toBe('number');
    expect(signal).not.toHaveProperty('ms');
    expect(signal).not.toHaveProperty('timestamp');
  });

  it('handles events with no content gracefully', () => {
    const findSignal = makeFirstMatchSignalPredicate(['x']);
    expect(() => findSignal([{ type: 'system', subtype: 'init' }])).not.toThrow();
  });

  it('does not match on the injected prompt text or assistant prose -- only tool_use/tool_result blocks count as a signal', () => {
    // The very first user event in a real stream IS the injected prompt itself; a naive scan
    // of ALL content would let a scenario prompt that mentions its own subject (e.g.
    // "core:common") match at event 0, reporting a near-zero "useful signal" that proves
    // nothing actually ran. Covers both plausible raw-prompt shapes (a plain string, and an
    // array of only "text" blocks) plus assistant prose mentioning the same term.
    const findSignal = makeFirstMatchSignalPredicate(['core:common']);
    const events = [
      { type: 'user', message: { content: 'Check the core:common module for test coverage.' } },
      { type: 'user', message: { content: [{ type: 'text', text: 'core:common results please' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Let me look at core:common.' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'kmp-test parallel --module-filter core:common' } }] } },
    ];
    const signal = findSignal(events);
    expect(signal).not.toBeNull();
    expect(signal.index).toBe(3);
  });

  it('still matches a genuine user tool_result block, not just assistant tool_use', () => {
    const findSignal = makeFirstMatchSignalPredicate(['core:common']);
    const events = [
      { type: 'user', message: { content: 'core:common' } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'core:common: 12 tests passed' }] } },
    ];
    expect(findSignal(events).index).toBe(1);
  });
});

describe('grader registry', () => {
  it('all six named scenarios from the corpus have a registered grader', () => {
    const ids = [
      'kampkit-android-host-test-discovery',
      'kampkit-no-applicable-tests',
      'nowinandroid-core-common',
      'deterministic-unit-test-failure',
      'coverage-threshold-failure',
      'changed-module-verification',
    ];
    for (const id of ids) {
      const entry = getGrader(id);
      expect(typeof entry.grade).toBe('function');
      expect(typeof entry.findSignal).toBe('function');
    }
  });

  it('throws a clear error for an unregistered scenario id', () => {
    expect(() => getGrader('does-not-exist')).toThrow(/No grader registered/);
  });

  it('registerGrader allows registering a new scenario at runtime', () => {
    registerGrader('test-only-scenario-xyz', {
      grade: makeTextContainsGrader(['ok']),
      findSignal: makeFirstMatchSignalPredicate(['ok']),
    });
    expect(() => getGrader('test-only-scenario-xyz')).not.toThrow();
  });
});

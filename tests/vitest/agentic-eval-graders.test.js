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

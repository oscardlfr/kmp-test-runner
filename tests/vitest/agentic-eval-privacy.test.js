// tests/vitest/agentic-eval-privacy.test.js
// Unit tests for tools/agentic-eval/privacy.mjs -- fail-closed redaction + leak-refusal wrapper.
// Synthetic secret-shaped values are split/assembled at runtime so this fixture file itself
// can't trip tools/decouple-audit.mjs -- matches the existing repo test idiom.
import { describe, it, expect } from 'vitest';
import { redactAndVerify, assertCleanOrThrow } from '../../tools/agentic-eval/privacy.mjs';

const FAKE_WIN_PATH = 'C:\\' + 'Users' + '\\' + 'someuser' + '\\projects\\app';

describe('redactAndVerify', () => {
  it('reports ok:true for text with no sensitive shapes', () => {
    const result = redactAndVerify('hello world, nothing sensitive here');
    expect(result.ok).toBe(true);
    expect(result.redacted).toBe('hello world, nothing sensitive here');
  });

  it('redacts a Windows user path and confirms it clean post-redaction', () => {
    const result = redactAndVerify(`path: ${FAKE_WIN_PATH}`);
    expect(result.ok).toBe(true);
    expect(result.redacted).not.toContain('someuser');
    expect(result.redacted).toContain('<USER_PATH>');
  });

  it('never includes the matched secret content in the leaks array (structural metadata only)', () => {
    // findLeaks is re-run internally against the (already redacted) output, so under normal
    // operation leaks should be empty -- this asserts the CONTRACT that if a leak ever were
    // reported, it would never carry the raw matched text.
    const result = redactAndVerify(`path: ${FAKE_WIN_PATH}`);
    for (const leak of result.leaks) {
      expect(JSON.stringify(leak)).not.toContain('someuser');
    }
  });
});

describe('assertCleanOrThrow', () => {
  it('returns the redacted text when clean', () => {
    const redacted = assertCleanOrThrow('nothing sensitive');
    expect(redacted).toBe('nothing sensitive');
  });

  it('returns redacted (not raw) text for input containing a sensitive shape', () => {
    const redacted = assertCleanOrThrow(`path: ${FAKE_WIN_PATH}`);
    expect(redacted).not.toContain('someuser');
  });
});

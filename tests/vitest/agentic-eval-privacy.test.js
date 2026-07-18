// tests/vitest/agentic-eval-privacy.test.js
// Unit tests for tools/agentic-eval/privacy.mjs -- fail-closed redaction + leak-refusal wrapper.
// Synthetic secret-shaped values are split/assembled at runtime so this fixture file itself
// can't trip tools/decouple-audit.mjs -- matches the existing repo test idiom.
import { describe, it, expect } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactAndVerify, assertCleanOrThrow, redactObjectAndVerify, assertCleanOrThrowObject } from '../../tools/agentic-eval/privacy.mjs';

const FAKE_WIN_PATH = 'C:\\' + 'Users' + '\\' + 'someuser' + '\\projects\\app';

function writeTempPatternsFile(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'aep-patterns-'));
  const file = join(dir, 'patterns.json');
  writeFileSync(file, JSON.stringify(entries));
  return file;
}

function cleanupTempPatternsFile(file) {
  rmSync(join(file, '..'), { recursive: true, force: true });
}

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

  // Regression coverage for a real, reproduced bypass an independent review pass demonstrated:
  // calling this TEXT-level function on an ALREADY-JSON.stringify()'d blob silently fails to
  // redact a Windows path, because JSON.stringify() escapes every backslash as TWO characters
  // (\\), while the user_path_win rule's regex is written to match a SINGLE literal backslash.
  // This documents that failure mode directly (proving the bug is real, not hypothetical) --
  // the fix is to never call assertCleanOrThrow on pre-serialized JSON; use
  // assertCleanOrThrowObject on the raw object instead (see below).
  it('DOES NOT catch a Windows path once JSON.stringify() has already escaped its backslashes -- this is why object-level redaction exists', () => {
    const alreadySerialized = JSON.stringify({ path: FAKE_WIN_PATH });
    const redacted = assertCleanOrThrow(alreadySerialized);
    expect(redacted).toContain('someuser'); // the real, documented bypass -- NOT redacted
  });
});

describe('redactObjectAndVerify / assertCleanOrThrowObject', () => {
  it('redacts a Windows path nested in an object field -- closing the JSON-escaping bypass', () => {
    const result = redactObjectAndVerify({ project_alias: FAKE_WIN_PATH });
    expect(result.ok).toBe(true);
    expect(result.redactedObj.project_alias).not.toContain('someuser');
    expect(result.redactedObj.project_alias).toBe('<USER_PATH>');
    expect(result.redactedText).not.toContain('someuser');
  });

  it('redacts recursively through nested objects and arrays', () => {
    const result = redactObjectAndVerify({
      errors: [{ code: 'x', message: `see ${FAKE_WIN_PATH}` }],
      nested: { deeper: { path: FAKE_WIN_PATH } },
    });
    expect(result.ok).toBe(true);
    expect(result.redactedObj.errors[0].message).not.toContain('someuser');
    expect(result.redactedObj.nested.deeper.path).toBe('<USER_PATH>');
  });

  it('leaves non-string values (numbers, booleans, null) untouched', () => {
    const result = redactObjectAndVerify({ count: 5, ok: true, missing: null });
    expect(result.redactedObj).toEqual({ count: 5, ok: true, missing: null });
  });

  it('the returned redactedText is valid, re-parseable JSON even when a private-pattern replacement contains a raw newline', () => {
    // Regression coverage for a real bug: text-level redaction on an already-serialized blob
    // could substitute a raw newline INTO a JSON string literal, breaking JSON syntax.
    // Field-level redaction (this function) redacts the raw string BEFORE the one-and-only
    // JSON.stringify() call, so the output is always valid JSON no matter what the replacement
    // string contains -- JSON.stringify() itself correctly escapes it.
    const marker = 'breaks-json-marker';
    const privatePatternsFile = writeTempPatternsFile([{ class: 'x', literal: marker, replacement: 'line-one\nline-two' }]);
    try {
      const result = redactObjectAndVerify({ note: marker }, { privatePatternsFile });
      expect(result.ok).toBe(true);
      expect(() => JSON.parse(result.redactedText)).not.toThrow();
      expect(JSON.parse(result.redactedText).note).toBe('line-one\nline-two');
    } finally {
      cleanupTempPatternsFile(privatePatternsFile);
    }
  });

  it('assertCleanOrThrowObject returns {redactedObj, redactedText} when clean', () => {
    const { redactedObj, redactedText } = assertCleanOrThrowObject({ a: 'clean' });
    expect(redactedObj).toEqual({ a: 'clean' });
    expect(JSON.parse(redactedText)).toEqual({ a: 'clean' });
  });

  // Regression coverage for a real, reproduced bypass an independent review pass demonstrated
  // directly against this code: a private-pattern rule's own REPLACEMENT text can itself be
  // leak-shaped (e.g. a real Windows path instead of a placeholder token). redactValue() correctly
  // substitutes it into the raw field value, but the OLD verification pass then JSON.stringify()d
  // the whole object before scanning -- doubling the replacement's backslashes -- and
  // user_path_win's single-backslash regex silently missed the JSON-escaped form. Reproduced
  // directly: assertCleanOrThrowObject() returned the real path completely intact, no throw.
  // Fixed via findLeaksInValue(), which scans each raw string value before any serialization,
  // exactly mirroring redactValue()'s own recursion.
  it('refuses when a private-pattern REPLACEMENT is itself leak-shaped, even though the ORIGINAL field value was not', () => {
    const marker = 'leak-via-replacement-marker';
    const privatePatternsFile = writeTempPatternsFile([{ class: 'x', literal: marker, replacement: FAKE_WIN_PATH }]);
    try {
      expect(() => assertCleanOrThrowObject({ some_field: `this contains ${marker} inside it` }, { privatePatternsFile })).toThrow(/REFUSED/);
      const result = redactObjectAndVerify({ some_field: `this contains ${marker} inside it` }, { privatePatternsFile });
      expect(result.ok).toBe(false);
      expect(result.redactedObj).toBeNull();
      expect(result.leaks.some((l) => l.class === 'user_path_win')).toBe(true);
    } finally {
      cleanupTempPatternsFile(privatePatternsFile);
    }
  });
});

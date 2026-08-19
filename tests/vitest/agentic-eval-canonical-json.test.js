// tests/vitest/agentic-eval-canonical-json.test.js
// RED -> GREEN for tools/agentic-eval/canonical-json.mjs: the one canonical UTF-8 JSON
// serialization + SHA-256 helper this PR introduces, and schemas.mjs's re-export of the same
// function (no second, independently-drifting canonicalizer).
import { describe, it, expect } from 'vitest';
import {
  canonicalStructuredValue, canonicalJsonStringify, canonicalJsonSha256,
} from '../../tools/agentic-eval/canonical-json.mjs';
import { canonicalStructuredValue as schemasCanonicalStructuredValue } from '../../tools/agentic-eval/schemas.mjs';

describe('canonicalStructuredValue -- object key order is insertion-independent', () => {
  it('two objects with the same keys/values in a different insertion order canonicalize identically', () => {
    const a = { count: 1, fingerprint_hmac: 'x', scope_id: 'y' };
    const b = { scope_id: 'y', fingerprint_hmac: 'x', count: 1 };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });

  it('nested object key order is independent at every level', () => {
    const a = { outer: { z: 1, a: 2 }, first: true };
    const b = { first: true, outer: { a: 2, z: 1 } };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });

  it('keys are sorted by code point, not locale collation', () => {
    // '_' (0x5F) sorts AFTER uppercase letters but BEFORE lowercase 'a' in code-point order --
    // a locale-aware sort could reorder this differently across environments.
    const value = { b: 1, _: 2, A: 3 };
    expect(Object.keys(JSON.parse(canonicalJsonStringify(value)))).toEqual(['A', '_', 'b']);
  });
});

describe('canonicalStructuredValue -- arrays preserve insertion order (never sorted)', () => {
  it('two arrays with the same elements in a different order canonicalize DIFFERENTLY', () => {
    const a = ['x', 'y', 'z'];
    const b = ['z', 'y', 'x'];
    expect(canonicalJsonStringify(a)).not.toBe(canonicalJsonStringify(b));
  });

  it('array element order survives inside an object value', () => {
    const value = { list: [3, 1, 2] };
    expect(JSON.parse(canonicalJsonStringify(value)).list).toEqual([3, 1, 2]);
  });
});

describe('canonicalJsonStringify -- compact separators, no inserted whitespace', () => {
  it('produces no whitespace anywhere in the output', () => {
    const value = { a: [1, 2, { b: 'c' }], d: null };
    const text = canonicalJsonStringify(value);
    expect(text).not.toMatch(/\s/);
    expect(text).toBe('{"a":[1,2,{"b":"c"}],"d":null}');
  });
});

describe('canonicalStructuredValue -- rejects non-JSON-representable values', () => {
  it('throws on undefined', () => {
    expect(() => canonicalStructuredValue(undefined)).toThrow();
  });
  it('throws on a top-level bigint', () => {
    expect(() => canonicalStructuredValue(10n)).toThrow();
  });
  it('throws on a nested bigint', () => {
    expect(() => canonicalStructuredValue({ a: 10n })).toThrow();
  });
  it('throws on a function value', () => {
    expect(() => canonicalStructuredValue({ a: () => {} })).toThrow();
  });
  it('throws on a symbol value', () => {
    expect(() => canonicalStructuredValue({ a: Symbol('x') })).toThrow();
  });
  it('throws on NaN', () => {
    expect(() => canonicalStructuredValue(NaN)).toThrow();
  });
  it('throws on Infinity', () => {
    expect(() => canonicalStructuredValue(Infinity)).toThrow();
  });
  it('throws on a cyclic object', () => {
    const obj = { a: 1 };
    obj.self = obj;
    expect(() => canonicalStructuredValue(obj)).toThrow();
  });
  it('throws on a cyclic array', () => {
    const arr = [1, 2];
    arr.push(arr);
    expect(() => canonicalStructuredValue(arr)).toThrow();
  });
  it('throws on a non-plain object (a Map)', () => {
    expect(() => canonicalStructuredValue(new Map([['a', 1]]))).toThrow();
  });
  it('throws on a non-plain object (a Date)', () => {
    expect(() => canonicalStructuredValue(new Date())).toThrow();
  });
  it('throws on a non-plain object (a class instance)', () => {
    class Foo { constructor() { this.x = 1; } }
    expect(() => canonicalStructuredValue(new Foo())).toThrow();
  });
  it('throws on an object with a non-null-prototype chain (Object.create(realShape))', () => {
    const proto = { inherited: 1 };
    const obj = Object.create(proto);
    obj.own = 2;
    expect(() => canonicalStructuredValue(obj)).toThrow();
  });

  it('does NOT throw on legitimate JSON-safe values: null, booleans, finite numbers, strings, nested arrays/objects, Object.create(null)', () => {
    expect(() => canonicalStructuredValue(null)).not.toThrow();
    expect(() => canonicalStructuredValue(true)).not.toThrow();
    expect(() => canonicalStructuredValue(false)).not.toThrow();
    expect(() => canonicalStructuredValue(0)).not.toThrow();
    expect(() => canonicalStructuredValue(-3.5)).not.toThrow();
    expect(() => canonicalStructuredValue('hello')).not.toThrow();
    expect(() => canonicalStructuredValue([1, 'a', null, { b: [true, false] }])).not.toThrow();
    const nullProto = Object.create(null);
    nullProto.x = 1;
    expect(() => canonicalStructuredValue(nullProto)).not.toThrow();
  });
});

describe('canonicalJsonSha256 -- lowercase 64-char hex, stable, and sensitive to real changes', () => {
  it('returns a lowercase 64-char hex string', () => {
    const digest = canonicalJsonSha256({ a: 1 });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is identical for the same value with different key insertion order', () => {
    const d1 = canonicalJsonSha256({ x: 1, y: 2 });
    const d2 = canonicalJsonSha256({ y: 2, x: 1 });
    expect(d1).toBe(d2);
  });

  it('changes when array order changes', () => {
    const d1 = canonicalJsonSha256({ list: [1, 2, 3] });
    const d2 = canonicalJsonSha256({ list: [3, 2, 1] });
    expect(d1).not.toBe(d2);
  });

  it('changes when any nested value changes', () => {
    const d1 = canonicalJsonSha256({ a: { b: 1 } });
    const d2 = canonicalJsonSha256({ a: { b: 2 } });
    expect(d1).not.toBe(d2);
  });

  it('is deterministic across repeated calls with a freshly-constructed equal object', () => {
    const build = () => ({ z: 'last', a: 'first', nested: { q: 1, p: 2 } });
    expect(canonicalJsonSha256(build())).toBe(canonicalJsonSha256(build()));
  });
});

describe('schemas.mjs re-exports the SAME canonicalStructuredValue -- no second canonicalizer', () => {
  it('schemas.mjs\'s exported function is reference-identical to canonical-json.mjs\'s own', () => {
    expect(schemasCanonicalStructuredValue).toBe(canonicalStructuredValue);
  });
});

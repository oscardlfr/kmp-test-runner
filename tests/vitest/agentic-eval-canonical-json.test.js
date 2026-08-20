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

  // Codex round 2, Finding 5: canonicalStructuredValue's object branch builds its result via
  // `Object.keys(value)`, which silently excludes own Symbol-keyed properties and own
  // non-enumerable properties -- either one collapses `value` to canonicalize identically to `{}`,
  // even though the two are genuinely different values. The array branch's `.map()` similarly
  // never inspects a non-index own property, silently collapsing an array carrying one to the
  // same canonical form as a clean dense array of the same length. A getter/setter accessor
  // property is a THIRD, distinct hazard: even if its VALUE were included, invoking an adversarial
  // getter during canonicalization is itself unsafe (side effects, a throw, a value that changes
  // between calls) -- it must be rejected without ever being read.
  it('a Symbol-keyed own property does NOT canonicalize the same as {} -- it must throw, not silently vanish', () => {
    const withSymbol = { a: 1 };
    withSymbol[Symbol('secret')] = 'leaked-if-silently-dropped';
    expect(() => canonicalStructuredValue(withSymbol)).toThrow();
    // Sanity: the object WITHOUT the symbol key canonicalizes fine (isolates the symbol as the
    // one and only difference under test).
    expect(() => canonicalStructuredValue({ a: 1 })).not.toThrow();
  });

  it('a non-enumerable own property does NOT canonicalize the same as {} -- it must throw, not silently vanish', () => {
    const withHidden = { a: 1 };
    Object.defineProperty(withHidden, 'hidden', { value: 'leaked-if-silently-dropped', enumerable: false });
    expect(() => canonicalStructuredValue(withHidden)).toThrow();
  });

  it('a getter/setter accessor property is rejected WITHOUT ever invoking the getter', () => {
    let getterInvoked = false;
    const withAccessor = { a: 1 };
    Object.defineProperty(withAccessor, 'b', {
      enumerable: true, configurable: true,
      get() { getterInvoked = true; return 'value-from-getter'; },
    });
    expect(() => canonicalStructuredValue(withAccessor)).toThrow();
    expect(getterInvoked).toBe(false);
  });

  it('an array with an extra non-index own property does NOT canonicalize the same as a clean dense array of the same length', () => {
    const withExtra = [1, 2, 3];
    withExtra.extra = 'leaked-if-silently-dropped';
    expect(() => canonicalStructuredValue(withExtra)).toThrow();
    // Sanity: the same 3 elements WITHOUT the extra property canonicalize fine.
    expect(() => canonicalStructuredValue([1, 2, 3])).not.toThrow();
  });

  // Codex round 3, Finding 1: the array branch's own key-validation loop used `Number(key)` +
  // an integer/range check, but never verified the key ROUND-TRIPS back to the exact same string
  // -- "01", "1e0", and "-0" all coerce to a Number that Number.isInteger accepts and that falls
  // in range, yet none of them is the CANONICAL string form of that index (`String(0)` is "0",
  // never "01"/"1e0"/"-0"). Each is therefore a genuinely EXTRA own property distinct from the
  // real index 0, silently ignored by `.map()` just like the plain "extra" case above -- an
  // object-vs-array parity gap this specific check exists to close, still open for exactly these
  // 3 non-canonical numeric-string shapes.
  it.each(['01', '1e0', '-0'])('an array with a non-canonical numeric-string own property "%s" (coerces in-range but does not round-trip) does NOT canonicalize the same as a clean array', (key) => {
    const withNonCanonical = [1, 2, 3];
    Object.defineProperty(withNonCanonical, key, { value: 'leaked-if-silently-dropped', enumerable: true, configurable: true });
    expect(() => canonicalStructuredValue(withNonCanonical)).toThrow();
  });

  // Codex round 3, Finding 1: the array branch never inspected each index's own property
  // DESCRIPTOR at all (unlike the object branch, which checks enumerable/accessor via
  // getOwnPropertyDescriptor before ever reading a value) -- a getter planted at a perfectly
  // valid, in-range, canonical index string was invoked unconditionally by `.map()`, contradicting
  // this module's own documented "never invoke an adversarial getter" guarantee.
  it('a getter defined at a valid array index is rejected WITHOUT ever invoking it', () => {
    let getterInvoked = false;
    const withAccessor = [1, 2, 3];
    Object.defineProperty(withAccessor, '1', {
      enumerable: true, configurable: true,
      get() { getterInvoked = true; return 'value-from-getter'; },
    });
    expect(() => canonicalStructuredValue(withAccessor)).toThrow();
    expect(getterInvoked).toBe(false);
  });

  it('a non-enumerable value at a valid array index is rejected, not silently treated as a hole or skipped', () => {
    const withHiddenIndex = [1, 2, 3];
    Object.defineProperty(withHiddenIndex, '1', { value: 'leaked-if-silently-dropped', enumerable: false, configurable: true });
    expect(() => canonicalStructuredValue(withHiddenIndex)).toThrow();
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

describe('canonicalJsonStringify -- direct serialization, immune to JS object-key semantics (P1 architectural review)', () => {
  it('a null-prototype object with an own "__proto__" property does NOT canonicalize the same as {} (the __proto__ setter must never fire during canonicalization)', () => {
    const trap = Object.create(null);
    trap.__proto__ = 'not-a-prototype-just-a-string-value';
    // Sanity: the trap object really does have an own, enumerable "__proto__" string key, and its
    // OWN prototype is still null (the assignment above did not go through Object.prototype's
    // accessor, because `trap` itself has no prototype to intercept it).
    expect(Object.prototype.hasOwnProperty.call(trap, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(trap)).toBe(null);
    expect(canonicalJsonStringify(trap)).not.toBe(canonicalJsonStringify({}));
    expect(canonicalJsonStringify(trap)).toBe('{"__proto__":"not-a-prototype-just-a-string-value"}');
  });

  it('a sparse array (a real hole) is rejected, never silently coerced to null and collided with [null]', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [, 'x'];
    expect(sparse.length).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(sparse, 0)).toBe(false);
    expect(() => canonicalStructuredValue(sparse)).toThrow();
    expect(() => canonicalJsonStringify(sparse)).toThrow();
    // The dense value it would otherwise collide with must remain representable and different.
    expect(() => canonicalJsonStringify([null, 'x'])).not.toThrow();
  });

  it('integer-like keys are emitted in code-point order, not the special ascending-numeric order JSON.stringify/object enumeration applies to array-index-like keys', () => {
    // Code-point order of the strings "10" and "2": '1' (0x31) < '2' (0x32), so "10" sorts BEFORE
    // "2". Plain JS object enumeration (and a naive `JSON.stringify` of an already-built object)
    // would instead emit "2" before "10" -- ascending NUMERIC order for array-index-like keys,
    // regardless of insertion order. canonicalJsonStringify must never let that native reordering
    // leak into its output.
    const value = { 10: 'ten', 2: 'two' };
    expect(canonicalJsonStringify(value)).toBe('{"10":"ten","2":"two"}');
  });

  it('sorts a BMP/astral key pair by true Unicode scalar value, not by default UTF-16-code-unit string comparison', () => {
    // U+E000 (BMP, Private Use Area) vs U+10000 (astral, first Linear B character -- encoded as the
    // UTF-16 surrogate pair U+D800 U+DC00). By code POINT: 0xE000 (57344) > 0x10000 (65536) is
    // false, so U+E000 sorts before U+10000. By default JS string comparison (UTF-16 code UNIT),
    // the astral character's leading surrogate 0xD800 is LESS than 0xE000, so a naive `.sort()`
    // would put the astral key FIRST -- the opposite, wrong order.
    const bmpKey = '';
    const astralKey = '\u{10000}';
    expect(bmpKey.codePointAt(0)).toBe(0xE000);
    expect(astralKey.codePointAt(0)).toBe(0x10000);
    expect([astralKey, bmpKey].sort()[0]).toBe(astralKey); // proves the naive-sort trap is real
    const value = { [astralKey]: 'astral', [bmpKey]: 'bmp' };
    const text = canonicalJsonStringify(value);
    expect(text.indexOf(JSON.stringify(bmpKey))).toBeLessThan(text.indexOf(JSON.stringify(astralKey)));
  });
});

describe('schemas.mjs re-exports the SAME canonicalStructuredValue -- no second canonicalizer', () => {
  it('schemas.mjs\'s exported function is reference-identical to canonical-json.mjs\'s own', () => {
    expect(schemasCanonicalStructuredValue).toBe(canonicalStructuredValue);
  });
});

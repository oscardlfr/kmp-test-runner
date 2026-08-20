#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/canonical-json.mjs -- the one canonical UTF-8 JSON serialization this PR
// needs anywhere a byte-stable hash over a structured value is required (execution-profile
// identity, skill-snapshot manifest, sidecar provenance): object keys ordered by true Unicode code
// point at every nesting level, arrays keep insertion order (never sorted), compact separators (no
// whitespace), and a value this cannot faithfully represent (undefined, bigint, a function or
// symbol, a non-finite number, a cyclic reference, a sparse array, or any non-plain object --
// Map/Set/Date/a class instance/anything with a non-Object.prototype/non-null prototype chain) is
// rejected by throwing rather than silently coerced or dropped.
//
// schemas.mjs re-exports `canonicalStructuredValue` from here verbatim -- this is the ONE
// canonicalizer in the repo; nothing else re-implements object-key sorting independently.
import { createHash } from 'node:crypto';

function isPlainObject(v) {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** True Unicode scalar-value (code point) comparison -- NEVER the default `Array.prototype.sort`
 * string comparator, which compares by UTF-16 code UNIT. Those two orders diverge for a BMP
 * character above U+D7FF (e.g. the Private Use Area) against any astral character: an astral
 * character's leading surrogate (U+D800-U+DBFF) is numerically LESS than such a BMP code unit,
 * so a naive `.sort()` would place the astral key first even though its real code point is larger.
 * Iterating each string by its `Symbol.iterator` (not by index) correctly groups a surrogate pair
 * into one code point before comparing. */
function compareByCodePoint(a, b) {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const an = ai.next();
    const bn = bi.next();
    if (an.done && bn.done) return 0;
    if (an.done) return -1;
    if (bn.done) return 1;
    const ac = an.value.codePointAt(0);
    const bc = bn.value.codePointAt(0);
    if (ac !== bc) return ac < bc ? -1 : 1;
  }
}

/**
 * Recursively canonicalizes `value` into a fresh plain-object/array tree: every plain object's own
 * keys are sorted by true code point (never JS's default UTF-16-code-unit string order) and
 * assigned onto a NULL-PROTOTYPE accumulator -- never a bare `{}`, whose inherited `__proto__`
 * accessor would silently swallow an own `"__proto__"`-named source key instead of setting a real
 * property, collapsing two genuinely different values to the same canonical form. Arrays keep
 * their original element order but reject any hole (a sparse array's missing index would otherwise
 * be indistinguishable from an explicit `null` once handed to a naive downstream `JSON.stringify`).
 * Throws on anything JSON cannot faithfully round-trip: `undefined`, `bigint`, a function, a
 * symbol, a non-finite number (`NaN`/`Infinity`/`-Infinity`), a cyclic reference, a sparse-array
 * hole, or a non-plain object. `seen` (a `Set`, tracked only along the current recursion path) is
 * an internal parameter for cycle detection -- callers never pass it.
 *
 * The returned tree is a plain, JSON.stringify-compatible value (existing callers like
 * aggregate.mjs embed it directly into a larger structure they stringify themselves) -- but a
 * PLAIN JS OBJECT's own-key enumeration order (which any such downstream `JSON.stringify` would
 * follow) still applies ECMAScript's array-index-key-ordering rule regardless of insertion order,
 * for ANY object regardless of prototype. This function's own sort order therefore does not by
 * itself guarantee code-point-ordered BYTES once re-stringified by a naive caller for an object
 * containing integer-like keys (a case none of this PR's actual schemas ever produce -- every
 * schema here uses a fixed, named, non-numeric key vocabulary). `canonicalJsonStringify` below is
 * the function that gives that byte-level guarantee unconditionally, via a direct string walk that
 * never lets any JS object's own enumeration decide output order.
 */
export function canonicalStructuredValue(value, seen = new Set()) {
  if (value === null) return null;
  if (value === undefined) throw new TypeError('canonicalStructuredValue: undefined is not representable');
  const t = typeof value;
  if (t === 'bigint') throw new TypeError('canonicalStructuredValue: bigint is not representable');
  if (t === 'function' || t === 'symbol') throw new TypeError(`canonicalStructuredValue: ${t} is not representable`);
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalStructuredValue: a non-finite number is not representable');
    return value;
  }
  if (t === 'boolean' || t === 'string') return value;
  // t === 'object' from here.
  if (seen.has(value)) throw new TypeError('canonicalStructuredValue: cyclic reference');
  if (Array.isArray(value)) {
    seen.add(value);
    try {
      // Reflect.ownKeys (not a plain length-bounded loop) so an extra own property beyond the
      // dense index range -- a string key like "extra", or a Symbol key -- is caught explicitly,
      // rather than silently ignored the way `value.map()` alone would ignore it (P1 architectural
      // review, Codex round 2, Finding 5). Subsumes the prior hole-check: an index missing from
      // ownKeys (a real hole) is never added to validIndexKeys, so the presence loop below still
      // catches it.
      //
      // Codex round 3, Finding 1: `Number(key)` alone is not enough -- "01", "1e0", and "-0" all
      // coerce to an in-range integer via Number(), but none is the CANONICAL string form of that
      // index (String(0) is always "0"), so each is a genuinely EXTRA own property, not the real
      // index, that `.map()` below would silently ignore just like a plain "extra" key. The
      // `String(index) === key` round-trip check rejects all three. Every valid-shaped index key
      // is ALSO descriptor-checked here -- enumerable, plain data property, never an accessor --
      // exactly like the object branch below, and for the identical reason: `.map()` reads
      // `value[i]` for every index, so an unvetted getter at a valid index would be invoked
      // unconditionally. Checking the descriptor here, before `.map()` ever runs, guarantees no
      // getter is ever invoked during canonicalization, array or object alike.
      const validIndexKeys = new Set();
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') {
          throw new TypeError('canonicalStructuredValue: an own Symbol-keyed property on an array is not representable');
        }
        if (key === 'length') continue;
        const index = Number(key);
        if (!(Number.isInteger(index) && index >= 0 && index < value.length) || String(index) !== key) {
          throw new TypeError(`canonicalStructuredValue: an array own property "${key}" outside its dense index range is not representable`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor.enumerable) {
          throw new TypeError(`canonicalStructuredValue: a non-enumerable array index "${key}" is not representable`);
        }
        if ('get' in descriptor || 'set' in descriptor) {
          throw new TypeError(`canonicalStructuredValue: an accessor (getter/setter) at array index "${key}" is not representable`);
        }
        validIndexKeys.add(key);
      }
      for (let i = 0; i < value.length; i++) {
        if (!validIndexKeys.has(String(i))) {
          throw new TypeError('canonicalStructuredValue: a sparse array (hole) is not representable');
        }
      }
      return value.map((v) => canonicalStructuredValue(v, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (!isPlainObject(value)) {
    throw new TypeError('canonicalStructuredValue: only plain objects and arrays are representable, got a non-plain object');
  }
  seen.add(value);
  try {
    // Reflect.ownKeys + getOwnPropertyDescriptor (not Object.keys directly) so an own Symbol-keyed
    // property, an own non-enumerable property, and an own accessor (getter/setter) property are
    // all explicitly rejected rather than silently excluded -- Object.keys alone excludes all
    // three, which would otherwise let each canonicalize identically to `{}` (P1 architectural
    // review, Codex round 2, Finding 5). A getter is detected via its DESCRIPTOR ('get'/'set' in
    // descriptor) and rejected WITHOUT ever reading `value[key]` -- invoking an adversarial getter
    // during canonicalization would itself be unsafe (side effects, a throw, a value that changes
    // between calls). Only once every own key is confirmed a plain, enumerable, string-keyed data
    // property does the second pass below ever read a real value.
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') {
        throw new TypeError('canonicalStructuredValue: an own Symbol-keyed property is not representable');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable) {
        throw new TypeError(`canonicalStructuredValue: a non-enumerable own property "${key}" is not representable`);
      }
      if ('get' in descriptor || 'set' in descriptor) {
        throw new TypeError(`canonicalStructuredValue: an accessor (getter/setter) own property "${key}" is not representable`);
      }
    }
    const sorted = Object.create(null);
    for (const k of Object.keys(value).sort(compareByCodePoint)) sorted[k] = canonicalStructuredValue(value[k], seen);
    return sorted;
  } finally {
    seen.delete(value);
  }
}

/** Direct recursive string builder for the FINAL canonical bytes -- never hands an object/array
 * structure to `JSON.stringify` (only individual string leaves, purely for standard escaping),
 * because doing so would let the JS engine's own own-key enumeration order decide byte order --
 * which, for any object with an array-index-like key, follows ascending numeric order rather than
 * code-point order regardless of insertion order (an ECMAScript property-enumeration rule, not a
 * canonicalStructuredValue bug). Re-sorting the key array explicitly at every level here, then
 * walking that array directly, is what gives an unconditional guarantee that byte order always
 * matches this module's own documented "code point order" contract, even for adversarial
 * integer-like keys. `value` is assumed already validated by `canonicalStructuredValue` (see
 * `canonicalJsonStringify`); this function performs no independent validation of its own. */
function serializeCanonical(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') return String(value);
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(',')}]`;
  const keys = Object.keys(value).sort(compareByCodePoint);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serializeCanonical(value[k])}`).join(',')}}`;
}

/** Compact canonical UTF-8 JSON text for `value` -- shares `canonicalStructuredValue`'s exact
 * validation (same throws, same notion of "representable"), then serializes the validated tree
 * directly via `serializeCanonical` rather than a bare `JSON.stringify` call, so integer-like keys
 * come out in true code-point order unconditionally (see both functions' own doc comments). */
export function canonicalJsonStringify(value) {
  return serializeCanonical(canonicalStructuredValue(value));
}

/** Lowercase-hex SHA-256 (64 characters) of the canonical UTF-8 JSON bytes of `value`. */
export function canonicalJsonSha256(value) {
  return createHash('sha256').update(canonicalJsonStringify(value), 'utf8').digest('hex');
}

#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/canonical-json.mjs -- the one canonical UTF-8 JSON serialization this PR
// needs anywhere a byte-stable hash over a structured value is required (execution-profile
// identity, skill-snapshot manifest, sidecar provenance): object keys ordered by code point at
// every nesting level, arrays keep insertion order (never sorted), compact separators (no
// whitespace), and a value this cannot faithfully represent (undefined, bigint, a function or
// symbol, a non-finite number, a cyclic reference, or any non-plain object -- Map/Set/Date/a class
// instance/anything with a non-Object.prototype/non-null prototype chain) is rejected by throwing
// rather than silently coerced or dropped.
//
// schemas.mjs re-exports `canonicalStructuredValue` from here verbatim -- this is the ONE
// canonicalizer in the repo; nothing else re-implements object-key sorting independently.
import { createHash } from 'node:crypto';

function isPlainObject(v) {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively canonicalizes `value` into a fresh plain-object/array tree ready for
 * `JSON.stringify`: every plain object's own keys are sorted by code point (`Array.prototype.sort`
 * on strings compares by UTF-16 code unit, which matches code-point order for the BMP identifiers
 * this PR's registries/records ever use); arrays keep their original element order. Throws on
 * anything JSON cannot faithfully round-trip: `undefined`, `bigint`, a function, a symbol, a
 * non-finite number (`NaN`/`Infinity`/`-Infinity`), a cyclic reference, or a non-plain object.
 * `seen` (a `Set`, tracked only along the current recursion path) is an internal parameter for
 * cycle detection -- callers never pass it.
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
    const sorted = {};
    for (const k of Object.keys(value).sort()) sorted[k] = canonicalStructuredValue(value[k], seen);
    return sorted;
  } finally {
    seen.delete(value);
  }
}

/** Compact canonical UTF-8 JSON text for `value` -- `JSON.stringify` with no replacer/space
 * argument already emits the minimal-separator form once its input is already canonicalized
 * (sorted keys, no undefined/bigint/cycle/non-plain-object left to encounter). */
export function canonicalJsonStringify(value) {
  return JSON.stringify(canonicalStructuredValue(value));
}

/** Lowercase-hex SHA-256 (64 characters) of the canonical UTF-8 JSON bytes of `value`. */
export function canonicalJsonSha256(value) {
  return createHash('sha256').update(canonicalJsonStringify(value), 'utf8').digest('hex');
}

#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/privacy.mjs -- fail-closed privacy wrapper around tools/lib/redact.mjs,
// following tools/wet-evidence.mjs's established pattern: redact, then re-scan with findLeaks
// before anything leaves the gitignored raw-transcript location, and refuse (never silently
// omit) if anything still matches.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

// dirname(fileURLToPath(...)), not import.meta.dirname -- the latter needs Node 20.11+/21.2+,
// but package.json declares "node": ">=18" (confirmed to actually matter on a real ubuntu-latest
// CI job -- see condition-launcher.mjs's identical fix for the full story).
const __dirname = dirname(fileURLToPath(import.meta.url));
const REDACT_MODULE_PATH = resolve(__dirname, '..', 'lib', 'redact.mjs');
// Dynamic import via pathToFileURL -- a raw "C:\..." path throws ERR_UNSUPPORTED_ESM_URL_SCHEME
// on Windows (the same fix tools/runs/agentic-usage-benchmark-v2-2026-07-17/harness.mjs needed).
const { PUBLIC_SHAPE_RULES, redactText, findLeaks, findLeaksInValue, loadPrivateRules, redactValue } = await import(pathToFileURL(REDACT_MODULE_PATH).href);

/**
 * @param {string} text
 * @param {{privatePatternsFile?: string}} [opts]
 * @returns {{ok: boolean, redacted: string|null, leaks: Array<{class:string,lineNo:number}>}}
 */
export function redactAndVerify(text, { privatePatternsFile } = {}) {
  const rules = privatePatternsFile ? [...PUBLIC_SHAPE_RULES, ...loadPrivateRules(privatePatternsFile)] : PUBLIC_SHAPE_RULES;
  const redacted = redactText(text, rules);
  const leaks = findLeaks(redacted, rules);
  return { ok: leaks.length === 0, redacted: leaks.length === 0 ? redacted : null, leaks };
}

/**
 * Refuses (throws) rather than writes if any leak survives redaction -- matches
 * wet-evidence.mjs's "refuse to print, never silently omit" contract exactly.
 *
 * NOTE: `text` must be a RAW value, not an already-JSON.stringify()'d blob -- JSON-escaping
 * doubles every backslash, which the user_path_win rule's single-backslash regex then silently
 * fails to match (confirmed: a real Windows path survived this exact call intact when fed
 * pre-serialized JSON text). For an object/record, use assertCleanOrThrowObject() instead, which
 * redacts each string field's raw value before any serialization happens.
 */
export function assertCleanOrThrow(text, opts) {
  const { ok, redacted, leaks } = redactAndVerify(text, opts);
  if (!ok) {
    throw new Error(`REFUSED: ${leaks.length} leak(s) detected after redaction: ${leaks.map((l) => `${l.class}@line${l.lineNo}`).join(', ')}`);
  }
  return redacted;
}

/**
 * Object-aware variant: recursively redacts every STRING field's raw value (via redactValue(),
 * never a pre-serialized text blob -- see assertCleanOrThrow's note on why that matters), then
 * re-scans the ALREADY-REDACTED object's raw string VALUES with findLeaksInValue() -- never the
 * JSON.stringify()'d text -- before returning it.
 *
 * NOTE: the verification pass must never run on JSON.stringify()'d text, for the same reason
 * substitution mustn't: a private-patterns rule's own "replacement" can itself be leak-shaped
 * (e.g. a real Windows path instead of a placeholder token) -- redactValue() correctly
 * substitutes it into the raw value, but JSON.stringify() then doubles its backslashes, and
 * user_path_win's single-backslash regex silently misses the JSON-escaped form. Confirmed
 * empirically: a replacement value shaped like "C:\Users\<name>\..." survived a
 * stringify-then-findLeaks verification pass completely undetected, returned intact by this
 * function. findLeaksInValue() scans each raw string value directly, exactly mirroring
 * redactValue()'s own recursion, so the regex always sees the real, unescaped text.
 * @param {object} obj
 * @param {{privatePatternsFile?: string}} [opts]
 * @returns {{ok: boolean, redactedObj: object|null, redactedText: string|null, leaks: Array<{class:string,lineNo:number}>}}
 */
export function redactObjectAndVerify(obj, { privatePatternsFile } = {}) {
  const rules = privatePatternsFile ? [...PUBLIC_SHAPE_RULES, ...loadPrivateRules(privatePatternsFile)] : PUBLIC_SHAPE_RULES;
  const redactedObj = redactValue(obj, rules);
  const leaks = findLeaksInValue(redactedObj, rules);
  const redactedText = JSON.stringify(redactedObj, null, 2);
  return { ok: leaks.length === 0, redactedObj: leaks.length === 0 ? redactedObj : null, redactedText: leaks.length === 0 ? redactedText : null, leaks };
}

/** Object-aware assertCleanOrThrow -- see redactObjectAndVerify(). */
export function assertCleanOrThrowObject(obj, opts) {
  const { ok, redactedObj, redactedText, leaks } = redactObjectAndVerify(obj, opts);
  if (!ok) {
    throw new Error(`REFUSED: ${leaks.length} leak(s) detected after redaction: ${leaks.map((l) => `${l.class}@line${l.lineNo}`).join(', ')}`);
  }
  return { redactedObj, redactedText };
}

export { PUBLIC_SHAPE_RULES, redactText, findLeaks, findLeaksInValue, loadPrivateRules, redactValue };

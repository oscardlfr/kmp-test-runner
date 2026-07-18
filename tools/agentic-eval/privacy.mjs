#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/privacy.mjs -- fail-closed privacy wrapper around tools/lib/redact.mjs,
// following tools/wet-evidence.mjs's established pattern: redact, then re-scan with findLeaks
// before anything leaves the gitignored raw-transcript location, and refuse (never silently
// omit) if anything still matches.
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';

const REDACT_MODULE_PATH = resolve(import.meta.dirname, '..', 'lib', 'redact.mjs');
// Dynamic import via pathToFileURL -- a raw "C:\..." path throws ERR_UNSUPPORTED_ESM_URL_SCHEME
// on Windows (the same fix tools/runs/agentic-usage-benchmark-v2-2026-07-17/harness.mjs needed).
const { PUBLIC_SHAPE_RULES, redactText, findLeaks, loadPrivateRules } = await import(pathToFileURL(REDACT_MODULE_PATH).href);

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
 */
export function assertCleanOrThrow(text, opts) {
  const { ok, redacted, leaks } = redactAndVerify(text, opts);
  if (!ok) {
    throw new Error(`REFUSED: ${leaks.length} leak(s) detected after redaction: ${leaks.map((l) => `${l.class}@line${l.lineNo}`).join(', ')}`);
  }
  return redacted;
}

export { PUBLIC_SHAPE_RULES, redactText, findLeaks, loadPrivateRules };

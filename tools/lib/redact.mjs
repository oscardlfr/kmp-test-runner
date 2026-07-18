// SPDX-License-Identifier: MIT
// tools/lib/redact.mjs — shared redaction core for wet-evidence (PR-00) and
// decouple-audit v2 (PR-02). No production lib/ dependencies.
//
// Redaction classes
// -----------------
//   device_serial   — 8-15 char uppercase alphanumeric strings containing at least one
//                     digit (matches Samsung ADB serial format and similar).
//   user_path_win   — Windows user home paths: C:\Users\<name>\... or D:\home\<name>\...
//   user_path_posix — POSIX user home paths: /home/<name>/... or /Users/<name>/...
//   artifact_path   — kmp-test-runner runtime artifacts under .kmp-test-runner/.
//
// Private-pattern config (tools/.private-patterns.json — git-ignored, never committed)
// --------------------------------------------------------------------------------------
// JSON array of entries. Each entry must have exactly one of "literal" or "regex", plus
// a "class" and "replacement":
//   { "class": "private_project", "literal": "my-project-name", "replacement": "<PRIVATE_PROJECT>" }
//   { "class": "custom_re",       "regex":   "com\\.example",    "replacement": "<PRIVATE_PKG>"     }
// "literal" entries are escaped verbatim; "regex" entries are compiled with the global flag.
// Optional "flags" field adds extra flags (e.g. "i" for case-insensitive); "g" is always forced.
// Duplicate or invalid flag characters throw (fail-closed).

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Public shape rules — no secrets required; identify by pattern shape alone.
// ---------------------------------------------------------------------------
export const PUBLIC_SHAPE_RULES = [
  {
    class: 'device_serial',
    // Matches 8-15 char uppercase alphanumeric strings that contain at least one digit.
    // The lookahead (?=[A-Z0-9]{8,15}\b) gates on total length before consuming;
    // the [0-9] in the body guarantees at least one digit is present.
    // This avoids false-positives on all-letter words like CHANGELOG or MANIFEST.
    re: /\b(?=[A-Z0-9]{8,15}\b)[A-Z][0-9A-Z]*[0-9][0-9A-Z]*\b/g,
    replacement: '<DEVICE_SERIAL>',
  },
  {
    class: 'user_path_win',
    // Windows user home directory paths including all subdirectories.
    // (?!<) excludes placeholder notation like C:\Users\<username>\... used in docs.
    // [^\s"] allows backslashes so C:\Users\<username>\projects\app is fully consumed.
    re: /[A-Za-z]:\\(?:Users|home)\\(?!<)[^\s"]+/g,
    replacement: '<USER_PATH>',
  },
  {
    class: 'user_path_posix',
    // POSIX user home directory paths including all subdirectories.
    // (?!<) excludes placeholder notation like /home/<username>/... used in docs.
    // [^\s"] allows forward-slashes so /home/<username>/projects/kmp is fully consumed.
    re: /\/(?:home|Users)\/(?!<)[^\s"]+/g,
    replacement: '<USER_PATH>',
  },
  {
    class: 'artifact_path',
    // kmp-test-runner runtime artifact directories.
    re: /\.kmp-test-runner\/(?:logs|reports|captures|android)\/\S+/g,
    replacement: '<ARTIFACT_PATH>',
  },
];

// ---------------------------------------------------------------------------
// loadPrivateRules(configPath) → [{class, re, replacement}]
//
// Parses a private-patterns JSON file. Throws on any parse or validation error
// (fail-closed: a bad config must never silently allow private data through).
// ---------------------------------------------------------------------------
export function loadPrivateRules(configPath) {
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read private-patterns file "${configPath}": ${err.message}`);
  }

  let entries;
  try {
    entries = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in private-patterns file "${configPath}": ${err.message}`);
  }

  if (!Array.isArray(entries)) {
    throw new Error(
      `Private-patterns file "${configPath}" must contain a JSON array, got ${typeof entries}`,
    );
  }

  return entries.map((entry, i) => {
    const ctx = `Entry ${i} in "${configPath}"`;
    if (typeof entry.class !== 'string' || !entry.class) {
      throw new Error(`${ctx}: "class" must be a non-empty string`);
    }
    if (typeof entry.replacement !== 'string') {
      throw new Error(`${ctx}: "replacement" must be a string`);
    }

    const hasLiteral = Object.prototype.hasOwnProperty.call(entry, 'literal');
    const hasRegex   = Object.prototype.hasOwnProperty.call(entry, 'regex');

    if (hasLiteral === hasRegex) {
      throw new Error(`${ctx}: exactly one of "literal" or "regex" must be present`);
    }

    // Build regex flags. Always forces 'g' (required by redactText).
    // Optional "flags" field adds extra flags (e.g. "i" for case-insensitive).
    // Fail-closed: invalid characters and duplicate characters both throw.
    const rawFlags = typeof entry.flags === 'string' ? entry.flags : '';
    if (rawFlags !== '') {
      if (!/^[gimsuy]*$/.test(rawFlags)) {
        throw new Error(`${ctx}: "flags" contains invalid characters: "${rawFlags}"`);
      }
      const dupes = [...rawFlags].filter((c, ii) => rawFlags.indexOf(c) !== ii);
      if (dupes.length > 0) {
        throw new Error(`${ctx}: "flags" has duplicate characters: "${dupes.join('')}"`);
      }
    }
    // Use Set to avoid double-g when the user also specified 'g' in flags.
    const flagSet = new Set(['g', ...rawFlags]);
    const flags = [...flagSet].join('');

    let re;
    if (hasLiteral) {
      if (typeof entry.literal !== 'string') {
        throw new Error(`${ctx}: "literal" must be a string`);
      }
      // Escape every regex metacharacter so the literal is matched verbatim.
      const escaped = entry.literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(escaped, flags);
    } else {
      if (typeof entry.regex !== 'string') {
        throw new Error(`${ctx}: "regex" must be a string`);
      }
      try {
        re = new RegExp(entry.regex, flags);
      } catch (err) {
        throw new Error(`${ctx}: invalid regex "${entry.regex}": ${err.message}`);
      }
    }

    return { class: entry.class, re, replacement: entry.replacement };
  });
}

// ---------------------------------------------------------------------------
// redactText(text, rules) → string
//
// Applies each rule in order, replacing all matches. Resets /g lastIndex
// before each replace so the function is idempotent across multiple calls
// with the same rule objects.
// ---------------------------------------------------------------------------
export function redactText(text, rules) {
  let out = text;
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, rule.replacement);
  }
  return out;
}

// ---------------------------------------------------------------------------
// findLeaks(text, rules) → [{class, lineNo}]
//
// Re-runs the SAME rules on text (expected: already-redacted output) and
// returns structural metadata for any remaining matches. NEVER includes the
// matched content in the returned objects — callers must not echo it.
// ---------------------------------------------------------------------------
export function findLeaks(text, rules) {
  const lines = text.split('\n');
  const leaks = [];
  for (const rule of rules) {
    for (let i = 0; i < lines.length; i++) {
      rule.re.lastIndex = 0;
      if (rule.re.test(lines[i])) {
        leaks.push({ class: rule.class, lineNo: i + 1 });
      }
    }
  }
  return leaks;
}

// ---------------------------------------------------------------------------
// redactValue(value, rules) → value (deep-cloned, every string redacted)
//
// Recursively redacts every STRING found anywhere in a JSON-shaped value
// (object/array/primitive), applying redactText() to each RAW string value
// directly -- never to an already-JSON.stringify()'d text blob. This closes a
// real bypass: JSON.stringify() escapes each backslash in a Windows path as
// TWO characters (\ becomes \\), but user_path_win's regex is written to
// match a SINGLE literal backslash -- redacting text AFTER serialization
// silently fails to match the JSON-escaped form (confirmed empirically: a
// real "C:\Users\<name>\..." path survived redactText()+findLeaks() intact
// once JSON.stringify() had already run on it). Redacting each string value
// BEFORE serialization means the regex always sees the real, unescaped path
// text, matching how tools/wet-evidence.mjs already redacts its own string
// fields individually (never a pre-serialized blob) -- this generalizes that
// same proven-correct pattern to an arbitrary object shape via recursion,
// rather than requiring every caller to enumerate which fields to redact by
// hand and risk missing one.
// ---------------------------------------------------------------------------
export function redactValue(value, rules) {
  if (typeof value === 'string') return redactText(value, rules);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, rules));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, rules);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// findLeaksInValue(value, rules) → [{class, lineNo}]
//
// Recursively re-scans every STRING found anywhere in a JSON-shaped value for
// remaining leaks, calling findLeaks() on each RAW string value directly --
// never on an already-JSON.stringify()'d blob. Closes the same JSON-escaping
// bypass class redactValue() closes for SUBSTITUTION, but for VERIFICATION: a
// rule's own REPLACEMENT text can itself be leak-shaped -- e.g. a
// private-patterns-file rule whose "replacement" is a real Windows path
// rather than a placeholder token. redactValue() correctly substitutes it
// into the raw value, but a verification pass that then JSON.stringify()s the
// WHOLE object before scanning sees that replacement's backslashes doubled by
// JSON escaping, and user_path_win's single-backslash regex silently misses
// it (confirmed empirically: a replacement value shaped like
// "C:\Users\<name>\..." survived a stringify-then-scan verification pass
// completely undetected, returned intact by assertCleanOrThrowObject()).
// Scanning each raw string value directly, before any serialization, means
// the regex always sees the real, unescaped text -- exactly the same
// discipline redactValue() already applies for substitution, now applied to
// verification too.
// ---------------------------------------------------------------------------
export function findLeaksInValue(value, rules) {
  if (typeof value === 'string') return findLeaks(value, rules);
  if (Array.isArray(value)) return value.flatMap((v) => findLeaksInValue(v, rules));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap((v) => findLeaksInValue(v, rules));
  }
  return [];
}

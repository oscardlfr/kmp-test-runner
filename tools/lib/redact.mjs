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
    // [^\s"] allows backslashes so C:\Users\user\projects\app is fully consumed.
    re: /[A-Za-z]:\\(?:Users|home)\\[^\s"]+/g,
    replacement: '<USER_PATH>',
  },
  {
    class: 'user_path_posix',
    // POSIX user home directory paths including all subdirectories.
    // [^\s"] allows forward-slashes so /home/user/projects/kmp is fully consumed.
    re: /\/(?:home|Users)\/[^\s"]+/g,
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

    let re;
    if (hasLiteral) {
      if (typeof entry.literal !== 'string') {
        throw new Error(`${ctx}: "literal" must be a string`);
      }
      // Escape every regex metacharacter so the literal is matched verbatim.
      const escaped = entry.literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(escaped, 'g');
    } else {
      if (typeof entry.regex !== 'string') {
        throw new Error(`${ctx}: "regex" must be a string`);
      }
      try {
        re = new RegExp(entry.regex, 'g');
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

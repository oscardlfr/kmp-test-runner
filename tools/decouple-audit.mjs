#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/decouple-audit.mjs — privacy enforcement gate (v2).
//
// Walks `git ls-files` (committed text only) and reports any hit against
// the audit rule set. Outputs `file:line:class` — never matched content.
//
// Public audit rules (always active, no secrets required):
//   device_serial   — 8-15 char uppercase alphanumeric string with at least one digit
//   user_path_win   — C:\Users\<name>\... (excludes <placeholder> form)
//   user_path_posix — /home/<name>/... or /Users/<name>/... (excludes <placeholder> form)
//
// artifact_path is intentionally excluded from the audit rule set.
// .kmp-test-runner/logs/... and .kmp-test-runner/reports/... appear legitimately in
// documentation and source; they are not privacy leaks in committed text.
//
// Private pattern scanning (fail-closed, opt-in):
//   Enabled when KMP_PRIVATE_PATTERNS_FILE is set or tools/.private-patterns.json exists.
//   Required (fail-closed) when KMP_PRIVATE_SCAN_REQUIRED=1.
//
// Fork-safe design (full CI wiring is out of scope for PR-02):
//
//   1. Normal fork PR CI: decouple-audit runs with AUDIT_PUBLIC_RULES only
//      (public audit subset: device_serial, user_path_win, user_path_posix).
//      No secrets. No KMP_PRIVATE_PATTERNS_FILE.
//
//   2. Privileged private scan (workflow_dispatch by maintainer):
//      - Inputs: { pr_number, head_sha }
//      - Runs ONLY on trusted base-branch code; never checks out the PR's code.
//      - Fetches the PR diff as data-only (gh api /repos/.../pulls/{pr}/files).
//      - Calls compareShas(input.head_sha, pr_api.head.sha) before proceeding.
//      - On SHA mismatch: refuses to run private scan (fail-closed).
//      - Loads KMP_PRIVATE_PATTERNS_FILE from a CI secret.
//      - Emits only PASS/FAIL + file:line:class metadata.
//
//      compareShas() is a pure helper exported below — testable without git or network.
//
// Usage:
//   node tools/decouple-audit.mjs
//   KMP_PRIVATE_PATTERNS_FILE=.../private.json node tools/decouple-audit.mjs
//   KMP_PRIVATE_SCAN_REQUIRED=1 KMP_PRIVATE_PATTERNS_FILE=.../private.json \
//     node tools/decouple-audit.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, openSync, readSync, closeSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_SHAPE_RULES, loadPrivateRules } from './lib/redact.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');
const SELF_REL   = path.relative(REPO_ROOT, __filename).replace(/\\/g, '/');

// Local (gitignored) private patterns file — never committed.
const LOCAL_PRIVATE_PATTERNS = path.join(__dirname, '.private-patterns.json');

// ---------------------------------------------------------------------------
// Audit rule set — privacy-relevant rules for committed-text scanning.
//
// These are NOT a simple filter of PUBLIC_SHAPE_RULES. The user-path rules are
// deliberately narrower here than in wet-evidence, for two reasons:
//
//   1. artifact_path excluded: .kmp-test-runner/logs/... etc. appear legitimately
//      in README, docs, skills, and error messages. They are a redaction aid for
//      wet-evidence output, not a privacy signal in committed text.
//
//   2. user_path_win/posix use \w{3,} for the username segment rather than the
//      broad [^\s"]+ in PUBLIC_SHAPE_RULES. This avoids false positives on:
//        - single-char placeholder examples like /Users/X/... in code comments;
//        - bats grep patterns like /Users/|/home/|/root/ (| is not \w);
//        - ellipsis examples like C:\Users\... in comments (. is not \w).
//      Real private usernames are always ≥3 chars and consist of word chars.
//      Angle-bracket placeholders (/home/<username>/...) are also excluded
//      because < is not \w.
// ---------------------------------------------------------------------------
export const AUDIT_PUBLIC_RULES = [
  // Reuse the device_serial rule from PUBLIC_SHAPE_RULES — it is narrow enough.
  PUBLIC_SHAPE_RULES.find(r => r.class === 'device_serial'),
  {
    class: 'user_path_win',
    // Windows user home paths. \w{3,} requires the username to be ≥3 word chars,
    // blocking single-char examples (X), regex patterns (|), and ellipsis (...).
    re: /[A-Za-z]:\\(?:Users|home)\\\w{3,}\\[^\s"]+/g,
    replacement: '<USER_PATH>',
  },
  {
    class: 'user_path_posix',
    // POSIX user home paths. Same \w{3,} rationale as user_path_win above.
    re: /\/(?:home|Users)\/\w{3,}\/[^\s"]+/g,
    replacement: '<USER_PATH>',
  },
];

// ---------------------------------------------------------------------------
// Skip list — relative paths (forward-slash-normalised) excluded from scanning.
//
// __snapshots__/: skipped because snapshots lock synthetic test data that may contain
// serial-shaped or path-shaped fixtures by design. Scanning them would require all
// fixture data to be construction-split, which is a follow-on audit.
// TODO: schedule a __snapshots__ audit pass and remove this exception once clean.
//
// tools/runs/ is NOT skipped: the 8 tracked files were verified clean in the PR-02
// pre-flight. Keeping them in scope ensures future private-data additions are caught.
// ---------------------------------------------------------------------------
const SKIP_PREFIXES = ['__snapshots__/'];

// ---------------------------------------------------------------------------
// NUL/binary sniffing — reads first 512 bytes; any NUL byte signals binary.
// ---------------------------------------------------------------------------
const SNIFF_BYTES = 512;

export function hasBinaryNul(absPath) {
  try {
    const fd = openSync(absPath, 'r');
    const buf = Buffer.alloc(SNIFF_BYTES);
    const n = readSync(fd, buf, 0, SNIFF_BYTES, 0);
    closeSync(fd);
    return buf.slice(0, n).includes(0);
  } catch {
    return false;
  }
}

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z',
  '.jar', '.war', '.class', '.so', '.dylib', '.dll',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
]);

function isTextFile(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (BINARY_EXTS.has(ext)) return false;
  return !hasBinaryNul(absPath);
}

// ---------------------------------------------------------------------------
// shouldSkip — true when the relative path should be excluded from scanning.
// ---------------------------------------------------------------------------
export function shouldSkip(rel, selfRel) {
  if (rel === selfRel) return true;
  return SKIP_PREFIXES.some(p => rel.startsWith(p) || rel.includes(`/${p}`));
}

// ---------------------------------------------------------------------------
// scanFile — returns [{file, lineNo, class}]. Never includes matched content.
// ---------------------------------------------------------------------------
export function scanFile(absPath, rel, rules) {
  let body;
  try {
    body = readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  const hits = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      if (rule.re.test(line)) {
        hits.push({ file: rel, lineNo: i + 1, class: rule.class });
        rule.re.lastIndex = 0;
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// buildRules — assembles AUDIT_PUBLIC_RULES + optional private rules.
// Throws (fail-closed) when privateRequired is true but no source is available,
// or when the private config file is invalid.
// ---------------------------------------------------------------------------
export function buildRules({ privatePatternFile, privateRequired }) {
  if (privateRequired && !privatePatternFile) {
    throw new Error(
      'KMP_PRIVATE_SCAN_REQUIRED=1 but no private-patterns source found ' +
      '(set KMP_PRIVATE_PATTERNS_FILE or place tools/.private-patterns.json)',
    );
  }
  const rules = [...AUDIT_PUBLIC_RULES];
  if (privatePatternFile) {
    rules.push(...loadPrivateRules(privatePatternFile));
  }
  return rules;
}

// ---------------------------------------------------------------------------
// compareShas — pure function for fork-safe SHA validation.
// The privileged workflow_dispatch scan calls this before running private patterns
// to reject a mismatched head SHA without touching untrusted code.
// No git dependency — the caller resolves both SHAs independently.
// ---------------------------------------------------------------------------
export function compareShas(providedSha, actualSha) {
  if (typeof providedSha !== 'string' || typeof actualSha !== 'string') {
    return { ok: false, error: 'SHA mismatch: one or both SHAs are not strings' };
  }
  if (providedSha !== actualSha) {
    return { ok: false, error: `SHA mismatch: provided=${providedSha} actual=${actualSha}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// listGitFiles — returns all committed files via git ls-files.
// ---------------------------------------------------------------------------
function listGitFiles() {
  const r = spawnSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  if (r.status !== 0) {
    console.error('decouple-audit: `git ls-files` failed.');
    console.error(r.stderr);
    process.exit(2);
  }
  return r.stdout.split('\n').filter(Boolean);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const privatePatternFile =
    process.env.KMP_PRIVATE_PATTERNS_FILE ||
    (existsSync(LOCAL_PRIVATE_PATTERNS) ? LOCAL_PRIVATE_PATTERNS : null);

  const privateRequired = process.env.KMP_PRIVATE_SCAN_REQUIRED === '1';

  let rules;
  try {
    rules = buildRules({ privatePatternFile, privateRequired });
  } catch (err) {
    console.error(`decouple-audit: ${err.message}`);
    process.exit(1);
  }

  const files = listGitFiles();
  const allHits = [];
  let scanned = 0;

  for (const rel of files) {
    if (shouldSkip(rel, SELF_REL)) continue;
    const abs = path.join(REPO_ROOT, rel);
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    if (!isTextFile(abs)) continue;
    const hits = scanFile(abs, rel, rules);
    allHits.push(...hits);
    scanned += 1;
  }

  if (allHits.length > 0) {
    for (const h of allHits) {
      console.error(`${h.file}:${h.lineNo}:${h.class}`);
    }
    console.error('');
    const pubCount  = AUDIT_PUBLIC_RULES.length;
    const privCount = rules.length - pubCount;
    console.error(
      `decouple-audit: ${allHits.length} hit(s) across ${scanned} file(s) ` +
      `[${pubCount} public + ${privCount} private rules].`,
    );
    console.error('See CLAUDE.md "Decouple from L0" for the policy.');
    process.exit(1);
  }

  const pubCount  = AUDIT_PUBLIC_RULES.length;
  const privCount = rules.length - pubCount;
  console.log(
    `decouple-audit: clean (${scanned} files, ${pubCount} public` +
    (privCount > 0 ? ` + ${privCount} private` : '') +
    ' rules).',
  );
}

// Guard: only run main() when this file is the direct entry point.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}

// tests/vitest/decouple-audit.test.js
// Unit tests for tools/decouple-audit.mjs (v2) and the flags extension to
// tools/lib/redact.mjs loadPrivateRules.
import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  openSync,
  writeSync,
  closeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  AUDIT_PUBLIC_RULES,
  hasBinaryNul,
  shouldSkip,
  scanFile,
  lineHasUnallowedMatch,
  buildRules,
  compareShas,
} from '../../tools/decouple-audit.mjs';
import { loadPrivateRules } from '../../tools/lib/redact.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const SELF_REL   = 'tools/decouple-audit.mjs';

// ---------------------------------------------------------------------------
// Temp-dir helpers
// ---------------------------------------------------------------------------
const tmpDirs = [];

function makeTmpDir() {
  const d = mkdtempSync(path.join(os.tmpdir(), 'da-test-'));
  tmpDirs.push(d);
  return d;
}

function tmpFile(dir, name, content) {
  const p = path.join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

function tmpJsonFile(dir, name, data) {
  return tmpFile(dir, name, JSON.stringify(data));
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// Runtime-constructed fixtures — split so no single source literal trips the
// audit shape rules (device_serial / user_path_win / user_path_posix).
const SERIAL_FIXTURE     = 'R38BHY' + '51234';                    // device_serial shape (assembled at runtime)
const WIN_PATH_FIXTURE   = 'C:\\Users\\' + 'oscar\\projects\\app'; // user_path_win shape
const POSIX_PATH_FIXTURE = '/home/' + 'oscar/projects/kmp';        // user_path_posix shape

// ---------------------------------------------------------------------------
// 1. Public shape rule catches serial-shaped text
// ---------------------------------------------------------------------------
describe('decouple-audit public rules', () => {
  it('flags a device-serial-shaped string', () => {
    const dir = makeTmpDir();
    const f = tmpFile(dir, 'test.txt', `connecting to device ${SERIAL_FIXTURE} completed\n`);
    const hits = scanFile(f, 'test.txt', AUDIT_PUBLIC_RULES);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].class).toBe('device_serial');
  });

  // ---------------------------------------------------------------------------
  // 2. Public rule catches real Windows and POSIX user paths
  // ---------------------------------------------------------------------------
  it('flags a real Windows user path', () => {
    const dir = makeTmpDir();
    const f = tmpFile(dir, 'win.txt', `project at ${WIN_PATH_FIXTURE}\n`);
    const hits = scanFile(f, 'win.txt', AUDIT_PUBLIC_RULES);
    expect(hits.some(h => h.class === 'user_path_win')).toBe(true);
  });

  it('flags a real POSIX user path', () => {
    const dir = makeTmpDir();
    const f = tmpFile(dir, 'posix.txt', `project at ${POSIX_PATH_FIXTURE}\n`);
    const hits = scanFile(f, 'posix.txt', AUDIT_PUBLIC_RULES);
    expect(hits.some(h => h.class === 'user_path_posix')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 3. Template placeholder paths do NOT trigger path rules
  // ---------------------------------------------------------------------------
  it('does not flag /home/<user>/... placeholder paths', () => {
    const dir = makeTmpDir();
    const f = tmpFile(dir, 'doc.md', 'Install to /home/<username>/bin/kmp-test\n');
    const hits = scanFile(f, 'doc.md', AUDIT_PUBLIC_RULES);
    expect(hits.filter(h => h.class === 'user_path_posix')).toHaveLength(0);
  });

  it('does not flag C:\\Users\\<name>\\... placeholder paths', () => {
    const dir = makeTmpDir();
    const f = tmpFile(dir, 'doc.md', 'Install to C:\\Users\\<username>\\AppData\\Local\\kmp-test\n');
    const hits = scanFile(f, 'doc.md', AUDIT_PUBLIC_RULES);
    expect(hits.filter(h => h.class === 'user_path_win')).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 17. artifact_path is NOT in AUDIT_PUBLIC_RULES
  // ---------------------------------------------------------------------------
  it('does not include artifact_path in AUDIT_PUBLIC_RULES', () => {
    const classes = AUDIT_PUBLIC_RULES.map(r => r.class);
    expect(classes).not.toContain('artifact_path');
    expect(classes).toContain('device_serial');
    expect(classes).toContain('user_path_win');
    expect(classes).toContain('user_path_posix');
  });

  // ---------------------------------------------------------------------------
  // 18. .kmp-test-runner/... in docs does NOT produce a hit
  // ---------------------------------------------------------------------------
  it('does not flag .kmp-test-runner artifact paths in documentation text', () => {
    const dir = makeTmpDir();
    const content = [
      'See `.kmp-test-runner/logs/android/abc123def456` for run logs.',
      'Reports are written to `.kmp-test-runner/reports/coverage/latest.md`.',
      'Captures stored under `.kmp-test-runner/captures/run-001/output.txt`.',
    ].join('\n');
    const f = tmpFile(dir, 'README.md', content);
    const hits = scanFile(f, 'README.md', AUDIT_PUBLIC_RULES);
    expect(hits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EVIDENCE1 benchmark name: exact-token allowlist on device_serial only.
//
// EVIDENCE1 is the name of the published agentic-benchmark campaign
// (tools/runs/evidence1-agentic-benchmark-*), not a device serial, but it
// matches the device_serial shape (9 uppercase-alnum chars with a digit).
// The allowlist is applied PER MATCH, never per line or per file, so it stays
// fail-closed: a real serial-shaped token sharing a line with EVIDENCE1 still
// flags, and a token that only CONTAINS "EVIDENCE1" as a substring is a
// different token (the regex's own \b matching makes this exact, not
// approximate -- see the two flagging tests below).
//
// Fixtures for the still-flagged tokens are split at runtime, same technique
// as SERIAL_FIXTURE above: writing the full shape as one source literal would
// make THIS test file itself trip the rule under test.
// ---------------------------------------------------------------------------
describe('decouple-audit device_serial: EVIDENCE1 allowlist', () => {
  const SYNTHETIC_SERIAL = 'ZZ0123' + '456789'; // device_serial shape, split (each half <8 chars) at write time
  const EVIDENCE1_PLUS_SUFFIX = 'EVIDENCE1' + '2ZZ'; // contains EVIDENCE1 as a prefix, not an exact-token match

  it('a line containing only EVIDENCE1 is clean', () => {
    const dir = makeTmpDir();
    const f = tmpFile(dir, 'doc.md', 'See the EVIDENCE1 benchmark for details.\n');
    const hits = scanFile(f, 'doc.md', AUDIT_PUBLIC_RULES);
    expect(hits.filter(h => h.class === 'device_serial')).toHaveLength(0);
  });

  it('a real serial-shaped token sharing a line with EVIDENCE1 still flags (fail-closed, not fail-open)', () => {
    const dir = makeTmpDir();
    const f = tmpFile(dir, 'doc.md', `EVIDENCE1 benchmark, device ${SYNTHETIC_SERIAL} attached\n`);
    const hits = scanFile(f, 'doc.md', AUDIT_PUBLIC_RULES);
    expect(hits.filter(h => h.class === 'device_serial').length).toBeGreaterThan(0);
  });

  it('a token that merely contains EVIDENCE1 as a substring still flags (exact-match allowlist, not a prefix check)', () => {
    const dir = makeTmpDir();
    const f = tmpFile(dir, 'doc.md', `id ${EVIDENCE1_PLUS_SUFFIX} assigned\n`);
    const hits = scanFile(f, 'doc.md', AUDIT_PUBLIC_RULES);
    expect(hits.filter(h => h.class === 'device_serial').length).toBeGreaterThan(0);
  });

  it('does not add allowTokens to any rule other than device_serial', () => {
    const others = AUDIT_PUBLIC_RULES.filter(r => r.class !== 'device_serial');
    expect(others.length).toBeGreaterThan(0);
    for (const rule of others) {
      expect(rule.allowTokens).toBeUndefined();
    }
  });

  it('lineHasUnallowedMatch: a rule with no allowTokens behaves exactly like a bare rule.re.test', () => {
    const rule = { re: /\bfoo\b/g };
    expect(lineHasUnallowedMatch('a foo here', rule)).toBe(true);
    expect(lineHasUnallowedMatch('no match here', rule)).toBe(false);
  });

  it('lineHasUnallowedMatch: allows an exact-listed token but still flags a different one on the same line', () => {
    const deviceSerialRule = AUDIT_PUBLIC_RULES.find(r => r.class === 'device_serial');
    expect(lineHasUnallowedMatch('EVIDENCE1 only', deviceSerialRule)).toBe(false);
    expect(lineHasUnallowedMatch(`EVIDENCE1 and ${SYNTHETIC_SERIAL}`, deviceSerialRule)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4 + 5. Private patterns catch synthetic names without echoing content
// ---------------------------------------------------------------------------
describe('decouple-audit private patterns', () => {
  it('catches a private literal without including matched content in result', () => {
    const dir = makeTmpDir();
    const configFile = tmpJsonFile(dir, 'priv.json', [
      { class: 'test_priv', literal: 'my-secret-project', replacement: '<X>' },
    ]);
    const rules = buildRules({ privatePatternFile: configFile, privateRequired: false });
    const f = tmpFile(dir, 'leak.txt', 'depends on my-secret-project for build\n');
    const hits = scanFile(f, 'leak.txt', rules);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].class).toBe('test_priv');
    // Result must NOT contain matched content
    expect(Object.keys(hits[0])).not.toContain('match');
    expect(Object.keys(hits[0])).not.toContain('line');
  });

  it('catches a private regex without including matched content in result', () => {
    const dir = makeTmpDir();
    const configFile = tmpJsonFile(dir, 'priv.json', [
      { class: 'private_pkg', regex: 'com\\.example\\.secret', replacement: '<PKG>' },
    ]);
    const rules = buildRules({ privatePatternFile: configFile, privateRequired: false });
    const f = tmpFile(dir, 'build.gradle.kts', 'implementation("com.example.secret:core:1.0")\n');
    const hits = scanFile(f, 'build.gradle.kts', rules);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].class).toBe('private_pkg');
    expect(Object.keys(hits[0])).not.toContain('match');
    expect(Object.keys(hits[0])).not.toContain('line');
  });
});

// ---------------------------------------------------------------------------
// 6. Missing private config fails closed when required
// ---------------------------------------------------------------------------
describe('buildRules fail-closed behaviour', () => {
  it('throws when privateRequired but no private source available', () => {
    expect(() =>
      buildRules({ privatePatternFile: null, privateRequired: true }),
    ).toThrow(/KMP_PRIVATE_SCAN_REQUIRED/);
  });

  // ---------------------------------------------------------------------------
  // 7. Missing private config does not break public-only scan
  // ---------------------------------------------------------------------------
  it('returns AUDIT_PUBLIC_RULES only when no private source and not required', () => {
    const rules = buildRules({ privatePatternFile: null, privateRequired: false });
    expect(rules).toHaveLength(AUDIT_PUBLIC_RULES.length);
    const classes = rules.map(r => r.class);
    expect(classes).toContain('device_serial');
    expect(classes).toContain('user_path_win');
    expect(classes).toContain('user_path_posix');
    expect(classes).not.toContain('artifact_path');
  });

  // ---------------------------------------------------------------------------
  // 8. Invalid private config (bad JSON) fails closed
  // ---------------------------------------------------------------------------
  it('throws when private config JSON is malformed', () => {
    const dir = makeTmpDir();
    const badFile = tmpFile(dir, 'bad.json', '{ not valid json ');
    expect(() =>
      buildRules({ privatePatternFile: badFile, privateRequired: false }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 9. Hits report file:line:class, NOT matched content
// ---------------------------------------------------------------------------
describe('hit object shape', () => {
  it('hit objects contain file, lineNo, class — and nothing else', () => {
    const dir = makeTmpDir();
    const f = tmpFile(dir, 'serial.txt', `device is ${SERIAL_FIXTURE} ok\n`);
    const hits = scanFile(f, 'serial.txt', AUDIT_PUBLIC_RULES);
    expect(hits.length).toBeGreaterThan(0);
    const h = hits[0];
    expect(h).toHaveProperty('file');
    expect(h).toHaveProperty('lineNo');
    expect(h).toHaveProperty('class');
    expect(Object.keys(h)).toEqual(['file', 'lineNo', 'class']);
  });
});

// ---------------------------------------------------------------------------
// 10. Case-insensitive flag works via loadPrivateRules flags field
// ---------------------------------------------------------------------------
describe('loadPrivateRules flags support', () => {
  it('matches case-insensitively when flags:"i" is set', () => {
    const dir = makeTmpDir();
    const configFile = tmpJsonFile(dir, 'priv.json', [
      { class: 'ci_match', regex: 'My-Secret', flags: 'i', replacement: '<X>' },
    ]);
    const rules = loadPrivateRules(configFile);
    expect(rules).toHaveLength(1);
    // The regex must match lowercase form
    rules[0].re.lastIndex = 0;
    expect(rules[0].re.test('contains my-secret value')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 19. Invalid flag chars in private config throw (fail-closed)
  // ---------------------------------------------------------------------------
  it('throws on invalid flag character "@"', () => {
    const dir = makeTmpDir();
    const configFile = tmpJsonFile(dir, 'priv.json', [
      { class: 'x', regex: 'foo', flags: '@', replacement: '<X>' },
    ]);
    expect(() => loadPrivateRules(configFile)).toThrow(/invalid/i);
  });

  // ---------------------------------------------------------------------------
  // 20. Duplicate flag chars in private config throw (fail-closed)
  // ---------------------------------------------------------------------------
  it('throws on duplicate flag character "ii"', () => {
    const dir = makeTmpDir();
    const configFile = tmpJsonFile(dir, 'priv.json', [
      { class: 'x', regex: 'foo', flags: 'ii', replacement: '<X>' },
    ]);
    expect(() => loadPrivateRules(configFile)).toThrow(/duplicate/i);
  });
});

// ---------------------------------------------------------------------------
// 11. tools/runs/ path is NOT skipped
// ---------------------------------------------------------------------------
describe('shouldSkip', () => {
  it('does not skip tools/runs/ paths', () => {
    expect(shouldSkip('tools/runs/cross-model-results-benchmark.txt', SELF_REL)).toBe(false);
    expect(shouldSkip('tools/runs/multi-project-token-cost-2026-05-12/aggregate-2026-05-12.md', SELF_REL)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 16. __snapshots__/ IS skipped (explicit tech debt: serial-shaped fixtures in snapshots)
  // TODO: remove this skip once a __snapshots__ audit pass cleans all serial-shaped fixtures.
  // ---------------------------------------------------------------------------
  it('skips __snapshots__/ paths (tech debt: snapshot fixtures may contain serial shapes)', () => {
    expect(shouldSkip('tests/vitest/__snapshots__/cli.test.js.snap', SELF_REL)).toBe(true);
    expect(shouldSkip('__snapshots__/foo.snap', SELF_REL)).toBe(true);
  });

  it('does not skip package-lock.json (integrity lines are exempted per-rule, not file-level)', () => {
    expect(shouldSkip('package-lock.json', SELF_REL)).toBe(false);
    expect(shouldSkip('subdir/package-lock.json', SELF_REL)).toBe(false);
  });

  it('skips the audit script itself', () => {
    expect(shouldSkip(SELF_REL, SELF_REL)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// integrity-line exemption in package-lock.json
// ---------------------------------------------------------------------------
describe('package-lock.json integrity-line exemption', () => {
  it('does not flag a serial-shaped base64 segment on an npm integrity line', () => {
    const dir = makeTmpDir();
    // Integrity line: the base64 payload contains SERIAL_FIXTURE between slashes.
    // Without excludeLineRe this would trip device_serial; the rule must suppress it.
    const f = tmpFile(dir, 'lock.json',
      `      "integrity": "sha512-abc/${SERIAL_FIXTURE}/xyz=="\n`
    );
    const hits = scanFile(f, 'package-lock.json', AUDIT_PUBLIC_RULES);
    expect(hits.filter(h => h.class === 'device_serial')).toHaveLength(0);
  });

  it('still flags a serial-shaped string on a non-integrity line in package-lock.json', () => {
    const dir = makeTmpDir();
    // A "name" or other field — not an integrity hash — must still trip the rule.
    const f = tmpFile(dir, 'lock.json',
      `    "name": "adb-device-${SERIAL_FIXTURE}"\n`
    );
    const hits = scanFile(f, 'package-lock.json', AUDIT_PUBLIC_RULES);
    expect(hits.filter(h => h.class === 'device_serial').length).toBeGreaterThan(0);
  });

  it('still flags a user path in package-lock.json (e.g. a local file: resolved URL)', () => {
    const dir = makeTmpDir();
    const f = tmpFile(dir, 'lock.json',
      `    "resolved": "file:${POSIX_PATH_FIXTURE}/my-private-pkg"\n`
    );
    const hits = scanFile(f, 'package-lock.json', AUDIT_PUBLIC_RULES);
    expect(hits.filter(h => h.class === 'user_path_posix').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 12. Binary/NUL file skipped safely
// ---------------------------------------------------------------------------
describe('hasBinaryNul', () => {
  it('returns true for a file containing a NUL byte', () => {
    const dir = makeTmpDir();
    const binPath = path.join(dir, 'binary.bin');
    const fd = openSync(binPath, 'w');
    writeSync(fd, Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64]));
    closeSync(fd);
    expect(hasBinaryNul(binPath)).toBe(true);
  });

  it('returns false for a plain text file', () => {
    const dir = makeTmpDir();
    const txtPath = tmpFile(dir, 'text.txt', 'Hello, world!\n');
    expect(hasBinaryNul(txtPath)).toBe(false);
  });

  it('returns true for a file with serial-shaped bytes amid NUL bytes (binary gate before scanFile in main())', () => {
    const dir = makeTmpDir();
    const binPath = path.join(dir, 'fake.txt');
    const fd = openSync(binPath, 'w');
    // Hex: NUL + serial-shaped ASCII bytes + NUL. main() calls isTextFile()
    // (which calls hasBinaryNul) before invoking scanFile — scanFile is never
    // reached for NUL-containing files. This test confirms hasBinaryNul fires.
    writeSync(fd, Buffer.from([0x00, 0x52, 0x33, 0x38, 0x42, 0x48, 0x59, 0x35, 0x31, 0x32, 0x33, 0x34, 0x00]));
    closeSync(fd);
    expect(hasBinaryNul(binPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13 + 14. compareShas — pure fork-safe SHA validator
// ---------------------------------------------------------------------------
describe('compareShas', () => {
  it('returns { ok: false } with a mismatch error for different SHAs', () => {
    const result = compareShas(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/mismatch/i);
  });

  it('returns { ok: true } for identical SHAs', () => {
    const sha = '8582b38f1234567890abcdef1234567890abcdef';
    expect(compareShas(sha, sha)).toEqual({ ok: true });
  });

  it('returns { ok: false } when either SHA is not a string', () => {
    expect(compareShas(null, 'abc').ok).toBe(false);
    expect(compareShas('abc', undefined).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 16. lineHasUnallowedMatch -- non-global regex + allowTokens must never hang
// (CodeRabbit review finding on PR #535, confirmed by execution: a non-global
// regex's lastIndex is ignored by exec(), so a manual bump never advances it
// and the old implementation looped forever the instant a matched token was
// allowlisted). Today's only allowTokens rule (device_serial) is global, so
// this never fired in the shipped tool -- but the exported function itself
// must be safe for any caller.
// ---------------------------------------------------------------------------
describe('lineHasUnallowedMatch: non-global regex + allowTokens safety', () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', '..', 'tools', 'decouple-audit.mjs')).href;

  // Runs the exact scenario in a CHILD PROCESS with a real timeout, so a regression FAILS this
  // test instead of hanging the whole suite -- an in-process call with no timeout would just hang
  // vitest itself if the bug ever came back.
  function runInChild(lineLiteral, reSource) {
    const script = `
      import { lineHasUnallowedMatch } from ${JSON.stringify(moduleUrl)};
      const rule = { re: new RegExp(${JSON.stringify(reSource)}), allowTokens: new Set(['FOO']) };
      const result = lineHasUnallowedMatch(${JSON.stringify(lineLiteral)}, rule);
      process.stdout.write(String(result));
    `;
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      timeout: 5000,
      encoding: 'utf8',
    });
  }

  it('a non-global rule with an allowed-only match returns false and does not hang (RED before the fix, GREEN after -- see commit message for the captured RED output)', () => {
    const r = runInChild('FOO', 'FOO');
    expect(r.status, `child stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toBe('false');
  });

  it('a non-global rule where an allowed token AND a real hit share the line still returns true (fail-closed)', () => {
    const r = runInChild('FOO and BAR both here', 'FOO|BAR');
    expect(r.status, `child stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toBe('true');
  });

  it('the existing global-rule (device_serial) behavior stays exactly as before the fix', () => {
    const deviceSerialRule = AUDIT_PUBLIC_RULES.find(r => r.class === 'device_serial');
    expect(deviceSerialRule.re.global).toBe(true);
    expect(lineHasUnallowedMatch('EVIDENCE1 only', deviceSerialRule)).toBe(false);
    expect(lineHasUnallowedMatch(`EVIDENCE1 and ${'ZZ0123' + '456789'}`, deviceSerialRule)).toBe(true);
  });

  // Second review round caught a fail-open regression in the first fix (commit 7405cdc): passing
  // the SHARED, already-global rule.re object straight into matchAll copies THAT object's current
  // lastIndex into the iterator (RegExp.prototype[@@matchAll] step 5) -- so a stale non-zero
  // lastIndex left behind by any earlier .test()/.exec() call on that same shared object (every
  // entry in AUDIT_PUBLIC_RULES is a long-lived, reused object, not a fresh one per call) silently
  // starts the scan past the beginning of the line, hiding a real privacy hit. Strictly worse than
  // the hang it replaced. Building a FRESH RegExp per call (never rule.re itself) fixes this.
  it('a stale non-zero lastIndex on the SHARED device_serial regex must never hide a real hit before that position (fail-open, caught in review of 7405cdc)', () => {
    const deviceSerialRule = AUDIT_PUBLIC_RULES.find(r => r.class === 'device_serial');
    const serial = 'R5CR20A' + 'BCDE'; // device_serial shape, split at write time (see SERIAL_FIXTURE above)
    const line = `serial ${serial} here, then EVIDENCE1 later in the same line`;
    try {
      deviceSerialRule.re.lastIndex = 30; // stale -- simulates a prior .test()/.exec() call on this SAME shared object
      expect(lineHasUnallowedMatch(line, deviceSerialRule)).toBe(true);
    } finally {
      deviceSerialRule.re.lastIndex = 0; // never leak state into other tests sharing this rule object
    }
  });
});

// ---------------------------------------------------------------------------
// 15. Importing the module does NOT execute main (entry-point guard)
// ---------------------------------------------------------------------------
describe('module import guard', () => {
  it('importing decouple-audit.mjs exports functions without side effects', async () => {
    // The import at the top of this file already triggered the module load.
    // If main() had run, it would have called git ls-files and process.exit —
    // neither of which happened. Verify the exports are callable functions.
    expect(typeof AUDIT_PUBLIC_RULES).toBe('object');
    expect(typeof shouldSkip).toBe('function');
    expect(typeof scanFile).toBe('function');
    expect(typeof buildRules).toBe('function');
    expect(typeof compareShas).toBe('function');
    expect(typeof hasBinaryNul).toBe('function');
  });
});

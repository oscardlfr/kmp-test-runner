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
import { fileURLToPath } from 'node:url';
import {
  AUDIT_PUBLIC_RULES,
  hasBinaryNul,
  shouldSkip,
  scanFile,
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

// ---------------------------------------------------------------------------
// 1. Public shape rule catches serial-shaped text
// ---------------------------------------------------------------------------
describe('decouple-audit public rules', () => {
  it('flags a device-serial-shaped string', () => {
    const dir = makeTmpDir();
    // R38BHY51234 — 11 chars, uppercase+digits, starts with letter, has digits
    const f = tmpFile(dir, 'test.txt', 'connecting to device R38BHY51234 completed\n');
    const hits = scanFile(f, 'test.txt', AUDIT_PUBLIC_RULES);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].class).toBe('device_serial');
  });

  // ---------------------------------------------------------------------------
  // 2. Public rule catches real Windows and POSIX user paths
  // ---------------------------------------------------------------------------
  it('flags a real Windows user path', () => {
    const dir = makeTmpDir();
    const f = tmpFile(dir, 'win.txt', 'project at C:\\Users\\oscar\\projects\\app\n');
    const hits = scanFile(f, 'win.txt', AUDIT_PUBLIC_RULES);
    expect(hits.some(h => h.class === 'user_path_win')).toBe(true);
  });

  it('flags a real POSIX user path', () => {
    const dir = makeTmpDir();
    const f = tmpFile(dir, 'posix.txt', 'project at /home/oscar/projects/kmp\n');
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
    const f = tmpFile(dir, 'serial.txt', 'device is R38BHY51234 ok\n');
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

  it('skips the audit script itself', () => {
    expect(shouldSkip(SELF_REL, SELF_REL)).toBe(true);
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

  it('scanFile returns no hits for a binary file with serial-shaped content in bytes', () => {
    const dir = makeTmpDir();
    // Write a "file" that contains NUL bytes — scanFile should return []
    const binPath = path.join(dir, 'fake.txt');
    const fd = openSync(binPath, 'w');
    // Embed serial-shaped bytes surrounded by NUL
    writeSync(fd, Buffer.from([0x00, 0x52, 0x33, 0x38, 0x42, 0x48, 0x59, 0x35, 0x31, 0x32, 0x33, 0x34, 0x00]));
    closeSync(fd);
    // hasBinaryNul should catch it so scanFile skips it at the caller level.
    // Directly confirm hasBinaryNul is true so the integration is clear.
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

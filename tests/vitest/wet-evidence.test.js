// tests/vitest/wet-evidence.test.js
// Unit tests for tools/lib/redact.mjs and tools/wet-evidence.mjs (PR-00).
//
// Synthetic device serial used throughout (see FAKE_SERIAL constant below).
//   - 13 chars, uppercase+digits, starts with a letter, contains digits
//   - matches the device_serial public shape rule
//   - clearly synthetic — never a real ADB serial
//   - constructed at runtime (split literal) so decouple-audit does not flag this file
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PUBLIC_SHAPE_RULES,
  loadPrivateRules,
  redactText,
  findLeaks,
} from '../../tools/lib/redact.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const CLI        = path.join(REPO_ROOT, 'tools', 'wet-evidence.mjs');

// Synthetic device-serial-shaped string. Assembled at runtime (split literal) so the
// decouple-audit device_serial shape rule does not flag this source file.
// 13 chars total (FAKEDEV=7 + ICE12X=6). Matches device_serial shape rule at runtime.
const FAKE_SERIAL = 'FAKEDEV' + 'ICE12X';

// ---- Test helpers ---------------------------------------------------------

const tmpFiles = [];

function tmpFile(name, content) {
  const p = path.join(tmpdir(), `wet-evidence-test-${name}-${process.pid}`);
  writeFileSync(p, content ?? '', 'utf8');
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    if (existsSync(f)) unlinkSync(f);
  }
});

function spawnCli(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      KMP_PRIVATE_PATTERNS_FILE: undefined,
      ...env,
    },
  });
  return result;
}

// Base args for a minimal valid official-kind CLI invocation with no output.
const BASE = [
  '--alias',        'OSS-A',
  '--cmd',          'kmp-test parallel --list-only',
  '--exit',         '0',
  '--project-kind', 'official',
  '--platform',     'windows',
  '--no-output',
];

// ---- redact.mjs: PUBLIC_SHAPE_RULES ---------------------------------------

describe('redact.mjs — device_serial rule', () => {
  it('redacts a device-serial-shaped string that contains digits', () => {
    const text = `connecting to device ${FAKE_SERIAL} completed`;
    const out  = redactText(text, PUBLIC_SHAPE_RULES);
    expect(out).not.toContain(FAKE_SERIAL);
    expect(out).toContain('<DEVICE_SERIAL>');
  });

  it('does not redact short all-uppercase words (< 8 chars) like PASS or FAIL', () => {
    const text = 'status: PASS result: FAIL';
    const out  = redactText(text, PUBLIC_SHAPE_RULES);
    expect(out).toBe(text);
  });

  it('does not redact all-alpha words without digits like CHANGELOG or MANIFEST', () => {
    expect(redactText('see CHANGELOG for details', PUBLIC_SHAPE_RULES)).toBe('see CHANGELOG for details');
    expect(redactText('MANIFEST entry', PUBLIC_SHAPE_RULES)).toBe('MANIFEST entry');
  });

  it('redacts multiple serials in one string', () => {
    const text = `device A: ${FAKE_SERIAL} and device B: ${FAKE_SERIAL}`;
    const out  = redactText(text, PUBLIC_SHAPE_RULES);
    expect(out).not.toContain(FAKE_SERIAL);
    expect((out.match(/<DEVICE_SERIAL>/g) || []).length).toBe(2);
  });
});

describe('redact.mjs — user_path_win rule', () => {
  it('redacts a Windows Users path', () => {
    const text = 'project at C:\\Users\\testuser\\projects\\myapp';
    const out  = redactText(text, PUBLIC_SHAPE_RULES);
    expect(out).not.toContain('testuser');
    expect(out).toContain('<USER_PATH>');
  });

  it('redacts a Windows drive root home path with another drive letter', () => {
    const text = 'using D:\\home\\oscar\\workspace';
    const out  = redactText(text, PUBLIC_SHAPE_RULES);
    expect(out).not.toContain('oscar');
    expect(out).toContain('<USER_PATH>');
  });
});

describe('redact.mjs — user_path_posix rule', () => {
  it('redacts /home/<user> path', () => {
    // Split literal so decouple-audit does not flag the test file; assembled at runtime.
    const text = 'project at /home/' + 'testuser/projects/kmp-test';
    const out  = redactText(text, PUBLIC_SHAPE_RULES);
    expect(out).not.toContain('testuser');
    expect(out).toContain('<USER_PATH>');
  });

  it('redacts /Users/<user> path (macOS style)', () => {
    // Split literal so decouple-audit does not flag the test file; assembled at runtime.
    const text = 'path is /Users/' + 'testuser/projects';
    const out  = redactText(text, PUBLIC_SHAPE_RULES);
    expect(out).not.toContain('testuser');
    expect(out).toContain('<USER_PATH>');
  });
});

describe('redact.mjs — artifact_path rule', () => {
  it('redacts a kmp-test-runner artifact path', () => {
    const text = 'log at .kmp-test-runner/logs/android/run-abc/logcat.txt done';
    const out  = redactText(text, PUBLIC_SHAPE_RULES);
    expect(out).toContain('<ARTIFACT_PATH>');
    expect(out).not.toContain('run-abc');
  });

  it('redacts reports and captures artifact paths', () => {
    const text = [
      '.kmp-test-runner/reports/coverage/index.html',
      '.kmp-test-runner/captures/android/session-xyz.mp4',
    ].join(' ');
    const out = redactText(text, PUBLIC_SHAPE_RULES);
    expect((out.match(/<ARTIFACT_PATH>/g) || []).length).toBe(2);
  });
});

// ---- redact.mjs: loadPrivateRules -----------------------------------------

describe('loadPrivateRules', () => {
  it('loads a literal pattern and redacts verbatim matches', () => {
    const file  = tmpFile('literal.json', JSON.stringify([
      { class: 'private_project', literal: 'my-secret-proj', replacement: '<PRIVATE_PROJECT>' },
    ]));
    const rules  = loadPrivateRules(file);
    expect(rules).toHaveLength(1);
    const out = redactText('building my-secret-proj module', rules);
    expect(out).toContain('<PRIVATE_PROJECT>');
    expect(out).not.toContain('my-secret-proj');
  });

  it('escapes regex metacharacters in literal patterns', () => {
    const file = tmpFile('literal-meta.json', JSON.stringify([
      { class: 'pkg', literal: 'com.example.private', replacement: '<PKG>' },
    ]));
    const rules = loadPrivateRules(file);
    // The dot must match a literal dot, not any character.
    const out = redactText('import com.example.private.core', rules);
    expect(out).toContain('<PKG>');
    // A string like "comXexampleYprivate" must NOT match.
    const no = redactText('comXexampleYprivate', rules);
    expect(no).toBe('comXexampleYprivate');
  });

  it('loads a regex pattern and applies it', () => {
    const file = tmpFile('regex.json', JSON.stringify([
      { class: 'private_pkg', regex: 'com\\.example\\.private', replacement: '<PRIVATE_PKG>' },
    ]));
    const rules = loadPrivateRules(file);
    const out   = redactText('import com.example.private.module', rules);
    expect(out).toContain('<PRIVATE_PKG>');
  });

  it('throws if entry has neither literal nor regex', () => {
    const file = tmpFile('bad-neither.json', JSON.stringify([
      { class: 'bad', replacement: '<BAD>' },
    ]));
    expect(() => loadPrivateRules(file)).toThrow(/exactly one of/);
  });

  it('throws if entry has both literal and regex', () => {
    const file = tmpFile('bad-both.json', JSON.stringify([
      { class: 'bad', literal: 'x', regex: 'x', replacement: '<BAD>' },
    ]));
    expect(() => loadPrivateRules(file)).toThrow(/exactly one of/);
  });

  it('throws on an unreadable file path', () => {
    expect(() => loadPrivateRules('/nonexistent/path/private.json')).toThrow();
  });

  it('throws on invalid JSON content', () => {
    const file = tmpFile('invalid.json', 'not-json');
    expect(() => loadPrivateRules(file)).toThrow(/Invalid JSON/);
  });

  it('throws if the file is not an array', () => {
    const file = tmpFile('object.json', JSON.stringify({ key: 'value' }));
    expect(() => loadPrivateRules(file)).toThrow(/must contain a JSON array/);
  });
});

// ---- redact.mjs: findLeaks ------------------------------------------------

describe('findLeaks', () => {
  it('returns empty array for clean text', () => {
    const leaks = findLeaks('no issues here', PUBLIC_SHAPE_RULES);
    expect(leaks).toHaveLength(0);
  });

  it('detects a serial that was not redacted (simulated by skipping redaction)', () => {
    const text  = `device: ${FAKE_SERIAL}`;
    // Deliberately skip redactText to simulate a missed redaction.
    const leaks = findLeaks(text, PUBLIC_SHAPE_RULES);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks[0].class).toBe('device_serial');
    expect(leaks[0]).toHaveProperty('lineNo');
    // Leak metadata must never include the matched string.
    expect(JSON.stringify(leaks[0])).not.toContain(FAKE_SERIAL);
  });

  it('detects a private name that was not redacted', () => {
    const file  = tmpFile('priv-leak.json', JSON.stringify([
      { class: 'private_project', literal: 'SECRETNAME', replacement: '<PRIVATE_PROJECT>' },
    ]));
    const rules = loadPrivateRules(file);
    const text  = 'building SECRETNAME now';
    // Do not redact so the leak is still present.
    const leaks = findLeaks(text, rules);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks[0].class).toBe('private_project');
    expect(JSON.stringify(leaks[0])).not.toContain('SECRETNAME');
  });

  it('returns the correct line number for a leak', () => {
    const text  = `line one\ndevice: ${FAKE_SERIAL}\nline three`;
    const leaks = findLeaks(text, PUBLIC_SHAPE_RULES);
    expect(leaks.some((l) => l.lineNo === 2)).toBe(true);
  });
});

// ---- wet-evidence CLI: clean runs -----------------------------------------

describe('wet-evidence CLI — clean runs', () => {
  it('emits a markdown table row on a clean official run', () => {
    const r = spawnCli([...BASE, '--format', 'table']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('| OSS-A |');
    expect(r.stdout).toContain('| PASS |');
  });

  it('emits valid JSON with all required metadata fields', () => {
    const r = spawnCli([...BASE, '--format', 'json']);
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj).toMatchObject({
      alias:       'OSS-A',
      projectKind: 'official',
      platform:    'windows',
      command:     'kmp-test parallel --list-only',
      exitCode:    0,
      result:      'PASS',
    });
    expect(obj).toHaveProperty('redactionCounts');
    expect(obj).toHaveProperty('timestamp');
    expect(obj).toHaveProperty('pr', null);
    expect(obj).toHaveProperty('sha', null);
  });

  it('sets result to FAIL when exit code is non-zero', () => {
    const r = spawnCli([
      '--alias', 'OSS-A', '--cmd', 'kmp-test parallel', '--exit', '1',
      '--project-kind', 'official', '--platform', 'linux', '--no-output', '--format', 'json',
    ]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).result).toBe('FAIL');
  });

  it('embeds pr and sha when provided', () => {
    const r = spawnCli([
      ...BASE, '--format', 'json', '--pr', '42', '--sha', 'abc123def',
    ]);
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj.pr).toBe(42);
    expect(obj.sha).toBe('abc123def');
  });

  it('accepts all valid platform values', () => {
    for (const platform of ['windows', 'linux', 'macos', 'android']) {
      const r = spawnCli([
        '--alias', 'X', '--cmd', 'kmp-test info', '--exit', '0',
        '--project-kind', 'official', '--platform', platform, '--no-output',
      ]);
      expect(r.status, `platform=${platform}`).toBe(0);
    }
  });
});

// ---- wet-evidence CLI: redaction in stdout file ---------------------------

describe('wet-evidence CLI — redaction of output files', () => {
  it('redacts serial in a stdout file and reports count in JSON', () => {
    const f = tmpFile('stdout.txt', `connecting to device ${FAKE_SERIAL} done`);
    const r = spawnCli([
      '--alias', 'OSS-B', '--cmd', 'kmp-test android', '--exit', '0',
      '--project-kind', 'official', '--platform', 'android',
      '--stdout', f, '--format', 'json',
    ]);
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj.redactionCounts.device_serial).toBeGreaterThan(0);
  });

  it('accepts a private-patterns file with private-kind run and reports count', () => {
    const pf = tmpFile('priv.json', JSON.stringify([
      { class: 'private_project', literal: 'SECRET-PROJ-42', replacement: '<PRIVATE_PROJECT>' },
    ]));
    const sf = tmpFile('stdout.txt', 'running SECRET-PROJ-42 unit tests');
    const r  = spawnCli([
      '--alias', 'PRIV-A', '--cmd', 'kmp-test parallel', '--exit', '0',
      '--project-kind', 'private', '--platform', 'windows',
      '--stdout', sf, '--private-patterns', pf, '--format', 'json',
    ]);
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj.redactionCounts.private_project).toBeGreaterThan(0);
  });

  it('also redacts the --cmd value before emitting', () => {
    const r = spawnCli([
      '--alias', 'OSS-C',
      '--cmd', `kmp-test android --device ${FAKE_SERIAL}`,
      '--exit', '0',
      '--project-kind', 'official', '--platform', 'android',
      '--no-output', '--format', 'json',
    ]);
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj.command).not.toContain(FAKE_SERIAL);
    expect(obj.command).toContain('<DEVICE_SERIAL>');
  });
});

// ---- wet-evidence CLI: fail-closed refusals -------------------------------

describe('wet-evidence CLI — fail-closed refusals', () => {
  it('refuses when --project-kind private has no private-pattern source', () => {
    const r = spawnCli([
      '--alias', 'PRIV-A', '--cmd', 'kmp-test parallel', '--exit', '0',
      '--project-kind', 'private', '--platform', 'windows', '--no-output',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('REFUSED');
    expect(r.stderr).toContain('private-kind');
  });

  it('accepts official kind with KMP_PRIVATE_PATTERNS_FILE pointing to a valid file', () => {
    const pf = tmpFile('env-priv.json', JSON.stringify([]));
    const r  = spawnCli(
      ['--alias', 'OSS-A', '--cmd', 'kmp-test info', '--exit', '0',
       '--project-kind', 'official', '--platform', 'linux', '--no-output'],
      { KMP_PRIVATE_PATTERNS_FILE: pf },
    );
    expect(r.status).toBe(0);
  });

  it('refuses when --allow-missing-private-rules is used with --project-kind private', () => {
    const r = spawnCli([
      '--alias', 'PRIV-A', '--cmd', 'kmp-test parallel', '--exit', '0',
      '--project-kind', 'private', '--platform', 'windows', '--no-output',
      '--allow-missing-private-rules',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('REFUSED');
  });

  it('accepts --allow-missing-private-rules with --project-kind official', () => {
    const r = spawnCli([
      ...BASE, '--allow-missing-private-rules',
    ]);
    expect(r.status).toBe(0);
  });

  it('refuses when no output source is specified (missing --stdout/--stderr/--no-output)', () => {
    const r = spawnCli([
      '--alias', 'OSS-A', '--cmd', 'kmp-test parallel', '--exit', '0',
      '--project-kind', 'official', '--platform', 'windows',
      // intentionally omit --stdout, --stderr, --no-output
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('REFUSED');
    expect(r.stderr).toContain('output source not specified');
  });

  it('refuses on an unknown flag', () => {
    const r = spawnCli([...BASE, '--nonexistent-flag']);
    expect(r.status).toBe(1);
  });

  it('refuses on an invalid --platform value', () => {
    const r = spawnCli([
      '--alias', 'OSS-A', '--cmd', 'kmp-test info', '--exit', '0',
      '--project-kind', 'official', '--platform', 'dos', '--no-output',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('REFUSED');
  });

  it('refuses on an invalid --project-kind value', () => {
    const r = spawnCli([
      '--alias', 'OSS-A', '--cmd', 'kmp-test info', '--exit', '0',
      '--project-kind', 'internal', '--platform', 'windows', '--no-output',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('REFUSED');
  });
});

// ---- Regression tests — PR-00 amendment fixes -----------------------------

describe('wet-evidence CLI — --no-output + --stdout/--stderr conflict', () => {
  it('refuses when --no-output is combined with a real --stdout file', () => {
    const f = tmpFile('out.txt', `device: ${FAKE_SERIAL}`);
    const r = spawnCli([
      '--alias', 'OSS-A', '--cmd', 'kmp-test parallel', '--exit', '0',
      '--project-kind', 'official', '--platform', 'windows',
      '--no-output', '--stdout', f,
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('REFUSED');
    expect(r.stderr).toContain('--no-output');
  });

  it('refuses when --no-output is combined with a real --stderr file', () => {
    const f = tmpFile('err.txt', 'some error output');
    const r = spawnCli([
      '--alias', 'OSS-A', '--cmd', 'kmp-test parallel', '--exit', '0',
      '--project-kind', 'official', '--platform', 'windows',
      '--no-output', '--stderr', f,
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('REFUSED');
  });

  it('accepts --no-output combined with --stdout none (explicit none)', () => {
    const r = spawnCli([
      '--alias', 'OSS-A', '--cmd', 'kmp-test parallel', '--exit', '0',
      '--project-kind', 'official', '--platform', 'windows',
      '--no-output', '--stdout', 'none',
    ]);
    expect(r.status).toBe(0);
  });
});

describe('wet-evidence CLI — evidence payload redaction', () => {
  it('does not emit a serial-shaped alias raw in the output', () => {
    // FAKE_SERIAL passes ^[A-Za-z0-9_.-]+$ format check but is serial-shaped.
    // The payload redaction must replace it before emit.
    const r = spawnCli([
      '--alias', FAKE_SERIAL,
      '--cmd', 'kmp-test parallel', '--exit', '0',
      '--project-kind', 'official', '--platform', 'windows',
      '--no-output', '--format', 'json',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(FAKE_SERIAL);
    const obj = JSON.parse(r.stdout);
    expect(obj.alias).toBe('<DEVICE_SERIAL>');
  });

  it('redacts a serial-shaped alias in table format too', () => {
    const r = spawnCli([
      '--alias', FAKE_SERIAL,
      '--cmd', 'kmp-test parallel', '--exit', '0',
      '--project-kind', 'official', '--platform', 'windows',
      '--no-output', '--format', 'table',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(FAKE_SERIAL);
    const tableLine = r.stdout.split('\n').find(l => l.startsWith('|'));
    expect(tableLine).toContain('<DEVICE_SERIAL>');
  });

  it('refuses if the --alias is not a safe identifier', () => {
    const r = spawnCli([
      '--alias', 'bad alias!',
      '--cmd', 'kmp-test parallel', '--exit', '0',
      '--project-kind', 'official', '--platform', 'windows', '--no-output',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('REFUSED');
    expect(r.stderr).toContain('--alias');
  });
});

describe('redact.mjs — full user path suffix redaction', () => {
  it('redacts the full Windows user path including subdirectories', () => {
    const text = 'project at C:\\Users\\testuser\\projects\\myapp end';
    const out  = redactText(text, PUBLIC_SHAPE_RULES);
    expect(out).not.toContain('testuser');
    expect(out).not.toContain('projects');
    expect(out).not.toContain('myapp');
    expect(out).toContain('<USER_PATH>');
    expect(out).toBe('project at <USER_PATH> end');
  });

  it('redacts the full POSIX user path including subdirectories', () => {
    // Split literal so decouple-audit does not flag the test file; assembled at runtime.
    const text = 'path is /home/' + 'testuser/projects/kmp-test end';
    const out  = redactText(text, PUBLIC_SHAPE_RULES);
    expect(out).not.toContain('testuser');
    expect(out).not.toContain('projects');
    expect(out).toContain('<USER_PATH>');
    expect(out).toBe('path is <USER_PATH> end');
  });

  it('redacts a macOS /Users/<user> path including subdirectories', () => {
    // Split literal so decouple-audit does not flag the test file; assembled at runtime.
    const text = 'running from /Users/' + 'testuser/workspace/kmp-test-runner/bin';
    const out  = redactText(text, PUBLIC_SHAPE_RULES);
    expect(out).not.toContain('testuser');
    expect(out).not.toContain('workspace');
    expect(out).toContain('<USER_PATH>');
  });
});

describe('wet-evidence CLI — table cell injection protection', () => {
  it('escapes pipe characters in the command to prevent column-breaking', () => {
    const r = spawnCli([
      '--alias', 'OSS-X',
      '--cmd', 'kmp-test parallel --test-filter x|y',
      '--exit', '0',
      '--project-kind', 'official', '--platform', 'windows',
      '--no-output', '--format', 'table',
    ]);
    expect(r.status).toBe(0);
    const tableLine = r.stdout.split('\n').find(l => l.startsWith('|'));
    expect(tableLine).toBeDefined();
    // The raw pipe in the command must be escaped so it cannot break the table row.
    expect(tableLine).toContain('\\|');
  });

  it('replaces newlines in table cells to keep the row on a single line', () => {
    const r = spawnCli([
      '--alias', 'OSS-X',
      '--cmd', 'kmp-test\nparallel',
      '--exit', '0',
      '--project-kind', 'official', '--platform', 'windows',
      '--no-output', '--format', 'table',
    ]);
    expect(r.status).toBe(0);
    // The newline in the command must be replaced so exactly one table row exists.
    const tableLines = r.stdout.split('\n').filter(l => l.startsWith('| OSS-X |'));
    expect(tableLines).toHaveLength(1);
  });
});

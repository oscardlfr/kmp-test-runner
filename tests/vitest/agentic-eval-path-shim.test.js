// tests/vitest/agentic-eval-path-shim.test.js
// Unit tests for tools/agentic-eval/path-shim.mjs. Content/string assertions plus a real
// local node-subprocess variant (no Claude, no network) proving the HOME/USERPROFILE redirect
// and worktree-pinning actually take effect, matching the existing repo idiom of real
// subprocess tests over mocking (e.g. decouple-audit.test.js).
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { buildPathShim } from '../../tools/agentic-eval/path-shim.mjs';

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function makeFakeWorktree() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aeps-worktree-'));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  writeFileSync(
    path.join(dir, 'bin', 'kmp-test.js'),
    '#!/usr/bin/env node\nconsole.log("PINNED-VERSION-MARKER");\nconsole.log(require("os").homedir());\n',
  );
  return dir;
}

describe('buildPathShim -- content assertions', () => {
  it('generates both a POSIX shim (no extension) and a Windows .cmd shim', () => {
    const worktreeRoot = makeFakeWorktree();
    const { shimDir, posixShimPath, cmdShimPath } = buildPathShim({ worktreeRoot });
    tmpDirs.push(shimDir);
    expect(posixShimPath.endsWith(path.join(shimDir, 'kmp-test'))).toBe(true);
    expect(cmdShimPath.endsWith('kmp-test.cmd')).toBe(true);
  });

  it('the POSIX shim sets HOME/USERPROFILE from KMP_EVAL_TEMP_HOME before exec-ing node', () => {
    const worktreeRoot = makeFakeWorktree();
    const { shimDir, posixShimPath } = buildPathShim({ worktreeRoot });
    tmpDirs.push(shimDir);
    const content = readFileSync(posixShimPath, 'utf8');
    expect(content).toContain('HOME="$KMP_EVAL_TEMP_HOME"');
    expect(content).toContain('USERPROFILE="$KMP_EVAL_TEMP_HOME"');
    expect(content).toContain('exec node');
  });

  it('the POSIX shim resolves to this specific worktree bin/kmp-test.js, not a bare "kmp-test"', () => {
    const worktreeRoot = makeFakeWorktree();
    const { shimDir, posixShimPath } = buildPathShim({ worktreeRoot });
    tmpDirs.push(shimDir);
    const content = readFileSync(posixShimPath, 'utf8');
    expect(content).toContain('bin/kmp-test.js');
    expect(content).toContain(worktreeRoot.replace(/\\/g, '/'));
  });

  it('the .cmd shim sets HOME/USERPROFILE and invokes node with the pinned path', () => {
    const worktreeRoot = makeFakeWorktree();
    const { shimDir, cmdShimPath } = buildPathShim({ worktreeRoot });
    tmpDirs.push(shimDir);
    const content = readFileSync(cmdShimPath, 'utf8');
    expect(content).toContain('set "HOME=%KMP_EVAL_TEMP_HOME%"');
    expect(content).toContain('set "USERPROFILE=%KMP_EVAL_TEMP_HOME%"');
    expect(content).toContain('kmp-test.js');
  });
});

describe('buildPathShim -- real subprocess variant (local node only, no Claude, no network)', () => {
  it('resolves to the pinned worktree marker, and redirects HOME for the grandchild process', () => {
    const worktreeRoot = makeFakeWorktree();
    const { shimDir, posixShimPath } = buildPathShim({ worktreeRoot });
    tmpDirs.push(shimDir);
    const tempHome = mkdtempSync(path.join(os.tmpdir(), 'aeps-home-'));
    tmpDirs.push(tempHome);

    const r = spawnSync('bash', ['-c', posixShimPath.replace(/\\/g, '/')], {
      env: { ...process.env, KMP_EVAL_TEMP_HOME: tempHome },
      encoding: 'utf8',
    });
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toBe('PINNED-VERSION-MARKER');
    expect(lines[1]).toBe(tempHome);
  });

  it('a synthetic ~/.kmp-test/config.json in a mock "real" home is not visible through the shim', () => {
    const worktreeRoot = makeFakeWorktree();
    const { shimDir, posixShimPath } = buildPathShim({ worktreeRoot });
    tmpDirs.push(shimDir);

    const mockRealHome = mkdtempSync(path.join(os.tmpdir(), 'aeps-real-home-'));
    tmpDirs.push(mockRealHome);
    mkdirSync(path.join(mockRealHome, '.kmp-test'), { recursive: true });
    writeFileSync(path.join(mockRealHome, '.kmp-test', 'config.json'), '{"marker":"REAL-HOME-CONFIG-SHOULD-NOT-BE-SEEN"}');

    const tempHome = mkdtempSync(path.join(os.tmpdir(), 'aeps-temp-home-'));
    tmpDirs.push(tempHome);

    // Simulate the parent claude session's env having the real HOME (as it does for OAuth),
    // while KMP_EVAL_TEMP_HOME points elsewhere -- the shim must redirect to the temp one.
    const r = spawnSync('bash', ['-c', posixShimPath.replace(/\\/g, '/')], {
      env: { ...process.env, HOME: mockRealHome, USERPROFILE: mockRealHome, KMP_EVAL_TEMP_HOME: tempHome },
      encoding: 'utf8',
    });
    const homedirSeen = r.stdout.trim().split('\n')[1];
    expect(homedirSeen).toBe(tempHome);
    expect(homedirSeen).not.toBe(mockRealHome);
  });

  it('a worktree path containing shell metacharacters is invoked literally, not expanded', () => {
    // If the pinned path were ever embedded in a double-quoted bash string (it must not be),
    // bash would try to expand "$AEPS_METACHAR_PROBE_UNSET" as a variable -- unset, so it
    // silently becomes an empty string, corrupting the path and breaking the exec. Single-quote
    // escaping keeps a '$'-bearing path segment fully literal.
    const parent = mkdtempSync(path.join(os.tmpdir(), 'aeps-metachar-'));
    tmpDirs.push(parent);
    const worktreeRoot = path.join(parent, '$AEPS_METACHAR_PROBE_UNSET-dir');
    mkdirSync(path.join(worktreeRoot, 'bin'), { recursive: true });
    writeFileSync(
      path.join(worktreeRoot, 'bin', 'kmp-test.js'),
      '#!/usr/bin/env node\nconsole.log("PINNED-VERSION-MARKER");\nconsole.log(require("os").homedir());\n',
    );

    const { shimDir, posixShimPath } = buildPathShim({ worktreeRoot });
    tmpDirs.push(shimDir);
    const tempHome = mkdtempSync(path.join(os.tmpdir(), 'aeps-metachar-home-'));
    tmpDirs.push(tempHome);

    const r = spawnSync('bash', ['-c', posixShimPath.replace(/\\/g, '/')], {
      env: { ...process.env, KMP_EVAL_TEMP_HOME: tempHome },
      encoding: 'utf8',
    });
    expect(r.stdout.trim().split('\n')[0]).toBe('PINNED-VERSION-MARKER');
  });
});

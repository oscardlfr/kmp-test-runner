// SPDX-License-Identifier: MIT
//
// tests/vitest/shebang-lf-guard.test.js — every tracked file whose FIRST LINE is a real `#!`
// shebang must be pinned `text eol=lf` in .gitattributes, so a Windows checkout with
// core.autocrlf=true can't corrupt it the way #533's hosted CI hit (CRLF broke vitest's ESM
// import of a shebang module).
//
// `git grep '^#!'` over-matches: a file can CONTAIN a `#!`-prefixed line without it being a real
// shebang, e.g. tests/installer/Install.Tests.ps1 embeds `#!/usr/bin/env node` inside a
// here-string building fixture content for a *different* file — its own real first line is
// `#Requires -Modules Pester`. This test narrows the broad grep to genuine first-line shebangs
// before asserting anything, and `git check-attr eol` queries git's own attribute resolution
// directly, so the assertion holds regardless of what line endings this checkout already has.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// Broad, cheap pre-filter: any tracked file containing a `^#!` line anywhere.
export function candidateShebangFiles(repoRoot = REPO_ROOT) {
  const r = spawnSync('git', ['grep', '-lz', '^#!', '--', '.'], { encoding: 'utf8', cwd: repoRoot });
  if (r.status === 1) return []; // git grep: no matches (not an error)
  if (r.status !== 0) throw new Error(`git grep failed: ${r.stderr || '(no output)'}`);
  return r.stdout.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
}

// True first line of the file on disk, CRLF-stripped, regardless of this checkout's own eol.
export function firstLine(relPath, repoRoot = REPO_ROOT) {
  let buf;
  try {
    buf = readFileSync(resolve(repoRoot, relPath));
  } catch {
    return '';
  }
  const nl = buf.indexOf(0x0a);
  const lineBuf = nl === -1 ? buf : buf.subarray(0, nl);
  return lineBuf.toString('utf8').replace(/\r$/, '');
}

// Precise filter: only files whose real first line starts with `#!`.
export function realShebangFiles(repoRoot = REPO_ROOT) {
  return candidateShebangFiles(repoRoot).filter((f) => firstLine(f, repoRoot).startsWith('#!'));
}

// What git's OWN attribute resolution reports for `eol` on this path right now.
export function checkAttrEol(relPath, repoRoot = REPO_ROOT) {
  const r = spawnSync('git', ['check-attr', 'eol', '--', relPath], { encoding: 'utf8', cwd: repoRoot });
  if (r.status !== 0) return 'unspecified';
  const m = r.stdout.match(/:\s*eol:\s*(\S+)\s*$/);
  return m ? m[1] : 'unspecified';
}

describe('every real shebang file is pinned text eol=lf', () => {
  const shebangFiles = realShebangFiles();

  it('found at least one real shebang file (guards against a vacuous pass if detection breaks)', () => {
    expect(shebangFiles.length).toBeGreaterThan(0);
  });

  it('excludes files whose #! only appears inside a here-string fixture, not on line 1', () => {
    expect(shebangFiles).not.toContain('tests/installer/Install.Tests.ps1');
  });

  it.each(shebangFiles)('%s is pinned eol=lf', (relPath) => {
    expect(checkAttrEol(relPath)).toBe('lf');
  });
});

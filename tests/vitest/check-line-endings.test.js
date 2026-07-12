// tests/vitest/check-line-endings.test.js
// Unit tests for tools/check-line-endings.mjs

import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hasCRLF, parseLFPatterns, shouldCheckLF, checkFiles } from '../../tools/check-line-endings.mjs';

// ---------------------------------------------------------------------------
// hasCRLF

describe('hasCRLF', () => {
  it('returns false for LF-only buffer', () => {
    expect(hasCRLF(Buffer.from('line1\nline2\n'))).toBe(false);
  });

  it('returns true for CRLF buffer', () => {
    expect(hasCRLF(Buffer.from('line1\r\nline2\r\n'))).toBe(true);
  });

  it('returns false for lone CR (old Mac line endings, not CRLF)', () => {
    expect(hasCRLF(Buffer.from('line1\rline2\r'))).toBe(false);
  });

  it('returns false for empty buffer', () => {
    expect(hasCRLF(Buffer.from(''))).toBe(false);
  });

  it('returns true when CRLF appears mid-file (mixed endings)', () => {
    expect(hasCRLF(Buffer.from('good\nbad\r\nend'))).toBe(true);
  });

  it('returns false for single-byte buffer', () => {
    expect(hasCRLF(Buffer.from([0x0d]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseLFPatterns

describe('parseLFPatterns', () => {
  it('ignores comment lines', () => {
    const text = '# This is a comment\nscripts/*.sh text eol=lf\n';
    const patterns = parseLFPatterns(text);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].raw).toBe('scripts/*.sh');
  });

  it('ignores empty lines', () => {
    const text = '\n\nscripts/*.sh text eol=lf\n\n';
    expect(parseLFPatterns(text)).toHaveLength(1);
  });

  it('excludes eol=crlf entries', () => {
    const text = 'gradlew.bat text eol=crlf\nscripts/*.sh text eol=lf\n';
    const patterns = parseLFPatterns(text);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].raw).toBe('scripts/*.sh');
  });

  it('excludes binary entries (no eol=lf attr)', () => {
    const text = 'gradle-wrapper.jar binary\nscripts/*.sh text eol=lf\n';
    expect(parseLFPatterns(text)).toHaveLength(1);
  });

  // ------------------------------------------------------------------
  // Glob semantics (critical — conversion is subtle)

  it('single * does not cross directory boundary', () => {
    const [p] = parseLFPatterns('scripts/*.sh text eol=lf\n');
    expect(p.regex.test('scripts/install.sh')).toBe(true);
    expect(p.regex.test('scripts/sh/run.sh')).toBe(false);
    expect(p.regex.test('other/scripts/install.sh')).toBe(false);
  });

  it('** matches zero path components (top-level file)', () => {
    const [p] = parseLFPatterns('scripts/**/*.sh text eol=lf\n');
    expect(p.regex.test('scripts/install.sh')).toBe(true);
  });

  it('** matches one path component (shallow subdirectory)', () => {
    const [p] = parseLFPatterns('scripts/**/*.sh text eol=lf\n');
    expect(p.regex.test('scripts/sh/run.sh')).toBe(true);
  });

  it('** matches multiple path components (deep subdirectory)', () => {
    const [p] = parseLFPatterns('scripts/**/*.sh text eol=lf\n');
    expect(p.regex.test('scripts/sh/lib/script-utils.sh')).toBe(true);
  });

  it('** pattern does not match paths outside the prefix', () => {
    const [p] = parseLFPatterns('scripts/**/*.sh text eol=lf\n');
    expect(p.regex.test('other/scripts/sh/run.sh')).toBe(false);
  });

  it('pattern starting with . is matched correctly (.skills)', () => {
    const [p] = parseLFPatterns('.skills/**/*.sh text eol=lf\n');
    expect(p.regex.test('.skills/kmp-test-runner/scripts/run-tests.sh')).toBe(true);
    expect(p.regex.test('skills/kmp-test-runner/scripts/run-tests.sh')).toBe(false);
  });

  it('exact path pattern matches only that path', () => {
    const [p] = parseLFPatterns('tools/release-gate.mjs text eol=lf\n');
    expect(p.regex.test('tools/release-gate.mjs')).toBe(true);
    expect(p.regex.test('tools/other-release-gate.mjs')).toBe(false);
    expect(p.regex.test('other/tools/release-gate.mjs')).toBe(false);
  });

  it('returns raw pattern string alongside regex', () => {
    const [p] = parseLFPatterns('tools/sync-versions.js text eol=lf\n');
    expect(p.raw).toBe('tools/sync-versions.js');
    expect(p.regex).toBeInstanceOf(RegExp);
  });
});

// ---------------------------------------------------------------------------
// shouldCheckLF

describe('shouldCheckLF', () => {
  const patterns = parseLFPatterns([
    'scripts/*.sh text eol=lf',
    'scripts/**/*.sh text eol=lf',
    '.skills/**/*.sh text eol=lf',
  ].join('\n'));

  it('matches a top-level script', () => {
    expect(shouldCheckLF('scripts/install.sh', patterns)).toBe(true);
  });

  it('matches a script in a subdirectory', () => {
    expect(shouldCheckLF('scripts/sh/run-parallel.sh', patterns)).toBe(true);
  });

  it('normalizes Windows backslash paths before matching', () => {
    expect(shouldCheckLF('scripts\\sh\\run-parallel.sh', patterns)).toBe(true);
  });

  it('does not match PowerShell scripts (no lf rule)', () => {
    expect(shouldCheckLF('scripts/ps1/Run-Tests.ps1', patterns)).toBe(false);
  });

  it('does not match gradlew.bat (not in any lf pattern)', () => {
    expect(shouldCheckLF('tests/fixtures/fake-gradlew/gradlew.bat', patterns)).toBe(false);
  });

  it('does not match a random .md file', () => {
    expect(shouldCheckLF('README.md', patterns)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkFiles

describe('checkFiles', () => {
  const lfPatterns = parseLFPatterns('test-scripts/**/*.sh text eol=lf\n');

  function makeDir() {
    return mkdtempSync(join(tmpdir(), 'cle-'));
  }

  it('returns checked=1 and no violations for an LF-only file', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'test-scripts', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'test-scripts', 'sub', 'ok.sh'), '#!/bin/sh\necho hi\n');
    const result = checkFiles(['test-scripts/sub/ok.sh'], dir, lfPatterns);
    expect(result.checked).toBe(1);
    expect(result.violations).toHaveLength(0);
  });

  it('reports a violation for a CRLF file', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'test-scripts', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'test-scripts', 'sub', 'bad.sh'), '#!/bin/sh\r\necho hi\r\n');
    const result = checkFiles(['test-scripts/sub/bad.sh'], dir, lfPatterns);
    expect(result.checked).toBe(1);
    expect(result.violations).toContain('test-scripts/sub/bad.sh');
  });

  it('skips files that do not match any LF pattern', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'readme.md'), 'Hello\r\nworld\r\n');
    const result = checkFiles(['readme.md'], dir, lfPatterns);
    expect(result.checked).toBe(0);
    expect(result.violations).toHaveLength(0);
  });

  it('checked count reflects only LF-required files', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'test-scripts'), { recursive: true });
    writeFileSync(join(dir, 'test-scripts', 'run.sh'), '#!/bin/sh\nok\n');
    writeFileSync(join(dir, 'other.txt'), 'text\r\n');
    const result = checkFiles(['test-scripts/run.sh', 'other.txt'], dir, lfPatterns);
    expect(result.checked).toBe(1);
  });

  it('violations contain file paths, not file content', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'test-scripts'), { recursive: true });
    writeFileSync(join(dir, 'test-scripts', 'sensitive.sh'), 'SECRET_TOKEN=abc123\r\n');
    const result = checkFiles(['test-scripts/sensitive.sh'], dir, lfPatterns);
    expect(result.violations).toContain('test-scripts/sensitive.sh');
    for (const v of result.violations) {
      expect(v).not.toContain('SECRET_TOKEN');
      expect(v).not.toContain('abc123');
    }
  });

  it('skips non-existent paths gracefully', () => {
    const dir = makeDir();
    const result = checkFiles(['test-scripts/missing.sh'], dir, lfPatterns);
    expect(result.checked).toBe(0);
    expect(result.violations).toHaveLength(0);
  });

  it('handles multiple files — reports all violations', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'test-scripts'), { recursive: true });
    writeFileSync(join(dir, 'test-scripts', 'a.sh'), 'ok\n');
    writeFileSync(join(dir, 'test-scripts', 'b.sh'), 'bad\r\n');
    writeFileSync(join(dir, 'test-scripts', 'c.sh'), 'also\r\nbad\r\n');
    const result = checkFiles(
      ['test-scripts/a.sh', 'test-scripts/b.sh', 'test-scripts/c.sh'],
      dir, lfPatterns
    );
    expect(result.checked).toBe(3);
    expect(result.violations).toHaveLength(2);
    expect(result.violations).toContain('test-scripts/b.sh');
    expect(result.violations).toContain('test-scripts/c.sh');
  });
});

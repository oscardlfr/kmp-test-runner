// tests/vitest/check-executable-fixtures.test.js
// Unit tests for tools/check-executable-fixtures.mjs -- see that module's own header comment for
// the incident this closes (a fake-claude-*/claude fixture committed at mode 100644 instead of
// 100755 broke ONLY on a real Linux checkout, invisible to every local check available at the
// time). The last test in this file is the one that would actually have caught it: a real
// `git ls-files -s` scan of the CURRENT repo state, asserting zero violations right now.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXECUTABLE_FIXTURE_PATTERN,
  parseLsFilesStageLine,
  findExecutableBitViolations,
} from '../../tools/check-executable-fixtures.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

describe('EXECUTABLE_FIXTURE_PATTERN', () => {
  it('matches a fake-claude-*/claude fixture path', () => {
    expect(EXECUTABLE_FIXTURE_PATTERN.test('tests/fixtures/fake-claude-run-foreign-skill-rejected/claude')).toBe(true);
  });

  it('does not match a DIFFERENT file inside the same fixture directory', () => {
    expect(EXECUTABLE_FIXTURE_PATTERN.test('tests/fixtures/fake-claude-run-foreign-skill-rejected/README.md')).toBe(false);
  });

  it('does not match an unrelated fixtures path', () => {
    expect(EXECUTABLE_FIXTURE_PATTERN.test('tests/fixtures/fake-gradlew/gradlew')).toBe(false);
  });

  it('does not match a nested subdirectory (exactly one directory level expected)', () => {
    expect(EXECUTABLE_FIXTURE_PATTERN.test('tests/fixtures/fake-claude-x/nested/claude')).toBe(false);
  });
});

describe('parseLsFilesStageLine', () => {
  it('parses a well-formed git ls-files -s line', () => {
    const line = '100755 c5f949c73f52da2bff0dbe761bc9de796a1725ca 0\ttests/fixtures/fake-claude-foreign-skill/claude';
    expect(parseLsFilesStageLine(line)).toEqual({ mode: '100755', path: 'tests/fixtures/fake-claude-foreign-skill/claude' });
  });

  it('normalizes backslashes to forward slashes', () => {
    const line = '100644 abc 0\ttests\\fixtures\\fake-claude-x\\claude';
    expect(parseLsFilesStageLine(line)?.path).toBe('tests/fixtures/fake-claude-x/claude');
  });

  it('returns null for a line not matching the expected shape', () => {
    expect(parseLsFilesStageLine('not a git ls-files line at all')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseLsFilesStageLine('')).toBeNull();
  });
});

describe('findExecutableBitViolations', () => {
  // The closest possible reproduction of the actual incident: this exact line shape (mode
  // 100644, the fake-claude-run-foreign-skill-confirmed/claude path) is what `git ls-files -s`
  // genuinely printed for the buggy commit before the fix.
  it('flags a fake-claude-*/claude fixture tracked at 100644 (the real incident shape)', () => {
    const output = '100644 29aab83f018d3306790016751262326affc74279 0\ttests/fixtures/fake-claude-run-foreign-skill-confirmed/claude\n';
    const violations = findExecutableBitViolations(output);
    expect(violations).toEqual([{ mode: '100644', path: 'tests/fixtures/fake-claude-run-foreign-skill-confirmed/claude' }]);
  });

  it('does not flag a fake-claude-*/claude fixture correctly tracked at 100755', () => {
    const output = '100755 c5f949c73f52da2bff0dbe761bc9de796a1725ca 0\ttests/fixtures/fake-claude-foreign-skill/claude\n';
    expect(findExecutableBitViolations(output)).toEqual([]);
  });

  it('does not flag a non-fixture file at 100644 (the common, correct case for most tracked files)', () => {
    const output = '100644 abc123 0\ttools/agentic-eval/cli.mjs\n';
    expect(findExecutableBitViolations(output)).toEqual([]);
  });

  // Regression guard for the exact false-positive class this check's own header comment warns
  // about: a shebang-carrying .sh file that is legitimately 100644 (a sourced library, or one
  // explicitly chmod'd inside a Dockerfile) must never be flagged -- EXECUTABLE_FIXTURE_PATTERN's
  // narrow scope (fake-claude-*/claude only) is what prevents this, not any shebang-sniffing.
  it('does not flag an unrelated shebang-carrying .sh file tracked at 100644 (sourced-library convention)', () => {
    const output = '100644 def456 0\tscripts/sh/lib/project-model.sh\n';
    expect(findExecutableBitViolations(output)).toEqual([]);
  });

  it('handles multiple lines, flagging only the violating ones', () => {
    const output = [
      '100755 aaa 0\ttests/fixtures/fake-claude-success/claude',
      '100644 bbb 0\ttests/fixtures/fake-claude-run-scenario-broken/claude',
      '100644 ccc 0\ttools/agentic-eval/schemas.mjs',
    ].join('\n');
    const violations = findExecutableBitViolations(output);
    expect(violations).toEqual([{ mode: '100644', path: 'tests/fixtures/fake-claude-run-scenario-broken/claude' }]);
  });

  it('returns [] for empty input', () => {
    expect(findExecutableBitViolations('')).toEqual([]);
  });
});

// The actual regression proof: a REAL `git ls-files -s` scan of the CURRENT repo. This is the
// exact check that -- had it existed before the incident -- would have failed the PR locally
// (on ANY platform, since it reads git's tracked mode directly, not a filesystem heuristic) before
// ever reaching a real Linux checkout.
describe('real repo scan (regression proof)', () => {
  it('every fake-claude-*/claude fixture currently tracked in this repo is 100755', () => {
    const r = spawnSync('git', ['ls-files', '-s'], { encoding: 'utf8', cwd: REPO_ROOT });
    expect(r.status).toBe(0);
    const violations = findExecutableBitViolations(r.stdout || '');
    expect(violations).toEqual([]);
  });

  it('the real scan actually finds fake-claude-*/claude fixtures to check (the check isn\'t vacuously passing)', () => {
    const r = spawnSync('git', ['ls-files', '-s'], { encoding: 'utf8', cwd: REPO_ROOT });
    const matched = (r.stdout || '').split('\n').filter((l) => {
      const parsed = parseLsFilesStageLine(l);
      return parsed && EXECUTABLE_FIXTURE_PATTERN.test(parsed.path);
    });
    expect(matched.length).toBeGreaterThan(0);
  });
});

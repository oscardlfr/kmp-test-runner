// tests/vitest/agentic-eval-materialize-fixture-setup.test.js
// Unit tests for tools/agentic-eval/materialize.mjs's applyFixtureSetup -- a new, separate concern
// split out from agentic-eval-materialize.test.js, mirroring the existing
// agentic-eval-materialize-best-effort-cleanup.test.js split-out precedent. Real `git`
// init/add/commit/worktree against throwaway repos -- local, no network, no Claude, matching the
// existing repo idiom of real subprocess tests over mocking.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  applyFixtureSetup,
  isExactlyOneUnstagedModificationAt,
  materializeScenarioProject,
} from '../../tools/agentic-eval/materialize.mjs';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';

// Mirrors agentic-eval-materialize.test.js's own bash-routing helpers exactly (same rationale:
// Windows-native spawnSync with shell:false mangles backslash-heavy path arguments).
function toPosixPath(winPath) {
  return winPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
}
const shQuote = (arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`;
function gitViaBash(argv, cwd) {
  const cmd = argv.map(shQuote).join(' ');
  const r = spawnSync(resolveBash(), ['-c', `git ${cmd}`], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout;
}

const cleanupDirs = [];
afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop(), { recursive: true, force: true });
});

const RELATIVE_PATH = 'core/common/src/main/kotlin/Result.kt';
const FILE_CONTENT = 'sealed class Result<T>\n';

/** Builds a throwaway source repo with exactly one tracked file at RELATIVE_PATH, committed, and
 * returns its real blob OID (never hand-computed/guessed -- read back from git itself). */
function makeSourceRepo() {
  const sourceRepoDir = mkdtempSync(path.join(os.tmpdir(), 'aefs-source-'));
  cleanupDirs.push(sourceRepoDir);
  gitViaBash(['init', '-q'], sourceRepoDir);
  gitViaBash(['config', 'user.email', 'test@example.com'], sourceRepoDir);
  gitViaBash(['config', 'user.name', 'Test'], sourceRepoDir);
  gitViaBash(['config', 'core.autocrlf', 'false'], sourceRepoDir);
  const fileDir = path.join(sourceRepoDir, 'core', 'common', 'src', 'main', 'kotlin');
  spawnSync(resolveBash(), ['-c', `mkdir -p ${shQuote(toPosixPath(fileDir))}`], { cwd: sourceRepoDir, encoding: 'utf8' });
  writeFileSync(path.join(sourceRepoDir, ...RELATIVE_PATH.split('/')), FILE_CONTENT);
  gitViaBash(['add', '-A'], sourceRepoDir);
  gitViaBash(['commit', '-q', '-m', 'initial'], sourceRepoDir);
  const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
  const blobOid = gitViaBash(['rev-parse', `HEAD:${RELATIVE_PATH}`], sourceRepoDir).trim();
  return { sourceRepoDir, pinnedCommit, blobOid };
}

function makeWorktree(sourceRepoDir, pinnedCommit) {
  const { fixtureDir } = materializeScenarioProject({ sourceRepoDir, pinnedCommit });
  cleanupDirs.push(fixtureDir);
  return fixtureDir;
}

describe('applyFixtureSetup -- precondition: clean tree required', () => {
  it('throws when a TRACKED file is already modified before the setup runs', () => {
    const { sourceRepoDir, pinnedCommit, blobOid } = makeSourceRepo();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    writeFileSync(path.join(fixtureDir, ...RELATIVE_PATH.split('/')), 'already dirty\n');
    expect(() => applyFixtureSetup({
      fixtureDir,
      fixtureSetup: { operation: 'append_comment', relative_path: RELATIVE_PATH, expected_blob_oid: blobOid },
    })).toThrow(/not clean/i);
  });

  it('throws when an UNTRACKED file is already present before the setup runs', () => {
    const { sourceRepoDir, pinnedCommit, blobOid } = makeSourceRepo();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    writeFileSync(path.join(fixtureDir, 'untracked-junk.txt'), 'junk');
    expect(() => applyFixtureSetup({
      fixtureDir,
      fixtureSetup: { operation: 'append_comment', relative_path: RELATIVE_PATH, expected_blob_oid: blobOid },
    })).toThrow(/not clean/i);
  });
});

describe('applyFixtureSetup -- target validation (defense in depth, independent of schema-level checks)', () => {
  it('throws on a traversal-shaped relative_path -- git itself refuses a pathspec outside the repo', () => {
    const { sourceRepoDir, pinnedCommit, blobOid } = makeSourceRepo();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    expect(() => applyFixtureSetup({
      fixtureDir,
      fixtureSetup: { operation: 'append_comment', relative_path: '../../../etc/passwd', expected_blob_oid: blobOid },
    })).toThrow(/outside repository|not a single tracked file/i);
  });

  it('throws on a relative_path that is not tracked at all', () => {
    const { sourceRepoDir, pinnedCommit, blobOid } = makeSourceRepo();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    expect(() => applyFixtureSetup({
      fixtureDir,
      fixtureSetup: { operation: 'append_comment', relative_path: 'does/not/exist.kt', expected_blob_oid: blobOid },
    })).toThrow(/not a single tracked file/i);
  });

  // Real gap this exact test caught pre-fix: a directory-shaped pathspec that happens to contain
  // exactly one file underneath it also produces exactly one `git ls-files -s` line -- but for a
  // DIFFERENT path (the file, not the directory) than what was actually requested. Without an
  // explicit entry.path===relativePath check, that file's mode/blob would validate fine while the
  // mutation still targeted the original (directory) path, crashing with EISDIR instead of failing
  // closed with a clear reason.
  it('throws on a relative_path naming a DIRECTORY, not a file -- even one containing exactly one real file', () => {
    const { sourceRepoDir, pinnedCommit, blobOid } = makeSourceRepo();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    expect(() => applyFixtureSetup({
      fixtureDir,
      fixtureSetup: { operation: 'append_comment', relative_path: 'core/common/src/main/kotlin', expected_blob_oid: blobOid },
    })).toThrow(/not a single tracked file/i);
  });

  it('throws when expected_blob_oid does not match the real tracked blob', () => {
    const { sourceRepoDir, pinnedCommit } = makeSourceRepo();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    expect(() => applyFixtureSetup({
      fixtureDir,
      fixtureSetup: { operation: 'append_comment', relative_path: RELATIVE_PATH, expected_blob_oid: 'd'.repeat(40) },
    })).toThrow(/blob mismatch/i);
  });

  it('throws when relative_path is tracked as a SYMLINK, not a regular file', () => {
    const sourceRepoDir = mkdtempSync(path.join(os.tmpdir(), 'aefs-source-symlink-'));
    cleanupDirs.push(sourceRepoDir);
    gitViaBash(['init', '-q'], sourceRepoDir);
    gitViaBash(['config', 'user.email', 'test@example.com'], sourceRepoDir);
    gitViaBash(['config', 'user.name', 'Test'], sourceRepoDir);
    gitViaBash(['config', 'core.autocrlf', 'false'], sourceRepoDir);
    writeFileSync(path.join(sourceRepoDir, 'real-target.kt'), 'real content\n');
    let symlinkSupported = true;
    try {
      symlinkSync('real-target.kt', path.join(sourceRepoDir, 'linked.kt'), 'file');
    } catch {
      symlinkSupported = false;
    }
    if (!symlinkSupported) return; // this host cannot create filesystem symlinks -- not this test's concern
    gitViaBash(['add', '-A'], sourceRepoDir);
    gitViaBash(['commit', '-q', '-m', 'initial with symlink'], sourceRepoDir);
    const lsOut = gitViaBash(['ls-files', '-s', '--', 'linked.kt'], sourceRepoDir).trim();
    if (!lsOut.startsWith('120000')) return; // git on this host didn't track it as a symlink (core.symlinks) -- not this test's concern
    const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
    const symlinkBlob = gitViaBash(['rev-parse', 'HEAD:linked.kt'], sourceRepoDir).trim();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    expect(() => applyFixtureSetup({
      fixtureDir,
      fixtureSetup: { operation: 'append_comment', relative_path: 'linked.kt', expected_blob_oid: symlinkBlob },
    })).toThrow(/not a regular file/i);
  });
});

describe('applyFixtureSetup -- correct application', () => {
  it('produces exactly one unstaged modification, appending the exact harness-constant comment', () => {
    const { sourceRepoDir, pinnedCommit, blobOid } = makeSourceRepo();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    applyFixtureSetup({
      fixtureDir,
      fixtureSetup: { operation: 'append_comment', relative_path: RELATIVE_PATH, expected_blob_oid: blobOid },
    });
    const status = gitViaBash(['status', '--porcelain'], fixtureDir);
    expect(isExactlyOneUnstagedModificationAt(status, RELATIVE_PATH)).toBe(true);
    const content = readFileSync(path.join(fixtureDir, ...RELATIVE_PATH.split('/')), 'utf8');
    expect(content.startsWith(FILE_CONTENT)).toBe(true);
    expect(content).toContain('kmp-agentic-eval-fixture-marker');
  });

  // The actual "leftover removed, setup recreated identically" proof this scenario's own
  // per-cell execution depends on: materializeScenarioProject's reset path (git clean -fdx &&
  // git reset --hard) always produces a byte-identical pristine tree before every cell, so
  // re-applying the fixed mutation on a FRESH reset must reproduce an identical diff every time.
  it('re-applying after a materializeScenarioProject reset produces a BYTE-IDENTICAL diff each time', () => {
    const { sourceRepoDir, pinnedCommit, blobOid } = makeSourceRepo();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    const setup = { operation: 'append_comment', relative_path: RELATIVE_PATH, expected_blob_oid: blobOid };

    applyFixtureSetup({ fixtureDir, fixtureSetup: setup });
    const firstDiff = gitViaBash(['diff', '--', RELATIVE_PATH], fixtureDir);
    const firstContent = readFileSync(path.join(fixtureDir, ...RELATIVE_PATH.split('/')), 'utf8');

    // Simulate the next cell: materializeScenarioProject's own reset path wipes the mutation.
    materializeScenarioProject({ sourceRepoDir, pinnedCommit, existingWorktreeDir: fixtureDir });
    expect(gitViaBash(['status', '--porcelain'], fixtureDir).trim()).toBe('');

    applyFixtureSetup({ fixtureDir, fixtureSetup: setup });
    const secondDiff = gitViaBash(['diff', '--', RELATIVE_PATH], fixtureDir);
    const secondContent = readFileSync(path.join(fixtureDir, ...RELATIVE_PATH.split('/')), 'utf8');

    expect(secondDiff).toBe(firstDiff);
    expect(secondContent).toBe(firstContent);
    expect(isExactlyOneUnstagedModificationAt(gitViaBash(['status', '--porcelain'], fixtureDir), RELATIVE_PATH)).toBe(true);
  });
});

describe('isExactlyOneUnstagedModificationAt (pure function -- direct unit coverage of the postcondition check)', () => {
  const P = 'core/common/src/main/kotlin/Result.kt';

  it('true for exactly one unstaged modification at the exact path', () => {
    expect(isExactlyOneUnstagedModificationAt(` M ${P}\n`, P)).toBe(true);
  });

  it('false when nothing changed at all', () => {
    expect(isExactlyOneUnstagedModificationAt('', P)).toBe(false);
  });

  it('false when the modification is STAGED (index dirty), not unstaged', () => {
    expect(isExactlyOneUnstagedModificationAt(`M  ${P}\n`, P)).toBe(false);
  });

  it('false when the file is staged AND unstaged modified (MM)', () => {
    expect(isExactlyOneUnstagedModificationAt(`MM ${P}\n`, P)).toBe(false);
  });

  it('false when the entry is an untracked file (??), not a modification', () => {
    expect(isExactlyOneUnstagedModificationAt(`?? ${P}\n`, P)).toBe(false);
  });

  it('false when more than one line is present, even if one matches exactly', () => {
    expect(isExactlyOneUnstagedModificationAt(` M ${P}\n M other/file.kt\n`, P)).toBe(false);
    expect(isExactlyOneUnstagedModificationAt(` M ${P}\n?? new-file.txt\n`, P)).toBe(false);
  });

  it('false when the single modified line is a DIFFERENT path than expected', () => {
    expect(isExactlyOneUnstagedModificationAt(' M some/other/path.kt\n', P)).toBe(false);
  });
});

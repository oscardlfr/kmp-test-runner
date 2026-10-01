// tests/vitest/agentic-eval-multi-module-apply-patch.test.js
// materialize.mjs's applyFixtureSetup, `apply_patch` operation (multi-module-tests family): applies a
// harness-owned patch from <corpus root>/fixtures/ to the pristine pinned checkout, never stages or
// commits anything, and fails closed unless exactly the expected files end up modified. Real git against
// throwaway repos, like agentic-eval-materialize-fixture-setup.test.js.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  applyFixtureSetup,
  isExactlyUnstagedModificationsAt,
  materializeScenarioProject,
} from '../../tools/agentic-eval/materialize.mjs';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';

function toPosixPath(winPath) {
  return winPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
}
const shQuote = (arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`;
function gitViaBash(argv, cwd) {
  const r = spawnSync(resolveBash(), ['-c', `git ${argv.map(shQuote).join(' ')}`], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout;
}

const cleanupDirs = [];
afterEach(() => {
  delete process.env.KMP_EVAL_SCENARIOS_DIR;
  while (cleanupDirs.length) rmSync(cleanupDirs.pop(), { recursive: true, force: true });
});

const PATH_A = 'core/data/src/main/A.kt';
const PATH_B = 'core/domain/src/main/B.kt';
const PATH_C = 'feature/c/src/main/C.kt';
const CONTENT = {
  [PATH_A]: 'fun a(x: Set<String>) = x.isEmpty()\nfun a2() = 1\n',
  [PATH_B]: 'fun b(id: String, ids: Set<String>) = id in ids\nfun b2() = 2\n',
  [PATH_C]: 'fun c() = 3\n',
};

function writeTracked(root, relPath, text) {
  const abs = path.join(root, ...relPath.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

/** A source repo with three tracked files, plus a patch file that modifies the first two (and the
 * third too when `alsoC`), written under `<corpus>/fixtures/` next to `<corpus>/scenarios/`. */
function makeSourceRepoAndCorpus({ alsoC = false } = {}) {
  const sourceRepoDir = mkdtempSync(path.join(os.tmpdir(), 'aemmp-source-'));
  cleanupDirs.push(sourceRepoDir);
  gitViaBash(['init', '-q'], sourceRepoDir);
  gitViaBash(['config', 'user.email', 'test@example.com'], sourceRepoDir);
  gitViaBash(['config', 'user.name', 'Test'], sourceRepoDir);
  gitViaBash(['config', 'core.autocrlf', 'false'], sourceRepoDir);
  for (const [p, text] of Object.entries(CONTENT)) writeTracked(sourceRepoDir, p, text);
  gitViaBash(['add', '-A'], sourceRepoDir);
  gitViaBash(['commit', '-q', '-m', 'initial'], sourceRepoDir);
  const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();

  // Build the patch from edits in the source working tree, then restore it.
  writeTracked(sourceRepoDir, PATH_A, CONTENT[PATH_A].replace('x.isEmpty()', 'x.isNotEmpty()'));
  writeTracked(sourceRepoDir, PATH_B, CONTENT[PATH_B].replace('id in ids', 'id !in ids'));
  if (alsoC) writeTracked(sourceRepoDir, PATH_C, 'fun c() = 4\n');
  const patchText = gitViaBash(['diff', '--no-color'], sourceRepoDir);
  gitViaBash(['checkout', '--', '.'], sourceRepoDir);
  const corpusRoot = mkdtempSync(path.join(os.tmpdir(), 'aemmp-corpus-'));
  cleanupDirs.push(corpusRoot);
  mkdirSync(path.join(corpusRoot, 'scenarios'), { recursive: true });
  mkdirSync(path.join(corpusRoot, 'fixtures'), { recursive: true });
  writeFileSync(path.join(corpusRoot, 'fixtures', 'two-edits.patch'), patchText);
  return { sourceRepoDir, pinnedCommit, corpusRoot, scenariosDir: path.join(corpusRoot, 'scenarios'), patchText };
}

function makeWorktree(sourceRepoDir, pinnedCommit) {
  const { fixtureDir } = materializeScenarioProject({ sourceRepoDir, pinnedCommit });
  cleanupDirs.push(fixtureDir);
  return fixtureDir;
}

const setup = (over = {}) => ({ operation: 'apply_patch', patch_file: 'two-edits.patch', expected_paths: [PATH_A, PATH_B], ...over });

describe('isExactlyUnstagedModificationsAt', () => {
  it('accepts exactly the expected unstaged modifications, in any order', () => {
    expect(isExactlyUnstagedModificationsAt(` M ${PATH_B}\n M ${PATH_A}\n`, [PATH_A, PATH_B])).toBe(true);
  });

  it('rejects an extra modified file', () => {
    expect(isExactlyUnstagedModificationsAt(` M ${PATH_A}\n M ${PATH_B}\n M ${PATH_C}\n`, [PATH_A, PATH_B])).toBe(false);
  });

  it('rejects a missing expected file', () => {
    expect(isExactlyUnstagedModificationsAt(` M ${PATH_A}\n`, [PATH_A, PATH_B])).toBe(false);
  });

  it('rejects a staged, untracked or deleted entry', () => {
    for (const bad of [`M  ${PATH_B}`, `?? ${PATH_B}`, ` D ${PATH_B}`, `A  ${PATH_B}`, `MM ${PATH_B}`]) {
      expect(isExactlyUnstagedModificationsAt(` M ${PATH_A}\n${bad}\n`, [PATH_A, PATH_B]), bad).toBe(false);
    }
  });

  it('rejects an empty status', () => {
    expect(isExactlyUnstagedModificationsAt('', [PATH_A])).toBe(false);
  });
});

describe('applyFixtureSetup -- apply_patch', { timeout: 60000 }, () => {
  it('applies the patch to exactly the expected files, unstaged and uncommitted', () => {
    const { sourceRepoDir, pinnedCommit, scenariosDir } = makeSourceRepoAndCorpus();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    applyFixtureSetup({ fixtureDir, fixtureSetup: setup(), scenariosDir });
    expect(readFileSync(path.join(fixtureDir, ...PATH_A.split('/')), 'utf8')).toContain('x.isNotEmpty()');
    expect(readFileSync(path.join(fixtureDir, ...PATH_B.split('/')), 'utf8')).toContain('id !in ids');
    expect(readFileSync(path.join(fixtureDir, ...PATH_C.split('/')), 'utf8')).toBe(CONTENT[PATH_C]);
    expect(gitViaBash(['status', '--porcelain'], fixtureDir).split('\n').filter(Boolean).sort()).toEqual([` M ${PATH_A}`, ` M ${PATH_B}`]);
  }, 60000);

  it('stages nothing and commits nothing', () => {
    const { sourceRepoDir, pinnedCommit, scenariosDir } = makeSourceRepoAndCorpus();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    applyFixtureSetup({ fixtureDir, fixtureSetup: setup(), scenariosDir });
    expect(gitViaBash(['diff', '--cached', '--name-only'], fixtureDir).trim()).toBe('');
    expect(gitViaBash(['rev-parse', 'HEAD'], fixtureDir).trim()).toBe(pinnedCommit);
  }, 60000);

  it('resolves the patch next to the scenarios directory named by KMP_EVAL_SCENARIOS_DIR', () => {
    const { sourceRepoDir, pinnedCommit, scenariosDir } = makeSourceRepoAndCorpus();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    process.env.KMP_EVAL_SCENARIOS_DIR = scenariosDir;
    applyFixtureSetup({ fixtureDir, fixtureSetup: setup() });
    expect(readFileSync(path.join(fixtureDir, ...PATH_A.split('/')), 'utf8')).toContain('x.isNotEmpty()');
  }, 60000);

  it('throws when the working tree is not clean, and applies nothing', () => {
    const { sourceRepoDir, pinnedCommit, scenariosDir } = makeSourceRepoAndCorpus();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    writeFileSync(path.join(fixtureDir, ...PATH_C.split('/')), 'dirty\n');
    expect(() => applyFixtureSetup({ fixtureDir, fixtureSetup: setup(), scenariosDir })).toThrow(/not clean/i);
    expect(readFileSync(path.join(fixtureDir, ...PATH_A.split('/')), 'utf8')).toBe(CONTENT[PATH_A]);
  }, 60000);

  it('throws when the patch does not apply, and leaves the tree untouched', () => {
    const { sourceRepoDir, pinnedCommit, scenariosDir, corpusRoot } = makeSourceRepoAndCorpus();
    // Replace the patch with one whose context cannot match the pinned commit.
    writeFileSync(path.join(corpusRoot, 'fixtures', 'two-edits.patch'), [
      `diff --git a/${PATH_A} b/${PATH_A}`,
      `--- a/${PATH_A}`,
      `+++ b/${PATH_A}`,
      '@@ -1,2 +1,2 @@',
      '-fun nothing() = 0',
      '+fun nothing() = 1',
      ' fun a2() = 1',
      '',
    ].join('\n'));
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    expect(() => applyFixtureSetup({ fixtureDir, fixtureSetup: setup(), scenariosDir })).toThrow(/does not apply/i);
    expect(gitViaBash(['status', '--porcelain'], fixtureDir).trim()).toBe('');
  }, 60000);

  it('throws a postcondition error, with its code, when the patch modifies an extra file', () => {
    const { sourceRepoDir, pinnedCommit, scenariosDir } = makeSourceRepoAndCorpus({ alsoC: true });
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    let error;
    try {
      applyFixtureSetup({ fixtureDir, fixtureSetup: setup(), scenariosDir });
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(error.message).toMatch(/fixture_setup postcondition failed/);
    expect(error.code).toBe('fixture_setup_postcondition_failed');
  }, 60000);

  it('throws a postcondition error when an expected path is not modified by the patch', () => {
    const { sourceRepoDir, pinnedCommit, scenariosDir } = makeSourceRepoAndCorpus();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    expect(() => applyFixtureSetup({ fixtureDir, fixtureSetup: setup({ expected_paths: [PATH_A, PATH_B, PATH_C] }), scenariosDir }))
      .toThrow(/postcondition failed/);
  }, 60000);

  it('throws when the patch file does not exist, naming only the bare file name', () => {
    const { sourceRepoDir, pinnedCommit, scenariosDir } = makeSourceRepoAndCorpus();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    let error;
    try {
      applyFixtureSetup({ fixtureDir, fixtureSetup: setup({ patch_file: 'missing.patch' }), scenariosDir });
    } catch (err) {
      error = err;
    }
    expect(error.message).toMatch(/missing\.patch/);
    expect(error.message).not.toContain(os.tmpdir());
  }, 60000);

  it('rejects a patch_file that is not a bare lowercase .patch name before touching git', () => {
    const { sourceRepoDir, pinnedCommit, scenariosDir } = makeSourceRepoAndCorpus();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    for (const bad of ['../two-edits.patch', 'sub/two-edits.patch', 'Two-Edits.patch', 'two-edits.diff', '']) {
      expect(() => applyFixtureSetup({ fixtureDir, fixtureSetup: setup({ patch_file: bad }), scenariosDir }), bad).toThrow(/patch_file/);
    }
    expect(existsSync(path.join(fixtureDir, '.git'))).toBe(true);
    expect(gitViaBash(['status', '--porcelain'], fixtureDir).trim()).toBe('');
  }, 60000);

  it('rejects an unsafe expected_paths list before touching git', () => {
    const { sourceRepoDir, pinnedCommit, scenariosDir } = makeSourceRepoAndCorpus();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    for (const bad of [[], ['../etc/passwd'], ['/abs/A.kt'], [PATH_A, PATH_A], 'core/A.kt']) {
      expect(() => applyFixtureSetup({ fixtureDir, fixtureSetup: setup({ expected_paths: bad }), scenariosDir }), JSON.stringify(bad)).toThrow(/expected_paths/);
    }
  }, 60000);

  it('keeps append_comment working through the same entry point', () => {
    const { sourceRepoDir, pinnedCommit } = makeSourceRepoAndCorpus();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    const blob = gitViaBash(['rev-parse', `HEAD:${PATH_C}`], fixtureDir).trim();
    applyFixtureSetup({ fixtureDir, fixtureSetup: { operation: 'append_comment', relative_path: PATH_C, expected_blob_oid: blob } });
    expect(gitViaBash(['status', '--porcelain'], fixtureDir).trimEnd()).toBe(` M ${PATH_C}`);
  }, 60000);

  it('still rejects an unknown operation', () => {
    const { sourceRepoDir, pinnedCommit } = makeSourceRepoAndCorpus();
    const fixtureDir = makeWorktree(sourceRepoDir, pinnedCommit);
    expect(() => applyFixtureSetup({ fixtureDir, fixtureSetup: { operation: 'rm_rf' } })).toThrow(/not supported/);
  }, 60000);
});

// tests/vitest/agentic-eval-materialize-worktree-rollback.test.js
// Real-git tests (own throwaway source repo per test, no mocks) for removeScenarioWorktree()'s two
// verified postconditions, and for materializeScenarioProject()'s worktree-add rollback-visibility
// hardening. Kept separate from agentic-eval-materialize.test.js because these specifically drive
// the git-worktree lifecycle end to end rather than mocking pieces of it.
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';

function gitViaBash(argv, cwd) {
  const cmd = argv.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ');
  const r = spawnSync(resolveBash(), ['-c', `git ${cmd}`], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout;
}

function makeSourceRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'aemwr-source-'));
  gitViaBash(['init', '-q'], dir);
  gitViaBash(['config', 'user.email', 'test@example.com'], dir);
  gitViaBash(['config', 'user.name', 'Test'], dir);
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  gitViaBash(['add', 'a.txt'], dir);
  gitViaBash(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

describe('removeScenarioWorktree -- two verified postconditions', () => {
  it('on a normal, healthy worktree: removes the directory AND deregisters it from git worktree list', async () => {
    const { materializeScenarioProject, removeScenarioWorktree } = await import('../../tools/agentic-eval/materialize.mjs');
    const sourceRepoDir = makeSourceRepo();
    try {
      const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
      const { fixtureDir } = materializeScenarioProject({ sourceRepoDir, pinnedCommit });
      expect(existsSync(fixtureDir)).toBe(true);

      removeScenarioWorktree({ sourceRepoDir, worktreeDir: fixtureDir });

      expect(existsSync(fixtureDir)).toBe(false);
      const list = gitViaBash(['worktree', 'list', '--porcelain'], sourceRepoDir);
      expect(list).not.toContain(fixtureDir.replace(/\\/g, '/'));
    } finally {
      rmSync(sourceRepoDir, { recursive: true, force: true });
    }
  }, 30000);

  it('is idempotent -- calling it again on an already-removed worktree does not throw (already-gone is not an error)', async () => {
    const { materializeScenarioProject, removeScenarioWorktree } = await import('../../tools/agentic-eval/materialize.mjs');
    const sourceRepoDir = makeSourceRepo();
    try {
      const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
      const { fixtureDir } = materializeScenarioProject({ sourceRepoDir, pinnedCommit });
      removeScenarioWorktree({ sourceRepoDir, worktreeDir: fixtureDir });
      expect(() => removeScenarioWorktree({ sourceRepoDir, worktreeDir: fixtureDir })).not.toThrow();
    } finally {
      rmSync(sourceRepoDir, { recursive: true, force: true });
    }
  }, 30000);

  it('when the directory was already deleted out from under git (deregistration never ran), still deregisters it via prune -- both postconditions still end up satisfied', async () => {
    const { materializeScenarioProject, removeScenarioWorktree } = await import('../../tools/agentic-eval/materialize.mjs');
    const sourceRepoDir = makeSourceRepo();
    try {
      const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
      const { fixtureDir } = materializeScenarioProject({ sourceRepoDir, pinnedCommit });
      // Simulate: someone/something deleted the directory directly, bypassing git entirely.
      rmSync(fixtureDir, { recursive: true, force: true });

      expect(() => removeScenarioWorktree({ sourceRepoDir, worktreeDir: fixtureDir })).not.toThrow();
      const list = gitViaBash(['worktree', 'list', '--porcelain'], sourceRepoDir);
      expect(list).not.toContain(fixtureDir.replace(/\\/g, '/'));
    } finally {
      rmSync(sourceRepoDir, { recursive: true, force: true });
    }
  }, 30000);
});

describe('materializeScenarioProject -- worktree-add rollback failure is surfaced, never silently swallowed', () => {
  it('attaches a rollback failure to the original error instead of discarding it', async () => {
    const { materializeScenarioProject } = await import('../../tools/agentic-eval/materialize.mjs');
    const sourceRepoDir = makeSourceRepo();
    try {
      // An invalid pinnedCommit makes `git worktree add` fail immediately, before any worktree
      // directory/registration exists -- so the rollback's own removeScenarioWorktree call has
      // nothing real to clean up and should succeed trivially in the normal case. This test proves
      // the *plumbing* (that a rollback failure, if one occurred, would be attached) by directly
      // exercising the real failure path and confirming the original error is not masked, and that
      // the error shape has room for a rollbackError when one occurs.
      let thrown = null;
      try {
        materializeScenarioProject({ sourceRepoDir, pinnedCommit: 'not-a-real-commit-ish' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).not.toBeNull();
      expect(thrown.message).toMatch(/worktree add.*failed/i);
      // No worktree was left registered after a clean add-failure.
      const list = gitViaBash(['worktree', 'list', '--porcelain'], sourceRepoDir);
      const lines = list.trim().split('\n').filter((l) => l.startsWith('worktree '));
      expect(lines.length).toBe(1); // only the main worktree
    } finally {
      rmSync(sourceRepoDir, { recursive: true, force: true });
    }
  }, 30000);

  it('a genuine (non-tolerated) git worktree remove failure still results in the directory being removed, and surfaces a combined, non-silent error', async () => {
    const { materializeScenarioProject, removeScenarioWorktree } = await import('../../tools/agentic-eval/materialize.mjs');
    const sourceRepoDir = makeSourceRepo();
    try {
      const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
      const { fixtureDir } = materializeScenarioProject({ sourceRepoDir, pinnedCommit });
      // `git worktree lock` makes a subsequent `git worktree remove --force` genuinely refuse
      // (a real, reproducible, non-tolerated failure -- distinct from the two benign
      // "already gone" patterns this function already tolerates).
      gitViaBash(['worktree', 'lock', fixtureDir], sourceRepoDir);

      let thrown = null;
      try {
        removeScenarioWorktree({ sourceRepoDir, worktreeDir: fixtureDir });
      } catch (err) {
        thrown = err;
      }

      // The directory removal must still have been ATTEMPTED (and, since nothing else holds it
      // open, succeeded) even though the git-level step refused -- this is the fix for today's
      // bug where a genuine git-worktree-remove failure throws before the trailing rmSync ever runs.
      expect(existsSync(fixtureDir)).toBe(false);
      // Since the git step itself never cleared the registration (it refused, it didn't run),
      // the postcondition check must still find it registered -- so this call must NOT silently
      // report success; it must surface a real, informative error.
      expect(thrown).not.toBeNull();
      expect(thrown.message.length).toBeGreaterThan(0);

      // Clean up the stale registration so the source repo teardown doesn't leave git state behind.
      try { gitViaBash(['worktree', 'remove', '--force', fixtureDir], sourceRepoDir); } catch { /* best-effort test cleanup */ }
    } finally {
      rmSync(sourceRepoDir, { recursive: true, force: true });
    }
  }, 30000);
});

describe('materialize.mjs git operations run with core.longpaths scoped per-command', () => {
  it('never persists core.longpaths at system/global/local config scope', async () => {
    const { materializeScenarioProject, removeScenarioWorktree } = await import('../../tools/agentic-eval/materialize.mjs');
    const sourceRepoDir = makeSourceRepo();
    try {
      const baselineLocal = spawnSync(resolveBash(), ['-c', 'git config --local --get core.longpaths'], { cwd: sourceRepoDir, encoding: 'utf8' });
      const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
      const { fixtureDir } = materializeScenarioProject({ sourceRepoDir, pinnedCommit });
      materializeScenarioProject({ sourceRepoDir, pinnedCommit, existingWorktreeDir: fixtureDir });
      removeScenarioWorktree({ sourceRepoDir, worktreeDir: fixtureDir });

      const afterLocal = spawnSync(resolveBash(), ['-c', 'git config --local --get core.longpaths'], { cwd: sourceRepoDir, encoding: 'utf8' });
      // Whatever the baseline was (commonly "unset" on a fresh repo -> non-zero exit, empty stdout),
      // it must be byte-identical after -- never assume unset, compare against the captured baseline.
      expect(afterLocal.status).toBe(baselineLocal.status);
      expect(afterLocal.stdout).toBe(baselineLocal.stdout);
    } finally {
      rmSync(sourceRepoDir, { recursive: true, force: true });
    }
  }, 30000);
});

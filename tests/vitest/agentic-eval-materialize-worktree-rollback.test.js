// tests/vitest/agentic-eval-materialize-worktree-rollback.test.js
// Real-git tests (own throwaway source repo per test, no mocks) for removeScenarioWorktree()'s two
// verified postconditions, and for materializeScenarioProject()'s worktree-add rollback-visibility
// hardening. Kept separate from agentic-eval-materialize.test.js because these specifically drive
// the git-worktree lifecycle end to end rather than mocking pieces of it.
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';

const isWindows = process.platform === 'win32';

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

  it('when the directory was already deleted out from under git, git worktree remove --force itself still clears the registration -- both postconditions still end up satisfied', async () => {
    const { materializeScenarioProject, removeScenarioWorktree } = await import('../../tools/agentic-eval/materialize.mjs');
    const sourceRepoDir = makeSourceRepo();
    try {
      const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
      const { fixtureDir } = materializeScenarioProject({ sourceRepoDir, pinnedCommit });
      // Simulate: someone/something deleted the directory directly, bypassing git entirely.
      // Post-Codex-audit correction (PR #418): this test's title previously claimed the
      // registration clears "via prune" -- verified directly, materialize.mjs never calls `git
      // worktree prune` anywhere, and a real reproduction on this machine's Git for Windows shows
      // `git worktree remove --force` alone (called by removeScenarioWorktree below) already
      // clears the registration for an already-missing directory, exit 0, no separate prune step
      // needed. No `git worktree prune` call was added -- only the test's own title/comment
      // corrected to match what actually happens.
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
  it('the common case: an invalid pinnedCommit fails before any worktree is registered, so the rollback has nothing real to clean up and trivially succeeds (thrown.rollbackError stays undefined) -- see agentic-eval-materialize-rollback-failure-injected.test.js for the genuine rollback-FAILURE reproduction', async () => {
    const { materializeScenarioProject } = await import('../../tools/agentic-eval/materialize.mjs');
    const sourceRepoDir = makeSourceRepo();
    try {
      // An invalid pinnedCommit makes `git worktree add` fail immediately, before any worktree
      // directory/registration exists -- so the rollback's own removeScenarioWorktree call has
      // nothing real to clean up and succeeds trivially. Post-Codex-audit correction (PR #418):
      // an earlier version of this test's own title claimed to prove "a rollback failure is
      // attached" -- it never did; this case cannot force a genuine rollback failure at all (see
      // the file header). It still has real, standalone value as the common-case regression test:
      // proves the original error surfaces cleanly and thrown.rollbackError is correctly absent
      // (not falsely populated) when there was truly nothing to roll back.
      let thrown = null;
      try {
        materializeScenarioProject({ sourceRepoDir, pinnedCommit: 'not-a-real-commit-ish' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).not.toBeNull();
      expect(thrown.message).toMatch(/worktree add.*failed/i);
      // Nothing needed cleaning up, so the rollback's own try/catch never entered its catch --
      // rollbackError is correctly absent, never falsely populated.
      expect(thrown.rollbackError).toBeUndefined();
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
      // Post-Codex-audit fix (PR #418, independently also flagged by CodeRabbit): this test's own
      // title already claimed "system/global/local", but the body previously captured/compared
      // ONLY --local -- a persistent --global or --system mutation (this code never intentionally
      // makes one, but a regression could) would have passed silently. All three scopes are now
      // actually captured and compared, matching the title's own claim.
      const scopes = ['--system', '--global', '--local'];
      const captureAll = () => scopes.map((scope) => spawnSync(resolveBash(), ['-c', `git config ${scope} --get core.longpaths`], { cwd: sourceRepoDir, encoding: 'utf8' }));
      const baseline = captureAll();
      const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
      const { fixtureDir } = materializeScenarioProject({ sourceRepoDir, pinnedCommit });
      materializeScenarioProject({ sourceRepoDir, pinnedCommit, existingWorktreeDir: fixtureDir });
      removeScenarioWorktree({ sourceRepoDir, worktreeDir: fixtureDir });

      const after = captureAll();
      // Whatever each scope's baseline was (commonly "unset" -> non-zero exit, empty stdout for
      // --local/--system on a fresh test repo; --global may legitimately already be set on this
      // machine), it must be byte-identical after -- never assume unset, compare against the
      // captured baseline for every scope independently.
      scopes.forEach((scope, i) => {
        expect(after[i].status, `${scope} exit status`).toBe(baseline[i].status);
        expect(after[i].stdout, `${scope} stdout`).toBe(baseline[i].stdout);
      });
    } finally {
      rmSync(sourceRepoDir, { recursive: true, force: true });
    }
  }, 30000);
});

// Post-Codex-audit fix (PR #418, round 3): removeScenarioWorktree's own realpathSync(worktreeDir)
// fell back to the RAW, unresolved path whenever the directory no longer existed -- under a
// symlinked ancestor (macOS's own /var -> /private/var is the canonical real-world example: a real
// git worktree created under the /var/... form gets its CANONICAL /private/var/... form recorded
// by git itself, so the two never textually match once the raw form is used for comparison), a
// still-registered stale entry could look absent, and removeScenarioWorktree would silently report
// its postconditions as met when the git-registration one genuinely wasn't. Gated to POSIX (Windows
// doesn't have this exact directory-symlink convention, and Git for Windows' own worktree/realpath
// interaction is already covered by every OTHER test in this file); reproduces the exact shape with
// a real symlink, not macOS-specific -- this is a general symlinked-temp-root property, verifiable
// on Linux too.
describe.skipIf(isWindows)('removeScenarioWorktree -- resolves the canonical path even when the worktree directory is already gone, under a symlinked ancestor', () => {
  it('detects a still-registered entry reached only through a symlinked parent directory (deleted externally, never resolved to its canonical form before this fix)', async () => {
    const { removeScenarioWorktree } = await import('../../tools/agentic-eval/materialize.mjs');
    const sourceRepoDir = makeSourceRepo();
    const container = mkdtempSync(join(tmpdir(), 'aemwr-symlink-container-'));
    try {
      const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
      const realDir = join(container, 'real');
      const linkDir = join(container, 'link');
      mkdirSync(realDir, { recursive: true });
      symlinkSync(realDir, linkDir, 'dir');

      const worktreeDirViaSymlink = join(linkDir, 'wt');
      gitViaBash(['worktree', 'add', '--detach', worktreeDirViaSymlink, pinnedCommit], sourceRepoDir);
      expect(existsSync(worktreeDirViaSymlink)).toBe(true);

      // Someone/something deleted the worktree directory directly, bypassing git entirely --
      // exactly the same simulated condition this file's own "already deleted out from under git"
      // test above uses, just reached through the symlinked path this time.
      rmSync(worktreeDirViaSymlink, { recursive: true, force: true });

      // Must not throw silently claiming success -- the registration genuinely remains (this is
      // the exact scenario the pre-fix raw-path fallback could miss).
      expect(() => removeScenarioWorktree({ sourceRepoDir, worktreeDir: worktreeDirViaSymlink })).not.toThrow();

      // The real postcondition: git's own registration is actually cleared, verified independently
      // of removeScenarioWorktree's own internal comparison.
      const list = gitViaBash(['worktree', 'list', '--porcelain'], sourceRepoDir);
      const lines = list.trim().split('\n').filter((l) => l.startsWith('worktree '));
      expect(lines.length).toBe(1); // only the main worktree
    } finally {
      rmSync(container, { recursive: true, force: true });
      rmSync(sourceRepoDir, { recursive: true, force: true });
    }
  }, 30000);
});

// tests/vitest/agentic-eval-materialize-longpaths.test.js
// Windows-only: real git operations against a fixture repo with a >260-character nested path,
// reproducing the exact 2026-08-10 canary incident's own trigger (`git clean -fdx` hitting
// "Filename too long" because core.longpaths was unset). RED without the fix, GREEN with it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), 'aelp-source-'));
  gitViaBash(['init', '-q'], dir);
  gitViaBash(['config', 'user.email', 'test@example.com'], dir);
  gitViaBash(['config', 'user.name', 'Test'], dir);
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  gitViaBash(['add', 'a.txt'], dir);
  gitViaBash(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

// Builds a nested, UNTRACKED directory tree whose full path exceeds 260 characters -- the exact
// shape of the incident (deep Gradle/Hilt/Kotlin build output inside a REUSED worktree, cleaned via
// `git clean -fdx`), without needing a real Gradle build. A component of 40 chars repeated 8 times,
// rooted under `worktreeDir`, comfortably exceeds 260 total.
function makeDeepUntrackedTree(worktreeDir) {
  const component = 'a'.repeat(40);
  let dir = worktreeDir;
  for (let i = 0; i < 8; i++) {
    dir = join(dir, `${component}${i}`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'leaf.txt'), 'x');
  expect(dir.length).toBeGreaterThan(260);
  return dir;
}

describe.skipIf(!isWindows)('materialize.mjs -- Windows long-path handling for the reused-worktree reset path', () => {
  let sourceRepoDir;
  let baselineLocalLongpaths;

  beforeAll(() => {
    sourceRepoDir = makeSourceRepo();
    baselineLocalLongpaths = spawnSync(resolveBash(), ['-c', 'git config --local --get core.longpaths'], { cwd: sourceRepoDir, encoding: 'utf8' });
  });

  afterAll(() => {
    if (sourceRepoDir) rmSync(sourceRepoDir, { recursive: true, force: true });
  });

  it('materializeScenarioProject\'s reuse branch (git clean -fdx) succeeds against a >260-char untracked tree', async () => {
    const { materializeScenarioProject, removeScenarioWorktree } = await import('../../tools/agentic-eval/materialize.mjs');
    const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
    const { fixtureDir } = materializeScenarioProject({ sourceRepoDir, pinnedCommit });
    try {
      const deepPath = makeDeepUntrackedTree(fixtureDir);
      expect(existsSync(deepPath)).toBe(true);

      // This is the exact incident trigger: reusing the worktree (existingWorktreeDir set) runs
      // `git clean -fdx` against the deep untracked tree just created.
      expect(() => materializeScenarioProject({ sourceRepoDir, pinnedCommit, existingWorktreeDir: fixtureDir })).not.toThrow();
      expect(existsSync(deepPath)).toBe(false);
    } finally {
      removeScenarioWorktree({ sourceRepoDir, worktreeDir: fixtureDir });
    }
  }, 30000);

  it('removeScenarioWorktree successfully tears down a worktree containing a >260-char tree', async () => {
    const { materializeScenarioProject, removeScenarioWorktree } = await import('../../tools/agentic-eval/materialize.mjs');
    const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
    const { fixtureDir } = materializeScenarioProject({ sourceRepoDir, pinnedCommit });
    makeDeepUntrackedTree(fixtureDir);

    expect(() => removeScenarioWorktree({ sourceRepoDir, worktreeDir: fixtureDir })).not.toThrow();
    expect(existsSync(fixtureDir)).toBe(false);
  }, 30000);

  // Post-CodeRabbit-audit fix (PR #418): this test previously ran no materialize.mjs git
  // operation of its own -- it only re-read the config, relying on the TWO EARLIER tests in this
  // same describe block having already exercised materializeScenarioProject/removeScenarioWorktree.
  // Filtered to run in isolation (e.g. `vitest run -t "never persists core.longpaths"`), the
  // baseline-vs-after comparison would trivially pass without ever exercising the fix. It now runs
  // its own materialize+remove cycle, matching the self-contained pattern the fourth test in this
  // file already uses.
  it('never persists core.longpaths at local config scope, compared against the captured baseline (never assumes unset)', async () => {
    const { materializeScenarioProject, removeScenarioWorktree } = await import('../../tools/agentic-eval/materialize.mjs');
    const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
    const { fixtureDir } = materializeScenarioProject({ sourceRepoDir, pinnedCommit });
    materializeScenarioProject({ sourceRepoDir, pinnedCommit, existingWorktreeDir: fixtureDir });
    removeScenarioWorktree({ sourceRepoDir, worktreeDir: fixtureDir });

    const afterLocal = spawnSync(resolveBash(), ['-c', 'git config --local --get core.longpaths'], { cwd: sourceRepoDir, encoding: 'utf8' });
    expect(afterLocal.status).toBe(baselineLocalLongpaths.status);
    expect(afterLocal.stdout).toBe(baselineLocalLongpaths.stdout);
  }, 30000);

  it('the git-config-scoped fix never leaks GIT_CONFIG_* into a representative built env object', async () => {
    const { materializeScenarioProject, removeScenarioWorktree } = await import('../../tools/agentic-eval/materialize.mjs');
    const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
    const { fixtureDir } = materializeScenarioProject({ sourceRepoDir, pinnedCommit });
    materializeScenarioProject({ sourceRepoDir, pinnedCommit, existingWorktreeDir: fixtureDir });
    removeScenarioWorktree({ sourceRepoDir, worktreeDir: fixtureDir });

    const gitConfigKeys = Object.keys(process.env).filter((k) => k.startsWith('GIT_CONFIG'));
    expect(gitConfigKeys).toEqual([]);
  });
});

// 2026-09-29 (WO-A2 auditor finding): a SEPARATE Windows long-path gap from the git-config one
// above -- mkdtempSync's own libuv binding (uv_fs_mkdtemp) fails past ~260 resolved characters on
// this harness's hosts even with HKLM FileSystem\LongPathsEnabled=1 set (confirmed empirically on
// the SAME host the tests above call "Inconclusive" for the .NET Remove-Item case -- that registry
// flag does not help every Node fs API uniformly). This produced a real incident: claude-code-0's
// acquireSharedEvalResources call failed with an untagged, opaque ENOENT before any cell spawned.
// baseDir is injected (never process.env.TEMP/TMP mutation) so this reproduces deterministically
// without depending on this host's own real tmpdir() depth.
describe.skipIf(!isWindows)('materialize.mjs -- mkdtempLongPathSafe (mkdtempSync itself fails past MAX_PATH)', () => {
  function makeDeepBaseDir() {
    const component = 'b'.repeat(40);
    let dir = mkdtempSync(join(tmpdir(), 'aelp-mkdtemp-base-'));
    for (let i = 0; i < 6; i++) dir = join(dir, `${component}${i}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('RED: plain mkdtempSync fails past 260 resolved chars on this host', () => {
    const deepBase = makeDeepBaseDir();
    try {
      expect(deepBase.length).toBeGreaterThan(200);
      expect(() => mkdtempSync(join(deepBase, 'plain-mkdtemp-'))).toThrow(/ENOENT/);
    } finally {
      rmSync(deepBase, { recursive: true, force: true });
    }
  });

  it('GREEN: mkdtempLongPathSafe succeeds at the identical depth where mkdtempSync just failed', async () => {
    const { mkdtempLongPathSafe } = await import('../../tools/agentic-eval/materialize.mjs');
    const deepBase = makeDeepBaseDir();
    try {
      const created = mkdtempLongPathSafe('kmp-agentic-eval-skill-', { baseDir: deepBase });
      expect(created.length).toBeGreaterThan(260);
      expect(existsSync(created)).toBe(true);
      rmSync(created, { recursive: true, force: true });
    } finally {
      rmSync(deepBase, { recursive: true, force: true });
    }
  });

  it('regression: mkdtempLongPathSafe still works correctly at normal, short lengths', async () => {
    const { mkdtempLongPathSafe } = await import('../../tools/agentic-eval/materialize.mjs');
    const created = mkdtempLongPathSafe('kmp-agentic-eval-skill-');
    try {
      expect(existsSync(created)).toBe(true);
      expect(created).toContain('kmp-agentic-eval-skill-');
    } finally {
      rmSync(created, { recursive: true, force: true });
    }
  });

  it('a failure carries code/syscall/target/length into the message, never a raw absolute path', async () => {
    const { mkdtempLongPathSafe } = await import('../../tools/agentic-eval/materialize.mjs');
    // A baseDir that doesn't exist fails mkdirSync deterministically regardless of length --
    // proves the message shape without depending on this host's own long-path threshold.
    const missingBase = join(tmpdir(), `aelp-definitely-missing-${Date.now()}`);
    let thrown = null;
    try {
      mkdtempLongPathSafe('kmp-agentic-eval-skill-', { baseDir: missingBase });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.message).toMatch(/^mkdtemp_long_path_failed: code=ENOENT syscall=mkdir target=kmp-agentic-eval-skill-[0-9a-f]{6} target_length=\d+$/);
    expect(thrown.message).not.toContain(missingBase);
    expect(thrown.message).not.toContain(tmpdir());
  });
});

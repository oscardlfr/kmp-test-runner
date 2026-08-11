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

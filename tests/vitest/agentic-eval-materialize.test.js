// tests/vitest/agentic-eval-materialize.test.js
// Unit tests for tools/agentic-eval/materialize.mjs. Real `git archive`/`git worktree` against
// *this* repo at a known commit -- local, no network, no Claude, matching the existing repo
// idiom of real subprocess tests over mocking.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  materializeSkillSnapshot,
  materializeCalibrationProject,
  materializeGradleUserHome,
} from '../../tools/agentic-eval/materialize.mjs';
import { runValidator } from '../../tools/validate-plugin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const KNOWN_SHA = 'c5c0661852f7c9da145ef56892048e706216a6ce';

// Local mirror of materialize.mjs's own bash-routing helpers -- Windows-native `execFileSync`/
// `spawnSync` with shell:false has been shown elsewhere in this harness to mangle
// backslash-heavy path arguments embedded in a command string, so all git calls that build a
// path into the command text itself go through `bash -c`, matching the proven pattern.
function toPosixPath(winPath) {
  return winPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
}
const shQuote = (arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`;
function gitViaBash(argv, cwd) {
  const cmd = argv.map(shQuote).join(' ');
  const r = spawnSync('bash', ['-c', `git ${cmd}`], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout;
}

const cleanupDirs = [];
afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop(), { recursive: true, force: true });
});

describe('materializeSkillSnapshot', () => {
  it('extracts and validates a real pinned-SHA snapshot from this repo', async () => {
    const { snapshotDir, validation } = await materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: KNOWN_SHA, validateFn: runValidator });
    cleanupDirs.push(snapshotDir);
    expect(validation.ok).toBe(true);
    expect(existsSync(path.join(snapshotDir, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(path.join(snapshotDir, '.skills', 'kmp-test-runner', 'SKILL.md'))).toBe(true);
  });

  it('throws if the materialize+validate pipeline is pointed at an invalid SHA', async () => {
    await expect(
      materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: 'not-a-real-sha-0000000000000000000000', validateFn: runValidator }),
    ).rejects.toThrow();
  });

  it('backfills a commit missing from a shallow clone before archiving (the real CI shallow-checkout failure mode)', async () => {
    // A CI checkout of this repo (or any shallow clone) only has the tip commit's tree locally --
    // `git archive <ancestor-sha>` fails with "not a tree object" for the pinned skill SHA even
    // though it's a perfectly valid, reachable commit. Reproduce that exact shape with a local,
    // no-network origin: two commits, then a --depth 1 clone that only has the second.
    const originDir = mkdtempSync(path.join(os.tmpdir(), 'aemat-origin-'));
    cleanupDirs.push(originDir);
    gitViaBash(['init', '-q'], originDir);
    gitViaBash(['config', 'user.email', 'test@example.com'], originDir);
    gitViaBash(['config', 'user.name', 'Test'], originDir);
    mkdirSync(path.join(originDir, '.claude-plugin'), { recursive: true });
    mkdirSync(path.join(originDir, '.skills', 'kmp-test-runner'), { recursive: true });
    writeFileSync(path.join(originDir, '.claude-plugin', 'plugin.json'), '{}\n');
    writeFileSync(path.join(originDir, '.skills', 'kmp-test-runner', 'SKILL.md'), '# stub\n');
    gitViaBash(['add', '-A'], originDir);
    gitViaBash(['commit', '-q', '-m', 'first'], originDir);
    const firstSha = gitViaBash(['rev-parse', 'HEAD'], originDir).trim();
    writeFileSync(path.join(originDir, 'marker2.txt'), 'second commit\n');
    gitViaBash(['add', '-A'], originDir);
    gitViaBash(['commit', '-q', '-m', 'second'], originDir);

    const shallowDir = mkdtempSync(path.join(os.tmpdir(), 'aemat-shallow-'));
    rmSync(shallowDir, { recursive: true, force: true }); // git clone requires the target not exist
    // --no-local is required: git silently ignores --depth for a plain local-path source
    // ("warning: --depth is ignored in local clones; use file:// instead."), which would make
    // this fixture not actually reproduce the shallow-checkout bug.
    gitViaBash(['clone', '-q', '--depth', '1', '--no-local', toPosixPath(originDir), toPosixPath(shallowDir)], os.tmpdir());
    cleanupDirs.push(shallowDir);

    // Confirm the fixture actually reproduces the bug -- the shallow clone must NOT have
    // `firstSha` locally yet, or this test would prove nothing.
    const probe = spawnSync('bash', ['-c', `git cat-file -e ${shQuote(firstSha)}^{commit}`], { cwd: shallowDir, encoding: 'utf8' });
    expect(probe.status).not.toBe(0);

    const stubValidate = async () => ({ ok: true, summary: 'stub' });
    const { snapshotDir, validation } = await materializeSkillSnapshot({ repoRoot: shallowDir, sha: firstSha, validateFn: stubValidate });
    cleanupDirs.push(snapshotDir);
    expect(validation.ok).toBe(true);
    expect(existsSync(path.join(snapshotDir, '.claude-plugin', 'plugin.json'))).toBe(true);
  });
});

describe('materializeCalibrationProject', () => {
  function makeTemplate() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aemat-template-'));
    cleanupDirs.push(dir);
    writeFileSync(path.join(dir, 'marker.txt'), 'pristine-content');
    return dir;
  }

  it('copies the template into a fresh temp directory', () => {
    const templateDir = makeTemplate();
    const { fixtureDir } = materializeCalibrationProject({ templateDir });
    cleanupDirs.push(fixtureDir);
    expect(existsSync(path.join(fixtureDir, 'marker.txt'))).toBe(true);
  });

  it('reset (existingDir) deletes any local mutation and restores pristine content', () => {
    const templateDir = makeTemplate();
    const { fixtureDir } = materializeCalibrationProject({ templateDir });
    cleanupDirs.push(fixtureDir);
    writeFileSync(path.join(fixtureDir, 'junk.txt'), 'should not survive reset');

    const { fixtureDir: fixtureDir2 } = materializeCalibrationProject({ templateDir, existingDir: fixtureDir });
    expect(fixtureDir2).toBe(fixtureDir);
    expect(existsSync(path.join(fixtureDir2, 'junk.txt'))).toBe(false);
    expect(existsSync(path.join(fixtureDir2, 'marker.txt'))).toBe(true);
  });
});

describe('materializeGradleUserHome', () => {
  it('creates a temp GRADLE_USER_HOME with the daemon disabled via gradle.properties', () => {
    const { gradleUserHome, daemonPolicy } = materializeGradleUserHome({});
    cleanupDirs.push(gradleUserHome);
    expect(existsSync(path.join(gradleUserHome, 'gradle.properties'))).toBe(true);
    expect(daemonPolicy).toBe('disabled-via-gradle-user-home-properties');
  });

  it('resetToSnapshot restores the exact prewarmed state, discarding later mutation', () => {
    const { gradleUserHome, resetToSnapshot } = materializeGradleUserHome({});
    cleanupDirs.push(gradleUserHome);
    writeFileSync(path.join(gradleUserHome, 'fake-dep-cache.jar'), 'x');
    resetToSnapshot();
    expect(existsSync(path.join(gradleUserHome, 'fake-dep-cache.jar'))).toBe(false);
    expect(existsSync(path.join(gradleUserHome, 'gradle.properties'))).toBe(true);
  });

  it('repeated resetToSnapshot calls are idempotent (byte-identical restore each time)', () => {
    const { gradleUserHome, resetToSnapshot } = materializeGradleUserHome({});
    cleanupDirs.push(gradleUserHome);
    resetToSnapshot();
    const afterFirst = existsSync(path.join(gradleUserHome, 'gradle.properties'));
    resetToSnapshot();
    const afterSecond = existsSync(path.join(gradleUserHome, 'gradle.properties'));
    expect(afterFirst).toBe(afterSecond);
  });

  it('runPrewarm callback receives the gradleUserHome path before the snapshot is taken', () => {
    let seenPath = null;
    const { gradleUserHome } = materializeGradleUserHome({ runPrewarm: (dir) => { seenPath = dir; } });
    cleanupDirs.push(gradleUserHome);
    expect(seenPath).toBe(gradleUserHome);
  });
});

// tests/vitest/agentic-eval-materialize.test.js
// Unit tests for tools/agentic-eval/materialize.mjs. Real `git archive`/`git worktree` against
// *this* repo at a known commit -- local, no network, no Claude, matching the existing repo
// idiom of real subprocess tests over mocking.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  materializeSkillSnapshot,
  materializeCalibrationProject,
  materializeGradleUserHome,
} from '../../tools/agentic-eval/materialize.mjs';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';
import { runValidator } from '../../tools/validate-plugin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const KNOWN_SHA = 'c5c0661852f7c9da145ef56892048e706216a6ce';

// Local mirror of materialize.mjs's own bash-routing helpers -- Windows-native `execFileSync`/
// `spawnSync` with shell:false has been shown elsewhere in this harness to mangle
// backslash-heavy path arguments embedded in a command string, so all git calls that build a
// path into the command text itself go through `bash -c`, matching the proven pattern. Uses
// resolveBash() (not a bare 'bash') for the same reason production code does -- an ambiguous
// PATH-resolved 'bash' can be WSL's launcher instead of Git Bash, which broke this exact test
// suite under a PowerShell shell where System32 (WSL's bash.exe) precedes Git's bin/ on PATH.
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

describe('materializeSkillSnapshot', () => {
  it('extracts and validates a real pinned-SHA snapshot from this repo', async () => {
    const { snapshotDir, validation } = await materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: KNOWN_SHA, validateFn: runValidator });
    cleanupDirs.push(snapshotDir);
    expect(validation.ok).toBe(true);
    expect(existsSync(path.join(snapshotDir, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(path.join(snapshotDir, '.skills', 'kmp-test-runner', 'SKILL.md'))).toBe(true);
  });

  it('cleans up its temp directory when validation fails partway through (not just on an invalid SHA)', async () => {
    // Regression coverage for a real leak found by an independent review pass: a failure
    // AFTER mkdtempSync (specifically, a validation failure against a perfectly valid archive)
    // previously left the temp directory behind forever, since the function had no try/catch of
    // its own. Redirects TEMP/TMP/TMPDIR to a dedicated, empty, test-exclusive directory (os.
    // tmpdir() re-reads these per call) so "is it empty afterward" is exact, not a fragile
    // global count under concurrent test-file execution.
    const isolatedTmp = mkdtempSync(path.join(os.tmpdir(), 'aemat-skill-cleanup-'));
    const originalEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = isolatedTmp;
    process.env.TMP = isolatedTmp;
    process.env.TMPDIR = isolatedTmp;
    try {
      const forcedFailValidate = async () => ({ ok: false, summary: 'forced failure for this test' });
      await expect(
        materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: KNOWN_SHA, validateFn: forcedFailValidate }),
      ).rejects.toThrow(/failed validation/);
      expect(existsSync(isolatedTmp)).toBe(true); // the isolated root itself must survive
      expect(readdirSync(isolatedTmp)).toEqual([]); // but nothing was left inside it
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
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
    const probe = spawnSync(resolveBash(), ['-c', `git cat-file -e ${shQuote(firstSha)}^{commit}`], { cwd: shallowDir, encoding: 'utf8' });
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
    const originalProperties = readFileSync(path.join(gradleUserHome, 'gradle.properties'), 'utf8');
    writeFileSync(path.join(gradleUserHome, 'fake-dep-cache.jar'), 'x');
    writeFileSync(path.join(gradleUserHome, 'gradle.properties'), 'org.gradle.daemon=true\nmutated=yes\n');
    resetToSnapshot();
    expect(existsSync(path.join(gradleUserHome, 'fake-dep-cache.jar'))).toBe(false);
    expect(readFileSync(path.join(gradleUserHome, 'gradle.properties'), 'utf8')).toBe(originalProperties);
  });

  it('repeated resetToSnapshot calls are idempotent (byte-identical restore each time)', () => {
    const { gradleUserHome, resetToSnapshot } = materializeGradleUserHome({});
    cleanupDirs.push(gradleUserHome);
    resetToSnapshot();
    const afterFirst = readFileSync(path.join(gradleUserHome, 'gradle.properties'), 'utf8');
    writeFileSync(path.join(gradleUserHome, 'gradle.properties'), 'mutated-between-resets\n');
    resetToSnapshot();
    const afterSecond = readFileSync(path.join(gradleUserHome, 'gradle.properties'), 'utf8');
    expect(afterSecond).toBe(afterFirst);
  });

  it('runPrewarm callback receives the gradleUserHome path before the snapshot is taken, and its writes survive resetToSnapshot', () => {
    let seenPath = null;
    const { gradleUserHome, resetToSnapshot } = materializeGradleUserHome({
      runPrewarm: (dir) => { seenPath = dir; writeFileSync(path.join(dir, 'prewarm-marker.txt'), 'prewarmed-content'); },
    });
    cleanupDirs.push(gradleUserHome);
    expect(seenPath).toBe(gradleUserHome);
    expect(readFileSync(path.join(gradleUserHome, 'prewarm-marker.txt'), 'utf8')).toBe('prewarmed-content');

    // Prove the marker was captured IN the snapshot (prewarm ran before the snapshot was taken),
    // not just present in the live dir by coincidence -- mutate it, then confirm reset restores
    // the prewarmed content specifically, not just "some" content.
    writeFileSync(path.join(gradleUserHome, 'prewarm-marker.txt'), 'mutated-after-prewarm');
    resetToSnapshot();
    expect(readFileSync(path.join(gradleUserHome, 'prewarm-marker.txt'), 'utf8')).toBe('prewarmed-content');
  });
});

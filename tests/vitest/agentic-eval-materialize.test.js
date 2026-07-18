// tests/vitest/agentic-eval-materialize.test.js
// Unit tests for tools/agentic-eval/materialize.mjs. Real `git archive`/`git worktree` against
// *this* repo at a known commit -- local, no network, no Claude, matching the existing repo
// idiom of real subprocess tests over mocking.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

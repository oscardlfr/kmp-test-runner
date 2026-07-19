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
  materializeScenarioProject,
  materializeGradleUserHome,
} from '../../tools/agentic-eval/materialize.mjs';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';
import { runValidator } from '../../tools/validate-plugin.mjs';
import { PINNED_SKILL_SHA } from '../../tools/agentic-eval/cli.mjs';

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

  // Uses the live HEAD (not KNOWN_SHA above, which is intentionally a fixed historical pin for
  // mechanism-only tests) because this test's whole point is content-sensitive: it proves the
  // skill-portability fix survives real plugin materialization, not just a working-tree read.
  // Only meaningful once a commit containing the fix exists -- added in the commit right after it.
  it('a materialized snapshot of the current commit reflects the portable canonical workflow', async () => {
    const headSha = gitViaBash(['rev-parse', 'HEAD'], REPO_ROOT).trim();
    const { snapshotDir, validation } = await materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: headSha, validateFn: runValidator });
    cleanupDirs.push(snapshotDir);
    expect(validation.ok).toBe(true);
    const materializedSkillMd = readFileSync(path.join(snapshotDir, '.skills', 'kmp-test-runner', 'SKILL.md'), 'utf8');
    expect(materializedSkillMd).not.toMatch(/^(bash|pwsh)\s+\.skills\/kmp-test-runner\//m);
    expect(materializedSkillMd).toContain('kmp-test parallel --json --project-root .');
  });

  // Locks the harness's actual runtime pin to this specific update -- separate from KNOWN_SHA
  // above (mechanism-only) and from the live-HEAD test above (tracks develop's tip forever, never
  // references this constant). calibrate/smoke both materialize current-skill via
  // runConditionPair's one call site using exactly PINNED_SKILL_SHA. This is a tripwire, not a
  // general staleness detector: it deliberately hardcodes aeba6ea and will need its own edit on
  // every future legitimate pin advance -- the next test verifies the semantics that should
  // survive such an advance. Split into two independent it() blocks on purpose: expect().toBe()
  // throws synchronously, so a single block with the equality check first would hide whether the
  // content assertions below actually discriminate -- two blocks means a run against a stale pin
  // shows both failing for real, not just the first one.
  it('PINNED_SKILL_SHA is locked to the aeba6ea skill-portability fix', () => {
    expect(PINNED_SKILL_SHA).toBe('aeba6eaa8d027be999cdfeeb5bb2d1bbd0f688ee');
  });

  it('the pinned current-skill snapshot reflects the portable canonical workflow', async () => {
    const { snapshotDir, validation } = await materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: PINNED_SKILL_SHA, validateFn: runValidator });
    cleanupDirs.push(snapshotDir);
    expect(validation.ok).toBe(true);
    const materializedSkillMd = readFileSync(path.join(snapshotDir, '.skills', 'kmp-test-runner', 'SKILL.md'), 'utf8');
    expect(materializedSkillMd).toContain('kmp-test parallel --json --project-root .');
    expect(materializedSkillMd).toContain('### 1. Run the relevant test type');
    expect(materializedSkillMd).toContain('### 2. Diagnose only if the environment blocks the run');
    expect(materializedSkillMd).toContain('Skip this step unless `exit_code` is `3`');
    expect(materializedSkillMd).not.toMatch(/^(bash|pwsh)\s+\.skills\/kmp-test-runner\//m);
    expect(materializedSkillMd).not.toContain('current: 0.10.0+');
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
  }, 30000); // real init + 2 commits + a --no-local shallow clone + backfill-and-archive: several
  // real git subprocess spawns, slow enough on Windows CI runners to trip vitest's default 5000ms
  // per-test timeout (observed: build (windows-latest) timing out here with no other failure).
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

  // Regression coverage for a real leak an independent review pass reproduced concretely: a
  // cpSync failure partway through (here: a nonexistent templateDir, which cpSync throws ENOENT
  // on) previously left the mkdirSync'd `dest` behind forever, since the function had no
  // try/catch of its own. Redirects TEMP/TMP/TMPDIR to an isolated, test-exclusive directory
  // (same technique as materializeSkillSnapshot's own cleanup-on-failure test above) so "is it
  // empty afterward" is exact -- no need to parse the thrown error's message to recover the
  // dest path.
  it('cleans up the created dest directory when cpSync fails (e.g. a nonexistent templateDir)', () => {
    const isolatedTmp = mkdtempSync(path.join(os.tmpdir(), 'aemat-calib-cleanup-'));
    const originalEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = isolatedTmp;
    process.env.TMP = isolatedTmp;
    process.env.TMPDIR = isolatedTmp;
    try {
      const bogusTemplateDir = path.join(os.tmpdir(), 'aemat-nonexistent-template');
      expect(existsSync(bogusTemplateDir)).toBe(false);
      expect(() => materializeCalibrationProject({ templateDir: bogusTemplateDir })).toThrow();
      expect(readdirSync(isolatedTmp)).toEqual([]);
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
  });
});

describe('materializeScenarioProject -- worktree-add failure', () => {
  // NOTE: this is deliberately NOT a full regression test for the try/catch+removeScenarioWorktree
  // cleanup wrapping `git worktree add` in materialize.mjs. An invalid commit-ish (tried here)
  // fails cleanly during git's own ref resolution, before any worktree metadata or directory is
  // created -- confirmed empirically by temporarily removing the try/catch and re-running this
  // exact scenario, which still passed identically either way, meaning it doesn't actually
  // discriminate. No other reliably cross-platform way to force `git worktree add` to create
  // PARTIAL state before failing was found (a bad path, an already-existing dest, a locked
  // index all either fail before creating anything or aren't reliably reproducible outside a
  // real interrupted-process scenario). The code fix mirrors the already-verified pattern used
  // by materializeSkillSnapshot/materializeCalibrationProject/materializeGradleUserHome, and the
  // BROADER leak class this defends against -- a successful materialize followed by a LATER,
  // unrelated failure elsewhere in runConditionPair -- is covered for real by
  // agentic-eval-run-condition-pair.test.js. This test only confirms the function still throws
  // (and doesn't crash some other way) on a bad commit.
  it('throws (does not hang or crash unexpectedly) when pinnedCommit does not resolve to a real commit', () => {
    const sourceRepoDir = mkdtempSync(path.join(os.tmpdir(), 'aemat-scenario-source-'));
    cleanupDirs.push(sourceRepoDir);
    gitViaBash(['init', '-q'], sourceRepoDir);
    gitViaBash(['config', 'user.email', 'test@example.com'], sourceRepoDir);
    gitViaBash(['config', 'user.name', 'Test'], sourceRepoDir);
    writeFileSync(path.join(sourceRepoDir, 'marker.txt'), 'pristine\n');
    gitViaBash(['add', '-A'], sourceRepoDir);
    gitViaBash(['commit', '-q', '-m', 'initial'], sourceRepoDir);

    const bogusCommit = '0000000000000000000000000000000000dead';
    expect(() => materializeScenarioProject({ sourceRepoDir, pinnedCommit: bogusCommit })).toThrow();
    const worktreeList = gitViaBash(['worktree', 'list'], sourceRepoDir);
    expect(worktreeList.trim().split('\n').length).toBe(1); // only the main working tree
  });
});

describe('materializeScenarioProject -- reset (existingWorktreeDir)', () => {
  // Regression coverage for a real gap an independent review pass found: the README claims
  // scenario-project reset (git clean -fdx && git reset --hard) discards local mutation between
  // conditions A and B, the same guarantee materializeCalibrationProject's own "reset (existingDir)
  // ..." test above proves for the copy-based fixture -- but nothing actually exercised the
  // git-worktree reset path itself. This is the exact mechanism every real calibration/smoke run
  // depends on to keep condition B from ever seeing condition A's leftovers.
  it('reset discards local mutation (tracked and untracked) and restores the pinned commit exactly', () => {
    const sourceRepoDir = mkdtempSync(path.join(os.tmpdir(), 'aemat-scenario-reset-source-'));
    cleanupDirs.push(sourceRepoDir);
    gitViaBash(['init', '-q'], sourceRepoDir);
    gitViaBash(['config', 'user.email', 'test@example.com'], sourceRepoDir);
    gitViaBash(['config', 'user.name', 'Test'], sourceRepoDir);
    // A machine-global core.autocrlf=true (common on Windows) would check this file back out as
    // CRLF regardless of what was committed -- irrelevant to what this test verifies (content
    // reset, not line-ending policy), so pin it off for this throwaway repo.
    gitViaBash(['config', 'core.autocrlf', 'false'], sourceRepoDir);
    writeFileSync(path.join(sourceRepoDir, 'marker.txt'), 'pristine\n');
    gitViaBash(['add', '-A'], sourceRepoDir);
    gitViaBash(['commit', '-q', '-m', 'initial'], sourceRepoDir);
    const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();

    const { fixtureDir } = materializeScenarioProject({ sourceRepoDir, pinnedCommit });
    cleanupDirs.push(fixtureDir);
    // Simulate what condition A's agent session could leave behind: a mutated TRACKED file and a
    // new UNTRACKED file.
    writeFileSync(path.join(fixtureDir, 'marker.txt'), 'mutated by condition A\n');
    writeFileSync(path.join(fixtureDir, 'untracked-junk.txt'), 'should not survive reset');

    const { fixtureDir: fixtureDir2 } = materializeScenarioProject({ sourceRepoDir, pinnedCommit, existingWorktreeDir: fixtureDir });
    expect(fixtureDir2).toBe(fixtureDir);
    expect(readFileSync(path.join(fixtureDir2, 'marker.txt'), 'utf8')).toBe('pristine\n');
    expect(existsSync(path.join(fixtureDir2, 'untracked-junk.txt'))).toBe(false);
    expect(gitViaBash(['status', '--porcelain'], fixtureDir2).trim()).toBe('');
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

  // Regression coverage: a failure inside runPrewarm (or writeFileSync/cpSync) partway through
  // previously left BOTH the gradleUserHome and its own internal snapshotDir behind forever,
  // since the function had no try/catch of its own.
  it('cleans up both temp directories it created when runPrewarm throws', () => {
    const isolatedTmp = mkdtempSync(path.join(os.tmpdir(), 'aemat-gradle-cleanup-'));
    const originalEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = isolatedTmp;
    process.env.TMP = isolatedTmp;
    process.env.TMPDIR = isolatedTmp;
    try {
      expect(() => materializeGradleUserHome({
        runPrewarm: () => { throw new Error('injected prewarm failure'); },
      })).toThrow('injected prewarm failure');
      expect(readdirSync(isolatedTmp)).toEqual([]);
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
  });
});

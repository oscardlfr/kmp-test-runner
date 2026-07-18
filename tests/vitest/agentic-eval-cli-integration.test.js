// tests/vitest/agentic-eval-cli-integration.test.js
// Real end-to-end integration tests for tools/agentic-eval/cli.mjs's calibrate/smoke commands,
// run as REAL `node cli.mjs ...` subprocesses against the fake `claude` fixtures under
// tests/fixtures/fake-claude-*/ (never the real claude CLI -- zero API cost, zero live
// authentication needed). Exercises the harness's OWN orchestration: privacy wiring
// (assertCleanOrThrow actually runs), gate-before-write (no committable evidence on any
// failure), the strengthened hard acceptance gates, wall_clock_ms, and cleanup (no leftover
// temp dirs/worktrees after either a passing or failing run).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'tools', 'agentic-eval', 'cli.mjs');
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const RUNS_ROOT = path.join(REPO_ROOT, 'tools', 'runs');

// os.tmpdir() is a GLOBAL, shared resource -- vitest runs test FILES concurrently by default,
// and agentic-eval-materialize.test.js's own tests create temp dirs with the exact same
// kmp-agentic-eval-* prefix cli.mjs itself uses (they call the same underlying materialize.mjs
// functions directly). A naive "count matching dirs before/after" leak check is flaky under that
// concurrency -- confirmed empirically (a real, one-off leak this WAS designed to catch got
// masked by noisy +2/+3 deltas from unrelated concurrent tests once the suite ran as a whole,
// not in isolation). Redirecting TEMP/TMP/TMPDIR to a fresh, test-exclusive directory for the
// subprocess makes every mkdtempSync(tmpdir()) call inside it land somewhere no other test can
// ever touch, so "is it empty after cleanup" is exact and non-flaky regardless of what else is
// running concurrently.
function fakeClaudeEnv(scenario, { isolatedTmp } = {}) {
  const fakeDir = path.join(FIXTURES_DIR, `fake-claude-${scenario}`);
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const env = { ...process.env, PATH: `${fakeDir}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}` };
  if (isolatedTmp) {
    env.TEMP = isolatedTmp;
    env.TMP = isolatedTmp;
    env.TMPDIR = isolatedTmp;
  }
  return env;
}

function runCli(args, env) {
  const r = spawnSync('node', [CLI_PATH, ...args], { env, encoding: 'utf8', timeout: 30000 });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* stderr-only failure path -- fine */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, parsed };
}

function evidenceDirFor(runKind) {
  return path.join(RUNS_ROOT, `agentic-eval-${runKind}`);
}

function listEvidenceFiles(runKind) {
  const dir = evidenceDirFor(runKind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json'));
}

// Every test cleans up any evidence IT wrote (this harness's own committable-evidence
// directories are shared, real repo paths -- tests must never leave artifacts behind).
const writtenDuringTest = { calibration: [], smoke: [] };
afterEach(() => {
  for (const runKind of ['calibration', 'smoke']) {
    for (const f of writtenDuringTest[runKind]) {
      rmSync(path.join(evidenceDirFor(runKind), f), { force: true });
    }
    writtenDuringTest[runKind] = [];
    const rawDir = path.join(evidenceDirFor(runKind), 'raw');
    if (existsSync(rawDir)) rmSync(rawDir, { recursive: true, force: true });
  }
});

function trackEvidence(runKind) {
  writtenDuringTest[runKind] = listEvidenceFiles(runKind);
}

describe('cli.mjs calibrate -- real subprocess against fake claude (no live API cost)', () => {
  it('success scenario: passes the hard gate, writes schema-valid evidence, sets a real wall_clock_ms', () => {
    const before = new Set(listEvidenceFiles('calibration'));
    const result = runCli(['calibrate', '--model', 'fake-model-x'], fakeClaudeEnv('success'));
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    const { recordA, recordB } = result.parsed;
    expect(recordA.skill_available.value).toBe(false);
    expect(recordB.skill_available.value).toBe(true);
    expect(recordA.skill_invocation_attempted.value).toBe(true);
    expect(recordB.skill_invocation_attempted.value).toBe(true);
    expect(recordA.skill_invoked.value).toBe(false);
    expect(recordB.skill_invoked.value).toBe(true);
    expect(recordA.model_requested).toBe('fake-model-x');
    expect(typeof recordA.wall_clock_ms).toBe('number');
    expect(recordA.wall_clock_ms).toBeGreaterThanOrEqual(0);
    // started_at/ended_at must be genuinely captured before/after the spawn, not two nowIso()
    // calls back-to-back after the fact -- ended_at can never be BEFORE started_at.
    expect(new Date(recordA.ended_at).getTime()).toBeGreaterThanOrEqual(new Date(recordA.started_at).getTime());

    const after = listEvidenceFiles('calibration').filter((f) => !before.has(f));
    expect(after.length).toBe(2);
    trackEvidence('calibration');
    for (const f of after) {
      const written = JSON.parse(readFileSync(path.join(evidenceDirFor('calibration'), f), 'utf8'));
      expect(written.schema).toBe(1);
    }
  }, 20000);

  it('no-tool-use scenario: fails the hard gate (no attempt at all) and writes NO evidence', () => {
    const before = new Set(listEvidenceFiles('calibration'));
    const result = runCli(['calibrate', '--model', 'fake-model-x'], fakeClaudeEnv('no-tool-use'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CALIBRATION FAILED');
    const after = listEvidenceFiles('calibration').filter((f) => !before.has(f));
    expect(after.length).toBe(0);
  }, 20000);

  it('leaves no leftover temp directories after a passing run (cleanup ran)', () => {
    const isolatedTmp = mkdtempSync(path.join(os.tmpdir(), 'aeci-isolated-tmp-'));
    try {
      const result = runCli(['calibrate', '--model', 'fake-model-x'], fakeClaudeEnv('success', { isolatedTmp }));
      expect(result.status).toBe(0);
      trackEvidence('calibration');
      expect(readdirSync(isolatedTmp)).toEqual([]);
    } finally {
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
  }, 20000);

  it('leaves no leftover temp directories after a FAILING run either (cleanup runs in finally)', () => {
    const isolatedTmp = mkdtempSync(path.join(os.tmpdir(), 'aeci-isolated-tmp-'));
    try {
      const result = runCli(['calibrate', '--model', 'fake-model-x'], fakeClaudeEnv('no-tool-use', { isolatedTmp }));
      expect(result.status).toBe(1);
      expect(readdirSync(isolatedTmp)).toEqual([]);
    } finally {
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
  }, 20000);
});

describe('cli.mjs smoke -- real subprocess against fake claude (no live API cost)', () => {
  let sourceRepoDir;
  let pinnedCommit;

  function gitViaBash(argv, cwd) {
    const shQuote = (arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`;
    const cmd = argv.map(shQuote).join(' ');
    const r = spawnSync(resolveBash(), ['-c', `git ${cmd}`], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  }

  beforeEach(() => {
    // A tiny, real, local git repo stands in for a real scenario source (KaMPKit) -- exercises
    // the REAL materializeScenarioProject/removeScenarioWorktree git-worktree machinery without
    // needing a real clone.
    sourceRepoDir = mkdtempSync(path.join(os.tmpdir(), 'aeci-source-'));
    gitViaBash(['init', '-q'], sourceRepoDir);
    gitViaBash(['config', 'user.email', 'test@example.com'], sourceRepoDir);
    gitViaBash(['config', 'user.name', 'Test'], sourceRepoDir);
    writeFileSync(path.join(sourceRepoDir, 'marker.txt'), 'pristine\n');
    gitViaBash(['add', '-A'], sourceRepoDir);
    gitViaBash(['commit', '-q', '-m', 'initial'], sourceRepoDir);
    pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
  });

  afterEach(() => {
    rmSync(sourceRepoDir, { recursive: true, force: true });
  });

  function smokeArgs(extra = []) {
    return ['smoke', '--source-repo-dir', sourceRepoDir, '--pinned-commit', pinnedCommit, '--project-alias', 'integration-test', '--model', 'fake-model-x', ...extra];
  }

  it('success scenario: passes the equivalent-real-work hard gate and writes schema-valid evidence', () => {
    const before = new Set(listEvidenceFiles('smoke'));
    const result = runCli(smokeArgs(), fakeClaudeEnv('success'));
    expect(result.status).toBe(0);
    const { recordA, recordB } = result.parsed;
    expect(recordA.skill_available.value).toBe(false);
    expect(recordB.skill_available.value).toBe(true);
    expect(recordA.hook_call_count).toBeGreaterThanOrEqual(1);
    expect(recordA.hook_deny_count).toBe(0);
    expect(recordB.hook_call_count).toBeGreaterThanOrEqual(1);
    expect(recordB.hook_deny_count).toBe(0);
    expect(recordA.privacy_status).toBe('public');

    const after = listEvidenceFiles('smoke').filter((f) => !before.has(f));
    expect(after.length).toBe(2);
    trackEvidence('smoke');
  }, 30000);

  it('all-denied scenario: fails the equivalent-real-work hard gate (hook_deny_count>0) and writes NO evidence', () => {
    const before = new Set(listEvidenceFiles('smoke'));
    const result = runCli(smokeArgs(), fakeClaudeEnv('all-denied'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SMOKE FAILED');
    const after = listEvidenceFiles('smoke').filter((f) => !before.has(f));
    expect(after.length).toBe(0);
  }, 30000);

  it('malformed-transcript scenario: fails the clean-transcript hard gate and writes NO evidence', () => {
    const before = new Set(listEvidenceFiles('smoke'));
    const result = runCli(smokeArgs(), fakeClaudeEnv('malformed'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SMOKE FAILED');
    const after = listEvidenceFiles('smoke').filter((f) => !before.has(f));
    expect(after.length).toBe(0);
  }, 30000);

  it('leaves no registered git worktree behind after a passing run (removeScenarioWorktree ran)', () => {
    const result = runCli(smokeArgs(), fakeClaudeEnv('success'));
    expect(result.status).toBe(0);
    trackEvidence('smoke');
    const worktreeList = gitViaBash(['worktree', 'list'], sourceRepoDir);
    // Only the main working tree (sourceRepoDir itself) should be listed -- no scenario
    // worktree left registered.
    expect(worktreeList.trim().split('\n').length).toBe(1);
  }, 30000);

  it('leaves no registered git worktree behind after a FAILING run either (cleanup runs in finally)', () => {
    const result = runCli(smokeArgs(), fakeClaudeEnv('all-denied'));
    expect(result.status).toBe(1);
    const worktreeList = gitViaBash(['worktree', 'list'], sourceRepoDir);
    expect(worktreeList.trim().split('\n').length).toBe(1);
  }, 30000);
});

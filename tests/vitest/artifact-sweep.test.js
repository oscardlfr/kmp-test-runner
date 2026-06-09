// SPDX-License-Identifier: MIT
// tests/vitest/artifact-sweep.test.js — unit tests for
// lib/project/artifact-sweep.js (TTL sweep, clean engine, cleanup-config
// resolution, rename retry).

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  sweepArtifacts,
  cleanArtifacts,
  resolveCleanupConfig,
  renameWithRetrySync,
  DEFAULT_LOGS_TTL_DAYS,
} from '../../lib/project/artifact-sweep.js';

let workDir;
afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

function makeProjectRoot() {
  workDir = mkdtempSync(path.join(tmpdir(), 'kmp-sweep-'));
  return { projectRoot: workDir, root: path.join(workDir, '.kmp-test-runner') };
}

function backdate(p, days) {
  const t = (Date.now() - days * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(p, t, t);
}

// Per-run dir with one content file. Backdates the DIR mtime (what the
// sweep stats) after the content write (which would otherwise refresh it).
function makeRun(root, rel, ageDays) {
  const dir = path.join(root, ...rel.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'content.log'), 'x');
  if (ageDays > 0) backdate(dir, ageDays);
  return dir;
}

function makeFile(root, rel, ageDays) {
  const p = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, 'x');
  if (ageDays > 0) backdate(p, ageDays);
  return p;
}

describe('resolveCleanupConfig', () => {
  it('defaults: auto on, 7-day logs TTL', () => {
    expect(resolveCleanupConfig(null, {})).toEqual({ auto: true, logsTtlDays: DEFAULT_LOGS_TTL_DAYS });
  });

  it('config overrides auto + logsTtlDays', () => {
    expect(resolveCleanupConfig({ cleanup: { auto: false, logsTtlDays: 3 } }, {}))
      .toEqual({ auto: false, logsTtlDays: 3 });
  });

  it('KMP_TEST_NO_SWEEP=1 hard-disables auto regardless of config', () => {
    expect(resolveCleanupConfig({ cleanup: { auto: true } }, { KMP_TEST_NO_SWEEP: '1' }).auto).toBe(false);
  });

  it('invalid logsTtlDays falls back to the default', () => {
    expect(resolveCleanupConfig({ cleanup: { logsTtlDays: -2 } }, {}).logsTtlDays).toBe(DEFAULT_LOGS_TTL_DAYS);
    expect(resolveCleanupConfig({ cleanup: { logsTtlDays: 'soon' } }, {}).logsTtlDays).toBe(DEFAULT_LOGS_TTL_DAYS);
  });
});

describe('sweepArtifacts', () => {
  it('removes stale disposables (>24h), keeps fresh ones and cache valuables', () => {
    const { projectRoot, root } = makeProjectRoot();
    const staleIso = makeRun(root, 'cache-isolated/111-222', 2);
    const freshIso = makeRun(root, 'cache-isolated/333-444', 0);
    const staleInit = makeFile(root, 'init-scripts/coverage.init.gradle', 2);
    const staleTmp = makeFile(root, 'cache/tasks-abc.txt.tmp.123', 2);
    // Valuables — NEVER auto-swept regardless of age.
    const keptModel = makeFile(root, 'cache/model-abc.json', 400);
    const keptTasks = makeFile(root, 'cache/tasks-abc.txt', 400);

    const r = sweepArtifacts(projectRoot);
    expect(existsSync(staleIso)).toBe(false);
    expect(existsSync(staleInit)).toBe(false);
    expect(existsSync(staleTmp)).toBe(false);
    expect(existsSync(freshIso)).toBe(true);
    expect(existsSync(keptModel)).toBe(true);
    expect(existsSync(keptTasks)).toBe(true);
    expect(r.removed.length).toBe(3);
  });

  it('removes per-run log dirs older than logsTtlDays, keeps newer', () => {
    const { projectRoot, root } = makeProjectRoot();
    const oldRun = makeRun(root, 'logs/android/run-old', 10);
    const newRun = makeRun(root, 'logs/android/run-new', 1);
    sweepArtifacts(projectRoot, { logsTtlDays: 7 });
    expect(existsSync(oldRun)).toBe(false);
    expect(existsSync(newRun)).toBe(true);
  });

  it('never touches reports/, the lockfile, or the config file', () => {
    const { projectRoot, root } = makeProjectRoot();
    const report = makeFile(root, 'reports/coverage/latest.md', 400);
    const lock = path.join(projectRoot, '.kmp-test-runner.lock');
    writeFileSync(lock, '{}');
    backdate(lock, 400);
    const cfg = path.join(projectRoot, '.kmp-test-runner.json');
    writeFileSync(cfg, '{}');
    backdate(cfg, 400);

    sweepArtifacts(projectRoot);
    expect(existsSync(report)).toBe(true);
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(cfg)).toBe(true);
  });

  it('no-op when .kmp-test-runner does not exist', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-sweep-empty-'));
    expect(sweepArtifacts(workDir).removed).toEqual([]);
  });
});

describe('cleanArtifacts', () => {
  it('default scope removes run artifacts (any age) but keeps cache + reports', () => {
    const { projectRoot, root } = makeProjectRoot();
    makeRun(root, 'logs/android/r1', 0);
    makeRun(root, 'cache-isolated/r2', 0);
    makeFile(root, 'init-scripts/x.init.gradle', 0);
    const tmp = makeFile(root, 'cache/tasks-a.txt.tmp.9', 0);
    const model = makeFile(root, 'cache/model-a.json', 0);
    const report = makeFile(root, 'reports/coverage/latest.md', 0);

    const r = cleanArtifacts(projectRoot);
    expect(existsSync(path.join(root, 'logs'))).toBe(false);
    expect(existsSync(path.join(root, 'cache-isolated'))).toBe(false);
    expect(existsSync(path.join(root, 'init-scripts'))).toBe(false);
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(model)).toBe(true);
    expect(existsSync(report)).toBe(true);
    expect(r.removed.length).toBe(4);
    expect(r.bytesFreed).toBeGreaterThan(0);
  });

  it('--all additionally purges cache/ and reports/', () => {
    const { projectRoot, root } = makeProjectRoot();
    makeFile(root, 'cache/model-a.json', 0);
    makeFile(root, 'reports/coverage/latest.md', 0);
    cleanArtifacts(projectRoot, { all: true });
    expect(existsSync(path.join(root, 'cache'))).toBe(false);
    expect(existsSync(path.join(root, 'reports'))).toBe(false);
  });

  it('dryRun lists targets with sizes without deleting anything', () => {
    const { projectRoot, root } = makeProjectRoot();
    makeRun(root, 'logs/android/r1', 0);
    const r = cleanArtifacts(projectRoot, { dryRun: true });
    expect(r.targets.length).toBe(1);
    expect(r.targets[0].bytes).toBeGreaterThan(0);
    expect(r.removed).toEqual([]);
    expect(existsSync(path.join(root, 'logs'))).toBe(true);
  });
});

describe('renameWithRetrySync', () => {
  it('retries EPERM and reports success once the rename lands', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-rename-'));
    const tmp = path.join(workDir, 'a.tmp.1');
    writeFileSync(tmp, 'x');
    let calls = 0;
    const rename = (a, b) => {
      calls++;
      if (calls < 3) {
        const e = new Error('busy');
        e.code = 'EPERM';
        throw e;
      }
      writeFileSync(b, 'x');
    };
    const ok = renameWithRetrySync(tmp, path.join(workDir, 'a.txt'), { rename, delays: [1, 1, 1] });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('non-retriable error gives up immediately and unlinks the tmp', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-rename2-'));
    const tmp = path.join(workDir, 'b.tmp.1');
    writeFileSync(tmp, 'x');
    let calls = 0;
    const rename = () => {
      calls++;
      const e = new Error('nope');
      e.code = 'ENOENT';
      throw e;
    };
    const ok = renameWithRetrySync(tmp, path.join(workDir, 'b.txt'), { rename, delays: [1, 1] });
    expect(ok).toBe(false);
    expect(calls).toBe(1);
    expect(existsSync(tmp)).toBe(false);
  });

  it('exhausted retries give up and unlink the tmp', () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-rename3-'));
    const tmp = path.join(workDir, 'c.tmp.1');
    writeFileSync(tmp, 'x');
    let calls = 0;
    const rename = () => {
      calls++;
      const e = new Error('busy');
      e.code = 'EBUSY';
      throw e;
    };
    const ok = renameWithRetrySync(tmp, path.join(workDir, 'c.txt'), { rename, delays: [1, 1] });
    expect(ok).toBe(false);
    expect(calls).toBe(3); // initial attempt + 2 retries
    expect(existsSync(tmp)).toBe(false);
  });
});

// SPDX-License-Identifier: MIT
// tests/vitest/lockfile.test.js — unit tests for lib/runners/lockfile.js.
//
// Tests for the concurrent-invocation safety helpers. Lives in a dedicated
// file (not cli.test.js) because the lockfile module was extracted from
// cli.js in refactor PR-09 — its tests follow the source.

import { describe, it, expect } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  isPidAlive,
  isLockfileStaleByTime,
  readLockfile,
  writeLockfile,
  removeLockfile,
  acquireLock,
  lockAgeLabel,
  STALE_THRESHOLD_MS,
} from '../../lib/runners/lockfile.js';
import { withFakeGradleProject, DEAD_PID } from './_test-helpers.js';

describe('isPidAlive', () => {
  it('returns true for current process PID', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
  it('returns false for clearly-dead PID', () => {
    expect(isPidAlive(DEAD_PID)).toBe(false);
  });
  it('returns false for non-numeric / invalid input', () => {
    expect(isPidAlive(null)).toBe(false);
    expect(isPidAlive(undefined)).toBe(false);
    expect(isPidAlive('123')).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(NaN)).toBe(false);
  });
});

describe('readLockfile / writeLockfile / removeLockfile round-trip', () => {
  it('returns null when no lockfile exists', () => {
    withFakeGradleProject(dir => {
      expect(readLockfile(dir)).toBeNull();
    });
  });

  it('write → read produces the same shape with required keys', () => {
    withFakeGradleProject(dir => {
      const written = writeLockfile(dir, 'parallel');
      const read = readLockfile(dir);
      expect(read).toEqual(written);
      expect(read.schema).toBe(1);
      expect(read.pid).toBe(process.pid);
      expect(read.subcommand).toBe('parallel');
      expect(read.project_root).toBe(dir);
      expect(typeof read.start_time).toBe('string');
      expect(new Date(read.start_time).toString()).not.toBe('Invalid Date');
      expect(typeof read.version).toBe('string');
    });
  });

  it('returns {invalid:true} on unparseable JSON', () => {
    withFakeGradleProject(dir => {
      writeFileSync(path.join(dir, '.kmp-test-runner.lock'), 'not-json{', 'utf8');
      expect(readLockfile(dir)).toEqual({ invalid: true });
    });
  });

  it('removeLockfile deletes the file and is idempotent', () => {
    withFakeGradleProject(dir => {
      writeLockfile(dir, 'parallel');
      expect(existsSync(path.join(dir, '.kmp-test-runner.lock'))).toBe(true);
      removeLockfile(dir);
      expect(existsSync(path.join(dir, '.kmp-test-runner.lock'))).toBe(false);
      // Calling again on missing lock must not throw.
      expect(() => removeLockfile(dir)).not.toThrow();
    });
  });
});

describe('acquireLock', () => {
  it('fresh acquire when no prior lock', () => {
    withFakeGradleProject(dir => {
      const r = acquireLock(dir, 'parallel', { force: false });
      expect(r.ok).toBe(true);
      expect(r.reclaimed).toBeUndefined();
      expect(r.forced).toBeUndefined();
      expect(r.ourLock.pid).toBe(process.pid);
    });
  });

  it('refuses with lock_held when existing lock has live PID and no --force', () => {
    withFakeGradleProject(dir => {
      // Pre-write a lock with our own PID (definitely alive).
      writeFileSync(
        path.join(dir, '.kmp-test-runner.lock'),
        JSON.stringify({
          schema: 1, pid: process.pid, start_time: new Date().toISOString(),
          subcommand: 'parallel', project_root: dir, version: '0.3.8',
        }),
        'utf8',
      );
      const r = acquireLock(dir, 'changed', { force: false });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('lock_held');
      expect(r.existing.pid).toBe(process.pid);
      expect(r.existing.subcommand).toBe('parallel');
    });
  });

  it('reclaims when existing lock has dead PID', () => {
    withFakeGradleProject(dir => {
      writeFileSync(
        path.join(dir, '.kmp-test-runner.lock'),
        JSON.stringify({
          schema: 1, pid: DEAD_PID, start_time: '2026-04-26T00:00:00.000Z',
          subcommand: 'parallel', project_root: dir, version: '0.3.8',
        }),
        'utf8',
      );
      const r = acquireLock(dir, 'changed', { force: false });
      expect(r.ok).toBe(true);
      expect(r.reclaimed).toBe(true);
      expect(r.ourLock.pid).toBe(process.pid);
      expect(r.ourLock.subcommand).toBe('changed');
    });
  });

  it('--force bypasses a live lock and writes our own', () => {
    withFakeGradleProject(dir => {
      writeFileSync(
        path.join(dir, '.kmp-test-runner.lock'),
        JSON.stringify({
          schema: 1, pid: process.pid, start_time: new Date().toISOString(),
          subcommand: 'parallel', project_root: dir, version: '0.3.8',
        }),
        'utf8',
      );
      const r = acquireLock(dir, 'changed', { force: true });
      expect(r.ok).toBe(true);
      expect(r.forced).toBe(true);
      expect(r.existing).toBeTruthy();
      expect(r.ourLock.subcommand).toBe('changed');
      const onDisk = readLockfile(dir);
      expect(onDisk.subcommand).toBe('changed');
    });
  });

  it('reclaims unparseable lockfile', () => {
    withFakeGradleProject(dir => {
      writeFileSync(path.join(dir, '.kmp-test-runner.lock'), 'garbage{', 'utf8');
      const r = acquireLock(dir, 'parallel', { force: false });
      expect(r.ok).toBe(true);
      expect(r.ourLock.pid).toBe(process.pid);
    });
  });

  it('returns write_error when target dir does not exist', () => {
    const ghost = path.join(tmpdir(), 'kmp-no-such-dir-' + Date.now());
    const r = acquireLock(ghost, 'parallel', { force: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('write_error');
    expect(r.error).toBeTruthy();
  });

  // Stale-by-time / PID-recycle guard. Lockfile age that predates the host's
  // last boot OR exceeds STALE_THRESHOLD_MS reclaims the lock even when
  // isPidAlive reports the PID as live (almost certainly a recycled PID on
  // Windows, where PIDs are aggressively reused after a process exits).
  it('reclaims a lock whose start_time predates the host boot', () => {
    withFakeGradleProject(dir => {
      writeFileSync(
        path.join(dir, '.kmp-test-runner.lock'),
        JSON.stringify({
          schema: 1, pid: process.pid, start_time: '2020-01-01T00:00:00.000Z',
          subcommand: 'parallel', project_root: dir, version: '0.3.8',
        }),
        'utf8',
      );
      const r = acquireLock(dir, 'changed', { force: false });
      expect(r.ok).toBe(true);
      expect(r.reclaimed).toBe(true);
      expect(r.ourLock.subcommand).toBe('changed');
    });
  });

  it('reclaims a lock whose start_time exceeds STALE_THRESHOLD_MS (PID recycle within boot)', () => {
    withFakeGradleProject(dir => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      writeFileSync(
        path.join(dir, '.kmp-test-runner.lock'),
        JSON.stringify({
          schema: 1, pid: process.pid, start_time: fiveHoursAgo,
          subcommand: 'parallel', project_root: dir, version: '0.3.8',
        }),
        'utf8',
      );
      const r = acquireLock(dir, 'changed', { force: false });
      expect(r.ok).toBe(true);
      expect(r.reclaimed).toBe(true);
    });
  });

  it('does NOT reclaim a fresh lock with live PID (no false positive)', () => {
    withFakeGradleProject(dir => {
      // start_time = now (not "60s ago") so the boot-time guard cannot
      // false-positive on fresh CI runners whose uptime is shorter than the
      // chosen back-offset. The intent is "fresh lock from a live process";
      // "now" satisfies that more robustly than any past timestamp.
      writeFileSync(
        path.join(dir, '.kmp-test-runner.lock'),
        JSON.stringify({
          schema: 1, pid: process.pid, start_time: new Date().toISOString(),
          subcommand: 'parallel', project_root: dir, version: '0.3.8',
        }),
        'utf8',
      );
      const r = acquireLock(dir, 'changed', { force: false });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('lock_held');
    });
  });

  it('unparseable-lockfile claim does NOT carry the reclaimed flag (contract)', () => {
    withFakeGradleProject(dir => {
      writeFileSync(path.join(dir, '.kmp-test-runner.lock'), 'garbage{', 'utf8');
      const r = acquireLock(dir, 'parallel', { force: false });
      expect(r.ok).toBe(true);
      // `reclaimed` is reserved for displacing a STALE-but-valid lock (dead
      // PID / time-stale). Invalid JSON claims silently — same contract as
      // the pre-exclusive-create implementation.
      expect(r.reclaimed).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Exclusive-create acquisition — the TOCTOU race the 'wx' rewrite closes
// ---------------------------------------------------------------------------
describe('acquireLock exclusive-create race', () => {
  // True 2-process race: both children attempt acquireLock against the same
  // project dir and then HOLD (keep their event loop alive) so PID-liveness
  // cannot reclaim mid-test. openSync('wx') is atomic at the FS layer, so
  // regardless of interleaving exactly one child wins and the other reports
  // lock_held. Pre-fix (read→check→writeFileSync) both could "win".
  // Manages its own temp dir — withFakeGradleProject tears down synchronously
  // and this test is async.
  it('exactly one of two concurrent processes acquires; the loser gets lock_held', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-lock-race-'));
    const lockfileUrl = pathToFileURL(
      path.resolve('lib', 'runners', 'lockfile.js')
    ).href;
    const childScript = `
      const m = await import(${JSON.stringify(lockfileUrl)});
      const r = m.acquireLock(${JSON.stringify(dir)}, 'race-test');
      process.stdout.write(JSON.stringify({ ok: r.ok, reason: r.reason ?? null, reclaimed: r.reclaimed ?? false }));
      if (r.ok) setInterval(() => {}, 1000); // hold the lock (stay alive) until killed
    `;
    const launch = () => new Promise((res) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let out = '';
      child.stdout.on('data', (d) => {
        out += String(d);
        // Both outcomes print exactly one JSON object — resolve on it.
        try { res({ child, result: JSON.parse(out) }); } catch { /* partial chunk */ }
      });
      child.on('error', (e) => res({ child, result: { ok: false, reason: `spawn-error:${e.message}` } }));
    });

    const [a, b] = await Promise.all([launch(), launch()]);
    try {
      const results = [a.result, b.result];
      const winners = results.filter(r => r.ok === true);
      const losers = results.filter(r => r.ok === false);
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);
      expect(losers[0].reason).toBe('lock_held');
      // Nobody "reclaimed" — both PIDs were alive the whole time.
      expect(winners[0].reclaimed).toBe(false);
    } finally {
      a.child.kill();
      b.child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('isLockfileStaleByTime', () => {
  it('returns false for null / undefined / missing start_time', () => {
    expect(isLockfileStaleByTime(null)).toBe(false);
    expect(isLockfileStaleByTime(undefined)).toBe(false);
    expect(isLockfileStaleByTime({})).toBe(false);
    expect(isLockfileStaleByTime({ start_time: null })).toBe(false);
    expect(isLockfileStaleByTime({ start_time: 'not-a-date' })).toBe(false);
  });

  it('returns true when start_time predates simulated boot', () => {
    const lock = { start_time: '2020-01-01T00:00:00.000Z' };
    // Inject uptimeMs/now so the test is deterministic regardless of when
    // the host actually booted.
    expect(isLockfileStaleByTime(lock, {
      now: new Date('2026-05-17T12:00:00.000Z').getTime(),
      uptimeMs: 60_000,
    })).toBe(true);
  });

  it('returns true when start_time exceeds STALE_THRESHOLD_MS', () => {
    const now = Date.now();
    const lock = { start_time: new Date(now - STALE_THRESHOLD_MS - 1000).toISOString() };
    // uptimeMs >> threshold so the boot-time branch can't fire — we're
    // exercising the age-threshold branch in isolation.
    expect(isLockfileStaleByTime(lock, { now, uptimeMs: 24 * 60 * 60 * 1000 })).toBe(true);
  });

  it('returns false for a fresh lock within threshold', () => {
    const now = Date.now();
    const lock = { start_time: new Date(now - 60_000).toISOString() };
    expect(isLockfileStaleByTime(lock, { now, uptimeMs: 24 * 60 * 60 * 1000 })).toBe(false);
  });
});

describe('lockAgeLabel', () => {
  it('formats sub-minute as "Ns"', () => {
    const t = new Date(Date.now() - 5_000).toISOString();
    expect(lockAgeLabel(t)).toMatch(/^\ds$/);
  });
  it('formats sub-hour as "NmMs"', () => {
    const t = new Date(Date.now() - (3 * 60 + 12) * 1000).toISOString();
    expect(lockAgeLabel(t)).toBe('3m12s');
  });
  it('formats over-hour as "NhMm"', () => {
    const t = new Date(Date.now() - (2 * 3600 + 17 * 60) * 1000).toISOString();
    expect(lockAgeLabel(t)).toBe('2h17m');
  });
  it('returns "?" for unparseable input', () => {
    expect(lockAgeLabel('not-a-date')).toBe('?');
    expect(lockAgeLabel(null)).toBe('?');
  });
});

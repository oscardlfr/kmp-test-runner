// SPDX-License-Identifier: MIT
// tests/vitest/lockfile.test.js — unit tests for lib/runners/lockfile.js.
//
// Tests for the concurrent-invocation safety helpers. Lives in a dedicated
// file (not cli.test.js) because the lockfile module was extracted from
// cli.js in refactor PR-09 — its tests follow the source.

import { describe, it, expect } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  isPidAlive,
  readLockfile,
  writeLockfile,
  removeLockfile,
  acquireLock,
  lockAgeLabel,
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

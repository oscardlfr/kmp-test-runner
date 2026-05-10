// SPDX-License-Identifier: MIT
// lib/runners/lockfile.js — concurrent-invocation safety (Tier 1, v0.3.8+)
//
// Refactor PR-09: extracted from lib/cli.js. cli.js re-exports these names
// through its `export {}` block so existing consumers (cli.test.js, Pester
// concurrency tests, orchestrators) keep importing from './cli.js' unchanged
// via ESM live bindings.
//
// Advisory lockfile at <project>/.kmp-test-runner.lock prevents two kmp-test
// runs from clobbering each other's reports / temp logs / gradle daemons when
// pointed at the same project root. Same-host coordination only — does not
// guard cross-host CI matrices.
//
// Schema v1: { schema, pid, start_time, subcommand, project_root, version }.
//
// `--force` bypasses a live lock (still writes own lock so a third arrival
// sees a coherent state). `doctor` and `--dry-run` skip the lock entirely
// since they neither spawn gradle nor write reports.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { readVersion } from '../envelope/builder.js';

const LOCKFILE_NAME = '.kmp-test-runner.lock';

function lockfilePath(projectRoot) {
  return path.join(projectRoot, LOCKFILE_NAME);
}

// Returns true if the PID is alive. EPERM (permission denied — typically
// process owned by another user) is treated as alive (conservative). ESRCH
// or any other error → dead.
function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === 'EPERM') return true;
    return false;
  }
}

function readLockfile(projectRoot) {
  const p = lockfilePath(projectRoot);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return { invalid: true };
    return obj;
  } catch {
    return { invalid: true };
  }
}

function writeLockfile(projectRoot, subcommand) {
  const lock = {
    schema: 1,
    pid: process.pid,
    start_time: new Date().toISOString(),
    subcommand,
    project_root: projectRoot,
    version: readVersion(),
  };
  writeFileSync(lockfilePath(projectRoot), JSON.stringify(lock, null, 2), 'utf8');
  return lock;
}

function removeLockfile(projectRoot) {
  try { unlinkSync(lockfilePath(projectRoot)); } catch { /* best-effort */ }
}

// Return values:
//   { ok: true, ourLock }                       — fresh acquisition
//   { ok: true, reclaimed: true, ourLock }      — stale lock reclaimed (PID dead)
//   { ok: true, forced: true, ourLock, existing } — --force bypassed live lock
//   { ok: false, reason: 'lock_held', existing }  — refused (live + no force)
//   { ok: false, reason: 'write_error', error }   — couldn't write (e.g. read-only fs)
function acquireLock(projectRoot, subcommand, { force = false } = {}) {
  const existing = readLockfile(projectRoot);

  // No prior lock or unparseable → claim it.
  if (!existing || existing.invalid) {
    try {
      const ourLock = writeLockfile(projectRoot, subcommand);
      return { ok: true, ourLock };
    } catch (error) {
      return { ok: false, reason: 'write_error', error };
    }
  }

  const alive = isPidAlive(existing.pid);
  if (alive && !force) {
    return { ok: false, reason: 'lock_held', existing };
  }

  // Either stale (PID dead) or live + --force. Write our own lock either way.
  try {
    const ourLock = writeLockfile(projectRoot, subcommand);
    if (alive && force) return { ok: true, forced: true, ourLock, existing };
    return { ok: true, reclaimed: true, ourLock };
  } catch (error) {
    return { ok: false, reason: 'write_error', error };
  }
}

// Human-readable age from an ISO start_time. Best-effort.
function lockAgeLabel(isoStr) {
  if (typeof isoStr !== 'string' || isoStr.length === 0) return '?';
  try {
    const t = new Date(isoStr).getTime();
    if (!Number.isFinite(t) || Number.isNaN(t)) return '?';
    const ms = Date.now() - t;
    if (!Number.isFinite(ms) || ms < 0) return '?';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m${sec % 60}s`;
    const hr = Math.floor(min / 60);
    return `${hr}h${min % 60}m`;
  } catch { return '?'; }
}

export {
  LOCKFILE_NAME,
  lockfilePath,
  isPidAlive,
  readLockfile,
  writeLockfile,
  removeLockfile,
  acquireLock,
  lockAgeLabel,
};

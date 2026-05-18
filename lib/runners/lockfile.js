// SPDX-License-Identifier: MIT
// lib/runners/lockfile.js — concurrent-invocation safety (Tier 1, v0.3.8+)
//
// cli.js re-exports these names through its `export {}` block so existing
// consumers (cli.test.js, Pester concurrency tests, orchestrators) keep
// importing from './cli.js' unchanged via ESM live bindings.
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
import os from 'node:os';
import path from 'node:path';
import { readVersion } from '../envelope/builder.js';

const LOCKFILE_NAME = '.kmp-test-runner.lock';

// Stale-by-time threshold. Lockfiles whose `start_time` exceeds this age are
// treated as stale regardless of whether `isPidAlive` says the PID is alive,
// because Windows aggressively recycles PIDs and the lockfile schema doesn't
// validate process identity beyond PID. 4 hours is the upper bound for any
// legitimate kmp-test run — benchmarks at the heaviest end of the matrix
// finish in <2h; bench timeouts fire at 1h max — so 4h is comfortably above
// the real-world envelope without giving up the stale-recovery property.
const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000;

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

// Returns true when the lockfile is stale strictly on time grounds — either
// it predates the host's last boot (so the original process can't possibly
// be alive, regardless of whether the PID is now reused) or its start_time
// exceeds STALE_THRESHOLD_MS. The second case catches PID recycle within the
// same boot session: Windows can recycle a PID to a new process minutes after
// the original exits, and `process.kill(pid, 0)` reports the recycled process
// as alive — but it isn't the kmp-test process that owned the lock.
function isLockfileStaleByTime(existing, { now = Date.now(), uptimeMs = os.uptime() * 1000 } = {}) {
  if (!existing || typeof existing.start_time !== 'string') return false;
  const lockTime = new Date(existing.start_time).getTime();
  if (!Number.isFinite(lockTime)) return false;
  const bootTime = now - uptimeMs;
  if (lockTime < bootTime) return true;
  const ageMs = now - lockTime;
  return ageMs > STALE_THRESHOLD_MS;
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
  const staleByTime = isLockfileStaleByTime(existing);
  if (alive && !staleByTime && !force) {
    return { ok: false, reason: 'lock_held', existing };
  }

  // Either stale (PID dead OR time-stale) or live + --force. Write our own
  // lock either way. `forced` only when the original PID is genuinely alive
  // AND we bypassed via --force (so the human-readable banner can warn about
  // racing the previous process). When stale-by-time reclaims a "live" PID
  // (almost certainly a recycled one), report it as `reclaimed`.
  try {
    const ourLock = writeLockfile(projectRoot, subcommand);
    if (alive && !staleByTime && force) return { ok: true, forced: true, ourLock, existing };
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
  STALE_THRESHOLD_MS,
  lockfilePath,
  isPidAlive,
  isLockfileStaleByTime,
  readLockfile,
  writeLockfile,
  removeLockfile,
  acquireLock,
  lockAgeLabel,
};

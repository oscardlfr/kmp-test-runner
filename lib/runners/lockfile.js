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

import {
  existsSync, readFileSync, writeFileSync, unlinkSync,
  openSync, writeSync, closeSync, linkSync,
} from 'node:fs';
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

function buildLockPayload(projectRoot, subcommand) {
  return {
    schema: 1,
    pid: process.pid,
    start_time: new Date().toISOString(),
    subcommand,
    project_root: projectRoot,
    version: readVersion(),
  };
}

// Public overwrite-style write. Kept overwrite-semantics on purpose: it is
// re-exported through cli.js and exercised directly by cli.test.js + the
// Pester concurrency suite. Exclusive acquisition lives in acquireLock via
// writeLockfileExclusive below.
function writeLockfile(projectRoot, subcommand) {
  const lock = buildLockPayload(projectRoot, subcommand);
  writeFileSync(lockfilePath(projectRoot), JSON.stringify(lock, null, 2), 'utf8');
  return lock;
}

// Atomic create-if-absent write WITH full content. Strategy: write the
// payload to a private tmp file, then hard-link it to the lock path —
// link(2) fails with EEXIST when the lock exists, and on success the lock
// appears with its COMPLETE content in one atomic step.
//
// Why not openSync('wx') + writeSync: that creates an EMPTY file first and
// fills it after — a concurrent loser that hits EEXIST can read the lock in
// that window, see unparseable (empty) JSON, and "reclaim" the winner's
// fresh lock. The 2-process race test caught exactly this on the macOS CI
// runner. Filesystems without hard links (some network mounts / exFAT) fall
// back to the 'wx' path; the invalid-grace re-read in acquireLock covers
// the residual window there.
function writeLockfileExclusive(projectRoot, subcommand) {
  const lock = buildLockPayload(projectRoot, subcommand);
  const payload = JSON.stringify(lock, null, 2);
  const lockPath = lockfilePath(projectRoot);
  const tmp = `${lockPath}.tmp.${process.pid}`;
  writeFileSync(tmp, payload, 'utf8');
  try {
    try {
      linkSync(tmp, lockPath);
      return lock;
    } catch (e) {
      if (e && e.code === 'EEXIST') throw e;
      // No hard-link support on this filesystem — exclusive create + write.
      const fd = openSync(lockPath, 'wx');
      try { writeSync(fd, payload); } finally { closeSync(fd); }
      return lock;
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* best-effort */ }
  }
}

// Synchronous sleep — Atomics.wait is the only non-spinning sync wait in
// Node. Used for the invalid-lock grace re-read below.
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* SAB unavailable → proceed without waiting */ }
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
  // Up to 3 acquisition rounds: exclusive create → on EEXIST evaluate the
  // existing lock → (stale/invalid) unlink + retry the exclusive create.
  // The bounded loop makes the loser of a reclaim race safe: when two
  // processes both saw the same stale lock and both unlinked, only one wins
  // the next exclusive create — the other re-reads the winner's fresh lock
  // and reports lock_held instead of clobbering it (pre-fix TOCTOU).
  let reclaimed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ourLock = writeLockfileExclusive(projectRoot, subcommand);
      // `reclaimed` only when a stale lock (dead PID or time-stale) was
      // displaced. An unparseable lockfile claims silently — same contract
      // as the pre-exclusive implementation.
      return reclaimed ? { ok: true, reclaimed: true, ourLock } : { ok: true, ourLock };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        return { ok: false, reason: 'write_error', error };
      }
    }

    // Exclusive create lost — somebody holds (or held) the lock.
    const existing = readLockfile(projectRoot);
    if (existing === null) {
      // Owner released between our create attempt and the read — retry.
      continue;
    }

    if (!existing.invalid) {
      const alive = isPidAlive(existing.pid);
      const staleByTime = isLockfileStaleByTime(existing);
      if (alive && !staleByTime) {
        if (!force) return { ok: false, reason: 'lock_held', existing };
        // --force displaces a LIVE lock. Inherently racy by contract (the
        // previous process is still running); overwrite-style write keeps
        // the historical --force behavior.
        try {
          const ourLock = writeLockfile(projectRoot, subcommand);
          return { ok: true, forced: true, ourLock, existing };
        } catch (error) {
          return { ok: false, reason: 'write_error', error };
        }
      }
      // Stale: dead PID, or time-stale (boot-time / STALE_THRESHOLD_MS —
      // recycled-PID guard). Reclaim below.
      reclaimed = true;
    } else {
      // Unparseable can be a concurrent writer caught mid-write on the
      // no-hardlink fallback path (or a --force overwrite in flight) rather
      // than a crashed writer's garbage. Give it one grace re-read before
      // reclaiming; if a valid lock materialized, re-evaluate it next round
      // instead of destroying it.
      sleepMs(25);
      const reread = readLockfile(projectRoot);
      if (reread && !reread.invalid) continue;
    }

    // Stale or unparseable → remove and retry the exclusive create. Unlink
    // failure (e.g. a racing reclaimer already removed it) is fine — the
    // next round re-evaluates whatever is on disk.
    try { unlinkSync(lockfilePath(projectRoot)); } catch { /* re-evaluated next round */ }
  }

  // Three rounds without a clean acquire — a fast-cycling peer keeps winning
  // the create race. Report held with whatever is currently on disk.
  return { ok: false, reason: 'lock_held', existing: readLockfile(projectRoot) || { invalid: true } };
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

// SPDX-License-Identifier: MIT
// lib/project/artifact-sweep.js — TTL lifecycle sweep + manual-clean engine
// for the <projectRoot>/.kmp-test-runner artifact tree, plus the Windows
// rename-retry helper shared by the cache writers.
//
// Policy:
//  * mtime-TTL only — per-run directory NAMES are never parsed (their runId
//    formats differ per orchestrator: coverage `YYYYMMDD-HHMMSS-PID`,
//    android/benchmark/isolated `Date.now()-pid`).
//  * Two tiers:
//      - disposables (fixed 24h TTL): cache-isolated/<runId>/ (gradle
//        --project-cache-dir trees orphaned by Ctrl-C'd runs), init-scripts/*,
//        cache/*.tmp.* (failed atomic-rename leftovers). 24h sits comfortably
//        above lockfile.js's 4h STALE_THRESHOLD_MS — the documented upper
//        bound for any legitimate run — so a live run's dirs are never swept.
//      - per-run logs (configurable TTL, default 7 days): logs/<sub>/<runId>/.
//  * NEVER auto-swept: cache/ model+tasks entries (valuable across runs),
//    reports/ (user deliverables), the root lockfile (concurrency key), and
//    .kmp-test-runner.json (user input). `kmp-test clean --all` purges the
//    first two explicitly.
//  * The auto-sweep runs AFTER acquireLock succeeds (never concurrently with
//    another run against the same project) and is best-effort — it never
//    throws and never changes exit codes.
//  * Config: `cleanup: { auto: bool, logsTtlDays: number }` (project-local +
//    user-global); env KMP_TEST_NO_SWEEP=1 is a hard opt-out.

import {
  existsSync, readdirSync, statSync, rmSync, renameSync, unlinkSync,
} from 'node:fs';
import path from 'node:path';

export const DISPOSABLE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LOGS_TTL_DAYS = 7;

function listDir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function mtimeMs(p) {
  try { return statSync(p).mtimeMs; } catch { return null; }
}

// Best-effort recursive byte count (for `clean` reporting only).
function dirSize(p) {
  let st;
  try { st = statSync(p); } catch { return 0; }
  if (st.isFile()) return st.size;
  let total = 0;
  for (const e of listDir(p)) total += dirSize(path.join(p, e.name));
  return total;
}

// Resolve the effective cleanup policy from a merged config object.
// env KMP_TEST_NO_SWEEP=1 hard-disables auto regardless of config.
export function resolveCleanupConfig(config, env = process.env) {
  const c = (config && typeof config.cleanup === 'object' && !Array.isArray(config.cleanup))
    ? config.cleanup
    : {};
  const auto = (env && env.KMP_TEST_NO_SWEEP === '1') ? false : (c.auto !== false);
  const days = Number(c.logsTtlDays);
  const logsTtlDays = (Number.isFinite(days) && days > 0) ? days : DEFAULT_LOGS_TTL_DAYS;
  return { auto, logsTtlDays };
}

function collectSweepCandidates(projectRoot, { now, logsTtlDays }) {
  const root = path.join(projectRoot, '.kmp-test-runner');
  if (!existsSync(root)) return [];
  const out = [];
  const stale = (p, ttl) => {
    const m = mtimeMs(p);
    return m !== null && (now - m) > ttl;
  };

  for (const e of listDir(path.join(root, 'cache-isolated'))) {
    const p = path.join(root, 'cache-isolated', e.name);
    if (stale(p, DISPOSABLE_TTL_MS)) out.push(p);
  }
  for (const e of listDir(path.join(root, 'init-scripts'))) {
    const p = path.join(root, 'init-scripts', e.name);
    if (stale(p, DISPOSABLE_TTL_MS)) out.push(p);
  }
  for (const e of listDir(path.join(root, 'cache'))) {
    if (!e.name.includes('.tmp.')) continue;
    const p = path.join(root, 'cache', e.name);
    if (stale(p, DISPOSABLE_TTL_MS)) out.push(p);
  }

  const ttlMs = logsTtlDays * 24 * 60 * 60 * 1000;
  const logsRoot = path.join(root, 'logs');
  for (const sub of listDir(logsRoot)) {
    if (!sub.isDirectory()) continue;
    for (const run of listDir(path.join(logsRoot, sub.name))) {
      const p = path.join(logsRoot, sub.name, run.name);
      if (stale(p, ttlMs)) out.push(p);
    }
  }
  return out;
}

/**
 * TTL sweep of stale artifacts under `<projectRoot>/.kmp-test-runner`.
 * Best-effort per entry — never throws.
 * @param {string} projectRoot
 * @param {{now?: number, logsTtlDays?: number}} [opts]
 * @returns {{removed: string[]}}
 */
export function sweepArtifacts(projectRoot, { now = Date.now(), logsTtlDays = DEFAULT_LOGS_TTL_DAYS } = {}) {
  const removed = [];
  for (const p of collectSweepCandidates(projectRoot, { now, logsTtlDays })) {
    try {
      rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch { /* best-effort — locked entries are retried by a future sweep */ }
  }
  return { removed };
}

// Manual `kmp-test clean` target collector. Unlike the TTL sweep, clean
// targets ALL run artifacts regardless of age. `--all` additionally purges
// the model/tasks cache and reports/. The lockfile and .kmp-test-runner.json
// are never targets.
export function collectCleanTargets(projectRoot, { all = false } = {}) {
  const root = path.join(projectRoot, '.kmp-test-runner');
  const out = [];
  for (const name of ['logs', 'cache-isolated', 'init-scripts']) {
    const p = path.join(root, name);
    if (existsSync(p)) out.push(p);
  }
  if (all) {
    for (const name of ['cache', 'reports']) {
      const p = path.join(root, name);
      if (existsSync(p)) out.push(p);
    }
  } else {
    // tmp leftovers inside cache/ are run debris even without --all.
    for (const e of listDir(path.join(root, 'cache'))) {
      if (e.name.includes('.tmp.')) out.push(path.join(root, 'cache', e.name));
    }
  }
  return out;
}

/**
 * Execute (or plan, with dryRun) a manual clean.
 * @param {string} projectRoot
 * @param {{all?: boolean, dryRun?: boolean}} [opts]
 * @returns {{targets: Array<{path: string, bytes: number}>, removed: string[],
 *            failed: Array<{path: string, error: string|null}>, bytesFreed: number}}
 */
export function cleanArtifacts(projectRoot, { all = false, dryRun = false } = {}) {
  const targets = collectCleanTargets(projectRoot, { all })
    .map((p) => ({ path: p, bytes: dirSize(p) }));
  const removed = [];
  const failed = [];
  let bytesFreed = 0;
  if (!dryRun) {
    for (const t of targets) {
      try {
        rmSync(t.path, { recursive: true, force: true });
        removed.push(t.path);
        bytesFreed += t.bytes;
      } catch (e) {
        failed.push({ path: t.path, error: (e && e.message) || null });
      }
    }
  }
  return { targets, removed, failed, bytesFreed };
}

/**
 * tmp+rename atomic-write completion with a bounded Windows retry. Antivirus
 * or an IDE briefly holding the destination makes renameSync throw
 * EPERM/EBUSY; a short retry absorbs it. On final failure the tmp file is
 * unlinked so failed persists stop accumulating `*.tmp.<pid>` orphans (the
 * sweep also collects any that survive a crash).
 * @param {string} tmp - temp file path (already written + closed)
 * @param {string} dest - final path
 * @param {{rename?: Function, delays?: number[]}} [opts] - injectable for tests
 * @returns {boolean} true when dest was written
 */
export function renameWithRetrySync(tmp, dest, { rename = renameSync, delays = [50, 100, 200] } = {}) {
  for (let i = 0; i <= delays.length; i++) {
    try {
      rename(tmp, dest);
      return true;
    } catch (e) {
      const retriable = e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES');
      if (!retriable || i === delays.length) break;
      // Atomics.wait is the only non-spinning synchronous wait in Node.
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[i]);
      } catch { /* SAB unavailable → retry immediately */ }
    }
  }
  try { unlinkSync(tmp); } catch { /* best-effort */ }
  return false;
}

#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/materialize.mjs -- fresh, os.tmpdir()-rooted materialization for every
// fixture kind this harness uses (Round 3 fix #1, Round 4 fix #9, Round 6 finding on
// symlink/wrapper resolution). Nothing under this module ever runs a measured session with a
// cwd inside this repo or any repo/config-ancestor tree -- every fixture is copied/checked out
// into a fresh temp directory immediately before use.
import { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync, appendFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, isAbsolute, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveBash } from './resolve-bash.mjs';
import { isWithinOrEqualCanonical } from './policy-hook.mjs';

// Windows-native tool resolution of `tar`/`git archive` piping mangles backslash-heavy paths
// passed via a plain argv array (confirmed empirically -- a destination path's digits were
// corrupted mid-string even though the source JS string was correct). The proven workaround,
// already required for `claude`/`gradlew` invocation elsewhere in this harness, is to route
// through `bash -c` with POSIX-style paths and careful single-quote escaping.
function toPosixPath(winPath) {
  return winPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
}
const shQuote = (arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`;

// Backslash-to-forward-slash + lowercase ONLY -- distinct from toPosixPath (which additionally
// rewrites `C:/...` to bash's `/c/...` mount-point form, for passing paths INTO a git/bash command
// line). `git worktree list --porcelain` reports paths in `C:/Users/...` form (drive letter kept,
// forward slashes) -- comparing against that output needs THIS normalization, not toPosixPath's.
function normalizeForComparison(p) {
  return String(p).replace(/\\/g, '/').toLowerCase();
}

// Every git invocation in this module is centralized through this one builder so
// `-c core.longpaths=true` -- scoped to the single git subprocess call via git's own `-c` flag,
// never touching process.env or any config file at system/global/local scope -- is never missed at
// a call site. Confirmed empirically (2026-08-10 canary incident): Git for Windows with
// core.longpaths unset fails deep, reused-worktree operations (git clean, git worktree remove) with
// "Filename too long" well under Windows' own MAX_PATH, once a live session's Gradle/Hilt/Kotlin
// build output has accumulated past ~260 characters of relative path depth.
function buildLongpathsGitCommand(argv) {
  return `git -c core.longpaths=true ${argv.map(shQuote).join(' ')}`;
}

// A CI checkout (or any shallow clone of this repo) only has the tip commit's tree locally --
// `git archive <ancestor-sha>` fails with "not a tree object" even for a perfectly valid,
// reachable SHA. GitHub allows fetching an arbitrary reachable commit by SHA directly, so
// self-heal by backfilling just that one commit before archiving, rather than requiring every
// caller (CI included) to carry a full, unshallowed clone just for this.
function isCommitAvailable(repoRoot, sha) {
  const r = spawnSync(resolveBash(), ['-c', buildLongpathsGitCommand(['cat-file', '-e', `${sha}^{commit}`])], { cwd: repoRoot, encoding: 'utf8' });
  return r.status === 0;
}

const PLAUSIBLE_SHA_RE = /^[0-9a-f]{7,40}$/i;

// Used only in error-path (acquisition-failure) cleanup, never in normal operation. A bare rmSync
// there risks two compounding failures: if it throws (a transient Windows file lock is a real,
// reproducible cause on this platform), it MASKS the original acquisition error that triggered
// the cleanup in the first place, AND -- when a catch block has more than one cleanup step, e.g.
// materializeGradleUserHome's own two temp directories -- stops every step queued after it from
// ever running. Swallowing this one's own failure means every queued step still gets attempted,
// and the original `err` a caller already has in scope is always what gets rethrown.
function bestEffortRemove(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch { /* best-effort: the original acquisition error is what matters, not this */ }
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* SAB unavailable -> retry immediately */ }
}

function resolveGitCommonDir(repoRoot) {
  const r = spawnSync(resolveBash(), ['-c', buildLongpathsGitCommand(['rev-parse', '--git-common-dir'])], { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) return join(repoRoot, '.git');
  const commonDir = r.stdout.trim();
  return isAbsolute(commonDir) ? commonDir : resolve(repoRoot, commonDir);
}

function acquireGitFetchLock(repoRoot) {
  const lockDir = join(resolveGitCommonDir(repoRoot), 'kmp-agentic-eval-fetch.lock');
  const started = Date.now();
  let attempt = 0;
  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner.txt'), `${process.pid}\n${new Date().toISOString()}\n`);
      return () => bestEffortRemove(lockDir);
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockDir).mtimeMs > 5 * 60 * 1000;
      } catch { /* if stat fails, just keep waiting */ }
      if (stale) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        } catch { /* another process may have won the race */ }
      }
      if (Date.now() - started > 120_000) {
        throw new Error(`timed out waiting for git shallow-fetch lock: ${lockDir}`);
      }
      sleepSync(Math.min(50 + attempt * 25, 250));
      attempt += 1;
    }
  }
}

/**
 * Bounded-retry `rmSync` with a VERIFIED postcondition -- modeled directly on
 * `lib/project/artifact-sweep.js`'s `renameWithRetrySync` (the one existing retry idiom in this
 * codebase): retry on the Windows-transient error codes, backing off via `Atomics.wait` (the only
 * non-spinning synchronous wait Node offers), bounded by `delays.length`. Deliberately NOT used by
 * `bestEffortRemove` (acquisition-rollback only, which must keep swallowing its own failure
 * unconditionally so one failed cleanup step never masks the ORIGINAL error or blocks a sibling
 * step queued after it -- see `agentic-eval-materialize-best-effort-cleanup.test.js`'s own
 * regression coverage for that distinct property). This is for the opposite case: callers that
 * need to know, for certain, that a directory is actually gone -- never silently reports success
 * when it can't confirm removal.
 * @param {string} path
 * @param {{delays?: number[], rmFn?: Function, existsFn?: Function}} [opts] - injectable for tests
 */
export function removeDirRobust(path, { delays = [50, 100, 200, 400], rmFn = rmSync, existsFn = existsSync } = {}) {
  let lastErr = null;
  for (let i = 0; i <= delays.length; i++) {
    try {
      rmFn(path, { recursive: true, force: true });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const retriable = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
      if (!retriable || i === delays.length) break;
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[i]);
      } catch { /* SAB unavailable -> retry immediately */ }
    }
  }
  if (lastErr) throw lastErr;
  if (existsFn(path)) {
    throw new Error(`removeDirRobust: ${path} still exists after removal attempt(s) -- postcondition failed`);
  }
}

function ensureCommitAvailable(repoRoot, sha) {
  if (isCommitAvailable(repoRoot, sha)) return;
  // Not hex-shaped -- definitely not a real commit; let `git archive` report it directly rather
  // than spending a network round-trip on input that can never resolve.
  if (!PLAUSIBLE_SHA_RE.test(sha)) return;
  const releaseFetchLock = acquireGitFetchLock(repoRoot);
  try {
    if (isCommitAvailable(repoRoot, sha)) return;
    const r = spawnSync(resolveBash(), ['-c', buildLongpathsGitCommand(['fetch', '--depth', '1', 'origin', sha])], { cwd: repoRoot, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`commit ${sha} not present locally (shallow clone?) and could not be fetched from origin (exit ${r.status}): ${r.stderr}`);
    }
  } finally {
    releaseFetchLock();
  }
}

/**
 * git-archive the skill snapshot at a pinned SHA into a fresh temp dir, then validate it with
 * tools/validate-plugin.mjs's own runValidator -- fail-closed if validation doesn't pass.
 * @param {{repoRoot: string, sha: string, validateFn: Function}} opts
 */
export async function materializeSkillSnapshot({ repoRoot, sha, validateFn }) {
  const dest = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-skill-'));
  // Everything after mkdtempSync is wrapped so a failure at ANY step (missing commit, archive
  // failure, validation failure) still removes `dest` before rethrowing -- previously a
  // validation failure specifically left the temp directory behind forever, since nothing
  // downstream of this function's own return value ever gets a chance to clean it up (the
  // caller's cleanup() handle doesn't exist yet if THIS call is what throws).
  try {
    ensureCommitAvailable(repoRoot, sha);
    const archiveCmd = buildLongpathsGitCommand(['archive', sha, '--', '.claude-plugin', '.skills']);
    const cmd = `${archiveCmd} | tar -x -C ${shQuote(toPosixPath(dest))}`;
    const r = spawnSync(resolveBash(), ['-c', cmd], { cwd: repoRoot, encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`git archive | tar extraction failed (exit ${r.status}): ${r.stderr}`);
    }
    const result = await validateFn({ repoRoot: dest });
    if (!result.ok) {
      throw new Error(`Skill snapshot at ${sha} failed validation: ${result.summary}`);
    }
    return { snapshotDir: dest, validation: result };
  } catch (err) {
    bestEffortRemove(dest);
    throw err;
  }
}

/**
 * Copy the committed calibration-project template into a fresh temp dir. Reset (for the second
 * condition of a run-pair) means: delete and recopy from the SAME pristine template, never
 * mutate in place. mkdirSync+cpSync are wrapped so a failure partway through (cpSync throwing on
 * a disk-full/permission error) removes the just-created `dest` before rethrowing, rather than
 * leaving an empty or partially-copied directory behind -- confirmed as a real leak (a genuine
 * kmp-agentic-eval-calibration-* directory survived a forced cpSync failure) before this fix.
 * @param {{templateDir: string, existingDir?: string}} opts
 */
export function materializeCalibrationProject({ templateDir, existingDir }) {
  const dest = existingDir ?? mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-calibration-'));
  if (existingDir) rmSync(existingDir, { recursive: true, force: true });
  try {
    mkdirSync(dest, { recursive: true });
    cpSync(templateDir, dest, { recursive: true });
  } catch (err) {
    bestEffortRemove(dest);
    throw err;
  }
  return { fixtureDir: dest };
}

function runGitViaBash(argv, cwd) {
  const r = spawnSync(resolveBash(), ['-c', buildLongpathsGitCommand(argv)], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout;
}

/** True when `worktreeDirReal` still appears as a `worktree <path>` line in
 * `git worktree list --porcelain` -- the second of removeScenarioWorktree's two postconditions.
 * Path separators/casing normalized on both sides (git reports `C:/Users/...` form). */
function isWorktreeStillRegistered(sourceRepoDir, worktreeDirReal) {
  const list = runGitViaBash(['worktree', 'list', '--porcelain'], sourceRepoDir);
  const target = normalizeForComparison(worktreeDirReal);
  return list
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => normalizeForComparison(line.slice('worktree '.length).trim()) === target);
}

/**
 * Resolves the canonical (symlink-free) form of `p`, even when `p` itself no longer exists on
 * disk. `realpathSync` fundamentally cannot resolve a missing path -- but a MISSING leaf doesn't
 * mean nothing above it can be resolved: this walks up to the nearest EXISTING ancestor,
 * `realpathSync`s that, and rejoins the missing suffix on top of the now-canonical prefix.
 *
 * Post-Codex-audit fix (PR #418, round 3): the pre-fix version simply fell back to the raw,
 * UNRESOLVED `p` whenever `realpathSync(p)` threw (the common case -- the directory this function
 * exists to check on has usually just been deleted). Under a symlinked ancestor -- e.g. macOS's
 * `/var` -> `/private/var` (`os.tmpdir()` returns the `/var/...` form; git records the resolved
 * `/private/var/...` form at `worktree add` time) -- that raw, unresolved path can NEVER textually
 * match what `git worktree list --porcelain` reports, so `isWorktreeStillRegistered`'s comparison
 * always misses a genuinely-still-registered stale entry, and `removeScenarioWorktree` silently
 * reports its postconditions as met when one of them (the git-registration one) actually isn't.
 * Reproduced directly on POSIX via a real symlinked ancestor (see
 * agentic-eval-materialize-worktree-rollback.test.js's own discriminating test).
 */
export function resolveCanonicalEvenIfMissing(p) {
  try {
    return realpathSync(p);
  } catch {
    // fall through to the walk-up below
  }
  let dir = dirname(p);
  let suffix = basename(p);
  for (;;) {
    try {
      return join(realpathSync(dir), suffix);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return p; // hit the filesystem root without finding an existing ancestor -- give up, use the raw path
      suffix = join(basename(dir), suffix);
      dir = parent;
    }
  }
}

/**
 * Removes a disposable git worktree created by materializeScenarioProject. Two INDEPENDENTLY
 * verified postconditions -- the directory is actually gone (via removeDirRobust, always
 * attempted regardless of whether `git worktree remove` itself succeeded), AND the worktree no
 * longer appears in `git worktree list` -- because either one alone can be misleading: a
 * directory being gone does not by itself prove git's own .git/worktrees/ metadata was cleared
 * (a "leftover worktree" -- confirmed via `git worktree list` after a run that skipped this), and
 * `git worktree remove` reporting success does not by itself prove the directory content is
 * actually gone. The canonical (real) path is captured BEFORE any deletion is attempted, via
 * resolveCanonicalEvenIfMissing() (see its own doc comment for why a plain realpathSync-or-raw-
 * fallback isn't enough).
 *
 * The two known-benign `git worktree remove` outcomes ("is not a working tree" / "not a valid
 * path" -- the worktree was already deregistered or never existed) are tolerated; any OTHER git
 * failure no longer short-circuits the directory-removal attempt the way it used to (today's bug:
 * `git worktree remove` throwing skipped the trailing `rmSync` entirely, a real, confirmed
 * mechanism behind an orphaned scenario-worktree directory during the 2026-08-10 canary incident).
 * If either postcondition still fails after both removal attempts, this throws a single combined,
 * informative error -- never silently swallowed.
 */
export function removeScenarioWorktree({ sourceRepoDir, worktreeDir }) {
  const worktreeDirReal = resolveCanonicalEvenIfMissing(worktreeDir);

  let gitRemoveError = null;
  try {
    runGitViaBash(['worktree', 'remove', '--force', toPosixPath(worktreeDir)], sourceRepoDir);
  } catch (err) {
    if (!/is not a working tree|not a valid path/i.test(err.message)) {
      gitRemoveError = err;
    }
  }

  let dirRemoveError = null;
  try {
    removeDirRobust(worktreeDir);
  } catch (err) {
    dirRemoveError = err;
  }

  const stillRegistered = isWorktreeStillRegistered(sourceRepoDir, worktreeDirReal);
  // gitRemoveError is part of this check even though the two POSTCONDITIONS alone might already
  // look satisfied (e.g. a concurrent `git worktree prune` cleared the registration despite this
  // call's own `git worktree remove` genuinely failing) -- a real git-level anomaly is diagnostic
  // signal worth surfacing regardless of the end state, never silently discarded just because
  // things happened to work out.
  if (!dirRemoveError && !stillRegistered && !gitRemoveError) return; // fully verified, no anomaly

  const parts = [];
  if (dirRemoveError) parts.push(`directory removal failed: ${dirRemoveError.message}`);
  if (stillRegistered) parts.push(`still registered in 'git worktree list' after removal attempt`);
  if (gitRemoveError) parts.push(`git worktree remove itself also failed: ${gitRemoveError.message}`);
  throw new Error(`removeScenarioWorktree: postconditions not met for ${worktreeDirReal} -- ${parts.join('; ')}`);
}

/**
 * Materialize a real scenario project via a disposable git worktree off a pinned commit,
 * landed under os.tmpdir(). Reset (before the second condition of a run-pair) is a fast
 * `git clean -fdx && git reset --hard <pinnedCommit>` inside that same worktree -- no re-clone.
 * @param {{sourceRepoDir: string, pinnedCommit: string, existingWorktreeDir?: string}} opts
 */
export function materializeScenarioProject({ sourceRepoDir, pinnedCommit, existingWorktreeDir }) {
  if (existingWorktreeDir) {
    runGitViaBash(['clean', '-fdx'], existingWorktreeDir);
    runGitViaBash(['reset', '--hard', pinnedCommit], existingWorktreeDir);
    return { fixtureDir: existingWorktreeDir };
  }
  const dest = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-scenario-'));
  rmSync(dest, { recursive: true, force: true }); // git worktree add requires the target not exist
  // `git worktree add` can leave partial state registered (or a partially-populated directory)
  // if it fails partway through -- clean up via the same removeScenarioWorktree() path a
  // successful worktree's own teardown uses, before rethrowing the ORIGINAL error. The rollback's
  // own failure (if any) is attached (never discarded) so it's visible to whatever eventually
  // logs/reports `err` -- previously a bare `catch {}` here discarded it unconditionally, making a
  // failed rollback of real partial state indistinguishable from "nothing needed cleaning up" (a
  // confirmed, real cause of an orphaned scenario-worktree temp directory).
  try {
    runGitViaBash(['worktree', 'add', '--detach', toPosixPath(dest), pinnedCommit], sourceRepoDir);
  } catch (err) {
    try {
      removeScenarioWorktree({ sourceRepoDir, worktreeDir: dest });
    } catch (rollbackErr) {
      err.rollbackError = rollbackErr;
    }
    throw err;
  }
  return { fixtureDir: dest };
}

/**
 * Creates a temp GRADLE_USER_HOME, snapshots it, and provides a resetToSnapshot() that restores
 * the exact same state -- both conditions of a run-pair always start from byte-identical cache
 * state, whatever that state is. Also writes a gradle.properties disabling the daemon inside the
 * temp GRADLE_USER_HOME itself, so the policy applies regardless of which gradle-invoking
 * command the agent types.
 *
 * seedFromDir is OPTIONAL. When present, it is copied into the fresh GRADLE_USER_HOME before
 * runPrewarm runs, so offline/restricted-network evaluations can start from a VM-prewarmed cache
 * while still snapshotting a temp, run-owned directory. runPrewarm is also OPTIONAL. Without it,
 * the "snapshot" is of the seeded or otherwise-empty directory plus gradle.properties. With it,
 * the caller's writes are captured in the snapshot before it's taken. The isolation guarantee
 * (byte-identical reset between conditions) holds either way.
 * @param {{runPrewarm?: (gradleUserHome: string) => void, seedFromDir?: string | null}} [opts]
 */
export function materializeGradleUserHome({ runPrewarm, seedFromDir = null } = {}) {
  const gradleUserHome = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-gradle-'));
  let snapshotDir;
  try {
    if (seedFromDir) {
      const seedStat = statSync(seedFromDir);
      if (!seedStat.isDirectory()) {
        throw new Error(`GRADLE_USER_HOME seed is not a directory: ${seedFromDir}`);
      }
      cpSync(seedFromDir, gradleUserHome, { recursive: true });
    }
    writeFileSync(join(gradleUserHome, 'gradle.properties'), 'org.gradle.daemon=false\n');
    snapshotDir = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-gradle-snapshot-'));
    if (runPrewarm) runPrewarm(gradleUserHome);
    rmSync(snapshotDir, { recursive: true, force: true });
    cpSync(gradleUserHome, snapshotDir, { recursive: true });
  } catch (err) {
    // Whichever of the two temp directories got created before the failure -- writeFileSync,
    // runPrewarm, or cpSync can each throw partway through -- must not survive it. Each removal
    // is independently best-effort so ONE of them failing (e.g. gradleUserHome locked by a
    // still-exiting child process) never skips the other.
    bestEffortRemove(gradleUserHome);
    if (snapshotDir) bestEffortRemove(snapshotDir);
    throw err;
  }

  function resetToSnapshot() {
    rmSync(gradleUserHome, { recursive: true, force: true });
    mkdirSync(gradleUserHome, { recursive: true });
    cpSync(snapshotDir, gradleUserHome, { recursive: true });
  }

  return { gradleUserHome, snapshotDir, resetToSnapshot, daemonPolicy: 'disabled-via-gradle-user-home-properties' };
}

/** Resolve a path via the real filesystem (symlinks/junctions followed) -- never lexical. */
export function realpath(p) {
  return realpathSync(p);
}

export function resolveParentDir(p) {
  return dirname(p);
}

// applyFixtureSetup -- the changed-module-verification scenario's own pre-run working-tree
// mutation (schemas.mjs's `fixture_setup` contract). The mutation content is ALWAYS this one
// harness-owned constant, never scenario-supplied text -- a scenario only ever names WHICH
// tracked file to mutate and what its pre-mutation blob must be.
export const FIXTURE_SETUP_APPEND_COMMENT = '\n// kmp-agentic-eval-fixture-marker\n';

/** Parses one `git ls-files -s -- <path>` line (`<mode> <blob> <stage>\t<path>`) into
 * `{mode, blob, path}`, or `null` if the pathspec matched zero (not tracked) or more than one
 * (e.g. a directory) entry -- both cases collapse to the identical "not a single tracked file"
 * outcome for this function's caller. */
function parseLsFilesShortEntry(output) {
  const trimmed = String(output ?? '').trim();
  if (trimmed === '') return null;
  const m = /^(\d+) ([0-9a-f]{40}) \d+\t(.+)$/.exec(trimmed);
  if (!m) return null;
  return { mode: m[1], blob: m[2], path: m[3] };
}

/** Pure postcondition check, directly unit-testable with synthetic `git status --porcelain`
 * text: true only when the ENTIRE output is exactly one line, an UNSTAGED modification (` M `,
 * index clean / worktree dirty -- never staged, never untracked, never any other status pair), at
 * exactly `relativePath`. */
export function isExactlyOneUnstagedModificationAt(porcelainOutput, relativePath) {
  const lines = String(porcelainOutput ?? '').split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length !== 1) return false;
  const line = lines[0];
  if (!line.startsWith(' M ')) return false;
  return line.slice(3) === relativePath;
}

/**
 * Applies (or re-applies, on a freshly-reset worktree) a scenario's `fixture_setup` mutation --
 * called from matrix-runner.mjs's runSingleCondition, immediately after materializeFixture's own
 * clean/reset and before spawnCondition. Because materializeFixture always yields a byte-for-byte
 * pristine tree first, re-running this on every repetition x condition is naturally idempotent --
 * no undo logic needed, and every cell reproduces an identical diff.
 * @param {{fixtureDir: string, fixtureSetup: {operation: string, relative_path: string, expected_blob_oid: string}}} opts
 */
export function applyFixtureSetup({ fixtureDir, fixtureSetup }) {
  // Fail closed BEFORE any git/file I/O -- never trust that the caller already validated this
  // against schemas.mjs's own closed FIXTURE_SETUP_OPERATION_VALUES enum (a post-open-PR review
  // found this exact gap: the enum currently closes to exactly one value, but this exported
  // primitive itself never re-checked it, so a future second enum value -- or any caller bypassing
  // schema validation -- would silently fall through to the append_comment mutation below no matter
  // what `operation` actually said).
  if (fixtureSetup.operation !== 'append_comment') {
    throw new Error(`fixture_setup.operation not supported by this harness: ${fixtureSetup.operation}`);
  }

  const statusBefore = runGitViaBash(['status', '--porcelain'], fixtureDir);
  if (statusBefore.trim() !== '') {
    throw new Error(`fixture_setup precondition failed: working tree not clean before mutation:\n${statusBefore}`);
  }

  const relativePath = fixtureSetup.relative_path;
  const lsFilesOut = runGitViaBash(['ls-files', '-s', '--', relativePath], fixtureDir);
  const entry = parseLsFilesShortEntry(lsFilesOut);
  // entry.path !== relativePath closes a real gap: a DIRECTORY-shaped pathspec that happens to
  // contain exactly one file underneath it also produces exactly one ls-files line -- but for a
  // DIFFERENT path than what was actually requested. Without this check, that file's own mode/blob
  // would be validated (potentially passing), while the mutation below still tries to write to the
  // ORIGINAL (directory) path, crashing with EISDIR instead of failing closed with a clear reason.
  if (entry == null || entry.path !== relativePath) {
    throw new Error(`fixture_setup target is not a single tracked file at the exact path: ${relativePath}`);
  }
  if (entry.mode !== '100644' && entry.mode !== '100755') {
    throw new Error(`fixture_setup target is not a regular file (git mode ${entry.mode}): ${relativePath}`);
  }
  if (entry.blob !== fixtureSetup.expected_blob_oid) {
    throw new Error(`fixture_setup blob mismatch at ${relativePath}: expected ${fixtureSetup.expected_blob_oid}, got ${entry.blob}`);
  }

  // Defense in depth -- never trust the already-schema-validated relative_path string alone.
  // Reuses policy-hook.mjs's own isWithinOrEqualCanonical rather than a second, independently-
  // maintained containment check.
  const absPath = join(fixtureDir, ...relativePath.split('/'));
  let absPathReal;
  try {
    absPathReal = realpathSync(absPath);
  } catch {
    throw new Error(`fixture_setup target does not exist on disk: ${relativePath}`);
  }
  const fixtureDirReal = realpathSync(fixtureDir);
  if (!isWithinOrEqualCanonical(fixtureDirReal, absPathReal)) {
    throw new Error(`fixture_setup target resolves outside the fixture root: ${relativePath}`);
  }

  appendFileSync(absPath, FIXTURE_SETUP_APPEND_COMMENT);

  const statusAfter = runGitViaBash(['status', '--porcelain'], fixtureDir);
  if (!isExactlyOneUnstagedModificationAt(statusAfter, relativePath)) {
    throw new Error(`fixture_setup postcondition failed: expected exactly one unstaged modification at ${relativePath}, got:\n${statusAfter}`);
  }
}

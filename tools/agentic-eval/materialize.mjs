#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/materialize.mjs -- fresh, os.tmpdir()-rooted materialization for every
// fixture kind this harness uses (Round 3 fix #1, Round 4 fix #9, Round 6 finding on
// symlink/wrapper resolution). Nothing under this module ever runs a measured session with a
// cwd inside this repo or any repo/config-ancestor tree -- every fixture is copied/checked out
// into a fresh temp directory immediately before use.
import { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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

// A CI checkout (or any shallow clone of this repo) only has the tip commit's tree locally --
// `git archive <ancestor-sha>` fails with "not a tree object" even for a perfectly valid,
// reachable SHA. GitHub allows fetching an arbitrary reachable commit by SHA directly, so
// self-heal by backfilling just that one commit before archiving, rather than requiring every
// caller (CI included) to carry a full, unshallowed clone just for this.
function isCommitAvailable(repoRoot, sha) {
  const r = spawnSync(resolveBash(), ['-c', `git cat-file -e ${shQuote(sha)}^{commit}`], { cwd: repoRoot, encoding: 'utf8' });
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

function ensureCommitAvailable(repoRoot, sha) {
  if (isCommitAvailable(repoRoot, sha)) return;
  // Not hex-shaped -- definitely not a real commit; let `git archive` report it directly rather
  // than spending a network round-trip on input that can never resolve.
  if (!PLAUSIBLE_SHA_RE.test(sha)) return;
  const r = spawnSync(resolveBash(), ['-c', `git fetch --depth 1 origin ${shQuote(sha)}`], { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`commit ${sha} not present locally (shallow clone?) and could not be fetched from origin (exit ${r.status}): ${r.stderr}`);
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
    const cmd = `git archive ${shQuote(sha)} -- .claude-plugin .skills | tar -x -C ${shQuote(toPosixPath(dest))}`;
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
  const cmd = argv.map(shQuote).join(' ');
  const r = spawnSync(resolveBash(), ['-c', `git ${cmd}`], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout;
}

/**
 * Removes a disposable git worktree created by materializeScenarioProject -- `git worktree
 * remove` (not a plain rmSync) so the source repo's .git/worktrees/ metadata is cleaned up too;
 * a directory deleted out from under git without this leaves the worktree registered forever
 * ("leftover worktree" -- confirmed via `git worktree list` after a run that skipped this).
 * Best-effort: a worktree that's already gone (or was never registered) is not an error here.
 */
export function removeScenarioWorktree({ sourceRepoDir, worktreeDir }) {
  const r = spawnSync(resolveBash(), ['-c', `git worktree remove --force ${shQuote(toPosixPath(worktreeDir))}`], { cwd: sourceRepoDir, encoding: 'utf8' });
  if (r.status !== 0 && !/is not a working tree|not a valid path/i.test(r.stderr ?? '')) {
    throw new Error(`git worktree remove failed (exit ${r.status}): ${r.stderr}`);
  }
  rmSync(worktreeDir, { recursive: true, force: true });
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
  // if it fails partway through -- best-effort clean up via the same removeScenarioWorktree()
  // path a successful worktree's own teardown uses, before rethrowing the original error.
  try {
    runGitViaBash(['worktree', 'add', '--detach', toPosixPath(dest), pinnedCommit], sourceRepoDir);
  } catch (err) {
    try { removeScenarioWorktree({ sourceRepoDir, worktreeDir: dest }); } catch { /* best-effort */ }
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
 * runPrewarm is OPTIONAL and, as of this PR, is never actually supplied by cli.mjs -- no
 * dependency prewarming happens today, and the "snapshot" is of an otherwise-empty directory
 * (just gradle.properties). The isolation guarantee (byte-identical reset between conditions)
 * holds either way; what's NOT currently true is any claim that dependencies are pre-resolved.
 * A caller that DOES pass runPrewarm gets its writes captured in the snapshot before it's taken.
 * @param {{runPrewarm?: (gradleUserHome: string) => void}} [opts]
 */
export function materializeGradleUserHome({ runPrewarm } = {}) {
  const gradleUserHome = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-gradle-'));
  let snapshotDir;
  try {
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

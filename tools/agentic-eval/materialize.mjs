#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/materialize.mjs -- fresh, os.tmpdir()-rooted materialization for every
// fixture kind this harness uses (Round 3 fix #1, Round 4 fix #9, Round 6 finding on
// symlink/wrapper resolution). Nothing under this module ever runs a measured session with a
// cwd inside this repo or any repo/config-ancestor tree -- every fixture is copied/checked out
// into a fresh temp directory immediately before use.
import { mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

// Windows-native tool resolution of `tar`/`git archive` piping mangles backslash-heavy paths
// passed via a plain argv array (confirmed empirically -- a destination path's digits were
// corrupted mid-string even though the source JS string was correct). The proven workaround,
// already required for `claude`/`gradlew` invocation elsewhere in this harness, is to route
// through `bash -c` with POSIX-style paths and careful single-quote escaping.
function toPosixPath(winPath) {
  return winPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
}
const shQuote = (arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`;

/**
 * git-archive the skill snapshot at a pinned SHA into a fresh temp dir, then validate it with
 * tools/validate-plugin.mjs's own runValidator -- fail-closed if validation doesn't pass.
 * @param {{repoRoot: string, sha: string, validateFn: Function}} opts
 */
export async function materializeSkillSnapshot({ repoRoot, sha, validateFn }) {
  const dest = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-skill-'));
  const cmd = `git archive ${shQuote(sha)} -- .claude-plugin .skills | tar -x -C ${shQuote(toPosixPath(dest))}`;
  const r = spawnSync('bash', ['-c', cmd], { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git archive | tar extraction failed (exit ${r.status}): ${r.stderr}`);
  }
  const result = await validateFn({ repoRoot: dest });
  if (!result.ok) {
    throw new Error(`Skill snapshot at ${sha} failed validation: ${result.summary}`);
  }
  return { snapshotDir: dest, validation: result };
}

/**
 * Copy the committed calibration-project template into a fresh temp dir. Reset (for the second
 * condition of a run-pair) means: delete and recopy from the SAME pristine template, never
 * mutate in place.
 * @param {{templateDir: string, existingDir?: string}} opts
 */
export function materializeCalibrationProject({ templateDir, existingDir }) {
  const dest = existingDir ?? mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-calibration-'));
  if (existingDir) rmSync(existingDir, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(templateDir, dest, { recursive: true });
  return { fixtureDir: dest };
}

function runGitViaBash(argv, cwd) {
  const cmd = argv.map(shQuote).join(' ');
  const r = spawnSync('bash', ['-c', `git ${cmd}`], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout;
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
  runGitViaBash(['worktree', 'add', '--detach', toPosixPath(dest), pinnedCommit], sourceRepoDir);
  return { fixtureDir: dest };
}

/**
 * Prewarm GRADLE_USER_HOME once (dependency resolution only, caller-supplied prewarm command),
 * snapshot it, and provide a resetToSnapshot() that restores the exact same pristine state --
 * both conditions of a run-pair always start from byte-identical cache state. Also writes a
 * gradle.properties disabling the daemon inside the temp GRADLE_USER_HOME itself, so the
 * policy applies regardless of which gradle-invoking command the agent types.
 * @param {{runPrewarm?: (gradleUserHome: string) => void}} [opts]
 */
export function materializeGradleUserHome({ runPrewarm } = {}) {
  const gradleUserHome = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-gradle-'));
  writeFileSync(join(gradleUserHome, 'gradle.properties'), 'org.gradle.daemon=false\n');
  const snapshotDir = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-gradle-snapshot-'));
  if (runPrewarm) runPrewarm(gradleUserHome);
  rmSync(snapshotDir, { recursive: true, force: true });
  cpSync(gradleUserHome, snapshotDir, { recursive: true });

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

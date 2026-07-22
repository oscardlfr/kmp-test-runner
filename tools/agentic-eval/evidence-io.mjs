#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/evidence-io.mjs -- shared, atomic evidence-write primitives.
//
// Extracted out of cli.mjs (PR: result-aware foreign-skill classification + rejected-run
// diagnostics) so both cli.mjs's own writers (writeRunRecordEvidence/writeRunMatrixRecordEvidence)
// and the new rejection-diagnostics.mjs writer can reuse the identical, already-reviewed
// atomic-promotion mechanism without a circular import between the two (rejection-diagnostics.mjs
// needs these primitives; cli.mjs needs to call INTO rejection-diagnostics.mjs). Pure move: no
// behavior change to any of the three functions below.
import { writeFileSync, mkdirSync, existsSync, rmSync, linkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpath } from './materialize.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

// KMP_EVAL_RUNS_ROOT override exists specifically so tests never write to (or, worse, clean up
// inside) the real committable tools/runs/ directory -- see cli.mjs's own identical-rationale
// comment on its (now re-exported-from-here) RUNS_ROOT. The single source of truth for this value
// lives here now; cli.mjs imports it rather than computing its own, so the two can never drift.
export const RUNS_ROOT = process.env.KMP_EVAL_RUNS_ROOT || join(REPO_ROOT, 'tools', 'runs');

// Where a run_kind's committable evidence lives: tools/runs/agentic-eval-<run_kind>/, with a
// gitignored raw/ subdirectory for unredacted transcripts (see .gitignore's
// tools/runs/agentic-eval-*/raw/** rule).
export function resolveEvidenceOutDir(runKind, runsRootOverride = RUNS_ROOT) {
  return join(runsRootOverride, `agentic-eval-${runKind}`);
}

// Where privacy-safe rejected-run diagnostics live: tools/runs/agentic-eval-rejected/, with the
// same raw/ gitignore coverage (the existing glob's `*` wildcard already matches "rejected" the
// same way it matches "scenario"/"smoke"/"calibration" -- no new .gitignore rule needed). Never
// keyed by run_kind (RUN_KIND_VALUES never includes 'rejected') -- structurally impossible to
// confuse with resolveEvidenceOutDir's real-evidence directories.
export function resolveRejectedDiagnosticsDir(runsRootOverride = RUNS_ROOT) {
  return join(runsRootOverride, 'agentic-eval-rejected');
}

// Runtime enforcement, not just a run record's own errors[] disclosure -- an independent review
// pass argued that documenting a non-default root in the record doesn't itself prevent an
// accidental `git add -A` from staging raw, unredacted transcripts. Verifies the raw-transcript
// destination can never end up in a real commit: EITHER it's CONFIRMED entirely outside any git
// repository (not just this one -- git can never see it, regardless of any gitignore rule), OR
// it's inside one and actually covered by that repository's own .gitignore -- checked via
// `git check-ignore`, not assumed from the path's string shape. Every git call's failure mode is
// itself fail-closed: a result this function can't positively confirm is never treated as safe by
// default.
export function isRawDirSafeFromAccidentalCommit(rawDir, runsRootOverride) {
  let runsRootReal;
  try {
    runsRootReal = realpath(runsRootOverride);
  } catch {
    return false; // can't even resolve the root -- fail closed
  }
  // Determine the ACTUAL containing git repository, if any -- never assumed to be REPO_ROOT
  // specifically. An earlier version only checked containment against REPO_ROOT and treated
  // anything outside THIS repo's worktree as automatically safe, but a KMP_EVAL_RUNS_ROOT pointed
  // at a location inside a COMPLETELY DIFFERENT git repository (a sibling checkout, any other
  // git-managed directory on the machine) is not "outside a repo" at all -- it's inside a repo
  // this harness never checks .gitignore against. Reproduced directly: pointed at a temp
  // repository elsewhere, `git status` there showed the raw directory as a real, trackable
  // untracked path (`?? agentic-eval-calibration/`) -- an accidental `git add -A` in THAT repo
  // would have staged it. `git -C <path> rev-parse --show-toplevel` finds whatever repository (if
  // any) actually contains the resolved root.
  //
  // A non-zero exit is NOT by itself "confirmed not inside any git repository" -- a further
  // independent review pass caught exactly this: git being unavailable (missing from PATH), a
  // spawn-level error, a permissions problem, an unconfigured safe.directory, or any other
  // unexpected failure ALSO produces a non-zero exit, and treating all of these the same as
  // "definitely outside a repo, therefore safe" is the identical fail-open pattern already fixed
  // once for gitDirtyPaths() -- reproduced concretely by disabling git for this exact call: the
  // function returned "safe" for a destination that, with git working normally, would have shown
  // up as trackable, untracked content in a real containing repository. Only ONE specific,
  // positively-matched outcome counts as confirmed-safe: the spawn itself succeeded (no
  // `.error`), AND git's own exit code (128) and stderr match its well-known, stable
  // "not a git repository" message exactly. Every other outcome -- including a DIFFERENT
  // non-zero status, unrecognized stderr, or a spawn error -- fails closed.
  // LC_ALL/LANG=C forces git's stderr into its default (English) locale regardless of the host's
  // configured language -- a minor observation from an independent review pass: git can localize
  // "fatal: not a git repository" into another language, and without this override, the stable
  // pattern match below would fail to recognize a genuinely-confirmed-safe destination on a
  // non-English host, over-rejecting (never under-rejecting -- fail-closed either way) a valid
  // path. Merged onto process.env, not replacing it -- spawnSync's env option replaces the WHOLE
  // environment if set, and git itself still needs PATH to be found at all.
  const toplevel = spawnSync('git', ['-C', runsRootReal, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
  const confirmedNotInAnyRepo = !toplevel.error && toplevel.status === 128 && /fatal: not a git repository/i.test(toplevel.stderr ?? '');
  if (confirmedNotInAnyRepo) return true;
  if (toplevel.status !== 0) return false; // couldn't confirm either way -- fail closed, never assume safe
  const containingRepoRoot = toplevel.stdout.trim();
  // .gitignore's own pattern is `tools/runs/agentic-eval-*/raw/**` -- the `**` only matches
  // CONTENTS of raw/, never the bare directory path itself (confirmed empirically: `git
  // check-ignore` on the directory alone exits 1/not-ignored, on a file inside it exits 0). Check
  // a representative file path inside it, matching what actually gets written there, scoped to
  // whichever repository actually contains it (not always REPO_ROOT).
  const r = spawnSync('git', ['check-ignore', '--quiet', join(rawDir, 'probe.jsonl')], { cwd: containingRepoRoot, encoding: 'utf8' });
  return !r.error && r.status === 0;
}

/**
 * The shared write/link/rollback body -- arity-independent (iterates whatever `targets` array
 * it's given), extracted so callers with different record shapes (a pair, N scenario-matrix
 * records, or a rejection-diagnostics pair) share the identical atomic-promotion mechanism rather
 * than one being a subtly-different duplicate of the other. `ensureDir` is the deepest directory
 * that must exist before any tmp file can be written (mkdirSync's recursive:true also creates
 * every parent, e.g. a `raw/` subdirectory's own parent `outDir`).
 *
 * Contract, precisely (do not overclaim beyond this): exception-safe (a JS throw partway through
 * rolls back every target THIS invocation successfully linked) and collision-safe (linkSync fails
 * atomically with EEXIST on a real concurrent race, never silently overwrites). It is NOT crash-safe
 * against a hard kill/power-loss between two sequential linkSync calls -- that narrow window can
 * leave a `.tmp-<random>` file, or one of a logically-paired set of targets promoted without its
 * pair, on disk. This is a pre-existing, already-accepted property of this exact mechanism for
 * every evidence write in this harness; a caller must not claim a stronger guarantee than this.
 *
 * run_id (or any other target-naming scheme a caller uses) embedding only a partial slice of
 * randomUUID() is not astronomically improbable to collide across this harness's full lifetime of
 * runs (or, concurrently, two overlapping invocations racing each other). The upfront existsSync
 * loop is a fast, non-atomic PRE-check only -- it narrows the common case early, but does NOT by
 * itself prevent a collision: an independent review pass reproduced a genuine TOCTOU race with two
 * synchronized workers -- both passed this existsSync check (target didn't exist YET for either),
 * then both proceeded to promote, and one silently overwrote the other via renameSync (which
 * replaces an existing destination on POSIX). The REAL, atomic guarantee is the linkSync-based
 * promotion below, which can never lose this race the way check-then-renameSync could.
 */
export function promoteTargetsAtomically(targets, ensureDir) {
  for (const [target] of targets) {
    if (existsSync(target)) {
      throw new Error(`refusing to write evidence: ${target} already exists (run_id collision?) -- nothing was written or touched`);
    }
  }
  mkdirSync(ensureDir, { recursive: true });
  const tmpSuffix = `.tmp-${randomUUID().slice(0, 8)}`;
  const tmpPaths = targets.map(([target]) => target + tmpSuffix);
  // linkSync (not renameSync) for promotion: creates a hard link to the fully-written tmp file at
  // the FINAL target path, and -- critically -- fails atomically with EEXIST if that target
  // already exists, rather than silently replacing it the way renameSync does on POSIX. This is
  // what actually closes the TOCTOU window the existsSync pre-check above cannot: a concurrent
  // invocation racing to create the SAME target can now only ever have ONE winner: whichever
  // linkSync call the filesystem serializes first.
  const linkedTargets = [];
  try {
    targets.forEach(([, content], i) => writeFileSync(tmpPaths[i], content));
    targets.forEach(([target], i) => {
      try {
        linkSync(tmpPaths[i], target);
      } catch (err) {
        if (err.code === 'EEXIST') {
          throw new Error(`refusing to write evidence: ${target} already exists (run_id collision -- lost a concurrent race) -- targets created by this invocation are being rolled back`);
        }
        throw err;
      }
      linkedTargets.push(target);
    });
  } catch (err) {
    // Roll back ONLY the targets THIS invocation actually created via a successful linkSync --
    // never a target that failed with EEXIST, since that means a DIFFERENT invocation already
    // owns it and this one must not touch it.
    for (const target of linkedTargets) rmSync(target, { force: true });
    for (const tmpPath of tmpPaths) rmSync(tmpPath, { force: true });
    throw err;
  }
  // linkSync creates an ADDITIONAL directory entry pointing at the same data -- unlike renameSync,
  // it doesn't consume the source -- so the tmp files must be cleaned up explicitly once every
  // target has been linked successfully.
  for (const tmpPath of tmpPaths) rmSync(tmpPath, { force: true });
}

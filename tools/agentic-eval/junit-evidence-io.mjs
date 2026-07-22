#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/junit-evidence-io.mjs -- shared sidecar-record read/write primitives for the
// per-attempt JUnit evidence-attribution mechanism (decisions/, evidence/, anomalies/ under
// KMP_EVAL_JUNIT_EVIDENCE_DIR). Deliberately its own tiny module, imported by policy-hook.mjs
// AND junit-evidence.mjs/junit-evidence-hook.mjs, so policy-hook.mjs never has to import
// command-classify.mjs (which itself imports `tokenize` FROM policy-hook.mjs) -- that would be a
// circular import. This module has zero dependency on policy-hook.mjs or command-classify.mjs.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { promoteTargetsAtomically } from './evidence-io.mjs';

/** Secure hash of a tool_use_id, used as the sidecar filename -- never the raw ID directly (which
 * could in principle contain filesystem-unsafe characters; hashing removes any assumption about
 * its charset). */
export function sha256Hex(input) {
  return createHash('sha256').update(String(input)).digest('hex');
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Every sidecar id (hash) currently present in `dir` -- `[]` if the directory doesn't exist at
 * all (e.g. the mechanism was never enabled for this condition). */
export function listSidecarIds(dir) {
  return safeReaddir(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length));
}

/** Reads and parses `<dir>/<idHash>.json` -- `null` on any failure (missing file, unreadable,
 * malformed JSON) -- a caller must never distinguish "genuinely absent" from "unreadable" here;
 * both mean "no record found," which the downstream integrity scan already treats identically
 * (an unreadable record is exactly as untrustworthy as a missing one). */
export function readSidecarRecord(dir, idHash) {
  try {
    return JSON.parse(readFileSync(join(dir, `${idHash}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Atomically writes `<dir>/<idHash>.json = JSON.stringify(record)`, reusing evidence-io.mjs's
 * `promoteTargetsAtomically` (the exact `linkSync`-based, collision-safe primitive already used by
 * every other evidence write in this harness -- never `renameSync`, which silently replaces an
 * existing destination on POSIX).
 *
 * On a collision (a real, reachable case given `PostToolUse`/`PostToolUseFailure`'s disclosed
 * possible double-fire for one Bash call, not merely defensive): the PRIMARY recovery is to
 * `rmSync(force:true)` the pre-existing, now-ambiguous target -- never rely solely on a tombstone
 * write succeeding. In the realistic failure mode (the target simply already exists) this makes
 * the worst case "no record exists at all" (unconditionally flagged missing by every reader),
 * never "an arbitrary one of two racing writers' records sits there looking perfectly valid."
 * `force:true` only suppresses `ENOENT`, though -- a genuinely different removal failure (e.g. a
 * transient file lock) is still caught and tolerated below, so in that narrower case the
 * pre-existing record could survive un-removed; disclosed, not deeply engineered around, since
 * manifesting it needs BOTH that removal failure AND the tombstone write below also failing (e.g.
 * its own target already occupied by an unrelated collision, though a plain disk-full/permissions
 * failure there works just as well) -- the two-coincident-failure case
 * `agentic-eval-junit-evidence-io.test.js` does not (and, by construction, cannot cheaply) cover.
 * Only after the removal attempt (itself wrapped so its own failure can't escape) does this ALSO
 * best-effort write a `<anomaliesDir>/<idHash>.json` tombstone for diagnostic richness -- a failure
 * writing *that* is tolerated silently; the outcome is still safe (bare absence, correctly
 * flagged) in the realistic case, just less informative about why.
 *
 * Never throws -- every failure path is swallowed internally. Both callers (`policy-hook.mjs`'s
 * `runAsHook` and `junit-evidence-hook.mjs`'s `runAsHook`) must never let this side effect's own
 * failure alter their primary stdout response.
 */
export function writeSidecarRecord(dir, idHash, record, anomaliesDir, tombstoneReason) {
  const target = join(dir, `${idHash}.json`);
  try {
    promoteTargetsAtomically([[target, JSON.stringify(record)]], dir);
    return;
  } catch {
    // Collision (or any other promotion failure) -- fall through to the recovery below regardless
    // of the exact cause: a non-collision failure (e.g. disk full) leaves `target` unwritten, so
    // the rmSync below is a harmless no-op and the outcome is still correctly "missing".
  }
  try {
    rmSync(target, { force: true });
  } catch {
    // Best-effort only -- even if this fails, still attempt the tombstone below.
  }
  try {
    promoteTargetsAtomically([[join(anomaliesDir, `${idHash}.json`), JSON.stringify({ reason: tombstoneReason })]], anomaliesDir);
  } catch {
    // Best-effort diagnostics only -- a failure here is tolerated. The removal above already makes
    // the realistic case (target simply pre-existed) a safe, correctly-flagged bare absence even
    // without this tombstone; see this function's own doc comment for the narrower, two-coincident-
    // failure case this doesn't fully close.
  }
}

/** True if `<dir>/<idHash>.json` exists in the anomalies directory -- a tombstone from a prior
 * collision on this exact id. */
export function hasAnomalyTombstone(anomaliesDir, idHash) {
  return existsSync(join(anomaliesDir, `${idHash}.json`));
}

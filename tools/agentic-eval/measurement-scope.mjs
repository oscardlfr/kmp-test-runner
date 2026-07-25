#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/measurement-scope.mjs -- versioned, local secret-file lifecycle enabling
// longitudinal (cross-invocation) aggregation.
//
// Background: generateAmbientProfileScope() (cli.mjs) generates a fresh {scopeId, key} pair
// PER INVOCATION, and ambient_skill_profile (which embeds scope_id) is a HARD_PARTITION_FIELDS
// entry -- so two records from different harness invocations can never bucket together in
// `aggregate`, even when their underlying environment was genuinely identical (see README.md's
// "Measurement scope" section for the full rationale this module addresses). This module lets a
// local, secret, versioned scope FILE be created once (`scope init`) and reused across
// independent `calibrate`/`smoke`/`run` invocations via `--measurement-scope-file <path>`, so
// their resulting records share one comparability scope. Supplying no file preserves today's
// exact ephemeral behavior byte-for-byte (cli.mjs's own generateAmbientProfileScope is untouched).
//
// File contract (exactly 3 keys, independently versioned from LATEST_RUN_SCHEMA):
//   { "schema": 1, "scope_id": "<UUID>", "hmac_key_base64": "<32 random bytes, canonical base64>" }
//
// hmac_key_base64 is secret: never printed, logged, committed, or returned by any function in
// this module except loadMeasurementScopeFile's own {key: Buffer} result (consumed locally by
// cli.mjs to build fingerprint_hmac, exactly like the ephemeral key already is -- never passed to
// a child Claude process). scope_id is not secret and is already a schema-v4 record field.
//
// Every filesystem mutation and git invocation below takes an injectable seam (fsImpl/spawnFn,
// both defaulting to the real implementation) so every fail-closed/rollback branch is testable
// deterministically (override one function) rather than by racing real processes or manipulating
// real permissions -- see this module's own test file for the full branch coverage.
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { dirname, basename, join, resolve } from 'node:path';

export const MEASUREMENT_SCOPE_FILE_SCHEMA = 1; // independent of LATEST_RUN_SCHEMA (schemas.mjs)

/**
 * Generates a fresh, independent measurement-scope payload: a new random UUID `scope_id` (not
 * secret) and 32 random bytes as `hmac_key_base64` (secret -- never logged or returned anywhere
 * else by this module except via `loadMeasurementScopeFile`'s own `{key: Buffer}` result).
 * @returns {{schema: number, scope_id: string, hmac_key_base64: string}}
 */
export function createMeasurementScopePayload() {
  return {
    schema: MEASUREMENT_SCOPE_FILE_SCHEMA,
    scope_id: randomUUID(),
    hmac_key_base64: randomBytes(32).toString('base64'),
  };
}

const SCOPE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fail-closed shape validator: exact key set, exact schema value, a well-formed scope_id, and a
 * hmac_key_base64 that decodes to EXACTLY 32 bytes AND round-trips canonically. Node's base64
 * decoder is lenient -- it silently ignores unused "filler" bits a strict decoder would reject,
 * so decode-and-check-length alone would accept a non-canonical encoding (verified directly in
 * this module's test file: two distinct 44-char strings can decode to the identical 32 bytes).
 * The round-trip check (decode, re-encode, compare to the original string) is both necessary and
 * sufficient -- it subsumes wrong length, invalid characters, and non-canonical padding in one
 * check, with no separate regex needed. Error messages never interpolate the actual key value,
 * even when the key IS the violation -- echoing a secret-shaped string back in an error is itself
 * a leak path.
 * @returns {{errors: string[]}}
 */
export function validateMeasurementScopeFileShape(parsed) {
  const errors = [];
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push('measurement scope file must contain a JSON object');
    return { errors };
  }
  const allowedKeys = new Set(['schema', 'scope_id', 'hmac_key_base64']);
  const actualKeys = Object.keys(parsed);
  if (actualKeys.some((k) => !allowedKeys.has(k)) || actualKeys.length !== allowedKeys.size) {
    errors.push(`must have exactly the keys schema/scope_id/hmac_key_base64, got ${JSON.stringify(actualKeys.sort())}`);
  }
  if (parsed.schema !== MEASUREMENT_SCOPE_FILE_SCHEMA) {
    errors.push(`schema must be exactly ${MEASUREMENT_SCOPE_FILE_SCHEMA}, got ${JSON.stringify(parsed.schema)}`);
  }
  if (typeof parsed.scope_id !== 'string' || !SCOPE_ID_RE.test(parsed.scope_id)) {
    errors.push('scope_id must be a full (36-char) UUID string');
  }
  if (typeof parsed.hmac_key_base64 !== 'string') {
    errors.push('hmac_key_base64 must be a string');
  } else {
    let decoded;
    try { decoded = Buffer.from(parsed.hmac_key_base64, 'base64'); } catch { decoded = null; }
    const roundTrips = decoded != null && decoded.length === 32 && decoded.toString('base64') === parsed.hmac_key_base64;
    if (!roundTrips) errors.push('hmac_key_base64 must be exactly 32 bytes encoded as canonical base64');
  }
  return { errors };
}

// --- Path safety --------------------------------------------------------------------------
//
// Mirrors evidence-io.mjs's isRawDirSafeFromAccidentalCommit's proven conventions (spawnSync,
// LC_ALL/LANG=C to force English stderr, strict status+stderr matching -- never "any non-zero
// exit means safe") as a self-contained sibling here rather than a refactor of that
// already-shipped function: different second concern (an arbitrary user-chosen file path, not a
// RUNS_ROOT-relative directory) and one extra check that function's own use case doesn't need
// (a long-lived, user-placed secret file can occupy a path that was tracked in the past --
// .gitignore can never retroactively untrack it).

/**
 * Walks up from `dir` to the nearest directory that actually exists on disk. A fresh scope-file
 * location may not have its parent directory created yet, but git's repo-boundary detection
 * (`git -C <dir> ...`) requires `dir` to exist -- pointing `-C` at any existing ancestor gives
 * the identical boundary answer git's own upward walk would give for the not-yet-existing exact
 * directory, since repo-boundary detection only cares about `.git` markers, never about whether
 * intermediate path components physically exist. Bounded by the filesystem root; returns null
 * (never expected in practice) if even that doesn't resolve.
 */
function resolveNearestExistingAncestor(dir, fsImpl) {
  let current = resolve(dir);
  while (!fsImpl.existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

/**
 * Resolves git repo-boundary context ONCE for a directory. A target path and its `.tmp.*`
 * sibling share the same directory, so this (relatively expensive) spawn happens once per
 * validation pass, not once per candidate path.
 * @returns {{status:'outside'}|{status:'inside', repoRoot:string}|{status:'indeterminate', reason:string}}
 */
function resolveGitSafetyContext(dir, fsImpl, spawnFn) {
  const ancestor = resolveNearestExistingAncestor(dir, fsImpl);
  if (ancestor == null) return { status: 'indeterminate', reason: 'could not resolve any existing ancestor directory' };
  let ancestorReal;
  try {
    ancestorReal = fsImpl.realpathSync(ancestor);
  } catch {
    return { status: 'indeterminate', reason: 'could not resolve the containing directory' };
  }
  const toplevel = spawnFn('git', ['-C', ancestorReal, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  const confirmedNotInAnyRepo = !toplevel.error && toplevel.status === 128
    && /fatal: not a git repository/i.test(toplevel.stderr ?? '');
  if (confirmedNotInAnyRepo) return { status: 'outside' };
  if (toplevel.status !== 0) return { status: 'indeterminate', reason: 'could not confirm whether the path is inside a git repository' };
  return { status: 'inside', repoRoot: toplevel.stdout.trim() };
}

/**
 * Checks ONE absolute target path string (need not exist on disk -- `git ls-files`/
 * `check-ignore` both pattern-match/index-lookup a path string regardless of whether it's
 * physically present) against an already-resolved context. Every indeterminate outcome fails
 * closed -- never treated as safe by default.
 * @returns {{safe: boolean, reason: string|null}}
 */
function isTargetPathSafe(context, absoluteTargetPath, spawnFn) {
  if (context.status === 'indeterminate') return { safe: false, reason: context.reason };
  if (context.status === 'outside') return { safe: true, reason: null };
  const lsFiles = spawnFn('git', ['ls-files', '--', absoluteTargetPath], { cwd: context.repoRoot, encoding: 'utf8' });
  if (lsFiles.error || lsFiles.status !== 0) {
    return { safe: false, reason: 'could not determine whether the path is already tracked by git (indeterminate)' };
  }
  if (lsFiles.stdout.trim().length > 0) {
    return { safe: false, reason: 'path is already tracked by git in its containing repository' };
  }
  const ignoreCheck = spawnFn('git', ['check-ignore', '--quiet', absoluteTargetPath], { cwd: context.repoRoot, encoding: 'utf8' });
  const ignored = !ignoreCheck.error && ignoreCheck.status === 0;
  if (!ignored) {
    return { safe: false, reason: 'path is inside a git repository but not confirmed ignored by its .gitignore' };
  }
  return { safe: true, reason: null };
}

/**
 * Public path-safety entry point, used both directly by loadMeasurementScopeFile (against the
 * presented path AND, separately, the realpath-resolved destination -- see its own doc comment)
 * and internally by createMeasurementScopeFileExclusive (against the final path AND its tmp
 * sibling). Fails closed on every indeterminate git outcome; never assumes safety from a bare
 * non-zero exit code.
 * @returns {{safe: boolean, reason: string|null}}
 */
export function isMeasurementScopePathSafe(absolutePath, fsImpl = fs, spawnFn = spawnSync) {
  return isTargetPathSafe(resolveGitSafetyContext(dirname(absolutePath), fsImpl, spawnFn), absolutePath, spawnFn);
}

/** POSIX-only: verifies the file's real, on-disk mode is exactly 0600 -- shared by both creation
 * (before publishing) and load (before returning the key, since permissions can loosen after
 * creation without this module's involvement -- a backup/restore, a different tool, a copy).
 * Windows cannot set POSIX permission bits or enforce ACLs via Node -- this is a deliberate no-op
 * there, never a claimed guarantee. A `statSync` failure (indeterminate mode) propagates as-is
 * and fails closed exactly like a wrong-mode result -- never treated as "probably fine." */
function verifyPosixMode0600(fsImpl, targetPath) {
  if (process.platform === 'win32') return;
  const actualMode = fsImpl.statSync(targetPath).mode & 0o777;
  if (actualMode !== 0o600) {
    throw new Error(`could not confirm exclusive 0600 permissions on the secret scope file (got mode ${actualMode.toString(8)})`);
  }
}

// --- Load ----------------------------------------------------------------------------------

/**
 * Loads and validates a supplied --measurement-scope-file, fail-closed on every malformed class:
 * missing file, unparseable JSON, any shape violation, or an unsafe path. Checks BOTH the path
 * as presented and its realpath-resolved destination (skipping the second check only when
 * they're identical) -- checking only one direction leaves a bypass open: a symlink that looks
 * safe but resolves to a tracked file (checking only the presented path would miss this), or a
 * symlink that is itself tracked/unignored but resolves to an otherwise-safe destination
 * (checking only the resolved path would miss THIS). Never returns the raw file content or
 * echoes a secret value in any thrown message.
 * @returns {{scopeId: string, key: Buffer}}
 */
export function loadMeasurementScopeFile(path, fsImpl = fs, spawnFn = spawnSync) {
  // An empty string is not "no path" -- `path.resolve('')` falls back to process.cwd(), which
  // would otherwise silently treat "no scope file" as "load the current working directory."
  // Reject explicitly rather than relying on the incidental (and confusing) EISDIR failure that
  // would eventually surface further down.
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('measurement scope file path must not be empty');
  }
  const presentedPath = resolve(path);
  let resolvedPath;
  try {
    resolvedPath = fsImpl.realpathSync(presentedPath);
  } catch {
    throw new Error(`measurement scope file not found: ${path}`);
  }

  const presentedSafety = isMeasurementScopePathSafe(presentedPath, fsImpl, spawnFn);
  if (!presentedSafety.safe) throw new Error(`refusing to load measurement scope file: ${presentedSafety.reason}`);
  if (resolvedPath !== presentedPath) {
    const resolvedSafety = isMeasurementScopePathSafe(resolvedPath, fsImpl, spawnFn);
    if (!resolvedSafety.safe) throw new Error(`refusing to load measurement scope file: ${resolvedSafety.reason}`);
  }

  // Re-verify 0600 on LOAD, not just at creation time -- see verifyPosixMode0600's own doc
  // comment for why (permissions can loosen after creation without this module's involvement).
  verifyPosixMode0600(fsImpl, resolvedPath);

  let raw;
  try {
    raw = fsImpl.readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    throw new Error(`could not read measurement scope file: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`measurement scope file is not valid JSON: ${path}`);
  }
  const { errors } = validateMeasurementScopeFileShape(parsed);
  if (errors.length > 0) throw new Error(`measurement scope file is invalid: ${errors.join('; ')}`);
  return { scopeId: parsed.scope_id, key: Buffer.from(parsed.hmac_key_base64, 'base64') };
}

// --- Exclusive creation ----------------------------------------------------------------------

/** Node's writeFileSync, given a file descriptor, loops internally to guarantee the full buffer
 * is written -- unlike a single raw writeSync call, which may short-write. */
function writeAllToFd(fsImpl, fd, content) {
  fsImpl.writeFileSync(fd, content, 'utf8');
}

/**
 * Atomically creates a brand-new measurement scope file: refuses to overwrite an existing file,
 * refuses an unsafe path (both the final name and its tmp sibling -- an exact-filename
 * .gitignore entry would cover the former but not the latter, which briefly holds the full
 * secret), sets exclusive 0600 permissions AT CREATION (before any publish step, never a
 * separate chmod afterward -- a hard link shares its source inode's permissions atomically, so
 * there is no window where the final path exists with wider permissions), and rolls back only
 * what THIS invocation demonstrably created on any failure. Returns only {scopeId} -- the key is
 * never returned to the caller after creation.
 * @returns {{scopeId: string}}
 */
export function createMeasurementScopeFileExclusive(path, fsImpl = fs, spawnFn = spawnSync) {
  const absPath = resolve(path);
  // Random suffix, not just PID (a PID-only name is predictable and PIDs are reused across
  // process lifetimes) -- PID kept alongside purely for human traceability.
  const tmp = `${absPath}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;

  let context = resolveGitSafetyContext(dirname(absPath), fsImpl, spawnFn);
  for (const candidate of [absPath, tmp]) {
    const safety = isTargetPathSafe(context, candidate, spawnFn);
    if (!safety.safe) throw new Error(`refusing to create measurement scope file: ${safety.reason}`);
  }
  if (fsImpl.existsSync(absPath)) throw new Error(`refusing to overwrite existing measurement scope file: ${absPath}`);
  fsImpl.mkdirSync(dirname(absPath), { recursive: true });

  // Re-validate now the directory is real -- closes the narrow window between the ancestor-based
  // check above (which may have walked up past a not-yet-existing directory) and the directory
  // actually coming into being.
  context = resolveGitSafetyContext(dirname(absPath), fsImpl, spawnFn);
  for (const candidate of [absPath, tmp]) {
    const safety = isTargetPathSafe(context, candidate, spawnFn);
    if (!safety.safe) throw new Error(`refusing to create measurement scope file: ${safety.reason}`);
  }

  const payload = createMeasurementScopePayload();
  const content = JSON.stringify(payload, null, 2);
  let tmpOwnedByUs = false;
  let pathCreatedByWxFallback = false;
  try {
    const tmpFd = fsImpl.openSync(tmp, 'wx', 0o600);
    tmpOwnedByUs = true; // marked immediately after open succeeds -- BEFORE any write
    try {
      writeAllToFd(fsImpl, tmpFd, content);
    } finally {
      fsImpl.closeSync(tmpFd);
    }
    verifyPosixMode0600(fsImpl, tmp); // close + verify, before publishing

    try {
      fsImpl.linkSync(tmp, absPath);
      // Hard link shares tmp's inode -- its already-verified 0600 mode transfers atomically; no
      // separate post-link verification needed on this branch.
    } catch (e) {
      if (e && e.code === 'EEXIST') throw new Error(`refusing to overwrite existing measurement scope file: ${absPath}`);
      // No hard-link support on this filesystem (e.g. some network shares, FAT32/exFAT) --
      // exclusive create directly at absPath, with the identical write/mode rigor as the tmp
      // stage above. Known, accepted residual gap (same tradeoff lib/runners/lockfile.js's own
      // identical fallback already accepts, see its doc comment): `openSync(path,'wx',mode)`
      // makes the file exist (empty) at its FINAL name before the write completes, so a
      // concurrent reader hitting that exact window sees a transient empty file rather than a
      // fully-written one -- unlike the hard-link path above, which never exposes absPath until
      // the fully-written, mode-verified tmp file is linked to it in one atomic step. Not fixable
      // by switching to renameSync instead: POSIX rename() is atomic but silently OVERWRITES an
      // existing destination (the exact hazard evidence-io.mjs's promoteTargetsAtomically already
      // rejected renameSync for) -- trading this narrow, transient-read hazard for a worse one.
      // A reader that hits this window gets a clean "not valid JSON" parse error (retryable), on
      // filesystems without hard-link support only.
      const pathFd = fsImpl.openSync(absPath, 'wx', 0o600);
      pathCreatedByWxFallback = true; // marked immediately, mirroring the tmp-stage rule
      try {
        writeAllToFd(fsImpl, pathFd, content);
      } finally {
        fsImpl.closeSync(pathFd);
      }
      verifyPosixMode0600(fsImpl, absPath); // fallback needs the identical guarantee
    }
  } catch (err) {
    // Roll back ONLY what THIS invocation demonstrably created: tmp is always ours (unique
    // random name); absPath is ours only via the wx-fallback branch above -- the primary
    // linkSync path never leaves a partial absPath (link either fully succeeds or fully fails),
    // and an EEXIST from either branch means something else already occupies absPath, which
    // must never be deleted.
    if (pathCreatedByWxFallback) {
      try { fsImpl.rmSync(absPath, { force: true }); } catch { /* best-effort */ }
    }
    throw err;
  } finally {
    if (tmpOwnedByUs) {
      try { fsImpl.unlinkSync(tmp); } catch { /* best-effort */ }
    }
  }
  return { scopeId: payload.scope_id };
}

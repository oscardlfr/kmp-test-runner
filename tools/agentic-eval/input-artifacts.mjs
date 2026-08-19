#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/input-artifacts.mjs -- static treatment-size computation (multi-runtime plan
// ADR-5/section 7.1): what artifact was made AVAILABLE to the runtime, measured entirely offline,
// before any session ever spawns. Two independent, pure-ish computations:
//
//  - computePromptArtifact(promptText): SHA-256 + UTF-8 byte length of the canonical prompt text
//    exactly as the harness produces it, before any adapter-internal wrapping.
//  - computeSkillSnapshotArtifact({repoRoot, sha, root}): a manifest {path, git_blob_oid,
//    byte_length} enumerated recursively under `root` at the exact Git tree identified by `sha`,
//    resolved entirely through Git's object database (`git rev-parse`/`git ls-tree`) -- never
//    checkout bytes, never the working tree. This is what makes the measurement identical on
//    Windows and macOS regardless of core.autocrlf, per-file eol attributes, or filesystem casing.
//
// These are ARTIFACT sizes, not a consumption measure: they describe what was made available, not
// that a model loaded, read, or admitted any of it to a context window. Never conflate this
// module's output with tokens, and never derive a "skill cost" by subtracting one arm's usage from
// another's -- that residual absorbs unrelated trajectory differences too (see ADR-5/7.1-7.4).
//
// The `root` this PR's own callers use is always `.skills/kmp-test-runner` -- the exact same
// (sha, subtree) pair materializeSkillSnapshot's own `git archive` extracts (a superset: that
// function also archives `.claude-plugin`) -- so the measured snapshot corresponds to what is
// actually delivered to the runtime via `--plugin-dir`, never a second, independently-scoped
// notion of "the skill".
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { canonicalJsonSha256 } from './canonical-json.mjs';

/** Runs one read-only git plumbing command against `repoRoot`. Never routed through a shell/bash
 * wrapper: every argument here is either a revision specifier (a sha, or `${sha}:${root}`, always
 * built with forward slashes) or a tree/blob OID -- none of it is a raw filesystem path handed to
 * a shell command string, so this doesn't hit the Windows backslash-mangling class of bug that
 * motivates bash-routing elsewhere in this harness (materialize.mjs's own `git archive`/`git
 * worktree` calls, which DO embed real filesystem paths in a command string). Throws with the
 * real stderr on any non-zero exit -- every caller here needs to fail closed, never silently
 * treat a git failure as "empty".
 */
function gitPlumbing(repoRoot, args) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (r.error) throw new Error(`git ${args.join(' ')} failed to spawn: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
  }
  return r.stdout;
}

/** UTF-8 byte length + SHA-256 of the exact canonical prompt text, before any adapter wrapping.
 * @param {string} promptText
 * @returns {{prompt_sha256: string, prompt_bytes: number}}
 */
export function computePromptArtifact(promptText) {
  if (typeof promptText !== 'string') {
    throw new TypeError('computePromptArtifact: promptText must be a string');
  }
  const bytes = Buffer.from(promptText, 'utf8');
  return {
    prompt_sha256: createHash('sha256').update(bytes).digest('hex'),
    prompt_bytes: bytes.length,
  };
}

/** Closed, defense-in-depth safety check for one manifest entry's relative path -- rejects an
 * absolute path (POSIX leading `/` or a Windows drive-letter prefix), any backslash, and any
 * `.`/`..` path segment, on top of requiring a non-empty string. Mirrors schemas.mjs's own
 * `isSafeFixtureRelativePath` (same defense-in-depth discipline, independently applied here since
 * this module's manifest entries -- Git-tree-derived, not scenario-authored -- are a structurally
 * different trust boundary). Every real entry `git ls-tree -r` produces under a resolved subtree
 * OID is already root-relative and traversal-free by construction; this check runs anyway, on
 * every entry, so nothing downstream ever has to trust that construction alone. Exported for
 * direct unit testing.
 */
export function isSafeManifestPath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.includes('\\')) return false;
  if (p.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  const segments = p.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  return true;
}

// git ls-tree -l output, one line per entry: "<mode> <type> <sha>[ <size>]\t<path>" -- the size
// column is right-padded/aligned by git but always whitespace-separated from the sha; a
// non-blob (commit/tree) entry reports "-" for size under -l.
const LS_TREE_LONG_LINE_RE = /^(\d{6}) (\S+) ([0-9a-f]{40})\s+(\S+)\t(.*)$/;
const REGULAR_FILE_MODES = new Set(['100644', '100755']);

/**
 * Resolves the manifest `{path, git_blob_oid, byte_length}[]` for everything recursively under
 * `root` at the exact Git tree `sha` identifies, entirely via Git's object database -- resolves
 * `sha:root` to its own tree OID first (never `sha -- root` plus manual prefix-stripping), so
 * every `git ls-tree -r` path is ALREADY root-relative by construction; no path can structurally
 * "escape" the root this way. Only mode `100644`/`100755` blob entries are admitted -- a symlink
 * (`120000`), a submodule/gitlink (`160000`, `commit` type), or any other unexpected entry fails
 * closed immediately. Sorted explicitly by code-point path order (never relying on Git's own tree
 * ordering, which sorts as-if directory names carry a trailing separator).
 * @returns {{snapshot_sha256: string, snapshot_bytes: number, snapshot_file_count: number}}
 */
export function computeSkillSnapshotArtifact({ repoRoot, sha, root }) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new TypeError('computeSkillSnapshotArtifact: repoRoot must be a non-empty string');
  if (typeof sha !== 'string' || sha.length === 0) throw new TypeError('computeSkillSnapshotArtifact: sha must be a non-empty string');
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('computeSkillSnapshotArtifact: root must be a non-empty string');

  const treeOid = gitPlumbing(repoRoot, ['rev-parse', '--verify', `${sha}:${root}`]).trim();
  const lsOut = gitPlumbing(repoRoot, ['ls-tree', '-r', '-l', treeOid]);

  const manifest = [];
  const seenPaths = new Set();
  for (const rawLine of lsOut.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length === 0) continue;
    const m = LS_TREE_LONG_LINE_RE.exec(line);
    if (!m) throw new Error(`computeSkillSnapshotArtifact: unrecognized git ls-tree -l output line: ${JSON.stringify(line)}`);
    const [, mode, , oid, sizeStr, entryPath] = m;
    if (!REGULAR_FILE_MODES.has(mode)) {
      throw new Error(`computeSkillSnapshotArtifact: rejected non-regular entry at "${entryPath}" (mode ${mode}) under ${root}@${sha} -- symlinks, submodules, and any other unexpected tree entry are not permitted in a skill snapshot`);
    }
    if (!isSafeManifestPath(entryPath)) {
      throw new Error(`computeSkillSnapshotArtifact: unsafe manifest path rejected: ${JSON.stringify(entryPath)}`);
    }
    if (seenPaths.has(entryPath)) {
      throw new Error(`computeSkillSnapshotArtifact: duplicate manifest path: ${JSON.stringify(entryPath)}`);
    }
    seenPaths.add(entryPath);
    const byteLength = Number.parseInt(sizeStr, 10);
    if (!Number.isInteger(byteLength) || byteLength < 0) {
      throw new Error(`computeSkillSnapshotArtifact: unrecognized blob size for "${entryPath}": ${JSON.stringify(sizeStr)}`);
    }
    manifest.push({ path: entryPath, git_blob_oid: oid, byte_length: byteLength });
  }

  manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const snapshot_bytes = manifest.reduce((sum, entry) => sum + entry.byte_length, 0);
  return {
    snapshot_sha256: canonicalJsonSha256(manifest),
    snapshot_bytes,
    snapshot_file_count: manifest.length,
  };
}

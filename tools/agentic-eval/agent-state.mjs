// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/agent-state.mjs -- a content-free listing of an agent's config directory, taken
// before and after a session, and the flag for a change to any file a LATER session would load into
// its context, so that session isolation is something the evidence proves rather than assumes.
//
// Only metadata is ever looked at: relative path, size and mtime, from lstat. No file is opened, so
// the listing can never hold, hash or leak a credential or a transcript, even in the directory that
// keeps the agent's login. Symbolic links and junctions are skipped (never followed, never listed):
// lstat reports a link itself, and a link could point anywhere on the host.
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

// The child env variable that names each runtime's config directory (the harness points
// every session at a fresh one).
const STATE_DIR_ENV = Object.freeze({ 'claude-code': 'CLAUDE_CONFIG_DIR', 'codex-cli': 'CODEX_HOME' });

// What a NEW session of each runtime loads into its context from the config directory (official docs
// plus user-scope configuration). `rootFiles` are matched at the top level only; `dirs` match any
// file below that top-level directory. claude-code also loads a per-project memory directory,
// projects/<any>/memory/, handled in isContextRelevant.
const CONTEXT_RELEVANT = Object.freeze({
  'claude-code': {
    rootFiles: new Set(['claude.md', 'settings.json', 'settings.local.json']),
    dirs: new Set(['rules', 'skills', 'agents', 'commands']),
  },
  'codex-cli': {
    rootFiles: new Set(['agents.md', 'agents.override.md', 'config.toml']),
    dirs: new Set(['memories', 'skills']),
  },
});

const DIR_UNAVAILABLE = 'dir_unavailable';

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function walk(absoluteDir, relativeDir, out, fsOps) {
  for (const name of fsOps.readdirSync(absoluteDir)) {
    const absolute = path.join(absoluteDir, name);
    const relative = relativeDir === '' ? name : `${relativeDir}/${name}`;
    let stat;
    try {
      stat = fsOps.lstatSync(absolute);
    } catch (error) {
      // The entry vanished between the directory read and its stat (a temp file an exiting process
      // just removed): it is simply not there. Any other failure means the listing cannot be trusted.
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walk(absolute, relative, out, fsOps);
    else if (stat.isFile()) out.push({ path: relative, size: stat.size, mtimeMs: stat.mtimeMs });
  }
}

/** Every regular file under `dir`, recursively, as `{path, size, mtimeMs}` sorted by path (`path` is
 * relative to `dir`, with forward slashes). Throws when `dir` cannot be read, so a caller can record
 * the directory as unavailable. `fsOps` is a test seam for the two calls it makes. */
export function listAgentState(dir, fsOps = { readdirSync, lstatSync }) {
  const files = [];
  walk(dir, '', files, fsOps);
  return files.sort((a, b) => byPath(a.path, b.path));
}

/** The files only `after` has (created), only `before` has (deleted), and the files in both whose size
 * or mtime differs (modified); each list sorted by path. */
export function diffAgentState(before, after) {
  const beforeByPath = new Map(before.map((file) => [file.path, file]));
  const afterByPath = new Map(after.map((file) => [file.path, file]));
  const created = [];
  const modified = [];
  for (const [filePath, file] of afterByPath) {
    const prior = beforeByPath.get(filePath);
    if (prior === undefined) created.push(filePath);
    else if (prior.size !== file.size || prior.mtimeMs !== file.mtimeMs) modified.push(filePath);
  }
  const deleted = [...beforeByPath.keys()].filter((filePath) => !afterByPath.has(filePath));
  return { created: created.sort(byPath), deleted: deleted.sort(byPath), modified: modified.sort(byPath) };
}

/** True for a file a new session of `runtimeId` loads into its context. Names are compared without
 * regard to case: on the Windows file system a `claude.md` IS `CLAUDE.md`, and a flag raised for a
 * case variant that Linux would ignore costs one rerun, while a missed one costs the isolation proof. */
export function isContextRelevant(runtimeId, filePath) {
  if (!Object.hasOwn(CONTEXT_RELEVANT, runtimeId)) return false;
  const { rootFiles, dirs } = CONTEXT_RELEVANT[runtimeId];
  const segments = filePath.toLowerCase().split('/');
  if (segments.length === 1) return rootFiles.has(segments[0]);
  if (dirs.has(segments[0])) return true;
  return runtimeId === 'claude-code' && segments[0] === 'projects' && segments.length >= 4 && segments[2] === 'memory';
}

/** The directory to list for a session: the child env's CLAUDE_CONFIG_DIR (claude-code) or CODEX_HOME
 * (codex-cli). Null when the variable is unset or empty, or the runtime is unknown. */
export function agentStateDir(runtimeId, env) {
  if (!Object.hasOwn(STATE_DIR_ENV, runtimeId) || env == null) return null;
  const value = env[STATE_DIR_ENV[runtimeId]];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** One listing, or `{listed:false, reason:'dir_unavailable'}` when there is no directory to list, it
 * does not exist, is not a directory, or cannot be read. Never throws: a cell is never lost to it. */
export function takeAgentStateListing(dir, fsOps) {
  if (typeof dir !== 'string' || dir === '') return { listed: false, reason: DIR_UNAVAILABLE };
  try {
    return { listed: true, files: listAgentState(dir, fsOps) };
  } catch {
    return { listed: false, reason: DIR_UNAVAILABLE };
  }
}

/** The record's `agent_state` value from the two listings taken around a session. */
export function buildAgentState(runtimeId, before, after) {
  if (before?.listed !== true || after?.listed !== true) return { listed: false, reason: DIR_UNAVAILABLE };
  const { created, deleted, modified } = diffAgentState(before.files, after.files);
  const relevant = (filePath) => isContextRelevant(runtimeId, filePath);
  return {
    listed: true,
    files_before: before.files.length,
    created,
    deleted,
    modified,
    context_relevant_before: before.files
      .filter((file) => relevant(file.path))
      .map(({ path: filePath, size, mtimeMs }) => ({ path: filePath, size, mtimeMs }))
      .sort((a, b) => byPath(a.path, b.path)),
    context_relevant_changed: [...created, ...deleted, ...modified].filter(relevant).sort(byPath),
  };
}

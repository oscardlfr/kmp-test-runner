// tests/vitest/agentic-eval-agent-state.test.js
// Unit coverage for tools/agentic-eval/agent-state.mjs: the content-free listing of an agent's config
// directory taken before and after a session, and the flag for a change to a file that a later session
// would load into its context. Real temp directories, no network.

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listAgentState, diffAgentState, isContextRelevant, agentStateDir, takeAgentStateListing, buildAgentState,
} from '../../tools/agentic-eval/agent-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH_ROOT = 'C:\\kmp-eval\\scratch';

// Temp directories live under C:\kmp-eval\scratch on a Windows host that has it (hosted CI exposes TEMP as
// a short 8.3 name), and under the OS temp directory everywhere else.
function tempDir(prefix) {
  const root = process.platform === 'win32' && existsSync(SCRATCH_ROOT) ? SCRATCH_ROOT : os.tmpdir();
  const dir = mkdtempSync(path.join(root, prefix));
  cleanup.push(dir);
  return dir;
}
const cleanup = [];
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop(), { recursive: true, force: true });
});

function put(dir, relativePath, content = 'x') {
  const full = path.join(dir, ...relativePath.split('/'));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

describe('listAgentState', () => {
  it('lists every regular file, recursively, with a relative forward-slash path, its size and its mtime', () => {
    const dir = tempDir('aeas-list-');
    put(dir, 'CLAUDE.md', 'abc');
    put(dir, 'projects/p1/memory/MEMORY.md', 'hello');
    put(dir, 'skills/a/SKILL.md', '');
    const listing = listAgentState(dir);
    expect(listing.map((f) => f.path)).toEqual(['CLAUDE.md', 'projects/p1/memory/MEMORY.md', 'skills/a/SKILL.md']);
    expect(listing.map((f) => f.size)).toEqual([3, 5, 0]);
    for (const f of listing) expect(f.mtimeMs).toBeGreaterThan(0);
    expect(Object.keys(listing[0]).sort()).toEqual(['mtimeMs', 'path', 'size']);
  });

  it('is sorted by path, so two listings of the same tree are equal', () => {
    const dir = tempDir('aeas-sorted-');
    for (const name of ['z.txt', 'a/b.txt', 'a.txt', 'm/n/o.txt']) put(dir, name);
    expect(listAgentState(dir)).toEqual(listAgentState(dir));
    expect(listAgentState(dir).map((f) => f.path)).toEqual(['a.txt', 'a/b.txt', 'm/n/o.txt', 'z.txt']);
  });

  it('lists an empty directory as no files, never as an error', () => {
    expect(listAgentState(tempDir('aeas-empty-'))).toEqual([]);
  });

  it('does not follow a symbolic link or a junction to a directory, and does not list the link', () => {
    const dir = tempDir('aeas-link-');
    const outside = tempDir('aeas-outside-');
    put(outside, 'secret.txt', 'must not be reached');
    put(dir, 'real.txt');
    symlinkSync(outside, path.join(dir, 'link'), 'junction'); // a junction on Windows, a directory symlink elsewhere
    expect(listAgentState(dir).map((f) => f.path)).toEqual(['real.txt']);
  });

  it('throws for a directory that does not exist, so the caller can record it as unavailable', () => {
    expect(() => listAgentState(path.join(tempDir('aeas-missing-'), 'nope'))).toThrow();
  });

  it('skips an entry that vanishes between the directory read and its stat, and lists the rest', () => {
    const dir = tempDir('aeas-vanish-');
    put(dir, 'stays.txt');
    put(dir, 'vanishes.txt');
    const lstatThatLosesOne = (p) => {
      if (p.endsWith('vanishes.txt')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return lstatSync(p);
    };
    expect(listAgentState(dir, { readdirSync, lstatSync: lstatThatLosesOne }).map((f) => f.path)).toEqual(['stays.txt']);
  });

  it('does not swallow any other stat failure: one unreadable entry makes the whole listing fail', () => {
    const dir = tempDir('aeas-denied-');
    put(dir, 'a.txt');
    const lstatDenied = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    expect(() => listAgentState(dir, { readdirSync, lstatSync: lstatDenied })).toThrow(/denied/);
  });

  it('the module never opens or reads a file: its source holds no readFile, createReadStream or openSync', () => {
    const source = readFileSync(path.join(__dirname, '..', '..', 'tools', 'agentic-eval', 'agent-state.mjs'), 'utf8');
    expect(source).not.toMatch(/readFile|createReadStream|openSync/);
  });
});

describe('diffAgentState', () => {
  const file = (p, size = 1, mtimeMs = 1000) => ({ path: p, size, mtimeMs });

  it('reports a file that only the after-listing has as created', () => {
    expect(diffAgentState([file('a')], [file('a'), file('b')])).toEqual({ created: ['b'], deleted: [], modified: [] });
  });

  it('reports a file that only the before-listing has as deleted', () => {
    expect(diffAgentState([file('a'), file('b')], [file('a')])).toEqual({ created: [], deleted: ['b'], modified: [] });
  });

  it('reports a file whose size differs as modified', () => {
    expect(diffAgentState([file('a', 1)], [file('a', 2)])).toEqual({ created: [], deleted: [], modified: ['a'] });
  });

  it('reports a file whose mtime differs as modified, even when its size is the same', () => {
    expect(diffAgentState([file('a', 1, 1000)], [file('a', 1, 2000)])).toEqual({ created: [], deleted: [], modified: ['a'] });
  });

  it('reports nothing for identical listings', () => {
    expect(diffAgentState([file('a'), file('b')], [file('b'), file('a')])).toEqual({ created: [], deleted: [], modified: [] });
  });

  it('returns each list sorted by path', () => {
    const diff = diffAgentState([file('m'), file('d1'), file('d0')], [file('m', 9), file('c1'), file('c0')]);
    expect(diff).toEqual({ created: ['c0', 'c1'], deleted: ['d0', 'd1'], modified: ['m'] });
  });

  it('detects create, delete and modify on real files', () => {
    const dir = tempDir('aeas-real-diff-');
    const kept = put(dir, 'kept.txt', 'one');
    put(dir, 'deleted.txt');
    const before = listAgentState(dir);
    put(dir, 'created.txt');
    rmSync(path.join(dir, 'deleted.txt'));
    writeFileSync(kept, 'one two');
    const after = listAgentState(dir);
    expect(diffAgentState(before, after)).toEqual({ created: ['created.txt'], deleted: ['deleted.txt'], modified: ['kept.txt'] });
  });

  it('detects a touch that leaves the size alone, on a real file', () => {
    const dir = tempDir('aeas-touch-');
    const f = put(dir, 'a.txt', 'same');
    const before = listAgentState(dir);
    const later = new Date(Date.now() + 60000);
    utimesSync(f, later, later);
    expect(diffAgentState(before, listAgentState(dir)).modified).toEqual(['a.txt']);
  });
});

describe('isContextRelevant', () => {
  it.each([
    'CLAUDE.md', 'settings.json', 'settings.local.json',
    'projects/x/memory/MEMORY.md', 'projects/C--some-repo/memory/topic.md', 'projects/x/memory/sub/deep.md',
    'rules/a.md', 'rules/sub/b.md', 'skills/a/SKILL.md', 'agents/reviewer.md', 'commands/run.md',
  ])('claude-code: %s is context-relevant', (p) => {
    expect(isContextRelevant('claude-code', p)).toBe(true);
  });

  it.each([
    '.credentials.json', 'history.jsonl', 'projects/x/session.jsonl', 'projects/x/subagents/a.jsonl',
    'sub/CLAUDE.md', 'settings.json.bak', 'projects/memory/MEMORY.md', 'shell-snapshots/a.sh', 'cache/changelog.md',
  ])('claude-code: %s is not context-relevant', (p) => {
    expect(isContextRelevant('claude-code', p)).toBe(false);
  });

  it.each([
    'AGENTS.md', 'AGENTS.override.md', 'config.toml', 'memories/a.md', 'memories/sub/b.md', 'skills/x/SKILL.md',
  ])('codex-cli: %s is context-relevant', (p) => {
    expect(isContextRelevant('codex-cli', p)).toBe(true);
  });

  it.each([
    'auth.json', 'sessions/2026/x.jsonl', 'nested/AGENTS.md', 'config.toml.bak', '.credentials.json', 'rules/a.md',
  ])('codex-cli: %s is not context-relevant', (p) => {
    expect(isContextRelevant('codex-cli', p)).toBe(false);
  });

  it.each(['claude.md', 'Settings.JSON', 'SETTINGS.LOCAL.JSON', 'Rules/a.md', 'PROJECTS/x/Memory/MEMORY.md'])(
    'claude-code: the case variant %s is still context-relevant, because the Windows file system would load it',
    (p) => {
      expect(isContextRelevant('claude-code', p)).toBe(true);
    },
  );

  it.each(['agents.md', 'Config.TOML', 'Memories/a.md'])('codex-cli: the case variant %s is still context-relevant', (p) => {
    expect(isContextRelevant('codex-cli', p)).toBe(true);
  });

  it('nothing is context-relevant for a runtime it does not know', () => {
    expect(isContextRelevant('other-runtime', 'CLAUDE.md')).toBe(false);
  });

  it('a Claude-only path is not context-relevant for Codex and the other way round', () => {
    expect(isContextRelevant('codex-cli', 'CLAUDE.md')).toBe(false);
    expect(isContextRelevant('claude-code', 'AGENTS.md')).toBe(false);
  });
});

describe('agentStateDir', () => {
  it('is the child env\'s CLAUDE_CONFIG_DIR for claude-code and its CODEX_HOME for codex-cli', () => {
    const env = { CLAUDE_CONFIG_DIR: 'C:\\claude-state', CODEX_HOME: 'C:\\codex-state' };
    expect(agentStateDir('claude-code', env)).toBe('C:\\claude-state');
    expect(agentStateDir('codex-cli', env)).toBe('C:\\codex-state');
  });

  it('is null when the variable is unset or empty, and for a runtime it does not know', () => {
    expect(agentStateDir('claude-code', { CODEX_HOME: 'x' })).toBeNull();
    expect(agentStateDir('codex-cli', { CODEX_HOME: '' })).toBeNull();
    expect(agentStateDir('other-runtime', { CLAUDE_CONFIG_DIR: 'x' })).toBeNull();
    expect(agentStateDir('claude-code', undefined)).toBeNull();
  });
});

describe('takeAgentStateListing', () => {
  it('lists an existing directory', () => {
    const dir = tempDir('aeas-take-');
    put(dir, 'CLAUDE.md');
    expect(takeAgentStateListing(dir)).toEqual({ listed: true, files: listAgentState(dir) });
  });

  it.each([
    ['no directory', null],
    ['an empty directory name', ''],
    ['a directory that does not exist', path.join(os.tmpdir(), 'aeas-never-created-dir')],
  ])('records %s as dir_unavailable and carries on', (_label, dir) => {
    expect(takeAgentStateListing(dir)).toEqual({ listed: false, reason: 'dir_unavailable' });
  });

  it('records a path that is a file, not a directory, as dir_unavailable', () => {
    const dir = tempDir('aeas-take-file-');
    const f = put(dir, 'a.txt');
    expect(takeAgentStateListing(f)).toEqual({ listed: false, reason: 'dir_unavailable' });
  });
});

describe('buildAgentState', () => {
  const listed = (files) => ({ listed: true, files });
  const file = (p, size = 1, mtimeMs = 1000) => ({ path: p, size, mtimeMs });

  it('is listed:false with reason dir_unavailable when either listing is unavailable', () => {
    const unavailable = { listed: false, reason: 'dir_unavailable' };
    expect(buildAgentState('claude-code', unavailable, listed([]))).toEqual({ listed: false, reason: 'dir_unavailable' });
    expect(buildAgentState('claude-code', listed([]), unavailable)).toEqual({ listed: false, reason: 'dir_unavailable' });
  });

  it('carries the count before, the three diffs, the context-relevant files before and the context-relevant changes', () => {
    const before = listed([file('.credentials.json'), file('projects/x/memory/MEMORY.md', 10, 1000), file('history.jsonl')]);
    const after = listed([
      file('.credentials.json', 2), file('projects/x/memory/MEMORY.md', 20, 2000), file('history.jsonl'), file('projects/x/session.jsonl'),
    ]);
    expect(buildAgentState('claude-code', before, after)).toEqual({
      listed: true,
      files_before: 3,
      created: ['projects/x/session.jsonl'],
      deleted: [],
      modified: ['.credentials.json', 'projects/x/memory/MEMORY.md'],
      context_relevant_before: [{ path: 'projects/x/memory/MEMORY.md', size: 10, mtimeMs: 1000 }],
      context_relevant_changed: ['projects/x/memory/MEMORY.md'],
    });
  });

  it('counts a created, a deleted and a modified context-relevant file in context_relevant_changed, sorted', () => {
    const before = listed([file('skills/old/SKILL.md'), file('rules/keep.md', 1, 1)]);
    const after = listed([file('rules/keep.md', 1, 2), file('CLAUDE.md')]);
    const state = buildAgentState('claude-code', before, after);
    expect(state.context_relevant_changed).toEqual(['CLAUDE.md', 'rules/keep.md', 'skills/old/SKILL.md']);
  });

  it('has no context-relevant change when only files a later session does not load changed', () => {
    const before = listed([file('history.jsonl', 1)]);
    const after = listed([file('history.jsonl', 99), file('shell-snapshots/a.sh')]);
    expect(buildAgentState('claude-code', before, after).context_relevant_changed).toEqual([]);
  });

  it('judges relevance by the runtime: AGENTS.md changes for codex-cli, not for claude-code', () => {
    const before = listed([]);
    const after = listed([file('AGENTS.md')]);
    expect(buildAgentState('codex-cli', before, after).context_relevant_changed).toEqual(['AGENTS.md']);
    expect(buildAgentState('claude-code', before, after).context_relevant_changed).toEqual([]);
  });
});

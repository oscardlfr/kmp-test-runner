// tests/vitest/agentic-eval-input-artifacts.test.js
// RED -> GREEN for tools/agentic-eval/input-artifacts.mjs: static, offline treatment-size
// computation (ADR-5/section 7.1 of the multi-runtime plan) -- prompt bytes/hash measured over
// exact UTF-8 bytes, skill-snapshot manifest measured entirely from Git objects (never checkout
// bytes), both computable before any runtime session ever spawns.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';
import {
  computePromptArtifact, computeSkillSnapshotArtifact, isSafeManifestPath,
} from '../../tools/agentic-eval/input-artifacts.mjs';
import { canonicalJsonSha256 } from '../../tools/agentic-eval/canonical-json.mjs';

// Local mirror of the established test convention (agentic-eval-materialize.test.js) -- all git
// setup calls route through `bash -c` with POSIX-style paths, matching this harness's own proven
// Windows-safe pattern for any git call that embeds a path in its command text.
function toPosixPath(winPath) {
  return winPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
}
const shQuote = (arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`;
function gitViaBash(argv, cwd) {
  const cmd = argv.map(shQuote).join(' ');
  const r = spawnSync(resolveBash(), ['-c', `git ${cmd}`], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout;
}

const cleanupDirs = [];
afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop(), { recursive: true, force: true });
});

function freshRepo(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  gitViaBash(['init', '-q'], dir);
  gitViaBash(['config', 'user.email', 'test@example.com'], dir);
  gitViaBash(['config', 'user.name', 'Test'], dir);
  // Never let ambient autocrlf/eol config on the test machine influence what gets committed --
  // this suite commits raw bytes it controls explicitly and asserts on Git-object-derived values.
  gitViaBash(['config', 'core.autocrlf', 'false'], dir);
  return dir;
}

function writeSkillFile(repoDir, relPath, content) {
  const abs = path.join(repoDir, '.skills', 'kmp-test-runner', ...relPath.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function commitAll(repoDir, message) {
  gitViaBash(['add', '-A'], repoDir);
  gitViaBash(['commit', '-q', '-m', message], repoDir);
  return gitViaBash(['rev-parse', 'HEAD'], repoDir).trim();
}

// For a caller that already staged its own change directly (e.g. `git update-index --chmod`) and
// must NOT have `commitAll`'s own `git add -A` re-read the working tree afterward -- on Linux, `git
// add -A` re-reads the physical file mode, which would silently revert an index-only mode change
// still sitting on disk as 644 and leave the index identical to HEAD (a "nothing to commit" exit 1).
function commitStaged(repoDir, message) {
  gitViaBash(['commit', '-q', '-m', message], repoDir);
  return gitViaBash(['rev-parse', 'HEAD'], repoDir).trim();
}

/** Builds one flat tree object via `git mktree -z`, entirely through STDIN -- never a command-line
 * argument -- so an entry `name` may contain ANY byte except NUL (a literal tab, newline, double
 * quote, or a genuinely invalid UTF-8 byte sequence), which `git update-index --add --cacheinfo`'s
 * own path argument validation refuses outright regardless of shell quoting (confirmed live:
 * "error: Invalid path" for tab/newline/quote). `name` may be a string or a raw Buffer. Returns the
 * new tree's OID (trimmed). */
function mktreeZ(repoDir, entries) {
  const parts = entries.map((e) => {
    const nameBuf = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8');
    return Buffer.concat([Buffer.from(`${e.mode} ${e.type} ${e.oid}\t`, 'utf8'), nameBuf, Buffer.from([0])]);
  });
  const input = Buffer.concat(parts);
  const r = spawnSync(resolveBash(), ['-c', 'git mktree -z'], { cwd: repoDir, input, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git mktree -z failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

function commitTreeRoot(repoDir, treeOid, message) {
  return gitViaBash(['commit-tree', treeOid, '-m', message], repoDir).trim();
}

describe('computePromptArtifact -- UTF-8 byte measurement, never JS string length', () => {
  it('prompt_bytes equals the exact UTF-8 byte length, not String.prototype.length', () => {
    // 'é' is 1 UTF-16 code unit but 2 UTF-8 bytes; the emoji is 2 UTF-16 code units (a surrogate
    // pair) but 4 UTF-8 bytes -- 'café🎉' has JS .length 6 but a real UTF-8 byte length of 9
    // (c-a-f-1 + é(2 bytes) + 🎉(4 bytes) = 4 + 2 + 4 - wait computed below via Buffer directly).
    const text = 'café🎉';
    const artifact = computePromptArtifact(text);
    expect(artifact.prompt_bytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(artifact.prompt_bytes).not.toBe(text.length);
  });

  it('prompt_sha256 is the real SHA-256 of the exact UTF-8 bytes', () => {
    const text = 'Use the kmp-test-runner skill to check this project. café🎉';
    const artifact = computePromptArtifact(text);
    const expected = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
    expect(artifact.prompt_sha256).toBe(expected);
    expect(artifact.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same text', () => {
    const a = computePromptArtifact('same text');
    const b = computePromptArtifact('same text');
    expect(a).toEqual(b);
  });

  it('differs for different text', () => {
    const a = computePromptArtifact('text A');
    const b = computePromptArtifact('text B');
    expect(a.prompt_sha256).not.toBe(b.prompt_sha256);
  });

  it('measures an empty string as zero bytes with a real (non-empty-input) SHA-256', () => {
    const artifact = computePromptArtifact('');
    expect(artifact.prompt_bytes).toBe(0);
    expect(artifact.prompt_sha256).toBe(createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  });
});

describe('isSafeManifestPath -- defense-in-depth path-shape guard', () => {
  it('accepts a normal nested relative path', () => {
    expect(isSafeManifestPath('references/workflows/overview.md')).toBe(true);
    expect(isSafeManifestPath('SKILL.md')).toBe(true);
  });
  it('rejects a leading slash (absolute POSIX path)', () => {
    expect(isSafeManifestPath('/etc/passwd')).toBe(false);
  });
  it('rejects a Windows drive-letter absolute path', () => {
    expect(isSafeManifestPath('C:/secrets.txt')).toBe(false);
  });
  it('rejects any backslash', () => {
    expect(isSafeManifestPath('references\\workflows\\overview.md')).toBe(false);
  });
  it('rejects a "." path segment', () => {
    expect(isSafeManifestPath('references/./overview.md')).toBe(false);
  });
  it('rejects a ".." path segment (traversal)', () => {
    expect(isSafeManifestPath('references/../../../etc/passwd')).toBe(false);
  });
  it('rejects an empty string', () => {
    expect(isSafeManifestPath('')).toBe(false);
  });
  it('rejects a non-string', () => {
    expect(isSafeManifestPath(null)).toBe(false);
    expect(isSafeManifestPath(undefined)).toBe(false);
    expect(isSafeManifestPath(42)).toBe(false);
  });
});

describe('computeSkillSnapshotArtifact -- measured entirely from Git objects', () => {
  // Codex round 2, Finding 7: integration tests spawning several real Git subprocesses -- two
  // real timeouts of 6035/5253ms observed under Windows coverage instrumentation stacked on top
  // of Lane All's own resource contention (they run isolated in ~1s otherwise). 15s is scoped to
  // ONLY these two tests, not a global timeout change.
  it('produces a manifest-derived file count and positive byte total for a real committed skill root', () => {
    const repo = freshRepo('aeia-basic-');
    writeSkillFile(repo, 'SKILL.md', '# skill\ncontent one\n');
    writeSkillFile(repo, 'references/overview.md', 'ref content\n');
    const sha = commitAll(repo, 'add skill');
    const artifact = computeSkillSnapshotArtifact({ repoRoot: repo, sha, root: '.skills/kmp-test-runner' });
    expect(artifact.snapshot_file_count).toBe(2);
    expect(artifact.snapshot_bytes).toBeGreaterThan(0);
    expect(artifact.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 15_000);

  it('snapshot_bytes equals the exact sum of the committed blobs\' own byte sizes', () => {
    const repo = freshRepo('aeia-bytesum-');
    const a = 'a'.repeat(37);
    const b = 'b'.repeat(101);
    writeSkillFile(repo, 'SKILL.md', a);
    writeSkillFile(repo, 'nested/dir/file.md', b);
    const sha = commitAll(repo, 'add skill');
    const artifact = computeSkillSnapshotArtifact({ repoRoot: repo, sha, root: '.skills/kmp-test-runner' });
    expect(artifact.snapshot_bytes).toBe(Buffer.byteLength(a, 'utf8') + Buffer.byteLength(b, 'utf8'));
    expect(artifact.snapshot_file_count).toBe(2);
  });

  it('is deterministic: recomputing the identical (repo, sha, root) twice gives the same hash', () => {
    const repo = freshRepo('aeia-det-');
    writeSkillFile(repo, 'SKILL.md', 'stable content\n');
    const sha = commitAll(repo, 'add skill');
    const first = computeSkillSnapshotArtifact({ repoRoot: repo, sha, root: '.skills/kmp-test-runner' });
    const second = computeSkillSnapshotArtifact({ repoRoot: repo, sha, root: '.skills/kmp-test-runner' });
    expect(first).toEqual(second);
  });

  // Codex round 2, Finding 7: see the sibling test above -- same class of real, several-Git-
  // subprocess integration test, same observed Windows-coverage-under-Lane-All timeout pressure.
  it('creation order of files does not change the hash -- two independent repos with the same final content produce the same manifest hash', () => {
    const repoA = freshRepo('aeia-order-a-');
    writeSkillFile(repoA, 'SKILL.md', 'alpha\n');
    writeSkillFile(repoA, 'refs/one.md', 'one\n');
    writeSkillFile(repoA, 'refs/two.md', 'two\n');
    const shaA = commitAll(repoA, 'all at once');

    const repoB = freshRepo('aeia-order-b-');
    writeSkillFile(repoB, 'refs/two.md', 'two\n');
    commitAll(repoB, 'two first');
    writeSkillFile(repoB, 'refs/one.md', 'one\n');
    commitAll(repoB, 'one second');
    writeSkillFile(repoB, 'SKILL.md', 'alpha\n');
    const shaB = commitAll(repoB, 'skill.md last');

    const artifactA = computeSkillSnapshotArtifact({ repoRoot: repoA, sha: shaA, root: '.skills/kmp-test-runner' });
    const artifactB = computeSkillSnapshotArtifact({ repoRoot: repoB, sha: shaB, root: '.skills/kmp-test-runner' });
    expect(artifactA.snapshot_sha256).toBe(artifactB.snapshot_sha256);
    expect(artifactA.snapshot_file_count).toBe(artifactB.snapshot_file_count);
    expect(artifactA.snapshot_bytes).toBe(artifactB.snapshot_bytes);
  }, 15_000);

  it('changing one file\'s path changes the hash', () => {
    const repo = freshRepo('aeia-path-change-');
    writeSkillFile(repo, 'SKILL.md', 'content\n');
    const sha1 = commitAll(repo, 'first path');
    const artifact1 = computeSkillSnapshotArtifact({ repoRoot: repo, sha: sha1, root: '.skills/kmp-test-runner' });
    gitViaBash(['mv', '.skills/kmp-test-runner/SKILL.md', '.skills/kmp-test-runner/RENAMED.md'], repo);
    const sha2 = commitAll(repo, 'renamed');
    const artifact2 = computeSkillSnapshotArtifact({ repoRoot: repo, sha: sha2, root: '.skills/kmp-test-runner' });
    expect(artifact1.snapshot_sha256).not.toBe(artifact2.snapshot_sha256);
  });

  it('changing one file\'s blob bytes changes the hash', () => {
    const repo = freshRepo('aeia-bytes-change-');
    writeSkillFile(repo, 'SKILL.md', 'version one\n');
    const sha1 = commitAll(repo, 'v1');
    const artifact1 = computeSkillSnapshotArtifact({ repoRoot: repo, sha: sha1, root: '.skills/kmp-test-runner' });
    writeSkillFile(repo, 'SKILL.md', 'version two, different content\n');
    const sha2 = commitAll(repo, 'v2');
    const artifact2 = computeSkillSnapshotArtifact({ repoRoot: repo, sha: sha2, root: '.skills/kmp-test-runner' });
    expect(artifact1.snapshot_sha256).not.toBe(artifact2.snapshot_sha256);
  });

  it('changing cardinality (adding a file) changes the hash and the file count', () => {
    const repo = freshRepo('aeia-cardinality-');
    writeSkillFile(repo, 'SKILL.md', 'content\n');
    const sha1 = commitAll(repo, 'one file');
    const artifact1 = computeSkillSnapshotArtifact({ repoRoot: repo, sha: sha1, root: '.skills/kmp-test-runner' });
    writeSkillFile(repo, 'references/extra.md', 'extra\n');
    const sha2 = commitAll(repo, 'two files');
    const artifact2 = computeSkillSnapshotArtifact({ repoRoot: repo, sha: sha2, root: '.skills/kmp-test-runner' });
    expect(artifact2.snapshot_file_count).toBe(artifact1.snapshot_file_count + 1);
    expect(artifact1.snapshot_sha256).not.toBe(artifact2.snapshot_sha256);
  });

  it('the executable bit (100755 vs 100644) does not change the hash -- mode is not part of the manifest', () => {
    const repo = freshRepo('aeia-exec-bit-');
    writeSkillFile(repo, 'scripts/run.sh', '#!/bin/sh\necho hi\n');
    const sha1 = commitAll(repo, 'non-executable');
    const artifact1 = computeSkillSnapshotArtifact({ repoRoot: repo, sha: sha1, root: '.skills/kmp-test-runner' });
    gitViaBash(['update-index', '--chmod=+x', '.skills/kmp-test-runner/scripts/run.sh'], repo);
    const sha2 = commitStaged(repo, 'now executable, same bytes');
    const artifact2 = computeSkillSnapshotArtifact({ repoRoot: repo, sha: sha2, root: '.skills/kmp-test-runner' });
    // The mode really did change on disk between the two commits (sanity-check the fixture itself
    // exercises what it claims to).
    const modeLine2 = gitViaBash(['ls-tree', sha2, '.skills/kmp-test-runner/scripts/run.sh'], repo);
    expect(modeLine2.startsWith('100755')).toBe(true);
    const modeLine1 = gitViaBash(['ls-tree', sha1, '.skills/kmp-test-runner/scripts/run.sh'], repo);
    expect(modeLine1.startsWith('100644')).toBe(true);
    expect(artifact1.snapshot_sha256).toBe(artifact2.snapshot_sha256);
  });

  it('CRLF mutation of the local checkout does not change the hash -- computed from Git objects, never checkout bytes', () => {
    const repo = freshRepo('aeia-crlf-');
    writeSkillFile(repo, 'SKILL.md', 'line one\nline two\n'); // LF blob, committed as-is (autocrlf=false)
    const sha = commitAll(repo, 'lf content');
    const before = computeSkillSnapshotArtifact({ repoRoot: repo, sha, root: '.skills/kmp-test-runner' });
    // Mutate the WORKING TREE copy to CRLF directly -- git's index/objects are untouched (no add/commit).
    const abs = path.join(repo, '.skills', 'kmp-test-runner', 'SKILL.md');
    writeFileSync(abs, 'line one\r\nline two\r\n');
    const after = computeSkillSnapshotArtifact({ repoRoot: repo, sha, root: '.skills/kmp-test-runner' });
    expect(after).toEqual(before);
  });

  it('never reads the working tree at all -- still succeeds after the checkout file is deleted from disk', () => {
    const repo = freshRepo('aeia-no-checkout-');
    writeSkillFile(repo, 'SKILL.md', 'will be deleted from disk after commit\n');
    const sha = commitAll(repo, 'add then delete locally');
    const before = computeSkillSnapshotArtifact({ repoRoot: repo, sha, root: '.skills/kmp-test-runner' });
    const abs = path.join(repo, '.skills', 'kmp-test-runner', 'SKILL.md');
    rmSync(abs, { force: true });
    expect(existsSync(abs)).toBe(false);
    const after = computeSkillSnapshotArtifact({ repoRoot: repo, sha, root: '.skills/kmp-test-runner' });
    expect(after).toEqual(before);
  });

  it('rejects (throws) on a symlink entry under the root', () => {
    const repo = freshRepo('aeia-symlink-');
    writeSkillFile(repo, 'SKILL.md', 'real file\n');
    gitViaBash(['add', '-A'], repo);
    // A symlink blob's content is the link target text; mode 120000 is what marks it as a symlink.
    const blobSha = spawnSync(resolveBash(), ['-c', `printf 'target.txt' | git hash-object -w --stdin`], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    gitViaBash(['update-index', '--add', '--cacheinfo', `120000,${blobSha},.skills/kmp-test-runner/evil-link`], repo);
    gitViaBash(['commit', '-q', '-m', 'add symlink entry'], repo);
    const sha = gitViaBash(['rev-parse', 'HEAD'], repo).trim();
    expect(() => computeSkillSnapshotArtifact({ repoRoot: repo, sha, root: '.skills/kmp-test-runner' })).toThrow();
  });

  it('rejects (throws) on a submodule/gitlink entry under the root', () => {
    const repo = freshRepo('aeia-submodule-');
    writeSkillFile(repo, 'SKILL.md', 'real file\n');
    gitViaBash(['add', '-A'], repo);
    // A gitlink entry (mode 160000, type commit) never needs a real submodule checkout to exist
    // for `git ls-tree` to report it -- it's purely an index-level mode/oid pairing. Git rejects
    // an all-zeros SHA specifically ("cache entry has null sha1"), so this uses a plausible-looking
    // non-zero placeholder instead -- still never resolves to a real commit object, which is
    // exactly the point (a gitlink is a reference into ANOTHER repository's object space).
    const fakeCommitSha = '1234567890abcdef1234567890abcdef12345678';
    gitViaBash(['update-index', '--add', '--cacheinfo', `160000,${fakeCommitSha},.skills/kmp-test-runner/vendored`], repo);
    gitViaBash(['commit', '-q', '-m', 'add gitlink entry'], repo);
    const sha = gitViaBash(['rev-parse', 'HEAD'], repo).trim();
    expect(() => computeSkillSnapshotArtifact({ repoRoot: repo, sha, root: '.skills/kmp-test-runner' })).toThrow();
  });

  it('rejects (throws) when the root does not exist at the given sha', () => {
    const repo = freshRepo('aeia-missing-root-');
    writeFileSync(path.join(repo, 'unrelated.txt'), 'x\n');
    const sha = commitAll(repo, 'no skill dir at all');
    expect(() => computeSkillSnapshotArtifact({ repoRoot: repo, sha, root: '.skills/kmp-test-runner' })).toThrow();
  });

  it('rejects (throws) on a nonexistent sha', () => {
    const repo = freshRepo('aeia-bad-sha-');
    writeSkillFile(repo, 'SKILL.md', 'x\n');
    commitAll(repo, 'one commit');
    expect(() => computeSkillSnapshotArtifact({ repoRoot: repo, sha: 'deadbeef00000000000000000000000000000000', root: '.skills/kmp-test-runner' })).toThrow();
  });

  // Constructed via `git mktree -z` (see its own doc comment above) -- never via `writeFileSync`
  // (NTFS forbids tab/newline/double-quote in a real filename outright) and never via
  // `update-index --add --cacheinfo` (confirmed live: it refuses the same 3 characters in its own
  // path argument regardless of shell quoting). This is exactly what computeSkillSnapshotArtifact
  // itself claims to depend on: Git's object database, never the working-tree filesystem
  // (P1 architectural review).
  it('an -l -z ls-tree parse correctly captures paths containing a tab, a newline, a double quote, and non-ASCII Unicode -- never Git\'s own C-style quoted/escaped representation of them', () => {
    const repo = freshRepo('aeia-weird-names-');
    const blobSha = spawnSync(resolveBash(), ['-c', 'printf x | git hash-object -w --stdin'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    const weirdNames = ['has\ttab.md', 'has\nnewline.md', 'has"quote.md', 'héllo-ünïcode-🎉.md'];
    const kmpTestRunnerTree = mktreeZ(repo, weirdNames.map((name) => ({ mode: '100644', type: 'blob', oid: blobSha, name })));
    const skillsTree = mktreeZ(repo, [{ mode: '040000', type: 'tree', oid: kmpTestRunnerTree, name: 'kmp-test-runner' }]);
    const rootTree = mktreeZ(repo, [{ mode: '040000', type: 'tree', oid: skillsTree, name: '.skills' }]);
    const sha = commitTreeRoot(repo, rootTree, 'weird filenames');
    const artifact = computeSkillSnapshotArtifact({ repoRoot: repo, sha, root: '.skills/kmp-test-runner' });
    expect(artifact.snapshot_file_count).toBe(weirdNames.length);
    // Read the raw manifest back out by recomputing the same canonical hash over the exact names
    // this test expects -- computeSkillSnapshotArtifact does not itself expose the manifest array,
    // so the strongest available proof is: an independent recomputation from a manually-built
    // manifest with these EXACT literal name strings (never a quoted/escaped variant) produces the
    // identical hash -- this can only be true if the real manifest's own path strings are the true,
    // unescaped values.
    const expectedManifest = weirdNames
      .map((name) => ({ path: name, git_blob_oid: blobSha, byte_length: 1 }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    expect(artifact.snapshot_sha256).toBe(canonicalJsonSha256(expectedManifest));
  });

  it('a path that cannot be faithfully decoded as UTF-8 fails closed (throws), never silently substitutes U+FFFD', () => {
    const repo = freshRepo('aeia-invalid-utf8-');
    const blobSha = spawnSync(resolveBash(), ['-c', 'printf x | git hash-object -w --stdin'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    // 0xFF is not a valid UTF-8 lead byte under any continuation -- an isolated 0xFF byte can never
    // be part of a well-formed UTF-8 sequence. Built as a raw Buffer (never a JS string, which
    // cannot represent an invalid byte sequence in the first place) so this reaches Git's tree
    // object -- and this function's own parsing -- as a genuinely invalid-UTF-8 path.
    const badName = Buffer.concat([Buffer.from('bad-', 'utf8'), Buffer.from([0xFF]), Buffer.from('-byte.md', 'utf8')]);
    const kmpTestRunnerTree = mktreeZ(repo, [{ mode: '100644', type: 'blob', oid: blobSha, name: badName }]);
    const skillsTree = mktreeZ(repo, [{ mode: '040000', type: 'tree', oid: kmpTestRunnerTree, name: 'kmp-test-runner' }]);
    const rootTree = mktreeZ(repo, [{ mode: '040000', type: 'tree', oid: skillsTree, name: '.skills' }]);
    const sha = commitTreeRoot(repo, rootTree, 'invalid utf-8 path');
    expect(() => computeSkillSnapshotArtifact({ repoRoot: repo, sha, root: '.skills/kmp-test-runner' })).toThrow();
  });

  it('accepts a real SHA-256 repository\'s own 64-hex-char blob OIDs -- never hardcoded to exactly 40 (SHA-1) characters', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'aeia-sha256-'));
    cleanupDirs.push(repo);
    gitViaBash(['init', '-q', '--object-format=sha256'], repo);
    gitViaBash(['config', 'user.email', 'test@example.com'], repo);
    gitViaBash(['config', 'user.name', 'Test'], repo);
    gitViaBash(['config', 'core.autocrlf', 'false'], repo);
    writeSkillFile(repo, 'SKILL.md', 'sha256 repo content\n');
    const sha = commitAll(repo, 'sha256 commit');
    const artifact = computeSkillSnapshotArtifact({ repoRoot: repo, sha, root: '.skills/kmp-test-runner' });
    expect(artifact.snapshot_file_count).toBe(1);
    const oid = gitViaBash(['rev-parse', `${sha}:.skills/kmp-test-runner/SKILL.md`], repo).trim();
    expect(oid).toMatch(/^[0-9a-f]{64}$/);
  });
});

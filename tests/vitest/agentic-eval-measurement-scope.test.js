// tests/vitest/agentic-eval-measurement-scope.test.js
// Unit + integration tests for tools/agentic-eval/measurement-scope.mjs -- the versioned, local
// secret-file lifecycle that lets calibrate/smoke/run share one comparability scope across
// independent invocations instead of each generating a fresh ephemeral one (cli.mjs's own
// generateAmbientProfileScope, unchanged). See the module's own header and README.md's
// "Measurement scope" section for the full design and privacy rationale.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as realFs from 'node:fs';
import { existsSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MEASUREMENT_SCOPE_FILE_SCHEMA,
  createMeasurementScopePayload,
  validateMeasurementScopeFileShape,
  isMeasurementScopePathSafe,
  loadMeasurementScopeFile,
  createMeasurementScopeFileExclusive,
} from '../../tools/agentic-eval/measurement-scope.mjs';

function gitViaBash(argv, cwd) {
  const r = spawnSync('git', argv, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function initRepo(dir) {
  gitViaBash(['init', '-q'], dir);
  gitViaBash(['config', 'user.email', 'test@example.com'], dir);
  gitViaBash(['config', 'user.name', 'Test'], dir);
  // Isolate from the host's global git config: a globally-enabled commit.gpgsign would make
  // `commitFile`'s commits hang/fail without a usable GPG agent, and a globally-configured
  // core.hooksPath would still apply to this freshly-`init`'d repo (a bare `git init` only ships
  // inert *.sample files under its OWN .git/hooks/, but doesn't itself override a global
  // core.hooksPath pointed elsewhere). Both set as LOCAL repo config -- portable on Windows/Git
  // Bash since this is a plain `git config key value` call, no shell interpretation involved.
  gitViaBash(['config', 'commit.gpgsign', 'false'], dir);
  gitViaBash(['config', 'core.hooksPath', path.join(dir, '.git', 'hooks')], dir);
}

function commitFile(dir, relPath, content) {
  writeFileSync(path.join(dir, relPath), content);
  gitViaBash(['add', '-A'], dir);
  gitViaBash(['commit', '-q', '-m', `add ${relPath}`], dir);
}

let tmpDirs = [];
function mkTemp(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function tmpSiblingsOf(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.includes('.tmp.')) : [];
}

// ---------------------------------------------------------------------------------------------
describe('createMeasurementScopePayload / validateMeasurementScopeFileShape', () => {
  it('creates a valid payload matching the exact schema contract', () => {
    const payload = createMeasurementScopePayload();
    expect(payload.schema).toBe(MEASUREMENT_SCOPE_FILE_SCHEMA);
    expect(payload.scope_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(Buffer.from(payload.hmac_key_base64, 'base64').length).toBe(32);
    expect(validateMeasurementScopeFileShape(payload).errors).toEqual([]);
  });

  it('two payloads never share a scope_id or key', () => {
    const a = createMeasurementScopePayload();
    const b = createMeasurementScopePayload();
    expect(a.scope_id).not.toBe(b.scope_id);
    expect(a.hmac_key_base64).not.toBe(b.hmac_key_base64);
  });

  it('rejects a missing key', () => {
    const { schema, scope_id } = createMeasurementScopePayload();
    expect(validateMeasurementScopeFileShape({ schema, scope_id }).errors.length).toBeGreaterThan(0);
  });

  it('rejects an extra key', () => {
    const payload = { ...createMeasurementScopePayload(), extra: 'nope' };
    expect(validateMeasurementScopeFileShape(payload).errors.length).toBeGreaterThan(0);
  });

  it('rejects the wrong schema value', () => {
    const payload = { ...createMeasurementScopePayload(), schema: 2 };
    expect(validateMeasurementScopeFileShape(payload).errors.length).toBeGreaterThan(0);
  });

  it('rejects a malformed scope_id (not a UUID)', () => {
    const payload = { ...createMeasurementScopePayload(), scope_id: 'not-a-uuid' };
    expect(validateMeasurementScopeFileShape(payload).errors.length).toBeGreaterThan(0);
  });

  it('rejects a hmac_key_base64 that decodes to the wrong length', () => {
    const payload = { ...createMeasurementScopePayload(), hmac_key_base64: Buffer.from('too short').toString('base64') };
    expect(validateMeasurementScopeFileShape(payload).errors.length).toBeGreaterThan(0);
  });

  // Node's base64 decoder is lenient -- it silently ignores unused "filler" bits a strict decoder
  // would reject, so decode-and-check-length alone would accept a non-canonical encoding. This
  // constructs a 32-zero-byte value whose LAST character's two filler bits are non-zero: it still
  // decodes to the same 32 bytes (verified directly: Buffer.from(nonCanonical,'base64').equals(
  // Buffer.from(canonical,'base64')) is true), but re-encoding those bytes produces the CANONICAL
  // string, not the one supplied -- exactly the round-trip mismatch the validator must catch.
  it('rejects a non-canonical base64 encoding (decodes to 32 bytes, but does not round-trip)', () => {
    const canonical = 'A'.repeat(43) + '=';
    const nonCanonical = 'A'.repeat(42) + 'B=';
    expect(Buffer.from(nonCanonical, 'base64').length).toBe(32);
    expect(Buffer.from(nonCanonical, 'base64').toString('base64')).toBe(canonical);
    expect(Buffer.from(nonCanonical, 'base64').toString('base64')).not.toBe(nonCanonical);
    const payload = { ...createMeasurementScopePayload(), hmac_key_base64: nonCanonical };
    const { errors } = validateMeasurementScopeFileShape(payload);
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).not.toContain(nonCanonical);
  });

  it('never echoes the hmac_key_base64 value in any error message, even when it IS the violation', () => {
    const payload = { ...createMeasurementScopePayload(), hmac_key_base64: 'clearly-invalid-value-xyz' };
    const { errors } = validateMeasurementScopeFileShape(payload);
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).not.toContain('clearly-invalid-value-xyz');
  });
});

// ---------------------------------------------------------------------------------------------
// Injectable-spawnFn unit coverage -- every branch reachable deterministically without a real
// repo. Mirrors evidence-io.mjs's isRawDirSafeFromAccidentalCommit's own precise status/stderr
// matching (see that function's doc comment) rather than treating "any non-zero exit" as safe.
function fakeSpawn({ toplevel, lsFiles, checkIgnore }) {
  return (_cmd, args) => {
    if (args.includes('rev-parse')) return toplevel;
    if (args.includes('ls-files')) return lsFiles;
    if (args.includes('check-ignore')) return checkIgnore;
    throw new Error(`unexpected git invocation in test fake: ${args.join(' ')}`);
  };
}
const OUTSIDE_REPO = { error: null, status: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' };
const INDETERMINATE_STATUS = { error: null, status: 1, stdout: '', stderr: 'some other git failure' };
const SPAWN_ERROR = { error: new Error('ENOENT: git not found'), status: null, stdout: '', stderr: '' };

describe('isMeasurementScopePathSafe -- injectable spawnFn, every branch', () => {
  const p = path.join(os.tmpdir(), 'ams-fake-probe', 'scope.json');

  it('confirmed outside any repo -> safe', () => {
    expect(isMeasurementScopePathSafe(p, realFs, fakeSpawn({ toplevel: OUTSIDE_REPO })).safe).toBe(true);
  });

  it('indeterminate outside-check (unexpected status) -> unsafe', () => {
    expect(isMeasurementScopePathSafe(p, realFs, fakeSpawn({ toplevel: INDETERMINATE_STATUS })).safe).toBe(false);
  });

  it('indeterminate outside-check (spawn error) -> unsafe', () => {
    expect(isMeasurementScopePathSafe(p, realFs, fakeSpawn({ toplevel: SPAWN_ERROR })).safe).toBe(false);
  });

  it('inside a repo, tracked -> unsafe', () => {
    const toplevel = { error: null, status: 0, stdout: '/fake/repo\n', stderr: '' };
    const lsFiles = { error: null, status: 0, stdout: `${p}\n`, stderr: '' };
    expect(isMeasurementScopePathSafe(p, realFs, fakeSpawn({ toplevel, lsFiles })).safe).toBe(false);
  });

  it('inside a repo, indeterminate tracked-check -> unsafe', () => {
    const toplevel = { error: null, status: 0, stdout: '/fake/repo\n', stderr: '' };
    const lsFiles = INDETERMINATE_STATUS;
    expect(isMeasurementScopePathSafe(p, realFs, fakeSpawn({ toplevel, lsFiles })).safe).toBe(false);
  });

  it('inside a repo, untracked and confirmed ignored -> safe', () => {
    const toplevel = { error: null, status: 0, stdout: '/fake/repo\n', stderr: '' };
    const lsFiles = { error: null, status: 0, stdout: '', stderr: '' };
    const checkIgnore = { error: null, status: 0, stdout: '', stderr: '' };
    expect(isMeasurementScopePathSafe(p, realFs, fakeSpawn({ toplevel, lsFiles, checkIgnore })).safe).toBe(true);
  });

  it('inside a repo, untracked but NOT ignored -> unsafe', () => {
    const toplevel = { error: null, status: 0, stdout: '/fake/repo\n', stderr: '' };
    const lsFiles = { error: null, status: 0, stdout: '', stderr: '' };
    const checkIgnore = { error: null, status: 1, stdout: '', stderr: '' };
    expect(isMeasurementScopePathSafe(p, realFs, fakeSpawn({ toplevel, lsFiles, checkIgnore })).safe).toBe(false);
  });

  it('inside a repo, untracked, indeterminate ignore-check -> unsafe', () => {
    const toplevel = { error: null, status: 0, stdout: '/fake/repo\n', stderr: '' };
    const lsFiles = { error: null, status: 0, stdout: '', stderr: '' };
    const checkIgnore = SPAWN_ERROR;
    expect(isMeasurementScopePathSafe(p, realFs, fakeSpawn({ toplevel, lsFiles, checkIgnore })).safe).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('isMeasurementScopePathSafe -- real git integration', () => {
  it('confirms safe for a destination genuinely outside any git repository', () => {
    const outside = mkTemp('ams-outside-repo-');
    expect(isMeasurementScopePathSafe(path.join(outside, 'scope.json')).safe).toBe(true);
  });

  it('confirms UNSAFE for an untracked path inside a real repo with no covering .gitignore rule', () => {
    const repoDir = mkTemp('ams-inrepo-uncovered-');
    initRepo(repoDir);
    expect(isMeasurementScopePathSafe(path.join(repoDir, 'uncovered-scope.json')).safe).toBe(false);
  });

  it('confirms safe for an untracked path inside a real repo that IS covered by .gitignore', () => {
    const repoDir = mkTemp('ams-inrepo-ignored-');
    initRepo(repoDir);
    writeFileSync(path.join(repoDir, '.gitignore'), 'scope.json\n');
    expect(isMeasurementScopePathSafe(path.join(repoDir, 'scope.json')).safe).toBe(true);
  });

  it('confirms UNSAFE for a path that is already tracked, even if a later .gitignore rule would now cover it', () => {
    const repoDir = mkTemp('ams-tracked-');
    initRepo(repoDir);
    commitFile(repoDir, 'scope.json', '{}');
    writeFileSync(path.join(repoDir, '.gitignore'), 'scope.json\n');
    expect(isMeasurementScopePathSafe(path.join(repoDir, 'scope.json')).safe).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('loadMeasurementScopeFile', () => {
  it('fails closed on a missing file', () => {
    expect(() => loadMeasurementScopeFile(path.join(os.tmpdir(), 'ams-does-not-exist.json'))).toThrow(/not found/);
  });

  // An empty string is not "no path" -- path.resolve('') falls back to process.cwd(), which
  // would otherwise silently treat "" as "load the current working directory" instead of
  // rejecting it outright.
  it('rejects an empty string path explicitly, not via path.resolve("")\'s cwd fallback', () => {
    expect(() => loadMeasurementScopeFile('')).toThrow(/must not be empty/);
  });

  it('fails closed on unparseable JSON', () => {
    const dir = mkTemp('ams-badjson-');
    const file = path.join(dir, 'scope.json');
    writeFileSync(file, 'not valid json', { mode: 0o600 });
    expect(() => loadMeasurementScopeFile(file)).toThrow(/not valid JSON/);
  });

  it('fails closed on a shape violation', () => {
    const dir = mkTemp('ams-badshape-');
    const file = path.join(dir, 'scope.json');
    writeFileSync(file, JSON.stringify({ schema: 1, scope_id: 'not-a-uuid', hmac_key_base64: 'x' }), { mode: 0o600 });
    expect(() => loadMeasurementScopeFile(file)).toThrow(/invalid/);
  });

  it('loads a valid file, returning {scopeId, key} matching its content exactly', () => {
    const dir = mkTemp('ams-goodload-');
    const file = path.join(dir, 'scope.json');
    const payload = createMeasurementScopePayload();
    writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
    const { scopeId, key } = loadMeasurementScopeFile(file);
    expect(scopeId).toBe(payload.scope_id);
    expect(key.equals(Buffer.from(payload.hmac_key_base64, 'base64'))).toBe(true);
  });

  it('fails closed when the path is inside a repo and not confirmed ignored', () => {
    const repoDir = mkTemp('ams-load-unsafe-');
    initRepo(repoDir);
    const file = path.join(repoDir, 'scope.json');
    writeFileSync(file, JSON.stringify(createMeasurementScopePayload()));
    expect(() => loadMeasurementScopeFile(file)).toThrow(/refusing to load/);
  });

  // Permissions can loosen after creation through no fault of this module (a backup/restore, a
  // different tool, a manual copy) -- re-verified on every LOAD, not just at creation time, since
  // createMeasurementScopeFileExclusive's own guarantee only covers the moment of creation.
  describe('POSIX mode re-verification on load (win32: no-op, no ACL guarantee claimed)', () => {
    if (process.platform !== 'win32') {
      it('accepts a file whose real mode is exactly 0600', () => {
        const dir = mkTemp('ams-load-mode-0600-');
        const file = path.join(dir, 'scope.json');
        const created = createMeasurementScopeFileExclusive(file);
        const { scopeId } = loadMeasurementScopeFile(file);
        expect(scopeId).toBe(created.scopeId);
      });

      it('rejects a file whose mode was loosened to 0644 after creation', () => {
        const dir = mkTemp('ams-load-mode-0644-');
        const file = path.join(dir, 'scope.json');
        createMeasurementScopeFileExclusive(file);
        realFs.chmodSync(file, 0o644);
        expect(() => loadMeasurementScopeFile(file)).toThrow(/0600/);
      });

      it('rejects when the file mode cannot be determined at all (indeterminate stat)', () => {
        const dir = mkTemp('ams-load-mode-indeterminate-');
        const file = path.join(dir, 'scope.json');
        createMeasurementScopeFileExclusive(file);
        const fakeFsImpl = { ...realFs, statSync: () => { throw new Error('simulated stat failure'); } };
        expect(() => loadMeasurementScopeFile(file, fakeFsImpl)).toThrow(/simulated stat failure/);
      });
    } else {
      it('is a deliberate no-op on Windows -- Node cannot set POSIX bits or enforce ACLs', () => {
        const dir = mkTemp('ams-load-mode-win32-');
        const file = path.join(dir, 'scope.json');
        const created = createMeasurementScopeFileExclusive(file);
        expect(() => loadMeasurementScopeFile(file)).not.toThrow();
        expect(loadMeasurementScopeFile(file).scopeId).toBe(created.scopeId);
      });
    }
  });

  // Correction 3b, direction 1: a symlink whose OWN name is ignored, resolving to a TRACKED file
  // -- checking only the presented path would wrongly see it as "ignored" and never notice the
  // resolved destination is tracked.
  describe('symlinks -- direction 1 (ignored symlink resolving to a tracked file)', () => {
    it('rejects via the injectable realpathSync seam (portable, incl. Windows)', () => {
      const repoDir = mkTemp('ams-symlink1-fake-');
      initRepo(repoDir);
      commitFile(repoDir, 'real.json', JSON.stringify(createMeasurementScopePayload()));
      writeFileSync(path.join(repoDir, '.gitignore'), 'link.json\n');
      const linkPath = path.join(repoDir, 'link.json');
      const realTarget = realFs.realpathSync(path.join(repoDir, 'real.json'));
      const fakeFsImpl = { ...realFs, realpathSync: (p) => (p === path.resolve(linkPath) ? realTarget : realFs.realpathSync(p)) };
      expect(() => loadMeasurementScopeFile(linkPath, fakeFsImpl, spawnSync)).toThrow(/refusing to load/);
    });

    if (process.platform !== 'win32') {
      it('rejects via a REAL symlink (POSIX integration)', () => {
        const repoDir = mkTemp('ams-symlink1-real-');
        initRepo(repoDir);
        commitFile(repoDir, 'real.json', JSON.stringify(createMeasurementScopePayload()));
        writeFileSync(path.join(repoDir, '.gitignore'), 'link.json\n');
        realFs.symlinkSync('real.json', path.join(repoDir, 'link.json'));
        expect(() => loadMeasurementScopeFile(path.join(repoDir, 'link.json'))).toThrow(/refusing to load/);
      });
    }
  });

  // Correction 3b, direction 2 (the final round's fix): a symlink that is itself tracked/
  // unignored, resolving to an otherwise-SAFE destination -- checking only the resolved
  // destination (the pre-final-round design) would wrongly accept this.
  describe('symlinks -- direction 2 (tracked/unignored symlink resolving to a safe destination)', () => {
    it('rejects via the injectable realpathSync seam (portable, incl. Windows)', () => {
      const repoDir = mkTemp('ams-symlink2-fake-');
      initRepo(repoDir);
      // link.json itself is tracked and carries no .gitignore coverage -- this is the unsafe
      // PRESENTED path; it need not even resolve to real content, since presentedSafety must
      // reject before resolvedPath's content is ever inspected.
      commitFile(repoDir, 'link.json', 'placeholder');
      const safeDir = mkTemp('ams-symlink2-safetarget-');
      const safeTarget = path.join(safeDir, 'safe.json');
      writeFileSync(safeTarget, JSON.stringify(createMeasurementScopePayload()));
      // Sanity check: the safe target ALONE would pass -- proving the rejection below is really
      // coming from the presented-path check, not incidentally from the resolved one too.
      expect(isMeasurementScopePathSafe(safeTarget).safe).toBe(true);
      const linkPath = path.join(repoDir, 'link.json');
      const fakeFsImpl = { ...realFs, realpathSync: (p) => (p === path.resolve(linkPath) ? realFs.realpathSync(safeTarget) : realFs.realpathSync(p)) };
      expect(() => loadMeasurementScopeFile(linkPath, fakeFsImpl, spawnSync)).toThrow(/refusing to load/);
    });

    if (process.platform !== 'win32') {
      it('rejects via a REAL symlink (POSIX integration)', () => {
        const repoDir = mkTemp('ams-symlink2-real-');
        initRepo(repoDir);
        const safeDir = mkTemp('ams-symlink2-real-safetarget-');
        const safeTarget = path.join(safeDir, 'safe.json');
        writeFileSync(safeTarget, JSON.stringify(createMeasurementScopePayload()));
        realFs.symlinkSync(safeTarget, path.join(repoDir, 'link.json'));
        gitViaBash(['add', '-A'], repoDir);
        gitViaBash(['commit', '-q', '-m', 'add tracked symlink'], repoDir);
        expect(() => loadMeasurementScopeFile(path.join(repoDir, 'link.json'))).toThrow(/refusing to load/);
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('createMeasurementScopeFileExclusive', () => {
  it('creates a valid file; returns only {scopeId}, never the key', () => {
    const dir = mkTemp('ams-create-success-');
    const file = path.join(dir, 'scope.json');
    const result = createMeasurementScopeFileExclusive(file);
    expect(Object.keys(result)).toEqual(['scopeId']);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.scope_id).toBe(result.scopeId);
    expect(validateMeasurementScopeFileShape(written).errors).toEqual([]);
    expect(tmpSiblingsOf(dir)).toEqual([]);
  });

  if (process.platform !== 'win32') {
    it('sets real mode 0600 on POSIX, verified via statSync (not merely asserted in code)', () => {
      const dir = mkTemp('ams-create-mode-');
      const file = path.join(dir, 'scope.json');
      createMeasurementScopeFileExclusive(file);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });
  }

  it('refuses to overwrite an existing file; leaves the original byte-identical', () => {
    const dir = mkTemp('ams-create-noclobber-');
    const file = path.join(dir, 'scope.json');
    const first = createMeasurementScopeFileExclusive(file);
    const beforeContent = readFileSync(file, 'utf8');
    expect(() => createMeasurementScopeFileExclusive(file)).toThrow(/refusing to overwrite/);
    expect(readFileSync(file, 'utf8')).toBe(beforeContent);
    expect(JSON.parse(beforeContent).scope_id).toBe(first.scopeId);
    expect(tmpSiblingsOf(dir)).toEqual([]);
  });

  // Correction 4a: a failure DURING the tmp write (after openSync(tmp,'wx',0o600) already
  // succeeded) must still remove the tmp file -- tmpOwnedByUs is set immediately after open,
  // before the write, precisely so this cleanup fires even on a write-time failure.
  it('a partial failure after tmp creation leaves no tmp file and no final file behind', () => {
    const dir = mkTemp('ams-create-partial-');
    const file = path.join(dir, 'scope.json');
    const fakeFsImpl = { ...realFs, writeFileSync: () => { throw new Error('simulated partial write failure'); } };
    expect(() => createMeasurementScopeFileExclusive(file, fakeFsImpl)).toThrow(/simulated partial write failure/);
    expect(existsSync(file)).toBe(false);
    expect(tmpSiblingsOf(dir)).toEqual([]);
  });

  // Correction 4b: an exact-filename .gitignore entry covers the FINAL name but not its
  // `.tmp.<pid>.<hex>` sibling -- proving the fix checks BOTH paths, not just the final one.
  it('rejects when the final name is ignored but its tmp sibling is not (checking only the final path would wrongly pass)', () => {
    const repoDir = mkTemp('ams-create-tmp-uncovered-');
    initRepo(repoDir);
    writeFileSync(path.join(repoDir, '.gitignore'), 'scope.json\n');
    const file = path.join(repoDir, 'scope.json');
    // Sanity check proving this is really about the tmp sibling: the final path ALONE passes.
    expect(isMeasurementScopePathSafe(file).safe).toBe(true);
    expect(() => createMeasurementScopeFileExclusive(file)).toThrow(/refusing to create/);
    expect(existsSync(file)).toBe(false);
    expect(tmpSiblingsOf(repoDir)).toEqual([]);
  });

  // Correction 4d: the exclusive ('wx') fallback -- used when linkSync fails for a reason OTHER
  // than EEXIST (e.g. no hard-link support) -- must get the SAME rigor as the primary path: a
  // full write and a verified final 0600 mode, with precise rollback on either failing.
  describe('exclusive (wx) fallback rigor', () => {
    function forceNonEexistLinkFailure() {
      return () => { const e = new Error('simulated cross-device link'); e.code = 'EXDEV'; throw e; };
    }

    it('falls through to the wx fallback when linkSync fails non-EEXIST, and still succeeds cleanly', () => {
      const dir = mkTemp('ams-fallback-success-');
      const file = path.join(dir, 'scope.json');
      const fakeFsImpl = { ...realFs, linkSync: forceNonEexistLinkFailure() };
      const result = createMeasurementScopeFileExclusive(file, fakeFsImpl);
      const written = JSON.parse(readFileSync(file, 'utf8'));
      expect(written.scope_id).toBe(result.scopeId);
      expect(tmpSiblingsOf(dir)).toEqual([]);
    });

    it('a short/failed write in the fallback rolls back the partially-created final file', () => {
      const dir = mkTemp('ams-fallback-shortwrite-');
      const file = path.join(dir, 'scope.json');
      let writeCallCount = 0;
      const fakeFsImpl = {
        ...realFs,
        linkSync: forceNonEexistLinkFailure(),
        writeFileSync: (fd, content, enc) => {
          writeCallCount++;
          if (writeCallCount === 1) return realFs.writeFileSync(fd, content, enc); // tmp write: succeeds
          throw new Error('simulated short write in fallback'); // fallback write: fails
        },
      };
      expect(() => createMeasurementScopeFileExclusive(file, fakeFsImpl)).toThrow(/simulated short write in fallback/);
      expect(existsSync(file)).toBe(false);
      expect(tmpSiblingsOf(dir)).toEqual([]);
    });

    if (process.platform !== 'win32') {
      it('a wrong final mode in the fallback rolls back the final file (POSIX only)', () => {
        const dir = mkTemp('ams-fallback-wrongmode-');
        const file = path.join(dir, 'scope.json');
        const absFile = path.resolve(file);
        const fakeFsImpl = {
          ...realFs,
          linkSync: forceNonEexistLinkFailure(),
          statSync: (p) => {
            const real = realFs.statSync(p);
            if (path.resolve(p) === absFile) return { ...real, mode: (real.mode & ~0o777) | 0o644 };
            return real;
          },
        };
        expect(() => createMeasurementScopeFileExclusive(file, fakeFsImpl)).toThrow(/0600/);
        expect(existsSync(file)).toBe(false);
        expect(tmpSiblingsOf(dir)).toEqual([]);
      });
    }
  });

  // Correction 4e: explicit contract for a not-yet-existing parent directory.
  describe('non-existent parent directory contract', () => {
    it('succeeds into a not-yet-existing (nested) subdirectory when safe -- directory is created', () => {
      const base = mkTemp('ams-newdir-');
      const file = path.join(base, 'sub1', 'sub2', 'scope.json');
      const result = createMeasurementScopeFileExclusive(file);
      expect(existsSync(file)).toBe(true);
      expect(JSON.parse(readFileSync(file, 'utf8')).scope_id).toBe(result.scopeId);
    });

    it('an ancestor that resolves indeterminate is rejected BEFORE any directory is created', () => {
      const base = mkTemp('ams-newdir-unsafe-');
      const targetDir = path.join(base, 'not-yet-existing-subdir');
      const file = path.join(targetDir, 'scope.json');
      const alwaysIndeterminate = () => INDETERMINATE_STATUS;
      expect(() => createMeasurementScopeFileExclusive(file, realFs, alwaysIndeterminate)).toThrow(/refusing to create/);
      expect(existsSync(targetDir)).toBe(false);
    });

    // Proves the post-mkdirSync re-validation genuinely re-checks rather than caching the first
    // context: the fake answers "outside any repo" (safe) on the FIRST rev-parse call -- letting
    // the pre-mkdir check and mkdirSync itself succeed -- then answers indeterminate on the
    // SECOND, which must still fail the overall call.
    it('the post-mkdirSync re-validation is real, not a no-op', () => {
      const base = mkTemp('ams-newdir-revalidate-');
      const targetDir = path.join(base, 'fresh-subdir');
      const file = path.join(targetDir, 'scope.json');
      let revParseCalls = 0;
      const spawnFn = (_cmd, args) => {
        if (args.includes('rev-parse')) {
          revParseCalls++;
          return revParseCalls === 1 ? OUTSIDE_REPO : INDETERMINATE_STATUS;
        }
        throw new Error(`unexpected git invocation: ${args.join(' ')}`);
      };
      expect(() => createMeasurementScopeFileExclusive(file, realFs, spawnFn)).toThrow(/refusing to create/);
      expect(revParseCalls).toBe(2);
      expect(existsSync(file)).toBe(false);
    });
  });
});

// tests/vitest/agentic-eval-resolve-bash.test.js
// Unit tests for tools/agentic-eval/resolve-bash.mjs -- resolveBash() must never silently
// return a bare 'bash' on Windows (PATH-ambiguous between Git Bash and WSL's launcher).
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveBash, WINDOWS_GIT_BASH_CANDIDATES } from '../../tools/agentic-eval/resolve-bash.mjs';

const originalEnvValue = process.env.KMP_EVAL_BASH_PATH;
afterEach(() => {
  if (originalEnvValue === undefined) delete process.env.KMP_EVAL_BASH_PATH;
  else process.env.KMP_EVAL_BASH_PATH = originalEnvValue;
});

describe('resolveBash', () => {
  it('on this host, resolves to a real, existing executable path', () => {
    const resolved = resolveBash({ fresh: true });
    expect(typeof resolved).toBe('string');
    expect(resolved.length).toBeGreaterThan(0);
    if (process.platform === 'win32') {
      expect(existsSync(resolved)).toBe(true);
    }
  });

  it('on win32, never returns the bare ambiguous string "bash"', () => {
    if (process.platform !== 'win32') return;
    expect(resolveBash({ fresh: true })).not.toBe('bash');
  });

  it('on win32, resolves to one of the well-known Git Bash candidates (on this dev machine)', () => {
    if (process.platform !== 'win32') return;
    const resolved = resolveBash({ fresh: true });
    // Either a well-known candidate, or a `where git`-derived path -- both are absolute,
    // existing, non-ambiguous paths. Assert existence + non-bare-ness (already covered above);
    // additionally assert it's under a Git-looking install root as a sanity check.
    expect(resolved.toLowerCase()).toContain('git');
  });

  it('KMP_EVAL_BASH_PATH override is honored when it points at a real file', () => {
    // Use this test file itself as a stand-in "exists" path -- resolveBash() only checks
    // existence, not that it's actually bash. fileURLToPath() (not a naive string replace) is
    // required for a correct absolute path on POSIX -- stripping the literal 'file:///' prefix
    // from a POSIX file URL also strips the path's own leading '/', turning an absolute path
    // into a relative-looking one (confirmed: broke this exact test on Linux CI).
    const thisFile = fileURLToPath(import.meta.url);
    process.env.KMP_EVAL_BASH_PATH = thisFile;
    expect(resolveBash({ fresh: true })).toBe(thisFile);
  });

  it('KMP_EVAL_BASH_PATH override throws when it points at a nonexistent file', () => {
    process.env.KMP_EVAL_BASH_PATH = 'C:\\this-file-does-not-exist-xyz-12345.exe';
    expect(() => resolveBash({ fresh: true })).toThrow(/does not exist/);
  });

  it('caches the resolution across calls unless {fresh:true} is passed', () => {
    delete process.env.KMP_EVAL_BASH_PATH;
    const first = resolveBash({ fresh: true });
    process.env.KMP_EVAL_BASH_PATH = 'C:\\this-file-does-not-exist-xyz-12345.exe';
    // Without fresh:true, the cached value from the previous call is returned, NOT re-read from
    // (now-invalid) env -- proves caching, not that the override is ignored.
    expect(resolveBash()).toBe(first);
  });

  it('exports the well-known candidate list for the harness README / diagnostics to reference', () => {
    expect(Array.isArray(WINDOWS_GIT_BASH_CANDIDATES)).toBe(true);
    expect(WINDOWS_GIT_BASH_CANDIDATES.length).toBeGreaterThan(0);
  });
});

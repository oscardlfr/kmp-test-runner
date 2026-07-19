// tests/vitest/agentic-eval-plugin-snapshot-identity.test.js
// Isolated unit tests for isPluginBoundToSnapshot's filesystem-IDENTITY comparison (cli.mjs),
// proving it compares dev+ino (via statSync) rather than any string form of the resolved path.
//
// A review-round-5 finding demonstrated the PREVIOUS implementation
// (`resolvedReported.toLowerCase() === resolvedExpected.toLowerCase()` on win32, after resolving
// both sides with realpath) is unsound on NTFS volumes with per-directory case sensitivity
// enabled (fsutil.exe file setCaseSensitiveInfo, shipped for WSL interop since Windows 10 1803):
// under that mode, two DIFFERENTLY-cased paths can be two genuinely DISTINCT directories that a
// case-folded string comparison would wrongly treat as the same snapshot -- a false positive here
// would approve the WRONG plugin outright, exactly the provenance guarantee this function exists
// to protect.
//
// A literal case-sensitive-NTFS directory isn't reproducible in this test environment: enabling
// it requires a persistent, system-level NTFS attribute change (out of scope for a test to
// configure, and would not be portable to CI, since standard CI images don't have it pre-enabled
// either). This file instead mocks node:fs's statSync/realpathSync -- scoped to ONLY this file
// (Vitest isolates module mocks per test file; nothing here affects
// agentic-eval-hard-gates.test.js's own real-filesystem-based tests, which never import this
// module) -- to construct the exact scenario directly: two path strings that a case-fold would
// treat as equal, stat'd to two DIFFERENT (dev,ino) pairs. Verified directly against BOTH
// implementations during review: the OLD code (realpath + toLowerCase) returns {ok:true} for the
// "different filesystem entries" case below (the bug); the NEW code (dev+ino via statSync)
// correctly returns false.
import { describe, it, expect, vi } from 'vitest';

const { statResults, realpathResults } = vi.hoisted(() => ({
  statResults: new Map(),
  realpathResults: new Map(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // Only paths explicitly registered by a test are intercepted -- everything else (including
    // whatever real paths cli.mjs's own module-level isRunsRootDefault() computation touches at
    // import time) falls through to the real implementation, unaffected.
    statSync: (path, opts) => {
      if (statResults.has(path)) {
        const result = statResults.get(path);
        if (result instanceof Error) throw result;
        return result;
      }
      return actual.statSync(path, opts);
    },
    realpathSync: (path) => {
      if (realpathResults.has(path)) return realpathResults.get(path);
      return actual.realpathSync(path);
    },
  };
});

const { isPluginBoundToSnapshot } = await import('../../tools/agentic-eval/cli.mjs');

describe('isPluginBoundToSnapshot -- filesystem identity, not a string comparison', () => {
  it('rejects two differently-cased paths that resolve to genuinely DIFFERENT filesystem entries (the NTFS case-sensitivity bypass this closes)', () => {
    statResults.clear();
    realpathResults.clear();
    // realpathSync is a no-op passthrough for these fake paths -- what matters is that the two
    // strings, once case-folded, would have been byte-identical.
    realpathResults.set('C:\\snapshot\\ABC', 'C:\\snapshot\\ABC');
    realpathResults.set('C:\\snapshot\\abc', 'C:\\snapshot\\abc');
    // Same volume (dev), but a DIFFERENT entry (ino) -- exactly what NTFS per-directory case
    // sensitivity makes possible.
    statResults.set('C:\\snapshot\\ABC', { dev: 1n, ino: 100n });
    statResults.set('C:\\snapshot\\abc', { dev: 1n, ino: 200n });

    const initEvent = { plugins: [{ name: 'kmp-test-runner', path: 'C:\\snapshot\\ABC', source: 'fake' }] };
    expect(isPluginBoundToSnapshot(initEvent, 'C:\\snapshot\\abc')).toBe(false);
  });

  it('accepts two syntactically different path strings that resolve to the SAME filesystem entry (doesn\'t over-reject)', () => {
    statResults.clear();
    realpathResults.clear();
    realpathResults.set('C:\\snapshot\\real', 'C:\\snapshot\\real');
    realpathResults.set('C:\\snapshot\\real\\', 'C:\\snapshot\\real');
    // Both keys map to the SAME (dev,ino) -- a trailing separator is a different string but the
    // same filesystem entry, which is what a real stat syscall would also report.
    statResults.set('C:\\snapshot\\real', { dev: 1n, ino: 100n });
    statResults.set('C:\\snapshot\\real\\', { dev: 1n, ino: 100n });

    const initEvent = { plugins: [{ name: 'kmp-test-runner', path: 'C:\\snapshot\\real', source: 'fake' }] };
    expect(isPluginBoundToSnapshot(initEvent, 'C:\\snapshot\\real\\')).toBe(true);
  });
});

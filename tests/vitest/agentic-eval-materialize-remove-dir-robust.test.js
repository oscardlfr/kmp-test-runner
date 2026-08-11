// tests/vitest/agentic-eval-materialize-remove-dir-robust.test.js
// Isolated test for materialize.mjs's removeDirRobust() -- a scoped mock of node:fs's rmSync and
// existsSync, kept in its own file rather than agentic-eval-materialize.test.js, matching this
// repo's established node:fs-mock-isolation convention (see
// coverage-orchestrator-report-write-failure.test.js's own header comment): vi.mock() is hoisted
// and module-wide, so it would otherwise break every OTHER real-filesystem test in that file.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync as realRmSync, existsSync as realExistsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let rmSyncFailCount = 0; // how many times rmSync should still throw before succeeding
let rmSyncCallCount = 0;
let forceStillExistsAfter = false; // simulate "removal reported success but the dir is still there"

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rmSync: (p, opts) => {
      rmSyncCallCount += 1;
      if (rmSyncCallCount <= rmSyncFailCount) {
        const err = new Error(`EBUSY: resource busy or locked, rmdir '${p}' (simulated)`);
        err.code = 'EBUSY';
        throw err;
      }
      return actual.rmSync(p, opts);
    },
    existsSync: (p) => {
      if (forceStillExistsAfter) return true;
      return actual.existsSync(p);
    },
  };
});

describe('removeDirRobust -- bounded retry on transient Windows errors, verified postcondition', () => {
  it('succeeds immediately when the first rmSync call succeeds', async () => {
    rmSyncFailCount = 0;
    rmSyncCallCount = 0;
    forceStillExistsAfter = false;
    const { removeDirRobust } = await import('../../tools/agentic-eval/materialize.mjs');
    const dir = mkdtempSync(path.join(tmpdir(), 'aemrdr-'));
    expect(() => removeDirRobust(dir, { delays: [1, 1, 1] })).not.toThrow();
    expect(realExistsSync(dir)).toBe(false);
  });

  it('retries a bounded number of times on EBUSY/EPERM/EACCES and succeeds once the transient condition clears', async () => {
    rmSyncFailCount = 2; // first two calls throw, third succeeds
    rmSyncCallCount = 0;
    forceStillExistsAfter = false;
    const { removeDirRobust } = await import('../../tools/agentic-eval/materialize.mjs');
    const dir = mkdtempSync(path.join(tmpdir(), 'aemrdr-'));
    expect(() => removeDirRobust(dir, { delays: [1, 1, 1] })).not.toThrow();
    expect(rmSyncCallCount).toBe(3);
    expect(realExistsSync(dir)).toBe(false);
  });

  it('throws -- never silently reports success -- when the directory still exists after retries are exhausted', async () => {
    rmSyncFailCount = 0; // rmSync itself always "succeeds" (never throws)...
    rmSyncCallCount = 0;
    forceStillExistsAfter = true; // ...but the postcondition check says the directory is still there
    const { removeDirRobust } = await import('../../tools/agentic-eval/materialize.mjs');
    const dir = mkdtempSync(path.join(tmpdir(), 'aemrdr-'));
    try {
      expect(() => removeDirRobust(dir, { delays: [1, 1] })).toThrow(/still exists|postcondition|failed to remove/i);
    } finally {
      forceStillExistsAfter = false;
      realRmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws the real error (never silently swallows) when rmSync keeps failing past the retry budget', async () => {
    rmSyncFailCount = 999; // always throws
    rmSyncCallCount = 0;
    forceStillExistsAfter = false;
    const { removeDirRobust } = await import('../../tools/agentic-eval/materialize.mjs');
    const dir = mkdtempSync(path.join(tmpdir(), 'aemrdr-'));
    try {
      expect(() => removeDirRobust(dir, { delays: [1, 1] })).toThrow(/EBUSY/);
      // Exactly 1 + delays.length attempts -- bounded, not infinite.
      expect(rmSyncCallCount).toBe(3);
    } finally {
      rmSyncFailCount = 0;
      realRmSync(dir, { recursive: true, force: true });
    }
  });

  it('is injectable (rmFn) for tests without relying on the module-wide node:fs mock', async () => {
    const { removeDirRobust } = await import('../../tools/agentic-eval/materialize.mjs');
    let calls = 0;
    const dir = mkdtempSync(path.join(tmpdir(), 'aemrdr-'));
    mkdirSync(path.join(dir, 'nested'), { recursive: true });
    const fakeRm = (p, opts) => { calls += 1; realRmSync(p, opts); };
    const fakeExists = () => false;
    removeDirRobust(dir, { delays: [], rmFn: fakeRm, existsFn: fakeExists });
    expect(calls).toBe(1);
  });
});

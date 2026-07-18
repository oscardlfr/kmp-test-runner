// tests/vitest/agentic-eval-materialize-best-effort-cleanup.test.js
// Isolated test for materialize.mjs's acquisition-rollback robustness, via a scoped mock of
// node:fs's rmSync -- kept in its own file rather than agentic-eval-materialize.test.js, matching
// this repo's established node:fs-mock-isolation convention (see
// coverage-orchestrator-report-write-failure.test.js's own header comment): vi.mock() is hoisted
// and module-wide, so it would otherwise break every OTHER real-filesystem test in that file.
//
// Regression coverage for a real robustness gap an independent review pass found:
// materializeGradleUserHome()'s (and materializeSkillSnapshot's / materializeCalibrationProject's)
// acquisition-failure catch block called rmSync directly. If the FIRST rmSync itself throws --
// realistic on Windows, where a still-exiting child process can transiently lock a directory --
// two things went wrong: the ORIGINAL acquisition error (the actual reason cleanup started) was
// MASKED by the new rmSync exception, and materializeGradleUserHome's SECOND cleanup step
// (removing its own separate snapshotDir) never ran at all, since nothing after the throwing line
// executes. Fixed via bestEffortRemove() -- each removal now swallows its own failure
// independently, so every queued step still gets attempted and the original `err` a caller
// already has in scope is always what gets rethrown.
import { describe, it, expect, vi } from 'vitest';
import { readdirSync, mkdtempSync, rmSync as realRmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Fails only the FIRST rmSync call process-wide (regardless of which path it targets), succeeds
// on every call after that -- simulates "the first cleanup step hits a transient lock," the exact
// scenario the fix exists for, without needing to know materialize.mjs's internally-generated
// temp-dir names ahead of time (mkdtempSync appends random characters this test can't predict).
let rmSyncCallCount = 0;
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rmSync: (p, opts) => {
      rmSyncCallCount += 1;
      if (rmSyncCallCount === 1) {
        const err = new Error(`EBUSY: resource busy or locked, rmdir '${p}' (simulated)`);
        err.code = 'EBUSY';
        throw err;
      }
      return actual.rmSync(p, opts);
    },
  };
});

describe('materializeGradleUserHome -- acquisition rollback is itself best-effort', () => {
  it('still rethrows the ORIGINAL error (not masked) AND still removes the second temp dir, even when removing the first one throws', async () => {
    const { materializeGradleUserHome } = await import('../../tools/agentic-eval/materialize.mjs');

    const isolatedTmp = mkdtempSync(path.join(tmpdir(), 'aemat-best-effort-'));
    const originalEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = isolatedTmp;
    process.env.TMP = isolatedTmp;
    process.env.TMPDIR = isolatedTmp;
    try {
      let thrown = null;
      try {
        materializeGradleUserHome({
          runPrewarm: () => { throw new Error('injected prewarm failure'); },
        });
      } catch (err) {
        thrown = err;
      }
      // The ORIGINAL error, not the simulated EBUSY from the first (failing) cleanup attempt.
      expect(thrown?.message).toBe('injected prewarm failure');

      // Exactly ONE leftover entry -- the directory whose OWN removal genuinely failed (the
      // first rmSync call, simulated-locked by the mock). If the pre-fix bug were still present,
      // the second directory's removal would never even have been attempted, leaving TWO entries
      // instead of one.
      expect(readdirSync(isolatedTmp).length).toBe(1);
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      realRmSync(isolatedTmp, { recursive: true, force: true });
    }
  });
});

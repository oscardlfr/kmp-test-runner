// tests/vitest/agentic-eval-write-evidence-atomic-promotion.test.js
// Isolated test for writeRunRecordEvidence()'s promotion step being genuinely ATOMIC and
// EXCLUSIVE, via a scoped mock of node:fs's existsSync -- kept in its own file rather than
// agentic-eval-cli.test.js, matching this repo's established node:fs-mock-isolation convention
// (see coverage-orchestrator-report-write-failure.test.js's own header comment): vi.mock() is
// hoisted and module-wide, so it would otherwise break every other test in that file.
//
// Regression coverage for a real TOCTOU race an independent review pass reproduced directly with
// two synchronized workers: writeRunRecordEvidence()'s upfront existsSync() pre-check and its
// (formerly renameSync-based) promotion step were two SEPARATE operations with a window between
// them -- a second invocation could pass the pre-check (target doesn't exist YET) before the
// first invocation's promotion actually lands, and both would then "succeed," one silently
// overwriting the other's evidence.
//
// A true two-OS-process race is inherently non-deterministic to test reliably. This instead
// forces the exact race WINDOW deterministically: existsSync is mocked to always report "does not
// exist" for target paths (simulating "this invocation's pre-check ran before the file existed"),
// while the REAL file is pre-created on disk beforehand (simulating "another invocation's
// promotion already landed by the time this one tries to promote"). Every OTHER fs call
// (writeFileSync, mkdirSync, linkSync, rmSync, readFileSync) is real. If the fix genuinely closed
// the race, the call must still refuse via linkSync's own atomic EEXIST behavior -- the pre-check
// lying is exactly what proves the REAL safety net is the promotion step, not the pre-check.
import { describe, it, expect, vi } from 'vitest';
import { existsSync as realExistsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: (p) => {
      if (String(p).includes('RACE-TARGET-')) return false; // lie: pre-check never sees it
      return actual.existsSync(p);
    },
  };
});

describe('writeRunRecordEvidence -- promotion is atomic even when the existsSync pre-check is bypassed (TOCTOU)', () => {
  it('still refuses via linkSync EEXIST, and rolls back only what THIS call itself created, when a target is pre-created behind the lied-to pre-check', async () => {
    const { writeRunRecordEvidence } = await import('../../tools/agentic-eval/cli.mjs');

    const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aec-race-'));
    try {
      const recordA = { run_id: 'RACE-TARGET-a-0001' };
      const recordB = { run_id: 'RACE-TARGET-b-0001' };
      const runA = { spawnResult: { rawStdout: '{"raw":"a"}\n' } };
      const runB = { spawnResult: { rawStdout: '{"raw":"b"}\n' } };

      const outDir = path.join(runsRoot, 'agentic-eval-race-kind');
      mkdirSync(outDir, { recursive: true });
      const winnerPath = path.join(outDir, 'RACE-TARGET-a-0001.json');
      // Simulates "the other invocation's promotion already landed" -- created via the REAL
      // (unmocked) writeFileSync, independent of the function under test.
      writeFileSync(winnerPath, '{"winner":"the other invocation, must survive untouched"}');

      expect(() => writeRunRecordEvidence('race-kind', recordA, recordB, runA, runB, '{"redacted":"a"}', '{"redacted":"b"}', runsRoot))
        .toThrow(/already exists/);

      // The pre-existing winner is completely untouched -- not overwritten, not removed by
      // rollback (this invocation never created it, so rollback must never touch it).
      expect(readFileSync(winnerPath, 'utf8')).toBe('{"winner":"the other invocation, must survive untouched"}');
      // Nothing from THIS losing invocation survives either -- no B record, no raw files, no tmp
      // leftovers.
      expect(realExistsSync(path.join(outDir, 'RACE-TARGET-b-0001.json'))).toBe(false);
      expect(readdirSync(outDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });
});

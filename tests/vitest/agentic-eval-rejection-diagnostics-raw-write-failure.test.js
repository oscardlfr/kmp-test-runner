// tests/vitest/agentic-eval-rejection-diagnostics-raw-write-failure.test.js
// The INVERSE of agentic-eval-rejection-diagnostics-write-failure.test.js's own scenario: here
// Transaction 1 (writeRejectionRawTranscripts, the raw transcripts) is the one mocked to throw,
// while Transaction 2 (writeRejectedRunDiagnostics, the structured diagnostic) runs for REAL --
// proving the two transactions really are independent in BOTH directions, not just the one already
// covered there (raw succeeds / diagnostics fails). Kept in its own file for the same module-wide
// vi.mock isolation reason that file's own header comment explains -- vi.mock is hoisted and
// module-wide, so mocking writeRejectionRawTranscripts here would collide with that file's own
// mock of writeRejectedRunDiagnostics if they shared a file.
//
// This is also the discriminating test for raw_transcripts_persisted's "false" direction: the
// WRITTEN diagnostic file (not just the in-memory result object) must explicitly declare
// raw_transcripts_persisted:false -- never merely omit the field, and never silently default to
// true -- when Transaction 1 genuinely failed. The "true" direction is already covered end-to-end
// by agentic-eval-run-command.test.js's own fail-fast tests (which read the real written file and
// assert raw_transcripts_persisted:true there).
import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computePolicySha256 } from '../../tools/agentic-eval/policy-config.mjs';

vi.mock('../../tools/agentic-eval/rejection-diagnostics.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeRejectionRawTranscripts: () => {
      throw new Error('simulated: raw transcript directory collision');
    },
  };
});

// Same fakeObservation()/fakeConditionResult()/buildRunRecord() pattern as
// agentic-eval-rejection-diagnostics-write-failure.test.js's own identical helper -- produces a
// real, fully schema-valid record pair so the test reaches the hard-gate branch instead of
// tripping on an earlier schema-validation step with a hand-rolled, incomplete record literal.
// Matches the canonical minimal condition-observation-v1 shape (see e.g.
// agentic-eval-graders.test.js's own baseObservation helper) -- buildRunRecord now reads
// conditionResult.observation exclusively, never a raw provider event.
function fakeObservation(overrides = {}) {
  return {
    schema: 1,
    runtime: { id: 'claude-code', protocolVersion: 1 },
    process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 1000n },
    session: { initPresent: true, modelResolved: 'claude-sonnet-5-fake', sessionIdObserved: 'sess-1', runtimeVersion: 'fake', toolProfileMatchesExpected: true },
    transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
    terminal: { present: true, isError: false, turnCount: 1, finalText: 'irrelevant', resultSubtype: 'success', usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
    toolAttempts: [],
    skill: {
      available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
      targetInvocation: null, foreignInvocations: [],
      ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
    },
    hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: true },
    byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
    timing: { receiptNsByEventIndex: new Map() },
    ...overrides,
  };
}
function fakeConditionResult(overrides = {}) {
  return {
    observation: fakeObservation(),
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    endedAt: new Date('2026-01-01T00:00:01.000Z'),
    ...overrides,
  };
}

describe('finalizeAndWriteRecords -- a raw-transcript write failure (Transaction 1) never blocks the structured diagnostic (Transaction 2)', () => {
  it('writes a real, valid rejection diagnostic declaring raw_transcripts_persisted:false in BOTH tiers, and preserves the ORIGINAL gate.reason', async () => {
    const { finalizeAndWriteRecords, buildRunRecord } = await import('../../tools/agentic-eval/cli.mjs');

    const common = { runKind: 'calibration', scenarioId: 'test-raw-write-failure', daemonPolicy: 'disabled-via-gradle-user-home-properties', allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(), modelRequested: 'fake-model-x', ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex') };
    const recordA = buildRunRecord({ conditionResult: fakeConditionResult(), condition: 'no-skill', skillSourceSha: null, ...common });
    const recordB = buildRunRecord({ conditionResult: fakeConditionResult(), condition: 'current-skill', skillSourceSha: 'a'.repeat(40), ...common });

    // Coherent, complete mock gate return (see the sibling write-failure test's own identical
    // comment for why an incomplete mock here would trip assertUnexpectedToolCoherence INSIDE
    // buildRejectionDiagnostics before this test's own scenario is ever reached).
    const alwaysFailGate = () => ({
      ok: false, reason: 'SIMULATED_GATE_FAILURE_RAW_INVERSE', failedChecksA: ['simulatedCheck'], failedChecksB: [],
      unexpectedToolUsesCountA: 0, unexpectedToolUsesCountB: 0, unexpectedToolsA: [], unexpectedToolsB: [],
    });

    const runsRootOverride = mkdtempSync(path.join(os.tmpdir(), 'aerdrw-runs-root-'));
    try {
      // cellOrdinal stamped on each -- buildRejectionDiagnostics (Transaction 2, NOT mocked in
      // this file) also validates captureOrdinalByRunId, which now derives from
      // runA.cellOrdinal/runB.cellOrdinal (Codex-audit fix, PR #418, round 4).
      const result = await finalizeAndWriteRecords({
        runKind: 'calibration', recordA, recordB,
        runA: { observation: fakeObservation(), cellOrdinal: 1 },
        runB: { observation: fakeObservation(), cellOrdinal: 0 },
        hardGateFn: alwaysFailGate,
        runsRootOverride,
        // transcriptsByRunId: required and validated fail-closed now that finalizeAndWriteRecords
        // no longer reads raw text off conditionResult itself -- content is irrelevant here
        // (Transaction 1/writeRejectionRawTranscripts is mocked to throw regardless of it).
        transcriptsByRunId: { [recordA.run_id]: '', [recordB.run_id]: '' },
      });

      expect(result.ok).toBe(false);
      // The ORIGINAL gate reason survives verbatim, unrelated to which transaction failed.
      expect(result.reason).toBe('SIMULATED_GATE_FAILURE_RAW_INVERSE');
      expect(result.rawTranscriptsWriteError).toContain('simulated: raw transcript directory collision');
      // Transaction 2 is NOT mocked in this file -- it must succeed for real, independently of
      // Transaction 1's mocked failure.
      expect(result.diagnosticsWriteError).toBeFalsy();
      expect(result.rejectionId).not.toBeNull();
      expect(result.diagnosticsRelativePath).toBe(path.join('agentic-eval-rejected', `${result.rejectionId}.json`));

      const committed = JSON.parse(readFileSync(path.join(runsRootOverride, result.diagnosticsRelativePath), 'utf8'));
      expect(committed.raw_transcripts_persisted).toBe(false);
      const local = JSON.parse(readFileSync(path.join(runsRootOverride, 'agentic-eval-rejected', 'raw', `${result.rejectionId}.json`), 'utf8'));
      expect(local.raw_transcripts_persisted).toBe(false);

      // No raw transcript directory exists at all -- Transaction 1 genuinely never wrote anything,
      // it isn't just reporting an error while some partial content leaked through.
      expect(existsSync(path.join(runsRootOverride, 'agentic-eval-rejected', 'raw', 'transcripts'))).toBe(false);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

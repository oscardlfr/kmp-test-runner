// tests/vitest/agentic-eval-rejection-diagnostics-write-failure.test.js
// Isolated test for finalizeAndWriteRecords/finalizeAndWriteMatrixRecords's graceful-degradation
// handling when the NEW rejected-run diagnostics write itself throws -- via a scoped mock of
// rejection-diagnostics.mjs's writeRejectedRunDiagnostics -- kept in its own file rather than
// agentic-eval-rejection-diagnostics.test.js, matching this repo's established mock-isolation
// convention (see agentic-eval-write-evidence-gitcheck-fail-closed.test.js's own header comment):
// vi.mock() is hoisted and module-wide, so it would otherwise break every other test that
// exercises the real buildRejectionDiagnostics/validateRejectionRow in that file.
//
// A diagnostics-write failure is explicitly a SECONDARY, additive concern -- it must never mask
// the ORIGINAL hard-gate rejection reason, never change the exit code, and never throw an
// uncaught exception up through cmdCalibrate/cmdSmoke/cmdRun.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computePolicySha256 } from '../../tools/agentic-eval/policy-config.mjs';

vi.mock('../../tools/agentic-eval/rejection-diagnostics.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeRejectedRunDiagnostics: () => {
      throw new Error('simulated: privacy check refused the rejection-diagnostics record');
    },
  };
});

// Same fakeConditionResult()/buildRunRecord() pattern already established in
// agentic-eval-cli.test.js's "finalizeAndWriteRecords -- fails closed on a dirty measured-code
// tree" describe block -- produces a REAL, fully schema-valid record pair (every field
// buildRunRecord actually populates), so the test reaches the hard-gate branch instead of
// tripping on the EARLIER schema-validation step with a hand-rolled, incomplete record literal.
function fakeConditionResult(overrides = {}) {
  return {
    init: { model: 'claude-sonnet-5-fake', session_id: 'sess-1', claude_code_version: 'fake', plugins: [], skills: [], tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' },
    result: { subtype: 'success', is_error: false },
    invocation: null,
    hookStats: { hookCallCount: 0, hookDenyCount: 0, everyCallHooked: true, hookAllowCount: 0 },
    byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    endedAt: new Date('2026-01-01T00:00:01.000Z'),
    spawnResult: { terminated: false, terminationReason: null, exitCode: 0 },
    events: [],
    ...overrides,
  };
}

describe('finalizeAndWriteRecords -- a rejection-diagnostics write failure never masks the original rejection', () => {
  it('preserves ok:false and the ORIGINAL gate.reason, surfaces the throw as a separate diagnosticsWriteError field, never throws uncaught', async () => {
    const { finalizeAndWriteRecords, buildRunRecord } = await import('../../tools/agentic-eval/cli.mjs');

    const common = { runKind: 'calibration', scenarioId: 'test-diagnostics-write-failure', daemonPolicy: 'disabled-via-gradle-user-home-properties', allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(), modelRequested: 'fake-model-x', ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex') };
    const recordA = buildRunRecord({ conditionResult: fakeConditionResult(), condition: 'no-skill', skillSourceSha: null, ...common });
    const recordB = buildRunRecord({ conditionResult: fakeConditionResult(), condition: 'current-skill', skillSourceSha: 'a'.repeat(40), ...common });

    // A minimal hard gate that always fails with a known, distinct reason -- the exact identity
    // of the failure doesn't matter here, only that gate.ok is false so the diagnostics write
    // (mocked above to throw) gets attempted and caught.
    const alwaysFailGate = () => ({ ok: false, reason: 'SIMULATED_GATE_FAILURE', failedChecksA: ['simulatedCheck'], failedChecksB: [] });

    // Isolated (non-default) runsRootOverride -- this session has real, uncommitted local
    // modifications under tools/agentic-eval/ (this very implementation work), so
    // findBlockingHarnessToolingDirty would otherwise, correctly, refuse the write before ever
    // reaching the hard gate at all (dirty_harness_tooling only BLOCKS when writing to the
    // DEFAULT RUNS_ROOT -- see cli.mjs's own isRunsRootDefault-gated check). An isolated root is
    // exactly the same test-isolation convention every other test in this suite already uses.
    const runsRootOverride = mkdtempSync(path.join(os.tmpdir(), 'aerdw-runs-root-'));
    try {
      const result = await finalizeAndWriteRecords({
        runKind: 'calibration', recordA, recordB,
        runA: { spawnResult: { rawStdout: '' }, events: [] },
        runB: { spawnResult: { rawStdout: '' }, events: [] },
        hardGateFn: alwaysFailGate,
        runsRootOverride,
      });

      expect(result.ok).toBe(false);
      // The ORIGINAL gate reason survives verbatim -- never overwritten or appended-to by the
      // diagnostics-write failure.
      expect(result.reason).toBe('SIMULATED_GATE_FAILURE');
      expect(result.diagnosticsWriteError).toContain('simulated: privacy check refused');
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

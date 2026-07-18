// tests/vitest/agentic-eval-finalize-outdir-privacy-order.test.js
// Isolated test for finalizeAndWriteRecords()'s evidence-directory-path privacy-check ORDERING,
// via a scoped mock of privacy.mjs's assertCleanOrThrow -- kept in its own file rather than
// agentic-eval-cli.test.js, matching this repo's established node:fs-mock-isolation convention
// (see coverage-orchestrator-report-write-failure.test.js's own header comment for the same
// rationale): vi.mock() is hoisted and module-wide, so it would otherwise affect every other
// test in whichever file it lives in.
//
// Regression coverage for a real ordering bug an independent review pass found: an EARLIER
// version of finalizeAndWriteRecords() called writeRunRecordEvidence() (writing all four files)
// BEFORE checking the evidence directory PATH's own redaction-safety via assertCleanOrThrow --
// meaning a private-patterns rule matching only the (possibly KMP_EVAL_RUNS_ROOT-overridden)
// runs-root path itself, never any record field, could report {ok:false} AFTER real evidence and
// raw transcripts were already committed to disk, contradicting the function's own "any failure
// returns {ok:false} and writes nothing" contract.
//
// assertCleanOrThrow (the plain-text variant, distinct from the object-aware
// assertCleanOrThrowObject used for record-content redaction) is called EXACTLY ONCE in cli.mjs's
// entire finalizeAndWriteRecords() body -- for this exact outDir check -- so mocking it to always
// throw isolates precisely this one check with zero risk of also intercepting the earlier,
// separate record-content privacy check.
//
// run_kind is a closed schema enum (calibration|corpus-probe|scenario|smoke), so this test can't
// dodge the real, shared tools/runs/agentic-eval-calibration/ directory with a made-up name --
// it uses 'calibration' for real. Safety instead comes from run_id: buildRunRecord() always
// generates a fresh random UUID-based id, so this test's own files can never collide with (and
// thus never overwrite) genuine committed evidence, and cleanup below removes ONLY those exact,
// by-name files -- never a directory-wide delete that could touch anything else already there.
import { describe, it, expect, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../tools/agentic-eval/privacy.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    assertCleanOrThrow: () => {
      throw new Error('REFUSED: mocked outDir leak for ordering test');
    },
  };
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('finalizeAndWriteRecords -- evidence-directory-path privacy check runs BEFORE any write', () => {
  it('writes zero files when the outDir privacy check fails, even though the hard gate and record-content check both passed', async () => {
    const { finalizeAndWriteRecords, buildRunRecord } = await import('../../tools/agentic-eval/cli.mjs');
    const { computePolicySha256 } = await import('../../tools/agentic-eval/policy-config.mjs');

    function fakeConditionResult() {
      return {
        init: { model: 'claude-sonnet-5-fake', session_id: 'sess-1', claude_code_version: 'fake', plugins: [], tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' },
        result: { subtype: 'success', is_error: false },
        invocation: null,
        hookStats: { hookCallCount: 0, hookDenyCount: 0, everyCallHooked: true, hookAllowCount: 0 },
        byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        endedAt: new Date('2026-01-01T00:00:01.000Z'),
        spawnResult: { terminated: false, terminationReason: null, exitCode: 0 },
        events: [],
      };
    }

    const policySha256 = computePolicySha256();
    const common = { runKind: 'calibration', scenarioId: 'test-outdir-order', daemonPolicy: 'disabled-via-gradle-user-home-properties', allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256, modelRequested: 'fake-model' };
    const recordA = buildRunRecord({ conditionResult: fakeConditionResult(), condition: 'no-skill', skillSourceSha: null, ...common });
    const recordB = buildRunRecord({ conditionResult: fakeConditionResult(), condition: 'current-skill', skillSourceSha: 'c5c0661852f7c9da145ef56892048e706216a6ce', ...common });
    // This test is specifically about outDir-privacy-check ordering, not dirty-tree behavior --
    // clear whatever real dirty_measured_code/dirty_harness_tooling errors buildRunRecord() may
    // have picked up from the ACTUAL, ambient git state of this repo at test-run time, so the
    // result never depends on incidental local working-tree state (e.g. this very file being
    // actively edited).
    recordA.errors = [];
    recordB.errors = [];
    const outDir = path.join(REPO_ROOT, 'tools', 'runs', 'agentic-eval-calibration');
    const rawDir = path.join(outDir, 'raw');
    const thisRunsPaths = [
      path.join(outDir, `${recordA.run_id}.json`),
      path.join(outDir, `${recordB.run_id}.json`),
      path.join(rawDir, `${recordA.run_id}.jsonl`),
      path.join(rawDir, `${recordB.run_id}.jsonl`),
    ];

    try {
      let hardGateCalled = false;
      const result = await finalizeAndWriteRecords({
        runKind: 'calibration', recordA, recordB,
        runA: { spawnResult: { rawStdout: '' } },
        runB: { spawnResult: { rawStdout: '' } },
        hardGateFn: () => { hardGateCalled = true; return { ok: true, reason: null }; },
      });

      expect(hardGateCalled).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('Privacy check refused to report the evidence directory path');

      // Nothing bearing THIS run's own (fresh, random) run_id exists -- proving the write
      // genuinely never happened, not just that the function's return value claims failure. Never
      // asserts anything about the directory's OTHER contents, which may include real evidence.
      for (const p of thisRunsPaths) expect(existsSync(p)).toBe(false);
    } finally {
      // Surgical, by-exact-name only -- never a directory-wide delete -- so this can never touch
      // any other file already in the real, shared evidence directory.
      for (const p of thisRunsPaths) rmSync(p, { force: true });
    }
  });
});

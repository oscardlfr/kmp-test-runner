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

// writeRunMatrixRecordEvidence -- the N-record sibling (decision 3/11), sharing the EXACT SAME
// promoteTargetsAtomically body proven race-safe above -- these tests prove the N>2 generalization
// itself (correct target construction, all-or-nothing rollback for a batch), not the TOCTOU
// mechanism a second time (already proven, verbatim-shared code).
describe('writeRunMatrixRecordEvidence -- N-record atomic promotion (decision 3/11)', () => {
  function fakeRecordsAndConditionResults(n) {
    const records = [];
    const conditionResults = [];
    const redactedTexts = [];
    for (let i = 0; i < n; i++) {
      records.push({ run_id: `MATRIX-TARGET-r${i}-0001` });
      conditionResults.push({ spawnResult: { rawStdout: `{"raw":${i}}\n` } });
      redactedTexts.push(`{"redacted":${i}}`);
    }
    return { records, conditionResults, redactedTexts };
  }

  it('writes exactly 2N files (N summaries + N raw transcripts) for a 4-record (2-repeat) matrix', async () => {
    const { writeRunMatrixRecordEvidence } = await import('../../tools/agentic-eval/cli.mjs');
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aemc-write-'));
    try {
      const { records, conditionResults, redactedTexts } = fakeRecordsAndConditionResults(4);
      const outDir = writeRunMatrixRecordEvidence('matrix-kind', records, conditionResults, redactedTexts, runsRoot);
      const summaryFiles = readdirSync(outDir).filter((f) => f.endsWith('.json'));
      const rawFiles = readdirSync(path.join(outDir, 'raw')).filter((f) => f.endsWith('.jsonl'));
      expect(summaryFiles.length).toBe(4);
      expect(rawFiles.length).toBe(4);
      for (let i = 0; i < 4; i++) {
        expect(JSON.parse(readFileSync(path.join(outDir, `MATRIX-TARGET-r${i}-0001.json`), 'utf8'))).toEqual({ redacted: i });
        expect(readFileSync(path.join(outDir, 'raw', `MATRIX-TARGET-r${i}-0001.jsonl`), 'utf8')).toBe(`{"raw":${i}}\n`);
      }
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  it('a single pre-existing target among N rolls back EVERY target this invocation created -- never a partial N-1 promotion', async () => {
    const { writeRunMatrixRecordEvidence } = await import('../../tools/agentic-eval/cli.mjs');
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aemc-partial-'));
    try {
      const { records, conditionResults, redactedTexts } = fakeRecordsAndConditionResults(4);
      const outDir = path.join(runsRoot, 'agentic-eval-matrix-kind-partial');
      mkdirSync(outDir, { recursive: true });
      // Pre-create the THIRD record's target -- simulating a collision partway through the batch.
      writeFileSync(path.join(outDir, 'MATRIX-TARGET-r2-0001.json'), '{"pre-existing":true}');

      expect(() => writeRunMatrixRecordEvidence('matrix-kind-partial', records, conditionResults, redactedTexts, runsRoot))
        .toThrow(/already exists/);

      // Every OTHER target (r0, r1, r3) must not have been left behind -- an all-or-nothing batch,
      // never N-1 records silently promoted while one collided.
      for (const i of [0, 1, 3]) {
        expect(realExistsSync(path.join(outDir, `MATRIX-TARGET-r${i}-0001.json`))).toBe(false);
      }
      // The pre-existing record survives untouched (this invocation never created it).
      expect(readFileSync(path.join(outDir, 'MATRIX-TARGET-r2-0001.json'), 'utf8')).toBe('{"pre-existing":true}');
      expect(readdirSync(outDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });
});

// findMatrixCompletenessGap (decision 11) -- a genuine identity PROOF, not a count. Pure function,
// tested directly with synthetic record arrays.
describe('findMatrixCompletenessGap', () => {
  function recordsFor(repeats) {
    const records = [];
    let orderIndex = 0;
    for (let rep = 0; rep < repeats; rep++) {
      for (const condition of ['current-skill', 'no-skill']) {
        records.push({ repetition_index: rep, condition, order_index: orderIndex++ });
      }
    }
    return records;
  }

  it('returns null (complete) for a well-formed 2-repeat (4-record) matrix', async () => {
    const { findMatrixCompletenessGap } = await import('../../tools/agentic-eval/cli.mjs');
    expect(findMatrixCompletenessGap(recordsFor(2), 2)).toBeNull();
  });

  it('detects a wrong total count', async () => {
    const { findMatrixCompletenessGap } = await import('../../tools/agentic-eval/cli.mjs');
    const records = recordsFor(2).slice(0, 3); // one short
    expect(findMatrixCompletenessGap(records, 2)).toMatch(/expected 4 records/);
  });

  // The exact bug findMatrixCompletenessGap exists to catch: same TOTAL count, wrong composition
  // -- a duplicated repetition silently substituting for a missing one. A plain
  // `records.length === expectedCellCount` check would NOT catch this.
  it('detects a duplicated (repetition_index, condition) pair substituting for a missing one -- same total count, wrong composition', async () => {
    const { findMatrixCompletenessGap } = await import('../../tools/agentic-eval/cli.mjs');
    const records = recordsFor(2);
    records[3] = { ...records[1] }; // duplicate rep0/no-skill into rep1/no-skill's slot
    expect(records.length).toBe(4); // count alone looks fine
    expect(findMatrixCompletenessGap(records, 2)).toMatch(/duplicate/);
  });

  it('detects a missing pair when counts happen to still add up via a different duplicate', async () => {
    const { findMatrixCompletenessGap } = await import('../../tools/agentic-eval/cli.mjs');
    const records = recordsFor(2);
    records[3] = { repetition_index: 0, condition: 'current-skill', order_index: 3 }; // duplicates records[0]
    expect(findMatrixCompletenessGap(records, 2)).toMatch(/duplicate|missing/);
  });

  it('detects non-contiguous order_index values', async () => {
    const { findMatrixCompletenessGap } = await import('../../tools/agentic-eval/cli.mjs');
    const records = recordsFor(2);
    records[3] = { ...records[3], order_index: 99 };
    expect(findMatrixCompletenessGap(records, 2)).toMatch(/order_index/);
  });

  it('works for repeats=1 (a 2-record matrix, no counterbalancing possible but still structurally complete)', async () => {
    const { findMatrixCompletenessGap } = await import('../../tools/agentic-eval/cli.mjs');
    expect(findMatrixCompletenessGap(recordsFor(1), 1)).toBeNull();
  });
});

// realizedStartCounts / scenarioMatrixIsBenchmarkEligible (decision 15) -- pure functions, tested
// directly with synthetic records. Regression coverage for a real gap: buildRunRecord always
// stamps benchmark_eligible:false with nothing anywhere ever flipping it true for a genuinely
// complete, integrity-passing, balanced scenario matrix -- caught live by
// agentic-eval-run-command.test.js's own real-subprocess success test before this fix landed.
describe('realizedStartCounts', () => {
  function cell(repetitionIndex, orderIndex, condition) {
    return { repetition_index: repetitionIndex, order_index: orderIndex, condition };
  }

  it('counts an exact 2/2 split correctly (repeats=2, one starts each way)', async () => {
    const { realizedStartCounts } = await import('../../tools/agentic-eval/cli.mjs');
    const records = [
      cell(0, 0, 'no-skill'), cell(0, 1, 'current-skill'),
      cell(1, 2, 'current-skill'), cell(1, 3, 'no-skill'),
    ];
    expect(realizedStartCounts(records)).toEqual({ currentSkillFirstCount: 1, noSkillFirstCount: 1 });
  });

  it('counts an all-current-skill-first matrix correctly (no balance)', async () => {
    const { realizedStartCounts } = await import('../../tools/agentic-eval/cli.mjs');
    const records = [
      cell(0, 0, 'current-skill'), cell(0, 1, 'no-skill'),
      cell(1, 2, 'current-skill'), cell(1, 3, 'no-skill'),
    ];
    expect(realizedStartCounts(records)).toEqual({ currentSkillFirstCount: 2, noSkillFirstCount: 0 });
  });

  it('determines "which started first" from order_index, not array position', async () => {
    const { realizedStartCounts } = await import('../../tools/agentic-eval/cli.mjs');
    // Deliberately out-of-order array -- the SECOND array entry has the smaller order_index.
    const records = [cell(0, 1, 'current-skill'), cell(0, 0, 'no-skill')];
    expect(realizedStartCounts(records)).toEqual({ currentSkillFirstCount: 0, noSkillFirstCount: 1 });
  });
});

describe('scenarioMatrixIsBenchmarkEligible', () => {
  function fullRecord(repetitionIndex, orderIndex, condition, overrides = {}) {
    return {
      repetition_index: repetitionIndex,
      order_index: orderIndex,
      condition,
      grading_checks: { value: [{ name: 'x', passed: true, detail: '', evidence_event_indices: [] }], reason: null },
      success: { value: true, reason: null },
      expected_outcome_matched: { value: true, reason: null },
      ...overrides,
    };
  }
  function balancedEligibleRecords() {
    return [
      fullRecord(0, 0, 'no-skill'), fullRecord(0, 1, 'current-skill'),
      fullRecord(1, 2, 'current-skill'), fullRecord(1, 3, 'no-skill'),
    ];
  }

  it('is true for a balanced, fully-graded matrix whose gate passed', async () => {
    const { scenarioMatrixIsBenchmarkEligible } = await import('../../tools/agentic-eval/cli.mjs');
    expect(scenarioMatrixIsBenchmarkEligible(balancedEligibleRecords(), { ok: true })).toBe(true);
  });

  it('is false when the gate itself failed, regardless of grading/balance', async () => {
    const { scenarioMatrixIsBenchmarkEligible } = await import('../../tools/agentic-eval/cli.mjs');
    expect(scenarioMatrixIsBenchmarkEligible(balancedEligibleRecords(), { ok: false, reason: 'x' })).toBe(false);
  });

  it('is false when any record has grading_checks.value:null (grading never ran)', async () => {
    const { scenarioMatrixIsBenchmarkEligible } = await import('../../tools/agentic-eval/cli.mjs');
    const records = balancedEligibleRecords();
    records[2] = fullRecord(1, 2, 'current-skill', { grading_checks: { value: null, reason: 'x' } });
    expect(scenarioMatrixIsBenchmarkEligible(records, { ok: true })).toBe(false);
  });

  it('is false when any record has a null success value (never true, never merely "not tracked")', async () => {
    const { scenarioMatrixIsBenchmarkEligible } = await import('../../tools/agentic-eval/cli.mjs');
    const records = balancedEligibleRecords();
    records[0] = fullRecord(0, 0, 'no-skill', { success: { value: null, reason: 'x' } });
    expect(scenarioMatrixIsBenchmarkEligible(records, { ok: true })).toBe(false);
  });

  it('is false when any record has a null expected_outcome_matched value', async () => {
    const { scenarioMatrixIsBenchmarkEligible } = await import('../../tools/agentic-eval/cli.mjs');
    const records = balancedEligibleRecords();
    records[1] = fullRecord(0, 1, 'current-skill', { expected_outcome_matched: { value: null, reason: 'x' } });
    expect(scenarioMatrixIsBenchmarkEligible(records, { ok: true })).toBe(false);
  });

  it('is TRUE regardless of a false success/expected_outcome_matched value -- a wrong answer is valid negative data, never disqualifying', async () => {
    const { scenarioMatrixIsBenchmarkEligible } = await import('../../tools/agentic-eval/cli.mjs');
    const records = balancedEligibleRecords();
    records[0] = fullRecord(0, 0, 'no-skill', { success: { value: false, reason: null }, expected_outcome_matched: { value: false, reason: null } });
    expect(scenarioMatrixIsBenchmarkEligible(records, { ok: true })).toBe(true);
  });

  it('is false for an odd-repeats matrix -- an unbalanced split can never be eligible by construction', async () => {
    const { scenarioMatrixIsBenchmarkEligible } = await import('../../tools/agentic-eval/cli.mjs');
    const records = [
      fullRecord(0, 0, 'current-skill'), fullRecord(0, 1, 'no-skill'),
      fullRecord(1, 2, 'current-skill'), fullRecord(1, 3, 'no-skill'),
      fullRecord(2, 4, 'current-skill'), fullRecord(2, 5, 'no-skill'),
    ];
    expect(scenarioMatrixIsBenchmarkEligible(records, { ok: true })).toBe(false);
  });
});

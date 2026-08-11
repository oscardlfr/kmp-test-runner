// tests/vitest/agentic-eval-journal-adoption-discard.test.js
// Direct unit coverage for cli.mjs's three journal-adoption/discard helpers -- adoptJournalRaw,
// journalRawExactlyMatchesRejectionManifest, discardJournalIfRedundant. All three are exported
// solely for direct testability (same established convention as e.g.
// checkScenarioFilenameMatchesId/findDuplicateScenarioIds elsewhere in this file).
//
// adoptJournalRaw's own doc comment flags the property this file's first describe block exists to
// prove: "the journal's own ordinal assignment (0=B/current-skill then 1=A/no-skill for a pair)
// does not match this codebase's historical recordA/recordB parameter ordering; conflating the two
// would silently swap two live sessions' transcripts" -- a severe, QUIET correctness bug (both
// transcripts look like plausible session output, so nothing here would fail loudly without a
// dedicated test). Distinct sentinel content per cellOrdinal, adopted in an order that deliberately
// does NOT match cellOrdinal order, is the only way to actually catch a position-keyed regression.
//
// discardJournalIfRedundant's own doc comment states the §6 exact-correspondence property this
// file's second describe block exists to prove: "rawTranscriptsPersisted:true alone only proves
// the write attempt didn't throw, not that every cell landed with the identity the diagnostic
// claims" -- a journal must survive a rejection whose manifest doesn't exactly match what it
// itself captured, even when that boolean is true.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptJournalRaw, journalRawExactlyMatchesRejectionManifest, discardJournalIfRedundant } from '../../tools/agentic-eval/cli.mjs';
import { createInvocationJournal } from '../../tools/agentic-eval/durable-journal.mjs';

function makeJournal() {
  const runsRootOverride = mkdtempSync(path.join(os.tmpdir(), 'aejad-journal-root-'));
  const journal = createInvocationJournal({ runKind: 'calibration', plannedCellCount: 2, runsRootOverride });
  return { journal, runsRootOverride };
}

describe('adoptJournalRaw -- keyed strictly by cellOrdinal, never array position or call order', () => {
  it('adopts each conditionResult\'s own journal-persisted raw, even when read back in the OPPOSITE order they were persisted -- never swapped', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      // B (current-skill) is journal cellOrdinal 0; A (no-skill) is cellOrdinal 1 -- the exact
      // convention adoptJournalRaw's own doc comment warns does NOT match recordA/recordB's
      // historical parameter ordering.
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'SENTINEL_B_REAL_TRANSCRIPT' });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: 2, rawStdout: 'SENTINEL_A_REAL_TRANSCRIPT' });

      const condB = { cellOrdinal: 0, didSpawn: true, spawnResult: { rawStdout: 'stale-in-memory-B' } };
      const condA = { cellOrdinal: 1, didSpawn: true, spawnResult: { rawStdout: 'stale-in-memory-A' } };

      // Deliberately adopt A BEFORE B -- proves correctness is keyed by cellOrdinal alone, never
      // by "the order adoptJournalRaw happens to be called in" or an assumed A-then-B convention.
      adoptJournalRaw(condA, journal);
      adoptJournalRaw(condB, journal);

      expect(condA.spawnResult.rawStdout).toBe('SENTINEL_A_REAL_TRANSCRIPT');
      expect(condB.spawnResult.rawStdout).toBe('SENTINEL_B_REAL_TRANSCRIPT');
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('throws (fail-closed) when a cell genuinely spawned but the journal has no persisted raw for it', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      const cond = { cellOrdinal: 0, didSpawn: true, spawnResult: { rawStdout: 'in-memory-only' } };
      expect(() => adoptJournalRaw(cond, journal)).toThrow(/no raw persisted for cellOrdinal 0/);
      // Refuses to promote unverified content -- the in-memory value is left untouched, never
      // silently substituted for the missing journal copy.
      expect(cond.spawnResult.rawStdout).toBe('in-memory-only');
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('is a no-op for a cell that never spawned (spawn_failed) -- never reads the journal, never throws', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      const cond = { cellOrdinal: 0, didSpawn: false, spawnResult: { rawStdout: '' } };
      expect(() => adoptJournalRaw(cond, journal)).not.toThrow();
      expect(cond.spawnResult.rawStdout).toBe('');
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('is a no-op when journal is null (matches every call site\'s own null-journal contract)', () => {
    const cond = { cellOrdinal: 0, didSpawn: true, spawnResult: { rawStdout: 'unchanged' } };
    expect(() => adoptJournalRaw(cond, null)).not.toThrow();
    expect(cond.spawnResult.rawStdout).toBe('unchanged');
  });
});

describe('journalRawExactlyMatchesRejectionManifest + discardJournalIfRedundant -- §6 exact-correspondence', () => {
  it('discards on full acceptance (result.ok:true), regardless of manifest', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x' });
      discardJournalIfRedundant(journal, { ok: true });
      expect(existsSync(journal.journalDir)).toBe(false);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('discards a rejection whose manifest EXACTLY matches the journal\'s own raw_persisted set', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x' });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: 2, rawStdout: 'y' });
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null,
        rawTranscriptsManifest: [
          { run_id: 'run-a', capture_ordinal: 0, filename: 'a.jsonl' },
          { run_id: 'run-b', capture_ordinal: 1, filename: 'b.jsonl' },
        ],
      };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result)).toBe(true);
      discardJournalIfRedundant(journal, result);
      expect(existsSync(journal.journalDir)).toBe(false);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('does NOT discard when the manifest is missing an ordinal the journal itself captured, even though rawTranscriptsPersisted:true', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x' });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: 2, rawStdout: 'y' });
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null,
        // Only cellOrdinal 0's transcript is claimed -- ordinal 1 is silently missing from the
        // manifest despite the journal having genuinely captured it. rawTranscriptsPersisted:true
        // alone must NOT be trusted as proof every cell landed.
        rawTranscriptsManifest: [{ run_id: 'run-a', capture_ordinal: 0, filename: 'a.jsonl' }],
      };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result)).toBe(false);
      discardJournalIfRedundant(journal, result);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('does NOT discard when diagnosticsWriteError is set, even with an otherwise-exact manifest', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x' });
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: 'privacy check refused',
        rawTranscriptsManifest: [{ run_id: 'run-a', capture_ordinal: 0, filename: 'a.jsonl' }],
      };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result)).toBe(false);
      discardJournalIfRedundant(journal, result);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('does NOT discard a genuine non-gate {ok:false} (no rawTranscriptsPersisted/manifest at all -- the finalizeIncident path, not printRejectionForensicsStderr)', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x' });
      const result = { ok: false, reason: 'schema validation failed', rejectionId: null };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result)).toBe(false);
      discardJournalIfRedundant(journal, result);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('is a no-op when journal is null', () => {
    expect(() => discardJournalIfRedundant(null, { ok: true })).not.toThrow();
  });
});

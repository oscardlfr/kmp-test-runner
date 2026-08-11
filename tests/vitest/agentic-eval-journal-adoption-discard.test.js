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
// Post-Codex-audit fix (PR #418): the second describe block was independently confirmed insufficient
// by an adversarial review -- journalRawExactlyMatchesRejectionManifest previously compared ONLY
// capture_ordinal SETS, never run_id/filename, so a manifest with a fabricated run_id and/or
// filename but a coincidentally-correct ordinal set still returned true and triggered a discard.
// The function now takes a third `recordRunIds` argument (the caller's own real, authoritative
// run_id list) and cross-validates full (run_id, ordinal, filename) identity, not just cardinality.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptJournalRaw, journalRawExactlyMatchesRejectionManifest, discardJournalIfRedundant } from '../../tools/agentic-eval/cli.mjs';
import { createInvocationJournal } from '../../tools/agentic-eval/durable-journal.mjs';
import { deriveTranscriptFilename } from '../../tools/agentic-eval/rejection-diagnostics.mjs';

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

describe('journalRawExactlyMatchesRejectionManifest + discardJournalIfRedundant -- §6 exact-correspondence (full identity, not just ordinal cardinality)', () => {
  it('discards on full acceptance (result.ok:true), regardless of manifest', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x' });
      discardJournalIfRedundant(journal, { ok: true }, ['run-a']);
      expect(existsSync(journal.journalDir)).toBe(false);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('discards a rejection whose manifest EXACTLY matches the journal\'s own raw_persisted set AND the real record run_ids, with correctly-derived filenames', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x' });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: 2, rawStdout: 'y' });
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null,
        rawTranscriptsManifest: [
          { run_id: 'run-a', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'run-a') },
          { run_id: 'run-b', capture_ordinal: 1, filename: deriveTranscriptFilename(1, 'run-b') },
        ],
      };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, ['run-a', 'run-b'])).toBe(true);
      discardJournalIfRedundant(journal, result, ['run-a', 'run-b']);
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
        rawTranscriptsManifest: [{ run_id: 'run-a', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'run-a') }],
      };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, ['run-a', 'run-b'])).toBe(false);
      discardJournalIfRedundant(journal, result, ['run-a', 'run-b']);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('does NOT discard when a manifest entry\'s run_id is fabricated/unknown -- even with a correct ordinal set and a self-consistent filename', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x' });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: 2, rawStdout: 'y' });
      // Direct reproduction of the audit's own finding: ordinals {0,1} are exactly right, but
      // 'FABRICATED-RUN-ID' is not one of the real record run_ids for this invocation. The
      // filename IS internally self-consistent with its own (ordinal, run_id) pair -- proving this
      // is caught by the run_id cross-check, not merely the filename-consistency check.
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null,
        rawTranscriptsManifest: [
          { run_id: 'FABRICATED-RUN-ID', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'FABRICATED-RUN-ID') },
          { run_id: 'run-b', capture_ordinal: 1, filename: deriveTranscriptFilename(1, 'run-b') },
        ],
      };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, ['run-a', 'run-b'])).toBe(false);
      discardJournalIfRedundant(journal, result, ['run-a', 'run-b']);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('does NOT discard when a manifest entry\'s filename is fabricated/inconsistent with its own declared (ordinal, run_id) pair -- even with a correct run_id and ordinal set', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x' });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: 2, rawStdout: 'y' });
      // run_id and capture_ordinal are both genuine and correctly matched -- only the filename is
      // wrong (doesn't match what deriveTranscriptFilename(0, 'run-a') actually produces).
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null,
        rawTranscriptsManifest: [
          { run_id: 'run-a', capture_ordinal: 0, filename: 'totally-fabricated-filename.jsonl' },
          { run_id: 'run-b', capture_ordinal: 1, filename: deriveTranscriptFilename(1, 'run-b') },
        ],
      };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, ['run-a', 'run-b'])).toBe(false);
      discardJournalIfRedundant(journal, result, ['run-a', 'run-b']);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('discards correctly regardless of manifest ARRAY ORDER -- reordered entries with the same real identities still match', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x' });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: 2, rawStdout: 'y' });
      // Same two entries as the "discards a rejection whose manifest EXACTLY matches" case above,
      // but listed in the OPPOSITE array order -- proves the comparison is set-based (by identity),
      // never positional.
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null,
        rawTranscriptsManifest: [
          { run_id: 'run-b', capture_ordinal: 1, filename: deriveTranscriptFilename(1, 'run-b') },
          { run_id: 'run-a', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'run-a') },
        ],
      };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, ['run-a', 'run-b'])).toBe(true);
      discardJournalIfRedundant(journal, result, ['run-a', 'run-b']);
      expect(existsSync(journal.journalDir)).toBe(false);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('does NOT discard on a duplicate run_id within the manifest, even if the ordinal set otherwise matches', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x' });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: 2, rawStdout: 'y' });
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null,
        rawTranscriptsManifest: [
          { run_id: 'run-a', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'run-a') },
          { run_id: 'run-a', capture_ordinal: 1, filename: deriveTranscriptFilename(1, 'run-a') },
        ],
      };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, ['run-a', 'run-b'])).toBe(false);
      discardJournalIfRedundant(journal, result, ['run-a', 'run-b']);
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
        rawTranscriptsManifest: [{ run_id: 'run-a', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'run-a') }],
      };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, ['run-a'])).toBe(false);
      discardJournalIfRedundant(journal, result, ['run-a']);
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
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, ['run-a'])).toBe(false);
      discardJournalIfRedundant(journal, result, ['run-a']);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('is a no-op when journal is null', () => {
    expect(() => discardJournalIfRedundant(null, { ok: true }, ['run-a'])).not.toThrow();
  });
});

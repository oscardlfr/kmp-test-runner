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
//
// Round 3: even THAT fix was independently confirmed insufficient by a further audit pass --
// checking "run_id is real" and "ordinal is real" as two INDEPENDENT set-membership tests still
// allows a SWAP (run-a claiming journal ordinal 1, run-b claiming ordinal 0, each with its own
// internally-self-consistent filename) to pass, since every individual check holds even though the
// PAIRING is wrong. The function's third argument is now `runIdToCellOrdinal`, an authoritative
// MAP (never a plain array) -- each manifest entry's (run_id, capture_ordinal) PAIR must match this
// binding exactly, not just each half independently.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { adoptJournalRaw, journalRawExactlyMatchesRejectionManifest, discardJournalIfRedundant } from '../../tools/agentic-eval/cli.mjs';
import { createInvocationJournal } from '../../tools/agentic-eval/durable-journal.mjs';
import { deriveTranscriptFilename, writeRejectionRawStderr, deriveStderrFilename } from '../../tools/agentic-eval/rejection-diagnostics.mjs';

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
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'SENTINEL_B_REAL_TRANSCRIPT', stderr: '' });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: 2, rawStdout: 'SENTINEL_A_REAL_TRANSCRIPT', stderr: '' });

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

describe('journalRawExactlyMatchesRejectionManifest + discardJournalIfRedundant -- §6 exact-correspondence (full identity binding, not independent set membership)', () => {
  it('discards on full acceptance (result.ok:true), regardless of manifest', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x', stderr: '' });
      discardJournalIfRedundant(journal, { ok: true }, { 'run-a': 0 });
      expect(existsSync(journal.journalDir)).toBe(false);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('discards a rejection whose manifest EXACTLY matches the journal\'s own raw_persisted set AND the authoritative run_id->cellOrdinal binding, with correctly-derived filenames', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x', stderr: 'stderr-for-run-a' });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: 2, rawStdout: 'y', stderr: 'stderr-for-run-b' });
      const binding = { 'run-a': 0, 'run-b': 1 };
      const rejectionId = randomUUID();
      // Mirrors production's own construction (cli.mjs's stderrByRunId, Diseño 4d): read the
      // ALREADY-redacted value back from the journal, never re-derive it from a fresh string --
      // this is also what guarantees journal-side and rejection-tier-side content are
      // byte-identical by construction, the same way the real caller achieves it.
      const { stderrManifest } = writeRejectionRawStderr(
        rejectionId,
        { 'run-a': journal.readStderrFor(0), 'run-b': journal.readStderrFor(1) },
        binding,
        { runsRootOverride },
      );
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null,
        rejectionId,
        rawTranscriptsManifest: [
          { run_id: 'run-a', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'run-a') },
          { run_id: 'run-b', capture_ordinal: 1, filename: deriveTranscriptFilename(1, 'run-b') },
        ],
        stderrManifest,
      };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, binding)).toBe(true);
      discardJournalIfRedundant(journal, result, binding, runsRootOverride);
      expect(existsSync(journal.journalDir)).toBe(false);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  // Post-Codex-audit fix (PR #418, round 3): direct reproduction of the audit's own specific
  // finding. Both run-a and run-b are real, expected run_ids; both ordinals 0 and 1 are real,
  // journal-captured ordinals; each entry's filename IS internally self-consistent with its OWN
  // declared (ordinal, run_id) pair. The round-2 fix (independent run_id-set and ordinal-set
  // membership checks) would pass this. Only checking the exact (run_id, ordinal) PAIR against the
  // authoritative binding catches it.
  it('does NOT discard when two run_ids\' ordinals are SWAPPED -- run-a claims ordinal 1, run-b claims ordinal 0, each with an internally-consistent filename, but neither matches the TRUE binding', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      // The TRUE binding: run-a really produced cellOrdinal 0's session, run-b really produced
      // cellOrdinal 1's.
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x', stderr: '' });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: 2, rawStdout: 'y', stderr: '' });
      const trueBinding = { 'run-a': 0, 'run-b': 1 };
      // The manifest claims the OPPOSITE pairing.
      const swappedResult = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null,
        rawTranscriptsManifest: [
          { run_id: 'run-a', capture_ordinal: 1, filename: deriveTranscriptFilename(1, 'run-a') },
          { run_id: 'run-b', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'run-b') },
        ],
      };
      expect(journalRawExactlyMatchesRejectionManifest(journal, swappedResult, trueBinding)).toBe(false);
      discardJournalIfRedundant(journal, swappedResult, trueBinding);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('discards correctly regardless of manifest ARRAY ORDER -- reordered entries with the same TRUE pairing still match', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x', stderr: 'stderr-for-run-a' });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: 2, rawStdout: 'y', stderr: 'stderr-for-run-b' });
      const binding = { 'run-a': 0, 'run-b': 1 };
      const rejectionId = randomUUID();
      // Keys inserted in the OPPOSITE order from the binding -- writeRejectionRawStderr's own
      // manifest order follows Object.keys() insertion order, so this naturally produces a
      // reordered stderrManifest below, same intent as the reordered rawTranscriptsManifest.
      const { stderrManifest } = writeRejectionRawStderr(
        rejectionId,
        { 'run-b': journal.readStderrFor(1), 'run-a': journal.readStderrFor(0) },
        binding,
        { runsRootOverride },
      );
      // Same two CORRECTLY-paired entries as the exact-match case above, but listed in the
      // OPPOSITE array order -- proves the comparison is identity-based (a map lookup), never
      // positional.
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null,
        rejectionId,
        rawTranscriptsManifest: [
          { run_id: 'run-b', capture_ordinal: 1, filename: deriveTranscriptFilename(1, 'run-b') },
          { run_id: 'run-a', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'run-a') },
        ],
        stderrManifest,
      };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, binding)).toBe(true);
      discardJournalIfRedundant(journal, result, binding, runsRootOverride);
      expect(existsSync(journal.journalDir)).toBe(false);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('does NOT discard when the manifest is missing an ordinal the journal itself captured, even though rawTranscriptsPersisted:true', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x', stderr: '' });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: 2, rawStdout: 'y', stderr: '' });
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null,
        // Only cellOrdinal 0's transcript is claimed -- ordinal 1 is silently missing from the
        // manifest despite the journal having genuinely captured it. rawTranscriptsPersisted:true
        // alone must NOT be trusted as proof every cell landed.
        rawTranscriptsManifest: [{ run_id: 'run-a', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'run-a') }],
      };
      const binding = { 'run-a': 0, 'run-b': 1 };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, binding)).toBe(false);
      discardJournalIfRedundant(journal, result, binding);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('does NOT discard when a manifest entry\'s run_id is fabricated/unknown -- even with a correct ordinal set and a self-consistent filename', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x', stderr: '' });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: 2, rawStdout: 'y', stderr: '' });
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null,
        rawTranscriptsManifest: [
          { run_id: 'FABRICATED-RUN-ID', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'FABRICATED-RUN-ID') },
          { run_id: 'run-b', capture_ordinal: 1, filename: deriveTranscriptFilename(1, 'run-b') },
        ],
      };
      const binding = { 'run-a': 0, 'run-b': 1 };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, binding)).toBe(false);
      discardJournalIfRedundant(journal, result, binding);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('does NOT discard when a manifest entry\'s filename is fabricated/inconsistent with its own declared (ordinal, run_id) pair -- even with a correct run_id and ordinal set', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x', stderr: '' });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: 2, rawStdout: 'y', stderr: '' });
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null,
        rawTranscriptsManifest: [
          { run_id: 'run-a', capture_ordinal: 0, filename: 'totally-fabricated-filename.jsonl' },
          { run_id: 'run-b', capture_ordinal: 1, filename: deriveTranscriptFilename(1, 'run-b') },
        ],
      };
      const binding = { 'run-a': 0, 'run-b': 1 };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, binding)).toBe(false);
      discardJournalIfRedundant(journal, result, binding);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('does NOT discard on a duplicate run_id within the manifest, even if the ordinal set otherwise matches', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x', stderr: '' });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: 2, rawStdout: 'y', stderr: '' });
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null,
        rawTranscriptsManifest: [
          { run_id: 'run-a', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'run-a') },
          { run_id: 'run-a', capture_ordinal: 1, filename: deriveTranscriptFilename(1, 'run-a') },
        ],
      };
      const binding = { 'run-a': 0, 'run-b': 1 };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, binding)).toBe(false);
      discardJournalIfRedundant(journal, result, binding);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('does NOT discard when diagnosticsWriteError is set, even with an otherwise-exact manifest', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x', stderr: '' });
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: 'privacy check refused',
        rawTranscriptsManifest: [{ run_id: 'run-a', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'run-a') }],
      };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, { 'run-a': 0 })).toBe(false);
      discardJournalIfRedundant(journal, result, { 'run-a': 0 });
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('does NOT discard a genuine non-gate {ok:false} (no rawTranscriptsPersisted/manifest at all -- the finalizeIncident path, not printRejectionForensicsStderr)', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x', stderr: '' });
      const result = { ok: false, reason: 'schema validation failed', rejectionId: null };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, { 'run-a': 0 })).toBe(false);
      discardJournalIfRedundant(journal, result, { 'run-a': 0 });
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('is a no-op when journal is null', () => {
    expect(() => discardJournalIfRedundant(null, { ok: true }, { 'run-a': 0 })).not.toThrow();
  });
});

// Round-3 audit finding, the most severe of that pass: comparing two hashes each computed in
// memory (one per side, at write time) never proves what is REALLY on disk right now. Every RED
// below physically truncates/deletes a REAL file on disk, AFTER a genuinely successful write --
// never just falsifying an in-memory manifest object, which the plan's own stop conditions call
// out as an invalid substitute for this specific finding.
describe('stderr content-correspondence -- physical on-disk truncation/deletion is detected by REREADING both copies, never by trusting write-time-cached metadata', () => {
  it('rejection branch: does NOT discard when the JOURNAL\'s own stderr file is physically truncated AFTER a successful write, even though the manifest is otherwise exactly correct', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x', stderr: 'original stderr content' });
      const binding = { 'run-a': 0 };
      const rejectionId = randomUUID();
      const { stderrManifest } = writeRejectionRawStderr(rejectionId, { 'run-a': journal.readStderrFor(0) }, binding, { runsRootOverride });
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null, rejectionId,
        rawTranscriptsManifest: [{ run_id: 'run-a', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'run-a') }],
        stderrManifest,
      };
      // Sanity: BEFORE corruption, the stdout side genuinely matches -- proves the eventual
      // conservation below is caused by the stderr truncation specifically, not a coincidental
      // stdout mismatch.
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, binding)).toBe(true);

      const journalStderrPath = path.join(journal.journalDir, 'stderr', '0.txt');
      writeFileSync(journalStderrPath, 'TRUNCATED');

      discardJournalIfRedundant(journal, result, binding, runsRootOverride);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('rejection branch: does NOT discard when the REJECTION TIER\'s own stderr file is physically truncated AFTER a successful write -- the opposite side from the previous test, proving BOTH copies are independently reread, not just one', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x', stderr: 'original stderr content' });
      const binding = { 'run-a': 0 };
      const rejectionId = randomUUID();
      const { stderrManifest } = writeRejectionRawStderr(rejectionId, { 'run-a': journal.readStderrFor(0) }, binding, { runsRootOverride });
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null, rejectionId,
        rawTranscriptsManifest: [{ run_id: 'run-a', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'run-a') }],
        stderrManifest,
      };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, binding)).toBe(true);

      const rejectionStderrPath = path.join(runsRootOverride, 'agentic-eval-rejected', 'raw', 'stderr', rejectionId, deriveStderrFilename(0, 'run-a'));
      writeFileSync(rejectionStderrPath, 'CORRUPTED');

      discardJournalIfRedundant(journal, result, binding, runsRootOverride);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('rejection branch: does NOT discard when the STDERR manifest\'s run_id/capture_ordinal pairing is SWAPPED between two cells, even though the STDOUT manifest is correct and each stderr entry is internally self-consistent with its own declared pair', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x', stderr: 'stderr-for-run-a' });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: 2, rawStdout: 'y', stderr: 'stderr-for-run-b' });
      const trueBinding = { 'run-a': 0, 'run-b': 1 };
      const rejectionId = randomUUID();
      // The STDOUT-side manifest (built below) uses the TRUE binding. The STDERR-side manifest is
      // written with the OPPOSITE (swapped) captureOrdinalByRunId -- each entry's own filename is
      // still internally self-consistent with ITS OWN declared pair, but the pairing is wrong.
      const swappedCaptureOrdinalByRunId = { 'run-a': 1, 'run-b': 0 };
      const { stderrManifest } = writeRejectionRawStderr(
        rejectionId,
        { 'run-a': journal.readStderrFor(0), 'run-b': journal.readStderrFor(1) },
        swappedCaptureOrdinalByRunId,
        { runsRootOverride },
      );
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null, rejectionId,
        rawTranscriptsManifest: [
          { run_id: 'run-a', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'run-a') },
          { run_id: 'run-b', capture_ordinal: 1, filename: deriveTranscriptFilename(1, 'run-b') },
        ],
        stderrManifest,
      };
      // Sanity: the STDOUT side alone is genuinely correct -- proves the eventual conservation is
      // caused by the STDERR pairing mismatch specifically.
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, trueBinding)).toBe(true);

      discardJournalIfRedundant(journal, result, trueBinding, runsRootOverride);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('acceptance branch (result.ok:true): does NOT discard when the journal\'s own stderr file was physically DELETED after a successful persist', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x', stderr: 'original stderr content' });
      const journalStderrPath = path.join(journal.journalDir, 'stderr', '0.txt');
      unlinkSync(journalStderrPath);

      discardJournalIfRedundant(journal, { ok: true }, { 'run-a': 0 }, runsRootOverride);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('acceptance branch (result.ok:true): does NOT discard when the journal\'s own stderr file was physically TRUNCATED (not deleted) after a successful persist', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x', stderr: 'original stderr content' });
      const journalStderrPath = path.join(journal.journalDir, 'stderr', '0.txt');
      writeFileSync(journalStderrPath, 'TRUNCATED-DIFFERENT-CONTENT');

      discardJournalIfRedundant(journal, { ok: true }, { 'run-a': 0 }, runsRootOverride);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('rejection branch: does NOT discard when the stderr manifest entry\'s OWN declared byte_length/sha256 are fabricated -- wrong on purpose -- even though the journal and rejection-tier files are both genuinely healthy and agree with EACH OTHER', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x', stderr: 'original stderr content' });
      const binding = { 'run-a': 0 };
      const rejectionId = randomUUID();
      const { stderrManifest } = writeRejectionRawStderr(rejectionId, { 'run-a': journal.readStderrFor(0) }, binding, { runsRootOverride });
      // The journal's own file and the rejection tier's own file are BOTH untouched and genuinely
      // agree with each other -- only the MANIFEST's own declared values are fabricated, proving
      // that check is independent of (not implied by) the cross-file comparison.
      const fabricatedManifest = stderrManifest.map((entry) => ({ ...entry, byte_length: entry.byte_length + 1, sha256: '0'.repeat(64) }));
      const result = {
        ok: false, rawTranscriptsPersisted: true, diagnosticsWriteError: null, rejectionId,
        rawTranscriptsManifest: [{ run_id: 'run-a', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'run-a') }],
        stderrManifest: fabricatedManifest,
      };
      expect(journalRawExactlyMatchesRejectionManifest(journal, result, binding)).toBe(true);

      discardJournalIfRedundant(journal, result, binding, runsRootOverride);
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('acceptance branch (result.ok:true) regression-lock: DOES discard when every executed cell\'s stderr is genuinely healthy (real, non-empty content, verified by rereading)', () => {
    const { journal, runsRootOverride } = makeJournal();
    try {
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: 1, rawStdout: 'x', stderr: 'healthy stderr content' });
      discardJournalIfRedundant(journal, { ok: true }, { 'run-a': 0 }, runsRootOverride);
      expect(existsSync(journal.journalDir)).toBe(false);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

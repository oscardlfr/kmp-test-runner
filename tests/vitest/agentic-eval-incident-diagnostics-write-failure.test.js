// tests/vitest/agentic-eval-incident-diagnostics-write-failure.test.js
// Isolated test for finalizeIncident's own two independent promoteTargetsAtomically calls (the
// emergency raw fallback and the main diagnostic write) -- via a scoped mock of evidence-io.mjs's
// promoteTargetsAtomically -- kept in its own file rather than agentic-eval-incident-diagnostics.test.js,
// matching this repo's established mock-isolation convention (see
// agentic-eval-write-evidence-gitcheck-fail-closed.test.js's own header comment): vi.mock() is
// hoisted and module-wide, so it would otherwise break every other test that relies on a real
// promoteTargetsAtomically call.
//
// Post-Codex-audit reproduction (PR #418): "emergency-raw success + diagnostic-write failure
// combination" -- neither of finalizeIncident's two independent transactions can be allowed to
// mask the other's outcome. The mock distinguishes the two calls by their OWN target path shape
// (the emergency-raw call always targets a path containing 'transcripts'; the main diagnostic
// write never does) rather than by call order, so this stays correct regardless of internal
// reordering.
import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../tools/agentic-eval/evidence-io.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    promoteTargetsAtomically: (targets, dirs) => {
      const isEmergencyRawWrite = targets.some(([targetPath]) => targetPath.includes('transcripts'));
      if (!isEmergencyRawWrite) {
        // Matches the realistic shape of promoteTargetsAtomically's own real EEXIST error (embeds
        // the full absolute target path) -- not just a generic message -- so this test actually
        // exercises the redaction/closed-fallback behavior, not merely a message with nothing to
        // redact in the first place.
        throw new Error(`EEXIST: refusing to overwrite ${targets[0][0]}`);
      }
      return actual.promoteTargetsAtomically(targets, dirs);
    },
  };
});

function freshRunsRoot() {
  return mkdtempSync(join(tmpdir(), 'aeidwf-runs-root-'));
}
function fakeJournal() {
  return {
    summarize: () => ({
      plannedCellCount: 2,
      counts: { planned: 2, spawn_started: 1, spawn_completed: 1, raw_persisted: 0, parsed: 0, evaluated: 0, spawn_failed: 0 },
      cellOrdinals: { planned: [0, 1], spawn_started: [0], spawn_completed: [0], raw_persisted: [], parsed: [], evaluated: [], spawn_failed: [] },
    }),
  };
}

describe('finalizeIncident -- the emergency raw fallback and the main diagnostic write are genuinely independent transactions', () => {
  it('when the primary journal write failed, the emergency raw fallback still succeeds for real even though the main diagnostic write is (independently) failing -- neither masks the other', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const sentinelRaw = '{"sentinel":"emergency-raw-still-lands-12345"}\n';
      let result;
      expect(() => {
        result = finalizeIncident({
          runKind: 'scenario', journal: fakeJournal(), phase: 'persisting_cell_journal',
          reasonText: 'journal write failed', cellOrdinal: 0, rawStdout: sentinelRaw,
          provenance: {}, runsRootOverride,
        });
      }).not.toThrow();

      // Transaction 1 (emergency raw) genuinely succeeded, unaffected by Transaction 2's failure.
      const expectedRawPath = join(runsRootOverride, 'agentic-eval-incident', 'raw', 'transcripts', result.incidentId, '0.jsonl');
      expect(existsSync(expectedRawPath)).toBe(true);
      expect(readFileSync(expectedRawPath, 'utf8')).toBe(sentinelRaw);

      // Transaction 2 (the main diagnostic artifact itself) honestly reports its own failure --
      // never silently claims success, never throws, never masks Transaction 1's real success.
      expect(result.diagnosticWritten).toBe(false);
      expect(typeof result.diagnosticWriteError).toBe('string');
      expect(result.diagnosticWriteError.length).toBeGreaterThan(0);
      // The real, absolute runsRootOverride path embedded in the raw underlying message must
      // never leak. HOW it's kept safe legitimately differs by platform (confirmed directly, a
      // real hosted Linux CI run): on Windows the path is PII-shaped (redactAndVerify's
      // user-home pattern) and gets redacted in place, leaving the surrounding "EEXIST: ..." text
      // intact; on POSIX, redactAndVerify's pattern is Windows-only and doesn't fire, so
      // ABSOLUTE_PATH_RE's own structural check (which DOES catch a POSIX path) instead falls all
      // the way back to the closed phase-code, replacing the whole message. Both are safe; this
      // test asserts only the REQUIRED invariant (never the real path), not which of the two
      // platform-dependent safe shapes it takes.
      expect(result.diagnosticWriteError).not.toContain(runsRootOverride);
      expect(existsSync(join(runsRootOverride, result.committedRelativePath))).toBe(false);

      // The ORIGINAL incident's own message is still fully usable.
      expect(result.message).toContain('persisting_cell_journal');
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

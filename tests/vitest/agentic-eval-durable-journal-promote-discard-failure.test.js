// tests/vitest/agentic-eval-durable-journal-promote-discard-failure.test.js
// Isolated test for durable-journal.mjs's promoteAndDiscard() under a REAL injected removeDirRobust
// failure -- via a scoped mock of materialize.mjs's removeDirRobust -- kept in its own file (vi.mock
// is hoisted/module-wide) matching this repo's established mock-isolation convention.
//
// Post-Codex-audit fix (PR #418): promoteAndDiscard previously caught and fully discarded its own
// failure with no return value at all -- this repo's own PR body claimed a discard failure surfaces
// as a reportCleanupFailures-style warning, but there was nothing for a caller to report. This
// proves the NEW {ok:false, warning:'journal_discard_failed'} contract under a genuine failure
// (not just the "directory already gone" trivial-success case agentic-eval-durable-journal.test.js
// itself covers), and that discardJournalIfRedundant (cli.mjs) reports it without throwing or
// affecting its own caller's control flow.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../tools/agentic-eval/materialize.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    removeDirRobust: () => {
      throw new Error('simulated: EBUSY, resource busy or locked (retries exhausted)');
    },
  };
});

function freshRunsRoot() {
  return mkdtempSync(join(tmpdir(), 'aedjpdf-runs-root-'));
}

describe('journal.promoteAndDiscard -- a real injected removeDirRobust failure', () => {
  it('returns {ok:false, warning:"journal_discard_failed"}, never throws, and the journal directory is honestly left in place', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      expect(existsSync(journal.journalDir)).toBe(true);

      let result;
      expect(() => { result = journal.promoteAndDiscard(); }).not.toThrow();
      expect(result).toEqual({ ok: false, warning: 'journal_discard_failed' });
      // Never the raw underlying error message (which could carry the real journalDir path) --
      // only the fixed, pre-approved closed code.
      expect(JSON.stringify(result)).not.toContain('EBUSY');
      // The directory removal genuinely never happened (removeDirRobust itself was intercepted),
      // matching the real underlying failure this simulates -- honestly left in place, not
      // silently reported as cleaned up.
      expect(existsSync(journal.journalDir)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

describe('discardJournalIfRedundant (cli.mjs) -- reports a real discard failure as a WARNING, never a command failure', () => {
  it('prints a WARNING to stderr and does not throw when promoteAndDiscard fails on the acceptance path', async () => {
    const { discardJournalIfRedundant } = await import('../../tools/agentic-eval/cli.mjs');
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      expect(() => discardJournalIfRedundant(journal, { ok: true }, ['run-a'])).not.toThrow();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/WARNING.*journal cleanup failed.*journal_discard_failed/));
    } finally {
      stderrSpy.mockRestore();
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

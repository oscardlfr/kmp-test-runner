// tests/vitest/agentic-eval-incident-diagnostics.test.js
// Unit tests for tools/agentic-eval/incident-diagnostics.mjs -- finalizeIncident(), the shared
// finalizer for both thrown exceptions (acquisition/materialization/journal-persist/parse/
// finalization) and non-gate {ok:false} results. Every test uses a mkdtempSync-rooted
// runsRootOverride, never the real tools/runs/.
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function freshRunsRoot() {
  return mkdtempSync(join(tmpdir(), 'aeid-runs-root-'));
}

function fakeJournalSummary(overrides = {}) {
  return {
    plannedCellCount: 4,
    counts: { planned: 4, spawn_started: 1, spawn_completed: 1, raw_persisted: 1, parsed: 1, evaluated: 1, spawn_failed: 0 },
    cellOrdinals: { planned: [0, 1, 2, 3], spawn_started: [0], spawn_completed: [0], raw_persisted: [0], parsed: [0], evaluated: [0], spawn_failed: [] },
    ...overrides,
  };
}
function fakeJournal(summaryOverrides = {}) {
  return { summarize: () => fakeJournalSummary(summaryOverrides) };
}
function fakeThrowingJournal() {
  return { summarize: () => { throw new Error('simulated: journal.summarize() itself threw'); } };
}

describe('finalizeIncident -- real-counter message, never the old generic lie', () => {
  it('builds a message containing real counts from the journal, not a hardcoded claim', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const result = finalizeIncident({
        runKind: 'scenario', journal: fakeJournal(), phase: 'materializing_cell',
        reasonText: 'a clean, safe reason', provenance: {}, runsRootOverride,
      });
      expect(result.message).toContain('1'); // real evaluated/spawn_started count, not "0" or a lie
      expect(result.message).not.toMatch(/before any cell completed/i);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('never includes a stack trace or an absolute path in the message', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const err = new Error('Evidence write refused: C:\\Users\\someone\\AppData\\Local\\Temp\\agentic-eval-scenario\\run-1.json already exists');
      const result = finalizeIncident({
        runKind: 'scenario', journal: fakeJournal(), phase: 'finalizing_matrix',
        reasonText: err.stack || err.message, provenance: {}, runsRootOverride,
      });
      expect(result.message).not.toContain('C:\\Users');
      expect(result.message).not.toContain('C:/Users');
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  // Regression coverage for a real local-ci (Linux lane) finding: a POSIX absolute path is not
  // PII-shaped (no username), so the existing redaction pipeline (Windows-user-path-only) lets it
  // through unchanged -- but Node's own fs error messages routinely single-quote one (this is
  // EXACTLY the shape `ENOENT: ... mkdtemp '/tmp/aeci-isolated-tmp-XXXXXX/...'` takes), and the
  // task's own invariant is "never an absolute path in stderr," not "never a PII-shaped one."
  it('never includes a POSIX absolute path either, even though it is not PII-shaped and the redaction pipeline alone would pass it through', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const err = new Error("ENOENT: no such file or directory, mkdtemp '/tmp/aeci-isolated-tmp-lM1BKV/this-directory-does-not-exist/kmp-agentic-eval-settings-XXXXXX'");
      const result = finalizeIncident({
        runKind: 'calibration', journal: fakeJournal(), phase: 'finalizing_matrix',
        reasonText: err.message, provenance: {}, runsRootOverride,
      });
      expect(result.message).not.toContain('/tmp/aeci-isolated-tmp-lM1BKV');
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('does NOT false-positive on ordinary double-quoted JSON-shaped reason text containing a slash', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const result = finalizeIncident({
        runKind: 'scenario', journal: fakeJournal(), phase: 'finalizing_matrix',
        reasonText: 'Run record [0] failed schema validation: [{"field":"a/b","message":"required"}]',
        provenance: {}, runsRootOverride,
      });
      expect(result.message).toContain('required');
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

describe('finalizeIncident -- reasonText/err.message is never trusted as already-safe', () => {
  it('redacts a reasonText containing an absolute path when redaction can clean it', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const result = finalizeIncident({
        runKind: 'scenario', journal: fakeJournal(), phase: 'finalizing_matrix',
        reasonText: 'refused: C:\\Users\\realname\\project\\file.json already exists',
        provenance: {}, runsRootOverride,
      });
      const committed = JSON.parse(readFileSync(join(runsRootOverride, result.committedRelativePath), 'utf8'));
      expect(JSON.stringify(committed)).not.toContain('C:\\Users\\realname');
      expect(JSON.stringify(committed)).not.toContain('realname');
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('falls back to a closed reason code (never raw text) when redaction cannot guarantee cleanliness', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const dangerousText = 'some text the redaction pipeline reports as unclean';
      // Injectable, matching this codebase's established pattern for hard-to-naturally-trigger
      // conditions (e.g. renameWithRetrySync's injectable `rename`) -- real leak-survives-
      // redaction cases are specific tools/lib/redact.mjs edge cases (documented in privacy.mjs's
      // own header comment), not something worth fragile-coupling this test to.
      const result = finalizeIncident({
        runKind: 'scenario', journal: fakeJournal(), phase: 'finalizing_matrix',
        reasonText: dangerousText, provenance: {}, runsRootOverride,
        redactReasonFn: () => ({ ok: false, redacted: null, leaks: [{ class: 'simulated', lineNo: 1 }] }),
      });
      const committed = JSON.parse(readFileSync(join(runsRootOverride, result.committedRelativePath), 'utf8'));
      expect(JSON.stringify(committed)).not.toContain(dangerousText);
      expect(typeof committed.reason).toBe('string');
      expect(committed.reason.length).toBeGreaterThan(0);
      expect(committed.reason).toBe('promotion_pipeline_rejected'); // the closed code for phase:'finalizing_matrix'
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

describe('finalizeIncident -- committed + local diagnostic tiers', () => {
  it('writes a committed diagnostic with phase, counts, and provenance, and a separate local gitignored tier', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      // scenario_id/project_commit -- the real provenance shape cmdRun actually passes (verified
      // against all 12 finalizeIncident call sites in cli.mjs); a field like repo_commit that no
      // real call site ever sends would now be rejected by the closed provenance validator.
      const result = finalizeIncident({
        runKind: 'scenario', journal: fakeJournal(), phase: 'materializing_cell',
        reasonText: 'clean reason', provenance: { project_commit: 'a'.repeat(40), scenario_id: 'x' }, runsRootOverride,
      });
      expect(result.committedRelativePath).toBe(join('agentic-eval-incident', `${result.incidentId}.json`));
      const committed = JSON.parse(readFileSync(join(runsRootOverride, result.committedRelativePath), 'utf8'));
      expect(committed.phase).toBe('materializing_cell');
      expect(committed.run_kind).toBe('scenario');
      expect(committed.counts).toBeDefined();
      expect(committed.provenance.project_commit).toBe('a'.repeat(40));

      const localPath = join(runsRootOverride, 'agentic-eval-incident', 'raw', `${result.incidentId}.json`);
      expect(existsSync(localPath)).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

describe('finalizeIncident -- emergency raw fallback, honestly accounted', () => {
  it('when the primary journal write failed but a raw payload is available, the fallback preserves it exactly at the documented path, and the diagnostic reports emergency_raw_persisted:true', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const sentinelRaw = '{"sentinel":"unique-raw-content-12345"}\n';
      const result = finalizeIncident({
        runKind: 'scenario', journal: fakeJournal(), phase: 'persisting_cell_journal',
        reasonText: 'journal write failed', cellOrdinal: 2, rawStdout: sentinelRaw,
        provenance: {}, runsRootOverride,
      });
      const expectedRawPath = join(runsRootOverride, 'agentic-eval-incident', 'raw', 'transcripts', result.incidentId, '2.jsonl');
      expect(existsSync(expectedRawPath)).toBe(true);
      expect(readFileSync(expectedRawPath, 'utf8')).toBe(sentinelRaw);

      const committed = JSON.parse(readFileSync(join(runsRootOverride, result.committedRelativePath), 'utf8'));
      expect(committed.emergency_raw_persisted).toBe(true);
      expect(committed.emergency_raw_write_error).toBeNull();
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('never attempts the emergency fallback (and never claims persistence) when no rawStdout is available -- e.g. a materializing_cell-phase incident', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const result = finalizeIncident({
        runKind: 'scenario', journal: fakeJournal(), phase: 'materializing_cell',
        reasonText: 'materialize threw', provenance: {}, runsRootOverride,
      });
      const committed = JSON.parse(readFileSync(join(runsRootOverride, result.committedRelativePath), 'utf8'));
      expect(committed.emergency_raw_persisted).toBe(false);
      expect(existsSync(join(runsRootOverride, 'agentic-eval-incident', 'raw', 'transcripts'))).toBe(false);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('when BOTH the primary journal write and the emergency fallback fail, honestly reports emergency_raw_persisted:false with a redacted write-error, and never masks the ORIGINAL incident\'s own phase/reason', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      // cellOrdinal out of any sane bound -- the fallback's own ordinal validation must refuse to
      // write, simulating "the fallback attempt itself failed" without needing to break the
      // filesystem to prove it.
      const result = finalizeIncident({
        runKind: 'scenario', journal: fakeJournal(), phase: 'persisting_cell_journal',
        reasonText: 'journal write failed', cellOrdinal: -1, rawStdout: 'some raw content',
        provenance: {}, runsRootOverride,
      });
      const committed = JSON.parse(readFileSync(join(runsRootOverride, result.committedRelativePath), 'utf8'));
      expect(committed.emergency_raw_persisted).toBe(false);
      expect(committed.emergency_raw_write_error).not.toBeNull();
      // The ORIGINAL incident's own phase/reason survive, unmasked by the fallback's own failure.
      expect(committed.phase).toBe('persisting_cell_journal');
      expect(typeof committed.reason).toBe('string');
      expect(committed.reason.length).toBeGreaterThan(0);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('finalizeIncident itself never throws, even when the fallback fails', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      expect(() => finalizeIncident({
        runKind: 'scenario', journal: fakeJournal(), phase: 'persisting_cell_journal',
        reasonText: 'x', cellOrdinal: -1, rawStdout: 'y', provenance: {}, runsRootOverride,
      })).not.toThrow();
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

// Post-Codex-audit fix (PR #418): finalizeIncident's own doc comment always claimed "never
// throws", but three real gaps let an exception escape uncaught -- journal.summarize(), the
// redaction call, and the final diagnostic write. Each is independently reproduced RED-before-fix
// here (each of these tests genuinely fails/throws against the pre-fix implementation -- confirmed
// directly against the exact pre-fix source before writing the fix).
describe('finalizeIncident -- total by construction: every internal failure point is independently guarded (Codex-audit fix, PR #418)', () => {
  it('never propagates when journal.summarize() itself throws -- degrades to an all-zero-counts summary, message still returned', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      let result;
      expect(() => {
        result = finalizeIncident({
          runKind: 'scenario', journal: fakeThrowingJournal(), phase: 'materializing_cell',
          reasonText: 'a clean reason', provenance: {}, runsRootOverride,
        });
      }).not.toThrow();
      expect(result.message).toContain('0/0 cells evaluated');
      expect(result.diagnosticWritten).toBe(true);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('never propagates when the redaction function itself throws (not just returns ok:false) -- falls back to the closed reason code', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      let result;
      expect(() => {
        result = finalizeIncident({
          runKind: 'scenario', journal: fakeJournal(), phase: 'materializing_cell',
          reasonText: 'irrelevant', provenance: {}, runsRootOverride,
          redactReasonFn: () => { throw new Error('simulated: redaction pipeline itself crashed'); },
        });
      }).not.toThrow();
      expect(result.message).toContain('materialization_or_reset_failed');
      const committed = JSON.parse(readFileSync(join(runsRootOverride, result.committedRelativePath), 'utf8'));
      expect(committed.reason).toBe('materialization_or_reset_failed');
      expect(JSON.stringify(committed)).not.toContain('irrelevant');
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('never propagates when the final diagnostic write itself throws (ENOTDIR) -- returns diagnosticWritten:false with a sanitized diagnosticWriteError, the original message is still returned', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    // A real ENOTDIR: runsRootOverride points AT A FILE, not a directory, so
    // join(runsRootOverride, 'agentic-eval-incident') tries to create a directory underneath a
    // path component that is actually a regular file.
    const parentDir = freshRunsRoot();
    const runsRootOverride = join(parentDir, 'a-file-not-a-directory');
    writeFileSync(runsRootOverride, 'not a directory');
    try {
      let result;
      expect(() => {
        result = finalizeIncident({
          runKind: 'scenario', journal: fakeJournal(), phase: 'materializing_cell',
          reasonText: 'a clean reason', provenance: {}, runsRootOverride,
        });
      }).not.toThrow();
      expect(result.diagnosticWritten).toBe(false);
      expect(typeof result.diagnosticWriteError).toBe('string');
      expect(result.diagnosticWriteError.length).toBeGreaterThan(0);
      // Never the raw underlying error message (which would embed runsRootOverride's own path).
      expect(result.diagnosticWriteError).not.toContain(runsRootOverride);
      // The ORIGINAL incident's own message is still fully usable -- a diagnostic-artifact write
      // failure never masks the incident this function exists to report.
      expect(result.message).toContain('materializing_cell');
      expect(result.incidentId.length).toBeGreaterThan(0);
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('returns diagnosticWritten:true and diagnosticWriteError:null on the ordinary success path', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const result = finalizeIncident({
        runKind: 'scenario', journal: fakeJournal(), phase: 'materializing_cell',
        reasonText: 'a clean reason', provenance: {}, runsRootOverride,
      });
      expect(result.diagnosticWritten).toBe(true);
      expect(result.diagnosticWriteError).toBeNull();
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

// Post-Codex-audit fix (PR #418): the committed/local diagnostic artifact had no structural
// validation at all beyond the PII-redaction pipeline (which only checks for private-pattern
// SHAPES, never schema correctness) -- a bogus run_kind, unknown phase, non-integer/negative
// counter, or unexpected provenance key could all reach disk unchanged. Each is independently
// reproduced here: finalizeIncident is called with a deliberately malformed input, and the
// COMMITTED artifact is asserted to have fallen back to the guaranteed-valid minimal shape rather
// than echoing the malformed value.
describe('finalizeIncident -- closed schema validation, both before and after redaction (Codex-audit fix, PR #418)', () => {
  it('a bogus run_kind never reaches the committed diagnostic -- falls back to a valid run_kind', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const result = finalizeIncident({
        runKind: 'bogus-kind', journal: fakeJournal(), phase: 'materializing_cell',
        reasonText: 'x', provenance: {}, runsRootOverride,
      });
      const committed = JSON.parse(readFileSync(join(runsRootOverride, result.committedRelativePath), 'utf8'));
      expect(['calibration', 'smoke', 'scenario']).toContain(committed.run_kind);
      expect(committed.run_kind).not.toBe('bogus-kind');
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('an unknown phase never reaches the committed diagnostic -- falls back to a valid phase', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const result = finalizeIncident({
        runKind: 'scenario', journal: fakeJournal(), phase: 'not-a-real-phase',
        reasonText: 'x', provenance: {}, runsRootOverride,
      });
      const committed = JSON.parse(readFileSync(join(runsRootOverride, result.committedRelativePath), 'utf8'));
      expect(committed.phase).not.toBe('not-a-real-phase');
      expect(committed.phase.length).toBeGreaterThan(0);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('a string counter value (from a corrupted journal summary) never reaches the committed diagnostic -- falls back to the guaranteed-valid zero counts', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const corruptJournal = { summarize: () => fakeJournalSummary({ counts: { planned: 4, spawn_started: 'one', spawn_completed: 1, raw_persisted: 1, parsed: 1, evaluated: 1, spawn_failed: 0 } }) };
      const result = finalizeIncident({
        runKind: 'scenario', journal: corruptJournal, phase: 'materializing_cell',
        reasonText: 'x', provenance: {}, runsRootOverride,
      });
      const committed = JSON.parse(readFileSync(join(runsRootOverride, result.committedRelativePath), 'utf8'));
      expect(typeof committed.counts.spawn_started).toBe('number');
      for (const v of Object.values(committed.counts)) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('a negative counter total (from a corrupted journal summary) never reaches the committed diagnostic', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const corruptJournal = { summarize: () => fakeJournalSummary({ counts: { planned: 4, spawn_started: -1, spawn_completed: 1, raw_persisted: 1, parsed: 1, evaluated: 1, spawn_failed: 0 } }) };
      const result = finalizeIncident({
        runKind: 'scenario', journal: corruptJournal, phase: 'materializing_cell',
        reasonText: 'x', provenance: {}, runsRootOverride,
      });
      const committed = JSON.parse(readFileSync(join(runsRootOverride, result.committedRelativePath), 'utf8'));
      for (const v of Object.values(committed.counts)) {
        expect(v).toBeGreaterThanOrEqual(0);
      }
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('an arbitrary/unexpected provenance key never reaches the committed diagnostic -- falls back to empty provenance', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const result = finalizeIncident({
        runKind: 'scenario', journal: fakeJournal(), phase: 'materializing_cell',
        reasonText: 'x', provenance: { totally_arbitrary_field: 'anything at all' }, runsRootOverride,
      });
      const committed = JSON.parse(readFileSync(join(runsRootOverride, result.committedRelativePath), 'utf8'));
      expect(committed.provenance.totally_arbitrary_field).toBeUndefined();
      expect(JSON.stringify(committed)).not.toContain('totally_arbitrary_field');
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('a fully well-formed diagnostic is written verbatim -- the validator does not reject legitimate input', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const result = finalizeIncident({
        runKind: 'scenario', journal: fakeJournal(), phase: 'materializing_cell',
        reasonText: 'a clean reason', provenance: { scenario_id: 'x', project_alias: 'y', project_commit: 'a'.repeat(40), seed: 7, model_requested: 'claude-sonnet-5' },
        runsRootOverride,
      });
      const committed = JSON.parse(readFileSync(join(runsRootOverride, result.committedRelativePath), 'utf8'));
      expect(committed.run_kind).toBe('scenario');
      expect(committed.phase).toBe('materializing_cell');
      expect(committed.provenance.scenario_id).toBe('x');
      expect(committed.provenance.seed).toBe(7);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

// Independent adversarial review finding (CodeRabbit + Codex both flagged this, PR #418): the
// drive-letter branch requires `:` and the POSIX branch requires a leading `/` -- neither can
// structurally match a Windows UNC path's leading `\\`.
describe('finalizeIncident -- a Windows UNC path never reaches stderr or the committed diagnostic (Codex/CodeRabbit-audit fix, PR #418)', () => {
  it('redacts or closed-codes a UNC path exactly like any other absolute path', async () => {
    const { finalizeIncident } = await import('../../tools/agentic-eval/incident-diagnostics.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const result = finalizeIncident({
        runKind: 'scenario', journal: fakeJournal(), phase: 'finalizing_matrix',
        reasonText: 'Evidence write refused: \\\\server\\share\\private\\file already exists',
        provenance: {}, runsRootOverride,
      });
      expect(result.message).not.toContain('\\\\server\\share');
      const committed = JSON.parse(readFileSync(join(runsRootOverride, result.committedRelativePath), 'utf8'));
      expect(JSON.stringify(committed)).not.toContain('\\\\server\\share');
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

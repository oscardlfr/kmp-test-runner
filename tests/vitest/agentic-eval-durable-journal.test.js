// tests/vitest/agentic-eval-durable-journal.test.js
// Unit tests for tools/agentic-eval/durable-journal.mjs -- the per-invocation crash-safety journal.
// Every test uses a mkdtempSync-rooted runsRootOverride, never the real tools/runs/.
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function freshRunsRoot() {
  return mkdtempSync(join(tmpdir(), 'aedj-runs-root-'));
}

function correlationSummary() {
  return {
    schema: 1,
    condition: 'no-skill',
    policy_mode: 'not_applicable',
    tool_use_counts_by_kind: { shell: 1, skill: 0, other: 0 },
    missing_id_counts_by_kind: { shell: 0, skill: 0, other: 0 },
    missing_result_counts_by_kind: { shell: 1, skill: 0, other: 0 },
    dispatch_status_counts: {
      hook_evaluated: 0, pre_dispatch_blocked: 0, result_correlated_no_policy: 0,
      unaccounted: 1, unclassified: 0,
    },
    correlation_issue_counts: {
      duplicate_tool_use_id: 0, orphan_tool_result_missing_id: 0,
      orphan_tool_result_unknown_id: 0, duplicate_tool_result: 0, malformed_stream_line: 0,
    },
    timeout_tolerance_applied: false,
  };
}

describe('createInvocationJournal -- creation, preflight, planned events', () => {
  it('creates a journal directory under agentic-eval-journal/<invocation-id>/ with a planned event per cell, written before any spawn', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 4, runsRootOverride });
      expect(journal.journalDir).toContain(join('agentic-eval-journal'));
      expect(existsSync(journal.journalDir)).toBe(true);
      const summary = journal.summarize();
      expect(summary.counts.planned).toBe(4);
      expect(summary.plannedCellCount).toBe(4);
      for (let i = 0; i < 4; i++) {
        expect(summary.cellOrdinals.planned).toContain(i);
      }
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('two separate invocations get two separate journal directories (never collide)', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const j1 = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 2, runsRootOverride });
      const j2 = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 2, runsRootOverride });
      expect(j1.journalDir).not.toBe(j2.journalDir);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

describe('journal transition state machine -- the normal branch', () => {
  it('walks planned -> spawn_started -> spawn_completed -> raw_persisted -> parsed -> evaluated for a real spawn, in order, atomically persisting the raw content', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: '{"line":1}\n', stderr: '' });
      journal.recordParsed(0);
      journal.recordEvaluated(0);

      const summary = journal.summarize();
      expect(summary.counts).toMatchObject({
        planned: 1, spawn_started: 1, spawn_completed: 1, raw_persisted: 1, parsed: 1, evaluated: 1, spawn_failed: 0,
      });

      expect(journal.readRawFor(0)).toBe('{"line":1}\n');
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('persists a validated count-only correlation summary in the evaluated event and exposes it by ordinal', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'x', stderr: '' });
      journal.recordParsed(0);
      journal.recordEvaluated(0, correlationSummary());

      expect(journal.summarize().correlationSummaries).toEqual({ 0: correlationSummary() });
      const evaluatedFile = readdirSync(join(journal.journalDir, 'events')).find((name) => name.endsWith('-evaluated.json'));
      const event = JSON.parse(readFileSync(join(journal.journalDir, 'events', evaluatedFile), 'utf8'));
      expect(event.meta).toEqual({ correlation_observability: correlationSummary() });
      expect(JSON.stringify(event)).not.toMatch(/toolu-|command|prompt|response|raw|stderr|[A-Za-z]:\\/i);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('rejects a malformed/expanded correlation summary before transitioning, while legacy callers may still omit it', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'x', stderr: '' });
      journal.recordParsed(0);
      expect(() => journal.recordEvaluated(0, { ...correlationSummary(), raw: 'forbidden' })).toThrow(/correlation observability/i);
      expect(journal.summarize().counts.evaluated).toBe(0);
      journal.recordEvaluated(0);
      expect(journal.summarize().correlationSummaries).toEqual({});
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('writes each transition as its own immutable event file (never an append-only log), sortable by a monotonic seq prefix', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'x', stderr: '' });
      journal.recordParsed(0);

      const eventsDir = join(journal.journalDir, 'events');
      const files = readdirSync(eventsDir).sort();
      // planned (from creation) + spawn_started + spawn_completed + raw_persisted + parsed = 5 distinct files
      expect(files.length).toBe(5);
      const transitions = files.map((f) => JSON.parse(readFileSync(join(eventsDir, f), 'utf8')).transition);
      expect(transitions).toEqual(['planned', 'spawn_started', 'spawn_completed', 'raw_persisted', 'parsed']);
      // Every file name is unique -- proves this is a write-once mechanism, not append.
      expect(new Set(files).size).toBe(files.length);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

describe('journal transition state machine -- the spawn_failed terminal branch', () => {
  it('records spawn_failed (terminal) when didSpawn is false, never spawn_started/spawn_completed/raw_persisted, and writes no raw file', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      journal.persistSpawnOutcome(0, { didSpawn: false, spawnStartedAt: null, rawStdout: '' });

      const summary = journal.summarize();
      expect(summary.counts).toMatchObject({
        planned: 1, spawn_started: 0, spawn_completed: 0, raw_persisted: 0, parsed: 0, evaluated: 0, spawn_failed: 1,
      });
      expect(existsSync(join(journal.journalDir, 'raw', '0.jsonl'))).toBe(false);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('rejects any further transition attempt after spawn_failed -- it is genuinely terminal', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      journal.persistSpawnOutcome(0, { didSpawn: false, spawnStartedAt: null, rawStdout: '' });
      expect(() => journal.recordParsed(0)).toThrow(/spawn_failed|terminal|illegal transition/i);
      expect(() => journal.recordEvaluated(0)).toThrow(/spawn_failed|terminal|illegal transition/i);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

describe('journal transition state machine -- rejects illegal transitions (wiring-bug guard)', () => {
  it('rejects recordParsed before persistSpawnOutcome has ever run for that cell (out-of-order)', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      expect(() => journal.recordParsed(0)).toThrow(/illegal transition|out.of.order|expected/i);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('rejects a duplicate persistSpawnOutcome for the same cell', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'a', stderr: '' });
      expect(() => journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'b', stderr: '' }))
        .toThrow(/illegal transition|duplicate|already/i);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('rejects a cellOrdinal outside [0, plannedCellCount)', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 2, runsRootOverride });
      expect(() => journal.persistSpawnOutcome(2, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'x', stderr: '' }))
        .toThrow(/cellOrdinal|out of range|bounds/i);
      expect(() => journal.persistSpawnOutcome(-1, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'x', stderr: '' }))
        .toThrow(/cellOrdinal|out of range|bounds/i);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

describe('journal coherence invariants (summarize)', () => {
  it('reports nested per-transition ordinal sets consistent with a partially-progressed matrix', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 3, runsRootOverride });
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'a', stderr: '' });
      journal.recordParsed(0);
      journal.recordEvaluated(0);
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'b', stderr: '' });
      // cell 1 stops after raw_persisted -- never parsed/evaluated (simulates a mid-parse crash)
      // cell 2 never even starts -- still just planned

      const summary = journal.summarize();
      expect(summary.counts).toMatchObject({
        planned: 3, spawn_started: 2, spawn_completed: 2, raw_persisted: 2, parsed: 1, evaluated: 1, spawn_failed: 0,
      });
      expect(summary.cellOrdinals.evaluated).toEqual([0]);
      expect(summary.cellOrdinals.raw_persisted.sort()).toEqual([0, 1]);
      expect(summary.cellOrdinals.planned.sort()).toEqual([0, 1, 2]);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

describe('journal.readRawFor', () => {
  it('returns null for a cell that never reached raw_persisted', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      expect(journal.readRawFor(0)).toBeNull();
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  // Post-Codex-audit fix (PR #418, independently also flagged by CodeRabbit): readRawFor never
  // called assertOrdinal() -- a crafted, path-shaped cellOrdinal interpolated straight into join()
  // and could escape raw/ entirely. Confirmed by direct reproduction before this fix: a sentinel
  // file planted at events/leak.jsonl was read back by readRawFor('../events/leak') as though it
  // were cell 0's own raw transcript.
  describe('rejects a malformed cellOrdinal instead of resolving outside raw/ (Codex/CodeRabbit-audit fix, PR #418)', () => {
    it('throws on a negative cellOrdinal', async () => {
      const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
      const runsRootOverride = freshRunsRoot();
      try {
        const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
        expect(() => journal.readRawFor(-1)).toThrow(/cellOrdinal|out of bounds/i);
      } finally {
        rmSync(runsRootOverride, { recursive: true, force: true });
      }
    });

    it('throws on an out-of-range cellOrdinal (>= plannedCellCount)', async () => {
      const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
      const runsRootOverride = freshRunsRoot();
      try {
        const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
        expect(() => journal.readRawFor(1)).toThrow(/cellOrdinal|out of bounds/i);
      } finally {
        rmSync(runsRootOverride, { recursive: true, force: true });
      }
    });

    it('throws on a path-traversal-shaped cellOrdinal, never reading a sentinel file planted outside raw/', async () => {
      const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
      const { writeFileSync } = await import('node:fs');
      const runsRootOverride = freshRunsRoot();
      try {
        const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
        // A real sentinel planted exactly where the pre-fix bug's own reproduction found it --
        // events/leak.jsonl, a sibling directory of raw/ under the same journalDir.
        const eventsDir = join(journal.journalDir, 'events');
        writeFileSync(join(eventsDir, 'leak.jsonl'), 'SENTINEL_SHOULD_NEVER_BE_READ_BACK');
        expect(() => journal.readRawFor('../events/leak')).toThrow(/cellOrdinal|out of bounds/i);
      } finally {
        rmSync(runsRootOverride, { recursive: true, force: true });
      }
    });
  });
});

describe('journal.promoteAndDiscard', () => {
  it('deletes the whole journal directory and returns {ok:true}', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      const dir = journal.journalDir;
      expect(existsSync(dir)).toBe(true);
      expect(journal.promoteAndDiscard()).toEqual({ ok: true });
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  // Post-Codex-audit fix (PR #418): the pre-fix implementation caught and fully discarded its own
  // failure -- no return value at all, contradicting this module's own claim (echoed in the PR
  // body) that a discard failure surfaces as a warning. See
  // agentic-eval-durable-journal-promote-discard-failure.test.js for a REAL injected
  // removeDirRobust failure (via vi.mock, isolated in its own file); this test only proves the
  // "directory already gone" case is harmless and never throws.
  it('a failure during discard is reported as a warning-shaped {ok:false, warning} result, never thrown -- a late cleanup failure must not look like a lost-evidence failure', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      // Remove the directory out from under the journal first, so the real removal step underneath
      // promoteAndDiscard() has nothing to act on in the normal way -- still must not throw.
      rmSync(journal.journalDir, { recursive: true, force: true });
      let result;
      expect(() => { result = journal.promoteAndDiscard(); }).not.toThrow();
      // removeDirRobust's own postcondition (existsFn(path) === false) is satisfied trivially
      // here (already gone), so this specific case resolves {ok:true} -- the REAL failure case is
      // covered by the isolated vi.mock file referenced above.
      expect(result).toEqual({ ok: true });
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

describe('journal stderr tier -- persistence, redaction, absent-vs-empty contract', () => {
  it('persists stderr alongside rawStdout, and readStderrFor returns the exact (already-redacted) text', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'stdout-content', stderr: 'a real stderr line\n' });
      expect(journal.readRawFor(0)).toBe('stdout-content');
      expect(journal.readStderrFor(0)).toBe('a real stderr line\n');
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('summarize() exposes stderrMeta keyed by cellOrdinal, with real byteLength/sha256 computed from a REREAD of the file on disk', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const { createHash } = await import('node:crypto');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'x', stderr: 'stderr-text' });
      const { stderrMeta } = journal.summarize();
      expect(stderrMeta[0].present).toBe(true);
      expect(stderrMeta[0].writeError).toBeNull();
      expect(stderrMeta[0].byteLength).toBe(Buffer.byteLength('stderr-text', 'utf8'));
      expect(stderrMeta[0].sha256).toBe(createHash('sha256').update('stderr-text', 'utf8').digest('hex'));
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('an empty string is a legitimate, distinct, stable stderr value -- present:true, byteLength:0, readStderrFor returns \'\' (never null)', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const { createHash } = await import('node:crypto');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'x', stderr: '' });
      const { stderrMeta } = journal.summarize();
      expect(stderrMeta[0]).toEqual({ present: true, byteLength: 0, sha256: createHash('sha256').update('', 'utf8').digest('hex'), writeError: null });
      expect(journal.readStderrFor(0)).toBe('');
      expect(journal.readStderrFor(0)).not.toBeNull();
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('a cell that never spawned has stderr "absent", not "empty" -- readStderrFor returns null, same as readRawFor', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      journal.persistSpawnOutcome(0, { didSpawn: false, spawnStartedAt: null, rawStdout: '' });
      expect(journal.readRawFor(0)).toBeNull();
      expect(journal.readStderrFor(0)).toBeNull();
      expect(journal.summarize().stderrMeta[0]).toBeUndefined();
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('stderr that is not a string is a structural failure (stderr_not_a_string), never silently treated as empty -- throws, but rawStdout is preserved first', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      expect(() => journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'stdout-survives', stderr: undefined }))
        .toThrow(/stderr_not_a_string/);
      expect(journal.readRawFor(0)).toBe('stdout-survives'); // rawStdout write happened BEFORE the stderr failure
      expect(journal.summarize().stderrMeta[0]).toEqual({ present: false, byteLength: 0, sha256: null, writeError: 'stderr_not_a_string' });
      expect(journal.readStderrFor(0)).toBeNull();
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('a null stderr is the same structural failure as undefined -- never coerced to an empty string', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      expect(() => journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'x', stderr: null }))
        .toThrow(/stderr_not_a_string/);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('redacts a known PII pattern (a Windows user-home path) before persisting -- the file on disk never contains the raw path', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const { findLeaks, PUBLIC_SHAPE_RULES } = await import('../../tools/agentic-eval/privacy.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      const sensitiveStderr = 'Error: ENOENT, open \'C:\\Users\\realname\\.claude\\config.json\'';
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'x', stderr: sensitiveStderr });
      const onDisk = journal.readStderrFor(0);
      expect(onDisk).not.toContain('realname');
      expect(findLeaks(onDisk, PUBLIC_SHAPE_RULES)).toEqual([]);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

// Post-Codex-audit fix (PR #418, independently also flagged by CodeRabbit): a 4-digit seq width
// places seq 10000 ('10000-...') lexically BEFORE seq 9999 ('9999-...') in a directory listing,
// breaking the documented sortable event order. buildEventFilename is exported as a pure function
// specifically so this boundary is verifiable without driving a real journal through thousands of
// real event writes.
describe('buildEventFilename -- stays lexically sortable well past any realistically achievable event count', () => {
  it('seq 9999 sorts before seq 10000 (the exact boundary a 4-digit width would get wrong)', async () => {
    const { buildEventFilename } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const a = buildEventFilename(9999, 0, 'planned');
    const b = buildEventFilename(10000, 0, 'planned');
    expect(a < b).toBe(true);
    // Confirms it's genuinely a lexical (string) comparison being exercised, not an accidental
    // numeric one.
    expect(typeof a).toBe('string');
    expect(a.length).toBe(b.length);
  });

  it('stays sortable across every power-of-ten boundary up to a generously large seq', async () => {
    const { buildEventFilename } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const boundaries = [9, 99, 999, 9999, 99999];
    for (const n of boundaries) {
      const lower = buildEventFilename(n, 0, 'planned');
      const upper = buildEventFilename(n + 1, 0, 'planned');
      expect(lower < upper, `seq ${n} vs ${n + 1}`).toBe(true);
    }
  });

  it('produces the documented <seq>-<cellOrdinal>-<transitionName>.json shape', async () => {
    const { buildEventFilename } = await import('../../tools/agentic-eval/durable-journal.mjs');
    expect(buildEventFilename(0, 3, 'spawn_started')).toBe('000000000000-3-spawn_started.json');
  });
});

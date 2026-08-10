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
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: '{"line":1}\n' });
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

  it('writes each transition as its own immutable event file (never an append-only log), sortable by a monotonic seq prefix', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'x' });
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
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'a' });
      expect(() => journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'b' }))
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
      expect(() => journal.persistSpawnOutcome(2, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'x' }))
        .toThrow(/cellOrdinal|out of range|bounds/i);
      expect(() => journal.persistSpawnOutcome(-1, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'x' }))
        .toThrow(/cellOrdinal|out of range|bounds/i);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

describe('journal coherence invariants (summarize)', () => {
  it('reports a nested nested-set nested picture consistent with a partially-progressed matrix', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 3, runsRootOverride });
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'a' });
      journal.recordParsed(0);
      journal.recordEvaluated(0);
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'b' });
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
});

describe('journal.promoteAndDiscard', () => {
  it('deletes the whole journal directory', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      const dir = journal.journalDir;
      expect(existsSync(dir)).toBe(true);
      journal.promoteAndDiscard();
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });

  it('a failure during discard is reported as a warning-shaped result, never thrown -- a late cleanup failure must not look like a lost-evidence failure', async () => {
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const runsRootOverride = freshRunsRoot();
    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride });
      // Remove the directory out from under the journal first, so the real removal step underneath
      // promoteAndDiscard() has nothing to act on in the normal way -- still must not throw.
      rmSync(journal.journalDir, { recursive: true, force: true });
      expect(() => journal.promoteAndDiscard()).not.toThrow();
    } finally {
      rmSync(runsRootOverride, { recursive: true, force: true });
    }
  });
});

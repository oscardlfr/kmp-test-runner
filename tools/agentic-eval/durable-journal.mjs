#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/durable-journal.mjs -- per-invocation crash-safety journal.
//
// Closes a real gap: today, a live Claude session's raw transcript exists ONLY in memory
// (condition-launcher.mjs's spawnCondition) until the very end of a run (full promotion) or a
// detected hard-gate rejection (rejection-diagnostics.mjs). An exception thrown BETWEEN cells --
// while materializing/resetting the NEXT cell, or anywhere in a cell's own post-spawn processing --
// discards an already-completed, already-billable session with zero trace on disk, in any tier
// (the 2026-08-10 canary incident this module exists to close).
//
// This journal is a write-ahead safety net, created once per invocation (cmdRun/cmdCalibrate/
// cmdSmoke, before the first spawn) and threaded down to runSingleCondition (matrix-runner.mjs).
// Storage is IMMUTABLE, single-purpose files -- never an append-only log -- because the one atomic
// write primitive this codebase has (evidence-io.mjs's promoteTargetsAtomically) is a
// write-once/refuse-to-overwrite primitive, not an append primitive. Each transition is its own
// small file under events/; each cell's raw payload is its own file under raw/.
//
// The transition state machine is closed and enforced here, not merely documented: an out-of-order,
// duplicate, or otherwise illegal transition throws immediately -- a wiring bug in the caller should
// fail loudly during development, not be silently accepted.
//
//   planned -> spawn_started -> spawn_completed -> raw_persisted -> parsed -> evaluated
//   planned -> spawn_failed                                                    (terminal)
//
// The spawn_failed branch exists because spawnCondition can resolve via its child.on('error') path
// (e.g. ENOENT) WITHOUT the process ever actually starting -- recording spawn_started/
// spawn_completed/raw_persisted for a process that never spawned would be a lie the accounting
// this journal exists to make trustworthy cannot afford.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { RUNS_ROOT, isRawDirSafeFromAccidentalCommit, promoteTargetsAtomically } from './evidence-io.mjs';
import { removeDirRobust } from './materialize.mjs';

/** Closed vocabulary an incident's thrown error is tagged with (agenticEvalPhase), so
 * incident-diagnostics.mjs's finalizeIncident() never has to guess which phase failed. */
export const AGENTIC_EVAL_INCIDENT_PHASES = Object.freeze([
  'acquiring_shared_resources',
  'materializing_cell',
  'persisting_cell_journal',
  'parsing_or_attributing_cell',
  'finalizing_matrix',
]);

/**
 * Tags a caught error with the phase/cellOrdinal (and, when available, the cell's own rawStdout)
 * it failed under, then returns it for rethrowing -- shared by every wrap point in
 * matrix-runner.mjs and cli.mjs so the tagging shape is defined in exactly one place. Never
 * overwrites a tag a more precise, deeper wrap point already set (an outer wrap catching an
 * already-tagged error must not clobber it).
 * @param {Error} err
 * @param {string} phase - one of AGENTIC_EVAL_INCIDENT_PHASES
 * @param {number} [cellOrdinal]
 * @param {string} [rawStdout]
 * @returns {Error}
 */
export function tagIncidentPhase(err, phase, cellOrdinal, rawStdout) {
  if (err.agenticEvalPhase === undefined) err.agenticEvalPhase = phase;
  if (cellOrdinal !== undefined && err.agenticEvalCellOrdinal === undefined) err.agenticEvalCellOrdinal = cellOrdinal;
  if (rawStdout !== undefined && err.agenticEvalRawStdout === undefined) err.agenticEvalRawStdout = rawStdout;
  return err;
}

const TRANSITIONS = Object.freeze(['planned', 'spawn_started', 'spawn_completed', 'raw_persisted', 'parsed', 'evaluated', 'spawn_failed']);

// 12 digits generously exceeds any real invocation's event count -- a full MAX_REPEATS=20 matrix
// produces at most ~240 events (up to 40 cells x 6 transitions each) -- so a lexical directory
// listing stays correctly seq-ordered no matter how large a single invocation's journal grows.
// Post-Codex-audit fix (PR #418, independently also flagged by CodeRabbit): the previous 4-digit
// width would place seq 10000 ('10000-...') lexically BEFORE seq 9999 ('9999-...'), breaking the
// documented sortable event order past 9999 events. Extracted as its own pure, exported function
// so the boundary (seq 9999 vs 10000) is directly unit-testable without driving a real journal
// through thousands of real event writes.
const EVENT_SEQ_WIDTH = 12;

/** Pure event-filename builder, shared by writeEvent() below. */
export function buildEventFilename(seq, cellOrdinal, transitionName) {
  return `${String(seq).padStart(EVENT_SEQ_WIDTH, '0')}-${cellOrdinal}-${transitionName}.json`;
}

// The legal NEXT transition(s) given a cell's current state (its last recorded transition, or
// `null` before anything has been recorded for it). `evaluated` and `spawn_failed` are terminal --
// both map to an empty allowed-next list.
const NEXT_ALLOWED = Object.freeze({
  null: ['planned'],
  planned: ['spawn_started', 'spawn_failed'],
  spawn_started: ['spawn_completed'],
  spawn_completed: ['raw_persisted'],
  raw_persisted: ['parsed'],
  parsed: ['evaluated'],
  evaluated: [],
  spawn_failed: [],
});

/**
 * Creates a new per-invocation journal. MUST be called before the first spawn -- writes a
 * `planned` event for every one of `plannedCellCount` slots up front, so a caller can prove "every
 * cell this invocation intended to run" independently of how far execution actually got. Preflighted
 * with the exact same gitignore-safety check every other local-only tier in this harness uses
 * (`isRawDirSafeFromAccidentalCommit`) before anything is written.
 * @param {{runKind: string, plannedCellCount: number, runsRootOverride?: string}} opts
 */
export function createInvocationJournal({ runKind, plannedCellCount, runsRootOverride = RUNS_ROOT }) {
  if (!Number.isInteger(plannedCellCount) || plannedCellCount < 0) {
    throw new Error(`createInvocationJournal: plannedCellCount must be a non-negative integer, got ${JSON.stringify(plannedCellCount)}`);
  }
  const invocationId = randomUUID();
  const journalDir = join(runsRootOverride, 'agentic-eval-journal', invocationId);
  const eventsDir = join(journalDir, 'events');
  const rawDir = join(journalDir, 'raw');
  // Fail closed BEFORE any filesystem I/O -- isRawDirSafeFromAccidentalCommit only needs the path
  // STRING (git check-ignore doesn't require the target to exist), so checking it before
  // mkdirSync means a refusal here never leaves an orphaned, empty journal directory tree behind.
  if (!isRawDirSafeFromAccidentalCommit(journalDir, runsRootOverride)) {
    throw new Error(`createInvocationJournal: ${journalDir} is not confirmed covered by .gitignore -- refusing to create a journal there`);
  }
  mkdirSync(eventsDir, { recursive: true });

  let seq = 0;
  const lastTransition = new Array(plannedCellCount).fill(null);
  const cellOrdinalsByTransition = Object.fromEntries(TRANSITIONS.map((t) => [t, new Set()]));

  function writeEvent(cellOrdinal, transitionName, meta) {
    const thisSeq = seq;
    seq += 1;
    const filename = buildEventFilename(thisSeq, cellOrdinal, transitionName);
    const content = JSON.stringify({ seq: thisSeq, ts: Date.now(), runKind, cellOrdinal, transition: transitionName, meta });
    promoteTargetsAtomically([[join(eventsDir, filename), content]], eventsDir);
  }

  function assertOrdinal(cellOrdinal) {
    if (!Number.isInteger(cellOrdinal) || cellOrdinal < 0 || cellOrdinal >= plannedCellCount) {
      throw new Error(`journal: cellOrdinal ${JSON.stringify(cellOrdinal)} is out of bounds [0, ${plannedCellCount})`);
    }
  }

  function transitionTo(cellOrdinal, name, meta = {}) {
    assertOrdinal(cellOrdinal);
    const current = lastTransition[cellOrdinal];
    const allowed = NEXT_ALLOWED[current === null ? 'null' : current] ?? [];
    if (!allowed.includes(name)) {
      throw new Error(`journal: illegal transition '${name}' for cellOrdinal ${cellOrdinal} (current state: ${current ?? 'none'}; allowed next: ${JSON.stringify(allowed)})`);
    }
    writeEvent(cellOrdinal, name, meta);
    lastTransition[cellOrdinal] = name;
    cellOrdinalsByTransition[name].add(cellOrdinal);
  }

  for (let i = 0; i < plannedCellCount; i++) transitionTo(i, 'planned');

  return {
    journalDir,

    /**
     * The whole post-spawn outcome for one cell, persisted as the single next operation after
     * `spawnCondition` resolves -- before any parsing. `didSpawn`/`spawnStartedAt` come from the
     * caller's own `onSpawned` callback (never from inspecting spawnResult.terminated/
     * terminationReason after the fact, which conflates "never started" with "started, then
     * crashed" -- only the callback's own firing unambiguously distinguishes them).
     * @param {number} cellOrdinal
     * @param {{didSpawn: boolean, spawnStartedAt: number|null, rawStdout: string}} outcome
     */
    persistSpawnOutcome(cellOrdinal, { didSpawn, spawnStartedAt, rawStdout }) {
      if (!didSpawn) {
        transitionTo(cellOrdinal, 'spawn_failed');
        return;
      }
      transitionTo(cellOrdinal, 'spawn_started', { spawnStartedAt });
      transitionTo(cellOrdinal, 'spawn_completed');
      const rawPath = join(rawDir, `${cellOrdinal}.jsonl`);
      promoteTargetsAtomically([[rawPath, rawStdout]], rawDir);
      transitionTo(cellOrdinal, 'raw_persisted');
    },

    recordParsed(cellOrdinal) {
      transitionTo(cellOrdinal, 'parsed');
    },

    recordEvaluated(cellOrdinal) {
      transitionTo(cellOrdinal, 'evaluated');
    },

    /** Real counts + cellOrdinal sets per transition -- the source of truth for both
     * incident-diagnostics.mjs's real-counter messaging and the §6 exact-correspondence discard
     * check. Also enforces the closed coherence invariants by construction (never computed
     * separately): every recorded ordinal is in-bounds and un-duplicated (assertOrdinal +
     * Set semantics), and the per-transition sets nest strictly because a cell can only ever reach
     * transition N by having already legally passed through N-1. */
    summarize() {
      const counts = Object.fromEntries(TRANSITIONS.map((t) => [t, cellOrdinalsByTransition[t].size]));
      const cellOrdinals = Object.fromEntries(TRANSITIONS.map((t) => [t, [...cellOrdinalsByTransition[t]]]));
      return { plannedCellCount, counts, cellOrdinals };
    },

    /** Reads a cell's own already-persisted raw back, or `null` if it never reached
     * `raw_persisted`. Used for promotion-time read-back adoption (never derived from array
     * position -- see cli.mjs's own doc comment on why). assertOrdinal() here (post-Codex-audit
     * fix, PR #418) is not merely defensive: without it, a non-integer/out-of-range cellOrdinal
     * (e.g. a path-shaped string like '../events/leak') interpolates straight into the join()
     * below and can escape raw/ entirely, reading an arbitrary file elsewhere under journalDir --
     * confirmed by direct reproduction (a crafted cellOrdinal read back a sibling events/*.json
     * file as though it were a raw transcript). persistSpawnOutcome/recordParsed/recordEvaluated
     * already reject the same shapes via this exact check; readRawFor was the one journal method
     * that didn't. */
    readRawFor(cellOrdinal) {
      assertOrdinal(cellOrdinal);
      const rawPath = join(rawDir, `${cellOrdinal}.jsonl`);
      if (!existsSync(rawPath)) return null;
      return readFileSync(rawPath, 'utf8');
    },

    /** Deletes the whole journal directory -- called by the command ONLY after the real evidence
     * this journal was a safety net for is durably promoted elsewhere (see cli.mjs). By the time
     * this runs, the real evidence is already safe, so a lingering-lock cleanup failure is disk
     * hygiene, never a lost-evidence condition -- but (post-Codex-audit fix, PR #418) it must
     * still be an honestly reported fact, not a silently swallowed one: an earlier version of this
     * method caught and discarded its own failure entirely, contradicting this module's own PR
     * body claim that a discard failure surfaces as a `reportCleanupFailures`-style warning --
     * there was no return value at all for a caller to report. Never throws. Returns {ok:true} on
     * success, or {ok:false, warning:'journal_discard_failed'} on failure -- a fixed, pre-approved
     * closed code, deliberately never the underlying error's own message (which can carry the
     * real, absolute journalDir path). */
    promoteAndDiscard() {
      try {
        removeDirRobust(journalDir);
        return { ok: true };
      } catch {
        return { ok: false, warning: 'journal_discard_failed' };
      }
    },
  };
}

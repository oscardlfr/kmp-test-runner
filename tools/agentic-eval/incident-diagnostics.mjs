#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/incident-diagnostics.mjs -- finalizeIncident(), the ONE shared finalizer for
// every non-gate incident this harness's run/calibrate/smoke commands can hit: a thrown exception
// from any phase (acquiring shared resources, materializing/resetting a cell, persisting a cell's
// journal outcome, parsing/attributing a cell, or grading/building records/finalizing the whole
// matrix), AND a non-throwing {ok:false} from finalizeAndWriteMatrixRecords/finalizeAndWriteRecords
// that ISN'T the already-well-handled hard-gate rejection (sidecar/schema/privacy/promotion-
// collision failures -- verified directly: every one of those returns {ok:false, reason}, never
// throws, but none of them produced a structured diagnostic or real counters before this module).
//
// Replaces cli.mjs's old, unconditional "... threw before any cell completed: ${err.stack ||
// err.message}" lines -- both the false claim (it never checked how many cells actually ran) and
// the raw stack trace (which can and does carry absolute paths) printed straight to stderr.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { RUNS_ROOT, isRawDirSafeFromAccidentalCommit, promoteTargetsAtomically } from './evidence-io.mjs';
import { redactAndVerify, assertCleanOrThrowObject } from './privacy.mjs';

// One pre-approved, closed fallback code per phase -- used ONLY when the real reason text can't be
// verified clean by the redaction pipeline. Never the raw text in that case, committed or local.
const CLOSED_FALLBACK_REASON_CODES = Object.freeze({
  acquiring_shared_resources: 'shared_resource_acquisition_failed',
  materializing_cell: 'materialization_or_reset_failed',
  persisting_cell_journal: 'journal_persist_failed',
  parsing_or_attributing_cell: 'parsing_or_attribution_failed',
  finalizing_matrix: 'promotion_pipeline_rejected',
});

function closedFallbackFor(phase) {
  return CLOSED_FALLBACK_REASON_CODES[phase] ?? 'incident_reason_unavailable';
}

// Node's own fs/child_process error messages routinely embed a real absolute path (e.g.
// `ENOENT: no such file or directory, mkdtemp '/tmp/aeci-isolated-tmp-XXXXXX/...'` on POSIX,
// `EBUSY: resource busy or locked, rmdir 'C:\Users\...'` on Windows) -- confirmed directly (a real
// local-ci Linux-lane run): this repo's own PII-redaction pipeline (privacy.mjs/tools/lib/redact.mjs)
// only recognizes Windows-user-home-shaped paths (`user_path_win`), not a generic absolute path on
// either platform. The task here is narrower and stricter than PII redaction: "never an absolute
// path in stderr or the committed tier," full stop, regardless of whether that path happens to be
// PII-shaped. Quoting-convention-based detection (only single-quoted POSIX paths, matching Node's
// own fs/child_process error style) was tried first and found insufficient: this module's OWN
// thrown error messages (e.g. durable-journal.mjs's createInvocationJournal, which interpolates
// `${journalDir}` directly into "... is not confirmed covered by .gitignore ...") embed an
// unquoted absolute path -- confirmed directly (a real local-ci Linux-lane run). So this instead
// requires the STRUCTURAL shape of a real path -- a leading `/` followed by at least two
// `word-chars-then-/`-separated segments (`/a/b`, not bare `/a`) -- which a JSON-shaped
// gate-rejection reason like `{"field":"a/b"}` cannot produce (no LEADING slash there), or a
// Windows drive-letter shape anywhere. Deliberately over-inclusive in one respect (a URL like
// `https://github.com/x/y` also matches this shape) -- over-redacting to a closed fallback code is
// the safe failure direction here, never under-redacting.
const ABSOLUTE_PATH_RE = /[A-Za-z]:[\\/]|\/(?:[\w.-]+\/)+[\w.-]+/;

function safeReasonText(reasonText, phase, { privatePatternsFile, redactReasonFn = redactAndVerify }) {
  const text = typeof reasonText === 'string' ? reasonText : String(reasonText ?? '');
  const { ok, redacted } = redactReasonFn(text, { privatePatternsFile });
  if (!ok) return closedFallbackFor(phase);
  if (ABSOLUTE_PATH_RE.test(redacted)) return closedFallbackFor(phase);
  return redacted;
}

function buildMessage(runKind, phase, summary, safeReason) {
  const c = summary.counts;
  return `${String(runKind).toUpperCase()} FAILED (${phase}): ${c.evaluated}/${summary.plannedCellCount} cells evaluated `
    + `(${c.spawn_started} spawned, ${c.raw_persisted} raw-persisted, ${c.spawn_failed} spawn-failed) -- ${safeReason}. `
    + `See the local journal/incident diagnostic for detail.`;
}

/**
 * The shared incident finalizer. Never throws -- an incident-reporting failure must never mask the
 * original incident by crashing the caller a second time.
 * @param {object} opts
 * @param {string} opts.runKind
 * @param {{summarize: () => object}|null} [opts.journal] - null when the journal itself never got
 *   created (its own creation call can throw -- isRawDirSafeFromAccidentalCommit fails closed
 *   against a real, non-isolated RUNS_ROOT -- and that catch has no journal to reference). Treated
 *   as an all-zero-counts summary, never dereferenced -- this function must never throw itself.
 * @param {string} opts.phase - one of durable-journal.mjs's AGENTIC_EVAL_INCIDENT_PHASES
 * @param {string} opts.reasonText - a caught error's message/stack, or finalizeAndWrite*'s
 *   result.reason -- NEVER assumed already safe (see safeReasonText).
 * @param {number|null} [opts.cellOrdinal] - present only when a raw payload might need the
 *   emergency fallback (phase === 'persisting_cell_journal').
 * @param {string|null} [opts.rawStdout] - present only for the same case.
 * @param {object} [opts.provenance] - already-safe identity fields (repo_commit, scenario_id,
 *   project_alias, project_commit, seed, model, planned-cell descriptors, toolchain version).
 * @param {string} [opts.privatePatternsFile]
 * @param {string} [opts.runsRootOverride]
 * @param {Function} [opts.redactReasonFn] - injectable, defaults to privacy.mjs's redactAndVerify.
 * @returns {{message: string, incidentId: string, committedRelativePath: string}}
 */
export function finalizeIncident({
  runKind, journal = null, phase, reasonText, cellOrdinal = null, rawStdout = null, provenance = {},
  privatePatternsFile, runsRootOverride = RUNS_ROOT, redactReasonFn,
}) {
  const incidentId = randomUUID();
  const ZERO_COUNTS = { planned: 0, spawn_started: 0, spawn_completed: 0, raw_persisted: 0, parsed: 0, evaluated: 0, spawn_failed: 0 };
  const summary = journal ? journal.summarize() : { plannedCellCount: 0, counts: ZERO_COUNTS, cellOrdinals: {} };
  const safeReason = safeReasonText(reasonText, phase, { privatePatternsFile, redactReasonFn });
  const message = buildMessage(runKind, phase, summary, safeReason);

  // Emergency raw fallback -- its own independent, best-effort local transaction. Only attempted
  // for phase:'persisting_cell_journal' (the only phase that ever attaches a raw payload in the
  // first place) AND only when the journal doesn't already durably own this cell's raw -- avoids a
  // redundant second atomic write when the journal-write failure that triggered this incident was
  // itself a LATER step (recordParsed/recordEvaluated) than raw_persisted, which already succeeded
  // moments earlier in the same call. Honestly accounted: a failure here is a real, reportable
  // possibility (the same underlying disk/filesystem condition that broke the primary journal
  // write can break this too), never assumed to succeed.
  const alreadyJournaled = journal && Number.isInteger(cellOrdinal)
    && (summary.cellOrdinals.raw_persisted ?? []).includes(cellOrdinal);
  let emergencyRawPersisted = false;
  let emergencyRawWriteError = null;
  if (phase === 'persisting_cell_journal' && rawStdout != null && !alreadyJournaled) {
    try {
      if (!Number.isInteger(cellOrdinal) || cellOrdinal < 0) {
        throw new Error(`invalid cellOrdinal for emergency raw fallback: ${JSON.stringify(cellOrdinal)}`);
      }
      const transcriptsDir = join(runsRootOverride, 'agentic-eval-incident', 'raw', 'transcripts', incidentId);
      if (!isRawDirSafeFromAccidentalCommit(transcriptsDir, runsRootOverride)) {
        throw new Error('emergency raw fallback directory not confirmed covered by .gitignore');
      }
      const rawPath = join(transcriptsDir, `${cellOrdinal}.jsonl`);
      promoteTargetsAtomically([[rawPath, rawStdout]], transcriptsDir);
      emergencyRawPersisted = true;
    } catch (err) {
      emergencyRawPersisted = false;
      emergencyRawWriteError = safeReasonText(err.message, phase, { privatePatternsFile, redactReasonFn });
    }
  }

  const diagnostic = {
    schema: 1,
    incident_id: incidentId,
    run_kind: runKind,
    phase,
    reason: safeReason,
    counts: summary.counts,
    planned_cell_count: summary.plannedCellCount,
    emergency_raw_persisted: emergencyRawPersisted,
    emergency_raw_write_error: emergencyRawWriteError,
    provenance,
    created_at: new Date().toISOString(),
  };

  // Final validate->redact->revalidate pass, same as every other committed artifact in this
  // harness. Should be unreachable in practice (every free-text field was already redact-or-
  // closed-coded before assembly) -- if it somehow still fails, fall back to a minimal,
  // hardcoded-safe diagnostic rather than let a privacy-check failure here mask the ORIGINAL
  // incident by throwing out of finalizeIncident entirely.
  let redactedText;
  try {
    ({ redactedText } = assertCleanOrThrowObject(diagnostic, { privatePatternsFile }));
  } catch {
    redactedText = JSON.stringify({
      ...diagnostic,
      reason: closedFallbackFor(phase),
      emergency_raw_write_error: emergencyRawWriteError ? closedFallbackFor(phase) : null,
      provenance: {},
    }, null, 2);
  }

  const committedDir = join(runsRootOverride, 'agentic-eval-incident');
  const committedPath = join(committedDir, `${incidentId}.json`);
  const localDir = join(committedDir, 'raw');
  const localPath = join(localDir, `${incidentId}.json`);
  promoteTargetsAtomically([[committedPath, redactedText], [localPath, redactedText]], [committedDir, localDir]);

  return {
    message,
    incidentId,
    committedRelativePath: join('agentic-eval-incident', `${incidentId}.json`),
  };
}

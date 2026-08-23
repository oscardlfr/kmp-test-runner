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
//
// Post-Codex-audit hardening (PR #418): finalizeIncident's own doc comment always claimed "never
// throws", but the pre-audit implementation left THREE gaps unguarded -- journal.summarize()
// (line ~40 below), the redaction call inside safeReasonText, and the final diagnostic write --
// each capable of propagating an exception straight out of the ONE function whose entire purpose
// is to be the last line of defense against exactly that. Every step that can fail is now wrapped
// with its own fallback; finalizeIncident is total by construction, not by convention. A closed
// schema validator (isValidIncidentDiagnostic) also runs before AND after redaction, so a bogus
// run_kind/phase/counter -- whether from a caller bug or a corrupted journal summary -- can never
// reach disk; a guaranteed-valid minimal diagnostic is written instead.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { RUNS_ROOT, isRawDirSafeFromAccidentalCommit, promoteTargetsAtomically } from './evidence-io.mjs';
import { redactAndVerify, assertCleanOrThrowObject } from './privacy.mjs';
import { AGENTIC_EVAL_INCIDENT_PHASES } from './durable-journal.mjs';
import { validateCorrelationObservability } from './correlation-observability.mjs';

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

const TRANSITIONS = Object.freeze(['planned', 'spawn_started', 'spawn_completed', 'raw_persisted', 'parsed', 'evaluated', 'spawn_failed']);
const ZERO_COUNTS = Object.freeze({ planned: 0, spawn_started: 0, spawn_completed: 0, raw_persisted: 0, parsed: 0, evaluated: 0, spawn_failed: 0 });
const SUMMARY_FALLBACK = Object.freeze({ plannedCellCount: 0, counts: ZERO_COUNTS, cellOrdinals: {} });

/** Validates the FULL shape durable-journal.mjs's own summarize() documents -- not merely "is an
 * object", but every field's own type/range, cardinality-matches-count, and the same nested-set
 * coherence invariants the journal itself enforces by construction (evaluated subset-of parsed
 * subset-of raw_persisted subset-of spawn_completed subset-of spawn_started; spawn_started and
 * spawn_failed disjoint; both subsets of planned; planned has exactly plannedCellCount entries).
 * `journal` is an injectable dependency (its own JSDoc contract is just `{summarize: () =>
 * object}|null`) -- a caught THROW from summarize() was already handled before this existed, but
 * a non-throwing null/{}/counts:null/missing-cellOrdinals/incoherent return reached buildMessage()
 * or the emergencyRaw alreadyJournaled check completely unvalidated and crashed there (confirmed
 * by direct reproduction, independently also flagged by CodeRabbit). */
function isValidJournalSummary(s) {
  if (s == null || typeof s !== 'object' || Array.isArray(s)) return false;
  if (!Number.isInteger(s.plannedCellCount) || s.plannedCellCount < 0) return false;
  if (s.counts == null || typeof s.counts !== 'object' || Array.isArray(s.counts)) return false;
  if (s.cellOrdinals == null || typeof s.cellOrdinals !== 'object' || Array.isArray(s.cellOrdinals)) return false;
  for (const t of TRANSITIONS) {
    if (!Number.isInteger(s.counts[t]) || s.counts[t] < 0) return false;
    const ords = s.cellOrdinals[t];
    if (!Array.isArray(ords) || ords.length !== s.counts[t]) return false;
    const seen = new Set();
    for (const o of ords) {
      if (!Number.isInteger(o) || o < 0 || o >= s.plannedCellCount) return false;
      if (seen.has(o)) return false; // duplicate within one transition
      seen.add(o);
    }
  }
  if (s.cellOrdinals.planned.length !== s.plannedCellCount) return false;
  const NEST_CHAIN = ['evaluated', 'parsed', 'raw_persisted', 'spawn_completed', 'spawn_started'];
  for (let i = 0; i < NEST_CHAIN.length - 1; i++) {
    const inner = s.cellOrdinals[NEST_CHAIN[i]];
    const outer = new Set(s.cellOrdinals[NEST_CHAIN[i + 1]]);
    if (inner.some((o) => !outer.has(o))) return false;
  }
  const started = new Set(s.cellOrdinals.spawn_started);
  const failed = s.cellOrdinals.spawn_failed;
  if (failed.some((o) => started.has(o))) return false; // spawn_started/spawn_failed must be disjoint
  const planned = new Set(s.cellOrdinals.planned);
  if (s.cellOrdinals.spawn_started.some((o) => !planned.has(o))) return false;
  if (failed.some((o) => !planned.has(o))) return false;
  if (s.correlationSummaries !== undefined) {
    if (s.correlationSummaries == null || typeof s.correlationSummaries !== 'object'
      || Array.isArray(s.correlationSummaries)) return false;
    const evaluated = new Set(s.cellOrdinals.evaluated);
    for (const [key, value] of Object.entries(s.correlationSummaries)) {
      const ordinal = Number(key);
      if (!Number.isInteger(ordinal) || ordinal < 0 || String(ordinal) !== key
        || !evaluated.has(ordinal) || !validateCorrelationObservability(value).ok) return false;
    }
  }
  return true;
}

/** journal.summarize() is ordinary synchronous code operating on the journal's own in-memory
 * state and should never throw, or return anything but a coherent summary, in practice -- but
 * `journal` is an injectable dependency, and this function's whole purpose is to be the last line
 * of defense. A throwing summarize() (whether from a real bug or a test double) OR a non-throwing
 * but malformed/incoherent return (null, {}, a null counts field, a missing cellOrdinals field, or
 * an internally-inconsistent state) both degrade to the same all-zero summary already used when
 * journal itself is null -- never dereferenced unsafely downstream. */
function safeSummarize(journal) {
  if (!journal) return SUMMARY_FALLBACK;
  let result;
  try {
    result = journal.summarize();
  } catch {
    return SUMMARY_FALLBACK;
  }
  return isValidJournalSummary(result) ? result : SUMMARY_FALLBACK;
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
// requires the STRUCTURAL shape of a real path: a leading `/` followed by at least two
// `word-chars-then-/`-separated segments (`/a/b`, not bare `/a`) -- which a JSON-shaped
// gate-rejection reason like `{"field":"a/b"}` cannot produce (no LEADING slash there); a Windows
// drive-letter shape anywhere; OR a Windows UNC path (`\\server\share\...`) -- confirmed missing
// from an earlier version of this regex by an independent adversarial review (both the drive-letter
// branch, which requires a `:`, and the POSIX branch, which requires a leading `/`, structurally
// cannot match a UNC path's leading `\\`). Deliberately over-inclusive in one respect (a URL like
// `https://github.com/x/y` also matches the POSIX-path shape) -- over-redacting to a closed
// fallback code is the safe failure direction here, never under-redacting.
const ABSOLUTE_PATH_RE = /[A-Za-z]:[\\/]|\\\\[\w.-]+\\[\w.-]+|\/(?:[\w.-]+\/)+[\w.-]+/;

function safeReasonText(reasonText, phase, { privatePatternsFile, redactReasonFn = redactAndVerify }) {
  const text = typeof reasonText === 'string' ? reasonText : String(reasonText ?? '');
  try {
    const { ok, redacted } = redactReasonFn(text, { privatePatternsFile });
    if (!ok) return closedFallbackFor(phase);
    if (ABSOLUTE_PATH_RE.test(redacted)) return closedFallbackFor(phase);
    return redacted;
  } catch {
    // redactReasonFn threw outright (not just returned ok:false) -- still never the raw text.
    return closedFallbackFor(phase);
  }
}

// Post-Codex-audit fix (PR #418, round 3): this used to unconditionally append "See the local
// journal/incident diagnostic for detail" -- a claim the diagnostic write might not have actually
// satisfied. finalizeIncident already tracks diagnosticWritten/diagnosticWriteError precisely for
// this reason, but every one of this repo's 12 call sites only ever destructured {message} from
// its return value, so the false claim reached stderr regardless (confirmed by direct
// reproduction: no diagnostic written, message still says to go consult it). buildMessage no
// longer presupposes success at all; reportIncident() below is the ONE place that correctly,
// conditionally reports the diagnostic's real fate.
function buildMessage(runKind, phase, summary, safeReason) {
  const c = summary.counts;
  return `${String(runKind).toUpperCase()} FAILED (${phase}): ${c.evaluated}/${summary.plannedCellCount} cells evaluated `
    + `(${c.spawn_started} spawned, ${c.raw_persisted} raw-persisted, ${c.spawn_failed} spawn-failed) -- ${safeReason}.`;
}

// Closed schema for the committed/local incident diagnostic artifact itself -- independent of, and
// in addition to, the privacy/redaction pipeline (assertCleanOrThrowObject only ever checks for
// PII-shaped content, never structural correctness). A bogus run_kind, an unknown phase, a
// non-integer or negative counter, or an unexpected provenance key must never reach disk, whether
// the cause is a caller bug or a corrupted journal summary.
const VALID_RUN_KINDS = new Set(['calibration', 'smoke', 'scenario']);
const DIAGNOSTIC_SCHEMA_1_KEYS = new Set([
  'schema', 'incident_id', 'run_kind', 'phase', 'reason', 'counts', 'planned_cell_count',
  'emergency_raw_persisted', 'emergency_raw_write_error', 'provenance', 'created_at',
]);
const DIAGNOSTIC_SCHEMA_2_KEYS = new Set([...DIAGNOSTIC_SCHEMA_1_KEYS, 'failed_cell_correlation']);
const COUNTS_ALLOWED_KEYS = new Set(['planned', 'spawn_started', 'spawn_completed', 'raw_persisted', 'parsed', 'evaluated', 'spawn_failed']);
// Union of every provenance shape actually passed at any of this repo's 12 finalizeIncident call
// sites (cmdCalibrate: model_requested+scenario_id; cmdSmoke: +project_alias+project_commit;
// cmdRun: scenario_id+project_alias+project_commit+seed+model_requested) -- re-verified directly
// against cli.mjs, not assumed.
const PROVENANCE_ALLOWED_KEYS = new Set(['scenario_id', 'project_alias', 'project_commit', 'seed', 'model_requested']);

function isValidProvenance(p) {
  if (p == null || typeof p !== 'object' || Array.isArray(p)) return false;
  for (const [key, value] of Object.entries(p)) {
    if (!PROVENANCE_ALLOWED_KEYS.has(key)) return false;
    if (key === 'seed') {
      if (typeof value !== 'number') return false;
    } else if (typeof value !== 'string') {
      return false;
    }
  }
  return true;
}

/** Validates the FULL closed shape of an incident diagnostic -- called both BEFORE redaction (on
 * the just-assembled candidate) and AGAIN after redaction/fallback (on what's actually about to be
 * written), so neither an assembly bug nor a redaction-fallback bug can ever produce an invalid
 * artifact on disk. */
function isValidIncidentDiagnostic(d) {
  if (d == null || typeof d !== 'object' || Array.isArray(d)) return false;
  const keys = Object.keys(d);
  const allowedKeys = d.schema === 1 ? DIAGNOSTIC_SCHEMA_1_KEYS
    : d.schema === 2 ? DIAGNOSTIC_SCHEMA_2_KEYS : null;
  if (allowedKeys == null || keys.length !== allowedKeys.size || keys.some((k) => !allowedKeys.has(k))) return false;
  if (d.schema === 2 && !validateCorrelationObservability(d.failed_cell_correlation).ok) return false;
  if (typeof d.incident_id !== 'string' || d.incident_id.length === 0) return false;
  if (!VALID_RUN_KINDS.has(d.run_kind)) return false;
  if (!AGENTIC_EVAL_INCIDENT_PHASES.includes(d.phase)) return false;
  if (typeof d.reason !== 'string' || d.reason.length === 0) return false;
  if (d.counts == null || typeof d.counts !== 'object' || Array.isArray(d.counts)) return false;
  const countKeys = Object.keys(d.counts);
  if (countKeys.length !== COUNTS_ALLOWED_KEYS.size || countKeys.some((k) => !COUNTS_ALLOWED_KEYS.has(k))) return false;
  for (const k of COUNTS_ALLOWED_KEYS) {
    if (!Number.isInteger(d.counts[k]) || d.counts[k] < 0) return false;
  }
  // Numeric nesting-coherence -- defense in depth, independent of whether isValidJournalSummary
  // upstream already caught this on the journal side: this flat counts object has no cellOrdinals
  // to cross-check, but the counts THEMSELVES must still nest (evaluated<=parsed<=raw_persisted<=
  // spawn_completed<=spawn_started) and spawn_started+spawn_failed must never exceed planned.
  const c = d.counts;
  if (c.evaluated > c.parsed || c.parsed > c.raw_persisted || c.raw_persisted > c.spawn_completed || c.spawn_completed > c.spawn_started) return false;
  if (c.spawn_started + c.spawn_failed > c.planned) return false;
  if (!Number.isInteger(d.planned_cell_count) || d.planned_cell_count < 0) return false;
  if (typeof d.emergency_raw_persisted !== 'boolean') return false;
  if (d.emergency_raw_write_error !== null && typeof d.emergency_raw_write_error !== 'string') return false;
  if (!isValidProvenance(d.provenance)) return false;
  if (typeof d.created_at !== 'string' || Number.isNaN(Date.parse(d.created_at))) return false;
  return true;
}

/**
 * The shared incident finalizer. Never throws -- an incident-reporting failure must never mask the
 * original incident by crashing the caller a second time. This is enforced structurally: every
 * step capable of failing (journal.summarize(), redaction, the closed-schema validation, the final
 * diagnostic write) is independently guarded with its own fallback, so a failure in any one of
 * them degrades gracefully rather than escaping uncaught.
 * @param {object} opts
 * @param {string} opts.runKind
 * @param {{summarize: () => object}|null} [opts.journal] - null when the journal itself never got
 *   created (its own creation call can throw -- isRawDirSafeFromAccidentalCommit fails closed
 *   against a real, non-isolated RUNS_ROOT -- and that catch has no journal to reference). Treated
 *   as an all-zero-counts summary if null OR if its own summarize() throws -- never dereferenced
 *   unsafely, this function must never throw itself regardless of what journal does.
 * @param {string} opts.phase - one of durable-journal.mjs's AGENTIC_EVAL_INCIDENT_PHASES
 * @param {string} opts.reasonText - a caught error's message/stack, or finalizeAndWrite*'s
 *   result.reason -- NEVER assumed already safe (see safeReasonText).
 * @param {number|null} [opts.cellOrdinal] - failed-cell selector and, when a raw payload exists,
 *   emergency-fallback ordinal (phase === 'persisting_cell_journal').
 * @param {string|null} [opts.rawStdout] - present only for the same case.
 * @param {object} [opts.provenance] - already-safe identity fields (repo_commit, scenario_id,
 *   project_alias, project_commit, seed, model, planned-cell descriptors, toolchain version).
 * @param {string} [opts.privatePatternsFile]
 * @param {string} [opts.runsRootOverride]
 * @param {Function} [opts.redactReasonFn] - injectable, defaults to privacy.mjs's redactAndVerify.
 * @returns {{message: string, incidentId: string, committedRelativePath: string,
 *   diagnosticWritten: boolean, diagnosticWriteError: string|null}}
 */
export function finalizeIncident({
  runKind, journal = null, phase, reasonText, cellOrdinal = null, rawStdout = null, provenance = {},
  privatePatternsFile, runsRootOverride = RUNS_ROOT, redactReasonFn,
}) {
  const incidentId = randomUUID();
  const summary = safeSummarize(journal);
  const safeReason = safeReasonText(reasonText, phase, { privatePatternsFile, redactReasonFn });
  const message = buildMessage(runKind, phase, summary, safeReason);
  const failedCellCorrelation = Number.isInteger(cellOrdinal) && cellOrdinal >= 0
    ? summary.correlationSummaries?.[cellOrdinal] ?? null
    : null;

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
    schema: failedCellCorrelation == null ? 1 : 2,
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
    ...(failedCellCorrelation == null ? {} : { failed_cell_correlation: failedCellCorrelation }),
  };

  // A guaranteed-valid stand-in -- built fresh each time it's needed (created_at must reflect
  // "now", not the first call). Every field except two is a hardcoded-safe literal (runKind/phase
  // are individually sanitized against their own closed sets). Post-Codex-audit fix (PR #418,
  // round 3): emergency_raw_persisted/emergency_raw_write_error are NOT hardcoded to false/null --
  // by the time this runs, they already hold an ALREADY-VERIFIED, ALREADY-SAFE fact (whether the
  // emergency raw transcript genuinely landed on disk), computed independently above. An earlier
  // version of this fallback discarded that fact unconditionally: if the emergency write
  // genuinely succeeded but some OTHER field (e.g. an unexpected provenance key) triggered this
  // fallback, the committed artifact would falsely claim the raw was never preserved, even though
  // it verifiably was -- confirmed by direct reproduction. emergencyRawWriteError is already the
  // output of safeReasonText by the time it's set, so it's already redaction-safe to reuse as-is.
  const minimalFallbackDiagnostic = () => ({
    schema: 1,
    incident_id: incidentId,
    run_kind: VALID_RUN_KINDS.has(runKind) ? runKind : 'scenario',
    phase: AGENTIC_EVAL_INCIDENT_PHASES.includes(phase) ? phase : 'finalizing_matrix',
    reason: closedFallbackFor(phase),
    counts: ZERO_COUNTS,
    planned_cell_count: 0,
    emergency_raw_persisted: emergencyRawPersisted,
    emergency_raw_write_error: emergencyRawWriteError,
    provenance: {},
    created_at: new Date().toISOString(),
  });

  // Validate -> redact -> revalidate, same discipline as every other committed artifact in this
  // harness, now closed on BOTH sides of redaction: a diagnostic that isn't already structurally
  // valid is never even offered to the redaction pipeline (skip straight to the guaranteed-valid
  // fallback); redaction itself throwing falls back the same way; and the REDACTED text is parsed
  // back and re-validated, in case redaction somehow altered the shape.
  let candidate = isValidIncidentDiagnostic(diagnostic) ? diagnostic : minimalFallbackDiagnostic();
  let redactedText;
  try {
    ({ redactedText } = assertCleanOrThrowObject(candidate, { privatePatternsFile }));
    if (!isValidIncidentDiagnostic(JSON.parse(redactedText))) {
      redactedText = JSON.stringify(minimalFallbackDiagnostic(), null, 2);
    }
  } catch {
    redactedText = JSON.stringify(minimalFallbackDiagnostic(), null, 2);
  }

  const committedDir = join(runsRootOverride, 'agentic-eval-incident');
  const committedPath = join(committedDir, `${incidentId}.json`);
  const localDir = join(committedDir, 'raw');
  const localPath = join(localDir, `${incidentId}.json`);
  let diagnosticWritten = false;
  let diagnosticWriteError = null;
  try {
    promoteTargetsAtomically([[committedPath, redactedText], [localPath, redactedText]], [committedDir, localDir]);
    diagnosticWritten = true;
  } catch (err) {
    // The diagnostic artifact itself is best-effort -- by this point `message` (real counters,
    // already-safe reason) is already computed and about to be returned regardless. A failure to
    // write the artifact is a real, reportable fact, never something that should mask or replace
    // the original incident this function exists to report.
    diagnosticWritten = false;
    diagnosticWriteError = safeReasonText(err.message, phase, { privatePatternsFile, redactReasonFn });
  }

  return {
    message,
    incidentId,
    committedRelativePath: join('agentic-eval-incident', `${incidentId}.json`),
    diagnosticWritten,
    diagnosticWriteError,
  };
}

/**
 * The ONE place that prints a finalizeIncident() result to stderr -- centralizes all 12 call
 * sites in cli.mjs, replacing each one's own bare `console.error(message)` (post-Codex-audit fix,
 * PR #418, round 3: every call site previously extracted ONLY `{message}`, silently discarding
 * `diagnosticWritten`/`diagnosticWriteError` even though buildMessage()'s own trailing sentence
 * used to unconditionally claim a diagnostic exists to consult -- confirmed by direct
 * reproduction: a genuine diagnostic-write failure left stderr telling the operator to go look at
 * an artifact that was never written). Never claims a diagnostic exists unless
 * `diagnosticWritten` is actually true; on failure, prints the already-sanitized/closed
 * `diagnosticWriteError` instead -- never a raw path. The safe relative path
 * (`committedRelativePath`) is the only path ever printed, and only when it's real.
 *
 * Post-Codex-audit fix (PR #418, round 4): the round-3 fix's own failure message overcorrected
 * into a DIFFERENT false claim -- "no on-disk artifact exists for this incident; the
 * counters/reason above are the only record" is itself false whenever ONLY the structured
 * diagnostic write fails while the durable journal and/or the emergency raw transcript are still
 * genuinely on disk (confirmed by direct reproduction: this function has no visibility into either
 * of those -- it only ever receives `result`, which carries no journal/emergency-raw state -- so
 * it cannot honestly assert their absence either way). The failure message is now strictly scoped
 * to the one fact this function DOES know for certain: the structured diagnostic artifact itself
 * was not persisted. It makes no claim, positive or negative, about anything else.
 * @param {{message: string, committedRelativePath: string, diagnosticWritten: boolean,
 *   diagnosticWriteError: string|null}} result
 */
export function reportIncident(result) {
  console.error(result.message);
  if (result.diagnosticWritten) {
    console.error(`Incident diagnostic written: ${result.committedRelativePath}`);
  } else {
    console.error(`Incident diagnostic NOT written (${result.diagnosticWriteError}) -- the structured diagnostic artifact was not persisted.`);
  }
}

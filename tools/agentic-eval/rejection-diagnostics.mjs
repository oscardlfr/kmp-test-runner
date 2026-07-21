#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/rejection-diagnostics.mjs -- privacy-safe, transactional, per-cell-attributed
// diagnostics for a rejected (hard-gate-failed) calibrate/smoke/run invocation. Closes the
// pre-existing, named BACKLOG.md gap: "Rejected agentic-eval hard-gate runs leave no auditable
// trace" -- calibrationHardGate/smokeHardGate/scenarioHardGate failures previously wrote zero
// evidence anywhere, leaving nothing beyond a terse stderr reason string once the terminal/log is
// gone.
//
// Kept in its own module (schema + construction + writing all together), deliberately OUT of
// cli.mjs, for two reasons: (1) cli.mjs is already large and heavily trafficked -- this PR's own
// audit history shows repeated rounds of the same bug class recurring there; (2) it breaks a
// circular import -- this module needs evidence-io.mjs's atomic-write primitives, while cli.mjs
// needs to call INTO this module from its gate-failure branches.
//
// Location: tools/runs/agentic-eval-rejected/ -- deliberately NOT shaped like
// resolveEvidenceOutDir's agentic-eval-<run_kind> (RUN_KIND_VALUES never includes 'rejected'), so
// it can never be confused with real evidence by aggregate/validate. One file PER rejection (not
// a shared append-only log, unlike measurement-registry.jsonl) -- a rejection is closer in nature
// to this directory's existing per-record evidence files, and per-rejection files close a real
// concurrency/partial-write concern a shared log would reopen. Reuses the exact same
// exception-safe, collision-safe promoteTargetsAtomically primitive every other evidence write in
// this harness already uses -- see evidence-io.mjs's own doc comment for the precise (not
// overclaimed) guarantee that actually provides.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolveRejectedDiagnosticsDir, isRawDirSafeFromAccidentalCommit, promoteTargetsAtomically } from './evidence-io.mjs';
import { assertCleanOrThrowObject } from './privacy.mjs';
import { RUN_KIND_VALUES, CONDITION_VALUES } from './schemas.mjs';

export const REJECTION_DIAGNOSTICS_SCHEMA = 1;

const FOREIGN_SKILL_SUMMARY_FIELDS = ['rejected', 'confirmed', 'incomplete'];
const CELL_CANONICAL_FIELDS = ['run_id', 'condition', 'repetition_index', 'skill_source_sha', 'failed_checks', 'foreign_skill_summary'];
const REJECTION_DIAGNOSTICS_CANONICAL_FIELDS = [
  'schema', 'rejection_id', 'timestamp', 'run_kind', 'run_ids', 'model_requested', 'repo_commit',
  'cells', 'foreign_skill_summary',
];

function validateForeignSkillSummary(summary, fieldPrefix) {
  const errors = [];
  if (summary == null || typeof summary !== 'object' || Array.isArray(summary)) {
    errors.push({ field: fieldPrefix, message: 'must be an object' });
    return errors;
  }
  const allowedKeys = new Set(FOREIGN_SKILL_SUMMARY_FIELDS);
  for (const k of Object.keys(summary)) {
    if (!allowedKeys.has(k)) errors.push({ field: `${fieldPrefix}.${k}`, message: 'unrecognized field' });
  }
  for (const k of allowedKeys) {
    if (!(Number.isInteger(summary[k]) && summary[k] >= 0)) {
      errors.push({ field: `${fieldPrefix}.${k}`, message: 'must be a non-negative integer' });
    }
  }
  return errors;
}

/**
 * Validates one rejection-diagnostics record. Closed key sets at EVERY nesting level (top-level,
 * each cells[] entry, both foreign_skill_summary objects) -- round-5 audit finding: "not just
 * top-level" was the explicit ask. Also enforces: cells[].run_id values unique within one record;
 * exact set-equality between run_ids[] and cells[].run_id (never merely overlapping); non-negative
 * integer counts everywhere; the top-level foreign_skill_summary must equal the field-by-field sum
 * across cells[] -- never an independently-settable second source of truth.
 * @returns {{errors: Array<{field: string, message: string}>, warnings: Array}}
 */
export function validateRejectionRow(row) {
  const warnings = [];
  if (row == null || typeof row !== 'object' || Array.isArray(row)) {
    return { errors: [{ field: 'row', message: 'must be an object' }], warnings };
  }
  const errors = [];
  const allowedKeys = new Set(REJECTION_DIAGNOSTICS_CANONICAL_FIELDS);
  for (const k of Object.keys(row)) if (!allowedKeys.has(k)) errors.push({ field: k, message: 'unrecognized field' });
  for (const k of allowedKeys) if (!(k in row)) errors.push({ field: k, message: 'missing required field' });

  if (row.schema !== REJECTION_DIAGNOSTICS_SCHEMA) errors.push({ field: 'schema', message: `must be ${REJECTION_DIAGNOSTICS_SCHEMA}` });
  if (typeof row.rejection_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.rejection_id)) {
    errors.push({ field: 'rejection_id', message: 'must be a full (36-char) UUID string, not a truncated slice' });
  }
  if (typeof row.timestamp !== 'string' || Number.isNaN(Date.parse(row.timestamp))) {
    errors.push({ field: 'timestamp', message: 'must be a valid ISO timestamp string' });
  }
  if (!RUN_KIND_VALUES.includes(row.run_kind)) errors.push({ field: 'run_kind', message: `must be one of ${RUN_KIND_VALUES.join('|')}` });
  if (typeof row.model_requested !== 'string' || row.model_requested.length === 0) errors.push({ field: 'model_requested', message: 'must be a non-empty string' });
  if (typeof row.repo_commit !== 'string' || row.repo_commit.length === 0) errors.push({ field: 'repo_commit', message: 'must be a non-empty string' });

  const runIdsOk = Array.isArray(row.run_ids) && row.run_ids.every((id) => typeof id === 'string' && id.length > 0);
  if (!runIdsOk) errors.push({ field: 'run_ids', message: 'must be an array of non-empty strings' });
  if (runIdsOk && new Set(row.run_ids).size !== row.run_ids.length) errors.push({ field: 'run_ids', message: 'must not contain duplicates' });

  if (!Array.isArray(row.cells) || row.cells.length === 0) {
    errors.push({ field: 'cells', message: 'must be a non-empty array' });
  } else {
    const cellAllowedKeys = new Set(CELL_CANONICAL_FIELDS);
    const seenRunIds = new Set();
    for (const [i, cell] of row.cells.entries()) {
      if (cell == null || typeof cell !== 'object' || Array.isArray(cell)) {
        errors.push({ field: `cells[${i}]`, message: 'must be an object' });
        continue;
      }
      for (const k of Object.keys(cell)) if (!cellAllowedKeys.has(k)) errors.push({ field: `cells[${i}].${k}`, message: 'unrecognized field' });
      for (const k of cellAllowedKeys) if (!(k in cell)) errors.push({ field: `cells[${i}].${k}`, message: 'missing required field' });
      if (typeof cell.run_id !== 'string' || cell.run_id.length === 0) {
        errors.push({ field: `cells[${i}].run_id`, message: 'must be a non-empty string' });
      } else if (seenRunIds.has(cell.run_id)) {
        errors.push({ field: `cells[${i}].run_id`, message: `duplicate run_id "${cell.run_id}" within one diagnostic record` });
      } else {
        seenRunIds.add(cell.run_id);
      }
      if (!CONDITION_VALUES.includes(cell.condition)) errors.push({ field: `cells[${i}].condition`, message: `must be one of ${CONDITION_VALUES.join('|')}` });
      if (!(cell.repetition_index === null || (Number.isInteger(cell.repetition_index) && cell.repetition_index >= 0))) {
        errors.push({ field: `cells[${i}].repetition_index`, message: 'must be null (calibrate/smoke) or a non-negative integer (scenario)' });
      }
      if (!(cell.skill_source_sha === null || (typeof cell.skill_source_sha === 'string' && cell.skill_source_sha.length > 0))) {
        errors.push({ field: `cells[${i}].skill_source_sha`, message: 'must be null (no-skill) or a non-empty string (current-skill)' });
      }
      if (!Array.isArray(cell.failed_checks) || cell.failed_checks.some((c) => typeof c !== 'string' || c.length === 0)) {
        errors.push({ field: `cells[${i}].failed_checks`, message: 'must be an array of non-empty strings' });
      }
      errors.push(...validateForeignSkillSummary(cell.foreign_skill_summary, `cells[${i}].foreign_skill_summary`));
    }
    if (runIdsOk) {
      const runIdsSet = new Set(row.run_ids);
      const cellRunIds = row.cells.map((c) => c?.run_id).filter((x) => typeof x === 'string');
      const cellRunIdsSet = new Set(cellRunIds);
      const missingFromCells = [...runIdsSet].filter((id) => !cellRunIdsSet.has(id));
      const missingFromRunIds = [...cellRunIdsSet].filter((id) => !runIdsSet.has(id));
      if (missingFromCells.length > 0 || missingFromRunIds.length > 0) {
        errors.push({ field: 'run_ids', message: `must exactly equal the set of cells[].run_id (missing from cells: ${JSON.stringify(missingFromCells)}, missing from run_ids: ${JSON.stringify(missingFromRunIds)})` });
      }
    }
  }

  const topSummaryErrors = validateForeignSkillSummary(row.foreign_skill_summary, 'foreign_skill_summary');
  errors.push(...topSummaryErrors);
  if (topSummaryErrors.length === 0 && Array.isArray(row.cells)) {
    const summedFromCells = { rejected: 0, confirmed: 0, incomplete: 0 };
    let cellSummariesUsable = true;
    for (const cell of row.cells) {
      const s = cell?.foreign_skill_summary;
      if (s == null || !FOREIGN_SKILL_SUMMARY_FIELDS.every((k) => Number.isInteger(s[k]))) { cellSummariesUsable = false; break; }
      for (const k of FOREIGN_SKILL_SUMMARY_FIELDS) summedFromCells[k] += s[k];
    }
    if (cellSummariesUsable) {
      for (const k of FOREIGN_SKILL_SUMMARY_FIELDS) {
        if (row.foreign_skill_summary[k] !== summedFromCells[k]) {
          errors.push({ field: `foreign_skill_summary.${k}`, message: `must equal the sum across cells[] (expected ${summedFromCells[k]}, got ${row.foreign_skill_summary[k]})` });
        }
      }
    }
  }

  return { errors, warnings };
}

/**
 * Pure construction, no I/O -- assembles a rejection-diagnostics record (committed tier) plus its
 * richer local-only companion (adds real, per-cell foreign skill NAMES, never present in the
 * committed tier) from what the caller's gate-failure branch already has in scope. Never
 * re-derives anything the gate functions already computed (evaluateNamedChecks'
 * failedChecks/failedChecksA/failedChecksB, scenarioHardGate's cellResults) -- see cli.mjs's own
 * call sites for how each run_kind maps its own shape into the uniform inputs here.
 *
 * @param {string} runKind
 * @param {object[]} records - the already-built run records for this batch (2 for calibrate/
 *   smoke as [recordA, recordB]; N for a scenario matrix) -- each already carries its own
 *   run_id/condition/repetition_index/skill_source_sha/repo_commit/model_requested/
 *   foreign_skill_summary (schema v3, populated by buildRunRecord regardless of whether the
 *   batch is ultimately accepted or rejected).
 * @param {Record<string, string[]>} failedChecksByRunId - each record's own run_id -> the named
 *   checks that failed for THAT record/side specifically.
 * @param {Record<string, string[]>} [foreignSkillNamesByRunId] - each record's own run_id -> the
 *   real (never-committed) foreign skillArg names attempted, for the local-only tier. Optional --
 *   if omitted, the local tier simply carries no extra names (still privacy-safe either way).
 */
export function buildRejectionDiagnostics({ runKind, records, failedChecksByRunId, foreignSkillNamesByRunId = {} }) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('buildRejectionDiagnostics: records must be a non-empty array');
  }
  // Round-5 audit finding: never silently collapse to the first record's value without checking
  // agreement -- a real disagreement here would mean records from different harness invocations
  // got mixed together by mistake, which should be structurally impossible and must fail loudly,
  // not be handled gracefully by guessing.
  const repoCommits = new Set(records.map((r) => r.repo_commit));
  const modelsRequested = new Set(records.map((r) => r.model_requested));
  if (repoCommits.size !== 1) {
    throw new Error(`buildRejectionDiagnostics: records disagree on repo_commit (${JSON.stringify([...repoCommits])}) -- should be structurally impossible within one harness invocation`);
  }
  if (modelsRequested.size !== 1) {
    throw new Error(`buildRejectionDiagnostics: records disagree on model_requested (${JSON.stringify([...modelsRequested])}) -- should be structurally impossible within one harness invocation`);
  }

  const cells = records.map((r) => ({
    run_id: r.run_id,
    condition: r.condition,
    repetition_index: r.repetition_index,
    skill_source_sha: r.skill_source_sha,
    failed_checks: failedChecksByRunId[r.run_id] ?? [],
    foreign_skill_summary: r.foreign_skill_summary,
  }));

  const foreignSkillSummary = { rejected: 0, confirmed: 0, incomplete: 0 };
  for (const cell of cells) {
    foreignSkillSummary.rejected += cell.foreign_skill_summary.rejected;
    foreignSkillSummary.confirmed += cell.foreign_skill_summary.confirmed;
    foreignSkillSummary.incomplete += cell.foreign_skill_summary.incomplete;
  }

  const committed = {
    schema: REJECTION_DIAGNOSTICS_SCHEMA,
    rejection_id: randomUUID(),
    timestamp: new Date().toISOString(),
    run_kind: runKind,
    run_ids: cells.map((c) => c.run_id),
    model_requested: [...modelsRequested][0],
    repo_commit: [...repoCommits][0],
    cells,
    foreign_skill_summary: foreignSkillSummary,
  };

  // Local-only tier: same base shape, PLUS real (deduplicated, sorted) foreign skill names per
  // cell -- never present in `committed`. Structured detail only, deliberately never the full raw
  // transcript (BACKLOG.md's originating text: "explicitly no raw transcript").
  const local = {
    ...committed,
    cells: cells.map((c) => ({
      ...c,
      foreign_skill_names: [...new Set(foreignSkillNamesByRunId[c.run_id] ?? [])].sort(),
    })),
  };

  return { committed, local };
}

/**
 * The actual two-tier write. Committed tier: validate -> redact -> revalidate -> promote --
 * mirrors finalizeAndWriteRecords's exact ordering for real evidence (round-5 audit finding: this
 * was only implied before, now explicit), so a redaction rule that would corrupt a required
 * field's shape is caught before promotion, not after. Local tier: redacted for incidental path/
 * serial leaks (same privacy layer) but not schema-validated against the same closed shape, since
 * it deliberately carries the extra foreign_skill_names field the committed schema forbids.
 *
 * Threads runsRootOverride through exactly like every other evidence-writing function in this
 * harness (test isolation via KMP_EVAL_RUNS_ROOT).
 * @param {{committed: object, local: object}} diagnostics - buildRejectionDiagnostics's own return
 * @param {{privatePatternsFile?: string, runsRootOverride?: string}} [opts]
 * @returns {string} outDir
 */
export function writeRejectedRunDiagnostics({ committed, local }, { privatePatternsFile, runsRootOverride } = {}) {
  const { errors: originalErrors } = validateRejectionRow(committed);
  if (originalErrors.length > 0) {
    throw new Error(`refusing to write rejection diagnostics: record failed schema validation before redaction: ${JSON.stringify(originalErrors)}`);
  }

  let redactedCommittedObj, redactedCommittedText;
  try {
    ({ redactedObj: redactedCommittedObj, redactedText: redactedCommittedText } = assertCleanOrThrowObject(committed, { privatePatternsFile }));
  } catch (err) {
    throw new Error(`refusing to write rejection diagnostics: privacy check refused the committed record: ${err.message}`);
  }
  const { errors: redactedErrors } = validateRejectionRow(redactedCommittedObj);
  if (redactedErrors.length > 0) {
    throw new Error(`refusing to write rejection diagnostics: redaction corrupted the committed record's shape: ${JSON.stringify(redactedErrors)}`);
  }

  let redactedLocalText;
  try {
    ({ redactedText: redactedLocalText } = assertCleanOrThrowObject(local, { privatePatternsFile }));
  } catch (err) {
    throw new Error(`refusing to write rejection diagnostics: privacy check refused the local detail record: ${err.message}`);
  }

  const outDir = resolveRejectedDiagnosticsDir(runsRootOverride);
  const rawDir = join(outDir, 'raw');
  if (!isRawDirSafeFromAccidentalCommit(rawDir, runsRootOverride)) {
    throw new Error(`refusing to write rejection diagnostics: ${rawDir} is inside this repo's worktree but not covered by .gitignore -- would risk an accidental commit of local-only data`);
  }
  const targets = [
    [join(outDir, `${committed.rejection_id}.json`), redactedCommittedText],
    [join(rawDir, `${committed.rejection_id}.json`), redactedLocalText],
  ];
  promoteTargetsAtomically(targets, rawDir);
  return outDir;
}

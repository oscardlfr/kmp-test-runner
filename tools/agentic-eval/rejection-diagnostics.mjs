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
import { RUN_KIND_VALUES, CONDITION_VALUES, PLATFORM_VALUES, PRIVACY_STATUS_VALUES } from './schemas.mjs';

export const REJECTION_DIAGNOSTICS_SCHEMA = 1;

const FOREIGN_SKILL_SUMMARY_FIELDS = ['rejected', 'confirmed', 'incomplete'];
// claude_code_version (round-7 audit finding -- "procedencia forense incompleta"): each transcript's
// OWN reported CLI version, like model_resolved -- can legitimately differ or be null per cell
// independently (a broken capture never reached its init event), so it lives here, not among the
// batch-wide fields below.
const CELL_CANONICAL_FIELDS = [
  'run_id', 'condition', 'repetition_index', 'order_index', 'skill_source_sha', 'model_resolved',
  'claude_code_version', 'failed_checks', 'foreign_skill_summary',
];
// scenario_id/project_alias/project_commit/seed/policy_sha256/platform/privacy_status (round-6/7
// audit findings -- "diagnostic provenance"): reproducing or even just understanding WHERE/WHEN a
// rejection happened needs more than repo_commit (the HARNESS's own commit) and model_requested --
// which scenario was running, which external project/commit was measured, the seed/policy that
// produced this exact matrix, which host platform ran it, whether privacy redaction was even
// active. Mirrors buildRunRecord's own field names exactly (never re-derived, only read off the
// already-built records the caller has in scope) so there is no second, drifting vocabulary for
// the same facts.
//
// project_url is DELIBERATELY ABSENT here (round-7 audit finding -- privacy): unlike
// project_alias/project_commit, which identify a project/revision without being a directly
// clickable/shareable link, a committed project_url would put a real external repository address
// into the SAME committed tier every other field here is safe-by-construction for. Present only in
// the local, gitignored tier (see buildRejectionDiagnostics's own doc comment) -- the safer of the
// two options this round's audit offered, and the one that needs no new conditional enforcement
// logic to get right.
const REJECTION_DIAGNOSTICS_CANONICAL_FIELDS = [
  'schema', 'rejection_id', 'timestamp', 'run_kind', 'run_ids', 'model_requested', 'repo_commit',
  'scenario_id', 'project_alias', 'project_commit', 'seed', 'policy_sha256', 'platform',
  'privacy_status', 'cells', 'foreign_skill_summary',
];

/**
 * Round-7 audit finding ("la procedencia por tipo de run no está realmente cerrada"): the
 * pre-fix check accepted "null OR a non-empty string" for project_alias/project_commit and "null
 * OR an integer" for seed UNCONDITIONALLY -- a scenario row with every project_* field AND seed
 * set to null validated with zero errors, exactly as cleanly as a genuinely-nullish
 * calibration row. Each run_kind has exactly one legitimate shape, mirroring what buildRunRecord
 * itself actually produces for that run_kind (verified directly against cli.mjs, not assumed):
 *   - calibration: project_alias is the FIXED literal 'calibration-project' (buildRunRecord's own
 *     default parameter value when the caller passes nothing -- cmdCalibrate never overrides it);
 *     project_commit null (no external project); seed null (no repetition concept).
 *   - smoke: project_alias/project_commit are REAL, non-empty values (points at whatever project
 *     the operator ran smoke against); seed null (no repetition concept).
 *   - scenario: project_alias/project_commit REAL; seed a real integer (the actual --seed used).
 *   - corpus-probe: not produced by anything in this codebase yet (accepted in RUN_KIND_VALUES as
 *     a reserved future value only) -- its real shape is genuinely unknown, so this explicitly
 *     fails closed rather than silently falling through to "anything goes" the way a missing
 *     switch arm would.
 * Explicit if-chain (never a bare fallthrough) -- run_kind's own validity is checked separately by
 * the caller; an already-invalid run_kind is skipped here rather than cascading into a wall of
 * confusing "wrong shape" errors on top of the "unrecognized run_kind" error it already produced.
 * @returns {Array<{field: string, message: string}>}
 */
function validateProvenanceForRunKind(row) {
  const errors = [];
  if (!RUN_KIND_VALUES.includes(row.run_kind)) return errors;
  const realProject = (v) => typeof v === 'string' && v.length > 0;
  if (row.run_kind === 'calibration') {
    if (row.project_alias !== 'calibration-project') {
      errors.push({ field: 'project_alias', message: `must be exactly 'calibration-project' for run_kind:'calibration'` });
    }
    if (row.project_commit !== null) errors.push({ field: 'project_commit', message: `must be null for run_kind:'calibration' -- no external project is involved` });
    if (row.seed !== null) errors.push({ field: 'seed', message: `must be null for run_kind:'calibration' -- no repetition concept applies` });
  } else if (row.run_kind === 'smoke') {
    if (!realProject(row.project_alias)) errors.push({ field: 'project_alias', message: `must be a real, non-empty string for run_kind:'smoke' -- points at whatever project smoke ran against` });
    if (!realProject(row.project_commit)) errors.push({ field: 'project_commit', message: `must be a real, non-empty string for run_kind:'smoke'` });
    if (row.seed !== null) errors.push({ field: 'seed', message: `must be null for run_kind:'smoke' -- no repetition concept applies` });
  } else if (row.run_kind === 'scenario') {
    if (!realProject(row.project_alias)) errors.push({ field: 'project_alias', message: `must be a real, non-empty string for run_kind:'scenario'` });
    if (!realProject(row.project_commit)) errors.push({ field: 'project_commit', message: `must be a real, non-empty string for run_kind:'scenario'` });
    if (!Number.isInteger(row.seed)) errors.push({ field: 'seed', message: `must be an integer for run_kind:'scenario'` });
  } else {
    // run_kind:'corpus-probe' (or any future RUN_KIND_VALUES addition this function hasn't been
    // taught about yet) -- fail closed rather than silently accepting an unvalidated shape.
    errors.push({ field: 'run_kind', message: `provenance validation is not yet defined for run_kind:'${row.run_kind}'` });
  }
  return errors;
}

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
  // scenario_id is a real, non-empty value for EVERY run_kind (buildRunRecord always populates it
  // -- calibrate/smoke use a fixed descriptive id like 'calibration-explicit-invocation', never
  // null).
  if (typeof row.scenario_id !== 'string' || row.scenario_id.length === 0) errors.push({ field: 'scenario_id', message: 'must be a non-empty string' });
  if (!PLATFORM_VALUES.includes(row.platform)) errors.push({ field: 'platform', message: `must be one of ${PLATFORM_VALUES.join('|')}` });
  if (!PRIVACY_STATUS_VALUES.includes(row.privacy_status)) errors.push({ field: 'privacy_status', message: `must be one of ${PRIVACY_STATUS_VALUES.join('|')}` });
  errors.push(...validateProvenanceForRunKind(row));
  if (typeof row.policy_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.policy_sha256)) {
    errors.push({ field: 'policy_sha256', message: 'must be a lowercase 64-char hex SHA-256 string' });
  }

  const runIdsOk = Array.isArray(row.run_ids) && row.run_ids.every((id) => typeof id === 'string' && id.length > 0);
  if (!runIdsOk) errors.push({ field: 'run_ids', message: 'must be an array of non-empty strings' });
  if (runIdsOk && new Set(row.run_ids).size !== row.run_ids.length) errors.push({ field: 'run_ids', message: 'must not contain duplicates' });

  if (!Array.isArray(row.cells) || row.cells.length === 0) {
    errors.push({ field: 'cells', message: 'must be a non-empty array' });
  } else {
    const cellAllowedKeys = new Set(CELL_CANONICAL_FIELDS);
    const seenRunIds = new Set();
    // round-6 audit finding ("rechazo sin causa"): a rejection diagnostic whose cells[] ALL carry
    // failed_checks:[] represents a rejection with no recorded cause anywhere in the record -- the
    // per-cell shape check above only confirms each ARRAY is well-formed, never that the batch as
    // a whole actually explains itself. Tracked across the loop, asserted once after it.
    let anyCellHasFailedCheck = false;
    // run_kind is validated independently above (may itself be malformed) -- coherence here is
    // gated on it actually being a real, recognized value, so a bad run_kind doesn't ALSO cascade
    // into a wall of misleading repetition_index/order_index errors for every cell.
    const runKindIsScenario = row.run_kind === 'scenario';
    const runKindKnown = RUN_KIND_VALUES.includes(row.run_kind);
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
      // repetition_index/order_index tied to run_kind (round-6 audit finding: "coherencia con
      // run_kind") -- the PRE-fix shape check ("null OR a non-negative integer") let a
      // calibration/smoke row carry a real repetition_index, or a scenario row carry null, neither
      // of which can happen from a genuine buildRunRecord() output (repetition/order concepts only
      // exist for run_kind:'scenario' -- see buildRunRecord's own `isScenario ? x : null` gating).
      if (runKindKnown) {
        const wantsInteger = runKindIsScenario;
        for (const field of ['repetition_index', 'order_index']) {
          const value = cell[field];
          const ok = wantsInteger ? (Number.isInteger(value) && value >= 0) : value === null;
          if (!ok) {
            errors.push({
              field: `cells[${i}].${field}`,
              message: wantsInteger
                ? `must be a non-negative integer for run_kind:'scenario'`
                : `must be null for run_kind:'${row.run_kind}' -- repetition/order only apply to run_kind:'scenario'`,
            });
          }
        }
      }
      if (!(cell.skill_source_sha === null || (typeof cell.skill_source_sha === 'string' && cell.skill_source_sha.length > 0))) {
        errors.push({ field: `cells[${i}].skill_source_sha`, message: 'must be null (no-skill) or a non-empty string (current-skill)' });
      }
      if (!(cell.model_resolved === null || (typeof cell.model_resolved === 'string' && cell.model_resolved.length > 0))) {
        errors.push({ field: `cells[${i}].model_resolved`, message: 'must be null (no init event captured) or a non-empty string' });
      }
      if (!(cell.claude_code_version === null || (typeof cell.claude_code_version === 'string' && cell.claude_code_version.length > 0))) {
        errors.push({ field: `cells[${i}].claude_code_version`, message: 'must be null (no init event captured) or a non-empty string' });
      }
      if (!Array.isArray(cell.failed_checks) || cell.failed_checks.some((c) => typeof c !== 'string' || c.length === 0)) {
        errors.push({ field: `cells[${i}].failed_checks`, message: 'must be an array of non-empty strings' });
      } else if (cell.failed_checks.length > 0) {
        anyCellHasFailedCheck = true;
      }
      errors.push(...validateForeignSkillSummary(cell.foreign_skill_summary, `cells[${i}].foreign_skill_summary`));
    }
    if (!anyCellHasFailedCheck) {
      errors.push({ field: 'cells', message: 'at least one cell must have a non-empty failed_checks -- a rejection diagnostic with no recorded failure anywhere is not a real rejection' });
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
 *   run_id/run_kind/condition/repetition_index/order_index/skill_source_sha/model_resolved/
 *   claude_code_version/repo_commit/model_requested/scenario_id/project_alias/project_commit/
 *   project_url/seed/policy_sha256/platform/privacy_status/foreign_skill_summary (schema v3,
 *   populated by buildRunRecord regardless of whether the batch is ultimately accepted or
 *   rejected).
 * @param {Record<string, string[]>} failedChecksByRunId - each record's own run_id -> the named
 *   checks that failed for THAT record/side specifically. Round-7 audit finding ("atribución por
 *   celda todavía fail-open"): must have EXACTLY the same key set as records[].run_id -- no
 *   missing (a real cell's failure reason silently vanishing), no extra (a stale/mistyped key
 *   pointing at a run_id that isn't actually part of this batch).
 * @param {Record<string, string[]>} [foreignSkillNamesByRunId] - each record's own run_id -> the
 *   real (never-committed) foreign skillArg names attempted, for the local-only tier. Optional --
 *   if omitted, the local tier simply carries no extra names (still privacy-safe either way).
 */
export function buildRejectionDiagnostics({ runKind, records, failedChecksByRunId, foreignSkillNamesByRunId = {} }) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('buildRejectionDiagnostics: records must be a non-empty array');
  }
  // Round-7 audit finding ("atribución por celda todavía fail-open"): the caller's OWN runKind
  // parameter was never actually cross-checked against what each record itself declares --
  // records built as one run_kind (e.g. wrongly assembled from a DIFFERENT code path, or a
  // caller-side typo passing the wrong records array) could silently masquerade as another,
  // reproduced directly: calibration-shaped records passed through with runKind:'smoke' validated
  // cleanly before this check existed.
  for (const r of records) {
    if (r.run_kind !== runKind) {
      throw new Error(`buildRejectionDiagnostics: runKind ('${runKind}') does not match record ${r.run_id}'s own run_kind ('${r.run_kind}') -- records from a different run_kind must never be attributed to this batch`);
    }
  }
  // Round-7 audit finding (same section): failedChecksByRunId[missingKey] ?? [] silently treated
  // an ABSENT key exactly like a genuinely-empty (all-passed) cell -- a caller-side bug (wrong
  // run_id, a typo, an incomplete map) could make a REAL failure disappear without a trace, and
  // the "at least one cell has a real failed_checks" invariant (validateRejectionRow) could still
  // be satisfied by a DIFFERENT cell, masking the gap entirely. Exact set-equality, not "every
  // record has an entry" (which alone wouldn't catch a stale extra key left over from a refactor).
  const recordRunIds = new Set(records.map((r) => r.run_id));
  const failedChecksKeys = new Set(Object.keys(failedChecksByRunId));
  const missingFromMap = [...recordRunIds].filter((id) => !failedChecksKeys.has(id));
  const extraInMap = [...failedChecksKeys].filter((id) => !recordRunIds.has(id));
  if (missingFromMap.length > 0 || extraInMap.length > 0) {
    throw new Error(`buildRejectionDiagnostics: failedChecksByRunId's keys must exactly match records[].run_id (missing: ${JSON.stringify(missingFromMap)}, extra/stale: ${JSON.stringify(extraInMap)})`);
  }
  // Round-5 audit finding: never silently collapse to the first record's value without checking
  // agreement -- a real disagreement here would mean records from different harness invocations
  // got mixed together by mistake, which should be structurally impossible and must fail loudly,
  // not be handled gracefully by guessing. Round-6/7 audit findings ("diagnostic provenance")
  // widened this from just repo_commit/model_requested to every batch-wide identity/provenance
  // field a human would need to locate or reproduce the rejected run: which scenario, which
  // external project/commit, the seed, the policy hash, the host platform, whether privacy
  // redaction was active. project_url is checked here too (batch-wide, same as project_alias/
  // project_commit) but deliberately NOT included in the committed record -- see
  // REJECTION_DIAGNOSTICS_CANONICAL_FIELDS's own comment for the privacy rationale. All are read
  // directly off buildRunRecord's own field names (never re-derived).
  const BATCH_WIDE_FIELDS = ['repo_commit', 'model_requested', 'scenario_id', 'project_alias', 'project_commit', 'project_url', 'seed', 'policy_sha256', 'platform', 'privacy_status'];
  const batchWide = {};
  for (const field of BATCH_WIDE_FIELDS) {
    const values = new Set(records.map((r) => r[field]));
    if (values.size !== 1) {
      throw new Error(`buildRejectionDiagnostics: records disagree on ${field} (${JSON.stringify([...values])}) -- should be structurally impossible within one harness invocation`);
    }
    batchWide[field] = [...values][0];
  }
  const { project_url: projectUrl, ...committedBatchWide } = batchWide;

  const cells = records.map((r) => ({
    run_id: r.run_id,
    condition: r.condition,
    repetition_index: r.repetition_index,
    order_index: r.order_index,
    skill_source_sha: r.skill_source_sha,
    model_resolved: r.model_resolved,
    claude_code_version: r.claude_code_version,
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
    ...committedBatchWide,
    cells,
    foreign_skill_summary: foreignSkillSummary,
  };

  // Local-only tier: same base shape, PLUS project_url (batch-wide -- see
  // REJECTION_DIAGNOSTICS_CANONICAL_FIELDS's own comment for why it's absent from `committed`) and
  // real (deduplicated, sorted) foreign skill names per cell -- never present in `committed`.
  // Structured detail only, deliberately never the full raw transcript (BACKLOG.md's originating
  // text: "explicitly no raw transcript").
  const local = {
    ...committed,
    project_url: projectUrl,
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
 * @returns {{outDir: string, rejectionId: string, relativePath: string}} relativePath is relative
 *   to RUNS_ROOT (never an absolute filesystem path), safe to print directly without a further
 *   privacy check.
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
  const committedFilename = `${committed.rejection_id}.json`;
  const targets = [
    [join(outDir, committedFilename), redactedCommittedText],
    [join(rawDir, committedFilename), redactedLocalText],
  ];
  promoteTargetsAtomically(targets, rawDir);
  // relativePath is relative to RUNS_ROOT (not an absolute filesystem path) SPECIFICALLY so it is
  // safe to print without a separate privacy-redaction pass -- round-6 audit finding ("localización
  // del diagnóstico"): the CLI previously never told an operator WHERE a written diagnostic landed
  // or its own id, meaning it could be written successfully yet remain undiscoverable in practice.
  // resolveRejectedDiagnosticsDir always resolves to `<runsRoot>/agentic-eval-rejected`, so this is
  // structurally constant regardless of the (possibly test-isolated) runsRootOverride value --
  // avoided by construction rather than by trusting a redaction rule to catch every absolute-path
  // shape.
  return { outDir, rejectionId: committed.rejection_id, relativePath: join('agentic-eval-rejected', committedFilename) };
}

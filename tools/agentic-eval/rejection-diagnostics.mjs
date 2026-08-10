#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/rejection-diagnostics.mjs -- privacy-safe, transactional, per-cell-attributed
// diagnostics for a rejected (hard-gate-failed) calibrate/smoke/run invocation. Originally closed
// BACKLOG.md's "leave no auditable trace" gap with two structured-detail-only tiers; extended here
// ("preserve rejected matrix forensics") to add a THIRD tier and fail-fast support, after a real
// 2026-08 canary matrix rejected for `noUnexpectedToolsOk` left its transcript unrecoverable
// (spawnCondition's rawStdout only ever existed in memory, never written on rejection) and no
// diagnostic tier recorded which tool, at which transcript index, actually caused it.
//
// Three tiers, same `rejection_id`:
//   1. Committed/sanitized -- `<rejection_id>.json`, TRACKED in git. Closed field allowlist:
//      categorized counts, check names, per-cell `unexpected_tool_uses_count`, identity/provenance.
//      Never a raw skill/tool name, never any transcript content, never `project_url`.
//   2. Local structured detail -- `raw/<rejection_id>.json`, gitignored. Tier 1 plus `project_url`
//      and, per cell, real `foreign_skill_names` and `unexpected_tools: [{name, event_index}]` plus
//      `transcript_filename` -- still no raw content: `name` is treated as untrusted, arbitrary
//      runtime input (not a closed vocabulary), safe here only because it goes through the same
//      redaction pass as every other string field and lives only in this gitignored tier.
//   3. Local raw transcripts -- `raw/transcripts/<rejection_id>/<captureOrdinal>-<sha256(run_id)>.
//      jsonl`, gitignored, one file per EXECUTED cell, byte-for-byte the same rawStdout capture the
//      accepted path would have written. Never redacted (same contract as every other raw/ tier),
//      never committed. This is a partial, scoped reversal of a deliberate prior decision (this
//      module's own earlier revisions never persisted raw content on rejection) -- justified
//      specifically because that decision made a real incident's root cause permanently
//      unrecoverable.
//
// Tiers 2 and 3 are covered by the EXISTING `.gitignore` rule `tools/runs/agentic-eval-*/raw/**`
// (the `**` matches at arbitrary depth, confirmed empirically with `git check-ignore -v`) -- no
// new .gitignore entry was needed for either. Only tier 1 is genuinely tracked.
//
// Persistence is TWO INDEPENDENT atomic transactions, not one:
//   - Transaction 1 (writeRejectionRawTranscripts, tier 3) -- minimal failure surface: no schema
//     validation, no redaction, just a UUID-shaped rejectionId check, an exact-set/ordinal check,
//     and the same gitignore-safety proof every raw/ tier already uses.
//   - Transaction 2 (writeRejectedRunDiagnostics, tiers 1+2) -- the full validate/redact/revalidate
//     pipeline this module has always used.
// Transaction 1 runs FIRST and its outcome (`rawTranscriptsWriteError` vs none) never blocks
// Transaction 2 from being attempted, and vice versa -- coupling them into one transaction would
// let a failure in the (more complex) structured-diagnostic layer cost the (simpler, more
// important) raw evidence, reproducing the exact "secondary layer blocks primary evidence" failure
// class the 2026-08 incident itself was. Both tiers stamp the SAME `raw_transcripts_persisted`
// boolean (Transaction 1's outcome, known before Transaction 2 is even attempted) so a reader of
// the structured diagnostic never has to guess whether `transcript_filename` points at a real file.
//
// Kept in its own module (schema + construction + writing all together), deliberately OUT of
// cli.mjs, for two reasons: (1) cli.mjs is already large and heavily trafficked; (2) it breaks a
// circular import -- this module needs evidence-io.mjs's atomic-write primitives, while cli.mjs
// needs to call INTO this module from its gate-failure branches.
//
// Location: tools/runs/agentic-eval-rejected/ -- deliberately NOT shaped like
// resolveEvidenceOutDir's agentic-eval-<run_kind> (RUN_KIND_VALUES never includes 'rejected'), so
// it can never be confused with real evidence by aggregate/validate.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolveRejectedDiagnosticsDir, isRawDirSafeFromAccidentalCommit, promoteTargetsAtomically } from './evidence-io.mjs';
import { assertCleanOrThrowObject } from './privacy.mjs';
import { RUN_KIND_VALUES, CONDITION_VALUES, PLATFORM_VALUES, PRIVACY_STATUS_VALUES } from './schemas.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Schema-version dispatch (mirrors schemas.mjs's SUPPORTED_RUN_SCHEMAS/LATEST_RUN_SCHEMA/
// runCanonicalFieldsFor pattern) -- adopted here specifically because v2 -> v3 is NOT a routine
// same-precedent bump: two real diagnostic files from a live 2026-08 canary rejection (preserved
// as this PR's own motivating incident evidence, outside this repo, hashed and declared not to be
// deleted) are schema:2 and must keep validating. CELL_CANONICAL_FIELDS_V2/
// REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V2 are therefore frozen forever, exactly like
// RUN_CANONICAL_FIELDS_V1 is frozen for the 8 historical schema:1 run records in schemas.mjs. The
// builder (buildRejectionDiagnostics) only ever constructs schema 3 going forward -- it does not
// need to know how to build v2, only that the validator keeps recognizing it if presented with one
// (a test, a future audit tool). Re-check this premise before any FUTURE bump: the moment a real
// schema:3 file is ever committed to this repo's own git history, the NEXT bump must follow this
// same dispatch pattern rather than reverting to a plain constant bump.
export const SUPPORTED_REJECTION_DIAGNOSTICS_SCHEMAS = [2, 3];
export const LATEST_REJECTION_DIAGNOSTICS_SCHEMA = 3;

const FOREIGN_SKILL_SUMMARY_FIELDS = ['rejected', 'confirmed', 'incomplete'];
const AMBIENT_SKILL_PROFILE_FIELDS = ['count', 'scope_id', 'fingerprint_hmac'];
// {name, event_index} only -- see validateUnexpectedTools's own doc comment for why nothing else
// (id, receiptNs, input, arguments, content) may ever appear here.
const UNEXPECTED_TOOL_FIELDS = ['name', 'event_index'];

// Schema 2's per-cell fields -- frozen, matches every schema:2 row's real shape exactly (including
// the two preserved incident files). Never edit this list.
//
// claude_code_version: each transcript's OWN reported CLI version, like model_resolved -- can
// legitimately differ or be null per cell independently, so it lives here, not among the
// batch-wide fields below.
//
// ambient_skill_profile: each cell's OWN {count, scope_id, fingerprint_hmac} -- read directly off
// that cell's already-built run record, never recomputed here. Privacy-safe by construction (count
// + opaque scope id + keyed HMAC digest only) -- the raw skill names stay local-tier-only, exactly
// like foreign_skill_names already does.
const CELL_CANONICAL_FIELDS_V2 = [
  'run_id', 'condition', 'repetition_index', 'order_index', 'skill_source_sha', 'model_resolved',
  'claude_code_version', 'failed_checks', 'foreign_skill_summary', 'ambient_skill_profile',
];
// Schema 3 = v2 + unexpected_tool_uses_count (per cell): the count comes from the shared
// cell-integrity evaluation (cell-integrity.mjs's cellTranscriptIntegrityOk/
// summarizeUnexpectedToolUses) that the calling hard gate already computed -- never reparsed or
// recomputed by this module.
const CELL_CANONICAL_FIELDS_V3 = [...CELL_CANONICAL_FIELDS_V2, 'unexpected_tool_uses_count'];

// Explicit if-chain, never a ternary/fallthrough -- mirrors schemas.mjs's runCanonicalFieldsFor
// rationale: a naive fallthrough would silently validate an unrecognized future schema against the
// WRONG (older) field list.
function cellCanonicalFieldsFor(schema) {
  if (schema === 3) return CELL_CANONICAL_FIELDS_V3;
  return CELL_CANONICAL_FIELDS_V2;
}

// scenario_id/project_alias/project_commit/seed/policy_sha256/platform/privacy_status: mirrors
// buildRunRecord's own field names exactly (never re-derived, only read off the already-built
// records the caller has in scope) so there is no second, drifting vocabulary for the same facts.
//
// project_url is DELIBERATELY ABSENT here: unlike project_alias/project_commit, a committed
// project_url would put a real external repository address into the committed tier. Present only
// in the local tier.
//
// ambient_profile_matrix_ok: the matrix-wide ambient-profile consensus scenarioHardGate computes
// ONCE per scenario batch -- null for calibration/smoke (no matrix/consensus concept applies to a
// plain A/B pair) or for an incomplete (fail-fast-stopped) scenario matrix, a real boolean for a
// COMPLETE scenario batch.
const REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V2 = [
  'schema', 'rejection_id', 'timestamp', 'run_kind', 'run_ids', 'model_requested', 'repo_commit',
  'scenario_id', 'project_alias', 'project_commit', 'seed', 'policy_sha256', 'platform',
  'privacy_status', 'cells', 'foreign_skill_summary', 'ambient_profile_matrix_ok',
];
// Schema 3 = v2 + matrix_complete/planned_cell_count/executed_cell_count (fail-fast partial-matrix
// support -- a full-matrix rejection has matrix_complete:true, planned===executed===N; a fail-fast
// rejection that aborted early has matrix_complete:false, planned:N, executed:M<N, and only the M
// executed cells appear in cells[]/run_ids[]) + raw_transcripts_persisted (whether Transaction 1,
// above, succeeded for this whole batch -- a single boolean correctly represents the entire batch
// precisely because that transaction is itself all-or-nothing).
const REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V3 = [
  ...REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V2,
  'matrix_complete', 'planned_cell_count', 'executed_cell_count', 'raw_transcripts_persisted',
];

function rejectionCanonicalFieldsFor(schema) {
  if (schema === 3) return REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V3;
  return REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V2;
}

/**
 * The SINGLE implementation, anywhere in this module, of "what filename does one executed cell's
 * raw transcript get". Used by BOTH writeRejectionRawTranscripts (to actually write the file) and
 * buildRejectionDiagnostics (to populate the local tier's per-cell `transcript_filename` field) --
 * neither caller independently re-derives it, so the two can never disagree about where a
 * transcript actually lives.
 *
 * Deliberately NEVER `run_id` (or `rejection_id`) used directly as, or folded into, a filename: a
 * charset-denylist regex on the untrusted `run_id` string (an earlier design of this fix) still
 * admitted Windows-reserved device names (CON, NUL, COM1, ...) and segments ending in a dot.
 * `captureOrdinal` is a plain, already-validated non-negative integer and `sha256hex(run_id)` is
 * always exactly 64 lowercase hex characters -- both are safe by construction (can never be a
 * reserved name, never contain a path separator, never end in a dot or space), eliminating the
 * entire class of filename-injection risk instead of enumerating cases against it.
 * `captureOrdinal` is the cell's EXECUTION position (0..N-1 among executed cells, assigned by the
 * caller) -- never the schema's own `order_index` field, which is `null` for calibration/smoke and
 * so cannot serve this purpose for two of the three run kinds this fix must cover.
 */
export function deriveTranscriptFilename(captureOrdinal, runId) {
  if (!(Number.isInteger(captureOrdinal) && captureOrdinal >= 0)) {
    throw new Error(`deriveTranscriptFilename: captureOrdinal must be a non-negative integer, got ${JSON.stringify(captureOrdinal)}`);
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('deriveTranscriptFilename: runId must be a non-empty string');
  }
  const hash = createHash('sha256').update(runId, 'utf8').digest('hex');
  return `${captureOrdinal}-${hash}.jsonl`;
}

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

/** Mirrors validateForeignSkillSummary's exact shape/closed-key-set discipline, one field over --
 * {count, scope_id, fingerprint_hmac}, never the raw skill names (see this module's own header
 * comment). scope_id: a full UUID string (matches rejection_id's own regex, below). fingerprint_hmac:
 * a lowercase 64-hex-char HMAC-SHA256 digest (matches schemas.mjs's identical run-record check). */
function validateAmbientSkillProfile(profile, fieldPrefix) {
  const errors = [];
  if (profile == null || typeof profile !== 'object' || Array.isArray(profile)) {
    errors.push({ field: fieldPrefix, message: 'must be an object' });
    return errors;
  }
  const allowedKeys = new Set(AMBIENT_SKILL_PROFILE_FIELDS);
  for (const k of Object.keys(profile)) {
    if (!allowedKeys.has(k)) errors.push({ field: `${fieldPrefix}.${k}`, message: 'unrecognized field' });
  }
  if (!(Number.isInteger(profile.count) && profile.count >= 0)) {
    errors.push({ field: `${fieldPrefix}.count`, message: 'must be a non-negative integer' });
  }
  if (typeof profile.scope_id !== 'string' || !UUID_RE.test(profile.scope_id)) {
    errors.push({ field: `${fieldPrefix}.scope_id`, message: 'must be a full (36-char) UUID string' });
  }
  if (typeof profile.fingerprint_hmac !== 'string' || !/^[0-9a-f]{64}$/.test(profile.fingerprint_hmac)) {
    errors.push({ field: `${fieldPrefix}.fingerprint_hmac`, message: 'must be a lowercase 64-char hex HMAC-SHA256 string' });
  }
  return errors;
}

/**
 * Local-tier-only shape check for `unexpected_tools` -- mirrors validateForeignSkillSummary's
 * exact closed-key-set discipline one field over: array of {name, event_index}, nothing else.
 * `name` is treated as untrusted, arbitrary runtime-supplied input (whatever tool name the model
 * happened to invoke outside the allowlist -- NOT a closed vocabulary), so this only checks it is
 * a non-empty string; the actual privacy protection is (a) this field existing only in the
 * gitignored local tier, never committed, and (b) the same redaction pass every other string field
 * in this record goes through (assertCleanOrThrowObject) before anything is written. NEVER accepts
 * `id`, `receiptNs`, `input`, or anything else findUnexpectedToolUses (stream-parser.mjs) happens
 * to carry alongside name/index.
 */
function validateUnexpectedTools(list, fieldPrefix) {
  const errors = [];
  if (!Array.isArray(list)) {
    errors.push({ field: fieldPrefix, message: 'must be an array' });
    return errors;
  }
  const allowedKeys = new Set(UNEXPECTED_TOOL_FIELDS);
  for (const [i, entry] of list.entries()) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({ field: `${fieldPrefix}[${i}]`, message: 'must be an object' });
      continue;
    }
    for (const k of Object.keys(entry)) {
      if (!allowedKeys.has(k)) errors.push({ field: `${fieldPrefix}[${i}].${k}`, message: 'unrecognized field -- only {name, event_index}; never id, receiptNs, inputs, arguments, or any content' });
    }
    for (const k of allowedKeys) if (!(k in entry)) errors.push({ field: `${fieldPrefix}[${i}].${k}`, message: 'missing required field' });
    if (typeof entry.name !== 'string' || entry.name.length === 0) errors.push({ field: `${fieldPrefix}[${i}].name`, message: 'must be a non-empty string' });
    if (!(Number.isInteger(entry.event_index) && entry.event_index >= 0)) errors.push({ field: `${fieldPrefix}[${i}].event_index`, message: 'must be a non-negative integer' });
  }
  return errors;
}

/**
 * The local tier's OWN (deliberately narrow) validator. The local tier is intentionally a
 * SUPERSET of the committed closed schema and is therefore never run through validateRejectionRow
 * -- but its local-only structured fields still deserve a real shape check rather than none.
 * Scoped to `unexpected_tools` (closed per-entry shape) and `transcript_filename` (must look like
 * what deriveTranscriptFilename actually produces) -- `foreign_skill_names`'s own pre-existing
 * shape is left exactly as it was, unchanged.
 * @returns {{errors: Array<{field: string, message: string}>, warnings: Array}}
 */
export function validateRejectionLocalRow(local) {
  const warnings = [];
  if (local == null || typeof local !== 'object' || Array.isArray(local)) {
    return { errors: [{ field: 'local', message: 'must be an object' }], warnings };
  }
  const errors = [];
  if (!Array.isArray(local.cells)) {
    errors.push({ field: 'cells', message: 'must be an array' });
    return { errors, warnings };
  }
  const filenameRe = /^\d+-[0-9a-f]{64}\.jsonl$/;
  for (const [i, cell] of local.cells.entries()) {
    if (cell == null || typeof cell !== 'object' || Array.isArray(cell)) {
      errors.push({ field: `cells[${i}]`, message: 'must be an object' });
      continue;
    }
    errors.push(...validateUnexpectedTools(cell.unexpected_tools, `cells[${i}].unexpected_tools`));
    if (typeof cell.transcript_filename !== 'string' || !filenameRe.test(cell.transcript_filename)) {
      errors.push({ field: `cells[${i}].transcript_filename`, message: 'must match the pattern <captureOrdinal>-<64 hex chars>.jsonl' });
    }
  }
  return { errors, warnings };
}

/**
 * Cross-tier construction-time invariants -- deliberately NOT schema rules: the local tier is
 * never schema-validated against the closed committed shape, so these relationships have no other
 * place to live.
 *  1. committed.cells and local.cells describe the SAME cells, in the SAME order (matching run_id
 *     at every index).
 *  2. Per cell: `local.cells[i].unexpected_tools.length === committed.cells[i].
 *     unexpected_tool_uses_count` -- the committed count is defined as exactly the length of that
 *     list; letting the two drift apart would reintroduce a second, independently-wrong source of
 *     truth for the same fact, precisely the class of gap that made the 2026-08 incident's root
 *     cause unrecoverable.
 *  3. `local.raw_transcripts_persisted === committed.raw_transcripts_persisted` -- both tiers must
 *     stamp the IDENTICAL Transaction-1 outcome; this is checked explicitly rather than merely
 *     trusting that both were built from the same boolean, because writeRejectedRunDiagnostics
 *     accepts a hand-built {committed, local} pair from any source, not only
 *     buildRejectionDiagnostics's own output.
 */
export function assertUnexpectedToolCoherence(committed, local) {
  const c = committed?.cells;
  const l = local?.cells;
  if (!Array.isArray(c) || !Array.isArray(l) || c.length !== l.length) {
    throw new Error(`rejection diagnostics: committed.cells and local.cells must be parallel arrays of equal length (committed=${Array.isArray(c) ? c.length : typeof c}, local=${Array.isArray(l) ? l.length : typeof l})`);
  }
  for (let i = 0; i < c.length; i++) {
    if (c[i]?.run_id !== l[i]?.run_id) {
      throw new Error(`rejection diagnostics: cells[${i}] run_id disagrees across tiers (committed '${c[i]?.run_id}', local '${l[i]?.run_id}') -- the two tiers must describe the same cells in the same order`);
    }
    const count = c[i].unexpected_tool_uses_count;
    const list = l[i].unexpected_tools;
    const len = Array.isArray(list) ? list.length : null;
    if (len !== count) {
      throw new Error(`rejection diagnostics: cells[${i}] (${c[i].run_id}) unexpected-tool tiers disagree -- committed.unexpected_tool_uses_count=${JSON.stringify(count)} but local.unexpected_tools has ${len === null ? 'a non-array value' : `${len} entry(ies)`}; the committed count is the summary of exactly that list and can never be an independent second source of truth`);
    }
  }
  if (committed?.raw_transcripts_persisted !== local?.raw_transcripts_persisted) {
    throw new Error(`rejection diagnostics: committed.raw_transcripts_persisted (${JSON.stringify(committed?.raw_transcripts_persisted)}) disagrees with local.raw_transcripts_persisted (${JSON.stringify(local?.raw_transcripts_persisted)}) -- both tiers must stamp the identical Transaction-1 (raw transcripts) outcome`);
  }
}

/**
 * Validates `ambient_profile_matrix_ok` -- both its own run_kind-conditional shape and its
 * coherence against the cells[] it describes. Kept as one function, not split in two, because both
 * checks are about the SAME field's meaning, not two unrelated concerns.
 *
 * Shape: null for run_kind:'calibration'/'smoke' (no matrix/consensus concept applies to a plain
 * A/B pair); for run_kind:'scenario', a real boolean UNLESS this is a schema:3 row whose matrix
 * never completed (`matrix_complete === false`), in which case it must be null too -- representing
 * consensus over a matrix that was never fully evaluated (fail-fast stopped it early) would be a
 * semantically false claim, not merely an unusual one. An already-invalid/not-yet-handled run_kind
 * is skipped here, mirroring validateProvenanceForRunKind's identical "don't cascade a wall of
 * errors" rationale.
 *
 * Coherence (only meaningful once every cell's OWN ambient_skill_profile shape is already
 * individually valid -- comparing already-malformed values would just add redundant noise on top
 * of validateAmbientSkillProfile's own per-cell errors):
 *   1. Every cell must share exactly ONE scope_id, for EVERY run_kind -- generateAmbientProfileScope
 *      (cli.mjs) is called once per harness invocation and threaded into every record built during
 *      it, calibration/smoke's A/B pair exactly like scenario's N-cell matrix.
 *   2. `ambient_profile_matrix_ok === true` implies every cell's count AND fingerprint_hmac are
 *      identical -- that agreement is the literal claim "true" makes. `false` implies nothing about
 *      cell-to-cell equality (a single malformed or wrongly-target-identified cell can fail the
 *      matrix while its own clean ambient names coincidentally still match another cell's -- not a
 *      contradiction).
 *   3. For run_kind:'scenario' only (the only run_kind where cli.mjs's scenarioCellIntegrityOk ever
 *      threads `ambientProfileMatrixOk` into a cell's OWN named-check list): `false` must show up as
 *      `'ambientProfileMatrixOk'` in EVERY cell's failed_checks (it is the identical shared boolean
 *      copied into every cell's own check list, so it can never legitimately fail for only some
 *      cells), and `true` must appear in NO cell's failed_checks. A scenario row claiming a
 *      batch-wide ambient failure that no individual cell's own failed_checks corroborates is
 *      exactly the "rejection with no recorded cause" gap the pre-existing anyCellHasFailedCheck
 *      check exists to catch generically, one level more specific.
 * @returns {Array<{field: string, message: string}>}
 */
function validateAmbientProfileMatrixOk(row) {
  const errors = [];
  if (RUN_KIND_VALUES.includes(row.run_kind)) {
    if (row.run_kind === 'scenario') {
      if (row.schema === 3 && row.matrix_complete === false) {
        if (row.ambient_profile_matrix_ok !== null) {
          errors.push({ field: 'ambient_profile_matrix_ok', message: `must be null when matrix_complete is false -- a matrix that fail-fast stopped before finishing never actually evaluated a real cross-cell consensus` });
        }
      } else if (typeof row.ambient_profile_matrix_ok !== 'boolean') {
        errors.push({ field: 'ambient_profile_matrix_ok', message: `must be a boolean for run_kind:'scenario' -- the matrix-wide ambient-profile consensus is always a real, computed fact for a complete scenario batch` });
      }
    } else if (row.run_kind === 'calibration' || row.run_kind === 'smoke') {
      if (row.ambient_profile_matrix_ok !== null) {
        errors.push({ field: 'ambient_profile_matrix_ok', message: `must be null for run_kind:'${row.run_kind}' -- no matrix/consensus concept applies to a plain A/B pair` });
      }
    }
    // run_kind:'corpus-probe' (or any other recognized-but-not-yet-handled value): its own shape is
    // undefined, already reported by validateProvenanceForRunKind -- not cascaded here too.
  }

  if (!Array.isArray(row.cells) || row.cells.length === 0) return errors;
  const cellsWellFormed = row.cells.every((c) => c != null && typeof c === 'object' && !Array.isArray(c));
  if (!cellsWellFormed) return errors; // already reported by validateRejectionRow's own per-cell loop

  const cellsWithValidProfiles = row.cells.filter((c) => validateAmbientSkillProfile(c.ambient_skill_profile, 'probe').length === 0);
  if (cellsWithValidProfiles.length === row.cells.length) {
    const scopeIds = new Set(cellsWithValidProfiles.map((c) => c.ambient_skill_profile.scope_id));
    if (scopeIds.size > 1) {
      errors.push({ field: 'cells', message: `all cells must share exactly one ambient_skill_profile.scope_id within one harness invocation (found ${scopeIds.size}: ${JSON.stringify([...scopeIds])})` });
    }
    if (row.ambient_profile_matrix_ok === true) {
      const counts = new Set(cellsWithValidProfiles.map((c) => c.ambient_skill_profile.count));
      const fingerprints = new Set(cellsWithValidProfiles.map((c) => c.ambient_skill_profile.fingerprint_hmac));
      if (counts.size > 1 || fingerprints.size > 1) {
        errors.push({ field: 'ambient_profile_matrix_ok', message: `is true (cells agree) but cells[].ambient_skill_profile differs across cells (${counts.size} distinct count(s), ${fingerprints.size} distinct fingerprint_hmac(s))` });
      }
    }
  }

  if (row.run_kind === 'scenario' && typeof row.ambient_profile_matrix_ok === 'boolean') {
    const cellsHaveValidFailedChecks = row.cells.every((c) => Array.isArray(c.failed_checks) && c.failed_checks.every((x) => typeof x === 'string' && x.length > 0));
    if (cellsHaveValidFailedChecks) {
      const flaggedCount = row.cells.filter((c) => c.failed_checks.includes('ambientProfileMatrixOk')).length;
      if (row.ambient_profile_matrix_ok === false && flaggedCount !== row.cells.length) {
        errors.push({ field: 'ambient_profile_matrix_ok', message: `is false but only ${flaggedCount}/${row.cells.length} cells show 'ambientProfileMatrixOk' in failed_checks -- this is one shared matrix-wide value, so a genuine failure must appear in EVERY cell's own failed_checks` });
      }
      if (row.ambient_profile_matrix_ok === true && flaggedCount > 0) {
        errors.push({ field: 'ambient_profile_matrix_ok', message: `is true but ${flaggedCount} cell(s) still show 'ambientProfileMatrixOk' in failed_checks -- contradicts the batch-wide agreement this flag claims` });
      }
    }
  }

  return errors;
}

/**
 * Validates one rejection-diagnostics record. Dispatches on `row.schema` (SUPPORTED_
 * REJECTION_DIAGNOSTICS_SCHEMAS): a schema:2 row is checked against its original, frozen shape
 * (no unexpected_tool_uses_count/matrix_complete/etc.); a schema:3 row additionally gets every new
 * check this fix adds. Closed key sets at EVERY nesting level (top-level, each cells[] entry, both
 * foreign_skill_summary objects) for whichever schema applies. Also enforces: cells[].run_id
 * values unique within one record; exact set-equality between run_ids[] and cells[].run_id;
 * non-negative integer counts everywhere; the top-level foreign_skill_summary must equal the
 * field-by-field sum across cells[].
 * @returns {{errors: Array<{field: string, message: string}>, warnings: Array}}
 */
export function validateRejectionRow(row) {
  const warnings = [];
  if (row == null || typeof row !== 'object' || Array.isArray(row)) {
    return { errors: [{ field: 'row', message: 'must be an object' }], warnings };
  }
  const errors = [];
  const isV3 = row.schema === 3;
  const allowedKeys = new Set(rejectionCanonicalFieldsFor(row.schema));
  for (const k of Object.keys(row)) if (!allowedKeys.has(k)) errors.push({ field: k, message: 'unrecognized field' });
  for (const k of allowedKeys) if (!(k in row)) errors.push({ field: k, message: 'missing required field' });

  if (!SUPPORTED_REJECTION_DIAGNOSTICS_SCHEMAS.includes(row.schema)) {
    errors.push({ field: 'schema', message: `must be one of ${SUPPORTED_REJECTION_DIAGNOSTICS_SCHEMAS.join('|')}, got ${row.schema}` });
  }
  if (typeof row.rejection_id !== 'string' || !UUID_RE.test(row.rejection_id)) {
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
  errors.push(...validateAmbientProfileMatrixOk(row));
  if (typeof row.policy_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.policy_sha256)) {
    errors.push({ field: 'policy_sha256', message: 'must be a lowercase 64-char hex SHA-256 string' });
  }

  // Schema 3-only top-level fields: matrix_complete/planned_cell_count/executed_cell_count/
  // raw_transcripts_persisted. Gated on isV3 -- a schema:2 row (including the two preserved
  // incident files) never has these keys at all, and rejectionCanonicalFieldsFor/the closed-key
  // loop above already enforces that a v2 row must NOT carry them.
  if (isV3) {
    if (typeof row.matrix_complete !== 'boolean') {
      errors.push({ field: 'matrix_complete', message: 'must be a boolean' });
    }
    for (const field of ['planned_cell_count', 'executed_cell_count']) {
      if (!(Number.isInteger(row[field]) && row[field] >= 1)) {
        errors.push({ field, message: 'must be an integer >= 1 -- a rejection always concerns at least one planned/executed cell' });
      }
    }
    if (Number.isInteger(row.planned_cell_count) && Number.isInteger(row.executed_cell_count)) {
      if (row.executed_cell_count > row.planned_cell_count) {
        errors.push({ field: 'executed_cell_count', message: `must be <= planned_cell_count (got ${row.executed_cell_count} > ${row.planned_cell_count}) -- a cell can never execute without having been planned` });
      }
      if (typeof row.matrix_complete === 'boolean' && row.matrix_complete !== (row.executed_cell_count === row.planned_cell_count)) {
        errors.push({ field: 'matrix_complete', message: `is ${row.matrix_complete} but executed_cell_count (${row.executed_cell_count}) ${row.executed_cell_count === row.planned_cell_count ? '===' : '!=='} planned_cell_count (${row.planned_cell_count}) -- matrix_complete is exactly that equality, never an independently-settable flag` });
      }
    }
    if (typeof row.raw_transcripts_persisted !== 'boolean') {
      errors.push({ field: 'raw_transcripts_persisted', message: 'must be a boolean' });
    }
  }

  const runIdsOk = Array.isArray(row.run_ids) && row.run_ids.every((id) => typeof id === 'string' && id.length > 0);
  if (!runIdsOk) errors.push({ field: 'run_ids', message: 'must be an array of non-empty strings' });
  if (runIdsOk && new Set(row.run_ids).size !== row.run_ids.length) errors.push({ field: 'run_ids', message: 'must not contain duplicates' });

  if (!Array.isArray(row.cells) || row.cells.length === 0) {
    errors.push({ field: 'cells', message: 'must be a non-empty array' });
  } else {
    const cellAllowedKeys = new Set(cellCanonicalFieldsFor(row.schema));
    const seenRunIds = new Set();
    // round-6 audit finding ("rechazo sin causa"): a rejection diagnostic whose cells[] ALL carry
    // failed_checks:[] represents a rejection with no recorded cause anywhere in the record -- the
    // per-cell shape check above only confirms each ARRAY is well-formed, never that the batch as
    // a whole actually explains itself. Tracked across the loop, asserted once after it. This
    // ALSO covers a fail-fast partial matrix: it can never legitimately exist without at least one
    // cell's own local-integrity check having failed.
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
      // Round-8 audit finding: this previously checked ONLY the generic shape ("null or a
      // non-empty string"), never actually relating it to the cell's own `condition` -- a
      // no-skill cell carrying a real SHA, or a current-skill cell carrying null, both validated
      // cleanly, contradicting both this file's own comment (which already claimed the
      // relationship) and the main run-record schema's real, enforced rule (schemas.mjs:219-223:
      // condition==='current-skill' requires a real skill_source_sha; every other condition
      // requires null). Mirrors that exact relationship, plus the pre-existing non-empty-string
      // requirement this file's OTHER nullable-string fields already hold cells to.
      if (cell.condition === 'current-skill') {
        if (!(typeof cell.skill_source_sha === 'string' && cell.skill_source_sha.length > 0)) {
          errors.push({ field: `cells[${i}].skill_source_sha`, message: `must be a non-empty string when condition is 'current-skill'` });
        }
      } else if (cell.skill_source_sha !== null) {
        errors.push({ field: `cells[${i}].skill_source_sha`, message: `must be null when condition is not 'current-skill'` });
      }
      if (!(cell.model_resolved === null || (typeof cell.model_resolved === 'string' && cell.model_resolved.length > 0))) {
        errors.push({ field: `cells[${i}].model_resolved`, message: 'must be null (no init event captured) or a non-empty string' });
      }
      if (!(cell.claude_code_version === null || (typeof cell.claude_code_version === 'string' && cell.claude_code_version.length > 0))) {
        errors.push({ field: `cells[${i}].claude_code_version`, message: 'must be null (no init event captured) or a non-empty string' });
      }
      let cellFailedChecksOk = false;
      if (!Array.isArray(cell.failed_checks) || cell.failed_checks.some((c) => typeof c !== 'string' || c.length === 0)) {
        errors.push({ field: `cells[${i}].failed_checks`, message: 'must be an array of non-empty strings' });
      } else {
        cellFailedChecksOk = true;
        if (cell.failed_checks.length > 0) anyCellHasFailedCheck = true;
      }
      errors.push(...validateForeignSkillSummary(cell.foreign_skill_summary, `cells[${i}].foreign_skill_summary`));
      errors.push(...validateAmbientSkillProfile(cell.ambient_skill_profile, `cells[${i}].ambient_skill_profile`));

      // Schema 3-only per-cell field: unexpected_tool_uses_count, plus the single most important
      // invariant this whole fix adds -- a strict BICONDITIONAL with failed_checks containing
      // 'noUnexpectedToolsOk'. noUnexpectedToolsOk is defined (cell-integrity.mjs) as exactly
      // `findUnexpectedToolUses(...).length === 0`, and this count IS that same `.length` --
      // so the check fails if and only if the count is > 0. This is what makes "a rejection
      // attributed to noUnexpectedToolsOk that records zero unexpected tools anywhere" -- the
      // precise, unrecoverable shape of the 2026-08 canary incident -- structurally impossible to
      // write ever again.
      if (isV3) {
        if (!(Number.isInteger(cell.unexpected_tool_uses_count) && cell.unexpected_tool_uses_count >= 0)) {
          errors.push({ field: `cells[${i}].unexpected_tool_uses_count`, message: 'must be a non-negative integer' });
        } else if (cellFailedChecksOk) {
          const flagged = cell.failed_checks.includes('noUnexpectedToolsOk');
          const hasCount = cell.unexpected_tool_uses_count > 0;
          if (flagged !== hasCount) {
            errors.push({
              field: `cells[${i}].unexpected_tool_uses_count`,
              message: flagged
                ? `is 0 but failed_checks contains 'noUnexpectedToolsOk' -- that check fails only when at least one unexpected tool use exists, so a rejection attributed to it must record how many`
                : `is ${cell.unexpected_tool_uses_count} but failed_checks does NOT contain 'noUnexpectedToolsOk' -- a cell with unexpected tool uses must show the check it necessarily failed`,
            });
          }
        }
      }
    }
    if (!anyCellHasFailedCheck) {
      errors.push({ field: 'cells', message: 'at least one cell must have a non-empty failed_checks -- a rejection diagnostic with no recorded failure anywhere is not a real rejection' });
    }
    if (isV3 && Number.isInteger(row.executed_cell_count) && row.executed_cell_count !== row.cells.length) {
      errors.push({ field: 'executed_cell_count', message: `must equal cells.length (${row.cells.length}) -- only executed cells ever produce a record, and every record produces exactly one cell` });
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
 * richer local-only companion (adds real per-cell foreign skill NAMES, unexpected TOOL detail, and
 * a transcript filename, never present in the committed tier) from what the caller's gate-failure
 * branch already has in scope. Never re-derives anything the gate functions already computed
 * (evaluateNamedChecks' failedChecks/failedChecksA/failedChecksB, scenarioHardGate's cellResults,
 * cell-integrity.mjs's unexpectedToolUsesCount/unexpectedTools) -- see cli.mjs's own call sites for
 * how each run_kind maps its own shape into the uniform inputs here. Always constructs schema
 * LATEST_REJECTION_DIAGNOSTICS_SCHEMA (3) -- see validateRejectionRow for why schema:2 is still
 * ACCEPTED (never built) by this module.
 *
 * @param {string} runKind
 * @param {string} rejectionId - a full UUID, generated ONCE by the caller (not here) so the SAME
 *   id can also be passed to writeRejectionRawTranscripts (Transaction 1) before this diagnostic
 *   (Transaction 2) is even built.
 * @param {object[]} records - the already-built run records for this batch (2 for calibrate/
 *   smoke as [recordA, recordB], or just [recordB] for a pair fail-fast stop; N, or M<N for a
 *   fail-fast-stopped matrix) -- each already carries its own run_id/run_kind/condition/
 *   repetition_index/order_index/skill_source_sha/model_resolved/claude_code_version/repo_commit/
 *   model_requested/scenario_id/project_alias/project_commit/project_url/seed/policy_sha256/
 *   platform/privacy_status/foreign_skill_summary/ambient_skill_profile.
 * @param {Record<string, string[]>} failedChecksByRunId - each record's own run_id -> the named
 *   checks that failed for THAT record/side specifically. Must have EXACTLY the same key set as
 *   records[].run_id -- no missing (a real cell's failure reason silently vanishing), no extra.
 * @param {Record<string, number>} unexpectedToolUsesCountByRunId - run_id -> the shared
 *   cell-integrity evaluation's own unexpectedToolUsesCount for that cell. Required, exact-set.
 * @param {Record<string, Array<{name: string, event_index: number}>>} unexpectedToolsByRunId -
 *   run_id -> the shared cell-integrity evaluation's own unexpectedTools list for that cell.
 *   Required, exact-set. Never deduplicated/sorted (unlike foreign_skill_names) -- transcript
 *   ORDER and DUPLICATE occurrences are themselves the forensic signal.
 * @param {Record<string, number>} captureOrdinalByRunId - run_id -> a non-negative integer
 *   execution-position ordinal (0..N-1, unique) used to derive that cell's transcript_filename via
 *   deriveTranscriptFilename. Required, exact-set.
 * @param {boolean} rawTranscriptsPersisted - Transaction 1's own already-known outcome (see
 *   writeRejectionRawTranscripts) -- stamped verbatim into both tiers, never reinterpreted here.
 * @param {Record<string, string[]>} [foreignSkillNamesByRunId] - each record's own run_id -> the
 *   real (never-committed) foreign skillArg names attempted, for the local-only tier.
 * @param {boolean|null} [ambientProfileMatrixOk] - null for calibration/smoke or an incomplete
 *   scenario matrix; a real boolean for a COMPLETE scenario batch.
 * @param {number|null} [plannedCellCount] - defaults to records.length (a normal, complete batch).
 * @param {number|null} [executedCellCount] - defaults to records.length; must equal it always
 *   (only executed cells ever produce a record).
 * @param {boolean|null} [matrixComplete] - defaults to (derived from planned===executed); if
 *   explicitly passed, must agree with that derivation or this throws.
 */
export function buildRejectionDiagnostics({
  runKind, rejectionId, records, failedChecksByRunId, unexpectedToolUsesCountByRunId,
  unexpectedToolsByRunId, captureOrdinalByRunId, rawTranscriptsPersisted,
  foreignSkillNamesByRunId = {}, ambientProfileMatrixOk = null,
  plannedCellCount = null, executedCellCount = null, matrixComplete = null,
}) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('buildRejectionDiagnostics: records must be a non-empty array');
  }
  if (typeof rejectionId !== 'string' || !UUID_RE.test(rejectionId)) {
    throw new Error(`buildRejectionDiagnostics: rejectionId must be a full UUID string, got ${JSON.stringify(rejectionId)}`);
  }
  // Round-7 audit finding ("atribución por celda todavía fail-open"): the caller's OWN runKind
  // parameter was never actually cross-checked against what each record itself declares.
  for (const r of records) {
    if (r.run_kind !== runKind) {
      throw new Error(`buildRejectionDiagnostics: runKind ('${runKind}') does not match record ${r.run_id}'s own run_kind ('${r.run_kind}') -- records from a different run_kind must never be attributed to this batch`);
    }
  }
  const recordRunIds = new Set(records.map((r) => r.run_id));

  // Exact-set-equality, shared shape, for every by-run-id map this function requires -- an absent
  // key would silently read as "nothing to report" for that cell, exactly the fail-open class that
  // made the 2026-08 incident's root cause unrecoverable in the first place.
  const requireExactRunIdKeys = (map, label) => {
    if (map == null || typeof map !== 'object' || Array.isArray(map)) {
      throw new Error(`buildRejectionDiagnostics: ${label} is required and must be an object keyed by run_id`);
    }
    const keys = new Set(Object.keys(map));
    const missing = [...recordRunIds].filter((id) => !keys.has(id));
    const extra = [...keys].filter((id) => !recordRunIds.has(id));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(`buildRejectionDiagnostics: ${label}'s keys must exactly match records[].run_id (missing: ${JSON.stringify(missing)}, extra/stale: ${JSON.stringify(extra)})`);
    }
  };
  requireExactRunIdKeys(failedChecksByRunId, 'failedChecksByRunId');
  requireExactRunIdKeys(unexpectedToolUsesCountByRunId, 'unexpectedToolUsesCountByRunId');
  requireExactRunIdKeys(unexpectedToolsByRunId, 'unexpectedToolsByRunId');
  requireExactRunIdKeys(captureOrdinalByRunId, 'captureOrdinalByRunId');

  if (typeof rawTranscriptsPersisted !== 'boolean') {
    throw new Error(`buildRejectionDiagnostics: rawTranscriptsPersisted is required and must be a boolean, got ${JSON.stringify(rawTranscriptsPersisted)}`);
  }

  const ordinals = records.map((r) => captureOrdinalByRunId[r.run_id]);
  if (ordinals.some((o) => !(Number.isInteger(o) && o >= 0))) {
    throw new Error(`buildRejectionDiagnostics: captureOrdinalByRunId values must all be non-negative integers (got ${JSON.stringify(ordinals)})`);
  }
  if (new Set(ordinals).size !== ordinals.length) {
    throw new Error(`buildRejectionDiagnostics: captureOrdinalByRunId values must be unique (got ${JSON.stringify(ordinals)})`);
  }

  // Round-5 audit finding: never silently collapse to the first record's value without checking
  // agreement. All read directly off buildRunRecord's own field names (never re-derived).
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

  const executed = executedCellCount ?? records.length;
  const planned = plannedCellCount ?? records.length;
  if (!Number.isInteger(executed) || executed !== records.length) {
    throw new Error(`buildRejectionDiagnostics: executedCellCount (${JSON.stringify(executedCellCount)}) must equal records.length (${records.length}) -- only cells that actually executed ever produce a record`);
  }
  if (!Number.isInteger(planned) || planned < executed) {
    throw new Error(`buildRejectionDiagnostics: plannedCellCount (${JSON.stringify(plannedCellCount)}) must be an integer >= executedCellCount (${executed})`);
  }
  const derivedComplete = executed === planned;
  if (matrixComplete !== null && matrixComplete !== derivedComplete) {
    throw new Error(`buildRejectionDiagnostics: matrixComplete (${matrixComplete}) contradicts executedCellCount/plannedCellCount (${executed}/${planned}) -- never an independently-settable flag`);
  }
  const resolvedMatrixComplete = derivedComplete;

  if (!resolvedMatrixComplete && ambientProfileMatrixOk !== null) {
    throw new Error(`buildRejectionDiagnostics: ambientProfileMatrixOk must be null when the matrix is incomplete (resolved matrixComplete is false) -- representing a consensus that was never actually evaluated would be false, got ${JSON.stringify(ambientProfileMatrixOk)}`);
  }

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
    ambient_skill_profile: r.ambient_skill_profile,
    unexpected_tool_uses_count: unexpectedToolUsesCountByRunId[r.run_id],
  }));

  const foreignSkillSummary = { rejected: 0, confirmed: 0, incomplete: 0 };
  for (const cell of cells) {
    foreignSkillSummary.rejected += cell.foreign_skill_summary.rejected;
    foreignSkillSummary.confirmed += cell.foreign_skill_summary.confirmed;
    foreignSkillSummary.incomplete += cell.foreign_skill_summary.incomplete;
  }

  const committed = {
    schema: LATEST_REJECTION_DIAGNOSTICS_SCHEMA,
    rejection_id: rejectionId,
    timestamp: new Date().toISOString(),
    run_kind: runKind,
    run_ids: cells.map((c) => c.run_id),
    ...committedBatchWide,
    cells,
    foreign_skill_summary: foreignSkillSummary,
    ambient_profile_matrix_ok: ambientProfileMatrixOk,
    matrix_complete: resolvedMatrixComplete,
    planned_cell_count: planned,
    executed_cell_count: executed,
    raw_transcripts_persisted: rawTranscriptsPersisted,
  };

  // Local-only tier: same base shape, PLUS project_url (batch-wide) and, per cell, real
  // (deduplicated, sorted) foreign skill names, the unexpected-tool structural detail (deliberately
  // NOT deduplicated/sorted -- see this function's own param doc), and the derived transcript
  // filename -- never present in `committed`. Still no raw transcript CONTENT in this tier; that
  // lives only in tier 3 (writeRejectionRawTranscripts), addressed BY this filename.
  const local = {
    ...committed,
    project_url: projectUrl,
    cells: cells.map((c) => ({
      ...c,
      foreign_skill_names: [...new Set(foreignSkillNamesByRunId[c.run_id] ?? [])].sort(),
      unexpected_tools: (unexpectedToolsByRunId[c.run_id] ?? []).map((u) => ({ name: u.name, event_index: u.event_index })),
      transcript_filename: deriveTranscriptFilename(captureOrdinalByRunId[c.run_id], c.run_id),
    })),
  };

  assertUnexpectedToolCoherence(committed, local);
  return { committed, local };
}

/**
 * Transaction 1 of 2 (see writeRejectedRunDiagnostics, below, for Transaction 2) -- writes the raw
 * rawStdout transcript of every EXECUTED cell to a separate, gitignored, per-rejection directory,
 * independently of whether the structured diagnostic (Transaction 2) can be built/validated/
 * written at all. Deliberately its own atomic transaction, meant to run FIRST: a redaction rule
 * that happens to corrupt the structured diagnostic's shape must never also cost the raw
 * transcripts, which need no validation/redaction to be forensically useful -- the exact same "a
 * secondary layer blocks primary evidence" failure class the 2026-08 canary incident itself was,
 * one level removed. Never redacts the transcript content itself (same contract as every other
 * raw/ tier in this harness) -- safety comes from confirming the destination is gitignored, not
 * from sanitizing what's inside it.
 *
 * @param {string} rejectionId - a full UUID. VALIDATED here, not merely trusted, because this
 *   value is used to build a filesystem path and is accepted as an external parameter (not
 *   generated internally by this function) -- a malformed value could otherwise attempt path
 *   traversal exactly the way an unvalidated run_id could.
 * @param {Record<string, string>} transcriptsByRunId - run_id -> that cell's raw rawStdout capture
 *   (an empty string is legitimate and forensically meaningful: the session produced no stdout).
 * @param {Record<string, number>} captureOrdinalByRunId - run_id -> a non-negative integer capture
 *   position (0..N-1, unique, assigned by the caller from actual execution order) -- MUST have
 *   exactly the same key set as transcriptsByRunId. Never the schema's own `order_index` field.
 * @param {{runsRootOverride?: string}} [opts]
 * @returns {{transcriptsDir: string, transcriptsRelativeDir: string, transcriptCount: number}}
 */
export function writeRejectionRawTranscripts(rejectionId, transcriptsByRunId, captureOrdinalByRunId, { runsRootOverride } = {}) {
  if (typeof rejectionId !== 'string' || !UUID_RE.test(rejectionId)) {
    throw new Error(`refusing to write raw transcripts: rejectionId must be a full UUID string, got ${JSON.stringify(rejectionId)}`);
  }
  if (transcriptsByRunId == null || typeof transcriptsByRunId !== 'object' || Array.isArray(transcriptsByRunId)) {
    throw new Error('refusing to write raw transcripts: transcriptsByRunId is required and must be an object keyed by run_id');
  }
  if (captureOrdinalByRunId == null || typeof captureOrdinalByRunId !== 'object' || Array.isArray(captureOrdinalByRunId)) {
    throw new Error('refusing to write raw transcripts: captureOrdinalByRunId is required and must be an object keyed by run_id');
  }
  const transcriptKeys = new Set(Object.keys(transcriptsByRunId));
  const ordinalKeys = new Set(Object.keys(captureOrdinalByRunId));
  const missingOrdinals = [...transcriptKeys].filter((id) => !ordinalKeys.has(id));
  const extraOrdinals = [...ordinalKeys].filter((id) => !transcriptKeys.has(id));
  if (missingOrdinals.length > 0 || extraOrdinals.length > 0) {
    throw new Error(`refusing to write raw transcripts: captureOrdinalByRunId's keys must exactly match transcriptsByRunId's (missing: ${JSON.stringify(missingOrdinals)}, extra/stale: ${JSON.stringify(extraOrdinals)})`);
  }
  const runIds = [...transcriptKeys];
  const ordinalValues = runIds.map((id) => captureOrdinalByRunId[id]);
  if (ordinalValues.some((o) => !(Number.isInteger(o) && o >= 0))) {
    throw new Error(`refusing to write raw transcripts: captureOrdinalByRunId values must all be non-negative integers (got ${JSON.stringify(ordinalValues)})`);
  }
  if (new Set(ordinalValues).size !== ordinalValues.length) {
    throw new Error(`refusing to write raw transcripts: captureOrdinalByRunId values must be unique (got ${JSON.stringify(ordinalValues)})`);
  }
  for (const id of runIds) {
    if (typeof transcriptsByRunId[id] !== 'string') {
      throw new Error(`refusing to write raw transcripts: transcriptsByRunId['${id}'] must be a string (the cell's raw stream-json stdout; '' is legitimate), got ${typeof transcriptsByRunId[id]}`);
    }
  }

  const outDir = resolveRejectedDiagnosticsDir(runsRootOverride);
  const rawDir = join(outDir, 'raw');
  const transcriptsDir = join(rawDir, 'transcripts', rejectionId);
  // Verified INDEPENDENTLY of writeRejectedRunDiagnostics's own identical check on `rawDir` --
  // never inferred from that other check's verdict. `git check-ignore` honours the LAST matching
  // rule, so a future negation could in principle un-ignore this nested subtree while `raw/`
  // itself still reports ignored; fail closed, empirically, at runtime, every time.
  if (!isRawDirSafeFromAccidentalCommit(transcriptsDir, runsRootOverride)) {
    throw new Error(`refusing to write raw transcripts: ${transcriptsDir} is inside this repo's worktree but not covered by .gitignore -- would risk an accidental commit of raw, unredacted transcripts`);
  }

  const targets = runIds.map((id) => [
    join(transcriptsDir, deriveTranscriptFilename(captureOrdinalByRunId[id], id)),
    transcriptsByRunId[id],
  ]);
  promoteTargetsAtomically(targets, transcriptsDir);

  return {
    transcriptsDir,
    transcriptsRelativeDir: join('agentic-eval-rejected', 'raw', 'transcripts', rejectionId),
    transcriptCount: runIds.length,
  };
}

/**
 * Transaction 2 of 2 -- the structured-diagnostic write (tiers 1+2). Committed tier: validate ->
 * redact -> revalidate -> promote. Local tier: shape-checked via validateRejectionLocalRow (its
 * own narrow validator, not the closed committed schema, since it deliberately carries extra
 * fields the committed schema forbids), redacted for incidental path/serial/name leaks (same
 * privacy layer), then re-shape-checked post-redaction.
 *
 * Never writes any transcript file -- that is Transaction 1's (writeRejectionRawTranscripts, above)
 * sole responsibility, already attempted (successfully or not) before this function is ever
 * called; this function's own signature is otherwise UNCHANGED from before this fix.
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

  const { errors: localShapeErrors } = validateRejectionLocalRow(local);
  if (localShapeErrors.length > 0) {
    throw new Error(`refusing to write rejection diagnostics: local detail record failed shape validation before redaction: ${JSON.stringify(localShapeErrors)}`);
  }
  // Re-asserted here (not only inside buildRejectionDiagnostics): this function accepts a
  // hand-built {committed, local} pair from ANY source, not only buildRejectionDiagnostics's own
  // output -- several existing tests already construct one directly.
  assertUnexpectedToolCoherence(committed, local);

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

  let redactedLocalObj, redactedLocalText;
  try {
    ({ redactedObj: redactedLocalObj, redactedText: redactedLocalText } = assertCleanOrThrowObject(local, { privatePatternsFile }));
  } catch (err) {
    throw new Error(`refusing to write rejection diagnostics: privacy check refused the local detail record: ${err.message}`);
  }
  const { errors: redactedLocalShapeErrors } = validateRejectionLocalRow(redactedLocalObj);
  if (redactedLocalShapeErrors.length > 0) {
    throw new Error(`refusing to write rejection diagnostics: redaction corrupted the local detail record's shape: ${JSON.stringify(redactedLocalShapeErrors)}`);
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
  // safe to print without a separate privacy-redaction pass. resolveRejectedDiagnosticsDir always
  // resolves to `<runsRoot>/agentic-eval-rejected`, so this is structurally constant regardless of
  // the (possibly test-isolated) runsRootOverride value.
  return { outDir, rejectionId: committed.rejection_id, relativePath: join('agentic-eval-rejected', committedFilename) };
}

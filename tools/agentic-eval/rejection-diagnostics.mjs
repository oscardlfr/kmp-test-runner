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
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { resolveRejectedDiagnosticsDir, isRawDirSafeFromAccidentalCommit, promoteTargetsAtomically } from './evidence-io.mjs';
import { assertCleanOrThrowObject, redactAndVerify } from './privacy.mjs';
import { RUN_KIND_VALUES, CONDITION_VALUES, PLATFORM_VALUES, PRIVACY_STATUS_VALUES } from './schemas.mjs';
import { validateCorrelationObservability } from './correlation-observability.mjs';
import { GRADING_CHECK_NAMES } from './graders.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Schema-version dispatch (mirrors schemas.mjs's SUPPORTED_RUN_SCHEMAS/LATEST_RUN_SCHEMA/
// runCanonicalFieldsFor pattern) -- adopted here specifically because v2 -> v3 is NOT a routine
// same-precedent bump: two real diagnostic files from a live 2026-08 canary rejection (preserved
// as this PR's own motivating incident evidence, outside this repo, hashed and declared not to be
// deleted) are schema:2 and must keep validating. CELL_CANONICAL_FIELDS_V2/
// REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V2 are therefore frozen forever, exactly like
// RUN_CANONICAL_FIELDS_V1 is frozen for the 8 historical schema:1 run records in schemas.mjs.
// v2 and v3 are BOTH frozen the same way going forward -- policy_sha256 stays a required real
// hex64 hash for either, and the builder never emits v2. Re-check this premise before any FUTURE
// bump: the moment a real schema:4 file is ever committed to this repo's own git history, the NEXT
// bump must follow this same dispatch pattern rather than reverting to a plain constant bump.
//
// schema 4 (sandboxed-unrestricted-v1 rejection support): the first shape exclusive to a batch whose
// every record is schema>=6 with execution_profile.policy_mode==="not_applicable" -- no policy
// hook ever governed such a batch, so policy_sha256 is honestly null (never a stale/synthetic
// hash) and three new fields (execution_profile_id/policy_mode/isolation_attestation_sha256)
// report which profile/attestation actually applied. Every OTHER batch (policy-required, or a
// pre-schema-6 legacy record) still builds v3 exactly as before -- see buildRejectionDiagnostics'
// own inline dispatch (its `policyModes`/`buildingNotApplicable`/`schema` locals), which never selects a
// schema via LATEST_REJECTION_DIAGNOSTICS_SCHEMA (a future LATEST bump must never silently
// redirect an unrelated, policy-required batch away from schema 3).
//
// schema 5: the first emitted sandboxed-unrestricted-v1 rejection observability shape. It keeps schema 4's
// batch-wide not_applicable fields and adds two per-cell, privacy-safe observability surfaces:
// closed run-record error codes and correlation-observability v1 count summaries. It still carries
// no raw transcript content, tool IDs, commands, paths, prompts, responses, or timestamps.
// schema 6: the historical emitted sandboxed-unrestricted-v1 rejection shape. It keeps schema 5
// and adds a per-cell pre_inference_failure summary: closed terminal metadata and usage/tool
// counts only, never final text, prompts, responses, paths, tool ids, command strings, or
// timestamps.
//
// schema 7: the historical emitted sandboxed-unrestricted-v1 rejection metrics shape. It keeps schema 6 and
// adds per-cell cell_metrics: the already-built run record's exact timing/usage/token/tool-count
// projection. This is deliberately separate from pre_inference_failure's categorical signatures
// so consumers can analyze rejected cells without reading raw transcripts or overloading a
// failure-classification field with numeric analytics.
//
// schema 8: the current emitted sandboxed-unrestricted-v1 rejection grading-observability shape.
// It keeps schema 7 and adds per-cell grading_summary: a closed, privacy-safe projection of
// success, expected_outcome_matched, and per-check pass booleans/event indices from the already-
// built run record. It deliberately drops grading_checks[].detail and every other free-text/raw
// surface; consumers get enough structure to distinguish "cell graded and failed semantically"
// from "cell never reached grading" without opening raw transcripts.
//
// schema 9: the current emitted sandboxed-unrestricted-v1 pre-inference-cause shape. It keeps
// schema 8 and upgrades per-cell pre_inference_failure from nested schema:1 to schema:2 by adding
// a closed cause_code. This lets operators distinguish the exact "terminal error before any
// useful model work" class without reading raw transcripts, stderr, prompts, responses, paths,
// commands, or final text.
export const REJECTION_DIAGNOSTICS_SCHEMA_V2 = 2;
export const REJECTION_DIAGNOSTICS_SCHEMA_V3 = 3;
export const REJECTION_DIAGNOSTICS_SCHEMA_V4 = 4;
export const REJECTION_DIAGNOSTICS_SCHEMA_V5 = 5;
export const REJECTION_DIAGNOSTICS_SCHEMA_V6 = 6;
export const REJECTION_DIAGNOSTICS_SCHEMA_V7 = 7;
export const REJECTION_DIAGNOSTICS_SCHEMA_V8 = 8;
export const REJECTION_DIAGNOSTICS_SCHEMA_V9 = 9;
export const SUPPORTED_REJECTION_DIAGNOSTICS_SCHEMAS = [REJECTION_DIAGNOSTICS_SCHEMA_V2, REJECTION_DIAGNOSTICS_SCHEMA_V3, REJECTION_DIAGNOSTICS_SCHEMA_V4, REJECTION_DIAGNOSTICS_SCHEMA_V5, REJECTION_DIAGNOSTICS_SCHEMA_V6, REJECTION_DIAGNOSTICS_SCHEMA_V7, REJECTION_DIAGNOSTICS_SCHEMA_V8, REJECTION_DIAGNOSTICS_SCHEMA_V9];
export const LATEST_REJECTION_DIAGNOSTICS_SCHEMA = REJECTION_DIAGNOSTICS_SCHEMA_V9;

// Mirrors registries.mjs's own ID_RE exactly (a small, local copy -- not imported, matching this
// module's and isolation-attestation.mjs's own established convention of keeping such small
// primitives module-local rather than sharing them).
const EXECUTION_PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const FOREIGN_SKILL_SUMMARY_FIELDS = ['rejected', 'confirmed', 'incomplete'];
const AMBIENT_SKILL_PROFILE_FIELDS = ['count', 'scope_id', 'fingerprint_hmac'];
const PRE_INFERENCE_FAILURE_FIELDS = [
  'schema', 'signature_matched', 'terminal_present', 'terminal_is_error',
  'terminal_result_subtype', 'terminal_turn_count', 'usage', 'tool_attempt_count',
];
const PRE_INFERENCE_FAILURE_FIELDS_V2 = [...PRE_INFERENCE_FAILURE_FIELDS, 'cause_code'];
const PRE_INFERENCE_USAGE_FIELDS = ['input', 'output', 'cached_input', 'cache_write'];
const PRE_INFERENCE_USAGE_STATUS_VALUES = ['zero', 'nonzero', 'null'];
const PRE_INFERENCE_CAUSE_CODE_VALUES = ['not_matched', 'pre_inference_terminal_error_zero_usage_zero_tools'];
const CELL_METRICS_FIELDS = [
  'schema', 'started_at', 'ended_at', 'wall_clock_ms', 'first_useful_signal_ms',
  'post_signal_ms', 'usage', 'tokens', 'tool_calls_total', 'shell_commands_total',
];
const CELL_METRICS_USAGE_FIELDS = ['source', 'input', 'cached_input', 'cache_write', 'output', 'reasoning_output'];
const CELL_METRICS_TOKEN_FIELDS = ['input', 'output', 'cache_read', 'cache_creation'];
const GRADING_SUMMARY_FIELDS = ['schema', 'success', 'expected_outcome_matched', 'grading_checks'];
const GRADING_SUMMARY_METRIC_FIELDS = ['value', 'reason'];
const GRADING_SUMMARY_REASON_VALUES = ['not_applicable', 'not_recorded', 'not_tracked'];
const GRADING_SUMMARY_CHECK_FIELDS = ['name', 'passed', 'evidence_event_indices'];
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
const CELL_CANONICAL_FIELDS_V5 = [
  ...CELL_CANONICAL_FIELDS_V3,
  'record_error_codes', 'correlation_observability',
];
const CELL_CANONICAL_FIELDS_V6 = [...CELL_CANONICAL_FIELDS_V5, 'pre_inference_failure'];
const CELL_CANONICAL_FIELDS_V7 = [...CELL_CANONICAL_FIELDS_V6, 'cell_metrics'];
const CELL_CANONICAL_FIELDS_V8 = [...CELL_CANONICAL_FIELDS_V7, 'grading_summary'];

// Explicit if-chain, never a ternary/fallthrough -- mirrors schemas.mjs's runCanonicalFieldsFor
// rationale: a naive fallthrough would silently validate an unrecognized future schema against the
// WRONG (older) field list. v4 reuses the IDENTICAL per-cell shape as v3 (schema 4's own 3 new
// fields are all batch-wide, never per-cell) -- never REJECTION_DIAGNOSTICS_SCHEMA_V4 falling
// through to the v2 cell shape by accident.
function cellCanonicalFieldsFor(schema) {
  if (schema === REJECTION_DIAGNOSTICS_SCHEMA_V9) return CELL_CANONICAL_FIELDS_V8;
  if (schema === REJECTION_DIAGNOSTICS_SCHEMA_V8) return CELL_CANONICAL_FIELDS_V8;
  if (schema === REJECTION_DIAGNOSTICS_SCHEMA_V7) return CELL_CANONICAL_FIELDS_V7;
  if (schema === REJECTION_DIAGNOSTICS_SCHEMA_V6) return CELL_CANONICAL_FIELDS_V6;
  if (schema === REJECTION_DIAGNOSTICS_SCHEMA_V5) return CELL_CANONICAL_FIELDS_V5;
  if (schema === REJECTION_DIAGNOSTICS_SCHEMA_V4 || schema === REJECTION_DIAGNOSTICS_SCHEMA_V3) return CELL_CANONICAL_FIELDS_V3;
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
// Schema 4 = v3 + execution_profile_id/policy_mode/isolation_attestation_sha256 -- the ONE shape
// exclusive to a policy_mode:"not_applicable" batch (see this module's own header comment above
// SUPPORTED_REJECTION_DIAGNOSTICS_SCHEMAS for the full rationale). policy_sha256 stays a REQUIRED
// field (inherited from v3, never removed) -- for schema 4 it is validated to be exactly null,
// never dropped from the shape entirely.
const REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V4 = [
  ...REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V3,
  'execution_profile_id', 'policy_mode', 'isolation_attestation_sha256',
];
const REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V5 = [...REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V4];

function rejectionCanonicalFieldsFor(schema) {
  if (schema === REJECTION_DIAGNOSTICS_SCHEMA_V9) return REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V5;
  if (schema === REJECTION_DIAGNOSTICS_SCHEMA_V8) return REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V5;
  if (schema === REJECTION_DIAGNOSTICS_SCHEMA_V7) return REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V5;
  if (schema === REJECTION_DIAGNOSTICS_SCHEMA_V6) return REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V5;
  if (schema === REJECTION_DIAGNOSTICS_SCHEMA_V5) return REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V5;
  if (schema === REJECTION_DIAGNOSTICS_SCHEMA_V4) return REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V4;
  if (schema === REJECTION_DIAGNOSTICS_SCHEMA_V3) return REJECTION_DIAGNOSTICS_CANONICAL_FIELDS_V3;
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
 * Post-open-PR review finding: the single canonical `captureOrdinalByRunId` validator, shared by
 * buildRejectionDiagnostics and writeRejectionRawTranscripts. Each previously duplicated an
 * independent, WEAKER check (non-negative integers + pairwise-unique values only) that silently
 * tolerated a GAP: `{a:0, b:2}` for 2 run_ids passed both, and writeRejectionRawTranscripts
 * genuinely wrote a file named `2-<hash>.jsonl` alongside `0-<hash>.jsonl` -- reproduced directly
 * against `develop`'s pre-fix code before this function existed. Requires, in this order:
 *   1. captureOrdinalByRunId's keys exactly match `expectedRunIds` (no missing, no stale/extra) --
 *      unchanged in wording/behavior from each caller's own pre-existing key check.
 *   2. every value is a non-negative integer -- unchanged in wording/behavior.
 *   3. the VALUE SET is exactly `{0, 1, ..., N-1}` for `N = expectedRunIds.length` -- contiguous
 *      and gap-free, not merely pairwise-unique, so a duplicate (which by the pigeonhole principle
 *      forces some other index to be missing from the range) is caught by the SAME check as an
 *      out-of-range value, rather than two independently-maintained ones that could drift apart.
 * `errorPrefix` lets each caller keep its own already-established message lead-in
 * (`buildRejectionDiagnostics` vs. `refusing to write raw transcripts`) unchanged.
 * @param {Record<string, number>} captureOrdinalByRunId
 * @param {string[]} expectedRunIds
 * @param {string} errorPrefix
 */
export function validateCaptureOrdinalSet(captureOrdinalByRunId, expectedRunIds, errorPrefix) {
  if (captureOrdinalByRunId == null || typeof captureOrdinalByRunId !== 'object' || Array.isArray(captureOrdinalByRunId)) {
    throw new Error(`${errorPrefix}: captureOrdinalByRunId is required and must be an object keyed by run_id`);
  }
  const expectedSet = new Set(expectedRunIds);
  const keys = new Set(Object.keys(captureOrdinalByRunId));
  const missing = [...expectedSet].filter((id) => !keys.has(id));
  const extra = [...keys].filter((id) => !expectedSet.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${errorPrefix}: captureOrdinalByRunId's keys must exactly match the expected run_ids (missing: ${JSON.stringify(missing)}, extra/stale: ${JSON.stringify(extra)})`);
  }
  const ordinals = expectedRunIds.map((id) => captureOrdinalByRunId[id]);
  if (ordinals.some((o) => !(Number.isInteger(o) && o >= 0))) {
    throw new Error(`${errorPrefix}: captureOrdinalByRunId values must all be non-negative integers (got ${JSON.stringify(ordinals)})`);
  }
  const n = expectedRunIds.length;
  const actualSet = new Set(ordinals);
  const isExactRange = actualSet.size === n && Array.from({ length: n }, (_, i) => i).every((i) => actualSet.has(i));
  if (!isExactRange) {
    throw new Error(`${errorPrefix}: captureOrdinalByRunId values must form the exact set {0..${n - 1}} with no gaps or duplicates (got ${JSON.stringify(ordinals)})`);
  }
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

function validatePreInferenceFailureSummary(summary, fieldPrefix, failedChecks, allowedSchemas = [1, 2]) {
  const errors = [];
  if (summary == null || typeof summary !== 'object' || Array.isArray(summary)) {
    errors.push({ field: fieldPrefix, message: 'must be an object' });
    return errors;
  }
  const nestedSchema = summary.schema;
  const allowedKeys = new Set(nestedSchema === 2 ? PRE_INFERENCE_FAILURE_FIELDS_V2 : PRE_INFERENCE_FAILURE_FIELDS);
  for (const k of Object.keys(summary)) {
    if (!allowedKeys.has(k)) errors.push({ field: `${fieldPrefix}.${k}`, message: 'unrecognized field' });
  }
  for (const k of allowedKeys) {
    if (!(k in summary)) errors.push({ field: `${fieldPrefix}.${k}`, message: 'missing required field' });
  }
  if (!allowedSchemas.includes(summary.schema)) errors.push({ field: `${fieldPrefix}.schema`, message: `must be exactly ${allowedSchemas.join(' or ')}` });
  if (typeof summary.signature_matched !== 'boolean') errors.push({ field: `${fieldPrefix}.signature_matched`, message: 'must be a boolean' });
  if (typeof summary.terminal_present !== 'boolean') errors.push({ field: `${fieldPrefix}.terminal_present`, message: 'must be a boolean' });
  if (!(summary.terminal_is_error === null || typeof summary.terminal_is_error === 'boolean')) errors.push({ field: `${fieldPrefix}.terminal_is_error`, message: 'must be null or boolean' });
  if (!(summary.terminal_result_subtype === null || (typeof summary.terminal_result_subtype === 'string' && /^[a-z][a-z0-9_]*$/.test(summary.terminal_result_subtype)))) {
    errors.push({ field: `${fieldPrefix}.terminal_result_subtype`, message: 'must be null or a closed lowercase snake_case subtype' });
  }
  if (!(summary.terminal_turn_count === null || (Number.isInteger(summary.terminal_turn_count) && summary.terminal_turn_count >= 0))) {
    errors.push({ field: `${fieldPrefix}.terminal_turn_count`, message: 'must be null or a non-negative integer' });
  }
  if (summary.usage == null || typeof summary.usage !== 'object' || Array.isArray(summary.usage)) {
    errors.push({ field: `${fieldPrefix}.usage`, message: 'must be an object' });
  } else {
    const usageKeys = new Set(PRE_INFERENCE_USAGE_FIELDS);
    for (const k of Object.keys(summary.usage)) {
      if (!usageKeys.has(k)) errors.push({ field: `${fieldPrefix}.usage.${k}`, message: 'unrecognized field' });
    }
    for (const k of usageKeys) {
      if (!PRE_INFERENCE_USAGE_STATUS_VALUES.includes(summary.usage[k])) {
        errors.push({ field: `${fieldPrefix}.usage.${k}`, message: `must be one of ${PRE_INFERENCE_USAGE_STATUS_VALUES.join('|')}` });
      }
    }
  }
  if (!(Number.isInteger(summary.tool_attempt_count) && summary.tool_attempt_count >= 0)) {
    errors.push({ field: `${fieldPrefix}.tool_attempt_count`, message: 'must be a non-negative integer' });
  }
  if (summary.schema === 2 && !PRE_INFERENCE_CAUSE_CODE_VALUES.includes(summary.cause_code)) {
    errors.push({ field: `${fieldPrefix}.cause_code`, message: `must be one of ${PRE_INFERENCE_CAUSE_CODE_VALUES.join('|')}` });
  }
  if (typeof summary.signature_matched === 'boolean') {
    const usage = summary.usage && typeof summary.usage === 'object' && !Array.isArray(summary.usage) ? summary.usage : {};
    const hasNonZeroUsage = PRE_INFERENCE_USAGE_FIELDS.some((k) => usage[k] === 'nonzero');
    const derivedSignatureMatched = summary.terminal_present === true
      && summary.terminal_is_error === true
      && Number.isInteger(summary.terminal_turn_count)
      && summary.terminal_turn_count >= 0
      && summary.terminal_turn_count <= 1
      && !hasNonZeroUsage
      && summary.tool_attempt_count === 0;
    if (summary.signature_matched !== derivedSignatureMatched) {
      errors.push({
        field: `${fieldPrefix}.signature_matched`,
        message: `must match the normalized pre-inference signature derived from terminal/usage/tool_attempt_count fields (derived: ${derivedSignatureMatched})`,
      });
    }
    if (summary.schema === 2) {
      const derivedCauseCode = derivedSignatureMatched ? 'pre_inference_terminal_error_zero_usage_zero_tools' : 'not_matched';
      if (summary.cause_code !== derivedCauseCode) {
        errors.push({
          field: `${fieldPrefix}.cause_code`,
          message: `must match the normalized pre-inference cause derived from signature_matched (derived: ${derivedCauseCode})`,
        });
      }
    }
  }
  if (Array.isArray(failedChecks) && typeof summary.signature_matched === 'boolean') {
    const flagged = failedChecks.includes('noPreInferenceFailureOk');
    if (summary.signature_matched !== flagged) {
      errors.push({
        field: `${fieldPrefix}.signature_matched`,
        message: `must be true iff failed_checks contains 'noPreInferenceFailureOk' (failed_checks has it: ${flagged})`,
      });
    }
  }
  return errors;
}

function validateMetricProjection(metric, fieldPrefix, errors, kind) {
  if (metric == null || typeof metric !== 'object' || Array.isArray(metric)) {
    errors.push({ field: fieldPrefix, message: 'must be a {value, reason} object' });
    return;
  }
  const allowedKeys = new Set(['value', 'reason']);
  for (const k of Object.keys(metric)) {
    if (!allowedKeys.has(k)) errors.push({ field: `${fieldPrefix}.${k}`, message: 'unrecognized field' });
  }
  for (const k of allowedKeys) {
    if (!(k in metric)) errors.push({ field: `${fieldPrefix}.${k}`, message: 'missing required field' });
  }
  if (metric.value === null) {
    if (typeof metric.reason !== 'string' || metric.reason.length === 0) {
      errors.push({ field: `${fieldPrefix}.reason`, message: 'must be a non-empty string when value is null' });
    }
    return;
  }
  if (metric.reason !== null) {
    errors.push({ field: `${fieldPrefix}.reason`, message: 'must be null when value is present' });
  }
  if (kind === 'count' && !(Number.isInteger(metric.value) && metric.value >= 0)) {
    errors.push({ field: `${fieldPrefix}.value`, message: 'must be a non-negative integer or null' });
  } else if (kind === 'timing' && !(typeof metric.value === 'number' && Number.isFinite(metric.value) && metric.value >= 0)) {
    errors.push({ field: `${fieldPrefix}.value`, message: 'must be a non-negative finite number or null' });
  }
}

function validateCellMetrics(metrics, fieldPrefix) {
  const errors = [];
  if (metrics == null || typeof metrics !== 'object' || Array.isArray(metrics)) {
    errors.push({ field: fieldPrefix, message: 'must be an object' });
    return errors;
  }
  const allowedKeys = new Set(CELL_METRICS_FIELDS);
  for (const k of Object.keys(metrics)) {
    if (!allowedKeys.has(k)) errors.push({ field: `${fieldPrefix}.${k}`, message: 'unrecognized field' });
  }
  for (const k of allowedKeys) {
    if (!(k in metrics)) errors.push({ field: `${fieldPrefix}.${k}`, message: 'missing required field' });
  }
  if (metrics.schema !== 1) errors.push({ field: `${fieldPrefix}.schema`, message: 'must be exactly 1' });
  for (const field of ['started_at', 'ended_at']) {
    if (typeof metrics[field] !== 'string' || Number.isNaN(Date.parse(metrics[field]))) {
      errors.push({ field: `${fieldPrefix}.${field}`, message: 'must be a valid ISO timestamp string' });
    }
  }
  if (!(typeof metrics.wall_clock_ms === 'number' && Number.isFinite(metrics.wall_clock_ms) && metrics.wall_clock_ms >= 0)) {
    errors.push({ field: `${fieldPrefix}.wall_clock_ms`, message: 'must be a non-negative finite number' });
  }
  validateMetricProjection(metrics.first_useful_signal_ms, `${fieldPrefix}.first_useful_signal_ms`, errors, 'timing');
  validateMetricProjection(metrics.post_signal_ms, `${fieldPrefix}.post_signal_ms`, errors, 'timing');
  validateMetricProjection(metrics.tool_calls_total, `${fieldPrefix}.tool_calls_total`, errors, 'count');
  validateMetricProjection(metrics.shell_commands_total, `${fieldPrefix}.shell_commands_total`, errors, 'count');

  if (metrics.usage == null || typeof metrics.usage !== 'object' || Array.isArray(metrics.usage)) {
    errors.push({ field: `${fieldPrefix}.usage`, message: 'must be an object' });
  } else {
    const usageKeys = new Set(CELL_METRICS_USAGE_FIELDS);
    for (const k of Object.keys(metrics.usage)) {
      if (!usageKeys.has(k)) errors.push({ field: `${fieldPrefix}.usage.${k}`, message: 'unrecognized field' });
    }
    for (const k of usageKeys) {
      if (!(k in metrics.usage)) errors.push({ field: `${fieldPrefix}.usage.${k}`, message: 'missing required field' });
    }
    if (!['runtime-reported', 'not-recorded', 'offline-estimate'].includes(metrics.usage.source)) {
      errors.push({ field: `${fieldPrefix}.usage.source`, message: 'must be a closed usage source' });
    }
    for (const dim of CELL_METRICS_USAGE_FIELDS.filter((k) => k !== 'source')) {
      const v = metrics.usage[dim];
      if (v !== null && !(Number.isInteger(v) && v >= 0)) {
        errors.push({ field: `${fieldPrefix}.usage.${dim}`, message: 'must be null or a non-negative integer' });
      }
    }
  }

  if (metrics.tokens == null || typeof metrics.tokens !== 'object' || Array.isArray(metrics.tokens)) {
    errors.push({ field: `${fieldPrefix}.tokens`, message: 'must be an object' });
  } else {
    const tokenKeys = new Set(CELL_METRICS_TOKEN_FIELDS);
    for (const k of Object.keys(metrics.tokens)) {
      if (!tokenKeys.has(k)) errors.push({ field: `${fieldPrefix}.tokens.${k}`, message: 'unrecognized field' });
    }
    for (const k of tokenKeys) {
      if (!(k in metrics.tokens)) errors.push({ field: `${fieldPrefix}.tokens.${k}`, message: 'missing required field' });
      validateMetricProjection(metrics.tokens[k], `${fieldPrefix}.tokens.${k}`, errors, 'count');
    }
    const projections = [
      ['input', 'input'],
      ['output', 'output'],
      ['cache_read', 'cached_input'],
      ['cache_creation', 'cache_write'],
    ];
    for (const [tokenKey, usageKey] of projections) {
      const tokenValue = metrics.tokens?.[tokenKey]?.value ?? null;
      const usageValue = metrics.usage && typeof metrics.usage === 'object' && !Array.isArray(metrics.usage)
        ? (metrics.usage[usageKey] ?? null)
        : null;
      if (tokenValue !== usageValue) {
        errors.push({ field: `${fieldPrefix}.tokens.${tokenKey}`, message: `must exactly equal usage.${usageKey} (${JSON.stringify(usageValue)})` });
      }
    }
  }
  return errors;
}

function gradingSummaryReason(metric) {
  const reason = typeof metric?.reason === 'string' ? metric.reason.toLowerCase() : '';
  if (reason.includes('not applicable')) return 'not_applicable';
  if (reason.includes('not tracked')) return 'not_tracked';
  return 'not_recorded';
}

function summarizeBooleanMetric(metric) {
  if (metric?.value === true || metric?.value === false) {
    return { value: metric.value, reason: null };
  }
  return { value: null, reason: gradingSummaryReason(metric) };
}

function summarizeGradingChecks(metric) {
  if (!Array.isArray(metric?.value)) {
    return { value: null, reason: gradingSummaryReason(metric) };
  }
  return {
    value: metric.value.map((check) => ({
      name: check?.name,
      passed: check?.passed,
      evidence_event_indices: Array.isArray(check?.evidence_event_indices) ? [...check.evidence_event_indices] : check?.evidence_event_indices,
    })),
    reason: null,
  };
}

function buildGradingSummary(record) {
  return {
    schema: 1,
    success: summarizeBooleanMetric(record.success),
    expected_outcome_matched: summarizeBooleanMetric(record.expected_outcome_matched),
    grading_checks: summarizeGradingChecks(record.grading_checks),
  };
}

function validateGradingSummaryMetric(metric, fieldPrefix, errors, kind) {
  if (metric == null || typeof metric !== 'object' || Array.isArray(metric)) {
    errors.push({ field: fieldPrefix, message: 'must be a {value, reason} object' });
    return;
  }
  const allowedKeys = new Set(GRADING_SUMMARY_METRIC_FIELDS);
  for (const k of Object.keys(metric)) {
    if (!allowedKeys.has(k)) errors.push({ field: `${fieldPrefix}.${k}`, message: 'unrecognized field' });
  }
  for (const k of allowedKeys) {
    if (!(k in metric)) errors.push({ field: `${fieldPrefix}.${k}`, message: 'missing required field' });
  }
  if (metric.value === null) {
    if (!GRADING_SUMMARY_REASON_VALUES.includes(metric.reason)) {
      errors.push({ field: `${fieldPrefix}.reason`, message: `must be one of ${GRADING_SUMMARY_REASON_VALUES.join('|')} when value is null` });
    }
    return;
  }
  if (metric.reason !== null) {
    errors.push({ field: `${fieldPrefix}.reason`, message: 'must be null when value is present' });
  }
  if (kind === 'boolean' && typeof metric.value !== 'boolean') {
    errors.push({ field: `${fieldPrefix}.value`, message: 'must be a boolean or null' });
  } else if (kind === 'checks') {
    if (!Array.isArray(metric.value)) {
      errors.push({ field: `${fieldPrefix}.value`, message: 'must be an array of grading check summaries or null' });
      return;
    }
    const seen = new Set();
    const allowedCheckKeys = new Set(GRADING_SUMMARY_CHECK_FIELDS);
    for (const [i, check] of metric.value.entries()) {
      const checkPrefix = `${fieldPrefix}.value[${i}]`;
      if (check == null || typeof check !== 'object' || Array.isArray(check)) {
        errors.push({ field: checkPrefix, message: 'must be an object' });
        continue;
      }
      for (const k of Object.keys(check)) {
        if (!allowedCheckKeys.has(k)) errors.push({ field: `${checkPrefix}.${k}`, message: 'unrecognized field -- no detail/free text is allowed in committed rejection diagnostics' });
      }
      for (const k of allowedCheckKeys) {
        if (!(k in check)) errors.push({ field: `${checkPrefix}.${k}`, message: 'missing required field' });
      }
      if (typeof check.name !== 'string' || !GRADING_CHECK_NAMES.includes(check.name)) {
        errors.push({ field: `${checkPrefix}.name`, message: `must be one of ${GRADING_CHECK_NAMES.join('|')}` });
      } else if (seen.has(check.name)) {
        errors.push({ field: `${checkPrefix}.name`, message: `duplicate grading check '${check.name}'` });
      } else {
        seen.add(check.name);
      }
      if (typeof check.passed !== 'boolean') {
        errors.push({ field: `${checkPrefix}.passed`, message: 'must be a boolean' });
      }
      if (!Array.isArray(check.evidence_event_indices) || check.evidence_event_indices.some((x) => !(Number.isInteger(x) && x >= 0))) {
        errors.push({ field: `${checkPrefix}.evidence_event_indices`, message: 'must be an array of non-negative integers' });
      }
    }
    for (const name of GRADING_CHECK_NAMES) {
      if (!seen.has(name)) errors.push({ field: `${fieldPrefix}.value`, message: `missing grading check '${name}'` });
    }
  }
}

function validateGradingSummary(summary, fieldPrefix) {
  const errors = [];
  if (summary == null || typeof summary !== 'object' || Array.isArray(summary)) {
    errors.push({ field: fieldPrefix, message: 'must be an object' });
    return errors;
  }
  const allowedKeys = new Set(GRADING_SUMMARY_FIELDS);
  for (const k of Object.keys(summary)) {
    if (!allowedKeys.has(k)) errors.push({ field: `${fieldPrefix}.${k}`, message: 'unrecognized field' });
  }
  for (const k of allowedKeys) {
    if (!(k in summary)) errors.push({ field: `${fieldPrefix}.${k}`, message: 'missing required field' });
  }
  if (summary.schema !== 1) errors.push({ field: `${fieldPrefix}.schema`, message: 'must be exactly 1' });
  validateGradingSummaryMetric(summary.success, `${fieldPrefix}.success`, errors, 'boolean');
  validateGradingSummaryMetric(summary.expected_outcome_matched, `${fieldPrefix}.expected_outcome_matched`, errors, 'boolean');
  validateGradingSummaryMetric(summary.grading_checks, `${fieldPrefix}.grading_checks`, errors, 'checks');
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
 * Scoped to `unexpected_tools` (closed per-entry shape) and `transcript_filename` (must look like,
 * AND actually correspond to, what deriveTranscriptFilename produces for that cell's own run_id).
 * `foreign_skill_names`'s own pre-existing shape is left exactly as it was, unchanged.
 *
 * Post-open-PR review finding ("la cadena de custodia del transcript aún puede quedar
 * incoherente"): the pre-fix version only checked transcript_filename's SHAPE (the regex), never
 * that the 64-hex-char portion was genuinely sha256(run_id) for THAT cell -- reproduced directly:
 * a filename `0-<64 zero-chars>.jsonl` attached to run_id:"a" passed this check unmodified, even
 * though `deriveTranscriptFilename(0, "a")` never produces that hash. A diagnostic could silently
 * claim a transcript belonged to a cell it didn't. Closed by reconstructing the EXPECTED filename
 * via the same canonical deriveTranscriptFilename this module uses everywhere else (never a
 * second, independently-maintained hash check), and by reusing validateCaptureOrdinalSet to also
 * confirm the ordinals across all of a diagnostic's cells form the exact contiguous {0..N-1} range
 * -- the SAME definition of "valid ordinal set" buildRejectionDiagnostics/
 * writeRejectionRawTranscripts enforce at construction time, checked again here at rest, since
 * writeRejectedRunDiagnostics accepts a hand-built {committed, local} pair from any source.
 * Deliberately does NOT check cells[].run_id for cross-cell duplicates itself (that is
 * validateRejectionRow's own, pre-existing job for the committed tier, which the two tiers already
 * share via assertUnexpectedToolCoherence's run_id-per-index alignment) -- a duplicate run_id
 * still fails closed here too (it collapses the ordinal set below the cells count), just via the
 * ordinal-range error rather than a dedicated duplicate-run_id message.
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
  const filenameRe = /^(\d+)-([0-9a-f]{64})\.jsonl$/;
  const capturedOrdinalByRunId = {};
  const runIdsWithVerifiedFilename = [];
  for (const [i, cell] of local.cells.entries()) {
    if (cell == null || typeof cell !== 'object' || Array.isArray(cell)) {
      errors.push({ field: `cells[${i}]`, message: 'must be an object' });
      continue;
    }
    errors.push(...validateUnexpectedTools(cell.unexpected_tools, `cells[${i}].unexpected_tools`));
    const filenameMatch = typeof cell.transcript_filename === 'string' ? cell.transcript_filename.match(filenameRe) : null;
    if (!filenameMatch) {
      errors.push({ field: `cells[${i}].transcript_filename`, message: 'must match the pattern <captureOrdinal>-<64 hex chars>.jsonl' });
      continue;
    }
    if (typeof cell.run_id !== 'string' || cell.run_id.length === 0) {
      errors.push({ field: `cells[${i}].transcript_filename`, message: 'cannot verify correspondence with run_id -- cells[i].run_id is missing or not a non-empty string' });
      continue;
    }
    const claimedOrdinal = Number(filenameMatch[1]);
    let expectedFilename;
    try {
      expectedFilename = deriveTranscriptFilename(claimedOrdinal, cell.run_id);
    } catch (err) {
      errors.push({ field: `cells[${i}].transcript_filename`, message: `cannot verify correspondence with run_id: ${err.message}` });
      continue;
    }
    if (cell.transcript_filename !== expectedFilename) {
      errors.push({ field: `cells[${i}].transcript_filename`, message: `does not correspond to this cell's own run_id -- expected ${expectedFilename} (the SAME derivation deriveTranscriptFilename uses everywhere else), got ${cell.transcript_filename}` });
      continue;
    }
    capturedOrdinalByRunId[cell.run_id] = claimedOrdinal;
    runIdsWithVerifiedFilename.push(cell.run_id);
  }
  // Only meaningful once every cell's own filename is individually verified correct -- avoids
  // cascading a second, redundant error on top of whatever the per-cell loop already reported.
  if (local.cells.length > 0 && runIdsWithVerifiedFilename.length === local.cells.length) {
    try {
      validateCaptureOrdinalSet(capturedOrdinalByRunId, runIdsWithVerifiedFilename, 'validateRejectionLocalRow');
    } catch (err) {
      errors.push({ field: 'cells', message: err.message });
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
      if ((row.schema === REJECTION_DIAGNOSTICS_SCHEMA_V3 || row.schema === REJECTION_DIAGNOSTICS_SCHEMA_V4 || row.schema === REJECTION_DIAGNOSTICS_SCHEMA_V5 || row.schema === REJECTION_DIAGNOSTICS_SCHEMA_V6 || row.schema === REJECTION_DIAGNOSTICS_SCHEMA_V7 || row.schema === REJECTION_DIAGNOSTICS_SCHEMA_V8 || row.schema === REJECTION_DIAGNOSTICS_SCHEMA_V9) && row.matrix_complete === false) {
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
 * check the "preserve rejected matrix forensics" fix added; schema:4+ rows get the
 * policy_mode:"not_applicable"-exclusive fields (execution_profile_id/policy_mode/
 * isolation_attestation_sha256), schema:5+ rows get closed per-cell observability, and schema:6
 * rows get closed pre-inference summaries. Not-applicable schemas require policy_sha256 to be
 * exactly null rather than a real hash. Closed key sets at EVERY nesting level (top-level, each
 * cells[] entry, both foreign_skill_summary objects) for whichever schema applies. Also enforces: cells[].run_id
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
  const isV3 = row.schema === REJECTION_DIAGNOSTICS_SCHEMA_V3;
  const isV4 = row.schema === REJECTION_DIAGNOSTICS_SCHEMA_V4;
  const isV5 = row.schema === REJECTION_DIAGNOSTICS_SCHEMA_V5;
  const isV6 = row.schema === REJECTION_DIAGNOSTICS_SCHEMA_V6;
  const isV7 = row.schema === REJECTION_DIAGNOSTICS_SCHEMA_V7;
  const isV8 = row.schema === REJECTION_DIAGNOSTICS_SCHEMA_V8;
  const isV9 = row.schema === REJECTION_DIAGNOSTICS_SCHEMA_V9;
  const isV5OrLater = isV5 || isV6 || isV7 || isV8 || isV9;
  const isV3OrLater = isV3 || isV4 || isV5 || isV6 || isV7 || isV8 || isV9;
  const isNotApplicableSchema = isV4 || isV5 || isV6 || isV7 || isV8 || isV9;
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
  // policy_sha256: a real hash for every policy-required batch (v2, v3, and any future
  // policy-required schema), but EXACTLY null for a schema:4/5 (policy_mode:"not_applicable") batch
  // -- no policy hook ever governed it, so a real-looking hash there would misrepresent what
  // actually happened. Never converted to "", 0, a synthetic hash, or any other sentinel.
  if (isNotApplicableSchema) {
    if (row.policy_sha256 !== null) {
      errors.push({ field: 'policy_sha256', message: `must be exactly null for schema:${row.schema} (policy_mode:"not_applicable" -- no policy hook ever governed this batch)` });
    }
  } else if (typeof row.policy_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.policy_sha256)) {
    errors.push({ field: 'policy_sha256', message: 'must be a lowercase 64-char hex SHA-256 string' });
  }

  // Schema 4/5-only top-level fields: exclusive to the policy_mode:"not_applicable" shape. Never
  // checked for v2/v3 here -- rejectionCanonicalFieldsFor/the closed-key loop above already
  // enforces that a v2/v3 row must NOT carry them (they are simply absent from those field lists).
  if (isNotApplicableSchema) {
    if (typeof row.execution_profile_id !== 'string' || !EXECUTION_PROFILE_ID_RE.test(row.execution_profile_id)) {
      errors.push({ field: 'execution_profile_id', message: `must be a non-empty lowercase id matching ${EXECUTION_PROFILE_ID_RE}` });
    }
    if (row.policy_mode !== 'not_applicable') {
      errors.push({ field: 'policy_mode', message: `must be exactly "not_applicable" for schema:${row.schema}` });
    }
    if (typeof row.isolation_attestation_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.isolation_attestation_sha256)) {
      errors.push({ field: 'isolation_attestation_sha256', message: 'must be a lowercase 64-char hex SHA-256 string' });
    }
  }

  // Schema 3/4/5 top-level fields: matrix_complete/planned_cell_count/executed_cell_count/
  // raw_transcripts_persisted. Gated on isV3OrLater -- a schema:2 row (including the two preserved
  // incident files) never has these keys at all, and rejectionCanonicalFieldsFor/the closed-key
  // loop above already enforces that a v2 row must NOT carry them. Schema 4 inherits this whole
  // block from schema 3 unchanged -- fail-fast partial-matrix support is orthogonal to policy_mode.
  if (isV3OrLater) {
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

      // Schema 3/4/5 per-cell field: unexpected_tool_uses_count, plus the single most important
      // invariant this whole fix adds -- a strict BICONDITIONAL with failed_checks containing
      // 'noUnexpectedToolsOk'. noUnexpectedToolsOk is defined (cell-integrity.mjs) as exactly
      // `findUnexpectedToolUses(...).length === 0`, and this count IS that same `.length` --
      // so the check fails if and only if the count is > 0. This is what makes "a rejection
      // attributed to noUnexpectedToolsOk that records zero unexpected tools anywhere" -- the
      // precise, unrecoverable shape of the 2026-08 canary incident -- structurally impossible to
      // write ever again.
      if (isV3OrLater) {
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
      if (isV5OrLater) {
        if (!Array.isArray(cell.record_error_codes) || cell.record_error_codes.some((code) => typeof code !== 'string' || !/^[a-z][a-z0-9_]*$/.test(code))) {
          errors.push({ field: `cells[${i}].record_error_codes`, message: 'must be an array of closed lowercase snake_case error-code strings' });
        } else if (new Set(cell.record_error_codes).size !== cell.record_error_codes.length || JSON.stringify([...cell.record_error_codes].sort()) !== JSON.stringify(cell.record_error_codes)) {
          errors.push({ field: `cells[${i}].record_error_codes`, message: 'must be sorted and unique for canonical committed diagnostics' });
        }
        const correlationValidation = validateCorrelationObservability(cell.correlation_observability);
        if (!correlationValidation.ok) {
          errors.push({ field: `cells[${i}].correlation_observability`, message: `must match correlation-observability schema v1 (${JSON.stringify(correlationValidation.errors)})` });
        } else {
          if (cell.correlation_observability.condition !== cell.condition) {
            errors.push({ field: `cells[${i}].correlation_observability.condition`, message: 'must match the rejection cell condition exactly' });
          }
          if (cell.correlation_observability.policy_mode !== row.policy_mode) {
            errors.push({ field: `cells[${i}].correlation_observability.policy_mode`, message: 'must match the rejection batch policy_mode exactly' });
          }
        }
      }
      if (isV6 || isV7 || isV8 || isV9) {
        errors.push(...validatePreInferenceFailureSummary(cell.pre_inference_failure, `cells[${i}].pre_inference_failure`, cell.failed_checks, isV9 ? [2] : [1]));
      }
      if (isV7 || isV8 || isV9) {
        errors.push(...validateCellMetrics(cell.cell_metrics, `cells[${i}].cell_metrics`));
      }
      if (isV8 || isV9) {
        errors.push(...validateGradingSummary(cell.grading_summary, `cells[${i}].grading_summary`));
      }
    }
    if (!anyCellHasFailedCheck) {
      errors.push({ field: 'cells', message: 'at least one cell must have a non-empty failed_checks -- a rejection diagnostic with no recorded failure anywhere is not a real rejection' });
    }
    if (isV3OrLater && Number.isInteger(row.executed_cell_count) && row.executed_cell_count !== row.cells.length) {
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
 * how each run_kind maps its own shape into the uniform inputs here. Constructs schema
 * REJECTION_DIAGNOSTICS_SCHEMA_V9 when every record in the batch is schema>=6 with
 * execution_profile.policy_mode==="not_applicable" (see the dispatch this function runs, right
 * after the existing BATCH_WIDE_FIELDS agreement check, for the exact rule -- NEVER
 * LATEST_REJECTION_DIAGNOSTICS_SCHEMA used as that selector), REJECTION_DIAGNOSTICS_SCHEMA_V3
 * otherwise (every policy-required or pre-schema-6 batch, unchanged from before) -- see
 * validateRejectionRow for why schema:2/4/5 are still ACCEPTED (never built) by this module.
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
 * @param {Record<string, object>|null} [correlationObservabilityByRunId] - run_id -> the
 *   correlation-observability schema v1 count-only projection already produced by matrix-runner.
 *   Required, exact-set, for schema:5. Never contains tool ids, commands, transcript content,
 *   paths, prompts, responses, or timestamps.
 * @param {Record<string, object>|null} [preInferenceFailureByRunId] - run_id -> the
 *   pre-inference terminal summary produced from the canonical condition observation. Required,
 *   exact-set, for schema:6. Never contains final text, prompts, responses, paths, commands,
 *   tool ids, or timestamps.
 * @param {Record<string, object>|null} [cellMetricsByRunId] - run_id -> exact, privacy-safe
 *   timing/usage/token/tool-count projection from the already-built run record. Required,
 *   exact-set, for schema:7+ emitted not_applicable diagnostics. Never contains prompts, responses, paths, commands, tool ids, or
 *   transcript content.
 * @param {Record<string, number>} captureOrdinalByRunId - run_id -> a non-negative integer
 *   execution-position ordinal used to derive that cell's transcript_filename via
 *   deriveTranscriptFilename. Required, exact-set of run_ids, and the value set must form the
 *   exact contiguous range {0..N-1} (validateCaptureOrdinalSet), never merely unique.
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
  correlationObservabilityByRunId = null, preInferenceFailureByRunId = null,
  cellMetricsByRunId = null,
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
  // Post-open-PR review finding: this used to be a bespoke, weaker check (requireExactRunIdKeys
  // for the key-set, then non-negative-integer + pairwise-unique for the values) that silently
  // tolerated a gap -- see validateCaptureOrdinalSet's own doc comment for the reproduced case.
  validateCaptureOrdinalSet(captureOrdinalByRunId, records.map((r) => r.run_id), 'buildRejectionDiagnostics');

  if (typeof rawTranscriptsPersisted !== 'boolean') {
    throw new Error(`buildRejectionDiagnostics: rawTranscriptsPersisted is required and must be a boolean, got ${JSON.stringify(rawTranscriptsPersisted)}`);
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

  // Schema dispatch (sandboxed-unrestricted-v1 rejection support) -- explicit, never
  // LATEST_REJECTION_DIAGNOSTICS_SCHEMA as a selector, exactly the "expectedXFor" pattern
  // accepted-run-audit.mjs's own PR 4 already established for the accepted-sidecar side of this
  // same feature. One harness invocation always resolves exactly one execution profile for its
  // whole batch, so every record must agree on execution_profile.policy_mode -- a record whose own
  // schema is <6 (no execution_profile concept at all) reads as its own distinct sentinel here, so
  // a schema<6/schema>=6 mix is caught by this SAME agreement check rather than silently building
  // v3 from a heterogeneous batch. A genuine disagreement can only ever be a caller-assembled
  // inconsistency (never a real production shape) and fails closed with a specific reason, rather
  // than silently degrading to schema 3 -- which would then also reject the batch's own honestly-
  // null policy_sha256.
  const policyModes = new Set(records.map((r) => (r.schema >= 6 ? r.execution_profile?.policy_mode : 'schema-pre-v6')));
  if (policyModes.size !== 1) {
    throw new Error(`buildRejectionDiagnostics: records disagree on execution_profile.policy_mode (${JSON.stringify([...policyModes])}) -- one harness invocation always resolves exactly one execution profile for its whole batch`);
  }
  const buildingNotApplicable = [...policyModes][0] === 'not_applicable';
  const schema = buildingNotApplicable ? REJECTION_DIAGNOSTICS_SCHEMA_V9 : REJECTION_DIAGNOSTICS_SCHEMA_V3;
  if (schema === REJECTION_DIAGNOSTICS_SCHEMA_V9) {
    requireExactRunIdKeys(correlationObservabilityByRunId, 'correlationObservabilityByRunId');
    requireExactRunIdKeys(preInferenceFailureByRunId, 'preInferenceFailureByRunId');
    requireExactRunIdKeys(cellMetricsByRunId, 'cellMetricsByRunId');
    for (const [runId, summary] of Object.entries(correlationObservabilityByRunId)) {
      const validation = validateCorrelationObservability(summary);
      if (!validation.ok) {
        throw new Error(`buildRejectionDiagnostics: correlationObservabilityByRunId['${runId}'] must be a valid correlation-observability schema v1 object (${JSON.stringify(validation.errors)})`);
      }
    }
    for (const [runId, summary] of Object.entries(preInferenceFailureByRunId)) {
      const errors = validatePreInferenceFailureSummary(summary, `preInferenceFailureByRunId['${runId}']`, failedChecksByRunId[runId] ?? [], [2]);
      if (errors.length > 0) {
        throw new Error(`buildRejectionDiagnostics: preInferenceFailureByRunId['${runId}'] must be a valid pre-inference-failure schema v2 object (${JSON.stringify(errors)})`);
      }
    }
    for (const [runId, metrics] of Object.entries(cellMetricsByRunId)) {
      const errors = validateCellMetrics(metrics, `cellMetricsByRunId['${runId}']`);
      if (errors.length > 0) {
        throw new Error(`buildRejectionDiagnostics: cellMetricsByRunId['${runId}'] must be a valid cell-metrics schema v1 object (${JSON.stringify(errors)})`);
      }
    }
  }

  // v4-only batch-wide fields -- copied EXCLUSIVELY from records[].execution_profile (never
  // consulted from a live registry, never derived from policy_sha256:null, never accepted as a
  // parallel, independently-controllable caller parameter that could drift from what the records
  // themselves actually carry). Batch-wide agreement is proven the SAME way as BATCH_WIDE_FIELDS
  // above -- a mismatch fails closed with a specific reason, never silently picks the first value.
  let executionProfileBatchWide = {};
  if (buildingNotApplicable) {
    const profileIds = new Set(records.map((r) => r.execution_profile.id));
    if (profileIds.size !== 1) {
      throw new Error(`buildRejectionDiagnostics: records disagree on execution_profile.id (${JSON.stringify([...profileIds])}) within one not_applicable batch`);
    }
    const attestationHashes = new Set(records.map((r) => r.execution_profile.isolation_attestation_sha256));
    if (attestationHashes.size !== 1) {
      throw new Error(`buildRejectionDiagnostics: records disagree on execution_profile.isolation_attestation_sha256 (${JSON.stringify([...attestationHashes])}) within one not_applicable batch`);
    }
    const [attestationSha256] = attestationHashes;
    if (typeof attestationSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(attestationSha256)) {
      throw new Error(`buildRejectionDiagnostics: execution_profile.isolation_attestation_sha256 must be a real 64-hex-char string for a not_applicable batch, got ${JSON.stringify(attestationSha256)}`);
    }
    executionProfileBatchWide = {
      execution_profile_id: [...profileIds][0],
      policy_mode: 'not_applicable',
      isolation_attestation_sha256: attestationSha256,
    };
  }

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
    ...(schema === REJECTION_DIAGNOSTICS_SCHEMA_V9 ? {
      record_error_codes: [...new Set((r.errors ?? []).map((e) => e?.code).filter((code) => typeof code === 'string' && code.length > 0))].sort(),
      correlation_observability: JSON.parse(JSON.stringify(correlationObservabilityByRunId[r.run_id])),
      pre_inference_failure: JSON.parse(JSON.stringify(preInferenceFailureByRunId[r.run_id])),
      cell_metrics: JSON.parse(JSON.stringify(cellMetricsByRunId[r.run_id])),
      grading_summary: buildGradingSummary(r),
    } : {}),
  }));

  const foreignSkillSummary = { rejected: 0, confirmed: 0, incomplete: 0 };
  for (const cell of cells) {
    foreignSkillSummary.rejected += cell.foreign_skill_summary.rejected;
    foreignSkillSummary.confirmed += cell.foreign_skill_summary.confirmed;
    foreignSkillSummary.incomplete += cell.foreign_skill_summary.incomplete;
  }

  const committed = {
    schema,
    rejection_id: rejectionId,
    timestamp: new Date().toISOString(),
    run_kind: runKind,
    run_ids: cells.map((c) => c.run_id),
    ...committedBatchWide,
    ...executionProfileBatchWide,
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
 *   position, assigned by the caller from actual execution order -- MUST have exactly the same key
 *   set as transcriptsByRunId, and its values MUST form the exact contiguous set {0..N-1} (enforced
 *   by validateCaptureOrdinalSet), never merely unique. Never the schema's own `order_index` field.
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
  const runIds = [...new Set(Object.keys(transcriptsByRunId))];
  // Post-open-PR review finding: this used to be a bespoke, weaker check (its own key-set
  // comparison, then non-negative-integer + pairwise-unique for the values) that silently
  // tolerated a gap -- see validateCaptureOrdinalSet's own doc comment for the reproduced case.
  validateCaptureOrdinalSet(captureOrdinalByRunId, runIds, 'refusing to write raw transcripts');
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
    // Purely additive (decision 3/N -- the journal's exact-correspondence discard check):
    // enumerates exactly what was actually written, reusing data this function already computed
    // per run_id above -- never a second pass, never a re-read off disk. A caller can compare this
    // against a journal's own raw_persisted cellOrdinal set without trusting a bare boolean flag.
    rawTranscriptsManifest: runIds.map((id) => ({
      run_id: id,
      capture_ordinal: captureOrdinalByRunId[id],
      filename: deriveTranscriptFilename(captureOrdinalByRunId[id], id),
    })),
  };
}

/**
 * Sibling of deriveTranscriptFilename, same safe ordinal+hash(run_id) derivation, own extension --
 * `.jsonl` (deriveTranscriptFilename's own suffix) mislabels free-text stderr as JSON-lines
 * content; this never reuses that function, it reuses only the derivation LOGIC.
 */
export function deriveStderrFilename(captureOrdinal, runId) {
  if (!(Number.isInteger(captureOrdinal) && captureOrdinal >= 0)) {
    throw new Error(`deriveStderrFilename: captureOrdinal must be a non-negative integer, got ${JSON.stringify(captureOrdinal)}`);
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('deriveStderrFilename: runId must be a non-empty string');
  }
  const hash = createHash('sha256').update(runId, 'utf8').digest('hex');
  return `${captureOrdinal}-${hash}.stderr.txt`;
}

/**
 * Transaction 3 of a rejection's forensics (sibling of writeRejectionRawTranscripts, never a
 * modification of it) -- persists each rejected cell's already-redacted stderr to its own tier,
 * `raw/stderr/<rejection_id>/...`, the exact sibling of `raw/transcripts/<rejection_id>/...`.
 *
 * `stderrByRunId` values are REQUIRED strings (never `?? ''`) -- a missing/wrong-type entry is a
 * structural failure (thrown), never silently treated as an empty-but-legitimate stderr. Each
 * value is re-verified against the privacy pipeline before writing (defense in depth over the
 * ALREADY-redacted value the caller reads back from the journal, never a first redaction pass
 * here): if this second pass would change the value, the input was never actually clean, so this
 * refuses rather than silently persisting a further-transformed string.
 *
 * `byte_length`/`sha256` in the returned manifest are computed from a REREAD of what actually
 * landed on disk, never the in-memory string -- the same discipline persistSpawnOutcome (the
 * journal's own stderr tier) uses, so a later correspondence check can detect a truncation/
 * corruption that happened during or after either write.
 * @param {string} rejectionId
 * @param {Record<string,string>} stderrByRunId
 * @param {Record<string,number>} captureOrdinalByRunId
 * @param {{runsRootOverride?: string, privatePatternsFile?: string}} [opts]
 */
export function writeRejectionRawStderr(rejectionId, stderrByRunId, captureOrdinalByRunId, { runsRootOverride, privatePatternsFile } = {}) {
  if (typeof rejectionId !== 'string' || !UUID_RE.test(rejectionId)) {
    throw new Error(`refusing to write raw stderr: rejectionId must be a full UUID string, got ${JSON.stringify(rejectionId)}`);
  }
  if (stderrByRunId == null || typeof stderrByRunId !== 'object' || Array.isArray(stderrByRunId)) {
    throw new Error('refusing to write raw stderr: stderrByRunId is required and must be an object keyed by run_id');
  }
  const runIds = [...new Set(Object.keys(stderrByRunId))];
  validateCaptureOrdinalSet(captureOrdinalByRunId, runIds, 'refusing to write raw stderr');
  for (const id of runIds) {
    if (typeof stderrByRunId[id] !== 'string') {
      throw new Error(`refusing to write raw stderr: stderrByRunId['${id}'] must be a string (the cell's already-redacted stderr; '' is legitimate, missing/undefined is not), got ${typeof stderrByRunId[id]}`);
    }
  }

  const outDir = resolveRejectedDiagnosticsDir(runsRootOverride);
  const stderrRootDir = join(outDir, 'raw', 'stderr', rejectionId);
  if (!isRawDirSafeFromAccidentalCommit(stderrRootDir, runsRootOverride)) {
    throw new Error(`refusing to write raw stderr: ${stderrRootDir} is inside this repo's worktree but not covered by .gitignore -- would risk an accidental commit of raw stderr text`);
  }

  const verifiedByRunId = {};
  for (const id of runIds) {
    const { ok, redacted } = redactAndVerify(stderrByRunId[id], { privatePatternsFile });
    if (!ok || redacted !== stderrByRunId[id]) {
      throw new Error(`refusing to write raw stderr for run_id '${id}': re-verification found the already-redacted value was not byte-identical (possible incomplete redaction upstream)`);
    }
    verifiedByRunId[id] = redacted;
  }

  const targets = runIds.map((id) => [join(stderrRootDir, deriveStderrFilename(captureOrdinalByRunId[id], id)), verifiedByRunId[id]]);
  promoteTargetsAtomically(targets, stderrRootDir);

  const stderrManifest = runIds.map((id) => {
    const filename = deriveStderrFilename(captureOrdinalByRunId[id], id);
    const onDisk = readFileSync(join(stderrRootDir, filename), 'utf8');
    return {
      run_id: id, capture_ordinal: captureOrdinalByRunId[id], filename,
      byte_length: Buffer.byteLength(onDisk, 'utf8'),
      sha256: createHash('sha256').update(onDisk, 'utf8').digest('hex'),
    };
  });

  return {
    stderrDir: stderrRootDir,
    stderrRelativeDir: join('agentic-eval-rejected', 'raw', 'stderr', rejectionId),
    stderrManifest,
    stderrCount: runIds.length,
  };
}

/**
 * Reads a rejected cell's own already-persisted stderr back, for the discard-time content
 * correspondence check (cli.mjs's journalStderrExactlyMatchesRejectionManifest). The filename is
 * ALWAYS derived internally from (captureOrdinal, runId) -- this function never accepts a raw
 * filename/path fragment as input, so a manifest entry's own (untrusted) `filename` field can
 * never participate in constructing the read path. Even though deriveStderrFilename's hash-based
 * output already makes traversal impossible by construction, the resolved path is additionally
 * confirmed to stay within stderrRootDir before reading -- the same defense-in-depth discipline
 * durable-journal.mjs's readRawFor uses, closing the exact bug class a crafted cellOrdinal once
 * exploited there.
 * @returns {string|null} the raw stderr text, or `null` if it was never persisted
 */
export function readRejectionStderrFile(rejectionId, captureOrdinal, runId, { runsRootOverride } = {}) {
  if (typeof rejectionId !== 'string' || !UUID_RE.test(rejectionId)) {
    throw new Error('readRejectionStderrFile: rejectionId must be a full UUID string');
  }
  const outDir = resolveRejectedDiagnosticsDir(runsRootOverride);
  const stderrRootDir = join(outDir, 'raw', 'stderr', rejectionId);
  const filename = deriveStderrFilename(captureOrdinal, runId); // throws on invalid captureOrdinal/runId
  const resolvedTarget = resolve(join(stderrRootDir, filename));
  const resolvedRoot = resolve(stderrRootDir);
  if (!resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new Error('readRejectionStderrFile: resolved path escapes the expected rejection stderr directory');
  }
  if (!existsSync(resolvedTarget)) return null;
  return readFileSync(resolvedTarget, 'utf8');
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

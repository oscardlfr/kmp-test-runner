#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/campaign-summary.mjs -- campaign-level (runtime x arm) summary over a
// completed live campaign directory: `<campaign-dir>/manifest.json` +
// `<campaign-dir>/private/<runtime>-<round>/{record,audit,rejection}.json` (confirmed against a
// real committed campaign directory, not assumed from the PowerShell finalizer's own doc comments
// alone).
//
// Deliberately does NOT reuse analysis.mjs's analyzeRunsDir/validateRunRecordFile: those resolve
// the audit sidecar via record.accepted_audit.relative_path under the flat
// `tools/runs/<kind>/audit/<run_id>.json` convention (schemas.mjs enforces that path shape), but a
// campaign cell's real audit file is flat -- literally named `audit.json`, beside `record.json`,
// no `audit/` subdirectory. This module has its own loader for that reason, composed from the
// same pure validators analyzeRunsDir itself uses underneath (validateRun, schemas.mjs;
// validateAcceptedRunAuditSidecar/crossValidateAcceptedRunAuditAgainstRecord,
// accepted-run-audit.mjs -- none of the three touch the filesystem) plus analysis.mjs's own
// exported analyzeRunRecord/summarizeNumericValues/buildTaskFieldCorrectness for the actual
// per-cell metrics, never re-derived by hand.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { validateRun } from './schemas.mjs';
import { validateAcceptedRunAuditSidecar, crossValidateAcceptedRunAuditAgainstRecord } from './accepted-run-audit.mjs';
import { analyzeRunRecord, summarizeNumericValues, buildTaskFieldCorrectness } from './analysis.mjs';
import { MULTI_MODULE_TASK_FIELD_VALUES } from './outcome-assessment-contract.mjs';

// Schema 2 (Evidence2): adds provenance.reasoning_effort, a per-runtime {values, mixed} tracker
// sourced from each accepted cell's own reasoning_effort_requested (schema v9 recording field) --
// same shape and the same runtime_cli_version/model_resolved pattern already established below.
// readme-evidence.mjs's validateSummary already accepts both 1 and 2 and requires the 3 per-runtime
// provenance groups (runtime_cli_version/model_resolved/reasoning_effort) only from schema 2 on.
export const CAMPAIGN_SUMMARY_SCHEMA = 2;

// D3 (placed here rather than
// at the integrity layer -- a rejected Codex cell abandoning an in-flight command at turn end is
// honest agent/runtime behavior, not a capture defect, and must count as a real negative
// observation in its arm's denominator rather than being discarded as missing data). Every one of
// these five conditions is required; verified against the real 689b7772/codex-cli-3 rejection.json.
const D3_ALLOWED_FAILED_CHECKS = new Set(['hookAccountingOk', 'toolResultsCompleteOk']);

function isSubsetOfAllowedFailedChecks(failedChecks) {
  return Array.isArray(failedChecks) && failedChecks.length > 0
    && failedChecks.every((check) => D3_ALLOWED_FAILED_CHECKS.has(check));
}

function qualifiesForD3NegativeReclassification(runtimeId, rejectionCell) {
  if (runtimeId !== 'codex-cli') return false;
  if (!isSubsetOfAllowedFailedChecks(rejectionCell?.failed_checks)) return false;
  const missing = rejectionCell?.correlation_observability?.missing_result_counts_by_kind;
  if (missing == null || typeof missing !== 'object') return false;
  if (!(Number.isInteger(missing.shell) && missing.shell >= 1)) return false;
  if (missing.skill !== 0 || missing.other !== 0) return false;
  const issues = rejectionCell?.correlation_observability?.correlation_issue_counts;
  if (issues == null || typeof issues !== 'object') return false;
  if (Object.values(issues).some((count) => count !== 0)) return false;
  const pre = rejectionCell?.pre_inference_failure;
  if (pre == null || typeof pre !== 'object') return false;
  return pre.terminal_present === true && pre.terminal_result_subtype === 'success' && pre.terminal_is_error === false;
}

// D2: "key facts" is deliberately STRICT for this scenario -- all four fields must be exactly
// 'matched'. 'not-applicable' is never accepted here even though buildTaskFieldCorrectness can
// produce it: every one of these four fields genuinely applies to coverage_threshold_exceeded, so
// admitting 'not-applicable' would only ever open a loophole for a future scenario, never reflect
// a real exemption for this one. 'not-observed' (claim-missing) is also a miss, not a pass.
const KEY_FACTS_FIELDS = Object.freeze(['module', 'outcome_kind', 'missed_lines', 'threshold']);
// The multi-module-tests family answers with its own four fields (PLAN.md D4), so its key facts are those four,
// each exactly 'matched' by the same strict rule; every other family keeps KEY_FACTS_FIELDS above.
const KEY_FACTS_FIELDS_BY_FAMILY = Object.freeze({ 'multi-module-tests': MULTI_MODULE_TASK_FIELD_VALUES });

function isKeyFactsMatch(taskFieldCorrectness, family) {
  const fields = KEY_FACTS_FIELDS_BY_FAMILY[family] ?? KEY_FACTS_FIELDS;
  return taskFieldCorrectness != null && fields.every((field) => taskFieldCorrectness[field] === 'matched');
}

/** The family every accepted cell of this campaign agrees on, or null when none is accepted or they disagree.
 * A rejected cell carries no family of its own, and key facts of a D3-reclassified cell (no claim at all) are
 * false whichever field list applies; this only picks the list. */
function campaignFamilyOf(loadedCells) {
  const families = new Set(loadedCells.filter((c) => c.loaded.status === 'accepted').map((c) => c.loaded.record.family));
  return families.size === 1 ? [...families][0] : null;
}

function armFor(condition) {
  if (condition === 'current-skill') return 'product';
  if (condition === 'no-skill') return 'free';
  return null;
}

function blockCampaignIdsOf(manifest) {
  if (manifest.kind !== 'merged-blocks') return null;
  const ids = manifest.block_campaign_ids;
  return Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === 'string' && id !== '') ? ids : undefined;
}

/** The arm the design put at a position of the manifest's round_order ('product' or 'free'), or null when the manifest names none. */
function designArmAt(manifest, position) {
  const arm = Array.isArray(manifest.round_order) ? manifest.round_order[position] : undefined;
  return arm === 'product' || arm === 'free' ? arm : null;
}

function expectedCellsFromManifest(manifest) {
  const cells = [];
  for (const runtime of manifest.runtimes ?? []) {
    (runtime.campaign_cell_indices ?? []).forEach((roundIndex, position) => {
      cells.push({
        runtimeId: String(runtime.runtime_id), modelId: String(runtime.model_id),
        roundIndex: Number(roundIndex), cellKey: `${runtime.runtime_id}-${roundIndex}`,
        // What the design puts at this position, for a cell that leaves no record and no rejection to take an arm from.
        designArm: designArmAt(manifest, position),
      });
    });
  }
  return cells;
}

/** Reads and cross-validates one cell's on-disk pair/rejection. Never throws -- every failure
 * mode (absent directory, unrecognized shape, malformed JSON, a failed cross-validator, a
 * digest mismatch) returns `{status:'missing', reason}` instead, matching this whole module's
 * fail-closed, honest-about-gaps discipline. */
// The campaign's own private evidence directory can carry
// well-known evidence files this summarizer does not itself read -- transcript.jsonl
// (agentic-eval-accepted-raw-transcript / agentic-eval-rejected-raw-transcript, added post-hoc for
// infra-flake classification, which DOES require it directly at this same path) and incident.json
// (an incident diagnostic, when relevant). Both are tolerated alongside the required set below; any
// OTHER, unrecognized file still fails closed, with the exact offending name(s) in the reason, same
// discipline as every other shape check in this function.
const REQUIRED_CELL_FILES = new Set(['rejection.json', 'audit.json', 'record.json']);
const KNOWN_EXTRA_CELL_FILES = new Set(['transcript.jsonl', 'incident.json']);

function loadCell(privateRoot, cellKey) {
  const cellDir = join(privateRoot, cellKey);
  if (!existsSync(cellDir)) return { status: 'missing', reason: 'cell_directory_absent' };
  let allEntries;
  try {
    allEntries = readdirSync(cellDir).sort();
  } catch {
    return { status: 'missing', reason: 'cell_directory_unreadable' };
  }

  const unknownEntries = allEntries.filter((e) => !REQUIRED_CELL_FILES.has(e) && !KNOWN_EXTRA_CELL_FILES.has(e));
  if (unknownEntries.length > 0) {
    return { status: 'missing', reason: `cell_directory_unknown_file:${unknownEntries.join(',')}` };
  }
  const entries = allEntries.filter((e) => REQUIRED_CELL_FILES.has(e));

  if (entries.length === 1 && entries[0] === 'rejection.json') {
    let rejection;
    try {
      rejection = JSON.parse(readFileSync(join(cellDir, 'rejection.json'), 'utf8'));
    } catch {
      return { status: 'missing', reason: 'rejection_json_invalid' };
    }
    // Verified against a real per-cell rejection.json (689b7772/codex-cli-3): `cells` is an
    // array, exactly one entry for a single-cell rejection copy.
    if (!Array.isArray(rejection.cells) || rejection.cells.length !== 1) {
      return { status: 'missing', reason: 'rejection_malformed_cell_count' };
    }
    return { status: 'rejected', rejectionTop: rejection, rejectionCell: rejection.cells[0] };
  }

  if (entries.length === 2 && entries[0] === 'audit.json' && entries[1] === 'record.json') {
    let record;
    let audit;
    let auditRaw;
    try {
      auditRaw = readFileSync(join(cellDir, 'audit.json'), 'utf8');
      audit = JSON.parse(auditRaw);
      record = JSON.parse(readFileSync(join(cellDir, 'record.json'), 'utf8'));
    } catch {
      return { status: 'missing', reason: 'record_or_audit_json_invalid' };
    }

    const recordShape = validateRun(record);
    if (recordShape.errors.length > 0) return { status: 'missing', reason: 'record_shape_invalid' };
    // The record's family selects the final-answer vocabularies (the multi-module-tests family has its own).
    const auditShape = validateAcceptedRunAuditSidecar(audit, { family: record.family });
    if (auditShape.errors.length > 0) return { status: 'missing', reason: 'audit_shape_invalid' };
    const crossErrors = crossValidateAcceptedRunAuditAgainstRecord(audit, record);
    if (crossErrors.length > 0) return { status: 'missing', reason: 'record_audit_cross_validation_failed' };

    const auditSha = createHash('sha256').update(auditRaw, 'utf8').digest('hex');
    if (auditSha !== record.accepted_audit?.sha256) return { status: 'missing', reason: 'audit_digest_mismatch' };

    const analyzed = analyzeRunRecord(record, audit);
    if (!analyzed.ok) return { status: 'missing', reason: `analysis_failed:${analyzed.error}` };
    return { status: 'accepted', record, audit, entry: analyzed.entry };
  }

  return { status: 'missing', reason: 'cell_directory_shape_unrecognized' };
}

/** One distinct-value tracker for a single provenance field -- `values` is the sorted, deduped
 * set actually observed (never more than a handful in practice); `mixed` is true iff more than
 * one distinct value was seen, the signal a "mixed revisions" limitation line is built from. */
function newProvenanceTracker() {
  return { seen: new Set() };
}
function trackProvenance(tracker, value) {
  if (typeof value === 'string' && value.length > 0) tracker.seen.add(value);
}
function finalizeProvenance(tracker) {
  const values = [...tracker.seen].sort();
  return { values, mixed: values.length > 1 };
}

function buildProvenance(loadedCells) {
  const repoCommit = newProvenanceTracker();
  const skillSourceSha = newProvenanceTracker();
  const kmpTestCliVersion = newProvenanceTracker();
  const kmpTestCliSourceSha = newProvenanceTracker();
  const runtimeCliVersion = { 'claude-code': newProvenanceTracker(), 'codex-cli': newProvenanceTracker() };
  const modelResolved = { 'claude-code': newProvenanceTracker(), 'codex-cli': newProvenanceTracker() };
  // reasoning_effort_requested (schema v9) is a harness-computed recording field that exists only
  // on an accepted run RECORD -- rejection.json's own per-cell shape (rejectionCell) has no
  // equivalent, so unlike runtimeCliVersion/modelResolved above this tracker is accepted-cells-only,
  // honestly (never inferred for a rejected cell).
  const reasoningEffort = { 'claude-code': newProvenanceTracker(), 'codex-cli': newProvenanceTracker() };
  // reasoning_effort_source (same schema-v9 accepted-only shape as reasoning_effort_requested
  // above -- verified against a real record.json directly: the two are sibling fields on the same
  // object) -- e.g. "harness-pinned-cli-flag". Evidence2's own controls table names the source, not
  // just the requested value, so a reader can tell a pinned flag from a runtime default.
  const reasoningEffortSource = { 'claude-code': newProvenanceTracker(), 'codex-cli': newProvenanceTracker() };

  for (const cell of loadedCells) {
    if (cell.loaded.status === 'accepted') {
      const { record } = cell.loaded;
      trackProvenance(repoCommit, record.repo_commit);
      trackProvenance(skillSourceSha, record.skill_source_sha);
      trackProvenance(kmpTestCliVersion, record.kmp_test_cli_version);
      trackProvenance(kmpTestCliSourceSha, record.kmp_test_cli_source_sha);
      const bucket = runtimeCliVersion[cell.runtimeId];
      if (bucket) trackProvenance(bucket, record.agent_runtime?.cli_version);
      const modelBucket = modelResolved[cell.runtimeId];
      if (modelBucket) trackProvenance(modelBucket, record.agent_runtime?.model_resolved);
      const effortBucket = reasoningEffort[cell.runtimeId];
      if (effortBucket) trackProvenance(effortBucket, record.reasoning_effort_requested);
      const effortSourceBucket = reasoningEffortSource[cell.runtimeId];
      if (effortSourceBucket) trackProvenance(effortSourceBucket, record.reasoning_effort_source);
    } else if (cell.loaded.status === 'rejected') {
      const { rejectionTop, rejectionCell } = cell.loaded;
      trackProvenance(repoCommit, rejectionTop.repo_commit);
      trackProvenance(skillSourceSha, rejectionCell.skill_source_sha);
      // rejection-diagnostics.mjs's own schema names this field claude_code_version
      // unconditionally -- verified against a real Codex rejection (689b7772/codex-cli-3) that it
      // is populated there too, not Claude-specific despite the name. Read as-is; renaming it is
      // out of this plan's scope.
      const bucket = runtimeCliVersion[cell.runtimeId];
      if (bucket) trackProvenance(bucket, rejectionCell.claude_code_version);
      const modelBucket = modelResolved[cell.runtimeId];
      if (modelBucket) trackProvenance(modelBucket, rejectionCell.model_resolved);
    }
  }

  return {
    repo_commit: finalizeProvenance(repoCommit),
    skill_source_sha: finalizeProvenance(skillSourceSha),
    kmp_test_cli_version: finalizeProvenance(kmpTestCliVersion),
    kmp_test_cli_source_sha: finalizeProvenance(kmpTestCliSourceSha),
    runtime_cli_version: {
      'claude-code': finalizeProvenance(runtimeCliVersion['claude-code']),
      'codex-cli': finalizeProvenance(runtimeCliVersion['codex-cli']),
    },
    model_resolved: {
      'claude-code': finalizeProvenance(modelResolved['claude-code']),
      'codex-cli': finalizeProvenance(modelResolved['codex-cli']),
    },
    reasoning_effort: {
      'claude-code': finalizeProvenance(reasoningEffort['claude-code']),
      'codex-cli': finalizeProvenance(reasoningEffort['codex-cli']),
    },
    reasoning_effort_source: {
      'claude-code': finalizeProvenance(reasoningEffortSource['claude-code']),
      'codex-cli': finalizeProvenance(reasoningEffortSource['codex-cli']),
    },
  };
}

function provenanceLimitationLines(provenance) {
  const lines = [];
  const flat = [
    ['repo_commit', provenance.repo_commit], ['skill_source_sha', provenance.skill_source_sha],
    ['kmp_test_cli_version', provenance.kmp_test_cli_version], ['kmp_test_cli_source_sha', provenance.kmp_test_cli_source_sha],
    ['claude-code runtime CLI version', provenance.runtime_cli_version['claude-code']],
    ['codex-cli runtime CLI version', provenance.runtime_cli_version['codex-cli']],
    ['claude-code model_resolved', provenance.model_resolved['claude-code']],
    ['codex-cli model_resolved', provenance.model_resolved['codex-cli']],
    ['claude-code reasoning_effort', provenance.reasoning_effort['claude-code']],
    ['codex-cli reasoning_effort', provenance.reasoning_effort['codex-cli']],
    ['claude-code reasoning_effort_source', provenance.reasoning_effort_source['claude-code']],
    ['codex-cli reasoning_effort_source', provenance.reasoning_effort_source['codex-cli']],
  ];
  for (const [label, tracker] of flat) {
    if (tracker.mixed) lines.push(`mixed revisions: ${label} varies across cells (${tracker.values.join(', ')})`);
  }
  return lines;
}

/** Per-cell numeric metrics available for BOTH accepted and D3-reclassified-negative cells --
 * everything the plan's "efficiency aggregates go over accepted+negative-D3 together" requirement
 * needs. A rejected cell (D3 or not) never carries the fine-grained tool_calls[] a kmp-test-vs-
 * gradle split needs (confirmed: no CELL_CANONICAL_FIELDS_* version includes it), so that split is
 * reported as accepted-only, honestly, never fabricated for a D3 cell. */
function countedCellMetrics(cell) {
  if (cell.loaded.status === 'accepted') {
    const e = cell.loaded.entry;
    return {
      duration_ms: e.wall_clock_ms, tool_calls_total: e.tool_calls_total, shell_commands_total: e.shell_commands_total,
      usage: e.usage,
    };
  }
  const m = cell.loaded.rejectionCell.cell_metrics ?? {};
  return {
    duration_ms: Number.isFinite(m.wall_clock_ms) ? m.wall_clock_ms : null,
    tool_calls_total: Number.isFinite(m.tool_calls_total) ? m.tool_calls_total : null,
    shell_commands_total: Number.isFinite(m.shell_commands_total) ? m.shell_commands_total : null,
    usage: m.usage ?? null,
  };
}

function usageDimensionValues(countedCells, dimension) {
  return countedCells.map((cell) => {
    const v = countedCellMetrics(cell).usage?.[dimension];
    return typeof v === 'number' ? v : null;
  });
}

/** Schema-2 additive per-session fields for one cell row: tokens by type (including Codex
 * reasoning_output), num_turns, total_cost_usd, output_bytes (tool-result volume), and the 3-way
 * command mix -- everything a per-session chart needs beyond duration_ms/tool_calls_total above.
 * Reuses analyzeRunRecord's own already-computed product_cli_command_count/
 * direct_build_tool_command_count/other_bash_command_count (analysis.mjs's deriveProductUsage,
 * which classifies against the SAME tool_kind/BASH_TOOL_KIND_VALUES vocabulary campaign-summary.mjs
 * already reads product_cli_command_count/direct_build_tool_command_count from for
 * kmp_test_vs_gradle) rather than re-deriving a second classification of the raw commands.
 *
 * `usage` (hence `tokens`) is the one field available on a D3-negative cell too (cell_metrics.usage
 * is real, per countedCellMetrics above); num_turns/total_cost_usd/output_bytes/command mix are
 * accepted-only -- confirmed against rejection-diagnostics.mjs's own CELL_METRICS_FIELDS, which
 * never includes num_turns, total_cost_usd, output_bytes, or executed_commands. A 'missing' cell (no
 * record was ever produced) has none of it. Absent is always null, never a fabricated 0 -- the same
 * "never infer" convention every other optional field in this schema already follows.
 */
function perCellSchema2Fields(cell, status) {
  if (status === 'missing') {
    return { tokens: null, num_turns: null, total_cost_usd: null, output_bytes: null, output_bytes_kind: null, command_kind_counts: null };
  }
  const usage = countedCellMetrics(cell).usage;
  const tokens = usage
    ? {
      input: typeof usage.input === 'number' ? usage.input : null,
      cached_input: typeof usage.cached_input === 'number' ? usage.cached_input : null,
      cache_write: typeof usage.cache_write === 'number' ? usage.cache_write : null,
      output: typeof usage.output === 'number' ? usage.output : null,
      // null for claude-code by construction (schemas.mjs's own validateRun requires it); a real
      // number for codex-cli. Passed through as recorded, never coerced.
      reasoning_output: typeof usage.reasoning_output === 'number' ? usage.reasoning_output : null,
    }
    : null;
  if (status !== 'accepted') {
    return { tokens, num_turns: null, total_cost_usd: null, output_bytes: null, output_bytes_kind: null, command_kind_counts: null };
  }
  const e = cell.loaded.entry;
  // num_turns/total_cost_usd/output_bytes are RAW record fields -- analyzeRunRecord's own entry
  // (e above) never passes them through (confirmed by reading its full return object: it ends at
  // `usage`, nothing named num_turns/total_cost_usd/output_bytes anywhere in it), so these three
  // read cell.loaded.record directly, not entry. product_cli_command_count and friends ARE entry
  // fields (analyzeRunRecord computes and returns them from deriveProductUsage), so those three
  // correctly stay on `e`.
  const r = cell.loaded.record;
  return {
    tokens,
    // Nullable-metric-wrapped ({value, reason}, schemas.mjs NULLABLE_METRIC_KIND 'count'/'amount'),
    // same as output_bytes -- not bare numbers.
    num_turns: typeof r.num_turns?.value === 'number' ? r.num_turns.value : null,
    total_cost_usd: typeof r.total_cost_usd?.value === 'number' ? r.total_cost_usd.value : null,
    output_bytes: typeof r.output_bytes?.value === 'number' ? r.output_bytes.value : null,
    // What output_bytes measures (tool_results for claude-code, command_output for codex-cli); null for a
    // record that predates the label. A rejection carries neither the bytes nor the label.
    output_bytes_kind: typeof r.output_bytes_kind === 'string' ? r.output_bytes_kind : null,
    command_kind_counts: {
      kmp_test: typeof e.product_cli_command_count === 'number' ? e.product_cli_command_count : null,
      gradle: typeof e.direct_build_tool_command_count === 'number' ? e.direct_build_tool_command_count : null,
      other: typeof e.other_bash_command_count === 'number' ? e.other_bash_command_count : null,
    },
  };
}

/** Per-cell session-isolation evidence, additive like perCellSchema2Fields above and read
 * from an accepted record only -- a rejection carries neither, and never a guess:
 *  - session_id: the provider's own session id (record.session_id_observed), null when none was observed;
 *  - agent_state_clean: true when the agent-state listing succeeded and no file a later session would
 *    load into its context changed, false when one did, null when there is no usable listing (a record
 *    that predates the field, or a config directory that could not be listed).
 * Both live on cells[] only; by_runtime_arm and the top-level keys stay exactly as they were. */
function perCellIsolationFields(cell, status) {
  if (status !== 'accepted') return { session_id: null, agent_state_clean: null };
  const { record } = cell.loaded;
  const state = record.agent_state;
  return {
    session_id: typeof record.session_id_observed === 'string' && record.session_id_observed.length > 0 ? record.session_id_observed : null,
    agent_state_clean: state?.listed === true && Array.isArray(state.context_relevant_changed)
      ? state.context_relevant_changed.length === 0
      : null,
  };
}

// The access scan (transcript-access-scan.mjs) is this summary's only input besides the campaign
// directory: {schema, campaign_id, patterns, cells:[{cell_key, scanned, hits:[{label, count}]}]}.
const ACCESS_SCAN_SCHEMA = 1;
const ACCESS_SCAN_LABEL_RE = /^[a-z][a-z0-9_]{0,63}$/;

class AccessScanError extends Error {}

function accessScanError(message) {
  return new AccessScanError(`access scan: ${message}`);
}

/** What an access scan does to this campaign's summary: the cells to drop, and the limitations that say
 * why. A cell with at least one hit is excluded exactly as --exclude-cells excludes one (its key joins
 * the same exclusion set, so it leaves cells[], the declared counts and every aggregate); the cells
 * carry no reason, so the reason -- ground_truth_access -- goes in a limitation that names the cell. A
 * cell whose transcript was missing (scanned:false) stays in, with a limitation saying access was not
 * verified for it. Limitations are ordered by cell key. Throws, with a message that starts "access
 * scan:", on a scan that is malformed or was made for another campaign: applying a scan the summary
 * cannot vouch for would be worse than refusing it. */
export function accessScanEffects(scan, campaignId) {
  if (scan === null || typeof scan !== 'object' || Array.isArray(scan)) throw accessScanError('not an object');
  if (scan.schema !== ACCESS_SCAN_SCHEMA) throw accessScanError(`schema must be ${ACCESS_SCAN_SCHEMA}, got ${JSON.stringify(scan.schema)}`);
  if (scan.campaign_id !== campaignId) {
    throw accessScanError(`campaign_id ${JSON.stringify(scan.campaign_id)} is not this campaign's (${JSON.stringify(campaignId)})`);
  }
  if (!Array.isArray(scan.cells)) throw accessScanError('cells must be an array');

  const excludeCellKeys = new Set();
  const entries = [];
  const seen = new Set();
  for (const cell of scan.cells) {
    if (cell === null || typeof cell !== 'object' || Array.isArray(cell)) throw accessScanError('every cell must be an object');
    const key = cell.cell_key;
    if (typeof key !== 'string' || key === '') throw accessScanError('every cell needs a non-empty cell_key');
    if (seen.has(key)) throw accessScanError(`cell ${key} is listed twice`);
    seen.add(key);
    if (typeof cell.scanned !== 'boolean') throw accessScanError(`cell ${key}: scanned must be a boolean`);
    if (!Array.isArray(cell.hits)) throw accessScanError(`cell ${key}: hits must be an array`);
    for (const hit of cell.hits) {
      if (hit === null || typeof hit !== 'object' || typeof hit.label !== 'string' || !ACCESS_SCAN_LABEL_RE.test(hit.label)
        || !Number.isInteger(hit.count) || hit.count < 1) {
        throw accessScanError(`cell ${key}: every hit needs a lowercase label and a positive integer count`);
      }
    }
    if (!cell.scanned) {
      if (cell.hits.length > 0) throw accessScanError(`cell ${key}: hits on a cell that was not scanned`);
      entries.push({ key, text: `cell ${key}: transcript missing: access not verified` });
    } else if (cell.hits.length > 0) {
      excludeCellKeys.add(key);
      const matches = cell.hits.map((hit) => `${hit.label} x${hit.count}`).join(', ');
      entries.push({ key, text: `ground_truth_access: cell ${key} excluded (transcript matches: ${matches})` });
    }
  }
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { excludeCellKeys, limitations: entries.map((entry) => entry.text) };
}

/** Loads every COUNTED (accepted + D3-negative) cell's runtime/model/arm/round + raw per-cell
 * token usage, reusing the SAME expectedCellsFromManifest/loadCell/armFor/
 * qualifiesForD3NegativeReclassification/countedCellMetrics this module's own summarizeCampaign
 * uses -- never a re-derived copy of the classification rules -- so cost-estimate.mjs (a sibling
 * generator over the same campaign directory) can never silently disagree with campaign-summary.json
 * on which cells count. Returns null when the campaign itself isn't live/readable; the caller
 * decides how to report that (this function is not itself a JSON-envelope producer).
 */
export function loadCountedCellTokens(campaignDir) {
  const manifestPath = join(campaignDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  if (manifest.provider_mode !== 'live') return null;

  const privateRoot = join(campaignDir, 'private');
  const expected = expectedCellsFromManifest(manifest)
    .sort((a, b) => a.runtimeId.localeCompare(b.runtimeId) || a.roundIndex - b.roundIndex);

  const rows = [];
  for (const cell of expected) {
    const loaded = loadCell(privateRoot, cell.cellKey);
    const arm = loaded.status === 'accepted' ? armFor(loaded.record.condition)
      : loaded.status === 'rejected' ? armFor(loaded.rejectionCell.condition)
        : null;

    const isAccepted = loaded.status === 'accepted';
    const isNegativeD3 = loaded.status === 'rejected' && qualifiesForD3NegativeReclassification(cell.runtimeId, loaded.rejectionCell);
    if (!isAccepted && !isNegativeD3) continue;

    rows.push({
      runtimeId: cell.runtimeId, modelId: cell.modelId, arm, roundIndex: cell.roundIndex,
      usage: countedCellMetrics({ ...cell, loaded }).usage,
    });
  }
  return rows;
}

/** The core, pure-ish (filesystem reads only, no writes) summarization. Reads `manifest.json`,
 * rejects outright if `provider_mode` is not `live` (mirrors the eligibility finalizer's own H21
 * gate, 2.8), then reads and cross-validates every declared cell before aggregating.
 * @param {Set<string>} [excludeCellKeys] -- cell keys (`${runtime_id}-${round_index}`) to drop
 *   entirely before aggregation, as if never expected -- the sensitivity-analysis seam
 *   (tools/runs/evidence2-agentic-benchmark-2026-09-30/preregistration.md Amendment A2 D13/R8). Defaults to an empty Set, so
 *   an omitted or empty argument reproduces today's output byte-for-byte (Amendment A2 R7's required
 *   regression test) -- this parameter changes nothing about CAMPAIGN_SUMMARY_SCHEMA itself.
 * @param {{accessScan?: object|null}} [options] -- `accessScan` is a parsed transcript-access-scan.mjs
 *   result (see accessScanEffects): the cells it flags are excluded exactly like excludeCellKeys, and its
 *   limitations are appended after every other one. A scan with nothing to report changes nothing, byte
 *   for byte. Throws (message starting "access scan:") when the scan is malformed or for another campaign.
 * @returns {object} CAMPAIGN_SUMMARY_SCHEMA-shaped result -- see this file's own README/tests for
 *   the full field list; never throws for an individual cell's own defects (those become that
 *   cell's `status:'missing'` + `reason`, not a whole-campaign failure).
 */
export function summarizeCampaign(campaignDir, excludeCellKeys = new Set(), { accessScan = null } = {}) {
  const manifestPath = join(campaignDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { schema: CAMPAIGN_SUMMARY_SCHEMA, summary_status: 'refused', reason_code: 'manifest_unreadable', campaign_id: null, scenario_id: null, provider_mode: null, provenance: null, benchmark_eligible_counts: {}, by_runtime_arm: [], cells: [], limitations: [] };
  }

  if (manifest.provider_mode !== 'live') {
    return {
      schema: CAMPAIGN_SUMMARY_SCHEMA, summary_status: 'refused', reason_code: 'campaign_not_live',
      campaign_id: manifest.campaign_id ?? null, scenario_id: manifest.scenario_id ?? null,
      provider_mode: manifest.provider_mode ?? null, provenance: null, benchmark_eligible_counts: {},
      by_runtime_arm: [], cells: [], limitations: [],
    };
  }

  const blockCampaignIds = blockCampaignIdsOf(manifest);
  if (blockCampaignIds === undefined) {
    return {
      schema: CAMPAIGN_SUMMARY_SCHEMA, summary_status: 'refused', reason_code: 'merged_manifest_invalid',
      campaign_id: manifest.campaign_id ?? null, scenario_id: manifest.scenario_id ?? null,
      provider_mode: manifest.provider_mode ?? null, provenance: null, benchmark_eligible_counts: {},
      by_runtime_arm: [], cells: [], limitations: [],
    };
  }

  // The access scan is applied only to a live, readable campaign (the two refusals above never look at
  // it); its flagged cells join the same exclusion set --exclude-cells feeds.
  const scanEffects = accessScan === null ? null : accessScanEffects(accessScan, manifest.campaign_id ?? null);
  const excluded = scanEffects === null ? excludeCellKeys : new Set([...excludeCellKeys, ...scanEffects.excludeCellKeys]);

  const privateRoot = join(campaignDir, 'private');
  const expected = expectedCellsFromManifest(manifest)
    .filter((cell) => !excluded.has(cell.cellKey))
    .sort((a, b) => a.runtimeId.localeCompare(b.runtimeId) || a.roundIndex - b.roundIndex);

  const loadedCells = expected.map((cell) => {
    const loaded = loadCell(privateRoot, cell.cellKey);
    // A cell with a record or a rejection takes its arm from its own condition. One with neither (a session lost before it produced
    // anything) takes the arm the design put at its position, so it is declared in that arm and not counted; with no round_order in the
    // manifest it has no arm, as it always had not.
    const arm = loaded.status === 'accepted' ? armFor(loaded.record.condition)
      : loaded.status === 'rejected' ? armFor(loaded.rejectionCell.condition)
        : cell.designArm;
    return { ...cell, loaded, arm };
  });

  const provenance = buildProvenance(loadedCells);
  if (blockCampaignIds !== null) provenance.block_campaign_ids = blockCampaignIds;

  // Deterministic grouping key order: runtime_id, then arm ('free' before 'product' -- alphabetical,
  // arbitrary but fixed), then round_index -- matches the required (runtime -> arm -> cell) output
  // order for byte-identical re-runs.
  const groupKey = (runtimeId, arm) => `${runtimeId}\u0000${arm ?? 'unknown'}`;
  const groups = new Map();
  for (const cell of loadedCells) {
    const key = groupKey(cell.runtimeId, cell.arm);
    if (!groups.has(key)) groups.set(key, { runtimeId: cell.runtimeId, arm: cell.arm, cells: [] });
    groups.get(key).cells.push(cell);
  }
  const sortedGroupKeys = [...groups.keys()].sort();

  const byRuntimeArm = [];
  const cellRows = [];
  const campaignFamily = campaignFamilyOf(loadedCells);

  for (const key of sortedGroupKeys) {
    const group = groups.get(key);
    const declared = group.cells.length;
    const missing = [];
    const counted = []; // accepted + D3-negative
    let acceptedCount = 0;
    let negativeD3Count = 0;
    let keyFactsMatches = 0;
    let fullAnswerMatches = 0;
    let successMatches = 0;
    let successEligible = 0; // product-only denominator

    for (const cell of group.cells) {
      let status;
      let reason = null;
      let keyFactsMatch = null;
      let fullAnswerMatch = null;
      let successValue = null;

      if (cell.loaded.status === 'accepted') {
        status = 'accepted';
        acceptedCount += 1;
        counted.push(cell);
        const e = cell.loaded.entry;
        keyFactsMatch = isKeyFactsMatch(e.task_field_correctness, cell.loaded.record.family);
        fullAnswerMatch = e.task_outcome_matched === true;
        if (keyFactsMatch) keyFactsMatches += 1;
        if (fullAnswerMatch) fullAnswerMatches += 1;
        if (cell.arm === 'product') {
          successEligible += 1;
          successValue = e.success === true;
          if (successValue) successMatches += 1;
        }
      } else if (cell.loaded.status === 'rejected' && qualifiesForD3NegativeReclassification(cell.runtimeId, cell.loaded.rejectionCell)) {
        status = 'negative-d3';
        negativeD3Count += 1;
        counted.push(cell);
        const correctness = buildTaskFieldCorrectness(cell.loaded.rejectionCell.outcome_assessment, null, campaignFamily);
        keyFactsMatch = isKeyFactsMatch(correctness, campaignFamily);
        fullAnswerMatch = cell.loaded.rejectionCell.outcome_assessment?.task_outcome_matched === true;
        if (keyFactsMatch) keyFactsMatches += 1;
        if (fullAnswerMatch) fullAnswerMatches += 1;
        if (cell.arm === 'product') successEligible += 1; // never eligible to be true: agent abandoned, so success stays counted-false implicitly (not incremented)
        reason = 'agent closed the turn with an in-progress command (D3)';
      } else {
        status = 'missing';
        reason = cell.loaded.status === 'rejected' ? 'rejected_not_reclassifiable' : cell.loaded.reason;
        missing.push({ cell_key: cell.cellKey, reason });
      }

      cellRows.push({
        runtime_id: cell.runtimeId, arm: cell.arm, round_index: cell.roundIndex, cell_key: cell.cellKey,
        status, reason, key_facts_match: keyFactsMatch, full_answer_match: fullAnswerMatch,
        success: successValue,
        duration_ms: status === 'missing' ? null : countedCellMetrics(cell).duration_ms,
        tool_calls_total: status === 'missing' ? null : countedCellMetrics(cell).tool_calls_total,
        ...perCellSchema2Fields(cell, status),
        ...perCellIsolationFields(cell, status),
      });
    }

    const durationStats = summarizeNumericValues(counted.map((c) => countedCellMetrics(c).duration_ms));
    const toolCallStats = summarizeNumericValues(counted.map((c) => countedCellMetrics(c).tool_calls_total));
    const shellCommandStats = summarizeNumericValues(counted.map((c) => countedCellMetrics(c).shell_commands_total));
    const tokenStats = {
      input: summarizeNumericValues(usageDimensionValues(counted, 'input')),
      output: summarizeNumericValues(usageDimensionValues(counted, 'output')),
      cached_input: summarizeNumericValues(usageDimensionValues(counted, 'cached_input')),
      cache_write: summarizeNumericValues(usageDimensionValues(counted, 'cache_write')),
    };

    const acceptedOnly = counted.filter((c) => c.loaded.status === 'accepted');
    const kmpTestVsGradle = acceptedOnly.length === counted.length
      ? {
        available: true,
        kmp_test_count: acceptedOnly.reduce((sum, c) => sum + (c.loaded.entry.product_cli_command_count ?? 0), 0),
        gradle_count: acceptedOnly.reduce((sum, c) => sum + (c.loaded.entry.direct_build_tool_command_count ?? 0), 0),
      }
      : {
        available: false,
        reason: 'not available for D3-reclassified cells (no fine-grained tool_calls[] on a rejection)',
        kmp_test_count_accepted_only: acceptedOnly.reduce((sum, c) => sum + (c.loaded.entry.product_cli_command_count ?? 0), 0),
        gradle_count_accepted_only: acceptedOnly.reduce((sum, c) => sum + (c.loaded.entry.direct_build_tool_command_count ?? 0), 0),
      };

    byRuntimeArm.push({
      runtime_id: group.runtimeId, arm: group.arm,
      declared, accepted: acceptedCount, negative_d3: negativeD3Count, missing: missing.length,
      counted: counted.length, missing_reasons: missing,
      key_facts_match: { matched: keyFactsMatches, of: counted.length },
      full_answer_match: { matched: fullAnswerMatches, of: counted.length },
      success: group.arm === 'product' ? { matched: successMatches, of: successEligible, label: 'product protocol, not a cross-arm comparison' } : null,
      duration_ms: durationStats, tool_calls_total: toolCallStats, shell_commands_total: shellCommandStats,
      tokens: tokenStats, kmp_test_vs_gradle: kmpTestVsGradle,
    });
  }

  const limitations = [
    'cost: not-recorded (no incurred-cost field exists in the record/audit/rejection schema today; max_budget_usd is a pre-flight cap, never actual spend)',
    'kmp-test vs Gradle invocation split is only available for accepted cells, never for D3-reclassified negative cells',
    'JUnit-XML capture is not verified for codex-cli (its PostToolUse hook correlation has never been validated against a real transcript)',
    ...provenanceLimitationLines(provenance),
    ...(scanEffects === null ? [] : scanEffects.limitations),
  ];

  // Descriptive only, never a gate: what the campaign's OWN accepted records already say about
  // their own benchmark_eligible flag (H20/H21's promotion decision, computed entirely elsewhere
  // by the eligibility finalizer, 2.8) -- this campaign summary must never be read as implying
  // "eligible" data just because it successfully COMPUTED (summary_status:'ok'). A rejected/
  // D3-reclassified cell has no such field on its own rejection.json, so it contributes to neither
  // bucket here.
  const benchmarkEligibleCounts = {};
  for (const cell of loadedCells) {
    if (cell.loaded.status !== 'accepted') continue;
    const bucket = benchmarkEligibleCounts[cell.runtimeId] ?? (benchmarkEligibleCounts[cell.runtimeId] = { true: 0, false: 0 });
    bucket[cell.loaded.record.benchmark_eligible === true ? 'true' : 'false'] += 1;
  }

  return {
    schema: CAMPAIGN_SUMMARY_SCHEMA, summary_status: 'ok', reason_code: null,
    campaign_id: manifest.campaign_id, scenario_id: manifest.scenario_id, provider_mode: manifest.provider_mode,
    benchmark_eligible_counts: benchmarkEligibleCounts,
    provenance, by_runtime_arm: byRuntimeArm, cells: cellRows, limitations,
  };
}

// ---------------------------------------------------------------------------------------------
// Markdown rendering -- rendered FROM the JSON summary object only, never re-reading the campaign
// directory, so the public document's table is never hand-transcribed. Deliberately emits only
// enums/ids/numbers this function itself receives from `summarizeCampaign`'s own return value --
// never a raw record/audit/rejection field -- so a local or guest filesystem path (e.g.
// resolved_kmp_test_executable_path, raw_capture_location) structurally cannot leak into it: no
// code path here ever reads those fields at all.
// ---------------------------------------------------------------------------------------------

// Exported: evidence2-tables.mjs reuses these three verbatim rather than re-implementing
// the same x/n and median/min/max formatting a second time.
export function fmtRate({ matched, of }) {
  return of > 0 ? `${matched}/${of}` : 'n/a';
}
export function fmtStats(stats) {
  if (stats.n === 0) return 'n/a';
  return `median ${stats.median}, min ${stats.min}, max ${stats.max} (n=${stats.n})`;
}
export function fmtProvenanceLine(label, tracker) {
  return `- ${label}: ${tracker.values.length === 0 ? 'not-recorded' : tracker.values.join(', ')}${tracker.mixed ? ' **(mixed)**' : ''}`;
}

export function renderMarkdown(summary) {
  const lines = [];
  lines.push(`# Campaign summary: ${summary.campaign_id ?? 'unknown'}`);
  lines.push('');
  if (summary.summary_status !== 'ok') {
    lines.push(`Refused: \`${summary.reason_code}\`.`);
    return lines.join('\n') + '\n';
  }
  lines.push(`Scenario: \`${summary.scenario_id}\`. Provider mode: \`${summary.provider_mode}\`.`);
  lines.push('');
  lines.push('## Provenance');
  lines.push(fmtProvenanceLine('repo_commit', summary.provenance.repo_commit));
  lines.push(fmtProvenanceLine('skill_source_sha', summary.provenance.skill_source_sha));
  lines.push(fmtProvenanceLine('kmp_test_cli_version', summary.provenance.kmp_test_cli_version));
  lines.push(fmtProvenanceLine('kmp_test_cli_source_sha', summary.provenance.kmp_test_cli_source_sha));
  lines.push(fmtProvenanceLine('claude-code CLI version', summary.provenance.runtime_cli_version['claude-code']));
  lines.push(fmtProvenanceLine('codex-cli CLI version', summary.provenance.runtime_cli_version['codex-cli']));
  lines.push(fmtProvenanceLine('claude-code model_resolved', summary.provenance.model_resolved['claude-code']));
  lines.push(fmtProvenanceLine('codex-cli model_resolved', summary.provenance.model_resolved['codex-cli']));
  lines.push(fmtProvenanceLine('claude-code reasoning_effort', summary.provenance.reasoning_effort['claude-code']));
  lines.push(fmtProvenanceLine('codex-cli reasoning_effort', summary.provenance.reasoning_effort['codex-cli']));
  lines.push(fmtProvenanceLine('claude-code reasoning_effort_source', summary.provenance.reasoning_effort_source['claude-code']));
  lines.push(fmtProvenanceLine('codex-cli reasoning_effort_source', summary.provenance.reasoning_effort_source['codex-cli']));
  if (summary.provenance.block_campaign_ids) lines.push(`- block_campaign_ids: ${summary.provenance.block_campaign_ids.join(', ')}`);
  lines.push('');
  lines.push('## benchmark_eligible, as recorded on accepted cells (descriptive only, not a gate)');
  const eligibilityRuntimes = Object.keys(summary.benchmark_eligible_counts).sort();
  if (eligibilityRuntimes.length === 0) {
    lines.push('- (no accepted cells)');
  } else {
    for (const runtimeId of eligibilityRuntimes) {
      const c = summary.benchmark_eligible_counts[runtimeId];
      lines.push(`- ${runtimeId}: benchmark_eligible=true: ${c.true}, benchmark_eligible=false: ${c.false}`);
    }
  }
  lines.push('');
  lines.push('## By runtime / arm');
  lines.push('');
  lines.push('| runtime | arm | declared | accepted | negative (D3) | missing | key facts | full answer | success (product only) | duration ms | tool calls |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const g of summary.by_runtime_arm) {
    lines.push(`| ${[
      g.runtime_id, g.arm, g.declared, g.accepted, g.negative_d3, g.missing,
      fmtRate(g.key_facts_match), fmtRate(g.full_answer_match),
      g.success ? fmtRate(g.success) : 'n/a', fmtStats(g.duration_ms), fmtStats(g.tool_calls_total),
    ].join(' | ')} |`);
  }
  lines.push('');
  lines.push('## Per-cell detail');
  lines.push('');
  lines.push('| runtime | arm | round | status | key facts | full answer | success | duration ms | tool calls |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const c of summary.cells) {
    const statusLabel = c.status === 'negative-d3' ? 'negative (D3: agent abandoned an in-progress command)' : c.status === 'missing' ? `missing: ${c.reason}` : 'accepted';
    lines.push(`| ${[
      c.runtime_id, c.arm ?? 'unknown', c.round_index, statusLabel,
      c.key_facts_match == null ? 'n/a' : c.key_facts_match ? 'yes' : 'no',
      c.full_answer_match == null ? 'n/a' : c.full_answer_match ? 'yes' : 'no',
      c.success == null ? 'n/a' : c.success ? 'yes' : 'no',
      c.duration_ms ?? 'n/a', c.tool_calls_total ?? 'n/a',
    ].join(' | ')} |`);
  }
  lines.push('');
  lines.push('## Limitations');
  for (const l of summary.limitations) lines.push(`- ${l}`);
  lines.push('');
  return lines.join('\n');
}

function main(argv) {
  const campaignDir = argv[0];
  const markdownIndex = argv.indexOf('--markdown');
  const markdownPath = markdownIndex >= 0 ? argv[markdownIndex + 1] : null;
  const excludeCellsIndex = argv.indexOf('--exclude-cells');
  const excludeCellsPath = excludeCellsIndex >= 0 ? argv[excludeCellsIndex + 1] : null;
  const accessScanIndex = argv.indexOf('--access-scan');
  const accessScanPath = accessScanIndex >= 0 ? argv[accessScanIndex + 1] : null;
  if (!campaignDir || !existsSync(campaignDir) || (accessScanIndex >= 0 && !accessScanPath)) {
    console.error('usage: campaign-summary.mjs <campaign-dir> [--markdown <file>] [--exclude-cells <infra-flake-classification.json>] [--access-scan <access-scan.json>]');
    return 1;
  }
  // Sensitivity-analysis seam (tools/runs/evidence2-agentic-benchmark-2026-09-30/preregistration.md Amendment A2 D13/R8):
  // takes infra-flake-classifier.mjs's own output file directly, so the two scripts compose
  // without a redundant intermediate format -- only infra_flake_suspected===true cells (never
  // 'unknown' ones, per Amendment A2 R6) are excluded. Writes to stdout like the primary run always has;
  // the caller redirects to a distinct file, so this never overwrites the primary output.
  let excludeCellKeys = new Set();
  if (excludeCellsPath) {
    const classification = JSON.parse(readFileSync(excludeCellsPath, 'utf8'));
    excludeCellKeys = new Set(
      (classification.cells ?? [])
        .filter((c) => c.infra_flake_suspected === true)
        .map((c) => c.cell_key),
    );
  }
  // Session-isolation evidence: transcript-access-scan.mjs's own output file. A cell with a hit is excluded like
  // an --exclude-cells cell, and the scan's limitations are appended; an unreadable, malformed or
  // foreign scan prints no summary at all, since a summary that silently ignored it would read as clean.
  let accessScan = null;
  if (accessScanPath) {
    try {
      accessScan = JSON.parse(readFileSync(accessScanPath, 'utf8'));
    } catch (error) {
      console.error(`error: access scan file cannot be read as JSON (${error.code ?? error.name})`);
      return 1;
    }
  }
  let summary;
  try {
    summary = summarizeCampaign(campaignDir, excludeCellKeys, { accessScan });
  } catch (error) {
    if (!(error instanceof AccessScanError)) throw error;
    console.error(`error: ${error.message}`);
    return 1;
  }
  console.log(JSON.stringify(summary, null, 2));
  if (markdownPath) writeFileSync(markdownPath, renderMarkdown(summary), 'utf8');
  return summary.summary_status === 'ok' ? 0 : 1;
}

// import.meta.url is always a file:// URL (file:///C:/... on Windows); `` `file://${argv[1]}` ``
// never matches a real Windows path (no leading slash before the drive letter) -- confirmed live:
// running this script on Windows previously exited 0 with zero output, main() never called.
// codex-offline-preflight.mjs's own idiom compares resolved filesystem paths instead.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

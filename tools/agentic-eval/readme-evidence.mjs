#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/readme-evidence.mjs — deterministic generator that turns a
// committed campaign-summary.json + cost-estimate.json into one scorecard SVG
// and a metrics grid per campaign, and, from the campaign registry, the overview figure
// and the README block between <!-- agentic-benchmark:start/end -->.
//
// Usage:
//   node tools/agentic-eval/readme-evidence.mjs --check   (default) exits 1 if
//     regenerating would change any committed file (line endings ignored)
//   node tools/agentic-eval/readme-evidence.mjs --write   writes scorecard.svg
//     and metrics-grid.svg of one campaign in place
//   --evidence=<n>    which evidenceN-agentic-benchmark-<date> run dir to read/write
//                      (default: 1, i.e. evidence1-agentic-benchmark-<date> -- back-compat)
//   --date=<yyyy-mm-dd>  campaign date for that run dir (default: 2026-09-28, back-compat)
//   node tools/agentic-eval/readme-evidence.mjs --overview          writes the overview figure
//     (tools/runs/agentic-benchmark-overview.svg), the root README block and the overview block of
//     docs/agentic-benchmark.md from tools/runs/agentic-benchmark-campaigns.json
//   node tools/agentic-eval/readme-evidence.mjs --overview --check  exits 1 if any of the three differs
//
// The root README block is owned by the overview, which shows every campaign of the registry. A run
// for an evidence (--evidence=<n>) checks or writes just that campaign's own two SVGs.
//
// Never edit scorecard.svg, the overview figure or the README block between the markers by hand --
// edit this generator (or the campaign-summary.json / cost-estimate.json / registry it
// reads) and regenerate. Fails closed unless the summary is summary_status:"ok",
// provider_mode:"live", schema 1 or 2, with all 4 (runtime x arm) groups declaring
// the same number of cells (at least 1) and each counting between 1 and that
// number, and cost-estimate.json has a complete price table and, for every
// runtime it prices, at least 1 cell per arm -- as many as the summary counted
// for that group (validatePairing) -- so a canary (1 per group), a campaign (8)
// and a campaign that lost a session to a rejection all render, while a partial
// or non-live summary, or an incomplete cost estimate, never does.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

// Who owns the root README block: the overview (--overview), which shows every campaign of the registry, and no one evidence. A run
// for an evidence never compares or writes that block, so this is false for every evidence number (a number or the raw --evidence= string).
export const README_BLOCK_OWNER = 'overview';
export function ownsReadmeBlock() {
  return false;
}

// GitHub-palette colors, chosen to render identically on GitHub's and npm's
// markdown sanitizers (presentation attributes only, no <style>/CSS).
export const COLOR_TEXT = '#1f2328';
export const COLOR_SECONDARY = '#59636e';
const COLOR_GRID = '#d8dee4';
export const COLOR_WITH = '#0969da';
// #d4a72c (GitHub's own "attention" yellow) fails the 3:1 contrast-on-white
// floor for non-text UI elements (~2.24:1, WCAG relative-luminance formula);
// #bc4c00 passes (~5.03:1). See the contrast-ratio test in the test suite.
export const COLOR_WITHOUT = '#bc4c00';
export const COLOR_CARD_FILL = '#ffffff';
export const COLOR_CARD_STROKE = '#d0d7de';
export const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";

const RUNTIME_LABELS = {
  'claude-code': 'Claude Code · claude-sonnet-5',
  'codex-cli': 'Codex CLI · gpt-5.6-terra',
};
const RUNTIME_KEY = { 'claude-code': 'CLAUDE', 'codex-cli': 'CODEX' };
const RUNTIME_DISPLAY_NAME = { 'claude-code': 'Claude Code', 'codex-cli': 'Codex CLI' };
export const RUNTIME_ORDER = ['claude-code', 'codex-cli'];
export const ARM_ORDER = ['product', 'free']; // "with kmp-test" before "without kmp-test"
const ARM_LABEL = { product: 'with kmp-test', free: 'without kmp-test' };

// ---------------------------------------------------------------------------
// Loading + validation -- fails closed on anything but a complete, live summary

// What a cell's output_bytes measures: the tool results returned to the model (claude-code) or the command
// output as logged (codex-cli). The same two values schemas.mjs's OUTPUT_BYTES_KIND_BY_RUNTIME validates a
// record against; this generator stays free of the harness's schema module, and a test pins the two lists.
export const OUTPUT_BYTES_KINDS = ['tool_results', 'command_output'];

export function validateSummary(summary) {
  const errors = [];
  if (!summary || typeof summary !== 'object') return ['summary is not an object'];
  if (summary.schema !== 1 && summary.schema !== 2) errors.push(`schema must be 1 or 2, got ${JSON.stringify(summary.schema)}`);
  if (summary.summary_status !== 'ok') errors.push(`summary_status must be "ok", got ${JSON.stringify(summary.summary_status)}`);
  if (summary.provider_mode !== 'live') errors.push(`provider_mode must be "live", got ${JSON.stringify(summary.provider_mode)}`);
  const groups = Array.isArray(summary.by_runtime_arm) ? summary.by_runtime_arm : [];
  if (groups.length !== 4) {
    errors.push(`expected 4 (runtime x arm) groups, got ${groups.length}`);
  }
  // Any sample size: `declared` is the design's session count, ONE number shared by every group (a canary
  // declares 1, a campaign 8); `counted` is how many of them count, 1..declared per group, and may differ
  // between groups because a rejected session is never replaced. A group without `counted` counts as
  // `declared` (older and synthetic summaries carry only declared).
  const declaredByGroup = [];
  for (const runtime of RUNTIME_ORDER) {
    for (const arm of ARM_ORDER) {
      const g = groups.find(x => x.runtime_id === runtime && x.arm === arm);
      if (!g) { errors.push(`missing group for ${runtime}/${arm}`); continue; }
      const validDeclared = Number.isInteger(g.declared) && g.declared >= 1;
      if (validDeclared) declaredByGroup.push({ group: `${runtime}/${arm}`, declared: g.declared });
      else errors.push(`${runtime}/${arm}: declared must be an integer of at least 1, got ${JSON.stringify(g.declared)}`);
      if (g.counted !== undefined && !(Number.isInteger(g.counted) && g.counted >= 1 && (!validDeclared || g.counted <= g.declared))) {
        errors.push(`${runtime}/${arm}: counted must be an integer from 1 to declared (${JSON.stringify(g.declared)}), got ${JSON.stringify(g.counted)}`);
      }
      // wallClockPhrase reads duration_ms.min/max directly (the same aggregate as the median) to
      // render the per-session range -- a group missing either, or a non-numeric value, must fail
      // closed here, not render literal "NaN–NaN" in the README.
      const d = g.duration_ms || {};
      if (!(Number.isFinite(d.min) && Number.isFinite(d.max) && d.min <= d.median && d.median <= d.max)) {
        errors.push(`${runtime}/${arm}: duration_ms.min/median/max must be finite with min <= median <= max, got ${JSON.stringify(d)}`);
      }
    }
  }
  if (new Set(declaredByGroup.map(d => d.declared)).size > 1) {
    errors.push(`every group must declare the same number of sessions (the design's count), got ${declaredByGroup.map(d => `${d.group}=${d.declared}`).join(', ')}`);
  }
  // The README's Scope line names the kmp-test version under measurement, so a campaign that
  // mixes versions (or records none) must never silently render one: a later release can change
  // the envelope and exit semantics, so readers must see which kmp-test version produced these
  // numbers, permanently, not just while the version happens to be uniform by accident.
  const kmpTestVersion = summary.provenance && summary.provenance.kmp_test_cli_version;
  if (!kmpTestVersion || kmpTestVersion.mixed === true || !Array.isArray(kmpTestVersion.values) || kmpTestVersion.values.length !== 1) {
    errors.push(`provenance.kmp_test_cli_version must be a single, non-mixed value, got ${JSON.stringify(kmpTestVersion)}`);
  }
  // Schema 2 only: the Scope line and each scorecard panel title read runtime_cli_version /
  // model_resolved / reasoning_effort per runtime directly from provenance instead of hardcoded
  // text, so an ambiguous or missing value here must fail closed, not render "undefined" or the
  // wrong agent's numbers under the wrong heading.
  if (summary.schema === 2) {
    for (const runtime of RUNTIME_ORDER) {
      for (const field of ['runtime_cli_version', 'model_resolved', 'reasoning_effort']) {
        const v = summary.provenance && summary.provenance[field] && summary.provenance[field][runtime];
        if (!v || v.mixed === true || !Array.isArray(v.values) || v.values.length !== 1) {
          errors.push(`provenance.${field}.${runtime} must be a single, non-mixed value, got ${JSON.stringify(v)}`);
        }
      }
    }
  }
  // Optional per-cell isolation keys (campaign-summary.mjs, session-isolation evidence): absent from every summary
  // that predates them (Evidence2's, for one), and never required. When a cell does carry one it must
  // have its type, so a corrupted value can never read as "clean" downstream.
  const cells = Array.isArray(summary.cells) ? summary.cells : [];
  cells.forEach((cell, index) => {
    if (cell == null || typeof cell !== 'object') return;
    const name = typeof cell.cell_key === 'string' ? cell.cell_key : `#${index}`;
    if ('session_id' in cell && cell.session_id !== null && !(typeof cell.session_id === 'string' && cell.session_id.length > 0)) {
      errors.push(`cells[${name}].session_id must be a non-empty string or null`);
    }
    if ('agent_state_clean' in cell && cell.agent_state_clean !== null && typeof cell.agent_state_clean !== 'boolean') {
      errors.push(`cells[${name}].agent_state_clean must be true, false or null`);
    }
    // What the cell's output_bytes measures (campaign-summary.mjs): optional, and Evidence2's summary has none.
    if ('output_bytes_kind' in cell && cell.output_bytes_kind !== null && !OUTPUT_BYTES_KINDS.includes(cell.output_bytes_kind)) {
      errors.push(`cells[${name}].output_bytes_kind must be one of ${OUTPUT_BYTES_KINDS.join(', ')} or null`);
    }
  });
  return errors;
}

function kmpTestVersionOf(summary) {
  return summary.provenance.kmp_test_cli_version.values[0];
}

function provenanceValue(summary, field, runtime) {
  return summary.provenance[field][runtime].values[0];
}

export function loadSummary(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateSummary(raw);
  if (errors.length > 0) {
    throw new Error(`campaign-summary.json failed validation:\n  ${errors.join('\n  ')}`);
  }
  return raw;
}

function findGroup(summary, runtime, arm) {
  return summary.by_runtime_arm.find(g => g.runtime_id === runtime && g.arm === arm);
}

// How many sessions a group counted: its `counted`, or its `declared` when it carries none (older and
// synthetic summaries). validateSummary has already established that both are sensible integers.
function countedOf(group) {
  return group.counted !== undefined ? group.counted : group.declared;
}

// The four groups' counted values, in the order the prose lists them: Claude Code with kmp-test, Claude
// Code without, Codex CLI with, Codex CLI without.
function sessionCounts(summary) {
  return RUNTIME_ORDER.flatMap(runtime => ARM_ORDER.map(arm => countedOf(findGroup(summary, runtime, arm))));
}

function allEqual(counts) {
  return counts.every(n => n === counts[0]);
}

// The per-arm session count as the generated prose states it: the bare number when all four groups
// counted the same ("8"), otherwise each group's count ("8 with kmp-test and 7 without for Claude Code;
// 8 and 8 for Codex CLI"). Every generated sentence that states the count goes through this, so a
// campaign that lost a session to a rejection (never replaced) can never be described as if it had not.
export function countPhrase(summary) {
  const counts = sessionCounts(summary);
  if (allEqual(counts)) return String(counts[0]);
  const [claudeWith, claudeWithout, codexWith, codexWithout] = counts;
  return `${claudeWith} with kmp-test and ${claudeWithout} without for Claude Code; ${codexWith} and ${codexWithout} for Codex CLI`;
}

// ---------------------------------------------------------------------------
// Cost estimate -- Claude Code only (schema 1 has no token data for Codex).
// Fails closed on the same "not recorded" philosophy as validateSummary: a
// malformed or incomplete cost-estimate.json must never silently render a
// wrong or partial number.

const COST_ESTIMATE_PRICE_KEYS = ['input', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'output'];

export function validateCostEstimate(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return ['cost estimate is not an object'];
  if (doc.schema === 1) {
    const price = doc.pricing && doc.pricing.per_million_tokens;
    for (const key of COST_ESTIMATE_PRICE_KEYS) {
      if (!price || typeof price[key] !== 'number') errors.push(`pricing.per_million_tokens.${key} must be a number`);
    }
    // Any sample size: each arm needs at least one cell; how many it has is checked against the summary's
    // counted by validatePairing, the one function that sees both documents.
    const cells = Array.isArray(doc.cells) ? doc.cells : [];
    for (const arm of ARM_ORDER) {
      const n = cells.filter(c => c.runtime_id === 'claude-code' && c.arm === arm).length;
      if (n < 1) errors.push(`expected at least 1 claude-code/${arm} cell, got ${n}`);
    }
    return errors;
  }
  if (doc.schema === 2) {
    const runtimes = doc.runtimes && typeof doc.runtimes === 'object' ? doc.runtimes : null;
    if (!runtimes || Object.keys(runtimes).length === 0) {
      errors.push('runtimes must be a non-empty object');
      return errors;
    }
    for (const [runtimeId, entry] of Object.entries(runtimes)) {
      if (!entry || typeof entry.model !== 'string' || entry.model === '') {
        errors.push(`runtimes.${runtimeId}.model must be a non-empty string`);
      }
      const price = entry && entry.per_million_tokens;
      for (const key of COST_ESTIMATE_PRICE_KEYS) {
        if (!price || typeof price[key] !== 'number') errors.push(`runtimes.${runtimeId}.per_million_tokens.${key} must be a number`);
      }
      const cells = Array.isArray(entry && entry.cells) ? entry.cells : [];
      for (const arm of ARM_ORDER) {
        const n = cells.filter(c => c.arm === arm).length;
        if (n < 1) errors.push(`runtimes.${runtimeId}: expected at least 1 ${arm} cell, got ${n}`);
      }
      // Optional; when present it must genuinely be a boolean -- a truthy non-boolean (e.g. the
      // string "true") would silently pass the `=== true` check armCostRange relies on, always
      // resolving to today's behavior even when the field was clearly meant to turn the new
      // high-bound pricing on.
      if (entry && 'uncached_input_may_be_cache_writes' in entry && typeof entry.uncached_input_may_be_cache_writes !== 'boolean') {
        errors.push(`runtimes.${runtimeId}.uncached_input_may_be_cache_writes must be a boolean when present`);
      }
    }
    return errors;
  }
  errors.push(`schema must be 1 or 2, got ${JSON.stringify(doc.schema)}`);
  return errors;
}

export function loadCostEstimate(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateCostEstimate(raw);
  if (errors.length > 0) {
    throw new Error(`cost-estimate.json failed validation:\n  ${errors.join('\n  ')}`);
  }
  return raw;
}

// validateSummary/validateCostEstimate each accept schema 1/2 independently -- neither checks that
// the pair AGREES. Left unchecked, a schema-1 summary paired with a schema-2 cost-estimate reaches
// buildClaudeBullet, which assumes costEstimate.pricing exists unconditionally and throws a bare
// TypeError; a schema-2 summary paired with a schema-1 cost-estimate makes hasV2Cost report false
// for every runtime, silently dropping cost data a schema-1 estimate actually has; and even with
// matching schema-2/schema-2 documents, nothing previously confirmed that a runtime's priced model
// (cost-estimate.runtimes[id].model) is the same model the Scope line/panel title actually display
// (provenance.model_resolved[id]) -- a mismatch would show one model's name priced at another
// model's rates. Partial schema-2 cost coverage (a runtime present in the summary but absent from
// cost-estimate.runtimes) stays valid -- that is not a mismatch, it is the documented "not
// estimated" fallback.
//
// Any sample size: each arm of the cost estimate must also hold exactly as many cells as its summary
// group counted (`counted`, or `declared` for a group that carries none). Neither validator alone can
// check this -- the cost estimate does not know the design's count and the summary does not hold the
// cells -- and a mismatch would price a different set of sessions than the ones the prose reports.
function pairingCellCountError(label, arm, cellCount, group) {
  const counted = countedOf(group);
  return cellCount === counted ? null
    : `${label}: ${arm} has ${cellCount} cost-estimate cells but the summary counted ${counted} sessions for that group`;
}

export function validatePairing(summary, costEstimate) {
  const errors = [];
  if (summary.schema !== costEstimate.schema) {
    errors.push(`summary schema ${JSON.stringify(summary.schema)} does not match cost-estimate schema ${JSON.stringify(costEstimate.schema)}`);
    return errors;
  }
  if (summary.schema === 1 && costEstimate.schema === 1) {
    for (const arm of ARM_ORDER) {
      const group = findGroup(summary, 'claude-code', arm);
      if (!group) continue;
      const cellCount = (Array.isArray(costEstimate.cells) ? costEstimate.cells : []).filter(c => c.runtime_id === 'claude-code' && c.arm === arm).length;
      const error = pairingCellCountError('cost-estimate claude-code', arm, cellCount, group);
      if (error) errors.push(error);
    }
  }
  if (summary.schema === 2 && costEstimate.schema === 2) {
    for (const [runtimeId, entry] of Object.entries(costEstimate.runtimes || {})) {
      if (!RUNTIME_ORDER.includes(runtimeId)) {
        errors.push(`cost-estimate.runtimes.${runtimeId} is not a known runtime (expected one of ${RUNTIME_ORDER.join(', ')})`);
        continue;
      }
      const provenanceModel = provenanceValue(summary, 'model_resolved', runtimeId);
      if (entry.model !== provenanceModel) {
        errors.push(`cost-estimate.runtimes.${runtimeId}.model (${JSON.stringify(entry.model)}) does not match provenance.model_resolved.${runtimeId} (${JSON.stringify(provenanceModel)})`);
      }
      for (const arm of ARM_ORDER) {
        const group = findGroup(summary, runtimeId, arm);
        if (!group) continue;
        const cellCount = (Array.isArray(entry.cells) ? entry.cells : []).filter(c => c.arm === arm).length;
        const error = pairingCellCountError(`cost-estimate.runtimes.${runtimeId}`, arm, cellCount, group);
        if (error) errors.push(error);
      }
    }
  }
  return errors;
}

// One session's cost at a given per-million-token price table. inputPrice defaults to the plain
// input rate; a runtime whose usage events can't distinguish a cache write from a plain input
// token (see armCostRange below) overrides it for the high bound only.
// Exported: evidence2-tables.mjs's per-cell cost column reuses this exact per-session
// pricing formula (and costMetric's own low/high-then-midpoint pattern around it) rather than
// re-deriving it.
export function sessionCost(tokens, price, cacheWriteKey, inputPrice = price.input) {
  return (
    tokens.input * inputPrice +
    tokens.cache_creation * price[cacheWriteKey] +
    tokens.cache_read * price.cache_read +
    tokens.output * price.output
  ) / 1e6;
}

// The record doesn't distinguish a 5-minute from a 1-hour cache write, so the
// range spans both prices across every cell in the arm: the low bound is the
// cheapest cell under the 5m price, the high bound is the priciest cell under
// the 1h price -- the widest interval consistent with every session in the
// arm regardless of which TTL it actually used.
//
// uncachedInputMayBeCacheWrites (schema 2 only): some providers' usage events report
// input_tokens (uncached) and cached_input_tokens separately but never distinguish a cache WRITE
// from a plain uncached input token, and a cache write is priced instead of the input rate, not
// in addition to it -- so tokens.input itself may have actually been billed at either price. The
// low bound keeps the existing, always-correct assumption (plain input rate); the high bound
// additionally prices tokens.input at the pricier of the two cache-write rates, on top of the
// existing 5m/1h uncertainty already applied to cache_creation. Claude's own usage events do
// distinguish these, so this never applies to claude-code (see claudeCostRange below, which never
// passes this argument).
export function armCostRange(cells, price, uncachedInputMayBeCacheWrites = false) {
  const highInputPrice = uncachedInputMayBeCacheWrites
    ? Math.max(price.cache_write_5m, price.cache_write_1h)
    : price.input;
  const low5m = cells.map(c => sessionCost(c.tokens, price, 'cache_write_5m'));
  const high1h = cells.map(c => sessionCost(c.tokens, price, 'cache_write_1h', highInputPrice));
  return { low: Math.min(...low5m), high: Math.max(...high1h) };
}

function claudeCostRange(costEstimate, arm) {
  const price = costEstimate.pricing.per_million_tokens;
  const cells = costEstimate.cells.filter(c => c.runtime_id === 'claude-code' && c.arm === arm);
  return armCostRange(cells, price);
}

// Schema 2 only: any runtime present in cost-estimate.runtimes, not just claude-code. Reuses
// armCostRange/sessionCost unchanged -- only the source of price + cells is runtime-parameterized.
function hasV2Cost(costEstimate, runtimeId) {
  return costEstimate.schema === 2 && !!(costEstimate.runtimes && costEstimate.runtimes[runtimeId]);
}

function runtimeCostRange(costEstimate, runtimeId, arm) {
  const entry = costEstimate.runtimes[runtimeId];
  const cells = entry.cells.filter(c => c.arm === arm);
  return armCostRange(cells, entry.per_million_tokens, entry.uncached_input_may_be_cache_writes === true);
}

// 2 decimal places: matches the scorecard chart's and the README bullets'
// compact style (the full 3-decimal precision lives only in cost-estimate.json
// itself, which anyone can recompute from).
function fmtCostRange({ low, high }) {
  return `$${low.toFixed(2)}–$${high.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Formatting helpers -- "not recorded" for anything absent, never inferred

function fmtRatio(match) {
  if (!match || typeof match.of !== 'number') return 'not recorded';
  return `${match.matched}/${match.of}`;
}

function fmtMinutesMedian(medianMs) {
  return (medianMs / 60000).toFixed(1);
}

// n=4 medians are the average of the two middle values whenever they differ (e.g. tool_calls_total
// 3/3/6/15 -> 4.5), so a bare Math.round() silently turns a genuine 4.5 into "5" -- readers can no
// longer tell the reported figure was ever non-integer. Exported for direct testing (the same
// integer-else-1-decimal convention as the metrics-grid's own fmtCount, kept as a separate function
// here since callers in this section format only this one metric, not a shared grid value).
export function fmtToolCallsMedian(median) {
  // A group whose tool-call median was never computed (a partial or fixture summary) renders as
  // "n/a" rather than throwing on undefined.toFixed -- the same fail-soft rendering the grid uses
  // for an unavailable metric; the cross-agent bullet still omits itself when a median is missing.
  if (typeof median !== 'number' || !Number.isFinite(median)) return 'n/a';
  return Number.isInteger(median) ? String(median) : median.toFixed(1);
}

// ---------------------------------------------------------------------------
// Bar metrics shared by the scorecard chart and the bullets -- tool calls,
// wall-clock and (Claude only) cost. Key facts is a plain text line, not a
// bar: an all-4/4 result renders every bar identically full and conveys
// nothing, so it is stated as text instead (see computeScorecardLayout).

// Raw (unscaled) values only -- the grid requires the SAME 0..max scale for both
// agent columns (today's per-runtime max misleads any cross-agent reading: 3.2 min fills Claude's
// row and 4.8 min fills Codex's, identically full bars for very different durations). Fracs are
// attached afterward by attachSharedBarFracs, once both runtimes' raw metrics are known.
function buildBarMetricsRaw(runtimeId, summary, costEstimate) {
  const gProduct = findGroup(summary, runtimeId, 'product');
  const gFree = findGroup(summary, runtimeId, 'free');

  const metrics = [
    {
      label: 'Tool calls per session (median)',
      withValue: Math.round(gProduct.tool_calls_total.median),
      withoutValue: Math.round(gFree.tool_calls_total.median),
      withLabel: fmtToolCallsMedian(gProduct.tool_calls_total.median),
      withoutLabel: fmtToolCallsMedian(gFree.tool_calls_total.median),
    },
    {
      label: 'Wall-clock per session (median)',
      withValue: gProduct.duration_ms.median / 60000,
      withoutValue: gFree.duration_ms.median / 60000,
      withLabel: `${fmtMinutesMedian(gProduct.duration_ms.median)} min`,
      withoutLabel: `${fmtMinutesMedian(gFree.duration_ms.median)} min`,
    },
  ];

  // Schema 1 keeps its original claude-code-only path byte-for-byte. Schema 2 renders a real cost
  // bar for every runtime cost-estimate.runtimes actually covers -- Codex included, once Evidence2
  // supplies its pricing/cells, without touching the schema-1 behavior above it.
  if (costEstimate.schema === 1 && runtimeId === 'claude-code') {
    const withRange = claudeCostRange(costEstimate, 'product');
    const withoutRange = claudeCostRange(costEstimate, 'free');
    metrics.push({
      label: 'Estimated API cost per session',
      withValue: withRange.high, withoutValue: withoutRange.high,
      withLabel: fmtCostRange(withRange), withoutLabel: fmtCostRange(withoutRange),
    });
  } else if (hasV2Cost(costEstimate, runtimeId)) {
    const withRange = runtimeCostRange(costEstimate, runtimeId, 'product');
    const withoutRange = runtimeCostRange(costEstimate, runtimeId, 'free');
    metrics.push({
      label: 'Estimated API cost per session',
      withValue: withRange.high, withoutValue: withoutRange.high,
      withLabel: fmtCostRange(withRange), withoutLabel: fmtCostRange(withoutRange),
    });
  } else {
    metrics.push({ label: 'Estimated API cost per session', notEstimated: true });
  }

  return metrics;
}

// Attaches withFrac/withoutFrac to each same-index metric pair from BOTH columns, sharing one max
// per metric TYPE across both agents when both sides have a real value; a metric only one side has
// (e.g. Codex cost not yet estimated) falls back to that side's own max, since there is nothing on
// the other side to share against.
function attachSharedBarFracs(metricsA, metricsB) {
  for (let i = 0; i < metricsA.length; i++) {
    const a = metricsA[i], b = metricsB[i];
    const aOk = !a.notEstimated, bOk = !b.notEstimated;
    if (aOk && bOk) {
      const max = Math.max(a.withValue, a.withoutValue, b.withValue, b.withoutValue, 1e-9);
      a.withFrac = a.withValue / max; a.withoutFrac = a.withoutValue / max;
      b.withFrac = b.withValue / max; b.withoutFrac = b.withoutValue / max;
    } else if (aOk) {
      const max = Math.max(a.withValue, a.withoutValue, 1e-9);
      a.withFrac = a.withValue / max; a.withoutFrac = a.withoutValue / max;
    } else if (bOk) {
      const max = Math.max(b.withValue, b.withoutValue, 1e-9);
      b.withFrac = b.withValue / max; b.withoutFrac = b.withoutValue / max;
    }
  }
}

// ---------------------------------------------------------------------------
// scorecard.svg -- small-multiple horizontal bars, one column per agent.
//
// computeScorecardLayout is the SINGLE source of truth for every (x, y): both
// renderScorecardSvg and the "no overlapping text" test read the same items
// list, so a layout bug shows up as a failing test, not just a bad render.

const SCORECARD_W = 880;
export const PAD = 28;
export const ROW_GAP = 14; // minimum vertical gap between two text rows' allocated space
export const COLUMN_GAP = 32;
export const COLUMN_W = (SCORECARD_W - 2 * PAD - COLUMN_GAP) / 2;
const BAR_AREA_W = 300; // gutter + bar, unchanged total footprint from before the gutter existed
const GUTTER_W = 60; // fixed left gutter for each bar row's own "with"/"without" arm label
const BAR_MAX_W = BAR_AREA_W - GUTTER_W;
const BAR_H = 14;
const BAR_ROW_GAP = 6;
const BLOCK_GAP = 24;
const VALUE_LABEL_X_OFFSET = 12;
const ARM_LABEL_FS = 11;

export function textItem(role, column, x, y, fontSize, fontWeight, fill, text, anchor) {
  return { kind: 'text', role, column, x, y, fontSize, fontWeight, fill, text, anchor: anchor || 'start' };
}

export function computeScorecardLayout(summary, costEstimate) {
  const items = [];

  // Header: title + subtitle only. No corner legend -- every bar row now carries its own
  // "with"/"without" arm label directly (see the gutter below), which review found reads more
  // reliably than a single legend far away from a two-column, many-row chart.
  const titleFS = 20;
  const titleY = PAD + titleFS;
  items.push(textItem('title', null, PAD, titleY, titleFS, 600, COLOR_TEXT,
    'Results at a glance'));

  const subtitleFS = 13;
  const subtitleY = titleY + ROW_GAP + subtitleFS;
  // The per-arm session count is stated through countPhrase. A single number (every group counted the
  // same) keeps the one-line subtitle as before; the phrase that names each group's count is too long
  // for that line, so it takes a second one.
  let subtitleBottom = subtitleY;
  if (allEqual(sessionCounts(summary))) {
    items.push(textItem('subtitle', null, PAD, subtitleY, subtitleFS, 400, COLOR_SECONDARY,
      `1 pre-registered scenario · ${countPhrase(summary)} sessions per arm per agent · Windows 11 · details in the evidence doc`));
  } else {
    items.push(textItem('subtitle', null, PAD, subtitleY, subtitleFS, 400, COLOR_SECONDARY,
      '1 pre-registered scenario · Windows 11 · details in the evidence doc'));
    subtitleBottom = subtitleY + subtitleFS + 4;
    items.push(textItem('subtitle', null, PAD, subtitleBottom, subtitleFS, 400, COLOR_SECONDARY,
      `Counted per arm and agent: ${countPhrase(summary)}`));
  }

  const headerBottom = subtitleBottom + ROW_GAP;

  // Two columns, each: panel title, key-facts text line, then 3 bar metrics
  // (tool calls, wall-clock, cost). Both columns share the same row Y's, so
  // they align horizontally -- Codex's "not estimated" cost row occupies the
  // same vertical space a 2-bar block would.
  // Schema 1 keeps its original hardcoded titles byte-for-byte. Schema 2 reads the model per
  // runtime from provenance instead -- avoids a panel title going stale against a Scope line that
  // now renders its own model/effort text from the same data.
  const columns = summary.schema === 2
    ? RUNTIME_ORDER.map((id, i) => ({
        id,
        x: i === 0 ? PAD : PAD + COLUMN_W + COLUMN_GAP,
        title: `${RUNTIME_DISPLAY_NAME[id]} · ${provenanceValue(summary, 'model_resolved', id)}`,
      }))
    : [
        { id: 'claude-code', x: PAD, title: 'Claude Code · Sonnet 5' },
        { id: 'codex-cli', x: PAD + COLUMN_W + COLUMN_GAP, title: 'Codex CLI · gpt-5.6-terra (low effort)' },
      ];

  // Raw metrics for BOTH columns first, then shared fracs -- a shared max needs
  // both agents' values before either column's bars can be positioned.
  const rawMetricsByColumn = columns.map((col) => buildBarMetricsRaw(col.id, summary, costEstimate));
  attachSharedBarFracs(rawMetricsByColumn[0], rawMetricsByColumn[1]);

  const columnBottoms = [];

  columns.forEach((col, colIndex) => {
    let cy = headerBottom;

    const panelTitleFS = 15;
    const panelTitleY = cy + panelTitleFS;
    items.push(textItem('panelTitle', col.id, col.x, panelTitleY, panelTitleFS, 600, COLOR_TEXT, col.title));
    cy = panelTitleY + ROW_GAP;

    const keyFactsFS = 13;
    const keyFactsY = cy + keyFactsFS;
    const gProduct = findGroup(summary, col.id, 'product');
    const gFree = findGroup(summary, col.id, 'free');
    const keyFactsText = `Key facts correct: ${fmtRatio(gProduct.key_facts_match)} with kmp-test · ${fmtRatio(gFree.key_facts_match)} without`;
    items.push(textItem('keyFactsLine', col.id, col.x, keyFactsY, keyFactsFS, 400, COLOR_TEXT, keyFactsText));
    cy = keyFactsY + ROW_GAP + 8; // extra breathing room before the first bar block

    const metrics = rawMetricsByColumn[colIndex];
    for (const metric of metrics) {
      const labelFS = 13;
      const labelY = cy + labelFS;
      items.push(textItem('metricLabel', col.id, col.x, labelY, labelFS, 500, COLOR_TEXT, metric.label));
      cy = labelY + ROW_GAP;

      if (metric.notEstimated) {
        const neY = cy + 13;
        items.push(textItem('notEstimated', col.id, col.x, neY, 13, 400, COLOR_SECONDARY, 'not estimated'));
        cy = neY + BAR_H + BAR_ROW_GAP; // reserve the same row height as a 2-bar block
      } else {
        const barX = col.x + GUTTER_W;
        const armLabelX = barX - 6;
        const valueLabelX = col.x + BAR_AREA_W + VALUE_LABEL_X_OFFSET;

        const bar1Top = cy;
        const bar1CenterY = bar1Top + BAR_H / 2;
        items.push(textItem('armLabel', col.id, armLabelX, bar1CenterY + 4, ARM_LABEL_FS, 400, COLOR_SECONDARY, 'with', 'end'));
        items.push({ kind: 'bar', column: col.id, x: barX, y: bar1Top, w: Math.max(metric.withFrac * BAR_MAX_W, 2), h: BAR_H, rx: 3, fill: COLOR_WITH });
        items.push(textItem('barValue', col.id, valueLabelX, bar1CenterY + 4, 13, 600, COLOR_TEXT, metric.withLabel));

        const bar2Top = bar1Top + BAR_H + BAR_ROW_GAP;
        const bar2CenterY = bar2Top + BAR_H / 2;
        items.push(textItem('armLabel', col.id, armLabelX, bar2CenterY + 4, ARM_LABEL_FS, 400, COLOR_SECONDARY, 'without', 'end'));
        items.push({ kind: 'bar', column: col.id, x: barX, y: bar2Top, w: Math.max(metric.withoutFrac * BAR_MAX_W, 2), h: BAR_H, rx: 3, fill: COLOR_WITHOUT });
        items.push(textItem('barValue', col.id, valueLabelX, bar2CenterY + 4, 13, 600, COLOR_TEXT, metric.withoutLabel));

        cy = bar2Top + BAR_H;
      }

      cy = cy + BLOCK_GAP;
    }

    columnBottoms.push(cy - BLOCK_GAP);
  });

  const height = Math.round(Math.max(...columnBottoms) + PAD);
  return { width: SCORECARD_W, height, items };
}

export function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderScorecardSvg(summary, costEstimate) {
  const layout = computeScorecardLayout(summary, costEstimate);
  const parts = [];
  for (const item of layout.items) {
    if (item.kind === 'text') {
      const anchorAttr = item.anchor !== 'start' ? ` text-anchor="${item.anchor}"` : '';
      parts.push(`<text x="${item.x}" y="${item.y.toFixed(1)}" font-size="${item.fontSize}" font-weight="${item.fontWeight}" fill="${item.fill}"${anchorAttr}>${escapeXml(item.text)}</text>`);
    } else if (item.kind === 'bar' || item.kind === 'legendSwatch') {
      parts.push(`<rect x="${item.x}" y="${item.y.toFixed(1)}" width="${item.w.toFixed(1)}" height="${item.h}" rx="${item.rx}" fill="${item.fill}"/>`);
    }
  }
  return `<svg viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" xmlns="http://www.w3.org/2000/svg" role="img" font-family="${FONT_STACK}">
  <title>Results at a glance</title>
  <desc>${escapeXml(buildScorecardAlt(summary, costEstimate))}</desc>
  <rect x="1" y="1" width="${layout.width - 2}" height="${layout.height - 2}" rx="12" fill="${COLOR_CARD_FILL}" stroke="${COLOR_CARD_STROKE}" stroke-width="1"/>
  ${parts.join('\n  ')}
</svg>
`;
}

export function buildScorecardAlt(summary, costEstimate) {
  const parts = [];
  for (const runtimeId of RUNTIME_ORDER) {
    const gProduct = findGroup(summary, runtimeId, 'product');
    const gFree = findGroup(summary, runtimeId, 'free');
    const bits = [`key facts ${fmtRatio(gProduct.key_facts_match)} with kmp-test, ${fmtRatio(gFree.key_facts_match)} without`];
    for (const metric of buildBarMetricsRaw(runtimeId, summary, costEstimate)) {
      // Lowercase the label for alt-text style, but keep "API" as an acronym, not "api".
      const label = metric.label.toLowerCase().replace(/\bapi\b/, 'API');
      bits.push(metric.notEstimated
        ? `${label}: not estimated`
        : `${label}: ${metric.withLabel} with kmp-test, ${metric.withoutLabel} without`);
    }
    parts.push(`${runtimeModelLabel(summary, runtimeId)} — ${bits.join('; ')}`);
  }
  return parts.join('. ') + '.';
}

// ---------------------------------------------------------------------------
// metrics-grid.svg -- small multiples beyond the scorecard's pre-registered
// key facts / tool calls / wall-clock / cost. Everything in this grid is
// DESCRIPTIVE (not part of the pre-registered design) and labeled as such.
//
// Every session is a mark: a scalar metric (wall-clock, cost, turns) gets a
// dot; a composite metric (tokens by type, tool calls by kind) gets a thin
// stacked bar. campaign-summary.mjs does not aggregate every metric this
// grid wants at per-session granularity today -- only duration_ms and
// tool_calls_total live in cells[] (everything else is a run-level aggregate
// in by_runtime_arm, or (tokens by type, reasoning tokens, turns,
// output_bytes, command identity) not present at all yet). Rather than
// fabricate n identical fake dots from a single aggregate number, a metric
// with no per-session data renders ONE range mark (min-median-max) visually
// distinct from a dot cluster, clearly labeled "campaign aggregate, not
// per-session"; a metric with no data at all renders "not available for this
// campaign" text, and tool-output volume (the one metric gated on how it was
// measured) is drawn as the grid's last row, with "not recorded" in place of an
// agent's lanes when its bytes do not measure command output (toolOutputMeasured).

export const GRID_W = SCORECARD_W;
// Numbers-first, in the scorecard's own visual language, with one color rule for the whole image:
// an arm is always blue (with kmp-test) or orange (without), the scorecard's own COLOR_WITH /
// COLOR_WITHOUT, carried by every lane label; a component type always has its own palette color.
// Every row is two horizontal bars, one per arm, starting at the same x, with the value printed at
// the end. No axes, no dots, no lines.
//   STRIP rows (scalar metrics) -- each lane is ONE bar to the median in the arm's color.
//   COMPOSITION rows (tool calls by kind, tokens by type) -- each lane is ONE stacked bar of
//   per-component MEDIANS (never per-session mini-bars), a total at the end, one legend line below
//   both bars giving each component's with-vs-without value.
// Both columns share one scale per row, so bar lengths compare directly across agents. Turns is
// printed as values only: it is not comparable across agents (Amendment A9), so it gets no bars.
const GRID_HEADER_FS = 13;
const GRID_HEADER_H = 18;
const GRID_LANE_LABEL_FS = 11;
const GRID_LANE_LABEL_W = 92; // "with kmp-test" / "without" text budget
const GRID_VALUE_LABEL_FS = 11;
const GRID_TICK_FS = 9;
const GRID_TICK_H = 16;
const GRID_COMP_BAR_H = 14;
const GRID_COMP_BAR_GAP = 4;
const GRID_VALUE_GAP = 8; // clearance between a bar and its value label
const GRID_VALUE_TEXT_W = 54; // "10.2 min" / "426.1k" text budget
const GRID_COMP_BAR_W = COLUMN_W - GRID_LANE_LABEL_W - GRID_VALUE_GAP - GRID_VALUE_TEXT_W;
const GRID_ROW_GAP = 14; // clearance before the next row (at least 10px; kept generous)
// Distinct from COLOR_WITH/COLOR_WITHOUT (#0969da/#bc4c00) on purpose -- kmp_test and gradle
// used to reuse those exact hex values, so a lane whose bar happened to be 100% one type (every FAKE
// -DATA session this campaign) rendered as a solid blue/orange bar indistinguishable from "this is
// just the arm's own color". With real, mixed-type data the two encodings (arm color in strip rows /
// scorecard, component-type color here) would otherwise collide and mislead a reader.
const COMMAND_KIND_COLORS = { kmp_test: '#8250df', gradle: '#1a7f37', other: '#59636e' };
export const COMMAND_KIND_LABEL = { kmp_test: 'kmp-test', gradle: 'gradle', other: 'other' };
const GRID_LEGEND_FS = 9;
const GRID_LEGEND_SWATCH = 8;

// Greedy word-wrap for a plain sentence (not a list of short "label N vs M" parts, which wrap on
// their own part boundaries elsewhere in this file) -- same chars x fontSize x 0.6 estimator used
// throughout. Shared by the composition-row partial-total note and the strip-row caption below;
// extracted once a third caller needed the identical loop rather than a third copy of it.
export function wrapWords(text, fontSize, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && candidate.length * fontSize * 0.6 > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function medianOf(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Counted cells (accepted or negative-D3; never 'missing') for one (runtime, arm) -- the same
// population by_runtime_arm's own aggregate stats are computed over, so a per-session mark set and
// an aggregate fallback for the SAME metric are never comparing different denominators.
function countedCells(summary, runtimeId, arm) {
  return (summary.cells || []).filter((c) => c.runtime_id === runtimeId && c.arm === arm && c.status !== 'missing');
}

// A scalar metric's per-session values when every counted cell carries `cellField`; otherwise the
// run-level aggregate (median/min/max) `aggregateField` already provides. Never a partial mix of
// some real dots and some inferred ones for the same lane.
// Exported: evidence2-tables.mjs's aggregate table reuses this (and compositionMedians/
// tokenCompositionMedians/commandKindAggregate below) so its numbers are computed exactly the same
// way as the grid's, never a second, potentially-diverging implementation of the same median/
// per-type logic.
export function scalarMetric(summary, group, runtimeId, arm, cellField, aggregateOf) {
  const cells = countedCells(summary, runtimeId, arm);
  if (cells.length > 0 && cells.every((c) => typeof c[cellField] === 'number')) {
    const values = cells.map((c) => c[cellField]);
    return { kind: 'per-session', values, median: medianOf(values) };
  }
  const agg = aggregateOf(group);
  if (agg && typeof agg.median === 'number' && typeof agg.min === 'number' && typeof agg.max === 'number') {
    return { kind: 'aggregate', min: agg.min, median: agg.median, max: agg.max };
  }
  return { kind: 'unavailable' };
}

// A composition row's per-component MEDIANS for one lane -- the grid always renders ONE bar per
// lane (never a per-session mini-bar cluster), so the data layer always resolves to "one value per
// component" up front, whichever source it comes from:
//   - every counted cell carries `cellField` as an object -> the median of each component ACROSS
//     sessions (stat: 'median', every declared type present, per-cell data always tracks all of
//     them -- see command_kind_counts's own 3-bucket invariant elsewhere in this file);
//   - otherwise the run-level aggregate's own per-type figure (by_runtime_arm.tokens.<type>.median
//     for tokens, or commandKindAggregate's per-session MEAN for tool calls) -- only the types the
//     aggregate actually tracks become a segment; an untracked one (e.g. commandKindAggregate's
//     'other') is omitted, never defaulted to a fabricated 0.
// Returns null when neither source has anything -- the caller renders a single "not recorded" line.
// totalIsComplete: false marks a total that undercounts reality -- the aggregate fallback tracked
// fewer of the declared `types` than exist (e.g. commandKindAggregate has no 'other' bucket at all),
// so summing only the present segments is not the same quantity as the row's true total. The
// per-cell branch always carries every declared type (command_kind_counts' own 3-bucket invariant),
// so its total is always complete. renderCompositionRow uses this to suppress a misleading number
// rather than print a partial sum as if it were whole.
export function compositionMedians(summary, group, runtimeId, arm, cellField, types, aggregateOf) {
  const cells = countedCells(summary, runtimeId, arm);
  if (cells.length > 0 && cells.every((c) => c[cellField] && typeof c[cellField] === 'object')) {
    const segments = types.map((t) => ({ type: t, value: medianOf(cells.map((c) => Number(c[cellField][t]) || 0)) }));
    return { segments, stat: 'median', total: segments.reduce((a, s) => a + s.value, 0), totalIsComplete: true };
  }
  const agg = aggregateOf(group);
  if (agg) {
    const segments = types
      .filter((t) => agg[t] && typeof agg[t].median === 'number')
      .map((t) => ({ type: t, value: agg[t].median }));
    if (segments.length > 0) {
      return {
        segments, stat: agg.stat || 'median', total: segments.reduce((a, s) => a + s.value, 0),
        totalIsComplete: segments.length === types.length,
      };
    }
  }
  return null;
}

// Runtime-specific DISJOINT token components, replacing the raw ingestion's overlapping pairs --
// same BINDING mapping cost-estimate.mjs documents and applies for pricing (verified against that
// file's own header comment, not assumed): Codex's raw `input` INCLUDES `cached_input` (OpenAI's
// input_tokens is the TOTAL prompt size, cached_input_tokens a SUBSET, not additive), and raw
// `output` INCLUDES `reasoning_output`. Claude's four raw fields (input/cached_input/cache_write/
// output) are already disjoint -- Anthropic reports them as separate, non-overlapping, additive
// charges. Stacking the raw fields as-is (an earlier bug) double-counted Codex's cached and
// reasoning tokens into its own totals. Identical canonical labels across both runtimes:
// "uncached input", "cache read", "cache write", "output", "reasoning".
export const TOKEN_COMPONENT_TYPES = {
  'claude-code': ['uncached_input', 'cache_read', 'cache_write', 'output'],
  'codex-cli': ['uncached_input', 'cache_read', 'output', 'reasoning'], // Codex never has a cache-write token count (cost-estimate.mjs: cache_creation = 0 always)
};
// cache_read and output used to reuse COLOR_WITH/COLOR_WITHOUT exactly (#0969da/#bc4c00) --
// same collision as COMMAND_KIND_COLORS above, fixed the same way.
export const TOKEN_COMPONENT_COLORS = { uncached_input: '#8250df', cache_read: '#1b7c83', cache_write: '#1a7f37', output: '#bf3989', reasoning: '#cf222e' };
export const TOKEN_COMPONENT_LABEL = { uncached_input: 'uncached input', cache_read: 'cache read', cache_write: 'cache write', output: 'output', reasoning: 'reasoning' };

// A `reasoning_output` that is null/undefined means "not tracked" (schema-1's own by_runtime_arm
// aggregate -- campaign-summary.mjs's tokenStats object literal has only input/output/cached_input/
// cache_write, never a reasoning_output key, verified directly against that file), not "genuinely
// zero" -- those two must render differently (component omitted vs. component shown as 0), so this
// checks raw nullness BEFORE any Number() coercion collapses both cases to the same 0.
// Exported: evidence2-tables.mjs's per-cell token column reuses this exact mapping rather
// than re-deriving the same Codex input/cached_input/output subset relationship a second time.
export function disjointTokens(raw, runtimeId) {
  const input = Number(raw.input) || 0;
  const cachedInput = Number(raw.cached_input) || 0;
  const output = Number(raw.output) || 0;
  if (runtimeId === 'codex-cli') {
    const reasoningTracked = raw.reasoning_output !== null && raw.reasoning_output !== undefined;
    if (!reasoningTracked) return { uncached_input: input - cachedInput, cache_read: cachedInput, output };
    const reasoning = Number(raw.reasoning_output) || 0;
    return { uncached_input: input - cachedInput, cache_read: cachedInput, output: output - reasoning, reasoning };
  }
  return { uncached_input: input, cache_read: cachedInput, cache_write: Number(raw.cache_write) || 0, output };
}

// Tokens-by-type composition data, mirroring compositionMedians' two-source shape (per-cell median
// across sessions, else the group aggregate) but applying disjointTokens() to whichever raw numbers
// are about to be reduced -- per-cell values before their median, or the group's own already-reduced
// medians before the fallback segments are built. Never mixes raw overlapping fields into a stack.
// totalIsComplete is always true here, unlike compositionMedians: an untracked reasoning_output
// doesn't shrink the total, it just leaves the reasoning portion folded into 'output' (disjointTokens'
// own null-handling) -- uncached_input + cache_read + output always equals the real input + output,
// split into fewer components or more, never a partial sum of them.
export function tokenCompositionMedians(summary, group, runtimeId, arm) {
  const types = TOKEN_COMPONENT_TYPES[runtimeId];
  const cells = countedCells(summary, runtimeId, arm);
  if (cells.length > 0 && cells.every((c) => c.tokens && typeof c.tokens === 'object')) {
    const perCellDisjoint = cells.map((c) => disjointTokens(c.tokens, runtimeId));
    // A type only becomes a segment when EVERY cell's disjoint result actually has it -- e.g.
    // 'reasoning' is absent from a cell whose raw tokens had no reasoning_output at all (never a
    // partial mix of some cells contributing a real value and others silently defaulting to 0).
    const presentTypes = types.filter((t) => perCellDisjoint.every((d) => d[t] !== undefined));
    const segments = presentTypes.map((t) => ({ type: t, value: medianOf(perCellDisjoint.map((d) => d[t])) }));
    return { segments, stat: 'median', total: segments.reduce((a, s) => a + s.value, 0), totalIsComplete: true };
  }
  if (!group.tokens) return null;
  const rawMedians = {};
  for (const key of ['input', 'cached_input', 'cache_write', 'output']) {
    rawMedians[key] = group.tokens[key] && typeof group.tokens[key].median === 'number' ? group.tokens[key].median : 0;
  }
  // reasoning_output stays null (never defaulted to 0) when untracked, so disjointTokens can tell
  // "not tracked" apart from "tracked and genuinely zero".
  rawMedians.reasoning_output = group.tokens.reasoning_output && typeof group.tokens.reasoning_output.median === 'number'
    ? group.tokens.reasoning_output.median
    : null;
  const disjoint = disjointTokens(rawMedians, runtimeId);
  const presentTypes = types.filter((t) => disjoint[t] !== undefined);
  const segments = presentTypes.map((t) => ({ type: t, value: disjoint[t] }));
  if (!segments.some((s) => s.value > 0)) return null;
  return { segments, stat: 'median', total: segments.reduce((a, s) => a + s.value, 0), totalIsComplete: true };
}

export function commandKindAggregate(group) {
  const mix = group.kmp_test_vs_gradle;
  if (!mix || mix.available === false) return null;
  const n = Math.max(group.counted, 1);
  return {
    // Per-session MEAN (total / n), not a median -- campaign-summary.mjs exposes only totals for
    // this bucket, so `.median` here is stackedMetric's generic per-type value field, not a claim
    // this specific number is a median (see `stat` below, which renderCompositionRow reads to label
    // these values as means in the row legend).
    kmp_test: { median: mix.kmp_test_count / n },
    gradle: { median: mix.gradle_count / n },
    stat: 'mean',
    // 'other' intentionally absent: campaign-summary.mjs does not currently track a 3rd bucket at
    // the aggregate level -- see inventory. Per-cell command_kind_counts (the stack-per-session
    // path above) still carries all 3.
  };
}

// Claude/Codex per-session cost from cost-estimate.json's own cells[] (already per-session,
// independent of whether campaign-summary aggregates tokens per-session) -- provider-reported
// total_cost_usd is preferred when every counted cell carries it, matching the design's "Claude
// from the provider-reported value where present, otherwise the estimate" rule generalized to any
// runtime; Codex (and Claude with no provider figure) uses the existing estimate mechanism.
export function costMetric(summary, group, runtimeId, arm, costEstimate) {
  const cells = countedCells(summary, runtimeId, arm);
  if (cells.length > 0 && cells.every((c) => typeof c.total_cost_usd === 'number')) {
    const values = cells.map((c) => c.total_cost_usd);
    return { kind: 'per-session', values, median: medianOf(values), provider: true };
  }
  const priced = costEstimate.schema === 1 && runtimeId === 'claude-code'
    ? costEstimate.cells.filter((c) => c.runtime_id === 'claude-code' && c.arm === arm)
    : hasV2Cost(costEstimate, runtimeId) ? costEstimate.runtimes[runtimeId].cells.filter((c) => c.arm === arm) : null;
  if (!priced || priced.length === 0) return { kind: 'unavailable' };
  const price = costEstimate.schema === 1 ? costEstimate.pricing.per_million_tokens : costEstimate.runtimes[runtimeId].per_million_tokens;
  const uncachedMayBeCacheWrites = costEstimate.schema === 2 && costEstimate.runtimes[runtimeId].uncached_input_may_be_cache_writes === true;
  const highInputPrice = uncachedMayBeCacheWrites ? Math.max(price.cache_write_5m, price.cache_write_1h) : price.input;
  // Midpoint of the low/high estimate per session, using the SAME low/high assumptions as
  // armCostRange's own arm-level range (low: cache_write_5m + plain input price; high:
  // cache_write_1h + highInputPrice) -- not a separate single "mid-TTL" price point, so each
  // session's dot is consistent with the scorecard's own cost bar, just resolved to one number
  // per session instead of one range per arm.
  const values = priced.map((c) => {
    const low = sessionCost(c.tokens, price, 'cache_write_5m');
    const high = sessionCost(c.tokens, price, 'cache_write_1h', highInputPrice);
    return (low + high) / 2;
  });
  return { kind: 'per-session', values, median: medianOf(values), provider: false };
}

// A strip row's shared scale max: the grid uses the SAME 0..max scale for both agent columns, so
// bar lengths compare directly across agents -- the largest median among BOTH runtimes'
// with/without lanes for this one metric, never per-runtime (an earlier scorecard bug this also
// fixes). No axis is drawn, so the raw max needs no rounding.
function sharedStripScaleMax(...metrics) {
  const medians = metrics.filter((m) => m.kind !== 'unavailable').map((m) => m.median);
  return Math.max(...medians, 1e-9);
}

// A composition row's shared bar-total max, same cross-agent reasoning as sharedStripScaleMax --
// null-total lanes (no data) don't participate.
function sharedCompositionMax(...compositions) {
  const totals = compositions.filter(Boolean).map((c) => c.total);
  return totals.length > 0 ? Math.max(...totals, 1e-9) : 1;
}

// The set of type keys actually present across two composition lanes -- never every key typeColors
// happens to define, so the legend never shows a value for a type neither lane tracked.
function presentCompositionTypes(...compositions) {
  const set = new Set();
  for (const c of compositions) if (c) for (const s of c.segments) set.add(s.type);
  return set;
}
// A legend entry's value: what the segment says it is worth in the legend (`display`) when its caller set one, else the value that sizes
// the segment. The metrics grid sets no `display`, so its legend is the segment values, as before; the cost-breakdown figure sizes a
// segment in dollars and shows its share of the group's cost.
function compositionValueFor(composition, type) {
  if (!composition) return null;
  const seg = composition.segments.find((s) => s.type === type);
  if (!seg) return null;
  return seg.display !== undefined ? seg.display : seg.value;
}

// One STRIP row (scalar metric) for one runtime column: header (metric/unit) -> the diff% line ->
// two lanes, each a bar from 0 to the median in the arm's own scorecard color with the median
// printed at the end (the same geometry as a composition row's bars), or the median alone for a
// valuesOnly row -> an optional word-wrapped caption (Amendment A9: Turns is values-only and
// carries a caption explaining why -- see buildGridRowData) -> gap. Each band advances a single
// cursor, so no band can silently overlap another.
function renderStripRow(colX, rowY, mainHeaderText, diffText, agentLabel, withMetric, withoutMetric, scaleMax, fmtValue, caption, valuesOnly) {
  const items = [];
  let cursor = rowY;
  items.push(textItem('gridRowHeader', null, colX, cursor + GRID_HEADER_FS, GRID_HEADER_FS, 500, COLOR_TEXT, mainHeaderText));
  cursor += GRID_HEADER_H;
  if (diffText) {
    items.push(textItem('gridRowDiff', null, colX, cursor + GRID_TICK_FS, GRID_TICK_FS, 400, COLOR_SECONDARY, diffText));
    cursor += GRID_TICK_H;
  }

  if (withMetric.kind === 'unavailable' && withoutMetric.kind === 'unavailable') {
    items.push(textItem('gridNotRecorded', null, colX, cursor + 12, 12, 400, COLOR_SECONDARY, `not recorded for ${agentLabel}`));
    cursor += 16 + GRID_ROW_GAP;
    return { items, rowHeight: cursor - rowY };
  }

  const barX = colX + GRID_LANE_LABEL_W;
  const xFor = (v) => barX + (Math.min(Math.max(v, 0), scaleMax) / scaleMax) * GRID_COMP_BAR_W;

  const lanes = [
    { m: withMetric, arm: 'with kmp-test', color: COLOR_WITH },
    { m: withoutMetric, arm: 'without', color: COLOR_WITHOUT },
  ];
  for (const lane of lanes) {
    const barY = cursor;
    const barCenterY = barY + GRID_COMP_BAR_H / 2;
    items.push(textItem('gridLaneLabel', null, colX, barCenterY + 4, GRID_LANE_LABEL_FS, 400, lane.color, lane.arm));
    if (lane.m.kind === 'unavailable') {
      items.push(textItem('gridNotRecorded', null, barX, barCenterY + 4, GRID_VALUE_LABEL_FS, 400, COLOR_SECONDARY, 'n/a'));
    } else if (valuesOnly) {
      items.push(textItem('gridValueLabel', null, barX, barCenterY + 4, GRID_VALUE_LABEL_FS, 400, COLOR_TEXT, fmtValue(lane.m.median)));
    } else {
      items.push({ kind: 'bar', column: null, x: barX, y: barY, w: Math.max(xFor(lane.m.median) - barX, 1), h: GRID_COMP_BAR_H, rx: 1, fill: lane.color });
      items.push(textItem('gridValueLabel', null, barX + GRID_COMP_BAR_W + GRID_VALUE_GAP, barCenterY + 4, GRID_VALUE_LABEL_FS, 400, COLOR_TEXT, fmtValue(lane.m.median)));
    }
    cursor += GRID_COMP_BAR_H + GRID_COMP_BAR_GAP;
  }
  if (caption) {
    for (const line of wrapWords(caption, GRID_TICK_FS, COLUMN_W)) {
      items.push(textItem('gridRowCaption', null, colX, cursor + GRID_TICK_FS, GRID_TICK_FS, 400, COLOR_SECONDARY, line));
      cursor += GRID_TICK_H;
    }
  }
  cursor += GRID_ROW_GAP;

  return { items, rowHeight: cursor - rowY };
}

// One COMPOSITION row (tool calls by kind / tokens by type) for one runtime column: header ->
// two lanes, each ONE horizontal stacked bar of per-component MEDIANS with the total printed at
// the end -> one shared legend line giving each present component's with-vs-without value -> gap.
// `valueAtBarEnd` (default false, which is what the metrics grid uses) prints each lane's total right after its own bar instead of in the
// fixed column at the right of a full-width bar; with bars of different lengths on one scale, that keeps a number next to what it measures.
export function renderCompositionRow(colX, rowY, headerText, agentLabel, withComp, withoutComp, compMax, types, typeColors, typeLabels, fmtValue, partialTotalNote, valueAtBarEnd = false) {
  const items = [];
  let cursor = rowY;
  items.push(textItem('gridRowHeader', null, colX, cursor + GRID_HEADER_FS, GRID_HEADER_FS, 500, COLOR_TEXT, headerText));
  cursor += GRID_HEADER_H;

  if (!withComp && !withoutComp) {
    items.push(textItem('gridNotRecorded', null, colX, cursor + 12, 12, 400, COLOR_SECONDARY, `not recorded for ${agentLabel}`));
    cursor += 16 + GRID_ROW_GAP;
    return { items, rowHeight: cursor - rowY };
  }

  const barX = colX + GRID_LANE_LABEL_W;
  const lanes = [{ c: withComp, arm: 'with kmp-test', color: COLOR_WITH }, { c: withoutComp, arm: 'without', color: COLOR_WITHOUT }];
  for (const lane of lanes) {
    const barY = cursor;
    const barCenterY = barY + GRID_COMP_BAR_H / 2;
    items.push(textItem('gridLaneLabel', null, colX, barCenterY + 4, GRID_LANE_LABEL_FS, 400, lane.color, lane.arm));
    if (!lane.c) {
      items.push(textItem('gridNotRecorded', null, barX, barCenterY + 4, GRID_VALUE_LABEL_FS, 400, COLOR_SECONDARY, 'n/a'));
    } else {
      let xCursor = barX;
      for (const seg of lane.c.segments) {
        if (seg.value <= 0) continue;
        const w = (seg.value / compMax) * GRID_COMP_BAR_W;
        items.push({ kind: 'bar', column: null, x: xCursor, y: barY, w, h: GRID_COMP_BAR_H, rx: 1, fill: typeColors[seg.type] || COLOR_SECONDARY });
        xCursor += w;
      }
      // A partial aggregate's total undercounts reality (see compositionMedians' totalIsComplete
      // doc) -- printing it would read as "the whole story" when it's really "the tracked subset of
      // an unknown whole" (e.g. 0 kmp-test/gradle calls next to the scorecard's own ~12 tool calls
      // for the same lane). Omitted here; the legend's partialTotalNote explains why below.
      if (lane.c.totalIsComplete !== false) {
        const valueX = (valueAtBarEnd ? xCursor : barX + GRID_COMP_BAR_W) + GRID_VALUE_GAP;
        items.push(textItem('gridCompTotal', null, valueX, barCenterY + 4, GRID_VALUE_LABEL_FS, 400, COLOR_TEXT, fmtValue(lane.c.total)));
      }
    }
    cursor += GRID_COMP_BAR_H + GRID_COMP_BAR_GAP;
  }

  const presentTypes = types.filter((t) => presentCompositionTypes(withComp, withoutComp).has(t));
  const legendTokens = presentTypes.map((t) => {
    const wv = compositionValueFor(withComp, t);
    const wov = compositionValueFor(withoutComp, t);
    const label = (typeLabels && typeLabels[t]) || t;
    return {
      color: typeColors[t] || COLOR_SECONDARY,
      text: `${label} ${wv === null ? 'n/a' : fmtValue(wv)} vs ${wov === null ? 'n/a' : fmtValue(wov)}`,
    };
  });
  // Greedily wrap tokens across lines within COLUMN_W (tokens-by-type, up to 5 components, easily
  // overflows one line -- confirmed by the real overlap this produced against Codex's own column
  // before this fix existed). Same chars x fontSize x 0.6 estimator as the layout tests, plus each
  // token's own swatch + gap (a color swatch in front of each component so a reader can map
  // a bar segment's color to its legend entry, instead of a text-only line).
  const SEP_TEXT = ' · ';
  const SEP_W = SEP_TEXT.length * GRID_LEGEND_FS * 0.6;
  const SWATCH_TEXT_GAP = 4;
  const swatchTokenWidth = (text) => GRID_LEGEND_SWATCH + SWATCH_TEXT_GAP + text.length * GRID_LEGEND_FS * 0.6;
  const maxLineWidth = COLUMN_W;
  const legendLines = []; // each entry: {tokens:[{color,text}]} or {note:'plain text'}
  let currentLine = [];
  let currentLineWidth = 0;
  for (const tok of legendTokens) {
    const tokWidth = swatchTokenWidth(tok.text);
    const addedWidth = (currentLine.length > 0 ? SEP_W : 0) + tokWidth;
    if (currentLine.length > 0 && currentLineWidth + addedWidth > maxLineWidth) {
      legendLines.push({ tokens: currentLine });
      currentLine = [tok];
      currentLineWidth = tokWidth;
    } else {
      currentLine.push(tok);
      currentLineWidth += addedWidth;
    }
  }
  if (currentLine.length > 0) legendLines.push({ tokens: currentLine });

  const anyPartialTotal = [withComp, withoutComp].some((c) => c && c.totalIsComplete === false);
  if (anyPartialTotal && partialTotalNote) {
    // Word-wrapped separately from the component tokens above (it's one long sentence, not a list of
    // short "label N vs M" parts, and carries no swatch) -- at ~76 chars it exceeds one COLUMN_W line
    // on its own (estimated ~410px vs 396px), so it needs the same greedy wrapping, split on spaces.
    for (const noteLine of wrapWords(partialTotalNote, GRID_LEGEND_FS, maxLineWidth)) legendLines.push({ note: noteLine });
  }
  // stat 'mean' only comes from an aggregate that recorded campaign totals, not per-session values
  // (see commandKindAggregate). The grid subtitle says bars are the median session, so these
  // values must say what they are.
  if ([withComp, withoutComp].some((c) => c && c.stat === 'mean')) {
    for (const noteLine of wrapWords('per-session means, not medians (this campaign recorded totals only)', GRID_LEGEND_FS, maxLineWidth)) {
      legendLines.push({ note: noteLine });
    }
  }

  let legendY = cursor + GRID_LEGEND_FS + 2;
  for (const line of legendLines) {
    if (line.note !== undefined) {
      items.push(textItem('gridLegendLine', null, colX, legendY, GRID_LEGEND_FS, 400, COLOR_SECONDARY, line.note));
    } else {
      let x = colX;
      line.tokens.forEach((tok, i) => {
        if (i > 0) {
          items.push(textItem('gridLegendLine', null, x, legendY, GRID_LEGEND_FS, 400, COLOR_SECONDARY, SEP_TEXT));
          x += SEP_W;
        }
        items.push({ kind: 'legendSwatch', column: null, x, y: legendY - 7, w: GRID_LEGEND_SWATCH, h: GRID_LEGEND_SWATCH, fill: tok.color });
        x += GRID_LEGEND_SWATCH + SWATCH_TEXT_GAP;
        items.push(textItem('gridLegendLine', null, x, legendY, GRID_LEGEND_FS, 400, COLOR_SECONDARY, tok.text));
        x += tok.text.length * GRID_LEGEND_FS * 0.6;
      });
    }
    legendY += GRID_LEGEND_FS + 4;
  }
  cursor = legendY + 2 + GRID_ROW_GAP;

  return { items, rowHeight: cursor - rowY };
}

// Formatting, all numbers-first (min at 1 decimal like the scorecard; tokens
// k/M; cost $; bytes KB/MB; plain counts for turns and tool-calls-by-kind).
function fmtCount(v) { return Number.isInteger(v) ? String(v) : v.toFixed(1); }
function fmtMinutesGrid(v) { return `${v.toFixed(1)} min`; }
function fmtUsdGrid(v) { return `$${v.toFixed(2)}`; }
function fmtTokensCompact(v) {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}
function fmtBytesCompact(v) {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)} KB`;
  return `${Math.round(v)} B`;
}

// Converts a scalarMetric() result's numeric fields by `factor` (e.g. ms -> min) so the strip-row
// renderer and its shared axis always work in the metric's OWN display unit, never raw milliseconds.
function scaleMetric(metric, factor) {
  if (metric.kind === 'per-session') return { kind: 'per-session', values: metric.values.map((v) => v * factor), median: metric.median * factor };
  if (metric.kind === 'aggregate') return { kind: 'aggregate', min: metric.min * factor, median: metric.median * factor, max: metric.max * factor };
  return metric;
}

// (with - without) / without from the medians, as a percent -- omitted (null) when either median
// is missing or exactly zero.
function stripDiffPct(withMetric, withoutMetric) {
  const wm = withMetric.median, wo = withoutMetric.median;
  if (typeof wm !== 'number' || typeof wo !== 'number' || wo === 0 || wm === 0) return null;
  return ((wm - wo) / wo) * 100;
}

// Split across up to 2 lines, not one long string: "API cost (USD) -- estimate: midpoint of
// low/high" alone is already ~48 chars (~374px at 13px), leaving no room to also fit a diff% on
// the same line within one COLUMN_W (396px) without overflowing into the next column -- confirmed
// visually (real committed data: Claude's "API cost" header overlapped Codex's own header text).
function stripHeaderLines(label, unit, diffPct, sourceNote) {
  const mainParts = [unit ? `${label} (${unit})` : label];
  if (sourceNote) mainParts.push(sourceNote);
  const diffText = diffPct === null ? null : `median ${diffPct > 0 ? '+' : ''}${Math.round(diffPct)}% with kmp-test`;
  return { mainText: mainParts.join(' — '), diffText };
}

// Codex CLI's `output_bytes` counted the agent's own messages, not the output of the commands it
// ran (Evidence2 erratum E6), until a cell says otherwise with `output_bytes_kind:
// 'command_output'`. Its tool-output lanes are drawn only when every counted cell says so, never a
// partial mix. Claude's bytes were always the tool results returned to the model.
export function toolOutputMeasured(summary, runtimeId) {
  if (runtimeId !== 'codex-cli') return true;
  const cells = ARM_ORDER.flatMap((arm) => countedCells(summary, runtimeId, arm));
  return cells.length > 0 && cells.every((c) => c.output_bytes_kind === 'command_output');
}

// The caption under Codex's tool-output lanes (renderStripRow word-wraps it, like the Turns row's).
const CODEX_TOOL_OUTPUT_CAPTION = 'Codex CLI: command output as logged; Codex may shorten what the model reads.';

function toolOutputMetric(summary, group, runtimeId, arm) {
  if (!toolOutputMeasured(summary, runtimeId)) return { kind: 'unavailable' };
  return scalarMetric(summary, group, runtimeId, arm, 'output_bytes', () => null);
}

// One runtime's full, FIXED row set and order -- always all 6 rows; an agent
// with nothing for a given row renders as a single "not recorded for <agent>" line there
// instead of the row being omitted campaign-wide.
function buildGridRowData(runtimeId, summary, costEstimate) {
  const gp = findGroup(summary, runtimeId, 'product');
  const gf = findGroup(summary, runtimeId, 'free');

  const wallWith = scaleMetric(scalarMetric(summary, gp, runtimeId, 'product', 'duration_ms', (g) => g.duration_ms), 1 / 60000);
  const wallWithout = scaleMetric(scalarMetric(summary, gf, runtimeId, 'free', 'duration_ms', (g) => g.duration_ms), 1 / 60000);

  const costWith = costMetric(summary, gp, runtimeId, 'product', costEstimate);
  const costWithout = costMetric(summary, gf, runtimeId, 'free', costEstimate);
  // "provider-reported when every session has total_cost_usd" -- costMetric() already only sets
  // provider:true on a lane when every counted cell IN THAT LANE carries total_cost_usd; the row
  // note calls it provider-reported only when BOTH lanes independently qualified (or the other is
  // simply unavailable), never when one lane is real and the other is an estimate.
  const costSourceNote = (costWith.kind === 'unavailable' && costWithout.kind === 'unavailable') ? null
    : (costWith.provider !== false && costWithout.provider !== false)
      ? 'provider-reported'
      : 'estimate: midpoint of low/high';

  return [
    {
      // This counts SHELL commands (product_cli_command_count / direct_build_tool_command_count
      // -- campaign-summary.mjs's own kmp_test_vs_gradle), never ALL tool calls (Skill, Read, etc. are
      // not counted here) -- the scorecard's own "Tool calls" bar (4 vs 13) is a different, larger
      // population. Named precisely so a reader never reads the two side by side and thinks the chart
      // is wrong.
      kind: 'composition', label: 'Shell commands by kind', types: ['kmp_test', 'gradle', 'other'], typeColors: COMMAND_KIND_COLORS, typeLabels: COMMAND_KIND_LABEL, fmtValue: fmtCount,
      partialTotalNote: 'kmp-test and gradle only (other shell commands not tracked in this campaign)',
      with: compositionMedians(summary, gp, runtimeId, 'product', 'command_kind_counts', ['kmp_test', 'gradle', 'other'], commandKindAggregate),
      without: compositionMedians(summary, gf, runtimeId, 'free', 'command_kind_counts', ['kmp_test', 'gradle', 'other'], commandKindAggregate),
    },
    {
      kind: 'composition', label: 'Tokens per session, by type', types: TOKEN_COMPONENT_TYPES[runtimeId], typeColors: TOKEN_COMPONENT_COLORS, typeLabels: TOKEN_COMPONENT_LABEL, fmtValue: fmtTokensCompact,
      with: tokenCompositionMedians(summary, gp, runtimeId, 'product'),
      without: tokenCompositionMedians(summary, gf, runtimeId, 'free'),
    },
    { kind: 'strip', label: 'Wall-clock', unit: 'min', fmtValue: fmtMinutesGrid, sourceNote: null, with: wallWith, without: wallWithout },
    { kind: 'strip', label: 'API cost', unit: 'USD', fmtValue: fmtUsdGrid, sourceNote: costSourceNote, with: costWith, without: costWithout },
    {
      // Amendment A9: num_turns is not comparable across runtimes -- Claude counts assistant
      // turns (5-12 observed in canary 2), Codex reports one user turn per non-interactive
      // session (always 1). valuesOnly prints each lane's median without a bar, so no scale ever
      // suggests the two columns' Turns are comparable; the caption states the reason on the row.
      kind: 'strip', label: 'Turns', unit: '', fmtValue: fmtCount, sourceNote: null,
      valuesOnly: true,
      caption: 'Not comparable across agents: Claude counts assistant turns; Codex reports one turn per session.',
      with: scalarMetric(summary, gp, runtimeId, 'product', 'num_turns', () => null),
      without: scalarMetric(summary, gf, runtimeId, 'free', 'num_turns', () => null),
    },
    {
      kind: 'strip', label: 'Tool output returned to the model', unit: 'bytes', fmtValue: fmtBytesCompact, sourceNote: null,
      // Codex may shorten a command's output before the model reads it (tool_output_token_limit), so once its
      // lanes are drawn -- every counted cell labelled command_output -- the row says what the bytes are.
      // Claude's bytes are the tool results returned to the model, which the row's own label already says.
      ...(runtimeId === 'codex-cli' && toolOutputMeasured(summary, runtimeId) ? { caption: CODEX_TOOL_OUTPUT_CAPTION } : {}),
      with: toolOutputMetric(summary, gp, runtimeId, 'product'),
      without: toolOutputMetric(summary, gf, runtimeId, 'free'),
    },
  ];
}

export function computeMetricsGridLayout(summary, costEstimate) {
  const items = [];
  const titleFS = 20;
  const titleY = PAD + titleFS;
  items.push(textItem('gridTitle', null, PAD, titleY, titleFS, 600, COLOR_TEXT, 'Per-session detail (descriptive)'));
  const subtitleFS = 13;
  const subtitleY1 = titleY + ROW_GAP + subtitleFS;
  const subtitleY2 = subtitleY1 + subtitleFS + 4;
  items.push(textItem('gridSubtitle', null, PAD, subtitleY1, subtitleFS, 400, COLOR_SECONDARY,
    'Bars are the median session: blue with kmp-test, orange without.'));
  items.push(textItem('gridSubtitle', null, PAD, subtitleY2, subtitleFS, 400, COLOR_SECONDARY,
    'Descriptive only, not part of the pre-registered analysis.'));
  const headerBottom = subtitleY2 + ROW_GAP + 8;

  const columns = RUNTIME_ORDER.map((id, i) => ({ id, x: i === 0 ? PAD : PAD + COLUMN_W + COLUMN_GAP }));
  // Both columns' full row data is built FIRST so shared cross-agent scales
  // can be computed before anything is rendered -- a shared max needs both sides' raw values.
  const rowDataByColumn = columns.map((col) => buildGridRowData(col.id, summary, costEstimate));
  const rowCount = rowDataByColumn[0].length;

  const columnBottoms = [];
  for (let ci = 0; ci < columns.length; ci++) {
    const col = columns[ci];
    const otherData = rowDataByColumn[1 - ci];
    let cy = headerBottom;
    const panelTitleFS = 14;
    items.push(textItem('gridPanelTitle', col.id, col.x, cy + panelTitleFS, panelTitleFS, 600, COLOR_TEXT,
      summary.schema === 2 ? `${RUNTIME_DISPLAY_NAME[col.id]} · ${provenanceValue(summary, 'model_resolved', col.id)}` : RUNTIME_DISPLAY_NAME[col.id]));
    cy += panelTitleFS + ROW_GAP;

    for (let ri = 0; ri < rowCount; ri++) {
      const row = rowDataByColumn[ci][ri];
      const agentLabel = RUNTIME_DISPLAY_NAME[col.id];
      let rendered;
      if (row.kind === 'strip') {
        // One scale per row across BOTH columns (otherData), so bar lengths compare across agents.
        // A valuesOnly row (Turns, Amendment A9) draws no bars, so its scale is never used.
        const scaleMax = sharedStripScaleMax(row.with, row.without, otherData[ri].with, otherData[ri].without);
        const diffPct = stripDiffPct(row.with, row.without);
        const { mainText, diffText } = stripHeaderLines(row.label, row.unit, diffPct, row.sourceNote);
        rendered = renderStripRow(col.x, cy, mainText, diffText, agentLabel, row.with, row.without, scaleMax, row.fmtValue, row.caption, !!row.valuesOnly);
      } else {
        const compMax = sharedCompositionMax(row.with, row.without, otherData[ri].with, otherData[ri].without);
        rendered = renderCompositionRow(col.x, cy, row.label, agentLabel, row.with, row.without, compMax, row.types, row.typeColors, row.typeLabels, row.fmtValue, row.partialTotalNote);
      }
      items.push(...rendered.items);
      cy += rendered.rowHeight;
    }
    columnBottoms.push(cy);
  }
  const height = Math.round(Math.max(...columnBottoms) + PAD);
  return { width: GRID_W, height, items };
}

export function renderMetricsGridSvg(summary, costEstimate) {
  const layout = computeMetricsGridLayout(summary, costEstimate);
  const parts = [];
  for (const item of layout.items) {
    if (item.kind === 'text') {
      const anchorAttr = item.anchor !== 'start' ? ` text-anchor="${item.anchor}"` : '';
      parts.push(`<text x="${item.x.toFixed(1)}" y="${item.y.toFixed(1)}" font-size="${item.fontSize}" font-weight="${item.fontWeight}" fill="${item.fill}"${anchorAttr}>${escapeXml(item.text)}</text>`);
    } else if (item.kind === 'bar') {
      parts.push(`<rect x="${item.x.toFixed(1)}" y="${item.y.toFixed(1)}" width="${item.w.toFixed(1)}" height="${item.h.toFixed(1)}" rx="${item.rx}" fill="${item.fill}"/>`);
    } else if (item.kind === 'legendSwatch') {
      parts.push(`<rect x="${item.x.toFixed(1)}" y="${item.y.toFixed(1)}" width="${item.w}" height="${item.h}" fill="${item.fill}"/>`);
    }
  }
  const tokenLegendDesc = Object.keys(TOKEN_COMPONENT_LABEL).map((t) => `${TOKEN_COMPONENT_LABEL[t]} (${TOKEN_COMPONENT_COLORS[t]})`).join(', ');
  const commandLegendDesc = ['kmp_test', 'gradle', 'other'].map((t) => `${COMMAND_KIND_LABEL[t]} (${COMMAND_KIND_COLORS[t]})`).join(', ');
  const desc = `Color legend. With kmp-test (${COLOR_WITH}), without (${COLOR_WITHOUT}). Token component: ${tokenLegendDesc}. Shell-command kind: ${commandLegendDesc}.`;
  return `<svg viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" xmlns="http://www.w3.org/2000/svg" role="img" font-family="${FONT_STACK}">
  <title>Per-session detail (descriptive)</title>
  <desc>${escapeXml(desc)}</desc>
  <rect x="1" y="1" width="${layout.width - 2}" height="${layout.height - 2}" rx="12" fill="${COLOR_CARD_FILL}" stroke="${COLOR_CARD_STROKE}" stroke-width="1"/>
  ${parts.join('\n  ')}
</svg>
`;
}

// ---------------------------------------------------------------------------
// README bullets -- three data-driven sentences, no hard-coded numbers.

// Evidence1's own "## Results — campaign (16 sessions)" heading, hand-authored (not generated) at
// tools/runs/evidence1-agentic-benchmark-<date>/README.md. The slug drops the em-dash (it is stripped,
// not converted), so "Results — campaign" leaves two adjacent spaces and therefore a DOUBLE hyphen:
// "results--campaign-16-sessions". It is the default anchor for a caller that passes none; main()
// computes the real one from the record README it is generating for (resultsHeadingAnchor).
const RESULTS_HEADING_ANCHOR = 'results--campaign-16-sessions';

// The anchor of a record README's results heading: its LAST level-2 heading that starts with
// "Results" (Evidence1 has a canary one and a campaign one, Evidence2 has one), slugified the way
// GitHub does -- lowercase, keep only letters, digits, spaces and hyphens, turn each space into a
// hyphen. Headings inside a fenced code block do not count. Throws when there is none, so a
// generated link can never point at a heading that is not there.
export function resultsHeadingAnchor(markdown) {
  let heading = null;
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    const match = !fenced && line.match(/^## (Results.*?)\s*$/);
    if (match) heading = match[1];
  }
  if (heading === null) throw new Error('the evidence README has no level-2 "Results" heading to link to');
  return heading.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replace(/ /g, '-');
}

// Reads min/max from the SAME counted-cells aggregate the median itself comes from
// (by_runtime_arm[].duration_ms), not recomputed from cells[] independently -- a cell rejected
// from the count would otherwise feed the range but not the median it's paired with.
function durationRangeMinutes(group) {
  return `${(group.min / 60000).toFixed(1)}–${(group.max / 60000).toFixed(1)}`;
}

// When the rounded medians are equal, "same" already tells the whole story -- no range needed.
// When they differ, a bare "X vs Y min" on its own has misread as "kmp-test is slower" in review,
// when the actual driver was a couple of long-tail sessions, not every session. The per-session
// range plus a link into the evidence doc's full breakdown gives that context without asserting a
// cause the generator can't derive from its own inputs (that stays in the doc, out of the README).
function wallClockPhrase(withMinutes, withoutMinutes, withGroup, withoutGroup, runsPath, anchor) {
  const w = withMinutes.toFixed(1);
  const wo = withoutMinutes.toFixed(1);
  if (w === wo) return `same median wall-clock (${w} min)`;
  const withRange = durationRangeMinutes(withGroup);
  const withoutRange = durationRangeMinutes(withoutGroup);
  const breakdownLink = `${runsPath}/README.md#${anchor}`;
  return `median wall-clock ${w} vs ${wo} min (per-session range ${withRange} vs ${withoutRange} min; [breakdown](${breakdownLink}))`;
}

// "<DisplayName> · <model>". Schema 2 reads the model from provenance.model_resolved, the model the
// campaign actually recorded; schema 1 keeps its fixed labels.
export function runtimeModelLabel(summary, runtimeId) {
  return summary.schema === 2
    ? `${RUNTIME_DISPLAY_NAME[runtimeId]} · ${provenanceValue(summary, 'model_resolved', runtimeId)}`
    : RUNTIME_LABELS[runtimeId];
}

function buildKeyFactsBullet(summary) {
  const allGroups = RUNTIME_ORDER.flatMap(r => ARM_ORDER.map(a => findGroup(summary, r, a)));
  const atCeiling = allGroups.every(g => g.key_facts_match.matched === g.key_facts_match.of);
  if (atCeiling) {
    const totalMatched = allGroups.reduce((sum, g) => sum + g.key_facts_match.matched, 0);
    const totalOf = allGroups.reduce((sum, g) => sum + g.key_facts_match.of, 0);
    return `Both agents reported the key facts correctly in every session, with and without kmp-test (${totalMatched}/${totalOf}).`;
  }
  // Deterministic fallback: not exercised by this campaign's ceiling data, but
  // covered by a synthetic-fixture test so a future non-ceiling campaign has
  // a defined rendering, not a silent gap.
  const bits = RUNTIME_ORDER.map(r => {
    const gp = findGroup(summary, r, 'product');
    const gf = findGroup(summary, r, 'free');
    return `${runtimeModelLabel(summary, r)} reported the key facts correctly in ${fmtRatio(gp.key_facts_match)} sessions with kmp-test and ${fmtRatio(gf.key_facts_match)} without`;
  });
  return bits.join('; ') + '.';
}

function buildClaudeBullet(summary, costEstimate, runsPath, anchor) {
  const gp = findGroup(summary, 'claude-code', 'product');
  const gf = findGroup(summary, 'claude-code', 'free');
  const toolsWith = fmtToolCallsMedian(gp.tool_calls_total.median);
  const toolsWithout = fmtToolCallsMedian(gf.tool_calls_total.median);
  const wallWith = gp.duration_ms.median / 60000;
  const wallWithout = gf.duration_ms.median / 60000;
  const costWith = fmtCostRange(claudeCostRange(costEstimate, 'product'));
  const costWithout = fmtCostRange(claudeCostRange(costEstimate, 'free'));
  const wallPhrase = wallClockPhrase(wallWith, wallWithout, gp.duration_ms, gf.duration_ms, runsPath, anchor);
  return `Claude Code (Sonnet 5) with kmp-test: median ${toolsWith} tool calls vs ${toolsWithout} without, ${wallPhrase}, estimated API cost ${costWith} vs ${costWithout} per session.`;
}

function buildCodexBullet(summary, runsPath, anchor) {
  const gp = findGroup(summary, 'codex-cli', 'product');
  const gf = findGroup(summary, 'codex-cli', 'free');
  const toolsWith = fmtToolCallsMedian(gp.tool_calls_total.median);
  const toolsWithout = fmtToolCallsMedian(gf.tool_calls_total.median);
  const wallWith = gp.duration_ms.median / 60000;
  const wallWithout = gf.duration_ms.median / 60000;
  const wallPhrase = wallClockPhrase(wallWith, wallWithout, gp.duration_ms, gf.duration_ms, runsPath, anchor);
  return `Codex CLI (gpt-5.6-terra, low reasoning effort): median ${toolsWith} tool calls with kmp-test vs ${toolsWithout} without; ${wallPhrase}.`;
}

// Schema 2 only: one shape for either runtime, cost included whenever cost-estimate.runtimes
// covers it -- this is what lets Codex's bullet gain the same cost clause Claude's already has,
// without a second hardcoded, cost-shaped template to keep in sync by hand.
function buildRuntimeBullet(runtimeId, summary, costEstimate, runsPath, anchor) {
  const gp = findGroup(summary, runtimeId, 'product');
  const gf = findGroup(summary, runtimeId, 'free');
  const toolsWith = fmtToolCallsMedian(gp.tool_calls_total.median);
  const toolsWithout = fmtToolCallsMedian(gf.tool_calls_total.median);
  const wallWith = gp.duration_ms.median / 60000;
  const wallWithout = gf.duration_ms.median / 60000;
  const wallPhrase = wallClockPhrase(wallWith, wallWithout, gp.duration_ms, gf.duration_ms, runsPath, anchor);
  const displayName = RUNTIME_DISPLAY_NAME[runtimeId];
  const model = provenanceValue(summary, 'model_resolved', runtimeId);
  if (hasV2Cost(costEstimate, runtimeId)) {
    const costWith = fmtCostRange(runtimeCostRange(costEstimate, runtimeId, 'product'));
    const costWithout = fmtCostRange(runtimeCostRange(costEstimate, runtimeId, 'free'));
    return `${displayName} (${model}) with kmp-test: median ${toolsWith} tool calls vs ${toolsWithout} without, ${wallPhrase}, estimated API cost ${costWith} vs ${costWithout} per session.`;
  }
  return `${displayName} (${model}): median ${toolsWith} tool calls with kmp-test vs ${toolsWithout} without; ${wallPhrase}.`;
}

// One descriptive bullet per arm comparing the two agents' medians --
// n per cell as each group counted it, no inferential wording (states the numbers, never
// "faster"/"better"/causal). Omitted entirely for that arm when either agent's median is missing,
// rather than rendering a partial claim.
function buildCrossAgentBullet(summary, arm, armLabel) {
  const gClaude = findGroup(summary, 'claude-code', arm);
  const gCodex = findGroup(summary, 'codex-cli', arm);
  const claudeMedian = gClaude && gClaude.tool_calls_total && gClaude.tool_calls_total.median;
  const codexMedian = gCodex && gCodex.tool_calls_total && gCodex.tool_calls_total.median;
  if (typeof claudeMedian !== 'number' || typeof codexMedian !== 'number') return null;
  // Read from the group's own tool_calls_total.n (the exact count the median was computed from),
  // never a literal: a campaign's per-arm count is whatever its design says (a canary 1, a campaign 8)
  // and a group that lost a session to a rejection counts one fewer, so any literal would misreport.
  // Claude and Codex are independent per-runtime data and can diverge, so a shared figure is only used
  // when they genuinely agree.
  const claudeN = gClaude.tool_calls_total.n;
  const codexN = gCodex.tool_calls_total.n;
  const nLabel = claudeN === codexN ? `n=${claudeN} per cell` : `n=${claudeN} for Claude, n=${codexN} for Codex`;
  return `${armLabel} (descriptive): Codex ${fmtToolCallsMedian(codexMedian)} tool calls vs Claude ${fmtToolCallsMedian(claudeMedian)}, median, ${nLabel}.`;
}

// anchor (optional): the heading anchor the wall-clock breakdown links point at -- main() passes the
// one it reads from the record README; a caller that passes none keeps the legacy Evidence1 anchor.
export function buildBullets(summary, costEstimate, runsPath, anchor = RESULTS_HEADING_ANCHOR) {
  const keyFactsBullet = buildKeyFactsBullet(summary);
  if (summary.schema === 2) {
    const bullets = [
      keyFactsBullet,
      buildRuntimeBullet('claude-code', summary, costEstimate, runsPath, anchor),
      buildRuntimeBullet('codex-cli', summary, costEstimate, runsPath, anchor),
    ];
    const withBullet = buildCrossAgentBullet(summary, 'product', 'With kmp-test');
    const withoutBullet = buildCrossAgentBullet(summary, 'free', 'Without kmp-test');
    if (withBullet) bullets.push(withBullet);
    if (withoutBullet) bullets.push(withoutBullet);
    return bullets;
  }
  return [keyFactsBullet, buildClaudeBullet(summary, costEstimate, runsPath, anchor), buildCodexBullet(summary, runsPath, anchor)];
}

// ---------------------------------------------------------------------------
// README block

// Schema 2 only: "<DisplayName> <cli-version> · <model> · reasoning effort <value>" per runtime,
// read from provenance -- replaces schema 1's hand-typed equivalent so the Scope line can never
// drift from the model/effort a v2 campaign actually recorded.
function runtimeScopeClause(summary, runtimeId) {
  const displayName = RUNTIME_DISPLAY_NAME[runtimeId];
  const version = provenanceValue(summary, 'runtime_cli_version', runtimeId);
  const model = provenanceValue(summary, 'model_resolved', runtimeId);
  const effort = provenanceValue(summary, 'reasoning_effort', runtimeId);
  return `${displayName} ${version} · ${model} · reasoning effort ${effort}`;
}

// The grid image's alt text names the six rows as drawn, in order. The Codex note appears exactly
// when the tool-output row is not drawn for Codex CLI (toolOutputMeasured).
function buildGridAlt(summary) {
  const alt = 'Per-session detail (descriptive, not part of the pre-registered design): shell commands by kind, tokens per session by type, wall-clock, API cost, turns and tool output returned to the model for both agents, with vs without kmp-test.';
  return toolOutputMeasured(summary, 'codex-cli') ? alt : `${alt} Codex CLI tool output was not measured in this campaign.`;
}

// The facts about a scenario that the README wording and notes name, read from its two corpus files at generation time:
// the number of in-scope modules (the distinct modules among the `<module>:tasks` entries of the scenario's
// policy.allowed_gradle_tasks) and the number of failing test methods (expected.failed_count). Throws when either is
// missing, so a sentence can never state a number the corpus does not hold.
export function loadScenarioFacts(scenarioId, corpusDir = join(REPO_ROOT, 'tools', 'agentic-eval', 'corpus')) {
  const scenario = JSON.parse(readFileSync(join(corpusDir, 'scenarios', `${scenarioId}.json`), 'utf8'));
  const expected = JSON.parse(readFileSync(join(corpusDir, 'expected', `${scenarioId}.json`), 'utf8'));
  const tasks = Array.isArray(scenario.policy?.allowed_gradle_tasks) ? scenario.policy.allowed_gradle_tasks : [];
  const modules = new Set(tasks.filter((task) => typeof task === 'string' && task.endsWith(':tasks')).map((task) => task.slice(0, -':tasks'.length)));
  const failedCount = expected.expected?.failed_count;
  if (modules.size === 0) throw new Error(`scenario ${scenarioId}: allowed_gradle_tasks names no module (no "<module>:tasks" entry)`);
  if (!Number.isInteger(failedCount)) throw new Error(`scenario ${scenarioId}: expected.failed_count is not an integer`);
  return { moduleCount: modules.size, failedCount };
}

// The median of one per-session metric, formatted; throws when a counted cell lacks it (a note must not quote a median of a
// partial set).
function noteMedian(value, digits, what) {
  if (typeof value !== 'number') throw new Error(`README note: ${what} is not recorded for every counted session`);
  return value.toFixed(digits);
}

// Decimal KB (bytes / 1000), like the metrics grid's fmtBytes and the detailed document's tables: the same median must read the same
// number, under the same "KB" label, everywhere the README and the document show it.
function noteOutputKb(summary, runtimeId, arm) {
  const metric = scalarMetric(summary, findGroup(summary, runtimeId, arm), runtimeId, arm, 'output_bytes', () => null);
  return noteMedian(metric.kind === 'per-session' ? metric.median / 1000 : null, 1, `output_bytes of ${runtimeId} ${arm}`);
}

function noteCost(summary, costEstimate, runtimeId, arm) {
  const metric = costMetric(summary, findGroup(summary, runtimeId, arm), runtimeId, arm, costEstimate);
  return noteMedian(metric.kind === 'per-session' ? metric.median : null, 3, `the cost estimate of ${runtimeId} ${arm}`);
}

// A short paragraph the README block shows between its bullets and its Scope line, keyed by evidence number: a string, or a
// function of the campaign's data ({ summary, costEstimate, scenarioFacts }) that returns one. An evidence without an entry
// gets no note.
export const README_NOTES = {
  2: `Why the difference is modest here: the task is deliberately small (one module, two test methods), and most of a session's tokens are the agent's own context going through the prompt cache, in both arms. The saving comes mostly from fewer cache re-reads and fewer output tokens, and kmp-test's advantage in output volume grows with project size. [Full breakdown](docs/agentic-benchmark.md).`,
  3: ({ summary, costEstimate, scenarioFacts }) => {
    const kb = (runtimeId, arm) => noteOutputKb(summary, runtimeId, arm);
    const cost = (runtimeId, arm) => noteCost(summary, costEstimate, runtimeId, arm);
    return `On a larger task (${scenarioFacts.moduleCount} modules, ${scenarioFacts.failedCount} failing test methods), the median tool output returned to the model was ${kb('claude-code', 'product')} KB with kmp-test and ${kb('claude-code', 'free')} KB without for Claude Code; for Codex CLI, the median command output its commands produced (as logged) was ${kb('codex-cli', 'product')} KB and ${kb('codex-cli', 'free')} KB. The median estimated cost per session was $${cost('claude-code', 'product')} vs $${cost('claude-code', 'free')} for Claude Code and $${cost('codex-cli', 'product')} vs $${cost('codex-cli', 'free')} for Codex CLI. A smaller single-module task (Evidence2) and the full breakdown are in [docs/agentic-benchmark.md](docs/agentic-benchmark.md).`;
  },
};

// The evidence-specific wording of the README block, keyed by evidence number: what the intro says the task was and how many
// sessions were counted, and what the Scope line says about the scenario and its key facts. Everything else in the block is
// shared. Evidence2 keeps its exact strings. `scopeLead` is the part of the Scope line before "Windows 11 ..."; `scopeTail`
// follows the runtime clause. Evidence3's intro and Scope name the task through the scenario's corpus files (needsScenarioFacts).
export const README_WORDING = Object.freeze({
  2: Object.freeze({
    needsScenarioFacts: false,
    shown: () => 'Every session is shown; none was re-run or replaced.',
    intro: ({ introCount }) => `To check that this helps end to end, Claude Code and Codex CLI each ran the same pre-registered coverage-gate task on a pinned NowInAndroid commit${introCount}`,
    scopeLead: ({ scopeCount }) => `one scenario, tagged \`train\` (the skill was tuned on this task family); ${scopeCount}`,
    scopeTail: ' Key facts = module, outcome, coverage numbers.',
  }),
  3: Object.freeze({
    needsScenarioFacts: true,
    // Every session is shown, a missing one as missing data (a rejected session, or one lost to a failed guest call), and none was re-run or
    // replaced; the campaign's own first attempt, which failed on infrastructure and is not analyzed, is named so the sentence stays true.
    shown: ({ summary }) => {
      const missing = (summary.cells ?? []).filter((c) => c.status === 'missing').length;
      return `Every session is shown${missing > 0 ? `, ${missing} of them as missing data` : ''}; none was re-run or replaced. An earlier attempt of this campaign failed on infrastructure and is not analyzed (see the record).`;
    },
    intro: ({ phrase, scenarioFacts }) => `An agent gets one realistic task on NowInAndroid: run the unit tests of ${scenarioFacts.moduleCount} modules after a production-code change and report which tests fail. Sessions counted per arm and agent: ${phrase}.`,
    scopeLead: ({ phrase }) => `one scenario, tagged held-out; sessions counted per arm and agent: ${phrase}; key facts = outcome, failing modules, failing test classes and the failing-test count`,
    scopeTail: '',
  }),
});

// runsDirName (optional): the exact tools/runs/<...> directory to link/read from, e.g.
// "evidence2-agentic-benchmark-2026-09-30". Falls back to the historical
// evidence1-agentic-benchmark-<campaignDate> shape when omitted, so every existing caller that only
// ever passed a bare date keeps rendering byte-identical output (back-compat default -- see main()'s
// own --evidence=/--date= flags, which are the only caller expected to pass this explicitly).
// anchor (optional): the heading anchor of the record README's results section, which the
// wall-clock breakdown links point at -- see buildBullets.
// note (optional): a paragraph shown between the bullets and the Scope line (README_NOTES).
// evidenceN (optional, default 2): the evidence whose wording the intro and the Scope line use (README_WORDING). scenarioFacts:
// loadScenarioFacts' result, required by a wording that names the task (Evidence3's).
export function renderReadmeBlock(summary, campaignDate, costEstimate, runsDirName, anchor, note, evidenceN = 2, scenarioFacts = null) {
  const wording = README_WORDING[evidenceN];
  if (!wording) throw new Error(`no README wording for evidence ${evidenceN}`);
  if (wording.needsScenarioFacts && !scenarioFacts) throw new Error(`the README wording of evidence ${evidenceN} needs the scenario's facts (loadScenarioFacts)`);
  const runsPath = `tools/runs/${runsDirName || `evidence1-agentic-benchmark-${campaignDate}`}`;
  const bulletsText = buildBullets(summary, costEstimate, runsPath, anchor).map((b) => `- ${b}`).join('\n');
  const noteText = note ? `${note}\n\n` : '';
  const kmpTestVersion = kmpTestVersionOf(summary);
  const runtimeScopeText = summary.schema === 2
    ? `${runtimeScopeClause(summary, 'claude-code')}. ${runtimeScopeClause(summary, 'codex-cli')}.`
    : `Claude Code 2.1.238 · claude-sonnet-5 · effort not set by the harness (docs default: high). Codex CLI 0.154.0 · gpt-5.6-terra · reasoning effort low.`;
  // Both published run dirs (Evidence1 and Evidence2) carry a controls-audit.md, so the link set is
  // the same for either schema; the "every linked file exists" tests guard against a dead link.
  const evidenceLinks = `[Evidence, per-session detail and limitations](${runsPath}/README.md) · [controls audit](${runsPath}/controls-audit.md) · [pre-registration](${runsPath}/preregistration.md)`;
  // The per-arm session count (any sample size), stated through countPhrase in the intro and the Scope
  // line. One number keeps each sentence exactly as it always read; when the groups counted differently
  // (a rejected session is never replaced) the sentence names each group's count instead.
  const sessionPhrase = countPhrase(summary);
  const equalCounts = allEqual(sessionCounts(summary));
  const introCount = equalCounts
    ? `: ${sessionPhrase} sessions with the kmp-test skill and CLI, ${sessionPhrase} without.`
    : `. Sessions counted per arm and agent: ${sessionPhrase}.`;
  const scopeCount = equalCounts
    ? `n=${sessionPhrase} sessions per arm per agent in counterbalanced order`
    : `sessions in counterbalanced order, counted per arm and agent: ${sessionPhrase}`;

  return `<!-- agentic-benchmark:start (generated by tools/agentic-eval/readme-evidence.mjs from ${runsPath}/campaign-summary.json; edit the generator, not this block) -->
### Agent sessions with and without kmp-test

kmp-test hands an agent the test and coverage verdict as one JSON envelope instead of Gradle logs and report files. ${wording.intro({ introCount, phrase: sessionPhrase, scenarioFacts })} ${wording.shown({ summary })}

![${buildScorecardAlt(summary, costEstimate)}](${runsPath}/scorecard.svg)

![${buildGridAlt(summary)}](${runsPath}/metrics-grid.svg)

${bulletsText}

${noteText}**Scope:** ${wording.scopeLead({ scopeCount, phrase: sessionPhrase })}; Windows 11 in an isolated VM with a restricted network (provider APIs only); design and metrics fixed before any live session. kmp-test ${kmpTestVersion}. ${runtimeScopeText}${wording.scopeTail} ${evidenceLinks}
<!-- agentic-benchmark:end -->`;
}

// ---------------------------------------------------------------------------
// Overview -- ONE figure and ONE README block for every published scenario.
//
// The registry (tools/runs/agentic-benchmark-campaigns.json) lists the campaigns in the order they are drawn; each entry's directory
// holds the committed summary and cost estimate that every value comes from, so nothing in the figure or the block is typed by hand.
// The figure has one block per scenario and one row per agent: tool calls, estimated API cost and wall-clock as bars with one scale per
// column (the largest value over every scenario, agent and arm) and the value at the end of each bar, and the key facts as matched/counted.
// The block is the intro sentence, the figure, one bullet per scenario and a closing line; the same figure is shown at the top of
// docs/agentic-benchmark.md. Never a ratio, a comparison across scenarios, or a full-answer number.

export const OVERVIEW_REGISTRY_PATH = join(REPO_ROOT, 'tools', 'runs', 'agentic-benchmark-campaigns.json');
export const OVERVIEW_SVG_PATH = join(REPO_ROOT, 'tools', 'runs', 'agentic-benchmark-overview.svg');
const OVERVIEW_SVG_REL = 'tools/runs/agentic-benchmark-overview.svg';
const OVERVIEW_DEFAULT_PATHS = Object.freeze({
  svgPath: OVERVIEW_SVG_PATH,
  readmePath: join(REPO_ROOT, 'README.md'),
  docPath: join(REPO_ROOT, 'docs', 'agentic-benchmark.md'),
});
const CAMPAIGN_DIR_RE = /^evidence(\d+)-agentic-benchmark-\d{4}-\d{2}-\d{2}$/;
const OVERVIEW_TITLE = 'Agent sessions with and without kmp-test';
const OVERVIEW_SUBTITLE = 'Median per session. Each scenario is its own pre-registered campaign on NowInAndroid and compares only its own two arms; bars share one scale per column.';
const OVERVIEW_INTRO = 'kmp-test hands an agent the test and coverage verdict as one JSON envelope instead of Gradle logs and report files.';
const OVERVIEW_CLOSING = 'Each scenario is a separate pre-registered campaign and compares only its own two arms. Method, per-scenario charts, every session and limitations: [docs/agentic-benchmark.md](docs/agentic-benchmark.md).';
const README_START = '<!-- agentic-benchmark:start';
const README_END = '<!-- agentic-benchmark:end -->';
const DOC_START = '<!-- agentic-benchmark-overview:start';
const DOC_END = '<!-- agentic-benchmark-overview:end -->';

// Geometry of the figure (the design the user approved): bars of up to BAR_MAX px in three columns, the key facts in a fourth.
const OVERVIEW_BAR_MAX = 118;
const OVERVIEW_BAR_H = 11;
const OVERVIEW_LANE_GAP = 5;
const OVERVIEW_VALUE_GAP = 6;
const OVERVIEW_KEY_FACTS_X = 744;
const fmtUsd3 = (v) => `$${v.toFixed(3)}`;
const fmtMinutes1 = (v) => `${v.toFixed(1)} min`;
const OVERVIEW_COLUMNS = Object.freeze([
  Object.freeze({ key: 'calls', head: 'Tool calls', x: 196, fmt: (v) => fmtToolCallsMedian(v) }),
  Object.freeze({ key: 'cost', head: 'Est. API cost', x: 376, fmt: fmtUsd3 }),
  Object.freeze({ key: 'wall', head: 'Wall-clock', x: 556, fmt: fmtMinutes1 }),
]);

/**
 * Loads and validates the registry: every campaign directory with its summary and cost estimate. One failure reason per check, each naming the
 * directory it concerns: schema 1; at least one campaign; unique dirs; a directory name evidence<N>-agentic-benchmark-<date> (the figure names the
 * evidence from it); the directory and its campaign-summary.json, cost-estimate.json and README.md exist; a non-empty label; the summary passes
 * validateSummary and pairs with its cost estimate (validatePairing). `runsRoot` is where the directories are (the registry's own folder).
 */
export function loadCampaignRegistry(registryPath = OVERVIEW_REGISTRY_PATH, runsRoot = dirname(registryPath)) {
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch (err) {
    throw new Error(`campaign registry ${registryPath} is not valid JSON: ${err.message}`);
  }
  if (!registry || registry.schema !== 1) throw new Error('campaign registry: schema must be 1');
  if (!Array.isArray(registry.campaigns) || registry.campaigns.length === 0) throw new Error('campaign registry: it must list at least one campaign');
  const seen = new Set();
  for (const entry of registry.campaigns) {
    const dir = entry && entry.dir;
    if (seen.has(dir)) throw new Error(`campaign registry: duplicate dir ${dir}`);
    seen.add(dir);
  }
  return registry.campaigns.map((entry) => {
    const dir = entry.dir;
    const match = typeof dir === 'string' ? CAMPAIGN_DIR_RE.exec(dir) : null;
    if (!match) throw new Error(`${dir}: the directory name must be evidence<N>-agentic-benchmark-<yyyy-mm-dd>`);
    const runDir = join(runsRoot, dir);
    if (!existsSync(runDir)) throw new Error(`${dir}: directory not found`);
    for (const name of ['campaign-summary.json', 'cost-estimate.json', 'README.md']) {
      if (!existsSync(join(runDir, name))) throw new Error(`${dir}: ${name} not found`);
    }
    if (typeof entry.label !== 'string' || entry.label.trim() === '') throw new Error(`${dir}: label must be a non-empty string`);
    let summary;
    let costEstimate;
    try {
      summary = loadSummary(join(runDir, 'campaign-summary.json'));
      costEstimate = loadCostEstimate(join(runDir, 'cost-estimate.json'));
    } catch (err) {
      throw new Error(`${dir}: ${err.message}`);
    }
    const pairingErrors = validatePairing(summary, costEstimate);
    if (pairingErrors.length > 0) throw new Error(`${dir}: campaign-summary.json / cost-estimate.json mismatch:\n  ${pairingErrors.join('\n  ')}`);
    return { dir, label: entry.label, evidenceN: Number(match[1]), summary, costEstimate };
  });
}

/** One group's medians as the figure prints them: tool calls and wall-clock from the summary's group aggregate (the scorecard's source), cost
 * as the median per-session list-price estimate, key facts as matched/counted. Throws when a value is not recorded. */
function overviewGroupValues(campaign, runtimeId, arm) {
  const group = findGroup(campaign.summary, runtimeId, arm);
  const need = (value, what) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${campaign.dir}: ${runtimeId} ${arm} has no ${what}`);
    return value;
  };
  const cost = costMetric(campaign.summary, group, runtimeId, arm, campaign.costEstimate);
  return {
    calls: need(group.tool_calls_total && group.tool_calls_total.median, 'tool-call median'),
    cost: need(cost.kind === 'per-session' ? cost.median : null, 'cost median'),
    wall: need(group.duration_ms && group.duration_ms.median, 'wall-clock median') / 60000,
    keyFacts: `${group.key_facts_match.matched}/${group.key_facts_match.of}`,
  };
}

// The session counts of a scenario, as "<with> + <without> sessions per agent" ("counted" when some session is missing, because a rejected or
// lost session is never replaced), or each agent's own when the agents counted differently.
function overviewCounts(summary) {
  const groups = RUNTIME_ORDER.map((runtimeId) => ARM_ORDER.map((arm) => findGroup(summary, runtimeId, arm)));
  const counted = groups.map((pair) => pair.map(countedOf));
  const allCounted = groups.every((pair) => pair.every((g) => countedOf(g) === g.declared));
  if (counted.every((pair) => pair[0] === counted[0][0] && pair[1] === counted[0][1])) {
    return `${counted[0][0]} + ${counted[0][1]} sessions${allCounted ? '' : ' counted'} per agent`;
  }
  return `sessions counted: ${RUNTIME_ORDER.map((runtimeId, i) => `${RUNTIME_DISPLAY_NAME[runtimeId]} ${counted[i][0]} + ${counted[i][1]}`).join(' · ')}`;
}

/** The figure's layout, as the items every test and the SVG renderer read: { width, height, items }. */
export function computeOverviewLayout(campaigns) {
  const data = campaigns.map((campaign) => ({
    campaign,
    meta: `Evidence${campaign.evidenceN} · ${overviewCounts(campaign.summary)}`,
    rows: RUNTIME_ORDER.map((runtimeId) => ({
      runtimeId,
      model: provenanceValue(campaign.summary, 'model_resolved', runtimeId),
      lanes: ARM_ORDER.map((arm) => overviewGroupValues(campaign, runtimeId, arm)),
    })),
  }));
  // One scale per column: the largest value of that column over every scenario, agent and arm.
  const columnMax = Object.fromEntries(OVERVIEW_COLUMNS.map((col) => [col.key, Math.max(...data.flatMap((d) => d.rows.flatMap((row) => row.lanes.map((lane) => lane[col.key]))), 1e-9)]));

  const items = [];
  let y = PAD + 20;
  items.push(textItem('overviewTitle', null, PAD, y, 20, 600, COLOR_TEXT, OVERVIEW_TITLE));
  y += 26;
  wrapWords(OVERVIEW_SUBTITLE, 13, GRID_W - 2 * PAD).forEach((line, i) => {
    if (i > 0) y += 17;
    items.push(textItem('overviewSubtitle', null, PAD, y, 13, 400, COLOR_SECONDARY, line));
  });
  y += 26;
  items.push({ kind: 'legendSwatch', column: null, x: PAD, y: y - 9.5, w: 10, h: 10, rx: 0, fill: COLOR_WITH });
  items.push(textItem('overviewLegend', null, PAD + 15, y, 12, 400, COLOR_SECONDARY, 'with kmp-test'));
  items.push({ kind: 'legendSwatch', column: null, x: PAD + 112, y: y - 9.5, w: 10, h: 10, rx: 0, fill: COLOR_WITHOUT });
  items.push(textItem('overviewLegend', null, PAD + 127, y, 12, 400, COLOR_SECONDARY, 'without'));
  y += 30;
  for (const col of OVERVIEW_COLUMNS) items.push(textItem('overviewColumnHead', col.key, col.x, y, 13, 600, COLOR_TEXT, col.head));
  items.push(textItem('overviewColumnHead', 'kf', OVERVIEW_KEY_FACTS_X, y, 13, 600, COLOR_TEXT, 'Key facts correct'));
  y += 8;

  const laneY = (top, i) => top + i * (OVERVIEW_BAR_H + OVERVIEW_LANE_GAP);
  for (const d of data) {
    y += 26;
    items.push(textItem('overviewScenarioTitle', null, PAD, y, 14, 600, COLOR_TEXT, d.campaign.label));
    y += 17;
    items.push(textItem('overviewScenarioMeta', null, PAD, y, 12, 400, COLOR_SECONDARY, d.meta));
    y += 10;
    for (const row of d.rows) {
      const top = y + 6;
      items.push(textItem('overviewAgent', null, PAD, top + 11, 13, 500, COLOR_TEXT, RUNTIME_DISPLAY_NAME[row.runtimeId]));
      items.push(textItem('overviewModel', null, PAD, top + 26, 11.5, 400, COLOR_SECONDARY, row.model));
      for (const col of OVERVIEW_COLUMNS) {
        row.lanes.forEach((lane, i) => {
          const barY = laneY(top, i);
          const w = (lane[col.key] / columnMax[col.key]) * OVERVIEW_BAR_MAX;
          items.push({ kind: 'bar', role: 'overviewBar', column: col.key, x: col.x, y: barY, w, h: OVERVIEW_BAR_H, rx: 1, fill: i === 0 ? COLOR_WITH : COLOR_WITHOUT });
          items.push(textItem('overviewValue', col.key, col.x + w + OVERVIEW_VALUE_GAP, barY + OVERVIEW_BAR_H - 1.5, 12, 400, COLOR_TEXT, col.fmt(lane[col.key])));
        });
      }
      row.lanes.forEach((lane, i) => {
        items.push(textItem('overviewKeyFacts', 'kf', OVERVIEW_KEY_FACTS_X, laneY(top, i) + OVERVIEW_BAR_H - 1.5, 12, 600, i === 0 ? COLOR_WITH : COLOR_WITHOUT, lane.keyFacts));
      });
      y = top + 2 * OVERVIEW_BAR_H + OVERVIEW_LANE_GAP + 8;
    }
    y += 6;
  }
  // The card ends one PAD below its lowest item (a text's baseline plus its glyph descent, or a bar's bottom).
  const bottoms = items.map((item) => (item.kind === 'text' ? item.y + item.fontSize * 0.25 : item.y + item.h));
  return { width: GRID_W, height: Math.round(Math.max(...bottoms) + PAD), items };
}

/** The figure's alt text: one clause per scenario and agent, with the values it prints (with kmp-test vs without). */
export function buildOverviewAlt(campaigns) {
  const clauses = campaigns.map((campaign) => {
    const rows = RUNTIME_ORDER.map((runtimeId) => {
      const [w, wo] = ARM_ORDER.map((arm) => overviewGroupValues(campaign, runtimeId, arm));
      return `${RUNTIME_DISPLAY_NAME[runtimeId]}: ${fmtToolCallsMedian(w.calls)} vs ${fmtToolCallsMedian(wo.calls)} tool calls, ${fmtUsd3(w.cost)} vs ${fmtUsd3(wo.cost)}, ${fmtMinutes1(w.wall)} vs ${fmtMinutes1(wo.wall)}, key facts ${w.keyFacts} vs ${wo.keyFacts}`;
    });
    return `${campaign.label} (Evidence${campaign.evidenceN}): ${rows.join('; ')}.`;
  });
  return `Median per session with kmp-test vs without, one block per scenario, bars on one scale per column. ${clauses.join(' ')}`;
}

export function renderOverviewSvg(campaigns) {
  const layout = computeOverviewLayout(campaigns);
  const parts = layout.items.map((item) => {
    if (item.kind === 'text') {
      const anchorAttr = item.anchor !== 'start' ? ` text-anchor="${item.anchor}"` : '';
      return `<text x="${item.x.toFixed(1)}" y="${item.y.toFixed(1)}" font-size="${item.fontSize}" font-weight="${item.fontWeight}" fill="${item.fill}"${anchorAttr}>${escapeXml(item.text)}</text>`;
    }
    return `<rect x="${item.x.toFixed(1)}" y="${item.y.toFixed(1)}" width="${item.w.toFixed(1)}" height="${item.h}" rx="${item.rx}" fill="${item.fill}"/>`;
  });
  const desc = `Median per session for Claude Code and Codex CLI, with kmp-test (${COLOR_WITH}) and without (${COLOR_WITHOUT}), one block per published scenario. Bars share one scale per column: tool calls, estimated API cost and wall-clock. The last column is the sessions whose key facts were all correct out of the sessions counted.`;
  return `<svg viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" xmlns="http://www.w3.org/2000/svg" role="img" font-family="${FONT_STACK}">
  <title>${escapeXml(OVERVIEW_TITLE)}</title>
  <desc>${escapeXml(desc)}</desc>
  <rect x="1" y="1" width="${layout.width - 2}" height="${layout.height - 2}" rx="12" fill="${COLOR_CARD_FILL}" stroke="${COLOR_CARD_STROKE}" stroke-width="1"/>
  ${parts.join('\n  ')}
</svg>
`;
}

// One scenario's bullet: the label, its evidence and counts, the medians with kmp-test vs without for each agent, the versions its provenance
// records and the link to its record. Values only: no ratio, no word that ranks.
function overviewBullet(campaign) {
  const { summary } = campaign;
  const [claude, codex] = RUNTIME_ORDER.map((runtimeId) => ARM_ORDER.map((arm) => overviewGroupValues(campaign, runtimeId, arm)));
  const pair = (lanes, key, fmt) => `${fmt(lanes[0][key])} vs ${fmt(lanes[1][key])}`;
  const same = (v) => v;
  const versions = [`kmp-test ${kmpTestVersionOf(summary)}`, ...RUNTIME_ORDER.map((runtimeId) => `${RUNTIME_DISPLAY_NAME[runtimeId]} ${provenanceValue(summary, 'runtime_cli_version', runtimeId)}`)].join(' · ');
  return `**${campaign.label}** (Evidence${campaign.evidenceN}, ${overviewCounts(summary)}): median tool calls ${pair(claude, 'calls', fmtToolCallsMedian)} (Claude Code) and ${pair(codex, 'calls', fmtToolCallsMedian)} (Codex CLI); median estimated cost ${pair(claude, 'cost', fmtUsd3)} and ${pair(codex, 'cost', fmtUsd3)}; key facts ${pair(claude, 'keyFacts', same)} and ${pair(codex, 'keyFacts', same)}. ${versions}. [Record](tools/runs/${campaign.dir}/README.md)`;
}

/** The root README block: the intro sentence, the figure, one bullet per scenario and the closing line, between the agentic-benchmark markers. */
export function renderOverviewBlock(campaigns) {
  const bullets = campaigns.map((campaign) => `- ${overviewBullet(campaign)}`).join('\n');
  return `${README_START} (generated by tools/agentic-eval/readme-evidence.mjs --overview from tools/runs/agentic-benchmark-campaigns.json; edit the generator or the registry, not this block) -->
### ${OVERVIEW_TITLE}

${OVERVIEW_INTRO}

![${buildOverviewAlt(campaigns)}](${OVERVIEW_SVG_REL})

${bullets}

${OVERVIEW_CLOSING}
${README_END}`;
}

/** The detailed document's block: the same figure with the same alt text, one directory up from the document. */
export function renderOverviewDocBlock(campaigns) {
  return `${DOC_START} (generated by tools/agentic-eval/readme-evidence.mjs --overview from tools/runs/agentic-benchmark-campaigns.json; do not edit) -->
![${buildOverviewAlt(campaigns)}](../${OVERVIEW_SVG_REL})
${DOC_END}`;
}

const lf = (text) => text.replace(/\r\n/g, '\n');

function blockBetween(text, start, end) {
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  return s === -1 || e === -1 || e < s ? null : text.slice(s, e + end.length);
}

function spliceBlock(text, start, end, block, fileLabel, markerLabel) {
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (s === -1 || e === -1 || e < s) throw new Error(`${fileLabel} is missing the ${markerLabel} markers`);
  return text.slice(0, s) + block + text.slice(e + end.length);
}

/** The files whose committed text differs from what the registry generates, line endings ignored (a Windows autocrlf checkout holds CRLF). */
export function checkOverview(campaigns, paths = {}) {
  const { svgPath, readmePath, docPath } = { ...OVERVIEW_DEFAULT_PATHS, ...paths };
  const stale = [];
  if (!existsSync(svgPath) || lf(readFileSync(svgPath, 'utf8')) !== renderOverviewSvg(campaigns)) stale.push(svgPath);
  const readme = existsSync(readmePath) ? lf(readFileSync(readmePath, 'utf8')) : '';
  if (blockBetween(readme, README_START, README_END) !== renderOverviewBlock(campaigns)) stale.push(readmePath);
  const doc = existsSync(docPath) ? lf(readFileSync(docPath, 'utf8')) : '';
  if (blockBetween(doc, DOC_START, DOC_END) !== renderOverviewDocBlock(campaigns)) stale.push(docPath);
  return stale;
}

/** Writes the figure and both blocks. Both marker pairs are checked before anything is written; a file without its markers is an error, never an append. */
export function writeOverview(campaigns, paths = {}) {
  const { svgPath, readmePath, docPath } = { ...OVERVIEW_DEFAULT_PATHS, ...paths };
  const readme = spliceBlock(readFileSync(readmePath, 'utf8'), README_START, README_END, renderOverviewBlock(campaigns), 'README.md', 'agentic-benchmark:start/end');
  const doc = spliceBlock(readFileSync(docPath, 'utf8'), DOC_START, DOC_END, renderOverviewDocBlock(campaigns), 'docs/agentic-benchmark.md', 'agentic-benchmark-overview:start/end');
  writeFileSync(svgPath, renderOverviewSvg(campaigns));
  writeFileSync(readmePath, readme);
  writeFileSync(docPath, doc);
  return [svgPath, readmePath, docPath];
}

/** An evidence's own charts whose committed text differs from what its summary generates, line endings ignored (a Windows autocrlf checkout holds CRLF). */
export function checkEvidenceCharts(summary, costEstimate, { scorecardPath, metricsGridPath }) {
  const stale = [];
  if (!existsSync(scorecardPath) || lf(readFileSync(scorecardPath, 'utf8')) !== renderScorecardSvg(summary, costEstimate)) stale.push(scorecardPath);
  if (!existsSync(metricsGridPath) || lf(readFileSync(metricsGridPath, 'utf8')) !== renderMetricsGridSvg(summary, costEstimate)) stale.push(metricsGridPath);
  return stale;
}

// ---------------------------------------------------------------------------
// CLI

function mainOverview(argv) {
  let campaigns;
  try {
    campaigns = loadCampaignRegistry();
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
  if (argv.includes('--check')) {
    const stale = checkOverview(campaigns);
    if (stale.length > 0) {
      console.error(`::error::out of date, run with --overview: ${stale.join(', ')}`);
      process.exit(1);
    }
    console.log('Overview figure, README block and document block are up to date.');
    return;
  }
  try {
    console.log(writeOverview(campaigns).map((path) => `Wrote ${path}`).join('\n'));
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}

function main(argv) {
  if (argv.includes('--overview')) return mainOverview(argv);
  const mode = argv.includes('--write') ? 'write' : 'check';
  const campaignDate = (argv.find(a => a.startsWith('--date=')) || '--date=2026-09-28').split('=')[1];
  // --evidence=<n> selects which evidenceN-agentic-benchmark-<date> run dir to read/write; default
  // 1 reproduces the exact historical directory name (back-compat default for every caller that
  // predates this flag).
  const evidenceN = (argv.find(a => a.startsWith('--evidence=')) || '--evidence=1').split('=')[1];
  const runsDirName = `evidence${evidenceN}-agentic-benchmark-${campaignDate}`;
  const runsDir = join(REPO_ROOT, 'tools', 'runs', runsDirName);
  const summaryPath = join(runsDir, 'campaign-summary.json');
  const costEstimatePath = join(runsDir, 'cost-estimate.json');

  if (!existsSync(summaryPath)) {
    console.error(`::error::campaign-summary.json not found at ${summaryPath}`);
    process.exit(1);
  }
  if (!existsSync(costEstimatePath)) {
    console.error(`::error::cost-estimate.json not found at ${costEstimatePath}`);
    process.exit(1);
  }

  let summary, costEstimate;
  try {
    summary = loadSummary(summaryPath);
    costEstimate = loadCostEstimate(costEstimatePath);
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }

  const pairingErrors = validatePairing(summary, costEstimate);
  if (pairingErrors.length > 0) {
    console.error(`::error::campaign-summary.json / cost-estimate.json mismatch:\n  ${pairingErrors.join('\n  ')}`);
    process.exit(1);
  }

  const scorecardPath = join(runsDir, 'scorecard.svg');
  const metricsGridPath = join(runsDir, 'metrics-grid.svg');

  // An evidence checks and writes its own two SVGs only: the root README block belongs to the overview (--overview).
  if (mode === 'write') {
    writeFileSync(scorecardPath, renderScorecardSvg(summary, costEstimate));
    writeFileSync(metricsGridPath, renderMetricsGridSvg(summary, costEstimate));
    console.log(`Wrote ${scorecardPath}\nWrote ${metricsGridPath}`);
    return;
  }

  // check mode: regenerate and diff against what's committed
  const mismatches = checkEvidenceCharts(summary, costEstimate, { scorecardPath, metricsGridPath });
  if (mismatches.length > 0) {
    console.error(`::error::out of date, run with --write: ${mismatches.join(', ')}`);
    process.exit(1);
  }
  console.log(`Evidence ${evidenceN} charts are up to date.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

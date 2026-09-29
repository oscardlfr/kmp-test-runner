#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/readme-evidence.mjs — deterministic generator that turns a
// committed campaign-summary.json + cost-estimate.json into one scorecard SVG
// and the README block between <!-- agentic-benchmark:start/end -->.
//
// Usage:
//   node tools/agentic-eval/readme-evidence.mjs --check   (default) exits 1 if
//     regenerating would change any committed file
//   node tools/agentic-eval/readme-evidence.mjs --write   writes scorecard.svg
//     and the README block in place
//
// Never edit scorecard.svg or the README block between the markers by hand --
// edit this generator (or the campaign-summary.json / cost-estimate.json it
// reads) and regenerate. Fails closed unless the summary is summary_status:"ok",
// provider_mode:"live", schema 1, with all 4 (runtime x arm) groups declaring
// exactly 4 cells each, and cost-estimate.json is schema 1 with 4 claude-code
// cells per arm and a complete price table -- a partial or non-live summary,
// or an incomplete cost estimate, must never render.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

// GitHub-palette colors, chosen to render identically on GitHub's and npm's
// markdown sanitizers (presentation attributes only, no <style>/CSS).
const COLOR_TEXT = '#1f2328';
const COLOR_SECONDARY = '#59636e';
const COLOR_GRID = '#d8dee4';
const COLOR_WITH = '#0969da';
// #d4a72c (GitHub's own "attention" yellow) fails the 3:1 contrast-on-white
// floor for non-text UI elements (~2.24:1, WCAG relative-luminance formula);
// #bc4c00 passes (~5.03:1). See the contrast-ratio test in the test suite.
const COLOR_WITHOUT = '#bc4c00';
const COLOR_CARD_FILL = '#ffffff';
const COLOR_CARD_STROKE = '#d0d7de';
const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";

const RUNTIME_LABELS = {
  'claude-code': 'Claude Code · claude-sonnet-5',
  'codex-cli': 'Codex CLI · gpt-5.6-terra',
};
const RUNTIME_KEY = { 'claude-code': 'CLAUDE', 'codex-cli': 'CODEX' };
const RUNTIME_DISPLAY_NAME = { 'claude-code': 'Claude Code', 'codex-cli': 'Codex CLI' };
const RUNTIME_ORDER = ['claude-code', 'codex-cli'];
const ARM_ORDER = ['product', 'free']; // "with kmp-test" before "without kmp-test"
const ARM_LABEL = { product: 'with kmp-test', free: 'without kmp-test' };

// ---------------------------------------------------------------------------
// Loading + validation -- fails closed on anything but a complete, live summary

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
  for (const runtime of RUNTIME_ORDER) {
    for (const arm of ARM_ORDER) {
      const g = groups.find(x => x.runtime_id === runtime && x.arm === arm);
      if (!g) { errors.push(`missing group for ${runtime}/${arm}`); continue; }
      if (g.declared !== 4) errors.push(`${runtime}/${arm}: declared must be 4, got ${g.declared}`);
      // wallClockPhrase reads duration_ms.min/max directly (the same aggregate as the median) to
      // render the per-session range -- a group missing either, or a non-numeric value, must fail
      // closed here, not render literal "NaN–NaN" in the README.
      const d = g.duration_ms || {};
      if (!(Number.isFinite(d.min) && Number.isFinite(d.max) && d.min <= d.median && d.median <= d.max)) {
        errors.push(`${runtime}/${arm}: duration_ms.min/median/max must be finite with min <= median <= max, got ${JSON.stringify(d)}`);
      }
    }
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
    const cells = Array.isArray(doc.cells) ? doc.cells : [];
    for (const arm of ARM_ORDER) {
      const n = cells.filter(c => c.runtime_id === 'claude-code' && c.arm === arm).length;
      if (n !== 4) errors.push(`expected 4 claude-code/${arm} cells, got ${n}`);
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
        if (n !== 4) errors.push(`runtimes.${runtimeId}: expected 4 ${arm} cells, got ${n}`);
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
export function validatePairing(summary, costEstimate) {
  const errors = [];
  if (summary.schema !== costEstimate.schema) {
    errors.push(`summary schema ${JSON.stringify(summary.schema)} does not match cost-estimate schema ${JSON.stringify(costEstimate.schema)}`);
    return errors;
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
    }
  }
  return errors;
}

// One session's cost at a given per-million-token price table. inputPrice defaults to the plain
// input rate; a runtime whose usage events can't distinguish a cache write from a plain input
// token (see armCostRange below) overrides it for the high bound only.
function sessionCost(tokens, price, cacheWriteKey, inputPrice = price.input) {
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

function fmtToolCallsMedian(median) {
  return String(Math.round(median));
}

// ---------------------------------------------------------------------------
// Bar metrics shared by the scorecard chart and the bullets -- tool calls,
// wall-clock and (Claude only) cost. Key facts is a plain text line, not a
// bar: an all-4/4 result renders every bar identically full and conveys
// nothing, so it is stated as text instead (see computeScorecardLayout).

// Raw (unscaled) values only -- WO-C12 addendum point 1 requires the SAME 0..max scale for both
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
const PAD = 28;
const ROW_GAP = 14; // minimum vertical gap between two text rows' allocated space
const COLUMN_GAP = 32;
const COLUMN_W = (SCORECARD_W - 2 * PAD - COLUMN_GAP) / 2;
const BAR_AREA_W = 300; // gutter + bar, unchanged total footprint from before the gutter existed
const GUTTER_W = 60; // fixed left gutter for each bar row's own "with"/"without" arm label
const BAR_MAX_W = BAR_AREA_W - GUTTER_W;
const BAR_H = 14;
const BAR_ROW_GAP = 6;
const BLOCK_GAP = 24;
const VALUE_LABEL_X_OFFSET = 12;
const ARM_LABEL_FS = 11;

function textItem(role, column, x, y, fontSize, fontWeight, fill, text, anchor) {
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
  items.push(textItem('subtitle', null, PAD, subtitleY, subtitleFS, 400, COLOR_SECONDARY,
    '1 pre-registered scenario · 4 sessions per arm per agent · Windows 11 · details in the evidence doc'));

  const headerBottom = subtitleY + ROW_GAP;

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

  // Raw metrics for BOTH columns first, then shared fracs (WO-C12 addendum) -- a shared max needs
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

function escapeXml(s) {
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
    const runtimeLabel = summary.schema === 2
      ? `${RUNTIME_DISPLAY_NAME[runtimeId]} · ${provenanceValue(summary, 'model_resolved', runtimeId)}`
      : RUNTIME_LABELS[runtimeId];
    parts.push(`${runtimeLabel} — ${bits.join('; ')}`);
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
// campaign" text, and tool-result volume (the one metric explicitly gated on
// availability) is omitted from the grid entirely rather than showing either.

const GRID_W = SCORECARD_W;
const GRID_DOT_R = 3;
// WO-C12 redesign: numbers-first, in the scorecard's own visual language. Two row shapes, each a
// stack of non-overlapping bands (header, lane(s), footer), height = sum of only the bands used:
//   STRIP rows (scalar metrics) -- two lanes stacked VERTICALLY sharing one horizontal axis (0 to
//   a nice max), dots in the arm's own color (scorecard COLOR_WITH/COLOR_WITHOUT), a median tick,
//   the median value printed to the right, 3 axis-tick labels shared below both lanes.
//   COMPOSITION rows (tool calls by kind, tokens by type) -- two lanes, each ONE horizontal
//   stacked bar of per-component MEDIANS (never per-session mini-bars), a total at the end, one
//   legend line below both bars giving each component's with-vs-without value.
const GRID_HEADER_FS = 13;
const GRID_HEADER_H = 18;
const GRID_LANE_LABEL_FS = 11;
const GRID_LANE_LABEL_W = 92; // "with kmp-test" / "without" text budget
const GRID_VALUE_LABEL_FS = 11;
const GRID_VALUE_LABEL_GAP = 8;
const GRID_VALUE_LABEL_W = 96; // "median 190.0 s" text budget
const GRID_STRIP_AXIS_W = COLUMN_W - GRID_LANE_LABEL_W - GRID_VALUE_LABEL_GAP - GRID_VALUE_LABEL_W;
const GRID_STRIP_LANE_H = 20;
const GRID_TICK_FS = 9;
const GRID_TICK_H = 16;
const GRID_COMP_BAR_H = 14;
const GRID_COMP_BAR_GAP = 4;
const GRID_COMP_TOTAL_LABEL_W = 46;
const GRID_COMP_BAR_W = COLUMN_W - GRID_LANE_LABEL_W - GRID_COMP_TOTAL_LABEL_W;
const GRID_ROW_GAP = 14; // clearance before the next row (WO-C10 required >= 10px; kept generous)
// WO-C15: distinct from COLOR_WITH/COLOR_WITHOUT (#0969da/#bc4c00) on purpose -- kmp_test and gradle
// used to reuse those exact hex values, so a lane whose bar happened to be 100% one type (every FAKE
// -DATA session this campaign) rendered as a solid blue/orange bar indistinguishable from "this is
// just the arm's own color". With real, mixed-type data the two encodings (arm color in strip rows /
// scorecard, component-type color here) would otherwise collide and mislead a reader.
const COMMAND_KIND_COLORS = { kmp_test: '#8250df', gradle: '#1a7f37', other: '#59636e' };
const COMMAND_KIND_LABEL = { kmp_test: 'kmp-test', gradle: 'gradle', other: 'other' };
const GRID_LEGEND_FS = 9;
const GRID_LEGEND_SWATCH = 8;

function medianOf(values) {
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
function scalarMetric(summary, group, runtimeId, arm, cellField, aggregateOf) {
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

// A composition row's per-component MEDIANS for one lane -- WO-C12 always renders ONE bar per
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
function compositionMedians(summary, group, runtimeId, arm, cellField, types, aggregateOf) {
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
// charges. Stacking the raw fields as-is (the pre-WO-C13 bug) double-counted Codex's cached and
// reasoning tokens into its own totals. Identical canonical labels across both runtimes (WO-C13):
// "uncached input", "cache read", "cache write", "output", "reasoning".
const TOKEN_COMPONENT_TYPES = {
  'claude-code': ['uncached_input', 'cache_read', 'cache_write', 'output'],
  'codex-cli': ['uncached_input', 'cache_read', 'output', 'reasoning'], // Codex never has a cache-write token count (cost-estimate.mjs: cache_creation = 0 always)
};
// WO-C15: cache_read and output used to reuse COLOR_WITH/COLOR_WITHOUT exactly (#0969da/#bc4c00) --
// same collision as COMMAND_KIND_COLORS above, fixed the same way.
const TOKEN_COMPONENT_COLORS = { uncached_input: '#8250df', cache_read: '#1b7c83', cache_write: '#1a7f37', output: '#bf3989', reasoning: '#cf222e' };
const TOKEN_COMPONENT_LABEL = { uncached_input: 'uncached input', cache_read: 'cache read', cache_write: 'cache write', output: 'output', reasoning: 'reasoning' };

// A `reasoning_output` that is null/undefined means "not tracked" (schema-1's own by_runtime_arm
// aggregate -- campaign-summary.mjs's tokenStats object literal has only input/output/cached_input/
// cache_write, never a reasoning_output key, verified directly against that file), not "genuinely
// zero" -- those two must render differently (component omitted vs. component shown as 0), so this
// checks raw nullness BEFORE any Number() coercion collapses both cases to the same 0.
function disjointTokens(raw, runtimeId) {
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
function tokenCompositionMedians(summary, group, runtimeId, arm) {
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

function commandKindAggregate(group) {
  const mix = group.kmp_test_vs_gradle;
  if (!mix || mix.available === false) return null;
  const n = Math.max(group.counted, 1);
  return {
    // Per-session MEAN (total / n), not a median -- campaign-summary.mjs exposes only totals for
    // this bucket, so `.median` here is stackedMetric's generic per-type value field, not a claim
    // this specific number is a median (see `stat` below, which renderMetricRow reads for the note).
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

// Rounds up to a "nice" axis max (1/2/5 x 10^n) so the 3 tick labels (0/mid/max) are clean
// numbers, not e.g. "0 / 96.3 / 192.7". For an integer-valued metric (turns, byte/tool-call counts)
// that alone isn't enough -- axisMax/2 (the middle tick) is only a whole number when axisMax itself
// is even, and the "nice" sequence includes odd values (1, 5, 50, 500, ...) whenever fraction<=1 or
// fraction<=5 lands on a base of 1 -- e.g. niceAxisMax(1)=1, whose own midpoint 0.5 rendered as
// "0.5 turns" (WO-C15). integerTicks rounds up to the nearest even integer >= 2 so axisMax/2 is
// always a whole number too; every base for exp>=1 (10, 100, ...) is already even, so this only
// ever adjusts the exp===0 cases (1->2, 5->6).
function niceAxisMax(rawMax, integerTicks = false) {
  if (!(rawMax > 0)) return integerTicks ? 2 : 1;
  const exp = Math.floor(Math.log10(rawMax));
  const base = Math.pow(10, exp);
  const fraction = rawMax / base;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  const nice = niceFraction * base;
  if (!integerTicks) return nice;
  const rounded = Math.max(2, Math.ceil(nice));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

// A strip row's shared axis max: the addendum requires the SAME 0..max scale for both agent
// columns, so a viewer can compare Claude's and Codex's dots directly -- computed over every
// per-session/aggregate value from BOTH runtimes' with/without lanes for this one metric, never
// per-runtime (that was the pre-addendum scorecard bug this also fixes).
function scalarLaneMax(metric) {
  if (metric.kind === 'per-session') return Math.max(...metric.values, 0);
  if (metric.kind === 'aggregate') return metric.max;
  return 0;
}
function sharedStripAxisMax(integerTicks, ...metrics) {
  const raw = Math.max(...metrics.map(scalarLaneMax), 1e-9);
  return niceAxisMax(raw, integerTicks);
}

// A composition row's shared bar-total max, same cross-agent reasoning as sharedStripAxisMax --
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
function compositionValueFor(composition, type) {
  if (!composition) return null;
  const seg = composition.segments.find((s) => s.type === type);
  return seg ? seg.value : null;
}

// One STRIP row (scalar metric) for one runtime column: header (metric/unit/diff%) -> two lanes
// stacked VERTICALLY sharing one 0..axisMax horizontal axis (dots in the arm's own scorecard
// color, a median tick, the median value printed right of the axis) -> 3 shared tick labels below
// both lanes -> gap. Each band advances a single cursor, so no band can silently overlap another.
function renderStripRow(colX, rowY, mainHeaderText, diffText, agentLabel, withMetric, withoutMetric, axisMax, fmtValue) {
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

  const axisLeft = colX + GRID_LANE_LABEL_W;
  const axisRight = axisLeft + GRID_STRIP_AXIS_W;
  const xFor = (v) => axisLeft + (Math.min(Math.max(v, 0), axisMax) / axisMax) * GRID_STRIP_AXIS_W;

  const lanes = [
    { m: withMetric, arm: 'with kmp-test', color: COLOR_WITH },
    { m: withoutMetric, arm: 'without', color: COLOR_WITHOUT },
  ];
  for (const lane of lanes) {
    const laneCenterY = cursor + GRID_STRIP_LANE_H / 2;
    items.push(textItem('gridLaneLabel', null, colX, laneCenterY + 4, GRID_LANE_LABEL_FS, 400, COLOR_SECONDARY, lane.arm));
    if (lane.m.kind === 'unavailable') {
      items.push(textItem('gridNotRecorded', null, axisLeft, laneCenterY + 4, GRID_VALUE_LABEL_FS, 400, COLOR_SECONDARY, 'n/a'));
    } else {
      if (lane.m.kind === 'per-session') {
        const n = lane.m.values.length;
        lane.m.values.forEach((v, i) => {
          // A small vertical jitter so n=4 real sessions landing at/near the same x are still all visible.
          const dotY = laneCenterY + (i - (n - 1) / 2) * 3.2;
          items.push({ kind: 'dot', column: null, cx: xFor(v), cy: dotY, r: GRID_DOT_R, fill: lane.color });
        });
      } else if (lane.m.kind === 'aggregate') {
        items.push({ kind: 'rangeLineH', column: null, y: laneCenterY, x1: xFor(lane.m.min), x2: xFor(lane.m.max), stroke: lane.color });
      }
      items.push({ kind: 'tickV', column: null, x: xFor(lane.m.median), y1: laneCenterY - 6, y2: laneCenterY + 6 });
      items.push(textItem('gridValueLabel', null, axisRight + GRID_VALUE_LABEL_GAP, laneCenterY + 4, GRID_VALUE_LABEL_FS, 400, COLOR_TEXT, `median ${fmtValue(lane.m.median)}`));
    }
    cursor += GRID_STRIP_LANE_H;
  }

  items.push({ kind: 'axisLine', column: null, y: cursor, x1: axisLeft, x2: axisRight });
  const tickY = cursor + GRID_TICK_FS + 4;
  const ticks = [[0, 'start'], [axisMax / 2, 'middle'], [axisMax, 'end']];
  for (const [t, anchor] of ticks) {
    items.push(textItem('gridTickLabel', null, xFor(t), tickY, GRID_TICK_FS, 400, COLOR_SECONDARY, fmtValue(t), anchor));
  }
  cursor += GRID_TICK_H + GRID_ROW_GAP;

  return { items, rowHeight: cursor - rowY };
}

// One COMPOSITION row (tool calls by kind / tokens by type) for one runtime column: header ->
// two lanes, each ONE horizontal stacked bar of per-component MEDIANS with the total printed at
// the end -> one shared legend line giving each present component's with-vs-without value -> gap.
function renderCompositionRow(colX, rowY, headerText, agentLabel, withComp, withoutComp, compMax, types, typeColors, typeLabels, fmtValue, partialTotalNote) {
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
  const lanes = [{ c: withComp, arm: 'with kmp-test' }, { c: withoutComp, arm: 'without' }];
  for (const lane of lanes) {
    const barY = cursor;
    const barCenterY = barY + GRID_COMP_BAR_H / 2;
    items.push(textItem('gridLaneLabel', null, colX, barCenterY + 4, GRID_LANE_LABEL_FS, 400, COLOR_SECONDARY, lane.arm));
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
        items.push(textItem('gridCompTotal', null, barX + GRID_COMP_BAR_W + 6, barCenterY + 4, GRID_VALUE_LABEL_FS, 400, COLOR_TEXT, fmtValue(lane.c.total)));
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
  // token's own swatch + gap (WO-C15: a color swatch in front of each component so a reader can map
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
    let noteLine = '';
    for (const word of partialTotalNote.split(' ')) {
      const candidate = noteLine ? `${noteLine} ${word}` : word;
      if (noteLine && candidate.length * GRID_LEGEND_FS * 0.6 > maxLineWidth) {
        legendLines.push({ note: noteLine });
        noteLine = word;
      } else {
        noteLine = candidate;
      }
    }
    if (noteLine) legendLines.push({ note: noteLine });
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

// Formatting, all numbers-first per WO-C12 point 7 (min at 1 decimal like the scorecard; tokens
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
// is missing or exactly zero, per WO-C12 point 3.
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

// One runtime's full, FIXED row set and order (WO-C12 point 5) -- always all 6 rows; an agent
// with nothing for a given row renders as a single "not recorded for <agent>" line there (point 6)
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
      // WO-C13: this counts SHELL commands (product_cli_command_count / direct_build_tool_command_count
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
      kind: 'strip', label: 'Turns', unit: '', fmtValue: fmtCount, sourceNote: null, integerTicks: true,
      with: scalarMetric(summary, gp, runtimeId, 'product', 'num_turns', () => null),
      without: scalarMetric(summary, gf, runtimeId, 'free', 'num_turns', () => null),
    },
    {
      kind: 'strip', label: 'Tool output returned to the model', unit: 'bytes', fmtValue: fmtBytesCompact, sourceNote: null, integerTicks: true,
      with: scalarMetric(summary, gp, runtimeId, 'product', 'output_bytes', () => null),
      without: scalarMetric(summary, gf, runtimeId, 'free', 'output_bytes', () => null),
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
    'Each dot is one session; bars are the median session.'));
  items.push(textItem('gridSubtitle', null, PAD, subtitleY2, subtitleFS, 400, COLOR_SECONDARY,
    'Descriptive only, not part of the pre-registered analysis.'));
  const headerBottom = subtitleY2 + ROW_GAP + 8;

  const columns = RUNTIME_ORDER.map((id, i) => ({ id, x: i === 0 ? PAD : PAD + COLUMN_W + COLUMN_GAP }));
  // Both columns' full row data is built FIRST so shared cross-agent scales (WO-C12 addendum point
  // 1) can be computed before anything is rendered -- a shared max needs both sides' raw values.
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
        const axisMax = sharedStripAxisMax(!!row.integerTicks, row.with, row.without, otherData[ri].with, otherData[ri].without);
        const diffPct = stripDiffPct(row.with, row.without);
        const { mainText, diffText } = stripHeaderLines(row.label, row.unit, diffPct, row.sourceNote);
        rendered = renderStripRow(col.x, cy, mainText, diffText, agentLabel, row.with, row.without, axisMax, row.fmtValue);
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
    } else if (item.kind === 'dot') {
      parts.push(`<circle cx="${item.cx.toFixed(1)}" cy="${item.cy.toFixed(1)}" r="${item.r}" fill="${item.fill}"/>`);
    } else if (item.kind === 'tickV') {
      parts.push(`<line x1="${item.x.toFixed(1)}" x2="${item.x.toFixed(1)}" y1="${item.y1.toFixed(1)}" y2="${item.y2.toFixed(1)}" stroke="${COLOR_TEXT}" stroke-width="2"/>`);
    } else if (item.kind === 'axisLine') {
      parts.push(`<line x1="${item.x1.toFixed(1)}" x2="${item.x2.toFixed(1)}" y1="${item.y.toFixed(1)}" y2="${item.y.toFixed(1)}" stroke="${COLOR_GRID}" stroke-width="1"/>`);
    } else if (item.kind === 'rangeLineH') {
      parts.push(`<line x1="${item.x1.toFixed(1)}" x2="${item.x2.toFixed(1)}" y1="${item.y.toFixed(1)}" y2="${item.y.toFixed(1)}" stroke="${item.stroke}" stroke-width="2"/>`);
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

// The evidence doc's own "## Results — campaign (16 sessions)" heading, hand-authored (not
// generated) at tools/runs/evidence1-agentic-benchmark-<date>/README.md. Anchor slug per GitHub's
// own algorithm: lowercase, strip characters outside [\w\- ], turn each remaining space into a
// hyphen -- the em-dash is stripped (not converted), so "Results — campaign" leaves two adjacent
// spaces and therefore a DOUBLE hyphen: "results--campaign-16-sessions".
const RESULTS_HEADING_ANCHOR = 'results--campaign-16-sessions';

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
function wallClockPhrase(withMinutes, withoutMinutes, withGroup, withoutGroup, runsPath) {
  const w = withMinutes.toFixed(1);
  const wo = withoutMinutes.toFixed(1);
  if (w === wo) return `same median wall-clock (${w} min)`;
  const withRange = durationRangeMinutes(withGroup);
  const withoutRange = durationRangeMinutes(withoutGroup);
  const breakdownLink = `${runsPath}/README.md#${RESULTS_HEADING_ANCHOR}`;
  return `median wall-clock ${w} vs ${wo} min (per-session range ${withRange} vs ${withoutRange} min; [breakdown](${breakdownLink}))`;
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
    return `${RUNTIME_LABELS[r]} reported the key facts correctly in ${fmtRatio(gp.key_facts_match)} sessions with kmp-test and ${fmtRatio(gf.key_facts_match)} without`;
  });
  return bits.join('; ') + '.';
}

function buildClaudeBullet(summary, costEstimate, runsPath) {
  const gp = findGroup(summary, 'claude-code', 'product');
  const gf = findGroup(summary, 'claude-code', 'free');
  const toolsWith = fmtToolCallsMedian(gp.tool_calls_total.median);
  const toolsWithout = fmtToolCallsMedian(gf.tool_calls_total.median);
  const wallWith = gp.duration_ms.median / 60000;
  const wallWithout = gf.duration_ms.median / 60000;
  const costWith = fmtCostRange(claudeCostRange(costEstimate, 'product'));
  const costWithout = fmtCostRange(claudeCostRange(costEstimate, 'free'));
  const wallPhrase = wallClockPhrase(wallWith, wallWithout, gp.duration_ms, gf.duration_ms, runsPath);
  return `Claude Code (Sonnet 5) with kmp-test: median ${toolsWith} tool calls vs ${toolsWithout} without, ${wallPhrase}, estimated API cost ${costWith} vs ${costWithout} per session.`;
}

function buildCodexBullet(summary, runsPath) {
  const gp = findGroup(summary, 'codex-cli', 'product');
  const gf = findGroup(summary, 'codex-cli', 'free');
  const toolsWith = fmtToolCallsMedian(gp.tool_calls_total.median);
  const toolsWithout = fmtToolCallsMedian(gf.tool_calls_total.median);
  const wallWith = gp.duration_ms.median / 60000;
  const wallWithout = gf.duration_ms.median / 60000;
  const wallPhrase = wallClockPhrase(wallWith, wallWithout, gp.duration_ms, gf.duration_ms, runsPath);
  return `Codex CLI (gpt-5.6-terra, low reasoning effort): median ${toolsWith} tool calls with kmp-test vs ${toolsWithout} without; ${wallPhrase}.`;
}

// Schema 2 only: one shape for either runtime, cost included whenever cost-estimate.runtimes
// covers it -- this is what lets Codex's bullet gain the same cost clause Claude's already has,
// without a second hardcoded, cost-shaped template to keep in sync by hand.
function buildRuntimeBullet(runtimeId, summary, costEstimate, runsPath) {
  const gp = findGroup(summary, runtimeId, 'product');
  const gf = findGroup(summary, runtimeId, 'free');
  const toolsWith = fmtToolCallsMedian(gp.tool_calls_total.median);
  const toolsWithout = fmtToolCallsMedian(gf.tool_calls_total.median);
  const wallWith = gp.duration_ms.median / 60000;
  const wallWithout = gf.duration_ms.median / 60000;
  const wallPhrase = wallClockPhrase(wallWith, wallWithout, gp.duration_ms, gf.duration_ms, runsPath);
  const displayName = RUNTIME_DISPLAY_NAME[runtimeId];
  const model = provenanceValue(summary, 'model_resolved', runtimeId);
  if (hasV2Cost(costEstimate, runtimeId)) {
    const costWith = fmtCostRange(runtimeCostRange(costEstimate, runtimeId, 'product'));
    const costWithout = fmtCostRange(runtimeCostRange(costEstimate, runtimeId, 'free'));
    return `${displayName} (${model}) with kmp-test: median ${toolsWith} tool calls vs ${toolsWithout} without, ${wallPhrase}, estimated API cost ${costWith} vs ${costWithout} per session.`;
  }
  return `${displayName} (${model}): median ${toolsWith} tool calls with kmp-test vs ${toolsWithout} without; ${wallPhrase}.`;
}

// One descriptive bullet per arm comparing the two agents' medians (WO-C12 addendum point 2) --
// n=4 per cell, no inferential wording (states the numbers, never "faster"/"better"/causal). Omitted
// entirely for that arm when either agent's median is missing, rather than rendering a partial claim.
function buildCrossAgentBullet(summary, arm, armLabel) {
  const gClaude = findGroup(summary, 'claude-code', arm);
  const gCodex = findGroup(summary, 'codex-cli', arm);
  const claudeMedian = gClaude && gClaude.tool_calls_total && gClaude.tool_calls_total.median;
  const codexMedian = gCodex && gCodex.tool_calls_total && gCodex.tool_calls_total.median;
  if (typeof claudeMedian !== 'number' || typeof codexMedian !== 'number') return null;
  // Read from the group's own tool_calls_total.n (the exact count the median was computed from),
  // never a hardcoded "n=4" -- true for every real, complete campaign (always exactly 4 per arm by
  // design), but a literal would silently misreport a smaller/partial run (WO-C14 dry run: n=1).
  // Claude and Codex are independent per-runtime data and can in principle diverge, so a shared
  // figure is only used when they genuinely agree.
  const claudeN = gClaude.tool_calls_total.n;
  const codexN = gCodex.tool_calls_total.n;
  const nLabel = claudeN === codexN ? `n=${claudeN} per cell` : `n=${claudeN} for Claude, n=${codexN} for Codex`;
  return `${armLabel} (descriptive): Codex ${fmtToolCallsMedian(codexMedian)} tool calls vs Claude ${fmtToolCallsMedian(claudeMedian)}, median, ${nLabel}.`;
}

export function buildBullets(summary, costEstimate, runsPath) {
  const keyFactsBullet = buildKeyFactsBullet(summary);
  if (summary.schema === 2) {
    const bullets = [
      keyFactsBullet,
      buildRuntimeBullet('claude-code', summary, costEstimate, runsPath),
      buildRuntimeBullet('codex-cli', summary, costEstimate, runsPath),
    ];
    const withBullet = buildCrossAgentBullet(summary, 'product', 'With kmp-test');
    const withoutBullet = buildCrossAgentBullet(summary, 'free', 'Without kmp-test');
    if (withBullet) bullets.push(withBullet);
    if (withoutBullet) bullets.push(withoutBullet);
    return bullets;
  }
  return [keyFactsBullet, buildClaudeBullet(summary, costEstimate, runsPath), buildCodexBullet(summary, runsPath)];
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

export function renderReadmeBlock(summary, campaignDate, costEstimate) {
  const runsPath = `tools/runs/evidence1-agentic-benchmark-${campaignDate}`;
  const bulletsText = buildBullets(summary, costEstimate, runsPath).map((b) => `- ${b}`).join('\n');
  const kmpTestVersion = kmpTestVersionOf(summary);
  const runtimeScopeText = summary.schema === 2
    ? `${runtimeScopeClause(summary, 'claude-code')}. ${runtimeScopeClause(summary, 'codex-cli')}.`
    : `Claude Code 2.1.238 · claude-sonnet-5 · effort not set by the harness (docs default: high). Codex CLI 0.154.0 · gpt-5.6-terra · reasoning effort low.`;

  return `<!-- agentic-benchmark:start (generated by tools/agentic-eval/readme-evidence.mjs from ${runsPath}/campaign-summary.json; edit the generator, not this block) -->
### Agent sessions with and without kmp-test

kmp-test hands an agent the test and coverage verdict as one JSON envelope instead of Gradle logs and report files. To check that this helps end to end, Claude Code and Codex CLI each ran the same pre-registered coverage-gate task on a pinned NowInAndroid commit: 4 sessions with the kmp-test skill and CLI, 4 without. Every session is shown; none was re-run or replaced.

![${buildScorecardAlt(summary, costEstimate)}](${runsPath}/scorecard.svg)

![Per-session detail (descriptive, not part of the pre-registered design): tool calls, tokens, wall-clock, cost, turns and tool-output bytes for both agents, with vs without kmp-test.](${runsPath}/metrics-grid.svg)

${bulletsText}

**Scope:** one scenario, tagged \`train\` (the skill was tuned on this task family); n=4 sessions per arm per agent in counterbalanced order; Windows 11 in an isolated VM with a restricted network (provider APIs only); design and metrics fixed before any live session. kmp-test ${kmpTestVersion}. ${runtimeScopeText} Key facts = module, outcome, coverage numbers. [Evidence, per-session detail and limitations](${runsPath}/README.md) · [controls audit](${runsPath}/controls-audit.md) · [pre-registration](${runsPath}/preregistration.md)
<!-- agentic-benchmark:end -->`;
}

// ---------------------------------------------------------------------------
// CLI

function main(argv) {
  const mode = argv.includes('--write') ? 'write' : 'check';
  const campaignDate = (argv.find(a => a.startsWith('--date=')) || '--date=2026-09-28').split('=')[1];
  const runsDir = join(REPO_ROOT, 'tools', 'runs', `evidence1-agentic-benchmark-${campaignDate}`);
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

  const scorecardSvg = renderScorecardSvg(summary, costEstimate);
  const metricsGridSvg = renderMetricsGridSvg(summary, costEstimate);
  const block = renderReadmeBlock(summary, campaignDate, costEstimate);

  const scorecardPath = join(runsDir, 'scorecard.svg');
  const metricsGridPath = join(runsDir, 'metrics-grid.svg');
  const readmePath = join(REPO_ROOT, 'README.md');

  if (mode === 'write') {
    writeFileSync(scorecardPath, scorecardSvg);
    writeFileSync(metricsGridPath, metricsGridSvg);
    const readme = readFileSync(readmePath, 'utf8');
    const startMarker = '<!-- agentic-benchmark:start';
    const endMarker = '<!-- agentic-benchmark:end -->';
    const startIdx = readme.indexOf(startMarker);
    const endIdx = readme.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1) {
      console.error('::error::README.md is missing the agentic-benchmark:start/end markers');
      process.exit(1);
    }
    const before = readme.slice(0, startIdx);
    const after = readme.slice(endIdx + endMarker.length);
    writeFileSync(readmePath, before + block + after);
    console.log(`Wrote ${scorecardPath}\nWrote ${metricsGridPath}\nUpdated README.md block`);
    return;
  }

  // check mode: regenerate and diff against what's committed
  let mismatches = [];
  if (!existsSync(scorecardPath) || readFileSync(scorecardPath, 'utf8') !== scorecardSvg) mismatches.push(scorecardPath);
  if (!existsSync(metricsGridPath) || readFileSync(metricsGridPath, 'utf8') !== metricsGridSvg) mismatches.push(metricsGridPath);
  const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
  const startMarker = '<!-- agentic-benchmark:start';
  const endMarker = '<!-- agentic-benchmark:end -->';
  const startIdx = readme.indexOf(startMarker);
  const endIdx = readme.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || readme.slice(startIdx, endIdx + endMarker.length) !== block) {
    mismatches.push(readmePath);
  }
  if (mismatches.length > 0) {
    console.error(`::error::out of date, run with --write: ${mismatches.join(', ')}`);
    process.exit(1);
  }
  console.log('README evidence block and chart are up to date.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

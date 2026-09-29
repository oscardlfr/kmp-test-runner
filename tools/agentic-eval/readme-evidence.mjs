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

function buildBarMetrics(runtimeId, summary, costEstimate) {
  const gProduct = findGroup(summary, runtimeId, 'product');
  const gFree = findGroup(summary, runtimeId, 'free');

  const toolsWith = Math.round(gProduct.tool_calls_total.median);
  const toolsWithout = Math.round(gFree.tool_calls_total.median);
  const toolsMax = Math.max(toolsWith, toolsWithout, 1e-9);

  const wallWith = gProduct.duration_ms.median / 60000;
  const wallWithout = gFree.duration_ms.median / 60000;
  const wallMax = Math.max(wallWith, wallWithout, 1e-9);

  const metrics = [
    {
      label: 'Tool calls per session (median)',
      withFrac: toolsWith / toolsMax,
      withoutFrac: toolsWithout / toolsMax,
      withLabel: fmtToolCallsMedian(gProduct.tool_calls_total.median),
      withoutLabel: fmtToolCallsMedian(gFree.tool_calls_total.median),
    },
    {
      label: 'Wall-clock per session (median)',
      withFrac: wallWith / wallMax,
      withoutFrac: wallWithout / wallMax,
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
    const costMax = Math.max(withRange.high, withoutRange.high, 1e-9);
    metrics.push({
      label: 'Estimated API cost per session',
      withFrac: withRange.high / costMax,
      withoutFrac: withoutRange.high / costMax,
      withLabel: fmtCostRange(withRange),
      withoutLabel: fmtCostRange(withoutRange),
    });
  } else if (hasV2Cost(costEstimate, runtimeId)) {
    const withRange = runtimeCostRange(costEstimate, runtimeId, 'product');
    const withoutRange = runtimeCostRange(costEstimate, runtimeId, 'free');
    const costMax = Math.max(withRange.high, withoutRange.high, 1e-9);
    metrics.push({
      label: 'Estimated API cost per session',
      withFrac: withRange.high / costMax,
      withoutFrac: withoutRange.high / costMax,
      withLabel: fmtCostRange(withRange),
      withoutLabel: fmtCostRange(withoutRange),
    });
  } else {
    metrics.push({ label: 'Estimated API cost per session', notEstimated: true });
  }

  return metrics;
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

  const columnBottoms = [];

  for (const col of columns) {
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

    const metrics = buildBarMetrics(col.id, summary, costEstimate);
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
  }

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
    for (const metric of buildBarMetrics(runtimeId, summary, costEstimate)) {
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

export function buildBullets(summary, costEstimate, runsPath) {
  const keyFactsBullet = buildKeyFactsBullet(summary);
  if (summary.schema === 2) {
    return [
      keyFactsBullet,
      buildRuntimeBullet('claude-code', summary, costEstimate, runsPath),
      buildRuntimeBullet('codex-cli', summary, costEstimate, runsPath),
    ];
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
  const [bullet1, bullet2, bullet3] = buildBullets(summary, costEstimate, runsPath);
  const kmpTestVersion = kmpTestVersionOf(summary);
  const runtimeScopeText = summary.schema === 2
    ? `${runtimeScopeClause(summary, 'claude-code')}. ${runtimeScopeClause(summary, 'codex-cli')}.`
    : `Claude Code 2.1.238 · claude-sonnet-5 · effort not set by the harness (docs default: high). Codex CLI 0.154.0 · gpt-5.6-terra · reasoning effort low.`;

  return `<!-- agentic-benchmark:start (generated by tools/agentic-eval/readme-evidence.mjs from ${runsPath}/campaign-summary.json; edit the generator, not this block) -->
### Agent sessions with and without kmp-test

kmp-test hands an agent the test and coverage verdict as one JSON envelope instead of Gradle logs and report files. To check that this helps end to end, Claude Code and Codex CLI each ran the same pre-registered coverage-gate task on a pinned NowInAndroid commit: 4 sessions with the kmp-test skill and CLI, 4 without. Every session is shown; none was re-run or replaced.

![${buildScorecardAlt(summary, costEstimate)}](${runsPath}/scorecard.svg)

- ${bullet1}
- ${bullet2}
- ${bullet3}

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

  const scorecardSvg = renderScorecardSvg(summary, costEstimate);
  const block = renderReadmeBlock(summary, campaignDate, costEstimate);

  const scorecardPath = join(runsDir, 'scorecard.svg');
  const readmePath = join(REPO_ROOT, 'README.md');

  if (mode === 'write') {
    writeFileSync(scorecardPath, scorecardSvg);
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
    console.log(`Wrote ${scorecardPath}\nUpdated README.md block`);
    return;
  }

  // check mode: regenerate and diff against what's committed
  let mismatches = [];
  if (!existsSync(scorecardPath) || readFileSync(scorecardPath, 'utf8') !== scorecardSvg) mismatches.push(scorecardPath);
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

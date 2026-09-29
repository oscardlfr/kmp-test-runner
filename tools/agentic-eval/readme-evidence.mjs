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
const GRID_ROW_LABEL_W = 190;
const GRID_LANE_W = 120;
const GRID_LANE_GAP = 18;
const GRID_DOT_R = 3;
const GRID_STACK_W = 10;
// Row layout: each row is a stack of non-overlapping bands (label, optional note, lane header,
// plot, bottom line), each with a fixed height; a row's TOTAL height is the sum of only the bands
// it actually uses (see renderMetricRow). Never a single flat per-row constant -- that was the
// WO-C10 bug: a fixed 64px slot for content that needed ~110-126px, so every band silently bled
// into its neighbor (row label under the previous row's legend, "with"/"without" under the next
// row's label, the aggregate note drawn over the row label it was meant to sit below).
const GRID_ROW_LABEL_FS = 13;
const GRID_NOTE_FS = 10;
const GRID_LANE_HEADER_FS = 11;
const GRID_VALUE_LABEL_FS = 11;
const GRID_ROW_LABEL_H = 18;
const GRID_NOTE_H = 16;
const GRID_LANE_HEADER_H = 18;
const GRID_PLOT_H = 44;
const GRID_BOTTOM_H = 18;
const GRID_ROW_GAP = 12; // clearance before the next row -- WO-C10 requires >= 10px
const TOKEN_TYPE_COLORS = {
  input: '#8250df', cached_input: '#0969da', cache_write: '#1a7f37', output: '#bc4c00', reasoning_output: '#cf222e',
};
const TOKEN_TYPE_ORDER = ['input', 'cached_input', 'cache_write', 'reasoning_output', 'output'];
const TOKEN_TYPE_LABEL = {
  input: 'input', cached_input: 'cached input', cache_write: 'cache write', output: 'output', reasoning_output: 'reasoning output',
};
const COMMAND_KIND_COLORS = { kmp_test: '#0969da', gradle: '#bc4c00', other: '#59636e' };
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

// A composite metric's per-session segments (one {type,value} array per session) when every
// counted cell carries `cellField` as an object; otherwise ONE segment array built from the
// run-level aggregate's own per-type medians (by_runtime_arm.tokens.<type>.median), when that
// aggregate exists.
// Distinct kind labels from scalarMetric()'s 'per-session'/'aggregate' -- a stacked result's
// payload shape (sessions: array-of-segment-arrays, or segments: one segment array) is structurally
// different from a scalar's (values: number[], or min/median/max), and reusing the same kind
// strings for both was a real bug caught in the real-data preview: yScaleFor's scalar branch read
// stacked payloads through the wrong shape and silently produced a NaN/1 scale, exploding every
// bar's height by orders of magnitude. Keeping the labels distinct makes that class of mismatch a
// missing-branch/undefined error instead of a silent wrong number.
function stackedMetric(summary, group, runtimeId, arm, cellField, types, aggregateOf) {
  const cells = countedCells(summary, runtimeId, arm);
  if (cells.length > 0 && cells.every((c) => c[cellField] && typeof c[cellField] === 'object')) {
    const sessions = cells.map((c) => types.map((t) => ({ type: t, value: Number(c[cellField][t]) || 0 })));
    return { kind: 'stack-per-session', sessions };
  }
  const agg = aggregateOf(group);
  if (agg) {
    // Only types aggregateOf actually tracks become a segment -- a type it doesn't track (e.g.
    // commandKindAggregate's 'other') is omitted rather than defaulted to a fabricated 0, so a
    // genuinely-untracked bucket is never indistinguishable from one that measured zero.
    const segments = types
      .filter((t) => agg[t] && typeof agg[t].median === 'number')
      .map((t) => ({ type: t, value: agg[t].median }));
    if (segments.some((s) => s.value > 0)) return { kind: 'stack-aggregate', segments, stat: agg.stat || 'median' };
  }
  return { kind: 'unavailable' };
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

function yScaleFor(marks) {
  let max = 0;
  for (const m of marks) {
    if (m.kind === 'per-session') max = Math.max(max, ...m.values);
    else if (m.kind === 'aggregate') max = Math.max(max, m.max);
    else if (m.kind === 'stack-per-session') max = Math.max(max, ...m.sessions.map((s) => s.reduce((a, b) => a + b.value, 0)));
    else if (m.kind === 'stack-aggregate') max = Math.max(max, m.segments.reduce((a, b) => a + b.value, 0));
  }
  return max > 0 ? max : 1;
}

// The set of type keys actually present in a metric's segments/sessions -- never every key
// typeColors happens to define, so a legend built from this never shows a swatch for a type the
// underlying data never tracked (mirrors stackedMetric's own "omit, don't fabricate" rule).
function presentStackTypes(metric) {
  if (metric.kind === 'stack-per-session') return new Set(metric.sessions.flatMap((s) => s.map((seg) => seg.type)));
  if (metric.kind === 'stack-aggregate') return new Set(metric.segments.map((seg) => seg.type));
  return new Set();
}

// A row needs its one aggregate-disclaimer note line when either lane fell back to an aggregate
// (stack-aggregate: a per-type median/mean built from by_runtime_arm, not per-cell data; aggregate:
// a scalar min/median/max range) -- never for a row where every plotted lane is real per-session data.
function rowNeedsNote(withMetric, withoutMetric) {
  return [withMetric, withoutMetric].some((m) => m.kind === 'stack-aggregate' || m.kind === 'aggregate');
}

function rowNoteText(withMetric, withoutMetric) {
  const stackAgg = [withMetric, withoutMetric].find((m) => m.kind === 'stack-aggregate');
  if (stackAgg) {
    return stackAgg.stat === 'mean' ? 'bars: campaign mean per session, not per-session' : 'bars: campaign median, not per-session';
  }
  return 'campaign range, not per-session';
}

// One row's SVG items for one runtime column, laid out as stacked, non-overlapping bands: row
// label -> optional aggregate note -> lane header ("with"/"without", ABOVE their lanes) -> plot
// area (dot cluster / stacked-bar cluster / range mark / "n/a") -> bottom line (color legend for
// stacked rows, the median value line for scalar rows) -> gap. Each band advances a single cursor,
// so no band can silently overlap another the way the old fixed-GRID_ROW_H layout did.
function renderMetricRow(colX, rowY, label, unit, descriptive, withMetric, withoutMetric, isStack, typeColors, types, typeLabels) {
  const items = [];
  let cursor = rowY;

  items.push(textItem('gridRowLabel', null, colX, cursor + GRID_ROW_LABEL_FS, GRID_ROW_LABEL_FS, 500, COLOR_TEXT, descriptive ? `${label} (descriptive)` : label));
  cursor += GRID_ROW_LABEL_H;

  if (withMetric.kind === 'unavailable' && withoutMetric.kind === 'unavailable') {
    items.push(textItem('gridNotAvailable', null, colX, cursor + 12, 12, 400, COLOR_SECONDARY, 'not available for this campaign'));
    cursor += 16 + GRID_ROW_GAP;
    return { items, rowHeight: cursor - rowY };
  }

  if (rowNeedsNote(withMetric, withoutMetric)) {
    items.push(textItem('gridAggregateNote', null, colX, cursor + GRID_NOTE_FS, GRID_NOTE_FS, 400, COLOR_SECONDARY, rowNoteText(withMetric, withoutMetric)));
    cursor += GRID_NOTE_H;
  }

  const lanes = [{ x: colX, m: withMetric, arm: 'with' }, { x: colX + GRID_LANE_W + GRID_LANE_GAP, m: withoutMetric, arm: 'without' }];
  for (const lane of lanes) {
    items.push(textItem('gridLaneLabel', null, lane.x, cursor + GRID_LANE_HEADER_FS, GRID_LANE_HEADER_FS, 400, COLOR_SECONDARY, lane.arm));
  }
  cursor += GRID_LANE_HEADER_H;

  const plotTop = cursor;
  const scale = yScaleFor([withMetric, withoutMetric]);
  const yFor = (v) => plotTop + GRID_PLOT_H - (v / scale) * GRID_PLOT_H;

  for (const lane of lanes) {
    if (lane.m.kind === 'unavailable') {
      items.push(textItem('gridNotAvailable', null, lane.x, plotTop + GRID_PLOT_H / 2 + 4, 11, 400, COLOR_SECONDARY, 'n/a'));
      continue;
    }
    if (isStack) {
      const sessionsToPlot = lane.m.kind === 'stack-per-session' ? lane.m.sessions : [lane.m.segments];
      const n = sessionsToPlot.length;
      const spacing = Math.min(GRID_STACK_W + 4, GRID_LANE_W / Math.max(n, 1));
      const startX = lane.x + GRID_LANE_W / 2 - (n - 1) * spacing / 2;
      sessionsToPlot.forEach((segments, i) => {
        let yCursor = plotTop + GRID_PLOT_H;
        for (const seg of segments) {
          if (seg.value <= 0) continue;
          const segH = (seg.value / scale) * GRID_PLOT_H;
          items.push({ kind: 'bar', column: null, x: startX + i * spacing - GRID_STACK_W / 2, y: yCursor - segH, w: GRID_STACK_W, h: segH, rx: 1, fill: typeColors[seg.type] || COLOR_SECONDARY });
          yCursor -= segH;
        }
      });
    } else if (lane.m.kind === 'per-session') {
      const n = lane.m.values.length;
      const spacing = Math.min(24, GRID_LANE_W / Math.max(n, 1));
      const startX = lane.x + GRID_LANE_W / 2 - (n - 1) * spacing / 2;
      lane.m.values.forEach((v, i) => {
        items.push({ kind: 'dot', column: null, cx: startX + i * spacing, cy: yFor(v), r: GRID_DOT_R, fill: COLOR_WITH });
      });
      const medianY = yFor(lane.m.median);
      items.push({ kind: 'medianTick', column: null, x1: lane.x + 4, x2: lane.x + GRID_LANE_W - 4, y: medianY });
    } else if (lane.m.kind === 'aggregate') {
      const yMin = yFor(lane.m.min), yMax = yFor(lane.m.max), yMed = yFor(lane.m.median);
      const cx = lane.x + GRID_LANE_W / 2;
      items.push({ kind: 'rangeLine', column: null, x: cx, y1: yMin, y2: yMax });
      items.push({ kind: 'medianTick', column: null, x1: cx - 14, x2: cx + 14, y: yMed });
    }
  }
  cursor += GRID_PLOT_H;

  const bottomBandTop = cursor;
  if (isStack) {
    const present = new Set([...presentStackTypes(withMetric), ...presentStackTypes(withoutMetric)]);
    const legendY = bottomBandTop + GRID_LEGEND_FS + 4;
    let legendX = colX;
    for (const t of types.filter((type) => present.has(type))) {
      const swatchFill = typeColors[t] || COLOR_SECONDARY;
      items.push({ kind: 'legendSwatch', column: null, x: legendX, y: legendY - GRID_LEGEND_SWATCH, w: GRID_LEGEND_SWATCH, h: GRID_LEGEND_SWATCH, fill: swatchFill });
      const labelText = (typeLabels && typeLabels[t]) || t;
      items.push(textItem('gridLegendLabel', null, legendX + GRID_LEGEND_SWATCH + 3, legendY, GRID_LEGEND_FS, 400, COLOR_SECONDARY, labelText));
      legendX += GRID_LEGEND_SWATCH + 3 + labelText.length * GRID_LEGEND_FS * 0.6 + 10;
    }
  } else {
    // ms carries its converted "s" unit on each value ("median 125.0 s vs 125.0 s"); every other
    // unit keeps the existing single trailing suffix ("median 0.11 vs 0.17 USD").
    const trailingUnit = unit && unit !== 'ms' ? ' ' + unit : '';
    const valueLabel = `median ${fmtGridValue(withMetric, unit)} vs ${fmtGridValue(withoutMetric, unit)}${trailingUnit}`;
    items.push(textItem('gridValueLabel', null, colX, bottomBandTop + GRID_VALUE_LABEL_FS + 4, GRID_VALUE_LABEL_FS, 400, COLOR_SECONDARY, valueLabel));
  }
  cursor += GRID_BOTTOM_H + GRID_ROW_GAP;

  return { items, rowHeight: cursor - rowY };
}

// Milliseconds read as seconds (1 decimal) -- "190.0 s vs 191.2 s" is legible at a glance; raw
// millisecond medians ("189954.5 vs 191216.5 ms") are not. Every other unit (USD, unitless turns)
// is unaffected. Only the printed value-line text changes; the plotted dot/tick geometry above it
// still scales off the raw metric values, which carry no unit label of their own.
function fmtGridValue(metric, unit) {
  if (metric.kind === 'unavailable') return 'n/a';
  const v = metric.median;
  if (typeof v !== 'number') return 'n/a';
  if (unit === 'ms') return `${(v / 1000).toFixed(1)} s`;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

// One runtime's full row set: tokens (stack), tool calls by kind (stack), wall-clock (dot), cost
// (dot), turns (dot). Tool-result volume is appended by the caller only when at least one runtime
// actually has it, per the design's explicit "chart only if reliably measurable" rule.
function buildMetricRowsForRuntime(runtimeId, summary, costEstimate) {
  const gp = findGroup(summary, runtimeId, 'product');
  const gf = findGroup(summary, runtimeId, 'free');
  const tokenTypes = runtimeId === 'claude-code' ? ['input', 'cached_input', 'cache_write', 'output'] : TOKEN_TYPE_ORDER;
  const rows = [
    {
      label: 'Tokens per session, by type', isStack: true, typeColors: TOKEN_TYPE_COLORS, types: tokenTypes, typeLabels: TOKEN_TYPE_LABEL,
      with: stackedMetric(summary, gp, runtimeId, 'product', 'tokens', tokenTypes, (g) => g.tokens),
      without: stackedMetric(summary, gf, runtimeId, 'free', 'tokens', tokenTypes, (g) => g.tokens),
    },
    {
      label: 'Tool calls by kind', isStack: true, typeColors: COMMAND_KIND_COLORS, types: ['kmp_test', 'gradle', 'other'], typeLabels: COMMAND_KIND_LABEL,
      with: stackedMetric(summary, gp, runtimeId, 'product', 'command_kind_counts', ['kmp_test', 'gradle', 'other'], commandKindAggregate),
      without: stackedMetric(summary, gf, runtimeId, 'free', 'command_kind_counts', ['kmp_test', 'gradle', 'other'], commandKindAggregate),
    },
    {
      label: 'Wall-clock', unit: 'ms', isStack: false,
      with: scalarMetric(summary, gp, runtimeId, 'product', 'duration_ms', (g) => g.duration_ms),
      without: scalarMetric(summary, gf, runtimeId, 'free', 'duration_ms', (g) => g.duration_ms),
    },
    {
      label: 'API cost (midpoint of low/high)', unit: 'USD', isStack: false,
      with: costMetric(summary, gp, runtimeId, 'product', costEstimate),
      without: costMetric(summary, gf, runtimeId, 'free', costEstimate),
    },
    {
      label: 'Turns', unit: '', isStack: false,
      with: scalarMetric(summary, gp, runtimeId, 'product', 'num_turns', () => null),
      without: scalarMetric(summary, gf, runtimeId, 'free', 'num_turns', () => null),
    },
  ];
  const toolResultVolume = {
    label: 'Tool-result bytes fed back to the model', unit: 'bytes', isStack: false,
    with: scalarMetric(summary, gp, runtimeId, 'product', 'output_bytes', () => null),
    without: scalarMetric(summary, gf, runtimeId, 'free', 'output_bytes', () => null),
  };
  const hasToolResultVolume = toolResultVolume.with.kind !== 'unavailable' || toolResultVolume.without.kind !== 'unavailable';
  return hasToolResultVolume ? [...rows, toolResultVolume] : rows;
}

export function computeMetricsGridLayout(summary, costEstimate) {
  const items = [];
  const titleFS = 20;
  const titleY = PAD + titleFS;
  items.push(textItem('gridTitle', null, PAD, titleY, titleFS, 600, COLOR_TEXT, 'Session detail (descriptive)'));
  const subtitleFS = 13;
  const subtitleY1 = titleY + ROW_GAP + subtitleFS;
  const subtitleY2 = subtitleY1 + subtitleFS + 4;
  items.push(textItem('gridSubtitle', null, PAD, subtitleY1, subtitleFS, 400, COLOR_SECONDARY,
    'Every metric below is descriptive, not part of the pre-registered design.'));
  items.push(textItem('gridSubtitle', null, PAD, subtitleY2, subtitleFS, 400, COLOR_SECONDARY,
    'Dots are real sessions; a range mark is a campaign aggregate, not per-session.'));
  const headerBottom = subtitleY2 + ROW_GAP + 8;

  const columns = RUNTIME_ORDER.map((id, i) => ({ id, x: i === 0 ? PAD : PAD + COLUMN_W + COLUMN_GAP }));
  const columnBottoms = [];
  for (const col of columns) {
    let cy = headerBottom;
    const panelTitleFS = 14;
    items.push(textItem('gridPanelTitle', col.id, col.x, cy + panelTitleFS, panelTitleFS, 600, COLOR_TEXT,
      summary.schema === 2 ? `${RUNTIME_DISPLAY_NAME[col.id]} · ${provenanceValue(summary, 'model_resolved', col.id)}` : RUNTIME_DISPLAY_NAME[col.id]));
    cy += panelTitleFS + ROW_GAP;
    for (const row of buildMetricRowsForRuntime(col.id, summary, costEstimate)) {
      const { items: rowItems, rowHeight } = renderMetricRow(col.x, cy, row.label, row.unit, true, row.with, row.without, row.isStack, row.typeColors, row.types, row.typeLabels);
      items.push(...rowItems);
      cy += rowHeight;
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
      parts.push(`<text x="${item.x}" y="${item.y.toFixed(1)}" font-size="${item.fontSize}" font-weight="${item.fontWeight}" fill="${item.fill}"${anchorAttr}>${escapeXml(item.text)}</text>`);
    } else if (item.kind === 'bar') {
      parts.push(`<rect x="${item.x.toFixed(1)}" y="${item.y.toFixed(1)}" width="${item.w}" height="${item.h.toFixed(1)}" rx="${item.rx}" fill="${item.fill}"/>`);
    } else if (item.kind === 'legendSwatch') {
      parts.push(`<rect x="${item.x.toFixed(1)}" y="${item.y.toFixed(1)}" width="${item.w}" height="${item.h}" fill="${item.fill}"/>`);
    } else if (item.kind === 'dot') {
      parts.push(`<circle cx="${item.cx.toFixed(1)}" cy="${item.cy.toFixed(1)}" r="${item.r}" fill="${item.fill}"/>`);
    } else if (item.kind === 'medianTick') {
      parts.push(`<line x1="${item.x1.toFixed(1)}" x2="${item.x2.toFixed(1)}" y1="${item.y.toFixed(1)}" y2="${item.y.toFixed(1)}" stroke="${COLOR_TEXT}" stroke-width="2"/>`);
    } else if (item.kind === 'rangeLine') {
      parts.push(`<line x1="${item.x.toFixed(1)}" x2="${item.x.toFixed(1)}" y1="${item.y1.toFixed(1)}" y2="${item.y2.toFixed(1)}" stroke="${COLOR_SECONDARY}" stroke-width="2"/>`);
    }
  }
  const tokenLegendDesc = TOKEN_TYPE_ORDER.map((t) => `${TOKEN_TYPE_LABEL[t]} (${TOKEN_TYPE_COLORS[t]})`).join(', ');
  const commandLegendDesc = ['kmp_test', 'gradle', 'other'].map((t) => `${COMMAND_KIND_LABEL[t]} (${COMMAND_KIND_COLORS[t]})`).join(', ');
  const desc = `Stacked-bar color legend. Token type: ${tokenLegendDesc}. Command kind: ${commandLegendDesc}.`;
  return `<svg viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" xmlns="http://www.w3.org/2000/svg" role="img" font-family="${FONT_STACK}">
  <title>Session detail (descriptive)</title>
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

![Session detail (descriptive, not part of the pre-registered design): per-session tokens, tool calls, wall-clock, cost and turns for both agents, with vs without kmp-test.](${runsPath}/metrics-grid.svg)

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

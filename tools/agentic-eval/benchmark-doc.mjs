#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/benchmark-doc.mjs -- deterministic generator behind docs/agentic-benchmark.md.
// From one campaign's committed campaign-summary.json + cost-estimate.json it writes
//   - tools/runs/evidence<n>-agentic-benchmark-<date>/cost-breakdown.svg, and
//   - the generated blocks of docs/agentic-benchmark.md for that evidence:
//       <!-- agentic-benchmark-doc:e<n>-cost-components:start (...) --> ... :end -->
//       <!-- agentic-benchmark-doc:e<n>-sessions:start (...) -->        ... :end -->
//
// Usage:
//   node tools/agentic-eval/benchmark-doc.mjs [--write] --evidence=<n> --date=<yyyy-mm-dd>
// Without --write it runs in check mode: it regenerates, byte-compares with the committed files and
// exits 1 on any difference. Fails closed on an invalid summary, a summary that does not pair with
// its cost estimate, a cost estimate that is not schema 2, or missing block markers.
//
// Everything is reused from readme-evidence.mjs (validators, pricing helpers, palettes, the
// composition-row renderer) and evidence2-tables.mjs (the per-session midpoint); nothing about a
// price or a token mapping is re-derived here.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  loadSummary, loadCostEstimate, validatePairing, disjointTokens, medianOf,
  textItem, wrapWords, escapeXml, renderCompositionRow, runtimeModelLabel, toolOutputMeasured,
  TOKEN_COMPONENT_TYPES, TOKEN_COMPONENT_LABEL, TOKEN_COMPONENT_COLORS,
  RUNTIME_ORDER, ARM_ORDER, GRID_W, PAD, ROW_GAP, COLUMN_W, COLUMN_GAP,
  COLOR_TEXT, COLOR_SECONDARY, COLOR_WITH, COLOR_WITHOUT, COLOR_CARD_FILL, COLOR_CARD_STROKE, FONT_STACK,
} from './readme-evidence.mjs';
import { costEstimateCellEntry, costEstimateCellMidpoint } from './evidence2-tables.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DOC_PATH = join(REPO_ROOT, 'docs', 'agentic-benchmark.md');

// Segment order in the figure and column order in the cost table.
const COST_COMPONENTS = ['cache_write', 'cache_read', 'output', 'uncached_input'];
const AGENT_LABEL = { 'claude-code': 'Claude Code', 'codex-cli': 'Codex CLI' };
const ARM_LABEL = { product: 'with kmp-test', free: 'without' };

const FIGURE_TITLE = 'Where a session\'s API cost goes';
const FIGURE_SUBTITLE = 'Share of the estimated cost by component, pooled over each group\'s sessions; the value is the median session cost. Blue: with kmp-test; orange: without.';

// ---------------------------------------------------------------------------
// Cost components -- the same midpoint convention as costMetric / costEstimateCellMidpoint: the
// cache write is priced at the mean of the 5-minute and 1-hour rates, and uncached input at the mean
// of the plain input rate and (when a provider's usage events cannot tell a cache write from a plain
// input token) the dearer of the two cache-write rates.

/** One session's cost, in USD, split into the four components. They sum to the session midpoint. */
export function sessionCostComponents(entry, tokens) {
  const price = entry.per_million_tokens;
  const highInputPrice = entry.uncached_input_may_be_cache_writes === true
    ? Math.max(price.cache_write_5m, price.cache_write_1h)
    : price.input;
  return {
    cache_write: (tokens.cache_creation * (price.cache_write_5m + price.cache_write_1h)) / 2 / 1e6,
    cache_read: (tokens.cache_read * price.cache_read) / 1e6,
    output: (tokens.output * price.output) / 1e6,
    uncached_input: (tokens.input * (price.input + highInputPrice)) / 2 / 1e6,
  };
}

const sum = (values) => values.reduce((a, b) => a + b, 0);

/**
 * One entry per (runtime, arm) of the cost estimate: its sessions' components and totals, the
 * pooled share of each component (group sum / group total) and the component and total medians.
 */
export function costGroups(costEstimate) {
  if (costEstimate.schema !== 2) throw new Error('benchmark-doc needs a schema 2 cost estimate');
  const groups = [];
  for (const runtimeId of RUNTIME_ORDER) {
    const entry = costEstimate.runtimes && costEstimate.runtimes[runtimeId];
    if (!entry) throw new Error(`cost-estimate.runtimes.${runtimeId} is missing`);
    for (const arm of ARM_ORDER) {
      const cells = entry.cells.filter((c) => c.arm === arm);
      if (cells.length === 0) throw new Error(`cost-estimate.runtimes.${runtimeId} has no ${arm} cells`);
      const sessions = cells.map((c) => {
        const components = sessionCostComponents(entry, c.tokens);
        return { order_index: c.order_index, components, total: sum(COST_COMPONENTS.map((k) => components[k])) };
      });
      const total = sum(sessions.map((s) => s.total));
      const pooledShare = {};
      const medianComponent = {};
      for (const k of COST_COMPONENTS) {
        pooledShare[k] = sum(sessions.map((s) => s.components[k])) / total;
        medianComponent[k] = medianOf(sessions.map((s) => s.components[k]));
      }
      groups.push({ runtimeId, arm, sessions, pooledShare, medianComponent, medianTotal: medianOf(sessions.map((s) => s.total)) });
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Figure: cost-breakdown.svg -- the metrics grid's frame, lanes and legend (renderCompositionRow),
// with every bar 100% stacked by pooled share.

const fmtUsd3 = (v) => `$${v.toFixed(3)}`;
function fmtShare(v) {
  if (v > 0 && v < 0.005) return '<1%';
  return `${Math.round(v * 100)}%`;
}

export function computeCostBreakdownLayout(summary, costEstimate) {
  const groups = costGroups(costEstimate);
  const items = [];
  const titleFS = 20;
  const titleY = PAD + titleFS;
  items.push(textItem('gridTitle', null, PAD, titleY, titleFS, 600, COLOR_TEXT, FIGURE_TITLE));
  const subtitleFS = 13;
  let subtitleY = titleY + ROW_GAP + subtitleFS;
  const subtitleLines = wrapWords(FIGURE_SUBTITLE, subtitleFS, GRID_W - 2 * PAD);
  subtitleLines.forEach((line, i) => {
    if (i > 0) subtitleY += subtitleFS + 4;
    items.push(textItem('gridSubtitle', null, PAD, subtitleY, subtitleFS, 400, COLOR_SECONDARY, line));
  });
  const headerBottom = subtitleY + ROW_GAP + 8;

  // The renderer prints fmtValue(total) at the end of each bar and fmtValue(segment value) in the
  // legend. Segment values here are shares and the printed total is the median session cost, already
  // formatted, so the one formatter passes a string through and formats a number as a share.
  const fmtValue = (v) => (typeof v === 'string' ? v : fmtShare(v));
  const composition = (group) => ({
    segments: COST_COMPONENTS.filter((k) => group.pooledShare[k] > 0).map((k) => ({ type: k, value: group.pooledShare[k] })),
    stat: 'median',
    total: fmtUsd3(group.medianTotal),
    totalIsComplete: true,
  });

  const bottoms = [];
  RUNTIME_ORDER.forEach((runtimeId, i) => {
    const colX = i === 0 ? PAD : PAD + COLUMN_W + COLUMN_GAP;
    const withGroup = groups.find((g) => g.runtimeId === runtimeId && g.arm === 'product');
    const withoutGroup = groups.find((g) => g.runtimeId === runtimeId && g.arm === 'free');
    const label = runtimeModelLabel(summary, runtimeId);
    const rendered = renderCompositionRow(
      colX, headerBottom, label, label, composition(withGroup), composition(withoutGroup), 1,
      COST_COMPONENTS, TOKEN_COMPONENT_COLORS, TOKEN_COMPONENT_LABEL, fmtValue, undefined,
    );
    items.push(...rendered.items);
    bottoms.push(headerBottom + rendered.rowHeight);
  });
  return { width: GRID_W, height: Math.round(Math.max(...bottoms) + PAD), items };
}

export function renderCostBreakdownSvg(summary, costEstimate) {
  const layout = computeCostBreakdownLayout(summary, costEstimate);
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
  const componentLegend = COST_COMPONENTS.map((k) => `${TOKEN_COMPONENT_LABEL[k]} (${TOKEN_COMPONENT_COLORS[k]})`).join(', ');
  const desc = `Color legend. With kmp-test (${COLOR_WITH}), without (${COLOR_WITHOUT}). Cost component: ${componentLegend}.`;
  return `<svg viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" xmlns="http://www.w3.org/2000/svg" role="img" font-family="${FONT_STACK}">
  <title>${escapeXml(FIGURE_TITLE)}</title>
  <desc>${escapeXml(desc)}</desc>
  <rect x="1" y="1" width="${layout.width - 2}" height="${layout.height - 2}" rx="12" fill="${COLOR_CARD_FILL}" stroke="${COLOR_CARD_STROKE}" stroke-width="1"/>
  ${parts.join('\n  ')}
</svg>
`;
}

// ---------------------------------------------------------------------------
// Generated tables

const fmtYesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : '—');
const fmtFixed = (v, digits) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—');
const fmtThousands = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US') : '—');

export function buildCostComponentsBlock(costEstimate) {
  const groups = costGroups(costEstimate);
  const lines = [
    'Median cost per session by component (USD, estimated at list prices)',
    '',
    `| Agent and arm | ${COST_COMPONENTS.map((k) => TOKEN_COMPONENT_LABEL[k]).join(' | ')} | median session total | sessions |`,
    `|---|${COST_COMPONENTS.map(() => '---:|').join('')}---:|---:|`,
  ];
  for (const g of groups) {
    const cells = COST_COMPONENTS.map((k) => (g.sessions.every((s) => s.components[k] === 0) ? '—' : g.medianComponent[k].toFixed(3)));
    lines.push(`| ${AGENT_LABEL[g.runtimeId]} ${ARM_LABEL[g.arm]} | ${cells.join(' | ')} | ${g.medianTotal.toFixed(3)} | ${g.sessions.length} |`);
  }
  lines.push('', 'Component medians are taken separately, so they need not add up to the median total.');
  return lines.join('\n');
}

// Token columns: one per disjoint type, in TOKEN_COMPONENT_TYPES order (first appearance across
// the runtimes), so each agent's own types fall under the same heading.
function tokenColumnTypes() {
  const types = [];
  for (const runtimeId of RUNTIME_ORDER) for (const t of TOKEN_COMPONENT_TYPES[runtimeId]) if (!types.includes(t)) types.push(t);
  return types;
}

export function buildSessionsBlock(summary, costEstimate) {
  const tokenTypes = tokenColumnTypes();
  const header = [
    'Agent', 'Arm', 'Round', 'Key facts', 'Full answer', 'Wall-clock (min)', 'Tool calls', 'Shell kmp-test/Gradle/other', 'Turns',
    ...tokenTypes.map((t) => TOKEN_COMPONENT_LABEL[t]), 'Tool output (KB)', 'Est. cost (USD)',
  ];
  const align = header.map((_, i) => (i < 2 ? '---' : i === 3 || i === 4 ? '---' : '---:'));
  const lines = [`| ${header.join(' | ')} |`, `|${align.join('|')}|`];
  // One row per counted session (accepted or negative-D3, the cells every aggregate and the cost
  // estimate are built from). A session that was rejected and not replaced has no metrics to show and no
  // cost cell, so it gets no row rather than a row of empty values.
  const ordered = summary.cells.filter((c) => c.status !== 'missing')
    .sort((a, b) => RUNTIME_ORDER.indexOf(a.runtime_id) - RUNTIME_ORDER.indexOf(b.runtime_id) || a.round_index - b.round_index);
  for (const cell of ordered) {
    const tokens = cell.tokens ? disjointTokens(cell.tokens, cell.runtime_id) : {};
    const kinds = cell.command_kind_counts;
    const entry = costEstimateCellEntry(costEstimate, cell.runtime_id, cell.arm, cell.round_index);
    const cost = entry ? costEstimateCellMidpoint(costEstimate, cell.runtime_id, entry) : null;
    const toolOutput = toolOutputMeasured(summary, cell.runtime_id) ? fmtFixed(cell.output_bytes / 1000, 1) : '—';
    const row = [
      AGENT_LABEL[cell.runtime_id], ARM_LABEL[cell.arm], String(cell.round_index),
      fmtYesNo(cell.key_facts_match), fmtYesNo(cell.full_answer_match),
      fmtFixed(cell.duration_ms / 60000, 1), fmtThousands(cell.tool_calls_total),
      kinds ? `${kinds.kmp_test}/${kinds.gradle}/${kinds.other}` : '—',
      fmtThousands(cell.num_turns),
      ...tokenTypes.map((t) => fmtThousands(tokens[t])),
      toolOutput, fmtFixed(cost, 3),
    ];
    lines.push(`| ${row.join(' | ')} |`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// docs/agentic-benchmark.md blocks

export function docBlockMarkers(blockId) {
  return {
    start: `<!-- agentic-benchmark-doc:${blockId}:start (generated by tools/agentic-eval/benchmark-doc.mjs; do not edit) -->`,
    end: `<!-- agentic-benchmark-doc:${blockId}:end -->`,
  };
}

/** The generated blocks of one evidence, keyed by block id. */
export function docBlocks(evidenceN, summary, costEstimate) {
  return {
    [`e${evidenceN}-cost-components`]: buildCostComponentsBlock(costEstimate),
    [`e${evidenceN}-sessions`]: buildSessionsBlock(summary, costEstimate),
  };
}

/** The text between a block's markers, or null when the markers are absent or out of order. */
export function readDocBlock(doc, blockId) {
  const { start, end } = docBlockMarkers(blockId);
  const s = doc.indexOf(start);
  const e = doc.indexOf(end);
  if (s === -1 || e === -1 || e < s) return null;
  return doc.slice(s + start.length, e);
}

/** The doc with every given block's content replaced; throws when a block's markers are missing. */
export function fillDocBlocks(doc, blocks) {
  let out = doc;
  for (const [blockId, content] of Object.entries(blocks)) {
    const { start, end } = docBlockMarkers(blockId);
    const s = out.indexOf(start);
    const e = out.indexOf(end);
    if (s === -1 || e === -1 || e < s) throw new Error(`docs/agentic-benchmark.md is missing the ${blockId} block markers`);
    out = `${out.slice(0, s + start.length)}\n${content}\n${out.slice(e)}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI

function main(argv) {
  const mode = argv.includes('--write') ? 'write' : 'check';
  const evidenceN = (argv.find((a) => a.startsWith('--evidence=')) || '').split('=')[1];
  const campaignDate = (argv.find((a) => a.startsWith('--date=')) || '').split('=')[1];
  if (!/^\d+$/.test(evidenceN || '') || !/^\d{4}-\d{2}-\d{2}$/.test(campaignDate || '')) {
    console.error('::error::usage: node tools/agentic-eval/benchmark-doc.mjs [--write] --evidence=<n> --date=<yyyy-mm-dd>');
    process.exit(1);
  }
  const runsDir = join(REPO_ROOT, 'tools', 'runs', `evidence${evidenceN}-agentic-benchmark-${campaignDate}`);
  const summaryPath = join(runsDir, 'campaign-summary.json');
  const costEstimatePath = join(runsDir, 'cost-estimate.json');
  for (const p of [summaryPath, costEstimatePath, DOC_PATH]) {
    if (!existsSync(p)) {
      console.error(`::error::${p} not found`);
      process.exit(1);
    }
  }

  let summary, costEstimate, svg, filled;
  const doc = readFileSync(DOC_PATH, 'utf8');
  try {
    summary = loadSummary(summaryPath);
    costEstimate = loadCostEstimate(costEstimatePath);
    const pairingErrors = validatePairing(summary, costEstimate);
    if (pairingErrors.length > 0) throw new Error(`campaign-summary.json / cost-estimate.json mismatch:\n  ${pairingErrors.join('\n  ')}`);
    svg = renderCostBreakdownSvg(summary, costEstimate);
    filled = fillDocBlocks(doc, docBlocks(evidenceN, summary, costEstimate));
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }

  const svgPath = join(runsDir, 'cost-breakdown.svg');
  if (mode === 'write') {
    writeFileSync(svgPath, svg);
    writeFileSync(DOC_PATH, filled);
    console.log(`Wrote ${svgPath}\nUpdated the evidence ${evidenceN} blocks of ${DOC_PATH}`);
    return;
  }

  const mismatches = [];
  if (!existsSync(svgPath) || readFileSync(svgPath, 'utf8') !== svg) mismatches.push(svgPath);
  if (doc !== filled) mismatches.push(DOC_PATH);
  if (mismatches.length > 0) {
    console.error(`::error::out of date, run with --write: ${mismatches.join(', ')}`);
    process.exit(1);
  }
  console.log(`Evidence ${evidenceN} cost breakdown and docs/agentic-benchmark.md blocks are up to date.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

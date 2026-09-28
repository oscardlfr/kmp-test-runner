#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/readme-evidence.mjs — deterministic generator that turns a
// committed campaign-summary.json into two SVG charts and the README block
// between <!-- agentic-benchmark:start/end -->.
//
// Usage:
//   node tools/agentic-eval/readme-evidence.mjs --check   (default) exits 1 if
//     regenerating would change any committed file
//   node tools/agentic-eval/readme-evidence.mjs --write   writes outcomes.svg,
//     effort.svg and the README block in place
//
// Never edit outcomes.svg, effort.svg or the README block between the markers
// by hand -- edit this generator (or the campaign-summary.json / cost-estimate.json
// it reads) and regenerate. Fails closed unless the summary is summary_status:"ok",
// provider_mode:"live", schema 1, with all 4 (runtime x arm) groups declaring
// exactly 4 cells each, and cost-estimate.json is schema 1 with 4 claude-code
// cells per arm and a complete price table -- a partial or non-live summary,
// or an incomplete cost estimate, must never render.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const COLOR_WITH = '#2a78d6';
const COLOR_WITHOUT = '#eb6834';
const COLOR_CARD = '#fcfcfb';
const COLOR_INK = '#0b0b0b';
const COLOR_INK_MUTED = '#52514e';
const COLOR_INK_FAINT = '#898781';
const COLOR_GRID = '#e1e0d9';
const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const RUNTIME_LABELS = {
  'claude-code': 'Claude Code · claude-sonnet-5',
  'codex-cli': 'Codex CLI · gpt-5.6-terra',
};
const RUNTIME_KEY = { 'claude-code': 'CLAUDE', 'codex-cli': 'CODEX' };
const RUNTIME_ORDER = ['claude-code', 'codex-cli'];
const ARM_ORDER = ['product', 'free']; // "with kmp-test" before "without kmp-test"
const ARM_LABEL = { product: 'with kmp-test', free: 'without kmp-test' };
const ARM_COLOR = { product: COLOR_WITH, free: COLOR_WITHOUT };

// ---------------------------------------------------------------------------
// Loading + validation -- fails closed on anything but a complete, live summary

export function validateSummary(summary) {
  const errors = [];
  if (!summary || typeof summary !== 'object') return ['summary is not an object'];
  if (summary.schema !== 1) errors.push(`schema must be 1, got ${JSON.stringify(summary.schema)}`);
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
    }
  }
  return errors;
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

function findCells(summary, runtime, arm) {
  return summary.cells
    .filter(c => c.runtime_id === runtime && c.arm === arm)
    .sort((a, b) => a.round_index - b.round_index);
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
  if (doc.schema !== 1) errors.push(`schema must be 1, got ${JSON.stringify(doc.schema)}`);
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

export function loadCostEstimate(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateCostEstimate(raw);
  if (errors.length > 0) {
    throw new Error(`cost-estimate.json failed validation:\n  ${errors.join('\n  ')}`);
  }
  return raw;
}

// One session's cost at a given per-million-token price table.
function sessionCost(tokens, price, cacheWriteKey) {
  return (
    tokens.input * price.input +
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
function armCostRange(cells, price) {
  const low5m = cells.map(c => sessionCost(c.tokens, price, 'cache_write_5m'));
  const high1h = cells.map(c => sessionCost(c.tokens, price, 'cache_write_1h'));
  return { low: Math.min(...low5m), high: Math.max(...high1h) };
}

function fmtCostRange({ low, high }) {
  return `$${low.toFixed(3)}–$${high.toFixed(3)}`;
}

export function buildCostSentence(costEstimate) {
  const price = costEstimate.pricing.per_million_tokens;
  const cellsFor = arm => costEstimate.cells.filter(c => c.runtime_id === 'claude-code' && c.arm === arm);
  const withRange = armCostRange(cellsFor('product'), price);
  const withoutRange = armCostRange(cellsFor('free'), price);
  return `Claude Code estimated API cost per session: ${fmtCostRange(withRange)} with kmp-test, ${fmtCostRange(withoutRange)} without (recorded tokens × published Sonnet 5 prices; an estimate, not a bill). Not estimated for Codex CLI.`;
}

// ---------------------------------------------------------------------------
// Formatting helpers -- "not recorded" for anything absent, never inferred

function fmtRatio(match) {
  if (!match || typeof match.of !== 'number') return 'not recorded';
  return `${match.matched}/${match.of}`;
}

function fmtMinutesStat(stat) {
  if (!stat || stat.n === 0 || stat.median == null) return 'not recorded';
  const min = (stat.min / 60000).toFixed(1);
  const max = (stat.max / 60000).toFixed(1);
  const median = (stat.median / 60000).toFixed(1);
  return `${median} min (${min}–${max})`;
}

function fmtCountStat(stat) {
  if (!stat || stat.n === 0 || stat.median == null) return 'not recorded';
  return `${stat.median} (${stat.min}–${stat.max})`;
}

// ---------------------------------------------------------------------------
// README block placeholders

export function buildPlaceholders(summary, campaignDate) {
  const p = {};
  for (const runtime of RUNTIME_ORDER) {
    const rk = RUNTIME_KEY[runtime];
    for (const arm of ARM_ORDER) {
      const ak = arm === 'product' ? 'PRODUCT' : 'FREE';
      const g = findGroup(summary, runtime, arm);
      p[`KEY_FACTS_${ak}_${rk}`] = fmtRatio(g.key_facts_match);
      p[`FULL_ANSWER_${ak}_${rk}`] = fmtRatio(g.full_answer_match);
      p[`WALL_${ak}_${rk}`] = fmtMinutesStat(g.duration_ms);
      p[`TOOLS_${ak}_${rk}`] = fmtCountStat(g.tool_calls_total);
    }
  }

  // Ceiling wording (rule e): "no difference in key facts at n=4 (16/16)" --
  // the exact phrase, with the totals computed, not hardcoded, so a future
  // campaign's own N is reflected correctly if it ever differs from 4x4.
  const allGroups = RUNTIME_ORDER.flatMap(r => ARM_ORDER.map(a => findGroup(summary, r, a)));
  p.KEY_FACTS_AT_CEILING = allGroups.every(g => g.key_facts_match.matched === g.key_facts_match.of);
  const totalMatched = allGroups.reduce((sum, g) => sum + g.key_facts_match.matched, 0);
  const totalOf = allGroups.reduce((sum, g) => sum + g.key_facts_match.of, 0);
  p.KEY_FACTS_CEILING_TOTALS = `${totalMatched}/${totalOf}`;

  // Missing / abandoned note: only say something when there is something to
  // say. A campaign with 0 missing and 0 negative_d3 everywhere gets no
  // trailing sentence at all, not an empty or vacuous one.
  const reasons = [];
  for (const runtime of RUNTIME_ORDER) {
    for (const arm of ARM_ORDER) {
      const g = findGroup(summary, runtime, arm);
      if (g.missing > 0 || g.negative_d3 > 0) {
        const bits = [];
        if (g.negative_d3 > 0) bits.push(`${g.negative_d3} counted negative`);
        if (g.missing > 0) bits.push(`${g.missing} missing (${(g.missing_reasons || []).join(', ') || 'not recorded'})`);
        reasons.push(`${RUNTIME_LABELS[runtime]} ${ARM_LABEL[arm]}: ${bits.join(', ')}`);
      }
    }
  }
  p.MISSING_OR_ABANDONED_NOTE = reasons.length > 0 ? reasons.join('; ') + '.' : '';

  p.CAMPAIGN_DATE = campaignDate;
  return p;
}

// ---------------------------------------------------------------------------
// outcomes.svg -- primary metric, one square per session

function renderSquareRow(cells, x, y, color) {
  const parts = [];
  const n = 4;
  const size = 20, gap = 6;
  for (let i = 0; i < n; i++) {
    const cx = x + i * (size + gap);
    const cell = cells[i];
    if (!cell) {
      // muted en dash: rejected and not counted
      parts.push(`<text x="${cx + size / 2}" y="${y + size / 2 + 5}" text-anchor="middle" font-size="16" fill="${COLOR_INK_FAINT}">–</text>`);
      continue;
    }
    if (cell.key_facts_match) {
      parts.push(`<rect x="${cx}" y="${y}" width="${size}" height="${size}" rx="4" fill="${color}"/>`);
    } else {
      parts.push(`<rect x="${cx}" y="${y}" width="${size}" height="${size}" rx="4" fill="none" stroke="${color}" stroke-width="2"/>`);
    }
  }
  return parts.join('\n    ');
}

export function renderOutcomesSvg(summary) {
  const W = 640, H = 232;
  const panelW = W / 2;
  const rowsY = { product: 96, free: 132 };
  const panels = RUNTIME_ORDER.map((runtime, i) => {
    const px = i * panelW;
    const cellsProduct = findCells(summary, runtime, 'product');
    const cellsFree = findCells(summary, runtime, 'free');
    const gProduct = findGroup(summary, runtime, 'product');
    const gFree = findGroup(summary, runtime, 'free');
    const labelX = px + 24;
    const squaresX = px + 150;
    const kOfNX = px + panelW - 24;
    return `
  <text x="${labelX}" y="60" font-size="14" font-weight="600" fill="${COLOR_INK}">${RUNTIME_LABELS[runtime]}</text>
  <text x="${labelX}" y="${rowsY.product + 15}" font-size="12" fill="${COLOR_INK_MUTED}">with kmp-test</text>
  ${renderSquareRow(cellsProduct, squaresX, rowsY.product, COLOR_WITH)}
  <text x="${kOfNX}" y="${rowsY.product + 15}" text-anchor="end" font-size="12" fill="${COLOR_INK_MUTED}">${fmtRatio(gProduct.key_facts_match)}</text>
  <text x="${labelX}" y="${rowsY.free + 15}" font-size="12" fill="${COLOR_INK_MUTED}">without kmp-test</text>
  ${renderSquareRow(cellsFree, squaresX, rowsY.free, COLOR_WITHOUT)}
  <text x="${kOfNX}" y="${rowsY.free + 15}" text-anchor="end" font-size="12" fill="${COLOR_INK_MUTED}">${fmtRatio(gFree.key_facts_match)}</text>`;
  }).join('\n');

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" role="img">
  <title>Did the agent report the right coverage-gate facts?</title>
  <desc>${buildOutcomesAlt(summary)}</desc>
  <rect x="0" y="0" width="${W}" height="${H}" rx="8" fill="${COLOR_CARD}"/>
  <text x="24" y="28" font-size="15" font-weight="600" fill="${COLOR_INK}">Did the agent report the right coverage-gate facts?</text>
  <text x="24" y="46" font-size="12" fill="${COLOR_INK_FAINT}">Primary metric · one square per session · pre-registered, n=4 per arm</text>
  <line x1="${panelW}" y1="52" x2="${panelW}" y2="${H - 16}" stroke="${COLOR_GRID}" stroke-width="1"/>${panels}
  <rect x="24" y="${H - 24}" width="12" height="12" rx="3" fill="${COLOR_INK_FAINT}"/>
  <text x="42" y="${H - 14}" font-size="11" fill="${COLOR_INK_MUTED}">filled = all 4 key facts matched · hollow = counted, not matched · &#8211; = rejected</text>
</svg>
`;
}

function buildOutcomesAlt(summary) {
  const parts = [];
  for (const runtime of RUNTIME_ORDER) {
    for (const arm of ARM_ORDER) {
      const g = findGroup(summary, runtime, arm);
      parts.push(`${RUNTIME_LABELS[runtime]} ${ARM_LABEL[arm]}: key facts ${fmtRatio(g.key_facts_match)}`);
    }
  }
  return parts.join('; ') + '.';
}

// ---------------------------------------------------------------------------
// effort.svg -- secondary efficiency metrics, one dot per session

function bandDomain(x0, x1, ...valueLists) {
  const all = valueLists.flat();
  const min = 0; // 0-based per spec, regardless of data floor
  const max = Math.max(...all, 1e-9);
  return v => x0 + ((v - min) / (max - min)) * (x1 - x0);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[Math.floor(mid)];
}

// Ties (same value -> same x) are jittered VERTICALLY, not horizontally --
// a horizontal nudge would visually misstate the value itself; a vertical
// one keeps every dot's x position exactly true to its value.
function renderDotRow({ cells, y, color, valueOf, scale }) {
  const withValues = cells.map(c => ({ cell: c, v: valueOf(c) })).filter(x => x.v != null);
  if (withValues.length === 0) return { svg: '', n: 0, median: null };
  const parts = [];
  const seenKey = new Map();
  for (const { v } of withValues) {
    const cx = scale(v);
    const key = Math.round(cx);
    const tie = seenKey.get(key) || 0;
    seenKey.set(key, tie + 1);
    const dy = tie === 0 ? 0 : (Math.ceil(tie / 2) * 5) * (tie % 2 === 1 ? -1 : 1);
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${(y + dy).toFixed(1)}" r="4.5" fill="${color}" stroke="${COLOR_CARD}" stroke-width="2"/>`);
  }
  const med = median(withValues.map(x => x.v));
  const medianX = scale(med);
  parts.push(`<line x1="${medianX.toFixed(1)}" y1="${y - 8}" x2="${medianX.toFixed(1)}" y2="${y + 8}" stroke="${COLOR_INK}" stroke-width="2"/>`);
  return { svg: parts.join('\n      '), n: withValues.length, median: med };
}

export function renderEffortSvg(summary) {
  const W = 640, H = 300;
  const panelW = W / 2;
  const axisX0Offset = 96, axisX1Offset = panelW - 88;
  const bandY = { wall: 100, tools: 210 };
  const rowDy = 30;

  const panels = RUNTIME_ORDER.map((runtime, i) => {
    const px = i * panelW;
    const x0 = px + axisX0Offset, x1 = px + axisX1Offset;
    const labelX = px + 24;

    const wallOf = c => c.duration_ms / 60000;
    const toolsOf = c => c.tool_calls_total;
    const wallCellsProduct = findCells(summary, runtime, 'product');
    const wallCellsFree = findCells(summary, runtime, 'free');
    // Shared per-band domain (spec: "shared 0-based linear axis per panel") --
    // both rows of a band use the SAME scale, computed from their union, not
    // each row scaled independently against its own min/max.
    const wallScale = bandDomain(x0, x1, wallCellsProduct.map(wallOf), wallCellsFree.map(wallOf));
    const toolsScale = bandDomain(x0, x1, wallCellsProduct.map(toolsOf), wallCellsFree.map(toolsOf));

    const wallProduct = renderDotRow({ cells: wallCellsProduct, y: bandY.wall, color: COLOR_WITH, valueOf: wallOf, scale: wallScale });
    const wallFree = renderDotRow({ cells: wallCellsFree, y: bandY.wall + rowDy, color: COLOR_WITHOUT, valueOf: wallOf, scale: wallScale });
    const toolsProduct = renderDotRow({ cells: wallCellsProduct, y: bandY.tools, color: COLOR_WITH, valueOf: toolsOf, scale: toolsScale });
    const toolsFree = renderDotRow({ cells: wallCellsFree, y: bandY.tools + rowDy, color: COLOR_WITHOUT, valueOf: toolsOf, scale: toolsScale });

    const gridLines = [0, 0.5, 1].map(t => {
      const gx = x0 + t * (x1 - x0);
      return `<line x1="${gx.toFixed(1)}" y1="${bandY.wall - 20}" x2="${gx.toFixed(1)}" y2="${bandY.wall + rowDy + 12}" stroke="${COLOR_GRID}" stroke-width="1"/>
      <line x1="${gx.toFixed(1)}" y1="${bandY.tools - 20}" x2="${gx.toFixed(1)}" y2="${bandY.tools + rowDy + 12}" stroke="${COLOR_GRID}" stroke-width="1"/>`;
    }).join('\n      ');

    const nSuffix = s => s.n > 0 && s.n < 4 ? ` (n=${s.n})` : '';

    return `
  <text x="${labelX}" y="62" font-size="14" font-weight="600" fill="${COLOR_INK}">${RUNTIME_LABELS[runtime]}</text>
  ${gridLines}
  <text x="${labelX}" y="${bandY.wall - 26}" font-size="11" fill="${COLOR_INK_FAINT}">Wall-clock (min)</text>
  <text x="${labelX}" y="${bandY.wall + 4}" font-size="11" fill="${COLOR_INK_MUTED}">with${nSuffix(wallProduct)}</text>
  ${wallProduct.svg}
  <text x="${x1 + 8}" y="${bandY.wall + 4}" font-size="11" fill="${COLOR_INK_MUTED}">${wallProduct.median != null ? wallProduct.median.toFixed(1) : '–'}</text>
  <text x="${labelX}" y="${bandY.wall + rowDy + 4}" font-size="11" fill="${COLOR_INK_MUTED}">without${nSuffix(wallFree)}</text>
  ${wallFree.svg}
  <text x="${x1 + 8}" y="${bandY.wall + rowDy + 4}" font-size="11" fill="${COLOR_INK_MUTED}">${wallFree.median != null ? wallFree.median.toFixed(1) : '–'}</text>
  <text x="${labelX}" y="${bandY.tools - 26}" font-size="11" fill="${COLOR_INK_FAINT}">Tool calls</text>
  <text x="${labelX}" y="${bandY.tools + 4}" font-size="11" fill="${COLOR_INK_MUTED}">with${nSuffix(toolsProduct)}</text>
  ${toolsProduct.svg}
  <text x="${x1 + 8}" y="${bandY.tools + 4}" font-size="11" fill="${COLOR_INK_MUTED}">${toolsProduct.median != null ? Math.round(toolsProduct.median) : '–'}</text>
  <text x="${labelX}" y="${bandY.tools + rowDy + 4}" font-size="11" fill="${COLOR_INK_MUTED}">without${nSuffix(toolsFree)}</text>
  ${toolsFree.svg}
  <text x="${x1 + 8}" y="${bandY.tools + rowDy + 4}" font-size="11" fill="${COLOR_INK_MUTED}">${toolsFree.median != null ? Math.round(toolsFree.median) : '–'}</text>`;
  }).join('\n');

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" role="img">
  <title>How much work did each session take?</title>
  <desc>${buildEffortAlt(summary)}</desc>
  <rect x="0" y="0" width="${W}" height="${H}" rx="8" fill="${COLOR_CARD}"/>
  <text x="24" y="28" font-size="15" font-weight="600" fill="${COLOR_INK}">How much work did each session take?</text>
  <text x="24" y="46" font-size="12" fill="${COLOR_INK_FAINT}">dot = one session · tick = median · each agent on its own axis</text>
  <line x1="${panelW}" y1="52" x2="${panelW}" y2="${H - 8}" stroke="${COLOR_GRID}" stroke-width="1"/>${panels}
</svg>
`;
}

function buildEffortAlt(summary) {
  const parts = [];
  for (const runtime of RUNTIME_ORDER) {
    for (const arm of ARM_ORDER) {
      const g = findGroup(summary, runtime, arm);
      parts.push(`${RUNTIME_LABELS[runtime]} ${ARM_LABEL[arm]}: wall-clock ${fmtMinutesStat(g.duration_ms)}, tool calls ${fmtCountStat(g.tool_calls_total)}`);
    }
  }
  return parts.join('; ') + '.';
}

// ---------------------------------------------------------------------------
// README block

export function renderReadmeBlock(summary, campaignDate, costEstimate) {
  const p = buildPlaceholders(summary, campaignDate);
  const runsPath = `tools/runs/evidence1-agentic-benchmark-${campaignDate}`;
  const costSentence = buildCostSentence(costEstimate);
  const ceilingSentence = p.KEY_FACTS_AT_CEILING
    ? ` No difference in key facts at n=4 (${p.KEY_FACTS_CEILING_TOTALS}).`
    : '';
  const missingSentence = p.MISSING_OR_ABANDONED_NOTE ? ` ${p.MISSING_OR_ABANDONED_NOTE}` : '';

  return `<!-- agentic-benchmark:start (generated by tools/agentic-eval/readme-evidence.mjs from ${runsPath}/campaign-summary.json; edit the generator, not this block) -->
### Agent sessions with and without kmp-test

kmp-test hands an agent the test and coverage verdict as one JSON envelope instead of Gradle logs and report files. To check that this helps end to end, Claude Code and Codex CLI each ran the same pre-registered coverage-gate task on a pinned NowInAndroid commit: 4 sessions with the kmp-test skill and CLI, 4 without. Every session is shown; none was re-run or replaced.

![${buildOutcomesAlt(summary)}](${runsPath}/outcomes.svg)

![${buildEffortAlt(summary)}](${runsPath}/effort.svg)

| Agent (model) | Arm | Key facts correct | Full answer correct | Wall-clock per session, median (range) | Tool calls per session, median (range) |
|---|---|:-:|:-:|--:|--:|
| Claude Code (\`claude-sonnet-5\`) | with kmp-test | ${p.KEY_FACTS_PRODUCT_CLAUDE} | ${p.FULL_ANSWER_PRODUCT_CLAUDE} | ${p.WALL_PRODUCT_CLAUDE} | ${p.TOOLS_PRODUCT_CLAUDE} |
| Claude Code (\`claude-sonnet-5\`) | without kmp-test | ${p.KEY_FACTS_FREE_CLAUDE} | ${p.FULL_ANSWER_FREE_CLAUDE} | ${p.WALL_FREE_CLAUDE} | ${p.TOOLS_FREE_CLAUDE} |
| Codex CLI (\`gpt-5.6-terra\`) | with kmp-test | ${p.KEY_FACTS_PRODUCT_CODEX} | ${p.FULL_ANSWER_PRODUCT_CODEX} | ${p.WALL_PRODUCT_CODEX} | ${p.TOOLS_PRODUCT_CODEX} |
| Codex CLI (\`gpt-5.6-terra\`) | without kmp-test | ${p.KEY_FACTS_FREE_CODEX} | ${p.FULL_ANSWER_FREE_CODEX} | ${p.WALL_FREE_CODEX} | ${p.TOOLS_FREE_CODEX} |

Compare each agent's two rows with each other. The agents differ in model, tools and harness, so the table does not rank Claude Code against Codex CLI.${ceilingSentence}${missingSentence}

${costSentence}

**Scope:** one scenario, tagged \`train\` (the skill was tuned on this task family); n=4 sessions per arm per agent in counterbalanced order; Windows 11 in an isolated VM with a restricted network (provider APIs only); design and metrics fixed before any live session. Claude Code 2.1.238 · claude-sonnet-5 · effort not set by the harness (docs default: high). Codex CLI 0.154.0 · gpt-5.6-terra · reasoning effort low. Key facts = module, outcome, coverage numbers. "Full answer" also requires the test counts, which the prompt leaves ambiguous. [Evidence, per-session detail and limitations](${runsPath}/README.md) · [controls audit](${runsPath}/controls-audit.md) · [pre-registration](${runsPath}/preregistration.md)
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

  const outcomesSvg = renderOutcomesSvg(summary);
  const effortSvg = renderEffortSvg(summary);
  const block = renderReadmeBlock(summary, campaignDate, costEstimate);

  const outcomesPath = join(runsDir, 'outcomes.svg');
  const effortPath = join(runsDir, 'effort.svg');
  const readmePath = join(REPO_ROOT, 'README.md');

  if (mode === 'write') {
    writeFileSync(outcomesPath, outcomesSvg);
    writeFileSync(effortPath, effortSvg);
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
    console.log(`Wrote ${outcomesPath}\nWrote ${effortPath}\nUpdated README.md block`);
    return;
  }

  // check mode: regenerate and diff against what's committed
  let mismatches = [];
  if (!existsSync(outcomesPath) || readFileSync(outcomesPath, 'utf8') !== outcomesSvg) mismatches.push(outcomesPath);
  if (!existsSync(effortPath) || readFileSync(effortPath, 'utf8') !== effortSvg) mismatches.push(effortPath);
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
  console.log('README evidence block and charts are up to date.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

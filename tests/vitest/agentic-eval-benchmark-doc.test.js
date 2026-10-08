// tests/vitest/agentic-eval-benchmark-doc.test.js
// Guard for tools/agentic-eval/benchmark-doc.mjs: the cost-breakdown figure and the generated blocks
// of docs/agentic-benchmark.md, plus the statements of that page's fixed prose that the committed
// data must back. No network calls; reads only what is committed under tools/runs/ and docs/.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadSummary, loadCostEstimate, costMetric, renderReadmeBlock, README_NOTES, loadScenarioFacts,
  TOKEN_COMPONENT_TYPES, disjointTokens, validateSummary, validateCostEstimate, validatePairing,
} from '../../tools/agentic-eval/readme-evidence.mjs';
import { costEstimateCellEntry, costEstimateCellMidpoint } from '../../tools/agentic-eval/evidence2-tables.mjs';
import {
  sessionCostComponents, costGroups, computeCostBreakdownLayout, renderCostBreakdownSvg,
  buildCostComponentsBlock, buildSessionsBlock, docBlocks, readDocBlock, fillDocBlocks, docBlockMarkers,
  buildScenarioBlock, loadScenarioPublicationFacts, buildRunBlock, buildCampaignsBlock, docContext, missingSessionsNote, staleOutputs,
} from '../../tools/agentic-eval/benchmark-doc.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const RUNS_DIR_NAME = 'evidence2-agentic-benchmark-2026-09-30';
const RUNS_DIR = join(REPO_ROOT, 'tools', 'runs', RUNS_DIR_NAME);
const DOC_PATH = join(REPO_ROOT, 'docs', 'agentic-benchmark.md');

const crlfNormalize = (s) => s.replace(/\r\n/g, '\n');
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const sum = (values) => values.reduce((a, b) => a + b, 0);

// The palette and arm colors, typed out here rather than imported so that an accidental change to
// either one in the generator fails this file instead of following it.
const COLOR_WITH = '#0969da';
const COLOR_WITHOUT = '#bc4c00';
const COMPONENT_COLORS = { cache_write: '#1a7f37', cache_read: '#1b7c83', output: '#bf3989', uncached_input: '#8250df' };
const COMPONENTS = ['cache_write', 'cache_read', 'output', 'uncached_input'];
const SECOND_COLUMN_X = 28 + 396 + 32; // the grid's frame: padding 28, columns 396 wide, 32 apart

// One session's cost components, written out independently of the generator from the price table
// in cost-estimate.json: cache write at the mean of the 5-minute and 1-hour rates; uncached input at
// the mean of the plain input rate and, where the provider cannot tell a cache write from plain input,
// the dearer cache-write rate.
function rawComponents(entry, tokens) {
  const p = entry.per_million_tokens;
  const dearInput = entry.uncached_input_may_be_cache_writes === true ? Math.max(p.cache_write_5m, p.cache_write_1h) : p.input;
  return {
    cache_write: (tokens.cache_creation * (p.cache_write_5m + p.cache_write_1h) / 2) / 1e6,
    cache_read: (tokens.cache_read * p.cache_read) / 1e6,
    output: (tokens.output * p.output) / 1e6,
    uncached_input: (tokens.input * (p.input + dearInput) / 2) / 1e6,
  };
}
const rawTotal = (components) => sum(COMPONENTS.map((k) => components[k]));

// The cost-breakdown figure draws a bar as long as its group's median session cost, on one dollar scale for the whole figure, and splits
// it by the group's pooled shares of its cost. The numbers below are written out here, independently of the generator.
const BAR_W = 242; // the grid's composition-row bar width, typed out so that a change in the renderer fails this file
const COST_FIGURE_SUBTITLE = 'Bar length is the median session cost, on one scale for both agents; the colors split it by each group\'s share of its total cost (percentages below). Blue: with kmp-test; orange: without.';
const COLUMN_GROUPS = [['claude-code', 'product'], ['claude-code', 'free'], ['codex-cli', 'product'], ['codex-cli', 'free']];
const COMPONENT_LABEL = { cache_write: 'cache write', cache_read: 'cache read', output: 'output', uncached_input: 'uncached input' };

/** One group's median session cost and pooled share of each component, from the price table and the tokens. */
function groupFacts(costEstimate, runtimeId, arm) {
  const entry = costEstimate.runtimes[runtimeId];
  const sessions = entry.cells.filter((c) => c.arm === arm).map((c) => rawComponents(entry, c.tokens));
  const total = sum(sessions.map(rawTotal));
  return { medianTotal: median(sessions.map(rawTotal)), share: Object.fromEntries(COMPONENTS.map((k) => [k, sum(sessions.map((s) => s[k])) / total])) };
}

/** The four lanes of a figure's layout in drawing order (column by column, "with kmp-test" above "without"), each its bars left to right. */
function lanesOf(layout) {
  const bars = layout.items.filter((i) => i.kind === 'bar');
  return [0, 1].flatMap((c) => {
    const inColumn = bars.filter((b) => (c === 0 ? b.x < SECOND_COLUMN_X : b.x >= SECOND_COLUMN_X));
    const laneYs = [...new Set(inColumn.map((b) => b.y))].sort((p, q) => p - q);
    return laneYs.map((y) => inColumn.filter((b) => b.y === y).sort((p, q) => p.x - q.x));
  });
}

/** Bar length is the group's median session cost over the largest median of the four groups, times the lane width; the longest bar fills the
 * lane; each bar splits into segments proportional to the pooled shares, in the order cache write, cache read, output, uncached input. */
function expectBarsAtTheMedianCost(layout, costEstimate) {
  const lanes = lanesOf(layout);
  expect(lanes).toHaveLength(4);
  const facts = COLUMN_GROUPS.map(([runtimeId, arm]) => groupFacts(costEstimate, runtimeId, arm));
  const largest = Math.max(...facts.map((f) => f.medianTotal));
  const colorToComponent = Object.fromEntries(Object.entries(COMPONENT_COLORS).map(([k, v]) => [v, k]));
  const lengths = lanes.map((lane) => sum(lane.map((b) => b.w)));
  lanes.forEach((lane, i) => {
    const label = COLUMN_GROUPS[i].join('/');
    expect(Math.abs(lengths[i] - (facts[i].medianTotal / largest) * BAR_W), `${label} bar length`).toBeLessThan(0.1);
    const expectedSegments = COMPONENTS.map((k) => ({ component: k, share: facts[i].share[k] })).filter((s) => s.share > 0);
    expect(lane.map((b) => colorToComponent[b.fill]), `${label} segment order and colors`).toEqual(expectedSegments.map((s) => s.component));
    lane.forEach((b, j) => expect(b.w / lengths[i], `${label} ${expectedSegments[j].component}`).toBeCloseTo(expectedSegments[j].share, 9));
    lane.slice(1).forEach((b, j) => expect(b.x).toBeCloseTo(lane[j].x + lane[j].w, 9));
  });
  const longest = lengths.indexOf(Math.max(...lengths));
  expect(facts[longest].medianTotal).toBe(largest);
  expect(lengths[longest]).toBeCloseTo(BAR_W, 6);
  // Two groups with different medians have bars of different lengths, in the same order as their medians.
  const byMedian = [0, 1, 2, 3].sort((a, b) => facts[a].medianTotal - facts[b].medianTotal);
  byMedian.slice(1).forEach((g, k) => expect(lengths[g]).toBeGreaterThan(lengths[byMedian[k]]));
}

/** Each lane prints its median right after its own bar (the bar's end plus the grid's 8 px clearance), not in a fixed column at the right edge. */
function expectValuesAtTheBarEnds(layout) {
  const GAP = 8; // the grid's clearance between a bar and its value label, typed out so that a change in the renderer fails this file
  const lanes = lanesOf(layout);
  const labels = layout.items.filter((i) => i.role === 'gridCompTotal');
  expect(labels).toHaveLength(4);
  lanes.forEach((lane, i) => {
    const barEnd = Math.max(...lane.map((b) => b.x + b.w));
    expect(labels[i].x, `${COLUMN_GROUPS[i].join('/')} value label`).toBeCloseTo(barEnd + GAP, 6);
  });
  // The label of the longest bar sits where the fixed column used to be: the end of a full-width bar.
  expect(Math.max(...labels.map((l, i) => l.x - (i < 2 ? 28 : SECOND_COLUMN_X)))).toBeCloseTo(92 + BAR_W + GAP, 6);
}

/** The card ends as far below the last legend line as the figure's side padding (28 px, plus the glyph descent of the legend text), within 2 px. */
function expectPaddingBelowTheLegend(layout) {
  const legend = layout.items.filter((i) => i.role === 'gridLegendLine');
  const last = legend.reduce((a, b) => (b.y > a.y ? b : a));
  expect(Math.abs(layout.height - last.y - (28 + last.fontSize * 0.25))).toBeLessThanOrEqual(2);
}

/** The legend still prints each component's pooled share with and without kmp-test ("cache write 62% vs 44%"), not the dollars of a segment. */
function expectLegendToPrintTheShares(layout, costEstimate) {
  const pct = (v) => (v > 0 && v < 0.005 ? '<1%' : `${Math.round(v * 100)}%`);
  const tokens = layout.items.filter((i) => i.role === 'gridLegendLine' && / vs /.test(i.text));
  AGENTS.forEach((runtimeId, column) => {
    const withShare = groupFacts(costEstimate, runtimeId, 'product').share;
    const withoutShare = groupFacts(costEstimate, runtimeId, 'free').share;
    const expected = COMPONENTS.filter((k) => withShare[k] > 0 || withoutShare[k] > 0)
      .map((k) => `${COMPONENT_LABEL[k]} ${withShare[k] > 0 ? pct(withShare[k]) : 'n/a'} vs ${withoutShare[k] > 0 ? pct(withoutShare[k]) : 'n/a'}`);
    const shown = tokens.filter((t) => (column === 0 ? t.x < SECOND_COLUMN_X : t.x >= SECOND_COLUMN_X)).sort((a, b) => a.y - b.y || a.x - b.x).map((t) => t.text);
    expect(shown, runtimeId).toEqual(expected);
    for (const text of shown) expect(text).not.toMatch(/\$|\d\.\d{3}/);
  });
}

describe('the committed Evidence2 cost breakdown', () => {
  let summary, costEstimate;
  beforeAll(() => {
    summary = loadSummary(join(RUNS_DIR, 'campaign-summary.json'));
    costEstimate = loadCostEstimate(join(RUNS_DIR, 'cost-estimate.json'));
  });

  describe('freshness (check mode)', () => {
    it('cost-breakdown.svg equals the generator output, byte for byte (CRLF-normalized)', () => {
      const committed = crlfNormalize(readFileSync(join(RUNS_DIR, 'cost-breakdown.svg'), 'utf8'));
      expect(crlfNormalize(renderCostBreakdownSvg(summary, costEstimate))).toBe(committed);
    });

    it('each generated block of docs/agentic-benchmark.md equals the generator output (CRLF-normalized)', () => {
      const doc = crlfNormalize(readFileSync(DOC_PATH, 'utf8'));
      const blocks = docBlocks(2, summary, costEstimate);
      expect(Object.keys(blocks)).toEqual(['e2-cost-components', 'e2-sessions']);
      for (const [id, content] of Object.entries(blocks)) {
        expect(readDocBlock(doc, id), `block ${id}`).toBe(`\n${content}\n`);
      }
    });

    it('filling the committed doc with the generated blocks changes nothing', () => {
      const doc = crlfNormalize(readFileSync(DOC_PATH, 'utf8'));
      expect(fillDocBlocks(doc, docBlocks(2, summary, costEstimate))).toBe(doc);
    });
  });

  describe('cost components', () => {
    it('for all 16 sessions the four components sum to the published per-session midpoint within 1e-9', () => {
      expect(summary.cells.length).toBe(16);
      for (const cell of summary.cells) {
        const entry = costEstimateCellEntry(costEstimate, cell.runtime_id, cell.arm, cell.round_index);
        expect(entry, `${cell.cell_key} has a cost-estimate cell`).not.toBeNull();
        const published = costEstimateCellMidpoint(costEstimate, cell.runtime_id, entry);
        const components = sessionCostComponents(costEstimate.runtimes[cell.runtime_id], entry.tokens);
        expect(Math.abs(rawTotal(components) - published), cell.cell_key).toBeLessThan(1e-9);
      }
    });

    it('each group\'s per-session totals are the per-session values costMetric publishes, in the same order', () => {
      for (const group of costGroups(costEstimate)) {
        const summaryGroup = summary.by_runtime_arm.find((g) => g.runtime_id === group.runtimeId && g.arm === group.arm);
        const published = costMetric(summary, summaryGroup, group.runtimeId, group.arm, costEstimate);
        expect(published.provider).toBe(false); // Evidence2 cost is the list-price estimate for every session
        expect(group.sessions.map((s) => s.total).length).toBe(published.values.length);
        group.sessions.forEach((s, i) => expect(Math.abs(s.total - published.values[i])).toBeLessThan(1e-9));
        expect(Math.abs(group.medianTotal - published.median)).toBeLessThan(1e-9);
      }
    });

    it('the pooled shares of each of the four groups sum to 1 within 1e-9', () => {
      const groups = costGroups(costEstimate);
      expect(groups.length).toBe(4);
      for (const group of groups) {
        expect(Math.abs(sum(COMPONENTS.map((k) => group.pooledShare[k])) - 1), `${group.runtimeId}/${group.arm}`).toBeLessThan(1e-9);
      }
    });

    it('rejects a schema 1 cost estimate rather than guessing its prices', () => {
      expect(() => costGroups({ schema: 1 })).toThrow(/schema 2/);
    });
  });

  describe('cost-breakdown.svg', () => {
    let svg, layout;
    beforeAll(() => {
      svg = readFileSync(join(RUNS_DIR, 'cost-breakdown.svg'), 'utf8');
      layout = computeCostBreakdownLayout(summary, costEstimate);
    });

    it('uses only svg, title, desc, rect and text elements, with no line, circle, path or other decoration', () => {
      const tags = new Set([...svg.matchAll(/<([a-zA-Z][\w:-]*)/g)].map((m) => m[1]));
      expect([...tags].sort()).toEqual(['desc', 'rect', 'svg', 'text', 'title']);
      expect(svg).not.toMatch(/<(line|circle|path|polyline|polygon|ellipse|style|script|foreignObject|image|use|filter)\b/);
      expect(svg).not.toContain('<!--');
    });

    it('is an accessible image: role="img", a title, a desc, and the metrics grid\'s own root font-family', () => {
      expect(svg).toMatch(/^<svg [^>]*role="img"/);
      expect(svg).toContain("<title>Where a session's API cost goes</title>");
      expect(svg).toMatch(/<desc>[^<]+<\/desc>/);
      const grid = readFileSync(join(RUNS_DIR, 'metrics-grid.svg'), 'utf8');
      const fontOf = (s) => s.match(/^<svg [^>]*font-family="([^"]*)"/)[1];
      expect(fontOf(svg)).toBe(fontOf(grid));
    });

    it('has the metrics grid\'s frame: width 880, the card, two columns', () => {
      const grid = readFileSync(join(RUNS_DIR, 'metrics-grid.svg'), 'utf8');
      expect(svg).toMatch(/^<svg viewBox="0 0 880 \d+" width="880" height="\d+"/);
      const card = (s) => s.match(/<rect x="1" y="1"[^>]*rx="12"[^>]*\/>/)[0].replace(/ width="\d+" height="\d+"/, '');
      expect(card(svg)).toBe(card(grid));
      const columnXs = [...new Set(layout.items.filter((i) => i.role === 'gridLaneLabel').map((i) => i.x))].sort((a, b) => a - b);
      expect(columnXs).toEqual([28, 28 + 396 + 32]);
    });

    it('says what it shows: the title, and a subtitle that says the bar length is the median session cost on one scale, the colors are the shares of it, and names both arm colors', () => {
      const texts = layout.items.filter((i) => i.kind === 'text');
      expect(texts.find((i) => i.role === 'gridTitle').text).toBe('Where a session\'s API cost goes');
      const subtitle = texts.filter((i) => i.role === 'gridSubtitle').map((i) => i.text).join(' ');
      expect(subtitle).toBe(COST_FIGURE_SUBTITLE);
    });

    it('labels the columns with each agent and its model, Claude Code first', () => {
      const headers = layout.items.filter((i) => i.role === 'gridRowHeader').map((i) => i.text);
      expect(headers).toEqual(['Claude Code · claude-sonnet-5', 'Codex CLI · gpt-5.6-terra']);
    });

    it('has two lanes per column, "with kmp-test" (#0969da) first and "without" (#bc4c00) second', () => {
      const lanes = layout.items.filter((i) => i.role === 'gridLaneLabel');
      expect(lanes.map((i) => [i.text, i.fill])).toEqual([
        ['with kmp-test', COLOR_WITH], ['without', COLOR_WITHOUT],
        ['with kmp-test', COLOR_WITH], ['without', COLOR_WITHOUT],
      ]);
      const [a, b] = lanes.slice(0, 2);
      expect(b.y).toBeGreaterThan(a.y);
    });

    it('draws each bar as long as its group\'s median session cost on one scale (the largest median fills the lane), split into segments proportional to the pooled shares in the order cache write, cache read, output, uncached input', () => {
      expectBarsAtTheMedianCost(layout, costEstimate);
    });

    it('still prints the pooled shares in the legend, not the dollars a segment stands for', () => {
      expectLegendToPrintTheShares(layout, costEstimate);
    });

    it('prints each median right after its own bar, not in a fixed column at the right edge', () => {
      expectValuesAtTheBarEnds(layout);
    });

    it('leaves the card as much room under the legend as at its sides', () => {
      expectPaddingBelowTheLegend(layout);
    });

    it('prints the median session cost, to 3 decimals, at the end of each bar', () => {
      const totals = layout.items.filter((i) => i.role === 'gridCompTotal').map((i) => i.text);
      const expected = ['claude-code', 'codex-cli'].flatMap((runtimeId) => ['product', 'free'].map((arm) => {
        const entry = costEstimate.runtimes[runtimeId];
        const values = entry.cells.filter((c) => c.arm === arm).map((c) => rawTotal(rawComponents(entry, c.tokens)));
        return `$${median(values).toFixed(3)}`;
      }));
      // Layout order is column by column: Claude's two lanes, then Codex's two.
      expect(totals).toEqual(expected);
    });

    it('fills every segment with a palette color that has a legend swatch, and leaves out a component that is zero for the group', () => {
      const bars = layout.items.filter((i) => i.kind === 'bar');
      const swatches = layout.items.filter((i) => i.kind === 'legendSwatch').map((i) => i.fill);
      const palette = new Set(Object.values(COMPONENT_COLORS));
      for (const bar of bars) {
        expect(palette.has(bar.fill), `fill ${bar.fill}`).toBe(true);
        expect(swatches).toContain(bar.fill);
      }
      // Codex has no cache-write tokens: no green segment in its column, and no green swatch either.
      const codexBars = bars.filter((b) => b.x >= SECOND_COLUMN_X);
      expect(codexBars.length).toBeGreaterThan(0);
      expect(codexBars.some((b) => b.fill === COMPONENT_COLORS.cache_write)).toBe(false);
      const claudeSwatches = layout.items.filter((i) => i.kind === 'legendSwatch' && i.x < SECOND_COLUMN_X).map((i) => i.fill);
      expect(claudeSwatches.sort()).toEqual(Object.values(COMPONENT_COLORS).sort());
      const codexSwatches = layout.items.filter((i) => i.kind === 'legendSwatch' && i.x >= SECOND_COLUMN_X).map((i) => i.fill);
      expect(codexSwatches).not.toContain(COMPONENT_COLORS.cache_write);
      expect(codexSwatches.sort()).toEqual([COMPONENT_COLORS.cache_read, COMPONENT_COLORS.output, COMPONENT_COLORS.uncached_input].sort());
    });

    it('names both arm colors and every component color in its desc', () => {
      const desc = svg.match(/<desc>([^<]+)<\/desc>/)[1];
      for (const color of [COLOR_WITH, COLOR_WITHOUT, ...Object.values(COMPONENT_COLORS)]) expect(desc).toContain(color);
    });

    it('has no overlapping text and keeps everything inside the viewBox', () => {
      const textBox = (i) => {
        const width = i.text.length * i.fontSize * 0.6;
        const x0 = i.anchor === 'end' ? i.x - width : i.anchor === 'middle' ? i.x - width / 2 : i.x;
        return { x0, x1: x0 + width, y0: i.y - i.fontSize * 0.8, y1: i.y + i.fontSize * 0.25, label: i.text };
      };
      const markBox = (i) => ({ x0: i.x, x1: i.x + i.w, y0: i.y, y1: i.y + i.h });
      const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
      const texts = layout.items.filter((i) => i.kind === 'text').map(textBox);
      const marks = layout.items.filter((i) => i.kind === 'bar' || i.kind === 'legendSwatch').map(markBox);
      for (let i = 0; i < texts.length; i++) {
        for (let j = i + 1; j < texts.length; j++) expect(overlap(texts[i], texts[j]), `"${texts[i].label}" overlaps "${texts[j].label}"`).toBe(false);
        for (const m of marks) expect(overlap(texts[i], m), `"${texts[i].label}" overlaps a mark`).toBe(false);
      }
      for (const box of [...texts, ...marks]) {
        expect(box.x0).toBeGreaterThanOrEqual(-0.5);
        expect(box.x1).toBeLessThanOrEqual(layout.width + 0.5);
        expect(box.y0).toBeGreaterThanOrEqual(0);
        expect(box.y1).toBeLessThanOrEqual(layout.height);
      }
      // Each column's legend stays inside its own column.
      for (const i of layout.items.filter((it) => it.role === 'gridLegendLine' || it.kind === 'legendSwatch')) {
        const right = i.kind === 'legendSwatch' ? i.x + i.w : textBox(i).x1;
        const columnRight = i.x < SECOND_COLUMN_X ? 28 + 396 : SECOND_COLUMN_X + 396;
        expect(right).toBeLessThanOrEqual(columnRight + 1);
      }
    });
  });

  describe('generated tables', () => {
    let doc;
    beforeAll(() => { doc = crlfNormalize(readFileSync(DOC_PATH, 'utf8')); });

    it('the component table\'s Claude Code with-kmp-test row is recomputed independently from the price table and the tokens', () => {
      const entry = costEstimate.runtimes['claude-code'];
      const sessions = entry.cells.filter((c) => c.arm === 'product').map((c) => rawComponents(entry, c.tokens));
      const f = (v) => v.toFixed(3);
      const expectedRow = `| Claude Code with kmp-test | ${COMPONENTS.map((k) => f(median(sessions.map((s) => s[k])))).join(' | ')} | ${f(median(sessions.map(rawTotal)))} | 4 |`;
      expect(readDocBlock(doc, 'e2-cost-components')).toContain(`\n${expectedRow}\n`);
      expect(expectedRow).toBe('| Claude Code with kmp-test | 0.073 | 0.023 | 0.018 | 0.000 | 0.112 | 4 |');
    });

    it('the component table shows — for the cache write of both Codex CLI rows, and keeps the medians-need-not-add-up note', () => {
      const block = readDocBlock(doc, 'e2-cost-components');
      const codexRows = block.split('\n').filter((l) => l.startsWith('| Codex CLI'));
      expect(codexRows.length).toBe(2);
      for (const row of codexRows) expect(row.split('|')[2].trim()).toBe('—');
      expect(block).toContain('Median cost per session by component (USD, estimated at list prices)');
      expect(block).toContain('Component medians are taken separately, so they need not add up to the median total.');
    });

    it('the sessions table has one row per session, 16 in all, ordered by agent and then round', () => {
      const rows = readDocBlock(doc, 'e2-sessions').split('\n').filter((l) => /^\| (Claude Code|Codex CLI) \|/.test(l));
      expect(rows.length).toBe(16);
      const keys = rows.map((r) => { const c = r.split('|').map((x) => x.trim()); return [c[1], Number(c[3])]; });
      expect(keys.slice(0, 8).every(([agent]) => agent === 'Claude Code')).toBe(true);
      expect(keys.slice(8).every(([agent]) => agent === 'Codex CLI')).toBe(true);
      for (const half of [keys.slice(0, 8), keys.slice(8)]) expect(half.map(([, round]) => round)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('a session row (Claude Code, round 3) is recomputed independently from the summary and the cost estimate', () => {
      const cell = summary.cells.find((c) => c.runtime_id === 'claude-code' && c.round_index === 3);
      const entry = costEstimate.runtimes['claude-code'].cells.find((c) => c.arm === cell.arm && c.order_index === 3);
      const cost = rawTotal(rawComponents(costEstimate.runtimes['claude-code'], entry.tokens));
      const t = cell.tokens;
      const n = (v) => v.toLocaleString('en-US');
      const kinds = cell.command_kind_counts;
      const expectedRow = [
        'Claude Code', cell.arm === 'product' ? 'with kmp-test' : 'without', '3',
        cell.key_facts_match ? 'yes' : 'no', cell.full_answer_match ? 'yes' : 'no',
        (cell.duration_ms / 60000).toFixed(1), n(cell.tool_calls_total), `${kinds.kmp_test}/${kinds.gradle}/${kinds.other}`, n(cell.num_turns),
        n(t.input), n(t.cached_input), n(t.cache_write), n(t.output), '—',
        (cell.output_bytes / 1000).toFixed(1), cost.toFixed(3),
      ];
      expect(readDocBlock(doc, 'e2-sessions')).toContain(`\n| ${expectedRow.join(' | ')} |\n`);
    });

    it('the sessions table shows — for the tool output of every Codex CLI row (erratum E6) and a number for every Claude Code row', () => {
      const rows = readDocBlock(doc, 'e2-sessions').split('\n').filter((l) => /^\| (Claude Code|Codex CLI) \|/.test(l));
      // The last two columns are Tool output (KB) and Est. cost (USD).
      for (const row of rows) {
        const cells = row.split('|').map((x) => x.trim());
        const toolOutput = cells[cells.length - 3];
        if (row.startsWith('| Codex CLI')) expect(toolOutput).toBe('—');
        else expect(toolOutput).toMatch(/^\d+\.\d$/);
      }
    });

    it('labels the token columns with the shared token component labels, in one column per disjoint type', () => {
      const header = readDocBlock(doc, 'e2-sessions').split('\n').find((l) => l.startsWith('| Agent |'));
      const union = [];
      for (const types of Object.values(TOKEN_COMPONENT_TYPES)) for (const t of types) if (!union.includes(t)) union.push(t);
      expect(header).toContain(`| ${union.map((t) => ({ uncached_input: 'uncached input', cache_read: 'cache read', cache_write: 'cache write', output: 'output', reasoning: 'reasoning' }[t])).join(' | ')} |`);
    });

    it('rejects a doc that lacks a block\'s markers instead of appending or guessing', () => {
      const blocks = docBlocks(2, summary, costEstimate);
      expect(() => fillDocBlocks('# empty\n', blocks)).toThrow(/e2-cost-components block markers/);
      const { start } = docBlockMarkers('e2-cost-components');
      expect(() => fillDocBlocks(`${start}\nno end marker\n`, { 'e2-cost-components': 'x' })).toThrow(/block markers/);
    });

    it('builds the same blocks twice (deterministic)', () => {
      expect(buildCostComponentsBlock(costEstimate)).toBe(buildCostComponentsBlock(costEstimate));
      expect(buildSessionsBlock(summary, costEstimate)).toBe(buildSessionsBlock(summary, costEstimate));
    });
  });
});

// Any sample size: a rejected session (OAuth 401, a usage limit) is never replaced, so one group counts
// fewer sessions than it declared. Evidence2's committed data with its last Claude Code "without" session
// turned into such a cell: the summary row is missing (no metrics), the group counted 3 of 4, and the
// cost estimate has no cell for it.
describe('a campaign with one rejected session', () => {
  let summary, costEstimate, rejected;
  beforeAll(() => {
    summary = structuredClone(loadSummary(join(RUNS_DIR, 'campaign-summary.json')));
    costEstimate = structuredClone(loadCostEstimate(join(RUNS_DIR, 'cost-estimate.json')));
    rejected = summary.cells.filter((c) => c.runtime_id === 'claude-code' && c.arm === 'free').at(-1);
    Object.assign(rejected, {
      status: 'missing', reason: 'rejected_not_reclassifiable', key_facts_match: null, full_answer_match: null, success: null,
      duration_ms: null, tool_calls_total: null, tokens: null, num_turns: null, total_cost_usd: null, output_bytes: null, command_kind_counts: null,
    });
    const group = summary.by_runtime_arm.find((g) => g.runtime_id === 'claude-code' && g.arm === 'free');
    Object.assign(group, { accepted: 3, missing: 1, counted: 3 });
    const entry = costEstimate.runtimes['claude-code'];
    entry.cells = entry.cells.filter((c) => !(c.arm === 'free' && c.order_index === rejected.round_index));
  });

  const sessionRows = (block) => block.split('\n').filter((l) => /^\| (Claude Code|Codex CLI) \|/.test(l));

  it('the pair validates: the group counted 3 of its 4, and its arm has 3 cost cells', () => {
    expect(validateSummary(summary)).toEqual([]);
    expect(validateCostEstimate(costEstimate)).toEqual([]);
    expect(validatePairing(summary, costEstimate)).toEqual([]);
  });

  it('the sessions table has one row per counted session: 15, and none for the rejected one', () => {
    const rows = sessionRows(buildSessionsBlock(summary, costEstimate));
    expect(rows).toHaveLength(15);
    const claudeRounds = rows.filter((r) => r.startsWith('| Claude Code |')).map((r) => Number(r.split('|')[3].trim()));
    expect(claudeRounds).not.toContain(rejected.round_index);
    expect(claudeRounds).toHaveLength(7);
  });

  it('every row of the sessions table ends in a real cost: none is built from the rejected session\'s empty metrics', () => {
    for (const row of sessionRows(buildSessionsBlock(summary, costEstimate))) {
      const cost = row.split('|').slice(-2, -1)[0].trim();
      expect(cost, row).toMatch(/^\d+\.\d{3}$/);
    }
  });

  it('the cost table counts the sessions of each group: 3 for Claude Code without kmp-test, 4 for the others', () => {
    const rows = buildCostComponentsBlock(costEstimate).split('\n').filter((l) => /^\| (Claude Code|Codex CLI) /.test(l));
    const sessionsOf = (label) => Number(rows.find((r) => r.startsWith(`| ${label} |`)).split('|').slice(-2, -1)[0].trim());
    expect(sessionsOf('Claude Code without')).toBe(3);
    expect(sessionsOf('Claude Code with kmp-test')).toBe(4);
    expect(sessionsOf('Codex CLI with kmp-test')).toBe(4);
    expect(sessionsOf('Codex CLI without')).toBe(4);
  });

  it('the cost breakdown figure renders for the short group', () => {
    expect(renderCostBreakdownSvg(summary, costEstimate)).toContain('<svg');
  });
});

describe('the README note and link to the detailed document', () => {
  let summary, costEstimate;
  beforeAll(() => {
    summary = loadSummary(join(RUNS_DIR, 'campaign-summary.json'));
    costEstimate = loadCostEstimate(join(RUNS_DIR, 'cost-estimate.json'));
  });

  it('README_NOTES has an entry for Evidence2 and Evidence3 only', () => {
    expect(Object.keys(README_NOTES)).toEqual(['2', '3']);
  });

  it('the Evidence2 block contains the note once, and exactly one link that leaves the evidence folder: docs/agentic-benchmark.md', () => {
    const block = renderReadmeBlock(summary, '2026-09-30', costEstimate, RUNS_DIR_NAME, 'results', README_NOTES[2]);
    expect(block.split(README_NOTES[2]).length - 1).toBe(1);
    const paths = [...block.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    expect(paths.filter((p) => !p.startsWith(`tools/runs/${RUNS_DIR_NAME}`))).toEqual(['docs/agentic-benchmark.md']);
  });

  it('puts the note between the bullets and the Scope paragraph', () => {
    const block = renderReadmeBlock(summary, '2026-09-30', costEstimate, RUNS_DIR_NAME, 'results', README_NOTES[2]);
    const lastBullet = block.lastIndexOf('\n- ');
    const note = block.indexOf(README_NOTES[2]);
    const scope = block.indexOf('**Scope:**');
    expect(lastBullet).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(lastBullet);
    expect(scope).toBeGreaterThan(note);
    expect(block.slice(note + README_NOTES[2].length, scope)).toBe('\n\n');
  });

  it('an evidence without a note gets none: the block is unchanged when no note is passed', () => {
    const block = renderReadmeBlock(summary, '2026-09-30', costEstimate, RUNS_DIR_NAME, 'results');
    expect(block).not.toContain('Why the difference is modest here');
    expect(block).not.toContain('agentic-benchmark.md');
    expect(README_NOTES[4]).toBeUndefined();
  });

  // The root README block is the overview now (WO-16): it shows every scenario's figure and bullet, no per-evidence note, so neither
  // note is in it; the notes stay available to the per-evidence renderer.
  it('the committed root README carries neither the Evidence3 note nor Evidence2\'s any more: the overview block replaced them', () => {
    const readme = crlfNormalize(readFileSync(join(REPO_ROOT, 'README.md'), 'utf8'));
    const dir3 = join(REPO_ROOT, 'tools', 'runs', 'evidence3-agentic-benchmark-2026-10-02');
    const summary3 = loadSummary(join(dir3, 'campaign-summary.json'));
    const costEstimate3 = loadCostEstimate(join(dir3, 'cost-estimate.json'));
    const note3 = README_NOTES[3]({ summary: summary3, costEstimate: costEstimate3, scenarioFacts: loadScenarioFacts(summary3.scenario_id) });
    expect(readme.split(note3).length - 1).toBe(0);
    expect(readme.split(README_NOTES[2]).length - 1).toBe(0);
  });
});

// The fixed prose of docs/agentic-benchmark.md makes four statements that the committed data must
// back. They are computed here from cost-estimate.json and campaign-summary.json, independently of
// the generator, so a change to either file that breaks the page fails this file.
describe('the fixed prose of docs/agentic-benchmark.md is backed by the committed data', () => {
  let summary, costEstimate, groups;
  beforeAll(() => {
    summary = loadSummary(join(RUNS_DIR, 'campaign-summary.json'));
    costEstimate = loadCostEstimate(join(RUNS_DIR, 'cost-estimate.json'));
    groups = {};
    for (const runtimeId of ['claude-code', 'codex-cli']) {
      for (const arm of ['product', 'free']) {
        const entry = costEstimate.runtimes[runtimeId];
        const sessions = entry.cells.filter((c) => c.arm === arm).map((c) => rawComponents(entry, c.tokens));
        groups[`${runtimeId}/${arm}`] = {
          median: Object.fromEntries(COMPONENTS.map((k) => [k, median(sessions.map((s) => s[k]))])),
          medianTotal: median(sessions.map(rawTotal)),
        };
      }
    }
  });

  it('(a) for each agent, the extra cache reads and output account for at least half of the difference in median total', () => {
    for (const runtimeId of ['claude-code', 'codex-cli']) {
      const w = groups[`${runtimeId}/product`], wo = groups[`${runtimeId}/free`];
      const share = ((wo.median.cache_read - w.median.cache_read) + (wo.median.output - w.median.output)) / (wo.medianTotal - w.medianTotal);
      expect(share, runtimeId).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('(b) for Claude Code, the cache write changes less between the arms, relatively, than the cache read', () => {
    const w = groups['claude-code/product'], wo = groups['claude-code/free'];
    const writeChange = Math.abs(wo.median.cache_write - w.median.cache_write) / w.median.cache_write;
    const readChange = Math.abs(wo.median.cache_read - w.median.cache_read) / w.median.cache_read;
    expect(writeChange).toBeLessThan(readChange);
  });

  it('(c) in every group, cache reads and writes are more than half of all tokens, pooled over its sessions', () => {
    for (const runtimeId of ['claude-code', 'codex-cli']) {
      for (const arm of ['product', 'free']) {
        const cells = summary.cells.filter((c) => c.runtime_id === runtimeId && c.arm === arm && c.status !== 'missing');
        const pooled = {};
        for (const cell of cells) for (const [k, v] of Object.entries(disjointTokens(cell.tokens, runtimeId))) pooled[k] = (pooled[k] || 0) + v;
        const cached = (pooled.cache_read || 0) + (pooled.cache_write || 0);
        expect(cached / sum(Object.values(pooled)), `${runtimeId}/${arm}`).toBeGreaterThan(0.5);
      }
    }
  });

  it('(d) for Claude Code, the median tool output differs between the arms by kilobytes, not megabytes', () => {
    const bytes = (arm) => median(summary.cells.filter((c) => c.runtime_id === 'claude-code' && c.arm === arm).map((c) => c.output_bytes));
    const difference = bytes('free') - bytes('product');
    expect(difference).toBeGreaterThanOrEqual(1000);
    expect(difference).toBeLessThan(1000000);
  });

  it('a cache read is priced at a tenth of the plain input rate, for both agents', () => {
    for (const runtimeId of ['claude-code', 'codex-cli']) {
      const p = costEstimate.runtimes[runtimeId].per_million_tokens;
      expect(p.cache_read / p.input).toBeCloseTo(0.1, 9);
    }
  });

  it('the cited token-cost figures are in docs/token-cost-measurement.md: NowInAndroid, 36 modules, 226,291 vs 1,839', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'token-cost-measurement.md'), 'utf8');
    expect(doc).toMatch(/NowInAndroid, 36 modules \| 226,291 \| 1,839 \|/);
    const page = readFileSync(DOC_PATH, 'utf8').replace(/\s+/g, ' ');
    expect(page).toContain('NowInAndroid (36 modules as counted there) produced 226,291 tokens of raw Gradle output against 1,839 through');
  });
});

// ---------------------------------------------------------------------------
// Evidence3: the same generator on a campaign with 7 or 8 counted sessions per group and two sessions that are missing data, plus the
// section's generated task and session paragraphs and the table that shows both campaigns. Everything below is computed here from the
// committed summaries, cost estimates and corpus files, independently of the generator.

const E3_DATE = '2026-10-02';
const E3_DIR_NAME = `evidence3-agentic-benchmark-${E3_DATE}`;
const E3_DIR = join(REPO_ROOT, 'tools', 'runs', E3_DIR_NAME);
const E4_DIR_NAME = 'evidence4-agentic-benchmark-2026-10-07';
const E4_DIR = join(REPO_ROOT, 'tools', 'runs', E4_DIR_NAME);
const E5_DIR_NAME = 'evidence5-agentic-benchmark-2026-10-08';
const E5_DIR = join(REPO_ROOT, 'tools', 'runs', E5_DIR_NAME);
const E6_DIR_NAME = 'evidence6-agentic-benchmark-2026-10-08';
const E6_DIR = join(REPO_ROOT, 'tools', 'runs', E6_DIR_NAME);
const CORPUS_DIR = join(REPO_ROOT, 'tools', 'agentic-eval', 'corpus');
const BENCHMARK_DOC_SCRIPT = join(REPO_ROOT, 'tools', 'agentic-eval', 'benchmark-doc.mjs');
const AGENTS = ['claude-code', 'codex-cli'];
const ARMS = ['product', 'free'];
const AGENT_NAME = { 'claude-code': 'Claude Code', 'codex-cli': 'Codex CLI' };
const ARM_NAME = { product: 'with kmp-test', free: 'without' };
// The scenario's ground truth must not appear in anything this page or the changelog says (the same names the README block's guard uses).
const GROUND_TRUTH_NAMES = /:core:|:feature:|:lint\b|BookmarksViewModelTest|CompositeUserNewsResourceRepositoryTest|GetFollowableTopicsUseCaseTest/;

const countedCells = (summary, runtimeId, arm) => summary.cells.filter((c) => c.runtime_id === runtimeId && c.arm === arm && c.status !== 'missing');
// Every token the session used, written out per agent: Codex CLI's input already contains its cached input and its output its reasoning.
const totalTokens = (cell) => (cell.runtime_id === 'codex-cli'
  ? cell.tokens.input + cell.tokens.output
  : cell.tokens.input + cell.tokens.cached_input + cell.tokens.cache_write + cell.tokens.output);
const sessionCost = (cell, costEstimate) => {
  const entry = costEstimate.runtimes[cell.runtime_id].cells.find((c) => c.arm === cell.arm && c.order_index === cell.round_index);
  return rawTotal(rawComponents(costEstimate.runtimes[cell.runtime_id], entry.tokens));
};
const thousands = (v) => v.toLocaleString('en-US');

describe('Evidence3: the cost breakdown and the generated blocks of docs/agentic-benchmark.md', () => {
  let summary, costEstimate, e2Summary, e2CostEstimate, e4Summary, e4CostEstimate, e5Summary, e5CostEstimate, e6Summary, e6CostEstimate, context, doc;
  beforeAll(() => {
    summary = loadSummary(join(E3_DIR, 'campaign-summary.json'));
    costEstimate = loadCostEstimate(join(E3_DIR, 'cost-estimate.json'));
    e2Summary = loadSummary(join(RUNS_DIR, 'campaign-summary.json'));
    e2CostEstimate = loadCostEstimate(join(RUNS_DIR, 'cost-estimate.json'));
    e4Summary = loadSummary(join(E4_DIR, 'campaign-summary.json'));
    e4CostEstimate = loadCostEstimate(join(E4_DIR, 'cost-estimate.json'));
    e5Summary = loadSummary(join(E5_DIR, 'campaign-summary.json'));
    e5CostEstimate = loadCostEstimate(join(E5_DIR, 'cost-estimate.json'));
    e6Summary = loadSummary(join(E6_DIR, 'campaign-summary.json'));
    e6CostEstimate = loadCostEstimate(join(E6_DIR, 'cost-estimate.json'));
    context = docContext(3, E3_DATE, summary, costEstimate);
    doc = crlfNormalize(readFileSync(DOC_PATH, 'utf8'));
  });

  describe('freshness (check mode)', () => {
    it('cost-breakdown.svg equals the generator output, byte for byte (CRLF-normalized)', () => {
      const committed = crlfNormalize(readFileSync(join(E3_DIR, 'cost-breakdown.svg'), 'utf8'));
      expect(crlfNormalize(renderCostBreakdownSvg(summary, costEstimate))).toBe(committed);
    });

    it('each generated block of the Evidence3 section and the both-campaigns table equals the generator output (CRLF-normalized)', () => {
      const blocks = docBlocks(3, summary, costEstimate, context);
      expect(Object.keys(blocks).sort()).toEqual(['campaigns', 'e3-cost-components', 'e3-run', 'e3-scenario', 'e3-sessions']);
      for (const [id, content] of Object.entries(blocks)) {
        expect(readDocBlock(doc, id), `block ${id}`).toBe(`\n${content}\n`);
      }
    });

    it('filling the committed doc with the blocks of both evidences changes nothing', () => {
      const both = { ...docBlocks(2, e2Summary, e2CostEstimate), ...docBlocks(3, summary, costEstimate, context) };
      expect(fillDocBlocks(doc, both)).toBe(doc);
    });

    it('check mode ignores line endings: a CRLF copy of the figure and the document (a Windows autocrlf checkout) is not stale, a changed one is', () => {
      const dir = mkdtempSync(join(tmpdir(), 'kmp-benchmark-doc-'));
      try {
        const svgPath = join(dir, 'cost-breakdown.svg');
        const svg = renderCostBreakdownSvg(summary, costEstimate);
        const filled = fillDocBlocks(doc, docBlocks(3, summary, costEstimate, context));
        const crlf = (text) => text.replace(/\n/g, '\r\n');
        writeFileSync(svgPath, crlf(svg));
        expect(staleOutputs({ svgPath, svg, docPath: 'doc.md', doc: crlf(doc), filled })).toEqual([]);
        expect(staleOutputs({ svgPath, svg, docPath: 'doc.md', doc, filled })).toEqual([]);
        writeFileSync(svgPath, crlf(svg.replace('Where a session', 'Where the session')));
        expect(staleOutputs({ svgPath, svg, docPath: 'doc.md', doc: crlf(doc), filled })).toEqual([svgPath]);
        expect(staleOutputs({ svgPath, svg, docPath: 'doc.md', doc: crlf(doc.replace('## Across campaigns', '## Across  campaigns')), filled })).toEqual([svgPath, 'doc.md']);
        const missing = join(dir, 'missing.svg');
        expect(staleOutputs({ svgPath: missing, svg, docPath: 'doc.md', doc, filled })).toEqual([missing]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('only Evidence3 generates the section paragraphs and the both-campaigns table; Evidence2 keeps its two blocks', () => {
      expect(docContext(2, '2026-09-30', e2Summary, e2CostEstimate)).toBeNull();
      expect(Object.keys(docBlocks(2, e2Summary, e2CostEstimate))).toEqual(['e2-cost-components', 'e2-sessions']);
    });

    it('check mode exits 0 for Evidence2 and for Evidence3, and 1 for a campaign directory that does not exist', () => {
      const run = (...args) => spawnSync(process.execPath, [BENCHMARK_DOC_SCRIPT, ...args], { encoding: 'utf8' });
      const e2 = run('--evidence=2', '--date=2026-09-30');
      expect(e2.status, e2.stderr).toBe(0);
      const e3 = run('--evidence=3', `--date=${E3_DATE}`);
      expect(e3.status, e3.stderr).toBe(0);
      expect(e3.stdout).toContain('Evidence 3 cost breakdown and docs/agentic-benchmark.md blocks are up to date.');
      expect(run('--evidence=3', '--date=2026-10-03').status).toBe(1);
    });
  });

  describe('cost components', () => {
    it('for all 30 counted sessions the four components sum to the published per-session midpoint within 1e-9, and the 2 sessions missing data have no cost cell', () => {
      const counted = summary.cells.filter((c) => c.status !== 'missing');
      expect(counted).toHaveLength(30);
      for (const cell of counted) {
        const entry = costEstimateCellEntry(costEstimate, cell.runtime_id, cell.arm, cell.round_index);
        expect(entry, `${cell.cell_key} has a cost-estimate cell`).not.toBeNull();
        const published = costEstimateCellMidpoint(costEstimate, cell.runtime_id, entry);
        const components = sessionCostComponents(costEstimate.runtimes[cell.runtime_id], entry.tokens);
        expect(Math.abs(rawTotal(components) - published), cell.cell_key).toBeLessThan(1e-9);
      }
      const missing = summary.cells.filter((c) => c.status === 'missing');
      expect(missing).toHaveLength(2);
      for (const cell of missing) expect(costEstimateCellEntry(costEstimate, cell.runtime_id, cell.arm, cell.round_index), cell.cell_key).toBeNull();
    });

    it('each group has the sessions it counted: 8 and 7 for Claude Code, 8 and 7 for Codex CLI', () => {
      expect(costGroups(costEstimate).map((g) => [g.runtimeId, g.arm, g.sessions.length])).toEqual([
        ['claude-code', 'product', 8], ['claude-code', 'free', 7], ['codex-cli', 'product', 8], ['codex-cli', 'free', 7],
      ]);
    });

    it('each group\'s per-session totals are the values costMetric publishes (as a set), and the pooled shares of each group sum to 1 within 1e-9', () => {
      for (const group of costGroups(costEstimate)) {
        const summaryGroup = summary.by_runtime_arm.find((g) => g.runtime_id === group.runtimeId && g.arm === group.arm);
        const published = costMetric(summary, summaryGroup, group.runtimeId, group.arm, costEstimate);
        const mine = group.sessions.map((s) => s.total).sort((a, b) => a - b);
        const theirs = [...published.values].sort((a, b) => a - b);
        expect(mine.length, `${group.runtimeId}/${group.arm}`).toBe(theirs.length);
        mine.forEach((v, i) => expect(Math.abs(v - theirs[i])).toBeLessThan(1e-9));
        expect(Math.abs(group.medianTotal - published.median)).toBeLessThan(1e-9);
        expect(Math.abs(sum(COMPONENTS.map((k) => group.pooledShare[k])) - 1), `${group.runtimeId}/${group.arm}`).toBeLessThan(1e-9);
      }
    });
  });

  describe('cost-breakdown.svg', () => {
    let svg, layout;
    beforeAll(() => {
      svg = readFileSync(join(E3_DIR, 'cost-breakdown.svg'), 'utf8');
      layout = computeCostBreakdownLayout(summary, costEstimate);
    });

    it('uses only svg, title, desc, rect and text elements, with no line, circle, path or other decoration', () => {
      const tags = new Set([...svg.matchAll(/<([a-zA-Z][\w:-]*)/g)].map((m) => m[1]));
      expect([...tags].sort()).toEqual(['desc', 'rect', 'svg', 'text', 'title']);
      expect(svg).not.toMatch(/<(line|circle|path|polyline|polygon|ellipse|style|script|foreignObject|image|use|filter)\b/);
      expect(svg).not.toContain('<!--');
    });

    it('is an accessible image with the Evidence3 metrics grid\'s own frame and font: role="img", a title, a desc, width 880, two columns', () => {
      expect(svg).toMatch(/^<svg [^>]*role="img"/);
      expect(svg).toContain("<title>Where a session's API cost goes</title>");
      expect(svg).toMatch(/<desc>[^<]+<\/desc>/);
      const grid = readFileSync(join(E3_DIR, 'metrics-grid.svg'), 'utf8');
      const fontOf = (s) => s.match(/^<svg [^>]*font-family="([^"]*)"/)[1];
      expect(fontOf(svg)).toBe(fontOf(grid));
      expect(svg).toMatch(/^<svg viewBox="0 0 880 \d+" width="880" height="\d+"/);
      const card = (s) => s.match(/<rect x="1" y="1"[^>]*rx="12"[^>]*\/>/)[0].replace(/ width="\d+" height="\d+"/, '');
      expect(card(svg)).toBe(card(grid));
      const columnXs = [...new Set(layout.items.filter((i) => i.role === 'gridLaneLabel').map((i) => i.x))].sort((a, b) => a - b);
      expect(columnXs).toEqual([28, SECOND_COLUMN_X]);
    });

    it('labels the columns with each agent and its resolved model, Claude Code first, and has "with kmp-test" first and "without" second in each', () => {
      expect(layout.items.filter((i) => i.role === 'gridRowHeader').map((i) => i.text)).toEqual(['Claude Code · claude-sonnet-5', 'Codex CLI · gpt-5.6-terra']);
      expect(summary.provenance.model_resolved['claude-code'].values).toEqual(['claude-sonnet-5']);
      expect(summary.provenance.model_resolved['codex-cli'].values).toEqual(['gpt-5.6-terra']);
      const lanes = layout.items.filter((i) => i.role === 'gridLaneLabel');
      expect(lanes.map((i) => [i.text, i.fill])).toEqual([
        ['with kmp-test', COLOR_WITH], ['without', COLOR_WITHOUT], ['with kmp-test', COLOR_WITH], ['without', COLOR_WITHOUT],
      ]);
    });

    it('says what it shows: a subtitle that says the bar length is the median session cost on one scale and the colors are the shares of it', () => {
      const subtitle = layout.items.filter((i) => i.role === 'gridSubtitle').map((i) => i.text).join(' ');
      expect(subtitle).toBe(COST_FIGURE_SUBTITLE);
    });

    it('draws each bar as long as its group\'s median session cost on one scale (the largest median fills the lane), split into segments proportional to the pooled shares recomputed here, in the order cache write, cache read, output, uncached input', () => {
      expectBarsAtTheMedianCost(layout, costEstimate);
    });

    it('still prints the pooled shares in the legend, not the dollars a segment stands for', () => {
      expectLegendToPrintTheShares(layout, costEstimate);
    });

    it('prints each median right after its own bar, not in a fixed column at the right edge', () => {
      expectValuesAtTheBarEnds(layout);
    });

    it('leaves the card as much room under the legend as at its sides', () => {
      expectPaddingBelowTheLegend(layout);
    });

    it('prints the median session cost, to 3 decimals, at the end of each bar, and leaves out the cache write that Codex CLI has none of', () => {
      const totals = layout.items.filter((i) => i.role === 'gridCompTotal').map((i) => i.text);
      const expected = AGENTS.flatMap((runtimeId) => ARMS.map((arm) => {
        const entry = costEstimate.runtimes[runtimeId];
        return `$${median(entry.cells.filter((c) => c.arm === arm).map((c) => rawTotal(rawComponents(entry, c.tokens)))).toFixed(3)}`;
      }));
      expect(totals).toEqual(expected);
      const bars = layout.items.filter((i) => i.kind === 'bar');
      const palette = new Set(Object.values(COMPONENT_COLORS));
      for (const bar of bars) expect(palette.has(bar.fill), `fill ${bar.fill}`).toBe(true);
      expect(bars.filter((b) => b.x >= SECOND_COLUMN_X).some((b) => b.fill === COMPONENT_COLORS.cache_write)).toBe(false);
    });

    it('names both arm colors and every component color in its desc', () => {
      const desc = svg.match(/<desc>([^<]+)<\/desc>/)[1];
      for (const color of [COLOR_WITH, COLOR_WITHOUT, ...Object.values(COMPONENT_COLORS)]) expect(desc).toContain(color);
    });

    it('has no overlapping text and keeps everything inside the viewBox', () => {
      const textBox = (i) => {
        const width = i.text.length * i.fontSize * 0.6;
        const x0 = i.anchor === 'end' ? i.x - width : i.anchor === 'middle' ? i.x - width / 2 : i.x;
        return { x0, x1: x0 + width, y0: i.y - i.fontSize * 0.8, y1: i.y + i.fontSize * 0.25, label: i.text };
      };
      const markBox = (i) => ({ x0: i.x, x1: i.x + i.w, y0: i.y, y1: i.y + i.h });
      const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
      const texts = layout.items.filter((i) => i.kind === 'text').map(textBox);
      const marks = layout.items.filter((i) => i.kind === 'bar' || i.kind === 'legendSwatch').map(markBox);
      for (let i = 0; i < texts.length; i++) {
        for (let j = i + 1; j < texts.length; j++) expect(overlap(texts[i], texts[j]), `"${texts[i].label}" overlaps "${texts[j].label}"`).toBe(false);
        for (const m of marks) expect(overlap(texts[i], m), `"${texts[i].label}" overlaps a mark`).toBe(false);
      }
      for (const box of [...texts, ...marks]) {
        expect(box.x0).toBeGreaterThanOrEqual(-0.5);
        expect(box.x1).toBeLessThanOrEqual(layout.width + 0.5);
        expect(box.y0).toBeGreaterThanOrEqual(0);
        expect(box.y1).toBeLessThanOrEqual(layout.height);
      }
    });
  });

  describe('generated tables', () => {
    it('the component table\'s four rows are recomputed independently from the price table and the tokens', () => {
      const block = readDocBlock(doc, 'e3-cost-components');
      const f = (v) => v.toFixed(3);
      for (const runtimeId of AGENTS) {
        for (const arm of ARMS) {
          const entry = costEstimate.runtimes[runtimeId];
          const sessions = entry.cells.filter((c) => c.arm === arm).map((c) => rawComponents(entry, c.tokens));
          const cells = COMPONENTS.map((k) => (sessions.every((s) => s[k] === 0) ? '—' : f(median(sessions.map((s) => s[k])))));
          const expectedRow = `| ${AGENT_NAME[runtimeId]} ${ARM_NAME[arm]} | ${cells.join(' | ')} | ${f(median(sessions.map(rawTotal)))} | ${sessions.length} |`;
          expect(block, `${runtimeId}/${arm}`).toContain(`\n${expectedRow}\n`);
        }
      }
      expect(block).toContain('\n| Claude Code with kmp-test | 0.072 | 0.013 | 0.026 | 0.000 | 0.110 | 8 |\n');
      expect(block).toContain('Component medians are taken separately, so they need not add up to the median total.');
    });

    it('the sessions table has one row per counted session, 30 in all, ordered by agent and then round, and none for the 2 sessions missing data', () => {
      const rows = readDocBlock(doc, 'e3-sessions').split('\n').filter((l) => /^\| (Claude Code|Codex CLI) \|/.test(l));
      expect(rows).toHaveLength(30);
      const keys = rows.map((r) => { const c = r.split('|').map((x) => x.trim()); return [c[1], Number(c[3])]; });
      expect(keys.slice(0, 15).every(([agent]) => agent === 'Claude Code')).toBe(true);
      expect(keys.slice(15).every(([agent]) => agent === 'Codex CLI')).toBe(true);
      expect(keys.slice(0, 15).map(([, round]) => round)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15]);
      expect(keys.slice(15).map(([, round]) => round)).toEqual([0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15]);
    });

    it('names the 2 sessions that are missing data under the table, with their reason codes, and the summary says the same two', () => {
      const missing = summary.cells.filter((c) => c.status === 'missing').map((c) => `${c.runtime_id}/${c.arm}/${c.round_index}/${c.reason}`).sort();
      expect(missing).toEqual(['claude-code/free/8/rejected_not_reclassifiable', 'codex-cli/free/7/cell_directory_absent']);
      const notes = readDocBlock(doc, 'e3-sessions').split('\n').filter((l) => l.startsWith('Two sessions are not in the table'));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('Claude Code without, round 8 (`rejected_not_reclassifiable`: the harness rejected the session)');
      expect(notes[0]).toContain('Codex CLI without, round 7 (`cell_directory_absent`: no session evidence was recorded)');
      expect(notes[0]).toContain('controls audit');
    });

    it('a Claude Code row (round 3) and a Codex CLI row (round 4) are recomputed independently from the summary and the cost estimate', () => {
      const block = readDocBlock(doc, 'e3-sessions');
      const row = (runtimeId, round) => {
        const cell = summary.cells.find((c) => c.runtime_id === runtimeId && c.round_index === round);
        const t = cell.tokens;
        const kinds = cell.command_kind_counts;
        const tokenColumns = runtimeId === 'codex-cli'
          ? [thousands(t.input - t.cached_input), thousands(t.cached_input), '—', thousands(t.output - t.reasoning_output), thousands(t.reasoning_output)]
          : [thousands(t.input), thousands(t.cached_input), thousands(t.cache_write), thousands(t.output), '—'];
        return [
          AGENT_NAME[runtimeId], ARM_NAME[cell.arm], String(round), cell.key_facts_match ? 'yes' : 'no', cell.full_answer_match ? 'yes' : 'no',
          (cell.duration_ms / 60000).toFixed(1), thousands(cell.tool_calls_total), `${kinds.kmp_test}/${kinds.gradle}/${kinds.other}`, thousands(cell.num_turns),
          ...tokenColumns, (cell.output_bytes / 1000).toFixed(1), sessionCost(cell, costEstimate).toFixed(3),
        ];
      };
      expect(block).toContain(`\n| ${row('claude-code', 3).join(' | ')} |\n`);
      expect(block).toContain(`\n| ${row('codex-cli', 4).join(' | ')} |\n`);
      expect(row('codex-cli', 4)[1]).toBe('without');
    });

    it('shows a number for the tool output of every session of both agents: Codex CLI\'s is measured here (command output as logged)', () => {
      const rows = readDocBlock(doc, 'e3-sessions').split('\n').filter((l) => /^\| (Claude Code|Codex CLI) \|/.test(l));
      for (const row of rows) {
        const cells = row.split('|').map((x) => x.trim());
        expect(cells[cells.length - 3], row).toMatch(/^\d+\.\d$/);
      }
      expect(summary.cells.filter((c) => c.runtime_id === 'codex-cli' && c.status !== 'missing').every((c) => c.output_bytes_kind === 'command_output')).toBe(true);
    });

    it('the note on missing sessions: none when every session is counted, singular for one, and a reason code with no gloss is shown as it is', () => {
      expect(missingSessionsNote(e2Summary)).toBeNull();
      expect(buildSessionsBlock(e2Summary, e2CostEstimate)).not.toContain('missing data');
      const one = { cells: [{ status: 'missing', runtime_id: 'codex-cli', arm: 'product', round_index: 2, reason: 'analysis_failed:x' }] };
      expect(missingSessionsNote(one)).toBe('One session is not in the table because it is missing data: Codex CLI with kmp-test, round 2 (`analysis_failed:x`). The record\'s controls audit has the details.');
    });
  });

  describe('the section\'s task and session paragraphs', () => {
    it('the scenario paragraph states the module and failing-method counts that the scenario\'s corpus files give', () => {
      const scenario = JSON.parse(readFileSync(join(CORPUS_DIR, 'scenarios', `${summary.scenario_id}.json`), 'utf8'));
      const expected = JSON.parse(readFileSync(join(CORPUS_DIR, 'expected', `${summary.scenario_id}.json`), 'utf8'));
      const modules = new Set(scenario.policy.allowed_gradle_tasks.filter((t) => t.endsWith(':tasks')).map((t) => t.slice(0, -':tasks'.length)));
      expect([modules.size, expected.expected.failed_count]).toEqual([11, 6]);
      const block = readDocBlock(doc, 'e3-scenario');
      expect(block).toContain(`${modules.size} modules are in scope, with ${expected.expected.failed_count} failing test methods.`);
      expect(block).toContain('**Scenario:** in NowInAndroid, a small production-code change breaks tests in several modules. The agent runs the unit tests of every module except those whose Robolectric tests need network access, then reports which modules and test classes fail and how many tests.');
      expect(buildScenarioBlock({ moduleCount: 3, failedCount: 2 })).toContain('3 modules are in scope, with 2 failing test methods.');
    });

    it('the sessions paragraph states what the summary says: 32 run, 30 counted, the count phrase, both models, and the link to the record', () => {
      expect(sum(summary.by_runtime_arm.map((g) => g.declared))).toBe(32);
      expect(summary.cells.filter((c) => c.status !== 'missing')).toHaveLength(30);
      const block = readDocBlock(doc, 'e3-run');
      expect(block).toContain('**Sessions:** 32 run, 30 counted; per agent and arm: 8 with kmp-test and 7 without for Claude Code; 8 and 7 for Codex CLI.');
      expect(block).toContain('Claude Code (claude-sonnet-5) and Codex CLI (gpt-5.6-terra), in a counterbalanced order.');
      expect(block).toContain(`Record: [Evidence3](../tools/runs/${E3_DIR_NAME}/README.md).`);
    });

    it('the second attempt and the sessions missing data are what the record says: its README, and amendments A4 and A5 of its preregistration', () => {
      const block = readDocBlock(doc, 'e3-run');
      expect(block).toContain('This is the campaign\'s second attempt; the first failed on infrastructure and is not analyzed (preregistration amendment A4). Two sessions are missing data and are not counted: one was rejected by the harness, one was lost to a failed call into the guest VM (amendment A5 treats such a loss like a rejection); none of them was re-run or replaced.');
      const readme = crlfNormalize(readFileSync(join(E3_DIR, 'README.md'), 'utf8'));
      expect(readme).toContain('This is the campaign\'s second attempt.');
      const prereg = crlfNormalize(readFileSync(join(E3_DIR, 'preregistration.md'), 'utf8'));
      expect(prereg).toMatch(/^### A4 \(.*before the second campaign attempt\)$/m);
      expect(prereg).toMatch(/^### A5 \(/m);
      expect(prereg).toContain('Under section 10 nothing from that attempt is analyzed or published');
      expect(prereg).toContain('one (claude-code, round 8) was rejected by the harness\'s integrity checks; one (codex-cli, round 7) was lost because its guest call failed');
      expect(prereg).toContain('is missing data and is treated like a rejected cell: declared, not counted, not replaced.');
      // The sentence about the two sessions is bound to the summary's own reason codes for them.
      expect(summary.cells.filter((c) => c.status === 'missing').map((c) => c.reason).sort()).toEqual(['cell_directory_absent', 'rejected_not_reclassifiable']);
    });

    it('refuses to describe the missing sessions as the record does when the summary says something else', () => {
      const other = structuredClone(summary);
      other.cells.find((c) => c.cell_key === 'codex-cli-7').reason = 'analysis_failed:x';
      expect(() => buildRunBlock({ evidenceN: 3, date: E3_DATE, summary: other })).toThrow(/history sentence describes sessions missing for cell_directory_absent and rejected_not_reclassifiable, but the summary's are analysis_failed:x, rejected_not_reclassifiable/);
    });

    it('a campaign without a history of its own gets no history sentence when every session is counted, and a plain one when some are not', () => {
      const block = buildRunBlock({ evidenceN: 2, date: '2026-09-30', summary: e2Summary });
      expect(block).not.toMatch(/attempt|missing data|amendment/);
      expect(block).toContain('**Sessions:** 16 run, 16 counted; per agent and arm: 4.');
      const lost = structuredClone(e2Summary);
      Object.assign(lost.cells.at(-1), { status: 'missing', reason: 'cell_directory_absent' });
      Object.assign(lost.by_runtime_arm.find((g) => g.runtime_id === 'codex-cli' && g.arm === 'free'), { accepted: 3, missing: 1, counted: 3 });
      expect(buildRunBlock({ evidenceN: 2, date: '2026-09-30', summary: lost })).toContain('in a counterbalanced order. One session is missing data and is not counted; it was not replaced. Record:');
    });

    it('refuses a summary whose model is not a single resolved value', () => {
      const broken = structuredClone(summary);
      broken.provenance.model_resolved['codex-cli'] = { values: ['a', 'b'], mixed: true };
      expect(() => buildRunBlock({ evidenceN: 3, date: E3_DATE, summary: broken })).toThrow(/model_resolved\.codex-cli is not a single model/);
    });
  });

  describe('the both-campaigns table', () => {
    // One expected row, computed here: a median over the group's counted sessions for every column but the last.
    const expectedRow = (evidenceN, s, c, runtimeId, arm) => {
      const cells = countedCells(s, runtimeId, arm);
      const measured = runtimeId === 'claude-code' || s.cells.filter((x) => x.runtime_id === runtimeId && x.status !== 'missing').every((x) => x.output_bytes_kind === 'command_output');
      const observedCalls = cells.map((x) => x.tool_calls_total).filter((v) => typeof v === 'number');
      const calls = median(observedCalls);
      return [
        `Evidence${evidenceN}`, AGENT_NAME[runtimeId], ARM_NAME[arm],
        Number.isInteger(calls) ? String(calls) : calls.toFixed(1),
        measured ? (median(cells.map((x) => x.output_bytes)) / 1000).toFixed(1) : '—',
        thousands(Math.round(median(cells.map(totalTokens)))),
        median(cells.map((x) => sessionCost(x, c))).toFixed(3),
        (median(cells.map((x) => x.duration_ms)) / 60000).toFixed(1),
        `${cells.filter((x) => x.key_facts_match === true).length}/${cells.length}`,
      ];
    };

    it('has one row per campaign, agent and arm, Evidence2 first, and every cell is recomputed independently from the two summaries and cost estimates', () => {
      const block = readDocBlock(doc, 'campaigns');
      const rows = block.split('\n').filter((l) => l.startsWith('| Evidence'));
      const expected = [[2, e2Summary, e2CostEstimate], [3, summary, costEstimate], [4, e4Summary, e4CostEstimate], [5, e5Summary, e5CostEstimate], [6, e6Summary, e6CostEstimate]]
        .flatMap(([n, s, c]) => AGENTS.flatMap((runtimeId) => ARMS.map((arm) => `| ${expectedRow(n, s, c, runtimeId, arm).join(' | ')} |`)));
      expect(rows).toEqual(expected);
      expect(rows).toHaveLength(20); // 5 campaigns x 2 agents x 2 arms
      // Evidence3's own groups, pinned: key facts matched 7 of 8 with kmp-test and 7 of 7 without, for both agents.
      expect(rows.slice(4, 8).map((r) => r.split('|')[9].trim())).toEqual(['7/8', '7/7', '7/8', '7/7']);
      expect(rows.slice(8, 12).map((r) => r.split('|')[9].trim())).toEqual(['7/7', '5/8', '8/8', '1/8']);
      expect(rows.slice(12, 16).map((r) => r.split('|')[9].trim())).toEqual(['4/7', '0/6', '8/8', '0/8']);
      expect(rows.slice(16, 20).map((r) => r.split('|')[9].trim())).toEqual(['8/8', '6/8', '8/8', '8/8']);
    });

    it('has the caption and header of the plan, and says what the columns mean', () => {
      const block = readDocBlock(doc, 'campaigns');
      expect(block.startsWith('\nMedian per session, by campaign (each campaign compares its own arms; the tasks differ)\n')).toBe(true);
      expect(block).toContain('| Campaign | Agent | Arm | Tool calls | Tool output (KB) | Total tokens | Est. cost (USD) | Wall-clock (min) | Key facts matched |');
      expect(block).toContain('- Key facts matched: counted sessions whose final answer matched the key facts of that campaign\'s task, out of the counted sessions; the key facts differ between the five tasks.');
    });

    it('shows — for Evidence2\'s Codex CLI tool output (erratum E6), numbers for Evidence3\'s, and says what Codex CLI\'s numbers are', () => {
      const block = readDocBlock(doc, 'campaigns');
      const rows = block.split('\n').filter((l) => l.startsWith('| Evidence'));
      const toolOutput = (row) => row.split('|')[5].trim();
      expect(rows.filter((r) => r.startsWith('| Evidence2 | Codex CLI')).map(toolOutput)).toEqual(['—', '—']);
      for (const row of rows.filter((r) => !r.startsWith('| Evidence2 | Codex CLI') && !r.startsWith('| Evidence4 | Codex CLI'))) expect(toolOutput(row), row).toMatch(/^\d+\.\d$/);
      expect(rows.filter((r) => r.startsWith('| Evidence4 | Codex CLI')).map(toolOutput)).toEqual(['—', '—']);
      expect(block).toContain('- Tool output is the tool results returned to the model for Claude Code and, for Codex CLI, command output as logged; Codex may shorten what the model reads.');
      expect(block).toContain('- Evidence2: tool output was not measured for Codex CLI, shown as —.');
      expect(block).not.toContain('Evidence3: tool output was not measured');
      expect(block).toContain('- Evidence4: tool output was not measured for Codex CLI, shown as —.');
    });

    // Re-pointed with the root README block (WO-16): the README bullets give each scenario's tool calls, cost and key facts, so those three
    // are what the table must agree with, row by row (the per-evidence note that used to carry the tool-output medians left the README).
    it('the root README bullets state the same tool-call medians, costs and key facts as this table, for both scenarios', () => {
      const readme = crlfNormalize(readFileSync(join(REPO_ROOT, 'README.md'), 'utf8'));
      const rows = readDocBlock(doc, 'campaigns').split('\n').filter((l) => l.startsWith('| Evidence')).map((r) => r.split('|').map((x) => x.trim()));
      expect(rows).toHaveLength(20);
      for (const [evidence, bulletStart] of [['Evidence2', '- **1 module'], ['Evidence3', '- **11 modules · find'], ['Evidence4', '- **11 modules · measure'], ['Evidence5', '- **19 selected modules'], ['Evidence6', '- **11 modules · identify']]) {
        const bullet = readme.split('\n').find((l) => l.startsWith(bulletStart));
        expect(bullet, evidence).toBeDefined();
        const [claudeWith, claudeWithout, codexWith, codexWithout] = ['Claude Code', 'Codex CLI'].flatMap((agent) => ['with kmp-test', 'without'].map((arm) => rows.find((r) => r[1] === evidence && r[2] === agent && r[3] === arm)));
        expect(bullet, evidence).toContain(`median tool calls ${claudeWith[4]} vs ${claudeWithout[4]} (Claude Code) and ${codexWith[4]} vs ${codexWithout[4]} (Codex CLI)`);
        expect(bullet, evidence).toContain(`median estimated cost $${claudeWith[7]} vs $${claudeWithout[7]} and $${codexWith[7]} vs $${codexWithout[7]}`);
        expect(bullet, evidence).toContain(`key facts ${claudeWith[9]} vs ${claudeWithout[9]} and ${codexWith[9]} vs ${codexWithout[9]}`);
      }
    });

    it('refuses a campaign in which a group has no counted session, instead of printing an empty row', () => {
      const broken = structuredClone(summary);
      broken.cells = broken.cells.filter((c) => !(c.runtime_id === 'codex-cli' && c.arm === 'free'));
      expect(() => buildCampaignsBlock([{ evidenceN: 9, summary: broken, costEstimate }])).toThrow(/Evidence9: no counted sessions for codex-cli free/);
    });
  });
});

// The fixed prose of the Evidence3 section and the changed Limitations bullet make statements that the committed data must back.
describe('the fixed prose of the Evidence3 section is backed by the committed data', () => {
  let summary, e2Summary, doc, section, audit;
  beforeAll(() => {
    summary = loadSummary(join(E3_DIR, 'campaign-summary.json'));
    e2Summary = loadSummary(join(RUNS_DIR, 'campaign-summary.json'));
    doc = crlfNormalize(readFileSync(DOC_PATH, 'utf8'));
    section = doc.slice(doc.indexOf('## Evidence3 ('), doc.indexOf('## Limitations'));
    audit = crlfNormalize(readFileSync(join(E3_DIR, 'controls-audit.md'), 'utf8'));
  });

  it('the section sits after Evidence2\'s Cost method and before the Limitations, and ends with the both-campaigns table', () => {
    const at = (needle) => doc.indexOf(needle);
    expect(at('### Cost method')).toBeGreaterThan(-1);
    expect(at('## Evidence3 (2026-10-02): many modules, failing tests')).toBeGreaterThan(at('### Cost method'));
    expect(at('## Evidence4 (2026-10-07): LINE coverage by module')).toBeGreaterThan(at('### Session conditions'));
    expect(at('## Across campaigns')).toBeGreaterThan(at('## Evidence4 (2026-10-07): LINE coverage by module'));
    expect(at('## Limitations')).toBeGreaterThan(at('## Across campaigns'));
    expect(doc.slice(at('## Across campaigns'), at('## Limitations')).trimEnd().endsWith(docBlockMarkers('campaigns').end)).toBe(true);
  });

  it('every link and image of the section points at a file that exists, and the figures are the ones the Evidence3 folder publishes', () => {
    const targets = [...section.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThanOrEqual(4);
    for (const target of targets) expect(existsSync(join(REPO_ROOT, 'docs', target)), target).toBe(true);
    for (const figure of ['scorecard.svg', 'metrics-grid.svg', 'cost-breakdown.svg']) expect(targets).toContain(`../tools/runs/${E3_DIR_NAME}/${figure}`);
  });

  it('the alt text of each cost-breakdown figure names what it shows', () => {
    const figures = [...doc.matchAll(/!\[([^\]]*)\]\(([^)]*cost-breakdown\.svg)\)/g)].map((m) => ({ alt: m[1], url: m[2] }));
    expect(figures.map((f) => f.url)).toEqual(['../tools/runs/evidence2-agentic-benchmark-2026-09-30/cost-breakdown.svg', `../tools/runs/${E3_DIR_NAME}/cost-breakdown.svg`, `../tools/runs/${E4_DIR_NAME}/cost-breakdown.svg`, `../tools/runs/${E5_DIR_NAME}/cost-breakdown.svg`, `../tools/runs/${E6_DIR_NAME}/cost-breakdown.svg`]);
    for (const { alt } of figures.slice(0, 2)) expect(alt).toBe('Stacked bars: median estimated API cost per session for Claude Code and Codex CLI, with and without kmp-test, split by cost component.');
    expect(figures[2].alt).toBe('Evidence4 estimated API cost components per counted session.');
    expect(figures[3].alt).toBe('Evidence5 estimated API cost components per counted session.');
    expect(figures[4].alt).toBe('Evidence6 estimated API cost components per counted session.');
  });

  it('"No session changed a file that a later session would load": the Claude Code sessions are all agent_state_clean, and the only ones that are not are the Codex CLI sessions whose config.toml the record names', () => {
    const counted = summary.cells.filter((c) => c.status !== 'missing');
    const claude = counted.filter((c) => c.runtime_id === 'claude-code');
    expect(claude).toHaveLength(15);
    expect(claude.every((c) => c.agent_state_clean === true)).toBe(true);
    const notClean = summary.cells.filter((c) => c.agent_state_clean === false);
    expect(notClean.every((c) => c.runtime_id === 'codex-cli' && c.status === 'accepted')).toBe(true);
    expect(notClean).toHaveLength(counted.filter((c) => c.runtime_id === 'codex-cli').length);
    expect(audit).toContain('the only changed context-relevant file was `config.toml` in 15 of them (amendment A3)');
    expect(section).toContain('`agent_state_clean` is false for those cells in the summary and the record names them');
    // "the record names them": the audit's agent-state row for Codex CLI lists every one of those cells, by cell key.
    const auditRow = audit.split('\n').find((l) => l.startsWith('| Agent-state listing: Codex CLI'));
    expect(auditRow).toBeDefined();
    for (const cell of notClean) expect(auditRow, cell.cell_key).toMatch(new RegExp(`\\b${cell.cell_key}\\b`));
  });

  it('"The transcripts of 30 of the 32 sessions were scanned ... with no hits": 30 sessions have a transcript, the audit reports no hit, and the summary says the other cell\'s access is not verified', () => {
    expect(sum(summary.by_runtime_arm.map((g) => g.declared))).toBe(32);
    expect(summary.cells.filter((c) => c.status !== 'missing')).toHaveLength(30);
    expect(audit).toContain('0 cells with a match, 30 of 31 cells scanned');
    expect(summary.limitations).toContain('cell claude-code-8: transcript missing: access not verified');
    expect(section.replace(/\s+/g, ' ')).toContain('The transcripts of 30 of the 32 sessions were scanned for the ground-truth, preregistration and private paths, with no hits.');
  });

  it('the Limitations bullet on sample sizes matches the summaries: 4 per arm in Evidence2, 8 planned and 7 or 8 counted in Evidence3', () => {
    expect(e2Summary.by_runtime_arm.map((g) => [g.declared, g.counted ?? g.declared])).toEqual([[4, 4], [4, 4], [4, 4], [4, 4]]);
    expect(summary.by_runtime_arm.map((g) => g.declared)).toEqual([8, 8, 8, 8]);
    expect(Math.min(...summary.by_runtime_arm.map((g) => g.counted))).toBe(7);
    expect(Math.max(...summary.by_runtime_arm.map((g) => g.counted))).toBe(8);
    expect(loadSummary(join(E5_DIR, 'campaign-summary.json')).by_runtime_arm.map((g) => g.counted).sort()).toEqual([6, 7, 8, 8]);
    expect(loadSummary(join(E6_DIR, 'campaign-summary.json')).by_runtime_arm.map((g) => g.counted)).toEqual([8, 8, 8, 8]);
    expect(doc.replace(/\s+/g, ' ')).toContain('small samples (4 sessions per agent and arm in Evidence2; 8 planned per agent and arm in Evidence3–6, with 6–8 counted per group)');
  });

  // The one place of the section that names the failing modules is the subsection on the key-fact misses (the architect's amendment,
  // after the results were published); everywhere else the section keeps the scenario's ground truth out, as before.
  it('names no module, test class or other ground-truth detail of the scenario beyond the two counts the scenario paragraph states, outside the subsection on the key-fact misses', () => {
    const start = section.indexOf('### Why two sessions missed the key facts');
    const end = section.indexOf('\n### ', start + 1);
    expect(start).toBeGreaterThan(-1);
    const outside = section.slice(0, start) + section.slice(end);
    expect(outside).not.toMatch(GROUND_TRUTH_NAMES);
    expect(section.toLowerCase()).not.toContain('baseline');
  });

  // "Why two sessions missed the key facts" (the architect's amendment). What the committed data can back is checked here. The calls and
  // outputs the text describes (the exact kmp-test calls, the doubled output, the truncated tool result, the envelope's summary fields)
  // come from the architect's reading of the private records and transcripts of the cells, which are not in the repository.
  describe('the subsection on the two key-fact misses', () => {
    let misses, recordReadme, expectedFile;
    beforeAll(() => {
      const start = section.indexOf('### Why two sessions missed the key facts');
      const end = section.indexOf('\n### ', start + 1);
      misses = section.slice(start, end);
      recordReadme = crlfNormalize(readFileSync(join(E3_DIR, 'README.md'), 'utf8'));
      expectedFile = JSON.parse(readFileSync(join(CORPUS_DIR, 'expected', `${summary.scenario_id}.json`), 'utf8'));
    });

    it('is there once, right after the sessions block (and the note on the missing sessions) and before the session conditions, and points at the backlog', () => {
      const heading = '### Why two sessions missed the key facts';
      expect(section.split(heading).length - 1).toBe(1);
      expect(section).toContain(`${docBlockMarkers('e3-sessions').end}\n\n${heading}\n`);
      expect(section.indexOf('### Session conditions')).toBeGreaterThan(section.indexOf(heading));
      expect(misses.replace(/\s+/g, ' ')).toContain('The follow-ups are in the [backlog](../BACKLOG.md).');
    });

    it('both misses are round 12 of the kmp-test arm, one per agent, and the record shows the failing-test count as the only field that did not match', () => {
      const missed = summary.cells.filter((c) => c.status !== 'missing' && c.key_facts_match === false).map((c) => c.cell_key).sort();
      expect(missed).toEqual(['claude-code-12', 'codex-cli-12']);
      for (const key of missed) {
        const cell = summary.cells.find((c) => c.cell_key === key);
        expect([cell.arm, cell.round_index], key).toEqual(['product', 12]);
      }
      const lines = recordReadme.split('\n');
      const header = lines.find((l) => l.startsWith('| runtime | arm | round | status | key facts |')).split('|').map((x) => x.trim());
      for (const runtime of ['claude-code', 'codex-cli']) {
        const row = lines.find((l) => l.startsWith(`| ${runtime} | product | 12 |`)).split('|').map((x) => x.trim());
        expect(['key facts', 'failing modules', 'failing classes', 'count'].map((name) => row[header.indexOf(name)]), runtime).toEqual(['no', 'yes', 'yes', 'no']);
      }
      expect(misses.replace(/\s+/g, ' ')).toContain('Each named the right modules and test classes and got the failing-test count wrong.');
    });

    it('Claude Code matched the key facts in rounds 3, 6 and 10 of the kmp-test arm, which the text says answered the ground truth\'s 6', () => {
      for (const round of [3, 6, 10]) {
        const cell = summary.cells.find((c) => c.runtime_id === 'claude-code' && c.round_index === round);
        expect([cell.arm, cell.key_facts_match], `claude-code-${round}`).toEqual(['product', true]);
      }
      expect(expectedFile.expected.failed_count).toBe(6);
      const flat = misses.replace(/\s+/g, ' ');
      expect(flat).toContain('saw the same doubled output and answered 6');
      expect(flat).toContain('each of the 6 failing tests appeared twice in the output');
    });

    it('the modules and the failing tests per module it names are the corpus ground truth: 1 in :core:data, 2 in :core:domain and 3 in :feature:bookmarks:impl', () => {
      expect(expectedFile.expected_outcome).toContain('2 failing tests in GetFollowableTopicsUseCaseTest, :core:domain');
      expect(expectedFile.expected_outcome).toContain('1 failing test in CompositeUserNewsResourceRepositoryTest, :core:data, and 3 in BookmarksViewModelTest, :feature:bookmarks:impl');
      const named = [...new Set([...misses.matchAll(/`(:[a-z-]+(?::[a-z-]+)*)`/g)].map((m) => m[1]))].sort();
      expect(named).toEqual([...expectedFile.expected.failing_modules].sort());
      expect(misses.replace(/\s+/g, ' ')).toContain('one in `:core:data`, two in `:core:domain` and three in `:feature:bookmarks:impl`');
      expect(misses).not.toMatch(/BookmarksViewModelTest|CompositeUserNewsResourceRepositoryTest|GetFollowableTopicsUseCaseTest/);
    });

    it('the historical variant finding remains documented and the current README includes flavored variants', () => {
      const readme = crlfNormalize(readFileSync(join(REPO_ROOT, 'README.md'), 'utf8'));
      expect(readme).toContain('`--variant` / `--android-variant <value>`');
      expect(readme).toContain('Accepts `auto`, `debug`, `release`, `all`, or a flavored variant such as `demoDebug` or `prodRelease`');
      expect(misses).toContain('`--variant` takes `auto`, `debug`, `release` or `all`');
      const backlog = crlfNormalize(readFileSync(join(REPO_ROOT, 'BACKLOG.md'), 'utf8'));
      const queued = backlog.slice(backlog.indexOf('## QUEUED — post-v0.3.4 ideas (newest first)'));
      const allHeadings = [...queued.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
      // They were queued at the top when this section was written (WO-15); WO-17 shipped them: the heading becomes
      // "✅ SHIPPED <date> (PR #<n>) — <title>" with the title and the text kept, and the parked milestone and newer items may sit above them.
      const titles = [
        'The umbrella-flavor warning is skipped for the default test type',
        '`--variant` silently accepts values outside `auto|debug|release|all`',
        'The envelope has no test-level failed count',
      ];
      const shipped = (title) => allHeadings.findIndex((h) => new RegExp(`^✅ SHIPPED \\d{4}-\\d{2}-\\d{2} \\(PR #\\d+\\) — ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(h));
      const first = shipped(titles[0]);
      expect(first).toBeGreaterThan(-1);
      expect(titles.map(shipped)).toEqual([first, first + 1, first + 2]);
      // The two items of the same cycle follow them directly.
      expect(allHeadings.slice(first + 3, first + 5)).toEqual([
        '💡 IDEA — Grader: accept a kmp-test envelope that reached the model through a file read (coverage family)',
        '💡 IDEA — Scenario B: multi-module coverage (NowInAndroid), same protocol as Evidence3',
      ]);
      const start = queued.indexOf(`### ${allHeadings[first]}`);
      const findings = queued.slice(start, queued.indexOf('### 💡 IDEA — Grader: accept a kmp-test envelope'));
      expect(findings.match(/\*\*Shipped:\*\*/g)).toHaveLength(3);
      expect(findings.match(/Evidence3/g).length).toBeGreaterThanOrEqual(3);
      expect(findings).not.toMatch(GROUND_TRUTH_NAMES);
    });
  });
});

describe('publication blocks for later scenario families', () => {
  const cases = [
    { evidenceN: 4, family: 'multi-module-coverage', expected: {
      outcome_kind: 'coverage_threshold_exceeded', threshold_percent: 26,
      below_threshold_modules: [':core:data'], no_data_modules: [':core:domain'],
      module_line_coverage: { ':core:data': 20 },
    }, phrases: ['LINE coverage separately for 2 in-scope modules', '26% threshold', 'no coverage data'] },
    { evidenceN: 5, family: 'changed-dependents', expected: {
      outcome_kind: 'tests_failed', direct_modules: [':core:data'], dependent_modules: [':core:domain'],
      selected_modules: [':core:data', ':core:domain'], failing_modules: [':core:domain'],
      failed_test_classes: ['DependentTest'], failed_count: 1,
    }, phrases: ['compares against the specified base', 'includes dependent modules', '2 modules are in scope'] },
    { evidenceN: 6, family: 'compile-failure', expected: {
      outcome_kind: 'compilation_failed', compile_module: ':core:data', compile_task: ':core:data:compileKotlin',
      diagnostic_file: 'core/data/Foo.kt', diagnostic_line: 10,
      diagnostic_message: 'Unresolved reference', unrun_dependents: [':core:domain'],
    }, phrases: ['failing compile task and diagnostic', 'dependents could not run', '2 modules are in scope'] },
  ];

  it('reads each family from synthetic corpus files and renders task-specific, aggregate-only prose', () => {
    const root = mkdtempSync(join(tmpdir(), 'kmp-publication-families-'));
    try {
      mkdirSync(join(root, 'scenarios'));
      mkdirSync(join(root, 'expected'));
      for (const { evidenceN, family, expected, phrases } of cases) {
        const id = `synthetic-e${evidenceN}`;
        writeFileSync(join(root, 'scenarios', `${id}.json`), JSON.stringify({
          id, family, policy: { allowed_gradle_tasks: [':core:data:tasks', ':core:domain:tasks'] },
        }));
        writeFileSync(join(root, 'expected', `${id}.json`), JSON.stringify({ id, expected }));
        const facts = loadScenarioPublicationFacts(id, root);
        expect(facts.family).toBe(family);
        expect(facts.moduleCount).toBe(2);
        const prose = buildScenarioBlock(facts);
        for (const phrase of phrases) expect(prose, family).toContain(phrase);
        expect(prose).not.toContain('6 failing test methods');
        expect(prose).not.toContain(':core:');
      }
      expect(() => buildScenarioBlock({ family: 'unknown', moduleCount: 2 })).toThrow(/unsupported family/);
      const id = 'synthetic-e4';
      writeFileSync(join(root, 'expected', `${id}.json`), JSON.stringify({ id, expected: { threshold_percent: '26' } }));
      expect(() => loadScenarioPublicationFacts(id, root)).toThrow(/threshold_percent/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the validated-registry order through Evidence6 and checks synthetic generated outputs for staleness', () => {
    const root = mkdtempSync(join(tmpdir(), 'kmp-publication-registry-'));
    try {
      mkdirSync(join(root, 'scenarios'));
      mkdirSync(join(root, 'expected'));
      const originalSummary = loadSummary(join(E3_DIR, 'campaign-summary.json'));
      const costEstimate = loadCostEstimate(join(E3_DIR, 'cost-estimate.json'));
      const campaigns = [2, 3].map((evidenceN) => ({
        evidenceN, dir: `evidence${evidenceN}-agentic-benchmark-${evidenceN === 2 ? '2026-09-30' : E3_DATE}`,
        summary: originalSummary, costEstimate,
      }));
      for (const { evidenceN, family, expected, phrases } of cases) {
        const id = `synthetic-e${evidenceN}`;
        writeFileSync(join(root, 'scenarios', `${id}.json`), JSON.stringify({
          id, family, policy: { allowed_gradle_tasks: [':core:data:tasks', ':core:domain:tasks'] },
        }));
        writeFileSync(join(root, 'expected', `${id}.json`), JSON.stringify({ id, expected }));
        const summary = { ...originalSummary, scenario_id: id };
        campaigns.push({ evidenceN, dir: `evidence${evidenceN}-agentic-benchmark-2026-10-07`, summary, costEstimate });
        const context = docContext(evidenceN, '2026-10-07', summary, costEstimate, { campaigns, corpusDir: root });
        expect(context.campaigns.map((entry) => entry.evidenceN)).toEqual(Array.from({ length: evidenceN - 1 }, (_, i) => i + 2));
        const blocks = docBlocks(evidenceN, summary, costEstimate, context);
        for (const phrase of phrases) expect(blocks[`e${evidenceN}-scenario`]).toContain(phrase);
        expect(blocks.campaigns.match(/^\| Evidence\d+ \|/gm)).toHaveLength(4 * (evidenceN - 1));
        expect(blocks.campaigns).toContain(`key facts differ between the ${{ 4: 'three', 5: 'four', 6: 'five' }[evidenceN]} tasks`);
        expect(blocks[`e${evidenceN}-run`]).toContain(`Record: [Evidence${evidenceN}](../tools/runs/evidence${evidenceN}-agentic-benchmark-2026-10-07/README.md).`);
        const template = Object.keys(blocks).map((key) => {
          const marker = docBlockMarkers(key);
          return `${marker.start}\nstale\n${marker.end}`;
        }).join('\n\n');
        const filled = fillDocBlocks(template, blocks);
        const svgPath = join(root, `e${evidenceN}.svg`);
        const svg = renderCostBreakdownSvg(summary, costEstimate);
        writeFileSync(svgPath, svg);
        expect(staleOutputs({ svgPath, svg, docPath: 'synthetic.md', doc: filled, filled })).toEqual([]);
        expect(staleOutputs({ svgPath, svg, docPath: 'synthetic.md', doc: template, filled })).toEqual(['synthetic.md']);
      }
      const oldSummary = campaigns.find((campaign) => campaign.evidenceN === 4).summary;
      const oldContext = docContext(4, '2026-10-07', oldSummary, costEstimate, { campaigns, corpusDir: root });
      expect(oldContext.campaigns.map((campaign) => campaign.evidenceN)).toEqual([2, 3, 4, 5, 6]);
      expect(docBlocks(4, oldSummary, costEstimate, oldContext).campaigns.match(/^\| Evidence\d+ \|/gm)).toHaveLength(20);
      const latest = campaigns.at(-1);
      expect(() => docContext(6, '2026-10-08', latest.summary, costEstimate, { campaigns, corpusDir: root })).toThrow(/exactly one registry entry/);
      expect(() => docContext(6, '2026-10-07', latest.summary, costEstimate, {
        campaigns: [...campaigns, { ...latest, dir: 'evidence6-agentic-benchmark-2026-10-08' }], corpusDir: root,
      })).toThrow(/exactly one registry entry/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the committed Evidence4 publication', () => {
  const runDir = join(REPO_ROOT, 'tools', 'runs', 'evidence4-agentic-benchmark-2026-10-07');

  it('uses the declared 11-module scope rather than requiring a Gradle discovery task', () => {
    const facts = loadScenarioPublicationFacts('multi-module-line-coverage');
    expect(facts).toEqual({ family: 'multi-module-coverage', moduleCount: 11, thresholdPercent: 26 });
    expect(buildScenarioBlock(facts)).toContain('11 in-scope modules');
  });

  it('keeps the counted D3 negative and excludes only the structural rejection from scores', () => {
    const summary = loadSummary(join(runDir, 'campaign-summary.json'));
    expect(summary.cells).toHaveLength(32);
    expect(summary.cells.filter((cell) => cell.status === 'accepted')).toHaveLength(30);
    expect(summary.cells.filter((cell) => cell.status === 'negative-d3').map((cell) => [cell.runtime_id, cell.arm, cell.round_index])).toEqual([['codex-cli', 'free', 8]]);
    expect(summary.cells.filter((cell) => cell.status === 'missing').map((cell) => [cell.runtime_id, cell.arm, cell.round_index])).toEqual([['claude-code', 'product', 10]]);
    expect(summary.by_runtime_arm.map((group) => `${group.runtime_id}/${group.arm}:${group.key_facts_match.matched}/${group.key_facts_match.of}`))
      .toEqual(['claude-code/free:5/8', 'claude-code/product:7/7', 'codex-cli/free:1/8', 'codex-cli/product:8/8']);
    const sensitivity = loadSummary(join(runDir, 'campaign-summary-sensitivity.json'));
    expect(sensitivity.by_runtime_arm).toEqual(summary.by_runtime_arm);
  });

  it('reconciles all 32 attempt costs, including measured usage of the missing cell', () => {
    const estimate = loadCostEstimate(join(runDir, 'cost-estimate.json'));
    const control = JSON.parse(readFileSync(join(runDir, 'cost-control.json'), 'utf8'));
    expect(estimate.runtimes['claude-code'].cells).toHaveLength(15);
    expect(estimate.runtimes['codex-cli'].cells).toHaveLength(16);
    const claudeUpper = estimate.runtimes['claude-code'].cells.reduce((total, { tokens: t }) => total
      + (t.input * 2 + t.cache_read * 0.2 + t.cache_creation * 4 + t.output * 10) / 1e6, 0);
    const codexUpper = estimate.runtimes['codex-cli'].cells.reduce((total, { tokens: t }) => total
      + (t.input * 2.5 * 2 + t.cache_read * 0.2 * 2 + t.output * 12 * 1.5) / 1e6, 0);
    expect(claudeUpper + codexUpper).toBeCloseTo(control.counted_upper_usd, 7);
    expect(control.missing_cell).toMatchObject({ runtime_id: 'claude-code', arm: 'product', order_index: 10, usage_source: 'runtime-reported' });
    const t = control.missing_cell.tokens;
    expect((t.input * 2 + t.cache_read * 0.2 + t.cache_write * 4 + t.output * 10) / 1e6).toBeCloseTo(control.missing_cell.upper_usd, 7);
    expect(control.counted_upper_usd + control.missing_cell.upper_usd).toBeCloseTo(control.all_attempts_upper_usd, 7);
    expect(control.all_attempts_upper_usd).toBeLessThan(control.frozen_ceiling_usd);
  });

  it('has fresh generated figures and document blocks', () => {
    const summary = loadSummary(join(runDir, 'campaign-summary.json'));
    const cost = loadCostEstimate(join(runDir, 'cost-estimate.json'));
    const doc = crlfNormalize(readFileSync(DOC_PATH, 'utf8'));
    const blocks = docBlocks(4, summary, cost, docContext(4, '2026-10-07', summary, cost));
    for (const [id, content] of Object.entries(blocks)) expect(readDocBlock(doc, id), id).toBe(`\n${content}\n`);
    expect(crlfNormalize(readFileSync(join(runDir, 'cost-breakdown.svg'), 'utf8'))).toBe(renderCostBreakdownSvg(summary, cost));
    expect(doc).toContain('Codex CLI free-arm index 8 is a counted protocol failure');
    expect(doc).toContain('Codex CLI without: tool-call median uses 7 recorded cells');
  });
});

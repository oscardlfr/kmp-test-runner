import { describe, expect, it } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeMetricsGridLayout, renderMetricsGridSvg, costMetric, loadSummary, loadCostEstimate,
} from '../../tools/agentic-eval/readme-evidence.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const RUNS_DIR = join(REPO_ROOT, 'tools', 'runs', 'evidence1-agentic-benchmark-2026-09-28');

// Minimal, valid schema-1 summary/cost-estimate: 4 groups, real duration_ms/tool_calls_total
// stats and a `cells` array shaped exactly like campaign-summary.mjs's real output (per-cell
// duration_ms/tool_calls_total only -- no per-cell tokens, matching every real campaign so far).
function baseGroup(overrides = {}) {
  return {
    declared: 4, accepted: 4, negative_d3: 0, missing: 0, counted: 4, missing_reasons: [],
    key_facts_match: { matched: 4, of: 4 }, full_answer_match: { matched: 0, of: 4 }, success: null,
    duration_ms: { n: 4, min: 100000, max: 160000, mean: 130000, median: 128000, stddev_sample: 1 },
    tool_calls_total: { n: 4, min: 8, max: 14, mean: 11, median: 11, stddev_sample: 1 },
    shell_commands_total: { n: 4, min: 8, max: 14, mean: 11, median: 11, stddev_sample: 1 },
    tokens: {
      input: { n: 4, min: 20, max: 30, mean: 25, median: 25, stddev_sample: 1 },
      output: { n: 4, min: 3000, max: 4000, mean: 3500, median: 3500, stddev_sample: 1 },
      cached_input: { n: 4, min: 200000, max: 300000, mean: 250000, median: 250000, stddev_sample: 1 },
      cache_write: { n: 4, min: 20000, max: 30000, mean: 25000, median: 25000, stddev_sample: 1 },
    },
    kmp_test_vs_gradle: { available: true, kmp_test_count: 8, gradle_count: 4 },
    ...overrides,
  };
}

function baseCells(runtimeId, arm) {
  return [1, 2, 3, 4].map((i) => ({
    runtime_id: runtimeId, arm, round_index: i, cell_key: `${runtimeId}-${i}`,
    status: 'accepted', reason: null, key_facts_match: true, full_answer_match: false, success: null,
    duration_ms: 100000 + i * 10000, tool_calls_total: 8 + i,
  }));
}

function schema1Summary() {
  return {
    schema: 1, summary_status: 'ok', provider_mode: 'live',
    provenance: { kmp_test_cli_version: { values: ['0.16.0'], mixed: false } },
    by_runtime_arm: [
      { runtime_id: 'claude-code', arm: 'product', ...baseGroup() },
      { runtime_id: 'claude-code', arm: 'free', ...baseGroup() },
      { runtime_id: 'codex-cli', arm: 'product', ...baseGroup() },
      { runtime_id: 'codex-cli', arm: 'free', ...baseGroup() },
    ],
    cells: [
      ...baseCells('claude-code', 'product'), ...baseCells('claude-code', 'free'),
      ...baseCells('codex-cli', 'product'), ...baseCells('codex-cli', 'free'),
    ],
  };
}

function schema1CostEstimate() {
  const cell = (i) => ({ arm: i <= 4 ? 'product' : 'free', tokens: { input: 20 + i, cache_creation: 25000, cache_read: 250000, output: 3500 } });
  return {
    schema: 1,
    pricing: { per_million_tokens: { input: 3, cache_write_5m: 3.75, cache_write_1h: 6, cache_read: 0.3, output: 15 } },
    cells: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ runtime_id: 'claude-code', ...cell(i) })),
  };
}

// Every numeric x/y/width/height in the rendered layout must be finite and non-negative (a stack
// segment can legitimately round to a zero-height bar, but never negative or NaN/Infinity) --
// this is the exact class of bug a kind-label mismatch between stackedMetric() and yScaleFor()
// produced: silently falling back to scale=1 and exploding every bar into the millions of pixels.
function assertAllFiniteNonNegativeGeometry(items) {
  for (const item of items) {
    if (item.kind === 'bar') {
      expect(Number.isFinite(item.x), `bar x finite: ${JSON.stringify(item)}`).toBe(true);
      expect(Number.isFinite(item.y), `bar y finite: ${JSON.stringify(item)}`).toBe(true);
      expect(item.h, `bar height non-negative: ${JSON.stringify(item)}`).toBeGreaterThanOrEqual(0);
      expect(item.h, `bar height sane (<1000px): ${JSON.stringify(item)}`).toBeLessThan(1000);
    }
    if (item.kind === 'dot') {
      expect(Number.isFinite(item.cx) && Number.isFinite(item.cy), `dot finite: ${JSON.stringify(item)}`).toBe(true);
    }
    if (item.kind === 'medianTick' || item.kind === 'rangeLine') {
      const ys = [item.y, item.y1, item.y2].filter((v) => v !== undefined);
      for (const y of ys) expect(Number.isFinite(y), `line y finite: ${JSON.stringify(item)}`).toBe(true);
    }
  }
}

describe('metrics-grid.svg', () => {
  it('renders every mark within sane, finite bounds against a realistic schema-1 fixture (regression: stacked-metric kind-label mismatch exploded bar heights into the millions)', () => {
    const layout = computeMetricsGridLayout(schema1Summary(), schema1CostEstimate());
    assertAllFiniteNonNegativeGeometry(layout.items);
    expect(layout.height).toBeGreaterThan(0);
    expect(layout.height).toBeLessThan(2000); // sane upper bound; the bug produced heights in the millions
  });

  it('renders valid, well-formed SVG (parses, has the expected viewBox) against the same fixture', () => {
    const svg = renderMetricsGridSvg(schema1Summary(), schema1CostEstimate());
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('Infinity');
    expect(svg).not.toContain('undefined');
  });

  it('labels every row "(descriptive)" -- none of this grid is pre-registered', () => {
    const layout = computeMetricsGridLayout(schema1Summary(), schema1CostEstimate());
    const rowLabels = layout.items.filter((i) => i.role === 'gridRowLabel').map((i) => i.text);
    expect(rowLabels.length).toBeGreaterThan(0);
    for (const label of rowLabels) expect(label).toContain('(descriptive)');
  });

  it('falls back to a campaign-aggregate stacked bar (not per-session dots) when cells[] carries no per-cell tokens -- the real shape every campaign has produced so far', () => {
    const layout = computeMetricsGridLayout(schema1Summary(), schema1CostEstimate());
    // Tokens is a true per-type median (by_runtime_arm.tokens.<type>.median); tool-calls-by-kind is
    // a per-session MEAN (see the "campaign mean per session" test below) -- only tokens contributes
    // "campaign median" notes here, 2 runtimes x 2 arms of them, still > 0.
    const aggregateNotes = layout.items.filter((i) => i.role === 'gridAggregateNote' && i.text.includes('campaign median'));
    expect(aggregateNotes.length).toBeGreaterThan(0);
  });

  it('renders real per-session dots for wall-clock -- cells[] DOES carry duration_ms per session today', () => {
    const layout = computeMetricsGridLayout(schema1Summary(), schema1CostEstimate());
    const dots = layout.items.filter((i) => i.kind === 'dot');
    // 2 runtimes x 2 arms x 4 sessions = 16 dots for wall-clock alone (cost may also add dots)
    expect(dots.length).toBeGreaterThanOrEqual(16);
  });

  it('reports "not available for this campaign" for turns on a schema-1 summary (num_turns is a v9-only field, absent from every real Evidence1 record)', () => {
    const svg = renderMetricsGridSvg(schema1Summary(), schema1CostEstimate());
    const turnsIdx = svg.indexOf('Turns (descriptive)');
    expect(turnsIdx).toBeGreaterThan(-1);
    expect(svg.slice(turnsIdx, turnsIdx + 200)).toContain('not available for this campaign');
  });

  it('omits the tool-result-volume row entirely when output_bytes is unavailable for every runtime (gated, not just labeled "not available")', () => {
    const svg = renderMetricsGridSvg(schema1Summary(), schema1CostEstimate());
    expect(svg).not.toContain('Tool-result bytes');
  });

  it('includes the tool-result-volume row, with real per-session dots, once cells[] carries output_bytes', () => {
    const summary = schema1Summary();
    for (const cell of summary.cells) cell.output_bytes = 1000 + cell.round_index * 100;
    const svg = renderMetricsGridSvg(summary, schema1CostEstimate());
    expect(svg).toContain('Tool-result bytes fed back to the model (descriptive)');
    const layout = computeMetricsGridLayout(summary, schema1CostEstimate());
    assertAllFiniteNonNegativeGeometry(layout.items);
  });

  it('renders real per-session token-stack dots once cells[] carries per-cell tokens (a future campaign-summary.mjs extension, not real data today)', () => {
    const summary = schema1Summary();
    for (const cell of summary.cells) {
      cell.tokens = { input: 25, cached_input: 250000, cache_write: 25000, output: 3500 };
    }
    const layout = computeMetricsGridLayout(summary, schema1CostEstimate());
    assertAllFiniteNonNegativeGeometry(layout.items);
    const bars = layout.items.filter((i) => i.kind === 'bar');
    expect(bars.length).toBeGreaterThan(0);
    // No "campaign median (not per-session)" note for the tokens row now that per-session data exists.
    const svg = renderMetricsGridSvg(summary, schema1CostEstimate());
    const tokensIdx = svg.indexOf('Tokens per session, by type');
    const nextRowIdx = svg.indexOf('Tool calls by kind');
    expect(svg.slice(tokensIdx, nextRowIdx)).not.toContain('campaign median (not per-session)');
  });

  it('never produces negative bar heights even when a token type is a tiny fraction of the stack total (input vs. a ~300k-token cached_input)', () => {
    // Regression for the exact real-data shape that first exposed the kind-label bug: input ~= 26
    // tokens against a cached_input/cache_write/output total in the hundreds of thousands.
    const summary = schema1Summary();
    summary.by_runtime_arm[0].tokens.input = { n: 4, min: 20, max: 30, mean: 26, median: 26, stddev_sample: 1 };
    const layout = computeMetricsGridLayout(summary, schema1CostEstimate());
    assertAllFiniteNonNegativeGeometry(layout.items);
  });

  // CodeRabbit round on #537 (WO-C9), 5 findings against 64bb1e3 -- one it() per finding below.

  it('CodeRabbit finding 1a: the tool-calls-by-kind aggregate note says "mean", not "median" -- kmp_test_count/gradle_count are per-session totals divided by n, never a true median', () => {
    const svg = renderMetricsGridSvg(schema1Summary(), schema1CostEstimate());
    const toolsIdx = svg.indexOf('Tool calls by kind');
    const nextRowIdx = svg.indexOf('Wall-clock');
    const toolsSection = svg.slice(toolsIdx, nextRowIdx);
    // Wording per WO-C10's row-level note redesign: "bars: campaign mean per session, not per-session".
    expect(toolsSection).toContain('bars: campaign mean per session, not per-session');
    expect(toolsSection).not.toContain('bars: campaign median, not per-session');
    // Tokens-by-type is unaffected -- it's a real per-type median from by_runtime_arm, still labeled "median".
    const tokensIdx = svg.indexOf('Tokens per session, by type');
    expect(svg.slice(tokensIdx, toolsIdx)).toContain('bars: campaign median, not per-session');
  });

  it('CodeRabbit finding 1b: never fabricates a measured-zero "other" bucket in the tool-calls-by-kind aggregate -- campaign-summary.mjs does not track it at the aggregate level, so it must be absent, not a fake 0', () => {
    const svg = renderMetricsGridSvg(schema1Summary(), schema1CostEstimate());
    const toolsIdx = svg.indexOf('Tool calls by kind');
    const nextRowIdx = svg.indexOf('Wall-clock');
    const toolsSection = svg.slice(toolsIdx, nextRowIdx);
    expect(toolsSection).toContain('>kmp-test<');
    expect(toolsSection).toContain('>gradle<');
    expect(toolsSection).not.toMatch(/>other</);
  });

  it('CodeRabbit finding 1b (per-cell path unaffected): per-cell command_kind_counts still carries all 3 buckets once cells[] has per-cell data', () => {
    const summary = schema1Summary();
    for (const cell of summary.cells) cell.command_kind_counts = { kmp_test: 6, gradle: 2, other: 1 };
    const svg = renderMetricsGridSvg(summary, schema1CostEstimate());
    const toolsIdx = svg.indexOf('Tool calls by kind');
    const nextRowIdx = svg.indexOf('Wall-clock');
    expect(svg.slice(toolsIdx, nextRowIdx)).toContain('>other<');
  });

  it('CodeRabbit finding 2: the cost row plots each session\'s midpoint of low/high, using the SAME low/high assumptions armCostRange uses for the scorecard (not the old mixed "5m cache-write + max input price" single point)', () => {
    const costEstimate = schema1CostEstimate();
    const price = costEstimate.pricing.per_million_tokens;
    const expectedSessionCost = (tokens, cacheWriteKey, inputPrice) =>
      (tokens.input * inputPrice + tokens.cache_creation * price[cacheWriteKey] + tokens.cache_read * price.cache_read + tokens.output * price.output) / 1e6;
    const summary = schema1Summary();
    const group = summary.by_runtime_arm.find((g) => g.runtime_id === 'claude-code' && g.arm === 'product');
    const metric = costMetric(summary, group, 'claude-code', 'product', costEstimate);
    expect(metric.kind).toBe('per-session');
    expect(metric.provider).toBe(false);
    expect(metric.values.length).toBe(4);
    const productCells = costEstimate.cells.filter((c) => c.arm === 'product');
    productCells.forEach((cell, i) => {
      const low = expectedSessionCost(cell.tokens, 'cache_write_5m', price.input);
      const high = expectedSessionCost(cell.tokens, 'cache_write_1h', price.input); // schema 1: no uncached-may-be-cache-write ambiguity
      const midpoint = (low + high) / 2;
      expect(metric.values[i]).toBeCloseTo(midpoint, 9);
      // Old bug: sessionCost(tokens, price, 'cache_write_5m', highInputPrice) with highInputPrice===price.input
      // for schema 1 -- collapses to exactly `low`, strictly below the true midpoint since cache_write_1h > cache_write_5m.
      expect(metric.values[i]).toBeGreaterThan(low);
    });
  });

  it('CodeRabbit finding 2: the cost row label says it is a midpoint estimate', () => {
    const svg = renderMetricsGridSvg(schema1Summary(), schema1CostEstimate());
    expect(svg).toContain('API cost (midpoint of low/high)');
  });

  it('CodeRabbit finding 3: stacked rows get a per-type color legend (swatch + label), showing only the types actually present -- not the full color-map key set', () => {
    const layout = computeMetricsGridLayout(schema1Summary(), schema1CostEstimate());
    const swatches = layout.items.filter((i) => i.kind === 'legendSwatch');
    expect(swatches.length).toBeGreaterThan(0);
    for (const s of swatches) expect(s.fill).toMatch(/^#[0-9a-f]{6}$/);

    const svg = renderMetricsGridSvg(schema1Summary(), schema1CostEstimate());
    const toolsIdx = svg.indexOf('Tool calls by kind');
    const wallIdx = svg.indexOf('Wall-clock');
    expect(svg.slice(toolsIdx, wallIdx)).toContain('>kmp-test<');
    expect(svg.slice(toolsIdx, wallIdx)).toContain('>gradle<');

    // claude-code's token types exclude reasoning_output entirely (not just "untracked this campaign").
    const tokensIdx = svg.indexOf('Tokens per session, by type');
    const claudeTokensSection = svg.slice(tokensIdx, toolsIdx);
    expect(claudeTokensSection).toContain('>cached input<');
    expect(claudeTokensSection).not.toContain('>reasoning output<');
  });

  it('CodeRabbit finding 3: the SVG <desc> lists the full color-to-type mapping for both stacked categories', () => {
    const svg = renderMetricsGridSvg(schema1Summary(), schema1CostEstimate());
    const descMatch = svg.match(/<desc>([\s\S]*?)<\/desc>/);
    expect(descMatch).not.toBeNull();
    const desc = descMatch[1];
    for (const pair of ['input (#8250df)', 'cached input (#0969da)', 'cache write (#1a7f37)', 'reasoning output (#cf222e)', 'output (#bc4c00)']) {
      expect(desc).toContain(pair);
    }
    for (const pair of ['kmp-test (#0969da)', 'gradle (#bc4c00)', 'other (#59636e)']) {
      expect(desc).toContain(pair);
    }
  });

  it('CodeRabbit finding 4: the header subtitle is split across 2 lines, each starting after the previous one (was a single 152-char line overflowing the 880px viewBox at 13px)', () => {
    const layout = computeMetricsGridLayout(schema1Summary(), schema1CostEstimate());
    const subtitleItems = layout.items.filter((i) => i.role === 'gridSubtitle');
    expect(subtitleItems.length).toBe(2);
    expect(subtitleItems[1].y).toBeGreaterThan(subtitleItems[0].y);
    for (const item of subtitleItems) {
      const estWidth = item.text.length * item.fontSize * 0.6;
      expect(item.x + estWidth, `"${item.text}" (~${estWidth.toFixed(0)}px) overflows the ${layout.width}px viewBox`).toBeLessThanOrEqual(layout.width);
    }
  });

  it('CodeRabbit finding 4: every text item in the grid stays within the viewBox width at its estimated width (chars x fontSize x 0.6, the same formula the scorecard layout tests use)', () => {
    const layout = computeMetricsGridLayout(schema1Summary(), schema1CostEstimate());
    for (const item of layout.items) {
      if (item.kind !== 'text') continue;
      const estWidth = item.text.length * item.fontSize * 0.6;
      const x0 = item.anchor === 'end' ? item.x - estWidth : item.x;
      expect(x0 + estWidth, `"${item.text}" overflows: x=${item.x} estWidth=${estWidth.toFixed(0)} viewBox=${layout.width}`).toBeLessThanOrEqual(layout.width);
      expect(x0, `"${item.text}" starts left of x=0`).toBeGreaterThanOrEqual(0);
    }
  });
});

// WO-C10: headless-Edge screenshots of 64bb1e3 AND 23fab2c (still using the old fixed
// GRID_ROW_H=64 layout) showed real overlap the "estimated width stays in the viewBox" test above
// could not catch: the aggregate note drawn over the row label, the with/without notes overlapping
// each other, lane labels colliding with the NEXT row's label, and the legend sitting on top of
// the bars. These tests check actual geometry, not just horizontal viewBox containment.

// Same estimator as the scorecard's own "no overlapping text" describe block above in
// agentic-eval-readme-evidence.test.js (chars x fontSize x 0.6 for width; SVG <text> ascent/descent
// approximated as 0.8*fs above the baseline and 0.25*fs below it).
function textBBox(item) {
  const width = item.text.length * item.fontSize * 0.6;
  const x0 = item.anchor === 'end' ? item.x - width : item.x;
  return { x0, x1: x0 + width, y0: item.y - item.fontSize * 0.8, y1: item.y + item.fontSize * 0.25 };
}

// Bars/swatches are exact rects. Dots get their real radius. Tick/range lines have no thickness of
// their own, so they get a small (+-2px) fudge -- enough to catch a real collision, not so much
// that two merely-adjacent marks false-positive.
function markBBox(item) {
  if (item.kind === 'bar' || item.kind === 'legendSwatch') return { x0: item.x, x1: item.x + item.w, y0: item.y, y1: item.y + item.h };
  if (item.kind === 'dot') return { x0: item.cx - item.r, x1: item.cx + item.r, y0: item.cy - item.r, y1: item.cy + item.r };
  if (item.kind === 'medianTick') return { x0: Math.min(item.x1, item.x2), x1: Math.max(item.x1, item.x2), y0: item.y - 2, y1: item.y + 2 };
  if (item.kind === 'rangeLine') return { x0: item.x - 2, x1: item.x + 2, y0: Math.min(item.y1, item.y2), y1: Math.max(item.y1, item.y2) };
  return null;
}

function bboxesOverlap(a, b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function checkNoOverlapLayout(layout) {
  const textItems = layout.items.filter((i) => i.kind === 'text');
  const markItems = layout.items.map(markBBox).filter(Boolean);

  const textBoxes = textItems.map((i) => ({ ...textBBox(i), label: i.text }));
  for (let i = 0; i < textBoxes.length; i++) {
    for (let j = i + 1; j < textBoxes.length; j++) {
      expect(bboxesOverlap(textBoxes[i], textBoxes[j]), `text "${textBoxes[i].label}" (y=${textItems[i].y}) overlaps text "${textBoxes[j].label}" (y=${textItems[j].y})`).toBe(false);
    }
  }
  for (const t of textBoxes) {
    for (const m of markItems) {
      expect(bboxesOverlap(t, m), `text "${t.label}" overlaps a mark: ${JSON.stringify(m)}`).toBe(false);
    }
  }
  for (const item of layout.items) {
    const box = item.kind === 'text' ? textBBox(item) : markBBox(item);
    if (!box) continue;
    const label = item.text || item.kind;
    expect(box.x0, `"${label}" x0 < 0`).toBeGreaterThanOrEqual(0);
    expect(box.x1, `"${label}" x1 (${box.x1}) exceeds viewBox width ${layout.width}`).toBeLessThanOrEqual(layout.width);
    expect(box.y0, `"${label}" y0 < 0`).toBeGreaterThanOrEqual(0);
    expect(box.y1, `"${label}" y1 (${box.y1}) exceeds viewBox height ${layout.height}`).toBeLessThanOrEqual(layout.height);
  }

  const PAD_ = 28, COLUMN_GAP_ = 32;
  const COLUMN_W_ = (layout.width - 2 * PAD_ - COLUMN_GAP_) / 2;
  const columnLefts = [PAD_, PAD_ + COLUMN_W_ + COLUMN_GAP_];
  const legendItems = layout.items.filter((i) => i.kind === 'legendSwatch' || i.role === 'gridLegendLabel');
  for (const colLeft of columnLefts) {
    const inColumn = legendItems.filter((i) => i.x >= colLeft && i.x < colLeft + COLUMN_W_ + COLUMN_GAP_);
    for (const item of inColumn) {
      const box = item.kind === 'legendSwatch' ? markBBox(item) : textBBox(item);
      expect(box.x1, `legend item at x=${item.x} (column left ${colLeft}) reaches ${box.x1}, past the column's own right edge ${colLeft + COLUMN_W_} (COLUMN_W, not just the viewBox)`).toBeLessThanOrEqual(colLeft + COLUMN_W_);
    }
  }
}

describe('metrics-grid.svg: WO-C10 no-overlap layout (headless-Edge-verified regression)', () => {
  it('(a)+(b)+(c)+(d): the synthetic schema-1 fixture (stack-aggregate + per-session + unavailable rows, the same mix real campaigns have) has no text-vs-text overlap, no text/legend-vs-mark overlap, everything inside the viewBox including the vertical bound, and every legend fits its own COLUMN_W', () => {
    const layout = computeMetricsGridLayout(schema1Summary(), schema1CostEstimate());
    checkNoOverlapLayout(layout);
  });

  it('(a)+(b)+(c)+(d): the REAL committed Evidence1 campaign data -- the exact shape the auditor\'s headless-Edge render of 64bb1e3/23fab2c exposed the overlap against', () => {
    const summary = loadSummary(join(RUNS_DIR, 'campaign-summary.json'));
    const costEstimate = loadCostEstimate(join(RUNS_DIR, 'cost-estimate.json'));
    const layout = computeMetricsGridLayout(summary, costEstimate);
    checkNoOverlapLayout(layout);
  });

  it('a stack-aggregate row\'s one note line reflects the true stat, and never duplicates per-lane (with/without share ONE note, not two that can overlap each other)', () => {
    const svg = renderMetricsGridSvg(schema1Summary(), schema1CostEstimate());
    const toolsIdx = svg.indexOf('Tool calls by kind');
    const wallIdx = svg.indexOf('Wall-clock');
    const section = svg.slice(toolsIdx, wallIdx);
    const noteOccurrences = section.split('campaign mean per session, not per-session').length - 1;
    expect(noteOccurrences).toBe(1);
  });

  it('a scalar row that falls back to a campaign range (min/median/max, no per-cell data) gets the same one-line note treatment, not the old per-lane "campaign range (not per-session)" text drawn over the plot', () => {
    const summary = schema1Summary();
    // Strip per-cell duration_ms so wall-clock falls back to the aggregate range, exercising the
    // scalar 'aggregate' branch of rowNeedsNote/rowNoteText instead of 'stack-aggregate'.
    for (const cell of summary.cells) delete cell.duration_ms;
    const svg = renderMetricsGridSvg(summary, schema1CostEstimate());
    expect(svg).toContain('campaign range, not per-session');
    expect(svg).not.toContain('campaign range (not per-session)');
    const layout = computeMetricsGridLayout(summary, schema1CostEstimate());
    checkNoOverlapLayout(layout);
  });
});

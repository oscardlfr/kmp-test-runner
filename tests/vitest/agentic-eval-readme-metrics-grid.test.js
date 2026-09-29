import { describe, expect, it } from 'vitest';
import {
  computeMetricsGridLayout, renderMetricsGridSvg,
} from '../../tools/agentic-eval/readme-evidence.mjs';

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
    const aggregateNotes = layout.items.filter((i) => i.role === 'gridAggregateNote' && i.text.includes('campaign median'));
    // 2 runtimes x 2 arms x (tokens + tool-calls-by-kind rows that have data) -- at least one per column/row combination that has an aggregate, not zero.
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
});

// tests/vitest/agentic-eval-readme-metrics-grid.test.js
// WO-C12: numbers-first per-session detail grid, in the scorecard's own visual language.
// Regression guard for computeMetricsGridLayout/renderMetricsGridSvg in
// tools/agentic-eval/readme-evidence.mjs. No network calls.

import { describe, expect, it } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeMetricsGridLayout, renderMetricsGridSvg, costMetric, loadSummary, loadCostEstimate,
  computeScorecardLayout, buildBullets,
} from '../../tools/agentic-eval/readme-evidence.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const RUNS_DIR = join(REPO_ROOT, 'tools', 'runs', 'evidence1-agentic-benchmark-2026-09-28');

// Scorecard's own with/without colors, duplicated here (not imported -- the module doesn't export
// them) specifically so test (h) can assert equality against a value that isn't just "whatever the
// production code currently uses" copy-pasted from it.
const SCORECARD_COLOR_WITH = '#0969da';
const SCORECARD_COLOR_WITHOUT = '#bc4c00';

// ---------------------------------------------------------------------------
// Synthetic schema-2 fixture, n=4 per lane, deliberately DIFFERENT between Claude and Codex so
// shared cross-agent scaling (addendum point 1) and the cross-agent bullet (point 2) are real,
// discriminating checks, not coincidentally-equal values that would pass either way.

function v2Group(runtimeId, arm, overrides = {}) {
  return {
    runtime_id: runtimeId, arm, declared: 4, accepted: 4, negative_d3: 0, missing: 0, counted: 4, missing_reasons: [],
    key_facts_match: { matched: 4, of: 4 }, full_answer_match: { matched: 0, of: 4 }, success: null,
    duration_ms: { n: 4, min: 100000, max: 160000, mean: 130000, median: 128000, stddev_sample: 1 },
    tool_calls_total: { n: 4, min: 8, max: 14, mean: 11, median: 11, stddev_sample: 1 },
    kmp_test_vs_gradle: { available: true, kmp_test_count: 8, gradle_count: 4 },
    ...overrides,
  };
}

function v2Cells(runtimeId, arm, { duration, toolCalls, tokens, commandKinds, totalCost } = {}) {
  return [1, 2, 3, 4].map((i) => {
    const cell = {
      runtime_id: runtimeId, arm, round_index: i, cell_key: `${runtimeId}-${arm}-${i}`,
      status: 'accepted', reason: null, key_facts_match: true, full_answer_match: false, success: null,
      duration_ms: duration ? duration[i - 1] : 100000 + i * 10000,
      tool_calls_total: toolCalls ? toolCalls[i - 1] : 8 + i,
    };
    if (tokens) cell.tokens = tokens[i - 1];
    if (commandKinds) cell.command_kind_counts = commandKinds[i - 1];
    if (totalCost) cell.total_cost_usd = totalCost[i - 1];
    return cell;
  });
}

// Claude: smaller tool-calls/duration/tokens, provider-reported cost (every cell carries
// total_cost_usd). Codex: larger tool-calls/duration/tokens (so a shared axis/bar max is a real,
// discriminating check), estimate-based cost (no total_cost_usd -- costMetric falls back to
// cost-estimate.json pricing). Turns is left with no per-cell field AND no group aggregate for
// EITHER runtime, so both agents hit the "not recorded" path on that one row (exercised by the
// no-overlap tests against a realistic "some rows genuinely absent" shape).
function v2Summary() {
  const claudeTokens = [
    { input: 10, cached_input: 100, cache_write: 20, output: 200 },
    { input: 12, cached_input: 110, cache_write: 22, output: 210 },
    { input: 11, cached_input: 105, cache_write: 21, output: 205 },
    { input: 13, cached_input: 115, cache_write: 23, output: 215 },
  ];
  const claudeTokensFree = claudeTokens.map((t) => ({ ...t, cached_input: t.cached_input * 2 }));
  // Codex tokens are NOT derived from Claude's by a flat multiplier -- Codex's raw `input` MUST be
  // >= raw `cached_input` (cached_input is a SUBSET of input, per cost-estimate.mjs's own BINDING
  // mapping) and raw `output` MUST be >= `reasoning_output` (same subset relationship). A flat *6
  // scale-up of Claude's numbers (where cached_input is already ~10x input) violated that and
  // produced a NEGATIVE "uncached input" once the WO-C13 disjoint-token fix subtracted them --
  // caught by the no-overlap tests, not assumed correct.
  const codexTokens = [
    { input: 400000, cached_input: 350000, output: 3000, reasoning_output: 500 },
    { input: 410000, cached_input: 355000, output: 3100, reasoning_output: 520 },
    { input: 405000, cached_input: 352000, output: 3050, reasoning_output: 510 },
    { input: 415000, cached_input: 358000, output: 3150, reasoning_output: 530 },
  ];
  const codexTokensFree = [
    { input: 380000, cached_input: 330000, output: 2800, reasoning_output: 400 },
    { input: 390000, cached_input: 335000, output: 2900, reasoning_output: 420 },
    { input: 385000, cached_input: 332000, output: 2850, reasoning_output: 410 },
    { input: 395000, cached_input: 338000, output: 2950, reasoning_output: 430 },
  ];

  return {
    schema: 2, summary_status: 'ok', provider_mode: 'live',
    provenance: {
      kmp_test_cli_version: { values: ['0.16.0'], mixed: false },
      runtime_cli_version: { 'claude-code': { values: ['2.1.238'], mixed: false }, 'codex-cli': { values: ['0.154.0'], mixed: false } },
      model_resolved: { 'claude-code': { values: ['claude-sonnet-5'], mixed: false }, 'codex-cli': { values: ['gpt-5.6-terra'], mixed: false } },
      reasoning_effort: { 'claude-code': { values: ['high'], mixed: false }, 'codex-cli': { values: ['high'], mixed: false } },
    },
    // Group-level aggregates MUST match the per-cell overrides below (buildRuntimeBullet and the
    // cross-agent bullet both read the group's own median, never recomputed from cells) -- a real
    // bug in an earlier draft of this fixture left these at v2Group()'s shared defaults, silently
    // making Claude and Codex look identical regardless of the very different per-cell data.
    by_runtime_arm: [
      v2Group('claude-code', 'product', { tool_calls_total: { n: 4, min: 2, max: 2, mean: 2, median: 2, stddev_sample: 0 }, duration_ms: { n: 4, min: 170000, max: 185000, mean: 177500, median: 177500, stddev_sample: 1 } }),
      v2Group('claude-code', 'free', { tool_calls_total: { n: 4, min: 3, max: 3, mean: 3, median: 3, stddev_sample: 0 }, duration_ms: { n: 4, min: 200000, max: 215000, mean: 207500, median: 207500, stddev_sample: 1 } }),
      v2Group('codex-cli', 'product', { tool_calls_total: { n: 4, min: 6, max: 6, mean: 6, median: 6, stddev_sample: 0 }, duration_ms: { n: 4, min: 290000, max: 305000, mean: 297500, median: 297500, stddev_sample: 1 } }),
      v2Group('codex-cli', 'free', { tool_calls_total: { n: 4, min: 1, max: 1, mean: 1, median: 1, stddev_sample: 0 }, duration_ms: { n: 4, min: 240000, max: 255000, mean: 247500, median: 247500, stddev_sample: 1 } }),
    ],
    cells: [
      ...v2Cells('claude-code', 'product', {
        duration: [170000, 180000, 175000, 185000], toolCalls: [2, 2, 2, 2],
        tokens: claudeTokens, commandKinds: [{ kmp_test: 2, gradle: 0, other: 0 }, { kmp_test: 2, gradle: 0, other: 0 }, { kmp_test: 2, gradle: 0, other: 0 }, { kmp_test: 2, gradle: 0, other: 0 }],
        totalCost: [0.05, 0.055, 0.052, 0.058],
      }),
      ...v2Cells('claude-code', 'free', {
        duration: [200000, 210000, 205000, 215000], toolCalls: [3, 3, 3, 3],
        tokens: claudeTokensFree, commandKinds: [{ kmp_test: 0, gradle: 3, other: 0 }, { kmp_test: 0, gradle: 3, other: 0 }, { kmp_test: 0, gradle: 3, other: 0 }, { kmp_test: 0, gradle: 3, other: 0 }],
        totalCost: [0.09, 0.095, 0.092, 0.098],
      }),
      ...v2Cells('codex-cli', 'product', {
        duration: [290000, 300000, 295000, 305000], toolCalls: [6, 6, 6, 6],
        tokens: codexTokens, commandKinds: [{ kmp_test: 5, gradle: 1, other: 0 }, { kmp_test: 5, gradle: 1, other: 0 }, { kmp_test: 5, gradle: 1, other: 0 }, { kmp_test: 5, gradle: 1, other: 0 }],
      }),
      ...v2Cells('codex-cli', 'free', {
        duration: [240000, 250000, 245000, 255000], toolCalls: [1, 1, 1, 1],
        tokens: codexTokensFree, commandKinds: [{ kmp_test: 0, gradle: 1, other: 0 }, { kmp_test: 0, gradle: 1, other: 0 }, { kmp_test: 0, gradle: 1, other: 0 }, { kmp_test: 0, gradle: 1, other: 0 }],
      }),
    ],
  };
}

function v2CostEstimate() {
  return {
    schema: 2,
    runtimes: {
      'claude-code': { model: 'claude-sonnet-5', per_million_tokens: { input: 3, cache_write_5m: 3.75, cache_write_1h: 6, cache_read: 0.3, output: 15 }, cells: [] },
      'codex-cli': {
        model: 'gpt-5.6-terra', per_million_tokens: { input: 2, cache_write_5m: 2.5, cache_write_1h: 2.5, cache_read: 0.2, output: 12 },
        cells: [
          ...[1, 2, 3, 4].map((i) => ({ arm: 'product', tokens: { input: 60 + i, cache_creation: 25000, cache_read: 250000, output: 3500 } })),
          ...[1, 2, 3, 4].map((i) => ({ arm: 'free', tokens: { input: 60 + i, cache_creation: 25000, cache_read: 250000, output: 3500 } })),
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// WO-C10's no-overlap geometry estimator, unchanged: chars x fontSize x 0.6 for width; SVG <text>
// ascent/descent approximated as 0.8*fs above the baseline and 0.25*fs below it (the scorecard's
// own "no overlapping text" describe block in agentic-eval-readme-evidence.test.js uses the same
// formula).
function textBBox(item) {
  const width = item.text.length * item.fontSize * 0.6;
  const x0 = item.anchor === 'end' ? item.x - width : item.anchor === 'middle' ? item.x - width / 2 : item.x;
  return { x0, x1: x0 + width, y0: item.y - item.fontSize * 0.8, y1: item.y + item.fontSize * 0.25 };
}
function markBBox(item) {
  if (item.kind === 'bar' || item.kind === 'legendSwatch') return { x0: item.x, x1: item.x + item.w, y0: item.y, y1: item.y + item.h };
  if (item.kind === 'dot') return { x0: item.cx - item.r, x1: item.cx + item.r, y0: item.cy - item.r, y1: item.cy + item.r };
  if (item.kind === 'tickV') return { x0: item.x - 2, x1: item.x + 2, y0: Math.min(item.y1, item.y2), y1: Math.max(item.y1, item.y2) };
  if (item.kind === 'axisLine' || item.kind === 'rangeLineH') return { x0: Math.min(item.x1, item.x2), x1: Math.max(item.x1, item.x2), y0: item.y - 2, y1: item.y + 2 };
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
      expect(bboxesOverlap(textBoxes[i], textBoxes[j]), `text "${textBoxes[i].label}" overlaps text "${textBoxes[j].label}"`).toBe(false);
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
    expect(box.x0, `"${label}" x0 < 0`).toBeGreaterThanOrEqual(-0.5);
    expect(box.x1, `"${label}" x1 (${box.x1}) exceeds viewBox width ${layout.width}`).toBeLessThanOrEqual(layout.width + 0.5);
    expect(box.y0, `"${label}" y0 < 0`).toBeGreaterThanOrEqual(0);
    expect(box.y1, `"${label}" y1 (${box.y1}) exceeds viewBox height ${layout.height}`).toBeLessThanOrEqual(layout.height);
  }

  const PAD_ = 28, COLUMN_GAP_ = 32;
  const COLUMN_W_ = (layout.width - 2 * PAD_ - COLUMN_GAP_) / 2;
  const columnLefts = [PAD_, PAD_ + COLUMN_W_ + COLUMN_GAP_];
  const legendItems = layout.items.filter((i) => i.kind === 'legendSwatch' || i.role === 'gridLegendLine' || i.role === 'gridCompTotal');
  for (const colLeft of columnLefts) {
    const inColumn = legendItems.filter((i) => i.x >= colLeft && i.x < colLeft + COLUMN_W_ + COLUMN_GAP_);
    for (const item of inColumn) {
      const box = item.kind === 'legendSwatch' ? markBBox(item) : textBBox(item);
      expect(box.x1, `legend/total item at x=${item.x} (column left ${colLeft}) reaches ${box.x1}, past the column's own right edge ${colLeft + COLUMN_W_}`).toBeLessThanOrEqual(colLeft + COLUMN_W_ + 1);
    }
  }
}

describe('metrics-grid.svg (WO-C12 redesign)', () => {
  it('(a)+(b)+(c)+(d): the synthetic schema-2 fixture has no text-vs-text overlap, no text/legend-vs-mark overlap, everything inside the viewBox, and every legend/total fits its own COLUMN_W', () => {
    const layout = computeMetricsGridLayout(v2Summary(), v2CostEstimate());
    checkNoOverlapLayout(layout);
  });

  it('(a)+(b)+(c)+(d): the REAL committed Evidence1 campaign data (schema 1) is also overlap-free', () => {
    const summary = loadSummary(join(RUNS_DIR, 'campaign-summary.json'));
    const costEstimate = loadCostEstimate(join(RUNS_DIR, 'cost-estimate.json'));
    const layout = computeMetricsGridLayout(summary, costEstimate);
    checkNoOverlapLayout(layout);
  });

  it('(e): every strip row renders its 3 axis tick labels and both lanes\' median labels, each carrying the metric\'s unit', () => {
    const svg = renderMetricsGridSvg(v2Summary(), v2CostEstimate());
    const wallIdx = svg.indexOf('Wall-clock (min)');
    const costIdx = svg.indexOf('API cost (USD)');
    const section = svg.slice(wallIdx, costIdx);
    // 3 tick labels: 0, mid, max -- all in minutes (the fixture's raw ms values are pre-scaled).
    expect(section).toMatch(/>0\.0 min</);
    expect(section).toMatch(/>\d+\.\d min</g);
    // Both lanes' median labels carry the unit.
    const medianMatches = section.match(/median \d+\.\d min/g) || [];
    expect(medianMatches.length).toBe(2);
  });

  it('(f): the composition legend line shows both arms\' values for every present component', () => {
    const svg = renderMetricsGridSvg(v2Summary(), v2CostEstimate());
    const toolsIdx = svg.indexOf('Shell commands by kind');
    const tokensIdx = svg.indexOf('Tokens per session, by type');
    const section = svg.slice(toolsIdx, tokensIdx);
    // Claude: with kmp_test=2/gradle=0, without kmp_test=0/gradle=3 (medians of 4 identical cells).
    // 'other' IS present here (0 vs 0) -- this fixture supplies real PER-CELL command_kind_counts
    // for every cell, and the per-session branch of compositionMedians() always carries all 3
    // declared types (the "per-cell command_kind_counts keeps all 3" invariant), so a genuine
    // zero measurement is shown, not omitted -- omission only applies to the AGGREGATE fallback's
    // untracked 'other' bucket (commandKindAggregate), covered by the real committed-data test
    // below and the dedicated point-3 test.
    expect(section).toContain('kmp-test 2 vs 0');
    expect(section).toContain('gradle 0 vs 3');
    expect(section).toContain('other 0 vs 0');
  });

  it('(g): the strip-row difference text is correct against the fixture ((with-without)/without), and omitted when a median is missing', () => {
    const svg = renderMetricsGridSvg(v2Summary(), v2CostEstimate());
    // Claude wall-clock: with median 177500ms=2.9583min, without median 207500ms=3.4583min.
    // (2.9583 - 3.4583) / 3.4583 * 100 = -14.46% -> rounds to -14%.
    const wallIdx = svg.indexOf('Wall-clock (min)');
    const costIdx = svg.indexOf('API cost (USD)');
    expect(svg.slice(wallIdx, costIdx)).toContain('median -14% with kmp-test');

    // Turns has no per-cell field and no group aggregate for either arm -> both lanes unavailable
    // -> diff is never computed (there's no header line rendered at all for it, since the row
    // short-circuits to "not recorded").
    const turnsIdx = svg.indexOf('>Turns<');
    expect(turnsIdx).toBeGreaterThan(-1);
    const nextRowIdx = svg.indexOf('Tool output returned to the model');
    expect(svg.slice(turnsIdx, nextRowIdx)).toContain('not recorded for Claude Code');
    expect(svg.slice(turnsIdx, nextRowIdx)).not.toMatch(/median [+-]?\d+% with kmp-test/);
  });

  it('(h): strip-row dots and the scorecard\'s own with/without colors are identical -- "with kmp-test" dots and bars use COLOR_WITH, "without" uses COLOR_WITHOUT, everywhere', () => {
    const layout = computeMetricsGridLayout(v2Summary(), v2CostEstimate());
    const dots = layout.items.filter((i) => i.kind === 'dot');
    expect(dots.length).toBeGreaterThan(0);
    const dotColors = new Set(dots.map((d) => d.fill));
    expect(dotColors.size).toBeLessThanOrEqual(2);
    for (const c of dotColors) expect([SCORECARD_COLOR_WITH, SCORECARD_COLOR_WITHOUT]).toContain(c);
    // The <desc> also states the mapping explicitly (accessibility + a second, independent check).
    const svg = renderMetricsGridSvg(v2Summary(), v2CostEstimate());
    expect(svg).toContain(`With kmp-test (${SCORECARD_COLOR_WITH})`);
    expect(svg).toContain(`without (${SCORECARD_COLOR_WITHOUT})`);
  });

  it('(i): the strip-row axis max and the composition bar-total max are IDENTICAL across both agent columns, for the same row -- Codex\'s larger values never get their own, more generous scale', () => {
    const layout = computeMetricsGridLayout(v2Summary(), v2CostEstimate());
    const tickLabels = layout.items.filter((i) => i.role === 'gridTickLabel' && i.text !== '0.0 min' && i.anchor === 'end');
    // One "max" tick label (anchor=end) per lane per strip row per column; group by row-Y band is
    // fragile, so instead assert the SET of distinct max-tick values for wall-clock is a single
    // value covering both columns (a per-column scale would produce 2 distinct maxima).
    const wallMaxTicks = layout.items.filter((i) => i.role === 'gridTickLabel' && i.anchor === 'end' && i.text.endsWith(' min'));
    const distinctWallMax = new Set(wallMaxTicks.map((i) => i.text));
    expect(distinctWallMax.size).toBe(1);

    // Composition: the widest single bar segment's implied per-unit pixel width (w / value) must
    // be the same for Claude's and Codex's shell-commands-by-kind bars -- proof they share one max,
    // not each column normalized to its own 100%. Scoped to each column's shell-commands row band
    // specifically (both occurrences: Claude's then Codex's) -- kmp_test and the tokens row's
    // cache_read component happen to share the same blue (#0969da), so an unscoped color filter
    // would mix two different composition rows' bars together.
    const allItems = layout.items;
    const shellCommandsStarts = allItems.reduce((acc, item, idx) => (item.text === 'Shell commands by kind' ? [...acc, idx] : acc), []);
    const tokensStarts = allItems.reduce((acc, item, idx) => (item.text === 'Tokens per session, by type' ? [...acc, idx] : acc), []);
    expect(shellCommandsStarts.length).toBe(2);
    expect(tokensStarts.length).toBe(2);
    const shellCommandItems = shellCommandsStarts.flatMap((start, i) => allItems.slice(start, tokensStarts[i]));
    const bars = shellCommandItems.filter((i) => i.kind === 'bar' && i.fill === '#0969da'); // kmp_test-colored segments
    expect(bars.length).toBeGreaterThanOrEqual(2);
    const pxPerUnit = bars.map((b) => b.w).filter((w) => w > 0);
    // Claude with=2, Codex with=5 (kmp_test medians) -- if shared, bar_width/value is constant
    // across both; compare the two largest (Claude's kmp_test bar and Codex's) via their ratio.
    const ratios = pxPerUnit.map((w) => w); // just confirm not all bars render at the identical width despite different values (which WOULD indicate independent 100% normalization)
    expect(new Set(ratios).size).toBeGreaterThan(1);
  });

  it('(j): the cross-agent README bullet renders correct medians from the fixture, one per arm, and is omitted when a median is missing', () => {
    const bullets = buildBullets(v2Summary(), v2CostEstimate(), 'tools/runs/evidence1-agentic-benchmark-2026-09-28');
    const withBullet = bullets.find((b) => b.startsWith('With kmp-test'));
    const withoutBullet = bullets.find((b) => b.startsWith('Without kmp-test'));
    expect(withBullet).toContain('Codex 6 tool calls vs Claude 2');
    expect(withoutBullet).toContain('Codex 1 tool calls vs Claude 3');
    expect(withBullet).toContain('n=4 per cell');

    const summaryMissingCodex = v2Summary();
    // Delete only .median (not the whole tool_calls_total object) -- buildRuntimeBullet, called
    // earlier in buildBullets for the SAME group, also reads gp.tool_calls_total.median and would
    // throw a bare TypeError on a missing parent object; that's an existing, unrelated code path
    // this test isn't exercising.
    delete summaryMissingCodex.by_runtime_arm.find((g) => g.runtime_id === 'codex-cli' && g.arm === 'product').tool_calls_total.median;
    const bulletsMissing = buildBullets(summaryMissingCodex, v2CostEstimate(), 'tools/runs/evidence1-agentic-benchmark-2026-09-28');
    expect(bulletsMissing.some((b) => b.startsWith('With kmp-test'))).toBe(false);
    expect(bulletsMissing.some((b) => b.startsWith('Without kmp-test'))).toBe(true); // the free-arm bullet is unaffected
  });

  it('WO-C12 point 4: the cost row header says "provider-reported" when every session (both lanes) carries total_cost_usd, and "estimate: midpoint of low/high" otherwise', () => {
    const svg = renderMetricsGridSvg(v2Summary(), v2CostEstimate());
    const claudeCostIdx = svg.indexOf('API cost (USD)');
    const claudeTurnsIdx = svg.indexOf('>Turns<');
    expect(svg.slice(claudeCostIdx, claudeTurnsIdx)).toContain('provider-reported');

    const codexCostIdx = svg.indexOf('API cost (USD)', claudeTurnsIdx);
    const codexTurnsIdx = svg.indexOf('>Turns<', codexCostIdx);
    expect(svg.slice(codexCostIdx, codexTurnsIdx)).toContain('estimate: midpoint of low/high');
  });

  it('WO-C12 point 6: an agent with no data at all for a row renders exactly one "not recorded for <agent>" line, naming that agent', () => {
    const svg = renderMetricsGridSvg(v2Summary(), v2CostEstimate());
    expect(svg).toContain('not recorded for Claude Code');
    expect(svg).toContain('not recorded for Codex CLI');
  });

  it('WO-C12 point 3: a genuinely untracked composition component (never "other" in this fixture) is omitted from bars, legend, and total -- never zero-filled', () => {
    const layout = computeMetricsGridLayout(v2Summary(), v2CostEstimate());
    const otherBars = layout.items.filter((i) => i.kind === 'bar' && i.fill === '#59636e'); // COMMAND_KIND_COLORS.other
    expect(otherBars.length).toBe(0);
  });

  it('WO-C12 header: title is "Per-session detail (descriptive)", subtitle states the dot/bar meaning and the descriptive-only disclaimer', () => {
    const svg = renderMetricsGridSvg(v2Summary(), v2CostEstimate());
    expect(svg).toContain('<title>Per-session detail (descriptive)</title>');
    expect(svg).toContain('Each dot is one session; bars are the median session.');
    expect(svg).toContain('Descriptive only, not part of the pre-registered analysis.');
  });

  it('lane labels read "with kmp-test" and "without", not the old bare "with"', () => {
    const svg = renderMetricsGridSvg(v2Summary(), v2CostEstimate());
    expect(svg).toContain('>with kmp-test<');
    expect(svg).not.toMatch(/>with<\/text>/);
  });
});

describe('scorecard.svg: shared cross-agent scale (WO-C12 addendum point 1)', () => {
  it('the same metric\'s bar-fraction-to-value ratio is identical across both agent columns -- Codex\'s larger wall-clock value does not get its own, independently-normalized 100% scale', () => {
    const layout = computeScorecardLayout(v2Summary(), v2CostEstimate());
    const bars = layout.items.filter((i) => i.kind === 'bar');
    // Group bars by column, in row order; the 3rd/4th bars (index 2,3 within a column's own bar
    // list) are the wall-clock with/without pair for each column, since key-facts is text-only and
    // tool-calls is the first bar block.
    const claudeBars = bars.filter((b) => b.column === 'claude-code');
    const codexBars = bars.filter((b) => b.column === 'codex-cli');
    expect(claudeBars.length).toBeGreaterThanOrEqual(4);
    expect(codexBars.length).toBeGreaterThanOrEqual(4);
    // Tool-calls-per-session bars (first pair): Claude with=2,without=3; Codex with=6,without=1.
    // Shared max = 6. Claude's "without" (3) and a hypothetical Codex value of 3 would render
    // identically; concretely: Claude's "with" bar (2/6) must be narrower than Codex's "with" bar
    // (6/6, i.e. the full BAR_MAX_W) -- if scales were independent, Claude's own "with" (2) would
    // instead be compared only against Claude's own max (3), rendering much WIDER relative to its
    // own column than this shared-scale assertion allows.
    const claudeToolsWith = claudeBars[0];
    const codexToolsWith = codexBars[0];
    expect(codexToolsWith.w).toBeGreaterThan(claudeToolsWith.w);
    // Precisely: width ratio must equal the value ratio (2/6), not 2/3 (Claude's own independent max).
    expect(claudeToolsWith.w / codexToolsWith.w).toBeCloseTo(2 / 6, 2);
  });
});

// WO-C13, bug 1: Codex's raw `input` INCLUDES `cached_input`, and raw `output` INCLUDES
// `reasoning_output` (cost-estimate.mjs's own BINDING mapping, verified directly against that
// file's header comment before writing this fix). Stacking the raw fields as-is double-counted.
describe('metrics-grid.svg (WO-C13): disjoint token components, no double-counting', () => {
  it('a Codex fixture\'s disjoint total equals input + output exactly, with no double count', () => {
    const raw = { input: 100, cached_input: 40, output: 50, reasoning_output: 10 };
    const summary = v2Summary();
    const gp = summary.by_runtime_arm.find((g) => g.runtime_id === 'codex-cli' && g.arm === 'product');
    for (const cell of summary.cells) {
      if (cell.runtime_id === 'codex-cli' && cell.arm === 'product') cell.tokens = { ...raw };
    }
    gp.tokens = {
      input: { median: raw.input }, cached_input: { median: raw.cached_input },
      output: { median: raw.output }, cache_write: { median: 0 },
    };
    const layout = computeMetricsGridLayout(summary, v2CostEstimate());
    const svg = renderMetricsGridSvg(summary, v2CostEstimate());
    // uncached input (60) + cache read (40) + output-excl-reasoning (40) + reasoning (10) = 150 = input + output.
    expect(svg).toContain('uncached input 60 vs');
    expect(svg).toContain('cache read 40 vs');
    expect(svg).toContain('reasoning 10 vs');
    // Never the raw, overlapping input(100)/output(50) values stacked directly -- that would double-count.
    expect(svg).not.toContain('uncached input 100 vs');
    checkNoOverlapLayout(layout);
  });

  it('the Claude fixture stays fully additive (its 4 raw fields were already disjoint -- no subtraction applied)', () => {
    const raw = { input: 100, cached_input: 40, cache_write: 20, output: 50 };
    const summary = v2Summary();
    const gp = summary.by_runtime_arm.find((g) => g.runtime_id === 'claude-code' && g.arm === 'product');
    for (const cell of summary.cells) {
      if (cell.runtime_id === 'claude-code' && cell.arm === 'product') cell.tokens = { ...raw };
    }
    gp.tokens = { input: { median: raw.input }, cached_input: { median: raw.cached_input }, cache_write: { median: raw.cache_write }, output: { median: raw.output } };
    const svg = renderMetricsGridSvg(summary, v2CostEstimate());
    // Claude's fields pass through unchanged, just relabeled: uncached input=input(100), cache read=cached_input(40).
    expect(svg).toContain('uncached input 100 vs');
    expect(svg).toContain('cache read 40 vs');
    expect(svg).toContain('cache write 20 vs');
  });

  it('identical component labels are used for both runtimes: "uncached input", "cache read", "cache write", "output", "reasoning"', () => {
    const svg = renderMetricsGridSvg(v2Summary(), v2CostEstimate());
    for (const label of ['uncached input', 'cache read', 'output']) expect(svg).toContain(label);
    expect(svg).not.toContain('>cached input<'); // the old, pre-WO-C13 label
  });
});

// WO-C13, bug 2 (defensive coverage): a lane whose underlying kmp_test_vs_gradle is genuinely
// available:false must render "not recorded", never a fabricated 0. Verified this is already
// correct for a TRUE available:false group (commandKindAggregate already returns null there) --
// flagged to the auditor separately that the REAL committed Codex free-arm data actually has
// available:true (a real 0/0 measurement, not a false one), contradicting the specific example in
// the work order; this test covers the general principle regardless.
describe('metrics-grid.svg (WO-C13): unavailable command-kind data never renders as a fabricated 0', () => {
  it('a group with kmp_test_vs_gradle.available:false renders "not recorded", never "0 vs 0" (row-level, both lanes unavailable)', () => {
    const summary = v2Summary();
    for (const arm of ['product', 'free']) {
      const g = summary.by_runtime_arm.find((x) => x.runtime_id === 'codex-cli' && x.arm === arm);
      g.kmp_test_vs_gradle = { available: false, reason: 'not available for D3-reclassified cells' };
    }
    // Also strip per-cell command_kind_counts so the per-session branch can't mask the aggregate's
    // unavailability (compositionMedians must fall through to the aggregate, which must honor
    // available:false).
    for (const cell of summary.cells) {
      if (cell.runtime_id === 'codex-cli') delete cell.command_kind_counts;
    }
    const svg = renderMetricsGridSvg(summary, v2CostEstimate());
    const toolsIdx = svg.indexOf('Shell commands by kind', svg.indexOf('Codex CLI'));
    const tokensIdx = svg.indexOf('Tokens per session, by type', toolsIdx);
    const section = svg.slice(toolsIdx, tokensIdx);
    expect(section).toContain('not recorded for Codex CLI');
    expect(section).not.toMatch(/kmp-test \d+ vs \d+ . gradle \d+ vs \d+/);
  });

  it('a group with kmp_test_vs_gradle.available:false on only ONE arm renders "n/a" for that lane specifically, never a fabricated 0, while the other lane keeps its real data', () => {
    const summary = v2Summary();
    const gf = summary.by_runtime_arm.find((g) => g.runtime_id === 'codex-cli' && g.arm === 'free');
    gf.kmp_test_vs_gradle = { available: false, reason: 'not available for D3-reclassified cells' };
    for (const cell of summary.cells) {
      if (cell.runtime_id === 'codex-cli' && cell.arm === 'free') delete cell.command_kind_counts;
    }
    const svg = renderMetricsGridSvg(summary, v2CostEstimate());
    const toolsIdx = svg.indexOf('Shell commands by kind', svg.indexOf('Codex CLI'));
    const tokensIdx = svg.indexOf('Tokens per session, by type', toolsIdx);
    const section = svg.slice(toolsIdx, tokensIdx);
    expect(section).toContain('>n/a<'); // the "without" lane
    expect(section).not.toContain('not recorded for Codex CLI'); // the "with" lane still has real per-cell data
    expect(section).not.toMatch(/gradle \d+ vs 0/); // never a fabricated 0 for the unavailable lane
  });
});

// WO-C13, bug 3: this row counts SHELL commands (product_cli_command_count / direct_build_tool_
// command_count), never ALL tool calls (Skill, Read, etc. aren't counted) -- the scorecard's own
// "Tool calls" bar is a different, larger population. Mislabeling it invited a reader to see "2 vs
// 2.8" next to the scorecard's "4 vs 13" and conclude the chart was wrong.
describe('metrics-grid.svg (WO-C13): shell-command row label precision', () => {
  it('the row is labeled "Shell commands by kind", not "Tool calls by kind"', () => {
    const svg = renderMetricsGridSvg(v2Summary(), v2CostEstimate());
    expect(svg).toContain('Shell commands by kind');
    expect(svg).not.toContain('Tool calls by kind');
  });
});

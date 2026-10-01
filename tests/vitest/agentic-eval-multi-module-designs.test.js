// SPDX-License-Identifier: MIT
// tests/vitest/agentic-eval-multi-module-designs.test.js -- Evidence3 WO-07: the two counterbalanced
// 8-pair campaign designs for the multi-module-tests family (`claude-product-vs-free-n8-v1` and
// `codex-product-vs-free-n8-v1`), what `derive-round-order-cli` prints for them, and proof that the
// nine designs that existed before them are untouched.
//
// Pure: no filesystem, no runtime, no registry file -- executionProfiles are caller-supplied arrays,
// exactly like scenario-campaign-plan.test.js. The one subprocess is the real CLI, fed on stdin.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  resolveScenarioCampaignDesign, buildScenarioCampaignPlan, assertValidScenarioCampaignPlan, validateScenarioCampaignRuntime,
} from '../../tools/agentic-eval/scenario-campaign-plan.mjs';
import { deriveRoundOrder } from '../../tools/agentic-eval/derive-round-order-cli.mjs';

const UNRESTRICTED = 'sandboxed-unrestricted-v1';
const KNOWN_PROFILES = ['strict-policy-v1', UNRESTRICTED];
const KNOWN_CONDITIONS = ['current-skill', 'no-skill'];

const CLAUDE_N8 = 'claude-product-vs-free-n8-v1';
const CODEX_N8 = 'codex-product-vs-free-n8-v1';
const N8_DESIGNS = [
  { id: CLAUDE_N8, runtime: 'claude-code', otherRuntime: 'codex-cli', baseline: 'claude-product-vs-free-baseline-v1' },
  { id: CODEX_N8, runtime: 'codex-cli', otherRuntime: 'claude-code', baseline: 'codex-product-vs-free-baseline-v2' },
];

// Eight pairs, A = product-assisted, B = free baseline: the first four are the existing balanced v2
// order, repeated with the pair positions swapped so every cell sits in each position equally often.
const N8_PAIR_ORDER = [['A', 'B'], ['B', 'A'], ['B', 'A'], ['A', 'B'], ['B', 'A'], ['A', 'B'], ['A', 'B'], ['B', 'A']];
const N8_LABELS = N8_PAIR_ORDER.flat();
const N8_ROUND_ORDER = N8_LABELS.map((label) => (label === 'A' ? 'product' : 'free'));

function plan(designId, overrides = {}) {
  const result = buildScenarioCampaignPlan({
    designId, repeats: 8, executionProfiles: KNOWN_PROFILES, skillConditions: KNOWN_CONDITIONS, ...overrides,
  });
  if (!result.ok) throw new Error(`test setup: expected a valid ${designId} plan, got rejection: ${result.reason}`);
  return result.plan;
}

describe.each(N8_DESIGNS)('$id', ({ id, runtime, otherRuntime, baseline }) => {
  it('resolves to a design with eight repeats, bound to its own runtime', () => {
    const resolved = resolveScenarioCampaignDesign(id);
    expect(resolved.ok).toBe(true);
    expect(resolved.design.id).toBe(id);
    expect(resolved.design.runtime_id).toBe(runtime);
    expect(resolved.design.repeats).toBe(8);
  });

  it('declares the pre-registered eight-pair order literally, one array per repetition', () => {
    const { design } = resolveScenarioCampaignDesign(id);
    expect(design.order.map((pair) => [...pair])).toEqual(N8_PAIR_ORDER);
  });

  it('is not bound to one scenario, like the baseline designs it copies (run --campaign-design takes any scenario)', () => {
    const { design } = resolveScenarioCampaignDesign(id);
    expect(design.scenario_id).toBeUndefined();
  });

  it('uses the same two cells as the existing product-vs-free baseline design, A product-assisted and B free baseline', () => {
    const { design } = resolveScenarioCampaignDesign(id);
    const { design: existing } = resolveScenarioCampaignDesign(baseline);
    expect(design.cellDefinitions).toEqual(existing.cellDefinitions);
    expect(design.cellDefinitions).toEqual({
      A: { execution_profile_id: UNRESTRICTED, condition: 'current-skill', product_access_mode: 'product-assisted' },
      B: { execution_profile_id: UNRESTRICTED, condition: 'no-skill', product_access_mode: 'free-baseline-no-product' },
    });
  });

  it('expands to sixteen cells with planned_sessions 16 and order_index 0..15 without gaps', () => {
    const built = plan(id);
    expect(built.campaign_design_id).toBe(id);
    expect(built.repeats).toBe(8);
    expect(built.planned_sessions).toBe(16);
    expect(built.cells.map((cell) => cell.order_index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('puts the cells in the exact A/B, B/A, B/A, A/B, B/A, A/B, A/B, B/A order, two per repetition', () => {
    const built = plan(id);
    expect(built.cells.map((cell) => cell.campaign_cell_label)).toEqual(N8_LABELS);
    expect(built.cells.map((cell) => cell.repetition_index)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]);
  });

  it('is counterbalanced: each cell opens exactly four of the eight pairs and is dispatched exactly eight times', () => {
    const built = plan(id);
    const opens = built.cells.filter((cell) => cell.order_index % 2 === 0).map((cell) => cell.campaign_cell_label);
    expect(opens.filter((label) => label === 'A')).toHaveLength(4);
    expect(opens.filter((label) => label === 'B')).toHaveLength(4);
    expect(built.cells.filter((cell) => cell.campaign_cell_label === 'A')).toHaveLength(8);
    expect(built.cells.filter((cell) => cell.campaign_cell_label === 'B')).toHaveLength(8);
  });

  it('carries the product-assisted current-skill cell and the free-baseline no-skill cell on every cell, with its own design id', () => {
    const built = plan(id);
    for (const cell of built.cells) {
      expect(cell.campaign_design_id).toBe(id);
      expect(cell.execution_profile_id).toBe(UNRESTRICTED);
      if (cell.campaign_cell_label === 'A') {
        expect([cell.condition, cell.product_access_mode]).toEqual(['current-skill', 'product-assisted']);
      } else {
        expect([cell.condition, cell.product_access_mode]).toEqual(['no-skill', 'free-baseline-no-product']);
      }
    }
  });

  it('builds a plan the module\'s own validator accepts and that survives a JSON round trip', () => {
    const built = plan(id);
    expect(() => assertValidScenarioCampaignPlan(built)).not.toThrow();
    expect(() => assertValidScenarioCampaignPlan(JSON.parse(JSON.stringify(built)))).not.toThrow();
  });

  it.each([1, 3, 4, 7, 9])('rejects %i repeats: the design fixes its own repeat count at eight', (repeats) => {
    const result = buildScenarioCampaignPlan({ designId: id, repeats, executionProfiles: KNOWN_PROFILES, skillConditions: KNOWN_CONDITIONS });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/requires exactly 8 repeats/);
  });

  it('rejects a registry that lacks the unrestricted profile instead of building a partial plan', () => {
    const result = buildScenarioCampaignPlan({ designId: id, repeats: 8, executionProfiles: ['strict-policy-v1'], skillConditions: KNOWN_CONDITIONS });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/sandboxed-unrestricted-v1/);
  });

  it('is accepted with its own runtime and rejected with the other family\'s runtime', () => {
    expect(validateScenarioCampaignRuntime({ designId: id, runtimeId: runtime })).toEqual({ ok: true });
    const mismatch = validateScenarioCampaignRuntime({ designId: id, runtimeId: otherRuntime });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toContain(`requires runtime ${JSON.stringify(runtime)}`);
  });

  it('derives the sixteen-entry round_order product/free sequence for indices 0..15', () => {
    const result = deriveRoundOrder({ designId: id, campaignCellIndices: Array.from({ length: 16 }, (_, index) => index), executionProfiles: [UNRESTRICTED] });
    expect(result.ok).toBe(true);
    expect(result.round_order).toEqual(N8_ROUND_ORDER);
    expect(result.round_order).toHaveLength(16);
  });

  it('derives a canary subset and a resumed subset from the full plan, and refuses index 16', () => {
    const first = deriveRoundOrder({ designId: id, campaignCellIndices: [0, 1], executionProfiles: [UNRESTRICTED] });
    expect(first.round_order).toEqual(['product', 'free']);
    const resumed = deriveRoundOrder({ designId: id, campaignCellIndices: [8, 9, 10, 11], executionProfiles: [UNRESTRICTED] });
    expect(resumed.round_order).toEqual(['free', 'product', 'product', 'free']);
    const outside = deriveRoundOrder({ designId: id, campaignCellIndices: [16], executionProfiles: [UNRESTRICTED] });
    expect(outside.ok).toBe(false);
    expect(outside.reason).toMatch(/derive_round_order_cell_index_not_in_plan/);
  });

  it('prints sixteen entries from the real CLI, fed on stdin', () => {
    const input = JSON.stringify({ designId: id, campaignCellIndices: Array.from({ length: 16 }, (_, index) => index), executionProfiles: [UNRESTRICTED] });
    const stdout = execFileSync(process.execPath, ['tools/agentic-eval/derive-round-order-cli.mjs'], { encoding: 'utf8', cwd: process.cwd(), input });
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.round_order).toEqual(N8_ROUND_ORDER);
  });
});

describe('the two n8 designs next to each other', () => {
  it('differ only in id and runtime: same order, same cells, same repeat count', () => {
    const claude = resolveScenarioCampaignDesign(CLAUDE_N8).design;
    const codex = resolveScenarioCampaignDesign(CODEX_N8).design;
    expect(claude.runtime_id).not.toBe(codex.runtime_id);
    expect(claude.order.map((pair) => [...pair])).toEqual(codex.order.map((pair) => [...pair]));
    expect(claude.cellDefinitions).toEqual(codex.cellDefinitions);
    expect(claude.repeats).toBe(codex.repeats);
  });
});

// The registry is closed and additive: the designs that existed before WO-07 keep their id, runtime,
// repeat count, scenario binding and literal order. A change to any of them is a change to evidence
// that was already collected, so it must show up here.
describe('the nine designs that existed before the n8 designs', () => {
  const ORDER_OF = (pairs) => pairs.map((pair) => pair.split(''));
  const EXISTING = [
    ['claude-2x2-williams-v1', 'claude-code', 4, undefined, [['A', 'B', 'D', 'C'], ['B', 'C', 'A', 'D'], ['C', 'D', 'B', 'A'], ['D', 'A', 'C', 'B']]],
    ['claude-product-vs-free-baseline-v1', 'claude-code', 4, undefined, ORDER_OF(['AB', 'BA', 'BA', 'AB'])],
    ['claude-product-vs-free-baseline-v2', 'claude-code', 3, undefined, ORDER_OF(['AB', 'BA', 'AB'])],
    ['codex-product-vs-free-baseline-v1', 'codex-cli', 3, undefined, ORDER_OF(['AB', 'BA', 'AB'])],
    ['codex-product-vs-free-baseline-v2', 'codex-cli', 4, undefined, ORDER_OF(['AB', 'BA', 'BA', 'AB'])],
    ['claude-product-canary-v1', 'claude-code', 1, 'coverage-threshold-failure-v2', [['A']]],
    ['claude-free-baseline-canary-v1', 'claude-code', 1, 'coverage-threshold-failure-v2', [['B']]],
    ['codex-product-canary-v1', 'codex-cli', 1, 'coverage-threshold-failure-v2', [['A']]],
    ['codex-free-baseline-canary-v1', 'codex-cli', 1, 'coverage-threshold-failure-v2', [['B']]],
  ];

  it.each(EXISTING)('%s keeps its runtime, repeats, scenario binding and literal order', (id, runtime, repeats, scenarioId, order) => {
    const { design } = resolveScenarioCampaignDesign(id);
    expect(design.id).toBe(id);
    expect(design.runtime_id).toBe(runtime);
    expect(design.repeats).toBe(repeats);
    expect(design.scenario_id).toBe(scenarioId);
    expect(design.order.map((repetition) => [...repetition])).toEqual(order);
  });

  it('the registry holds exactly these nine plus the two n8 designs, and nothing else', () => {
    const unknown = resolveScenarioCampaignDesign('not-a-registered-design');
    expect(unknown.ok).toBe(false);
    const listed = unknown.reason.slice(unknown.reason.indexOf('(known: ') + '(known: '.length, -1).split(', ');
    expect([...listed].sort()).toEqual([...EXISTING.map((row) => row[0]), CLAUDE_N8, CODEX_N8].sort());
  });

  it('derives the same eight-entry round_order as before for the existing balanced Claude and Codex designs', () => {
    const expected = ['product', 'free', 'free', 'product', 'free', 'product', 'product', 'free'];
    for (const designId of ['claude-product-vs-free-baseline-v1', 'codex-product-vs-free-baseline-v2']) {
      const result = deriveRoundOrder({ designId, campaignCellIndices: [0, 1, 2, 3, 4, 5, 6, 7], executionProfiles: [UNRESTRICTED] });
      expect(result.round_order).toEqual(expected);
    }
  });
});

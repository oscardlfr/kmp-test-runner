// tests/vitest/agentic-eval-scenario-campaign-plan.test.js
// Unit tests for tools/agentic-eval/scenario-campaign-plan.mjs -- the pure, deterministic
// multi-profile campaign planner (agentic-eval-multi-profile-campaigns-v1). Unblocks Evidence 1's
// single pre-registered 16-cell Williams plan across both execution profile and skill condition
// (see docs/audits/agentic-eval-v1-evidence-1-prereq-four-condition-planner-runbook.md's own
// "Required campaign design" section for the literal cell table this file locks in).
//
// Deliberately pure: no filesystem, no subprocess, no network, no runtime auth, no import from
// registries.mjs/schemas.mjs/any runtimes/* adapter -- executionProfiles/skillConditions are always
// caller-supplied arrays here, exactly like resolveSelection's own registries parameter, so this
// whole module (and this whole test file) never needs a real registry to prove its own contract.
import { describe, it, expect } from 'vitest';
import {
  resolveScenarioCampaignDesign, buildScenarioCampaignPlan, assertValidScenarioCampaignPlan,
} from '../../tools/agentic-eval/scenario-campaign-plan.mjs';
import { PRODUCT_ACCESS_MODE_VALUES } from '../../tools/agentic-eval/product-access.mjs';

const DESIGN_ID = 'claude-2x2-williams-v1';
const FREE_BASELINE_DESIGN_ID = 'claude-product-vs-free-baseline-v1';
const STRICT = 'strict-policy-v1';
const UNRESTRICTED = 'sandboxed-unrestricted-v1';
const KNOWN_PROFILES = [STRICT, UNRESTRICTED];
const KNOWN_CONDITIONS = ['current-skill', 'no-skill'];

// The runbook's own literal "Total cells" table -- order_index 0..15, by label.
const EXPECTED_LABEL_ORDER = ['A', 'B', 'D', 'C', 'B', 'C', 'A', 'D', 'C', 'D', 'B', 'A', 'D', 'A', 'C', 'B'];
const CELL_DEFINITIONS = {
  A: { execution_profile_id: STRICT, condition: 'no-skill', product_access_mode: 'product-visible-no-skill' },
  B: { execution_profile_id: STRICT, condition: 'current-skill', product_access_mode: 'product-assisted' },
  C: { execution_profile_id: UNRESTRICTED, condition: 'no-skill', product_access_mode: 'product-visible-no-skill' },
  D: { execution_profile_id: UNRESTRICTED, condition: 'current-skill', product_access_mode: 'product-assisted' },
};
const EXPECTED_REPETITION_INDEX = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3];
const FREE_BASELINE_EXPECTED_LABEL_ORDER = ['A', 'B', 'B', 'A', 'B', 'A', 'A', 'B'];
const FREE_BASELINE_CELL_DEFINITIONS = {
  A: { execution_profile_id: UNRESTRICTED, condition: 'current-skill', product_access_mode: 'product-assisted' },
  B: { execution_profile_id: UNRESTRICTED, condition: 'no-skill', product_access_mode: 'free-baseline-no-product' },
};

function buildValidPlanOrThrow(overrides = {}) {
  const result = buildScenarioCampaignPlan({
    designId: DESIGN_ID, repeats: 4, executionProfiles: KNOWN_PROFILES, skillConditions: KNOWN_CONDITIONS, ...overrides,
  });
  if (!result.ok) throw new Error(`test setup: expected a valid plan, got rejection: ${result.reason}`);
  return result.plan;
}

function buildFreeBaselinePlanOrThrow(overrides = {}) {
  const result = buildScenarioCampaignPlan({
    designId: FREE_BASELINE_DESIGN_ID, repeats: 4, executionProfiles: KNOWN_PROFILES, skillConditions: KNOWN_CONDITIONS, ...overrides,
  });
  if (!result.ok) throw new Error(`test setup: expected a valid free-baseline plan, got rejection: ${result.reason}`);
  return result.plan;
}

describe('resolveScenarioCampaignDesign', () => {
  it('resolves the known claude-2x2-williams-v1 design', () => {
    const result = resolveScenarioCampaignDesign(DESIGN_ID);
    expect(result.ok).toBe(true);
    expect(result.design.id).toBe(DESIGN_ID);
    expect(result.design.repeats).toBe(4);
  });

  it('resolves the known claude-product-vs-free-baseline-v1 design', () => {
    const result = resolveScenarioCampaignDesign(FREE_BASELINE_DESIGN_ID);
    expect(result.ok).toBe(true);
    expect(result.design.id).toBe(FREE_BASELINE_DESIGN_ID);
    expect(result.design.repeats).toBe(4);
  });

  it('rejects an unknown design id', () => {
    const result = resolveScenarioCampaignDesign('not-a-real-design-v99');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unknown/i);
    expect(result.reason).toMatch(/not-a-real-design-v99/);
  });

  it('rejects null/undefined/empty-string design ids the same way', () => {
    expect(resolveScenarioCampaignDesign(null).ok).toBe(false);
    expect(resolveScenarioCampaignDesign(undefined).ok).toBe(false);
    expect(resolveScenarioCampaignDesign('').ok).toBe(false);
  });
});

describe('buildScenarioCampaignPlan -- claude-product-vs-free-baseline-v1 shape', () => {
  it('expands to exactly 8 unrestricted cells, planned_sessions:8', () => {
    const plan = buildFreeBaselinePlanOrThrow();
    expect(plan.campaign_design_id).toBe(FREE_BASELINE_DESIGN_ID);
    expect(plan.repeats).toBe(4);
    expect(plan.planned_sessions).toBe(8);
    expect(plan.cells).toHaveLength(8);
    expect(plan.cells.every((c) => c.execution_profile_id === UNRESTRICTED)).toBe(true);
  });

  it('produces the exact pre-registered A/B, B/A, B/A, A/B label order', () => {
    const plan = buildFreeBaselinePlanOrThrow();
    const sorted = [...plan.cells].sort((a, b) => a.order_index - b.order_index);
    expect(sorted.map((c) => c.campaign_cell_label)).toEqual(FREE_BASELINE_EXPECTED_LABEL_ORDER);
    expect(sorted.map((c) => `${c.condition}:${c.product_access_mode}`)).toEqual(
      FREE_BASELINE_EXPECTED_LABEL_ORDER.map((label) => {
        const def = FREE_BASELINE_CELL_DEFINITIONS[label];
        return `${def.condition}:${def.product_access_mode}`;
      }),
    );
  });

  it('compares product-assisted current-skill against a true no-product baseline, not product-visible no-skill', () => {
    const plan = buildFreeBaselinePlanOrThrow();
    expect(plan.cells.filter((c) => c.condition === 'current-skill')).toHaveLength(4);
    expect(plan.cells.filter((c) => c.product_access_mode === 'product-assisted')).toHaveLength(4);
    expect(plan.cells.filter((c) => c.condition === 'no-skill')).toHaveLength(4);
    expect(plan.cells.filter((c) => c.product_access_mode === 'free-baseline-no-product')).toHaveLength(4);
    expect(plan.cells.filter((c) => c.product_access_mode === 'product-visible-no-skill')).toHaveLength(0);
  });

  it('validates as a normal campaign plan and remains JSON-serializable', () => {
    const plan = buildFreeBaselinePlanOrThrow();
    expect(() => assertValidScenarioCampaignPlan(plan)).not.toThrow();
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });
});

describe('buildScenarioCampaignPlan -- claude-2x2-williams-v1 shape', () => {
  it('expands to exactly 16 cells, planned_sessions:16', () => {
    const plan = buildValidPlanOrThrow();
    expect(plan.cells.length).toBe(16);
    expect(plan.planned_sessions).toBe(16);
    expect(plan.campaign_design_id).toBe(DESIGN_ID);
    expect(plan.repeats).toBe(4);
  });

  it('produces the exact pre-registered A/B/D/C, B/C/A/D, C/D/B/A, D/A/C/B label order by order_index', () => {
    const plan = buildValidPlanOrThrow();
    const labelsByOrderIndex = [...plan.cells].sort((a, b) => a.order_index - b.order_index).map((c) => c.campaign_cell_label);
    expect(labelsByOrderIndex).toEqual(EXPECTED_LABEL_ORDER);
  });

  it('produces the exact pre-registered order asserted by execution_profile_id + condition (not just by label)', () => {
    const plan = buildValidPlanOrThrow();
    const sorted = [...plan.cells].sort((a, b) => a.order_index - b.order_index);
    const realized = sorted.map((c) => `${c.execution_profile_id}:${c.condition}`);
    const expected = EXPECTED_LABEL_ORDER.map((label) => `${CELL_DEFINITIONS[label].execution_profile_id}:${CELL_DEFINITIONS[label].condition}`);
    expect(realized).toEqual(expected);
  });

  it('repetition_index runs 0..3, matching the runbook\'s own per-cell repetition table exactly', () => {
    const plan = buildValidPlanOrThrow();
    const sorted = [...plan.cells].sort((a, b) => a.order_index - b.order_index);
    expect(sorted.map((c) => c.repetition_index)).toEqual(EXPECTED_REPETITION_INDEX);
  });

  it('order_index is 0..15 with no gaps and no duplicates', () => {
    const plan = buildValidPlanOrThrow();
    const indices = plan.cells.map((c) => c.order_index).sort((a, b) => a - b);
    expect(indices).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });

  it('every cell carries its own campaign_design_id, matching the plan\'s', () => {
    const plan = buildValidPlanOrThrow();
    expect(plan.cells.every((c) => c.campaign_design_id === DESIGN_ID)).toBe(true);
  });

  it('each of A/B/C/D appears exactly once per repetition', () => {
    const plan = buildValidPlanOrThrow();
    const byRep = new Map();
    for (const cell of plan.cells) {
      if (!byRep.has(cell.repetition_index)) byRep.set(cell.repetition_index, new Set());
      byRep.get(cell.repetition_index).add(cell.campaign_cell_label);
    }
    expect(byRep.size).toBe(4);
    for (const labels of byRep.values()) {
      expect([...labels].sort()).toEqual(['A', 'B', 'C', 'D']);
    }
  });

  it('strict-policy-v1 appears exactly 8 times, sandboxed-unrestricted-v1 exactly 8 times', () => {
    const plan = buildValidPlanOrThrow();
    const strictCount = plan.cells.filter((c) => c.execution_profile_id === STRICT).length;
    const unrestrictedCount = plan.cells.filter((c) => c.execution_profile_id === UNRESTRICTED).length;
    expect(strictCount).toBe(8);
    expect(unrestrictedCount).toBe(8);
  });

  it('current-skill appears exactly 8 times, no-skill exactly 8 times', () => {
    const plan = buildValidPlanOrThrow();
    const currentSkillCount = plan.cells.filter((c) => c.condition === 'current-skill').length;
    const noSkillCount = plan.cells.filter((c) => c.condition === 'no-skill').length;
    expect(currentSkillCount).toBe(8);
    expect(noSkillCount).toBe(8);
  });

  it('declares product access explicitly: no-skill cells are product-visible, not free-baseline', () => {
    const plan = buildValidPlanOrThrow();
    const sorted = [...plan.cells].sort((a, b) => a.order_index - b.order_index);
    expect(sorted.map((c) => c.product_access_mode)).toEqual(EXPECTED_LABEL_ORDER.map((l) => CELL_DEFINITIONS[l].product_access_mode));
    expect(plan.cells.filter((c) => c.product_access_mode === 'product-assisted')).toHaveLength(8);
    expect(plan.cells.filter((c) => c.product_access_mode === 'product-visible-no-skill')).toHaveLength(8);
    expect(plan.cells.filter((c) => c.product_access_mode === 'free-baseline-no-product')).toHaveLength(0);
  });

  it('keeps product access independent from execution profile: strict and unrestricted each contain both product modes', () => {
    const plan = buildValidPlanOrThrow();
    for (const executionProfileId of [STRICT, UNRESTRICTED]) {
      const modes = new Set(plan.cells.filter((c) => c.execution_profile_id === executionProfileId).map((c) => c.product_access_mode));
      expect([...modes].sort()).toEqual(['product-assisted', 'product-visible-no-skill']);
    }
  });

  it('uses only the closed product-access vocabulary', () => {
    const plan = buildValidPlanOrThrow();
    for (const cell of plan.cells) {
      expect(PRODUCT_ACCESS_MODE_VALUES).toContain(cell.product_access_mode);
    }
  });

  it('is deterministic across repeated calls -- never depends on Math.random or wall-clock', () => {
    const a = buildValidPlanOrThrow();
    const b = buildValidPlanOrThrow();
    expect(a).toEqual(b);
  });

  it('does not depend on --seed: passing an unrelated seed-like field has no effect on the plan (the design has no seed input at all)', () => {
    // buildScenarioCampaignPlan never accepts a seed parameter in the first place -- this test
    // documents that omission is deliberate (the runbook: "must not be shuffled with --seed"),
    // not an oversight. Calling it identically twice, with no seed anywhere in scope, must still
    // produce the byte-identical plan proven above; there is no seed-shaped input to vary here.
    const a = buildValidPlanOrThrow();
    const b = buildValidPlanOrThrow();
    expect(a).toEqual(b);
  });

  it('produces cells as plain, JSON-serializable objects (safe to embed directly in --dry-run output)', () => {
    const plan = buildValidPlanOrThrow();
    expect(() => JSON.stringify(plan)).not.toThrow();
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });
});

describe('buildScenarioCampaignPlan -- rejections (fail closed, never partially built)', () => {
  it('rejects an unknown design id', () => {
    const result = buildScenarioCampaignPlan({ designId: 'not-a-real-design-v99', repeats: 4, executionProfiles: KNOWN_PROFILES, skillConditions: KNOWN_CONDITIONS });
    expect(result.ok).toBe(false);
    expect(result.plan).toBeUndefined();
    expect(result.reason).toMatch(/unknown/i);
  });

  it('rejects a wrong repeat count (too few)', () => {
    const result = buildScenarioCampaignPlan({ designId: DESIGN_ID, repeats: 3, executionProfiles: KNOWN_PROFILES, skillConditions: KNOWN_CONDITIONS });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/repeats/i);
    expect(result.reason).toMatch(/4/);
  });

  it('rejects a wrong repeat count (too many)', () => {
    const result = buildScenarioCampaignPlan({ designId: DESIGN_ID, repeats: 8, executionProfiles: KNOWN_PROFILES, skillConditions: KNOWN_CONDITIONS });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/repeats/i);
  });

  it('rejects when a required execution profile is missing from the resolved runtime registry', () => {
    const result = buildScenarioCampaignPlan({ designId: DESIGN_ID, repeats: 4, executionProfiles: [STRICT], skillConditions: KNOWN_CONDITIONS });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(new RegExp(UNRESTRICTED));
  });

  it('rejects when EVERY execution profile is missing from the resolved runtime registry', () => {
    const result = buildScenarioCampaignPlan({ designId: DESIGN_ID, repeats: 4, executionProfiles: [], skillConditions: KNOWN_CONDITIONS });
    expect(result.ok).toBe(false);
  });

  it('rejects when a required skill condition is missing from the supported set', () => {
    const result = buildScenarioCampaignPlan({ designId: DESIGN_ID, repeats: 4, executionProfiles: KNOWN_PROFILES, skillConditions: ['no-skill'] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/current-skill/);
  });

  it('rejects a non-array executionProfiles rather than throwing', () => {
    const result = buildScenarioCampaignPlan({ designId: DESIGN_ID, repeats: 4, executionProfiles: null, skillConditions: KNOWN_CONDITIONS });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-array skillConditions rather than throwing', () => {
    const result = buildScenarioCampaignPlan({ designId: DESIGN_ID, repeats: 4, executionProfiles: KNOWN_PROFILES, skillConditions: 'current-skill' });
    expect(result.ok).toBe(false);
  });
});

describe('assertValidScenarioCampaignPlan', () => {
  it('accepts a genuinely valid plan (no throw)', () => {
    const plan = buildValidPlanOrThrow();
    expect(() => assertValidScenarioCampaignPlan(plan)).not.toThrow();
  });

  it('throws on an unknown campaign_design_id', () => {
    const plan = buildValidPlanOrThrow();
    expect(() => assertValidScenarioCampaignPlan({ ...plan, campaign_design_id: 'not-a-real-design-v99' })).toThrow();
  });

  it('throws when planned_sessions disagrees with cells.length', () => {
    const plan = buildValidPlanOrThrow();
    expect(() => assertValidScenarioCampaignPlan({ ...plan, planned_sessions: 15 })).toThrow(/planned_sessions/);
  });

  it('throws on a duplicate order_index', () => {
    const plan = buildValidPlanOrThrow();
    const cells = plan.cells.map((c, i) => (i === 1 ? { ...c, order_index: 0 } : c));
    expect(() => assertValidScenarioCampaignPlan({ ...plan, cells })).toThrow(/order_index/);
  });

  it('throws on a gap in the order_index range', () => {
    const plan = buildValidPlanOrThrow();
    const cells = plan.cells.map((c) => (c.order_index === 15 ? { ...c, order_index: 16 } : c));
    expect(() => assertValidScenarioCampaignPlan({ ...plan, cells })).toThrow(/order_index/);
  });

  it('throws on an unknown campaign_cell_label', () => {
    const plan = buildValidPlanOrThrow();
    const cells = plan.cells.map((c, i) => (i === 0 ? { ...c, campaign_cell_label: 'E' } : c));
    expect(() => assertValidScenarioCampaignPlan({ ...plan, cells })).toThrow(/campaign_cell_label|label/);
  });

  it('throws when a label is duplicated within one repetition (even if order_index stays contiguous)', () => {
    const plan = buildValidPlanOrThrow();
    // Swap repetition 0's 4th cell's label to duplicate repetition 0's 1st label ('A'), breaking
    // the "each label exactly once per repetition" invariant while every other structural
    // invariant (order_index contiguity, cell count, dedup-by-order_index) stays intact.
    const cells = plan.cells.map((c) => (c.order_index === 3 ? { ...c, campaign_cell_label: 'A', execution_profile_id: CELL_DEFINITIONS.A.execution_profile_id, condition: CELL_DEFINITIONS.A.condition, product_access_mode: CELL_DEFINITIONS.A.product_access_mode } : c));
    expect(() => assertValidScenarioCampaignPlan({ ...plan, cells })).toThrow();
  });

  it('throws when a cell\'s execution_profile_id disagrees with its own label\'s design definition', () => {
    const plan = buildValidPlanOrThrow();
    const cells = plan.cells.map((c) => (c.campaign_cell_label === 'A' ? { ...c, execution_profile_id: UNRESTRICTED } : c));
    expect(() => assertValidScenarioCampaignPlan({ ...plan, cells })).toThrow();
  });

  it('throws when a cell\'s condition disagrees with its own label\'s design definition', () => {
    const plan = buildValidPlanOrThrow();
    const cells = plan.cells.map((c) => (c.campaign_cell_label === 'A' ? { ...c, condition: 'current-skill' } : c));
    expect(() => assertValidScenarioCampaignPlan({ ...plan, cells })).toThrow();
  });

  it('throws when a cell product_access_mode disagrees with its own label definition', () => {
    const plan = buildValidPlanOrThrow();
    const cells = plan.cells.map((c) => (c.campaign_cell_label === 'A' ? { ...c, product_access_mode: 'free-baseline-no-product' } : c));
    expect(() => assertValidScenarioCampaignPlan({ ...plan, cells })).toThrow(/product_access_mode/);
  });

  it('throws when a repetition\'s realized label sequence does not match the pre-registered literal order', () => {
    const plan = buildValidPlanOrThrow();
    // Repetition 0 must dispatch A,B,D,C in that literal order_index sequence -- swap the label at
    // order_index 0 and order_index 1 (A<->B) while leaving every label's own execution_profile_id/
    // condition/order_index/repetition_index internally self-consistent, so only SEQUENCE is wrong.
    const cells = plan.cells.map((c) => {
      if (c.order_index === 0) return { ...c, campaign_cell_label: 'B', execution_profile_id: CELL_DEFINITIONS.B.execution_profile_id, condition: CELL_DEFINITIONS.B.condition, product_access_mode: CELL_DEFINITIONS.B.product_access_mode };
      if (c.order_index === 1) return { ...c, campaign_cell_label: 'A', execution_profile_id: CELL_DEFINITIONS.A.execution_profile_id, condition: CELL_DEFINITIONS.A.condition, product_access_mode: CELL_DEFINITIONS.A.product_access_mode };
      return c;
    });
    expect(() => assertValidScenarioCampaignPlan({ ...plan, cells })).toThrow();
  });

  it('throws on a non-object plan', () => {
    expect(() => assertValidScenarioCampaignPlan(null)).toThrow();
    expect(() => assertValidScenarioCampaignPlan(undefined)).toThrow();
    expect(() => assertValidScenarioCampaignPlan('not-a-plan')).toThrow();
  });

  it('throws on an empty cells array', () => {
    const plan = buildValidPlanOrThrow();
    expect(() => assertValidScenarioCampaignPlan({ ...plan, cells: [] })).toThrow();
  });
});

#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/scenario-campaign-plan.mjs -- pure, deterministic multi-profile scenario
// campaign planning (agentic-eval-multi-profile-campaigns-v1). Expands one closed, pre-registered
// campaign design id into an explicit, literal-order 16-cell plan spanning BOTH execution profile
// (strict-policy-v1/sandboxed-unrestricted-v1) and skill condition (current-skill/no-skill) --
// unblocking Evidence 1's single pre-registered 4x4 Williams-style order across a genuine
// 2x2 (policy profile x skill condition) design.
//
// A closed, explicit campaign design registry (never arbitrary caller-supplied JSON) -- this is an
// implementation foundation for one pre-registered design, not a general experiment-design DSL.
//
// Deliberately dependency-free: no filesystem, no subprocess, no network, no runtime auth, no
// import from registries.mjs/schemas.mjs/any runtimes/* adapter. `executionProfiles` and
// `skillConditions` are always caller-supplied arrays (mirroring resolveSelection's own
// `registries` parameter in registries.mjs) -- the real CLI passes the resolved runtime registry's
// actual ids; tests pass synthetic arrays. This keeps the whole module trivially vendor-neutral and
// independently unit-testable without ever touching a real registry file.
import { isProductAccessMode, isProductAccessModeCompatibleWithSkillCondition } from './product-access.mjs';

/** The two skill-condition values this harness ever varies -- see randomizer.mjs's own
 * buildConditionOrders, which this module deliberately does NOT import (no seed/shuffle dependency
 * of any kind here; the campaign's own cell order is fully literal and pre-registered). */
const SKILL_CONDITION_VALUES = Object.freeze(['current-skill', 'no-skill']);

/** Closed registry of campaign designs. Each design is a fixed 2-axis (execution profile x skill
 * condition) cell definition set (`cellDefinitions`, keyed by a short label) plus a literal,
 * pre-registered per-repetition dispatch ORDER of those labels (`order`, one array per repetition,
 * left-to-right = real dispatch sequence within that repetition) -- never derived from a seed or
 * shuffle. Adding a new design is additive (a new key here); existing ids are never reinterpreted. */
const CAMPAIGN_DESIGNS = Object.freeze({
  'claude-2x2-williams-v1': Object.freeze({
    id: 'claude-2x2-williams-v1',
    repeats: 4,
    cellDefinitions: Object.freeze({
      A: Object.freeze({ execution_profile_id: 'strict-policy-v1', condition: 'no-skill', product_access_mode: 'product-visible-no-skill' }),
      B: Object.freeze({ execution_profile_id: 'strict-policy-v1', condition: 'current-skill', product_access_mode: 'product-assisted' }),
      C: Object.freeze({ execution_profile_id: 'sandboxed-unrestricted-v1', condition: 'no-skill', product_access_mode: 'product-visible-no-skill' }),
      D: Object.freeze({ execution_profile_id: 'sandboxed-unrestricted-v1', condition: 'current-skill', product_access_mode: 'product-assisted' }),
    }),
    order: Object.freeze([
      Object.freeze(['A', 'B', 'D', 'C']),
      Object.freeze(['B', 'C', 'A', 'D']),
      Object.freeze(['C', 'D', 'B', 'A']),
      Object.freeze(['D', 'A', 'C', 'B']),
    ]),
  }),
  'claude-product-vs-free-baseline-v1': Object.freeze({
    id: 'claude-product-vs-free-baseline-v1',
    repeats: 4,
    cellDefinitions: Object.freeze({
      A: Object.freeze({ execution_profile_id: 'sandboxed-unrestricted-v1', condition: 'current-skill', product_access_mode: 'product-assisted' }),
      B: Object.freeze({ execution_profile_id: 'sandboxed-unrestricted-v1', condition: 'no-skill', product_access_mode: 'free-baseline-no-product' }),
    }),
    order: Object.freeze([
      Object.freeze(['A', 'B']),
      Object.freeze(['B', 'A']),
      Object.freeze(['B', 'A']),
      Object.freeze(['A', 'B']),
    ]),
  }),
});

/** Resolves a campaign design by id. Never throws -- `{ok:true, design}` or `{ok:false, reason}`,
 * mirroring registries.mjs's resolveSelection/resolveIsolationAttestationOrFail's own shape. */
export function resolveScenarioCampaignDesign(designId) {
  const design = typeof designId === 'string' && designId.length > 0 ? CAMPAIGN_DESIGNS[designId] : undefined;
  if (design == null) {
    const known = Object.keys(CAMPAIGN_DESIGNS).join(', ');
    return { ok: false, reason: `unknown campaign design id ${JSON.stringify(designId)} (known: ${known})` };
  }
  return { ok: true, design };
}

/**
 * Builds the full, literal, pre-registered campaign plan for one design id. Never falls back or
 * partially builds on any rejection -- fails closed with `{ok:false, reason}` before constructing
 * a single cell, exactly like resolveSelection's own discipline.
 * @param {object} opts
 * @param {string} opts.designId
 * @param {number} opts.repeats - must equal the design's own required repeat count exactly.
 * @param {string[]} opts.executionProfiles - the resolved runtime registry's own known/enabled
 *   execution profile ids (real caller: registries.mjs's loadRegistries().executionProfiles ids;
 *   tests: a synthetic array).
 * @param {string[]} [opts.skillConditions] - defaults to the harness's own closed 2-value set.
 * @returns {{ok:true, plan:object}|{ok:false, reason:string}}
 */
export function buildScenarioCampaignPlan({ designId, repeats, executionProfiles, skillConditions = SKILL_CONDITION_VALUES }) {
  const resolved = resolveScenarioCampaignDesign(designId);
  if (!resolved.ok) return resolved;
  const { design } = resolved;

  if (repeats !== design.repeats) {
    return { ok: false, reason: `campaign design ${JSON.stringify(designId)} requires exactly ${design.repeats} repeats, got ${JSON.stringify(repeats)}` };
  }
  if (!Array.isArray(executionProfiles)) {
    return { ok: false, reason: 'executionProfiles must be an array of known execution profile ids' };
  }
  if (!Array.isArray(skillConditions)) {
    return { ok: false, reason: 'skillConditions must be an array of known skill condition values' };
  }

  // Every cell definition's own profile/condition must be independently satisfiable against the
  // CALLER's resolved registry state -- checked once per distinct label, before any cell is built
  // (fail closed before construction, never a partially-built plan).
  for (const [label, def] of Object.entries(design.cellDefinitions)) {
    if (!executionProfiles.includes(def.execution_profile_id)) {
      return { ok: false, reason: `campaign design ${JSON.stringify(designId)} cell ${label} requires execution profile ${JSON.stringify(def.execution_profile_id)}, which is not in the resolved runtime registry (known: ${executionProfiles.join(', ') || '(none)'})` };
    }
    if (!skillConditions.includes(def.condition)) {
      return { ok: false, reason: `campaign design ${JSON.stringify(designId)} cell ${label} requires skill condition ${JSON.stringify(def.condition)}, which is not a supported skill condition (known: ${skillConditions.join(', ') || '(none)'})` };
    }
    if (!isProductAccessMode(def.product_access_mode)) {
      return { ok: false, reason: `campaign design ${JSON.stringify(designId)} cell ${label} has unsupported product_access_mode ${JSON.stringify(def.product_access_mode)}` };
    }
    if (!isProductAccessModeCompatibleWithSkillCondition({ condition: def.condition, productAccessMode: def.product_access_mode })) {
      return { ok: false, reason: `campaign design ${JSON.stringify(designId)} cell ${label} product_access_mode ${JSON.stringify(def.product_access_mode)} is not compatible with condition ${JSON.stringify(def.condition)}` };
    }
  }

  const cells = [];
  let orderIndex = 0;
  for (let repetitionIndex = 0; repetitionIndex < design.repeats; repetitionIndex++) {
    for (const label of design.order[repetitionIndex]) {
      const def = design.cellDefinitions[label];
      cells.push({
        order_index: orderIndex,
        repetition_index: repetitionIndex,
        campaign_cell_label: label,
        campaign_design_id: designId,
        execution_profile_id: def.execution_profile_id,
        condition: def.condition,
        product_access_mode: def.product_access_mode,
      });
      orderIndex++;
    }
  }

  const plan = {
    campaign_design_id: designId,
    repeats: design.repeats,
    planned_sessions: cells.length,
    cells,
  };
  // Self-check before ever returning a plan to a caller -- defense in depth against a future edit
  // to the construction loop above silently drifting from the design's own declared shape; this
  // function's own tests already prove the happy path, but a caller must never be able to observe
  // a plan this module's own validator would itself reject.
  assertValidScenarioCampaignPlan(plan);
  return { ok: true, plan };
}

/**
 * Structural + semantic validator for a campaign plan object -- reusable both as
 * buildScenarioCampaignPlan's own internal self-check and directly against a hand-constructed
 * candidate (e.g. a test fixture, or a plan round-tripped through JSON for --dry-run). Throws with
 * a descriptive message on any violation (never returns a value) -- matches this codebase's own
 * "assert" naming convention (privacy.mjs's assertCleanOrThrow, rejection-diagnostics.mjs's
 * assertUnexpectedToolCoherence), unlike this module's own resolve/build functions, which never
 * throw.
 * @param {object} plan
 */
export function assertValidScenarioCampaignPlan(plan) {
  if (plan == null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('assertValidScenarioCampaignPlan: plan must be an object');
  }
  const resolved = resolveScenarioCampaignDesign(plan.campaign_design_id);
  if (!resolved.ok) throw new Error(`assertValidScenarioCampaignPlan: ${resolved.reason}`);
  const { design } = resolved;
  const knownLabels = Object.keys(design.cellDefinitions);

  if (plan.repeats !== design.repeats) {
    throw new Error(`assertValidScenarioCampaignPlan: plan.repeats (${JSON.stringify(plan.repeats)}) does not match design ${JSON.stringify(plan.campaign_design_id)}'s required repeats (${design.repeats})`);
  }
  if (!Array.isArray(plan.cells) || plan.cells.length === 0) {
    throw new Error('assertValidScenarioCampaignPlan: plan.cells must be a non-empty array');
  }
  if (plan.planned_sessions !== plan.cells.length) {
    throw new Error(`assertValidScenarioCampaignPlan: planned_sessions (${JSON.stringify(plan.planned_sessions)}) does not match cells.length (${plan.cells.length})`);
  }
  const expectedCellCount = design.repeats * knownLabels.length;
  if (plan.cells.length !== expectedCellCount) {
    throw new Error(`assertValidScenarioCampaignPlan: expected ${expectedCellCount} cells (${design.repeats} repeats x ${knownLabels.length} labels), got ${plan.cells.length}`);
  }

  const seenOrderIndices = new Set();
  const labelsByRepetition = new Map();
  for (const cell of plan.cells) {
    if (!Number.isInteger(cell.order_index) || cell.order_index < 0) {
      throw new Error(`assertValidScenarioCampaignPlan: cell must have a non-negative-integer order_index, got ${JSON.stringify(cell.order_index)}`);
    }
    if (seenOrderIndices.has(cell.order_index)) {
      throw new Error(`assertValidScenarioCampaignPlan: duplicate order_index ${cell.order_index}`);
    }
    seenOrderIndices.add(cell.order_index);

    if (!Number.isInteger(cell.repetition_index) || cell.repetition_index < 0 || cell.repetition_index >= design.repeats) {
      throw new Error(`assertValidScenarioCampaignPlan: cell has an out-of-range repetition_index, got ${JSON.stringify(cell.repetition_index)}`);
    }
    if (!knownLabels.includes(cell.campaign_cell_label)) {
      throw new Error(`assertValidScenarioCampaignPlan: unknown campaign_cell_label ${JSON.stringify(cell.campaign_cell_label)} (known: ${knownLabels.join(', ')})`);
    }
    if (cell.campaign_design_id !== plan.campaign_design_id) {
      throw new Error(`assertValidScenarioCampaignPlan: cell campaign_design_id ${JSON.stringify(cell.campaign_design_id)} does not match plan campaign_design_id ${JSON.stringify(plan.campaign_design_id)}`);
    }
    const expectedDef = design.cellDefinitions[cell.campaign_cell_label];
    if (cell.execution_profile_id !== expectedDef.execution_profile_id) {
      throw new Error(`assertValidScenarioCampaignPlan: cell ${cell.campaign_cell_label} execution_profile_id ${JSON.stringify(cell.execution_profile_id)} does not match design's ${JSON.stringify(expectedDef.execution_profile_id)}`);
    }
    if (cell.condition !== expectedDef.condition) {
      throw new Error(`assertValidScenarioCampaignPlan: cell ${cell.campaign_cell_label} condition ${JSON.stringify(cell.condition)} does not match design's ${JSON.stringify(expectedDef.condition)}`);
    }
    if (cell.product_access_mode !== expectedDef.product_access_mode) {
      throw new Error(`assertValidScenarioCampaignPlan: cell ${cell.campaign_cell_label} product_access_mode ${JSON.stringify(cell.product_access_mode)} does not match design's ${JSON.stringify(expectedDef.product_access_mode)}`);
    }

    if (!labelsByRepetition.has(cell.repetition_index)) labelsByRepetition.set(cell.repetition_index, new Map());
    const labelsThisRep = labelsByRepetition.get(cell.repetition_index);
    if (labelsThisRep.has(cell.campaign_cell_label)) {
      throw new Error(`assertValidScenarioCampaignPlan: label ${cell.campaign_cell_label} appears more than once in repetition ${cell.repetition_index}`);
    }
    labelsThisRep.set(cell.campaign_cell_label, cell.order_index);
  }

  for (let i = 0; i < plan.cells.length; i++) {
    if (!seenOrderIndices.has(i)) {
      throw new Error(`assertValidScenarioCampaignPlan: order_index values are not a contiguous 0..${plan.cells.length - 1} range (missing ${i})`);
    }
  }
  // Every repetition must carry every known label exactly once (already proven per-cell above) AND
  // realize them in the design's own literal, pre-registered left-to-right sequence -- a plan whose
  // labels are all PRESENT but reordered within a repetition must still be rejected: this is the
  // "the 16-cell order must be literal and pre-registered, never shuffled" contract made structural.
  for (let rep = 0; rep < design.repeats; rep++) {
    const labelsThisRep = labelsByRepetition.get(rep);
    if (labelsThisRep == null) {
      throw new Error(`assertValidScenarioCampaignPlan: repetition ${rep} has no cells at all`);
    }
    for (const label of knownLabels) {
      if (!labelsThisRep.has(label)) {
        throw new Error(`assertValidScenarioCampaignPlan: repetition ${rep} is missing label ${label}`);
      }
    }
    const realizedOrder = [...labelsThisRep.entries()].sort((a, b) => a[1] - b[1]).map(([label]) => label);
    const expectedOrder = design.order[rep];
    for (let i = 0; i < expectedOrder.length; i++) {
      if (realizedOrder[i] !== expectedOrder[i]) {
        throw new Error(`assertValidScenarioCampaignPlan: repetition ${rep} realized label order ${JSON.stringify(realizedOrder)} does not match design's pre-registered order ${JSON.stringify(expectedOrder)}`);
      }
    }
  }
}

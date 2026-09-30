// SPDX-License-Identifier: MIT
// tests/vitest/agentic-eval-derive-round-order-cli.test.js -- P0 #2 (publication hardening):
// direct unit coverage for deriveRoundOrder plus a real subprocess CLI check, since this file's
// whole reason to exist is being invokable from evidence1-run.ps1's own host-side validator, not
// just importable from another Node module.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { deriveRoundOrder } from '../../tools/agentic-eval/derive-round-order-cli.mjs';

const PROFILE = 'sandboxed-unrestricted-v1';
const DESIGN = 'claude-product-vs-free-baseline-v1';
const FULL_CAMPAIGN_ORDER = ['product', 'free', 'free', 'product', 'free', 'product', 'product', 'free'];

describe('deriveRoundOrder', () => {
  it('indices [0,1] (a canary) derive [product, free] -- the design\'s own first repetition', () => {
    const result = deriveRoundOrder({ designId: DESIGN, campaignCellIndices: [0, 1], executionProfiles: [PROFILE] });
    expect(result.ok).toBe(true);
    expect(result.round_order).toEqual(['product', 'free']);
  });

  it('indices [2,3] derive [free, product] -- a non-first, non-contiguous-with-0 subset still indexes correctly', () => {
    const result = deriveRoundOrder({ designId: DESIGN, campaignCellIndices: [2, 3], executionProfiles: [PROFILE] });
    expect(result.ok).toBe(true);
    expect(result.round_order).toEqual(['free', 'product']);
  });

  it('the full [0..7] derives the complete pre-registered 8-cell campaign round_order for the Claude design', () => {
    const result = deriveRoundOrder({ designId: DESIGN, campaignCellIndices: [0, 1, 2, 3, 4, 5, 6, 7], executionProfiles: [PROFILE] });
    expect(result.ok).toBe(true);
    expect(result.round_order).toEqual(FULL_CAMPAIGN_ORDER);
  });

  it('the full [0..7] derives the identical round_order for the Codex design', () => {
    const result = deriveRoundOrder({ designId: 'codex-product-vs-free-baseline-v2', campaignCellIndices: [0, 1, 2, 3, 4, 5, 6, 7], executionProfiles: [PROFILE] });
    expect(result.ok).toBe(true);
    expect(result.round_order).toEqual(FULL_CAMPAIGN_ORDER);
  });

  it('an out-of-order index list [3,2] derives in the REQUESTED order, not sorted -- the manifest\'s own declared order is what gets checked', () => {
    const result = deriveRoundOrder({ designId: DESIGN, campaignCellIndices: [3, 2], executionProfiles: [PROFILE] });
    expect(result.ok).toBe(true);
    expect(result.round_order).toEqual(['product', 'free']);
  });

  it('a repeated index is honored literally, once per occurrence', () => {
    const result = deriveRoundOrder({ designId: DESIGN, campaignCellIndices: [0, 0], executionProfiles: [PROFILE] });
    expect(result.ok).toBe(true);
    expect(result.round_order).toEqual(['product', 'product']);
  });

  it('fails closed with derive_round_order_cell_index_not_in_plan on an index the plan does not contain, rather than skipping it', () => {
    const result = deriveRoundOrder({ designId: DESIGN, campaignCellIndices: [0, 99], executionProfiles: [PROFILE] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/derive_round_order_cell_index_not_in_plan: 99/);
  });

  it('fails closed (never throws) on an unknown design id, surfacing resolveScenarioCampaignDesign\'s own reason', () => {
    const result = deriveRoundOrder({ designId: 'not-a-real-design', campaignCellIndices: [0, 1], executionProfiles: [PROFILE] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unknown campaign design id/);
  });
});

describe('derive-round-order-cli.mjs as a real subprocess (stdin, never a CLI argument)', () => {
  it('prints non-empty JSON with the derived round_order and exits 0 on success', () => {
    const args = JSON.stringify({ designId: DESIGN, campaignCellIndices: [0, 1, 2, 3, 4, 5, 6, 7], executionProfiles: [PROFILE] });
    const stdout = execFileSync(process.execPath, ['tools/agentic-eval/derive-round-order-cli.mjs'], { encoding: 'utf8', cwd: process.cwd(), input: args });
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.round_order).toEqual(FULL_CAMPAIGN_ORDER);
  });

  it('exits non-zero and still prints structured JSON on a bad design id', () => {
    const args = JSON.stringify({ designId: 'nope', campaignCellIndices: [0, 1], executionProfiles: [PROFILE] });
    let threw = null;
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, ['tools/agentic-eval/derive-round-order-cli.mjs'], { encoding: 'utf8', cwd: process.cwd(), input: args });
    } catch (error) {
      threw = error;
      stdout = error.stdout;
    }
    expect(threw).not.toBeNull();
    expect(threw.status).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
  });

  it('exits 2 with a usage message when stdin is empty', () => {
    let threw = null;
    try {
      execFileSync(process.execPath, ['tools/agentic-eval/derive-round-order-cli.mjs'], { encoding: 'utf8', cwd: process.cwd(), input: '' });
    } catch (error) {
      threw = error;
    }
    expect(threw).not.toBeNull();
    expect(threw.status).toBe(2);
  });
});

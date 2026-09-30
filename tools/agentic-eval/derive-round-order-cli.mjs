#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/derive-round-order-cli.mjs -- thin CLI wrapper around
// scenario-campaign-plan.mjs's buildScenarioCampaignPlan, so evidence1-run.ps1's host-side
// round_order pre-registration guard can derive the same
// single-source-of-truth sequence a PowerShell process cannot import directly. Takes one JSON
// object on stdin ({designId, campaignCellIndices, executionProfiles}), prints
// {round_order: [...]} (conditions mapped current-skill -> "product", no-skill -> "free", matching
// every manifest's own round_order vocabulary) on success, or {ok:false, reason} with a non-zero
// exit on failure. Never mutates anything; pure derivation.
//
// Indexes by campaignCellIndices into the design's own FULL pre-registered plan
// (always built at the design's real repeats) rather than trying to infer a repeat count and
// special-case repeats:1 -- expected[i] = label(fullPlan.cells.find(c => c.order_index ===
// campaignCellIndices[i]).condition). This is exactly the property the guest side already asserts
// per cell (order_index == CampaignCellIndex), so ANY valid index subset works the same way a
// canary's [0,1] does -- a resumed [2,3], or any other subset, not just "1 rep or the full count".
// An index missing from the plan fails closed rather than silently skipping it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScenarioCampaignPlan, resolveScenarioCampaignDesign } from './scenario-campaign-plan.mjs';

const CONDITION_TO_ROUND_ORDER_LABEL = { 'current-skill': 'product', 'no-skill': 'free' };

export function deriveRoundOrder({ designId, campaignCellIndices, executionProfiles }) {
  const resolved = resolveScenarioCampaignDesign(designId);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const fullRepeats = resolved.design.repeats;
  const result = buildScenarioCampaignPlan({ designId, repeats: fullRepeats, executionProfiles });
  if (!result.ok) return result;
  const cellsByOrderIndex = new Map(result.plan.cells.map((cell) => [cell.order_index, cell]));
  const roundOrder = [];
  for (const index of campaignCellIndices) {
    const cell = cellsByOrderIndex.get(index);
    if (cell == null) return { ok: false, reason: `derive_round_order_cell_index_not_in_plan: ${JSON.stringify(index)}` };
    const label = CONDITION_TO_ROUND_ORDER_LABEL[cell.condition];
    if (label == null) return { ok: false, reason: `derive_round_order_unknown_condition: ${cell.condition}` };
    roundOrder.push(label);
  }
  return { ok: true, round_order: roundOrder };
}

function main() {
  // Read via stdin, never a CLI argument: PowerShell's own native-executable argument marshaling
  // mangles a JSON string's embedded double quotes on the way to CreateProcess's command line --
  // confirmed live (process.argv[2] came back undefined from a real PowerShell caller passing
  // ConvertTo-Json -Compress output positionally). Stdin has no such quoting layer to cross.
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  if (!raw.trim()) {
    process.stderr.write('usage: echo \'{"designId":"...","campaignCellIndices":[0,1],"executionProfiles":["..."]}\' | node derive-round-order-cli.mjs\n');
    process.exit(2);
  }
  let args;
  try {
    args = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'derive_round_order_stdin_not_json' }) + '\n');
    process.exit(1);
  }
  const result = deriveRoundOrder(args);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

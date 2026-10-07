#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/cost-estimate.mjs -- cost-estimate.json (schema 2) generator. Reads the same
// live campaign directory campaign-summary.mjs reads, via its exported loadCountedCellTokens (the
// single source of truth for "which cells count" -- see that function's own header), applies a
// fixed, binding, runtime-specific token mapping to avoid double-counting, and prices every counted
// cell against a real, sourced-and-dated per-runtime price table. readme-evidence.mjs's
// validateCostEstimate is the authoritative consumer-side contract this module
// targets -- verified directly against that function's code before writing this, not from prose.
//
// BINDING token mapping (avoids double-counting a cached prefix):
//   Codex (runtimes/codex-cli.mjs's own ingestion: `input: usage?.input_tokens`,
//   `cached_input: usage?.cached_input_tokens`, no subtraction) -- OpenAI's input_tokens is the
//   TOTAL prompt size, INCLUSIVE of any cached portion; cached_input_tokens is a SUBSET of it, not
//   additive. So: tokens.input = usage.input - usage.cached_input (U, the uncached portion),
//   tokens.cache_read = usage.cached_input, tokens.output = usage.output (includes reasoning
//   tokens -- OpenAI's own Output pricing tooltip: "Output prices include visible output tokens
//   and reasoning..."), tokens.cache_creation = 0 always (Codex's own turn.completed usage event
//   has no cache-write TOKEN COUNT dimension at all -- runtimes/codex-cli.mjs hardcodes
//   usage.cache_write:null, never a real number).
//
//   Codex price-ambiguity correction (verified independently against the raw
//   fetched page before use -- see Pricing verification trail below): OpenAI's own Input pricing
//   tooltip reads "Input tokens are either Input, Cached Input, or Cache Write and writes are not
//   an additive fee." -- a token is billed at exactly ONE of the three rates, never input-plus-
//   cache-write. Since Codex's usage event cannot distinguish which rate U (the uncached portion)
//   was actually billed at, U's PRICE is genuinely ambiguous -- unlike its TOKEN COUNT, which is
//   unambiguous (cache_creation really is always 0 here; that count is never ambiguous, only which
//   rate priced the uncached tokens is). Both cache_write_5m/cache_write_1h PRICE fields are set to
//   the real, published cache-write rate (not 0) so a downstream cost-range generator can price U
//   at the input rate for a low bound and at the cache-write rate for a high bound -- this module
//   itself does not compute that range (see readme-evidence.mjs's armCostRange/sessionCost, a
//   sibling consumer); it only emits the flag and the real prices needed to do so
//   correctly. The runtime-level `uncached_input_may_be_cache_writes: true` field (codex-cli only)
//   and `pricing_note` (the quoted tooltip) make this ambiguity explicit in the emitted document,
//   not just in this comment.
//
//   Claude (runtimes/claude-code.mjs's own ingestion: `input: usageRaw?.input`,
//   `cached_input: usageRaw?.cache_read`, `cache_write: usageRaw?.cache_creation`) -- Anthropic's
//   input/cache_read/cache_creation are three DISTINCT, non-overlapping, unambiguously-priced
//   buckets (no equivalent tooltip -- cache writes are a real, separately reported, additive
//   Anthropic charge). So: tokens.input = usage.input as-is, tokens.cache_read = usage.cached_input,
//   tokens.cache_creation = usage.cache_write, tokens.output = usage.output. No subtraction, no
//   pricing ambiguity, no uncached_input_may_be_cache_writes field.
//
// Pricing verification trail (both fetched live, cross-checked raw HTML against the WebFetch
// summary before use -- see this session's own record for the full trail):
//   claude-sonnet-5: https://platform.claude.com/docs/en/about-claude/pricing, retrieved 2026-09-29.
//   gpt-5.6-terra: https://developers.openai.com/api/docs/pricing (redirected from
//     platform.openai.com/docs/pricing), retrieved 2026-09-29 -- confirmed against the page's own
//     embedded data table (`["gpt-5.6-terra"],[2],[0.2],[2.5],[12]`) AND the Input pricing
//     tooltip's exact text (grepped from the raw fetched HTML, not just the WebFetch summary).
//
// Usage: node tools/agentic-eval/cost-estimate.mjs <campaign-dir>

import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCountedCellTokens } from './campaign-summary.mjs';

export const COST_ESTIMATE_SCHEMA = 2;

export const RUNTIME_PRICING = Object.freeze({
  'claude-code': Object.freeze({
    model: 'claude-sonnet-5',
    per_million_tokens: Object.freeze({ input: 2, cache_write_5m: 2.5, cache_write_1h: 4, cache_read: 0.2, output: 10 }),
    source: 'https://platform.claude.com/docs/en/about-claude/pricing',
    retrieved: '2026-09-29',
  }),
  'codex-cli': Object.freeze({
    model: 'gpt-5.6-terra',
    // cache_write_5m/1h are the REAL published cache-write rate (not 0) -- see this file's header
    // for why: OpenAI's own tooltip makes input/cached-input/cache-write mutually exclusive rates
    // for the SAME token, so the uncached portion's true rate is ambiguous from Codex's own usage
    // event, not zero.
    per_million_tokens: Object.freeze({ input: 2, cache_write_5m: 2.5, cache_write_1h: 2.5, cache_read: 0.2, output: 12 }),
    source: 'https://developers.openai.com/api/docs/pricing',
    retrieved: '2026-09-29',
    uncached_input_may_be_cache_writes: true,
    pricing_note: 'OpenAI Input pricing tooltip (developers.openai.com/api/docs/pricing, retrieved 2026-09-29): "Input tokens are either Input, Cached Input, or Cache Write and writes are not an additive fee."',
  }),
});

const PRICED_USAGE_DIMENSIONS = Object.freeze({
  'claude-code': Object.freeze(['input', 'cached_input', 'cache_write', 'output']),
  'codex-cli': Object.freeze(['input', 'cached_input', 'output']),
});

function missingPricedDimensions(runtimeId, usage) {
  return (PRICED_USAGE_DIMENSIONS[runtimeId] ?? []).filter((dimension) =>
    !Number.isSafeInteger(usage?.[dimension]) || usage[dimension] < 0);
}

/** Applies the BINDING per-runtime token mapping to one counted cell's recorded usage.
 * Returns null when any priced dimension is absent; a null usage value is unknown, never zero.
 * Codex cache_write is excluded because this mapping prices its uncached input as input and
 * assigns cache_creation=0 by definition, not by reading that unreported dimension. */
export function tokensForRow(runtimeId, usage) {
  if (!PRICED_USAGE_DIMENSIONS[runtimeId] || (usage?.source != null && usage.source !== 'runtime-reported')
      || missingPricedDimensions(runtimeId, usage).length > 0) return null;
  const { input, cached_input: cachedInput, output } = usage;
  if (runtimeId === 'codex-cli') {
    return { input: Math.max(input - cachedInput, 0), output, cache_read: cachedInput, cache_creation: 0 };
  }
  return { input, output, cache_read: cachedInput, cache_creation: usage.cache_write };
}

/** Builds the schema-2 cost-estimate.json object for a live campaign directory.
 * @returns {{ok:true, doc:object}|{ok:false, reason:string}} Never a partial or guessed estimate:
 *   fails closed on a non-live/unreadable campaign, a cell whose recorded model_id doesn't match
 *   this module's own pinned RUNTIME_PRICING (the price table would silently describe the wrong
 *   model), incomplete/unrecorded priced usage, or a runtime with an arm that has no counted cell.
 *   Each arm's cells are that arm's counted cells, whatever their number (a canary has 1 per arm,
 *   a campaign 8) and whether or not the two arms of a runtime match.
 */
export function buildCostEstimate(campaignDir) {
  const rows = loadCountedCellTokens(campaignDir);
  if (rows == null) return { ok: false, reason: 'campaign_not_live_or_unreadable' };

  const runtimes = {};
  for (const [runtimeId, pricing] of Object.entries(RUNTIME_PRICING)) {
    const runtimeRows = rows.filter((r) => r.runtimeId === runtimeId);
    const modelMismatch = runtimeRows.find((r) => r.modelId !== pricing.model);
    if (modelMismatch) {
      return { ok: false, reason: `${runtimeId}: campaign cell reports model_id ${JSON.stringify(modelMismatch.modelId)}, pinned pricing is for ${JSON.stringify(pricing.model)}` };
    }
    // Any sample size: the arms of a runtime may count different numbers of cells (a rejected session is
    // never replaced), but an arm with none has nothing to price.
    for (const arm of ['product', 'free']) {
      const n = runtimeRows.filter((r) => r.arm === arm).length;
      if (n < 1) return { ok: false, reason: `${runtimeId}: expected at least 1 counted ${arm} cell, got ${n}` };
    }
    const cells = [];
    for (const row of runtimeRows.slice().sort((a, b) => a.roundIndex - b.roundIndex)) {
      const location = `${runtimeId} ${row.arm} index ${row.roundIndex}`;
      if (row.usage?.source !== 'runtime-reported') {
        return { ok: false, reason: `${location}: usage source ${JSON.stringify(row.usage?.source ?? 'not-recorded')} cannot be priced` };
      }
      const missing = missingPricedDimensions(runtimeId, row.usage);
      if (missing.length > 0) {
        return { ok: false, reason: `${location}: missing priced usage dimensions: ${missing.join(', ')}` };
      }
      cells.push({ arm: row.arm, order_index: row.roundIndex, tokens: tokensForRow(runtimeId, row.usage) });
    }
    runtimes[runtimeId] = {
      model: pricing.model, per_million_tokens: pricing.per_million_tokens,
      source: pricing.source, retrieved: pricing.retrieved,
      // Present only for a runtime whose RUNTIME_PRICING entry defines them (codex-cli today).
      // Conditional spread, not a direct `key: pricing.key` assignment: an object literal
      // property assigned an explicit `undefined` still creates an OWN, enumerable key (`'x' in
      // obj` is true, `JSON.stringify` drops it, but readme-evidence.mjs's validateCostEstimate
      // checks presence via `in` on the in-memory doc, before any serialization -- confirmed
      // against that function's own code, not assumed). A direct assignment left
      // claude-code carrying the key with value `undefined`, which the validator's own
      // `typeof !== 'boolean'` check then correctly rejected as present-but-wrong-shaped.
      ...(pricing.uncached_input_may_be_cache_writes !== undefined
        ? { uncached_input_may_be_cache_writes: pricing.uncached_input_may_be_cache_writes } : {}),
      ...(pricing.pricing_note !== undefined ? { pricing_note: pricing.pricing_note } : {}),
      cells,
    };
  }

  return { ok: true, doc: { schema: COST_ESTIMATE_SCHEMA, runtimes } };
}

function main(argv) {
  const campaignDir = argv[0];
  const outIndex = argv.indexOf('--out');
  const outPath = outIndex >= 0 ? argv[outIndex + 1] : null;
  if (!campaignDir) {
    console.error('usage: cost-estimate.mjs <campaign-dir> [--out <file>]');
    return 1;
  }
  const result = buildCostEstimate(campaignDir);
  if (!result.ok) {
    if (outPath && existsSync(outPath)) {
      // Keep the prior bytes for audit, but remove them from the active path so a failed
      // recomputation cannot be mistaken for a current estimate.
      const invalidatedPath = `${outPath}.invalidated-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
      renameSync(outPath, invalidatedPath);
      console.error(`::warning::previous --out estimate invalidated and preserved at ${invalidatedPath}`);
    }
    console.error(`::error::${result.reason}`);
    return 1;
  }
  const json = JSON.stringify(result.doc, null, 2);
  console.log(json);
  if (outPath) writeFileSync(outPath, json + '\n', 'utf8');
  return 0;
}

// import.meta.url is always a file:// URL (file:///C:/... on Windows); resolve(process.argv[1])
// comparison matches campaign-summary.mjs's own entry-point guard (a bare `file://${argv[1]}`
// string comparison never matches on Windows -- verified live there, same fix applies here).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

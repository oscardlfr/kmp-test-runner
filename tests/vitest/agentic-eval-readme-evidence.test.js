// tests/vitest/agentic-eval-readme-evidence.test.js
// Regression + regeneration-drift guard for tools/agentic-eval/readme-evidence.mjs.
// No network calls; reads only what's committed under tools/runs/ and README.md.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateSummary,
  loadSummary,
  renderReadmeBlock,
  validateCostEstimate,
  loadCostEstimate,
  computeScorecardLayout,
  renderScorecardSvg,
  buildScorecardAlt,
  buildBullets,
  armCostRange,
} from '../../tools/agentic-eval/readme-evidence.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CAMPAIGN_DATE = '2026-09-28';
const RUNS_DIR = join(REPO_ROOT, 'tools', 'runs', `evidence1-agentic-benchmark-${CAMPAIGN_DATE}`);
const README_PATH = join(REPO_ROOT, 'README.md');

function crlfNormalize(s) {
  return s.replace(/\r\n/g, '\n');
}

// WCAG 2.x relative-luminance / contrast-ratio formulas, self-contained so the
// contrast test below has no dependency on the generator exporting a color.
function relLuminance(hex) {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = channels.map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrastRatio(hexA, hexB) {
  const a = relLuminance(hexA), b = relLuminance(hexB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ---------------------------------------------------------------------------
// validateSummary -- fail-closed guard, RED then GREEN

describe('validateSummary', () => {
  const complete = () => ({
    schema: 1,
    summary_status: 'ok',
    provider_mode: 'live',
    by_runtime_arm: [
      { runtime_id: 'claude-code', arm: 'product', declared: 4 },
      { runtime_id: 'claude-code', arm: 'free', declared: 4 },
      { runtime_id: 'codex-cli', arm: 'product', declared: 4 },
      { runtime_id: 'codex-cli', arm: 'free', declared: 4 },
    ],
    provenance: { kmp_test_cli_version: { values: ['0.15.0'], mixed: false } },
  });

  it('accepts a complete, live, schema-1 summary with all 4 groups at declared:4', () => {
    expect(validateSummary(complete())).toEqual([]);
  });

  it('rejects schema !== 1', () => {
    const s = complete(); s.schema = 2;
    const errors = validateSummary(s);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('schema');
  });

  it('rejects summary_status !== "ok"', () => {
    const s = complete(); s.summary_status = 'partial';
    expect(validateSummary(s).join(' ')).toContain('summary_status');
  });

  it('rejects provider_mode !== "live"', () => {
    const s = complete(); s.provider_mode = 'dry_run';
    expect(validateSummary(s).join(' ')).toContain('provider_mode');
  });

  it('rejects a missing (runtime, arm) group', () => {
    const s = complete(); s.by_runtime_arm = s.by_runtime_arm.slice(0, 3);
    const errors = validateSummary(s);
    expect(errors.some(e => e.includes('4 (runtime x arm) groups'))).toBe(true);
  });

  it('rejects a group with declared !== 4', () => {
    const s = complete(); s.by_runtime_arm[0].declared = 3;
    expect(validateSummary(s).some(e => e.includes('declared must be 4'))).toBe(true);
  });

  it('rejects provenance.kmp_test_cli_version.mixed: true (a campaign must never silently pick one of several versions)', () => {
    const s = complete(); s.provenance.kmp_test_cli_version = { values: ['0.14.0', '0.15.0'], mixed: true };
    expect(validateSummary(s).some(e => e.includes('kmp_test_cli_version'))).toBe(true);
  });

  it('rejects provenance.kmp_test_cli_version.values.length !== 1 (0 or 2+ recorded values)', () => {
    const s = complete(); s.provenance.kmp_test_cli_version = { values: [], mixed: false };
    expect(validateSummary(s).some(e => e.includes('kmp_test_cli_version'))).toBe(true);
  });

  it('rejects a missing provenance.kmp_test_cli_version entirely', () => {
    const s = complete(); delete s.provenance;
    expect(validateSummary(s).some(e => e.includes('kmp_test_cli_version'))).toBe(true);
  });

  it('loadSummary throws (does not silently proceed) on an incomplete summary file on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'readme-evidence-'));
    const path = join(dir, 'campaign-summary.json');
    try {
      const incomplete = complete();
      incomplete.summary_status = 'error';
      writeFileSync(path, JSON.stringify(incomplete));
      expect(() => loadSummary(path)).toThrow(/summary_status/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// validateCostEstimate -- fail-closed guard, same philosophy as validateSummary

describe('validateCostEstimate', () => {
  const completeCells = () => {
    const cells = [];
    for (const arm of ['product', 'free']) {
      for (let i = 0; i < 4; i++) {
        cells.push({ runtime_id: 'claude-code', arm, order_index: i, tokens: { input: 1, output: 1, cache_read: 1, cache_creation: 1 } });
      }
    }
    return cells;
  };
  const complete = () => ({
    schema: 1,
    pricing: { per_million_tokens: { input: 2, cache_write_5m: 2.5, cache_write_1h: 4, cache_read: 0.2, output: 10 } },
    cells: completeCells(),
  });

  it('accepts a complete, schema-1 cost estimate with 4 claude-code cells per arm and a full price table', () => {
    expect(validateCostEstimate(complete())).toEqual([]);
  });

  it('rejects schema !== 1', () => {
    const d = complete(); d.schema = 2;
    expect(validateCostEstimate(d).join(' ')).toContain('schema');
  });

  it('rejects a price table missing any of the 5 required keys', () => {
    const d = complete(); delete d.pricing.per_million_tokens.cache_write_1h;
    expect(validateCostEstimate(d).join(' ')).toContain('cache_write_1h');
  });

  it('rejects fewer than 4 claude-code cells in either arm', () => {
    const d = complete(); d.cells = d.cells.filter(c => !(c.arm === 'free' && c.order_index === 3));
    const errors = validateCostEstimate(d);
    expect(errors.some(e => e.includes('claude-code/free'))).toBe(true);
  });

  it('loadCostEstimate throws (does not silently proceed) on an incomplete file on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'readme-evidence-cost-'));
    const path = join(dir, 'cost-estimate.json');
    try {
      const incomplete = complete();
      incomplete.schema = 2;
      writeFileSync(path, JSON.stringify(incomplete));
      expect(() => loadCostEstimate(path)).toThrow(/schema/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The real, committed campaign -- regeneration must match byte for byte

describe('the committed evidence1-agentic-benchmark-2026-09-28 campaign', () => {
  let summary, costEstimate;

  beforeAll(() => {
    summary = loadSummary(join(RUNS_DIR, 'campaign-summary.json'));
    costEstimate = loadCostEstimate(join(RUNS_DIR, 'cost-estimate.json'));
  });

  it('is a valid, complete, live summary', () => {
    expect(validateSummary(summary)).toEqual([]);
  });

  it('is a valid, complete cost estimate', () => {
    expect(validateCostEstimate(costEstimate)).toEqual([]);
  });

  it('regenerating scorecard.svg matches the committed file byte for byte (CRLF-normalized)', () => {
    const committed = crlfNormalize(readFileSync(join(RUNS_DIR, 'scorecard.svg'), 'utf8'));
    const regenerated = crlfNormalize(renderScorecardSvg(summary, costEstimate));
    expect(regenerated).toBe(committed);
  });

  it('regenerating the README block matches what is committed, byte for byte (CRLF-normalized)', () => {
    const readme = crlfNormalize(readFileSync(README_PATH, 'utf8'));
    const start = readme.indexOf('<!-- agentic-benchmark:start');
    const end = readme.indexOf('<!-- agentic-benchmark:end -->') + '<!-- agentic-benchmark:end -->'.length;
    expect(start).toBeGreaterThan(-1);
    const committedBlock = readme.slice(start, end);
    const regenerated = crlfNormalize(renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate));
    expect(regenerated).toBe(committedBlock);
  });

  it('the README block contains no unresolved {{placeholder}} markers', () => {
    const readme = readFileSync(README_PATH, 'utf8');
    const start = readme.indexOf('<!-- agentic-benchmark:start');
    const end = readme.indexOf('<!-- agentic-benchmark:end -->') + '<!-- agentic-benchmark:end -->'.length;
    const block = readme.slice(start, end);
    expect(block).not.toMatch(/\{\{/);
  });

  it('every relative link/image path in the README block resolves inside this one campaign directory', () => {
    const readme = readFileSync(README_PATH, 'utf8');
    const start = readme.indexOf('<!-- agentic-benchmark:start');
    const end = readme.indexOf('<!-- agentic-benchmark:end -->') + '<!-- agentic-benchmark:end -->'.length;
    const block = readme.slice(start, end);
    const paths = [...block.matchAll(/\]\(([^)]+)\)/g)].map(m => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    // All evidence (doc, controls audit, preregistration, summary, chart) lives inside the one
    // campaign directory -- no exceptions, unlike an earlier revision that carved out docs/.
    for (const p of paths) {
      expect(p.startsWith(`tools/runs/evidence1-agentic-benchmark-${CAMPAIGN_DATE}`)).toBe(true);
    }
  });

  it('the README block links to the evidence doc, controls audit, and preregistration, all inside the campaign directory', () => {
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    const dir = `tools/runs/evidence1-agentic-benchmark-${CAMPAIGN_DATE}`;
    expect(block).toContain(`(${dir}/README.md)`);
    expect(block).toContain(`(${dir}/controls-audit.md)`);
    expect(block).toContain(`(${dir}/preregistration.md)`);
  });

  it('every file the README block links to actually exists on disk, not just in the generated text', () => {
    for (const name of ['README.md', 'controls-audit.md', 'preregistration.md', 'campaign-summary.json', 'cost-estimate.json', 'scorecard.svg']) {
      expect(existsSync(join(RUNS_DIR, name)), `${name} should exist in ${RUNS_DIR}`).toBe(true);
    }
    // The old two-chart shape must NOT exist -- replaced by the scorecard redesign.
    expect(existsSync(join(RUNS_DIR, 'outcomes.svg'))).toBe(false);
    expect(existsSync(join(RUNS_DIR, 'effort.svg'))).toBe(false);
    // The pre-consolidation top-level file must NOT exist -- it was moved inside the directory.
    expect(existsSync(`${RUNS_DIR}.md`)).toBe(false);
  });

  it('no file in the bundle except preregistration.md still names the old top-level evidence file', () => {
    // preregistration.md is hash-locked verbatim text (see the describe block below) -- its own
    // internal mention of a planning-doc filename is part of the immutable original and must
    // never be "fixed" by this or any future sweep, even if it happened to contain a similar
    // string. It doesn't today (verified: this loop's own exclusion is defensive, not covering a
    // known current match), but the exclusion documents the rule regardless.
    const staleRef = 'evidence1-agentic-benchmark-2026-09-28.md';
    for (const name of ['README.md', 'controls-audit.md', 'campaign-summary.json', 'cost-estimate.json']) {
      const content = readFileSync(join(RUNS_DIR, name), 'utf8');
      expect(content, `${name} should not reference the pre-consolidation top-level filename`).not.toContain(staleRef);
    }
  });

  it('the README block has no markdown table (dropped per review: it conveyed nothing clearly)', () => {
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    expect(block).not.toMatch(/\|---/);
    expect(block).not.toMatch(/^\|.*\|$/m);
  });

  it('the README block never mentions "strict" (strict-success line was dropped; the evidence doc keeps it with the full explanation)', () => {
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    // Word-boundary, not a bare substring check -- "restricted network" (required
    // wording, asserted elsewhere in this file) contains "strict" as a substring.
    expect(block.toLowerCase()).not.toMatch(/\bstrict\b/);
  });

  it('the README block never says "Full answer correct" (dropped per review: ambiguity-sensitive, explained in the evidence doc)', () => {
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    expect(block).not.toMatch(/Full answer/i);
  });

  it('never names the scenario\'s ground truth (module path, specific numeric answers) in generated text', () => {
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    // Ground truth lives only in the (unshipped) evidence doc under tools/runs/,
    // never in README.md (shipped in the npm tarball). Word-boundary match, and not
    // preceded by "." -- a bare substring/boundary check false-positives on "2.1.238"
    // (the Claude Code version, containing "23" mid-token) and on "$0.15" (a cost
    // figure, containing "15" right after the decimal point).
    expect(block).not.toMatch(/nowinandroid.*(core|feature|app):/i);
    expect(block).not.toMatch(/(?<!\.)\b23\b/);
    expect(block).not.toMatch(/(?<!\.)\b15\b/);
  });

  it('never uses the word "baseline" to label an arm', () => {
    expect(renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate).toLowerCase()).not.toContain('baseline');
  });

  it('states no ratio (e.g. "2x faster") and no pooled cross-runtime row', () => {
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    expect(block).not.toMatch(/\d+(\.\d+)?x\s*(faster|slower|cheaper)/i);
    expect(block).not.toMatch(/all agents/i);
  });

  it('uses the exact overridden agent labels, never the proposal draft\'s originals', () => {
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    expect(block).toContain('Claude Code 2.1.238 · claude-sonnet-5 · effort not set by the harness (docs default: high)');
    expect(block).toContain('Codex CLI 0.154.0 · gpt-5.6-terra · reasoning effort low');
  });

  it('uses "restricted network (provider APIs only)", never "sealed"', () => {
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    expect(block).toContain('restricted network (provider APIs only)');
    expect(block.toLowerCase()).not.toContain('sealed');
  });

  it('the Scope line names the kmp-test version measured, read from provenance.kmp_test_cli_version, never hardcoded', () => {
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    expect(block).toContain('kmp-test 0.15.0');
    expect(summary.provenance.kmp_test_cli_version.values).toEqual(['0.15.0']); // the real committed data
    // Mutating the fixture's version changes the output -- proves this is read from the data,
    // not a literal baked into the generator (unlike the Claude Code/Codex CLI version strings,
    // which this review round did not ask to change).
    const mutated = { ...summary, provenance: { ...summary.provenance, kmp_test_cli_version: { values: ['0.16.0'], mixed: false } } };
    const mutatedBlock = renderReadmeBlock(mutated, CAMPAIGN_DATE, costEstimate);
    expect(mutatedBlock).toContain('kmp-test 0.16.0');
    expect(mutatedBlock).not.toContain('kmp-test 0.15.0');
  });

  it('drops the test-invocations/retries clause entirely (schema 1 carries neither field)', () => {
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    expect(block).not.toMatch(/test runs per session/);
    expect(block).not.toMatch(/retries \S+ \/ \S+/);
  });

  it('never estimates a cost for Codex CLI (schema 1 has no token data for it)', () => {
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    expect(block).not.toMatch(/Codex CLI estimated/);
    expect(block).toContain('not estimated');
  });

  it('renders exactly 3 bullets, each an exact match against an independent recomputation from the committed JSON', () => {
    // Recomputes from the raw committed JSON without calling any of the module's own
    // helpers for the numbers -- this proves the FORMULAS are right, not just that the
    // module agrees with itself.
    const RUNS_PATH_REL = `tools/runs/evidence1-agentic-benchmark-${CAMPAIGN_DATE}`;
    const gp = r => summary.by_runtime_arm.find(g => g.runtime_id === r && g.arm === 'product');
    const gf = r => summary.by_runtime_arm.find(g => g.runtime_id === r && g.arm === 'free');
    const cellsOf = (r, arm) => summary.cells.filter(c => c.runtime_id === r && c.arm === arm);
    const allGroups = summary.by_runtime_arm;
    const totalMatched = allGroups.reduce((s, g) => s + g.key_facts_match.matched, 0);
    const totalOf = allGroups.reduce((s, g) => s + g.key_facts_match.of, 0);
    const bullet1 = `Both agents reported the key facts correctly in every session, with and without kmp-test (${totalMatched}/${totalOf}).`;

    const price = costEstimate.pricing.per_million_tokens;
    const cost = (tokens, key) => (tokens.input * price.input + tokens.cache_creation * price[key] + tokens.cache_read * price.cache_read + tokens.output * price.output) / 1e6;
    const range = arm => {
      const cells = costEstimate.cells.filter(c => c.runtime_id === 'claude-code' && c.arm === arm);
      const low = Math.min(...cells.map(c => cost(c.tokens, 'cache_write_5m')));
      const high = Math.max(...cells.map(c => cost(c.tokens, 'cache_write_1h')));
      return `$${low.toFixed(2)}–$${high.toFixed(2)}`;
    };
    // Independent per-session duration range, straight from cells[].duration_ms -- not via any
    // module helper -- so this test can't pass just because it agrees with the generator's own bug.
    const durationRange = (r, arm) => {
      const minutes = cellsOf(r, arm).map(c => c.duration_ms / 60000);
      return `${Math.min(...minutes).toFixed(1)}–${Math.max(...minutes).toFixed(1)}`;
    };

    const claudeWallWith = (gp('claude-code').duration_ms.median / 60000).toFixed(1);
    const claudeWallWithout = (gf('claude-code').duration_ms.median / 60000).toFixed(1);
    const claudeWallPhrase = claudeWallWith === claudeWallWithout
      ? `same median wall-clock (${claudeWallWith} min)`
      : `median wall-clock ${claudeWallWith} vs ${claudeWallWithout} min (per-session range ${durationRange('claude-code', 'product')} vs ${durationRange('claude-code', 'free')} min; [breakdown](${RUNS_PATH_REL}/README.md#results--campaign-16-sessions))`;
    const bullet2 = `Claude Code (Sonnet 5) with kmp-test: median ${Math.round(gp('claude-code').tool_calls_total.median)} tool calls vs ${Math.round(gf('claude-code').tool_calls_total.median)} without, ${claudeWallPhrase}, estimated API cost ${range('product')} vs ${range('free')} per session.`;

    const codexWallWith = (gp('codex-cli').duration_ms.median / 60000).toFixed(1);
    const codexWallWithout = (gf('codex-cli').duration_ms.median / 60000).toFixed(1);
    const codexWallPhrase = codexWallWith === codexWallWithout
      ? `same median wall-clock (${codexWallWith} min)`
      : `median wall-clock ${codexWallWith} vs ${codexWallWithout} min (per-session range ${durationRange('codex-cli', 'product')} vs ${durationRange('codex-cli', 'free')} min; [breakdown](${RUNS_PATH_REL}/README.md#results--campaign-16-sessions))`;
    const bullet3 = `Codex CLI (gpt-5.6-terra, low reasoning effort): median ${Math.round(gp('codex-cli').tool_calls_total.median)} tool calls with kmp-test vs ${Math.round(gf('codex-cli').tool_calls_total.median)} without; ${codexWallPhrase}.`;

    expect(buildBullets(summary, costEstimate, RUNS_PATH_REL)).toEqual([bullet1, bullet2, bullet3]);

    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    expect(block).toContain(`- ${bullet1}`);
    expect(block).toContain(`- ${bullet2}`);
    expect(block).toContain(`- ${bullet3}`);

    // This campaign's real data hits both branches this test cares about: the
    // ceiling case for bullet 1, and an EQUAL Claude median (forcing "same", no range
    // appended) vs a DIFFERENT Codex median (forcing "vs" plus the range+link) for the
    // wall-clock phrase -- so this one assertion, against real data, already exercises
    // both wallClockPhrase branches.
    expect(bullet2).toContain('same median wall-clock');
    expect(bullet2).not.toContain('per-session range'); // equal-medians branch appends no range
    expect(bullet3).toMatch(/median wall-clock \d+\.\d vs \d+\.\d min \(per-session range \d+\.\d–\d+\.\d vs \d+\.\d–\d+\.\d min; \[breakdown\]\(.+#results--campaign-16-sessions\)\)/);
    // The auditor's own independently verified target text for this exact campaign's data.
    expect(bullet3).toBe(
      'Codex CLI (gpt-5.6-terra, low reasoning effort): median 13 tool calls with kmp-test vs 12 without; ' +
      'median wall-clock 4.8 vs 3.7 min (per-session range 3.3–7.9 vs 3.3–4.2 min; ' +
      `[breakdown](${RUNS_PATH_REL}/README.md#results--campaign-16-sessions)).`
    );
  });

  it('the linked "Results — campaign (16 sessions)" heading actually exists in the evidence doc', () => {
    const evidenceDoc = readFileSync(join(RUNS_DIR, 'README.md'), 'utf8');
    expect(evidenceDoc).toMatch(/^## Results — campaign \(16 sessions\)$/m);
  });

  it('the README block never asserts a cause for the Codex wall-clock difference (that stays in the evidence doc, behind the link)', () => {
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    expect(block).not.toMatch(/re-ran kmp-test/i);
    expect(block).not.toMatch(/because/i);
    expect(block).not.toMatch(/caused by/i);
  });
});

// ---------------------------------------------------------------------------
// Bullet fallback branches -- synthetic fixtures, not exercised by this
// campaign's real (ceiling / ceiling) data. A future non-ceiling campaign
// needs a defined rendering, not a silent gap.

describe('bullet fallback branches (synthetic fixtures)', () => {
  const baseGroup = (runtime, arm, overrides = {}) => ({
    runtime_id: runtime,
    arm,
    declared: 4,
    key_facts_match: { matched: 4, of: 4 },
    duration_ms: { n: 4, median: 180000 },
    tool_calls_total: { n: 4, median: 10 },
    ...overrides,
  });
  // 4 degenerate cells per group, each exactly at that group's own median (min=max=median) --
  // deterministic and sufficient for these tests, none of which assert a specific range value.
  // Callers that DO mutate by_runtime_arm after baseSummary() must call this again to keep
  // summary.cells consistent with the group they just changed.
  const cellsFromGroups = (groups) => groups.flatMap((g) =>
    Array.from({ length: 4 }, (_, i) => ({ runtime_id: g.runtime_id, arm: g.arm, round_index: i, duration_ms: g.duration_ms.median }))
  );
  const baseSummary = (overrides) => {
    const by_runtime_arm = [
      baseGroup('claude-code', 'product'),
      baseGroup('claude-code', 'free'),
      baseGroup('codex-cli', 'product'),
      baseGroup('codex-cli', 'free'),
      ...(overrides || []),
    ].filter((g, i, arr) => arr.findIndex(x => x.runtime_id === g.runtime_id && x.arm === g.arm) === i);
    return {
      schema: 1, summary_status: 'ok', provider_mode: 'live', by_runtime_arm, cells: cellsFromGroups(by_runtime_arm),
      provenance: { kmp_test_cli_version: { values: ['0.15.0'], mixed: false } },
    };
  };
  const baseCostEstimate = () => {
    const cells = [];
    for (const arm of ['product', 'free']) {
      for (let i = 0; i < 4; i++) {
        cells.push({ runtime_id: 'claude-code', arm, order_index: i, tokens: { input: 10, output: 1000, cache_read: 100000, cache_creation: 20000 } });
      }
    }
    return {
      schema: 1,
      pricing: { per_million_tokens: { input: 2, cache_write_5m: 2.5, cache_write_1h: 4, cache_read: 0.2, output: 10 } },
      cells,
    };
  };

  const FAKE_RUNS_PATH = 'tools/runs/evidence1-agentic-benchmark-fake-date';

  it('bullet 1 falls back to per-agent k/n phrasing when not every group is at the key-facts ceiling', () => {
    const summary = baseSummary([
      { ...baseGroup('claude-code', 'product'), key_facts_match: { matched: 3, of: 4 } },
    ]);
    // Replace the claude-code/product group with the degraded one.
    summary.by_runtime_arm = summary.by_runtime_arm.map(g =>
      g.runtime_id === 'claude-code' && g.arm === 'product' ? { ...g, key_facts_match: { matched: 3, of: 4 } } : g
    );
    const [bullet1] = buildBullets(summary, baseCostEstimate(), FAKE_RUNS_PATH);
    expect(bullet1).toBe(
      'Claude Code · claude-sonnet-5 reported the key facts correctly in 3/4 sessions with kmp-test and 4/4 without; ' +
      'Codex CLI · gpt-5.6-terra reported the key facts correctly in 4/4 sessions with kmp-test and 4/4 without.'
    );
    expect(bullet1).not.toContain('16/16');
    expect(bullet1).not.toContain('every session');
  });

  it('the Claude bullet uses the "vs" wall-clock phrase (not "same") when its two medians differ, with a per-session range and breakdown link', () => {
    const summary = baseSummary();
    summary.by_runtime_arm = summary.by_runtime_arm.map(g =>
      g.runtime_id === 'claude-code' && g.arm === 'free' ? { ...g, duration_ms: { n: 4, median: 240000 } } : g
    );
    summary.cells = cellsFromGroups(summary.by_runtime_arm); // keep cells consistent with the override above
    const [, bullet2] = buildBullets(summary, baseCostEstimate(), FAKE_RUNS_PATH);
    expect(bullet2).toContain('median wall-clock 3.0 vs 4.0 min');
    expect(bullet2).not.toContain('same median wall-clock');
    // Degenerate synthetic cells (all 4 equal the group's own median) -> a degenerate but
    // well-defined range, proving the range/link machinery actually fires on this branch.
    expect(bullet2).toContain('(per-session range 3.0–3.0 vs 4.0–4.0 min; ' +
      `[breakdown](${FAKE_RUNS_PATH}/README.md#results--campaign-16-sessions))`);
  });

  it('the Codex bullet uses the "same" wall-clock phrase when its two medians are equal at 1 decimal, with no range appended', () => {
    const summary = baseSummary();
    const [, , bullet3] = buildBullets(summary, baseCostEstimate(), FAKE_RUNS_PATH);
    expect(bullet3).toContain('same median wall-clock (3.0 min)');
    expect(bullet3).not.toContain('per-session range');
    expect(bullet3).not.toContain('breakdown');
    // The bullet's tool-calls clause legitimately says "... vs ..." too (a
    // different comparison) -- assert against the specific wall-clock "vs"
    // shape, not a blanket "no vs anywhere in the bullet".
    expect(bullet3).not.toMatch(/median wall-clock \d+\.\d vs \d+\.\d min/);
  });
});

// ---------------------------------------------------------------------------
// Scorecard layout -- computeScorecardLayout is the single source of truth
// for every (x, y); this proves it never produces overlapping text, which is
// exactly the defect class the redesign was fixing.

describe('scorecard layout: no overlapping text', () => {
  let summary, costEstimate;

  beforeAll(() => {
    summary = loadSummary(join(RUNS_DIR, 'campaign-summary.json'));
    costEstimate = loadCostEstimate(join(RUNS_DIR, 'cost-estimate.json'));
  });

  // Geometric bounding-box check, not just a sequential-Y-order check: since an arm label
  // ("with"/"without") now sits on the SAME row as its bar and value label (by design -- see the
  // gutter layout below), a same-row pair legitimately shares one y with a different x, which a
  // pure Y-order check can't distinguish from a real collision. Approximate text width per the
  // review's own formula (chars x fontSize x 0.6); approximate vertical extent as ascent above the
  // baseline and a small descent below, which is what "y" means for SVG <text>.
  function approxTextBox(item) {
    const width = item.text.length * item.fontSize * 0.6;
    const x0 = item.anchor === 'end' ? item.x - width : item.x;
    return { x0, x1: x0 + width, y0: item.y - item.fontSize * 0.8, y1: item.y + item.fontSize * 0.25 };
  }
  function barBox(item) {
    return { x0: item.x, x1: item.x + item.w, y0: item.y, y1: item.y + item.h };
  }
  function boxesOverlap(a, b) {
    return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  }

  it('no two text boxes, and no text box and bar, overlap within a column (geometric check)', () => {
    const layout = computeScorecardLayout(summary, costEstimate);
    for (const columnId of ['claude-code', 'codex-cli']) {
      const texts = layout.items.filter(i => i.kind === 'text' && i.column === columnId).map(i => ({ ...approxTextBox(i), label: i.text }));
      const bars = layout.items.filter(i => i.kind === 'bar' && i.column === columnId).map(i => ({ ...barBox(i), label: `bar(${i.fill})@${i.y}` }));
      const boxes = [...texts, ...bars];
      expect(boxes.length).toBeGreaterThan(0);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          expect(boxesOverlap(boxes[i], boxes[j]), `${columnId}: "${boxes[i].label}" overlaps "${boxes[j].label}"`).toBe(false);
        }
      }
    }
  });

  it('the header title and subtitle do not overlap', () => {
    const layout = computeScorecardLayout(summary, costEstimate);
    const title = layout.items.find(i => i.role === 'title');
    const subtitle = layout.items.find(i => i.role === 'subtitle');
    expect(subtitle.y).toBeGreaterThanOrEqual(title.y + title.fontSize + 4);
  });

  it('the chart title is "Results at a glance", not a duplicate of the README H3 directly above the image', () => {
    const layout = computeScorecardLayout(summary, costEstimate);
    const title = layout.items.find(i => i.role === 'title');
    expect(title.text).toBe('Results at a glance');
    const svg = renderScorecardSvg(summary, costEstimate);
    expect(svg).toContain('<title>Results at a glance</title>');
    expect(svg).not.toContain('Agent sessions with and without kmp-test');
  });

  it('the alt text says "API" (acronym), never lowercase "api", even though the rest of each metric label is lowercased', () => {
    const alt = buildScorecardAlt(summary, costEstimate);
    expect(alt).toContain('estimated API cost per session');
    expect(alt).not.toMatch(/\bapi\b/); // lowercase "api" must not appear anywhere
    // Still lowercased apart from the acronym -- this isn't just "never touch the label".
    expect(alt).toContain('tool calls per session (median)');
    expect(alt).toContain('wall-clock per session (median)');
  });

  it('the computed height covers every item with room to spare (nothing renders below the card)', () => {
    const layout = computeScorecardLayout(summary, costEstimate);
    const maxY = Math.max(...layout.items.filter(i => i.kind === 'text').map(i => i.y));
    expect(layout.height).toBeGreaterThan(maxY);
  });

  it('the card rect height is at least 20px below the lowest text baseline or bar bottom (not clipped)', () => {
    const layout = computeScorecardLayout(summary, costEstimate);
    const maxTextY = Math.max(...layout.items.filter(i => i.kind === 'text').map(i => i.y));
    const maxBarBottom = Math.max(...layout.items.filter(i => i.kind === 'bar').map(i => i.y + i.h));
    expect(layout.height).toBeGreaterThanOrEqual(Math.max(maxTextY, maxBarBottom) + 20);
  });

  it('the card border rect is fully inside the viewBox on all 4 sides (not flush with the edge)', () => {
    const svg = renderScorecardSvg(summary, costEstimate);
    const m = svg.match(/<rect x="(\d+(?:\.\d+)?)" y="(\d+(?:\.\d+)?)" width="(\d+(?:\.\d+)?)" height="(\d+(?:\.\d+)?)" rx="12" fill="#ffffff"/);
    expect(m).not.toBeNull();
    const [, x, y, w, h] = m.map(Number);
    const layout = computeScorecardLayout(summary, costEstimate);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
    expect(x + w).toBeLessThan(layout.width);
    expect(y + h).toBeLessThan(layout.height);
  });
});

// ---------------------------------------------------------------------------
// SVG authoring rules -- structural, not visual

describe('SVG authoring rules (github/markup sanitizer safety)', () => {
  let scorecardSvg;

  beforeAll(() => {
    const summary = loadSummary(join(RUNS_DIR, 'campaign-summary.json'));
    const costEstimate = loadCostEstimate(join(RUNS_DIR, 'cost-estimate.json'));
    scorecardSvg = renderScorecardSvg(summary, costEstimate);
  });

  it('has no <style> block, no style= attribute, and no forbidden elements', () => {
    expect(scorecardSvg).not.toMatch(/<style/i);
    expect(scorecardSvg).not.toMatch(/\sstyle=/i);
    for (const forbidden of ['<script', '<foreignObject', '<use', '<image', '<filter', '<!DOCTYPE', '<!--']) {
      expect(scorecardSvg).not.toContain(forbidden);
    }
  });

  it('declares role="img" plus <title> and <desc>', () => {
    expect(scorecardSvg).toContain('role="img"');
    expect(scorecardSvg).toMatch(/<title>[^<]+<\/title>/);
    expect(scorecardSvg).toMatch(/<desc>[^<]+<\/desc>/);
  });

  it('declares font-family as a root <svg> attribute (not CSS), using only the system font stack', () => {
    expect(scorecardSvg).toMatch(/<svg[^>]*\sfont-family="[^"]+"/);
    expect(scorecardSvg).not.toMatch(/@font-face|googleapis|fonts\./);
  });

  it('is deterministic: two independent renders are byte-identical', () => {
    const summary = loadSummary(join(RUNS_DIR, 'campaign-summary.json'));
    const costEstimate = loadCostEstimate(join(RUNS_DIR, 'cost-estimate.json'));
    expect(renderScorecardSvg(summary, costEstimate)).toBe(renderScorecardSvg(summary, costEstimate));
  });

  it('the "without" bar color has at least 3:1 contrast against white (WCAG non-text UI floor)', () => {
    // Each bar's own arm-label text (">without</text>") immediately precedes its <rect> in render
    // order -- reads the color directly off a real bar, not a legend (removed per review: it sat
    // far from the many bar rows it was meant to explain).
    const m = scorecardSvg.match(/>without<\/text>\s*<rect[^>]*fill="(#[0-9a-fA-F]{6})"/);
    expect(m).not.toBeNull();
    const withoutColor = m[1];
    expect(contrastRatio(withoutColor, '#ffffff')).toBeGreaterThanOrEqual(3.0);
  });

  it('the "with" and "without" bar colors are distinct', () => {
    const withM = scorecardSvg.match(/>with<\/text>\s*<rect[^>]*fill="(#[0-9a-fA-F]{6})"/);
    const withoutM = scorecardSvg.match(/>without<\/text>\s*<rect[^>]*fill="(#[0-9a-fA-F]{6})"/);
    expect(withM).not.toBeNull();
    expect(withoutM).not.toBeNull();
    expect(withM[1]).not.toBe(withoutM[1]);
  });

  it('every bar row is labelled with exactly one matching arm label ("with" next to a with-color bar, "without" next to a without-color bar), and no legend remains', () => {
    // The legend's own swatch used rx="2" (bars use rx="3") -- its unique structural signature,
    // now gone entirely. Not a bare substring ban on "with kmp-test": that phrase legitimately
    // still appears in the <desc> alt text's key-facts line ("key facts 4/4 with kmp-test, ..."),
    // which has nothing to do with the removed corner legend.
    expect(scorecardSvg).not.toMatch(/rx="2"/);
    const withCount = (scorecardSvg.match(/>with<\/text>/g) || []).length;
    const withoutCount = (scorecardSvg.match(/>without<\/text>/g) || []).length;
    const barCount = (scorecardSvg.match(/<rect x="\d+(?:\.\d+)?" y="\d+(?:\.\d+)?" width="[\d.]+" height="14"/g) || []).length;
    // 2 columns x 3 bar metrics (tool calls, wall-clock, cost) x 2 arms = 12 "with"/"without" bars
    // each, minus Codex's cost metric (no bars, "not estimated" instead) = 5 bars per arm per column
    // pairing... expressed simply: every "with" bar has a "with" label, every "without" bar has a
    // "without" label, one each, so the counts must be equal to each other and to the number of
    // 14px-tall bar rects actually rendered.
    expect(withCount).toBe(withoutCount);
    expect(withCount).toBeGreaterThan(0);
    expect(barCount).toBe(withCount + withoutCount);
  });
});

// ---------------------------------------------------------------------------
// CHANGELOG.md must never carry the scenario's ground truth either -- it
// ships in release archives, same reasoning as README.md shipping in the npm
// tarball. Only the (unshipped) evidence doc under tools/runs/ may state it.

describe('CHANGELOG.md ground-truth guard', () => {
  it('the README-evidence entry never names the scenario\'s module or specific numeric answers', () => {
    // Scoped to just this feature's own entry, not the whole [Unreleased] section -- that
    // section legitimately accumulates OTHER entries over time (e.g. a "### Fixed -- 0.15.0
    // never reached npm" entry from a different PR), and those contain incidental digit
    // sequences (version numbers) that would false-positive a same-file-wide check.
    const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
    const entryIdx = changelog.indexOf('### Added — README publishes');
    expect(entryIdx).toBeGreaterThan(-1);
    const nextHeaderIdx = changelog.indexOf('\n### ', entryIdx + 1);
    const entry = changelog.slice(entryIdx, nextHeaderIdx === -1 ? undefined : nextHeaderIdx);
    expect(entry).not.toMatch(/nowinandroid.*(core|feature|app):/i);
    expect(entry).not.toMatch(/\b23\b/);
    expect(entry).not.toMatch(/\b15\b/);
    expect(entry.toLowerCase()).not.toContain('baseline');
  });
});

// ---------------------------------------------------------------------------
// preregistration.md must carry the LOCKED text verbatim. A preregistration's
// evidential value depends on being published unedited -- any accuracy fix or
// clarification belongs in the publication note above the marker, never in the
// body below it. This test proves the body was not touched: it strips the note,
// then hashes what remains using real git-blob semantics and compares against
// the known blob id of the source file at its locking commit.

describe('preregistration.md: locked body is byte-for-byte the pre-registered blob', () => {
  const SOURCE_COMMIT = '15ad0dd6598c71fb12754e47ce5b024797f6a033';
  const SOURCE_PATH = 'docs/audits/evidence1-preregistration.md';
  const KNOWN_BLOB = '2d5426ca393e9ea6d4b00a8aa27567e09a0ff21b';
  const MARKER = `<!-- VERBATIM-START: everything below this line is byte-for-byte identical to blob ${KNOWN_BLOB} (${SOURCE_PATH} @ ${SOURCE_COMMIT}) -->`;

  // Reimplements `git hash-object`'s blob hashing (sha1("blob " + byteLength + "\0" + content))
  // rather than shelling out, so the test has no git-subprocess dependency. Cross-checked by hand
  // against the real `git hash-object` CLI on this exact content, including non-ASCII bytes (the
  // document uses em dashes), before this test was written.
  function gitBlobHash(content) {
    const byteLength = Buffer.byteLength(content, 'utf8');
    return createHash('sha1')
      .update(`blob ${byteLength}\0`)
      .update(content, 'utf8')
      .digest('hex');
  }

  let raw;

  beforeAll(() => {
    raw = crlfNormalize(readFileSync(join(RUNS_DIR, 'preregistration.md'), 'utf8'));
  });

  it('contains the publication-note marker exactly once', () => {
    const firstIdx = raw.indexOf(MARKER);
    expect(firstIdx).toBeGreaterThan(-1);
    expect(raw.indexOf(MARKER, firstIdx + 1)).toBe(-1);
  });

  it('the publication note (above the marker) is clearly labeled and cites the source commit + blob id', () => {
    const note = raw.slice(0, raw.indexOf(MARKER));
    expect(note).toContain('not part of the preregistered text');
    expect(note).toContain(SOURCE_COMMIT);
    expect(note).toContain(KNOWN_BLOB);
    expect(note).toContain(SOURCE_PATH);
  });

  it('the note discloses the sealed/restricted-network and Phase/step-reference clarifications, instead of silently editing the locked text', () => {
    const note = raw.slice(0, raw.indexOf(MARKER));
    expect(note.toLowerCase()).toContain('sealed');
    expect(note.toLowerCase()).toContain('restricted');
    expect(note).toMatch(/phase/i);
  });

  it('exactly one blank line separates the marker from the locked body (no drift in the splice point)', () => {
    const afterMarker = raw.slice(raw.indexOf(MARKER) + MARKER.length);
    expect(afterMarker.startsWith('\n\n')).toBe(true);
    expect(afterMarker.startsWith('\n\n\n')).toBe(false);
  });

  it('the locked body hashes to the exact pre-registered git blob -- proves it was copied, not edited', () => {
    const afterMarker = raw.slice(raw.indexOf(MARKER) + MARKER.length);
    const body = afterMarker.slice(2); // drop the one blank line asserted above
    expect(gitBlobHash(body)).toBe(KNOWN_BLOB);
  });

  it('the locked body still contains its own internal amendment markers, untouched (proof it is the full original, not a trimmed excerpt)', () => {
    const afterMarker = raw.slice(raw.indexOf(MARKER) + MARKER.length);
    const body = afterMarker.slice(2);
    expect(body).toContain('**Amendment, 2026-09-28**');
    expect(body).toContain('sealed network');
    expect(body).toContain('Phase 4 canary');
  });
});

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
  buildPlaceholders,
  renderOutcomesSvg,
  renderEffortSvg,
  renderReadmeBlock,
  validateCostEstimate,
  loadCostEstimate,
  buildCostSentence,
} from '../../tools/agentic-eval/readme-evidence.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CAMPAIGN_DATE = '2026-09-28';
const RUNS_DIR = join(REPO_ROOT, 'tools', 'runs', `evidence1-agentic-benchmark-${CAMPAIGN_DATE}`);
const README_PATH = join(REPO_ROOT, 'README.md');

function crlfNormalize(s) {
  return s.replace(/\r\n/g, '\n');
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

  it('regenerating outcomes.svg matches the committed file byte for byte (CRLF-normalized)', () => {
    const committed = crlfNormalize(readFileSync(join(RUNS_DIR, 'outcomes.svg'), 'utf8'));
    const regenerated = crlfNormalize(renderOutcomesSvg(summary));
    expect(regenerated).toBe(committed);
  });

  it('regenerating effort.svg matches the committed file byte for byte (CRLF-normalized)', () => {
    const committed = crlfNormalize(readFileSync(join(RUNS_DIR, 'effort.svg'), 'utf8'));
    const regenerated = crlfNormalize(renderEffortSvg(summary));
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
    // All evidence (doc, controls audit, preregistration, summary, SVGs) lives inside the one
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
    for (const name of ['README.md', 'controls-audit.md', 'preregistration.md', 'campaign-summary.json', 'cost-estimate.json', 'outcomes.svg', 'effort.svg']) {
      expect(existsSync(join(RUNS_DIR, name)), `${name} should exist in ${RUNS_DIR}`).toBe(true);
    }
    // The pre-consolidation top-level file must NOT exist -- it was moved inside the directory.
    expect(existsSync(`${RUNS_DIR}.md`)).toBe(false);
  });

  it('has no strict-success placeholder at all -- dropped from the generated block per review (misleading without the evidence doc\'s full explanation)', () => {
    const placeholders = buildPlaceholders(summary, CAMPAIGN_DATE);
    const keys = Object.keys(placeholders);
    expect(keys.some(k => /STRICT_SUCCESS/.test(k))).toBe(false);
  });

  it('the README block never mentions "strict" -- the strict-success line was dropped; the evidence doc keeps it with the full explanation', () => {
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    // Word-boundary, not a bare substring check -- "restricted network" (required
    // wording, asserted elsewhere in this file) contains "strict" as a substring.
    expect(block.toLowerCase()).not.toMatch(/\bstrict\b/);
  });

  it('never names the scenario\'s ground truth (module path, specific numeric answers) in generated text', () => {
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    // Ground truth lives only in the (unshipped) evidence doc under tools/runs/,
    // never in README.md (shipped in the npm tarball). Word-boundary match --
    // a bare substring check false-positives on "2.1.238" (the Claude Code
    // version, legitimately present), which contains "23" mid-token.
    expect(block).not.toMatch(/nowinandroid.*(core|feature|app):/i);
    expect(block).not.toMatch(/\b23\b/);
    expect(block).not.toMatch(/\b15\b/);
  });

  it('never uses the word "baseline" to label an arm', () => {
    expect(renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate).toLowerCase()).not.toContain('baseline');
  });

  it('states no ratio (e.g. "2x faster") and no pooled cross-runtime row', () => {
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    expect(block).not.toMatch(/\d+(\.\d+)?x\s*(faster|slower|cheaper)/i);
    expect(block).not.toMatch(/all agents/i);
  });

  it('says the exact ceiling sentence when key facts matched in every cell', () => {
    // This campaign's real data is a ceiling case (4/4 in all 4 groups) --
    // locks the exact wording, not just "some sentence exists".
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    expect(block).toContain('No difference in key facts at n=4 (16/16).');
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

  it('drops the test-invocations/retries clause entirely (schema 1 carries neither field)', () => {
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    expect(block).not.toMatch(/test runs per session/);
    expect(block).not.toMatch(/retries \S+ \/ \S+/);
  });

  it('the cost sentence is present and matches an independent recomputation from cost-estimate.json', () => {
    // Recomputes from the raw committed JSON without calling any of the module's own
    // cost helpers -- this proves the FORMULA is right, not just that the module agrees
    // with itself. Sonnet 5 pricing per million tokens, from cost-estimate.json.
    const price = costEstimate.pricing.per_million_tokens;
    const cost = (tokens, cacheWriteKey) => (
      tokens.input * price.input +
      tokens.cache_creation * price[cacheWriteKey] +
      tokens.cache_read * price.cache_read +
      tokens.output * price.output
    ) / 1e6;
    const range = arm => {
      const cells = costEstimate.cells.filter(c => c.runtime_id === 'claude-code' && c.arm === arm);
      const low = Math.min(...cells.map(c => cost(c.tokens, 'cache_write_5m')));
      const high = Math.max(...cells.map(c => cost(c.tokens, 'cache_write_1h')));
      return `$${low.toFixed(3)}–$${high.toFixed(3)}`;
    };
    const expected = `Claude Code estimated API cost per session: ${range('product')} with kmp-test, ${range('free')} without (recorded tokens × published Sonnet 5 prices; an estimate, not a bill). Not estimated for Codex CLI.`;
    expect(buildCostSentence(costEstimate)).toBe(expected);

    // These are the auditor's own independently verified ranges for this exact
    // campaign's data -- reproducing them exactly, not just "some range", is the point.
    expect(expected).toBe('Claude Code estimated API cost per session: $0.086–$0.137 with kmp-test, $0.146–$0.218 without (recorded tokens × published Sonnet 5 prices; an estimate, not a bill). Not estimated for Codex CLI.');

    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    expect(block).toContain(expected);
  });

  it('never estimates a cost for Codex CLI (schema 1 has no token data for it)', () => {
    const block = renderReadmeBlock(summary, CAMPAIGN_DATE, costEstimate);
    expect(block).not.toMatch(/Codex CLI estimated/);
  });
});

// ---------------------------------------------------------------------------
// SVG authoring rules -- structural, not visual

describe('SVG authoring rules (github/markup sanitizer safety)', () => {
  let outcomesSvg, effortSvg;

  beforeAll(() => {
    const summary = loadSummary(join(RUNS_DIR, 'campaign-summary.json'));
    outcomesSvg = renderOutcomesSvg(summary);
    effortSvg = renderEffortSvg(summary);
  });

  it.each([['outcomes.svg', () => outcomesSvg], ['effort.svg', () => effortSvg]])(
    '%s has no <style> block, no style= attribute, and no forbidden elements',
    (_name, get) => {
      const svg = get();
      expect(svg).not.toMatch(/<style/i);
      expect(svg).not.toMatch(/\sstyle=/i);
      for (const forbidden of ['<script', '<foreignObject', '<use', '<image', '<filter', '<!DOCTYPE', '<!--']) {
        expect(svg).not.toContain(forbidden);
      }
    }
  );

  it.each([['outcomes.svg', () => outcomesSvg], ['effort.svg', () => effortSvg]])(
    '%s declares role="img" plus <title> and <desc>',
    (_name, get) => {
      const svg = get();
      expect(svg).toContain('role="img"');
      expect(svg).toMatch(/<title>[^<]+<\/title>/);
      expect(svg).toMatch(/<desc>[^<]+<\/desc>/);
    }
  );

  it.each([['outcomes.svg', () => outcomesSvg], ['effort.svg', () => effortSvg]])(
    '%s uses only the system font stack, no webfonts',
    (_name, get) => {
      const svg = get();
      expect(svg).not.toMatch(/@font-face|googleapis|fonts\./);
    }
  );

  it('outcomes.svg is deterministic: two independent renders are byte-identical', () => {
    const summary = loadSummary(join(RUNS_DIR, 'campaign-summary.json'));
    expect(renderOutcomesSvg(summary)).toBe(renderOutcomesSvg(summary));
  });

  it('effort.svg is deterministic: two independent renders are byte-identical', () => {
    const summary = loadSummary(join(RUNS_DIR, 'campaign-summary.json'));
    expect(renderEffortSvg(summary)).toBe(renderEffortSvg(summary));
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

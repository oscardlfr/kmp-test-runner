// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for tools/measure-token-cost.js — covers the cross-model branch
// added in v0.3.9. The gradle-driven default mode is exercised end-to-end by
// the docs/token-cost-measurement.md captures and is not re-tested here.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// vi.mock is hoisted; declare the mock fns via vi.hoisted so the factory
// closure can see them before the module under test is imported.
const countTokensMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  function FakeAnthropic() {
    return { messages: { countTokens: countTokensMock } };
  }
  FakeAnthropic.APIError = APIError;
  return { default: FakeAnthropic };
});

import {
  parseAnthropicModels,
  parseArgs,
  countTokensAnthropic,
  countTokensCl100k,
  loadCaptures,
  formatCrossModelTable,
  summariseCrossModelVariation,
  runCrossModelMode,
} from '../../tools/measure-token-cost.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

// ----- helpers --------------------------------------------------------------

function makeSink() {
  const log = vi.fn();
  const error = vi.fn();
  return { sink: { log, error }, log, error };
}

function makeFakeRunsDir(files) {
  // files: { 'A-foo-run1.txt': 'content', ... }
  const dir = mkdtempSync(path.join(tmpdir(), 'kmp-test-runs-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

// ----- parseAnthropicModels -------------------------------------------------

describe('parseAnthropicModels', () => {
  it('returns [] for empty / undefined input', () => {
    expect(parseAnthropicModels()).toEqual([]);
    expect(parseAnthropicModels('')).toEqual([]);
  });
  it('splits CSV and trims whitespace', () => {
    expect(parseAnthropicModels('claude-opus-4-7, claude-sonnet-4-6 ,claude-haiku-4-5'))
      .toEqual(['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5']);
  });
  it('drops empty entries from trailing commas', () => {
    expect(parseAnthropicModels('a,,b,')).toEqual(['a', 'b']);
  });
});

// ----- parseArgs ------------------------------------------------------------

describe('parseArgs', () => {
  let exitSpy;
  let errSpy;
  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('__exit__'); });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('parses --project-root and defaults', () => {
    const out = parseArgs(['--project-root', '/tmp/x']);
    expect(out.projectRoot).toMatch(/x$/);
    expect(out.runs).toBe(1);
    expect(out.testTask).toBe('test');
    expect(out.anthropicModels).toEqual([]);
  });

  it('parses --anthropic-models without --project-root', () => {
    const out = parseArgs(['--anthropic-models', 'claude-opus-4-7,claude-sonnet-4-6']);
    expect(out.anthropicModels).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6']);
    expect(out.projectRoot).toBeUndefined();
  });

  it('exits 2 when neither --project-root nor --anthropic-models is set', () => {
    expect(() => parseArgs([])).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('accepts --runs and --test-task', () => {
    const out = parseArgs(['--project-root', '/tmp/y', '--runs', '5', '--test-task', 'desktopTest']);
    expect(out.runs).toBe(5);
    expect(out.testTask).toBe('desktopTest');
  });
});

// ----- countTokensAnthropic -------------------------------------------------

describe('countTokensAnthropic', () => {
  beforeEach(() => countTokensMock.mockReset());

  it('returns ok=true with input_tokens on success', async () => {
    countTokensMock.mockResolvedValueOnce({ input_tokens: 42 });
    const client = { messages: { countTokens: countTokensMock } };
    const r = await countTokensAnthropic(client, 'claude-opus-4-7', 'hello');
    expect(r).toEqual({ ok: true, tokens: 42 });
    expect(countTokensMock).toHaveBeenCalledWith({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('maps 429 to rate_limited', async () => {
    countTokensMock.mockRejectedValueOnce({ status: 429, message: 'too many requests' });
    const client = { messages: { countTokens: countTokensMock } };
    const r = await countTokensAnthropic(client, 'claude-opus-4-7', 'x');
    expect(r).toEqual({ ok: false, error: 'rate_limited' });
  });

  it('maps 401 to auth_failed', async () => {
    countTokensMock.mockRejectedValueOnce({ status: 401, message: 'invalid key' });
    const client = { messages: { countTokens: countTokensMock } };
    const r = await countTokensAnthropic(client, 'claude-opus-4-7', 'x');
    expect(r).toEqual({ ok: false, error: 'auth_failed' });
  });

  it('maps 404 to model_not_found', async () => {
    countTokensMock.mockRejectedValueOnce({ status: 404, message: 'no such model' });
    const client = { messages: { countTokens: countTokensMock } };
    const r = await countTokensAnthropic(client, 'claude-fake-9-9', 'x');
    expect(r).toEqual({ ok: false, error: 'model_not_found' });
  });

  it('returns no_input_tokens_in_response when SDK returns malformed body', async () => {
    countTokensMock.mockResolvedValueOnce({});
    const client = { messages: { countTokens: countTokensMock } };
    const r = await countTokensAnthropic(client, 'claude-opus-4-7', 'x');
    expect(r).toEqual({ ok: false, error: 'no_input_tokens_in_response' });
  });

  it('passes through other error messages, truncated', async () => {
    const long = 'x'.repeat(200);
    countTokensMock.mockRejectedValueOnce({ message: long });
    const client = { messages: { countTokens: countTokensMock } };
    const r = await countTokensAnthropic(client, 'claude-opus-4-7', 'x');
    expect(r.ok).toBe(false);
    expect(r.error.length).toBeLessThanOrEqual(80);
  });
});

// ----- loadCaptures ---------------------------------------------------------

describe('loadCaptures', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('returns [] for missing directory', () => {
    expect(loadCaptures(path.join(tmpdir(), 'definitely-not-here-' + Date.now()))).toEqual([]);
  });

  it('reads matching captures and ignores non-matching files', () => {
    dir = makeFakeRunsDir({
      'A-rawgradle-run1.txt': 'AAA',
      'B-markdown-run1.txt': 'BBB',
      'C-json-run1.txt': 'CCC',
      'cross-model-results.txt': 'should be ignored',
      'README.md': 'also ignored',
    });
    const caps = loadCaptures(dir);
    expect(caps.map((c) => c.approach)).toEqual(['A', 'B', 'C']);
    expect(caps.map((c) => c.text)).toEqual(['AAA', 'BBB', 'CCC']);
    expect(caps.every((c) => c.runIndex === 1)).toBe(true);
  });

  it('sorts multi-run captures by approach then runIndex', () => {
    dir = makeFakeRunsDir({
      'A-x-run2.txt': '2',
      'A-x-run1.txt': '1',
      'B-y-run1.txt': '3',
    });
    const caps = loadCaptures(dir);
    expect(caps.map((c) => c.file)).toEqual(['A-x-run1.txt', 'A-x-run2.txt', 'B-y-run1.txt']);
  });
});

// ----- formatCrossModelTable ------------------------------------------------

describe('formatCrossModelTable', () => {
  it('produces a markdown table with model columns', () => {
    const rows = [
      { approach: 'A', file: 'A-foo-run1.txt', cl100k: 1000, perModel: { 'claude-opus-4-7': 1100, 'claude-sonnet-4-6': 1050 } },
      { approach: 'B', file: 'B-foo-run1.txt', cl100k: 100,  perModel: { 'claude-opus-4-7': 105,  'claude-sonnet-4-6': '[error: rate_limited]' } },
    ];
    const out = formatCrossModelTable(rows, ['claude-opus-4-7', 'claude-sonnet-4-6']);
    expect(out).toContain('| Approach | Capture | cl100k_base | claude-opus-4-7 | claude-sonnet-4-6 |');
    expect(out).toContain('| A | `A-foo-run1.txt` | 1000 | 1100 | 1050 |');
    expect(out).toContain('| B | `B-foo-run1.txt` | 100 | 105 | [error: rate_limited] |');
  });
});

// ----- summariseCrossModelVariation -----------------------------------------

describe('summariseCrossModelVariation', () => {
  it('computes spread across cl100k + per-model numeric values', () => {
    const rows = [
      { approach: 'A', file: 'A.txt', cl100k: 1000, perModel: { m1: 1100, m2: 950 } },
    ];
    const out = summariseCrossModelVariation(rows, ['m1', 'm2']);
    // min=950, max=1100, spread = (1100-950)/950 = 15.789…%
    expect(out[0].spreadPct).toBeCloseTo(15.8, 1);
  });

  it('returns spread null when only one numeric value is available', () => {
    const rows = [{ approach: 'A', file: 'A.txt', cl100k: 1000, perModel: { m1: '[error: x]', m2: '[error: y]' } }];
    const out = summariseCrossModelVariation(rows, ['m1', 'm2']);
    // Only cl100k is numeric → cannot compute spread
    expect(out[0].spreadPct).toBe(null);
  });
});

// ----- runCrossModelMode ----------------------------------------------------

describe('runCrossModelMode', () => {
  let dir;
  beforeEach(() => countTokensMock.mockReset());
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('returns exitCode 2 when there are no captures', async () => {
    dir = makeFakeRunsDir({});
    const { sink, error } = makeSink();
    const result = await runCrossModelMode(
      { anthropicModels: ['claude-opus-4-7'] },
      () => ({ messages: { countTokens: countTokensMock } }),
      sink,
      dir
    );
    expect(result.exitCode).toBe(2);
    expect(error).toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toMatch(/no captures found/);
  });

  it('happy path: per-capture × per-model count, prints table, returns exitCode 0', async () => {
    countTokensMock.mockImplementation((args) => {
      const model = args?.model;
      const map = { 'claude-opus-4-7': 1234, 'claude-sonnet-4-6': 1200 };
      return Promise.resolve({ input_tokens: map[model] ?? 999 });
    });
    dir = makeFakeRunsDir({
      'A-rawgradle-run1.txt': 'A capture body',
      'C-json-run1.txt': 'C capture body',
    });
    const { sink, log } = makeSink();
    const result = await runCrossModelMode(
      { anthropicModels: ['claude-opus-4-7', 'claude-sonnet-4-6'] },
      () => ({ messages: { countTokens: countTokensMock } }),
      sink,
      dir
    );
    expect(result.exitCode).toBe(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].approach).toBe('A');
    expect(result.rows[0].perModel['claude-opus-4-7']).toBe(1234);
    // 2 captures × 2 models = 4 SDK calls
    expect(countTokensMock).toHaveBeenCalledTimes(4);
    // Table content reached stdout sink
    const stdout = log.mock.calls.map((c) => c[0]).join('\n');
    expect(stdout).toContain('Cross-model token-cost');
    expect(stdout).toContain('claude-opus-4-7');
    expect(stdout).toContain('Cross-family variation');
    expect(stdout).toContain('Approach ratio vs C');
  });

  it('per-model error renders inline as [error: …] without aborting the run', async () => {
    // Order: first call is for claude-opus-4-7 (resolves), second is for the bad model (rejects).
    countTokensMock
      .mockResolvedValueOnce({ input_tokens: 500 })
      .mockRejectedValueOnce({ status: 404, message: 'model not found' });
    dir = makeFakeRunsDir({ 'B-md-run1.txt': 'body' });
    const { sink, log } = makeSink();
    const result = await runCrossModelMode(
      { anthropicModels: ['claude-opus-4-7', 'claude-bad-model'] },
      () => ({ messages: { countTokens: countTokensMock } }),
      sink,
      dir
    );
    expect(result.exitCode).toBe(0);
    expect(result.rows[0].perModel['claude-opus-4-7']).toBe(500);
    expect(result.rows[0].perModel['claude-bad-model']).toBe('[error: model_not_found]');
    const stdout = log.mock.calls.map((c) => c[0]).join('\n');
    expect(stdout).toContain('[error: model_not_found]');
  });
});

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseAnthropicModels,
  parseArgs,
  countTokensAnthropic,
  countTokensCl100k,
  loadCaptures,
  formatCrossModelTable,
  summariseCrossModelVariation,
  runCrossModelMode,
  FEATURES,
  VALID_FEATURES,
  filterModulesByGlob,
  modulesFromGitDiff,
  featureRunsDir,
  buildApproachAInvocation,
  buildKmpTestCliInvocation,
  parseProjectsConfigJson,
  parseProjectsConfigEnv,
  resolveProjectsConfig,
  classifyBucket,
  summarizeBucket,
  splitForAnthropic,
  aggregateByBucket,
  formatAggregateReport,
  CHUNK_THRESHOLD_BYTES,
} from '../../tools/measure-token-cost.js';

const countTokensMock = vi.fn();

function makeSink() {
  const log = vi.fn();
  const error = vi.fn();
  return { sink: { log, error }, log, error };
}

function makeFakeRunsDir(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmp-test-runs-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

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

  it('parses --anthropic-api-key as a CLI override', () => {
    const out = parseArgs([
      '--anthropic-models', 'claude-opus-4-7',
      '--anthropic-api-key', 'sk-ant-test-key-123',
    ]);
    expect(out.anthropicApiKey).toBe('sk-ant-test-key-123');
    expect(out.anthropicModels).toEqual(['claude-opus-4-7']);
  });

  it('defaults anthropicApiKey to null when --anthropic-api-key is omitted', () => {
    const out = parseArgs(['--anthropic-models', 'claude-opus-4-7']);
    expect(out.anthropicApiKey).toBeNull();
  });
});

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

  // Multi-account fallback path. When the primary client returns 401 and a
  // fallback client is provided, retry once on the fallback before giving up.

  it('falls back to fallbackClient on 401 and returns the fallback result', async () => {
    const primaryMock = vi.fn().mockRejectedValueOnce({ status: 401, message: 'invalid key' });
    const fallbackMock = vi.fn().mockResolvedValueOnce({ input_tokens: 99 });
    const primary = { messages: { countTokens: primaryMock } };
    const fallback = { messages: { countTokens: fallbackMock } };

    const r = await countTokensAnthropic(primary, 'claude-opus-4-7', 'hello', fallback);

    expect(r).toEqual({ ok: true, tokens: 99, usedFallback: true });
    expect(primaryMock).toHaveBeenCalledTimes(1);
    expect(fallbackMock).toHaveBeenCalledTimes(1);
    expect(fallbackMock).toHaveBeenCalledWith({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('does NOT invoke fallbackClient when primary succeeds', async () => {
    const primaryMock = vi.fn().mockResolvedValueOnce({ input_tokens: 7 });
    const fallbackMock = vi.fn();
    const primary = { messages: { countTokens: primaryMock } };
    const fallback = { messages: { countTokens: fallbackMock } };

    const r = await countTokensAnthropic(primary, 'claude-opus-4-7', 'x', fallback);

    expect(r).toEqual({ ok: true, tokens: 7 });
    expect(r.usedFallback).toBeUndefined();
    expect(primaryMock).toHaveBeenCalledTimes(1);
    expect(fallbackMock).not.toHaveBeenCalled();
  });

  it('preserves auth_failed when primary returns 401 and no fallback is provided', async () => {
    countTokensMock.mockRejectedValueOnce({ status: 401, message: 'invalid key' });
    const client = { messages: { countTokens: countTokensMock } };
    // fallbackClient omitted (defaults to null) — exercises the original
    // single-client behaviour as a regression guard.
    const r = await countTokensAnthropic(client, 'claude-opus-4-7', 'x');
    expect(r).toEqual({ ok: false, error: 'auth_failed' });
    expect(r.usedFallback).toBeUndefined();
  });

  it('returns fallback error code when both primary and fallback fail', async () => {
    const primaryMock = vi.fn().mockRejectedValueOnce({ status: 401, message: 'invalid key' });
    const fallbackMock = vi.fn().mockRejectedValueOnce({ status: 401, message: 'also invalid' });
    const primary = { messages: { countTokens: primaryMock } };
    const fallback = { messages: { countTokens: fallbackMock } };

    const r = await countTokensAnthropic(primary, 'claude-opus-4-7', 'x', fallback);

    expect(r).toEqual({ ok: false, error: 'auth_failed', usedFallback: true });
    expect(primaryMock).toHaveBeenCalledTimes(1);
    expect(fallbackMock).toHaveBeenCalledTimes(1);
  });
});

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

describe('summariseCrossModelVariation', () => {
  it('computes spread across cl100k + per-model numeric values', () => {
    const rows = [
      { approach: 'A', file: 'A.txt', cl100k: 1000, perModel: { m1: 1100, m2: 950 } },
    ];
    const out = summariseCrossModelVariation(rows, ['m1', 'm2']);
    expect(out[0].spreadPct).toBeCloseTo(15.8, 1);
  });

  it('returns spread null when only one numeric value is available', () => {
    const rows = [{ approach: 'A', file: 'A.txt', cl100k: 1000, perModel: { m1: '[error: x]', m2: '[error: y]' } }];
    const out = summariseCrossModelVariation(rows, ['m1', 'm2']);
    expect(out[0].spreadPct).toBe(null);
  });
});

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

  it('happy path: per-capture per-model count, prints table, returns exitCode 0', async () => {
    countTokensMock.mockImplementation((args) => {
      const model = args ? args.model : undefined;
      const map = { 'claude-opus-4-7': 1234, 'claude-sonnet-4-6': 1200 };
      return Promise.resolve({ input_tokens: map[model] != null ? map[model] : 999 });
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
    expect(countTokensMock).toHaveBeenCalledTimes(4);
    const stdout = log.mock.calls.map((c) => c[0]).join('\n');
    expect(stdout).toContain('Cross-model token-cost');
    expect(stdout).toContain('claude-opus-4-7');
    expect(stdout).toContain('Cross-family variation');
    expect(stdout).toContain('Approach ratio vs C');
  });

  it('per-model error renders inline as bracketed error string without aborting the run', async () => {
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

// ---------------------------------------------------------------------------
// v0.4 — multi-feature dispatch
// ---------------------------------------------------------------------------

describe('FEATURES registry', () => {
  it('exposes exactly the six supported features (4 gradle-backed + 2 agent-query)', () => {
    expect(VALID_FEATURES.sort()).toEqual(['benchmark', 'changed', 'coverage', 'describe', 'info', 'parallel']);
    expect(Object.keys(FEATURES).sort()).toEqual(['benchmark', 'changed', 'coverage', 'describe', 'info', 'parallel']);
  });
  it('every entry exposes the dispatch shape', () => {
    for (const [name, feat] of Object.entries(FEATURES)) {
      expect(typeof feat.cliSubcommand, `${name}.cliSubcommand`).toBe('string');
      expect(typeof feat.gradleTasksForModules, `${name}.gradleTasksForModules`).toBe('function');
      expect(typeof feat.isReport, `${name}.isReport`).toBe('function');
      expect(typeof feat.resolveModules, `${name}.resolveModules`).toBe('function');
      expect(typeof feat.skipApproachA, `${name}.skipApproachA`).toBe('boolean');
      expect(typeof feat.acceptsModuleFilter, `${name}.acceptsModuleFilter`).toBe('boolean');
    }
  });
  it('gradle-backed features (parallel/coverage/changed/benchmark) opt out of skipApproachA', () => {
    expect(FEATURES.parallel.skipApproachA).toBe(false);
    expect(FEATURES.coverage.skipApproachA).toBe(false);
    expect(FEATURES.changed.skipApproachA).toBe(false);
    expect(FEATURES.benchmark.skipApproachA).toBe(false);
  });
  it.each(['info', 'describe'])('agent-query feature %s opts into skipApproachA', (name) => {
    expect(FEATURES[name].skipApproachA).toBe(true);
  });
  it('info opts out of acceptsModuleFilter; describe opts in', () => {
    expect(FEATURES.info.acceptsModuleFilter).toBe(false);
    expect(FEATURES.describe.acceptsModuleFilter).toBe(true);
  });
  it('parallel + changed produce :module:test tasks (default testTask)', () => {
    expect(FEATURES.parallel.gradleTasksForModules(['core-x'], {})).toEqual([':core-x:test']);
    expect(FEATURES.changed.gradleTasksForModules(['core-x'], {})).toEqual([':core-x:test']);
  });
  it('parallel + changed honour --test-task override', () => {
    expect(FEATURES.parallel.gradleTasksForModules(['m'], { testTask: 'desktopTest' }))
      .toEqual([':m:desktopTest']);
    expect(FEATURES.changed.gradleTasksForModules(['m'], { testTask: 'jvmTest' }))
      .toEqual([':m:jvmTest']);
  });
  it('coverage produces both koverXmlReport and koverHtmlReport per module', () => {
    expect(FEATURES.coverage.gradleTasksForModules(['core-a', 'core-b'], {})).toEqual([
      ':core-a:koverXmlReport',
      ':core-a:koverHtmlReport',
      ':core-b:koverXmlReport',
      ':core-b:koverHtmlReport',
    ]);
  });
  it('benchmark defaults to jvmBenchmark and honours --benchmark-task', () => {
    expect(FEATURES.benchmark.gradleTasksForModules(['bench-io'], {}))
      .toEqual([':bench-io:jvmBenchmark']);
    expect(FEATURES.benchmark.gradleTasksForModules(['bench-io'], { benchmarkTask: 'nativeBenchmark' }))
      .toEqual([':bench-io:nativeBenchmark']);
  });
  it('isReport predicates partition cleanly per feature', () => {
    const t = '/p/m/build/reports/tests/test/index.html';
    const tx = '/p/m/build/test-results/test/x.xml';
    const k = '/p/m/build/reports/kover/report.xml';
    const b = '/p/m/build/reports/benchmarks/main/2026-04-26-12-00-00/results.json';
    expect(FEATURES.parallel.isReport(t)).toBe(true);
    expect(FEATURES.parallel.isReport(tx)).toBe(true);
    expect(FEATURES.parallel.isReport(k)).toBe(false);
    expect(FEATURES.coverage.isReport(k)).toBe(true);
    expect(FEATURES.coverage.isReport(t)).toBe(false);
    expect(FEATURES.benchmark.isReport(b)).toBe(true);
    expect(FEATURES.benchmark.isReport(t)).toBe(false);
    expect(FEATURES.changed.isReport(t)).toBe(true);
    expect(FEATURES.changed.isReport(b)).toBe(false);
  });
});

describe('parseArgs --feature', () => {
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

  it('defaults to parallel when --feature is not passed (backward compat)', () => {
    const out = parseArgs(['--project-root', '/tmp/x']);
    expect(out.feature).toBe('parallel');
  });
  it.each(['parallel', 'coverage', 'changed', 'benchmark', 'info', 'describe'])(
    'accepts --feature %s', (feature) => {
      const out = parseArgs(['--project-root', '/tmp/x', '--feature', feature]);
      expect(out.feature).toBe(feature);
    });
  it('exits 2 with a clear message on unknown feature', () => {
    expect(() => parseArgs(['--project-root', '/tmp/x', '--feature', 'parralel'])).toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errSpy.mock.calls[0][0]).toMatch(/--feature must be one of/);
  });
  it('parses --benchmark-task and --changed-range alongside --feature', () => {
    const out = parseArgs([
      '--project-root', '/tmp/x',
      '--feature', 'benchmark',
      '--benchmark-task', 'nativeBenchmark',
      '--changed-range', 'main..HEAD',
    ]);
    expect(out.feature).toBe('benchmark');
    expect(out.benchmarkTask).toBe('nativeBenchmark');
    expect(out.changedRange).toBe('main..HEAD');
  });
  it('exposes new defaults: benchmarkTask=jvmBenchmark, changedRange=HEAD~1..HEAD', () => {
    const out = parseArgs(['--project-root', '/tmp/x']);
    expect(out.benchmarkTask).toBe('jvmBenchmark');
    expect(out.changedRange).toBe('HEAD~1..HEAD');
  });
});

describe('filterModulesByGlob', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function makeProject(modules) {
    dir = mkdtempSync(path.join(tmpdir(), 'kmp-fm-'));
    for (const [name, hasBuild] of Object.entries(modules)) {
      mkdirSync(path.join(dir, name), { recursive: true });
      if (hasBuild) writeFileSync(path.join(dir, name, 'build.gradle.kts'), '');
    }
    return dir;
  }

  it('returns [] for a missing root', () => {
    expect(filterModulesByGlob(path.join(tmpdir(), 'nope-' + Date.now()))).toEqual([]);
  });
  it('returns all gradle-module dirs when no filter is passed', () => {
    makeProject({ 'core-a': true, 'core-b': true, 'docs-only': false });
    expect(filterModulesByGlob(dir).sort()).toEqual(['core-a', 'core-b']);
  });
  it('honours glob wildcards', () => {
    makeProject({ 'core-a': true, 'core-b': true, 'feature-x': true });
    expect(filterModulesByGlob(dir, 'core-*').sort()).toEqual(['core-a', 'core-b']);
  });
  it('skips directories without build.gradle.kts even if they match the glob', () => {
    makeProject({ 'core-a': true, 'core-empty': false });
    expect(filterModulesByGlob(dir, 'core-*')).toEqual(['core-a']);
  });
});

describe('modulesFromGitDiff', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function gitInitWithModules(modules, edits) {
    dir = mkdtempSync(path.join(tmpdir(), 'kmp-gd-'));
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: dir });
    spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    for (const m of modules) {
      mkdirSync(path.join(dir, m), { recursive: true });
      writeFileSync(path.join(dir, m, 'build.gradle.kts'), '');
      writeFileSync(path.join(dir, m, 'src.txt'), 'v1\n');
    }
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
    for (const [file, body] of Object.entries(edits)) {
      writeFileSync(path.join(dir, file), body);
    }
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'edit'], { cwd: dir });
    return dir;
  }

  it('returns the set of modules touched by the diff range', () => {
    gitInitWithModules(
      ['core-a', 'core-b', 'core-c'],
      { 'core-a/src.txt': 'v2\n', 'core-c/src.txt': 'v2\n' }
    );
    expect(modulesFromGitDiff(dir, 'HEAD~1..HEAD').sort()).toEqual(['core-a', 'core-c']);
  });
  it('ignores diffs in non-module top-level paths', () => {
    gitInitWithModules(
      ['core-a'],
      { 'core-a/src.txt': 'v2\n', 'README.md': '# hi\n' }
    );
    expect(modulesFromGitDiff(dir, 'HEAD~1..HEAD')).toEqual(['core-a']);
  });
  it('returns [] when the diff range produces no module touches', () => {
    gitInitWithModules(['core-a'], { 'README.md': '# hi\n' });
    expect(modulesFromGitDiff(dir, 'HEAD~1..HEAD')).toEqual([]);
  });
});

describe('featureRunsDir', () => {
  it('returns an absolute path under tools/runs/<feature>', () => {
    const p = featureRunsDir('coverage');
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.replace(/\\/g, '/')).toMatch(/tools\/runs\/coverage$/);
  });
  it('produces distinct paths per feature', () => {
    const set = new Set(VALID_FEATURES.map(featureRunsDir));
    expect(set.size).toBe(VALID_FEATURES.length);
  });
});

describe('loadCaptures (v0.4 short-form names)', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('matches new <A|B|C>-run<N>.txt subdir layout', () => {
    dir = makeFakeRunsDir({ 'A-run1.txt': 'a', 'B-run1.txt': 'b', 'C-run1.txt': 'c' });
    const caps = loadCaptures(dir);
    expect(caps.map((c) => c.approach)).toEqual(['A', 'B', 'C']);
    expect(caps.map((c) => c.text)).toEqual(['a', 'b', 'c']);
  });
  it('still ignores cross-model evidence files', () => {
    dir = makeFakeRunsDir({
      'A-run1.txt': 'a',
      'cross-model-results-coverage.txt': 'ignored',
    });
    const caps = loadCaptures(dir);
    expect(caps).toHaveLength(1);
    expect(caps[0].approach).toBe('A');
  });
});

describe('buildApproachAInvocation', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function makeProject(modules) {
    dir = mkdtempSync(path.join(tmpdir(), 'kmp-ai-'));
    writeFileSync(path.join(dir, 'gradlew'), '#!/bin/sh\n');
    writeFileSync(path.join(dir, 'gradlew.bat'), '@echo off\n');
    for (const m of modules) {
      mkdirSync(path.join(dir, m), { recursive: true });
      writeFileSync(path.join(dir, m, 'build.gradle.kts'), '');
    }
    return dir;
  }

  it('parallel feature: emits :module:test per matched module', () => {
    makeProject(['core-a', 'core-b']);
    const inv = buildApproachAInvocation({
      feature: 'parallel', projectRoot: dir, moduleFilter: 'core-*', testTask: 'test',
    });
    expect(inv.modules.sort()).toEqual(['core-a', 'core-b']);
    expect(inv.args).toContain(':core-a:test');
    expect(inv.args).toContain(':core-b:test');
    expect(inv.args).toContain('--console=plain');
    expect(inv.cwd).toBe(dir);
  });
  it('coverage feature: emits both koverXmlReport + koverHtmlReport', () => {
    makeProject(['core-a']);
    const inv = buildApproachAInvocation({
      feature: 'coverage', projectRoot: dir, moduleFilter: 'core-*',
    });
    expect(inv.args).toContain(':core-a:koverXmlReport');
    expect(inv.args).toContain(':core-a:koverHtmlReport');
  });
  it('benchmark feature: honours --benchmark-task override', () => {
    makeProject(['bench-io']);
    const inv = buildApproachAInvocation({
      feature: 'benchmark', projectRoot: dir, moduleFilter: 'bench-*', benchmarkTask: 'nativeBenchmark',
    });
    expect(inv.args).toContain(':bench-io:nativeBenchmark');
    expect(inv.args).not.toContain(':bench-io:jvmBenchmark');
  });
  it('falls back to root-level :testTask when no modules match', () => {
    makeProject([]);
    const inv = buildApproachAInvocation({
      feature: 'parallel', projectRoot: dir, moduleFilter: 'no-match-*', testTask: 'test',
    });
    expect(inv.modules).toEqual([]);
    expect(inv.args).toContain(':test');
  });
  it('uses cmd.exe wrapper on win32 and bare gradlew elsewhere', () => {
    makeProject(['core-a']);
    const inv = buildApproachAInvocation({
      feature: 'parallel', projectRoot: dir, moduleFilter: 'core-*',
    });
    if (process.platform === 'win32') {
      expect(inv.cmd.toLowerCase()).toMatch(/cmd\.exe$/);
      expect(inv.args[0]).toBe('/c');
      expect(inv.args[1]).toMatch(/gradlew\.bat$/);
    } else {
      expect(inv.cmd).toMatch(/gradlew$/);
      expect(inv.args[0]).toBe(':core-a:test');
    }
  });
});

describe('buildKmpTestCliInvocation', () => {
  it.each(['parallel', 'coverage', 'changed', 'benchmark', 'info', 'describe'])(
    '%s subcommand is forwarded as the first cli arg', (feature) => {
      const inv = buildKmpTestCliInvocation({ feature, projectRoot: '/tmp/x' }, false);
      expect(inv.cmd).toBe(process.execPath);
      const cliIndex = inv.args.findIndex((a) => /kmp-test\.js$/.test(a));
      expect(cliIndex).toBeGreaterThanOrEqual(0);
      expect(inv.args[cliIndex + 1]).toBe(feature);
    });
  it('approach C adds --json before --project-root', () => {
    const invB = buildKmpTestCliInvocation({ feature: 'coverage', projectRoot: '/tmp/x' }, false);
    const invC = buildKmpTestCliInvocation({ feature: 'coverage', projectRoot: '/tmp/x' }, true);
    expect(invB.args).not.toContain('--json');
    expect(invC.args).toContain('--json');
    const jsonIdx = invC.args.indexOf('--json');
    const projIdx = invC.args.indexOf('--project-root');
    expect(jsonIdx).toBeLessThan(projIdx);
  });
  it('forwards --module-filter when set', () => {
    const inv = buildKmpTestCliInvocation({
      feature: 'parallel', projectRoot: '/tmp/x', moduleFilter: 'core-*',
    }, false);
    expect(inv.args).toContain('--module-filter');
    expect(inv.args).toContain('core-*');
  });
  it('omits --module-filter when not set', () => {
    const inv = buildKmpTestCliInvocation({ feature: 'parallel', projectRoot: '/tmp/x' }, false);
    expect(inv.args).not.toContain('--module-filter');
  });
  it('describe forwards --module-filter when set (acceptsModuleFilter=true)', () => {
    const inv = buildKmpTestCliInvocation({
      feature: 'describe', projectRoot: '/tmp/x', moduleFilter: 'core-*',
    }, false);
    expect(inv.args).toContain('--module-filter');
    expect(inv.args).toContain('core-*');
  });
  it('info does NOT forward --module-filter even when set (acceptsModuleFilter=false)', () => {
    const inv = buildKmpTestCliInvocation({
      feature: 'info', projectRoot: '/tmp/x', moduleFilter: 'core-*',
    }, false);
    expect(inv.args).not.toContain('--module-filter');
    expect(inv.args).not.toContain('core-*');
  });
});

describe('runCrossModelMode (v0.4 — derives runsDir from opts.feature)', () => {
  let dir;
  beforeEach(() => countTokensMock.mockReset());
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('emits a feature-tagged heading reflecting opts.feature', async () => {
    countTokensMock.mockResolvedValue({ input_tokens: 100 });
    dir = makeFakeRunsDir({ 'A-run1.txt': 'body' });
    const { sink, log } = makeSink();
    const result = await runCrossModelMode(
      { anthropicModels: ['claude-opus-4-7'], feature: 'coverage' },
      () => ({ messages: { countTokens: countTokensMock } }),
      sink,
      dir // explicit override; feature still drives the heading
    );
    expect(result.exitCode).toBe(0);
    const stdout = log.mock.calls.map((c) => c[0]).join('\n');
    expect(stdout).toMatch(/feature: coverage/);
  });
  it('defaults heading to "parallel" when opts.feature is absent', async () => {
    countTokensMock.mockResolvedValue({ input_tokens: 100 });
    dir = makeFakeRunsDir({ 'A-run1.txt': 'body' });
    const { sink, log } = makeSink();
    await runCrossModelMode(
      { anthropicModels: ['claude-opus-4-7'] },
      () => ({ messages: { countTokens: countTokensMock } }),
      sink,
      dir
    );
    const stdout = log.mock.calls.map((c) => c[0]).join('\n');
    expect(stdout).toMatch(/feature: parallel/);
  });
});

// ---------------------------------------------------------------------------
// Multi-project orchestration (PR #13 — size-bucketed token-cost re-measurement)
// ---------------------------------------------------------------------------

describe('parseProjectsConfigJson', () => {
  it('parses an array of {path, label, bucket} entries', () => {
    const json = JSON.stringify([
      { path: '/tmp/foo', label: 'KaMPKit', bucket: 'small' },
      { path: '/tmp/bar', label: 'NowInAndroid', bucket: 'large' },
    ]);
    expect(parseProjectsConfigJson(json)).toEqual([
      { path: '/tmp/foo', label: 'KaMPKit', bucket: 'small' },
      { path: '/tmp/bar', label: 'NowInAndroid', bucket: 'large' },
    ]);
  });
  it('throws when payload is not an array', () => {
    expect(() => parseProjectsConfigJson('{}')).toThrow(/expected array/);
  });
  it('throws when an entry is missing a required field', () => {
    expect(() =>
      parseProjectsConfigJson(JSON.stringify([{ path: '/x', label: 'x' }]))
    ).toThrow(/missing bucket/);
  });
  it('throws when bucket is not one of small|medium|large', () => {
    expect(() =>
      parseProjectsConfigJson(JSON.stringify([{ path: '/x', label: 'x', bucket: 'huge' }]))
    ).toThrow(/bucket must be/);
  });
});

describe('parseProjectsConfigEnv', () => {
  it('parses newline-separated path|label|bucket entries', () => {
    const env = '/tmp/a|KaMPKit|small\n/tmp/b|Confetti|medium';
    expect(parseProjectsConfigEnv(env)).toEqual([
      { path: '/tmp/a', label: 'KaMPKit', bucket: 'small' },
      { path: '/tmp/b', label: 'Confetti', bucket: 'medium' },
    ]);
  });
  it('skips empty / whitespace lines', () => {
    const env = '\n/tmp/a|x|small\n   \n/tmp/b|y|large\n\n';
    expect(parseProjectsConfigEnv(env).length).toBe(2);
  });
  it('throws when a line has the wrong number of fields', () => {
    expect(() => parseProjectsConfigEnv('/tmp/a|just-label')).toThrow(/bad line/);
  });
  it('throws when a line\'s bucket is invalid', () => {
    expect(() => parseProjectsConfigEnv('/tmp/a|x|tiny')).toThrow(/bucket must be/);
  });
});

describe('resolveProjectsConfig', () => {
  let tmp;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('reads from cliPath when provided (highest precedence)', () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'kmp-projects-'));
    const cli = path.join(tmp, 'cli.json');
    const conv = path.join(tmp, 'conv.json');
    writeFileSync(cli, JSON.stringify([{ path: '/c', label: 'cli', bucket: 'small' }]));
    writeFileSync(conv, JSON.stringify([{ path: '/x', label: 'conv', bucket: 'large' }]));
    const env = '/e|env|medium';
    const out = resolveProjectsConfig({ cliPath: cli, envValue: env, conventionalPath: conv });
    expect(out).toEqual([{ path: '/c', label: 'cli', bucket: 'small' }]);
  });

  it('falls back to envValue when cliPath omitted', () => {
    const env = '/e|env|medium';
    const out = resolveProjectsConfig({ envValue: env });
    expect(out).toEqual([{ path: '/e', label: 'env', bucket: 'medium' }]);
  });

  it('falls back to conventionalPath when cli + env both omitted and file exists', () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'kmp-projects-'));
    const conv = path.join(tmp, 'conv.json');
    writeFileSync(conv, JSON.stringify([{ path: '/x', label: 'conv', bucket: 'large' }]));
    const out = resolveProjectsConfig({ conventionalPath: conv });
    expect(out).toEqual([{ path: '/x', label: 'conv', bucket: 'large' }]);
  });

  it('returns null when no source resolves', () => {
    expect(resolveProjectsConfig({})).toBeNull();
    expect(resolveProjectsConfig({ conventionalPath: '/nonexistent.json' })).toBeNull();
  });
});

describe('classifyBucket', () => {
  it('returns small for 1..5 modules', () => {
    expect(classifyBucket(1)).toBe('small');
    expect(classifyBucket(5)).toBe('small');
  });
  it('returns medium for 6..20 modules', () => {
    expect(classifyBucket(6)).toBe('medium');
    expect(classifyBucket(20)).toBe('medium');
  });
  it('returns large for 21+ modules', () => {
    expect(classifyBucket(21)).toBe('large');
    expect(classifyBucket(500)).toBe('large');
  });
});

describe('summarizeBucket', () => {
  it('returns zeros for an empty array', () => {
    expect(summarizeBucket([])).toEqual({ mean: 0, median: 0, min: 0, max: 0, spread: 0 });
  });
  it('computes median for odd-length arrays', () => {
    expect(summarizeBucket([1, 3, 9]).median).toBe(3);
  });
  it('computes median as the average of the two middle values for even-length arrays', () => {
    expect(summarizeBucket([1, 3, 5, 9]).median).toBe(4); // (3 + 5) / 2
  });
  it('computes spread as (max - min) / min * 100, rounded', () => {
    // values [10, 100] -> max-min=90, min=10 -> 900%
    expect(summarizeBucket([10, 100]).spread).toBe(900);
  });
  it('computes spread as 0 when min === max', () => {
    expect(summarizeBucket([7, 7, 7]).spread).toBe(0);
  });
  it('preserves min and max', () => {
    const s = summarizeBucket([5, 1, 9, 3, 7]);
    expect(s.min).toBe(1);
    expect(s.max).toBe(9);
  });
});

describe('splitForAnthropic', () => {
  it('returns a single-element array when input is small', () => {
    expect(splitForAnthropic('hello', { chunkBytes: 1024 })).toEqual(['hello']);
  });
  it('returns a single-element array for empty / null input', () => {
    expect(splitForAnthropic('', { chunkBytes: 1024 })).toEqual(['']);
    expect(splitForAnthropic(null, { chunkBytes: 1024 })).toEqual(['']);
  });
  it('splits at file-record boundaries when present', () => {
    // Build a payload with 3 file records, each ~600 bytes; threshold 1000
    // forces at least one split, and the split must land on a `\n=== ===\n`
    // boundary (not mid-content).
    const blob = (n) => 'x'.repeat(600);
    const text =
      '\n=== /a.html ===\n' + blob() +
      '\n=== /b.html ===\n' + blob() +
      '\n=== /c.html ===\n' + blob();
    const chunks = splitForAnthropic(text, { chunkBytes: 1000 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Reassembled chunks must exactly equal the input — no character lost.
    expect(chunks.join('')).toBe(text);
    // Every chunk except possibly the first must start with the boundary marker.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startsWith('\n=== ')).toBe(true);
    }
  });
  it('falls back to byte-window slicing when no boundaries are present', () => {
    const text = 'a'.repeat(5000);
    const chunks = splitForAnthropic(text, { chunkBytes: 1500 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.join('')).toBe(text);
    for (const c of chunks.slice(0, -1)) {
      expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(1500);
    }
  });
  it('uses the default CHUNK_THRESHOLD_BYTES when chunkBytes opt is omitted', () => {
    // Just exercise the default-path; payload < default threshold -> 1 chunk.
    expect(splitForAnthropic('small payload')).toEqual(['small payload']);
    expect(typeof CHUNK_THRESHOLD_BYTES).toBe('number');
    expect(CHUNK_THRESHOLD_BYTES).toBeGreaterThan(1024 * 1024); // > 1 MB
  });
});

describe('countTokensAnthropic — chunked path for oversized payloads', () => {
  it('uses single-call path when input <= chunk threshold (regression guard)', async () => {
    const mock = vi.fn().mockResolvedValueOnce({ input_tokens: 11 });
    const client = { messages: { countTokens: mock } };
    const r = await countTokensAnthropic(client, 'claude-opus-4-7', 'tiny');
    expect(r).toEqual({ ok: true, tokens: 11 });
    expect(r.chunked).toBeUndefined();
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('splits into N chunks and returns the summed token count when input > threshold', async () => {
    // Force the chunked path by setting a tiny threshold via opts.
    const mock = vi.fn()
      .mockResolvedValueOnce({ input_tokens: 100 })
      .mockResolvedValueOnce({ input_tokens: 250 })
      .mockResolvedValueOnce({ input_tokens: 50 });
    const client = { messages: { countTokens: mock } };
    const text = 'x'.repeat(3000); // 3000 bytes; threshold 1000 -> 3 chunks
    const r = await countTokensAnthropic(client, 'claude-opus-4-7', text, null, { chunkBytes: 1000 });
    expect(r.ok).toBe(true);
    expect(r.tokens).toBe(400); // 100 + 250 + 50
    expect(r.chunked).toBe(true);
    expect(r.chunks).toBe(3);
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('marks the result as failed and stops chunking when any chunk errs', async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce({ input_tokens: 100 })
      .mockRejectedValueOnce({ status: 413, message: 'too large' })
      .mockResolvedValueOnce({ input_tokens: 50 });
    const client = { messages: { countTokens: mock } };
    const text = 'x'.repeat(3000);
    const r = await countTokensAnthropic(client, 'claude-opus-4-7', text, null, { chunkBytes: 1000 });
    expect(r.ok).toBe(false);
    expect(r.chunked).toBe(true);
    expect(r.chunks).toBe(3);
    expect(r.failedChunkIndex).toBe(1);
    // Error code surfaces from simplifyAnthropicError — bad_request prefix for 400/413
    // (413 isn't in the explicit map; falls through to the generic message branch).
    expect(typeof r.error).toBe('string');
    // Subsequent chunk MUST not be called once a failure is recorded.
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('preserves fallback-client semantics across chunks (401 on first chunk routes to fallback)', async () => {
    const primaryMock = vi.fn()
      .mockRejectedValueOnce({ status: 401, message: 'invalid key' })
      .mockResolvedValueOnce({ input_tokens: 30 });
    const fallbackMock = vi.fn()
      .mockResolvedValueOnce({ input_tokens: 200 });
    const primary = { messages: { countTokens: primaryMock } };
    const fallback = { messages: { countTokens: fallbackMock } };
    const text = 'y'.repeat(2000); // 2 chunks at threshold 1000
    const r = await countTokensAnthropic(primary, 'claude-opus-4-7', text, fallback, { chunkBytes: 1000 });
    expect(r.ok).toBe(true);
    expect(r.tokens).toBe(230); // 200 (fallback) + 30 (primary)
    expect(r.chunked).toBe(true);
    expect(r.chunks).toBe(2);
    expect(r.usedFallback).toBe(true);
  });
});

describe('aggregateByBucket', () => {
  it('groups projects by bucket and surfaces sample labels', () => {
    const result = aggregateByBucket([
      { label: 'KaMPKit', bucket: 'small', perFeature: {} },
      { label: 'kotlinconf-app', bucket: 'small', perFeature: {} },
      { label: 'NowInAndroid', bucket: 'large', perFeature: {} },
    ]);
    expect(result.small.sample).toEqual(['KaMPKit', 'kotlinconf-app']);
    expect(result.medium.sample).toEqual([]);
    expect(result.large.sample).toEqual(['NowInAndroid']);
  });

  it('summarises per-feature per-approach token counts across the bucket sample', () => {
    const result = aggregateByBucket([
      { label: 'p1', bucket: 'small', perFeature: { parallel: { A: { mean: 1000 }, B: { mean: 200 }, C: { mean: 50 } } } },
      { label: 'p2', bucket: 'small', perFeature: { parallel: { A: { mean: 5000 }, B: { mean: 800 }, C: { mean: 150 } } } },
    ]);
    const slot = result.small.byFeature.parallel;
    expect(slot.approaches.A.mean).toBe(3000); // (1000 + 5000) / 2
    expect(slot.approaches.A.median).toBe(3000); // (1000 + 5000) / 2
    expect(slot.approaches.A.min).toBe(1000);
    expect(slot.approaches.A.max).toBe(5000);
    expect(slot.approaches.C.median).toBe(100); // (50 + 150) / 2
  });

  it('computes per-project A/C ratio and aggregates the ratios', () => {
    const result = aggregateByBucket([
      { label: 'p1', bucket: 'medium', perFeature: { coverage: { A: { mean: 1000 }, B: { mean: 50 }, C: { mean: 10 } } } }, // ratio 100
      { label: 'p2', bucket: 'medium', perFeature: { coverage: { A: { mean: 500 }, B: { mean: 30 }, C: { mean: 10 } } } },  // ratio 50
      { label: 'p3', bucket: 'medium', perFeature: { coverage: { A: { mean: 2000 }, B: { mean: 80 }, C: { mean: 10 } } } }, // ratio 200
    ]);
    const ratios = result.medium.byFeature.coverage.ratios.A_to_C;
    expect(ratios.median).toBe(100); // sorted [50, 100, 200] -> median 100
    expect(ratios.min).toBe(50);
    expect(ratios.max).toBe(200);
  });

  it('skips bucket assignment for invalid bucket labels (defensive)', () => {
    const result = aggregateByBucket([
      { label: 'rogue', bucket: 'huge', perFeature: { parallel: { A: { mean: 9 }, B: {}, C: {} } } },
    ]);
    expect(result.small.sample).toEqual([]);
    expect(result.medium.sample).toEqual([]);
    expect(result.large.sample).toEqual([]);
  });

  it('omits ratios when A or C means are missing', () => {
    const result = aggregateByBucket([
      // info / describe skip approach A — no ratio computable
      { label: 'p1', bucket: 'small', perFeature: { info: { B: { mean: 50 }, C: { mean: 5 } } } },
    ]);
    const slot = result.small.byFeature.info;
    expect(slot.approaches.B.mean).toBe(50);
    expect(slot.ratios.A_to_C.median).toBe(0);
  });
});

describe('formatAggregateReport', () => {
  it('renders the bucket roster and a per-feature table', () => {
    const byBucket = aggregateByBucket([
      { label: 'A1', bucket: 'small', perFeature: { parallel: { A: { mean: 1000 }, B: { mean: 200 }, C: { mean: 50 } } } },
      { label: 'A2', bucket: 'small', perFeature: { parallel: { A: { mean: 2000 }, B: { mean: 300 }, C: { mean: 50 } } } },
      { label: 'B1', bucket: 'large', perFeature: { parallel: { A: { mean: 50000 }, B: { mean: 800 }, C: { mean: 200 } } } },
    ]);
    const md = formatAggregateReport(byBucket, { date: '2026-05-12', features: ['parallel'] });
    expect(md).toContain('Multi-project token-cost aggregate (2026-05-12)');
    expect(md).toMatch(/\| small \| 2 \| A1, A2 \|/);
    expect(md).toMatch(/\| large \| 1 \| B1 \|/);
    expect(md).toContain('## Feature: parallel');
    expect(md).toContain('A→C median');
    // Small bucket median A/C ratio = (1000/50 + 2000/50) / 2 -> sorted [20, 40] -> median 30
    expect(md).toMatch(/\| small \|.*\| 30\.0× \|/);
    // Footer references both invocation + per-project capture path
    expect(md).toContain('--projects-config');
    expect(md).toContain('per-project/<label>/<feature>');
  });

  it('renders empty buckets as `-` cells without crashing', () => {
    const byBucket = aggregateByBucket([
      { label: 'A1', bucket: 'small', perFeature: { parallel: { A: { mean: 1000 }, B: { mean: 200 }, C: { mean: 50 } } } },
    ]);
    const md = formatAggregateReport(byBucket, { date: '2026-05-12', features: ['parallel'] });
    expect(md).toMatch(/\| medium \| - \| - \| - \| - \| - \|/);
    expect(md).toMatch(/\| large \| - \| - \| - \| - \| - \|/);
  });

  it('formats large ratios with thousands separators and trailing ×', () => {
    const byBucket = aggregateByBucket([
      { label: 'huge', bucket: 'large', perFeature: { coverage: { A: { mean: 30_000_000 }, B: { mean: 200 }, C: { mean: 10 } } } },
    ]);
    const md = formatAggregateReport(byBucket, { date: '2026-05-12', features: ['coverage'] });
    // Single-project in bucket: median ratio = 30_000_000 / 10 = 3_000_000
    expect(md).toMatch(/3,000,000×/);
  });
});

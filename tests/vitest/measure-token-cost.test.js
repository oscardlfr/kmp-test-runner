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
  it('exposes exactly the four supported features', () => {
    expect(VALID_FEATURES.sort()).toEqual(['benchmark', 'changed', 'coverage', 'parallel']);
    expect(Object.keys(FEATURES).sort()).toEqual(['benchmark', 'changed', 'coverage', 'parallel']);
  });
  it('every entry exposes the dispatch shape', () => {
    for (const [name, feat] of Object.entries(FEATURES)) {
      expect(typeof feat.cliSubcommand, `${name}.cliSubcommand`).toBe('string');
      expect(typeof feat.gradleTasksForModules, `${name}.gradleTasksForModules`).toBe('function');
      expect(typeof feat.isReport, `${name}.isReport`).toBe('function');
      expect(typeof feat.resolveModules, `${name}.resolveModules`).toBe('function');
    }
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
    expect(FEATURES.benchmark.gradleTasksForModules(['benchmark-io'], {}))
      .toEqual([':benchmark-io:jvmBenchmark']);
    expect(FEATURES.benchmark.gradleTasksForModules(['benchmark-io'], { benchmarkTask: 'nativeBenchmark' }))
      .toEqual([':benchmark-io:nativeBenchmark']);
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
  it.each(['parallel', 'coverage', 'changed', 'benchmark'])(
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
    makeProject(['benchmark-io']);
    const inv = buildApproachAInvocation({
      feature: 'benchmark', projectRoot: dir, moduleFilter: 'benchmark-*', benchmarkTask: 'nativeBenchmark',
    });
    expect(inv.args).toContain(':benchmark-io:nativeBenchmark');
    expect(inv.args).not.toContain(':benchmark-io:jvmBenchmark');
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
  it.each(['parallel', 'coverage', 'changed', 'benchmark'])(
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

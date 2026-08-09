// SPDX-License-Identifier: MIT
// Tests for v0.9 session 2 Bug-B / Bug-C / Bug-D — input validation pass.
//
// Pre-fix every orchestrator's parser silently accepted invalid values for
// enum and numeric flags, and `describe --module-filter` swallowed regex
// compile errors (`try { new RegExp(...) } catch { = null }`). Post-fix,
// invalid input populates `errors[{code: 'invalid_flag_value' | 'invalid_regex'}]`
// and the orchestrator exits with EXIT.CONFIG_ERROR (2) BEFORE any gradle work.
//
// Single shared error code (`invalid_flag_value`) for both enum + numeric
// failures keeps the agent-facing contract minimal — payload carries `flag`,
// `value`, and `allowed[]` (omitted for numeric).

import { describe, it, expect } from 'vitest';

import { validateEnum, validateNonNegativeInt, requireFlagValue } from '../../lib/orchestrators/orchestrator-utils.js';
import { runUpdate } from '../../lib/orchestrators/update-orchestrator.js';
import { runParallel, parseArgs as parseParallelArgs } from '../../lib/orchestrators/parallel-orchestrator.js';
import { runChanged } from '../../lib/orchestrators/changed-orchestrator.js';
import { runBenchmark } from '../../lib/orchestrators/benchmark-orchestrator.js';
import { runCoverage } from '../../lib/orchestrators/coverage-orchestrator.js';
import { runDescribe } from '../../lib/orchestrators/describe-orchestrator.js';
import { runAndroid } from '../../lib/orchestrators/android-orchestrator.js';
import { EXIT } from '../../lib/cli.js';

// ---------------------------------------------------------------------------
// Unit — validation helpers
// ---------------------------------------------------------------------------

describe('validateEnum', () => {
  it('returns value when in allowed list', () => {
    const errors = [];
    expect(validateEnum('--test-type', 'common', ['common', 'jvm'], errors)).toBe('common');
    expect(errors).toEqual([]);
  });

  it('pushes invalid_flag_value when value is not in allowed list', () => {
    const errors = [];
    const result = validateEnum('--test-type', 'bogus', ['common', 'jvm'], errors);
    expect(result).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('invalid_flag_value');
    expect(errors[0].flag).toBe('--test-type');
    expect(errors[0].value).toBe('bogus');
    expect(errors[0].allowed).toEqual(['common', 'jvm']);
    expect(errors[0].message).toContain('bogus');
    expect(errors[0].message).toContain('common');
  });

  // Contract flip (dangling-flag normalization, 2026-06-10): `undefined`
  // (dangling flag — no value token) is now INVALID. Pre-fix it was treated
  // as "missing, not invalid", silently swallowing a trailing `--test-type`.
  it('treats undefined (dangling flag) as invalid', () => {
    const errors = [];
    const result = validateEnum('--test-type', undefined, ['common'], errors);
    expect(result).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'invalid_flag_value',
      flag: '--test-type',
      value: null,
    });
    expect(errors[0].message).toContain('missing required value');
  });
});

describe('validateNonNegativeInt', () => {
  it('returns parsed integer for valid non-negative int', () => {
    const errors = [];
    expect(validateNonNegativeInt('--max-workers', '4', errors)).toBe(4);
    expect(validateNonNegativeInt('--max-workers', '0', errors)).toBe(0);
    expect(errors).toEqual([]);
  });

  it('rejects NaN with invalid_flag_value', () => {
    const errors = [];
    const result = validateNonNegativeInt('--max-workers', 'abc', errors);
    expect(result).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'invalid_flag_value', flag: '--max-workers', value: 'abc' });
  });

  it('rejects negative numbers', () => {
    const errors = [];
    const result = validateNonNegativeInt('--timeout', '-1', errors);
    expect(result).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('invalid_flag_value');
  });

  it('rejects non-integer (e.g. 1.5)', () => {
    const errors = [];
    const result = validateNonNegativeInt('--timeout', '1.5', errors);
    expect(result).toBeNull();
    expect(errors[0].code).toBe('invalid_flag_value');
  });

  // Contract flip (dangling-flag normalization, 2026-06-10) — see the enum
  // sibling above.
  it('treats undefined (dangling flag) as invalid', () => {
    const errors = [];
    const result = validateNonNegativeInt('--max-workers', undefined, errors);
    expect(result).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'invalid_flag_value',
      flag: '--max-workers',
      value: null,
    });
  });
});

// ---------------------------------------------------------------------------
// requireFlagValue — the dangling-flag normalization helper
// ---------------------------------------------------------------------------

describe('requireFlagValue', () => {
  it('returns the value verbatim, including empty string (legacy falsy fallbacks intact)', () => {
    const errors = [];
    expect(requireFlagValue('--device', 'R5CT', errors)).toBe('R5CT');
    expect(requireFlagValue('--device', '', errors)).toBe('');
    expect(errors).toEqual([]);
  });

  it('pushes invalid_flag_value and returns null on undefined (dangling)', () => {
    const errors = [];
    expect(requireFlagValue('--device', undefined, errors)).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'invalid_flag_value',
      flag: '--device',
      value: null,
      message: '--device: missing required value',
    });
  });
});

// ---------------------------------------------------------------------------
// Integration — orchestrator-level CONFIG_ERROR exit
// ---------------------------------------------------------------------------

const ENUM_CASES = [
  { sub: 'parallel',  run: runParallel,  args: ['--test-type', 'bogus'],     code: 'invalid_flag_value', flag: '--test-type' },
  { sub: 'parallel',  run: runParallel,  args: ['--coverage-tool', 'bogus'], code: 'invalid_flag_value', flag: '--coverage-tool' },
  { sub: 'changed',   run: runChanged,   args: ['--test-type', 'bogus'],     code: 'invalid_flag_value', flag: '--test-type' },
  { sub: 'changed',   run: runChanged,   args: ['--coverage-tool', 'bogus'], code: 'invalid_flag_value', flag: '--coverage-tool' },
  { sub: 'benchmark', run: runBenchmark, args: ['--platform', 'bogus'],      code: 'invalid_flag_value', flag: '--platform' },
  { sub: 'coverage',  run: runCoverage,  args: ['--coverage-tool', 'bogus'], code: 'invalid_flag_value', flag: '--coverage-tool' },
];

const NUMERIC_CASES = [
  { sub: 'parallel',  run: runParallel,  args: ['--max-workers', 'abc'], code: 'invalid_flag_value', flag: '--max-workers' },
  { sub: 'parallel',  run: runParallel,  args: ['--timeout', '-1'],      code: 'invalid_flag_value', flag: '--timeout' },
  { sub: 'parallel',  run: runParallel,  args: ['--min-missed-lines', 'NaN'], code: 'invalid_flag_value', flag: '--min-missed-lines' },
  { sub: 'changed',   run: runChanged,   args: ['--min-missed-lines', '-5'], code: 'invalid_flag_value', flag: '--min-missed-lines' },
  { sub: 'benchmark', run: runBenchmark, args: ['--timeout', '-1'],      code: 'invalid_flag_value', flag: '--timeout' },
  { sub: 'coverage',  run: runCoverage,  args: ['--min-missed-lines', 'abc'], code: 'invalid_flag_value', flag: '--min-missed-lines' },
];

describe.each([...ENUM_CASES, ...NUMERIC_CASES])(
  'Bug-B/D: $sub $args[0] $args[1]',
  ({ run, args, code, flag }) => {
    it(`exits CONFIG_ERROR (2) with errors[].code === '${code}', flag === '${flag}'`, async () => {
      const result = await run({ projectRoot: '/tmp/nonexistent-stub', args });
      expect(result.exitCode).toBe(EXIT.CONFIG_ERROR);
      expect(result.envelope.errors).toBeTruthy();
      expect(result.envelope.errors.length).toBeGreaterThan(0);
      const matching = result.envelope.errors.find(e => e.code === code && e.flag === flag);
      expect(matching).toBeTruthy();
    });
  },
);

// ---------------------------------------------------------------------------
// L1 (2026-06-09 audit) — dangling `--isolated-cache-dir` (last token, no
// value). Pre-fix behavior diverged per orchestrator: parallel / benchmark /
// android silently ran NON-isolated with the token leaking into args;
// changed silently enabled isolation with an auto-generated dir. Post-fix all
// four exit CONFIG_ERROR with invalid_flag_value BEFORE any git / adb /
// gradle work (runner.js-direct defense; cli.js gates the CLI route via
// peekIsolatedFlags).
// ---------------------------------------------------------------------------

const DANGLING_ISOLATED_CASES = [
  { sub: 'parallel',  run: runParallel },
  { sub: 'changed',   run: runChanged },
  { sub: 'benchmark', run: runBenchmark },
  { sub: 'android',   run: runAndroid },
];

describe.each(DANGLING_ISOLATED_CASES)(
  'L1: $sub --isolated-cache-dir (dangling)',
  ({ run }) => {
    it("exits CONFIG_ERROR (2) with errors[].code === 'invalid_flag_value', flag === '--isolated-cache-dir'", async () => {
      const result = await run({
        projectRoot: '/tmp/nonexistent-stub',
        args: ['--isolated-cache-dir'],
      });
      expect(result.exitCode).toBe(EXIT.CONFIG_ERROR);
      const matching = (result.envelope.errors || []).find(
        e => e.code === 'invalid_flag_value' && e.flag === '--isolated-cache-dir',
      );
      expect(matching).toBeTruthy();
      expect(matching.message).toContain('--isolated-cache-dir');
    });
  },
);

// ---------------------------------------------------------------------------
// Dangling value-bearing flags (2026-06-10 normalization — extends the L1
// `--isolated-cache-dir` fix to the whole bug-class). Pre-fix every parser
// silently treated a trailing value-bearing flag as if it had been omitted
// (`argv[++i] || ''`), hiding the user's mistake until gradle/adb failed
// confusingly later. One case per parser per flag class (string / enum /
// numeric / gradle-args).
// ---------------------------------------------------------------------------

const DANGLING_VALUE_CASES = [
  // string flags
  { sub: 'parallel',  run: runParallel,  flag: '--device' },
  { sub: 'parallel',  run: runParallel,  flag: '--module-filter' },
  { sub: 'parallel',  run: runParallel,  flag: '--output-file' },
  { sub: 'changed',   run: runChanged,   flag: '--test-filter' },
  { sub: 'changed',   run: runChanged,   flag: '--variant' },
  { sub: 'android',   run: runAndroid,   flag: '--device' },
  { sub: 'android',   run: runAndroid,   flag: '--capture-dir' },
  { sub: 'benchmark', run: runBenchmark, flag: '--module-filter' },
  { sub: 'benchmark', run: runBenchmark, flag: '--config' },
  { sub: 'coverage',  run: runCoverage,  flag: '--coverage-modules' },
  { sub: 'coverage',  run: runCoverage,  flag: '--output-file' },
  { sub: 'describe',  run: runDescribe,  flag: '--module-filter' },
  { sub: 'update',    run: runUpdate,    flag: '--prefix' },
  // enum flags (validateEnum contract flip)
  { sub: 'parallel',  run: runParallel,  flag: '--test-type' },
  { sub: 'benchmark', run: runBenchmark, flag: '--platform' },
  // numeric flags (validateNonNegativeInt contract flip)
  { sub: 'parallel',  run: runParallel,  flag: '--max-workers' },
  // gradle-args accumulator
  { sub: 'parallel',  run: runParallel,  flag: '--gradle-args' },
  { sub: 'android',   run: runAndroid,   flag: '--gradle-args' },
];

describe.each(DANGLING_VALUE_CASES)(
  'dangling $sub $flag',
  ({ run, flag }) => {
    it("exits CONFIG_ERROR (2) with errors[].code === 'invalid_flag_value'", async () => {
      const result = await run({
        projectRoot: '/tmp/nonexistent-stub',
        args: [flag],
      });
      expect(result.exitCode).toBe(EXIT.CONFIG_ERROR);
      const matching = (result.envelope.errors || []).find(
        e => e.code === 'invalid_flag_value' && e.flag === flag,
      );
      expect(matching).toBeTruthy();
      expect(matching.message).toContain('missing required value');
    });
  },
);

// ---------------------------------------------------------------------------
// PR-10 — contextual argument schema
// ---------------------------------------------------------------------------

// requireFlagValue — opaque option
//
// Non-opaque (default): a value starting with '--' is rejected as
// `invalid_flag_value` because the user likely forgot the actual value
// and the next token is another flag.
// Opaque (--gradle-args): the value is forwarded verbatim to Gradle and
// may legitimately start with '--' or contain '%' characters.
describe('requireFlagValue — opaque option', () => {
  it('non-opaque: rejects value starting with -- as invalid_flag_value', () => {
    const errors = [];
    const result = requireFlagValue('--module-filter', '--test-type', errors);
    expect(result).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'invalid_flag_value',
      flag: '--module-filter',
      value: '--test-type',
    });
    expect(errors[0].message).toMatch(/forgot the value/);
  });

  it('opaque: accepts value starting with --', () => {
    const errors = [];
    const result = requireFlagValue('--gradle-args', '--no-parallel', errors, { opaque: true });
    expect(result).toBe('--no-parallel');
    expect(errors).toHaveLength(0);
  });

  it('opaque: accepts value containing percent characters', () => {
    const errors = [];
    const pct = '-Pkmp.test.literal=%KMP_SHOULD_NOT_EXPAND%';
    const result = requireFlagValue('--gradle-args', pct, errors, { opaque: true });
    expect(result).toBe(pct);
    expect(errors).toHaveLength(0);
  });

  it('(regression) non-opaque: undefined still emits missing-value error', () => {
    const errors = [];
    const result = requireFlagValue('--module-filter', undefined, errors);
    expect(result).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'invalid_flag_value',
      flag: '--module-filter',
      value: null,
    });
    expect(errors[0].message).toMatch(/missing required value/);
  });

  it('(regression) opaque: undefined still emits missing-value error', () => {
    const errors = [];
    const result = requireFlagValue('--gradle-args', undefined, errors, { opaque: true });
    expect(result).toBeNull();
    expect(errors[0].message).toMatch(/missing required value/);
  });
});

// orchestrator-level unknown_flag
//
// The parallel parseArgs default case emits unknown_flag for any --flag
// token not present in the parallel switch. Positionals and single-dash
// tokens (gradle-style) are NOT flagged.
describe('parallel parseArgs — unknown_flag', () => {
  it('emits unknown_flag for an unrecognised --flag', () => {
    const opts = parseParallelArgs(['--no-such-kmp-flag']);
    expect(opts.errors.some(e => e.code === 'unknown_flag' && e.flag === '--no-such-kmp-flag'))
      .toBe(true);
  });

  it('emits unknown_flag for multiple unknown --flags', () => {
    const opts = parseParallelArgs(['--no-such-kmp-flag', '--another-unknown']);
    const codes = opts.errors.filter(e => e.code === 'unknown_flag').map(e => e.flag);
    expect(codes).toContain('--no-such-kmp-flag');
    expect(codes).toContain('--another-unknown');
  });

  it('does NOT flag positional tokens', () => {
    const opts = parseParallelArgs(['positional']);
    expect(opts.errors.filter(e => e.code === 'unknown_flag')).toHaveLength(0);
  });

  it('does NOT flag single-dash tokens (gradle-style pass-through values)', () => {
    const opts = parseParallelArgs(['-Pfoo=bar']);
    expect(opts.errors.filter(e => e.code === 'unknown_flag')).toHaveLength(0);
  });

  it('emits unknown_flag that exits CONFIG_ERROR (2) via runParallel', async () => {
    const result = await runParallel({
      projectRoot: '/tmp/nonexistent-stub',
      args: ['--no-such-kmp-flag'],
    });
    expect(result.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(
      (result.envelope.errors || []).some(e => e.code === 'unknown_flag' && e.flag === '--no-such-kmp-flag'),
    ).toBe(true);
  });
});

// --gradle-args lossless round-trip
//
// Opaque values (--flag-shaped, percent-containing, equals-form) must
// survive the parser and appear verbatim in gradleArgs[].
// Values with no embedded spaces are fully lossless under splitGradleArgs.
describe('parallel parseArgs — --gradle-args lossless values', () => {
  it('--gradle-args --no-parallel: preserves flag-shaped value, no error', () => {
    const opts = parseParallelArgs(['--gradle-args', '--no-parallel']);
    expect(opts.errors).toHaveLength(0);
    expect(opts.gradleArgs).toContain('--no-parallel');
  });

  it('--gradle-args=--no-parallel (equals form): split then preserved', () => {
    const opts = parseParallelArgs(['--gradle-args=--no-parallel']);
    expect(opts.errors).toHaveLength(0);
    expect(opts.gradleArgs).toContain('--no-parallel');
  });

  it('--gradle-args with percent literal: round-trips without expansion', () => {
    const pct = '-Pkmp.test.literal=%KMP_SHOULD_NOT_EXPAND%';
    const opts = parseParallelArgs(['--gradle-args', pct]);
    expect(opts.errors).toHaveLength(0);
    expect(opts.gradleArgs).toContain(pct);
  });

  it('--gradle-args with equals inside value: preserved intact', () => {
    const opts = parseParallelArgs(['--gradle-args', '-Pfoo=bar=baz']);
    expect(opts.errors).toHaveLength(0);
    expect(opts.gradleArgs).toContain('-Pfoo=bar=baz');
  });

  it('repeated --gradle-args: accumulates all values', () => {
    const pct = '-Pkmp.test.literal=%KMP_SHOULD_NOT_EXPAND%';
    const opts = parseParallelArgs(['--gradle-args', '--no-parallel', '--gradle-args', pct]);
    expect(opts.errors).toHaveLength(0);
    expect(opts.gradleArgs).toContain('--no-parallel');
    expect(opts.gradleArgs).toContain(pct);
  });

  it('non-opaque --module-filter followed by -- flag: emits invalid_flag_value', () => {
    const opts = parseParallelArgs(['--module-filter', '--test-type', 'android']);
    expect(
      opts.errors.some(e => e.code === 'invalid_flag_value' && e.flag === '--module-filter'),
    ).toBe(true);
  });
});

// Explicit-empty stays on each flag's legacy fallback — only true dangling
// (undefined) is invalid. Locks the policy boundary of this PR.
it('explicit-empty value is NOT invalid (legacy falsy fallback preserved)', async () => {
  const result = await runParallel({
    projectRoot: '/tmp/nonexistent-stub',
    args: ['--module-filter', '', '--dry-run'],
  });
  const danglingErr = (result.envelope.errors || []).find(
    e => e.code === 'invalid_flag_value' && e.flag === '--module-filter',
  );
  expect(danglingErr).toBeFalsy();
});

// ---------------------------------------------------------------------------
// Bug-C — describe regex validation
// ---------------------------------------------------------------------------

describe('Bug-C: describe --module-filter invalid regex', () => {
  it('exits CONFIG_ERROR (2) with errors[].code === "invalid_regex"', () => {
    const result = runDescribe({
      projectRoot: '/tmp/nonexistent-stub',
      args: ['--module-filter', '[unclosed'],
    });
    expect(result.exitCode).toBe(EXIT.CONFIG_ERROR);
    expect(result.envelope.errors).toBeTruthy();
    const err = result.envelope.errors.find(e => e.code === 'invalid_regex');
    expect(err).toBeTruthy();
    expect(err.flag).toBe('--module-filter');
    expect(err.value).toBe('[unclosed');
    expect(err.message).toContain('--module-filter');
  });

  it('exits CONFIG_ERROR (2) for positional shorthand with invalid regex', () => {
    // Positional binding for describe (drift #5, PR #168) routes the first
    // non-flag token into `moduleFilter` — same regex compilation must fire.
    const result = runDescribe({
      projectRoot: '/tmp/nonexistent-stub',
      args: ['[unclosed'],
    });
    expect(result.exitCode).toBe(EXIT.CONFIG_ERROR);
    const err = result.envelope.errors.find(e => e.code === 'invalid_regex');
    expect(err).toBeTruthy();
  });

  it('accepts valid regex without producing invalid_regex error', () => {
    // Sanity: a valid regex must NOT trigger the invalid_regex path. The
    // project-root may or may not exist — describe will emit some envelope
    // either way (CONFIG_ERROR `no_project` or success), but the errors[]
    // array MUST NOT carry an invalid_regex entry.
    const result = runDescribe({
      projectRoot: '/tmp/nonexistent-stub',
      args: ['--module-filter', '^core'],
    });
    expect((result.envelope.errors || []).find(e => e.code === 'invalid_regex')).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Envelope shape — invalid args envelope mirrors the standard envelope
// ---------------------------------------------------------------------------

describe('invalid args envelope shape', () => {
  it('carries top-level schema_version, tool, subcommand, exit_code', async () => {
    const result = await runParallel({ projectRoot: '/tmp/nonexistent-stub', args: ['--test-type', 'bogus'] });
    expect(result.envelope.tool).toBe('kmp-test');
    expect(result.envelope.schema_version).toBe(2);
    expect(result.envelope.subcommand).toBe('parallel');
    expect(result.envelope.exit_code).toBe(EXIT.CONFIG_ERROR);
    expect(result.envelope.tests).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });
    expect(result.envelope.modules).toEqual([]);
    expect(result.envelope.warnings).toEqual([]);
  });
});

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

import { validateEnum, validateNonNegativeInt } from '../../lib/orchestrators/orchestrator-utils.js';
import { runParallel } from '../../lib/orchestrators/parallel-orchestrator.js';
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

  it('treats undefined as missing (not invalid)', () => {
    const errors = [];
    const result = validateEnum('--test-type', undefined, ['common'], errors);
    expect(result).toBeUndefined();
    expect(errors).toEqual([]);
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

  it('treats undefined as missing (not invalid)', () => {
    const errors = [];
    const result = validateNonNegativeInt('--max-workers', undefined, errors);
    expect(result).toBeUndefined();
    expect(errors).toEqual([]);
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
  { sub: 'changed',   run: runChanged,   args: ['--max-failures', 'abc'], code: 'invalid_flag_value', flag: '--max-failures' },
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

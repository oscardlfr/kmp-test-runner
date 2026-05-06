// SPDX-License-Identifier: MIT
// tests/vitest/macos-validation-gate.test.js — v0.9 step 7 (Phase A).
//
// Locks the matrix shape, argv hygiene, mode gating, and shape-diff
// behavior of `tools/macos-validation-gate.mjs`. No spawn — the driver
// dependencies for adb / filesystem are injected via the `deps`
// parameter exposed on `buildMatrix`. The mode-full guard is exercised
// by feeding raw argv through `parseArgs`.

import { describe, it, expect } from 'vitest';

import {
  PROJECTS,
  TEST_TYPES,
  SUBCOMMANDS,
  parseArgs,
  buildMatrix,
  safeName,
  extractShape,
  diffShapes,
  loadSnapshots,
  extractEnvelope,
} from '../../tools/macos-validation-gate.mjs';

const FORBIDDEN_FLAGS = ['--ignore-jdk-mismatch'];
const SHELL_METACHARS = /[;&|`$<>(){}*?\[\]\\!]/;

const happyDeps = () => ({
  adbHasDevice: () => true,
  projectExists: () => true,
});

const noDeviceDeps = () => ({
  adbHasDevice: () => false,
  projectExists: () => true,
});

const allMissingDeps = () => ({
  adbHasDevice: () => true,
  projectExists: () => false,
});

const baseDryOpts = {
  mode: 'dry',
  subcommand: 'all',
  testType: 'all-of',
  project: 'all',
  timeout: 900,
  output: 'MACOS-GATE-V0.9-SUMMARY.md',
  reclassify: false,
  iHaveTwentyGb: false,
  abortFloorMb: 2048,
  stopDaemons: true,
};

describe('macos-validation-gate / matrix shape', () => {
  it('enumerates exactly 45 cells in the full happy-path matrix', () => {
    const cells = buildMatrix(baseDryOpts, happyDeps());
    // 2 subcommands (parallel, changed) × 7 test-types × 3 projects = 42
    // 1 subcommand (android)                                × 3 projects =  3
    expect(cells).toHaveLength(45);
  });

  it('produces 21 parallel cells, 21 changed cells, and 3 android cells', () => {
    const cells = buildMatrix(baseDryOpts, happyDeps());
    const counts = cells.reduce((acc, c) => {
      acc[c.subcommand] = (acc[c.subcommand] || 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ parallel: 21, changed: 21, android: 3 });
  });

  it('android cells carry no testType (subcommand is instrumented-only)', () => {
    const cells = buildMatrix(baseDryOpts, happyDeps())
      .filter((c) => c.subcommand === 'android');
    expect(cells).toHaveLength(3);
    for (const c of cells) {
      expect(c.testType).toBeNull();
      expect(c.args).not.toContain('--test-type');
    }
  });

  it('every (subcommand, test-type) combo appears exactly once per project for parallel/changed', () => {
    const cells = buildMatrix(baseDryOpts, happyDeps())
      .filter((c) => c.subcommand !== 'android');
    const seen = new Set();
    for (const c of cells) {
      const key = `${c.subcommand}|${c.testType}|${c.project}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(2 * TEST_TYPES.length * PROJECTS.length);
  });

  it('TEST_TYPES + SUBCOMMANDS exactly match the documented v0.9 surface', () => {
    expect(TEST_TYPES).toEqual([
      'all', 'common', 'androidUnit', 'androidInstrumented',
      'desktop', 'ios', 'macos',
    ]);
    expect(SUBCOMMANDS).toEqual(['parallel', 'changed', 'android']);
  });
});

describe('macos-validation-gate / skip rules', () => {
  it('marks androidInstrumented + android cells [SKIP] device-required when adb returns no devices', () => {
    const cells = buildMatrix(baseDryOpts, noDeviceDeps());
    const skipped = cells.filter((c) => c.skipReason === 'device-required');
    // android subcommand on shared-kmp-libs + KaMPKit (fixture has no instrumented target)
    // PLUS parallel/changed × androidInstrumented × 3 projects
    expect(skipped.length).toBeGreaterThan(0);
    for (const c of skipped) {
      const isInstrumented = c.subcommand === 'android' || c.testType === 'androidInstrumented';
      expect(isInstrumented).toBe(true);
    }
  });

  it('marks fixture android cell [SKIP] no-instrumented-target', () => {
    const cells = buildMatrix(baseDryOpts, happyDeps())
      .filter((c) => c.subcommand === 'android' && c.project === 'fixture');
    expect(cells).toHaveLength(1);
    expect(cells[0].skipReason).toBe('no-instrumented-target');
  });

  it('marks every cell [SKIP] project-absent when projectExists returns false', () => {
    const cells = buildMatrix(baseDryOpts, allMissingDeps());
    expect(cells).toHaveLength(45);
    for (const c of cells) {
      expect(c.skipReason).toBe('project-absent');
    }
  });
});

describe('macos-validation-gate / argv hygiene', () => {
  it('every emitted args[] uses absolute project-root paths', () => {
    const cells = buildMatrix(baseDryOpts, happyDeps());
    for (const c of cells) {
      const idx = c.args.indexOf('--project-root');
      expect(idx).toBeGreaterThan(-1);
      const value = c.args[idx + 1];
      expect(value.startsWith('/')).toBe(true);
    }
  });

  it('never emits forbidden flags (memory rule: feedback_json_ignore_jdk_hides_errors.md)', () => {
    const cells = buildMatrix(baseDryOpts, happyDeps());
    for (const c of cells) {
      for (const flag of FORBIDDEN_FLAGS) {
        expect(c.args).not.toContain(flag);
      }
    }
  });

  it('emits --json for every cell', () => {
    const cells = buildMatrix(baseDryOpts, happyDeps());
    for (const c of cells) {
      expect(c.args).toContain('--json');
    }
  });

  it('contains no shell metacharacters in any emitted argv slot', () => {
    const cells = buildMatrix(baseDryOpts, happyDeps());
    for (const c of cells) {
      for (const a of c.args) {
        expect(SHELL_METACHARS.test(a)).toBe(false);
      }
    }
  });

  it('uses --module-filter with a name pattern (no leading colon) in scoped mode', () => {
    const cells = buildMatrix({ ...baseDryOpts, mode: 'scoped' }, happyDeps())
      .filter((c) => c.subcommand !== 'android');
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      const idx = c.args.indexOf('--module-filter');
      expect(idx).toBeGreaterThan(-1);
      expect(c.args[idx + 1].startsWith(':')).toBe(false);
    }
  });

  it('omits --module-filter in dry mode', () => {
    const cells = buildMatrix(baseDryOpts, happyDeps());
    for (const c of cells) {
      expect(c.args).not.toContain('--module-filter');
    }
  });
});

describe('macos-validation-gate / parseArgs + mode gating', () => {
  it('defaults to mode=dry, subcommand=all, testType=all-of, project=all', () => {
    const opts = parseArgs([]);
    expect(opts.mode).toBe('dry');
    expect(opts.subcommand).toBe('all');
    expect(opts.testType).toBe('all-of');
    expect(opts.project).toBe('all');
    expect(opts.iHaveTwentyGb).toBe(false);
    expect(opts.abortFloorMb).toBe(2048);
    expect(opts.stopDaemons).toBe(true);
  });

  it('rejects --mode full without --i-have-20gb-free (memory rule disk guard)', () => {
    expect(() => parseArgs(['--mode', 'full'])).toThrow(/--i-have-20gb-free/);
  });

  it('accepts --mode full with the override flag', () => {
    const opts = parseArgs(['--mode', 'full', '--i-have-20gb-free']);
    expect(opts.mode).toBe('full');
    expect(opts.iHaveTwentyGb).toBe(true);
  });

  it('rejects unknown --mode values', () => {
    expect(() => parseArgs(['--mode', 'bogus'])).toThrow(/Invalid --mode/);
  });

  it('rejects unknown --subcommand values', () => {
    expect(() => parseArgs(['--subcommand', 'bogus'])).toThrow(/Invalid --subcommand/);
  });

  it('rejects unknown --test-type values', () => {
    expect(() => parseArgs(['--test-type', 'jvm'])).toThrow(/Invalid --test-type/);
  });

  it('accepts --no-stop-daemons toggle', () => {
    const opts = parseArgs(['--no-stop-daemons']);
    expect(opts.stopDaemons).toBe(false);
  });
});

describe('macos-validation-gate / safeName', () => {
  it('produces filesystem-safe names', () => {
    const out = safeName({ sub: 'parallel', testType: 'androidInstrumented', project: 'KaMPKit' });
    expect(out).toBe('parallel_androidInstrumented_KaMPKit');
    expect(SHELL_METACHARS.test(out)).toBe(false);
  });

  it('uniquely identifies every cell in the 45-cell matrix', () => {
    const cells = buildMatrix(baseDryOpts, happyDeps());
    const names = cells.map((c) => c.safeName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('emits "none" for android cells (no testType)', () => {
    const out = safeName({ sub: 'android', testType: null, project: 'fixture' });
    expect(out).toBe('android_none_fixture');
  });
});

describe('macos-validation-gate / shape diff', () => {
  it('extractShape walks nested objects and arrays into dot-paths', () => {
    const env = {
      tool: 'kmp-test',
      tests: { failed: 0, passed: 0 },
      modules: [{ name: ':a', platforms: ['jvm'] }],
    };
    const shape = extractShape(env);
    expect(shape).toContain('tool');
    expect(shape).toContain('tests');
    expect(shape).toContain('tests.failed');
    expect(shape).toContain('tests.passed');
    expect(shape).toContain('modules');
    expect(shape).toContain('modules[].name');
    expect(shape).toContain('modules[].platforms');
  });

  it('diffShapes returns agree=true for identical shapes', () => {
    const a = extractShape({ x: 1, y: { z: true } });
    const b = extractShape({ x: 99, y: { z: false } });
    const d = diffShapes(a, b);
    expect(d.agree).toBe(true);
    expect(d.onlyInExpected).toEqual([]);
    expect(d.onlyInObserved).toEqual([]);
  });

  it('diffShapes detects a removed top-level key', () => {
    const expected = extractShape({ a: 1, b: 2, c: 3 });
    const observed = extractShape({ a: 1, b: 2 });
    const d = diffShapes(expected, observed);
    expect(d.agree).toBe(false);
    expect(d.onlyInExpected).toEqual(['c']);
    expect(d.onlyInObserved).toEqual([]);
  });

  it('diffShapes detects an added top-level key', () => {
    const expected = extractShape({ a: 1 });
    const observed = extractShape({ a: 1, b: 2 });
    const d = diffShapes(expected, observed);
    expect(d.agree).toBe(false);
    expect(d.onlyInObserved).toEqual(['b']);
  });

  it('extractShape ignores concrete value differences (path-only contract)', () => {
    const a = extractShape({ duration_ms: '<DURATION_MS>' });
    const b = extractShape({ duration_ms: 1234 });
    expect(diffShapes(a, b).agree).toBe(true);
  });
});

describe('macos-validation-gate / snapshot loader', () => {
  it('loadSnapshots parses Vitest export blocks into a title-keyed map', () => {
    const sample = [
      'exports[`a > parallel envelope shape is stable 1`] = `',
      '{',
      '  "tool": "kmp-test",',
      '  "exit_code": 0,',
      '}',
      '`;',
      '',
      'exports[`a > android envelope shape is stable 1`] = `',
      '{',
      '  "tool": "kmp-test",',
      '  "errors": [',
      '    { "code": "no_test_modules" },',
      '  ],',
      '}',
      '`;',
    ].join('\n');
    const snaps = loadSnapshots(sample);
    expect(Object.keys(snaps)).toHaveLength(2);
    const parallel = snaps['a > parallel envelope shape is stable 1'];
    expect(parallel.parsed.tool).toBe('kmp-test');
    expect(parallel.parsed.exit_code).toBe(0);
    const android = snaps['a > android envelope shape is stable 1'];
    expect(android.parsed.errors[0].code).toBe('no_test_modules');
  });
});

describe('macos-validation-gate / extractEnvelope', () => {
  it('extracts the JSON envelope between sentinel markers', () => {
    const stdout = [
      'banner output that the orchestrator prints first',
      '__KMP_TEST_ENVELOPE_V1_BEGIN__',
      JSON.stringify({ tool: 'kmp-test', exit_code: 0 }),
      '__KMP_TEST_ENVELOPE_V1_END__',
      'trailing log lines',
    ].join('\n');
    const env = extractEnvelope(stdout);
    expect(env).toEqual({ tool: 'kmp-test', exit_code: 0 });
  });

  it('returns null when no envelope is emitted', () => {
    expect(extractEnvelope('plain stderr garbage')).toBeNull();
    expect(extractEnvelope('')).toBeNull();
    expect(extractEnvelope(null)).toBeNull();
  });
});

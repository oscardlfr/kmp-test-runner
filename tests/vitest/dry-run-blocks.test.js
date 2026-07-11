// SPDX-License-Identifier: MIT
// tests/vitest/dry-run-blocks.test.js — full coverage of the dry-run block
// builders introduced in PR 3.1.
//
// The builders are pure functions consumed by:
//   - lib/runners/script-dispatcher.js (CLI path: bin/kmp-test.js → cli.js
//     → dispatcher → buildDryRunBlockFromArgv on `--dry-run` short-circuit)
//   - lib/orchestrators/android-orchestrator.js (direct-call path:
//     `node lib/runner.js android --dry-run`)
//   - lib/orchestrators/benchmark-orchestrator.js (same direct-call path)
//   - lib/orchestrators/changed-orchestrator.js (same direct-call path)
//
// Both call sites converge on the same builder, so the envelope shape is
// identical regardless of entry point. This file tests the builders
// themselves; parity.test.js exercises them end-to-end through the CLI.

import { describe, it, expect } from 'vitest';
import {
  buildAndroidBlock,
  buildBenchmarkBlock,
  buildChangedBlock,
  buildParallelBlock,
  buildDryRunBlockFromArgv,
  findFlagValue,
  hasFlag,
  parseIntFlag,
} from '../../lib/envelope/dry-run-blocks.js';

// ---------------------------------------------------------------------------
// Argv helpers
// ---------------------------------------------------------------------------

describe('findFlagValue', () => {
  it('returns the value following the named flag', () => {
    expect(findFlagValue(['--device', 'DEVICE_SERIAL_FAKE'], '--device')).toBe('DEVICE_SERIAL_FAKE');
  });

  it('returns empty string when the flag is absent', () => {
    expect(findFlagValue(['--other', 'x'], '--device')).toBe('');
  });

  it('returns empty string when the flag has no following token', () => {
    expect(findFlagValue(['--device'], '--device')).toBe('');
  });

  it('treats `--foo --bar` as boolean (returns empty for `--foo`)', () => {
    expect(findFlagValue(['--device', '--flavor', 'staging'], '--device')).toBe('');
  });

  it('returns empty string for non-array input (defensive)', () => {
    expect(findFlagValue(null, '--device')).toBe('');
    expect(findFlagValue(undefined, '--device')).toBe('');
    expect(findFlagValue('--device DEVICE_SERIAL_FAKE', '--device')).toBe('');
  });

  it('finds the first occurrence when the flag is repeated', () => {
    expect(findFlagValue(['--device', 'A', '--device', 'B'], '--device')).toBe('A');
  });

  it('handles complex values (paths, glob, special chars)', () => {
    expect(findFlagValue(['--module-filter', 'core-*,:feature:auth'], '--module-filter'))
      .toBe('core-*,:feature:auth');
  });
});

describe('hasFlag', () => {
  it('returns true when the flag is present', () => {
    expect(hasFlag(['--dry-run', '--json'], '--dry-run')).toBe(true);
  });

  it('returns false when the flag is absent', () => {
    expect(hasFlag(['--json'], '--dry-run')).toBe(false);
  });

  it('returns false for non-array input', () => {
    expect(hasFlag(null, '--dry-run')).toBe(false);
    expect(hasFlag(undefined, '--dry-run')).toBe(false);
  });

  it('returns false for empty argv', () => {
    expect(hasFlag([], '--dry-run')).toBe(false);
  });
});

describe('parseIntFlag', () => {
  it('parses a valid integer', () => {
    expect(parseIntFlag(['--max-workers', '8'], '--max-workers', 0)).toBe(8);
  });

  it('returns default when the flag is absent', () => {
    expect(parseIntFlag(['--other', '1'], '--max-workers', 4)).toBe(4);
  });

  it('returns default when the value is non-numeric', () => {
    expect(parseIntFlag(['--max-workers', 'abc'], '--max-workers', 4)).toBe(4);
  });

  it('handles zero correctly (not confused with default)', () => {
    expect(parseIntFlag(['--max-workers', '0'], '--max-workers', 4)).toBe(0);
  });

  it('handles negative integers', () => {
    expect(parseIntFlag(['--max-workers', '-1'], '--max-workers', 4)).toBe(-1);
  });

  it('handles values with leading whitespace via parseInt', () => {
    expect(parseIntFlag(['--max-workers', ' 7'], '--max-workers', 0)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// buildAndroidBlock
// ---------------------------------------------------------------------------

describe('buildAndroidBlock', () => {
  it('emits all 4 fields with defaults when input is empty', () => {
    expect(buildAndroidBlock()).toEqual({
      device_serial: '',
      device_task: '',
      flavor: '',
      instrumented_modules: [],
    });
  });

  it('echoes --device value to device_serial', () => {
    expect(buildAndroidBlock({ device: 'DEVICE_SERIAL_FAKE' }).device_serial).toBe('DEVICE_SERIAL_FAKE');
  });

  it('echoes --device-task to device_task', () => {
    expect(buildAndroidBlock({ deviceTask: 'androidConnectedCheck' }).device_task)
      .toBe('androidConnectedCheck');
  });

  it('echoes --flavor to flavor', () => {
    expect(buildAndroidBlock({ flavor: 'staging' }).flavor).toBe('staging');
  });

  it('accepts modules as strings', () => {
    expect(buildAndroidBlock({ modules: [':app', ':feature:auth'] }).instrumented_modules)
      .toEqual([':app', ':feature:auth']);
  });

  it('accepts modules as `{name}` objects (auto-coerces)', () => {
    expect(buildAndroidBlock({
      modules: [{ name: ':app' }, { name: ':feature:auth' }],
    }).instrumented_modules).toEqual([':app', ':feature:auth']);
  });

  it('filters out empty / nullish module entries', () => {
    expect(buildAndroidBlock({
      modules: [':app', null, undefined, '', { name: '' }, { name: ':b' }],
    }).instrumented_modules).toEqual([':app', ':b']);
  });

  it('treats explicit empty strings as falsy → defaults to ""', () => {
    expect(buildAndroidBlock({ device: '', deviceTask: '', flavor: '' })).toEqual({
      device_serial: '',
      device_task: '',
      flavor: '',
      instrumented_modules: [],
    });
  });

  it('is a pure function — output independent of input mutation', () => {
    const input = { device: 'A', deviceTask: 'B', flavor: 'C', modules: [':x'] };
    const out = buildAndroidBlock(input);
    input.device = 'MUTATED';
    input.modules.push(':y');
    expect(out.device_serial).toBe('A');
    expect(out.instrumented_modules).toEqual([':x']);
  });
});

// ---------------------------------------------------------------------------
// buildBenchmarkBlock
// ---------------------------------------------------------------------------

describe('buildBenchmarkBlock', () => {
  it('emits all 7 fields with defaults when input is empty', () => {
    expect(buildBenchmarkBlock()).toEqual({
      config: 'smoke',
      total: 0,
      passed: 0,
      failed: 0,
      timed_out: 0,
      platforms: [],
      timeout_ms: 0,
    });
  });

  it('echoes --config (smoke / main / stress)', () => {
    expect(buildBenchmarkBlock({ config: 'main' }).config).toBe('main');
    expect(buildBenchmarkBlock({ config: 'stress' }).config).toBe('stress');
  });

  it('defaults config to "smoke" when empty string passed', () => {
    expect(buildBenchmarkBlock({ config: '' }).config).toBe('smoke');
  });

  it('passes through finite timeoutMs', () => {
    expect(buildBenchmarkBlock({ timeoutMs: 300_000 }).timeout_ms).toBe(300_000);
  });

  it('treats 0 as a valid timeout (timeout disabled)', () => {
    expect(buildBenchmarkBlock({ timeoutMs: 0 }).timeout_ms).toBe(0);
  });

  it('coerces non-finite timeout to 0 (Infinity / NaN / string)', () => {
    expect(buildBenchmarkBlock({ timeoutMs: Infinity }).timeout_ms).toBe(0);
    expect(buildBenchmarkBlock({ timeoutMs: NaN }).timeout_ms).toBe(0);
    expect(buildBenchmarkBlock({ timeoutMs: 'oops' }).timeout_ms).toBe(0);
  });

  it('always zeros the counter fields', () => {
    const b = buildBenchmarkBlock({ config: 'stress', timeoutMs: 100 });
    expect(b.total).toBe(0);
    expect(b.passed).toBe(0);
    expect(b.failed).toBe(0);
    expect(b.timed_out).toBe(0);
  });

  it('always emits empty platforms[] (legs run later)', () => {
    expect(buildBenchmarkBlock({ config: 'main' }).platforms).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildChangedBlock
// ---------------------------------------------------------------------------

describe('buildChangedBlock', () => {
  it('emits all 3 fields with defaults when input is empty', () => {
    expect(buildChangedBlock()).toEqual({
      detected_modules: [],
      staged_only: false,
      base_ref: 'HEAD',
    });
  });

  it('echoes stagedOnly: true → staged_only: true', () => {
    expect(buildChangedBlock({ stagedOnly: true }).staged_only).toBe(true);
  });

  it('coerces truthy values to bool', () => {
    expect(buildChangedBlock({ stagedOnly: 1 }).staged_only).toBe(true);
    expect(buildChangedBlock({ stagedOnly: 'yes' }).staged_only).toBe(true);
  });

  it('coerces falsy values to false', () => {
    expect(buildChangedBlock({ stagedOnly: null }).staged_only).toBe(false);
    expect(buildChangedBlock({ stagedOnly: 0 }).staged_only).toBe(false);
    expect(buildChangedBlock({ stagedOnly: undefined }).staged_only).toBe(false);
  });

  it('always emits empty detected_modules[] (git probe runs later)', () => {
    expect(buildChangedBlock({ stagedOnly: true }).detected_modules).toEqual([]);
  });

  it('always emits base_ref: "HEAD" (the only supported base today)', () => {
    expect(buildChangedBlock({ stagedOnly: true }).base_ref).toBe('HEAD');
  });
});

// ---------------------------------------------------------------------------
// buildParallelBlock
// ---------------------------------------------------------------------------

describe('buildParallelBlock', () => {
  it('emits all 4 fields with defaults when input is empty', () => {
    expect(buildParallelBlock()).toEqual({
      test_type: 'auto',
      max_workers: 0,
      timeout_s: 600,
      legs: [],
    });
  });

  it('echoes --test-type', () => {
    expect(buildParallelBlock({ testType: 'androidUnit' }).test_type).toBe('androidUnit');
  });

  it('defaults test_type to "auto" when empty', () => {
    expect(buildParallelBlock({ testType: '' }).test_type).toBe('auto');
  });

  it('echoes --max-workers', () => {
    expect(buildParallelBlock({ maxWorkers: 8 }).max_workers).toBe(8);
  });

  it('echoes --timeout (seconds)', () => {
    expect(buildParallelBlock({ timeoutS: 1200 }).timeout_s).toBe(1200);
  });

  it('coerces non-finite max_workers to 0', () => {
    expect(buildParallelBlock({ maxWorkers: NaN }).max_workers).toBe(0);
    expect(buildParallelBlock({ maxWorkers: Infinity }).max_workers).toBe(0);
  });

  it('coerces non-finite timeoutS to default 600', () => {
    expect(buildParallelBlock({ timeoutS: NaN }).timeout_s).toBe(600);
    expect(buildParallelBlock({ timeoutS: Infinity }).timeout_s).toBe(600);
  });

  it('always emits empty legs[] (real dispatch runs later)', () => {
    expect(buildParallelBlock({ testType: 'androidUnit' }).legs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildDryRunBlockFromArgv — dispatcher adapter
// ---------------------------------------------------------------------------

describe('buildDryRunBlockFromArgv', () => {
  describe('android', () => {
    it('echoes --device + --device-task + --flavor', () => {
      const argv = ['--device', 'DEVICE_SERIAL_FAKE', '--device-task', 'androidConnectedCheck', '--flavor', 'staging'];
      expect(buildDryRunBlockFromArgv('android', argv, {})).toEqual({
        device_serial: 'DEVICE_SERIAL_FAKE',
        device_task: 'androidConnectedCheck',
        flavor: 'staging',
        instrumented_modules: [],
      });
    });

    it('passes plan.modules through to instrumented_modules', () => {
      const argv = ['--device', 'DEVICE_SERIAL_FAKE'];
      const plan = { modules: [{ name: ':app' }, { name: ':feature:auth' }] };
      expect(buildDryRunBlockFromArgv('android', argv, plan).instrumented_modules)
        .toEqual([':app', ':feature:auth']);
    });

    it('handles missing plan defensively', () => {
      const block = buildDryRunBlockFromArgv('android', ['--device', 'X']);
      expect(block.device_serial).toBe('X');
      expect(block.instrumented_modules).toEqual([]);
    });

    it('returns all-defaults block when argv has no relevant flags', () => {
      expect(buildDryRunBlockFromArgv('android', ['--json'], {})).toEqual({
        device_serial: '',
        device_task: '',
        flavor: '',
        instrumented_modules: [],
      });
    });
  });

  describe('benchmark', () => {
    it('echoes --config', () => {
      expect(buildDryRunBlockFromArgv('benchmark', ['--config', 'stress'], {}).config).toBe('stress');
    });

    it('defaults config to "smoke" when absent', () => {
      expect(buildDryRunBlockFromArgv('benchmark', ['--json'], {}).config).toBe('smoke');
    });

    it('always zeros timeout_ms on dispatcher path (orchestrator computes the real value)', () => {
      // Rationale: the dispatcher's dry-run short-circuit runs before the
      // orchestrator's resolveBenchmarkTimeoutMs(). The orchestrator-direct
      // path (`node lib/runner.js benchmark --dry-run`) DOES compute it.
      // Documented divergence — dispatcher gets the structural shape; the
      // accurate timeout is on the orchestrator path.
      expect(buildDryRunBlockFromArgv('benchmark', ['--config', 'smoke'], {}).timeout_ms).toBe(0);
    });
  });

  describe('changed', () => {
    it('detects --staged-only', () => {
      expect(buildDryRunBlockFromArgv('changed', ['--staged-only', '--json'], {}).staged_only).toBe(true);
    });

    it('staged_only:false when flag absent', () => {
      expect(buildDryRunBlockFromArgv('changed', ['--json'], {}).staged_only).toBe(false);
    });
  });

  describe('parallel', () => {
    it('echoes --test-type + --max-workers + --timeout', () => {
      const argv = ['--test-type', 'androidUnit', '--max-workers', '4', '--timeout', '900'];
      expect(buildDryRunBlockFromArgv('parallel', argv, {})).toEqual({
        test_type: 'androidUnit',
        max_workers: 4,
        timeout_s: 900,
        legs: [],
      });
    });

    it('defaults test_type to "auto" when absent', () => {
      expect(buildDryRunBlockFromArgv('parallel', ['--json'], {}).test_type).toBe('auto');
    });

    it('defaults max_workers to 0 when absent', () => {
      expect(buildDryRunBlockFromArgv('parallel', ['--json'], {}).max_workers).toBe(0);
    });

    it('defaults timeout_s to 600 when absent', () => {
      expect(buildDryRunBlockFromArgv('parallel', ['--json'], {}).timeout_s).toBe(600);
    });
  });

  describe('coverage + unknown', () => {
    it('returns null for coverage (no subcommand-specific block on dry-run)', () => {
      expect(buildDryRunBlockFromArgv('coverage', ['--json'], {})).toBeNull();
    });

    it('returns null for unknown subcommands', () => {
      expect(buildDryRunBlockFromArgv('foo', ['--json'], {})).toBeNull();
      expect(buildDryRunBlockFromArgv('', ['--json'], {})).toBeNull();
      expect(buildDryRunBlockFromArgv(undefined, [], {})).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-builder invariants
// ---------------------------------------------------------------------------

describe('cross-builder invariants', () => {
  it('all 4 builders produce objects with stable key sets', () => {
    expect(Object.keys(buildAndroidBlock()).sort()).toEqual([
      'device_serial', 'device_task', 'flavor', 'instrumented_modules',
    ].sort());
    expect(Object.keys(buildBenchmarkBlock()).sort()).toEqual([
      'config', 'total', 'passed', 'failed', 'timed_out', 'platforms', 'timeout_ms',
    ].sort());
    expect(Object.keys(buildChangedBlock()).sort()).toEqual([
      'detected_modules', 'staged_only', 'base_ref',
    ].sort());
    expect(Object.keys(buildParallelBlock()).sort()).toEqual([
      'test_type', 'max_workers', 'timeout_s', 'legs',
    ].sort());
  });

  it('all 4 builders are pure (same input → same output)', () => {
    expect(buildAndroidBlock({ device: 'X' })).toEqual(buildAndroidBlock({ device: 'X' }));
    expect(buildBenchmarkBlock({ config: 'main' })).toEqual(buildBenchmarkBlock({ config: 'main' }));
    expect(buildChangedBlock({ stagedOnly: true })).toEqual(buildChangedBlock({ stagedOnly: true }));
    expect(buildParallelBlock({ maxWorkers: 8 })).toEqual(buildParallelBlock({ maxWorkers: 8 }));
  });

  it('all 4 builders produce JSON-serialisable output', () => {
    expect(() => JSON.stringify(buildAndroidBlock({ device: 'X' }))).not.toThrow();
    expect(() => JSON.stringify(buildBenchmarkBlock({ config: 'main' }))).not.toThrow();
    expect(() => JSON.stringify(buildChangedBlock({ stagedOnly: true }))).not.toThrow();
    expect(() => JSON.stringify(buildParallelBlock({ timeoutS: 900 }))).not.toThrow();
  });
});

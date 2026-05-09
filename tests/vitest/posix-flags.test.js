// SPDX-License-Identifier: MIT
// Tests for the v0.9 session 2 Bug-A.2 POSIX `--name=value` rollout.
//
// Two layers:
//   1. Unit tests on `expandPosixEqualsForm` (orchestrator-utils.js) — the
//      shared helper that all 6 orchestrators consume.
//   2. Parameterized parser tests across the 4 orchestrators that didn't
//      accept POSIX form pre-fix (android, benchmark, changed, describe).
//      Pre-fix the switch / if-else chain matched the FULL token, so
//      `--module-filter=:foo` fell through as "unknown flag" and the value
//      was silently dropped. Post-fix the parser sees the canonical
//      [--module-filter, :foo] shape.

import { describe, it, expect } from 'vitest';

import { expandPosixEqualsForm } from '../../lib/orchestrator-utils.js';
import { parseArgs as parseAndroid } from '../../lib/android-orchestrator.js';
import { parseArgs as parseBenchmark } from '../../lib/benchmark-orchestrator.js';
import { parseArgs as parseChanged } from '../../lib/changed-orchestrator.js';
import { parseArgs as parseDescribe } from '../../lib/describe-orchestrator.js';

describe('expandPosixEqualsForm — unit', () => {
  it('splits --name=value into [--name, value]', () => {
    expect(expandPosixEqualsForm(['--module-filter=:foo'])).toEqual(['--module-filter', ':foo']);
  });

  it('passes through bare --name (no equals)', () => {
    expect(expandPosixEqualsForm(['--module-filter', ':foo'])).toEqual(['--module-filter', ':foo']);
  });

  it('passes through positional arguments', () => {
    expect(expandPosixEqualsForm([':core-result', 'task'])).toEqual([':core-result', 'task']);
  });

  it('preserves multiple `=` signs in value (only the first splits)', () => {
    // Gradle property tokens can carry their own `=` (e.g. `-Pfoo=bar`) inside
    // a `--gradle-args=` value. The helper splits ONLY on the first `=`.
    expect(expandPosixEqualsForm(['--gradle-args=-Pfoo=bar'])).toEqual(['--gradle-args', '-Pfoo=bar']);
  });

  it('does not split when `=` lands at column ≤2 (no flag head)', () => {
    // `--=foo` has eq at index 2, head length 0 — leave alone (caller's parser
    // will drop the unknown token).
    expect(expandPosixEqualsForm(['--=foo'])).toEqual(['--=foo']);
  });

  it('does not split tokens that are not flags', () => {
    expect(expandPosixEqualsForm(['some=value'])).toEqual(['some=value']);
  });

  it('handles a mixed argv (flag, posix-flag, positional, equals-in-value)', () => {
    const input = ['--device', 'R3CT', '--module-filter=:core-result', ':extra', '--gradle-args=--info'];
    expect(expandPosixEqualsForm(input)).toEqual([
      '--device', 'R3CT',
      '--module-filter', ':core-result',
      ':extra',
      '--gradle-args', '--info',
    ]);
  });

  it('passes through non-string entries unchanged', () => {
    // Defensive: orchestrator parsers shouldn't see non-strings, but if they
    // do (e.g. test fixtures injecting numbers), the helper must not crash.
    expect(expandPosixEqualsForm([null, 42, '--foo=bar'])).toEqual([null, 42, '--foo', 'bar']);
  });
});

// Parameterized parser test — each orchestrator's parseArgs MUST treat the
// POSIX `--name=value` form identically to the space form `--name value`.
// Pre-fix the four orchestrators below dropped the value silently because
// their switch / if-else chain matched the FULL token.
const ORCHESTRATOR_CASES = [
  {
    name: 'android',
    parser: parseAndroid,
    flag: '--module-filter',
    value: ':benchmark',
    getter: (out) => out.moduleFilter,
  },
  {
    name: 'benchmark',
    parser: parseBenchmark,
    flag: '--platform',
    value: 'android',
    getter: (out) => out.platform,
  },
  {
    name: 'changed',
    parser: parseChanged,
    flag: '--test-type',
    value: 'common',
    getter: (out) => out.testType,
  },
  {
    name: 'describe',
    parser: parseDescribe,
    flag: '--module-filter',
    value: ':core-result',
    getter: (out) => out.moduleFilter,
  },
];

describe.each(ORCHESTRATOR_CASES)(
  '$name orchestrator — POSIX --name=value parity',
  ({ parser, flag, value, getter }) => {
    it(`accepts ${'`'}--name=value${'`'} form (parses identically to space form)`, () => {
      const fromSpace = parser([flag, value]);
      const fromPosix = parser([`${flag}=${value}`]);
      expect(getter(fromPosix)).toBe(value);
      expect(getter(fromPosix)).toBe(getter(fromSpace));
    });
  },
);

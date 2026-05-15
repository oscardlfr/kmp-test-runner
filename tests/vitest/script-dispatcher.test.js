// SPDX-License-Identifier: MIT
// Tests for lib/runners/script-dispatcher.js#dedupBooleanFlags.
//
// Bug A from the post-PR-09 wet-validation gate (2026-05-10):
// `kmp-test coverage --skip-tests` failed on Windows with
// "Cannot bind parameter because parameter 'SkipTests' is specified more
// than once" because COMMANDS.coverage.prefix already injects --skip-tests
// (canonical wire form) and the user re-passing it duplicated the token.
// The dispatcher now collapses duplicate boolean flags before spawn.

import { describe, it, expect } from 'vitest';

import {
  dedupBooleanFlags,
  KNOWN_BOOLEAN_FLAGS,
} from '../../lib/runners/script-dispatcher.js';

describe('dedupBooleanFlags', () => {
  it('collapses duplicate --skip-tests into one (Bug A repro)', () => {
    const input = ['--skip-tests', '--project-root', '/tmp/x', '--skip-tests'];
    expect(dedupBooleanFlags(input)).toEqual([
      '--skip-tests',
      '--project-root',
      '/tmp/x',
    ]);
  });

  it('does NOT dedup value-bearing flags like --module-filter', () => {
    // --module-filter takes a value — both occurrences must survive so the
    // orchestrator sees both filter patterns.
    const input = [
      '--module-filter', ':foo',
      '--module-filter', ':bar',
    ];
    expect(dedupBooleanFlags(input)).toEqual(input);
  });

  it('preserves positional and unknown args verbatim', () => {
    const input = ['parallel', '--unknown-flag', 'value', ':module-name'];
    expect(dedupBooleanFlags(input)).toEqual(input);
  });

  it('dedups multiple distinct boolean flags independently', () => {
    const input = [
      '--skip-tests',
      '--no-coverage',
      '--skip-tests',
      '--verbose',
      '--no-coverage',
    ];
    expect(dedupBooleanFlags(input)).toEqual([
      '--skip-tests',
      '--no-coverage',
      '--verbose',
    ]);
  });

  it('returns an empty array unchanged', () => {
    expect(dedupBooleanFlags([])).toEqual([]);
  });

  it('exposes KNOWN_BOOLEAN_FLAGS containing --skip-tests', () => {
    // Lock the contract: the bug-A flag MUST be in the set (regression guard
    // against accidental removal during future edits).
    expect(KNOWN_BOOLEAN_FLAGS.has('--skip-tests')).toBe(true);
  });
});

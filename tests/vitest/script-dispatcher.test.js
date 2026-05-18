// SPDX-License-Identifier: MIT
// Tests for lib/runners/script-dispatcher.js#dedupBooleanFlags.
//
// Bug A from the post-PR-09 wet-validation gate (2026-05-10):
// `kmp-test coverage --skip-tests` failed on Windows with
// "Cannot bind parameter because parameter 'SkipTests' is specified more
// than once" because COMMANDS.coverage.prefix already injects --skip-tests
// (canonical wire form) and the user re-passing it duplicated the token.
// The dispatcher now collapses duplicate boolean flags before spawn.

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

import {
  dedupBooleanFlags,
  KNOWN_BOOLEAN_FLAGS,
} from '../../lib/runners/script-dispatcher.js';
import { makeFixtureProject, runSubcommand } from './_parity-helpers.js';

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

// v0.10 #2 — dispatcher-level dry-run surfaces `gradle_config_applied` for
// `parallel`. The script-dispatcher's --dry-run path short-circuits BEFORE
// invoking the Node orchestrator (lib/orchestrators/parallel-orchestrator.js),
// so without this patch agents probing `kmp-test parallel --dry-run --json`
// would never see the `parallel_dropped:true` signal. Restricted to `parallel`
// because other script-backed subs (android/benchmark/coverage) don't inject
// `--parallel` themselves.
describe('v0.10 #2 — dispatcher dry-run surfaces gradle_config_applied for parallel', () => {
  let fixtureRoot = null;
  afterEach(() => {
    if (fixtureRoot && existsSync(fixtureRoot)) {
      try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    fixtureRoot = null;
  });

  it('parallel --dry-run --json with project parallel=false → gradle_config_applied:{parallel_dropped:true}', () => {
    fixtureRoot = makeFixtureProject();
    writeFileSync(path.join(fixtureRoot, 'gradle.properties'), 'org.gradle.parallel=false\n');
    const { envelope, stdout, exitCode } = runSubcommand('parallel', [
      '--project-root', fixtureRoot, '--dry-run', '--json',
    ], { cwd: fixtureRoot });
    if (!envelope) {
      throw new Error(`No envelope (exit ${exitCode}): ${stdout.slice(0, 600)}`);
    }
    expect(envelope.dry_run).toBe(true);
    expect(envelope.gradle_config_applied).toEqual({ parallel_dropped: true });
  });

  it('parallel --dry-run --json with project parallel=true → gradle_config_applied ABSENT', () => {
    fixtureRoot = makeFixtureProject();
    writeFileSync(path.join(fixtureRoot, 'gradle.properties'), 'org.gradle.parallel=true\n');
    const { envelope, stdout, exitCode } = runSubcommand('parallel', [
      '--project-root', fixtureRoot, '--dry-run', '--json',
    ], { cwd: fixtureRoot });
    if (!envelope) {
      throw new Error(`No envelope (exit ${exitCode}): ${stdout.slice(0, 600)}`);
    }
    expect(envelope.dry_run).toBe(true);
    expect('gradle_config_applied' in envelope).toBe(false);
  });
});

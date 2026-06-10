// SPDX-License-Identifier: MIT
// tests/vitest/characterization.test.js — pre-refactor envelope safety net.
//
// PR-00 of the pre-v0.10 refactor. Locks the JSON envelope wire format for
// the cases NOT already covered by parity.test.js (which freezes 9 happy-path
// dry-run/list-only envelopes). This file fills two gaps:
//
//   1. Error envelopes — invalid_flag_value (CONFIG_ERROR / exit 2) + env
//      errors (ENV_ERROR / exit 3). Locked here so refactor PRs that touch
//      buildInvalidArgsEnvelope / envErrorJson / validateEnum (PR-01 envelope
//      builders, PR-05 argv parsers + validators) cannot silently change the
//      shape agents downstream depend on.
//
//   2. Critical variations — non-default flag combos that flex envelope-side
//      effects (--coverage populates coverage:{}, --module-filter rewrites
//      modules[], --variant changes plan). parity.test.js only locks the bare
//      `--dry-run --json` form for each subcommand, so these are additive.
//
// All cases drive `node bin/kmp-test.js <sub> <args>` via subprocess (same
// helper parity.test.js uses) and snapshot the normalized envelope. Snapshots
// live in tests/vitest/__snapshots__/characterization.test.js.snap and are
// the contract — any unintended diff during refactor is the bug.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  REPO_ROOT,
  makeFixtureProject,
  normalizeEnvelopeForSnapshot,
  runSubcommand,
} from './_parity-helpers.js';

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------

let fixtureRoot;
let bareDir;

beforeAll(() => {
  fixtureRoot = makeFixtureProject();
  // Bare directory with no gradlew — used for ENV_ERROR / no_gradlew envelope.
  bareDir = mkdtempSync(path.join(tmpdir(), 'kmp-bare-'));
  // Add a settings file so changed/info don't bail with no_project before the
  // gradlew check fires. We want the no_gradlew code path specifically.
  writeFileSync(path.join(bareDir, 'settings.gradle.kts'), 'rootProject.name = "bare"\n');
});

afterAll(() => {
  for (const dir of [fixtureRoot, bareDir]) {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

// ---------------------------------------------------------------------------
// 1. Invalid-args envelopes (CONFIG_ERROR / exit 2)
// ---------------------------------------------------------------------------
//
// Each case targets a distinct validator path inside cli.js#main pre-spawn
// validation block (lines 2378-2421). After PR-05 (extract argv parsers +
// validators to lib/parsers/), these snapshots remain identical or the bug
// is in the extraction.

describe('characterization / invalid-args envelopes', () => {
  const INVALID_CASES = [
    {
      sub: 'parallel',
      args: ['--test-type', 'bogus', '--json'],
      tag: '--test-type bogus',
    },
    {
      sub: 'parallel',
      args: ['--max-workers', 'abc', '--json'],
      tag: '--max-workers abc (NaN)',
    },
    {
      sub: 'parallel',
      args: ['--max-workers', '-1', '--json'],
      tag: '--max-workers -1 (negative)',
    },
    {
      sub: 'parallel',
      args: ['--max-failures', '1.5', '--json'],
      tag: '--max-failures 1.5 (non-integer)',
    },
    {
      sub: 'parallel',
      args: ['--coverage-tool', 'bogus', '--json'],
      tag: '--coverage-tool bogus',
    },
    {
      sub: 'coverage',
      args: ['--coverage-tool', 'bogus', '--json'],
      tag: '--coverage-tool bogus',
    },
    {
      sub: 'benchmark',
      args: ['--platform', 'bogus', '--json'],
      tag: '--platform bogus',
    },
    {
      sub: 'benchmark',
      args: ['--timeout', 'abc', '--json'],
      tag: '--timeout abc',
    },
    {
      // L1 (2026-06-09 audit): dangling --isolated-cache-dir. `--json` is
      // hoisted at main() entry, so the flag IS the last token by the time
      // peekIsolatedFlags runs — the exact BACKLOG repro shape. Pre-fix:
      // isolation silently OFF + lock taken + token leaked into args.
      sub: 'parallel',
      args: ['--isolated-cache-dir', '--json'],
      tag: '--isolated-cache-dir (dangling)',
    },
    {
      // Dangling enum flag (validator contract flip, 2026-06-10): a trailing
      // `--test-type` with no value is invalid_flag_value instead of being
      // silently swallowed by the pre-spawn loop.
      sub: 'parallel',
      args: ['--test-type', '--json'],
      tag: '--test-type (dangling)',
    },
    {
      // Dangling string flag via the VALUE_BEARING_FLAGS last-token gate:
      // pre-fix the Windows ps1 wrapper died in parameter binding and the
      // run surfaced as `no_summary` exit 1 (wet-reproduced 2026-06-10).
      sub: 'parallel',
      args: ['--device', '--json'],
      tag: '--device (dangling)',
    },
  ];

  for (const { sub, args, tag } of INVALID_CASES) {
    it(`${sub} ${tag} → CONFIG_ERROR envelope`, () => {
      const fullArgs = ['--project-root', fixtureRoot, ...args];
      const { envelope, stdout, exitCode } = runSubcommand(sub, fullArgs, { cwd: fixtureRoot });
      if (!envelope) {
        const preview = stdout.slice(0, 600);
        throw new Error(`No envelope for '${sub} ${tag}' (exit ${exitCode}). stdout: ${preview}`);
      }
      // Sanity invariants — locked outside the snapshot so they're robust to
      // future normalization tweaks.
      expect(envelope.exit_code).toBe(2);
      expect(envelope.subcommand).toBe(sub);
      expect(envelope.errors).toHaveLength(1);
      expect(envelope.errors[0].code).toBe('invalid_flag_value');
      const normalized = normalizeEnvelopeForSnapshot(envelope, fixtureRoot);
      expect(normalized).toMatchSnapshot();
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Environment-error envelope (ENV_ERROR / exit 3)
// ---------------------------------------------------------------------------
//
// Locks the envErrorJson shape via the no_gradlew path. After PR-06 (extract
// shell-runner.js), this contract must remain — the gradlew probe happens
// BEFORE shell dispatch, so PR-06 shouldn't move it.
//
// Uses explicit shape assertions (NOT toMatchSnapshot) because the error
// message is OS-specific: Windows emits "no gradlew.bat found in …" while
// Linux/macOS emit "no gradlew found in …". The wire contract is the envelope
// SHAPE + error code + exit code — the human-facing message is intentionally
// OS-localized and isn't part of the agent-facing contract.

describe('characterization / environment-error envelopes', () => {
  it('parallel in dir without gradlew → no_gradlew envelope shape', () => {
    const fullArgs = ['--project-root', bareDir, '--json'];
    const { envelope, stdout, exitCode } = runSubcommand('parallel', fullArgs, { cwd: bareDir });
    if (!envelope) {
      const preview = stdout.slice(0, 600);
      throw new Error(`No envelope (exit ${exitCode}). stdout: ${preview}`);
    }
    // Lock the envelope shape — every key on envErrorJson must be present.
    expect(envelope).toMatchObject({
      tool: 'kmp-test',
      schema_version: 2,
      subcommand: 'parallel',
      exit_code: 3,
      tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
      modules: [],
      skipped: [],
      coverage: {
        tool: 'auto',
        missed_lines: null,
        modules_with_kover_plugin: [],
        modules_with_jacoco_plugin: [],
      },
      warnings: [],
    });
    expect(envelope.errors).toHaveLength(1);
    expect(envelope.errors[0]).toMatchObject({ code: 'no_gradlew' });
    expect(envelope.errors[0].message).toMatch(/^no gradlew(\.bat)? found in /);
    expect(typeof envelope.duration_ms).toBe('number');
    expect(typeof envelope.version).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 3. Critical variations — non-default flag paths
// ---------------------------------------------------------------------------
//
// parity.test.js locks the bare `--dry-run --json` envelope per subcommand.
// Most flag variations (--coverage, --max-workers <n>, --module-filter :mod)
// produce snapshot-identical output because their effects live inside
// plan.spawn_args / plan.final_args, which the normalizer collapses to
// <PLATFORM_SPECIFIC> — so adding them as snapshots would be redundant
// safety. Only flags that flex envelope fields OUTSIDE the normalized blobs
// earn a snapshot here.
//
// After PR-05 / PR-09, these must remain identical or the bug is in the
// extracted parser / per-command parse() function.

describe('characterization / variation envelopes', () => {
  it('parallel --test-filter SomeTestClass populates plan.test_filter', () => {
    // The only --dry-run variation that produces a non-platform-specific
    // envelope diff: plan.test_filter surfaces the resolved pattern.
    const fullArgs = ['--project-root', fixtureRoot,
      '--dry-run', '--json', '--test-filter', 'SomeTestClass'];
    const { envelope, stdout, exitCode } = runSubcommand('parallel', fullArgs, { cwd: fixtureRoot });
    if (!envelope) {
      const preview = stdout.slice(0, 600);
      throw new Error(`No envelope (exit ${exitCode}). stdout: ${preview}`);
    }
    expect(envelope.plan.test_filter).toBe('SomeTestClass');
    const normalized = normalizeEnvelopeForSnapshot(envelope, fixtureRoot);
    expect(normalized).toMatchSnapshot();
  });

  it('parallel --isolated --dry-run populates isolated:{} alongside plan', () => {
    // parity.test.js asserts isolated.enabled / cache_dir / kept / locked
    // individually but doesn't snapshot the FULL envelope when isolated is
    // active. A snapshot here locks the cross-section: isolated:{} present
    // AND the rest of the envelope unchanged.
    const fullArgs = ['--project-root', fixtureRoot,
      '--dry-run', '--json', '--isolated'];
    const { envelope, stdout, exitCode } = runSubcommand('parallel', fullArgs, { cwd: fixtureRoot });
    if (!envelope) {
      const preview = stdout.slice(0, 600);
      throw new Error(`No envelope (exit ${exitCode}). stdout: ${preview}`);
    }
    expect(envelope.isolated.enabled).toBe(true);
    const normalized = normalizeEnvelopeForSnapshot(envelope, fixtureRoot);
    expect(normalized).toMatchSnapshot();
  });
});

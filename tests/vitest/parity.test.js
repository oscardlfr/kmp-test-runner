// SPDX-License-Identifier: MIT
// tests/vitest/parity.test.js — cross-platform parity check (v0.9 step 5).
//
// Four static sub-checks running on every PR (ubuntu/windows-latest via the
// existing build matrix; NO new macOS minutes). Catch drift between the four
// sources of truth that documented behavior depends on:
//
//   1. Flag matrix audit: orchestrator parseArgs ↔ SUBCOMMAND_HELP text.
//   2. Envelope JSON schema snapshot: golden-file freeze of each subcommand's
//      JSON envelope shape (with volatile fields normalized).
//   3. README ↔ code drift: bidirectional set equality (with allowlist).
//   4. Platform-behavior matrix lock-in: pinned candidate-chains for
//      resolveTasksFor (iOS/macOS/JS/Wasm).
//
// Drift simulations live in the PR description; running this spec without
// modification asserts the codebase is internally consistent.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REPO_ROOT,
  SUBCOMMAND_TO_ORCHESTRATOR,
  CLI_GLOBAL_FLAGS,
  ORCHESTRATOR_INTERNAL_LITERALS,
  GRADLE_PASSTHROUGH_FLAGS,
  extractFlagsFromOrchestratorSource,
  parseReadmeFlagTable,
  normalizeEnvelopeForSnapshot,
  makeFixtureProject,
  runSubcommand,
  getDocumentedFlagsForSubcommand,
  getParsedFlagsForSubcommand,
} from './_parity-helpers.js';

import { resolveTasksFor } from '../../lib/project-model.js';

const SUBCOMMANDS = Object.keys(SUBCOMMAND_TO_ORCHESTRATOR);

// ---------------------------------------------------------------------------
// Sub-check 1 — Flag matrix audit
// ---------------------------------------------------------------------------

describe('parity / flag-matrix audit', () => {
  for (const sub of SUBCOMMANDS) {
    describe(`subcommand: ${sub}`, () => {
      it('every documented flag has a parser case (in cli.js or orchestrator)', () => {
        const documented = getDocumentedFlagsForSubcommand(sub);
        const parsed = getParsedFlagsForSubcommand(sub);
        const documentedNotParsed = [...documented].filter(f => !parsed.has(f));
        expect(documentedNotParsed).toEqual([]);
      });

      // v0.9 session 2 Bug-I — `--java-home` and `--no-jdk-autoselect` exist
      // in CLI_GLOBAL_FLAGS and the underlying parsers (cli.js:getJavaHomeOverride,
      // extractNoJdkAutoselect) but were missing from SUBCOMMAND_HELP. The
      // existing "every documented flag has a parser case" check filters these
      // out via CLI_GLOBAL_FLAGS membership, so add an explicit positive
      // assertion that the help text mentions both by literal name. Skip
      // `info` + `update` + `doctor` which don't gate on JDK toolchain.
      const JDK_ANNOTATED_SUBS = new Set(['parallel', 'changed', 'android', 'coverage', 'benchmark', 'describe']);
      if (JDK_ANNOTATED_SUBS.has(sub)) {
        it('SUBCOMMAND_HELP mentions --java-home and --no-jdk-autoselect (Bug-I)', () => {
          const documented = getDocumentedFlagsForSubcommand(sub);
          expect(documented.has('--java-home')).toBe(true);
          expect(documented.has('--no-jdk-autoselect')).toBe(true);
        });
      }

      it('every orchestrator-parsed flag is documented in SUBCOMMAND_HELP', () => {
        const documented = getDocumentedFlagsForSubcommand(sub);
        const orchestratorRel = SUBCOMMAND_TO_ORCHESTRATOR[sub];
        if (!orchestratorRel) {
          // doctor — flags parsed inline in cli.js. Skip: the inline-runDoctor
          // body is checked by the "every documented flag has a parser case"
          // direction. Asserting the inverse here would re-test the same code.
          return;
        }
        const internal = ORCHESTRATOR_INTERNAL_LITERALS[sub] || new Set();
        // Use the canonical parsedFlags set (includes orchestrator literals +
        // shared-parser flags from orchestrator-utils via SHARED_PARSER_FLAGS).
        // Subtract:
        //   - GRADLE_PASSTHROUGH_FLAGS — gradle CLI tokens emitted, not user-facing.
        //   - CLI_GLOBAL_FLAGS — handled by cli.js; defensive arms in orchestrator.
        //   - ORCHESTRATOR_INTERNAL_LITERALS[sub] — per-sub internal (git args, etc.).
        const parsedFlags = getParsedFlagsForSubcommand(sub);
        const orchestratorOwn = [...parsedFlags].filter(f =>
          !GRADLE_PASSTHROUGH_FLAGS.has(f)
          && !CLI_GLOBAL_FLAGS.has(f)
          && !internal.has(f));
        const parsedNotDocumented = orchestratorOwn.filter(f => !documented.has(f));
        expect(parsedNotDocumented).toEqual([]);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Sub-check 4 — Platform-behavior matrix lock-in
// ---------------------------------------------------------------------------

describe('parity / platform-behavior matrix', () => {
  const matrix = JSON.parse(readFileSync(
    path.join(REPO_ROOT, 'tests', 'vitest', 'fixtures', 'platform-behavior-matrix.json'),
    'utf8',
  ));

  for (const [field, scenarios] of Object.entries(matrix)) {
    describe(`resolveTasksFor → ${field}`, () => {
      for (const { gradleTasks, expected, label } of scenarios) {
        const tag = label || `tasks=[${(gradleTasks || []).join(',') || '∅'}]`;
        it(`${tag} → ${expected === null ? 'null' : expected}`, () => {
          const r = resolveTasksFor(':mod', gradleTasks);
          expect(r[field]).toBe(expected);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Sub-check 3 — README ↔ code drift detection
// ---------------------------------------------------------------------------

describe('parity / README ↔ code drift', () => {
  const allowlistPath = path.join(REPO_ROOT, 'tests', 'vitest', 'fixtures', 'parity-allowlist.json');
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  const allowParsedNotInReadme = new Set(allowlist.parsedButNotInReadme || []);
  const allowReadmeNotParsed = new Set(allowlist.readmeButNotParsed || []);

  const readmePath = path.join(REPO_ROOT, 'README.md');
  const readmeFlags = parseReadmeFlagTable(readmePath);

  // Union of flags parsed by any orchestrator OR by cli.js globals.
  const allParsed = new Set();
  for (const f of CLI_GLOBAL_FLAGS) allParsed.add(f);
  for (const sub of SUBCOMMANDS) {
    for (const f of getParsedFlagsForSubcommand(sub)) allParsed.add(f);
  }

  it('every README flag has at least one parser case', () => {
    const orphans = [...readmeFlags].filter(f => !allParsed.has(f) && !allowReadmeNotParsed.has(f));
    expect(orphans).toEqual([]);
  });

  it('every parsed user-facing flag appears in the README', () => {
    // Filter out gradle-passthrough literals AND every orchestrator's internal
    // literals — these aren't user-facing CLI surface, so they shouldn't be in
    // the README either.
    const allInternal = new Set();
    for (const sub of SUBCOMMANDS) {
      for (const f of (ORCHESTRATOR_INTERNAL_LITERALS[sub] || new Set())) {
        allInternal.add(f);
      }
    }
    const userFacing = [...allParsed].filter(f =>
      !GRADLE_PASSTHROUGH_FLAGS.has(f) && !allInternal.has(f));
    const orphans = userFacing.filter(f => !readmeFlags.has(f) && !allowParsedNotInReadme.has(f));
    expect(orphans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sub-check 2 — Envelope JSON schema snapshot
// ---------------------------------------------------------------------------

describe('parity / envelope JSON schema snapshot', () => {
  let fixtureRoot;

  beforeAll(() => {
    fixtureRoot = makeFixtureProject();
  });

  afterAll(() => {
    if (fixtureRoot) {
      try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // Each entry: { sub, args, env? } — driven via spawnSync of node bin/kmp-test.js.
  // Mode picks the subcommand's lightest path that still emits a complete
  // envelope (no gradle / network spawn).
  const CASES = [
    { sub: 'parallel',  args: ['--dry-run', '--json'] },
    { sub: 'changed',   args: ['--dry-run', '--json', '--staged-only'] },
    { sub: 'android',   args: ['--list-only', '--json'] },
    // PR 3.1 — add an explicit android --dry-run case. The previous matrix
    // covered only --list-only for android; --dry-run goes through the
    // dispatcher's short-circuit (lib/runners/script-dispatcher.js) which
    // before PR 3.1 dropped the android:{} block entirely. This snapshot
    // locks the post-fix shape so a future regression resurfaces immediately.
    { sub: 'android',   args: ['--dry-run', '--json'] },
    { sub: 'benchmark', args: ['--dry-run', '--json'] },
    { sub: 'coverage',  args: ['--dry-run', '--json'] },
    { sub: 'doctor',    args: ['--json'], skipFixture: true },
    { sub: 'info',      args: ['--json', '--no-adb'] },
    { sub: 'describe',  args: ['--json', '--skip-probe'] },
    { sub: 'update',    args: ['--check', '--json'], env: { KMP_TEST_REGISTRY_STUB: '{"tag":"99.99.99","source":"stub"}' } },
  ];

  for (const { sub, args, env, skipFixture } of CASES) {
    it(`${sub} ${args.join(' ')} envelope shape is stable`, () => {
      const cwd = skipFixture ? REPO_ROOT : fixtureRoot;
      const fullArgs = skipFixture ? args : ['--project-root', fixtureRoot, ...args];
      const { envelope, stdout, exitCode } = runSubcommand(sub, fullArgs, { cwd, env });
      // Sanity: envelope parsed (don't assert exit code — coverage --dry-run can
      // legitimately exit non-zero when the project has no coverage reports).
      if (!envelope) {
        const preview = stdout.slice(0, 800);
        throw new Error(`No JSON envelope for '${sub}' (exit ${exitCode}). stdout preview: ${preview}`);
      }
      const normalized = normalizeEnvelopeForSnapshot(envelope, fixtureRoot);
      expect(normalized).toMatchSnapshot();
    });
  }

  // v0.9 session 2 Bug-K — top-level `schema_version` on every envelope.
  // Explicit assertion (not a snapshot) so a future refactor that drops the
  // field is caught without snapshot churn — and so the value is locked at
  // the canonical integer (a `null` or `'2'` would still fit the shape but
  // break the contract). Pre-Bug-K only `describe.schema_version` (sourced
  // from project-model) existed; agents had no version handle for the CLI
  // envelope itself.
  //
  // Bumped 1 → 2 in wet-audit v0.9 part 2: OBS-3 (no_test_modules CONFIG vs
  // ENV split) + OBS-7 (flavor_unused → CONFIG_ERROR) + OBS-4 (isolated
  // runtime-race CONFIG_ERROR) all change exit-code/error-code semantics
  // per the bump policy in lib/cli.js#ENVELOPE_SCHEMA_VERSION comment.
  for (const { sub, args, env, skipFixture } of CASES) {
    it(`${sub} envelope carries top-level schema_version === 2 (Bug-K + wet-audit OBS-3/4/7)`, () => {
      const cwd = skipFixture ? REPO_ROOT : fixtureRoot;
      const fullArgs = skipFixture ? args : ['--project-root', fixtureRoot, ...args];
      const { envelope } = runSubcommand(sub, fullArgs, { cwd, env });
      expect(envelope).toBeTruthy();
      expect(envelope.schema_version).toBe(2);
    });
  }

  // v0.9 step 9.6 (Bug #6) — isolated dry-run envelope. Pre-fix the
  // `--isolated --dry-run` envelope was missing the top-level `isolated:{}`
  // field; only `plan.spawn_args` carried `-Isolated`. Now populated from
  // peekIsolatedFlags upstream of cli.js#buildDryRunReport for shape parity
  // with real-run envelopes.
  describe('--isolated --dry-run populates top-level isolated:{} field (Bug #6)', () => {
    const ISOLATED_CASES = [
      { sub: 'parallel',  args: ['--dry-run', '--json', '--isolated'] },
      { sub: 'changed',   args: ['--dry-run', '--json', '--staged-only', '--isolated'] },
      { sub: 'android',   args: ['--dry-run', '--json', '--isolated'] },
      { sub: 'benchmark', args: ['--dry-run', '--json', '--isolated'] },
    ];
    for (const { sub, args } of ISOLATED_CASES) {
      it(`${sub} ${args.join(' ')} surfaces isolated.enabled:true`, () => {
        const fullArgs = ['--project-root', fixtureRoot, ...args];
        const { envelope, stdout, exitCode } = runSubcommand(sub, fullArgs, { cwd: fixtureRoot });
        if (!envelope) {
          const preview = stdout.slice(0, 600);
          throw new Error(`No JSON envelope for '${sub}' (exit ${exitCode}). stdout preview: ${preview}`);
        }
        expect(envelope.isolated).toBeDefined();
        expect(envelope.isolated.enabled).toBe(true);
        // Dry-run never resolves a real cache dir — null is the contract.
        expect(envelope.isolated.cache_dir).toBeNull();
        expect(envelope.isolated.kept).toBe(false);
        expect(envelope.isolated.locked).toBe(true);
      });
    }

    it('parallel --isolated-cache-dir <path> --dry-run captures cache_dir override', () => {
      const fullArgs = ['--project-root', fixtureRoot,
        '--dry-run', '--json', '--isolated-cache-dir', '/tmp/my-cache'];
      const { envelope } = runSubcommand('parallel', fullArgs, { cwd: fixtureRoot });
      expect(envelope.isolated).toBeDefined();
      expect(envelope.isolated.enabled).toBe(true);
      expect(envelope.isolated.cache_dir).toBe('/tmp/my-cache');
    });

    it('parallel --isolated-no-lock --dry-run flips locked:false', () => {
      const fullArgs = ['--project-root', fixtureRoot,
        '--dry-run', '--json', '--isolated', '--isolated-no-lock'];
      const { envelope } = runSubcommand('parallel', fullArgs, { cwd: fixtureRoot });
      expect(envelope.isolated.locked).toBe(false);
    });
  });
});

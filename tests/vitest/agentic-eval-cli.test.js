// tests/vitest/agentic-eval-cli.test.js
// Unit tests for tools/agentic-eval/cli.mjs's pure helper functions (parseArgs, nullableMetric).
// Real subprocess end-to-end coverage (calibrate/smoke against fake claude) lives in
// agentic-eval-cli-integration.test.js -- this file is for fast, in-process logic that doesn't
// need a child process.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { parseArgs, validateSubcommandArgs, validatePrivatePatternsFileOrFail, resolveMeasurementScopeOrFail, resolveMaxBudgetUsdOrFail, nullableMetric, resolveHarnessProvenance, verifyExactCommandsSucceeded, writeRunRecordEvidence, buildRunRecord, finalizeAndWriteRecords, finalizeAndWriteMatrixRecords, findBlockingHarnessToolingDirty, isRunsRootDefault, cmdAggregate, validateRunRecordFile, SUBCOMMAND_SHAPES, discardJournalIfRedundant, buildStderrByRunId } from '../../tools/agentic-eval/cli.mjs';
import { computePolicySha256 } from '../../tools/agentic-eval/policy-config.mjs';
import { buildAcceptedRunAuditSidecar, finalizeAcceptedRunAuditSidecar, acceptedAuditRelativePathFor, crossValidateAcceptedRunAuditAgainstRecord } from '../../tools/agentic-eval/accepted-run-audit.mjs';
import { canonicalJsonSha256 as canonicalJsonSha256Local } from '../../tools/agentic-eval/canonical-json.mjs';
import { resolveSelection } from '../../tools/agentic-eval/registries.mjs';
import { TEST_RUN_RECORD_V6_INPUTS } from './_agentic-eval-run-record-fixtures.js';
import { withPartitionView } from '../../tools/agentic-eval/run-record-view.mjs';
import { LATEST_RUN_SCHEMA, validateRun, buildAggregateGroup } from '../../tools/agentic-eval/schemas.mjs';
import { GRADING_CHECK_NAMES } from '../../tools/agentic-eval/graders.mjs';
import { createInvocationJournal } from '../../tools/agentic-eval/durable-journal.mjs';
import { readRejectionStderrFile } from '../../tools/agentic-eval/rejection-diagnostics.mjs';
import { findAllToolUsesWithResults, classifyForeignSkillUses } from '../../tools/agentic-eval/stream-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('parseArgs', () => {
  it('parses a subcommand and its flags', () => {
    const args = parseArgs(['calibrate', '--model', 'claude-sonnet-5']);
    expect(args._).toEqual(['calibrate']);
    expect(args.model).toBe('claude-sonnet-5');
    expect(args.errors).toEqual([]);
  });

  it('--help/-h never require a value', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['--help']).errors).toEqual([]);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  // Regression coverage for a real silent-failure bug found by an independent review pass: a
  // trailing --private-patterns-file with nothing after it previously became
  // args['private-patterns-file'] === undefined, which `?? null` then silently treated as "flag
  // never provided" -- disabling private-pattern redaction and reporting the run as 'public'
  // with no error at all. A flag that's meant to protect private data must fail loudly when
  // misconfigured, not silently do nothing.
  it('a flag with nothing after it is an error, not a silent undefined', () => {
    const args = parseArgs(['calibrate', '--private-patterns-file']);
    expect(args.errors.length).toBeGreaterThan(0);
    expect(args.errors[0]).toContain('--private-patterns-file');
    expect(args['private-patterns-file']).toBeUndefined();
  });

  it('a flag immediately followed by another flag is an error -- the next flag is never consumed as a value', () => {
    const args = parseArgs(['calibrate', '--private-patterns-file', '--model', 'claude-sonnet-5']);
    expect(args.errors.length).toBeGreaterThan(0);
    expect(args.errors[0]).toContain('--private-patterns-file');
    // --model must still be parsed correctly -- the missing-value flag doesn't consume it.
    expect(args.model).toBe('claude-sonnet-5');
  });

  it('multiple missing-value flags are all reported, not just the first', () => {
    const args = parseArgs(['smoke', '--source-repo-dir', '--pinned-commit']);
    expect(args.errors.length).toBe(2);
  });

  it('a value that happens to look like a path is accepted normally', () => {
    const args = parseArgs(['calibrate', '--private-patterns-file', 'C:\\real\\path.json']);
    expect(args.errors).toEqual([]);
    expect(args['private-patterns-file']).toBe('C:\\real\\path.json');
  });

  // Regression coverage for a real silent-failure bug found by an independent review pass:
  // a duplicated flag previously silently kept only the LAST value (plain object-key
  // overwrite), which could mask a copy-paste mistake -- e.g. two --model values where the
  // first was intended to stick.
  it('a duplicated flag is an error, not silent last-wins', () => {
    const args = parseArgs(['calibrate', '--model', 'claude-sonnet-5', '--model', 'claude-opus-4-8']);
    expect(args.errors.length).toBeGreaterThan(0);
    expect(args.errors[0]).toContain('--model');
    expect(args.errors[0]).toContain('more than once');
  });

  it('positional arguments are collected into _', () => {
    const args = parseArgs(['corpus', 'validate']);
    expect(args._).toEqual(['corpus', 'validate']);
    expect(args.errors).toEqual([]);
  });

  // A bare --dry-run must never consume the next token as its value -- before BOOLEAN_FLAGS
  // existed, every --flag (other than --help/-h) required a following value, so a bare
  // `run --dry-run` would have recorded `--dry-run requires a value` as a hard parse error.
  it('a boolean flag (--dry-run) does not consume the next token as a value', () => {
    const args = parseArgs(['run', '--dry-run']);
    expect(args['dry-run']).toBe(true);
    expect(args.errors).toEqual([]);
  });

  it('a boolean flag immediately followed by another flag -- the next flag is parsed normally, not consumed', () => {
    const args = parseArgs(['run', '--dry-run', '--scenario', 'kampkit-android-host-test-discovery']);
    expect(args['dry-run']).toBe(true);
    expect(args.scenario).toBe('kampkit-android-host-test-discovery');
    expect(args.errors).toEqual([]);
  });

  it('a boolean flag works regardless of position among value-flags', () => {
    const args = parseArgs(['run', '--scenario', 'kampkit-no-applicable-tests', '--dry-run', '--repeats', '4']);
    expect(args['dry-run']).toBe(true);
    expect(args.scenario).toBe('kampkit-no-applicable-tests');
    expect(args.repeats).toBe('4');
    expect(args.errors).toEqual([]);
  });

  it('a duplicated boolean flag is still an error, not silently accepted twice', () => {
    const args = parseArgs(['run', '--dry-run', '--dry-run']);
    expect(args.errors.length).toBeGreaterThan(0);
    expect(args.errors[0]).toContain('--dry-run');
    expect(args.errors[0]).toContain('more than once');
  });

  it('omitting a boolean flag entirely leaves it unset, never defaulted to true', () => {
    const args = parseArgs(['run', '--scenario', 'kampkit-android-host-test-discovery']);
    expect(args['dry-run']).toBeUndefined();
  });
});

// Regression coverage for a real privacy bug found by an independent review pass:
// --private-pattern-file (missing the 's') previously parsed with ZERO errors from parseArgs
// alone (it's a well-formed --flag value pair, just an unrecognized NAME) and silently behaved
// as if --private-patterns-file had never been supplied at all -- cmdCalibrate/cmdSmoke only
// ever read the correctly-spelled key, so redaction was silently disabled and the run still
// reported privacy_status:'public' with no error anywhere. parseArgs alone can't catch this (it
// doesn't know which flag names are valid for which subcommand); validateSubcommandArgs closes
// the gap once the subcommand is known.
describe('validateSubcommandArgs', () => {
  it('accepts a well-formed calibrate invocation', () => {
    const args = parseArgs(['calibrate', '--model', 'claude-sonnet-5', '--private-patterns-file', 'x.json']);
    expect(validateSubcommandArgs('calibrate', args)).toEqual([]);
  });

  it('rejects the exact real-world typo: --private-pattern-file (missing the s)', () => {
    const args = parseArgs(['smoke', '--source-repo-dir', 'x', '--pinned-commit', 'y', '--private-pattern-file', 'secret.json']);
    const errors = validateSubcommandArgs('smoke', args);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('--private-pattern-file'))).toBe(true);
  });

  it('rejects an unrecognized flag for a subcommand that has flags of its own', () => {
    const args = parseArgs(['aggregate', '--runs-dir', 'x', '--bogus-flag', 'y']);
    const errors = validateSubcommandArgs('aggregate', args);
    expect(errors.some((e) => e.includes('--bogus-flag'))).toBe(true);
  });

  it('rejects a flag valid for ANOTHER subcommand but not this one', () => {
    const args = parseArgs(['validate', '--run', 'x.json', '--model', 'claude-sonnet-5']);
    const errors = validateSubcommandArgs('validate', args);
    expect(errors.some((e) => e.includes('--model'))).toBe(true);
  });

  it('rejects an unexpected extra positional argument', () => {
    const args = parseArgs(['calibrate', 'unexpected-extra']);
    const errors = validateSubcommandArgs('calibrate', args);
    expect(errors.some((e) => e.includes('extra argument'))).toBe(true);
  });

  it('accepts corpus validate\'s one expected extra positional', () => {
    const args = parseArgs(['corpus', 'validate']);
    expect(validateSubcommandArgs('corpus', args)).toEqual([]);
  });

  it('rejects corpus with a second extra positional beyond validate', () => {
    const args = parseArgs(['corpus', 'validate', 'unexpected']);
    const errors = validateSubcommandArgs('corpus', args);
    expect(errors.some((e) => e.includes('extra argument'))).toBe(true);
  });

  it('rejects an unknown subcommand', () => {
    expect(validateSubcommandArgs('bogus-subcommand', parseArgs(['bogus-subcommand']))).toEqual(
      expect.arrayContaining([expect.stringContaining('Unknown subcommand')]),
    );
  });

  it('SUBCOMMAND_SHAPES covers every real subcommand main() actually dispatches', () => {
    expect(Object.keys(SUBCOMMAND_SHAPES).sort()).toEqual([
      'aggregate',
      'analyze',
      'calibrate',
      'corpus',
      'product-access',
      'run',
      'scope',
      'smoke',
      'validate',
    ]);
  });

  // --measurement-scope-file: added to calibrate/smoke/run so an existing, sanity-checked
  // measurement can be reused across independent invocations (see resolveMeasurementScopeOrFail
  // below) -- accepting the new flag must never disturb any EXISTING flag's acceptance/rejection.
  it('accepts --measurement-scope-file for calibrate/smoke/run', () => {
    for (const sub of ['calibrate', 'smoke', 'run']) {
      expect(SUBCOMMAND_SHAPES[sub].flags).toContain('measurement-scope-file');
    }
    const args = parseArgs(['calibrate', '--measurement-scope-file', 'x.json']);
    expect(validateSubcommandArgs('calibrate', args)).toEqual([]);
  });

  it('an unrelated typo of the new flag is still rejected, exactly like every other flag', () => {
    const args = parseArgs(['calibrate', '--measurement-scope-fil', 'x.json']);
    const errors = validateSubcommandArgs('calibrate', args);
    expect(errors.some((e) => e.includes('--measurement-scope-fil'))).toBe(true);
  });

  it('duplicating --measurement-scope-file is still a hard parseArgs error', () => {
    const args = parseArgs(['calibrate', '--measurement-scope-file', 'a.json', '--measurement-scope-file', 'b.json']);
    expect(args.errors.some((e) => e.includes('--measurement-scope-file') && e.includes('more than once'))).toBe(true);
  });

  it('accepts scope init\'s one expected extra positional plus --out', () => {
    const args = parseArgs(['scope', 'init', '--out', 'x.json']);
    expect(validateSubcommandArgs('scope', args)).toEqual([]);
  });

  it('rejects scope with an unknown flag', () => {
    const args = parseArgs(['scope', 'init', '--out', 'x.json', '--bogus', 'y']);
    const errors = validateSubcommandArgs('scope', args);
    expect(errors.some((e) => e.includes('--bogus'))).toBe(true);
  });

  it('rejects scope with a second extra positional beyond init', () => {
    const args = parseArgs(['scope', 'init', 'unexpected']);
    const errors = validateSubcommandArgs('scope', args);
    expect(errors.some((e) => e.includes('extra argument'))).toBe(true);
  });

  // --runtime/--execution-profile (agentic-eval-runtime-neutral-records-v1): accepted for
  // calibrate/smoke/run (the three commands that can spend a live session), rejected everywhere
  // else -- exactly like --model's own existing scope.
  it('accepts --runtime and --execution-profile for calibrate/smoke/run', () => {
    for (const sub of ['calibrate', 'smoke', 'run']) {
      expect(SUBCOMMAND_SHAPES[sub].flags).toContain('runtime');
      expect(SUBCOMMAND_SHAPES[sub].flags).toContain('execution-profile');
    }
    const args = parseArgs(['calibrate', '--runtime', 'claude-code', '--execution-profile', 'strict-policy-v1']);
    expect(validateSubcommandArgs('calibrate', args)).toEqual([]);
  });

  // --isolation-attestation-file (PR 4, sandboxed-unrestricted-v1): accepted for calibrate/smoke/run
  // -- the three commands that resolve an execution profile and can spend a live session -- exactly
  // like --runtime/--execution-profile's own scope above. Whether the flag is REQUIRED/FORBIDDEN for
  // a given resolved profile is resolveIsolationAttestationOrFail's own concern (a semantic check),
  // never this shape-only allowlist's.
  it('accepts --isolation-attestation-file for calibrate/smoke/run', () => {
    for (const sub of ['calibrate', 'smoke', 'run']) {
      expect(SUBCOMMAND_SHAPES[sub].flags).toContain('isolation-attestation-file');
    }
    const args = parseArgs(['calibrate', '--isolation-attestation-file', 'attestation.json']);
    expect(validateSubcommandArgs('calibrate', args)).toEqual([]);
  });

  it('duplicating --isolation-attestation-file is still a hard parseArgs error', () => {
    const args = parseArgs(['calibrate', '--isolation-attestation-file', 'a.json', '--isolation-attestation-file', 'b.json']);
    expect(args.errors.some((e) => e.includes('--isolation-attestation-file') && e.includes('more than once'))).toBe(true);
  });

  it('rejects --isolation-attestation-file for subcommands that never spend a live session', () => {
    for (const sub of ['aggregate', 'analyze', 'validate', 'corpus', 'scope']) {
      expect(SUBCOMMAND_SHAPES[sub].flags).not.toContain('isolation-attestation-file');
    }
  });

  it('rejects --runtime for a subcommand that never spends a session', () => {
    const args = parseArgs(['validate', '--run', 'x.json', '--runtime', 'claude-code']);
    const errors = validateSubcommandArgs('validate', args);
    expect(errors.some((e) => e.includes('--runtime'))).toBe(true);
  });

  it('accepts --max-budget-usd only for commands that can spend live runtime sessions', () => {
    for (const sub of ['calibrate', 'smoke', 'run']) {
      expect(SUBCOMMAND_SHAPES[sub].flags).toContain('max-budget-usd');
    }
    for (const sub of ['aggregate', 'analyze', 'validate', 'corpus', 'scope']) {
      expect(SUBCOMMAND_SHAPES[sub].flags).not.toContain('max-budget-usd');
    }
    const args = parseArgs(['run', '--scenario', 'x', '--source-repo-dir', 'repo', '--seed', '1', '--max-budget-usd', '1.25']);
    expect(validateSubcommandArgs('run', args)).toEqual([]);
  });

  it('duplicating --max-budget-usd is still a hard parseArgs error', () => {
    const args = parseArgs(['run', '--max-budget-usd', '1', '--max-budget-usd', '2']);
    expect(args.errors.some((e) => e.includes('--max-budget-usd') && e.includes('more than once'))).toBe(true);
  });

  it('rejects --execution-profile for aggregate/analyze/validate/corpus/scope', () => {
    for (const [sub, extraArgs] of [
      ['aggregate', ['--runs-dir', 'x']], ['analyze', ['--runs-dir', 'x']], ['validate', ['--run', 'x.json']],
    ]) {
      const args = parseArgs([sub, ...extraArgs, '--execution-profile', 'strict-policy-v1']);
      const errors = validateSubcommandArgs(sub, args);
      expect(errors.some((e) => e.includes('--execution-profile'))).toBe(true);
    }
  });

  // --provider is deliberately never a recognized flag anywhere -- the plan reserves that term
  // for a future backend-model-service concept, never an alias for --runtime.
  it('--provider is unknown for every subcommand, including calibrate/smoke/run', () => {
    for (const [sub, extraArgs] of [
      ['calibrate', []], ['smoke', ['--source-repo-dir', 'x', '--pinned-commit', 'y']],
      ['run', ['--scenario', 'x', '--source-repo-dir', 'y', '--seed', '1']],
    ]) {
      const args = parseArgs([sub, ...extraArgs, '--provider', 'anthropic']);
      const errors = validateSubcommandArgs(sub, args);
      expect(errors.some((e) => e.includes('--provider'))).toBe(true);
    }
  });
});

describe('validatePrivatePatternsFileOrFail', () => {
  it('passes through cleanly when no file is supplied at all', () => {
    expect(validatePrivatePatternsFileOrFail(null)).toEqual({ ok: true });
  });

  it('accepts a real, valid patterns file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aec-patterns-'));
    try {
      const file = path.join(dir, 'patterns.json');
      writeFileSync(file, JSON.stringify([{ class: 'x', literal: 'secret', replacement: '<X>' }]));
      expect(validatePrivatePatternsFileOrFail(file)).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // This is the eager, fail-fast half of the fix: a missing/malformed patterns file is caught
  // here, BEFORE any Claude session runs -- not only later, inside finalizeAndWriteRecords(),
  // after both conditions have already completed (real API cost and time for a live re-run,
  // spent for nothing).
  it('fails closed on a nonexistent file, with a clear reason', () => {
    const result = validatePrivatePatternsFileOrFail(path.join(os.tmpdir(), 'aec-does-not-exist.json'));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('--private-patterns-file is invalid');
  });

  it('fails closed on malformed JSON', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aec-patterns-'));
    try {
      const file = path.join(dir, 'patterns.json');
      writeFileSync(file, 'not valid json');
      const result = validatePrivatePatternsFileOrFail(file);
      expect(result.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// resolveMeasurementScopeOrFail is the ONE abstraction cmdCalibrate/cmdSmoke/cmdRun each call
// (replacing the 3 direct generateAmbientProfileScope() calls) -- see measurement-scope.mjs's
// own test file for the underlying module's coverage; this covers the cli.mjs-level wrapper's
// own {ok,reason}/{ok,source,...} contract, mirroring validatePrivatePatternsFileOrFail's shape.
describe('resolveMeasurementScopeOrFail', () => {
  it('no path -> ephemeral, and two separate calls never produce the same scopeId/key', () => {
    const a = resolveMeasurementScopeOrFail(null);
    const b = resolveMeasurementScopeOrFail(null);
    expect(a.ok).toBe(true);
    expect(a.source).toBe('ephemeral');
    expect(a.scopeId).not.toBe(b.scopeId);
    expect(a.key.equals(b.key)).toBe(false);
  });

  it('the same supplied scope file loaded twice yields identical scopeId and key bytes', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aec-scope-'));
    try {
      const file = path.join(dir, 'scope.json');
      const first = resolveMeasurementScopeOrFail(file);
      // scope init doesn't exist as a bare function call here -- exercise the same file-creation
      // path cmdScopeInit uses, directly, so this test doesn't depend on cli.mjs wiring order.
      expect(first.ok).toBe(false); // file doesn't exist yet
      writeFileSync(file, JSON.stringify({
        schema: 1,
        scope_id: '11111111-1111-4111-8111-111111111111',
        hmac_key_base64: Buffer.alloc(32, 7).toString('base64'),
      }), { mode: 0o600 });
      const a = resolveMeasurementScopeOrFail(file);
      const b = resolveMeasurementScopeOrFail(file);
      expect(a.ok).toBe(true);
      expect(a.source).toBe('supplied');
      expect(a.scopeId).toBe('11111111-1111-4111-8111-111111111111');
      expect(a.scopeId).toBe(b.scopeId);
      expect(a.key.equals(b.key)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every malformed-file class fails closed with ok:false and a reason, never throwing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aec-scope-bad-'));
    try {
      expect(resolveMeasurementScopeOrFail(path.join(dir, 'missing.json')).ok).toBe(false);
      // mode:0o600 on both -- otherwise, on POSIX, loadMeasurementScopeFile's own mode
      // re-verification would reject these for the WRONG reason (permissions), masking whether
      // the JSON-parse and shape-validation layers below actually discriminate as claimed.
      const badJson = path.join(dir, 'bad.json');
      writeFileSync(badJson, 'not json', { mode: 0o600 });
      const badJsonResult = resolveMeasurementScopeOrFail(badJson);
      expect(badJsonResult.ok).toBe(false);
      expect(badJsonResult.reason).toMatch(/not valid JSON/);
      const badShape = path.join(dir, 'shape.json');
      writeFileSync(badShape, JSON.stringify({ schema: 1, scope_id: 'nope' }), { mode: 0o600 });
      const badShapeResult = resolveMeasurementScopeOrFail(badShape);
      expect(badShapeResult.ok).toBe(false);
      expect(badShapeResult.reason).toMatch(/invalid/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression coverage: an explicitly-supplied empty string is reachable via
  // `--measurement-scope-file ''` (parseArgs happily accepts an empty-but-present value -- see
  // the sibling parseArgs test below) and previously fell through the falsy check
  // (`!measurementScopeFile`) the same way an OMITTED flag (null) does, silently generating a
  // fresh ephemeral scope instead of failing closed on the caller's actual (invalid) input.
  it('an explicitly-supplied empty string is NOT treated as omitted -- fails closed, never silently ephemeral', () => {
    const result = resolveMeasurementScopeOrFail('');
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.source).toBeUndefined();
  });

  it('parseArgs does not strip an explicitly empty --measurement-scope-file value', () => {
    const args = parseArgs(['run', '--measurement-scope-file', '']);
    expect(args['measurement-scope-file']).toBe('');
    expect(args.errors).toEqual([]);
  });
});

describe('nullableMetric', () => {
  it('a non-null value always gets a null reason', () => {
    expect(nullableMetric(true)).toEqual({ value: true, reason: null });
    expect(nullableMetric(0)).toEqual({ value: 0, reason: null });
  });

  it('a null value requires a reason, defaulting to "not recorded"', () => {
    expect(nullableMetric(null)).toEqual({ value: null, reason: 'not recorded' });
    expect(nullableMetric(null, 'custom reason')).toEqual({ value: null, reason: 'custom reason' });
  });
});

// Regression coverage for a real "always null" bug found by an independent review pass:
// kmp_test_cli_version/kmp_test_cli_source_sha/resolved_kmp_test_executable_path were
// unconditionally null in every written run record, and repo_commit silently carried the PINNED
// SKILL snapshot's SHA instead of the harness's own actual commit. These assert against
// independently-derived real values (a second, direct `git rev-parse HEAD` / a direct
// package.json read), not just "is non-null" shape checks -- a shape-only check would still pass
// if resolveHarnessProvenance() returned the wrong (but non-null) SHA.
describe('resolveHarnessProvenance', () => {
  it('resolves the real repo HEAD commit -- not the pinned skill SHA, not null', () => {
    const expected = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim();
    const provenance = resolveHarnessProvenance({ fresh: true });
    expect(provenance.repoCommit).toBe(expected);
  });

  it('resolves the real package.json version -- not null', () => {
    const expected = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
    const provenance = resolveHarnessProvenance({ fresh: true });
    expect(provenance.cliVersion).toBe(expected);
  });

  it('resolves the real bin/kmp-test.js path -- not null', () => {
    const provenance = resolveHarnessProvenance({ fresh: true });
    expect(provenance.resolvedExecutablePath).toBe(path.join(REPO_ROOT, 'bin', 'kmp-test.js'));
  });

  it('caches across calls unless {fresh:true} forces re-resolution', () => {
    const first = resolveHarnessProvenance();
    const second = resolveHarnessProvenance();
    expect(second).toBe(first);
    const third = resolveHarnessProvenance({ fresh: true });
    expect(third).not.toBe(first);
    expect(third).toEqual(first);
  });
});

// Regression coverage for a real bypass an independent review pass demonstrated against the
// OLD regex-based design: unanchored regexes with no --json requirement let a bare
// `kmp-test doctor` (no --json at all, contradicting smoke's own prompt) or even an unrelated
// `kmp-test doctor-evil-subcommand` (the old `\bdoctor\b` pattern's word boundary matched a
// hyphen-adjacent suffix too) satisfy the gate. The current design tokenizes each command
// (quote-aware, via policy-hook.mjs's own tokenize()) and requires an EXACT token-array match
// against the expected multiset -- each expected command exactly once, no extras.
describe('verifyExactCommandsSucceeded', () => {
  const DOCTOR_DESCRIBE = [
    ['kmp-test', 'doctor', '--json'],
    ['kmp-test', 'describe', '--json'],
  ];

  it('passes when every expected command has a correlated, non-error result', () => {
    const bashResults = [
      { command: 'kmp-test doctor --json', resultFound: true, resultIsError: false },
      { command: 'kmp-test describe --json', resultFound: true, resultIsError: false },
    ];
    expect(verifyExactCommandsSucceeded(bashResults, DOCTOR_DESCRIBE)).toBe(true);
  });

  it('fails when a required command was never run at all', () => {
    const bashResults = [{ command: 'kmp-test doctor --json', resultFound: true, resultIsError: false }];
    expect(verifyExactCommandsSucceeded(bashResults, DOCTOR_DESCRIBE)).toBe(false);
  });

  it('fails when the matching command has no correlated tool_result', () => {
    const bashResults = [
      { command: 'kmp-test doctor --json', resultFound: false, resultIsError: null },
      { command: 'kmp-test describe --json', resultFound: true, resultIsError: false },
    ];
    expect(verifyExactCommandsSucceeded(bashResults, DOCTOR_DESCRIBE)).toBe(false);
  });

  it('fails when the matching command\'s own result was an error', () => {
    const bashResults = [
      { command: 'kmp-test doctor --json', resultFound: true, resultIsError: true },
      { command: 'kmp-test describe --json', resultFound: true, resultIsError: false },
    ];
    expect(verifyExactCommandsSucceeded(bashResults, DOCTOR_DESCRIBE)).toBe(false);
  });

  it('one command run twice does not satisfy two distinct expected commands', () => {
    const bashResults = [
      { command: 'kmp-test doctor --json', resultFound: true, resultIsError: false },
      { command: 'kmp-test doctor --json', resultFound: true, resultIsError: false },
    ];
    expect(verifyExactCommandsSucceeded(bashResults, DOCTOR_DESCRIBE)).toBe(false);
  });

  it('fails on an unrelated extra command alongside both expected ones -- no extras allowed', () => {
    const bashResults = [
      { command: 'kmp-test doctor --json', resultFound: true, resultIsError: false },
      { command: 'kmp-test describe --json', resultFound: true, resultIsError: false },
      { command: 'kmp-test doctor --help', resultFound: true, resultIsError: false },
    ];
    expect(verifyExactCommandsSucceeded(bashResults, DOCTOR_DESCRIBE)).toBe(false);
  });

  it('fails when --json is missing -- a bare "kmp-test doctor" does not satisfy "kmp-test doctor --json"', () => {
    const bashResults = [
      { command: 'kmp-test doctor', resultFound: true, resultIsError: false },
      { command: 'kmp-test describe --json', resultFound: true, resultIsError: false },
    ];
    expect(verifyExactCommandsSucceeded(bashResults, DOCTOR_DESCRIBE)).toBe(false);
  });

  it('fails on a similarly-named but different subcommand -- the old \\bdoctor\\b regex would have matched this', () => {
    const bashResults = [
      { command: 'kmp-test doctor-evil-subcommand --json', resultFound: true, resultIsError: false },
      { command: 'kmp-test describe --json', resultFound: true, resultIsError: false },
    ];
    expect(verifyExactCommandsSucceeded(bashResults, DOCTOR_DESCRIBE)).toBe(false);
  });

  it('fails when a command cannot even be tokenized (unterminated quote)', () => {
    const bashResults = [
      { command: 'kmp-test doctor "unterminated', resultFound: true, resultIsError: false },
      { command: 'kmp-test describe --json', resultFound: true, resultIsError: false },
    ];
    expect(verifyExactCommandsSucceeded(bashResults, DOCTOR_DESCRIBE)).toBe(false);
  });

  it('is order-independent -- describe then doctor still satisfies the same expected multiset', () => {
    const bashResults = [
      { command: 'kmp-test describe --json', resultFound: true, resultIsError: false },
      { command: 'kmp-test doctor --json', resultFound: true, resultIsError: false },
    ];
    expect(verifyExactCommandsSucceeded(bashResults, DOCTOR_DESCRIBE)).toBe(true);
  });
});

describe('resolveMaxBudgetUsdOrFail', () => {
  it('preserves the historical 0.60 default when the flag is omitted', () => {
    expect(resolveMaxBudgetUsdOrFail(null)).toEqual({ ok: true, maxBudgetUsd: 0.60, source: 'default' });
    expect(resolveMaxBudgetUsdOrFail(undefined)).toEqual({ ok: true, maxBudgetUsd: 0.60, source: 'default' });
  });

  it('accepts positive decimal and integer dollar values inside the reviewed cap', () => {
    expect(resolveMaxBudgetUsdOrFail('1.25')).toEqual({ ok: true, maxBudgetUsd: 1.25, source: 'supplied' });
    expect(resolveMaxBudgetUsdOrFail('5')).toEqual({ ok: true, maxBudgetUsd: 5, source: 'supplied' });
  });

  it('rejects zero, negatives, non-decimal notation, and values above the reviewed cap', () => {
    for (const value of ['0', '-1', '1e3', 'Infinity', 'NaN', '', '5.01']) {
      const result = resolveMaxBudgetUsdOrFail(value);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('--max-budget-usd');
    }
  });
});

// Regression coverage for a real partial-pair-on-disk bug found by an independent review pass:
// the original write-then-rename sequence had no rollback -- a renameSync failure on file 3 of
// 4 previously left files 1-2 committed as final evidence while 3-4 were missing. Uses the
// (test-only) runsRootOverride parameter so this never touches the real, shared tools/runs/
// tree -- every call here is pointed at an isolated, per-test temp directory.
describe('writeRunRecordEvidence', () => {
  function fixtureRecords() {
    return {
      recordA: { run_id: 'test-run-a-0001' },
      recordB: { run_id: 'test-run-b-0001' },
      rawTextA: '{"raw":"a"}\n',
      rawTextB: '{"raw":"b"}\n',
    };
  }

  it('writes all four files (two records, two raw transcripts) on a clean run', () => {
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aec-evidence-'));
    try {
      const { recordA, recordB, rawTextA, rawTextB } = fixtureRecords();
      const outDir = writeRunRecordEvidence('test-kind', recordA, recordB, rawTextA, rawTextB, '{"redacted":"a"}', '{"redacted":"b"}', runsRoot);
      expect(existsSync(path.join(outDir, 'test-run-a-0001.json'))).toBe(true);
      expect(existsSync(path.join(outDir, 'test-run-b-0001.json'))).toBe(true);
      expect(existsSync(path.join(outDir, 'raw', 'test-run-a-0001.jsonl'))).toBe(true);
      expect(existsSync(path.join(outDir, 'raw', 'test-run-b-0001.jsonl'))).toBe(true);
      expect(readFileSync(path.join(outDir, 'test-run-a-0001.json'), 'utf8')).toBe('{"redacted":"a"}');
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  it('rolls back already-renamed files when a later rename in the same call fails', () => {
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aec-evidence-'));
    try {
      const { recordA, recordB, rawTextA, rawTextB } = fixtureRecords();
      // Force the FOURTH target (raw/test-run-b-0001.jsonl) to fail its rename by pre-creating
      // that exact path as a DIRECTORY -- renameSync can never replace a directory with a file.
      // Targets 1-3 (record A, record B, raw A) rename successfully first, proving the rollback
      // really does undo already-committed work, not just abort before anything happened.
      const outDir = path.join(runsRoot, 'agentic-eval-test-kind');
      const rawDir = path.join(outDir, 'raw');
      mkdirSync(rawDir, { recursive: true });
      mkdirSync(path.join(rawDir, 'test-run-b-0001.jsonl'), { recursive: true });

      expect(() => writeRunRecordEvidence('test-kind', recordA, recordB, rawTextA, rawTextB, '{"redacted":"a"}', '{"redacted":"b"}', runsRoot))
        .toThrow();

      // The two record files and raw A -- all successfully renamed before the failure -- must
      // NOT survive as committed evidence. Only the directory we deliberately pre-created (never
      // touched by this call) remains.
      expect(existsSync(path.join(outDir, 'test-run-a-0001.json'))).toBe(false);
      expect(existsSync(path.join(outDir, 'test-run-b-0001.json'))).toBe(false);
      expect(existsSync(path.join(rawDir, 'test-run-a-0001.jsonl'))).toBe(false);
      // No leftover .tmp-* files either.
      expect(readdirSync(outDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
      expect(readdirSync(rawDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  // Regression coverage for a real data-loss risk an independent review pass found: run_id
  // embeds only an 8-hex-char slice of randomUUID() (~2^32 space, not the full 128 bits) -- a
  // collision isn't astronomically improbable across this harness's full lifetime of runs. On
  // POSIX, renameSync silently REPLACES an existing destination file; a collision on target 1
  // followed by a later rename failure on target 3 or 4 would previously have (a) silently
  // overwritten genuine prior evidence, then (b) the rollback would have deleted that overwritten
  // replacement too -- permanently losing the ORIGINAL evidence with no trace it ever existed.
  it('refuses before writing/renaming anything if any target already exists (run_id collision)', () => {
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aec-evidence-'));
    try {
      const { recordA, recordB, rawTextA, rawTextB } = fixtureRecords();
      const outDir = path.join(runsRoot, 'agentic-eval-test-kind');
      mkdirSync(outDir, { recursive: true });
      const preExistingPath = path.join(outDir, 'test-run-a-0001.json');
      writeFileSync(preExistingPath, '{"this":"is prior, real evidence -- must survive"}');

      expect(() => writeRunRecordEvidence('test-kind', recordA, recordB, rawTextA, rawTextB, '{"redacted":"a"}', '{"redacted":"b"}', runsRoot))
        .toThrow(/already exists/);

      // The pre-existing file must be completely untouched -- not overwritten, not renamed away.
      expect(readFileSync(preExistingPath, 'utf8')).toBe('{"this":"is prior, real evidence -- must survive"}');
      // Nothing else was created either -- the check runs for ALL targets before ANY write.
      expect(existsSync(path.join(outDir, 'test-run-b-0001.json'))).toBe(false);
      expect(existsSync(path.join(outDir, 'raw'))).toBe(false);
      expect(readdirSync(outDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  // Regression coverage for a real risk an independent review pass argued: documenting a
  // non-default KMP_EVAL_RUNS_ROOT in the run record's own errors[] (see the RUNS_ROOT_IS_DEFAULT
  // tests elsewhere) doesn't itself prevent an accidental `git add -A` from staging raw,
  // unredacted transcripts if the override happens to land INSIDE this repo's worktree at a
  // location .gitignore doesn't actually cover. This points runsRootOverride at a real,
  // uncommitted scratch directory inside the repo (verified via `git check-ignore` to NOT be
  // covered by any existing rule) and asserts the write refuses outright.
  it('refuses to write raw transcripts to a location inside the repo that .gitignore does not actually cover', () => {
    const insideRepoUnignored = path.join(REPO_ROOT, 'tools', `.tmp-test-gitignore-check-${process.pid}`);
    mkdirSync(insideRepoUnignored, { recursive: true });
    try {
      const { recordA, recordB, rawTextA, rawTextB } = fixtureRecords();
      expect(() => writeRunRecordEvidence('test-kind', recordA, recordB, rawTextA, rawTextB, '{"redacted":"a"}', '{"redacted":"b"}', insideRepoUnignored))
        .toThrow(/not covered by \.gitignore/);
      // Nothing was created at all -- the check runs before any directory or file is touched.
      expect(readdirSync(insideRepoUnignored)).toEqual([]);
    } finally {
      rmSync(insideRepoUnignored, { recursive: true, force: true });
    }
  });

  it('allows writing when runsRootOverride is entirely outside the repo worktree (the normal test-isolation case)', () => {
    const outsideRepo = mkdtempSync(path.join(os.tmpdir(), 'aec-evidence-outside-'));
    try {
      const { recordA, recordB, rawTextA, rawTextB } = fixtureRecords();
      const outDir = writeRunRecordEvidence('test-kind', recordA, recordB, rawTextA, rawTextB, '{"redacted":"a"}', '{"redacted":"b"}', outsideRepo);
      expect(existsSync(path.join(outDir, 'test-run-a-0001.json'))).toBe(true);
    } finally {
      rmSync(outsideRepo, { recursive: true, force: true });
    }
  });

  // Regression coverage for a real gap an independent review pass found: "outside THIS repo's
  // worktree" was treated as automatically safe, without checking whether the destination is
  // inside a DIFFERENT git repository entirely -- reproduced directly by pointing
  // KMP_EVAL_RUNS_ROOT at a fresh, unrelated git repository elsewhere, where `git status` showed
  // the raw directory as a real, trackable untracked path (`?? agentic-eval-.../`), meaning an
  // accidental `git add -A` in THAT repo would have staged it. Fixed by resolving the ACTUAL
  // containing repository via `git -C <path> rev-parse --show-toplevel` rather than assuming
  // REPO_ROOT is the only repository that could ever matter.
  it('refuses to write when runsRootOverride is inside a DIFFERENT git repository (not this one) and unignored there', () => {
    const otherRepo = mkdtempSync(path.join(os.tmpdir(), 'aec-other-repo-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: otherRepo, encoding: 'utf8' });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: otherRepo, encoding: 'utf8' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: otherRepo, encoding: 'utf8' });
      // Confirm the premise directly, matching Codex's own reproduction: this OTHER repo's git
      // status genuinely sees the target as a real, trackable path before the fix is even
      // exercised.
      const statusBefore = spawnSync('git', ['status', '--porcelain'], { cwd: otherRepo, encoding: 'utf8' });
      expect(statusBefore.status).toBe(0);

      const { recordA, recordB, rawTextA, rawTextB } = fixtureRecords();
      expect(() => writeRunRecordEvidence('test-kind', recordA, recordB, rawTextA, rawTextB, '{"redacted":"a"}', '{"redacted":"b"}', otherRepo))
        .toThrow(/not covered by \.gitignore/);
      expect(readdirSync(otherRepo).filter((f) => f !== '.git')).toEqual([]);

      const statusAfter = spawnSync('git', ['status', '--porcelain'], { cwd: otherRepo, encoding: 'utf8' });
      expect(statusAfter.stdout.trim()).toBe(''); // nothing was ever created to show up as untracked
    } finally {
      rmSync(otherRepo, { recursive: true, force: true });
    }
  });
});

// Regression coverage for a real fail-open gap an independent review pass demonstrated: an
// EARLIER version disclosed a dirty measured-code tree (bin/lib/scripts) via the run record's
// own errors[] array, but the hard gate still allowed evidence to be written regardless --
// meaning committable evidence could claim repo_commit described the exact code that ran when
// it demonstrably didn't. This constructs a real, schema-valid record pair (via the real
// buildRunRecord()) and injects the exact errors[] entry a genuinely dirty bin/lib/scripts tree
// would produce -- proving finalizeAndWriteRecords() itself refuses before ever reaching the
// hard gate, without needing to actually dirty this repo's own production code during a test.
describe('finalizeAndWriteRecords -- fails closed on a dirty measured-code tree', () => {
  // Matches the canonical minimal condition-observation-v1 shape (see e.g.
  // agentic-eval-graders.test.js's own baseObservation helper) -- buildRunRecord now reads
  // conditionResult.observation exclusively, never a raw provider event.
  function fakeObservation() {
    return {
      schema: 1,
      runtime: { id: 'claude-code', protocolVersion: 1 },
      process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 1000n },
      session: { initPresent: true, modelResolved: 'claude-sonnet-5-fake', sessionIdObserved: 'sess-1', runtimeVersion: 'fake', toolProfileMatchesExpected: true },
      transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
      terminal: { present: true, isError: false, turnCount: 1, finalText: 'irrelevant', resultSubtype: 'success', usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
      toolAttempts: [],
      skill: {
        available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
        targetInvocation: null, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
      },
      hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: true },
      byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
      timing: { receiptNsByEventIndex: new Map() },
    };
  }
  function fakeConditionResult() {
    return {
      observation: fakeObservation(),
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
    };
  }

  it('refuses to write evidence -- and never calls the hard gate at all -- when a record carries a dirty_measured_code error', async () => {
    const policySha256 = computePolicySha256();
    const common = { runKind: 'calibration', scenarioId: 'test-dirty-tree', daemonPolicy: 'disabled-via-gradle-user-home-properties', allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256, ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'), ...TEST_RUN_RECORD_V6_INPUTS };
    const recordA = buildRunRecord({ conditionResult: fakeConditionResult(), condition: 'no-skill', skillSourceSha: null, ...common });
    const recordB = buildRunRecord({ conditionResult: fakeConditionResult(), condition: 'current-skill', skillSourceSha: 'c5c0661852f7c9da145ef56892048e706216a6ce', ...common });
    // Simulate what resolveHarnessProvenance() would have populated for a genuinely dirty
    // bin/lib/scripts tree -- see cli.mjs's own buildRunRecord for the real construction.
    recordA.errors = [{ code: 'dirty_measured_code', message: 'bin/kmp-test.js has uncommitted local modifications' }];
    recordB.errors = [{ code: 'dirty_measured_code', message: 'bin/kmp-test.js has uncommitted local modifications' }];

    let hardGateCalled = false;
    const result = await finalizeAndWriteRecords({
      runKind: 'calibration', recordA, recordB,
      runA: { observation: fakeObservation() },
      runB: { observation: fakeObservation() },
      hardGateFn: () => { hardGateCalled = true; return { ok: true, reason: null }; },
      transcriptsByRunId: { [recordA.run_id]: '', [recordB.run_id]: '' },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unclean measured-code tree');
    expect(hardGateCalled).toBe(false);
  });

  // Revised for a real gap an independent review pass found: leaving dirty_harness_tooling purely
  // disclosure-only meant code that directly decides parsing/gates/metrics (this PR's own feature
  // work) could change what evidence actually captures while repo_commit still pointed at a clean
  // HEAD. Fixed: fail-closed, but ONLY when writing to the default RUNS_ROOT (RUNS_ROOT_IS_DEFAULT)
  // -- this test file never sets KMP_EVAL_RUNS_ROOT, so it naturally IS the default-root case, and
  // now correctly proves dirty_harness_tooling blocks the SAME way dirty_measured_code already
  // does. The hard gate stub still returns {ok:false} defensively (never {ok:true}) even though
  // this path is never expected to reach it -- consistent with this file's established
  // never-risk-a-real-write discipline.
  it('a dirty_harness_tooling error (tools/agentic-eval itself) DOES block before reaching the hard gate, when writing to the default RUNS_ROOT', async () => {
    const policySha256 = computePolicySha256();
    const common = { runKind: 'calibration', scenarioId: 'test-dirty-tooling', daemonPolicy: 'disabled-via-gradle-user-home-properties', allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256, ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'), ...TEST_RUN_RECORD_V6_INPUTS };
    const recordA = buildRunRecord({ conditionResult: fakeConditionResult(), condition: 'no-skill', skillSourceSha: null, ...common });
    const recordB = buildRunRecord({ conditionResult: fakeConditionResult(), condition: 'current-skill', skillSourceSha: 'c5c0661852f7c9da145ef56892048e706216a6ce', ...common });
    recordA.errors = [{ code: 'dirty_harness_tooling', message: 'tools/agentic-eval/cli.mjs has uncommitted local modifications' }];
    recordB.errors = [{ code: 'dirty_harness_tooling', message: 'tools/agentic-eval/cli.mjs has uncommitted local modifications' }];

    let hardGateCalled = false;
    const result = await finalizeAndWriteRecords({
      runKind: 'calibration', recordA, recordB,
      runA: { observation: fakeObservation() },
      runB: { observation: fakeObservation() },
      hardGateFn: () => { hardGateCalled = true; return { ok: false, reason: 'stubbed gate rejection -- test never intends to reach a real write' }; },
      transcriptsByRunId: { [recordA.run_id]: '', [recordB.run_id]: '' },
    });
    expect(hardGateCalled).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unclean harness-tooling tree');
  });
});

// Diseño 4d (macOS auth-preflight PR): exactly 4 real call sites build stderrByRunId and pass it
// to writeRejectionForensics -- pair fail-fast, pair complete (gate rejects), matrix fail-fast,
// matrix complete (gate rejects). Before this coverage, only the matrix-fail-fast producer (the
// one the original incident actually walked) had ANY end-to-end proof that a rejected cell's
// stderr survives past the eventual journal discard; the other 3 were wired identically but never
// independently exercised. Each test here drives the REAL finalizeAndWriteRecords/
// finalizeAndWriteMatrixRecords with a REAL journal, confirms the stderr the journal captured is
// independently recoverable from the rejection tier (raw/stderr/<rejection_id>/) via
// readRejectionStderrFile, and then runs it through the real discardJournalIfRedundant -- proving
// the journal itself is safely discarded (both stdout and stderr correspondence held) while the
// rejection-tier copy survives on its own, independent of the journal's lifecycle.
describe('finalizeAndWriteRecords / finalizeAndWriteMatrixRecords -- a rejected cell\'s stderr survives independently in the rejection tier, for all 4 rejection producers', () => {
  // Matches the canonical minimal condition-observation-v1 shape (see e.g.
  // agentic-eval-graders.test.js's own baseObservation helper) -- buildRunRecord/
  // finalizeAndWriteRecords/finalizeAndWriteMatrixRecords now read conditionResult.observation
  // exclusively, never a raw provider event. Raw transcript text no longer lives on
  // conditionResult at all (raw-custody rule) -- callers build transcriptsByRunId separately,
  // sourced from the same journal.persistSpawnOutcome() calls these tests already make.
  function fakeObservation(cellOrdinal) {
    return {
      schema: 1,
      runtime: { id: 'claude-code', protocolVersion: 1 },
      process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 1000n },
      session: { initPresent: true, modelResolved: 'claude-sonnet-5-fake', sessionIdObserved: `sess-${cellOrdinal}`, runtimeVersion: 'fake', toolProfileMatchesExpected: true },
      transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
      terminal: { present: true, isError: false, turnCount: 1, finalText: 'irrelevant', resultSubtype: 'success', usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
      toolAttempts: [],
      skill: {
        available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
        targetInvocation: null, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
      },
      hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: true },
      byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
      timing: { receiptNsByEventIndex: new Map() },
    };
  }
  function fakeConditionResult(cellOrdinal) {
    return {
      observation: fakeObservation(cellOrdinal),
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
      cellOrdinal,
    };
  }
  const MINIMAL_GRADE_RESULT = { expectedOutcomeMatched: false, success: false, checks: [], firstUsefulSignalEventIndex: null, testInvocationsTotal: 0, retries: 0 };
  function commonFields(runKind) {
    return {
      runKind, scenarioId: 'test-stderr-producer', daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000',
      ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      ...TEST_RUN_RECORD_V6_INPUTS,
      // run_kind:'scenario' schema-requires a real project_commit + integer seed (calibration/smoke
      // don't) -- buildRejectionDiagnostics' own committed-record validation refuses without them.
      ...(runKind === 'scenario' ? { seed: 42, projectCommit: 'a'.repeat(40) } : {}),
    };
  }
  function freshRunsRoot() {
    return mkdtempSync(path.join(os.tmpdir(), 'aec-stderr-producer-'));
  }
  function stderrFor(cellOrdinal) {
    return `stderr text for cellOrdinal ${cellOrdinal} -- distinctive sentinel, never shared across cells`;
  }
  function assertStderrSurvivedFor(result, journal, runsRoot, cellOrdinal, runId) {
    expect(result.stderrWriteError).toBeNull();
    expect(result.rejectionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(journal.readStderrFor(cellOrdinal)).toBe(stderrFor(cellOrdinal));
    expect(readRejectionStderrFile(result.rejectionId, cellOrdinal, runId, { runsRootOverride: runsRoot })).toBe(stderrFor(cellOrdinal));
  }

  it('producer 1/4 -- pair fail-fast (only B ran, A never spawned)', async () => {
    const runsRoot = freshRunsRoot();
    try {
      const common = commonFields('calibration');
      const conditionResultB = fakeConditionResult(0);
      const recordB = buildRunRecord({ conditionResult: conditionResultB, condition: 'current-skill', skillSourceSha: 'c5c0661852f7c9da145ef56892048e706216a6ce', ...common });
      const journal = createInvocationJournal({ runKind: 'calibration', plannedCellCount: 2, runsRootOverride: runsRoot });
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'raw-b', stderr: stderrFor(0) });

      const failFastStop = { reason: 'test fail-fast', failedChecks: ['cleanTranscriptOk'], unexpectedToolUsesCount: 0, unexpectedTools: [] };
      const result = await finalizeAndWriteRecords({
        runKind: 'calibration', recordA: null, recordB, runA: null, runB: conditionResultB,
        privatePatternsFile: null, hardGateFn: () => { throw new Error('must not be called on the fail-fast path'); },
        matrixComplete: false, plannedCellCount: 2, executedCellCount: 1, failFastStop,
        journal, runsRootOverride: runsRoot,
        transcriptsByRunId: { [recordB.run_id]: 'raw-b' },
      });
      expect(result.ok).toBe(false);
      assertStderrSurvivedFor(result, journal, runsRoot, 0, recordB.run_id);

      discardJournalIfRedundant(journal, result, { [recordB.run_id]: 0 }, runsRoot);
      expect(existsSync(journal.journalDir)).toBe(false);
      expect(readRejectionStderrFile(result.rejectionId, 0, recordB.run_id, { runsRootOverride: runsRoot })).toBe(stderrFor(0));
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  it('producer 2/4 -- pair complete (both A and B ran), hard gate rejects', async () => {
    const runsRoot = freshRunsRoot();
    try {
      const common = commonFields('calibration');
      const conditionResultA = fakeConditionResult(1);
      const conditionResultB = fakeConditionResult(0);
      const recordA = buildRunRecord({ conditionResult: conditionResultA, condition: 'no-skill', skillSourceSha: null, ...common });
      const recordB = buildRunRecord({ conditionResult: conditionResultB, condition: 'current-skill', skillSourceSha: 'c5c0661852f7c9da145ef56892048e706216a6ce', ...common });
      const journal = createInvocationJournal({ runKind: 'calibration', plannedCellCount: 2, runsRootOverride: runsRoot });
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'raw-b', stderr: stderrFor(0) });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'raw-a', stderr: stderrFor(1) });

      const gate = { ok: false, reason: 'test hard gate rejection', failedChecksA: [], failedChecksB: ['cleanTranscriptOk'], unexpectedToolUsesCountA: 0, unexpectedToolUsesCountB: 0, unexpectedToolsA: [], unexpectedToolsB: [] };
      const result = await finalizeAndWriteRecords({
        runKind: 'calibration', recordA, recordB, runA: conditionResultA, runB: conditionResultB,
        privatePatternsFile: null, hardGateFn: () => gate,
        journal, runsRootOverride: runsRoot,
        transcriptsByRunId: { [recordA.run_id]: 'raw-a', [recordB.run_id]: 'raw-b' },
      });
      expect(result.ok).toBe(false);
      assertStderrSurvivedFor(result, journal, runsRoot, 0, recordB.run_id);
      assertStderrSurvivedFor(result, journal, runsRoot, 1, recordA.run_id);

      // stderr text is persisted ONLY in its own dedicated raw/stderr/ file tier -- it must never
      // be embedded into the committed diagnostic JSON (which is neither gitignored the same way
      // nor schema-scoped for free text). Read the ACTUAL committed file back from disk, not just
      // trust that buildRejectionDiagnostics' own parameter list never received it.
      const committedDiagnosticPath = path.join(runsRoot, result.diagnosticsRelativePath);
      const committedDiagnosticText = readFileSync(committedDiagnosticPath, 'utf8');
      expect(committedDiagnosticText).not.toContain(stderrFor(0));
      expect(committedDiagnosticText).not.toContain(stderrFor(1));

      discardJournalIfRedundant(journal, result, { [recordB.run_id]: 0, [recordA.run_id]: 1 }, runsRoot);
      expect(existsSync(journal.journalDir)).toBe(false);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  it('producer 3/4 -- matrix fail-fast (records only cover the cells that actually executed)', async () => {
    const runsRoot = freshRunsRoot();
    try {
      const common = commonFields('scenario');
      const conditionResult0 = fakeConditionResult(0);
      const record0 = buildRunRecord({ conditionResult: conditionResult0, condition: 'current-skill', skillSourceSha: 'c5c0661852f7c9da145ef56892048e706216a6ce', repetitionIndex: 0, orderIndex: 0, gradeResult: MINIMAL_GRADE_RESULT, ...common });
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 4, runsRootOverride: runsRoot });
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'raw-0', stderr: stderrFor(0) });

      const localIntegrityByRunId = { [record0.run_id]: { failedChecks: ['cleanTranscriptOk'], unexpectedToolUsesCount: 0, unexpectedTools: [] } };
      const result = await finalizeAndWriteMatrixRecords({
        runKind: 'scenario', records: [record0], conditionResults: [conditionResult0],
        hardGateFn: () => { throw new Error('must not be called on the fail-fast path'); },
        privatePatternsFile: null, repeats: 2, matrixComplete: false,
        plannedCellCount: 4, executedCellCount: 1, localIntegrityByRunId,
        journal, runsRootOverride: runsRoot,
        transcriptsByRunId: { [record0.run_id]: 'raw-0' },
      });
      expect(result.ok).toBe(false);
      assertStderrSurvivedFor(result, journal, runsRoot, 0, record0.run_id);

      discardJournalIfRedundant(journal, result, { [record0.run_id]: 0 }, runsRoot);
      expect(existsSync(journal.journalDir)).toBe(false);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  it('producer 4/4 -- matrix complete (all planned cells ran), hard gate rejects', async () => {
    const runsRoot = freshRunsRoot();
    try {
      const common = commonFields('scenario');
      const conditionResult0 = fakeConditionResult(0);
      const conditionResult1 = fakeConditionResult(1);
      const record0 = buildRunRecord({ conditionResult: conditionResult0, condition: 'current-skill', skillSourceSha: 'c5c0661852f7c9da145ef56892048e706216a6ce', repetitionIndex: 0, orderIndex: 0, gradeResult: MINIMAL_GRADE_RESULT, ...common });
      const record1 = buildRunRecord({ conditionResult: conditionResult1, condition: 'no-skill', skillSourceSha: null, repetitionIndex: 0, orderIndex: 1, gradeResult: MINIMAL_GRADE_RESULT, ...common });
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 2, runsRootOverride: runsRoot });
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'raw-0', stderr: stderrFor(0) });
      journal.persistSpawnOutcome(1, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'raw-1', stderr: stderrFor(1) });

      const gate = {
        ok: false, reason: 'test whole-matrix hard gate rejection', ambientProfileMatrixOk: true,
        cellResults: [
          { runId: record0.run_id, failedChecks: ['cleanTranscriptOk'], unexpectedToolUsesCount: 0, unexpectedTools: [] },
          { runId: record1.run_id, failedChecks: [], unexpectedToolUsesCount: 0, unexpectedTools: [] },
        ],
      };
      const result = await finalizeAndWriteMatrixRecords({
        runKind: 'scenario', records: [record0, record1], conditionResults: [conditionResult0, conditionResult1],
        hardGateFn: () => gate, privatePatternsFile: null, repeats: 1,
        journal, runsRootOverride: runsRoot,
        transcriptsByRunId: { [record0.run_id]: 'raw-0', [record1.run_id]: 'raw-1' },
      });
      expect(result.ok).toBe(false);
      assertStderrSurvivedFor(result, journal, runsRoot, 0, record0.run_id);
      assertStderrSurvivedFor(result, journal, runsRoot, 1, record1.run_id);

      discardJournalIfRedundant(journal, result, { [record0.run_id]: 0, [record1.run_id]: 1 }, runsRoot);
      expect(existsSync(journal.journalDir)).toBe(false);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  it('a journal-absent caller (journal:null, matching every test that predates this fix) skips the stderr transaction cleanly -- stderrCount:0, stderrWriteError:null, never a throw', async () => {
    const runsRoot = freshRunsRoot();
    try {
      const common = commonFields('calibration');
      const conditionResultB = fakeConditionResult(0);
      const recordB = buildRunRecord({ conditionResult: conditionResultB, condition: 'current-skill', skillSourceSha: 'c5c0661852f7c9da145ef56892048e706216a6ce', ...common });
      const failFastStop = { reason: 'test fail-fast', failedChecks: ['cleanTranscriptOk'], unexpectedToolUsesCount: 0, unexpectedTools: [] };
      const result = await finalizeAndWriteRecords({
        runKind: 'calibration', recordA: null, recordB, runA: null, runB: conditionResultB,
        privatePatternsFile: null, hardGateFn: () => { throw new Error('must not be called on the fail-fast path'); },
        matrixComplete: false, plannedCellCount: 2, executedCellCount: 1, failFastStop,
        runsRootOverride: runsRoot,
        transcriptsByRunId: { [recordB.run_id]: 'raw-b' },
        // journal intentionally omitted -- defaults to null
      });
      expect(result.ok).toBe(false);
      expect(result.stderrWriteError).toBeNull();
      expect(result.stderrCount).toBe(0);
      expect(result.stderrManifest).toBeNull();
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  // The buildStderrByRunId-focused describe block further down proves that helper's own contract
  // in isolation; these 2 tests prove the SAME failure mode survives the real producer wiring end
  // to end -- a real journal (Transaction 1/2 inputs genuinely intact), with readStderrFor
  // specifically forced to fail, driven through a real finalize call.
  it('a real journal.readStderrFor() failure during a real producer call surfaces stderrWriteError:"stderr_read_failed" through finalizeAndWriteRecords -- Transactions 1+2 (raw transcripts, diagnostics) still succeed, matching a genuine write failure\'s own contract', async () => {
    const runsRoot = freshRunsRoot();
    try {
      const common = commonFields('calibration');
      const conditionResultB = fakeConditionResult(0);
      const recordB = buildRunRecord({ conditionResult: conditionResultB, condition: 'current-skill', skillSourceSha: 'c5c0661852f7c9da145ef56892048e706216a6ce', ...common });
      const journal = createInvocationJournal({ runKind: 'calibration', plannedCellCount: 2, runsRootOverride: runsRoot });
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'raw-b', stderr: stderrFor(0) });
      // A real journal, every OTHER method unchanged, with readStderrFor specifically forced to
      // fail -- simulates a real fs race (EACCES/EBUSY) between the successful write above and
      // this read, without needing to actually break the filesystem.
      const journalWithBrokenStderrRead = {
        ...journal,
        readStderrFor: () => { throw new Error('simulated fs race: EBUSY, resource busy or locked'); },
      };

      const failFastStop = { reason: 'test fail-fast', failedChecks: ['cleanTranscriptOk'], unexpectedToolUsesCount: 0, unexpectedTools: [] };
      const result = await finalizeAndWriteRecords({
        runKind: 'calibration', recordA: null, recordB, runA: null, runB: conditionResultB,
        privatePatternsFile: null, hardGateFn: () => { throw new Error('must not be called on the fail-fast path'); },
        matrixComplete: false, plannedCellCount: 2, executedCellCount: 1, failFastStop,
        journal: journalWithBrokenStderrRead, runsRootOverride: runsRoot,
        transcriptsByRunId: { [recordB.run_id]: 'raw-b' },
      });

      expect(result.ok).toBe(false);
      // The stderr tier reports the real, distinguishable failure -- never silence, never
      // conflated with "no journal at all", and never the raw err.message.
      expect(result.stderrWriteError).toBe('stderr_read_failed');
      expect(result.stderrCount).toBe(0);
      expect(result.stderrManifest).toBeNull();
      expect(JSON.stringify(result)).not.toContain('EBUSY');
      expect(JSON.stringify(result)).not.toContain('resource busy');

      // Transactions 1+2 are UNAFFECTED -- the read failure never blocks the other 2 independent
      // transactions.
      expect(result.rawTranscriptsPersisted).toBe(true);
      expect(result.rejectionId).not.toBeNull();
      const committedDiagnosticPath = path.join(runsRoot, result.diagnosticsRelativePath);
      expect(existsSync(committedDiagnosticPath)).toBe(true);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  it('a real journal.readStderrFor() failure during a real producer call surfaces the same closed code through finalizeAndWriteMatrixRecords (the matrix-path sibling)', async () => {
    const runsRoot = freshRunsRoot();
    try {
      const common = commonFields('scenario');
      const conditionResult0 = fakeConditionResult(0);
      const record0 = buildRunRecord({ conditionResult: conditionResult0, condition: 'current-skill', skillSourceSha: 'c5c0661852f7c9da145ef56892048e706216a6ce', repetitionIndex: 0, orderIndex: 0, gradeResult: MINIMAL_GRADE_RESULT, ...common });
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 4, runsRootOverride: runsRoot });
      journal.persistSpawnOutcome(0, { didSpawn: true, spawnStartedAt: Date.now(), rawStdout: 'raw-0', stderr: stderrFor(0) });
      const journalWithBrokenStderrRead = {
        ...journal,
        readStderrFor: () => { throw new Error('simulated fs race: EBUSY, resource busy or locked'); },
      };

      const localIntegrityByRunId = { [record0.run_id]: { failedChecks: ['cleanTranscriptOk'], unexpectedToolUsesCount: 0, unexpectedTools: [] } };
      const result = await finalizeAndWriteMatrixRecords({
        runKind: 'scenario', records: [record0], conditionResults: [conditionResult0],
        hardGateFn: () => { throw new Error('must not be called on the fail-fast path'); },
        privatePatternsFile: null, repeats: 2, matrixComplete: false,
        plannedCellCount: 4, executedCellCount: 1, localIntegrityByRunId,
        journal: journalWithBrokenStderrRead, runsRootOverride: runsRoot,
        transcriptsByRunId: { [record0.run_id]: 'raw-0' },
      });

      expect(result.ok).toBe(false);
      expect(result.stderrWriteError).toBe('stderr_read_failed');
      expect(result.stderrCount).toBe(0);
      expect(JSON.stringify(result)).not.toContain('EBUSY');
      expect(result.rawTranscriptsPersisted).toBe(true);
      expect(result.rejectionId).not.toBeNull();
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });
});

// Post-adversarial-review fix (round 1): journal.readStderrFor() is real filesystem I/O (unlike
// every other *ByRunId map finalizeAndWriteRecords/finalizeAndWriteMatrixRecords build, which are
// pure in-memory), and was the only one of the 4 stderrByRunId construction call sites NOT
// wrapped in its own try/catch. A real fs race (EACCES/EBUSY on Windows) or a stale ordinal
// reaching readStderrFor's own assertOrdinal would otherwise let an uncaught exception escape all
// the way out of the finalize function, silently skipping Transactions 1 and 2 (raw transcripts,
// structured diagnostics) as collateral damage -- degrading a well-handled gate rejection into a
// far-less-informative generic incident.
//
// Post-adversarial-review fix (round 2): the FIRST fix's own null-fallback silently collapsed TWO
// distinct states into the same value -- "no journal at all" (a legitimate, expected silence; the
// transaction genuinely does not apply) and "journal present but the read itself failed" (a REAL
// failure that must be reported, exactly like a write failure already is). An operator watching
// the terminal could not tell these apart; the second case produced total, unexplained silence on
// the stderr tier. buildStderrByRunId now returns a `{stderrByRunId, stderrReadError}` pair so the
// caller (writeRejectionForensics) can surface a closed `stderr_read_failed` code through the SAME
// `stderrWriteError` field/reporting channel a write failure already uses. buildStderrByRunId is
// exported solely for direct testability (same established convention as
// adoptJournalRaw/discardJournalIfRedundant).
describe('buildStderrByRunId -- never lets a journal.readStderrFor() throw escape, AND never conflates "no journal" with "journal present but the read failed"', () => {
  it('returns {stderrByRunId: null, stderrReadError: null} when journal is absent -- no failure to report, the transaction genuinely does not apply', () => {
    expect(buildStderrByRunId(null, { 'run-a': 0 })).toEqual({ stderrByRunId: null, stderrReadError: null });
  });

  it('returns the constructed {run_id: stderr} map, with stderrReadError:null, when every read succeeds', () => {
    const fakeJournal = { readStderrFor: (ordinal) => `stderr-for-ordinal-${ordinal}` };
    expect(buildStderrByRunId(fakeJournal, { 'run-a': 0, 'run-b': 1 })).toEqual({
      stderrByRunId: { 'run-a': 'stderr-for-ordinal-0', 'run-b': 'stderr-for-ordinal-1' },
      stderrReadError: null,
    });
  });

  it('returns {stderrByRunId: null, stderrReadError: "stderr_read_failed"} (never throws) when readStderrFor throws for ANY one cell -- a real failure, distinguishable from "no journal"', () => {
    const fakeJournal = {
      readStderrFor: (ordinal) => {
        if (ordinal === 1) throw new Error('simulated fs race: EBUSY, resource busy or locked');
        return `stderr-for-ordinal-${ordinal}`;
      },
    };
    expect(() => buildStderrByRunId(fakeJournal, { 'run-a': 0, 'run-b': 1 })).not.toThrow();
    expect(buildStderrByRunId(fakeJournal, { 'run-a': 0, 'run-b': 1 })).toEqual({
      stderrByRunId: null, stderrReadError: 'stderr_read_failed',
    });
  });
});

// Direct unit coverage for findBlockingHarnessToolingDirty() -- extracted specifically so BOTH
// branches of "fail-closed only when writing to the default RUNS_ROOT" can be tested directly.
// RUNS_ROOT_IS_DEFAULT is a module-level const fixed at first import, so a real in-process test
// (like the one above) can only ever observe ONE of its two values within a single vitest
// process -- this is the only way to exercise the OTHER branch (isolated/non-default root)
// without a real subprocess.
// Regression coverage for a real bypass an independent review pass reproduced concretely: a
// path-equivalent-but-textually-different KMP_EVAL_RUNS_ROOT (a relative path, one with a
// trailing separator, a different Windows casing) physically points at the exact same official
// tools/runs/ directory, but a bare string-equality comparison classified it as "not default" --
// silently bypassing BOTH the dirty_harness_tooling fail-closed gate (which exists specifically to
// protect that official location) and the raw_capture_location honesty check, while still
// physically writing evidence there. isRunsRootDefault() is realpath-based specifically so all of
// these variants resolve to the same canonical comparison.
describe('isRunsRootDefault', () => {
  const defaultPath = path.join(REPO_ROOT, 'tools', 'runs');

  it('recognizes the literal default path as default', () => {
    expect(isRunsRootDefault(defaultPath, REPO_ROOT)).toBe(true);
  });

  it('recognizes a default path with a trailing separator as default (not textually equal, but physically identical)', () => {
    expect(isRunsRootDefault(defaultPath + path.sep, REPO_ROOT)).toBe(true);
  });

  it('recognizes a dot-segment path that resolves to the same physical directory as default', () => {
    // Built via raw string concatenation, deliberately NOT path.join() -- path.join() normalizes
    // ".." segments away eagerly at construction time, which would silently defeat the entire
    // point of this test (proving isRunsRootDefault() itself, via realpath, does the equivalent
    // normalization -- not that the test's own input happened to already be pre-normalized).
    const equivalent = defaultPath + path.sep + '..' + path.sep + 'runs';
    expect(equivalent).not.toBe(defaultPath); // textually different, the whole point of this test
    expect(isRunsRootDefault(equivalent, REPO_ROOT)).toBe(true);
  });

  if (process.platform === 'win32') {
    it('recognizes a differently-cased default path as default on Windows (case-insensitive, case-preserving filesystem)', () => {
      const uppercased = path.join(REPO_ROOT, 'TOOLS', 'RUNS');
      expect(isRunsRootDefault(uppercased, REPO_ROOT)).toBe(true);
    });
  }

  it('does NOT classify a genuinely different, real directory as default', () => {
    const outsideRepo = mkdtempSync(path.join(os.tmpdir(), 'aec-isrunsroot-'));
    try {
      expect(isRunsRootDefault(outsideRepo, REPO_ROOT)).toBe(false);
    } finally {
      rmSync(outsideRepo, { recursive: true, force: true });
    }
  });

  it('fails closed (treats as default) when the candidate path does not exist yet, rather than assuming it is safely non-default', () => {
    const doesNotExist = path.join(os.tmpdir(), 'aec-isrunsroot-definitely-does-not-exist-marker');
    expect(existsSync(doesNotExist)).toBe(false);
    expect(isRunsRootDefault(doesNotExist, REPO_ROOT)).toBe(true);
  });
});

describe('findBlockingHarnessToolingDirty', () => {
  it('returns undefined (never blocks) when runsRootIsDefault is false, even with a real dirty_harness_tooling error present', () => {
    const record = { errors: [{ code: 'dirty_harness_tooling', message: 'tools/agentic-eval/cli.mjs has uncommitted local modifications' }] };
    expect(findBlockingHarnessToolingDirty(record, false)).toBeUndefined();
  });

  it('returns the dirty error entry when runsRootIsDefault is true', () => {
    const dirty = { code: 'dirty_harness_tooling', message: 'tools/agentic-eval/cli.mjs has uncommitted local modifications' };
    const record = { errors: [dirty] };
    expect(findBlockingHarnessToolingDirty(record, true)).toBe(dirty);
  });

  it('returns undefined when runsRootIsDefault is true but there is no dirty_harness_tooling error', () => {
    const record = { errors: [{ code: 'dirty_measured_code', message: 'unrelated' }] };
    expect(findBlockingHarnessToolingDirty(record, true)).toBeUndefined();
  });
});

// Regression coverage for a real gap an independent review pass found: raw_capture_location was a
// hardcoded 'tools/runs/...' literal even when KMP_EVAL_RUNS_ROOT overrides where the raw
// transcript actually lands (as it always does under the subprocess integration tests -- see
// agentic-eval-cli-integration.test.js's identical-purpose regression tests for the override
// case). This file never sets KMP_EVAL_RUNS_ROOT, so buildRunRecord() here exercises the DEFAULT
// root -- the one case the original literal string was actually correct for.
describe('buildRunRecord -- raw_capture_location under the default (non-overridden) RUNS_ROOT', () => {
  it('reports the real tools/runs/ path and raises no override error, since this process never set KMP_EVAL_RUNS_ROOT', () => {
    const conditionResult = {
      observation: {
        schema: 1,
        runtime: { id: 'claude-code', protocolVersion: 1 },
        process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 1000n },
        session: { initPresent: true, modelResolved: 'claude-sonnet-5-fake', sessionIdObserved: 'sess-1', runtimeVersion: 'fake', toolProfileMatchesExpected: true },
        transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
        terminal: { present: true, isError: false, turnCount: 1, finalText: 'irrelevant', resultSubtype: 'success', usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
        toolAttempts: [],
        skill: {
          available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
          targetInvocation: null, foreignInvocations: [],
          ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        },
        hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: true },
        byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
        timing: { receiptNsByEventIndex: new Map() },
      },
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
    };
    const record = buildRunRecord({
      conditionResult, condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-default-root',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    expect(record.raw_capture_location).toBe('tools/runs/agentic-eval-calibration/raw/');
    expect(record.errors.some((e) => e.code === 'raw_capture_location_overridden')).toBe(false);
  });
});

// Regression coverage for a real gap PR #373 found and hand-corrected only in its 4 committed
// evidence records, not in the generator itself: retries was hardcoded to nullableMetric(0) with
// no retry-detection logic behind it anywhere in this file, silently claiming a measured value of
// zero rather than disclosing that retries simply aren't tracked -- exactly the shape
// test_invocations_total already uses one field above. Fixed at the generator, not just the 4
// already-committed records (which PR #373 already corrected and which stay untouched).
describe('buildRunRecord -- retries reflects "not tracked", never a hardcoded zero', () => {
  function fakeConditionResult() {
    return {
      observation: {
        schema: 1,
        runtime: { id: 'claude-code', protocolVersion: 1 },
        process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 1000n },
        session: { initPresent: true, modelResolved: 'claude-sonnet-5-fake', sessionIdObserved: 'sess-1', runtimeVersion: 'fake', toolProfileMatchesExpected: true },
        transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
        terminal: { present: true, isError: false, turnCount: 1, finalText: 'irrelevant', resultSubtype: 'success', usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
        toolAttempts: [],
        skill: {
          available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
          targetInvocation: null, foreignInvocations: [],
          ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        },
        hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: true },
        byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
        timing: { receiptNsByEventIndex: new Map() },
      },
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
    };
  }

  it('reports retries as null with a runKind-specific reason for a calibration run', () => {
    const record = buildRunRecord({
      conditionResult: fakeConditionResult(), condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-retries-calibration',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    expect(record.retries).toEqual({ value: null, reason: 'not tracked for calibration runs' });
  });

  it('reports retries as null with a runKind-specific reason for a smoke run', () => {
    const record = buildRunRecord({
      conditionResult: fakeConditionResult(), condition: 'no-skill', runKind: 'smoke', scenarioId: 'test-retries-smoke',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    expect(record.retries).toEqual({ value: null, reason: 'not tracked for smoke runs' });
  });
});

// PR 4 (agentic-eval-isolated-unrestricted-profile-v1): buildRunRecord's own schema6 no-policy
// branch. selection comes from the REAL, public resolveSelection() seam (never a hand-typed
// registry entry -- see _agentic-eval-run-record-fixtures.js's own identical rationale), so this
// suite can never silently drift from what the registry actually contains.
describe('buildRunRecord -- policy_mode:not_applicable (sandboxed-unrestricted-v1) emits exact nulls, never fabricated zeros/empty arrays/allow (PR 4)', () => {
  function fakeConditionResult(overrides = {}) {
    return {
      observation: {
        schema: 1,
        runtime: { id: 'claude-code', protocolVersion: 1 },
        process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 1000n },
        session: { initPresent: true, modelResolved: 'claude-sonnet-5-fake', sessionIdObserved: 'sess-1', runtimeVersion: 'fake', toolProfileMatchesExpected: true },
        transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
        terminal: { present: true, isError: false, turnCount: 1, finalText: 'irrelevant', resultSubtype: 'success', usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
        toolAttempts: [],
        skill: {
          available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
          targetInvocation: null, foreignInvocations: [],
          ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        },
        hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: true },
        byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
        timing: { receiptNsByEventIndex: new Map() },
      },
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
      ...overrides,
    };
  }

  function unrestrictedSelection() {
    const result = resolveSelection({ executionProfileId: 'sandboxed-unrestricted-v1' });
    if (!result.ok) throw new Error(`test setup: resolveSelection(sandboxed-unrestricted-v1) failed: ${result.reason}`);
    return result.selection;
  }

  const FAKE_ATTESTATION_SHA256 = 'e'.repeat(64);

  function unrestrictedRunRecord(overrides = {}) {
    const selection = unrestrictedSelection();
    return buildRunRecord({
      conditionResult: fakeConditionResult(), condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-not-applicable-policy',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: ['build'], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      modelRequested: selection.model.model_id,
      selection, promptArtifact: TEST_RUN_RECORD_V6_INPUTS.promptArtifact, skillSnapshotArtifact: TEST_RUN_RECORD_V6_INPUTS.skillSnapshotArtifact,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      isolationAttestationSha256: FAKE_ATTESTATION_SHA256,
      ...overrides,
    });
  }

  it('execution_profile carries the real attestation hash, isolation_attestation_required:true, policy_mode:not_applicable', () => {
    const record = unrestrictedRunRecord();
    expect(record.execution_profile.isolation_attestation_sha256).toBe(FAKE_ATTESTATION_SHA256);
    expect(record.execution_profile.isolation_attestation_required).toBe(true);
    expect(record.execution_profile.policy_mode).toBe('not_applicable');
    expect(record.execution_profile.id).toBe('sandboxed-unrestricted-v1');
  });

  it('permission_mode_used is exactly bypassPermissions', () => {
    expect(unrestrictedRunRecord().permission_mode_used).toBe('bypassPermissions');
  });

  it('policy_allowed_gradle_tasks/policy_allowed_kmptest_subcommands are exactly null -- never the real arrays, never empty arrays', () => {
    const record = unrestrictedRunRecord();
    expect(record.policy_allowed_gradle_tasks).toBeNull();
    expect(record.policy_allowed_kmptest_subcommands).toBeNull();
  });

  it('policy_sha256 is exactly null -- never the real policy-hook.mjs hash', () => {
    expect(unrestrictedRunRecord().policy_sha256).toBeNull();
  });

  it('hook_call_count/hook_deny_count are exactly null -- never 0, even though the fake observation genuinely has zero hook events', () => {
    const record = unrestrictedRunRecord();
    expect(record.hook_call_count).toBeNull();
    expect(record.hook_deny_count).toBeNull();
  });

  it('policy_denials_before_first_signal/after_first_signal are null with reason "execution-profile-policy-not-applicable", for a non-scenario run', () => {
    const record = unrestrictedRunRecord();
    expect(record.policy_denials_before_first_signal).toEqual({ value: null, reason: 'execution-profile-policy-not-applicable' });
    expect(record.policy_denials_after_first_signal).toEqual({ value: null, reason: 'execution-profile-policy-not-applicable' });
  });

  it('post_signal_ms/post_signal_tool_calls use the ORDINARY runKind-based reason, never the policy-not-applicable one -- their own condition is independent of policy_mode', () => {
    const record = unrestrictedRunRecord();
    expect(record.post_signal_ms).toEqual({ value: null, reason: 'calibration run -- no scenario grader applies' });
    expect(record.post_signal_tool_calls).toEqual({ value: null, reason: 'calibration run -- no scenario grader applies' });
  });

  it('policy_denials_before/after_first_signal use the not-applicable reason even for a scenario run with NO signal boundary -- takes priority over the ordinary no-boundary reason; post_signal_ms stays on the ordinary no-boundary reason', () => {
    const gradeResult = {
      expectedOutcomeMatched: true, success: true, checks: [], firstUsefulSignalEventIndex: null,
      testInvocationsTotal: 1, retries: 0,
      harnessEvidenceAmbiguous: false, parallelEvidenceMalformed: false, changedEvidenceMalformed: false, gradleJunitEvidenceUnreliable: false,
    };
    const record = unrestrictedRunRecord({ runKind: 'scenario', gradeResult, seed: 1, orderIndex: 0, repetitionIndex: 0 });
    expect(record.policy_denials_before_first_signal).toEqual({ value: null, reason: 'execution-profile-policy-not-applicable' });
    expect(record.policy_denials_after_first_signal).toEqual({ value: null, reason: 'execution-profile-policy-not-applicable' });
    expect(record.post_signal_ms.reason).toBe('no first useful signal boundary');
  });

  it('the resulting record validates clean against schemas.mjs\'s own validateRun', () => {
    const record = unrestrictedRunRecord();
    expect(validateRun(record).errors).toEqual([]);
  });

  it('throws if isolationAttestationSha256 is omitted/null for a policy_mode:not_applicable selection', () => {
    expect(() => unrestrictedRunRecord({ isolationAttestationSha256: null })).toThrow();
  });

  it('throws if isolationAttestationSha256 is malformed (not 64-hex) for a policy_mode:not_applicable selection', () => {
    expect(() => unrestrictedRunRecord({ isolationAttestationSha256: 'not-a-hash' })).toThrow();
  });

  it('strict (policy_mode:required) rejects a non-null isolationAttestationSha256 -- never silently accepted', () => {
    expect(() => buildRunRecord({
      conditionResult: fakeConditionResult(), condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-strict-rejects-attestation',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      isolationAttestationSha256: FAKE_ATTESTATION_SHA256,
    })).toThrow();
  });

  it('strict (omitting isolationAttestationSha256 entirely) stays byte-identical to before this parameter existed -- null attestation hash, dontAsk, real policy metrics', () => {
    const record = buildRunRecord({
      conditionResult: fakeConditionResult(), condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-strict-default',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: ['build'], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    expect(record.execution_profile.isolation_attestation_sha256).toBeNull();
    expect(record.permission_mode_used).toBe('dontAsk');
    expect(record.policy_allowed_gradle_tasks).toEqual(['build']);
    expect(record.policy_allowed_kmptest_subcommands).toEqual(['doctor']);
    expect(record.policy_sha256).toBe(computePolicySha256());
    expect(record.hook_call_count).toBe(0);
    expect(record.hook_deny_count).toBe(0);
  });
});

// Review-round-2 regression coverage: graders.mjs's gradeScenarioCondition() exposes
// harnessEvidenceAmbiguous (a HARNESS-integrity defect -- JUnit evidence that cannot be reliably
// attributed to a specific Gradle attempt), but nothing previously propagated it onto the built
// run record at all, so scenarioCellIntegrityOk (cli.mjs) had no way to see it and block the whole
// matrix's promotion.
describe('buildRunRecord -- ambiguous_junit_evidence propagation (review-round-2 fix)', () => {
  function fakeScenarioConditionResult() {
    return {
      observation: {
        schema: 1,
        runtime: { id: 'claude-code', protocolVersion: 1 },
        process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 1000n },
        session: { initPresent: true, modelResolved: 'claude-sonnet-5-fake', sessionIdObserved: 'sess-1', runtimeVersion: 'fake', toolProfileMatchesExpected: true },
        transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
        terminal: { present: true, isError: false, turnCount: 1, finalText: 'irrelevant', resultSubtype: 'success', usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
        toolAttempts: [],
        skill: {
          available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
          targetInvocation: null, foreignInvocations: [],
          ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        },
        hookStats: { hookCallCount: 1, hookResponseCount: 1, hookDenyCount: 0, hookAllowCount: 1, hookPairingOk: true, everyCallHooked: true },
        byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
        timing: { receiptNsByEventIndex: new Map() },
      },
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
    };
  }
  function fakeGradeResult(overrides = {}) {
    return {
      expectedOutcomeMatched: false, success: false,
      checks: [], firstUsefulSignalEventIndex: null,
      testInvocationsTotal: 2, retries: 1,
      harnessEvidenceAmbiguous: false,
      parallelEvidenceMalformed: false,
      changedEvidenceMalformed: false,
      gradleJunitEvidenceUnreliable: false,
      ...overrides,
    };
  }

  it('a gradeResult with harnessEvidenceAmbiguous:true produces an ambiguous_junit_evidence error entry', () => {
    const record = buildRunRecord({
      conditionResult: fakeScenarioConditionResult(), condition: 'no-skill', runKind: 'scenario', scenarioId: 'test-ambiguous-junit',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [':shared:testAndroidHostTest'], allowedKmpTestSubcommands: ['parallel'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS, seed: 1, orderIndex: 0, repetitionIndex: 0,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      gradeResult: fakeGradeResult({ harnessEvidenceAmbiguous: true }),
    });
    expect(record.errors.some((e) => e.code === 'ambiguous_junit_evidence')).toBe(true);
  });

  it('a gradeResult with harnessEvidenceAmbiguous:false produces NO ambiguous_junit_evidence entry', () => {
    const record = buildRunRecord({
      conditionResult: fakeScenarioConditionResult(), condition: 'no-skill', runKind: 'scenario', scenarioId: 'test-ambiguous-junit-clean',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [':shared:testAndroidHostTest'], allowedKmpTestSubcommands: ['parallel'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS, seed: 1, orderIndex: 0, repetitionIndex: 0,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      gradeResult: fakeGradeResult({ harnessEvidenceAmbiguous: false }),
    });
    expect(record.errors.some((e) => e.code === 'ambiguous_junit_evidence')).toBe(false);
  });

  it('calibrate/smoke records (runKind !== scenario) never produce this error, regardless of gradeResult', () => {
    const record = buildRunRecord({
      conditionResult: fakeScenarioConditionResult(), condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-ambiguous-junit-calibration',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    expect(record.errors.some((e) => e.code === 'ambiguous_junit_evidence')).toBe(false);
  });

  // Round 10 (systematic-closure pass): the identical propagation gap existed for
  // parallelEvidenceMalformed (a genuinely incoherent parallel.legs[] structure on the terminal
  // kmp-test attempt) -- a fresh review found nothing surfaced it onto the run record either,
  // so scenarioCellIntegrityOk had no way to see it and block promotion.
  it('a gradeResult with parallelEvidenceMalformed:true produces a malformed_parallel_evidence error entry', () => {
    const record = buildRunRecord({
      conditionResult: fakeScenarioConditionResult(), condition: 'no-skill', runKind: 'scenario', scenarioId: 'test-malformed-parallel',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [':shared:testAndroidHostTest'], allowedKmpTestSubcommands: ['parallel'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS, seed: 1, orderIndex: 0, repetitionIndex: 0,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      gradeResult: fakeGradeResult({ parallelEvidenceMalformed: true }),
    });
    expect(record.errors.some((e) => e.code === 'malformed_parallel_evidence')).toBe(true);
  });

  it('a gradeResult with parallelEvidenceMalformed:false produces NO malformed_parallel_evidence entry', () => {
    const record = buildRunRecord({
      conditionResult: fakeScenarioConditionResult(), condition: 'no-skill', runKind: 'scenario', scenarioId: 'test-malformed-parallel-clean',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [':shared:testAndroidHostTest'], allowedKmpTestSubcommands: ['parallel'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS, seed: 1, orderIndex: 0, repetitionIndex: 0,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      gradeResult: fakeGradeResult({ parallelEvidenceMalformed: false }),
    });
    expect(record.errors.some((e) => e.code === 'malformed_parallel_evidence')).toBe(false);
  });

  it('calibrate/smoke records (runKind !== scenario) never produce malformed_parallel_evidence, regardless of gradeResult', () => {
    const record = buildRunRecord({
      conditionResult: fakeScenarioConditionResult(), condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-malformed-parallel-calibration',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    expect(record.errors.some((e) => e.code === 'malformed_parallel_evidence')).toBe(false);
  });

  // The identical propagation, mirrored exactly for changedEvidenceMalformed (graders.mjs's
  // changed-subcommand sibling of parallelEvidenceMalformed -- a genuinely incoherent changed{}
  // block, or a changed envelope also carrying a production-impossible parallel block, on the
  // terminal changed attempt).
  it('a gradeResult with changedEvidenceMalformed:true produces a malformed_changed_evidence error entry', () => {
    const record = buildRunRecord({
      conditionResult: fakeScenarioConditionResult(), condition: 'no-skill', runKind: 'scenario', scenarioId: 'test-malformed-changed',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [':core:common:test'], allowedKmpTestSubcommands: ['changed'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS, seed: 1, orderIndex: 0, repetitionIndex: 0,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      gradeResult: fakeGradeResult({ changedEvidenceMalformed: true }),
    });
    expect(record.errors.some((e) => e.code === 'malformed_changed_evidence')).toBe(true);
  });

  it('a gradeResult with changedEvidenceMalformed:false produces NO malformed_changed_evidence entry', () => {
    const record = buildRunRecord({
      conditionResult: fakeScenarioConditionResult(), condition: 'no-skill', runKind: 'scenario', scenarioId: 'test-malformed-changed-clean',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [':core:common:test'], allowedKmpTestSubcommands: ['changed'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS, seed: 1, orderIndex: 0, repetitionIndex: 0,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      gradeResult: fakeGradeResult({ changedEvidenceMalformed: false }),
    });
    expect(record.errors.some((e) => e.code === 'malformed_changed_evidence')).toBe(false);
  });

  it('calibrate/smoke records (runKind !== scenario) never produce malformed_changed_evidence, regardless of gradeResult', () => {
    const record = buildRunRecord({
      conditionResult: fakeScenarioConditionResult(), condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-malformed-changed-calibration',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    expect(record.errors.some((e) => e.code === 'malformed_changed_evidence')).toBe(false);
  });

  // Round 11 (Docker/local-ci audit): the identical propagation gap existed for
  // gradleJunitEvidenceUnreliable (a real JUnit XML with a genuine <skipped> testcase, or an
  // oversized/unreadable file) -- a fresh review found matrix-runner.mjs's
  // captureGradleJunitEvidence already returned a harness-integrity signal for this, but nothing
  // propagated it onto the run record, so scenarioCellIntegrityOk had no way to see it and block
  // promotion (exactly the same class of gap the two error codes above were fixed for).
  it('a gradeResult with gradleJunitEvidenceUnreliable:true produces an unreliable_gradle_junit_evidence error entry', () => {
    const record = buildRunRecord({
      conditionResult: fakeScenarioConditionResult(), condition: 'no-skill', runKind: 'scenario', scenarioId: 'test-unreliable-gradle-junit',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [':shared:testAndroidHostTest'], allowedKmpTestSubcommands: ['parallel'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS, seed: 1, orderIndex: 0, repetitionIndex: 0,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      gradeResult: fakeGradeResult({ gradleJunitEvidenceUnreliable: true }),
    });
    expect(record.errors.some((e) => e.code === 'unreliable_gradle_junit_evidence')).toBe(true);
  });

  it('a gradeResult with gradleJunitEvidenceUnreliable:false produces NO unreliable_gradle_junit_evidence entry', () => {
    const record = buildRunRecord({
      conditionResult: fakeScenarioConditionResult(), condition: 'no-skill', runKind: 'scenario', scenarioId: 'test-unreliable-gradle-junit-clean',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [':shared:testAndroidHostTest'], allowedKmpTestSubcommands: ['parallel'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS, seed: 1, orderIndex: 0, repetitionIndex: 0,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      gradeResult: fakeGradeResult({ gradleJunitEvidenceUnreliable: false }),
    });
    expect(record.errors.some((e) => e.code === 'unreliable_gradle_junit_evidence')).toBe(false);
  });

  it('calibrate/smoke records (runKind !== scenario) never produce unreliable_gradle_junit_evidence, regardless of gradeResult', () => {
    const record = buildRunRecord({
      conditionResult: fakeScenarioConditionResult(), condition: 'no-skill', runKind: 'smoke', scenarioId: 'test-unreliable-gradle-junit-smoke',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    expect(record.errors.some((e) => e.code === 'unreliable_gradle_junit_evidence')).toBe(false);
  });

  // "bind junit evidence to authoritative attempts" fix: junit_evidence_capture_incomplete is a
  // capture-MECHANISM failure (a missing/incoherent decision/evidence record, a command cross-check
  // mismatch, or a duplicate-write anomaly on some relevant attempt in this condition) -- an
  // independent propagation gap from ambiguous_junit_evidence/unreliable_gradle_junit_evidence
  // above, never merged with either.
  it('a gradeResult with gradleJunitEvidenceCaptureIncomplete:true produces a junit_evidence_capture_incomplete error entry', () => {
    const record = buildRunRecord({
      conditionResult: fakeScenarioConditionResult(), condition: 'no-skill', runKind: 'scenario', scenarioId: 'test-junit-capture-incomplete',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [':shared:testAndroidHostTest'], allowedKmpTestSubcommands: ['parallel'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS, seed: 1, orderIndex: 0, repetitionIndex: 0,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      gradeResult: fakeGradeResult({ gradleJunitEvidenceCaptureIncomplete: true }),
    });
    expect(record.errors.some((e) => e.code === 'junit_evidence_capture_incomplete')).toBe(true);
  });

  it('a gradeResult with gradleJunitEvidenceCaptureIncomplete:false produces NO junit_evidence_capture_incomplete entry', () => {
    const record = buildRunRecord({
      conditionResult: fakeScenarioConditionResult(), condition: 'no-skill', runKind: 'scenario', scenarioId: 'test-junit-capture-incomplete-clean',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [':shared:testAndroidHostTest'], allowedKmpTestSubcommands: ['parallel'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS, seed: 1, orderIndex: 0, repetitionIndex: 0,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      gradeResult: fakeGradeResult({ gradleJunitEvidenceCaptureIncomplete: false }),
    });
    expect(record.errors.some((e) => e.code === 'junit_evidence_capture_incomplete')).toBe(false);
  });

  it('calibrate/smoke records (runKind !== scenario) never produce junit_evidence_capture_incomplete, regardless of gradeResult', () => {
    const record = buildRunRecord({
      conditionResult: fakeScenarioConditionResult(), condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-junit-capture-incomplete-calibration',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    expect(record.errors.some((e) => e.code === 'junit_evidence_capture_incomplete')).toBe(false);
  });

  // Independence proof: harnessEvidenceAmbiguous:true and gradleJunitEvidenceCaptureIncomplete:true
  // together on the SAME gradeResult produce BOTH error codes, never one masking the other.
  it('harnessEvidenceAmbiguous and gradleJunitEvidenceCaptureIncomplete both true on the SAME gradeResult produce BOTH error codes independently', () => {
    const record = buildRunRecord({
      conditionResult: fakeScenarioConditionResult(), condition: 'no-skill', runKind: 'scenario', scenarioId: 'test-junit-both-codes',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [':shared:testAndroidHostTest'], allowedKmpTestSubcommands: ['parallel'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS, seed: 1, orderIndex: 0, repetitionIndex: 0,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      gradeResult: fakeGradeResult({ harnessEvidenceAmbiguous: true, gradleJunitEvidenceCaptureIncomplete: true }),
    });
    expect(record.errors.some((e) => e.code === 'ambiguous_junit_evidence')).toBe(true);
    expect(record.errors.some((e) => e.code === 'junit_evidence_capture_incomplete')).toBe(true);
  });
});

// Regression coverage for a review-round-3 finding: tool_calls_total's new
// `invocation?.attemptCount ?? 0` computation (replacing a flat 0-or-1) was only exercised at the
// findSkillInvocation/attemptCount level (agentic-eval-stream-parser.test.js) -- nothing proved
// buildRunRecord() itself actually wires that field into the final total correctly.
describe('buildRunRecord -- tool_calls_total counts every Skill attempt, not just presence/absence', () => {
  function bashToolUseEvent(id) {
    return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command: 'kmp-test doctor --json' } }] } };
  }
  function skillToolUseEvent(id, skill) {
    return { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id, input: { skill } }] } };
  }
  // tool_calls_total/shell_commands_total/foreign_skill_summary all derive from
  // observation.toolAttempts/observation.skill.foreignInvocations now -- converts a raw events[]
  // fixture into that canonical shape using the REAL frozen stream-parser.mjs primitives (test
  // files are permitted to import stream-parser.mjs directly; only production consumers are bound
  // by the core-consumer boundary). targetInvocation is left null throughout this describe block --
  // none of its tests assert on skill_invocation_attempted/skill_invoked/skill_invocation_event, and
  // buildRunRecord handles a null targetInvocation safely (optional-chained everywhere it's read).
  function observationFromEvents(events, { targetPluginName = 'kmp-test-runner', targetSkillName = 'kmp-test-runner' } = {}) {
    const expectedToolNames = new Set(['Bash', 'Skill']);
    const toolAttempts = findAllToolUsesWithResults(events).map((u) => {
      const kind = u.name === 'Skill' ? 'skill' : u.name === 'Bash' ? 'shell' : 'other';
      const command = kind === 'shell' ? (typeof u.input?.command === 'string' ? u.input.command : null) : null;
      const textStatus = !u.resultFound ? 'missing' : (typeof u.resultContent === 'string' ? 'text' : 'unsupported');
      return {
        id: u.id ?? null, kind, runtimeName: u.name ?? null, eventIndex: u.index,
        receiptNs: typeof u.receiptNs === 'bigint' ? u.receiptNs : null,
        profileAllowed: expectedToolNames.has(u.name), command,
        skillReference: kind === 'skill' && typeof u.input?.skill === 'string' ? u.input.skill : null,
        targetsExpectedSkill: null,
        result: { found: u.resultFound, eventIndex: u.resultFound ? u.resultIndex : null, isError: u.resultFound ? u.resultIsError : null, text: textStatus === 'text' ? u.resultContent : null, textStatus },
        preDispatchBlock: { recognized: false, signature: null },
      };
    });
    const foreignInvocations = classifyForeignSkillUses(events, targetPluginName, targetSkillName).map((f) => ({
      eventIndex: f.index, receiptNs: typeof f.receiptNs === 'bigint' ? f.receiptNs : null,
      id: f.id ?? null, skillReference: f.skillArg ?? null, resultIsError: f.resultIsError, confirmed: f.confirmed,
    }));
    return {
      schema: 1,
      runtime: { id: 'claude-code', protocolVersion: 1 },
      process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 1000n },
      session: { initPresent: true, modelResolved: 'claude-sonnet-5-fake', sessionIdObserved: 'sess-1', runtimeVersion: 'fake', toolProfileMatchesExpected: true },
      transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
      terminal: { present: true, isError: false, turnCount: 1, finalText: 'irrelevant', resultSubtype: 'success', usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
      toolAttempts,
      skill: {
        available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
        targetInvocation: null, foreignInvocations,
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
      },
      hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: true },
      byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
      timing: { receiptNsByEventIndex: new Map() },
    };
  }

  it('sums N real Bash tool_use events plus N real multi-attempt Skill tool_use events, not a flat 0-or-1', () => {
    // 2 real Skill tool_use blocks below back a 2-attempt invocation (e.g. a
    // failed-then-retried-successful invocation) -- tool_calls_total derives purely from the
    // transcript's own tool_use blocks (findAllToolUsesWithResults), matching the
    // accepted-run-audit sidecar's own derivation, so a decoupled attemptCount with no
    // corresponding real event would no longer be reflected in the total.
    const events = [bashToolUseEvent('toolu_1'), bashToolUseEvent('toolu_2'), bashToolUseEvent('toolu_3'), skillToolUseEvent('toolu_4', 'kmp-test-runner'), skillToolUseEvent('toolu_5', 'kmp-test-runner')];
    const conditionResult = {
      observation: observationFromEvents(events),
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
    };
    const record = buildRunRecord({
      conditionResult, condition: 'current-skill', runKind: 'calibration', scenarioId: 'test-tool-calls-total',
      skillSourceSha: 'aeba6eaa8d027be999cdfeeb5bb2d1bbd0f688ee', daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    // 3 real Bash tool_use events + 2 real Skill tool_use events = 5, not 4.
    expect(record.tool_calls_total).toEqual({ value: 5, reason: null });
    expect(record.shell_commands_total).toEqual({ value: 3, reason: null });
  });

  it('falls back to 0 for the Skill contribution when invocation is null (no attempt at all)', () => {
    const events = [bashToolUseEvent('toolu_1')];
    const conditionResult = {
      observation: observationFromEvents(events),
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
    };
    const record = buildRunRecord({
      conditionResult, condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-tool-calls-total-no-invocation',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    expect(record.tool_calls_total).toEqual({ value: 1, reason: null });
  });

  // Dedicated, isolated coverage for THIS PR's own addition (result-aware foreign-skill
  // classification): a foreign Skill attempt was, until now, silently uncounted -- neither
  // findBashToolUses (name!=='Bash') nor invocation?.attemptCount (findSkillInvocation is scoped
  // to ONLY the expected skill name) ever sees it. Zero Bash events and a single-attempt
  // expected-skill invocation isolate the foreign contribution precisely: 0 (Bash) + 1
  // (invocation.attemptCount) + 1 (the new foreignSkillUses.length term) = 2, not 1.
  it('counts a foreign Skill attempt in the total -- it is no longer silently uncounted', () => {
    const events = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id: 'toolu_foreign1', input: { skill: 'totally-unrelated-skill' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_foreign1', is_error: true, content: '<tool_use_error>Unknown skill: totally-unrelated-skill</tool_use_error>' }] } },
      // tool_calls_total derives purely from real transcript tool_use blocks -- this event is a
      // second, expected-skill Skill tool_use, distinct from the foreign one above.
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id: 'toolu_target1', input: { skill: 'kmp-test-runner' } }] } },
    ];
    const conditionResult = {
      observation: observationFromEvents(events),
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
    };
    const record = buildRunRecord({
      conditionResult, condition: 'current-skill', runKind: 'calibration', scenarioId: 'test-tool-calls-total-foreign-skill',
      skillSourceSha: 'aeba6eaa8d027be999cdfeeb5bb2d1bbd0f688ee', daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    // 0 Bash + 1 expected-skill tool_use event + 1 foreign-skill tool_use event = 2, not 1.
    expect(record.tool_calls_total).toEqual({ value: 2, reason: null });
    expect(record.foreign_skill_summary).toEqual({ rejected: 1, confirmed: 0, incomplete: 0 });
  });
});

// Regression coverage for a real gap found while implementing the gitignore-safety check above:
// writeRunRecordEvidence() can itself throw (a run_id collision, or an unsafe raw destination),
// but finalizeAndWriteRecords() called it with no try/catch of its own -- and neither
// cmdCalibrate() nor cmdSmoke() wrap their own `await finalizeAndWriteRecords(...)` call either.
// An uncaught throw there would have propagated all the way out as an unhandled rejection instead
// of the {ok:false, reason} pattern every OTHER check in this function already uses. Proven here
// via a real run_id collision reaching finalizeAndWriteRecords() itself (not writeRunRecordEvidence
// directly, which agentic-eval-cli.test.js's "writeRunRecordEvidence" describe block already
// covers). The finalizer's injectable runs root keeps this destructive fixture entirely outside
// the repository and its real, shared evidence tree.
describe('finalizeAndWriteRecords -- a writeRunRecordEvidence() throw returns {ok:false}, never an uncaught rejection', () => {
  it('returns {ok:false, reason} instead of throwing when the target evidence file already exists', async () => {
    function fakeConditionResult() {
      return {
        observation: {
          schema: 1,
          runtime: { id: 'claude-code', protocolVersion: 1 },
          process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 1000n },
          session: { initPresent: true, modelResolved: 'claude-sonnet-5-fake', sessionIdObserved: 'sess-1', runtimeVersion: 'fake', toolProfileMatchesExpected: true },
          transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
          terminal: { present: true, isError: false, turnCount: 1, finalText: 'irrelevant', resultSubtype: 'success', usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
          toolAttempts: [],
          skill: {
            available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
            targetInvocation: null, foreignInvocations: [],
            ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
          },
          hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: true },
          byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
          timing: { receiptNsByEventIndex: new Map() },
        },
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        endedAt: new Date('2026-01-01T00:00:01.000Z'),
      };
    }
    const policySha256 = computePolicySha256();
    const common = { runKind: 'calibration', scenarioId: 'test-collision-via-finalize', daemonPolicy: 'disabled-via-gradle-user-home-properties', allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256, ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'), ...TEST_RUN_RECORD_V6_INPUTS };
    const recordA = buildRunRecord({ conditionResult: fakeConditionResult(), condition: 'no-skill', skillSourceSha: null, ...common });
    const recordB = buildRunRecord({ conditionResult: fakeConditionResult(), condition: 'current-skill', skillSourceSha: 'c5c0661852f7c9da145ef56892048e706216a6ce', ...common });
    // This test is specifically about the run_id-collision property, not dirty-tree behavior --
    // clear whatever real dirty_measured_code/dirty_harness_tooling errors buildRunRecord() may
    // have picked up from the ACTUAL, ambient git state of this repo at test-run time (e.g. this
    // very file being actively edited), so the test result never depends on incidental local
    // working-tree state.
    recordA.errors = [];
    recordB.errors = [];
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'agentic-finalize-collision-'));
    const outDir = path.join(runsRoot, 'agentic-eval-calibration');
    const collidingPath = path.join(outDir, `${recordA.run_id}.json`);

    mkdirSync(outDir, { recursive: true });
    writeFileSync(collidingPath, '{"prior":"real evidence -- must survive"}');
    try {
      let thrown = null;
      let result = null;
      try {
        result = await finalizeAndWriteRecords({
          runKind: 'calibration', recordA, recordB,
          runA: { observation: fakeConditionResult().observation },
          runB: { observation: fakeConditionResult().observation },
          hardGateFn: () => ({ ok: true, reason: null }),
          runsRootOverride: runsRoot,
          transcriptsByRunId: { [recordA.run_id]: '', [recordB.run_id]: '' },
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeNull();
      expect(result?.ok).toBe(false);
      expect(result?.reason).toContain('Evidence write refused');
      expect(readFileSync(collidingPath, 'utf8')).toBe('{"prior":"real evidence -- must survive"}');
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });
});

// cmdCorpusValidate() reads from a fixed, repo-relative corpus/ directory (not
// parameterizable), so this only proves the wiring succeeds against the real, committed corpus
// -- the underlying content-validation LOGIC (shape, banned terms, activation hints, partition
// coverage) has its own comprehensive synthetic-failure-case coverage in
// agentic-eval-schemas.test.js's validateTriggerQueries describe block. The duplicate-id and
// filename-match checks below are extracted as standalone pure functions specifically so their
// NEGATIVE cases are unit-testable with synthetic input, since cmdCorpusValidate() itself always
// reads the fixed real directory (which has neither duplicates nor mismatches by construction).
describe('cmdCorpusValidate', () => {
  it('returns 0 (success) against the real, committed corpus', async () => {
    const { cmdCorpusValidate } = await import('../../tools/agentic-eval/cli.mjs');
    expect(cmdCorpusValidate()).toBe(0);
  });
});

// EXACT REPRODUCTION (manual review of the systematic-closure pass): cmdCorpusValidate's own
// JSON.parse('.map()') let one malformed scenario file's throw propagate all the way to main()'s
// global catch (a stack trace + exit 2), aborting validation of every OTHER file -- fails closed,
// but contradicts corpus validate's whole purpose (report every file's status). Fixed by extracting
// the per-file parse (loadScenarioFile) and the per-entry validation loop (validateLoadedScenarios)
// as their own pure, synthetic-input-testable functions, since cmdCorpusValidate() itself always
// reads the fixed real corpus/scenarios/ directory (see its own describe block above).
describe('loadScenarioFile', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('returns {file, scenario} for a real, valid JSON file', async () => {
    const { loadScenarioFile } = await import('../../tools/agentic-eval/cli.mjs');
    dir = mkdtempSync(path.join(os.tmpdir(), 'aec-load-scenario-'));
    writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ id: 'kampkit-a' }));
    expect(loadScenarioFile(dir, 'good.json')).toEqual({ file: 'good.json', scenario: { id: 'kampkit-a' } });
  });

  it('EXACT REPRODUCTION: returns {file, parseError} for malformed JSON, never throws', async () => {
    const { loadScenarioFile } = await import('../../tools/agentic-eval/cli.mjs');
    dir = mkdtempSync(path.join(os.tmpdir(), 'aec-load-scenario-'));
    writeFileSync(path.join(dir, 'bad.json'), '{ this is not valid JSON');
    let result;
    expect(() => { result = loadScenarioFile(dir, 'bad.json'); }).not.toThrow();
    expect(result.file).toBe('bad.json');
    expect(typeof result.parseError).toBe('string');
    expect(result.scenario).toBeUndefined();
  });
});

describe('validateLoadedScenarios', () => {
  it('EXACT REPRODUCTION: one entry\'s parseError does not prevent the OTHER entries, valid or invalid, from being fully validated and reported', async () => {
    const { validateLoadedScenarios } = await import('../../tools/agentic-eval/cli.mjs');
    // Deliberately minimal/schema-invalid "good" scenarios -- this test isolates ONLY "did every
    // OTHER entry still go through the real validateScenario() path and get its own reported
    // result," never "does a fully schema-valid scenario pass" (already covered by
    // cmdCorpusValidate's own "returns 0 against the real corpus" test above).
    const loaded = [
      { file: 'a.json', scenario: { id: 'kampkit-a' } },
      { file: 'b-corrupt.json', parseError: 'Unexpected token } in JSON at position 3' },
      { file: 'c.json', scenario: { id: 'kampkit-c' } },
    ];
    const result = validateLoadedScenarios(loaded);
    expect(result.ok).toBe(false); // b-corrupt.json alone must fail the whole command
    // Nothing was silently skipped -- one result per input entry, same length, same order.
    expect(result.results.map((r) => r.file)).toEqual(['a.json', 'b-corrupt.json', 'c.json']);
    const byFile = Object.fromEntries(result.results.map((r) => [r.file, r]));
    expect(byFile['b-corrupt.json'].ok).toBe(false);
    expect(byFile['b-corrupt.json'].message).toContain('invalid JSON');
    expect(byFile['b-corrupt.json'].message).toContain('Unexpected token');
    // a.json/c.json went through the REAL validateScenario() path (proven by their own real
    // schema errors appearing), never treated as a parse failure themselves.
    expect(byFile['a.json'].message).not.toContain('invalid JSON');
    expect(byFile['c.json'].message).not.toContain('invalid JSON');
  });

  it('a duplicate id between two VALID-SHAPED entries is still attributed correctly when a THIRD entry has a parseError', async () => {
    const { validateLoadedScenarios } = await import('../../tools/agentic-eval/cli.mjs');
    const loaded = [
      { file: 'first.json', scenario: { id: 'kampkit-dup' } },
      { file: 'broken.json', parseError: 'Unexpected end of JSON input' },
      { file: 'second.json', scenario: { id: 'kampkit-dup' } },
    ];
    const result = validateLoadedScenarios(loaded);
    const byFile = Object.fromEntries(result.results.map((r) => [r.file, r]));
    // Messages are JSON.stringify'd error arrays, so quotes around the id are backslash-escaped --
    // matched without the surrounding quote characters to stay robust to that encoding.
    expect(byFile['second.json'].message).toContain('duplicate id');
    expect(byFile['second.json'].message).toContain('kampkit-dup');
    expect(byFile['second.json'].message).toContain('already declared by first.json');
    expect(byFile['first.json'].message).not.toContain('duplicate');
    expect(byFile['broken.json'].message).toContain('invalid JSON');
  });
});

describe('checkScenarioFilenameMatchesId', () => {
  it('returns null when the filename matches "${id}.json" exactly', async () => {
    const { checkScenarioFilenameMatchesId } = await import('../../tools/agentic-eval/cli.mjs');
    expect(checkScenarioFilenameMatchesId({ id: 'kampkit-example' }, 'kampkit-example.json')).toBeNull();
  });

  it('returns an error object when the filename diverges from the declared id', async () => {
    const { checkScenarioFilenameMatchesId } = await import('../../tools/agentic-eval/cli.mjs');
    const result = checkScenarioFilenameMatchesId({ id: 'kampkit-example' }, 'wrong-name.json');
    expect(result).toEqual({
      field: 'id',
      message: 'filename "wrong-name.json" does not match its own declared id -- expected "kampkit-example.json"',
    });
  });

  it('returns null (defers to validateScenario) when id is missing or not a string', async () => {
    const { checkScenarioFilenameMatchesId } = await import('../../tools/agentic-eval/cli.mjs');
    expect(checkScenarioFilenameMatchesId({}, 'anything.json')).toBeNull();
    expect(checkScenarioFilenameMatchesId({ id: 42 }, 'anything.json')).toBeNull();
    expect(checkScenarioFilenameMatchesId(null, 'anything.json')).toBeNull();
  });
});

describe('findDuplicateScenarioIds', () => {
  it('returns an empty array when every id is unique', async () => {
    const { findDuplicateScenarioIds } = await import('../../tools/agentic-eval/cli.mjs');
    const pairs = [
      { id: 'kampkit-a', file: 'kampkit-a.json' },
      { id: 'kampkit-b', file: 'kampkit-b.json' },
    ];
    expect(findDuplicateScenarioIds(pairs)).toEqual([]);
  });

  it('flags every re-declaration of an id already seen, attributing it back to the first file', async () => {
    const { findDuplicateScenarioIds } = await import('../../tools/agentic-eval/cli.mjs');
    const pairs = [
      { id: 'kampkit-a', file: 'first.json' },
      { id: 'kampkit-b', file: 'other.json' },
      { id: 'kampkit-a', file: 'second.json' },
    ];
    const errors = findDuplicateScenarioIds(pairs);
    expect(errors).toEqual([
      { field: 'id', file: 'second.json', message: 'duplicate id "kampkit-a" in second.json -- already declared by first.json' },
    ]);
  });

  it('flags a THIRD file re-declaring the same id independently of the second', async () => {
    const { findDuplicateScenarioIds } = await import('../../tools/agentic-eval/cli.mjs');
    const pairs = [
      { id: 'kampkit-a', file: 'first.json' },
      { id: 'kampkit-a', file: 'second.json' },
      { id: 'kampkit-a', file: 'third.json' },
    ];
    const errors = findDuplicateScenarioIds(pairs);
    expect(errors).toEqual([
      { field: 'id', file: 'second.json', message: 'duplicate id "kampkit-a" in second.json -- already declared by first.json' },
      { field: 'id', file: 'third.json', message: 'duplicate id "kampkit-a" in third.json -- already declared by first.json' },
    ]);
  });

  it('returns `file` structurally so a caller can attribute an error to its owning file by direct equality, not by parsing the message', async () => {
    const { findDuplicateScenarioIds } = await import('../../tools/agentic-eval/cli.mjs');
    const pairs = [
      { id: 'kampkit-a', file: 'first.json' },
      { id: 'kampkit-a', file: 'second.json' },
    ];
    const [error] = findDuplicateScenarioIds(pairs);
    expect(error.file).toBe('second.json');
  });

  it('ignores entries whose id is missing or not a string, without throwing', async () => {
    const { findDuplicateScenarioIds } = await import('../../tools/agentic-eval/cli.mjs');
    const pairs = [
      { id: undefined, file: 'no-id.json' },
      { id: 42, file: 'numeric-id.json' },
      { id: 'kampkit-a', file: 'real.json' },
    ];
    expect(findDuplicateScenarioIds(pairs)).toEqual([]);
  });

  it('returns an empty array for an empty input list', async () => {
    const { findDuplicateScenarioIds } = await import('../../tools/agentic-eval/cli.mjs');
    expect(findDuplicateScenarioIds([])).toEqual([]);
  });
});

// Round 8: a fresh review reproduced this function still rejecting two more real remote-URL forms
// after round 7's original SSH-shorthand/HTTPS fix, AND noted zero regression tests existed for it
// at all despite round 7 claiming every new behavior was verified RED->GREEN -- an accurate
// correction: this function specifically had no direct unit coverage until now.
describe('normalizeGitRemoteForComparison', () => {
  it('EXACT REPRODUCTION: the ssh:// URI form (distinct from the git@host:path shorthand) now canonicalizes to the same identity as the HTTPS form', async () => {
    const { normalizeGitRemoteForComparison } = await import('../../tools/agentic-eval/cli.mjs');
    const ssh = normalizeGitRemoteForComparison('ssh://git@github.com/touchlab/KaMPKit.git');
    const https = normalizeGitRemoteForComparison('https://github.com/touchlab/KaMPKit');
    expect(ssh).toBe(https);
  });

  it('EXACT REPRODUCTION: a trailing slash AFTER .git no longer defeats .git-suffix stripping', async () => {
    const { normalizeGitRemoteForComparison } = await import('../../tools/agentic-eval/cli.mjs');
    const withTrailingSlash = normalizeGitRemoteForComparison('https://github.com/touchlab/KaMPKit.git/');
    const withoutTrailingSlash = normalizeGitRemoteForComparison('https://github.com/touchlab/KaMPKit');
    expect(withTrailingSlash).toBe(withoutTrailingSlash);
  });

  it('EXACT REPRODUCTION: scheme/host case differences no longer produce a different canonical identity (path case held IDENTICAL to isolate this from path case-sensitivity)', async () => {
    const { normalizeGitRemoteForComparison } = await import('../../tools/agentic-eval/cli.mjs');
    const upper = normalizeGitRemoteForComparison('HTTPS://GitHub.com/touchlab/KaMPKit.git');
    const lower = normalizeGitRemoteForComparison('https://github.com/touchlab/KaMPKit');
    expect(upper).toBe(lower);
  });

  // Round 9: a fresh review reproduced the PRECEDING test conflating scheme/host case-insensitivity
  // with path case -- it compared 'KaMPKit' against 'kampkit' in the SAME assertion as the
  // scheme/host case difference, which (given the old implementation lowercased the whole result)
  // passed for the wrong reason and locked in "path case is ignored" as expected behavior. Most git
  // hosts treat repository paths as case-SENSITIVE; this tool is not GitHub-specific. Path case must
  // now be preserved exactly -- only the host is normalized.
  it('EXACT REPRODUCTION: path case is preserved, NOT normalized -- Team/Repo and team/repo are different repositories', async () => {
    const { normalizeGitRemoteForComparison } = await import('../../tools/agentic-eval/cli.mjs');
    const a = normalizeGitRemoteForComparison('https://example.com/Team/Repo');
    const b = normalizeGitRemoteForComparison('https://example.com/team/repo');
    expect(a).not.toBe(b);
  });

  it('regression guard: the bare SSH shorthand (git@host:org/repo) still canonicalizes to the same identity as HTTPS', async () => {
    const { normalizeGitRemoteForComparison } = await import('../../tools/agentic-eval/cli.mjs');
    const ssh = normalizeGitRemoteForComparison('git@github.com:touchlab/KaMPKit.git');
    const https = normalizeGitRemoteForComparison('https://github.com/touchlab/KaMPKit');
    expect(ssh).toBe(https);
  });

  it('a genuinely different repository does NOT canonicalize to the same identity', async () => {
    const { normalizeGitRemoteForComparison } = await import('../../tools/agentic-eval/cli.mjs');
    const a = normalizeGitRemoteForComparison('https://github.com/touchlab/KaMPKit');
    const b = normalizeGitRemoteForComparison('https://github.com/touchlab/other-repo');
    expect(a).not.toBe(b);
  });

  it('a genuinely different host does NOT canonicalize to the same identity', async () => {
    const { normalizeGitRemoteForComparison } = await import('../../tools/agentic-eval/cli.mjs');
    const a = normalizeGitRemoteForComparison('https://github.com/touchlab/KaMPKit');
    const b = normalizeGitRemoteForComparison('https://gitlab.com/touchlab/KaMPKit');
    expect(a).not.toBe(b);
  });
});

// accepted-run-observability PR: cmdAggregate's own file-discovery step (readdirSync, never
// recursive) must never descend into a nested audit/ directory -- proven directly here rather
// than only implicitly relying on Node's own non-recursive readdirSync default, since this is
// exactly the kind of assumption a future refactor (e.g. a switch to a recursive glob) could
// silently break.
describe('cmdAggregate -- does not recurse into a nested audit/ directory', () => {
  it('reads only top-level *.json files; a malformed file inside audit/ is never touched', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aec-aggregate-noaudit-'));
    try {
      // Discovered dynamically, never a hard-coded historical filename -- this test only needs
      // SOME real, valid schema-conformant record; pinning one specific committed filename would
      // make the test fragile to an unrelated future rename/cleanup of that exact file.
      const scenarioDir = path.join(REPO_ROOT, 'tools', 'runs', 'agentic-eval-scenario');
      const anyScenarioFile = readdirSync(scenarioDir).find((f) => f.endsWith('.json'));
      const realRecord = readFileSync(path.join(scenarioDir, anyScenarioFile), 'utf8');
      writeFileSync(path.join(dir, 'r1.json'), realRecord);
      const auditDir = path.join(dir, 'audit');
      mkdirSync(auditDir, { recursive: true });
      // Deliberately invalid JSON -- if cmdAggregate ever recursed into audit/, reading this
      // would throw (JSON.parse) rather than silently succeed.
      writeFileSync(path.join(auditDir, 'sidecar.json'), 'not valid json {{{');
      expect(() => cmdAggregate({ 'runs-dir': dir })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Schema v5 (accepted-run-observability PR): buildRunRecord()'s own responsibility is limited to
// the 4 new post-signal {value,reason} metrics (computed from conditionResult/gradeResult it
// already receives) plus a null accepted_audit PLACEHOLDER -- the real accepted_audit object is
// attached later, by matrix finalization, once the sidecar's own redacted SHA-256 is known (see
// accepted-run-audit.mjs). Every OTHER schema-v5 field (schema itself now LATEST_RUN_SCHEMA=5) is
// exercised implicitly by every OTHER buildRunRecord test in this file continuing to pass
// unmodified.
describe('buildRunRecord -- schema v5 post-signal metrics + accepted_audit placeholder', () => {
  // toolAttempts (and hence tool_calls_total/post_signal_tool_calls/the policy-denial{before,after}
  // split) now derive purely from observation.toolAttempts, built here via the REAL frozen
  // findAllToolUsesWithResults (test files are permitted to import stream-parser.mjs directly) --
  // the old hand-maintained `bashResults` parameter was always redundant with what that function
  // independently derives from `events`, so it is dropped. receiptNsByEventIndex is built directly
  // from each event's own `_receiptNs` (the real per-event field findAllToolUsesWithResults' own
  // receiptNs output is sourced from -- see stream-parser.mjs), matching this describe block's
  // pre-existing convention of hand-setting `_receiptNs` on synthetic event literals.
  function fakeConditionResultWithEvents({ events = [], decisionByAttempt = new Map(), endedHrtimeNs } = {}) {
    const expectedToolNames = new Set(['Bash', 'Skill']);
    const toolAttempts = findAllToolUsesWithResults(events).map((u) => {
      const kind = u.name === 'Skill' ? 'skill' : u.name === 'Bash' ? 'shell' : 'other';
      const command = kind === 'shell' ? (typeof u.input?.command === 'string' ? u.input.command : null) : null;
      const textStatus = !u.resultFound ? 'missing' : (typeof u.resultContent === 'string' ? 'text' : 'unsupported');
      return {
        id: u.id ?? null, kind, runtimeName: u.name ?? null, eventIndex: u.index,
        receiptNs: typeof u.receiptNs === 'bigint' ? u.receiptNs : null,
        profileAllowed: expectedToolNames.has(u.name), command,
        skillReference: kind === 'skill' && typeof u.input?.skill === 'string' ? u.input.skill : null,
        targetsExpectedSkill: null,
        result: { found: u.resultFound, eventIndex: u.resultFound ? u.resultIndex : null, isError: u.resultFound ? u.resultIsError : null, text: textStatus === 'text' ? u.resultContent : null, textStatus },
        preDispatchBlock: { recognized: false, signature: null },
      };
    });
    return {
      observation: {
        schema: 1,
        runtime: { id: 'claude-code', protocolVersion: 1 },
        process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: endedHrtimeNs ?? 1000n },
        session: { initPresent: true, modelResolved: 'claude-sonnet-5-fake', sessionIdObserved: 'sess-1', runtimeVersion: 'fake', toolProfileMatchesExpected: true },
        transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
        terminal: { present: true, isError: false, turnCount: 1, finalText: 'irrelevant', resultSubtype: 'success', usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
        toolAttempts,
        skill: {
          available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
          targetInvocation: null, foreignInvocations: [],
          ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        },
        hookStats: { hookCallCount: toolAttempts.length, hookResponseCount: toolAttempts.length, hookDenyCount: 0, hookAllowCount: toolAttempts.length, hookPairingOk: true, everyCallHooked: true },
        byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
        timing: { receiptNsByEventIndex: new Map(events.map((e, i) => [i, e._receiptNs])) },
      },
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
      junitAttribution: { decisionByAttempt },
    };
  }

  const commonScenarioParams = {
    condition: 'no-skill', runKind: 'scenario', scenarioId: 'test-post-signal',
    skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
    allowedGradleTasks: [':shared:testAndroidHostTest'], allowedKmpTestSubcommands: ['parallel'],
    policySha256: computePolicySha256(), seed: 1, orderIndex: 0, repetitionIndex: 0,
    ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    ...TEST_RUN_RECORD_V6_INPUTS,
  };

  it('schema is now LATEST_RUN_SCHEMA, and every record carries accepted_audit:null at build time', () => {
    const record = buildRunRecord({
      conditionResult: fakeConditionResultWithEvents({ events: [] }),
      ...commonScenarioParams,
      gradeResult: { expectedOutcomeMatched: false, success: false, checks: [], firstUsefulSignalEventIndex: null, testInvocationsTotal: 0, retries: 0 },
    });
    expect(record.schema).toBe(LATEST_RUN_SCHEMA);
    expect(record.accepted_audit).toBeNull();
  });

  it('a non-scenario (calibration) record reports all 4 new metrics null with a run-kind-specific reason', () => {
    const record = buildRunRecord({
      conditionResult: fakeConditionResultWithEvents({ events: [] }),
      condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-post-signal-calibration',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    for (const f of ['post_signal_ms', 'post_signal_tool_calls', 'policy_denials_before_first_signal', 'policy_denials_after_first_signal']) {
      expect(record[f].value).toBeNull();
      expect(record[f].reason).toBe('calibration run -- no scenario grader applies');
    }
    expect(record.accepted_audit).toBeNull();
  });

  it('a scenario record with NO first-useful-signal boundary reports all 4 metrics null with the exact reason', () => {
    const record = buildRunRecord({
      conditionResult: fakeConditionResultWithEvents({ events: [] }),
      ...commonScenarioParams,
      gradeResult: { expectedOutcomeMatched: false, success: false, checks: [], firstUsefulSignalEventIndex: null, testInvocationsTotal: 0, retries: 0 },
    });
    for (const f of ['post_signal_ms', 'post_signal_tool_calls', 'policy_denials_before_first_signal', 'policy_denials_after_first_signal']) {
      expect(record[f].value).toBeNull();
      expect(record[f].reason).toBe('no first useful signal boundary');
    }
  });

  it('a scenario record WITH a real boundary computes real post_signal_ms/post_signal_tool_calls/policy_denials_{before,after}', () => {
    // 0=init,1=tool_use(t1),2=result(t1, THE signal),3=tool_use(t2, dispatched AFTER signal, denied),4=result(t2)
    const events = [
      { type: 'system', subtype: 'init', _receiptNs: 0n },
      { type: 'assistant', _receiptNs: 1_000_000n, message: { content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'kmp-test parallel --module-filter shared --json' } }] } },
      { type: 'user', _receiptNs: 2_000_000n, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] } },
      { type: 'assistant', _receiptNs: 3_000_000n, message: { content: [{ type: 'tool_use', name: 'Bash', id: 't2', input: { command: 'kmp-test doctor --json' } }] } },
      { type: 'user', _receiptNs: 4_000_000n, message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'denied', is_error: true }] } },
    ];
    const decisionByAttempt = new Map([['t1', 'allow'], ['t2', 'deny']]);
    const endedHrtimeNs = 10_000_000n;
    const record = buildRunRecord({
      conditionResult: fakeConditionResultWithEvents({ events, decisionByAttempt, endedHrtimeNs }),
      ...commonScenarioParams,
      gradeResult: { expectedOutcomeMatched: true, success: true, checks: [], firstUsefulSignalEventIndex: 2, testInvocationsTotal: 1, retries: 0 },
    });
    expect(record.first_useful_signal_event).toEqual({ type: 'user.tool_result', index: 2 });
    expect(record.post_signal_ms.value).toBe(8); // (10_000_000 - 2_000_000) ns = 8ms
    expect(record.post_signal_ms.reason).toBeNull();
    expect(record.post_signal_tool_calls.value).toBe(1); // t2's own tool_use is at index 3 > 2
    expect(record.policy_denials_before_first_signal.value).toBe(0);
    expect(record.policy_denials_after_first_signal.value).toBe(1); // t2 (denied, dispatched at index 3 > 2)
  });

  it('a denial dispatched BEFORE the signal boundary counts as "before", even one dispatched in the SAME assistant turn as the eventual signal-producing call', () => {
    // 0=init,1=tool_use BATCH (t1 allowed-parallel + t2 denied-doctor, SAME assistant turn),2=result(t1, signal),3=result(t2)
    const events = [
      { type: 'system', subtype: 'init', _receiptNs: 0n },
      {
        type: 'assistant', _receiptNs: 1_000_000n,
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'kmp-test parallel --module-filter shared --json' } },
            { type: 'tool_use', name: 'Bash', id: 't2', input: { command: 'kmp-test doctor --json' } },
          ],
        },
      },
      { type: 'user', _receiptNs: 2_000_000n, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] } },
      { type: 'user', _receiptNs: 3_000_000n, message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'denied', is_error: true }] } },
    ];
    const decisionByAttempt = new Map([['t1', 'allow'], ['t2', 'deny']]);
    const record = buildRunRecord({
      conditionResult: fakeConditionResultWithEvents({ events, decisionByAttempt, endedHrtimeNs: 20_000_000n }),
      ...commonScenarioParams,
      gradeResult: { expectedOutcomeMatched: true, success: true, checks: [], firstUsefulSignalEventIndex: 2, testInvocationsTotal: 1, retries: 0 },
    });
    // t2's OWN tool-use index (1) is <= the signal's result index (2) -- classified "before",
    // even though t2's own RESULT (index 3) arrives after the signal.
    expect(record.policy_denials_before_first_signal.value).toBe(1);
    expect(record.policy_denials_after_first_signal.value).toBe(0);
  });

  // Review finding: tool_calls_total previously summed findBashToolUses().length +
  // invocation?.attemptCount + foreignSkillUses.length -- a real, unexpected tool_use block (e.g.
  // a bare Read call, never Bash and never Skill) was silently dropped by all three terms,
  // producing tool_calls_total:0 for a transcript that genuinely made 1 tool call. The
  // accepted-run-audit sidecar's own summary.tool_calls_total counts every tool_use block via
  // findAllToolUsesWithResults regardless of name, so the old formula also made the record and its
  // own sidecar disagree on an otherwise-unremarkable transcript.
  it('tool_calls_total counts an UNEXPECTED tool_use block (e.g. Read), not just Bash/Skill', () => {
    const events = [
      { type: 'system', subtype: 'init', _receiptNs: 0n },
      { type: 'assistant', _receiptNs: 1_000_000n, message: { content: [{ type: 'tool_use', name: 'Read', id: 'r1', input: { file_path: '/tmp/x' } }] } },
      { type: 'user', _receiptNs: 2_000_000n, message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'ok', is_error: false }] } },
    ];
    const record = buildRunRecord({
      conditionResult: fakeConditionResultWithEvents({ events }),
      ...commonScenarioParams,
      gradeResult: { expectedOutcomeMatched: false, success: false, checks: [], firstUsefulSignalEventIndex: null, testInvocationsTotal: 0, retries: 0 },
    });
    expect(record.tool_calls_total.value).toBe(1);
  });
});

// Section E follow-up correction: selection/promptArtifact/skillSnapshotArtifact are REQUIRED
// buildRunRecord inputs (schema v6) with no default -- but until this test existed, a missing or
// malformed one crashed with an ACCIDENTAL TypeError deep inside agentRuntime/
// executionProfileGroup/skillObservation construction ("Cannot read properties of undefined
// (reading 'runtime')"), never a legible, named contract violation naming which parameter and
// field is wrong. Also closes a real duplication gap: modelRequested was an independent parameter
// with no relationship at all to selection.model.model_id, so a caller could pass two silently
// disagreeing values for "the model" -- now enforced as a hard equality requirement, and
// agent_runtime.model_requested / the legacy top-level model_requested are both written FROM
// selection.model.model_id (the one source of truth), never from the separately-passed parameter.
describe('buildRunRecord -- selection/promptArtifact/skillSnapshotArtifact are required and well-formed; modelRequested must agree with selection.model.model_id', () => {
  function fakeConditionResult() {
    return {
      observation: {
        schema: 1,
        runtime: { id: 'claude-code', protocolVersion: 1 },
        process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 1000n },
        session: { initPresent: true, modelResolved: 'claude-sonnet-5-fake', sessionIdObserved: 'sess-1', runtimeVersion: 'fake', toolProfileMatchesExpected: true },
        transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
        terminal: { present: true, isError: false, turnCount: 1, finalText: 'irrelevant', resultSubtype: 'success', usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
        toolAttempts: [],
        skill: {
          available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
          targetInvocation: null, foreignInvocations: [],
          ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        },
        hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: true },
        byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
        timing: { receiptNsByEventIndex: new Map() },
      },
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
    };
  }

  function realSelection() {
    const result = resolveSelection({});
    expect(result.ok).toBe(true);
    return result.selection;
  }

  function baseParams(overrides = {}) {
    const selection = overrides.selection ?? realSelection();
    return {
      conditionResult: fakeConditionResult(), condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-selection-contract',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      modelRequested: selection.model.model_id,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      selection,
      promptArtifact: { prompt_sha256: 'b'.repeat(64), prompt_bytes: 1 },
      skillSnapshotArtifact: { snapshot_sha256: 'c'.repeat(64), snapshot_bytes: 1, snapshot_file_count: 1 },
      ...overrides,
    };
  }

  it('a well-formed call with modelRequested === selection.model.model_id succeeds, and both model_requested fields are written from selection.model.model_id', () => {
    const selection = realSelection();
    const record = buildRunRecord(baseParams({ selection, modelRequested: selection.model.model_id }));
    expect(record.model_requested).toBe(selection.model.model_id);
    expect(record.agent_runtime.model_requested).toBe(selection.model.model_id);
  });

  it('a missing selection throws a named contract error, never the accidental deep-dereference TypeError', () => {
    const params = baseParams();
    delete params.selection;
    expect(() => buildRunRecord(params)).toThrow(/selection is required and must be a well-formed resolveSelection\(\) result/);
  });

  it('a malformed selection (missing selection.model.model_id) throws the same named contract error', () => {
    const selection = realSelection();
    const params = baseParams({ selection: { ...selection, model: { ...selection.model, model_id: undefined } } });
    expect(() => buildRunRecord(params)).toThrow(/selection is required and must be a well-formed resolveSelection\(\) result/);
  });

  it('a missing promptArtifact throws a named contract error', () => {
    const params = baseParams();
    delete params.promptArtifact;
    expect(() => buildRunRecord(params)).toThrow(/promptArtifact is required and must be a well-formed computePromptArtifact\(\) result/);
  });

  it('a malformed promptArtifact (non-integer prompt_bytes) throws the same named contract error', () => {
    const params = baseParams({ promptArtifact: { prompt_sha256: 'b'.repeat(64), prompt_bytes: 'not-a-number' } });
    expect(() => buildRunRecord(params)).toThrow(/promptArtifact is required and must be a well-formed computePromptArtifact\(\) result/);
  });

  it('a missing skillSnapshotArtifact throws a named contract error', () => {
    const params = baseParams();
    delete params.skillSnapshotArtifact;
    expect(() => buildRunRecord(params)).toThrow(/skillSnapshotArtifact is required and must be a well-formed computeSkillSnapshotArtifact\(\) result/);
  });

  it('a malformed skillSnapshotArtifact (missing snapshot_file_count) throws the same named contract error', () => {
    const params = baseParams({ skillSnapshotArtifact: { snapshot_sha256: 'c'.repeat(64), snapshot_bytes: 1, snapshot_file_count: undefined } });
    expect(() => buildRunRecord(params)).toThrow(/skillSnapshotArtifact is required and must be a well-formed computeSkillSnapshotArtifact\(\) result/);
  });

  it('a modelRequested that disagrees with selection.model.model_id throws closed -- never silently records the caller\'s mismatched value', () => {
    const selection = realSelection();
    const params = baseParams({ selection, modelRequested: 'some-other-model-the-caller-mistakenly-typed' });
    expect(() => buildRunRecord(params)).toThrow(/modelRequested .* must exactly equal selection\.model\.model_id/);
  });

  it('records product_access_mode explicitly, defaulting legacy no-skill callers to product-visible-no-skill', () => {
    const record = buildRunRecord(baseParams());
    expect(record.product_access_mode).toBe('product-visible-no-skill');
  });

  it('preserves a caller-supplied free-baseline-no-product mode for no-skill campaign cells', () => {
    const record = buildRunRecord(baseParams({ productAccessMode: 'free-baseline-no-product' }));
    expect(record.product_access_mode).toBe('free-baseline-no-product');
  });

  it('rejects a product_access_mode incompatible with condition before writing an incoherent record', () => {
    expect(() => buildRunRecord(baseParams({ productAccessMode: 'product-assisted' }))).toThrow(/productAccessMode .* is not compatible with condition/);
  });
});

// Review finding 3: a hard-gate rejection must ALWAYS take precedence over accepted-audit-sidecar
// processing -- no sidecar build/finalization/cross-validation failure may suppress the gate's own
// reason or prevent writeRejectedRunDiagnostics. Accepted-audit work belongs only on the
// gate-PASSING path (a sidecar audits an ACCEPTED run by definition). These are targeted unit
// tests directly against finalizeAndWriteMatrixRecords with a fully-controlled synthetic
// hardGateFn -- independent of whatever a REAL scenarioHardGate rejection looks like, and fast
// (no subprocess).
describe('finalizeAndWriteMatrixRecords -- gate rejection precedence over sidecar processing', () => {
  function minimalScenarioRecord(overrides = {}) {
    return {
      run_id: overrides.run_id ?? 'scenario-current-skill-syn0001',
      run_kind: 'scenario',
      schema: LATEST_RUN_SCHEMA,
      condition: 'current-skill',
      repetition_index: 0,
      order_index: 0,
      policy_sha256: computePolicySha256(),
      accepted_audit: null,
      errors: [],
      grading_checks: { value: null, reason: 'not graded in this synthetic fixture' },
      success: { value: null, reason: null },
      expected_outcome_matched: { value: null, reason: null },
      // Evidence1 success-recovery PR B (schema v8): required (non-null) for every
      // run_kind:scenario record -- this fixture predates that requirement.
      outcome_assessment: {
        schema: 1, task_outcome_matched: null, task_outcome_reason: 'ground-truth-unavailable',
        answer_protocol_matched: false, provider_evidence_kind: 'none', provider_evidence_status: 'unavailable',
        product_e2e_success: null,
      },
      foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
      ambient_skill_profile: { count: 0, scope_id: '00000000-0000-4000-8000-000000000000', fingerprint_hmac: '0'.repeat(64) },
      // Only actually needed by buildRejectionDiagnostics's own (narrower) rejection-record schema
      // -- exercised when the gate rejects this synthetic matrix.
      model_requested: 'fake-model', repo_commit: 'c'.repeat(40), scenario_id: 'test-gate-precedence',
      platform: 'linux', privacy_status: 'public', project_alias: 'test-gate-precedence-project',
      project_commit: 'd'.repeat(40), seed: 1,
      skill_source_sha: overrides.condition === 'no-skill' ? null : 'a'.repeat(40),
      model_resolved: 'claude-sonnet-5-fake', claude_code_version: '1.2.3-fake',
      ...overrides,
    };
  }

  // Matches the canonical minimal condition-observation-v1 shape (see e.g.
  // agentic-eval-graders.test.js's own baseObservation helper) -- finalizeAndWriteMatrixRecords now
  // reads conditionResults[i].observation exclusively, never a raw provider event.
  function minimalObservation() {
    return {
      schema: 1,
      runtime: { id: 'claude-code', protocolVersion: 1 },
      process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 1000n },
      session: { initPresent: true, modelResolved: 'claude-sonnet-5-fake', sessionIdObserved: 'sess-1', runtimeVersion: 'fake', toolProfileMatchesExpected: true },
      transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
      terminal: { present: true, isError: false, turnCount: 1, finalText: 'irrelevant', resultSubtype: 'success', usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
      toolAttempts: [],
      skill: {
        available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
        targetInvocation: null, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
      },
      hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: true },
      byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
      timing: { receiptNsByEventIndex: new Map() },
    };
  }

  function twoCellMatrix() {
    return [
      minimalScenarioRecord({ run_id: 'scenario-current-skill-syn0001', condition: 'current-skill', order_index: 0 }),
      minimalScenarioRecord({ run_id: 'scenario-no-skill-syn0002', condition: 'no-skill', order_index: 1, skill_source_sha: null }),
    ];
  }

  const rejectingGate = () => ({
    ok: false,
    reason: 'synthetic-gate-rejection:true',
    cellResults: [
      { runId: 'scenario-current-skill-syn0001', failedChecks: ['syntheticCheck'], unexpectedToolUsesCount: 0, unexpectedTools: [] },
      { runId: 'scenario-no-skill-syn0002', failedChecks: [], unexpectedToolUsesCount: 0, unexpectedTools: [] },
    ],
    ambientProfileMatrixOk: true,
  });

  // A sidecar callback that would ALWAYS fail if invoked -- proves it's never even attempted on
  // the reject path (Requirement: "Accepted-audit work belongs only on the gate-passing path").
  const alwaysFailingSidecarBuilder = () => ({ ok: false, reason: 'sidecar builder should never be invoked for a rejected matrix' });

  it('a rejected matrix reports the GATE\'s own reason, never a sidecar failure reason', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aec-gate-precedence-'));
    try {
      const records = twoCellMatrix();
      // cellOrdinal stamped on each -- captureOrdinalByRunId (cli.mjs) now derives from
      // conditionResult.cellOrdinal, never array position (Codex-audit fix, PR #418).
      const conditionResults = [{ observation: minimalObservation(), cellOrdinal: 0 }, { observation: minimalObservation(), cellOrdinal: 1 }];
      const result = await finalizeAndWriteMatrixRecords({
        runKind: 'scenario', records, conditionResults, hardGateFn: rejectingGate,
        repeats: 1, runsRootOverride: dir, buildSidecarsFn: alwaysFailingSidecarBuilder,
        transcriptsByRunId: { 'scenario-current-skill-syn0001': '', 'scenario-no-skill-syn0002': '' },
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('synthetic-gate-rejection:true');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a rejected matrix still writes rejection diagnostics despite a sidecar builder that would fail', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aec-gate-precedence-diag-'));
    try {
      const records = twoCellMatrix();
      // cellOrdinal stamped on each -- captureOrdinalByRunId (cli.mjs) now derives from
      // conditionResult.cellOrdinal, never array position (Codex-audit fix, PR #418).
      const conditionResults = [{ observation: minimalObservation(), cellOrdinal: 0 }, { observation: minimalObservation(), cellOrdinal: 1 }];
      const result = await finalizeAndWriteMatrixRecords({
        runKind: 'scenario', records, conditionResults, hardGateFn: rejectingGate,
        repeats: 1, runsRootOverride: dir, buildSidecarsFn: alwaysFailingSidecarBuilder,
        transcriptsByRunId: { 'scenario-current-skill-syn0001': '', 'scenario-no-skill-syn0002': '' },
      });
      expect(result.diagnosticsWriteError).toBeFalsy();
      expect(typeof result.rejectionId).toBe('string');
      expect(typeof result.diagnosticsRelativePath).toBe('string');
      expect(existsSync(path.join(dir, result.diagnosticsRelativePath))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Codex round 2, Finding 3's pre-redaction validation pass (finalizeAndWriteMatrixRecords) now
  // runs BEFORE this test's own target code path (the sidecar-builder-failure branch, only
  // reachable once the gate ACCEPTS) -- minimalScenarioRecord is deliberately incomplete (its own
  // comment: "only actually needed by buildRejectionDiagnostics's own narrower rejection-record
  // schema"), which is fine for the 2 sibling tests above (both use rejectingGate, returning
  // BEFORE pre-redaction validation is ever reached) but not for this one, which needs a genuinely
  // schema-complete pair to exercise the ACCEPTING path at all. Built via the real buildRunRecord +
  // TEST_RUN_RECORD_V6_INPUTS seam, matching the sibling "provenance-bound field redacted" describe
  // block's own realV6ScenarioRecord pattern -- not shared across describe blocks (this file's own
  // established convention), so duplicated locally rather than hoisted.
  function completeScenarioMatrix() {
    const shared = {
      runKind: 'scenario', daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      projectAlias: 'test-gate-precedence-project', projectCommit: 'd'.repeat(40), projectUrl: null,
      family: 'test-only', privacyStatus: 'public', seed: 1, repetitionIndex: 0,
      gradeResult: {
        expectedOutcomeMatched: false, success: false, firstUsefulSignalEventIndex: null,
        testInvocationsTotal: 0, retries: 0, harnessEvidenceAmbiguous: false,
        checks: GRADING_CHECK_NAMES.map((name) => ({ name, passed: true, detail: 'synthetic', evidence_event_indices: [] })),
        // Required for a schema:8 run_kind:scenario record -- this fixture predates that
        // requirement; value is arbitrary (this test only exercises gate-vs-sidecar precedence).
        outcomeAssessment: {
          schema: 1, task_outcome_matched: null, task_outcome_reason: 'ground-truth-unavailable',
          answer_protocol_matched: false, provider_evidence_kind: 'none', provider_evidence_status: 'unavailable',
          product_e2e_success: null,
        },
      },
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      ...TEST_RUN_RECORD_V6_INPUTS,
    };
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const endedAt = new Date('2026-01-01T00:00:01.000Z');
    return [
      buildRunRecord({
        ...shared, conditionResult: { observation: minimalObservation(), startedAt, endedAt, cellOrdinal: 0 },
        condition: 'current-skill', scenarioId: 'test-gate-precedence', skillSourceSha: 'a'.repeat(40), orderIndex: 0,
      }),
      buildRunRecord({
        ...shared, conditionResult: { observation: minimalObservation(), startedAt, endedAt, cellOrdinal: 1 },
        condition: 'no-skill', scenarioId: 'test-gate-precedence', skillSourceSha: null, orderIndex: 1,
      }),
    ];
  }

  it('an ACCEPTED matrix promotes NOTHING when the sidecar builder fails, and reports why', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aec-gate-precedence-accept-fail-'));
    try {
      const records = completeScenarioMatrix();
      // cellOrdinal stamped on each -- captureOrdinalByRunId (cli.mjs) now derives from
      // conditionResult.cellOrdinal, never array position (Codex-audit fix, PR #418).
      const conditionResults = [{ observation: minimalObservation(), cellOrdinal: 0 }, { observation: minimalObservation(), cellOrdinal: 1 }];
      const acceptingGate = () => ({ ok: true, reason: null, cellResults: [], ambientProfileMatrixOk: true });
      const result = await finalizeAndWriteMatrixRecords({
        runKind: 'scenario', records, conditionResults, hardGateFn: acceptingGate,
        repeats: 1, runsRootOverride: dir, buildSidecarsFn: alwaysFailingSidecarBuilder,
        transcriptsByRunId: { [records[0].run_id]: '', [records[1].run_id]: '' },
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('sidecar builder should never be invoked for a rejected matrix');
      expect(existsSync(path.join(dir, 'agentic-eval-scenario'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// P1 architectural review: redaction must happen BEFORE the accepted-audit sidecar/provenance is
// built FROM the record, never after -- otherwise a redaction pass that touches a
// RUN_PROVENANCE_PROJECTION_KEYS field (accepted-run-audit.mjs) makes final cross-validation
// structurally impossible to pass (the sidecar's stored hash would forever disagree with a re-read
// of the final, redacted record). Exercised end-to-end against the REAL redaction pipeline
// (privacy.mjs's own PUBLIC_SHAPE_RULES, always active -- no privatePatternsFile needed, and this
// public repo has no lib/redact.mjs private-rule module to load one from anyway) and the REAL
// accepted-run-audit sidecar builder, never mocked.
describe('finalizeAndWriteMatrixRecords -- a provenance-bound field redacted by a real rule still cross-validates (P1 architectural review)', () => {
  // scenario_id deliberately builds a value that matches PUBLIC_SHAPE_RULES' device_serial rule
  // (an 8-15 char uppercase-alphanumeric run containing at least one digit) -- scenario_id is a
  // RUN_PROVENANCE_PROJECTION_KEYS member, exactly the class of field this fix is about. Built via
  // concatenation of two shorter pieces, NEITHER of which alone is long enough or has a digit, so
  // this file's own committed TEXT never contains a contiguous run matching that shape (decouple-
  // audit, tools/decouple-audit.mjs, statically scans committed file text for exactly this
  // pattern -- a spelled-out example value in this very comment would trip it just as the code
  // literal would, so intentionally none appears here or below). The runtime VALUE produced by the
  // concatenation is unchanged and still genuinely matches the rule when the real redaction
  // pipeline scans it.
  const REDACTABLE_SCENARIO_ID = 'DEVICE' + 'SN1234';

  // Matches the canonical minimal condition-observation-v1 shape (mirrors the sibling
  // 'gate rejection precedence' describe block's own identical helper -- not shared across
  // describe blocks in this file's own established convention).
  function minimalObservation() {
    return {
      schema: 1,
      runtime: { id: 'claude-code', protocolVersion: 1 },
      process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: 1000n },
      session: { initPresent: true, modelResolved: 'claude-sonnet-5-fake', sessionIdObserved: 'sess-1', runtimeVersion: 'fake', toolProfileMatchesExpected: true },
      transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
      terminal: { present: true, isError: false, turnCount: 1, finalText: 'irrelevant', resultSubtype: 'success', usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
      toolAttempts: [],
      skill: {
        available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
        targetInvocation: null, foreignInvocations: [],
        ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
      },
      hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: true },
      byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
      timing: { receiptNsByEventIndex: new Map() },
    };
  }

  function fakeConditionResultLocal() {
    return { observation: minimalObservation(), startedAt: new Date('2026-01-01T00:00:00.000Z'), endedAt: new Date('2026-01-01T00:00:01.000Z'), cellOrdinal: 0 };
  }

  const REQUIRED_GRADING_CHECK_NAMES = [
    'no_transcript_structural_issues', 'bash_tool_use_present', 'tool_result_correlated',
    'authoritative_evidence_well_formed', 'authoritative_target_matches_expected',
    'authoritative_outcome_matches_expected', 'no_provider_contradiction', 'final_answer_consistent_with_evidence',
  ];
  function fakeGradeResultLocal(overrides = {}) {
    return {
      expectedOutcomeMatched: false, success: false, firstUsefulSignalEventIndex: null,
      testInvocationsTotal: 0, retries: 0, harnessEvidenceAmbiguous: false,
      checks: REQUIRED_GRADING_CHECK_NAMES.map((name) => ({ name, passed: true, detail: 'synthetic', evidence_event_indices: [] })),
      // Evidence1 success-recovery PR B (schema v8): buildRunRecord now also reads
      // gradeResult.outcomeAssessment -- a real, well-formed stub, consistent with this
      // fixture's own expectedOutcomeMatched:false/success:false defaults.
      outcomeAssessment: {
        schema: 1, task_outcome_matched: null, task_outcome_reason: 'ground-truth-unavailable',
        answer_protocol_matched: false, provider_evidence_kind: 'none', provider_evidence_status: 'unavailable',
        product_e2e_success: null,
      },
      ...overrides,
    };
  }

  // Real buildRunRecord + the real resolveSelection() seam (TEST_RUN_RECORD_V6_INPUTS), never a
  // hand-rolled 60-field object -- constructing a full v6 record by hand proved too error-prone at
  // this scale (a first attempt was missing over 20 required fields before this rewrite).
  function realV6ScenarioRecord(overrides = {}) {
    const condition = overrides.condition ?? 'current-skill';
    const conditionResult = overrides.conditionResult ?? { ...fakeConditionResultLocal(), cellOrdinal: overrides.orderIndex ?? 0 };
    return buildRunRecord({
      conditionResult, condition, runKind: 'scenario',
      scenarioId: overrides.scenarioId ?? REDACTABLE_SCENARIO_ID,
      skillSourceSha: condition === 'no-skill' ? null : PINNED_SKILL_SHA_LOCAL,
      daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      projectAlias: 'test-redact-order-project', projectCommit: 'd'.repeat(40), projectUrl: null, family: 'test-only',
      privacyStatus: 'public', seed: 1, orderIndex: overrides.orderIndex ?? 0, repetitionIndex: 0,
      gradeResult: fakeGradeResultLocal(), ambientProfileScopeId: '00000000-0000-4000-8000-000000000000',
      ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      ...TEST_RUN_RECORD_V6_INPUTS,
      ...overrides,
    });
  }
  const PINNED_SKILL_SHA_LOCAL = '0'.repeat(40);

  it('a scenario_id redacted by a PUBLIC_SHAPE_RULES rule still produces a record and sidecar that cross-validate successfully, and the actually-written record carries the redacted value', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aec-redact-order-'));
    try {
      const records = [
        realV6ScenarioRecord({ condition: 'current-skill', orderIndex: 0 }),
        realV6ScenarioRecord({ condition: 'no-skill', orderIndex: 1 }),
      ];
      const conditionResults = [fakeConditionResultLocal(), { ...fakeConditionResultLocal(), cellOrdinal: 1 }];
      const acceptingGate = () => ({ ok: true, reason: null, cellResults: [], ambientProfileMatrixOk: true });
      // Evidence1 success-recovery PR B (schema v10): a schema:8 record's sidecar always requires a
      // real terminal_evidence object (self-describing in both policy modes) -- this fixture's own
      // record produced no terminal signal at all, so the honest "absent" shape is the correct one.
      const absentTerminalEvidence = {
        present: false, provider: null, tool_result_event_index: null,
        evidence_well_formed: false, target_matches_expected: null, outcome_matches_expected: null,
        malformed: null, parallel_evidence_invalid: null, changed_evidence_invalid: null,
        observed_result: null,
        final_answer_block: {
          found: false, parsed: false, ambiguous: false, matches_observed: false,
          comparison_status: 'no-final-text', declared_outcome_kind: null, observed_outcome_kind: null,
          missing_fields: [], mismatch_fields: [], unexpected_key_count: 0,
        },
        coverage_gate_diagnostic: 'no-terminal-evidence', coverage_gate_attempts: [],
      };
      const buildSidecarsFn = async (recs, condResults) => {
        const texts = [];
        for (const [i, record] of recs.entries()) {
          const built = buildAcceptedRunAuditSidecar({ record, conditionResult: condResults[i], terminalAuthoritativeEventIndex: null, terminalEvidence: absentTerminalEvidence });
          const finalized = finalizeAcceptedRunAuditSidecar(built, { privatePatternsFile: null });
          if (!finalized.ok) return { ok: false, reason: finalized.reason };
          record.accepted_audit = { schema: built.schema, relative_path: acceptedAuditRelativePathFor(record.run_id), sha256: finalized.sha256 };
          texts.push(finalized.redactedText);
        }
        return { ok: true, sidecarTexts: texts };
      };
      const result = await finalizeAndWriteMatrixRecords({
        runKind: 'scenario', records, conditionResults, hardGateFn: acceptingGate,
        repeats: 1, runsRootOverride: dir, buildSidecarsFn,
        transcriptsByRunId: { [records[0].run_id]: 'raw A', [records[1].run_id]: 'raw B' },
      });
      expect(result.ok, result.reason).toBe(true);
      for (const record of result.redactedRecords) {
        expect(record.scenario_id).toBe('<DEVICE_SERIAL>');
        expect(record.scenario_id).not.toBe(REDACTABLE_SCENARIO_ID);
      }
      // Codex round 2, Finding 2/test C: the RETURNED redactedRecords object is not proof enough
      // that the file actually on disk matches -- re-read record + sidecar from disk (through the
      // exact same trusted-input gate cmdValidate/cmdAggregate use) and validate the pair that was
      // REALLY written, not the in-memory object this function happens to return.
      for (const record of result.redactedRecords) {
        const runPath = path.join(dir, 'agentic-eval-scenario', `${record.run_id}.json`);
        const onDisk = validateRunRecordFile(runPath);
        expect(onDisk.errors, JSON.stringify(onDisk.errors)).toEqual([]);
        expect(onDisk.record.scenario_id).toBe('<DEVICE_SERIAL>');
        expect(onDisk.sidecar).not.toBeNull();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Codex round 2, Finding 3: validation was only ever run on the REDACTED record -- a private
  // rule that happens to transform an invalid enum value into a VALID one would silently launder
  // a producer defect through redaction, promoting a record that claims a state the producer
  // never actually generated. Pre-redaction validation on the ORIGINAL records must catch this
  // BEFORE redaction ever runs, and buildSidecarsFn must never be reached.
  it('an invalid record whose bad field a private rule would coincidentally launder into a valid value fails BEFORE redaction -- buildSidecarsFn is never invoked (Codex round 2, Finding 3)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aec-prevalidate-'));
    const privatePatternsFile = path.join(dir, '.private-patterns.json');
    try {
      // platform is a simple, isolated top-level enum (PLATFORM_VALUES, schemas.mjs) with no
      // cross-field coupling elsewhere in the schema -- chosen specifically so the ONLY defect is
      // the invalid enum value itself, not an incidental cascade from some OTHER field.
      const INVALID_PLATFORM = 'not-a-real-platform';
      writeFileSync(privatePatternsFile, JSON.stringify([
        { class: 'test_enum_launder', literal: INVALID_PLATFORM, replacement: 'windows' },
      ]));
      // A genuine current-skill/no-skill PAIR -- repeats:1 requires exactly 2 records
      // (findMatrixCompletenessGap), matching the existing positive test's own fixture shape; a
      // single record would reject at the completeness gate BEFORE ever reaching redaction, never
      // actually exercising the code path this test targets.
      //
      // platform is NOT a buildRunRecord input parameter -- buildRunRecord hardcodes it internally
      // via resolvePlatform() (cli.mjs), silently ignoring any `platform` key passed to it. The
      // corruption is applied by spreading onto the RETURNED record directly instead.
      const records = [
        realV6ScenarioRecord({ condition: 'current-skill', orderIndex: 0 }),
        { ...realV6ScenarioRecord({ condition: 'no-skill', orderIndex: 1 }), platform: INVALID_PLATFORM },
      ];
      const conditionResults = [fakeConditionResultLocal(), { ...fakeConditionResultLocal(), cellOrdinal: 1 }];
      const acceptingGate = () => ({ ok: true, reason: null, cellResults: [], ambientProfileMatrixOk: true });
      let sidecarBuildCalls = 0;
      const spySidecarsFn = async (recs) => {
        sidecarBuildCalls += 1;
        return { ok: true, sidecarTexts: recs.map(() => '{}') };
      };
      const result = await finalizeAndWriteMatrixRecords({
        runKind: 'scenario', records, conditionResults, hardGateFn: acceptingGate,
        repeats: 1, runsRootOverride: dir, buildSidecarsFn: spySidecarsFn, privatePatternsFile,
        transcriptsByRunId: { [records[0].run_id]: 'raw A', [records[1].run_id]: 'raw B' },
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/platform/);
      expect(sidecarBuildCalls).toBe(0);
      for (const record of records) {
        expect(existsSync(path.join(dir, 'agentic-eval-scenario', `${record.run_id}.json`))).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Codex round 2, Finding 2: the second redaction pass (after buildSidecarsFn attaches
  // accepted_audit) previously kept the freshly-redacted TEXT but discarded the freshly-redacted
  // OBJECT, so downstream validation/cross-validation ran against the STALE, pre-second-pass
  // object while the STALE object's own accepted_audit.relative_path still happened to match the
  // canonical path -- even though the text actually about to be written to disk carries a
  // DIFFERENT (tampered) value. A private rule targeting accepted_audit.relative_path's own
  // literal value (only ever present starting the second pass, once buildSidecarsFn has attached
  // it) reproduces exactly that divergence.
  it('a private rule that retargets accepted_audit.relative_path fails closed and writes zero evidence -- never validates one object while persisting a different one (Codex round 2, Finding 2)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aec-relpath-tamper-'));
    const privatePatternsFile = path.join(dir, '.private-patterns.json');
    try {
      // A genuine current-skill/no-skill PAIR -- see the sibling Finding-3 test above for why a
      // single record would never reach the code path this test targets.
      const records = [
        realV6ScenarioRecord({ condition: 'current-skill', orderIndex: 0 }),
        realV6ScenarioRecord({ condition: 'no-skill', orderIndex: 1 }),
      ];
      const [record] = records; // the tampered rule targets only this one -- the other stays clean
      const conditionResults = [fakeConditionResultLocal(), { ...fakeConditionResultLocal(), cellOrdinal: 1 }];
      const acceptingGate = () => ({ ok: true, reason: null, cellResults: [], ambientProfileMatrixOk: true });
      const realRelativePath = acceptedAuditRelativePathFor(record.run_id);
      writeFileSync(privatePatternsFile, JSON.stringify([
        { class: 'test_relpath_tamper', literal: realRelativePath, replacement: 'audit/TAMPERED.json' },
      ]));
      const buildSidecarsFn = async (recs, condResults) => {
        const texts = [];
        for (const [i, rec] of recs.entries()) {
          const built = buildAcceptedRunAuditSidecar({ record: rec, conditionResult: condResults[i], terminalAuthoritativeEventIndex: null });
          const finalized = finalizeAcceptedRunAuditSidecar(built, { privatePatternsFile: null });
          if (!finalized.ok) return { ok: false, reason: finalized.reason };
          rec.accepted_audit = { schema: built.schema, relative_path: acceptedAuditRelativePathFor(rec.run_id), sha256: finalized.sha256 };
          texts.push(finalized.redactedText);
        }
        return { ok: true, sidecarTexts: texts };
      };
      const result = await finalizeAndWriteMatrixRecords({
        runKind: 'scenario', records, conditionResults, hardGateFn: acceptingGate,
        repeats: 1, runsRootOverride: dir, buildSidecarsFn, privatePatternsFile,
        transcriptsByRunId: { [records[0].run_id]: 'raw A', [records[1].run_id]: 'raw B' },
      });
      expect(result.ok).toBe(false);
      // Zero evidence written for EITHER record -- a rejection anywhere in the batch promotes
      // nothing, neither the record, nor its raw transcript, nor the sidecar.
      for (const r of records) {
        expect(existsSync(path.join(dir, 'agentic-eval-scenario', `${r.run_id}.json`))).toBe(false);
        expect(existsSync(path.join(dir, 'agentic-eval-scenario', 'raw', `${r.run_id}.jsonl`))).toBe(false);
        expect(existsSync(path.join(dir, 'agentic-eval-scenario', 'audit', `${r.run_id}.json`))).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// CodeRabbit review finding (PR #417): this guard used to `throw` on a localIntegrityByRunId
// mismatch -- cmdRun calls finalizeAndWriteMatrixRecords inside a try/finally with no catch, so
// the throw escaped uncaught all the way to main(), exiting 2 with a raw stack trace instead of
// this function's own established {ok:false, reason} / RUN FAILED / exit 1 contract. Reproduced
// directly against the pre-fix code (a bare `await` of this call, with the exception surfacing as
// an uncaught rejection rather than a resolved `{ok:false}`) before converting it to a clean
// return, matching every OTHER guard in this same function.
describe('finalizeAndWriteMatrixRecords -- a localIntegrityByRunId mismatch on an incomplete matrix returns {ok:false}, never throws', () => {
  function minimalScenarioRecord(overrides = {}) {
    return {
      run_id: overrides.run_id ?? 'scenario-current-skill-syn0001',
      run_kind: 'scenario', schema: LATEST_RUN_SCHEMA, condition: 'current-skill',
      repetition_index: 0, order_index: 0, policy_sha256: computePolicySha256(),
      accepted_audit: null, errors: [],
      grading_checks: { value: null, reason: 'not graded in this synthetic fixture' },
      success: { value: null, reason: null }, expected_outcome_matched: { value: null, reason: null },
      // Evidence1 success-recovery PR B (schema v8): required (non-null) for every
      // run_kind:scenario record -- this fixture predates that requirement.
      outcome_assessment: {
        schema: 1, task_outcome_matched: null, task_outcome_reason: 'ground-truth-unavailable',
        answer_protocol_matched: false, provider_evidence_kind: 'none', provider_evidence_status: 'unavailable',
        product_e2e_success: null,
      },
      foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
      ambient_skill_profile: { count: 0, scope_id: '00000000-0000-4000-8000-000000000000', fingerprint_hmac: '0'.repeat(64) },
      model_requested: 'fake-model', repo_commit: 'c'.repeat(40), scenario_id: 'test-local-integrity-guard',
      platform: 'linux', privacy_status: 'public', project_alias: 'test-local-integrity-guard-project',
      project_commit: 'd'.repeat(40), seed: 1,
      skill_source_sha: overrides.condition === 'no-skill' ? null : 'a'.repeat(40),
      model_resolved: 'claude-sonnet-5-fake', claude_code_version: '1.2.3-fake',
      ...overrides,
    };
  }
  const neverCalledHardGate = () => { throw new Error('hardGateFn must never be invoked on an incomplete matrix'); };

  it('returns {ok:false, reason} (never throws) when localIntegrityByRunId is missing a required key', async () => {
    const record = minimalScenarioRecord();
    // observation content is irrelevant here -- the localIntegrityByRunId mismatch check (below)
    // returns before this branch ever dereferences conditionResults[i].observation.
    const result = await finalizeAndWriteMatrixRecords({
      runKind: 'scenario', records: [record], conditionResults: [{ observation: {} }],
      hardGateFn: neverCalledHardGate, repeats: 1, matrixComplete: false,
      plannedCellCount: 4, executedCellCount: 1,
      localIntegrityByRunId: {}, // deliberately missing record.run_id's own key
      failFastStop: { reason: 'SIMULATED_LOCAL_FAILURE' },
      transcriptsByRunId: { [record.run_id]: '' },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("localIntegrityByRunId's keys must exactly match records[].run_id");
    expect(result.reason).toContain(record.run_id);
  });

  it('returns {ok:false, reason} (never throws) when localIntegrityByRunId carries an extra/stale key', async () => {
    const record = minimalScenarioRecord();
    const result = await finalizeAndWriteMatrixRecords({
      runKind: 'scenario', records: [record], conditionResults: [{ observation: {} }],
      hardGateFn: neverCalledHardGate, repeats: 1, matrixComplete: false,
      plannedCellCount: 4, executedCellCount: 1,
      localIntegrityByRunId: { [record.run_id]: { failedChecks: [], unexpectedToolUsesCount: 0, unexpectedTools: [] }, 'stale-run-id-from-another-batch': {} },
      failFastStop: { reason: 'SIMULATED_LOCAL_FAILURE' },
      transcriptsByRunId: { [record.run_id]: '' },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("localIntegrityByRunId's keys must exactly match records[].run_id");
    expect(result.reason).toContain('stale-run-id-from-another-batch');
  });

  it('returns {ok:false, reason} (never throws) when localIntegrityByRunId is null entirely', async () => {
    const record = minimalScenarioRecord();
    const result = await finalizeAndWriteMatrixRecords({
      runKind: 'scenario', records: [record], conditionResults: [{ observation: {} }],
      hardGateFn: neverCalledHardGate, repeats: 1, matrixComplete: false,
      plannedCellCount: 4, executedCellCount: 1,
      localIntegrityByRunId: null,
      failFastStop: { reason: 'SIMULATED_LOCAL_FAILURE' },
      transcriptsByRunId: { [record.run_id]: '' },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("localIntegrityByRunId's keys must exactly match records[].run_id");
  });
});

// Review finding 2 (aggregate side): cmdAggregate previously fed every *.json file straight into
// aggregateRuns(), which only ever runs schemas.mjs's validateRun() -- a purely OBJECT-SHAPE check
// of accepted_audit (schema/relative_path regex/sha256 hex format), never a verification that the
// sidecar FILE the record claims actually exists, hashes correctly, or agrees with the record's own
// content. A record with a fabricated (well-formed but fictitious) accepted_audit therefore
// aggregated cleanly with zero errors. cmdAggregate must now offline-validate every top-level run
// file via validateRunRecordFile (record schema + on-disk sidecar) BEFORE handing anything to
// aggregateRuns, excluding and reporting any schema-v5 scenario record whose sidecar is
// missing/malformed/mismatched.
describe('cmdAggregate -- schema-v6 scenario records require a verifiable on-disk sidecar', () => {
  // Matches the canonical minimal condition-observation-v1 shape (see e.g.
  // agentic-eval-graders.test.js's own baseObservation helper) -- buildRunRecord now reads
  // conditionResult.observation exclusively, never a raw provider event. This describe block's
  // `events` param is always empty in practice (every call site below passes `{}`), so
  // toolAttempts stays empty rather than deriving from findAllToolUsesWithResults.
  function fakeConditionResultWithEvents({ events = [] } = {}) {
    return {
      observation: {
        schema: 1,
        runtime: { id: 'claude-code', protocolVersion: 1 },
        process: { exitCode: 0, terminated: false, terminationReason: null, spawnHrtimeNs: 0n, endedHrtimeNs: undefined },
        session: { initPresent: true, modelResolved: 'claude-sonnet-5-fake', sessionIdObserved: 'sess-1', runtimeVersion: 'fake', toolProfileMatchesExpected: true },
        transcript: { malformedLineCount: 0, strictStructuralIssues: [], effectiveStructuralIssues: [], strictIncompleteToolResults: [], effectiveIncompleteToolResults: [] },
        terminal: { present: true, isError: false, turnCount: 1, finalText: 'irrelevant', resultSubtype: 'success', usage: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null } },
        toolAttempts: events.length === 0 ? [] : findAllToolUsesWithResults(events).map((u) => ({
          id: u.id ?? null, kind: u.name === 'Skill' ? 'skill' : u.name === 'Bash' ? 'shell' : 'other',
          runtimeName: u.name ?? null, eventIndex: u.index, receiptNs: typeof u.receiptNs === 'bigint' ? u.receiptNs : null,
          profileAllowed: new Set(['Bash', 'Skill']).has(u.name),
          command: u.name === 'Bash' && typeof u.input?.command === 'string' ? u.input.command : null,
          skillReference: u.name === 'Skill' && typeof u.input?.skill === 'string' ? u.input.skill : null,
          targetsExpectedSkill: null,
          result: { found: u.resultFound, eventIndex: u.resultFound ? u.resultIndex : null, isError: u.resultFound ? u.resultIsError : null, text: typeof u.resultContent === 'string' ? u.resultContent : null, textStatus: !u.resultFound ? 'missing' : (typeof u.resultContent === 'string' ? 'text' : 'unsupported') },
          preDispatchBlock: { recognized: false, signature: null },
        })),
        skill: {
          available: false, profileMatchesCondition: true, snapshotBindingMatches: false,
          targetInvocation: null, foreignInvocations: [],
          ambient: { names: new Set(), structurallyWellFormed: true, targetIdentityOk: true },
        },
        hookStats: { hookCallCount: 0, hookResponseCount: 0, hookDenyCount: 0, hookAllowCount: 0, hookPairingOk: true, everyCallHooked: true },
        byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
        timing: { receiptNsByEventIndex: new Map(events.map((e, i) => [i, e._receiptNs])) },
      },
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
      junitAttribution: { decisionByAttempt: new Map() },
    };
  }

  /** A publicly complete, schema-v6-valid scenario record (built via the real buildRunRecord, not
   * hand-typed) with a FABRICATED accepted_audit -- overriding the null placeholder buildRunRecord
   * itself always leaves. A schema:6 record requires exactly a v3 sidecar pointer (Section E). */
  function completeV5ScenarioRecordWithFabricatedAudit(auditOverrides = {}) {
    const record = buildRunRecord({
      conditionResult: fakeConditionResultWithEvents({}),
      condition: 'no-skill', runKind: 'scenario', scenarioId: 'test-aggregate-sidecar',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [':shared:testAndroidHostTest'], allowedKmpTestSubcommands: ['parallel'],
      policySha256: computePolicySha256(), ...TEST_RUN_RECORD_V6_INPUTS, seed: 1, orderIndex: 0, repetitionIndex: 0,
      projectAlias: 'test-aggregate-project', projectCommit: 'd'.repeat(40), projectUrl: 'https://example.invalid/test-aggregate-project',
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
      gradeResult: {
        expectedOutcomeMatched: true, success: true, checks: GRADING_CHECK_NAMES.map((name) => ({ name, passed: true, detail: 'ok', evidence_event_indices: [] })), firstUsefulSignalEventIndex: null, testInvocationsTotal: 1, retries: 0,
        // Evidence1 success-recovery PR B: buildRunRecord now also reads gradeResult.
        // outcomeAssessment (schema v8) -- a real, well-formed stub, consistent with this
        // fixture's own expectedOutcomeMatched:true/success:true.
        outcomeAssessment: {
          schema: 1, task_outcome_matched: true, task_outcome_reason: 'matched',
          answer_protocol_matched: true, provider_evidence_kind: 'kmp-test-envelope',
          provider_evidence_status: 'matched', product_e2e_success: true,
        },
      },
    });
    record.benchmark_eligible = true;
    // schema v8 (LATEST_RUN_SCHEMA) requires exactly sidecar schema 10 -- was 3 pre-PR-B.
    record.accepted_audit = { schema: 10, relative_path: `audit/${record.run_id}.json`, sha256: '0'.repeat(64), ...auditOverrides };
    return record;
  }

  /** Sanity check the fixture itself: with a REMOVED accepted_audit requirement bypassed (a
   * well-formed, if fabricated, sidecar reference), this record must otherwise aggregate cleanly
   * -- proves any exclusion asserted below is attributable to the sidecar check this describe
   * block exists to test, not some unrelated Fairness-Contract gap in the fixture. withPartitionView
   * mirrors aggregate.mjs's own pipeline exactly: buildAggregateGroup is called directly here
   * (bypassing aggregateRuns), so this helper -- not aggregate.mjs -- is responsible for the same
   * pre-projection a real caller always applies before the 3 new structural partition keys
   * (Section F) are read off the record. */
  function expectFixtureWouldAggregateCleanlyOnItsOwnMerits(record) {
    const { errors: runErrors } = validateRun(record);
    expect(runErrors).toEqual([]);
    const { errors: groupErrors, group } = buildAggregateGroup([withPartitionView(record)]);
    expect(groupErrors).toEqual([]);
    expect(group).not.toBeNull();
  }

  function captureAggregateOutput(dir) {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const exitCode = cmdAggregate({ 'runs-dir': dir });
      const printed = JSON.parse(spy.mock.calls.at(-1)[0]);
      return { exitCode, ...printed };
    } finally {
      spy.mockRestore();
    }
  }

  it('excludes and reports a schema-6 scenario record whose sidecar file does not exist on disk', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aec-aggregate-sidecar-missing-'));
    try {
      const record = completeV5ScenarioRecordWithFabricatedAudit();
      expectFixtureWouldAggregateCleanlyOnItsOwnMerits(record);
      writeFileSync(path.join(dir, `${record.run_id}.json`), JSON.stringify(record));
      // Deliberately no audit/ directory at all.
      const { exitCode, groups, errors } = captureAggregateOutput(dir);
      expect(exitCode).toBe(1);
      expect(errors.some((e) => e.run_id === record.run_id)).toBe(true);
      expect(groups.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('excludes and reports a schema-6 scenario record whose sidecar hash does not match', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aec-aggregate-sidecar-badhash-'));
    try {
      const record = completeV5ScenarioRecordWithFabricatedAudit();
      expectFixtureWouldAggregateCleanlyOnItsOwnMerits(record);
      writeFileSync(path.join(dir, `${record.run_id}.json`), JSON.stringify(record));
      mkdirSync(path.join(dir, 'audit'), { recursive: true });
      // A syntactically-valid but semantically-arbitrary sidecar -- its real SHA-256 will never
      // equal the record's declared (fabricated) '000...0' digest.
      writeFileSync(path.join(dir, 'audit', `${record.run_id}.json`), JSON.stringify({ schema: 1, run_id: record.run_id, run_schema: 5, run_kind: 'scenario', condition: record.condition, scenario_id: record.scenario_id, first_useful_signal_event: null, terminal_authoritative_event: null, tool_calls: [], summary: { tool_calls_total: 0, shell_commands_total: 0, post_signal_ms: null, post_signal_tool_calls: null, policy_denials_total: 0, policy_denials_before_first_signal: null, policy_denials_after_first_signal: null, policy_decisions_missing: 0 } }));
      const { exitCode, groups, errors } = captureAggregateOutput(dir);
      expect(exitCode).toBe(1);
      expect(errors.some((e) => e.run_id === record.run_id)).toBe(true);
      expect(groups.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A second review round found validateRunRecordFile's own top-level readFileSync+JSON.parse was
// itself unguarded -- cmdAggregate calls it directly with no try/catch, so one malformed
// top-level *.json file in --runs-dir threw an uncaught SyntaxError and aborted the WHOLE batch,
// instead of excluding just that file and continuing with its siblings. cmdAggregate also
// re-read and re-parsed every VALID file's JSON a second time (validateRunRecordFile already
// parses it once) -- fixed by having cmdAggregate reuse validateRunRecordFile's own returned
// `record`.
describe('cmdAggregate -- a malformed top-level run file never aborts the batch', () => {
  function captureAggregateOutput(dir) {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const exitCode = cmdAggregate({ 'runs-dir': dir });
      const printed = JSON.parse(spy.mock.calls.at(-1)[0]);
      return { exitCode, ...printed };
    } finally {
      spy.mockRestore();
    }
  }

  it('does not throw, excludes the malformed file, and reports it with run_id:"(unknown)"', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aec-aggregate-malformed-'));
    try {
      writeFileSync(path.join(dir, 'bad.json'), 'not valid json {{{');
      let result;
      expect(() => { result = captureAggregateOutput(dir); }).not.toThrow();
      const { exitCode, errors } = result;
      expect(exitCode).toBe(1);
      expect(errors.some((e) => e.run_id === '(unknown)')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('continues processing a valid sibling file -- it still aggregates while the malformed one is reported separately', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aec-aggregate-malformed-sibling-'));
    try {
      writeFileSync(path.join(dir, 'bad.json'), 'not valid json {{{');
      const validRecord = {
        schema: 1, run_id: 'calibration-no-skill-goodsib01', run_kind: 'calibration', benchmark_eligible: false,
      };
      // A deliberately minimal (schema-invalid) but PARSEABLE sibling -- this test only needs to
      // prove the malformed file doesn't block the sibling from being CONSIDERED (it still shows
      // up in `errors`, keyed by its own real run_id, rather than the batch aborting outright).
      writeFileSync(path.join(dir, 'sib.json'), JSON.stringify(validRecord));
      const { exitCode, errors } = captureAggregateOutput(dir);
      expect(exitCode).toBe(1);
      expect(errors.some((e) => e.run_id === '(unknown)')).toBe(true);
      expect(errors.some((e) => e.run_id === 'calibration-no-skill-goodsib01')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never leaks the absolute path or the malformed file\'s own content in the reported errors', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aec-aggregate-malformed-leak-'));
    try {
      const runPath = path.join(dir, 'bad.json');
      writeFileSync(runPath, 'not valid json {{{ sk-ant-totally-not-a-real-secret-marker');
      const { errors } = captureAggregateOutput(dir);
      const serialized = JSON.stringify(errors);
      expect(serialized).not.toContain(runPath);
      expect(serialized).not.toContain(dir);
      expect(serialized).not.toContain('sk-ant-totally-not-a-real-secret-marker');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses each valid file\'s JSON exactly once -- reuses validateRunRecordFile\'s own returned record', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aec-aggregate-single-parse-'));
    try {
      const validRecord = { schema: 1, run_id: 'calibration-no-skill-onceonly01', run_kind: 'calibration' };
      writeFileSync(path.join(dir, 'once.json'), JSON.stringify(validRecord));
      const parseSpy = vi.spyOn(JSON, 'parse');
      try {
        cmdAggregate({ 'runs-dir': dir });
        // String-level match, deliberately NOT a second JSON.parse call here -- JSON.parse is
        // still spied at this point, and re-invoking it inside this inspection would itself be
        // recorded, corrupting the very call count being measured.
        const parsedThisFile = parseSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].includes('calibration-no-skill-onceonly01'));
        expect(parsedThisFile.length).toBe(1);
      } finally {
        parseSpy.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

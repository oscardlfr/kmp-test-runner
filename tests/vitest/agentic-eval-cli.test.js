// tests/vitest/agentic-eval-cli.test.js
// Unit tests for tools/agentic-eval/cli.mjs's pure helper functions (parseArgs, nullableMetric).
// Real subprocess end-to-end coverage (calibrate/smoke against fake claude) lives in
// agentic-eval-cli-integration.test.js -- this file is for fast, in-process logic that doesn't
// need a child process.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { parseArgs, validateSubcommandArgs, validatePrivatePatternsFileOrFail, resolveMeasurementScopeOrFail, nullableMetric, resolveHarnessProvenance, verifyExactCommandsSucceeded, writeRunRecordEvidence, buildRunRecord, finalizeAndWriteRecords, findBlockingHarnessToolingDirty, isRunsRootDefault, SUBCOMMAND_SHAPES } from '../../tools/agentic-eval/cli.mjs';
import { computePolicySha256 } from '../../tools/agentic-eval/policy-config.mjs';

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
    expect(Object.keys(SUBCOMMAND_SHAPES).sort()).toEqual(['aggregate', 'calibrate', 'corpus', 'run', 'scope', 'smoke', 'validate']);
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
      const badJson = path.join(dir, 'bad.json');
      writeFileSync(badJson, 'not json');
      expect(resolveMeasurementScopeOrFail(badJson).ok).toBe(false);
      const badShape = path.join(dir, 'shape.json');
      writeFileSync(badShape, JSON.stringify({ schema: 1, scope_id: 'nope' }));
      expect(resolveMeasurementScopeOrFail(badShape).ok).toBe(false);
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
      runA: { spawnResult: { rawStdout: '{"raw":"a"}\n' } },
      runB: { spawnResult: { rawStdout: '{"raw":"b"}\n' } },
    };
  }

  it('writes all four files (two records, two raw transcripts) on a clean run', () => {
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aec-evidence-'));
    try {
      const { recordA, recordB, runA, runB } = fixtureRecords();
      const outDir = writeRunRecordEvidence('test-kind', recordA, recordB, runA, runB, '{"redacted":"a"}', '{"redacted":"b"}', runsRoot);
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
      const { recordA, recordB, runA, runB } = fixtureRecords();
      // Force the FOURTH target (raw/test-run-b-0001.jsonl) to fail its rename by pre-creating
      // that exact path as a DIRECTORY -- renameSync can never replace a directory with a file.
      // Targets 1-3 (record A, record B, raw A) rename successfully first, proving the rollback
      // really does undo already-committed work, not just abort before anything happened.
      const outDir = path.join(runsRoot, 'agentic-eval-test-kind');
      const rawDir = path.join(outDir, 'raw');
      mkdirSync(rawDir, { recursive: true });
      mkdirSync(path.join(rawDir, 'test-run-b-0001.jsonl'), { recursive: true });

      expect(() => writeRunRecordEvidence('test-kind', recordA, recordB, runA, runB, '{"redacted":"a"}', '{"redacted":"b"}', runsRoot))
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
      const { recordA, recordB, runA, runB } = fixtureRecords();
      const outDir = path.join(runsRoot, 'agentic-eval-test-kind');
      mkdirSync(outDir, { recursive: true });
      const preExistingPath = path.join(outDir, 'test-run-a-0001.json');
      writeFileSync(preExistingPath, '{"this":"is prior, real evidence -- must survive"}');

      expect(() => writeRunRecordEvidence('test-kind', recordA, recordB, runA, runB, '{"redacted":"a"}', '{"redacted":"b"}', runsRoot))
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
      const { recordA, recordB, runA, runB } = fixtureRecords();
      expect(() => writeRunRecordEvidence('test-kind', recordA, recordB, runA, runB, '{"redacted":"a"}', '{"redacted":"b"}', insideRepoUnignored))
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
      const { recordA, recordB, runA, runB } = fixtureRecords();
      const outDir = writeRunRecordEvidence('test-kind', recordA, recordB, runA, runB, '{"redacted":"a"}', '{"redacted":"b"}', outsideRepo);
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

      const { recordA, recordB, runA, runB } = fixtureRecords();
      expect(() => writeRunRecordEvidence('test-kind', recordA, recordB, runA, runB, '{"redacted":"a"}', '{"redacted":"b"}', otherRepo))
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
  function fakeConditionResult() {
    return {
      init: { model: 'claude-sonnet-5-fake', session_id: 'sess-1', claude_code_version: 'fake', plugins: [], skills: [], tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' },
      result: { subtype: 'success', is_error: false },
      invocation: null,
      hookStats: { hookCallCount: 0, hookDenyCount: 0, everyCallHooked: true, hookAllowCount: 0 },
      byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
      spawnResult: { terminated: false, terminationReason: null, exitCode: 0 },
      events: [],
    };
  }

  it('refuses to write evidence -- and never calls the hard gate at all -- when a record carries a dirty_measured_code error', async () => {
    const policySha256 = computePolicySha256();
    const common = { runKind: 'calibration', scenarioId: 'test-dirty-tree', daemonPolicy: 'disabled-via-gradle-user-home-properties', allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256, modelRequested: 'fake-model', ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex') };
    const recordA = buildRunRecord({ conditionResult: fakeConditionResult(), condition: 'no-skill', skillSourceSha: null, ...common });
    const recordB = buildRunRecord({ conditionResult: fakeConditionResult(), condition: 'current-skill', skillSourceSha: 'c5c0661852f7c9da145ef56892048e706216a6ce', ...common });
    // Simulate what resolveHarnessProvenance() would have populated for a genuinely dirty
    // bin/lib/scripts tree -- see cli.mjs's own buildRunRecord for the real construction.
    recordA.errors = [{ code: 'dirty_measured_code', message: 'bin/kmp-test.js has uncommitted local modifications' }];
    recordB.errors = [{ code: 'dirty_measured_code', message: 'bin/kmp-test.js has uncommitted local modifications' }];

    let hardGateCalled = false;
    const result = await finalizeAndWriteRecords({
      runKind: 'calibration', recordA, recordB,
      runA: { spawnResult: { rawStdout: '' } },
      runB: { spawnResult: { rawStdout: '' } },
      hardGateFn: () => { hardGateCalled = true; return { ok: true, reason: null }; },
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
    const common = { runKind: 'calibration', scenarioId: 'test-dirty-tooling', daemonPolicy: 'disabled-via-gradle-user-home-properties', allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256, modelRequested: 'fake-model', ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex') };
    const recordA = buildRunRecord({ conditionResult: fakeConditionResult(), condition: 'no-skill', skillSourceSha: null, ...common });
    const recordB = buildRunRecord({ conditionResult: fakeConditionResult(), condition: 'current-skill', skillSourceSha: 'c5c0661852f7c9da145ef56892048e706216a6ce', ...common });
    recordA.errors = [{ code: 'dirty_harness_tooling', message: 'tools/agentic-eval/cli.mjs has uncommitted local modifications' }];
    recordB.errors = [{ code: 'dirty_harness_tooling', message: 'tools/agentic-eval/cli.mjs has uncommitted local modifications' }];

    let hardGateCalled = false;
    const result = await finalizeAndWriteRecords({
      runKind: 'calibration', recordA, recordB,
      runA: { spawnResult: { rawStdout: '' } },
      runB: { spawnResult: { rawStdout: '' } },
      hardGateFn: () => { hardGateCalled = true; return { ok: false, reason: 'stubbed gate rejection -- test never intends to reach a real write' }; },
    });
    expect(hardGateCalled).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unclean harness-tooling tree');
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
      init: { model: 'claude-sonnet-5-fake', session_id: 'sess-1', claude_code_version: 'fake', plugins: [], skills: [], tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' },
      result: { subtype: 'success', is_error: false },
      invocation: null,
      hookStats: { hookCallCount: 0, hookDenyCount: 0, everyCallHooked: true, hookAllowCount: 0 },
      byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
      spawnResult: { terminated: false, terminationReason: null, exitCode: 0 },
      events: [],
    };
    const record = buildRunRecord({
      conditionResult, condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-default-root',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      modelRequested: 'fake-model',
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
      init: { model: 'claude-sonnet-5-fake', session_id: 'sess-1', claude_code_version: 'fake', plugins: [], skills: [], tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' },
      result: { subtype: 'success', is_error: false },
      invocation: null,
      hookStats: { hookCallCount: 0, hookDenyCount: 0, everyCallHooked: true, hookAllowCount: 0 },
      byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
      spawnResult: { terminated: false, terminationReason: null, exitCode: 0 },
      events: [],
    };
  }

  it('reports retries as null with a runKind-specific reason for a calibration run', () => {
    const record = buildRunRecord({
      conditionResult: fakeConditionResult(), condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-retries-calibration',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      modelRequested: 'fake-model',
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    expect(record.retries).toEqual({ value: null, reason: 'not tracked for calibration runs' });
  });

  it('reports retries as null with a runKind-specific reason for a smoke run', () => {
    const record = buildRunRecord({
      conditionResult: fakeConditionResult(), condition: 'no-skill', runKind: 'smoke', scenarioId: 'test-retries-smoke',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      modelRequested: 'fake-model',
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    expect(record.retries).toEqual({ value: null, reason: 'not tracked for smoke runs' });
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
      init: { model: 'claude-sonnet-5-fake', session_id: 'sess-1', claude_code_version: 'fake', plugins: [], skills: [], tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' },
      result: { subtype: 'success', is_error: false },
      invocation: null,
      hookStats: { hookCallCount: 1, hookDenyCount: 0, everyCallHooked: true, hookAllowCount: 1 },
      byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
      spawnResult: { terminated: false, terminationReason: null, exitCode: 0 },
      events: [],
    };
  }
  function fakeGradeResult(overrides = {}) {
    return {
      expectedOutcomeMatched: false, success: false,
      checks: [], firstUsefulSignalEventIndex: null,
      testInvocationsTotal: 2, retries: 1,
      harnessEvidenceAmbiguous: false,
      parallelEvidenceMalformed: false,
      gradleJunitEvidenceUnreliable: false,
      ...overrides,
    };
  }

  it('a gradeResult with harnessEvidenceAmbiguous:true produces an ambiguous_junit_evidence error entry', () => {
    const record = buildRunRecord({
      conditionResult: fakeScenarioConditionResult(), condition: 'no-skill', runKind: 'scenario', scenarioId: 'test-ambiguous-junit',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [':shared:testAndroidHostTest'], allowedKmpTestSubcommands: ['parallel'], policySha256: computePolicySha256(),
      modelRequested: 'fake-model', seed: 1, orderIndex: 0, repetitionIndex: 0,
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
      modelRequested: 'fake-model', seed: 1, orderIndex: 0, repetitionIndex: 0,
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
      modelRequested: 'fake-model',
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
      modelRequested: 'fake-model', seed: 1, orderIndex: 0, repetitionIndex: 0,
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
      modelRequested: 'fake-model', seed: 1, orderIndex: 0, repetitionIndex: 0,
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
      modelRequested: 'fake-model',
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    expect(record.errors.some((e) => e.code === 'malformed_parallel_evidence')).toBe(false);
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
      modelRequested: 'fake-model', seed: 1, orderIndex: 0, repetitionIndex: 0,
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
      modelRequested: 'fake-model', seed: 1, orderIndex: 0, repetitionIndex: 0,
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
      modelRequested: 'fake-model',
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
      modelRequested: 'fake-model', seed: 1, orderIndex: 0, repetitionIndex: 0,
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
      modelRequested: 'fake-model', seed: 1, orderIndex: 0, repetitionIndex: 0,
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
      modelRequested: 'fake-model',
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
      modelRequested: 'fake-model', seed: 1, orderIndex: 0, repetitionIndex: 0,
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

  it('sums N real Bash tool_use events plus a multi-attempt invocation.attemptCount, not a flat 0-or-1', () => {
    const conditionResult = {
      init: { model: 'claude-sonnet-5-fake', session_id: 'sess-1', claude_code_version: 'fake', plugins: [{ name: 'kmp-test-runner', path: '/fake', source: 'fake' }], tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' },
      result: { subtype: 'success', is_error: false },
      // Simulates what findSkillInvocation() itself would return for 2 real Skill attempts
      // (e.g. a failed-then-retried-successful invocation) -- attemptCount:2, not 1.
      invocation: { attempted: true, confirmed: true, attemptCount: 2, type: 'assistant.tool_use.Skill', index: 0, receiptNs: 0n, input: { skill: 'kmp-test-runner' }, resultIsError: false },
      hookStats: { hookCallCount: 3, hookDenyCount: 0, everyCallHooked: true, hookAllowCount: 3 },
      byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
      spawnResult: { terminated: false, terminationReason: null, exitCode: 0 },
      events: [bashToolUseEvent('toolu_1'), bashToolUseEvent('toolu_2'), bashToolUseEvent('toolu_3')],
    };
    const record = buildRunRecord({
      conditionResult, condition: 'current-skill', runKind: 'calibration', scenarioId: 'test-tool-calls-total',
      skillSourceSha: 'aeba6eaa8d027be999cdfeeb5bb2d1bbd0f688ee', daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      modelRequested: 'fake-model',
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    // 3 real Bash tool_use events + attemptCount:2 (NOT the old flat +1) = 5, not 4.
    expect(record.tool_calls_total).toEqual({ value: 5, reason: null });
    expect(record.shell_commands_total).toEqual({ value: 3, reason: null });
  });

  it('falls back to 0 for the Skill contribution when invocation is null (no attempt at all)', () => {
    const conditionResult = {
      init: { model: 'claude-sonnet-5-fake', session_id: 'sess-1', claude_code_version: 'fake', plugins: [], skills: [], tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' },
      result: { subtype: 'success', is_error: false },
      invocation: null,
      hookStats: { hookCallCount: 1, hookDenyCount: 0, everyCallHooked: true, hookAllowCount: 1 },
      byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
      spawnResult: { terminated: false, terminationReason: null, exitCode: 0 },
      events: [bashToolUseEvent('toolu_1')],
    };
    const record = buildRunRecord({
      conditionResult, condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-tool-calls-total-no-invocation',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      modelRequested: 'fake-model',
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
  it('adds foreignSkillUses.length to the total -- a foreign Skill attempt is no longer silently uncounted', () => {
    const conditionResult = {
      init: { model: 'claude-sonnet-5-fake', session_id: 'sess-1', claude_code_version: 'fake', plugins: [{ name: 'kmp-test-runner', path: '/fake', source: 'fake' }], tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' },
      result: { subtype: 'success', is_error: false },
      invocation: { attempted: true, confirmed: true, attemptCount: 1, type: 'assistant.tool_use.Skill', index: 0, receiptNs: 0n, input: { skill: 'kmp-test-runner' }, resultIsError: false },
      hookStats: { hookCallCount: 0, hookDenyCount: 0, everyCallHooked: true, hookAllowCount: 0 },
      byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
      spawnResult: { terminated: false, terminationReason: null, exitCode: 0 },
      events: [
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', id: 'toolu_foreign1', input: { skill: 'totally-unrelated-skill' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_foreign1', is_error: true, content: '<tool_use_error>Unknown skill: totally-unrelated-skill</tool_use_error>' }] } },
      ],
    };
    const record = buildRunRecord({
      conditionResult, condition: 'current-skill', runKind: 'calibration', scenarioId: 'test-tool-calls-total-foreign-skill',
      skillSourceSha: 'aeba6eaa8d027be999cdfeeb5bb2d1bbd0f688ee', daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      modelRequested: 'fake-model',
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });
    // 0 Bash + 1 expected-skill attempt + 1 foreign-skill attempt = 2, not the pre-fix 1.
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
        init: { model: 'claude-sonnet-5-fake', session_id: 'sess-1', claude_code_version: 'fake', plugins: [], skills: [], tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' },
        result: { subtype: 'success', is_error: false },
        invocation: null,
        hookStats: { hookCallCount: 0, hookDenyCount: 0, everyCallHooked: true, hookAllowCount: 0 },
        byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        endedAt: new Date('2026-01-01T00:00:01.000Z'),
        spawnResult: { terminated: false, terminationReason: null, exitCode: 0 },
        events: [],
      };
    }
    const policySha256 = computePolicySha256();
    const common = { runKind: 'calibration', scenarioId: 'test-collision-via-finalize', daemonPolicy: 'disabled-via-gradle-user-home-properties', allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256, modelRequested: 'fake-model', ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex') };
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
          runA: { spawnResult: { rawStdout: '' } },
          runB: { spawnResult: { rawStdout: '' } },
          hardGateFn: () => ({ ok: true, reason: null }),
          runsRootOverride: runsRoot,
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

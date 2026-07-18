// tests/vitest/agentic-eval-cli.test.js
// Unit tests for tools/agentic-eval/cli.mjs's pure helper functions (parseArgs, nullableMetric).
// Real subprocess end-to-end coverage (calibrate/smoke against fake claude) lives in
// agentic-eval-cli-integration.test.js -- this file is for fast, in-process logic that doesn't
// need a child process.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { parseArgs, validateSubcommandArgs, validatePrivatePatternsFileOrFail, nullableMetric, resolveHarnessProvenance, verifyExactCommandsSucceeded, writeRunRecordEvidence, SUBCOMMAND_SHAPES } from '../../tools/agentic-eval/cli.mjs';

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
    expect(Object.keys(SUBCOMMAND_SHAPES).sort()).toEqual(['aggregate', 'calibrate', 'corpus', 'smoke', 'validate']);
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
});

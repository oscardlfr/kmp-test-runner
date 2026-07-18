// tests/vitest/agentic-eval-cli.test.js
// Unit tests for tools/agentic-eval/cli.mjs's pure helper functions (parseArgs, nullableMetric).
// Real subprocess end-to-end coverage (calibrate/smoke against fake claude) lives in
// agentic-eval-cli-integration.test.js -- this file is for fast, in-process logic that doesn't
// need a child process.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, nullableMetric, resolveHarnessProvenance, verifyExactCommandsSucceeded } from '../../tools/agentic-eval/cli.mjs';

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

  it('positional arguments are collected into _', () => {
    const args = parseArgs(['corpus', 'validate']);
    expect(args._).toEqual(['corpus', 'validate']);
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

describe('verifyExactCommandsSucceeded', () => {
  const DOCTOR_DESCRIBE = [/kmp-test\s+doctor\b/, /kmp-test\s+describe\b/];

  it('passes when every expected pattern has a correlated, non-error result', () => {
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

  it('one command run twice does not satisfy two distinct expected patterns', () => {
    const bashResults = [
      { command: 'kmp-test doctor --json', resultFound: true, resultIsError: false },
      { command: 'kmp-test doctor --json', resultFound: true, resultIsError: false },
    ];
    expect(verifyExactCommandsSucceeded(bashResults, DOCTOR_DESCRIBE)).toBe(false);
  });

  it('an unrelated allowed extra command alongside both expected ones still passes', () => {
    const bashResults = [
      { command: 'kmp-test doctor --json', resultFound: true, resultIsError: false },
      { command: 'kmp-test describe --json', resultFound: true, resultIsError: false },
      { command: 'kmp-test doctor --help', resultFound: true, resultIsError: false },
    ];
    expect(verifyExactCommandsSucceeded(bashResults, DOCTOR_DESCRIBE)).toBe(true);
  });
});

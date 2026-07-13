// Tests for the JSON ↔ text mode exit-code parity contract for `kmp-test benchmark`.
//
// The dispatcher has two paths for migrated subcommands:
//   JSON path  — captures stdout, extracts the sentinel-wrapped envelope, applies
//                enforceErrorsExitCodeInvariant(envelope.exit_code, {errors}).
//   Text path  — inherits stdio (capturedStdout=''), subprocess status is canonical.
//
// resolveDispatchExitCode(capturedStdout, subprocessStatus) encodes both paths:
//   capturedStdout with sentinels → JSON path
//   ''                            → text path (no-op invariant, subprocess status wins)
//
// These tests exercise both call shapes with identical scenario inputs to prove the
// two paths always agree.  Scenario 5 is the regression guard for the partial-timeout
// divergence that motivated this PR: before gradle_timeout was added to SOFT_ERROR_CODES,
// the JSON path promoted exit_code 0 → 1 while the text path returned 0.

import { describe, it, expect } from 'vitest';
import { resolveDispatchExitCode } from '../../lib/runners/script-dispatcher.js';
import { ENVELOPE_BEGIN, ENVELOPE_END } from '../../lib/runner.js';

// Build a sentinel-wrapped stdout string exactly as lib/runner.js#writeEnvelope does.
function wrapEnvelope(envelope) {
  return ENVELOPE_BEGIN + '\n' + JSON.stringify(envelope) + '\n' + ENVELOPE_END;
}

// Minimal benchmark envelope fixture.
function makeEnvelope({ exitCode, errors = [], warnings = [] } = {}) {
  return {
    tool: 'kmp-test',
    schema_version: 1,
    subcommand: 'benchmark',
    exit_code: exitCode,
    tests: { total: 1, passed: exitCode === 0 ? 1 : 0, failed: exitCode !== 0 ? 1 : 0, skipped: 0 },
    errors,
    warnings,
    benchmark: { config: 'smoke', total: 1, passed: exitCode === 0 ? 1 : 0, failed: 0, timed_out: 0 },
  };
}

describe('resolveDispatchExitCode — json/text parity', () => {
  it('all pass: both modes return 0', () => {
    const env = makeEnvelope({ exitCode: 0 });
    const jsonResult = resolveDispatchExitCode(wrapEnvelope(env), /* ignored */ 99);
    const textResult = resolveDispatchExitCode('', 0);
    expect(jsonResult).toBe(0);
    expect(textResult).toBe(0);
    expect(jsonResult).toBe(textResult);
  });

  it('module_failed: both modes return 1', () => {
    const env = makeEnvelope({
      exitCode: 1,
      errors: [{ code: 'module_failed', module: ':bench-jvm', platform: 'jvm', message: 'FAILED' }],
    });
    const jsonResult = resolveDispatchExitCode(wrapEnvelope(env), 99);
    const textResult = resolveDispatchExitCode('', 1);
    expect(jsonResult).toBe(1);
    expect(textResult).toBe(1);
    expect(jsonResult).toBe(textResult);
  });

  it('gradle_timeout (hard — zero passes, exit 3): both modes return 3', () => {
    // All modules timed out — orchestrator exits 3 (not a soft case).
    const env = makeEnvelope({
      exitCode: 3,
      errors: [{ code: 'gradle_timeout', module: ':bench-jvm', platform: 'jvm' }],
    });
    const jsonResult = resolveDispatchExitCode(wrapEnvelope(env), 99);
    const textResult = resolveDispatchExitCode('', 3);
    expect(jsonResult).toBe(3);
    expect(textResult).toBe(3);
    expect(jsonResult).toBe(textResult);
  });

  it('no_test_modules: both modes return 3', () => {
    const env = makeEnvelope({
      exitCode: 3,
      errors: [{ code: 'no_test_modules', message: 'No modules found matching filter: benchmark' }],
    });
    const jsonResult = resolveDispatchExitCode(wrapEnvelope(env), 99);
    const textResult = resolveDispatchExitCode('', 3);
    expect(jsonResult).toBe(3);
    expect(textResult).toBe(3);
    expect(jsonResult).toBe(textResult);
  });

  it('partial timeout (≥1 pass + timed_out, no strict-timeouts): both modes return 0', () => {
    // The benchmark orchestrator intentionally exits 0 when ≥1 module passed and
    // the remaining ones timed out (graded partial-timeout path, no --strict-timeouts).
    // It records the per-module timeouts in errors[] as an observability signal.
    // gradle_timeout is a SOFT_ERROR_CODE so the invariant does not promote 0 → 1.
    //
    // Regression guard: before gradle_timeout was added to SOFT_ERROR_CODES the JSON
    // path promoted exit_code 0 → 1 (hard error), while the text path returned 0
    // (subprocess status) — a silent grading divergence that misled agents using --json.
    const env = {
      tool: 'kmp-test',
      schema_version: 1,
      subcommand: 'benchmark',
      exit_code: 0,
      tests: { total: 2, passed: 1, failed: 0, skipped: 0 },
      errors: [{ code: 'gradle_timeout', module: ':bench-jvm', platform: 'jvm', timeout_ms: 300000 }],
      warnings: [{ code: 'partial_timeout', timed_out: 1, passed: 1, message: '1 module passed, 1 timed out' }],
      benchmark: { config: 'smoke', total: 2, passed: 1, failed: 0, timed_out: 1, platforms: ['jvm', 'android'] },
    };
    const jsonResult = resolveDispatchExitCode(wrapEnvelope(env), 99);
    const textResult = resolveDispatchExitCode('', 0);
    expect(jsonResult).toBe(0);
    expect(textResult).toBe(0);
    expect(jsonResult).toBe(textResult);
  });
});

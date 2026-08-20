// tests/vitest/agentic-eval-provenance-git-fail-closed.test.js
// Isolated test for resolveHarnessProvenance()'s fail-closed behavior when a git command it
// depends on itself fails, via a scoped mock of node:child_process's spawnSync -- kept in its own
// file rather than agentic-eval-cli.test.js, matching this repo's established
// node:fs-mock-isolation convention (see coverage-orchestrator-report-write-failure.test.js's own
// header comment): vi.mock() is hoisted and module-wide, so it would otherwise break every other
// test that calls buildRunRecord()/resolveHarnessProvenance() indirectly.
//
// Regression coverage for two related fail-open bugs an independent review pass found:
//
// 1. gitDirtyPaths() collapsed "the git status command itself failed" into the exact SAME empty
//    array as "genuinely clean" -- reproduced by removing git from PATH entirely, which returned
//    repo_commit:null AND both dirty-path lists empty, meaning finalizeAndWriteRecords's
//    fail-closed dirty_measured_code gate silently never fired even though nothing had actually
//    verified the tree.
// 2. A SEPARATE, independent git call (git rev-parse HEAD, not git status) failing was its own
//    distinct gap: repo_commit correctly came back null, but nothing made THAT failure fail
//    closed either -- without knowing which commit produced it, evidence is fundamentally
//    non-reproducible regardless of whether the (unrelated) dirty-paths checks happened to
//    succeed.
//
// Fixed: gitDirtyPaths() now returns {ok, paths}, and a failed check (ok:false) OR a null
// repoCommit is treated the SAME as a genuinely dirty tree -- all three mean repo_commit can't be
// trusted, so all three must produce the dirty_measured_code error that finalizeAndWriteRecords
// fails closed on.
//
// Also covers a THIRD, unrelated gap discovered alongside the above: the dirty_harness_tooling
// error messages (and the README's Fairness Contract prose describing them) claimed this code was
// unconditionally "disclosure-only, never fail-closed" -- stale, since findBlockingHarnessToolingDirty
// / finalizeAndWriteRecords already fail closed on it conditionally (default RUNS_ROOT only). Reuses
// this file's existing spawnSync mock (targeting the harness-tooling pathspec instead of the
// measured-code one) rather than standing up a second parallel mock of the same module.
import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { TEST_RUN_RECORD_V6_INPUTS } from './_agentic-eval-run-record-fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Which git call fails (or, for 'tools-lib-dirty'/'harness-dirty', what it reports) is toggled PER
// TEST via failMode -- avoids mixing a hoisted vi.mock() with vi.doMock() for the same module path,
// which is fragile/order-dependent. Every OTHER spawnSync call always behaves normally, isolating
// each test to exactly the one check under coverage.
let failMode = null; // 'status' | 'rev-parse' | 'tools-lib-dirty' | 'harness-status-fail' | 'harness-dirty' | null

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: (cmd, args, opts) => {
      const isMeasuredCodeStatusCall = cmd === 'git' && args[0] === 'status' && args.includes('bin') && args.includes('lib') && args.includes('scripts');
      const isHarnessToolingStatusCall = cmd === 'git' && args[0] === 'status' && args.includes('tools/agentic-eval') && args.includes('package.json');
      if (failMode === 'status' && isMeasuredCodeStatusCall) {
        return { status: 1, stdout: '', stderr: 'fatal: git: command not found (simulated)', error: new Error('spawn git ENOENT (simulated)') };
      }
      // Deliberately requires 'tools/lib' to actually be PRESENT in the real args -- not just the
      // bin/lib/scripts heuristic above, which stays true regardless of whether the pathspec was
      // ever extended. This is what makes the test genuinely exercise the REAL pathspec cli.mjs
      // sends to git, rather than always firing the canned response irrespective of it.
      if (failMode === 'tools-lib-dirty' && isMeasuredCodeStatusCall && args.includes('tools/lib')) {
        // The status call itself SUCCEEDS -- it genuinely found a real, reportable modification --
        // simulating an uncommitted local change to tools/lib/redact.mjs specifically.
        return { status: 0, stdout: ' M tools/lib/redact.mjs\n', stderr: '' };
      }
      if (failMode === 'rev-parse' && cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { status: 128, stdout: '', stderr: 'fatal: not a git repository (simulated)' };
      }
      if (failMode === 'harness-status-fail' && isHarnessToolingStatusCall) {
        return { status: 1, stdout: '', stderr: 'fatal: git: command not found (simulated)', error: new Error('spawn git ENOENT (simulated)') };
      }
      if (failMode === 'harness-dirty' && isHarnessToolingStatusCall) {
        return { status: 0, stdout: ' M tools/agentic-eval/cli.mjs\n', stderr: '' };
      }
      return actual.spawnSync(cmd, args, opts);
    },
  };
});

describe('resolveHarnessProvenance -- fails closed when the git status check itself fails', () => {
  it('produces a dirty_measured_code error (not an empty, falsely-clean dirty-paths list) when git status errors out', async () => {
    failMode = 'status';
    const { resolveHarnessProvenance, buildRunRecord } = await import('../../tools/agentic-eval/cli.mjs');

    const provenance = resolveHarnessProvenance({ fresh: true });
    expect(provenance.measuredCodeCheckFailed).toBe(true);
    expect(provenance.measuredCodeDirtyPaths).toEqual([]);

    const conditionResult = fakeConditionResult();
    const { computePolicySha256 } = await import('../../tools/agentic-eval/policy-config.mjs');
    const record = buildRunRecord({
      conditionResult, condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-git-fail',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      ...TEST_RUN_RECORD_V6_INPUTS,
      ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
    });

    // The record's own errors[] must disclose this as dirty_measured_code -- the SAME code a
    // genuinely dirty tree produces, since finalizeAndWriteRecords's fail-closed check only knows
    // to look for that one code.
    const dirtyError = record.errors.find((e) => e.code === 'dirty_measured_code');
    expect(dirtyError).toBeDefined();
    expect(dirtyError.message).toContain('cannot verify the tree is clean');
  });
});

describe('resolveHarnessProvenance -- fails closed when git rev-parse HEAD itself fails (repo_commit unknown)', () => {
  it('produces a dirty_measured_code error even though the bin/lib/scripts status check itself succeeded', async () => {
    failMode = 'rev-parse';
    const { resolveHarnessProvenance } = await import('../../tools/agentic-eval/cli.mjs');

    const provenance = resolveHarnessProvenance({ fresh: true });
    expect(provenance.repoCommit).toBeNull();
    expect(provenance.measuredCodeDirtyPaths).toEqual([]); // the status check itself succeeded (found nothing dirty)
    expect(provenance.measuredCodeCheckFailed).toBe(true); // still fails closed, via repoCommit being null
  });
});

// Regression coverage for a real coverage gap an independent review pass found: the measured-code
// dirty-tree pathspec only covered bin/lib/scripts, completely missing tools/lib/redact.mjs
// (imported by privacy.mjs -- IS the redaction logic every privacy guarantee in this PR depends
// on) and tools/validate-plugin.mjs (imported by cli.mjs -- validates the materialized skill
// snapshot). A local, uncommitted change to either was previously invisible to ANY dirty-tree
// check, not even disclosed. Fixed by extending the SAME fail-closed pathspec (not a new,
// separate category) to include both.
describe('resolveHarnessProvenance -- the measured-code pathspec covers tools/lib and tools/validate-plugin.mjs, not just bin/lib/scripts', () => {
  it('reports tools/lib/redact.mjs as a dirty measured-code path when it has a real, reported modification', async () => {
    failMode = 'tools-lib-dirty';
    const { resolveHarnessProvenance } = await import('../../tools/agentic-eval/cli.mjs');

    const provenance = resolveHarnessProvenance({ fresh: true });
    expect(provenance.measuredCodeDirtyPaths).toEqual(['M tools/lib/redact.mjs']);
    expect(provenance.measuredCodeCheckFailed).toBe(false); // the check itself succeeded -- this is a genuinely dirty result, not a failed check
  });
});

// Regression coverage for a stale-prose gap: the dirty_harness_tooling error messages built in
// buildRunRecord() claimed this was unconditionally "informational only" / "never blocks evidence".
// That was true once, but findBlockingHarnessToolingDirty()/finalizeAndWriteRecords() were later
// made conditionally fail-closed (blocks only when writing to the default RUNS_ROOT) without the
// message text catching up. Asserts on substance (contains the corrected framing, drops the old
// absolute claim) via .toContain(), never a full-message deep-equal/snapshot, so this survives
// incidental future rewording as long as the conditional truth is still stated.
// Matches the canonical minimal condition-observation-v1 shape (see e.g.
// agentic-eval-graders.test.js's own baseObservation helper) -- buildRunRecord now reads
// conditionResult.observation exclusively, never a raw provider event.
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

async function buildRecordWithHarnessToolingError() {
  const { resolveHarnessProvenance, buildRunRecord } = await import('../../tools/agentic-eval/cli.mjs');
  const { computePolicySha256 } = await import('../../tools/agentic-eval/policy-config.mjs');
  resolveHarnessProvenance({ fresh: true });
  const conditionResult = fakeConditionResult();
  return buildRunRecord({
    conditionResult, condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-harness-tooling-wording',
    skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
    allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
    ...TEST_RUN_RECORD_V6_INPUTS,
    ambientProfileScopeId: '00000000-0000-4000-8000-000000000000', ambientProfileKey: Buffer.from('0'.repeat(64), 'hex'),
  });
}

describe('buildRunRecord -- dirty_harness_tooling message states the real conditional, not "never blocks evidence"', () => {
  it('when the harness-tooling status check itself fails', async () => {
    failMode = 'harness-status-fail';
    const record = await buildRecordWithHarnessToolingError();
    const dirty = record.errors.find((e) => e.code === 'dirty_harness_tooling');
    expect(dirty).toBeDefined();
    expect(dirty.message).toContain('fail-closed');
    expect(dirty.message).toContain('default');
    expect(dirty.message).toContain('RUNS_ROOT');
    expect(dirty.message).not.toContain('never blocks evidence');
    expect(dirty.message).not.toContain('informational only');
  });

  it('when the harness-tooling status check succeeds but reports a real dirty path', async () => {
    failMode = 'harness-dirty';
    const record = await buildRecordWithHarnessToolingError();
    const dirty = record.errors.find((e) => e.code === 'dirty_harness_tooling');
    expect(dirty).toBeDefined();
    expect(dirty.message).toContain('fail-closed');
    expect(dirty.message).toContain('default');
    expect(dirty.message).toContain('RUNS_ROOT');
    expect(dirty.message).not.toContain('never blocks evidence');
    expect(dirty.message).not.toContain('informational only');
  });
});

// Regression coverage for the actual place this drift happened: README.md's Fairness Contract
// prose, not just the two runtime messages above. Nothing else in this suite reads the README, so
// without this, the prose could drift stale again while every code-level test stays green.
describe('README.md -- Fairness Contract describes dirty_harness_tooling conditionally', () => {
  it('states the default/non-default RUNS_ROOT conditional and drops the stale unconditional wording', () => {
    const readme = readFileSync(path.join(REPO_ROOT, 'tools', 'agentic-eval', 'README.md'), 'utf8');
    expect(readme).toMatch(/dirty_harness_tooling[\s\S]{0,600}\bdefault\b/i);
    expect(readme).toMatch(/dirty_harness_tooling[\s\S]{0,600}non-default/i);
    expect(readme).not.toMatch(/disclosure-only,\s*never fail-closed/i);
  });
});

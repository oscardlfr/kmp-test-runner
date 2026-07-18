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
import { describe, it, expect, vi } from 'vitest';

// Which git call fails is toggled PER TEST via failMode -- avoids mixing a hoisted vi.mock() with
// vi.doMock() for the same module path, which is fragile/order-dependent. Every OTHER spawnSync
// call always behaves normally, isolating each test to exactly the one check under coverage.
let failMode = null; // 'status' | 'rev-parse' | null

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: (cmd, args, opts) => {
      if (failMode === 'status' && cmd === 'git' && args[0] === 'status' && args.includes('bin') && args.includes('lib') && args.includes('scripts')) {
        return { status: 1, stdout: '', stderr: 'fatal: git: command not found (simulated)', error: new Error('spawn git ENOENT (simulated)') };
      }
      if (failMode === 'rev-parse' && cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { status: 128, stdout: '', stderr: 'fatal: not a git repository (simulated)' };
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

    const conditionResult = {
      init: { model: 'claude-sonnet-5-fake', session_id: 'sess-1', claude_code_version: 'fake', plugins: [], tools: ['Bash', 'Skill'], mcp_servers: [], permissionMode: 'dontAsk' },
      result: { subtype: 'success', is_error: false },
      invocation: null,
      hookStats: { hookCallCount: 0, hookDenyCount: 0, everyCallHooked: true, hookAllowCount: 0 },
      byteMetrics: { outputBytes: 0, streamJsonBytes: 0 },
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: new Date('2026-01-01T00:00:01.000Z'),
      spawnResult: { terminated: false, terminationReason: null, exitCode: 0 },
      events: [],
    };
    const { computePolicySha256 } = await import('../../tools/agentic-eval/policy-config.mjs');
    const record = buildRunRecord({
      conditionResult, condition: 'no-skill', runKind: 'calibration', scenarioId: 'test-git-fail',
      skillSourceSha: null, daemonPolicy: 'disabled-via-gradle-user-home-properties',
      allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'], policySha256: computePolicySha256(),
      modelRequested: 'fake-model',
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

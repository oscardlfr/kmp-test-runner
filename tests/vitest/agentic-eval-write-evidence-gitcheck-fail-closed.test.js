// tests/vitest/agentic-eval-write-evidence-gitcheck-fail-closed.test.js
// Isolated test for isRawDirSafeFromAccidentalCommit()'s git-unavailable behavior, via a scoped
// mock of node:child_process's spawnSync -- kept in its own file rather than
// agentic-eval-cli.test.js, matching this repo's established node:fs-mock-isolation convention
// (see coverage-orchestrator-report-write-failure.test.js's own header comment): vi.mock() is
// hoisted and module-wide, so it would otherwise break every other test that calls git via
// spawnSync (which is most of this file's siblings).
//
// Regression coverage for a real fail-open bug an independent review pass found and reproduced by
// disabling git during exactly this check: `git -C <path> rev-parse --show-toplevel` returning a
// non-zero exit was treated as unconditional proof the destination is outside any git repository,
// therefore safe. But a non-zero exit ALSO covers git being entirely unavailable (missing from
// PATH), a spawn-level failure, a permissions problem, an unconfigured safe.directory, or any
// other unexpected error -- none of which mean "confirmed outside a repo," they mean "couldn't
// check." Fixed: only a spawn success with git's own well-known, stable exit code (128) and
// stderr message ("fatal: not a git repository") counts as confirmed-safe; every other outcome,
// including a spawn error, now fails closed.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-parse' && args[3] === '--show-toplevel') {
        // Simulates git being entirely unavailable -- a spawn-level failure, not git running and
        // reporting "not a git repository." error is set exactly the way Node's real spawnSync
        // sets it on ENOENT.
        const err = new Error('spawn git ENOENT (simulated -- git unavailable)');
        err.code = 'ENOENT';
        return { status: null, stdout: '', stderr: '', error: err };
      }
      return actual.spawnSync(cmd, args, opts);
    },
  };
});

describe('writeRunRecordEvidence -- fails closed when the git availability check itself cannot be completed', () => {
  it('refuses to write raw transcripts when rev-parse --show-toplevel fails via a spawn error, never assuming "outside any repo"', async () => {
    const { writeRunRecordEvidence } = await import('../../tools/agentic-eval/cli.mjs');

    const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aec-gitcheck-'));
    try {
      const recordA = { run_id: 'gitcheck-a-0001' };
      const recordB = { run_id: 'gitcheck-b-0001' };
      const runA = { spawnResult: { rawStdout: '{"raw":"a"}\n' } };
      const runB = { spawnResult: { rawStdout: '{"raw":"b"}\n' } };

      expect(() => writeRunRecordEvidence('test-kind', recordA, recordB, runA, runB, '{"redacted":"a"}', '{"redacted":"b"}', runsRoot))
        .toThrow(/not covered by \.gitignore/);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });
});

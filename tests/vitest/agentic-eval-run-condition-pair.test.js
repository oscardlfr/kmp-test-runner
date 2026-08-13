// tests/vitest/agentic-eval-run-condition-pair.test.js
// Real (non-mocked) coverage for runConditionPair's (tools/agentic-eval/cli.mjs) cleanup-on-
// acquisition-failure contract. Regression coverage for a real leak bug found by an independent
// review pass: runConditionPair materializes SIX real temp resources (policy settings file,
// PATH shim, skill snapshot, GRADLE_USER_HOME + its own internal snapshot, KMP_EVAL_TEMP_HOME)
// before the caller ever receives a cleanup() handle to call -- previously, a failure ANYWHERE
// during that acquisition sequence, or inside either condition's own materializeFixture call,
// left every resource created up to that point on disk forever, because the ONLY cleanup
// mechanism was the cleanup() function returned on a SUCCESSFUL resolution. This drives the real
// function (real git archive of the pinned skill snapshot, real Gradle-user-home prewarm, real
// PATH shim generation) and injects a failure partway through -- inside the caller-supplied
// materializeFixture callback, which runs strictly AFTER all six resources already exist -- to
// prove the internal try/catch-based incremental cleanup actually fires.
//
// Deliberately does NOT exercise a failure AFTER a successful spawnCondition() call: that would
// require condition B's run to actually complete first, which means actually spawning the
// literal `claude` argv[0] through PATH resolution -- on a machine with the real claude CLI
// installed (this one), that risks invoking a real, live Claude session, which this harness's
// own explicit constraint (never run live Claude outside an authorized, explicit calibrate/smoke
// invocation with the fake-claude PATH override or full user sign-off) forbids. The
// materializeFixture-throws-immediately injection point below proves the same incremental-
// cleanup mechanism without ever reaching spawnCondition.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConditionPair } from '../../tools/agentic-eval/cli.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

// Same as agentic-eval-matrix-runner-crash-safety.test.js's own identical helper -- required as
// of the auth-preflight fix: acquireSharedEvalResources now calls runAuthPreflight as its own
// LAST step, before materializeFixture is ever reached, so this test's injected
// materializeFixture failure is only reachable when the preflight itself succeeds first. Without
// this, the real (bare) `claude` on PATH is resolved instead -- on a machine with a pre-
// authenticated claude CLI (a real developer workstation) the preflight happens to succeed by
// accident, masking that the test would fail closed (a DIFFERENT error: the preflight's own
// failure message, never reaching materializeFixture at all) anywhere else, including CI's Linux
// Docker lane, where claude is not installed at all (exit code 127).
// Node coerces `process.env.KEY = undefined` to the literal STRING "undefined" rather than
// removing the variable -- assigning back a `saved` value that was itself `undefined` (the var
// genuinely wasn't set before this test touched it, plausible for TMPDIR specifically on Linux)
// would corrupt process.env for the rest of this worker process's test run, not actually restore
// the pre-test state. delete is the correct restoration for an originally-absent variable.
function restoreEnvVar(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function withFakeClaudePath(scenario, fn) {
  const fakeDir = path.join(FIXTURES_DIR, `fake-claude-${scenario}`);
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeDir}${delimiter}${savedPath ?? ''}`;
  try {
    return await fn();
  } finally {
    // Post-review fix (P3): restoreEnvVar (not a bare assignment) -- see its own doc comment.
    restoreEnvVar('PATH', savedPath);
  }
}

describe('runConditionPair -- cleanup on acquisition failure', () => {
  it('removes every temp resource created so far when materializeFixture throws mid-acquisition', async () => {
    // os.tmpdir() reads TEMP/TMP/TMPDIR fresh on every call (not cached at module load) -- so
    // redirecting these env vars for the duration of this in-process call routes every
    // mkdtempSync(tmpdir()) call inside runConditionPair (and everything it calls) into an
    // isolated directory this test exclusively owns, making "is it empty afterward" exact.
    const isolatedTmp = mkdtempSync(path.join(os.tmpdir(), 'aecp-isolated-tmp-'));
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = isolatedTmp;
    process.env.TMP = isolatedTmp;
    process.env.TMPDIR = isolatedTmp;
    try {
      let materializeCalls = 0;
      await withFakeClaudePath('run-scenario-success', async () => {
        await expect(runConditionPair({
          prompt: 'irrelevant -- never reaches a real spawn',
          model: 'fake-model-x',
          allowedGradleTasks: [],
          allowedKmpTestSubcommands: ['doctor'],
          materializeFixture: () => {
            materializeCalls++;
            throw new Error('injected acquisition failure');
          },
        })).rejects.toThrow('injected acquisition failure');
      });
      // Confirms the failure really did happen AFTER acquisition (not e.g. materializeFixture
      // being skipped and some earlier step throwing instead, which would make this test
      // meaningless -- it would then be testing a different failure point than it claims to).
      expect(materializeCalls).toBe(1);
      expect(readdirSync(isolatedTmp)).toEqual([]);
    } finally {
      restoreEnvVar('TEMP', saved.TEMP);
      restoreEnvVar('TMP', saved.TMP);
      restoreEnvVar('TMPDIR', saved.TMPDIR);
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
  }, 30000);
});

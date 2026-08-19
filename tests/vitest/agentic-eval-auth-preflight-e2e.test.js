// tests/vitest/agentic-eval-auth-preflight-e2e.test.js
// Direct, in-process end-to-end reproduction of the two live-session-affecting failure modes the
// macOS auth-preflight incident plan (Diseño 5) requires: Caso A (the auth preflight itself fails
// closed, before ANY live spawn) and Caso B (auth passes, but the FIRST cell's own live session
// hits the exact pre-inference-failure signature the incident produced). Both drive the REAL
// runScenarioMatrix (tools/agentic-eval/matrix-runner.mjs) against the two new fake-claude
// fixtures via PATH -- same withFakeClaudePath/isolated-TEMP idiom as
// agentic-eval-matrix-runner-crash-safety.test.js and agentic-eval-run-condition-pair.test.js (see
// each of those files' own header comments for why this is a safe, PATH-only override that can
// never reach a real, live claude binary). Caso C (a genuine negative cell must never be
// misclassified as a pre-inference failure) is already covered by Diseño 3's own unit tests in
// agentic-eval-cell-integrity.test.js -- no fixture needed there.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenarioMatrix } from '../../tools/agentic-eval/matrix-runner.mjs';
import { createInvocationJournal } from '../../tools/agentic-eval/durable-journal.mjs';
import { runValidator as runPluginValidator } from '../../tools/validate-plugin.mjs';
// Test-only, deliberately vendor-specific: matrix-runner.mjs no longer defaults runtimeAdapter
// (agentic-eval-runtime-neutral-records-v1) -- an omitted adapter is now a contract error, not a
// fallback. These two cases exist specifically to exercise the REAL Claude adapter's own
// preflight/spawn behavior against a PATH-shadowed fake `claude` binary, so they inject the real
// singleton directly rather than going through the registry default.
import { claudeCodeRuntimeAdapter } from '../../tools/agentic-eval/runtimes/claude-code.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const PINNED_SKILL_SHA = '9814ada0c45e6a3d2a0399291ec96cb8d1ef86bb';
const TARGET_PLUGIN_NAME = 'kmp-test-runner';
const TARGET_SKILL_NAME = 'kmp-test-runner';

/** Same as agentic-eval-run-condition-pair.test.js's own identical helper -- `delete` (never
 * assigning back `undefined`, which Node coerces to the literal string "undefined") is the
 * correct restoration for an originally-absent env var. */
function restoreEnvVar(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Same as agentic-eval-matrix-runner-crash-safety.test.js's own identical helper. */
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

const SCENARIO = {
  schema: 1,
  id: 'auth-preflight-e2e-test-only-scenario',
  family: 'test-only',
  project_alias: 'fake-auth-preflight-project',
  project_url: 'https://example.com/fake-auth-preflight-project.git',
  prompt: "Run the tests for this project's only module and tell me what happened.",
  expected_outcome: 'irrelevant -- these tests never reach grading',
  policy: {
    allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel'],
    allowed_gradle_tasks: [':fakemod:test'],
  },
  expected: {
    module: ':fakemod',
    outcome_kind: 'no_applicable_tests',
    kmp_test: { error_code: 'no_test_modules', exit_code: 2, caused_by_filter: true },
    gradle: { allowed_invocations: [':fakemod:test'], evidence_task: ':fakemod:test', exit_code: 0, marker: 'NO-SOURCE' },
  },
  first_useful_signal_predicate: { description: 'irrelevant -- these tests never reach grading' },
  tags: ['train'],
};

describe('Caso A -- auth preflight fails closed BEFORE any live spawn', () => {
  it('runScenarioMatrix throws tagged acquiring_shared_resources, the normal argv is never invoked, the journal records zero transitions, and no leftover temp resources remain', async () => {
    const isolatedTmp = mkdtempSync(path.join(os.tmpdir(), 'aeape-caso-a-tmp-'));
    const journalRunsRoot = mkdtempSync(path.join(os.tmpdir(), 'aeape-caso-a-journal-'));
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = isolatedTmp;
    process.env.TMP = isolatedTmp;
    process.env.TMPDIR = isolatedTmp;

    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 4, runsRootOverride: journalRunsRoot });

      let caught = null;
      await withFakeClaudePath('auth-status-fail', async () => {
        try {
          await runScenarioMatrix({
            scenario: SCENARIO, repeats: 2, seed: 1, model: 'fake-model-x',
            allowedGradleTasks: SCENARIO.policy.allowed_gradle_tasks,
            allowedKmpTestSubcommands: SCENARIO.policy.allowed_kmptest_subcommands,
            repoRoot: REPO_ROOT, pinnedSkillSha: PINNED_SKILL_SHA, runPluginValidator,
            materializeFixture: () => { throw new Error('materializeFixture must never be called -- the preflight must fail before any cell is even attempted'); },
            cleanupFixture: () => {},
            targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
            timeoutMs: 30000,
            journal,
            runtimeAdapter: claudeCodeRuntimeAdapter,
          });
        } catch (err) {
          caught = err;
        }
      });

      expect(caught).not.toBeNull();
      expect(caught.agenticEvalPhase).toBe('acquiring_shared_resources');
      // A closed reason code + normalized fields only -- never authMethod/apiProvider/
      // subscriptionType (which come straight from the external claude auth status JSON,
      // unvalidated) and never raw JSON/stdout/stderr. This fixture exits non-zero NORMALLY (a
      // real, non-terminated process, per condition-launcher.mjs's own "a merely nonzero exit
      // code is NOT a termination" contract) AND reports loggedIn:false --
      // authPreflightReasonCode checks terminated first (false here, so it's a no-op), then
      // exitCode, so the nonzero-exit code takes precedence over the (also-true) not-logged-in
      // signal, exactly matching its own documented precedence order.
      expect(caught.message).toContain('reason=auth_preflight_nonzero_exit');
      expect(caught.message).toMatch(/exit_code=\d+/);
      expect(caught.message).toContain('logged_in=false');

      // The normal argv (-p ...) was never invoked -- the fixture only ever writes this probe log
      // entry if it somehow WAS reached.
      const probeLogPath = path.join(isolatedTmp, 'auth-status-fail-invocations.log');
      expect(existsSync(probeLogPath)).toBe(false);

      // Zero cells ever reached even spawn_started -- the preflight fails before the cellPlan
      // loop is ever entered.
      const summary = journal.summarize();
      expect(summary.counts.spawn_started).toBe(0);
      expect(summary.counts.spawn_completed).toBe(0);
      expect(summary.counts.raw_persisted).toBe(0);
      expect(summary.cellOrdinals.planned).toEqual([0, 1, 2, 3]);

      // No leftover temp resources -- acquireSharedEvalResources' own catch already ran
      // runCleanup() before the error ever reached this test.
      expect(readdirSync(isolatedTmp)).toEqual([]);
    } finally {
      restoreEnvVar('TEMP', saved.TEMP);
      restoreEnvVar('TMP', saved.TMP);
      restoreEnvVar('TMPDIR', saved.TMPDIR);
      rmSync(isolatedTmp, { recursive: true, force: true });
      rmSync(journalRunsRoot, { recursive: true, force: true });
    }
  }, 30000);
});

describe('Caso B -- auth passes, the FIRST cell hits the exact pre-inference-failure signature', () => {
  it('exactly ONE live session runs (of 4 planned); the matrix stops with matrixComplete:false; noPreInferenceFailureOk is the failing check; raw stdout + stderr are both recoverable from the journal', async () => {
    const journalRunsRoot = mkdtempSync(path.join(os.tmpdir(), 'aeape-caso-b-journal-'));
    const isolatedTmp = mkdtempSync(path.join(os.tmpdir(), 'aeape-caso-b-tmp-'));
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = isolatedTmp;
    process.env.TMP = isolatedTmp;
    process.env.TMPDIR = isolatedTmp;
    const fixtureDirs = [];

    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 4, runsRootOverride: journalRunsRoot });
      const materializeFixture = () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'aeape-caso-b-fixture-'));
        fixtureDirs.push(dir);
        return { fixtureDir: dir };
      };

      const result = await withFakeClaudePath('auth-ok-pre-inference-failure', () => runScenarioMatrix({
        scenario: SCENARIO, repeats: 2, seed: 1, model: 'fake-model-x',
        allowedGradleTasks: SCENARIO.policy.allowed_gradle_tasks,
        allowedKmpTestSubcommands: SCENARIO.policy.allowed_kmptest_subcommands,
        repoRoot: REPO_ROOT, pinnedSkillSha: PINNED_SKILL_SHA, runPluginValidator,
        materializeFixture,
        cleanupFixture: () => {},
        targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
        timeoutMs: 30000,
        journal,
        runtimeAdapter: claudeCodeRuntimeAdapter,
      }));

      // Exactly 1 live invocation of the normal argv -- the other 3 planned cells never spawned.
      const probeLogPath = path.join(isolatedTmp, 'auth-ok-pre-inference-failure-invocations.log');
      expect(existsSync(probeLogPath)).toBe(true);
      const invocationLines = readFileSync(probeLogPath, 'utf8').trim().split('\n').filter(Boolean);
      expect(invocationLines.length).toBe(1);

      expect(result.matrixComplete).toBe(false);
      expect(result.executedCellCount).toBe(1);
      expect(result.plannedCellCount).toBe(4);
      expect(result.cellResults.length).toBe(1);
      expect(result.cellResults[0].localIntegrity.ok).toBe(false);
      expect(result.cellResults[0].localIntegrity.failedChecks).toContain('noPreInferenceFailureOk');
      // Isolated to exactly this one check -- the fixture's init/tool-profile/plugin-binding shape
      // is otherwise clean, matching fake-claude-run-scenario-success's own proven-correct
      // construction.
      expect(result.cellResults[0].localIntegrity.failedChecks).toEqual(['noPreInferenceFailureOk']);
      expect(result.failFastStop.orderIndex).toBe(0);

      // The journal recovers BOTH the real transcript and the real (non-empty) stderr for the one
      // cell that actually ran.
      const raw0 = journal.readRawFor(0);
      expect(raw0.length).toBeGreaterThan(0);
      expect(raw0).toContain('"type":"result"');
      const stderr0 = journal.readStderrFor(0);
      expect(stderr0).not.toBeNull();
      expect(stderr0.length).toBeGreaterThan(0);
      expect(stderr0).toContain('simulated pre-inference failure');

      await result.cleanup();
    } finally {
      restoreEnvVar('TEMP', saved.TEMP);
      restoreEnvVar('TMP', saved.TMP);
      restoreEnvVar('TMPDIR', saved.TMPDIR);
      rmSync(isolatedTmp, { recursive: true, force: true });
      rmSync(journalRunsRoot, { recursive: true, force: true });
      for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

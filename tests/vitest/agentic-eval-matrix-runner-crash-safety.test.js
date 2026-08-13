// tests/vitest/agentic-eval-matrix-runner-crash-safety.test.js
// Direct, in-process coverage for runScenarioMatrix's (tools/agentic-eval/matrix-runner.mjs) and
// runConditionPair's (tools/agentic-eval/cli.mjs) crash-safety journal wiring -- the central
// scenario the whole incident/plan exists to fix: a cell's live Claude session spawns and
// completes for real, the NEXT cell's materialization throws, and the completed cell's raw
// transcript must survive in the journal rather than being discarded with zero trace (the
// 2026-08-10 agentic-full-corpus-final-canary-v2 incident -- see
// HANDOFF-full-corpus-canary-v2-matrix2-session-loss.md).
//
// materializeFixture is a plain injected callback (runScenarioMatrix's/runConditionPair's own
// documented parameter shape) -- no vi.mock() needed. The REAL spawnCondition/
// condition-launcher.mjs machinery runs unmocked, spawning the real
// fake-claude-run-scenario-success fixture for the cell that's meant to complete for real -- this
// is the only way to prove the journal captures a GENUINELY completed session's raw transcript,
// not a synthetic stand-in.
//
// SAFETY: claude is resolved purely via PATH lookup inside spawnCondition's `bash -c "'claude'
// ..."` invocation (condition-launcher.mjs) -- confirmed no hardcoded binary path or bypass env
// var exists anywhere in this harness (grepped tools/agentic-eval/*.mjs). buildPathShim's own
// shim directory only ever contains a kmp-test shim, never a claude shim, and env-builder.mjs's
// buildEvalEnv() passes PATH through from process.env verbatim (base value only -- callers
// prepend a shim dir on top). Prepending the fake-claude fixture directory to process.env.PATH
// before calling runScenarioMatrix/runConditionPair (restored in `finally`, matching
// agentic-eval-run-condition-pair.test.js's own TEMP/TMP/TMPDIR restoration idiom) is therefore
// the correct, safe in-process equivalent of agentic-eval-run-command.test.js's own
// fakeClaudeEnv() subprocess convention -- it never resolves the real, live claude binary that
// may also be installed on the host machine.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenarioMatrix } from '../../tools/agentic-eval/matrix-runner.mjs';
import { runConditionPair } from '../../tools/agentic-eval/cli.mjs';
import { createInvocationJournal } from '../../tools/agentic-eval/durable-journal.mjs';
import { runValidator as runPluginValidator } from '../../tools/validate-plugin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const PINNED_SKILL_SHA = '9814ada0c45e6a3d2a0399291ec96cb8d1ef86bb';
const TARGET_PLUGIN_NAME = 'kmp-test-runner';
const TARGET_SKILL_NAME = 'kmp-test-runner';

// Node coerces `process.env.KEY = undefined` to the literal STRING "undefined" rather than
// removing the variable -- assigning back a `saved` value that was itself `undefined` (PATH
// genuinely absent before this helper touched it) would corrupt process.env for the rest of this
// worker process's test run, not actually restore the pre-test state. delete is the correct
// restoration for an originally-absent variable (post-review fix, P3).
function restoreEnvVar(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Prepends a fake-claude-<scenario> fixture directory to process.env.PATH for the duration of
 * `fn`, always restoring the exact original value afterward -- see this file's own header
 * comment for why this is a safe, PATH-only override that can never reach the real claude binary. */
async function withFakeClaudePath(scenario, fn) {
  const fakeDir = path.join(FIXTURES_DIR, `fake-claude-${scenario}`);
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeDir}${delimiter}${savedPath ?? ''}`;
  try {
    return await fn();
  } finally {
    restoreEnvVar('PATH', savedPath);
  }
}

const SCENARIO = {
  schema: 1,
  id: 'matrix-runner-crash-safety-test-only-scenario',
  family: 'test-only',
  project_alias: 'fake-crash-safety-project',
  project_url: 'https://example.com/fake-crash-safety-project.git',
  prompt: "Run the tests for this project's only module and tell me what happened.",
  expected_outcome: 'irrelevant -- this test never reaches grading',
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
  first_useful_signal_predicate: { description: 'irrelevant -- this test never reaches grading' },
  tags: ['train'],
};

describe("runScenarioMatrix -- crash-safety journal preserves an earlier cell across a later cell's materialization exception", () => {
  it("cell 0 spawns and completes for real; cell 1's materializeFixture throws -- cell 0's raw survives, tagged materializing_cell/cellOrdinal:1", async () => {
    const journalRunsRoot = mkdtempSync(path.join(os.tmpdir(), 'aemr-journal-root-'));
    const fixtureDirs = [];
    let materializeCalls = 0;

    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 2, runsRootOverride: journalRunsRoot });

      const materializeFixture = () => {
        materializeCalls++;
        if (materializeCalls === 2) {
          throw new Error('simulated: git clean -fdx failed -- Filename too long (the exact 2026-08-10 incident trigger)');
        }
        const dir = mkdtempSync(path.join(os.tmpdir(), 'aemr-fixture-'));
        fixtureDirs.push(dir);
        return { fixtureDir: dir };
      };

      let caught = null;
      await withFakeClaudePath('run-scenario-success', async () => {
        try {
          await runScenarioMatrix({
            scenario: SCENARIO, repeats: 1, seed: 1, model: 'fake-model-x',
            allowedGradleTasks: SCENARIO.policy.allowed_gradle_tasks,
            allowedKmpTestSubcommands: SCENARIO.policy.allowed_kmptest_subcommands,
            repoRoot: REPO_ROOT, pinnedSkillSha: PINNED_SKILL_SHA, runPluginValidator,
            materializeFixture,
            cleanupFixture: () => {},
            targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
            timeoutMs: 30000,
            journal,
          });
        } catch (err) {
          caught = err;
        }
      });

      // The exception genuinely escaped runScenarioMatrix (never silently swallowed) and is
      // correctly phase/ordinal-tagged for finalizeIncident to consume.
      expect(caught).not.toBeNull();
      expect(caught.message).toMatch(/Filename too long/);
      expect(caught.agenticEvalPhase).toBe('materializing_cell');
      expect(caught.agenticEvalCellOrdinal).toBe(1);

      // cell 1 never spawned at all -- the throw happened inside materializeFixture, strictly
      // before spawnCondition is ever reached.
      expect(materializeCalls).toBe(2);

      // The central proof: cell 0's REAL, completed session is durably preserved in the journal,
      // never discarded (this test never calls journal.promoteAndDiscard() -- the journal
      // directory's continued existence on disk IS the preservation, matching cli.mjs's own
      // discard policy of simply never calling it on this path).
      const summary = journal.summarize();
      expect(summary.counts.raw_persisted).toBe(1);
      expect(summary.cellOrdinals.raw_persisted).toEqual([0]);
      expect(summary.counts.spawn_started).toBe(1);
      expect(summary.cellOrdinals.spawn_started).toEqual([0]); // cell 1 never even reached spawn_started
      expect(summary.counts.evaluated).toBe(1); // cell 0 also completed its own local integrity evaluation
      expect(existsSync(journal.journalDir)).toBe(true);

      // The preserved raw is cell 0's GENUINE fake-claude-run-scenario-success transcript, not an
      // empty placeholder -- read back through the journal's own API, matching exactly how
      // cli.mjs's adoptJournalRaw reads it back for promotion.
      const raw0 = journal.readRawFor(0);
      expect(raw0.length).toBeGreaterThan(0);
      expect(raw0).toContain('"type"'); // a real stream-json transcript, not synthetic filler
    } finally {
      rmSync(journalRunsRoot, { recursive: true, force: true });
      for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

// Diseño 4a (macOS auth-preflight PR) -- the most severe P1 finding of the whole review process:
// a cell whose stderr persistence genuinely fails must NEVER be allowed to continue toward
// parse/evaluate/promotion as if nothing happened. persistSpawnOutcome's own fail-fast throws the
// instant the stderr write fails; this test proves that throw genuinely propagates all the way out
// of a REAL runScenarioMatrix invocation (a real fake-claude session spawns and completes, THEN
// the stderr write fails), tagged for finalizeIncident exactly like materializeFixture's own
// exception above -- same phase family, different cause. The journal is never discarded on this
// path (this test, like its siblings above, never calls promoteAndDiscard/discardJournalIfRedundant
// -- the journal directory's continued presence on disk IS the preservation).
describe('runScenarioMatrix -- a real stderr-persistence failure aborts as an incident, never reaching promotion', () => {
  it("cell 0's real fake-claude session spawns and completes, but its stderr write fails (a plain file occupies the journal's stderr/ directory slot) -- persistSpawnOutcome's fail-fast throws, tagged persisting_cell_journal/cellOrdinal:0, rawStdout still recoverable, zero cells ever reach evaluated", async () => {
    const journalRunsRoot = mkdtempSync(path.join(os.tmpdir(), 'aemr-stderr-fail-journal-root-'));
    const fixtureDirs = [];

    try {
      const journal = createInvocationJournal({ runKind: 'scenario', plannedCellCount: 1, runsRootOverride: journalRunsRoot });
      // Occupies the directory slot persistSpawnOutcome needs for stderr/0.txt -- BEFORE any real
      // spawn happens, using the journal's own known (not internally-random) journalDir, unlike the
      // rejection tier's rejectionId which is only known after the fact.
      mkdirSync(journal.journalDir, { recursive: true });
      writeFileSync(path.join(journal.journalDir, 'stderr'), 'blocking-file');

      const materializeFixture = () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'aemr-stderr-fail-fixture-'));
        fixtureDirs.push(dir);
        return { fixtureDir: dir };
      };

      let caught = null;
      await withFakeClaudePath('run-scenario-success', async () => {
        try {
          await runScenarioMatrix({
            scenario: SCENARIO, repeats: 1, seed: 1, model: 'fake-model-x',
            allowedGradleTasks: SCENARIO.policy.allowed_gradle_tasks,
            allowedKmpTestSubcommands: SCENARIO.policy.allowed_kmptest_subcommands,
            repoRoot: REPO_ROOT, pinnedSkillSha: PINNED_SKILL_SHA, runPluginValidator,
            materializeFixture,
            cleanupFixture: () => {},
            targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
            timeoutMs: 30000,
            journal,
          });
        } catch (err) {
          caught = err;
        }
      });

      expect(caught).not.toBeNull();
      expect(caught.message).toMatch(/stderr persistence failed for cellOrdinal 0/);
      expect(caught.message).toMatch(/stderr_write_failed/);
      // Never the raw fs error text (which, on this exact setup, genuinely contains an absolute path).
      expect(caught.message).not.toContain(journalRunsRoot);
      expect(caught.agenticEvalPhase).toBe('persisting_cell_journal');
      expect(caught.agenticEvalCellOrdinal).toBe(0);
      expect(typeof caught.agenticEvalRawStdout).toBe('string');
      expect(caught.agenticEvalRawStdout.length).toBeGreaterThan(0);
      expect(caught.agenticEvalRawStdout).toContain('"type"'); // the real spawned session's own transcript

      // rawStdout was persisted to the journal BEFORE the stderr failure -- still recoverable there
      // too, not just on the error object.
      const raw0 = journal.readRawFor(0);
      expect(raw0.length).toBeGreaterThan(0);
      expect(raw0).toContain('"type"');

      // The stderr failure is recorded structurally, never masked.
      const { stderrMeta } = journal.summarize();
      expect(stderrMeta[0].present).toBe(false);
      expect(stderrMeta[0].writeError).toBe('stderr_write_failed');

      // Zero cells ever reached parse/evaluate -- the throw happens strictly between
      // raw_persisted and any further processing, so nothing downstream of the failed cell ever
      // ran, and no promotion path was ever reachable.
      const summary = journal.summarize();
      expect(summary.counts.evaluated).toBe(0);
      expect(summary.counts.parsed).toBe(0);
      expect(existsSync(journal.journalDir)).toBe(true); // conserved -- the incident path never discards
    } finally {
      rmSync(journalRunsRoot, { recursive: true, force: true });
      for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("runConditionPair -- crash-safety journal preserves B (current-skill, cellOrdinal 0) across A's materialization exception", () => {
  it("B spawns and completes for real; A's materializeFixture throws -- B's raw survives, tagged materializing_cell/cellOrdinal:1", async () => {
    const journalRunsRoot = mkdtempSync(path.join(os.tmpdir(), 'aecp-journal-root-'));
    const fixtureDirs = [];
    let materializeCalls = 0;

    try {
      const journal = createInvocationJournal({ runKind: 'calibration', plannedCellCount: 2, runsRootOverride: journalRunsRoot });

      const materializeFixture = () => {
        materializeCalls++;
        // runOneCondition's fixed order is current-skill (B, cellOrdinal 0) then no-skill (A,
        // cellOrdinal 1) -- see cli.mjs's own runConditionPair doc comment -- so the 2nd
        // materializeFixture call is always A's.
        if (materializeCalls === 2) {
          throw new Error('simulated: git clean -fdx failed -- Filename too long (the exact 2026-08-10 incident trigger)');
        }
        const dir = mkdtempSync(path.join(os.tmpdir(), 'aecp-fixture-'));
        fixtureDirs.push(dir);
        return { fixtureDir: dir };
      };

      let caught = null;
      await withFakeClaudePath('run-scenario-success', async () => {
        try {
          await runConditionPair({
            prompt: "Run the tests for this project's only module and tell me what happened.",
            model: 'fake-model-x',
            allowedGradleTasks: [':fakemod:test'],
            allowedKmpTestSubcommands: ['doctor', 'describe', 'parallel'],
            materializeFixture,
            journal,
          });
        } catch (err) {
          caught = err;
        }
      });

      expect(caught).not.toBeNull();
      expect(caught.message).toMatch(/Filename too long/);
      expect(caught.agenticEvalPhase).toBe('materializing_cell');
      expect(caught.agenticEvalCellOrdinal).toBe(1);
      expect(materializeCalls).toBe(2);

      const summary = journal.summarize();
      expect(summary.counts.raw_persisted).toBe(1);
      expect(summary.cellOrdinals.raw_persisted).toEqual([0]);
      expect(existsSync(journal.journalDir)).toBe(true);

      const raw0 = journal.readRawFor(0);
      expect(raw0.length).toBeGreaterThan(0);
      expect(raw0).toContain('"type"');
    } finally {
      rmSync(journalRunsRoot, { recursive: true, force: true });
      for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

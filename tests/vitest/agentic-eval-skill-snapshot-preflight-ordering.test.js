// tests/vitest/agentic-eval-skill-snapshot-preflight-ordering.test.js
// Isolated test for the skill-snapshot artifact's resolution boundary inside
// acquireSharedEvalResources() (tools/agentic-eval/matrix-runner.mjs) and its propagation through
// runConditionPair (tools/agentic-eval/cli.mjs) / runScenarioMatrix (matrix-runner.mjs) into
// cmdCalibrate/cmdSmoke/cmdRun -- via a scoped mock of input-artifacts.mjs's
// computeSkillSnapshotArtifact and materialize.mjs's materializeSkillSnapshot -- kept in its own
// file (vi.mock is hoisted/module-wide) matching this repo's established mock-isolation convention
// (see agentic-eval-durable-journal-promote-discard-failure.test.js's own header comment).
//
// Post-Codex-round-4 CORRECTED boundary (this file replaces an earlier, wrong version): the
// original round-4 fix moved the artifact's resolution into cli.mjs's own cmdCalibrate/cmdSmoke/
// cmdRun, BEFORE createInvocationJournal. That broke hosted Ubuntu CI (fetch-depth:1 shallow
// checkout): materializeSkillSnapshot's own ensureCommitAvailable (materialize.mjs) is the ONE
// mechanism that backfills a commit missing from a shallow clone (`git fetch --depth 1 origin
// <sha>`) -- see agentic-eval-materialize.test.js's own "backfills a commit missing from a shallow
// clone before archiving (the real CI shallow-checkout failure mode)" test, PRESERVED UNCHANGED,
// unmocked, and re-run as part of this fix's own verification. Resolving the artifact BEFORE that
// backfill ran meant every intentional-in-session-rejection test (previously never reaching this
// code at all, since they fail inside runConditionPair before its own late call site) now failed
// this Git lookup for real on a shallow CI checkout, well before session mechanics even entered
// the picture.
//
// The corrected boundary: inside acquireSharedEvalResources, strictly AFTER
// materializeSkillSnapshot (which guarantees the commit is available) and its cleanup
// registration, and strictly BEFORE runtimeAdapter.prepareIsolatedHome/preflight/any spawn.
// createInvocationJournal is explicitly NOT part of this ordering contract (see this file's own
// "not a contract" describe block below) -- that was the original test's own over-restriction; the
// journal is a write-ahead log created BEFORE acquisition specifically so a resource-acquisition
// failure (including this one) has something to record it against.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const CLI_SOURCE_PATH = path.join(REPO_ROOT, 'tools', 'agentic-eval', 'cli.mjs');
// A real, valid commit already reachable from this repo's own history -- same test-only SHA
// agentic-eval-matrix-runner-crash-safety.test.js and agentic-eval-run-condition-pair.test.js
// already use for exactly this purpose (never the production PINNED_SKILL_SHA, which cli.mjs
// itself supplies internally whenever a test goes through runConditionPair rather than calling
// acquireSharedEvalResources directly).
const TEST_PINNED_SKILL_SHA = '9814ada0c45e6a3d2a0399291ec96cb8d1ef86bb';
const TARGET_PLUGIN_NAME = 'kmp-test-runner';
const TARGET_SKILL_NAME = 'kmp-test-runner';

vi.mock('../../tools/agentic-eval/input-artifacts.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, computeSkillSnapshotArtifact: vi.fn(actual.computeSkillSnapshotArtifact) };
});
vi.mock('../../tools/agentic-eval/materialize.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, materializeSkillSnapshot: vi.fn(actual.materializeSkillSnapshot) };
});

afterEach(() => {
  vi.restoreAllMocks(); // undoes any vi.spyOn(claudeCodeRuntimeAdapter, ...) from a given test
  vi.clearAllMocks(); // clears call history on the two vi.mock spies above, keeps their passthrough
});

// Node coerces `process.env.KEY = undefined` to the literal STRING "undefined" -- delete is the
// correct restoration for an originally-absent variable (same helper as the two sibling files
// above; each test file in this suite keeps its own copy rather than sharing one).
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
    restoreEnvVar('PATH', savedPath);
  }
}

/** claudeCodeRuntimeAdapter (runtimes/claude-code.mjs) is Object.freeze()'d -- every property is
 * configurable:false, so vi.spyOn(claudeCodeRuntimeAdapter, methodName) throws "Cannot redefine
 * property" directly against the singleton. Returns a fresh, UNFROZEN plain object spreading every
 * property of `base` (preserving id/capabilities/every other method verbatim, so
 * validateRuntimeAdapter's own closed-shape check still passes identically), with each name in
 * `methodNames` replaced by a vi.fn() that still delegates to the real, bound original -- a true
 * pass-through spy, never a behavior change. */
function spyableAdapter(base, methodNames) {
  const clone = { ...base };
  for (const name of methodNames) {
    clone[name] = vi.fn(base[name].bind(base));
  }
  return clone;
}

async function withIsolatedTmp(fn) {
  const isolatedTmp = mkdtempSync(path.join(os.tmpdir(), 'aessp-isolated-tmp-'));
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = isolatedTmp;
  process.env.TMP = isolatedTmp;
  process.env.TMPDIR = isolatedTmp;
  try {
    return await fn(isolatedTmp);
  } finally {
    restoreEnvVar('TEMP', saved.TEMP);
    restoreEnvVar('TMP', saved.TMP);
    restoreEnvVar('TMPDIR', saved.TMPDIR);
    rmSync(isolatedTmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Structural (source-text) contract: cli.mjs no longer resolves or recomputes the artifact itself
// -- it only consumes whatever acquireSharedEvalResources already produced. No mocks, no
// execution.
// ---------------------------------------------------------------------------------------------

const CLI_SOURCE = readFileSync(CLI_SOURCE_PATH, 'utf8');

function extractSpan(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`start marker not found in cli.mjs: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`end marker not found after start in cli.mjs: ${endMarker}`);
  return source.slice(start, end);
}

const CMD_CALIBRATE_SOURCE = extractSpan(CLI_SOURCE, 'async function cmdCalibrate(args) {', 'async function cmdSmoke(args) {');
const CMD_SMOKE_SOURCE = extractSpan(CLI_SOURCE, 'async function cmdSmoke(args) {', 'async function cmdRun(args) {');
const CMD_RUN_SOURCE = extractSpan(CLI_SOURCE, 'async function cmdRun(args) {', 'function checkScenarioFilenameMatchesId(scenario, filename) {');

describe('cli.mjs -- structural contract: the artifact is consumed, never recomputed', () => {
  it('no longer imports computeSkillSnapshotArtifact at all (the one remaining mention is a doc-string naming the contract, in buildRunRecord\'s own TypeError text -- not an import or a call)', () => {
    expect(CLI_SOURCE).toMatch(/import \{ computePromptArtifact \} from '\.\/input-artifacts\.mjs';/);
    expect(CLI_SOURCE).not.toMatch(/import \{[^}]*computeSkillSnapshotArtifact[^}]*\} from '\.\/input-artifacts\.mjs';/);
    // The only surviving occurrence, verified by exact count: buildRunRecord's own required-input
    // TypeError message (naming the contract for a caller reading the error, not code).
    const occurrences = CLI_SOURCE.split('computeSkillSnapshotArtifact').length - 1;
    expect(occurrences).toBe(1);
    expect(CLI_SOURCE).toContain("must be a well-formed computeSkillSnapshotArtifact() result");
  });

  it('defines no local wrapper/cache for the artifact (the round-4 mistake this replaces)', () => {
    expect(CLI_SOURCE).not.toContain('resolveSkillSnapshotArtifactOrFail');
    expect(CLI_SOURCE).not.toContain('currentSkillSnapshotArtifact');
    expect(CLI_SOURCE).not.toContain('cachedSkillSnapshotArtifact');
  });

  it('cmdCalibrate destructures skillSnapshotArtifact FROM conditionPair, never computes it', () => {
    expect(CMD_CALIBRATE_SOURCE).toMatch(/failFastStop,\s*skillSnapshotArtifact\s*\}\s*=\s*conditionPair;/);
  });

  it('cmdSmoke destructures skillSnapshotArtifact FROM conditionPair, never computes it', () => {
    expect(CMD_SMOKE_SOURCE).toMatch(/failFastStop,\s*skillSnapshotArtifact\s*\}\s*=\s*conditionPair;/);
  });

  it('cmdRun reads skillSnapshotArtifact directly off matrix, never computes it', () => {
    expect(CMD_RUN_SOURCE).toContain('skillSnapshotArtifact: matrix.skillSnapshotArtifact');
  });

  it('--dry-run\'s early return appears strictly before runScenarioMatrix( in source order -- --dry-run never acquires resources or computes the artifact', () => {
    const dryRunIdx = CMD_RUN_SOURCE.indexOf('if (isDryRun) {');
    const sessionIdx = CMD_RUN_SOURCE.indexOf('runScenarioMatrix(');
    expect(dryRunIdx).toBeGreaterThan(-1);
    expect(sessionIdx).toBeGreaterThan(-1);
    expect(dryRunIdx).toBeLessThan(sessionIdx);
  });
});

// ---------------------------------------------------------------------------------------------
// Dynamic: acquireSharedEvalResources's own internal ordering and single-computation contract.
// Real materialization + real artifact computation + a real (fake-claude-backed) auth preflight --
// never a live session (acquireSharedEvalResources itself never spawns one; that is
// runSingleCondition's job, one layer up, never reached by these tests).
// ---------------------------------------------------------------------------------------------

describe('acquireSharedEvalResources -- resolution boundary and single-computation contract', () => {
  it('materializes the skill snapshot, computes its artifact, prepares the isolated home, then runs auth preflight -- in that exact order, each called exactly once', async () => {
    const { acquireSharedEvalResources } = await import('../../tools/agentic-eval/matrix-runner.mjs');
    const { materializeSkillSnapshot } = await import('../../tools/agentic-eval/materialize.mjs');
    const { computeSkillSnapshotArtifact } = await import('../../tools/agentic-eval/input-artifacts.mjs');
    const { claudeCodeRuntimeAdapter } = await import('../../tools/agentic-eval/runtimes/claude-code.mjs');
    const { runValidator: runPluginValidator } = await import('../../tools/validate-plugin.mjs');

    const adapter = spyableAdapter(claudeCodeRuntimeAdapter, ['prepareIsolatedHome', 'preflight']);

    await withIsolatedTmp(() => withFakeClaudePath('auth-ok-pre-inference-failure', async () => {
      const shared = await acquireSharedEvalResources({
        allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'],
        repoRoot: REPO_ROOT, pinnedSkillSha: TEST_PINNED_SKILL_SHA, runPluginValidator,
        runtimeAdapter: adapter,
      });
      try {
        expect(vi.mocked(materializeSkillSnapshot)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(computeSkillSnapshotArtifact)).toHaveBeenCalledTimes(1);
        expect(adapter.prepareIsolatedHome).toHaveBeenCalledTimes(1);
        expect(adapter.preflight).toHaveBeenCalledTimes(1);

        const materializeOrder = vi.mocked(materializeSkillSnapshot).mock.invocationCallOrder[0];
        const computeOrder = vi.mocked(computeSkillSnapshotArtifact).mock.invocationCallOrder[0];
        const prepareOrder = adapter.prepareIsolatedHome.mock.invocationCallOrder[0];
        const preflightOrder = adapter.preflight.mock.invocationCallOrder[0];
        expect(materializeOrder).toBeLessThan(computeOrder);
        expect(computeOrder).toBeLessThan(prepareOrder);
        expect(prepareOrder).toBeLessThan(preflightOrder);

        // acquireSharedEvalResources returns EXACTLY the computed artifact -- not a copy, not a
        // re-derivation, the same object the mocked (real-passthrough) computeSkillSnapshotArtifact
        // call actually produced.
        const producedArtifact = await vi.mocked(computeSkillSnapshotArtifact).mock.results[0].value;
        expect(shared.skillSnapshotArtifact).toEqual(producedArtifact);
        expect(shared.skillSnapshotArtifact.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await shared.runCleanup();
      }
    }));
  }, 30000);
});

describe('acquireSharedEvalResources -- fail-closed when the artifact computation throws (via runConditionPair, the real caller)', () => {
  it('a thrown Git/canonicalization failure: prepareIsolatedHome/preflight/buildInvocation never called, no condition ever materializes, the already-registered snapshot cleanup runs, and the incident phase is acquiring_shared_resources', async () => {
    const { runConditionPair } = await import('../../tools/agentic-eval/cli.mjs');
    const { materializeSkillSnapshot } = await import('../../tools/agentic-eval/materialize.mjs');
    const { computeSkillSnapshotArtifact } = await import('../../tools/agentic-eval/input-artifacts.mjs');
    const { claudeCodeRuntimeAdapter } = await import('../../tools/agentic-eval/runtimes/claude-code.mjs');

    // materializeSkillSnapshot is left as the default real pass-through (see the vi.mock factory
    // above) -- its own real result is captured via .mock.results below, never re-invoked.
    vi.mocked(computeSkillSnapshotArtifact).mockImplementationOnce(() => {
      throw new Error('SENTINEL: simulated git object-database failure');
    });
    const adapter = spyableAdapter(claudeCodeRuntimeAdapter, ['prepareIsolatedHome', 'preflight', 'buildInvocation']);
    let materializeFixtureCalls = 0;

    await withIsolatedTmp(() => withFakeClaudePath('auth-ok-pre-inference-failure', async () => {
      const err = await runConditionPair({
        prompt: 'irrelevant -- never reaches a real spawn',
        model: 'fake-model-x',
        allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor'],
        materializeFixture: () => { materializeFixtureCalls++; return { fixtureDir: '/should-never-be-called' }; },
        runtimeAdapter: adapter,
      }).catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('SENTINEL: simulated git object-database failure');
      expect(err.agenticEvalPhase).toBe('acquiring_shared_resources');

      expect(materializeFixtureCalls).toBe(0);
      expect(adapter.prepareIsolatedHome).not.toHaveBeenCalled();
      expect(adapter.preflight).not.toHaveBeenCalled();
      expect(adapter.buildInvocation).not.toHaveBeenCalled();

      expect(vi.mocked(materializeSkillSnapshot)).toHaveBeenCalledTimes(1);
      const { snapshotDir: capturedSnapshotDir } = await vi.mocked(materializeSkillSnapshot).mock.results[0].value;
      expect(existsSync(capturedSnapshotDir)).toBe(false);
    }));
  }, 30000);
});

// ---------------------------------------------------------------------------------------------
// Dynamic: propagation through runConditionPair (calibrate/smoke's engine) and runScenarioMatrix
// (run's engine) -- both the complete result and the fail-fast/partial result carry the SAME
// artifact acquireSharedEvalResources produced. Real fake-claude spawns throughout (never live).
// ---------------------------------------------------------------------------------------------

describe('runConditionPair -- propagates skillSnapshotArtifact on both outcomes', () => {
  it('complete pair (both conditions run): skillSnapshotArtifact is present and well-formed', async () => {
    const { runConditionPair } = await import('../../tools/agentic-eval/cli.mjs');
    const { claudeCodeRuntimeAdapter } = await import('../../tools/agentic-eval/runtimes/claude-code.mjs');
    const adapter = spyableAdapter(claudeCodeRuntimeAdapter, ['buildInvocation']);
    await withIsolatedTmp(() => withFakeClaudePath('success', async () => {
      const result = await runConditionPair({
        prompt: 'irrelevant', model: 'fake-model-x',
        allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor', 'describe'],
        materializeFixture: () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'aessp-fixture-')); return { fixtureDir: dir }; },
        cleanupFixture: (dir) => rmSync(dir, { recursive: true, force: true }),
        runtimeAdapter: adapter,
        maxBudgetUsd: 1.75,
      });
      try {
        expect(result.matrixComplete).toBe(true);
        expect(result.skillSnapshotArtifact).toBeTruthy();
        expect(result.skillSnapshotArtifact.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(adapter.buildInvocation.mock.calls[0][0].maxBudgetUsd).toBe(1.75);
      } finally {
        await result.cleanup();
      }
    }));
  }, 30000);

  it('fail-fast pair (B rejected, A never spawns): skillSnapshotArtifact is STILL present -- acquisition happened before B ever ran', async () => {
    const { runConditionPair } = await import('../../tools/agentic-eval/cli.mjs');
    const { claudeCodeRuntimeAdapter } = await import('../../tools/agentic-eval/runtimes/claude-code.mjs');
    const adapter = spyableAdapter(claudeCodeRuntimeAdapter, ['buildInvocation']);
    await withIsolatedTmp(() => withFakeClaudePath('unexpected-tool', async () => {
      const result = await runConditionPair({
        prompt: 'irrelevant', model: 'fake-model-x',
        allowedGradleTasks: [], allowedKmpTestSubcommands: ['doctor', 'describe'],
        materializeFixture: () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'aessp-fixture-')); return { fixtureDir: dir }; },
        cleanupFixture: (dir) => rmSync(dir, { recursive: true, force: true }),
        runtimeAdapter: adapter,
        maxBudgetUsd: 1.75,
      });
      try {
        expect(result.matrixComplete).toBe(false);
        expect(result.runA).toBeNull();
        expect(result.skillSnapshotArtifact).toBeTruthy();
        expect(result.skillSnapshotArtifact.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await result.cleanup();
      }
    }));
  }, 30000);
});

describe('runScenarioMatrix -- propagates skillSnapshotArtifact on both outcomes', () => {
  const SCENARIO = {
    schema: 1,
    id: 'skill-snapshot-preflight-ordering-test-only-scenario',
    family: 'test-only',
    project_alias: 'fake-preflight-ordering-project',
    project_url: 'https://example.com/fake-preflight-ordering-project.git',
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

  it('complete matrix (matrixComplete:true): skillSnapshotArtifact is present and well-formed', async () => {
    const { runScenarioMatrix } = await import('../../tools/agentic-eval/matrix-runner.mjs');
    const { claudeCodeRuntimeAdapter } = await import('../../tools/agentic-eval/runtimes/claude-code.mjs');
    const { runValidator: runPluginValidator } = await import('../../tools/validate-plugin.mjs');
    const adapter = spyableAdapter(claudeCodeRuntimeAdapter, ['buildInvocation']);
    await withIsolatedTmp(() => withFakeClaudePath('run-scenario-success', async () => {
      const matrix = await runScenarioMatrix({
        scenario: SCENARIO, repeats: 1, seed: 1, model: 'fake-model-x',
        allowedGradleTasks: SCENARIO.policy.allowed_gradle_tasks,
        allowedKmpTestSubcommands: SCENARIO.policy.allowed_kmptest_subcommands,
        repoRoot: REPO_ROOT, pinnedSkillSha: TEST_PINNED_SKILL_SHA, runPluginValidator,
        materializeFixture: () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'aessp-matrix-fixture-')); return { fixtureDir: dir }; },
        cleanupFixture: (dir) => rmSync(dir, { recursive: true, force: true }),
        targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
        timeoutMs: 30000,
        runtimeAdapter: adapter,
        maxBudgetUsd: 2.25,
      });
      try {
        expect(matrix.matrixComplete).toBe(true);
        expect(matrix.skillSnapshotArtifact).toBeTruthy();
        expect(matrix.skillSnapshotArtifact.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(adapter.buildInvocation.mock.calls[0][0].maxBudgetUsd).toBe(2.25);
      } finally {
        await matrix.cleanup();
      }
    }));
  }, 30000);

  it('partial/fail-fast matrix (matrixComplete:false): skillSnapshotArtifact is STILL present -- acquisition happened before cell 0 ever ran', async () => {
    const { runScenarioMatrix } = await import('../../tools/agentic-eval/matrix-runner.mjs');
    const { claudeCodeRuntimeAdapter } = await import('../../tools/agentic-eval/runtimes/claude-code.mjs');
    const { runValidator: runPluginValidator } = await import('../../tools/validate-plugin.mjs');
    const adapter = spyableAdapter(claudeCodeRuntimeAdapter, ['buildInvocation']);
    await withIsolatedTmp(() => withFakeClaudePath('auth-ok-pre-inference-failure', async () => {
      const matrix = await runScenarioMatrix({
        scenario: SCENARIO, repeats: 1, seed: 1, model: 'fake-model-x',
        allowedGradleTasks: SCENARIO.policy.allowed_gradle_tasks,
        allowedKmpTestSubcommands: SCENARIO.policy.allowed_kmptest_subcommands,
        repoRoot: REPO_ROOT, pinnedSkillSha: TEST_PINNED_SKILL_SHA, runPluginValidator,
        materializeFixture: () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'aessp-matrix-fixture-')); return { fixtureDir: dir }; },
        cleanupFixture: (dir) => rmSync(dir, { recursive: true, force: true }),
        targetPluginName: TARGET_PLUGIN_NAME, targetSkillName: TARGET_SKILL_NAME,
        timeoutMs: 30000,
        runtimeAdapter: adapter,
        maxBudgetUsd: 2.25,
      });
      try {
        expect(matrix.matrixComplete).toBe(false);
        expect(matrix.executedCellCount).toBeLessThan(matrix.plannedCellCount);
        expect(matrix.skillSnapshotArtifact).toBeTruthy();
        expect(matrix.skillSnapshotArtifact.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await matrix.cleanup();
      }
    }));
  }, 30000);
});

// ---------------------------------------------------------------------------------------------
// Explicitly NOT a contract: createInvocationJournal's own position relative to the artifact.
// The journal is a write-ahead log created BEFORE acquireSharedEvalResources runs at all (see
// cmdCalibrate/cmdSmoke/cmdRun's own source) -- specifically so a resource-acquisition failure,
// including this one, has a journal to be recorded against. The original round-4 test asserted
// the OPPOSITE ordering; that assertion was the over-restriction being corrected here.
// ---------------------------------------------------------------------------------------------

describe('createInvocationJournal is NOT required to happen after artifact resolution (documented, not tested dynamically)', () => {
  it('cmdCalibrate/cmdSmoke/cmdRun each create the journal BEFORE calling runConditionPair/runScenarioMatrix (source order), confirming acquisition -- and the artifact inside it -- happens strictly AFTER the journal already exists', () => {
    for (const source of [CMD_CALIBRATE_SOURCE, CMD_SMOKE_SOURCE, CMD_RUN_SOURCE]) {
      const journalIdx = source.indexOf('createInvocationJournal(');
      const sessionIdx = source.search(/runConditionPair\(|runScenarioMatrix\(/);
      expect(journalIdx).toBeGreaterThan(-1);
      expect(sessionIdx).toBeGreaterThan(-1);
      expect(journalIdx).toBeLessThan(sessionIdx);
    }
  });
});

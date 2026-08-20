// tests/vitest/agentic-eval-skill-snapshot-preflight-ordering.test.js
// Isolated test for cli.mjs's cmdCalibrate/cmdSmoke/cmdRun skill-snapshot preflight ordering --
// via a scoped mock of input-artifacts.mjs's computeSkillSnapshotArtifact, durable-journal.mjs's
// createInvocationJournal, and matrix-runner.mjs's acquireSharedEvalResources/runScenarioMatrix --
// kept in its own file (vi.mock is hoisted/module-wide) matching this repo's established
// mock-isolation convention (see agentic-eval-durable-journal-promote-discard-failure.test.js's
// own header comment).
//
// Post-Codex-round-4 audit finding (P1): currentSkillSnapshotArtifact()'s own doc comment
// documents it as resolved "before the first session", but cmdCalibrate/cmdSmoke/cmdRun each
// called it only AFTER their live session(s) had already run (runConditionPair/runScenarioMatrix),
// so a Git or canonicalization failure there discarded an already-spent matrix of live sessions
// instead of failing closed before any of them started. The fix adds ONE shared, fail-closed
// preflight step (resolveSkillSnapshotArtifactOrFail) each command now calls exactly once, before
// createInvocationJournal and before any spawn.
//
// Two independent contracts, deliberately separated (per review-round-4 direction):
//   1. STRUCTURAL (below, no mocks, no execution): reads cli.mjs as text, delimits each command's
//      own function body by source position, and asserts the wrapper call's position relative to
//      createInvocationJournal/runConditionPair/runScenarioMatrix/the --dry-run early-return, and
//      that no direct late call to currentSkillSnapshotArtifact() remains in any of the three
//      spans. This is what actually proves per-command PLACEMENT -- a dynamic test exercising only
//      cmdCalibrate (the one command reachable without a live-work fixture) cannot, by itself,
//      prove cmdSmoke/cmdRun are correctly ordered too.
//   2. DYNAMIC fail-closed (bottom): proves the shared wrapper's OWN behavior end-to-end through
//      cmdCalibrate -- the only one of the three reachable without a source-repo-dir/scenario/real
//      git fixture -- confirming a thrown Git failure exits 1 with a bounded message and starts
//      zero journals, zero live-adjacent resource acquisition, and zero sessions.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_SOURCE_PATH = path.join(REPO_ROOT, 'tools', 'agentic-eval', 'cli.mjs');

vi.mock('../../tools/agentic-eval/input-artifacts.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, computeSkillSnapshotArtifact: vi.fn(actual.computeSkillSnapshotArtifact) };
});
vi.mock('../../tools/agentic-eval/durable-journal.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createInvocationJournal: vi.fn(actual.createInvocationJournal) };
});
vi.mock('../../tools/agentic-eval/matrix-runner.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    acquireSharedEvalResources: vi.fn(actual.acquireSharedEvalResources),
    runScenarioMatrix: vi.fn(actual.runScenarioMatrix),
  };
});

// ---------------------------------------------------------------------------------------------
// Contract 1: structural -- source-text analysis only, zero execution, zero mocks consumed.
// ---------------------------------------------------------------------------------------------

const CLI_SOURCE = readFileSync(CLI_SOURCE_PATH, 'utf8');

function extractSpan(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`start marker not found in cli.mjs: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`end marker not found after start in cli.mjs: ${endMarker}`);
  return source.slice(start, end);
}

function countOccurrences(text, substring) {
  return text.split(substring).length - 1;
}

function firstIndexOrThrow(text, substring, label) {
  const idx = text.indexOf(substring);
  if (idx === -1) throw new Error(`expected to find ${label} ("${substring}") in this span`);
  return idx;
}

// Boundaries are the next sibling top-level declaration in cli.mjs's own real source order --
// deliberately NOT brace-matched (a naive brace counter would mis-parse braces embedded in string
// literals/comments elsewhere in these bodies); every marker below was verified via direct
// inspection to occur nowhere else between its own span's start and end.
const CMD_CALIBRATE_SOURCE = extractSpan(CLI_SOURCE, 'async function cmdCalibrate(args) {', 'async function cmdSmoke(args) {');
const CMD_SMOKE_SOURCE = extractSpan(CLI_SOURCE, 'async function cmdSmoke(args) {', 'async function cmdRun(args) {');
const CMD_RUN_SOURCE = extractSpan(CLI_SOURCE, 'async function cmdRun(args) {', 'function checkScenarioFilenameMatchesId(scenario, filename) {');

const WRAPPER_CALL = 'resolveSkillSnapshotArtifactOrFail(';
const LATE_DIRECT_CALL = 'currentSkillSnapshotArtifact(';

describe.each([
  ['cmdCalibrate', CMD_CALIBRATE_SOURCE, 'createInvocationJournal(', 'runConditionPair('],
  ['cmdSmoke', CMD_SMOKE_SOURCE, 'createInvocationJournal(', 'runConditionPair('],
  ['cmdRun', CMD_RUN_SOURCE, 'createInvocationJournal(', 'runScenarioMatrix('],
])('%s -- skill-snapshot preflight is structurally correct (source-text contract)', (name, source, journalCall, sessionCall) => {
  it('resolves the skill-snapshot artifact exactly once, via the shared fail-closed wrapper', () => {
    expect(countOccurrences(source, WRAPPER_CALL)).toBe(1);
  });

  it('leaves no direct late call to currentSkillSnapshotArtifact() -- only the wrapper calls it, elsewhere in the file', () => {
    expect(countOccurrences(source, LATE_DIRECT_CALL)).toBe(0);
  });

  it(`resolves strictly before ${journalCall}`, () => {
    const wrapperIdx = firstIndexOrThrow(source, WRAPPER_CALL, 'the wrapper call');
    const journalIdx = firstIndexOrThrow(source, journalCall, journalCall);
    expect(wrapperIdx).toBeLessThan(journalIdx);
  });

  it(`resolves strictly before ${sessionCall}`, () => {
    const wrapperIdx = firstIndexOrThrow(source, WRAPPER_CALL, 'the wrapper call');
    const sessionIdx = firstIndexOrThrow(source, sessionCall, sessionCall);
    expect(wrapperIdx).toBeLessThan(sessionIdx);
  });
});

describe('cmdRun -- --dry-run source-text contract', () => {
  it('the --dry-run early return appears strictly before the preflight wrapper call', () => {
    const dryRunIdx = firstIndexOrThrow(CMD_RUN_SOURCE, 'if (isDryRun) {', 'the --dry-run branch');
    const wrapperIdx = firstIndexOrThrow(CMD_RUN_SOURCE, WRAPPER_CALL, 'the wrapper call');
    expect(dryRunIdx).toBeLessThan(wrapperIdx);
  });
});

// ---------------------------------------------------------------------------------------------
// Contract 2: dynamic fail-closed -- proves the shared wrapper's own behavior, exercised through
// cmdCalibrate only (the one command reachable with zero fixtures: no source-repo-dir, no
// scenario, no real git clone -- resolveSelectionOrFail({}) already resolves the real default
// selection, and validatePrivatePatternsFileOrFail(null)/resolveMeasurementScopeOrFail(null) both
// succeed on omitted flags). cmdSmoke/cmdRun's OWN placement is already proven above by Contract
// 1 -- this does not re-prove placement, only the wrapper's shared fail-closed translation.
// ---------------------------------------------------------------------------------------------

afterEach(() => {
  vi.clearAllMocks();
});

describe('cmdCalibrate -- skill-snapshot preflight is fail-closed before any journal or live work', () => {
  it('a thrown Git/canonicalization failure exits 1 with a bounded message, before any journal, resource acquisition, or session', async () => {
    const { cmdCalibrate } = await import('../../tools/agentic-eval/cli.mjs');
    const { computeSkillSnapshotArtifact } = await import('../../tools/agentic-eval/input-artifacts.mjs');
    const { createInvocationJournal } = await import('../../tools/agentic-eval/durable-journal.mjs');
    const { acquireSharedEvalResources, runScenarioMatrix } = await import('../../tools/agentic-eval/matrix-runner.mjs');

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(computeSkillSnapshotArtifact).mockImplementationOnce(() => {
      throw new Error('SENTINEL: simulated git object-database failure');
    });
    // Safety net, independent of the fix under test: acquireSharedEvalResources is the ONE real
    // gateway to live-adjacent work (real mkdtempSync/git-materialize, then the runtime adapter's
    // own spawn) for every one of the three commands (runConditionPair calls it directly for
    // cmdCalibrate/cmdSmoke; runScenarioMatrix calls it internally for cmdRun). Mocking it to also
    // throw immediately means that even against the UNFIXED tree -- where the snapshot check still
    // ran too late to prevent this call from being reached at all -- this test can never trigger a
    // real spawn or real fixture materialization while proving the RED case; it can only ever
    // observe whether the call happened, which is exactly this test's own assertion.
    vi.mocked(acquireSharedEvalResources).mockImplementationOnce(() => {
      throw new Error('SAFETY-NET SENTINEL: acquireSharedEvalResources must not be reached when the skill-snapshot preflight already failed');
    });
    try {
      const result = await cmdCalibrate({});

      expect(result).toBe(1);
      expect(vi.mocked(computeSkillSnapshotArtifact)).toHaveBeenCalledTimes(1);
      // No live-adjacent resource acquisition, no session -- the failure never got past this
      // preflight step.
      expect(acquireSharedEvalResources).not.toHaveBeenCalled();
      expect(runScenarioMatrix).not.toHaveBeenCalled();
      // No journal either -- the preflight step runs strictly before createInvocationJournal (see
      // the source-text Contract 1 tests above); createInvocationJournal itself is left as a real
      // pass-through here deliberately (a journal write is fast/local/gitignored and harmless, so
      // this assertion is a genuine, unmocked observation, not one made safe only by a thrown
      // safety net).
      expect(createInvocationJournal).not.toHaveBeenCalled();

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const [message] = stderrSpy.mock.calls[0];
      expect(message).toContain('SENTINEL: simulated git object-database failure');
      // Bounded -- the underlying error's own message, wrapped in one fixed sentence, never a raw
      // multi-line stack trace.
      expect(message.length).toBeLessThan(300);
      expect(message).not.toMatch(/\n\s*at /);
      // Zero files, journals, incidents, raw, or records created -- the failure never got past
      // the wrapper. (A success-path dynamic test proving journal creation is subsequently
      // ATTEMPTED is deliberately not included here: cmdCalibrate never exposes a runsRootOverride
      // seam, so exercising that path for real would write a real journal/incident into the
      // production tools/runs/ tree on every CI run -- exactly what this requirement forbids.
      // Contract 1's structural tests above already prove that same success-path ordering fact,
      // with zero execution and zero side effects.)
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// tests/vitest/agentic-eval-cli-integration.test.js
// Real end-to-end integration tests for tools/agentic-eval/cli.mjs's calibrate/smoke commands,
// run as REAL `node cli.mjs ...` subprocesses against the fake `claude` fixtures under
// tests/fixtures/fake-claude-*/ (never the real claude CLI -- zero API cost, zero live
// authentication needed). Exercises the harness's OWN orchestration: privacy wiring
// (assertCleanOrThrow actually runs), gate-before-write (no committable evidence on any
// failure), the strengthened hard acceptance gates, wall_clock_ms, and cleanup (no leftover
// temp dirs/worktrees after either a passing or failing run).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';
import { LATEST_RUN_SCHEMA } from '../../tools/agentic-eval/schemas.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'tools', 'agentic-eval', 'cli.mjs');
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

// Every subprocess this file spawns writes its evidence under KMP_EVAL_RUNS_ROOT (cli.mjs's own
// override, see cli.mjs's RUNS_ROOT comment), pointed at a fresh, per-test, exclusive temp
// directory -- NEVER the real, shared tools/runs/agentic-eval-{calibration,smoke}/ tree. An
// earlier version of this file read/wrote/deleted directly under the real tree, including an
// unconditional recursive delete of its 'raw/' subdirectory in a top-level afterEach -- running
// this suite while real committed evidence existed there would have destroyed it. With a fresh
// runsRoot per test, "what did this run write" is exactly listEvidenceFiles(runKind) with no
// diffing needed, and cleanup is just deleting the whole isolated directory.
//
// TEMP/TMP/TMPDIR are isolated separately (not inside runsRoot) so the "no leftover temp
// directories" assertions stay meaningful: runsRoot's evidence files are the run's intended
// output (expected non-empty on success), while isolatedTmp holds materialize.mjs's own
// mkdtempSync(tmpdir()) scratch dirs (expected EMPTY once cleanup has run). os.tmpdir() is a
// GLOBAL, shared resource -- vitest runs test FILES concurrently by default, and
// agentic-eval-materialize.test.js's own tests create temp dirs with the exact same
// kmp-agentic-eval-* prefix cli.mjs itself uses (they call the same underlying materialize.mjs
// functions directly). A naive "count matching dirs before/after" leak check is flaky under that
// concurrency -- confirmed empirically (a real, one-off leak this WAS designed to catch got
// masked by noisy +2/+3 deltas from unrelated concurrent tests once the suite ran as a whole, not
// in isolation). Redirecting TEMP/TMP/TMPDIR to a fresh, test-exclusive directory for the
// subprocess makes every mkdtempSync(tmpdir()) call inside it land somewhere no other test can
// ever touch, so "is it empty after cleanup" is exact and non-flaky regardless of what else is
// running concurrently.
let runsRoot;
let isolatedTmp;

beforeEach(() => {
  runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aeci-runs-root-'));
  isolatedTmp = mkdtempSync(path.join(os.tmpdir(), 'aeci-isolated-tmp-'));
});

afterEach(() => {
  rmSync(runsRoot, { recursive: true, force: true });
  rmSync(isolatedTmp, { recursive: true, force: true });
});

function fakeClaudeEnv(scenario) {
  const fakeDir = path.join(FIXTURES_DIR, `fake-claude-${scenario}`);
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return {
    ...process.env,
    PATH: `${fakeDir}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
    KMP_EVAL_RUNS_ROOT: runsRoot,
    TEMP: isolatedTmp,
    TMP: isolatedTmp,
    TMPDIR: isolatedTmp,
  };
}

/** Async spawn, never spawnSync -- mirrors agentic-eval-run-command.test.js's own identical fix
 * and its rationale exactly: this file grew to 34 real subprocess invocations (this PR's own
 * isolation-attestation-ordering describe block added 5 of them), and its own synchronous
 * cumulative blocking measured 61574ms / 60222ms wall-clock on Windows-with-coverage in local-ci
 * -- just over Vitest's own ~60s worker-RPC heartbeat window, reproducing the identical
 * "[vitest-worker]: Timeout calling \"onTaskUpdate\"" unhandled error on two separate Lane All
 * runs, even though every one of this file's own 34 tests passed cleanly both times (this is a
 * demonstrated, reproducible relationship -- 60000ms RPC timeout vs. this file's own measured
 * 60222-61574ms synchronous duration -- not an unrelated flake). Same external contract as the
 * spawnSync-based helper it replaces: resolves to `{status, stdout, stderr, parsed}`, `parsed`
 * is `null` on anything that doesn't parse as JSON, `status` is the child's real exit code (or
 * `null` if the 30s safety timeout killed it first). Every caller must `await` this. */
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI_PATH, ...args], { env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill();
    }, 30000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        resolve({ status: null, stdout, stderr, parsed: null });
        return;
      }
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* stderr-only failure path -- fine */ }
      resolve({ status: code, stdout, stderr, parsed });
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: `${stderr}\n${err.message}`, parsed: null });
    });
  });
}

function evidenceDirFor(runKind) {
  return path.join(runsRoot, `agentic-eval-${runKind}`);
}

function listEvidenceFiles(runKind) {
  const dir = evidenceDirFor(runKind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json'));
}

describe('cli.mjs calibrate -- real subprocess against fake claude (no live API cost)', () => {
  it('success scenario: passes the hard gate, writes schema-valid evidence, sets a real wall_clock_ms', async () => {
    const result = await runCli(['calibrate', '--model', 'claude-sonnet-5'], fakeClaudeEnv('success'));
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    const { recordA, recordB } = result.parsed;
    expect(recordA.skill_available.value).toBe(false);
    expect(recordB.skill_available.value).toBe(true);
    expect(recordA.skill_invocation_attempted.value).toBe(true);
    expect(recordB.skill_invocation_attempted.value).toBe(true);
    expect(recordA.skill_invoked.value).toBe(false);
    expect(recordB.skill_invoked.value).toBe(true);
    // 2 Bash calls + 1 Skill attempt each -- regression coverage for a real undercount an
    // independent review pass found: tool_calls_total previously added a flat 0-or-1 for the
    // Skill contribution regardless of how many Skill attempts actually occurred.
    expect(recordA.tool_calls_total.value).toBe(3);
    expect(recordB.tool_calls_total.value).toBe(3);
    expect(recordA.model_requested).toBe('claude-sonnet-5');
    // Stage 6 (agentic-eval-runtime-neutral-records-v1): proves the 4 new schema:6 groups are a
    // REAL, complete projection against a real fake-claude calibrate run (see smoke's identical
    // proof below for the full rationale on why cli_version/model_resolved are checked
    // structurally rather than by exact string).
    for (const record of [recordA, recordB]) {
      expect(record.agent_runtime.runtime_id).toBe('claude-code');
      expect(record.agent_runtime.model_requested).toBe('claude-sonnet-5');
      expect(record.agent_runtime.model_vendor_expected).toBe('anthropic');
      expect(typeof record.agent_runtime.cli_version).toBe('string');
      expect(typeof record.agent_runtime.model_resolved).toBe('string');
      expect(record.execution_profile).toEqual({
        id: 'strict-policy-v1', sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        isolation_kind: 'runtime-policy-hooks', isolation_attestation_sha256: null, network_mode: 'runtime-default',
        isolation_attestation_required: false, policy_mode: 'required', required_capabilities: ['softPermissionDenial'],
      });
      expect(record.skill_observation.delivery_mode).toBe(record.condition === 'current-skill' ? 'runtime-extension' : 'none');
      expect(record.skill_observation.treatment_size.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(record.usage).not.toBeNull();
      expect(['runtime-reported', 'not-recorded']).toContain(record.usage.source);
      expect(record.usage.attributable_to_skill_load.status).toBe('not-recorded');
    }
    expect(typeof recordA.wall_clock_ms).toBe('number');
    expect(recordA.wall_clock_ms).toBeGreaterThanOrEqual(0);
    // started_at/ended_at must be genuinely captured before/after the spawn, not two nowIso()
    // calls back-to-back after the fact -- ended_at can never be BEFORE started_at.
    expect(new Date(recordA.ended_at).getTime()).toBeGreaterThanOrEqual(new Date(recordA.started_at).getTime());

    const written = listEvidenceFiles('calibration');
    expect(written.length).toBe(2);
    for (const f of written) {
      const record = JSON.parse(readFileSync(path.join(evidenceDirFor('calibration'), f), 'utf8'));
      // decision 6: every subcommand (calibrate included) stamps LATEST_RUN_SCHEMA on new
      // records going forward -- calibrate's own grading_checks/repetition_index (v2-only
      // fields, decisions 11/14) correctly report null+reason, since grading doesn't apply to a
      // calibration run at all, never "not tracked" (that wording is reserved for genuinely
      // unmeasured metrics on an applicable record).
      expect(record.schema).toBe(LATEST_RUN_SCHEMA);
      expect(record.grading_checks.value).toBeNull();
      expect(record.grading_checks.reason).toMatch(/not applicable/i);
      expect(record.repetition_index).toBeNull();
      // Regression lock: calibrate/smoke's notes must stay EXACTLY this foundation-harness
      // string, unchanged by the scenario-specific notes branch added alongside this test.
      expect(record.notes).toBe('Foundation-harness run; not a benchmark result.');
      // accepted-run-observability PR: calibrate's pair-based writer is untouched -- no sidecar,
      // no accepted_audit, for a non-scenario record.
      expect(record.accepted_audit).toBeNull();
    }
    // The pair-based writer never creates an audit/ directory at all (only the scenario-matrix
    // writer does, and only for accepted records).
    expect(existsSync(path.join(evidenceDirFor('calibration'), 'audit'))).toBe(false);
  }, 20000);

  // Regression coverage for a real gap an independent review pass found: raw_capture_location was
  // a hardcoded 'tools/runs/...' literal regardless of where the raw transcript ACTUALLY landed --
  // wrong (and only .gitignore-covered) once KMP_EVAL_RUNS_ROOT is set, which every test in this
  // file already does. Fixed: the field is honest about a non-default root, and the actual
  // override path (runsRoot, a temp directory) is never itself written into the record.
  it('discloses a non-default KMP_EVAL_RUNS_ROOT honestly, never leaking the real override path', async () => {
    const result = await runCli(['calibrate', '--model', 'claude-sonnet-5'], fakeClaudeEnv('success'));
    expect(result.status).toBe(0);
    const { recordA, recordB } = result.parsed;
    for (const record of [recordA, recordB]) {
      expect(record.raw_capture_location).toBe('(KMP_EVAL_RUNS_ROOT override -- see errors[])');
      expect(record.raw_capture_location).not.toContain(runsRoot);
      expect(record.errors.some((e) => e.code === 'raw_capture_location_overridden')).toBe(true);
    }
  }, 20000);

  // This fixture's no-skill arm (A) genuinely attempts nothing; its current-skill arm (B)
  // genuinely attempts AND succeeds (mirrors the success fixture's own Skill-invocation shape).
  // A prior version of calibrationHardGate rejected this shape (required A to ATTEMPT the call
  // before trusting it) -- a real live run hit exactly this shape (2026-07-19 agentic-eval
  // revalidation) and review established the requirement itself was wrong: a model correctly
  // recognizing the skill isn't in its available tool list and not trying it at all is just as
  // legitimate no-skill-arm proof as trying it and getting `Unknown skill` back. This is now a
  // PASS. Calibrate's remaining failure mode against this fixture family -- B failing to confirm
  // invocation -- is deliberately left to agentic-eval-hard-gates.test.js's synthetic unit tests
  // only, not a new fake-claude fixture, mirroring this same file's own established precedent for
  // smoke's 'all-denied' scenario (see its comment above): fabricating a realistic transcript
  // shape that isn't independently verified anywhere isn't worth the guesswork.
  it('no-tool-use scenario: A never attempting the skill is a legitimate no-skill shape -- passes and writes evidence', async () => {
    const result = await runCli(['calibrate', '--model', 'claude-sonnet-5'], fakeClaudeEnv('no-tool-use'));
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    const { recordA, recordB } = result.parsed;
    expect(recordA.skill_available.value).toBe(false);
    expect(recordA.skill_invocation_attempted.value).toBe(false);
    expect(recordA.skill_invoked.value).toBe(false);
    expect(recordB.skill_available.value).toBe(true);
    expect(recordB.skill_invocation_attempted.value).toBe(true);
    expect(recordB.skill_invoked.value).toBe(true);
    expect(listEvidenceFiles('calibration').length).toBe(2);
  }, 20000);

  // Regression coverage for a real bypass an independent review pass demonstrated: only
  // smokeHardGate had cleanTranscriptOk -- a malformed/truncated JSONL line could hide exactly a
  // Skill tool_use or its own result, artificially producing a "clean" attempted:false shape the
  // relaxed no-skill contract now legitimately tolerates. Reuses the same fake-claude-malformed
  // fixture smoke's own cleanTranscriptOk test uses.
  //
  // Fail-fast (preserve rejected matrix forensics) changes this fixture's own observable
  // behavior exactly like smoke's identical fixture above: current-skill (B) runs FIRST and
  // fails its own local cleanTranscriptOk check immediately -- no-skill (A) is NEVER spawned, so
  // calibrationHardGate's two-sided reason (with checks like skillSelectionOk/currentInvocationOk,
  // which cellTranscriptIntegrityOk's canonical 15 do not cover -- skillSelectionOk specifically
  // because it needs matrix-wide sharedAmbientNames that don't exist yet) never gets built at all.
  it('malformed-transcript scenario: fail-fast stops after current-skill fails its own cleanTranscriptOk check, never spawns no-skill, and writes NO evidence', async () => {
    const result = await runCli(['calibrate', '--model', 'claude-sonnet-5'], fakeClaudeEnv('malformed'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CALIBRATION FAILED');
    expect(result.stderr).toContain('cleanTranscriptOk:false');
    expect(result.stderr).toContain('availabilityOk:true');
    expect(result.stderr).toContain('pluginProfileOk:true');
    expect(listEvidenceFiles('calibration').length).toBe(0);
    expect(result.stderr).toContain('rejected-run diagnostics written');
    expect(result.stderr).toContain('1 raw transcript(s) preserved locally');
  }, 20000);

  // preserve rejected matrix forensics: unlike the malformed-transcript/unexpected-tool fixtures
  // above (static, no invocation counter -- they prove the ONE session that ran looks rejected, but
  // not that a SECOND session never happened), fake-claude-failfast-pair/claude counts its own
  // invocations (see its own header comment) so this test can assert on the actual count: a broken
  // fail-fast (e.g. runConditionPair spawning A regardless of B's own local verdict) would still
  // show a rejection here, but the probe log would carry a second line.
  it('failfast-pair scenario (invocation-counted fixture): fail-fast stops after current-skill (B) fails locally -- EXACTLY ONE live session, no-skill (A) never spawned', async () => {
    const probeLogPath = path.join(isolatedTmp, 'failfast-pair-invocations.log');
    // CodeRabbit review finding (PR #417): make the isolation precondition this test's own
    // invocation-count assertion depends on EXPLICIT, not merely implicit -- isolatedTmp is a
    // fresh mkdtempSync() directory from this file's own beforeEach (never shared across tests,
    // never reused), so the probe log genuinely cannot pre-exist here; asserting it demonstrates
    // that guarantee rather than assuming it silently.
    expect(existsSync(probeLogPath)).toBe(false);
    const result = await runCli(['calibrate', '--model', 'claude-sonnet-5'], fakeClaudeEnv('failfast-pair'));
    expect(result.status).toBe(1);
    expect(existsSync(probeLogPath)).toBe(true);
    const invocationLines = readFileSync(probeLogPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(invocationLines.length).toBe(1);
    expect(result.stderr).toContain('CALIBRATION FAILED');
    expect(result.stderr).toContain('toolProfileOk:false');
    expect(result.stderr).toContain('noUnexpectedToolsOk:false');
    expect(result.stderr).toContain('availabilityOk:true');
    expect(listEvidenceFiles('calibration').length).toBe(0);
    expect(result.stderr).toContain('rejected-run diagnostics written');
    expect(result.stderr).toContain('1 raw transcript(s) preserved locally');
  }, 20000);

  // Regression coverage for a real evidence-contamination bypass an independent review pass
  // demonstrated directly against calibrationHardGate: A calling an entirely UNRELATED skill
  // (not kmp-test-runner) is invisible to findSkillInvocation (scoped to kmp-test-runner only),
  // so A's own attempted/invoked both still read false for kmp-test-runner -- the exact same
  // shape the 'no-tool-use' scenario above legitimately tolerates. Without skillSelectionOk this
  // fixture would pass the gate outright and write evidence for a run that actually invoked a
  // DIFFERENT skill entirely. Proves the fix is wired up end-to-end (real stream-json parsing,
  // not just the synthetic unit tests in agentic-eval-hard-gates.test.js) and writes NO evidence.
  //
  // Round-5 audit correction: this fixture's foreign-skill tool_result has no `is_error` key, so
  // it's a CONFIRMED foreign invocation (not "rejected" as this test was previously titled) --
  // see the fixture's own header comment. calibrationHardGate's contract is unchanged by the
  // result-aware classifier PR, so this correctly still fails regardless of the confirmed/
  // rejected distinction; the title now says what's actually being tested.
  it('foreign-skill scenario: A calling an unrelated Skill that gets CONFIRMED is rejected by the gate (evidence-contamination bypass) and writes NO evidence', async () => {
    const result = await runCli(['calibrate', '--model', 'claude-sonnet-5'], fakeClaudeEnv('foreign-skill'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CALIBRATION FAILED');
    expect(result.stderr).toContain('skillSelectionOk:false');
    expect(result.stderr).toContain('availabilityOk:true');
    expect(result.stderr).toContain('noSkillSafetyOk:true');
    expect(result.stderr).toContain('currentInvocationOk:true');
    expect(listEvidenceFiles('calibration').length).toBe(0);
  }, 20000);

  // preserve rejected matrix forensics: this fixture is the one already-established case where
  // BOTH sides genuinely run to completion before the gate rejects (skillSelectionOk is only
  // evaluated by the ordinary two-sided gate, never by fail-fast's own canonical 15 checks -- see
  // cell-integrity.mjs's own doc comment) -- exactly the shape needed to verify captureOrdinal
  // reflects TRUE execution order, not parameter-list order. runConditionPair always spawns B
  // (current-skill) before A (no-skill); a caller that instead assigned ordinals by the
  // (recordA, recordB) parameter order alone would silently swap them.
  it('captureOrdinal in the persisted transcript filenames reflects TRUE execution order (B=current-skill first=0, A=no-skill second=1), never parameter-list order', async () => {
    const result = await runCli(['calibrate', '--model', 'claude-sonnet-5'], fakeClaudeEnv('foreign-skill'));
    expect(result.status).toBe(1);
    const rejectionIdMatch = result.stderr.match(/rejection_id ([0-9a-f-]{36})/i);
    expect(rejectionIdMatch).not.toBeNull();
    const rejectionId = rejectionIdMatch[1];
    const local = JSON.parse(readFileSync(path.join(runsRoot, 'agentic-eval-rejected', 'raw', `${rejectionId}.json`), 'utf8'));
    expect(local.cells.length).toBe(2);
    const cellB = local.cells.find((c) => c.condition === 'current-skill');
    const cellA = local.cells.find((c) => c.condition === 'no-skill');
    expect(cellB.transcript_filename).toMatch(/^0-[0-9a-f]{64}\.jsonl$/);
    expect(cellA.transcript_filename).toMatch(/^1-[0-9a-f]{64}\.jsonl$/);
    // Both transcripts genuinely exist under the ordinal this test just asserted on.
    const transcriptsDir = path.join(runsRoot, 'agentic-eval-rejected', 'raw', 'transcripts', rejectionId);
    expect(existsSync(path.join(transcriptsDir, cellB.transcript_filename))).toBe(true);
    expect(existsSync(path.join(transcriptsDir, cellA.transcript_filename))).toBe(true);
  }, 20000);

  it('leaves no leftover temp directories after a passing run (cleanup ran)', async () => {
    const result = await runCli(['calibrate', '--model', 'claude-sonnet-5'], fakeClaudeEnv('success'));
    expect(result.status).toBe(0);
    expect(readdirSync(isolatedTmp)).toEqual([]);
  }, 20000);

  // Round-7 audit finding: a resource-acquisition failure BEFORE any Claude session even spawns
  // (runConditionPair's own await sat outside cmdCalibrate's try block) previously escaped
  // uncaught all the way to main()'s top-level catch -- exit 2 with a raw stack trace, never this
  // command's own "CALIBRATION FAILED: <reason>" / exit 1 contract every OTHER failure path here
  // already honors. TEMP/TMP/TMPDIR pointed at a non-existent directory forces
  // acquireSharedEvalResources' own real mkdtempSync call to throw, deterministically, without
  // needing to reproduce the original (never-confirmed) CI-only trigger.
  //
  // Materializer-journal PR: the message itself changed -- the old unconditional "session
  // acquisition/spawn threw before any condition completed" claim is replaced with real, honest
  // counters (this is the "failure before the first spawn: zero counters" case). Never a stack
  // trace or an absolute path in stderr either -- see incident-diagnostics.mjs's finalizeIncident.
  it('a resource-acquisition failure (mkdtempSync throwing on a broken TEMP dir) fails cleanly with exit 1, real zero counters, never an uncaught exit 2', async () => {
    const brokenTemp = path.join(isolatedTmp, 'this-directory-does-not-exist');
    const env = { ...fakeClaudeEnv('success'), TEMP: brokenTemp, TMP: brokenTemp, TMPDIR: brokenTemp };
    const result = await runCli(['calibrate', '--model', 'claude-sonnet-5'], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CALIBRATION FAILED');
    expect(result.stderr).toMatch(/0\/2 cells evaluated/);
    expect(result.stderr).toMatch(/0 spawned/);
    // Never the raw, unhandled "agentic-eval: <stack>" shape main()'s own top-level catch writes.
    expect(result.stderr).not.toMatch(/^agentic-eval:/m);
    // Never a stack trace or an absolute path -- the exact bug this PR fixes.
    expect(result.stderr).not.toMatch(/\bat \S+ \(/); // no "at functionName (" stack-frame shape
    expect(result.stderr).not.toContain(runsRoot);
    expect(result.stderr).not.toContain(isolatedTmp);
  }, 20000);

  // Adversarial-review finding: createInvocationJournal() is called before cmdCalibrate's own
  // try/catch -- its own realistic failure mode (isRawDirSafeFromAccidentalCommit failing closed)
  // was completely untested, because every OTHER test here points KMP_EVAL_RUNS_ROOT at an
  // isolated tmpdir OUTSIDE any git repo, which takes the harmless "confirmedNotInAnyRepo"
  // shortcut. A real deployment's default RUNS_ROOT (inside this repo) exercises the git
  // check-ignore path instead -- reproduced here by pointing KMP_EVAL_RUNS_ROOT at a location
  // INSIDE a real git repo that does NOT have the new agentic-eval-journal/** gitignore rule.
  it('a journal-creation failure (runs root inside a git repo lacking the journal gitignore rule) fails cleanly with exit 1, never an uncaught exit 2', async () => {
    const bareRepoDir = mkdtempSync(path.join(isolatedTmp, 'aeci-bare-repo-'));
    const gitViaBashLocal = (argv, cwd) => {
      const shQuote = (arg) => `'${String(arg).replace(/'/g, "'\\''")}'`;
      const r = spawnSync(resolveBash(), ['-c', `git ${argv.map(shQuote).join(' ')}`], { cwd, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${r.stderr}`);
      return r.stdout;
    };
    gitViaBashLocal(['init', '-q'], bareRepoDir);
    gitViaBashLocal(['config', 'user.email', 'test@example.com'], bareRepoDir);
    gitViaBashLocal(['config', 'user.name', 'Test'], bareRepoDir);
    // No .gitignore at all in this fresh repo -- the journal directory is genuinely untracked and
    // uncovered, exactly the condition isRawDirSafeFromAccidentalCommit must fail closed against.
    const unsafeRunsRoot = path.join(bareRepoDir, 'runs-root');
    const env = { ...fakeClaudeEnv('success'), KMP_EVAL_RUNS_ROOT: unsafeRunsRoot };
    const result = await runCli(['calibrate', '--model', 'claude-sonnet-5'], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CALIBRATION FAILED');
    // Never the raw, unhandled "agentic-eval: <stack>" shape main()'s own top-level catch writes --
    // this is the exact bug: without the fix, this assertion is what fails (exit 2, stack trace).
    expect(result.stderr).not.toMatch(/^agentic-eval:/m);
    expect(result.stderr).not.toMatch(/\bat \S+ \(/);
    expect(result.stderr).not.toContain(bareRepoDir);
  }, 20000);

  // Uses 'unexpected-tool', not 'no-tool-use' -- the latter is now a legitimate PASS scenario
  // (see the flipped test above), so this cleanup-on-failure test needs a fixture that still
  // genuinely fails calibrate for a reason unrelated to the invocation contract.
  // 'unexpected-tool' trips noUnexpectedToolsOk (a Read tool_use outside the two expected calls)
  // in both conditions regardless of --plugin-dir, so it fails calibrate the same way it fails
  // smoke -- see this fixture's own header comment.
  it('leaves no leftover temp directories after a FAILING run either (cleanup runs in finally)', async () => {
    const result = await runCli(['calibrate', '--model', 'claude-sonnet-5'], fakeClaudeEnv('unexpected-tool'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('noUnexpectedToolsOk:false');
    expect(readdirSync(isolatedTmp)).toEqual([]);
  }, 20000);

  // A malformed --measurement-scope-file must fail closed BEFORE any Claude session spawns --
  // proven here via a REAL subprocess against a fixture that would otherwise clearly succeed
  // ('success'): zero fake-claude invocation ever happens (no evidence, no temp dirs used), not
  // just "cmdCalibrate's own code resolves the scope early" as a static/unit-level claim.
  it('a malformed --measurement-scope-file fails closed before spawning any Claude session', async () => {
    const result = await runCli(
      ['calibrate', '--model', 'claude-sonnet-5', '--measurement-scope-file', path.join(isolatedTmp, 'does-not-exist-scope.json')],
      fakeClaudeEnv('success'),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--measurement-scope-file is invalid/);
    expect(listEvidenceFiles('calibration')).toEqual([]);
    expect(readdirSync(isolatedTmp)).toEqual([]);
  }, 20000);

  // Registry selection (agentic-eval-runtime-neutral-records-v1) is resolved before ANY other
  // operation -- an unknown --runtime/--model/--execution-profile fails closed before auth,
  // materialize, or journal creation, exactly like the malformed-scope-file case above. Proven the
  // identical way: zero fake-claude invocation, zero temp resource under isolatedTmp (no journal,
  // no shim, no snapshot -- acquireSharedEvalResources is never even reached).
  it('an unknown --runtime fails closed before any Claude session, auth preflight, or journal creation', async () => {
    const result = await runCli(['calibrate', '--runtime', 'nonexistent-runtime'], fakeClaudeEnv('success'));
    expect(result.status).toBe(1);
    expect(listEvidenceFiles('calibration')).toEqual([]);
    expect(readdirSync(isolatedTmp)).toEqual([]);
  }, 20000);

  it('an unknown --model fails closed the same way', async () => {
    const result = await runCli(['calibrate', '--model', 'not-a-real-model'], fakeClaudeEnv('success'));
    expect(result.status).toBe(1);
    expect(listEvidenceFiles('calibration')).toEqual([]);
    expect(readdirSync(isolatedTmp)).toEqual([]);
  }, 20000);

  it('an unknown --execution-profile fails closed the same way', async () => {
    const result = await runCli(['calibrate', '--execution-profile', 'not-a-real-profile'], fakeClaudeEnv('success'));
    expect(result.status).toBe(1);
    expect(listEvidenceFiles('calibration')).toEqual([]);
    expect(readdirSync(isolatedTmp)).toEqual([]);
  }, 20000);
});

describe('cli.mjs smoke -- real subprocess against fake claude (no live API cost)', () => {
  let sourceRepoDir;
  let pinnedCommit;

  function gitViaBash(argv, cwd) {
    const shQuote = (arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`;
    const cmd = argv.map(shQuote).join(' ');
    const r = spawnSync(resolveBash(), ['-c', `git ${cmd}`], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  }

  beforeEach(() => {
    // A tiny, real, local git repo stands in for a real scenario source (KaMPKit) -- exercises
    // the REAL materializeScenarioProject/removeScenarioWorktree git-worktree machinery without
    // needing a real clone.
    sourceRepoDir = mkdtempSync(path.join(os.tmpdir(), 'aeci-source-'));
    gitViaBash(['init', '-q'], sourceRepoDir);
    gitViaBash(['config', 'user.email', 'test@example.com'], sourceRepoDir);
    gitViaBash(['config', 'user.name', 'Test'], sourceRepoDir);
    writeFileSync(path.join(sourceRepoDir, 'marker.txt'), 'pristine\n');
    gitViaBash(['add', '-A'], sourceRepoDir);
    gitViaBash(['commit', '-q', '-m', 'initial'], sourceRepoDir);
    pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
    // A fake (never-fetched-from) origin remote -- lets tests prove project_url is resolved
    // from the REAL git remote of whatever --source-repo-dir points to, not hardcoded.
    gitViaBash(['remote', 'add', 'origin', 'https://github.com/example/fake-scenario-repo.git'], sourceRepoDir);
  });

  afterEach(() => {
    rmSync(sourceRepoDir, { recursive: true, force: true });
  });

  // projectAlias is a parameter (not folded into `extra`) because parseArgs now rejects a
  // duplicated --project-alias as a hard error -- a caller that wants a non-default alias must
  // set it here, not append a second --project-alias onto `extra`.
  function smokeArgs(extra = [], projectAlias = 'integration-test') {
    return ['smoke', '--source-repo-dir', sourceRepoDir, '--pinned-commit', pinnedCommit, '--project-alias', projectAlias, '--model', 'claude-sonnet-5', ...extra];
  }

  it('success scenario: passes the equivalent-real-work hard gate and writes schema-valid evidence', async () => {
    const result = await runCli(smokeArgs(), fakeClaudeEnv('success'));
    expect(result.status).toBe(0);
    const { recordA, recordB } = result.parsed;
    expect(recordA.skill_available.value).toBe(false);
    expect(recordB.skill_available.value).toBe(true);
    expect(recordA.hook_call_count).toBeGreaterThanOrEqual(1);
    expect(recordA.hook_deny_count).toBe(0);
    expect(recordB.hook_call_count).toBeGreaterThanOrEqual(1);
    expect(recordB.hook_deny_count).toBe(0);
    expect(recordA.privacy_status).toBe('public');

    // Stage 6 (agentic-eval-runtime-neutral-records-v1): proves the 4 new schema:6 groups are a
    // REAL, complete projection against a real fake-claude smoke run, not just buildRunRecord's
    // own unit tests. Structural checks (never a raw command/path/skill name) rather than exact
    // string equality for the runtime-observed fields (cli_version/model_resolved) -- those are
    // smoke's own fake-claude fixture output, already covered exactly by buildRunRecord's own
    // unit-level coverage; what this E2E proof needs is that a REAL subprocess run genuinely
    // produces them, not their precise fixture text.
    for (const record of [recordA, recordB]) {
      expect(record.agent_runtime.runtime_id).toBe('claude-code');
      expect(record.agent_runtime.model_requested).toBe('claude-sonnet-5');
      expect(record.agent_runtime.model_vendor_expected).toBe('anthropic');
      expect(typeof record.agent_runtime.cli_version).toBe('string');
      expect(typeof record.agent_runtime.model_resolved).toBe('string');
      expect(record.execution_profile).toEqual({
        id: 'strict-policy-v1', sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        isolation_kind: 'runtime-policy-hooks', isolation_attestation_sha256: null, network_mode: 'runtime-default',
        isolation_attestation_required: false, policy_mode: 'required', required_capabilities: ['softPermissionDenial'],
      });
      expect(record.skill_observation.delivery_mode).toBe(record.condition === 'current-skill' ? 'runtime-extension' : 'none');
      expect(record.skill_observation.treatment_size.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(record.usage).not.toBeNull();
      expect(['runtime-reported', 'not-recorded']).toContain(record.usage.source);
      expect(record.usage.attributable_to_skill_load.status).toBe('not-recorded');
    }

    expect(listEvidenceFiles('smoke').length).toBe(2);
    // accepted-run-observability PR: smoke's pair-based writer is untouched -- no sidecar, no
    // accepted_audit, no audit/ directory at all for a non-scenario record.
    expect(recordA.accepted_audit).toBeNull();
    expect(recordB.accepted_audit).toBeNull();
    expect(existsSync(path.join(evidenceDirFor('smoke'), 'audit'))).toBe(false);
  }, 30000);

  // See calibrate's identical regression test above for the full rationale -- smoke goes through
  // the same buildRunRecord/writeRunRecordEvidence path and shares the bug class.
  it('discloses a non-default KMP_EVAL_RUNS_ROOT honestly, never leaking the real override path', async () => {
    const result = await runCli(smokeArgs(), fakeClaudeEnv('success'));
    expect(result.status).toBe(0);
    const { recordA, recordB } = result.parsed;
    for (const record of [recordA, recordB]) {
      expect(record.raw_capture_location).toBe('(KMP_EVAL_RUNS_ROOT override -- see errors[])');
      expect(record.raw_capture_location).not.toContain(runsRoot);
      expect(record.errors.some((e) => e.code === 'raw_capture_location_overridden')).toBe(true);
    }
  }, 30000);

  // Regression coverage for a real bypass an independent review pass demonstrated: scenario_id
  // was HARDCODED to 'kampkit-android-host-test-discovery' regardless of --source-repo-dir/
  // --project-alias -- a smoke run against ANY other project was still labeled as if it were
  // KaMPKit. project_url was never recorded at all. Fixed: scenario_id derives from the actual
  // --project-alias; project_url is the real git remote origin URL of --source-repo-dir.
  it('scenario_id and project_url reflect the ACTUAL project smoke is pointed at, never a hardcoded kampkit label', async () => {
    const result = await runCli(smokeArgs([], 'totally-different-project'), fakeClaudeEnv('success'));
    expect(result.status).toBe(0);
    const { recordA, recordB } = result.parsed;
    expect(recordA.scenario_id).toBe('totally-different-project-android-host-test-discovery');
    expect(recordA.scenario_id).not.toContain('kampkit');
    expect(recordB.scenario_id).toBe(recordA.scenario_id);
    expect(recordA.project_alias).toBe('totally-different-project');
    expect(recordA.project_url).toBe('https://github.com/example/fake-scenario-repo.git');
    expect(recordB.project_url).toBe('https://github.com/example/fake-scenario-repo.git');
  }, 30000);

  // Regression coverage for a real fail-open bug found by an independent review pass: records
  // were redacted before being WRITTEN TO DISK, but the ORIGINAL, unredacted objects were printed
  // to stdout -- redaction protected the file and never the terminal. A caller (or a human)
  // reading stdout output would still see the raw private value even on a run whose evidence FILE
  // was clean. This drives a real subprocess with a custom --private-patterns-file matching a
  // distinctive marker planted in --project-alias, and asserts that marker never appears anywhere
  // in raw stdout -- only the redaction placeholder does.
  it('privacy redaction applies to stdout too, not just the written evidence file', async () => {
    const patternsFile = path.join(os.tmpdir(), `aeci-private-patterns-${process.pid}-${Date.now()}.json`);
    const secretMarker = 'totally-fake-marker-not-a-real-secret-xyz';
    writeFileSync(patternsFile, JSON.stringify([
      { class: 'test_marker', literal: secretMarker, replacement: '<REDACTED_TEST_MARKER>' },
    ]));
    try {
      const result = await runCli(smokeArgs(['--private-patterns-file', patternsFile], secretMarker), fakeClaudeEnv('success'));
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain(secretMarker);
      expect(result.stdout).toContain('<REDACTED_TEST_MARKER>');
      expect(result.parsed.recordA.project_alias).toBe('<REDACTED_TEST_MARKER>');
      expect(result.parsed.recordA.privacy_status).toBe('redacted-private');

      // The written evidence file must ALSO be clean (the original guarantee, still intact).
      const files = listEvidenceFiles('smoke');
      expect(files.length).toBe(2);
      const writtenText = readFileSync(path.join(evidenceDirFor('smoke'), files[0]), 'utf8');
      expect(writtenText).not.toContain(secretMarker);
      // Both records, not just files[0] -- asymmetric redaction between conditions A/B could
      // otherwise regress unnoticed (a CodeRabbit nitpick on an earlier round of this same test).
      const otherFile = files.find((f) => f !== files[0]);
      expect(readFileSync(path.join(evidenceDirFor('smoke'), otherFile), 'utf8')).not.toContain(secretMarker);
      expect(result.parsed.recordB.project_alias).not.toBe(secretMarker);
    } finally {
      rmSync(patternsFile, { force: true });
    }
  }, 30000);

  // A real ordering bug an independent review pass found -- finalizeAndWriteRecords() wrote all
  // four files BEFORE checking the evidence directory PATH's own redaction-safety -- is covered
  // by tests/vitest/agentic-eval-finalize-outdir-privacy-order.test.js (an isolated, mocked-
  // assertCleanOrThrow test, kept in its own file per this repo's established
  // node:fs-mock-isolation convention -- see coverage-orchestrator-report-write-failure.test.js).
  // A real subprocess test was attempted here first and abandoned: this test file's own runsRoot
  // always lives under a real Windows user-home-shaped path, so PUBLIC_SHAPE_RULES' built-in
  // user_path_win rule (which always runs first) greedily collapses BOTH the evidence directory
  // path AND the record's own resolved_kmp_test_executable_path field to the byte-identical
  // `<USER_PATH>` placeholder -- no private-patterns-file rule running after it can distinguish
  // which one it originally was, so a real end-to-end run can't isolate this specific ordering
  // property on this platform.

  // Regression coverage for a real, reproduced privacy bypass an independent review pass
  // demonstrated directly against this code: an EARLIER version redacted by JSON.stringify()-ing
  // the whole record FIRST, then running text-level redaction on that already-serialized blob.
  // JSON.stringify() escapes every backslash in a string as TWO characters (\ becomes \\), but
  // PUBLIC_SHAPE_RULES' user_path_win rule is written to match a SINGLE literal backslash --
  // redacting the JSON-escaped text silently failed to match, letting a real Windows user-home
  // path survive completely untouched (confirmed empirically: a literal "C:\Users\<username>\..."
  // path passed assertCleanOrThrow() intact once JSON.stringify() had already run on it). This
  // drives a real subprocess with a Windows-path-SHAPED value planted in --project-alias (a
  // PUBLIC_SHAPE_RULES match -- no custom --private-patterns-file needed, proving the built-in,
  // always-on rule itself now works) and asserts it's redacted to <USER_PATH> in BOTH stdout and
  // the written evidence file, never surviving as the raw path in either.
  it('a Windows user-home-shaped path is redacted correctly -- not silently missed due to JSON-escaped backslashes', async () => {
    const windowsPath = 'C:\\Users\\someuser\\private-app';
    const result = await runCli(smokeArgs([], windowsPath), fakeClaudeEnv('success'));
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('someuser');
    expect(result.stdout).not.toContain('private-app');
    expect(result.stdout).toContain('<USER_PATH>');
    expect(result.parsed.recordA.project_alias).toBe('<USER_PATH>');

    const files = listEvidenceFiles('smoke');
    expect(files.length).toBe(2);
    const writtenText = readFileSync(path.join(evidenceDirFor('smoke'), files[0]), 'utf8');
    expect(writtenText).not.toContain('someuser');
    expect(writtenText).not.toContain('private-app');
    expect(JSON.parse(writtenText).project_alias).toBe('<USER_PATH>');
  }, 30000);

  // Regression coverage for a real bypass an independent review pass demonstrated: an EARLIER
  // version redacted records by JSON.stringify()-ing first, then running text-level redaction on
  // that already-serialized blob -- a private-pattern replacement string containing a raw,
  // unescaped newline broke JSON syntax once substituted into what was a JSON string value
  // (findLeaks has no way to catch that; it only checks for leak PATTERNS, not JSON structural
  // validity), so invalid-JSON evidence could previously reach disk. A later, more fundamental
  // fix (field-level redaction BEFORE the one-and-only JSON.stringify() call, in
  // tools/lib/redact.mjs's redactValue()) makes this failure mode structurally impossible rather
  // than merely detecting it after the fact: JSON.stringify() always correctly escapes whatever
  // a replacement string contains, including a raw newline. This test now proves that guarantee
  // directly -- the exact same "breaking" replacement string from the original finding is used,
  // and the run must now SUCCEED, with the newline correctly escaped as \n in the written
  // evidence (still valid, re-parseable JSON), not silently corrupt anything.
  it('a private-pattern replacement containing a raw newline is safely JSON-escaped, not left to break JSON syntax', async () => {
    const patternsFile = path.join(os.tmpdir(), `aeci-breaking-patterns-${process.pid}-${Date.now()}.json`);
    const secretMarker = 'another-fake-marker-not-a-real-secret-xyz';
    writeFileSync(patternsFile, JSON.stringify([
      { class: 'test_marker', literal: secretMarker, replacement: 'line-one\nline-two-used-to-break-json' },
    ]));
    try {
      const result = await runCli(smokeArgs(['--private-patterns-file', patternsFile], secretMarker), fakeClaudeEnv('success'));
      expect(result.status).toBe(0);
      expect(result.parsed).not.toBeNull();
      expect(result.parsed.recordA.project_alias).toBe('line-one\nline-two-used-to-break-json');

      const files = listEvidenceFiles('smoke');
      expect(files.length).toBe(2);
      // The written file is still valid, re-parseable JSON -- readFileSync + JSON.parse would
      // throw here if the newline had corrupted the structure the way the original finding
      // demonstrated.
      const writtenText = readFileSync(path.join(evidenceDirFor('smoke'), files[0]), 'utf8');
      const writtenRecord = JSON.parse(writtenText);
      expect(writtenRecord.project_alias).toBe('line-one\nline-two-used-to-break-json');
      // The RAW marker must never survive uninterpreted -- it was replaced, not left alone.
      expect(writtenText).not.toContain(secretMarker);
    } finally {
      rmSync(patternsFile, { force: true });
    }
  }, 30000);

  // Regression coverage for the exact real adversarial transcript an independent review pass
  // constructed against this code: an init event declaring Read alongside Bash/Skill, with Read
  // actually invoked once (and succeeding) alongside both expected Bash calls also succeeding.
  // An EARLIER version of smokeHardGate returned {ok:true} for exactly this transcript, since it
  // never inspected the init event's own tools field or scanned for tool_use events beyond the
  // two expected Bash calls -- "the two expected commands succeeded" was treated as sufficient
  // proof of a narrow session, when it wasn't.
  // Fail-fast (preserve rejected matrix forensics) changes this fixture's own observable
  // behavior exactly like the malformed-transcript fixture above: current-skill (B) runs FIRST
  // and fails its own local toolProfileOk/noUnexpectedToolsOk checks (both part of
  // cellTranscriptIntegrityOk's canonical 15) immediately -- no-skill (A) is NEVER spawned, so
  // smokeHardGate's two-sided reason (with smoke-only checks like processOk/resultOk/realWorkOk/
  // exactCommandsOk, which cellTranscriptIntegrityOk does not cover) never gets built. This
  // fixture is the exact reproduction shape of the 2026-08 canary incident this whole fix exists
  // for -- fail-fast now stops it after exactly one session, which is the point.
  it('unexpected-tool scenario: fail-fast stops after current-skill fails its own toolProfileOk/noUnexpectedToolsOk checks, never spawns no-skill, and writes NO evidence', async () => {
    const result = await runCli(smokeArgs(), fakeClaudeEnv('unexpected-tool'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SMOKE FAILED');
    expect(result.stderr).toContain('toolProfileOk:false');
    expect(result.stderr).toContain('noUnexpectedToolsOk:false');
    // Everything else about this transcript is genuinely clean -- isolating the two checks as the
    // ones actually catching this, not an artifact of something else also being broken.
    expect(result.stderr).toContain('availabilityOk:true');
    expect(result.stderr).toContain('initOk:true');
    expect(result.stderr).toContain('hookAccountingOk:true');
    expect(result.stderr).toContain('cleanTranscriptOk:true');
    expect(listEvidenceFiles('smoke').length).toBe(0);
    expect(result.stderr).toContain('rejected-run diagnostics written');
    expect(result.stderr).toContain('1 raw transcript(s) preserved locally');
  }, 30000);

  // This fixture's only Bash call is an unrelated, denied `ls` -- honestly, that ONE fact trips
  // BOTH realWorkOk (hook_deny_count>0) and exactCommandsOk (neither expected command ran) at
  // once, not two independent causes. Redesigning this fixture so a denied command's own
  // tool_result carries a real, verified shape (as opposed to fake-claude-malformed/
  // fake-claude-no-tool-use, where the fix only required reusing fake-claude-success's own
  // already-verified "allow" shape) would mean fabricating what a REAL denied command's
  // tool_result looks like on an actual transcript -- not independently confirmed anywhere in
  // this harness, and not worth guessing at just to force an artificial single-check split.
  // agentic-eval-hard-gates.test.js's synthetic unit tests already isolate realWorkOk and
  // exactCommandsOk from each other precisely, with inputs that don't depend on that unverified
  // shape.
  it('all-denied scenario: fails the equivalent-real-work hard gate (hook_deny_count>0) and writes NO evidence', async () => {
    const result = await runCli(smokeArgs(), fakeClaudeEnv('all-denied'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SMOKE FAILED');
    expect(result.stderr).toContain('realWorkOk:false');
    expect(result.stderr).toContain('availabilityOk:true');
    expect(result.stderr).toContain('processOk:true');
    expect(result.stderr).toContain('resultOk:true');
    expect(result.stderr).toContain('hookAccountingOk:true');
    expect(listEvidenceFiles('smoke').length).toBe(0);
  }, 30000);

  // This fixture is otherwise byte-for-byte the success shape (both expected commands run,
  // correctly hooked with an "allow" decision, non-error results, correct --plugin-dir-driven
  // skill_available) -- the ONLY difference is one injected line of invalid JSON.
  //
  // Fail-fast (preserve rejected matrix forensics) changes this fixture's own observable
  // behavior: current-skill (B) runs FIRST (see runConditionPair's confirmed order) and fails its
  // own local cleanTranscriptOk check immediately -- no-skill (A) is NEVER spawned, so
  // smokeHardGate's two-sided reason format (which used to report BOTH sides' full 16-check
  // breakdown, including smoke-only checks like processOk/resultOk/realWorkOk/exactCommandsOk
  // that cellTranscriptIntegrityOk's own canonical 15 do not cover) never gets built at all --
  // this test previously asserted that full two-sided shape appeared, which stopped being true
  // the moment fail-fast could short-circuit before smokeHardGate ever runs. What's still true,
  // and is exactly what this fixture exists to prove: cleanTranscriptOk is correctly identified
  // as the failing check, from a transcript that is otherwise completely clean.
  it('malformed-transcript scenario: fail-fast stops after current-skill fails its own cleanTranscriptOk check, never spawns no-skill, and writes NO evidence', async () => {
    const result = await runCli(smokeArgs(), fakeClaudeEnv('malformed'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SMOKE FAILED');
    expect(result.stderr).toContain('cleanTranscriptOk:false');
    expect(listEvidenceFiles('smoke').length).toBe(0);
    expect(result.stderr).toContain('rejected-run diagnostics written');
    expect(result.stderr).toContain('1 raw transcript(s) preserved locally');
  }, 30000);

  // preserve rejected matrix forensics: same invocation-counted proof as calibrate's identical
  // test above (see that test's own header comment) -- fake-claude-failfast-pair/claude is shared
  // by both commands, exercising the SAME runConditionPair fail-fast wired through smoke's own
  // command instead of calibrate's, since each is an independently-testable call site.
  it('failfast-pair scenario (invocation-counted fixture): fail-fast stops after current-skill (B) fails locally -- EXACTLY ONE live session, no-skill (A) never spawned', async () => {
    const probeLogPath = path.join(isolatedTmp, 'failfast-pair-invocations.log');
    // CodeRabbit review finding (PR #417): make the isolation precondition this test's own
    // invocation-count assertion depends on EXPLICIT, not merely implicit -- isolatedTmp is a
    // fresh mkdtempSync() directory from this file's own beforeEach (never shared across tests,
    // never reused), so the probe log genuinely cannot pre-exist here; asserting it demonstrates
    // that guarantee rather than assuming it silently.
    expect(existsSync(probeLogPath)).toBe(false);
    const result = await runCli(smokeArgs(), fakeClaudeEnv('failfast-pair'));
    expect(result.status).toBe(1);
    expect(existsSync(probeLogPath)).toBe(true);
    const invocationLines = readFileSync(probeLogPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(invocationLines.length).toBe(1);
    expect(result.stderr).toContain('SMOKE FAILED');
    expect(result.stderr).toContain('toolProfileOk:false');
    expect(result.stderr).toContain('noUnexpectedToolsOk:false');
    expect(result.stderr).toContain('availabilityOk:true');
    expect(listEvidenceFiles('smoke').length).toBe(0);
    expect(result.stderr).toContain('rejected-run diagnostics written');
    expect(result.stderr).toContain('1 raw transcript(s) preserved locally');
  }, 30000);

  it('leaves no registered git worktree behind after a passing run (removeScenarioWorktree ran)', async () => {
    const result = await runCli(smokeArgs(), fakeClaudeEnv('success'));
    expect(result.status).toBe(0);
    const worktreeList = gitViaBash(['worktree', 'list'], sourceRepoDir);
    // Only the main working tree (sourceRepoDir itself) should be listed -- no scenario
    // worktree left registered.
    expect(worktreeList.trim().split('\n').length).toBe(1);
  }, 30000);

  it('leaves no registered git worktree behind after a FAILING run either (cleanup runs in finally)', async () => {
    const result = await runCli(smokeArgs(), fakeClaudeEnv('all-denied'));
    expect(result.status).toBe(1);
    const worktreeList = gitViaBash(['worktree', 'list'], sourceRepoDir);
    expect(worktreeList.trim().split('\n').length).toBe(1);
  }, 30000);

  // Mirrors calibrate's identical proof above: a malformed --measurement-scope-file must fail
  // closed before any Claude session spawns -- proven via a REAL subprocess against a fixture
  // ('success') that would otherwise clearly succeed, so no worktree is ever materialized.
  it('a malformed --measurement-scope-file fails closed before spawning any Claude session', async () => {
    const result = await runCli(
      smokeArgs(['--measurement-scope-file', path.join(isolatedTmp, 'does-not-exist-scope.json')]),
      fakeClaudeEnv('success'),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--measurement-scope-file is invalid/);
    expect(listEvidenceFiles('smoke')).toEqual([]);
    const worktreeList = gitViaBash(['worktree', 'list'], sourceRepoDir);
    expect(worktreeList.trim().split('\n').length).toBe(1);
  }, 30000);

  // Registry selection is resolved before ANY other operation for smoke too -- an unknown
  // --runtime/--model/--execution-profile fails closed before auth, materialize (no git worktree
  // ever created), or journal creation.
  it('an unknown --runtime fails closed before any Claude session or worktree materialization', async () => {
    const result = await runCli(smokeArgs(['--runtime', 'nonexistent-runtime']), fakeClaudeEnv('success'));
    expect(result.status).toBe(1);
    expect(listEvidenceFiles('smoke')).toEqual([]);
    const worktreeList = gitViaBash(['worktree', 'list'], sourceRepoDir);
    expect(worktreeList.trim().split('\n').length).toBe(1);
  }, 30000);
});

// PR 4 (agentic-eval-isolated-unrestricted-profile-v1): resolveIsolationAttestationOrFail ordering
// -- real subprocess, real cli.mjs, calibrate only (the simplest, self-contained command -- no
// source-repo-dir/worktree needed). Every case here fails BEFORE any journal is created or Claude
// session spawns, exactly like the pre-existing --runtime/--measurement-scope-file ordering proofs
// above. The success path (a real accepted sandboxed-unrestricted-v1 run) is Stage 7's own
// dedicated fake-E2E coverage, not duplicated here.
describe('cli.mjs calibrate -- isolation attestation ordering (real subprocess, no live API cost)', () => {
  it('--isolation-attestation-file is rejected for the default (strict-policy-v1) profile -- never silently ignored', async () => {
    const attestationPath = path.join(isolatedTmp, 'unexpected-attestation.json');
    writeFileSync(attestationPath, JSON.stringify({ schema: 1 }));
    const result = await runCli(['calibrate', '--isolation-attestation-file', attestationPath], fakeClaudeEnv('success'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/isolation-attestation-file is not accepted/);
    expect(listEvidenceFiles('calibration')).toEqual([]);
  }, 30000);

  it('sandboxed-unrestricted-v1 without --isolation-attestation-file fails closed before any spawn', async () => {
    const result = await runCli(['calibrate', '--execution-profile', 'sandboxed-unrestricted-v1'], fakeClaudeEnv('success'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--isolation-attestation-file <path> is required/);
    expect(listEvidenceFiles('calibration')).toEqual([]);
  }, 30000);

  it('sandboxed-unrestricted-v1 with a missing attestation file fails closed, sanitized (no path leaked)', async () => {
    const missingPath = path.join(isolatedTmp, 'does-not-exist-attestation.json');
    const result = await runCli(['calibrate', '--execution-profile', 'sandboxed-unrestricted-v1', '--isolation-attestation-file', missingPath], fakeClaudeEnv('success'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/isolation attestation invalid: not_a_regular_file/);
    expect(result.stderr).not.toContain(missingPath);
    expect(listEvidenceFiles('calibration')).toEqual([]);
  }, 30000);

  it('sandboxed-unrestricted-v1 with a malformed (empty-object) attestation file fails closed', async () => {
    const attestationPath = path.join(isolatedTmp, 'malformed-attestation.json');
    writeFileSync(attestationPath, JSON.stringify({}));
    const result = await runCli(['calibrate', '--execution-profile', 'sandboxed-unrestricted-v1', '--isolation-attestation-file', attestationPath], fakeClaudeEnv('success'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/isolation attestation invalid: invalid_keys/);
    expect(listEvidenceFiles('calibration')).toEqual([]);
  }, 30000);

  it('the attestation check runs before journal creation -- no journal directory materializes on failure (mirrors the pre-existing --measurement-scope-file/--runtime ordering proofs)', async () => {
    const result = await runCli(['calibrate', '--execution-profile', 'sandboxed-unrestricted-v1'], fakeClaudeEnv('success'));
    expect(result.status).toBe(1);
    // No agentic-eval-calibration evidence dir contents at all -- calibrate never got far enough
    // to create createInvocationJournal's own write-ahead artifact.
    expect(listEvidenceFiles('calibration')).toEqual([]);
  }, 30000);
});

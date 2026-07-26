// tests/vitest/agentic-eval-cli-integration.test.js
// Real end-to-end integration tests for tools/agentic-eval/cli.mjs's calibrate/smoke commands,
// run as REAL `node cli.mjs ...` subprocesses against the fake `claude` fixtures under
// tests/fixtures/fake-claude-*/ (never the real claude CLI -- zero API cost, zero live
// authentication needed). Exercises the harness's OWN orchestration: privacy wiring
// (assertCleanOrThrow actually runs), gate-before-write (no committable evidence on any
// failure), the strengthened hard acceptance gates, wall_clock_ms, and cleanup (no leftover
// temp dirs/worktrees after either a passing or failing run).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
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

function runCli(args, env) {
  const r = spawnSync('node', [CLI_PATH, ...args], { env, encoding: 'utf8', timeout: 30000 });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* stderr-only failure path -- fine */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, parsed };
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
  it('success scenario: passes the hard gate, writes schema-valid evidence, sets a real wall_clock_ms', () => {
    const result = runCli(['calibrate', '--model', 'fake-model-x'], fakeClaudeEnv('success'));
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
    expect(recordA.model_requested).toBe('fake-model-x');
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
  it('discloses a non-default KMP_EVAL_RUNS_ROOT honestly, never leaking the real override path', () => {
    const result = runCli(['calibrate', '--model', 'fake-model-x'], fakeClaudeEnv('success'));
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
  it('no-tool-use scenario: A never attempting the skill is a legitimate no-skill shape -- passes and writes evidence', () => {
    const result = runCli(['calibrate', '--model', 'fake-model-x'], fakeClaudeEnv('no-tool-use'));
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
  // fixture smoke's own cleanTranscriptOk test uses; it never calls Skill at all, so for
  // calibrate this ALSO trips currentInvocationOk (B never confirms an invocation either) -- not
  // pure single-cause isolation, disclosed honestly rather than fabricating a calibrate-specific
  // fixture just to force a cleaner split.
  it('malformed-transcript scenario: fails the hard gate (cleanTranscriptOk, alongside currentInvocationOk since this fixture never calls Skill) and writes NO evidence', () => {
    const result = runCli(['calibrate', '--model', 'fake-model-x'], fakeClaudeEnv('malformed'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CALIBRATION FAILED');
    expect(result.stderr).toContain('cleanTranscriptOk:false');
    expect(result.stderr).toContain('availabilityOk:true');
    expect(result.stderr).toContain('skillSelectionOk:true');
    expect(result.stderr).toContain('pluginProfileOk:true');
    expect(listEvidenceFiles('calibration').length).toBe(0);
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
  it('foreign-skill scenario: A calling an unrelated Skill that gets CONFIRMED is rejected by the gate (evidence-contamination bypass) and writes NO evidence', () => {
    const result = runCli(['calibrate', '--model', 'fake-model-x'], fakeClaudeEnv('foreign-skill'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CALIBRATION FAILED');
    expect(result.stderr).toContain('skillSelectionOk:false');
    expect(result.stderr).toContain('availabilityOk:true');
    expect(result.stderr).toContain('noSkillSafetyOk:true');
    expect(result.stderr).toContain('currentInvocationOk:true');
    expect(listEvidenceFiles('calibration').length).toBe(0);
  }, 20000);

  it('leaves no leftover temp directories after a passing run (cleanup ran)', () => {
    const result = runCli(['calibrate', '--model', 'fake-model-x'], fakeClaudeEnv('success'));
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
  it('a resource-acquisition failure (mkdtempSync throwing on a broken TEMP dir) fails cleanly with exit 1, never an uncaught exit 2', () => {
    const brokenTemp = path.join(isolatedTmp, 'this-directory-does-not-exist');
    const env = { ...fakeClaudeEnv('success'), TEMP: brokenTemp, TMP: brokenTemp, TMPDIR: brokenTemp };
    const result = runCli(['calibrate', '--model', 'fake-model-x'], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CALIBRATION FAILED');
    expect(result.stderr).toContain('session acquisition/spawn threw');
    // Never the raw, unhandled "agentic-eval: <stack>" shape main()'s own top-level catch writes.
    expect(result.stderr).not.toMatch(/^agentic-eval:/m);
  }, 20000);

  // Uses 'unexpected-tool', not 'no-tool-use' -- the latter is now a legitimate PASS scenario
  // (see the flipped test above), so this cleanup-on-failure test needs a fixture that still
  // genuinely fails calibrate for a reason unrelated to the invocation contract.
  // 'unexpected-tool' trips noUnexpectedToolsOk (a Read tool_use outside the two expected calls)
  // in both conditions regardless of --plugin-dir, so it fails calibrate the same way it fails
  // smoke -- see this fixture's own header comment.
  it('leaves no leftover temp directories after a FAILING run either (cleanup runs in finally)', () => {
    const result = runCli(['calibrate', '--model', 'fake-model-x'], fakeClaudeEnv('unexpected-tool'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('noUnexpectedToolsOk:false');
    expect(readdirSync(isolatedTmp)).toEqual([]);
  }, 20000);

  // A malformed --measurement-scope-file must fail closed BEFORE any Claude session spawns --
  // proven here via a REAL subprocess against a fixture that would otherwise clearly succeed
  // ('success'): zero fake-claude invocation ever happens (no evidence, no temp dirs used), not
  // just "cmdCalibrate's own code resolves the scope early" as a static/unit-level claim.
  it('a malformed --measurement-scope-file fails closed before spawning any Claude session', () => {
    const result = runCli(
      ['calibrate', '--model', 'fake-model-x', '--measurement-scope-file', path.join(isolatedTmp, 'does-not-exist-scope.json')],
      fakeClaudeEnv('success'),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--measurement-scope-file is invalid/);
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
    return ['smoke', '--source-repo-dir', sourceRepoDir, '--pinned-commit', pinnedCommit, '--project-alias', projectAlias, '--model', 'fake-model-x', ...extra];
  }

  it('success scenario: passes the equivalent-real-work hard gate and writes schema-valid evidence', () => {
    const result = runCli(smokeArgs(), fakeClaudeEnv('success'));
    expect(result.status).toBe(0);
    const { recordA, recordB } = result.parsed;
    expect(recordA.skill_available.value).toBe(false);
    expect(recordB.skill_available.value).toBe(true);
    expect(recordA.hook_call_count).toBeGreaterThanOrEqual(1);
    expect(recordA.hook_deny_count).toBe(0);
    expect(recordB.hook_call_count).toBeGreaterThanOrEqual(1);
    expect(recordB.hook_deny_count).toBe(0);
    expect(recordA.privacy_status).toBe('public');

    expect(listEvidenceFiles('smoke').length).toBe(2);
    // accepted-run-observability PR: smoke's pair-based writer is untouched -- no sidecar, no
    // accepted_audit, no audit/ directory at all for a non-scenario record.
    expect(recordA.accepted_audit).toBeNull();
    expect(recordB.accepted_audit).toBeNull();
    expect(existsSync(path.join(evidenceDirFor('smoke'), 'audit'))).toBe(false);
  }, 30000);

  // See calibrate's identical regression test above for the full rationale -- smoke goes through
  // the same buildRunRecord/writeRunRecordEvidence path and shares the bug class.
  it('discloses a non-default KMP_EVAL_RUNS_ROOT honestly, never leaking the real override path', () => {
    const result = runCli(smokeArgs(), fakeClaudeEnv('success'));
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
  it('scenario_id and project_url reflect the ACTUAL project smoke is pointed at, never a hardcoded kampkit label', () => {
    const result = runCli(smokeArgs([], 'totally-different-project'), fakeClaudeEnv('success'));
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
  it('privacy redaction applies to stdout too, not just the written evidence file', () => {
    const patternsFile = path.join(os.tmpdir(), `aeci-private-patterns-${process.pid}-${Date.now()}.json`);
    const secretMarker = 'totally-fake-marker-not-a-real-secret-xyz';
    writeFileSync(patternsFile, JSON.stringify([
      { class: 'test_marker', literal: secretMarker, replacement: '<REDACTED_TEST_MARKER>' },
    ]));
    try {
      const result = runCli(smokeArgs(['--private-patterns-file', patternsFile], secretMarker), fakeClaudeEnv('success'));
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
  it('a Windows user-home-shaped path is redacted correctly -- not silently missed due to JSON-escaped backslashes', () => {
    const windowsPath = 'C:\\Users\\someuser\\private-app';
    const result = runCli(smokeArgs([], windowsPath), fakeClaudeEnv('success'));
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
  it('a private-pattern replacement containing a raw newline is safely JSON-escaped, not left to break JSON syntax', () => {
    const patternsFile = path.join(os.tmpdir(), `aeci-breaking-patterns-${process.pid}-${Date.now()}.json`);
    const secretMarker = 'another-fake-marker-not-a-real-secret-xyz';
    writeFileSync(patternsFile, JSON.stringify([
      { class: 'test_marker', literal: secretMarker, replacement: 'line-one\nline-two-used-to-break-json' },
    ]));
    try {
      const result = runCli(smokeArgs(['--private-patterns-file', patternsFile], secretMarker), fakeClaudeEnv('success'));
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
  it('unexpected-tool scenario: fails the hard gate (Read enabled and invoked) and writes NO evidence', () => {
    const result = runCli(smokeArgs(), fakeClaudeEnv('unexpected-tool'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SMOKE FAILED');
    expect(result.stderr).toContain('toolProfileOk:false');
    expect(result.stderr).toContain('noUnexpectedToolsOk:false');
    // Everything else about this transcript is genuinely clean -- isolating the two new checks
    // as the ones actually catching this, not an artifact of something else also being broken.
    expect(result.stderr).toContain('availabilityOk:true');
    expect(result.stderr).toContain('initOk:true');
    expect(result.stderr).toContain('processOk:true');
    expect(result.stderr).toContain('resultOk:true');
    expect(result.stderr).toContain('hookAccountingOk:true');
    expect(result.stderr).toContain('realWorkOk:true');
    expect(result.stderr).toContain('exactCommandsOk:true');
    expect(result.stderr).toContain('cleanTranscriptOk:true');
    expect(listEvidenceFiles('smoke').length).toBe(0);
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
  it('all-denied scenario: fails the equivalent-real-work hard gate (hook_deny_count>0) and writes NO evidence', () => {
    const result = runCli(smokeArgs(), fakeClaudeEnv('all-denied'));
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
  // skill_available) -- the ONLY difference is one injected line of invalid JSON. Asserting the
  // granular reason string proves cleanTranscriptOk is the SOLE failing named sub-check, not an
  // artifact of an otherwise-empty transcript also failing realWorkOk/exactCommandsOk for an
  // unrelated reason (the bug this fixture previously had, found by an independent review pass).
  it('malformed-transcript scenario: fails the clean-transcript hard gate and writes NO evidence', () => {
    const result = runCli(smokeArgs(), fakeClaudeEnv('malformed'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SMOKE FAILED');
    expect(result.stderr).toContain('cleanTranscriptOk:false');
    expect(result.stderr).toContain('availabilityOk:true');
    expect(result.stderr).toContain('processOk:true');
    expect(result.stderr).toContain('resultOk:true');
    expect(result.stderr).toContain('hookAccountingOk:true');
    expect(result.stderr).toContain('realWorkOk:true');
    expect(result.stderr).toContain('exactCommandsOk:true');
    expect(listEvidenceFiles('smoke').length).toBe(0);
  }, 30000);

  it('leaves no registered git worktree behind after a passing run (removeScenarioWorktree ran)', () => {
    const result = runCli(smokeArgs(), fakeClaudeEnv('success'));
    expect(result.status).toBe(0);
    const worktreeList = gitViaBash(['worktree', 'list'], sourceRepoDir);
    // Only the main working tree (sourceRepoDir itself) should be listed -- no scenario
    // worktree left registered.
    expect(worktreeList.trim().split('\n').length).toBe(1);
  }, 30000);

  it('leaves no registered git worktree behind after a FAILING run either (cleanup runs in finally)', () => {
    const result = runCli(smokeArgs(), fakeClaudeEnv('all-denied'));
    expect(result.status).toBe(1);
    const worktreeList = gitViaBash(['worktree', 'list'], sourceRepoDir);
    expect(worktreeList.trim().split('\n').length).toBe(1);
  }, 30000);

  // Mirrors calibrate's identical proof above: a malformed --measurement-scope-file must fail
  // closed before any Claude session spawns -- proven via a REAL subprocess against a fixture
  // ('success') that would otherwise clearly succeed, so no worktree is ever materialized.
  it('a malformed --measurement-scope-file fails closed before spawning any Claude session', () => {
    const result = runCli(
      smokeArgs(['--measurement-scope-file', path.join(isolatedTmp, 'does-not-exist-scope.json')]),
      fakeClaudeEnv('success'),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--measurement-scope-file is invalid/);
    expect(listEvidenceFiles('smoke')).toEqual([]);
    const worktreeList = gitViaBash(['worktree', 'list'], sourceRepoDir);
    expect(worktreeList.trim().split('\n').length).toBe(1);
  }, 30000);
});

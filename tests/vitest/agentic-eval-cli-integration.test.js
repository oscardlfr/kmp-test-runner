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
      expect(record.schema).toBe(1);
    }
  }, 20000);

  // This fixture's no-skill arm (A) genuinely attempts nothing; its current-skill arm (B)
  // genuinely attempts AND succeeds (mirrors the success fixture's own Skill-invocation shape).
  // Asserting the granular reason string -- not just "it failed" -- proves invocationOk is the
  // ONLY named sub-check this fixture trips, isolating specifically "A never attempted" rather
  // than both arms trivially being empty/identical.
  it('no-tool-use scenario: fails the hard gate (no attempt at all) and writes NO evidence', () => {
    const result = runCli(['calibrate', '--model', 'fake-model-x'], fakeClaudeEnv('no-tool-use'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CALIBRATION FAILED');
    expect(result.stderr).toContain('invocationOk:false');
    expect(result.stderr).toContain('processOk:true');
    expect(result.stderr).toContain('resultOk:true');
    expect(result.stderr).toContain('hookAccountingOk:true');
    expect(listEvidenceFiles('calibration').length).toBe(0);
  }, 20000);

  it('leaves no leftover temp directories after a passing run (cleanup ran)', () => {
    const result = runCli(['calibrate', '--model', 'fake-model-x'], fakeClaudeEnv('success'));
    expect(result.status).toBe(0);
    expect(readdirSync(isolatedTmp)).toEqual([]);
  }, 20000);

  it('leaves no leftover temp directories after a FAILING run either (cleanup runs in finally)', () => {
    const result = runCli(['calibrate', '--model', 'fake-model-x'], fakeClaudeEnv('no-tool-use'));
    expect(result.status).toBe(1);
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
    } finally {
      rmSync(patternsFile, { force: true });
    }
  }, 30000);

  // Regression coverage for a real bypass an independent review pass demonstrated: records were
  // redacted (assertCleanOrThrow, which only checks for LEAK patterns via findLeaks, not JSON
  // structural validity) and WRITTEN to disk, with JSON.parse() only attempted afterward -- a
  // private-pattern replacement string containing a raw, unescaped newline breaks JSON syntax
  // once substituted into what was a JSON string value, but findLeaks has no way to catch that,
  // so invalid-JSON evidence could previously reach disk. This drives a real subprocess with a
  // patterns file whose replacement contains an actual newline byte (valid in the patterns FILE
  // itself, which JSON-escapes it as \n -- redactText substitutes the REAL in-memory string,
  // newline byte and all) and asserts the run fails closed with NO evidence written, rather than
  // writing a file that then can't even be parsed back.
  it('refuses to write evidence when a private-pattern replacement would produce invalid JSON', () => {
    const patternsFile = path.join(os.tmpdir(), `aeci-breaking-patterns-${process.pid}-${Date.now()}.json`);
    const secretMarker = 'another-fake-marker-not-a-real-secret-xyz';
    writeFileSync(patternsFile, JSON.stringify([
      { class: 'test_marker', literal: secretMarker, replacement: 'line-one\nline-two-breaks-json' },
    ]));
    try {
      const before = listEvidenceFiles('smoke');
      const result = runCli(smokeArgs(['--private-patterns-file', patternsFile], secretMarker), fakeClaudeEnv('success'));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('SMOKE FAILED');
      expect(result.stderr.toLowerCase()).toContain('invalid json');
      expect(listEvidenceFiles('smoke')).toEqual(before);
    } finally {
      rmSync(patternsFile, { force: true });
    }
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
});

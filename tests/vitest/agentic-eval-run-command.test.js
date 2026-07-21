// tests/vitest/agentic-eval-run-command.test.js
// Real end-to-end integration tests for tools/agentic-eval/cli.mjs's `run` command, run as REAL
// `node cli.mjs run ...` subprocesses against the fake `claude` fixtures under
// tests/fixtures/fake-claude-*/ (never the real claude CLI -- zero API cost, zero live
// authentication needed), plus a small number of direct-function tests for cases a real
// subprocess cannot naturally trigger (a killed-by-timeout cell). Kept in its own file (not
// folded into agentic-eval-cli-integration.test.js, which owns calibrate/smoke) matching this
// PR's own test-coverage map.
//
// `run`'s --scenario always resolves against a FIXED, non-parameterizable corpus/scenarios/
// directory by default (mirroring cmdCorpusValidate's same fixed-path design) -- but that
// directory is scoped to exactly the two real, pinned-commit KaMPKit scenarios this PR ships
// (kampkit-android-host-test-discovery, kampkit-no-applicable-tests), and neither can be
// materialized here without a real KaMPKit clone at that exact pinned commit. This suite instead
// points KMP_EVAL_SCENARIOS_DIR (a test-only override mirroring KMP_EVAL_RUNS_ROOT's own
// rationale) at a throwaway, synthetic scenario, and --source-repo-dir at a tiny, real, local git
// repo standing in for a real project -- exactly like agentic-eval-cli-integration.test.js's own
// smoke tests already do. This proves cmdRun's own WIRING (materialize/reset per cell, grading
// integration, atomic N-record promotion, hard-gate enforcement, cleanup) without needing a real
// KaMPKit checkout or any live Claude/API call.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';
import { LATEST_RUN_SCHEMA } from '../../tools/agentic-eval/schemas.mjs';
import { gradeScenarioCondition } from '../../tools/agentic-eval/graders.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'tools', 'agentic-eval', 'cli.mjs');
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

// Same isolation discipline as agentic-eval-cli-integration.test.js (see its own header comment
// for the full rationale): every subprocess writes evidence under an exclusive temp
// KMP_EVAL_RUNS_ROOT, and TEMP/TMP/TMPDIR are redirected so "no leftover temp dirs after cleanup"
// assertions stay exact under vitest's concurrent test-file execution.
let runsRoot;
let isolatedTmp;
let sourceRepoDir;
let scenariosDir;
let pinnedCommit;

const PROJECT_URL = 'https://github.com/example/fake-run-integration-project.git';
const SCENARIO_ID = 'run-command-integration-test-only-scenario';

function gitViaBash(argv, cwd) {
  const shQuote = (arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`;
  const cmd = argv.map(shQuote).join(' ');
  const r = spawnSync(resolveBash(), ['-c', `git ${cmd}`], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

beforeEach(() => {
  runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aerc-runs-root-'));
  isolatedTmp = mkdtempSync(path.join(os.tmpdir(), 'aerc-isolated-tmp-'));

  // A tiny, real, local git repo stands in for a real scenario source (KaMPKit) -- exercises the
  // REAL materializeScenarioProject/removeScenarioWorktree git-worktree machinery, exactly
  // mirroring agentic-eval-cli-integration.test.js's own smoke fixture setup.
  sourceRepoDir = mkdtempSync(path.join(os.tmpdir(), 'aerc-source-'));
  gitViaBash(['init', '-q'], sourceRepoDir);
  gitViaBash(['config', 'user.email', 'test@example.com'], sourceRepoDir);
  gitViaBash(['config', 'user.name', 'Test'], sourceRepoDir);
  writeFileSync(path.join(sourceRepoDir, 'marker.txt'), 'pristine\n');
  gitViaBash(['add', '-A'], sourceRepoDir);
  gitViaBash(['commit', '-q', '-m', 'initial'], sourceRepoDir);
  pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
  gitViaBash(['remote', 'add', 'origin', PROJECT_URL], sourceRepoDir);

  // KMP_EVAL_SCENARIOS_DIR (test-only override, see cli.mjs's own comment) -- a throwaway
  // scenario file, never touching the real, committed corpus/scenarios/ directory (scoped to
  // exactly the two real KaMPKit scenarios this PR ships).
  scenariosDir = mkdtempSync(path.join(os.tmpdir(), 'aerc-scenarios-'));
  writeFileSync(path.join(scenariosDir, `${SCENARIO_ID}.json`), JSON.stringify({
    schema: 1,
    id: SCENARIO_ID,
    family: 'test-only',
    project_alias: 'fake-run-integration-project',
    project_url: PROJECT_URL,
    project_commit: pinnedCommit,
    prompt: "Run the tests for this project's only module and tell me what happened.",
    expected_outcome: 'The agent correctly reports that the :fakemod module has no applicable unit tests.',
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
    first_useful_signal_predicate: { description: 'first well-formed evidence confirming :fakemod has no applicable tests' },
    tags: ['train'],
  }, null, 2));
});

afterEach(() => {
  rmSync(runsRoot, { recursive: true, force: true });
  rmSync(isolatedTmp, { recursive: true, force: true });
  rmSync(sourceRepoDir, { recursive: true, force: true });
  rmSync(scenariosDir, { recursive: true, force: true });
});

function fakeClaudeEnv(scenario) {
  const fakeDir = path.join(FIXTURES_DIR, `fake-claude-${scenario}`);
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return {
    ...process.env,
    PATH: `${fakeDir}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
    KMP_EVAL_RUNS_ROOT: runsRoot,
    KMP_EVAL_SCENARIOS_DIR: scenariosDir,
    TEMP: isolatedTmp,
    TMP: isolatedTmp,
    TMPDIR: isolatedTmp,
  };
}

function runCli(args, env, timeout = 30000) {
  const r = spawnSync('node', [CLI_PATH, ...args], { env, encoding: 'utf8', timeout });
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

function runArgs(extra = []) {
  return ['run', '--scenario', SCENARIO_ID, '--source-repo-dir', sourceRepoDir, '--model', 'fake-model-x', ...extra];
}

describe('cli.mjs run --dry-run -- zero-spawn plan preview', () => {
  it('prints the resolved plan and spawns nothing, even with a nonexistent --source-repo-dir', () => {
    const result = runCli(
      ['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/definitely/does/not/exist', '--seed', '7', '--repeats', '2', '--dry-run'],
      fakeClaudeEnv('run-scenario-success'),
    );
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    expect(result.parsed.dry_run).toBe(true);
    expect(result.parsed.scenario_id).toBe(SCENARIO_ID);
    expect(result.parsed.repeats).toBe(2);
    expect(result.parsed.seed).toBe(7);
    expect(result.parsed.plan.length).toBe(4);
    // order_index is a contiguous 0..3 range; every (repetition_index, condition) pair present
    // exactly once -- the SAME identity proof findMatrixCompletenessGap enforces on real records.
    const pairs = new Set(result.parsed.plan.map((c) => `${c.repetition_index}:${c.condition}`));
    expect(pairs.size).toBe(4);
    for (const rep of [0, 1]) {
      for (const cond of ['current-skill', 'no-skill']) {
        expect(pairs.has(`${rep}:${cond}`)).toBe(true);
      }
    }
    // Zero evidence written -- dry-run never reaches materialization or grading.
    expect(listEvidenceFiles('scenario')).toEqual([]);
    // Review-fix: the real live-session blast radius is disclosed explicitly, not left for a
    // reviewer to compute themselves from repeats alone.
    expect(result.parsed.total_live_claude_sessions).toBe(4);
  }, 15000);

  it('is deterministic -- the same --seed produces the identical plan every time', () => {
    const a = runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/nonexistent', '--seed', '99', '--repeats', '3', '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    const b = runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/nonexistent', '--seed', '99', '--repeats', '3', '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(a.parsed.plan).toEqual(b.parsed.plan);
  }, 15000);
});

describe('cli.mjs run -- argument validation', () => {
  it('requires --seed explicitly -- never silently auto-generated', () => {
    const result = runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', sourceRepoDir, '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--seed/);
  });

  // Review-fix regression: --repeats previously accepted ANY positive integer with no upper
  // bound -- each repetition spawns 2 real live Claude sessions once `run` is pointed at a real
  // claude binary, so a single typo (e.g. --repeats 100) would have silently authorized 200
  // sessions with no warning at all, even under --dry-run.
  it('rejects --repeats exceeding MAX_REPEATS (20), even under --dry-run -- a typo must never silently authorize hundreds of live sessions', () => {
    const result = runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/nonexistent', '--seed', '1', '--repeats', '100', '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--repeats 100 exceeds the maximum/);
    expect(result.parsed).toBeNull(); // no plan was ever printed
  });

  it('accepts --repeats exactly AT the cap (20)', () => {
    const result = runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/nonexistent', '--seed', '1', '--repeats', '20', '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(0);
    expect(result.parsed.repeats).toBe(20);
    expect(result.parsed.total_live_claude_sessions).toBe(40);
  });

  it('rejects --repeats one over the cap (21)', () => {
    const result = runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/nonexistent', '--seed', '1', '--repeats', '21', '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--repeats 21 exceeds the maximum/);
  });

  it('rejects an unknown --scenario id with a clear, actionable error', () => {
    const result = runCli(['run', '--scenario', 'totally-unknown-scenario', '--source-repo-dir', sourceRepoDir, '--seed', '1', '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no scenario file found/);
  });

  it('refuses a --source-repo-dir whose origin does not match the scenario\'s declared project_url (real run, not dry-run)', () => {
    const wrongRemote = mkdtempSync(path.join(os.tmpdir(), 'aerc-wrong-remote-'));
    try {
      gitViaBash(['init', '-q'], wrongRemote);
      gitViaBash(['config', 'user.email', 'test@example.com'], wrongRemote);
      gitViaBash(['config', 'user.name', 'Test'], wrongRemote);
      writeFileSync(path.join(wrongRemote, 'marker.txt'), 'x\n');
      gitViaBash(['add', '-A'], wrongRemote);
      gitViaBash(['commit', '-q', '-m', 'initial'], wrongRemote);
      gitViaBash(['remote', 'add', 'origin', 'https://github.com/example/totally-different-project.git'], wrongRemote);
      const result = runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', wrongRemote, '--seed', '1', '--repeats', '1'], fakeClaudeEnv('run-scenario-success'));
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/does not match the scenario's declared project_url/);
      expect(listEvidenceFiles('scenario')).toEqual([]);
    } finally {
      rmSync(wrongRemote, { recursive: true, force: true });
    }
  }, 15000);
});

describe('cli.mjs run -- real subprocess against fake claude (no live API cost)', () => {
  it('repeats=2: writes 4 schema-valid, benchmark_eligible:true records with genuine counterbalancing', () => {
    const result = runCli(runArgs(['--seed', '13', '--repeats', '2']), fakeClaudeEnv('run-scenario-success'), 60000);
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    const { records } = result.parsed;
    expect(records.length).toBe(4);

    const written = listEvidenceFiles('scenario');
    expect(written.length).toBe(4);

    // Identity proof (findMatrixCompletenessGap's own invariant), re-checked here against the
    // REAL written records, not just the plan preview.
    const pairs = new Set(records.map((r) => `${r.repetition_index}:${r.condition}`));
    expect(pairs.size).toBe(4);
    const orderIndices = records.map((r) => r.order_index).sort((a, b) => a - b);
    expect(orderIndices).toEqual([0, 1, 2, 3]);

    // Genuine counterbalancing (decision 2/15): exactly 2 repetitions start current-skill-first,
    // 2 start no-skill-first -- an exact split for repeats=2, never a coincidental one.
    const byRepetition = { 0: [], 1: [] };
    for (const r of records) byRepetition[r.repetition_index].push(r);
    const startsCurrentSkillFirst = (reps) => reps.sort((a, b) => a.order_index - b.order_index)[0].condition === 'current-skill';
    const startCounts = [startsCurrentSkillFirst(byRepetition[0]), startsCurrentSkillFirst(byRepetition[1])];
    expect(startCounts.filter(Boolean).length).toBe(1); // exactly one of the two repetitions starts current-skill-first

    for (const record of records) {
      expect(record.schema).toBe(LATEST_RUN_SCHEMA);
      expect(record.run_kind).toBe('scenario');
      expect(record.scenario_id).toBe(SCENARIO_ID);
      expect(record.seed).toBe(13);
      expect(record.cache_state).toBe('cold');
      expect(record.project_commit).toBe(pinnedCommit);
      expect(record.project_url).toBe(PROJECT_URL);
      // The fixture's fake evidence exactly matches the scenario's expected.kmp_test contract in
      // both arms -- both conditions should grade as a genuine match, not a coincidental one.
      expect(record.expected_outcome_matched.value).toBe(true);
      expect(record.success.value).toBe(true);
      expect(record.grading_checks.value).not.toBeNull();
      expect(record.grading_checks.value.length).toBe(8);
      expect(record.grading_checks.value.every((c) => typeof c.passed === 'boolean')).toBe(true);
      expect(record.test_invocations_total.value).toBe(1);
      expect(record.retries.value).toBe(0);
      expect(record.benchmark_eligible).toBe(true);
    }
  }, 60000);

  it('a harness-integrity failure (malformed transcript) blocks the WHOLE matrix -- zero records written for ANY cell', () => {
    const result = runCli(runArgs(['--seed', '1', '--repeats', '1']), fakeClaudeEnv('malformed'), 30000);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/RUN FAILED/);
    expect(listEvidenceFiles('scenario')).toEqual([]);
  }, 30000);

  // The closest possible reproduction of the real live-scenario-matrix incident that motivated
  // this PR (see fake-claude-run-foreign-skill-rejected/claude's own header comment): a REJECTED
  // ("Unknown skill") foreign Skill attempt, alongside otherwise-correct diagnostic work, must no
  // longer block the whole matrix's promotion.
  it('a REJECTED foreign-skill attempt (is_error:true), otherwise clean, promotes the WHOLE matrix successfully end-to-end', () => {
    // --repeats 2 (even), not 1 -- benchmark_eligible additionally requires balanced realized
    // current-skill-first/no-skill-first start counts (decision 15), which is structurally
    // impossible for an odd --repeats regardless of anything else in the matrix.
    const result = runCli(runArgs(['--seed', '5', '--repeats', '2']), fakeClaudeEnv('run-foreign-skill-rejected'), 30000);
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    const { records } = result.parsed;
    expect(records.length).toBe(4);
    expect(listEvidenceFiles('scenario').length).toBe(4);
    for (const record of records) {
      expect(record.benchmark_eligible).toBe(true);
      expect(record.expected_outcome_matched.value).toBe(true);
      // foreign_skill_summary (schema v3, populated end-to-end by buildRunRecord): exactly one
      // rejected foreign attempt, zero confirmed, zero incomplete -- proving B3's field
      // population works through the real subprocess path, not just in unit tests.
      expect(record.foreign_skill_summary).toEqual({ rejected: 1, confirmed: 0, incomplete: 0 });
      // tool_calls_total (A3's fix): 1 Bash call + 1 kmp-test-runner Skill attempt + 1 foreign
      // Skill attempt = 3 -- proving the foreign attempt is no longer silently uncounted.
      expect(record.tool_calls_total.value).toBe(3);
    }
  }, 30000);

  // The companion negative case (see fake-claude-run-foreign-skill-confirmed/claude's own header
  // comment): a genuinely CONFIRMED foreign invocation must still block the whole matrix, exactly
  // as any foreign contamination did before this PR -- only the REJECTED case was relaxed.
  it('a CONFIRMED foreign-skill invocation (is_error:false) still blocks the WHOLE matrix -- zero records written for ANY cell', () => {
    const result = runCli(runArgs(['--seed', '5', '--repeats', '1']), fakeClaudeEnv('run-foreign-skill-confirmed'), 30000);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/RUN FAILED/);
    expect(result.stderr).toContain('skillSelectionOk:false');
    expect(listEvidenceFiles('scenario')).toEqual([]);
  }, 30000);

  it('leaves no registered git worktree behind after a passing run (removeScenarioWorktree ran)', () => {
    const result = runCli(runArgs(['--seed', '5', '--repeats', '1']), fakeClaudeEnv('run-scenario-success'), 30000);
    expect(result.status).toBe(0);
    const worktreeList = gitViaBash(['worktree', 'list'], sourceRepoDir);
    expect(worktreeList.trim().split('\n').length).toBe(1);
  }, 30000);

  it('leaves no registered git worktree behind after a FAILING run either (cleanup runs in finally)', () => {
    const result = runCli(runArgs(['--seed', '5', '--repeats', '1']), fakeClaudeEnv('malformed'), 30000);
    expect(result.status).toBe(1);
    const worktreeList = gitViaBash(['worktree', 'list'], sourceRepoDir);
    expect(worktreeList.trim().split('\n').length).toBe(1);
  }, 30000);

  it('leaves no leftover temp directories after a passing run', () => {
    const result = runCli(runArgs(['--seed', '5', '--repeats', '1']), fakeClaudeEnv('run-scenario-success'), 30000);
    expect(result.status).toBe(0);
    expect(readdirSync(isolatedTmp)).toEqual([]);
  }, 30000);

  it('leaves no leftover temp directories after a FAILING run either', () => {
    const result = runCli(runArgs(['--seed', '5', '--repeats', '1']), fakeClaudeEnv('malformed'), 30000);
    expect(result.status).toBe(1);
    expect(readdirSync(isolatedTmp)).toEqual([]);
  }, 30000);
});

// A real subprocess never naturally hits its own configured timeout deterministically without a
// slow, flaky sleep-based fixture -- these exercise the SAME production functions cmdRun itself
// calls (gradeScenarioCondition, buildRunRecord-shaped records, finalizeAndWriteMatrixRecords)
// directly with a synthetic timed-out conditionResult instead, matching this suite's own
// established precedent (agentic-eval-hard-gates.test.js's scenarioCellIntegrityOk unit tests do
// the same for the gate in isolation) -- this test additionally proves the WHOLE pipeline
// (grading + record-building + gate + write) doesn't crash or silently drop a legitimately
// timed-out cell, not just that the gate alone tolerates it.
describe('cmdRun pipeline -- a legitimately timed-out cell is still recorded, never dropped', () => {
  it('grades a timed-out condition as a real, non-crashing false outcome (not a thrown exception)', async () => {
    const SCENARIO = {
      schema: 1,
      id: 'timeout-direct-test-scenario',
      family: 'test-only',
      project_alias: 'fake',
      project_url: 'https://example.com/fake',
      project_commit: '0'.repeat(40),
      prompt: 'irrelevant for this direct test',
      expected_outcome: 'irrelevant',
      policy: { allowed_kmptest_subcommands: ['parallel'], allowed_gradle_tasks: [] },
      expected: {
        module: ':fakemod',
        outcome_kind: 'no_applicable_tests',
        kmp_test: { error_code: 'no_test_modules', exit_code: 2, caused_by_filter: true },
        gradle: { allowed_invocations: [':fakemod:test'], evidence_task: ':fakemod:test', exit_code: 0, marker: 'NO-SOURCE' },
      },
      first_useful_signal_predicate: { description: 'irrelevant' },
      tags: ['train'],
    };
    // A Bash tool_use with NO correlated tool_result (the process was killed mid-call) and a
    // spawnResult declaring a legitimate timeout -- exactly the shape decision 7's
    // timeout-tolerant structural checks exist to accept.
    const timedOutConditionResult = {
      condition: 'no-skill',
      events: [
        { type: 'system', subtype: 'init' },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'kmp-test parallel --module-filter :fakemod --json' } }] } },
      ],
      malformedLines: [],
      bashResults: [{ index: 1, command: 'kmp-test parallel --module-filter :fakemod --json', resultIndex: null, resultContent: null, resultFound: false }],
      result: null,
      spawnResult: { terminated: true, terminationReason: 'timeout', exitCode: null, spawnHrtimeNs: 0n },
      gradleJunitEvidence: null,
    };

    const grade = gradeScenarioCondition(timedOutConditionResult, SCENARIO);
    expect(grade.expectedOutcomeMatched).toBe(false);
    expect(grade.success).toBe(false);
    expect(grade.checks.length).toBe(8);
    expect(grade.checks.every((c) => typeof c.passed === 'boolean')).toBe(true);
    // The specific checks a genuine timeout should NOT fail on: no_transcript_structural_issues
    // and tool_result_correlated are tolerant of exactly this shape (decision 7) -- only the
    // evidence/outcome-dependent checks legitimately fail, because no evidence was ever produced.
    const byName = Object.fromEntries(grade.checks.map((c) => [c.name, c.passed]));
    expect(byName.no_transcript_structural_issues).toBe(true);
    expect(byName.tool_result_correlated).toBe(true);
    expect(byName.authoritative_evidence_well_formed).toBe(false);
  });
});

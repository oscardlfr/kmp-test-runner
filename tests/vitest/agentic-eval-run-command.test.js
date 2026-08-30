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
// directory holds three real, pinned-commit scenarios (kampkit-android-host-test-discovery,
// kampkit-no-applicable-tests against KaMPKit; nowinandroid-core-common against NowInAndroid),
// and none of them can be materialized here without a real clone at that exact pinned commit.
// This suite instead
// points KMP_EVAL_SCENARIOS_DIR (a test-only override mirroring KMP_EVAL_RUNS_ROOT's own
// rationale) at a throwaway, synthetic scenario, and --source-repo-dir at a tiny, real, local git
// repo standing in for a real project -- exactly like agentic-eval-cli-integration.test.js's own
// smoke tests already do. This proves cmdRun's own WIRING (materialize/reset per cell, grading
// integration, atomic N-record promotion, hard-gate enforcement, cleanup) without needing a real
// KaMPKit checkout or any live Claude/API call.
//
// runCli() spawns each `node cli.mjs run ...` subprocess ASYNCHRONOUSLY (round-8 fix -- see this
// function's own comment): this file grew past 24 real subprocess invocations across its own
// round-7/round-8 additions, and hosted Windows CI measured this file at ~69s wall-clock, wholly
// spent inside back-to-back synchronous spawnSync calls with essentially no event-loop yielding in
// between. Vitest's own worker RPC layer needs the event loop free to send its periodic
// "onTaskUpdate" heartbeat; a long enough run of uninterrupted synchronous blocking crossed that
// internal timeout on Windows CI specifically (`Error: [vitest-worker]: Timeout calling
// "onTaskUpdate"`) on BOTH of this PR's hosted Windows runs, even though every one of the 3729
// tests in the full suite passed cleanly. gitViaBash() below stays synchronous deliberately --
// its own calls (git init/config/commit, used only in setup and a couple of assertions) are
// millisecond-scale, never the actual contributor to the cumulative blocking time.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';
import { LATEST_RUN_SCHEMA } from '../../tools/agentic-eval/schemas.mjs';
import { gradeScenarioCondition } from '../../tools/agentic-eval/graders.mjs';
import {
  findAllToolUsesWithResults, findResultEvent, findTranscriptStructuralIssuesToleratingTimeout,
  findIncompleteToolResultsToleratingTimeout,
} from '../../tools/agentic-eval/stream-parser.mjs';
import { aggregateRuns } from '../../tools/agentic-eval/aggregate.mjs';
import { validateAcceptedRunAuditSidecar, crossValidateAcceptedRunAuditAgainstRecord } from '../../tools/agentic-eval/accepted-run-audit.mjs';

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
  // scenario file, never touching the real, committed corpus/scenarios/ directory (which holds
  // the three real scenarios: two KaMPKit-based, one NowInAndroid-based).
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

/** Spawns `node cli.mjs run ...` ASYNCHRONOUSLY (round-8 fix -- see this file's own header
 * comment for the full Windows-CI RPC-timeout rationale) -- never spawnSync, so the event loop
 * stays free between subprocess exits and Vitest's own RPC layer never goes quiet for the whole
 * duration of a 1-7-second child process. Same external contract as the pre-existing spawnSync-
 * based helper it replaces: resolves to `{status, stdout, stderr, parsed}`, `parsed` is `null`
 * on anything that doesn't parse as JSON (a stderr-only failure path), `status` is the child's
 * real exit code (or `null` if the timeout killed it first, mirroring spawnSync's own timeout
 * contract -- no test in this file asserts on that specific shape, it exists purely as a safety
 * net against a hung child blocking the whole run). On timeout, the timer only signals `child.kill()`
 * and never resolves by itself -- resolution always happens from the `close` handler, once the
 * killed child has actually exited, so the next test's beforeEach/afterEach never races a
 * still-alive process over the same temp/run directories (spawnSync's own timeout implicitly had
 * this property for free; naively resolving as soon as kill() is called would silently lose it).
 * Every caller must `await` this. */
function runCli(args, env, timeout = 30000) {
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
    }, timeout);
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

/** The accepted-run-audit sidecar actually written to disk beside a promoted scenario record --
 * resolved through the same deterministic `audit/<run_id>.json` path the record's own
 * accepted_audit.relative_path points at. */
function readAcceptedAuditSidecar(runId) {
  return JSON.parse(readFileSync(path.join(evidenceDirFor('scenario'), 'audit', `${runId}.json`), 'utf8'));
}

// --model must be a real registered model_id now that cmdRun resolves the selection against
// registries.mjs before any spawn (agentic-eval-runtime-neutral-records-v1) -- 'fake-model-x' is
// no longer a valid --model value; the FAKE-claude binary invoked via PATH override is still free
// to report whatever synthetic `model_resolved` it wants in its own init event, independent of
// the real, registered `--model` requested here.
function runArgs(extra = []) {
  return ['run', '--scenario', SCENARIO_ID, '--source-repo-dir', sourceRepoDir, '--model', 'claude-sonnet-5', ...extra];
}

// "zero-spawn" here means what every test in THIS block actually exercises: no
// --measurement-scope-file supplied. With that flag, --dry-run still never spawns Claude or
// touches --source-repo-dir, but it DOES invoke real `git` subprocesses to validate the supplied
// scope file -- see the "cli.mjs run --dry-run + --measurement-scope-file" describe block below,
// and cmdRun's own doc comment in cli.mjs, for that precise, narrower contract.
describe('cli.mjs run --dry-run -- zero-spawn plan preview', () => {
  it('prints the resolved plan and spawns nothing, even with a nonexistent --source-repo-dir', async () => {
    const result = await runCli(
      ['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/definitely/does/not/exist', '--seed', '7', '--repeats', '2', '--max-budget-usd', '1.50', '--dry-run'],
      fakeClaudeEnv('run-scenario-success'),
    );
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    expect(result.parsed.dry_run).toBe(true);
    expect(result.parsed.scenario_id).toBe(SCENARIO_ID);
    expect(result.parsed.repeats).toBe(2);
    expect(result.parsed.seed).toBe(7);
    expect(result.parsed.max_budget_usd).toBe(1.5);
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
    // reviewer to compute themselves from repeats alone. Runtime-neutral name (never the
    // Claude-specific total_live_claude_sessions -- agentic-eval-runtime-neutral-records-v1).
    expect(result.parsed.total_live_sessions).toBe(4);
    expect(result.parsed.total_live_claude_sessions).toBeUndefined();
    // The dry-run preview now names the resolved registry selection explicitly -- the exact
    // default (every flag omitted) resolves to claude-code / claude-sonnet-5 / strict-policy-v1.
    expect(result.parsed.runtime_id).toBe('claude-code');
    expect(result.parsed.model_id).toBe('claude-sonnet-5');
    expect(result.parsed.model_vendor_expected).toBe('anthropic');
    expect(result.parsed.execution_profile_id).toBe('strict-policy-v1');
    expect(result.parsed.execution_profile_sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 15000);

  it('is deterministic -- the same --seed produces the identical plan every time', async () => {
    const a = await runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/nonexistent', '--seed', '99', '--repeats', '3', '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    const b = await runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/nonexistent', '--seed', '99', '--repeats', '3', '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(a.parsed.plan).toEqual(b.parsed.plan);
  }, 15000);
});

describe('cli.mjs run -- argument validation', () => {
  it('requires --seed explicitly -- never silently auto-generated', async () => {
    const result = await runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', sourceRepoDir, '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--seed/);
  });

  // Registry selection (agentic-eval-runtime-neutral-records-v1) is resolved before ANY other
  // check, including argument parsing that follows it -- an unknown/disabled/incompatible
  // --runtime/--model/--execution-profile fails closed with exit 1 and prints no plan at all,
  // even under --dry-run (which itself never spawns anything -- this proves the failure happens
  // strictly earlier than even that zero-spawn preview).
  it('an unknown --runtime fails closed, even under --dry-run, with no plan ever printed', async () => {
    const result = await runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', sourceRepoDir, '--seed', '1', '--runtime', 'nonexistent-runtime', '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(1);
    expect(result.parsed).toBeNull();
  });

  it('an unknown --model fails closed the same way', async () => {
    const result = await runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', sourceRepoDir, '--seed', '1', '--model', 'not-a-real-model', '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(1);
    expect(result.parsed).toBeNull();
  });

  it('an unknown --execution-profile fails closed the same way', async () => {
    const result = await runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', sourceRepoDir, '--seed', '1', '--execution-profile', 'not-a-real-profile', '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(1);
    expect(result.parsed).toBeNull();
  });

  // A disabled selection (not merely unknown) must fail the identical way -- proven against the
  // real shipped registry content itself: --execution-profile is case-sensitive and
  // 'Strict-Policy-v1' is not a registered id (the closed [a-z0-9][a-z0-9-]* charset never
  // matches an uppercase letter), so this doubles as an id-charset/unknown-id proof too.
  it('a syntactically-close but unregistered id is rejected, never fuzzy-matched to a real one', async () => {
    const result = await runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', sourceRepoDir, '--seed', '1', '--execution-profile', 'Strict-Policy-v1', '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(1);
    expect(result.parsed).toBeNull();
  });

  // Explicit defaults must resolve to the byte-identical selection as omitted flags -- the dry-run
  // preview IS that resolved selection made visible, so a deep-equal comparison here is a direct
  // proof of "same adapter/model/profile resolution", not just "both happen to succeed".
  it('explicit defaults produce the identical dry-run resolution as omitted defaults', async () => {
    const omitted = await runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', sourceRepoDir, '--seed', '42', '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    const explicit = await runCli([
      'run', '--scenario', SCENARIO_ID, '--source-repo-dir', sourceRepoDir, '--seed', '42',
      '--runtime', 'claude-code', '--model', 'claude-sonnet-5', '--execution-profile', 'strict-policy-v1', '--dry-run',
    ], fakeClaudeEnv('run-scenario-success'));
    expect(omitted.status).toBe(0);
    expect(explicit.status).toBe(0);
    expect(explicit.parsed).toEqual(omitted.parsed);
  });

  // Review-fix regression: --repeats previously accepted ANY positive integer with no upper
  // bound -- each repetition spawns 2 real live Claude sessions once `run` is pointed at a real
  // claude binary, so a single typo (e.g. --repeats 100) would have silently authorized 200
  // sessions with no warning at all, even under --dry-run.
  it('rejects --repeats exceeding MAX_REPEATS (20), even under --dry-run -- a typo must never silently authorize hundreds of live sessions', async () => {
    const result = await runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/nonexistent', '--seed', '1', '--repeats', '100', '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--repeats 100 exceeds the maximum/);
    expect(result.parsed).toBeNull(); // no plan was ever printed
  });

  it('accepts --repeats exactly AT the cap (20)', async () => {
    const result = await runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/nonexistent', '--seed', '1', '--repeats', '20', '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(0);
    expect(result.parsed.repeats).toBe(20);
    expect(result.parsed.total_live_sessions).toBe(40);
  });

  it('rejects --repeats one over the cap (21)', async () => {
    const result = await runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/nonexistent', '--seed', '1', '--repeats', '21', '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--repeats 21 exceeds the maximum/);
  });

  it('rejects an unknown --scenario id with a clear, actionable error', async () => {
    const result = await runCli(['run', '--scenario', 'totally-unknown-scenario', '--source-repo-dir', sourceRepoDir, '--seed', '1', '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no scenario file found/);
  });

  it('refuses a --source-repo-dir whose origin does not match the scenario\'s declared project_url (real run, not dry-run)', async () => {
    const wrongRemote = mkdtempSync(path.join(os.tmpdir(), 'aerc-wrong-remote-'));
    try {
      gitViaBash(['init', '-q'], wrongRemote);
      gitViaBash(['config', 'user.email', 'test@example.com'], wrongRemote);
      gitViaBash(['config', 'user.name', 'Test'], wrongRemote);
      writeFileSync(path.join(wrongRemote, 'marker.txt'), 'x\n');
      gitViaBash(['add', '-A'], wrongRemote);
      gitViaBash(['commit', '-q', '-m', 'initial'], wrongRemote);
      gitViaBash(['remote', 'add', 'origin', 'https://github.com/example/totally-different-project.git'], wrongRemote);
      const result = await runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', wrongRemote, '--seed', '1', '--repeats', '1'], fakeClaudeEnv('run-scenario-success'));
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/does not match the scenario's declared project_url/);
      expect(listEvidenceFiles('scenario')).toEqual([]);
    } finally {
      rmSync(wrongRemote, { recursive: true, force: true });
    }
  }, 15000);
});

describe('cli.mjs run --dry-run + --measurement-scope-file', () => {
  it('reports scope_id in the preview JSON, and the raw key never appears anywhere in stdout', async () => {
    const scopeDir = mkdtempSync(path.join(os.tmpdir(), 'aerc-scope-dryrun-'));
    try {
      const scopeFile = path.join(scopeDir, 'scope.json');
      const init = await runCli(['scope', 'init', '--out', scopeFile], fakeClaudeEnv('run-scenario-success'));
      expect(init.status).toBe(0);
      const knownKeyBase64 = JSON.parse(readFileSync(scopeFile, 'utf8')).hmac_key_base64;

      const result = await runCli(
        ['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/definitely/does/not/exist', '--seed', '7', '--repeats', '2', '--dry-run', '--measurement-scope-file', scopeFile],
        fakeClaudeEnv('run-scenario-success'),
      );
      expect(result.status).toBe(0);
      expect(result.parsed.measurement_scope.source).toBe('supplied');
      expect(result.parsed.measurement_scope.scope_id).toBe(JSON.parse(readFileSync(scopeFile, 'utf8')).scope_id);
      expect(Object.keys(result.parsed.measurement_scope).sort()).toEqual(['scope_id', 'source']);
      expect(result.stdout).not.toContain(knownKeyBase64);
      expect(result.stderr).not.toContain(knownKeyBase64);
    } finally {
      rmSync(scopeDir, { recursive: true, force: true });
    }
  }, 15000);

  it('bare --dry-run (no scope flag) keeps today\'s exact JSON shape -- no measurement_scope key at all', async () => {
    const result = await runCli(
      ['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/definitely/does/not/exist', '--seed', '7', '--repeats', '2', '--dry-run'],
      fakeClaudeEnv('run-scenario-success'),
    );
    expect(result.status).toBe(0);
    expect('measurement_scope' in result.parsed).toBe(false);
  });

  it('a malformed --measurement-scope-file fails closed BEFORE the dry-run preview is ever printed', async () => {
    const result = await runCli(
      ['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/definitely/does/not/exist', '--seed', '7', '--dry-run', '--measurement-scope-file', path.join(os.tmpdir(), 'aerc-does-not-exist-scope.json')],
      fakeClaudeEnv('run-scenario-success'),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--measurement-scope-file is invalid/);
    expect(result.parsed).toBeNull();
  });

  // Regression coverage: an explicitly-empty --measurement-scope-file value (a real, reachable
  // argv shape -- parseArgs accepts an empty-but-present value without stripping it) must fail
  // closed, never silently fall back to an ephemeral scope the way an OMITTED flag correctly does.
  it('an explicitly empty --measurement-scope-file value fails closed, never silently ephemeral', async () => {
    const result = await runCli(
      ['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/definitely/does/not/exist', '--seed', '7', '--dry-run', '--measurement-scope-file', ''],
      fakeClaudeEnv('run-scenario-success'),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--measurement-scope-file is invalid/);
    expect(result.parsed).toBeNull();
  });
});

describe('cli.mjs scope init', () => {
  it('creates a scope file printing only {scope_id, path}, never the key', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aerc-scopeinit-'));
    try {
      const file = path.join(dir, 'scope.json');
      const result = await runCli(['scope', 'init', '--out', file], fakeClaudeEnv('run-scenario-success'));
      expect(result.status).toBe(0);
      expect(Object.keys(result.parsed).sort()).toEqual(['path', 'scope_id']);
      const written = JSON.parse(readFileSync(file, 'utf8'));
      expect(result.parsed.scope_id).toBe(written.scope_id);
      expect(result.stdout).not.toContain(written.hmac_key_base64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing scope file, leaves it byte-identical, exit 1', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aerc-scopeinit-noclobber-'));
    try {
      const file = path.join(dir, 'scope.json');
      const first = await runCli(['scope', 'init', '--out', file], fakeClaudeEnv('run-scenario-success'));
      expect(first.status).toBe(0);
      const before = readFileSync(file, 'utf8');
      const second = await runCli(['scope', 'init', '--out', file], fakeClaudeEnv('run-scenario-success'));
      expect(second.status).toBe(1);
      expect(readFileSync(file, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires --out', async () => {
    const result = await runCli(['scope', 'init'], fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(1);
  });

  it('rejects an unknown extra positional after init', async () => {
    const result = await runCli(['scope', 'init', 'unexpected', '--out', 'x.json'], fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/extra argument/);
  });

  it('rejects an unknown scope sub-subcommand', async () => {
    const result = await runCli(['scope', 'bogus'], fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/usage: scope init/);
  });
});

// Correction 1 (plan): calibrate/smoke are always benchmark_eligible:false and refused outright
// by aggregateRuns(), so the longitudinal-aggregation proof must use `run`'s scenario records.
// Further correction: `condition` is itself a HARD_PARTITION_FIELDS entry, so a scenario
// matrix's no-skill and current-skill records can NEVER share a group with each other --
// the correct expectation is exactly 2 groups (one per condition) for two same-scope
// invocations of one scenario, not 1.
describe('measurement scope + aggregation -- 2 groups (one per condition), shared scope merges, different scope stays separate', () => {
  it('two run invocations sharing --measurement-scope-file aggregate into exactly 2 groups, each containing records from BOTH invocations; a third invocation with a different scope adds 2 more, separate groups', async () => {
    const scopeDir = mkdtempSync(path.join(os.tmpdir(), 'aerc-scope-agg-'));
    try {
      const scopeFile = path.join(scopeDir, 'shared-scope.json');
      const otherScopeFile = path.join(scopeDir, 'other-scope.json');
      expect((await runCli(['scope', 'init', '--out', scopeFile], fakeClaudeEnv('run-scenario-success'))).status).toBe(0);
      expect((await runCli(['scope', 'init', '--out', otherScopeFile], fakeClaudeEnv('run-scenario-success'))).status).toBe(0);

      const run1 = await runCli(runArgs(['--seed', '11', '--repeats', '2', '--measurement-scope-file', scopeFile]), fakeClaudeEnv('run-scenario-success'), 60000);
      const run2 = await runCli(runArgs(['--seed', '23', '--repeats', '2', '--measurement-scope-file', scopeFile]), fakeClaudeEnv('run-scenario-success'), 60000);
      const run3 = await runCli(runArgs(['--seed', '37', '--repeats', '2', '--measurement-scope-file', otherScopeFile]), fakeClaudeEnv('run-scenario-success'), 60000);
      for (const r of [run1, run2, run3]) expect(r.status).toBe(0);

      const sharedScopeId = run1.parsed.records[0].ambient_skill_profile.scope_id;
      for (const record of run2.parsed.records) expect(record.ambient_skill_profile.scope_id).toBe(sharedScopeId);
      for (const record of run3.parsed.records) expect(record.ambient_skill_profile.scope_id).not.toBe(sharedScopeId);

      const allRecords = [...run1.parsed.records, ...run2.parsed.records, ...run3.parsed.records];
      expect(allRecords.length).toBe(12); // 4 + 4 + 4

      const { groups, errors } = aggregateRuns(allRecords);
      expect(errors).toEqual([]);
      expect(groups.length).toBe(4); // 2 (shared scope, split by condition) + 2 (other scope, split by condition)

      const sharedGroups = groups.filter((g) => g.group_key.ambient_skill_profile.scope_id === sharedScopeId);
      expect(sharedGroups.length).toBe(2);
      expect(sharedGroups.map((g) => g.group_key.condition).sort()).toEqual(['current-skill', 'no-skill']);
      for (const g of sharedGroups) expect(g.run_count).toBe(4); // 2 (run1) + 2 (run2) per condition

      const otherGroups = groups.filter((g) => g.group_key.ambient_skill_profile.scope_id !== sharedScopeId);
      expect(otherGroups.length).toBe(2);
      expect(otherGroups.map((g) => g.group_key.condition).sort()).toEqual(['current-skill', 'no-skill']);
      for (const g of otherGroups) expect(g.run_count).toBe(2); // only run3

      // Never merges: no group mixes runs from both scopes.
      for (const g of groups) {
        const runIdsFromRun3 = new Set(run3.parsed.records.map((r) => r.run_id));
        const groupHasRun3 = g.runs.some((id) => runIdsFromRun3.has(id));
        const groupScopeId = g.group_key.ambient_skill_profile.scope_id;
        expect(groupHasRun3).toBe(groupScopeId !== sharedScopeId);
      }
    } finally {
      rmSync(scopeDir, { recursive: true, force: true });
    }
  }, 180000);
});

describe('cli.mjs run -- real subprocess against fake claude (no live API cost)', () => {
  it('repeats=2: writes 4 schema-valid, benchmark_eligible:true records with genuine counterbalancing', async () => {
    const result = await runCli(runArgs(['--seed', '13', '--repeats', '2']), fakeClaudeEnv('run-scenario-success'), 60000);
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
      // Stage 6 (agentic-eval-runtime-neutral-records-v1): the 4 new schema:6 groups are a REAL,
      // complete projection of the registry-resolved selection + the observation's own reported
      // identity -- proven directly against a real fake-claude run, not just via buildRunRecord's
      // own unit tests. agent_runtime/execution_profile are condition-independent (every record in
      // this matrix uses the same claude-code/strict-policy-v1 selection); skill_observation's own
      // delivery_mode/source_sha/treatment_size legitimately vary by condition (asserted below,
      // scoped to condition, since a blanket check here would be wrong for one arm).
      expect(record.agent_runtime).toEqual({
        runtime_id: 'claude-code', cli_version: 'fake', model_requested: 'claude-sonnet-5',
        model_resolved: 'claude-sonnet-5-fake-resolved', model_vendor_expected: 'anthropic', model_vendor_observed: null,
      });
      expect(record.execution_profile.id).toBe('strict-policy-v1');
      expect(record.execution_profile.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(record.execution_profile.isolation_kind).toBe('runtime-policy-hooks');
      expect(record.execution_profile.network_mode).toBe('runtime-default');
      expect(record.execution_profile.isolation_attestation_sha256).toBeNull();
      expect(record.skill_observation.delivery_mode).toBe(record.condition === 'current-skill' ? 'runtime-extension' : 'none');
      expect(record.skill_observation.treatment_size.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof record.skill_observation.treatment_size.prompt_bytes).toBe('number');
      expect(['observed-present', 'observed-absent']).toContain(record.skill_observation.availability.status);
      expect(['confirmed', 'not-observed']).toContain(record.skill_observation.activation.status);
      expect(record.usage).not.toBeNull();
      expect(['runtime-reported', 'not-recorded']).toContain(record.usage.source);
      for (const dim of ['input', 'cached_input', 'cache_write', 'output']) {
        expect(record.usage[dim] === null || typeof record.usage[dim] === 'number').toBe(true);
      }
      expect(record.usage.reasoning_output).toBeNull();
      expect(record.usage.attributable_to_skill_load.status).toBe('not-recorded');
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
      // A scenario record must never carry a note that contradicts benchmark_eligible:true --
      // asserted by exact string equality, not merely "doesn't contain the old phrase", so a
      // broken replacement can't slip through.
      expect(record.notes).toBe('Scenario run -- benchmark_eligible reflects protocol/integrity completeness, not answer correctness; see grading_checks and success for the actual outcome.');
    }
  }, 60000);

  // Full end-to-end reproduction of a real, confirmed 2026-07-22 live rejection: the current-skill
  // condition's ONLY Skill call used Claude Code's plugin-namespaced identity
  // (kmp-test-runner:kmp-test-runner), which the pre-fix stream-parser.mjs classified as confirmed
  // foreign-skill contamination, rejecting the whole matrix (0/4 records written). This proves the
  // fix through the REAL pipeline (real spawn, real stream-json parsing, real classification, real
  // hard-gate/record promotion) -- not just at the stream-parser unit level
  // (agentic-eval-stream-parser.test.js) or the synthetic hard-gate level
  // (agentic-eval-hard-gates.test.js), both of which also cover this fix directly.
  it('the plugin-namespaced Skill invocation form promotes cleanly end-to-end -- matches the real 2026-07-22 rejection shape, now fixed', async () => {
    const result = await runCli(runArgs(['--seed', '13', '--repeats', '2']), fakeClaudeEnv('run-scenario-success-namespaced-skill'), 60000);
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    const { records } = result.parsed;
    expect(records.length).toBe(4);

    const currentSkillRecords = records.filter((r) => r.condition === 'current-skill');
    const noSkillRecords = records.filter((r) => r.condition === 'no-skill');
    expect(currentSkillRecords.length).toBe(2);
    expect(noSkillRecords.length).toBe(2);

    for (const record of currentSkillRecords) {
      // The namespaced invocation is correctly recognized as the TARGET skill -- not just "didn't
      // trip the foreign-skill check", but genuinely attempted/invoked/confirmed.
      expect(record.skill_invocation_attempted.value).toBe(true);
      expect(record.skill_invoked.value).toBe(true);
      expect(record.foreign_skill_summary).toEqual({ rejected: 0, confirmed: 0, incomplete: 0 });
      expect(record.benchmark_eligible).toBe(true);
    }
    for (const record of noSkillRecords) {
      expect(record.benchmark_eligible).toBe(true);
    }
  }, 60000);

  // Round-7 regression group: decision attribution (allow/deny per Bash attempt) is now available
  // for every scenario, not just 'tests_executed' ones -- see matrix-runner.mjs's own comment on
  // decisionAttributionEnabled. Reproduces the exact 2026-07-23 canary-evidence finding: a denied
  // kmp-test-parallel attempt was previously phantom-counted as a real execution for a
  // no_applicable_tests condition (this suite's own synthetic scenario), since decisionByAttempt
  // was never populated at all for that outcome_kind.
  it('round-7: a denied wildcard-filtered attempt followed by two ALLOWED attempts counts as exactly 2 invocations / 1 retry, never 3/2', async () => {
    // --repeats 2 (even), not 1 -- benchmark_eligible additionally requires balanced realized
    // current-skill-first/no-skill-first start counts (decision 15), structurally impossible for
    // an odd --repeats regardless of anything else in the matrix (see the identical comment on
    // the foreign-skill-rejected test above).
    const result = await runCli(runArgs(['--seed', '1', '--repeats', '2']), fakeClaudeEnv('run-scenario-parallel-denied-then-two-allowed'), 30000);
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    const { records } = result.parsed;
    const currentSkillRecords = records.filter((r) => r.condition === 'current-skill');
    expect(currentSkillRecords.length).toBe(2);
    for (const record of currentSkillRecords) {
      expect(record.test_invocations_total.value).toBe(2);
      expect(record.retries.value).toBe(1);
      expect(record.success.value).toBe(true);
      expect(record.expected_outcome_matched.value).toBe(true);
    }
    for (const record of records) expect(record.benchmark_eligible).toBe(true);
  }, 30000);

  it('round-7: a denied trailing attempt never displaces a genuinely valid earlier attempt as terminal', async () => {
    const result = await runCli(runArgs(['--seed', '1', '--repeats', '2']), fakeClaudeEnv('run-scenario-parallel-valid-then-denied-last'), 30000);
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    const { records } = result.parsed;
    const currentSkillRecords = records.filter((r) => r.condition === 'current-skill');
    expect(currentSkillRecords.length).toBe(2);
    for (const record of currentSkillRecords) {
      // Only the first (allowed) attempt counts -- the denied trailing retry is excluded
      // entirely, never becoming "terminal" just by virtue of running last.
      expect(record.test_invocations_total.value).toBe(1);
      expect(record.success.value).toBe(true);
      expect(record.expected_outcome_matched.value).toBe(true);
    }
    for (const record of records) expect(record.benchmark_eligible).toBe(true);
  }, 30000);

  it('round-7: only-denied kmp-test-parallel attempts do not satisfy bash_tool_use_present', async () => {
    const result = await runCli(runArgs(['--seed', '1', '--repeats', '2']), fakeClaudeEnv('run-scenario-all-parallel-denied'), 30000);
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    const { records } = result.parsed;
    const currentSkillRecords = records.filter((r) => r.condition === 'current-skill');
    expect(currentSkillRecords.length).toBe(2);
    for (const record of currentSkillRecords) {
      expect(record.test_invocations_total.value).toBe(0);
      const btupCheck = record.grading_checks.value.find((c) => c.name === 'bash_tool_use_present');
      expect(btupCheck.passed).toBe(false);
    }
    // Still a legitimate, disclosed negative result -- not a harness-integrity failure.
    for (const record of records) expect(record.benchmark_eligible).toBe(true);
  }, 30000);

  it('round-7: a genuinely missing decision sidecar for an otherwise-clean attempt fails the WHOLE matrix closed -- never silently promoted', async () => {
    const result = await runCli(runArgs(['--seed', '1', '--repeats', '1']), fakeClaudeEnv('run-scenario-parallel-missing-decision'), 30000);
    expect(result.status).toBe(1);
    // The rejection is unchanged (exit 1, zero evidence promoted); WHICH gate catches it moved
    // EARLIER. This fixture emits a real hook_started/hook_response pair but never writes the
    // decision sidecar, so the per-attempt dispatch accounting now sees hook events with no
    // correlated decision -- a cross-channel incoherence -- and fails hookAccountingOk during
    // fail-fast, before grading (and therefore before junitCaptureCompleteOk, which reads
    // record.errors, is ever computed). junitCaptureCompleteOk keeps its own independent reach via
    // the Gradle-evidence half of captureIncomplete, which fail-fast cannot preempt.
    expect(result.stderr).toMatch(/hookAccountingOk:false/);
    expect(result.stderr).toContain('fail-fast stopped the matrix early');
    expect(listEvidenceFiles('scenario')).toEqual([]);
  }, 30000);

  it('a harness-integrity failure (malformed transcript) blocks the WHOLE matrix -- zero records written for ANY cell', async () => {
    const result = await runCli(runArgs(['--seed', '1', '--repeats', '1']), fakeClaudeEnv('malformed'), 30000);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/RUN FAILED/);
    expect(listEvidenceFiles('scenario')).toEqual([]);
  }, 30000);

  // The closest possible reproduction of the real live-scenario-matrix incident that motivated
  // this PR (see fake-claude-run-foreign-skill-rejected/claude's own header comment): a REJECTED
  // ("Unknown skill") foreign Skill attempt, alongside otherwise-correct diagnostic work, must no
  // longer block the whole matrix's promotion.
  // The real 2026-08 Windows canary incident, reproduced end-to-end. Before this fix the matrix
  // aborted at fail-fast on hookAccountingOk:false, discarding three already-spent live sessions
  // and the agent's own correct answer, because 13 Bash tool_uses had only 12 hook pairs. Nothing
  // executed and no enforcement gap occurred -- Claude Code refused the call at its own tool layer
  // -- so the cell must promote and be graded, with the attempt still fully visible.
  it('a Claude-Code pre-dispatch tool block, otherwise clean, promotes and grades the WHOLE matrix -- no respawn, no extra sessions', async () => {
    const result = await runCli(runArgs(['--seed', '5', '--repeats', '2']), fakeClaudeEnv('run-pre-dispatch-blocked'), 30000);
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    const { records } = result.parsed;
    // Exactly 4 cells ran and 4 were promoted: no cell was re-launched, replaced, or re-seeded.
    expect(records.length).toBe(4);
    expect(listEvidenceFiles('scenario').length).toBe(4);
    expect(result.stderr).not.toMatch(/hookAccountingOk:false/);
    expect(result.stderr).not.toMatch(/fail-fast/);

    for (const record of records) {
      expect(record.benchmark_eligible).toBe(true);
      // The agent's own (correct) answer is graded normally -- a pre-dispatch block is not an
      // outcome, and must not leak a negative result.
      expect(record.expected_outcome_matched.value).toBe(true);
      // The attempt stays counted as behaviour: 2 Bash calls (the blocked `sleep 60` + the real
      // kmp-test call) plus 1 Skill attempt.
      expect(record.shell_commands_total.value).toBe(2);
      expect(record.tool_calls_total.value).toBe(3);
      // ...but it is neither a hook allow nor a hook deny: only the ONE dispatched call was hooked.
      expect(record.hook_call_count).toBe(1);
      expect(record.hook_deny_count).toBe(0);
      // ...and it is not a test invocation (the single real kmp-test call is).
      expect(record.test_invocations_total.value).toBe(1);
      expect(record.retries.value).toBe(0);
      expect((record.errors ?? []).some((e) => e.code === 'junit_evidence_capture_incomplete')).toBe(false);
      // The record points at a schema-10 sidecar (this CLI always builds schema:8 records now --
      // Evidence1 success-recovery PR B -- and a schema:8 record always requires exactly a v10
      // sidecar, in either policy mode), matching what was actually written.
      expect(record.accepted_audit.schema).toBe(10);
    }

    // The audit sidecar records the attempt honestly: present, error result, no policy decision
    // (none was ever due), and counted as a pre-dispatch block rather than a missing decision.
    const sidecar = readAcceptedAuditSidecar(records[0].run_id);
    expect(sidecar.schema).toBe(10);
    expect(sidecar.summary.pre_dispatch_blocked_total).toBe(1);
    expect(sidecar.summary.policy_decisions_missing).toBe(0);
    expect(sidecar.summary.shell_commands_total).toBe(2);
    const blocked = sidecar.tool_calls.filter((tc) => tc.dispatch_status === 'pre_dispatch_blocked');
    expect(blocked.length).toBe(1);
    expect(blocked[0].tool_kind).toBe('other-bash');
    expect(blocked[0].policy_decision).toBe('not-applicable');
    expect(blocked[0].result_status).toBe('error');
    // The real kmp-test call is still ordinarily hook-evaluated.
    const hooked = sidecar.tool_calls.filter((tc) => tc.dispatch_status === 'hook_evaluated');
    expect(hooked.length).toBe(1);
    expect(hooked[0].policy_decision).toBe('allow');
  }, 30000);

  it('a REJECTED foreign-skill attempt (is_error:true), otherwise clean, promotes the WHOLE matrix successfully end-to-end', async () => {
    // --repeats 2 (even), not 1 -- benchmark_eligible additionally requires balanced realized
    // current-skill-first/no-skill-first start counts (decision 15), which is structurally
    // impossible for an odd --repeats regardless of anything else in the matrix.
    const result = await runCli(runArgs(['--seed', '5', '--repeats', '2']), fakeClaudeEnv('run-foreign-skill-rejected'), 30000);
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
  it('a CONFIRMED foreign-skill invocation (is_error:false) still blocks the WHOLE matrix -- zero records written for ANY cell', async () => {
    const result = await runCli(runArgs(['--seed', '5', '--repeats', '1']), fakeClaudeEnv('run-foreign-skill-confirmed'), 30000);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/RUN FAILED/);
    expect(result.stderr).toContain('skillSelectionOk:false');
    expect(listEvidenceFiles('scenario')).toEqual([]);
  }, 30000);

  // The closest possible reproduction of the real live-scenario-matrix incident that motivated the
  // ambient-skill-profile fix (see fake-claude-run-shared-bundled-skill-confirmed/claude's own
  // header comment): a CONFIRMED invocation of an ambient, bundled Claude Code skill ("run",
  // present in init.skills[] regardless of --plugin-dir) is genuinely different from the
  // -foreign-skill-confirmed fixture above -- there, "android-gradle-helper" is never advertised
  // anywhere and must still block; here, "run" IS advertised (agreeing across every cell once the
  // target's own identity is stripped) and must be tolerated.
  it('a CONFIRMED ambient (ubiquitous, bundled) ["run"] Skill invocation, confirmed only in no-skill, promotes the WHOLE matrix successfully end-to-end', async () => {
    const result = await runCli(runArgs(['--seed', '5', '--repeats', '2']), fakeClaudeEnv('run-shared-bundled-skill-confirmed'), 30000);
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    const { records } = result.parsed;
    expect(records.length).toBe(4);
    expect(listEvidenceFiles('scenario').length).toBe(4);
    for (const record of records) {
      expect(record.benchmark_eligible).toBe(true);
      expect(record.expected_outcome_matched.value).toBe(true);
      // ambient_skill_profile (schema v4, populated end-to-end by buildRunRecord): exactly one
      // ambient name ("run") on every record, regardless of condition -- proving the field
      // population works through the real subprocess path, not just in unit tests. Never the raw
      // name itself (privacy-safe count + opaque scope id + keyed HMAC fingerprint only).
      expect(record.ambient_skill_profile.count).toBe(1);
      expect(record.ambient_skill_profile.scope_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(record.ambient_skill_profile.fingerprint_hmac).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.keys(record.ambient_skill_profile).sort()).toEqual(['count', 'fingerprint_hmac', 'scope_id']);
      // Privacy-safe: the committed record's ambient_skill_profile is exactly {count, scope_id,
      // fingerprint_hmac} -- the raw skill name ("run") never appears anywhere in it.
      expect(JSON.stringify(record.ambient_skill_profile)).not.toContain('run');
    }
    // Every record in this SAME invocation shares the identical scope_id (one random HMAC key
    // generated once for the whole matrix, correction 2) -- and since they also share the same
    // real ambient name set ("run"), their fingerprints agree too, proving the keyed HMAC is
    // still genuinely comparable WITHIN one invocation, not just uncorrelated across invocations.
    const scopeIds = new Set(records.map((r) => r.ambient_skill_profile.scope_id));
    const fingerprints = new Set(records.map((r) => r.ambient_skill_profile.fingerprint_hmac));
    expect(scopeIds.size).toBe(1);
    expect(fingerprints.size).toBe(1);
    // The no-skill records are the ones that actually confirmed "run" -- foreign_skill_summary
    // (schema v3) still records it as a real, harmless, counted event (categorized counts only,
    // never the raw name).
    const noSkillRecords = records.filter((r) => r.condition === 'no-skill');
    const currentSkillRecords = records.filter((r) => r.condition === 'current-skill');
    expect(noSkillRecords.length).toBe(2);
    expect(currentSkillRecords.length).toBe(2);
    for (const record of noSkillRecords) {
      expect(record.foreign_skill_summary).toEqual({ rejected: 0, confirmed: 1, incomplete: 0 });
    }
    for (const record of currentSkillRecords) {
      expect(record.foreign_skill_summary).toEqual({ rejected: 0, confirmed: 0, incomplete: 0 });
    }
  }, 30000);

  it('leaves no registered git worktree behind after a passing run (removeScenarioWorktree ran)', async () => {
    const result = await runCli(runArgs(['--seed', '5', '--repeats', '1']), fakeClaudeEnv('run-scenario-success'), 30000);
    expect(result.status).toBe(0);
    const worktreeList = gitViaBash(['worktree', 'list'], sourceRepoDir);
    expect(worktreeList.trim().split('\n').length).toBe(1);
  }, 30000);

  it('leaves no registered git worktree behind after a FAILING run either (cleanup runs in finally)', async () => {
    const result = await runCli(runArgs(['--seed', '5', '--repeats', '1']), fakeClaudeEnv('malformed'), 30000);
    expect(result.status).toBe(1);
    const worktreeList = gitViaBash(['worktree', 'list'], sourceRepoDir);
    expect(worktreeList.trim().split('\n').length).toBe(1);
  }, 30000);

  it('leaves no leftover temp directories after a passing run', async () => {
    const result = await runCli(runArgs(['--seed', '5', '--repeats', '1']), fakeClaudeEnv('run-scenario-success'), 30000);
    expect(result.status).toBe(0);
    expect(readdirSync(isolatedTmp)).toEqual([]);
  }, 30000);

  it('leaves no leftover temp directories after a FAILING run either', async () => {
    const result = await runCli(runArgs(['--seed', '5', '--repeats', '1']), fakeClaudeEnv('malformed'), 30000);
    expect(result.status).toBe(1);
    expect(readdirSync(isolatedTmp)).toEqual([]);
  }, 30000);
});

// "bind junit evidence to authoritative attempts" fix -- real end-to-end proof of the per-attempt
// JUnit-evidence-attribution pipeline (matrix-runner.mjs's env threading + scratch-directory
// lifecycle, junit-evidence.mjs's attributeCondition reading real sidecar files, graders.mjs
// consuming the result, buildRunRecord/scenarioCellIntegrityOk surfacing the two new error codes),
// all through a real `cli.mjs run` subprocess. Uses its OWN tests_executed-shaped scenario (the
// shared beforeEach's SCENARIO_ID scenario is no_applicable_tests-shaped, which never enables this
// mechanism at all) and its own fake-claude-run-tests-executed-*/claude fixtures -- see each
// fixture's own header comment for exactly what it simulates and why.
describe('cli.mjs run -- JUnit-evidence-attribution pipeline, real subprocess against fake claude', () => {
  const TESTS_EXECUTED_SCENARIO_ID = 'run-command-integration-tests-executed-scenario';

  function writeTestsExecutedScenario() {
    writeFileSync(path.join(scenariosDir, `${TESTS_EXECUTED_SCENARIO_ID}.json`), JSON.stringify({
      schema: 1,
      id: TESTS_EXECUTED_SCENARIO_ID,
      family: 'test-only',
      project_alias: 'fake-run-integration-project',
      project_url: PROJECT_URL,
      project_commit: pinnedCommit,
      prompt: "Run the tests for this project's only module and tell me what happened.",
      expected_outcome: 'The agent discovers and runs the tests for the :fakemod module and reports the accurate pass/fail count.',
      policy: {
        allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel'],
        allowed_gradle_tasks: [':fakemod:test'],
      },
      expected: {
        module: ':fakemod',
        outcome_kind: 'tests_executed',
        kmp_test: { tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 2 }, exit_code: 0 },
        gradle: { allowed_invocations: [':fakemod:test'], evidence_task: ':fakemod:test', tests: { total: 2, passed: 2, failed: 0 }, exit_code: 0 },
      },
      first_useful_signal_predicate: { description: 'first well-formed evidence confirming :fakemod 2/2' },
      tags: ['train'],
    }, null, 2));
  }

  function runTestsExecutedArgs(extra = []) {
    return ['run', '--scenario', TESTS_EXECUTED_SCENARIO_ID, '--source-repo-dir', sourceRepoDir, '--model', 'claude-sonnet-5', ...extra];
  }

  it('two SEQUENTIAL Gradle attempts (fail then a --rerun-tasks retry that passes) attribute correctly end to end -- the terminal (passing) attempt governs, no harness-integrity error codes fire', async () => {
    writeTestsExecutedScenario();
    // --repeats 2 (even), not 1 -- benchmark_eligible additionally requires balanced realized
    // current-skill-first/no-skill-first start counts (decision 15), structurally impossible for
    // an odd --repeats regardless of anything else in the matrix (see the sibling
    // "REJECTED foreign-skill" test's own identical comment).
    const result = await runCli(runTestsExecutedArgs(['--seed', '7', '--repeats', '2']), fakeClaudeEnv('run-tests-executed-two-gradle'), 30000);
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    const { records } = result.parsed;
    expect(records.length).toBe(4);
    expect(listEvidenceFiles('scenario').length).toBe(4);

    for (const record of records) {
      expect(record.scenario_id).toBe(TESTS_EXECUTED_SCENARIO_ID);
      // The SECOND (terminal, passing) Gradle attempt's own evidence governs -- the first (failed)
      // attempt is correctly superseded, not conflated with it into a false ambiguity.
      expect(record.expected_outcome_matched.value).toBe(true);
      expect(record.success.value).toBe(true);
      // Both real Gradle attempts count -- decision 12's test_invocations_total/retries, computed
      // from the same attempt list grading itself built.
      expect(record.test_invocations_total.value).toBe(2);
      expect(record.retries.value).toBe(1);
      expect(record.benchmark_eligible).toBe(true);
      // None of the three harness-integrity codes fire for this clean, sequential (never
      // same-turn) two-attempt pipeline.
      const errorCodes = (record.errors ?? []).map((e) => e.code);
      expect(errorCodes).not.toContain('ambiguous_junit_evidence');
      expect(errorCodes).not.toContain('junit_evidence_capture_incomplete');
      expect(errorCodes).not.toContain('unreliable_gradle_junit_evidence');
    }
  }, 30000);

  // EXACT REPRODUCTION of the round-5 required proof ("colisión + fallo al escribir tombstone =
  // hard gate rechazado"): see fake-claude-run-tests-executed-collision/claude's own header
  // comment for exactly how it forces both the evidence-record collision AND the tombstone write
  // itself to fail, using only real, sequential sidecar writes (no test-harness pre-seeding, no
  // mocking).
  it('a duplicate sidecar write whose OWN tombstone write also fails still safely rejects the whole matrix -- zero records written for ANY cell', async () => {
    writeTestsExecutedScenario();
    const result = await runCli(runTestsExecutedArgs(['--seed', '7', '--repeats', '1']), fakeClaudeEnv('run-tests-executed-collision'), 30000);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/RUN FAILED/);
    // Same shift as the missing-decision case above: a duplicate write leaves an anomaly tombstone,
    // so the attempt resolves to a null decision while its hook pair is present in the transcript.
    // The per-attempt dispatch accounting catches that incoherence during fail-fast, ahead of
    // junitCaptureCompleteOk. The safety property under test -- whole matrix rejected, zero records
    // written for ANY cell -- is unchanged.
    expect(result.stderr).toContain('hookAccountingOk:false');
    expect(listEvidenceFiles('scenario')).toEqual([]);
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
    // timeout-tolerant structural checks exist to accept. Converted to the canonical
    // condition-observation-v1 shape gradeScenarioCondition now reads exclusively, via the REAL
    // frozen stream-parser.mjs primitives (test files may import stream-parser.mjs directly) --
    // gradeScenarioCondition only ever reads observation.toolAttempts/
    // transcript.effective{StructuralIssues,IncompleteToolResults}/terminal.finalText (confirmed by
    // direct inspection of its current body), so this conversion is deliberately narrow.
    const timedOutEvents = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'kmp-test parallel --module-filter :fakemod --json' } }] } },
    ];
    const timedOutTimeoutCtx = { terminated: true, terminationReason: 'timeout' };
    const timedOutConditionResult = {
      condition: 'no-skill',
      observation: {
        toolAttempts: findAllToolUsesWithResults(timedOutEvents).map((u) => ({
          id: u.id ?? null, kind: 'shell', runtimeName: u.name ?? null, eventIndex: u.index,
          receiptNs: typeof u.receiptNs === 'bigint' ? u.receiptNs : null,
          profileAllowed: true, command: typeof u.input?.command === 'string' ? u.input.command : null,
          skillReference: null, targetsExpectedSkill: null,
          result: { found: u.resultFound, eventIndex: u.resultFound ? u.resultIndex : null, isError: u.resultFound ? u.resultIsError : null, text: null, textStatus: u.resultFound ? 'unsupported' : 'missing' },
          preDispatchBlock: { recognized: false, signature: null },
        })),
        transcript: {
          effectiveStructuralIssues: findTranscriptStructuralIssuesToleratingTimeout(timedOutEvents, timedOutTimeoutCtx),
          effectiveIncompleteToolResults: findIncompleteToolResultsToleratingTimeout(timedOutEvents, timedOutTimeoutCtx),
        },
        terminal: { finalText: findResultEvent(timedOutEvents)?.result ?? null },
      },
      junitAttribution: null,
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

// accepted-run-observability PR: the accepted-run-audit sidecar's real, end-to-end promotion
// behavior -- written alongside the record + raw transcript for every ACCEPTED cell, and for
// NONE of the three tiers when the matrix is rejected. The wiring itself (buildAcceptedRunAuditSidecar
// -> finalizeAcceptedRunAuditSidecar -> record.accepted_audit -> writeRunMatrixRecordEvidence) is
// already exercised implicitly by every "real subprocess" test above continuing to pass; this
// block adds EXPLICIT assertions on the sidecar files themselves -- digest binding, schema
// validity, and cross-record coherence -- rather than relying on that implicit coverage alone.
function listAuditFiles() {
  const dir = path.join(evidenceDirFor('scenario'), 'audit');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json'));
}

describe('accepted-run-audit sidecar -- real end-to-end promotion (accepted-run-observability PR)', () => {
  it('a real fake-claude run promotes a record + a raw transcript + an audit sidecar for EVERY cell, digest-bound and cross-validating cleanly', async () => {
    const result = await runCli(runArgs(['--seed', '13', '--repeats', '2']), fakeClaudeEnv('run-scenario-success'), 60000);
    expect(result.status).toBe(0);
    const { records } = result.parsed;
    expect(records.length).toBe(4);

    const auditFiles = listAuditFiles();
    expect(auditFiles.length).toBe(4);

    for (const record of records) {
      expect(record.accepted_audit).not.toBeNull();
      expect(record.accepted_audit.relative_path).toBe(`audit/${record.run_id}.json`);
      expect(auditFiles).toContain(`${record.run_id}.json`);

      const sidecarPath = path.join(evidenceDirFor('scenario'), 'audit', `${record.run_id}.json`);
      const sidecarText = readFileSync(sidecarPath, 'utf8');
      const actualSha256 = createHash('sha256').update(sidecarText, 'utf8').digest('hex');
      expect(actualSha256).toBe(record.accepted_audit.sha256);

      const sidecar = JSON.parse(sidecarText);
      expect(validateAcceptedRunAuditSidecar(sidecar).errors).toEqual([]);
      expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record)).toEqual([]);
      // Privacy: no raw command/module-filter/path ever appears in the committed sidecar.
      expect(sidecarText).not.toContain('--module-filter');
      expect(sidecarText).not.toContain(':fakemod');
    }
  }, 60000);

  it('a REJECTED matrix (CONFIRMED foreign-skill invocation) promotes NONE of the three tiers -- no record, no raw, no audit sidecar', async () => {
    const result = await runCli(runArgs(['--seed', '5', '--repeats', '1']), fakeClaudeEnv('run-foreign-skill-confirmed'), 30000);
    expect(result.status).toBe(1);
    expect(listEvidenceFiles('scenario')).toEqual([]);
    expect(existsSync(path.join(evidenceDirFor('scenario'), 'raw'))).toBe(false);
    expect(listAuditFiles()).toEqual([]);
  }, 30000);

  it('--dry-run writes no audit directory at all (never spawns Claude, never reaches the matrix)', async () => {
    const result = await runCli(
      ['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/definitely/does/not/exist', '--seed', '7', '--repeats', '2', '--dry-run'],
      fakeClaudeEnv('run-scenario-success'),
    );
    expect(result.status).toBe(0);
    expect(listAuditFiles()).toEqual([]);
  }, 15000);
});

// Post-open-PR review finding: agentic-eval-materialize-fixture-setup.test.js already covers
// applyFixtureSetup/materializeScenarioProject directly, but nothing exercised matrix-runner.mjs's
// OWN threading of scenario.fixture_setup through runSingleCondition -- i.e. the REAL wiring that
// makes a `fixture_setup`-bearing scenario actually mutate the fixture before a real cell/session
// launches. This closes that gap through the same real-subprocess-against-fake-claude boundary
// every other integration test in this file already uses, reusing the shared
// sourceRepoDir/scenariosDir/runCli/fakeClaudeEnv scaffolding from this file's own beforeEach --
// no new production abstraction, no new test-harness machinery.
describe('fixture_setup real matrix/CLI wiring (post-open-PR review finding)', () => {
  it('is applied before each cell launches, resets between cells, and reapplies exactly once per cell -- never accumulates across repetitions/conditions', async () => {
    const scenarioId = 'fixture-setup-wiring-check';
    // marker.txt is the same tracked file this suite's shared beforeEach already commits into
    // sourceRepoDir -- its real blob OID is read back from git itself, never hand-computed/guessed.
    const blobOid = gitViaBash(['rev-parse', 'HEAD:marker.txt'], sourceRepoDir).trim();
    writeFileSync(path.join(scenariosDir, `${scenarioId}.json`), JSON.stringify({
      schema: 1,
      id: scenarioId,
      family: 'test-only',
      project_alias: 'fake-run-integration-project',
      project_url: PROJECT_URL,
      project_commit: pinnedCommit,
      prompt: "Find the module affected by the pending edit, run exactly that module's tests, and tell me what happened.",
      expected_outcome: 'The agent scopes testing to exactly the :fakemod2 module via kmp-test changed and reports 1/1/0.',
      policy: {
        allowed_kmptest_subcommands: ['doctor', 'describe', 'parallel', 'changed'],
        allowed_gradle_tasks: [':fakemod2:test'],
      },
      expected: {
        module: ':fakemod2',
        outcome_kind: 'tests_executed',
        kmp_test: { tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 1 }, exit_code: 0 },
        gradle: { allowed_invocations: [':fakemod2:test'], evidence_task: ':fakemod2:test', tests: { total: 1, passed: 1, failed: 0 }, exit_code: 0 },
        changed: { detected_modules: ['fakemod2'], staged_only: false, base_ref: 'HEAD' },
      },
      fixture_setup: { operation: 'append_comment', relative_path: 'marker.txt', expected_blob_oid: blobOid },
      first_useful_signal_predicate: { description: 'first well-formed changed evidence confirming :fakemod2 single-module detection and 1/1' },
      tags: ['train'],
    }, null, 2));

    // Pure test-fixture instrumentation (see the claude fixture's own header comment) -- never
    // read by production code. One line per cell, appended by the fixture BEFORE it emits any
    // simulated transcript activity, in the order cells actually run. Rides the ALREADY-isolated,
    // ALREADY-allowlisted isolatedTmp directory (this file's own beforeEach points TEMP/TMP/TMPDIR
    // at it) rather than a custom env var, which buildEvalEnv's narrow allowlist would silently
    // drop before it ever reached the fake-claude subprocess.
    const probeLogPath = path.join(isolatedTmp, 'fixture-setup-probe.log');
    const result = await runCli(
      ['run', '--scenario', scenarioId, '--source-repo-dir', sourceRepoDir, '--model', 'claude-sonnet-5', '--seed', '3', '--repeats', '2'],
      fakeClaudeEnv('run-fixture-setup-wiring'),
      60000,
    );
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    const { records } = result.parsed;
    expect(records.length).toBe(4);
    for (const record of records) {
      expect(record.success.value).toBe(true);
      expect(record.expected_outcome_matched.value).toBe(true);
    }

    // Every one of the 4 cells must see EXACTLY one marker occurrence: "0" would mean
    // fixture_setup never ran (or ran too late) before this cell's own launch; "2"+ would mean a
    // PRIOR cell's mutation leaked into this cell instead of starting from a freshly-reset
    // checkout. Reading exactly "1" on all 4, in a fresh materializeScenarioProject worktree
    // every time, is exactly what proves requirements (a) applied-before-launch, (b) later
    // cells start from a restored checkout, and (c) reapplied exactly once, never accumulating.
    const probeLines = readFileSync(probeLogPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(probeLines.length).toBe(4);
    expect(probeLines.every((line) => line === '1')).toBe(true);
  }, 60000);
});

// preserve rejected matrix forensics: fail-fast (Objective C) + rejection forensics (Objectives
// A+B), proven end-to-end through a real `cli.mjs run` subprocess against fake-claude fixtures with
// their own invocation COUNTER (fake-claude-run-failfast-first-cell/-last-cell, see each fixture's
// own header comment) -- unlike the pre-existing fake-claude-malformed/-unexpected-tool fixtures
// (static, no counter), a counting fixture can prove the runner actually STOPPED spawning further
// live sessions, not merely that the one session that ran looks rejected. That distinction is
// exactly what the real 2026-08 canary incident's own postmortem asked for: fail-fast is only a
// real defense if it demonstrably prevents further sessions, not just correctly explains the one
// that already ran.
function rejectedDir() {
  return path.join(runsRoot, 'agentic-eval-rejected');
}

function readCommittedRejectionDiagnostic(rejectionId) {
  return JSON.parse(readFileSync(path.join(rejectedDir(), `${rejectionId}.json`), 'utf8'));
}

function readLocalRejectionDiagnostic(rejectionId) {
  return JSON.parse(readFileSync(path.join(rejectedDir(), 'raw', `${rejectionId}.json`), 'utf8'));
}

function extractRejectionId(stderr) {
  const m = stderr.match(/rejection_id ([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

describe('fail-fast (preserve rejected matrix forensics) -- scenario matrix stops spawning further live sessions', () => {
  it('a cell failing at order_index 0 of a --repeats 2 (4-cell) matrix causes EXACTLY ONE live session -- the other 3 are never spawned -- and writes a partial diagnostic declaring matrix_complete:false/planned:4/executed:1/ambient_profile_matrix_ok:null', async () => {
    const probeLogPath = path.join(isolatedTmp, 'failfast-first-cell-invocations.log');
    // CodeRabbit review finding (PR #417): make the isolation precondition this test's own
    // invocation-count assertion depends on EXPLICIT, not merely implicit -- isolatedTmp is a
    // fresh mkdtempSync() directory from this file's own beforeEach (never shared across tests,
    // never reused), so the probe log genuinely cannot pre-exist here.
    expect(existsSync(probeLogPath)).toBe(false);
    const result = await runCli(runArgs(['--seed', '5', '--repeats', '2']), fakeClaudeEnv('run-failfast-first-cell'), 30000);
    expect(result.status).toBe(1);

    // The discriminating assertion this fixture exists for: a broken fail-fast (e.g. a `break`
    // that only escapes the inner of two nested loops) would still show a rejection, but the probe
    // log would carry MORE than one line -- this is what a static, non-counting fixture cannot
    // prove.
    expect(existsSync(probeLogPath)).toBe(true);
    const invocationLines = readFileSync(probeLogPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(invocationLines.length).toBe(1);

    expect(result.stderr).toMatch(/RUN FAILED/);
    expect(result.stderr).toContain('fail-fast stopped the matrix early at order_index 0');
    expect(result.stderr).toContain('1/4 cells executed, remaining cells never spawned');
    // The exact failure shape the 2026-08 incident itself was -- isolated to the two checks this
    // fixture's injected Read tool_use actually trips, matching fake-claude-unexpected-tool's own
    // already-proven isolation (toolProfileOk from the init event's tools[] declaring Read,
    // noUnexpectedToolsOk from the transcript actually invoking it).
    expect(result.stderr).toContain('toolProfileOk:false');
    expect(result.stderr).toContain('noUnexpectedToolsOk:false');
    expect(result.stderr).toContain('availabilityOk:true');
    expect(listEvidenceFiles('scenario')).toEqual([]);
    expect(result.stderr).toContain('rejected-run diagnostics written');
    expect(result.stderr).toContain('1 raw transcript(s) preserved locally');
    // 3rd tier (stderr, Diseño 4d): the matrix-fail-fast producer -- same reporting pattern as the
    // 2 tiers above, now covering the piece the original macOS incident actually needed
    // (diagnosable stderr from the one live session that ran).
    expect(result.stderr).toContain('1 stderr file(s) preserved locally under');
    expect(result.stderr).toContain(path.join('agentic-eval-rejected', 'raw', 'stderr'));

    const rejectionId = extractRejectionId(result.stderr);
    expect(rejectionId).not.toBeNull();

    const committed = readCommittedRejectionDiagnostic(rejectionId);
    // Evidence1 success-recovery PR B: this CLI now always builds schema:8 run records, and a
    // rejection batch with any such cell always routes to rejection-diagnostics schema 13 instead
    // of 3 -- v13 conserves v3's own policy-required shape (checked here) via conditional
    // validation and adds 2 new common per-cell fields (outcome_assessment/
    // outcome_observability_summary) on top.
    expect(committed.schema).toBe(13);
    expect(committed.run_kind).toBe('scenario');
    expect(committed.matrix_complete).toBe(false);
    expect(committed.planned_cell_count).toBe(4);
    expect(committed.executed_cell_count).toBe(1);
    // Never a faked/simulated consensus over cells that never ran -- scenarioHardGate itself was
    // never even invoked for this rejection (see finalizeAndWriteMatrixRecords's own
    // matrixComplete:false branch).
    expect(committed.ambient_profile_matrix_ok).toBeNull();
    expect(committed.raw_transcripts_persisted).toBe(true);
    expect(committed.cells.length).toBe(1);
    expect(committed.cells[0].order_index).toBe(0);
    expect(committed.cells[0].unexpected_tool_uses_count).toBe(1);
    expect(committed.cells[0].failed_checks).toContain('noUnexpectedToolsOk');
    // Privacy: the committed tier never carries the unexpected tool's own NAME -- only its count.
    expect(JSON.stringify(committed)).not.toContain('"Read"');

    const local = readLocalRejectionDiagnostic(rejectionId);
    expect(local.cells[0].unexpected_tools.length).toBe(1);
    expect(local.cells[0].unexpected_tools[0].name).toBe('Read');
    expect(Number.isInteger(local.cells[0].unexpected_tools[0].event_index)).toBe(true);
    expect(Object.keys(local.cells[0].unexpected_tools[0]).sort()).toEqual(['event_index', 'name']);
    expect(local.raw_transcripts_persisted).toBe(true);
    expect(local.cells[0].transcript_filename).toMatch(/^0-[0-9a-f]{64}\.jsonl$/);

    const transcriptPath = path.join(rejectedDir(), 'raw', 'transcripts', rejectionId, local.cells[0].transcript_filename);
    expect(existsSync(transcriptPath)).toBe(true);
    expect(readFileSync(transcriptPath, 'utf8')).toContain('"name":"Read"');
  }, 30000);

  // Diseño 4d (round-2/round-4 audit findings): a real filesystem failure blocking the stderr
  // transaction specifically must (a) never block the OTHER two independent transactions (raw
  // transcripts, structured diagnostics -- both must still succeed), (b) report only the closed
  // code 'stderr_write_failed', never the real underlying fs error text (which, on this exact
  // setup, genuinely contains an absolute path), and (c) leave rawStdout for the failing cell
  // recoverable regardless. A plain FILE occupies the `raw/stderr` directory slot BEFORE the
  // subprocess ever runs -- any rejectionId the subprocess generates internally (unpredictable
  // from outside) collides the same way, since its parent directory is what is blocked, not one
  // specific rejection_id's own subdirectory.
  it('a real stderr-tier filesystem failure blocks ONLY that tier -- diagnostics + raw transcripts still succeed, and the error text never leaks the real fs failure', async () => {
    const blockedDir = path.join(runsRoot, 'agentic-eval-rejected', 'raw');
    mkdirSync(blockedDir, { recursive: true });
    writeFileSync(path.join(blockedDir, 'stderr'), 'blocking-file'); // occupies the directory slot as a plain file
    const result = await runCli(runArgs(['--seed', '5', '--repeats', '2']), fakeClaudeEnv('run-failfast-first-cell'), 30000);
    expect(result.status).toBe(1);

    // The other 2 transactions succeed exactly as they do without the collision (same test as the
    // sibling above, minus the stderr-specific line).
    expect(result.stderr).toContain('rejected-run diagnostics written');
    expect(result.stderr).toContain('1 raw transcript(s) preserved locally');

    // The stderr tier reports failure via its own closed code, never a raw fs error.
    expect(result.stderr).toContain('stderr was NOT preserved: stderr_write_failed');
    expect(result.stderr).not.toContain('stderr file(s) preserved locally');
    expect(result.stderr).not.toContain('ENOTDIR');
    expect(result.stderr).not.toContain('not a directory');
    expect(result.stderr).not.toContain('blocking-file');
    expect(result.stderr).not.toContain(runsRoot); // the real absolute path never leaks either

    const rejectionId = extractRejectionId(result.stderr);
    expect(rejectionId).not.toBeNull();
    const committed = readCommittedRejectionDiagnostic(rejectionId);
    expect(committed.raw_transcripts_persisted).toBe(true);
  }, 30000);

  // Diseño 5 Caso B (macOS auth-preflight PR): the real 2026-08 canary incident's OWN exact
  // failure shape, reproduced end-to-end through a real `node cli.mjs run` subprocess -- auth
  // passes, the first cell's live session produces a well-formed but pre-inference-failed
  // transcript (is_error:true, num_turns:1, usage all zero, zero tool_use), fail-fast stops the
  // matrix after exactly that one session, and the cell's stderr survives independently in the
  // rejection tier (the diagnosability gap the incident's own postmortem asked for). This is the
  // mandatory (not optional, per the plan's own round-3 ruling) subprocess-level closure of
  // Diseño 4d's wiring for the matrix-fail-fast producer specifically, using the NEW fixture --
  // agentic-eval-cli.test.js's own 4-producer suite already covers the other 3 producers
  // in-process with synthetic records, and this file's own sibling test above already covers a
  // stderr WRITE FAILURE for the (pre-existing) unexpected-tool fail-fast shape; this test is the
  // one place that proves the auth-preflight incident's own signature, specifically, survives all
  // the way through a real CLI invocation.
  it('Caso B: exactly ONE live session runs, matrixComplete:false, noPreInferenceFailureOk is the failing check, and the cell\'s stderr survives independently in the rejection tier', async () => {
    const probeLogPath = path.join(isolatedTmp, 'auth-ok-pre-inference-failure-invocations.log');
    expect(existsSync(probeLogPath)).toBe(false);
    const result = await runCli(runArgs(['--seed', '5', '--repeats', '2']), fakeClaudeEnv('auth-ok-pre-inference-failure'), 30000);
    expect(result.status).toBe(1);

    expect(existsSync(probeLogPath)).toBe(true);
    const invocationLines = readFileSync(probeLogPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(invocationLines.length).toBe(1);

    expect(result.stderr).toMatch(/RUN FAILED/);
    expect(result.stderr).toContain('fail-fast stopped the matrix early at order_index 0');
    expect(result.stderr).toContain('1/4 cells executed, remaining cells never spawned');
    expect(result.stderr).toContain('noPreInferenceFailureOk:false');
    expect(listEvidenceFiles('scenario')).toEqual([]);
    expect(result.stderr).toContain('rejected-run diagnostics written');
    expect(result.stderr).toContain('1 raw transcript(s) preserved locally');
    expect(result.stderr).toContain('1 stderr file(s) preserved locally under');

    const rejectionId = extractRejectionId(result.stderr);
    expect(rejectionId).not.toBeNull();

    const committed = readCommittedRejectionDiagnostic(rejectionId);
    expect(committed.matrix_complete).toBe(false);
    expect(committed.planned_cell_count).toBe(4);
    expect(committed.executed_cell_count).toBe(1);
    expect(committed.raw_transcripts_persisted).toBe(true);
    expect(committed.cells.length).toBe(1);
    expect(committed.cells[0].order_index).toBe(0);
    expect(committed.cells[0].failed_checks).toEqual(['noPreInferenceFailureOk']);
    // Never an English-language-text detection -- the committed diagnostic's own failed_checks
    // entry is the structural signal, with zero unexpected tool uses (this is NOT a tool-profile
    // rejection).
    expect(committed.cells[0].unexpected_tool_uses_count).toBe(0);

    const local = readLocalRejectionDiagnostic(rejectionId);
    expect(local.raw_transcripts_persisted).toBe(true);
    expect(local.cells[0].transcript_filename).toMatch(/^0-[0-9a-f]{64}\.jsonl$/);
    const transcriptPath = path.join(rejectedDir(), 'raw', 'transcripts', rejectionId, local.cells[0].transcript_filename);
    expect(existsSync(transcriptPath)).toBe(true);
    expect(readFileSync(transcriptPath, 'utf8')).toContain('"type":"result"');

    // The stderr tier -- independently recoverable, non-empty, and never embedded in either
    // committable diagnostic tier.
    const stderrDir = path.join(rejectedDir(), 'raw', 'stderr', rejectionId);
    const stderrFiles = readdirSync(stderrDir);
    expect(stderrFiles.length).toBe(1);
    expect(stderrFiles[0]).toMatch(/^0-[0-9a-f]{64}\.stderr\.txt$/);
    const stderrText = readFileSync(path.join(stderrDir, stderrFiles[0]), 'utf8');
    expect(stderrText.length).toBeGreaterThan(0);
    expect(stderrText).toContain('simulated pre-inference failure');
    expect(JSON.stringify(committed)).not.toContain('simulated pre-inference failure');
    expect(JSON.stringify(local)).not.toContain('simulated pre-inference failure');

    // No record was ever promoted as benchmark_eligible:true (or promoted at all) -- fail-fast
    // rejection, not a graded negative result.
    expect(listEvidenceFiles('scenario')).toEqual([]);
  }, 30000);

  // "No false savings" (correction 7): the real 2026-08 canary incident's own failing cell was the
  // LAST of 4 planned cells -- fail-fast would NOT have saved any live session in that specific
  // shape, since every cell had already been spawned by the time the last one failed. This fixture
  // reproduces exactly that shape at the smallest scale (--repeats 1, 2 planned cells, the SECOND
  // one fails): the loop's own break fires only once there is nothing left to run anyway, so
  // executedCellCount === plannedCellCount, matrixComplete is `true`, and the ORDINARY
  // scenarioHardGate runs for real (never the fail-fast-only partial branch) -- ambient_profile_
  // matrix_ok must be a genuine boolean here, not null, and the diagnostic must never claim savings
  // that didn't happen.
  it('a cell failing at the LAST order_index of a --repeats 1 (2-cell) matrix still runs BOTH sessions -- matrix_complete:true, no savings claimed, and the ordinary scenarioHardGate (not the fail-fast branch) produced the rejection', async () => {
    const probeLogPath = path.join(isolatedTmp, 'failfast-last-cell-invocations.log');
    // CodeRabbit review finding (PR #417): see the sibling first-cell test's identical comment.
    expect(existsSync(probeLogPath)).toBe(false);
    const result = await runCli(runArgs(['--seed', '5', '--repeats', '1']), fakeClaudeEnv('run-failfast-last-cell'), 30000);
    expect(result.status).toBe(1);

    expect(existsSync(probeLogPath)).toBe(true);
    const invocationLines = readFileSync(probeLogPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(invocationLines.length).toBe(2);

    expect(result.stderr).toMatch(/RUN FAILED/);
    // The fail-fast-specific early stderr line is printed ONLY when matrixComplete is false --
    // never here, since the matrix legitimately ran to its own planned end.
    expect(result.stderr).not.toContain('fail-fast stopped the matrix early');
    expect(result.stderr).toContain('noUnexpectedToolsOk:false');
    expect(listEvidenceFiles('scenario')).toEqual([]);
    expect(result.stderr).toContain('rejected-run diagnostics written');
    // BOTH executed cells' transcripts are preserved -- not just the failing one -- since Transaction
    // 1 persists every EXECUTED cell of the batch, and here that batch is the whole (complete) matrix.
    expect(result.stderr).toContain('2 raw transcript(s) preserved locally');
    // 3rd tier (stderr, Diseño 4d): the matrix-complete producer -- both executed cells' stderr
    // preserved, matching the raw-transcript count above.
    expect(result.stderr).toContain('2 stderr file(s) preserved locally under');

    const rejectionId = extractRejectionId(result.stderr);
    expect(rejectionId).not.toBeNull();

    const committed = readCommittedRejectionDiagnostic(rejectionId);
    expect(committed.matrix_complete).toBe(true);
    expect(committed.planned_cell_count).toBe(2);
    expect(committed.executed_cell_count).toBe(2);
    // The real, computed consensus -- the gate genuinely ran, because the matrix genuinely
    // completed (see this test's own header comment).
    expect(typeof committed.ambient_profile_matrix_ok).toBe('boolean');
    expect(committed.raw_transcripts_persisted).toBe(true);
    expect(committed.cells.length).toBe(2);
    const failingCell = committed.cells.find((c) => c.unexpected_tool_uses_count > 0);
    expect(failingCell).toBeDefined();
    expect(failingCell.order_index).toBe(1);
    expect(failingCell.failed_checks).toContain('noUnexpectedToolsOk');
    const cleanCell = committed.cells.find((c) => c.run_id !== failingCell.run_id);
    expect(cleanCell.unexpected_tool_uses_count).toBe(0);

    const local = readLocalRejectionDiagnostic(rejectionId);
    const localFailingCell = local.cells.find((c) => c.run_id === failingCell.run_id);
    expect(localFailingCell.unexpected_tools.length).toBe(1);
    expect(localFailingCell.unexpected_tools[0].name).toBe('Read');
    expect(Number.isInteger(localFailingCell.unexpected_tools[0].event_index)).toBe(true);
  }, 30000);

  // G4 (accepted-path byte/shape contract preserved): the accept path was never touched by this
  // fix -- only the two rejection branches inside finalizeAndWriteMatrixRecords gained forensics.
  // Mirrors agentic-eval-rejection-diagnostics.test.js's own identical calibrate-only assertion
  // ("a real calibrate SUCCESS writes nothing under agentic-eval-rejected/ at all") for the `run`
  // command specifically -- no equivalent existed for the scenario-matrix path before this fix.
  it('a real, ACCEPTED scenario matrix run creates no agentic-eval-rejected/ directory at all', async () => {
    const result = await runCli(runArgs(['--seed', '5', '--repeats', '1']), fakeClaudeEnv('run-scenario-success'), 30000);
    expect(result.status).toBe(0);
    expect(existsSync(rejectedDir())).toBe(false);
  }, 30000);
});

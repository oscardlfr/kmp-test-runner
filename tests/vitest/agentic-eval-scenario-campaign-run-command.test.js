// tests/vitest/agentic-eval-scenario-campaign-run-command.test.js
// Real end-to-end integration tests for cli.mjs's `run --campaign-design claude-2x2-williams-v1`
// mode (agentic-eval-multi-profile-campaigns-v1) -- run as REAL `node cli.mjs run ...` subprocesses
// against fake `claude` fixtures under tests/fixtures/fake-claude-*/ (never the real claude CLI).
// Mirrors agentic-eval-unrestricted-profile-e2e.test.js's own structure/helpers (this file is a new
// sibling, not folded into agentic-eval-run-command.test.js, matching that same precedent: a
// substantial, distinct feature scope gets its own dedicated E2E file).
//
// This is an OFFLINE harness PR: zero live Claude Code sessions, zero raw transcript reads/writes
// outside fake fixtures, zero tools/runs/** evidence additions from this file's own test runs (all
// evidence is written under an isolated per-test KMP_EVAL_RUNS_ROOT, never the real committed
// corpus).
//
// Coverage map (docs/audits/agentic-eval-v1-evidence-1-prereq-four-condition-planner-runbook.md,
// Stage 3 + Stage 5):
//  1. --campaign-design --dry-run: 16 planned cells, exact pre-registered order, per-cell shape.
//  2. --campaign-design argument validation: mutual exclusion with --execution-profile/--repeats,
//     unknown design id, missing/invalid isolation attestation.
//  3. Legacy run --execution-profile bookend: byte-for-byte unaffected by this PR.
//  4. Fake-runtime campaign execution: happy path (16/16 accepted), missing-result fail-fast,
//     attestation failure before any session, legacy two-condition run still works.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';
import { validateAcceptedRunAuditSidecar, crossValidateAcceptedRunAuditAgainstRecord } from '../../tools/agentic-eval/accepted-run-audit.mjs';
import { LATEST_RUN_SCHEMA } from '../../tools/agentic-eval/schemas.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'tools', 'agentic-eval', 'cli.mjs');
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

const DESIGN_ID = 'claude-2x2-williams-v1';
const STRICT = 'strict-policy-v1';
const UNRESTRICTED = 'sandboxed-unrestricted-v1';
const EXPECTED_LABEL_ORDER = ['A', 'B', 'D', 'C', 'B', 'C', 'A', 'D', 'C', 'D', 'B', 'A', 'D', 'A', 'C', 'B'];
const CELL_DEFINITIONS = {
  A: { execution_profile_id: STRICT, condition: 'no-skill' },
  B: { execution_profile_id: STRICT, condition: 'current-skill' },
  C: { execution_profile_id: UNRESTRICTED, condition: 'no-skill' },
  D: { execution_profile_id: UNRESTRICTED, condition: 'current-skill' },
};

let runsRoot;
let isolatedTmp;
let sourceRepoDir;
let scenariosDir;
let pinnedCommit;

const PROJECT_URL = 'https://github.com/example/fake-campaign-e2e-project.git';
const SCENARIO_ID = 'campaign-e2e-test-only-scenario';

function gitViaBash(argv, cwd) {
  const shQuote = (arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`;
  const cmd = argv.map(shQuote).join(' ');
  const r = spawnSync(resolveBash(), ['-c', `git ${cmd}`], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

beforeEach(() => {
  runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aecc-runs-root-'));
  isolatedTmp = mkdtempSync(path.join(os.tmpdir(), 'aecc-isolated-tmp-'));

  sourceRepoDir = mkdtempSync(path.join(os.tmpdir(), 'aecc-source-'));
  gitViaBash(['init', '-q'], sourceRepoDir);
  gitViaBash(['config', 'user.email', 'test@example.com'], sourceRepoDir);
  gitViaBash(['config', 'user.name', 'Test'], sourceRepoDir);
  writeFileSync(path.join(sourceRepoDir, 'marker.txt'), 'pristine\n');
  gitViaBash(['add', '-A'], sourceRepoDir);
  gitViaBash(['commit', '-q', '-m', 'initial'], sourceRepoDir);
  pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
  gitViaBash(['remote', 'add', 'origin', PROJECT_URL], sourceRepoDir);

  scenariosDir = mkdtempSync(path.join(os.tmpdir(), 'aecc-scenarios-'));
  writeFileSync(path.join(scenariosDir, `${SCENARIO_ID}.json`), JSON.stringify({
    schema: 1,
    id: SCENARIO_ID,
    family: 'test-only',
    project_alias: 'fake-campaign-e2e-project',
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

/** Async spawn, never spawnSync -- see agentic-eval-run-command.test.js's own header comment for
 * the full Windows-CI vitest-RPC-heartbeat-timeout rationale this mirrors exactly. */
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

function readAcceptedAuditSidecar(runId) {
  return JSON.parse(readFileSync(path.join(evidenceDirFor('scenario'), 'audit', `${runId}.json`), 'utf8'));
}

function resolvePlatformForAttestation() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return 'not-recorded';
}

let cachedHarnessSha = null;
function resolveHarnessSha() {
  if (cachedHarnessSha != null) return cachedHarnessSha;
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git rev-parse HEAD failed in ${REPO_ROOT}: ${r.stderr}`);
  cachedHarnessSha = r.stdout.trim();
  return cachedHarnessSha;
}

function isoNoMillis(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

let attestationCounter = 0;
/** Same closed shape as agentic-eval-unrestricted-profile-e2e.test.js's own writeValidAttestation
 * -- ONE attestation covers every unrestricted cell in a campaign (there is only ever one
 * --isolation-attestation-file flag per invocation; the campaign's strict cells never consult it
 * at all). */
function writeValidAttestation(overrides = {}) {
  attestationCounter += 1;
  const now = new Date();
  const created = new Date(now.getTime() - 60 * 1000);
  const expires = new Date(now.getTime() + 60 * 60 * 1000);
  const attestation = {
    schema: 1,
    profile_id: UNRESTRICTED,
    runtime_id: 'claude-code',
    campaign_id: 'agentic-eval-multi-profile-campaign-e2e-test',
    platform: resolvePlatformForAttestation(),
    boundary_kind: 'disposable-vm',
    network_mode: 'restricted',
    workspace_scope: 'campaign-only',
    runtime_credential_scope: 'runtime-only',
    normal_maintainer_home_mounted: false,
    ambient_secrets_present: false,
    disposable_home: true,
    rollback_or_destroy_required: true,
    harness_sha: resolveHarnessSha(),
    created_at: isoNoMillis(created),
    expires_at: isoNoMillis(expires),
    ...overrides,
  };
  const filePath = path.join(isolatedTmp, `attestation-${attestationCounter}.json`);
  writeFileSync(filePath, JSON.stringify(attestation, null, 2));
  return filePath;
}

function runArgs(extra = []) {
  return ['run', '--scenario', SCENARIO_ID, '--source-repo-dir', sourceRepoDir, '--model', 'claude-sonnet-5', ...extra];
}

const CAMPAIGN_FLAGS = (attestationPath) => ['--campaign-design', DESIGN_ID, '--isolation-attestation-file', attestationPath];

describe('1. cli.mjs run --campaign-design -- dry-run plan preview', () => {
  it('prints 16 planned cells and spawns nothing, even with a nonexistent --source-repo-dir', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(
      ['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/definitely/does/not/exist', '--seed', '7', '--max-budget-usd', '1.50', ...CAMPAIGN_FLAGS(attestationPath), '--dry-run'],
      fakeClaudeEnv('run-scenario-success'),
    );
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    expect(result.parsed.dry_run).toBe(true);
    expect(result.parsed.scenario_id).toBe(SCENARIO_ID);
    expect(result.parsed.campaign_design_id).toBe(DESIGN_ID);
    expect(result.parsed.repeats).toBe(4);
    expect(result.parsed.max_budget_usd).toBe(1.5);
    expect(result.parsed.planned_sessions).toBe(16);
    expect(Array.isArray(result.parsed.plan)).toBe(true);
    expect(result.parsed.plan.length).toBe(16);
  });

  it('produces the exact pre-registered A/B/D/C, B/C/A/D, C/D/B/A, D/A/C/B order, verifiable by label, profile, condition, order_index, and repetition_index', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(
      ['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/definitely/does/not/exist', '--seed', '7', ...CAMPAIGN_FLAGS(attestationPath), '--dry-run'],
      fakeClaudeEnv('run-scenario-success'),
    );
    expect(result.status).toBe(0);
    const sorted = [...result.parsed.plan].sort((a, b) => a.order_index - b.order_index);
    expect(sorted.map((c) => c.campaign_cell_label)).toEqual(EXPECTED_LABEL_ORDER);
    expect(sorted.map((c) => c.execution_profile_id)).toEqual(EXPECTED_LABEL_ORDER.map((l) => CELL_DEFINITIONS[l].execution_profile_id));
    expect(sorted.map((c) => c.condition)).toEqual(EXPECTED_LABEL_ORDER.map((l) => CELL_DEFINITIONS[l].condition));
    expect(sorted.map((c) => c.order_index)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(sorted.map((c) => c.repetition_index)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
  });

  it('is deterministic across repeated invocations -- never shuffled, never dependent on --seed', async () => {
    const attestationPath = writeValidAttestation();
    const a = await runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/nonexistent', '--seed', '99', ...CAMPAIGN_FLAGS(attestationPath), '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    const b = await runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/nonexistent', '--seed', '1', ...CAMPAIGN_FLAGS(attestationPath), '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(a.parsed.plan).toEqual(b.parsed.plan);
  });

  it('never spawns a live session (no evidence, no journal, no rejected dirs created)', async () => {
    const attestationPath = writeValidAttestation();
    await runCli(['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/definitely/does/not/exist', '--seed', '1', ...CAMPAIGN_FLAGS(attestationPath), '--dry-run'], fakeClaudeEnv('run-scenario-success'));
    expect(listEvidenceFiles('scenario').length).toBe(0);
    expect(existsSync(path.join(runsRoot, 'agentic-eval-rejected'))).toBe(false);
  });
});

describe('2. cli.mjs run --campaign-design -- argument validation (fail closed before any session)', () => {
  // Every assertion in this block also proves stderr is NOT the generic "Unknown flag for 'run':
  // --campaign-design" usage-banner dump (parseArgs/validateSubcommandArgs's own rejection for a
  // flag SUBCOMMAND_SHAPES doesn't yet recognize) -- that banner text itself happens to contain
  // "--execution-profile"/"--repeats"/"--seed" as substrings (they're part of run's own usage
  // synopsis), which would otherwise let a loose /--execution-profile/-style match pass BEFORE
  // --campaign-design is wired up at all, for entirely the wrong reason. This is the genuine RED
  // proof for every test below: today (pre-Stage-4) every one of them fails this exact check.
  function expectRealCampaignRejection(result) {
    expect(result.status).toBe(1);
    expect(result.parsed).toBeNull();
    expect(result.stderr).not.toMatch(/Unknown flag/);
  }

  it('rejects --campaign-design combined with --execution-profile, before any plan is printed', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(runArgs(['--seed', '1', '--campaign-design', DESIGN_ID, '--execution-profile', STRICT, '--isolation-attestation-file', attestationPath, '--dry-run']), fakeClaudeEnv('run-scenario-success'));
    expectRealCampaignRejection(result);
    expect(result.stderr).toMatch(/cannot be combined/i);
    expect(result.stderr).toMatch(/--campaign-design/);
    expect(result.stderr).toMatch(/--execution-profile/);
  });

  it('rejects --campaign-design combined with --repeats 3 (wrong count), before any plan is printed', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(runArgs(['--seed', '1', '--campaign-design', DESIGN_ID, '--repeats', '3', '--isolation-attestation-file', attestationPath, '--dry-run']), fakeClaudeEnv('run-scenario-success'));
    expectRealCampaignRejection(result);
    expect(result.stderr).toMatch(/cannot be combined/i);
    expect(result.stderr).toMatch(/--repeats/);
  });

  it('rejects --campaign-design combined with --repeats 4 too -- the design fixes its own repeat count, never overridable even with the "right" value', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(runArgs(['--seed', '1', '--campaign-design', DESIGN_ID, '--repeats', '4', '--isolation-attestation-file', attestationPath, '--dry-run']), fakeClaudeEnv('run-scenario-success'));
    expectRealCampaignRejection(result);
    expect(result.stderr).toMatch(/cannot be combined/i);
    expect(result.stderr).toMatch(/--repeats/);
  });

  it('rejects an unknown --campaign-design id, before any plan is printed', async () => {
    const result = await runCli(runArgs(['--seed', '1', '--campaign-design', 'not-a-real-design-v99', '--dry-run']), fakeClaudeEnv('run-scenario-success'));
    expectRealCampaignRejection(result);
    expect(result.stderr).toMatch(/campaign design/i);
  });

  it('a missing --isolation-attestation-file fails closed, even under --dry-run, before any plan is printed (the design always includes sandboxed-unrestricted-v1 cells)', async () => {
    const result = await runCli(runArgs(['--seed', '1', '--campaign-design', DESIGN_ID, '--dry-run']), fakeClaudeEnv('run-scenario-success'));
    expectRealCampaignRejection(result);
    expect(result.stderr).toMatch(/--isolation-attestation-file <path> is required/);
  });

  it('an invalid isolation attestation (wrong profile_id) fails closed the same way', async () => {
    const badAttestation = path.join(isolatedTmp, 'bad-attestation.json');
    writeFileSync(badAttestation, JSON.stringify({ schema: 1, profile_id: 'not-a-real-profile' }));
    const result = await runCli(runArgs(['--seed', '1', '--campaign-design', DESIGN_ID, '--isolation-attestation-file', badAttestation, '--dry-run']), fakeClaudeEnv('run-scenario-success'));
    expectRealCampaignRejection(result);
    expect(result.stderr).toMatch(/isolation attestation invalid/);
  });

  it('a valid isolation attestation allows --dry-run through to a printed plan', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(runArgs(['--seed', '1', '--campaign-design', DESIGN_ID, '--isolation-attestation-file', attestationPath, '--dry-run']), fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/Unknown flag/);
    expect(result.parsed.dry_run).toBe(true);
  });

  it('requires --seed explicitly, exactly like the legacy path', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(runArgs(['--campaign-design', DESIGN_ID, '--isolation-attestation-file', attestationPath, '--dry-run']), fakeClaudeEnv('run-scenario-success'));
    expectRealCampaignRejection(result);
    expect(result.stderr).toMatch(/--seed/);
  });
});

describe('3. cli.mjs run --execution-profile -- legacy bookend (byte-for-byte unaffected by --campaign-design)', () => {
  it('run --execution-profile strict-policy-v1 --dry-run --repeats 4 still plans 8 sessions, no campaign fields anywhere', async () => {
    const result = await runCli(runArgs(['--seed', '1', '--execution-profile', STRICT, '--repeats', '4', '--dry-run']), fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(0);
    expect(result.parsed.dry_run).toBe(true);
    expect(result.parsed.total_live_sessions).toBe(8);
    expect(result.parsed.plan.length).toBe(8);
    expect(result.parsed.campaign_design_id).toBeUndefined();
    expect(result.parsed.planned_sessions).toBeUndefined();
    for (const cell of result.parsed.plan) {
      expect(cell.campaign_cell_label).toBeUndefined();
      expect(cell.execution_profile_id).toBeUndefined();
    }
  });

  it('bare run --dry-run (no campaign, no execution-profile) is completely unaffected', async () => {
    const result = await runCli(runArgs(['--seed', '1', '--repeats', '2', '--dry-run']), fakeClaudeEnv('run-scenario-success'));
    expect(result.status).toBe(0);
    expect(result.parsed.plan.length).toBe(4);
    expect(result.parsed.campaign_design_id).toBeUndefined();
  });

  // Full REAL (non-dry-run) legacy execution is already exhaustively covered by
  // agentic-eval-run-command.test.js (309 assertions across schema/counterbalancing/dispatch-
  // accounting/cleanup, all against fake-claude-run-scenario-success) and
  // agentic-eval-unrestricted-profile-e2e.test.js (the --execution-profile sandboxed-unrestricted-v1
  // analogue) -- both already re-verified green against this PR's own diff. This one lightweight
  // test exists only to colocate a self-contained proof that runScenarioCampaign's own additions to
  // matrix-runner.mjs/cli.mjs (the new completenessCheckFn parameter, the new cmdRunCampaign
  // dispatch) left the LEGACY --execution-profile real-run path completely unaffected.
  it('run --execution-profile strict-policy-v1 (real, non-dry-run) still promotes records via the legacy path, unaffected by runScenarioCampaign existing', async () => {
    const result = await runCli(runArgs(['--seed', '5', '--execution-profile', STRICT, '--repeats', '1']), fakeClaudeEnv('run-scenario-success'), 60000);
    expect(result.status).toBe(0);
    expect(result.parsed.records.length).toBe(2);
    expect(listEvidenceFiles('scenario').length).toBe(2);
  }, 60000);
});

describe('4. cli.mjs run --campaign-design -- fake-runtime campaign execution (real subprocess against fake claude)', () => {
  it('happy path: all 16 cells accepted, each record matches its own pre-registered plan cell exactly, no cross-contamination between profiles', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(
      runArgs(['--seed', '11', '--max-budget-usd', '1.25', ...CAMPAIGN_FLAGS(attestationPath)]),
      { ...fakeClaudeEnv('campaign-success'), KMP_FAKE_EXPECT_MAX_BUDGET_USD: '1.25' },
      120000,
    );
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    const { records } = result.parsed;
    expect(records.length).toBe(16);
    expect(listEvidenceFiles('scenario').length).toBe(16);

    // Identity proof (findCampaignCompletenessGap's own invariant), re-checked against the REAL
    // written records, not just the plan preview: order_index 0..15 contiguous, each matching the
    // pre-registered plan's own repetition_index/condition/execution_profile.id exactly.
    const sorted = [...records].sort((a, b) => a.order_index - b.order_index);
    expect(sorted.map((r) => r.order_index)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(sorted.map((r) => r.repetition_index)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
    expect(sorted.map((r) => r.condition)).toEqual(EXPECTED_LABEL_ORDER.map((l) => CELL_DEFINITIONS[l].condition));
    expect(sorted.map((r) => r.execution_profile.id)).toEqual(EXPECTED_LABEL_ORDER.map((l) => CELL_DEFINITIONS[l].execution_profile_id));

    for (const record of records) {
      expect(record.schema).toBe(LATEST_RUN_SCHEMA);
      expect(record.run_kind).toBe('scenario');
      expect(record.scenario_id).toBe(SCENARIO_ID);
      expect(record.seed).toBe(11);

      // current-skill cells invoke the skill source, no-skill cells never do -- proven per record,
      // never assumed from the plan alone.
      expect(record.skill_observation.delivery_mode).toBe(record.condition === 'current-skill' ? 'runtime-extension' : 'none');

      // Strict/unrestricted cells are never cross-contaminated: a strict record's own
      // execution_profile group + policy accounting must never leak unrestricted values, and vice
      // versa -- checked directly against the resolved profile registry shape, not inferred.
      if (record.execution_profile.id === STRICT) {
        expect(record.execution_profile.isolation_kind).toBe('runtime-policy-hooks');
        expect(record.execution_profile.network_mode).toBe('runtime-default');
        expect(record.execution_profile.policy_mode).toBe('required');
        expect(record.execution_profile.isolation_attestation_required).toBe(false);
        expect(record.execution_profile.isolation_attestation_sha256).toBeNull();
        // A strict cell's own PreToolUse:Bash hook genuinely fired once (allow) -- never absent,
        // never an unrestricted cell's no-policy shape leaking in.
        expect(record.hook_call_count).toBe(1);
        expect(record.hook_deny_count).toBe(0);
        expect(record.policy_sha256).toMatch(/^[0-9a-f]{64}$/);
      } else {
        expect(record.execution_profile.id).toBe(UNRESTRICTED);
        expect(record.execution_profile.isolation_kind).toBe('external-sandbox');
        expect(record.execution_profile.network_mode).toBe('restricted');
        expect(record.execution_profile.policy_mode).toBe('not_applicable');
        expect(record.execution_profile.isolation_attestation_required).toBe(true);
        expect(record.execution_profile.isolation_attestation_sha256).toMatch(/^[0-9a-f]{64}$/);
        // An unrestricted cell must never observe a strict cell's policy-hook accounting -- no
        // PreToolUse:Bash hook exists under policy_mode:"not_applicable" at all.
        expect(record.hook_call_count).toBeNull();
        expect(record.hook_deny_count).toBeNull();
        expect(record.policy_sha256).toBeNull();
      }

      expect(record.grading_checks.value).not.toBeNull();
      expect(record.expected_outcome_matched.value).toBe(true);
      expect(record.success.value).toBe(true);
    }

    // Every accepted-run-audit sidecar cross-validates against its own promoted record -- proven
    // for every one of the 16 cells, not sampled.
    for (const record of records) {
      const sidecar = readAcceptedAuditSidecar(record.run_id);
      expect(validateAcceptedRunAuditSidecar(sidecar).errors).toEqual([]);
      expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record)).toEqual([]);
    }
  }, 120000);

  // KNOWN LIMITATION (documented and accepted for this PR -- see BACKLOG.md "mixed-profile
  // campaign rejection diagnostics schema" and this PR's own body): buildRejectionDiagnostics
  // (rejection-diagnostics.mjs) asserts every record in one batch agrees on policy_sha256 and
  // execution_profile.policy_mode/id -- true by construction for the legacy single-profile matrix
  // (one execution_profile per whole `run` invocation), never true for a campaign whose fail-fast
  // stop happens after cells from BOTH profiles already ran (exactly this test's own shape: cells 0
  // and 1 are strict-policy-v1, cell 2 is sandboxed-unrestricted-v1). Fixing this properly needs a
  // new rejection-diagnostics schema variant carrying PER-RECORD execution_profile/policy_sha256
  // instead of today's batch-wide fields -- a real, scoped schema change this PR deliberately does
  // NOT make (scope discipline: this PR is offline campaign planning/execution, not a
  // rejection-diagnostics schema PR). writeRejectionForensics' own try/catch around
  // buildRejectionDiagnostics already converts that throw into `diagnosticsWriteError` cleanly
  // (never an uncaught crash), and finalizeAndWriteMatrixRecords' caller (cmdRunCampaign, mirroring
  // cmdRun's own existing `result.rejectionId == null` branch) already falls back to the SAME
  // finalizeIncident/reportIncident path calibrate/smoke/run already use for every OTHER
  // unexpected-shape failure -- proven below to still be fail-closed, zero-evidence, privacy-safe,
  // and to preserve a genuinely SPECIFIC reason (never a generic "something went wrong").
  it('missing result crossing the strict->unrestricted boundary: fails closed with a specific, privacy-safe incident diagnostic (not yet a rich rejection diagnostic -- see this test\'s own header comment)', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(runArgs(['--seed', '11', ...CAMPAIGN_FLAGS(attestationPath)]), fakeClaudeEnv('campaign-failfast-mid'), 60000);
    expect(result.status).toBe(1);
    expect(result.parsed).toBeNull();
    // Zero accepted evidence, unconditionally -- a broken cell (or any cell after it) is never
    // promoted, regardless of which diagnostic tier ends up describing the failure.
    expect(listEvidenceFiles('scenario').length).toBe(0);

    // The rejection-diagnostics tier-1 path could not represent this mixed-profile batch (the
    // known limitation above) -- no committed rejection file exists, but the directory itself may
    // still exist (writeRejectionForensics' OTHER two transactions -- raw transcripts, stderr --
    // are independent and still ran/persisted before the diagnostics transaction failed).
    const rejectedDir = path.join(runsRoot, 'agentic-eval-rejected');
    if (existsSync(rejectedDir)) {
      expect(readdirSync(rejectedDir).filter((f) => f.endsWith('.json'))).toEqual([]);
    }

    // The harness's EXISTING incident fallback (finalizeIncident/reportIncident -- the same one
    // calibrate/smoke/run already use for every other unexpected-shape failure, with its own
    // dedicated privacy tests in agentic-eval-incident-diagnostics.test.js) took over cleanly:
    // exactly one structured, privacy-safe incident file, never silently swallowed.
    const incidentDir = path.join(runsRoot, 'agentic-eval-incident');
    const incidentFiles = readdirSync(incidentDir).filter((f) => f.endsWith('.json'));
    expect(incidentFiles.length).toBe(1);
    const incident = JSON.parse(readFileSync(path.join(incidentDir, incidentFiles[0]), 'utf8'));

    // Exact key-set check (this codebase's own established discipline for closed shapes) -- proves
    // no extra, unaccounted-for field (e.g. a raw path or transcript) is present at all, not merely
    // that the fields we happen to check look clean.
    expect(Object.keys(incident).sort()).toEqual([
      'counts', 'created_at', 'emergency_raw_persisted', 'emergency_raw_write_error', 'incident_id',
      'failed_cell_correlation', 'phase', 'planned_cell_count', 'provenance', 'reason', 'run_kind', 'schema',
    ].sort());

    expect(incident.schema).toBe(2);
    expect(incident.failed_cell_correlation).toEqual({
      schema: 1,
      condition: 'current-skill',
      policy_mode: 'not_applicable',
      tool_use_counts_by_kind: { shell: 1, skill: 1, other: 0 },
      missing_id_counts_by_kind: { shell: 0, skill: 0, other: 0 },
      missing_result_counts_by_kind: { shell: 1, skill: 0, other: 0 },
      dispatch_status_counts: {
        hook_evaluated: 0, pre_dispatch_blocked: 0, result_correlated_no_policy: 0,
        unaccounted: 1, unclassified: 0,
      },
      correlation_issue_counts: {
        duplicate_tool_use_id: 0, orphan_tool_result_missing_id: 0,
        orphan_tool_result_unknown_id: 0, duplicate_tool_result: 0, malformed_stream_line: 0,
      },
      timeout_tolerance_applied: false,
    });
    expect(incident.run_kind).toBe('scenario');
    expect(incident.phase).toBe('finalizing_matrix');
    expect(incident.planned_cell_count).toBe(16);
    expect(incident.counts).toEqual({
      planned: 16, spawn_started: 3, spawn_completed: 3, raw_persisted: 3, parsed: 3, evaluated: 3, spawn_failed: 0,
    });
    // The reason stays SPECIFIC, never generic -- names the exact failed check
    // (toolResultsCompleteOk) this fixture's own missing tool_result was designed to trip, proving
    // the classification is genuinely informative, not merely "an incident happened."
    expect(incident.reason).toMatch(/toolResultsCompleteOk:false/);
    // Privacy custody: provenance is the SAME closed, non-secret shape every other incident in this
    // harness carries -- never sourceRepoDir, never a raw transcript, never a filesystem path.
    expect(Object.keys(incident.provenance).sort()).toEqual(['model_requested', 'project_alias', 'project_commit', 'scenario_id', 'seed'].sort());
    expect(incident.provenance.scenario_id).toBe(SCENARIO_ID);
    expect(JSON.stringify(incident)).not.toContain(sourceRepoDir);
    expect(JSON.stringify(incident)).not.toContain(runsRoot);
    expect(JSON.stringify(incident)).not.toContain('toolu_fakebash1');
    expect(JSON.stringify(incident)).not.toContain('kmp-test parallel');
  }, 60000);

  it('attestation failure: a campaign with unrestricted cells and a missing attestation fails before the first fake session, even for the real (non-dry-run) path', async () => {
    const result = await runCli(runArgs(['--seed', '11', '--campaign-design', DESIGN_ID]), fakeClaudeEnv('campaign-success'), 30000);
    expect(result.status).toBe(1);
    expect(result.parsed).toBeNull();
    expect(result.stderr).toMatch(/--isolation-attestation-file <path> is required/);
    // No session, no journal, no evidence, no incident, no rejection -- the failure happens at
    // argument-validation time, strictly before loadScenarioById/journal creation are ever reached.
    expect(listEvidenceFiles('scenario').length).toBe(0);
    expect(existsSync(path.join(runsRoot, 'agentic-eval-rejected'))).toBe(false);
  }, 30000);

  // Real harness cleanup -- never just "afterEach wiped a temp dir". materializeScenarioProject
  // registers a real `git worktree add` against sourceRepoDir for the campaign's own fixture, and
  // removeScenarioWorktree (threaded as runScenarioCampaign's own cleanupFixture) is the ONLY thing
  // that ever unregisters it -- mirrors agentic-eval-run-command.test.js's own identical proof for
  // the legacy path exactly ("leaves no registered git worktree behind after a passing/FAILING
  // run"). `git worktree list` inside sourceRepoDir itself is the observable: exactly 1 line (the
  // main worktree only) proves runScenarioCampaign's own returned `cleanup()` actually ran --
  // cmdRunCampaign's own `matrix.cleanup()` call is the only code path that invokes it.
  it('leaves no registered git worktree behind after a passing campaign run (matrix.cleanup() ran)', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(runArgs(['--seed', '11', ...CAMPAIGN_FLAGS(attestationPath)]), fakeClaudeEnv('campaign-success'), 120000);
    expect(result.status).toBe(0);
    const worktreeList = gitViaBash(['worktree', 'list'], sourceRepoDir);
    expect(worktreeList.trim().split('\n').length).toBe(1);
  }, 120000);

  it('leaves no registered git worktree behind after a FAILING campaign run either (cleanup runs even on result.ok:false / incident)', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(runArgs(['--seed', '11', ...CAMPAIGN_FLAGS(attestationPath)]), fakeClaudeEnv('campaign-failfast-mid'), 60000);
    expect(result.status).toBe(1);
    const worktreeList = gitViaBash(['worktree', 'list'], sourceRepoDir);
    expect(worktreeList.trim().split('\n').length).toBe(1);
  }, 60000);
});

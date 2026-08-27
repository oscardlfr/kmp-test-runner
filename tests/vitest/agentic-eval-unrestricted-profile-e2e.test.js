// tests/vitest/agentic-eval-unrestricted-profile-e2e.test.js
// Real end-to-end integration tests for the sandboxed-unrestricted-v1 execution profile (PR 4:
// agentic-eval-isolated-unrestricted-profile-v1), run as REAL `node cli.mjs ...` subprocesses
// against fake `claude` fixtures under tests/fixtures/fake-claude-*-unrestricted-*/ (never the
// real claude CLI, never `--dangerously-skip-permissions`/bypassPermissions on THIS host -- the
// fake fixture is a bash script, not a real Claude Code binary, so no permission mode this harness
// passes to it has any real effect). Zero live API cost, zero live authentication, zero real
// prompts -- exactly the same zero-vendor-cost discipline as agentic-eval-run-command.test.js and
// agentic-eval-cli-integration.test.js, which this file deliberately mirrors the structure of.
//
// This is the second and final new test file this PR's own runbook authorizes (the first is
// agentic-eval-isolation-attestation.test.js, covering loadIsolationAttestation's own unit
// contract in isolation). Everything here proves the FULL WIRING through the real CLI subprocess:
// registry resolution -> attestation load/validation -> per-profile argv/settings/env compilation
// -> no-policy dispatch accounting -> schema v6 no-policy fields -> accepted-run-audit sidecar v8
// -> promotion. Unit-level coverage for each of those layers already exists in their own dedicated
// test files (agentic-eval-registries/condition-launcher/claude-runtime-adapter/schemas/
// pre-dispatch-block/junit-evidence/accepted-run-audit.test.js); this file's job is proving they
// compose correctly end-to-end, not re-deriving any of them.
//
// 8-point coverage map (this PR's own runbook, Stage 7):
//  1. run --dry-run strict regression (default profile's dry-run JSON stays byte-for-byte).
//  2. run --dry-run unrestricted, with a synthetic isolation attestation.
//  3+4. Unrestricted current-skill AND no-skill, full acceptance -> schema v6 record + v8 sidecar.
//  5. A genuinely missing tool_result fails the WHOLE matrix closed -- never an accepted sidecar.
//  6. Auth failure / a malformed stream still follow their pre-existing, profile-independent phases.
//  7. calibrate and smoke traverse the fake path with zero hook events and real accounting.
//  8. Strict fake E2E, run through this file's own harness, stays exactly as before.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';
import { validateAcceptedRunAuditSidecar, crossValidateAcceptedRunAuditAgainstRecord } from '../../tools/agentic-eval/accepted-run-audit.mjs';
import { validateRejectionRow, REJECTION_DIAGNOSTICS_SCHEMA_V12 } from '../../tools/agentic-eval/rejection-diagnostics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'tools', 'agentic-eval', 'cli.mjs');
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

let runsRoot;
let isolatedTmp;
let sourceRepoDir;
let scenariosDir;
let pinnedCommit;

const PROJECT_URL = 'https://github.com/example/fake-unrestricted-e2e-project.git';
const SCENARIO_ID = 'unrestricted-e2e-test-only-scenario';

function gitViaBash(argv, cwd) {
  const shQuote = (arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`;
  const cmd = argv.map(shQuote).join(' ');
  const r = spawnSync(resolveBash(), ['-c', `git ${cmd}`], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

beforeEach(() => {
  runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aeup-runs-root-'));
  isolatedTmp = mkdtempSync(path.join(os.tmpdir(), 'aeup-isolated-tmp-'));

  sourceRepoDir = mkdtempSync(path.join(os.tmpdir(), 'aeup-source-'));
  gitViaBash(['init', '-q'], sourceRepoDir);
  gitViaBash(['config', 'user.email', 'test@example.com'], sourceRepoDir);
  gitViaBash(['config', 'user.name', 'Test'], sourceRepoDir);
  writeFileSync(path.join(sourceRepoDir, 'marker.txt'), 'pristine\n');
  gitViaBash(['add', '-A'], sourceRepoDir);
  gitViaBash(['commit', '-q', '-m', 'initial'], sourceRepoDir);
  pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
  gitViaBash(['remote', 'add', 'origin', PROJECT_URL], sourceRepoDir);

  scenariosDir = mkdtempSync(path.join(os.tmpdir(), 'aeup-scenarios-'));
  writeFileSync(path.join(scenariosDir, `${SCENARIO_ID}.json`), JSON.stringify({
    schema: 1,
    id: SCENARIO_ID,
    family: 'test-only',
    project_alias: 'fake-unrestricted-e2e-project',
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
 * the full Windows-CI vitest-RPC-heartbeat-timeout rationale this mirrors exactly. Every caller
 * must `await` this. */
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

/** The committed (tier-1) rejection-diagnostic this run's own fail-fast/hard-gate rejection wrote
 * -- resolved the same way agentic-eval-rejection-diagnostics.test.js's own "wired into cli.mjs"
 * describe block does (tools/runs/agentic-eval-rejected/<rejection_id>.json under this test's own
 * isolated runsRoot), asserting exactly one such file exists rather than guessing a filename. */
function readCommittedRejectionDiagnostic() {
  const rejectedDir = path.join(runsRoot, 'agentic-eval-rejected');
  const committedFiles = readdirSync(rejectedDir).filter((f) => f.endsWith('.json'));
  expect(committedFiles.length).toBe(1);
  return JSON.parse(readFileSync(path.join(rejectedDir, committedFiles[0]), 'utf8'));
}

function runArgs(extra = []) {
  return ['run', '--scenario', SCENARIO_ID, '--source-repo-dir', sourceRepoDir, '--model', 'claude-sonnet-5', ...extra];
}

// Mirrors cli.mjs's own resolvePlatform() exactly -- the attestation's declared `platform` must
// match whatever THIS test process's host actually reports, or loadIsolationAttestation's
// context_mismatch check rejects it. Hardcoding 'windows' here would silently break this whole
// file on the ubuntu-latest/macos-latest legs of this repo's own CI matrix.
function resolvePlatformForAttestation() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return 'not-recorded';
}

let cachedHarnessSha = null;
/** The kmp-test-runner worktree's OWN current HEAD -- resolved the identical way
 * resolveHarnessProvenance() does inside cli.mjs (`git rev-parse HEAD` with cwd:REPO_ROOT, no
 * bash-c indirection needed, same rationale). Never hardcoded: this worktree's HEAD is whatever
 * it is at test-run time, and will differ once this PR's own commit lands at the end of the
 * runbook -- a literal SHA baked in here would silently go stale the moment that happens. */
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
/** Writes one syntactically-valid, fresh, correctly-bound isolation attestation file (matching
 * isolation-attestation.mjs's own closed shape exactly) into isolatedTmp and returns its path.
 * `overrides` lets a specific test deliberately break one field to prove the CLI's own rejection
 * path, without duplicating the other 15 fields. */
function writeValidAttestation(overrides = {}) {
  attestationCounter += 1;
  const now = new Date();
  const created = new Date(now.getTime() - 60 * 1000);
  const expires = new Date(now.getTime() + 60 * 60 * 1000);
  const attestation = {
    schema: 1,
    profile_id: 'sandboxed-unrestricted-v1',
    runtime_id: 'claude-code',
    campaign_id: 'agentic-eval-unrestricted-e2e-test',
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

const UNRESTRICTED_EXECUTION_PROFILE_FLAGS = (attestationPath) => ['--execution-profile', 'sandboxed-unrestricted-v1', '--isolation-attestation-file', attestationPath];

describe('1. run --dry-run -- strict (default) profile regression bookend', () => {
  it('bare --dry-run (no execution-profile flags) never carries any of this PR\'s new attestation keys', async () => {
    const result = await runCli(
      ['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/definitely/does/not/exist', '--seed', '1', '--dry-run'],
      fakeClaudeEnv('run-scenario-success'),
    );
    expect(result.status).toBe(0);
    expect(result.parsed.execution_profile_id).toBe('strict-policy-v1');
    for (const key of ['execution_profile_isolation_kind', 'execution_profile_network_mode', 'execution_profile_policy_mode', 'execution_profile_isolation_attestation_sha256']) {
      expect(key in result.parsed).toBe(false);
    }
    // Genuinely zero-spawn, even under this PR's own new attestation-check call site -- proven the
    // same way run-command.test.js's own dry-run suite already proves it: a nonexistent
    // --source-repo-dir never surfaces as an error, because dry-run returns long before it's ever read.
    expect(listEvidenceFiles('scenario')).toEqual([]);
  }, 15000);
});

describe('2. run --dry-run -- sandboxed-unrestricted-v1, with a synthetic isolation attestation', () => {
  it('a valid attestation resolves the plan and reports the 4 new keys, still touching nothing under --source-repo-dir', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(
      ['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/definitely/does/not/exist', '--seed', '1', '--dry-run', ...UNRESTRICTED_EXECUTION_PROFILE_FLAGS(attestationPath)],
      fakeClaudeEnv('run-scenario-unrestricted-success'),
    );
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    expect(result.parsed.execution_profile_id).toBe('sandboxed-unrestricted-v1');
    expect(result.parsed.execution_profile_isolation_kind).toBe('external-sandbox');
    expect(result.parsed.execution_profile_network_mode).toBe('restricted');
    expect(result.parsed.execution_profile_policy_mode).toBe('not_applicable');
    expect(result.parsed.execution_profile_isolation_attestation_sha256).toMatch(/^[0-9a-f]{64}$/);
    // Never leaked: the attestation file's own path, or any of its operator-identifying field
    // values (campaign_id, timestamps) -- only the bound hash appears anywhere in stdout.
    expect(result.stdout).not.toContain(attestationPath);
    expect(result.stdout).not.toContain('agentic-eval-unrestricted-e2e-test');
    expect(listEvidenceFiles('scenario')).toEqual([]);
  }, 15000);

  it('a missing --isolation-attestation-file fails closed, even under --dry-run, before any plan is printed', async () => {
    const result = await runCli(
      ['run', '--scenario', SCENARIO_ID, '--source-repo-dir', '/definitely/does/not/exist', '--seed', '1', '--dry-run', '--execution-profile', 'sandboxed-unrestricted-v1'],
      fakeClaudeEnv('run-scenario-unrestricted-success'),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--isolation-attestation-file <path> is required/);
    expect(result.parsed).toBeNull();
  }, 15000);
});

describe('3+4. run -- sandboxed-unrestricted-v1, current-skill AND no-skill, full acceptance', () => {
  it('repeats=2: writes 4 schema-v6 records with a v8 accepted-run-audit sidecar each, honest null policy fields, and real no-policy dispatch accounting', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(
      runArgs(['--seed', '13', '--repeats', '2', ...UNRESTRICTED_EXECUTION_PROFILE_FLAGS(attestationPath)]),
      fakeClaudeEnv('run-scenario-unrestricted-success'),
      60000,
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.parsed).not.toBeNull();
    const { records } = result.parsed;
    expect(records.length).toBe(4);
    expect(listEvidenceFiles('scenario').length).toBe(4);

    const currentSkillRecords = records.filter((r) => r.condition === 'current-skill');
    const noSkillRecords = records.filter((r) => r.condition === 'no-skill');
    expect(currentSkillRecords.length).toBe(2);
    expect(noSkillRecords.length).toBe(2);

    for (const record of records) {
      // execution_profile: a complete, real projection of the registry entry plus this run's own
      // validated attestation hash -- never a partial or guessed shape.
      expect(record.execution_profile).toEqual({
        id: 'sandboxed-unrestricted-v1',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        isolation_kind: 'external-sandbox',
        isolation_attestation_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        isolation_attestation_required: true,
        network_mode: 'restricted',
        policy_mode: 'not_applicable',
        required_capabilities: ['structuredTranscript', 'correlatedToolResults', 'skillStateEvidence'],
      });
      // Every record in this matrix shares the identical attestation hash -- one attestation file,
      // one CLI invocation, 4 cells.
      expect(record.execution_profile.isolation_attestation_sha256).toBe(records[0].execution_profile.isolation_attestation_sha256);

      expect(record.permission_mode_used).toBe('bypassPermissions');
      // Honest null, never 0/[]/a stale value -- no policy hook ever governed this run.
      expect(record.policy_allowed_gradle_tasks).toBeNull();
      expect(record.policy_allowed_kmptest_subcommands).toBeNull();
      expect(record.policy_sha256).toBeNull();
      expect(record.hook_call_count).toBeNull();
      expect(record.hook_deny_count).toBeNull();
      expect(record.policy_denials_before_first_signal).toEqual({ value: null, reason: 'execution-profile-policy-not-applicable' });
      expect(record.policy_denials_after_first_signal).toEqual({ value: null, reason: 'execution-profile-policy-not-applicable' });

      // Real, observed behavior: the fixture's ONE Bash call correlates a real tool_result, so
      // no-policy dispatch accounting counts it as genuine engagement (resolveDecisions'
      // not_applicable branch synthesizes 'allow' from result-correlation alone) -- the identical
      // outcome the strict fixture's own hook-mediated 'allow' produces for the same transcript shape.
      expect(record.test_invocations_total.value).toBe(1);
      expect(record.retries.value).toBe(0);
      expect(record.expected_outcome_matched.value).toBe(true);
      expect(record.success.value).toBe(true);
      expect(record.benchmark_eligible).toBe(true);

      // schema v6 run record with accepted-run-audit sidecar v8 -- never v3, the moment
      // policy_mode:"not_applicable" is what actually produced this record. v8 is the
      // privacy-safe terminal coverage/final-answer observability extension; the record schema stays v6.
      expect(record.accepted_audit.schema).toBe(8);
    }

    // The sidecar written to disk, read back and independently validated/cross-validated --
    // proving buildAcceptedRunAuditSidecar/validateAcceptedRunAuditSidecar/
    // crossValidateAcceptedRunAuditAgainstRecord compose correctly through the REAL promotion
    // path, not just their own dedicated unit tests.
    for (const record of records) {
      const sidecar = readAcceptedAuditSidecar(record.run_id);
      expect(sidecar.schema).toBe(8);
      expect(sidecar.execution_profile_id).toBe('sandboxed-unrestricted-v1');
      expect(sidecar.policy_mode).toBe('not_applicable');
      expect(sidecar.isolation_attestation_sha256).toBe(record.execution_profile.isolation_attestation_sha256);
      expect(sidecar.terminal_evidence).toMatchObject({
        present: true,
        provider: 'kmp-test',
        evidence_well_formed: true,
        target_matches_expected: true,
        outcome_matches_expected: true,
        coverage_gate_diagnostic: 'not-applicable',
        coverage_gate_attempts: [],
        final_answer_block: { found: true, parsed: true, ambiguous: false, matches_observed: true },
      });
      expect(sidecar.summary.policy_denials_total).toBeNull();
      expect(sidecar.summary.policy_decisions_missing).toBeNull();
      expect(sidecar.summary.policy_denials_before_first_signal).toBeNull();
      expect(sidecar.summary.policy_denials_after_first_signal).toBeNull();
      expect(sidecar.summary.dispatch_unaccounted_total).toBe(0);
      expect(sidecar.summary.shell_commands_total).toBe(1);

      // Skill attempts are also present in tool_calls (tool_kind:'target-skill'/'non-target-skill'),
      // but dispatch_status only ever leaves its 'not_applicable' default for a shell-kind entry
      // (classifyToolCall only reassigns it inside the `a.kind === 'shell'` branch) -- filtering on
      // that is a robust way to isolate the one real Bash attempt without hardcoding its exact
      // kmp-test/gradle/other-bash sub-classification.
      const bashEntries = sidecar.tool_calls.filter((tc) => tc.dispatch_status !== 'not_applicable');
      expect(bashEntries.length).toBe(1);
      expect(bashEntries[0].dispatch_status).toBe('result_correlated_no_policy');
      expect(bashEntries[0].policy_decision).toBe('not-applicable');
      expect(bashEntries[0].result_status).toBe('success');

      expect(validateAcceptedRunAuditSidecar(sidecar).errors).toEqual([]);
      expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record)).toEqual([]);
    }

    // Condition-specific facts stay condition-specific -- the shared no-policy shape above never
    // masks a genuine skill_observation difference between the two arms.
    for (const record of currentSkillRecords) expect(record.skill_observation.delivery_mode).toBe('runtime-extension');
    for (const record of noSkillRecords) expect(record.skill_observation.delivery_mode).toBe('none');
  }, 60000);
});

describe('5. run -- a genuinely missing tool_result fails the WHOLE matrix closed, never an accepted sidecar', () => {
  // Regression coverage for a real bug this test itself found and (in an authorized, scoped
  // follow-up within this same PR) fixed: rejection-diagnostics.mjs's validateRejectionRow() used
  // to unconditionally require `policy_sha256` to be a real 64-hex-char string. For a
  // policy_mode:"not_applicable" record it is honestly `null` (Decision F/G), so
  // writeRejectedRunDiagnostics() threw internally on every such rejection; writeRejectionForensics()
  // caught that throw but never assigned `rejectionId`, so cli.mjs's own `result.rejectionId == null`
  // branch misclassified a normal, well-understood rejection as a generic "finalizing_matrix"
  // incident instead of the clean "RUN FAILED: <reason>" strict already produces. Fixed by adding
  // rejection-diagnostics schema 12 (REJECTION_DIAGNOSTICS_SCHEMA_V12): exclusive to a batch whose
  // every record is schema>=6 with execution_profile.policy_mode:"not_applicable", policy_sha256
  // exactly null, profile/attestation fields reporting which profile actually applied, and
  // privacy-safe per-cell observability for run-record error codes, correlation counts, and
  // pre-inference summaries with closed cause/runtime codes, exact timing/usage/token/tool-count
  // metrics, closed grading summaries, and terminal-evidence summaries. v2/v3/v4/v5/v6/v7/v8/v9/v10 stay frozen. This test now proves the FULL, correct, end-to-end
  // rejection shape.
  it('zero records written for ANY cell, fail-fast reported via the normal RUN FAILED path, a sanitized schema-11 rejection diagnostic written, no accepted-run-audit sidecar anywhere', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(
      runArgs(['--seed', '1', '--repeats', '1', ...UNRESTRICTED_EXECUTION_PROFILE_FLAGS(attestationPath)]),
      fakeClaudeEnv('run-scenario-unrestricted-missing-result'),
      30000,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/RUN FAILED/);
    expect(result.stderr).toMatch(/toolResultsCompleteOk:false/);
    // The generic incident path this bug used to fall through to is now genuinely never reached.
    expect(result.stderr).not.toMatch(/SCENARIO FAILED \(finalizing_matrix\)/);
    expect(result.stderr).not.toContain('Incident diagnostic written');
    expect(listEvidenceFiles('scenario')).toEqual([]);
    expect(existsSync(path.join(evidenceDirFor('scenario'), 'audit'))).toBe(false);

    const committed = readCommittedRejectionDiagnostic();
    expect(committed.schema).toBe(REJECTION_DIAGNOSTICS_SCHEMA_V12);
    expect(committed.execution_profile_id).toBe('sandboxed-unrestricted-v1');
    expect(committed.policy_mode).toBe('not_applicable');
    expect(committed.isolation_attestation_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(committed.policy_sha256).toBeNull();
    expect(committed.cells[0].pre_inference_failure.signature_matched).toBe(false);
    expect(committed.cells[0].pre_inference_failure.runtime_error_code).toBe('not_matched');
    expect(committed.cells[0].cell_metrics.schema).toBe(1);
    expect(Object.keys(committed.cells[0].cell_metrics.usage).sort()).toEqual(['cache_write', 'cached_input', 'input', 'output', 'reasoning_output', 'source']);
    expect(committed.cells[0].cell_metrics.usage.source).toBe('runtime-reported');
    expect(committed.cells[0].cell_metrics.tokens.input.value).toBe(committed.cells[0].cell_metrics.usage.input);
    expect(committed.cells[0].cell_metrics.tokens.cache_read.value).toBe(committed.cells[0].cell_metrics.usage.cached_input);
    expect(committed.cells[0].cell_metrics.tool_calls_total.value).toBeGreaterThan(0);
    expect(committed.cells[0].grading_summary.schema).toBe(1);
    expect(committed.cells[0].grading_summary.success.value).toBe(false);
    expect(committed.cells[0].grading_summary.expected_outcome_matched.value).toBe(false);
    expect(committed.cells[0].grading_summary.grading_checks.value).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'tool_result_correlated', passed: false })]),
    );
    expect(committed.cells[0].terminal_evidence_summary.schema).toBe(1);
    expect(committed.cells[0].terminal_evidence_summary.source).toBe('runtime-reported');
    expect(committed.cells[0].terminal_evidence_summary.coverage_gate_diagnostic).toBe('not-applicable');
    for (const check of committed.cells[0].grading_summary.grading_checks.value) {
      expect(Object.keys(check).sort()).toEqual(['evidence_event_indices', 'name', 'passed']);
    }
    expect(JSON.stringify(committed.cells[0].grading_summary)).not.toMatch(/free-text detail|prompt|response/);
    expect(JSON.stringify(committed.cells[0].terminal_evidence_summary)).not.toMatch(/final_answer|prompt|response|tool_result_event_index/);
    expect(validateRejectionRow(committed).errors).toEqual([]);
    // The committed tier's own closed field set (just re-proven by validateRejectionRow above)
    // structurally admits no raw transcript content -- confirmed directly too: neither the
    // attestation path nor its own operator-identifying fields (checked identically to block 2's
    // dry-run proof) ever reach the committed diagnostic or this process's own stdout/stderr.
    expect(JSON.stringify(committed)).not.toContain(attestationPath);
    expect(result.stdout).not.toContain(attestationPath);
    expect(result.stderr).not.toContain(attestationPath);
  }, 30000);
});

describe('6. run -- auth failure and a malformed stream still follow their current, profile-independent phases', () => {
  it('an auth preflight failure rejects before any live-session accounting, identically under sandboxed-unrestricted-v1', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(
      runArgs(['--seed', '1', '--repeats', '1', ...UNRESTRICTED_EXECUTION_PROFILE_FLAGS(attestationPath)]),
      fakeClaudeEnv('auth-status-fail'),
      30000,
    );
    expect(result.status).toBe(1);
    // The auth preflight throws BEFORE finalizeAndWriteMatrixRecords is ever reached, so this
    // takes the thrown-exception incident path (SCENARIO FAILED (acquiring_shared_resources): ...),
    // never the gate-rejection "RUN FAILED: ..." path the missing-result/malformed tests hit below
    // -- this is the ONE genuinely-expected use of the incident path in this whole file (no rejected
    // cell, no rejection-diagnostics batch to build at all -- the matrix never even starts).
    expect(result.stderr).toMatch(/SCENARIO FAILED \(acquiring_shared_resources\)/);
    expect(result.stderr).toMatch(/auth_preflight_nonzero_exit/);
    expect(listEvidenceFiles('scenario')).toEqual([]);
  }, 30000);

  // Same fixed rejection-diagnostics schema-11 contract as block 5's own test above (see its header
  // comment for the full root-cause trace) -- a malformed-transcript rejection is ALSO a genuine
  // fail-fast/hard-gate rejection, so it exercises the identical schema-11 path with a different
  // specific reason (cleanTranscriptOk:false here, toolResultsCompleteOk:false there).
  it('a harness-integrity failure (malformed transcript) blocks the WHOLE matrix, identically under sandboxed-unrestricted-v1, with a sanitized schema-11 rejection diagnostic written', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(
      runArgs(['--seed', '1', '--repeats', '1', ...UNRESTRICTED_EXECUTION_PROFILE_FLAGS(attestationPath)]),
      fakeClaudeEnv('malformed'),
      30000,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/RUN FAILED/);
    expect(result.stderr).toMatch(/cleanTranscriptOk:false/);
    expect(result.stderr).not.toMatch(/SCENARIO FAILED \(finalizing_matrix\)/);
    expect(result.stderr).not.toContain('Incident diagnostic written');
    expect(listEvidenceFiles('scenario')).toEqual([]);

    const committed = readCommittedRejectionDiagnostic();
    expect(committed.schema).toBe(REJECTION_DIAGNOSTICS_SCHEMA_V12);
    expect(committed.policy_mode).toBe('not_applicable');
    expect(committed.policy_sha256).toBeNull();
    expect(committed.cells[0].pre_inference_failure.signature_matched).toBe(false);
    expect(committed.cells[0].pre_inference_failure.runtime_error_code).toBe('not_matched');
    expect(committed.cells[0].cell_metrics.schema).toBe(1);
    expect(committed.cells[0].cell_metrics.usage.source).toBe('runtime-reported');
    expect(committed.cells[0].grading_summary.schema).toBe(1);
    expect(committed.cells[0].grading_summary.grading_checks.value).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'authoritative_evidence_well_formed', passed: false })]),
    );
    expect(committed.cells[0].terminal_evidence_summary.schema).toBe(1);
    expect(committed.cells[0].terminal_evidence_summary.coverage_gate_diagnostic).toBe('not-applicable');
    for (const check of committed.cells[0].grading_summary.grading_checks.value) {
      expect(Object.keys(check).sort()).toEqual(['evidence_event_indices', 'name', 'passed']);
    }
    expect(JSON.stringify(committed.cells[0].grading_summary)).not.toMatch(/free-text detail|prompt|response/);
    expect(JSON.stringify(committed.cells[0].terminal_evidence_summary)).not.toMatch(/final_answer|prompt|response|tool_result_event_index/);
    expect(validateRejectionRow(committed).errors).toEqual([]);
  }, 30000);
});

describe('7. calibrate and smoke -- sandboxed-unrestricted-v1 traverses the fake path with zero hook events and real accounting', () => {
  it('calibrate: passes the no-policy hard gate, writes schema-valid evidence, hook_call_count/hook_deny_count stay honestly null', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(
      ['calibrate', '--model', 'claude-sonnet-5', ...UNRESTRICTED_EXECUTION_PROFILE_FLAGS(attestationPath)],
      fakeClaudeEnv('calibrate-smoke-unrestricted-success'),
      30000,
    );
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    const { recordA, recordB } = result.parsed;
    for (const record of [recordA, recordB]) {
      expect(record.execution_profile.id).toBe('sandboxed-unrestricted-v1');
      expect(record.execution_profile.policy_mode).toBe('not_applicable');
      expect(record.permission_mode_used).toBe('bypassPermissions');
      expect(record.hook_call_count).toBeNull();
      expect(record.hook_deny_count).toBeNull();
      // calibrate never writes a scenario-only accepted-run-audit sidecar, regardless of profile.
      expect(record.accepted_audit).toBeNull();
    }
    expect(recordA.skill_available.value).toBe(false);
    expect(recordB.skill_available.value).toBe(true);
    expect(listEvidenceFiles('calibration').length).toBe(2);
    expect(existsSync(path.join(evidenceDirFor('calibration'), 'audit'))).toBe(false);
  }, 30000);

  it('smoke: passes the no-policy equivalent-real-work hard gate against a real materialized project, same null hook fields', async () => {
    const attestationPath = writeValidAttestation();
    const result = await runCli(
      ['smoke', '--source-repo-dir', sourceRepoDir, '--pinned-commit', pinnedCommit, '--project-alias', 'unrestricted-e2e-smoke', '--model', 'claude-sonnet-5', ...UNRESTRICTED_EXECUTION_PROFILE_FLAGS(attestationPath)],
      fakeClaudeEnv('calibrate-smoke-unrestricted-success'),
      30000,
    );
    expect(result.status).toBe(0);
    expect(result.parsed).not.toBeNull();
    const { recordA, recordB } = result.parsed;
    for (const record of [recordA, recordB]) {
      expect(record.execution_profile.id).toBe('sandboxed-unrestricted-v1');
      expect(record.execution_profile.policy_mode).toBe('not_applicable');
      expect(record.hook_call_count).toBeNull();
      expect(record.hook_deny_count).toBeNull();
      expect(record.accepted_audit).toBeNull();
    }
    expect(listEvidenceFiles('smoke').length).toBe(2);
  }, 30000);
});

describe('8. run -- strict (default) fake E2E, run through this file\'s own harness, stays exactly as before', () => {
  it('repeats=2 under strict-policy-v1 keeps the pre-existing real-value policy shape and a v3 sidecar', async () => {
    const result = await runCli(runArgs(['--seed', '13', '--repeats', '2']), fakeClaudeEnv('run-scenario-success'), 60000);
    expect(result.status).toBe(0);
    const { records } = result.parsed;
    expect(records.length).toBe(4);
    for (const record of records) {
      expect(record.execution_profile).toEqual({
        id: 'strict-policy-v1', sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        isolation_kind: 'runtime-policy-hooks', isolation_attestation_sha256: null,
        isolation_attestation_required: false, network_mode: 'runtime-default',
        policy_mode: 'required', required_capabilities: ['softPermissionDenial'],
      });
      expect(record.permission_mode_used).toBe('dontAsk');
      expect(typeof record.hook_call_count).toBe('number');
      expect(record.hook_deny_count).toBe(0);
      expect(record.policy_denials_before_first_signal.value).not.toBeNull();
      expect(record.policy_denials_after_first_signal.value).not.toBeNull();
      expect(record.accepted_audit.schema).toBe(3);
    }
    const sidecar = readAcceptedAuditSidecar(records[0].run_id);
    expect(sidecar.schema).toBe(3);
    expect('execution_profile_id' in sidecar).toBe(false);
    expect('policy_mode' in sidecar).toBe(false);
    expect('isolation_attestation_sha256' in sidecar).toBe(false);
    expect(validateAcceptedRunAuditSidecar(sidecar).errors).toEqual([]);
  }, 60000);
});

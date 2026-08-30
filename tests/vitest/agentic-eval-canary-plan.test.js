import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as childProcess from 'node:child_process';
import {
  assertValidScenarioCampaignPlan, buildScenarioCampaignPlan, resolveScenarioCampaignDesign,
} from '../../tools/agentic-eval/scenario-campaign-plan.mjs';
import { cmdRun, parseArgs, validateSubcommandArgs, scenarioMatrixIsBenchmarkEligible } from '../../tools/agentic-eval/cli.mjs';
import { runScenarioCampaign } from '../../tools/agentic-eval/matrix-runner.mjs';

const runsRoot = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-canary-runs-'));
  vi.stubEnv('KMP_EVAL_RUNS_ROOT', dir);
  return dir;
});

afterAll(() => {
  expect(readdirSync(runsRoot)).toEqual([]);
  vi.unstubAllEnvs();
  rmSync(runsRoot, { recursive: true, force: true });
});

// No runtime, Gradle, shell, or transcript fixtures: only read-only git provenance may spawn.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  const blocked = () => { throw new Error('unexpected subprocess in canary dry-run test'); };
  return {
    ...actual,
    spawn: vi.fn(blocked), exec: vi.fn(blocked), execSync: vi.fn(blocked),
    execFile: vi.fn(blocked), execFileSync: vi.fn(blocked), fork: vi.fn(blocked),
    spawnSync: vi.fn((file, args, options) => {
      if (file === 'git' && ['rev-parse', 'status'].includes(args[0])) {
        return actual.spawnSync(file, args, options);
      }
      return blocked();
    }),
  };
});

const SCENARIO = 'coverage-threshold-failure-v2';
const CAMPAIGN = 'claude-product-vs-free-baseline-v1';
const PROFILE = 'sandboxed-unrestricted-v1';
const ARMS = [
  { designId: 'claude-product-canary-v1', label: 'A', condition: 'current-skill', mode: 'product-assisted' },
  { designId: 'claude-free-baseline-canary-v1', label: 'B', condition: 'no-skill', mode: 'free-baseline-no-product' },
];

function buildPlan(designId, overrides = {}) {
  return buildScenarioCampaignPlan({ designId, repeats: 1, executionProfiles: [PROFILE], ...overrides });
}

describe.each(ARMS)('$designId registered one-cell planner', ({ designId, label, condition, mode }) => {
  it('builds one complete registered plan with the full campaign arm semantics', () => {
    const result = buildPlan(designId);
    expect(result.ok, result.reason).toBe(true);
    expect(result.plan).toEqual({
      campaign_design_id: designId, repeats: 1, planned_sessions: 1,
      cells: [{
        campaign_design_id: designId, campaign_cell_label: label,
        order_index: 0, repetition_index: 0, execution_profile_id: PROFILE,
        condition, product_access_mode: mode,
      }],
    });
    expect(() => assertValidScenarioCampaignPlan(JSON.parse(JSON.stringify(result.plan)))).not.toThrow();
    const full = buildScenarioCampaignPlan({ designId: CAMPAIGN, repeats: 4, executionProfiles: [PROFILE] });
    const fullCell = full.plan.cells.find((cell) => cell.campaign_cell_label === label);
    expect(result.plan.cells[0]).toEqual({ ...fullCell, campaign_design_id: designId, order_index: 0 });
    expect(resolveScenarioCampaignDesign(designId).design).toMatchObject({ scenario_id: SCENARIO });
  });

  it('cannot expand its repeat count or use a missing execution profile', () => {
    expect(buildPlan(designId, { repeats: 4 })).toMatchObject({ ok: false, reason: expect.stringContaining('exactly 1 repeats') });
    expect(buildPlan(designId, { executionProfiles: ['strict-policy-v1'] })).toMatchObject({ ok: false, reason: expect.stringContaining(PROFILE) });
  });

  it('rejects arm substitution, extra cells, and disguising it as the full campaign', () => {
    const result = buildPlan(designId);
    expect(result.ok, result.reason).toBe(true);
    const plan = result.plan;
    expect(() => assertValidScenarioCampaignPlan({ ...plan, cells: [{ ...plan.cells[0], product_access_mode: 'product-visible-no-skill' }] })).toThrow(/product_access_mode/);
    expect(() => assertValidScenarioCampaignPlan({ ...plan, planned_sessions: 2, cells: [...plan.cells, plan.cells[0]] })).toThrow(/expected 1 cells/);
    expect(() => assertValidScenarioCampaignPlan({ ...plan, campaign_design_id: CAMPAIGN, repeats: 4 })).toThrow(/expected 8 cells/);
  });

  it('retains the shared runner adapter gate without acquiring resources', async () => {
    const result = buildPlan(designId);
    expect(result.ok, result.reason).toBe(true);
    await expect(runScenarioCampaign({
      scenario: {}, campaignPlan: result.plan,
      selectionsByProfileId: { [PROFILE]: { adapter: undefined } },
    })).rejects.toThrow(/runtimeAdapter|adapter/i);
  });

  it('does not turn an otherwise passing one-cell canary into benchmark evidence', () => {
    expect(scenarioMatrixIsBenchmarkEligible([{
      condition, repetition_index: 0, order_index: 0,
      grading_checks: { value: {} }, success: { value: true }, expected_outcome_matched: { value: true },
    }], { ok: true })).toBe(false);
  });
});

describe('closed campaign registry', () => {
  it.each(['claude-unknown-canary-v1', 'Product', 'FreeBaseline', '__proto__', 'constructor', 'toString'])('rejects invalid arm/design %s', (designId) => {
    expect(resolveScenarioCampaignDesign(designId)).toMatchObject({ ok: false, reason: expect.stringContaining('unknown campaign design') });
  });
});

describe('one-cell CLI contract with real scenario and isolation validation', () => {
  let root;
  let log;
  let error;
  let attestation;
  let attestationFile;

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), 'ae-canary-plan-'));
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sha = childProcess.spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const now = Date.now();
    attestation = {
      schema: 1, profile_id: PROFILE, runtime_id: 'claude-code', campaign_id: 'offline-canary-test',
      platform: { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform],
      boundary_kind: 'disposable-vm', network_mode: 'restricted', workspace_scope: 'campaign-only',
      runtime_credential_scope: 'runtime-only', normal_maintainer_home_mounted: false,
      ambient_secrets_present: false, disposable_home: true, rollback_or_destroy_required: true,
      harness_sha: sha,
      created_at: new Date(now - 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      expires_at: new Date(now + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
    attestationFile = join(root, 'attestation.json');
    writeFileSync(attestationFile, JSON.stringify(attestation), 'utf8');
  });

  afterEach(() => {
    // All rejection/success paths stay read-only: no journals, records, or materialized fixtures.
    expect(readdirSync(root)).toEqual(['attestation.json']);
    expect(readdirSync(runsRoot)).toEqual([]);
    for (const name of ['spawn', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      expect(childProcess[name]).not.toHaveBeenCalled();
    }
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function argsFor(designId, overrides = {}) {
    return {
      _: ['run'], errors: [], scenario: SCENARIO, 'source-repo-dir': join(root, 'nonexistent-source'),
      seed: '7', 'campaign-design': designId, 'isolation-attestation-file': attestationFile,
      'dry-run': true, ...overrides,
    };
  }

  async function reject(args, message) {
    expect(await cmdRun(args)).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join('\n')).toMatch(message);
  }

  it.each(ARMS)('$designId prints exactly one cell with the full campaign isolation fields', async ({ designId, label, condition, mode }) => {
    expect(await cmdRun(argsFor(CAMPAIGN))).toBe(0);
    const full = JSON.parse(log.mock.calls[0][0]);
    log.mockClear();
    expect(await cmdRun(argsFor(designId))).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    const result = JSON.parse(log.mock.calls[0][0]);
    expect(result).toMatchObject({
      dry_run: true, scenario_id: SCENARIO, campaign_design_id: designId,
      repeats: 1, planned_sessions: 1, seed: 7, runtime_id: 'claude-code', max_budget_usd: 0.6,
    });
    expect(result.plan).toHaveLength(1);
    expect(result.plan[0]).toEqual({ ...full.plan.find((cell) => cell.campaign_cell_label === label), order_index: 0 });
    expect(result.plan[0]).toMatchObject({
      repetition_index: 0, condition, product_access_mode: mode, execution_profile_id: PROFILE,
      execution_profile_isolation_kind: 'external-sandbox', execution_profile_network_mode: 'restricted',
      execution_profile_policy_mode: 'not_applicable',
      execution_profile_isolation_attestation_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.records).toBeUndefined();
    expect(result.evidenceDir).toBeUndefined();
    expect(full.dry_run_only).toBeUndefined();
    expect(full.planned_sessions).toBe(8);
  });

  it.each(ARMS)('$designId retains the existing source-repository gate when dry-run is absent', async ({ designId }) => {
    await reject(argsFor(designId, { 'dry-run': undefined }), /--source-repo-dir does not exist/);
  });

  it.each(ARMS)('$designId retains the isolation gate when dry-run is absent', async ({ designId }) => {
    await reject(argsFor(designId, { 'dry-run': undefined, 'isolation-attestation-file': undefined }), /--isolation-attestation-file <path> is required/);
  });

  it.each(ARMS)('$designId restricts the scenario to coverage-threshold-failure-v2', async ({ designId }) => {
    await reject(argsFor(designId, { scenario: 'coverage-threshold-failure' }), /requires --scenario coverage-threshold-failure-v2/);
  });

  it.each(ARMS)('$designId requires an isolation attestation even for dry-run', async ({ designId }) => {
    await reject(argsFor(designId, { 'isolation-attestation-file': undefined }), /--isolation-attestation-file <path> is required/);
  });

  it.each([
    ['harness_sha', '0'.repeat(40)], ['ambient_secrets_present', true],
    ['normal_maintainer_home_mounted', true], ['workspace_scope', 'host'],
    ['profile_id', 'strict-policy-v1'], ['expires_at', '2020-01-01T00:00:00Z'],
  ])('rejects an invalid isolation boundary: %s', async (key, value) => {
    writeFileSync(attestationFile, JSON.stringify({ ...attestation, [key]: value }), 'utf8');
    await reject(argsFor(ARMS[0].designId), /isolation attestation invalid/);
  });

  it.each([
    [{ repeats: '1' }, /cannot be combined with --repeats/],
    [{ 'execution-profile': PROFILE }, /cannot be combined with --execution-profile/],
    [{ seed: undefined }, /requires --seed/],
    [{ seed: 'abc' }, /--seed must be an integer/],
    [{ runtime: 'invalid' }, /runtime/],
    [{ model: 'invalid' }, /model/],
    [{ 'max-budget-usd': '99' }, /--max-budget-usd/],
    [{ 'private-patterns-file': 'missing-private-patterns.json' }, /private-patterns/],
  ])('rejects invalid shared campaign options %j', async (overrides, message) => {
    await reject(argsFor(ARMS[0].designId, overrides), message);
  });

  it.each([
    ['--campaign-design', ARMS[0].designId, '--campaign-design', ARMS[1].designId],
    ['--dry-run', '--dry-run'],
    ['--scenario', SCENARIO, '--scenario', 'coverage-threshold-failure'],
    ['--campaign-design'], ['--dry-run=false'], ['--dry-run', 'false'],
    ['--arm', 'Product'], ['--canary-arm', 'FreeBaseline'],
  ])('rejects ambiguous/unsupported argv %j before dispatch', (...argv) => {
    const parsed = parseArgs(['run', ...argv]);
    expect([...parsed.errors, ...validateSubcommandArgs('run', parsed)].length).toBeGreaterThan(0);
  });
});

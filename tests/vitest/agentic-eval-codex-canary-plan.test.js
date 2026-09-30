import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as childProcess from 'node:child_process';
import {
  assertValidScenarioCampaignPlan,
  buildScenarioCampaignPlan,
  resolveScenarioCampaignDesign,
  validateScenarioCampaignRuntime,
} from '../../tools/agentic-eval/scenario-campaign-plan.mjs';
import { cmdRun, scenarioMatrixIsBenchmarkEligible } from '../../tools/agentic-eval/cli.mjs';

const runsRoot = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-codex-canary-runs-'));
  vi.stubEnv('KMP_EVAL_RUNS_ROOT', dir);
  return dir;
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  const blocked = () => { throw new Error('unexpected subprocess in Codex canary planner test'); };
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
const PROFILE = 'sandboxed-unrestricted-v1';
const CODEX_RUNTIME = 'codex-cli';
const CLAUDE_RUNTIME = 'claude-code';
const CODEX_CAMPAIGN = 'codex-product-vs-free-baseline-v1';
const CODEX_ARMS = [
  { designId: 'codex-product-canary-v1', label: 'A', condition: 'current-skill', mode: 'product-assisted' },
  { designId: 'codex-free-baseline-canary-v1', label: 'B', condition: 'no-skill', mode: 'free-baseline-no-product' },
];

const CLAUDE_PLAN_HASHES = Object.freeze({
  'claude-2x2-williams-v1': Object.freeze({ repeats: 4, sha256: '167af97f070594227484bac3ed18abe5916d8f659dd332fb00dbd52de8e55876' }),
  'claude-product-vs-free-baseline-v1': Object.freeze({ repeats: 4, sha256: '302f80ab68a003d95563db331f30e0f763e324aa5c8c7c2ee289fd2c21a4fc8d' }),
  'claude-product-canary-v1': Object.freeze({ repeats: 1, sha256: '4756b9a460db3edda4bed78d8369999d110998a05c135b56004ada4383725085' }),
  'claude-free-baseline-canary-v1': Object.freeze({ repeats: 1, sha256: '0dfa61aa8fdb9b8342f55b69acba55f0c01b16a0da3e797c8a6d1827e6aab493' }),
});

afterAll(() => {
  expect(readdirSync(runsRoot)).toEqual([]);
  vi.unstubAllEnvs();
  rmSync(runsRoot, { recursive: true, force: true });
});

describe.each(CODEX_ARMS)('$designId registered one-cell Codex planner', ({ designId, label, condition, mode }) => {
  it('is exactly one unrestricted product/control cell with no historical cell-shape change', () => {
    const result = buildScenarioCampaignPlan({
      designId, repeats: 1, executionProfiles: [PROFILE],
    });
    expect(result.ok, result.reason).toBe(true);
    expect(result.plan).toEqual({
      campaign_design_id: designId,
      repeats: 1,
      planned_sessions: 1,
      cells: [{
        order_index: 0,
        repetition_index: 0,
        campaign_cell_label: label,
        campaign_design_id: designId,
        execution_profile_id: PROFILE,
        condition,
        product_access_mode: mode,
      }],
    });
    expect(Object.keys(result.plan.cells[0]).sort()).toEqual([
      'campaign_cell_label', 'campaign_design_id', 'condition', 'execution_profile_id',
      'order_index', 'product_access_mode', 'repetition_index',
    ]);
    expect(() => assertValidScenarioCampaignPlan(result.plan)).not.toThrow();
    expect(resolveScenarioCampaignDesign(designId).design).toMatchObject({
      runtime_id: CODEX_RUNTIME,
      scenario_id: SCENARIO,
    });
  });

  it('uses the identical arm definition from the complete six-session Codex campaign', () => {
    const canary = buildScenarioCampaignPlan({ designId, repeats: 1, executionProfiles: [PROFILE] });
    const full = buildScenarioCampaignPlan({ designId: CODEX_CAMPAIGN, repeats: 3, executionProfiles: [PROFILE] });
    expect(canary.ok, canary.reason).toBe(true);
    expect(full.ok, full.reason).toBe(true);
    const fullCell = full.plan.cells.find((cell) => cell.campaign_cell_label === label);
    expect(canary.plan.cells[0]).toEqual({
      ...fullCell,
      campaign_design_id: designId,
      order_index: 0,
      repetition_index: 0,
    });
  });

  it('cannot expand beyond its single pre-registered session', () => {
    expect(buildScenarioCampaignPlan({
      designId, repeats: 3, executionProfiles: [PROFILE],
    })).toMatchObject({ ok: false, reason: expect.stringContaining('exactly 1 repeats') });
  });

  it('cannot promote an otherwise passing one-cell result to benchmark evidence', () => {
    expect(scenarioMatrixIsBenchmarkEligible([{
      condition,
      repetition_index: 0,
      order_index: 0,
      grading_checks: { value: {} },
      success: { value: true },
      expected_outcome_matched: { value: true },
    }], { ok: true })).toBe(false);
  });
});

describe('campaign runtime binding', () => {
  it.each([
    ['claude-2x2-williams-v1', CLAUDE_RUNTIME],
    ['claude-product-vs-free-baseline-v1', CLAUDE_RUNTIME],
    ['claude-product-canary-v1', CLAUDE_RUNTIME],
    ['claude-free-baseline-canary-v1', CLAUDE_RUNTIME],
    [CODEX_CAMPAIGN, CODEX_RUNTIME],
    ['codex-product-canary-v1', CODEX_RUNTIME],
    ['codex-free-baseline-canary-v1', CODEX_RUNTIME],
  ])('%s accepts only its registered runtime %s', (designId, runtimeId) => {
    expect(validateScenarioCampaignRuntime({ designId, runtimeId })).toEqual({ ok: true });
    const wrongRuntime = runtimeId === CODEX_RUNTIME ? CLAUDE_RUNTIME : CODEX_RUNTIME;
    expect(validateScenarioCampaignRuntime({ designId, runtimeId: wrongRuntime })).toMatchObject({
      ok: false,
      reason: expect.stringContaining(`requires runtime "${runtimeId}"`),
    });
  });

  it('preserves every historical Claude plan byte-for-byte', () => {
    for (const [designId, expected] of Object.entries(CLAUDE_PLAN_HASHES)) {
      const result = buildScenarioCampaignPlan({
        designId,
        repeats: expected.repeats,
        executionProfiles: ['strict-policy-v1', PROFILE],
      });
      expect(result.ok, result.reason).toBe(true);
      const actualSha256 = createHash('sha256').update(JSON.stringify(result.plan)).digest('hex');
      expect(actualSha256, designId).toBe(expected.sha256);
    }
  });
});

describe('Codex canary CLI dry-run and pre-dispatch mismatch gate', () => {
  let root;
  let log;
  let error;
  let attestationFile;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ae-codex-canary-plan-'));
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sha = childProcess.spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const now = Date.now();
    attestationFile = join(root, 'attestation.json');
    writeFileSync(attestationFile, JSON.stringify({
      schema: 1,
      profile_id: PROFILE,
      runtime_id: CODEX_RUNTIME,
      campaign_id: 'codex-canary-offline-test',
      platform: { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform],
      boundary_kind: 'disposable-vm',
      network_mode: 'restricted',
      workspace_scope: 'campaign-only',
      runtime_credential_scope: 'runtime-only',
      normal_maintainer_home_mounted: false,
      ambient_secrets_present: false,
      disposable_home: true,
      rollback_or_destroy_required: true,
      harness_sha: sha,
      created_at: new Date(now - 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      expires_at: new Date(now + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }), 'utf8');
    vi.clearAllMocks();
  });

  afterEach(() => {
    expect(readdirSync(root)).toEqual(['attestation.json']);
    expect(readdirSync(runsRoot)).toEqual([]);
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function argsFor(designId, runtime, model, overrides = {}) {
    return {
      _: ['run'], errors: [], scenario: SCENARIO,
      'source-repo-dir': join(root, 'source-must-not-be-materialized'),
      seed: '17', 'campaign-design': designId, 'timeout-ms': '900000',
      runtime, model, ...overrides,
    };
  }

  it.each(CODEX_ARMS)('$designId emits an honest Codex dry-run with null budget telemetry', async ({ designId, label, condition, mode }) => {
    const args = argsFor(designId, CODEX_RUNTIME, 'gpt-5.6-terra', {
      'isolation-attestation-file': attestationFile,
      'dry-run': true,
    });
    expect(await cmdRun(args)).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const result = JSON.parse(log.mock.calls[0][0]);
    expect(result).toMatchObject({
      dry_run: true,
      scenario_id: SCENARIO,
      campaign_design_id: designId,
      repeats: 1,
      planned_sessions: 1,
      runtime_id: CODEX_RUNTIME,
      model_id: 'gpt-5.6-terra',
      max_budget_usd: null,
      max_budget_reason: 'runtime_does_not_support_session_budget',
    });
    expect(result.plan).toEqual([expect.objectContaining({
      order_index: 0,
      repetition_index: 0,
      campaign_cell_label: label,
      condition,
      product_access_mode: mode,
      execution_profile_id: PROFILE,
      execution_profile_isolation_attestation_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);
    expect(result.benchmark_eligible).toBeUndefined();
    for (const call of childProcess.spawnSync.mock.calls) {
      expect(call[0]).toBe('git');
      expect(['rev-parse', 'status']).toContain(call[1][0]);
    }
    for (const name of ['spawn', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      expect(childProcess[name]).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['codex-product-canary-v1', undefined, undefined, CODEX_RUNTIME],
    [CODEX_CAMPAIGN, CLAUDE_RUNTIME, 'claude-sonnet-5', CODEX_RUNTIME],
    ['codex-product-canary-v1', CLAUDE_RUNTIME, 'claude-sonnet-5', CODEX_RUNTIME],
    ['claude-2x2-williams-v1', CODEX_RUNTIME, 'gpt-5.6-terra', CLAUDE_RUNTIME],
    ['claude-product-vs-free-baseline-v1', CODEX_RUNTIME, 'gpt-5.6-terra', CLAUDE_RUNTIME],
    ['claude-product-canary-v1', CODEX_RUNTIME, 'gpt-5.6-terra', CLAUDE_RUNTIME],
  ])('rejects design %s with runtime %s before any subprocess or materialization', async (designId, runtime, model, requiredRuntime) => {
    expect(await cmdRun(argsFor(designId, runtime, model))).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join('\n')).toContain(`requires runtime "${requiredRuntime}"`);
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      expect(childProcess[name]).not.toHaveBeenCalled();
    }
    expect(readdirSync(root)).toEqual(['attestation.json']);
  });
});

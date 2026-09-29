import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createFinalCampaignControlFromEnv, FINAL_CODEX_AUTHORIZATION_LITERAL,
} from '../../tools/agentic-eval/final-campaign-control.mjs';
import { runSingleCondition } from '../../tools/agentic-eval/matrix-runner.mjs';

const roots = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const writeJson = (path, value) => { const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); writeFileSync(path, bytes); return hash(bytes); };
const now = Date.parse('2026-09-11T10:00:00.000Z');

function plan() {
  const labels = ['A', 'B', 'B', 'A', 'A', 'B'];
  const conditions = ['current-skill', 'no-skill', 'no-skill', 'current-skill', 'current-skill', 'no-skill'];
  return {
    campaign_design_id: 'codex-product-vs-free-baseline-v1', planned_sessions: 6,
    cells: labels.map((label, order_index) => ({
      order_index, repetition_index: Math.floor(order_index / 2), campaign_cell_label: label,
      campaign_design_id: 'codex-product-vs-free-baseline-v1', condition: conditions[order_index],
      execution_profile_id: 'sandboxed-unrestricted-v1',
      product_access_mode: label === 'A' ? 'product-assisted' : 'free-baseline-no-product',
    })),
  };
}

function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'e1-final-control-')); roots.push(root);
  const campaignId = randomUUID(); const groupRunId = randomUUID();
  const authorizationSha = hash(Buffer.from(FINAL_CODEX_AUTHORIZATION_LITERAL));
  const scopeDigest = hash(Buffer.from([
    'evidence1-final-codex-v1', authorizationSha, 'exactly-six-codex-sessions', '6',
    'no-retry-no-replacement-no-respawn',
  ].join('\n')));
  const globalClaim = { schema: 1, kind: 'evidence1-final-codex-global-authorization-claim',
    authorization_sha256: authorizationSha, authorized_sessions: 6, authorization_scope: 'exactly-six-codex-sessions',
    retry_count: 0, replacement_authorized: false, respawn_authorized: false,
    vm_name: 'Evidence1-Runner-E2E', vm_id: '6e5848f5-37dd-4653-9f3d-df2871e6293a', model: 'gpt-5.6-terra',
    readiness_sha256: '1'.repeat(64), remote_auth_sha256: '2'.repeat(64), scope_digest: scopeDigest, claimed_at_utc: '2026-09-11T09:56:00.000Z' };
  const globalPath = join(root, 'global.authorization.claim.json'); const globalSha = writeJson(globalPath, globalClaim);
  const binding = {
    schema: 1, kind: 'evidence1-final-codex-campaign-binding', campaign_id: campaignId,
    group_run_id: groupRunId, campaign_design_id: 'codex-product-vs-free-baseline-v1', authorized_sessions: 6,
    runtime_id: 'codex-cli', cli_version: '0.154.0', model_requested: 'gpt-5.6-terra', model_resolved: 'gpt-5.6-terra',
    vm_name: 'Evidence1-Runner-E2E', vm_id: '6e5848f5-37dd-4653-9f3d-df2871e6293a',
    scenario_id: 'coverage-threshold-failure-v2', seed: 20260910,
    readiness_sha256: '1'.repeat(64), guest_readiness_sha256: 'a'.repeat(64), readiness_generated_at_utc: '2026-09-11T09:50:00.000Z',
    remote_auth_sha256: '2'.repeat(64), remote_auth_completed_at_utc: '2026-09-11T09:55:00.000Z',
    remote_auth_operation_id: randomUUID(),
    not_before_utc: '2026-09-11T09:45:00.000Z', source_commit: '3'.repeat(40), harness_commit: '4'.repeat(40), harness_tree: 'e'.repeat(40),
    isolation_attestation_sha256: '5'.repeat(64), execution_profile_id: 'sandboxed-unrestricted-v1',
    execution_profile_sha256: '6'.repeat(64), skill_source_commit: '7'.repeat(40),
    skill_snapshot_sha256: '8'.repeat(64), toolchain_sha256: '9'.repeat(64), created_at_utc: '2026-09-11T09:56:00.000Z',
    script_sha256: { launcher: 'a'.repeat(64), wrapper: 'b'.repeat(64), validation_helper: 'c'.repeat(64), campaign_control: 'd'.repeat(64), pilot_describe: 'f'.repeat(64), publication_scan: '0'.repeat(64) },
    global_authorization_claim_sha256: globalSha,
    ...overrides,
  };
  const bindingPath = join(root, 'binding.json'); const bindingSha = writeJson(bindingPath, binding);
  const auth = {
    schema: 1, kind: 'evidence1-final-codex-authorization-claim', campaign_id: campaignId, group_run_id: groupRunId,
    binding_sha256: bindingSha, authorization_sha256: hash(Buffer.from(FINAL_CODEX_AUTHORIZATION_LITERAL)),
    authorized_sessions: 6, authorization_scope: 'exactly-six-codex-sessions', retry_count: 0,
    replacement_authorized: false, respawn_authorized: false, created_at_utc: '2026-09-11T09:56:00.000Z',
    global_authorization_claim_sha256: globalSha,
  };
  const authPath = join(root, 'authorization.claim.json'); const authSha = writeJson(authPath, auth);
  return { root, binding, env: {
    KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_BINDING: bindingPath,
    KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_BINDING_SHA256: bindingSha,
    KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_AUTH_CLAIM: authPath,
    KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_AUTH_CLAIM_SHA256: authSha,
    KMP_AGENTIC_EVAL_FINAL_GLOBAL_AUTH_CLAIM: globalPath,
    KMP_AGENTIC_EVAL_FINAL_GLOBAL_AUTH_CLAIM_SHA256: globalSha,
  } };
}

describe('final Codex campaign control', () => {
  it('is inert for historical and Claude invocations', () => {
    expect(createFinalCampaignControlFromEnv({ env: {}, campaignPlan: {}, runtimeId: 'claude-code', model: 'x' })).toBeNull();
  });

  it('creates a closed group claim and six CreateNew slot/plan claims in A,B,B,A,A,B order', () => {
    const f = fixture();
    const control = createFinalCampaignControlFromEnv({ env: f.env, campaignPlan: plan(), runtimeId: 'codex-cli', model: 'gpt-5.6-terra', now: () => now });
    for (const cell of plan().cells) control.beforeCellSpawn(cell);
    expect(JSON.parse(readFileSync(join(f.root, 'group.claim.json'))).planned_sessions).toBe(6);
    expect(plan().cells.map((_, i) => JSON.parse(readFileSync(join(f.root, 'slots', String(i), 'plan.claim.json'))).campaign_cell_label)).toEqual(['A', 'B', 'B', 'A', 'A', 'B']);
  });

  it('burns a slot before spawn and rejects replay/respawn', () => {
    const f = fixture();
    const control = createFinalCampaignControlFromEnv({ env: f.env, campaignPlan: plan(), runtimeId: 'codex-cli', model: 'gpt-5.6-terra', now: () => now });
    control.beforeCellSpawn(plan().cells[0]);
    expect(() => control.beforeCellSpawn(plan().cells[0])).toThrowError('campaign_claim_already_exists_or_write_failed');
    expect(() => createFinalCampaignControlFromEnv({ env: f.env, campaignPlan: plan(), runtimeId: 'codex-cli', model: 'gpt-5.6-terra', now: () => now })).toThrowError('campaign_claim_already_exists_or_write_failed');
  });

  it.each([
    ['wrong model', { model_resolved: null }, 'campaign_binding_invalid'],
    ['wrong cli', { cli_version: '0.153.5' }, 'campaign_binding_invalid'],
    ['stale readiness', { readiness_generated_at_utc: '2026-09-11T08:00:00.000Z' }, 'campaign_readiness_or_auth_stale'],
  ])('rejects %s before any group claim', (_label, override, code) => {
    const f = fixture(override);
    expect(() => createFinalCampaignControlFromEnv({ env: f.env, campaignPlan: plan(), runtimeId: 'codex-cli', model: 'gpt-5.6-terra', now: () => now })).toThrowError(code);
  });

  it('rejects a substituted or partially written binding by its closed hash', () => {
    const f = fixture();
    writeFileSync(f.env.KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_BINDING, '{');
    expect(() => createFinalCampaignControlFromEnv({ env: f.env, campaignPlan: plan(), runtimeId: 'codex-cli', model: 'gpt-5.6-terra', now: () => now })).toThrowError('campaign_binding_read_failed');
  });

  it('rejects a valid authorization blob substituted at a different path', () => {
    const f = fixture(); const substitute = join(f.root, 'authorization-copy.json');
    copyFileSync(f.env.KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_AUTH_CLAIM, substitute);
    f.env.KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_AUTH_CLAIM = substitute;
    expect(() => createFinalCampaignControlFromEnv({ env: f.env, campaignPlan: plan(), runtimeId: 'codex-cli', model: 'gpt-5.6-terra', now: () => now })).toThrowError('campaign_authorization_claim_path_mismatch');
  });

  it('rejects a self-consistent global claim whose VM identity differs from the binding', () => {
    const f = fixture();
    const globalClaim = JSON.parse(readFileSync(f.env.KMP_AGENTIC_EVAL_FINAL_GLOBAL_AUTH_CLAIM));
    globalClaim.vm_id = '11111111-1111-4111-8111-111111111111';
    const globalSha = writeJson(f.env.KMP_AGENTIC_EVAL_FINAL_GLOBAL_AUTH_CLAIM, globalClaim);
    f.env.KMP_AGENTIC_EVAL_FINAL_GLOBAL_AUTH_CLAIM_SHA256 = globalSha;
    const binding = JSON.parse(readFileSync(f.env.KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_BINDING));
    binding.global_authorization_claim_sha256 = globalSha;
    const bindingSha = writeJson(f.env.KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_BINDING, binding);
    f.env.KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_BINDING_SHA256 = bindingSha;
    const auth = JSON.parse(readFileSync(f.env.KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_AUTH_CLAIM));
    auth.binding_sha256 = bindingSha; auth.global_authorization_claim_sha256 = globalSha;
    f.env.KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_AUTH_CLAIM_SHA256 = writeJson(f.env.KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_AUTH_CLAIM, auth);
    expect(() => createFinalCampaignControlFromEnv({ env: f.env, campaignPlan: plan(), runtimeId: 'codex-cli', model: 'gpt-5.6-terra', now: () => now })).toThrowError('global_authorization_claim_invalid');
  });

  it('rejects hard-linked custody inputs rather than trusting mutable aliases', () => {
    const f = fixture(); const original = f.env.KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_BINDING;
    const alias = join(f.root, 'binding-alias.json'); linkSync(original, alias);
    f.env.KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_BINDING = alias;
    expect(() => createFinalCampaignControlFromEnv({ env: f.env, campaignPlan: plan(), runtimeId: 'codex-cli', model: 'gpt-5.6-terra', now: () => now })).toThrowError('campaign_binding_read_failed');
  });

  it('fake-runtime crash proves the durable callback is the last operation before provider spawn', async () => {
    const f = fixture(); const fixtureDir = join(f.root, 'fixture'); const home = join(f.root, 'home');
    const events = [];
    const adapter = {
      id: 'codex-cli', protocolVersion: 1,
      capabilities: { observationSources: ['fake'], structuredTranscript: true, correlatedToolResults: true, skillDeliveryModes: [], skillStateEvidence: true, usageDimensions: ['input'], softPermissionDenial: true },
      supportsModelConfiguration() { return true; }, supportsExecutionProfile() { return true; },
      async probeInstallation() { return {}; }, async preflight() { return { ok: true }; },
      async prepareIsolatedHome() { return { sharedEnv: {}, settingsPath: null, cleanupPaths: [] }; },
      prepareSkillDelivery() { events.push('prepare'); return { argv: [], stdinText: 'test prompt' }; }, buildInvocation() { return []; },
      async collectObservationSources() { events.push('spawn'); throw new Error('synthetic_provider_crash'); },
      normalizeObservations() { throw new Error('unreachable'); }, redactRuntimeDiagnostics(value) { return value; },
    };
    const control = createFinalCampaignControlFromEnv({ env: f.env, campaignPlan: plan(), runtimeId: 'codex-cli', model: 'gpt-5.6-terra', now: () => now });
    await expect(runSingleCondition({
      condition: 'current-skill', materializeFixture: () => { mkdirSync(fixtureDir); return { fixtureDir }; },
      cleanupFixtureOnce() {}, resetGradleToSnapshot() {}, kmpEvalTempHome: home, sharedEnv: {}, baseArgv: [],
      snapshotDir: f.root, targetPluginName: 'kmp-test-runner', targetSkillName: 'kmp-test-runner',
      timeoutMs: 100, cellOrdinal: 0, runtimeAdapter: adapter,
      executionProfile: { policy_mode: 'not_applicable' }, productAccessMode: 'product-assisted',
      beforeSpawn: () => { control.beforeCellSpawn(plan().cells[0]); events.push('claim'); },
    })).rejects.toThrow('synthetic_provider_crash');
    expect(events).toEqual(['prepare', 'claim', 'spawn']);
    expect(JSON.parse(readFileSync(join(f.root, 'slots', '0', 'slot.claim.json'))).sessions_consumed).toBe(1);
  });
});

// SPDX-License-Identifier: MIT
// Durable, opt-in control plane for the closed six-session Evidence1 Codex pilot.
// The normal harness path is unchanged unless KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_BINDING is set.
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const DESIGN = 'codex-product-vs-free-baseline-v1';
const ORDER = Object.freeze(['A', 'B', 'B', 'A', 'A', 'B']);
const CONDITIONS = Object.freeze(['current-skill', 'no-skill', 'no-skill', 'current-skill', 'current-skill', 'no-skill']);
const REPS = Object.freeze([0, 0, 1, 1, 2, 2]);
const AUTHORIZATION = 'AUTORIZO EXACTAMENTE 6 SESIONES CODEX: 3 PRODUCT Y 3 FREE-BASELINE; SIN REINTENTOS, REEMPLAZOS NI RESPAWNS.';
const AUTHORIZATION_SHA256 = createHash('sha256').update(AUTHORIZATION, 'utf8').digest('hex');
const SHA256 = /^[0-9a-f]{64}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class FinalCampaignControlError extends Error {
  constructor(code) { super(code); this.name = 'FinalCampaignControlError'; this.code = code; }
}
const fail = (code) => { throw new FinalCampaignControlError(code); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const plain = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

function readClosedJson(path, expectedSha, code) {
  if (typeof path !== 'string' || !isAbsolute(path) || !SHA256.test(expectedSha)) fail(code);
  const absolute = resolve(path);
  let cursor = absolute;
  try {
    if (realpathSync.native(absolute).toLowerCase() !== absolute.toLowerCase()) fail(code);
    while (true) {
      if (lstatSync(cursor).isSymbolicLink()) fail(code);
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
  } catch { fail(code); }
  let bytes; let fd;
  try {
    const before = lstatSync(absolute);
    if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024) fail(code);
    fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) fail(code);
    bytes = readFileSync(fd);
    const after = fstatSync(fd); const pathAfter = lstatSync(absolute);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== bytes.length
      || after.mtimeMs !== opened.mtimeMs || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino
      || pathAfter.size !== bytes.length || pathAfter.nlink !== 1) fail(code);
  } catch { fail(code); }
  finally { if (fd !== undefined) closeSync(fd); }
  if (sha256(bytes) !== expectedSha) fail(code);
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!plain(value)) fail(code);
    return value;
  } catch { fail(code); }
}

function writeCreateNew(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  mkdirSync(dirname(path), { recursive: true });
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeSync(fd, bytes);
    fsyncSync(fd);
  } catch { fail('campaign_claim_already_exists_or_write_failed'); }
  finally { if (fd !== undefined) closeSync(fd); }
  return sha256(bytes);
}

const BINDING_KEYS = Object.freeze([
  'schema', 'kind', 'campaign_id', 'group_run_id', 'campaign_design_id', 'authorized_sessions',
  'runtime_id', 'cli_version', 'model_requested', 'model_resolved', 'vm_name', 'vm_id',
  'scenario_id', 'seed', 'readiness_sha256', 'guest_readiness_sha256', 'readiness_generated_at_utc', 'remote_auth_sha256',
  'remote_auth_completed_at_utc', 'remote_auth_operation_id', 'not_before_utc', 'source_commit', 'harness_commit', 'harness_tree',
  'isolation_attestation_sha256', 'execution_profile_id', 'execution_profile_sha256',
  'skill_source_commit', 'skill_snapshot_sha256', 'toolchain_sha256',
  'script_sha256', 'global_authorization_claim_sha256', 'created_at_utc',
]);
const AUTH_KEYS = Object.freeze([
  'schema', 'kind', 'campaign_id', 'group_run_id', 'binding_sha256', 'authorization_sha256',
  'authorized_sessions', 'authorization_scope', 'retry_count', 'replacement_authorized',
  'respawn_authorized', 'global_authorization_claim_sha256', 'created_at_utc',
]);
const GLOBAL_AUTH_KEYS = Object.freeze([
  'schema', 'kind', 'authorization_sha256', 'authorized_sessions', 'authorization_scope',
  'retry_count', 'replacement_authorized', 'respawn_authorized', 'vm_name', 'vm_id',
  'model', 'readiness_sha256', 'remote_auth_sha256', 'scope_digest', 'claimed_at_utc',
]);
const SCRIPT_KEYS = Object.freeze([
  'launcher', 'wrapper', 'validation_helper', 'campaign_control', 'pilot_describe', 'publication_scan',
]);

function parseUtc(value, code) {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail(code);
  return time;
}

function validateBinding(binding, bindingSha, auth, nowMs) {
  if (!exactKeys(binding, BINDING_KEYS) || binding.schema !== 1 || binding.kind !== 'evidence1-final-codex-campaign-binding'
    || !GUID.test(binding.campaign_id) || !GUID.test(binding.group_run_id)
    || binding.campaign_design_id !== DESIGN || binding.authorized_sessions !== 6
    || binding.runtime_id !== 'codex-cli' || binding.cli_version !== '0.154.0'
    || binding.model_requested !== 'gpt-5.6-terra' || binding.model_resolved !== 'gpt-5.6-terra'
    || typeof binding.vm_name !== 'string' || binding.vm_name.length === 0 || !GUID.test(binding.vm_id)
    || binding.scenario_id !== 'coverage-threshold-failure-v2' || !Number.isSafeInteger(binding.seed)
    || !SHA256.test(binding.readiness_sha256) || !SHA256.test(binding.guest_readiness_sha256)
    || !SHA256.test(binding.remote_auth_sha256)
    || !GUID.test(binding.remote_auth_operation_id)
    || !SHA1.test(binding.source_commit) || !SHA1.test(binding.harness_commit) || !SHA1.test(binding.harness_tree)
    || !SHA256.test(binding.isolation_attestation_sha256)
    || binding.execution_profile_id !== 'sandboxed-unrestricted-v1'
    || !SHA256.test(binding.execution_profile_sha256) || !SHA1.test(binding.skill_source_commit)
    || !SHA256.test(binding.skill_snapshot_sha256) || !SHA256.test(binding.toolchain_sha256)
    || !exactKeys(binding.script_sha256, SCRIPT_KEYS)
    || SCRIPT_KEYS.some((key) => !SHA256.test(binding.script_sha256[key]))) fail('campaign_binding_invalid');
  if (!SHA256.test(binding.global_authorization_claim_sha256)) fail('campaign_binding_invalid');
  const notBefore = parseUtc(binding.not_before_utc, 'campaign_binding_time_invalid');
  const readiness = parseUtc(binding.readiness_generated_at_utc, 'campaign_binding_time_invalid');
  const remoteAuth = parseUtc(binding.remote_auth_completed_at_utc, 'campaign_binding_time_invalid');
  const created = parseUtc(binding.created_at_utc, 'campaign_binding_time_invalid');
  if (readiness < notBefore || remoteAuth < notBefore || nowMs - readiness > 60 * 60_000
    || nowMs - remoteAuth > 30 * 60_000 || readiness > nowMs + 60_000 || remoteAuth > nowMs + 60_000
    || created < readiness || created < remoteAuth || created > nowMs + 60_000) {
    fail('campaign_readiness_or_auth_stale');
  }
  if (!exactKeys(auth, AUTH_KEYS) || auth.schema !== 1 || auth.kind !== 'evidence1-final-codex-authorization-claim'
    || auth.campaign_id !== binding.campaign_id || auth.group_run_id !== binding.group_run_id
    || auth.binding_sha256 !== bindingSha || auth.authorization_sha256 !== AUTHORIZATION_SHA256
    || auth.authorized_sessions !== 6 || auth.authorization_scope !== 'exactly-six-codex-sessions'
    || auth.retry_count !== 0 || auth.replacement_authorized !== false || auth.respawn_authorized !== false) {
    fail('campaign_authorization_claim_invalid');
  }
  if (auth.global_authorization_claim_sha256 !== binding.global_authorization_claim_sha256) fail('campaign_authorization_claim_invalid');
  if (parseUtc(auth.created_at_utc, 'campaign_authorization_claim_invalid') !== created) {
    fail('campaign_authorization_claim_invalid');
  }
}

export function createFinalCampaignControlFromEnv({ env = process.env, campaignPlan, runtimeId, model, now = () => Date.now() }) {
  const bindingPath = env.KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_BINDING;
  if (bindingPath == null || bindingPath === '') return null;
  const bindingSha = env.KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_BINDING_SHA256;
  const authPath = env.KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_AUTH_CLAIM;
  const authSha = env.KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_AUTH_CLAIM_SHA256;
  const globalClaimPath = env.KMP_AGENTIC_EVAL_FINAL_GLOBAL_AUTH_CLAIM;
  const globalClaimSha = env.KMP_AGENTIC_EVAL_FINAL_GLOBAL_AUTH_CLAIM_SHA256;
  const binding = readClosedJson(bindingPath, bindingSha, 'campaign_binding_read_failed');
  if (resolve(authPath) !== join(dirname(resolve(bindingPath)), 'authorization.claim.json')) {
    fail('campaign_authorization_claim_path_mismatch');
  }
  const auth = readClosedJson(authPath, authSha, 'campaign_authorization_claim_read_failed');
  const globalClaim = readClosedJson(globalClaimPath, globalClaimSha, 'global_authorization_claim_read_failed');
  const nowMs = now();
  if (!exactKeys(globalClaim, GLOBAL_AUTH_KEYS)) fail('global_authorization_claim_invalid');
  const expectedScopeDigest = sha256(Buffer.from([
    'evidence1-final-codex-v1', AUTHORIZATION_SHA256, 'exactly-six-codex-sessions', '6',
    'no-retry-no-replacement-no-respawn',
  ].join('\n'), 'utf8'));
  if (globalClaimSha !== binding.global_authorization_claim_sha256
    || globalClaim.schema !== 1 || globalClaim.kind !== 'evidence1-final-codex-global-authorization-claim'
    || globalClaim.authorization_sha256 !== AUTHORIZATION_SHA256 || globalClaim.authorized_sessions !== 6
    || globalClaim.authorization_scope !== 'exactly-six-codex-sessions' || globalClaim.retry_count !== 0
    || globalClaim.replacement_authorized !== false || globalClaim.respawn_authorized !== false
    || globalClaim.vm_name !== binding.vm_name || globalClaim.vm_id !== binding.vm_id
    || globalClaim.model !== 'gpt-5.6-terra' || globalClaim.readiness_sha256 !== binding.readiness_sha256
    || globalClaim.remote_auth_sha256 !== binding.remote_auth_sha256
    || globalClaim.scope_digest !== expectedScopeDigest) {
    fail('global_authorization_claim_invalid');
  }
  const globalClaimedAt = parseUtc(globalClaim.claimed_at_utc, 'global_authorization_claim_invalid');
  if (globalClaimedAt < Date.parse(binding.readiness_generated_at_utc)
    || globalClaimedAt < Date.parse(binding.remote_auth_completed_at_utc)
    || globalClaimedAt > Date.parse(binding.created_at_utc) || globalClaimedAt > nowMs + 60_000) {
    fail('global_authorization_claim_invalid');
  }
  validateBinding(binding, bindingSha, auth, nowMs);
  if (runtimeId !== binding.runtime_id || model !== binding.model_requested
    || campaignPlan?.campaign_design_id !== binding.campaign_design_id
    || campaignPlan?.planned_sessions !== 6 || campaignPlan?.cells?.length !== 6) fail('campaign_plan_binding_mismatch');
  for (let index = 0; index < 6; index += 1) {
    const cell = campaignPlan.cells[index];
    if (cell.order_index !== index || cell.campaign_cell_label !== ORDER[index]
      || cell.condition !== CONDITIONS[index] || cell.repetition_index !== REPS[index]
      || cell.execution_profile_id !== binding.execution_profile_id) fail('campaign_plan_binding_mismatch');
  }

  const operationRoot = dirname(resolve(bindingPath));
  const groupClaim = {
    schema: 1, kind: 'evidence1-final-codex-group-claim', campaign_id: binding.campaign_id,
    group_run_id: binding.group_run_id, binding_sha256: bindingSha, authorization_claim_sha256: authSha,
    authorized_sessions: 6, planned_sessions: 6, retry_count: 0, replacement_authorized: false,
    respawn_authorized: false, created_at_utc: new Date(now()).toISOString(),
  };
  const groupClaimSha256 = writeCreateNew(join(operationRoot, 'group.claim.json'), groupClaim);

  return {
    binding, bindingSha256: bindingSha, groupClaimSha256,
    beforeCellSpawn(planCell) {
      const index = planCell?.order_index;
      if (!Number.isInteger(index) || index < 0 || index >= 6
        || planCell.campaign_cell_label !== ORDER[index] || planCell.condition !== CONDITIONS[index]
        || planCell.repetition_index !== REPS[index]) fail('campaign_slot_plan_mismatch');
      const slotDir = join(operationRoot, 'slots', String(index));
      const claimedAt = new Date(now()).toISOString();
      const slotSha256 = writeCreateNew(join(slotDir, 'slot.claim.json'), {
        schema: 1, kind: 'evidence1-final-codex-slot-claim', campaign_id: binding.campaign_id,
        group_run_id: binding.group_run_id, binding_sha256: bindingSha, group_claim_sha256: groupClaimSha256,
        order_index: index, campaign_cell_label: ORDER[index], condition: CONDITIONS[index],
        repetition_index: REPS[index], sessions_consumed: 1, retry_count: 0,
        replacement_authorized: false, respawn_authorized: false, claimed_at_utc: claimedAt,
      });
      writeCreateNew(join(slotDir, 'plan.claim.json'), {
        schema: 1, kind: 'evidence1-final-codex-plan-claim', campaign_id: binding.campaign_id,
        group_run_id: binding.group_run_id, binding_sha256: bindingSha, slot_claim_sha256: slotSha256,
        order_index: index, campaign_cell_label: ORDER[index], condition: CONDITIONS[index],
        repetition_index: REPS[index], execution_profile_id: binding.execution_profile_id,
        runtime_id: binding.runtime_id, cli_version: binding.cli_version,
        model_requested: binding.model_requested, model_resolved_required: binding.model_resolved,
        claimed_at_utc: claimedAt,
      });
    },
  };
}

export const FINAL_CODEX_AUTHORIZATION_LITERAL = AUTHORIZATION;

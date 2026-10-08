import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { deriveRoundOrder } from './derive-round-order-cli.mjs';
import { validateRun } from './schemas.mjs';
import { validateAcceptedRunAuditSidecar, crossValidateAcceptedRunAuditAgainstRecord } from './accepted-run-audit.mjs';
import { scanClosure } from './transcript-access-scan.mjs';
import { classifyCampaign } from './infra-flake-classifier.mjs';
import { qualifiesForStrictD3Negative } from './campaign-summary.mjs';

const RUNTIMES = Object.freeze({ 'claude-code': 'claude-sonnet-5', 'codex-cli': 'gpt-5.6-terra' });
const DESIGN = Object.freeze({ 'claude-code': 'claude-product-vs-free-n8-v1', 'codex-cli': 'codex-product-vs-free-n8-v1' });
const VM_ID = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14';
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const GUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sameSet = (actual, expected) => actual.length === expected.length
  && new Set(actual).size === actual.length && new Set(expected).size === expected.length
  && actual.every((v) => expected.includes(v));
const armFor = (condition) => condition === 'current-skill' ? 'product' : condition === 'no-skill' ? 'free' : null;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const samePath = (a, b) => typeof a === 'string' && resolve(a).toLowerCase() === resolve(b).toLowerCase();

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function numericUsage(usage, runtime) {
  if (usage?.source !== 'runtime-reported') return false;
  const required = runtime === 'codex-cli' ? ['input', 'cached_input', 'output'] : ['input', 'cached_input', 'cache_write', 'output'];
  return required.every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
    && (runtime !== 'codex-cli' || usage.cached_input <= usage.input)
    && (runtime !== 'codex-cli' || usage.cache_write === null);
}
function safeReceipt(receipt, state, id) {
  return receipt?.schema === 1 && receipt.campaign_id === id && receipt.state === state
    && receipt.verdict === 'PASS' && receipt.reason_code === '';
}
function safeClosure(receipt, vmId) {
  const vm = receipt?.detail?.vm_result;
  const network = receipt?.detail?.network_result;
  return vm?.verdict === 'PASS' && vm.vm_id === vmId && vm.state === 'Off' && vm.vhd_attached === false
    && network?.verdict === 'PASS' && network.vm_id === vmId && network.mode === 'offline'
    && network.adapter_connected === false && network.firewall_default_outbound === 'Block'
    && network.watchdog_armed === false;
}
function stateAllowed(paths, runtime) {
  return Array.isArray(paths) && (runtime === 'codex-cli'
    ? paths.length === 0 || (paths.length === 1 && paths[0] === 'config.toml')
    : paths.length === 0);
}

/**
 * Prospective Evidence5 revised4 block gate. `expected` is the separately pinned identity, not a
 * value inferred from the closure: campaign_id, manifest_sha256, source_commit, project_commit,
 * skill_source_sha, scenario_id and seed are mandatory. A returned `block_eligible` means that
 * this original eight-position attempt may enter the merged analysis. It is not VM readiness,
 * budget approval, independent review, or authorization to start another process.
 *
 * The original nested EvidenceCopied eligibility is preserved in the result. Its single allowed
 * FAIL shape is explained by authentic rejected cells; no rejected cell is turned into an
 * accepted record. Missing classifications require complete usage for the block to proceed.
 */
export function evaluateE5R4Block({ blockDir, expected }) {
  const reasons = [];
  const fail = (reason) => { reasons.push(reason); };
  const result = { schema: 1, campaign_id: expected?.campaign_id ?? null, block_eligible: false,
    reasons, cells: [], counts: { scheduled: 8, accepted: 0, negative_d3: 0, missing: 0 },
    original_eligibility: null, limitations: [] };
  if (typeof blockDir !== 'string' || !isObject(expected) || !GUID.test(expected.campaign_id ?? '')
    || !SHA256.test(expected.manifest_sha256 ?? '') || !SHA1.test(expected.source_commit ?? '')
    || !SHA1.test(expected.project_commit ?? '') || !SHA1.test(expected.skill_source_sha ?? '')
    || expected.scenario_id !== 'changed-dependents-network-topic' || expected.seed !== 20261006
    || (expected.vm_id !== undefined && expected.vm_id !== VM_ID)) {
    fail('expected_identity_invalid'); return result;
  }
  const vmId = expected.vm_id ?? VM_ID;
  let manifest, live, copied, closed, custody;
  try {
    const bytes = readFileSync(join(blockDir, 'manifest.json'));
    if (sha(bytes) !== expected.manifest_sha256) fail('manifest_digest_mismatch');
    manifest = JSON.parse(bytes);
    live = readJson(join(blockDir, 'readiness', 'LiveRunning.receipt.json'));
    copied = readJson(join(blockDir, 'readiness', 'EvidenceCopied.receipt.json'));
    closed = readJson(join(blockDir, 'readiness', 'Closed.receipt.json'));
    custody = readJson(join(blockDir, 'private', 'raw-custody.json'));
  } catch { fail('closure_evidence_unreadable'); return result; }
  const id = expected.campaign_id;
  if (manifest?.campaign_id !== id || manifest.provider_mode !== 'live'
    || manifest.scenario_id !== expected.scenario_id || manifest.seed !== expected.seed
    || manifest.execution_profile_id !== 'sandboxed-unrestricted-v1'
    || manifest.max_session_count !== 8 || manifest.no_automatic_provider_retry !== true
    || !Array.isArray(manifest.round_order) || manifest.round_order.length !== 4
    || !Array.isArray(manifest.runtimes) || manifest.runtimes.length !== 2) fail('manifest_identity_invalid');
  if (!samePath(manifest.output_roots?.private, join(blockDir, 'private'))
    || !samePath(manifest.output_roots?.public, join(blockDir, 'public'))
    || typeof manifest.vm_name !== 'string' || manifest.vm_name.length === 0) fail('manifest_storage_or_vm_identity_invalid');
  const runtimeById = new Map((manifest.runtimes ?? []).map((r) => [r.runtime_id, r]));
  if (!sameSet([...runtimeById.keys()], Object.keys(RUNTIMES))) fail('manifest_runtime_set_invalid');
  const expectedKeys = [];
  const positions = [];
  for (const [runtimeId, modelId] of Object.entries(RUNTIMES)) {
    const runtime = runtimeById.get(runtimeId);
    const indices = runtime?.campaign_cell_indices;
    if (runtime?.model_id !== modelId || runtime.campaign_design_id !== DESIGN[runtimeId]
      || !Array.isArray(indices) || indices.length !== 4 || new Set(indices).size !== 4
      || !indices.every((i) => Number.isInteger(i) && i >= 0 && i < 16)) {
      fail(`manifest_runtime_invalid:${runtimeId}`); continue;
    }
    const start = Math.floor(indices[0] / 4) * 4;
    if (!indices.every((index, local) => index === start + local)) fail(`manifest_indices_invalid:${runtimeId}`);
    const order = deriveRoundOrder({ designId: DESIGN[runtimeId], campaignCellIndices: indices,
      executionProfiles: [manifest.execution_profile_id] });
    if (!order.ok || JSON.stringify(order.round_order) !== JSON.stringify(manifest.round_order)) fail(`manifest_order_invalid:${runtimeId}`);
    indices.forEach((index, local) => {
      const key = `${runtimeId}-${index}`;
      expectedKeys.push(key);
      positions.push({ key, runtimeId, modelId, index, local, arm: manifest.round_order[local] });
    });
  }
  if (positions.length !== 8 || positions.filter((p) => p.runtimeId === 'claude-code').some((p, i) => p.index !== positions[i + 4]?.index)
    || !manifest.round_order.every((a) => a === 'product' || a === 'free')) fail('manifest_positions_invalid');
  if (!safeReceipt(live, 'LiveRunning', id) || !Array.isArray(live.detail?.sessions) || live.detail.sessions.length !== 8) fail('live_receipt_invalid');
  if (!safeReceipt(copied, 'EvidenceCopied', id) || !safeClosure(copied, vmId)
    || !samePath(copied.detail?.private_root, join(blockDir, 'private'))
    || copied.detail?.vm_result?.vm_name !== manifest.vm_name
    || copied.detail?.network_result?.vm_name !== manifest.vm_name
    || !Array.isArray(copied.detail?.copy_results) || copied.detail.copy_results.length !== 8) fail('copy_receipt_invalid');
  if (!safeReceipt(closed, 'Closed', id) || !safeClosure(closed, vmId)
    || closed.detail?.vm_result?.vm_name !== manifest.vm_name
    || closed.detail?.network_result?.vm_name !== manifest.vm_name
    || closed.detail?.publication_result?.verdict !== 'PASS'
    || closed.detail.publication_result.state !== 'committed'
    || !samePath(closed.detail.publication_result.private_root, join(blockDir, 'private'))
    || !samePath(closed.detail.publication_result.public_root, join(blockDir, 'public'))) fail('closed_receipt_invalid');
  result.original_eligibility = copied.detail?.eligibility ?? null;
  if (custody?.campaign_id !== id || !Array.isArray(custody.cells) || custody.cells.length !== 8) fail('raw_custody_index_invalid');
  for (const tier of ['private', 'public', 'raw']) {
    try {
      const entries = readdirSync(join(blockDir, tier), { withFileTypes: true });
      const keys = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      if (!sameSet(keys, expectedKeys) || entries.some((e) => !e.isDirectory() && !(tier === 'private' && e.name === 'raw-custody.json')))
        fail(`${tier}_cell_set_invalid`);
    } catch { fail(`${tier}_cell_set_unreadable`); }
  }
  let scan, infra;
  try { scan = scanClosure(blockDir); infra = classifyCampaign(blockDir); }
  catch { fail('access_or_infra_scan_failed'); }
  if (scan?.campaign_id !== id || !Array.isArray(scan.cells) || scan.cells.length !== 8) fail('access_scan_incomplete');
  if (!Array.isArray(infra?.cells) || infra.cells.length !== 8) fail('infra_scan_incomplete');

  const runIds = new Set();
  for (const p of positions) {
    const cellReasons = [];
    const cellFail = (reason) => { cellReasons.push(reason); fail(`${p.key}:${reason}`); };
    const liveMatches = (live.detail?.sessions ?? []).filter((s) => s.runtime_id === p.runtimeId && s.round_index === p.local);
    const copyMatches = (copied.detail?.copy_results ?? []).filter((c) => c.cell_key === p.key);
    const custodyMatches = (custody.cells ?? []).filter((c) => c.cell_key === p.key);
    const accessMatches = (scan?.cells ?? []).filter((c) => c.cell_key === p.key);
    const infraMatches = (infra?.cells ?? []).filter((c) => c.cell_key === p.key);
    if (liveMatches.length !== 1 || liveMatches[0].verdict !== 'PASS' || liveMatches[0].model_id !== p.modelId) cellFail('live_session_invalid');
    if (copyMatches.length !== 1 || copyMatches[0].resume_action !== 'copy') cellFail('copy_position_invalid');
    if (custodyMatches.length !== 1 || custodyMatches[0].order_index !== p.index || custodyMatches[0].arm !== p.arm) cellFail('custody_position_invalid');
    if (accessMatches.length !== 1 || accessMatches[0].scanned !== true || !Array.isArray(accessMatches[0].hits)
      || accessMatches[0].hits.length !== 0) cellFail('access_scan_hit_or_unknown');
    if (infraMatches.length !== 1 || infraMatches[0].infra_flake_suspected !== false
      || infraMatches[0].runtime_id !== p.runtimeId || infraMatches[0].arm !== p.arm) cellFail('infra_hit_or_unknown');
    const dir = join(blockDir, 'private', p.key);
    const pub = join(blockDir, 'public', p.key);
    let files = [], publicFiles = [], raw;
    try {
      files = readdirSync(dir).sort(); publicFiles = readdirSync(pub).sort();
      raw = readFileSync(join(dir, 'transcript.jsonl'));
      if (custodyMatches[0]?.raw_bytes !== raw.length || custodyMatches[0]?.raw_sha256 !== sha(raw)) cellFail('raw_custody_mismatch');
      if (sha(readFileSync(join(blockDir, 'raw', p.key, 'transcript.jsonl'))) !== sha(raw)) cellFail('raw_source_mismatch');
    } catch { cellFail('cell_files_unreadable'); }
    const accepted = files.includes('record.json') && files.includes('audit.json') && !files.includes('rejection.json');
    const rejected = files.includes('rejection.json') && !files.includes('record.json') && !files.includes('audit.json');
    if (!accepted && !rejected) cellFail('cell_evidence_shape_invalid');
    if (!sameSet(files, accepted ? ['record.json', 'audit.json', 'transcript.jsonl']
      : ['rejection.json', 'transcript.jsonl'])) cellFail('cell_extra_or_missing_file');
    if (!sameSet(publicFiles, accepted ? ['record.json', 'audit.json'] : ['rejection.json'])) cellFail('public_evidence_shape_invalid');
    for (const file of publicFiles) {
      try { if (sha(readFileSync(join(dir, file))) !== sha(readFileSync(join(pub, file)))) cellFail('public_private_mismatch'); }
      catch { cellFail('public_private_unreadable'); }
    }
    if (copyMatches[0]?.benchmark_status !== (accepted ? 'accepted' : 'rejected')
      || !sameSet(copyMatches[0]?.result?.files_copied ?? [], accepted ? ['record.json', 'audit.json'] : ['rejection.json'])
      || liveMatches[0]?.output_summary?.benchmark_status !== (accepted ? 'accepted' : 'rejected')
      || custodyMatches[0]?.status !== (accepted ? 'accepted' : 'rejected')) cellFail('receipt_cell_status_mismatch');
    let status = 'missing';
    if (accepted) {
      try {
        const record = readJson(join(dir, 'record.json'));
        const auditBytes = readFileSync(join(dir, 'audit.json'));
        const audit = JSON.parse(auditBytes);
        if (validateRun(record).errors.length || validateAcceptedRunAuditSidecar(audit, { family: record.family }).errors.length
          || crossValidateAcceptedRunAuditAgainstRecord(audit, record).length || record.accepted_audit?.sha256 !== sha(auditBytes)) cellFail('accepted_pair_invalid');
        if (record.campaign_id !== id || record.order_index !== p.index || armFor(record.condition) !== p.arm
          || record.agent_runtime?.runtime_id !== p.runtimeId || record.model_resolved !== p.modelId
          || record.scenario_id !== expected.scenario_id || record.seed !== expected.seed
          || record.repo_commit !== expected.source_commit || record.kmp_test_cli_source_sha !== expected.source_commit
          || record.project_commit !== expected.project_commit
          || record.skill_source_sha !== (p.arm === 'product' ? expected.skill_source_sha : null)
          || record.execution_profile?.id !== manifest.execution_profile_id) cellFail('accepted_identity_invalid');
        if (record.stream_json_bytes?.value !== raw?.length) cellFail('accepted_raw_bytes_mismatch');
        if (!numericUsage(record.usage, p.runtimeId)) cellFail('usage_unknown');
        if (!stateAllowed(record.agent_state?.context_relevant_changed, p.runtimeId)
          || !stateAllowed(custodyMatches[0]?.agent_state_relevant_changed, p.runtimeId)
          || JSON.stringify(record.agent_state?.context_relevant_changed) !== JSON.stringify(custodyMatches[0]?.agent_state_relevant_changed)) cellFail('state_exception_invalid');
        if (typeof record.run_id !== 'string' || !record.run_id || runIds.has(record.run_id)) cellFail('run_id_invalid_or_duplicate');
        else runIds.add(record.run_id);
        status = 'accepted';
      } catch { cellFail('accepted_evidence_unreadable'); }
    } else if (rejected) {
      try {
        const diagnostic = readJson(join(dir, 'rejection.json'));
        const cell = diagnostic.cells?.[0];
        if (!isObject(cell) || diagnostic.cells.length !== 1 || diagnostic.schema !== 13
          || diagnostic.run_kind !== 'scenario' || !Array.isArray(diagnostic.run_ids)
          || diagnostic.run_ids.length !== 1 || diagnostic.run_ids[0] !== cell.run_id
          || diagnostic.planned_cell_count !== 1 || diagnostic.executed_cell_count !== 1
          || !GUID.test(diagnostic.rejection_id ?? '')
          || diagnostic.repo_commit !== expected.source_commit || diagnostic.scenario_id !== expected.scenario_id
          || diagnostic.seed !== expected.seed || diagnostic.project_commit !== expected.project_commit
          || diagnostic.execution_profile_id !== manifest.execution_profile_id || diagnostic.raw_transcripts_persisted !== true
          || cell.order_index !== p.index || armFor(cell.condition) !== p.arm
          || cell.model_resolved !== p.modelId || cell.skill_source_sha !== (p.arm === 'product' ? expected.skill_source_sha : null)
          || liveMatches[0]?.output_summary?.rejection_id !== diagnostic.rejection_id) cellFail('rejection_identity_invalid');
        if (!numericUsage(cell.cell_metrics?.usage, p.runtimeId)) cellFail('usage_unknown');
        if (!Array.isArray(cell.failed_checks) || cell.failed_checks.some((check) =>
          /policy|access|unexpected|foreign.skill|isolation|state/i.test(check))
          || cell.unexpected_tool_uses_count !== 0
          || cell.foreign_skill_summary?.rejected !== 0
          || cell.foreign_skill_summary?.confirmed !== 0
          || cell.foreign_skill_summary?.incomplete !== 0
          || diagnostic.policy_mode !== 'not_applicable'
          || diagnostic.ambient_profile_matrix_ok !== true) cellFail('rejection_policy_or_access_invalid');
        if (typeof cell.run_id !== 'string' || !cell.run_id || runIds.has(cell.run_id)) cellFail('run_id_invalid_or_duplicate');
        else runIds.add(cell.run_id);
        const listed = custodyMatches[0]?.agent_state_relevant_changed;
        if (listed !== null && !stateAllowed(listed, p.runtimeId)) cellFail('state_exception_invalid');
        if (cell.agent_state != null
          && (!isObject(cell.agent_state)
            || !stateAllowed(cell.agent_state.context_relevant_changed, p.runtimeId))) cellFail('state_exception_invalid');
        if (listed === null) result.limitations.push(`${p.key}: rejected-cell state listing unavailable`);
        if (qualifiesForStrictD3Negative(p.runtimeId, cell, join(dir, 'transcript.jsonl'))) status = 'negative-d3';
      } catch { cellFail('rejection_evidence_unreadable'); }
    }
    result.counts[status.replace('-', '_')] += 1;
    result.cells.push({ cell_key: p.key, runtime_id: p.runtimeId, arm: p.arm, order_index: p.index,
      status, original_status: accepted ? 'accepted' : rejected ? 'rejected' : 'invalid', reasons: cellReasons });
  }
  const eligibility = copied.detail?.eligibility;
  const acceptedCount = result.counts.accepted;
  if (!Array.isArray(eligibility?.runtimes)
    || !sameSet(eligibility.runtimes.map((r) => r.runtime_id), Object.keys(RUNTIMES)))
    fail('nested_eligibility_runtime_set_invalid');
  const promoted = (eligibility?.runtimes ?? []).reduce((n, runtime) => n + runtime.promoted_count, 0);
  const fullPass = eligibility?.verdict === 'PASS' && eligibility.eligible === true
    && eligibility.promoted_count === 8 && acceptedCount === 8
    && eligibility.runtimes?.length === 2 && eligibility.runtimes.every((r) => r.eligible === true && r.promoted_count === 4);
  const mixedFail = eligibility?.verdict === 'FAIL' && eligibility.reason_code === 'runtime_ineligible'
    && eligibility.eligible === false && result.counts.missing + result.counts.negative_d3 > 0
    && eligibility.runtimes?.length === 2 && eligibility.runtimes.every((r) => {
      const rejectedCount = result.cells.filter((c) => c.runtime_id === r.runtime_id && c.original_status === 'rejected').length;
      return RUNTIMES[r.runtime_id] && r.eligible === (rejectedCount === 0)
        && r.promoted_count === (rejectedCount === 0 ? 4 : 0)
        && r.reason_code === (rejectedCount === 0 ? null : 'runtime_has_rejected_cells');
    }) && eligibility.promoted_count === promoted;
  if (eligibility?.cell_count !== 8 || !(fullPass || mixedFail)) fail('nested_eligibility_unexplained');
  if (result.cells.length !== 8 || result.counts.accepted + result.counts.negative_d3 + result.counts.missing !== 8) fail('position_accounting_invalid');
  result.block_eligible = reasons.length === 0;
  return result;
}

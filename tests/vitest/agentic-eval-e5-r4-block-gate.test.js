import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluateE5R4Block } from '../../tools/agentic-eval/e5-r4-block-gate.mjs';
import { acceptedRecord, sidecarFor } from './_agentic-eval-campaign-cell-fixtures.js';
import { validateRun } from '../../tools/agentic-eval/schemas.mjs';
import { validateAcceptedRunAuditSidecar, crossValidateAcceptedRunAuditAgainstRecord } from '../../tools/agentic-eval/accepted-run-audit.mjs';

const ID = '11111111-2222-4333-8444-555555555555';
const SOURCE = 'be8d850455bdac7a653ff24794777b2f96d7958c';
const PROJECT = '7d45eae4f8720a0c77f507712ba2437ff974b6ed';
const SKILL = '2112aed96686ee159f851e00c2efa553e58473fc';
const VM = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const rmRoots = [];
afterEach(() => { for (const root of rmRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function makeBlock() {
  const root = mkdtempSync(join(tmpdir(), 'e5r4-block-'));
  rmRoots.push(root);
  for (const tier of ['private', 'public', 'raw', 'readiness']) mkdirSync(join(root, tier));
  const order = ['product', 'free', 'free', 'product'];
  const manifest = {
    schema: 1, campaign_id: ID, provider_mode: 'live', scenario_id: 'changed-dependents-network-topic', seed: 20261006,
    execution_profile_id: 'sandboxed-unrestricted-v1', round_order: order, max_session_count: 8,
    no_automatic_provider_retry: true, private_root: 'C:\\Evidence1Private\\test-block',
    vm_name: 'Evidence1-Runner-E2E', output_roots: { private: join(root, 'private'), public: join(root, 'public') },
    runtimes: [
      { runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-n8-v1', campaign_cell_indices: [0, 1, 2, 3] },
      { runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-n8-v1', campaign_cell_indices: [0, 1, 2, 3] },
    ],
  };
  json(join(root, 'manifest.json'), manifest);
  const expected = { campaign_id: ID, manifest_sha256: hash(readFileSync(join(root, 'manifest.json'))),
    source_commit: SOURCE, project_commit: PROJECT, skill_source_sha: SKILL,
    scenario_id: manifest.scenario_id, seed: manifest.seed, vm_id: VM };
  const safe = { vm_result: { verdict: 'PASS', vm_id: VM, vm_name: manifest.vm_name, state: 'Off', vhd_attached: false },
    network_result: { verdict: 'PASS', vm_id: VM, vm_name: manifest.vm_name, mode: 'offline', adapter_connected: false,
      firewall_default_outbound: 'Block', watchdog_armed: false } };
  const live = { schema: 1, campaign_id: ID, state: 'LiveRunning', verdict: 'PASS', reason_code: '', detail: { sessions: [] } };
  const copied = { schema: 1, campaign_id: ID, state: 'EvidenceCopied', verdict: 'PASS', reason_code: '',
    detail: { ...safe, private_root: join(root, 'private'), copy_results: [], eligibility: { verdict: 'PASS', eligible: true, cell_count: 8,
      promoted_count: 8, runtimes: Object.keys({ 'claude-code': 1, 'codex-cli': 1 }).map((runtime_id) =>
        ({ runtime_id, eligible: true, promoted_count: 4, reason_code: null })) } } };
  const closed = { schema: 1, campaign_id: ID, state: 'Closed', verdict: 'PASS', reason_code: '',
    detail: { ...safe, publication_result: { verdict: 'PASS', state: 'committed',
      private_root: join(root, 'private'), public_root: join(root, 'public') } } };
  const custody = { campaign_id: ID, cells: [] };
  for (const runtimeId of ['claude-code', 'codex-cli']) {
    for (let index = 0; index < 4; index++) {
      const key = `${runtimeId}-${index}`;
      const arm = order[index];
      const condition = arm === 'product' ? 'current-skill' : 'no-skill';
      const privateDir = join(root, 'private', key);
      const publicDir = join(root, 'public', key);
      const rawDir = join(root, 'raw', key);
      mkdirSync(privateDir); mkdirSync(publicDir); mkdirSync(rawDir);
      const raw = Buffer.from(`${JSON.stringify({ type: 'test', key })}\n`);
      const record = acceptedRecord({ runId: `run-${key}`, runtimeId, condition, roundIndex: index });
      if (runtimeId === 'codex-cli') {
        record.usage.cache_write = null;
        record.tokens.cache_creation = { value: null, reason: 'runtime-does-not-report-cache-write' };
      }
      record.campaign_id = ID; record.scenario_id = manifest.scenario_id; record.seed = manifest.seed;
      record.stream_json_bytes = { value: raw.length, reason: null };
      record.agent_state = { context_relevant_changed: runtimeId === 'codex-cli' ? ['config.toml'] : [] };
      const audit = sidecarFor(record);
      const auditBytes = Buffer.from(JSON.stringify(audit, null, 2));
      record.accepted_audit = { schema: 10, relative_path: `audit/${record.run_id}.json`, sha256: hash(auditBytes) };
      // Both validators run on real schema-conformant record/audit material before the gate sees it.
      expect(validateRun(record).errors).toEqual([]);
      expect(validateAcceptedRunAuditSidecar(audit, { family: record.family }).errors).toEqual([]);
      expect(crossValidateAcceptedRunAuditAgainstRecord(audit, record)).toEqual([]);
      writeFileSync(join(privateDir, 'audit.json'), auditBytes);
      writeFileSync(join(publicDir, 'audit.json'), auditBytes);
      json(join(privateDir, 'record.json'), record);
      json(join(publicDir, 'record.json'), record);
      writeFileSync(join(privateDir, 'transcript.jsonl'), raw);
      writeFileSync(join(rawDir, 'transcript.jsonl'), raw);
      custody.cells.push({ cell_key: key, order_index: index, arm, status: 'accepted', raw_bytes: raw.length,
        raw_sha256: hash(raw), agent_state_relevant_changed: record.agent_state.context_relevant_changed });
      live.detail.sessions.push({ runtime_id: runtimeId, round_index: index, model_id: record.model_resolved,
        verdict: 'PASS', output_summary: { benchmark_status: 'accepted', rejection_id: null } });
      copied.detail.copy_results.push({ cell_key: key, benchmark_status: 'accepted', resume_action: 'copy',
        result: { files_copied: ['audit.json', 'record.json'] } });
    }
  }
  json(join(root, 'readiness', 'LiveRunning.receipt.json'), live);
  json(join(root, 'readiness', 'EvidenceCopied.receipt.json'), copied);
  json(join(root, 'readiness', 'Closed.receipt.json'), closed);
  json(join(root, 'private', 'raw-custody.json'), custody);
  return { root, expected };
}

function rejectCell(root, key, { usage = true, d3 = true } = {}) {
  const privateDir = join(root, 'private', key);
  const publicDir = join(root, 'public', key);
  rmSync(join(privateDir, 'record.json'));
  rmSync(join(privateDir, 'audit.json'));
  rmSync(join(publicDir, 'record.json'));
  rmSync(join(publicDir, 'audit.json'));
  const record = acceptedRecord({ runId: `run-${key}`, runtimeId: key.split(/-(?=\d+$)/)[0],
    condition: [0, 3].includes(Number(key.at(-1))) ? 'current-skill' : 'no-skill', roundIndex: Number(key.at(-1)) });
  record.usage.cache_write = null;
  const diagnostic = { schema: 13, rejection_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    run_kind: 'scenario', run_ids: [`run-${key}`], planned_cell_count: 1, executed_cell_count: 1,
    repo_commit: SOURCE, scenario_id: 'changed-dependents-network-topic', seed: 20261006,
    project_commit: PROJECT, execution_profile_id: 'sandboxed-unrestricted-v1', policy_mode: 'not_applicable',
    raw_transcripts_persisted: true,
    ambient_profile_matrix_ok: true,
    cells: [{ run_id: `run-${key}`, order_index: Number(key.at(-1)), condition: record.condition,
      model_resolved: record.model_resolved, skill_source_sha: record.skill_source_sha,
      failed_checks: d3 ? ['hookAccountingOk', 'toolResultsCompleteOk'] : ['toolResultsCompleteOk'],
      unexpected_tool_uses_count: 0, foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
      correlation_observability: { policy_mode: 'not_applicable',
        tool_use_counts_by_kind: { shell: 3, skill: 0, other: 0 },
        missing_id_counts_by_kind: { shell: 0, skill: 0, other: 0 },
        missing_result_counts_by_kind: { shell: 1, skill: 0, other: 0 },
        correlation_issue_counts: { duplicate_tool_use_id: 0, orphan_tool_result_missing_id: 0,
          orphan_tool_result_unknown_id: 0, duplicate_tool_result: 0, malformed_stream_line: 0 },
        dispatch_status_counts: { pre_dispatch_blocked: 0, unclassified: 0, unaccounted: 1 } },
      pre_inference_failure: { terminal_present: true, terminal_result_subtype: 'success',
        terminal_is_error: false, terminal_turn_count: 1, tool_attempt_count: 3 },
      cell_metrics: { usage: usage ? { source: 'runtime-reported', input: 400,
        cached_input: 0, cache_write: null, output: 100 } : null } }] };
  if (d3) {
    const events = [
      { type: 'thread.started' },
      { type: 'item.started', item: { type: 'command_execution', id: 'item_1' } },
      { type: 'item.completed', item: { type: 'command_execution', id: 'item_1' } },
      { type: 'item.started', item: { type: 'command_execution', id: 'item_2' } },
      { type: 'item.started', item: { type: 'command_execution', id: 'item_3' } },
      { type: 'item.completed', item: { type: 'command_execution', id: 'item_3' } },
      { type: 'turn.completed', usage: { input_tokens: 400, cached_input_tokens: 0,
        cache_write_input_tokens: 0, output_tokens: 100 } },
    ];
    const bytes = Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    writeFileSync(join(privateDir, 'transcript.jsonl'), bytes);
    writeFileSync(join(root, 'raw', key, 'transcript.jsonl'), bytes);
  }
  json(join(privateDir, 'rejection.json'), diagnostic);
  json(join(publicDir, 'rejection.json'), diagnostic);
  const custody = read(join(root, 'private', 'raw-custody.json'));
  const cell = custody.cells.find((c) => c.cell_key === key);
  cell.status = 'rejected'; cell.agent_state_relevant_changed = null;
  const raw = readFileSync(join(privateDir, 'transcript.jsonl'));
  cell.raw_bytes = raw.length; cell.raw_sha256 = hash(raw);
  json(join(root, 'private', 'raw-custody.json'), custody);
  const live = read(join(root, 'readiness', 'LiveRunning.receipt.json'));
  const session = live.detail.sessions.find((s) => s.runtime_id === key.split(/-(?=\d+$)/)[0] && s.round_index === Number(key.at(-1)));
  session.output_summary = { benchmark_status: 'rejected', rejection_id: diagnostic.rejection_id };
  json(join(root, 'readiness', 'LiveRunning.receipt.json'), live);
  const copied = read(join(root, 'readiness', 'EvidenceCopied.receipt.json'));
  const copy = copied.detail.copy_results.find((c) => c.cell_key === key);
  copy.benchmark_status = 'rejected'; copy.result.files_copied = ['rejection.json'];
  copied.detail.eligibility = { verdict: 'FAIL', reason_code: 'runtime_ineligible', eligible: false,
    cell_count: 8, promoted_count: 4, runtimes: [
      { runtime_id: 'claude-code', eligible: true, promoted_count: 4, reason_code: null },
      { runtime_id: 'codex-cli', eligible: false, promoted_count: 0, reason_code: 'runtime_has_rejected_cells' },
    ] };
  json(join(root, 'readiness', 'EvidenceCopied.receipt.json'), copied);
}

const gate = ({ root, expected }) => evaluateE5R4Block({ blockDir: root, expected });

describe('Evidence5 revised4 block gate', () => {
  it('accepts eight original record/audit pairs and a full PASS receipt', () => {
    const result = gate(makeBlock());
    expect(result.reasons).toEqual([]);
    expect(result.block_eligible).toBe(true);
    expect(result.counts).toEqual({ scheduled: 8, accepted: 8, negative_d3: 0, missing: 0 });
  });
  it('keeps original FAIL/runtime_ineligible and counts only strict D3 rejection', () => {
    const block = makeBlock(); rejectCell(block.root, 'codex-cli-0');
    const result = gate(block);
    expect(result.block_eligible).toBe(true);
    expect(result.original_eligibility.verdict).toBe('FAIL');
    expect(result.counts).toEqual({ scheduled: 8, accepted: 7, negative_d3: 1, missing: 0 });
    expect(result.cells.find((c) => c.cell_key === 'codex-cli-0').original_status).toBe('rejected');
  });
  it('classifies a complete-use non-D3 rejection as missing without making an accepted record', () => {
    const block = makeBlock(); rejectCell(block.root, 'codex-cli-0', { d3: false });
    const result = gate(block);
    expect(result.block_eligible).toBe(true);
    expect(result.counts).toEqual({ scheduled: 8, accepted: 7, negative_d3: 0, missing: 1 });
  });
  it.each([
    ['failed copy receipt', (root) => { const path = join(root, 'readiness', 'EvidenceCopied.receipt.json'); const doc = read(path); doc.verdict = 'FAIL'; json(path, doc); }, 'copy_receipt_invalid'],
    ['unknown rejected usage', (root) => rejectCell(root, 'codex-cli-0', { usage: false }), 'usage_unknown'],
    ['raw custody mismatch', (root) => { const path = join(root, 'private', 'raw-custody.json'); const doc = read(path); doc.cells[0].raw_bytes += 1; json(path, doc); }, 'raw_custody_mismatch'],
    ['access hit', (root) => writeFileSync(join(root, 'private', 'claude-code-0', 'transcript.jsonl'), 'preregistration\n'), 'access_scan_hit_or_unknown'],
    ['unexplained state', (root) => { const path = join(root, 'private', 'raw-custody.json'); const doc = read(path); doc.cells[0].agent_state_relevant_changed = ['settings.json']; json(path, doc); }, 'state_exception_invalid'],
    ['infra signature', (root) => writeFileSync(join(root, 'private', 'claude-code-0', 'transcript.jsonl'), 'Gradle build daemon disappeared unexpectedly\n'), 'infra_hit_or_unknown'],
    ['bad source identity', (root) => { const path = join(root, 'private', 'claude-code-0', 'record.json'); const doc = read(path); doc.kmp_test_cli_source_sha = 'f'.repeat(40); json(path, doc); json(join(root, 'public', 'claude-code-0', 'record.json'), doc); }, 'accepted_identity_invalid'],
    ['duplicate eligibility runtime', (root) => { const path = join(root, 'readiness', 'EvidenceCopied.receipt.json'); const doc = read(path); doc.detail.eligibility.runtimes[1].runtime_id = 'claude-code'; json(path, doc); }, 'nested_eligibility_runtime_set_invalid'],
    ['malformed rejected state', (root) => { rejectCell(root, 'codex-cli-0'); const path = join(root, 'private', 'codex-cli-0', 'rejection.json'); const doc = read(path); doc.cells[0].agent_state = { context_relevant_changed: 'config.toml' }; json(path, doc); json(join(root, 'public', 'codex-cli-0', 'rejection.json'), doc); }, 'state_exception_invalid'],
    ['rejection run identity mismatch', (root) => { rejectCell(root, 'codex-cli-0'); const path = join(root, 'private', 'codex-cli-0', 'rejection.json'); const doc = read(path); doc.run_ids = ['other-run']; json(path, doc); json(join(root, 'public', 'codex-cli-0', 'rejection.json'), doc); }, 'rejection_identity_invalid'],
  ])('refuses %s', (_label, mutate, reason) => {
    const block = makeBlock(); mutate(block.root);
    const result = gate(block);
    expect(result.block_eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes(reason))).toBe(true);
  });
});

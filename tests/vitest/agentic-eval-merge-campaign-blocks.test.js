// tests/vitest/agentic-eval-merge-campaign-blocks.test.js
// Coverage for tools/agentic-eval/merge-campaign-blocks.mjs: a counterbalanced campaign run as separate block runs (each its own
// campaign id, cells keyed by their position inside the block) is merged into one closure-shaped directory (cells keyed by their
// campaign cell index, one manifest) that the analysis tools read unchanged. Synthetic closure directories only; no network.
//
// The pre-registered arm order of the n8 designs is written out below on purpose: the tool has to agree with it, not with itself.
import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeCampaignBlocks, mergedCampaignId } from '../../tools/agentic-eval/merge-campaign-blocks.mjs';
import { summarizeCampaign, renderMarkdown, loadCountedCellTokens } from '../../tools/agentic-eval/campaign-summary.mjs';
import { classifyCampaign } from '../../tools/agentic-eval/infra-flake-classifier.mjs';
import { scanClosure } from '../../tools/agentic-eval/transcript-access-scan.mjs';
import { acceptedRecord, sidecarFor, writeAcceptedCell } from './_agentic-eval-campaign-cell-fixtures.js';

const MERGE_SCRIPT = fileURLToPath(new URL('../../tools/agentic-eval/merge-campaign-blocks.mjs', import.meta.url));

const RUNTIMES = [
  { runtime_id: 'claude-code', model_id: 'claude-sonnet-5', campaign_design_id: 'claude-product-vs-free-n8-v1', max_budget_usd: 6 },
  { runtime_id: 'codex-cli', model_id: 'gpt-5.6-terra', campaign_design_id: 'codex-product-vs-free-n8-v1', max_budget_usd: null },
];
const ORDER_16 = ['product', 'free', 'free', 'product', 'free', 'product', 'product', 'free', 'free', 'product', 'product', 'free', 'product', 'free', 'free', 'product'];
const COMMIT = 'c3da7bec808f0e43c91ddbf90f7e4bfc3ab7665a';
const BLOCK_IDS = [
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444',
];
const LAYOUT_4 = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15]];
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const cleanup = [];
function tempRoot() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aemb-'));
  cleanup.push(dir);
  return dir;
}
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop(), { recursive: true, force: true });
});

const conditionOf = (global) => (ORDER_16[global] === 'product' ? 'current-skill' : 'no-skill');

/** The few record fields the merge tool reads, for the global cell `global` of `runtimeId`; the rest of a record is passed through untouched. */
function fakeRecord(runtimeId, global, overrides = {}) {
  return { ...acceptedRecord({ runId: `run-${runtimeId}-${global}`, runtimeId, condition: conditionOf(global), roundIndex: global, repoCommit: COMMIT }),
    kmp_test_cli_source_sha: COMMIT, ...overrides };
}

/** A block manifest shaped like the ones the run orchestrator takes: the fields a block legitimately changes are the id, the cell indices, the
 * round order, the session budget, the output roots and the generation time. */
function blockManifest(dir, campaignId, indices, k = 0) {
  return {
    schema: 1, campaign_id: campaignId,
    runtimes: RUNTIMES.map((runtime) => ({ ...runtime, campaign_cell_indices: [...indices] })),
    scenario_id: 'multi-module-test-failures', seed: 42, execution_profile_id: 'sandboxed-unrestricted-v1', conditions: ['product', 'free'],
    round_order: indices.map((index) => ORDER_16[index]), max_session_count: indices.length * RUNTIMES.length,
    vm_name: 'vm-under-test', private_root: 'C:\\Evidence1Private\\campaign-' + k,
    provider_timeout_seconds: 1800, worker_timeout_seconds: 1860, guest_transport_timeout_seconds: 1920,
    provider_mode: 'live', output_roots: { private: path.join(dir, 'private'), public: path.join(dir, 'public') },
    no_automatic_provider_retry: true, generated_at_utc: `2026-10-02T0${k}:00:00.000Z`,
  };
}

/** Writes block closures: one directory per entry of `layout` (the global cell indices that block ran), cells keyed by global index, like the closure
 * of a real block run. Hooks let a test break one thing: `manifest(k, m)` edits the manifest, `record(k, runtimeId, local, global, r)` edits a record
 * (return null to write a rejection instead), `skip(k, runtimeId, local)` leaves a cell directory out. */
function writeBlocks(root, { layout = LAYOUT_4, ids = BLOCK_IDS, manifest = () => {}, record = () => {}, skip = () => false, extraDirs = [] } = {}) {
  return layout.map((indices, k) => {
    const dir = path.join(root, `block-${k}`);
    mkdirSync(path.join(dir, 'private'), { recursive: true });
    const m = blockManifest(dir, ids[k], indices, k);
    manifest(k, m);
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
    writeFileSync(path.join(dir, 'Closed.receipt.json'), JSON.stringify({ schema: 1, campaign_id: m.campaign_id, state: 'Closed', verdict: 'PASS', reason_code: null, detail: {}, generated_at_utc: '2026-10-02T12:00:00.000Z' }));
    for (const runtime of RUNTIMES) {
      indices.forEach((global, local) => {
        if (skip(k, runtime.runtime_id, local)) return;
        const cellDir = path.join(dir, 'private', `${runtime.runtime_id}-${global}`);
        mkdirSync(cellDir, { recursive: true });
        const r = fakeRecord(runtime.runtime_id, global);
        const edited = record(k, runtime.runtime_id, local, global, r);
        if (edited === null) {
          writeFileSync(path.join(cellDir, 'rejection.json'), JSON.stringify({ repo_commit: COMMIT, cells: [{ order_index: global, condition: r.condition, repetition_index: r.repetition_index }] }));
        } else {
          const finalRecord = edited ?? r;
          const auditText = JSON.stringify(sidecarFor(finalRecord), null, 2);
          finalRecord.accepted_audit = { schema: 10, relative_path: `audit/${finalRecord.run_id}.json`, sha256: createHash('sha256').update(auditText, 'utf8').digest('hex') };
          writeFileSync(path.join(cellDir, 'record.json'), JSON.stringify(finalRecord));
          writeFileSync(path.join(cellDir, 'audit.json'), auditText);
          writeFileSync(path.join(cellDir, 'transcript.jsonl'), `{"type":"result","cell":"${runtime.runtime_id}-${global}"}\n`);
        }
      });
    }
    for (const name of extraDirs) mkdirSync(path.join(dir, 'private', name), { recursive: true });
    return dir;
  });
}

function mergeBlocks(blockDirs, out) {
  return mergeCampaignBlocks({ blockDirs, outDir: out });
}

/** The error a merge throws, so a test can pin its code. */
function mergeError(blockDirs, out) {
  try {
    mergeCampaignBlocks({ blockDirs, outDir: out });
  } catch (error) {
    return error;
  }
  throw new Error('the merge was expected to fail');
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const listDir = (dir) => readdirSync(dir).sort();

function schema9Record(record, campaignId) {
  return {
    ...record, schema: 9, campaign_id: campaignId,
    reasoning_effort_requested: 'high', reasoning_effort_source: 'harness-pinned-cli-flag',
    served_model_snapshot: { value: record.model_resolved, reason: null },
    argv_sha256: 'a'.repeat(64), delivered_prompt_sha256: 'b'.repeat(64),
    treatment_delivery_sha256: record.condition === 'current-skill'
      ? { value: 'c'.repeat(64), reason: null }
      : { value: null, reason: 'condition-no-skill' },
    env_keys: ['PATH', 'TEMP'], executed_commands: ['./gradlew :core:domain:test'],
    max_budget_usd: { value: 0.60, reason: null }, timeout_ms: 300000,
    result_subtype: { value: 'success', reason: null }, num_turns: { value: 3, reason: null },
    total_cost_usd: { value: null, reason: 'no_cost_reporting' },
  };
}

describe('mergeCampaignBlocks -- the merged directory', () => {
  it('writes one manifest of the whole campaign: every cell index, the full pre-registered order, 32 sessions, the blocks named in order', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const result = mergeBlocks(writeBlocks(root), out);
    const manifest = readJson(path.join(out, 'manifest.json'));
    expect(manifest.kind).toBe('merged-blocks');
    expect(manifest.block_campaign_ids).toEqual(BLOCK_IDS);
    expect(manifest.campaign_id).toMatch(GUID_RE);
    expect(BLOCK_IDS).not.toContain(manifest.campaign_id);
    expect(manifest.campaign_id).toBe(mergedCampaignId(BLOCK_IDS));
    expect(manifest.runtimes.map((r) => r.runtime_id)).toEqual(['claude-code', 'codex-cli']);
    for (const runtime of manifest.runtimes) expect(runtime.campaign_cell_indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(manifest.round_order).toEqual(ORDER_16);
    expect(manifest.max_session_count).toBe(32);
    expect(manifest.private_root).toBeNull();
    expect(manifest.block_private_roots).toEqual(BLOCK_IDS.map((campaign_id, k) => ({ campaign_id, private_root: 'C:\\Evidence1Private\\campaign-' + k })));
    expect(result.manifest).toEqual(manifest);
  });

  it('copies every other manifest field from the blocks and points the output roots at the merged directory', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    mergeBlocks(writeBlocks(root), out);
    const manifest = readJson(path.join(out, 'manifest.json'));
    const first = readJson(path.join(root, 'block-0', 'manifest.json'));
    for (const key of ['schema', 'scenario_id', 'seed', 'execution_profile_id', 'conditions', 'vm_name', 'provider_timeout_seconds', 'worker_timeout_seconds', 'guest_transport_timeout_seconds', 'provider_mode', 'no_automatic_provider_retry']) {
      expect(manifest[key]).toEqual(first[key]);
    }
    expect(manifest.runtimes.map(({ campaign_cell_indices: _ignored, ...rest }) => rest)).toEqual(RUNTIMES);
    expect(manifest.output_roots).toEqual({ private: path.join(path.resolve(out), 'private'), public: path.join(path.resolve(out), 'public') });
    expect(manifest.generated_at_utc).toBe('2026-10-02T03:00:00.000Z');
  });

  it('keys the merged cells by their campaign cell index and copies every file byte for byte, rejections included', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { record: (k, runtimeId, local) => (k === 1 && runtimeId === 'codex-cli' && local === 2 ? null : undefined) });
    mergeBlocks(blocks, out);
    const expectedCells = RUNTIMES.flatMap((r) => Array.from({ length: 16 }, (_, g) => `${r.runtime_id}-${g}`)).sort();
    expect(listDir(path.join(out, 'private'))).toEqual(expectedCells);
    LAYOUT_4.forEach((indices, k) => {
      for (const runtime of RUNTIMES) {
        indices.forEach((global, local) => {
          const from = path.join(blocks[k], 'private', `${runtime.runtime_id}-${global}`);
          const to = path.join(out, 'private', `${runtime.runtime_id}-${global}`);
          expect(listDir(to)).toEqual(listDir(from));
          for (const file of listDir(from)) expect(readFileSync(path.join(to, file)).equals(readFileSync(path.join(from, file)))).toBe(true);
        });
      }
    });
    expect(listDir(path.join(out, 'private', 'codex-cli-6'))).toEqual(['rejection.json']);
    expect(readJson(path.join(out, 'manifest.json')).block_private_roots).toEqual(BLOCK_IDS.map((campaign_id, k) => ({
      campaign_id, private_root: 'C:\\Evidence1Private\\campaign-' + k,
    })));
  });

  it('is deterministic: the same blocks merged twice give byte-identical manifests', () => {
    const root = tempRoot();
    const blocks = writeBlocks(root);
    mergeBlocks(blocks, path.join(root, 'one'));
    mergeBlocks(blocks, path.join(root, 'two'));
    const a = readFileSync(path.join(root, 'one', 'manifest.json'), 'utf8').replaceAll('one', 'X');
    const b = readFileSync(path.join(root, 'two', 'manifest.json'), 'utf8').replaceAll('two', 'X');
    expect(a).toBe(b);
  });

  it('merges two blocks of eight rounds', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    mergeBlocks(writeBlocks(root, { layout: [[0, 1, 2, 3, 4, 5, 6, 7], [8, 9, 10, 11, 12, 13, 14, 15]] }), out);
    const manifest = readJson(path.join(out, 'manifest.json'));
    expect(manifest.block_campaign_ids).toEqual(BLOCK_IDS.slice(0, 2));
    expect(manifest.round_order).toEqual(ORDER_16);
    expect(listDir(path.join(out, 'private'))).toHaveLength(32);
  });

  it('maps the cells by campaign cell index whatever order the blocks are given in', () => {
    const root = tempRoot();
    const blocks = writeBlocks(root);
    const reordered = [blocks[2], blocks[0], blocks[3], blocks[1]];
    mergeBlocks(reordered, path.join(root, 'merged'));
    const manifest = readJson(path.join(root, 'merged', 'manifest.json'));
    expect(manifest.block_campaign_ids).toEqual([BLOCK_IDS[2], BLOCK_IDS[0], BLOCK_IDS[3], BLOCK_IDS[1]]);
    expect(manifest.round_order).toEqual(ORDER_16);
    expect(readJson(path.join(root, 'merged', 'private', 'claude-code-9', 'record.json')).order_index).toBe(9);
    expect(manifest.generated_at_utc).toBe('2026-10-02T03:00:00.000Z');
  });

  it('writes an empty output directory that already exists', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    mkdirSync(out);
    mergeBlocks(writeBlocks(root), out);
    expect(existsSync(path.join(out, 'manifest.json'))).toBe(true);
  });
});

describe('mergedCampaignId', () => {
  it('is a stable GUID of the block ids in order', () => {
    expect(mergedCampaignId(BLOCK_IDS)).toMatch(GUID_RE);
    expect(mergedCampaignId(BLOCK_IDS)).toBe(mergedCampaignId([...BLOCK_IDS]));
    expect(mergedCampaignId([...BLOCK_IDS].reverse())).not.toBe(mergedCampaignId(BLOCK_IDS));
    expect(mergedCampaignId(BLOCK_IDS.slice(0, 3))).not.toBe(mergedCampaignId(BLOCK_IDS));
  });
});

describe('mergeCampaignBlocks -- it fails closed, one reason per check, and writes nothing', () => {
  function expectRefusal({ error, code, out }) {
    expect(error.code).toBe(code);
    expect(error.message.startsWith(`${code}`)).toBe(true);
    expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
  }

  it('refuses fewer than two blocks and more than four', () => {
    const root = tempRoot();
    const blocks = writeBlocks(root);
    const out = path.join(root, 'merged');
    expectRefusal({ error: mergeError([blocks[0]], out), code: 'block_count_out_of_range', out });
    const five = [...blocks, blocks[0]];
    expectRefusal({ error: mergeError(five, out), code: 'block_count_out_of_range', out });
  });

  it('refuses a block directory without a readable manifest', () => {
    const root = tempRoot();
    const blocks = writeBlocks(root);
    rmSync(path.join(blocks[2], 'manifest.json'));
    const out = path.join(root, 'merged');
    expectRefusal({ error: mergeError(blocks, out), code: 'block_manifest_unreadable', out });
  });

  it('refuses a manifest that is not live', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { manifest: (k, m) => { if (k === 1) m.provider_mode = 'fake'; } });
    expectRefusal({ error: mergeError(blocks, out), code: 'block_provider_mode_not_live', out });
  });

  it('refuses a block without a matching successful Closed receipt', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root);
    rmSync(path.join(blocks[1], 'Closed.receipt.json'));
    expectRefusal({ error: mergeError(blocks, out), code: 'block_closed_receipt_unreadable', out });
    writeFileSync(path.join(blocks[1], 'Closed.receipt.json'), JSON.stringify({ schema: 1, campaign_id: BLOCK_IDS[1], state: 'Closed', verdict: 'FAIL' }));
    expectRefusal({ error: mergeError(blocks, out), code: 'block_not_closed', out });
  });

  it('refuses an output directory inside any source block', () => {
    const root = tempRoot();
    const blocks = writeBlocks(root);
    const out = path.join(blocks[1], 'merged');
    expectRefusal({ error: mergeError(blocks, out), code: 'out_dir_inside_block', out });
  });

  it('refuses unsafe runtime IDs and indices before reading a cell path', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { manifest: (k, m) => { if (k === 1) m.runtimes[0].runtime_id = '../outside'; } });
    expectRefusal({ error: mergeError(blocks, out), code: 'block_manifest_unreadable', out });
    const second = writeBlocks(tempRoot(), { manifest: (k, m) => { if (k === 1) m.runtimes[0].campaign_cell_indices[0] = -1; } });
    expectRefusal({ error: mergeError(second, out), code: 'block_manifest_unreadable', out });
  });

  it('refuses two blocks that share a campaign id', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { ids: [BLOCK_IDS[0], BLOCK_IDS[0], BLOCK_IDS[2], BLOCK_IDS[3]] });
    expectRefusal({ error: mergeError(blocks, out), code: 'block_campaign_ids_not_unique', out });
  });

  it.each([
    ['scenario', 'scenario_id', (m) => { m.scenario_id = 'another-scenario'; }],
    ['provider timeout', 'provider_timeout_seconds', (m) => { m.provider_timeout_seconds = 1700; }],
    ['worker timeout', 'worker_timeout_seconds', (m) => { m.worker_timeout_seconds = 1800; }],
    ['guest transport timeout', 'guest_transport_timeout_seconds', (m) => { m.guest_transport_timeout_seconds = 1900; }],
    ['execution profile', 'execution_profile_id', (m) => { m.execution_profile_id = 'strict-policy-v1'; }],
    ['seed', 'seed', (m) => { m.seed = 43; }],
    ['model budget', 'runtimes.claude-code.max_budget_usd', (m) => { m.runtimes[0].max_budget_usd = 7; }],
    ['design', 'runtimes.codex-cli.campaign_design_id', (m) => { m.runtimes[1].campaign_design_id = 'codex-product-vs-free-baseline-v2'; }],
  ])('refuses blocks whose manifests differ in the %s', (_label, field, change) => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { manifest: (k, m) => { if (k === 2) change(m); } });
    const error = mergeError(blocks, out);
    expectRefusal({ error, code: 'block_manifests_differ', out });
    expect(error.message).toContain(field);
  });

  it.each([
    ['missing', undefined],
    ['outside the private parent', 'C:\\Temp\\campaign-2'],
    ['traversal', 'C:\\Evidence1Private\\campaign-2\\..\\other'],
    ['noncanonical separators', 'C:/Evidence1Private/campaign-2'],
    ['root itself', 'C:\\Evidence1Private'],
  ])('refuses a %s block private root', (_case, privateRoot) => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { manifest: (k, m) => { if (k === 2) m.private_root = privateRoot; } });
    expectRefusal({ error: mergeError(blocks, out), code: 'block_private_root_invalid', out });
  });

  it.each([
    ['same root', 'C:\\Evidence1Private\\campaign-0'],
    ['case alias', 'C:\\Evidence1Private\\CAMPAIGN-0'],
    ['nested root', 'C:\\Evidence1Private\\campaign-0\\child'],
  ])('refuses blocks with the %s', (_case, privateRoot) => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { manifest: (k, m) => { if (k === 2) m.private_root = privateRoot; } });
    expectRefusal({ error: mergeError(blocks, out), code: 'block_private_roots_overlap', out });
  });

  it('refuses a cell index that two blocks both ran', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { layout: [[0, 1, 2, 3], [3, 4, 5, 6], [8, 9, 10, 11], [12, 13, 14, 15]] });
    const error = mergeError(blocks, out);
    expectRefusal({ error, code: 'cell_indices_overlap', out });
    expect(error.message).toContain('index 3');
  });

  it('refuses a cell index no block ran', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { layout: [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14]] });
    const error = mergeError(blocks, out);
    expectRefusal({ error, code: 'cell_indices_gap', out });
    expect(error.message).toContain('index 15');
  });

  it('refuses a cell index outside the design', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { layout: [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 16]], record: (k, runtimeId, local, global, r) => ({ ...r, order_index: global }) });
    expectRefusal({ error: mergeError(blocks, out), code: 'block_cell_index_not_in_design', out });
  });

  it('refuses a block whose round order is not the pre-registered order of its cells', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { manifest: (k, m) => { if (k === 1) m.round_order = ['product', 'free', 'free', 'product']; } });
    expectRefusal({ error: mergeError(blocks, out), code: 'block_round_order_not_preregistered', out });
  });

  it('refuses records of two different harness commits', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { record: (k, runtimeId, local, global, r) => (k === 3 && local === 1 ? { ...r, repo_commit: 'b'.repeat(40) } : r) });
    expectRefusal({ error: mergeError(blocks, out), code: 'record_commit_mismatch', out });
  });

  it('refuses records of two different product commits', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { record: (k, runtimeId, local, global, r) => (k === 0 && local === 0 ? { ...r, kmp_test_cli_source_sha: 'b'.repeat(40) } : r) });
    expectRefusal({ error: mergeError(blocks, out), code: 'record_commit_mismatch', out });
  });

  it('refuses a rejection that names another harness commit', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { record: (k, runtimeId, local) => (k === 0 && runtimeId === 'claude-code' && local === 0 ? null : undefined) });
    const file = path.join(blocks[0], 'private', 'claude-code-0', 'rejection.json');
    writeFileSync(file, JSON.stringify({ ...readJson(file), repo_commit: 'b'.repeat(40) }));
    expectRefusal({ error: mergeError(blocks, out), code: 'record_commit_mismatch', out });
  });

  it('refuses a record whose seed is not the manifest seed', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { record: (k, runtimeId, local, global, r) => (k === 1 && local === 0 ? { ...r, seed: 7 } : r) });
    expectRefusal({ error: mergeError(blocks, out), code: 'record_seed_mismatch', out });
  });

  it('refuses a changed audit file before writing merged evidence', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root);
    const audit = path.join(blocks[1], 'private', 'claude-code-4', 'audit.json');
    writeFileSync(audit, `${readFileSync(audit, 'utf8')} `);
    expectRefusal({ error: mergeError(blocks, out), code: 'cell_custody_invalid', out });
  });

  it('binds schema-9 records to their source block campaign', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const valid = writeBlocks(root, { record: (k, runtimeId, local, global, record) =>
      k === 1 && runtimeId === 'claude-code' && local === 0 ? schema9Record(record, BLOCK_IDS[1]) : record });
    expect(mergeBlocks(valid, out).ok).toBe(true);
    const badRoot = tempRoot();
    const badOut = path.join(badRoot, 'merged');
    const wrong = writeBlocks(badRoot, { record: (k, runtimeId, local, global, record) =>
      k === 1 && runtimeId === 'claude-code' && local === 0 ? schema9Record(record, BLOCK_IDS[0]) : record });
    expectRefusal({ error: mergeError(wrong, badOut), code: 'record_campaign_mismatch', out: badOut });
  });

  it('refuses a record that is not the cell its position holds', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { record: (k, runtimeId, local, global, r) => (k === 2 && runtimeId === 'codex-cli' && local === 3 ? { ...r, order_index: 3 } : r) });
    const error = mergeError(blocks, out);
    expectRefusal({ error, code: 'record_index_mismatch', out });
    expect(error.message).toContain('codex-cli-11');
  });

  it('refuses a record whose condition is not the pre-registered arm of its cell', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { record: (k, runtimeId, local, global, r) => (k === 1 && local === 1 ? { ...r, condition: conditionOf(global) === 'current-skill' ? 'no-skill' : 'current-skill' } : r) });
    expectRefusal({ error: mergeError(blocks, out), code: 'record_condition_mismatch', out });
  });

  it('refuses a record whose repetition or product access is not the design plan\'s for its cell', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const repetition = writeBlocks(root, { record: (k, runtimeId, local, global, r) => (k === 1 && local === 1 ? { ...r, repetition_index: 6 } : r) });
    expectRefusal({ error: mergeError(repetition, out), code: 'record_plan_mismatch', out });
    const access = writeBlocks(tempRoot(), { record: (k, runtimeId, local, global, r) => (k === 1 && local === 1 ? { ...r, product_access_mode: 'product-visible-no-skill' } : r) });
    expectRefusal({ error: mergeError(access, out), code: 'record_plan_mismatch', out });
  });

  it('refuses a rejection that is not the cell its position holds', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { record: (k, runtimeId, local) => (k === 2 && runtimeId === 'claude-code' && local === 0 ? null : undefined) });
    const file = path.join(blocks[2], 'private', 'claude-code-8', 'rejection.json');
    const rejection = readJson(file);
    rejection.cells[0].order_index = 99;
    writeFileSync(file, JSON.stringify(rejection));
    expectRefusal({ error: mergeError(blocks, out), code: 'record_index_mismatch', out });
  });

  it('refuses the same run in two cells', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { record: (k, runtimeId, local, global, r) => (k === 3 && local === 3 && runtimeId === 'claude-code' ? { ...r, run_id: 'run-claude-code-0' } : r) });
    expectRefusal({ error: mergeError(blocks, out), code: 'duplicate_run_id', out });
  });

  it('refuses a block that lacks a cell directory', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { skip: (k, runtimeId, local) => k === 1 && runtimeId === 'codex-cli' && local === 2 });
    const error = mergeError(blocks, out);
    expectRefusal({ error, code: 'cell_directory_absent', out });
    expect(error.message).toContain('codex-cli-6');
  });

  it('refuses a cell directory the manifest does not name', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { extraDirs: ['claude-code-9'] });
    const error = mergeError(blocks, out);
    expectRefusal({ error, code: 'cell_directory_unexpected', out });
    expect(error.message).toContain('claude-code-9');
  });

  it('refuses a cell without a record and audit pair or a rejection', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root);
    rmSync(path.join(blocks[0], 'private', 'claude-code-1', 'audit.json'));
    expectRefusal({ error: mergeError(blocks, out), code: 'cell_evidence_missing', out });
  });

  it('refuses a design the harness does not know', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { manifest: (k, m) => { m.runtimes[0].campaign_design_id = 'claude-product-vs-free-n99-v1'; } });
    expectRefusal({ error: mergeError(blocks, out), code: 'block_design_unknown', out });
  });

  it('refuses a cell directory that holds both a record and a rejection, or something that is not a file', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const both = writeBlocks(root);
    writeFileSync(path.join(both[0], 'private', 'claude-code-1', 'rejection.json'), JSON.stringify({ cells: [{}] }));
    expectRefusal({ error: mergeError(both, out), code: 'cell_evidence_unrecognized', out });
    const nested = writeBlocks(tempRoot());
    mkdirSync(path.join(nested[0], 'private', 'claude-code-1', 'extra'));
    expectRefusal({ error: mergeError(nested, out), code: 'cell_evidence_unrecognized', out });
  });

  it('refuses a rejection that does not hold exactly one cell, and a record that is not an object', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { record: (k, runtimeId, local) => (k === 0 && runtimeId === 'claude-code' && local === 0 ? null : undefined) });
    writeFileSync(path.join(blocks[0], 'private', 'claude-code-0', 'rejection.json'), JSON.stringify({ repo_commit: COMMIT, cells: [] }));
    expectRefusal({ error: mergeError(blocks, out), code: 'cell_evidence_unreadable', out });
    const notObject = writeBlocks(tempRoot());
    writeFileSync(path.join(notObject[0], 'private', 'claude-code-1', 'record.json'), 'null');
    expectRefusal({ error: mergeError(notObject, out), code: 'cell_evidence_unreadable', out });
  });

  it('refuses a record that is not JSON', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root);
    writeFileSync(path.join(blocks[0], 'private', 'claude-code-1', 'record.json'), '{not json');
    expectRefusal({ error: mergeError(blocks, out), code: 'cell_evidence_unreadable', out });
  });

  it('refuses an output directory that is not empty and leaves it as it was', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    mkdirSync(out);
    writeFileSync(path.join(out, 'keep.txt'), 'keep');
    const error = mergeError(writeBlocks(root), out);
    expect(error.code).toBe('out_dir_not_empty');
    expect(readdirSync(out)).toEqual(['keep.txt']);
  });
});

describe('merge-campaign-blocks.mjs -- the command line', () => {
  it('merges the blocks it is given and prints one JSON line', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root);
    const run = spawnSync(process.execPath, [MERGE_SCRIPT, '--out', out, ...blocks], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    const printed = JSON.parse(run.stdout.trim());
    expect(printed).toMatchObject({ ok: true, block_campaign_ids: BLOCK_IDS, cells: 32 });
    expect(printed.campaign_id).toBe(readJson(path.join(out, 'manifest.json')).campaign_id);
  });

  it('prints the refusal code and exits 1 without writing anything', () => {
    const root = tempRoot();
    const out = path.join(root, 'merged');
    const blocks = writeBlocks(root, { layout: [[0, 1, 2, 3], [3, 4, 5, 6], [8, 9, 10, 11], [12, 13, 14, 15]] });
    const run = spawnSync(process.execPath, [MERGE_SCRIPT, '--out', out, ...blocks], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('error: cell_indices_overlap');
    expect(existsSync(out)).toBe(false);
  });

  it.each([[[]], [['--out']], [['--out', 'somewhere']], [['--out', 'somewhere', '--bogus', 'a', 'b']]])('prints the usage and exits 2 for %j', (args) => {
    const run = spawnSync(process.execPath, [MERGE_SCRIPT, ...args], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('usage: merge-campaign-blocks.mjs');
  });
});

// A real campaign directory of 32 schema-valid cells (the builders campaign-summary.mjs's own tests use), split into four block closures by
// copying each cell's files into the block's local position. Merging the blocks has to give back the original directory, cell for cell.
function buildSingleCampaign(root) {
  const dir = path.join(root, 'single');
  mkdirSync(path.join(dir, 'private'), { recursive: true });
  const manifest = blockManifest(dir, 'single-campaign-under-test', Array.from({ length: 16 }, (_, g) => g));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const runtime of RUNTIMES) {
    for (let g = 0; g < 16; g += 1) {
      const cellKey = `${runtime.runtime_id}-${g}`;
      writeAcceptedCell(dir, cellKey, { runtimeId: runtime.runtime_id, condition: conditionOf(g), roundIndex: g });
      let transcript = `{"type":"result","cell":"${cellKey}"}\n`;
      if (cellKey === 'codex-cli-9') transcript += '{"type":"tool_result","content":"Gradle build daemon disappeared unexpectedly"}\n';
      if (cellKey === 'claude-code-12') transcript += '{"type":"tool_result","content":"cat tools/agentic-eval/corpus/expected/x.json"}\n';
      writeFileSync(path.join(dir, 'private', cellKey, 'transcript.jsonl'), transcript);
    }
  }
  return dir;
}

function splitIntoBlocks(singleDir, root) {
  return LAYOUT_4.map((indices, k) => {
    const dir = path.join(root, `block-${k}`);
    mkdirSync(path.join(dir, 'private'), { recursive: true });
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(blockManifest(dir, BLOCK_IDS[k], indices, k), null, 2));
    writeFileSync(path.join(dir, 'Closed.receipt.json'), JSON.stringify({ schema: 1, campaign_id: BLOCK_IDS[k], state: 'Closed', verdict: 'PASS' }));
    for (const runtime of RUNTIMES) {
      indices.forEach((global, local) => {
        const from = path.join(singleDir, 'private', `${runtime.runtime_id}-${global}`);
        const to = path.join(dir, 'private', `${runtime.runtime_id}-${global}`);
        mkdirSync(to, { recursive: true });
        for (const file of readdirSync(from)) copyFileSync(path.join(from, file), path.join(to, file));
      });
    }
    return dir;
  });
}

describe('the analysis tools on a merged directory', () => {
  function mergedAndSingle() {
    const root = tempRoot();
    const single = buildSingleCampaign(root);
    const merged = path.join(root, 'merged');
    mergeBlocks(splitIntoBlocks(single, root), merged);
    return { single, merged };
  }

  it('summarizes four merged blocks exactly like the same 32 cells run as one campaign, the campaign id and the block ids aside', () => {
    const { single, merged } = mergedAndSingle();
    const a = summarizeCampaign(single);
    const b = summarizeCampaign(merged);
    expect(a.summary_status).toBe('ok');
    expect(b.summary_status).toBe('ok');
    expect(b.by_runtime_arm.map((g) => [g.runtime_id, g.arm, g.declared, g.accepted])).toEqual(a.by_runtime_arm.map((g) => [g.runtime_id, g.arm, g.declared, g.accepted]));
    expect(a.by_runtime_arm.reduce((sum, g) => sum + g.accepted, 0)).toBe(32);
    const { block_campaign_ids: blocks, ...mergedProvenance } = b.provenance;
    expect(blocks).toEqual(BLOCK_IDS);
    expect({ ...b, campaign_id: null, provenance: mergedProvenance }).toEqual({ ...a, campaign_id: null });
    expect(b.campaign_id).toBe(mergedCampaignId(BLOCK_IDS));
  });

  it('leaves a single campaign\'s summary without any block ids', () => {
    const { single } = mergedAndSingle();
    const summary = summarizeCampaign(single);
    expect(Object.keys(summary.provenance)).not.toContain('block_campaign_ids');
    expect(renderMarkdown(summary)).not.toContain('block_campaign_ids');
  });

  it('names the block campaigns in the rendered provenance', () => {
    const { merged } = mergedAndSingle();
    expect(renderMarkdown(summarizeCampaign(merged))).toContain(`- block_campaign_ids: ${BLOCK_IDS.join(', ')}`);
  });

  it('refuses a merged manifest that names no blocks', () => {
    const { merged } = mergedAndSingle();
    const file = path.join(merged, 'manifest.json');
    const manifest = readJson(file);
    for (const bad of [undefined, [], [''], 'not-an-array']) {
      const edited = { ...manifest };
      if (bad === undefined) delete edited.block_campaign_ids; else edited.block_campaign_ids = bad;
      writeFileSync(file, JSON.stringify(edited));
      expect(summarizeCampaign(merged)).toMatchObject({ summary_status: 'refused', reason_code: 'merged_manifest_invalid' });
    }
  });

  it('counts the same cells and tokens for the cost estimate', () => {
    const { single, merged } = mergedAndSingle();
    expect(loadCountedCellTokens(merged)).toEqual(loadCountedCellTokens(single));
    expect(loadCountedCellTokens(merged)).toHaveLength(32);
  });

  it('runs the infra-flake classifier unchanged on the merged directory', () => {
    const { single, merged } = mergedAndSingle();
    const flakes = classifyCampaign(merged);
    expect(flakes).toEqual(classifyCampaign(single));
    expect(flakes.cells.filter((c) => c.infra_flake_suspected === true).map((c) => c.cell_key)).toEqual(['codex-cli-9']);
    expect(flakes.cells).toHaveLength(32);
  });

  it('runs the transcript access scan unchanged on the merged directory', () => {
    const { single, merged } = mergedAndSingle();
    const scan = scanClosure(merged);
    expect(scan.cells).toEqual(scanClosure(single).cells);
    expect(scan.patterns).not.toContain('private_root');
    expect(scan.campaign_id).toBe(mergedCampaignId(BLOCK_IDS));
    expect(scan.cells.filter((c) => c.hits.length > 0).map((c) => c.cell_key)).toEqual(['claude-code-12']);
    expect(summarizeCampaign(merged, new Set(), { accessScan: scan }).cells.find((c) => c.cell_key === 'claude-code-12')).toBeUndefined();
  });

  it('still detects an isolated guest private path in merged transcripts', () => {
    const { merged } = mergedAndSingle();
    const transcript = path.join(merged, 'private', 'codex-cli-0', 'transcript.jsonl');
    writeFileSync(transcript, readFileSync(transcript, 'utf8') + 'C:\\Evidence1Private\\campaign-0\\codex-cli-0\n');
    expect(scanClosure(merged).cells.find((cell) => cell.cell_key === 'codex-cli-0').hits)
      .toContainEqual({ label: 'private_evidence', count: 1 });
  });
});

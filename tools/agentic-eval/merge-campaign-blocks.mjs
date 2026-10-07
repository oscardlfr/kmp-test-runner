#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/merge-campaign-blocks.mjs --out <merged-dir> <block-closure-dir>... -- merges the closure directories of two to four
// COMPLETED block runs of one counterbalanced campaign into one closure-shaped directory that the analysis tools (campaign-summary.mjs,
// cost-estimate.mjs, infra-flake-classifier.mjs, transcript-access-scan.mjs) read as one campaign, unchanged.
//
// A block run is a campaign of its own: its own campaign id, a manifest that lists only the campaign cell indices it ran, and a closure
// directory whose cells are keyed by their POSITION inside the block (`private/<runtime>-<position>`), while every record carries the cell's
// campaign cell index in `order_index`. The merged directory keys every cell by that campaign cell index (`private/<runtime>-<index>`), which is
// what the analysis tools read from a manifest's `campaign_cell_indices`, and holds byte-identical copies of each cell's files.
//
// Nothing is written until every check has passed, and every check refuses with its own code (see MergeBlocksError). The merged manifest is a
// pure function of the block manifests, so merging the same blocks twice gives the same bytes. Records carry no campaign id; what ties a record
// to its block is the block's closure directory, and what ties it to its cell is `order_index`, checked here against the position it sits at.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJsonStringify } from './canonical-json.mjs';
import { deriveRoundOrder } from './derive-round-order-cli.mjs';
import { buildScenarioCampaignPlan, resolveScenarioCampaignDesign } from './scenario-campaign-plan.mjs';
import { validateRun } from './schemas.mjs';
import { validateAcceptedRunAuditSidecar, crossValidateAcceptedRunAuditAgainstRecord } from './accepted-run-audit.mjs';

const MIN_BLOCKS = 2;
const MAX_BLOCKS = 4;

// The manifest fields a block legitimately changes: its own id, the cells it ran and how many sessions that is, where its closure lives and when its
// manifest was generated. Every other field must be the same in every block, and is copied into the merged manifest.
const BLOCK_VARIABLE_FIELDS = new Set(['campaign_id', 'round_order', 'max_session_count', 'output_roots', 'generated_at_utc', 'private_root']);

const MERGED_ID_NAMESPACE = 'kmp-test-runner/agentic-eval/merged-blocks/v1';

const ARM_OF_CONDITION = Object.freeze({ 'current-skill': 'product', 'no-skill': 'free' });
const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const RUNTIME_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const GUEST_PRIVATE_PARENT = 'C:\\Evidence1Private';

export class MergeBlocksError extends Error {
  constructor(code, detail = null) {
    super(detail === null ? code : `${code}: ${detail}`);
    this.name = 'MergeBlocksError';
    this.code = code;
    this.detail = detail;
  }
}

function refuse(code, detail) {
  throw new MergeBlocksError(code, detail);
}

/** The campaign id of a merged directory: a GUID derived (a UUID version 8, from a SHA-256) from the block campaign ids in order, so the same blocks
 * always merge into the same id and no block's id stands for the whole campaign. */
export function mergedCampaignId(blockCampaignIds) {
  const digest = createHash('sha256').update(`${MERGED_ID_NAMESPACE}\n${blockCampaignIds.join('\n')}`, 'utf8').digest();
  digest[6] = (digest[6] & 0x0f) | 0x80;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function sameArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function readJsonFile(file, code) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return refuse(code, file);
  }
}

function readBlock(blockDir) {
  const dir = resolve(blockDir);
  const manifest = readJsonFile(join(dir, 'manifest.json'), 'block_manifest_unreadable');
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
    || typeof manifest.campaign_id !== 'string' || !UUID_RE.test(manifest.campaign_id)) {
    refuse('block_manifest_unreadable', `${dir} (no campaign_id)`);
  }
  if (manifest.provider_mode !== 'live') refuse('block_provider_mode_not_live', manifest.campaign_id);
  const closed = readJsonFile(join(dir, 'Closed.receipt.json'), 'block_closed_receipt_unreadable');
  if (closed?.schema !== 1 || closed.campaign_id !== manifest.campaign_id
    || closed.state !== 'Closed' || closed.verdict !== 'PASS') {
    refuse('block_not_closed', manifest.campaign_id);
  }
  const runtimes = manifest.runtimes;
  if (!Array.isArray(runtimes) || runtimes.length === 0 || !Array.isArray(manifest.round_order)
    || !runtimes.every((runtime) => runtime !== null && typeof runtime === 'object'
      && RUNTIME_ID_RE.test(runtime.runtime_id) && Array.isArray(runtime.campaign_cell_indices)
      && runtime.campaign_cell_indices.length === manifest.round_order.length
      && runtime.campaign_cell_indices.every((index) => Number.isSafeInteger(index) && index >= 0))) {
    refuse('block_manifest_unreadable', `${dir} (no runtimes with cell indices, or no round order)`);
  }
  return { dir, manifest, id: manifest.campaign_id };
}

/** Every manifest field a block does not legitimately change must be equal; the runtimes are compared field by field, their cell indices aside. */
function assertSameManifests(blocks) {
  const first = blocks[0];
  for (const block of blocks.slice(1)) {
    const a = first.manifest;
    const b = block.manifest;
    const where = `${first.id} vs ${block.id}`;
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (BLOCK_VARIABLE_FIELDS.has(key)) continue;
      if ((key in a) !== (key in b)) refuse('block_manifests_differ', `${key} is not in both (${where})`);
      if (key !== 'runtimes') {
        if (canonicalJsonStringify(a[key]) !== canonicalJsonStringify(b[key])) refuse('block_manifests_differ', `${key} (${where})`);
        continue;
      }
      if (a.runtimes.length !== b.runtimes.length) refuse('block_manifests_differ', `runtimes (${where})`);
      a.runtimes.forEach((runtimeA, index) => {
        const runtimeB = b.runtimes[index];
        if (runtimeA.runtime_id !== runtimeB.runtime_id) refuse('block_manifests_differ', `runtimes.${index}.runtime_id (${where})`);
        for (const field of [...new Set([...Object.keys(runtimeA), ...Object.keys(runtimeB)])].sort()) {
          if (field === 'campaign_cell_indices') continue;
          if (canonicalJsonStringify(runtimeA[field] ?? null) !== canonicalJsonStringify(runtimeB[field] ?? null)) {
            refuse('block_manifests_differ', `runtimes.${runtimeA.runtime_id}.${field} (${where})`);
          }
        }
      });
    }
  }
}

/** Guest roots are separate operational storage for each run. Bind each canonical root to its block UUID and
 * reject aliases or ancestor/descendant paths, which would let two live campaigns share private files. */
function assertIsolatedPrivateRoots(blocks) {
  const seen = [];
  for (const block of blocks) {
    const root = block.manifest.private_root;
    if (typeof root !== 'string' || !root.startsWith(`${GUEST_PRIVATE_PARENT}\\`)
      || root.includes('/') || win32.normalize(root) !== root
      || /[<>:"|?*\x00-\x1f]/.test(root.slice(2))) {
      refuse('block_private_root_invalid', block.id);
    }
    const relativeRoot = root.slice(GUEST_PRIVATE_PARENT.length + 1);
    if (relativeRoot.split('\\').some((segment) => segment === '' || segment === '.' || segment === '..' || /[. ]$/.test(segment))) {
      refuse('block_private_root_invalid', block.id);
    }
    const normalized = root.toLowerCase();
    const conflict = seen.find(({ path }) => normalized === path || normalized.startsWith(`${path}\\`) || path.startsWith(`${normalized}\\`));
    if (conflict) refuse('block_private_roots_overlap', `${conflict.id} and ${block.id}`);
    seen.push({ id: block.id, path: normalized });
  }
}

/** The design's full pre-registered plan for one runtime: its cells by campaign cell index. */
function designPlan(runtime, executionProfileId) {
  const resolved = resolveScenarioCampaignDesign(runtime.campaign_design_id);
  if (!resolved.ok) refuse('block_design_unknown', `${runtime.runtime_id}: ${runtime.campaign_design_id}`);
  const built = buildScenarioCampaignPlan({ designId: runtime.campaign_design_id, repeats: resolved.design.repeats, executionProfiles: [executionProfileId] });
  if (!built.ok) refuse('block_design_unknown', `${runtime.runtime_id}: ${built.reason}`);
  return new Map(built.plan.cells.map((cell) => [cell.order_index, cell]));
}

/** Each block's round order must be the pre-registered order of exactly the cells it ran, for every runtime. */
function assertBlockRoundOrders(blocks) {
  for (const block of blocks) {
    for (const runtime of block.manifest.runtimes) {
      const derived = deriveRoundOrder({ designId: runtime.campaign_design_id, campaignCellIndices: runtime.campaign_cell_indices, executionProfiles: [block.manifest.execution_profile_id] });
      if (!derived.ok) refuse('block_cell_index_not_in_design', `${block.id} ${runtime.runtime_id}: ${derived.reason}`);
      if (!sameArray(derived.round_order, block.manifest.round_order)) refuse('block_round_order_not_preregistered', `${block.id} ${runtime.runtime_id}`);
    }
  }
}

/** The union of the blocks' cell indices has to be the design's whole plan, each index exactly once, for every runtime. Returns the indices per runtime. */
function assertCoverage(blocks, plans) {
  const fullIndices = new Map();
  for (const runtime of blocks[0].manifest.runtimes) {
    const owner = new Map();
    for (const block of blocks) {
      const blockRuntime = block.manifest.runtimes.find((candidate) => candidate.runtime_id === runtime.runtime_id);
      for (const index of blockRuntime.campaign_cell_indices) {
        if (owner.has(index)) refuse('cell_indices_overlap', `${runtime.runtime_id} index ${index} (blocks ${owner.get(index)} and ${block.id})`);
        owner.set(index, block.id);
      }
    }
    const wanted = [...plans.get(runtime.runtime_id).keys()].sort((a, b) => a - b);
    for (const index of wanted) {
      if (!owner.has(index)) refuse('cell_indices_gap', `${runtime.runtime_id} index ${index}`);
    }
    fullIndices.set(runtime.runtime_id, wanted);
  }
  return fullIndices;
}

/** Reads one cell directory of a block and checks it is the cell its position holds. Returns what the merge copies and what it must compare across blocks. */
function readCell(block, runtime, local, plan) {
  const global = runtime.campaign_cell_indices[local];
  const cellKey = `${runtime.runtime_id}-${global}`;
  const cellDir = join(block.dir, 'private', cellKey);
  if (!existsSync(cellDir) || !statSync(cellDir).isDirectory()) refuse('cell_directory_absent', `${block.id}/${cellKey}`);
  const entries = readdirSync(cellDir, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) refuse('cell_evidence_unrecognized', `${block.id}/${cellKey} holds something that is not a file`);
  const files = entries.map((entry) => entry.name).sort();
  const hasRecord = files.includes('record.json');
  const hasRejection = files.includes('rejection.json');
  if (hasRecord && hasRejection) refuse('cell_evidence_unrecognized', `${block.id}/${cellKey} holds both a record and a rejection`);
  if (!(hasRecord && files.includes('audit.json')) && !hasRejection) refuse('cell_evidence_missing', `${block.id}/${cellKey}`);

  let identity;
  let repoCommit;
  let kmpTestCliSourceSha = null;
  let seed = null;
  let acceptedRecord = null;
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (hasRecord) {
    const file = join(cellDir, 'record.json');
    const record = readJsonFile(file, 'cell_evidence_unreadable');
    if (!isObject(record)) refuse('cell_evidence_unreadable', file);
    identity = record;
    repoCommit = record.repo_commit;
    kmpTestCliSourceSha = record.kmp_test_cli_source_sha;
    seed = record.seed;
    acceptedRecord = record;
  } else {
    const file = join(cellDir, 'rejection.json');
    const rejection = readJsonFile(file, 'cell_evidence_unreadable');
    if (!isObject(rejection) || !Array.isArray(rejection.cells) || rejection.cells.length !== 1 || !isObject(rejection.cells[0])) refuse('cell_evidence_unreadable', file);
    identity = rejection.cells[0];
    repoCommit = rejection.repo_commit;
  }

  const where = `${cellKey} in ${block.id}`;
  if (identity.order_index !== global) refuse('record_index_mismatch', `${where}: order_index ${JSON.stringify(identity.order_index)}, expected ${global}`);
  const planCell = plan.get(global);
  if (ARM_OF_CONDITION[identity.condition] !== block.manifest.round_order[local] || identity.condition !== planCell.condition) {
    refuse('record_condition_mismatch', `${where}: condition ${JSON.stringify(identity.condition)}, expected ${planCell.condition}`);
  }
  if ((identity.repetition_index !== undefined && identity.repetition_index !== planCell.repetition_index)
    || (hasRecord && identity.product_access_mode !== planCell.product_access_mode)) {
    refuse('record_plan_mismatch', `${where}: repetition_index ${JSON.stringify(identity.repetition_index)} and product_access_mode ${JSON.stringify(identity.product_access_mode)} are not the design plan's`);
  }
  if (hasRecord && seed !== block.manifest.seed) refuse('record_seed_mismatch', `${where}: seed ${JSON.stringify(seed)}, manifest ${JSON.stringify(block.manifest.seed)}`);
  if (acceptedRecord !== null) {
    const auditRaw = readFileSync(join(cellDir, 'audit.json'), 'utf8');
    const audit = readJsonFile(join(cellDir, 'audit.json'), 'cell_evidence_unreadable');
    if (validateRun(acceptedRecord).errors.length > 0
      || validateAcceptedRunAuditSidecar(audit, { family: acceptedRecord.family }).errors.length > 0
      || crossValidateAcceptedRunAuditAgainstRecord(audit, acceptedRecord).length > 0
      || createHash('sha256').update(auditRaw, 'utf8').digest('hex') !== acceptedRecord.accepted_audit?.sha256) {
      refuse('cell_custody_invalid', `${block.id}/${cellKey}`);
    }
    if (acceptedRecord.schema >= 9 && acceptedRecord.campaign_id !== block.id) refuse('record_campaign_mismatch', `${block.id}/${cellKey}`);
  }
  return { cellKey, cellDir, global, files, repoCommit, kmpTestCliSourceSha, runId: typeof identity.run_id === 'string' ? identity.run_id : null, hasRecord };
}

function assertSingleValue(label, values) {
  const distinct = new Set(values);
  if (distinct.size !== 1 || distinct.has(undefined) || distinct.has(null)) refuse('record_commit_mismatch', `${label} takes ${distinct.size} values across the blocks (${[...distinct].map((v) => String(v).slice(0, 12)).join(', ')})`);
}

function assertOutDirUsable(outDir) {
  if (!existsSync(outDir)) return;
  if (!statSync(outDir).isDirectory() || readdirSync(outDir).length > 0) refuse('out_dir_not_empty', outDir);
}

/** An optional private custody sidecar is produced after raw transcripts are copied off the VM. It is not a
 * cell and is not copied into the merged cell tree; validate it against the exact source block bytes. */
function assertBlockRawCustody(block, expected) {
  const privateDir = join(block.dir, 'private');
  const sidecar = join(privateDir, 'raw-custody.json');
  if (!existsSync(sidecar)) return;
  const custody = readJsonFile(sidecar, 'block_raw_custody_invalid');
  if (custody?.campaign_id !== block.id || !Array.isArray(custody.cells) || custody.cells.length !== expected.size) {
    refuse('block_raw_custody_invalid', block.id);
  }
  const seen = new Set();
  for (const cell of custody.cells) {
    const planned = expected.get(cell?.cell_key);
    if (!planned || seen.has(cell.cell_key) || cell.order_index !== planned.index || cell.arm !== planned.arm
      || !Number.isSafeInteger(cell.raw_bytes) || cell.raw_bytes < 0 || !/^[0-9a-f]{64}$/.test(cell.raw_sha256)) {
      refuse('block_raw_custody_invalid', block.id + '/' + (cell?.cell_key ?? 'unknown'));
    }
    seen.add(cell.cell_key);
    let bytes;
    try {
      bytes = readFileSync(join(privateDir, cell.cell_key, 'transcript.jsonl'));
    } catch {
      refuse('block_raw_custody_invalid', block.id + '/' + cell.cell_key + ' transcript absent');
    }
    if (bytes.length !== cell.raw_bytes || createHash('sha256').update(bytes).digest('hex') !== cell.raw_sha256) {
      refuse('block_raw_custody_invalid', block.id + '/' + cell.cell_key + ' transcript digest');
    }
  }
}

/**
 * Merges the closure directories of completed block runs into `outDir`.
 * @param {{blockDirs: string[], outDir: string}} options
 * @returns {{ok: true, out: string, manifest: object, cells: number}}
 * @throws {MergeBlocksError} with the code of the first check that fails; nothing is written in that case.
 */
export function mergeCampaignBlocks({ blockDirs, outDir }) {
  if (!Array.isArray(blockDirs) || blockDirs.length < MIN_BLOCKS || blockDirs.length > MAX_BLOCKS) {
    refuse('block_count_out_of_range', `got ${Array.isArray(blockDirs) ? blockDirs.length : 'none'}, expected ${MIN_BLOCKS} to ${MAX_BLOCKS}`);
  }
  const out = resolve(outDir);
  assertOutDirUsable(out);

  const blocks = blockDirs.map(readBlock);
  for (const block of blocks) {
    const offset = relative(block.dir, out);
    if (offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))) {
      refuse('out_dir_inside_block', out);
    }
  }
  const ids = blocks.map((block) => block.id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined) refuse('block_campaign_ids_not_unique', repeated);
  assertSameManifests(blocks);
  assertIsolatedPrivateRoots(blocks);

  const base = blocks[0].manifest;
  const plans = new Map(base.runtimes.map((runtime) => [runtime.runtime_id, designPlan(runtime, base.execution_profile_id)]));
  assertBlockRoundOrders(blocks);
  const fullIndices = assertCoverage(blocks, plans);

  // The whole campaign's round order is the design's, for every cell index. Every block's order was already checked against each runtime's design
  // above, so the first runtime's stands for all of them.
  const derived = deriveRoundOrder({ designId: base.runtimes[0].campaign_design_id, campaignCellIndices: fullIndices.get(base.runtimes[0].runtime_id), executionProfiles: [base.execution_profile_id] });
  if (!derived.ok) refuse('block_cell_index_not_in_design', `${base.runtimes[0].runtime_id}: ${derived.reason}`);
  const roundOrder = derived.round_order;

  // Every cell, in block order: the position each block gave it and the campaign cell index its record names.
  const planned = [];
  for (const block of blocks) {
    const privateDir = join(block.dir, 'private');
    const expected = new Map(block.manifest.runtimes.flatMap((runtime) => runtime.campaign_cell_indices.map((index, local) =>
      [runtime.runtime_id + '-' + index, { index, arm: block.manifest.round_order[local] }])));
    const unexpected = (existsSync(privateDir) ? readdirSync(privateDir, { withFileTypes: true }) : [])
      .find((entry) => !(expected.has(entry.name) && entry.isDirectory())
        && !(entry.name === 'raw-custody.json' && entry.isFile()));
    if (unexpected !== undefined) refuse('cell_directory_unexpected', block.id + '/private/' + unexpected.name);
    assertBlockRawCustody(block, expected);
    for (const runtime of block.manifest.runtimes) {
      runtime.campaign_cell_indices.forEach((_, local) => {
        planned.push({ runtimeId: runtime.runtime_id, ...readCell(block, runtime, local, plans.get(runtime.runtime_id)) });
      });
    }
  }
  assertSingleValue('repo_commit', planned.map((cell) => cell.repoCommit));
  assertSingleValue('kmp_test_cli_source_sha', planned.filter((cell) => cell.hasRecord).map((cell) => cell.kmpTestCliSourceSha));
  const runIds = planned.map((cell) => cell.runId).filter((id) => id !== null);
  const duplicate = runIds.find((id, index) => runIds.indexOf(id) !== index);
  if (duplicate !== undefined) refuse('duplicate_run_id', duplicate);

  const generated = blocks.map((block) => block.manifest.generated_at_utc).filter((value) => typeof value === 'string').sort();
  const merged = {};
  for (const [key, value] of Object.entries(base)) {
    if (key === 'campaign_id') {
      merged.campaign_id = mergedCampaignId(ids);
      merged.kind = 'merged-blocks';
      merged.block_campaign_ids = ids;
    } else if (key === 'runtimes') {
      merged.runtimes = value.map((runtime) => ({ ...runtime, campaign_cell_indices: fullIndices.get(runtime.runtime_id) }));
    } else if (key === 'round_order') {
      merged.round_order = roundOrder;
    } else if (key === 'max_session_count') {
      merged.max_session_count = roundOrder.length * base.runtimes.length;
    } else if (key === 'output_roots') {
      merged.output_roots = { private: join(out, 'private'), public: join(out, 'public') };
    } else if (key === 'generated_at_utc') {
      merged.generated_at_utc = generated.length > 0 ? generated[generated.length - 1] : value;
    } else if (key === 'private_root') {
      // This is an analysis-only manifest. It has no single guest private root.
      merged.private_root = null;
      merged.block_private_roots = blocks.map((block) => ({ campaign_id: block.id, private_root: block.manifest.private_root }));
    } else {
      merged[key] = value;
    }
  }

  mkdirSync(join(out, 'private'), { recursive: true });
  for (const cell of planned) {
    const to = join(out, 'private', `${cell.runtimeId}-${cell.global}`);
    mkdirSync(to, { recursive: true });
    for (const file of cell.files) copyFileSync(join(cell.cellDir, file), join(to, file));
  }
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(merged, null, 2)}\n`);
  return { ok: true, out, manifest: merged, cells: planned.length };
}

const USAGE = 'usage: merge-campaign-blocks.mjs --out <merged-dir> <block-closure-dir> <block-closure-dir> [<block-closure-dir> [<block-closure-dir>]]';

function main(argv) {
  const outIndex = argv.indexOf('--out');
  const outDir = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  const blockDirs = argv.filter((_, index) => index !== outIndex && index !== outIndex + 1);
  if (outIndex < 0 || outDir === undefined || outDir.startsWith('--') || blockDirs.length === 0 || blockDirs.some((arg) => arg.startsWith('--'))) {
    console.error(USAGE);
    return 2;
  }
  try {
    const result = mergeCampaignBlocks({ blockDirs, outDir });
    console.log(JSON.stringify({ ok: true, out: result.out, campaign_id: result.manifest.campaign_id, block_campaign_ids: result.manifest.block_campaign_ids, cells: result.cells }));
    return 0;
  } catch (error) {
    if (!(error instanceof MergeBlocksError)) throw error;
    console.error(`error: ${error.message}`);
    return 1;
  }
}

// Same entry-point guard as campaign-summary.mjs: compare resolved filesystem paths, since import.meta.url is a file:// URL and never equals a
// Windows argv[1].
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

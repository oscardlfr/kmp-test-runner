#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Offline-only validator and descriptive reducer for the six-session Codex Evidence1 pilot.
// It intentionally does not call the publishable aggregate/analyze pipeline: that pipeline must
// continue to reject benchmark_eligible:false evidence. Inputs are an explicit, closed manifest;
// no directory discovery, newest-file selection, runtime process, network access, or VM access is
// performed here.
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRun } from '../../tools/agentic-eval/schemas.mjs';
import {
  acceptedAuditRelativePathFor,
  crossValidateAcceptedRunAuditAgainstRecord,
  validateAcceptedRunAuditSidecar,
} from '../../tools/agentic-eval/accepted-run-audit.mjs';

const MANIFEST_KEYS = Object.freeze(['schema', 'expected', 'artifacts']);
const EXPECTED_KEYS = Object.freeze([
  'runtime_id', 'cli_version', 'model_requested', 'model_resolved', 'scenario_id', 'seed',
  'execution_profile_id', 'execution_profile_sha256', 'source_commit', 'harness_commit',
  'isolation_attestation_sha256', 'skill_source_commit', 'skill_snapshot_sha256', 'platform',
  'campaign_custody_sha256', 'campaign_custody_identity',
  'binding_sha256',
]);
const CUSTODY_IDENTITY_KEYS = Object.freeze([
  'schema', 'campaign_id', 'campaign_design_id', 'sessions_executed', 'retry_count', 'slot_order',
]);
const ARTIFACT_KEYS = Object.freeze([
  'order_index', 'record_path', 'record_sha256', 'sidecar_path', 'sidecar_sha256',
]);
const ORDER = Object.freeze(['A', 'B', 'B', 'A', 'A', 'B']);
const CONDITIONS = Object.freeze([
  'current-skill', 'no-skill', 'no-skill', 'current-skill', 'current-skill', 'no-skill',
]);
const REPETITIONS = Object.freeze([0, 0, 1, 1, 2, 2]);
const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SAFE_ID_RE = /^[a-z0-9][a-z0-9.-]{1,127}$/;
const PINNED_CLI_VERSION = '0.154.0';
const CAMPAIGN_DESIGN_ID = 'codex-product-vs-free-baseline-v1';
const MAX_JSON_BYTES = 16 * 1024 * 1024;

export class CodexPilotDescribeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CodexPilotDescribeError';
    this.code = code;
  }
}

function fail(code) {
  throw new CodexPilotDescribeError(code);
}

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function pathKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function assertNoLinkedPathComponents(path, failureCode) {
  let cursor = path;
  while (true) {
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch {
      fail(failureCode);
    }
    if (stat.isSymbolicLink()) fail(failureCode);
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function sameFileIdentity(left, right) {
  return left.isFile() && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && (left.mode & 0o170000) === (right.mode & 0o170000);
}

function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readStrictJson(path, failureCode) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('artifact_path_invalid');
  const absolutePath = resolve(path);
  let realPath;
  try {
    realPath = realpathSync.native(absolutePath);
  } catch {
    fail(failureCode);
  }
  // Reject a symlink/junction/reparse point anywhere in the resolved path, not just at the leaf.
  if (pathKey(realPath) !== pathKey(absolutePath)) fail(failureCode);
  assertNoLinkedPathComponents(absolutePath, failureCode);
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch {
    fail(failureCode);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) fail(failureCode);
  let fd;
  let bytes;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(absolutePath, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (!sameFileIdentity(stat, opened) || opened.size > MAX_JSON_BYTES) fail(failureCode);
    bytes = readFileSync(fd);
    const afterRead = fstatSync(fd);
    const afterPath = lstatSync(absolutePath);
    const afterRealPath = realpathSync.native(absolutePath);
    assertNoLinkedPathComponents(absolutePath, failureCode);
    if (!sameFileSnapshot(opened, afterRead) || !sameFileSnapshot(stat, afterPath)
      || !sameFileIdentity(afterRead, afterPath)
      || pathKey(afterRealPath) !== pathKey(absolutePath)
      || bytes.length !== afterRead.size) fail(failureCode);
  } catch {
    fail(failureCode);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail(failureCode);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(failureCode);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(failureCode);
  }
  if (!isPlainObject(value)) fail(failureCode);
  return { value, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function validateManifest(manifest) {
  if (!hasExactKeys(manifest, MANIFEST_KEYS) || manifest.schema !== 1) fail('manifest_contract_mismatch');
  if (!hasExactKeys(manifest.expected, EXPECTED_KEYS)) fail('manifest_contract_mismatch');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 6) fail('manifest_contract_mismatch');
  for (let i = 0; i < manifest.artifacts.length; i += 1) {
    const artifact = manifest.artifacts[i];
    if (!hasExactKeys(artifact, ARTIFACT_KEYS) || artifact.order_index !== i
      || typeof artifact.record_path !== 'string' || !isAbsolute(artifact.record_path)
      || !SHA256_RE.test(artifact.record_sha256)
      || typeof artifact.sidecar_path !== 'string' || !isAbsolute(artifact.sidecar_path)
      || !SHA256_RE.test(artifact.sidecar_sha256)) {
      fail('manifest_contract_mismatch');
    }
  }

  const expected = manifest.expected;
  const custody = expected.campaign_custody_identity;
  if (expected.runtime_id !== 'codex-cli'
    || expected.model_requested !== 'gpt-5.6-terra'
    || expected.model_resolved !== 'gpt-5.6-terra'
    || expected.execution_profile_id !== 'sandboxed-unrestricted-v1'
    || expected.platform !== 'windows'
    || typeof expected.seed !== 'number' || !Number.isSafeInteger(expected.seed)
    || expected.cli_version !== PINNED_CLI_VERSION
    || typeof expected.scenario_id !== 'string' || !SAFE_ID_RE.test(expected.scenario_id)
    || !SHA256_RE.test(expected.execution_profile_sha256)
    || !SHA1_RE.test(expected.source_commit)
    || !SHA1_RE.test(expected.harness_commit)
    || !SHA256_RE.test(expected.isolation_attestation_sha256)
    || !SHA1_RE.test(expected.skill_source_commit)
    || !SHA256_RE.test(expected.skill_snapshot_sha256)
    || !SHA256_RE.test(expected.campaign_custody_sha256)
    || !SHA256_RE.test(expected.binding_sha256)
    || !hasExactKeys(custody, CUSTODY_IDENTITY_KEYS)
    || custody.schema !== 1
    || typeof custody.campaign_id !== 'string' || !SAFE_ID_RE.test(custody.campaign_id)
    || custody.campaign_design_id !== CAMPAIGN_DESIGN_ID
    || custody.sessions_executed !== 6
    || custody.retry_count !== 0
    || JSON.stringify(custody.slot_order) !== JSON.stringify(ORDER)) {
    fail('expected_identity_invalid');
  }

  const allPaths = manifest.artifacts.flatMap((artifact) => [resolve(artifact.record_path), resolve(artifact.sidecar_path)]);
  const pathKeys = allPaths.map((path) => process.platform === 'win32' ? path.toLowerCase() : path);
  if (new Set(pathKeys).size !== 12) fail('artifact_path_duplicate');
}

function assertIdentity(record, expected) {
  if (record.schema !== 8 || record.run_kind !== 'scenario' || record.benchmark_eligible !== false) {
    fail('record_pilot_contract_mismatch');
  }
  if (record.agent_runtime?.runtime_id !== expected.runtime_id
    || record.agent_runtime?.cli_version !== expected.cli_version
    || record.agent_runtime?.model_requested !== expected.model_requested
    || record.agent_runtime?.model_resolved !== expected.model_resolved
    || record.model_requested !== expected.model_requested
    || record.model_resolved !== expected.model_resolved) {
    fail(record.agent_runtime?.model_resolved == null || record.model_resolved == null
      ? 'model_resolved_not_observed'
      : 'runtime_model_or_version_mismatch');
  }
  if (record.scenario_id !== expected.scenario_id || record.seed !== expected.seed
    || record.platform !== expected.platform || record.project_commit !== expected.source_commit
    || record.repo_commit !== expected.harness_commit
    || record.execution_profile?.id !== expected.execution_profile_id
    || record.execution_profile?.sha256 !== expected.execution_profile_sha256
    || record.execution_profile?.isolation_attestation_sha256 !== expected.isolation_attestation_sha256
    || record.execution_profile?.policy_mode !== 'not_applicable'
    || record.execution_profile?.network_mode !== 'restricted') {
    fail('record_context_mismatch');
  }
}

function assertTreatment(record, index, expected) {
  const condition = CONDITIONS[index];
  const product = condition === 'current-skill';
  if (record.order_index !== index || record.repetition_index !== REPETITIONS[index]
    || record.condition !== condition
    || record.product_access_mode !== (product ? 'product-assisted' : 'free-baseline-no-product')) {
    fail('counterbalance_mismatch');
  }
  const observation = record.skill_observation;
  if (product) {
    if (record.skill_available?.value !== true
      || record.skill_source_sha !== expected.skill_source_commit
      || observation?.delivery_mode !== 'project-instructions'
      || observation?.availability?.status !== 'observed-present'
      || observation?.availability?.evidence_kind !== 'isolated-filesystem'
      || observation?.source_sha !== expected.skill_source_commit
      || observation?.treatment_size?.snapshot_sha256 !== expected.skill_snapshot_sha256
      || observation?.treatment_size?.absent_reason !== null) {
      fail('product_skill_contract_mismatch');
    }
  } else if (record.skill_available?.value !== false
    || record.skill_source_sha !== null
    || observation?.delivery_mode !== 'none'
    || observation?.availability?.status !== 'observed-absent'
    || observation?.availability?.evidence_kind !== 'isolated-filesystem'
    || observation?.source_sha !== null
    || observation?.treatment_size?.snapshot_sha256 !== null
    || observation?.treatment_size?.absent_reason !== 'condition-no-skill') {
    fail('baseline_skill_contract_mismatch');
  }
}

function commonProjection(record) {
  return {
    scenario_id: record.scenario_id,
    seed: record.seed,
    platform: record.platform,
    family: record.family,
    cache_state: record.cache_state,
    daemon_policy: record.daemon_policy,
    env_allowlist_profile: record.env_allowlist_profile,
    repo_commit: record.repo_commit,
    project_alias: record.project_alias,
    project_commit: record.project_commit,
    project_url: record.project_url,
    kmp_test_cli_version: record.kmp_test_cli_version,
    kmp_test_cli_source_sha: record.kmp_test_cli_source_sha,
    agent_runtime: record.agent_runtime,
    execution_profile: record.execution_profile,
    prompt_sha256: record.skill_observation?.treatment_size?.prompt_sha256,
    prompt_bytes: record.skill_observation?.treatment_size?.prompt_bytes,
    ambient_skill_profile: record.ambient_skill_profile,
  };
}

function valueAt(record, path) {
  let value = record;
  for (const key of path) value = value?.[key];
  return value;
}

function numericSummary(records, path, unavailableReasonCode = 'metric_not_recorded_by_runtime') {
  const values = records.map((record) => valueAt(record, path));
  if (values.some((value) => value !== null && (!Number.isFinite(value) || value < 0))) fail('metric_contract_mismatch');
  const observed = values.filter((value) => typeof value === 'number').sort((a, b) => a - b);
  if (observed.length === 0) {
    return {
      observed_count: 0, missing_count: values.length, min: null, max: null, mean: null, median: null,
      reason_code: unavailableReasonCode,
    };
  }
  const sum = observed.reduce((total, value) => total + value, 0);
  const middle = Math.floor(observed.length / 2);
  const median = observed.length % 2 === 1 ? observed[middle] : (observed[middle - 1] + observed[middle]) / 2;
  return {
    observed_count: observed.length,
    missing_count: values.length - observed.length,
    min: observed[0],
    max: observed.at(-1),
    mean: sum / observed.length,
    median,
    reason_code: observed.length === values.length ? null : 'some_sessions_did_not_report_metric',
  };
}

function booleanSummary(records, path, unavailableReasonCode = 'metric_not_recorded') {
  const values = records.map((record) => valueAt(record, path));
  if (values.some((value) => value !== true && value !== false && value !== null)) fail('metric_contract_mismatch');
  const missingCount = values.filter((value) => value === null).length;
  return {
    true_count: values.filter((value) => value === true).length,
    false_count: values.filter((value) => value === false).length,
    missing_count: missingCount,
    reason_code: missingCount === 0
      ? null
      : missingCount === values.length ? unavailableReasonCode : 'some_sessions_did_not_report_metric',
  };
}

function summarizeCondition(condition, records) {
  return {
    condition,
    product_access_mode: condition === 'current-skill' ? 'product-assisted' : 'free-baseline-no-product',
    session_count: records.length,
    outcomes: {
      success: booleanSummary(records, ['success', 'value']),
      expected_outcome_matched: booleanSummary(records, ['expected_outcome_matched', 'value']),
      task_outcome_matched: booleanSummary(records, ['outcome_assessment', 'task_outcome_matched']),
      product_e2e_success: booleanSummary(
        records,
        ['outcome_assessment', 'product_e2e_success'],
        condition === 'no-skill' ? 'condition_does_not_use_product' : 'product_e2e_outcome_not_observed',
      ),
    },
    metrics: {
      wall_clock_ms: numericSummary(records, ['wall_clock_ms']),
      tool_calls_total: numericSummary(records, ['tool_calls_total', 'value']),
      shell_commands_total: numericSummary(records, ['shell_commands_total', 'value']),
      test_invocations_total: numericSummary(records, ['test_invocations_total', 'value']),
      retries: numericSummary(records, ['retries', 'value']),
      human_interventions: numericSummary(records, ['human_interventions', 'value']),
      input_tokens: numericSummary(records, ['usage', 'input']),
      cached_input_tokens: numericSummary(records, ['usage', 'cached_input']),
      cache_write_tokens: numericSummary(records, ['usage', 'cache_write'], 'runtime_does_not_expose_cache_write_tokens'),
      output_tokens: numericSummary(records, ['usage', 'output']),
      reasoning_output_tokens: numericSummary(records, ['usage', 'reasoning_output'], 'runtime_did_not_report_reasoning_output_tokens'),
    },
  };
}

/**
 * Validates the exact twelve artifacts named by a closed manifest and returns a privacy-safe,
 * descriptive-only summary. Test-only dependency injection keeps the reducer independently
 * testable; the CLI always uses the real repository validators below.
 */
export function describeCodexPilot(manifest, dependencies = {}) {
  validateManifest(manifest);
  const validators = {
    validateRecord: dependencies.validateRecord ?? validateRun,
    validateSidecar: dependencies.validateSidecar ?? validateAcceptedRunAuditSidecar,
    crossValidate: dependencies.crossValidate ?? crossValidateAcceptedRunAuditAgainstRecord,
  };
  const records = [];
  const runIds = new Set();
  const sessionIds = new Set();
  let common = null;

  for (let index = 0; index < manifest.artifacts.length; index += 1) {
    const artifact = manifest.artifacts[index];
    const recordRead = readStrictJson(artifact.record_path, 'record_read_or_json_failed');
    const sidecarRead = readStrictJson(artifact.sidecar_path, 'sidecar_read_or_json_failed');
    if (recordRead.sha256 !== artifact.record_sha256
      || sidecarRead.sha256 !== artifact.sidecar_sha256) fail('artifact_blob_hash_mismatch');
    const record = recordRead.value;
    const sidecar = sidecarRead.value;

    let recordValidation;
    let sidecarValidation;
    let crossValidation;
    try {
      recordValidation = validators.validateRecord(record);
      sidecarValidation = validators.validateSidecar(sidecar);
      crossValidation = validators.crossValidate(sidecar, record);
    } catch {
      fail('shared_validator_failed');
    }
    if (!recordValidation || !Array.isArray(recordValidation.errors) || recordValidation.errors.length !== 0) {
      fail('record_schema_invalid');
    }
    if (!sidecarValidation || !Array.isArray(sidecarValidation.errors)
      || sidecarValidation.errors.length !== 0) fail('sidecar_schema_invalid');
    if (!Array.isArray(crossValidation) || crossValidation.length !== 0) fail('record_sidecar_cross_validation_failed');

    assertIdentity(record, manifest.expected);
    assertTreatment(record, index, manifest.expected);
    if (record.retries?.value !== 0 || record.retries?.reason !== null
      || (Number.isInteger(record.test_invocations_total?.value) && record.test_invocations_total.value > 1)
      || (Array.isArray(sidecar.terminal_evidence?.coverage_gate_attempts)
        && sidecar.terminal_evidence.coverage_gate_attempts.length > 1)) {
      fail('retry_or_respawn_indicator_present');
    }
    if (typeof record.run_id !== 'string' || runIds.has(record.run_id)) fail('run_id_missing_or_duplicate');
    runIds.add(record.run_id);
    if (typeof record.session_id_observed !== 'string' || record.session_id_observed.length === 0
      || sessionIds.has(record.session_id_observed)) fail('session_id_missing_or_duplicate');
    sessionIds.add(record.session_id_observed);

    const expectedRelative = acceptedAuditRelativePathFor(record.run_id);
    const expectedSidecarPath = resolve(dirname(resolve(artifact.record_path)), expectedRelative);
    if (basename(resolve(artifact.record_path)) !== `${record.run_id}.json`
      || basename(dirname(resolve(artifact.sidecar_path))).toLowerCase() !== 'audit'
      || basename(resolve(artifact.sidecar_path)) !== `${record.run_id}.json`
      || pathKey(resolve(artifact.sidecar_path)) !== pathKey(expectedSidecarPath)
      || record.accepted_audit?.relative_path !== expectedRelative
      || record.accepted_audit?.schema !== sidecar.schema
      || record.accepted_audit?.sha256 !== sidecarRead.sha256
      || sidecar.run_id !== record.run_id) {
      fail('record_sidecar_hash_or_path_mismatch');
    }

    const projection = JSON.stringify(commonProjection(record));
    if (common == null) common = projection;
    else if (projection !== common) fail('common_axes_mismatch');
    records.push(record);
  }

  return {
    schema: 1,
    kind: 'evidence1-codex-pilot-descriptive-summary',
    status: 'pass',
    benchmark_eligible: false,
    publication_class: 'descriptive-only',
    publishable_aggregate: {
      status: 'not-applicable',
      reason_code: 'benchmark_ineligible_records_are_rejected_by_publishable_aggregate',
    },
    publishable_analysis: {
      status: 'not-applicable',
      reason_code: 'benchmark_ineligible_records_are_excluded_from_publishable_analysis',
    },
    campaign: {
      runtime_id: manifest.expected.runtime_id,
      cli_version: manifest.expected.cli_version,
      model_requested: manifest.expected.model_requested,
      model_resolved: manifest.expected.model_resolved,
      scenario_id: manifest.expected.scenario_id,
      seed: manifest.expected.seed,
      execution_profile_id: manifest.expected.execution_profile_id,
      execution_profile_sha256: manifest.expected.execution_profile_sha256,
      source_commit: manifest.expected.source_commit,
      harness_commit: manifest.expected.harness_commit,
      isolation_attestation_sha256: manifest.expected.isolation_attestation_sha256,
      skill_source_commit: manifest.expected.skill_source_commit,
      skill_snapshot_sha256: manifest.expected.skill_snapshot_sha256,
      platform: manifest.expected.platform,
      planned_sessions: 6,
      validated_sessions: 6,
      product_sessions: 3,
      free_baseline_sessions: 3,
      counterbalanced_order: ORDER,
      recorded_retry_metrics_all_zero: true,
      operational_custody: {
        binding_sha256: manifest.expected.binding_sha256,
        campaign_custody_sha256: manifest.expected.campaign_custody_sha256,
        identity: manifest.expected.campaign_custody_identity,
        exact_session_count_evidence_source: 'external-operational-ledger',
        reducer_validates_ledger_contents: false,
        additional_session_absence_established_by_reducer: null,
        additional_session_absence_reason_code: 'external_operational_ledger_required_to_exclude_additional_sessions',
      },
    },
    conditions: [
      summarizeCondition('current-skill', records.filter((record) => record.condition === 'current-skill')),
      summarizeCondition('no-skill', records.filter((record) => record.condition === 'no-skill')),
    ],
  };
}

export function writeSummaryCreateNew(path, summary) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('output_path_invalid');
  const bytes = Buffer.from(`${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  let fd;
  try {
    fd = openSync(path, 'wx');
    writeSync(fd, bytes, 0, bytes.length);
    fsyncSync(fd);
  } catch {
    fail('output_create_new_failed');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseCli(argv) {
  const result = { manifest: null, output: null };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== '--manifest' && flag !== '--output') || value == null) fail('cli_arguments_invalid');
    const key = flag.slice(2);
    if (result[key] !== null) fail('cli_arguments_invalid');
    result[key] = value;
  }
  if (result.manifest == null) fail('cli_arguments_invalid');
  return result;
}

function runCli() {
  try {
    const args = parseCli(process.argv.slice(2));
    const manifest = readStrictJson(args.manifest, 'manifest_read_or_json_failed').value;
    const summary = describeCodexPilot(manifest);
    if (args.output) writeSummaryCreateNew(args.output, summary);
    else process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    const reasonCode = error instanceof CodexPilotDescribeError ? error.code : 'pilot_describe_failed';
    process.stderr.write(`${JSON.stringify({ schema: 1, status: 'fail', reason_code: reasonCode })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  CodexPilotDescribeError,
  describeCodexPilot,
  writeSummaryCreateNew,
} from '../../docs/audits/evidence1-codex-pilot-describe.mjs';
import {
  buildAcceptedRunAuditSidecar,
  crossValidateAcceptedRunAuditAgainstRecord,
  validateAcceptedRunAuditSidecar,
} from '../../tools/agentic-eval/accepted-run-audit.mjs';
import { canonicalJsonSha256 } from '../../tools/agentic-eval/canonical-json.mjs';
import { GRADING_CHECK_NAMES } from '../../tools/agentic-eval/graders.mjs';
import { validateRun } from '../../tools/agentic-eval/schemas.mjs';

const HASH_A = canonicalJsonSha256({
  id: 'sandboxed-unrestricted-v1',
  isolation_kind: 'external-sandbox',
  network_mode: 'restricted',
  isolation_attestation_required: true,
  policy_mode: 'not_applicable',
  required_capabilities: ['structuredTranscript', 'correlatedToolResults', 'skillStateEvidence'],
});
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const COMMIT_C = 'c'.repeat(40);
const CONDITIONS = ['current-skill', 'no-skill', 'no-skill', 'current-skill', 'current-skill', 'no-skill'];
const REPS = [0, 0, 1, 1, 2, 2];
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function expected() {
  return {
    runtime_id: 'codex-cli',
    cli_version: '0.154.0',
    model_requested: 'gpt-5.6-terra',
    model_resolved: 'gpt-5.6-terra',
    scenario_id: 'coverage-threshold-failure-v2',
    seed: 20260910,
    execution_profile_id: 'sandboxed-unrestricted-v1',
    execution_profile_sha256: HASH_A,
    source_commit: COMMIT_A,
    harness_commit: COMMIT_B,
    isolation_attestation_sha256: HASH_B,
    skill_source_commit: COMMIT_C,
    skill_snapshot_sha256: HASH_C,
    platform: 'windows',
    binding_sha256: '9'.repeat(64),
    campaign_custody_sha256: 'f'.repeat(64),
    campaign_custody_identity: {
      schema: 1,
      campaign_id: 'evidence1-codex-pilot-20260910',
      campaign_design_id: 'codex-product-vs-free-baseline-v1',
      sessions_executed: 6,
      retry_count: 0,
      slot_order: ['A', 'B', 'B', 'A', 'A', 'B'],
    },
  };
}

function makeRecord(index, runId, secret = null) {
  const condition = CONDITIONS[index];
  const product = condition === 'current-skill';
  const nullable = (value, reason = null) => ({ value, reason });
  return {
    schema: 8,
    run_id: runId,
    run_kind: 'scenario',
    benchmark_eligible: false,
    scenario_id: expected().scenario_id,
    query_id: null,
    condition,
    product_access_mode: product ? 'product-assisted' : 'free-baseline-no-product',
    seed: expected().seed,
    order_index: index,
    repetition_index: REPS[index],
    platform: 'windows',
    family: 'coverage',
    cache_state: 'warm',
    daemon_policy: 'disabled-via-gradle-user-home-properties',
    env_allowlist_profile: 'narrow',
    repo_commit: COMMIT_B,
    project_alias: 'source-project',
    project_commit: COMMIT_A,
    project_url: null,
    kmp_test_cli_version: '0.13.0',
    kmp_test_cli_source_sha: COMMIT_B,
    resolved_kmp_test_executable_path: 'tools/agentic-eval/fixtures/kmp-test.js',
    agent_runtime: {
      runtime_id: 'codex-cli', cli_version: '0.154.0', model_requested: 'gpt-5.6-terra',
      model_resolved: 'gpt-5.6-terra', model_vendor_expected: 'openai', model_vendor_observed: 'openai',
    },
    model_requested: 'gpt-5.6-terra',
    model_resolved: 'gpt-5.6-terra',
    session_id_observed: `thread-${index}`,
    claude_code_version: null,
    execution_profile: {
      id: 'sandboxed-unrestricted-v1', sha256: HASH_A, isolation_kind: 'external-sandbox',
      isolation_attestation_sha256: HASH_B, isolation_attestation_required: true,
      network_mode: 'restricted', policy_mode: 'not_applicable',
      required_capabilities: ['structuredTranscript', 'correlatedToolResults', 'skillStateEvidence'],
    },
    skill_source_sha: product ? COMMIT_C : null,
    skill_available: nullable(product),
    skill_invocation_attempted: nullable(false),
    skill_invoked: nullable(null, 'Codex does not expose a skill-activation event'),
    skill_invocation_event: null,
    skill_observation: {
      delivery_mode: product ? 'project-instructions' : 'none',
      availability: { status: product ? 'observed-present' : 'observed-absent', evidence_kind: 'isolated-filesystem' },
      activation: { status: 'not-observable', evidence_kind: 'not-observable' },
      source_sha: product ? COMMIT_C : null,
      treatment_size: {
        snapshot_sha256: product ? HASH_C : null,
        snapshot_bytes: product ? 1234 : null,
        snapshot_file_count: product ? 8 : null,
        prompt_sha256: 'd'.repeat(64), prompt_bytes: 55,
        absent_reason: product ? null : 'condition-no-skill',
      },
    },
    ambient_skill_profile: { count: 0, scope_id: '11111111-2222-4333-8444-555555555555', fingerprint_hmac: 'e'.repeat(64) },
    started_at: `2026-09-10T00:00:0${index}.000Z`,
    ended_at: `2026-09-10T00:00:1${index}.000Z`,
    success: nullable(index % 2 === 0),
    expected_outcome_matched: nullable(index % 2 === 0),
    first_useful_signal_ms: nullable(null, 'no first useful signal boundary'),
    first_useful_signal_event: null,
    outcome_assessment: {
      schema: 1,
      task_outcome_matched: null,
      task_outcome_reason: 'ground-truth-unavailable',
      answer_protocol_matched: false,
      provider_evidence_kind: 'none',
      provider_evidence_status: 'unavailable',
      product_e2e_success: null,
    },
    wall_clock_ms: 1000 + index,
    tokens: {
      input: nullable(10 + index),
      output: nullable(4),
      cache_read: nullable(2),
      cache_creation: nullable(null, 'runtime does not expose cache-write tokens'),
    },
    tool_calls_total: nullable(0),
    shell_commands_total: nullable(0),
    test_invocations_total: nullable(1),
    retries: nullable(0),
    output_bytes: nullable(100),
    stream_json_bytes: nullable(1000),
    human_interventions: nullable(0),
    post_signal_ms: nullable(null, 'no first useful signal boundary'),
    post_signal_tool_calls: nullable(null, 'no first useful signal boundary'),
    policy_denials_before_first_signal: nullable(null, 'policy not applicable'),
    policy_denials_after_first_signal: nullable(null, 'policy not applicable'),
    usage: {
      source: 'runtime-reported',
      input: 10 + index,
      cached_input: 2,
      cache_write: null,
      output: 4,
      reasoning_output: null,
      attributable_to_skill_load: {
        status: 'not-recorded',
        dimensions: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null },
        unit: null,
        reason: product ? 'runtime-attribution-unavailable' : 'condition-no-skill',
      },
    },
    grading_checks: {
      value: GRADING_CHECK_NAMES.map((name) => ({ name, passed: true, detail: 'ok', evidence_event_indices: [] })),
      reason: null,
    },
    foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
    terminated: false,
    termination_reason: null,
    exit_code: 0,
    permission_mode_used: null,
    policy_allowed_gradle_tasks: null,
    policy_allowed_kmptest_subcommands: null,
    policy_sha256: null,
    hook_call_count: null,
    hook_deny_count: null,
    privacy_status: 'redacted-private',
    raw_capture_committed: false,
    raw_capture_location: 'external-private-custody',
    notes: secret,
    errors: [],
    accepted_audit: null,
  };
}

function realSidecarFor(record) {
  const terminalEvidence = {
    present: false,
    provider: null,
    tool_result_event_index: null,
    evidence_well_formed: false,
    target_matches_expected: null,
    outcome_matches_expected: null,
    malformed: null,
    parallel_evidence_invalid: null,
    changed_evidence_invalid: null,
    observed_result: null,
    final_answer_block: {
      found: false,
      parsed: false,
      ambiguous: false,
      matches_observed: null,
      comparison_status: 'no-final-text',
      declared_outcome_kind: null,
      observed_outcome_kind: null,
      missing_fields: [],
      mismatch_fields: [],
      unexpected_key_count: 0,
    },
    coverage_gate_diagnostic: 'no-terminal-evidence',
    coverage_gate_attempts: [],
  };
  return buildAcceptedRunAuditSidecar({
    record,
    conditionResult: {
      observation: {
        toolAttempts: [],
        timing: { receiptNsByEventIndex: new Map() },
        process: { endedHrtimeNs: 1_000_000n },
      },
      junitAttribution: { decisionByAttempt: new Map() },
      dispatchAccounting: { dispatchStatusByAttempt: new Map() },
    },
    terminalAuthoritativeEventIndex: null,
    terminalEvidence,
  });
}

function createFixture({ mutateRecord, mutateSidecar, secret = null, realValidators = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'e1-codex-describe-'));
  roots.push(root);
  const auditDir = join(root, 'audit');
  mkdirSync(auditDir);
  const artifacts = [];
  for (let index = 0; index < 6; index += 1) {
    const runId = `scenario-${index}-abcdef12`;
    const record = makeRecord(index, runId, secret);
    mutateRecord?.(record, index);
    const sidecar = realValidators
      ? realSidecarFor(record)
      : { schema: 10, run_id: record.run_id, private_test_value: secret };
    mutateSidecar?.(sidecar, index);
    const sidecarText = JSON.stringify(sidecar);
    const sidecarPath = join(auditDir, `${runId}.json`);
    writeFileSync(sidecarPath, sidecarText, 'utf8');
    record.accepted_audit = {
      schema: sidecar.schema,
      relative_path: `audit/${runId}.json`,
      sha256: createHash('sha256').update(sidecarText, 'utf8').digest('hex'),
    };
    const recordPath = join(root, `${runId}.json`);
    const recordText = JSON.stringify(record);
    writeFileSync(recordPath, recordText, 'utf8');
    artifacts.push({
      order_index: index,
      record_path: recordPath,
      record_sha256: createHash('sha256').update(recordText, 'utf8').digest('hex'),
      sidecar_path: sidecarPath,
      sidecar_sha256: createHash('sha256').update(sidecarText, 'utf8').digest('hex'),
    });
  }
  return { schema: 1, expected: expected(), artifacts };
}

function testDependencies() {
  return {
    validateRecord: vi.fn(() => ({ errors: [], warnings: [] })),
    validateSidecar: vi.fn(() => ({ errors: [], warnings: [] })),
    crossValidate: vi.fn(() => []),
  };
}

function expectCode(fn, code) {
  try {
    fn();
    throw new Error('expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(CodexPilotDescribeError);
    expect(error.code).toBe(code);
    expect(error.message).toBe(code);
  }
}

function stageClosedNodeRuntime(destination) {
  const runner = readFileSync(join(process.cwd(), 'docs', 'audits', 'evidence1-host-elevated-runner.ps1'), 'utf8');
  const start = runner.indexOf('$TrustedNodeFiles = @(');
  const end = runner.indexOf('function Resolve-FullPath', start);
  const relativeFiles = [...runner.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1]);
  expect(relativeFiles.length).toBeGreaterThan(0);
  expect(relativeFiles).toEqual(expect.arrayContaining([
    'tools/evidence1/provisioning/evidence1-post-os-transition.ps1',
    'tools/evidence1/provisioning/evidence1-bootstrap-toolchain.ps1',
    'tools/evidence1/provisioning/evidence1-checkpoint-toolchain.ps1',
  ]));
  for (const relative of relativeFiles) {
    const target = join(destination, ...relative.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(process.cwd(), ...relative.split('/')), target);
  }
  return relativeFiles;
}

describe('Evidence1 Codex ineligible pilot descriptive reducer', () => {
  it('executes the real reducer and privacy scanner from deployment and guest repo-relative snapshots', () => {
    const manifest = createFixture({ realValidators: true });
    const fixtureRoot = dirname(manifest.artifacts[0].record_path);
    const manifestPath = join(fixtureRoot, 'closed-manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));

    for (const layout of ['deployment', 'guest']) {
      const nodeRoot = join(fixtureRoot, layout, 'node-runtime');
      const relativeFiles = stageClosedNodeRuntime(nodeRoot);
      expect(new Set(relativeFiles).size).toBe(relativeFiles.length);
      const reducer = join(nodeRoot, 'docs', 'audits', 'evidence1-codex-pilot-describe.mjs');
      const scanner = join(nodeRoot, 'docs', 'audits', 'evidence1-codex-publication-scan.mjs');
      const summaryPath = join(fixtureRoot, `${layout}-summary.json`);
      execFileSync(process.execPath, [reducer, '--manifest', manifestPath, '--output', summaryPath], { stdio: 'pipe' });
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
      expect(summary).toMatchObject({ status: 'pass', benchmark_eligible: false, publication_class: 'descriptive-only' });

      const publicFiles = [summaryPath];
      for (let index = 0; index < 7; index += 1) {
        const path = join(fixtureRoot, `${layout}-public-${index}.json`);
        writeFileSync(path, JSON.stringify({ schema: 1, benchmark_eligible: false, condition_index: index }));
        publicFiles.push(path);
      }
      const scan = JSON.parse(execFileSync(process.execPath, [scanner, ...publicFiles.flatMap((path) => ['--file', path])], { encoding: 'utf8' }));
      expect(scan).toMatchObject({ status: 'pass', files_scanned: 8 });
    }
  }, 30_000);

  it('validates six explicit record/sidecar pairs and emits a closed descriptive 3/3 summary', () => {
    const manifest = createFixture({ realValidators: true });
    for (const artifact of manifest.artifacts) {
      const record = JSON.parse(readFileSync(artifact.record_path, 'utf8'));
      const sidecar = JSON.parse(readFileSync(artifact.sidecar_path, 'utf8'));
      expect(validateRun(record).errors).toEqual([]);
      expect(validateAcceptedRunAuditSidecar(sidecar).errors).toEqual([]);
      expect(crossValidateAcceptedRunAuditAgainstRecord(sidecar, record)).toEqual([]);
    }
    const summary = describeCodexPilot(manifest);

    expect(summary).toMatchObject({
      schema: 1, status: 'pass', benchmark_eligible: false, publication_class: 'descriptive-only',
      campaign: {
        runtime_id: 'codex-cli', cli_version: '0.154.0', model_requested: 'gpt-5.6-terra',
        model_resolved: 'gpt-5.6-terra', product_sessions: 3, free_baseline_sessions: 3,
        counterbalanced_order: ['A', 'B', 'B', 'A', 'A', 'B'], recorded_retry_metrics_all_zero: true,
        operational_custody: {
          binding_sha256: '9'.repeat(64),
          campaign_custody_sha256: 'f'.repeat(64),
          identity: {
            schema: 1,
            campaign_id: 'evidence1-codex-pilot-20260910',
            campaign_design_id: 'codex-product-vs-free-baseline-v1',
            sessions_executed: 6,
            retry_count: 0,
            slot_order: ['A', 'B', 'B', 'A', 'A', 'B'],
          },
          exact_session_count_evidence_source: 'external-operational-ledger',
          reducer_validates_ledger_contents: false,
          additional_session_absence_established_by_reducer: null,
          additional_session_absence_reason_code: 'external_operational_ledger_required_to_exclude_additional_sessions',
        },
      },
      publishable_aggregate: {
        status: 'not-applicable',
        reason_code: 'benchmark_ineligible_records_are_rejected_by_publishable_aggregate',
      },
      publishable_analysis: {
        status: 'not-applicable',
        reason_code: 'benchmark_ineligible_records_are_excluded_from_publishable_analysis',
      },
    });
    expect(summary.conditions.map((entry) => [entry.condition, entry.session_count])).toEqual([
      ['current-skill', 3], ['no-skill', 3],
    ]);
    expect(summary.conditions[0].metrics.cache_write_tokens).toEqual({
      observed_count: 0, missing_count: 3, min: null, max: null, mean: null, median: null,
      reason_code: 'runtime_does_not_expose_cache_write_tokens',
    });
  });

  it('rejects a manifest with an unknown field before reading artifacts', () => {
    const manifest = { ...createFixture(), extra: true };
    expectCode(() => describeCodexPilot(manifest, testDependencies()), 'manifest_contract_mismatch');
  });

  it('requires the closed external campaign-custody hash and identity', () => {
    const missingHash = createFixture();
    delete missingHash.expected.campaign_custody_sha256;
    expectCode(() => describeCodexPilot(missingHash, testDependencies()), 'manifest_contract_mismatch');

    const nonzeroLedgerRetry = createFixture();
    nonzeroLedgerRetry.expected.campaign_custody_identity.retry_count = 1;
    expectCode(() => describeCodexPilot(nonzeroLedgerRetry, testDependencies()), 'expected_identity_invalid');
  });

  it('hard-fails when the resolved model is null', () => {
    const manifest = createFixture({
      mutateRecord: (record, index) => {
        if (index === 2) {
          record.agent_runtime.model_resolved = null;
          record.model_resolved = null;
        }
      },
    });
    expectCode(() => describeCodexPilot(manifest, testDependencies()), 'model_resolved_not_observed');
  });

  it('hard-fails when the resolved model differs from the pinned model', () => {
    const manifest = createFixture({
      mutateRecord: (record, index) => {
        if (index === 3) {
          record.agent_runtime.model_resolved = 'gpt-different';
          record.model_resolved = 'gpt-different';
        }
      },
    });
    expectCode(() => describeCodexPilot(manifest, testDependencies()), 'runtime_model_or_version_mismatch');
  });

  it('rejects duplicate run and provider session identities', () => {
    const manifest = createFixture({
      mutateRecord: (record, index) => {
        if (index === 1) record.session_id_observed = 'thread-0';
      },
    });
    expectCode(() => describeCodexPilot(manifest, testDependencies()), 'session_id_missing_or_duplicate');
  });

  it('rejects a duplicate run id independently of provider session identity', () => {
    const manifest = createFixture({
      mutateRecord: (record, index) => {
        if (index === 1) record.run_id = 'scenario-0-abcdef12';
      },
    });
    expectCode(() => describeCodexPilot(manifest, testDependencies()), 'run_id_missing_or_duplicate');
  });

  it('rejects a sidecar whose exact bytes no longer match the record hash', () => {
    const manifest = createFixture();
    writeFileSync(manifest.artifacts[4].sidecar_path, '{"schema":10,"run_id":"tampered"}', 'utf8');
    expectCode(() => describeCodexPilot(manifest, testDependencies()), 'artifact_blob_hash_mismatch');
  });

  it('rejects substituting another internally-consistent record/sidecar pair at different paths', () => {
    const manifest = createFixture({ secret: 'original-pair' });
    const replacement = createFixture({ secret: 'replacement-pair' });
    manifest.artifacts[2] = {
      ...manifest.artifacts[2],
      record_path: replacement.artifacts[2].record_path,
      sidecar_path: replacement.artifacts[2].sidecar_path,
    };

    expectCode(() => describeCodexPilot(manifest, testDependencies()), 'artifact_blob_hash_mismatch');
  });

  it('rejects any CLI version other than the campaign pin', () => {
    const manifest = createFixture();
    manifest.expected.cli_version = '0.153.5';
    expectCode(() => describeCodexPilot(manifest, testDependencies()), 'expected_identity_invalid');
  });

  it('hard-fails when any record reports a retry', () => {
    const manifest = createFixture({
      mutateRecord: (record, index) => {
        if (index === 4) record.retries = { value: 1, reason: null };
      },
    });
    expectCode(() => describeCodexPilot(manifest, testDependencies()), 'retry_or_respawn_indicator_present');
  });

  it('requires a sidecar to live at the record-relative accepted_audit path exactly', () => {
    const manifest = createFixture();
    const alternateRoot = mkdtempSync(join(tmpdir(), 'e1-codex-sidecar-substitute-'));
    roots.push(alternateRoot);
    const alternateAudit = join(alternateRoot, 'audit');
    mkdirSync(alternateAudit);
    const original = manifest.artifacts[3].sidecar_path;
    const substitute = join(alternateAudit, basename(original));
    writeFileSync(substitute, readFileSync(original));
    manifest.artifacts[3].sidecar_path = substitute;

    expectCode(
      () => describeCodexPilot(manifest, testDependencies()),
      'record_sidecar_hash_or_path_mismatch',
    );
  });

  it('rejects an ancestor symlink or junction instead of following it', ({ skip }) => {
    const manifest = createFixture();
    const aliasRoot = mkdtempSync(join(tmpdir(), 'e1-codex-reparse-'));
    roots.push(aliasRoot);
    const alias = join(aliasRoot, 'linked-campaign');
    try {
      symlinkSync(dirname(manifest.artifacts[0].record_path), alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      skip();
      return;
    }
    manifest.artifacts[0].record_path = join(alias, basename(manifest.artifacts[0].record_path));

    expectCode(() => describeCodexPilot(manifest, testDependencies()), 'record_read_or_json_failed');
  });

  it('rejects a drifted common axis even when the critical expected identity still matches', () => {
    const manifest = createFixture({
      mutateRecord: (record, index) => {
        if (index === 5) record.cache_state = 'cold';
      },
    });
    expectCode(() => describeCodexPilot(manifest, testDependencies()), 'common_axes_mismatch');
  });

  it('never projects artifact paths or record/sidecar free text into the output', () => {
    const secret = 'Z:\\private-fixture\\raw-transcript secret prompt command response';
    const manifest = createFixture({ secret, realValidators: true });
    const summaryText = JSON.stringify(describeCodexPilot(manifest));

    expect(summaryText).not.toContain(secret);
    expect(summaryText).not.toContain('private-user');
    for (const artifact of manifest.artifacts) {
      expect(summaryText).not.toContain(artifact.record_path);
      expect(summaryText).not.toContain(artifact.sidecar_path);
    }
  });

  it('writes UTF-8 output once and refuses overwrite', () => {
    const manifest = createFixture({ realValidators: true });
    const summary = describeCodexPilot(manifest);
    const output = join(dirname(manifest.artifacts[0].record_path), 'summary.json');
    writeSummaryCreateNew(output, summary);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(summary);
    expectCode(() => writeSummaryCreateNew(output, summary), 'output_create_new_failed');
  });
});

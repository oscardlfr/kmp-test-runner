// tests/vitest/agentic-eval-rejection-diagnostics.test.js
// Unit tests for tools/agentic-eval/rejection-diagnostics.mjs (pure construction + validation)
// plus real-subprocess integration tests proving the two-tier write is actually wired into
// cli.mjs's calibrate/smoke/run failure paths -- closing BACKLOG.md's "leave no auditable trace"
// gap. See evidence-io.mjs's own doc comment for the exact (not overclaimed) atomicity contract
// this module reuses rather than reinventing.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LATEST_REJECTION_DIAGNOSTICS_SCHEMA,
  SUPPORTED_REJECTION_DIAGNOSTICS_SCHEMAS,
  REJECTION_DIAGNOSTICS_SCHEMA_V2,
  REJECTION_DIAGNOSTICS_SCHEMA_V3,
  REJECTION_DIAGNOSTICS_SCHEMA_V4,
  buildRejectionDiagnostics,
  validateRejectionRow,
  validateRejectionLocalRow,
  assertUnexpectedToolCoherence,
  writeRejectedRunDiagnostics,
  writeRejectionRawTranscripts,
  deriveTranscriptFilename,
  validateCaptureOrdinalSet,
  writeRejectionRawStderr,
  deriveStderrFilename,
  readRejectionStderrFile,
} from '../../tools/agentic-eval/rejection-diagnostics.mjs';
import { findLeaks, PUBLIC_SHAPE_RULES, redactAndVerify } from '../../tools/agentic-eval/privacy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'tools', 'agentic-eval', 'cli.mjs');
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

// Test-local wrapper -- this fix (preserve rejected matrix forensics) added 5 new REQUIRED
// buildRejectionDiagnostics params (rejectionId, unexpectedToolUsesCountByRunId,
// unexpectedToolsByRunId, captureOrdinalByRunId, rawTranscriptsPersisted). Every EXISTING test
// below predates those fields and is testing something else entirely (provenance disagreement,
// ambient-profile coherence, foreign-skill-summary summing, ...) -- routing them through this
// wrapper supplies coherent, valid defaults (zero unexpected tools everywhere) so those tests keep
// exercising the REAL function under realistic, schema-valid inputs, without each one having to
// separately restate the same 5 boilerplate fields. Tests that specifically exercise the NEW
// fields' own contract call buildRejectionDiagnostics directly instead (see the dedicated describe
// blocks added by this fix, below).
function zeroToolDefaultsFor(records) {
  const ids = records.map((r) => r.run_id);
  return {
    unexpectedToolUsesCountByRunId: Object.fromEntries(ids.map((id) => [id, 0])),
    unexpectedToolsByRunId: Object.fromEntries(ids.map((id) => [id, []])),
    captureOrdinalByRunId: Object.fromEntries(ids.map((id, i) => [id, i])),
  };
}
function buildDiag(opts) {
  return buildRejectionDiagnostics({
    rejectionId: randomUUID(),
    rawTranscriptsPersisted: true,
    ...zeroToolDefaultsFor(opts.records),
    ...opts,
  });
}

// Defaults represent a genuine run_kind:'calibration' record -- project_alias is the FIXED
// 'calibration-project' literal (buildRunRecord's own default parameter value, never null; see
// validateProvenanceForRunKind's own doc comment), project_commit/seed null (no external
// project/repetition concept for calibration). A caller building a 'smoke'/'scenario' record must
// override run_kind AND all four project_*/seed fields together via `overrides` -- see
// smokeRecord()/scenarioRecord() below for the pre-built variants.
function record(overrides = {}) {
  return {
    run_id: 'calibration-no-skill-aaaa1111',
    run_kind: 'calibration',
    condition: 'no-skill',
    repetition_index: null,
    order_index: null,
    skill_source_sha: null,
    model_resolved: 'claude-sonnet-5-fake-resolved',
    claude_code_version: '1.2.3-fake',
    repo_commit: 'c'.repeat(40),
    model_requested: 'fake-model-x',
    scenario_id: 'calibration-explicit-invocation',
    project_alias: 'calibration-project',
    project_commit: null,
    project_url: null,
    seed: null,
    policy_sha256: 'a'.repeat(64),
    platform: 'linux',
    privacy_status: 'public',
    foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
    ambient_skill_profile: { count: 0, scope_id: '00000000-0000-4000-8000-000000000000', fingerprint_hmac: '0'.repeat(64) },
    ...overrides,
  };
}

// A genuine run_kind:'smoke' record -- project_alias/project_commit are REAL (smoke always points
// at an actual external project), seed null (no repetition concept for smoke either).
function smokeRecord(overrides = {}) {
  return record({
    run_kind: 'smoke', scenario_id: 'smoke-explicit-invocation',
    project_alias: 'kampkit', project_commit: 'd'.repeat(40), project_url: 'https://github.com/example/kampkit',
    ...overrides,
  });
}

// A genuine run_kind:'scenario' record -- project_alias/project_commit REAL, seed a real integer,
// repetition_index/order_index real non-negative integers (scenario is the one run_kind where
// these concepts apply at all).
function scenarioRecord(overrides = {}) {
  return record({
    run_kind: 'scenario', scenario_id: 'kampkit-android-host-test-discovery',
    project_alias: 'kampkit', project_commit: 'd'.repeat(40), project_url: 'https://github.com/example/kampkit',
    seed: 5, repetition_index: 0, order_index: 0,
    ...overrides,
  });
}

// A genuine schema:6, execution_profile.policy_mode:"not_applicable" execution_profile group
// (sandboxed-unrestricted-v1) -- matches buildRunRecord's own real projection shape exactly
// (id/policy_mode/isolation_attestation_sha256 are the only 3 fields rejection-diagnostics.mjs
// ever reads off it). `overrides` lets a specific test deliberately vary one field (e.g. a
// different isolation_attestation_sha256) to prove the batch-disagreement checks.
function unrestrictedProfile(overrides = {}) {
  return {
    id: 'sandboxed-unrestricted-v1',
    policy_mode: 'not_applicable',
    isolation_attestation_sha256: 'e'.repeat(64),
    ...overrides,
  };
}
// A genuine schema:6, policy_mode:"not_applicable" calibration record -- policy_sha256 is
// honestly null (buildRunRecord's own policyApplies-conditioned assignment), never the real hash
// bare record() carries. Building on record() (never a parallel, independently-maintained base)
// so every OTHER field stays identical to the policy-required shape.
function unrestrictedRecord(overrides = {}) {
  return record({ schema: 6, execution_profile: unrestrictedProfile(), policy_sha256: null, ...overrides });
}
// The scenario-run_kind analogue -- schema:6/execution_profile/policy_sha256:null layered onto
// scenarioRecord()'s own real project_alias/project_commit/seed/repetition_index/order_index shape.
function unrestrictedScenarioRecord(overrides = {}) {
  return scenarioRecord({ schema: 6, execution_profile: unrestrictedProfile(), policy_sha256: null, ...overrides });
}

// Schema 2 -> 3 -> 4 (preserve rejected matrix forensics; sandboxed-unrestricted-v1 support): v2
// gained per-cell unexpected_tool_uses_count + top-level matrix_complete/planned_cell_count/
// executed_cell_count/raw_transcripts_persisted going to v3; v3 gained execution_profile_id/
// policy_mode/isolation_attestation_sha256 going to v4, EXCLUSIVE to a policy_mode:"not_applicable"
// batch (policy_sha256 becomes exactly null there, instead of a real hash). All three are a genuine
// version DISPATCH (SUPPORTED_REJECTION_DIAGNOSTICS_SCHEMAS = [2, 3, 4]), never a plain constant
// bump -- two real diagnostic files from a live 2026-08 canary rejection are schema:2 and are
// declared incident evidence that must keep validating, and v2/v3 stay frozen forever (their own
// field sets, and policy_sha256's own real-hex64 requirement, never change again). The builder
// picks v3 or v4 per batch (see buildRejectionDiagnostics' own dispatch) -- never emits v2.
it('LATEST_REJECTION_DIAGNOSTICS_SCHEMA is 4, and the validator still supports 2 and 3', () => {
  expect(REJECTION_DIAGNOSTICS_SCHEMA_V2).toBe(2);
  expect(REJECTION_DIAGNOSTICS_SCHEMA_V3).toBe(3);
  expect(REJECTION_DIAGNOSTICS_SCHEMA_V4).toBe(4);
  expect(LATEST_REJECTION_DIAGNOSTICS_SCHEMA).toBe(REJECTION_DIAGNOSTICS_SCHEMA_V4);
  expect(SUPPORTED_REJECTION_DIAGNOSTICS_SCHEMAS).toEqual([REJECTION_DIAGNOSTICS_SCHEMA_V2, REJECTION_DIAGNOSTICS_SCHEMA_V3, REJECTION_DIAGNOSTICS_SCHEMA_V4]);
});

describe('buildRejectionDiagnostics -- pure construction', () => {
  it('builds a committed record with the closed field set, and a local companion with extra foreign_skill_names', () => {
    const recordA = record();
    const recordB = record({ run_id: 'calibration-current-skill-bbbb2222', condition: 'current-skill', skill_source_sha: 'a'.repeat(40) });
    const { committed, local } = buildDiag({
      runKind: 'calibration',
      records: [recordA, recordB],
      failedChecksByRunId: { [recordA.run_id]: ['skillSelectionOk'], [recordB.run_id]: [] },
      foreignSkillNamesByRunId: { [recordA.run_id]: ['some-other-skill'], [recordB.run_id]: [] },
    });
    // record() carries no execution_profile (a real, policy-required calibration record) --
    // schema 3, never the current LATEST (which now means something else: schema 4, exclusive to
    // a policy_mode:"not_applicable" batch neither recordA nor recordB is).
    expect(committed.schema).toBe(REJECTION_DIAGNOSTICS_SCHEMA_V3);
    expect(committed.run_kind).toBe('calibration');
    expect(committed.run_ids).toEqual([recordA.run_id, recordB.run_id]);
    expect(committed.cells.length).toBe(2);
    expect(committed.cells[0].failed_checks).toEqual(['skillSelectionOk']);
    // Never a raw skill name anywhere in the committed object.
    expect(JSON.stringify(committed)).not.toContain('some-other-skill');
    // Local tier carries the real name, the committed tier does not.
    expect(local.cells[0].foreign_skill_names).toEqual(['some-other-skill']);
    expect(local.cells[1].foreign_skill_names).toEqual([]);
  });

  it('deduplicates and sorts foreign_skill_names in the local tier', () => {
    const r = record();
    const { local } = buildDiag({
      runKind: 'calibration',
      records: [r],
      failedChecksByRunId: { [r.run_id]: [] },
      foreignSkillNamesByRunId: { [r.run_id]: ['zeta', 'alpha', 'zeta', 'alpha'] },
    });
    expect(local.cells[0].foreign_skill_names).toEqual(['alpha', 'zeta']);
  });

  it('sums foreign_skill_summary across every cell into the top-level total', () => {
    const a = record({ foreign_skill_summary: { rejected: 2, confirmed: 0, incomplete: 1 } });
    const b = record({ run_id: 'calibration-current-skill-cccc3333', condition: 'current-skill', foreign_skill_summary: { rejected: 0, confirmed: 1, incomplete: 0 } });
    const { committed } = buildDiag({ runKind: 'calibration', records: [a, b], failedChecksByRunId: { [a.run_id]: [], [b.run_id]: [] } });
    expect(committed.foreign_skill_summary).toEqual({ rejected: 2, confirmed: 1, incomplete: 1 });
  });

  // ambient_skill_profile per cell (correction 6): read directly off each record's OWN field
  // (buildRunRecord already populates it, exactly like foreign_skill_summary) -- never
  // recomputed, never defaulted away.
  it('carries each cell\'s own ambient_skill_profile through unchanged, read directly off the record', () => {
    const profileA = { count: 1, scope_id: '11111111-1111-4111-8111-111111111111', fingerprint_hmac: 'a'.repeat(64) };
    const profileB = { count: 0, scope_id: '11111111-1111-4111-8111-111111111111', fingerprint_hmac: 'b'.repeat(64) };
    const a = record({ ambient_skill_profile: profileA });
    const b = record({ run_id: 'calibration-current-skill-llll4444', condition: 'current-skill', ambient_skill_profile: profileB });
    const { committed } = buildDiag({ runKind: 'calibration', records: [a, b], failedChecksByRunId: { [a.run_id]: [], [b.run_id]: [] } });
    expect(committed.cells[0].ambient_skill_profile).toEqual(profileA);
    expect(committed.cells[1].ambient_skill_profile).toEqual(profileB);
  });

  // ambient_profile_matrix_ok (correction 6): optional param, defaults to null (calibration/smoke
  // never compute a matrix consensus) -- scenario's own call site passes the real computed value.
  it('ambient_profile_matrix_ok defaults to null when the caller omits it', () => {
    const a = record();
    const { committed } = buildDiag({ runKind: 'calibration', records: [a], failedChecksByRunId: { [a.run_id]: [] } });
    expect(committed.ambient_profile_matrix_ok).toBeNull();
  });

  it('ambient_profile_matrix_ok carries the real value the caller passes (scenario\'s own use)', () => {
    const a = scenarioRecord({ run_id: 'scenario-no-skill-mmmm5555' });
    const { committed } = buildDiag({ runKind: 'scenario', records: [a], failedChecksByRunId: { [a.run_id]: ['ambientProfileMatrixOk'] }, ambientProfileMatrixOk: false });
    expect(committed.ambient_profile_matrix_ok).toBe(false);
  });

  // Mandatory RED->GREEN reproduction (review-round-2, correction 6): "rejected profile mismatch
  // is diagnosable from the structured sidecar" -- a rejection diagnostic for a genuine
  // cross-cell ambient-profile mismatch must let a human actually SEE the mismatch: the top-level
  // ambient_profile_matrix_ok:false flag, PLUS each cell's own distinct ambient_skill_profile
  // (count/scope_id/fingerprint_hmac) preserved side by side -- never collapsed, averaged, or
  // dropped. Two cells with deliberately DIFFERENT profiles here, standing in for what
  // scenarioHardGate would have computed for a real mismatched matrix.
  it('a genuine cross-cell mismatch is fully diagnosable: ambient_profile_matrix_ok:false plus each cell\'s own distinct ambient_skill_profile, side by side', () => {
    const profileWithRun = { count: 1, scope_id: '22222222-2222-4222-8222-222222222222', fingerprint_hmac: 'a'.repeat(64) };
    const profileWithRunAndReview = { count: 2, scope_id: '22222222-2222-4222-8222-222222222222', fingerprint_hmac: 'b'.repeat(64) };
    const cellClean = scenarioRecord({ run_id: 'scenario-no-skill-nnnn6666', ambient_skill_profile: profileWithRun });
    const cellDrifted = scenarioRecord({ run_id: 'scenario-no-skill-oooo7777', ambient_skill_profile: profileWithRunAndReview });
    const { committed } = buildDiag({
      runKind: 'scenario',
      records: [cellClean, cellDrifted],
      failedChecksByRunId: { [cellClean.run_id]: ['ambientProfileMatrixOk'], [cellDrifted.run_id]: ['ambientProfileMatrixOk'] },
      ambientProfileMatrixOk: false,
    });
    expect(committed.ambient_profile_matrix_ok).toBe(false);
    // Both cells' own profiles survive independently and visibly differ -- a human reading this
    // diagnostic can directly see WHY the consensus failed (different count AND fingerprint),
    // not just that it did.
    expect(committed.cells[0].ambient_skill_profile).toEqual(profileWithRun);
    expect(committed.cells[1].ambient_skill_profile).toEqual(profileWithRunAndReview);
    expect(committed.cells[0].ambient_skill_profile.count).not.toBe(committed.cells[1].ambient_skill_profile.count);
    expect(committed.cells[0].ambient_skill_profile.fingerprint_hmac).not.toBe(committed.cells[1].ambient_skill_profile.fingerprint_hmac);
    // Still schema-valid end to end -- the strongest proof this shape is real, not just asserted.
    expect(validateRejectionRow(committed).errors).toEqual([]);
  });

  it('includes every cell, not only ones with failed_checks -- scenario batches need the whole matrix as context', () => {
    const clean = scenarioRecord({ run_id: 'scenario-no-skill-dddd4444' });
    const failing = scenarioRecord({ run_id: 'scenario-current-skill-eeee5555', condition: 'current-skill', skill_source_sha: 'b'.repeat(40) });
    const { committed } = buildDiag({
      runKind: 'scenario',
      records: [clean, failing],
      failedChecksByRunId: { [clean.run_id]: [], [failing.run_id]: ['toolResultsCompleteOk'] },
    });
    expect(committed.cells.length).toBe(2);
    expect(committed.cells.find((c) => c.run_id === clean.run_id).failed_checks).toEqual([]);
  });

  it('throws (never silently picks one) when contributing records disagree on repo_commit', () => {
    const a = record({ repo_commit: 'c'.repeat(40) });
    const b = record({ run_id: 'calibration-current-skill-ffff6666', repo_commit: 'd'.repeat(40) });
    expect(() => buildDiag({ runKind: 'calibration', records: [a, b], failedChecksByRunId: { [a.run_id]: [], [b.run_id]: [] } })).toThrow(/disagree on repo_commit/);
  });

  it('throws (never silently picks one) when contributing records disagree on model_requested', () => {
    const a = record({ model_requested: 'model-x' });
    const b = record({ run_id: 'calibration-current-skill-ffff7777', model_requested: 'model-y' });
    expect(() => buildDiag({ runKind: 'calibration', records: [a, b], failedChecksByRunId: { [a.run_id]: [], [b.run_id]: [] } })).toThrow(/disagree on model_requested/);
  });

  // Round-6 audit finding ("diagnostic provenance"): the disagreement check generalized from a
  // hardcoded repo_commit/model_requested pair to a shared BATCH_WIDE_FIELDS loop covering 10
  // fields -- this proves the loop actually reaches a field OTHER than the original two, not just
  // that the two pre-existing checks still work by coincidence of being first in the list.
  it('throws (never silently picks one) when contributing records disagree on scenario_id', () => {
    const a = scenarioRecord({ scenario_id: 'kampkit-android-host-test-discovery' });
    const b = scenarioRecord({ run_id: 'scenario-current-skill-gggg8888', condition: 'current-skill', skill_source_sha: 'b'.repeat(40), scenario_id: 'kampkit-no-applicable-tests' });
    expect(() => buildDiag({ runKind: 'scenario', records: [a, b], failedChecksByRunId: { [a.run_id]: [], [b.run_id]: [] } })).toThrow(/disagree on scenario_id/);
  });

  it('throws when contributing records disagree on seed (a scenario-only field, still checked)', () => {
    const a = scenarioRecord({ seed: 1 });
    const b = scenarioRecord({ run_id: 'scenario-current-skill-hhhh9999', condition: 'current-skill', skill_source_sha: 'b'.repeat(40), seed: 2 });
    expect(() => buildDiag({ runKind: 'scenario', records: [a, b], failedChecksByRunId: { [a.run_id]: [], [b.run_id]: [] } })).toThrow(/disagree on seed/);
  });

  // Round-7 audit finding ("atribución por celda todavía fail-open"): runKind must match every
  // record's OWN run_kind -- proves calibration-shaped records can no longer masquerade as a
  // smoke batch just because the caller's runKind parameter says so.
  it('throws when runKind does not match a record\'s own run_kind', () => {
    const a = record(); // run_kind: 'calibration'
    const b = record({ run_id: 'calibration-current-skill-jjjj2222', condition: 'current-skill' });
    expect(() => buildDiag({ runKind: 'smoke', records: [a, b], failedChecksByRunId: { [a.run_id]: [], [b.run_id]: [] } }))
      .toThrow(/runKind \('smoke'\) does not match record .+'s own run_kind \('calibration'\)/);
  });

  // Round-7 audit finding (same section): failedChecksByRunId must have EXACTLY the same key set
  // as records[].run_id -- reproduces the user's own repro shape (a key silently missing from the
  // map) as a dedicated, isolated test.
  it('throws when failedChecksByRunId is missing a key for one of the records', () => {
    const a = record();
    const b = record({ run_id: 'calibration-current-skill-kkkk3333', condition: 'current-skill' });
    expect(() => buildDiag({ runKind: 'calibration', records: [a, b], failedChecksByRunId: { [a.run_id]: ['skillSelectionOk'] } }))
      .toThrow(/failedChecksByRunId's keys must exactly match records\[\]\.run_id \(missing: \["calibration-current-skill-kkkk3333"\]/);
  });

  it('throws when failedChecksByRunId has a stale/extra key not present in records', () => {
    const a = record();
    expect(() => buildDiag({ runKind: 'calibration', records: [a], failedChecksByRunId: { [a.run_id]: ['skillSelectionOk'], 'stale-run-id-from-a-different-batch': ['x'] } }))
      .toThrow(/extra\/stale: \["stale-run-id-from-a-different-batch"\]/);
  });

  // Round-6/7 audit findings ("diagnostic provenance"): every new field must actually reach the
  // output, not just pass the disagreement check silently -- proves order_index/model_resolved/
  // claude_code_version (per-cell) and every new batch-wide provenance field land correctly,
  // INCLUDING project_url landing in `local` but NOT `committed` (the round-7 privacy finding).
  it('populates order_index/model_resolved/claude_code_version per cell, and every new batch-wide provenance field, from the records', () => {
    const a = scenarioRecord({
      order_index: 0, model_resolved: 'claude-sonnet-5-2026-06-01', claude_code_version: '2.0.0-fake',
      scenario_id: 'kampkit-android-host-test-discovery', project_alias: 'kampkit', project_commit: 'd'.repeat(40),
      project_url: 'https://github.com/example/kampkit', seed: 7, policy_sha256: 'b'.repeat(64),
      platform: 'linux', privacy_status: 'redacted-private',
    });
    const b = scenarioRecord({
      run_id: 'scenario-current-skill-iiii0000', condition: 'current-skill', skill_source_sha: 'a'.repeat(40),
      order_index: 1, model_resolved: 'claude-sonnet-5-2026-06-01', claude_code_version: '2.0.0-fake',
      scenario_id: 'kampkit-android-host-test-discovery', project_alias: 'kampkit', project_commit: 'd'.repeat(40),
      project_url: 'https://github.com/example/kampkit', seed: 7, policy_sha256: 'b'.repeat(64),
      platform: 'linux', privacy_status: 'redacted-private',
    });
    // ambientProfileMatrixOk (round-3 audit finding): a real scenario diagnostic ALWAYS carries a
    // real boolean here (cli.mjs's finalizeAndWriteMatrixRecords always passes gate.ambientProfileMatrixOk,
    // never leaves the default) -- true, and coherent with neither cell's failed_checks below
    // flagging 'ambientProfileMatrixOk', matching validateAmbientProfileMatrixOk's own coherence rule.
    const { committed, local } = buildDiag({ runKind: 'scenario', records: [a, b], failedChecksByRunId: { [a.run_id]: ['toolResultsCompleteOk'], [b.run_id]: [] }, ambientProfileMatrixOk: true });
    expect(committed.scenario_id).toBe('kampkit-android-host-test-discovery');
    expect(committed.project_alias).toBe('kampkit');
    expect(committed.project_commit).toBe('d'.repeat(40));
    expect(committed.seed).toBe(7);
    expect(committed.policy_sha256).toBe('b'.repeat(64));
    expect(committed.platform).toBe('linux');
    expect(committed.privacy_status).toBe('redacted-private');
    expect(committed.cells[0].order_index).toBe(0);
    expect(committed.cells[1].order_index).toBe(1);
    expect(committed.cells[0].model_resolved).toBe('claude-sonnet-5-2026-06-01');
    expect(committed.cells[0].claude_code_version).toBe('2.0.0-fake');
    // project_url: never in committed (round-7 privacy finding), present at the LOCAL tier's
    // TOP level (batch-wide, like project_alias/project_commit) -- not re-derived per cell.
    expect('project_url' in committed).toBe(false);
    expect(JSON.stringify(committed)).not.toContain('github.com/example/kampkit');
    expect(local.project_url).toBe('https://github.com/example/kampkit');
    // The record built from `committed` is itself schema-valid -- the strongest possible proof
    // that every new field landed in a shape validateRejectionRow actually accepts.
    expect(validateRejectionRow(committed).errors).toEqual([]);
  });
});

describe('validateRejectionRow -- schema validation', () => {
  const AMBIENT_PROFILE_FIXTURE = { count: 0, scope_id: '00000000-0000-4000-8000-000000000000', fingerprint_hmac: '0'.repeat(64) };

  function validRow(overrides = {}) {
    // unexpected_tool_uses_count: 0 on both -- coherent with the biconditional this fix adds
    // (validateRejectionRow requires count>0 IFF failed_checks includes 'noUnexpectedToolsOk';
    // neither cell's failed_checks includes it, so 0 is the only valid value for either).
    const cellA = { run_id: 'r1', condition: 'no-skill', repetition_index: null, order_index: null, skill_source_sha: null, model_resolved: 'claude-sonnet-5-fake-resolved', claude_code_version: '1.2.3-fake', failed_checks: ['skillSelectionOk'], foreign_skill_summary: { rejected: 0, confirmed: 1, incomplete: 0 }, ambient_skill_profile: AMBIENT_PROFILE_FIXTURE, unexpected_tool_uses_count: 0 };
    const cellB = { run_id: 'r2', condition: 'current-skill', repetition_index: null, order_index: null, skill_source_sha: 'a'.repeat(40), model_resolved: 'claude-sonnet-5-fake-resolved', claude_code_version: '1.2.3-fake', failed_checks: [], foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 }, ambient_skill_profile: AMBIENT_PROFILE_FIXTURE, unexpected_tool_uses_count: 0 };
    return {
      // Explicitly v3 (a real policy_sha256 below, no execution_profile) -- never
      // LATEST_REJECTION_DIAGNOSTICS_SCHEMA, which now means schema 4 and requires
      // policy_sha256:null instead.
      schema: REJECTION_DIAGNOSTICS_SCHEMA_V3,
      rejection_id: '11111111-1111-1111-1111-111111111111',
      timestamp: '2026-07-21T00:00:00.000Z',
      run_kind: 'calibration',
      run_ids: ['r1', 'r2'],
      model_requested: 'fake-model-x',
      repo_commit: 'c'.repeat(40),
      scenario_id: 'calibration-explicit-invocation',
      // Matches validateProvenanceForRunKind's own fixed calibration shape -- project_alias is
      // NEVER null for a real record (buildRunRecord's own default), only project_commit/seed are.
      project_alias: 'calibration-project',
      project_commit: null,
      seed: null,
      policy_sha256: 'a'.repeat(64),
      platform: 'linux',
      privacy_status: 'public',
      cells: [cellA, cellB],
      foreign_skill_summary: { rejected: 0, confirmed: 1, incomplete: 0 },
      // ambient_profile_matrix_ok (review-round-2 fix): null for calibration/smoke (no matrix
      // consensus concept -- see cli.mjs's scenarioHardGate), a real boolean for scenario.
      ambient_profile_matrix_ok: null,
      // matrix_complete/planned_cell_count/executed_cell_count/raw_transcripts_persisted
      // (preserve rejected matrix forensics fix): a normal, complete 2-cell batch by default.
      matrix_complete: true,
      planned_cell_count: 2,
      executed_cell_count: 2,
      raw_transcripts_persisted: true,
      ...overrides,
    };
  }

  it('accepts a well-formed row cleanly', () => {
    const { errors } = validateRejectionRow(validRow());
    expect(errors).toEqual([]);
  });

  it('rejects an unrecognized top-level field (closed key set)', () => {
    const { errors } = validateRejectionRow({ ...validRow(), unexpected_field: 'x' });
    expect(errors.some((e) => e.field === 'unexpected_field')).toBe(true);
  });

  it('rejects an unrecognized field nested inside a cells[] entry (closed key set, not just top-level)', () => {
    const row = validRow();
    row.cells[0] = { ...row.cells[0], unexpected: 'x' };
    const { errors } = validateRejectionRow(row);
    expect(errors.some((e) => e.field === 'cells[0].unexpected')).toBe(true);
  });

  it('rejects an unrecognized field nested inside foreign_skill_summary (closed key set at every nesting level)', () => {
    const row = validRow();
    row.foreign_skill_summary = { ...row.foreign_skill_summary, extra: 1 };
    const { errors } = validateRejectionRow(row);
    expect(errors.some((e) => e.field === 'foreign_skill_summary.extra')).toBe(true);
  });

  it('rejects duplicate run_id values within cells[]', () => {
    const row = validRow();
    row.cells[1] = { ...row.cells[1], run_id: 'r1' };
    row.run_ids = ['r1', 'r1'];
    const { errors } = validateRejectionRow(row);
    expect(errors.some((e) => e.field === 'cells[1].run_id' && e.message.includes('duplicate'))).toBe(true);
  });

  it('rejects run_ids[] and cells[].run_id disagreeing (not just overlapping)', () => {
    const row = validRow();
    row.run_ids = ['r1', 'r2', 'r3-not-in-cells'];
    const { errors } = validateRejectionRow(row);
    expect(errors.some((e) => e.field === 'run_ids')).toBe(true);
  });

  it('rejects a truncated (non-UUID-shaped) rejection_id', () => {
    const { errors } = validateRejectionRow({ ...validRow(), rejection_id: 'abcd1234' });
    expect(errors.some((e) => e.field === 'rejection_id')).toBe(true);
  });

  it('rejects a negative foreign_skill_summary count', () => {
    const row = validRow();
    row.foreign_skill_summary = { rejected: -1, confirmed: 1, incomplete: 0 };
    const { errors } = validateRejectionRow(row);
    expect(errors.some((e) => e.field === 'foreign_skill_summary.rejected')).toBe(true);
  });

  // ambient_skill_profile per-cell (review-round-2 fix, correction 6): mirrors
  // foreign_skill_summary's own validation coverage one field over -- every rejected batch now
  // carries each cell's OWN profile validity/count/opaque-scope-fingerprint, never the raw skill
  // names (those stay local-tier-only, exactly like foreign_skill_names already does).
  describe('ambient_skill_profile per cell + ambient_profile_matrix_ok (correction 6)', () => {
    it('accepts the well-formed default cleanly', () => {
      const { errors } = validateRejectionRow(validRow());
      expect(errors.filter((e) => e.field.includes('ambient_skill_profile') || e.field === 'ambient_profile_matrix_ok')).toEqual([]);
    });

    it('rejects a missing ambient_skill_profile on a cell', () => {
      const row = validRow();
      delete row.cells[0].ambient_skill_profile;
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'cells[0].ambient_skill_profile')).toBe(true);
    });

    it('rejects an unrecognized field nested inside a cell\'s ambient_skill_profile (closed key set)', () => {
      const row = validRow();
      row.cells[0] = { ...row.cells[0], ambient_skill_profile: { ...row.cells[0].ambient_skill_profile, extra: 1 } };
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'cells[0].ambient_skill_profile.extra')).toBe(true);
    });

    it('rejects a negative count in a cell\'s ambient_skill_profile', () => {
      const row = validRow();
      row.cells[0] = { ...row.cells[0], ambient_skill_profile: { ...row.cells[0].ambient_skill_profile, count: -1 } };
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'cells[0].ambient_skill_profile.count')).toBe(true);
    });

    it('rejects a malformed scope_id in a cell\'s ambient_skill_profile', () => {
      const row = validRow();
      row.cells[0] = { ...row.cells[0], ambient_skill_profile: { ...row.cells[0].ambient_skill_profile, scope_id: 'not-a-uuid' } };
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'cells[0].ambient_skill_profile.scope_id')).toBe(true);
    });

    it('rejects a malformed fingerprint_hmac in a cell\'s ambient_skill_profile', () => {
      const row = validRow();
      row.cells[0] = { ...row.cells[0], ambient_skill_profile: { ...row.cells[0].ambient_skill_profile, fingerprint_hmac: 'not-hex' } };
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'cells[0].ambient_skill_profile.fingerprint_hmac')).toBe(true);
    });

    it('never carries a raw skill name anywhere in the committed shape -- count/scope_id/fingerprint_hmac only', () => {
      const { errors } = validateRejectionRow(validRow());
      expect(errors).toEqual([]);
      expect(JSON.stringify(validRow())).not.toMatch(/"run"|"review"/);
    });

    // Builds a genuinely run_kind:'scenario'-shaped row (real project_alias/project_commit/seed,
    // integer repetition_index/order_index on every cell -- mirrors the existing
    // "run_kind-specific provenance shape" describe block's own scenario overrides below) so
    // ambient_profile_matrix_ok's scenario-side rules are exercised on a row that is ACTUALLY
    // scenario-shaped, not merely a calibration row with one field overridden.
    function scenarioShapedValidRow(overrides = {}) {
      const row = validRow({
        run_kind: 'scenario', scenario_id: 'kampkit-android-host-test-discovery',
        project_alias: 'kampkit', project_commit: 'd'.repeat(40), seed: 5,
        ambient_profile_matrix_ok: true,
      });
      row.cells = row.cells.map((c, i) => ({ ...c, repetition_index: 0, order_index: i }));
      return { ...row, ...overrides };
    }

    it('ambient_profile_matrix_ok accepts null for calibration', () => {
      const { errors } = validateRejectionRow({ ...validRow(), ambient_profile_matrix_ok: null });
      expect(errors.filter((e) => e.field === 'ambient_profile_matrix_ok')).toEqual([]);
    });

    it('ambient_profile_matrix_ok accepts null for smoke', () => {
      const row = validRow({ run_kind: 'smoke', scenario_id: 'smoke-explicit-invocation', project_alias: 'kampkit', project_commit: 'd'.repeat(40), ambient_profile_matrix_ok: null });
      const { errors } = validateRejectionRow(row);
      expect(errors.filter((e) => e.field === 'ambient_profile_matrix_ok')).toEqual([]);
    });

    // Round-3 audit finding (CodeRabbit Major thread on commit 45e3522, unresolved until this fix):
    // this test's own title previously claimed to cover "a real boolean (scenario)", but only ever
    // overrode ambient_profile_matrix_ok on top of validRow()'s CALIBRATION default -- so it
    // actually asserted a CALIBRATION row carrying a real boolean validated cleanly. Reproduced
    // directly against the pre-fix validator before this correction. Now correctly a rejection:
    // calibration requires EXACTLY null, no matrix/consensus concept applies to a plain A/B pair.
    it('rejects a non-null ambient_profile_matrix_ok on a calibration row', () => {
      const { errors } = validateRejectionRow({ ...validRow(), ambient_profile_matrix_ok: false });
      expect(errors.some((e) => e.field === 'ambient_profile_matrix_ok' && e.message.includes("must be null for run_kind:'calibration'"))).toBe(true);
    });

    it('ambient_profile_matrix_ok accepts a real boolean on a genuinely scenario-shaped row', () => {
      const { errors } = validateRejectionRow(scenarioShapedValidRow({ ambient_profile_matrix_ok: true }));
      expect(errors.filter((e) => e.field === 'ambient_profile_matrix_ok')).toEqual([]);
    });

    it('rejects a null ambient_profile_matrix_ok on a genuinely scenario-shaped row', () => {
      const { errors } = validateRejectionRow(scenarioShapedValidRow({ ambient_profile_matrix_ok: null }));
      expect(errors.some((e) => e.field === 'ambient_profile_matrix_ok' && e.message.includes("must be a boolean for run_kind:'scenario'"))).toBe(true);
    });

    it('rejects a non-boolean, non-null ambient_profile_matrix_ok on a calibration row', () => {
      const { errors } = validateRejectionRow({ ...validRow(), ambient_profile_matrix_ok: 'yes' });
      expect(errors.some((e) => e.field === 'ambient_profile_matrix_ok')).toBe(true);
    });

    it('rejects a non-boolean, non-null ambient_profile_matrix_ok on a scenario row', () => {
      const { errors } = validateRejectionRow(scenarioShapedValidRow({ ambient_profile_matrix_ok: 'yes' }));
      expect(errors.some((e) => e.field === 'ambient_profile_matrix_ok')).toBe(true);
    });

    it('rejects a missing ambient_profile_matrix_ok key entirely (closed, required key set)', () => {
      const row = validRow();
      delete row.ambient_profile_matrix_ok;
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'ambient_profile_matrix_ok')).toBe(true);
    });

    // Round-3 audit finding: "el diagnóstico no valida la coherencia interna del perfil" -- prior
    // to this fix, cells[].ambient_skill_profile was validated ONLY in isolation per cell; nothing
    // related cells to EACH OTHER or to the batch's own top-level ambient_profile_matrix_ok claim.
    // Reproduced directly: a hand-built row with ambient_profile_matrix_ok:true but two DIFFERENT
    // scope_id/count/fingerprint_hmac values across its cells validated with zero errors.
    describe('cross-cell coherence (round-3 audit finding)', () => {
      it('accepts a genuinely coherent scenario row unchanged (same scope_id, identical profiles, matrix_ok:true, no cell flags it)', () => {
        const { errors } = validateRejectionRow(scenarioShapedValidRow());
        expect(errors).toEqual([]);
      });

      it('rejects matrix_ok:true when cells disagree on scope_id', () => {
        const row = scenarioShapedValidRow();
        row.cells[1] = { ...row.cells[1], ambient_skill_profile: { ...row.cells[1].ambient_skill_profile, scope_id: '99999999-9999-4999-8999-999999999999' } };
        const { errors } = validateRejectionRow(row);
        expect(errors.some((e) => e.field === 'cells' && e.message.includes('exactly one ambient_skill_profile.scope_id'))).toBe(true);
      });

      it('rejects matrix_ok:true when cells share one scope_id but disagree on count/fingerprint_hmac', () => {
        const row = scenarioShapedValidRow();
        row.cells[1] = { ...row.cells[1], ambient_skill_profile: { ...row.cells[1].ambient_skill_profile, count: 99, fingerprint_hmac: 'f'.repeat(64) } };
        const { errors } = validateRejectionRow(row);
        expect(errors.some((e) => e.field === 'ambient_profile_matrix_ok' && e.message.includes('differs across cells'))).toBe(true);
      });

      it('does NOT require identical profiles when matrix_ok:false -- a single malformed cell can fail the matrix while ambient names coincidentally still differ', () => {
        const row = scenarioShapedValidRow({ ambient_profile_matrix_ok: false });
        row.cells = row.cells.map((c) => ({ ...c, failed_checks: ['ambientProfileMatrixOk'] }));
        row.cells[1] = { ...row.cells[1], ambient_skill_profile: { ...row.cells[1].ambient_skill_profile, count: 99, fingerprint_hmac: 'f'.repeat(64) } };
        const { errors } = validateRejectionRow(row);
        expect(errors.filter((e) => e.field === 'ambient_profile_matrix_ok')).toEqual([]);
      });

      // THE USER'S OWN REPRODUCTION, verbatim: a scenario diagnostic with ambient_profile_matrix_ok
      // false must show that specific failure attributed on EVERY cell's own failed_checks -- it is
      // one shared matrix-wide value (cli.mjs's scenarioCellIntegrityOk threads the identical
      // boolean into every cell), so it can never legitimately fail for only some cells.
      it('rejects matrix_ok:false when not every cell shows ambientProfileMatrixOk in its own failed_checks', () => {
        const row = scenarioShapedValidRow({ ambient_profile_matrix_ok: false });
        row.cells[0] = { ...row.cells[0], failed_checks: ['ambientProfileMatrixOk'] };
        // row.cells[1].failed_checks stays [] -- the exact "rejection with no recorded cause on
        // this cell" gap the user's own reproduction demonstrated.
        const { errors } = validateRejectionRow(row);
        expect(errors.some((e) => e.field === 'ambient_profile_matrix_ok' && e.message.includes('only 1/2 cells show'))).toBe(true);
      });

      it('rejects matrix_ok:true when some cell still shows ambientProfileMatrixOk in its own failed_checks (contradicts the claimed agreement)', () => {
        const row = scenarioShapedValidRow({ ambient_profile_matrix_ok: true });
        row.cells[0] = { ...row.cells[0], failed_checks: ['ambientProfileMatrixOk'] };
        const { errors } = validateRejectionRow(row);
        expect(errors.some((e) => e.field === 'ambient_profile_matrix_ok' && e.message.includes('contradicts the batch-wide agreement'))).toBe(true);
      });

      it('never applies the failed_checks-coherence rule to calibration/smoke (ambient_profile_matrix_ok is always null there, not a boolean)', () => {
        const row = validRow(); // calibration, ambient_profile_matrix_ok: null by default
        row.cells = row.cells.map((c) => ({ ...c, failed_checks: [] }));
        const { errors } = validateRejectionRow(row);
        expect(errors.filter((e) => e.field === 'ambient_profile_matrix_ok')).toEqual([]);
      });
    });
  });

  it('rejects a top-level foreign_skill_summary that does not equal the sum across cells[]', () => {
    const row = validRow();
    row.foreign_skill_summary = { rejected: 0, confirmed: 99, incomplete: 0 };
    const { errors } = validateRejectionRow(row);
    expect(errors.some((e) => e.field === 'foreign_skill_summary.confirmed')).toBe(true);
  });

  it('rejects an unknown run_kind', () => {
    const { errors } = validateRejectionRow({ ...validRow(), run_kind: 'not-a-real-kind' });
    expect(errors.some((e) => e.field === 'run_kind')).toBe(true);
  });

  it('rejects a repetition_index that is neither null nor a non-negative integer', () => {
    const row = validRow();
    row.cells[0] = { ...row.cells[0], repetition_index: -1 };
    const { errors } = validateRejectionRow(row);
    expect(errors.some((e) => e.field === 'cells[0].repetition_index')).toBe(true);
  });

  // "Rechazo sin causa" (round-6 audit finding): a rejection diagnostic every one of whose cells
  // carries failed_checks:[] records no cause anywhere -- structurally indistinguishable from a
  // rejection that never actually happened. validRow()'s own cellA already has one real failed
  // check ('skillSelectionOk'), so this test explicitly empties BOTH cells to isolate the invariant.
  it('rejects a row where EVERY cell has empty failed_checks -- a rejection with no recorded cause', () => {
    const row = validRow();
    row.cells = row.cells.map((c) => ({ ...c, failed_checks: [] }));
    const { errors } = validateRejectionRow(row);
    expect(errors.some((e) => e.field === 'cells' && e.message.includes('no recorded failure'))).toBe(true);
  });

  it('accepts a row where only ONE cell (not all) has a real failed check', () => {
    const row = validRow();
    row.cells[0] = { ...row.cells[0], failed_checks: ['skillSelectionOk'] };
    row.cells[1] = { ...row.cells[1], failed_checks: [] };
    const { errors } = validateRejectionRow(row);
    expect(errors.filter((e) => e.field === 'cells')).toEqual([]);
  });

  // "Coherencia con run_kind" (round-6 audit finding): the pre-fix shape check ("null OR a
  // non-negative integer") accepted EITHER shape for ANY run_kind -- a calibration/smoke row could
  // carry a real repetition_index/order_index (repetition/order concepts don't apply outside
  // run_kind:'scenario' at all), or a scenario row could carry null (silently discarding which
  // repetition/position a cell actually was). Both directions proven explicitly, for both fields.
  describe('repetition_index/order_index coherence with run_kind', () => {
    it('rejects a non-null repetition_index on a run_kind:calibration row (validRow default)', () => {
      const row = validRow();
      row.cells[0] = { ...row.cells[0], repetition_index: 0 };
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'cells[0].repetition_index' && e.message.includes("run_kind:'calibration'"))).toBe(true);
    });

    it('rejects a non-null order_index on a run_kind:smoke row', () => {
      const row = validRow({ run_kind: 'smoke' });
      row.cells[0] = { ...row.cells[0], order_index: 0 };
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'cells[0].order_index')).toBe(true);
    });

    it('rejects a null repetition_index AND null order_index on a run_kind:scenario row', () => {
      const row = validRow({ run_kind: 'scenario', scenario_id: 'kampkit-android-host-test-discovery', project_alias: 'kampkit', project_commit: 'd'.repeat(40), seed: 5 });
      row.cells[0] = { ...row.cells[0], repetition_index: null, order_index: null };
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'cells[0].repetition_index' && e.message.includes("run_kind:'scenario'"))).toBe(true);
      expect(errors.some((e) => e.field === 'cells[0].order_index')).toBe(true);
    });

    it('accepts a real non-negative repetition_index/order_index on a run_kind:scenario row', () => {
      const row = validRow({ run_kind: 'scenario', scenario_id: 'kampkit-android-host-test-discovery', project_alias: 'kampkit', project_commit: 'd'.repeat(40), seed: 5 });
      row.cells = row.cells.map((c, i) => ({ ...c, repetition_index: 0, order_index: i }));
      const { errors } = validateRejectionRow(row);
      expect(errors.filter((e) => e.field.includes('repetition_index') || e.field.includes('order_index'))).toEqual([]);
    });

    // An unrecognized run_kind is already reported on its own field -- must not ALSO cascade into
    // a wall of misleading repetition_index/order_index errors for every cell (the coherence check
    // is gated on run_kind being a KNOWN value first).
    it('does not cascade repetition_index/order_index errors when run_kind itself is unrecognized', () => {
      const row = validRow({ run_kind: 'not-a-real-kind' });
      const { errors } = validateRejectionRow(row);
      expect(errors.filter((e) => e.field.includes('repetition_index') || e.field.includes('order_index'))).toEqual([]);
    });
  });

  // Round-8 audit finding: skill_source_sha's shape check ("null or a non-empty string") was
  // never actually tied to the cell's own `condition`, contradicting both this file's own
  // pre-existing comment and the main run-record schema's real, enforced relationship
  // (schemas.mjs:219-223) -- reproduced directly: a no-skill cell with a real SHA, and a
  // current-skill cell with a null SHA, both validated with zero errors.
  describe('skill_source_sha coherence with condition (round-8 audit finding)', () => {
    it('rejects a no-skill cell carrying a real (non-null) skill_source_sha', () => {
      const row = validRow();
      row.cells[0] = { ...row.cells[0], condition: 'no-skill', skill_source_sha: 'a'.repeat(40) };
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'cells[0].skill_source_sha' && e.message.includes("not 'current-skill'"))).toBe(true);
    });

    it('rejects a current-skill cell carrying a null skill_source_sha', () => {
      const row = validRow();
      row.cells[1] = { ...row.cells[1], condition: 'current-skill', skill_source_sha: null };
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'cells[1].skill_source_sha' && e.message.includes("'current-skill'"))).toBe(true);
    });

    it('rejects a current-skill cell carrying an empty-string skill_source_sha (real, non-empty required)', () => {
      const row = validRow();
      row.cells[1] = { ...row.cells[1], condition: 'current-skill', skill_source_sha: '' };
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'cells[1].skill_source_sha')).toBe(true);
    });

    it('accepts the coherent pairing (no-skill/null, current-skill/real SHA) -- validRow\'s own default', () => {
      const { errors } = validateRejectionRow(validRow());
      expect(errors.filter((e) => e.field.includes('skill_source_sha'))).toEqual([]);
    });
  });

  describe('provenance fields (round-6/7 audit findings: scenario_id/project_*/seed/policy_sha256/platform/privacy_status)', () => {
    it('rejects a missing scenario_id', () => {
      const row = validRow();
      delete row.scenario_id;
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'scenario_id')).toBe(true);
    });

    it('rejects a malformed policy_sha256 (not a 64-char lowercase hex string)', () => {
      const row = validRow({ policy_sha256: 'not-a-real-hash' });
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'policy_sha256')).toBe(true);
    });

    it('rejects an unrecognized platform', () => {
      const row = validRow({ platform: 'not-a-real-platform' });
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'platform')).toBe(true);
    });

    it('rejects an unrecognized privacy_status', () => {
      const row = validRow({ privacy_status: 'not-a-real-status' });
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'privacy_status')).toBe(true);
    });

    it('rejects an empty-string project_alias on a calibration row (must be exactly \'calibration-project\')', () => {
      const row = validRow({ project_alias: '' });
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'project_alias')).toBe(true);
    });

    // Round-7 audit finding ("la procedencia por tipo de run no está realmente cerrada"): each
    // run_kind's provenance shape tested BOTH ways -- its own genuine shape accepted cleanly, and
    // every OTHER run_kind's shape (or an all-null one) explicitly rejected. The scenario case is
    // the user's own literal reproduction: a scenario diagnostic with every project_* field AND
    // seed left null previously validated with ZERO errors, indistinguishable from a genuinely
    // nullish calibration row.
    describe('run_kind-specific provenance shape', () => {
      it('accepts calibration\'s own fixed shape (project_alias:"calibration-project", project_commit/seed null)', () => {
        const { errors } = validateRejectionRow(validRow());
        expect(errors.filter((e) => e.field === 'project_alias' || e.field === 'project_commit' || e.field === 'seed')).toEqual([]);
      });

      it('rejects a calibration row with a real (non-fixed) project_alias -- not just "any non-null string"', () => {
        const row = validRow({ project_alias: 'some-other-project' });
        const { errors } = validateRejectionRow(row);
        expect(errors.some((e) => e.field === 'project_alias' && e.message.includes("'calibration-project'"))).toBe(true);
      });

      it('rejects a calibration row with a non-null project_commit', () => {
        const row = validRow({ project_commit: 'd'.repeat(40) });
        const { errors } = validateRejectionRow(row);
        expect(errors.some((e) => e.field === 'project_commit')).toBe(true);
      });

      it('rejects a calibration row with a non-null seed', () => {
        const row = validRow({ seed: 3 });
        const { errors } = validateRejectionRow(row);
        expect(errors.some((e) => e.field === 'seed')).toBe(true);
      });

      it('accepts smoke\'s own real-project shape (project_alias/project_commit non-null, seed null)', () => {
        const row = validRow({ run_kind: 'smoke', scenario_id: 'smoke-explicit-invocation', project_alias: 'kampkit', project_commit: 'd'.repeat(40) });
        const { errors } = validateRejectionRow(row);
        expect(errors.filter((e) => e.field === 'project_alias' || e.field === 'project_commit' || e.field === 'seed')).toEqual([]);
      });

      // Round-8 audit finding (CodeRabbit): this test's own title previously claimed to cover a
      // null project_alias too, but validRow()'s default project_alias is 'calibration-project'
      // (a non-null placeholder that happens to also satisfy smoke's "real, non-empty string"
      // check) -- only project_commit was ever actually asserted null-and-rejected here.
      // Production behavior was never wrong (validateProvenanceForRunKind's smoke branch does
      // reject a genuinely-null project_alias), only this test's own coverage was incomplete;
      // split into two isolated cases so each field's rejection is actually exercised.
      it('rejects a smoke row with a null project_commit (project_alias left at its non-null default)', () => {
        const row = validRow({ run_kind: 'smoke', scenario_id: 'smoke-explicit-invocation' }); // project_commit still calibration's null default
        const { errors } = validateRejectionRow(row);
        expect(errors.some((e) => e.field === 'project_commit')).toBe(true);
      });

      it('rejects a smoke row with a null project_alias', () => {
        const row = validRow({ run_kind: 'smoke', scenario_id: 'smoke-explicit-invocation', project_alias: null, project_commit: 'd'.repeat(40) });
        const { errors } = validateRejectionRow(row);
        expect(errors.some((e) => e.field === 'project_alias')).toBe(true);
      });

      it('accepts scenario\'s own real-project shape (project_alias/project_commit non-null, seed a real integer)', () => {
        const row = validRow({ run_kind: 'scenario', scenario_id: 'kampkit-android-host-test-discovery', project_alias: 'kampkit', project_commit: 'd'.repeat(40), seed: 5 });
        row.cells = row.cells.map((c, i) => ({ ...c, repetition_index: 0, order_index: i }));
        const { errors } = validateRejectionRow(row);
        expect(errors.filter((e) => e.field === 'project_alias' || e.field === 'project_commit' || e.field === 'seed')).toEqual([]);
      });

      // THE USER'S OWN REPRODUCTION, verbatim: a scenario diagnostic with project_alias,
      // project_commit, AND seed all null must NOT validate cleanly -- this is the exact case that
      // silently passed before this round's fix.
      it('rejects a scenario row with project_alias/project_commit/seed ALL null (the exact reported repro)', () => {
        const row = validRow({ run_kind: 'scenario', scenario_id: 'kampkit-android-host-test-discovery', project_alias: null, project_commit: null, seed: null });
        row.cells = row.cells.map((c, i) => ({ ...c, repetition_index: 0, order_index: i }));
        const { errors } = validateRejectionRow(row);
        expect(errors.some((e) => e.field === 'project_alias')).toBe(true);
        expect(errors.some((e) => e.field === 'project_commit')).toBe(true);
        expect(errors.some((e) => e.field === 'seed')).toBe(true);
      });

      it('rejects a scenario row with a non-integer seed', () => {
        const row = validRow({ run_kind: 'scenario', scenario_id: 'kampkit-android-host-test-discovery', project_alias: 'kampkit', project_commit: 'd'.repeat(40), seed: 'five' });
        row.cells = row.cells.map((c, i) => ({ ...c, repetition_index: 0, order_index: i }));
        const { errors } = validateRejectionRow(row);
        expect(errors.some((e) => e.field === 'seed')).toBe(true);
      });

      // corpus-probe: reserved for a future run_kind never actually produced by this codebase --
      // must fail closed (an explicit, named error), never silently accept an unvalidated shape.
      it('fails closed on run_kind:corpus-probe -- provenance shape genuinely undefined, not "anything goes"', () => {
        const row = validRow({ run_kind: 'corpus-probe' });
        const { errors } = validateRejectionRow(row);
        expect(errors.some((e) => e.field === 'run_kind' && e.message.includes('not yet defined'))).toBe(true);
      });
    });
  });
});

// validate -> redact -> revalidate ordering (round-5 audit finding, C2's own doc comment):
// mirrors finalizeAndWriteRecords' identical ordering for real evidence -- a redaction rule that
// happens to corrupt a required field's SHAPE (not just its content) must be caught by the
// post-redaction revalidate step, never silently promoted. redactValue() only ever touches STRING
// field values (see privacy.mjs's own doc comment), so the target must be a string field with its
// own shape constraint beyond "is a string" -- rejection_id's strict UUID regex is exactly that.
describe('writeRejectedRunDiagnostics -- validate -> redact -> revalidate ordering', () => {
  function writeTempPatternsFile(entries) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aerd-patterns-'));
    const file = path.join(dir, 'patterns.json');
    writeFileSync(file, JSON.stringify(entries));
    return file;
  }

  it('a redaction rule that mangles rejection_id out of its required UUID shape is caught by revalidation, never promoted', () => {
    const r = record();
    const r2 = record({ run_id: 'calibration-current-skill-bbbb2222', condition: 'current-skill', skill_source_sha: 'a'.repeat(40) });
    const { committed, local } = buildDiag({
      runKind: 'calibration',
      records: [r, r2],
      // At least one real failed check -- an empty failedChecksByRunId would produce
      // failed_checks:[] on every cell, itself now a distinct validation failure ("rechazo sin
      // causa" -- see the dedicated describe block below), which would trip THIS test for the
      // wrong reason entirely.
      failedChecksByRunId: { [r.run_id]: ['skillSelectionOk'], [r2.run_id]: [] },
    });
    // The ORIGINAL (pre-redaction) record is genuinely valid -- confirms any throw below comes
    // from the redaction step corrupting it, not from a pre-existing malformed input.
    expect(validateRejectionRow(committed).errors).toEqual([]);

    // Matches a literal substring of the REAL, just-generated rejection_id (its first UUID
    // segment) and replaces it with a non-hex placeholder -- breaks
    // validateRejectionRow's `^[0-9a-f]{8}-...` regex while leaving every other field untouched.
    const uuidFirstSegment = committed.rejection_id.split('-')[0];
    const privatePatternsFile = writeTempPatternsFile([{ class: 'test_corrupt_uuid', literal: uuidFirstSegment, replacement: 'NOT-HEX-AT-ALL' }]);
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aerd-corrupt-runs-root-'));
    try {
      expect(() => writeRejectedRunDiagnostics({ committed, local }, { privatePatternsFile, runsRootOverride: runsRoot })).toThrow(/redaction corrupted the committed record's shape/);
      // Refusing to write means refusing to write -- nothing promoted under either tier.
      expect(existsSync(path.join(runsRoot, 'agentic-eval-rejected'))).toBe(false);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
      rmSync(path.join(privatePatternsFile, '..'), { recursive: true, force: true });
    }
  });
});

// "Localización del diagnóstico" (round-6 audit finding): the old contract returned a bare
// `outDir` string, telling a caller WHERE the committed-tier DIRECTORY is but nothing about the
// specific FILE just written or its own id -- a caller had no way to point a human at what
// actually happened. relativePath is relative to RUNS_ROOT (never the absolute filesystem path
// -- see this module's own doc comment) specifically so it's safe to print without a further
// privacy pass.
describe('writeRejectedRunDiagnostics -- return shape (round-6 audit finding: "localización del diagnóstico")', () => {
  it('returns {outDir, rejectionId, relativePath}, with relativePath pointing at the actual written file, relative to RUNS_ROOT', () => {
    const r = record();
    const r2 = record({ run_id: 'calibration-current-skill-jjjj1111', condition: 'current-skill', skill_source_sha: 'a'.repeat(40) });
    const { committed, local } = buildDiag({
      runKind: 'calibration',
      records: [r, r2],
      failedChecksByRunId: { [r.run_id]: ['skillSelectionOk'], [r2.run_id]: [] },
    });
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aerd-return-shape-'));
    try {
      const result = writeRejectedRunDiagnostics({ committed, local }, { runsRootOverride: runsRoot });
      expect(result.rejectionId).toBe(committed.rejection_id);
      expect(result.outDir).toBe(path.join(runsRoot, 'agentic-eval-rejected'));
      // Never an absolute path -- path.isAbsolute is the direct, platform-correct check (a raw
      // string-prefix comparison would be wrong on Windows, where an absolute path can start with
      // a drive letter, not always a leading slash).
      expect(path.isAbsolute(result.relativePath)).toBe(false);
      expect(result.relativePath).toBe(path.join('agentic-eval-rejected', `${committed.rejection_id}.json`));
      // The relative path genuinely resolves to the real, just-written file -- not merely a
      // plausible-looking string.
      expect(existsSync(path.join(runsRoot, result.relativePath))).toBe(true);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });
});

// Real end-to-end integration: cli.mjs's actual gate-failure branches, driven exactly like
// agentic-eval-cli-integration.test.js's own tests, reusing the ALREADY-committed
// fake-claude-foreign-skill fixture (a real, confirmed-foreign-skill calibrate rejection).
describe('writeRejectedRunDiagnostics -- wired into cli.mjs end-to-end (real subprocess)', () => {
  function runsRootFor(fn) {
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aerd-runs-root-'));
    try {
      return fn(runsRoot);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  }

  function fakeClaudeEnv(scenario, runsRoot) {
    const fakeDir = path.join(FIXTURES_DIR, `fake-claude-${scenario}`);
    const delimiter = process.platform === 'win32' ? ';' : ':';
    return { ...process.env, PATH: `${fakeDir}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`, KMP_EVAL_RUNS_ROOT: runsRoot };
  }

  it('a real calibrate rejection writes exactly one committed + one raw rejection-diagnostics file, and nothing under the real evidence directory', () => {
    runsRootFor((runsRoot) => {
      const r = spawnSync('node', [CLI_PATH, 'calibrate', '--model', 'claude-sonnet-5'], { env: fakeClaudeEnv('foreign-skill', runsRoot), encoding: 'utf8', timeout: 20000 });
      // Round-7 audit finding: a bare expect(r.status).toBe(1) gives no diagnostic surface at all
      // when it fails -- status alone doesn't distinguish a normal exit(2) (cmdCalibrate's own
      // top-level uncaught-exception handler, see cli.mjs's `main().catch()`) from a signal kill
      // or a spawn-level error. Report every dimension BEFORE the plain assertion, so a future CI
      // failure of this exact test carries the actual error/stack, not just a number mismatch.
      if (r.status !== 1) {
        throw new Error(
          `expected calibrate to exit 1, got status=${r.status} signal=${r.signal} ` +
          `error=${r.error ? (r.error.stack || r.error.message) : 'none'}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
        );
      }
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('CALIBRATION FAILED');
      // Same rationale as the status check above -- if the diagnostics write itself failed (any
      // OTHER early-return reason never even attempts it; a genuine write throw is caught and
      // surfaced as "were NOT written"), fail here with the FULL reason instead of a bare ENOENT
      // three lines down when the directory this assumes exists never got created.
      if (!r.stderr.includes('rejected-run diagnostics written:')) {
        throw new Error(`expected a successful diagnostics write, got stderr:\n${r.stderr}`);
      }

      const rejectedDir = path.join(runsRoot, 'agentic-eval-rejected');
      const committedFiles = readdirSync(rejectedDir).filter((f) => f.endsWith('.json'));
      expect(committedFiles.length).toBe(1);
      const rawFiles = readdirSync(path.join(rejectedDir, 'raw')).filter((f) => f.endsWith('.json'));
      expect(rawFiles.length).toBe(1);
      expect(committedFiles[0]).toBe(rawFiles[0]); // same rejection_id names both tiers

      const committed = JSON.parse(readFileSync(path.join(rejectedDir, committedFiles[0]), 'utf8'));
      expect(committed.run_kind).toBe('calibration');
      expect(committed.cells.length).toBe(2);
      expect(JSON.stringify(committed)).not.toContain('totally-unrelated-skill'); // no raw skill name

      // Round-7 audit finding ("procedencia forense incompleta" / "no está realmente cerrada"):
      // every new provenance field actually flows through the REAL end-to-end pipeline, not just
      // synthetic unit tests -- calibration's own fixed shape, platform/privacy_status/
      // claude_code_version populated from the real transcript, and project_url correctly ABSENT
      // from the committed tier specifically (present only in `local`, checked further below).
      expect(committed.scenario_id).toBe('calibration-explicit-invocation');
      expect(committed.project_alias).toBe('calibration-project');
      expect(committed.project_commit).toBeNull();
      expect(committed.seed).toBeNull();
      expect(typeof committed.policy_sha256).toBe('string');
      expect(committed.policy_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(['windows', 'macos', 'linux', 'not-recorded']).toContain(committed.platform);
      expect(['public', 'redacted-private']).toContain(committed.privacy_status);
      expect('project_url' in committed).toBe(false);
      for (const cell of committed.cells) {
        expect(typeof cell.model_resolved).toBe('string');
        expect(typeof cell.claude_code_version).toBe('string');
      }

      // "Localización del diagnóstico" (round-6 audit finding): the CLI's own stderr must point a
      // human at the actual file it just wrote -- checked against the REAL committed.rejection_id
      // (read back off disk above), not merely "some UUID-shaped string appears in stderr".
      expect(r.stderr).toContain(`rejection_id ${committed.rejection_id}`);
      expect(r.stderr).toContain(`agentic-eval-rejected${path.sep}${committedFiles[0]}`);

      const local = JSON.parse(readFileSync(path.join(rejectedDir, 'raw', rawFiles[0]), 'utf8'));
      expect(local.cells.some((c) => c.foreign_skill_names?.includes('totally-unrelated-skill'))).toBe(true);
      // project_url: null for a REAL calibration run (no external project) -- still present as a
      // key at the local tier's top level (the committed tier omits the key entirely).
      expect('project_url' in local).toBe(true);
      expect(local.project_url).toBeNull();

      // Never wrote anything to the real, committable calibration evidence location.
      const realEvidenceDir = path.join(runsRoot, 'agentic-eval-calibration');
      expect(existsSync(realEvidenceDir) && readdirSync(realEvidenceDir).filter((f) => f.endsWith('.json')).length > 0).toBe(false);
    });
  }, 20000);

  it('a real calibrate SUCCESS writes nothing under agentic-eval-rejected/ at all', () => {
    runsRootFor((runsRoot) => {
      const r = spawnSync('node', [CLI_PATH, 'calibrate', '--model', 'claude-sonnet-5'], { env: fakeClaudeEnv('success', runsRoot), encoding: 'utf8', timeout: 20000 });
      expect(r.status).toBe(0);
      expect(existsSync(path.join(runsRoot, 'agentic-eval-rejected'))).toBe(false);
    });
  }, 20000);

  // Negative proof that diagnostics are scoped to the actual hard-gate-failure branch only, not
  // every early-return reason -- driven via a real OTHER-early-return rejection (a private-
  // patterns-file argument error is validated and rejected before the hard gate -- or more
  // precisely here, before finalizeAndWrite* is even called at all) to confirm no
  // agentic-eval-rejected/ directory appears for a failure class this PR's diagnostics hook was
  // never wired into.
  it('a pre-hard-gate argument validation failure (nonexistent --private-patterns-file) writes nothing under agentic-eval-rejected/', () => {
    runsRootFor((runsRoot) => {
      const r = spawnSync('node', [CLI_PATH, 'calibrate', '--model', 'claude-sonnet-5', '--private-patterns-file', '/definitely/does/not/exist.json'], { env: fakeClaudeEnv('success', runsRoot), encoding: 'utf8', timeout: 20000 });
      expect(r.status).toBe(1);
      expect(existsSync(path.join(runsRoot, 'agentic-eval-rejected'))).toBe(false);
    });
  }, 20000);

  it('git check-ignore -v confirms agentic-eval-rejected/raw/ is covered by the EXISTING .gitignore rule (no new rule needed)', () => {
    const probePath = 'tools/runs/agentic-eval-rejected/raw/probe.json';
    const r = spawnSync('git', ['check-ignore', '-v', probePath], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('.gitignore');
    expect(r.stdout).toContain('tools/runs/agentic-eval-*/raw/**');
  });

  // The graceful-degradation proof itself (a diagnostics-write throw must never mask the original
  // FAILED message/exit code) needs a module-wide vi.mock of rejection-diagnostics.mjs, which
  // would break every OTHER test in this file (vi.mock is hoisted/module-wide) -- kept in its own
  // file instead, matching this repo's established node:fs/privacy.mjs-mock-isolation convention
  // (see agentic-eval-write-evidence-gitcheck-fail-closed.test.js's own header comment). See
  // agentic-eval-rejection-diagnostics-write-failure.test.js.
});

// ---------------------------------------------------------------------------
// preserve rejected matrix forensics: everything below is NEW coverage this fix adds -- the
// pre-existing suite above predates it and exercises a different concern (provenance, ambient-
// profile coherence, foreign-skill summing). Scoped exclusively to: schema-3-only field
// validation (including the noUnexpectedToolsOk<->count biconditional that makes the 2026-08
// incident's own exact shape structurally impossible to reproduce), the local tier's own
// validator, the cross-tier coherence invariant (including the raw_transcripts_persisted equality
// the final approval made a second mandatory invariant), transcript filename derivation, and
// Transaction 1 (writeRejectionRawTranscripts) itself.
// ---------------------------------------------------------------------------

describe('validateRejectionRow -- schema-3-only fields (preserve rejected matrix forensics)', () => {
  const AMBIENT_PROFILE_FIXTURE = { count: 0, scope_id: '00000000-0000-4000-8000-000000000000', fingerprint_hmac: '0'.repeat(64) };

  function validRow(overrides = {}) {
    const cellA = { run_id: 'r1', condition: 'no-skill', repetition_index: null, order_index: null, skill_source_sha: null, model_resolved: 'claude-sonnet-5-fake-resolved', claude_code_version: '1.2.3-fake', failed_checks: ['skillSelectionOk'], foreign_skill_summary: { rejected: 0, confirmed: 1, incomplete: 0 }, ambient_skill_profile: AMBIENT_PROFILE_FIXTURE, unexpected_tool_uses_count: 0 };
    const cellB = { run_id: 'r2', condition: 'current-skill', repetition_index: null, order_index: null, skill_source_sha: 'a'.repeat(40), model_resolved: 'claude-sonnet-5-fake-resolved', claude_code_version: '1.2.3-fake', failed_checks: [], foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 }, ambient_skill_profile: AMBIENT_PROFILE_FIXTURE, unexpected_tool_uses_count: 0 };
    return {
      // Explicitly v3, same rationale as the sibling validRow() above.
      schema: REJECTION_DIAGNOSTICS_SCHEMA_V3,
      rejection_id: '11111111-1111-1111-1111-111111111111',
      timestamp: '2026-07-21T00:00:00.000Z',
      run_kind: 'calibration',
      run_ids: ['r1', 'r2'],
      model_requested: 'fake-model-x',
      repo_commit: 'c'.repeat(40),
      scenario_id: 'calibration-explicit-invocation',
      project_alias: 'calibration-project',
      project_commit: null,
      seed: null,
      policy_sha256: 'a'.repeat(64),
      platform: 'linux',
      privacy_status: 'public',
      cells: [cellA, cellB],
      foreign_skill_summary: { rejected: 0, confirmed: 1, incomplete: 0 },
      ambient_profile_matrix_ok: null,
      matrix_complete: true,
      planned_cell_count: 2,
      executed_cell_count: 2,
      raw_transcripts_persisted: true,
      ...overrides,
    };
  }

  it('accepts a well-formed schema-3 row cleanly', () => {
    const { errors } = validateRejectionRow(validRow());
    expect(errors).toEqual([]);
  });

  it('rejects a non-boolean matrix_complete', () => {
    const { errors } = validateRejectionRow(validRow({ matrix_complete: 'true' }));
    expect(errors.some((e) => e.field === 'matrix_complete')).toBe(true);
  });

  it('rejects planned_cell_count/executed_cell_count below 1', () => {
    const { errors } = validateRejectionRow(validRow({ planned_cell_count: 0, executed_cell_count: 0 }));
    expect(errors.some((e) => e.field === 'planned_cell_count')).toBe(true);
    expect(errors.some((e) => e.field === 'executed_cell_count')).toBe(true);
  });

  it('rejects executed_cell_count exceeding planned_cell_count', () => {
    const { errors } = validateRejectionRow(validRow({ planned_cell_count: 2, executed_cell_count: 3 }));
    expect(errors.some((e) => e.field === 'executed_cell_count' && e.message.includes('<= planned_cell_count'))).toBe(true);
  });

  it('rejects matrix_complete:true when executed_cell_count !== planned_cell_count', () => {
    const row = validRow({ planned_cell_count: 4, executed_cell_count: 1, cells: [validRow().cells[0]], run_ids: ['r1'] });
    row.cells[0] = { ...row.cells[0], failed_checks: ['noUnexpectedToolsOk'], unexpected_tool_uses_count: 1 };
    const { errors } = validateRejectionRow(row);
    expect(errors.some((e) => e.field === 'matrix_complete')).toBe(true);
  });

  it('rejects matrix_complete:false when executed_cell_count === planned_cell_count', () => {
    const { errors } = validateRejectionRow(validRow({ matrix_complete: false }));
    expect(errors.some((e) => e.field === 'matrix_complete')).toBe(true);
  });

  it('rejects executed_cell_count disagreeing with the real cells.length', () => {
    const { errors } = validateRejectionRow(validRow({ executed_cell_count: 3 }));
    expect(errors.some((e) => e.field === 'executed_cell_count' && e.message.includes('cells.length'))).toBe(true);
  });

  it('rejects a non-boolean raw_transcripts_persisted', () => {
    const { errors } = validateRejectionRow(validRow({ raw_transcripts_persisted: 'yes' }));
    expect(errors.some((e) => e.field === 'raw_transcripts_persisted')).toBe(true);
  });

  it('rejects a negative unexpected_tool_uses_count on a cell', () => {
    const row = validRow();
    row.cells[0] = { ...row.cells[0], unexpected_tool_uses_count: -1 };
    const { errors } = validateRejectionRow(row);
    expect(errors.some((e) => e.field === 'cells[0].unexpected_tool_uses_count')).toBe(true);
  });

  describe('the noUnexpectedToolsOk <-> unexpected_tool_uses_count biconditional (the single most important invariant this fix adds)', () => {
    it('accepts count:0 with no noUnexpectedToolsOk flag (the coherent clean pairing)', () => {
      const { errors } = validateRejectionRow(validRow());
      expect(errors.filter((e) => e.field === 'cells[0].unexpected_tool_uses_count')).toEqual([]);
    });

    it('accepts count>0 WITH the flag present (the coherent failure pairing -- exactly the shape the 2026-08 incident was missing)', () => {
      const row = validRow();
      row.cells[0] = { ...row.cells[0], failed_checks: ['noUnexpectedToolsOk'], unexpected_tool_uses_count: 1 };
      const { errors } = validateRejectionRow(row);
      expect(errors.filter((e) => e.field === 'cells[0].unexpected_tool_uses_count')).toEqual([]);
    });

    it('rejects count:0 when failed_checks DOES contain noUnexpectedToolsOk -- structurally impossible to reproduce the 2026-08 incident\'s own shape (a rejection blamed on this check with zero recorded detail)', () => {
      const row = validRow();
      row.cells[0] = { ...row.cells[0], failed_checks: ['noUnexpectedToolsOk'], unexpected_tool_uses_count: 0 };
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'cells[0].unexpected_tool_uses_count' && e.message.includes('is 0 but failed_checks contains'))).toBe(true);
    });

    it('rejects count>0 when failed_checks does NOT contain noUnexpectedToolsOk -- a cell can never show unexpected-tool detail without also showing the check it necessarily failed', () => {
      const row = validRow();
      row.cells[0] = { ...row.cells[0], failed_checks: [], unexpected_tool_uses_count: 2 };
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'cells[0].unexpected_tool_uses_count' && e.message.includes('does NOT contain'))).toBe(true);
    });
  });

  describe('ambient_profile_matrix_ok must be null on an incomplete (fail-fast-stopped) scenario matrix', () => {
    function incompleteScenarioRow(overrides = {}) {
      const cell = { run_id: 'r1', condition: 'current-skill', repetition_index: 0, order_index: 0, skill_source_sha: 'a'.repeat(40), model_resolved: 'claude-sonnet-5-fake-resolved', claude_code_version: '1.2.3-fake', failed_checks: ['noUnexpectedToolsOk'], foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 }, ambient_skill_profile: AMBIENT_PROFILE_FIXTURE, unexpected_tool_uses_count: 1 };
      return validRow({
        run_kind: 'scenario', scenario_id: 'kampkit-android-host-test-discovery',
        project_alias: 'kampkit', project_commit: 'd'.repeat(40), seed: 5,
        run_ids: ['r1'], cells: [cell],
        foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
        matrix_complete: false, planned_cell_count: 4, executed_cell_count: 1,
        ambient_profile_matrix_ok: null,
        ...overrides,
      });
    }

    it('accepts ambient_profile_matrix_ok:null on a genuinely incomplete scenario matrix', () => {
      const { errors } = validateRejectionRow(incompleteScenarioRow());
      expect(errors.filter((e) => e.field === 'ambient_profile_matrix_ok')).toEqual([]);
    });

    it('rejects a real boolean ambient_profile_matrix_ok on an incomplete scenario matrix, even though scenario rows normally require one', () => {
      const { errors } = validateRejectionRow(incompleteScenarioRow({ ambient_profile_matrix_ok: true }));
      expect(errors.some((e) => e.field === 'ambient_profile_matrix_ok' && e.message.includes('matrix_complete is false'))).toBe(true);
    });

    it('still requires a real boolean once matrix_complete is true again (the ordinary scenario rule, unaffected by this fix)', () => {
      const completeRow = incompleteScenarioRow({ matrix_complete: true, planned_cell_count: 1, executed_cell_count: 1, ambient_profile_matrix_ok: null });
      const { errors } = validateRejectionRow(completeRow);
      expect(errors.some((e) => e.field === 'ambient_profile_matrix_ok')).toBe(true);
    });
  });

  it('a schema:2 row is validated against its ORIGINAL shape -- none of the schema-3-only fields are required, and none are even ALLOWED', () => {
    const v2Cell = { run_id: 'r1', condition: 'no-skill', repetition_index: null, order_index: null, skill_source_sha: null, model_resolved: 'claude-sonnet-5-fake-resolved', claude_code_version: '1.2.3-fake', failed_checks: ['skillSelectionOk'], foreign_skill_summary: { rejected: 0, confirmed: 1, incomplete: 0 }, ambient_skill_profile: AMBIENT_PROFILE_FIXTURE };
    const v2Cell2 = { run_id: 'r2', condition: 'current-skill', repetition_index: null, order_index: null, skill_source_sha: 'a'.repeat(40), model_resolved: 'claude-sonnet-5-fake-resolved', claude_code_version: '1.2.3-fake', failed_checks: [], foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 }, ambient_skill_profile: AMBIENT_PROFILE_FIXTURE };
    const v2Row = {
      schema: 2, rejection_id: '11111111-1111-1111-1111-111111111111', timestamp: '2026-07-21T00:00:00.000Z',
      run_kind: 'calibration', run_ids: ['r1', 'r2'], model_requested: 'fake-model-x', repo_commit: 'c'.repeat(40),
      scenario_id: 'calibration-explicit-invocation', project_alias: 'calibration-project', project_commit: null, seed: null,
      policy_sha256: 'a'.repeat(64), platform: 'linux', privacy_status: 'public', cells: [v2Cell, v2Cell2],
      foreign_skill_summary: { rejected: 0, confirmed: 1, incomplete: 0 }, ambient_profile_matrix_ok: null,
    };
    expect(validateRejectionRow(v2Row).errors).toEqual([]);

    // Adding a schema-3-only field to a schema:2 row is a closed-key-set violation, not silently
    // tolerated -- v2's own field list never included these.
    const v2RowWithV3Field = { ...v2Row, matrix_complete: true };
    expect(validateRejectionRow(v2RowWithV3Field).errors.some((e) => e.field === 'matrix_complete' && e.message === 'unrecognized field')).toBe(true);
  });
});

describe('schema v2 backward compatibility -- the validator DISPATCHES (2, 3, and 4), the builder only ever emits 3 or 4, never 2 (B.6)', () => {
  // Constructed from the DOCUMENTED v2 shape (CELL_CANONICAL_FIELDS_V2/REJECTION_DIAGNOSTICS_
  // CANONICAL_FIELDS_V2's own frozen field lists in rejection-diagnostics.mjs) -- never copied
  // from the two real, preserved 2026-08 incident diagnostic files themselves (those remain
  // untouched, off-limits, read-only reference evidence outside this repo, per this session's own
  // constraints). This fixture's job is only to prove the DISPATCH mechanism genuinely recognizes
  // a v2-shaped row, not to reproduce that incident's own content.
  function syntheticV2Fixture() {
    const ambientProfile = { count: 0, scope_id: '00000000-0000-4000-8000-000000000000', fingerprint_hmac: '0'.repeat(64) };
    return {
      schema: 2,
      rejection_id: '22222222-2222-2222-2222-222222222222',
      timestamp: '2026-08-10T12:00:00.000Z',
      run_kind: 'scenario',
      run_ids: ['run-a', 'run-b', 'run-c', 'run-d'],
      model_requested: 'claude-sonnet-5',
      repo_commit: 'e'.repeat(40),
      scenario_id: 'changed-module-verification',
      project_alias: 'some-project',
      project_commit: 'f'.repeat(40),
      seed: 42,
      policy_sha256: 'b'.repeat(64),
      platform: 'windows',
      privacy_status: 'public',
      // 4-cell matrix, the LAST cell (order_index 3) is the one that failed noUnexpectedToolsOk --
      // matching the real incident's own reported shape (see this fix's plan document's own
      // "Contexto" section) -- but schema:2 never recorded a per-cell COUNT, only this named-check
      // boolean, which is exactly the gap this whole fix closes for schema:3 rows going forward.
      // ambient_profile_matrix_ok:true (every cell shares the identical ambient profile below) --
      // the real incident's own rejection was attributed to noUnexpectedToolsOk alone, never an
      // ambient-profile disagreement.
      cells: ['run-a', 'run-b', 'run-c', 'run-d'].map((runId, i) => ({
        run_id: runId, condition: i % 2 === 0 ? 'no-skill' : 'current-skill',
        repetition_index: Math.floor(i / 2), order_index: i,
        skill_source_sha: i % 2 === 0 ? null : 'a'.repeat(40),
        model_resolved: 'claude-sonnet-5-fake-resolved', claude_code_version: '1.2.3-fake',
        failed_checks: i === 3 ? ['noUnexpectedToolsOk'] : [],
        foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
        ambient_skill_profile: ambientProfile,
      })),
      foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
      ambient_profile_matrix_ok: true,
    };
  }

  it('a genuine schema:2 row (4-cell scenario matrix, last cell failed noUnexpectedToolsOk) validates cleanly against the CURRENT validator, with none of the new schema-3 fields required', () => {
    const { errors } = validateRejectionRow(syntheticV2Fixture());
    expect(errors).toEqual([]);
  });

  it('the SAME fixture is rejected outright if schema-3-only fields are added to it -- v2 and v3 field sets are disjoint at the top level, never merged', () => {
    const v2WithV3Fields = { ...syntheticV2Fixture(), matrix_complete: true, planned_cell_count: 4, executed_cell_count: 4, raw_transcripts_persisted: true };
    const { errors } = validateRejectionRow(v2WithV3Fields);
    expect(errors.some((e) => e.field === 'matrix_complete' && e.message === 'unrecognized field')).toBe(true);
  });
});

describe('validateRejectionLocalRow -- local tier\'s own narrow validator (unexpected_tools + transcript_filename)', () => {
  const VALID_RUN_ID = 'r1';
  const VALID_FILENAME = deriveTranscriptFilename(0, VALID_RUN_ID);

  function validLocalRow(overrides = {}) {
    return { cells: [{ run_id: VALID_RUN_ID, unexpected_tools: [], transcript_filename: VALID_FILENAME, ...overrides }] };
  }

  it('accepts an empty unexpected_tools array with a well-formed, correctly-corresponding transcript_filename', () => {
    expect(validateRejectionLocalRow(validLocalRow()).errors).toEqual([]);
  });

  it('accepts a well-formed {name, event_index} entry', () => {
    const row = validLocalRow({ unexpected_tools: [{ name: 'Read', event_index: 7 }] });
    expect(validateRejectionLocalRow(row).errors).toEqual([]);
  });

  it('rejects unexpected_tools that is not an array', () => {
    const row = validLocalRow({ unexpected_tools: 'nope' });
    expect(validateRejectionLocalRow(row).errors.some((e) => e.field === 'cells[0].unexpected_tools')).toBe(true);
  });

  it('rejects an entry carrying id/receiptNs alongside name/event_index -- never anything beyond the closed {name, event_index} shape', () => {
    const row = validLocalRow({ unexpected_tools: [{ name: 'Read', event_index: 0, id: 'toolu_x', receiptNs: '123' }] });
    const { errors } = validateRejectionLocalRow(row);
    expect(errors.some((e) => e.field === 'cells[0].unexpected_tools[0].id')).toBe(true);
    expect(errors.some((e) => e.field === 'cells[0].unexpected_tools[0].receiptNs')).toBe(true);
  });

  it('rejects an entry missing event_index', () => {
    const row = validLocalRow({ unexpected_tools: [{ name: 'Read' }] });
    expect(validateRejectionLocalRow(row).errors.some((e) => e.field === 'cells[0].unexpected_tools[0].event_index')).toBe(true);
  });

  it('rejects an entry with an empty-string name', () => {
    const row = validLocalRow({ unexpected_tools: [{ name: '', event_index: 0 }] });
    expect(validateRejectionLocalRow(row).errors.some((e) => e.field === 'cells[0].unexpected_tools[0].name')).toBe(true);
  });

  it('rejects a negative event_index', () => {
    const row = validLocalRow({ unexpected_tools: [{ name: 'Read', event_index: -1 }] });
    expect(validateRejectionLocalRow(row).errors.some((e) => e.field === 'cells[0].unexpected_tools[0].event_index')).toBe(true);
  });

  it('accepts ANY non-empty tool name -- unexpected tool names are untrusted, arbitrary runtime input, never a closed vocabulary', () => {
    const row = validLocalRow({ unexpected_tools: [{ name: 'SomeToolNoOneHasEverSeenBefore', event_index: 3 }] });
    expect(validateRejectionLocalRow(row).errors).toEqual([]);
  });

  it('rejects a transcript_filename that does not match <captureOrdinal>-<64 hex>.jsonl', () => {
    const row = validLocalRow({ transcript_filename: 'not-a-real-filename.jsonl' });
    expect(validateRejectionLocalRow(row).errors.some((e) => e.field === 'cells[0].transcript_filename')).toBe(true);
  });

  it('rejects a transcript_filename using the raw run_id instead of a derived ordinal-hash name', () => {
    const row = validLocalRow({ transcript_filename: 'calibration-current-skill-jjjj1111.jsonl' });
    expect(validateRejectionLocalRow(row).errors.some((e) => e.field === 'cells[0].transcript_filename')).toBe(true);
  });

  // Post-open-PR review finding ("la cadena de custodia del transcript aún puede quedar
  // incoherente"): the pre-fix validator only checked SHAPE, never that the 64-hex-char portion
  // actually corresponded to sha256(run_id) for that specific cell. Reproduced directly against
  // the pre-fix code: a filename `0-<64 zero-chars>.jsonl` attached to run_id:"a" passed this
  // validator unmodified, even though deriveTranscriptFilename(0, "a") never produces that hash.
  describe('chain of custody: transcript_filename must genuinely correspond to its own cell\'s run_id (not just look shape-valid)', () => {
    it('rejects a well-formed-SHAPED filename whose hash does not correspond to this cell\'s run_id -- the exact reproduced gap', () => {
      const row = validLocalRow({ run_id: 'a', transcript_filename: `0-${'0'.repeat(64)}.jsonl` });
      const { errors } = validateRejectionLocalRow(row);
      expect(errors.some((e) => e.field === 'cells[0].transcript_filename' && e.message.includes('does not correspond'))).toBe(true);
    });

    it('accepts the SAME ordinal+hash shape when it genuinely is deriveTranscriptFilename(0, "a")', () => {
      const row = validLocalRow({ run_id: 'a', transcript_filename: deriveTranscriptFilename(0, 'a') });
      expect(validateRejectionLocalRow(row).errors).toEqual([]);
    });

    // A filename can be internally self-consistent (its hash genuinely IS sha256(run_id) for the
    // ordinal it claims) while still claiming an ordinal that's invalid for the BATCH it's part
    // of -- for a single-cell diagnostic (N=1), the only valid ordinal is 0, so claiming ordinal 1
    // is a CROSS-CELL range violation (validateCaptureOrdinalSet, field:'cells'), not a per-cell
    // hash-correspondence one (this per-cell check has no way to know what N is on its own).
    it('rejects a single-cell diagnostic whose one cell claims ordinal 1 -- self-consistent hash, but out of the {0} range for N=1', () => {
      const row = validLocalRow({ run_id: VALID_RUN_ID, transcript_filename: deriveTranscriptFilename(1, VALID_RUN_ID) });
      const { errors } = validateRejectionLocalRow(row);
      expect(errors.some((e) => e.field === 'cells[0].transcript_filename')).toBe(false);
      expect(errors.some((e) => e.field === 'cells' && e.message.includes('exact set {0..0}'))).toBe(true);
    });

    it('rejects when run_id is missing entirely -- correspondence cannot be verified against nothing', () => {
      const row = { cells: [{ unexpected_tools: [], transcript_filename: VALID_FILENAME }] };
      const { errors } = validateRejectionLocalRow(row);
      expect(errors.some((e) => e.field === 'cells[0].transcript_filename' && e.message.includes('cannot verify correspondence'))).toBe(true);
    });
  });

  // Reuses validateCaptureOrdinalSet (the same canonical check buildRejectionDiagnostics/
  // writeRejectionRawTranscripts enforce at construction time) to ALSO confirm, at rest, that the
  // ordinals across every cell of one diagnostic form the exact contiguous {0..N-1} range.
  describe('cross-cell ordinal-set completeness, checked at rest via the same canonical validator', () => {
    function twoCellRow(ordinalA, ordinalB) {
      return {
        cells: [
          { run_id: 'a', unexpected_tools: [], transcript_filename: deriveTranscriptFilename(ordinalA, 'a') },
          { run_id: 'b', unexpected_tools: [], transcript_filename: deriveTranscriptFilename(ordinalB, 'b') },
        ],
      };
    }

    it('accepts two cells whose ordinals form the exact set {0,1}', () => {
      expect(validateRejectionLocalRow(twoCellRow(0, 1)).errors).toEqual([]);
    });

    // The exact P2 reproduction: {a:0, b:2} for 2 cells -- a real gap, not just "unique values".
    it('rejects two cells whose ordinals are {0,2} -- unique but NOT the contiguous {0,1} range', () => {
      const { errors } = validateRejectionLocalRow(twoCellRow(0, 2));
      expect(errors.some((e) => e.field === 'cells' && e.message.includes('exact set {0..1}'))).toBe(true);
    });

    it('does not cascade the cross-cell check on top of an already-reported per-cell correspondence failure', () => {
      const row = twoCellRow(0, 1);
      row.cells[1] = { ...row.cells[1], transcript_filename: `1-${'0'.repeat(64)}.jsonl` }; // wrong hash for "b"
      const { errors } = validateRejectionLocalRow(row);
      expect(errors.some((e) => e.field === 'cells[1].transcript_filename')).toBe(true);
      expect(errors.some((e) => e.field === 'cells' && e.message.includes('exact set'))).toBe(false);
    });
  });
});

describe('validateCaptureOrdinalSet -- the single canonical captureOrdinalByRunId validator (post-open-PR review finding)', () => {
  it('accepts an exact-set, contiguous {0,1} map for 2 run_ids', () => {
    expect(() => validateCaptureOrdinalSet({ a: 0, b: 1 }, ['a', 'b'], 'test')).not.toThrow();
  });

  it('accepts a single run_id at ordinal 0', () => {
    expect(() => validateCaptureOrdinalSet({ a: 0 }, ['a'], 'test')).not.toThrow();
  });

  // The exact P2 reproduction: {a:0, b:2} for 2 run_ids previously passed both
  // buildRejectionDiagnostics' and writeRejectionRawTranscripts' own (weaker) checks.
  it('throws on {a:0, b:2} for 2 run_ids -- a gap, even though both values are non-negative integers and unique', () => {
    expect(() => validateCaptureOrdinalSet({ a: 0, b: 2 }, ['a', 'b'], 'test')).toThrow(/exact set \{0\.\.1\}/);
  });

  it('throws on a plain duplicate ({a:0, b:0}) -- still caught by the same exact-set check, not a separate one', () => {
    expect(() => validateCaptureOrdinalSet({ a: 0, b: 0 }, ['a', 'b'], 'test')).toThrow(/exact set \{0\.\.1\}/);
  });

  it('throws when a value is negative', () => {
    expect(() => validateCaptureOrdinalSet({ a: -1, b: 1 }, ['a', 'b'], 'test')).toThrow(/non-negative integer/);
  });

  it('throws when a value is not an integer', () => {
    expect(() => validateCaptureOrdinalSet({ a: 0.5, b: 1 }, ['a', 'b'], 'test')).toThrow(/non-negative integer/);
  });

  it('throws when a key is missing', () => {
    expect(() => validateCaptureOrdinalSet({ a: 0 }, ['a', 'b'], 'test')).toThrow(/keys must exactly match/);
  });

  it('throws when there is a stale/extra key', () => {
    expect(() => validateCaptureOrdinalSet({ a: 0, b: 1, c: 2 }, ['a', 'b'], 'test')).toThrow(/keys must exactly match/);
  });

  it('throws when the map itself is null', () => {
    expect(() => validateCaptureOrdinalSet(null, ['a'], 'test')).toThrow(/required and must be an object/);
  });

  it('uses the caller-supplied errorPrefix verbatim, so each of the two real call sites keeps its own established wording', () => {
    expect(() => validateCaptureOrdinalSet({}, ['a'], 'buildRejectionDiagnostics')).toThrow(/^buildRejectionDiagnostics:/);
    expect(() => validateCaptureOrdinalSet({}, ['a'], 'refusing to write raw transcripts')).toThrow(/^refusing to write raw transcripts:/);
  });
});

describe('assertUnexpectedToolCoherence -- cross-tier construction-time invariants', () => {
  function committedCell(overrides = {}) {
    return { run_id: 'r1', unexpected_tool_uses_count: 0, ...overrides };
  }
  function localCell(overrides = {}) {
    return { run_id: 'r1', unexpected_tools: [], ...overrides };
  }

  it('accepts a genuinely coherent pair (counts match lengths, run_ids align, raw_transcripts_persisted agrees)', () => {
    const committed = { cells: [committedCell()], raw_transcripts_persisted: true };
    const local = { cells: [localCell()], raw_transcripts_persisted: true };
    expect(() => assertUnexpectedToolCoherence(committed, local)).not.toThrow();
  });

  it('throws when committed.cells and local.cells have different lengths', () => {
    const committed = { cells: [committedCell(), committedCell({ run_id: 'r2' })], raw_transcripts_persisted: true };
    const local = { cells: [localCell()], raw_transcripts_persisted: true };
    expect(() => assertUnexpectedToolCoherence(committed, local)).toThrow(/parallel arrays of equal length/);
  });

  it('throws when run_id disagrees at the same index', () => {
    const committed = { cells: [committedCell({ run_id: 'r1' })], raw_transcripts_persisted: true };
    const local = { cells: [localCell({ run_id: 'r-different' })], raw_transcripts_persisted: true };
    expect(() => assertUnexpectedToolCoherence(committed, local)).toThrow(/run_id disagrees across tiers/);
  });

  it('throws when local.unexpected_tools.length disagrees with committed.unexpected_tool_uses_count (the count can never be an independent second source of truth)', () => {
    const committed = { cells: [committedCell({ unexpected_tool_uses_count: 2 })], raw_transcripts_persisted: true };
    const local = { cells: [localCell({ unexpected_tools: [{ name: 'Read', event_index: 0 }] })], raw_transcripts_persisted: true };
    expect(() => assertUnexpectedToolCoherence(committed, local)).toThrow(/unexpected-tool tiers disagree/);
  });

  // The final approval's SECOND mandatory invariant, added on top of the plan's own review rounds:
  // both tiers must stamp the IDENTICAL Transaction-1 outcome. Tested in BOTH directions -- a
  // one-directional check would miss a bug that only flips one side.
  describe('raw_transcripts_persisted must agree across tiers (final-approval mandatory invariant)', () => {
    it('throws when committed says true but local says false', () => {
      const committed = { cells: [committedCell()], raw_transcripts_persisted: true };
      const local = { cells: [localCell()], raw_transcripts_persisted: false };
      expect(() => assertUnexpectedToolCoherence(committed, local)).toThrow(/raw_transcripts_persisted.*disagrees/);
    });

    it('throws when committed says false but local says true', () => {
      const committed = { cells: [committedCell()], raw_transcripts_persisted: false };
      const local = { cells: [localCell()], raw_transcripts_persisted: true };
      expect(() => assertUnexpectedToolCoherence(committed, local)).toThrow(/raw_transcripts_persisted.*disagrees/);
    });

    it('accepts both tiers agreeing on false (a genuine Transaction-1 failure, consistently recorded)', () => {
      const committed = { cells: [committedCell()], raw_transcripts_persisted: false };
      const local = { cells: [localCell()], raw_transcripts_persisted: false };
      expect(() => assertUnexpectedToolCoherence(committed, local)).not.toThrow();
    });
  });
});

describe('buildRejectionDiagnostics -- schema-3 fields (preserve rejected matrix forensics)', () => {
  it('populates unexpected_tool_uses_count on the committed tier from unexpectedToolUsesCountByRunId, never reparsed', () => {
    const r = record();
    const { committed } = buildDiag({
      runKind: 'calibration', records: [r],
      failedChecksByRunId: { [r.run_id]: ['noUnexpectedToolsOk'] },
      unexpectedToolUsesCountByRunId: { [r.run_id]: 2 },
      unexpectedToolsByRunId: { [r.run_id]: [{ name: 'Read', event_index: 4 }, { name: 'Read', event_index: 9 }] },
      captureOrdinalByRunId: { [r.run_id]: 0 },
    });
    expect(committed.cells[0].unexpected_tool_uses_count).toBe(2);
    // Privacy: the committed tier never carries the tool NAME, only the count.
    expect(JSON.stringify(committed)).not.toContain('Read');
  });

  it('populates unexpected_tools + transcript_filename on the LOCAL tier only -- never on committed', () => {
    const r = record();
    const { committed, local } = buildDiag({
      runKind: 'calibration', records: [r],
      failedChecksByRunId: { [r.run_id]: ['noUnexpectedToolsOk'] },
      unexpectedToolUsesCountByRunId: { [r.run_id]: 1 },
      unexpectedToolsByRunId: { [r.run_id]: [{ name: 'Read', event_index: 4 }] },
      captureOrdinalByRunId: { [r.run_id]: 0 },
    });
    expect('unexpected_tools' in committed.cells[0]).toBe(false);
    expect(local.cells[0].unexpected_tools).toEqual([{ name: 'Read', event_index: 4 }]);
    expect(local.cells[0].transcript_filename).toBe(deriveTranscriptFilename(0, r.run_id));
  });

  it('does NOT deduplicate or sort unexpected_tools -- transcript order and repeat occurrences are themselves the forensic signal', () => {
    const r = record();
    const { local } = buildDiag({
      runKind: 'calibration', records: [r],
      failedChecksByRunId: { [r.run_id]: ['noUnexpectedToolsOk'] },
      unexpectedToolUsesCountByRunId: { [r.run_id]: 3 },
      unexpectedToolsByRunId: { [r.run_id]: [{ name: 'Read', event_index: 9 }, { name: 'Read', event_index: 4 }, { name: 'Read', event_index: 4 }] },
      captureOrdinalByRunId: { [r.run_id]: 0 },
    });
    expect(local.cells[0].unexpected_tools).toEqual([{ name: 'Read', event_index: 9 }, { name: 'Read', event_index: 4 }, { name: 'Read', event_index: 4 }]);
  });

  it('throws when unexpectedToolUsesCountByRunId is missing a required key (exact-set, never a silent zero-default)', () => {
    const r = record();
    const r2 = record({ run_id: 'other-run', condition: 'current-skill', skill_source_sha: 'a'.repeat(40) });
    expect(() => buildRejectionDiagnostics({
      runKind: 'calibration', rejectionId: randomUUID(), records: [r, r2], rawTranscriptsPersisted: true,
      failedChecksByRunId: { [r.run_id]: [], [r2.run_id]: [] },
      unexpectedToolUsesCountByRunId: { [r.run_id]: 0 },
      unexpectedToolsByRunId: { [r.run_id]: [], [r2.run_id]: [] },
      captureOrdinalByRunId: { [r.run_id]: 0, [r2.run_id]: 1 },
    })).toThrow(/unexpectedToolUsesCountByRunId/);
  });

  it('throws when rawTranscriptsPersisted is not a boolean', () => {
    const r = record();
    expect(() => buildDiag({ runKind: 'calibration', records: [r], failedChecksByRunId: { [r.run_id]: [] }, rawTranscriptsPersisted: 'true' })).toThrow(/rawTranscriptsPersisted/);
  });

  it('throws when captureOrdinalByRunId values are not unique (via validateCaptureOrdinalSet -- a duplicate can never form the exact {0..N-1} set)', () => {
    const r = record();
    const r2 = record({ run_id: 'other-run', condition: 'current-skill', skill_source_sha: 'a'.repeat(40) });
    expect(() => buildRejectionDiagnostics({
      runKind: 'calibration', rejectionId: randomUUID(), records: [r, r2], rawTranscriptsPersisted: true,
      failedChecksByRunId: { [r.run_id]: [], [r2.run_id]: [] },
      unexpectedToolUsesCountByRunId: { [r.run_id]: 0, [r2.run_id]: 0 },
      unexpectedToolsByRunId: { [r.run_id]: [], [r2.run_id]: [] },
      captureOrdinalByRunId: { [r.run_id]: 0, [r2.run_id]: 0 },
    })).toThrow(/exact set \{0\.\.1\}/);
  });

  // The exact P2 reproduction at this call site: {a:0, b:2} for 2 records -- both non-negative
  // integers, both pairwise-unique, so the pre-fix (weaker) check accepted it.
  it('throws on a GAP -- {a:0, b:2} for 2 records -- never silently accepts a non-dense ordinal range', () => {
    const r = record();
    const r2 = record({ run_id: 'other-run', condition: 'current-skill', skill_source_sha: 'a'.repeat(40) });
    expect(() => buildRejectionDiagnostics({
      runKind: 'calibration', rejectionId: randomUUID(), records: [r, r2], rawTranscriptsPersisted: true,
      failedChecksByRunId: { [r.run_id]: [], [r2.run_id]: [] },
      unexpectedToolUsesCountByRunId: { [r.run_id]: 0, [r2.run_id]: 0 },
      unexpectedToolsByRunId: { [r.run_id]: [], [r2.run_id]: [] },
      captureOrdinalByRunId: { [r.run_id]: 0, [r2.run_id]: 2 },
    })).toThrow(/exact set \{0\.\.1\}/);
  });

  it('derives matrix_complete:true and planned===executed===records.length by default (a normal, complete batch)', () => {
    const r = record();
    const { committed } = buildDiag({ runKind: 'calibration', records: [r], failedChecksByRunId: { [r.run_id]: [] } });
    expect(committed.matrix_complete).toBe(true);
    expect(committed.planned_cell_count).toBe(1);
    expect(committed.executed_cell_count).toBe(1);
  });

  it('derives matrix_complete:false when plannedCellCount exceeds executedCellCount (a fail-fast-stopped matrix)', () => {
    const r = scenarioRecord();
    const { committed } = buildDiag({
      runKind: 'scenario', records: [r], failedChecksByRunId: { [r.run_id]: ['noUnexpectedToolsOk'] },
      unexpectedToolUsesCountByRunId: { [r.run_id]: 1 }, unexpectedToolsByRunId: { [r.run_id]: [{ name: 'Read', event_index: 0 }] },
      plannedCellCount: 4, executedCellCount: 1, ambientProfileMatrixOk: null,
    });
    expect(committed.matrix_complete).toBe(false);
    expect(committed.planned_cell_count).toBe(4);
    expect(committed.executed_cell_count).toBe(1);
  });

  it('throws when an explicit matrixComplete contradicts the derived planned/executed equality', () => {
    const r = scenarioRecord();
    expect(() => buildDiag({
      runKind: 'scenario', records: [r], failedChecksByRunId: { [r.run_id]: [] },
      plannedCellCount: 4, executedCellCount: 1, matrixComplete: true,
    })).toThrow(/matrixComplete/);
  });

  it('throws when ambientProfileMatrixOk is a real boolean while the matrix is incomplete -- never a faked/simulated consensus over cells that never ran', () => {
    const r = scenarioRecord();
    expect(() => buildDiag({
      runKind: 'scenario', records: [r], failedChecksByRunId: { [r.run_id]: ['noUnexpectedToolsOk'] },
      unexpectedToolUsesCountByRunId: { [r.run_id]: 1 }, unexpectedToolsByRunId: { [r.run_id]: [{ name: 'Read', event_index: 0 }] },
      plannedCellCount: 4, executedCellCount: 1, ambientProfileMatrixOk: true,
    })).toThrow(/ambientProfileMatrixOk must be null/);
  });

  it('accepts ambientProfileMatrixOk:null on an incomplete matrix (the required, safe value)', () => {
    const r = scenarioRecord();
    const { committed } = buildDiag({
      runKind: 'scenario', records: [r], failedChecksByRunId: { [r.run_id]: ['noUnexpectedToolsOk'] },
      unexpectedToolUsesCountByRunId: { [r.run_id]: 1 }, unexpectedToolsByRunId: { [r.run_id]: [{ name: 'Read', event_index: 0 }] },
      plannedCellCount: 4, executedCellCount: 1, ambientProfileMatrixOk: null,
    });
    expect(committed.ambient_profile_matrix_ok).toBeNull();
  });

  it('throws (via assertUnexpectedToolCoherence) when unexpectedToolsByRunId\'s length disagrees with unexpectedToolUsesCountByRunId for the same run -- the two inputs must already agree, this is not derived from one of them', () => {
    const r = record();
    expect(() => buildDiag({
      runKind: 'calibration', records: [r], failedChecksByRunId: { [r.run_id]: ['noUnexpectedToolsOk'] },
      unexpectedToolUsesCountByRunId: { [r.run_id]: 2 }, unexpectedToolsByRunId: { [r.run_id]: [{ name: 'Read', event_index: 0 }] },
    })).toThrow(/unexpected-tool tiers disagree/);
  });
});

// ---------------------------------------------------------------------------
// Rejection-diagnostics schema 4 (sandboxed-unrestricted-v1 support). Authorized scope expansion,
// mid-session, after the fake E2E suite (agentic-eval-unrestricted-profile-e2e.test.js) proved a
// genuine rejection under the new execution profile was silently misclassified: policy_sha256 is
// honestly null for a policy_mode:"not_applicable" batch (Decision F/G, PR 4's own established
// pattern), but the pre-existing validator unconditionally required a real hex64 hash, so
// writeRejectedRunDiagnostics() threw internally on every such rejection and cli.mjs's own
// `result.rejectionId == null` branch silently fell back to a generic "finalizing_matrix" incident
// instead of the clean "RUN FAILED: <specific reason>" strict already produces. Schema 4 reports
// the real facts instead: execution_profile_id/policy_mode/isolation_attestation_sha256, and an
// honestly-null policy_sha256 -- v2 and v3 stay frozen exactly as they were (their own field sets
// unchanged, policy_sha256 still a required real hex64 for either).
// ---------------------------------------------------------------------------
describe('rejection-diagnostics schema 4 -- sandboxed-unrestricted-v1 (policy_mode:"not_applicable") support', () => {
  describe('v2 and v3 stay frozen -- policy_sha256 is still a required real hex64 hash for either', () => {
    it('a v3 row with policy_sha256:null is rejected -- v3 never adopts v4\'s honest-null rule', () => {
      const cellA = { run_id: 'r1', condition: 'no-skill', repetition_index: null, order_index: null, skill_source_sha: null, model_resolved: 'claude-sonnet-5-fake-resolved', claude_code_version: '1.2.3-fake', failed_checks: ['skillSelectionOk'], foreign_skill_summary: { rejected: 0, confirmed: 1, incomplete: 0 }, ambient_skill_profile: { count: 0, scope_id: '00000000-0000-4000-8000-000000000000', fingerprint_hmac: '0'.repeat(64) }, unexpected_tool_uses_count: 0 };
      const cellB = { run_id: 'r2', condition: 'current-skill', repetition_index: null, order_index: null, skill_source_sha: 'a'.repeat(40), model_resolved: 'claude-sonnet-5-fake-resolved', claude_code_version: '1.2.3-fake', failed_checks: [], foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 }, ambient_skill_profile: { count: 0, scope_id: '00000000-0000-4000-8000-000000000000', fingerprint_hmac: '0'.repeat(64) }, unexpected_tool_uses_count: 0 };
      const row = {
        schema: REJECTION_DIAGNOSTICS_SCHEMA_V3, rejection_id: '11111111-1111-1111-1111-111111111111',
        timestamp: '2026-07-21T00:00:00.000Z', run_kind: 'calibration', run_ids: ['r1', 'r2'],
        model_requested: 'fake-model-x', repo_commit: 'c'.repeat(40), scenario_id: 'calibration-explicit-invocation',
        project_alias: 'calibration-project', project_commit: null, seed: null,
        policy_sha256: null, platform: 'linux', privacy_status: 'public', cells: [cellA, cellB],
        foreign_skill_summary: { rejected: 0, confirmed: 1, incomplete: 0 }, ambient_profile_matrix_ok: null,
        matrix_complete: true, planned_cell_count: 2, executed_cell_count: 2, raw_transcripts_persisted: true,
      };
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'policy_sha256')).toBe(true);
    });

    it('a genuine schema:2 row is completely unaffected by the schema-4 addition', () => {
      const ambientProfile = { count: 0, scope_id: '00000000-0000-4000-8000-000000000000', fingerprint_hmac: '0'.repeat(64) };
      const v2Row = {
        schema: REJECTION_DIAGNOSTICS_SCHEMA_V2, rejection_id: '22222222-2222-2222-2222-222222222222',
        timestamp: '2026-08-10T12:00:00.000Z', run_kind: 'scenario', run_ids: ['run-a'],
        model_requested: 'claude-sonnet-5', repo_commit: 'e'.repeat(40), scenario_id: 'changed-module-verification',
        project_alias: 'some-project', project_commit: 'f'.repeat(40), seed: 42, policy_sha256: 'b'.repeat(64),
        platform: 'windows', privacy_status: 'public',
        cells: [{ run_id: 'run-a', condition: 'no-skill', repetition_index: 0, order_index: 0, skill_source_sha: null, model_resolved: 'claude-sonnet-5-fake-resolved', claude_code_version: '1.2.3-fake', failed_checks: ['noUnexpectedToolsOk'], foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 }, ambient_skill_profile: ambientProfile }],
        foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 }, ambient_profile_matrix_ok: true,
      };
      expect(validateRejectionRow(v2Row).errors).toEqual([]);
    });
  });

  describe('buildRejectionDiagnostics -- dispatches to v3 or v4, never via LATEST_REJECTION_DIAGNOSTICS_SCHEMA', () => {
    it('a policy-required (schema<6, or no execution_profile) batch still builds v3, byte-identical to before this addition', () => {
      const r = record();
      const { committed } = buildDiag({ runKind: 'calibration', records: [r], failedChecksByRunId: { [r.run_id]: [] } });
      expect(committed.schema).toBe(REJECTION_DIAGNOSTICS_SCHEMA_V3);
      expect(committed.policy_sha256).toBe('a'.repeat(64));
      expect('execution_profile_id' in committed).toBe(false);
      expect('policy_mode' in committed).toBe(false);
      expect('isolation_attestation_sha256' in committed).toBe(false);
    });

    it('a policy_mode:"not_applicable" batch builds v4, with policy_sha256 honestly null and the 3 new fields populated from records[].execution_profile', () => {
      const r = unrestrictedRecord();
      const { committed } = buildDiag({ runKind: 'calibration', records: [r], failedChecksByRunId: { [r.run_id]: ['skillSelectionOk'] } });
      expect(committed.schema).toBe(REJECTION_DIAGNOSTICS_SCHEMA_V4);
      expect(committed.policy_sha256).toBeNull();
      expect(committed.execution_profile_id).toBe('sandboxed-unrestricted-v1');
      expect(committed.policy_mode).toBe('not_applicable');
      expect(committed.isolation_attestation_sha256).toBe('e'.repeat(64));
      expect(validateRejectionRow(committed).errors).toEqual([]);
    });

    it('a not_applicable scenario batch (2 cells) also builds v4 cleanly, matching the real fail-fast-rejection shape', () => {
      const r1 = unrestrictedScenarioRecord();
      const r2 = unrestrictedScenarioRecord({ run_id: 'kampkit-current-skill-bbbb2222', condition: 'current-skill', skill_source_sha: 'a'.repeat(40), repetition_index: 0, order_index: 1 });
      const { committed } = buildDiag({
        runKind: 'scenario', records: [r1, r2],
        failedChecksByRunId: { [r1.run_id]: [], [r2.run_id]: ['noUnexpectedToolsOk'] },
        unexpectedToolUsesCountByRunId: { [r1.run_id]: 0, [r2.run_id]: 1 },
        unexpectedToolsByRunId: { [r1.run_id]: [], [r2.run_id]: [{ name: 'Read', event_index: 3 }] },
        plannedCellCount: 4, executedCellCount: 2, ambientProfileMatrixOk: null,
      });
      expect(committed.schema).toBe(REJECTION_DIAGNOSTICS_SCHEMA_V4);
      expect(committed.matrix_complete).toBe(false);
      expect(committed.policy_sha256).toBeNull();
      expect(committed.execution_profile_id).toBe('sandboxed-unrestricted-v1');
      expect(validateRejectionRow(committed).errors).toEqual([]);
    });

    it('throws a specific, closed reason when records disagree on execution_profile.policy_mode (a caller-assembled inconsistency, never a real production shape)', () => {
      const r1 = unrestrictedRecord();
      // Deliberately agrees with r1 on policy_sha256:null (so the PRE-EXISTING BATCH_WIDE_FIELDS
      // check, which runs earlier and would otherwise catch a policy_sha256 mismatch first, stays
      // silent here) but is schema>=6 with execution_profile.policy_mode:"required" -- a shape
      // buildRunRecord itself can never actually produce (policy_sha256 and policy_mode are always
      // coupled 1:1 there), exercised here specifically to isolate THIS function's own agreement
      // check rather than accidentally re-proving the pre-existing, unrelated one.
      const r2 = record({
        run_id: 'other-run', condition: 'current-skill', skill_source_sha: 'a'.repeat(40), policy_sha256: null,
        schema: 6, execution_profile: { id: 'strict-policy-v1', policy_mode: 'required', isolation_attestation_sha256: null },
      });
      expect(() => buildDiag({ runKind: 'calibration', records: [r1, r2], failedChecksByRunId: { [r1.run_id]: ['skillSelectionOk'], [r2.run_id]: [] } }))
        .toThrow(/records disagree on execution_profile\.policy_mode/);
    });

    it('throws when a schema<6 record is mixed with a schema>=6 not_applicable record -- the pre-v6/post-v6 mix is caught by the SAME agreement check', () => {
      const r1 = unrestrictedRecord();
      // record() never sets schema at all (schema<6 sentinel) -- policy_sha256:null explicitly
      // added so this exercises the schema<6-vs->=6 mix specifically, not a rediscovery of the
      // pre-existing policy_sha256 batch-wide check (same isolation rationale as the test above).
      const r2 = record({ run_id: 'other-run', condition: 'current-skill', skill_source_sha: 'a'.repeat(40), policy_sha256: null });
      expect(() => buildDiag({ runKind: 'calibration', records: [r1, r2], failedChecksByRunId: { [r1.run_id]: ['skillSelectionOk'], [r2.run_id]: [] } }))
        .toThrow(/records disagree on execution_profile\.policy_mode/);
    });

    it('throws a specific reason when records disagree on execution_profile.id within a not_applicable batch', () => {
      const r1 = unrestrictedRecord();
      const r2 = unrestrictedRecord({ run_id: 'other-run', condition: 'current-skill', skill_source_sha: 'a'.repeat(40), execution_profile: unrestrictedProfile({ id: 'some-other-profile-v1' }) });
      expect(() => buildDiag({ runKind: 'calibration', records: [r1, r2], failedChecksByRunId: { [r1.run_id]: [], [r2.run_id]: [] } }))
        .toThrow(/records disagree on execution_profile\.id/);
    });

    it('throws a specific reason when records disagree on execution_profile.isolation_attestation_sha256 within a not_applicable batch', () => {
      const r1 = unrestrictedRecord();
      const r2 = unrestrictedRecord({ run_id: 'other-run', condition: 'current-skill', skill_source_sha: 'a'.repeat(40), execution_profile: unrestrictedProfile({ isolation_attestation_sha256: 'f'.repeat(64) }) });
      expect(() => buildDiag({ runKind: 'calibration', records: [r1, r2], failedChecksByRunId: { [r1.run_id]: [], [r2.run_id]: [] } }))
        .toThrow(/records disagree on execution_profile\.isolation_attestation_sha256/);
    });

    it('throws when the (agreeing) isolation_attestation_sha256 is not a real hex64 string -- never silently accepted, never a synthetic fallback hash', () => {
      const r = unrestrictedRecord({ execution_profile: unrestrictedProfile({ isolation_attestation_sha256: 'not-a-real-hash' }) });
      expect(() => buildDiag({ runKind: 'calibration', records: [r], failedChecksByRunId: { [r.run_id]: [] } }))
        .toThrow(/isolation_attestation_sha256 must be a real 64-hex-char string/);
    });

    it('v4\'s 3 new fields are copied EXCLUSIVELY from records[].execution_profile -- there is no caller-supplied parameter that could override or bypass them', () => {
      const r = unrestrictedRecord();
      // Not a real buildRejectionDiagnostics param -- confirms the function signature has no
      // parallel, independently-controllable channel for these facts (an extra key here is simply
      // ignored, exactly like passing any other unrecognized option to a destructured-params
      // function would be).
      const { committed } = buildDiag({ runKind: 'calibration', records: [r], failedChecksByRunId: { [r.run_id]: [] }, executionProfileId: 'attacker-controlled-id', policyMode: 'required' });
      expect(committed.execution_profile_id).toBe('sandboxed-unrestricted-v1');
      expect(committed.policy_mode).toBe('not_applicable');
    });
  });

  describe('validateRejectionRow -- schema-4-only fields', () => {
    function unrestrictedValidRow(overrides = {}) {
      const cellA = { run_id: 'r1', condition: 'no-skill', repetition_index: null, order_index: null, skill_source_sha: null, model_resolved: 'claude-sonnet-5-fake-resolved', claude_code_version: '1.2.3-fake', failed_checks: ['skillSelectionOk'], foreign_skill_summary: { rejected: 0, confirmed: 1, incomplete: 0 }, ambient_skill_profile: { count: 0, scope_id: '00000000-0000-4000-8000-000000000000', fingerprint_hmac: '0'.repeat(64) }, unexpected_tool_uses_count: 0 };
      const cellB = { run_id: 'r2', condition: 'current-skill', repetition_index: null, order_index: null, skill_source_sha: 'a'.repeat(40), model_resolved: 'claude-sonnet-5-fake-resolved', claude_code_version: '1.2.3-fake', failed_checks: [], foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 }, ambient_skill_profile: { count: 0, scope_id: '00000000-0000-4000-8000-000000000000', fingerprint_hmac: '0'.repeat(64) }, unexpected_tool_uses_count: 0 };
      return {
        schema: REJECTION_DIAGNOSTICS_SCHEMA_V4,
        rejection_id: '11111111-1111-1111-1111-111111111111',
        timestamp: '2026-07-21T00:00:00.000Z',
        run_kind: 'calibration',
        run_ids: ['r1', 'r2'],
        model_requested: 'fake-model-x',
        repo_commit: 'c'.repeat(40),
        scenario_id: 'calibration-explicit-invocation',
        project_alias: 'calibration-project',
        project_commit: null,
        seed: null,
        policy_sha256: null,
        execution_profile_id: 'sandboxed-unrestricted-v1',
        policy_mode: 'not_applicable',
        isolation_attestation_sha256: 'e'.repeat(64),
        platform: 'linux',
        privacy_status: 'public',
        cells: [cellA, cellB],
        foreign_skill_summary: { rejected: 0, confirmed: 1, incomplete: 0 },
        ambient_profile_matrix_ok: null,
        matrix_complete: true,
        planned_cell_count: 2,
        executed_cell_count: 2,
        raw_transcripts_persisted: true,
        ...overrides,
      };
    }

    it('accepts a well-formed schema-4 row cleanly', () => {
      expect(validateRejectionRow(unrestrictedValidRow()).errors).toEqual([]);
    });

    it('rejects a non-empty but non-slug execution_profile_id', () => {
      const { errors } = validateRejectionRow(unrestrictedValidRow({ execution_profile_id: 'Sandboxed-Unrestricted-V1' }));
      expect(errors.some((e) => e.field === 'execution_profile_id')).toBe(true);
    });

    it('rejects an empty execution_profile_id', () => {
      const { errors } = validateRejectionRow(unrestrictedValidRow({ execution_profile_id: '' }));
      expect(errors.some((e) => e.field === 'execution_profile_id')).toBe(true);
    });

    it('rejects policy_mode !== "not_applicable" -- required (or any other value) is never valid on schema 4', () => {
      const { errors } = validateRejectionRow(unrestrictedValidRow({ policy_mode: 'required' }));
      expect(errors.some((e) => e.field === 'policy_mode')).toBe(true);
    });

    it('rejects a missing isolation_attestation_sha256 (null -- the required-policy shape\'s own value)', () => {
      const { errors } = validateRejectionRow(unrestrictedValidRow({ isolation_attestation_sha256: null }));
      expect(errors.some((e) => e.field === 'isolation_attestation_sha256')).toBe(true);
    });

    it('rejects a malformed (non-hex64) isolation_attestation_sha256', () => {
      const { errors } = validateRejectionRow(unrestrictedValidRow({ isolation_attestation_sha256: 'not-a-real-hash' }));
      expect(errors.some((e) => e.field === 'isolation_attestation_sha256')).toBe(true);
    });

    it('rejects a schema-4 row whose policy_sha256 is a real hash instead of null', () => {
      const { errors } = validateRejectionRow(unrestrictedValidRow({ policy_sha256: 'a'.repeat(64) }));
      expect(errors.some((e) => e.field === 'policy_sha256')).toBe(true);
    });

    it('rejects a schema-4 row carrying extra, unrecognized fields', () => {
      const { errors } = validateRejectionRow({ ...unrestrictedValidRow(), extra_field: 'nope' });
      expect(errors.some((e) => e.field === 'extra_field' && e.message === 'unrecognized field')).toBe(true);
    });

    it('rejects a schema-3 row that ALSO carries the schema-4-only fields -- v3 and v4 field sets are disjoint at the top level, never merged', () => {
      const v3WithV4Fields = { ...unrestrictedValidRow(), schema: REJECTION_DIAGNOSTICS_SCHEMA_V3, policy_sha256: 'a'.repeat(64) };
      const { errors } = validateRejectionRow(v3WithV4Fields);
      expect(errors.some((e) => e.field === 'execution_profile_id' && e.message === 'unrecognized field')).toBe(true);
      expect(errors.some((e) => e.field === 'policy_mode' && e.message === 'unrecognized field')).toBe(true);
      expect(errors.some((e) => e.field === 'isolation_attestation_sha256' && e.message === 'unrecognized field')).toBe(true);
    });

    it('rejects a schema-4 row missing the schema-4-only fields entirely', () => {
      const row = unrestrictedValidRow();
      delete row.execution_profile_id;
      delete row.policy_mode;
      delete row.isolation_attestation_sha256;
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'execution_profile_id' && e.message === 'missing required field')).toBe(true);
      expect(errors.some((e) => e.field === 'policy_mode' && e.message === 'missing required field')).toBe(true);
      expect(errors.some((e) => e.field === 'isolation_attestation_sha256' && e.message === 'missing required field')).toBe(true);
    });

    // Schema 4 inherits the whole matrix_complete/planned_cell_count/executed_cell_count/
    // raw_transcripts_persisted contract from v3 unchanged -- fail-fast partial-matrix support is
    // orthogonal to policy_mode. One representative test per already-covered v3 rule, proving the
    // widened isV3||isV4 gate actually applies to schema 4, not just schema 3.
    it('still enforces matrix_complete as a real boolean on schema 4', () => {
      const { errors } = validateRejectionRow(unrestrictedValidRow({ matrix_complete: 'true' }));
      expect(errors.some((e) => e.field === 'matrix_complete')).toBe(true);
    });

    it('still enforces the noUnexpectedToolsOk <-> unexpected_tool_uses_count biconditional per cell on schema 4', () => {
      const row = unrestrictedValidRow();
      row.cells[0].failed_checks = ['noUnexpectedToolsOk'];
      row.cells[0].unexpected_tool_uses_count = 0;
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'cells[0].unexpected_tool_uses_count')).toBe(true);
    });

    it('still requires ambient_profile_matrix_ok:null on an incomplete (fail-fast-stopped) schema-4 scenario matrix', () => {
      const row = unrestrictedValidRow({
        run_kind: 'scenario', scenario_id: 'kampkit-android-host-test-discovery',
        project_alias: 'kampkit', project_commit: 'd'.repeat(40), seed: 5,
        matrix_complete: false, planned_cell_count: 4, executed_cell_count: 2,
        ambient_profile_matrix_ok: true,
      });
      row.cells = row.cells.map((c) => ({ ...c, repetition_index: 0, order_index: 0 }));
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'ambient_profile_matrix_ok')).toBe(true);
    });
  });
});

describe('deriveTranscriptFilename -- the single canonical filename derivation (never raw run_id, never order_index)', () => {
  it('produces <captureOrdinal>-<64 lowercase hex>.jsonl for a normal run_id', () => {
    const filename = deriveTranscriptFilename(0, 'calibration-current-skill-jjjj1111');
    expect(filename).toMatch(/^0-[0-9a-f]{64}\.jsonl$/);
  });

  it('is deterministic -- the same (captureOrdinal, runId) pair always derives the identical filename', () => {
    const a = deriveTranscriptFilename(3, 'some-run-id');
    const b = deriveTranscriptFilename(3, 'some-run-id');
    expect(a).toBe(b);
  });

  it('the SAME run_id at a DIFFERENT captureOrdinal produces a different filename (ordinal is part of the identity, not just decoration)', () => {
    const a = deriveTranscriptFilename(0, 'some-run-id');
    const b = deriveTranscriptFilename(1, 'some-run-id');
    expect(a).not.toBe(b);
  });

  it('never echoes the raw run_id anywhere in the filename, even for a run_id shaped like a Windows-reserved device name', () => {
    for (const reserved of ['CON', 'NUL', 'COM1', 'LPT1', 'AUX', 'PRN']) {
      const filename = deriveTranscriptFilename(0, reserved);
      expect(filename).toMatch(/^0-[0-9a-f]{64}\.jsonl$/);
      expect(filename.toUpperCase()).not.toContain(reserved);
    }
  });

  it('never produces a path-traversal-shaped filename, even for a run_id containing "../" or an absolute path', () => {
    for (const hostile of ['../../../etc/passwd', '..\\..\\windows\\system32', '/etc/passwd', 'C:\\Windows\\System32']) {
      const filename = deriveTranscriptFilename(0, hostile);
      expect(filename).toMatch(/^0-[0-9a-f]{64}\.jsonl$/);
      expect(filename).not.toContain('/');
      expect(filename).not.toContain('\\');
      expect(filename).not.toContain('..');
    }
  });

  it('never produces a filename ending in a dot or space, even for a run_id ending in one', () => {
    for (const trailing of ['some-run-id.', 'some-run-id ', 'some-run-id...']) {
      const filename = deriveTranscriptFilename(0, trailing);
      const withoutExtension = filename.replace(/\.jsonl$/, '');
      expect(withoutExtension.endsWith('.')).toBe(false);
      expect(withoutExtension.endsWith(' ')).toBe(false);
    }
  });

  it('throws on a negative captureOrdinal', () => {
    expect(() => deriveTranscriptFilename(-1, 'r1')).toThrow(/non-negative integer/);
  });

  it('throws on a non-integer captureOrdinal', () => {
    expect(() => deriveTranscriptFilename(1.5, 'r1')).toThrow(/non-negative integer/);
  });

  it('throws on a non-string runId', () => {
    expect(() => deriveTranscriptFilename(0, null)).toThrow(/non-empty string/);
  });

  it('throws on an empty-string runId', () => {
    expect(() => deriveTranscriptFilename(0, '')).toThrow(/non-empty string/);
  });

  it('NEVER derives from the schema\'s own order_index field -- calibrate/smoke records always have order_index:null, yet still need a real, distinct filename per side', () => {
    // order_index is irrelevant to this function's signature entirely (it takes captureOrdinal,
    // never a record) -- this documents that a null-order_index run_kind still works exactly like
    // any other, since captureOrdinal is always caller-assigned from EXECUTION position.
    const filenameA = deriveTranscriptFilename(0, 'calibration-no-skill-aaaa1111');
    const filenameB = deriveTranscriptFilename(1, 'calibration-current-skill-jjjj1111');
    expect(filenameA).toMatch(/^0-[0-9a-f]{64}\.jsonl$/);
    expect(filenameB).toMatch(/^1-[0-9a-f]{64}\.jsonl$/);
  });
});

describe('writeRejectionRawTranscripts -- Transaction 1 (raw transcripts, minimal failure surface)', () => {
  function isolatedRunsRoot(fn) {
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aerdw-raw-transcripts-'));
    try {
      return fn(runsRoot);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  }

  it('writes exactly N files, one per run_id, named via deriveTranscriptFilename', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      const transcriptsByRunId = { r1: '{"line":1}\n', r2: '{"line":2}\n' };
      const captureOrdinalByRunId = { r1: 0, r2: 1 };
      const result = writeRejectionRawTranscripts(rejectionId, transcriptsByRunId, captureOrdinalByRunId, { runsRootOverride: runsRoot });
      expect(result.transcriptCount).toBe(2);
      expect(result.transcriptsRelativeDir).toBe(path.join('agentic-eval-rejected', 'raw', 'transcripts', rejectionId));
      const dir = path.join(runsRoot, 'agentic-eval-rejected', 'raw', 'transcripts', rejectionId);
      const files = readdirSync(dir);
      expect(files.sort()).toEqual([deriveTranscriptFilename(0, 'r1'), deriveTranscriptFilename(1, 'r2')].sort());
      expect(readFileSync(path.join(dir, deriveTranscriptFilename(0, 'r1')), 'utf8')).toBe('{"line":1}\n');
      expect(readFileSync(path.join(dir, deriveTranscriptFilename(1, 'r2')), 'utf8')).toBe('{"line":2}\n');
    });
  });

  it('additionally returns rawTranscriptsManifest -- exactly the {run_id, capture_ordinal, filename} entries actually written, for the journal exact-correspondence discard check (decision 3/N)', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      const transcriptsByRunId = { r1: '{"line":1}\n', r2: '{"line":2}\n' };
      const captureOrdinalByRunId = { r1: 0, r2: 1 };
      const result = writeRejectionRawTranscripts(rejectionId, transcriptsByRunId, captureOrdinalByRunId, { runsRootOverride: runsRoot });
      expect(result.rawTranscriptsManifest).toEqual(
        expect.arrayContaining([
          { run_id: 'r1', capture_ordinal: 0, filename: deriveTranscriptFilename(0, 'r1') },
          { run_id: 'r2', capture_ordinal: 1, filename: deriveTranscriptFilename(1, 'r2') },
        ]),
      );
      expect(result.rawTranscriptsManifest.length).toBe(2);
    });
  });

  it('accepts an empty-string transcript -- legitimate and forensically meaningful (the session produced no stdout)', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      const result = writeRejectionRawTranscripts(rejectionId, { r1: '' }, { r1: 0 }, { runsRootOverride: runsRoot });
      expect(result.transcriptCount).toBe(1);
      const dir = path.join(runsRoot, 'agentic-eval-rejected', 'raw', 'transcripts', rejectionId);
      expect(readFileSync(path.join(dir, deriveTranscriptFilename(0, 'r1')), 'utf8')).toBe('');
    });
  });

  it('never redacts transcript content -- writes it byte-for-byte raw, same contract as any other raw/ tier', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      const rawContent = '{"secret_looking_but_never_redacted":"C:\\\\Users\\\\someuser\\\\file"}\n';
      writeRejectionRawTranscripts(rejectionId, { r1: rawContent }, { r1: 0 }, { runsRootOverride: runsRoot });
      const dir = path.join(runsRoot, 'agentic-eval-rejected', 'raw', 'transcripts', rejectionId);
      expect(readFileSync(path.join(dir, deriveTranscriptFilename(0, 'r1')), 'utf8')).toBe(rawContent);
    });
  });

  describe('fails BEFORE any filesystem operation on an untrustworthy rejectionId (G13 -- the "raw outside gitignore" risk realized via a non-UUID rejectionId)', () => {
    it('throws on a rejectionId containing a path-traversal sequence, and creates no directory at all', () => {
      isolatedRunsRoot((runsRoot) => {
        expect(() => writeRejectionRawTranscripts('../../etc/passwd', { r1: 'x' }, { r1: 0 }, { runsRootOverride: runsRoot })).toThrow(/full UUID string/);
        expect(existsSync(path.join(runsRoot, 'agentic-eval-rejected'))).toBe(false);
      });
    });

    it('throws on a truncated (non-UUID-shaped) rejectionId', () => {
      isolatedRunsRoot((runsRoot) => {
        expect(() => writeRejectionRawTranscripts('abcd1234', { r1: 'x' }, { r1: 0 }, { runsRootOverride: runsRoot })).toThrow(/full UUID string/);
        expect(existsSync(path.join(runsRoot, 'agentic-eval-rejected'))).toBe(false);
      });
    });

    it('throws on an absolute-path-shaped rejectionId', () => {
      isolatedRunsRoot((runsRoot) => {
        expect(() => writeRejectionRawTranscripts('C:\\Windows\\System32', { r1: 'x' }, { r1: 0 }, { runsRootOverride: runsRoot })).toThrow(/full UUID string/);
        expect(existsSync(path.join(runsRoot, 'agentic-eval-rejected'))).toBe(false);
      });
    });
  });

  it('throws when captureOrdinalByRunId is missing a key present in transcriptsByRunId (exact-set, never a silent 0-default)', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      expect(() => writeRejectionRawTranscripts(rejectionId, { r1: 'x', r2: 'y' }, { r1: 0 }, { runsRootOverride: runsRoot })).toThrow(/keys must exactly match/);
    });
  });

  it('throws when captureOrdinalByRunId has a stale/extra key not present in transcriptsByRunId', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      expect(() => writeRejectionRawTranscripts(rejectionId, { r1: 'x' }, { r1: 0, r2: 1 }, { runsRootOverride: runsRoot })).toThrow(/keys must exactly match/);
    });
  });

  it('throws when two run_ids share the same captureOrdinal (via validateCaptureOrdinalSet -- a duplicate can never form the exact {0..N-1} set)', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      expect(() => writeRejectionRawTranscripts(rejectionId, { r1: 'x', r2: 'y' }, { r1: 0, r2: 0 }, { runsRootOverride: runsRoot })).toThrow(/exact set \{0\.\.1\}/);
    });
  });

  // The exact P2 reproduction: {a:0, b:2} for 2 run_ids -- BOTH values are non-negative integers
  // AND pairwise-unique, so the pre-fix (weaker) check accepted this and genuinely wrote
  // "2-<hash>.jsonl" alongside "0-<hash>.jsonl" -- reproduced directly against the pre-fix code
  // before writing this test. A real gap (never claimed ordinal 1) must now be refused.
  it('throws on a GAP -- {a:0, b:2} for 2 run_ids -- never silently writes ordinal 2 as if the range were still dense', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      expect(() => writeRejectionRawTranscripts(rejectionId, { a: 'content-a', b: 'content-b' }, { a: 0, b: 2 }, { runsRootOverride: runsRoot })).toThrow(/exact set \{0\.\.1\}/);
      // Nothing was written at all -- the ordinal-set check fires before any promoteTargetsAtomically call.
      expect(existsSync(path.join(runsRoot, 'agentic-eval-rejected'))).toBe(false);
    });
  });

  it('throws when a captureOrdinal is negative', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      expect(() => writeRejectionRawTranscripts(rejectionId, { r1: 'x' }, { r1: -1 }, { runsRootOverride: runsRoot })).toThrow(/non-negative integer/);
    });
  });

  it('throws when a transcript value is not a string (never silently coerced)', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      expect(() => writeRejectionRawTranscripts(rejectionId, { r1: null }, { r1: 0 }, { runsRootOverride: runsRoot })).toThrow(/must be a string/);
    });
  });

  it('a pre-existing file at the target path aborts the whole transaction -- nothing else is written', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      writeRejectionRawTranscripts(rejectionId, { r1: 'first-write' }, { r1: 0 }, { runsRootOverride: runsRoot });
      // Re-using the SAME rejectionId + ordinal is a genuine collision: promoteTargetsAtomically's
      // own existsSync pre-check refuses before writing anything for this second call.
      expect(() => writeRejectionRawTranscripts(rejectionId, { r1: 'second-write', r2: 'other-content' }, { r1: 0, r2: 1 }, { runsRootOverride: runsRoot })).toThrow(/already exists/);
      const dir = path.join(runsRoot, 'agentic-eval-rejected', 'raw', 'transcripts', rejectionId);
      // The original file is untouched by the failed second call, and the OTHER (non-colliding)
      // target from that second call was never written either -- all-or-nothing, not partial.
      expect(readFileSync(path.join(dir, deriveTranscriptFilename(0, 'r1')), 'utf8')).toBe('first-write');
      expect(existsSync(path.join(dir, deriveTranscriptFilename(1, 'r2')))).toBe(false);
    });
  });
});

describe('deriveStderrFilename -- sibling of deriveTranscriptFilename, own extension (Diseño 4b)', () => {
  it('produces "<ordinal>-<sha256(runId)>.stderr.txt", never .jsonl', () => {
    const filename = deriveStderrFilename(0, 'calibration-current-skill-jjjj1111');
    expect(filename).toMatch(/^0-[0-9a-f]{64}\.stderr\.txt$/);
  });

  it('a runId containing path-traversal characters never produces a filename containing / or .. -- the hash-based derivation makes traversal structurally impossible, by construction rather than by escaping', () => {
    const filename = deriveStderrFilename(0, '../../etc/passwd');
    expect(filename).not.toContain('/');
    expect(filename).not.toContain('..');
    expect(filename).toMatch(/^0-[0-9a-f]{64}\.stderr\.txt$/);
  });

  it('throws on a negative captureOrdinal', () => {
    expect(() => deriveStderrFilename(-1, 'r1')).toThrow(/non-negative integer/);
  });

  it('throws on an empty runId', () => {
    expect(() => deriveStderrFilename(0, '')).toThrow(/non-empty string/);
  });
});

describe('writeRejectionRawStderr -- Transaction 3 (stderr, sibling of writeRejectionRawTranscripts, Diseño 4b)', () => {
  function isolatedRunsRoot(fn) {
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aerdw-raw-stderr-'));
    try {
      return fn(runsRoot);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  }

  it('writes exactly N files, one per run_id, named via deriveStderrFilename, ending .stderr.txt', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      const stderrByRunId = { r1: 'stderr one\n', r2: 'stderr two\n' };
      const captureOrdinalByRunId = { r1: 0, r2: 1 };
      const result = writeRejectionRawStderr(rejectionId, stderrByRunId, captureOrdinalByRunId, { runsRootOverride: runsRoot });
      expect(result.stderrCount).toBe(2);
      expect(result.stderrRelativeDir).toBe(path.join('agentic-eval-rejected', 'raw', 'stderr', rejectionId));
      const dir = path.join(runsRoot, 'agentic-eval-rejected', 'raw', 'stderr', rejectionId);
      const files = readdirSync(dir);
      expect(files.sort()).toEqual([deriveStderrFilename(0, 'r1'), deriveStderrFilename(1, 'r2')].sort());
      for (const f of files) expect(f).toMatch(/\.stderr\.txt$/);
      expect(readFileSync(path.join(dir, deriveStderrFilename(0, 'r1')), 'utf8')).toBe('stderr one\n');
      expect(readFileSync(path.join(dir, deriveStderrFilename(1, 'r2')), 'utf8')).toBe('stderr two\n');
    });
  });

  it('the returned stderrManifest byte_length/sha256 are computed from a REREAD of what actually landed on disk, never the input string in memory', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      const content = 'exact-content-to-verify-by-rereading-from-disk';
      const result = writeRejectionRawStderr(rejectionId, { r1: content }, { r1: 0 }, { runsRootOverride: runsRoot });
      const dir = path.join(runsRoot, 'agentic-eval-rejected', 'raw', 'stderr', rejectionId);
      const onDisk = readFileSync(path.join(dir, deriveStderrFilename(0, 'r1')), 'utf8');
      expect(onDisk).toBe(content);
      const entry = result.stderrManifest.find((e) => e.run_id === 'r1');
      expect(entry.capture_ordinal).toBe(0);
      expect(entry.filename).toBe(deriveStderrFilename(0, 'r1'));
      expect(entry.byte_length).toBe(Buffer.byteLength(onDisk, 'utf8'));
      expect(entry.sha256).toBe(createHash('sha256').update(onDisk, 'utf8').digest('hex'));
    });
  });

  it('accepts an empty-string stderr -- legitimate and forensically meaningful (the cell produced no stderr)', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      const result = writeRejectionRawStderr(rejectionId, { r1: '' }, { r1: 0 }, { runsRootOverride: runsRoot });
      expect(result.stderrCount).toBe(1);
      const dir = path.join(runsRoot, 'agentic-eval-rejected', 'raw', 'stderr', rejectionId);
      expect(readFileSync(path.join(dir, deriveStderrFilename(0, 'r1')), 'utf8')).toBe('');
      expect(result.stderrManifest[0].byte_length).toBe(0);
    });
  });

  it('throws when a stderrByRunId value is undefined (never silently treated as \'\' -- absent must never become empty)', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      expect(() => writeRejectionRawStderr(rejectionId, { r1: undefined }, { r1: 0 }, { runsRootOverride: runsRoot })).toThrow(/must be a string/);
      expect(existsSync(path.join(runsRoot, 'agentic-eval-rejected'))).toBe(false);
    });
  });

  it('throws when a stderrByRunId value is null (the same structural failure as undefined, never coerced)', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      expect(() => writeRejectionRawStderr(rejectionId, { r1: null }, { r1: 0 }, { runsRootOverride: runsRoot })).toThrow(/must be a string/);
    });
  });

  it('throws when a stderrByRunId value is a number (any non-string type, not just null/undefined)', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      expect(() => writeRejectionRawStderr(rejectionId, { r1: 42 }, { r1: 0 }, { runsRootOverride: runsRoot })).toThrow(/must be a string/);
    });
  });

  it('rejects a rejectionId that is not a full UUID, before any filesystem operation', () => {
    isolatedRunsRoot((runsRoot) => {
      expect(() => writeRejectionRawStderr('not-a-uuid', { r1: 'x' }, { r1: 0 }, { runsRootOverride: runsRoot })).toThrow(/full UUID string/);
      expect(existsSync(path.join(runsRoot, 'agentic-eval-rejected'))).toBe(false);
    });
  });

  it('throws when captureOrdinalByRunId keys do not exactly match stderrByRunId keys (same exact-set discipline as writeRejectionRawTranscripts)', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      expect(() => writeRejectionRawStderr(rejectionId, { r1: 'x', r2: 'y' }, { r1: 0 }, { runsRootOverride: runsRoot })).toThrow(/keys must exactly match/);
    });
  });

  it('accepts an already-redacted value containing a known PII shape (a Windows user-home path) -- the file on disk stays redacted, matching what the journal\'s own readStderrFor already produced', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      const sensitive = 'Error: ENOENT, open \'C:\\Users\\realname\\.claude\\config.json\'';
      // writeRejectionRawStderr's own contract (see its doc comment) is to receive the value
      // ALREADY redacted -- exactly what journal.readStderrFor(cellOrdinal) returns in production,
      // never the raw stderr text. Pre-redact once here to match that real caller contract; the
      // dedicated re-verification test above already proves an UNREDACTED value is refused.
      const { ok, redacted: alreadyRedacted } = redactAndVerify(sensitive);
      expect(ok).toBe(true);
      expect(alreadyRedacted).not.toContain('realname');
      const result = writeRejectionRawStderr(rejectionId, { r1: alreadyRedacted }, { r1: 0 }, { runsRootOverride: runsRoot });
      const dir = path.join(runsRoot, 'agentic-eval-rejected', 'raw', 'stderr', rejectionId);
      const onDisk = readFileSync(path.join(dir, deriveStderrFilename(0, 'r1')), 'utf8');
      expect(onDisk).not.toContain('realname');
      expect(findLeaks(onDisk, PUBLIC_SHAPE_RULES)).toEqual([]);
      expect(result.stderrManifest[0].sha256).toBe(createHash('sha256').update(onDisk, 'utf8').digest('hex'));
    });
  });

  // Round-2/round-4 audit findings (Diseño 4b): writeRejectionRawStderr re-verifies the
  // ALREADY-redacted value it receives against the privacy pipeline a second time, rather than
  // trusting the caller. This proves that pass is real (it actually catches an unredacted value),
  // not a no-op trust-through -- an upstream redaction that was somehow incomplete must never
  // silently reach disk.
  it('refuses (throws) when the input still matches a configured private-pattern rule -- proves the re-verification pass is real, never a no-op trust-through of an "already redacted" value', () => {
    isolatedRunsRoot((runsRoot) => {
      const patternsFile = path.join(runsRoot, 'private-patterns.json');
      const marker = 'totally-fake-marker-for-redaction-idempotency-test';
      writeFileSync(patternsFile, JSON.stringify([{ class: 'test_marker', literal: marker, replacement: '<REDACTED>' }]));
      const rejectionId = randomUUID();
      expect(() => writeRejectionRawStderr(rejectionId, { r1: `stderr containing ${marker}` }, { r1: 0 }, { runsRootOverride: runsRoot, privatePatternsFile: patternsFile }))
        .toThrow(/not byte-identical/);
      // Nothing was written -- the transaction aborts before any promoteTargetsAtomically call.
      expect(existsSync(path.join(runsRoot, 'agentic-eval-rejected', 'raw', 'stderr', rejectionId))).toBe(false);
    });
  });

  // Round-3/round-4 audit findings: a real fs-level failure is a raw throw AT THIS LAYER (same
  // contract writeRejectionRawTranscripts already has, see the "pre-existing file" test above) --
  // closing the code to the fixed 'stderr_write_failed' and dropping err.message is
  // writeRejectionForensics' (cli.mjs) responsibility, verified separately at that layer (see
  // agentic-eval-cli.test.js's finalizeAndWriteRecords-level coverage).
  it('a real filesystem failure (a plain file occupying the path a directory needs to be created at) is a genuine throw, not a silent success', () => {
    isolatedRunsRoot((runsRoot) => {
      const rawDir = path.join(runsRoot, 'agentic-eval-rejected', 'raw');
      mkdirSync(rawDir, { recursive: true });
      writeFileSync(path.join(rawDir, 'stderr'), 'blocking-file'); // occupies the directory slot as a file
      const rejectionId = randomUUID();
      expect(() => writeRejectionRawStderr(rejectionId, { r1: 'x' }, { r1: 0 }, { runsRootOverride: runsRoot })).toThrow();
    });
  });
});

describe('readRejectionStderrFile -- always derives its own filename internally, never accepts one as input (path-traversal defense, Diseño 4b round-4 audit finding)', () => {
  function isolatedRunsRoot(fn) {
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aerdw-read-stderr-'));
    try {
      return fn(runsRoot);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  }

  it('reads back exactly what writeRejectionRawStderr wrote, for the real (captureOrdinal, runId) pair', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      writeRejectionRawStderr(rejectionId, { r1: 'real content' }, { r1: 0 }, { runsRootOverride: runsRoot });
      expect(readRejectionStderrFile(rejectionId, 0, 'r1', { runsRootOverride: runsRoot })).toBe('real content');
    });
  });

  it('returns null for a (captureOrdinal, runId) pair that was never written -- same absent-not-thrown contract as the journal\'s readRawFor/readStderrFor', () => {
    isolatedRunsRoot((runsRoot) => {
      const rejectionId = randomUUID();
      expect(readRejectionStderrFile(rejectionId, 0, 'never-written', { runsRootOverride: runsRoot })).toBeNull();
    });
  });

  // The direct reproduction: a runId crafted to look like a traversal sequence can never escape
  // raw/stderr/<rejection_id>/, because the filename is ALWAYS derived internally via
  // deriveStderrFilename's hash -- there is no parameter this function accepts that could carry a
  // raw filename/path fragment straight into the read path. A sentinel file placed OUTSIDE the
  // expected directory proves this end-to-end: if a future refactor ever regressed to building the
  // read path directly from an external value, this is what would catch it.
  it('a runId containing traversal characters never causes a read outside the expected rejection stderr directory -- returns null, never a file from elsewhere', () => {
    isolatedRunsRoot((runsRoot) => {
      const sentinelPath = path.join(runsRoot, 'sentinel.txt');
      writeFileSync(sentinelPath, 'LEAKED_CONTENT_OUTSIDE_REJECTION_DIR');
      const rejectionId = randomUUID();
      const result = readRejectionStderrFile(rejectionId, 0, '../../../sentinel', { runsRootOverride: runsRoot });
      expect(result).toBeNull();
      expect(result).not.toBe('LEAKED_CONTENT_OUTSIDE_REJECTION_DIR');
    });
  });

  it('throws on a rejectionId that is not a full UUID', () => {
    isolatedRunsRoot((runsRoot) => {
      expect(() => readRejectionStderrFile('not-a-uuid', 0, 'r1', { runsRootOverride: runsRoot })).toThrow(/full UUID string/);
    });
  });
});

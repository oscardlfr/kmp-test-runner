// tests/vitest/agentic-eval-rejection-diagnostics.test.js
// Unit tests for tools/agentic-eval/rejection-diagnostics.mjs (pure construction + validation)
// plus real-subprocess integration tests proving the two-tier write is actually wired into
// cli.mjs's calibrate/smoke/run failure paths -- closing BACKLOG.md's "leave no auditable trace"
// gap. See evidence-io.mjs's own doc comment for the exact (not overclaimed) atomicity contract
// this module reuses rather than reinventing.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REJECTION_DIAGNOSTICS_SCHEMA,
  buildRejectionDiagnostics,
  validateRejectionRow,
  writeRejectedRunDiagnostics,
} from '../../tools/agentic-eval/rejection-diagnostics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'tools', 'agentic-eval', 'cli.mjs');
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

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

describe('buildRejectionDiagnostics -- pure construction', () => {
  it('builds a committed record with the closed field set, and a local companion with extra foreign_skill_names', () => {
    const recordA = record();
    const recordB = record({ run_id: 'calibration-current-skill-bbbb2222', condition: 'current-skill', skill_source_sha: 'a'.repeat(40) });
    const { committed, local } = buildRejectionDiagnostics({
      runKind: 'calibration',
      records: [recordA, recordB],
      failedChecksByRunId: { [recordA.run_id]: ['skillSelectionOk'], [recordB.run_id]: [] },
      foreignSkillNamesByRunId: { [recordA.run_id]: ['some-other-skill'], [recordB.run_id]: [] },
    });
    expect(committed.schema).toBe(REJECTION_DIAGNOSTICS_SCHEMA);
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
    const { local } = buildRejectionDiagnostics({
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
    const { committed } = buildRejectionDiagnostics({ runKind: 'calibration', records: [a, b], failedChecksByRunId: { [a.run_id]: [], [b.run_id]: [] } });
    expect(committed.foreign_skill_summary).toEqual({ rejected: 2, confirmed: 1, incomplete: 1 });
  });

  it('includes every cell, not only ones with failed_checks -- scenario batches need the whole matrix as context', () => {
    const clean = scenarioRecord({ run_id: 'scenario-no-skill-dddd4444' });
    const failing = scenarioRecord({ run_id: 'scenario-current-skill-eeee5555', condition: 'current-skill', skill_source_sha: 'b'.repeat(40) });
    const { committed } = buildRejectionDiagnostics({
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
    expect(() => buildRejectionDiagnostics({ runKind: 'calibration', records: [a, b], failedChecksByRunId: { [a.run_id]: [], [b.run_id]: [] } })).toThrow(/disagree on repo_commit/);
  });

  it('throws (never silently picks one) when contributing records disagree on model_requested', () => {
    const a = record({ model_requested: 'model-x' });
    const b = record({ run_id: 'calibration-current-skill-ffff7777', model_requested: 'model-y' });
    expect(() => buildRejectionDiagnostics({ runKind: 'calibration', records: [a, b], failedChecksByRunId: { [a.run_id]: [], [b.run_id]: [] } })).toThrow(/disagree on model_requested/);
  });

  // Round-6 audit finding ("diagnostic provenance"): the disagreement check generalized from a
  // hardcoded repo_commit/model_requested pair to a shared BATCH_WIDE_FIELDS loop covering 10
  // fields -- this proves the loop actually reaches a field OTHER than the original two, not just
  // that the two pre-existing checks still work by coincidence of being first in the list.
  it('throws (never silently picks one) when contributing records disagree on scenario_id', () => {
    const a = scenarioRecord({ scenario_id: 'kampkit-android-host-test-discovery' });
    const b = scenarioRecord({ run_id: 'scenario-current-skill-gggg8888', condition: 'current-skill', skill_source_sha: 'b'.repeat(40), scenario_id: 'kampkit-no-applicable-tests' });
    expect(() => buildRejectionDiagnostics({ runKind: 'scenario', records: [a, b], failedChecksByRunId: { [a.run_id]: [], [b.run_id]: [] } })).toThrow(/disagree on scenario_id/);
  });

  it('throws when contributing records disagree on seed (a scenario-only field, still checked)', () => {
    const a = scenarioRecord({ seed: 1 });
    const b = scenarioRecord({ run_id: 'scenario-current-skill-hhhh9999', condition: 'current-skill', skill_source_sha: 'b'.repeat(40), seed: 2 });
    expect(() => buildRejectionDiagnostics({ runKind: 'scenario', records: [a, b], failedChecksByRunId: { [a.run_id]: [], [b.run_id]: [] } })).toThrow(/disagree on seed/);
  });

  // Round-7 audit finding ("atribución por celda todavía fail-open"): runKind must match every
  // record's OWN run_kind -- proves calibration-shaped records can no longer masquerade as a
  // smoke batch just because the caller's runKind parameter says so.
  it('throws when runKind does not match a record\'s own run_kind', () => {
    const a = record(); // run_kind: 'calibration'
    const b = record({ run_id: 'calibration-current-skill-jjjj2222', condition: 'current-skill' });
    expect(() => buildRejectionDiagnostics({ runKind: 'smoke', records: [a, b], failedChecksByRunId: { [a.run_id]: [], [b.run_id]: [] } }))
      .toThrow(/runKind \('smoke'\) does not match record .+'s own run_kind \('calibration'\)/);
  });

  // Round-7 audit finding (same section): failedChecksByRunId must have EXACTLY the same key set
  // as records[].run_id -- reproduces the user's own repro shape (a key silently missing from the
  // map) as a dedicated, isolated test.
  it('throws when failedChecksByRunId is missing a key for one of the records', () => {
    const a = record();
    const b = record({ run_id: 'calibration-current-skill-kkkk3333', condition: 'current-skill' });
    expect(() => buildRejectionDiagnostics({ runKind: 'calibration', records: [a, b], failedChecksByRunId: { [a.run_id]: ['skillSelectionOk'] } }))
      .toThrow(/failedChecksByRunId's keys must exactly match records\[\]\.run_id \(missing: \["calibration-current-skill-kkkk3333"\]/);
  });

  it('throws when failedChecksByRunId has a stale/extra key not present in records', () => {
    const a = record();
    expect(() => buildRejectionDiagnostics({ runKind: 'calibration', records: [a], failedChecksByRunId: { [a.run_id]: ['skillSelectionOk'], 'stale-run-id-from-a-different-batch': ['x'] } }))
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
    const { committed, local } = buildRejectionDiagnostics({ runKind: 'scenario', records: [a, b], failedChecksByRunId: { [a.run_id]: ['toolResultsCompleteOk'], [b.run_id]: [] } });
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
  function validRow(overrides = {}) {
    const cellA = { run_id: 'r1', condition: 'no-skill', repetition_index: null, order_index: null, skill_source_sha: null, model_resolved: 'claude-sonnet-5-fake-resolved', claude_code_version: '1.2.3-fake', failed_checks: ['skillSelectionOk'], foreign_skill_summary: { rejected: 0, confirmed: 1, incomplete: 0 } };
    const cellB = { run_id: 'r2', condition: 'current-skill', repetition_index: null, order_index: null, skill_source_sha: 'a'.repeat(40), model_resolved: 'claude-sonnet-5-fake-resolved', claude_code_version: '1.2.3-fake', failed_checks: [], foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 } };
    return {
      schema: REJECTION_DIAGNOSTICS_SCHEMA,
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
    const { committed, local } = buildRejectionDiagnostics({
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
    const { committed, local } = buildRejectionDiagnostics({
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
      const r = spawnSync('node', [CLI_PATH, 'calibrate', '--model', 'fake-model-x'], { env: fakeClaudeEnv('foreign-skill', runsRoot), encoding: 'utf8', timeout: 20000 });
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
      const r = spawnSync('node', [CLI_PATH, 'calibrate', '--model', 'fake-model-x'], { env: fakeClaudeEnv('success', runsRoot), encoding: 'utf8', timeout: 20000 });
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
      const r = spawnSync('node', [CLI_PATH, 'calibrate', '--model', 'fake-model-x', '--private-patterns-file', '/definitely/does/not/exist.json'], { env: fakeClaudeEnv('success', runsRoot), encoding: 'utf8', timeout: 20000 });
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

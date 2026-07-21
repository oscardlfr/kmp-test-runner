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

function record(overrides = {}) {
  return {
    run_id: 'calibration-no-skill-aaaa1111',
    condition: 'no-skill',
    repetition_index: null,
    order_index: null,
    skill_source_sha: null,
    model_resolved: 'claude-sonnet-5-fake-resolved',
    repo_commit: 'c'.repeat(40),
    model_requested: 'fake-model-x',
    scenario_id: 'calibration-explicit-invocation',
    project_alias: null,
    project_commit: null,
    project_url: null,
    seed: null,
    policy_sha256: 'a'.repeat(64),
    foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 },
    ...overrides,
  };
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
      failedChecksByRunId: {},
      foreignSkillNamesByRunId: { [r.run_id]: ['zeta', 'alpha', 'zeta', 'alpha'] },
    });
    expect(local.cells[0].foreign_skill_names).toEqual(['alpha', 'zeta']);
  });

  it('sums foreign_skill_summary across every cell into the top-level total', () => {
    const a = record({ foreign_skill_summary: { rejected: 2, confirmed: 0, incomplete: 1 } });
    const b = record({ run_id: 'calibration-current-skill-cccc3333', condition: 'current-skill', foreign_skill_summary: { rejected: 0, confirmed: 1, incomplete: 0 } });
    const { committed } = buildRejectionDiagnostics({ runKind: 'calibration', records: [a, b], failedChecksByRunId: {} });
    expect(committed.foreign_skill_summary).toEqual({ rejected: 2, confirmed: 1, incomplete: 1 });
  });

  it('includes every cell, not only ones with failed_checks -- scenario batches need the whole matrix as context', () => {
    const clean = record({ run_id: 'scenario-no-skill-dddd4444', repetition_index: 0 });
    const failing = record({ run_id: 'scenario-current-skill-eeee5555', condition: 'current-skill', repetition_index: 0, skill_source_sha: 'b'.repeat(40) });
    const { committed } = buildRejectionDiagnostics({
      runKind: 'scenario',
      records: [clean, failing],
      failedChecksByRunId: { [failing.run_id]: ['toolResultsCompleteOk'] },
    });
    expect(committed.cells.length).toBe(2);
    expect(committed.cells.find((c) => c.run_id === clean.run_id).failed_checks).toEqual([]);
  });

  it('throws (never silently picks one) when contributing records disagree on repo_commit', () => {
    const a = record({ repo_commit: 'c'.repeat(40) });
    const b = record({ run_id: 'calibration-current-skill-ffff6666', repo_commit: 'd'.repeat(40) });
    expect(() => buildRejectionDiagnostics({ runKind: 'calibration', records: [a, b], failedChecksByRunId: {} })).toThrow(/disagree on repo_commit/);
  });

  it('throws (never silently picks one) when contributing records disagree on model_requested', () => {
    const a = record({ model_requested: 'model-x' });
    const b = record({ run_id: 'calibration-current-skill-ffff7777', model_requested: 'model-y' });
    expect(() => buildRejectionDiagnostics({ runKind: 'calibration', records: [a, b], failedChecksByRunId: {} })).toThrow(/disagree on model_requested/);
  });

  // Round-6 audit finding ("diagnostic provenance"): the disagreement check generalized from a
  // hardcoded repo_commit/model_requested pair to a shared BATCH_WIDE_FIELDS loop covering 8
  // fields -- this proves the loop actually reaches a field OTHER than the original two, not just
  // that the two pre-existing checks still work by coincidence of being first in the list.
  it('throws (never silently picks one) when contributing records disagree on scenario_id', () => {
    const a = record({ scenario_id: 'kampkit-android-host-test-discovery' });
    const b = record({ run_id: 'scenario-current-skill-gggg8888', scenario_id: 'kampkit-no-applicable-tests' });
    expect(() => buildRejectionDiagnostics({ runKind: 'scenario', records: [a, b], failedChecksByRunId: {} })).toThrow(/disagree on scenario_id/);
  });

  it('throws when contributing records disagree on seed (a scenario-only field, still checked)', () => {
    const a = record({ seed: 1 });
    const b = record({ run_id: 'scenario-current-skill-hhhh9999', seed: 2 });
    expect(() => buildRejectionDiagnostics({ runKind: 'scenario', records: [a, b], failedChecksByRunId: {} })).toThrow(/disagree on seed/);
  });

  // Round-6 audit finding ("diagnostic provenance"): every new field must actually reach the
  // output, not just pass the disagreement check silently -- proves order_index/model_resolved
  // (per-cell) and the 6 new batch-wide fields all land in `committed`, read directly off the
  // records (buildRunRecord's own field names), never re-derived.
  it('populates order_index/model_resolved per cell, and every new batch-wide provenance field, from the records', () => {
    const a = record({
      order_index: 0, model_resolved: 'claude-sonnet-5-2026-06-01', scenario_id: 'kampkit-android-host-test-discovery',
      project_alias: 'kampkit', project_commit: 'd'.repeat(40), project_url: 'https://github.com/example/kampkit', seed: 7,
      policy_sha256: 'b'.repeat(64), repetition_index: 0,
    });
    const b = record({
      run_id: 'scenario-current-skill-iiii0000', condition: 'current-skill', skill_source_sha: 'a'.repeat(40),
      order_index: 1, model_resolved: 'claude-sonnet-5-2026-06-01', scenario_id: 'kampkit-android-host-test-discovery',
      project_alias: 'kampkit', project_commit: 'd'.repeat(40), project_url: 'https://github.com/example/kampkit', seed: 7,
      policy_sha256: 'b'.repeat(64), repetition_index: 0,
    });
    const { committed } = buildRejectionDiagnostics({ runKind: 'scenario', records: [a, b], failedChecksByRunId: { [a.run_id]: ['toolResultsCompleteOk'] } });
    expect(committed.scenario_id).toBe('kampkit-android-host-test-discovery');
    expect(committed.project_alias).toBe('kampkit');
    expect(committed.project_commit).toBe('d'.repeat(40));
    expect(committed.project_url).toBe('https://github.com/example/kampkit');
    expect(committed.seed).toBe(7);
    expect(committed.policy_sha256).toBe('b'.repeat(64));
    expect(committed.cells[0].order_index).toBe(0);
    expect(committed.cells[1].order_index).toBe(1);
    expect(committed.cells[0].model_resolved).toBe('claude-sonnet-5-2026-06-01');
    // The record built from `committed` is itself schema-valid -- the strongest possible proof
    // that every new field landed in a shape validateRejectionRow actually accepts.
    expect(validateRejectionRow(committed).errors).toEqual([]);
  });
});

describe('validateRejectionRow -- schema validation', () => {
  function validRow(overrides = {}) {
    const cellA = { run_id: 'r1', condition: 'no-skill', repetition_index: null, order_index: null, skill_source_sha: null, model_resolved: 'claude-sonnet-5-fake-resolved', failed_checks: ['skillSelectionOk'], foreign_skill_summary: { rejected: 0, confirmed: 1, incomplete: 0 } };
    const cellB = { run_id: 'r2', condition: 'current-skill', repetition_index: null, order_index: null, skill_source_sha: 'a'.repeat(40), model_resolved: 'claude-sonnet-5-fake-resolved', failed_checks: [], foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 } };
    return {
      schema: REJECTION_DIAGNOSTICS_SCHEMA,
      rejection_id: '11111111-1111-1111-1111-111111111111',
      timestamp: '2026-07-21T00:00:00.000Z',
      run_kind: 'calibration',
      run_ids: ['r1', 'r2'],
      model_requested: 'fake-model-x',
      repo_commit: 'c'.repeat(40),
      scenario_id: 'calibration-explicit-invocation',
      project_alias: null,
      project_commit: null,
      project_url: null,
      seed: null,
      policy_sha256: 'a'.repeat(64),
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
      const row = validRow({ run_kind: 'scenario', scenario_id: 'kampkit-android-host-test-discovery', project_alias: 'kampkit', project_commit: 'd'.repeat(40), project_url: 'https://github.com/example/kampkit', seed: 5 });
      row.cells[0] = { ...row.cells[0], repetition_index: null, order_index: null };
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'cells[0].repetition_index' && e.message.includes("run_kind:'scenario'"))).toBe(true);
      expect(errors.some((e) => e.field === 'cells[0].order_index')).toBe(true);
    });

    it('accepts a real non-negative repetition_index/order_index on a run_kind:scenario row', () => {
      const row = validRow({ run_kind: 'scenario', scenario_id: 'kampkit-android-host-test-discovery', project_alias: 'kampkit', project_commit: 'd'.repeat(40), project_url: 'https://github.com/example/kampkit', seed: 5 });
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

  describe('provenance fields (round-6 audit finding: scenario_id/project_*/seed/policy_sha256)', () => {
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

    it('rejects an empty-string project_alias (must be null or a REAL non-empty string, never empty)', () => {
      const row = validRow({ project_alias: '' });
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'project_alias')).toBe(true);
    });

    it('accepts a real scenario\'s project_alias/project_commit/project_url/seed (non-null)', () => {
      const row = validRow({ run_kind: 'scenario', scenario_id: 'kampkit-android-host-test-discovery', project_alias: 'kampkit', project_commit: 'd'.repeat(40), project_url: 'https://github.com/example/kampkit', seed: 5 });
      row.cells = row.cells.map((c, i) => ({ ...c, repetition_index: 0, order_index: i }));
      const { errors } = validateRejectionRow(row);
      expect(errors.filter((e) => e.field.startsWith('project_') || e.field === 'seed')).toEqual([]);
    });

    it('rejects a non-integer seed', () => {
      const row = validRow({ seed: 'five' });
      const { errors } = validateRejectionRow(row);
      expect(errors.some((e) => e.field === 'seed')).toBe(true);
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
    const { committed, local } = buildRejectionDiagnostics({
      runKind: 'calibration',
      records: [r, record({ run_id: 'calibration-current-skill-bbbb2222', condition: 'current-skill', skill_source_sha: 'a'.repeat(40) })],
      // At least one real failed check -- an empty failedChecksByRunId would produce
      // failed_checks:[] on every cell, itself now a distinct validation failure ("rechazo sin
      // causa" -- see the dedicated describe block below), which would trip THIS test for the
      // wrong reason entirely.
      failedChecksByRunId: { [r.run_id]: ['skillSelectionOk'] },
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
    const { committed, local } = buildRejectionDiagnostics({
      runKind: 'calibration',
      records: [r, record({ run_id: 'calibration-current-skill-jjjj1111', condition: 'current-skill', skill_source_sha: 'a'.repeat(40) })],
      failedChecksByRunId: { [r.run_id]: ['skillSelectionOk'] },
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
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('CALIBRATION FAILED');

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

      // "Localización del diagnóstico" (round-6 audit finding): the CLI's own stderr must point a
      // human at the actual file it just wrote -- checked against the REAL committed.rejection_id
      // (read back off disk above), not merely "some UUID-shaped string appears in stderr".
      expect(r.stderr).toContain(`rejection_id ${committed.rejection_id}`);
      expect(r.stderr).toContain(`agentic-eval-rejected${path.sep}${committedFiles[0]}`);

      const local = JSON.parse(readFileSync(path.join(rejectedDir, 'raw', rawFiles[0]), 'utf8'));
      expect(local.cells.some((c) => c.foreign_skill_names?.includes('totally-unrelated-skill'))).toBe(true);

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

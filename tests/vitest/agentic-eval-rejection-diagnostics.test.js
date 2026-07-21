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
    skill_source_sha: null,
    repo_commit: 'c'.repeat(40),
    model_requested: 'fake-model-x',
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
});

describe('validateRejectionRow -- schema validation', () => {
  function validRow(overrides = {}) {
    const cellA = { run_id: 'r1', condition: 'no-skill', repetition_index: null, skill_source_sha: null, failed_checks: ['skillSelectionOk'], foreign_skill_summary: { rejected: 0, confirmed: 1, incomplete: 0 } };
    const cellB = { run_id: 'r2', condition: 'current-skill', repetition_index: null, skill_source_sha: 'a'.repeat(40), failed_checks: [], foreign_skill_summary: { rejected: 0, confirmed: 0, incomplete: 0 } };
    return {
      schema: REJECTION_DIAGNOSTICS_SCHEMA,
      rejection_id: '11111111-1111-1111-1111-111111111111',
      timestamp: '2026-07-21T00:00:00.000Z',
      run_kind: 'calibration',
      run_ids: ['r1', 'r2'],
      model_requested: 'fake-model-x',
      repo_commit: 'c'.repeat(40),
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
      failedChecksByRunId: {},
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

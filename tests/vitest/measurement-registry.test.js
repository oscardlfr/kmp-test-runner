// tests/vitest/measurement-registry.test.js
// Unit tests for tools/measurement-registry.mjs.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_FIELDS,
  PLATFORM_VALUES,
  validateRow,
  validateRows,
  parseJsonlFile,
  rowToCsvRecord,
  toCsv,
  buildSummary,
  buildFeatureTable,
  nextRunSeq,
  appendRows,
  cmdValidate,
  cmdExportCsv,
  cmdSummarize,
} from '../../tools/measurement-registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '../../tools/measurement-registry.mjs');

// Split so the literal doesn't trip tools/decouple-audit.mjs's own self-scan
// once this test file is committed (same dodge as decouple-audit.test.js).
const WIN_ABS_FIXTURE = 'C:\\Users\\' + 'testuser\\project\\tools\\runs\\coverage\\A-run1.txt';

const tmpDirs = [];
function makeTmpDir() {
  const d = mkdtempSync(path.join(os.tmpdir(), 'mr-test-'));
  tmpDirs.push(d);
  return d;
}
function tmpJsonlFile(dir, name, lines) {
  const p = path.join(dir, name);
  writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + (lines.length ? '\n' : ''), 'utf8');
  return p;
}
function makeSink() {
  const log = [];
  const error = [];
  return { sink: { log: (m) => log.push(m), error: (m) => error.push(m) }, log, error };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------
function validRow(overrides = {}) {
  return {
    schema: 1,
    run_id: '2026-07-16-parallel-nowinandroid-not-recorded-smoke-warm-01',
    date: '2026-07-16',
    release_context: 'unreleased (post-v0.14.0)',
    platform: 'not-recorded',
    os_version: 'not-recorded',
    node_version: 'not-recorded',
    java_version: 'not-recorded',
    project_alias: 'NowInAndroid',
    project_visibility: 'public',
    project_url: 'not-recorded',
    project_commit: 'not-recorded',
    feature: 'parallel',
    scope: 'module-filter=**, test-task=test',
    command_shape: 'node tools/measure-token-cost.js --feature parallel',
    measurement_kind: 'smoke',
    cache_state: 'warm',
    approach: 'C',
    tokenizer: 'cl100k_base',
    token_count: 2013,
    bytes: null,
    chunking: 'none',
    raw_capture_committed: false,
    raw_capture_location: 'tools/runs/multi-project-token-cost-2026-07-16/per-project/NowInAndroid/parallel/C-run-N.txt',
    privacy_status: 'public',
    source_artifact: 'tools/runs/token-cost-validation-2026-07-16.md',
    notes: '',
    ...overrides,
  };
}

function validPrivateRow(overrides = {}) {
  return validRow({
    run_id: '2026-05-19-coverage-private-large-a-not-recorded-private-reference-unknown-01',
    date: '2026-05-19',
    release_context: 'v0.10.1',
    project_alias: 'private-large-A',
    project_visibility: 'private',
    project_url: null,
    project_commit: null,
    feature: 'coverage',
    measurement_kind: 'private-reference',
    cache_state: 'unknown',
    approach: 'A',
    tokenizer: 'claude-opus-4-8',
    token_count: 36571742,
    bytes: 74189422,
    chunking: 'chunked:23@~3.1MiB',
    raw_capture_location: 'tools/runs/coverage/A-run1.txt',
    privacy_status: 'redacted-private',
    source_artifact: 'tools/runs/cross-model-results-coverage.txt',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// validateRow — per-row checks
// ---------------------------------------------------------------------------
describe('validateRow — valid rows', () => {
  it('accepts a fully valid public row', () => {
    expect(validateRow(validRow()).errors).toEqual([]);
  });

  it('accepts a fully valid private row', () => {
    expect(validateRow(validPrivateRow()).errors).toEqual([]);
  });
});

describe('validateRow — key shape', () => {
  it('rejects a non-object row', () => {
    expect(validateRow(null).errors.length).toBeGreaterThan(0);
    expect(validateRow('nope').errors.length).toBeGreaterThan(0);
    expect(validateRow([]).errors.length).toBeGreaterThan(0);
  });

  it('flags a missing required field by name', () => {
    const row = validRow();
    delete row.token_count;
    const errors = validateRow(row).errors;
    expect(errors.some((e) => e.includes('"token_count"'))).toBe(true);
  });

  it('flags an unexpected extra field by name', () => {
    const row = validRow({ extra_field: 'nope' });
    const errors = validateRow(row).errors;
    expect(errors.some((e) => e.includes('"extra_field"'))).toBe(true);
  });

  it('CANONICAL_FIELDS has exactly 27 entries', () => {
    expect(CANONICAL_FIELDS.length).toBe(27);
  });
});

describe('validateRow — controlled vocab', () => {
  it('rejects a bad platform, accepts all 4 legal values including not-recorded', () => {
    expect(validateRow(validRow({ platform: 'freebsd' })).errors.length).toBeGreaterThan(0);
    for (const p of PLATFORM_VALUES) {
      // run_id must be kept consistent with platform — the run_id/platform tie
      // check (tested separately below) would otherwise flag the mismatch.
      const runId = `2026-07-16-parallel-nowinandroid-${p}-smoke-warm-01`;
      expect(validateRow(validRow({ platform: p, run_id: runId })).errors).toEqual([]);
    }
  });

  it('rejects a bad approach', () => {
    expect(validateRow(validRow({ approach: 'D' })).errors.length).toBeGreaterThan(0);
  });

  it('rejects a bad measurement_kind', () => {
    expect(validateRow(validRow({ measurement_kind: 'bogus' })).errors.length).toBeGreaterThan(0);
  });

  it('rejects a bad cache_state', () => {
    expect(validateRow(validRow({ cache_state: 'lukewarm' })).errors.length).toBeGreaterThan(0);
  });

  it('rejects a bad privacy_status', () => {
    expect(validateRow(validRow({ privacy_status: 'semi-public', project_visibility: 'semi-public' })).errors.length).toBeGreaterThan(0);
  });

  it('rejects a bad feature and names the real VALID_FEATURES list', () => {
    const errors = validateRow(validRow({ feature: 'lint' })).errors;
    const hit = errors.find((e) => e.includes('"feature"'));
    expect(hit).toBeDefined();
    expect(hit).toContain('parallel');
  });
});

describe('validateRow — privacy invariants', () => {
  it('rejects a private row with a leaked project_url', () => {
    const errors = validateRow(validPrivateRow({ project_url: 'https://example.com/private' })).errors;
    expect(errors.some((e) => e.includes('"project_url"'))).toBe(true);
  });

  it('rejects a private row with a leaked project_commit', () => {
    const errors = validateRow(validPrivateRow({ project_commit: 'abc123' })).errors;
    expect(errors.some((e) => e.includes('"project_commit"'))).toBe(true);
  });

  it('rejects a private project_alias that does not start with "private-"', () => {
    const errors = validateRow(validPrivateRow({ project_alias: 'my-real-project-name' })).errors;
    expect(errors.some((e) => e.includes('"project_alias"'))).toBe(true);
  });

  it('accepts any private-* alias shape, not just private-<size>-<letter>', () => {
    expect(validateRow(validPrivateRow({ project_alias: 'private-reference-1' })).errors).toEqual([]);
  });

  it('rejects public visibility paired with redacted-private status', () => {
    const errors = validateRow(validRow({ project_visibility: 'public', privacy_status: 'redacted-private' })).errors;
    expect(errors.some((e) => e.includes('"privacy_status"'))).toBe(true);
  });

  it('rejects private visibility paired with public status', () => {
    const errors = validateRow(validPrivateRow({ privacy_status: 'public' })).errors;
    expect(errors.some((e) => e.includes('"privacy_status"'))).toBe(true);
  });

  it('rejects null on a field other than project_url/project_commit', () => {
    const errors = validateRow(validRow({ os_version: null })).errors;
    expect(errors.some((e) => e.includes('"os_version"'))).toBe(true);
  });

  it('rejects null project_url on a PUBLIC row (null is a private-only sentinel)', () => {
    const errors = validateRow(validRow({ project_url: null })).errors;
    expect(errors.some((e) => e.includes('"project_url"'))).toBe(true);
  });

  it('accepts bytes:null on any row — nullability there is not privacy-gated', () => {
    expect(validateRow(validRow({ bytes: null })).errors).toEqual([]);
    expect(validateRow(validPrivateRow({ bytes: null })).errors).toEqual([]);
  });
});

describe('validateRow — value shape', () => {
  it('rejects a negative token_count', () => {
    expect(validateRow(validRow({ token_count: -1 })).errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-integer token_count', () => {
    expect(validateRow(validRow({ token_count: 12.5 })).errors.length).toBeGreaterThan(0);
  });

  it('rejects a malformed date', () => {
    expect(validateRow(validRow({ date: '07/16/2026' })).errors.length).toBeGreaterThan(0);
  });

  it('rejects schema !== 1', () => {
    expect(validateRow(validRow({ schema: 2 })).errors.length).toBeGreaterThan(0);
  });

  it('accepts chunking "none" and a valid "chunked:N@~X.XMiB", rejects garbage', () => {
    expect(validateRow(validRow({ chunking: 'none' })).errors).toEqual([]);
    expect(validateRow(validRow({ chunking: 'chunked:23@~3.1MiB' })).errors).toEqual([]);
    expect(validateRow(validRow({ chunking: 'chunked:abc' })).errors.length).toBeGreaterThan(0);
  });

  it('rejects an absolute raw_capture_location, accepts "not-recorded" and repo-relative paths', () => {
    expect(validateRow(validRow({ raw_capture_location: WIN_ABS_FIXTURE })).errors.length).toBeGreaterThan(0);
    expect(validateRow(validRow({ raw_capture_location: 'not-recorded' })).errors).toEqual([]);
    expect(validateRow(validRow({ raw_capture_location: 'tools/runs/parallel/A-run1.txt' })).errors).toEqual([]);
  });

  it('rejects a release_context missing patch or with no version shape', () => {
    expect(validateRow(validRow({ release_context: 'v0.10' })).errors.length).toBeGreaterThan(0);
    expect(validateRow(validRow({ release_context: 'develop' })).errors.length).toBeGreaterThan(0);
  });

  it('warns (not errors) on an unrecognized tokenizer', () => {
    const { errors, warnings } = validateRow(validRow({ tokenizer: 'gpt-5-tokenizer' }));
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('tokenizer'))).toBe(true);
  });
});

describe('validateRow — run_id cross-field ties', () => {
  it('rejects a run_id that does not start with the row date', () => {
    const errors = validateRow(validRow({ run_id: '2026-01-01-parallel-x-not-recorded-smoke-warm-01' })).errors;
    expect(errors.some((e) => e.includes('run_id'))).toBe(true);
  });

  it('rejects a run_id missing the row platform', () => {
    const errors = validateRow(validRow({ run_id: '2026-07-16-parallel-x-smoke-warm-01' })).errors;
    expect(errors.some((e) => e.includes('platform'))).toBe(true);
  });

  it('rejects a malformed run_id shape entirely', () => {
    expect(validateRow(validRow({ run_id: 'not-a-run-id' })).errors.length).toBeGreaterThan(0);
    expect(validateRow(validRow({ run_id: '2026-07-16-PARALLEL-x-not-recorded-smoke-warm-01' })).errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// validateRows — cross-row checks
// ---------------------------------------------------------------------------
describe('validateRows', () => {
  it('flags two rows sharing a run_id that disagree on an invariant field', () => {
    const a = validRow({ approach: 'A', token_count: 200000 });
    const c = validRow({ approach: 'C', token_count: 2000, feature: 'coverage' });
    const { ok, violations } = validateRows([
      { lineNo: 1, raw: '', row: a, parseError: null },
      { lineNo: 2, raw: '', row: c, parseError: null },
    ]);
    expect(ok).toBe(false);
    expect(violations.some((v) => v.message.includes('feature'))).toBe(true);
  });

  it('flags a duplicate (run_id, approach, tokenizer)', () => {
    const row = validRow();
    const { ok, violations } = validateRows([
      { lineNo: 1, raw: '', row, parseError: null },
      { lineNo: 2, raw: '', row: { ...row }, parseError: null },
    ]);
    expect(ok).toBe(false);
    expect(violations.some((v) => v.message.includes('duplicate'))).toBe(true);
  });

  it('positive control: same run_id, differing approach/tokenizer/token_count passes', () => {
    const a = validRow({ approach: 'A', token_count: 234046 });
    const b = validRow({ approach: 'B', token_count: 1383 });
    const c = validRow({ approach: 'C', token_count: 2013 });
    const { ok, violations } = validateRows([
      { lineNo: 1, raw: '', row: a, parseError: null },
      { lineNo: 2, raw: '', row: b, parseError: null },
      { lineNo: 3, raw: '', row: c, parseError: null },
    ]);
    expect(violations).toEqual([]);
    expect(ok).toBe(true);
  });

  it('reports malformed JSON as a line violation', () => {
    const { ok, violations } = validateRows([
      { lineNo: 1, raw: '{bad', row: null, parseError: 'Unexpected token b' },
    ]);
    expect(ok).toBe(false);
    expect(violations[0].message).toContain('invalid JSON');
  });

  it('treats an empty entry list as valid', () => {
    expect(validateRows([])).toEqual({ ok: true, violations: [], warnings: [] });
  });

  it('warns when A:C ratio is below 1 (likely transcription slip)', () => {
    const a = validRow({ approach: 'A', token_count: 100 });
    const c = validRow({ approach: 'C', token_count: 500 });
    const { warnings } = validateRows([
      { lineNo: 1, raw: '', row: a, parseError: null },
      { lineNo: 2, raw: '', row: c, parseError: null },
    ]);
    expect(warnings.some((w) => w.message.includes('A:C sanity'))).toBe(true);
  });

  it('does not warn when A:C ratio is at or above 1', () => {
    const a = validRow({ approach: 'A', token_count: 234046 });
    const c = validRow({ approach: 'C', token_count: 2013 });
    const { warnings } = validateRows([
      { lineNo: 1, raw: '', row: a, parseError: null },
      { lineNo: 2, raw: '', row: c, parseError: null },
    ]);
    expect(warnings.some((w) => w.message.includes('A:C sanity'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseJsonlFile
// ---------------------------------------------------------------------------
describe('parseJsonlFile', () => {
  it('treats a missing file identically to an empty one', () => {
    const dir = makeTmpDir();
    expect(parseJsonlFile(path.join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('skips blank lines without counting them as entries', () => {
    const dir = makeTmpDir();
    const f = tmpJsonlFile(dir, 'r.jsonl', [validRow(), '', validRow({ approach: 'B' })]);
    const entries = parseJsonlFile(f);
    expect(entries.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
describe('CSV export', () => {
  it('header is exactly the 27 canonical fields in order', () => {
    const header = toCsv([]).split('\n')[0];
    expect(header.split(',')).toEqual(CANONICAL_FIELDS);
  });

  it('quotes a field containing a comma', () => {
    const rec = rowToCsvRecord(validRow({ notes: 'a, b' }));
    expect(rec[CANONICAL_FIELDS.indexOf('notes')]).toBe('"a, b"');
  });

  it('escapes an embedded double quote by doubling it', () => {
    const rec = rowToCsvRecord(validRow({ notes: 'say "hi"' }));
    expect(rec[CANONICAL_FIELDS.indexOf('notes')]).toBe('"say ""hi"""');
  });

  it('renders null as an empty field, not the string "null"', () => {
    const rec = rowToCsvRecord(validRow({ bytes: null }));
    expect(rec[CANONICAL_FIELDS.indexOf('bytes')]).toBe('');
  });

  it('produces N+1 lines for N rows', () => {
    const csv = toCsv([validRow(), validRow({ approach: 'B' }), validRow({ approach: 'A' })]);
    expect(csv.trim().split('\n').length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// cmd* — validate / export-csv / summarize
// ---------------------------------------------------------------------------
describe('cmdValidate', () => {
  it('passes on a valid registry, prints an OK summary', () => {
    const dir = makeTmpDir();
    const f = tmpJsonlFile(dir, 'r.jsonl', [validRow(), validPrivateRow()]);
    const { sink, log } = makeSink();
    const result = cmdValidate({ file: f, sink });
    expect(result.code).toBe(0);
    expect(log[0]).toContain('OK');
  });

  it('fails with file:line:reason detail lines on a violation', () => {
    const dir = makeTmpDir();
    const f = tmpJsonlFile(dir, 'r.jsonl', [validRow({ approach: 'Z' })]);
    const { sink, error } = makeSink();
    const result = cmdValidate({ file: f, sink });
    expect(result.code).toBe(1);
    expect(error.some((e) => e.includes(':1:'))).toBe(true);
  });

  it('treats a not-yet-created registry file as valid (0 rows)', () => {
    const dir = makeTmpDir();
    const { sink, log } = makeSink();
    const result = cmdValidate({ file: path.join(dir, 'missing.jsonl'), sink });
    expect(result.code).toBe(0);
    expect(log[0]).toContain('0 rows');
  });
});

describe('cmdExportCsv', () => {
  it('validates first, writes the CSV on success', () => {
    const dir = makeTmpDir();
    const f = tmpJsonlFile(dir, 'r.jsonl', [validRow()]);
    const out = path.join(dir, 'out.csv');
    const { sink } = makeSink();
    const result = cmdExportCsv({ file: f, out, sink });
    expect(result.code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, 'utf8').trim().split('\n').length).toBe(2);
  });

  it('refuses to write when the source registry has a violation', () => {
    const dir = makeTmpDir();
    const f = tmpJsonlFile(dir, 'r.jsonl', [validRow({ approach: 'Z' })]);
    const out = path.join(dir, 'out.csv');
    const { sink } = makeSink();
    const result = cmdExportCsv({ file: f, out, sink });
    expect(result.code).toBe(1);
    expect(existsSync(out)).toBe(false);
  });
});

describe('buildSummary / buildFeatureTable', () => {
  it('counts rows by feature, kind, and visibility', () => {
    const rows = [validRow(), validRow({ approach: 'A' }), validPrivateRow()];
    const summary = buildSummary(rows);
    expect(summary.totalRows).toBe(3);
    expect(summary.byFeature.parallel).toBe(2);
    expect(summary.byFeature.coverage).toBe(1);
    expect(summary.byVisibility.public).toBe(2);
    expect(summary.byVisibility.private).toBe(1);
  });

  it('returns zero counts for an empty row set without throwing', () => {
    expect(() => buildSummary([])).not.toThrow();
    expect(buildSummary([]).totalRows).toBe(0);
  });

  it('pivots A/B/C onto one row per (run_id, tokenizer) with a computed ratio', () => {
    const rows = [
      validRow({ approach: 'A', token_count: 234046 }),
      validRow({ approach: 'B', token_count: 1383 }),
      validRow({ approach: 'C', token_count: 2013 }),
    ];
    const table = buildFeatureTable(rows, 'parallel');
    expect(table.length).toBe(1);
    expect(table[0].A).toBe(234046);
    expect(table[0].C).toBe(2013);
    expect(table[0].ratio).toBeCloseTo(234046 / 2013, 2);
  });
});

describe('cmdSummarize', () => {
  it('tolerates one malformed line, still summarizes the rest', () => {
    const dir = makeTmpDir();
    const f = tmpJsonlFile(dir, 'r.jsonl', [validRow(), '{not json']);
    const { sink, log, error } = makeSink();
    const result = cmdSummarize({ file: f, sink });
    expect(result.code).toBe(0);
    expect(error.some((e) => e.includes('skipping'))).toBe(true);
    expect(log.some((l) => l.includes('1 rows'))).toBe(true);
  });

  it('rejects an unknown --feature value with a usage exit code', () => {
    const dir = makeTmpDir();
    const f = tmpJsonlFile(dir, 'r.jsonl', [validRow()]);
    const { sink } = makeSink();
    const result = cmdSummarize({ file: f, feature: 'bogus', sink });
    expect(result.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// nextRunSeq / appendRows
// ---------------------------------------------------------------------------
describe('nextRunSeq / appendRows', () => {
  it('returns 01 for a fresh prefix, increments past existing rows', () => {
    const prefix = '2026-07-16-parallel-nowinandroid-windows-smoke-warm';
    expect(nextRunSeq([], prefix)).toBe('01');
    const rows = [validRow({ run_id: `${prefix}-01` }), validRow({ run_id: `${prefix}-02` })];
    expect(nextRunSeq(rows, prefix)).toBe('03');
  });

  it('appends newline-delimited JSON, one object per line', () => {
    const dir = makeTmpDir();
    const f = path.join(dir, 'append.jsonl');
    writeFileSync(f, '', 'utf8');
    appendRows([validRow(), validRow({ approach: 'A' })], f);
    const lines = readFileSync(f, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).approach).toBe('C');
    expect(JSON.parse(lines[1]).approach).toBe('A');
  });
});

// ---------------------------------------------------------------------------
// CLI entry point — a few subprocess-level smoke tests for the process.exit
// wiring; the bulk of behavior is covered above via direct cmd* calls.
// ---------------------------------------------------------------------------
describe('CLI entry point', () => {
  it('exits 2 with usage text on an unknown subcommand', () => {
    const r = spawnSync(process.execPath, [CLI_PATH, 'bogus-subcommand'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage:');
  });

  it('exits 0 validating an empty (not-yet-created) default-adjacent file via --file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mr-cli-'));
    tmpDirs.push(dir);
    const f = path.join(dir, 'empty.jsonl');
    writeFileSync(f, '', 'utf8');
    const r = spawnSync(process.execPath, [CLI_PATH, 'validate', '--file', f], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK');
  });
});

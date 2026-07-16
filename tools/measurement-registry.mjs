#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/measurement-registry.mjs — append-only token-cost measurement registry.
//
// tools/runs/measurement-registry.jsonl is the single source of truth: one
// JSON object per line, one line per (approach, tokenizer) observation. This
// tool only reads/validates/derives from it — it never runs gradle or calls
// the Anthropic API itself (that's tools/measure-token-cost.js's job; this
// tool is downstream of it).
//
// Usage:
//   node tools/measurement-registry.mjs validate    [--file <path>]
//   node tools/measurement-registry.mjs export-csv  [--file <path>] [--out <path>]
//   node tools/measurement-registry.mjs summarize   [--file <path>] [--feature <name>]
//
// Exports: schema constants + parseJsonlFile, validateRow, validateRows,
// rowToCsvRecord, toCsv, buildSummary, buildFeatureTable, nextRunSeq,
// appendRows, cmdValidate, cmdExportCsv, cmdSummarize (for unit tests).

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALID_FEATURES } from './measure-token-cost.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILE = path.join(REPO_ROOT, 'tools', 'runs', 'measurement-registry.jsonl');
const DEFAULT_CSV = path.join(REPO_ROOT, 'tools', 'runs', 'measurement-registry.csv');

// ---------------------------------------------------------------------------
// Schema constants
// ---------------------------------------------------------------------------

export const CURRENT_SCHEMA = 1;

export const CANONICAL_FIELDS = [
  'schema', 'run_id', 'date', 'release_context', 'platform', 'os_version',
  'node_version', 'java_version', 'project_alias', 'project_visibility',
  'project_url', 'project_commit', 'feature', 'scope', 'command_shape',
  'measurement_kind', 'cache_state', 'approach', 'tokenizer', 'token_count',
  'bytes', 'chunking', 'raw_capture_committed', 'raw_capture_location',
  'privacy_status', 'source_artifact', 'notes',
];

// platform intentionally extends the user-specified windows|macos|linux with
// "not-recorded": historical evidence sources rarely document the measuring
// machine, and guessing (e.g. defaulting to "windows" because this repo's
// tooling is Windows-primary) would misrepresent an unverified fact as
// verified. Only a row from a session that actually ran on that platform may
// claim it.
export const PLATFORM_VALUES = ['windows', 'macos', 'linux', 'not-recorded'];
export const PROJECT_VISIBILITY_VALUES = ['public', 'private'];
export const MEASUREMENT_KIND_VALUES = ['full-matrix', 'smoke', 'trace-validation', 'private-reference'];
export const CACHE_STATE_VALUES = ['cold', 'warm', 'mixed', 'unknown'];
export const APPROACH_VALUES = ['A', 'B', 'C'];
export const PRIVACY_STATUS_VALUES = ['public', 'redacted-private'];

// Soft allowlist only — warns, never fails, so a new Claude model doesn't
// require editing this file before its counts can be recorded.
export const KNOWN_TOKENIZERS = [
  'cl100k_base', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5',
];

// Loose shape check only: <date>-<free-form lowercase/digits/hyphens>-<seq>.
// The feature/alias/platform/measurement_kind/cache_state segments are all
// lowercase-alnum-with-hyphens themselves (e.g. "private-reference",
// "not-recorded"), so a single regex can't unambiguously carve out exact
// segment boundaries. Real semantic tying happens in validateRow below via
// substring checks against the row's own field values, not by parsing this
// string apart.
export const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z][a-z0-9-]*-\d{2}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const CHUNKING_RE = /^none$|^chunked:\d+@~[\d.]+(KiB|MiB|GiB)$/;
export const RELEASE_CONTEXT_RE = /^v\d+\.\d+\.\d+$|^unreleased \(post-v\d+\.\d+\.\d+\)$/;
// Guards raw_capture_location against an absolute local path leaking into a
// committed row — defense-in-depth ahead of tools/decouple-audit.mjs. Matches
// ANY absolute path shape (drive-letter, UNC, or POSIX-rooted), not just
// user-home paths — the field's contract is "repo-relative, not absolute",
// so /tmp/..., /var/folders/... (the exact shape behind a real historical
// entrypoint-guard bug in this repo — see BACKLOG.md), /opt/..., etc. must
// all be rejected too, not just /home/... and /Users/....
export const ABS_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

// Fields that must be identical across every row sharing a run_id — only
// approach/tokenizer/token_count/bytes/chunking/command_shape/notes may vary
// (see validateRows below).
const RUN_ID_GROUP_INVARIANT_FIELDS = [
  'date', 'release_context', 'platform', 'os_version', 'node_version',
  'java_version', 'project_alias', 'project_visibility', 'project_url',
  'project_commit', 'feature', 'scope', 'measurement_kind', 'cache_state',
  'privacy_status', 'source_artifact',
];

// ---------------------------------------------------------------------------
// parseJsonlFile — a missing file parses identically to an empty one (a
// freshly-scaffolded, not-yet-backfilled registry is valid, not an error).
// ---------------------------------------------------------------------------
export function parseJsonlFile(filePath) {
  const text = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const entries = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    let row = null;
    let parseError = null;
    try {
      row = JSON.parse(raw);
    } catch (err) {
      parseError = err.message;
    }
    entries.push({ lineNo: i + 1, raw, row, parseError });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// validateRow — per-row checks. Returns { errors, warnings }; only errors
// affect a caller's exit code.
// ---------------------------------------------------------------------------
export function validateRow(row) {
  const errors = [];
  const warnings = [];

  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    errors.push('row must be a plain JSON object');
    return { errors, warnings };
  }

  const rowKeys = new Set(Object.keys(row));
  for (const f of CANONICAL_FIELDS) {
    if (!rowKeys.has(f)) errors.push(`missing required field "${f}"`);
  }
  for (const k of rowKeys) {
    if (!CANONICAL_FIELDS.includes(k)) errors.push(`unexpected field "${k}" (not in the canonical schema)`);
  }

  if (row.schema !== CURRENT_SCHEMA) {
    errors.push(`"schema" must be ${CURRENT_SCHEMA} (got ${JSON.stringify(row.schema)})`);
  }

  if (typeof row.run_id !== 'string' || !RUN_ID_RE.test(row.run_id)) {
    errors.push(`"run_id" has an invalid shape (got ${JSON.stringify(row.run_id)})`);
  } else {
    if (typeof row.date === 'string' && !row.run_id.startsWith(`${row.date}-`)) {
      errors.push(`"run_id" does not start with "date" (${row.date})`);
    }
    if (typeof row.platform === 'string' && !row.run_id.includes(`-${row.platform}-`)) {
      errors.push(`"run_id" does not contain "platform" (${row.platform})`);
    }
    if (typeof row.measurement_kind === 'string' && !row.run_id.includes(`-${row.measurement_kind}-`)) {
      errors.push(`"run_id" does not contain "measurement_kind" (${row.measurement_kind})`);
    }
    if (typeof row.cache_state === 'string' && !row.run_id.includes(`-${row.cache_state}-`)) {
      errors.push(`"run_id" does not contain "cache_state" (${row.cache_state})`);
    }
  }

  if (typeof row.date !== 'string' || !DATE_RE.test(row.date)) {
    errors.push(`"date" must be YYYY-MM-DD (got ${JSON.stringify(row.date)})`);
  }

  if (typeof row.release_context !== 'string' || !RELEASE_CONTEXT_RE.test(row.release_context)) {
    errors.push(`"release_context" must be "vX.Y.Z" or "unreleased (post-vX.Y.Z)" (got ${JSON.stringify(row.release_context)})`);
  }

  if (typeof row.platform !== 'string' || !PLATFORM_VALUES.includes(row.platform)) {
    errors.push(`"platform" must be one of ${PLATFORM_VALUES.join('|')} (got ${JSON.stringify(row.platform)})`);
  }

  for (const f of ['os_version', 'node_version', 'java_version']) {
    if (typeof row[f] !== 'string' || row[f].length === 0) {
      errors.push(`"${f}" must be a non-empty string`);
    }
  }

  if (typeof row.project_alias !== 'string' || row.project_alias.length === 0) {
    errors.push('"project_alias" must be a non-empty string');
  } else if (row.project_visibility === 'private' && !row.project_alias.startsWith('private-')) {
    // Deliberately loose — just the prefix, not a rigid private-<size>-<letter>
    // suffix shape, so future private-project aliases aren't blocked by an
    // overly specific historical naming convention.
    errors.push(`"project_alias" must start with "private-" when project_visibility is "private" (got ${JSON.stringify(row.project_alias)})`);
  }

  if (typeof row.project_visibility !== 'string' || !PROJECT_VISIBILITY_VALUES.includes(row.project_visibility)) {
    errors.push(`"project_visibility" must be one of ${PROJECT_VISIBILITY_VALUES.join('|')} (got ${JSON.stringify(row.project_visibility)})`);
  }

  // Privacy invariant: null is legal ONLY on project_url/project_commit, ONLY
  // when project_visibility is "private". Everywhere else "not-recorded" (a
  // real string) is the unknown-value sentinel, never null.
  for (const f of ['project_url', 'project_commit']) {
    if (row.project_visibility === 'private') {
      if (row[f] !== null) {
        errors.push(`"${f}" must be null when project_visibility is "private" (got ${JSON.stringify(row[f])})`);
      }
    } else if (typeof row[f] !== 'string' || row[f].length === 0) {
      errors.push(`"${f}" must be a non-empty string when project_visibility is not "private" (got ${JSON.stringify(row[f])}) — use "not-recorded", never null`);
    }
  }

  if (typeof row.feature !== 'string' || !VALID_FEATURES.includes(row.feature)) {
    errors.push(`"feature" must be one of ${VALID_FEATURES.join('|')} (got ${JSON.stringify(row.feature)})`);
  }

  if (typeof row.scope !== 'string' || row.scope.length === 0) {
    errors.push('"scope" must be a non-empty string');
  }

  if (typeof row.command_shape !== 'string' || row.command_shape.length === 0) {
    errors.push('"command_shape" must be a non-empty string');
  }

  if (typeof row.measurement_kind !== 'string' || !MEASUREMENT_KIND_VALUES.includes(row.measurement_kind)) {
    errors.push(`"measurement_kind" must be one of ${MEASUREMENT_KIND_VALUES.join('|')} (got ${JSON.stringify(row.measurement_kind)})`);
  }

  if (typeof row.cache_state !== 'string' || !CACHE_STATE_VALUES.includes(row.cache_state)) {
    errors.push(`"cache_state" must be one of ${CACHE_STATE_VALUES.join('|')} (got ${JSON.stringify(row.cache_state)})`);
  }

  if (typeof row.approach !== 'string' || !APPROACH_VALUES.includes(row.approach)) {
    errors.push(`"approach" must be one of ${APPROACH_VALUES.join('|')} (got ${JSON.stringify(row.approach)})`);
  }

  if (typeof row.tokenizer !== 'string' || row.tokenizer.length === 0) {
    errors.push('"tokenizer" must be a non-empty string');
  } else if (!KNOWN_TOKENIZERS.includes(row.tokenizer)) {
    warnings.push(`"tokenizer" value "${row.tokenizer}" is not in the known allowlist (${KNOWN_TOKENIZERS.join(', ')}) — allowed, but double-check for a typo`);
  }

  if (typeof row.token_count !== 'number' || !Number.isInteger(row.token_count) || row.token_count < 0) {
    errors.push(`"token_count" must be a non-negative integer (got ${JSON.stringify(row.token_count)})`);
  }

  if (row.bytes !== null && (typeof row.bytes !== 'number' || !Number.isInteger(row.bytes) || row.bytes < 0)) {
    errors.push(`"bytes" must be a non-negative integer or null (got ${JSON.stringify(row.bytes)})`);
  }

  if (typeof row.chunking !== 'string' || !CHUNKING_RE.test(row.chunking)) {
    errors.push(`"chunking" must be "none" or "chunked:<n>@~<size><KiB|MiB|GiB>" (got ${JSON.stringify(row.chunking)})`);
  }

  if (typeof row.raw_capture_committed !== 'boolean') {
    errors.push(`"raw_capture_committed" must be a boolean (got ${JSON.stringify(row.raw_capture_committed)})`);
  }

  if (typeof row.raw_capture_location !== 'string' || row.raw_capture_location.length === 0) {
    errors.push('"raw_capture_location" must be a non-empty string');
  } else if (row.raw_capture_location !== 'not-recorded' && ABS_PATH_RE.test(row.raw_capture_location)) {
    errors.push(`"raw_capture_location" must be repo-relative, not absolute (got ${JSON.stringify(row.raw_capture_location)})`);
  }

  if (typeof row.privacy_status !== 'string' || !PRIVACY_STATUS_VALUES.includes(row.privacy_status)) {
    errors.push(`"privacy_status" must be one of ${PRIVACY_STATUS_VALUES.join('|')} (got ${JSON.stringify(row.privacy_status)})`);
  } else if (typeof row.project_visibility === 'string' && PROJECT_VISIBILITY_VALUES.includes(row.project_visibility)) {
    const expected = row.project_visibility === 'private' ? 'redacted-private' : 'public';
    if (row.privacy_status !== expected) {
      errors.push(`"privacy_status" (${row.privacy_status}) must be "${expected}" to match project_visibility (${row.project_visibility})`);
    }
  }

  if (typeof row.source_artifact !== 'string' || row.source_artifact.length === 0) {
    errors.push('"source_artifact" must be a non-empty string');
  }

  if (typeof row.notes !== 'string') {
    errors.push(`"notes" must be a string (got ${JSON.stringify(row.notes)})`);
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// validateRows — cross-row checks on top of the per-row pass: run_id
// grouping consistency, duplicate-observation guard, and a non-blocking A:C
// arithmetic sanity check (catches a hand-transcription swap/typo — Approach
// A, the raw baseline, coming out smaller than Approach C, the compact JSON,
// is backwards from every real measurement this tool has ever produced).
// ---------------------------------------------------------------------------
export function validateRows(entries) {
  const violations = [];
  const warnings = [];
  const byRunId = new Map();

  for (const entry of entries) {
    if (entry.parseError) {
      violations.push({ lineNo: entry.lineNo, message: `invalid JSON (${entry.parseError})` });
      continue;
    }
    const { errors, warnings: rowWarnings } = validateRow(entry.row);
    for (const e of errors) violations.push({ lineNo: entry.lineNo, message: e });
    for (const w of rowWarnings) warnings.push({ lineNo: entry.lineNo, message: w });

    const runId = entry.row && entry.row.run_id;
    if (typeof runId === 'string') {
      if (!byRunId.has(runId)) byRunId.set(runId, []);
      byRunId.get(runId).push(entry);
    }
  }

  for (const [runId, group] of byRunId) {
    if (group.length > 1) {
      const first = group[0];
      for (const entry of group.slice(1)) {
        for (const f of RUN_ID_GROUP_INVARIANT_FIELDS) {
          if (JSON.stringify(entry.row[f]) !== JSON.stringify(first.row[f])) {
            violations.push({
              lineNo: entry.lineNo,
              message: `run_id "${runId}" field "${f}" disagrees with line ${first.lineNo}`,
            });
          }
        }
      }
    }

    const seen = new Map();
    for (const entry of group) {
      const key = `${entry.row.approach}|${entry.row.tokenizer}`;
      if (seen.has(key)) {
        violations.push({
          lineNo: entry.lineNo,
          message: `duplicate (approach, tokenizer) "${key}" within run_id "${runId}" (also line ${seen.get(key)})`,
        });
      } else {
        seen.set(key, entry.lineNo);
      }
    }

    const byTokenizer = new Map();
    for (const entry of group) {
      const t = entry.row.tokenizer;
      if (!byTokenizer.has(t)) byTokenizer.set(t, {});
      byTokenizer.get(t)[entry.row.approach] = entry;
    }
    for (const [tokenizer, approaches] of byTokenizer) {
      const a = approaches.A;
      const c = approaches.C;
      if (
        a && c &&
        typeof a.row.token_count === 'number' &&
        typeof c.row.token_count === 'number' &&
        c.row.token_count > 0
      ) {
        const ratio = a.row.token_count / c.row.token_count;
        if (ratio < 1) {
          warnings.push({
            lineNo: c.lineNo,
            message: `A:C sanity — run_id "${runId}" tokenizer "${tokenizer}": A=${a.row.token_count} C=${c.row.token_count} (ratio ${ratio.toFixed(2)}x < 1; likely a transcription slip)`,
          });
        }
      }
    }
  }

  return { ok: violations.length === 0, violations, warnings };
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------
function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowToCsvRecord(row) {
  return CANONICAL_FIELDS.map((f) => csvEscape(row[f]));
}

export function toCsv(rows) {
  const lines = [CANONICAL_FIELDS.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(rowToCsvRecord(row).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Summarize helpers — two fixed views only, deliberately not a generic
// --group-by engine.
// ---------------------------------------------------------------------------
export function buildSummary(rows) {
  const runIds = new Set(rows.map((r) => r.run_id));
  const byFeature = {};
  const byKind = {};
  const byVisibility = {};
  for (const r of rows) {
    byFeature[r.feature] = (byFeature[r.feature] || 0) + 1;
    byKind[r.measurement_kind] = (byKind[r.measurement_kind] || 0) + 1;
    byVisibility[r.project_visibility] = (byVisibility[r.project_visibility] || 0) + 1;
  }
  return { totalRows: rows.length, runIdCount: runIds.size, byFeature, byKind, byVisibility };
}

export function buildFeatureTable(rows, feature) {
  const byKey = new Map();
  for (const r of rows) {
    if (r.feature !== feature) continue;
    const key = `${r.run_id}|${r.tokenizer}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        run_id: r.run_id,
        project_alias: r.project_alias,
        cache_state: r.cache_state,
        tokenizer: r.tokenizer,
      });
    }
    byKey.get(key)[r.approach] = r.token_count;
  }
  return [...byKey.values()].map((entry) => ({
    ...entry,
    ratio: entry.A != null && entry.C != null && entry.C > 0 ? entry.A / entry.C : null,
  }));
}

// ---------------------------------------------------------------------------
// nextRunSeq — scans existing rows for the next free 2-digit suffix under a
// given run_id prefix (everything before the trailing "-NN").
// ---------------------------------------------------------------------------
export function nextRunSeq(rows, prefixWithoutSeq) {
  let max = 0;
  const needle = `${prefixWithoutSeq}-`;
  for (const r of rows) {
    if (typeof r.run_id === 'string' && r.run_id.startsWith(needle)) {
      const n = parseInt(r.run_id.slice(needle.length), 10);
      if (Number.isInteger(n) && n > max) max = n;
    }
  }
  return String(max + 1).padStart(2, '0');
}

export function appendRows(rows, filePath) {
  const text = `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
  appendFileSync(filePath, text, 'utf8');
}

// ---------------------------------------------------------------------------
// CLI commands — return { code, ... } rather than calling process.exit
// themselves, so exit codes and output are directly assertable in tests
// (matches the sink-injection pattern already used by
// tests/vitest/measure-token-cost.test.js's makeSink()).
// ---------------------------------------------------------------------------
export function cmdValidate({ file, sink = console }) {
  const entries = parseJsonlFile(file);
  const { ok, violations, warnings } = validateRows(entries);
  const relFile = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
  const rows = entries.filter((e) => e.row).map((e) => e.row);
  const runIds = new Set(rows.map((r) => r.run_id).filter(Boolean));

  for (const w of warnings) {
    sink.error(`${relFile}:${w.lineNo}: WARNING — ${w.message}`);
  }

  if (!ok) {
    for (const v of violations) {
      sink.error(`${relFile}:${v.lineNo}: ${v.message}`);
    }
    sink.error('');
    sink.error(`[measurement-registry] FAIL — ${violations.length} violation(s) across ${entries.length} line(s).`);
    return { code: 1, violations, warnings };
  }

  const warnSuffix = warnings.length ? `, ${warnings.length} warning(s)` : '';
  sink.log(`[measurement-registry] OK — ${rows.length} rows across ${runIds.size} run_ids, 0 violations${warnSuffix}.`);
  return { code: 0, violations: [], warnings };
}

export function cmdExportCsv({ file, out, sink = console }) {
  const validated = cmdValidate({ file, sink });
  if (validated.code !== 0) {
    sink.error('[measurement-registry] export-csv aborted — fix validation failures first.');
    return { code: validated.code };
  }
  const entries = parseJsonlFile(file);
  const rows = entries.filter((e) => e.row).map((e) => e.row);
  writeFileSync(out, toCsv(rows), 'utf8');
  sink.log(`[measurement-registry] OK — validated ${rows.length} rows, wrote ${path.relative(REPO_ROOT, out).replace(/\\/g, '/')} (${rows.length + 1} line(s) incl. header).`);
  return { code: 0, rows: rows.length };
}

export function cmdSummarize({ file, feature, sink = console }) {
  const entries = parseJsonlFile(file);
  const skipped = entries.filter((e) => e.parseError).length;
  const rows = entries.filter((e) => e.row).map((e) => e.row);
  if (skipped > 0) {
    sink.error(`[measurement-registry] summarize — skipping ${skipped} unparseable line(s); run \`validate\` for details.`);
  }

  if (feature) {
    if (!VALID_FEATURES.includes(feature)) {
      sink.error(`[measurement-registry] FAIL — --feature must be one of ${VALID_FEATURES.join('|')} (got ${feature})`);
      return { code: 2 };
    }
    const table = buildFeatureTable(rows, feature);
    sink.log(`[measurement-registry] summarize --feature ${feature} — ${table.length} (run_id, tokenizer) row(s)`);
    sink.log('run_id | project_alias | cache_state | tokenizer | A | B | C | A:C');
    for (const t of table) {
      const ratioStr = t.ratio != null ? `${t.ratio.toFixed(1)}x` : 'n/a';
      sink.log(`${t.run_id} | ${t.project_alias} | ${t.cache_state} | ${t.tokenizer} | ${t.A ?? '-'} | ${t.B ?? '-'} | ${t.C ?? '-'} | ${ratioStr}`);
    }
    return { code: 0, table };
  }

  const summary = buildSummary(rows);
  const fmtCounts = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('  ') || '(none)';
  sink.log(`[measurement-registry] summary — ${summary.totalRows} rows, ${summary.runIdCount} run_ids`);
  sink.log(`  by feature:     ${fmtCounts(summary.byFeature)}`);
  sink.log(`  by kind:        ${fmtCounts(summary.byKind)}`);
  sink.log(`  by visibility:  ${fmtCounts(summary.byVisibility)}`);
  return { code: 0, summary };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
const USAGE = 'Usage: node tools/measurement-registry.mjs <validate|export-csv|summarize> [--file <path>] [--out <path>] [--feature <name>]';

function parseCommonArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file' && argv[i + 1]) { out.file = argv[++i]; continue; }
    if (argv[i] === '--out' && argv[i + 1]) { out.out = argv[++i]; continue; }
    if (argv[i] === '--feature' && argv[i + 1]) { out.feature = argv[++i]; continue; }
    out.error = `unknown or malformed flag "${argv[i]}"`;
    break;
  }
  return out;
}

function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const args = parseCommonArgs(rest);
  if (args.error) {
    console.error(USAGE);
    console.error(args.error);
    process.exit(2);
  }
  const file = args.file || DEFAULT_FILE;

  let result;
  switch (sub) {
    case 'validate':
      result = cmdValidate({ file, sink: console });
      break;
    case 'export-csv':
      result = cmdExportCsv({ file, out: args.out || DEFAULT_CSV, sink: console });
      break;
    case 'summarize':
      result = cmdSummarize({ file, feature: args.feature, sink: console });
      break;
    default:
      console.error(USAGE);
      process.exit(2);
      return;
  }
  process.exit(result.code);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) main();

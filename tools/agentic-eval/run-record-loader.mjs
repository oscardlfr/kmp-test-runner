#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/run-record-loader.mjs -- the ONE trusted-input gate for reading a run record
// file plus, for a schema-v5 scenario record, its own accepted-run-audit sidecar. Extracted out of
// cli.mjs (where this logic originally lived) into its own module for two independent reasons:
//
// 1. Avoids a circular import: analysis.mjs needs this same validation, and cli.mjs needs
//    analysis.mjs's analyzeRunsDir -- two modules importing each other's exports is fragile even
//    when (as it was before this extraction) both sides only ever call the other's export from
//    inside a function body. A shared, dependency-free-of-either-caller module has no such cycle.
// 2. Eliminates a TOCTOU double-read: previously, validateRunRecordFile validated the sidecar file
//    on disk but discarded the parsed object, so any caller that needed the sidecar's own CONTENT
//    (analysis.mjs) had to independently re-open and re-parse the exact same file a second time.
//    validateRunRecordFile now returns the already-parsed, already-validated `sidecar` object
//    directly -- one read, one parse, one validation pass, one returned pair of objects.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { validateRun } from './schemas.mjs';
import { validateAcceptedRunAuditSidecar, crossValidateAcceptedRunAuditAgainstRecord } from './accepted-run-audit.mjs';
import { realpath } from './materialize.mjs';

/**
 * Offline verification of one schema-v5 scenario record's own accepted-run-audit sidecar
 * (accepted-run-observability PR): resolves `accepted_audit.relative_path` relative to the run
 * record's OWN directory (never string-concatenated -- `relative_path` is already schema-guaranteed
 * safe by validateRun's own regex, but the resolved path is still containment-checked before ever
 * being read), requires the file to exist and parse, verifies its strict schema and record
 * coherence (validateAcceptedRunAuditSidecar + crossValidateAcceptedRunAuditAgainstRecord), and
 * SHA-256s the exact file text against the record's own declared digest. Never follows a symlink
 * whose resolved target escapes the run directory -- both the run directory and the sidecar path
 * are realpath-resolved and containment-checked first. Returns `{errors, sidecar}` -- `sidecar` is
 * the parsed object whenever JSON.parse succeeded (even if it then failed shape/cross validation,
 * mirroring validateRunRecordFile's own "record is non-null once parsed" convention), `null` only
 * when the file couldn't be read/resolved/parsed at all. Never throws.
 *
 * Error messages use `err.code` (e.g. 'ENOENT'), never `err.message` -- a raw Node fs error message
 * embeds the absolute path it operated on (e.g. "ENOENT: no such file or directory, open
 * 'C:\Users\...'"), which would leak the run record's own on-disk location into an otherwise
 * content-free diagnostic. Content-bearing values (the record's declared digest, the sidecar's own
 * relative_path) are never interpolated into these messages either.
 * @returns {{errors: Array<{field:string,message:string}>, sidecar: object|null}}
 */
export function validateAcceptedAuditOnDisk(runPath, record) {
  const errors = [];
  const runDir = dirname(runPath);
  let runDirReal;
  try {
    runDirReal = realpath(runDir);
  } catch (err) {
    errors.push({ field: 'accepted_audit', message: `could not resolve the run record's own directory (${err.code ?? 'unknown error'})` });
    return { errors, sidecar: null };
  }
  // relative_path is already schema-guaranteed (validateRun, schemas.mjs) to be exactly
  // "audit/<run_id>.json" in a closed, traversal/backslash/absolute-path-free charset -- joined via
  // path.join (platform-correct separators), never raw string concatenation.
  const sidecarPath = join(runDir, ...record.accepted_audit.relative_path.split('/'));
  if (!existsSync(sidecarPath)) {
    errors.push({ field: 'accepted_audit', message: 'sidecar file does not exist' });
    return { errors, sidecar: null };
  }
  let sidecarPathReal;
  try {
    sidecarPathReal = realpath(sidecarPath);
  } catch (err) {
    errors.push({ field: 'accepted_audit', message: `could not resolve the sidecar path (${err.code ?? 'unknown error'})` });
    return { errors, sidecar: null };
  }
  const relFromRunDir = relative(runDirReal, sidecarPathReal);
  if (relFromRunDir.startsWith('..') || isAbsolute(relFromRunDir)) {
    errors.push({ field: 'accepted_audit', message: 'sidecar path resolves outside the run record\'s own directory -- refusing to follow (symlink escape?)' });
    return { errors, sidecar: null };
  }
  let sidecarText;
  try {
    sidecarText = readFileSync(sidecarPathReal, 'utf8');
  } catch (err) {
    errors.push({ field: 'accepted_audit', message: `could not read the sidecar file (${err.code ?? 'unknown error'})` });
    return { errors, sidecar: null };
  }
  let sidecarObj;
  try {
    sidecarObj = JSON.parse(sidecarText);
  } catch {
    errors.push({ field: 'accepted_audit', message: 'sidecar file is not valid JSON' });
    return { errors, sidecar: null };
  }
  const { errors: shapeErrors } = validateAcceptedRunAuditSidecar(sidecarObj);
  errors.push(...shapeErrors.map((e) => ({ field: `accepted_audit.sidecar.${e.field}`, message: e.message })));
  // Cross-validation is skipped once the sidecar's own shape is already invalid (review finding
  // 5) -- a null/scalar/array sidecar root (valid JSON, but not a real sidecar object) is caught
  // above by shapeErrors alone; comparing it field-by-field against the record adds nothing but
  // noisy "undefined does not match ..." entries, and crossValidateAcceptedRunAuditAgainstRecord's
  // own defensive guard (never throws even if called directly) is a second, independent layer,
  // not a substitute for this one.
  if (shapeErrors.length === 0) {
    const crossErrors = crossValidateAcceptedRunAuditAgainstRecord(sidecarObj, record);
    errors.push(...crossErrors.map((e) => ({ field: `accepted_audit.cross.${e.field}`, message: e.message })));
  }
  const actualSha256 = createHash('sha256').update(sidecarText, 'utf8').digest('hex');
  if (actualSha256 !== record.accepted_audit.sha256) {
    errors.push({ field: 'accepted_audit.sha256', message: 'sidecar file\'s actual SHA-256 does not match the record\'s declared accepted_audit.sha256' });
  }
  return { errors, sidecar: sidecarObj };
}

/**
 * Validates one run record file at `runPath` -- schemas 1-4 (and a schema-5 non-scenario record)
 * get exactly the pre-existing record-only behavior; a schema-5 scenario record ADDITIONALLY gets
 * its own accepted-run-audit sidecar verified offline (see validateAcceptedAuditOnDisk), only once
 * the record itself already validates cleanly (a structurally invalid record has no reliable
 * accepted_audit.relative_path/sha256 to resolve in the first place). Extracted as its own,
 * directly-testable function so cmdValidate/cmdAggregate stay thin CLI wrappers (print + exit
 * code) and analysis.mjs's analyzeRunsDir reuses the identical gate.
 *
 * Fails CLOSED, never throws. `record` is `null` only on a read/parse failure; a record that
 * parses but fails schema validation still returns the real parsed object, unchanged from before.
 * `sidecar` is `null` unless a schema-5 scenario record's own sidecar was successfully read and
 * parsed (even if it then failed shape/cross validation) -- callers must still check `errors` before
 * trusting `sidecar`'s content. The read/parse failure message never includes the file's own path
 * or content -- `err.code` (e.g. 'ENOENT') for a read failure, a fixed generic string for a parse
 * failure (JSON.parse's own error message embeds a snippet of the malformed text itself, so it is
 * never interpolated here).
 * @returns {{record: object|null, sidecar: object|null, errors: Array<{field:string,message:string}>, warnings: Array}}
 */
export function validateRunRecordFile(runPath) {
  let text;
  try {
    text = readFileSync(runPath, 'utf8');
  } catch (err) {
    return { record: null, sidecar: null, errors: [{ field: '(root)', message: `the run file could not be read (${err.code ?? 'unknown error'})` }], warnings: [] };
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { record: null, sidecar: null, errors: [{ field: '(root)', message: 'the run file is not valid JSON' }], warnings: [] };
  }
  const { errors, warnings } = validateRun(record);
  let sidecar = null;
  if (errors.length === 0 && record.schema >= 5 && record.run_kind === 'scenario') {
    const auditResult = validateAcceptedAuditOnDisk(runPath, record);
    errors.push(...auditResult.errors);
    sidecar = auditResult.sidecar;
  }
  return { record, sidecar, errors, warnings };
}

#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// tools/macos-validation-gate.mjs — manual macOS validation gate for v0.9.
//
// Drives the matrix described in `BACKLOG.md` §"v0.9 — macOS validation gate":
//
//   { kmp-test parallel, kmp-test changed }  ×  { 7 --test-type values }  ×  { 3 projects } = 42 cells
//   { kmp-test android }                                                  ×  { 3 projects } =  3 cells
//   ──────────────────────────────────────────────────────────────────────────────────────── + 45 cells
//
// Mirrors `tools/wide-smoke-pass-9-mac.mjs` shape (argv parser, project loop,
// per-cell artifacts under .smoke/<run>/<safe>.{out,err,json,meta.json},
// markdown summary, --reclassify mode that re-reads saved artifacts).
//
// Modes (--mode <dry|probe|scoped|full>):
//   dry    — enumerate cells, print plan, write summary, NO spawn. Default.
//            Used by Phase B's matrix-shape sanity check + the vitest spec.
//   probe  — spawn kmp-test per cell with --dry-run (parallel/changed) or
//            --list-only (android). Captures REAL envelopes with NO gradle
//            invocation, exactly mirroring the parity.test.js snapshot
//            cases. Disk-safe (no daemons), so it runs unconditionally.
//            Used by Phase B's envelope-shape drift check.
//   scoped — spawn kmp-test per cell with --module-filter <scopedModule>
//            so gradle only touches one module per cell. Daemons stopped
//            between cells. Disk monitored against --abort-floor-mb.
//            Bucketing is OPERATIONAL (exit_code + errors[]) NOT
//            structural — wet envelopes carry plan/legs/device fields
//            the dry snapshot baseline lacks, so a shape diff would
//            mark every cell DRIFT by design. Used by Phase C with
//            current 8.6 GiB disk.
//   full   — spawn kmp-test per cell with no module filter. Hard-errors
//            unless --i-have-20gb-free is also passed (memory rule:
//            feedback_disk_space_awareness.md).
//
// Output: MACOS-GATE-V0.9-SUMMARY.md at repo root (gitignored during
// iteration; committed separately at v0.9 step 7 close-out per Phase E).
//
// Memory rules baked in:
//   - feedback_disk_space_awareness.md  : TMPDIR override, daemon stop,
//                                          abort-floor, full-mode gating
//   - feedback_json_ignore_jdk_hides_errors.md : never emit
//                                          --ignore-jdk-mismatch
//   - feedback_ci_minutes_minimal_macos.md : manual-only, no CI wiring

import { spawnSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');
const KMP_TEST   = path.join(REPO_ROOT, 'bin', 'kmp-test.js');
const SNAPSHOT_FILE = path.join(
  REPO_ROOT, 'tests', 'vitest', '__snapshots__', 'parity.test.js.snap',
);

const ENVELOPE_BEGIN = '__KMP_TEST_ENVELOPE_V1_BEGIN__';
const ENVELOPE_END   = '__KMP_TEST_ENVELOPE_V1_END__';

const WORKSPACE       = process.env.KMP_WORKSPACE || path.resolve(REPO_ROOT, '..');
const TMPDIR_OVERRIDE = process.env.KMP_TMPDIR    || path.join(WORKSPACE, '.tmp');
console.error(`[NOTICE] WORKSPACE = ${WORKSPACE}`);

// ─── matrix dimensions ─────────────────────────────────────────────────────

// 3 KMP gradle roots used by the gate. `scopedModule` is the smallest
// representative module per project (used by --mode scoped to keep gradle
// daemon + cache footprint small enough for the secondary Mac's tight
// disk situation).
export const PROJECTS = [
  {
    name: 'fixture',
    path: path.join(REPO_ROOT, 'tests', 'fixtures', 'kmp-cross-platform-e2e'),
    scopedModule: ':sample',
    hasAndroidInstrumented: false, // androidLibrary { withHostTestBuilder } only
  },
  {
    name: 'private-lib',
    path: path.join(WORKSPACE, 'private-lib'),
    scopedModule: ':sample-result',
    hasAndroidInstrumented: true,
  },
  {
    name: 'KaMPKit',
    path: path.join(WORKSPACE, 'KaMPKit'),
    scopedModule: ':shared',
    hasAndroidInstrumented: true,
  },
];

// Real CLI surface as of v0.8.1 (lib/cli.js:141, 240). NOT the prompt's
// {jvm,android,…} aliases — we use the canonical CLI values so cells
// dispatch directly without alias translation.
export const TEST_TYPES = [
  'all', 'common', 'androidUnit', 'androidInstrumented',
  'desktop', 'ios', 'macos',
];

export const SUBCOMMANDS = ['parallel', 'changed', 'android'];

const VALID_MODES = new Set(['dry', 'probe', 'scoped', 'full']);

// ─── argv parser ───────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = {
    mode: 'dry',
    subcommand: 'all',
    testType: 'all-of',
    project: 'all',
    timeout: 900,
    output: 'MACOS-GATE-V0.9-SUMMARY.md',
    label: 'v0.9',
    reclassify: false,
    iHaveTwentyGb: false,
    abortFloorMb: 2048,
    stopDaemons: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode')              { out.mode = argv[++i]; continue; }
    if (a === '--subcommand')        { out.subcommand = argv[++i]; continue; }
    if (a === '--test-type')         { out.testType = argv[++i]; continue; }
    if (a === '--project')           { out.project = argv[++i]; continue; }
    if (a === '--timeout')           { out.timeout = parseInt(argv[++i], 10); continue; }
    if (a === '--output')            { out.output = argv[++i]; continue; }
    if (a === '--label')             { out.label = argv[++i]; continue; }
    if (a === '--reclassify')        { out.reclassify = true; continue; }
    if (a === '--i-have-20gb-free')  { out.iHaveTwentyGb = true; continue; }
    if (a === '--abort-floor-mb')    { out.abortFloorMb = parseInt(argv[++i], 10); continue; }
    if (a === '--no-stop-daemons')   { out.stopDaemons = false; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    throw new Error(`Unknown argument: ${a}`);
  }
  if (!VALID_MODES.has(out.mode)) {
    throw new Error(`Invalid --mode: ${out.mode}. Must be one of: ${[...VALID_MODES].join('|')}`);
  }
  if (out.mode === 'full' && !out.iHaveTwentyGb) {
    throw new Error(
      '--mode full requires --i-have-20gb-free. ' +
      'Multi-project sweep with no module filter routinely consumes 20+ GiB ' +
      'of transient gradle daemon footprint (feedback_disk_space_awareness.md, ' +
      'incident 2026-05-04). Verify ≥20 GiB free on /System/Volumes/Data, then ' +
      're-run with the override flag.',
    );
  }
  if (out.subcommand !== 'all' && !SUBCOMMANDS.includes(out.subcommand)) {
    throw new Error(`Invalid --subcommand: ${out.subcommand}. Must be one of: all|${SUBCOMMANDS.join('|')}`);
  }
  if (out.testType !== 'all-of' && !TEST_TYPES.includes(out.testType)) {
    throw new Error(`Invalid --test-type: ${out.testType}. Must be one of: all-of|${TEST_TYPES.join('|')}`);
  }
  if (out.project !== 'all' && !PROJECTS.some((p) => p.name === out.project)) {
    throw new Error(`Invalid --project: ${out.project}. Must be one of: all|${PROJECTS.map((p) => p.name).join('|')}`);
  }
  return out;
}

// ─── matrix expansion ──────────────────────────────────────────────────────

// Builds the cell list for a given options bundle. Each cell is a fully
// resolved unit of work: { subcommand, testType, project, args, skip? }.
// Cells with conditions that prevent spawning are pre-marked `skip`
// rather than emitted-and-failed (e.g. instrumented cells without an
// authorized device).
export function buildMatrix(opts, deps = {}) {
  const adbHasDevice = deps.adbHasDevice ?? defaultAdbHasDevice;
  const projectExists = deps.projectExists ?? defaultProjectExists;

  const targetSubs = opts.subcommand === 'all'
    ? SUBCOMMANDS
    : [opts.subcommand];
  const targetTypes = opts.testType === 'all-of'
    ? TEST_TYPES
    : [opts.testType];
  const targetProjects = opts.project === 'all'
    ? PROJECTS
    : PROJECTS.filter((p) => p.name === opts.project);

  const adbReady = adbHasDevice();
  // Probe mode short-circuits before any gradle (or adb) invocation,
  // so the device-required skip rule doesn't apply. Phase B should
  // produce envelope shapes for every cell regardless of device state.
  const requireAdb = opts.mode !== 'probe';
  const cells = [];

  for (const sub of targetSubs) {
    for (const proj of targetProjects) {
      if (sub === 'android') {
        // android subcommand is instrumented-only and ignores --test-type.
        // One cell per project. Skip if no project on disk or no device
        // (the latter only outside probe mode).
        cells.push(buildCell({
          sub, testType: null, proj,
          opts, adbReady, projectExists,
          skipReason: pickAndroidSkip({ proj, adbReady, projectExists, requireAdb }),
        }));
        continue;
      }
      // parallel + changed: cross with all selected test-types.
      for (const tt of targetTypes) {
        cells.push(buildCell({
          sub, testType: tt, proj,
          opts, adbReady, projectExists,
          skipReason: pickSkip({ tt, proj, adbReady, projectExists, requireAdb }),
        }));
      }
    }
  }
  return cells;
}

function buildCell({ sub, testType, proj, opts, skipReason }) {
  const args = [KMP_TEST, sub, '--project-root', proj.path];
  if (testType !== null) args.push('--test-type', testType);
  if (opts.mode === 'probe') {
    // Probe mode mirrors what parity.test.js does — invoke kmp-test
    // in its lightest no-gradle-spawn shape. The orchestrators short-
    // circuit before any gradle invocation, so envelopes come back
    // populated but no daemons start. Keeps probe mode disk-safe at
    // any free-space level.
    if (sub === 'android') args.push('--list-only');
    else args.push('--dry-run');
  }
  if (opts.mode === 'scoped' && proj.scopedModule) {
    // Strip leading `:` — the CLI's --module-filter is a name-glob,
    // not a gradle path. `:sample-result` → `sample-result`.
    const pattern = proj.scopedModule.replace(/^:/, '');
    args.push('--module-filter', pattern);
  }
  args.push('--json', '--timeout', String(opts.timeout));
  // CRITICAL — never emit --ignore-jdk-mismatch (memory rule
  // feedback_json_ignore_jdk_hides_errors.md). The vitest spec asserts
  // this for every generated cell.
  return {
    subcommand: sub,
    testType,
    project: proj.name,
    projectPath: proj.path,
    args,
    safeName: safeName({ sub, testType, project: proj.name }),
    skipReason,
  };
}

function pickAndroidSkip({ proj, adbReady, projectExists, requireAdb }) {
  if (!projectExists(proj.path)) return 'project-absent';
  if (!proj.hasAndroidInstrumented) return 'no-instrumented-target';
  if (requireAdb && !adbReady) return 'device-required';
  return null;
}

function pickSkip({ tt, proj, adbReady, projectExists, requireAdb }) {
  if (!projectExists(proj.path)) return 'project-absent';
  if (requireAdb && tt === 'androidInstrumented' && !adbReady) return 'device-required';
  return null;
}

// ─── default helpers (overridable for vitest) ──────────────────────────────

function defaultAdbHasDevice() {
  const r = spawnSync('adb', ['devices'], { encoding: 'utf8', shell: false });
  if (r.status !== 0 || !r.stdout) return false;
  // Match `<serial>\tdevice` (NOT `unauthorized`, `offline`, etc.).
  return /\n\S+\tdevice\b/.test(r.stdout);
}

function defaultProjectExists(p) {
  try { return statSync(p).isDirectory(); }
  catch { return false; }
}

// ─── safe filename helper ──────────────────────────────────────────────────

export function safeName({ sub, testType, project }) {
  const tt = testType || 'none';
  return `${sub}_${tt}_${project}`.replace(/[^A-Za-z0-9._-]/g, '_');
}

// ─── envelope extraction + shape signature ─────────────────────────────────

export function extractEnvelope(stdout) {
  if (!stdout) return null;
  const startIdx = stdout.lastIndexOf(ENVELOPE_BEGIN);
  if (startIdx >= 0) {
    const after = stdout.slice(startIdx + ENVELOPE_BEGIN.length);
    const endIdx = after.indexOf(ENVELOPE_END);
    if (endIdx >= 0) {
      const jsonText = after.slice(0, endIdx).trim();
      try { return JSON.parse(jsonText); } catch { /* fall through */ }
    }
  }
  const markerIdx = stdout.lastIndexOf('{"tool":"kmp-test"');
  if (markerIdx >= 0) {
    const tail = stdout.slice(markerIdx).trim();
    try { return JSON.parse(tail); } catch { /* fall through */ }
  }
  return null;
}

// Computes a recursive shape signature for an envelope: a sorted array
// of dot-path strings (no types). Arrays are summarized by their first
// non-null element. Type checking is intentionally omitted because the
// step-5 snapshots use sentinel string values like `"<DURATION_MS>"`
// for volatile fields — comparing against live numeric values would
// produce false-positive type drifts. Path-only detection still
// catches the three most common drift modes: key removed, key added,
// key renamed. Deep value diffs are Phase D's job.
export function extractShape(value, prefix = '') {
  const out = new Set();
  walk(value, prefix, out);
  return [...out].sort();
}

function walk(v, prefix, out) {
  if (prefix) out.add(prefix);
  if (v === null || v === undefined) return;
  if (Array.isArray(v)) {
    // Always emit the `[]` suffix so empty-vs-populated arrays don't
    // cause asymmetric drift (snapshot baseline often uses one shape
    // against synthetic fixtures, live runs against real projects use
    // the other).
    if (prefix) out.add(`${prefix}[]`);
    if (v.length > 0) walk(v[0], `${prefix}[]`, out);
    return;
  }
  if (typeof v === 'object') {
    for (const k of Object.keys(v).sort()) {
      const nextPrefix = prefix ? `${prefix}.${k}` : k;
      walk(v[k], nextPrefix, out);
    }
  }
}

// Mirror the platform-specific normalizations baked into
// tests/vitest/_parity-helpers.js#normalizeEnvelopeForSnapshot. The
// step-5 snapshots collapse `dry_run.plan.{spawn_cmd, spawn_args,
// script_path, final_args}` to a single `<PLATFORM_SPECIFIC>` token —
// shape diff against a live envelope must apply the same collapse,
// otherwise array-vs-string drifts reading as 2 unexpected paths
// (`plan.spawn_args[]`, `plan.final_args[]`) get reported as drift.
// Mutates and returns the envelope; only used as input to extractShape.
export function normalizeForShapeDiff(envelope) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  if (envelope.plan && typeof envelope.plan === 'object') {
    for (const k of ['spawn_cmd', 'spawn_args', 'script_path', 'final_args']) {
      if (k in envelope.plan) envelope.plan[k] = '<PLATFORM_SPECIFIC>';
    }
  }
  return envelope;
}

// Compares two shape signatures; returns { onlyInA, onlyInB, agree } sets.
// onlyInA = paths present in a but not b ("missing from observed").
// onlyInB = paths present in b but not a ("unexpected in observed").
// Array-element child paths (containing `[].`) are reported but excluded
// from `agree`: snapshot baselines were generated against synthetic
// fixtures whose array contents differ structurally from real projects
// (e.g., snapshot's empty `errors: []` vs live `errors: [{code, message}]`).
// Top-level array existence (`foo[]`), object keys, and nested non-array
// keys all still drive `agree` — those reflect the actual envelope contract.
export function diffShapes(expected, observed) {
  const exp = new Set(expected);
  const obs = new Set(observed);
  const onlyInExpected = [...exp].filter((x) => !obs.has(x));
  const onlyInObserved = [...obs].filter((x) => !exp.has(x));
  const isArrayChild = (p) => p.includes('[].');
  const expectedContractDrift = onlyInExpected.filter((p) => !isArrayChild(p));
  const observedContractDrift = onlyInObserved.filter((p) => !isArrayChild(p));
  return {
    onlyInExpected,
    onlyInObserved,
    agree: expectedContractDrift.length === 0 && observedContractDrift.length === 0,
  };
}

// ─── snapshot loader ───────────────────────────────────────────────────────

// Parses tests/vitest/__snapshots__/parity.test.js.snap. Vitest's snapshot
// format uses JSON5-ish syntax (trailing commas, unquoted-but-quotable
// identifiers, sentinel string values like "<DURATION_MS>"). We strip
// trailing commas and parse via JSON.parse.
export function loadSnapshots(text) {
  const out = {};
  // Match `exports[\`...title...\`] = \`...body...\`;` blocks.
  const re = /exports\[`([^`]+)`\]\s*=\s*`([\s\S]*?)`;/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const title = m[1];
    const body = m[2].trim();
    const cleaned = stripTrailingCommas(body);
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch { parsed = null; } // skip un-parseable; drift checker treats as absent
    out[title] = { title, body, parsed };
  }
  return out;
}

function stripTrailingCommas(s) {
  return s.replace(/,(\s*[}\]])/g, '$1');
}

// ─── cell execution ────────────────────────────────────────────────────────

function runCell(cell, opts, smokeDir, expectedShape) {
  const outFile  = path.join(smokeDir, `${cell.safeName}.out`);
  const errFile  = path.join(smokeDir, `${cell.safeName}.err`);
  const jsonFile = path.join(smokeDir, `${cell.safeName}.json`);
  const metaFile = path.join(smokeDir, `${cell.safeName}.meta.json`);

  if (cell.skipReason) {
    const meta = {
      cell, mode: opts.mode, bucket: 'SKIP', reason: cell.skipReason,
      durationMs: 0,
    };
    writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    console.log(`[SKIP] ${cell.safeName} — ${cell.skipReason}`);
    return meta;
  }

  const t0 = Date.now();
  const r = spawnSync(process.execPath, cell.args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    shell: false,
    cwd: REPO_ROOT,
    env: { ...process.env, TMPDIR: TMPDIR_OVERRIDE },
    timeout: (opts.timeout + 60) * 1000,
  });
  const elapsed = Date.now() - t0;

  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  writeFileSync(outFile, stdout);
  writeFileSync(errFile, stderr);

  const envelope = extractEnvelope(stdout);
  if (envelope) writeFileSync(jsonFile, JSON.stringify(envelope, null, 2));

  let bucket = 'ERROR';
  let reason = '';
  let driftDetail = null;
  if (r.status === null || r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT') {
    bucket = 'TIMEOUT';
    reason = `process timed out (${opts.timeout}s + 60s buffer)`;
  } else if (!envelope) {
    bucket = 'ERROR';
    reason = 'no envelope emitted (orchestrator died before --json write)';
  } else if (opts.mode === 'scoped') {
    // Scoped mode runs gradle for real; wet envelopes carry plan.modules[],
    // parallel.legs[], android.device_serial (and other host-specific
    // fields) that the dry snapshot baseline doesn't, so a structural diff
    // against expectedShape marks every cell DRIFT by design. Bucket on
    // the operational signal — exit_code + errors[] — for clean PASS/FAIL
    // classification. See BACKLOG IDEA "macos-validation-gate scoped
    // misalignment" (PR #222) for the divergence table.
    const errs = Array.isArray(envelope.errors) ? envelope.errors : [];
    if (envelope.exit_code === 0 && errs.length === 0) {
      bucket = 'PASS';
      reason = `wet run green (exit 0, no errors[])`;
    } else {
      bucket = 'ERROR';
      reason = `wet run failed (exit ${envelope.exit_code}, ${errs.length} errors)`;
    }
  } else if (expectedShape) {
    const observed = extractShape(normalizeForShapeDiff(structuredClone(envelope)));
    const diff = diffShapes(expectedShape, observed);
    if (diff.agree) {
      bucket = 'PASS';
      reason = `envelope shape matches snapshot (exit ${envelope.exit_code})`;
    } else {
      bucket = 'DRIFT';
      reason = `${diff.onlyInExpected.length} missing, ${diff.onlyInObserved.length} unexpected paths`;
      driftDetail = diff;
    }
  } else {
    // No expected snapshot for this cell type — neutral pass if exit code looks healthy.
    bucket = envelope.exit_code === 0 ? 'PASS' : 'ERROR';
    reason = `no snapshot baseline; exit ${envelope.exit_code}`;
  }

  const meta = {
    cell, mode: opts.mode, bucket, reason,
    durationMs: elapsed,
    exitCode: r.status,
    spawnError: r.error?.message,
    driftDetail,
  };
  writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  console.log(`[${bucket}] ${cell.safeName} in ${fmtDuration(elapsed)} — ${reason}`);
  return meta;
}

function maybeStopDaemons(opts, projPath) {
  if (!opts.stopDaemons) return;
  // dry + probe modes never spawn gradle daemons, so the stop is a
  // pointless ~1s wrapper invocation.
  if (opts.mode === 'dry' || opts.mode === 'probe') return;
  const wrapper = path.join(projPath, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (!existsSync(wrapper)) return;
  spawnSync(wrapper, ['--stop'], { cwd: projPath, encoding: 'utf8', shell: false });
}

function checkAbortFloor(opts) {
  // dry + probe modes don't allocate gradle daemons, so the disk floor
  // doesn't apply. They run regardless of free space.
  if (opts.mode === 'dry' || opts.mode === 'probe') return false;
  const r = spawnSync('df', ['-Pm', '/System/Volumes/Data'], { encoding: 'utf8', shell: false });
  if (r.status !== 0) return false;
  const lines = r.stdout.trim().split('\n');
  const cols = lines[lines.length - 1].split(/\s+/);
  const availMb = parseInt(cols[3], 10);
  if (Number.isFinite(availMb) && availMb < opts.abortFloorMb) {
    console.error(
      `[ABORT] free disk on /System/Volumes/Data is ${availMb} MiB ` +
      `< --abort-floor-mb=${opts.abortFloorMb}. Stopping the run to ` +
      `prevent the 2026-05-04 freeze pattern (memory rule: ` +
      `feedback_disk_space_awareness.md).`,
    );
    return true;
  }
  return false;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ─── reclassify mode ───────────────────────────────────────────────────────

function reclassifyCell(cell, smokeDir, expectedShape) {
  const metaFile = path.join(smokeDir, `${cell.safeName}.meta.json`);
  const jsonFile = path.join(smokeDir, `${cell.safeName}.json`);
  if (!existsSync(metaFile) && !existsSync(jsonFile)) {
    console.log(`[ABSENT] ${cell.safeName} — no captured artifacts`);
    return { cell, bucket: 'ABSENT', reason: 'no artifacts on disk' };
  }
  let envelope = null;
  if (existsSync(jsonFile)) {
    try { envelope = JSON.parse(readFileSync(jsonFile, 'utf8')); } catch { /* keep null */ }
  }
  let prior = {};
  if (existsSync(metaFile)) {
    try { prior = JSON.parse(readFileSync(metaFile, 'utf8')); } catch { /* keep {} */ }
  }
  let bucket = prior.bucket || 'ERROR';
  let reason = prior.reason || '';
  if (envelope && expectedShape) {
    const diff = diffShapes(expectedShape, extractShape(normalizeForShapeDiff(structuredClone(envelope))));
    if (diff.agree) {
      bucket = 'PASS';
      reason = `(reclassified) envelope shape matches snapshot`;
    } else {
      bucket = 'DRIFT';
      reason = `(reclassified) ${diff.onlyInExpected.length} missing, ${diff.onlyInObserved.length} unexpected paths`;
    }
  }
  console.log(`[${bucket}] ${cell.safeName} (reclassified) — ${reason}`);
  return { ...prior, cell, bucket, reason, reclassified: true };
}

// ─── snapshot key resolution ───────────────────────────────────────────────

// Maps a cell to its expected-snapshot title in parity.test.js.snap. The
// snapshots cover --dry-run / --list-only modes; for wet cells (--mode
// scoped/full) the same shape contract holds at the top level even if
// nested fields populate differently. Returns null if no baseline exists.
function snapshotTitleFor(cell) {
  if (cell.subcommand === 'parallel') {
    return 'parity / envelope JSON schema snapshot > parallel --dry-run --json envelope shape is stable 1';
  }
  if (cell.subcommand === 'changed') {
    return 'parity / envelope JSON schema snapshot > changed --dry-run --json --staged-only envelope shape is stable 1';
  }
  if (cell.subcommand === 'android') {
    return 'parity / envelope JSON schema snapshot > android --list-only --json envelope shape is stable 1';
  }
  return null;
}

// ─── summary markdown ──────────────────────────────────────────────────────

function emitSummary(results, opts, outputPath) {
  const counts = { PLANNED: 0, PASS: 0, DRIFT: 0, SKIP: 0, ERROR: 0, TIMEOUT: 0, ABSENT: 0 };
  for (const r of results) counts[r.bucket] = (counts[r.bucket] || 0) + 1;

  const lines = [];
  lines.push(`# ${opts.label} macOS validation gate — summary`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Mode: \`${opts.mode}\``);
  lines.push(`Output cells: ${results.length}`);
  lines.push(`Repo HEAD: \`${getGitHead()}\``);
  lines.push('');
  lines.push('## Bucket counts');
  lines.push('');
  lines.push('| Bucket | Count |');
  lines.push('|---|---|');
  for (const [b, c] of Object.entries(counts)) lines.push(`| ${b} | ${c} |`);
  lines.push(`| **Total** | **${results.length}** |`);
  lines.push('');
  lines.push('## Cells');
  lines.push('');
  lines.push('| Subcommand | Test type | Project | Bucket | Duration | Notes |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of results) {
    const c = r.cell;
    const dur = r.durationMs ? fmtDuration(r.durationMs) : '–';
    const note = (r.reason || '').replace(/\|/g, '\\|');
    lines.push(`| ${c.subcommand} | ${c.testType ?? 'n/a'} | ${c.project} | ${r.bucket} | ${dur} | ${note} |`);
  }
  lines.push('');
  const drifts = results.filter((r) => r.bucket === 'DRIFT' && r.driftDetail);
  if (drifts.length) {
    lines.push('## Drift detail');
    lines.push('');
    for (const r of drifts) {
      lines.push(`### ${r.cell.safeName} — DRIFT`);
      lines.push('');
      if (r.driftDetail.onlyInExpected.length) {
        lines.push('Missing from observed envelope:');
        lines.push('```');
        for (const p of r.driftDetail.onlyInExpected) lines.push(p);
        lines.push('```');
      }
      if (r.driftDetail.onlyInObserved.length) {
        lines.push('Unexpected in observed envelope (not in snapshot baseline):');
        lines.push('```');
        for (const p of r.driftDetail.onlyInObserved) lines.push(p);
        lines.push('```');
      }
      lines.push('');
    }
  }
  lines.push('## Forensic artifacts');
  lines.push('');
  lines.push(`Per-cell stdout / stderr / envelope / meta live under \`.smoke/macos-gate-${opts.label}/\`.`);
  lines.push('Filename pattern: `<subcommand>_<testType|none>_<project>.{out,err,json,meta.json}`.');
  lines.push('');

  writeFileSync(outputPath, lines.join('\n'));
  console.log(`\nWrote summary → ${outputPath}`);
  for (const [b, c] of Object.entries(counts)) console.log(`  ${b}: ${c}`);
}

function getGitHead() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', cwd: REPO_ROOT });
  return r.stdout?.trim() || 'unknown';
}

// ─── help text ─────────────────────────────────────────────────────────────

const HELP = `Usage: node tools/macos-validation-gate.mjs [options]

Manual macOS validation gate for v0.9. See BACKLOG.md ### v0.9 — macOS
validation gate for the matrix definition.

Options:
  --mode <dry|probe|scoped|full>
                                dry:    enumerate, no spawn (default)
                                probe:  spawn kmp-test --dry-run/--list-only
                                        per cell — captures real envelopes
                                        without invoking gradle (Phase B)
                                scoped: run with --module-filter <single>
                                full:   run unfiltered (requires --i-have-20gb-free)
  --subcommand <name>           parallel|changed|android|all (default: all)
  --test-type <name>            ${TEST_TYPES.join('|')}|all-of (default: all-of)
  --project <name>              ${PROJECTS.map((p) => p.name).join('|')}|all (default: all)
  --timeout <s>                 per-cell timeout in seconds (default: 900)
  --output <path>               summary markdown path (default: MACOS-GATE-V0.9-SUMMARY.md)
  --label <vX.Y>                version label used in title + smoke subdir (default: v0.9)
  --reclassify                  re-read .smoke artifacts, no spawn
  --abort-floor-mb <N>          stop the run if /System/Volumes/Data falls below N MiB (default: 2048)
  --no-stop-daemons             skip ./gradlew --stop between cells (debug only)
  --i-have-20gb-free            unlock --mode full (memory rule guard)
  --help, -h                    print this message
`;

// ─── main ──────────────────────────────────────────────────────────────────

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) {
    console.error(`Error: ${e.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const smokeDir = path.join(REPO_ROOT, '.smoke', `macos-gate-${opts.label}`);
  mkdirSync(smokeDir, { recursive: true });

  // Load snapshots once. Drift detection depends on this; an unparseable
  // snapshot file is non-fatal (cells without baselines fall through to
  // exit-code-only classification).
  let snapshots = {};
  if (existsSync(SNAPSHOT_FILE)) {
    snapshots = loadSnapshots(readFileSync(SNAPSHOT_FILE, 'utf8'));
  }

  const cells = buildMatrix(opts);
  console.log(`Mode: ${opts.mode}`);
  console.log(`Cells: ${cells.length}`);
  console.log(`Smoke dir: ${smokeDir}`);
  console.log(`Output:    ${path.join(REPO_ROOT, opts.output)}`);
  console.log('');

  if (opts.mode === 'dry') {
    // Plan-only: emit the cell list as a planned summary, no spawn.
    // PLANNED is a distinct bucket from PASS so the dry summary doesn't
    // misrepresent unexecuted cells as having succeeded.
    const results = cells.map((cell) => ({
      cell,
      bucket: cell.skipReason ? 'SKIP' : 'PLANNED',
      reason: cell.skipReason || `args: ${cell.args.slice(1).join(' ')}`,
      durationMs: null,
    }));
    emitSummary(results, opts, path.join(REPO_ROOT, opts.output));
    return;
  }

  let lastProject = null;
  const results = [];
  for (const cell of cells) {
    if (opts.reclassify) {
      results.push(reclassifyCell(cell, smokeDir, expectedShapeFor(cell, snapshots)));
      continue;
    }
    if (lastProject && lastProject !== cell.project) {
      // crossing project boundary — stop daemons of the previous project's wrapper
      const prior = PROJECTS.find((p) => p.name === lastProject);
      if (prior) maybeStopDaemons(opts, prior.path);
    }
    if (checkAbortFloor(opts)) break;
    results.push(runCell(cell, opts, smokeDir, expectedShapeFor(cell, snapshots)));
    lastProject = cell.project;
    // stop daemons between cells of the same project too (each cell
    // typically activates one leg's daemon; idle daemons accrete cache
    // and disk over a long matrix).
    maybeStopDaemons(opts, cell.projectPath);
  }
  emitSummary(results, opts, path.join(REPO_ROOT, opts.output));
}

function expectedShapeFor(cell, snapshots) {
  const title = snapshotTitleFor(cell);
  if (!title || !snapshots[title]?.parsed) return null;
  return extractShape(snapshots[title].parsed);
}

// Only run main when invoked directly. Importing the module (e.g. from
// vitest) triggers no side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

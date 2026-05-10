#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// tools/wet-audit-v0.9.mjs — pre-tag wet-audit for v0.9.0.
//
// Validates the post-989f57b surface (PRs #183/#184/#185 → develop tip
// 867df44+) end-to-end against 7 real projects + S22 Ultra (instrumented),
// with explicit coverage of the NEW `isolated_runtime_race` rejection
// path (zero prior wet coverage) and the schema_version 1 → 2 bump on
// every envelope.
//
// Cell types (concrete kmp-test invocations, no aliasing):
//   sanity      : doctor, info --no-adb
//   discovery   : describe (with + without --no-cache)
//   plan        : parallel --dry-run / --list-only --test-type all
//   wet-common  : parallel --test-type common
//   wet-desktop : parallel --test-type desktop
//   wet-aunit   : parallel --test-type androidUnit
//   wet-aint    : android (S22) + parallel --test-type androidInstrumented (S22)
//   neg-iso-*   : parallel --isolated --test-type {ios,all,androidInstrumented (no --device)}
//                 → expect errors[].code='isolated_runtime_race' + exit 2 (CONFIG_ERROR)
//   pos-iso     : 2× concurrent parallel --isolated --test-type common (cache_dir separation)
//   neg-filter  : parallel --module-filter ":nonexistent"
//                 → expect errors[].code='no_test_modules' + caused_by_filter:true + exit 2
//   neg-flavor  : android --flavor nonexistent
//                 → expect errors[].code='flavor_unused' + exit 2
//   coverage    : parallel --coverage-only / --min-missed-lines 0
//
// Modes (--mode):
//   dry            — print plan + cell args, no spawn (default)
//   probe          — run sanity + discovery + plan cells (no wet gradle)
//   wet-non-android— probe + wet-common/desktop + neg-filter + coverage + neg-iso-ios + neg-iso-all + pos-iso
//   wet-android    — wet-aunit + wet-aint + neg-iso-androidInstrumented + neg-flavor (S22 required)
//   wet            — full sweep (probe + wet-non-android + wet-android)
//   reclassify     — re-classify cached envelopes from .smoke/wet-audit-v0.9-release/
//
// Output:
//   .smoke/wet-audit-v0.9-release/<safe-id>.{out,err,json,meta.json}
//   WET-AUDIT-V0.9-RELEASE.md (markdown summary at repo root)
//
// Usage:
//   node tools/wet-audit-v0.9.mjs --mode dry
//   node tools/wet-audit-v0.9.mjs --mode probe
//   node tools/wet-audit-v0.9.mjs --mode wet-non-android --timeout 600
//   node tools/wet-audit-v0.9.mjs --mode wet-android --timeout 900
//   node tools/wet-audit-v0.9.mjs --mode wet --timeout 900
//   node tools/wet-audit-v0.9.mjs --mode reclassify
//   node tools/wet-audit-v0.9.mjs --only private-lib,PrivAndroidApp --mode wet-non-android

import { spawnSync, spawn as spawnAsync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');
const KMP_TEST   = path.join(REPO_ROOT, 'bin', 'kmp-test.js');
const SMOKE_DIR  = path.join(REPO_ROOT, '.smoke', 'wet-audit-v0.9-release');

const ENVELOPE_BEGIN = '__KMP_TEST_ENVELOPE_V1_BEGIN__';
const ENVELOPE_END   = '__KMP_TEST_ENVELOPE_V1_END__';
const SCHEMA_VERSION_EXPECTED = 2;

const WORKSPACE = process.env.KMP_WORKSPACE || path.resolve(process.cwd(), '..');

// 7 projects validated to have gradlew on disk. Nested wrappers point at
// the inner gradle root (KaMPKit-main/KaMPKit-main, PeopleInSpace-main/
// PeopleInSpace-main).
const PROJECTS = [
  { name: 'private-lib', path: `${WORKSPACE}/private-lib`,
    s22: true, hasInstrumented: true, hasFlavor: false,
    coverageModule: 'sample-result' /* :sample-result has Kover */,
    smallModuleFilter: 'sample-result',
  },
  { name: 'PrivAndroidApp', path: `${WORKSPACE}/PrivAndroidApp`,
    s22: true, hasInstrumented: true, hasFlavor: false,
    coverageModule: null, smallModuleFilter: null,
  },
  { name: 'local-app-2', path: `${WORKSPACE}/local-app-2`,
    s22: false, hasInstrumented: false, hasFlavor: false,
    coverageModule: null, smallModuleFilter: null,
  },
  { name: 'di-sample', path: `${WORKSPACE}/di-sample`,
    s22: true, hasInstrumented: true, hasFlavor: false,
    coverageModule: null, smallModuleFilter: 'di-contracts',
  },
  { name: 'local-app-3', path: `${WORKSPACE}/local-app-3`,
    s22: false, hasInstrumented: false, hasFlavor: false,
    coverageModule: null, smallModuleFilter: null,
  },
  { name: 'KaMPKit', path: `${WORKSPACE}/OFFICIAL_PROJECTS/KaMPKit-main/KaMPKit-main`,
    s22: false, hasInstrumented: false, hasFlavor: false,
    coverageModule: null, smallModuleFilter: 'shared',
  },
  { name: 'PeopleInSpace', path: `${WORKSPACE}/OFFICIAL_PROJECTS/PeopleInSpace-main/PeopleInSpace-main`,
    s22: false, hasInstrumented: false, hasFlavor: false,
    coverageModule: null, smallModuleFilter: 'common',
  },
];

const VALID_MODES = new Set(['dry', 'probe', 'wet-non-android', 'wet-android', 'wet', 'reclassify']);

// ─── argv parser ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    mode: 'dry',
    only: null,
    timeout: 600,
    output: 'WET-AUDIT-V0.9-RELEASE.md',
    instrumentedOnly: false,
    skipInstrumented: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode')                   { out.mode = argv[++i]; continue; }
    if (a === '--only')                   { out.only = new Set(argv[++i].split(',').map(s => s.trim())); continue; }
    if (a === '--timeout')                { out.timeout = parseInt(argv[++i], 10); continue; }
    if (a === '--output')                 { out.output = argv[++i]; continue; }
    if (a === '--instrumented-only')      { out.instrumentedOnly = true; continue; }
    if (a === '--skip-instrumented')      { out.skipInstrumented = true; continue; }
    if (a === '--skip-cached')            { out.skipCached = true; continue; }
    if (a === '--help' || a === '-h')     { out.help = true; continue; }
    throw new Error(`Unknown argument: ${a}`);
  }
  if (!VALID_MODES.has(out.mode)) {
    throw new Error(`Invalid --mode: ${out.mode}. Must be one of: ${[...VALID_MODES].join('|')}`);
  }
  return out;
}

// ─── helpers ───────────────────────────────────────────────────────────────

function safeId(s) { return s.replace(/[^A-Za-z0-9._-]/g, '_'); }

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms == null) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function spawnCapture(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    shell: false,
    ...opts,
  });
}

function extractEnvelope(stdout) {
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

const FAIL_LINE_RE = /\[FAIL\] :[^\s]+:[^\s]+/;

// ─── matrix builder ────────────────────────────────────────────────────────

// Returns Cell[]. Each cell is fully resolved at build time:
// { id, kind, project, args, expected, needsDevice, runOrder, concurrencyGroup? }.
//
// `expected` is the discriminator the classifier uses to decide PASS vs DRIFT vs RED.
//   - exitCodeAny: number[]   (acceptable exit codes, default [0])
//   - mustContainErrorCode: string | null  (negative-test cells)
//   - bucketIfMatch: 'PASS' | 'PASS-AS-EXPECTED'
function buildMatrix(opts, projects) {
  const cells = [];
  let order = 0;

  // 1) Sanity — doctor + info --no-adb (no project-root needed but we
  //    pass it so the envelope reflects the right gradle wrapper).
  for (const p of projects) {
    cells.push({
      id: safeId(`sanity_doctor__${p.name}`),
      kind: 'sanity-doctor',
      project: p.name,
      args: [KMP_TEST, 'doctor', '--project-root', p.path, '--json'],
      expected: { exitCodeAny: [0], bucketIfMatch: 'PASS' },
      needsDevice: false,
      runOrder: order++,
    });
    cells.push({
      id: safeId(`sanity_info__${p.name}`),
      kind: 'sanity-info',
      project: p.name,
      args: [KMP_TEST, 'info', '--project-root', p.path, '--json', '--no-adb'],
      expected: { exitCodeAny: [0], bucketIfMatch: 'PASS' },
      needsDevice: false,
      runOrder: order++,
    });
  }

  // 2) Discovery — describe (cache miss + cache hit). --no-cache forces
  //    fresh model build; second call hits cache.
  for (const p of projects) {
    cells.push({
      id: safeId(`discovery_describe_miss__${p.name}`),
      kind: 'discovery-describe-miss',
      project: p.name,
      args: [KMP_TEST, 'describe', '--project-root', p.path, '--json', '--no-cache'],
      expected: { exitCodeAny: [0], bucketIfMatch: 'PASS' },
      needsDevice: false,
      runOrder: order++,
    });
    cells.push({
      id: safeId(`discovery_describe_hit__${p.name}`),
      kind: 'discovery-describe-hit',
      project: p.name,
      args: [KMP_TEST, 'describe', '--project-root', p.path, '--json'],
      expected: { exitCodeAny: [0], bucketIfMatch: 'PASS' },
      needsDevice: false,
      runOrder: order++,
    });
  }

  // 3) Plan — parallel --dry-run / --list-only --test-type all
  for (const p of projects) {
    cells.push({
      id: safeId(`plan_dry_run__${p.name}`),
      kind: 'plan-dry-run',
      project: p.name,
      args: [KMP_TEST, 'parallel', '--project-root', p.path, '--test-type', 'all',
             '--dry-run', '--json'],
      // dry-run on no-test-modules projects emits no_test_modules at exit 3.
      // Accept exit 0 OR 3 with no_test_modules+caused_by_filter:false.
      expected: { exitCodeAny: [0, 3], bucketIfMatch: 'PASS' },
      needsDevice: false,
      runOrder: order++,
    });
    cells.push({
      id: safeId(`plan_list_only__${p.name}`),
      kind: 'plan-list-only',
      project: p.name,
      args: [KMP_TEST, 'parallel', '--project-root', p.path, '--test-type', 'all',
             '--list-only', '--json'],
      expected: { exitCodeAny: [0, 3], bucketIfMatch: 'PASS' },
      needsDevice: false,
      runOrder: order++,
    });
  }

  if (opts.mode === 'probe' || opts.mode === 'dry') return cells;

  // 4) Wet — common (multiplatform JVM-side) — projects with KMP source sets.
  for (const p of projects) {
    if (p.name === 'local-app-2' || p.name === 'local-app-3') continue; // not-KMP / Android-only
    cells.push({
      id: safeId(`wet_common__${p.name}`),
      kind: 'wet-common',
      project: p.name,
      args: [KMP_TEST, 'parallel', '--project-root', p.path, '--test-type', 'common',
             '--json', '--timeout', String(opts.timeout)],
      expected: { exitCodeAny: [0, 1, 3], bucketIfMatch: 'PASS' /* RED-repo allowed */ },
      needsDevice: false,
      runOrder: order++,
    });
  }

  // 5) Wet — desktop — JVM/Desktop-targeted KMP projects.
  for (const p of projects) {
    if (!['private-lib', 'KaMPKit', 'PeopleInSpace'].includes(p.name)) continue;
    cells.push({
      id: safeId(`wet_desktop__${p.name}`),
      kind: 'wet-desktop',
      project: p.name,
      args: [KMP_TEST, 'parallel', '--project-root', p.path, '--test-type', 'desktop',
             '--json', '--timeout', String(opts.timeout)],
      expected: { exitCodeAny: [0, 1, 3], bucketIfMatch: 'PASS' },
      needsDevice: false,
      runOrder: order++,
    });
  }

  // 6) Negative — filter with no match (emits caused_by_filter:true + exit 2)
  cells.push({
    id: 'neg_filter_nomatch__private-lib',
    kind: 'neg-filter',
    project: 'private-lib',
    args: [KMP_TEST, 'parallel', '--project-root',
           PROJECTS.find(p => p.name === 'private-lib').path,
           '--module-filter', ':nonexistent', '--test-type', 'common', '--json',
           '--timeout', String(opts.timeout)],
    expected: {
      exitCodeAny: [2],
      mustContainErrorCode: 'no_test_modules',
      causedByFilter: true,
      bucketIfMatch: 'PASS-AS-EXPECTED',
    },
    needsDevice: false,
    runOrder: order++,
  });

  // 7) Negative isolated — ios + all (no S22 needed; rejection happens
  //    BEFORE gradle invocation per parallel-orchestrator.js:1400-1428).
  cells.push({
    id: 'neg_iso_ios__private-lib',
    kind: 'neg-iso-ios',
    project: 'private-lib',
    args: [KMP_TEST, 'parallel', '--project-root',
           PROJECTS.find(p => p.name === 'private-lib').path,
           '--isolated', '--test-type', 'ios', '--json',
           '--timeout', String(opts.timeout)],
    expected: {
      exitCodeAny: [2],
      mustContainErrorCode: 'isolated_runtime_race',
      bucketIfMatch: 'PASS-AS-EXPECTED',
    },
    needsDevice: false,
    runOrder: order++,
  });
  cells.push({
    id: 'neg_iso_all__private-lib',
    kind: 'neg-iso-all',
    project: 'private-lib',
    args: [KMP_TEST, 'parallel', '--project-root',
           PROJECTS.find(p => p.name === 'private-lib').path,
           '--isolated', '--test-type', 'all', '--json',
           '--timeout', String(opts.timeout)],
    expected: {
      exitCodeAny: [2],
      mustContainErrorCode: 'isolated_runtime_race',
      bucketIfMatch: 'PASS-AS-EXPECTED',
    },
    needsDevice: false,
    runOrder: order++,
  });

  // 8) Coverage — coverage-only + min-missed-lines (gate)
  cells.push({
    id: 'coverage_only__private-lib',
    kind: 'coverage-only',
    project: 'private-lib',
    args: [KMP_TEST, 'parallel', '--project-root',
           PROJECTS.find(p => p.name === 'private-lib').path,
           '--test-type', 'common', '--coverage-only',
           '--module-filter', 'sample-result', '--json',
           '--timeout', String(opts.timeout)],
    expected: { exitCodeAny: [0, 1, 3], bucketIfMatch: 'PASS' },
    needsDevice: false,
    runOrder: order++,
  });
  cells.push({
    id: 'coverage_min_missed_zero__private-lib',
    kind: 'coverage-min-missed',
    project: 'private-lib',
    args: [KMP_TEST, 'parallel', '--project-root',
           PROJECTS.find(p => p.name === 'private-lib').path,
           '--test-type', 'common', '--module-filter', 'sample-result',
           '--min-missed-lines', '0', '--json',
           '--timeout', String(opts.timeout)],
    // exit 1 acceptable (gate may fire on missed lines > 0)
    expected: { exitCodeAny: [0, 1, 3], bucketIfMatch: 'PASS' },
    needsDevice: false,
    runOrder: order++,
  });

  // 8.5) FULL PARALLEL — `parallel --test-type all` on the heaviest KMP
  //      project, no module filter. The macOS validation gate explicitly
  //      skipped this cell shape because of the secondary Mac's tight
  //      disk. Windows has no such constraint, so the gate runs here.
  //      All legs dispatch concurrently (jvm/common/desktop/androidUnit/
  //      androidInstrumented/ios/macos), exercising the orchestrator's
  //      full multi-leg fan-out path. iOS/macOS legs may fail on
  //      Windows hosts — that's a platform-mismatch SKIP, not an
  //      orchestrator bug. The classifier accepts exit {0,1,3} and
  //      relies on RED-repo / SKIP-legit downstream classification.
  cells.push({
    id: 'wet_full_parallel__private-lib',
    kind: 'wet-full-parallel',
    project: 'private-lib',
    args: [KMP_TEST, 'parallel', '--project-root',
           PROJECTS.find(p => p.name === 'private-lib').path,
           '--test-type', 'all', '--json',
           '--timeout', String(Math.max(opts.timeout, 1500))],
    expected: { exitCodeAny: [0, 1, 3], bucketIfMatch: 'PASS' /* RED-repo permitted on Win for ios/macos legs */ },
    needsDevice: false /* S22 used for androidInstrumented if present, but cell still emits envelope without device */,
    runOrder: order++,
  });

  // 9) Positive isolated — 2× concurrent --isolated --test-type common
  //    (cache_dir separation; both should exit 0 if tests pass).
  //    Concurrency group = 'pos-iso-1' so runner can spawn both at once.
  for (const proj of ['private-lib', 'KaMPKit']) {
    const proot = PROJECTS.find(p => p.name === proj).path;
    cells.push({
      id: safeId(`pos_iso_common__${proj}`),
      kind: 'pos-iso',
      project: proj,
      args: [KMP_TEST, 'parallel', '--project-root', proot,
             '--isolated', '--test-type', 'common', '--module-filter',
             PROJECTS.find(p => p.name === proj).smallModuleFilter || '*',
             '--json', '--timeout', String(opts.timeout)],
      expected: { exitCodeAny: [0, 1, 3], bucketIfMatch: 'PASS', isolatedField: true },
      needsDevice: false,
      runOrder: order++,
      concurrencyGroup: 'pos-iso-1',
    });
  }

  // ─── Android cells ──────────────────────────────────────────────────────

  // 10) Wet — androidUnit
  for (const p of projects) {
    if (!['private-lib', 'PrivAndroidApp', 'di-sample'].includes(p.name)) continue;
    cells.push({
      id: safeId(`wet_aunit__${p.name}`),
      kind: 'wet-aunit',
      project: p.name,
      args: [KMP_TEST, 'parallel', '--project-root', p.path, '--test-type', 'androidUnit',
             '--json', '--timeout', String(opts.timeout)],
      expected: { exitCodeAny: [0, 1, 3], bucketIfMatch: 'PASS' },
      needsDevice: false,
      runOrder: order++,
    });
  }

  // 11) Negative — androidInstrumented isolated WITHOUT --device
  //     (rejection before gradle; doesn't need S22 connected).
  cells.push({
    id: 'neg_iso_aint_no_device__PrivAndroidApp',
    kind: 'neg-iso-aint',
    project: 'PrivAndroidApp',
    args: [KMP_TEST, 'parallel', '--project-root',
           PROJECTS.find(p => p.name === 'PrivAndroidApp').path,
           '--isolated', '--test-type', 'androidInstrumented', '--json',
           '--timeout', String(opts.timeout)],
    expected: {
      exitCodeAny: [2],
      mustContainErrorCode: 'isolated_runtime_race',
      bucketIfMatch: 'PASS-AS-EXPECTED',
    },
    needsDevice: false,
    runOrder: order++,
  });

  // 12) Wet — instrumented (S22).
  cells.push({
    id: 'wet_aint_android_subcommand__private-lib',
    kind: 'wet-aint',
    project: 'private-lib',
    args: [KMP_TEST, 'android', '--project-root',
           PROJECTS.find(p => p.name === 'private-lib').path,
           '--module-filter', 'bench-net', '--json',
           '--timeout', String(opts.timeout)],
    expected: { exitCodeAny: [0, 1, 3], bucketIfMatch: 'PASS' },
    needsDevice: true,
    runOrder: order++,
  });
  cells.push({
    id: 'wet_aint_parallel_dipatternsdemo',
    kind: 'wet-aint-parallel',
    project: 'di-sample',
    args: [KMP_TEST, 'parallel', '--project-root',
           PROJECTS.find(p => p.name === 'di-sample').path,
           '--test-type', 'androidInstrumented',
           '--module-filter', 'di-contracts', '--json',
           '--timeout', String(opts.timeout)],
    expected: { exitCodeAny: [0, 1, 3], bucketIfMatch: 'PASS' },
    needsDevice: true,
    runOrder: order++,
  });

  // 13) Negative — flavor unused (no productFlavors declared on PrivAndroidApp).
  //     `flavor_unused` only emits via the parallel orchestrator's
  //     androidInstrumented/all leg (parallel-orchestrator.js:1605-1614).
  //     The `kmp-test android` subcommand doesn't have this validation —
  //     it forwards the flavor as a gradle arg without checking. So the
  //     correct shape for this negative test is parallel + androidInstrumented.
  //     Doesn't need S22 connected: the check runs at module-discovery
  //     time, before any gradle dispatch or adb probe.
  cells.push({
    id: 'neg_flavor_unused__PrivAndroidApp',
    kind: 'neg-flavor',
    project: 'PrivAndroidApp',
    args: [KMP_TEST, 'parallel', '--project-root',
           PROJECTS.find(p => p.name === 'PrivAndroidApp').path,
           '--test-type', 'androidInstrumented',
           '--flavor', 'nonexistent', '--json',
           '--timeout', String(opts.timeout)],
    expected: {
      exitCodeAny: [2],
      mustContainErrorCode: 'flavor_unused',
      bucketIfMatch: 'PASS-AS-EXPECTED',
    },
    needsDevice: false,
    runOrder: order++,
  });

  return cells;
}

// Filter cells by mode. 'wet-non-android' drops android cells; 'wet-android'
// keeps only android-touched cells; 'wet' keeps everything.
function filterCellsByMode(cells, opts) {
  const androidKinds = new Set([
    'wet-aunit', 'wet-aint', 'wet-aint-parallel', 'neg-iso-aint', 'neg-flavor',
  ]);
  if (opts.mode === 'wet') return cells;
  if (opts.mode === 'probe' || opts.mode === 'dry') return cells; // no wet cells anyway
  if (opts.mode === 'wet-non-android') return cells.filter(c => !androidKinds.has(c.kind));
  if (opts.mode === 'wet-android') {
    // Android lane drops sanity/discovery/plan (they were already covered by probe).
    const dropKinds = new Set([
      'sanity-doctor', 'sanity-info', 'discovery-describe-miss',
      'discovery-describe-hit', 'plan-dry-run', 'plan-list-only',
      'wet-common', 'wet-desktop', 'neg-filter',
      'neg-iso-ios', 'neg-iso-all', 'coverage-only', 'coverage-min-missed',
      'pos-iso',
    ]);
    return cells.filter(c => !dropKinds.has(c.kind));
  }
  return cells;
}

// ─── classifier ────────────────────────────────────────────────────────────

// Cells that don't dispatch gradle tests — should PASS on exit-0 even
// when tests.individual_total is 0 (it's structurally 0 by design).
const NON_TEST_KINDS = new Set([
  'sanity-doctor', 'sanity-info',
  'discovery-describe-miss', 'discovery-describe-hit',
  'plan-dry-run', 'plan-list-only',
  'coverage-only', // implies --skip-tests; coverage aggregation only
]);

function classify(cell, envelope, stderr, exitCode, timedOut) {
  if (timedOut) {
    return { bucket: 'TIMEOUT', reason: 'process timed out (timeout + 60s buffer)' };
  }
  if (!envelope) {
    return { bucket: 'RED-orchestrator',
      reason: 'no envelope emitted (orchestrator died before --json write or extraction failed)' };
  }
  // schema_version drift always wins — it's a contract break.
  if (envelope.schema_version !== SCHEMA_VERSION_EXPECTED) {
    return { bucket: 'DRIFT',
      reason: `schema_version=${envelope.schema_version} (expected ${SCHEMA_VERSION_EXPECTED})` };
  }

  const errors = envelope.errors || [];
  const errorCodes = errors.map(e => e?.code).filter(Boolean);
  const expected = cell.expected || {};
  const actualExit = envelope.exit_code;
  const isNonTest = NON_TEST_KINDS.has(cell.kind);

  // Negative cells must contain a specific error code.
  if (expected.mustContainErrorCode) {
    const codeFound = errorCodes.includes(expected.mustContainErrorCode);
    const exitMatches = (expected.exitCodeAny || [0]).includes(actualExit);
    if (codeFound && exitMatches) {
      // For neg-filter, also verify caused_by_filter shape.
      if (typeof expected.causedByFilter === 'boolean') {
        const matchedErr = errors.find(e => e?.code === expected.mustContainErrorCode);
        const cbf = matchedErr?.caused_by_filter;
        if (cbf !== expected.causedByFilter) {
          return { bucket: 'DRIFT',
            reason: `caused_by_filter=${cbf} (expected ${expected.causedByFilter})` };
        }
      }
      return { bucket: expected.bucketIfMatch || 'PASS-AS-EXPECTED',
        reason: `errors[].code='${expected.mustContainErrorCode}' present, exit=${actualExit}` };
    }
    return { bucket: 'RED-orchestrator',
      reason: `expected errors[].code='${expected.mustContainErrorCode}' + exit ${expected.exitCodeAny.join('|')}; got codes=[${errorCodes.join(',') || 'none'}] exit=${actualExit}` };
  }

  // Positive cells: classify per exit + tests + errors[]
  // The android subcommand uses `tests.total/passed/failed` for test-case
  // counts. The parallel orchestrator emits both that AND `tests.individual_total`
  // (the JUnit-XML real count, which can dwarf tests.total when each
  // gradle task spans many testcases). Pick the larger of the two as
  // "did any tests actually execute."
  const indvTotal = Math.max(
    envelope.tests?.individual_total ?? 0,
    envelope.tests?.passed ?? 0,
    envelope.tests?.total ?? 0,
  );
  const skipped   = envelope.skipped || [];
  const hasModuleFailed = errorCodes.includes('module_failed');
  const hasFailLine     = FAIL_LINE_RE.test(stderr || '');
  const allErrorsAreNoTestModules =
    errors.length > 0 && errors.every(e => e?.code === 'no_test_modules');

  if (hasModuleFailed || hasFailLine) {
    return { bucket: 'RED-repo',
      reason: hasModuleFailed
        ? `module_failed (${errors.filter(e => e?.code === 'module_failed').length} mod${indvTotal ? `, ${indvTotal} testcases ran` : ''})`
        : '[FAIL] line in stderr' };
  }

  // Special: pos-iso cells must surface isolated:{} field
  if (expected.isolatedField && !envelope.isolated) {
    return { bucket: 'DRIFT', reason: 'expected isolated:{} field absent' };
  }

  if (actualExit === 0 && isNonTest) {
    return { bucket: 'PASS',
      reason: `non-test cell exit 0; envelope healthy (modules=${(envelope.modules || []).length}, schema=${envelope.schema_version})` };
  }
  if (actualExit === 0 && indvTotal > 0) {
    return { bucket: 'PASS', reason: `${indvTotal} testcases ran` };
  }
  if (actualExit === 0 && indvTotal === 0) {
    const skipReasons = [...new Set(skipped.map(s => s.reason).filter(Boolean))];
    return { bucket: 'SKIP-legit',
      reason: `exit 0, no testcases (skip reasons: ${skipReasons.join(' | ') || 'none'})` };
  }
  if (allErrorsAreNoTestModules) {
    return { bucket: 'SKIP-legit', reason: 'all errors are no_test_modules (legitimately empty)' };
  }
  if ((expected.exitCodeAny || [0]).includes(actualExit)) {
    // Within accepted exit codes (e.g., dry-run on test-empty project → exit 3).
    if (actualExit === 3 && allErrorsAreNoTestModules) {
      return { bucket: 'SKIP-legit', reason: 'exit 3 + no_test_modules (project has no test modules)' };
    }
    return { bucket: 'PASS', reason: `exit ${actualExit} matches expected set [${expected.exitCodeAny.join(',')}]` };
  }
  return { bucket: 'RED-orchestrator',
    reason: `exit ${actualExit} with codes [${errorCodes.join(',') || 'none'}] — not in expected set [${(expected.exitCodeAny || [0]).join(',')}]` };
}

// ─── runner ────────────────────────────────────────────────────────────────

function runCell(cell, opts) {
  const outFile  = path.join(SMOKE_DIR, `${cell.id}.out`);
  const errFile  = path.join(SMOKE_DIR, `${cell.id}.err`);
  const jsonFile = path.join(SMOKE_DIR, `${cell.id}.json`);
  const metaFile = path.join(SMOKE_DIR, `${cell.id}.meta.json`);

  const t0 = Date.now();
  const r = spawnCapture(process.execPath, cell.args, {
    timeout: (opts.timeout + 60) * 1000,
    cwd: REPO_ROOT,
  });
  const elapsedMs = Date.now() - t0;

  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  writeFileSync(outFile, stdout);
  writeFileSync(errFile, stderr);

  const envelope = extractEnvelope(stdout);
  if (envelope) writeFileSync(jsonFile, JSON.stringify(envelope, null, 2));

  const timedOut = r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT' || r.status === null;
  const cls = classify(cell, envelope, stderr, r.status, timedOut);

  const meta = {
    cell: { id: cell.id, kind: cell.kind, project: cell.project },
    bucket: cls.bucket,
    reason: cls.reason,
    elapsedMs,
    exitCode: r.status,
    spawnError: r.error?.message,
    timedOut,
    schemaVersion: envelope?.schema_version ?? null,
    errorCodes: (envelope?.errors || []).map(e => e?.code).filter(Boolean),
  };
  writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  console.log(`[${cls.bucket}] ${cell.id} in ${fmtDuration(elapsedMs)} — ${cls.reason}`);
  return meta;
}

// Concurrent runner for cells in the same concurrencyGroup.
async function runCellAsync(cell, opts) {
  return new Promise((resolve) => {
    const outFile  = path.join(SMOKE_DIR, `${cell.id}.out`);
    const errFile  = path.join(SMOKE_DIR, `${cell.id}.err`);
    const jsonFile = path.join(SMOKE_DIR, `${cell.id}.json`);
    const metaFile = path.join(SMOKE_DIR, `${cell.id}.meta.json`);

    const t0 = Date.now();
    const child = spawnAsync(process.execPath, cell.args, {
      shell: false,
      cwd: REPO_ROOT,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const tmo = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
    }, (opts.timeout + 60) * 1000);
    child.on('close', (code, signal) => {
      clearTimeout(tmo);
      const elapsedMs = Date.now() - t0;
      writeFileSync(outFile, stdout);
      writeFileSync(errFile, stderr);
      const envelope = extractEnvelope(stdout);
      if (envelope) writeFileSync(jsonFile, JSON.stringify(envelope, null, 2));
      const timedOut = signal === 'SIGTERM';
      const cls = classify(cell, envelope, stderr, code, timedOut);
      const meta = {
        cell: { id: cell.id, kind: cell.kind, project: cell.project },
        bucket: cls.bucket, reason: cls.reason, elapsedMs,
        exitCode: code, timedOut,
        schemaVersion: envelope?.schema_version ?? null,
        errorCodes: (envelope?.errors || []).map(e => e?.code).filter(Boolean),
        concurrent: true,
      };
      writeFileSync(metaFile, JSON.stringify(meta, null, 2));
      console.log(`[${cls.bucket}] ${cell.id} in ${fmtDuration(elapsedMs)} (concurrent) — ${cls.reason}`);
      resolve(meta);
    });
  });
}

function stopGradleDaemons(projectPath) {
  const wrapper = path.join(projectPath, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (!existsSync(wrapper)) return;
  try {
    spawnSync(wrapper, ['--stop'], {
      cwd: projectPath, encoding: 'utf8', shell: false, timeout: 30_000,
    });
  } catch { /* swallow — best-effort cleanup */ }
}

// ─── reclassify ────────────────────────────────────────────────────────────

function reclassifyCell(cell) {
  const jsonFile = path.join(SMOKE_DIR, `${cell.id}.json`);
  const errFile  = path.join(SMOKE_DIR, `${cell.id}.err`);
  const metaFile = path.join(SMOKE_DIR, `${cell.id}.meta.json`);

  if (!existsSync(metaFile) && !existsSync(jsonFile)) {
    console.log(`[ABSENT] ${cell.id} — no captured artifacts`);
    return { cell: { id: cell.id, kind: cell.kind, project: cell.project },
             bucket: 'ABSENT', reason: 'no artifacts on disk', elapsedMs: null };
  }
  let envelope = null;
  if (existsSync(jsonFile)) {
    try { envelope = JSON.parse(readFileSync(jsonFile, 'utf8')); } catch { /* keep null */ }
  }
  let stderr = '';
  if (existsSync(errFile)) {
    try { stderr = readFileSync(errFile, 'utf8'); } catch { /* keep '' */ }
  }
  let prior = {};
  if (existsSync(metaFile)) {
    try { prior = JSON.parse(readFileSync(metaFile, 'utf8')); } catch { /* keep {} */ }
  }
  const cls = classify(cell, envelope, stderr, envelope?.exit_code ?? prior.exitCode, false);
  console.log(`[${cls.bucket}] ${cell.id} (reclassified) — ${cls.reason}`);
  return {
    cell: { id: cell.id, kind: cell.kind, project: cell.project },
    bucket: cls.bucket, reason: cls.reason,
    elapsedMs: prior.elapsedMs ?? null,
    exitCode:  envelope?.exit_code ?? prior.exitCode ?? null,
    schemaVersion: envelope?.schema_version ?? prior.schemaVersion ?? null,
    errorCodes: (envelope?.errors || []).map(e => e?.code).filter(Boolean),
    reclassified: true,
  };
}

// ─── markdown emitter ──────────────────────────────────────────────────────

function emitMarkdown(results, outputPath, opts) {
  const counts = {
    PASS: 0, 'PASS-AS-EXPECTED': 0, 'SKIP-legit': 0, 'RED-repo': 0,
    'RED-orchestrator': 0, DRIFT: 0, TIMEOUT: 0, ABSENT: 0,
  };
  for (const r of results) {
    counts[r.bucket] = (counts[r.bucket] || 0) + 1;
  }

  const lines = [];
  lines.push('# WET-AUDIT-V0.9-RELEASE');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Mode: \`${opts.mode}\``);
  lines.push(`Repo HEAD: see \`git rev-parse HEAD\` at run time.`);
  lines.push('');
  lines.push('Validates the post-989f57b surface (PRs #183/#184/#185 → 867df44+) end-to-end against 7 real projects + S22 Ultra. Explicit coverage of the new `isolated_runtime_race` rejection path and `schema_version:2` everywhere.');
  lines.push('');
  lines.push('## Bucket counts');
  lines.push('');
  lines.push('| Bucket | Count | Meaning |');
  lines.push('|---|---|---|');
  lines.push(`| PASS | ${counts.PASS} | wet exit 0 + tests ran (or accepted exit set) |`);
  lines.push(`| PASS-AS-EXPECTED | ${counts['PASS-AS-EXPECTED']} | negative-test cell hit expected error code + exit |`);
  lines.push(`| SKIP-legit | ${counts['SKIP-legit']} | no testcases + legit reasons (no source set, etc.) |`);
  lines.push(`| RED-repo | ${counts['RED-repo']} | real test failures in the upstream project |`);
  lines.push(`| RED-orchestrator | ${counts['RED-orchestrator']} | orchestrator-side break — investigate AND fix in-session |`);
  lines.push(`| DRIFT | ${counts.DRIFT} | envelope contract divergence (schema_version, etc.) — investigate |`);
  lines.push(`| TIMEOUT | ${counts.TIMEOUT} | process timed out (likely orchestrator hang) |`);
  lines.push(`| ABSENT | ${counts.ABSENT} | reclassify saw no captured artifacts |`);
  lines.push('');
  lines.push(`**Total cells:** ${results.length}`);
  lines.push('');
  lines.push('## Per-cell results');
  lines.push('');
  lines.push('| Cell | Project | Kind | Bucket | Duration | Exit | Schema | Codes | Reason |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const codeCol = (r.errorCodes || []).length ? r.errorCodes.join(',') : '–';
    const schemaCol = r.schemaVersion ?? '–';
    const reasonCell = (r.reason || '').replace(/\|/g, '\\|');
    lines.push(`| ${r.cell.id} | ${r.cell.project} | ${r.cell.kind} | ${r.bucket} | ${fmtDuration(r.elapsedMs)} | ${r.exitCode == null ? '–' : r.exitCode} | ${schemaCol} | ${codeCol} | ${reasonCell} |`);
  }
  lines.push('');
  lines.push('## Non-PASS cells (forensic detail)');
  lines.push('');
  for (const r of results) {
    if (r.bucket === 'PASS' || r.bucket === 'PASS-AS-EXPECTED' || r.bucket === 'SKIP-legit') continue;
    lines.push(`### ${r.cell.id} — ${r.bucket}`);
    lines.push('');
    lines.push(`Project: ${r.cell.project}`);
    lines.push(`Kind: ${r.cell.kind}`);
    lines.push(`Reason: ${r.reason}`);
    if (r.exitCode != null) lines.push(`Exit code: ${r.exitCode}`);
    if (r.schemaVersion != null) lines.push(`Schema version: ${r.schemaVersion}`);
    if ((r.errorCodes || []).length) lines.push(`Error codes: ${r.errorCodes.join(', ')}`);
    lines.push('');
    lines.push(`Forensic captures: \`.smoke/wet-audit-v0.9-release/${r.cell.id}.{out,err,json,meta.json}\``);
    lines.push('');
  }
  lines.push('## Per-cell artifacts');
  lines.push('');
  lines.push('Each cell wrote 4 files under `.smoke/wet-audit-v0.9-release/` (gitignored):');
  lines.push('');
  lines.push('- `<id>.out` — stdout (envelope between `__KMP_TEST_ENVELOPE_V1_*__` markers)');
  lines.push('- `<id>.err` — stderr (orchestrator log + gradle stderr)');
  lines.push('- `<id>.json` — extracted JSON envelope (only when emitted)');
  lines.push('- `<id>.meta.json` — run metadata (bucket, reason, exit, codes)');
  lines.push('');

  writeFileSync(outputPath, lines.join('\n'));
  console.log(`\nWrote summary → ${outputPath}`);
  console.log('Bucket counts:');
  for (const [b, c] of Object.entries(counts)) {
    console.log(`  ${b}: ${c}`);
  }
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('node tools/wet-audit-v0.9.mjs --mode {dry|probe|wet-non-android|wet-android|wet|reclassify}');
    return;
  }
  mkdirSync(SMOKE_DIR, { recursive: true });

  const targetProjects = opts.only
    ? PROJECTS.filter(p => opts.only.has(p.name))
    : PROJECTS;

  const allCells = buildMatrix(opts, targetProjects);
  let cells = filterCellsByMode(allCells, opts);
  if (opts.skipInstrumented) cells = cells.filter(c => !c.needsDevice);
  if (opts.instrumentedOnly) cells = cells.filter(c => c.needsDevice || c.kind === 'neg-iso-aint' || c.kind === 'neg-flavor');
  if (opts.skipCached) {
    const before = cells.length;
    cells = cells.filter(c => !existsSync(path.join(SMOKE_DIR, `${c.id}.meta.json`)));
    console.log(`--skip-cached: ${before - cells.length} cells already captured, ${cells.length} remaining`);
  }

  console.log(`Mode: ${opts.mode}`);
  console.log(`Cells: ${cells.length}`);
  console.log(`Smoke dir: ${SMOKE_DIR}`);
  console.log('');

  if (opts.mode === 'dry') {
    for (const c of cells) {
      console.log(`[DRY] ${c.id}  args=[${c.args.slice(1).join(' ')}]`);
    }
    return;
  }

  if (opts.mode === 'reclassify') {
    const results = cells.map(reclassifyCell);
    emitMarkdown(results, path.join(REPO_ROOT, opts.output), opts);
    return;
  }

  const results = [];
  // Group cells by concurrencyGroup for parallel pos-iso execution.
  const concurrentGroups = new Map();
  const sequential = [];
  for (const c of cells) {
    if (c.concurrencyGroup) {
      const g = concurrentGroups.get(c.concurrencyGroup) || [];
      g.push(c);
      concurrentGroups.set(c.concurrencyGroup, g);
    } else {
      sequential.push(c);
    }
  }

  let lastProject = null;
  for (const c of sequential) {
    // Stop daemons when crossing project boundary (wet modes only).
    if (opts.mode !== 'probe' && c.project !== lastProject && lastProject) {
      const prevProj = PROJECTS.find(p => p.name === lastProject);
      if (prevProj) stopGradleDaemons(prevProj.path);
    }
    lastProject = c.project;
    results.push(runCell(c, opts));
  }
  // Run concurrent groups after sequential cells.
  for (const [groupId, groupCells] of concurrentGroups) {
    console.log(`\n[CONCURRENT-${groupId}] launching ${groupCells.length} cells in parallel…`);
    const groupResults = await Promise.all(groupCells.map(c => runCellAsync(c, opts)));
    results.push(...groupResults);
  }

  // Final daemon cleanup.
  if (opts.mode !== 'probe') {
    for (const p of targetProjects) stopGradleDaemons(p.path);
  }

  // If --skip-cached was used, merge cached cell results into the report
  // so the markdown reflects the full picture (newly-run + cached).
  if (opts.skipCached) {
    const ranIds = new Set(results.map(r => r.cell.id));
    const allInScope = filterCellsByMode(allCells, opts);
    const filtered = allInScope.filter(c =>
      (!opts.skipInstrumented || !c.needsDevice)
      && (!opts.instrumentedOnly || c.needsDevice || c.kind === 'neg-iso-aint' || c.kind === 'neg-flavor')
    );
    for (const c of filtered) {
      if (ranIds.has(c.id)) continue;
      const meta = reclassifyCell(c);
      if (meta.bucket !== 'ABSENT') results.push(meta);
    }
  }

  emitMarkdown(results, path.join(REPO_ROOT, opts.output), opts);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

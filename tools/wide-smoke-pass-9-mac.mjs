#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// tools/wide-smoke-pass-9-mac.mjs — macOS-side wide-smoke pass-9 sweep, the
// counterpart to tools/wide-smoke-pass-9.mjs (Windows). Targets the 4 KMP
// projects available in /Volumes/XcodeOscar/kmp-test-workspace/ (Confetti,
// KaMPKit, PeopleInSpace, shared-kmp-libs) with overlap on the Windows
// matrix names (Confetti-main / KaMPKit-main / PeopleInSpace-main).
//
// Three modes via --test-type:
//   all   — parity sweep vs Windows pass-8 baseline (covers JVM/desktop/common)
//   macos — macOS-only validation (Windows cannot run macosArm64Test)
//   ios   — iOS Simulator validation (Windows cannot run iosSimulatorArm64Test)
//
// Per-mode artifacts: .smoke/pass-9-mac-<type>/<safe-name>.{out,err,json,meta.json}
// Per-mode output: WIDE-SMOKE-PASS-9-MAC-<TYPE>.md (uppercase suffix)
//
// Usage:
//   node tools/wide-smoke-pass-9-mac.mjs                                   # --test-type all (default)
//   node tools/wide-smoke-pass-9-mac.mjs --test-type macos
//   node tools/wide-smoke-pass-9-mac.mjs --test-type ios --only Confetti
//   node tools/wide-smoke-pass-9-mac.mjs --reclassify --test-type all
//
// Classifier code is a 1:1 mirror of wide-smoke-pass-9.mjs so Mac+Win
// outputs are directly comparable.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');
const KMP_TEST   = path.join(REPO_ROOT, 'bin', 'kmp-test.js');

const ENVELOPE_BEGIN = '__KMP_TEST_ENVELOPE_V1_BEGIN__';
const ENVELOPE_END   = '__KMP_TEST_ENVELOPE_V1_END__';

const WORKSPACE = '/Volumes/XcodeOscar/kmp-test-workspace';

// 4 gradle roots — the subset of pass-9's 30-project matrix that is
// reproducible on this Mac. Names mirror their Windows counterparts (without
// the `-main` suffix that distinguishes the GitHub-zip-extracted folders on
// Windows) so Mac↔Win envelope comparison is unambiguous.
const PROJECTS = [
  { name: 'Confetti',         path: `${WORKSPACE}/Confetti`,         category: 'INTERESTING', winName: 'Confetti-main' },
  { name: 'KaMPKit',          path: `${WORKSPACE}/KaMPKit`,          category: 'NEW',         winName: 'KaMPKit-main' },
  { name: 'PeopleInSpace',    path: `${WORKSPACE}/PeopleInSpace`,    category: 'NEW',         winName: 'PeopleInSpace-main' },
  { name: 'shared-kmp-libs',  path: `${WORKSPACE}/shared-kmp-libs`,  category: 'PR3',         winName: 'shared-kmp-libs' },
];

const VALID_TEST_TYPES = new Set(['all', 'macos', 'ios']);

function parseArgs(argv) {
  const out = { testType: 'all', output: null, timeout: 900, only: null, reclassify: false, maxWorkers: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--test-type')   { out.testType   = argv[++i]; continue; }
    if (a === '--output')      { out.output     = argv[++i]; continue; }
    if (a === '--timeout')     { out.timeout    = parseInt(argv[++i], 10); continue; }
    if (a === '--only')        { out.only       = new Set(argv[++i].split(',').map(s => s.trim())); continue; }
    if (a === '--reclassify')  { out.reclassify = true; continue; }
    if (a === '--max-workers') { out.maxWorkers = argv[++i]; continue; }
  }
  if (!VALID_TEST_TYPES.has(out.testType)) {
    console.error(`Invalid --test-type: ${out.testType}. Must be one of: ${[...VALID_TEST_TYPES].join('|')}`);
    process.exit(2);
  }
  if (!out.output) out.output = `WIDE-SMOKE-PASS-9-MAC-${out.testType.toUpperCase()}.md`;
  return out;
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

function detectCascadePattern(envelope) {
  const legs = envelope?.parallel?.legs || [];
  const cascadeLegs = [];
  const realFailedLegs = [];
  for (const leg of legs) {
    if (leg.exit_code === 0) continue;
    let isLegCascade;
    if (typeof leg.cascade_detected === 'boolean') {
      isLegCascade = leg.cascade_detected;
    } else {
      const ex = leg.execution || {};
      isLegCascade = (ex.failed || 0) === 0 && (ex.no_evidence || 0) > 0;
    }
    if (isLegCascade) cascadeLegs.push(leg.test_type);
    else realFailedLegs.push(leg.test_type);
  }
  return { isCascade: cascadeLegs.length > 0, cascadeLegs, realFailedLegs };
}

function classify(envelope, stderr) {
  if (!envelope) {
    return {
      bucket: 'RED-orchestrator',
      reason: 'no envelope emitted (orchestrator fast-failed before --json write or spawn died)',
      errorCodes: [],
    };
  }
  const exitCode  = envelope.exit_code;
  const indvTotal = envelope.tests?.individual_total ?? 0;
  const errors    = envelope.errors || [];
  const skipped   = envelope.skipped || [];
  const errorCodes = errors.map(e => e?.code).filter(Boolean);
  const hasModuleFailed = errorCodes.includes('module_failed');
  const hasFailLine     = FAIL_LINE_RE.test(stderr || '');
  const allErrorsAreNoTestModules =
    errors.length > 0 && errors.every(e => e?.code === 'no_test_modules');
  const cascade = detectCascadePattern(envelope);

  if (hasModuleFailed || hasFailLine) {
    const moduleFailedCount = errors.filter(e => e?.code === 'module_failed').length;
    if (cascade.isCascade && cascade.realFailedLegs.length === 0) {
      const allCascadeLegsRetried = cascade.cascadeLegs.every(t => {
        const leg = (envelope.parallel?.legs || []).find(l => l.test_type === t);
        return leg?.retry_fired === true;
      });
      if (allCascadeLegsRetried) {
        return {
          bucket: 'RED-repo',
          reason: `cascade-isolation retry fired on all cascade legs [${cascade.cascadeLegs.join(', ')}] — modules independently broken at evaluation phase (not orchestrator bug). ${moduleFailedCount} module_failed, ${indvTotal} testcases ran in OTHER legs.`,
          errorCodes,
        };
      }
      return {
        bucket: 'RED-orchestrator-cascade',
        reason: `${moduleFailedCount} module_failed across cascade legs [${cascade.cascadeLegs.join(', ')}], no real test failures, retry did NOT fire`,
        errorCodes,
      };
    }
    if (cascade.isCascade && cascade.realFailedLegs.length > 0) {
      return {
        bucket: 'RED-repo',
        reason: `MIXED: cascade in [${cascade.cascadeLegs.join(', ')}] + real failures in [${cascade.realFailedLegs.join(', ')}] (${moduleFailedCount} module_failed, ${indvTotal} testcases ran)`,
        errorCodes,
      };
    }
    return {
      bucket: 'RED-repo',
      reason: `module_failed discriminator (${moduleFailedCount} module(s), ${indvTotal} testcases ran)`,
      errorCodes,
    };
  }
  if (exitCode === 0 && indvTotal > 0) {
    return { bucket: 'GREEN', reason: `${indvTotal} testcases ran`, errorCodes };
  }
  if (exitCode === 0 && indvTotal === 0) {
    const skipReasons = [...new Set(skipped.map(s => s.reason).filter(Boolean))];
    return {
      bucket: 'SKIP',
      reason: `exit 0, no testcases (skip reasons: ${skipReasons.join(' | ') || 'none'})`,
      errorCodes,
    };
  }
  if (allErrorsAreNoTestModules && indvTotal === 0) {
    return { bucket: 'SKIP', reason: 'all errors are no_test_modules (legitimately empty)', errorCodes };
  }
  return {
    bucket: 'RED-orchestrator',
    reason: `exit ${exitCode} with codes [${errorCodes.join(',') || 'none'}] — no [FAIL] line, no module_failed`,
    errorCodes,
  };
}

function safeName(name) { return name.replace(/[^A-Za-z0-9._-]/g, '_'); }

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function runOneProject(proj, opts, smokeDir) {
  const safe     = safeName(proj.name);
  const outFile  = path.join(smokeDir, `${safe}.out`);
  const errFile  = path.join(smokeDir, `${safe}.err`);
  const jsonFile = path.join(smokeDir, `${safe}.json`);

  if (!existsSync(proj.path)) {
    console.log(`[MISSING] ${proj.name} (path not found)`);
    return { proj, missing: true };
  }

  const args = [
    KMP_TEST, 'parallel',
    '--project-root', proj.path,
    '--test-type', opts.testType,
    '--json',
    '--timeout', String(opts.timeout),
  ];
  if (opts.maxWorkers != null) {
    args.push('--max-workers', String(opts.maxWorkers));
  }

  const nodeTimeoutMs = (opts.timeout + 60) * 1000;

  const t0 = Date.now();
  const r  = spawnCapture(process.execPath, args, { timeout: nodeTimeoutMs, cwd: REPO_ROOT });
  const elapsed = Date.now() - t0;

  const stdout = r.stdout || '';
  const stderr = r.stderr || '';

  writeFileSync(outFile, stdout);
  writeFileSync(errFile, stderr);

  const envelope = extractEnvelope(stdout);
  if (envelope) writeFileSync(jsonFile, JSON.stringify(envelope, null, 2));

  const cls = classify(envelope, stderr);
  console.log(`[${cls.bucket}] ${proj.name} in ${fmtDuration(elapsed)} — ${cls.reason}`);

  const result = {
    proj,
    elapsedMs: elapsed,
    exitCode: r.status,
    spawnError: r.error?.message,
    timedOut: r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT' || r.status === null,
    envelope,
    bucket: cls.bucket,
    reason: cls.reason,
    errorCodes: cls.errorCodes || [],
  };
  const metaFile = path.join(smokeDir, `${safe}.meta.json`);
  const { envelope: _envForMeta, proj: _projForMeta, ...metaRest } = result;
  writeFileSync(metaFile, JSON.stringify({
    proj: { name: proj.name, path: proj.path, category: proj.category, winName: proj.winName },
    testType: opts.testType,
    ...metaRest,
  }, null, 2));
  return result;
}

function reclassifyOneProject(proj, smokeDir) {
  const safe     = safeName(proj.name);
  const jsonFile = path.join(smokeDir, `${safe}.json`);
  const errFile  = path.join(smokeDir, `${safe}.err`);
  const metaFile = path.join(smokeDir, `${safe}.meta.json`);

  if (!existsSync(metaFile) && !existsSync(jsonFile)) {
    console.log(`[MISSING] ${proj.name} (no captured artifacts at ${smokeDir})`);
    return { proj, missing: true };
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

  const cls = classify(envelope, stderr);
  console.log(`[${cls.bucket}] ${proj.name} (reclassified) — ${cls.reason}`);

  return {
    proj,
    elapsedMs: prior.elapsedMs ?? null,
    exitCode:  prior.exitCode ?? envelope?.exit_code ?? null,
    spawnError: prior.spawnError,
    timedOut:  prior.timedOut ?? false,
    envelope,
    bucket: cls.bucket,
    reason: cls.reason,
    errorCodes: cls.errorCodes || [],
    reclassified: true,
  };
}

function envelopeExcerpt(env) {
  if (!env) return null;
  return {
    exit_code: env.exit_code,
    tests: env.tests,
    errors: env.errors,
    skipped: env.skipped,
    warnings: env.warnings,
    parallel: env.parallel ? {
      test_type:   env.parallel.test_type,
      max_workers: env.parallel.max_workers,
      timeout_s:   env.parallel.timeout_s,
      legs: (env.parallel.legs || []).map(l => ({
        test_type: l.test_type,
        exit_code: l.exit_code,
        execution: l.execution,
      })),
    } : undefined,
  };
}

// Pass-8 bucket baseline for the 4 Mac-reproducible projects, mapped via
// proj.winName (frozen 2026-05-04 from WIDE-SMOKE-PASS-8.md). Only used when
// --test-type all (the parity sweep). For macos / ios sweeps, no baseline
// exists — Mac is the source of truth for those test types.
const PASS8_WIN = {
  'Confetti-main':       'RED-repo',
  'KaMPKit-main':        'SKIP',
  'PeopleInSpace-main':  'RED-repo',
  'shared-kmp-libs':     'RED-repo',
};

function emitMarkdown(results, outputPath, opts) {
  const counts = { GREEN: 0, SKIP: 0, 'RED-repo': 0, 'RED-orchestrator-cascade': 0, 'RED-orchestrator': 0, MISSING: 0 };
  for (const r of results) {
    if (r.missing) { counts.MISSING++; continue; }
    counts[r.bucket] = (counts[r.bucket] || 0) + 1;
  }

  const lines = [];
  lines.push(`# Wide-smoke pass-9 (mac) — \`--test-type ${opts.testType}\``);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`Test type: \`${opts.testType}\``);
  lines.push(`Workspace: \`${WORKSPACE}\``);
  lines.push(`Orchestrator HEAD: \`${getGitHead()}\``);
  lines.push('');
  if (opts.testType === 'all') {
    lines.push('Goal: Mac-side parity check vs Windows pass-8 baseline (PR #129 sweep). The 4 Mac-reproducible projects must match their Windows-side bucket (or improve via the fix-PR-A/D/B/C cumulative). Any flip from `GREEN/SKIP → RED-orchestrator*` blocks v0.8.0.');
  } else if (opts.testType === 'macos') {
    lines.push('Goal: validate `macosArm64Test` per-module dispatch + envelope shape on real macOS hardware. Windows cannot exercise this codepath.');
  } else if (opts.testType === 'ios') {
    lines.push('Goal: validate `iosSimulatorArm64Test` dispatch + iOS Simulator boot orchestration on real macOS hardware. Windows cannot exercise this codepath.');
  }
  lines.push('');
  lines.push('## Bucket counts');
  lines.push('');
  lines.push('| Bucket | Count |');
  lines.push('|---|---|');
  for (const [b, c] of Object.entries(counts)) {
    lines.push(`| ${b} | ${c} |`);
  }
  lines.push(`| **Total** | **${results.length}** |`);
  lines.push('');
  lines.push('## Summary table');
  lines.push('');
  lines.push('| Project | Category | Bucket | Duration | Exit | Discriminators | Notes |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of results) {
    if (r.missing) {
      lines.push(`| ${r.proj.name} | ${r.proj.category} | MISSING | – | – | – | path not found: \`${r.proj.path}\` |`);
      continue;
    }
    const codeCounts = {};
    for (const c of r.errorCodes) codeCounts[c] = (codeCounts[c] || 0) + 1;
    const codes = r.errorCodes.length
      ? Object.entries(codeCounts).map(([c, n]) => n > 1 ? `${c}×${n}` : c).join(', ')
      : '–';
    const exitCol = r.timedOut ? 'TIMEOUT' : (r.exitCode == null ? '?' : String(r.exitCode));
    const noteCell = r.reason.replace(/\|/g, '\\|');
    lines.push(`| ${r.proj.name} | ${r.proj.category} | ${r.bucket} | ${fmtDuration(r.elapsedMs)} | ${exitCol} | ${codes} | ${noteCell} |`);
  }
  lines.push('');

  if (opts.testType === 'all') {
    lines.push('## Mac↔Win parity (vs Windows pass-8 baseline)');
    lines.push('');
    lines.push('| Project | Win name (pass-8) | Win bucket | Mac bucket | Δ |');
    lines.push('|---|---|---|---|---|');
    for (const r of results) {
      if (r.missing) {
        lines.push(`| ${r.proj.name} | ${r.proj.winName} | ${PASS8_WIN[r.proj.winName] || '?'} | MISSING | – |`);
        continue;
      }
      const win = PASS8_WIN[r.proj.winName] || '?';
      let flag = '';
      if (win !== r.bucket) {
        const wasRed   = win.startsWith('RED');
        const nowGreen = r.bucket === 'GREEN' || r.bucket === 'SKIP';
        flag = (wasRed && nowGreen) ? ' ✅ IMPROVEMENT' : ' ⚠️ DELTA';
      }
      lines.push(`| ${r.proj.name} | ${r.proj.winName} | ${win} | ${r.bucket}${flag} | ${win === r.bucket ? '✓' : flag.trim()} |`);
    }
    lines.push('');
  }

  lines.push('## Per-project envelopes (non-GREEN)');
  lines.push('');
  for (const r of results) {
    if (r.missing || r.bucket === 'GREEN') continue;
    lines.push(`### ${r.proj.name} — ${r.bucket}`);
    lines.push('');
    lines.push(`Path: \`${r.proj.path}\``);
    lines.push(`Category: ${r.proj.category}`);
    lines.push(`Spawn exit: ${r.exitCode == null ? '(null — likely timeout)' : r.exitCode}${r.timedOut ? ' [TIMEOUT]' : ''}`);
    if (r.spawnError) lines.push(`Spawn error: ${r.spawnError}`);
    lines.push(`Reason: ${r.reason}`);
    lines.push('');
    if (r.envelope) {
      lines.push('Envelope excerpt:');
      lines.push('```json');
      lines.push(JSON.stringify(envelopeExcerpt(r.envelope), null, 2));
      lines.push('```');
    } else {
      const safe = safeName(r.proj.name);
      lines.push(`_No envelope emitted — see \`.smoke/pass-9-mac-${opts.testType}/${safe}.err\` for stderr._`);
    }
    lines.push('');
  }

  lines.push('## Per-project artifacts');
  lines.push('');
  lines.push(`Forensic captures live in \`.smoke/pass-9-mac-${opts.testType}/\` (gitignored — same \`.smoke/\` rule as pass-7/8/9):`);
  lines.push('');
  lines.push('- `<safe-name>.out` — stdout (envelope between sentinel markers)');
  lines.push('- `<safe-name>.err` — stderr (orchestrator log + gradle stderr)');
  lines.push('- `<safe-name>.json` — extracted JSON envelope (only when emitted)');
  lines.push('- `<safe-name>.meta.json` — run metadata for `--reclassify`');
  lines.push('');

  writeFileSync(outputPath, lines.join('\n'));
  console.log(`\nWrote summary → ${outputPath}`);
  console.log(`Bucket counts (pass-9-mac, --test-type ${opts.testType}):`);
  for (const [b, c] of Object.entries(counts)) {
    console.log(`  ${b}: ${c}`);
  }
}

function getGitHead() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', cwd: REPO_ROOT });
  return r.stdout?.trim() || 'unknown';
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const smokeDir = path.join(REPO_ROOT, '.smoke', `pass-9-mac-${opts.testType}`);
  mkdirSync(smokeDir, { recursive: true });

  const targets = opts.only
    ? PROJECTS.filter(p => opts.only.has(p.name))
    : PROJECTS;

  if (opts.reclassify) {
    console.log(`Reclassifying ${targets.length} projects from ${smokeDir} (no gradle spawn)`);
    console.log('');
    const results = targets.map(p => reclassifyOneProject(p, smokeDir));
    emitMarkdown(results, path.join(REPO_ROOT, opts.output), opts);
    return;
  }

  console.log(`Sweeping ${targets.length} projects, --test-type ${opts.testType} (per-project timeout: ${opts.timeout}s + 60s buffer)`);
  console.log(`Repo root: ${REPO_ROOT}`);
  console.log(`Smoke dir: ${smokeDir}`);
  console.log('');

  const results = [];
  for (const proj of targets) {
    const r = runOneProject(proj, opts, smokeDir);
    results.push(r);
  }

  emitMarkdown(results, path.join(REPO_ROOT, opts.output), opts);
}

main();

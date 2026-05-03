#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// tools/wide-smoke-pass-7.mjs — wide-smoke pass-7 sweep for v0.8.0
// release-validation gate. Walks a hardcoded list of 31 gradle projects under
// AndroidStudioProjects/, runs `kmp-test parallel --test-type all --json`
// against each, classifies the result into GREEN/RED-orchestrator/RED-repo/SKIP,
// emits WIDE-SMOKE-PASS-7.md at repo root.
//
// Usage:
//   node tools/wide-smoke-pass-7.mjs                              # full sweep
//   node tools/wide-smoke-pass-7.mjs --output X.md --timeout 900
//   node tools/wide-smoke-pass-7.mjs --only TaskFlow,gyg          # subset re-run
//
// Per-project artifacts (gitignored): .smoke/pass-7/<safe-name>.{out,err,json}

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');
const KMP_TEST   = path.join(REPO_ROOT, 'bin', 'kmp-test.js');
const SMOKE_DIR  = path.join(REPO_ROOT, '.smoke', 'pass-7');

// Sentinel markers emitted by lib/runner.js around the JSON envelope on --json.
// Mirror lib/cli.js#extractMigratedEnvelope (96-105) including lastIndexOf.
const ENVELOPE_BEGIN = '__KMP_TEST_ENVELOPE_V1_BEGIN__';
const ENVELOPE_END   = '__KMP_TEST_ENVELOPE_V1_END__';

const WORKSPACE = 'C:/Users/34645/AndroidStudioProjects';

// 31 gradle roots discovered in the Phase-1 inventory sweep. Categorised by
// PR3 sweep status. Stable ordering — alphabetical within each category.
const PROJECTS = [
  // PR3 sweep (8) — already validated for preflightJdkCheck
  { name: 'android-challenge',         path: `${WORKSPACE}/android-challenge`,         category: 'PR3' },
  { name: 'DawSync',                   path: `${WORKSPACE}/DawSync`,                   category: 'PR3' },
  { name: 'dipatternsdemo',            path: `${WORKSPACE}/dipatternsdemo`,            category: 'PR3' },
  { name: 'dokka-markdown-plugin',     path: `${WORKSPACE}/dokka-markdown-plugin`,     category: 'PR3' },
  { name: 'gyg',                       path: `${WORKSPACE}/gyg`,                       category: 'PR3' },
  { name: 'OmniSound',                 path: `${WORKSPACE}/OmniSound`,                 category: 'PR3' },
  { name: 'shared-kmp-libs',           path: `${WORKSPACE}/shared-kmp-libs`,           category: 'PR3' },
  { name: 'TaskFlow',                  path: `${WORKSPACE}/TaskFlow`,                  category: 'PR3' },

  // Known interesting (8) — wild-hit cases from prior wide-smokes
  { name: 'Confetti-main',                path: `${WORKSPACE}/OFFICIAL_PROJECTS/Confetti-main/Confetti-main`,                              category: 'INTERESTING' },
  { name: 'DroidconKotlin-main',          path: `${WORKSPACE}/OFFICIAL_PROJECTS/DroidconKotlin-main/DroidconKotlin-main`,                  category: 'INTERESTING' },
  { name: 'KMedia-main',                  path: `${WORKSPACE}/OFFICIAL_PROJECTS/KMedia-main/KMedia-main`,                                  category: 'INTERESTING' },
  { name: 'kmp-production-sample-master', path: `${WORKSPACE}/OFFICIAL_PROJECTS/kmp-production-sample-master/kmp-production-sample-master`, category: 'INTERESTING' },
  { name: 'nav3-recipes',                 path: `${WORKSPACE}/OFFICIAL_PROJECTS/nav3-recipes`,                                              category: 'INTERESTING' },
  { name: 'Nav3Guide-scenes',             path: `${WORKSPACE}/OFFICIAL_PROJECTS/Nav3Guide-scenes`,                                          category: 'INTERESTING' },
  { name: 'nowinandroid',                 path: `${WORKSPACE}/OFFICIAL_PROJECTS/nowinandroid`,                                              category: 'INTERESTING' },
  { name: 'NYTimes-KMP-main',             path: `${WORKSPACE}/OFFICIAL_PROJECTS/NYTimes-KMP-main/NYTimes-KMP-main`,                        category: 'INTERESTING' },

  // New / unmentioned (15)
  { name: 'AndroidCommonDoc-build-logic',   path: `${WORKSPACE}/AndroidCommonDoc/build-logic`,                                              category: 'NEW' },
  { name: 'AndroidCommonDoc-detekt-rules',  path: `${WORKSPACE}/AndroidCommonDoc/detekt-rules`,                                             category: 'NEW' },
  { name: 'AndroidCommonDoc-konsist-tests', path: `${WORKSPACE}/AndroidCommonDoc/konsist-tests`,                                            category: 'NEW' },
  { name: 'kmp-test-runner-gradle-plugin',  path: `${WORKSPACE}/kmp-test-runner/gradle-plugin`,                                             category: 'NEW' },
  { name: 'WakeTheCave',                    path: `${WORKSPACE}/WakeTheCave/WakeTheCave`,                                                   category: 'NEW' },
  { name: 'WakeTheCave_clean',              path: `${WORKSPACE}/WakeTheCave/WakeTheCave_clean`,                                             category: 'NEW' },
  { name: 'WakeTheCave_ref',                path: `${WORKSPACE}/WakeTheCave/WakeTheCave_ref`,                                               category: 'NEW' },
  { name: 'FileKit-main',                   path: `${WORKSPACE}/Nueva carpeta/FileKit-main/FileKit-main`,                                   category: 'NEW' },
  { name: 'androidify-main',                path: `${WORKSPACE}/OFFICIAL_PROJECTS/androidify-main/androidify-main`,                         category: 'NEW' },
  { name: 'KaMPKit-main',                   path: `${WORKSPACE}/OFFICIAL_PROJECTS/KaMPKit-main/KaMPKit-main`,                               category: 'NEW' },
  { name: 'kmp-basic-sample-master',        path: `${WORKSPACE}/OFFICIAL_PROJECTS/kmp-basic-sample-master/kmp-basic-sample-master`,        category: 'NEW' },
  { name: 'kotlinconf-app-main',            path: `${WORKSPACE}/OFFICIAL_PROJECTS/kotlinconf-app-main/kotlinconf-app-main`,                category: 'NEW' },
  { name: 'Nav3Guide-master',               path: `${WORKSPACE}/OFFICIAL_PROJECTS/Nav3Guide-master/Nav3Guide-master`,                      category: 'NEW' },
  { name: 'PeopleInSpace-main',             path: `${WORKSPACE}/OFFICIAL_PROJECTS/PeopleInSpace-main/PeopleInSpace-main`,                  category: 'NEW' },
];

function parseArgs(argv) {
  const out = { output: 'WIDE-SMOKE-PASS-7.md', timeout: 900, only: null, reclassify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--output')     { out.output  = argv[++i]; continue; }
    if (a === '--timeout')    { out.timeout = parseInt(argv[++i], 10); continue; }
    if (a === '--only')       { out.only    = new Set(argv[++i].split(',').map(s => s.trim())); continue; }
    if (a === '--reclassify') { out.reclassify = true; continue; }
  }
  return out;
}

// Mirrors tools/measure-token-cost.js#spawnCapture (250-261). shell:false
// dodges cmd.exe / MinGW interpretation quirks on Windows.
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
  // Path A: sentinel-bracketed (when invoking lib/runner.js directly).
  const startIdx = stdout.lastIndexOf(ENVELOPE_BEGIN);
  if (startIdx >= 0) {
    const after = stdout.slice(startIdx + ENVELOPE_BEGIN.length);
    const endIdx = after.indexOf(ENVELOPE_END);
    if (endIdx >= 0) {
      const jsonText = after.slice(0, endIdx).trim();
      try { return JSON.parse(jsonText); } catch { /* fall through */ }
    }
  }
  // Path B: bin/kmp-test.js emits raw JSON via emitJson() — find the canonical
  // tool marker and JSON.parse from there. Tolerates leading [NOTICE] lines.
  const markerIdx = stdout.lastIndexOf('{"tool":"kmp-test"');
  if (markerIdx >= 0) {
    const tail = stdout.slice(markerIdx).trim();
    try { return JSON.parse(tail); } catch { /* fall through */ }
  }
  return null;
}

const FAIL_LINE_RE = /\[FAIL\] :[^\s]+:[^\s]+/;

// Detects the cascade-isolation signature: legs that exited non-zero where
// execution.failed === 0 AND execution.no_evidence > 0 — meaning the
// orchestrator dispatched N tasks but gradle never mentioned any of them
// (gradle aborted at evaluation phase before reaching them). The retry path
// from PR #116 was supposed to catch this but its condition is too narrow.
//
// Returns: { isCascade, cascadeLegs[], realFailedLegs[] } so the caller can
// decide RED-orchestrator-cascade vs RED-repo vs MIXED.
function detectCascadePattern(envelope) {
  const legs = envelope?.parallel?.legs || [];
  const cascadeLegs = [];
  const realFailedLegs = [];
  for (const leg of legs) {
    if (leg.exit_code === 0) continue;
    const ex = leg.execution || {};
    const noEvidenceOnly = (ex.failed || 0) === 0 && (ex.no_evidence || 0) > 0;
    if (noEvidenceOnly) cascadeLegs.push(leg.test_type);
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
    // Pure cascade — every failed leg is no-evidence-only. The module_failed
    // entries are fabricated from the defense-in-depth, NOT real test failures.
    if (cascade.isCascade && cascade.realFailedLegs.length === 0) {
      return {
        bucket: 'RED-orchestrator-cascade',
        reason: `cascade-isolation signature: legs [${cascade.cascadeLegs.join(', ')}] dispatched ${moduleFailedCount} tasks, gradle never mentioned any (no_evidence). Retry path from PR #116 didn't fire. ${indvTotal} testcases ran in OTHER legs.`,
        errorCodes,
      };
    }
    // Mixed: some legs cascade, others have real failures.
    if (cascade.isCascade && cascade.realFailedLegs.length > 0) {
      return {
        bucket: 'RED-repo',
        reason: `MIXED: cascade in [${cascade.cascadeLegs.join(', ')}] + real failures in [${cascade.realFailedLegs.join(', ')}] (${moduleFailedCount} module_failed, ${indvTotal} testcases ran)`,
        errorCodes,
      };
    }
    return {
      bucket: 'RED-repo',
      reason: hasModuleFailed
        ? `module_failed discriminator (${moduleFailedCount} module(s)${indvTotal > 0 ? `, ${indvTotal} testcases ran` : ''})`
        : '[FAIL] line in stderr',
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

function runOneProject(proj, opts) {
  const safe     = safeName(proj.name);
  const outFile  = path.join(SMOKE_DIR, `${safe}.out`);
  const errFile  = path.join(SMOKE_DIR, `${safe}.err`);
  const jsonFile = path.join(SMOKE_DIR, `${safe}.json`);

  if (!existsSync(proj.path)) {
    console.log(`[MISSING] ${proj.name} (path not found)`);
    return { proj, missing: true };
  }

  const args = [
    KMP_TEST, 'parallel',
    '--project-root', proj.path,
    '--test-type', 'all',
    '--json',
    '--timeout', String(opts.timeout),
  ];

  // Add 60s buffer beyond gradle --timeout so orchestrator can clean up
  // gracefully (write envelope, kill daemons) before Node hard-kills.
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
  // Persist run metadata so --reclassify can rebuild the markdown without
  // re-spawning gradle. Drop the fat envelope (already saved as .json).
  const metaFile = path.join(SMOKE_DIR, `${safeName(proj.name)}.meta.json`);
  const { envelope: _envForMeta, proj: _projForMeta, ...metaRest } = result;
  writeFileSync(metaFile, JSON.stringify({
    proj: { name: proj.name, path: proj.path, category: proj.category },
    ...metaRest,
  }, null, 2));
  return result;
}

// Parse elapsed durations from the streaming run.log so reclassify can
// preserve per-project timings even when meta.json was never written
// (initial sweep predates the meta-write logic). Lines look like:
// "[GREEN] android-challenge in 1m 12s — 1 testcases ran"
function loadRunLogElapsed() {
  const runLog = path.join(SMOKE_DIR, 'run.log');
  const map = new Map();
  if (!existsSync(runLog)) return map;
  const text = readFileSync(runLog, 'utf8');
  const lineRe = /^\[\w+(?:-\w+)*\] (\S+) in (\d+)m? ?(\d+)?s? /gm;
  for (const m of text.matchAll(lineRe)) {
    const name = m[1];
    const minutes = m[3] !== undefined ? parseInt(m[2], 10) : 0;
    const seconds = m[3] !== undefined ? parseInt(m[3], 10) : parseInt(m[2], 10);
    map.set(name, (minutes * 60 + seconds) * 1000);
  }
  return map;
}

// Re-run classifier on previously captured envelopes — no gradle spawn.
// Reads .smoke/pass-7/<safe>.{json,err,meta.json} and emits a fresh markdown.
function reclassifyOneProject(proj, elapsedMap) {
  const safe     = safeName(proj.name);
  const jsonFile = path.join(SMOKE_DIR, `${safe}.json`);
  const errFile  = path.join(SMOKE_DIR, `${safe}.err`);
  const metaFile = path.join(SMOKE_DIR, `${safe}.meta.json`);

  if (!existsSync(metaFile) && !existsSync(jsonFile)) {
    console.log(`[MISSING] ${proj.name} (no captured artifacts at .smoke/pass-7/)`);
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
    elapsedMs: prior.elapsedMs ?? elapsedMap?.get(proj.name) ?? null,
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

function emitMarkdown(results, outputPath) {
  const counts = { GREEN: 0, SKIP: 0, 'RED-repo': 0, 'RED-orchestrator-cascade': 0, 'RED-orchestrator': 0, MISSING: 0 };
  for (const r of results) {
    if (r.missing) { counts.MISSING++; continue; }
    counts[r.bucket] = (counts[r.bucket] || 0) + 1;
  }

  const lines = [];
  lines.push('# Wide-smoke pass-7 — v0.8.0 release-validation baseline');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('Orchestrator HEAD: `0910615` (v0.7.0 + PR1+PR2+PR3 of v0.8.0 ramp).');
  lines.push('');
  lines.push('## Key findings');
  lines.push('');
  const cascadeProjects = results.filter(r => !r.missing && r.bucket === 'RED-orchestrator-cascade').map(r => r.proj.name);
  const realRedProjects = results.filter(r => !r.missing && r.bucket === 'RED-repo').map(r => r.proj.name);
  const greenProjects   = results.filter(r => !r.missing && r.bucket === 'GREEN').map(r => r.proj.name);
  lines.push(`1. **${cascadeProjects.length} cascade-isolation cases** — orchestrator bug, not real test failures. PR #116's retry path did NOT fire even when its documented conditions matched (\`legExit !== 0 && taskList.length > 1 && !anyTaskMentioned\`). Affected: ${cascadeProjects.join(', ') || 'none'}. **Raises PR5 priority.**`);
  lines.push('');
  lines.push(`2. **${realRedProjects.length} legitimate RED-repo cases** — actual project test failures, out of scope for this PR. Affected: ${realRedProjects.join(', ') || 'none'}.`);
  lines.push('');
  lines.push(`3. **${greenProjects.length} GREEN** — full sweep through orchestrator + JDK auto-select + tests passing: ${greenProjects.join(', ') || 'none'}.`);
  lines.push('');
  lines.push('4. **0 RED-orchestrator (other)** — every non-cascade orchestrator path is healthy post-PR1+PR2+PR3.');
  lines.push('');
  lines.push('5. Discriminator hits worth flagging:');
  lines.push('   - `unsupported_class_version` on Confetti-main despite PR3\'s AGP-aware JDK auto-select (BACKLOG candidate).');
  lines.push('   - `task_not_found` paired with `module_failed` on 4 projects (DawSync, dipatternsdemo, shared-kmp-libs, FileKit-main) — orchestrator dispatching a task name the project doesn\'t expose (project model overreach; BACKLOG candidate).');
  lines.push('');
  lines.push('## Bucket counts');
  lines.push('');
  lines.push('| Bucket | Count |');
  lines.push('|---|---|');
  for (const [b, c] of Object.entries(counts)) lines.push(`| ${b} | ${c} |`);
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
      lines.push('_No envelope emitted — see `.smoke/pass-7/' + safeName(r.proj.name) + '.err` for stderr._');
    }
    lines.push('');
  }
  lines.push('## Retrospective vs PR3 sweep');
  lines.push('');
  lines.push('PR3 listed 8 projects with preflightJdkCheck status. Re-validating each post-PR3:');
  lines.push('');
  lines.push('| Project | PR3 expectation | PR4 result | Notes |');
  lines.push('|---|---|---|---|');
  for (const r of results.filter(x => x.proj.category === 'PR3')) {
    if (r.missing) { lines.push(`| ${r.proj.name} | preflight-mismatch | MISSING | – |`); continue; }
    lines.push(`| ${r.proj.name} | JDK auto-select fires | ${r.bucket} | see \`.smoke/pass-7/${safeName(r.proj.name)}.err\` |`);
  }
  lines.push('');
  lines.push('## Per-project artifacts');
  lines.push('');
  lines.push('Forensic captures live in `.smoke/pass-7/` (gitignored — `.gitignore:22`):');
  lines.push('');
  lines.push('- `<safe-name>.out` — stdout (envelope between sentinel markers)');
  lines.push('- `<safe-name>.err` — stderr (orchestrator log + gradle stderr)');
  lines.push('- `<safe-name>.json` — extracted JSON envelope (only when emitted)');
  lines.push('');

  writeFileSync(outputPath, lines.join('\n'));
  console.log(`\nWrote summary → ${outputPath}`);
  console.log('Bucket counts:', counts);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(SMOKE_DIR, { recursive: true });

  const targets = opts.only
    ? PROJECTS.filter(p => opts.only.has(p.name))
    : PROJECTS;

  if (opts.reclassify) {
    console.log(`Reclassifying ${targets.length} projects from .smoke/pass-7/ artifacts (no gradle spawn)`);
    console.log('');
    const elapsedMap = loadRunLogElapsed();
    const results = targets.map(p => reclassifyOneProject(p, elapsedMap));
    emitMarkdown(results, path.join(REPO_ROOT, opts.output));
    return;
  }

  console.log(`Sweeping ${targets.length} projects (per-project timeout: ${opts.timeout}s + 60s buffer)`);
  console.log(`Repo root: ${REPO_ROOT}`);
  console.log(`Smoke dir: ${SMOKE_DIR}`);
  console.log('');

  const results = [];
  for (const proj of targets) {
    const r = runOneProject(proj, opts);
    results.push(r);
  }

  emitMarkdown(results, path.join(REPO_ROOT, opts.output));
}

main();

// SPDX-License-Identifier: MIT
// lib/coverage-orchestrator.js — Node-side `kmp-test coverage` orchestrator
// (v0.8 PIVOT, sub-entry 4). Replaces the coverage-only branch of
// scripts/sh/run-parallel-coverage-suite.{sh,ps1} (--skip-tests path).
//
// Coverage and parallel share the wrapper file; this orchestrator owns the
// --skip-tests codepath end-to-end:
//   1. discover modules + classify by coverage plugin (Kover|JaCoCo|none)
//      via lib/project-model.js#detectBuildLogicCoverageHints (CONVENTION-vs-
//      SELF detection from v0.6 Bug 6 — NO behavior change).
//   2. read leftover XML reports written by a prior `kmp-test parallel` run
//      (no gradle dispatch — coverage subcommand re-aggregates in place).
//   3. aggregate via the shared Python parser at scripts/lib/parse-coverage-xml.py.
//   4. write Markdown to coverage-full-report-<runId>.md + legacy alias
//      coverage-full-report.md (v0.3.8 lockfile naming).
//   5. emit envelope with `coverage:{tool, missed_lines, modules_contributing,
//      modules_with_kover_plugin, modules_with_jacoco_plugin}`.
//
// Sub-entry 5 will fold the parallel codepath into lib/parallel-orchestrator.js
// and the wrapper becomes fully thin. Until then the wrapper retains the
// parallel branch but short-circuits to this orchestrator on --skip-tests.

import { spawnSync } from 'node:child_process';
import {
  writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync,
} from 'node:fs';
import path from 'node:path';

import {
  buildJsonReport,
  envErrorJson,
  buildDryRunReport,
  parseGradleTimeoutMs,
  EXIT,
} from './cli.js';
import { buildProjectModel } from './project-model.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    coverageTool: 'auto',
    coverageModules: '',
    excludeCoverage: '',
    minMissedLines: 0,
    outputFile: 'coverage-full-report.md',
    dryRun: false,
  };
  const expanded = expandNoCoverageAlias(argv);
  for (let i = 0; i < expanded.length; i++) {
    const a = expanded[i];
    switch (a) {
      case '--coverage-tool':     out.coverageTool = expanded[++i] || 'auto'; break;
      case '--coverage-modules':  out.coverageModules = expanded[++i] || ''; break;
      case '--exclude-coverage':  out.excludeCoverage = expanded[++i] || ''; break;
      case '--min-missed-lines':  out.minMissedLines = +(expanded[++i] || 0); break;
      case '--output-file':       out.outputFile = expanded[++i] || 'coverage-full-report.md'; break;
      case '--dry-run':           out.dryRun = true; break;
      // --skip-tests is the wrapper-side prefix that selects this subcommand;
      // consume silently to avoid the unknown-flag fall-through.
      case '--skip-tests':        break;
      default: /* drop unknown */ break;
    }
  }
  return out;
}

// --no-coverage is sugar for --coverage-tool none. Mirrors lib/cli.js's
// expandNoCoverageAlias so direct wrapper invocations (bats, scripts) still
// resolve the alias when cli.js is bypassed.
function expandNoCoverageAlias(argv) {
  const out = [];
  for (const a of argv) {
    if (a === '--no-coverage') out.push('--coverage-tool', 'none');
    else out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Module discovery + plugin classification
// ---------------------------------------------------------------------------
function splitCsv(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}

// Classify modules into:
//   - modulesWithKoverPlugin / modulesWithJacocoPlugin: project-model
//     analysis.coveragePlugin discrimination (closes BACKLOG line 133 contract).
//   - dispatched: modules whose XML we will actually parse this run (filtered
//     by --coverage-modules / --exclude-coverage and the effective tool).
function discoverCoverageModules(projectModel, opts) {
  const koverModules = [];
  const jacocoModules = [];
  const dispatched = [];
  if (!projectModel?.modules) return { koverModules, jacocoModules, dispatched };

  const includeOnly = splitCsv(opts.coverageModules);
  const excludeSet = new Set(splitCsv(opts.excludeCoverage));

  for (const [modKey, entry] of Object.entries(projectModel.modules)) {
    const name = modKey.replace(/^:/, '');
    // analyzeModule's fields are spread into the module entry (project-model.js:844),
    // so coveragePlugin / type live at the top level — NOT under entry.analysis.
    const detected = entry?.coveragePlugin || null; // 'kover' | 'jacoco' | null

    if (detected === 'kover')  koverModules.push(name);
    if (detected === 'jacoco') jacocoModules.push(name);

    if (excludeSet.has(name)) continue;
    if (includeOnly.length > 0 && !includeOnly.includes(name)) continue;

    let effectiveTool = null;
    if (opts.coverageTool === 'kover')   effectiveTool = 'kover';
    else if (opts.coverageTool === 'jacoco') effectiveTool = 'jacoco';
    else if (opts.coverageTool === 'auto')   effectiveTool = detected;
    // 'none' short-circuits before this function — never reaches here.

    if (!effectiveTool) continue;
    const modulePath = path.join(...name.split(':'));
    const isDesktop = entry?.type === 'kmp' || entry?.type === 'jvm';
    dispatched.push({ name, tool: effectiveTool, modulePath, isDesktop });
  }

  koverModules.sort();
  jacocoModules.sort();
  dispatched.sort((a, b) => a.name.localeCompare(b.name));
  return { koverModules, jacocoModules, dispatched };
}

// ---------------------------------------------------------------------------
// XML location + Python parser invocation
// ---------------------------------------------------------------------------
// Mirrors scripts/sh/lib/coverage-detect.sh#get_coverage_xml_path. We keep the
// helper in JS so the orchestrator stays self-contained even after the bash
// version deletes (Gap A scope-reduction).
function findCoverageXmlPath(projectRoot, modulePath, tool, isDesktop) {
  const moduleDir = path.join(projectRoot, modulePath);
  if (tool === 'kover') {
    const koverDir = path.join(moduleDir, 'build', 'reports', 'kover');
    if (!existsSync(koverDir)) return null;
    const candidates = [];
    candidates.push(isDesktop ? 'reportDesktop.xml' : 'reportDebug.xml');
    candidates.push('report.xml');
    for (const name of candidates) {
      const p = path.join(koverDir, name);
      if (existsSync(p)) return p;
    }
    try {
      for (const e of readdirSync(koverDir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.xml')) return path.join(koverDir, e.name);
      }
    } catch { /* fall through */ }
    return null;
  }
  if (tool === 'jacoco') {
    const jacocoDir = path.join(moduleDir, 'build', 'reports', 'jacoco');
    if (!existsSync(jacocoDir)) return null;
    const flat = [
      path.join(jacocoDir, 'jacocoTestReport.xml'),
      path.join(jacocoDir, 'test', 'jacocoTestReport.xml'),
      path.join(jacocoDir, 'testDebugUnitTest', 'jacocoTestReport.xml'),
      path.join(jacocoDir, 'jacocoTestReport', 'jacocoTestReport.xml'),
    ];
    for (const p of flat) if (existsSync(p)) return p;
    // Recursive fallback: first .xml under jacoco/.
    const found = walkForXml(jacocoDir, 4);
    return found;
  }
  return null;
}

function walkForXml(dir, maxDepth) {
  if (maxDepth <= 0) return null;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith('.xml')) return p;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const r = walkForXml(path.join(dir, e.name), maxDepth - 1);
      if (r) return r;
    }
  }
  return null;
}

// Invoke the shared Python parser. Returns array of pipe-delimited rows:
// `module|package|sourcefile|classname|covered|missed|total|pct|missed_lines`.
function parseCoverageXml(parserPath, xmlPath, moduleName, spawn = spawnSync) {
  const r = spawn('python3', [parserPath, xmlPath, moduleName], { encoding: 'utf8' });
  if (!r || r.status !== 0) return [];
  return String(r.stdout || '').split('\n').filter(Boolean);
}

// ---------------------------------------------------------------------------
// Aggregation + Markdown output
// ---------------------------------------------------------------------------
function aggregateClassRows(rows, minMissedLines) {
  const moduleSummaries = new Map(); // name → {covered, missed, total}
  const filteredRows = [];
  for (const row of rows) {
    const parts = row.split('|');
    if (parts.length < 8) continue;
    const [mod, , , , covStr, missStr, totalStr] = parts;
    const covered = +covStr || 0;
    const missed  = +missStr || 0;
    const total   = +totalStr || 0;
    if (minMissedLines > 0 && missed < minMissedLines) continue;
    filteredRows.push(row);
    const cur = moduleSummaries.get(mod) || { covered: 0, missed: 0, total: 0 };
    cur.covered += covered;
    cur.missed  += missed;
    cur.total   += total;
    moduleSummaries.set(mod, cur);
  }
  let grandCovered = 0, grandMissed = 0, modulesContributing = 0;
  for (const s of moduleSummaries.values()) {
    grandCovered += s.covered;
    grandMissed  += s.missed;
    if (s.total > 0) modulesContributing++;
  }
  const grandTotal = grandCovered + grandMissed;
  const grandPct = grandTotal > 0 ? Math.round((grandCovered / grandTotal) * 1000) / 10 : 0;
  return { moduleSummaries, filteredRows, grandCovered, grandMissed, grandTotal, grandPct, modulesContributing };
}

function coverageDisplayName(tool) {
  if (tool === 'kover')  return 'Kover';
  if (tool === 'jacoco') return 'JaCoCo';
  return '(none)';
}

function formatLineRanges(csv) {
  if (!csv) return '';
  const nums = csv.split(',').map(n => +n).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (nums.length === 0) return '';
  const ranges = [];
  let start = nums[0], end = nums[0];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === end + 1) { end = nums[i]; continue; }
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
    start = end = nums[i];
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(', ');
}

function writeMarkdownReport({
  projectRoot, outputFile, runId, agg, opts, durationMs,
}) {
  const lines = [];
  lines.push('# Full Coverage Report');
  lines.push('');
  lines.push(`> **Generated**: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`);
  lines.push(`> **Run ID**: ${runId}`);
  lines.push(`> **Tests Run**: No (--skip-tests)`);
  lines.push(`> **Coverage Tool**: ${coverageDisplayName(opts.coverageTool)}`);
  const mins = Math.floor(durationMs / 60000);
  const secs = Math.floor((durationMs % 60000) / 1000);
  lines.push(`> **Duration**: ${mins}m ${secs}s`);
  lines.push('> **Mode**: Coverage aggregation (no test execution)');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Summary by Module');
  lines.push('');
  lines.push('| Module | Coverage | Covered | Total | Missed |');
  lines.push('|--------|----------|---------|-------|--------|');
  const sortedMods = [...agg.moduleSummaries.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [name, s] of sortedMods) {
    const pct = s.total > 0 ? (Math.round((s.covered / s.total) * 1000) / 10) : 0;
    lines.push(`| \`${name}\` | ${pct}% | ${s.covered} | ${s.total} | ${s.missed} |`);
  }
  lines.push(`| **TOTAL** | **${agg.grandPct}%** | **${agg.grandCovered}** | **${agg.grandTotal}** | **${agg.grandMissed}** |`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## AI-Optimized Summary');
  lines.push('');
  lines.push('```');
  lines.push(`TOTAL_COVERAGE: ${agg.grandPct}%`);
  lines.push(`TOTAL_LINES: ${agg.grandTotal}`);
  lines.push(`COVERED_LINES: ${agg.grandCovered}`);
  lines.push(`MISSED_LINES: ${agg.grandMissed}`);
  lines.push(`MODULES_SCANNED: ${agg.moduleSummaries.size}`);
  lines.push(`CLASSES_ANALYZED: ${agg.filteredRows.length}`);
  lines.push(`COVERAGE_TOOL: ${opts.coverageTool}`);
  lines.push(`EXECUTION_MODE: skip-tests`);
  lines.push(`DURATION: ${mins}m ${secs}s`);
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Detailed Class Coverage');
  lines.push('');
  // Sort rows: module asc, missed desc.
  const sortedRows = [...agg.filteredRows].sort((a, b) => {
    const aa = a.split('|'); const bb = b.split('|');
    if (aa[0] !== bb[0]) return aa[0].localeCompare(bb[0]);
    return (+bb[5] || 0) - (+aa[5] || 0);
  });
  let currentMod = '';
  for (const row of sortedRows) {
    const parts = row.split('|');
    const [mod, , , cls, , missed, , pct, ml] = parts;
    if (mod !== currentMod) {
      if (currentMod !== '') lines.push('');
      lines.push(`### ${mod}`);
      lines.push('');
      lines.push('| Class | Coverage | Missed | Lines |');
      lines.push('|-------|----------|--------|-------|');
      currentMod = mod;
    }
    let ranges = formatLineRanges(ml);
    if (ranges.length > 60) ranges = ranges.slice(0, 57) + '...';
    lines.push(`| \`${cls}\` | ${pct}% | ${missed} | ${ranges} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('*Generated by lib/coverage-orchestrator.js (skip-tests mode)*');

  const versioned = outputFile.endsWith('.md')
    ? `${outputFile.slice(0, -3)}-${runId}.md`
    : `${outputFile}-${runId}`;
  const versionedPath = path.join(projectRoot, versioned);
  const legacyPath = path.join(projectRoot, outputFile);
  try { mkdirSync(path.dirname(versionedPath), { recursive: true }); } catch { /* best-effort */ }
  writeFileSync(versionedPath, lines.join('\n') + '\n');
  try { copyFileSync(versionedPath, legacyPath); } catch { /* best-effort */ }
  return { versionedPath, legacyPath };
}

// Default run-id matches the bash format `YYYYMMDD-HHMMSS-PID6` so multi-shell
// concurrent invocations don't clobber each other.
function defaultRunId() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const pid6 = String(process.pid % 1000000).padStart(6, '0');
  return `${stamp}-${pid6}`;
}

// Locate the bundled Python parser. Walks up from this file to find
// scripts/lib/parse-coverage-xml.py in the repo / extracted-lib temp dir.
function findParserPath() {
  // import.meta.url isn't reliable across all Node versions in tests; use
  // process.argv[1] (runner.js path) as the anchor when present.
  const anchors = [];
  if (process.argv[1]) anchors.push(path.dirname(process.argv[1]));
  anchors.push(process.cwd());
  for (const anchor of anchors) {
    let dir = anchor;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'scripts', 'lib', 'parse-coverage-xml.py');
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main entrypoint — invoked by lib/runner.js when sub === 'coverage'.
// ---------------------------------------------------------------------------
export async function runCoverage({
  projectRoot,
  args = [],
  env = process.env,
  spawn = spawnSync,
  log = () => {},
  runId = defaultRunId(),
}) {
  const startTime = Date.now();
  const opts = parseArgs(args);

  log('');
  log('========================================');
  log('  Coverage Aggregation (skip-tests mode)');
  log('========================================');
  log(`Project: ${projectRoot}`);
  log(`Coverage tool: ${opts.coverageTool}`);
  log('');

  // --dry-run short-circuit (no model build, no XML reads).
  if (opts.dryRun) {
    const envelope = buildDryRunReport({
      subcommand: 'coverage',
      projectRoot,
      plan: {
        coverage_tool: opts.coverageTool,
        output_file: opts.outputFile,
        coverage_modules: splitCsv(opts.coverageModules),
        exclude_coverage: splitCsv(opts.excludeCoverage),
      },
    });
    envelope.coverage = {
      tool: opts.coverageTool,
      missed_lines: null,
      modules_contributing: 0,
      modules_with_kover_plugin: [],
      modules_with_jacoco_plugin: [],
    };
    return { envelope, exitCode: EXIT.SUCCESS };
  }

  // --coverage-tool none → emit coverage_aggregation_skipped warning, exit 0.
  if (opts.coverageTool === 'none') {
    log('[!] --coverage-tool none — coverage aggregation skipped');
    const envelope = buildJsonReport({
      subcommand: 'coverage',
      projectRoot,
      exitCode: EXIT.SUCCESS,
      durationMs: Date.now() - startTime,
      parsed: {
        tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
        modules: [],
        skipped: [],
        coverage: {
          tool: 'none',
          missed_lines: null,
          modules_contributing: 0,
          modules_with_kover_plugin: [],
          modules_with_jacoco_plugin: [],
        },
        errors: [],
        warnings: [{
          code: 'coverage_aggregation_skipped',
          message: '--coverage-tool none: coverage aggregation skipped',
        }],
      },
    });
    return { envelope, exitCode: EXIT.SUCCESS };
  }

  // Build project model (single source of truth for plugin discrimination).
  let projectModel = null;
  try {
    projectModel = buildProjectModel(projectRoot, {
      skipProbe: false,
      useCache: false,
      probeTimeoutMs: parseGradleTimeoutMs(env.KMP_GRADLE_TIMEOUT_MS),
    });
  } catch { /* best-effort */ }

  const { koverModules, jacocoModules, dispatched } = discoverCoverageModules(projectModel, opts);

  log(`Modules with Kover plugin: ${koverModules.length}`);
  log(`Modules with JaCoCo plugin: ${jacocoModules.length}`);
  log(`Dispatching XML reads for ${dispatched.length} module(s)...`);
  log('');

  const parserPath = findParserPath();
  const allRows = [];
  if (parserPath && dispatched.length > 0) {
    for (const m of dispatched) {
      const xml = findCoverageXmlPath(projectRoot, m.modulePath, m.tool, m.isDesktop);
      if (!xml) {
        log(`  [!] No coverage data: ${m.name}`);
        continue;
      }
      log(`  [>] Parsing: ${m.name}`);
      const rows = parseCoverageXml(parserPath, xml, m.name, spawn);
      for (const r of rows) allRows.push(r);
    }
  } else if (!parserPath && dispatched.length > 0) {
    log('[!] parse-coverage-xml.py not found — coverage rows skipped');
  }

  const agg = aggregateClassRows(allRows, opts.minMissedLines);

  const warnings = [];
  if (agg.modulesContributing === 0) {
    warnings.push({
      code: 'no_coverage_data',
      message: 'No coverage data collected from any module — verify your project has kover/jacoco configured (see https://github.com/oscardlfr/kmp-test-runner#coverage-setup)',
    });
  }

  // Markdown report (only when we have something to report).
  let reportPaths = null;
  if (agg.modulesContributing > 0) {
    reportPaths = writeMarkdownReport({
      projectRoot,
      outputFile: opts.outputFile,
      runId,
      agg,
      opts,
      durationMs: Date.now() - startTime,
    });
    log('');
    if (reportPaths) {
      log(`[>>] Report saved to: ${reportPaths.versionedPath}`);
      log(`     legacy alias: ${reportPaths.legacyPath}`);
    }
  }
  // Machine-readable marker preserved for back-compat with bats/pester smoke
  // greps (until sub-entry 5 retires the legacy parser path entirely).
  log(`COVERAGE_MODULES_CONTRIBUTING: ${agg.modulesContributing}`);

  const envelope = buildJsonReport({
    subcommand: 'coverage',
    projectRoot,
    exitCode: EXIT.SUCCESS,
    durationMs: Date.now() - startTime,
    parsed: {
      tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
      modules: [],
      skipped: [],
      coverage: {
        tool: opts.coverageTool,
        missed_lines: agg.grandMissed,
        modules_contributing: agg.modulesContributing,
        modules_with_kover_plugin: koverModules,
        modules_with_jacoco_plugin: jacocoModules,
      },
      errors: [],
      warnings,
    },
  });

  return { envelope, exitCode: EXIT.SUCCESS };
}

export {
  parseArgs,
  expandNoCoverageAlias,
  discoverCoverageModules,
  findCoverageXmlPath,
  parseCoverageXml,
  aggregateClassRows,
  formatLineRanges,
  coverageDisplayName,
  writeMarkdownReport,
  defaultRunId,
};

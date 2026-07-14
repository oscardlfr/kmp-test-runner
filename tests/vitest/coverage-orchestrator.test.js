// SPDX-License-Identifier: MIT
// Tests for lib/coverage-orchestrator.js — v0.8 STRATEGIC PIVOT, sub-entry 4.
//
// Migrates the --skip-tests codepath of run-parallel-coverage-suite.{sh,ps1}
// to Node. The orchestrator parses leftover Kover/JaCoCo XML reports left
// by a prior `kmp-test parallel` run and aggregates them; it does NOT spawn
// gradle. Plugin discrimination consumes lib/project-model.js#detectBuildLogic
// CoverageHints (CONVENTION-vs-SELF detection from v0.6 Bug 6) — NO behavior
// change.
//
// Test surface (acceptance rubric: BACKLOG.md Sub-entry 4):
//   1. Kover-only project → modules_with_kover_plugin populated
//   2. JaCoCo-only project → modules_with_jacoco_plugin populated
//   3. Mixed Kover + JaCoCo → both arrays partition correctly
//   4. --coverage-tool none → coverage_aggregation_skipped warning, exit 0
//   5. --no-coverage alias → same effect as --coverage-tool none
//   6. No coverage plugins detected → no_coverage_data warning, exit 0
//   7. --dry-run → dry_run:true plus plan section, no fs writes
//   8. --exclude-coverage <m> → m drops from dispatched but stays in
//      modules_with_*_plugin (project-shape signal preserved)
//   9. --coverage-modules <m> → only m dispatched
//  10. parseArgs handles all coverage flags
//  11. expandNoCoverageAlias substitutes correctly
//  12. Parser injection seam — coverage-xml.js parser is invoked in-process
//      as a plain function `(xmlPath, moduleName)`, no subprocess involved
//
// PR-17 additions (coverage-orchestrator.js's own share of the fix — the
// Node parser module itself is tested independently in coverage-xml.test.js):
//   - aggregateClassRows / modules_contributing are always unfiltered by
//     --min-missed-lines; the row-filter narrows only the markdown report's
//     detail section (see "PR-17 — threshold/aggregation integrity" below)
//   - coverage_xml_oversized / coverage_parse_failed discriminated warnings
//   - coverage_report_write_failed is covered in a separate isolated file
//     (coverage-orchestrator-report-write-failure.test.js) since it needs
//     its own node:fs mock scoped away from the ~60 tests in this file

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  runCoverage,
  parseArgs,
  expandNoCoverageAlias,
  discoverCoverageModules,
  findCoverageXmlPath,
  aggregateClassRows,
  formatLineRanges,
  coverageToolLabel,
} from '../../lib/orchestrators/coverage-orchestrator.js';

let workDir;

afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

// Build a project with modules each annotated with a coverage plugin shape.
// `coverage` ∈ {undefined, 'kover', 'jacoco'} — controls the plugin block in
// the module's build.gradle.kts, which analyzeModule reads for coveragePlugin.
function makeProject(modules, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmp-coverage-test-'));
  workDir = dir;
  const includes = modules.map(m => `include(":${m.name}")`).join('\n');
  writeFileSync(path.join(dir, 'settings.gradle.kts'),
    `rootProject.name = "${opts.rootName ?? 'fixture'}"\n${includes}\n`);
  writeFileSync(path.join(dir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(path.join(dir, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
  for (const mod of modules) {
    const modDir = path.join(dir, ...mod.name.split(':'));
    mkdirSync(modDir, { recursive: true });
    let plugins = '';
    if (mod.coverage === 'kover') {
      plugins = 'plugins {\n  id("org.jetbrains.kotlinx.kover")\n  kotlin("jvm")\n}\n';
    } else if (mod.coverage === 'jacoco') {
      plugins = 'plugins {\n  jacoco\n  kotlin("jvm")\n}\n';
    } else {
      plugins = 'plugins {\n  kotlin("jvm")\n}\n';
    }
    writeFileSync(path.join(modDir, 'build.gradle.kts'), plugins);
  }
  return dir;
}

// Stub for the injected `parseCoverageXml` parser function — matches
// lib/parsers/coverage-xml.js's contract exactly: `(xmlPath, moduleName) =>
// {rows, errored, reason, message}`. Returns canned rows keyed by module
// name. No subprocess is involved (PR-17 replaced the python3 spawn with an
// in-process Node parser), so the stub is a plain function, not a spawn
// shim — `status !== 0` models a parser failure the same way the real
// module's `errored:true` does.
function makeParseCoverageStub({ rowsByModule = {}, status = 0, reason = null } = {}) {
  const calls = [];
  const fn = (xmlPath, moduleName) => {
    calls.push({ xmlPath, moduleName });
    if (status !== 0) {
      return { rows: [], errored: true, reason: reason || 'parse_failed', message: 'stub failure' };
    }
    const rows = rowsByModule[moduleName] ?? [];
    return { rows, errored: false, reason: 'ok', message: null };
  };
  fn.calls = calls;
  return fn;
}

// Drop a leftover XML at the expected Kover/JaCoCo location so findCoverageXml
// returns a non-null path. Content doesn't matter — the stub returns canned
// rows regardless of what's on disk.
function dropFakeXml(projectRoot, moduleName, tool) {
  const modDir = path.join(projectRoot, ...moduleName.split(':'));
  let xmlDir, xmlFile;
  if (tool === 'kover') {
    xmlDir = path.join(modDir, 'build', 'reports', 'kover');
    xmlFile = path.join(xmlDir, 'report.xml');
  } else {
    xmlDir = path.join(modDir, 'build', 'reports', 'jacoco');
    xmlFile = path.join(xmlDir, 'jacocoTestReport.xml');
  }
  mkdirSync(xmlDir, { recursive: true });
  writeFileSync(xmlFile, '<report></report>');
  return xmlFile;
}

// ---------------------------------------------------------------------------
// Pure-function helpers
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('extracts all coverage flags with defaults', () => {
    const opts = parseArgs([]);
    expect(opts.coverageTool).toBe('auto');
    expect(opts.coverageModules).toBe('');
    expect(opts.excludeCoverage).toBe('');
    expect(opts.minMissedLines).toBe(0);
    expect(opts.outputFile).toBe('coverage-full-report.md');
    expect(opts.dryRun).toBe(false);
  });

  it('reads explicit flag values', () => {
    const opts = parseArgs([
      '--coverage-tool', 'kover',
      '--coverage-modules', 'a,b',
      '--exclude-coverage', 'c',
      '--min-missed-lines', '5',
      '--output-file', 'custom.md',
      '--dry-run',
    ]);
    expect(opts.coverageTool).toBe('kover');
    expect(opts.coverageModules).toBe('a,b');
    expect(opts.excludeCoverage).toBe('c');
    expect(opts.minMissedLines).toBe(5);
    expect(opts.outputFile).toBe('custom.md');
    expect(opts.dryRun).toBe(true);
  });

  it('expands --no-coverage to --coverage-tool none', () => {
    const opts = parseArgs(['--no-coverage']);
    expect(opts.coverageTool).toBe('none');
  });

  it('silently consumes --skip-tests prefix', () => {
    // The wrapper passes --skip-tests through to runner.js → orchestrator;
    // parseArgs must drop it without crashing.
    const opts = parseArgs(['--skip-tests', '--coverage-tool', 'jacoco']);
    expect(opts.coverageTool).toBe('jacoco');
  });

  it('emits unknown_flag for unrecognised --flags (regression: was silent drop)', () => {
    const opts = parseArgs(['--no-such-coverage-flag']);
    expect(opts.errors.some(e => e.code === 'unknown_flag' && e.flag === '--no-such-coverage-flag'))
      .toBe(true);
  });

  it('does NOT emit unknown_flag for positionals or single-dash tokens', () => {
    const opts = parseArgs(['positional', '-Pfoo=bar']);
    expect(opts.errors.filter(e => e.code === 'unknown_flag')).toHaveLength(0);
  });
});

describe('expandNoCoverageAlias', () => {
  it('substitutes --no-coverage → --coverage-tool none', () => {
    expect(expandNoCoverageAlias(['--no-coverage'])).toEqual(['--coverage-tool', 'none']);
  });
  it('passes through other flags untouched', () => {
    expect(expandNoCoverageAlias(['--project-root', '/x', '--no-coverage', '--json']))
      .toEqual(['--project-root', '/x', '--coverage-tool', 'none', '--json']);
  });
  // Wet audit 2026-05-08 (cell I1c): the parser switch matches whole tokens,
  // so `--coverage-tool=kover` was silently dropped. expandNoCoverageAlias
  // splits `--flag=value` into `[--flag, value]` so both forms work.
  it('splits POSIX-style --flag=value into separate tokens', () => {
    expect(expandNoCoverageAlias(['--coverage-tool=kover']))
      .toEqual(['--coverage-tool', 'kover']);
  });
  it('splits only on the FIRST = (preserves = inside the value)', () => {
    expect(expandNoCoverageAlias(['--gradle-args=-Pfoo=bar']))
      .toEqual(['--gradle-args', '-Pfoo=bar']);
  });
  it('does not split short flags or non-flag tokens', () => {
    expect(expandNoCoverageAlias(['-Pfoo=bar', 'value=raw']))
      .toEqual(['-Pfoo=bar', 'value=raw']);
  });
  it('parseArgs accepts --coverage-tool=kover (= form)', () => {
    const opts = parseArgs(['--coverage-tool=kover']);
    expect(opts.coverageTool).toBe('kover');
  });
});

describe('aggregateClassRows', () => {
  it('partitions rows by module and totals correctly', () => {
    const rows = [
      'mod-a|pkg|src.kt|Cls|10|2|12|83.3|3,5',
      'mod-a|pkg|src2.kt|Cls2|5|5|10|50.0|6,7,8,9,10',
      'mod-b|pkg|src.kt|Cls|0|10|10|0|1,2,3,4,5,6,7,8,9,10',
    ];
    const agg = aggregateClassRows(rows, 0);
    expect(agg.modulesContributing).toBe(2);
    expect(agg.grandCovered).toBe(15);
    expect(agg.grandMissed).toBe(17);
    expect(agg.grandTotal).toBe(32);
    expect(agg.moduleSummaries.get('mod-a')).toEqual({ covered: 15, missed: 7, total: 22 });
    expect(agg.moduleSummaries.get('mod-b')).toEqual({ covered: 0, missed: 10, total: 10 });
  });

  it('filters rows below minMissedLines threshold', () => {
    const rows = [
      'mod-a|pkg|src.kt|Cls|10|2|12|83.3|3,5',
      'mod-a|pkg|src2.kt|Cls2|5|10|15|33.3|6,7,8,9',
    ];
    const agg = aggregateClassRows(rows, 5);
    expect(agg.filteredRows).toHaveLength(1);
    expect(agg.filteredRows[0]).toContain('Cls2');
  });

  // PR-17 — grand totals / modulesContributing must reflect the project's
  // full coverage even when a row-filter is in effect. Pre-fix, moduleSummaries
  // (and everything derived from it) was only updated INSIDE the row-filter
  // branch, so a threshold that starved every row falsely zeroed
  // modulesContributing and fired a contradictory no_coverage_data warning
  // even when the project's real coverage was non-zero. filteredRows remains
  // the one deliberately-filtered field (markdown detail section only).
  it('grand totals + modulesContributing are always unfiltered (immune to the --min-missed-lines row filter)', () => {
    const rows = [
      'mod-a|pkg|src.kt|Cls|10|2|12|83.3|3,5',
      'mod-a|pkg|src2.kt|Cls2|5|10|15|33.3|6,7,8,9',
      'mod-b|pkg|src.kt|Cls|0|7|7|0|1,2,3,4,5,6,7',
    ];
    const agg = aggregateClassRows(rows, 5);
    // post-filter (row-filter narrows the markdown detail section ONLY)
    expect(agg.filteredRows.length).toBeLessThan(rows.length);
    // pre-filter (gate + envelope + Summary/AI-Optimized report sections use these)
    expect(agg.grandMissed).toBe(19); // 2 + 10 + 7
    expect(agg.grandCovered).toBe(15); // 10 + 5 + 0
    expect(agg.grandTotal).toBe(34);   // 12 + 15 + 7
    expect(agg.modulesContributing).toBe(2); // mod-a, mod-b — both have real data
  });
});

// wet-audit-v0.9-part2 BUG-2 — fail-gate semantics. Locks the contract that
// `--min-missed-lines N > 0` fails when the project's UNFILTERED missed_lines
// total exceeds N (strict greater-than). Threshold of 0 disables the gate.
// End-to-end propagation through runParallel is covered in
// parallel-orchestrator.test.js#coverage_threshold_exceeded.
describe('runCoverage — --min-missed-lines fail-gate (BUG-2)', () => {
  function gateBreaches(rows, threshold) {
    const agg = aggregateClassRows(rows, 0);
    return threshold > 0 && agg.grandMissed > threshold;
  }

  it('fires when unfiltered missed > threshold', () => {
    const rows = ['mod-a|pkg|src.kt|Cls|0|100|100|0|1-100'];
    expect(gateBreaches(rows, 50)).toBe(true);
  });

  it('does NOT fire when minMissedLines=0 (default — disabled)', () => {
    const rows = ['mod-a|pkg|src.kt|Cls|0|100|100|0|1-100'];
    expect(gateBreaches(rows, 0)).toBe(false);
  });

  it('does NOT fire when missed equals threshold (strict greater-than)', () => {
    const rows = ['mod-a|pkg|src.kt|Cls|0|50|50|0|1-50'];
    expect(gateBreaches(rows, 50)).toBe(false);
  });
});

describe('formatLineRanges', () => {
  it('compresses runs', () => {
    expect(formatLineRanges('1,2,3,5,7,8,9')).toBe('1-3, 5, 7-9');
  });
  it('handles single line and empty', () => {
    expect(formatLineRanges('42')).toBe('42');
    expect(formatLineRanges('')).toBe('');
  });
});

describe('coverageToolLabel', () => {
  it('maps explicit tool keys to human names', () => {
    expect(coverageToolLabel('kover')).toBe('Kover');
    expect(coverageToolLabel('jacoco')).toBe('JaCoCo');
    expect(coverageToolLabel('none')).toBe('(none)');
  });
  it('auto reflects the tool(s) that produced data (never bare "(none)" with data)', () => {
    expect(coverageToolLabel('auto', ['kover'])).toBe('auto (Kover)');
    expect(coverageToolLabel('auto', ['jacoco'])).toBe('auto (JaCoCo)');
    expect(coverageToolLabel('auto', ['jacoco', 'kover'])).toBe('auto (JaCoCo + Kover)');
  });
  it('auto with no resolved tools degrades gracefully (defensive)', () => {
    expect(coverageToolLabel('auto', [])).toBe('auto (none detected)');
  });
});

describe('findCoverageXmlPath', () => {
  it('returns the kover XML path when present', () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    const xml = dropFakeXml(projectRoot, 'a', 'kover');
    expect(findCoverageXmlPath(projectRoot, 'a', 'kover', false)).toBe(xml);
  });
  it('returns the jacoco XML path when present', () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'jacoco' }]);
    const xml = dropFakeXml(projectRoot, 'a', 'jacoco');
    expect(findCoverageXmlPath(projectRoot, 'a', 'jacoco', false)).toBe(xml);
  });
  it('returns null when no XML exists', () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    expect(findCoverageXmlPath(projectRoot, 'a', 'kover', false)).toBe(null);
  });

  // Finding #2 — AGP per-variant coverage report XML lives under
  // build/reports/coverage/test/<flavor>/<buildType>/report.xml, not jacoco/.
  it('finds the AGP per-variant coverage report XML (build/reports/coverage/test/...)', () => {
    const projectRoot = makeProject([{ name: 'app', coverage: 'jacoco' }]);
    const dir = path.join(projectRoot, 'app', 'build', 'reports', 'coverage', 'test', 'demo', 'debug');
    mkdirSync(dir, { recursive: true });
    const xml = path.join(dir, 'report.xml');
    writeFileSync(xml, '<report></report>');
    expect(findCoverageXmlPath(projectRoot, 'app', 'jacoco', false)).toBe(xml);
  });

  it('prefers the variant-hint flavor when multiple variant reports coexist on disk', () => {
    const projectRoot = makeProject([{ name: 'app', coverage: 'jacoco' }]);
    const mk = (flavor) => {
      const d = path.join(projectRoot, 'app', 'build', 'reports', 'coverage', 'test', flavor, 'debug');
      mkdirSync(d, { recursive: true });
      const f = path.join(d, 'report.xml');
      writeFileSync(f, '<report></report>');
      return f;
    };
    const demoXml = mk('demo');
    const prodXml = mk('prod');
    expect(findCoverageXmlPath(projectRoot, 'app', 'jacoco', false, { flavor: 'prod', buildType: 'debug' })).toBe(prodXml);
    expect(findCoverageXmlPath(projectRoot, 'app', 'jacoco', false, { flavor: 'demo', buildType: 'debug' })).toBe(demoXml);
  });

  it('classic jacocoTestReport.xml still wins over an AGP variant report (non-flavored byte-identical)', () => {
    const projectRoot = makeProject([{ name: 'app', coverage: 'jacoco' }]);
    const classic = dropFakeXml(projectRoot, 'app', 'jacoco');
    const agpDir = path.join(projectRoot, 'app', 'build', 'reports', 'coverage', 'test', 'demo', 'debug');
    mkdirSync(agpDir, { recursive: true });
    writeFileSync(path.join(agpDir, 'report.xml'), '<report></report>');
    expect(findCoverageXmlPath(projectRoot, 'app', 'jacoco', false)).toBe(classic);
  });
});

describe('discoverCoverageModules', () => {
  it('partitions modules by detected plugin', () => {
    const projectModel = {
      modules: {
        ':a': { coveragePlugin: 'kover',  type: 'jvm' },
        ':b': { coveragePlugin: 'jacoco', type: 'jvm' },
        ':c': { coveragePlugin: null,     type: 'jvm' },
      },
    };
    const opts = parseArgs([]);
    const r = discoverCoverageModules(projectModel, opts);
    expect(r.koverModules).toEqual(['a']);
    expect(r.jacocoModules).toEqual(['b']);
    expect(r.dispatched.map(m => m.name)).toEqual(['a', 'b']);
  });

  it('--exclude-coverage drops from dispatched but keeps plugin classification', () => {
    const projectModel = {
      modules: {
        ':a': { coveragePlugin: 'kover',  type: 'jvm' },
        ':b': { coveragePlugin: 'kover',  type: 'jvm' },
      },
    };
    const opts = parseArgs(['--exclude-coverage', 'b']);
    const r = discoverCoverageModules(projectModel, opts);
    expect(r.koverModules).toEqual(['a', 'b']);
    expect(r.dispatched.map(m => m.name)).toEqual(['a']);
  });

  it('--coverage-modules limits dispatched (plugin classification unaffected)', () => {
    const projectModel = {
      modules: {
        ':a': { coveragePlugin: 'kover', type: 'jvm' },
        ':b': { coveragePlugin: 'kover', type: 'jvm' },
      },
    };
    const opts = parseArgs(['--coverage-modules', 'a']);
    const r = discoverCoverageModules(projectModel, opts);
    expect(r.koverModules).toEqual(['a', 'b']);
    expect(r.dispatched.map(m => m.name)).toEqual(['a']);
  });

  it('forced --coverage-tool kover still records the project-shape arrays from analysis', () => {
    const projectModel = {
      modules: {
        ':a': { coveragePlugin: 'jacoco', type: 'jvm' },
      },
    };
    const opts = parseArgs(['--coverage-tool', 'kover']);
    const r = discoverCoverageModules(projectModel, opts);
    // Project-shape signal: a has jacoco configured.
    expect(r.koverModules).toEqual([]);
    expect(r.jacocoModules).toEqual(['a']);
    // But effective dispatch uses forced kover.
    expect(r.dispatched.map(m => m.tool)).toEqual(['kover']);
  });

  it('classifies root-convention jacoco via probe-derived resolved.coverageTask (Bug 1)', () => {
    // Static coveragePlugin is null (jacoco applied via root subprojects {}),
    // but the gradle probe resolved jacocoTestReport. effectiveCoveragePlugin
    // upgrades it → classified + dispatched in auto mode.
    const projectModel = {
      modules: {
        ':core-foo': { coveragePlugin: null, type: 'jvm', resolved: { coverageTask: 'jacocoTestReport' } },
        ':core-bar': { coveragePlugin: null, type: 'jvm', resolved: { coverageTask: 'jacocoTestReport' } },
      },
    };
    const opts = parseArgs([]); // auto
    const r = discoverCoverageModules(projectModel, opts);
    expect(r.jacocoModules).toEqual(['core-bar', 'core-foo']);
    expect(r.koverModules).toEqual([]);
    expect(r.dispatched.map(m => m.name)).toEqual(['core-bar', 'core-foo']);
    expect(r.dispatched.every(m => m.tool === 'jacoco')).toBe(true);
  });

  it('static coveragePlugin still wins over a divergent probe task', () => {
    const projectModel = {
      modules: {
        ':a': { coveragePlugin: 'kover', type: 'jvm', resolved: { coverageTask: 'jacocoTestReport' } },
      },
    };
    const r = discoverCoverageModules(projectModel, parseArgs([]));
    expect(r.koverModules).toEqual(['a']);
    expect(r.jacocoModules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runCoverage integration
// ---------------------------------------------------------------------------

describe('runCoverage', () => {
  it('Kover-only project: modules_with_kover_plugin populated, modules_with_jacoco_plugin empty', async () => {
    const projectRoot = makeProject([{ name: 'mod-a', coverage: 'kover' }]);
    dropFakeXml(projectRoot, 'mod-a', 'kover');
    const parseCoverageXml = makeParseCoverageStub({
      rowsByModule: {
        'mod-a': ['mod-a|pkg|Foo.kt|Foo|10|2|12|83.3|3,5'],
      },
    });
    const { envelope, exitCode } = await runCoverage({
      projectRoot,
      args: [],
      parseCoverageXml,
    });
    expect(exitCode).toBe(0);
    expect(envelope.coverage.modules_with_kover_plugin).toEqual(['mod-a']);
    expect(envelope.coverage.modules_with_jacoco_plugin).toEqual([]);
    expect(envelope.coverage.modules_contributing).toBe(1);
    expect(envelope.coverage.missed_lines).toBe(2);
    expect(envelope.errors).toEqual([]);
    expect(envelope.warnings).toEqual([]);
  });

  it('JaCoCo-only project: modules_with_jacoco_plugin populated', async () => {
    const projectRoot = makeProject([{ name: 'mod-b', coverage: 'jacoco' }]);
    dropFakeXml(projectRoot, 'mod-b', 'jacoco');
    const parseCoverageXml = makeParseCoverageStub({
      rowsByModule: {
        'mod-b': ['mod-b|pkg|Bar.kt|Bar|5|5|10|50.0|1,2,3,4,5'],
      },
    });
    const { envelope } = await runCoverage({
      projectRoot,
      args: [],
      parseCoverageXml,
    });
    expect(envelope.coverage.modules_with_jacoco_plugin).toEqual(['mod-b']);
    expect(envelope.coverage.modules_with_kover_plugin).toEqual([]);
    expect(envelope.coverage.modules_contributing).toBe(1);
  });

  it('mixed project: both arrays populated correctly', async () => {
    const projectRoot = makeProject([
      { name: 'k1', coverage: 'kover' },
      { name: 'j1', coverage: 'jacoco' },
      { name: 'plain' },
    ]);
    dropFakeXml(projectRoot, 'k1', 'kover');
    dropFakeXml(projectRoot, 'j1', 'jacoco');
    const parseCoverageXml = makeParseCoverageStub({
      rowsByModule: {
        'k1': ['k1|p|F.kt|F|1|1|2|50|2'],
        'j1': ['j1|p|G.kt|G|2|0|2|100|'],
      },
    });
    const { envelope } = await runCoverage({
      projectRoot,
      args: [],
      parseCoverageXml,
    });
    expect(envelope.coverage.modules_with_kover_plugin).toEqual(['k1']);
    expect(envelope.coverage.modules_with_jacoco_plugin).toEqual(['j1']);
    expect(envelope.coverage.modules_contributing).toBe(2);
  });

  it('report Duration reflects the parent runStartTime (full parallel run), not just the aggregation step', async () => {
    const projectRoot = makeProject([{ name: 'mod-a', coverage: 'kover' }]);
    dropFakeXml(projectRoot, 'mod-a', 'kover');
    const parseCoverageXml = makeParseCoverageStub({ rowsByModule: { 'mod-a': ['mod-a|pkg|Foo.kt|Foo|10|2|12|83.3|3,5'] } });
    const outputFile = path.join(projectRoot, 'report.md');
    await runCoverage({
      projectRoot,
      args: ['--output-file', outputFile],
      parseCoverageXml,
      // Simulate a ~95s parent run: tests already executed before this
      // aggregation. Without threading runStartTime the report would show the
      // (sub-second) aggregation time → "0m 0s".
      runStartTime: Date.now() - 95_000,
      testsRan: true,
      originatingSubcommand: 'parallel',
    });
    const report = readFileSync(outputFile, 'utf8');
    expect(report).toMatch(/\*\*Duration\*\*: 1m \d+s/);
    expect(report).not.toContain('**Duration**: 0m 0s');
  });

  it('report Duration uses the aggregation clock when no parent runStartTime (standalone coverage)', async () => {
    const projectRoot = makeProject([{ name: 'mod-a', coverage: 'kover' }]);
    dropFakeXml(projectRoot, 'mod-a', 'kover');
    const parseCoverageXml = makeParseCoverageStub({ rowsByModule: { 'mod-a': ['mod-a|pkg|Foo.kt|Foo|10|2|12|83.3|3,5'] } });
    const outputFile = path.join(projectRoot, 'report.md');
    await runCoverage({ projectRoot, args: ['--output-file', outputFile], parseCoverageXml });
    const report = readFileSync(outputFile, 'utf8');
    // Standalone aggregation measures only its own (sub-minute) work — correct.
    expect(report).toMatch(/\*\*Duration\*\*: 0m \d+s/);
  });

  it('report Coverage Tool header shows the resolved tool for --coverage-tool auto (not "(none)")', async () => {
    const projectRoot = makeProject([{ name: 'mod-a', coverage: 'kover' }]);
    dropFakeXml(projectRoot, 'mod-a', 'kover');
    const parseCoverageXml = makeParseCoverageStub({ rowsByModule: { 'mod-a': ['mod-a|pkg|Foo.kt|Foo|10|2|12|83.3|3,5'] } });
    const outputFile = path.join(projectRoot, 'report.md');
    await runCoverage({ projectRoot, args: ['--output-file', outputFile, '--coverage-tool', 'auto'], parseCoverageXml });
    const report = readFileSync(outputFile, 'utf8');
    expect(report).toContain('**Coverage Tool**: auto (Kover)');
    expect(report).not.toContain('**Coverage Tool**: (none)');
  });

  it('jacoco module with HTML report but no XML → coverage_xml_disabled warning + no_xml bucket', async () => {
    const projectRoot = makeProject([{ name: 'j-html', coverage: 'jacoco' }]);
    // jacocoTestReport ran but emitted HTML only (Gradle default xml.required=false).
    mkdirSync(path.join(projectRoot, 'j-html', 'build', 'reports', 'jacoco', 'test', 'html'), { recursive: true });
    const parseCoverageXml = makeParseCoverageStub();
    const { envelope, exitCode } = await runCoverage({ projectRoot, args: [], parseCoverageXml });
    expect(exitCode).toBe(0);
    expect(envelope.coverage.module_buckets.no_xml).toContain('j-html');
    const w = envelope.warnings.find((x) => x.code === 'coverage_xml_disabled');
    expect(w).toBeTruthy();
    expect(w.modules).toContain('j-html');
  });

  it('jacoco module with a .exec data file but no XML → coverage_xml_disabled warning', async () => {
    const projectRoot = makeProject([{ name: 'j-exec', coverage: 'jacoco' }]);
    const execDir = path.join(projectRoot, 'j-exec', 'build', 'jacoco');
    mkdirSync(execDir, { recursive: true });
    writeFileSync(path.join(execDir, 'test.exec'), 'x');
    const parseCoverageXml = makeParseCoverageStub();
    const { envelope } = await runCoverage({ projectRoot, args: [], parseCoverageXml });
    expect(envelope.warnings.find((x) => x.code === 'coverage_xml_disabled')?.modules).toContain('j-exec');
  });

  it('jacoco module with no report artifacts at all → no_xml without coverage_xml_disabled', async () => {
    const projectRoot = makeProject([{ name: 'j-bare', coverage: 'jacoco' }]);
    const parseCoverageXml = makeParseCoverageStub();
    const { envelope } = await runCoverage({ projectRoot, args: [], parseCoverageXml });
    expect(envelope.coverage.module_buckets.no_xml).toContain('j-bare');
    expect(envelope.warnings.find((x) => x.code === 'coverage_xml_disabled')).toBeFalsy();
  });

  it('kover module never triggers coverage_xml_disabled (jacoco-only diagnostic)', async () => {
    const projectRoot = makeProject([{ name: 'k-html', coverage: 'kover' }]);
    // Even with a jacoco-style HTML dir present, a kover-classified module is exempt.
    mkdirSync(path.join(projectRoot, 'k-html', 'build', 'reports', 'jacoco', 'test', 'html'), { recursive: true });
    const parseCoverageXml = makeParseCoverageStub();
    const { envelope } = await runCoverage({ projectRoot, args: [], parseCoverageXml });
    expect(envelope.warnings.find((x) => x.code === 'coverage_xml_disabled')).toBeFalsy();
  });

  it('--coverage-tool none → coverage_aggregation_skipped warning, exit 0, no parser calls', async () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    const parseCoverageXml = makeParseCoverageStub();
    const { envelope, exitCode } = await runCoverage({
      projectRoot,
      args: ['--coverage-tool', 'none'],
      parseCoverageXml,
    });
    expect(exitCode).toBe(0);
    expect(envelope.warnings).toHaveLength(1);
    expect(envelope.warnings[0].code).toBe('coverage_aggregation_skipped');
    expect(envelope.coverage.tool).toBe('none');
    expect(parseCoverageXml.calls).toHaveLength(0);
  });

  it('--no-coverage alias → same effect as --coverage-tool none', async () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    const parseCoverageXml = makeParseCoverageStub();
    const { envelope, exitCode } = await runCoverage({
      projectRoot,
      args: ['--no-coverage'],
      parseCoverageXml,
    });
    expect(exitCode).toBe(0);
    expect(envelope.warnings[0].code).toBe('coverage_aggregation_skipped');
    expect(parseCoverageXml.calls).toHaveLength(0);
  });

  it('no coverage plugins detected → no_coverage_data warning', async () => {
    const projectRoot = makeProject([{ name: 'plain' }]); // no kover, no jacoco
    const parseCoverageXml = makeParseCoverageStub();
    const { envelope, exitCode } = await runCoverage({
      projectRoot,
      args: [],
      parseCoverageXml,
    });
    expect(exitCode).toBe(0);
    expect(envelope.coverage.modules_contributing).toBe(0);
    expect(envelope.warnings.find(w => w.code === 'no_coverage_data')).toBeTruthy();
    expect(envelope.coverage.modules_with_kover_plugin).toEqual([]);
    expect(envelope.coverage.modules_with_jacoco_plugin).toEqual([]);
  });

  it('--dry-run → dry_run:true plus plan section, no fs writes for the report', async () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    const parseCoverageXml = makeParseCoverageStub();
    const { envelope, exitCode } = await runCoverage({
      projectRoot,
      args: ['--dry-run'],
      parseCoverageXml,
    });
    expect(exitCode).toBe(0);
    expect(envelope.dry_run).toBe(true);
    expect(envelope.plan).toBeTruthy();
    expect(envelope.plan.coverage_tool).toBe('auto');
    expect(parseCoverageXml.calls).toHaveLength(0);
    // No report files written
    expect(existsSync(path.join(projectRoot, 'coverage-full-report.md'))).toBe(false);
  });

  it('writes Markdown report under .kmp-test-runner/reports/coverage/ with versioned + latest alias (v0.8.0)', async () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    dropFakeXml(projectRoot, 'a', 'kover');
    const parseCoverageXml = makeParseCoverageStub({
      rowsByModule: { 'a': ['a|pkg|Foo.kt|Foo|9|1|10|90.0|7'] },
    });
    const { envelope } = await runCoverage({
      projectRoot,
      args: ['--output-file', 'coverage-full-report.md'],
      parseCoverageXml,
      runId: 'TEST-RUN-ID',
    });
    const reportsDir = path.join(projectRoot, '.kmp-test-runner', 'reports', 'coverage');
    expect(existsSync(path.join(reportsDir, 'TEST-RUN-ID.md'))).toBe(true);
    expect(existsSync(path.join(reportsDir, 'latest.md'))).toBe(true);
    expect(envelope.coverage.missed_lines).toBe(1);
  });

  it('clean break — no coverage-full-report.md or coverage-full-report-<runId>.md written at project root (v0.8.0)', async () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    dropFakeXml(projectRoot, 'a', 'kover');
    const parseCoverageXml = makeParseCoverageStub({
      rowsByModule: { 'a': ['a|pkg|Foo.kt|Foo|9|1|10|90.0|7'] },
    });
    await runCoverage({
      projectRoot,
      args: ['--output-file', 'coverage-full-report.md'],
      parseCoverageXml,
      runId: 'TEST-RUN-ID',
    });
    expect(existsSync(path.join(projectRoot, 'coverage-full-report.md'))).toBe(false);
    expect(existsSync(path.join(projectRoot, 'coverage-full-report-TEST-RUN-ID.md'))).toBe(false);
  });

  // Tests-Run header through the FULL runCoverage path (one level above the
  // PR 3.4 writeMarkdownReport-level cases below). These opts shapes are
  // exactly what lib/runner.js's coverage branch passes after reading the
  // dispatcher-threaded KMP_ORIGINATING_SUBCOMMAND env var — the live CLI
  // route `kmp-test parallel --skip-tests` is wrapper-rewritten to a
  // `coverage` invocation, so this seam is where the header is decided.
  // (The dispatcher env injection + runner.js allowlist mapping themselves
  // are wet-validated — a bin-level CI e2e would be the suite's first
  // real-Gradle-dependent test, brittle for a header string.)
  it('runCoverage(originatingSubcommand:parallel) → latest.md header "No (--skip-tests)"', async () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    dropFakeXml(projectRoot, 'a', 'kover');
    const parseCoverageXml = makeParseCoverageStub({
      rowsByModule: { 'a': ['a|pkg|Foo.kt|Foo|9|1|10|90.0|7'] },
    });
    await runCoverage({
      projectRoot,
      args: [],
      parseCoverageXml,
      runId: 'HDR-PARALLEL',
      testsRan: false,
      originatingSubcommand: 'parallel',
    });
    const md = readFileSync(
      path.join(projectRoot, '.kmp-test-runner', 'reports', 'coverage', 'latest.md'), 'utf8');
    expect(md).toContain('> **Tests Run**: No (--skip-tests)');
  });

  it('runCoverage() defaults → latest.md header "No (coverage subcommand)"', async () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    dropFakeXml(projectRoot, 'a', 'kover');
    const parseCoverageXml = makeParseCoverageStub({
      rowsByModule: { 'a': ['a|pkg|Foo.kt|Foo|9|1|10|90.0|7'] },
    });
    await runCoverage({ projectRoot, args: [], parseCoverageXml, runId: 'HDR-DEFAULT' });
    const md = readFileSync(
      path.join(projectRoot, '.kmp-test-runner', 'reports', 'coverage', 'latest.md'), 'utf8');
    expect(md).toContain('> **Tests Run**: No (coverage subcommand)');
  });

  it('two coverage runs in same project produce two <runId>.md files + single latest.md overwrite', async () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    dropFakeXml(projectRoot, 'a', 'kover');
    const parseCoverageXmlA = makeParseCoverageStub({
      rowsByModule: { 'a': ['a|pkg|Foo.kt|Foo|9|1|10|90.0|7'] },
    });
    await runCoverage({ projectRoot, args: [], parseCoverageXml: parseCoverageXmlA, runId: 'RUN-A' });
    const parseCoverageXmlB = makeParseCoverageStub({
      rowsByModule: { 'a': ['a|pkg|Foo.kt|Foo|8|2|10|80.0|7,9'] },
    });
    await runCoverage({ projectRoot, args: [], parseCoverageXml: parseCoverageXmlB, runId: 'RUN-B' });
    const reportsDir = path.join(projectRoot, '.kmp-test-runner', 'reports', 'coverage');
    expect(existsSync(path.join(reportsDir, 'RUN-A.md'))).toBe(true);
    expect(existsSync(path.join(reportsDir, 'RUN-B.md'))).toBe(true);
    expect(existsSync(path.join(reportsDir, 'latest.md'))).toBe(true);
    // latest.md must mirror the most recent run (RUN-B) — sample a known-distinct row.
    const latestContent = readFileSync(path.join(reportsDir, 'latest.md'), 'utf8');
    expect(latestContent).toContain('80%');  // RUN-B coverage pct
  });

  // PR 3.4 A2 — pre-fix the orchestrator hardcoded the report path to
  // .kmp-test-runner/reports/coverage/<runId>.md and dropped --output-file
  // entirely (literal `void outputFile;`). After PR 3.4 a custom path is
  // honoured: absolute used verbatim, relative resolved against projectRoot.
  // The historic default literal (`coverage-full-report.md`) stays as the
  // sentinel for "use the default tree" so the v0.8.0 clean-break shape
  // (no project-root markdown) is preserved.
  describe('PR 3.4 A2 — --output-file path semantics', () => {
    it('relative path → written under projectRoot, no default-tree alias', async () => {
      const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
      dropFakeXml(projectRoot, 'a', 'kover');
      const parseCoverageXml = makeParseCoverageStub({
        rowsByModule: { 'a': ['a|pkg|Foo.kt|Foo|9|1|10|90.0|7'] },
      });
      await runCoverage({
        projectRoot,
        args: ['--output-file', 'my-report.md'],
        parseCoverageXml,
        runId: 'A2-REL',
      });
      // User's chosen path written at projectRoot.
      expect(existsSync(path.join(projectRoot, 'my-report.md'))).toBe(true);
      // Default-tree write did NOT happen — the user picked a destination.
      const defaultTreeFile = path.join(projectRoot, '.kmp-test-runner', 'reports', 'coverage', 'A2-REL.md');
      expect(existsSync(defaultTreeFile)).toBe(false);
      // And no latest.md alias either.
      const defaultLatest = path.join(projectRoot, '.kmp-test-runner', 'reports', 'coverage', 'latest.md');
      expect(existsSync(defaultLatest)).toBe(false);
    });

    it('absolute path → written verbatim, no default-tree write', async () => {
      const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
      dropFakeXml(projectRoot, 'a', 'kover');
      // Use a tmp file path OUTSIDE the projectRoot to prove absolute is honoured.
      const absDir = mkdtempSync(path.join(tmpdir(), 'kmp-a2-abs-'));
      const absPath = path.join(absDir, 'absolute-report.md');
      const parseCoverageXml = makeParseCoverageStub({
        rowsByModule: { 'a': ['a|pkg|Foo.kt|Foo|9|1|10|90.0|7'] },
      });
      try {
        await runCoverage({
          projectRoot,
          args: ['--output-file', absPath],
          parseCoverageXml,
          runId: 'A2-ABS',
        });
        expect(existsSync(absPath)).toBe(true);
        expect(existsSync(path.join(projectRoot, '.kmp-test-runner', 'reports', 'coverage', 'A2-ABS.md'))).toBe(false);
      } finally {
        rmSync(absDir, { recursive: true, force: true });
      }
    });

    it('relative path with nested dirs → parent dir auto-created', async () => {
      const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
      dropFakeXml(projectRoot, 'a', 'kover');
      const parseCoverageXml = makeParseCoverageStub({
        rowsByModule: { 'a': ['a|pkg|Foo.kt|Foo|9|1|10|90.0|7'] },
      });
      await runCoverage({
        projectRoot,
        args: ['--output-file', 'nested/dir/report.md'],
        parseCoverageXml,
        runId: 'A2-NEST',
      });
      expect(existsSync(path.join(projectRoot, 'nested', 'dir', 'report.md'))).toBe(true);
    });

    it('default (no flag) → falls back to default tree + latest.md (regression guard)', async () => {
      const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
      dropFakeXml(projectRoot, 'a', 'kover');
      const parseCoverageXml = makeParseCoverageStub({
        rowsByModule: { 'a': ['a|pkg|Foo.kt|Foo|9|1|10|90.0|7'] },
      });
      const { envelope } = await runCoverage({
        projectRoot, args: [], parseCoverageXml, runId: 'A2-DEFAULT',
      });
      const reportsDir = path.join(projectRoot, '.kmp-test-runner', 'reports', 'coverage');
      expect(existsSync(path.join(reportsDir, 'A2-DEFAULT.md'))).toBe(true);
      expect(existsSync(path.join(reportsDir, 'latest.md'))).toBe(true);
      expect(envelope.coverage.missed_lines).toBe(1);
    });

    it('explicit default literal coverage-full-report.md → treated as default (back-compat sentinel)', async () => {
      const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
      dropFakeXml(projectRoot, 'a', 'kover');
      const parseCoverageXml = makeParseCoverageStub({
        rowsByModule: { 'a': ['a|pkg|Foo.kt|Foo|9|1|10|90.0|7'] },
      });
      await runCoverage({
        projectRoot,
        args: ['--output-file', 'coverage-full-report.md'],
        parseCoverageXml,
        runId: 'A2-LITERAL',
      });
      // Default tree write fires (sentinel preserved).
      const reportsDir = path.join(projectRoot, '.kmp-test-runner', 'reports', 'coverage');
      expect(existsSync(path.join(reportsDir, 'A2-LITERAL.md'))).toBe(true);
      // No literal file at projectRoot — would defeat the v0.8.0 clean break.
      expect(existsSync(path.join(projectRoot, 'coverage-full-report.md'))).toBe(false);
    });
  });

  // PR 3.4 A3 — the "Tests Run" header (+ EXECUTION_MODE marker, + generator
  // footer) used to be hardcoded as "No (--skip-tests)" regardless of how the
  // orchestrator was invoked. After PR 3.4 the label reflects the actual
  // execution path: standalone `coverage` says "No (coverage subcommand)",
  // `parallel --skip-tests` says "No (--skip-tests)", `parallel` (full) says
  // "Yes (via parallel)" because tests ran before coverage aggregation.
  describe('PR 3.4 A3 — Tests Run header reflects execution path', () => {
    it('defaults (standalone coverage subcommand) → "No (coverage subcommand)"', async () => {
      const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
      dropFakeXml(projectRoot, 'a', 'kover');
      const parseCoverageXml = makeParseCoverageStub({
        rowsByModule: { 'a': ['a|pkg|Foo.kt|Foo|9|1|10|90.0|7'] },
      });
      await runCoverage({ projectRoot, args: [], parseCoverageXml, runId: 'A3-DEFAULTS' });
      const reportPath = path.join(projectRoot, '.kmp-test-runner', 'reports', 'coverage', 'A3-DEFAULTS.md');
      const content = readFileSync(reportPath, 'utf8');
      expect(content).toContain('> **Tests Run**: No (coverage subcommand)');
      expect(content).toContain('EXECUTION_MODE: skip-tests');
      expect(content).toContain('coverage aggregator');
    });

    it('originatingSubcommand=parallel + testsRan=false → "No (--skip-tests)"', async () => {
      const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
      dropFakeXml(projectRoot, 'a', 'kover');
      const parseCoverageXml = makeParseCoverageStub({
        rowsByModule: { 'a': ['a|pkg|Foo.kt|Foo|9|1|10|90.0|7'] },
      });
      await runCoverage({
        projectRoot, args: [], parseCoverageXml, runId: 'A3-PARALLEL-SKIP',
        testsRan: false, originatingSubcommand: 'parallel',
      });
      const reportPath = path.join(projectRoot, '.kmp-test-runner', 'reports', 'coverage', 'A3-PARALLEL-SKIP.md');
      const content = readFileSync(reportPath, 'utf8');
      expect(content).toContain('> **Tests Run**: No (--skip-tests)');
      expect(content).toContain('EXECUTION_MODE: skip-tests');
    });

    it('originatingSubcommand=parallel + testsRan=true → "Yes (via parallel)"', async () => {
      const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
      dropFakeXml(projectRoot, 'a', 'kover');
      const parseCoverageXml = makeParseCoverageStub({
        rowsByModule: { 'a': ['a|pkg|Foo.kt|Foo|9|1|10|90.0|7'] },
      });
      await runCoverage({
        projectRoot, args: [], parseCoverageXml, runId: 'A3-PARALLEL-FULL',
        testsRan: true, originatingSubcommand: 'parallel',
      });
      const reportPath = path.join(projectRoot, '.kmp-test-runner', 'reports', 'coverage', 'A3-PARALLEL-FULL.md');
      const content = readFileSync(reportPath, 'utf8');
      expect(content).toContain('> **Tests Run**: Yes (via parallel)');
      expect(content).toContain('EXECUTION_MODE: with-tests');
      expect(content).toContain('Coverage aggregation (after test execution)');
      expect(content).toContain('aggregator after parallel');
    });
  });

  it('--exclude-coverage drops module from dispatched but keeps plugin classification', async () => {
    const projectRoot = makeProject([
      { name: 'a', coverage: 'kover' },
      { name: 'b', coverage: 'kover' },
    ]);
    dropFakeXml(projectRoot, 'a', 'kover');
    dropFakeXml(projectRoot, 'b', 'kover');
    const parseCoverageXml = makeParseCoverageStub({
      rowsByModule: { 'a': ['a|p|F.kt|F|1|1|2|50|2'] },
    });
    const { envelope } = await runCoverage({
      projectRoot,
      args: ['--exclude-coverage', 'b'],
      parseCoverageXml,
    });
    // Project-shape signal preserves both modules.
    expect(envelope.coverage.modules_with_kover_plugin).toEqual(['a', 'b']);
    // Only 'a' actually contributed XML → modules_contributing reflects it.
    expect(envelope.coverage.modules_contributing).toBe(1);
    // Parser was only invoked for 'a'.
    expect(parseCoverageXml.calls.map((c) => c.moduleName)).toEqual(['a']);
  });

  it('parser is invoked in-process with (xmlPath, moduleName) — no subprocess involved', async () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    const xmlPath = dropFakeXml(projectRoot, 'a', 'kover');
    const parseCoverageXml = makeParseCoverageStub({
      rowsByModule: { 'a': ['a|p|F.kt|F|1|0|1|100|'] },
    });
    await runCoverage({ projectRoot, args: [], parseCoverageXml });
    expect(parseCoverageXml.calls).toHaveLength(1);
    expect(parseCoverageXml.calls[0].xmlPath).toBe(xmlPath);
    expect(parseCoverageXml.calls[0].moduleName).toBe('a');
  });

  // v0.9 step 4 — coverage silently ignores --isolated. Coverage doesn't
  // spawn gradle (it parses leftover XML in-process only), so the cache-dir
  // flag has no surface to attach to. The orchestrator must not error out
  // and must not surface an `isolated:{}` envelope field (would be misleading).
  it('--isolated is silently ignored (no envelope field, no error)', async () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    dropFakeXml(projectRoot, 'a', 'kover');
    const parseCoverageXml = makeParseCoverageStub({
      rowsByModule: { 'a': ['a|p|F.kt|F|1|0|1|100|'] },
    });
    const { envelope, exitCode } = await runCoverage({
      projectRoot,
      args: ['--isolated', '--isolated-cache-dir', '/tmp/x', '--isolated-no-lock'],
      parseCoverageXml,
    });
    expect(exitCode).toBe(0);
    expect(envelope.errors).toEqual([]);
    expect(envelope.isolated).toBeUndefined();
  });
});

describe('PR 3.5 A4 — coverage.module_buckets accounting', () => {
  it('three buckets populated (with_data + no_xml + skipped_by_user), invariant holds', async () => {
    // a → kover plugin + XML present + parser returns rows → with_data
    // b → kover plugin + XML missing on disk             → no_xml
    // c → kover plugin + excluded via --exclude-coverage → skipped_by_user
    const projectRoot = makeProject([
      { name: 'a', coverage: 'kover' },
      { name: 'b', coverage: 'kover' },
      { name: 'c', coverage: 'kover' },
    ]);
    dropFakeXml(projectRoot, 'a', 'kover');
    // intentionally NO dropFakeXml for b → noXml bucket
    dropFakeXml(projectRoot, 'c', 'kover');
    const parseCoverageXml = makeParseCoverageStub({
      rowsByModule: { 'a': ['a|p|F.kt|F|1|0|1|100|'] },
    });
    const { envelope } = await runCoverage({
      projectRoot,
      args: ['--exclude-coverage', 'c'],
      parseCoverageXml,
    });
    expect(envelope.coverage.module_buckets).toEqual({
      with_data: ['a'],
      no_xml: ['b'],
      parse_errored: [],
      skipped_by_user: ['c'],
    });
    // 3 detected + 3 accounted → no drift warning.
    const drift = (envelope.warnings || []).find(w => w.code === 'coverage_aggregation_drift');
    expect(drift).toBeUndefined();
    // c was excluded so the parser never gets called for it.
    expect(parseCoverageXml.calls.map((c) => c.moduleName).sort()).toEqual(['a']);
  });

  it('parse_errored bucket fires when the parser reports errored:true, with a discriminated warning', async () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    dropFakeXml(projectRoot, 'a', 'kover');
    // Parser reports a failure → orchestrator must distinguish empty rows from
    // a parser failure and land the module in parse_errored, not with_data,
    // AND surface a discriminated coverage_parse_failed warning (PR-17 —
    // never silently indistinguishable from no_coverage_data).
    const parseCoverageXml = makeParseCoverageStub({ rowsByModule: { 'a': [] }, status: 1 });
    const { envelope } = await runCoverage({ projectRoot, args: [], parseCoverageXml });
    expect(envelope.coverage.module_buckets.parse_errored).toEqual(['a']);
    expect(envelope.coverage.module_buckets.with_data).toEqual([]);
    expect(envelope.coverage.module_buckets.no_xml).toEqual([]);
    expect(envelope.coverage.module_buckets.skipped_by_user).toEqual([]);
    // 1 detected + 1 accounted → no drift warning.
    const drift = (envelope.warnings || []).find(w => w.code === 'coverage_aggregation_drift');
    expect(drift).toBeUndefined();
    const w = envelope.warnings.find((x) => x.code === 'coverage_parse_failed');
    expect(w).toBeTruthy();
    expect(w.modules).toEqual(['a']);
  });

  it('--dry-run envelope carries empty module_buckets shape (parity)', async () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    const parseCoverageXml = makeParseCoverageStub();
    const { envelope, exitCode } = await runCoverage({
      projectRoot,
      args: ['--dry-run'],
      parseCoverageXml,
    });
    expect(exitCode).toBe(0);
    expect(envelope.dry_run).toBe(true);
    // Empty shape on dry-run so downstream consumers can read the key without
    // optional-chaining; mirrors the existing modules_with_*_plugin treatment.
    expect(envelope.coverage.module_buckets).toEqual({
      with_data: [],
      no_xml: [],
      parse_errored: [],
      skipped_by_user: [],
    });
  });
});

// PR-17 — decouple --min-missed-lines threshold filtering from aggregation
// (Bug 1), and discriminate parser failures (Bug 3's aggregation-side
// consumer). Bug 2 (warnings dropped on the full `parallel` path) is covered
// in parallel-orchestrator.test.js since the drop happened one layer up.
describe('PR-17 — threshold/aggregation integrity', () => {
  it('threshold fail (aggregate) with per-row values all below the row-filter still reports full data', async () => {
    // Two classes each missing only 10 lines (below --min-missed-lines 15's
    // row-filter) but summing to 20 (above the gate) — the exact scenario
    // that used to falsely zero modulesContributing, fire a contradictory
    // no_coverage_data warning, and skip writing the report entirely.
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    dropFakeXml(projectRoot, 'a', 'kover');
    const parseCoverageXml = makeParseCoverageStub({
      rowsByModule: {
        a: [
          'a|pkg|One.kt|One|0|10|10|0|1-10',
          'a|pkg|Two.kt|Two|0|10|10|0|1-10',
        ],
      },
    });
    const outputFile = path.join(projectRoot, 'report.md');
    const { envelope, exitCode } = await runCoverage({
      projectRoot,
      args: ['--output-file', outputFile, '--min-missed-lines', '15'],
      parseCoverageXml,
    });
    expect(exitCode).toBe(1);
    expect(envelope.errors.find((e) => e.code === 'coverage_threshold_exceeded')).toBeTruthy();
    expect(envelope.coverage.missed_lines).toBe(20);
    expect(envelope.coverage.modules_contributing).toBe(1);
    expect(envelope.warnings.find((w) => w.code === 'no_coverage_data')).toBeFalsy();
    // The markdown report IS still written, with the unfiltered TOTAL.
    expect(existsSync(outputFile)).toBe(true);
    const report = readFileSync(outputFile, 'utf8');
    expect(report).toContain('MISSED_LINES: 20');
    // Detailed Class Coverage is correctly narrowed to empty — no single
    // class individually meets the 15-missed-line bar — proving the
    // row-filter still does its (intentionally separate) job.
    expect(report).not.toContain('### a');
  });

  it('discriminates coverage_xml_oversized from coverage_parse_failed across different modules', async () => {
    const projectRoot = makeProject([
      { name: 'big', coverage: 'kover' },
      { name: 'bad', coverage: 'kover' },
    ]);
    dropFakeXml(projectRoot, 'big', 'kover');
    dropFakeXml(projectRoot, 'bad', 'kover');
    const parseCoverageXml = (xmlPath, moduleName) => {
      if (moduleName === 'big') {
        return { rows: [], errored: true, reason: 'oversized', message: 'too big' };
      }
      return { rows: [], errored: true, reason: 'parse_failed', message: 'malformed' };
    };
    const { envelope } = await runCoverage({ projectRoot, args: [], parseCoverageXml });
    expect(envelope.coverage.module_buckets.parse_errored.slice().sort()).toEqual(['bad', 'big']);
    const oversized = envelope.warnings.find((w) => w.code === 'coverage_xml_oversized');
    expect(oversized).toBeTruthy();
    expect(oversized.modules).toEqual(['big']);
    const parseFailed = envelope.warnings.find((w) => w.code === 'coverage_parse_failed');
    expect(parseFailed).toBeTruthy();
    expect(parseFailed.modules).toEqual(['bad']);
  });

  it('threads the injected env through to the real parser — KMP_COVERAGE_XML_MAX_MB is honored', async () => {
    // Exercises the DEFAULT (non-injected) parseCoverageXml -- i.e. the real
    // lib/parsers/coverage-xml.js -- to prove runCoverage's own `env` param
    // reaches it, not just process.env. A 1 MB cap (the smallest valid
    // KMP_COVERAGE_XML_MAX_MB value) requires real oversized content; the
    // ~1.5 MB padding is comfortably under the 128 MB default, so this only
    // trips if the injected env actually wins.
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    const xmlPath = dropFakeXml(projectRoot, 'a', 'kover');
    writeFileSync(xmlPath, `<report>${'y'.repeat(1_500_000)}</report>`, 'utf8');
    const { envelope } = await runCoverage({
      projectRoot,
      args: [],
      env: { ...process.env, KMP_COVERAGE_XML_MAX_MB: '1' },
    });
    expect(envelope.coverage.module_buckets.parse_errored).toEqual(['a']);
    const w = envelope.warnings.find((x) => x.code === 'coverage_xml_oversized');
    expect(w).toBeTruthy();
    expect(w.modules).toEqual(['a']);
  });
});

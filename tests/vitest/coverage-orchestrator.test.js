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
//  12. Cross-platform spawn shape (no shell-specific assumptions in stub)

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
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
  coverageDisplayName,
} from '../../lib/coverage-orchestrator.js';

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

// Spawn stub for python3 calls (parse-coverage-xml.py). Returns canned rows
// keyed by module name. Cross-platform: caller passes the same shape regardless
// of host OS (mac/linux/windows) — orchestrator does NOT shell out via cmd.exe
// or bash; it calls python3 directly.
function makeSpawnStub({ rowsByModule = {}, status = 0 } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], cwd: opts?.cwd ?? null });
    if (cmd === 'python3') {
      // args: [parserPath, xmlPath, moduleName]
      const moduleName = args[2];
      const rows = rowsByModule[moduleName] ?? [];
      return {
        status,
        stdout: rows.join('\n'),
        stderr: '',
        signal: null,
        error: null,
      };
    }
    // Default: empty success.
    return { status: 0, stdout: '', stderr: '', signal: null, error: null };
  };
  fn.calls = calls;
  return fn;
}

// Drop a leftover XML at the expected Kover/JaCoCo location so findCoverageXml
// returns a non-null path. Content doesn't matter — the python3 stub returns
// canned rows regardless.
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
});

describe('expandNoCoverageAlias', () => {
  it('substitutes --no-coverage → --coverage-tool none', () => {
    expect(expandNoCoverageAlias(['--no-coverage'])).toEqual(['--coverage-tool', 'none']);
  });
  it('passes through other flags untouched', () => {
    expect(expandNoCoverageAlias(['--project-root', '/x', '--no-coverage', '--json']))
      .toEqual(['--project-root', '/x', '--coverage-tool', 'none', '--json']);
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

describe('coverageDisplayName', () => {
  it('maps tool keys to human names', () => {
    expect(coverageDisplayName('kover')).toBe('Kover');
    expect(coverageDisplayName('jacoco')).toBe('JaCoCo');
    expect(coverageDisplayName('none')).toBe('(none)');
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
});

// ---------------------------------------------------------------------------
// runCoverage integration
// ---------------------------------------------------------------------------

describe('runCoverage', () => {
  it('Kover-only project: modules_with_kover_plugin populated, modules_with_jacoco_plugin empty', async () => {
    const projectRoot = makeProject([{ name: 'mod-a', coverage: 'kover' }]);
    dropFakeXml(projectRoot, 'mod-a', 'kover');
    const spawn = makeSpawnStub({
      rowsByModule: {
        'mod-a': ['mod-a|pkg|Foo.kt|Foo|10|2|12|83.3|3,5'],
      },
    });
    const { envelope, exitCode } = await runCoverage({
      projectRoot,
      args: [],
      spawn,
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
    const spawn = makeSpawnStub({
      rowsByModule: {
        'mod-b': ['mod-b|pkg|Bar.kt|Bar|5|5|10|50.0|1,2,3,4,5'],
      },
    });
    const { envelope } = await runCoverage({
      projectRoot,
      args: [],
      spawn,
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
    const spawn = makeSpawnStub({
      rowsByModule: {
        'k1': ['k1|p|F.kt|F|1|1|2|50|2'],
        'j1': ['j1|p|G.kt|G|2|0|2|100|'],
      },
    });
    const { envelope } = await runCoverage({
      projectRoot,
      args: [],
      spawn,
    });
    expect(envelope.coverage.modules_with_kover_plugin).toEqual(['k1']);
    expect(envelope.coverage.modules_with_jacoco_plugin).toEqual(['j1']);
    expect(envelope.coverage.modules_contributing).toBe(2);
  });

  it('--coverage-tool none → coverage_aggregation_skipped warning, exit 0, no spawn', async () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    const spawn = makeSpawnStub();
    const { envelope, exitCode } = await runCoverage({
      projectRoot,
      args: ['--coverage-tool', 'none'],
      spawn,
    });
    expect(exitCode).toBe(0);
    expect(envelope.warnings).toHaveLength(1);
    expect(envelope.warnings[0].code).toBe('coverage_aggregation_skipped');
    expect(envelope.coverage.tool).toBe('none');
    expect(spawn.calls).toHaveLength(0);
  });

  it('--no-coverage alias → same effect as --coverage-tool none', async () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    const spawn = makeSpawnStub();
    const { envelope, exitCode } = await runCoverage({
      projectRoot,
      args: ['--no-coverage'],
      spawn,
    });
    expect(exitCode).toBe(0);
    expect(envelope.warnings[0].code).toBe('coverage_aggregation_skipped');
    expect(spawn.calls).toHaveLength(0);
  });

  it('no coverage plugins detected → no_coverage_data warning', async () => {
    const projectRoot = makeProject([{ name: 'plain' }]); // no kover, no jacoco
    const spawn = makeSpawnStub();
    const { envelope, exitCode } = await runCoverage({
      projectRoot,
      args: [],
      spawn,
    });
    expect(exitCode).toBe(0);
    expect(envelope.coverage.modules_contributing).toBe(0);
    expect(envelope.warnings.find(w => w.code === 'no_coverage_data')).toBeTruthy();
    expect(envelope.coverage.modules_with_kover_plugin).toEqual([]);
    expect(envelope.coverage.modules_with_jacoco_plugin).toEqual([]);
  });

  it('--dry-run → dry_run:true plus plan section, no fs writes for the report', async () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    const spawn = makeSpawnStub();
    const { envelope, exitCode } = await runCoverage({
      projectRoot,
      args: ['--dry-run'],
      spawn,
    });
    expect(exitCode).toBe(0);
    expect(envelope.dry_run).toBe(true);
    expect(envelope.plan).toBeTruthy();
    expect(envelope.plan.coverage_tool).toBe('auto');
    expect(spawn.calls).toHaveLength(0);
    // No report files written
    expect(existsSync(path.join(projectRoot, 'coverage-full-report.md'))).toBe(false);
  });

  it('writes Markdown report with versioned filename + legacy alias', async () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    dropFakeXml(projectRoot, 'a', 'kover');
    const spawn = makeSpawnStub({
      rowsByModule: { 'a': ['a|pkg|Foo.kt|Foo|9|1|10|90.0|7'] },
    });
    const { envelope } = await runCoverage({
      projectRoot,
      args: ['--output-file', 'coverage-full-report.md'],
      spawn,
      runId: 'TEST-RUN-ID',
    });
    expect(existsSync(path.join(projectRoot, 'coverage-full-report-TEST-RUN-ID.md'))).toBe(true);
    expect(existsSync(path.join(projectRoot, 'coverage-full-report.md'))).toBe(true);
    expect(envelope.coverage.missed_lines).toBe(1);
  });

  it('--exclude-coverage drops module from dispatched but keeps plugin classification', async () => {
    const projectRoot = makeProject([
      { name: 'a', coverage: 'kover' },
      { name: 'b', coverage: 'kover' },
    ]);
    dropFakeXml(projectRoot, 'a', 'kover');
    dropFakeXml(projectRoot, 'b', 'kover');
    const spawn = makeSpawnStub({
      rowsByModule: { 'a': ['a|p|F.kt|F|1|1|2|50|2'] },
    });
    const { envelope } = await runCoverage({
      projectRoot,
      args: ['--exclude-coverage', 'b'],
      spawn,
    });
    // Project-shape signal preserves both modules.
    expect(envelope.coverage.modules_with_kover_plugin).toEqual(['a', 'b']);
    // Only 'a' actually contributed XML → modules_contributing reflects it.
    expect(envelope.coverage.modules_contributing).toBe(1);
    // Python parser was only invoked for 'a'.
    const pythonCalls = spawn.calls.filter(c => c.cmd === 'python3');
    expect(pythonCalls.map(c => c.args[2])).toEqual(['a']);
  });

  it('cross-platform spawn shape: invokes python3 directly (no shell wrapper)', async () => {
    const projectRoot = makeProject([{ name: 'a', coverage: 'kover' }]);
    dropFakeXml(projectRoot, 'a', 'kover');
    const spawn = makeSpawnStub({
      rowsByModule: { 'a': ['a|p|F.kt|F|1|0|1|100|'] },
    });
    await runCoverage({ projectRoot, args: [], spawn });
    const pythonCalls = spawn.calls.filter(c => c.cmd === 'python3');
    expect(pythonCalls).toHaveLength(1);
    // No bash/cmd/powershell intermediary in the cmd field — parser is invoked
    // directly with [parserPath, xmlPath, moduleName].
    expect(pythonCalls[0].cmd).toBe('python3');
    expect(pythonCalls[0].args).toHaveLength(3);
    expect(pythonCalls[0].args[2]).toBe('a');
  });
});

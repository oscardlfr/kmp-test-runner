// SPDX-License-Identifier: MIT
// lib/parsers/script-output.js — parse stdout/stderr from the bash/PowerShell
// scripts (parallel/changed/coverage) and the Node-side android/benchmark
// orchestrator banners.
//
// cli.js re-exports through the `export {}` block at the bottom (live
// bindings) so existing consumers (cli.test.js, Pester
// Json-Envelope-Contract.Tests.ps1) keep importing from './cli.js' unchanged.

import { applyErrorCodeDiscriminators } from '../envelope/error-codes.js';
import { getCoverageToolFromArgs, getBenchmarkConfigFromArgs } from './argv.js';
import { buildProjectModel } from '../project-model.js';
import {
  parseArgs as parseParallelArgs,
  applyModuleFilters,
  canonicalModuleEntry,
  discoverParallelModules,
} from '../orchestrators/parallel-orchestrator.js';

// Strip ANSI escape codes (\x1b[...m) for output parsing.
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

// Shared signal pass: gradle 9 deprecation, BUILD FAILED/SUCCESSFUL.
// Mutates `state.deprecationSeen` / `state.buildFailedSeen` / `state.buildSuccessSeen`
// so per-subcommand parsers and the parse-gap fallback can branch on these.
function applySharedSignal(stdout, stderr, state) {
  const all = stdout + '\n' + stderr;

  // Gradle 9 deprecation notice — "[NOTICE] Gradle [(context)] exited with
  // code N but all M tasks passed individually." Emitted by parallel scripts
  // when the gradle daemon exits non-zero solely due to deprecation
  // warnings. Surface as warnings[], NOT errors[], so agents can branch on
  // real failures vs noise. Match BOTH `[NOTICE]` (current) and the legacy
  // `[!]` form. The optional `(context)` tag (v0.5.1, Bug C') lets the same
  // gate run against both the test-execution AND the coverage-gen passes;
  // matchAll picks up multiple NOTICE lines per run (one per pass).
  const deprecationRegex = /\[(?:NOTICE|!)\]\s+Gradle(?:\s*\(([^)]+)\))?\s+exited with code (\d+) but all (\d+) tasks passed individually/gi;
  for (const m of all.matchAll(deprecationRegex)) {
    const w = {
      code: 'gradle_deprecation',
      message: m[0].trim(),
      gradle_exit_code: +m[2],
      tasks_passed: +m[3],
    };
    if (m[1]) w.context = m[1];
    state.warnings.push(w);
    state.deprecationSeen = true;
  }

  // Bug E (v0.5.1): coverage report ran but zero modules produced data —
  // usually means the user has no kover/jacoco plugin applied to any module
  // and Bug B'' skipped them all. Surface as warnings[].code so agents can
  // suggest the kover/jacoco setup recipe.
  const noDataMatch = all.match(/\[!\]\s+No coverage data collected from any module[^\n]*/i);
  if (noDataMatch) {
    state.warnings.push({
      code: 'no_coverage_data',
      message: noDataMatch[0].trim(),
    });
  }

  // Bug E (v0.5.1): explicit machine-readable count of modules that
  // contributed coverage data. Populates coverage.modules_contributing so
  // agents can quantify "how many modules actually had coverage".
  const contribMatch = all.match(/COVERAGE_MODULES_CONTRIBUTING:\s*(\d+)/);
  if (contribMatch) {
    state.coverage.modules_contributing = +contribMatch[1];
  }

  // Best-effort: surface "BUILD FAILED" lines in errors[]. Skip when paired
  // with the deprecation NOTICE (gradle prints both, but logically it's a
  // warning, not an error).
  const buildFailedMatch = all.match(/BUILD FAILED[^\n]*/i);
  if (buildFailedMatch && !state.deprecationSeen) {
    state.errors.push({ message: buildFailedMatch[0].trim() });
    state.buildFailedSeen = true;
  }

  state.buildSuccessSeen = /BUILD SUCCESSFUL/i.test(all);
}

// android subcommand: parse the `=== JSON SUMMARY ===` block that
// run-android-tests.sh / Run-AndroidTests.ps1 emit at the end of the run.
// Falls back to scanning [PASS]/[FAIL] markers when the JSON block is
// missing (e.g. the script bailed before reaching the summary stage).
function parseAndroidSummary(stdout, state) {
  const marker = '=== JSON SUMMARY ===';
  const idx = stdout.indexOf(marker);
  if (idx < 0) {
    parseAndroidModuleTableFallback(stdout, state);
    return;
  }

  // Find the first '{' after the marker and walk balanced braces to the
  // matching '}'. Robust against trailing log lines after the JSON. If
  // brace-walking or JSON.parse fails, emit `json_summary_parse_failed` and
  // fall back to scanning the bracketed module-results table.
  const after = stdout.slice(idx + marker.length);
  const start = after.indexOf('{');
  let summary = null;
  if (start >= 0) {
    let depth = 0, end = -1;
    for (let i = start; i < after.length; i++) {
      if (after[i] === '{') depth++;
      else if (after[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end >= 0) {
      try {
        summary = JSON.parse(after.slice(start, end + 1));
      } catch {
        // fall through to warning below
      }
    }
  }
  if (!summary) {
    state.warnings.push({
      code: 'json_summary_parse_failed',
      message: 'Could not parse android JSON SUMMARY block',
    });
    parseAndroidModuleTableFallback(stdout, state);
    return;
  }

  state.tests.total = +(summary.totalTests ?? 0);
  state.tests.passed = +(summary.passedTests ?? 0);
  state.tests.failed = +(summary.failedTests ?? 0);
  if (Array.isArray(summary.modules)) {
    let skipped = 0;
    for (const m of summary.modules) skipped += +(m.testsSkipped ?? 0);
    state.tests.skipped = skipped;
    for (const m of summary.modules) {
      if (m.name) state.modules.push(m.name);
      if (m.status === 'FAIL') {
        const err = {
          code: 'module_failed',
          module: m.name,
          message: `[FAIL] ${m.name}`,
        };
        if (m.logFile) err.log_file = m.logFile;
        if (m.logcatFile) err.logcat_file = m.logcatFile;
        if (m.errorsFile) err.errors_file = m.errorsFile;
        state.errors.push(err);
      }
    }
  }
  state.androidSummarySeen = true;
}

function parseAndroidModuleTableFallback(stdout, state) {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*\[(PASS|FAIL|SKIP)\]\s+(\S+)/);
    if (!m) continue;
    if (!state.modules.includes(m[2])) state.modules.push(m[2]);
    if (m[1] === 'FAIL') {
      state.errors.push({
        code: 'module_failed',
        module: m[2],
        message: line.trim(),
      });
    }
  }
}

// benchmark subcommand: parse per-module `[OK]/[FAIL] <module> (<platform>)
// completed/failed` lines plus the `Result: X passed, Y failed` tally.
// Populates a top-level `benchmark` field on the envelope.
function parseBenchmarkSummary(stdout, stderr, args, state) {
  const all = stdout + '\n' + stderr;

  const seen = new Set();
  for (const line of all.split(/\r?\n/)) {
    const m = line.match(/\[(OK|FAIL)\]\s+(\S+)\s+\(([\w-]+)\)\s+(completed|failed)/);
    if (!m) continue;
    const mod = m[2];
    if (!seen.has(mod)) {
      seen.add(mod);
      state.modules.push(mod);
    }
    if (m[1] === 'FAIL') {
      state.errors.push({
        code: 'module_failed',
        module: mod,
        platform: m[3],
        message: line.trim(),
      });
    }
  }

  const tally = all.match(/Result:\s*(\d+)\s+passed,\s+(\d+)\s+failed/i);
  let passed = 0, failed = 0;
  if (tally) {
    passed = +tally[1];
    failed = +tally[2];
    state.tests.passed = passed;
    state.tests.failed = failed;
    state.tests.total = passed + failed;
    state.benchmarkTallySeen = true;
  }

  state.benchmark = {
    config: getBenchmarkConfigFromArgs(args),
    total: passed + failed,
    passed,
    failed,
  };
}

// Capture `[SKIP] <module> (<reason>)` lines emitted by the legacy wrapper
// (run-parallel-coverage-suite.{sh,ps1}) into `state.skipped[]`. Two emission
// sites: discovery-time skips go to stderr (`[SKIP] mod (excluded by ...)`,
// `[SKIP] mod (no test source set ...)`), test-task-time skips go to stdout
// (`  [SKIP] mod (no jvmTest tests)`). Match the canonical shape on both
// streams. Surfaces enough signal for downstream agents to suggest
// `--include-untested` or audit module-filter mistakes.
function parseSkippedModules(stdout, stderr, state) {
  const all = stdout + '\n' + stderr;
  const seen = new Set();
  for (const m of all.matchAll(/^\s*\[SKIP\]\s+(\S+)\s+\(([^)]+)\)\s*$/gm)) {
    const key = `${m[1]}|${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    state.skipped.push({ module: m[1], reason: m[2].trim() });
  }
}

// Legacy parser: parallel/changed/coverage subcommands all share this format.
// Preserves the v0.5.0 behavior: the four patterns the original
// parseScriptOutput recognized.
function parseLegacySummary(stdout, stderr, state) {
  const all = stdout + '\n' + stderr;

  // Pattern 1: "Tests: X total | Y passed | Z failed | W skipped"
  const summaryMatch = all.match(/Tests:\s*(\d+)\s+total\s*\|\s*(\d+)\s+passed\s*\|\s*(\d+)\s+failed\s*\|\s*(\d+)\s+skipped/i);
  if (summaryMatch) {
    state.tests.total = +summaryMatch[1];
    state.tests.passed = +summaryMatch[2];
    state.tests.failed = +summaryMatch[3];
    state.tests.skipped = +summaryMatch[4];
    state.legacySummarySeen = true;
  }

  // Pattern 2: "SUMMARY: X% total | Y lines missed | ..."
  const covMatch = all.match(/SUMMARY:\s*([\d.]+)%\s*total\s*\|\s*(\d+)\s+lines\s+missed/i);
  if (covMatch) state.coverage.missed_lines = +covMatch[2];

  // Pattern 3: module names from the "MODULE COVERAGE SUMMARY" table
  let inModuleTable = false;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/MODULE COVERAGE SUMMARY/.test(trimmed)) { inModuleTable = true; continue; }
    if (!inModuleTable) continue;
    if (/COVERAGE GAPS|^Tests:|^SUMMARY:/.test(trimmed)) break;
    const m = trimmed.match(/^([a-zA-Z][\w:.\-]*)\s+\d+(?:\.\d+)?%\s+\d+\s*$/);
    if (m && m[1] !== 'TOTAL' && m[1] !== 'MODULE') state.modules.push(m[1]);
  }
}

// Parse the bash/PowerShell script's stdout to extract test counts, modules,
// coverage, errors, and warnings. Dispatches to a per-subcommand parser
// (android emits a JSON block; benchmark emits a per-module table; the rest
// share a "Tests: X total | ..." summary line). When `subcommand` is omitted
// the legacy parser runs — preserves backward compatibility for callers that
// don't know which script produced the output.
//
// Best-effort: returns partial data + errors[] entry if a known pattern is
// missing.
function parseScriptOutput(stdoutRaw, stderrRaw, args, subcommand) {
  const stdout = stripAnsi(stdoutRaw || '');
  const stderr = stripAnsi(stderrRaw || '');

  const state = {
    tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
    modules: [],
    skipped: [],
    coverage: { tool: getCoverageToolFromArgs(args), missed_lines: null },
    errors: [],
    warnings: [],
    deprecationSeen: false,
    buildFailedSeen: false,
    buildSuccessSeen: false,
    legacySummarySeen: false,
    androidSummarySeen: false,
    benchmarkTallySeen: false,
  };

  applySharedSignal(stdout, stderr, state);

  if (subcommand === 'android') {
    parseAndroidSummary(stdout, state);
  } else if (subcommand === 'benchmark') {
    parseBenchmarkSummary(stdout, stderr, args, state);
  } else {
    parseLegacySummary(stdout, stderr, state);
  }

  parseSkippedModules(stdout, stderr, state);

  applyErrorCodeDiscriminators(stdout, stderr, state);

  // Parse-gap fallback: only when nothing recognizable parsed AND no shared
  // signal (build status, deprecation) appeared.
  const sawAnything =
    state.legacySummarySeen ||
    state.androidSummarySeen ||
    state.benchmarkTallySeen ||
    state.buildSuccessSeen ||
    state.buildFailedSeen ||
    state.deprecationSeen ||
    state.modules.length > 0 ||
    state.errors.length > 0;
  if (!sawAnything) {
    state.errors.push({ message: 'no recognizable test/build summary in script output', code: 'no_summary' });
  }

  const result = {
    tests: state.tests,
    modules: state.modules,
    skipped: state.skipped,
    coverage: state.coverage,
    errors: state.errors,
    warnings: state.warnings,
  };
  if (state.benchmark) result.benchmark = state.benchmark;
  return result;
}

// Resolve which modules WOULD be dispatched
// by `parallel` / `changed` (`changed` shares parallel-orchestrator's filter
// chain). Best-effort: returns null when the subcommand is not module-aware
// or when project-model loading fails. Pure read-only — no spawn, no gradle
// invocation, no side-effects on the project tree.
//
// Returns `{ modules: [{name,type,coverage_plugin,...}], skipped: [{module,reason}] }`
// — same shape as the `--list-only` short-circuit so agents can branch
// uniformly on dry-run / list-only / wet outputs.
function resolveDryRunModules(subcommand, projectRoot, finalArgs) {
  if (subcommand !== 'parallel' && subcommand !== 'changed') return null;
  try {
    const projectModel = buildProjectModel(projectRoot);
    // discoverParallelModules walks projectModel.modules (object keyed by
    // gradle path), strips the leading colon, and returns an array of
    // module objects with the shape expected by applyModuleFilters /
    // canonicalModuleEntry. Mirrors the wet-run discovery path so dry-run
    // module resolution stays in lockstep with what would actually run.
    const allModules = discoverParallelModules(projectModel);
    if (!allModules || allModules.length === 0) return null;
    const opts = parseParallelArgs(finalArgs);
    const { kept, skipped } = applyModuleFilters(allModules, opts, process.env);
    return {
      modules: kept.map(canonicalModuleEntry),
      skipped: skipped || [],
    };
  } catch {
    return null;
  }
}

export {
  stripAnsi,
  applySharedSignal,
  parseAndroidSummary,
  parseAndroidModuleTableFallback,
  parseBenchmarkSummary,
  parseSkippedModules,
  parseLegacySummary,
  parseScriptOutput,
  resolveDryRunModules,
};

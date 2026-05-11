#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/measure-token-cost.js — measure the token cost of three agent-friendly
// approaches to running KMP test/coverage/changed/benchmark workflows:
//
//   A. Raw Gradle + report parsing — what an agent without kmp-test would do:
//      invoke gradle directly (capturing stdout) AND read the generated report
//      files.
//   B. kmp-test <feature> — markdown-summarized stdout.
//   C. kmp-test <feature> --json — single JSON line on stdout.
//
// Each `--feature` reuses the same A/B/C shape but plugs in feature-specific
// gradle tasks, report globs, and module resolution. The default feature is
// `parallel` for backward compatibility with the v0.3.x single-feature script.
//
// Usage:
//   node tools/measure-token-cost.js \
//     --project-root /path/to/kmp/project \
//     --feature parallel \
//     --module-filter "module-name*" \
//     [--runs 3]
//
//   # Cross-model re-tokenisation (no gradle, reads tools/runs/<feature>/*.txt):
//   node tools/measure-token-cost.js \
//     --feature coverage \
//     --anthropic-models claude-opus-4-7,claude-sonnet-4-6,claude-haiku-4-5
//
//   # Multi-account workflows: set both keys, the tool auto-falls-back on 401:
//   export ANTHROPIC_API_KEY=sk-ant-account-A...
//   export ANTHROPIC_API_KEY_FALLBACK=sk-ant-account-B...
//   node tools/measure-token-cost.js --feature parallel \
//     --anthropic-models claude-opus-4-7
//
//   # One-shot CLI override (skips env entirely):
//   node tools/measure-token-cost.js --feature parallel \
//     --anthropic-models claude-opus-4-7 --anthropic-api-key sk-ant-...

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tiktoken } from 'js-tiktoken/lite';
import cl100kBase from 'js-tiktoken/ranks/cl100k_base';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const enc = new Tiktoken(cl100kBase);

// ---------------------------------------------------------------------------
// Feature registry
// ---------------------------------------------------------------------------

// Each entry describes how approach A is built for that feature: which gradle
// tasks to run per matched module, which generated files to slurp afterwards,
// and how to discover modules (most use the glob filter; `changed` uses git).
// Approach B/C just dispatch to `kmp-test <cliSubcommand> [--json]`.
// Feature shape:
//   skipApproachA       — true for kmp-test-only subcommands (info, describe)
//                         that have no raw-gradle equivalent. Approach A is
//                         skipped; only B+C captures are written.
//   acceptsModuleFilter — false when `kmp-test <subcommand>` doesn't accept
//                         `--module-filter`. info is the only such case today.
//                         Defaults to true elsewhere.
export const FEATURES = {
  parallel: {
    cliSubcommand: 'parallel',
    skipApproachA: false,
    acceptsModuleFilter: true,
    gradleTasksForModules: (modules, opts) =>
      modules.map((m) => `:${m}:${opts.testTask || 'test'}`),
    isReport: (full) =>
      (full.includes('build') && full.includes('reports') && full.includes('tests') && full.endsWith('.html')) ||
      (full.includes('build') && full.includes('test-results') && full.endsWith('.xml')),
    resolveModules: (projectRoot, opts) => filterModulesByGlob(projectRoot, opts.moduleFilter),
  },
  coverage: {
    cliSubcommand: 'coverage',
    skipApproachA: false,
    acceptsModuleFilter: true,
    gradleTasksForModules: (modules) =>
      modules.flatMap((m) => [`:${m}:koverXmlReport`, `:${m}:koverHtmlReport`]),
    isReport: (full) =>
      full.includes('build') && full.includes('reports') && full.includes('kover'),
    resolveModules: (projectRoot, opts) => filterModulesByGlob(projectRoot, opts.moduleFilter),
  },
  changed: {
    cliSubcommand: 'changed',
    skipApproachA: false,
    acceptsModuleFilter: true,
    gradleTasksForModules: (modules, opts) =>
      modules.map((m) => `:${m}:${opts.testTask || 'test'}`),
    isReport: (full) =>
      (full.includes('build') && full.includes('reports') && full.includes('tests') && full.endsWith('.html')) ||
      (full.includes('build') && full.includes('test-results') && full.endsWith('.xml')),
    // `changed` ignores the glob filter — modules come from git diff so the
    // measurement matches what `kmp-test changed` actually runs internally.
    resolveModules: (projectRoot, opts) => modulesFromGitDiff(projectRoot, opts.changedRange || 'HEAD~1..HEAD'),
  },
  benchmark: {
    cliSubcommand: 'benchmark',
    skipApproachA: false,
    acceptsModuleFilter: true,
    gradleTasksForModules: (modules, opts) =>
      modules.map((m) => `:${m}:${opts.benchmarkTask || 'jvmBenchmark'}`),
    isReport: (full) =>
      full.includes('build') && full.includes('reports') && full.includes('benchmarks') && full.endsWith('.json'),
    resolveModules: (projectRoot, opts) => filterModulesByGlob(projectRoot, opts.moduleFilter),
  },
  // v0.9 — agent-query subcommands. No raw-gradle baseline; B+C only.
  info: {
    cliSubcommand: 'info',
    skipApproachA: true,
    acceptsModuleFilter: false, // `kmp-test info` is global; rejects per-module filters
    gradleTasksForModules: () => [],
    isReport: () => false,
    resolveModules: () => [],
  },
  describe: {
    cliSubcommand: 'describe',
    skipApproachA: true,
    acceptsModuleFilter: true,
    gradleTasksForModules: () => [],
    isReport: () => false,
    resolveModules: () => [],
  },
};

export const VALID_FEATURES = Object.keys(FEATURES);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export function parseAnthropicModels(csv) {
  if (!csv) return [];
  return csv.split(',').map((s) => s.trim()).filter(Boolean);
}

export function parseArgs(argv) {
  // testTask: gradle task suffix appended to each matched module for approach A
  // when the feature uses a generic test invocation (parallel, changed). KMP
  // modules use ":desktopTest" / ":jvmTest"; plain JVM modules use ":test".
  // benchmarkTask: same idea but for the benchmark feature (jvmBenchmark by
  // default, can be overridden to nativeBenchmark or an Android variant).
  // changedRange: git revision range fed to `git diff --name-only` for the
  // changed feature. HEAD~1..HEAD by default — single-commit deltas.
  const out = {
    runs: 1,
    testTask: 'test',
    benchmarkTask: 'jvmBenchmark',
    changedRange: 'HEAD~1..HEAD',
    feature: 'parallel',
    anthropicModels: [],
    // anthropicApiKey: optional CLI override. When set, OVERRIDES both
    // ANTHROPIC_API_KEY env var and ANTHROPIC_API_KEY_FALLBACK fallback path
    // (one-shot escape hatch for measurement against an arbitrary account).
    anthropicApiKey: null,
    // projectsConfig: optional path to a JSON list of {path, label, bucket}.
    // When set (or the KMP_MEASUREMENT_PROJECTS env var or the conventional
    // gitignored path tools/.measurement-projects.json), the tool runs in
    // multi-project orchestration mode (PR #13).
    projectsConfig: null,
    // anthropicChunkBytes: override for CHUNK_THRESHOLD_BYTES. Lets ops dial
    // the chunked-counting threshold up or down depending on Anthropic's
    // observed payload limit. Pass 0 to disable chunking entirely (legacy).
    anthropicChunkBytes: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project-root' && argv[i + 1]) { out.projectRoot = argv[++i]; continue; }
    if (argv[i] === '--module-filter' && argv[i + 1]) { out.moduleFilter = argv[++i]; continue; }
    if (argv[i] === '--test-task' && argv[i + 1]) { out.testTask = argv[++i]; continue; }
    if (argv[i] === '--benchmark-task' && argv[i + 1]) { out.benchmarkTask = argv[++i]; continue; }
    if (argv[i] === '--changed-range' && argv[i + 1]) { out.changedRange = argv[++i]; continue; }
    if (argv[i] === '--feature' && argv[i + 1]) {
      const f = argv[++i];
      if (!VALID_FEATURES.includes(f)) {
        console.error(`Error: --feature must be one of: ${VALID_FEATURES.join(', ')} (got: ${f})`);
        process.exit(2);
      }
      out.feature = f;
      continue;
    }
    if (argv[i] === '--runs' && argv[i + 1]) { out.runs = parseInt(argv[++i], 10); continue; }
    if (argv[i] === '--anthropic-models' && argv[i + 1]) {
      out.anthropicModels = parseAnthropicModels(argv[++i]);
      continue;
    }
    if (argv[i] === '--anthropic-api-key' && argv[i + 1]) {
      out.anthropicApiKey = argv[++i];
      continue;
    }
    if (argv[i] === '--projects-config' && argv[i + 1]) {
      out.projectsConfig = argv[++i];
      continue;
    }
    if (argv[i] === '--anthropic-chunk-bytes' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!Number.isFinite(n) || n < 0) {
        console.error(`Error: --anthropic-chunk-bytes must be a non-negative integer (got: ${argv[i]})`);
        process.exit(2);
      }
      out.anthropicChunkBytes = n;
      continue;
    }
  }
  const envProjects = process.env.KMP_MEASUREMENT_PROJECTS || null;
  const conventionalConfig = path.join(repoRoot, 'tools', '.measurement-projects.json');
  const hasMultiProject = !!(out.projectsConfig || envProjects || existsSync(conventionalConfig));
  // --project-root is only required for single-project gradle mode. Cross-model
  // mode reads existing captures; multi-project mode resolves projects from the
  // config sources above (CLI > env > convention path).
  if (out.anthropicModels.length === 0 && !out.projectRoot && !hasMultiProject) {
    console.error('Usage: node tools/measure-token-cost.js --project-root <path> [--feature parallel|coverage|changed|benchmark|info|describe] [--module-filter <pat>] [--test-task <name>] [--benchmark-task <name>] [--changed-range <rev>] [--runs N]');
    console.error('       node tools/measure-token-cost.js [--feature <name>] --anthropic-models <csv> [--anthropic-api-key <key>]   # re-tokenise existing captures');
    console.error('       node tools/measure-token-cost.js --projects-config <path>   # multi-project size-bucketed orchestration (PR #13)');
    console.error('       Reads ANTHROPIC_API_KEY (primary) and ANTHROPIC_API_KEY_FALLBACK (auto-fallback on 401) from env.');
    console.error('       Reads KMP_MEASUREMENT_PROJECTS (newline-separated path|label|bucket) as a multi-project config alternative.');
    process.exit(2);
  }
  if (out.projectRoot) out.projectRoot = path.resolve(out.projectRoot);
  return out;
}

// ---------------------------------------------------------------------------
// Tokenisation + summary helpers
// ---------------------------------------------------------------------------

export function countTokensCl100k(text) {
  return enc.encode(text || '').length;
}

export function summarize(values) {
  if (values.length === 0) return { mean: 0, std: 0, min: 0, max: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return {
    mean: Math.round(mean),
    std: Math.round(Math.sqrt(variance)),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function fmt(n) {
  return n.toString().padStart(6, ' ');
}

// ---------------------------------------------------------------------------
// Module resolution — shared by features
// ---------------------------------------------------------------------------

export function filterModulesByGlob(projectRoot, moduleFilter) {
  // Walks the project root one level deep and keeps directories that look
  // like Gradle modules (own build.gradle.kts) and match the glob filter.
  // Returns module simple names (no leading colon).
  const filterRe = moduleFilter
    ? new RegExp('^' + moduleFilter.replace(/\*/g, '.*') + '$')
    : /.*/;
  const out = [];
  let entries;
  try { entries = readdirSync(projectRoot, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!filterRe.test(e.name)) continue;
    if (existsSync(path.join(projectRoot, e.name, 'build.gradle.kts'))) {
      out.push(e.name);
    }
  }
  return out;
}

export function modulesFromGitDiff(projectRoot, range) {
  // Returns the set of module simple names whose paths intersect the git diff
  // for the given revision range. Modules are detected by the same heuristic
  // as filterModulesByGlob (top-level dir with build.gradle.kts).
  const allModules = new Set(
    readdirSync(projectRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(projectRoot, e.name, 'build.gradle.kts')))
      .map((e) => e.name)
  );
  const r = spawnSync('git', ['diff', '--name-only', range], {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false,
  });
  const out = new Set();
  const lines = ((r.stdout || '') + '').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const top = line.split(/[\\/]/)[0];
    if (allModules.has(top)) out.add(top);
  }
  return [...out];
}

function readReportFiles(projectRoot, modules, isReport) {
  // Slurps every file under <projectRoot>/<module>/build/... that matches the
  // feature's `isReport` predicate. Limited to the resolved modules so the A
  // capture is faithful to what an agent would read after a real run.
  let collected = '';
  const moduleSet = new Set(modules);
  function walk(dir, depth = 0, topModule = null) {
    if (depth > 8) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.gradle', '.git'].includes(e.name)) continue;
        const nextTop = depth === 0 ? e.name : topModule;
        if (depth === 0 && !moduleSet.has(e.name)) continue;
        walk(full, depth + 1, nextTop);
      } else if (e.isFile()) {
        if (isReport(full)) {
          try { collected += '\n=== ' + full + ' ===\n' + readFileSync(full, 'utf8'); } catch { /* unreadable */ }
        }
      }
    }
  }
  walk(projectRoot);
  return collected;
}

// ---------------------------------------------------------------------------
// Approach runners
// ---------------------------------------------------------------------------

function spawnCapture(cmd, args, opts = {}) {
  // Use shell:false + absolute paths to dodge cmd.exe / MinGW interpretation
  // quirks. Without this, `gradlew.bat` from a bash-launched Node process
  // resolves to nothing on Windows ("no se reconoce como un comando interno").
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    shell: false,
    ...opts,
  });
  return (r.stdout || '') + (r.stderr || '');
}

export function buildApproachAInvocation(opts) {
  // Pure function: looks up the feature config and returns the spawn shape
  // (command, argv, cwd, resolved modules) without actually invoking gradle.
  // The runApproachA wrapper just adds spawnSync + report slurping on top.
  const feature = FEATURES[opts.feature];
  const wrapperName = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const wrapper = path.join(opts.projectRoot, wrapperName);
  const modules = feature.resolveModules(opts.projectRoot, opts);
  const tasks = modules.length > 0
    ? feature.gradleTasksForModules(modules, opts)
    : [`:${opts.testTask || 'test'}`]; // fall back to root-level task
  let cmd, cmdArgs;
  if (process.platform === 'win32') {
    cmd = process.env.COMSPEC || 'cmd.exe';
    cmdArgs = ['/c', wrapper, ...tasks, '--console=plain'];
  } else {
    cmd = wrapper;
    cmdArgs = [...tasks, '--console=plain'];
  }
  return { cmd, args: cmdArgs, cwd: opts.projectRoot, modules };
}

export function buildKmpTestCliInvocation(opts, withJson) {
  // Pure function: returns the spawn shape for `kmp-test <subcommand>
  // [--json] --project-root <…> [--module-filter <…>]`. Used by approach
  // B (withJson=false) and approach C (withJson=true).
  const feature = FEATURES[opts.feature];
  const cli = path.join(repoRoot, 'bin', 'kmp-test.js');
  const args = [feature.cliSubcommand];
  if (withJson) args.push('--json');
  args.push('--project-root', opts.projectRoot);
  if (opts.moduleFilter && feature.acceptsModuleFilter !== false) {
    args.push('--module-filter', opts.moduleFilter);
  }
  return { cmd: process.execPath, args: [cli, ...args] };
}

export function runApproachA(opts) {
  const inv = buildApproachAInvocation(opts);
  const stdout = spawnCapture(inv.cmd, inv.args, { cwd: inv.cwd });
  const reports = inv.modules.length > 0
    ? readReportFiles(opts.projectRoot, inv.modules, FEATURES[opts.feature].isReport)
    : '';
  return stdout + reports;
}

export function runApproachB(opts) {
  const inv = buildKmpTestCliInvocation(opts, false);
  return spawnCapture(inv.cmd, inv.args);
}

export function runApproachC(opts) {
  const inv = buildKmpTestCliInvocation(opts, true);
  return spawnCapture(inv.cmd, inv.args);
}

// ---------------------------------------------------------------------------
// Capture I/O
// ---------------------------------------------------------------------------

const CAPTURE_RE = /^([ABC])-.*-run(\d+)\.txt$/;
const CAPTURE_RE_SHORT = /^([ABC])-run(\d+)\.txt$/;

export function loadCaptures(runsDir) {
  // Returns [{ approach, file, runIndex, label, text }] sorted by
  // (approach, runIndex). Accepts both legacy `<A|B|C>-<label>-run<N>.txt`
  // and the cleaner per-feature subdir form `<A|B|C>-run<N>.txt`. Ignores
  // helper files like cross-model-results-*.txt.
  if (!existsSync(runsDir)) return [];
  const captures = [];
  for (const name of readdirSync(runsDir)) {
    const m = name.match(CAPTURE_RE) || name.match(CAPTURE_RE_SHORT);
    if (!m) continue;
    const fullPath = path.join(runsDir, name);
    let text;
    try { text = readFileSync(fullPath, 'utf8'); } catch { continue; }
    captures.push({
      approach: m[1],
      runIndex: parseInt(m[2], 10),
      file: name,
      label: name,
      text,
    });
  }
  captures.sort((a, b) =>
    a.approach.localeCompare(b.approach) || a.runIndex - b.runIndex
  );
  return captures;
}

export function featureRunsDir(feature) {
  return path.join(repoRoot, 'tools', 'runs', feature);
}

// ---------------------------------------------------------------------------
// Cross-model tokenisation
// ---------------------------------------------------------------------------

function simplifyAnthropicError(err) {
  // Normalise SDK errors into short reason strings for the table cell.
  // Anthropic.RateLimitError / AuthenticationError / BadRequestError all
  // extend APIError and carry .status. We avoid `instanceof` so the test
  // mock doesn't have to mirror the full class hierarchy.
  if (err && typeof err === 'object') {
    if (err.status === 429) return 'rate_limited';
    if (err.status === 401) return 'auth_failed';
    if (err.status === 404) return 'model_not_found';
    if (err.status === 400) {
      const msg = err.message || 'bad_request';
      return 'bad_request: ' + msg.slice(0, 80);
    }
    if (err.message) return err.message.slice(0, 80);
  }
  return String(err);
}

// Conservative cap below Anthropic's count_tokens payload limit. Empirically,
// requests above ~4 MB UTF-8 trip 413 too_large; 3.5 MiB leaves headroom.
// Override via opts.chunkBytes (or the --anthropic-chunk-bytes CLI flag).
export const CHUNK_THRESHOLD_BYTES = 3.5 * 1024 * 1024;

async function _countTokensAnthropicSingle(client, model, text, fallbackClient) {
  try {
    const r = await client.messages.countTokens({
      model,
      messages: [{ role: 'user', content: text }],
    });
    if (typeof r?.input_tokens !== 'number') {
      return { ok: false, error: 'no_input_tokens_in_response' };
    }
    return { ok: true, tokens: r.input_tokens };
  } catch (err) {
    const errCode = simplifyAnthropicError(err);
    if (errCode === 'auth_failed' && fallbackClient) {
      try {
        const r = await fallbackClient.messages.countTokens({
          model,
          messages: [{ role: 'user', content: text }],
        });
        if (typeof r?.input_tokens !== 'number') {
          return { ok: false, error: 'no_input_tokens_in_response', usedFallback: true };
        }
        return { ok: true, tokens: r.input_tokens, usedFallback: true };
      } catch (err2) {
        return { ok: false, error: simplifyAnthropicError(err2), usedFallback: true };
      }
    }
    return { ok: false, error: errCode };
  }
}

// Splits a payload into chunks of at most `opts.chunkBytes` UTF-8 bytes. Tries
// file-record boundaries (`\n=== <path> ===\n`) first — these appear in
// approach-A captures (concatenated test/coverage report files) and yield
// semantically-clean splits. Falls back to a byte-window slice when no
// boundaries are present (or only 1).
//
// Used by the chunked path of countTokensAnthropic to recover Anthropic-side
// token counts on payloads that would otherwise overflow count_tokens with
// a 413. BPE tokenisers are approximately additive across chunks (≤1 token
// of boundary error per chunk → <0.001% error at measurement scale).
export function splitForAnthropic(text, opts = {}) {
  const target = opts.chunkBytes ?? CHUNK_THRESHOLD_BYTES;
  const safeText = text || '';
  if (Buffer.byteLength(safeText, 'utf8') <= target) {
    return [safeText];
  }
  const sepRe = /\n=== [^\n]+ ===\n/g;
  const matches = [...safeText.matchAll(sepRe)];
  if (matches.length >= 2) {
    const out = [];
    let current = '';
    let lastEnd = 0;
    for (const m of matches) {
      const idx = m.index;
      const segment = safeText.slice(lastEnd, idx);
      lastEnd = idx;
      if (current && Buffer.byteLength(current + segment, 'utf8') > target) {
        out.push(current);
        current = segment;
      } else {
        current += segment;
      }
    }
    const tail = safeText.slice(lastEnd);
    if (current && Buffer.byteLength(current + tail, 'utf8') > target) {
      out.push(current);
      out.push(tail);
    } else {
      out.push(current + tail);
    }
    const filtered = out.filter((c) => c.length > 0);
    if (filtered.length >= 2) return filtered;
    // Fall through: boundaries didn't produce multiple chunks (single record
    // larger than target). Use the byte-window fallback below.
  }
  const out = [];
  let i = 0;
  while (i < safeText.length) {
    let bytes = 0;
    let j = i;
    while (j < safeText.length && bytes < target) {
      bytes += Buffer.byteLength(safeText[j], 'utf8');
      j++;
    }
    out.push(safeText.slice(i, j));
    i = j;
  }
  return out;
}

export async function countTokensAnthropic(client, model, text, fallbackClient = null, opts = {}) {
  // Wraps client.messages.countTokens in a per-call try/catch so one model's
  // failure (e.g. a typo'd model id) doesn't abort the whole run. The SDK
  // applies its own retry policy for 429/5xx before throwing.
  //
  // When `fallbackClient` is provided AND the primary client returns 401
  // (auth_failed), retry once on the fallback. Use case: the user has two
  // Anthropic accounts (ANTHROPIC_API_KEY + ANTHROPIC_API_KEY_FALLBACK) and
  // one of them has been rotated/revoked.
  //
  // When the payload exceeds CHUNK_THRESHOLD_BYTES (or `opts.chunkBytes`), the
  // text is split into chunks (file-record boundaries when present, byte-window
  // fallback otherwise) and counted per-chunk. The summed `input_tokens` is
  // returned with `chunked: true` and `chunks: <n>`. On any chunk failure the
  // call short-circuits with `failedChunkIndex: i` so partial counts don't
  // silently pollute aggregates. This recovers Anthropic-side measurements on
  // payloads that would otherwise return 413 too_large (PR #13, 2026-05-12).
  const threshold = opts.chunkBytes ?? CHUNK_THRESHOLD_BYTES;
  const safeText = text || '';
  if (Buffer.byteLength(safeText, 'utf8') <= threshold) {
    return _countTokensAnthropicSingle(client, model, safeText, fallbackClient);
  }
  const chunks = splitForAnthropic(safeText, { chunkBytes: threshold });
  let total = 0;
  let usedFallback = false;
  for (let i = 0; i < chunks.length; i++) {
    const r = await _countTokensAnthropicSingle(client, model, chunks[i], fallbackClient);
    if (!r.ok) {
      const out = {
        ok: false,
        error: r.error,
        chunked: true,
        chunks: chunks.length,
        failedChunkIndex: i,
      };
      if (r.usedFallback || usedFallback) out.usedFallback = true;
      return out;
    }
    total += r.tokens;
    if (r.usedFallback) usedFallback = true;
  }
  const out = { ok: true, tokens: total, chunked: true, chunks: chunks.length };
  if (usedFallback) out.usedFallback = true;
  return out;
}

// ---------------------------------------------------------------------------
// Multi-project orchestration (PR #13 — size-bucketed token-cost re-measurement)
// ---------------------------------------------------------------------------

const VALID_BUCKETS = ['small', 'medium', 'large'];

function validateProjectEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('project entry must be an object');
  }
  for (const f of ['path', 'label', 'bucket']) {
    if (typeof entry[f] !== 'string' || !entry[f]) {
      throw new Error(`project entry is missing ${f}`);
    }
  }
  if (!VALID_BUCKETS.includes(entry.bucket)) {
    throw new Error(`bucket must be one of ${VALID_BUCKETS.join('|')} (got ${entry.bucket})`);
  }
  return { path: entry.path, label: entry.label, bucket: entry.bucket };
}

export function parseProjectsConfigJson(jsonText) {
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed)) {
    throw new Error('expected array of {path, label, bucket}');
  }
  return parsed.map(validateProjectEntry);
}

export function parseProjectsConfigEnv(envValue) {
  return envValue
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('|');
      if (parts.length !== 3) {
        throw new Error(`bad line (expected path|label|bucket): ${line}`);
      }
      return validateProjectEntry({
        path: parts[0].trim(),
        label: parts[1].trim(),
        bucket: parts[2].trim(),
      });
    });
}

// Resolves a projects list from the first available source. Precedence:
//   1. cliPath        — explicit --projects-config <path>
//   2. envValue       — KMP_MEASUREMENT_PROJECTS env var (newline-separated)
//   3. conventionalPath — gitignored tools/.measurement-projects.json
// Returns null when no source resolves; the caller decides whether that's an
// error. Per the privacy hard rule (BACKLOG L608, 2026-05-11), the project
// list MUST come from one of these sources — never a hardcoded array.
export function resolveProjectsConfig({ cliPath, envValue, conventionalPath } = {}) {
  if (cliPath) {
    return parseProjectsConfigJson(readFileSync(cliPath, 'utf8'));
  }
  if (envValue) {
    return parseProjectsConfigEnv(envValue);
  }
  if (conventionalPath && existsSync(conventionalPath)) {
    return parseProjectsConfigJson(readFileSync(conventionalPath, 'utf8'));
  }
  return null;
}

// Bucket boundaries locked 2026-05-11 (BACKLOG L601). 1-5 small / 6-20 medium
// / 21+ large. Shared with classifyProjectModulesCount() callers so all
// committed outputs use the same labels.
export function classifyBucket(moduleCount) {
  if (moduleCount <= 5) return 'small';
  if (moduleCount <= 20) return 'medium';
  return 'large';
}

// Per-bucket aggregator: extends the per-feature `summarize()` shape with
// median + spread (max/min ratio expressed as a percentage). The README's
// 3-row bucket table consumes these fields directly.
export function summarizeBucket(values) {
  if (!values || values.length === 0) {
    return { mean: 0, median: 0, min: 0, max: 0, spread: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const spread = min > 0 ? Math.round(((max - min) / min) * 100) : 0;
  return { mean: Math.round(mean), median, min, max, spread };
}

// Aggregates per-project measurements into the bucket × feature × approach
// shape consumed by the README 3-row table. Input shape:
//   [{ label, bucket, perFeature: { <feat>: { A: {mean}, B: {mean}, C: {mean} }, ... } }, ...]
// (The per-approach fields just need a numeric `mean` — projects that ran
// multiple runs already pre-aggregated via summarize().) Output shape:
//   { small: { sample: [...labels], byFeature: { <feat>: {
//       approaches: { A|B|C: summarizeBucket(values across projects) },
//       ratios: { A_to_C: summarizeBucket(per-project A/C ratios) }
//     }}}, medium: {...}, large: {...} }
// Approaches that a feature skips (e.g. info/describe skip A) yield empty
// summaries — the formatter renders them as `-`.
export function aggregateByBucket(perProjectResults) {
  const out = {
    small: { sample: [], byFeature: {} },
    medium: { sample: [], byFeature: {} },
    large: { sample: [], byFeature: {} },
  };
  for (const project of perProjectResults || []) {
    const bucket = project.bucket;
    if (!out[bucket]) continue;
    out[bucket].sample.push(project.label);
    for (const [feature, approaches] of Object.entries(project.perFeature || {})) {
      if (!out[bucket].byFeature[feature]) {
        out[bucket].byFeature[feature] = { _raw: { A: [], B: [], C: [], ratios_A_C: [] } };
      }
      const slot = out[bucket].byFeature[feature]._raw;
      for (const a of ['A', 'B', 'C']) {
        const v = approaches?.[a]?.mean;
        if (typeof v === 'number') slot[a].push(v);
      }
      const aMean = approaches?.A?.mean;
      const cMean = approaches?.C?.mean;
      if (typeof aMean === 'number' && typeof cMean === 'number' && cMean > 0) {
        slot.ratios_A_C.push(aMean / cMean);
      }
    }
  }
  for (const bucket of VALID_BUCKETS) {
    for (const feature of Object.keys(out[bucket].byFeature)) {
      const raw = out[bucket].byFeature[feature]._raw;
      out[bucket].byFeature[feature] = {
        approaches: {
          A: summarizeBucket(raw.A),
          B: summarizeBucket(raw.B),
          C: summarizeBucket(raw.C),
        },
        ratios: { A_to_C: summarizeBucket(raw.ratios_A_C) },
      };
    }
  }
  return out;
}

function fmtRatio(n) {
  if (!Number.isFinite(n) || n <= 0) return '-';
  if (n >= 1000) return Math.round(n).toLocaleString('en-US') + '×';
  return n.toFixed(1) + '×';
}

// Renders the bucketed aggregate as a markdown report. Caller writes to disk
// at tools/runs/multi-project-token-cost-<date>/aggregate-<date>.md. The
// README's 3-row bucket table cross-links to this file as the underlying
// data. Anonymized labels (private-small-A etc.) MUST be used by the caller
// — formatAggregateReport does NOT scrub identifiers.
export function formatAggregateReport(byBucket, opts = {}) {
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const features = opts.features || [];
  const lines = [];
  lines.push(`# Multi-project token-cost aggregate (${date})`);
  lines.push('');
  lines.push('Token-cost reduction scales with project size. The table below shows median A→C ratio per bucket per feature, computed across the sample listed under each bucket.');
  lines.push('');
  lines.push('| Bucket | Sample (n) | Projects |');
  lines.push('|--------|-----------:|----------|');
  for (const bucket of VALID_BUCKETS) {
    const sample = byBucket[bucket]?.sample || [];
    const projectsList = sample.length ? sample.join(', ') : '_(empty)_';
    lines.push(`| ${bucket} | ${sample.length} | ${projectsList} |`);
  }
  lines.push('');
  for (const feature of features) {
    lines.push(`## Feature: ${feature}`);
    lines.push('');
    lines.push('| Bucket | A median | C median | A→C median | A→C range | A→C spread |');
    lines.push('|--------|---------:|---------:|-----------:|-----------|-----------:|');
    for (const bucket of VALID_BUCKETS) {
      const slot = byBucket[bucket]?.byFeature?.[feature];
      if (!slot) {
        lines.push(`| ${bucket} | - | - | - | - | - |`);
        continue;
      }
      const a = slot.approaches.A;
      const c = slot.approaches.C;
      const r = slot.ratios.A_to_C;
      const aTok = a.median > 0 ? a.median.toLocaleString('en-US') : '-';
      const cTok = c.median > 0 ? c.median.toLocaleString('en-US') : '-';
      const rMed = fmtRatio(r.median);
      const rRange = r.min > 0 && r.max > 0 ? `${fmtRatio(r.min)} – ${fmtRatio(r.max)}` : '-';
      const rSpread = r.spread > 0 ? `${r.spread}%` : '-';
      lines.push(`| ${bucket} | ${aTok} | ${cTok} | ${rMed} | ${rRange} | ${rSpread} |`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push(`Generated by \`tools/measure-token-cost.js --projects-config <path>\` on ${date}.`);
  lines.push('Per-project per-run captures are gitignored under `per-project/<label>/<feature>/{A,B,C}-run-N.txt`.');
  return lines.join('\n') + '\n';
}

// Per-project per-feature measurement loop. Returns the same shape as the
// per-approach object built inside runGradleMode, plus a `files` array of
// captured filenames. Side effects: writes captures into `runsDir`. Console
// output is intentionally suppressed — multi-project mode prints its own
// progress; single-project mode (runGradleMode) calls this then prints the
// detail tables.
function measureFeatureForProject(opts, runsDir) {
  if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
  const featureCfg = FEATURES[opts.feature];
  const approaches = [];
  if (!featureCfg.skipApproachA) {
    approaches.push({ id: 'A', label: `raw gradle + ${opts.feature} report parsing`, run: () => runApproachA(opts) });
  }
  approaches.push({ id: 'B', label: `kmp-test ${opts.feature} (markdown)`, run: () => runApproachB(opts) });
  approaches.push({ id: 'C', label: `kmp-test ${opts.feature} --json`,     run: () => runApproachC(opts) });

  const results = {};
  for (const a of approaches) {
    const tokens = [];
    const bytes = [];
    const durations = [];
    const files = [];
    for (let r = 1; r <= opts.runs; r++) {
      const fname = `${a.id}-run${r}.txt`;
      const t0 = Date.now();
      const output = a.run();
      const elapsed = Date.now() - t0;
      const outFile = path.join(runsDir, fname);
      writeFileSync(outFile, output, 'utf8');
      const tok = countTokensCl100k(output);
      tokens.push(tok);
      bytes.push(Buffer.byteLength(output, 'utf8'));
      durations.push(elapsed);
      files.push(outFile);
    }
    results[a.id] = {
      label: a.label,
      tokens: summarize(tokens),
      bytes: summarize(bytes),
      duration_ms: summarize(durations),
      files,
    };
  }
  return results;
}

// Multi-project orchestrator. Iterates over `projects` × features, captures
// per-(project, feature) per-approach token counts, and writes the bucketed
// aggregate markdown. Heavy I/O — invoked live during wet measurement
// (Sub-step 3 of PR #13). The caller is responsible for resolving project
// paths (resolveProjectsConfig) before invocation.
//
// Returns: { exitCode, aggregateFile, byBucket, perProjectResults, outRoot }
export async function runMultiProjectMode(opts, projects, sink = console) {
  const date = new Date().toISOString().slice(0, 10);
  const outRoot = path.join(repoRoot, 'tools', 'runs', `multi-project-token-cost-${date}`);
  mkdirSync(outRoot, { recursive: true });
  const features = opts.features && opts.features.length
    ? opts.features
    : VALID_FEATURES;
  const perProjectResults = [];
  for (const project of projects) {
    sink.error?.(`[multi] project: ${project.label} (bucket ${project.bucket}) — ${features.length} features`);
    const projectResult = { label: project.label, bucket: project.bucket, perFeature: {} };
    for (const feature of features) {
      const featureRunsDirOut = path.join(outRoot, 'per-project', project.label, feature);
      try {
        const approachResults = measureFeatureForProject(
          { ...opts, projectRoot: project.path, feature },
          featureRunsDirOut,
        );
        projectResult.perFeature[feature] = {
          A: approachResults.A?.tokens || { mean: 0 },
          B: approachResults.B?.tokens || { mean: 0 },
          C: approachResults.C?.tokens || { mean: 0 },
        };
        sink.error?.(`[multi]   ${feature}: A=${approachResults.A?.tokens?.mean ?? '-'} B=${approachResults.B?.tokens?.mean ?? '-'} C=${approachResults.C?.tokens?.mean ?? '-'}`);
      } catch (err) {
        sink.error?.(`[multi]   ${feature}: ERROR ${err.message}`);
        projectResult.perFeature[feature] = { A: { mean: 0 }, B: { mean: 0 }, C: { mean: 0 }, error: err.message };
      }
    }
    perProjectResults.push(projectResult);
  }
  const byBucket = aggregateByBucket(perProjectResults);
  const md = formatAggregateReport(byBucket, { date, features });
  const aggregateFile = path.join(outRoot, `aggregate-${date}.md`);
  writeFileSync(aggregateFile, md, 'utf8');
  sink.log?.('');
  sink.log?.(`Aggregate written: ${path.relative(repoRoot, aggregateFile).replace(/\\/g, '/')}`);
  return { exitCode: 0, aggregateFile, byBucket, perProjectResults, outRoot };
}

export function formatCrossModelTable(rows, models) {
  const headers = ['Approach', 'Capture', 'cl100k_base', ...models];
  const align = ['---', '---', '---:', ...models.map(() => '---:')];
  const lines = [];
  lines.push('| ' + headers.join(' | ') + ' |');
  lines.push('|' + align.map((a) => a).join('|') + '|');
  for (const row of rows) {
    const cells = [
      row.approach,
      '`' + row.file + '`',
      String(row.cl100k),
      ...models.map((m) => {
        const v = row.perModel[m];
        return v == null ? '-' : String(v);
      }),
    ];
    lines.push('| ' + cells.join(' | ') + ' |');
  }
  return lines.join('\n');
}

export function summariseCrossModelVariation(rows, models) {
  const out = [];
  for (const row of rows) {
    const numeric = models
      .map((m) => row.perModel[m])
      .filter((v) => typeof v === 'number');
    if (typeof row.cl100k === 'number') numeric.push(row.cl100k);
    if (numeric.length < 2) {
      out.push({ approach: row.approach, file: row.file, spreadPct: null });
      continue;
    }
    const min = Math.min(...numeric);
    const max = Math.max(...numeric);
    const spreadPct = min > 0 ? +(((max - min) / min) * 100).toFixed(1) : null;
    out.push({ approach: row.approach, file: row.file, spreadPct, min, max });
  }
  return out;
}

export async function runCrossModelMode(opts, sdkFactory, sink = console, runsDir, fallbackSdkFactory = null) {
  // sink: { log, error } — injected for tests so we can capture stdout/stderr.
  // sdkFactory: () => Anthropic-like client. Defaults to a real one in main().
  // runsDir: explicit override; when omitted, derived from opts.feature.
  // fallbackSdkFactory: optional () => Anthropic-like client. When set, used
  //   as a fallback when the primary client returns 401 (auth_failed). See
  //   countTokensAnthropic for the retry semantics.
  const dir = runsDir || featureRunsDir(opts.feature || 'parallel');
  const captures = loadCaptures(dir);
  if (captures.length === 0) {
    sink.error(
      `Error: no captures found in ${dir}. Run without --anthropic-models first to generate captures.`
    );
    return { exitCode: 2, rows: [], variation: [] };
  }
  const client = sdkFactory();
  const fallbackClient = fallbackSdkFactory ? fallbackSdkFactory() : null;
  // Pass through the optional --anthropic-chunk-bytes override; the chunked
  // path activates automatically when the payload exceeds the threshold.
  const countOpts = typeof opts.anthropicChunkBytes === 'number'
    ? { chunkBytes: opts.anthropicChunkBytes }
    : {};
  let sawFallbackUse = false;
  const rows = [];
  for (const cap of captures) {
    const cl100k = countTokensCl100k(cap.text);
    const perModel = {};
    for (const model of opts.anthropicModels) {
      sink.error(`[count] ${cap.file} × ${model}…`);
      const result = await countTokensAnthropic(client, model, cap.text, fallbackClient, countOpts);
      if (result.usedFallback && !sawFallbackUse) {
        sink.error('[note] primary ANTHROPIC_API_KEY returned 401; using ANTHROPIC_API_KEY_FALLBACK for the rest of this run');
        sawFallbackUse = true;
      }
      if (result.ok && result.chunked) {
        sink.error(`[chunk] ${cap.file} × ${model}: ${result.chunks} chunks, sum ${result.tokens} tokens`);
      }
      perModel[model] = result.ok ? result.tokens : `[error: ${result.error}${result.chunked ? ` chunk ${result.failedChunkIndex}/${result.chunks}` : ''}]`;
    }
    rows.push({ approach: cap.approach, file: cap.file, cl100k, perModel });
  }

  sink.log('');
  sink.log(`# Cross-model token-cost — feature: ${opts.feature || 'parallel'}`);
  sink.log('');
  sink.log(`Captures: ${captures.length} from \`${path.relative(repoRoot, dir).replace(/\\/g, '/')}/\``);
  sink.log(`Models: ${opts.anthropicModels.join(', ')}`);
  sink.log('Tokenizer: cl100k_base baseline + Anthropic `messages.countTokens` per model');
  sink.log('');
  sink.log(formatCrossModelTable(rows, opts.anthropicModels));
  sink.log('');

  const variation = summariseCrossModelVariation(rows, opts.anthropicModels);
  sink.log('## Cross-family variation');
  sink.log('');
  sink.log('| Approach | Capture | spread (max/min - 1) |');
  sink.log('|----------|---------|---------------------:|');
  for (const v of variation) {
    const cell = v.spreadPct == null ? 'n/a' : v.spreadPct + '%';
    sink.log(`| ${v.approach} | \`${v.file}\` | ${cell} |`);
  }
  sink.log('');
  const byApproach = { A: [], B: [], C: [] };
  for (const r of rows) byApproach[r.approach]?.push(r);
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const cAvg = (key) => avg((byApproach.C || []).map((r) => key === 'cl100k' ? r.cl100k : r.perModel[key]).filter((v) => typeof v === 'number'));
  const ratioFor = (approach, key) => {
    const c = cAvg(key);
    if (!c) return 'n/a';
    const aVals = byApproach[approach].map((r) => key === 'cl100k' ? r.cl100k : r.perModel[key]).filter((v) => typeof v === 'number');
    if (aVals.length === 0) return 'n/a';
    return (avg(aVals) / c).toFixed(1) + '×';
  };
  sink.log('## Approach ratio vs C (per tokenizer)');
  sink.log('');
  const ratioHeaders = ['Approach', 'cl100k_base', ...opts.anthropicModels];
  sink.log('| ' + ratioHeaders.join(' | ') + ' |');
  sink.log('|' + ratioHeaders.map(() => '---').join('|') + '|');
  for (const a of ['A', 'B', 'C']) {
    const cells = [
      a,
      ratioFor(a, 'cl100k'),
      ...opts.anthropicModels.map((m) => ratioFor(a, m)),
    ];
    sink.log('| ' + cells.join(' | ') + ' |');
  }
  sink.log('');
  sink.log(`Raw captures in \`${path.relative(repoRoot, dir).replace(/\\/g, '/')}/\`. Re-run with the same flag to refresh.`);

  return { exitCode: 0, rows, variation };
}

// ---------------------------------------------------------------------------
// Default-mode (gradle) main loop
// ---------------------------------------------------------------------------

function runGradleMode(opts) {
  const runsDir = featureRunsDir(opts.feature);
  const featureLabel = opts.feature;
  const results = measureFeatureForProject(opts, runsDir);
  for (const id of ['A', 'B', 'C']) {
    const r = results[id];
    if (!r) continue;
    for (const f of r.files) {
      console.error(`[run] ${id} → ${path.relative(repoRoot, f).replace(/\\/g, '/')}`);
    }
  }
  const ratio = (a, b) => b > 0 ? (a / b).toFixed(1) + 'x' : 'n/a';
  console.log('');
  console.log(`# Token-cost measurement (${opts.runs} run${opts.runs === 1 ? '' : 's'}) — feature: ${featureLabel}`);
  console.log('');
  console.log(`Project: \`${opts.projectRoot}\``);
  if (opts.moduleFilter) console.log(`Module filter: \`${opts.moduleFilter}\``);
  console.log(`Runs per approach: ${opts.runs}`);
  console.log(`Tokenizer: cl100k_base (OpenAI; relative comparison only)`);
  console.log('');
  console.log('| Approach | Tokens (mean) | Bytes (mean) | Duration (mean) | vs C |');
  console.log('|----------|--------------:|-------------:|----------------:|-----:|');
  const orderedIds = ['A', 'B', 'C'].filter((id) => results[id]);
  for (const id of orderedIds) {
    const r = results[id];
    const vsC = ratio(r.tokens.mean, results.C?.tokens?.mean || 0);
    console.log(`| **${id}** — ${r.label} | ${fmt(r.tokens.mean)} | ${fmt(r.bytes.mean)} | ${fmt(Math.round(r.duration_ms.mean / 1000))}s | ${vsC} |`);
  }
  console.log('');
  if (opts.runs > 1) {
    console.log('## Standard deviation (noise check)');
    console.log('');
    console.log('| Approach | Tokens std | min | max |');
    console.log('|----------|-----------:|----:|----:|');
    for (const id of orderedIds) {
      const r = results[id];
      console.log(`| ${id} | ${fmt(r.tokens.std)} | ${fmt(r.tokens.min)} | ${fmt(r.tokens.max)} |`);
    }
  }
  console.log('');
  console.log(`Raw run logs in \`tools/runs/${featureLabel}/\`.`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // Multi-project orchestration mode (PR #13). Wins over single-project gradle
  // mode when any of the 3 projects-config sources resolve to a non-empty list.
  // Cross-model mode still wins over multi-project when --anthropic-models is
  // also set — that combination would re-tokenise existing single-project
  // captures, not multi-project. Multi-project + cross-model is a v0.10+ idea.
  const conventionalConfig = path.join(repoRoot, 'tools', '.measurement-projects.json');
  const projects = opts.anthropicModels.length === 0
    ? resolveProjectsConfig({
        cliPath: opts.projectsConfig,
        envValue: process.env.KMP_MEASUREMENT_PROJECTS || null,
        conventionalPath: conventionalConfig,
      })
    : null;
  if (projects && projects.length > 0) {
    const result = await runMultiProjectMode(opts, projects, console);
    process.exit(result.exitCode);
  }

  if (opts.anthropicModels.length > 0) {
    // Key resolution precedence:
    //   1. --anthropic-api-key <key>    — CLI override (overrides both env vars)
    //   2. ANTHROPIC_API_KEY            — env primary
    //   3. ANTHROPIC_API_KEY_FALLBACK   — env secondary, used when primary returns 401
    const cliKey = opts.anthropicApiKey;
    const primaryKey = cliKey || process.env.ANTHROPIC_API_KEY;
    // When --anthropic-api-key is set, fallback is intentionally suppressed —
    // a CLI-supplied key is an explicit "use this and only this" choice.
    const fallbackKey = cliKey ? null : (process.env.ANTHROPIC_API_KEY_FALLBACK || null);

    if (!primaryKey) {
      console.error(
        'Error: --anthropic-models needs at least one Anthropic API key.\n' +
        '       Provide one of:\n' +
        '         --anthropic-api-key <key>          (CLI override; overrides env)\n' +
        '         export ANTHROPIC_API_KEY=sk-ant-…  (primary key)\n' +
        '       Optionally set ANTHROPIC_API_KEY_FALLBACK=sk-ant-… for automatic\n' +
        '       fallback when the primary returns 401 (multi-account workflows).'
      );
      process.exit(2);
    }

    const sdkFactory = () => new Anthropic({ apiKey: primaryKey });
    const fallbackSdkFactory = fallbackKey ? () => new Anthropic({ apiKey: fallbackKey }) : null;
    const result = await runCrossModelMode(opts, sdkFactory, console, undefined, fallbackSdkFactory);
    process.exit(result.exitCode);
  }
  runGradleMode(opts);
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

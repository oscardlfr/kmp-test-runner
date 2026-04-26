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
export const FEATURES = {
  parallel: {
    cliSubcommand: 'parallel',
    gradleTasksForModules: (modules, opts) =>
      modules.map((m) => `:${m}:${opts.testTask || 'test'}`),
    isReport: (full) =>
      (full.includes('build') && full.includes('reports') && full.includes('tests') && full.endsWith('.html')) ||
      (full.includes('build') && full.includes('test-results') && full.endsWith('.xml')),
    resolveModules: (projectRoot, opts) => filterModulesByGlob(projectRoot, opts.moduleFilter),
  },
  coverage: {
    cliSubcommand: 'coverage',
    gradleTasksForModules: (modules) =>
      modules.flatMap((m) => [`:${m}:koverXmlReport`, `:${m}:koverHtmlReport`]),
    isReport: (full) =>
      full.includes('build') && full.includes('reports') && full.includes('kover'),
    resolveModules: (projectRoot, opts) => filterModulesByGlob(projectRoot, opts.moduleFilter),
  },
  changed: {
    cliSubcommand: 'changed',
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
    gradleTasksForModules: (modules, opts) =>
      modules.map((m) => `:${m}:${opts.benchmarkTask || 'jvmBenchmark'}`),
    isReport: (full) =>
      full.includes('build') && full.includes('reports') && full.includes('benchmarks') && full.endsWith('.json'),
    resolveModules: (projectRoot, opts) => filterModulesByGlob(projectRoot, opts.moduleFilter),
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
  }
  // --project-root is only required for the gradle mode. In cross-model mode
  // we read existing captures from tools/runs/<feature>/ instead.
  if (out.anthropicModels.length === 0 && !out.projectRoot) {
    console.error('Usage: node tools/measure-token-cost.js --project-root <path> [--feature parallel|coverage|changed|benchmark] [--module-filter <pat>] [--test-task <name>] [--benchmark-task <name>] [--changed-range <rev>] [--runs N]');
    console.error('       node tools/measure-token-cost.js [--feature <name>] --anthropic-models <csv>   # re-tokenise existing captures');
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
  if (opts.moduleFilter) args.push('--module-filter', opts.moduleFilter);
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

export async function countTokensAnthropic(client, model, text) {
  // Wraps client.messages.countTokens in a per-call try/catch so one model's
  // failure (e.g. a typo'd model id) doesn't abort the whole run. The SDK
  // applies its own retry policy for 429/5xx before throwing.
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
    return { ok: false, error: simplifyAnthropicError(err) };
  }
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

export async function runCrossModelMode(opts, sdkFactory, sink = console, runsDir) {
  // sink: { log, error } — injected for tests so we can capture stdout/stderr.
  // sdkFactory: () => Anthropic-like client. Defaults to a real one in main().
  // runsDir: explicit override; when omitted, derived from opts.feature.
  const dir = runsDir || featureRunsDir(opts.feature || 'parallel');
  const captures = loadCaptures(dir);
  if (captures.length === 0) {
    sink.error(
      `Error: no captures found in ${dir}. Run without --anthropic-models first to generate captures.`
    );
    return { exitCode: 2, rows: [], variation: [] };
  }
  const client = sdkFactory();
  const rows = [];
  for (const cap of captures) {
    const cl100k = countTokensCl100k(cap.text);
    const perModel = {};
    for (const model of opts.anthropicModels) {
      sink.error(`[count] ${cap.file} × ${model}…`);
      const result = await countTokensAnthropic(client, model, cap.text);
      perModel[model] = result.ok ? result.tokens : `[error: ${result.error}]`;
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
  if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });

  const featureLabel = opts.feature;
  const approaches = [
    { id: 'A', label: `raw gradle + ${featureLabel} report parsing`, run: () => runApproachA(opts) },
    { id: 'B', label: `kmp-test ${featureLabel} (markdown)`,           run: () => runApproachB(opts) },
    { id: 'C', label: `kmp-test ${featureLabel} --json`,               run: () => runApproachC(opts) },
  ];

  const results = {};
  for (const a of approaches) {
    const tokens = [];
    const bytes = [];
    const durations = [];
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
      console.error(`[run] ${a.id} run ${r}: ${tok} tokens, ${Buffer.byteLength(output, 'utf8')} bytes, ${(elapsed/1000).toFixed(1)}s → ${path.relative(repoRoot, outFile).replace(/\\/g, '/')}`);
    }
    results[a.id] = {
      label: a.label,
      tokens: summarize(tokens),
      bytes: summarize(bytes),
      duration_ms: summarize(durations),
    };
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
  for (const id of ['A', 'B', 'C']) {
    const r = results[id];
    const vsC = ratio(r.tokens.mean, results.C.tokens.mean);
    console.log(`| **${id}** — ${r.label} | ${fmt(r.tokens.mean)} | ${fmt(r.bytes.mean)} | ${fmt(Math.round(r.duration_ms.mean / 1000))}s | ${vsC} |`);
  }
  console.log('');
  if (opts.runs > 1) {
    console.log('## Standard deviation (noise check)');
    console.log('');
    console.log('| Approach | Tokens std | min | max |');
    console.log('|----------|-----------:|----:|----:|');
    for (const id of ['A', 'B', 'C']) {
      const r = results[id];
      console.log(`| ${id} | ${fmt(r.tokens.std)} | ${fmt(r.tokens.min)} | ${fmt(r.tokens.max)} |`);
    }
  }
  console.log('');
  console.log(`Raw run logs in \`tools/runs/${featureLabel}/\`.`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.anthropicModels.length > 0) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error(
        'Error: --anthropic-models requires the ANTHROPIC_API_KEY environment variable.\n' +
        '       Set it in your shell, e.g. `export ANTHROPIC_API_KEY=sk-ant-…`'
      );
      process.exit(2);
    }
    const result = await runCrossModelMode(opts, () => new Anthropic());
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

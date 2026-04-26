#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// tools/measure-token-cost.js — measure the token cost of three agent-friendly
// approaches to running KMP tests:
//
//   A. Raw Gradle + report parsing — what an agent would do without kmp-test:
//      invoke gradle directly (capturing stdout) AND read the generated report
//      files (build/reports/tests/test/index.html + test-results/test/*.xml).
//   B. kmp-test parallel — markdown-summarized stdout.
//   C. kmp-test parallel --json — single JSON line on stdout.
//
// Default mode counts tokens with cl100k_base (OpenAI tokenizer). Pass
// `--anthropic-models <csv>` to skip the gradle run and re-tokenise the
// captures already present in `tools/runs/` via the Anthropic API's
// `messages.countTokens` endpoint per Claude 4.x model — this validates that
// the A/B/C ratio holds across the Claude family, not just on cl100k_base.
//
// Usage:
//   node tools/measure-token-cost.js \
//     --project-root /path/to/kmp/project \
//     --module-filter "module-name*" \
//     [--runs 3]
//
//   # Cross-model re-tokenisation (no gradle, reads tools/runs/*.txt):
//   node tools/measure-token-cost.js \
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

export function parseAnthropicModels(csv) {
  if (!csv) return [];
  return csv.split(',').map((s) => s.trim()).filter(Boolean);
}

export function parseArgs(argv) {
  // testTask: gradle task suffix appended to each matched module for approach A.
  // KMP modules use ":desktopTest" / ":jvmTest"; plain JVM modules use ":test".
  const out = { runs: 1, testTask: 'test', anthropicModels: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project-root' && argv[i + 1]) { out.projectRoot = argv[++i]; continue; }
    if (argv[i] === '--module-filter' && argv[i + 1]) { out.moduleFilter = argv[++i]; continue; }
    if (argv[i] === '--test-task' && argv[i + 1]) { out.testTask = argv[++i]; continue; }
    if (argv[i] === '--runs' && argv[i + 1]) { out.runs = parseInt(argv[++i], 10); continue; }
    if (argv[i] === '--anthropic-models' && argv[i + 1]) {
      out.anthropicModels = parseAnthropicModels(argv[++i]);
      continue;
    }
  }
  // --project-root is only required for the gradle mode. In cross-model mode
  // we read existing captures from tools/runs/ instead.
  if (out.anthropicModels.length === 0 && !out.projectRoot) {
    console.error('Usage: node tools/measure-token-cost.js --project-root <path> [--module-filter <pat>] [--test-task <name>] [--runs N]');
    console.error('       node tools/measure-token-cost.js --anthropic-models <csv>   # re-tokenise existing captures');
    process.exit(2);
  }
  if (out.projectRoot) out.projectRoot = path.resolve(out.projectRoot);
  return out;
}

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

function readReportFiles(projectRoot, moduleFilter) {
  // Walks <projectRoot>/<module>/build/reports/tests/test/index.html and
  // build/test-results/test/*.xml — what an agent reading "the test reports"
  // would consume after a raw gradle run. Limited to modules matching the
  // filter so the comparison stays fair.
  let collected = '';
  const filterRe = moduleFilter
    ? new RegExp('^' + moduleFilter.replace(/\*/g, '.*') + '$')
    : /.*/;
  function walk(dir, depth = 0) {
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.gradle', '.git'].includes(e.name)) continue;
        // Match `<projectRoot>/<simpleName>/build/...` against filter.
        if (depth === 0 && !filterRe.test(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        const isReport =
          (full.includes('build') && full.includes('reports') && full.endsWith('.html')) ||
          (full.includes('build') && full.includes('test-results') && full.endsWith('.xml'));
        if (isReport) {
          try { collected += '\n=== ' + full + ' ===\n' + readFileSync(full, 'utf8'); } catch {}
        }
      }
    }
  }
  walk(projectRoot);
  return collected;
}

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

function runApproachA(projectRoot, moduleFilter, testTask) {
  // Raw gradle: invoke `gradlew :module:<testTask>` (or matching modules) with
  // --console=plain so the agent gets the same noisy output it would in CI,
  // PLUS read every generated report file.
  const wrapperName = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const wrapper = path.join(projectRoot, wrapperName);
  // Translate module-filter glob into one or more :module:<testTask> args.
  const filterRe = moduleFilter
    ? new RegExp('^' + moduleFilter.replace(/\*/g, '.*') + '$')
    : /.*/;
  const tasks = [];
  for (const e of readdirSync(projectRoot, { withFileTypes: true })) {
    if (e.isDirectory() && filterRe.test(e.name)
        && existsSync(path.join(projectRoot, e.name, 'build.gradle.kts'))) {
      tasks.push(`:${e.name}:${testTask}`);
    }
  }
  if (tasks.length === 0) tasks.push(`:${testTask}`);
  // On Unix gradlew is a shell script; spawn directly with absolute path.
  // On Windows the .bat is invoked via cmd.exe to handle the .bat extension.
  let cmd, cmdArgs;
  if (process.platform === 'win32') {
    cmd = process.env.COMSPEC || 'cmd.exe';
    cmdArgs = ['/c', wrapper, ...tasks, '--console=plain'];
  } else {
    cmd = wrapper;
    cmdArgs = [...tasks, '--console=plain'];
  }
  const stdout = spawnCapture(cmd, cmdArgs, { cwd: projectRoot });
  const reports = readReportFiles(projectRoot, moduleFilter);
  return stdout + reports;
}

function runApproachB(projectRoot, moduleFilter) {
  const cli = path.join(repoRoot, 'bin', 'kmp-test.js');
  const args = ['parallel', '--project-root', projectRoot];
  if (moduleFilter) args.push('--module-filter', moduleFilter);
  return spawnCapture(process.execPath, [cli, ...args]);
}

function runApproachC(projectRoot, moduleFilter) {
  const cli = path.join(repoRoot, 'bin', 'kmp-test.js');
  const args = ['parallel', '--json', '--project-root', projectRoot];
  if (moduleFilter) args.push('--module-filter', moduleFilter);
  return spawnCapture(process.execPath, [cli, ...args]);
}

// Cross-model helpers ---------------------------------------------------------

const CAPTURE_RE = /^([ABC])-.*-run(\d+)\.txt$/;

export function loadCaptures(runsDir) {
  // Returns [{ approach: 'A', file, runIndex, label, text }, …] sorted by
  // (approach, runIndex). Only matches `<A|B|C>-<label>-run<N>.txt` so
  // helper outputs like cross-model-results.txt are skipped.
  if (!existsSync(runsDir)) return [];
  const captures = [];
  for (const name of readdirSync(runsDir)) {
    const m = name.match(CAPTURE_RE);
    if (!m) continue;
    const fullPath = path.join(runsDir, name);
    let text;
    try { text = readFileSync(fullPath, 'utf8'); } catch { continue; }
    captures.push({
      approach: m[1],
      runIndex: parseInt(m[2], 10),
      file: name,
      label: name.replace(CAPTURE_RE, '$1'), // approach letter only; we keep file for display
      text,
    });
  }
  captures.sort((a, b) =>
    a.approach.localeCompare(b.approach) || a.runIndex - b.runIndex
  );
  return captures;
}

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
      // Trim long upstream messages so the table stays narrow.
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
  // rows: [{ approach, file, cl100k, perModel: { [model]: number | "[error: ...]" } }]
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
  // Per-approach: max(over models) / min(over models) - 1, expressed as %.
  // Surfaces whether the family agrees within a tight band (low %) or
  // diverges meaningfully (high %).
  const out = [];
  for (const row of rows) {
    const numeric = models
      .map((m) => row.perModel[m])
      .filter((v) => typeof v === 'number');
    // Include cl100k as the baseline reference.
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
  // runsDir: override for tests; defaults to <repoRoot>/tools/runs.
  const dir = runsDir || path.join(repoRoot, 'tools', 'runs');
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
  sink.log('# Cross-model token-cost (re-tokenised existing captures)');
  sink.log('');
  sink.log(`Captures: ${captures.length} from \`tools/runs/\``);
  sink.log(`Models: ${opts.anthropicModels.join(', ')}`);
  sink.log('Tokenizer: cl100k_base baseline + Anthropic `messages.countTokens` per model');
  sink.log('');
  sink.log(formatCrossModelTable(rows, opts.anthropicModels));
  sink.log('');

  // Cross-family variation footer
  const variation = summariseCrossModelVariation(rows, opts.anthropicModels);
  sink.log('## Cross-family variation');
  sink.log('');
  sink.log('| Approach | Capture | spread (max/min − 1) |');
  sink.log('|----------|---------|---------------------:|');
  for (const v of variation) {
    const cell = v.spreadPct == null ? 'n/a' : v.spreadPct + '%';
    sink.log(`| ${v.approach} | \`${v.file}\` | ${cell} |`);
  }
  sink.log('');
  // Approach ratio across each model (vs C, like the cl100k table).
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
  sink.log('Raw captures in `tools/runs/`. Re-run with the same flag to refresh.');

  return { exitCode: 0, rows, variation };
}

// Default-mode (gradle) main loop --------------------------------------------

function runGradleMode(opts) {
  const runsDir = path.join(repoRoot, 'tools', 'runs');
  if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });

  const approaches = [
    { id: 'A', label: 'raw gradle + report parsing', run: (p, f) => runApproachA(p, f, opts.testTask) },
    { id: 'B', label: 'kmp-test parallel (markdown)', run: runApproachB },
    { id: 'C', label: 'kmp-test parallel --json', run: runApproachC },
  ];

  const results = {};
  for (const a of approaches) {
    const tokens = [];
    const bytes = [];
    const durations = [];
    for (let r = 1; r <= opts.runs; r++) {
      const label = `${a.id}-${a.label.replace(/[^a-z0-9]+/gi, '_')}-run${r}.txt`;
      const t0 = Date.now();
      const output = a.run(opts.projectRoot, opts.moduleFilter);
      const elapsed = Date.now() - t0;
      const outFile = path.join(runsDir, label);
      writeFileSync(outFile, output, 'utf8');
      const tok = countTokensCl100k(output);
      tokens.push(tok);
      bytes.push(Buffer.byteLength(output, 'utf8'));
      durations.push(elapsed);
      console.error(`[run] ${a.id} run ${r}: ${tok} tokens, ${Buffer.byteLength(output, 'utf8')} bytes, ${(elapsed/1000).toFixed(1)}s → ${path.relative(repoRoot, outFile)}`);
    }
    results[a.id] = {
      label: a.label,
      tokens: summarize(tokens),
      bytes: summarize(bytes),
      duration_ms: summarize(durations),
    };
  }

  // Markdown table on stdout
  const ratio = (a, b) => b > 0 ? (a / b).toFixed(1) + 'x' : 'n/a';
  console.log('');
  console.log(`# Token-cost measurement (${opts.runs} run${opts.runs === 1 ? '' : 's'})`);
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
  console.log('Raw run logs in `tools/runs/`.');
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

// Only auto-run when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

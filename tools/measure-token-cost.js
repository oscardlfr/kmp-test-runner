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
// Tokens are counted with cl100k_base (OpenAI tokenizer; close enough to
// Anthropic's tokenizer for relative comparison — the ratio between A/B/C is
// what matters, not the absolute count). Repeat N runs per approach for
// noise-robustness; report mean ± std.
//
// Usage:
//   node tools/measure-token-cost.js \
//     --project-root /path/to/kmp/project \
//     --module-filter "module-name*" \
//     [--runs 3]
//
// Example:
//   node tools/measure-token-cost.js \
//     --project-root ../dipatternsdemo \
//     --module-filter "di-contracts*"

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tiktoken } from 'js-tiktoken/lite';
import cl100kBase from 'js-tiktoken/ranks/cl100k_base';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const enc = new Tiktoken(cl100kBase);

function parseArgs(argv) {
  // testTask: gradle task suffix appended to each matched module for approach A.
  // KMP modules use ":desktopTest" / ":jvmTest"; plain JVM modules use ":test".
  const out = { runs: 1, testTask: 'test' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project-root' && argv[i + 1]) { out.projectRoot = argv[++i]; continue; }
    if (argv[i] === '--module-filter' && argv[i + 1]) { out.moduleFilter = argv[++i]; continue; }
    if (argv[i] === '--test-task' && argv[i + 1]) { out.testTask = argv[++i]; continue; }
    if (argv[i] === '--runs' && argv[i + 1]) { out.runs = parseInt(argv[++i], 10); continue; }
  }
  if (!out.projectRoot) {
    console.error('Usage: node tools/measure-token-cost.js --project-root <path> [--module-filter <pat>] [--test-task <name>] [--runs N]');
    process.exit(2);
  }
  out.projectRoot = path.resolve(out.projectRoot);
  return out;
}

function countTokens(text) {
  return enc.encode(text || '').length;
}

function summarize(values) {
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
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
      const tok = countTokens(output);
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

main();

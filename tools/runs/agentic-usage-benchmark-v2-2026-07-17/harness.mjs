#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/runs/agentic-usage-benchmark-v2-2026-07-17/harness.mjs
//
// Measurement-local evidence harness for THIS run directory only -- not
// product tooling under tools/, not vitest-covered, not a shipped CLI
// feature (same "evidence, not shipped tooling" line
// docs/agentic-usage-measurement.md's own "Registry relationship" section
// draws). Every benchmark cell in this run (raw-gradle-no-kmp /
// kmp-test-json, either project) routes every real shell command through
// this script instead of hand-rolling its own timing wrapper -- see
// ../agentic-usage-pilot-2026-07-17.md's Interpretation section for the
// confound this exists to close: two independent hand-rolled PowerShell
// wrapper bugs in the v1 pilot both landed in raw-gradle cells and zero
// kmp-test-json cells, making that pilot's wall-clock/command numbers
// unsafe to read as clean condition effects.
//
// Usage:
//   node harness.mjs --log <path/to/cell.jsonl> [--note <text>] -- <command> [args...]
//   node harness.mjs --verify <run-dir>
//
// Log line shape (one JSON object per line, appended):
//   { n, cmd, exit_code, duration_ms, stdout_bytes, stderr_bytes, note? }
//
// --log mode:
//   - Spawns <command> [args...] with shell:false (args passed as a real
//     array -- no shell quoting/injection surface) and cwd = this
//     process's own cwd (the calling agent must `cd` into its assigned
//     worktree BEFORE invoking the harness).
//   - Streams the child's stdout/stderr through to this process's own
//     stdout/stderr in real time, so the calling agent still sees normal
//     command output and can react to it. Streamed content is never
//     redacted (only the logged cmd/note fields are) -- stdout/stderr are
//     recorded as byte counts only, never as content, so no leak surface.
//   - Measures wall-clock duration via process.hrtime.bigint().
//   - `n` is the next integer after the current line count of the log
//     file (0 if the file doesn't exist yet) -- safe because this process
//     is the sole writer for the single command it's running; there is no
//     concurrent-write race the way there was in v1's hand-rolled
//     PowerShell wrapper (see Note 1 of the v1 pilot doc).
//   - `cmd` (and `note`, if given) are redacted via PUBLIC_SHAPE_RULES from
//     tools/lib/redact.mjs before ever touching disk.
//   - Appends exactly one JSON line, then exits with the child's own real
//     exit code (-1 if the child was killed by a signal) so a calling
//     agent's normal error handling/retry logic still works on top of the
//     harness.
//
// --verify mode (fails closed):
//   - Scans <run-dir> for every *.jsonl file.
//   - Every line must parse as JSON AND have all required fields present
//     with correct types -- a line that parses but is missing/mistypes a
//     field is a FAILURE, not just a line that fails JSON.parse.
//   - If <run-dir>/summary.json exists (array of per-cell objects with a
//     `cell` field matching `<cell>.jsonl`), cross-checks its
//     commands_total/stdout_bytes_total/stderr_bytes_total against the
//     matching file's own true sums.
//   - Exits 0 only if every file parses clean AND every cross-check
//     matches; exits 1 otherwise, printing every discrepancy.

import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolved via import.meta.url, never cwd-relative -- correct regardless of
// where the harness is invoked from (a different worktree's directory).
// pathToFileURL is required on Windows: dynamic import() rejects a raw
// "C:\..." path (ERR_UNSUPPORTED_ESM_URL_SCHEME), it needs a real file:// URL.
const { PUBLIC_SHAPE_RULES, redactText } = await import(
  pathToFileURL(path.resolve(__dirname, '../../lib/redact.mjs')).href
);

const REQUIRED_FIELDS = {
  n: 'number',
  cmd: 'string',
  exit_code: 'number',
  duration_ms: 'number',
  stdout_bytes: 'number',
  stderr_bytes: 'number',
};

function die(msg) {
  process.stderr.write(`harness: ${msg}\n`);
  process.exit(1);
}

function countExistingLines(logPath) {
  if (!existsSync(logPath)) return 0;
  const body = readFileSync(logPath, 'utf8');
  return body.split('\n').filter((l) => l.trim().length > 0).length;
}

async function runLogMode(argv) {
  let logPath = null;
  let note = null;
  let sepIdx = -1;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--log') { logPath = argv[i + 1]; i++; continue; }
    if (argv[i] === '--note') { note = argv[i + 1]; i++; continue; }
    if (argv[i] === '--') { sepIdx = i; break; }
  }

  if (!logPath) die('--log <path.jsonl> is required');
  if (sepIdx === -1) die('missing "--" separator before the command to run');

  const commandArgs = argv.slice(sepIdx + 1);
  if (commandArgs.length === 0) die('no command given after "--"');

  const [cmd, ...cmdArgs] = commandArgs;
  const n = countExistingLines(logPath) + 1;

  let stdoutBytes = 0;
  let stderrBytes = 0;

  const start = process.hrtime.bigint();

  // .bat/.cmd files are not directly executable by Windows' CreateProcess --
  // spawn() with shell:false throws EINVAL for them (documented Node/Windows
  // limitation: batch files need a shell to interpret them). gradlew.bat is
  // exactly this case for every raw-gradle-no-kmp cell on this Windows host.
  // {shell:true} "fixes" the EINVAL but trades it for Node's own DEP0190
  // warning (args get concatenated, not escaped -- a real injection risk),
  // and driving cmd.exe directly hit inconsistent argv handling under this
  // Git Bash environment. Instead, route through `bash -c` with each
  // argument POSIX-quoted ourselves: this repo's own shell IS Git Bash
  // (confirmed it runs ./gradlew.bat correctly via its MSYS layer), bash.exe
  // is a normal spawnable executable (no shell:true needed for it), and
  // explicit quoting -- not shell:true's implicit concatenation -- is what
  // actually keeps this safe.
  const isWindowsBatch = process.platform === 'win32' && /\.(bat|cmd)$/i.test(cmd);
  const shQuote = (arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`;
  const spawnCmd = isWindowsBatch ? 'bash' : cmd;
  const spawnArgs = isWindowsBatch
    ? ['-c', [cmd, ...cmdArgs].map(shQuote).join(' ')]
    : cmdArgs;

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(spawnCmd, spawnArgs, { shell: false, stdio: ['inherit', 'pipe', 'pipe'] });

    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      process.stderr.write(chunk);
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve(code === null ? (signal ? -1 : 1) : code);
    });
  });

  const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);

  const rawCmdString = [cmd, ...cmdArgs].join(' ');
  const redactedCmd = redactText(rawCmdString, PUBLIC_SHAPE_RULES);
  const redactedNote = note != null ? redactText(note, PUBLIC_SHAPE_RULES) : undefined;

  const line = {
    n,
    cmd: redactedCmd,
    exit_code: exitCode,
    duration_ms: durationMs,
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderrBytes,
    ...(redactedNote !== undefined ? { note: redactedNote } : {}),
  };

  appendFileSync(logPath, JSON.stringify(line) + '\n', 'utf8');

  process.exit(exitCode);
}

function verifyFile(absPath) {
  const body = readFileSync(absPath, 'utf8');
  const lines = body.split('\n').filter((l) => l.trim().length > 0);
  const errors = [];
  const parsed = [];

  lines.forEach((line, idx) => {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      errors.push(`line ${idx + 1}: invalid JSON (${err.message})`);
      return;
    }
    for (const [field, type] of Object.entries(REQUIRED_FIELDS)) {
      if (!(field in obj)) {
        errors.push(`line ${idx + 1}: missing required field "${field}"`);
      } else if (typeof obj[field] !== type) {
        errors.push(
          `line ${idx + 1}: field "${field}" has type ${typeof obj[field]}, expected ${type}`,
        );
      }
    }
    parsed.push(obj);
  });

  const sums = parsed.reduce(
    (acc, o) => ({
      commands_total: acc.commands_total + 1,
      stdout_bytes_total: acc.stdout_bytes_total + (o.stdout_bytes || 0),
      stderr_bytes_total: acc.stderr_bytes_total + (o.stderr_bytes || 0),
    }),
    { commands_total: 0, stdout_bytes_total: 0, stderr_bytes_total: 0 },
  );

  return { errors, sums, lineCount: lines.length };
}

function runVerifyMode(argv) {
  const runDir = argv[0];
  if (!runDir) die('--verify <run-dir> requires a directory path');
  if (!existsSync(runDir)) die(`run directory does not exist: ${runDir}`);

  const jsonlFiles = readdirSync(runDir).filter((f) => f.endsWith('.jsonl'));
  if (jsonlFiles.length === 0) die(`no .jsonl files found in ${runDir}`);

  let anyFailure = false;
  const fileSums = {};

  for (const file of jsonlFiles) {
    const absPath = path.join(runDir, file);
    const { errors, sums, lineCount } = verifyFile(absPath);
    fileSums[file] = sums;
    if (errors.length > 0) {
      anyFailure = true;
      console.error(`FAIL ${file} (${lineCount} lines):`);
      for (const e of errors) console.error(`  ${e}`);
    } else {
      console.log(`OK   ${file} (${lineCount} lines, ${JSON.stringify(sums)})`);
    }
  }

  const summaryPath = path.join(runDir, 'summary.json');
  if (existsSync(summaryPath)) {
    let summary;
    try {
      summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    } catch (err) {
      console.error(`FAIL summary.json: invalid JSON (${err.message})`);
      anyFailure = true;
      summary = null;
    }
    if (Array.isArray(summary)) {
      for (const cell of summary) {
        const file = `${cell.cell}.jsonl`;
        const computed = fileSums[file];
        if (!computed) {
          console.error(`FAIL summary.json: cell "${cell.cell}" has no matching ${file} in ${runDir}`);
          anyFailure = true;
          continue;
        }
        for (const key of ['commands_total', 'stdout_bytes_total', 'stderr_bytes_total']) {
          if (cell[key] !== computed[key]) {
            console.error(
              `FAIL summary.json: cell "${cell.cell}" field "${key}" = ${cell[key]}, ` +
              `but ${file} sums to ${computed[key]}`,
            );
            anyFailure = true;
          }
        }
      }
    }
  } else {
    console.log('(no summary.json present yet -- skipping cross-check)');
  }

  process.exit(anyFailure ? 1 : 0);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--verify') {
    runVerifyMode(argv.slice(1));
    return;
  }
  await runLogMode(argv);
}

main();

// SPDX-License-Identifier: Apache-2.0
// lib/cli.js — pure ESM module with all CLI logic for kmp-test-runner

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 5 subcommands → (sh-script-name, ps1-script-name, extra-prefix-args)
const COMMANDS = {
  parallel:  { sh: 'run-parallel-coverage-suite.sh',  ps1: 'run-parallel-coverage-suite.ps1',  prefix: [] },
  changed:   { sh: 'run-changed-modules-tests.sh',    ps1: 'run-changed-modules-tests.ps1',    prefix: [] },
  android:   { sh: 'run-android-tests.sh',             ps1: 'run-android-tests.ps1',             prefix: [] },
  benchmark: { sh: 'run-benchmarks.sh',                ps1: 'run-benchmarks.ps1',                prefix: [] },
  coverage:  { sh: 'run-parallel-coverage-suite.sh',   ps1: 'run-parallel-coverage-suite.ps1',   prefix: ['--skip-tests'] },
};

function readVersion() {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  return pkg.version;
}

function printHelp() {
  process.stdout.write(`kmp-test-runner — KMP/Android parallel test runner

Usage: kmp-test <subcommand> [--project-root <path>] [args...]

Subcommands:
  parallel   Run all tests in parallel with coverage
  changed    Run tests only for modules with uncommitted changes
  android    Run Android instrumented tests
  benchmark  Run benchmark suites
  coverage   Generate coverage report (skips test execution)

Options:
  --project-root <path>  Project root directory (default: cwd)
  --help                 Show this message
  --version              Print version
`);
}

function ensureProjectRoot(args) {
  const idx = args.indexOf('--project-root');
  if (idx === -1) {
    return ['--project-root', process.cwd(), ...args];
  }
  return args;
}

function pickWindowsShell() {
  const probe = spawnSync('pwsh', ['-NoLogo', '-Command', '$null'], { stdio: 'ignore' });
  if (probe.status === 0) return 'pwsh';
  return 'powershell.exe';
}

// Translates a long-form bash flag (--project-root) to PowerShell PascalCase (-ProjectRoot).
// Values and positional args pass through unchanged.
function translateFlagForPowerShell(arg) {
  if (typeof arg !== 'string' || !arg.startsWith('--')) return arg;
  const rest = arg.slice(2);
  return '-' + rest.split('-')
    .map(w => w.length === 0 ? '' : w[0].toUpperCase() + w.slice(1))
    .join('');
}

function resolveScript(sub, platform) {
  const cmd = COMMANDS[sub];
  if (!cmd) return null;
  return {
    script: platform === 'win32' ? cmd.ps1 : cmd.sh,
    prefix: cmd.prefix,
  };
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    printHelp();
    return 2;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(readVersion() + '\n');
    return 0;
  }

  const sub = argv[0];
  const cmd = COMMANDS[sub];
  if (!cmd) {
    process.stderr.write(`kmp-test: unknown subcommand '${sub}'\n`);
    printHelp();
    return 2;
  }

  const rest = argv.slice(1);
  const withProjectRoot = ensureProjectRoot(rest);
  const finalArgs = [...cmd.prefix, ...withProjectRoot];

  const isWin = process.platform === 'win32';
  const scriptsDir = path.join(__dirname, '..', 'scripts');

  let spawnCmd, spawnArgs;
  if (isWin) {
    const shell = pickWindowsShell();
    const scriptPath = path.join(scriptsDir, 'ps1', cmd.ps1);
    const translatedArgs = finalArgs.map(translateFlagForPowerShell);
    spawnCmd = shell;
    spawnArgs = ['-NoLogo', '-NoProfile', '-File', scriptPath, ...translatedArgs];
  } else {
    const scriptPath = path.join(scriptsDir, 'sh', cmd.sh);
    spawnCmd = 'bash';
    spawnArgs = [scriptPath, ...finalArgs];
  }

  const result = spawnSync(spawnCmd, spawnArgs, { stdio: 'inherit' });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      const missing = isWin ? 'pwsh/powershell' : 'bash';
      process.stderr.write(`kmp-test: '${missing}' not found on PATH. Install PowerShell (Windows) or bash (Unix).\n`);
      return 127;
    }
    process.stderr.write(`kmp-test: failed to spawn '${spawnCmd}': ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

export { main, COMMANDS, resolveScript, pickWindowsShell, translateFlagForPowerShell, ensureProjectRoot, readVersion, printHelp };

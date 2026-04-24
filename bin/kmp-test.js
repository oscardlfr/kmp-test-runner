#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// bin/kmp-test.js — OS-dispatching CLI for kmp-test-runner

const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

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
  // --project-root default to cwd if not provided
  const idx = args.indexOf('--project-root');
  if (idx === -1) {
    return ['--project-root', process.cwd(), ...args];
  }
  return args;
}

function pickWindowsShell() {
  // Try pwsh first, fall back to powershell.exe
  const probe = spawnSync('pwsh', ['-NoLogo', '-Command', '$null'], { stdio: 'ignore' });
  if (probe.status === 0) return 'pwsh';
  return 'powershell.exe';
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    process.exit(argv.length === 0 ? 2 : 0);
  }

  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(readVersion() + '\n');
    process.exit(0);
  }

  const sub = argv[0];
  const cmd = COMMANDS[sub];
  if (!cmd) {
    process.stderr.write(`kmp-test: unknown subcommand '${sub}'\n`);
    printHelp();
    process.exit(2);
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
    spawnCmd = shell;
    spawnArgs = ['-NoLogo', '-NoProfile', '-File', scriptPath, ...finalArgs];
  } else {
    const scriptPath = path.join(scriptsDir, 'sh', cmd.sh);
    spawnCmd = 'bash';
    spawnArgs = [scriptPath, ...finalArgs];
  }

  const result = spawnSync(spawnCmd, spawnArgs, { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`kmp-test: failed to spawn '${spawnCmd}': ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

main();

// SPDX-License-Identifier: Apache-2.0
// lib/cli.js — pure ESM module with all CLI logic for kmp-test-runner

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Semantic exit codes (documented in --help and README)
const EXIT = {
  SUCCESS: 0,        // all tests passed
  TEST_FAIL: 1,      // script ran, tests failed
  CONFIG_ERROR: 2,   // bad CLI usage (unknown subcommand, missing arg)
  ENV_ERROR: 3,      // missing gradlew, missing bash/pwsh, etc.
};

// 5 subcommands → (sh-script-name, ps1-script-name, extra-prefix-args)
const COMMANDS = {
  parallel:  { sh: 'run-parallel-coverage-suite.sh',  ps1: 'run-parallel-coverage-suite.ps1',  prefix: [] },
  changed:   { sh: 'run-changed-modules-tests.sh',    ps1: 'run-changed-modules-tests.ps1',    prefix: [] },
  android:   { sh: 'run-android-tests.sh',             ps1: 'run-android-tests.ps1',             prefix: [] },
  benchmark: { sh: 'run-benchmarks.sh',                ps1: 'run-benchmarks.ps1',                prefix: [] },
  coverage:  { sh: 'run-parallel-coverage-suite.sh',   ps1: 'run-parallel-coverage-suite.ps1',   prefix: ['--skip-tests'] },
};

const SUBCOMMAND_HELP = {
  parallel: `kmp-test parallel — run all tests in parallel with coverage

Usage: kmp-test parallel [--project-root <path>] [options]

Options:
  --project-root <path>      Gradle project root (default: cwd)
  --include-shared           Include sibling shared-libs modules
  --test-type <type>         all | common | androidUnit | androidInstrumented | desktop
  --module-filter <pattern>  Module name filter (glob, comma-separated). Default: *
  --max-workers <N>          Parallel Gradle workers. 0 = auto
  --coverage-tool <tool>     auto (default) | jacoco | kover | none
  --coverage-modules <list>  Comma-separated modules for coverage aggregation
  --min-missed-lines <N>     Fail if missed lines exceed N. Default: 0
  --exclude-coverage <list>  Comma-separated modules to skip in coverage
  --timeout <seconds>        Test execution timeout. Default: 600
  --json                     Emit single JSON object on stdout (agentic mode)
  --help                     Show this message

Example:
  cd ~/my-kmp-project && kmp-test parallel --json
`,
  changed: `kmp-test changed — run tests only for modules with uncommitted changes

Usage: kmp-test changed [--project-root <path>] [options]

Options:
  --project-root <path>      Gradle project root (default: cwd)
  --include-shared           Include changes in sibling shared-libs project
  --test-type <type>         all | common | androidUnit | androidInstrumented | desktop
  --staged-only              Only consider git-staged files
  --show-modules-only        List detected modules without running tests (dry run)
  --max-failures <N>         Stop after N failures. 0 = run all. Default: 0
  --min-missed-lines <N>     Min missed lines for gaps report. Default: 0
  --coverage-tool <tool>     jacoco (default) | kover | auto | none
  --exclude-coverage <list>  Comma-separated modules to exclude from coverage
  --json                     Emit single JSON object on stdout (agentic mode)
  --help                     Show this message

Example:
  cd ~/my-kmp-project && kmp-test changed --staged-only
`,
  android: `kmp-test android — run Android instrumented tests on a connected device

Usage: kmp-test android [--project-root <path>] [options]

Options:
  --project-root <path>      Gradle project root (default: cwd)
  --device <serial>          ADB device serial (auto-detect if omitted)
  --module-filter <glob>     Comma-separated module name glob patterns
  --skip-app                 Skip app/androidApp modules
  --verbose                  Show last 30 lines of log on failure
  --flavor <name>            Android build flavor
  --auto-retry               Retry failed modules once
  --clear-data               Clear app data before retry
  --list | --list-only       List discovered modules and exit
  --json                     Emit single JSON object on stdout (agentic mode)
  --help                     Show this message

Example:
  cd ~/my-android-project && kmp-test android --device emulator-5554
`,
  benchmark: `kmp-test benchmark — run benchmark suites with real Dispatchers contention

Usage: kmp-test benchmark [--project-root <path>] [options]

Options:
  --project-root <path>      Gradle project root (default: cwd)
  --config <name>            smoke (default) | main | stress
  --platform <name>          all (default) | jvm | android
  --module-filter <pattern>  Module name filter (glob, comma-separated). Default: *
  --include-shared           Include sibling shared-libs benchmark modules
  --json                     Emit single JSON object on stdout (agentic mode)
  --help                     Show this message

Example:
  cd ~/my-kmp-project && kmp-test benchmark --config smoke
`,
  coverage: `kmp-test coverage — generate coverage report (skips test execution)

Usage: kmp-test coverage [--project-root <path>] [options]

Options:
  --project-root <path>      Gradle project root (default: cwd)
  --coverage-tool <tool>     auto (default) | jacoco | kover | none
  --coverage-modules <list>  Comma-separated modules for coverage aggregation
  --min-missed-lines <N>     Fail if missed lines exceed N. Default: 0
  --exclude-coverage <list>  Comma-separated modules to skip in coverage
  --output-file <name>       Report filename. Default: coverage-full-report.md
  --json                     Emit single JSON object on stdout (agentic mode)
  --help                     Show this message

Example:
  cd ~/my-kmp-project && kmp-test coverage --json
`,
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

Run \`kmp-test <subcommand> --help\` for subcommand-specific flags.

Global options:
  --project-root <path>  Gradle project root (default: cwd)
  --json                 Emit single JSON object on stdout (agentic mode, low-token)
  --help, -h             Show this message
  --version, -v          Print version

Exit codes:
  0  success — all tests passed
  1  test failure — script ran, tests failed
  2  config error — bad CLI usage (unknown subcommand, missing arg)
  3  environment error — gradlew not found, bash/pwsh missing, JDK absent
`);
}

function printSubcommandHelp(sub) {
  const help = SUBCOMMAND_HELP[sub];
  if (!help) {
    printHelp();
    return;
  }
  process.stdout.write(help);
}

function ensureProjectRoot(args) {
  const idx = args.indexOf('--project-root');
  if (idx === -1) {
    return ['--project-root', process.cwd(), ...args];
  }
  return args;
}

function getProjectRoot(args) {
  const idx = args.indexOf('--project-root');
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return process.cwd();
}

function getCoverageToolFromArgs(args) {
  const idx = args.indexOf('--coverage-tool');
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return 'auto';
}

function checkGradlew(projectRoot, isWin) {
  const candidates = isWin ? ['gradlew.bat', 'gradlew'] : ['gradlew'];
  return candidates.some(c => existsSync(path.join(projectRoot, c)));
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

// Strip --json / --format json from args; return cleaned args + flag.
function consumeJsonFlag(args) {
  const out = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') { json = true; continue; }
    if (args[i] === '--format' && args[i + 1] === 'json') { json = true; i++; continue; }
    out.push(args[i]);
  }
  return { args: out, json };
}

// Strip ANSI escape codes (\x1b[...m) for output parsing.
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

// Parse the bash/PowerShell script's stdout to extract test counts, modules, and coverage.
// Best-effort: returns partial data + errors[] entry if a known pattern is missing.
function parseScriptOutput(stdoutRaw, stderrRaw, args) {
  const stdout = stripAnsi(stdoutRaw || '');
  const stderr = stripAnsi(stderrRaw || '');
  const all = stdout + '\n' + stderr;

  const tests = { total: 0, passed: 0, failed: 0, skipped: 0 };
  const modules = [];
  const coverage = { tool: getCoverageToolFromArgs(args), missed_lines: null };
  const errors = [];

  // Pattern 1: "Tests: X total | Y passed | Z failed | W skipped" (parallel/changed)
  const summaryMatch = all.match(/Tests:\s*(\d+)\s+total\s*\|\s*(\d+)\s+passed\s*\|\s*(\d+)\s+failed\s*\|\s*(\d+)\s+skipped/i);
  if (summaryMatch) {
    tests.total = +summaryMatch[1];
    tests.passed = +summaryMatch[2];
    tests.failed = +summaryMatch[3];
    tests.skipped = +summaryMatch[4];
  }

  // Pattern 2: "SUMMARY: X% total | Y lines missed | ..."
  const covMatch = all.match(/SUMMARY:\s*([\d.]+)%\s*total\s*\|\s*(\d+)\s+lines\s+missed/i);
  if (covMatch) {
    coverage.missed_lines = +covMatch[2];
  }

  // Pattern 3: extract module names from the "MODULE COVERAGE SUMMARY" table.
  // Lines look like: "<name>            <pct>%       <missed>"
  const lines = stdout.split(/\r?\n/);
  let inModuleTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/MODULE COVERAGE SUMMARY/.test(trimmed)) { inModuleTable = true; continue; }
    if (!inModuleTable) continue;
    if (/COVERAGE GAPS|^Tests:|^SUMMARY:/.test(trimmed)) break;
    const m = trimmed.match(/^([a-zA-Z][\w:.\-]*)\s+\d+(?:\.\d+)?%\s+\d+\s*$/);
    if (m && m[1] !== 'TOTAL' && m[1] !== 'MODULE') {
      modules.push(m[1]);
    }
  }

  // Best-effort: surface "BUILD FAILED" / explicit error lines in errors[]
  const buildFailedMatch = all.match(/BUILD FAILED[^\n]*/i);
  if (buildFailedMatch) {
    errors.push({ message: buildFailedMatch[0].trim() });
  }

  // If neither test summary nor BUILD SUCCESSFUL/FAILED appeared, mark a parse gap.
  const sawSuccess = /BUILD SUCCESSFUL/i.test(all);
  if (!summaryMatch && !sawSuccess && !buildFailedMatch) {
    errors.push({ message: 'no recognizable test/build summary in script output' });
  }

  return { tests, modules, coverage, errors };
}

// Build the canonical JSON object emitted by --json mode.
function buildJsonReport({ subcommand, projectRoot, exitCode, durationMs, parsed }) {
  return {
    tool: 'kmp-test',
    subcommand,
    version: readVersion(),
    project_root: projectRoot,
    exit_code: exitCode,
    duration_ms: durationMs,
    tests: parsed.tests,
    modules: parsed.modules,
    coverage: parsed.coverage,
    errors: parsed.errors,
  };
}

function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function envErrorJson({ subcommand, projectRoot, durationMs, message }) {
  return {
    tool: 'kmp-test',
    subcommand,
    version: readVersion(),
    project_root: projectRoot,
    exit_code: EXIT.ENV_ERROR,
    duration_ms: durationMs,
    tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
    modules: [],
    coverage: { tool: 'auto', missed_lines: null },
    errors: [{ message }],
  };
}

function main() {
  const rawArgv = process.argv.slice(2);

  if (rawArgv.length === 0) {
    printHelp();
    return EXIT.CONFIG_ERROR;
  }

  // Hoist global --json / --format json so it can appear BEFORE the subcommand
  // (e.g. `kmp-test --json parallel ...`) as well as after it.
  const { args: argv, json: jsonMode } = consumeJsonFlag(rawArgv);

  if (argv.length === 0) {
    // --json given alone → still a config error
    printHelp();
    return EXIT.CONFIG_ERROR;
  }

  // Top-level --help / --version (no subcommand)
  if (argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return EXIT.SUCCESS;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(readVersion() + '\n');
    return EXIT.SUCCESS;
  }

  const sub = argv[0];
  const cmd = COMMANDS[sub];
  if (!cmd) {
    process.stderr.write(`kmp-test: unknown subcommand '${sub}'\n`);
    printHelp();
    return EXIT.CONFIG_ERROR;
  }

  const cleanedArgs = argv.slice(1);

  // Per-subcommand --help / --version
  if (cleanedArgs.includes('--help') || cleanedArgs.includes('-h')) {
    printSubcommandHelp(sub);
    return EXIT.SUCCESS;
  }
  if (cleanedArgs.includes('--version') || cleanedArgs.includes('-v')) {
    process.stdout.write(readVersion() + '\n');
    return EXIT.SUCCESS;
  }

  // Resolve & freeze project root before any spawn
  const projectRoot = path.resolve(getProjectRoot(cleanedArgs));

  // Pre-flight gradlew check
  const isWin = process.platform === 'win32';
  if (!checkGradlew(projectRoot, isWin)) {
    const wrapper = isWin ? 'gradlew.bat' : 'gradlew';
    const msg = `no ${wrapper} found in ${projectRoot}`;
    if (jsonMode) {
      emitJson(envErrorJson({ subcommand: sub, projectRoot, durationMs: 0, message: msg }));
    } else {
      process.stderr.write(`kmp-test: ${msg}\n`);
      process.stderr.write(`Either pass --project-root <dir> pointing to a Gradle project, or cd into one.\n`);
      process.stderr.write(`If this IS a Gradle project, run \`gradle wrapper\` to generate the wrapper.\n`);
    }
    return EXIT.ENV_ERROR;
  }

  // Inject --project-root if missing (must happen AFTER consumeJsonFlag)
  const withProjectRoot = ensureProjectRoot(cleanedArgs);
  const finalArgs = [...cmd.prefix, ...withProjectRoot];

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

  const startTime = Date.now();
  // In --json mode we capture all output, parse, and emit a single JSON object on stdout.
  // In default mode we stream the script's output straight to the user's terminal.
  const spawnOpts = jsonMode
    ? { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    : { stdio: 'inherit' };

  const result = spawnSync(spawnCmd, spawnArgs, spawnOpts);
  const durationMs = Date.now() - startTime;

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      const missing = isWin ? 'pwsh/powershell' : 'bash';
      const msg = `'${missing}' not found on PATH. Install PowerShell (Windows) or bash (Unix).`;
      if (jsonMode) {
        emitJson(envErrorJson({ subcommand: sub, projectRoot, durationMs, message: msg }));
      } else {
        process.stderr.write(`kmp-test: ${msg}\n`);
      }
      return EXIT.ENV_ERROR;
    }
    process.stderr.write(`kmp-test: failed to spawn '${spawnCmd}': ${result.error.message}\n`);
    return EXIT.TEST_FAIL;
  }

  const scriptStatus = result.status ?? EXIT.TEST_FAIL;

  if (jsonMode) {
    const parsed = parseScriptOutput(result.stdout, result.stderr, finalArgs);
    emitJson(buildJsonReport({
      subcommand: sub,
      projectRoot,
      exitCode: scriptStatus,
      durationMs,
      parsed,
    }));
  }

  return scriptStatus;
}

export {
  main,
  COMMANDS,
  EXIT,
  resolveScript,
  pickWindowsShell,
  translateFlagForPowerShell,
  ensureProjectRoot,
  getProjectRoot,
  getCoverageToolFromArgs,
  checkGradlew,
  consumeJsonFlag,
  stripAnsi,
  parseScriptOutput,
  buildJsonReport,
  envErrorJson,
  readVersion,
  printHelp,
  printSubcommandHelp,
};

// SPDX-License-Identifier: Apache-2.0
// lib/cli.js — pure ESM module with all CLI logic for kmp-test-runner

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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

// 5 script-backed subcommands → (sh-script-name, ps1-script-name, extra-prefix-args).
// `doctor` is implemented in-CLI and not in this map.
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
  --test-filter <pattern>    Filter to a single test class (gradle --tests). Globs OK.
  --max-workers <N>          Parallel Gradle workers. 0 = auto
  --coverage-tool <tool>     auto (default) | jacoco | kover | none
  --coverage-modules <list>  Comma-separated modules for coverage aggregation
  --min-missed-lines <N>     Fail if missed lines exceed N. Default: 0
  --exclude-coverage <list>  Comma-separated modules to skip in coverage
  --timeout <seconds>        Test execution timeout. Default: 600
  --dry-run                  Print the resolved plan and exit 0 without spawning
  --json                     Emit single JSON object on stdout (agentic mode)
  --help                     Show this message

Example:
  cd ~/my-kmp-project && kmp-test parallel --json
  kmp-test parallel --test-filter "*MyServiceTest" --dry-run
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
  --test-filter <pattern>    Filter to a single test class (gradle --tests). Globs OK.
  --dry-run                  Print the resolved plan and exit 0 without spawning
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
  --test-filter <pattern>    Filter to a single instrumented class. Wildcard pattern
                             (e.g. *FooTest*) is resolved to FQN by source scan; literal
                             FQN passes through. Maps to
                             -Pandroid.testInstrumentationRunnerArguments.class=<FQN>.
  --dry-run                  Print the resolved plan and exit 0 without spawning
  --json                     Emit single JSON object on stdout (agentic mode)
  --help                     Show this message

Example:
  cd ~/my-android-project && kmp-test android --device emulator-5554
  kmp-test android --test-filter "*ScaleBenchmark*" --dry-run
`,
  benchmark: `kmp-test benchmark — run benchmark suites with real Dispatchers contention

Usage: kmp-test benchmark [--project-root <path>] [options]

Options:
  --project-root <path>      Gradle project root (default: cwd)
  --config <name>            smoke (default) | main | stress
  --platform <name>          all (default) | jvm | android
  --module-filter <pattern>  Module name filter (glob, comma-separated). Default: *
  --include-shared           Include sibling shared-libs benchmark modules
  --test-filter <pattern>    Filter to a single benchmark class. Wildcard pattern
                             (e.g. *ScaleBenchmark*) is resolved to FQN by source scan
                             when --platform is android or all; for jvm gradle's --tests
                             handles the glob natively.
  --dry-run                  Print the resolved plan and exit 0 without spawning
  --json                     Emit single JSON object on stdout (agentic mode)
  --help                     Show this message

Example:
  cd ~/my-kmp-project && kmp-test benchmark --config smoke
  kmp-test benchmark --platform android --test-filter "*ScaleBenchmark*"
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
  --dry-run                  Print the resolved plan and exit 0 without spawning
  --json                     Emit single JSON object on stdout (agentic mode)
  --help                     Show this message

Example:
  cd ~/my-kmp-project && kmp-test coverage --json
`,
  doctor: `kmp-test doctor — diagnose the local environment

Usage: kmp-test doctor [--project-root <path>] [options]

Options:
  --project-root <path>      Gradle project root (default: cwd) — used to check gradlew
  --json                     Emit single JSON object on stdout (agentic mode)
  --help                     Show this message

Checks:
  Node    >= 18 required
  bash    on PATH (Linux/macOS) or pwsh / powershell.exe (Windows)
  gradlew present in --project-root (warn-only — doctor doesn't require a project)
  JDK     on PATH, >= 17 recommended
  ADB     on PATH (warn-only — only needed for the android subcommand)

Exit codes:
  0  all OK or WARN — kmp-test should run
  3  one or more critical FAIL — fix the remediation hints before running

Example:
  kmp-test doctor
  kmp-test doctor --json
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
  doctor     Diagnose the local environment (Node, bash/pwsh, gradlew, JDK, ADB)

Run \`kmp-test <subcommand> --help\` for subcommand-specific flags.

Global options:
  --project-root <path>   Gradle project root (default: cwd)
  --test-filter <pattern> Filter tests to a single class (gradle --tests for JVM,
                          -Pandroid.testInstrumentationRunnerArguments.class for Android)
  --dry-run               Print the resolved plan and exit 0 without spawning the script
  --json                  Emit single JSON object on stdout (agentic mode, low-token)
  --help, -h              Show this message
  --version, -v           Print version

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

function getBenchmarkPlatform(args) {
  const idx = args.indexOf('--platform');
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return 'all';
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

// Strip --dry-run from args; return cleaned args + flag.
function consumeDryRunFlag(args) {
  const out = [];
  let dryRun = false;
  for (const a of args) {
    if (a === '--dry-run') { dryRun = true; continue; }
    out.push(a);
  }
  return { args: out, dryRun };
}

// Strip --test-filter <pattern> from args; return cleaned args + pattern (or null).
function consumeTestFilter(args) {
  const out = [];
  let pattern = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--test-filter' && args[i + 1] !== undefined) {
      pattern = args[i + 1];
      i++;
      continue;
    }
    out.push(args[i]);
  }
  return { args: out, pattern };
}

// Strip ANSI escape codes (\x1b[...m) for output parsing.
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

// Walk projectRoot for *.kt / *.java with a top-level `class <simpleName>` declaration.
// Returns the FQN (package + class) of the first match, or null. Skips build/, .gradle/,
// node_modules/, .git/. Depth-limited so we don't crawl pathological trees.
function findFirstClassFqn(projectRoot, simpleName, maxDepth = 12) {
  const skip = new Set(['build', '.gradle', 'node_modules', '.git', '.idea', 'dist', 'out', 'target', '.vscode']);
  const classRe = new RegExp(`(?:^|\\s)class\\s+${escapeRegex(simpleName)}\\b`);
  const pkgRe = /^\s*package\s+([\w.]+)/m;

  function walk(dir, depth) {
    if (depth > maxDepth) return null;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    // Visit files first so a class match short-circuits before recursing into subdirs.
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!(e.name.endsWith('.kt') || e.name.endsWith('.java'))) continue;
      const full = path.join(dir, e.name);
      let content;
      try { content = readFileSync(full, 'utf8'); } catch { continue; }
      if (classRe.test(content)) {
        const m = content.match(pkgRe);
        return m ? `${m[1]}.${simpleName}` : simpleName;
      }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (skip.has(e.name)) continue;
      const res = walk(path.join(dir, e.name), depth + 1);
      if (res) return res;
    }
    return null;
  }

  try { return walk(projectRoot, 0); } catch { return null; }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// If pattern contains `*`, strip wildcards and try to resolve to a class FQN by scanning
// projectRoot. If no match found (or pattern has no wildcards), return pattern unchanged —
// gradle / Android instrumentation will surface a clear error in that case.
function resolveAndroidTestFilter(pattern, projectRoot) {
  if (!pattern || !pattern.includes('*')) return pattern;
  const core = pattern.replace(/\*/g, '').trim();
  if (!core) return pattern;
  const fqn = findFirstClassFqn(projectRoot, core);
  return fqn || pattern;
}

// Decide how to translate a --test-filter pattern based on the subcommand. Returns the
// (possibly-resolved) pattern that gets passed through to the platform script.
function resolvePatternForSubcommand(pattern, sub, args, projectRoot) {
  if (!pattern) return null;
  if (sub === 'parallel' || sub === 'changed' || sub === 'coverage') {
    // Pure JVM gradle test tasks — gradle --tests handles globs natively.
    return pattern;
  }
  if (sub === 'android') {
    return resolveAndroidTestFilter(pattern, projectRoot);
  }
  if (sub === 'benchmark') {
    const platform = getBenchmarkPlatform(args);
    if (platform === 'jvm') return pattern;
    // android or all → resolve once for android. JVM uses same value (gradle --tests
    // accepts a literal class name and filters to that exact one).
    return resolveAndroidTestFilter(pattern, projectRoot);
  }
  return pattern;
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

// Build the JSON payload emitted in --dry-run --json mode. Same envelope shape as the
// regular report, plus dry_run:true and a plan{} section describing what *would* run.
function buildDryRunReport({ subcommand, projectRoot, plan }) {
  return {
    tool: 'kmp-test',
    subcommand,
    version: readVersion(),
    project_root: projectRoot,
    exit_code: EXIT.SUCCESS,
    duration_ms: 0,
    dry_run: true,
    tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
    modules: [],
    coverage: { tool: 'auto', missed_lines: null },
    errors: [],
    plan,
  };
}

function pad(s, n) {
  const str = String(s ?? '');
  if (str.length >= n) return str;
  return str + ' '.repeat(n - str.length);
}

// Build the array of doctor checks. Pure function over spawnSync results so it can be
// tested by mocking spawnSync. Returns { checks, exitCode, durationMs, projectRoot }.
function runDoctorChecks(projectRoot, isWin = process.platform === 'win32') {
  const checks = [];

  // Node version
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  checks.push({
    name: 'Node',
    status: nodeMajor >= 18 ? 'OK' : 'FAIL',
    value: 'v' + process.versions.node,
    message: nodeMajor >= 18 ? '>=18 required' : 'upgrade to Node 18+',
  });

  // Shell
  if (isWin) {
    const pwsh = spawnSync('pwsh', ['-NoLogo', '-Command', '$null'], { stdio: 'ignore' });
    const ps = spawnSync('powershell.exe', ['-NoLogo', '-Command', '$null'], { stdio: 'ignore' });
    if (pwsh.status === 0) {
      checks.push({ name: 'pwsh', status: 'OK', value: 'available', message: 'cross-platform PowerShell present' });
    } else if (ps.status === 0) {
      checks.push({ name: 'pwsh', status: 'WARN', value: 'powershell.exe only', message: 'install pwsh 7+ for cross-shell parity' });
    } else {
      checks.push({ name: 'pwsh', status: 'FAIL', value: 'not found', message: 'install PowerShell to run kmp-test on Windows' });
    }
  } else {
    const bash = spawnSync('bash', ['-c', 'true'], { stdio: 'ignore' });
    if (bash.status === 0) {
      checks.push({ name: 'bash', status: 'OK', value: 'available', message: 'shell present' });
    } else {
      checks.push({ name: 'bash', status: 'FAIL', value: 'not found', message: 'install bash to run kmp-test on Unix' });
    }
  }

  // gradlew (warn-only — doctor itself doesn't require a project)
  if (checkGradlew(projectRoot, isWin)) {
    checks.push({ name: 'gradlew', status: 'OK', value: 'present', message: projectRoot });
  } else {
    checks.push({
      name: 'gradlew',
      status: 'WARN',
      value: 'not found',
      message: `no wrapper in ${projectRoot} — run from a Gradle project or pass --project-root`,
    });
  }

  // JDK — `java -version` writes to stderr in most JVMs.
  const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (java.error || java.status === null) {
    checks.push({ name: 'JDK', status: 'FAIL', value: 'not found', message: 'install JDK 17+ and add to PATH' });
  } else {
    const out = (java.stderr || '') + (java.stdout || '');
    const m = out.match(/version "([^"]+)"/);
    const ver = m ? m[1] : 'unknown';
    let major = 0;
    if (m) {
      const head = m[1].split('.')[0];
      major = head === '1' ? parseInt(m[1].split('.')[1] || '0', 10) : parseInt(head, 10);
    }
    if (major >= 17) {
      checks.push({ name: 'JDK', status: 'OK', value: ver, message: '>=17 recommended' });
    } else if (major > 0) {
      checks.push({ name: 'JDK', status: 'WARN', value: ver, message: 'upgrade to JDK 17+ for current Gradle/AGP' });
    } else {
      checks.push({ name: 'JDK', status: 'WARN', value: ver, message: 'unable to parse java -version output' });
    }
  }

  // ADB — warn-only (only the android subcommand uses it).
  const adb = spawnSync('adb', ['version'], { encoding: 'utf8' });
  if (adb.error || adb.status !== 0) {
    checks.push({
      name: 'ADB',
      status: 'WARN',
      value: 'not found',
      message: 'install Android SDK platform-tools to run android subcommand',
    });
  } else {
    const out = (adb.stdout || '') + (adb.stderr || '');
    const m = out.match(/Version (\S+)/);
    checks.push({
      name: 'ADB',
      status: 'OK',
      value: m ? m[1] : 'available',
      message: 'instrumented tests supported',
    });
  }

  const exitCode = checks.some(c => c.status === 'FAIL') ? EXIT.ENV_ERROR : EXIT.SUCCESS;
  return { checks, exitCode };
}

function runDoctor(args, jsonMode) {
  const startTime = Date.now();
  const projectRoot = path.resolve(getProjectRoot(args));
  const { checks, exitCode } = runDoctorChecks(projectRoot);
  const durationMs = Date.now() - startTime;

  if (jsonMode) {
    emitJson({
      tool: 'kmp-test',
      subcommand: 'doctor',
      version: readVersion(),
      project_root: projectRoot,
      exit_code: exitCode,
      duration_ms: durationMs,
      checks,
    });
    return exitCode;
  }

  process.stdout.write('\nkmp-test doctor — environment diagnostics\n');
  process.stdout.write(`Project root: ${projectRoot}\n\n`);
  const namePad = Math.max(7, ...checks.map(c => c.name.length));
  const valPad = Math.max(5, ...checks.map(c => (c.value || '').length));
  process.stdout.write(
    pad('CHECK', namePad) + '  ' + pad('STATUS', 6) + '  ' + pad('VALUE', valPad) + '  MESSAGE\n'
  );
  process.stdout.write('-'.repeat(namePad + 6 + valPad + 12) + '\n');
  for (const c of checks) {
    process.stdout.write(
      pad(c.name, namePad) + '  ' + pad(c.status, 6) + '  ' + pad(c.value || '', valPad) + '  ' + (c.message || '') + '\n'
    );
  }
  process.stdout.write('\n');
  if (exitCode === EXIT.ENV_ERROR) {
    process.stdout.write('1+ FAIL detected — kmp-test may not run correctly. Address the remediation hints above.\n');
  } else {
    process.stdout.write('All checks OK or WARN — kmp-test should run correctly.\n');
  }
  return exitCode;
}

function main() {
  const rawArgv = process.argv.slice(2);

  if (rawArgv.length === 0) {
    printHelp();
    return EXIT.CONFIG_ERROR;
  }

  // Hoist global flags (any order, before or after the subcommand).
  const dry = consumeDryRunFlag(rawArgv);
  const j = consumeJsonFlag(dry.args);
  const argv = j.args;
  const jsonMode = j.json;
  const dryRun = dry.dryRun;

  if (argv.length === 0) {
    printHelp();
    return EXIT.CONFIG_ERROR;
  }

  // Top-level --help / --version (no subcommand).
  if (argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return EXIT.SUCCESS;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(readVersion() + '\n');
    return EXIT.SUCCESS;
  }

  const sub = argv[0];

  // doctor: special-case — implemented in CLI, not via a script.
  if (sub === 'doctor') {
    const cleanedArgs = argv.slice(1);
    if (cleanedArgs.includes('--help') || cleanedArgs.includes('-h')) {
      printSubcommandHelp('doctor');
      return EXIT.SUCCESS;
    }
    return runDoctor(cleanedArgs, jsonMode);
  }

  const cmd = COMMANDS[sub];
  if (!cmd) {
    process.stderr.write(`kmp-test: unknown subcommand '${sub}'\n`);
    printHelp();
    return EXIT.CONFIG_ERROR;
  }

  let cleanedArgs = argv.slice(1);

  // Per-subcommand --help / --version.
  if (cleanedArgs.includes('--help') || cleanedArgs.includes('-h')) {
    printSubcommandHelp(sub);
    return EXIT.SUCCESS;
  }
  if (cleanedArgs.includes('--version') || cleanedArgs.includes('-v')) {
    process.stdout.write(readVersion() + '\n');
    return EXIT.SUCCESS;
  }

  // Pull --test-filter <pattern> out before resolution; we may need to look it up against
  // the source tree for android targets.
  const tf = consumeTestFilter(cleanedArgs);
  cleanedArgs = tf.args;

  // Resolve & freeze project root before any spawn.
  const projectRoot = path.resolve(getProjectRoot(cleanedArgs));

  // Pre-flight gradlew check.
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

  // Resolve --test-filter (may walk source tree for android targets).
  const resolvedFilter = tf.pattern
    ? resolvePatternForSubcommand(tf.pattern, sub, cleanedArgs, projectRoot)
    : null;

  // Inject --project-root if missing.
  const withProjectRoot = ensureProjectRoot(cleanedArgs);
  let finalArgs = [...cmd.prefix, ...withProjectRoot];
  if (resolvedFilter !== null && resolvedFilter !== undefined) {
    finalArgs = [...finalArgs, '--test-filter', resolvedFilter];
  }

  const scriptsDir = path.join(__dirname, '..', 'scripts');

  let spawnCmd, spawnArgs, scriptPath;
  if (isWin) {
    const shell = pickWindowsShell();
    scriptPath = path.join(scriptsDir, 'ps1', cmd.ps1);
    const translatedArgs = finalArgs.map(translateFlagForPowerShell);
    spawnCmd = shell;
    spawnArgs = ['-NoLogo', '-NoProfile', '-File', scriptPath, ...translatedArgs];
  } else {
    scriptPath = path.join(scriptsDir, 'sh', cmd.sh);
    spawnCmd = 'bash';
    spawnArgs = [scriptPath, ...finalArgs];
  }

  // --dry-run: emit the resolved plan and exit before spawning anything.
  if (dryRun) {
    const plan = {
      spawn_cmd: spawnCmd,
      spawn_args: spawnArgs,
      script_path: scriptPath,
      final_args: finalArgs,
      test_filter: resolvedFilter ?? null,
    };
    if (jsonMode) {
      emitJson(buildDryRunReport({ subcommand: sub, projectRoot, plan }));
    } else {
      process.stdout.write(`kmp-test ${sub} — DRY RUN (no script invoked)\n`);
      process.stdout.write(`  Project root: ${projectRoot}\n`);
      process.stdout.write(`  Subcommand:   ${sub}\n`);
      process.stdout.write(`  Script:       ${scriptPath}\n`);
      if (resolvedFilter) {
        process.stdout.write(`  Test filter:  ${resolvedFilter}` +
          (tf.pattern !== resolvedFilter ? ` (resolved from ${tf.pattern})` : '') + '\n');
      }
      process.stdout.write(`  Final argv:   ${finalArgs.join(' ')}\n`);
      process.stdout.write(`  Spawn:        ${spawnCmd} ${spawnArgs.map(a => /\s/.test(a) ? `"${a}"` : a).join(' ')}\n`);
    }
    return EXIT.SUCCESS;
  }

  const startTime = Date.now();
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
  getBenchmarkPlatform,
  checkGradlew,
  consumeJsonFlag,
  consumeDryRunFlag,
  consumeTestFilter,
  stripAnsi,
  parseScriptOutput,
  buildJsonReport,
  buildDryRunReport,
  envErrorJson,
  readVersion,
  printHelp,
  printSubcommandHelp,
  findFirstClassFqn,
  resolveAndroidTestFilter,
  resolvePatternForSubcommand,
  runDoctorChecks,
  runDoctor,
};

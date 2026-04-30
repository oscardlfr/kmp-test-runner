// SPDX-License-Identifier: MIT
// lib/cli.js — pure ESM module with all CLI logic for kmp-test-runner

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Phase 4 (v0.5.1): findRequiredJdkVersion delegates to the canonical
// JDK-signal walker in lib/project-model.js. See the function comment below.
import { aggregateJdkSignals, buildProjectModel } from './project-model.js';
// v0.6.x Gap 2: discover installed JDKs to auto-select a matching one
// when the project requires a different version than the host default.
import { discoverInstalledJdks } from './jdk-catalogue.js';

// Default 30 minute watchdog for `./gradlew` invocations (Bug H). Override via
// the KMP_GRADLE_TIMEOUT_MS env var (e.g. 3600000 for 1h on slow projects).
// On timeout, spawnSync sends SIGTERM and we surface a `gradle_timeout` error
// instead of letting the CLI hang forever (the original v0.5.0 behavior).
const DEFAULT_GRADLE_TIMEOUT_MS = 30 * 60 * 1000;
function parseGradleTimeoutMs(envValue = process.env.KMP_GRADLE_TIMEOUT_MS) {
  if (!envValue) return DEFAULT_GRADLE_TIMEOUT_MS;
  const n = parseInt(envValue, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GRADLE_TIMEOUT_MS;
}

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
  --exclude-modules <list>   Comma-separated module globs to skip entirely
                             (e.g. "*:api,build-logic" — by-convention untested modules)
  --include-untested         Include modules with no test source set
                             (default: auto-skip when no src/*Test* dir exists)
  --timeout <seconds>        Test execution timeout. Default: 600
  --ignore-jdk-mismatch      Bypass the project-vs-JAVA_HOME JDK toolchain check
                             (default: BLOCK with exit 3 on mismatch)
  --dry-run                  Print the resolved plan and exit 0 without spawning
  --json                     Emit single JSON object on stdout (agentic mode)
  --help                     Show this message

Example:
  cd ~/my-kmp-project && kmp-test parallel --json
  kmp-test parallel --exclude-modules "*:api,*-api" --dry-run
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
  --exclude-modules <list>   Comma-separated module globs to skip entirely
                             (e.g. "*:api,build-logic" — by-convention untested modules)
  --include-untested         Include modules with no test source set
                             (default: auto-skip when no src/*Test* dir exists)
  --test-filter <pattern>    Filter to a single test class (gradle --tests). Globs OK.
  --ignore-jdk-mismatch      Bypass the project-vs-JAVA_HOME JDK toolchain check
                             (default: BLOCK with exit 3 on mismatch)
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
  --device-task <name>       Force a specific gradle task (e.g. androidConnectedCheck).
                             Default auto-detects via gradle task probe — needed for KMP
                             modules using the new androidLibrary { } DSL where neither
                             connectedDebugAndroidTest nor connectedAndroidTest exist.
  --ignore-jdk-mismatch      Bypass the project-vs-JAVA_HOME JDK toolchain check
                             (default: BLOCK with exit 3 on mismatch)
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
  --ignore-jdk-mismatch      Bypass the project-vs-JAVA_HOME JDK toolchain check
                             (default: BLOCK with exit 3 on mismatch)
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
  --ignore-jdk-mismatch      Bypass the project-vs-JAVA_HOME JDK toolchain check
                             (default: BLOCK with exit 3 on mismatch)
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
  --force                 Bypass concurrent-invocation lockfile (.kmp-test-runner.lock)
  --help, -h              Show this message
  --version, -v           Print version

Exit codes:
  0  success — all tests passed
  1  test failure — script ran, tests failed
  2  config error — bad CLI usage (unknown subcommand, missing arg)
  3  environment error — gradlew not found, bash/pwsh missing, JDK absent,
                         JDK toolchain mismatch with current java -version
                         (errors[].code: jdk_mismatch — pass --ignore-jdk-mismatch
                         to bypass), or another kmp-test is running on the same
                         project root (errors[].code: lock_held — pass --force)
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

function getBenchmarkConfigFromArgs(args) {
  // Accept both POSIX (`--config`) and PowerShell-translated (`-Config`) forms.
  const idx = args.findIndex(a => a === '--config' || a === '-Config');
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return null;
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

// Strip --force from args; return cleaned args + flag.
function consumeForceFlag(args) {
  const out = [];
  let force = false;
  for (const a of args) {
    if (a === '--force') { force = true; continue; }
    out.push(a);
  }
  return { args: out, force };
}

// Check (without consuming) if --ignore-jdk-mismatch is present. The flag
// passes through to the underlying script so script-level callers honor it too.
function getIgnoreJdkMismatch(args) {
  return args.includes('--ignore-jdk-mismatch');
}

// v0.6.x Gap 2: read --java-home <path> WITHOUT consuming. The flag also
// passes through to the sh/ps1 scripts (which accept it natively) so the
// script-level JDK gate also bypasses. Defense in depth.
function getJavaHomeOverride(args) {
  const i = args.indexOf('--java-home');
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1];
}

// v0.6.x Gap 2: consume --no-jdk-autoselect (CLI-only flag — scripts don't
// know about it, so we strip it from the spawn argv).
function extractNoJdkAutoselect(args) {
  const out = [];
  let noAutoselect = false;
  for (const a of args) {
    if (a === '--no-jdk-autoselect') { noAutoselect = true; continue; }
    out.push(a);
  }
  return { args: out, noAutoselect };
}

// Expand `--no-coverage` to `--coverage-tool none` so the alias works on both
// platforms. Without this, `translateFlagForPowerShell` would emit `-NoCoverage`
// (a switch the .ps1 scripts don't declare) and bash scripts would also reject
// the unknown flag — neither side has ever wired up `--no-coverage` directly,
// only `--coverage-tool none`. If `--coverage-tool` is already explicit, the
// user's choice wins and `--no-coverage` is dropped silently (last-wins would
// be ambiguous, conservative passthrough is cleaner).
function expandNoCoverageAlias(args) {
  if (!args.includes('--no-coverage')) return args;
  const hasExplicitCoverageTool = args.includes('--coverage-tool');
  const out = [];
  for (const a of args) {
    if (a === '--no-coverage') continue;
    out.push(a);
  }
  if (!hasExplicitCoverageTool) {
    out.push('--coverage-tool', 'none');
  }
  return out;
}

// Walk projectRoot for build scripts (`*.gradle.kts`, `*.kt` in `build-logic`)
// and detect signals that declare the JDK version this project produces or
// expects to run on. Returns the maximum version found across all signals,
// or null when nothing matches.
//
// Three signals are recognized — modern Kotlin Gradle DSL forms only:
//   1. `jvmToolchain(N)`           — gradle compiles + runs tests on JDK N
//   2. `JvmTarget.JVM_N`           — kotlin emits bytecode v(44+N) (e.g. 65 for JDK 21)
//   3. `JavaVersion.VERSION_N`     — Android source/target compatibility
//
// `*.kt` files are scanned too because convention plugins (e.g.
// `KmpBenchmarkConventionPlugin`) often declare `jvmTarget` in
// `build-logic/src/main/kotlin/` rather than in module-level `*.gradle.kts`.
//
// Returning the MAX is conservative: any signal pinned to JDK N means at
// least one part of the build will fail to load on a JVM older than N.
// Phase 4 step 3 (v0.5.1): delegates to lib/project-model.js#aggregateJdkSignals.
// The pure-Node walker that previously lived here is now the canonical
// implementation in project-model.js (same exclusion list, same depth=12 cap,
// same regex patterns). The function signature is preserved — `maxDepth`
// is accepted but ignored — so existing callers + the 7 vitest cases at
// tests/vitest/cli.test.js continue to pass byte-identically.
function findRequiredJdkVersion(projectRoot, _maxDepth = 12) {
  return aggregateJdkSignals(projectRoot).min;
}

// Pre-flight JDK check. Returns null if OK, { required, current } if mismatch.
// Skips when:
//   - gradle.properties has `org.gradle.java.home` pointing to an existing dir
//     (user explicitly told gradle which JDK to use; JAVA_HOME is moot)
//   - no JDK requirement signal (jvmToolchain / JvmTarget / JavaVersion) found
//     in any build script (can't determine required)
//   - `java -version` fails (handled by `kmp-test doctor`)
function preflightJdkCheck(projectRoot) {
  const gradleProps = path.join(projectRoot, 'gradle.properties');
  if (existsSync(gradleProps)) {
    try {
      const txt = readFileSync(gradleProps, 'utf8');
      const m = txt.match(/^[ \t]*org\.gradle\.java\.home[ \t]*=[ \t]*(.+?)[ \t\r]*$/m);
      if (m && existsSync(m[1])) return null;
    } catch { /* fall through to JDK requirement detection */ }
  }

  const required = findRequiredJdkVersion(projectRoot);
  if (!required) return null;

  const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (java.error || java.status === null) return null;
  const out = (java.stderr || '') + (java.stdout || '');
  const m = out.match(/version "([^"]+)"/);
  if (!m) return null;
  const head = m[1].split('.')[0];
  const current = head === '1' ? parseInt(m[1].split('.')[1] || '0', 10) : parseInt(head, 10);
  if (!current || current === required) return null;

  return { required, current };
}

// Per-OS hint for setting JAVA_HOME to the required JDK version.
function jdkMismatchHint(required, sub = 'parallel', platform = process.platform) {
  if (platform === 'darwin') {
    return `JAVA_HOME=$(/usr/libexec/java_home -v ${required}) kmp-test ${sub}`;
  }
  if (platform === 'win32') {
    return `$env:JAVA_HOME = "C:\\Program Files\\...\\jdk-${required}"; kmp-test ${sub}`;
  }
  return `JAVA_HOME=/usr/lib/jvm/java-${required} kmp-test ${sub}`;
}

// =============================================================================
// LOCKFILE — concurrent-invocation safety (Tier 1, v0.3.8+)
// =============================================================================
//
// Advisory lockfile at <project>/.kmp-test-runner.lock prevents two kmp-test
// runs from clobbering each other's reports / temp logs / gradle daemons when
// pointed at the same project root. Same-host coordination only — does not
// guard cross-host CI matrices.
//
// Schema v1: { schema, pid, start_time, subcommand, project_root, version }.
//
// `--force` bypasses a live lock (still writes own lock so a third arrival
// sees a coherent state). `doctor` and `--dry-run` skip the lock entirely
// since they neither spawn gradle nor write reports.
// =============================================================================

const LOCKFILE_NAME = '.kmp-test-runner.lock';

function lockfilePath(projectRoot) {
  return path.join(projectRoot, LOCKFILE_NAME);
}

// Returns true if the PID is alive. EPERM (permission denied — typically
// process owned by another user) is treated as alive (conservative). ESRCH
// or any other error → dead.
function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === 'EPERM') return true;
    return false;
  }
}

function readLockfile(projectRoot) {
  const p = lockfilePath(projectRoot);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return { invalid: true };
    return obj;
  } catch {
    return { invalid: true };
  }
}

function writeLockfile(projectRoot, subcommand) {
  const lock = {
    schema: 1,
    pid: process.pid,
    start_time: new Date().toISOString(),
    subcommand,
    project_root: projectRoot,
    version: readVersion(),
  };
  writeFileSync(lockfilePath(projectRoot), JSON.stringify(lock, null, 2), 'utf8');
  return lock;
}

function removeLockfile(projectRoot) {
  try { unlinkSync(lockfilePath(projectRoot)); } catch { /* best-effort */ }
}

// Return values:
//   { ok: true, ourLock }                       — fresh acquisition
//   { ok: true, reclaimed: true, ourLock }      — stale lock reclaimed (PID dead)
//   { ok: true, forced: true, ourLock, existing } — --force bypassed live lock
//   { ok: false, reason: 'lock_held', existing }  — refused (live + no force)
//   { ok: false, reason: 'write_error', error }   — couldn't write (e.g. read-only fs)
function acquireLock(projectRoot, subcommand, { force = false } = {}) {
  const existing = readLockfile(projectRoot);

  // No prior lock or unparseable → claim it.
  if (!existing || existing.invalid) {
    try {
      const ourLock = writeLockfile(projectRoot, subcommand);
      return { ok: true, ourLock };
    } catch (error) {
      return { ok: false, reason: 'write_error', error };
    }
  }

  const alive = isPidAlive(existing.pid);
  if (alive && !force) {
    return { ok: false, reason: 'lock_held', existing };
  }

  // Either stale (PID dead) or live + --force. Write our own lock either way.
  try {
    const ourLock = writeLockfile(projectRoot, subcommand);
    if (alive && force) return { ok: true, forced: true, ourLock, existing };
    return { ok: true, reclaimed: true, ourLock };
  } catch (error) {
    return { ok: false, reason: 'write_error', error };
  }
}

// Human-readable age from an ISO start_time. Best-effort.
function lockAgeLabel(isoStr) {
  if (typeof isoStr !== 'string' || isoStr.length === 0) return '?';
  try {
    const t = new Date(isoStr).getTime();
    if (!Number.isFinite(t) || Number.isNaN(t)) return '?';
    const ms = Date.now() - t;
    if (!Number.isFinite(ms) || ms < 0) return '?';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m${sec % 60}s`;
    const hr = Math.floor(min / 60);
    return `${hr}h${min % 60}m`;
  } catch { return '?'; }
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
// Find the first class declaration matching `pattern` under `projectRoot`
// and return its fully-qualified name (`package.ClassName`), or null if
// nothing matches.
//
// Pattern grammar:
//   "Foo"       — exact class name
//   "Foo*"      — prefix:    matches `class Foo`, `class FooBar`, …
//   "*Foo"      — suffix:    matches `class Foo`, `class BarFoo`, …
//   "*Foo*"     — substring: matches `class Foo`, `class FooBar`,
//                            `class BarFoo`, `class BarFooBaz`, …
//
// The capture group around the actual matched class name lets us return the
// real FQN even when wildcards expand the literal core (e.g. `*Scale*` →
// `com.example.ScaleBenchmark`).
function findFirstClassFqn(projectRoot, pattern, maxDepth = 12) {
  if (!pattern) return null;
  const hasLeading = pattern.startsWith('*');
  const hasTrailing = pattern.endsWith('*');
  const core = pattern.replace(/\*/g, '').trim();
  if (!core) return null;

  const skip = new Set(['build', '.gradle', 'node_modules', '.git', '.idea', 'dist', 'out', 'target', '.vscode']);
  const before = hasLeading ? '\\w*' : '';
  const after = hasTrailing ? '\\w*' : '';
  const classRe = new RegExp(`(?:^|\\s)class\\s+(${before}${escapeRegex(core)}${after})\\b`);
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
      const m = content.match(classRe);
      if (m) {
        const className = m[1];
        const pkgMatch = content.match(pkgRe);
        return pkgMatch ? `${pkgMatch[1]}.${className}` : className;
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

// Split a test pattern into class + method portions. Two accepted forms:
//   "FQN#method"  — explicit, unambiguous (preferred for Android filters)
//   "FQN.method"  — heuristic: last `.`-segment must start lowercase
//                    AND there must be ≥ 2 segments. Relies on Java/Kotlin
//                    convention that classes are UpperCamelCase, methods
//                    lowerCamelCase. Won't split a bare package
//                    (no segments lowercase) or a single token.
// Returns { cls, method }; method is null when no method portion captured.
function splitClassMethod(pattern) {
  if (!pattern) return { cls: pattern, method: null };
  const hashIdx = pattern.indexOf('#');
  if (hashIdx >= 0) {
    return {
      cls: pattern.slice(0, hashIdx),
      method: pattern.slice(hashIdx + 1) || null,
    };
  }
  const segments = pattern.split('.');
  if (segments.length >= 2) {
    const last = segments[segments.length - 1];
    if (last && /^[a-z]/.test(last)) {
      return {
        cls: segments.slice(0, -1).join('.'),
        method: last,
      };
    }
  }
  return { cls: pattern, method: null };
}

// If pattern contains `*`, resolve to a class FQN by scanning projectRoot
// (`*Foo*` is substring, `Foo*` prefix, `*Foo` suffix). If no match found
// — or the pattern has no wildcards — return pattern unchanged so the
// downstream tool (gradle / Android instrumentation) can surface a clear
// error.
//
// Method-level filter support (v0.5.2 Gap E): when the pattern carries a
// method portion (`#method` or `.method` heuristic), split → resolve class
// → recombine as `<resolvedClass>#<method>`. The `#` is the canonical wire
// separator between cli.js and the platform scripts (run-android-tests,
// run-benchmarks); scripts split it back and emit both
// `-Pandroid.testInstrumentationRunnerArguments.class=<class>` AND
// `-Pandroid.testInstrumentationRunnerArguments.method=<method>` flags
// (AndroidJUnitRunner accepts both args together).
function resolveAndroidTestFilter(pattern, projectRoot) {
  if (!pattern) return pattern;
  const { cls, method } = splitClassMethod(pattern);
  let resolvedCls = cls;
  if (cls && cls.includes('*')) {
    resolvedCls = findFirstClassFqn(projectRoot, cls) || cls;
  }
  return method ? `${resolvedCls}#${method}` : resolvedCls;
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

// Error-code discriminators: scan stdout+stderr for known failure signatures
// and push structured errors[] with a `code` field. Specific codes always
// supplement the generic BUILD FAILED message — agents can prefer the coded
// entry.
function applyErrorCodeDiscriminators(stdout, stderr, state) {
  const all = stdout + '\n' + stderr;

  // task_not_found — Bug B' (KMP androidLibrary{} DSL has no
  // connectedDebugAndroidTest task)
  const taskMatch = all.match(/Cannot locate tasks? that match[^\n]*/i);
  if (taskMatch) {
    state.errors.push({
      code: 'task_not_found',
      message: taskMatch[0].trim(),
    });
  }

  // unsupported_class_version — Bug F (kotlinx-benchmark JmhBytecodeGeneratorWorker
  // requires JDK 21+; common when project toolchain is JDK 17)
  const ucvDetailed = all.match(/UnsupportedClassVersionError[^\n]*?class file version (\d+)[^\n]*?(?:up to|runtime)[^\n]*?(\d+)[^\n]*/i);
  if (ucvDetailed) {
    state.errors.push({
      code: 'unsupported_class_version',
      message: ucvDetailed[0].trim(),
      class_file_version: +ucvDetailed[1],
      runtime_version: +ucvDetailed[2],
    });
  } else {
    const ucvLoose = all.match(/UnsupportedClassVersionError[^\n]*/i);
    if (ucvLoose) {
      state.errors.push({
        code: 'unsupported_class_version',
        message: ucvLoose[0].trim(),
      });
    }
  }

  // instrumented_setup_failed — android emulator/device couldn't host
  // instrumented tests (apk install, manifest mismatch, etc.)
  const isfMatch = all.match(/(?:Failed to install instrumentation[^\n]*|INSTRUMENTATION_RESULT[^\n]*shortMsg[^\n]*)/i);
  if (isfMatch) {
    state.errors.push({
      code: 'instrumented_setup_failed',
      message: isfMatch[0].trim(),
    });
  }
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
    coverage: state.coverage,
    errors: state.errors,
    warnings: state.warnings,
  };
  if (state.benchmark) result.benchmark = state.benchmark;
  return result;
}

// Build the canonical JSON object emitted by --json mode. Conditionally
// includes the top-level `benchmark` field when the parsed result contains
// one — keeps the envelope shape stable for non-benchmark subcommands.
function buildJsonReport({ subcommand, projectRoot, exitCode, durationMs, parsed }) {
  const out = {
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
    warnings: parsed.warnings || [],
  };
  if (parsed.benchmark) out.benchmark = parsed.benchmark;
  return out;
}

function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function envErrorJson({ subcommand, projectRoot, durationMs, message, code, extra }) {
  const err = { message };
  if (code) err.code = code;
  if (extra) Object.assign(err, extra);
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
    errors: [err],
    warnings: [],
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
    warnings: [],
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

  // v0.6.x Gap 2: surface the JDK catalogue so users can see which installs
  // are eligible for auto-select. WARN if zero installs detected (no
  // auto-select possible); OK otherwise. Each entry is reported as a
  // separate check so the JSON envelope stays granular.
  let installedJdks = [];
  try { installedJdks = discoverInstalledJdks(); } catch { /* best-effort */ }
  if (installedJdks.length === 0) {
    checks.push({
      name: 'JDK catalogue',
      status: 'WARN',
      value: 'empty',
      message: 'no installs detected — auto-select disabled, gate will fire on JDK mismatch',
    });
  } else {
    checks.push({
      name: 'JDK catalogue',
      status: 'OK',
      value: `${installedJdks.length} install${installedJdks.length === 1 ? '' : 's'}`,
      message: installedJdks.map(e => `JDK ${e.majorVersion} (${e.vendor})`).join(', '),
    });
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
  const f = consumeForceFlag(j.args);
  const argv = f.args;
  const jsonMode = j.json;
  const dryRun = dry.dryRun;
  const force = f.force;

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

  // Expand the `--no-coverage` alias to `--coverage-tool none` BEFORE flag
  // translation runs. Translating `--no-coverage` directly produces a
  // `-NoCoverage` PowerShell switch the .ps1 scripts don't declare; bash
  // scripts also have no such flag. Wiring it as an alias here lets users
  // pass the natural form on either platform.
  cleanedArgs = expandNoCoverageAlias(cleanedArgs);

  // v0.6.x Gap 2: strip --no-jdk-autoselect (CLI-only — scripts don't know
  // about it) and capture --java-home (passes through to scripts as well).
  const njas = extractNoJdkAutoselect(cleanedArgs);
  cleanedArgs = njas.args;
  const noJdkAutoselect = njas.noAutoselect;
  const javaHomeOverride = getJavaHomeOverride(cleanedArgs);

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

  // Pre-flight JDK toolchain check. Gates real runs only — `--dry-run` is for
  // planning without spawning gradle, so a JDK mismatch can't actually break it
  // and gating dry-run only blocks legitimate plan inspection on misconfigured
  // hosts. Bypassable via --ignore-jdk-mismatch (the flag also passes through
  // to the script).
  const ignoreJdk = getIgnoreJdkMismatch(cleanedArgs);
  const mismatch = !dryRun ? preflightJdkCheck(projectRoot) : null;
  // v0.6.x Gap 2: when there's a mismatch, try (in priority order):
  //   1. user-provided --java-home (skip catalogue, trust the user)
  //   2. catalogue auto-select (find an installed JDK matching `required`)
  //   3. fall through to gate (existing behavior — emit error / hint, exit)
  // Result is captured in `jdkOverrideEnv` and applied to spawn opts later.
  let jdkOverrideEnv = null;
  if (mismatch && !ignoreJdk) {
    let resolvedJavaHome = javaHomeOverride;
    let autoSelected = false;
    if (!resolvedJavaHome && !noJdkAutoselect) {
      const installed = discoverInstalledJdks();
      const match = installed.find(e => e.majorVersion === mismatch.required);
      if (match) {
        resolvedJavaHome = match.path;
        autoSelected = true;
        process.stderr.write(
          `[NOTICE] auto-selecting JDK ${mismatch.required} from ${match.path} `
          + `(${match.vendor}; host default is JDK ${mismatch.current})\n`,
        );
      }
    }
    if (resolvedJavaHome) {
      const newPath = path.join(resolvedJavaHome, 'bin') + path.delimiter + (process.env.PATH || '');
      jdkOverrideEnv = { JAVA_HOME: resolvedJavaHome, PATH: newPath };
      // suppress description unused — autoSelected is already announced above.
      void autoSelected;
    } else {
      // Gate fires (existing behavior).
      const hint = jdkMismatchHint(mismatch.required, sub);
      const msg = `JDK mismatch — project requires JDK ${mismatch.required} but current is JDK ${mismatch.current}`;
      if (jsonMode) {
        emitJson(envErrorJson({
          subcommand: sub, projectRoot, durationMs: 0,
          message: msg, code: 'jdk_mismatch',
          extra: { required_jdk: mismatch.required, current_jdk: mismatch.current },
        }));
      } else {
        process.stderr.write(`\nkmp-test: ${msg}\n`);
        process.stderr.write(`          Tests will fail with UnsupportedClassVersionError if we proceed.\n\n`);
        process.stderr.write(`          Fix: set JAVA_HOME to a JDK ${mismatch.required} install. Example:\n`);
        process.stderr.write(`            ${hint}\n\n`);
        process.stderr.write(`          Or pass --java-home <path> to a JDK ${mismatch.required} install.\n`);
        process.stderr.write(`          Or install a JDK ${mismatch.required} into a standard location for auto-select.\n`);
        process.stderr.write(`          Bypass (not recommended): pass --ignore-jdk-mismatch\n\n`);
      }
      return EXIT.ENV_ERROR;
    }
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

  // Acquire advisory lockfile before spawning. doctor + dry-run skip this
  // (they neither spawn gradle nor write reports). --force bypasses a live
  // lock; stale locks (PID dead) are reclaimed automatically.
  const lockResult = acquireLock(projectRoot, sub, { force });
  if (!lockResult.ok) {
    if (lockResult.reason === 'lock_held') {
      const e = lockResult.existing;
      const age = lockAgeLabel(e.start_time);
      const msg = `another kmp-test (${e.subcommand}) is already running with PID ${e.pid} (started ${age} ago). Pass --force to bypass.`;
      if (jsonMode) {
        emitJson(envErrorJson({
          subcommand: sub, projectRoot, durationMs: 0,
          message: msg, code: 'lock_held',
        }));
      } else {
        process.stderr.write(`kmp-test: lock held — ${msg}\n`);
        process.stderr.write(`  PID:        ${e.pid}\n`);
        process.stderr.write(`  age:        ${age}\n`);
        process.stderr.write(`  subcommand: ${e.subcommand}\n`);
      }
      return EXIT.ENV_ERROR;
    }
    if (lockResult.reason === 'write_error') {
      const msg = `failed to write lockfile at ${lockfilePath(projectRoot)}: ${lockResult.error && lockResult.error.message}`;
      if (jsonMode) {
        emitJson(envErrorJson({
          subcommand: sub, projectRoot, durationMs: 0,
          message: msg, code: 'lock_write_error',
        }));
      } else {
        process.stderr.write(`kmp-test: ${msg}\n`);
      }
      return EXIT.ENV_ERROR;
    }
  }
  if (!jsonMode && lockResult.reclaimed) {
    process.stderr.write(`kmp-test: stale lockfile reclaimed (previous PID was dead)\n`);
  }
  if (!jsonMode && lockResult.forced) {
    process.stderr.write(`kmp-test: --force: bypassing live lock from PID ${lockResult.existing.pid}\n`);
  }

  // Phase 4 (v0.5.1): build the ProjectModel JSON before spawning the script
  // so its sh/ps1 readers (pm_get_*, Get-Pm*) hit the model fast-path on
  // tier 1 instead of falling through to the gradle-tasks probe. We pass
  // `skipProbe: true` to avoid double-invoking gradle: the script's own
  // probe layer is the one that runs `./gradlew tasks --all` and writes
  // tasks-<sha>.txt; the next CLI invocation will rebuild the model with
  // the populated tasks cache and tier 1 will engage. Costs a small upfront
  // walk of *.gradle.kts files (no subprocess) and is best-effort: any
  // failure is swallowed so the run continues. Placed AFTER the dry-run
  // and lockfile checks so dry-run remains instant and lock failures
  // short-circuit before we do any work.
  try {
    buildProjectModel(projectRoot, { skipProbe: true });
  } catch { /* model build is non-essential — script falls through to legacy */ }

  // Cleanup hooks for SIGINT (Ctrl-C), SIGTERM, and uncaughtException — drop
  // the lockfile so subsequent invocations don't see a stale lock from a
  // PID that's about to die. Best-effort: unlink failures are swallowed.
  const cleanup = () => removeLockfile(projectRoot);
  const sigintHandler = () => { cleanup(); process.exit(130); };
  const sigtermHandler = () => { cleanup(); process.exit(143); };
  const uncaughtHandler = (err) => {
    cleanup();
    process.stderr.write(`kmp-test: uncaughtException: ${(err && err.stack) || err}\n`);
    process.exit(1);
  };
  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);
  process.once('uncaughtException', uncaughtHandler);

  // Bug Z (Windows pipe-inheritance deadlock with --json): pwsh.exe inherits
  // Node's pipe handles to its grandchildren (gradlew.bat → gradle java
  // daemon). The daemon survives the script exit by hours and keeps the pipes
  // open, so spawnSync waits for stdout EOF that never comes. Redirecting to
  // file descriptors avoids this: the daemon may keep the FD open, but
  // spawnSync only waits for the script process to exit, not for FD close.
  // Gated on isWin because the issue is a Windows pipe-inheritance quirk;
  // POSIX defaults already work and we keep tests' spawnSync mock contract.
  const useTempFileRedirect = jsonMode && isWin;
  let stdoutFile = null, stderrFile = null;
  let stdoutFd = null, stderrFd = null;
  const cleanupTempFiles = () => {
    if (stdoutFd !== null) { try { closeSync(stdoutFd); } catch { /* already closed */ } stdoutFd = null; }
    if (stderrFd !== null) { try { closeSync(stderrFd); } catch { /* already closed */ } stderrFd = null; }
    if (stdoutFile) { try { unlinkSync(stdoutFile); } catch { /* best-effort */ } }
    if (stderrFile) { try { unlinkSync(stderrFile); } catch { /* best-effort */ } }
  };

  try {
    const startTime = Date.now();
    const timeoutMs = parseGradleTimeoutMs();

    if (useTempFileRedirect) {
      const stamp = `${process.pid}-${Date.now()}`;
      stdoutFile = path.join(os.tmpdir(), `kmp-test-${stamp}-stdout.log`);
      stderrFile = path.join(os.tmpdir(), `kmp-test-${stamp}-stderr.log`);
      stdoutFd = openSync(stdoutFile, 'w');
      stderrFd = openSync(stderrFile, 'w');
    }

    const spawnOpts = useTempFileRedirect
      ? { stdio: ['ignore', stdoutFd, stderrFd], timeout: timeoutMs, killSignal: 'SIGTERM' }
      : jsonMode
        ? { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGTERM' }
        : { stdio: 'inherit', timeout: timeoutMs, killSignal: 'SIGTERM' };

    // v0.6.x Gap 2: inject JAVA_HOME + PATH override when the catalogue
    // auto-selected a matching JDK or the user passed --java-home. When
    // `jdkOverrideEnv` is null, leave spawnOpts.env unset so Node inherits
    // process.env (preserves prior behavior — no test mocks see env).
    if (jdkOverrideEnv) {
      spawnOpts.env = { ...process.env, ...jdkOverrideEnv };
    }

    const result = spawnSync(spawnCmd, spawnArgs, spawnOpts);
    const durationMs = Date.now() - startTime;

    let capturedStdout = '', capturedStderr = '';
    if (useTempFileRedirect) {
      // Real spawn with FD redirect: result.stdout/stderr are null (Node
      // doesn't populate them when stdio is fd numbers). Read the temp files.
      // Test mocks override this by returning a fake `stdout` string — honor
      // that path so existing tests don't need to know about FD plumbing.
      if (result.stdout != null) {
        capturedStdout = result.stdout;
        capturedStderr = result.stderr || '';
      } else {
        try { closeSync(stdoutFd); } catch { /* fall through */ }
        try { closeSync(stderrFd); } catch { /* fall through */ }
        stdoutFd = null; stderrFd = null;
        try { capturedStdout = readFileSync(stdoutFile, 'utf8'); } catch { /* empty */ }
        try { capturedStderr = readFileSync(stderrFile, 'utf8'); } catch { /* empty */ }
      }
    } else if (jsonMode) {
      capturedStdout = result.stdout || '';
      capturedStderr = result.stderr || '';
    }

    // Bug H detection: spawnSync's timeout option surfaces in TWO ways
    // depending on platform/Node version:
    //   - POSIX (bash on Linux/macOS): result.signal = 'SIGTERM', status = null,
    //     no result.error.
    //   - Windows (pwsh.exe + Bug Z's stdio = ['ignore', fd, fd]): result.error
    //     is set with code 'ETIMEDOUT'. The Bug Z fix changes how the child
    //     process is wrapped, which changes how Node reports the timeout —
    //     instead of the SIGTERM signal channel it bubbles up as an error.
    //
    // Both paths converge on the same `gradle_timeout` envelope so agents
    // can disambiguate hung-daemon from failing-tests regardless of platform.
    const isGradleTimeout =
      (result.signal === 'SIGTERM' && result.status === null) ||
      (result.error && result.error.code === 'ETIMEDOUT');

    if (isGradleTimeout) {
      const timeoutSec = Math.round(timeoutMs / 1000);
      const msg = `gradle invocation exceeded ${timeoutSec}s timeout — likely a hung daemon. Set KMP_GRADLE_TIMEOUT_MS env var to override (e.g. 3600000 for 1h).`;
      if (jsonMode) {
        emitJson(envErrorJson({
          subcommand: sub, projectRoot, durationMs,
          message: msg, code: 'gradle_timeout',
        }));
      } else {
        process.stderr.write(`kmp-test: ${msg}\n`);
      }
      // Exit code 3 (ENV_ERROR) — same semantic class as JDK mismatch and
      // missing shell. The envelope ALSO reports exit_code=3 via envErrorJson,
      // so the process exit and JSON report agree. Fixed in Phase 4 step 9
      // (was returning TEST_FAIL=1 despite the envelope saying 3 — confused
      // wrapper scripts that key on bash exit code rather than parsing JSON).
      return EXIT.ENV_ERROR;
    }

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
      const parsed = parseScriptOutput(capturedStdout, capturedStderr, finalArgs, sub);
      emitJson(buildJsonReport({
        subcommand: sub,
        projectRoot,
        exitCode: scriptStatus,
        durationMs,
        parsed,
      }));
    }

    return scriptStatus;
  } finally {
    cleanupTempFiles();
    cleanup();
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
    process.removeListener('uncaughtException', uncaughtHandler);
  }
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
  consumeForceFlag,
  consumeTestFilter,
  expandNoCoverageAlias,
  getIgnoreJdkMismatch,
  findRequiredJdkVersion,
  preflightJdkCheck,
  jdkMismatchHint,
  lockfilePath,
  isPidAlive,
  readLockfile,
  writeLockfile,
  removeLockfile,
  acquireLock,
  lockAgeLabel,
  stripAnsi,
  parseScriptOutput,
  buildJsonReport,
  buildDryRunReport,
  envErrorJson,
  readVersion,
  printHelp,
  printSubcommandHelp,
  findFirstClassFqn,
  splitClassMethod,
  resolveAndroidTestFilter,
  resolvePatternForSubcommand,
  runDoctorChecks,
  runDoctor,
  parseGradleTimeoutMs,
  DEFAULT_GRADLE_TIMEOUT_MS,
};

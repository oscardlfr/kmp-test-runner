// SPDX-License-Identifier: MIT
// lib/cli.js — pure ESM module with all CLI logic for kmp-test-runner

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Phase 4 (v0.5.1): findRequiredJdkVersion delegates to the canonical
// JDK-signal walker in lib/project-model.js. See the function comment below.
import { buildProjectModel } from './project-model.js';
// v0.6.x Gap 2: discover installed JDKs to auto-select a matching one
// when the project requires a different version than the host default.
import { discoverInstalledJdks } from './jdk-catalogue.js';
// v0.8.0: project-level config (`.kmp-test-runner.json`) — used by doctor +
// applyConfigDefaults for flag re-injection before subcommand dispatch.
// doctor's own consumers (loadProjectConfig + CONFIG_FILE_NAME +
// android-sdk-catalogue helpers) live in lib/commands/doctor.js. cli.js
// keeps only what main() / applyConfigDefaults still need.
// loadMergedConfig combines user-global (~/.kmp-test/config.json) with
// project-local. Injected here so getJavaHomeOverride downstream sees
// user-global java_home as if the user had passed --java-home explicitly.
import { loadMergedConfig, applyConfigDefaults } from './project-config.js';
// Node-only orchestrators for the new DX-parity subcommands.
// Imports are static (not dynamic): the orchestrators import runDoctorChecks /
// buildJsonReport / EXIT from this file, so we'd hit a top-level `import` cycle.
// ESM resolves this via live bindings — at evaluation time the orchestrator
// modules see this file's exports as partially-initialized references; by the
// time main() actually invokes them, all bindings are stable. See lib/info-
// orchestrator.js, lib/describe-orchestrator.js, lib/update-orchestrator.js.
// POSIX `--name=value` form normalization. cli.js
// must split BEFORE the ps1/sh wrapper spawn since PowerShell's `-File`
// invocation mangles `--name=:value` (parses as parameter binding, eats the
// flag, strips the leading colon on the value).
// Pre-spawn enum / numeric validation so
// `kmp-test parallel --test-type bogus` exits CONFIG_ERROR (2) with the
// canonical `invalid_flag_value` shape rather than falling through to the
// ps1 wrapper's `[ValidateSet]` (whose error doesn't surface as JSON).
import { expandPosixEqualsForm, validateEnum, validateNonNegativeInt } from './orchestrators/orchestrator-utils.js';
import { runInfo, formatInfoText } from './orchestrators/info-orchestrator.js';
import { runDescribe, formatDescribeText } from './orchestrators/describe-orchestrator.js';
import { runUpdate, formatUpdateText } from './orchestrators/update-orchestrator.js';
// `kmp-test doctor` lives in lib/commands/doctor.js. cli.js re-exports
// runDoctor / runDoctorChecks via the export block at the bottom; ESM live
// bindings handle the cli.js↔commands/doctor.js circular reference (doctor.js
// still pulls getProjectRoot / parseGradleConfig / checkGradlew from cli.js).
import { runDoctor, runDoctorChecks } from './commands/doctor.js';
// Envelope shape concerns (exit codes, schema version, builders) live in
// lib/envelope/. cli.js re-exports these names from its existing `export {}`
// block at the bottom so external consumers (orchestrators, tests) keep
// importing from './cli.js' unchanged via ESM live bindings.
import { EXIT, ENVELOPE_SCHEMA_VERSION, ASYNC_DEFERRED } from './envelope/exit-codes.js';
import {
  readVersion,
  buildJsonReport,
  enforceErrorsExitCodeInvariant,
  emitJson,
  buildInvalidArgsEnvelope,
  envErrorJson,
  buildDryRunReport,
} from './envelope/builder.js';
// Argv parsers (consume*/get*/peek*/expand*/extract*) live in lib/parsers/argv.js,
// and applyErrorCodeDiscriminators is centralized in lib/envelope/error-codes.js.
// cli.js re-exports every name through its `export {}` block at the bottom so
// existing consumers (tests, orchestrators, commands/doctor.js) keep importing
// from './cli.js' unchanged via ESM live bindings.
import {
  getProjectRoot,
  getCoverageToolFromArgs,
  getBenchmarkPlatform,
  getBenchmarkConfigFromArgs,
  consumeJsonFlag,
  consumeDryRunFlag,
  consumeForceFlag,
  consumeColorFlag,
  getIgnoreJdkMismatch,
  getJavaHomeOverride,
  extractNoJdkAutoselect,
  expandNoCoverageAlias,
  consumeTestFilter,
  peekIsolatedFlags,
} from './parsers/argv.js';
import { applyErrorCodeDiscriminators } from './envelope/error-codes.js';
import { setConsoleMode } from './runners/console-mode.js';
// Shell/PowerShell helpers live in lib/runners/. cli.js re-exports these names
// through its `export {}` block at the bottom so existing consumers
// (cli.test.js) keep importing from './cli.js' unchanged via ESM live bindings.
// shell-runner.js imports COMMANDS back from this file (live binding) since
// main()'s dispatcher and resolveScript() share that registry.
import {
  pickWindowsShell,
  translateFlagForPowerShell,
  PS_GRADLE_ARGS_SEP,
  collapseGradleArgs,
  translateBashFlagsForPowerShell,
  resolveScript,
} from './runners/shell-runner.js';
// Concurrent-invocation lockfile helpers live in lib/runners/lockfile.js.
// cli.js re-exports through the `export {}` block at the bottom so existing
// consumers (cli.test.js, Pester Concurrency.Tests.ps1) keep importing from
// './cli.js' unchanged via ESM live bindings.
import {
  lockfilePath,
  isPidAlive,
  readLockfile,
  writeLockfile,
  removeLockfile,
  acquireLock,
  lockAgeLabel,
} from './runners/lockfile.js';
// `--test-filter` pattern resolution helpers live in lib/parsers/test-filter.js.
// cli.js re-exports through the `export {}` block at the bottom (live bindings)
// for cli.test.js + orchestrator consumers.
import {
  findFirstClassFqn,
  splitClassMethod,
  resolveAndroidTestFilter,
  resolvePatternForSubcommand,
} from './parsers/test-filter.js';
// Script stdout/stderr parsers live in lib/parsers/script-output.js. cli.js
// re-exports through the `export {}` block at the bottom. parseScriptOutput
// is the canonical entry; the per-subcommand helpers (parseAndroidSummary,
// parseBenchmarkSummary, etc.) stay exposed so cli.test.js + Pester tests
// keep working.
import {
  stripAnsi,
  applySharedSignal,
  parseAndroidSummary,
  parseAndroidModuleTableFallback,
  parseBenchmarkSummary,
  parseSkippedModules,
  parseLegacySummary,
  parseScriptOutput,
  resolveDryRunModules,
} from './parsers/script-output.js';
// JDK preflight + gradle.properties parser live in lib/project/jdk-preflight.js.
// cli.js re-exports through the `export {}` block at the bottom (live bindings)
// for cli.test.js + doctor.js consumers.
import {
  findRequiredJdkVersion,
  preflightJdkCheck,
  parseGradleConfig,
  jdkMismatchHint,
} from './project/jdk-preflight.js';
// Script-backed spawn pipeline + commands dispatch table. Each command module
// exposes `parse(args) + run({...})`. Script-backed subs (parallel/changed/
// android/benchmark/coverage) forward to dispatchScriptCommand. Orchestrator-
// only subs (info/describe/update/doctor) own their run() body.
import { dispatchScriptCommand } from './runners/script-dispatcher.js';
import * as parallelCmd  from './commands/parallel.js';
import * as changedCmd   from './commands/changed.js';
import * as androidCmd   from './commands/android.js';
import * as benchmarkCmd from './commands/benchmark.js';
import * as coverageCmd  from './commands/coverage.js';
import * as infoCmd      from './commands/info.js';
import * as describeCmd  from './commands/describe.js';
import * as updateCmd    from './commands/update.js';
import * as doctorCmd    from './commands/doctor.js';

const COMMAND_MODULES = {
  parallel: parallelCmd,
  changed: changedCmd,
  android: androidCmd,
  benchmark: benchmarkCmd,
  coverage: coverageCmd,
  info: infoCmd,
  describe: describeCmd,
  update: updateCmd,
  doctor: doctorCmd,
};

const SCRIPT_BACKED_SUBS = new Set(['parallel', 'changed', 'android', 'benchmark', 'coverage']);

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

// v0.8.0 — outer wrapper-level watchdog timeout for `kmp-test benchmark`.
// The orchestrator owns the per-config inner timeout; this outer must be
// ≥ that or cli.js would SIGTERM the wrapper before the orchestrator can
// surface `gradle_timeout`. Layered defaults (env override > config-aware
// default with safety buffer > DEFAULT). Buffer is 30 min on top of the
// orchestrator's per-config inner default so even worst-case daemon-warmup
// + envelope-construction has headroom.
const BENCHMARK_OUTER_BUFFER_MS = 30 * 60 * 1000;
const BENCHMARK_OUTER_TIMEOUTS_MS = Object.freeze({
  smoke: 300_000 + BENCHMARK_OUTER_BUFFER_MS,    // 5 min + 30 min = 35 min
  main: 1_800_000 + BENCHMARK_OUTER_BUFFER_MS,   // 30 min + 30 min = 60 min
  stress: 3_600_000 + BENCHMARK_OUTER_BUFFER_MS, // 60 min + 30 min = 90 min
});

function resolveBenchmarkOuterTimeoutMs(
  spawnArgs = [],
  env = process.env,
) {
  // Env override wins (preserves existing parseGradleTimeoutMs contract).
  if (env.KMP_GRADLE_TIMEOUT_MS != null && env.KMP_GRADLE_TIMEOUT_MS !== '') {
    return parseGradleTimeoutMs(env.KMP_GRADLE_TIMEOUT_MS);
  }
  // Parse --config from the same args the wrapper will receive.
  let config = 'smoke';
  for (let i = 0; i < spawnArgs.length; i++) {
    if (spawnArgs[i] === '--config' && spawnArgs[i + 1]) {
      config = spawnArgs[i + 1];
      break;
    }
  }
  return BENCHMARK_OUTER_TIMEOUTS_MS[config] ?? BENCHMARK_OUTER_TIMEOUTS_MS.main;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 5 script-backed subcommands → (sh-script-name, ps1-script-name, extra-prefix-args).
// `doctor` is implemented in-CLI and not in this map.
//
// `migrated: true` marks subcommands whose orchestrator lives in lib/ and emits
// a sentinel-bracketed envelope on stdout. lib/cli.js short-circuits the
// post-spawn parseScriptOutput path for these and trusts the envelope directly.
// v0.8 STRATEGIC PIVOT: subcommands flip to migrated:true one PR at a time.
// `passthrough: true` marks ps1 wrappers that splat `@args` straight to
// runner.js without a `param()` block. For these we must NOT translate
// kebab → PascalCase on the way in: PowerShell preserves the literal flag
// strings via @args, and the Node-side parsers expect kebab (--project-root,
// --variant, --device-task, …). Translating would emit -ProjectRoot etc. and
// the parsers would silently miss the flags — fixed in a refactor pass (live repro
// 2026-05-05 against di-sample: `kmp-test android --variant release
// --list-only` returned no_test_modules + project_root=cwd because every
// kebab flag mismatched the PascalCase form arriving in the orchestrator).
//
// `passthrough: false` (or absent) goes through translateBashFlagsForPowerShell
// because the wrapper has a typed param block (-ProjectRoot [string], …).
// Currently only the parallel/coverage shared script needs this.
const COMMANDS = {
  parallel:  { sh: 'run-parallel-coverage-suite.sh',  ps1: 'run-parallel-coverage-suite.ps1',  prefix: [], migrated: true, passthrough: false },
  changed:   { sh: 'run-changed-modules-tests.sh',    ps1: 'run-changed-modules-tests.ps1',    prefix: [], migrated: true, passthrough: true  },
  android:   { sh: 'run-android-tests.sh',             ps1: 'run-android-tests.ps1',             prefix: [], migrated: true, passthrough: true  },
  benchmark: { sh: 'run-benchmarks.sh',                ps1: 'run-benchmarks.ps1',                prefix: [], migrated: true, passthrough: true  },
  coverage:  { sh: 'run-parallel-coverage-suite.sh',   ps1: 'run-parallel-coverage-suite.ps1',   prefix: ['--skip-tests'], migrated: true, passthrough: false },
};

// Sentinel markers that lib/runner.js emits around the orchestrator envelope
// when --json is set. Must stay in sync with lib/runner.js#ENVELOPE_BEGIN/END.
const MIGRATED_ENVELOPE_BEGIN = '__KMP_TEST_ENVELOPE_V1_BEGIN__';
const MIGRATED_ENVELOPE_END   = '__KMP_TEST_ENVELOPE_V1_END__';

// Extract the orchestrator envelope from a captured stdout stream. Returns the
// parsed envelope object or null if the sentinel block is missing/malformed.
function extractMigratedEnvelope(stdout) {
  if (!stdout) return null;
  const startIdx = stdout.lastIndexOf(MIGRATED_ENVELOPE_BEGIN);
  if (startIdx < 0) return null;
  const after = stdout.slice(startIdx + MIGRATED_ENVELOPE_BEGIN.length);
  const endIdx = after.indexOf(MIGRATED_ENVELOPE_END);
  if (endIdx < 0) return null;
  const jsonText = after.slice(0, endIdx).trim();
  try { return JSON.parse(jsonText); } catch { return null; }
}

const SUBCOMMAND_HELP = {
  parallel: `kmp-test parallel — run all tests in parallel with coverage

Usage: kmp-test parallel [--project-root <path>] [options]

Options:
  --project-root <path>      Gradle project root (default: cwd)
  --include-shared           Include sibling shared-libs modules
  --test-type <type>         all | common | androidUnit | androidInstrumented | desktop | ios | macos.
                             Omitted = auto-detect (unit leg: common/desktop, else
                             androidUnit). Compose-UI / instrumented-only modules
                             are skipped by the unit leg — use androidInstrumented
                             (or the android subcommand) to run them; that skip
                             emits warnings[].code "instrumented_only_skipped".
  --module-filter <pattern>  Module name filter (glob, comma-separated). Default: *
  --test-filter <pattern>    Filter to a single test class. JVM / K-Native / KJS
                             legs use gradle --tests (globs OK). Android
                             instrumented uses
                             -Pandroid.testInstrumentationRunnerArguments.class
                             — the canonical AGP form is the combined single
                             arg "Class#method" (works under AndroidJUnitRunner
                             AND Microbenchmark; honored verbatim).
  --max-workers <N>          Parallel Gradle workers. 0 = auto
  --coverage-tool <tool>     auto (default) | jacoco | kover | none
  --coverage-modules <list>  Comma-separated modules for coverage aggregation
  --min-missed-lines <N>     Fail if missed lines exceed N. Default: 0
  --exclude-coverage <list>  Comma-separated modules to skip in coverage
  --no-coverage-xml-autofix  Disable the auto-injected init-script that turns
                             jacoco XML reports on. By default kmp-test forces
                             xml.required=true so HTML-only jacoco modules still
                             produce parseable coverage XML. No-op for Kover.
  --exclude-modules <list>   Comma-separated module globs to skip entirely
                             (e.g. "*:api,build-logic" — by-convention untested modules)
  --include-untested         Include modules with no test source set
                             (default: auto-skip when no src/*Test* dir exists)
  --timeout <seconds>        Test execution timeout. Default: 600
  --skip-tests               Skip test execution; still aggregates coverage
                             from existing reports if present. Equivalent to
                             \`kmp-test coverage\` (the coverage subcommand
                             sets this internally).
  --fresh-daemon             Stop existing Gradle daemons before launching.
                             Useful when memory pressure or stale config-
                             cache entries from prior runs cause flakes.
  --output-file <path>       Path for the aggregated coverage / parallel
                             report. Absolute paths used verbatim; relative
                             paths resolved against --project-root. When
                             omitted, writes to
                             .kmp-test-runner/reports/coverage/<runId>.md
                             with a latest.md alias.
  --coverage-only            Generate only the coverage report — implies
                             --skip-tests; faster than the \`coverage\`
                             subcommand when reports are already on disk.
  --benchmark                Run benchmark suites instead of tests. The
                             \`benchmark\` subcommand sets this internally;
                             pass directly to \`parallel\` only if composing
                             the orchestrator.
  --variant | --android-variant <value>
                             Android variant for unit + instrumented tests:
                             auto (default; respects testBuildType="release"
                             projects), debug, release, or all (umbrella :test
                             / :connectedAndroidTest tasks — both variants).
                             Ignored for non-Android modules and for the
                             kmpAndroidLibrary plugin (no Debug/Release split).
                             \`--android-variant\` is the legacy alias.
  --device <serial>          ADB device serial for instrumented dispatch.
                             Validated against \`adb devices\`; pins
                             ANDROID_SERIAL for AGP. Mismatched serial →
                             instrumented_setup_failed (exit 3).
  --device-task <name>       Force an explicit gradle task name on the
                             instrumented leg (e.g. androidConnectedCheck for
                             kmpAndroidLibrary projects, or a custom AGP
                             umbrella). Preempts auto-resolution.
  --auto-retry               Re-dispatch instrumented tasks that ran but
                             failed at runtime. One retry per task; mutually
                             exclusive with cascade-isolation (which already
                             handles eval-phase aborts). Surfaces
                             parallel.legs[i].retries[].
  --clear-data               Invoke \`adb shell pm clear <pkg>\` before each
                             auto-retry attempt. Implies --auto-retry to be
                             effective. Reads package from AndroidManifest.xml.
                             Surfaces parallel.legs[i].pre_run_actions[].
  --flavor <name>            Android productFlavor weave for instrumented
                             tasks: connected\${Cap}\${Variant}AndroidTest. Modules
                             without productFlavors {} declaration ignore the
                             flag (no-op + flavor_unused warning if zero
                             discovered modules have flavors).
  --gradle-args <string>     Escape hatch: append tokens to every gradlew run.
                             Repeatable; whitespace-split. Tokens go LAST so
                             they OVERRIDE CLI defaults via gradle's last-wins
                             (--gradle-args "--no-parallel" wins over --parallel).
  --isolated                 Run gradle with --project-cache-dir <tmp> so
                             concurrent kmp-test invocations don't share
                             configuration cache. Tier-3 isolation.
  --isolated-cache-dir <p>   Override the temp project-cache-dir location.
                             Implies --isolated.
  --isolated-no-lock         Skip the OS-level cache-dir lockfile. Implies
                             --isolated.
  --java-home <path>         Override JDK location for this run. Skips
                             auto-select and preempts the host JAVA_HOME.
  --no-jdk-autoselect        Disable JDK catalogue auto-select (use the host's
                             JAVA_HOME unmodified). Pair with --java-home for
                             explicit control.
  --ignore-jdk-mismatch      Bypass the project-vs-JAVA_HOME JDK toolchain check
                             (default: BLOCK with exit 3 on mismatch)
  --dry-run                  Print the resolved plan and exit 0 without spawning
  --list | --list-only       Emit the post-filter module set (modules[]) +
                             skipped[] + coverage block, then exit 0 before
                             any gradle dispatch. Differs from --dry-run:
                             dry-run shows the spawn command shape; list-only
                             shows the module set the spawn would iterate.
  --json                     Emit single JSON object on stdout (agentic mode)
  --color <mode>             always | never | auto (default). Auto detects piped/non-TTY
                             stdout and respects NO_COLOR; injects --console=plain into gradle.
  --help                     Show this message

Example:
  cd ~/my-kmp-project && kmp-test parallel --json
  kmp-test parallel --exclude-modules "*:api,*-api" --dry-run
  kmp-test parallel --module-filter "core-*" --list-only --json   # enumerate effective module set
  kmp-test parallel --variant all       # run BOTH Debug and Release Android variants
  kmp-test parallel --variant release   # only Release variant (testBuildType="release" projects)
  kmp-test parallel --test-type androidInstrumented --device R3CT30KAMEH \\
                    --test-filter "com.foo.Bench#one" --json
  kmp-test parallel --test-type androidInstrumented --auto-retry --clear-data
  kmp-test parallel --test-type androidInstrumented --flavor staging --variant release
`,
  changed: `kmp-test changed — run tests only for modules with uncommitted changes

Usage: kmp-test changed [--project-root <path>] [options]

Options:
  --project-root <path>      Gradle project root (default: cwd)
  --include-shared           Include changes in sibling shared-libs project
  --test-type <type>         all | common | androidUnit | androidInstrumented | desktop | ios | macos.
                             Omitted = auto-detect (unit leg: common/desktop, else
                             androidUnit). Compose-UI / instrumented-only modules
                             are skipped by the unit leg — use androidInstrumented
                             (or the android subcommand) to run them; that skip
                             emits warnings[].code "instrumented_only_skipped".
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
  --variant | --android-variant <value>
                             Android variant: auto (default; respects
                             testBuildType="release" projects), debug,
                             release, or all (umbrella). Forwarded to
                             parallel-orchestrator under the hood.
                             \`--android-variant\` is the legacy alias.
  --no-coverage              Sugar for --coverage-tool none — runs tests
                             only, skips coverage aggregation.
  --isolated                 Run gradle with --project-cache-dir <tmp> so
                             concurrent kmp-test invocations don't share
                             configuration cache. Tier-3 isolation.
  --isolated-cache-dir <p>   Override the temp project-cache-dir location.
                             Implies --isolated. Default: per-run tmpdir.
  --isolated-no-lock         Skip the OS-level cache-dir lockfile. Use only
                             when the lockfile contention itself is the
                             problem (rare). Implies --isolated.
  --gradle-args <string>     Escape hatch: append tokens to every gradlew run.
                             Repeatable; whitespace-split. Tokens go LAST so
                             they OVERRIDE CLI defaults via gradle's last-wins
                             (--gradle-args "--no-parallel" wins over --parallel).
  --java-home <path>         Override JDK location for this run. Skips
                             auto-select and preempts the host JAVA_HOME.
  --no-jdk-autoselect        Disable JDK catalogue auto-select (use the host's
                             JAVA_HOME unmodified). Pair with --java-home for
                             explicit control.
  --ignore-jdk-mismatch      Bypass the project-vs-JAVA_HOME JDK toolchain check
                             (default: BLOCK with exit 3 on mismatch)
  --dry-run                  Print the resolved plan and exit 0 without spawning
  --json                     Emit single JSON object on stdout (agentic mode)
  --color <mode>             always | never | auto (default). Auto detects piped/non-TTY
                             stdout and respects NO_COLOR; injects --console=plain into gradle.
  --help                     Show this message

Example:
  cd ~/my-kmp-project && kmp-test changed --staged-only
`,
  android: `kmp-test android — run Android instrumented tests on a connected device

This is the instrumented path (Compose UI tests included). Host JVM unit tests
run via \`kmp-test parallel\` (or \`parallel --test-type androidInstrumented\` for
the instrumented leg with full coverage aggregation).

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
  --capture-on-fail          On instrumented-test failure, capture a device
                             screenshot + UI-hierarchy dump via adb (best-effort,
                             forensic-only — never changes the exit code). Paths
                             surface on errors[].screenshot_file / .ui_hierarchy_file.
                             Post-hoc: shows device state at task-end (high value
                             for crashes/ANRs), not the exact assertion frame.
  --capture-dir <path>       Override where --capture-on-fail artifacts land
                             (default: the per-run .kmp-test-runner log dir).
                             Implies --capture-on-fail. Relative paths resolve
                             against --project-root.
  --list | --list-only       List discovered modules and exit
  --no-adb                   Implies --list-only on the android subcommand —
                             instrumented tests require adb, so the orchestrator
                             skips the dispatch and emits the module set with a
                             warnings[].code:"no_adb_implies_list_only" entry.
                             Also via KMP_TEST_SKIP_ADB=1 for envelope-level skip.
  --test-filter <pattern>    Filter to a single instrumented class. Wildcard pattern
                             (e.g. *FooTest*) is resolved to FQN by source scan; literal
                             FQN passes through. Maps to
                             -Pandroid.testInstrumentationRunnerArguments.class=<FQN>.
  --device-task <name>       Force a specific gradle task (e.g. androidConnectedCheck).
                             Default auto-detects via gradle task probe — needed for KMP
                             modules using the new androidLibrary { } DSL where neither
                             connectedDebugAndroidTest nor connectedAndroidTest exist.
  --variant | --android-variant <value>
                             Android variant: auto (default; respects
                             testBuildType="release" projects via project-
                             model resolution), debug, release, or all
                             (umbrella connectedAndroidTest). Explicit values
                             override project-model resolution; combine with
                             --flavor to compose connected\${Cap}\${Variant}AndroidTest.
                             \`--android-variant\` is the legacy alias.
  --gradle-args <string>     Escape hatch: append tokens to every gradlew run.
                             Repeatable; whitespace-split. Tokens go LAST so
                             they OVERRIDE CLI defaults via gradle's last-wins
                             (--gradle-args "--no-parallel" wins over --parallel).
  --isolated                 Run gradle with --project-cache-dir <tmp> so
                             concurrent kmp-test invocations don't share
                             configuration cache. Tier-3 isolation.
  --isolated-cache-dir <p>   Override the temp project-cache-dir location.
                             Implies --isolated.
  --isolated-no-lock         Skip the OS-level cache-dir lockfile. Implies
                             --isolated.
  --java-home <path>         Override JDK location for this run. Skips
                             auto-select and preempts the host JAVA_HOME.
  --no-jdk-autoselect        Disable JDK catalogue auto-select (use the host's
                             JAVA_HOME unmodified). Pair with --java-home for
                             explicit control.
  --ignore-jdk-mismatch      Bypass the project-vs-JAVA_HOME JDK toolchain check
                             (default: BLOCK with exit 3 on mismatch)
  --dry-run                  Print the resolved plan and exit 0 without spawning
  --json                     Emit single JSON object on stdout (agentic mode)
  --color <mode>             always | never | auto (default). Auto detects piped/non-TTY
                             stdout and respects NO_COLOR; injects --console=plain into gradle.
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
  --variant | --android-variant <value>
                             Android variant for instrumented benchmarks:
                             auto (default; respects project-model
                             testBuildType resolution, falls back to
                             connectedAndroidTest umbrella), debug, release,
                             or all. JVM benchmarks ignore this flag — the
                             desktop\${Config}Benchmark task shape doesn't
                             split by build type.
                             \`--android-variant\` is the legacy alias.
  --timeout <seconds>        Per-task gradle watchdog timeout. Overrides the
                             KMP_GRADLE_TIMEOUT_MS env var and the per-config
                             default (smoke=300 / main=1800 / stress=3600).
                             Pass 0 to disable.
  --ignore-gradle-timeout    Disable the gradle watchdog entirely. Wins over
                             --timeout and KMP_GRADLE_TIMEOUT_MS. Equivalent
                             to --timeout 0.
  --strict-timeouts          Restore pre-graded exit-code behavior: any
                             gradle timeout exits 3 even when other modules
                             passed. Default (false) grades partial timeouts
                             as exit 0 + warnings[].code='partial_timeout'
                             when at least one module passed. Use this in
                             CI matrix cells that require hard fail on any
                             timeout.
  --gradle-args <string>     Escape hatch: append tokens to every gradlew run.
                             Repeatable; whitespace-split. Tokens go LAST so
                             they OVERRIDE CLI defaults via gradle's last-wins
                             (--gradle-args "--no-parallel" wins over --parallel).
  --isolated                 Run gradle with --project-cache-dir <tmp> so
                             concurrent kmp-test invocations don't share
                             configuration cache. Tier-3 isolation.
  --isolated-cache-dir <p>   Override the temp project-cache-dir location.
                             Implies --isolated.
  --isolated-no-lock         Skip the OS-level cache-dir lockfile. Implies
                             --isolated.
  --java-home <path>         Override JDK location for this run. Skips
                             auto-select and preempts the host JAVA_HOME.
  --no-jdk-autoselect        Disable JDK catalogue auto-select (use the host's
                             JAVA_HOME unmodified). Pair with --java-home for
                             explicit control.
  --ignore-jdk-mismatch      Bypass the project-vs-JAVA_HOME JDK toolchain check
                             (default: BLOCK with exit 3 on mismatch)
  --dry-run                  Print the resolved plan and exit 0 without spawning
  --json                     Emit single JSON object on stdout (agentic mode)
  --color <mode>             always | never | auto (default). Auto detects piped/non-TTY
                             stdout and respects NO_COLOR; injects --console=plain into gradle.
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
  --flavor <name>            Product flavor whose per-variant coverage report to
                             aggregate (flavored Android projects). Default:
                             the alphabetically-first flavor.
  --output-file <name>       Report filename. Default: coverage-full-report.md
  --skip-tests               Accepted for parity with \`parallel --skip-tests\`
                             (the \`coverage\` subcommand sets this internally).
                             Silently consumed; no effect on coverage flow.
  --java-home <path>         Override JDK location for this run. Skips
                             auto-select and preempts the host JAVA_HOME.
  --no-jdk-autoselect        Disable JDK catalogue auto-select (use the host's
                             JAVA_HOME unmodified). Pair with --java-home for
                             explicit control.
  --ignore-jdk-mismatch      Bypass the project-vs-JAVA_HOME JDK toolchain check
                             (default: BLOCK with exit 3 on mismatch)
  --dry-run                  Print the resolved plan and exit 0 without spawning
  --json                     Emit single JSON object on stdout (agentic mode)
  --color <mode>             always | never | auto (default). Auto detects piped/non-TTY
                             stdout and respects NO_COLOR; injects --console=plain into gradle.
  --help                     Show this message

Example:
  cd ~/my-kmp-project && kmp-test coverage --json
`,
  doctor: `kmp-test doctor — diagnose the local environment

Usage: kmp-test doctor [--project-root <path>] [options]

Options:
  --project-root <path>      Gradle project root (default: cwd) — used to check gradlew
  --json                     Emit single JSON object on stdout (agentic mode)
  --color <mode>             always | never | auto (default). Auto detects piped/non-TTY
                             stdout and respects NO_COLOR; injects --console=plain into gradle.
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
  info: `kmp-test info — print environment paths and versions

Usage: kmp-test info [--project-root <path>] [options]

Lighter sibling of \`kmp-test doctor\`. Probes the same environment
dimensions but emits raw values without PASS/WARN/FAIL judgments —
designed for agents that need machine-readable paths/versions.

Options:
  --project-root <path>      Gradle project root (default: cwd)
  --no-adb                   Skip the ADB probe (also via KMP_TEST_SKIP_ADB=1)
  --json                     Emit single JSON envelope on stdout
  --color <mode>             always | never | auto (default). Auto detects piped/non-TTY
                             stdout and respects NO_COLOR; injects --console=plain into gradle.
  --help                     Show this message

JSON envelope keys (under info:{}):
  node, os, platform, shell{name,present}
  gradlew{present, project_root}
  jdk{version, java_home, note} | null
  jdk_catalogue[{major, vendor}]
  android_sdk{path, source} | null
  adb{version} | null
  config{present, path?, parse_ok?}
  gradle_config{parallel, workers_max, caching, daemon, configureondemand, sources}

Exit codes:
  0  always — info never fails (missing tools surface as null values)

Example:
  kmp-test info
  kmp-test info --json
`,
  describe: `kmp-test describe — print project metadata as JSON

Usage: kmp-test describe [--project-root <path>] [options]

Emits modules, per-module test tasks, coverage tool, and dependency
graph hints for the project — without running anything. Designed for
agents that need to enumerate test surface without executing it.

Options:
  --project-root <path>      Gradle project root (default: cwd)
  --module-filter <regex>    Filter modules array by name regex
  --skip-probe               Skip the gradle tasks probe (use cached or
                             static analysis only — fast but may miss
                             KMP-aware task names like connectedAndroidDeviceTest)
  --no-cache                 Bypass the .kmp-test-runner/cache/model-*.json cache
  --java-home <path>         Override JDK location for this run. Skips
                             auto-select and preempts the host JAVA_HOME.
  --no-jdk-autoselect        Disable JDK catalogue auto-select (use the host's
                             JAVA_HOME unmodified).
  --ignore-jdk-mismatch      Bypass the project-vs-JAVA_HOME JDK toolchain check
  --json                     Emit single JSON envelope on stdout (default)
  --color <mode>             always | never | auto (default). Auto detects piped/non-TTY
                             stdout and respects NO_COLOR; injects --console=plain into gradle.
  --help                     Show this message

JSON envelope keys:
  modules[{ name, platforms, test_tasks{unit,device,web,ios,macos},
            coverage_plugin, test_build_type }]
  coverage_tool: kover | jacoco | mixed | none
  dependency_graph{ composite_builds, included_modules }
  jdk_requirement{ min, agp }
  schema_version, cache_key

Exit codes:
  0  envelope emitted
  2  no settings.gradle.kts (errors[].code: "no_project")

Example:
  kmp-test describe --json
  kmp-test describe --module-filter "^core" --skip-probe
`,
  update: `kmp-test update — update kmp-test to the latest GitHub release

Usage: kmp-test update [options]

Detects the current version, probes the latest GitHub release tag, and
re-runs the install script when a newer version is available. Idempotent:
no-op when already on latest.

Options:
  --check                    Probe latest release; do not install. Useful for
                             "is there an update?" scripts.
  --force                    Re-install even if already on latest.
  --prefix <dir>             Forwarded to the install script (--prefix / -Prefix).
                             Default: install script's per-platform default.
  --prerelease               Allow pre-release tags. Default: stable releases only.
  --json                     Emit single JSON envelope on stdout
  --color <mode>             always | never | auto (default). Auto detects piped/non-TTY
                             stdout and respects NO_COLOR; injects --console=plain into gradle.
  --help                     Show this message

JSON envelope keys:
  current_version, latest_version, action, install_command?, errors[]?

Exit codes:
  0  no-op (already on latest) OR install succeeded OR --check returned cleanly
  3  release resolution failed OR install script failed (errors[].code set)

Example:
  kmp-test update --check
  kmp-test update --json
`,
};

function printHelp() {
  process.stdout.write(`kmp-test-runner — KMP/Android parallel test runner

Usage: kmp-test <subcommand> [--project-root <path>] [args...]

Subcommands:
  parallel   Run all tests in parallel with coverage (unit tests by default)
  changed    Run tests only for modules with uncommitted changes
  android    Run Android instrumented tests (Compose UI included; needs a device)
  benchmark  Run benchmark suites
  coverage   Generate coverage report (skips test execution)
  doctor     Diagnose the local environment (Node, bash/pwsh, gradlew, JDK, ADB)
  info       Print environment paths and versions (lighter doctor; JSON-friendly)
  describe   Print project metadata as JSON (modules, test tasks, coverage)
  update     Update kmp-test to the latest GitHub release (idempotent)

Run \`kmp-test <subcommand> --help\` for subcommand-specific flags.

Global options:
  --project-root <path>   Gradle project root (default: cwd)
  --test-filter <pattern> Filter tests to a single class (gradle --tests for JVM,
                          -Pandroid.testInstrumentationRunnerArguments.class for Android)
  --dry-run               Print the resolved plan and exit 0 without spawning the script
  --json                  Emit single JSON object on stdout (agentic mode, low-token)
  --force                 Bypass concurrent-invocation lockfile (.kmp-test-runner.lock)
  --isolated              Run with --project-cache-dir <tmp> for parallel-safe runs
                          (multi-agent fan-out). Pair with --isolated-no-lock for
                          true concurrency. Default cache: <project>/.kmp-test-runner/
                          cache-isolated/<runId>/ (auto-removed at exit).
  --isolated-cache-dir <path>
                          Override the isolated cache dir (user-owned; never removed).
                          Implies --isolated. Useful for CI tmpfs / RAM-disk pinning.
  --isolated-no-lock      Bypass the Tier 1 advisory lockfile (.kmp-test-runner.lock).
                          Pair with --isolated for true concurrent fan-out without
                          collision. KMP_TEST_KEEP_ISOLATED=1 also skips cache cleanup.
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

function checkGradlew(projectRoot, isWin) {
  const candidates = isWin ? ['gradlew.bat', 'gradlew'] : ['gradlew'];
  return candidates.some(c => existsSync(path.join(projectRoot, c)));
}

// Dispatch table. Hoists global flags, resolves the subcommand module,
// normalizes argv (alias / POSIX-equals / coverage-only), runs pre-spawn
// enum/int validation, then forwards to the command's run(). Script-backed
// subs (parallel/changed/android/benchmark/coverage) get the full pipeline
// context (gradlew check, JDK preflight, lockfile, spawn) via
// dispatchScriptCommand. Orchestrator-only subs (info/describe/update/doctor)
// get a minimal { args, jsonMode } context.
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
  if (argv[0] === '--help' || argv[0] === '-h') { printHelp(); return EXIT.SUCCESS; }
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(readVersion() + '\n');
    return EXIT.SUCCESS;
  }

  const sub = argv[0];
  const cmdModule = COMMAND_MODULES[sub];
  if (!cmdModule) {
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

  // Global `--color={always,never,auto}` strip. Sets module-level state
  // read by spawnGradle (lib/runners/console-mode.js). Invalid values
  // emit an invalid_args envelope before any orchestrator runs.
  try {
    const c = consumeColorFlag(cleanedArgs);
    cleanedArgs = c.args;
    if (c.mode !== null) setConsoleMode(c.mode);
  } catch (e) {
    const err = { code: 'invalid_flag_value', flag: '--color', message: e.message };
    if (jsonMode) {
      emitJson(buildInvalidArgsEnvelope({
        subcommand: sub,
        projectRoot: path.resolve(getProjectRoot(cleanedArgs)),
        durationMs: 0,
        errors: [err],
      }));
    } else {
      process.stderr.write(`kmp-test ${sub}: ${e.message}\n`);
    }
    return EXIT.CONFIG_ERROR;
  }

  // Orchestrator-only subs (info/describe/update/doctor) take a minimal call.
  if (!SCRIPT_BACKED_SUBS.has(sub)) {
    return cmdModule.run({ args: cleanedArgs, jsonMode });
  }

  // ─── Script-backed subs: full pipeline prep ─────────────────────────────

  // Expand the `--no-coverage` alias to `--coverage-tool none` BEFORE flag
  // translation runs. Translating `--no-coverage` directly produces a
  // `-NoCoverage` PowerShell switch the .ps1 scripts don't declare; bash
  // scripts also have no such flag. Wiring it as an alias here lets users
  // pass the natural form on either platform.
  cleanedArgs = expandNoCoverageAlias(cleanedArgs);

  // Split POSIX `--name=value` form into the
  // canonical `[--name, value]` shape BEFORE any downstream consumer sees
  // it. PowerShell's `-File` invocation mangles `--name=:value` shapes.
  cleanedArgs = expandPosixEqualsForm(cleanedArgs);

  // `--coverage-only` (parallel/coverage) implies
  // `--skip-tests`. Mirror in parallel-orchestrator's parseArgs covers
  // direct `node lib/runner.js parallel` invocations.
  if (cleanedArgs.includes('--coverage-only') && !cleanedArgs.includes('--skip-tests')) {
    cleanedArgs = [...cleanedArgs, '--skip-tests'];
  }

  // Pre-spawn input validation. Reject invalid
  // enum / numeric values BEFORE the ps1/sh wrapper spawn. Orchestrator-level
  // validation in parseArgs remains in place for direct `node lib/runner.js
  // <sub>` invocations (defense in depth).
  const invalidArgErrors = [];
  for (let i = 0; i < cleanedArgs.length; i++) {
    const a = cleanedArgs[i];
    const v = cleanedArgs[i + 1];
    switch (a) {
      case '--test-type':
        if (validateEnum('--test-type', v,
          ['common', 'jvm', 'android', 'androidUnit', 'androidInstrumented', 'ios', 'macos', 'js', 'wasm', 'all', 'desktop'],
          invalidArgErrors) !== null) i++;
        else if (v !== undefined) i++;
        break;
      case '--coverage-tool':
        if (validateEnum('--coverage-tool', v, ['auto', 'kover', 'jacoco', 'none'], invalidArgErrors) !== null) i++;
        else if (v !== undefined) i++;
        break;
      case '--platform':
        if (validateEnum('--platform', v, ['android', 'jvm', 'all'], invalidArgErrors) !== null) i++;
        else if (v !== undefined) i++;
        break;
      case '--max-workers':
      case '--timeout':
      case '--max-failures':
      case '--min-missed-lines':
        if (validateNonNegativeInt(a, v, invalidArgErrors) !== null) i++;
        else if (v !== undefined) i++;
        break;
      default: break;
    }
  }
  if (invalidArgErrors.length > 0) {
    if (jsonMode) {
      emitJson(buildInvalidArgsEnvelope({
        subcommand: sub,
        projectRoot: path.resolve(getProjectRoot(cleanedArgs)),
        durationMs: 0,
        errors: invalidArgErrors,
      }));
    } else {
      for (const err of invalidArgErrors) {
        process.stderr.write(`kmp-test ${sub}: ${err.message}\n`);
      }
    }
    return EXIT.CONFIG_ERROR;
  }

  // Merge user-global + project-local config and inject defaults
  // (--test-type / --coverage-tool / --exclude-modules / --java-home) BEFORE
  // downstream JDK + filter extraction. User-global java_home propagates via
  // the injected --java-home flag so getJavaHomeOverride / script-dispatcher
  // see it like a user-passed flag. Precedence: CLI flag wins over config.
  {
    const _projectRoot = path.resolve(getProjectRoot(cleanedArgs));
    const _mergedCfg = loadMergedConfig(_projectRoot);
    cleanedArgs = applyConfigDefaults(cleanedArgs, _mergedCfg);
  }

  // v0.6.x Gap 2: strip --no-jdk-autoselect (CLI-only) and capture the
  // pass-through flags --java-home / --ignore-jdk-mismatch.
  const njas = extractNoJdkAutoselect(cleanedArgs);
  cleanedArgs = njas.args;
  const noJdkAutoselect = njas.noAutoselect;
  const javaHomeOverride = getJavaHomeOverride(cleanedArgs);
  const ignoreJdk = getIgnoreJdkMismatch(cleanedArgs);

  // Pull --test-filter <pattern> out before resolution; android targets may
  // need the source tree walk (see resolvePatternForSubcommand).
  const tf = consumeTestFilter(cleanedArgs);
  cleanedArgs = tf.args;
  const testFilterPattern = tf.pattern;

  // Peek for --isolated* flags. Pass-through to the orchestrator
  // (which parses + strips them via parseIsolatedArgs). cli.js needs `noLock`
  // for the Tier 1 acquireLock decision and `enabled`/`cacheDir` for the
  // top-level `isolated:{}` envelope field on dry-run.
  const isolatedFlags = peekIsolatedFlags(cleanedArgs);

  // Resolve & freeze project root before any spawn.
  const projectRoot = path.resolve(getProjectRoot(cleanedArgs));
  const isWin = process.platform === 'win32';
  const scriptsDir = path.join(__dirname, '..', 'scripts');

  return cmdModule.run({
    cmd: COMMANDS[sub],
    projectRoot,
    cleanedArgs,
    jsonMode,
    dryRun,
    force,
    ignoreJdk,
    javaHomeOverride,
    noJdkAutoselect,
    testFilterPattern,
    isolatedFlags,
    isWin,
    scriptsDir,
  });
}

export {
  main,
  COMMANDS,
  EXIT,
  // Re-exported from ./runners/shell-runner.js (do not delete —
  // tests/vitest/cli.test.js + parallel-orchestrator import these from cli.js).
  resolveScript,
  pickWindowsShell,
  translateFlagForPowerShell,
  translateBashFlagsForPowerShell,
  collapseGradleArgs,
  PS_GRADLE_ARGS_SEP,
  ensureProjectRoot,
  getProjectRoot,
  getCoverageToolFromArgs,
  getBenchmarkPlatform,
  getBenchmarkConfigFromArgs,
  checkGradlew,
  consumeJsonFlag,
  consumeDryRunFlag,
  consumeForceFlag,
  consumeColorFlag,
  consumeTestFilter,
  peekIsolatedFlags,
  expandNoCoverageAlias,
  getIgnoreJdkMismatch,
  getJavaHomeOverride,
  extractNoJdkAutoselect,
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
  enforceErrorsExitCodeInvariant,
  buildDryRunReport,
  envErrorJson,
  buildInvalidArgsEnvelope,
  ENVELOPE_SCHEMA_VERSION,
  readVersion,
  printHelp,
  printSubcommandHelp,
  findFirstClassFqn,
  splitClassMethod,
  resolveAndroidTestFilter,
  resolvePatternForSubcommand,
  runDoctorChecks,
  runDoctor,
  parseGradleConfig,
  parseGradleTimeoutMs,
  DEFAULT_GRADLE_TIMEOUT_MS,
  resolveBenchmarkOuterTimeoutMs,
  BENCHMARK_OUTER_TIMEOUTS_MS,
  extractMigratedEnvelope,
  MIGRATED_ENVELOPE_BEGIN,
  MIGRATED_ENVELOPE_END,
  applyErrorCodeDiscriminators,
};

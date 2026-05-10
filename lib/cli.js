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
// wet-audit-v0.9-part2 OBS-2 — dry-run path enumerates resolved modules
// using the same filter logic as wet runs. Imports limited to filter-time
// helpers (no spawn).
import {
  parseArgs as parseParallelArgs,
  applyModuleFilters,
  canonicalModuleEntry,
  discoverParallelModules,
} from './parallel-orchestrator.js';
// v0.6.x Gap 2: discover installed JDKs to auto-select a matching one
// when the project requires a different version than the host default.
import { discoverInstalledJdks } from './jdk-catalogue.js';
// v0.8.0: project-level config (`.kmp-test-runner.json`) — used by doctor +
// applyConfigDefaults for flag re-injection before subcommand dispatch.
// PR-04: doctor's own consumers (loadProjectConfig + CONFIG_FILE_NAME +
// android-sdk-catalogue helpers) moved into lib/commands/doctor.js. cli.js
// keeps only what main() / applyConfigDefaults still need.
import { loadProjectConfig, applyConfigDefaults } from './project-config.js';
// v0.9 step 3 — Node-only orchestrators for the new DX-parity subcommands.
// Imports are static (not dynamic): the orchestrators import runDoctorChecks /
// buildJsonReport / EXIT from this file, so we'd hit a top-level `import` cycle.
// ESM resolves this via live bindings — at evaluation time the orchestrator
// modules see this file's exports as partially-initialized references; by the
// time main() actually invokes them, all bindings are stable. See lib/info-
// orchestrator.js, lib/describe-orchestrator.js, lib/update-orchestrator.js.
// v0.9 session 2 Bug-A.2 — POSIX `--name=value` form normalization. cli.js
// must split BEFORE the ps1/sh wrapper spawn since PowerShell's `-File`
// invocation mangles `--name=:value` (parses as parameter binding, eats the
// flag, strips the leading colon on the value).
// v0.9 session 2 Bug-B/Bug-D — pre-spawn enum / numeric validation so
// `kmp-test parallel --test-type bogus` exits CONFIG_ERROR (2) with the
// canonical `invalid_flag_value` shape rather than falling through to the
// ps1 wrapper's `[ValidateSet]` (whose error doesn't surface as JSON).
import { expandPosixEqualsForm, validateEnum, validateNonNegativeInt } from './orchestrator-utils.js';
import { runInfo, formatInfoText } from './info-orchestrator.js';
import { runDescribe, formatDescribeText } from './describe-orchestrator.js';
import { runUpdate, formatUpdateText } from './update-orchestrator.js';
// Refactor PR-04 — `kmp-test doctor` extracted to lib/commands/doctor.js.
// cli.js re-exports runDoctor / runDoctorChecks via the export block at the
// bottom; ESM live bindings handle the cli.js↔commands/doctor.js circular
// reference (doctor.js still pulls getProjectRoot / parseGradleConfig /
// checkGradlew from cli.js).
import { runDoctor, runDoctorChecks } from './commands/doctor.js';
// Refactor PR-01 — envelope shape concerns (exit codes, schema version,
// builders) live in lib/envelope/. cli.js re-exports these names from its
// existing `export {}` block at the bottom so external consumers
// (orchestrators, tests) keep importing from './cli.js' unchanged via ESM
// live bindings.
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
// the parsers would silently miss the flags — fixed v0.9 step 3 (live repro
// 2026-05-05 against dipatternsdemo: `kmp-test android --variant release
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
  --test-type <type>         all | common | androidUnit | androidInstrumented | desktop | ios | macos
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
  --output-file <path>       Filename for the aggregated coverage / parallel
                             report. Default: coverage-full-report.md.
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
  --test-type <type>         all | common | androidUnit | androidInstrumented | desktop | ios | macos
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
  info: `kmp-test info — print environment paths and versions

Usage: kmp-test info [--project-root <path>] [options]

Lighter sibling of \`kmp-test doctor\`. Probes the same environment
dimensions but emits raw values without PASS/WARN/FAIL judgments —
designed for agents that need machine-readable paths/versions.

Options:
  --project-root <path>      Gradle project root (default: cwd)
  --no-adb                   Skip the ADB probe (also via KMP_TEST_SKIP_ADB=1)
  --json                     Emit single JSON envelope on stdout
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
  parallel   Run all tests in parallel with coverage
  changed    Run tests only for modules with uncommitted changes
  android    Run Android instrumented tests
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
//
// v0.9 session 2 Bug-A.1 — POSIX `--name=value` form: split on the FIRST `=`
// before walking dash segments, so the value is preserved verbatim. Without
// this, `--module-filter=:core-result` was translated to `-ModuleFilter=:coreResult`
// (mangling `core-result` → `coreResult`) and `--gradle-args=--rerun-tasks` to
// `-GradleArgs=RerunTasks` (losing the value's leading `--`).
function translateFlagForPowerShell(arg) {
  if (typeof arg !== 'string' || !arg.startsWith('--')) return arg;
  const eq = arg.indexOf('=');
  const head = eq > 2 ? arg.slice(0, eq) : arg;
  const tail = eq > 2 ? arg.slice(eq) : '';
  const rest = head.slice(2);
  return '-' + rest.split('-')
    .map(w => w.length === 0 ? '' : w[0].toUpperCase() + w.slice(1))
    .join('') + tail;
}

// v0.9 step 2 — PowerShell-binding hazards for the new --gradle-args flag.
//
// Two pitfalls when bridging bash-form `--gradle-args VAL` to the PowerShell
// wrapper:
//   1. PowerShell binds [string[]] parameters via COMMA syntax, NOT repeated
//      `-Param`. `-GradleArgs A -GradleArgs B` errors with "specified more
//      than once". We can't use comma either: gradle props naturally contain
//      commas (e.g. `-Pfoo=a,b`).
//   2. translateFlagForPowerShell maps every arg starting with `--` to its
//      PascalCase form. That correctly handles flags but mangles --gradle-args
//      VALUES that themselves start with `--` (e.g. `--no-parallel` would be
//      translated to `-NoParallel`, which gradle doesn't recognise).
//
// Combined fix:
//   * collapseGradleArgs (called BEFORE translation) joins repeated
//     `--gradle-args` invocations into a single arg whose value is the
//     sentinel-joined list. ASCII Unit Separator (\x1F) is guaranteed not
//     to appear in gradle CLI flags.
//   * translateBashFlagsForPowerShell replaces the simple `.map()`. It
//     preserves the value immediately after `--gradle-args` verbatim so
//     a value like `--no-parallel\x1F-Pfoo=bar` survives intact.
//   * The ps1 wrapper splits on \x1F and re-emits one `--gradle-args <tok>`
//     per element so the Node-side parser sees the canonical multi-invocation
//     shape.
const PS_GRADLE_ARGS_SEP = '\u001F';
function collapseGradleArgs(args) {
  const out = [];
  const collected = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--gradle-args' && i + 1 < args.length) {
      collected.push(args[i + 1]);
      i++;
    } else {
      out.push(args[i]);
    }
  }
  if (collected.length > 0) out.push('--gradle-args', collected.join(PS_GRADLE_ARGS_SEP));
  return out;
}
function translateBashFlagsForPowerShell(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    out.push(translateFlagForPowerShell(a));
    if (a === '--gradle-args' && i + 1 < args.length) {
      // Value of --gradle-args is opaque pass-through; never translate.
      out.push(args[++i]);
    }
  }
  return out;
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

// Pre-flight JDK check. Returns null if OK, { required, current, agpVersion } if mismatch.
// `agpVersion` is null when the project doesn't apply AGP; non-null when the
// AGP runtime requirement contributed to the JDK floor (used by the auto-select
// notice to explain WHY the JDK was bumped).
//
// Returns one of:
//   - `null` — no signal, no JDK detected, or host already matches (silent no-op)
//   - `{ kind: 'preserved', required, current, agpVersion }` — host EXCEEDS the
//     AGP-binding floor; preserves host (no JAVA_HOME override) but caller may
//     emit a [NOTICE] for observability. v0.8.0 fix-PR-B (PR3 used to coerce
//     down to the floor; that breaks bytecode-65 Compose deps on Confetti-style
//     projects whose AGP floor is JDK 17 but whose host is JDK 23).
//   - `{ kind: 'mismatch', required, current, agpVersion }` — host BELOW floor;
//     caller fires auto-select / gate.
//
// Skips (returns null) when:
//   - gradle.properties has `org.gradle.java.home` pointing to an existing dir
//     (user explicitly told gradle which JDK to use; JAVA_HOME is moot)
//   - no JDK requirement signal (jvmToolchain / JvmTarget / JavaVersion / AGP runtime)
//     found in any build script (can't determine required)
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

  const sig = aggregateJdkSignals(projectRoot);
  const required = sig.min;
  if (!required) return null;

  const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (java.error || java.status === null) return null;
  const out = (java.stderr || '') + (java.stdout || '');
  const m = out.match(/version "([^"]+)"/);
  if (!m) return null;
  const head = m[1].split('.')[0];
  const current = head === '1' ? parseInt(m[1].split('.')[1] || '0', 10) : parseInt(head, 10);
  if (!current || current === required) return null;

  if (current > required) {
    // Host meets/exceeds the floor — preserve. Surface observability only when
    // AGP is the BINDING signal: that's the case where the floor came from an
    // implicit AGP requirement (not something the user typed in build.gradle.kts),
    // so an explanatory banner helps. When jvmToolchain raises the floor above
    // AGP, the user already opted in to that JDK requirement explicitly — no
    // banner needed.
    if (sig.agpIsBinding) {
      return { kind: 'preserved', required, current, agpVersion: sig.agpVersion };
    }
    return null;
  }

  return { kind: 'mismatch', required, current, agpVersion: sig.agpVersion };
}

// v0.8.1 — Gradle config diagnostic. Pure-additive `--json` field on
// `kmp-test doctor`: surfaces the resolved values for `org.gradle.parallel` /
// `workers.max` / `caching` / `daemon` / `jvmargs` / `configureondemand` from
// `<projectRoot>/gradle.properties` + `~/.gradle/gradle.properties`. Project
// values override user-global. No behaviour change — agents read this to
// decide e.g. whether to layer their own parallel scheduler on top of gradle's.
//
// Tier 1 of the "Adapt CLI to project's Gradle config" BACKLOG entry. Tier 2
// (`--gradle-args` passthrough) deferred to v0.9; Tier 3 (auto-respect) v1.0.
//
// `homedirOverride` exists for tests — production calls without it use the
// real `os.homedir()`.
const GRADLE_CONFIG_KEYS = [
  'org.gradle.parallel',
  'org.gradle.workers.max',
  'org.gradle.caching',
  'org.gradle.daemon',
  'org.gradle.jvmargs',
  'org.gradle.configureondemand',
];

function parseGradleConfig(projectRoot, homedirOverride) {
  const props = {};
  const sources = { project: false, user: false };
  const home = homedirOverride || os.homedir();

  const userPath = path.join(home, '.gradle', 'gradle.properties');
  if (existsSync(userPath)) {
    try {
      _readGradleConfigKeys(readFileSync(userPath, 'utf8'), props);
      sources.user = true;
    } catch { /* best-effort — never block doctor on this */ }
  }

  // Project values applied second so they override user-global on collision.
  const projectPath = path.join(projectRoot, 'gradle.properties');
  if (existsSync(projectPath)) {
    try {
      _readGradleConfigKeys(readFileSync(projectPath, 'utf8'), props);
      sources.project = true;
    } catch { /* best-effort */ }
  }

  return {
    parallel: _toGradleBool(props['org.gradle.parallel'], false),
    workers_max: props['org.gradle.workers.max']
      ? parseInt(props['org.gradle.workers.max'], 10)
      : null,
    caching: _toGradleBool(props['org.gradle.caching'], false),
    daemon: _toGradleBool(props['org.gradle.daemon'], true),
    jvmargs: props['org.gradle.jvmargs'] ?? null,
    configureondemand: _toGradleBool(props['org.gradle.configureondemand'], false),
    sources,
  };
}

function _readGradleConfigKeys(txt, props) {
  for (const k of GRADLE_CONFIG_KEYS) {
    const re = new RegExp(
      '^[ \\t]*' + k.replace(/\./g, '\\.') + '[ \\t]*=[ \\t]*(.+?)[ \\t\\r]*$',
      'm'
    );
    const m = txt.match(re);
    if (m) props[k] = m[1];
  }
}

function _toGradleBool(v, defaultVal) {
  if (v === undefined || v === null) return defaultVal;
  return String(v).trim().toLowerCase() === 'true';
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

// v0.9 step 4 — peek at `--isolated*` flags WITHOUT stripping. The
// orchestrators strip + parse them themselves (via
// orchestrator-utils.js#parseIsolatedArgs) so they can emit the resulting
// state in their envelope. cli.js only needs `noLock` for the Tier 1
// acquireLock decision; we read all three for symmetry / future use.
function peekIsolatedFlags(args) {
  let enabled = false;
  let cacheDir = null;
  let noLock = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--isolated') enabled = true;
    // v0.9 session 2 Bug-F — `--isolated-no-lock` implies `--isolated`. The
    // help text documents the implication; pre-fix passing `--isolated-no-lock`
    // alone produced `isolated:{enabled:false, locked:false}` (a nonsensical
    // shape — locked:false but no isolation actually applied). Mirrors the
    // existing `--isolated-cache-dir` branch below.
    else if (args[i] === '--isolated-no-lock') { noLock = true; enabled = true; }
    else if (args[i] === '--isolated-cache-dir' && args[i + 1] !== undefined) {
      cacheDir = args[i + 1];
      enabled = true;
      i++;
    }
  }
  return { enabled, cacheDir, noLock };
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

  // no_test_modules — wrapper script discovered no modules matching the
  // filter. Either the project has no test source sets (e.g. a sample app
  // with only `composeApp` that itself has no tests), the user's
  // `--module-filter` excluded everything, or `--test-type` filtered out
  // every module (UX-2: starting with v0.7.x the wrapper words this case
  // as "No modules support the requested --test-type=<X>"). Discriminates
  // the most common parse-gap cause; surfaced from v0.6.1 stress test
  // against Nav3Guide-scenes and kmp-production-sample.
  const noModulesMatch = stdout.match(/^\[ERROR\] No modules (?:found matching filter|support the requested)[^\n]*/m);
  if (noModulesMatch) {
    state.errors.push({
      code: 'no_test_modules',
      message: noModulesMatch[0].trim(),
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

// Capture `[SKIP] <module> (<reason>)` lines emitted by the legacy wrapper
// (run-parallel-coverage-suite.{sh,ps1}) into `state.skipped[]`. Two emission
// sites: discovery-time skips go to stderr (`[SKIP] mod (excluded by ...)`,
// `[SKIP] mod (no test source set ...)`), test-task-time skips go to stdout
// (`  [SKIP] mod (no jvmTest tests)`). Match the canonical shape on both
// streams. Surfaces enough signal for downstream agents to suggest
// `--include-untested` or audit module-filter mistakes.
function parseSkippedModules(stdout, stderr, state) {
  const all = stdout + '\n' + stderr;
  const seen = new Set();
  for (const m of all.matchAll(/^\s*\[SKIP\]\s+(\S+)\s+\(([^)]+)\)\s*$/gm)) {
    const key = `${m[1]}|${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    state.skipped.push({ module: m[1], reason: m[2].trim() });
  }
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
    skipped: [],
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

  parseSkippedModules(stdout, stderr, state);

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
    skipped: state.skipped,
    coverage: state.coverage,
    errors: state.errors,
    warnings: state.warnings,
  };
  if (state.benchmark) result.benchmark = state.benchmark;
  return result;
}

// wet-audit-v0.9-part2 OBS-2 — resolve which modules WOULD be dispatched
// by `parallel` / `changed` (`changed` shares parallel-orchestrator's filter
// chain). Best-effort: returns null when the subcommand is not module-aware
// or when project-model loading fails. Pure read-only — no spawn, no gradle
// invocation, no side-effects on the project tree.
//
// Returns `{ modules: [{name,type,coverage_plugin,...}], skipped: [{module,reason}] }`
// — same shape as the `--list-only` short-circuit so agents can branch
// uniformly on dry-run / list-only / wet outputs.
function resolveDryRunModules(subcommand, projectRoot, finalArgs) {
  if (subcommand !== 'parallel' && subcommand !== 'changed') return null;
  try {
    const projectModel = buildProjectModel(projectRoot);
    // discoverParallelModules walks projectModel.modules (object keyed by
    // gradle path), strips the leading colon, and returns an array of
    // module objects with the shape expected by applyModuleFilters /
    // canonicalModuleEntry. Mirrors the wet-run discovery path so dry-run
    // module resolution stays in lockstep with what would actually run.
    const allModules = discoverParallelModules(projectModel);
    if (!allModules || allModules.length === 0) return null;
    const opts = parseParallelArgs(finalArgs);
    const { kept, skipped } = applyModuleFilters(allModules, opts, process.env);
    return {
      modules: kept.map(canonicalModuleEntry),
      skipped: skipped || [],
    };
  } catch {
    return null;
  }
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

  // v0.9 step 3 — Node-only orchestrators (no shell scripts). Each special-
  // cases here like doctor; never spawns gradle. Static-imported at the top
  // of this file (ESM live bindings handle the circular dep — see import
  // block above).
  if (sub === 'info') {
    const cleanedArgs = argv.slice(1);
    if (cleanedArgs.includes('--help') || cleanedArgs.includes('-h')) {
      printSubcommandHelp('info');
      return EXIT.SUCCESS;
    }
    const projectRoot = path.resolve(getProjectRoot(cleanedArgs));
    const { envelope, exitCode } = runInfo({ projectRoot, args: cleanedArgs });
    if (jsonMode) emitJson(envelope);
    else process.stdout.write(formatInfoText(envelope.info));
    return exitCode;
  }
  if (sub === 'describe') {
    const cleanedArgs = argv.slice(1);
    if (cleanedArgs.includes('--help') || cleanedArgs.includes('-h')) {
      printSubcommandHelp('describe');
      return EXIT.SUCCESS;
    }
    const projectRoot = path.resolve(getProjectRoot(cleanedArgs));
    const { envelope, exitCode } = runDescribe({ projectRoot, args: cleanedArgs });
    if (jsonMode) emitJson(envelope);
    else process.stdout.write(formatDescribeText(envelope));
    return exitCode;
  }
  if (sub === 'update') {
    const cleanedArgs = argv.slice(1);
    if (cleanedArgs.includes('--help') || cleanedArgs.includes('-h')) {
      printSubcommandHelp('update');
      return EXIT.SUCCESS;
    }
    const projectRoot = path.resolve(getProjectRoot(cleanedArgs));
    // runUpdate is async (uses fetch). Fire the promise; bin/kmp-test.js
    // detects the ASYNC_DEFERRED sentinel and skips its sync process.exit.
    // process.exit fires from the .then() callback below when the orchestrator
    // resolves. Keeps main() sync for the other 89 cli.test.js call sites.
    runUpdate({ projectRoot, args: cleanedArgs }).then(
      ({ envelope, exitCode }) => {
        if (jsonMode) emitJson(envelope);
        else process.stdout.write(formatUpdateText(envelope));
        process.exit(exitCode);
      },
      (err) => {
        process.stderr.write(`kmp-test update: ${err && err.stack || err}\n`);
        process.exit(EXIT.ENV_ERROR);
      },
    );
    return ASYNC_DEFERRED;
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

  // v0.9 session 2 Bug-A.2 — split POSIX `--name=value` form into the
  // canonical `[--name, value]` shape BEFORE any downstream consumer (ps1
  // wrapper, sh wrapper, runner.js, orchestrator parsers). PowerShell's
  // `-File` invocation mangles `--name=:value` shapes (parses as parameter
  // binding, eats the `=` token, strips a leading colon on the value), so
  // every consumer that's downstream of cli.js must see the space form.
  // Orchestrator-level expandPosixEqualsForm calls remain in place for
  // direct `node lib/runner.js <sub>` invocations (which don't go through
  // cli.js). Keep BOTH layers — defense in depth.
  cleanedArgs = expandPosixEqualsForm(cleanedArgs);

  // v0.9 session 2 Bug-E — `--coverage-only` (parallel/coverage) implies
  // `--skip-tests`. The implication must fire HERE so the ps1/sh wrapper
  // receives both flags in spawn_args; mirror in parallel-orchestrator's
  // parseArgs covers direct `node lib/runner.js parallel` invocations.
  if (cleanedArgs.includes('--coverage-only') && !cleanedArgs.includes('--skip-tests')) {
    cleanedArgs = [...cleanedArgs, '--skip-tests'];
  }

  // v0.9 session 2 Bug-B/Bug-D — pre-spawn input validation. Reject invalid
  // enum / numeric values BEFORE the ps1/sh wrapper spawn so the user gets a
  // canonical `invalid_flag_value` JSON envelope (exit 2) instead of either
  // (a) ps1's PowerShell ValidateSet error (which cli.js's parse-gap fallback
  // surfaces as `no_summary` — confusing), or (b) silent fall-through to NaN
  // in the orchestrator. Orchestrator-level validation in parseArgs remains
  // in place for direct `node lib/runner.js <sub>` invocations.
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

  // v0.9 step 4 — peek for --isolated* flags. These pass through to the
  // orchestrator (which parses + strips them via parseIsolatedArgs from
  // orchestrator-utils); cli.js only needs `noLock` for the Tier 1
  // acquireLock decision below.
  const isolatedFlags = peekIsolatedFlags(cleanedArgs);

  // Resolve & freeze project root before any spawn.
  const projectRoot = path.resolve(getProjectRoot(cleanedArgs));

  // Pre-flight gradlew check.
  const isWin = process.platform === 'win32';
  if (!checkGradlew(projectRoot, isWin)) {
    const wrapper = isWin ? 'gradlew.bat' : 'gradlew';
    const msg = `no ${wrapper} found in ${projectRoot}`;
    if (jsonMode) {
      emitJson(envErrorJson({ subcommand: sub, projectRoot, durationMs: 0, message: msg, code: 'no_gradlew' }));
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
  const jdkResult = !dryRun ? preflightJdkCheck(projectRoot) : null;
  // v0.8.0 fix-PR-B: surface a [NOTICE] when the host JDK exceeds an
  // AGP-implied floor and we're preserving it. Without this banner the
  // precedence decision is invisible — users hit "host JDK 23 > AGP 8.x
  // floor 17" silently and can't tell whether kmp-test even noticed the
  // floor. The notice fires only when AGP is the BINDING signal (see
  // preflightJdkCheck for the definition).
  if (jdkResult?.kind === 'preserved') {
    process.stderr.write(
      `[NOTICE] host JDK ${jdkResult.current} meets AGP ${jdkResult.agpVersion} floor `
      + `(JDK ${jdkResult.required}); preserving host\n`,
    );
  }
  const mismatch = jdkResult?.kind === 'mismatch' ? jdkResult : null;
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
        const agpNote = mismatch.agpVersion ? ` — project applies AGP ${mismatch.agpVersion}` : '';
        process.stderr.write(
          `[NOTICE] auto-selecting JDK ${mismatch.required} from ${match.path} `
          + `(${match.vendor}; host default is JDK ${mismatch.current}${agpNote})\n`,
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

  // v0.8.0 — apply config-file defaults before constructing finalArgs. This
  // re-injects --test-type / --coverage-tool / --exclude-modules from
  // .kmp-test-runner.json when the CLI didn't pass them. CLI flags always win
  // (applyConfigDefaults is a no-op if the flag is already present in argv).
  const projectConfig = loadProjectConfig(projectRoot);
  const argsWithConfigDefaults = applyConfigDefaults(cleanedArgs, projectConfig);

  // Inject --project-root if missing.
  const withProjectRoot = ensureProjectRoot(argsWithConfigDefaults);
  let finalArgs = [...cmd.prefix, ...withProjectRoot];
  if (resolvedFilter !== null && resolvedFilter !== undefined) {
    finalArgs = [...finalArgs, '--test-filter', resolvedFilter];
  }

  const scriptsDir = path.join(__dirname, '..', 'scripts');

  let spawnCmd, spawnArgs, scriptPath;
  if (isWin) {
    const shell = pickWindowsShell();
    scriptPath = path.join(scriptsDir, 'ps1', cmd.ps1);
    // Order matters: collapse repeated --gradle-args on the BASH form BEFORE
    // translating flags. Once collapsed, translateBashFlagsForPowerShell
    // preserves the (now-single) value verbatim so tokens like --no-parallel
    // don't get mangled into -NoParallel.
    const collapsedArgs = collapseGradleArgs(finalArgs);
    // v0.9 step 3 — bare-passthrough ps1 wrappers (changed/android/benchmark)
    // splat @args straight to runner.js. Their Node-side parsers expect
    // kebab; translating to PascalCase silently breaks every explicit flag.
    // Skip translation for those — PowerShell forwards strings unchanged
    // when the wrapper has no param() block. The shared
    // run-parallel-coverage-suite.ps1 keeps the param-block typed entry
    // (-ProjectRoot [string], …) so its dispatch still translates.
    const translatedArgs = cmd.passthrough
      ? collapsedArgs
      : translateBashFlagsForPowerShell(collapsedArgs);
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
    // wet-audit-v0.9-part2 OBS-2 — enrich `plan.modules[]` with the resolved
    // module set when the subcommand is module-aware (parallel/changed).
    // Pre-fix `--dry-run --json` only carried spawn-level info; agents
    // wanting to preview WHICH modules would be dispatched had to invoke
    // `describe` (or `--list-only`) separately. Now plan.modules[] mirrors
    // the canonical shape used by wet runs + `--list-only`. Best-effort:
    // resolveDryRunModules() returns null when the subcommand doesn't
    // resolve modules (info/doctor/update) or when project-model loading
    // fails — plan.modules then defaults to []/[] without an error.
    const resolved = resolveDryRunModules(sub, projectRoot, finalArgs);
    plan.modules = resolved ? resolved.modules : [];
    plan.skipped = resolved ? resolved.skipped : [];
    // v0.9 step 9.6 (Bug #6) — populate the top-level `isolated:{}` envelope
    // field from the already-peeked `isolatedFlags`. Dry-run never resolves
    // a real cache_dir (no mkdir / lockfile in dry-run), so the field carries
    // the user's intent (`enabled` + optional cacheDir override) without
    // forcing agents to inspect `plan.spawn_args` for the `-Isolated` flag.
    const isolatedField = {
      enabled: !!isolatedFlags.enabled,
      cache_dir: isolatedFlags.cacheDir || null,
      kept: false,  // dry-run never persists anything
      locked: !isolatedFlags.noLock,
    };
    if (jsonMode) {
      emitJson(buildDryRunReport({ subcommand: sub, projectRoot, plan, isolated: isolatedField }));
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
      if (plan.modules.length > 0) {
        process.stdout.write(`  Modules (${plan.modules.length}):\n`);
        for (const m of plan.modules) {
          process.stdout.write(`    - ${m.name}\n`);
        }
      }
    }
    return EXIT.SUCCESS;
  }

  // Acquire advisory lockfile before spawning. doctor + dry-run skip this
  // (they neither spawn gradle nor write reports). --force bypasses a live
  // lock; stale locks (PID dead) are reclaimed automatically.
  //
  // v0.9 step 4 — `--isolated-no-lock` opts out entirely. With each isolated
  // run holding its own gradle cache dir (--project-cache-dir <tmp>), Tier 1
  // serialization is no longer required: multi-agent fan-out can run
  // concurrently against the same project without collision.
  const lockResult = isolatedFlags.noLock
    ? { ok: true, skipped: true }
    : acquireLock(projectRoot, sub, { force });
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
  // v0.9 step 4 — when --isolated-no-lock skipped acquireLock, there's no
  // lockfile to remove (and stomping one written by a concurrent run would
  // be incorrect). Make cleanup a no-op in that case.
  const cleanup = () => { if (!isolatedFlags.noLock) removeLockfile(projectRoot); };
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
    // v0.8.0 — adaptive outer timeout for `benchmark`. The orchestrator
    // applies a per-config inner timeout (smoke=300s, main=1800s, stress=
    // 3600s); this outer wrapper-level watchdog must be ≥ that or it would
    // SIGTERM the wrapper before the orchestrator could surface
    // `gradle_timeout`. We add a 30-min safety margin on top of the inner
    // default for the chosen --config. KMP_GRADLE_TIMEOUT_MS env override
    // continues to win.
    const timeoutMs = sub === 'benchmark'
      ? resolveBenchmarkOuterTimeoutMs(spawnArgs, process.env)
      : parseGradleTimeoutMs();

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
    // v0.8 STRATEGIC PIVOT: tell lib/runner.js to emit its sentinel-bracketed
    // envelope on stdout when we're spawning a migrated subcommand AND we're
    // in JSON mode. lib/cli.js#consumeJsonFlag already stripped --json upstream,
    // so the wrapper can't infer this from argv.
    if (cmd.migrated && jsonMode) {
      spawnOpts.env = { ...(spawnOpts.env || process.env), KMP_TEST_RUNNER_EMIT_ENVELOPE: '1' };
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
          emitJson(envErrorJson({ subcommand: sub, projectRoot, durationMs, message: msg, code: 'missing_shell' }));
        } else {
          process.stderr.write(`kmp-test: ${msg}\n`);
        }
        return EXIT.ENV_ERROR;
      }
      process.stderr.write(`kmp-test: failed to spawn '${spawnCmd}': ${result.error.message}\n`);
      return EXIT.TEST_FAIL;
    }

    const scriptStatus = result.status ?? EXIT.TEST_FAIL;

    // Migrated subcommand short-circuit (v0.8 STRATEGIC PIVOT).
    // The orchestrator (lib/<feature>-orchestrator.js, invoked via the thin
    // wrapper which exec's lib/runner.js) emits a fully-formed envelope
    // bracketed by sentinel markers on stdout. Use it directly; skip the
    // legacy parseScriptOutput / buildJsonReport path. Non-migrated
    // subcommands fall through to the legacy path below unchanged.
    if (cmd.migrated && jsonMode) {
      const envelope = extractMigratedEnvelope(capturedStdout);
      if (envelope) {
        // Run the WS-5 invariant against the orchestrator envelope too —
        // hardErrors with exit_code:0 should still get promoted to TEST_FAIL.
        const parsedAdapter = {
          tests: envelope.tests,
          errors: envelope.errors,
        };
        envelope.exit_code = enforceErrorsExitCodeInvariant(
          envelope.exit_code ?? scriptStatus, parsedAdapter
        );
        emitJson(envelope);
        return envelope.exit_code;
      }
      // No sentinel found → fall through to legacy parser as a safety net.
    }

    // Parse output up-front so the WS-5 invariant can promote scriptStatus
    // before BOTH the JSON envelope build and the process exit. Parse cost
    // is negligible vs. the script run we just did.
    const parsed = parseScriptOutput(capturedStdout, capturedStderr, finalArgs, sub);
    const resolvedStatus = enforceErrorsExitCodeInvariant(scriptStatus, parsed);

    if (jsonMode) {
      emitJson(buildJsonReport({
        subcommand: sub,
        projectRoot,
        exitCode: resolvedStatus,
        durationMs,
        parsed,
      }));
    }

    return resolvedStatus;
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
  translateBashFlagsForPowerShell,
  collapseGradleArgs,
  PS_GRADLE_ARGS_SEP,
  ensureProjectRoot,
  getProjectRoot,
  getCoverageToolFromArgs,
  getBenchmarkPlatform,
  checkGradlew,
  consumeJsonFlag,
  consumeDryRunFlag,
  consumeForceFlag,
  consumeTestFilter,
  peekIsolatedFlags,
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

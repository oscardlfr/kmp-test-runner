// SPDX-License-Identifier: MIT
// lib/orchestrator-utils.js — shared helpers for the v0.8 PIVOT orchestrators
// (benchmark / changed / android / coverage / parallel). Centralizes the
// settings.gradle.kts + per-module build.gradle.kts walking that every
// orchestrator needs. Sub-entries 1+2 wired this module; 3-5 follow.
//
// ── Validation error contract (used by every orchestrator's parseArgs) ─────
// Orchestrators that validate flag values push entries onto a caller-provided
// `out.errors[]`. The runX caller inspects `opts.errors` BEFORE any gradle /
// git work; when at least one entry has `code === 'invalid_flag_value'` the
// caller emits an EXIT.CONFIG_ERROR envelope via `buildInvalidArgsEnvelope`
// and exits.
//
//   Entry shape:
//     { code: 'invalid_flag_value', flag: '--name', value: <raw>,
//       allowed?: [...], message: '...' }
//
//   Convention: validators (validateEnum, validateNonNegativeInt) return
//   null on miss (entry already pushed). Callers MUST check
//   `if (v !== null && v !== undefined)` before assigning, so the field
//   default survives invalid input. `undefined` (missing positional) is
//   passed through unchanged — not treated as an error.
//
// Consumers today: coverage, benchmark, changed, parallel/dispatch.
// ───────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, rmSync,
} from 'node:fs';
import path from 'node:path';
import { shouldInjectConsolePlain } from '../runners/console-mode.js';
// `resolveGradleFile` (prefer .kts, fall back to Groovy .gradle) lives in the
// project layer's pure parser module (a leaf — imports only node:fs/path), so
// reusing it here adds no import cycle. Keeps the .kts/.gradle resolution rule
// in one place instead of drifting a second copy.
import { resolveGradleFile, extractIncludeModuleNames } from '../project/kotlin-dsl.js';

// Strip Kotlin `//` + `/* ... */` comments. Legacy bash matched commented
// `//include(":foo")` lines AND comment text containing plugin-name keywords
// in module build files, both causing phantom discovery / mis-classification.
export function stripKotlinComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Read a module's build.gradle(.kts), comment-stripped. Returns null if the
// file does not exist or is unreadable.
export function readBuildFile(projectRoot, modulePath) {
  const dir = path.join(projectRoot, ...modulePath.split(':'));
  const file = resolveGradleFile(dir, 'build.gradle');
  if (!file) return null;
  try { return stripKotlinComments(readFileSync(file, 'utf8')); } catch { return null; }
}

// Walk settings.gradle(.kts) for `include(":foo")` / `include("foo", "bar")`
// (Kotlin) and `include ':foo'` / `include ':a', ':b'` (Groovy) declarations.
// Returns a deduplicated list of module names without the leading colon
// (`["foo", "core:domain"]`), in first-seen order. Handles single-line and
// multiline parenthesized forms as well as Groovy bare trailing-comma
// continuation. Comments stripped before parsing so commented-out includes
// don't surface as phantom modules.
export function discoverIncludedModules(projectRoot) {
  const settings = resolveGradleFile(projectRoot, 'settings.gradle');
  if (!settings) return [];
  let content;
  try { content = readFileSync(settings, 'utf8'); } catch { return []; }
  return extractIncludeModuleNames(stripKotlinComments(content));
}

// ---------------------------------------------------------------------------
// Child-process output limits
// ---------------------------------------------------------------------------
// Node's spawnSync default maxBuffer is 1 MB; a chatty multi-module gradle
// build exceeds that easily, and exceeding it KILLS the child
// (ERR_CHILD_PROCESS_STDIO_MAXBUFFER) with truncated stdout — the run then
// mis-classifies as a generic module failure. 64 MB covers every output
// observed across the wide-smoke matrix; hosts running very verbose builds
// can raise it with KMP_GRADLE_MAXBUFFER_MB (positive integer, megabytes).
export const DEFAULT_SPAWN_MAX_BUFFER_MB = 64;

// Aggregate cross-module output kept in memory for the discriminator pass.
// Full per-module output is already persisted to per-module log files where
// this cap applies; the in-memory aggregate only feeds line-regex scans.
export const AGGREGATE_OUTPUT_CAP = 4 * 1024 * 1024;

export function resolveMaxBuffer(env = process.env) {
  const raw = env && env.KMP_GRADLE_MAXBUFFER_MB;
  if (raw !== undefined && raw !== null && raw !== '') {
    const mb = Number(raw);
    if (Number.isInteger(mb) && mb > 0) return mb * 1024 * 1024;
    process.stderr.write(
      `[WARN] KMP_GRADLE_MAXBUFFER_MB='${raw}' is not a positive integer — using default ${DEFAULT_SPAWN_MAX_BUFFER_MB} MB\n`
    );
  }
  return DEFAULT_SPAWN_MAX_BUFFER_MB * 1024 * 1024;
}

// Bound an accumulated output string to its LAST maxChars characters (UTF-16
// units — close enough to bytes for ASCII-dominated gradle output). Only for
// aggregate buffers whose full content already lives in per-module log files;
// discriminator signatures cluster near the failure tail, so keeping the tail
// preserves them. A marker line records that truncation happened.
export function tailTruncate(s, maxChars) {
  if (typeof s !== 'string' || s.length <= maxChars) return s;
  const tail = s.slice(s.length - maxChars);
  return `[kmp-test: aggregate output truncated to last ${maxChars} chars]\n${tail}`;
}

// Cross-platform-safe gradle dispatch wrapper.
//
// Background: Node 18.20.2 / 20.12.2 / 22.0.0+ enforce CVE-2024-27980 which
// blocks direct .bat / .cmd execution via spawn — `spawnSync('gradlew.bat',...)`
// on Windows returns `status:null, error:'EINVAL'` without ever invoking gradle.
// The migrated v0.8 orchestrators all hit this; the wide-smoke pass against
// 23 Windows projects (2026-05-03) showed 14/14 false-positive PASS envelopes
// because dispatchLeg's spawn returned EINVAL → empty stdout/stderr →
// classifyTaskResults' regex didn't match → silent fall-through to 'passed'.
//
// Windows transport (H9 fix): cmd.exe expands %VAR% patterns in a pre-parse
// pass that runs before quote-processing, so even a double-quoted arg like
// "%KMP_FILTER%" becomes the value of that env var before the subprocess
// sees it. The fix bypasses cmd.exe entirely on the hot path:
//
//   1. Non-.bat executables (e.g. java.exe, node.exe): Node can spawn
//      .exe files directly without cmd.exe; EINVAL only affects .bat.
//
//   2. gradlew.bat + wrapper JAR present: invoke the JVM directly with
//      `-classpath gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain`
//      and pass gradleArgs as an OS-level argv array. No shell, no %VAR%
//      expansion, no EINVAL.
//
//   3. gradlew.bat + no JAR: fall back to cmd.exe with /v:off (legacy path;
//      %VAR% expansion risk remains but the JAR is always present in real
//      Gradle projects so this branch is defence-in-depth only).
//
// Pass `spawn` as first arg so tests can inject a mock; the helper just
// shapes the cross-platform call before delegating.

// Split a JVM opts string (JAVA_OPTS / GRADLE_OPTS) into individual option
// tokens. Respects double-quoted tokens and strips the surrounding quotes:
//   "-Xmx2g" "-Dsome.prop=value with space" → ['-Xmx2g', '-Dsome.prop=value with space']
//   -Xmx2g -Dhttp.proxyHost=proxy.example.com → ['-Xmx2g', '-Dhttp.proxyHost=proxy.example.com']
// NOTE: DEFAULT_JVM_OPTS embedded in gradlew.bat is not parsed (v1 limitation).
// Most projects set JVM memory via org.gradle.jvmargs in gradle.properties,
// which the Gradle daemon reads independently after launch.
export function splitJvmOpts(str) {
  if (!str || !str.trim()) return [];
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    tokens.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return tokens;
}

// Resolve java[.exe] launcher path: prefer JAVA_HOME from the spawn env.
function _resolveJavaExe(env) {
  const jh = env && env.JAVA_HOME;
  if (jh) return path.join(jh, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

// Locate the Gradle wrapper JAR relative to gradlew.bat. Returns the path
// when the file exists, null otherwise.
function _findWrapperJar(gradlewPath) {
  const jar = path.join(path.dirname(gradlewPath), 'gradle', 'wrapper', 'gradle-wrapper.jar');
  return existsSync(jar) ? jar : null;
}

export function spawnGradle(spawn, gradlewPath, gradleArgs, opts) {
  // Default maxBuffer at the choke point so no call site can silently fall
  // back to Node's 1 MB spawnSync default. Explicit caller values win; the
  // env knob resolves against the spawn env when the caller threads one
  // through (orchestrators do), else the current process env.
  opts = { maxBuffer: resolveMaxBuffer((opts && opts.env) || process.env), ...opts };
  // Defensive `--console=plain` injection when stdout isn't a TTY
  // (or NO_COLOR is set, or --color=never was passed). Idempotent:
  // skip when the caller — or the user via `--gradle-args` — already
  // chose any `--console=*` value, so explicit choices always win.
  if (shouldInjectConsolePlain() && !gradleArgs.some((a) => /^--console(=|$)/.test(a))) {
    gradleArgs = [...gradleArgs, '--console=plain'];
  }
  if (process.platform !== 'win32') {
    return spawn(gradlewPath, gradleArgs, opts);
  }
  // Non-.bat: spawn directly — no cmd.exe needed, no EINVAL risk for .exe.
  if (!gradlewPath.toLowerCase().endsWith('.bat')) {
    return spawn(gradlewPath, gradleArgs, opts);
  }
  // .bat + JAR present: bypass cmd.exe, invoke the JVM directly.
  const wrapperJar = _findWrapperJar(gradlewPath);
  if (wrapperJar) {
    const spawnEnv = (opts && opts.env) || process.env;
    const javaExe = _resolveJavaExe(spawnEnv);
    const jvmOpts = [
      ...splitJvmOpts(spawnEnv.JAVA_OPTS || ''),
      ...splitJvmOpts(spawnEnv.GRADLE_OPTS || ''),
    ];
    return spawn(javaExe, [
      ...jvmOpts,
      '-classpath', wrapperJar,
      '-Dorg.gradle.appname=gradlew',
      'org.gradle.wrapper.GradleWrapperMain',
      ...gradleArgs,
    ], opts);
  }
  // .bat + no JAR: fall back to cmd.exe (legacy path; JAR absent means
  // non-standard Gradle project layout). /v:off prevents !VAR! expansion.
  const quote = (s) => {
    s = String(s);
    if (s !== '' && !/[\s"&|<>()^%!]/.test(s)) return s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const quotedPath = `"${gradlewPath.replace(/"/g, '""')}"`;
  const cmdLine = `"${[quotedPath, ...gradleArgs.map(quote)].join(' ')}"`;
  const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  return spawn(comspec, ['/d', '/v:off', '/s', '/c', cmdLine], { ...opts, windowsVerbatimArguments: true });
}

// Read the package name declared in a module's AndroidManifest.xml (best-effort).
// Walks `src/main/AndroidManifest.xml` then `src/androidMain/AndroidManifest.xml`
// and returns the first `package="..."` value found, or null when not present.
// Used by `--clear-data` (android + parallel orchestrators) to invoke
// `adb shell pm clear <pkg>` between retry attempts.
//
// Originally lived in lib/android-orchestrator.js#readPackageName (v0.8 PIVOT);
// hoisted to shared util when the parallel `--clear-data` parity flag
// landed (BACKLOG L339, "kmp-test parallel --test-type androidInstrumented
// parity gap").
export function readPackageName(projectRoot, moduleName) {
  const rel = moduleName.replace(/:/g, path.sep);
  const candidates = [
    path.join(projectRoot, rel, 'src', 'main', 'AndroidManifest.xml'),
    path.join(projectRoot, rel, 'src', 'androidMain', 'AndroidManifest.xml'),
  ];
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    try {
      const content = readFileSync(f, 'utf8');
      const m = content.match(/package\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    } catch { /* fall through */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Concurrency Tier 3 — `--isolated` cache-dir lifecycle
// ---------------------------------------------------------------------------
//
// `--isolated` injects `--project-cache-dir <dir>` into every gradle spawn so
// concurrent kmp-test runs against the same project don't clobber each other's
// per-project `.gradle/` (configuration cache + build outputs). Tier 1's
// advisory lock still serializes by default; pair `--isolated` with
// `--isolated-no-lock` for true parallel multi-agent fan-out.
//
// What `--project-cache-dir` does NOT isolate (and we accept):
//   * `~/.gradle/caches/modules-2`   — dependency cache; Gradle locks per-file
//   * `~/.gradle/daemon`             — daemon registry; Gradle handles reuse
//   * `~/.gradle/wrapper/dists`      — wrapper distributions
// All three are read-mostly and Gradle-managed, so concurrent reads are safe.
//
// Default cache dir: `<projectRoot>/.kmp-test-runner/cache-isolated/<runId>`
// where `runId = `${Date.now()}-${process.pid}``. The `.kmp-test-runner/`
// umbrella is already gitignored.
//
// User-supplied dir (--isolated-cache-dir <path>) is treated as user-owned:
// we mkdir-p it but never rm it on exit. KMP_TEST_KEEP_ISOLATED=1 likewise
// preserves auto-generated dirs for debugging.

// Strip --isolated / --isolated-cache-dir <val> / --isolated-no-lock from args
// and return the parsed state. `enabled` flips on with either bare --isolated
// or --isolated-cache-dir (the latter implies isolation). `cacheDir` is the
// raw user value (resolveIsolatedDir normalizes to absolute). `noLock` is the
// Tier 1 lock-skip flag — consumed by lib/cli.js but also stripped here so
// orchestrators emitting envelopes can mirror its state. `errors` carries
// `invalid_flag_value` entries for a dangling / empty `--isolated-cache-dir`;
// callers gate on it BEFORE any gradle work (same contract as the parseArgs
// validators below).
export function parseIsolatedArgs(args) {
  const out = [];
  let enabled = false;
  let cacheDir = null;
  let noLock = false;
  const errors = [];
  // Normalize `--isolated-cache-dir=<path>` BEFORE the walk. cli.js routes
  // pre-expand the whole argv at dispatch, but direct `node lib/runner.js
  // <sub>` invocations reach here raw — without this the equals form falls
  // through to `out` unparsed and isolation silently no-ops. Idempotent for
  // already-expanded argv.
  const expanded = expandPosixEqualsForm(args);
  for (let i = 0; i < expanded.length; i++) {
    const a = expanded[i];
    if (a === '--isolated') { enabled = true; continue; }
    // `--isolated-no-lock` implies `--isolated` so the
    // user's intent (skip the Tier 1 advisory lock for parallel multi-agent
    // fan-out) actually engages isolation. Mirrors the cli.js#peekIsolatedFlags
    // fix and the existing `--isolated-cache-dir` branch below.
    if (a === '--isolated-no-lock') { noLock = true; enabled = true; continue; }
    if (a === '--isolated-cache-dir') {
      const v = expanded[i + 1];
      if (v === undefined || v === '') {
        // Dangling (last token) or explicit-empty (`--isolated-cache-dir=`).
        // Consume WITHOUT enabling isolation and surface a CONFIG_ERROR via
        // errors[]: pre-fix this silently ran non-isolated while the lock
        // path believed isolation was on, and the dangling token leaked into
        // orchestrator args.
        errors.push({
          code: 'invalid_flag_value',
          flag: '--isolated-cache-dir',
          value: v ?? null,
          message: '--isolated-cache-dir: missing required <path> value',
        });
        if (v !== undefined) i++;
        continue;
      }
      cacheDir = v;
      enabled = true;
      i++;
      continue;
    }
    out.push(a);
  }
  return { args: out, enabled, cacheDir, noLock, errors };
}

// Assess whether an `--isolated` + test-type (+ device) combination races on a
// shared runtime resource that isolation cannot protect (the host-wide iOS
// simulator, or a single ADB device). Pure: returns a structured rejection
// descriptor or null. SINGLE SOURCE OF TRUTH shared by the parallel orchestrator
// (real runs, in runParallel) and the dispatcher's `--dry-run` short-circuit, so
// `--dry-run` surfaces the SAME `isolated_runtime_race` rejection a real run
// enforces. Without this parity, an agent validating `--isolated --test-type ios
// --dry-run` gets exit 0 + a plan, then hits CONFIG_ERROR on the real run — yet
// the whole point of the check is to teach the limitation BEFORE paying the
// gradle cost, and --dry-run is the canonical cheap-discovery path.
//
// Reject (isolation does not protect a shared runtime resource):
//   - --test-type ios   — only one simulator boots per host
//   - --test-type all    — expands to include the ios leg
//   - --test-type androidInstrumented WITHOUT --device — all processes race the
//     same default ADB device / app-install state
// Allow: jvm / desktop / macos (Konan host-native) / common / androidUnit, and
// androidInstrumented WITH --device (caller targets a distinct device per proc).
//
// @param {{enabled:boolean, testType:string, hasDevice:boolean}} a
// @returns {{code:'isolated_runtime_race', message:string, test_type:string}|null}
export function assessIsolatedRuntimeRace({ enabled, testType, hasDevice } = {}) {
  if (!enabled) return null;
  const ttype = testType || '';
  let message = null;
  if (ttype === 'ios') {
    message = '--isolated does not protect against iOS simulator races (shared host-wide). '
      + 'Run sequentially without --isolated, or split iOS runs across separate hosts.';
  } else if (ttype === 'all') {
    message = '--isolated --test-type all is unsafe: the iOS leg races on the simulator. '
      + 'Use --isolated with a single safe test-type (jvm/desktop/macos/androidUnit/common), '
      + 'or run --test-type all sequentially without --isolated.';
  } else if (ttype === 'androidInstrumented' && !hasDevice) {
    message = '--isolated --test-type androidInstrumented requires --device <serial> to '
      + 'target distinct devices per concurrent process. Without --device, all processes target '
      + 'the same default device and race on ADB / app-install state.';
  }
  if (!message) return null;
  return { code: 'isolated_runtime_race', message, test_type: ttype };
}

// Resolve the cache-dir to use. Returns null when isolation is disabled.
// When user-supplied: resolve to absolute (relative resolves against
// projectRoot) and mkdir-p. When auto-generated: place under
// <projectRoot>/.kmp-test-runner/cache-isolated/<runId>. dryRun:true skips the
// mkdir so dry-run paths can surface the would-be path without creating it.
export function resolveIsolatedDir(projectRoot, { enabled, cacheDir, dryRun = false } = {}) {
  if (!enabled) return null;
  let abs;
  if (cacheDir) {
    abs = path.isAbsolute(cacheDir) ? cacheDir : path.resolve(projectRoot, cacheDir);
  } else {
    const runId = `${Date.now()}-${process.pid}`;
    abs = path.join(projectRoot, '.kmp-test-runner', 'cache-isolated', runId);
  }
  if (!dryRun) {
    try { mkdirSync(abs, { recursive: true }); } catch { /* best-effort */ }
  }
  return abs;
}

// Append `--project-cache-dir <dir>` to a gradle args array. No-op when dir
// is null/empty (so callers can unconditionally pipe through this helper).
// Returns a NEW array — never mutates input.
export function injectProjectCacheDir(gradleArgs, dir) {
  if (!dir) return gradleArgs;
  return [...gradleArgs, '--project-cache-dir', dir];
}

// ---------------------------------------------------------------------------
// JaCoCo XML auto-fix init-script
// ---------------------------------------------------------------------------
// Gradle's built-in `jacocoTestReport` leaves `xml.required = false` by
// default, so a module that applies the standard `jacoco` plugin emits only an
// HTML report — and the coverage aggregator (which parses XML) buckets it
// `no_xml` even though its tests ran. We transparently force XML on every
// JacocoReport task via an injected init-script so coverage "just works"
// without the project changing its build, consistent with the gradle flags the
// runner already injects (--console=plain / --parallel / --project-cache-dir).
// It is a genuine no-op for Kover (its report tasks are not JacocoReport
// subtypes) and for projects that already enable XML. Opt out with
// `--no-coverage-xml-autofix`.
//
// FQN `org.gradle.testing.jacoco.tasks.JacocoReport` is always on the
// init-script classpath (jacoco is a bundled core Gradle plugin); `configureEach`
// keeps configuration lazy + configuration-cache friendly. Groovy
// `xml.required = true` is the correct assignment to the Property<Boolean> on
// Gradle 7/8/9 (the `.set()`-vs-`=` change was Kotlin-DSL-only).
const COVERAGE_XML_INIT_SCRIPT = `// Generated by kmp-test-runner: forces jacoco XML reports on so coverage can be
// parsed. Safe to delete. Disable with --no-coverage-xml-autofix.
allprojects {
    tasks.withType(org.gradle.testing.jacoco.tasks.JacocoReport).configureEach {
        reports {
            xml.required = true
        }
    }
}
`;

// Write the coverage-XML init-script under <projectRoot>/.kmp-test-runner/
// init-scripts/ and return its absolute path, or null on write failure (the
// caller proceeds without the autofix). The `.kmp-test-runner/` umbrella is
// already gitignored. The filename is process-unique so concurrent runs don't
// collide; the caller is expected to clean it up after the gradle leg.
export function writeCoverageXmlInitScript(projectRoot) {
  try {
    const scriptDir = path.join(projectRoot, '.kmp-test-runner', 'init-scripts');
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, `coverage-xml-${Date.now()}-${process.pid}.init.gradle`);
    writeFileSync(scriptPath, COVERAGE_XML_INIT_SCRIPT, 'utf8');
    return scriptPath;
  } catch {
    return null;
  }
}

// Append `--init-script <path>` to a gradle args array. No-op when path is
// null/empty. Returns a NEW array — never mutates input. Mirrors
// injectProjectCacheDir.
export function injectInitScript(gradleArgs, scriptPath) {
  if (!scriptPath) return gradleArgs;
  return [...gradleArgs, '--init-script', scriptPath];
}

// Best-effort removal of a generated init-script. Honors
// KMP_TEST_KEEP_INIT_SCRIPT=1 (debug aid). Never throws — an orphan file under
// the gitignored .kmp-test-runner/ tree is non-fatal.
export function cleanupInitScript(scriptPath, { env = process.env } = {}) {
  if (!scriptPath) return false;
  if (String(env.KMP_TEST_KEEP_INIT_SCRIPT || '') === '1') return false;
  try {
    rmSync(scriptPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

// Decide whether to inject the jacoco-XML autofix init-script for a coverage
// dispatch. Inject only when ALL hold:
//   - the autofix isn't opted out (--no-coverage-xml-autofix),
//   - the user didn't already supply their own --init-script / -I via
//     --gradle-args (their script wins — least surprise),
//   - at least one dispatched task is a jacoco report task (skip for pure-Kover
//     runs; the init-script would be a no-op there anyway).
export function shouldAutofixCoverageXml(taskList, opts = {}) {
  if (opts.noCoverageXmlAutofix) return false;
  const userArgs = Array.isArray(opts.gradleArgs) ? opts.gradleArgs : [];
  if (userArgs.some((a) => a === '--init-script' || a === '-I'
      || /^--init-script=/.test(a))) {
    return false;
  }
  const tasks = Array.isArray(taskList) ? taskList : [];
  return tasks.some((t) => {
    const s = String(t);
    const bare = s.slice(s.lastIndexOf(':') + 1);
    return coverageToolFromTask(bare) === 'jacoco';
  });
}

// ---------------------------------------------------------------------------
// Coverage classification (probe-backed, application-method-agnostic)
// ---------------------------------------------------------------------------
// Map a resolved gradle coverage-report task name back to its tool. The
// project model's `resolved.coverageTask` is derived from the `gradlew tasks
// --all` probe (project-model.js#parseGradleTasksOutput), so it reflects the
// REAL task graph regardless of HOW coverage was applied — per-module,
// build-logic convention, OR a root `subprojects {}` / `allprojects {}` block.
export function coverageToolFromTask(task) {
  if (!task || typeof task !== 'string') return null;
  if (task === 'jacocoTestReport') return 'jacoco';
  // AGP's per-variant unit-test coverage report (created when
  // `enableUnitTestCoverage = true`): create${Variant}UnitTestCoverageReport,
  // e.g. createDemoDebugUnitTestCoverageReport — jacoco-format XML. This is how
  // flavored Android projects (convention-applied flavors) expose unit coverage.
  if (/UnitTestCoverageReport$/.test(task)) return 'jacoco';
  if (/^koverXmlReport/.test(task)) return 'kover';
  return null;
}

// The coverage tool a module effectively uses. Static detection
// (analyzeModule's `coveragePlugin` regex over the module's own build.gradle.kts
// + build-logic/) wins when present; otherwise fall back to the probe-derived
// `resolved.coverageTask`. This closes the root-convention gap: a module with a
// root `subprojects { apply(plugin = "jacoco") }` application has
// `coveragePlugin: null` statically but `resolved.coverageTask:
// 'jacocoTestReport'` from the probe. Optional chaining is REQUIRED — some
// unit-test stubs pass a bare `{coveragePlugin, type}` with no `resolved` key.
export function effectiveCoveragePlugin(entry) {
  if (!entry) return null;
  if (entry.coveragePlugin) return entry.coveragePlugin;
  const fromTask = coverageToolFromTask(entry.resolved?.coverageTask);
  if (fromTask) return fromTask;
  // Flavored Android coverage applied by convention: the only probe signal is
  // the per-variant report tasks (create${Variant}UnitTestCoverageReport,
  // jacoco-format), which the single `coverageTask` candidate chain doesn't
  // capture. Classify off the first one so a convention-jacoco + flavors module
  // (static coveragePlugin=null, no jacocoTestReport task) still reports jacoco.
  const reportTasks = entry.resolved?.coverageReportTasks;
  if (Array.isArray(reportTasks) && reportTasks.length > 0) {
    return coverageToolFromTask(reportTasks[0]);
  }
  return null;
}

// The product-flavor names a module effectively declares. Static `hasFlavor`
// is a bare boolean that misses convention-applied flavors; resolved.flavors
// (from flavorsFromTasks over the probe) carries the recovered NAMES. Optional
// chaining is REQUIRED — bare unit-test stubs have no `resolved` key. Always an
// array, so callers can `.length` / `.sort()` without guarding.
export function effectiveFlavors(entry) {
  return Array.isArray(entry?.resolved?.flavors) ? entry.resolved.flavors : [];
}

// Whether a module is flavored by EITHER signal: the static `hasFlavor` regex
// OR probe-recovered flavor names. Closes the convention-flavor gap exactly as
// effectiveCoveragePlugin closes the root-convention coverage gap — static wins
// when present, the probe is the fallback that catches build-logic application.
export function effectiveHasFlavor(entry) {
  return !!entry?.hasFlavor || effectiveFlavors(entry).length > 0;
}

// Should we leave the isolated cache dir on disk after the run?
//   * userSupplied:true    → yes (user owns the lifecycle)
//   * KMP_TEST_KEEP_ISOLATED=1 → yes (debug aid)
//   * otherwise            → no (clean up)
export function shouldKeepIsolated({ userSupplied = false, env = process.env } = {}) {
  if (userSupplied) return true;
  return String(env.KMP_TEST_KEEP_ISOLATED || '') === '1';
}

// Best-effort cleanup of an auto-generated isolated cache dir. Returns true
// on actual rm, false when policy says keep or dir is null. Never throws —
// rm errors are swallowed (orphan dirs are non-fatal).
export function cleanupIsolatedDir(dir, { userSupplied = false, env = process.env } = {}) {
  if (!dir) return false;
  if (shouldKeepIsolated({ userSupplied, env })) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Module-filter helpers (unified normalization for glob + comma-CSV)
// ---------------------------------------------------------------------------
// Pre-fix, each orchestrator implemented its own filter shape:
//   - parallel:  glob with comma-CSV + dual-test (bare + `:`-prefixed name)
//   - changed:   inherits parallel
//   - coverage:  inherits parallel
//   - android:   `m.name.includes(filter)` substring on stripped name
//   - benchmark: `name.includes(filter)` substring on colon-preserved name
//   - describe:  `new RegExp(filter).test(m.name)` on colon-preserved name
//
// Result: `kmp-test android --module-filter ":benchmark"` returned 0 modules
// (because `"benchmark".includes(":benchmark")` is false), while the same
// filter shape worked on parallel/describe. This helper lifts parallel's
// glob+CSV+dual-test semantics into one place and is wired into android +
// benchmark + parallel orchestrators. Describe keeps its regex semantic for
// power-user use cases but adds the colon-stripped dual-test fallback.

// Split a comma-separated value into trimmed, non-empty segments.
export function splitCsv(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}

// Compile a glob pattern (with `*` and `?` wildcards) into a regex anchored
// at both ends. Mirrors the bash wrapper's `case` glob shape.
export function globToRegex(pattern) {
  let re = '^';
  for (const ch of pattern) {
    if (ch === '*')      re += '.*';
    else if (ch === '?') re += '.';
    else if (/[\\^$+.()|[\]{}]/.test(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp(re + '$');
}

// True iff `name` matches any pattern in the comma-separated CSV.
// Pattern semantics (per-pattern, not per-CSV):
//   - **No glob metacharacters** (`*` / `?`): substring match. `feature`
//     matches `feature-auth` AND `:feature:auth`. Mirrors the historical
//     android / benchmark filter contract — typing a bare term does not
//     anchor to exact match.
//   - **Glob metacharacters present**: anchored glob match. `feature-*`
//     matches `feature-auth` but not `core-feature-auth`. Mirrors the
//     historical parallel filter contract.
// In both modes we try the bare name AND the `:`-prefixed variant since
// project module names can be either form depending on settings.gradle.kts
// shape and the orchestrator's discovery normalization. Empty filter or
// `'*'` matches all.
export function matchModuleFilter(name, filterCsv) {
  if (!filterCsv || filterCsv === '*') return true;
  const patterns = splitCsv(filterCsv);
  if (patterns.length === 0) return true;
  const bareName = name.replace(/^:/, '');
  const colonName = bareName.startsWith(':') ? bareName : ':' + bareName;
  const short = bareName.split(':').pop();
  for (const pat of patterns) {
    const isGlob = /[*?]/.test(pat);
    if (isGlob) {
      const re = globToRegex(pat);
      if (re.test(name)) return true;
      if (re.test(bareName)) return true;
      if (re.test(colonName)) return true;
      if (short !== bareName && re.test(short)) return true;
    } else {
      // Substring contract — preserves historical android / benchmark behavior.
      if (name.includes(pat)) return true;
      if (bareName.includes(pat)) return true;
      if (colonName.includes(pat)) return true;
    }
  }
  return false;
}

// Compose the `isolated:` envelope field. enabled:false collapses to a stable
// no-op shape so downstream consumers can read parsed.isolated unconditionally.
export function buildIsolatedField({
  enabled = false,
  cacheDir = null,
  kept = false,
  locked = true,
} = {}) {
  return {
    enabled: !!enabled,
    cache_dir: cacheDir || null,
    kept: !!kept,
    locked: !!locked,
  };
}

// ---------------------------------------------------------------------------
// POSIX `--flag=value` argv normalization
// ---------------------------------------------------------------------------
//
// All orchestrator parseArgs functions match the FULL token in their switch /
// if-else chains, so `--module-filter=:foo` falls through as "unknown flag"
// and the value is dropped silently. Pre-PR-#167 only `expandNoCoverageAlias`
// (parallel + coverage) split POSIX-style `=` form; android / benchmark /
// changed / describe orchestrators didn't. Lifted here so all five+coverage
// can normalize argv through one shared helper before the parser walk.
//
// Restricted to tokens that begin with `--<name>=` (eq > 2 guard rejects
// `--=foo`; `startsWith('--')` rejects positionals; whitespace check rejects
// space-form values like `--gradle-args "--no-parallel -Pa=b"` where `=` is
// part of a gradle property). First `=` only — multi-`=` in value preserved.
export function expandPosixEqualsForm(args) {
  const out = [];
  for (const a of args) {
    if (typeof a !== 'string') { out.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 2 && a.startsWith('--') && !a.slice(0, eq).includes(' ')) {
      out.push(a.slice(0, eq), a.slice(eq + 1));
    } else {
      out.push(a);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------
//
// Pre-fix, every orchestrator's parser silently accepted invalid values for
// enum and numeric flags:
//   --test-type bogus       → out.testType = 'bogus' (no error, gradle dispatch
//                             fails later with a confusing "task not found")
//   --coverage-tool bogus   → fell back to 'auto' silently
//   --max-workers abc       → +'abc' → NaN → coerced to 0 (auto)
//   --timeout -1            → accepted as a negative timeout
// These helpers push a discriminated `invalid_flag_value` error into the
// caller-provided errors[] array. Caller (each orchestrator's runX) inspects
// `opts.errors` and emits an `EXIT.CONFIG_ERROR (2)` envelope BEFORE any
// gradle work. Single error code (`invalid_flag_value`) for both enum + numeric
// failures keeps the agent-facing contract minimal — payload carries `flag`,
// `value`, and `allowed[]` for enum case (omitted for numeric).

// Require a value token for a value-bearing flag. A dangling flag (last
// token, `value === undefined`) pushes an `invalid_flag_value` error and
// returns null; otherwise returns the value verbatim — including `''`, so
// each flag's legacy falsy fallback (`requireFlagValue(...) || '<default>'`)
// keeps its pre-fix explicit-empty behavior. Pre-fix every parser silently
// treated a dangling flag as if it had been omitted (`argv[++i] || ''`),
// hiding the user's mistake until gradle/adb failed confusingly later
// (`--isolated-cache-dir` was the audit's L1 instance; this helper
// normalizes the whole bug-class).
export function requireFlagValue(flag, value, errors, { opaque = false } = {}) {
  if (value === undefined) {
    errors.push({
      code: 'invalid_flag_value',
      flag,
      value: null,
      message: `${flag}: missing required value`,
    });
    return null;
  }
  if (!opaque && typeof value === 'string' && value.startsWith('--')) {
    errors.push({
      code: 'invalid_flag_value',
      flag,
      value,
      message: `${flag}: expected a value but got flag '${value}' — forgot the value?`,
    });
    return null;
  }
  return value;
}

// Validate that `value` belongs to `allowed`. On miss: push an
// `invalid_flag_value` error and return null (caller falls back to default).
// `value === undefined` (dangling flag) is ALSO invalid — pre-fix it was
// treated as "missing, not invalid", which silently swallowed e.g. a
// trailing `--test-type` with no value. Empty string IS invalid for enums
// (callers should default-init before calling).
export function validateEnum(flag, value, allowed, errors) {
  if (value === undefined) return requireFlagValue(flag, value, errors);
  if (allowed.includes(value)) return value;
  errors.push({
    code: 'invalid_flag_value',
    flag,
    value,
    allowed: [...allowed],
    message: `${flag}: invalid value '${value}' — expected one of [${allowed.join(', ')}]`,
  });
  return null;
}

// Validate that `value` parses to a non-negative finite integer. On miss:
// push an `invalid_flag_value` error and return null. `value === undefined`
// (dangling flag) is ALSO invalid per the enum contract above.
export function validateNonNegativeInt(flag, value, errors) {
  if (value === undefined) return requireFlagValue(flag, value, errors);
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0 && Math.floor(n) === n) return n;
  errors.push({
    code: 'invalid_flag_value',
    flag,
    value,
    message: `${flag}: invalid value '${value}' — expected a non-negative integer`,
  });
  return null;
}

// Whitespace-split a `--gradle-args` value into individual tokens. Empty
// segments are dropped. Used by android / benchmark / changed / parallel
// orchestrators when accumulating tokens to forward to gradle. Quoted values
// with embedded spaces (`-Pmessage="hello world"`) are NOT supported;
// workaround is to pass --gradle-args multiple times.
//
// Pre-Phase-3 Option B (2026-05-11), the 4-line whitespace-split lived inline
// in every orchestrator's `--gradle-args` switch case. Centralized so a
// future quoting upgrade only changes one place.
export function splitGradleArgs(raw) {
  if (!raw) return [];
  return String(raw).split(/\s+/).filter(Boolean);
}

// `--no-coverage` is sugar for `--coverage-tool none`. Expansion runs BEFORE
// expandPosixEqualsForm so `--no-coverage=foo` (typo — `--no-coverage` is
// boolean) still emits `[--no-coverage, foo]` rather than re-aliasing.
//
// Used by coverage + parallel/dispatch orchestrators. Distinct from
// `lib/parsers/argv.js#expandNoCoverageAlias` which has different semantics
// (drops the flag at CLI level with last-wins behavior when `--coverage-tool`
// is already explicit). Do NOT unify — the two contracts must stay separate.
//
// Centralized by Phase 3 Option B (2026-05-11).
export function expandNoCoverageAlias(argv) {
  const aliased = [];
  for (const a of argv) {
    if (a === '--no-coverage') {
      aliased.push('--coverage-tool', 'none');
      continue;
    }
    aliased.push(a);
  }
  return expandPosixEqualsForm(aliased);
}

// adb device probe — port of scripts/sh/lib/benchmark-detect.sh:36-80.
// Returns array of { serial, type, model }; empty when no devices or no adb.
// Shared across benchmark + android orchestrators (sub-entries 1 + 3).
export function defaultAdbProbe() {
  const result = spawnSync('adb', ['devices', '-l'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return [];
  const out = [];
  for (const line of (result.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('List of devices')) continue;
    if (!line.trim()) continue;
    const serial = line.split(/\s+/)[0];
    if (!serial) continue;
    const type = serial.startsWith('emulator-') ? 'emulator' : 'physical';
    const modelMatch = line.match(/model:(\S+)/);
    out.push({ serial, type, model: modelMatch ? modelMatch[1] : 'unknown' });
  }
  return out;
}

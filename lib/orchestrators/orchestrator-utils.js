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

// Strip Kotlin `//` + `/* ... */` comments. Legacy bash matched commented
// `//include(":foo")` lines AND comment text containing plugin-name keywords
// in module build files, both causing phantom discovery / mis-classification.
export function stripKotlinComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Read a module's build.gradle.kts, comment-stripped. Returns null if the
// file does not exist or is unreadable.
export function readBuildFile(projectRoot, modulePath) {
  const dir = path.join(projectRoot, ...modulePath.split(':'));
  const file = path.join(dir, 'build.gradle.kts');
  if (!existsSync(file)) return null;
  try { return stripKotlinComments(readFileSync(file, 'utf8')); } catch { return null; }
}

// Walk settings.gradle.kts for `include(":foo")` and `include("foo", "bar")`
// declarations. Returns a deduplicated list of module names without the
// leading colon (`["foo", "core:domain"]`). Comments stripped before parsing
// so commented-out includes don't surface as phantom modules.
export function discoverIncludedModules(projectRoot) {
  const settings = path.join(projectRoot, 'settings.gradle.kts');
  if (!existsSync(settings)) return [];
  let content;
  try { content = readFileSync(settings, 'utf8'); } catch { return []; }
  content = stripKotlinComments(content);
  const out = [];
  // The single-arg regex matches the first `":name"` of any include — including
  // the first arg of multi-arg forms. Dedupe here so the multi-form pass below
  // never sees duplicates; mirrors that pass's own `!out.includes` guard so the
  // docstring "deduplicated list" contract holds end-to-end.
  const re = /include\s*\(\s*"(:[\w\-:]+)"/g;
  for (const m of content.matchAll(re)) {
    const name = m[1].replace(/^:/, '');
    if (!out.includes(name)) out.push(name);
  }
  const multi = /include\s*\(\s*((?:"[^"]+"\s*,?\s*)+)\)/g;
  for (const m of content.matchAll(multi)) {
    for (const sub of m[1].matchAll(/"(:[\w\-:]+)"/g)) {
      const name = sub[1].replace(/^:/, '');
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
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
// Fix: route through cmd.exe explicitly on Windows. Avoids both the EINVAL
// error AND the DEP0190 deprecation warning that `shell:true` triggers in
// Node 22+. Args are quoted for cmd.exe per the standard rules: any arg
// containing whitespace or shell-meta gets wrapped in `"..."` with internal
// `"` doubled. Module names + task names from Gradle never contain meta
// chars; the only user-supplied arg in our surface is `--tests "<filter>"`,
// which goes through the same quoter.
//
// Pass `spawn` as first arg so tests can inject a mock; the helper just
// shapes the cross-platform call before delegating.
export function spawnGradle(spawn, gradlewPath, gradleArgs, opts) {
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
  const quote = (s) => {
    s = String(s);
    if (s !== '' && !/[\s"&|<>()^%!]/.test(s)) return s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  // cmd.exe /s /c quote-stripping rule (see `cmd.exe /?`): with /s, exactly
  // one leading and one trailing quote are stripped from the command line
  // before parsing. To make this round-trip safely we (a) ALWAYS inline-quote
  // the gradlew path (so the post-strip line still has the path quoted and
  // cmd.exe parses it as one token even if it contains whitespace), and
  // (b) wrap the whole command line in one outer pair of quotes (consumed by
  // the strip). After strip, cmd.exe sees: `"<gradlewPath>" arg1 arg2 ...`
  // which is the canonical shape. Args that contain whitespace are also
  // inline-quoted by quote() above; simple args pass through unquoted.
  const quotedPath = `"${gradlewPath.replace(/"/g, '""')}"`;
  const cmdLine = `"${[quotedPath, ...gradleArgs.map(quote)].join(' ')}"`;
  const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  // windowsVerbatimArguments: Node otherwise re-quotes any arg containing
  // whitespace, which mangles our carefully-crafted cmdLine. With verbatim
  // mode Node passes args[3] to cmd.exe exactly as we built it.
  return spawn(comspec, ['/d', '/s', '/c', cmdLine], { ...opts, windowsVerbatimArguments: true });
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
// orchestrators emitting envelopes can mirror its state.
export function parseIsolatedArgs(args) {
  const out = [];
  let enabled = false;
  let cacheDir = null;
  let noLock = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--isolated') { enabled = true; continue; }
    // `--isolated-no-lock` implies `--isolated` so the
    // user's intent (skip the Tier 1 advisory lock for parallel multi-agent
    // fan-out) actually engages isolation. Mirrors the cli.js#peekIsolatedFlags
    // fix and the existing `--isolated-cache-dir` branch below.
    if (a === '--isolated-no-lock') { noLock = true; enabled = true; continue; }
    if (a === '--isolated-cache-dir' && i + 1 < args.length) {
      cacheDir = args[i + 1];
      enabled = true;
      i++;
      continue;
    }
    out.push(a);
  }
  return { args: out, enabled, cacheDir, noLock };
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

// Validate that `value` belongs to `allowed`. On miss: push an
// `invalid_flag_value` error and return null (caller falls back to default).
// `value === undefined` is treated as missing (not invalid) so positional
// callers passing `[--flag, undefined]` don't double-error. Empty string IS
// invalid for enums (callers should default-init before calling).
export function validateEnum(flag, value, allowed, errors) {
  if (value === undefined) return value;
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
// is treated as missing (not invalid) per the enum contract above.
export function validateNonNegativeInt(flag, value, errors) {
  if (value === undefined) return value;
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

// SPDX-License-Identifier: MIT
// lib/project-model.js — canonical project introspector (v0.5.1 Phase 4).
//
// Builds a single ProjectModel JSON file at:
//   <projectRoot>/.kmp-test-runner-cache/model-<sha1>.json
//
// The model is the source of truth for: JDK requirement, module discovery,
// per-module type/DSL/sourceSets/coveragePlugin, gradle-tasks list, and the
// resolved canonical task names (unitTestTask, deviceTestTask, coverageTask).
// Sh and ps1 readers parse this JSON when present and fall through to legacy
// detection when absent (model is additive — never blocking).
//
// Design notes:
// - Cache key matches scripts/sh/lib/gradle-tasks-probe.sh:_kmp_compute_cache_key
//   so the model + probe cache invalidate on the same content changes.
// - JDK signal walker preserves lib/cli.js#findRequiredJdkVersion exclusion
//   list and depth=12 cap (the existing 7 vitest cases must keep passing
//   when findRequiredJdkVersion delegates here in Phase 4 step 3).
// - All file IO is sync. Atomic writes use a tmp + rename pattern so concurrent
//   runs don't see a half-written model.

import { spawnSync } from 'node:child_process';
import {
  readFileSync, readdirSync, existsSync, mkdirSync,
  openSync, closeSync, writeSync, renameSync, unlinkSync,
} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SCHEMA_VERSION = 1;
const CACHE_DIR_NAME = '.kmp-test-runner-cache';
const MAX_BUILD_FILE_DEPTH = 4;
const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

// Same exclusion list + depth cap as findRequiredJdkVersion in lib/cli.js.
// Don't drift this without updating the corresponding wrapper test in step 3.
const JDK_WALK_EXCLUDE = new Set([
  'build', '.gradle', 'node_modules', '.git', '.idea',
  'dist', 'out', 'target', '.vscode',
]);
const JDK_WALK_MAX_DEPTH = 12;

const JDK_PATTERNS = [
  { type: 'jvmToolchain', re: /jvmToolchain\s*\(\s*(\d+)\s*\)/g },
  { type: 'JvmTarget',    re: /JvmTarget\.JVM_(\d+)\b/g },
  { type: 'JavaVersion',  re: /JavaVersion\.VERSION_(\d+)\b/g },
];

// Match scripts/sh/lib/gradle-tasks-probe.sh:_kmp_compute_cache_key:
// concat(settings.gradle.kts + gradle.properties + every build.gradle.kts at
// depth ≤ 4 excluding build/ and .gradle/, sorted lexicographically), normalize
// CRLF/LF differences, SHA1 the result.
//
// Cross-platform parity (v0.5.2 Gap C): JS, bash, and PS1 walkers now produce
// IDENTICAL SHAs across LF / CRLF / multiple-trailing-newline fixtures AND
// across Linux/macOS/Windows runners. Strategy: strip all `\r` first, then
// strip trailing `\n+`. This makes the hash invariant under git's autocrlf /
// VCS line-ending normalization — a project authored on Windows (CRLF) and
// pulled on Linux (LF) hashes to the same value. Sibling walkers in
// scripts/sh/lib/gradle-tasks-probe.sh (`tr -d '\r'` before `$(cat)`) and
// scripts/ps1/lib/Gradle-Tasks-Probe.ps1 (`-replace '\r', ''` then
// `-replace '\n+$', ''`) implement the same normalization byte-for-byte.
function normalizeForHash(s) {
  return s.replace(/\r/g, '').replace(/\n+$/, '');
}

function collectBuildFiles(projectRoot) {
  const out = [];
  function walk(dir, childDepth) {
    if (childDepth > MAX_BUILD_FILE_DEPTH) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile() && e.name === 'build.gradle.kts') {
        out.push(path.join(dir, e.name));
      }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'build' || e.name === '.gradle') continue;
      walk(path.join(dir, e.name), childDepth + 1);
    }
  }
  walk(projectRoot, 1);
  out.sort();
  return out;
}

export function computeCacheKey(projectRoot) {
  let concat = '';
  const settings = path.join(projectRoot, 'settings.gradle.kts');
  if (existsSync(settings)) {
    try { concat += normalizeForHash(readFileSync(settings, 'utf8')); } catch { /* skip */ }
  }
  const props = path.join(projectRoot, 'gradle.properties');
  if (existsSync(props)) {
    try { concat += normalizeForHash(readFileSync(props, 'utf8')); } catch { /* skip */ }
  }
  for (const f of collectBuildFiles(projectRoot)) {
    try { concat += normalizeForHash(readFileSync(f, 'utf8')); } catch { /* skip */ }
  }
  return crypto.createHash('sha1').update(concat).digest('hex');
}

// Aggregate JDK requirement signals across the project.
// Returns { min: number|null, signals: Array<{file,type,version}> }.
// `min` is the MAX of all signals (the strictest requirement).
export function aggregateJdkSignals(projectRoot) {
  const signals = [];
  function consider(file, type, version) {
    const v = parseInt(version, 10);
    if (!Number.isInteger(v) || v <= 0) return;
    signals.push({
      file: path.relative(projectRoot, file).replace(/\\/g, '/'),
      type,
      version: v,
    });
  }
  function walk(dir, depth) {
    if (depth > JDK_WALK_MAX_DEPTH) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!(e.name.endsWith('.gradle.kts') || e.name.endsWith('.kt'))) continue;
      const full = path.join(dir, e.name);
      let content;
      try { content = readFileSync(full, 'utf8'); } catch { continue; }
      for (const { type, re } of JDK_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(content)) !== null) consider(full, type, m[1]);
      }
    }
    for (const e of entries) {
      if (!e.isDirectory() || JDK_WALK_EXCLUDE.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }
  try { walk(projectRoot, 0); } catch { /* swallow */ }
  let min = null;
  for (const s of signals) {
    if (min === null || s.version > min) min = s.version;
  }
  return { min, signals };
}

// Parse settings.gradle.kts for `include(":mod")` declarations.
// Returns canonical `:`-prefixed names (e.g. ':core-encryption').
// Handles include(":foo"), include(':foo'), include ":foo", include ':foo',
// and continued lists like include(":a", ":b").
export function parseSettingsIncludes(projectRoot) {
  const file = path.join(projectRoot, 'settings.gradle.kts');
  if (!existsSync(file)) return [];
  let content;
  try { content = readFileSync(file, 'utf8'); } catch { return []; }
  const set = new Set();
  // For each `include` keyword, scan its statement (up to newline or `;`)
  // and pull every quoted ":name".
  const re = /\binclude\b([^\n;]*)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const segment = m[1];
    const inner = /['"]:([\w\-:]+)['"]/g;
    let im;
    while ((im = inner.exec(segment)) !== null) set.add(`:${im[1]}`);
  }
  return Array.from(set).sort();
}

// Detect whether the project's build-logic/ directory configures kover or
// jacoco via convention plugins (v0.5.2 Gap A — port the bash
// `detect_coverage_tool` build-logic scan into JS so we can retire the
// legacy chain). Scans build-logic/**/*.{gradle.kts,kt} for the literal
// plugin names. Returns { hasKover, hasJacoco }.
//
// The signal is project-wide: a convention plugin in build-logic/ that
// applies kover affects every module that consumes the convention plugin,
// even when the module's own build.gradle.kts doesn't mention kover.
// `analyzeModule` ORs this against the per-module signal so modules
// inherit the project-wide hint when they have no per-module reference.
export function detectBuildLogicCoverageHints(projectRoot) {
  const buildLogicDir = path.join(projectRoot, 'build-logic');
  if (!existsSync(buildLogicDir)) return { hasKover: false, hasJacoco: false };
  let hasKover = false;
  let hasJacoco = false;
  function walk(dir, depth) {
    if (depth > 8) return;
    if (hasKover && hasJacoco) return; // short-circuit once both signals seen
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile() && (e.name.endsWith('.gradle.kts') || e.name.endsWith('.kt'))) {
        let content = '';
        try { content = readFileSync(path.join(dir, e.name), 'utf8'); } catch { continue; }
        if (!hasKover && /\bkover\b/.test(content)) hasKover = true;
        if (!hasJacoco && (/\bjacoco\b/.test(content) || /\btestCoverageEnabled\b/.test(content))) hasJacoco = true;
        if (hasKover && hasJacoco) return;
      }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'build' || e.name === '.gradle' || e.name === 'node_modules' || e.name === '.git') continue;
      walk(path.join(dir, e.name), depth + 1);
      if (hasKover && hasJacoco) return;
    }
  }
  try { walk(buildLogicDir, 0); } catch { /* swallow — best effort */ }
  return { hasKover, hasJacoco };
}

// Analyze a single module: build.gradle.kts contents + filesystem source-sets.
// Returns the per-module record minus the gradleTasks/resolved fields (those
// come from the probe layer in buildProjectModel).
//
// The optional `buildLogicHints` parameter (v0.5.2 Gap A) carries the
// project-wide kover/jacoco signal from `detectBuildLogicCoverageHints`.
// When the per-module build file has no kover/jacoco mention, the hint
// fills in `coveragePlugin` so the module inherits the convention-plugin
// configuration (e.g. shared-kmp-libs's build-logic kover apply).
export function analyzeModule(projectRoot, moduleName, buildLogicHints = null) {
  const rel = moduleName.replace(/^:/, '').replace(/:/g, path.sep);
  const modulePath = path.join(projectRoot, rel);
  const buildFile = path.join(modulePath, 'build.gradle.kts');
  let content = '';
  try { content = readFileSync(buildFile, 'utf8'); } catch { /* missing or unreadable */ }

  // Source-set detection — 9 standard directories.
  const sourceSetNames = [
    'test', 'commonTest', 'jvmTest', 'desktopTest',
    'androidUnitTest', 'androidInstrumentedTest', 'androidTest',
    'iosTest', 'nativeTest',
  ];
  const sourceSets = {};
  for (const ss of sourceSetNames) {
    sourceSets[ss] = existsSync(path.join(modulePath, 'src', ss));
  }

  // Type detection.
  // Android plugin coverage (v0.6 Bug 2): the `library` / `application`
  // alternation missed `com.android.test` (test-fixtures-only Android module
  // pattern, e.g. Confetti's androidBenchmark) and `kotlin("android")` /
  // `org.jetbrains.kotlin.android` (the Android-paired Kotlin plugin id —
  // separate from AGP itself; some modules apply it without an AGP id, others
  // pair AGP + kotlin-android with neither matching the pre-fix regex).
  const kmpPluginIdPattern = /kotlin\s*\(\s*['"]multiplatform['"]\s*\)|id\s*\(?\s*['"]org\.jetbrains\.kotlin\.multiplatform['"]/;
  const hasAndroidLibraryDsl = /\bandroidLibrary\s*\{/.test(content);
  const hasAndroidTargetCall = /\bandroidTarget\s*\(/.test(content);
  const hasAndroidPlugin       = /\bid\s*\(?\s*['"]com\.android\.(library|application|test)['"]/.test(content);
  const hasKotlinAndroidPlugin = /kotlin\s*\(\s*['"]android['"]\s*\)|id\s*\(?\s*['"]org\.jetbrains\.kotlin\.android['"]/.test(content);
  const hasJvmKotlinPlugin     = /kotlin\s*\(\s*['"]jvm['"]\s*\)|id\s*\(?\s*['"]org\.jetbrains\.kotlin\.jvm['"]/.test(content);

  let type = 'unknown';
  let androidDsl = null;
  if (kmpPluginIdPattern.test(content) || hasAndroidLibraryDsl || hasAndroidTargetCall) {
    type = 'kmp';
    if (hasAndroidLibraryDsl) androidDsl = 'androidLibrary';
    else if (hasAndroidTargetCall) androidDsl = 'androidTarget';
  } else if (hasAndroidPlugin || hasKotlinAndroidPlugin) {
    type = 'android';
  } else if (hasJvmKotlinPlugin) {
    type = 'jvm';
  }

  // Has flavor (drives the connected${Flavor}DebugAndroidTest candidate).
  const hasFlavor = /\bproductFlavors\b/.test(content);

  // Coverage plugin detection. Per-module signal first (most specific),
  // then build-logic project-wide hint (v0.5.2 Gap A — replaces the
  // legacy `detect_coverage_tool` build-logic scan that lived in bash).
  let coveragePlugin = null;
  if (/\bkover\b/.test(content)) coveragePlugin = 'kover';
  else if (/\bjacoco\b/.test(content) || /\btestCoverageEnabled\b/.test(content)) coveragePlugin = 'jacoco';
  else if (buildLogicHints) {
    if (buildLogicHints.hasKover) coveragePlugin = 'kover';
    else if (buildLogicHints.hasJacoco) coveragePlugin = 'jacoco';
  }

  return { type, androidDsl, hasFlavor, sourceSets, coveragePlugin };
}

// Predict the canonical coverage task name from the (coveragePlugin, type)
// pair when probe data is unavailable (v0.5.2 Gap A — replaces the legacy
// `get_coverage_gradle_task` mapping in coverage-detect.sh). Used as a
// fallback inside `resolveTasksFor` when gradleTasks is null.
//   - jacoco          → jacocoTestReport
//   - kover + kmp     → koverXmlReportDesktop  (jvm-side coverage on KMP)
//   - kover + android → koverXmlReportDebug
//   - kover + jvm     → koverXmlReport
//   - else            → null
function predictCoverageTask(coveragePlugin, type) {
  if (coveragePlugin === 'jacoco') return 'jacocoTestReport';
  if (coveragePlugin === 'kover') {
    if (type === 'kmp') return 'koverXmlReportDesktop';
    if (type === 'android') return 'koverXmlReportDebug';
    if (type === 'jvm') return 'koverXmlReport';
    return 'koverXmlReport'; // unknown type — best effort
  }
  return null;
}

// Resolve canonical task names from a per-module gradleTasks[] list.
// Returns { unitTestTask, deviceTestTask, coverageTask } — each null when
// no candidate matched (probe ran but nothing fits) AND no fallback applies.
//
// When `gradleTasks` is null (probe didn't run / timed out) but the analysis
// carries a `coveragePlugin` signal, predict the coverage task name via
// `predictCoverageTask` (v0.5.2 Gap A). The script-side coverage selector
// then confirms task existence via the cheap `module_has_task` probe before
// invoking gradle, so a wrong prediction degrades gracefully to a
// `[SKIP coverage]` notice.
export function resolveTasksFor(_moduleName, gradleTasks, analysis = null) {
  const predictedCoverage = analysis
    ? predictCoverageTask(analysis.coveragePlugin, analysis.type)
    : null;
  if (!Array.isArray(gradleTasks)) {
    return {
      unitTestTask: null,
      deviceTestTask: null,
      coverageTask: predictedCoverage,
    };
  }
  const set = new Set(gradleTasks);
  function pickFirst(candidates) {
    for (const c of candidates) if (set.has(c)) return c;
    return null;
  }
  const probedCoverage = pickFirst([
    'koverXmlReportDesktop', 'koverXmlReportDebug', 'koverXmlReport', 'jacocoTestReport',
  ]);
  return {
    unitTestTask:   pickFirst(['desktopTest', 'jvmTest', 'test']),
    deviceTestTask: pickFirst(['connectedDebugAndroidTest', 'connectedAndroidTest', 'androidConnectedCheck']),
    coverageTask:   probedCoverage ?? predictedCoverage,
  };
}

// Parse `gradlew tasks --all --quiet` output into Map<moduleName, taskList>.
// Real format is `module:task - description` (no leading colon at column 0).
export function parseGradleTasksOutput(content) {
  const out = new Map();
  if (!content) return out;
  for (const rawLine of content.split(/\r?\n/)) {
    const m = rawLine.match(/^([\w\-]+(?::[\w\-]+)*):([\w]+)(?:\s|$)/);
    if (!m) continue;
    const mod = m[1];
    const task = m[2];
    if (!out.has(mod)) out.set(mod, []);
    if (!out.get(mod).includes(task)) out.get(mod).push(task);
  }
  return out;
}

// Probe gradle for the full task set. Returns Map<moduleName, taskList> or null.
function probeGradleTasksCached(projectRoot, cacheKey, opts = {}) {
  const cacheDir = path.join(projectRoot, CACHE_DIR_NAME);
  const cacheFile = path.join(cacheDir, `tasks-${cacheKey}.txt`);
  if (existsSync(cacheFile)) {
    try {
      const content = readFileSync(cacheFile, 'utf8');
      if (content && content.length > 0) return parseGradleTasksOutput(content);
    } catch { /* fall through */ }
  }

  if (opts.skipProbe) return null;

  const isWin = process.platform === 'win32';
  const wrapper = isWin ? 'gradlew.bat' : 'gradlew';
  const wrapperPath = path.join(projectRoot, wrapper);
  if (!existsSync(wrapperPath)) return null;

  const timeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const result = spawnSync(wrapperPath, ['tasks', '--all', '--quiet'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error || result.status !== 0 || !result.stdout) return null;

  try {
    mkdirSync(cacheDir, { recursive: true });
    const tmp = `${cacheFile}.tmp.${process.pid}`;
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, result.stdout); } finally { closeSync(fd); }
    renameSync(tmp, cacheFile);
  } catch { /* best-effort persist */ }

  return parseGradleTasksOutput(result.stdout);
}

// Build a fresh ProjectModel for projectRoot.
//   opts.useCache (default true) — read existing model JSON if cacheKey matches.
//   opts.skipProbe (default false) — when true, never invoke gradle. Useful in
//                                    unit tests that pre-write the cache file.
//   opts.probeTimeoutMs (default 60_000) — gradle tasks probe watchdog.
export function buildProjectModel(projectRoot, opts = {}) {
  if (!projectRoot || !existsSync(projectRoot)) {
    throw new Error(`buildProjectModel: projectRoot does not exist: ${projectRoot}`);
  }
  const useCache = opts.useCache !== false;
  const cacheKey = computeCacheKey(projectRoot);
  const cacheDir = path.join(projectRoot, CACHE_DIR_NAME);
  const modelFile = path.join(cacheDir, `model-${cacheKey}.json`);

  if (useCache && existsSync(modelFile)) {
    try {
      const cached = JSON.parse(readFileSync(modelFile, 'utf8'));
      if (
        cached
        && cached.schemaVersion === SCHEMA_VERSION
        && cached.cacheKey === cacheKey
        && cached.projectRoot === projectRoot
      ) {
        return cached;
      }
    } catch { /* corrupt cache — rebuild */ }
  }

  const settingsIncludes = parseSettingsIncludes(projectRoot);
  const jdkRequirement = aggregateJdkSignals(projectRoot);
  const buildLogicHints = detectBuildLogicCoverageHints(projectRoot);
  const probeMap = probeGradleTasksCached(projectRoot, cacheKey, opts);

  const modules = {};
  for (const inc of settingsIncludes) {
    const analysis = analyzeModule(projectRoot, inc, buildLogicHints);
    const modKey = inc.replace(/^:/, '');
    const tasks = probeMap ? (probeMap.get(modKey) ?? null) : null;
    const resolved = resolveTasksFor(inc, tasks, analysis);
    modules[inc] = {
      ...analysis,
      gradleTasks: tasks,
      resolved,
    };
  }

  const model = {
    schemaVersion: SCHEMA_VERSION,
    projectRoot,
    generatedAt: new Date().toISOString(),
    cacheKey,
    jdkRequirement,
    settingsIncludes,
    modules,
  };

  if (useCache) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      const tmp = `${modelFile}.tmp.${process.pid}`;
      const fd = openSync(tmp, 'w');
      try { writeSync(fd, JSON.stringify(model, null, 2)); } finally { closeSync(fd); }
      renameSync(tmp, modelFile);
    } catch { /* best-effort persist */ }
  }

  return model;
}

// Test/diagnostic helper: clear all model-*.json caches under <projectRoot>.
export function clearProjectModelCache(projectRoot) {
  const cacheDir = path.join(projectRoot, CACHE_DIR_NAME);
  if (!existsSync(cacheDir)) return;
  let entries;
  try { entries = readdirSync(cacheDir); } catch { return; }
  for (const name of entries) {
    if (!name.startsWith('model-') || !name.endsWith('.json')) continue;
    try { unlinkSync(path.join(cacheDir, name)); } catch { /* swallow */ }
  }
}

export const SCHEMA_VERSION_CONST = SCHEMA_VERSION;
export { SCHEMA_VERSION };

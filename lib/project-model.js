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
// depth ≤ 4 excluding build/ and .gradle/, sorted lexicographically), strip
// trailing newlines on each chunk (mirrors `$(cat foo)` shell semantics),
// SHA1 the result.
//
// NOTE on cross-platform parity: JS and sh produce IDENTICAL SHAs for ASCII-
// only build files when no edge cases trigger (verified against simple
// fixtures). Real-world projects with mixed line-ending normalization or
// trailing-whitespace-only differences may produce slightly different SHAs
// (~50-200 bytes of concat divergence on a 130KB input). This is acceptable:
// (a) Each walker correctly invalidates its OWN cache when content changes
//     — the probe cache and the model cache may simply have different SHAs
//     in their filenames and coexist as `tasks-<sha>.txt` + `model-<sha>.json`.
// (b) The performance overhead is one extra file per cache generation
//     (~1KB) and there is no correctness impact — sh/ps1 readers always
//     locate the model file via the JS-computed SHA, and the gradle-tasks
//     probe always locates its cache via the sh/ps1-computed SHA.
// (c) Aligning them byte-for-byte across Windows/POSIX requires reproducing
//     bash's exact `$(cat foo)` semantics for trailing-CR/LF handling and
//     is deferred to v0.5.2 if it ever produces a user-visible issue.
function stripTrailingNewlines(s) {
  return s.replace(/\n+$/, '');
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
    try { concat += stripTrailingNewlines(readFileSync(settings, 'utf8')); } catch { /* skip */ }
  }
  const props = path.join(projectRoot, 'gradle.properties');
  if (existsSync(props)) {
    try { concat += stripTrailingNewlines(readFileSync(props, 'utf8')); } catch { /* skip */ }
  }
  for (const f of collectBuildFiles(projectRoot)) {
    try { concat += stripTrailingNewlines(readFileSync(f, 'utf8')); } catch { /* skip */ }
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

// Analyze a single module: build.gradle.kts contents + filesystem source-sets.
// Returns the per-module record minus the gradleTasks/resolved fields (those
// come from the probe layer in buildProjectModel).
export function analyzeModule(projectRoot, moduleName) {
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
  const kmpPluginIdPattern = /kotlin\s*\(\s*['"]multiplatform['"]\s*\)|id\s*\(?\s*['"]org\.jetbrains\.kotlin\.multiplatform['"]/;
  const hasAndroidLibraryDsl = /\bandroidLibrary\s*\{/.test(content);
  const hasAndroidTargetCall = /\bandroidTarget\s*\(/.test(content);
  const hasAndroidPlugin     = /\bid\s*\(?\s*['"]com\.android\.(library|application)['"]/.test(content);
  const hasJvmKotlinPlugin   = /kotlin\s*\(\s*['"]jvm['"]\s*\)|id\s*\(?\s*['"]org\.jetbrains\.kotlin\.jvm['"]/.test(content);

  let type = 'unknown';
  let androidDsl = null;
  if (kmpPluginIdPattern.test(content) || hasAndroidLibraryDsl || hasAndroidTargetCall) {
    type = 'kmp';
    if (hasAndroidLibraryDsl) androidDsl = 'androidLibrary';
    else if (hasAndroidTargetCall) androidDsl = 'androidTarget';
  } else if (hasAndroidPlugin) {
    type = 'android';
  } else if (hasJvmKotlinPlugin) {
    type = 'jvm';
  }

  // Has flavor (drives the connected${Flavor}DebugAndroidTest candidate).
  const hasFlavor = /\bproductFlavors\b/.test(content);

  // Coverage plugin (fast-path detection — D1 keeps detect_coverage_tool as
  // the deeper fallback for catalog/build-logic-derived signals).
  let coveragePlugin = null;
  if (/\bkover\b/.test(content)) coveragePlugin = 'kover';
  else if (/\bjacoco\b/.test(content) || /\btestCoverageEnabled\b/.test(content)) coveragePlugin = 'jacoco';

  return { type, androidDsl, hasFlavor, sourceSets, coveragePlugin };
}

// Resolve canonical task names from a per-module gradleTasks[] list.
// Returns { unitTestTask, deviceTestTask, coverageTask } — each null when
// no candidate matched (probe ran but nothing fits).
export function resolveTasksFor(_moduleName, gradleTasks) {
  if (!Array.isArray(gradleTasks)) {
    return { unitTestTask: null, deviceTestTask: null, coverageTask: null };
  }
  const set = new Set(gradleTasks);
  function pickFirst(candidates) {
    for (const c of candidates) if (set.has(c)) return c;
    return null;
  }
  return {
    unitTestTask:   pickFirst(['desktopTest', 'jvmTest', 'test']),
    deviceTestTask: pickFirst(['connectedDebugAndroidTest', 'connectedAndroidTest', 'androidConnectedCheck']),
    coverageTask:   pickFirst(['koverXmlReportDesktop', 'koverXmlReportDebug', 'koverXmlReport', 'jacocoTestReport']),
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
  const probeMap = probeGradleTasksCached(projectRoot, cacheKey, opts);

  const modules = {};
  for (const inc of settingsIncludes) {
    const analysis = analyzeModule(projectRoot, inc);
    const modKey = inc.replace(/^:/, '');
    const tasks = probeMap ? (probeMap.get(modKey) ?? null) : null;
    const resolved = resolveTasksFor(inc, tasks);
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

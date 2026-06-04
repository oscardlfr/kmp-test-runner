// SPDX-License-Identifier: MIT
// lib/project-model.js — canonical project introspector (v0.5.1 Phase 4).
//
// Builds a single ProjectModel JSON file at:
//   <projectRoot>/.kmp-test-runner/cache/model-<sha1>.json
// (v0.8.0 — moved from <projectRoot>/.kmp-test-runner-cache/ as part of the
// artifact-subdir consolidation. Legacy path is read via dual-read fallback
// for one transition release; v0.9 drops the fallback.)
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
//
// The introspector is split across 3 files — this orchestrator
// (buildProjectModel + parseGradleTasksOutput + detectBuildLogicCoverageHints),
// ./project/analyze-module.js (per-module classifier + canonical-task
// resolution), and ./project/cache.js (schema versioning, fingerprint,
// content-addressed cache key, gradle-task probe with disk persistence).
// External consumers keep importing every public symbol from this file via
// ESM live-binding re-exports.

import {
  readFileSync, readdirSync, existsSync, mkdirSync,
  openSync, closeSync, writeSync, renameSync,
} from 'node:fs';
import path from 'node:path';
import { aggregateJdkSignals } from './project/jdk-signals.js';
import {
  stripGradleComments,
  parseSettingsIncludes,
  parseVersionCatalog,
  parseBuildLogicPluginDescriptors,
} from './project/kotlin-dsl.js';
import {
  SCHEMA_VERSION,
  MODEL_FINGERPRINT,
  CACHE_DIR_NAME,
  LEGACY_CACHE_DIR_NAME,
  computeCacheKey,
  probeGradleTasksCached,
  clearProjectModelCache,
} from './project/cache.js';
import { analyzeModule, resolveTasksFor } from './project/analyze-module.js';

// Re-export for back-compat: cli.js + tests import aggregateJdkSignals
// from this module via ESM live binding.
export { aggregateJdkSignals } from './project/jdk-signals.js';
// Re-export for back-compat: tests import these parsers from this module
// via ESM live binding.
export {
  stripGradleComments,
  parseSettingsIncludes,
  parseVersionCatalog,
  parseBuildLogicPluginDescriptors,
  extractAppliedPluginsFromConventionSource,
} from './project/kotlin-dsl.js';
// Re-export for back-compat: tests + bats + pester fixtures import the cache
// + module-analysis surface from this module.
export {
  SCHEMA_VERSION,
  MODEL_FINGERPRINT,
  CACHE_DIR_NAME,
  LEGACY_CACHE_DIR_NAME,
  computeCacheKey,
  clearProjectModelCache,
} from './project/cache.js';
export { analyzeModule, resolveTasksFor, flavorsFromTasks } from './project/analyze-module.js';

// JDK signal helpers (JDK_WALK_EXCLUDE, JDK_PATTERNS, agpRequiredJdk,
// detectAgpVersion, aggregateJdkSignals) live in ./project/jdk-signals.js.
// Imported above + re-exported for back-compat.

// Detect whether the project's build-logic/ directory configures kover or
// jacoco via convention plugins (v0.5.2 Gap A — port the bash
// `detect_coverage_tool` build-logic scan into JS so we can retire the
// legacy chain).
//
// v0.6 Bug 6 refinement: distinguish CONVENTION (consumer modules inherit
// the plugin) from SELF (build-logic's own buildscript uses the plugin only
// for compiling itself). Pre-fix the naive `\bjacoco\b` scan over every
// build-logic file produced false positives in two ways:
//
//   1. nowinandroid's `build-logic/convention/build.gradle.kts` lists plugin
//      registrations like `register("androidApplicationJacoco")` and
//      `implementationClass = "AndroidApplicationJacocoConventionPlugin"`.
//      Both contain the substring "jacoco" but neither APPLIES jacoco —
//      they only NAME plugin descriptors. Modules that consume those
//      convention plugins do inherit jacoco; modules that don't, don't.
//   2. A build-logic module that uses jacoco for its OWN compilation /
//      testing (`plugins { jacoco }` in `build-logic/build.gradle.kts`)
//      doesn't propagate the plugin to consumer modules.
//
// Discrimination rule:
//   - File path under `build-logic/**/src/main/...` (precompiled-script
//     plugins or `Plugin<Project>` class sources) → CONVENTION signal.
//     Anything mentioning kover/jacoco there shapes consumer modules.
//   - File path is a `*.gradle.kts` outside `src/main/` (build-logic's
//     own buildscript) → SELF signal. Plugin-registration noise is stripped
//     first (`register(...)`, `implementationClass = ...`, `pluginId = ...`,
//     `asProvider().get().pluginId`) so naming-only references don't trigger
//     a false positive. Whatever survives is a real `plugins { jacoco }` /
//     `apply { plugin("jacoco") }` reference.
//
// `analyzeModule` only inherits when `kind === 'convention'`. SELF signals
// are recorded for diagnostic visibility but never propagate to per-module
// `coveragePlugin`. CONVENTION wins over SELF when both fire on the same
// plugin (a build-logic module both compiles itself with jacoco AND
// publishes a jacoco convention plugin).
//
// Returns `{ hasKover, hasJacoco }` with each value being one of:
//   - `'convention'` — a real consumer-facing convention plugin signal
//   - `'self'`       — build-logic's own buildscript (NOT inherited)
//   - `null`         — no signal
//
// Pre-fix shape was `{ hasKover: boolean, hasJacoco: boolean }`. The
// breaking change to the kind tri-state is intentional: every call site
// inside this module updates in lockstep, and the only external consumer
// is `analyzeModule` which now branches on `=== 'convention'`.
export function detectBuildLogicCoverageHints(projectRoot) {
  const buildLogicDir = path.join(projectRoot, 'build-logic');
  if (!existsSync(buildLogicDir)) return { hasKover: null, hasJacoco: null };
  let koverKind = null;
  let jacocoKind = null;

  // Convention wins over self. Once a kind is convention, never downgrade.
  function record(plugin, kind) {
    if (plugin === 'kover') {
      if (koverKind !== 'convention') koverKind = kind;
    } else {
      if (jacocoKind !== 'convention') jacocoKind = kind;
    }
  }

  // Strip line and block comments first (they may legitimately mention
  // kover/jacoco for documentation purposes), then strip `register("...") { ... }`
  // blocks plus any leftover `implementationClass = "..."`, `pluginId = ...`,
  // `asProvider().get().pluginId`, and `id = libs.plugins.<...>` lines that
  // may live outside register blocks.
  //
  // Without this, a `build-logic/convention/build.gradle.kts` that only NAMES
  // jacoco-related convention plugins (nowinandroid's pattern) raises a
  // false-positive self-signal because the body of the register block
  // contains `id = libs.plugins.<...>.jacoco.get().pluginId`.
  //
  // Body uses `[^}]*` which breaks if the register block contains nested
  // braces — none of the real-world fixtures do (just two lines: `id = ...`
  // and `implementationClass = "..."`). If a project ever nests a brace
  // inside the register body, we'll over-strip until the next `}` and
  // possibly miss a real signal — acceptable trade-off vs. false positives.
  function stripRegistrationNoise(content) {
    return stripGradleComments(content)
      .replace(/register\s*\([^)]*\)\s*\{[^}]*\}/g, '')
      .replace(/register\s*\([^)]*\)/g, '')
      .replace(/implementationClass\s*=\s*['"][^'"]*['"]/g, '')
      .replace(/\bid\s*=\s*libs\.plugins[^\n]*/g, '')
      .replace(/pluginId\s*=\s*[^\n]*/g, '')
      .replace(/asProvider\s*\(\s*\)\s*\.\s*get\s*\(\s*\)\s*\.\s*pluginId/g, '');
  }

  function walk(dir, depth) {
    if (depth > 8) return;
    if (koverKind === 'convention' && jacocoKind === 'convention') return; // strongest pair seen
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!(e.name.endsWith('.gradle.kts') || e.name.endsWith('.gradle') || e.name.endsWith('.kt'))) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(buildLogicDir, full).replace(/\\/g, '/');
      const isUnderSrcMain = /(^|\/)src\/main\//.test(rel);

      let content = '';
      try { content = readFileSync(full, 'utf8'); } catch { continue; }

      // Strip comments under both kinds — a comment mentioning jacoco/kover
      // ("// TODO: add jacoco support") shouldn't raise any signal regardless
      // of whether the file is a convention plugin or a self-buildscript.
      const scan = isUnderSrcMain ? stripGradleComments(content) : stripRegistrationNoise(content);
      const kind = isUnderSrcMain ? 'convention' : 'self';

      if (/\bkover\b/.test(scan)) record('kover', kind);
      if (/\bjacoco\b/.test(scan) || /\btestCoverageEnabled\b/.test(scan)) record('jacoco', kind);
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'build' || e.name === '.gradle' || e.name === 'node_modules' || e.name === '.git') continue;
      walk(path.join(dir, e.name), depth + 1);
      if (koverKind === 'convention' && jacocoKind === 'convention') return;
    }
  }
  try { walk(buildLogicDir, 0); } catch { /* swallow — best effort */ }
  return { hasKover: koverKind, hasJacoco: jacocoKind };
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
  // v0.8.0 dual-read: try new path, fall back to legacy `.kmp-test-runner-cache/`
  // so v0.7.x users don't lose their model cache on first upgrade. Schema bump
  // to 7 invalidates v6 caches anyway, but the dual-read is defensive: future
  // path-only moves (without a schema bump) will keep working.
  const legacyModelFile = path.join(projectRoot, LEGACY_CACHE_DIR_NAME, `model-${cacheKey}.json`);

  if (useCache) {
    for (const candidate of [modelFile, legacyModelFile]) {
      if (!existsSync(candidate)) continue;
      try {
        const cached = JSON.parse(readFileSync(candidate, 'utf8'));
        if (
          cached
          && cached.schemaVersion === SCHEMA_VERSION
          && cached.modelFingerprint === MODEL_FINGERPRINT
          && cached.cacheKey === cacheKey
          && cached.projectRoot === projectRoot
          // A probe-blind cached model (built with skipProbe and no tasks-<sha>
          // cache, so every resolved.* task is null) must not be served back to
          // a caller that wants the probe. Otherwise a `describe --skip-probe`
          // on a fresh project persists a coverage/task-blind model that the
          // next plain `describe` reads — silently returning null tasks instead
          // of re-probing. skip-probe callers still accept it (they opted out).
          && !(cached.probed === false && !opts.skipProbe)
        ) {
          return cached;
        }
      } catch { /* corrupt cache — try next candidate or rebuild */ }
    }
  }

  const settingsIncludes = parseSettingsIncludes(projectRoot);
  const jdkRequirement = aggregateJdkSignals(projectRoot);
  const buildLogicHints = detectBuildLogicCoverageHints(projectRoot);
  const catalog = parseVersionCatalog(projectRoot);
  const buildLogicDescriptors = parseBuildLogicPluginDescriptors(projectRoot, catalog);
  const probeMap = probeGradleTasksCached(projectRoot, cacheKey, opts);

  const modules = {};
  for (const inc of settingsIncludes) {
    const analysis = analyzeModule(projectRoot, inc, buildLogicHints, catalog, buildLogicDescriptors);
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
    modelFingerprint: MODEL_FINGERPRINT,
    projectRoot,
    generatedAt: new Date().toISOString(),
    cacheKey,
    // Whether this model was built from real gradle task-graph data — the probe
    // ran, or a tasks-<sha>.txt cache hit. False only for a skip-probe build
    // with no tasks cache (all resolved.* null). The cache-read guard above uses
    // this so a blind model is never served to a probe-wanting caller.
    probed: probeMap !== null,
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

export const SCHEMA_VERSION_CONST = SCHEMA_VERSION;

// SPDX-License-Identifier: MIT
// lib/project/cache.js — project-model cache layer.
//
// Owns: schema versioning, model fingerprint, cache directory constants,
// content-addressed cache key, gradle-task probe with disk persistence, and
// the diagnostic clear-cache helper.
//
// Extracted from lib/project-model.js so the orchestrator (buildProjectModel)
// stays a thin composition step. The cache key matches
// scripts/sh/lib/gradle-tasks-probe.sh:_kmp_compute_cache_key byte-for-byte
// across LF/CRLF/multiple-trailing-newline variants — sibling shell + ps1
// walkers must produce identical SHAs (cross-platform parity) FOR THE INPUTS
// THEY BOTH HASH. One exception (PR-28b/PR-28e): build-logic/**/*.kt,
// build-logic/**/*.gradle.kts, and build-logic/**/*.gradle sources are
// hashed only here, not in the sh/ps1 siblings — see the SCHEMA_VERSION 8→9
// and 9→10 comments below for why that's safe to leave scoped.
//
// All file I/O is sync. Atomic writes use tmp + rename so concurrent runs
// never see a half-written cache file.

import { spawnSync } from 'node:child_process';
import {
  readFileSync, readdirSync, existsSync, mkdirSync,
  openSync, closeSync, writeSync, unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawnGradle } from '../orchestrators/orchestrator-utils.js';
import { renameWithRetrySync } from './artifact-sweep.js';
// Back-import keeps probeGradleTasksCached + buildProjectModel sharing one
// parser. Live ESM binding — runtime resolution avoids the top-level cycle.
import { parseGradleTasksOutput } from '../project-model.js';

// v0.8 sub-entry 5: schema bump from 1 → 2 to invalidate stale caches that
// don't include the iOS/macOS *Main source-set keys added below. Required for
// the parallel-orchestrator's permissive --test-type ios|macos dispatch on
// Confetti :shared shape (iosMain only, no iosTest yet — gradle still creates
// the *Test task from the target() declaration).
// Bumped 5 → 6 (2026-05-03): analyzeModule emits hasDefaultJvm. Old
// caches missing this field would skip default-jvm() KMP modules with
// only commonTest/ on disk (PeopleInSpace `:common` repro). Bump
// invalidates so first run after upgrade picks up jvmTest correctly.
// Bumped 6 → 7 (2026-05-04): cache directory moved from
// `.kmp-test-runner-cache/` to `.kmp-test-runner/cache/` as part of v0.8.0
// artifact-subdir consolidation. Dual-read fallback covers v0.7.x users
// during one transition release; legacy caches at the old path are read
// once and then ignored (writes go to the new path only).
// Bumped 7 → 8 (2026-06-09): computeCacheKey grows gradle/libs.versions.toml
// in its hashed input set. analyzeModule resolves plugin aliases from that
// catalog (alias(libs.plugins.X) → plugin id), so a toml edit changes the
// model output — pre-bump caches keyed without the toml would keep serving
// the stale model until an unrelated build file changed.
// Bumped 8 → 9 (2026-07-14, PR-28b): computeCacheKey grows
// build-logic/**/*.kt (convention-plugin Kotlin sources) in its hashed input
// set. detectBuildLogicCoverageHints and parseBuildLogicPluginDescriptors
// (coveragePlugin) and aggregateJdkSignals (jdkRequirement) all derive
// signals from these files, so editing one changes model output — same
// shape as the 7→8 toml bump. Scope note: only build-logic/**/*.kt is
// hashed (matches the audit finding); precompiled-script-plugin
// build-logic/**/*.gradle.kts files are a related, still-open gap (tracked
// in BACKLOG.md). The sh/ps1 gradle-tasks-probe cache-key walkers are NOT
// updated in this pass — a cross-implementation cache-key mismatch only
// ever produces a miss (safe, forces a fresh probe), never a stale hit.
// Bumped 9 → 10 (2026-07-15, PR-28e): computeCacheKey grows
// build-logic/**/*.gradle.kts and build-logic/**/*.gradle (precompiled
// script-plugin sources) in its hashed input set — closes the residual gap
// left open by the 8→9 bump above. parseBuildLogicPluginDescriptors already
// parses both file types as descriptor sources (coveragePlugin,
// appliedPlugins, module `type`), and aggregateJdkSignals already reads
// .gradle.kts/.gradle content anywhere in the project, including
// build-logic/, for jdkRequirement — so editing a precompiled script
// plugin's applied-plugin id or JDK toolchain call changes model output
// exactly like a build-logic/**/*.kt edit does. Same shape as the 8→9 bump.
// Scope note: this fix targets the JS project-model cache only. The sh/ps1
// gradle-tasks-probe cache-key walkers are NOT updated in this pass — they
// never read or write model-*.json, so a JS/shell key mismatch can only
// cause a safe miss in their own probe cache, never a stale hit in the JS
// model.
const SCHEMA_VERSION = 10;
const CACHE_DIR_NAME = '.kmp-test-runner/cache';
const LEGACY_CACHE_DIR_NAME = '.kmp-test-runner-cache';
const MAX_BUILD_FILE_DEPTH = 4;
const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

// Fingerprint of the introspector's source. Surfaced by wet audit 2026-05-08:
// `cacheKey` only hashes project inputs (settings/properties/build files), so
// caches generated before a project-model change (e.g. a model fix in
// commit ae02317) silently keep returning outputs from the OLD logic until the
// project itself changes. By embedding a fingerprint of the introspector
// itself, any modification auto-invalidates existing caches — no manual
// SCHEMA_VERSION bump required. Tasks-<sha>.txt (raw gradle probe output) is
// independent of the introspector and stays valid, so re-building the model
// is Node-only (~ms), not a re-probe.
//
// The introspector is 3 files (project-model.js, project/analyze-module.js,
// project/cache.js). Hash all three so any source change still triggers
// invalidation.
const MODEL_FINGERPRINT = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)); // .../lib/project
    const sources = [
      path.join(here, '..', 'project-model.js'),
      path.join(here, 'analyze-module.js'),
      path.join(here, 'cache.js'),
    ];
    const concat = sources
      .map((f) => readFileSync(f, 'utf8').replace(/\r/g, '').replace(/\n+$/, ''))
      .join('\n');
    return crypto.createHash('sha1').update(concat).digest('hex').slice(0, 12);
  } catch {
    return 'unknown';
  }
})();

// Match scripts/sh/lib/gradle-tasks-probe.sh:_kmp_compute_cache_key:
// concat(settings.gradle(.kts) + gradle.properties + gradle/libs.versions.toml
// + every build.gradle(.kts) at depth ≤ 4 excluding build/ and .gradle/,
// sorted lexicographically), normalize CRLF/LF differences, SHA1 the result.
// Both the Kotlin (.kts) and Groovy (.gradle) script forms are hashed so
// editing a Groovy build/settings file invalidates the cache — purely
// additive, so a Kotlin-DSL project (no .gradle present) hashes
// byte-identically to before. The version catalog is hashed because
// analyzeModule resolves `alias(libs.plugins.X)` through it — editing a
// plugin alias/version must invalidate the model (same additive property:
// toml-free projects hash identically to the pre-toml key).
//
// PR-28b/PR-28e addition (JS-model-path only, NOT mirrored in the sh/ps1
// script above — see the SCHEMA_VERSION 8→9 and 9→10 comments for the scope
// rationale): build-logic/**/*.kt convention-plugin sources (PR-28b) and
// build-logic/**/*.gradle.kts / build-logic/**/*.gradle precompiled
// script-plugin sources (PR-28e) are hashed by RELATIVE PATH + content (not
// content alone), appended after the build-file walk. Path is included
// because a convention plugin's class name — and a precompiled script
// plugin's id — comes from its filename: analyzeModule resolves
// `coveragePlugin` from both via parseBuildLogicPluginDescriptors, so a
// rename can change model output even when total file content is
// unchanged. Additive: a project with no build-logic/ directory (or none
// containing a matching file) hashes identically to before either change.
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
      if (e.isFile() && (e.name === 'build.gradle.kts' || e.name === 'build.gradle')) {
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

// Depth cap + exclusion set mirror the two existing build-logic/ walkers
// that already consume these same files for model signals:
// kotlin-dsl.js#parseBuildLogicPluginDescriptors and
// project-model.js#detectBuildLogicCoverageHints (both `depth > 8`,
// both skip build/.gradle/node_modules/.git).
const BUILD_LOGIC_WALK_MAX_DEPTH = 8;
const BUILD_LOGIC_WALK_EXCLUDE = new Set(['build', '.gradle', 'node_modules', '.git']);

// Walk build-logic/**/*.kt (convention-plugin Kotlin sources),
// build-logic/**/*.gradle.kts, and build-logic/**/*.gradle (precompiled
// script-plugin sources) for the cache key — see the PR-28b/PR-28e comment
// above computeCacheKey for why. Returns [] when build-logic/ is absent, so
// the loop that consumes this is a no-op for projects with no build-logic/
// directory (purely additive to the pre-existing key).
//
// Deliberately broad, not path-restricted: parseBuildLogicPluginDescriptors
// (kotlin-dsl.js) only treats a `.gradle.kts` as a precompiled-script-plugin
// source under a `src/main/kotlin/` path segment (and `.gradle` under
// `src/main/groovy/`), but this walk hashes ANY matching file anywhere
// under build-logic/ regardless of path shape. Over-invalidating (hashing a
// file the descriptor parser wouldn't actually read as a descriptor source)
// is harmless — worst case, an unrelated edit forces one extra cache miss.
// Under-invalidating would silently serve a stale model, which is the bug
// this function exists to prevent. Keeping this walk suffix-only (not
// regex-matching a path shape) also avoids coupling cache.js's matching
// logic to kotlin-dsl.js's, which could otherwise silently drift out of
// sync if one changes without the other.
//
// A build-logic/<module>/build.gradle.kts registration file (gradlePlugin{}
// register{} blocks) matches BOTH this walk (path+content) AND the separate
// collectBuildFiles() walk above (content-only, since it's reachable within
// MAX_BUILD_FILE_DEPTH) — that file's content is hashed twice into `concat`.
// This is redundant but not incorrect: computeCacheKey only needs the
// concatenated string to CHANGE when relevant content changes, and
// duplicated content still changes when the source changes.
function collectBuildLogicSourceFiles(projectRoot) {
  const buildLogicDir = path.join(projectRoot, 'build-logic');
  if (!existsSync(buildLogicDir)) return [];
  const out = [];
  function walk(dir, depth) {
    if (depth > BUILD_LOGIC_WALK_MAX_DEPTH) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile() && (
        e.name.endsWith('.kt') ||
        e.name.endsWith('.gradle.kts') ||
        e.name.endsWith('.gradle')
      )) out.push(path.join(dir, e.name));
    }
    for (const e of entries) {
      if (!e.isDirectory() || BUILD_LOGIC_WALK_EXCLUDE.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }
  walk(buildLogicDir, 0);
  out.sort();
  return out;
}

// Known limitation (documented, deliberate): build files are hashed by
// walked-path CONTENT without realpathSync — two worktrees sharing gradle
// sources via symlinks hash identically and collide on one cache entry.
// Symlinked gradle build files are rare and per-file realpath adds I/O to
// every walk; callers that must separate such worktrees can use --no-cache.
// See docs/concurrency.md "Out of scope".
export function computeCacheKey(projectRoot) {
  let concat = '';
  const settings = path.join(projectRoot, 'settings.gradle.kts');
  if (existsSync(settings)) {
    try { concat += normalizeForHash(readFileSync(settings, 'utf8')); } catch { /* skip */ }
  }
  // Groovy settings.gradle hashed right after its .kts sibling. Absent on a
  // Kotlin-DSL project → concat unchanged → the canonical SHA holds; present on
  // a Groovy project so include/edit changes invalidate the model cache.
  const groovySettings = path.join(projectRoot, 'settings.gradle');
  if (existsSync(groovySettings)) {
    try { concat += normalizeForHash(readFileSync(groovySettings, 'utf8')); } catch { /* skip */ }
  }
  const props = path.join(projectRoot, 'gradle.properties');
  if (existsSync(props)) {
    try { concat += normalizeForHash(readFileSync(props, 'utf8')); } catch { /* skip */ }
  }
  // Version catalog — hashed after gradle.properties, before the build-file
  // walk. Keep this slot identical in the sh + ps1 siblings (3-way parity).
  const versionCatalog = path.join(projectRoot, 'gradle', 'libs.versions.toml');
  if (existsSync(versionCatalog)) {
    try { concat += normalizeForHash(readFileSync(versionCatalog, 'utf8')); } catch { /* skip */ }
  }
  for (const f of collectBuildFiles(projectRoot)) {
    try { concat += normalizeForHash(readFileSync(f, 'utf8')); } catch { /* skip */ }
  }
  // build-logic convention-plugin sources (.kt / .gradle.kts / .gradle) —
  // hashed last, by relative path + content. See the PR-28b/PR-28e comment
  // above for why path is included.
  for (const f of collectBuildLogicSourceFiles(projectRoot)) {
    const rel = path.relative(projectRoot, f).replace(/\\/g, '/');
    try { concat += rel + '\n' + normalizeForHash(readFileSync(f, 'utf8')); } catch { /* skip */ }
  }
  return crypto.createHash('sha1').update(concat).digest('hex');
}

// Probe gradle for the full task set. Returns Map<moduleName, taskList> or null.
export function probeGradleTasksCached(projectRoot, cacheKey, opts = {}) {
  const cacheDir = path.join(projectRoot, CACHE_DIR_NAME);
  const cacheFile = path.join(cacheDir, `tasks-${cacheKey}.txt`);
  // v0.8.0 dual-read: try new path, fall back to legacy `.kmp-test-runner-cache/`
  // so v0.7.x users don't lose their probe cache on first upgrade.
  const legacyCacheFile = path.join(projectRoot, LEGACY_CACHE_DIR_NAME, `tasks-${cacheKey}.txt`);
  for (const candidate of [cacheFile, legacyCacheFile]) {
    if (existsSync(candidate)) {
      try {
        const content = readFileSync(candidate, 'utf8');
        if (content && content.length > 0) return parseGradleTasksOutput(content);
      } catch { /* fall through */ }
    }
  }

  if (opts.skipProbe) return null;

  const isWin = process.platform === 'win32';
  const wrapper = isWin ? 'gradlew.bat' : 'gradlew';
  const wrapperPath = path.join(projectRoot, wrapper);
  if (!existsSync(wrapperPath)) return null;

  const timeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  // Route gradle invocations through `spawnGradle` so Windows hosts work:
  // direct `spawnSync('gradlew.bat', …)` returns `EINVAL` since Node 18.20.2 /
  // 20.12.2 / 22.0.0+ enforced CVE-2024-27980. The v0.8.0 sub-entry-1 fix in
  // `lib/orchestrator-utils.js#spawnGradle` wraps via `cmd.exe /d /s /c` with
  // `windowsVerbatimArguments:true`. This call site (the gradle-tasks probe)
  // was missed by the original migration — without the wrapper the probe
  // silently returns null on Windows, and KMP modules whose targets come from
  // a convention plugin (so the static parser can't see `jvm("desktop")` /
  // `iosX64()` etc.) report `test_tasks` as null and refuse to dispatch.
  // maxBuffer comes from spawnGradle's choke-point default
  // (resolveMaxBuffer — 64 MB, overridable via KMP_GRADLE_MAXBUFFER_MB).
  const result = spawnGradle(spawnSync, wrapperPath, ['tasks', '--all', '--quiet'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
  });

  if (result.error || result.status !== 0 || !result.stdout) return null;

  try {
    mkdirSync(cacheDir, { recursive: true });
    const tmp = `${cacheFile}.tmp.${process.pid}`;
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, result.stdout); } finally { closeSync(fd); }
    // Bounded EPERM/EBUSY retry (antivirus holding the dest on Windows);
    // unlinks the tmp on final failure so orphans don't accumulate.
    renameWithRetrySync(tmp, cacheFile);
  } catch { /* best-effort persist */ }

  return parseGradleTasksOutput(result.stdout);
}

// Test/diagnostic helper: clear all model-*.json caches under <projectRoot>.
// Also sweeps the legacy `.kmp-test-runner-cache/` dir so a manual reset
// doesn't leave stale v0.7.x caches behind.
export function clearProjectModelCache(projectRoot) {
  for (const dirName of [CACHE_DIR_NAME, LEGACY_CACHE_DIR_NAME]) {
    const cacheDir = path.join(projectRoot, dirName);
    if (!existsSync(cacheDir)) continue;
    let entries;
    try { entries = readdirSync(cacheDir); } catch { continue; }
    for (const name of entries) {
      if (!name.startsWith('model-') || !name.endsWith('.json')) continue;
      try { unlinkSync(path.join(cacheDir, name)); } catch { /* swallow */ }
    }
  }
}

export {
  SCHEMA_VERSION,
  MODEL_FINGERPRINT,
  CACHE_DIR_NAME,
  LEGACY_CACHE_DIR_NAME,
  MAX_BUILD_FILE_DEPTH,
  DEFAULT_PROBE_TIMEOUT_MS,
};

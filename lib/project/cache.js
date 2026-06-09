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
// walkers must produce identical SHAs (cross-platform parity).
//
// All file I/O is sync. Atomic writes use tmp + rename so concurrent runs
// never see a half-written cache file.

import { spawnSync } from 'node:child_process';
import {
  readFileSync, readdirSync, existsSync, mkdirSync,
  openSync, closeSync, writeSync, renameSync, unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawnGradle } from '../orchestrators/orchestrator-utils.js';
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
const SCHEMA_VERSION = 7;
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
// concat(settings.gradle(.kts) + gradle.properties + every build.gradle(.kts)
// at depth ≤ 4 excluding build/ and .gradle/, sorted lexicographically),
// normalize CRLF/LF differences, SHA1 the result. Both the Kotlin (.kts) and
// Groovy (.gradle) script forms are hashed so editing a Groovy build/settings
// file invalidates the cache — purely additive, so a Kotlin-DSL project (no
// .gradle present) hashes byte-identically to before.
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
  for (const f of collectBuildFiles(projectRoot)) {
    try { concat += normalizeForHash(readFileSync(f, 'utf8')); } catch { /* skip */ }
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
    renameSync(tmp, cacheFile);
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

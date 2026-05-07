// SPDX-License-Identifier: MIT
// lib/orchestrator-utils.js — shared helpers for the v0.8 PIVOT orchestrators
// (benchmark / changed / android / coverage / parallel). Centralizes the
// settings.gradle.kts + per-module build.gradle.kts walking that every
// orchestrator needs. Sub-entries 1+2 wired this module; 3-5 follow.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

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
  const re = /include\s*\(\s*"(:[\w\-:]+)"/g;
  for (const m of content.matchAll(re)) out.push(m[1].replace(/^:/, ''));
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
// hoisted to shared util when v0.9 step 1's parallel `--clear-data` parity flag
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
// Concurrency Tier 3 — `--isolated` cache-dir lifecycle (v0.9 step 4)
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
    if (a === '--isolated-no-lock') { noLock = true; continue; }
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
// Module-filter helpers (v0.9 step 9.3 — Bug #3 unified normalization)
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

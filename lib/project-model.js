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

// v0.8 sub-entry 5: schema bump from 1 → 2 to invalidate stale caches that
// don't include the iOS/macOS *Main source-set keys added below. Required for
// the parallel-orchestrator's permissive --test-type ios|macos dispatch on
// Confetti :shared shape (iosMain only, no iosTest yet — gradle still creates
// the *Test task from the target() declaration).
// Bumped 4 → 5 (2026-05-03): analyzeModule now also emits testBuildType
// for Android modules. Old caches don't have this field; fall through
// would default to AGP's debug variant correctly, but the bump
// invalidates so projects with `testBuildType = "release"` get the
// right task name on first run after upgrade.
const SCHEMA_VERSION = 5;
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

// AGP version → minimum runtime JDK. AGP needs this JDK to RUN (regardless of
// the project's bytecode target). Source:
// https://developer.android.com/build/releases/gradle-plugin#compatibility
//
// Until 2026-05-03 the orchestrator only looked at bytecode-target signals
// (`jvmTarget`, `JavaVersion.VERSION_N`, `jvmToolchain`) to pick a JDK. For
// `jvmTarget=11 + AGP 8.x` projects (TaskFlow case) this picked JDK 11 →
// gradle aborted with "Android Gradle plugin requires Java 17 to run". The
// AGP-implied requirement now joins the signal pool so the strictest floor
// wins.
function agpRequiredJdk(versionString) {
  if (!versionString) return null;
  const m = String(versionString).trim().match(/^(\d+)\.(\d+)/);
  if (!m) return null;
  const major = parseInt(m[1], 10);
  if (!Number.isFinite(major)) return null;
  if (major >= 9) return 17; // AGP 9 still requires JDK 17 minimum (alpha as of 2026-05)
  if (major === 8) return 17;
  if (major === 7) return 11;
  if (major === 4) return 8;
  return null;
}

// Detect AGP version from the most common declaration shapes:
//   1. gradle/libs.versions.toml: `agp = "..."`, `android-gradle = "..."`,
//      `androidGradlePlugin = "..."`, `android = "..."` (catalog convention).
//   2. Root build.gradle.kts: `id("com.android.application") version "..."`,
//      `id("com.android.library") version "..."`, plugins DSL forms.
//   3. buildscript dependencies: `"com.android.tools.build:gradle:X.Y.Z"`.
// Returns the version string (e.g. "8.7.3") or null when no AGP detected.
function detectAgpVersion(projectRoot) {
  // 1. Catalog probe — pick the FIRST matching key name. Catalog wins because
  //    it's the canonical version declaration in modern multi-module projects.
  const catalog = path.join(projectRoot, 'gradle', 'libs.versions.toml');
  if (existsSync(catalog)) {
    let content;
    try { content = readFileSync(catalog, 'utf8'); } catch { /* skip */ }
    if (content) {
      const versionsBlock = content.match(/\[versions\][\s\S]*?(?:\n\[|$)/);
      const block = versionsBlock ? versionsBlock[0] : content;
      const agpKeys = ['agp', 'android-gradle', 'android-gradle-plugin', 'androidGradlePlugin', 'android'];
      for (const key of agpKeys) {
        const re = new RegExp(`^\\s*${key.replace(/[-]/g, '[-_]')}\\s*=\\s*"([^"]+)"`, 'm');
        const m = block.match(re);
        if (m && /^\d+\.\d+/.test(m[1])) return m[1];
      }
    }
  }
  // 2. + 3. Walk root + first-level build files for inline version + buildscript.
  const candidates = [
    path.join(projectRoot, 'build.gradle.kts'),
    path.join(projectRoot, 'build.gradle'),
    path.join(projectRoot, 'settings.gradle.kts'),
    path.join(projectRoot, 'buildSrc', 'build.gradle.kts'),
    path.join(projectRoot, 'build-logic', 'build.gradle.kts'),
  ];
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    let content;
    try { content = readFileSync(f, 'utf8'); } catch { continue; }
    // plugins { id("com.android.application") version "X.Y.Z" }
    let m = content.match(/id\s*\(\s*["']com\.android\.(?:application|library|test)["']\s*\)\s*version\s*["']([^"']+)["']/);
    if (m) return m[1];
    // buildscript { dependencies { classpath("com.android.tools.build:gradle:X.Y.Z") } }
    m = content.match(/com\.android\.tools\.build:gradle:([^"'\s)]+)/);
    if (m) return m[1];
  }
  return null;
}

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

// Strip `// line` and `/* block */` comments from Kotlin / Gradle DSL source
// before doing plugin/coverage signal detection. A comment mentioning a
// plugin name ("// TODO: jacoco support") must NOT trigger a signal — only
// real code references should.
//
// Limitation: a `//` substring inside a string literal would be incorrectly
// stripped (e.g. a URL like `"https://..."`). Acceptable for the build-script
// scanning use case — none of our signal regexes (`\bkover\b`, `\bjacoco\b`,
// `\btestCoverageEnabled\b`) appear inside URL-like strings in practice, and
// a precise tokenizer is overkill for this layer.
function stripGradleComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
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
  // Add the AGP-implied runtime JDK requirement to the signal pool. Without
  // this, projects with `jvmTarget=11` AND AGP 8.x get JDK 11 picked, then
  // gradle aborts with "Android Gradle plugin requires Java 17 to run".
  // The strictest signal wins (max), so AGP runtime requirement raises the
  // floor without affecting projects whose bytecode target is already higher.
  const agpVersion = detectAgpVersion(projectRoot);
  const agpJdk = agpRequiredJdk(agpVersion);
  if (agpJdk) {
    signals.push({
      file: 'gradle/libs.versions.toml or build.gradle.kts',
      type: `AGP ${agpVersion} runtime`,
      version: agpJdk,
    });
  }
  let min = null;
  for (const s of signals) {
    if (min === null || s.version > min) min = s.version;
  }
  return { min, signals, agpVersion: agpVersion || null };
}

// Parse settings.gradle.kts for `include(":mod")` declarations.
// Returns canonical `:`-prefixed names (e.g. ':core-encryption').
// Handles include(":foo"), include(':foo'), include ":foo", include ':foo',
// and continued lists like include(":a", ":b").
//
// Comment-stripping fix (2026-05-03 wide-smoke regression): commented-out
// includes were treated as live modules. shared-kmp-libs has
// `// include(":benchmark-android-test")` and was sending gradle a task for
// a non-existent project, causing build abort at resolution. Mirrors the
// same rules as orchestrator-utils.js#stripKotlinComments.
export function parseSettingsIncludes(projectRoot) {
  const file = path.join(projectRoot, 'settings.gradle.kts');
  if (!existsSync(file)) return [];
  let content;
  try { content = readFileSync(file, 'utf8'); } catch { return []; }
  // Strip block comments first, then line comments. The `[^:]` guard on
  // line comments preserves URLs (https://...).
  content = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
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

// Parse `gradle/libs.versions.toml` `[plugins]` section into a
// `Map<dottedKey, pluginId>` where dottedKey matches the consumer's
// `alias(libs.plugins.<dotted-key>)` form. TOML keys may use `-` (the
// canonical TOML convention), but consumers reference them with `.` —
// `android-application` becomes `android.application`. Returns `null`
// when the file is absent (caller falls through to heuristic resolution).
//
// v0.6.x Gap 3 — closes the surface where module-type detection missed
// the version-catalog DSL form. nav3-recipes, large parts of Compose
// Multiplatform, and Confetti modern modules use alias() exclusively;
// pre-fix they all classified as `unknown`.
//
// Tiny regex-based parser — full TOML parsing is overkill for the two
// forms used in practice:
//   table:  key = { id = "plugin-id", version.ref = "..." }
//   string: key = "plugin-id:1.2.3"
// Anything unparseable is silently skipped.
export function parseVersionCatalog(projectRoot) {
  const tomlPath = path.join(projectRoot, 'gradle', 'libs.versions.toml');
  if (!existsSync(tomlPath)) return null;
  let content;
  try { content = readFileSync(tomlPath, 'utf8'); } catch { return null; }

  // Scope to the `[plugins]` section. Walk lines, capture between the
  // `[plugins]` header and the next `[section]` header (or EOF).
  // JS regex lacks a true end-of-input anchor (`\Z` is Perl/Python only),
  // so a lookahead-based one-shot match was unreliable — the line-walk is
  // both shorter and easier to reason about.
  const sectionLines = [];
  let inPlugins = false;
  for (const rawLine of content.split('\n')) {
    const trimmed = rawLine.trim();
    if (/^\[plugins\]\s*$/.test(trimmed)) { inPlugins = true; continue; }
    if (inPlugins && /^\[[^\]]+\]\s*$/.test(trimmed)) { inPlugins = false; }
    if (inPlugins) sectionLines.push(rawLine);
  }
  if (sectionLines.length === 0) return new Map();
  const body = sectionLines.join('\n');

  // Strip line comments (`# ...`) — TOML's only comment form. Comments
  // inside quoted strings aren't a real-world version-catalog pattern;
  // ignore them.
  const stripped = body.split('\n').map(line => {
    const idx = line.indexOf('#');
    return idx >= 0 ? line.slice(0, idx) : line;
  }).join('\n');

  const map = new Map();
  // Table form: key = { id = "...", ... }
  for (const tm of stripped.matchAll(/^([\w\-\.]+)\s*=\s*\{[^}]*?\bid\s*=\s*['"]([^'"]+)['"]/gm)) {
    map.set(tm[1].replace(/-/g, '.'), tm[2]);
  }
  // String form: key = "id:version" (table form wins if both are present).
  for (const sm of stripped.matchAll(/^([\w\-\.]+)\s*=\s*['"]([^:'"]+):[^'"]+['"]/gm)) {
    const k = sm[1].replace(/-/g, '.');
    if (!map.has(k)) map.set(k, sm[2]);
  }
  return map;
}

// Suffix-based fallback when the catalog is missing or doesn't contain
// the alias key. Covers conventional naming (`<namespace>.android.application`,
// `<namespace>.kotlin.multiplatform`, etc.) used by nowinandroid-style
// projects whose plugin keys are namespaced. Returns `null` when no
// suffix matches — caller treats the alias as unresolvable.
const HEURISTIC_PLUGIN_SUFFIXES = [
  ['android.application',  'com.android.application'],
  ['android.library',      'com.android.library'],
  ['android.test',         'com.android.test'],
  ['kotlin.multiplatform', 'org.jetbrains.kotlin.multiplatform'],
  ['kotlin.android',       'org.jetbrains.kotlin.android'],
  ['kotlin.jvm',           'org.jetbrains.kotlin.jvm'],
];

function heuristicResolveAlias(dottedKey) {
  for (const [suffix, pluginId] of HEURISTIC_PLUGIN_SUFFIXES) {
    if (dottedKey === suffix || dottedKey.endsWith('.' + suffix)) return pluginId;
  }
  return null;
}

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
      if (!(e.name.endsWith('.gradle.kts') || e.name.endsWith('.kt'))) continue;
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

// v0.6.x Gap 4: extract per-plugin descriptors from `build-logic/<X>/`
// so `analyzeModule` can decide whether THIS particular consumer module
// applies a coverage-adding convention plugin (vs blanket-inheriting from
// the project-wide hint, which over-predicts on nowinandroid-style setups
// where only some modules apply jacoco).
//
// Two registration patterns are recognized:
//
//   1. `gradlePlugin { plugins { register("<key>") { id = ...; implementationClass = "<Class>" } } }`
//      Found in `build-logic/<X>/build.gradle.kts`. Plugin id is either a
//      literal string or `libs.plugins.<X>.get().pluginId` (resolved via
//      the version catalog). Class name comes from `implementationClass`.
//
//   2. Precompiled-script-plugin: a bare `<plugin-id>.gradle.kts` file
//      under `build-logic/<X>/src/main/kotlin/`. The filename minus
//      `.gradle.kts` IS the plugin id. No class name (treated as filename).
//
// `addsCoverage` is determined by **class-name / filename heuristic** —
// `/Jacoco/i` → 'jacoco', `/Kover/i` → 'kover', else null. We DON'T parse
// the .kt source body for `apply(...)` calls (heuristic-first per the v0.6.x
// plan; class names like `AndroidApplicationJacocoConventionPlugin` are
// intentional and reliable in real-world projects). If a project surfaces
// where the heuristic misses, escalate to source scan in v0.6.2.
//
// Returns Array<{ pluginId, className, addsCoverage }>. Empty when
// build-logic/ is absent or no descriptors are found — `analyzeModule`
// then falls back to the v0.6 broad-inheritance behavior via buildLogicHints.
export function parseBuildLogicPluginDescriptors(projectRoot, catalog = null) {
  const buildLogicDir = path.join(projectRoot, 'build-logic');
  if (!existsSync(buildLogicDir)) return [];
  if (catalog === null) catalog = parseVersionCatalog(projectRoot);

  const descriptors = [];

  // Walk all `*.gradle.kts` under build-logic looking for gradlePlugin{}
  // register{} blocks AND collect precompiled-script filenames under
  // <X>/src/main/kotlin/.
  function walk(dir, depth) {
    if (depth > 8) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(buildLogicDir, full).replace(/\\/g, '/');
      if (e.isFile()) {
        // Precompiled-script-plugin: `<plugin-id>.gradle.kts` under src/main/kotlin/.
        if (e.name.endsWith('.gradle.kts') && /(^|\/)src\/main\/kotlin\//.test(rel)) {
          const pluginId = e.name.replace(/\.gradle\.kts$/, '');
          if (pluginId && !pluginId.includes(' ')) {
            descriptors.push({
              pluginId,
              className: pluginId,
              addsCoverage: classifyCoverageFromName(pluginId),
            });
          }
        } else if (e.name === 'build.gradle.kts') {
          // gradlePlugin{} register{} blocks — top-level build files only.
          let content = '';
          try { content = readFileSync(full, 'utf8'); } catch { continue; }
          const stripped = stripGradleComments(content);
          // Match each `register("...") { ... }` block. `[^}]*?` is OK
          // because real-world register bodies contain only `id = ...` and
          // `implementationClass = ...` — no nested braces.
          for (const reg of stripped.matchAll(/register\s*\([^)]*\)\s*\{([^}]*)\}/g)) {
            const body = reg[1];
            const idMatch = body.match(/\bid\s*=\s*([^\n;]+)/);
            const classMatch = body.match(/implementationClass\s*=\s*['"]([^'"]+)['"]/);
            if (!idMatch || !classMatch) continue;
            const className = classMatch[1];
            const pluginId = resolveDescriptorIdExpr(idMatch[1].trim(), catalog);
            if (!pluginId) continue;
            descriptors.push({
              pluginId,
              className,
              addsCoverage: classifyCoverageFromName(className),
            });
          }
        }
      }
      if (e.isDirectory() && e.name !== 'build' && e.name !== '.gradle' && e.name !== 'node_modules' && e.name !== '.git') {
        walk(full, depth + 1);
      }
    }
  }
  try { walk(buildLogicDir, 0); } catch { /* best-effort */ }

  // Dedup by pluginId — same plugin registered twice (rare) or precompiled
  // script + gradlePlugin{} block referencing the same id.
  const seen = new Set();
  return descriptors.filter(d => {
    if (seen.has(d.pluginId)) return false;
    seen.add(d.pluginId);
    return true;
  });
}

function classifyCoverageFromName(name) {
  if (/jacoco/i.test(name)) return 'jacoco';
  if (/kover/i.test(name)) return 'kover';
  return null;
}

// Resolve a descriptor's `id = <expr>` to a plugin id string. Accepts
// either a literal string ("foo.bar") or `libs.plugins.<X>.get().pluginId`
// (looked up against the version catalog). Returns null when unparseable
// or the catalog entry is missing.
function resolveDescriptorIdExpr(expr, catalog) {
  // Literal string: "foo.bar" or 'foo.bar'
  const lit = expr.match(/^['"]([^'"]+)['"]/);
  if (lit) return lit[1];
  // libs.plugins.<dotted>.get().pluginId
  const cat = expr.match(/^libs\.plugins\.([\w\.]+)\s*\.\s*get\s*\(\s*\)\s*\.\s*pluginId/);
  if (cat) {
    const dotted = cat[1];
    return (catalog && catalog.get(dotted)) || null;
  }
  return null;
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
export function analyzeModule(projectRoot, moduleName, buildLogicHints = null, catalog = null, buildLogicDescriptors = null) {
  const rel = moduleName.replace(/^:/, '').replace(/:/g, path.sep);
  const modulePath = path.join(projectRoot, rel);
  const buildFile = path.join(modulePath, 'build.gradle.kts');
  let content = '';
  try { content = readFileSync(buildFile, 'utf8'); } catch { /* missing or unreadable */ }

  // v0.6.x Gap 3: lazy-load the version catalog when not threaded through
  // from buildProjectModel. Direct test calls (analyzeModule(dir, ':m'))
  // and ad-hoc consumers still get alias resolution this way.
  if (catalog === null) catalog = parseVersionCatalog(projectRoot);

  // v0.6.x Gap 4: lazy-load build-logic descriptors and hints. Same pattern
  // as catalog above — direct test calls work without requiring
  // buildProjectModel as a wrapper.
  if (buildLogicDescriptors === null) {
    buildLogicDescriptors = parseBuildLogicPluginDescriptors(projectRoot, catalog);
  }
  if (buildLogicHints === null) {
    buildLogicHints = detectBuildLogicCoverageHints(projectRoot);
  }

  // Source-set detection — 12 standard directories. JS/Wasm targets
  // (v0.6 Bug 3) added so consumer scripts can decide whether to invoke
  // jsTest / wasmJsTest tasks alongside the JVM-side jvmTest / desktopTest.
  // Compose Multiplatform's `html/` modules and other JS-only KMP projects
  // were previously invisible to the model.
  const sourceSetNames = [
    'test', 'commonTest', 'jvmTest', 'desktopTest',
    'androidUnitTest', 'androidInstrumentedTest', 'androidTest',
    'iosTest', 'nativeTest',
    'jsTest', 'wasmJsTest', 'wasmWasiTest',
    // v0.7.0: iOS-arch-specific + macOS source sets so KMP modules that
    // declare iosX64() / iosSimulatorArm64() / macosArm64() etc. surface
    // their per-target test source sets without falling back to the
    // umbrella `iosTest` / `nativeTest` directories.
    'iosX64Test', 'iosArm64Test', 'iosSimulatorArm64Test',
    'macosTest', 'macosX64Test', 'macosArm64Test',
    // v0.8 sub-entry 5: *Main variants for iOS/macOS target detection. Modules
    // declaring iosX64()/iosSimulatorArm64()/macosArm64() typically have these
    // source-set dirs even before any iosTest/macosTest source set exists.
    // The parallel-orchestrator uses these signals to dispatch the gradle
    // *Test task (created from the target() declaration) rather than skip
    // the module — preserves the legacy wrapper's permissive behavior.
    'iosMain', 'iosX64Main', 'iosArm64Main', 'iosSimulatorArm64Main',
    'macosMain', 'macosX64Main', 'macosArm64Main',
  ];
  // 2026-05-03 — Detect renamed JVM targets: `kotlin { jvm("desktop") {} }`.
  // The runnable test task is `<name>Test` (e.g. `desktopTest`), NOT `jvmTest`.
  // shared-kmp-libs uses this pattern to declare the JVM target as "desktop"
  // alongside an `androidLibrary {}` target. Without this detection, the CLI
  // sees on-disk `jvmTest/` (intermediate hierarchy folder, see below), picks
  // `jvmTest` task, and gradle aborts with `Cannot locate tasks that match
  // ':foo:jvmTest'`. Strip comments first so commented-out `jvm("...")` calls
  // don't surface as phantom targets.
  const codeOnlyForJvm = stripGradleComments(content);
  const namedJvmTargets = [];
  for (const m of codeOnlyForJvm.matchAll(/\bjvm\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!namedJvmTargets.includes(m[1])) namedJvmTargets.push(m[1]);
  }
  // 2026-05-03 — Detect intermediate hierarchy groups created via
  // `applyDefaultHierarchyTemplate { common { group("X") { ... } } }`. These
  // produce `XMain`/`XTest` source sets but NO runnable `XTest` task. The
  // hierarchy is just for sharing code between sibling targets. A `group("jvm")`
  // declaration paired with `jvm("desktop")` is the canonical KMP pattern for
  // android+desktop code-sharing — see shared-kmp-libs core-network-retrofit.
  const intermediateGroups = [];
  const hierarchyBlocks = codeOnlyForJvm.matchAll(/applyDefaultHierarchyTemplate\s*\{([\s\S]*?)\n\s*\}/g);
  for (const block of hierarchyBlocks) {
    for (const gm of block[1].matchAll(/\bgroup\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!intermediateGroups.includes(gm[1])) intermediateGroups.push(gm[1]);
    }
  }
  // Augment the source-set walker with disk dirs implied by named JVM targets,
  // so projects with `jvm("server")` get `serverMain`/`serverTest` registered
  // even though those names aren't in the static sourceSetNames list.
  const augmentedSourceSetNames = [...sourceSetNames];
  for (const name of namedJvmTargets) {
    for (const suffix of ['Main', 'Test']) {
      const ss = `${name}${suffix}`;
      if (!augmentedSourceSetNames.includes(ss)) augmentedSourceSetNames.push(ss);
    }
  }
  const sourceSets = {};
  for (const ss of augmentedSourceSetNames) {
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

  // v0.6.x Gap 3: resolve `alias(libs.plugins.<X>)` references via the
  // version catalog (preferred) or a small suffix heuristic (fallback).
  // Each resolved id participates in the type-classification booleans
  // below alongside the literal `id()` / `kotlin()` forms.
  const aliasPluginIds = [];
  for (const am of content.matchAll(/alias\s*\(\s*libs\.plugins\.([\w\.]+)\s*\)/g)) {
    const dotted = am[1];
    const resolved = (catalog && catalog.get(dotted)) || heuristicResolveAlias(dotted);
    if (resolved) aliasPluginIds.push(resolved);
  }
  const hasKmpViaAlias            = aliasPluginIds.includes('org.jetbrains.kotlin.multiplatform');
  const hasAndroidViaAlias        = aliasPluginIds.some(id => /^com\.android\.(library|application|test)$/.test(id));
  const hasKotlinAndroidViaAlias  = aliasPluginIds.includes('org.jetbrains.kotlin.android');
  const hasJvmKotlinPluginViaAlias = aliasPluginIds.includes('org.jetbrains.kotlin.jvm');

  let type = 'unknown';
  let androidDsl = null;
  if (kmpPluginIdPattern.test(content) || hasAndroidLibraryDsl || hasAndroidTargetCall || hasKmpViaAlias) {
    type = 'kmp';
    if (hasAndroidLibraryDsl) androidDsl = 'androidLibrary';
    else if (hasAndroidTargetCall) androidDsl = 'androidTarget';
  } else if (hasAndroidPlugin || hasKotlinAndroidPlugin || hasAndroidViaAlias || hasKotlinAndroidViaAlias) {
    type = 'android';
  } else if (hasJvmKotlinPlugin || hasJvmKotlinPluginViaAlias) {
    type = 'jvm';
  }

  // Has flavor (drives the connected${Flavor}DebugAndroidTest candidate).
  const hasFlavor = /\bproductFlavors\b/.test(content);

  // Coverage plugin detection. Per-module signal first (most specific),
  // then build-logic project-wide hint (v0.5.2 Gap A — replaces the
  // legacy `detect_coverage_tool` build-logic scan that lived in bash).
  // v0.6 Bug 6 refinement:
  //   - Strip comments before per-module regex check; doc-style comments
  //     that mention jacoco/kover ("// adds jacoco support — see ...")
  //     must NOT raise the signal.
  //   - Only inherit when the build-logic hint is a CONVENTION signal
  //     (consumer-facing plugin); SELF signals (build-logic's own buildscript
  //     using kover/jacoco for self-compilation only) are ignored to avoid
  //     the over-prediction surfaced in nowinandroid.
  const codeOnly = stripGradleComments(content);
  let coveragePlugin = null;
  if (/\bkover\b/.test(codeOnly)) coveragePlugin = 'kover';
  else if (/\bjacoco\b/.test(codeOnly) || /\btestCoverageEnabled\b/.test(codeOnly)) coveragePlugin = 'jacoco';
  else if (buildLogicDescriptors && buildLogicDescriptors.length > 0) {
    // v0.6.x Gap 4: per-module application detection. Only inherit when
    // THIS module's plugins{} block applies a coverage-adding convention
    // plugin (one whose descriptor has addsCoverage='jacoco'|'kover').
    // Pre-fix the buildLogicHints fallback below treated all consumers
    // identically, over-predicting on nowinandroid (35 modules, only ~5-10
    // actually apply jacoco).
    const appliedIds = new Set(aliasPluginIds);
    for (const m of codeOnly.matchAll(/\bid\s*\(?\s*['"]([^'"]+)['"]/g)) appliedIds.add(m[1]);
    for (const m of codeOnly.matchAll(/\bkotlin\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      appliedIds.add(`org.jetbrains.kotlin.${m[1]}`);
    }
    const matched = buildLogicDescriptors.find(d => d.addsCoverage && appliedIds.has(d.pluginId));
    if (matched) coveragePlugin = matched.addsCoverage;
  } else if (buildLogicHints) {
    // Backwards-compat fallback (v0.6.0 broad inheritance). Triggers when
    // descriptor parsing produced nothing — typical of pure Plugin<Project>
    // setups where build-logic has no `gradlePlugin {}` block (like the
    // build-logic-convention-jacoco fixture). Trust the convention-level
    // signal as before.
    if (buildLogicHints.hasKover === 'convention') coveragePlugin = 'kover';
    else if (buildLogicHints.hasJacoco === 'convention') coveragePlugin = 'jacoco';
  }

  // 2026-05-03 — Detect Android `testBuildType` declarations. AGP creates
  // `test${BuildType}UnitTest` tasks based on this property — when set to
  // "release", `testDebugUnitTest` does NOT exist. Repro: dipatternsdemo
  // `:benchmark` declares `testBuildType = benchmarkBuildType` (variable,
  // defaults to "release"). Static literal-string parse only — variable
  // values fall through to the `null` default, which the orchestrator
  // treats as "use the AGP default (debug)".
  let testBuildType = null;
  const tbtMatch = stripGradleComments(content).match(/\btestBuildType\s*=\s*['"]([^'"]+)['"]/);
  if (tbtMatch) testBuildType = tbtMatch[1];

  return { type, androidDsl, hasFlavor, sourceSets, coveragePlugin, namedJvmTargets, intermediateGroups, testBuildType };
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

// v0.8 sub-entry 2 — predict task name from sourceSets when probe is
// unavailable (BACKLOG line 215-244). Walks the same candidate orders
// `resolveTasksFor` uses for the populated branch and returns the first
// candidate whose corresponding source set is `true`. Only meaningful for
// task families where task-name == source-set-name (unitTestTask, webTestTask,
// iosTestTask, macosTestTask). The deviceTestTask candidates are gradle task
// names that do NOT correspond to source-set names (connectedDebugAndroidTest
// vs androidInstrumentedTest), so deviceTestTask prediction is intentionally
// skipped — callers fall back to probe or static defaults.
function predictTaskFromSourceSets(analysis, candidates) {
  if (!analysis || !analysis.sourceSets) return null;
  // 2026-05-03 — JVM-family-only override: trust `kotlin { jvm("name") {} }`
  // declarations. Gradle creates the `<name>Test` task automatically from
  // the target declaration, independent of whether `src/<name>Test/` exists
  // on disk (code typically lives in `commonTest` or the intermediate
  // `jvmTest` source set when a hierarchy template is in play).
  // shared-kmp-libs reproduces this: `core-storage-cache` declares
  // `jvm("desktop")` but only has `jvmTest/` on disk — the runnable task is
  // `:core-storage-cache:desktopTest`, verified via `gradle :tasks --all`.
  // Detect the JVM family by checking if any canonical JVM candidate
  // (`jvmTest`, `desktopTest`, `test`) is in the chain — only then apply
  // the named-target override. Avoids polluting iOS/macOS/web prediction.
  const isJvmChain = candidates.some(c => c === 'jvmTest' || c === 'desktopTest' || c === 'test');
  if (isJvmChain) {
    const namedJvm = analysis.namedJvmTargets || [];
    if (namedJvm.length > 0) {
      const intermediate = new Set(analysis.intermediateGroups || []);
      const pick = namedJvm.find(n => !intermediate.has(n));
      if (pick) return `${pick}Test`;
    }
  }
  // Standard disk-walk chain. Drop candidates that match a declared
  // intermediate hierarchy group (they have source-set folders but no
  // runnable task — `applyDefaultHierarchyTemplate { common { group("jvm")
  // {...} } }` is the canonical KMP shape).
  let effective = candidates;
  const intermediateTasks = (analysis.intermediateGroups || []).map(g => `${g}Test`);
  if (intermediateTasks.length > 0) {
    effective = effective.filter(c => !intermediateTasks.includes(c));
  }
  for (const c of effective) {
    if (analysis.sourceSets[c]) return c;
  }
  return null;
}

// Resolve canonical task names from a per-module gradleTasks[] list.
// Returns { unitTestTask, deviceTestTask, coverageTask, webTestTask } — each
// null when no candidate matched (probe ran but nothing fits) AND no
// fallback applies.
//
// When `gradleTasks` is null (probe didn't run / timed out) but the analysis
// carries a `coveragePlugin` signal, predict the coverage task name via
// `predictCoverageTask` (v0.5.2 Gap A). The script-side coverage selector
// then confirms task existence via the cheap `module_has_task` probe before
// invoking gradle, so a wrong prediction degrades gracefully to a
// `[SKIP coverage]` notice.
//
// v0.6 Bug 3: `unitTestTask` candidates extend with `jsTest`/`wasmJsTest`
// AFTER the JVM candidates so a KMP module with both `jvmTest` and `jsTest`
// still picks `jvmTest` (the expected default). JS-only modules with no
// JVM-side test task now get `unitTestTask: 'jsTest'` instead of null.
// New `webTestTask` field surfaces JS/Wasm test invocation explicitly so
// scripts can run the web side alongside (or instead of) JVM tests without
// inferring intent from `unitTestTask`.
//
// v0.7.0: parallel `iosTestTask` and `macosTestTask` fields surface Apple
// platform test invocation without polluting the `unitTestTask` candidate
// race. iOS task names vary by declared target (iosSimulatorArm64Test on
// Apple-silicon hosts, iosX64Test on Intel hosts/CI, iosArm64Test for
// device runs); macOS likewise picks among macosArm64Test / macosX64Test /
// macosTest. Scripts opt in by reading these fields when they want to
// dispatch to the Apple side.
export function resolveTasksFor(_moduleName, gradleTasks, analysis = null) {
  const predictedCoverage = analysis
    ? predictCoverageTask(analysis.coveragePlugin, analysis.type)
    : null;
  if (!Array.isArray(gradleTasks)) {
    // v0.8 sub-entry 2: predict task names from sourceSets where
    // task-name == source-set-name (unit / web / ios / macos). deviceTestTask
    // candidates are gradle task names (connectedDebugAndroidTest etc.) with
    // no source-set parity, so deviceTestTask stays null when probe missed.
    return {
      unitTestTask:   predictTaskFromSourceSets(analysis, ['desktopTest', 'jvmTest', 'test', 'jsTest', 'wasmJsTest']),
      deviceTestTask: null,
      coverageTask:   predictedCoverage,
      webTestTask:    predictTaskFromSourceSets(analysis, ['jsTest', 'wasmJsTest']),
      iosTestTask:    predictTaskFromSourceSets(analysis, ['iosSimulatorArm64Test', 'iosX64Test', 'iosArm64Test', 'iosTest']),
      macosTestTask:  predictTaskFromSourceSets(analysis, ['macosArm64Test', 'macosX64Test', 'macosTest']),
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
    unitTestTask:   pickFirst(['desktopTest', 'jvmTest', 'test', 'jsTest', 'wasmJsTest']),
    deviceTestTask: pickFirst(['connectedAndroidDeviceTest', 'connectedDebugAndroidTest', 'connectedAndroidTest', 'androidConnectedCheck']),
    coverageTask:   probedCoverage ?? predictedCoverage,
    webTestTask:    pickFirst(['jsTest', 'wasmJsTest']),
    iosTestTask:    pickFirst(['iosSimulatorArm64Test', 'iosX64Test', 'iosArm64Test', 'iosTest']),
    macosTestTask:  pickFirst(['macosArm64Test', 'macosX64Test', 'macosTest']),
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

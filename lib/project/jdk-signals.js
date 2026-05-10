// JDK signal aggregation for project-model.
//
// Walks the project for build scripts (`*.gradle.kts`, `*.kt` in build-logic),
// detects JDK version signals (jvmToolchain, JvmTarget, JavaVersion), and
// adds the AGP-implied runtime JDK requirement to the pool. The strictest
// signal wins.
//
// Extracted from lib/project-model.js in PR-03 (refactor pre-v0.10).
// `findRequiredJdkVersion` in lib/cli.js delegates here via the
// re-export from project-model.js.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

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
export function agpRequiredJdk(versionString) {
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
export function detectAgpVersion(projectRoot) {
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

// Aggregate JDK requirement signals across the project.
// Returns { min, signals, agpVersion, agpIsBinding }.
// `min` is the MAX of all signals (the strictest requirement). `agpIsBinding`
// is true when the AGP-implied runtime requirement is the signal that pinned
// `min` (i.e., AGP raised the floor; jvmToolchain didn't override it). v0.8.0
// fix-PR-B uses this to decide whether the "preserving host JDK" notice fires:
// only when AGP is the BINDING source of the floor — projects that explicitly
// set jvmToolchain higher have already accepted that JDK requirement, so
// preserving the host above it is unsurprising and needs no banner.
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
  // AGP is the binding signal when its implied JDK is exactly the floor.
  // When jvmToolchain raises `min` above `agpJdk`, AGP is no longer binding —
  // the user's explicit jvmToolchain takes ownership of the floor.
  const agpIsBinding = agpJdk !== null && min === agpJdk;
  return { min, signals, agpVersion: agpVersion || null, agpIsBinding };
}

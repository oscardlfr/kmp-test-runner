// SPDX-License-Identifier: MIT
// lib/project/kotlin-dsl.js — Kotlin DSL parsers (extracted from project-model.js).
//
// Pure parsers + filesystem readers for Gradle Kotlin DSL inputs. Used by the
// project-model layer (analyzeModule, buildProjectModel, detectBuildLogicCoverageHints)
// to introspect a KMP / Android Gradle project's surface without spawning gradle.
//
// Functions exported:
//   - stripGradleComments(text) — strip // and /* */ from Kotlin/Gradle source
//   - parseSettingsIncludes(projectRoot) — read settings.gradle.kts, return ":mod" names
//   - parseVersionCatalog(projectRoot) — read gradle/libs.versions.toml [plugins] section
//   - extractAppliedPluginsFromConventionSource(content) — find applied plugin ids
//   - parseBuildLogicPluginDescriptors(projectRoot, catalog) — walk build-logic/
//
// Internal helpers (not exported):
//   - classifyCoverageFromName(name) — class-name → 'jacoco' / 'kover' / null
//   - resolveDescriptorIdExpr(expr, catalog) — resolve id = <expr> to a plugin id

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';


// Resolve a Gradle script by base name, preferring the Kotlin DSL form.
// Returns the `.kts` path when it exists, else the bare Groovy path when it
// exists, else null. Every settings/build reader routes through this so a
// Groovy DSL project (settings.gradle / build.gradle) is read transparently,
// while `.kts` stays canonical when both are present (mixed-DSL projects).
export function resolveGradleFile(dir, baseName) {
  const kts = path.join(dir, `${baseName}.kts`);
  if (existsSync(kts)) return kts;
  const groovy = path.join(dir, baseName);
  if (existsSync(groovy)) return groovy;
  return null;
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
export function stripGradleComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// Parse settings.gradle(.kts) for `include(":mod")` declarations (Kotlin or
// Groovy DSL — the regexes below already cover both quote/paren styles).
// Returns canonical `:`-prefixed names (e.g. ':sample-encryption').
// Handles include(":foo"), include(':foo'), include ":foo", include ':foo',
// and continued lists like include(":a", ":b").
//
// Comment-stripping fix (2026-05-03 wide-smoke regression): commented-out
// includes were treated as live modules. A private KMP project had
// `// include(":bench-android")` commented out and was sending gradle a task for
// a non-existent project, causing build abort at resolution. Mirrors the
// same rules as orchestrator-utils.js#stripKotlinComments.
export function parseSettingsIncludes(projectRoot) {
  const file = resolveGradleFile(projectRoot, 'settings.gradle');
  if (!file) return [];
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

function classifyCoverageFromName(name) {
  if (/jacoco/i.test(name)) return 'jacoco';
  if (/kover/i.test(name)) return 'kover';
  return null;
}

// Resolve a descriptor's `id = <expr>` to a plugin id string. Accepts
// either a literal string ("foo.bar") or `libs.plugins.<X>.get().pluginId`,
// optionally with a `.asProvider()` step before `.get()` (used when a
// catalog parent alias coexists with nested children — NIA's
// `libs.plugins.nowinandroid.android.library.asProvider().get().pluginId`
// vs the children `libs.plugins.nowinandroid.android.library.jacoco.get().pluginId`).
// Returns null when unparseable or the catalog entry is missing.
function resolveDescriptorIdExpr(expr, catalog) {
  // Literal string: "foo.bar" or 'foo.bar'
  const lit = expr.match(/^['"]([^'"]+)['"]/);
  if (lit) return lit[1];
  // libs.plugins.<dotted>[.asProvider()].get().pluginId
  // Non-greedy `+?` lets the optional `.asProvider()` take precedence over
  // capturing it as part of the dotted key.
  const cat = expr.match(/^libs\.plugins\.([\w\.]+?)(?:\s*\.\s*asProvider\s*\(\s*\))?\s*\.\s*get\s*\(\s*\)\s*\.\s*pluginId/);
  if (cat) {
    const dotted = cat[1];
    return (catalog && catalog.get(dotted)) || null;
  }
  return null;
}

// Extract plugin ids that a convention-plugin source file (`.kt` Plugin<Project>
// subclass OR precompiled `.gradle.kts`) activates. Several Kotlin source
// patterns + two precompiled-script patterns are recognized:
//
//   1. `apply(plugin = "literal-id")`        — Kotlin named-arg form (NIA).
//   2. `apply("literal-id")` (positional)     — covers `pluginManager.apply("…")`,
//                                               `target.apply("…")`, and the
//                                               `with(pluginManager) { apply("…") }`
//                                               idiom (private convention-plugin pattern).
//   3. `apply<XxxPlugin>()`                   — Kotlin generic form. Class-name
//                                               → id heuristic: `Jacoco` →
//                                               'jacoco', `Kover` → kover id.
//                                               Other generics ignored (custom
//                                               classes have no canonical id).
//   4. `plugins { id("literal-id") }`         — precompiled-script plugins block.
//   5. `apply { plugin("literal-id") }`       — precompiled-script apply form.
//
// Returns deduped array; empty when nothing matches. Comments are stripped
// first to avoid raising false positives on doc-style references.
export function extractAppliedPluginsFromConventionSource(content) {
  if (!content) return [];
  const stripped = stripGradleComments(content);
  const out = new Set();
  // 1. `apply(plugin = "literal-id")` — must run before regex 2 because
  // regex 2's positional pattern would only match `apply("literal")` (no
  // `plugin =` prefix); they're disjoint, but explicit ordering is clearer.
  for (const m of stripped.matchAll(/\bapply\s*\(\s*plugin\s*=\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.add(m[1]);
  }
  // 2. Positional `apply("literal-id")` — catches `pluginManager.apply("…")`,
  // `target.apply("…")`, and `with(pluginManager) { apply("…") }` since the
  // `apply("string")` substring is the same in all three.
  for (const m of stripped.matchAll(/\bapply\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.add(m[1]);
  }
  // 3. Kotlin generic `apply<XxxPlugin>()`. Map class basename → canonical id
  // for the two Gradle plugins seen in the wild (jacoco, kover); ignore
  // project-internal generics that have no canonical id.
  for (const m of stripped.matchAll(/\bapply\s*<\s*([A-Z][\w]*?)Plugin\s*>\s*\(\s*\)/g)) {
    const baseName = m[1];
    if (/^Jacoco$/.test(baseName)) out.add('jacoco');
    else if (/^Kover$/.test(baseName)) out.add('org.jetbrains.kotlinx.kover');
  }
  // 4. Precompiled-script `plugins { id("…") }` (Kotlin) and `plugins { id '…' }`
  // (Groovy) — parens optional. Bare `id = …` still does not match: the `=`
  // sits before the quote, so the `['"]`-immediately-after requirement keeps
  // `register() { id = … }` blocks out.
  for (const m of stripped.matchAll(/\bid\s*\(?\s*['"]([^'"]+)['"]/g)) {
    out.add(m[1]);
  }
  // 5. `apply { plugin("…") }` precompiled-script apply form.
  for (const m of stripped.matchAll(/\bplugin\s*\(\s*['"]([^'"]+)['"]/g)) {
    out.add(m[1]);
  }
  // 6. Groovy `apply plugin: '…'` — the colon form used by Groovy convention
  // scripts. No parens; disjoint from the Kotlin `apply(...)` forms (#1/#2).
  for (const m of stripped.matchAll(/\bapply\s+plugin\s*:\s*['"]([^'"]+)['"]/g)) {
    out.add(m[1]);
  }
  return Array.from(out);
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
// `addsCoverage` is determined by class-name / filename heuristic FIRST
// (`/Jacoco/i` → 'jacoco', `/Kover/i` → 'kover'), then refined post-walk
// from `appliedPlugins` extracted from the `.kt` source. So a convention
// plugin named neutrally (e.g. `KmpLibraryConventionPlugin` that calls
// `pluginManager.apply("org.jetbrains.kotlinx.kover")` internally) still
// surfaces `addsCoverage: 'kover'`.
//
// `appliedPlugins[]` records which plugin ids
// the convention plugin's `apply()` body activates. Three Kotlin source
// patterns are extracted:
//   - `apply(plugin = "literal-id")` (NIA pattern)
//   - `pluginManager.apply("literal-id")` (convention-plugin pattern)
//   - `apply<JacocoPlugin>()` / `apply<KoverPlugin>()` (Kotlin generic form)
// Plus precompiled-script `plugins { id("...") }` and `apply { plugin("...") }`
// blocks for the `.gradle.kts` form.
//
// `analyzeModule` uses `appliedPlugins[]` to expand a non-canonical alias
// (e.g. NIA's `nowinandroid.android.library` → `["com.android.library", ...]`)
// so the canonical-id type checks fire. Without this expansion, modules
// that apply plugins ONLY via custom convention plugin aliases get
// classified as `type='unknown'`.
//
// Returns Array<{ pluginId, className, addsCoverage, appliedPlugins }>.
// Empty when build-logic/ is absent or no descriptors are found —
// `analyzeModule` then falls back to v0.6 broad-inheritance via buildLogicHints.
export function parseBuildLogicPluginDescriptors(projectRoot, catalog = null) {
  const buildLogicDir = path.join(projectRoot, 'build-logic');
  if (!existsSync(buildLogicDir)) return [];
  if (catalog === null) catalog = parseVersionCatalog(projectRoot);

  const descriptors = [];
  // className → string[] of plugin ids the class's apply() body activates.
  // Populated by walking *.kt files under <X>/src/main/kotlin/. After the
  // walk completes, descriptors that were sourced from a register() block
  // get their `appliedPlugins` resolved by basename match.
  const kotlinSourceApplies = new Map();

  // Walk `*.gradle.kts` / `*.gradle` / `*.kt` under build-logic looking for:
  //   - precompiled-script plugins (`<id>.gradle.kts` under src/main/kotlin/,
  //     or `<id>.gradle` under src/main/groovy/)
  //   - gradlePlugin{} register{} blocks in `build.gradle(.kts)` files
  //   - Kotlin Plugin<Project> subclasses under src/main/kotlin/ (.kt files)
  function walk(dir, depth) {
    if (depth > 8) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(buildLogicDir, full).replace(/\\/g, '/');
      if (e.isFile()) {
        // Precompiled-script-plugin: `<plugin-id>.gradle.kts` under src/main/kotlin/
        // (Kotlin) or `<plugin-id>.gradle` under src/main/groovy/ (Groovy).
        const isPrecompiledScript =
          (e.name.endsWith('.gradle.kts') && /(^|\/)src\/main\/kotlin\//.test(rel)) ||
          (e.name.endsWith('.gradle') && /(^|\/)src\/main\/groovy\//.test(rel));
        if (isPrecompiledScript) {
          const pluginId = e.name.replace(/\.gradle(\.kts)?$/, '');
          if (pluginId && !pluginId.includes(' ')) {
            let content = '';
            try { content = readFileSync(full, 'utf8'); } catch {}
            const applied = extractAppliedPluginsFromConventionSource(content);
            descriptors.push({
              pluginId,
              className: pluginId,
              addsCoverage: classifyCoverageFromName(pluginId),
              appliedPlugins: applied,
            });
          }
        } else if (e.name.endsWith('.kt') && /(^|\/)src\/main\/kotlin\//.test(rel) && !/\/build\//.test(rel)) {
          // Kotlin Plugin<Project> source — collect applied plugins by class basename.
          const className = e.name.replace(/\.kt$/, '');
          let content = '';
          try { content = readFileSync(full, 'utf8'); } catch { continue; }
          const applied = extractAppliedPluginsFromConventionSource(content);
          if (applied.length > 0) kotlinSourceApplies.set(className, applied);
        } else if (e.name === 'build.gradle.kts' || e.name === 'build.gradle') {
          // gradlePlugin{} register{} blocks — top-level build files only
          // (Kotlin build.gradle.kts or Groovy build.gradle).
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
              // Resolved post-walk from kotlinSourceApplies map.
              appliedPlugins: [],
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

  // Resolve each register()-sourced descriptor's `appliedPlugins` from the
  // matching `.kt` file. Refine `addsCoverage` from applied plugins when the
  // class-name heuristic missed (e.g. a neutrally-named
  // `KmpLibraryConventionPlugin` applies kover but no "Kover" in the name).
  for (const d of descriptors) {
    if (d.appliedPlugins.length === 0 && kotlinSourceApplies.has(d.className)) {
      d.appliedPlugins = kotlinSourceApplies.get(d.className);
    }
    if (!d.addsCoverage && d.appliedPlugins.length > 0) {
      if (d.appliedPlugins.includes('jacoco')) d.addsCoverage = 'jacoco';
      else if (d.appliedPlugins.includes('org.jetbrains.kotlinx.kover')) d.addsCoverage = 'kover';
    }
  }

  // Dedup by pluginId — same plugin registered twice (rare) or precompiled
  // script + gradlePlugin{} block referencing the same id.
  const seen = new Set();
  return descriptors.filter(d => {
    if (seen.has(d.pluginId)) return false;
    seen.add(d.pluginId);
    return true;
  });
}

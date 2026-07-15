// SPDX-License-Identifier: MIT
// lib/project/kotlin-dsl.js — Kotlin DSL parsers (extracted from project-model.js).
//
// Pure parsers + filesystem readers for Gradle Kotlin DSL inputs. Used by the
// project-model layer (analyzeModule, buildProjectModel, detectBuildLogicCoverageHints)
// to introspect a KMP / Android Gradle project's surface without spawning gradle.
//
// Functions exported:
//   - stripGradleComments(text) — strip // and /* */ from Kotlin/Gradle source, preserving
//     string-literal content byte-for-byte (quote-aware, PR-28d)
//   - stripGradleCommentsAndStrings(text) — same comment-stripping, PLUS blanks string-literal
//     content (used only where a signal-shaped substring inside a string must never be mistaken
//     for live code — see aggregateJdkSignals in jdk-signals.js)
//   - extractIncludeModuleNames(content) — parse bare module names from stripped settings content
//   - parseSettingsIncludes(projectRoot) — read settings.gradle.kts, return ":mod" names
//   - parseVersionCatalog(projectRoot) — read gradle/libs.versions.toml [plugins] section
//   - extractAppliedPluginsFromConventionSource(content) — find applied plugin ids
//   - parseBuildLogicPluginDescriptors(projectRoot, catalog) — walk build-logic/
//
// Internal helpers (not exported):
//   - stripGradleSource(s, opts) — shared quote/comment-aware scanner behind both
//     stripGradleComments and stripGradleCommentsAndStrings
//   - scanToClosingParen(src, pos) — balanced-paren scanner with quote awareness
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


// Single-pass quote-and-comment-aware scanner shared by `stripGradleComments` and
// `stripGradleCommentsAndStrings`. Tracks: normal code / `//` line comment / `/* */` block
// comment / quoted string (single `'...'`, double `"..."`, or Kotlin triple-quoted raw
// `"""..."""`). Never throws.
//
// Fixes two bugs the prior two-independent-regex-pass implementation had, both stemming from
// zero string-literal awareness:
//   1. OVER-stripping: a `//`/`/*`-shaped substring INSIDE a string literal (e.g. a URL like
//      `"https://..."`) was wrongly treated as starting a real comment, silently eating real
//      trailing code on the same line.
//   2. UNDER-stripping (PR-28d): a signal-shaped substring INSIDE a string literal (e.g.
//      `println("jvmToolchain(21)")`) is not a comment, so it was correctly left untouched by
//      stripGradleComments — but a caller that regex-scans the stripped output for live
//      signals (aggregateJdkSignals's JDK_PATTERNS) then wrongly matched it as real code.
//
// opts.blankStrings selects the behavior:
//   - false (stripGradleComments): comments removed; string content copied through
//     BYTE-FOR-BYTE IDENTICAL to input. Only inputs where a `//`/`/*`-shaped substring sits
//     inside a string literal produce different output than the old regex-based
//     implementation — a pure bug fix (bug 1 above). None of the other 4 call sites'
//     plugin-id/coverage-tool/class-name regexes can contain `//`/`/*` (not legal in a Gradle
//     plugin id or Kotlin identifier), so none of them regress.
//   - true (stripGradleCommentsAndStrings): comments removed AND string-literal CONTENT is
//     also blanked (quote delimiters are kept, so code on either side of a blanked string can
//     never become falsely adjacent). Use ONLY where a signal-shaped substring inside a string
//     must never be mistaken for live code — currently just aggregateJdkSignals's build-script
//     walk, where a real jvmToolchain/JvmTarget/JavaVersion signal is always bare Kotlin/Groovy
//     DSL code, never a legitimate string literal.
//
// Deliberate, documented scope decisions (do not "fix" without re-reading this note):
//   - Block comments do not nest. Kotlin's real grammar allows `/* /* ... */ ... */`, but the
//     prior regex didn't support it either, and nested block comments do not occur in
//     real-world Gradle build scripts.
//   - Multi-line block comments collapse with no newline preserved — matches the prior regex
//     (`/\*[\s\S]*?\*\//g`, where `[\s\S]` matches newlines too).
//   - An unterminated `/* ...` (no closing `*/` anywhere in the rest of the file) is swallowed
//     to EOF and NOTHING is copied back to the output — the contract is "comments are
//     removed," and copying an unclosed comment's tail back would re-expose any signal-shaped
//     text inside it as if it were live code. This deliberately does NOT byte-match the old
//     regex (which left an unterminated `/* ...` completely untouched, since the regex simply
//     fails to match without a closing `*/`) — an unterminated block comment is a syntax error
//     Gradle itself would refuse to build, so "swallow to EOF" is the safe, contract-honoring
//     choice, not "replay whatever the legacy regex happened to do here."
//   - An unterminated quoted string (`'`, `"`, or `"""` with no closing delimiter before EOF)
//     also consumes to EOF, matching `scanToClosingParen`'s existing convention. Unlike an
//     unterminated comment, this is safe to preserve/blank per the normal per-mode rule (a
//     string's content was always going to survive stripGradleComments intact, or always going
//     to be blanked by stripGradleCommentsAndStrings, regardless of whether it terminates).
//   - Single-quote strings are treated as Groovy-style spans (not Kotlin Char literals), the
//     same simplification `scanToClosingParen` below already makes — real Gradle Kotlin DSL
//     scripts don't contain bare Char literals, only Groovy single-quoted strings.
//   - Triple-quoted raw strings get NO escape processing — a defining property of real Kotlin
//     raw strings (backslash is a literal character inside them), not an implementation
//     shortcut.
function stripGradleSource(s, opts) {
  const blankStrings = !!(opts && opts.blankStrings);
  const len = s.length;
  let i = 0;
  let out = '';
  while (i < len) {
    const ch = s[i];

    // `//` line comment — drop through end of line (the newline itself is left for the next
    // iteration to copy through as ordinary code).
    if (ch === '/' && s[i + 1] === '/') {
      i += 2;
      while (i < len && s[i] !== '\n') i++;
      continue;
    }

    // `/* */` block comment.
    if (ch === '/' && s[i + 1] === '*') {
      const closeIdx = s.indexOf('*/', i + 2);
      // Unterminated — swallow the rest of the file as inert comment and do NOT copy it back
      // to `out`. See the design note above for why this deliberately does not byte-match the
      // old regex's incidental behavior on malformed input.
      if (closeIdx === -1) break;
      i = closeIdx + 2; // drop the whole span, including embedded newlines
      continue;
    }

    // Kotlin raw string `"""..."""` — MUST be checked before the plain single-`"` case below,
    // or the first two `"` of `"""` get misread as an empty `""` string, desynchronizing the
    // scanner against any quote embedded in the real raw-string content. No escape processing.
    if (ch === '"' && s[i + 1] === '"' && s[i + 2] === '"') {
      out += '"""';
      i += 3;
      const start = i;
      const endIdx = s.indexOf('"""', i);
      const contentEnd = endIdx === -1 ? len : endIdx;
      // Blank mode pads with equal-length spaces rather than deleting content outright — see
      // the single/double-quote branch below for why.
      if (blankStrings) out += ' '.repeat(contentEnd - start);
      else out += s.slice(start, contentEnd);
      if (endIdx === -1) { i = len; break; } // unterminated — content already preserved/blanked above
      out += '"""';
      i = endIdx + 3;
      continue;
    }

    // Single- or double-quoted string, with backslash-escape skipping — same algorithm as
    // scanToClosingParen below, so both quote-aware scanners in this file agree on escapes.
    if (ch === '"' || ch === "'") {
      const q = ch;
      out += q; // opening delimiter always kept, both modes
      i++;
      const start = i;
      while (i < len && s[i] !== q) {
        if (s[i] === '\\') i++; // skip escaped char (incl. escaped quote)
        i++;
      }
      // Blank mode replaces content with equal-length spaces rather than deleting it — not
      // load-bearing for the current JDK_PATTERNS regexes (all require adjacent parens/dots a
      // bare space can't fake), but keeps output length/shape predictable and defends against
      // any future regex accidentally bridging two blanked spans into a new false match.
      if (blankStrings) out += ' '.repeat(i - start);
      else out += s.slice(start, i);
      if (i < len) { out += q; i++; } // closing delimiter; absent when unterminated
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

// Strip `// line` and `/* block */` comments from Kotlin / Gradle DSL source
// before doing plugin/coverage signal detection. A comment mentioning a
// plugin name ("// TODO: jacoco support") must NOT trigger a signal — only
// real code references should. Quote-aware (PR-28d): string-literal content
// is copied through byte-for-byte unchanged, so a `//`/`/*`-shaped substring
// inside a string (e.g. a URL like `"https://..."`) is no longer mistaken
// for a real comment. See `stripGradleSource` above for the full design note.
export function stripGradleComments(s) {
  return stripGradleSource(s, { blankStrings: false });
}

// Same comment-stripping as `stripGradleComments`, PLUS string-literal
// CONTENT is blanked (quote delimiters are kept — see design note above).
// Use this ONLY when a signal-shaped substring inside a string literal must
// never be mistaken for a live code declaration — currently just
// `aggregateJdkSignals`'s build-script walk in jdk-signals.js, where a real
// `jvmToolchain(17)` / `JvmTarget.JVM_17` / `JavaVersion.VERSION_17` signal
// is always Kotlin/Groovy DSL CODE (a function call / enum-constant
// reference), never legitimately written as a quoted string literal in a
// working build script — so blanking string content can only remove phantom
// signals, never a real one. Every OTHER stripGradleComments caller
// (plugin-id / coverage-tool / class-name detection) must keep using
// `stripGradleComments` instead — those names legitimately live inside
// string literals.
export function stripGradleCommentsAndStrings(s) {
  return stripGradleSource(s, { blankStrings: true });
}

// Walk from `pos` (pointing at `(`) to the matching `)`, respecting single-
// and double-quoted strings so a `)` inside a string literal is never treated
// as the closing paren. Escaped quote characters (`\'`, `\"`) inside a string
// are skipped so they cannot prematurely end the string scan.
// Returns { inner, nextPos } where `inner` is the text between `(` and `)`,
// and `nextPos` is the index of the character after the closing `)`.
function scanToClosingParen(src, pos) {
  let i = pos + 1; // skip opening '('
  let depth = 1;
  const len = src.length;
  while (i < len && depth > 0) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      i++;
      while (i < len && src[i] !== q) {
        if (src[i] === '\\') i++; // skip escaped character
        i++;
      }
      i++; // skip closing quote
    } else if (ch === '(') {
      depth++;
      i++;
    } else if (ch === ')') {
      depth--;
      i++;
    } else {
      i++;
    }
  }
  return { inner: src.slice(pos + 1, i - 1), nextPos: i };
}

// Extract bare module names (no leading colon) from already-comment-stripped
// settings.gradle(.kts) content. Handles both Kotlin DSL parenthesized forms
// (single-line and multiline) and Groovy DSL bare forms (including trailing-
// comma line continuation). Caller is responsible for stripping comments before
// passing content here; this function performs no comment stripping itself.
//
// Returns a deduplicated array in first-seen order.
//
// Two mutually exclusive passes:
//   Pass 1 — parenthesized form: `include(...)`, possibly multiline.
//     Finds each `include` keyword, checks whether `(` follows, and invokes
//     scanToClosingParen for a balanced-paren + quote-aware extraction.
//   Pass 2 — bare Groovy form: `include ':a', ':b'` without parens.
//     The negative lookahead (?!\s*\() ensures no overlap with pass 1.
//     The continuation clause matches subsequent lines that begin with
//     horizontal whitespace + quote + colon — the shape of a Groovy module
//     string — and stops before unrelated lines.
export function extractIncludeModuleNames(content) {
  const seen = new Set();
  const out = [];
  function add(name) { if (!seen.has(name)) { seen.add(name); out.push(name); } }

  // Both passes use an alternation regex that matches string literals before
  // \binclude\b so that include(...) appearing inside a string value is never
  // mistaken for a module declaration.  When the left branch (group 1) fires the
  // match is a string literal and we skip it; when it doesn't fire we have an
  // include keyword outside any string.
  const STR = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/;

  // Pass 1: parenthesized include(...), possibly multiline.
  // Uses exec + lastIndex so we can jump past the closing ) after each block,
  // which also prevents re-processing include keywords found inside the block.
  const p1Re = new RegExp(STR.source + /|\binclude\b/.source, 'g');
  let m1;
  while ((m1 = p1Re.exec(content)) !== null) {
    if (m1[1] !== undefined) continue; // string literal — skip
    let j = m1.index + m1[0].length;
    while (j < content.length && (content[j] === ' ' || content[j] === '\t')) j++;
    if (content[j] !== '(') continue; // bare form — handled by pass 2
    const { inner, nextPos } = scanToClosingParen(content, j);
    p1Re.lastIndex = nextPos; // jump past the closing paren
    for (const im of inner.matchAll(/['"]:([\w\-:]+)['"]/g)) add(im[1]);
  }

  // Pass 2: bare Groovy form — include ':a', ':b' (no parens).
  // Continuation lines must start with horizontal whitespace + quote + colon
  // to avoid swallowing unrelated subsequent lines.
  const p2Re = new RegExp(STR.source + /|\binclude\b(?!\s*\()[ \t]*([^\n]+(?:\n[ \t]+['"]:[^\n]*)*)/.source, 'g');
  for (const bm of content.matchAll(p2Re)) {
    if (bm[1] !== undefined) continue; // string literal — skip
    if (!bm[2]) continue;
    for (const im of bm[2].matchAll(/['"]:([\w\-:]+)['"]/g)) add(im[1]);
  }

  return out;
}

// Parse settings.gradle(.kts) for `include(":mod")` declarations (Kotlin or
// Groovy DSL). Returns canonical `:`-prefixed names (e.g. ':sample-encryption'),
// deduplicated and sorted alphabetically. Handles single-line and multiline
// parenthesized forms as well as Groovy bare `include ':a', ':b'` with optional
// trailing-comma line continuation.
//
// Comment-stripping fix (2026-05-03 wide-smoke regression): commented-out
// includes were treated as live modules, causing build aborts on non-existent
// projects. Comments are stripped here before delegating to
// extractIncludeModuleNames, which expects already-stripped content.
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
  return extractIncludeModuleNames(content).map(n => `:${n}`).sort();
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

// SPDX-License-Identifier: MIT
// lib/describe-orchestrator.js — Node-side `kmp-test describe` orchestrator (v0.9 step 3).
//
// Mirrors `android describe` from Google's android CLI — emits project metadata
// as a single JSON document WITHOUT running anything. Designed for agents that
// need to enumerate the test surface (modules, per-module test tasks, coverage
// tool, dependency graph) before deciding what to run.
//
// Reuses `buildProjectModel` from lib/project-model.js — the same source of
// truth `parallel`, `android`, `benchmark`, `coverage` use for module discovery
// and task resolution. Reshapes its schema-7 output into a stable describe
// envelope that omits the standard `tests`/`errors`/`warnings` blocks (no
// execution to report).

import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

import {
  buildJsonReport,
  envErrorJson,
  EXIT,
  parseGradleTimeoutMs,
} from './cli.js';
import { buildProjectModel } from './project-model.js';

// Argparse for describe-specific flags.
//
// Globals consumed upstream by cli.js (--json, --dry-run, --force, --no-jdk-
// autoselect) are already stripped. Globals that are *looked up* but not
// spliced (--project-root, --java-home, --ignore-jdk-mismatch, --no-adb)
// remain in argv — we skip them explicitly so their values don't bind as
// positionals (Drift #5 below).
//
// v0.9 wet-audit drift #5 (PR #168): a positional argument now binds to
// --module-filter as a shorthand. Pre-fix, `kmp-test describe :core-result`
// silently dropped the positional and returned the unfiltered set, hiding
// the usage mistake. Post-fix, that command behaves identically to
// `kmp-test describe --module-filter :core-result`. Extra positionals
// after the first warn on stderr and are ignored.
const GLOBAL_VALUE_FLAGS = new Set(['--project-root', '--java-home']);
const GLOBAL_BOOL_FLAGS = new Set(['--ignore-jdk-mismatch', '--no-adb']);

function parseArgs(argv) {
  const out = {
    moduleFilter: '',  // regex source string; empty = all modules
    skipProbe: false,
    noCache: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--module-filter') { out.moduleFilter = argv[++i] || ''; continue; }
    if (a === '--skip-probe')    { out.skipProbe = true; continue; }
    if (a === '--no-cache')      { out.noCache = true; continue; }
    if (GLOBAL_VALUE_FLAGS.has(a)) { i++; continue; }
    if (GLOBAL_BOOL_FLAGS.has(a))  { continue; }

    if (typeof a === 'string' && !a.startsWith('--')) {
      if (!out.moduleFilter) { out.moduleFilter = a; continue; }
      process.stderr.write(
        `kmp-test describe: ignoring extra positional '${a}' (already bound --module-filter '${out.moduleFilter}')\n`,
      );
      continue;
    }

    // Unknown --flag — drop silently (preserves prior behavior).
  }
  return out;
}

// Walk settings.gradle.kts for `includeBuild("path")` calls. Returns the list
// of paths in declaration order; empty when no composite builds.
//
// settings.gradle.kts shape examples (both supported):
//   includeBuild("../shared-kmp-libs")
//   includeBuild "../shared-kmp-libs"      // groovy-style
function discoverCompositeBuilds(projectRoot) {
  const candidates = ['settings.gradle.kts', 'settings.gradle'];
  for (const name of candidates) {
    const p = path.join(projectRoot, name);
    if (!existsSync(p)) continue;
    let content;
    try { content = readFileSync(p, 'utf8'); } catch { continue; }
    const out = [];
    const matches = content.matchAll(/\bincludeBuild\s*[\s(]\s*["']([^"']+)["']/g);
    for (const m of matches) out.push(m[1]);
    return out;
  }
  return [];
}

// Derive the platform list a module supports.
//
// Sources (merged + deduped, fixed ordering jvm/android/ios/macos/js/wasmJs):
//   1. **Static signals** — source-set names + plugin/DSL evidence on disk.
//      Cheap, works without gradle probe, but undercounts when convention
//      plugins emit targets without leaving visible source-set dirs.
//   2. **Probed gradle tasks** — when `gradleTasks` is provided (populated
//      by `probeGradleTasksCached` in project-model), task names map back
//      to platforms. Closes the static-only gap on convention-driven KMP
//      modules (v0.9 step 9.4 — Bug #4 — `shared-kmp-libs :core-result`
//      reported `["android"]` despite gradle exposing
//      `desktopTest`/`iosSimulatorArm64Test`/`macosArm64Test`).
//
// `gradleTasks` is optional. When null/undefined, falls through to the
// pre-fix static-only behavior — preserves describe `--skip-probe` semantics
// (cheap, offline) and honors test fixtures with no gradle integration.
function platformsFromAnalysis(analysis, gradleTasks = null) {
  if (!analysis) return [];
  const ss = analysis.sourceSets || {};
  const set = new Set();
  // Static signals (fast path).
  if (ss.jvmMain || ss.desktopMain || analysis.type === 'jvm' || analysis.hasDefaultJvm) set.add('jvm');
  if (ss.androidMain || ss.androidUnitTest || ss.androidInstrumentedTest ||
      analysis.type === 'android' || analysis.androidDsl) set.add('android');
  if (ss.iosMain || ss.iosX64Main || ss.iosArm64Main || ss.iosSimulatorArm64Main ||
      ss.iosTest || ss.iosX64Test || ss.iosArm64Test || ss.iosSimulatorArm64Test) set.add('ios');
  if (ss.macosMain || ss.macosArm64Main || ss.macosX64Main ||
      ss.macosTest || ss.macosArm64Test || ss.macosX64Test) set.add('macos');
  if (ss.jsMain || ss.jsTest) set.add('js');
  if (ss.wasmJsMain || ss.wasmJsTest) set.add('wasmJs');

  // Probed signals (Bug #4 fix). Conservative regex match — only accepts
  // canonical KMP/AGP test task names, not arbitrary user-defined tasks.
  if (Array.isArray(gradleTasks)) {
    for (const t of gradleTasks) {
      if (!t || typeof t !== 'string') continue;
      const name = t.replace(/^:[^:]+:/, '');  // strip module prefix if present
      if (/^(jvm|desktop)Test$/.test(name)) set.add('jvm');
      else if (/^test(Debug|Release|[A-Z]\w+(Debug|Release))?(Unit|Android(Host|Device))Test$/.test(name)
               || /^connected(Debug|Release|[A-Z]\w+)?(Android)?(Test|Check)$/.test(name)
               || /^androidConnectedCheck$/.test(name)) set.add('android');
      else if (/^ios(X64|Arm64|SimulatorArm64)?Test$/.test(name)) set.add('ios');
      else if (/^macos(X64|Arm64)?Test$/.test(name)) set.add('macos');
      else if (/^jsTest$/.test(name)) set.add('js');
      else if (/^wasmJsTest$/.test(name)) set.add('wasmJs');
    }
  }

  const out = [];
  for (const p of ['jvm', 'android', 'ios', 'macos', 'js', 'wasmJs']) {
    if (set.has(p)) out.push(p);
  }
  if (set.size === 0 && ss.commonMain && analysis.type === 'kmp') {
    // KMP module declared but no concrete target detected — surface 'common'.
    out.push('common');
  }
  return out;
}

// Aggregate the per-module coverage_plugin into a project-wide tool tag.
// 'mixed' fires when modules disagree (some kover, some jacoco). 'none' when
// no module declares either.
function aggregateCoverageTool(modules) {
  const tools = new Set();
  for (const m of modules) {
    if (m.coverage_plugin) tools.add(m.coverage_plugin);
  }
  if (tools.size === 0) return 'none';
  if (tools.size === 1) return Array.from(tools)[0];
  return 'mixed';
}

// Build the per-module entry for the describe envelope. Conservatively maps
// the canonical project-model fields to user-facing names.
function buildModuleEntry(modKey, entry) {
  const name = modKey.replace(/^:/, '');
  const r = entry.resolved || {};
  return {
    name: modKey,
    path: name.replace(/:/g, '/'),
    type: entry.type ?? null,
    // v0.9 step 9.4 (Bug #4) — pass `entry.gradleTasks` so platforms[] is
    // augmented from probed task names when probe ran. Static-only fallback
    // when gradleTasks is null (cache miss / --skip-probe).
    platforms: platformsFromAnalysis(entry, entry.gradleTasks),
    test_tasks: {
      unit:   r.unitTestTask  ?? null,
      device: r.deviceTestTask ?? null,
      web:    r.webTestTask   ?? null,
      ios:    r.iosTestTask   ?? null,
      macos:  r.macosTestTask ?? null,
    },
    coverage_task:   r.coverageTask ?? null,
    coverage_plugin: entry.coveragePlugin ?? null,
    test_build_type: entry.testBuildType ?? null,
    has_flavor: !!entry.hasFlavor,
    android_dsl: entry.androidDsl ?? null,
    android_dsl_variant: entry.androidDslVariant ?? null,
  };
}

// Main entrypoint — invoked by lib/cli.js#main() on `kmp-test describe`.
export function runDescribe({
  projectRoot = process.cwd(),
  args = [],
  env = process.env,
} = {}) {
  const startTime = Date.now();
  const opts = parseArgs(args);
  const root = path.resolve(projectRoot);

  // Reject early if the project root has no settings or build script.
  const hasSettings = existsSync(path.join(root, 'settings.gradle.kts')) ||
                      existsSync(path.join(root, 'settings.gradle'));
  const hasBuild = existsSync(path.join(root, 'build.gradle.kts')) ||
                   existsSync(path.join(root, 'build.gradle'));
  if (!hasSettings && !hasBuild) {
    const msg = `[ERROR] No settings.gradle.kts or build.gradle.kts in ${root}`;
    const envelope = envErrorJson({
      subcommand: 'describe',
      projectRoot: root,
      durationMs: Date.now() - startTime,
      message: msg,
      code: 'no_project',
    });
    return { envelope, exitCode: EXIT.CONFIG_ERROR };
  }

  let model = null;
  try {
    model = buildProjectModel(root, {
      skipProbe: opts.skipProbe,
      useCache: !opts.noCache,
      probeTimeoutMs: parseGradleTimeoutMs(env.KMP_GRADLE_TIMEOUT_MS),
    });
  } catch (err) {
    const envelope = envErrorJson({
      subcommand: 'describe',
      projectRoot: root,
      durationMs: Date.now() - startTime,
      message: `[ERROR] buildProjectModel failed: ${err && err.message}`,
      code: 'project_model_failed',
    });
    return { envelope, exitCode: EXIT.ENV_ERROR };
  }

  // Reshape modules from project-model schema → describe envelope.
  let moduleEntries = [];
  if (model && model.modules) {
    moduleEntries = Object.entries(model.modules).map(([k, v]) => buildModuleEntry(k, v));
  }

  // --module-filter applies after enumeration. Empty pattern = include all.
  // Describe accepts a regex (power-user form). v0.9 step 9.3 (Bug #3) — also
  // dual-tests against the colon-stripped form so `^:core-result$` and
  // `^core-result$` both match a module whose `m.name` is `:core-result`.
  let filterRegex = null;
  if (opts.moduleFilter) {
    try { filterRegex = new RegExp(opts.moduleFilter); } catch { filterRegex = null; }
  }
  const filtered = filterRegex
    ? moduleEntries.filter(m => filterRegex.test(m.name) || filterRegex.test(m.name.replace(/^:/, '')))
    : moduleEntries;
  filtered.sort((a, b) => a.name.localeCompare(b.name));

  const compositeBuilds = discoverCompositeBuilds(root);
  const includedModules = (model?.settingsIncludes ?? []).slice();

  const describe = {
    schema_version: model?.schemaVersion ?? null,
    cache_key: model?.cacheKey ?? null,
    generated_at: model?.generatedAt ?? new Date().toISOString(),
    coverage_tool: aggregateCoverageTool(filtered),
    jdk_requirement: model?.jdkRequirement
      ? { min: model.jdkRequirement.min ?? null, agp: model.jdkRequirement.agp ?? null }
      : null,
    dependency_graph: {
      composite_builds: compositeBuilds,
      included_modules: includedModules,
    },
    modules: filtered,
  };

  const envelope = buildJsonReport({
    subcommand: 'describe',
    projectRoot: root,
    exitCode: EXIT.SUCCESS,
    durationMs: Date.now() - startTime,
    parsed: {
      tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
      modules: [],
      skipped: [],
      coverage: { tool: describe.coverage_tool, missed_lines: null },
      errors: [],
      warnings: [],
      describe,
    },
  });

  return { envelope, exitCode: EXIT.SUCCESS };
}

// Render a compact human-readable summary. JSON envelope is the canonical
// output; text mode is for quick eyeballing.
export function formatDescribeText(envelope) {
  const d = envelope.describe || {};
  const out = [];
  out.push('');
  out.push(`kmp-test describe — ${envelope.project_root}`);
  out.push('');
  out.push(`Coverage tool: ${d.coverage_tool}`);
  if (d.jdk_requirement) {
    out.push(`JDK requirement: min=${d.jdk_requirement.min ?? 'n/a'}  agp=${d.jdk_requirement.agp ?? 'n/a'}`);
  }
  if (d.dependency_graph && d.dependency_graph.composite_builds.length > 0) {
    out.push(`Composite builds: ${d.dependency_graph.composite_builds.join(', ')}`);
  }
  out.push('');
  out.push(`Modules (${(d.modules || []).length}):`);
  for (const m of d.modules || []) {
    const platforms = m.platforms.length ? m.platforms.join(',') : '-';
    out.push(`  ${m.name}  [${platforms}]`);
    const tasks = [];
    if (m.test_tasks.unit)   tasks.push(`unit=${m.test_tasks.unit}`);
    if (m.test_tasks.device) tasks.push(`device=${m.test_tasks.device}`);
    if (m.test_tasks.web)    tasks.push(`web=${m.test_tasks.web}`);
    if (m.test_tasks.ios)    tasks.push(`ios=${m.test_tasks.ios}`);
    if (m.test_tasks.macos)  tasks.push(`macos=${m.test_tasks.macos}`);
    if (tasks.length) out.push(`      ${tasks.join('  ')}`);
    if (m.coverage_plugin) out.push(`      coverage=${m.coverage_plugin}`);
  }
  out.push('');
  return out.join('\n') + '\n';
}

export {
  parseArgs,
  discoverCompositeBuilds,
  platformsFromAnalysis,
  aggregateCoverageTool,
  buildModuleEntry,
};

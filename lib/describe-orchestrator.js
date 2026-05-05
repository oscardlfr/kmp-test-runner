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

// Argparse for describe-specific flags. Globals are stripped upstream by cli.js.
function parseArgs(argv) {
  const out = {
    moduleFilter: '',  // regex source string; empty = all modules
    skipProbe: false,
    noCache: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--module-filter': out.moduleFilter = argv[++i] || ''; break;
      case '--skip-probe':    out.skipProbe = true; break;
      case '--no-cache':      out.noCache = true; break;
      default: /* unknown — drop */ break;
    }
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

// Derive the platform list a module supports from its source-set names.
// A module declares "jvm" if it has jvmMain/desktopMain; "android" if
// androidMain or AGP plugin; "ios" if any iosX/iosTest/iosMain set; etc.
function platformsFromAnalysis(analysis) {
  if (!analysis) return [];
  const ss = analysis.sourceSets || {};
  const out = [];
  if (ss.jvmMain || ss.desktopMain || analysis.type === 'jvm' || analysis.hasDefaultJvm) {
    out.push('jvm');
  }
  if (ss.androidMain || ss.androidUnitTest || ss.androidInstrumentedTest ||
      analysis.type === 'android' || analysis.androidDsl) {
    out.push('android');
  }
  if (ss.iosMain || ss.iosX64Main || ss.iosArm64Main || ss.iosSimulatorArm64Main ||
      ss.iosTest || ss.iosX64Test || ss.iosArm64Test || ss.iosSimulatorArm64Test) {
    out.push('ios');
  }
  if (ss.macosMain || ss.macosArm64Main || ss.macosX64Main ||
      ss.macosTest || ss.macosArm64Test || ss.macosX64Test) {
    out.push('macos');
  }
  if (ss.jsMain || ss.jsTest) out.push('js');
  if (ss.wasmJsMain || ss.wasmJsTest) out.push('wasmJs');
  if (ss.commonMain && out.length === 0 && analysis.type === 'kmp') {
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
    platforms: platformsFromAnalysis(entry),
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
  let filterRegex = null;
  if (opts.moduleFilter) {
    try { filterRegex = new RegExp(opts.moduleFilter); } catch { filterRegex = null; }
  }
  const filtered = filterRegex
    ? moduleEntries.filter(m => filterRegex.test(m.name))
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

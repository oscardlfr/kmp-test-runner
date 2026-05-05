// SPDX-License-Identifier: MIT
// Tests for lib/describe-orchestrator.js — v0.9 step 3 DX-parity bundle.
//
// `kmp-test describe` reshapes buildProjectModel's schema-7 output into a
// stable describe envelope without running anything. Test surface:
//   1. Envelope shape — describe:{} block with required keys
//   2. Module metadata — name/path/platforms/test_tasks/coverage_plugin
//   3. Module filter (--module-filter regex)
//   4. discoverCompositeBuilds parses includeBuild() declarations
//   5. aggregateCoverageTool — kover / jacoco / mixed / none
//   6. platformsFromAnalysis — derives jvm/android/ios/macos/js from sourceSets
//   7. Missing settings.gradle.kts → no_project error code
//   8. --skip-probe path returns model from static analysis only

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  runDescribe,
  formatDescribeText,
  discoverCompositeBuilds,
  platformsFromAnalysis,
  aggregateCoverageTool,
  buildModuleEntry,
  parseArgs,
} from '../../lib/describe-orchestrator.js';

let workDir;

afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

function makeProject(modules, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmp-describe-test-'));
  workDir = dir;
  const includes = modules.map(m => `include(":${m.name}")`).join('\n');
  const settingsExtra = opts.settingsExtra ?? '';
  writeFileSync(path.join(dir, 'settings.gradle.kts'),
    `rootProject.name = "${opts.rootName ?? 'fixture'}"\n${includes}\n${settingsExtra}\n`);
  // Stub gradlew so buildProjectModel's wrapper-existence check doesn't bail.
  writeFileSync(path.join(dir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(path.join(dir, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
  for (const mod of modules) {
    const modDir = path.join(dir, ...mod.name.split(':'));
    mkdirSync(modDir, { recursive: true });
    const build = mod.build ?? `plugins { kotlin("jvm") }\n`;
    writeFileSync(path.join(modDir, 'build.gradle.kts'), build);
  }
  return dir;
}

describe('runDescribe envelope shape', () => {
  it('emits canonical envelope with describe:{} block, no tests/modules execution', () => {
    const dir = makeProject([{ name: 'app' }]);
    const { envelope, exitCode } = runDescribe({ projectRoot: dir, args: ['--skip-probe'] });

    expect(envelope.tool).toBe('kmp-test');
    expect(envelope.subcommand).toBe('describe');
    expect(envelope.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(envelope.exit_code).toBe(0);
    expect(envelope.tests).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });
    expect(envelope.errors).toEqual([]);
    expect(envelope.describe).toBeDefined();
    expect(exitCode).toBe(0);
  });

  it('describe block includes required keys', () => {
    const dir = makeProject([{ name: 'app' }]);
    const { envelope } = runDescribe({ projectRoot: dir, args: ['--skip-probe'] });
    const d = envelope.describe;
    expect(d).toHaveProperty('schema_version');
    expect(d).toHaveProperty('cache_key');
    expect(d).toHaveProperty('generated_at');
    expect(d).toHaveProperty('coverage_tool');
    expect(d).toHaveProperty('jdk_requirement');
    expect(d).toHaveProperty('dependency_graph');
    expect(d.dependency_graph).toHaveProperty('composite_builds');
    expect(d.dependency_graph).toHaveProperty('included_modules');
    expect(Array.isArray(d.modules)).toBe(true);
  });

  it('module entry has name/path/platforms/test_tasks/coverage_plugin/test_build_type', () => {
    const dir = makeProject([{ name: 'app' }]);
    const { envelope } = runDescribe({ projectRoot: dir, args: ['--skip-probe'] });
    const m = envelope.describe.modules[0];
    expect(m.name).toBe(':app');
    expect(m.path).toBe('app');
    expect(Array.isArray(m.platforms)).toBe(true);
    expect(m.test_tasks).toHaveProperty('unit');
    expect(m.test_tasks).toHaveProperty('device');
    expect(m.test_tasks).toHaveProperty('web');
    expect(m.test_tasks).toHaveProperty('ios');
    expect(m.test_tasks).toHaveProperty('macos');
    expect(m).toHaveProperty('coverage_plugin');
    expect(m).toHaveProperty('test_build_type');
  });
});

describe('runDescribe --module-filter', () => {
  it('filters modules by regex', () => {
    const dir = makeProject([
      { name: 'core' }, { name: 'feature' }, { name: 'app' },
    ]);
    const { envelope } = runDescribe({
      projectRoot: dir,
      args: ['--skip-probe', '--module-filter', '^:(core|feature)$'],
    });
    const names = envelope.describe.modules.map(m => m.name).sort();
    expect(names).toEqual([':core', ':feature']);
  });

  it('empty filter includes all modules', () => {
    const dir = makeProject([{ name: 'a' }, { name: 'b' }]);
    const { envelope } = runDescribe({ projectRoot: dir, args: ['--skip-probe'] });
    expect(envelope.describe.modules.length).toBe(2);
  });
});

describe('runDescribe missing project', () => {
  it('exits 2 with errors[].code:"no_project" when no settings/build files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-describe-empty-'));
    workDir = dir;
    const { envelope, exitCode } = runDescribe({ projectRoot: dir, args: [] });
    expect(envelope.errors[0].code).toBe('no_project');
    expect(exitCode).toBe(2);
  });
});

describe('discoverCompositeBuilds', () => {
  it('parses includeBuild("../shared-kmp-libs")', () => {
    const dir = makeProject(
      [{ name: 'app' }],
      { settingsExtra: 'includeBuild("../shared-kmp-libs")' },
    );
    const composites = discoverCompositeBuilds(dir);
    expect(composites).toEqual(['../shared-kmp-libs']);
  });

  it('parses multiple includeBuild calls', () => {
    const dir = makeProject(
      [{ name: 'app' }],
      { settingsExtra: 'includeBuild("../lib-a")\nincludeBuild("../lib-b")' },
    );
    const composites = discoverCompositeBuilds(dir);
    expect(composites).toEqual(['../lib-a', '../lib-b']);
  });

  it('parses groovy-style includeBuild "..."', () => {
    const dir = makeProject(
      [{ name: 'app' }],
      { settingsExtra: 'includeBuild "../lib-c"' },
    );
    const composites = discoverCompositeBuilds(dir);
    expect(composites).toEqual(['../lib-c']);
  });

  it('returns [] when no includeBuild calls', () => {
    const dir = makeProject([{ name: 'app' }]);
    expect(discoverCompositeBuilds(dir)).toEqual([]);
  });

  it('envelope reflects composite_builds in dependency_graph', () => {
    const dir = makeProject(
      [{ name: 'app' }],
      { settingsExtra: 'includeBuild("../shared-kmp-libs")' },
    );
    const { envelope } = runDescribe({ projectRoot: dir, args: ['--skip-probe'] });
    expect(envelope.describe.dependency_graph.composite_builds).toEqual(['../shared-kmp-libs']);
  });
});

describe('platformsFromAnalysis', () => {
  it('jvm sourceSet → ["jvm"]', () => {
    expect(platformsFromAnalysis({ sourceSets: { jvmMain: true } })).toEqual(['jvm']);
  });

  it('android plugin → ["android"]', () => {
    expect(platformsFromAnalysis({ type: 'android', sourceSets: {} })).toEqual(['android']);
  });

  it('iosMain + macosArm64Main → ["ios", "macos"]', () => {
    expect(platformsFromAnalysis({
      sourceSets: { iosMain: true, macosArm64Main: true },
    })).toEqual(['ios', 'macos']);
  });

  it('KMP with all targets → multi-platform array', () => {
    const platforms = platformsFromAnalysis({
      type: 'kmp',
      sourceSets: {
        jvmMain: true, androidMain: true, iosMain: true, macosArm64Main: true, jsMain: true,
      },
    });
    expect(platforms.sort()).toEqual(['android', 'ios', 'js', 'jvm', 'macos']);
  });

  it('KMP with only commonMain → ["common"]', () => {
    expect(platformsFromAnalysis({
      type: 'kmp',
      sourceSets: { commonMain: true },
    })).toEqual(['common']);
  });

  it('null analysis → []', () => {
    expect(platformsFromAnalysis(null)).toEqual([]);
  });
});

describe('aggregateCoverageTool', () => {
  it('all modules kover → "kover"', () => {
    expect(aggregateCoverageTool([{ coverage_plugin: 'kover' }, { coverage_plugin: 'kover' }])).toBe('kover');
  });
  it('all modules jacoco → "jacoco"', () => {
    expect(aggregateCoverageTool([{ coverage_plugin: 'jacoco' }])).toBe('jacoco');
  });
  it('mixed kover + jacoco → "mixed"', () => {
    expect(aggregateCoverageTool([
      { coverage_plugin: 'kover' }, { coverage_plugin: 'jacoco' },
    ])).toBe('mixed');
  });
  it('no coverage anywhere → "none"', () => {
    expect(aggregateCoverageTool([{ coverage_plugin: null }, { coverage_plugin: null }])).toBe('none');
  });
});

describe('parseArgs', () => {
  it('--skip-probe and --no-cache flags', () => {
    expect(parseArgs(['--skip-probe']).skipProbe).toBe(true);
    expect(parseArgs(['--no-cache']).noCache).toBe(true);
    expect(parseArgs([]).skipProbe).toBe(false);
    expect(parseArgs([]).noCache).toBe(false);
  });

  it('--module-filter takes value', () => {
    expect(parseArgs(['--module-filter', '^core']).moduleFilter).toBe('^core');
  });
});

describe('formatDescribeText', () => {
  it('renders project_root + module count + per-module rows', () => {
    const dir = makeProject([{ name: 'app' }, { name: 'core' }]);
    const { envelope } = runDescribe({ projectRoot: dir, args: ['--skip-probe'] });
    const text = formatDescribeText(envelope);
    expect(text).toMatch(/kmp-test describe/);
    expect(text).toMatch(/Modules \(2\)/);
    expect(text).toMatch(/:app/);
    expect(text).toMatch(/:core/);
  });
});

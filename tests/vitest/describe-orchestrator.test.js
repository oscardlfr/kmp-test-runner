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

import { describe, it, expect, afterEach, vi } from 'vitest';
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
} from '../../lib/orchestrators/describe-orchestrator.js';

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

  // v0.9 wet-audit F-1 regression — envelope.exit_code MUST match the
  // orchestrator's process exit (CONFIG_ERROR / 2). Pre-fix envErrorJson
  // hardcoded ENV_ERROR / 3 in the envelope while the caller exited 2.
  it('F-1 regression: envelope.exit_code equals returned exitCode (CONFIG_ERROR/2)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-describe-empty-'));
    workDir = dir;
    const { envelope, exitCode } = runDescribe({ projectRoot: dir, args: [] });
    expect(exitCode).toBe(2);
    expect(envelope.exit_code).toBe(2);
    expect(envelope.exit_code).toBe(exitCode);
  });
});

describe('discoverCompositeBuilds', () => {
  it('parses includeBuild("../private-lib")', () => {
    const dir = makeProject(
      [{ name: 'app' }],
      { settingsExtra: 'includeBuild("../private-lib")' },
    );
    const composites = discoverCompositeBuilds(dir);
    expect(composites).toEqual(['../private-lib']);
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
      { settingsExtra: 'includeBuild("../private-lib")' },
    );
    const { envelope } = runDescribe({ projectRoot: dir, args: ['--skip-probe'] });
    expect(envelope.describe.dependency_graph.composite_builds).toEqual(['../private-lib']);
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

  // ---------------------------------------------------------------------
  // v0.9 step 9.4 (Bug #4) — gradleTasks augmentation. Static-only undercounts
  // platforms when convention plugins emit targets without leaving visible
  // source-set dirs (private-lib `:sample-result` repro: only `androidMain`
  // on disk, but gradle exposes `desktopTest`/`iosSimulatorArm64Test`/...).
  // ---------------------------------------------------------------------
  it('gradleTasks augments platforms — desktopTest → jvm', () => {
    expect(platformsFromAnalysis(
      { sourceSets: { androidMain: true } },
      [':sample-result:desktopTest', ':sample-result:testAndroidHostTest']
    ).sort()).toEqual(['android', 'jvm']);
  });

  it('gradleTasks augments platforms — full KMP target set (Bug #4 repro)', () => {
    // private-lib :sample-result: declares jvm("desktop") + androidLibrary +
    // iosX64/iosArm64/iosSimulatorArm64 + macosArm64 via convention plugin.
    // Static scan only finds androidMain; probe should add jvm/ios/macos.
    expect(platformsFromAnalysis(
      { type: 'kmp', sourceSets: { androidMain: true, commonMain: true }, androidDsl: 'androidLibrary' },
      [
        ':sample-result:desktopTest',
        ':sample-result:iosSimulatorArm64Test',
        ':sample-result:iosX64Test',
        ':sample-result:iosArm64Test',
        ':sample-result:macosArm64Test',
        ':sample-result:testAndroidHostTest',
      ]
    )).toEqual(['jvm', 'android', 'ios', 'macos']);
  });

  it('gradleTasks: jsTest + wasmJsTest → js + wasmJs', () => {
    expect(platformsFromAnalysis(
      { sourceSets: {} },
      [':m:jsTest', ':m:wasmJsTest']
    ).sort()).toEqual(['js', 'wasmJs']);
  });

  it('gradleTasks: testDebugUnitTest / connectedDebugAndroidTest → android', () => {
    expect(platformsFromAnalysis(
      { sourceSets: {} },
      [':m:testDebugUnitTest', ':m:connectedDebugAndroidTest']
    )).toEqual(['android']);
  });

  it('gradleTasks: jvmTest (legacy KMP target name) → jvm', () => {
    expect(platformsFromAnalysis(
      { sourceSets: {} },
      [':m:jvmTest']
    )).toEqual(['jvm']);
  });

  it('null gradleTasks falls through to static-only behavior (no regression)', () => {
    expect(platformsFromAnalysis(
      { sourceSets: { androidMain: true } },
      null
    )).toEqual(['android']);
    expect(platformsFromAnalysis(
      { sourceSets: { androidMain: true } }
    )).toEqual(['android']);
  });

  it('static + gradle merge — deduplicated', () => {
    expect(platformsFromAnalysis(
      { sourceSets: { androidMain: true, jvmMain: true } },
      [':m:desktopTest', ':m:testDebugUnitTest']
    ).sort()).toEqual(['android', 'jvm']);
  });

  it('arbitrary user task names ignored (only canonical KMP/AGP shapes)', () => {
    expect(platformsFromAnalysis(
      { sourceSets: {} },
      [':m:myCustomTestTask', ':m:somethingElse', ':m:assemble']
    )).toEqual([]);
  });

  it('preserves stable platform ordering: jvm/android/ios/macos/js/wasmJs', () => {
    // Probed in random order — output ordering should be canonical.
    expect(platformsFromAnalysis(
      { sourceSets: {} },
      [':m:wasmJsTest', ':m:macosArm64Test', ':m:jsTest', ':m:iosSimulatorArm64Test', ':m:desktopTest', ':m:testDebugUnitTest']
    )).toEqual(['jvm', 'android', 'ios', 'macos', 'js', 'wasmJs']);
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

  // v0.9 wet-audit drift #5: positional argument binds to --module-filter.
  // Pre-fix: `kmp-test describe :sample-result` silently dropped the positional
  // and returned the unfiltered module set, hiding the usage mistake.
  describe('drift #5 — positional --module-filter shorthand', () => {
    it('binds a single positional to moduleFilter', () => {
      expect(parseArgs([':sample-result']).moduleFilter).toBe(':sample-result');
    });

    it('explicit --module-filter wins over later positional', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const r = parseArgs(['--module-filter', ':first', ':second']);
        expect(r.moduleFilter).toBe(':first');
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining(":second"));
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('first positional wins over later positional', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const r = parseArgs([':first', ':second']);
        expect(r.moduleFilter).toBe(':first');
        expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining(":second"));
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('skips global --project-root <value> so its value is not bound as positional', () => {
      const r = parseArgs(['--project-root', '/some/path', ':sample-result']);
      expect(r.moduleFilter).toBe(':sample-result');
    });

    it('skips global --java-home <value>', () => {
      const r = parseArgs(['--java-home', '/jdks/21', ':core']);
      expect(r.moduleFilter).toBe(':core');
    });

    it('skips boolean global --ignore-jdk-mismatch', () => {
      expect(parseArgs(['--ignore-jdk-mismatch', ':a']).moduleFilter).toBe(':a');
    });

    it('positional with --skip-probe + --no-cache combines correctly', () => {
      const r = parseArgs(['--skip-probe', ':core', '--no-cache']);
      expect(r.moduleFilter).toBe(':core');
      expect(r.skipProbe).toBe(true);
      expect(r.noCache).toBe(true);
    });

    it('end-to-end: runDescribe applies positional filter', () => {
      const dir = makeProject([{ name: 'app' }, { name: 'sample-result' }, { name: 'core-common' }]);
      const { envelope } = runDescribe({ projectRoot: dir, args: ['--skip-probe', 'sample-result'] });
      const names = envelope.describe.modules.map(m => m.name);
      expect(names).toEqual([':sample-result']);
    });
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

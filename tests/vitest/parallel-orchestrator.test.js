// SPDX-License-Identifier: MIT
// Tests for lib/parallel-orchestrator.js — v0.8 STRATEGIC PIVOT, sub-entry 5
// (terminal step). Migrates the parallel codepath of run-parallel-coverage-suite.
// {sh,ps1} (~2,600 LOC residual after sub-entry 4) into Node.
//
// Test surface (acceptance rubric: BACKLOG.md Sub-entry 5):
//   1.  parseArgs handles all parallel-specific flags
//   2.  expandNoCoverageAlias substitutes correctly
//   3.  Glob matcher: --module-filter + --exclude-modules
//   4.  pickGradleTaskFor: --test-type common resolves via unitTestTask (WS-7 + jvm()→jvmTest)
//   5.  pickGradleTaskFor: --test-type ios uses iosTestTask candidate chain
//   6.  pickGradleTaskFor: --test-type macos uses macosTestTask candidate chain
//   7.  pickGradleTaskFor: --test-type androidUnit hardcodes testDebugUnitTest
//   8.  pickGradleTaskFor: --test-type androidInstrumented uses deviceTestTask
//   9.  Modules without target → skipped[] with reason (UX-1)
//  10.  Empty post-filter + --test-type explicit + --module-filter=* → "No modules support the requested --test-type=<X>" (UX-2)
//  11.  Empty post-filter + non-default filter → "No modules found matching filter" (UX-2 negative case)
//  12.  --test-type ios on Linux → errors[].code:"platform_unsupported", exit 3
//  13.  --test-type macos on Windows → errors[].code:"platform_unsupported", exit 3
//  14.  --test-type ios on macOS → no platform_unsupported (proceeds to dispatch)
//  15.  --dry-run → dry_run:true with plan{legs[]}, no spawn calls
//  16.  --skip-tests → delegates to runCoverage stub, no gradle dispatch
//  17.  --test-type all → multiple legs (WS-6) — at minimum [common, desktop, androidUnit]
//  18.  --test-type all on macOS → adds ios + macos legs
//  19.  KMP_TEST_SKIP_ADB=1 → drops androidInstrumented from --test-type all legs
//  20.  Successful test run → modules:[] populated when tests.passed > 0 (WS-9)
//  21.  Failed gradle task ("X FAILED" pattern) → state.errors has module_failed
//  22.  WS-1: "Cannot locate tasks that match" → all tasks marked failed
//  23.  applyErrorCodeDiscriminators picks up task_not_found from gradle stderr
//  24.  Junit-XML walk for individual_total (WS-8 additive)
//  25.  --no-coverage → coverage.tool='none' + warning, runCoverage NOT called
//  26.  --coverage-tool none → same as --no-coverage
//  27.  In-process runCoverage call replaces subprocess hop (WS-9 by-construction)
//  28.  SKIP_DESKTOP_MODULES env → modules with that short-name go to skipped[]
//  29.  SKIP_IOS_MODULES env → only applies on --test-type ios leg
//  30.  --module-filter glob (`api,*-test`) matches multiple patterns
//  31.  --exclude-modules glob drops matching modules silently
//  32.  Cross-platform spawn shape — direct gradlew dispatch (no bash subprocess)
//  33.  Envelope shape: parallel:{test_type, legs[], max_workers, timeout_s}
//  34.  Empty SKIP_*_MODULES under strict-mode (locks v0.7.x Bash 3.2 fix into JS forever)
//  35.  Empty modules list → no_test_modules error, exit 3

import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isGradleCall, effectiveGradleArgs, isStopCall } from './_spawn-helpers.js';

import {
  runParallel,
  parseArgs,
  expandNoCoverageAlias,
  splitCsv,
  globToRegex,
  matchAnyGlob,
  pickGradleTaskFor,
  partitionBySkipEnv,
  legsForAll,
  junitTestCountFor,
  classifyTaskResults,
  applyModuleFilters,
  hasAnyTestSourceSet,
  discoverParallelModules,
} from '../../lib/parallel-orchestrator.js';

let workDir;
afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

// Build a synthetic project. Each module gets a build.gradle.kts so
// discoverIncludedModules + analyzeModule see them. moduleBuild lets a test
// override the contents to declare ios/macos/android targets.
function makeProject(modules, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmp-parallel-test-'));
  workDir = dir;
  const includes = modules.map(m => `include(":${m.name ?? m}")`).join('\n');
  writeFileSync(path.join(dir, 'settings.gradle.kts'),
    `rootProject.name = "${opts.rootName ?? 'fixture'}"\n${includes}\n`);
  writeFileSync(path.join(dir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(path.join(dir, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
  for (const m of modules) {
    const name = m.name ?? m;
    const modDir = path.join(dir, ...name.split(':'));
    mkdirSync(modDir, { recursive: true });
    writeFileSync(path.join(modDir, 'build.gradle.kts'),
      m.build ?? 'plugins { kotlin("jvm") }\n');
    // Create source-set directories so analyzeModule's sourceSets walk picks
    // them up. Each test specifies which source sets to create.
    if (m.sourceSets) {
      for (const ss of m.sourceSets) {
        mkdirSync(path.join(modDir, 'src', ss, 'kotlin'), { recursive: true });
      }
    }
  }
  return dir;
}

// Spawn stub. Records every call. Returns canned gradle output (BUILD SUCCESSFUL
// by default, or a per-task FAILED marker when configured). Cross-platform: the
// orchestrator calls gradlew (or gradlew.bat) directly — never bash/powershell.
function makeSpawnStub({ status = 0, stdout = 'BUILD SUCCESSFUL\n', stderr = '', failTasks = [], resolutionFail = false } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], cwd: opts?.cwd ?? null, env: opts?.env ?? null });
    let outText = stdout;
    if (resolutionFail) {
      outText += '\nCannot locate tasks that match\n';
    }
    for (const t of failTasks) {
      outText += `\n> Task ${t} FAILED\n`;
    }
    return {
      status: failTasks.length > 0 || resolutionFail ? 1 : status,
      stdout: outText,
      stderr,
      signal: null,
      error: null,
    };
  };
  fn.calls = calls;
  return fn;
}

// Stub for runCoverage (in-process call). Records invocations and returns a
// canned envelope so the parallel orchestrator can merge it.
function makeRunCoverageStub({ coverage = null } = {}) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    return {
      envelope: {
        coverage: coverage ?? {
          tool: 'auto',
          missed_lines: 0,
          modules_contributing: 0,
          modules_with_kover_plugin: [],
          modules_with_jacoco_plugin: [],
        },
      },
      exitCode: 0,
    };
  };
  fn.calls = calls;
  return fn;
}

// ===========================================================================
// Argparse + helpers
// ===========================================================================
describe('parseArgs', () => {
  it('handles every documented flag with expected types', () => {
    const opts = parseArgs([
      '--include-shared',
      '--test-type', 'ios',
      '--module-filter', 'core,*:api',
      '--test-filter', 'com.foo.*',
      '--max-workers', '4',
      '--coverage-tool', 'kover',
      '--coverage-modules', 'core,domain',
      '--min-missed-lines', '10',
      '--exclude-coverage', 'app',
      '--exclude-modules', '*-test',
      '--include-untested',
      '--timeout', '900',
      '--skip-tests',
      '--dry-run',
      '--fresh-daemon',
      '--output-file', 'custom.md',
      '--coverage-only',
      '--benchmark',
      '--benchmark-config', 'stress',
    ]);
    expect(opts.includeShared).toBe(true);
    expect(opts.testType).toBe('ios');
    expect(opts.testTypeExplicit).toBe(true);
    expect(opts.moduleFilter).toBe('core,*:api');
    expect(opts.testFilter).toBe('com.foo.*');
    expect(opts.maxWorkers).toBe(4);
    expect(opts.coverageTool).toBe('kover');
    expect(opts.coverageModules).toBe('core,domain');
    expect(opts.minMissedLines).toBe(10);
    expect(opts.excludeCoverage).toBe('app');
    expect(opts.excludeModules).toBe('*-test');
    expect(opts.includeUntested).toBe(true);
    expect(opts.timeout).toBe(900);
    expect(opts.skipTests).toBe(true);
    expect(opts.dryRun).toBe(true);
    expect(opts.freshDaemon).toBe(true);
    expect(opts.outputFile).toBe('custom.md');
    expect(opts.coverageOnly).toBe(true);
    expect(opts.benchmark).toBe(true);
    expect(opts.benchmarkConfig).toBe('stress');
  });

  it('defaults: testType empty, moduleFilter "*", testTypeExplicit false', () => {
    const opts = parseArgs([]);
    expect(opts.testType).toBe('');
    expect(opts.testTypeExplicit).toBe(false);
    expect(opts.moduleFilter).toBe('*');
    expect(opts.coverageTool).toBe('auto');
    expect(opts.timeout).toBe(600);
    expect(opts.maxWorkers).toBe(0);
    expect(opts.freshDaemon).toBe(false);
    expect(opts.outputFile).toBe('coverage-full-report.md');
    expect(opts.coverageOnly).toBe(false);
    expect(opts.benchmark).toBe(false);
    expect(opts.benchmarkConfig).toBe('smoke');
  });

  it('expands --no-coverage to --coverage-tool none', () => {
    const opts = parseArgs(['--no-coverage']);
    expect(opts.coverageTool).toBe('none');
  });
});

describe('expandNoCoverageAlias', () => {
  it('substitutes --no-coverage in place', () => {
    expect(expandNoCoverageAlias(['--foo', '--no-coverage', '--bar']))
      .toEqual(['--foo', '--coverage-tool', 'none', '--bar']);
  });
});

describe('splitCsv', () => {
  it('trims and filters empty', () => {
    expect(splitCsv(' a , , b,c ')).toEqual(['a', 'b', 'c']);
    expect(splitCsv('')).toEqual([]);
    expect(splitCsv(undefined)).toEqual([]);
  });
});

// ===========================================================================
// Glob matching
// ===========================================================================
describe('globToRegex + matchAnyGlob', () => {
  it('matches *', () => {
    expect(globToRegex('*').test('anything')).toBe(true);
    expect(globToRegex('*-api').test('foo-api')).toBe(true);
    expect(globToRegex('*-api').test('foo-bar')).toBe(false);
  });

  it('matches comma-separated globs (with leading-colon variant)', () => {
    expect(matchAnyGlob('foo:api', '*:api,*-api')).toBe(true);
    expect(matchAnyGlob('foo-api', '*:api,*-api')).toBe(true);
    expect(matchAnyGlob('core', 'core,domain')).toBe(true);
    expect(matchAnyGlob('shared', 'core,domain')).toBe(false);
    // Leading-colon variant: `:core` matches `core` glob.
    expect(matchAnyGlob('core', ':core')).toBe(true);
  });
});

// ===========================================================================
// Per-test-type task selection (single source of truth: project-model)
// ===========================================================================
describe('pickGradleTaskFor', () => {
  const kmpModule = {
    name: 'shared',
    type: 'kmp',
    androidDsl: false,
    resolved: {
      unitTestTask: 'jvmTest',
      deviceTestTask: null,
      iosTestTask: 'iosSimulatorArm64Test',
      macosTestTask: 'macosArm64Test',
      webTestTask: 'jsTest',
    },
  };
  const androidModule = {
    name: 'app',
    type: 'android',
    androidDsl: true,
    resolved: {
      unitTestTask: null,
      deviceTestTask: 'connectedDebugAndroidTest',
      iosTestTask: null,
      macosTestTask: null,
      webTestTask: null,
    },
  };
  const jvmOnlyModule = {
    name: 'lib',
    type: 'jvm',
    androidDsl: false,
    resolved: { unitTestTask: 'test', deviceTestTask: null, iosTestTask: null, macosTestTask: null, webTestTask: null },
  };

  it('--test-type common resolves via unitTestTask (WS-7 + jvm()→jvmTest closure)', () => {
    expect(pickGradleTaskFor(kmpModule, 'common').task).toBe(':shared:jvmTest');
    expect(pickGradleTaskFor(jvmOnlyModule, 'common').task).toBe(':lib:test');
  });

  it('--test-type common with no unitTestTask → null + reason (UX-1)', () => {
    const r = pickGradleTaskFor({ name: 'foo', type: 'kmp', resolved: { unitTestTask: null } }, 'common');
    expect(r.task).toBeNull();
    expect(r.reason).toMatch(/no common target/);
  });

  it('--test-type ios uses iosTestTask candidate', () => {
    expect(pickGradleTaskFor(kmpModule, 'ios').task).toBe(':shared:iosSimulatorArm64Test');
    expect(pickGradleTaskFor(androidModule, 'ios').task).toBeNull();
    expect(pickGradleTaskFor(androidModule, 'ios').reason).toMatch(/no ios target/);
  });

  it('--test-type ios permissive fallback: iosMain-only module dispatches iosSimulatorArm64Test', () => {
    // Confetti :shared shape — declares iosX64()/iosSimulatorArm64() (evidenced
    // by src/iosMain on disk) but no iosTest source set yet. Gradle creates
    // the *Test task from the target() declaration; orchestrator must queue it.
    const iosMainOnly = {
      name: 'shared',
      type: 'kmp',
      resolved: { iosTestTask: null },
      sourceSets: { commonMain: true, iosMain: true, commonTest: true },
    };
    expect(pickGradleTaskFor(iosMainOnly, 'ios').task).toBe(':shared:iosSimulatorArm64Test');
  });

  it('--test-type macos uses macosTestTask candidate', () => {
    expect(pickGradleTaskFor(kmpModule, 'macos').task).toBe(':shared:macosArm64Test');
    expect(pickGradleTaskFor(jvmOnlyModule, 'macos').task).toBeNull();
  });

  it('--test-type androidUnit hardcodes testDebugUnitTest, gated by Android type', () => {
    expect(pickGradleTaskFor(androidModule, 'androidUnit').task).toBe(':app:testDebugUnitTest');
    expect(pickGradleTaskFor(jvmOnlyModule, 'androidUnit').task).toBeNull();
  });

  it('--test-type androidInstrumented uses deviceTestTask, falls back for AGP modules', () => {
    expect(pickGradleTaskFor(androidModule, 'androidInstrumented').task).toBe(':app:connectedDebugAndroidTest');
    // KMP module with androidDsl but probe missed → fallback.
    const kmpWithAndroid = { name: 'kmp-and', type: 'kmp', androidDsl: true, resolved: { deviceTestTask: null } };
    expect(pickGradleTaskFor(kmpWithAndroid, 'androidInstrumented').task).toBe(':kmp-and:connectedDebugAndroidTest');
  });

  it('--test-type js / wasmJs use webTestTask', () => {
    expect(pickGradleTaskFor(kmpModule, 'js').task).toBe(':shared:jsTest');
    expect(pickGradleTaskFor(kmpModule, 'wasmJs').task).toBe(':shared:jsTest');
  });

  it('empty test-type auto-picks: KMP/JVM → unitTestTask, Android-only → testDebugUnitTest', () => {
    expect(pickGradleTaskFor(kmpModule, '').task).toBe(':shared:jvmTest');
    expect(pickGradleTaskFor(androidModule, '').task).toBe(':app:testDebugUnitTest');
  });
});

// ===========================================================================
// SKIP_*_MODULES env partition
// ===========================================================================
describe('partitionBySkipEnv', () => {
  const modules = [
    { name: 'core' }, { name: 'feature:domain' }, { name: 'app' },
  ];

  it('SKIP_DESKTOP_MODULES drops named modules from desktop/common legs', () => {
    const r = partitionBySkipEnv(modules, 'desktop', { SKIP_DESKTOP_MODULES: 'core' });
    expect(r.kept.map(m => m.name)).toEqual(['feature:domain', 'app']);
    expect(r.skipped[0].module).toBe('core');
    expect(r.skipped[0].reason).toMatch(/SKIP_DESKTOP_MODULES/);
  });

  it('SKIP_IOS_MODULES does not affect desktop leg', () => {
    const r = partitionBySkipEnv(modules, 'desktop', { SKIP_IOS_MODULES: 'core' });
    expect(r.kept.length).toBe(3);
    expect(r.skipped.length).toBe(0);
  });

  it('empty SKIP_* env partitions cleanly (locks Bash 3.2 SKIPPED_MODULES regression into JS)', () => {
    const r = partitionBySkipEnv(modules, 'ios', {});
    expect(r.kept.length).toBe(3);
    expect(r.skipped.length).toBe(0);
  });
});

// ===========================================================================
// --test-type all: leg expansion (WS-6)
// ===========================================================================
describe('legsForAll', () => {
  it('always includes common, desktop, androidUnit', () => {
    const legs = legsForAll({});
    expect(legs).toContain('common');
    expect(legs).toContain('desktop');
    expect(legs).toContain('androidUnit');
  });

  it('includes androidInstrumented when KMP_TEST_SKIP_ADB is unset', () => {
    expect(legsForAll({})).toContain('androidInstrumented');
  });

  it('drops androidInstrumented when KMP_TEST_SKIP_ADB=1', () => {
    expect(legsForAll({ KMP_TEST_SKIP_ADB: '1' })).not.toContain('androidInstrumented');
  });

  it('adds ios + macos only on macOS host', () => {
    const legs = legsForAll({});
    if (process.platform === 'darwin') {
      expect(legs).toContain('ios');
      expect(legs).toContain('macos');
    } else {
      expect(legs).not.toContain('ios');
      expect(legs).not.toContain('macos');
    }
  });
});

// ===========================================================================
// classifyTaskResults: per-task pass/fail extraction
// ===========================================================================
describe('classifyTaskResults', () => {
  it('marks tasks failed when "<task> FAILED" appears in stdout', () => {
    const stdout = '> Task :foo:test\nBUILD SUCCESSFUL\n> Task :bar:test FAILED\n';
    const r = classifyTaskResults(stdout, '', [':foo:test', ':bar:test']);
    expect(r.get(':foo:test')).toBe('passed');
    expect(r.get(':bar:test')).toBe('failed');
  });

  it('WS-1: "Cannot locate tasks that match" → all tasks failed (build aborted at resolution)', () => {
    const stderr = 'Cannot locate tasks that match \':foo:iosTest\'\n';
    const r = classifyTaskResults('', stderr, [':foo:iosTest', ':bar:iosTest']);
    expect(r.get(':foo:iosTest')).toBe('failed');
    expect(r.get(':bar:iosTest')).toBe('failed');
  });
});

// ===========================================================================
// Junit-XML walk for individual_total (WS-8 additive)
// ===========================================================================
describe('junitTestCountFor', () => {
  it('counts <testcase> entries across TEST-*.xml files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-test-'));
    workDir = dir;
    const taskDir = path.join(dir, 'core', 'build', 'test-results', 'jvmTest');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(path.join(taskDir, 'TEST-com.foo.Bar.xml'),
      '<testsuite><testcase/><testcase/><testcase/></testsuite>');
    writeFileSync(path.join(taskDir, 'TEST-com.foo.Baz.xml'),
      '<testsuite><testcase/></testsuite>');
    expect(junitTestCountFor(dir, ':core:jvmTest')).toBe(4);
  });

  it('returns 0 when directory missing (no failure)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-test-'));
    workDir = dir;
    expect(junitTestCountFor(dir, ':missing:test')).toBe(0);
  });
});

// ===========================================================================
// runParallel: end-to-end behaviors
// ===========================================================================
describe('runParallel', () => {
  it('--dry-run emits dry_run:true with plan, no spawn calls', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain'] }]);
    const spawn = makeSpawnStub();
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--dry-run', '--test-type', 'common'],
      spawn,
      log: () => {},
    });
    expect(envelope.dry_run).toBe(true);
    expect(envelope.exit_code).toBe(0);
    expect(envelope.plan.test_type).toBe('common');
    expect(envelope.plan.legs).toEqual(['common']);
    expect(spawn.calls.length).toBe(0);
    expect(exitCode).toBe(0);
  });

  it('--dry-run with --test-type all enumerates legs in plan', async () => {
    const dir = makeProject([{ name: 'core' }]);
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--dry-run', '--test-type', 'all'],
      spawn: makeSpawnStub(),
      env: { KMP_TEST_SKIP_ADB: '1' }, // deterministic across hosts
      log: () => {},
    });
    expect(envelope.plan.legs.length).toBeGreaterThanOrEqual(3);
    expect(envelope.plan.legs).toContain('common');
    expect(envelope.plan.legs).toContain('desktop');
    expect(envelope.plan.legs).toContain('androidUnit');
    expect(envelope.plan.legs).not.toContain('androidInstrumented');
  });

  it('--test-type ios on Linux/Windows → platform_unsupported, exit 3', async () => {
    if (process.platform === 'darwin') return; // no-op on macOS
    const dir = makeProject([{ name: 'shared' }]);
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'ios'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    expect(envelope.errors[0].code).toBe('platform_unsupported');
    expect(envelope.errors[0].test_type).toBe('ios');
    expect(envelope.exit_code).toBe(3);
    expect(exitCode).toBe(3);
  });

  it('--test-type macos on Linux/Windows → platform_unsupported, exit 3', async () => {
    if (process.platform === 'darwin') return;
    const dir = makeProject([{ name: 'shared' }]);
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'macos'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    expect(envelope.errors[0].code).toBe('platform_unsupported');
    expect(exitCode).toBe(3);
  });

  it('--skip-tests delegates to runCoverage stub, no gradle dispatch', async () => {
    const dir = makeProject([{ name: 'core' }]);
    const stubCoverage = makeRunCoverageStub({
      coverage: { tool: 'kover', missed_lines: 0, modules_contributing: 1 },
    });
    const spawn = makeSpawnStub();
    await runParallel({
      projectRoot: dir,
      args: ['--skip-tests'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(stubCoverage.calls.length).toBe(1);
    // No gradlew spawn since coverage stub returned early.
    const gradlewCalls = spawn.calls.filter(c => /gradlew/.test(String(c.cmd)));
    expect(gradlewCalls.length).toBe(0);
  });

  it('successful run populates modules:[] when tests.passed > 0 (WS-9)', async () => {
    const dir = makeProject([
      { name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'feature', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 5s\n' });
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.tests.passed).toBeGreaterThan(0);
    expect(envelope.modules.length).toBeGreaterThan(0);
    expect(envelope.modules).toContain('core');
    expect(envelope.modules).toContain('feature');
  });

  it('--fresh-daemon spawns gradlew --stop before main dispatch', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--fresh-daemon'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    const stopCalls = spawn.calls.filter(isStopCall);
    expect(stopCalls.length).toBe(1);
    // --stop must precede the main test dispatch.
    const firstNonStop = spawn.calls.findIndex(c => isGradleCall(c) && !isStopCall(c));
    const stopIdx = spawn.calls.findIndex(isStopCall);
    expect(stopIdx).toBeLessThan(firstNonStop);
  });

  it('without --fresh-daemon, no gradlew --stop call', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    const stopCalls = spawn.calls.filter(isStopCall);
    expect(stopCalls.length).toBe(0);
  });

  it('--output-file forwarded to runCoverage', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--output-file', 'custom-report.md'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(stubCoverage.calls.length).toBe(1);
    const passedArgs = stubCoverage.calls[0].args;
    const idx = passedArgs.indexOf('--output-file');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(passedArgs[idx + 1]).toBe('custom-report.md');
  });

  it('--coverage-only filters modules to those listed in --coverage-modules', async () => {
    const dir = makeProject([
      { name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'feature', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'shared', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--coverage-only', '--coverage-modules', 'core,feature'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    // Only `core` + `feature` reached the test dispatch, `shared` was filtered out.
    expect(envelope.modules).toContain('core');
    expect(envelope.modules).toContain('feature');
    expect(envelope.modules).not.toContain('shared');
  });

  it('--benchmark invokes runBenchmark stub with --config', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    const benchCalls = [];
    const stubBenchmark = async (opts) => {
      benchCalls.push(opts);
      return { envelope: { benchmark: { config: 'main', total: 0 } }, exitCode: 0 };
    };
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--benchmark', '--benchmark-config', 'main'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
      runBenchmarkInjection: stubBenchmark,
    });
    expect(benchCalls.length).toBe(1);
    expect(benchCalls[0].args).toContain('--config');
    expect(benchCalls[0].args).toContain('main');
  });

  it('without --benchmark, runBenchmark is NOT invoked', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    let benchCalled = false;
    const stubBenchmark = async () => { benchCalled = true; return { envelope: {}, exitCode: 0 }; };
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
      runBenchmarkInjection: stubBenchmark,
    });
    expect(benchCalled).toBe(false);
  });

  it('--benchmark non-zero exit surfaces as non-fatal warning, parallel exit unchanged', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    const stubBenchmark = async () => ({ envelope: {}, exitCode: 1 });
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--benchmark'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
      runBenchmarkInjection: stubBenchmark,
    });
    expect(envelope.warnings.some(w => w.code === 'benchmark_failed')).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('"<task> FAILED" pattern → state.errors has module_failed, exit 1', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    // jvmTest source set present → unitTestTask resolves to jvmTest.
    const spawn = makeSpawnStub({ failTasks: [':core:jvmTest'], stdout: '> Task :core:jvmTest\n' });
    const stubCoverage = makeRunCoverageStub();
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.tests.failed).toBeGreaterThan(0);
    expect(envelope.errors.some(e => e.code === 'module_failed')).toBe(true);
    expect(exitCode).toBe(1);
  });

  it('WS-1: "Cannot locate tasks" → all modules marked failed by classifyTaskResults', async () => {
    const dir = makeProject([
      { name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'feature', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub({ resolutionFail: true });
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.tests.failed).toBeGreaterThan(0);
    // applyErrorCodeDiscriminators picks up "Cannot locate tasks" → task_not_found
    expect(envelope.errors.some(e => e.code === 'task_not_found')).toBe(true);
  });

  it('--no-coverage → coverage.tool="none" + warning, runCoverage NOT called', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const stubCoverage = makeRunCoverageStub();
    const spawn = makeSpawnStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--no-coverage'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.coverage.tool).toBe('none');
    expect(envelope.warnings.some(w => w.code === 'coverage_aggregation_skipped')).toBe(true);
    expect(stubCoverage.calls.length).toBe(0);
  });

  it('cross-platform spawn shape — invokes gradlew directly, no bash subprocess', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub();
    const stubCoverage = makeRunCoverageStub();
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    // Find the gradle spawn (skip git probes etc.). isGradleCall sees through
    // the cmd.exe wrapper used on Windows by spawnGradle.
    const gradleCall = spawn.calls.find(isGradleCall);
    expect(gradleCall).toBeTruthy();
    // The orchestrator must invoke gradlew (directly on POSIX, via cmd.exe
    // wrapper on Windows). It must never wrap with bash/powershell.
    const cmd = String(gradleCall.cmd);
    expect(cmd).toMatch(/gradlew(\.bat)?$|(^|[\\/])cmd(\.exe)?$/i);
    expect(/bash|pwsh|powershell/i.test(cmd)).toBe(false);
    // Effective args contain --parallel --continue
    const args = effectiveGradleArgs(gradleCall);
    expect(args).toContain('--parallel');
    expect(args).toContain('--continue');
  });

  it('envelope shape: parallel:{test_type, legs[], max_workers, timeout_s}', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--max-workers', '4', '--timeout', '300'],
      spawn: makeSpawnStub(),
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.parallel).toBeDefined();
    expect(envelope.parallel.test_type).toBe('common');
    expect(envelope.parallel.legs).toEqual([{ test_type: 'common', exit_code: 0 }]);
    expect(envelope.parallel.max_workers).toBe(4);
    expect(envelope.parallel.timeout_s).toBe(300);
  });

  it('--test-type all dispatches multiple legs (closes WS-6)', async () => {
    const dir = makeProject([
      { name: 'shared', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'app', build: 'plugins { id("com.android.application") }\n', sourceSets: ['main', 'androidUnitTest'] },
    ]);
    const spawn = makeSpawnStub();
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'all'],
      spawn,
      env: { KMP_TEST_SKIP_ADB: '1' }, // deterministic across hosts
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    // At minimum 3 legs (common, desktop, androidUnit).
    expect(envelope.parallel.legs.length).toBeGreaterThanOrEqual(3);
    const types = envelope.parallel.legs.map(l => l.test_type);
    expect(types).toContain('common');
    expect(types).toContain('desktop');
    expect(types).toContain('androidUnit');
  });

  it('UX-1: module without target source set goes to skipped[] with reason', async () => {
    const dir = makeProject([
      // Pure JVM module with a JVM test set — survives the auto-skip-untested
      // filter, then UX-1 fires at task-pick time when --test-type ios is asked.
      { name: 'lib', sourceSets: ['main', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub();
    const stubCoverage = makeRunCoverageStub();
    // On non-mac hosts, --test-type ios fails platform_unsupported BEFORE
    // reaching UX-1 — only assert this contract on macOS hosts.
    if (process.platform !== 'darwin') return;
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'ios'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.skipped.length).toBeGreaterThan(0);
    expect(envelope.skipped[0].module).toBe('lib');
    expect(envelope.skipped[0].reason).toMatch(/no ios target/);
  });

  it('UX-2: --module-filter=* + --test-type explicit + post-filter empty → "No modules support the requested --test-type=<X>"', async () => {
    // KaMPKit reproducer: there is no `common` source set framing in any
    // module — they're pure JVM modules tagged `kotlin("jvm")`. Hand the
    // orchestrator a module that resolves to NO unitTestTask via project
    // model. Easiest synthetic: an empty plugin block (analyzeModule returns
    // no source sets, no resolved task).
    const dir = makeProject([{ name: 'noTarget', build: 'plugins {}\n' }]);
    const spawn = makeSpawnStub();
    const stubCoverage = makeRunCoverageStub();
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    const noTestErr = envelope.errors.find(e => e.code === 'no_test_modules');
    expect(noTestErr).toBeTruthy();
    expect(noTestErr.message).toMatch(/No modules support the requested --test-type=common/);
  });
});

// ===========================================================================
// applyModuleFilters
// ===========================================================================
describe('applyModuleFilters', () => {
  // Helper: synthesize a sourceSets map with jvmTest present so the auto-
  // skip-untested filter doesn't drop the module.
  const ss = { sourceSets: { jvmTest: true } };

  it('--module-filter glob matches multiple patterns (kept)', () => {
    const modules = [
      { name: 'core', ...ss },
      { name: 'feature:api', ...ss },
      { name: 'app', ...ss },
    ];
    const r = applyModuleFilters(modules, { moduleFilter: 'core,*:api', excludeModules: '', includeUntested: false }, {});
    expect(r.kept.map(m => m.name).sort()).toEqual(['core', 'feature:api']);
  });

  it('--exclude-modules drops matching modules into skipped[] with reason', () => {
    const modules = [
      { name: 'core', ...ss },
      { name: 'core-test', ...ss },
      { name: 'app', ...ss },
    ];
    const r = applyModuleFilters(modules, { moduleFilter: '*', excludeModules: '*-test', includeUntested: false }, {});
    expect(r.kept.map(m => m.name).sort()).toEqual(['app', 'core']);
    expect(r.skipped.find(s => s.module === 'core-test').reason).toMatch(/excluded by --exclude-modules/);
  });

  it('default --module-filter "*" returns all when test source sets present', () => {
    const modules = [{ name: 'a', ...ss }, { name: 'b', ...ss }, { name: 'c', ...ss }];
    const r = applyModuleFilters(modules, { moduleFilter: '*', excludeModules: '', includeUntested: false }, {});
    expect(r.kept.length).toBe(3);
    expect(r.skipped.length).toBe(0);
  });

  it('auto-skip-untested: modules with no *Test* source set go to skipped[]', () => {
    const modules = [
      { name: 'has-tests', sourceSets: { jvmTest: true } },
      { name: 'no-tests', sourceSets: { main: true } },
    ];
    const r = applyModuleFilters(modules, { moduleFilter: '*', excludeModules: '', includeUntested: false }, {});
    expect(r.kept.map(m => m.name)).toEqual(['has-tests']);
    expect(r.skipped[0].module).toBe('no-tests');
    expect(r.skipped[0].reason).toBe('no test source set');
  });

  it('--include-untested bypasses auto-skip-untested', () => {
    const modules = [
      { name: 'no-tests', sourceSets: { main: true } },
    ];
    const r = applyModuleFilters(modules, { moduleFilter: '*', excludeModules: '', includeUntested: true }, {});
    expect(r.kept.length).toBe(1);
    expect(r.skipped.length).toBe(0);
  });
});

describe('hasAnyTestSourceSet', () => {
  it('true when any *Test* sourceSet entry is true', () => {
    expect(hasAnyTestSourceSet({ sourceSets: { jvmTest: true } })).toBe(true);
    expect(hasAnyTestSourceSet({ sourceSets: { commonTest: true } })).toBe(true);
    expect(hasAnyTestSourceSet({ sourceSets: { iosSimulatorArm64Test: true } })).toBe(true);
  });
  it('false when no *Test* sourceSet present', () => {
    expect(hasAnyTestSourceSet({ sourceSets: { main: true, jvmMain: true } })).toBe(false);
  });
  it('false when sourceSets missing or empty', () => {
    expect(hasAnyTestSourceSet({})).toBe(false);
    expect(hasAnyTestSourceSet({ sourceSets: {} })).toBe(false);
  });
});

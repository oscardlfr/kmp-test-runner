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
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, utimesSync } from 'node:fs';
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
  isInstrumentedOnly,
  pickGradleTaskFor,
  partitionBySkipEnv,
  legsForAll,
  junitTestCountFor,
  junitTestFailuresFor,
  extractTestcaseFailures,
  classifyTaskResults,
  applyModuleFilters,
  hasAnyTestSourceSet,
  discoverParallelModules,
  buildFilterArgs,
  canonicalModuleEntry,
  buildCoverageReportTasks,
} from '../../lib/orchestrators/parallel-orchestrator.js';

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
// canned envelope so the parallel orchestrator can merge it. `warnings`
// (PR-17) mirrors the pre-existing `errors` param — every existing call site
// omits it and implicitly gets `[]`, a no-op merge.
function makeRunCoverageStub({
  coverage = null, errors = null, warnings = null, exitCode = 0,
} = {}) {
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
        errors: errors ?? [],
        warnings: warnings ?? [],
      },
      exitCode,
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

  // v0.9 session 2 Bug-E — `--coverage-only` implies `--skip-tests`. The
  // `parallel --help` text documents the implication; pre-fix the parser set
  // only `coverageOnly`, so `runParallel` still dispatched the test suite
  // before reaching the coverage-only filter at line ~1330.
  it('Bug-E: --coverage-only implies --skip-tests', () => {
    const opts = parseArgs(['--coverage-only']);
    expect(opts.coverageOnly).toBe(true);
    expect(opts.skipTests).toBe(true);
  });
  it('Bug-E: --coverage-only with explicit --skip-tests is idempotent', () => {
    const opts = parseArgs(['--coverage-only', '--skip-tests']);
    expect(opts.coverageOnly).toBe(true);
    expect(opts.skipTests).toBe(true);
  });

  it('parses v0.9 step 1 parity-gap flags (#1-#5)', () => {
    const opts = parseArgs([
      '--device', 'DEVICE_SERIAL_FAKE',
      '--device-task', 'androidConnectedCheck',
      '--auto-retry',
      '--clear-data',
      '--flavor', 'staging',
    ]);
    expect(opts.device).toBe('DEVICE_SERIAL_FAKE');
    expect(opts.deviceTaskOverride).toBe('androidConnectedCheck');
    expect(opts.autoRetry).toBe(true);
    expect(opts.clearData).toBe(true);
    expect(opts.flavor).toBe('staging');
  });

  it('v0.9 parity flags default to off / empty', () => {
    const opts = parseArgs([]);
    expect(opts.device).toBe('');
    expect(opts.deviceTaskOverride).toBe('');
    expect(opts.autoRetry).toBe(false);
    expect(opts.clearData).toBe(false);
    expect(opts.flavor).toBe('');
  });

  it('--capture-on-fail / --capture-dir parse; --capture-dir implies --capture-on-fail', () => {
    expect(parseArgs([]).captureOnFail).toBe(false);
    expect(parseArgs([]).captureDir).toBe('');
    expect(parseArgs(['--capture-on-fail']).captureOnFail).toBe(true);
    const withDir = parseArgs(['--capture-dir', 'build/kmp-captures']);
    expect(withDir.captureDir).toBe('build/kmp-captures');
    // --capture-dir implies --capture-on-fail (mirrors kmp-test android).
    expect(withDir.captureOnFail).toBe(true);
  });

  it('v0.9 step 2 — --gradle-args accumulates across multiple invocations', () => {
    const opts = parseArgs([
      '--gradle-args', '--no-parallel',
      '--gradle-args', '-Pfoo=bar',
    ]);
    expect(opts.gradleArgs).toEqual(['--no-parallel', '-Pfoo=bar']);
  });

  it('v0.9 step 2 — --gradle-args whitespace-splits a single multi-token argument', () => {
    const opts = parseArgs([
      '--gradle-args', '--no-parallel --max-workers 1 -Pfoo=bar',
    ]);
    expect(opts.gradleArgs).toEqual(['--no-parallel', '--max-workers', '1', '-Pfoo=bar']);
  });

  it('v0.9 step 2 — gradleArgs default is empty array', () => {
    const opts = parseArgs([]);
    expect(opts.gradleArgs).toEqual([]);
  });
});

describe('expandNoCoverageAlias', () => {
  it('substitutes --no-coverage in place', () => {
    expect(expandNoCoverageAlias(['--foo', '--no-coverage', '--bar']))
      .toEqual(['--foo', '--coverage-tool', 'none', '--bar']);
  });
  // Wet audit 2026-05-08 (cell I1c): `--gradle-args=--info` (POSIX = form)
  // was silently dropped because the switch matches the FULL token. Split
  // `--flag=value` into `[--flag, value]` so callers can use either syntax.
  it('splits --flag=value into [--flag, value]', () => {
    expect(expandNoCoverageAlias(['--gradle-args=--info']))
      .toEqual(['--gradle-args', '--info']);
    expect(expandNoCoverageAlias(['--module-filter=sample-result']))
      .toEqual(['--module-filter', 'sample-result']);
    expect(expandNoCoverageAlias(['--test-type=common']))
      .toEqual(['--test-type', 'common']);
  });
  it('splits on first = only (value may contain =)', () => {
    expect(expandNoCoverageAlias(['--gradle-args=-Pfoo=bar']))
      .toEqual(['--gradle-args', '-Pfoo=bar']);
  });
  it('does NOT split short flags or non-flag tokens with =', () => {
    expect(expandNoCoverageAlias(['-Pfoo=bar', 'core=err']))
      .toEqual(['-Pfoo=bar', 'core=err']);
  });
  it('parseArgs accepts --module-filter=value (= form)', () => {
    const opts = parseArgs(['--module-filter=sample-result']);
    expect(opts.moduleFilter).toBe('sample-result');
  });
  it('parseArgs accepts --test-type=value (= form)', () => {
    const opts = parseArgs(['--test-type=common']);
    expect(opts.testType).toBe('common');
    expect(opts.testTypeExplicit).toBe(true);
  });
  it('parseArgs accepts --gradle-args=value (= form)', () => {
    const opts = parseArgs(['--gradle-args=--info --rerun-tasks']);
    expect(opts.gradleArgs).toEqual(['--info', '--rerun-tasks']);
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
    sourceSets: { test: true, androidUnitTest: false, commonTest: false },
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

  it('--test-type common/desktop excludes testAndroidHostTest (belongs to androidUnit leg)', () => {
    const mod = {
      name: 'shared', type: 'kmp', androidDsl: null,
      androidDslVariant: 'kmpAndroidLibrary',
      sourceSets: { androidUnitTest: true, commonTest: true },
      resolved: { unitTestTask: 'testAndroidHostTest' },
    };
    expect(pickGradleTaskFor(mod, 'common').task).toBeNull();
    expect(pickGradleTaskFor(mod, 'common').reason).toMatch(/no common target/);
    expect(pickGradleTaskFor(mod, 'desktop').task).toBeNull();
  });

  it('testAndroidHostTest dispatches via androidUnit only — no double-dispatch across legs', () => {
    // Guards --test-type all: legsForAll() runs 'common' and 'androidUnit' as
    // separate legs: without the exclusion above, both would resolve to the
    // same gradle task for a kmpAndroidLibrary host-test-only module.
    const mod = {
      name: 'shared', type: 'kmp', androidDsl: null,
      androidDslVariant: 'kmpAndroidLibrary',
      sourceSets: { androidUnitTest: true, commonTest: true },
      resolved: { unitTestTask: 'testAndroidHostTest' },
    };
    expect(pickGradleTaskFor(mod, 'common').task).toBeNull();
    expect(pickGradleTaskFor(mod, 'androidUnit').task).toBe(':shared:testAndroidHostTest');
  });

  it('default (no --test-type) dispatches testAndroidHostTest identically whether unitTestTask is pre- or post-fix', () => {
    // Documents that the default/auto-pick case is genuinely unaffected by
    // the resolveTasksFor fallback — same final task, resolved via a
    // different internal path (own inline fallback vs. the now-populated
    // resolved field).
    const base = {
      name: 'shared', type: 'kmp', androidDslVariant: 'kmpAndroidLibrary',
      sourceSets: { androidUnitTest: true },
    };
    expect(pickGradleTaskFor({ ...base, resolved: { unitTestTask: null } }, undefined).task)
      .toBe(':shared:testAndroidHostTest');
    expect(pickGradleTaskFor({ ...base, resolved: { unitTestTask: 'testAndroidHostTest' } }, undefined).task)
      .toBe(':shared:testAndroidHostTest');
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
    // 2026-05-04 Bug A — fallback now requires source-set evidence
    // (androidInstrumentedTest / androidTest) to avoid over-dispatching to
    // KMP+androidLibrary modules that lack the source set entirely.
    const kmpWithAndroid = {
      name: 'kmp-and', type: 'kmp', androidDsl: true,
      sourceSets: { androidInstrumentedTest: true },
      resolved: { deviceTestTask: null },
    };
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

  // 2026-05-03 — Android variant flag. Default --variant=auto preserves the
  // historical fast-path (testDebugUnitTest); --variant=release and =all
  // route to the matching task names. testBuildType="release" detected
  // statically also flips the auto pick.
  describe('--variant flag for Android unit tests', () => {
    it('--variant debug → testDebugUnitTest (default)', () => {
      expect(pickGradleTaskFor(androidModule, 'androidUnit', { androidVariant: 'debug' }).task)
        .toBe(':app:testDebugUnitTest');
    });

    it('--variant release → testReleaseUnitTest', () => {
      expect(pickGradleTaskFor(androidModule, 'androidUnit', { androidVariant: 'release' }).task)
        .toBe(':app:testReleaseUnitTest');
    });

    it('--variant all → test (umbrella runs both Debug + Release)', () => {
      expect(pickGradleTaskFor(androidModule, 'androidUnit', { androidVariant: 'all' }).task)
        .toBe(':app:test');
    });

    it('--variant auto + testBuildType="release" → testReleaseUnitTest', () => {
      const releaseModule = { ...androidModule, testBuildType: 'release' };
      expect(pickGradleTaskFor(releaseModule, 'androidUnit', { androidVariant: 'auto' }).task)
        .toBe(':app:testReleaseUnitTest');
    });

    it('--variant auto + no testBuildType → testDebugUnitTest (AGP default)', () => {
      expect(pickGradleTaskFor(androidModule, 'androidUnit', { androidVariant: 'auto' }).task)
        .toBe(':app:testDebugUnitTest');
    });

    it('default (no opts) → testDebugUnitTest (backward compat)', () => {
      expect(pickGradleTaskFor(androidModule, 'androidUnit').task)
        .toBe(':app:testDebugUnitTest');
    });

    it('default test-type (auto) honors --variant', () => {
      expect(pickGradleTaskFor(androidModule, '', { androidVariant: 'release' }).task)
        .toBe(':app:testReleaseUnitTest');
      expect(pickGradleTaskFor(androidModule, '', { androidVariant: 'all' }).task)
        .toBe(':app:test');
    });
  });

  // 2026-05-05 — fix-PR-F: --variant flag on androidInstrumented dispatch.
  // Mirror of the androidUnit variant suite. The fallback path for AGP
  // modules without a probed deviceTestTask must honor --variant +
  // mod.testBuildType to fix di-sample :benchmark (testBuildType =
  // "release" → only :benchmark:connectedReleaseAndroidTest exists).
  describe('--variant flag for Android instrumented tests', () => {
    // Fixture: AGP-fallback path (deviceTestTask null forces fallback to
    // androidConnectedTask). Mirrors line ~394-415 fallback in pickGradleTaskFor.
    const fallbackModule = {
      name: 'app',
      type: 'android',
      androidDsl: true,
      sourceSets: { androidInstrumentedTest: true },
      resolved: { deviceTestTask: null },
    };

    it('--variant auto + testBuildType="release" → connectedReleaseAndroidTest', () => {
      const releaseModule = { ...fallbackModule, testBuildType: 'release' };
      expect(pickGradleTaskFor(releaseModule, 'androidInstrumented', { androidVariant: 'auto' }).task)
        .toBe(':app:connectedReleaseAndroidTest');
    });

    it('--variant debug overrides testBuildType="release" → connectedDebugAndroidTest', () => {
      const releaseModule = { ...fallbackModule, testBuildType: 'release' };
      expect(pickGradleTaskFor(releaseModule, 'androidInstrumented', { androidVariant: 'debug' }).task)
        .toBe(':app:connectedDebugAndroidTest');
    });

    it('--variant auto + no testBuildType → connectedDebugAndroidTest (AGP default)', () => {
      expect(pickGradleTaskFor(fallbackModule, 'androidInstrumented', { androidVariant: 'auto' }).task)
        .toBe(':app:connectedDebugAndroidTest');
    });

    it('--variant all → connectedAndroidTest (AGP lifecycle umbrella)', () => {
      expect(pickGradleTaskFor(fallbackModule, 'androidInstrumented', { androidVariant: 'all' }).task)
        .toBe(':app:connectedAndroidTest');
    });

    it('kmpAndroidLibrary branch: --variant is no-op, still dispatches androidConnectedCheck', () => {
      const kmpAndroidLib = {
        name: 'kmp-feat',
        type: 'kmp',
        androidDsl: true,
        androidDslVariant: 'kmpAndroidLibrary',
        sourceSets: { androidDeviceTest: true },
        resolved: { deviceTestTask: null },
      };
      expect(pickGradleTaskFor(kmpAndroidLib, 'androidInstrumented', { androidVariant: 'release' }).task)
        .toBe(':kmp-feat:androidConnectedCheck');
      expect(pickGradleTaskFor(kmpAndroidLib, 'androidInstrumented', { androidVariant: 'all' }).task)
        .toBe(':kmp-feat:androidConnectedCheck');
    });
  });

  // 2026-05-05 v0.9 step 1 (flag #4) — `--flavor <name>` weaves into
  // `connected${Cap}${Variant}AndroidTest`. Modules with hasFlavor=true
  // get the flavor weave; modules without hasFlavor see the flag as a no-op
  // (parallel.warnings[].code='flavor_unused' surfaces at the runParallel
  // level when no module has hasFlavor at all).
  describe('--flavor weave on androidConnectedTask (v0.9 step 1, flag #4)', () => {
    const flavorModule = {
      name: 'app',
      type: 'android',
      androidDsl: true,
      hasFlavor: true,
      sourceSets: { androidInstrumentedTest: true },
      resolved: { deviceTestTask: null },
    };

    it('--flavor staging --variant debug → connectedStagingDebugAndroidTest', () => {
      expect(pickGradleTaskFor(flavorModule, 'androidInstrumented', {
        androidVariant: 'debug', flavor: 'staging',
      }).task).toBe(':app:connectedStagingDebugAndroidTest');
    });

    it('--flavor staging --variant release → connectedStagingReleaseAndroidTest', () => {
      expect(pickGradleTaskFor(flavorModule, 'androidInstrumented', {
        androidVariant: 'release', flavor: 'staging',
      }).task).toBe(':app:connectedStagingReleaseAndroidTest');
    });

    it('--flavor staging --variant all → connectedStagingAndroidTest (umbrella)', () => {
      expect(pickGradleTaskFor(flavorModule, 'androidInstrumented', {
        androidVariant: 'all', flavor: 'staging',
      }).task).toBe(':app:connectedStagingAndroidTest');
    });

    it('--flavor staging --variant auto + testBuildType=release → connectedStagingReleaseAndroidTest', () => {
      const releaseFlavor = { ...flavorModule, testBuildType: 'release' };
      expect(pickGradleTaskFor(releaseFlavor, 'androidInstrumented', {
        androidVariant: 'auto', flavor: 'staging',
      }).task).toBe(':app:connectedStagingReleaseAndroidTest');
    });

    it('--flavor staging on a module without hasFlavor → no-op (no flavor in task name)', () => {
      const flatModule = {
        ...flavorModule,
        hasFlavor: false,
      };
      expect(pickGradleTaskFor(flatModule, 'androidInstrumented', {
        androidVariant: 'debug', flavor: 'staging',
      }).task).toBe(':app:connectedDebugAndroidTest');
    });
  });

  // Finding #2 — flavored androidUnit dispatch. Convention-applied flavors
  // (effectiveHasFlavor, recovered from the probe even when static
  // hasFlavor=false) weave the flavor into the unit task; no --flavor falls back
  // to the flavor-agnostic umbrella `test` (a bare testDebugUnitTest is ambiguous
  // under flavors and fails task_not_found).
  describe('--flavor weave + umbrella on androidUnitTask (Finding #2)', () => {
    const flavored = {
      name: 'app',
      type: 'android',
      androidDsl: true,
      hasFlavor: false,            // static is blind (convention-applied)...
      effectiveHasFlavor: true,    // ...probe-recovered
      flavors: ['demo', 'prod'],
      sourceSets: { test: true },
      resolved: { unitTestTask: 'test', flavors: ['demo', 'prod'] },
    };

    it('--flavor demo --variant debug → testDemoDebugUnitTest', () => {
      expect(pickGradleTaskFor(flavored, 'androidUnit', { androidVariant: 'debug', flavor: 'demo' }).task)
        .toBe(':app:testDemoDebugUnitTest');
    });

    it('--flavor demo --variant release → testDemoReleaseUnitTest', () => {
      expect(pickGradleTaskFor(flavored, 'androidUnit', { androidVariant: 'release', flavor: 'demo' }).task)
        .toBe(':app:testDemoReleaseUnitTest');
    });

    it('--flavor prod --variant auto → testProdDebugUnitTest', () => {
      expect(pickGradleTaskFor(flavored, 'androidUnit', { androidVariant: 'auto', flavor: 'prod' }).task)
        .toBe(':app:testProdDebugUnitTest');
    });

    it('no --flavor → umbrella :app:test (the always-correct default), even with --variant debug', () => {
      expect(pickGradleTaskFor(flavored, 'androidUnit', { androidVariant: 'auto' }).task)
        .toBe(':app:test');
      expect(pickGradleTaskFor(flavored, 'androidUnit', { androidVariant: 'debug' }).task)
        .toBe(':app:test');
    });

    it('--variant all → umbrella :app:test', () => {
      expect(pickGradleTaskFor(flavored, 'androidUnit', { androidVariant: 'all', flavor: 'demo' }).task)
        .toBe(':app:test');
    });

    it('capitalization: --flavor Demo (already capitalized) → testDemoDebugUnitTest', () => {
      expect(pickGradleTaskFor(flavored, 'androidUnit', { androidVariant: 'debug', flavor: 'Demo' }).task)
        .toBe(':app:testDemoDebugUnitTest');
    });

    it('static hasFlavor=true (per-module declaration) also weaves', () => {
      const staticFlavor = {
        name: 'app', type: 'android', androidDsl: true, hasFlavor: true,
        sourceSets: { test: true }, resolved: { unitTestTask: 'test' },
      };
      expect(pickGradleTaskFor(staticFlavor, 'androidUnit', { androidVariant: 'debug', flavor: 'demo' }).task)
        .toBe(':app:testDemoDebugUnitTest');
    });

    it('instrumented parity: --flavor demo → connectedDemoDebugAndroidTest; no flavor → umbrella connectedAndroidTest', () => {
      const flavoredInstr = {
        name: 'app', type: 'android', androidDsl: true, effectiveHasFlavor: true,
        flavors: ['demo', 'prod'], sourceSets: { androidInstrumentedTest: true },
        resolved: { deviceTestTask: null, flavors: ['demo', 'prod'] },
      };
      expect(pickGradleTaskFor(flavoredInstr, 'androidInstrumented', { androidVariant: 'debug', flavor: 'demo' }).task)
        .toBe(':app:connectedDemoDebugAndroidTest');
      expect(pickGradleTaskFor(flavoredInstr, 'androidInstrumented', { androidVariant: 'debug' }).task)
        .toBe(':app:connectedAndroidTest');
    });

    it('REGRESSION: non-flavored module is byte-identical (--flavor is a no-op)', () => {
      const flat = {
        name: 'app', type: 'android', androidDsl: true,
        sourceSets: { test: true }, resolved: { unitTestTask: null },
      };
      expect(pickGradleTaskFor(flat, 'androidUnit', { androidVariant: 'debug', flavor: 'demo' }).task)
        .toBe(':app:testDebugUnitTest');
      expect(pickGradleTaskFor(flat, 'androidUnit', { androidVariant: 'auto' }).task)
        .toBe(':app:testDebugUnitTest');
    });
  });

  // 2026-05-05 v0.9 step 1 (flag #5) — `--device-task <name>` preempts every
  // other resolution path on the androidInstrumented branch. Mirrors the
  // dedicated `kmp-test android` subcommand's escape hatch (BACKLOG L195-198).
  describe('--device-task override (v0.9 step 1, flag #5)', () => {
    it('preempts deviceTestTask probe', () => {
      expect(pickGradleTaskFor(androidModule, 'androidInstrumented', {
        deviceTaskOverride: 'androidConnectedCheck',
      }).task).toBe(':app:androidConnectedCheck');
    });

    it('preempts kmpAndroidLibrary androidConnectedCheck default', () => {
      const kmpLib = {
        name: 'kmp-feat',
        type: 'kmp',
        androidDsl: true,
        androidDslVariant: 'kmpAndroidLibrary',
        sourceSets: { androidDeviceTest: true },
        resolved: { deviceTestTask: null },
      };
      expect(pickGradleTaskFor(kmpLib, 'androidInstrumented', {
        deviceTaskOverride: 'connectedDebugAndroidTest',
      }).task).toBe(':kmp-feat:connectedDebugAndroidTest');
    });

    it('preempts AGP fallback to connected${Variant}AndroidTest', () => {
      const fallbackModule = {
        name: 'app',
        type: 'android',
        androidDsl: true,
        sourceSets: { androidInstrumentedTest: true },
        resolved: { deviceTestTask: null },
        testBuildType: 'release',
      };
      // testBuildType="release" would normally pick connectedReleaseAndroidTest;
      // override forces a different name verbatim.
      expect(pickGradleTaskFor(fallbackModule, 'androidInstrumented', {
        deviceTaskOverride: 'customConnectedTest',
        androidVariant: 'auto',
      }).task).toBe(':app:customConnectedTest');
    });

    it('does NOT apply to non-androidInstrumented test types (e.g. common, ios, androidUnit)', () => {
      // The override is only consumed in the androidInstrumented branch; other
      // branches see opts.deviceTaskOverride but ignore it.
      expect(pickGradleTaskFor(kmpModule, 'common', {
        deviceTaskOverride: 'androidConnectedCheck',
      }).task).toBe(':shared:jvmTest');
      expect(pickGradleTaskFor(kmpModule, 'ios', {
        deviceTaskOverride: 'androidConnectedCheck',
      }).task).toBe(':shared:iosSimulatorArm64Test');
      expect(pickGradleTaskFor(androidModule, 'androidUnit', {
        deviceTaskOverride: 'androidConnectedCheck',
      }).task).toBe(':app:testDebugUnitTest');
    });
  });

  // 2026-05-05 — fix-PR-F-bis: --variant + testBuildType honored even when
  // the project model already resolved a deviceTestTask. Repro from
  // di-sample `:benchmark` post commit 058a520
  // (androidComponents.beforeVariants enabled connectedDebugAndroidTest
  // alongside the testBuildType="release" canonical
  // connectedReleaseAndroidTest). Pre-fix, the early-return on
  // `r.deviceTestTask` returned Debug regardless of testBuildType, and an
  // explicit `--variant release` from the user was bypassed.
  describe('fix-PR-F-bis: probe-populated deviceTestTask + variant + testBuildType', () => {
    const probedReleaseModule = {
      name: 'benchmark',
      type: 'android',
      androidDsl: true,
      sourceSets: { androidTest: true },
      testBuildType: 'release',
      resolved: { deviceTestTask: 'connectedDebugAndroidTest' },
    };
    const probedDebugModule = {
      name: 'app',
      type: 'android',
      androidDsl: true,
      sourceSets: { androidTest: true },
      resolved: { deviceTestTask: 'connectedDebugAndroidTest' },
    };

    it('AGP+source-set+probe(Debug)+testBuildType="release"+variant=auto → connectedReleaseAndroidTest', () => {
      // The exact di-sample `:benchmark` regression case: probe-populated
      // Debug task name is now ignored in favor of testBuildType-aware variant
      // selection in androidConnectedTask.
      expect(pickGradleTaskFor(probedReleaseModule, 'androidInstrumented', { androidVariant: 'auto' }).task)
        .toBe(':benchmark:connectedReleaseAndroidTest');
    });

    it('AGP+source-set+probe(Debug)+testBuildType="release"+variant=debug → user override wins', () => {
      expect(pickGradleTaskFor(probedReleaseModule, 'androidInstrumented', { androidVariant: 'debug' }).task)
        .toBe(':benchmark:connectedDebugAndroidTest');
    });

    it('AGP+source-set+probe(Debug)+no testBuildType+variant=auto → connectedDebugAndroidTest (legacy preserved)', () => {
      expect(pickGradleTaskFor(probedDebugModule, 'androidInstrumented', { androidVariant: 'auto' }).task)
        .toBe(':app:connectedDebugAndroidTest');
    });

    it('AGP NO source-set evidence + probe(Debug) → probe wins (legacy invariant preserved)', () => {
      // Existing "deviceTestTask probe wins over fallback gate" contract from
      // line ~509 below. With no source-set evidence, the AGP+source-set
      // branch is skipped and the probe early-return fires.
      const noSrcMod = {
        name: 'app',
        type: 'android',
        androidDsl: true,
        sourceSets: { androidTest: false, androidInstrumentedTest: false },
        testBuildType: 'release',
        resolved: { deviceTestTask: 'connectedDebugAndroidTest' },
      };
      expect(pickGradleTaskFor(noSrcMod, 'androidInstrumented', { androidVariant: 'auto' }).task)
        .toBe(':app:connectedDebugAndroidTest');
    });
  });

  // 2026-05-04 — Bug A (wide-smoke pass-8): source-set gate for explicit
  // androidUnit / androidInstrumented dispatch. KMP modules with
  // `androidLibrary {}` DSL but no androidUnitTest / androidInstrumentedTest
  // source set must be skipped, not dispatched (AGP doesn't create the task →
  // task_not_found + module_failed). 4 projects affected pre-fix:
  // private-lib (+66 false positives), PrivAndroidApp, di-sample, FileKit-main.
  describe('Bug A: source-set gate for androidUnit/androidInstrumented', () => {
    it('androidUnit: KMP+androidLibrary DSL with no androidUnitTest source set → null', () => {
      const mod = {
        name: 'benchmark-crypto', type: 'kmp', androidDsl: 'androidLibrary',
        sourceSets: { commonTest: true, desktopTest: true, androidUnitTest: false, test: false },
        resolved: { unitTestTask: null },
      };
      const r = pickGradleTaskFor(mod, 'androidUnit');
      expect(r.task).toBeNull();
      expect(r.reason).toMatch(/no androidUnitTest source set/);
    });

    it('androidUnit: KMP+androidLibrary DSL with androidUnitTest source set → dispatches testDebugUnitTest', () => {
      const mod = {
        name: 'app', type: 'kmp', androidDsl: 'androidLibrary',
        sourceSets: { commonTest: true, androidUnitTest: true },
        resolved: { unitTestTask: null },
      };
      expect(pickGradleTaskFor(mod, 'androidUnit').task).toBe(':app:testDebugUnitTest');
    });

    it('androidUnit: pure Android module with src/test/ → dispatches', () => {
      const mod = { name: 'lint', type: 'android', sourceSets: { test: true }, resolved: { unitTestTask: null } };
      expect(pickGradleTaskFor(mod, 'androidUnit').task).toBe(':lint:testDebugUnitTest');
    });

    it('androidUnit: pure Android module without src/test/ → null', () => {
      const mod = { name: 'instrumented-only', type: 'android', sourceSets: { test: false }, resolved: { unitTestTask: null } };
      const r = pickGradleTaskFor(mod, 'androidUnit');
      expect(r.task).toBeNull();
      expect(r.reason).toMatch(/no androidUnitTest source set/);
    });

    it('androidUnit: commonTest alone is NOT enough (Gotcha 1 — AGP needs explicit androidUnitTest)', () => {
      const mod = {
        name: 'common-only', type: 'kmp', androidDsl: 'androidLibrary',
        sourceSets: { commonTest: true, androidUnitTest: false, test: false },
        resolved: { unitTestTask: null },
      };
      expect(pickGradleTaskFor(mod, 'androidUnit').task).toBeNull();
    });

    it('androidInstrumented: KMP+androidLibrary DSL + no androidInstrumentedTest source set + no probe → null', () => {
      const mod = {
        name: 'benchmark-crypto', type: 'kmp', androidDsl: 'androidLibrary',
        sourceSets: { androidInstrumentedTest: false, androidTest: false },
        resolved: { deviceTestTask: null },
      };
      const r = pickGradleTaskFor(mod, 'androidInstrumented');
      expect(r.task).toBeNull();
      expect(r.reason).toMatch(/no androidInstrumentedTest source set/);
    });

    it('androidInstrumented: deviceTestTask probe wins over fallback gate', () => {
      // Source-set evidence is irrelevant when the project model already
      // resolved a deviceTestTask — that's the canonical happy path.
      const mod = {
        name: 'app', type: 'android',
        sourceSets: { androidTest: false, androidInstrumentedTest: false },
        resolved: { deviceTestTask: 'connectedDebugAndroidTest' },
      };
      expect(pickGradleTaskFor(mod, 'androidInstrumented').task).toBe(':app:connectedDebugAndroidTest');
    });
  });

  // 2026-05-04 — Bug D (wide-smoke pass-8 follow-up to Bug A): Google's new
  // KMP-Android plugin `com.android.kotlin.multiplatform.library` (Kotlin 2.3+)
  // uses different test task names than legacy AGP. Host tests dispatch as
  // `testAndroidHostTest` (no Debug/Release variants — the new DSL omits
  // product-flavor support). Device tests dispatch as `androidConnectedCheck`.
  // Modules that declare `withHostTestBuilder {} / withDeviceTestBuilder {}`
  // opt in to test-task generation; without the opt-in, AGP creates no task
  // even if `src/androidUnitTest/` exists on disk. The model surfaces this
  // via `androidDslVariant: 'kmpAndroidLibrary'` and pre-overrides the
  // sourceSets booleans so the orchestrator sees opt-in-aware values.
  describe('Bug D: kmpAndroidLibrary plugin dispatch (testAndroidHostTest / androidConnectedCheck)', () => {
    it('androidUnit: kmpAndroidLibrary with androidUnitTest opt-in → dispatches testAndroidHostTest', () => {
      const mod = {
        name: 'sample-firebase-mod', type: 'kmp', androidDsl: 'androidLibrary',
        androidDslVariant: 'kmpAndroidLibrary',
        sourceSets: { androidUnitTest: true, commonTest: true },
        resolved: { unitTestTask: null },
      };
      const r = pickGradleTaskFor(mod, 'androidUnit');
      expect(r.task).toBe(':sample-firebase-mod:testAndroidHostTest');
      expect(r.reason).toBe('');
    });

    // Surfaced live by v0.9 step 7 wet validation against KaMPKit's `:shared`
    // (2026-05-06). KaMPKit uses the hybrid pattern: `com.android.library`
    // plugin AT THE TOP + `kotlin { android { withHostTestBuilder {} } }`
    // DSL inside the `kotlin {}` block. The parser surfaces type='kmp' +
    // androidDsl=null (no `androidLibrary {}` block) + androidDslVariant=
    // 'kmpAndroidLibrary' (legacy DSL with new opt-in). The orchestrator's
    // androidUnit early-return previously only consulted `type` and
    // `androidDsl`, so this combo hit `'no androidUnit target'` even though
    // `testAndroidHostTest` would have run cleanly. Lock the dispatch.
    it('androidUnit: kmpAndroidLibrary with androidDsl=null (KaMPKit hybrid) → dispatches testAndroidHostTest', () => {
      const mod = {
        name: 'shared', type: 'kmp', androidDsl: null,
        androidDslVariant: 'kmpAndroidLibrary',
        sourceSets: { androidUnitTest: true, commonTest: true, iosTest: true, iosMain: true },
        resolved: { unitTestTask: null },
      };
      const r = pickGradleTaskFor(mod, 'androidUnit');
      expect(r.task).toBe(':shared:testAndroidHostTest');
      expect(r.reason).toBe('');
    });

    it('androidUnit: kmpAndroidLibrary without opt-in → null with withHostTestBuilder reason', () => {
      const mod = {
        name: 'sample-firebase-mod', type: 'kmp', androidDsl: 'androidLibrary',
        androidDslVariant: 'kmpAndroidLibrary',
        sourceSets: { androidUnitTest: false, commonTest: true },
        resolved: { unitTestTask: null },
      };
      const r = pickGradleTaskFor(mod, 'androidUnit');
      expect(r.task).toBeNull();
      expect(r.reason).toMatch(/withHostTestBuilder/);
    });

    it('androidUnit: --variant=release is a no-op for kmpAndroidLibrary (no Debug/Release split)', () => {
      const mod = {
        name: 'sample-firebase-mod', type: 'kmp', androidDsl: 'androidLibrary',
        androidDslVariant: 'kmpAndroidLibrary',
        sourceSets: { androidUnitTest: true },
        resolved: { unitTestTask: null },
      };
      // Pass --variant=release: legacy path would emit testReleaseUnitTest;
      // new plugin path emits testAndroidHostTest regardless of the flag.
      const r = pickGradleTaskFor(mod, 'androidUnit', { androidVariant: 'release' });
      expect(r.task).toBe(':sample-firebase-mod:testAndroidHostTest');
    });

    it('androidInstrumented: kmpAndroidLibrary with androidDeviceTest opt-in → dispatches androidConnectedCheck', () => {
      const mod = {
        name: 'bench-net', type: 'kmp', androidDsl: 'androidLibrary',
        androidDslVariant: 'kmpAndroidLibrary',
        sourceSets: { androidDeviceTest: true, commonTest: true },
        resolved: { deviceTestTask: null },
      };
      const r = pickGradleTaskFor(mod, 'androidInstrumented');
      expect(r.task).toBe(':bench-net:androidConnectedCheck');
      expect(r.reason).toBe('');
    });

    it('androidInstrumented: kmpAndroidLibrary without opt-in → null with withDeviceTestBuilder reason', () => {
      const mod = {
        name: 'sample-firebase-mod', type: 'kmp', androidDsl: 'androidLibrary',
        androidDslVariant: 'kmpAndroidLibrary',
        sourceSets: { androidDeviceTest: false },
        resolved: { deviceTestTask: null },
      };
      const r = pickGradleTaskFor(mod, 'androidInstrumented');
      expect(r.task).toBeNull();
      expect(r.reason).toMatch(/withDeviceTestBuilder/);
    });

    it('regression: legacy androidLibrary (androidDslVariant null) still dispatches testDebugUnitTest', () => {
      // Guards Bug D from accidentally swallowing the legacy path. KMP modules
      // using the deprecated `androidTarget()` shape (or any path where the
      // model didn't tag kmpAndroidLibrary) must continue to dispatch the
      // legacy variant-aware task name.
      const mod = {
        name: 'legacy-shared', type: 'kmp', androidDsl: 'androidLibrary',
        androidDslVariant: null,
        sourceSets: { androidUnitTest: true, commonTest: true },
        resolved: { unitTestTask: null },
      };
      const r = pickGradleTaskFor(mod, 'androidUnit');
      expect(r.task).toBe(':legacy-shared:testDebugUnitTest');
    });
  });

  // 2026-05-03 — instrumented-only Android module skip (di-sample
  // :benchmark repro). No `test/`, `androidUnitTest/`, or `commonTest/`
  // source set → orchestrator skips with reason instead of dispatching a
  // hardcoded task name that gradle doesn't have.
  describe('instrumented-only Android module skip', () => {
    it('Android module with only androidTest/ source set → actionable skip + hint', () => {
      const benchmarkModule = {
        name: 'benchmark',
        type: 'android',
        androidDsl: true,
        sourceSets: { test: false, androidUnitTest: false, commonTest: false, androidTest: true },
        resolved: null,
      };
      const result = pickGradleTaskFor(benchmarkModule, '');
      expect(result.task).toBeNull();
      // Reason now points the user at the fix (was the opaque
      // "no androidUnit source set (instrumented-only?)").
      expect(result.reason).toMatch(/instrumented-only/i);
      expect(result.reason).toMatch(/androidInstrumented/);
      expect(result.hint).toBe('instrumented_only');
    });

    it('Android module with test/ source set → dispatches normally', () => {
      const result = pickGradleTaskFor(androidModule, '');
      expect(result.task).toBe(':app:testDebugUnitTest');
    });

    it('KMP module that is instrumented-only → hint (was a silent generic skip)', () => {
      // Regression: a KMP module (type='kmp', no JVM target so unitTestTask is
      // null) with only androidInstrumentedTest used to fall through to the
      // opaque "no resolvable test task". It must now carry the hint.
      const kmpInstrumented = {
        name: 'ui',
        type: 'kmp',
        sourceSets: { androidInstrumentedTest: true },
        resolved: { unitTestTask: null },
      };
      const result = pickGradleTaskFor(kmpInstrumented, '');
      expect(result.task).toBeNull();
      expect(result.reason).toMatch(/androidInstrumented/);
      expect(result.hint).toBe('instrumented_only');
    });

    it('explicit --test-type androidUnit on instrumented-only → hint', () => {
      const mod = {
        name: 'compose-ui',
        type: 'android',
        androidDsl: true,
        sourceSets: { androidInstrumentedTest: true },
        resolved: null,
      };
      const result = pickGradleTaskFor(mod, 'androidUnit');
      expect(result.task).toBeNull();
      expect(result.hint).toBe('instrumented_only');
    });

    it('module WITH unit tests → no hint', () => {
      const result = pickGradleTaskFor(androidModule, '');
      expect(result.hint).toBeUndefined();
    });
  });

  describe('isInstrumentedOnly predicate', () => {
    it('instrumented source set + no unit source → true', () => {
      expect(isInstrumentedOnly({ sourceSets: { androidInstrumentedTest: true } })).toBe(true);
      expect(isInstrumentedOnly({ sourceSets: { androidTest: true } })).toBe(true);
      expect(isInstrumentedOnly({ sourceSets: { androidDeviceTest: true } })).toBe(true);
    });

    it('has a unit source set alongside instrumented → false', () => {
      expect(isInstrumentedOnly({ sourceSets: { androidTest: true, androidUnitTest: true } })).toBe(false);
      expect(isInstrumentedOnly({ sourceSets: { androidTest: true, commonTest: true } })).toBe(false);
      expect(isInstrumentedOnly({ sourceSets: { androidTest: true }, flavors: ['staging'] })).toBe(false);
    });

    it('NO test source sets at all → false (that is "no tests", not instrumented-only)', () => {
      expect(isInstrumentedOnly({ sourceSets: { androidMain: true } })).toBe(false);
      expect(isInstrumentedOnly({ sourceSets: {} })).toBe(false);
      expect(isInstrumentedOnly({})).toBe(false);
    });
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

  // v0.8.0 — config-file fallback for SKIP_*_MODULES precedence chain
  it('config skip.android falls through when env is unset → reason includes [config] suffix', () => {
    const r = partitionBySkipEnv(modules, 'androidUnit', {}, { skip: { android: ['core'] } });
    expect(r.kept.map(m => m.name)).toEqual(['feature:domain', 'app']);
    expect(r.skipped[0].module).toBe('core');
    expect(r.skipped[0].reason).toMatch(/SKIP_ANDROID_MODULES \(core\) \[config\]/);
  });

  it('env SKIP_ANDROID_MODULES wins over config skip.android (precedence: env > config)', () => {
    const r = partitionBySkipEnv(
      modules,
      'androidUnit',
      { SKIP_ANDROID_MODULES: 'app' },         // env says skip "app"
      { skip: { android: ['core'] } },         // config says skip "core" — should be ignored
    );
    expect(r.kept.map(m => m.name)).toEqual(['core', 'feature:domain']);
    expect(r.skipped[0].module).toBe('app');
    // No [config] suffix because env supplied the value.
    expect(r.skipped[0].reason).not.toMatch(/\[config\]/);
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

  // OBS-A from 2026-05-09 — symmetric counting on AGP path.
  it('counts testcases in AGP outputs/androidTest-results/connected/ for instrumented tasks', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-test-'));
    workDir = dir;
    const agpDir = path.join(
      dir, 'mod', 'build', 'outputs', 'androidTest-results',
      'connected', 'androidMain',
    );
    mkdirSync(agpDir, { recursive: true });
    writeFileSync(path.join(agpDir, 'TEST-Foo.xml'),
      '<testsuite><testcase/><testcase/></testsuite>');
    expect(junitTestCountFor(dir, ':mod:androidConnectedCheck')).toBe(2);
  });

  // Finding #2 — the umbrella `test` task (dispatched for flavored androidUnit
  // with no --flavor) has no JUnit output of its own; it aggregates the
  // per-variant test${Flavor}${BuildType}UnitTest tasks whose XML lands in
  // sibling test-results/<variant>UnitTest/ dirs.
  it('umbrella `test` aggregates per-variant test*UnitTest result dirs', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-test-'));
    workDir = dir;
    const trRoot = path.join(dir, 'core', 'build', 'test-results');
    for (const [variant, n] of [['testDemoDebugUnitTest', 3], ['testProdDebugUnitTest', 2]]) {
      const vd = path.join(trRoot, variant);
      mkdirSync(vd, { recursive: true });
      writeFileSync(path.join(vd, 'TEST-Foo.xml'),
        '<testsuite>' + '<testcase/>'.repeat(n) + '</testsuite>');
    }
    expect(junitTestCountFor(dir, ':core:test')).toBe(5);
  });

  it('non-umbrella JVM `test` counts only test-results/test/ (no *UnitTest aggregation)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-test-'));
    workDir = dir;
    const testDir = path.join(dir, 'core', 'build', 'test-results', 'test');
    mkdirSync(testDir, { recursive: true });
    writeFileSync(path.join(testDir, 'TEST-Bar.xml'), '<testsuite><testcase/><testcase/></testsuite>');
    expect(junitTestCountFor(dir, ':core:test')).toBe(2);
  });
});

// ===========================================================================
// wet-audit-v0.9-part2 BUG-1 — junit XML failure extraction
// ===========================================================================
describe('extractTestcaseFailures (BUG-1)', () => {
  it('skips passing self-closing testcases', () => {
    const xml = '<testsuite><testcase name="ok" classname="C" time="0.1"/></testsuite>';
    const out = [];
    extractTestcaseFailures(xml, out);
    expect(out).toEqual([]);
  });

  it('skips skipped tests (AssumptionViolatedException etc.)', () => {
    const xml = `<testsuite>
      <testcase name="skipped" classname="C" time="0.1">
        <skipped message="org.junit.AssumptionViolatedException" type="org.junit.AssumptionViolatedException"/>
      </testcase>
    </testsuite>`;
    const out = [];
    extractTestcaseFailures(xml, out);
    expect(out).toEqual([]);
  });

  it('extracts <failure> children with type + message attrs', () => {
    const xml = `<testsuite>
      <testcase name="testFoo" classname="com.example.FooTest" time="0.1">
        <failure type="java.lang.AssertionError" message="expected: &lt;true&gt; but was: &lt;false&gt;">
          full stack trace here
        </failure>
      </testcase>
    </testsuite>`;
    const out = [];
    extractTestcaseFailures(xml, out);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      test: 'com.example.FooTest.testFoo',
      cause: 'expected: <true> but was: <false>',
      type: 'java.lang.AssertionError',
    });
  });

  it('extracts <error> children (test infrastructure errors)', () => {
    const xml = `<testsuite>
      <testcase name="testBar" classname="com.example.BarTest">
        <error type="java.lang.RuntimeException" message="setup failed"/>
      </testcase>
    </testsuite>`;
    const out = [];
    extractTestcaseFailures(xml, out);
    expect(out).toHaveLength(1);
    expect(out[0].cause).toBe('setup failed');
    expect(out[0].type).toBe('java.lang.RuntimeException');
  });

  it('falls back to first body line when message attr missing', () => {
    const xml = `<testsuite>
      <testcase name="testBaz" classname="com.example.BazTest">
        <failure type="kotlin.AssertionError">kotlin.AssertionError: assertion failed
at com.example.BazTest.testBaz(BazTest.kt:42)</failure>
      </testcase>
    </testsuite>`;
    const out = [];
    extractTestcaseFailures(xml, out);
    expect(out[0].cause).toBe('kotlin.AssertionError: assertion failed');
  });

  it('handles multiple testcases with mixed pass / fail / skip', () => {
    const xml = `<testsuite>
      <testcase name="pass" classname="C"/>
      <testcase name="fail1" classname="C"><failure type="E" message="m1"/></testcase>
      <testcase name="skipped" classname="C"><skipped/></testcase>
      <testcase name="fail2" classname="C"><failure type="F" message="m2"/></testcase>
    </testsuite>`;
    const out = [];
    extractTestcaseFailures(xml, out);
    expect(out.map(f => f.test)).toEqual(['C.fail1', 'C.fail2']);
  });
});

describe('junitTestFailuresFor (BUG-1)', () => {
  it('walks build/test-results/<task>/TEST-*.xml and aggregates failures', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-fail-'));
    workDir = dir;
    const taskDir = path.join(dir, 'core', 'build', 'test-results', 'jvmTest');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(path.join(taskDir, 'TEST-com.foo.AlphaTest.xml'),
      '<testsuite><testcase name="ok" classname="com.foo.AlphaTest"/>' +
      '<testcase name="bad" classname="com.foo.AlphaTest">' +
      '<failure type="AssertionError" message="alpha bad"/></testcase></testsuite>');
    writeFileSync(path.join(taskDir, 'TEST-com.foo.BetaTest.xml'),
      '<testsuite><testcase name="bad" classname="com.foo.BetaTest">' +
      '<failure type="AssertionError" message="beta bad"/></testcase></testsuite>');
    const failures = junitTestFailuresFor(dir, ':core:jvmTest');
    expect(failures).toHaveLength(2);
    expect(failures.map(f => f.test).sort()).toEqual([
      'com.foo.AlphaTest.bad',
      'com.foo.BetaTest.bad',
    ]);
  });

  it('returns [] when directory missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-fail-'));
    workDir = dir;
    expect(junitTestFailuresFor(dir, ':missing:test')).toEqual([]);
  });

  it('respects sinceMs stale-XML guard', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-fail-'));
    workDir = dir;
    const taskDir = path.join(dir, 'core', 'build', 'test-results', 'jvmTest');
    mkdirSync(taskDir, { recursive: true });
    const xmlPath = path.join(taskDir, 'TEST-Stale.xml');
    writeFileSync(xmlPath,
      '<testsuite><testcase name="bad" classname="C"><failure message="stale"/></testcase></testsuite>');
    // Future sinceMs filters out the file regardless of mtime.
    const future = Date.now() + 60_000;
    expect(junitTestFailuresFor(dir, ':core:jvmTest', future)).toEqual([]);
    // sinceMs=0 disables the guard.
    expect(junitTestFailuresFor(dir, ':core:jvmTest', 0)).toHaveLength(1);
  });

  // OBS-A from 2026-05-09 wet-audit (private-lib bench-store).
  // AGP's androidConnectedCheck (and connected${Variant}AndroidTest)
  // emit JUnit XML to `build/outputs/androidTest-results/connected/
  // <sourceSet>/TEST-*.xml`, NOT `build/test-results/<task>/`. Pre-fix
  // junitTestFailuresFor only walked the latter, so failures from
  // instrumented tasks never populated `modules[].test_failures[]` —
  // agents had to walk the file system to discriminate.
  it('walks AGP outputs/androidTest-results/connected/ path for instrumented tasks', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-fail-'));
    workDir = dir;
    const agpDir = path.join(
      dir, 'bench-store', 'build', 'outputs', 'androidTest-results',
      'connected', 'androidMain',
    );
    mkdirSync(agpDir, { recursive: true });
    writeFileSync(
      path.join(agpDir, 'TEST-SM-S908B - 16-_bench-store-.xml'),
      '<testsuite name="com.foo.StressTest" tests="2" failures="1">' +
      '<testcase name="passes" classname="com.foo.StressTest" time="0.1"/>' +
      '<testcase name="oomFails" classname="com.foo.StressTest" time="42.0">' +
      '<failure type="java.lang.OutOfMemoryError" message="heap exhausted"/>' +
      '</testcase></testsuite>'
    );
    const failures = junitTestFailuresFor(dir, ':bench-store:androidConnectedCheck');
    expect(failures).toHaveLength(1);
    expect(failures[0].test).toBe('com.foo.StressTest.oomFails');
    expect(failures[0].type).toBe('java.lang.OutOfMemoryError');
  });

  it('walks BOTH test-results/<task>/ AND outputs/androidTest-results/connected/ (instrumented + JVM unioned)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-junit-fail-'));
    workDir = dir;
    // Legacy path (some KMP/AGP setups emit BOTH paths for connectedCheck —
    // gradle JvmTestTask + AGP's connected aggregator). Make sure we don't
    // duplicate-count or skip either source.
    const legacyDir = path.join(dir, 'mod', 'build', 'test-results', 'androidConnectedCheck');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(path.join(legacyDir, 'TEST-LegacyClass.xml'),
      '<testsuite><testcase name="legacy_fail" classname="com.foo.LegacyClass">' +
      '<failure type="AssertionError" message="legacy bad"/></testcase></testsuite>');
    const agpDir = path.join(
      dir, 'mod', 'build', 'outputs', 'androidTest-results', 'connected', 'androidMain',
    );
    mkdirSync(agpDir, { recursive: true });
    writeFileSync(path.join(agpDir, 'TEST-AgpClass.xml'),
      '<testsuite><testcase name="agp_fail" classname="com.foo.AgpClass">' +
      '<failure type="AssertionError" message="agp bad"/></testcase></testsuite>');
    const failures = junitTestFailuresFor(dir, ':mod:androidConnectedCheck');
    const tests = failures.map(f => f.test).sort();
    expect(tests).toEqual([
      'com.foo.AgpClass.agp_fail',
      'com.foo.LegacyClass.legacy_fail',
    ]);
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

  // ---------------------------------------------------------------------
  // Side-effect-purity regression locks (dry-run must never spawn gradle,
  // probe adb, dispatch coverage/benchmark, or touch .kmp-test-runner/).
  // These characterize behavior already correct in runParallel's own
  // dry-run short-circuit (line 335) — the actual reachable bug for the
  // real CLI lives one layer up, in the dispatcher's resolveDryRunModules
  // (lib/parsers/script-output.js), covered separately in cli.test.js and
  // script-dispatcher.test.js.
  // ---------------------------------------------------------------------
  it('--dry-run --fresh-daemon does not spawn gradle at all (no gradlew --stop)', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain'] }]);
    const spawn = makeSpawnStub();
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--dry-run', '--test-type', 'common', '--fresh-daemon'],
      spawn,
      log: () => {},
    });
    expect(envelope.dry_run).toBe(true);
    expect(exitCode).toBe(0);
    expect(spawn.calls.length).toBe(0);
  });

  it('--dry-run --test-type androidInstrumented never invokes adbProbe', async () => {
    const dir = makeProject([{ name: 'core' }]);
    let adbCalls = 0;
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--dry-run', '--test-type', 'androidInstrumented'],
      spawn: makeSpawnStub(),
      adbProbe: () => { adbCalls++; return []; },
      log: () => {},
    });
    expect(envelope.dry_run).toBe(true);
    expect(exitCode).toBe(0);
    expect(adbCalls).toBe(0);
  });

  it('--dry-run does not call runCoverage', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    let coverageCalls = 0;
    const stubCoverage = async () => { coverageCalls++; return { envelope: {}, exitCode: 0 }; };
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--dry-run', '--test-type', 'common', '--coverage-tool', 'kover'],
      spawn: makeSpawnStub(),
      runCoverageInjection: stubCoverage,
      log: () => {},
    });
    expect(envelope.dry_run).toBe(true);
    expect(coverageCalls).toBe(0);
  });

  it('--dry-run --benchmark does not call runBenchmark', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    let benchCalls = 0;
    const stubBenchmark = async () => { benchCalls++; return { envelope: {}, exitCode: 0 }; };
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--dry-run', '--test-type', 'common', '--benchmark'],
      spawn: makeSpawnStub(),
      runBenchmarkInjection: stubBenchmark,
      log: () => {},
    });
    expect(envelope.dry_run).toBe(true);
    expect(benchCalls).toBe(0);
  });

  it('--dry-run --isolated leaves the whole .kmp-test-runner tree absent, not just cache_dir', async () => {
    const dir = makeProject([{ name: 'core' }]);
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--dry-run', '--isolated'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    expect(exitCode).toBe(0);
    expect(envelope.isolated.enabled).toBe(true);
    expect(existsSync(path.join(dir, '.kmp-test-runner'))).toBe(false);
  });

  it('--dry-run envelope carries the full expected key set', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--dry-run', '--test-type', 'common'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    for (const key of [
      'tool', 'schema_version', 'subcommand', 'version', 'project_root',
      'exit_code', 'duration_ms', 'dry_run', 'tests', 'modules', 'skipped',
      'coverage', 'errors', 'warnings', 'plan', 'isolated',
    ]) {
      expect(envelope).toHaveProperty(key);
    }
    expect(envelope.subcommand).toBe('parallel');
    expect(envelope.dry_run).toBe(true);
  });

  it('--dry-run on a cold-cache project leaves zero .kmp-test-runner artifacts on disk (filesystem sentinel)', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub();
    await runParallel({
      projectRoot: dir,
      args: ['--dry-run', '--test-type', 'common'],
      spawn,
      log: () => {},
    });
    expect(spawn.calls.length).toBe(0);
    expect(existsSync(path.join(dir, '.kmp-test-runner'))).toBe(false);
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
    // v0.9 drift #2 — modules[] is now an array of canonical objects with
    // `{name, type, coverage_plugin, test_build_type, has_flavor,
    //   android_dsl, android_dsl_variant}` (parity with --list-only).
    const names = envelope.modules.map(m => m.name);
    expect(names).toContain('core');
    expect(names).toContain('feature');
    expect(envelope.modules[0]).toHaveProperty('type');
    expect(envelope.modules[0]).toHaveProperty('coverage_plugin');
    expect(envelope.modules[0]).toHaveProperty('test_build_type');
  });

  it('threads the run startTime into in-process coverage aggregation (report Duration covers the full run)', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 5s\n' });
    const stubCoverage = makeRunCoverageStub();
    const before = Date.now();
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(stubCoverage.calls.length).toBe(1);
    // The parallel run's own startTime is threaded so the coverage report's
    // Duration reflects test execution + aggregation, not aggregation alone
    // (which is ~0 when the coverage tool resolves to none → "0m 0s").
    const passed = stubCoverage.calls[0].runStartTime;
    expect(typeof passed).toBe('number');
    expect(passed).toBeGreaterThanOrEqual(before);
    expect(passed).toBeLessThanOrEqual(Date.now());
    expect(stubCoverage.calls[0].testsRan).toBe(true);
  });

  // wet-audit-v0.9-part2 BUG-2 — coverage gate breach (errors[].code:
  // 'coverage_threshold_exceeded') propagates from in-process runCoverage
  // through state.errors and promotes the parallel envelope to exit 1.
  it('coverage_threshold_exceeded from in-process runCoverage promotes exit to TEST_FAIL', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub({
      coverage: { tool: 'kover', missed_lines: 317, modules_contributing: 1 },
      errors: [{
        code: 'coverage_threshold_exceeded',
        message: 'Coverage threshold exceeded: 317 missed lines > 50',
        threshold: 50,
        missed_lines: 317,
      }],
      exitCode: 1,
    });
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--coverage-tool', 'kover', '--min-missed-lines', '50'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.errors.some(e => e.code === 'coverage_threshold_exceeded')).toBe(true);
    expect(envelope.coverage.missed_lines).toBe(317);
    expect(exitCode).toBe(1); // TEST_FAIL
  });

  // PR-17 Bug 2 — runCoverageInProcess used to forward only errors[], never
  // warnings[], from the in-process coverage envelope. This proves the two
  // now survive TOGETHER: a coverage_threshold_exceeded error (the pre-
  // existing regression guard above) alongside a coverage_parse_failed
  // warning, both propagated to the parallel envelope in the same run.
  it('aggregation warnings survive threshold failure via the in-process coverage call', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub({
      coverage: { tool: 'kover', missed_lines: 317, modules_contributing: 1 },
      errors: [{
        code: 'coverage_threshold_exceeded',
        message: 'Coverage threshold exceeded: 317 missed lines > 50',
        threshold: 50,
        missed_lines: 317,
      }],
      warnings: [{
        code: 'coverage_parse_failed',
        modules: ['feature'],
        message: "Coverage XML parsing failed for 1 module(s); coverage totals for these modules are excluded from the aggregate. Check the module's XML report for malformed or missing content.",
      }],
      exitCode: 1,
    });
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--coverage-tool', 'kover', '--min-missed-lines', '50'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.errors.some(e => e.code === 'coverage_threshold_exceeded')).toBe(true);
    expect(exitCode).toBe(1);
    const w = envelope.warnings.find(x => x.code === 'coverage_parse_failed');
    expect(w).toBeTruthy();
    expect(w.modules).toEqual(['feature']);
  });

  it('coverage envelope errors:[] (no gate) leaves exit_code unchanged', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub({
      coverage: { tool: 'kover', missed_lines: 10, modules_contributing: 1 },
      errors: [], // no gate breach
    });
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--coverage-tool', 'kover'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.errors.filter(e => e.code === 'coverage_threshold_exceeded').length).toBe(0);
    expect(exitCode).toBe(0);
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

  // PR 3.4 A2 — stale guard pre-fix:
  //   if (opts.outputFile && opts.outputFile !== 'coverage-full-report.md')
  // dropped the flag whenever the user explicitly passed the historic default
  // literal (or it was injected by parseArgs default). The orchestrator now
  // forwards unconditionally; coverage-orchestrator treats the literal as
  // its "use default tree" sentinel.
  it('--output-file coverage-full-report.md (literal default) is forwarded too', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--output-file', 'coverage-full-report.md'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(stubCoverage.calls.length).toBe(1);
    const passedArgs = stubCoverage.calls[0].args;
    const idx = passedArgs.indexOf('--output-file');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(passedArgs[idx + 1]).toBe('coverage-full-report.md');
  });

  // v0.9 session 2 Bug-E — `--coverage-only` implies `--skip-tests`, so the
  // dispatch routes to coverage-orchestrator BEFORE the parallel-orchestrator's
  // own `opts.coverageOnly && opts.coverageModules` module filter at line ~1331
  // can fire (it's now unreachable when coverageOnly is set; left in place for
  // direct `node lib/runner.js parallel --coverage-modules ...` calls without
  // --coverage-only). Test confirms the new routing: stubCoverage IS invoked
  // and receives `--coverage-modules` so the eventual report is filtered.
  it('Bug-E: --coverage-only routes to runCoverage with --coverage-modules forwarded', async () => {
    const dir = makeProject([
      { name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'feature', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'shared', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--coverage-only', '--coverage-modules', 'core,feature'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(stubCoverage.calls.length).toBe(1);
    const passedArgs = stubCoverage.calls[0].args;
    expect(passedArgs).toContain('--coverage-modules');
    const idx = passedArgs.indexOf('--coverage-modules');
    expect(passedArgs[idx + 1]).toBe('core,feature');
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

  // OBS-A from 2026-05-09 wet-audit. When a gradle task fails AND no
  // JUnit XML evidence exists (compile-time / runner-setup failure),
  // pre-fix the envelope surfaced plain `module_failed` with empty
  // `test_failures[]` — agents could not distinguish "test ran and
  // failed" from "test never ran". Fix marks setup_failed:true when
  // both junitTestFailuresFor and junitTestCountFor return empty.
  it('module_failed + no XML evidence → errors[].setup_failed:true (OBS-A)', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    // failTasks marks the task as failed, but the spawn stub does NOT
    // create any TEST-*.xml files — mimics a compile-time failure.
    const spawn = makeSpawnStub({ failTasks: [':core:jvmTest'], stdout: '> Task :core:jvmTest\n' });
    const stubCoverage = makeRunCoverageStub();
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(exitCode).toBe(1);
    const moduleFailed = envelope.errors.find(e => e.code === 'module_failed' && e.module === 'core');
    expect(moduleFailed).toBeDefined();
    expect(moduleFailed.setup_failed).toBe(true);
  });

  // Bonus finding from 2026-05-09 wet-audit. Pre-fix `parallel --test-type
  // androidInstrumented` (no `--device`, no `--clear-data`) skipped the
  // adb probe entirely, so `envelope.android.device_serial` always
  // returned `''` even when a device was connected — paridad gap with
  // the `kmp-test android` subcommand which always probes.
  it('androidInstrumented populates android.device_serial from adb probe (no --device)', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL\n> Task :app:connectedDebugAndroidTest\n' });
    const adbProbe = () => [{ serial: 'PROBED-X1', type: 'physical', model: 'TestDevice' }];

    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    expect(exitCode).toBe(0);
    expect(envelope.android).toBeDefined();
    expect(envelope.android.device_serial).toBe('PROBED-X1');
  });

  it('androidInstrumented with no devices → instrumented_setup_failed, exit 3', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL\n> Task :app:connectedDebugAndroidTest\n' });
    const adbProbe = () => []; // no devices connected

    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    // Unified policy: no devices → instrumented_setup_failed / exit 3, matches
    // android-orchestrator and benchmark-orchestrator.
    expect(exitCode).toBe(3);
    expect(envelope.errors.find(e => e.code === 'instrumented_setup_failed')).toBeDefined();
  });

  it('androidInstrumented with multiple connected devices and no --device → multiple_adb_devices, exit 3', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL\n> Task :app:connectedDebugAndroidTest\n' });
    // Two devices without state (both treated as usable via backward-compat default).
    const adbProbe = () => [
      { serial: 'FIRST', type: 'physical', model: 'A', state: 'device' },
      { serial: 'SECOND', type: 'emulator', model: 'B', state: 'device' },
    ];

    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    expect(exitCode).toBe(3);
    expect(envelope.errors[0].code).toBe('multiple_adb_devices');
  });

  // ---- --capture-on-fail (parallel androidInstrumented leg) ----------------
  // The injected `spawn` serves BOTH gradle dispatch AND the adb capture calls,
  // so this stub discriminates: gradle (gradlew path) → canned FAILED output;
  // adb screencap → a PNG buffer; adb uiautomator dump → a <hierarchy> XML.
  // adbOk:false makes every adb call fail so the capture_error path is exercised.
  function makeCaptureSpawn({ failTasks = [], adbOk = true } = {}) {
    const calls = [];
    const fn = (cmd, args = [], _opts) => {
      calls.push({ cmd, args: [...args] });
      if (cmd === 'adb') {
        if (args.includes('screencap')) {
          return adbOk
            ? { status: 0, stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), stderr: '', error: null }
            : { status: 1, stdout: Buffer.alloc(0), stderr: '', error: null };
        }
        // uiautomator dump (/dev/tty) or the shell-dump + cat fallback.
        return adbOk
          ? { status: 0, stdout: '<?xml version="1.0"?><hierarchy rotation="0"></hierarchy>', stderr: '', error: null }
          : { status: 0, stdout: '', stderr: '', error: null };
      }
      // gradle leg: mention each task with a FAILED suffix so classifyTaskResults
      // marks it failed WITHOUT tripping the cascade-isolation (no_evidence) path.
      let out = 'BUILD FAILED\n';
      for (const t of failTasks) out += `> Task ${t} FAILED\n`;
      return { status: failTasks.length ? 1 : 0, stdout: out, stderr: '', signal: null, error: null };
    };
    fn.calls = calls;
    return fn;
  }
  const androidApp = (name = 'app') => ({
    name,
    sourceSets: ['androidInstrumentedTest'],
    build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n',
  });

  it('--capture-on-fail: instrumented FAIL → screenshot_file + ui_hierarchy_file on errors[], exit 1', async () => {
    const dir = makeProject([androidApp()]);
    const spawn = makeCaptureSpawn({ failTasks: [':app:connectedDebugAndroidTest'] });
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--capture-on-fail'],
      spawn,
      adbProbe: () => [{ serial: 'emulator-5554', type: 'emulator', model: 'SDK' }],
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect(exitCode).toBe(1);
    const err = envelope.errors.find(e => e.code === 'module_failed');
    expect(err).toBeDefined();
    expect(err.screenshot_file).toMatch(/app_screenshot\.png$/);
    expect(err.ui_hierarchy_file).toMatch(/app_ui-hierarchy\.xml$/);
    expect(err.capture_error).toBeUndefined();
    // Artifacts actually written under the per-run android log dir.
    expect(existsSync(err.screenshot_file)).toBe(true);
    expect(existsSync(err.ui_hierarchy_file)).toBe(true);
    expect(err.screenshot_file).toContain(path.join('.kmp-test-runner', 'logs', 'android'));
    // adb targeted the resolved serial, and screencap fired exactly once (one
    // capture per failed module on the final state — no per-attempt spam).
    const shots = spawn.calls.filter(c => c.cmd === 'adb' && c.args.includes('screencap'));
    expect(shots.length).toBe(1);
    expect(shots[0].args).toContain('emulator-5554');
  });

  it('--capture-dir overrides where capture artifacts land', async () => {
    const dir = makeProject([androidApp()]);
    const capDir = mkdtempSync(path.join(tmpdir(), 'kmp-cap-'));
    const spawn = makeCaptureSpawn({ failTasks: [':app:connectedDebugAndroidTest'] });
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--capture-dir', capDir],
      spawn,
      adbProbe: () => [{ serial: 'emulator-5554' }],
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const err = envelope.errors.find(e => e.code === 'module_failed');
    expect(err.screenshot_file.startsWith(capDir)).toBe(true);
    expect(existsSync(err.screenshot_file)).toBe(true);
    rmSync(capDir, { recursive: true, force: true });
  });

  it('--capture-on-fail is a no-op on a non-instrumented (common) leg', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeCaptureSpawn({ failTasks: [':core:jvmTest'] });
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--capture-on-fail'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect(exitCode).toBe(1);
    const err = envelope.errors.find(e => e.code === 'module_failed');
    expect(err).toBeDefined();
    expect(err.screenshot_file).toBeUndefined();
    expect(err.ui_hierarchy_file).toBeUndefined();
    expect(spawn.calls.some(c => c.cmd === 'adb')).toBe(false);
  });

  it('--capture-on-fail: adb failure → capture_error set, no paths, exit unchanged (forensic-only)', async () => {
    const dir = makeProject([androidApp()]);
    const spawn = makeCaptureSpawn({ failTasks: [':app:connectedDebugAndroidTest'], adbOk: false });
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--capture-on-fail'],
      spawn,
      adbProbe: () => [{ serial: 'emulator-5554' }],
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect(exitCode).toBe(1); // capture failure NEVER changes the exit code
    const err = envelope.errors.find(e => e.code === 'module_failed');
    expect(err.capture_error).toBeTruthy();
    expect(err.screenshot_file).toBeUndefined();
    expect(err.ui_hierarchy_file).toBeUndefined();
  });

  it('--capture-on-fail with no connected device → instrumented_setup_failed, exit 3', async () => {
    const dir = makeProject([androidApp()]);
    const spawn = makeCaptureSpawn({ failTasks: [':app:connectedDebugAndroidTest'] });
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--capture-on-fail'],
      spawn,
      adbProbe: () => [], // no devices — unified policy: fail early, no gradle call
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    // No devices → instrumented_setup_failed / exit 3 (same policy as android + benchmark).
    // capture_error "no device serial" is no longer reachable since we fail before gradle.
    expect(exitCode).toBe(3);
    expect(envelope.errors[0].code).toBe('instrumented_setup_failed');
    expect(spawn.calls.some(c => c.cmd === 'adb')).toBe(false);
  });

  it('passing instrumented run with --capture-on-fail → no capture artifacts, exit 0', async () => {
    const dir = makeProject([androidApp()]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL\n> Task :app:connectedDebugAndroidTest\n' });
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--capture-on-fail'],
      spawn,
      adbProbe: () => [{ serial: 'emulator-5554' }],
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect(exitCode).toBe(0);
    expect(envelope.errors.some(e => e.code === 'module_failed')).toBe(false);
    // capture only fires inside the module_failed branch → no adb on a green run.
    expect(spawn.calls.some(c => c.cmd === 'adb')).toBe(false);
  });

  it('--capture-on-fail: multiple failed modules get per-module namespaced artifacts', async () => {
    const dir = makeProject([androidApp('app'), androidApp('feature')]);
    const spawn = makeCaptureSpawn({
      failTasks: [':app:connectedDebugAndroidTest', ':feature:connectedDebugAndroidTest'],
    });
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--capture-on-fail'],
      spawn,
      adbProbe: () => [{ serial: 'emulator-5554' }],
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const fails = envelope.errors.filter(e => e.code === 'module_failed');
    expect(fails.length).toBe(2);
    const shots = fails.map(e => e.screenshot_file);
    expect(shots.every(Boolean)).toBe(true);
    // Distinct, module-prefixed filenames — no overwrite under one runId.
    expect(new Set(shots).size).toBe(2);
    expect(shots.some(s => /app_screenshot\.png$/.test(s))).toBe(true);
    expect(shots.some(s => /feature_screenshot\.png$/.test(s))).toBe(true);
  });

  it('module_failed WITH XML evidence → errors[] has NO setup_failed flag (OBS-A negative)', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    // Pre-write a JUnit XML with one failing testcase. The stale-XML
    // guard filters by mtime < state.runStartMs; bump mtime to the
    // future so the file passes regardless of when runParallel starts.
    const xmlDir = path.join(dir, 'core', 'build', 'test-results', 'jvmTest');
    mkdirSync(xmlDir, { recursive: true });
    const xmlPath = path.join(xmlDir, 'TEST-RealFailures.xml');
    writeFileSync(xmlPath,
      '<testsuite><testcase name="boom" classname="com.foo.RealFailures">' +
      '<failure type="AssertionError" message="real test failure"/>' +
      '</testcase></testsuite>');
    // Bump mtime to +60s so the stale-XML guard always lets it through.
    const future = new Date(Date.now() + 60_000);
    utimesSync(xmlPath, future, future);
    const spawn = makeSpawnStub({ failTasks: [':core:jvmTest'], stdout: '> Task :core:jvmTest\n' });
    const stubCoverage = makeRunCoverageStub();
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(exitCode).toBe(1);
    const moduleFailed = envelope.errors.find(e => e.code === 'module_failed' && e.module === 'core');
    expect(moduleFailed).toBeDefined();
    // setup_failed must NOT be set when XML evidence exists.
    expect(moduleFailed.setup_failed).toBeUndefined();
    // test_failures populated as a regression-anti-flake.
    const coreModule = envelope.modules.find(m => m.name === 'core');
    expect(coreModule.test_failures.length).toBeGreaterThan(0);
  });

  it('WS-1: "Cannot locate tasks" → all modules marked failed by classifyTaskResults', async () => {
    const dir = makeProject([
      { name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'feature', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub({ resolutionFail: true });
    const stubCoverage = makeRunCoverageStub();
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.tests.failed).toBeGreaterThan(0);
    // applyErrorCodeDiscriminators picks up "Cannot locate tasks" → task_not_found
    expect(envelope.errors.some(e => e.code === 'task_not_found')).toBe(true);
    // task_not_found is an environment/toolchain problem (not a test assertion)
    // → ENV_ERROR (3), taking priority over the generic module_failed/TEST_FAIL
    // default it's discovered alongside.
    expect(exitCode).toBe(3);
  });

  it('unsupported_class_version discriminator promotes exit to ENV_ERROR (3), not TEST_FAIL', async () => {
    const dir = makeProject([
      { name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub({
      failTasks: [':core:jvmTest'],
      stdout: 'BUILD FAILED\njava.lang.UnsupportedClassVersionError: Foo has been compiled by a more recent version of the Java Runtime\n',
    });
    const stubCoverage = makeRunCoverageStub();
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.errors.some(e => e.code === 'module_failed')).toBe(true);
    expect(envelope.errors.some(e => e.code === 'unsupported_class_version')).toBe(true);
    expect(exitCode).toBe(3);
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

  // v0.9 step 2 — --gradle-args escape hatch: tokens appended LAST so users
  // can override CLI defaults via gradle's last-wins flag semantics.
  it('--gradle-args tokens are appended LAST in dispatchLeg gradleArgs', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub();
    const stubCoverage = makeRunCoverageStub();
    await runParallel({
      projectRoot: dir,
      args: [
        '--test-type', 'common',
        '--gradle-args', '--no-parallel',
        '--gradle-args', '-Pfoo=bar',
      ],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    const gradleCall = spawn.calls.find(isGradleCall);
    expect(gradleCall).toBeTruthy();
    const args = effectiveGradleArgs(gradleCall);
    // Both user tokens must appear in the spawn args.
    expect(args).toContain('--no-parallel');
    expect(args).toContain('-Pfoo=bar');
    // CLI default --parallel still emitted (escape-hatch overrides via gradle's
    // last-wins, not by suppression at the orchestrator layer).
    expect(args).toContain('--parallel');
    // Order check: user tokens come AFTER the CLI defaults so gradle wins-last
    // resolves the user's intent. We assert idxParallel < idxNoParallel and
    // both user tokens appear in the order they were passed on the CLI.
    const idxParallel = args.indexOf('--parallel');
    const idxNoParallel = args.indexOf('--no-parallel');
    const idxFoo = args.indexOf('-Pfoo=bar');
    expect(idxParallel).toBeGreaterThanOrEqual(0);
    expect(idxNoParallel).toBeGreaterThan(idxParallel);
    expect(idxFoo).toBeGreaterThan(idxNoParallel);
  });

  // 2026-05-03 wide-smoke regression: when gradle aborts at evaluation phase
  // (one module's plugin/compile fails before any task runs), --continue +
  // multi-module dispatch produced 4 misleading [FAIL] lines. Confetti repro:
  // `:shared:jvmTest` succeeds in 1m 44s when invoked alone, but fails when
  // bundled with `:androidApp:test` whose evaluation aborts. Cascade-isolation
  // fallback retries each module separately when the one-shot dispatch shows
  // no per-task evidence, so per-module truth surfaces.
  it('cascade-isolation fallback: re-dispatches per-module when one-shot aborts pre-task', async () => {
    const dir = makeProject([
      { name: 'broken', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'healthy', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    let callIdx = 0;
    const calls = [];
    // Spawn that simulates: (1) one-shot leg → exit 1 with NO per-task line
    // (only `BUILD FAILED`), then (2) per-module retry: broken → fail with
    // per-task FAILED marker, healthy → BUILD SUCCESSFUL.
    const spawn = (cmd, args, opts) => {
      calls.push({ cmd, args: [...args], opts });
      callIdx++;
      const eArgs = effectiveGradleArgs({ cmd, args });
      const isOneShot = eArgs.filter(a => a.startsWith(':')).length > 1;
      if (isOneShot) {
        return { status: 1, stdout: 'FAILURE: Build failed.\nBUILD FAILED in 1s\n', stderr: '', signal: null, error: null };
      }
      const taskArg = eArgs.find(a => a.startsWith(':')) || '';
      if (taskArg.startsWith(':broken')) {
        return { status: 1, stdout: `> Task ${taskArg} FAILED\nBUILD FAILED in 1s\n`, stderr: '', signal: null, error: null };
      }
      return { status: 0, stdout: `> Task ${taskArg}\nBUILD SUCCESSFUL in 1s\n`, stderr: '', signal: null, error: null };
    };
    spawn.calls = calls;
    const stubCoverage = makeRunCoverageStub();
    const lines = [];
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: (l) => lines.push(l),
      runCoverageInjection: stubCoverage,
    });
    // Cascade-isolation banner emitted.
    expect(lines.some(l => /retrying per-module|isolate/i.test(l))).toBe(true);
    // Per-module truth: healthy passed, broken failed. Pre-fix, BOTH would
    // have been marked failed by defense-in-depth.
    expect(envelope.tests.passed).toBe(1);
    expect(envelope.tests.failed).toBe(1);
    // v0.9 drift #2 — modules[] is array of objects with `.name`.
    expect(envelope.modules.map(m => m.name)).toContain('healthy');
    expect(envelope.errors.some(e => e.module === 'broken')).toBe(true);
    expect(envelope.errors.some(e => e.module === 'healthy')).toBe(false);
    // Spawn called 1 (one-shot) + 2 (per-module retry) = 3 times.
    const gradleSpawnCount = calls.filter(c => isGradleCall(c)).length;
    expect(gradleSpawnCount).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // Gradle spawn timeouts — T1-T8 (PR-14)
  // ---------------------------------------------------------------------------
  // spawnSync with a `timeout` option kills the child and returns:
  //   POSIX: { status: null, signal: 'SIGTERM', ... }
  //   Windows: { status: null, signal: null, error: { code: 'ETIMEDOUT' }, ... }
  // These tests verify discrimination, metadata, and no-retry invariants.

  it('T1: POSIX timeout (signal SIGTERM) → gradle_timeout error, exit 3', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = (cmd, args, opts) => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: null });
    spawn.calls = [];
    const stubCoverage = makeRunCoverageStub();
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--timeout', '30', '--no-coverage'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.errors.some(e => e.code === 'gradle_timeout')).toBe(true);
    expect(exitCode).toBe(3);
    // Counter invariants: total and failed must both equal gradle_timeout count.
    const timeoutCount = envelope.errors.filter(e => e.code === 'gradle_timeout').length;
    expect(envelope.tests.total).toBe(timeoutCount);
    expect(envelope.tests.failed).toBe(timeoutCount);
    expect(envelope.parallel.legs[0].execution.failed).toBe(timeoutCount);
  });

  it('T2: Windows timeout (error.code ETIMEDOUT) → gradle_timeout error, exit 3', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const winErr = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const spawn = (cmd, args, opts) => ({ status: null, signal: null, stdout: '', stderr: '', error: winErr });
    spawn.calls = [];
    const stubCoverage = makeRunCoverageStub();
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--timeout', '30', '--no-coverage'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.errors.some(e => e.code === 'gradle_timeout')).toBe(true);
    expect(exitCode).toBe(3);
  });

  it('T3: timeout error carries module, task, timeout_ms — no gradlew path', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = (cmd, args, opts) => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: null });
    spawn.calls = [];
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--timeout', '45', '--no-coverage'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    const err = envelope.errors.find(e => e.code === 'gradle_timeout');
    expect(err).toBeDefined();
    expect(err.module).toBe('core');
    expect(err.task).toMatch(/^:core:/);
    expect(err.timeout_ms).toBe(45000);
    // Must not leak gradlew path or raw command-line args
    expect(JSON.stringify(err)).not.toMatch(/gradlew/);
  });

  it('T4: nested module path → module name from taskOwners, task contains full path', async () => {
    // Gradle uses colons for project hierarchy. `:feature:auth:jvmTest` is the
    // task; module name is `feature:auth` (as declared in settings.gradle.kts).
    const dir = makeProject([{ name: 'feature:auth', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = (cmd, args, opts) => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: null });
    spawn.calls = [];
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--timeout', '60', '--no-coverage'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    const err = envelope.errors.find(e => e.code === 'gradle_timeout');
    expect(err).toBeDefined();
    expect(err.module).toBe('feature:auth');
    expect(err.task).toMatch(/:feature:auth:/);
    expect(err.timeout_ms).toBe(60000);
  });

  it('T5: --auto-retry does NOT fire on timeout (spawn called once)', async () => {
    // --auto-retry only fires for androidInstrumented, so we use a real Android
    // module with an adb probe to reach the auto-retry gate before the timeout guard.
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    const manifestDir = path.join(dir, 'app', 'src', 'main');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(path.join(manifestDir, 'AndroidManifest.xml'), '<manifest package="com.example.app"/>');
    const calls = [];
    const spawn = (cmd, args, opts) => {
      calls.push({ cmd, args: [...args] });
      if (cmd === 'adb') return { status: 0, stdout: '', stderr: '', signal: null, error: null };
      return { status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: null };
    };
    spawn.calls = calls;
    const adbProbe = () => [{ serial: 'X', type: 'physical', model: 'Y' }];
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--timeout', '30', '--auto-retry', '--no-coverage'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const gradleCount = calls.filter(c => isGradleCall(c)).length;
    expect(gradleCount).toBe(1);
  });

  it('T6: cascade-isolation does NOT fire on timeout (spawn called once)', async () => {
    // All tasks show no_evidence (empty stdout) — without the timedOut guard
    // the cascade check would trigger a per-module re-run.
    const dir = makeProject([
      { name: 'alpha', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'beta',  sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const calls = [];
    const spawn = (cmd, args, opts) => {
      calls.push({ cmd, args: [...args] });
      // Empty stdout = all tasks no_evidence; signal triggers timeout path.
      return { status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: null };
    };
    spawn.calls = calls;
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--timeout', '30', '--no-coverage'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    const gradleCount = calls.filter(c => isGradleCall(c)).length;
    expect(gradleCount).toBe(1);
    // Both modules surfaced as timeout, not as cascade-isolated failures.
    const timeoutErrors = envelope.errors.filter(e => e.code === 'gradle_timeout');
    expect(timeoutErrors).toHaveLength(2);
    // Counter invariants for multi-module timeout.
    expect(envelope.tests.total).toBe(2);
    expect(envelope.tests.failed).toBe(2);
    expect(envelope.parallel.legs[0].execution.failed).toBe(2);
  });

  it('T7: normal test failure STILL retries with --auto-retry (regression)', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    const manifestDir = path.join(dir, 'app', 'src', 'main');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(path.join(manifestDir, 'AndroidManifest.xml'), '<manifest package="com.example.app"/>');
    const calls = [];
    let gradleCallNum = 0;
    const spawn = (cmd, args, opts) => {
      calls.push({ cmd, args: [...args] });
      if (cmd === 'adb') return { status: 0, stdout: '', stderr: '', signal: null, error: null };
      gradleCallNum++;
      const task = effectiveGradleArgs({ cmd, args }).find(a => a.startsWith(':')) || ':app:connectedDebugAndroidTest';
      return gradleCallNum === 1
        ? { status: 1, stdout: `> Task ${task} FAILED\nBUILD FAILED\n`, stderr: '', signal: null, error: null }
        : { status: 0, stdout: `> Task ${task}\nBUILD SUCCESSFUL\n`, stderr: '', signal: null, error: null };
    };
    spawn.calls = calls;
    const adbProbe = () => [{ serial: 'X', type: 'physical', model: 'Y' }];
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--auto-retry', '--no-coverage'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const gradleCount = calls.filter(c => isGradleCall(c)).length;
    expect(gradleCount).toBe(2);
  });

  it('T8: non-timeout spawn error (no signal, no ETIMEDOUT) keeps module_failed', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const genericErr = Object.assign(new Error('ENOMEM'), { code: 'ENOMEM' });
    const spawn = (cmd, args, opts) => ({
      status: null, signal: null, stdout: '', stderr: '', error: genericErr,
    });
    spawn.calls = [];
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--timeout', '30', '--no-coverage'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    // Not a timeout — must NOT emit gradle_timeout.
    expect(envelope.errors.every(e => e.code !== 'gradle_timeout')).toBe(true);
    // Standard failure path applies.
    expect(envelope.errors.some(e => e.code === 'module_failed')).toBe(true);
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
    expect(envelope.parallel.legs).toHaveLength(1);
    expect(envelope.parallel.legs[0]).toMatchObject({ test_type: 'common', exit_code: 0 });
    expect(envelope.parallel.legs[0].execution).toBeDefined();
    expect(envelope.parallel.max_workers).toBe(4);
    expect(envelope.parallel.timeout_s).toBe(300);
  });

  it('execution telemetry: counts fresh tasks (no UP-TO-DATE / FROM-CACHE suffix)', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: '> Task :core:jvmTest\nBUILD SUCCESSFUL in 5s\n' });
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.parallel.legs[0].execution.fresh).toBe(1);
    expect(envelope.parallel.legs[0].execution.up_to_date).toBe(0);
    expect(envelope.parallel.legs[0].execution.from_cache).toBe(0);
  });

  it('execution telemetry: counts UP-TO-DATE tasks (gradle incremental skip)', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: '> Task :core:jvmTest UP-TO-DATE\nBUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.parallel.legs[0].execution.up_to_date).toBe(1);
    expect(envelope.parallel.legs[0].execution.fresh).toBe(0);
  });

  it('execution telemetry: counts FROM-CACHE tasks (gradle build cache hit)', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: '> Task :core:jvmTest FROM-CACHE\nBUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.parallel.legs[0].execution.from_cache).toBe(1);
    expect(envelope.parallel.legs[0].execution.fresh).toBe(0);
  });

  // F3 (2026-05-03): when gradle marks the test task UP-TO-DATE, AGP doesn't
  // rewrite TEST-*.xml — their mtime stays from the prior run. The walker's
  // stale-XML guard (added by PR #116 to filter ~10K bash-wrapper-era XMLs)
  // would then false-discard them and report individual_total:0 on otherwise
  // green incremental builds. Reproduced live on di-sample:
  // 4 XMLs with mtime 8 days old, walker returned 0; touch + rerun → 68.
  // Fix: bypass the guard for UP-TO-DATE / FROM-CACHE execution modes.
  function writeStaleJunitXml(projectRoot, modName, taskShort, fileBase, testcaseCount, ageSec = 60) {
    const taskDir = path.join(projectRoot, modName, 'build', 'test-results', taskShort);
    mkdirSync(taskDir, { recursive: true });
    const xml = '<testsuite>' + '<testcase/>'.repeat(testcaseCount) + '</testsuite>';
    const filePath = path.join(taskDir, `TEST-${fileBase}.xml`);
    writeFileSync(filePath, xml);
    const past = Math.floor(Date.now() / 1000) - ageSec;
    utimesSync(filePath, past, past);
  }

  it('F3 fix: UP-TO-DATE tasks count existing TEST-*.xml without mtime guard', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    writeStaleJunitXml(dir, 'core', 'jvmTest', 'com.foo.Bar', 5);
    writeStaleJunitXml(dir, 'core', 'jvmTest', 'com.foo.Baz', 3);
    const spawn = makeSpawnStub({ stdout: '> Task :core:jvmTest UP-TO-DATE\nBUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.parallel.legs[0].execution.up_to_date).toBe(1);
    expect(envelope.tests.individual_total).toBe(8);
  });

  it('F3 fix: FROM-CACHE tasks count existing TEST-*.xml without mtime guard', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    writeStaleJunitXml(dir, 'core', 'jvmTest', 'com.foo.Cached', 7);
    const spawn = makeSpawnStub({ stdout: '> Task :core:jvmTest FROM-CACHE\nBUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.parallel.legs[0].execution.from_cache).toBe(1);
    expect(envelope.tests.individual_total).toBe(7);
  });

  it('F3 fix: fresh tasks still discard stale TEST-*.xml (regression guard preserved)', async () => {
    // Locks the original PR #116 protection: gradle ran the task fresh, but
    // stale XMLs from a prior run remain on disk. Walker must NOT count them.
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    writeStaleJunitXml(dir, 'core', 'jvmTest', 'com.foo.Wrapper', 99);
    const spawn = makeSpawnStub({ stdout: '> Task :core:jvmTest\nBUILD SUCCESSFUL in 5s\n' });
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.parallel.legs[0].execution.fresh).toBe(1);
    expect(envelope.tests.individual_total).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // PR-28c (2026-07-14, M10 closure) — AGP-directory analogue of the F3 fix
  // above. forEachJunitXml unions the legacy build/test-results/<task>/ dir
  // AND AGP's build/outputs/androidTest-results/connected/<sourceSet>/ dir
  // under the SAME sinceMs gate (junit-xml.js:93-159) — nothing branches on
  // test type. These tests prove that shape-agnostic claim through a real
  // androidInstrumented dispatch, closing the untested intersection
  // BACKLOG.md flagged (AGP dir x stale mtime x cacheRespected x real
  // dispatch).
  // ---------------------------------------------------------------------------
  // AGP's connected-test output isn't keyed by task short-name —
  // forEachJunitXml walks every subdirectory of
  // build/outputs/androidTest-results/connected/ regardless of which task
  // dispatched it (junit-xml.js:124-133), unlike the legacy
  // build/test-results/<taskShort>/ path — so this helper takes a sourceSet
  // dir name instead of a taskShort.
  function writeStaleAgpJunitXml(projectRoot, modName, sourceSetDir, fileBase, testcaseCount, ageSec = 60) {
    const agpDir = path.join(
      projectRoot, modName, 'build', 'outputs', 'androidTest-results', 'connected', sourceSetDir,
    );
    mkdirSync(agpDir, { recursive: true });
    const xml = '<testsuite>' + '<testcase/>'.repeat(testcaseCount) + '</testsuite>';
    const filePath = path.join(agpDir, `TEST-${fileBase}.xml`);
    writeFileSync(filePath, xml);
    const past = Math.floor(Date.now() / 1000) - ageSec;
    utimesSync(filePath, past, past);
  }

  // Reuses the exact `app` + com.android.application + androidInstrumentedTest
  // shape already proven (below) to dispatch :app:connectedDebugAndroidTest.
  function androidInstrumentedApp() {
    return {
      name: 'app',
      sourceSets: ['androidInstrumentedTest'],
      build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n',
    };
  }

  it('F3 fix (AGP shape): UP-TO-DATE androidInstrumented task counts existing AGP TEST-*.xml without mtime guard', async () => {
    const dir = makeProject([androidInstrumentedApp()]);
    writeStaleAgpJunitXml(dir, 'app', 'androidMain', 'com.foo.Bar', 5);
    writeStaleAgpJunitXml(dir, 'app', 'androidMain', 'com.foo.Baz', 3);
    const spawn = makeSpawnStub({ stdout: '> Task :app:connectedDebugAndroidTest UP-TO-DATE\nBUILD SUCCESSFUL in 1s\n' });
    const adbProbe = () => [{ serial: 'PROBED-X1', type: 'physical', model: 'TestDevice' }];
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect(envelope.parallel.legs[0].execution.up_to_date).toBe(1);
    expect(envelope.tests.individual_total).toBe(8);
  });

  it('F3 fix (AGP shape): FROM-CACHE androidInstrumented task counts existing AGP TEST-*.xml without mtime guard', async () => {
    const dir = makeProject([androidInstrumentedApp()]);
    writeStaleAgpJunitXml(dir, 'app', 'androidMain', 'com.foo.Cached', 7);
    const spawn = makeSpawnStub({ stdout: '> Task :app:connectedDebugAndroidTest FROM-CACHE\nBUILD SUCCESSFUL in 1s\n' });
    const adbProbe = () => [{ serial: 'PROBED-X1', type: 'physical', model: 'TestDevice' }];
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect(envelope.parallel.legs[0].execution.from_cache).toBe(1);
    expect(envelope.tests.individual_total).toBe(7);
  });

  it('F3 fix (AGP shape): fresh androidInstrumented task still discards stale AGP TEST-*.xml (regression guard preserved)', async () => {
    // Negative control mirroring the JVM-shape test above: proves the guard
    // isn't globally disabled for the Android/AGP directory shape.
    const dir = makeProject([androidInstrumentedApp()]);
    writeStaleAgpJunitXml(dir, 'app', 'androidMain', 'com.foo.Wrapper', 99);
    const spawn = makeSpawnStub({ stdout: '> Task :app:connectedDebugAndroidTest\nBUILD SUCCESSFUL in 5s\n' });
    const adbProbe = () => [{ serial: 'PROBED-X1', type: 'physical', model: 'TestDevice' }];
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect(envelope.parallel.legs[0].execution.fresh).toBe(1);
    expect(envelope.tests.individual_total).toBe(0);
  });

  it('androidInstrumented fresh failure populates modules[].test_failures[] from the AGP directory end-to-end', async () => {
    // Closes a related-but-distinct gap: junitTestFailuresFor's AGP walk was
    // previously only unit-tested directly, never through a real runParallel
    // dispatch. execMode is 'fresh' (not cache-respected) here — a task can't
    // be both cache-respected (didn't re-execute) and newly FAILED, so this
    // models the actually-reachable "fresh + failed" combination, not a
    // fabricated one.
    const dir = makeProject([androidInstrumentedApp()]);
    const agpDir = path.join(dir, 'app', 'build', 'outputs', 'androidTest-results', 'connected', 'androidMain');
    mkdirSync(agpDir, { recursive: true });
    const xmlPath = path.join(agpDir, 'TEST-StressTest.xml');
    writeFileSync(xmlPath,
      '<testsuite name="com.foo.StressTest" tests="1" failures="1">' +
      '<testcase name="oomFails" classname="com.foo.StressTest" time="1.0">' +
      '<failure type="java.lang.OutOfMemoryError" message="heap exhausted"/>' +
      '</testcase></testsuite>');
    // Stale-XML guard filters by mtime < state.runStartMs (captured inside
    // runParallel, AFTER this fixture is written) — bump mtime to the future
    // so the file passes regardless of when runParallel actually starts.
    // Mirrors the identical pattern at the "OBS-A negative" test above.
    const future = new Date(Date.now() + 60_000);
    utimesSync(xmlPath, future, future);
    const spawn = makeSpawnStub({
      failTasks: [':app:connectedDebugAndroidTest'],
      stdout: '> Task :app:connectedDebugAndroidTest\n',
    });
    const adbProbe = () => [{ serial: 'PROBED-X1', type: 'physical', model: 'TestDevice' }];
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const appModule = envelope.modules.find(m => m.name === 'app');
    expect(appModule.test_failures).toEqual([
      { test: 'com.foo.StressTest.oomFails', cause: 'heap exhausted', type: 'java.lang.OutOfMemoryError' },
    ]);
  });

  // L6 (2026-06-09 audit) — cascade-retry diagnostic arrays are bounded at
  // push time. Below the caps the emitted text is byte-identical to the old
  // collect-all-then-slice shape; above them a suppressed-count line points
  // at the per-module log.
  it('L6: >50 critical lines emit exactly 50 + a suppressed-count line', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const criticalFlood = Array.from({ length: 60 },
      (_, i) => `Execution failed for task :core:probe${i}.`).join('\n');
    const spawn = makeSpawnStub({
      stdout: `${criticalFlood}\n> Task :core:jvmTest FAILED\nBUILD FAILED in 1s\n`,
      status: 1,
    });
    const logs = [];
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: (l) => logs.push(l),
      runCoverageInjection: makeRunCoverageStub(),
    });
    const emitted = logs.filter(l => l.includes('Execution failed for task :core:probe'));
    // 60 flood lines compete with the FAILED + BUILD FAILED critical matches
    // for the 50-line cap — never more than 50 critical lines total.
    expect(emitted.length).toBeLessThanOrEqual(50);
    expect(logs.some(l => l.includes('more critical lines suppressed'))).toBe(true);
  });

  it('L6: tasksRun >30 emits 30 + byte-identical suppressed arithmetic (parity)', async () => {
    // Failing leg — the step-4b diagnostic block (where the caps live) only
    // processes failing-leg output; success legs echo elsewhere.
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const taskFlood = Array.from({ length: 40 },
      (_, i) => `> Task :core:compile${i}`).join('\n');
    const spawn = makeSpawnStub({
      stdout: `${taskFlood}\n> Task :core:jvmTest FAILED\nBUILD FAILED in 1s\n`,
      status: 1,
    });
    const logs = [];
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: (l) => logs.push(l),
      runCoverageInjection: makeRunCoverageStub(),
    });
    const emitted = logs.filter(l => /^> Task :core:compile\d+$/.test(l));
    expect(emitted).toHaveLength(30);
    // Exact pre-cap arithmetic: 40 total − 30 emitted = 10 suppressed.
    expect(logs.some(l => l.includes('(… 10 more "> Task" lines suppressed)'))).toBe(true);
  });

  it('L6: status-noise counter text is identical to the old array-length form', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const noise = Array.from({ length: 5 },
      (_, i) => `> Task :core:upToDate${i} UP-TO-DATE`).join('\n');
    const spawn = makeSpawnStub({
      stdout: `${noise}\n> Task :core:jvmTest FAILED\nBUILD FAILED in 1s\n`,
      status: 1,
    });
    const logs = [];
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: (l) => logs.push(l),
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect(logs.some(l => l.includes('(5 UP-TO-DATE/NO-SOURCE/SKIPPED status lines suppressed)'))).toBe(true);
  });

  // L2 (2026-06-09 audit) — oversized TEST-*.xml files are skipped by the
  // size guard and surfaced as a `junit_xml_oversized` envelope warning so
  // agents know individual_total undercounts for that task.
  it('L2: oversized TEST-*.xml skips surface as junit_xml_oversized warning on the envelope', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    writeStaleJunitXml(dir, 'core', 'jvmTest', 'com.foo.Small', 2);
    const taskDir = path.join(dir, 'core', 'build', 'test-results', 'jvmTest');
    writeFileSync(path.join(taskDir, 'TEST-com.foo.Big.xml'),
      `<testsuite><testcase/><system-out>${'y'.repeat(1_500_000)}</system-out></testsuite>`);
    // UP-TO-DATE → cacheRespected → sinceMs=0, both files reach the size guard.
    const spawn = makeSpawnStub({ stdout: '> Task :core:jvmTest UP-TO-DATE\nBUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    const saved = process.env.KMP_JUNIT_XML_MAX_MB;
    process.env.KMP_JUNIT_XML_MAX_MB = '1';
    try {
      const { envelope } = await runParallel({
        projectRoot: dir,
        args: ['--test-type', 'common'],
        spawn,
        log: () => {},
        runCoverageInjection: stubCoverage,
      });
      expect(envelope.tests.individual_total).toBe(2); // Big skipped, Small counted
      const w = envelope.warnings.filter(x => x.code === 'junit_xml_oversized');
      expect(w).toHaveLength(1);
      expect(w[0].module).toBe('core');
      expect(w[0].task).toBe(':core:jvmTest');
      expect(w[0].file).toContain('TEST-com.foo.Big.xml');
      expect(w[0].size_bytes).toBeGreaterThan(1024 * 1024);
      expect(w[0].max_mb).toBe(1);
      expect(w[0].message).toContain('KMP_JUNIT_XML_MAX_MB');
    } finally {
      if (saved === undefined) delete process.env.KMP_JUNIT_XML_MAX_MB;
      else process.env.KMP_JUNIT_XML_MAX_MB = saved;
    }
  });

  it('L2: failed task walks the same files twice (count + failures) but warns once per file', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const taskDir = path.join(dir, 'core', 'build', 'test-results', 'jvmTest');
    mkdirSync(taskDir, { recursive: true });
    const bigFile = path.join(taskDir, 'TEST-com.foo.BigFail.xml');
    writeFileSync(bigFile,
      `<testsuite><testcase name="t" classname="C"><failure message="m">b</failure></testcase><system-out>${'y'.repeat(1_500_000)}</system-out></testsuite>`);
    // Future mtime so the fresh-task sinceMs guard deterministically passes
    // and the file reaches the size guard on BOTH walks.
    const future = Math.floor(Date.now() / 1000) + 3600;
    utimesSync(bigFile, future, future);
    const spawn = makeSpawnStub({
      stdout: '> Task :core:jvmTest FAILED\nBUILD FAILED in 1s\n',
      status: 1,
    });
    const stubCoverage = makeRunCoverageStub();
    const saved = process.env.KMP_JUNIT_XML_MAX_MB;
    process.env.KMP_JUNIT_XML_MAX_MB = '1';
    try {
      const { envelope } = await runParallel({
        projectRoot: dir,
        args: ['--test-type', 'common'],
        spawn,
        log: () => {},
        runCoverageInjection: stubCoverage,
      });
      // The count walk AND the failures walk both skipped the same file —
      // dedupe must collapse them into ONE warning.
      const w = envelope.warnings.filter(x => x.code === 'junit_xml_oversized');
      expect(w).toHaveLength(1);
      expect(w[0].file).toContain('TEST-com.foo.BigFail.xml');
    } finally {
      if (saved === undefined) delete process.env.KMP_JUNIT_XML_MAX_MB;
      else process.env.KMP_JUNIT_XML_MAX_MB = saved;
    }
  });

  it('F2: --test-type all suppresses per-leg no_test_modules when another leg passes', async () => {
    // Module declares only jvm() — leg `common` matches, leg `androidUnit` does not.
    // Pre-fix: per-leg `no_test_modules` error → exit 3 even though `common` passed.
    const dir = makeProject([{ name: 'shared', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: '> Task :shared:jvmTest\nBUILD SUCCESSFUL in 5s\n' });
    const stubCoverage = makeRunCoverageStub();
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'all'],
      env: { KMP_TEST_SKIP_ADB: '1' }, // deterministic legs across hosts
      spawn,
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    // No no_test_modules in errors[] (per-leg empties demoted to warnings).
    expect(envelope.errors.some(e => e.code === 'no_test_modules')).toBe(false);
    // Per-leg empties surfaced as warnings instead.
    expect(envelope.warnings.some(w => w.code === 'no_test_modules_for_leg')).toBe(true);
    // Exit 0 — common leg passed, no env error.
    expect(exitCode).toBe(0);
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
// instrumented_only_skipped warning (2026-06-06) — the Compose-UI-only
// "no reports" discoverability fix. The unit/auto leg silently dropped modules
// whose only test surface is androidInstrumentedTest; now it raises a structured
// pointer at --test-type androidInstrumented (suppressed under --test-type all,
// which already targets the instrumented leg).
// ===========================================================================
describe('instrumented_only_skipped warning', () => {
  it('unit leg + instrumented-only module → warning + actionable skip reason', async () => {
    const dir = makeProject([
      { name: 'compose-ui', build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n', sourceSets: ['main', 'androidInstrumentedTest'] },
    ]);
    const spawn = makeSpawnStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidUnit'],
      spawn,
      env: { KMP_TEST_SKIP_ADB: '1' },
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const warn = (envelope.warnings || []).find(w => w.code === 'instrumented_only_skipped');
    expect(warn).toBeTruthy();
    expect(warn.message).toMatch(/androidInstrumented/);
    // Module also lands on skipped[] with the actionable reason (not the old opaque text).
    const sk = (envelope.skipped || []).find(s => /compose-ui/.test(s.module));
    expect(sk).toBeTruthy();
    expect(sk.reason).toMatch(/instrumented-only/i);
  });

  it('--test-type all suppresses the warning (instrumented leg is targeted by the run)', async () => {
    const dir = makeProject([
      { name: 'compose-ui', build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n', sourceSets: ['main', 'androidInstrumentedTest'] },
    ]);
    const spawn = makeSpawnStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'all'],
      spawn,
      env: { KMP_TEST_SKIP_ADB: '1' },
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect((envelope.warnings || []).some(w => w.code === 'instrumented_only_skipped')).toBe(false);
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
  it('true when probe recovered flavored unit tests even with no tracked *Test* source set', () => {
    // A convention-flavored app (src/test<Flavor>/ only) has all-false sourceSets
    // on disk but resolved.flavors is non-empty → must NOT be auto-skipped.
    expect(hasAnyTestSourceSet({ sourceSets: {}, flavors: ['demo', 'prod'] })).toBe(true);
    expect(hasAnyTestSourceSet({ sourceSets: { androidTest: true }, flavors: ['demo'] })).toBe(true);
  });
  it('false when no *Test* source set and no probe flavors (true negative preserved)', () => {
    expect(hasAnyTestSourceSet({ sourceSets: { main: true }, flavors: [] })).toBe(false);
  });
});

// ===========================================================================
// Flavored unit-test source-set gap (probe-recovered flavors)
// ===========================================================================
// A convention-flavored app keeps its unit tests in src/test<Flavor>/ with no
// bare test/androidUnitTest source set. The static walker is blind to it, but
// the probe surfaces test<Flavor><BuildType>UnitTest → resolved.flavors. The
// pickGradleTaskFor gates accept that as unit-test evidence so the module
// dispatches the flavor-agnostic umbrella :m:test (or test<Flavor>...UnitTest
// with --flavor).
describe('pickGradleTaskFor — flavored unit source-set gate (probe flavors)', () => {
  const flavoredApp = {
    name: 'app', type: 'android',
    sourceSets: { test: false, androidUnitTest: false },
    flavors: ['demo', 'prod'], effectiveHasFlavor: true,
    resolved: { unitTestTask: 'test', flavors: ['demo', 'prod'] },
  };
  it('androidUnit: flavored app (probe flavors, no test src) → umbrella :app:test', () => {
    expect(pickGradleTaskFor(flavoredApp, 'androidUnit').task).toBe(':app:test');
  });
  it('androidUnit --flavor demo: flavored app → :app:testDemoDebugUnitTest', () => {
    expect(pickGradleTaskFor(flavoredApp, 'androidUnit', { flavor: 'demo' }).task)
      .toBe(':app:testDemoDebugUnitTest');
  });
  it('default leg: flavored app (probe flavors, no test src) → umbrella :app:test', () => {
    expect(pickGradleTaskFor(flavoredApp, '').task).toBe(':app:test');
  });
  it('androidUnit: instrumented-only module without probe flavors → null + instrumented_only hint', () => {
    const instr = {
      name: 'instrumented-only', type: 'android',
      sourceSets: { test: false, androidUnitTest: false, androidTest: true },
      flavors: [], resolved: { unitTestTask: null },
    };
    const r = pickGradleTaskFor(instr, 'androidUnit');
    expect(r.task).toBeNull();
    // 2026-06-06: the bare "no androidUnitTest source set" reason became an
    // actionable instrumented-only pointer (still a true negative — task null).
    expect(r.reason).toMatch(/androidInstrumented/);
    expect(r.hint).toBe('instrumented_only');
  });
});

describe('runParallel — flavored-unit-only fixture (end-to-end probe + dispatch)', () => {
  const fixture = path.resolve('tests/fixtures/flavored-unit-only');
  it('--test-type androidUnit --module-filter :app → dispatches umbrella :app:test + flavor_defaulted_umbrella', async () => {
    const spawn = makeSpawnStub();
    const { envelope } = await runParallel({
      projectRoot: fixture,
      args: ['--test-type', 'androidUnit', '--module-filter', ':app'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const taskArgs = spawn.calls.filter(isGradleCall).flatMap(effectiveGradleArgs);
    expect(taskArgs).toContain(':app:test');
    expect(taskArgs).not.toContain(':app:testDebugUnitTest');
    expect((envelope.skipped || []).map(s => s.module)).not.toContain(':app');
    const warn = (envelope.warnings || []).find(w => w.code === 'flavor_defaulted_umbrella');
    expect(warn).toBeTruthy();
    expect(warn.candidates).toEqual(['demo', 'prod']);
  });
  it('--test-type androidUnit --module-filter :app --flavor demo → :app:testDemoDebugUnitTest, no flavor_unused', async () => {
    const spawn = makeSpawnStub();
    const { envelope } = await runParallel({
      projectRoot: fixture,
      args: ['--test-type', 'androidUnit', '--module-filter', ':app', '--flavor', 'demo'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const taskArgs = spawn.calls.filter(isGradleCall).flatMap(effectiveGradleArgs);
    expect(taskArgs).toContain(':app:testDemoDebugUnitTest');
    expect((envelope.errors || []).map(e => e.code)).not.toContain('flavor_unused');
  });
});

// ===========================================================================
// PR5 (2026-05-04) — cascade-isolation retry path. PR #116 added the per-module
// retry but its `anyTaskMentioned` regex (`Task\s+:foo:bar(\s|$)`) was more
// permissive than `classifyTaskExecutionMode`'s strict regex (`Task\s+:foo:bar
// (?:\s+SUFFIX)?\s*$`). Wide-smoke pass-7 found 8/30 cascade cases bypassed
// the retry. PR5 replaces the trigger with the same execution-summary signature
// that pass-7's cascade-detection helper uses and exposes
// `parallel.legs[].cascade_detected` + `parallel.legs[].retry_fired` so
// downstream tooling can read the orchestrator's verdict directly.
// ===========================================================================
describe('cascade-isolation retry path (PR5)', () => {
  // Helper: build a spawn that returns cascade output on the bundled one-shot
  // (>1 task arg) and per-module-defined output on isolated retries.
  function makeCascadeSpawn({ oneShotStdout, perModule = {} }) {
    const calls = [];
    const fn = (cmd, args, opts) => {
      calls.push({ cmd, args: [...args], opts });
      const eArgs = effectiveGradleArgs({ cmd, args });
      const taskArgs = eArgs.filter(a => a.startsWith(':'));
      const isOneShot = taskArgs.length > 1;
      if (isOneShot) {
        return { status: 1, stdout: oneShotStdout, stderr: '', signal: null, error: null };
      }
      const taskArg = taskArgs[0] || '';
      const cfg = perModule[taskArg] ?? { status: 0, stdout: `> Task ${taskArg}\nBUILD SUCCESSFUL in 1s\n` };
      return { status: cfg.status, stdout: cfg.stdout, stderr: cfg.stderr || '', signal: null, error: null };
    };
    fn.calls = calls;
    return fn;
  }

  // Test 1 — Pure cascade (multi-module, single leg): one-shot fails with no
  // task evidence, per-module retries all pass. cascade_detected=true,
  // retry_fired=true, spawn count = 1 (one-shot) + 4 (retries) = 5.
  it('pure cascade single leg → cascade_detected=true, retry_fired=true, retries each module', async () => {
    const dir = makeProject([
      { name: 'a', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'b', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'c', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'd', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeCascadeSpawn({
      oneShotStdout: 'FAILURE: Build failed.\nBUILD FAILED in 1s\n',
    });
    const lines = [];
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: (l) => lines.push(l),
      runCoverageInjection: makeRunCoverageStub(),
    });
    const leg = envelope.parallel.legs[0];
    expect(leg.cascade_detected).toBe(true);
    expect(leg.retry_fired).toBe(true);
    const gradleSpawnCount = spawn.calls.filter(c => isGradleCall(c)).length;
    expect(gradleSpawnCount).toBe(5); // 1 one-shot + 4 per-module retries
    expect(lines.some(l => /retrying per-module|isolate/i.test(l))).toBe(true);
    expect(envelope.tests.passed).toBe(4);
    expect(envelope.tests.failed).toBe(0);
  });

  it('isolated task-resolution failure keeps suffix on culprit only', async () => {
    const dir = makeProject([
      { name: 'a', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'b', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeCascadeSpawn({
      oneShotStdout: 'FAILURE: Build failed.\nBUILD FAILED in 1s\n',
      perModule: {
        ':a:jvmTest': {
          status: 1,
          stdout: 'Cannot locate tasks that match \':a:jvmTest\' as task \'jvmTest\' not found in project \':a\'.\n'
            + 'BUILD FAILED in 1s\n',
        },
        ':b:jvmTest': {
          status: 0,
          stdout: '> Task :b:jvmTest\nBUILD SUCCESSFUL in 1s\n',
        },
      },
    });
    const lines = [];
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: (l) => lines.push(l),
      runCoverageInjection: makeRunCoverageStub(),
    });
    const leg = envelope.parallel.legs[0];
    expect(leg.cascade_detected).toBe(true);
    expect(leg.retry_fired).toBe(true);
    expect(exitCode).toBe(3);
    expect(envelope.errors.some(e => e.code === 'task_not_found')).toBe(true);
    expect(envelope.tests.failed).toBe(1);
    expect(envelope.tests.passed).toBe(1);
    expect(lines).toContain('  [FAIL] a (task not found / build aborted at resolution)');
    expect(lines).toContain('  [PASS] b');
    expect(lines.some(l => l.includes('[FAIL] b'))).toBe(false);
    expect(envelope.errors.some(e => e.code === 'module_failed' && e.module === 'b')).toBe(false);
  });

  // Test 2 — Single-task cascade (nav3-recipes shape): 1 module, leg fails,
  // no task evidence. PR5 drops the `taskList.length > 1` requirement so the
  // retry now fires for single-task cascades too — surfaces the per-module
  // gradle error context that the bundled-leg output buried.
  it('single-task cascade (nav3 shape) → retry fires (drops the >1 requirement)', async () => {
    const dir = makeProject([
      { name: 'app', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    // Single-task case: the one-shot dispatch and the per-module retry have
    // the same `:app:jvmTest` arg shape, so we can't differentiate them by
    // task-count. Track call sequence instead: first call returns cascade
    // output (status=1, no evidence), second call returns the same cascade
    // output (the underlying task IS broken — retry surfaces same diagnostic
    // in isolation). Both calls trip cascade detection per-call.
    const calls = [];
    const spawn = (cmd, args, opts) => {
      calls.push({ cmd, args: [...args], opts });
      return { status: 1, stdout: 'FAILURE: Build failed.\nBUILD FAILED in 1s\n', stderr: '', signal: null, error: null };
    };
    spawn.calls = calls;
    const lines = [];
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: (l) => lines.push(l),
      runCoverageInjection: makeRunCoverageStub(),
    });
    const leg = envelope.parallel.legs[0];
    expect(leg.cascade_detected).toBe(true);
    expect(leg.retry_fired).toBe(true);
    const gradleSpawnCount = calls.filter(c => isGradleCall(c)).length;
    // 1 one-shot + 1 per-module retry = 2 spawns. Pre-fix this would be 1
    // (retry guard's `taskList.length > 1` blocked the single-task case).
    expect(gradleSpawnCount).toBe(2);
    expect(lines.some(l => /retrying per-module|isolate/i.test(l))).toBe(true);
  });

  // Test 3 — Real failures (gradle reported `> Task :mod:jvmTest FAILED`)
  // do NOT trigger the retry. cascade_detected requires failed===0, so when
  // any task explicitly failed the retry is skipped — gradle has actionable
  // diagnostic in the original output already.
  it('real failures (FAILED marker) → cascade_detected=false, no retry', async () => {
    const dir = makeProject([
      { name: 'a', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'b', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub({
      failTasks: [':a:jvmTest', ':b:jvmTest'],
      stdout: '> Task :a:jvmTest FAILED\n> Task :b:jvmTest FAILED\nBUILD FAILED in 1s\n',
    });
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const leg = envelope.parallel.legs[0];
    expect(leg.cascade_detected).toBe(false);
    expect(leg.retry_fired).toBe(false);
    const gradleSpawnCount = spawn.calls.filter(c => isGradleCall(c)).length;
    expect(gradleSpawnCount).toBe(1); // no retry — only the one-shot
    expect(envelope.tests.failed).toBe(2);
  });

  // Test 4 — `anyTaskMentioned` false-positive regression guard. The original
  // PR #116 regex matched ANY mid-line `Task :foo:bar` mention, which gradle's
  // daemon/log output sometimes prints during housekeeping (not actual task
  // execution). Such a mention would set anyTaskMentioned=true and skip the
  // retry. PR5 uses the strict execution-mode regex (`Task ... \s*$` anchored
  // to line-end with optional suffix), so housekeeping mentions don't poison
  // the cascade signal. This test injects exactly the kind of mid-line mention
  // that fooled the old guard and verifies the retry now fires.
  it('mid-line `Task :foo:bar` mention does NOT block retry (regex divergence fix)', async () => {
    const dir = makeProject([
      { name: 'a', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'b', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    // Mid-line mention that the OLD lax regex `Task\s+:foo:bar(\s|$)` would
    // match (because `Task :a:jvmTest dispatch` has whitespace after the task
    // name) but the NEW strict regex `Task ...\s*$` (anchored to line-end)
    // will not match.
    const spawn = makeCascadeSpawn({
      oneShotStdout: 'Daemon vm using Task :a:jvmTest dispatch context\n'
                   + 'Daemon vm using Task :b:jvmTest dispatch context\n'
                   + 'FAILURE: Build failed.\n'
                   + 'BUILD FAILED in 1s\n',
    });
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const leg = envelope.parallel.legs[0];
    expect(leg.cascade_detected).toBe(true);
    expect(leg.retry_fired).toBe(true);
    const gradleSpawnCount = spawn.calls.filter(c => isGradleCall(c)).length;
    expect(gradleSpawnCount).toBe(3); // 1 one-shot + 2 retries
  });

  // Test 5 — Mixed in same leg (1 task FAILED, 1 task no_evidence). The
  // cascade trigger requires `failed === 0` — this leg has failed===1 so the
  // retry is NOT fired. The no_evidence task is left as the orchestrator's
  // defense-in-depth marks it (failed via classifyTaskResults's
  // legExit-and-no-mention guard). Conservative: only retry pure cascades.
  it('mixed in-leg (1 failed + 1 no_evidence) → cascade_detected=false (failed > 0)', async () => {
    const dir = makeProject([
      { name: 'a', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'b', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub({
      // a's task failed explicitly (FAILED marker); b's task never mentioned
      // (no_evidence). execSummary.failed=1, no_evidence=1 → cascade NOT
      // triggered (requires failed===0).
      stdout: '> Task :a:jvmTest FAILED\nBUILD FAILED in 1s\n',
      status: 1,
    });
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const leg = envelope.parallel.legs[0];
    expect(leg.cascade_detected).toBe(false);
    expect(leg.retry_fired).toBe(false);
    const gradleSpawnCount = spawn.calls.filter(c => isGradleCall(c)).length;
    expect(gradleSpawnCount).toBe(1);
  });

  // Test 6 — Envelope shape: every leg always emits cascade_detected and
  // retry_fired as booleans (never undefined). Locks the field contract so
  // downstream consumers can rely on the orchestrator's verdict being present
  // for all legs (passing, cascading, real-failure, and empty no-modules).
  it('envelope shape: every leg has cascade_detected + retry_fired as booleans', async () => {
    const dir = makeProject([
      { name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub({
      stdout: '> Task :core:jvmTest\nBUILD SUCCESSFUL in 1s\n',
      status: 0,
    });
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const leg = envelope.parallel.legs[0];
    expect(typeof leg.cascade_detected).toBe('boolean');
    expect(typeof leg.retry_fired).toBe('boolean');
    expect(leg.cascade_detected).toBe(false);
    expect(leg.retry_fired).toBe(false);
  });
});

// ===========================================================================
// fix-PR-E (2026-05-04) — execution-summary classifier counts non-JVM test
// task RUNTIME failures. Pre-fix, classifyTaskExecutionMode's strict-EOL
// regex (`Task\s+ESCAPED(?:\s+SUFFIX)?\s*$`) missed K/N native + AGP
// instrumented runtime fails where gradle prints `> Task :foo FAILED in Xs`
// (non-whitespace before EOL) — execMode dropped to 'fresh' (first-match wins
// on the bare `> Task :foo` line printed at task-start) or 'no_evidence' (no
// task line at all). classifyTaskResults still caught these via its
// non-anchored primary regex (`escaped + '\s+FAILED'`), so [FAIL]-line
// emission + errors[].module_failed entries were correct — but execSummary.
// failed stayed 0, breaking OS parity (PRODUCT.md criterion 2) and false-firing
// cascade-isolation retry (`failed===0 && no_evidence>0`) on real-failure legs.
//
// The fix is two surgical changes in executeLeg:
//   (1) cascade trigger: `failed===0 && no_evidence>0` → `no_evidence===taskList.length`
//       (literal "every task ended up no_evidence" — gradle ran nothing).
//   (2) post-step-5 alignment: rebuild execSummary from classifyTaskResults
//       so execution.failed === errors.module_failed-count per leg.
//
// Repro envelopes: private-lib Mac `macos` leg + Win `androidInstrumented`
// leg + di-sample `androidInstrumented` leg (.smoke/pass-9/).
// ===========================================================================
describe('execution.failed counter on non-JVM task failures (fix-PR-E)', () => {
  // Test 1 — K/N runtime fail with `FAILED in Xs` suffix. The strict-EOL
  // anchor in classifyTaskExecutionMode misses the FAILED suffix because of
  // the trailing duration. The bare `> Task :a:jvmTest` line earlier in the
  // stream wins as 'fresh' on first-match. Pre-fix: execution.failed=0
  // (envelope wrong, OS-parity broken). Post-fix: alignment promotes the task
  // from fresh → failed, matching errors.module_failed count.
  it('K/N-style runtime fail (FAILED in Xs suffix) → execution.failed=1, cascade=false', async () => {
    const dir = makeProject([
      { name: 'a', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub({
      stdout: '> Task :a:jvmTest\n'
            + 'kotlin.test.AssertionError\n'
            + '  at TestImpl.testThing(Test.kt:42)\n'
            + '> Task :a:jvmTest FAILED in 5s\n'
            + 'BUILD FAILED in 6s\n',
      status: 1,
    });
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const leg = envelope.parallel.legs[0];
    expect(leg.execution.failed).toBe(1);
    expect(leg.execution.fresh).toBe(0);
    expect(leg.cascade_detected).toBe(false);
    expect(leg.retry_fired).toBe(false);
    expect(envelope.tests.failed).toBe(1);
    const moduleFailedCount = envelope.errors.filter(e => e.code === 'module_failed').length;
    expect(moduleFailedCount).toBe(1);
    expect(leg.execution.failed).toBe(moduleFailedCount); // OS-parity invariant
  });

  // Test 2 — AGP instrumented runtime fail (`connectedDebugAndroidTest`).
  // Same FAILED-with-trailing-content shape. Locks the AGP-on-device path
  // (Win-S22 / Mac-S25 repros from wide-smoke pass-9 post-toolchain re-runs).
  // Note: the dispatched task is `:a:jvmTest` (project model), but the stdout
  // shape is what classifyTaskExecutionMode parses — so the test is meaningful
  // for the classifier behavior regardless of the actual task class dispatched.
  it('AGP instrumented-style runtime fail → execution.failed=1, cascade=false', async () => {
    const dir = makeProject([
      { name: 'app', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub({
      stdout: '> Task :app:jvmTest\n'
            + 'Finished testRun\n'
            + 'There were failing tests. See the report at: file:///...\n'
            + '> Task :app:jvmTest FAILED in 12s\n'
            + 'BUILD FAILED in 13s\n',
      status: 1,
    });
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const leg = envelope.parallel.legs[0];
    expect(leg.execution.failed).toBe(1);
    expect(leg.cascade_detected).toBe(false);
    expect(envelope.tests.failed).toBe(1);
  });

  // Test 3 — KMP plugin alias path (`androidConnectedCheck` shape, no Debug/
  // Release variant suffix — the new `com.android.kotlin.multiplatform.library`
  // plugin emits this single composite task). Locks the AGP-KMP plugin path
  // detected by fix-PR-D (PR #126).
  it('androidConnectedCheck-style runtime fail (KMP plugin alias) → execution.failed=1', async () => {
    const dir = makeProject([
      { name: 'mod', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub({
      stdout: '> Task :mod:jvmTest\n'
            + 'Test instrumentation runner finished with 3 tests, 1 failure\n'
            + '> Task :mod:jvmTest FAILED in 18s\n'
            + 'FAILURE: Build failed with an exception.\n'
            + 'BUILD FAILED in 20s\n',
      status: 1,
    });
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const leg = envelope.parallel.legs[0];
    expect(leg.execution.failed).toBe(1);
    expect(leg.cascade_detected).toBe(false);
  });

  // Test 4 — Mixed K/N + JVM-success in same leg. 2 tasks complete cleanly
  // (matching strict-EOL → 'fresh'), 1 task runtime-fails with non-EOL FAILED.
  // Pre-fix: leg shows fresh:2, no_evidence:1, failed:0, cascade_detected=true,
  // retry_fired=true (the di-sample Win-side bug shape — wasted gradle
  // work). Post-fix: cascade signature requires no_evidence === taskList.length,
  // which fails (1 !== 3) — no spurious retry. Alignment promotes the failing
  // task from fresh → failed, leaving fresh:2, failed:1, total preserved.
  it('mixed K/N-fail + 2 JVM-pass in same leg → cascade NOT fired, failed=1', async () => {
    const dir = makeProject([
      { name: 'a', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'b', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'c', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub({
      stdout: '> Task :a:jvmTest\n'
            + '> Task :b:jvmTest\n'
            + '> Task :c:jvmTest\n'
            + 'kotlin.test.AssertionError\n'
            + '> Task :c:jvmTest FAILED in 4s\n'
            + 'BUILD FAILED in 5s\n',
      status: 1,
    });
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const leg = envelope.parallel.legs[0];
    // Counter alignment (Change 2): :c promoted from fresh → failed.
    expect(leg.execution.failed).toBe(1);
    expect(leg.execution.fresh).toBe(2);
    // Bucket-total preserved.
    const total = leg.execution.fresh + leg.execution.up_to_date
                + leg.execution.from_cache + leg.execution.no_source
                + leg.execution.skipped_by_gradle + leg.execution.failed
                + leg.execution.no_evidence;
    expect(total).toBe(3);
    // Cascade trigger (Change 1): no_evidence !== taskList.length → suppressed.
    expect(leg.cascade_detected).toBe(false);
    expect(leg.retry_fired).toBe(false);
    expect(envelope.tests.failed).toBe(1);
    expect(envelope.tests.passed).toBe(2);
  });

  // Test 5 — Pure cascade (Cannot locate task → all tasks no_evidence).
  // Both Change 1 (cascade still fires when every task is no_evidence) and
  // Change 2 (alignment promotes resolutionFailed-marked tasks from
  // no_evidence → failed in the final envelope) exercised together.
  it('pure cascade (Cannot locate) → cascade fires + alignment promotes to failed', async () => {
    const dir = makeProject([
      { name: 'a', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'b', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub({
      stdout: 'Cannot locate tasks that match \':a:jvmTest\' as task \'jvmTest\' not found in project \':a\'.\n'
            + 'BUILD FAILED in 1s\n',
      resolutionFail: true,
    });
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const leg = envelope.parallel.legs[0];
    // Change 1 — cascade trigger fires: every task is no_evidence (no
    // Task-status lines printed) → no_evidence === taskList.length.
    expect(leg.cascade_detected).toBe(true);
    expect(leg.retry_fired).toBe(true);
    // Change 2 — alignment: classifyTaskResults marks all 'failed' via
    // resolutionFailed branch in BOTH the bundled one-shot AND each per-module
    // retry, so the final aligned execSummary surfaces all modules as failed.
    expect(leg.execution.failed).toBe(2);
    expect(leg.execution.no_evidence).toBe(0);
    expect(envelope.tests.failed).toBe(2);
  });

  // Test 6 — Regression guard: classic JVM `> Task :foo:test FAILED\n` shape
  // (FAILED at clean EOL, no trailing content). classifyTaskExecutionMode
  // already counts these correctly via the strict-EOL anchor; alignment is
  // a no-op (failedTasks.size === execSummary.failed). Locks the JVM path
  // against future regressions to either Change 1 or Change 2.
  it('regression guard: classic JVM `> Task FAILED\\n` (clean EOL) → execution.failed=2', async () => {
    const dir = makeProject([
      { name: 'a', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'b', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub({
      failTasks: [':a:jvmTest', ':b:jvmTest'],
      stdout: '> Task :a:jvmTest FAILED\n> Task :b:jvmTest FAILED\nBUILD FAILED in 1s\n',
    });
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const leg = envelope.parallel.legs[0];
    expect(leg.execution.failed).toBe(2);
    expect(leg.execution.no_evidence).toBe(0);
    // Cascade trigger (new semantic): no_evidence !== taskList.length → suppressed.
    expect(leg.cascade_detected).toBe(false);
    expect(leg.retry_fired).toBe(false);
    expect(envelope.tests.failed).toBe(2);
  });
});

// 2026-05-05 fix-PR-G — `--test-filter` translation per task class.
// JvmTestTask / KotlinNativeTest / KotlinJsTest accept `--tests <pattern>`;
// AGP AndroidConnectedTest does NOT. Pre-fix the orchestrator pushed
// `--tests` blindly for every leg, breaking
// `kmp-test parallel --test-type androidInstrumented --test-filter <X>`
// with `Unknown command-line option '--tests'`. Mirrors
// `lib/android-orchestrator.js#buildFilterArgs`.
//
// 2026-05-05 v0.9 step 1 (flag #6) — method-bearing filters now emit the
// COMBINED single-arg shape `class=<FQN>#<method>` instead of separate
// `class=` + `method=` args. The combined form is the canonical AGP /
// AndroidJUnitRunner shape that ALWAYS works (per BACKLOG.md L329) — the
// pre-v0.9 separate-args shape silently missed Microbenchmark method
// filtering (live repro on di-sample: 14 of 14 DiBenchmark methods
// ran instead of 1). Pre-v0.9 cases re-asserted below.
describe('buildFilterArgs (fix-PR-G + v0.9 step 1 flag #6)', () => {
  it('androidInstrumented + FQN class → -P class only', () => {
    const args = buildFilterArgs('com.grinwich.benchmark.DiBenchmark', 'androidInstrumented', '/tmp/np');
    expect(args).toEqual([
      '-Pandroid.testInstrumentationRunnerArguments.class=com.grinwich.benchmark.DiBenchmark',
    ]);
  });

  it('androidInstrumented + FQN#method (canonical separator) → combined single arg', () => {
    const args = buildFilterArgs(
      'com.grinwich.benchmark.DiBenchmark#lazyInit_noDeps_daggerB_analytics',
      'androidInstrumented',
      '/tmp/np',
    );
    expect(args).toEqual([
      '-Pandroid.testInstrumentationRunnerArguments.class=com.grinwich.benchmark.DiBenchmark#lazyInit_noDeps_daggerB_analytics',
    ]);
  });

  it('androidInstrumented + FQN.method (heuristic split, lowerCamel last segment) → combined single arg', () => {
    const args = buildFilterArgs(
      'com.grinwich.benchmark.DiBenchmark.lazyInit_noDeps_daggerB_analytics',
      'androidInstrumented',
      '/tmp/np',
    );
    expect(args).toEqual([
      '-Pandroid.testInstrumentationRunnerArguments.class=com.grinwich.benchmark.DiBenchmark#lazyInit_noDeps_daggerB_analytics',
    ]);
  });

  it('androidInstrumented + FQN#method does NOT emit a separate .method= arg (Microbenchmark fix)', () => {
    const args = buildFilterArgs(
      'com.foo.Bench#one',
      'androidInstrumented',
      '/tmp/np',
    );
    expect(args).toHaveLength(1);
    expect(args[0]).toBe('-Pandroid.testInstrumentationRunnerArguments.class=com.foo.Bench#one');
    expect(args.some(a => a.startsWith('-Pandroid.testInstrumentationRunnerArguments.method='))).toBe(false);
  });

  it('androidInstrumented + class-only does NOT inject a fake `#` (regression guard)', () => {
    const args = buildFilterArgs('com.foo.Bench', 'androidInstrumented', '/tmp/np');
    expect(args).toEqual([
      '-Pandroid.testInstrumentationRunnerArguments.class=com.foo.Bench',
    ]);
    expect(args[0].includes('#')).toBe(false);
  });

  it('androidUnit (testDebugUnitTest = JvmTestTask) preserves --tests pattern', () => {
    expect(buildFilterArgs('FooTest', 'androidUnit', '/tmp/np')).toEqual(['--tests', 'FooTest']);
  });

  it('common / desktop (jvmTest / desktopTest = JvmTestTask) preserves --tests', () => {
    expect(buildFilterArgs('FooTest', 'common', '/tmp/np')).toEqual(['--tests', 'FooTest']);
    expect(buildFilterArgs('FooTest', 'desktop', '/tmp/np')).toEqual(['--tests', 'FooTest']);
  });

  it('ios / macos (KotlinNativeTest accepts --tests) preserves --tests', () => {
    expect(buildFilterArgs('FooTest', 'ios', '/tmp/np')).toEqual(['--tests', 'FooTest']);
    expect(buildFilterArgs('FooTest', 'macos', '/tmp/np')).toEqual(['--tests', 'FooTest']);
  });

  it('js / wasmJs (KotlinJsTest accepts --tests) preserves --tests', () => {
    expect(buildFilterArgs('FooTest', 'js', '/tmp/np')).toEqual(['--tests', 'FooTest']);
    expect(buildFilterArgs('FooTest', 'wasmJs', '/tmp/np')).toEqual(['--tests', 'FooTest']);
  });

  it('empty filter → no args (regardless of test type)', () => {
    expect(buildFilterArgs('', 'androidInstrumented', '/tmp/np')).toEqual([]);
    expect(buildFilterArgs(null, 'common', '/tmp/np')).toEqual([]);
    expect(buildFilterArgs(undefined, 'ios', '/tmp/np')).toEqual([]);
  });
});

// fix-PR-G integration: confirm gradleArgs at the spawn site contain
// `-Pandroid.testInstrumentationRunnerArguments.*` (NOT `--tests`) when the
// leg dispatches an instrumented task. End-to-end through runParallel against
// the `common` leg (deterministic — no adb / device probe in path) so we
// regression-guard the JVM-side preservation. The androidInstrumented
// leg's translation is locked at the unit level by `buildFilterArgs` above
// + the live di-sample run.
describe('runParallel: --test-filter on common leg preserves --tests (fix-PR-G regression guard)', () => {
  it('common leg with --test-filter still uses --tests', async () => {
    const dir = makeProject([
      { name: 'shared', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL\n> Task :shared:jvmTest\n' });
    await runParallel({
      projectRoot: dir,
      args: [
        '--test-type', 'common',
        '--test-filter', 'com.example.MyTest',
      ],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const gradleCalls = spawn.calls.filter(c => isGradleCall(c) && !isStopCall(c));
    expect(gradleCalls.length).toBeGreaterThanOrEqual(1);
    const args = effectiveGradleArgs(gradleCalls[0]);
    expect(args).toContain('--tests');
    expect(args).toContain('com.example.MyTest');
    // No -Pandroid.* leak into JVM legs.
    expect(args.some(a => a.startsWith('-Pandroid.testInstrumentationRunner'))).toBe(false);
  });
});

// Spawn stub that reproduces the "first call fails, retry passes" pattern
// used by --auto-retry tests. The `failNthGradleCall` option specifies which
// 1-indexed gradle call should return failure (others pass). Adb calls always
// pass with no output. Differentiates adb from gradle by command name.
function makeAutoRetrySpawnStub({ failNthGradleCall = 1, failTasks = [] } = {}) {
  const calls = [];
  let gradleCallNum = 0;
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], cwd: opts?.cwd ?? null, env: opts?.env ?? null });
    if (cmd === 'adb') {
      return { status: 0, stdout: '', stderr: '', signal: null, error: null };
    }
    // Gradle call (gradlew or cmd.exe wrapping gradlew on Windows).
    gradleCallNum++;
    const eArgs = effectiveGradleArgs({ cmd, args });
    const taskArg = eArgs.find(a => typeof a === 'string' && a.startsWith(':'));
    let stdout = 'BUILD SUCCESSFUL\n';
    if (taskArg) stdout = `> Task ${taskArg}\n${taskArg} ${gradleCallNum === failNthGradleCall ? 'FAILED' : ''}\nBUILD ${gradleCallNum === failNthGradleCall ? 'FAILED' : 'SUCCESSFUL'}\n`;
    const status = gradleCallNum === failNthGradleCall || failTasks.includes(taskArg) ? 1 : 0;
    return { status, stdout, stderr: '', signal: null, error: null };
  };
  fn.calls = calls;
  return fn;
}

// 2026-05-05 v0.9 step 1 (flag #3) — `--device <serial>` validates against
// adb output and injects ANDROID_SERIAL into the gradle dispatch env. The
// envelope surfaces `parallel.legs[i].device.serial` on the
// androidInstrumented leg only (clean shape — agents branch on field
// presence). Adb probe failure modes (no devices / serial not found) emit
// `instrumented_setup_failed` + exit 3, mirroring `kmp-test android`.
describe('runParallel --device <serial> (v0.9 step 1, flag #3)', () => {
  it('validates against adb probe + threads ANDROID_SERIAL into dispatchEnv', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL\n> Task :app:connectedDebugAndroidTest\n' });
    const adbProbe = () => [
      { serial: 'DEVICE_SERIAL_FAKE', type: 'physical', model: 'SM-S908B' },
      { serial: 'emulator-5554', type: 'emulator', model: 'sdk' },
    ];

    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--device', 'DEVICE_SERIAL_FAKE'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    expect(exitCode).toBe(0);
    // Envelope surfaces resolved device on the androidInstrumented leg.
    const leg = envelope.parallel.legs.find(l => l.test_type === 'androidInstrumented');
    expect(leg).toBeDefined();
    expect(leg.device).toEqual({ serial: 'DEVICE_SERIAL_FAKE' });

    // Gradle spawn env got ANDROID_SERIAL.
    const gradleCalls = spawn.calls.filter(c => isGradleCall(c) && !isStopCall(c));
    expect(gradleCalls.length).toBeGreaterThanOrEqual(1);
    expect(gradleCalls[0].env.ANDROID_SERIAL).toBe('DEVICE_SERIAL_FAKE');
  });

  it('--device with no adb devices → instrumented_setup_failed, exit 3', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    const spawn = makeSpawnStub();
    const adbProbe = () => [];

    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--device', 'NOPE'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    expect(exitCode).toBe(3);
    expect(envelope.errors[0].code).toBe('instrumented_setup_failed');
    // No gradle dispatch happened.
    expect(spawn.calls.filter(c => isGradleCall(c) && !isStopCall(c))).toEqual([]);
  });

  it('--device with serial not in probe → instrumented_setup_failed, exit 3', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'X', type: 'physical', model: 'Y' }];

    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--device', 'NOPE'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    expect(exitCode).toBe(3);
    expect(envelope.errors[0].code).toBe('instrumented_setup_failed');
    expect(envelope.errors[0].message).toMatch(/Available: X/);
  });

  it('--device with no androidInstrumented leg → no probe (silent no-op)', async () => {
    const dir = makeProject([
      { name: 'shared', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL\n> Task :shared:jvmTest\n' });
    let probeCalled = false;
    const adbProbe = () => { probeCalled = true; return []; };

    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--device', 'DEVICE_SERIAL_FAKE'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    expect(exitCode).toBe(0);
    expect(probeCalled).toBe(false);
    // No device field on the common leg.
    const leg = envelope.parallel.legs.find(l => l.test_type === 'common');
    expect(leg.device).toBeUndefined();
  });
});

// 2026-05-05 v0.9 step 1 (flags #1 + #2) — `--auto-retry` re-dispatches
// failed instrumented tasks once. `--clear-data` (precondition: --auto-retry)
// invokes adb shell pm clear before each retry attempt. Mutually exclusive
// with PR5 cascade-isolation: cascade fires when every task is no_evidence
// (eval-phase abort); auto-retry fires when at least one task ran but came
// back failed.
describe('runParallel --auto-retry + --clear-data (v0.9 step 1, flags #1 + #2)', () => {
  function makeAndroidApp(name = 'app') {
    const modDir = path.join(workDir, name);
    const manifestDir = path.join(modDir, 'src', 'main');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(path.join(manifestDir, 'AndroidManifest.xml'),
      `<manifest package="com.example.${name}"/>`);
  }

  it('--auto-retry re-dispatches failed task once → final exit 0 + retries[]', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    makeAndroidApp('app');
    // First gradle call fails (one-shot dispatch); second (per-task retry) passes.
    const spawn = makeAutoRetrySpawnStub({ failNthGradleCall: 1 });
    const adbProbe = () => [{ serial: 'X', type: 'physical', model: 'Y' }];

    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--auto-retry'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    const leg = envelope.parallel.legs.find(l => l.test_type === 'androidInstrumented');
    expect(leg.retries).toBeDefined();
    expect(leg.retries).toHaveLength(1);
    expect(leg.retries[0]).toMatchObject({
      module: 'app', attempt: 2, status: 'passed',
    });
    expect(leg.exit_code).toBe(0);
    expect(exitCode).toBe(0);
  });

  it('--auto-retry without --clear-data does NOT call adb shell pm clear', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    makeAndroidApp('app');
    const spawn = makeAutoRetrySpawnStub({ failNthGradleCall: 1 });
    const adbProbe = () => [{ serial: 'X', type: 'physical', model: 'Y' }];

    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--auto-retry'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    // No adb pm clear call.
    const adbCalls = spawn.calls.filter(c => c.cmd === 'adb' && c.args.includes('clear'));
    expect(adbCalls).toEqual([]);
  });

  it('--auto-retry --clear-data invokes adb pm clear with resolved package + records pre_run_actions', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    makeAndroidApp('app');
    const spawn = makeAutoRetrySpawnStub({ failNthGradleCall: 1 });
    const adbProbe = () => [{ serial: 'X', type: 'physical', model: 'Y' }];

    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--auto-retry', '--clear-data'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    // adb shell pm clear <pkg> was invoked with the manifest's package.
    const pmClearCall = spawn.calls.find(c => c.cmd === 'adb' && c.args.includes('clear'));
    expect(pmClearCall).toBeDefined();
    expect(pmClearCall.args).toEqual(['-s', 'X', 'shell', 'pm', 'clear', 'com.example.app']);

    // Envelope records the action for downstream consumers / agents.
    const leg = envelope.parallel.legs.find(l => l.test_type === 'androidInstrumented');
    expect(leg.pre_run_actions).toBeDefined();
    expect(leg.pre_run_actions[0]).toMatchObject({
      module: 'app', action: 'pm_clear', package: 'com.example.app',
    });
  });

  it('--clear-data + offline device → device_offline, exit 3', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL\n' });
    const adbProbe = () => [{ serial: 'offline-dev', type: 'physical', model: 'X', state: 'offline' }];

    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--auto-retry', '--clear-data'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    expect(exitCode).toBe(3);
    expect(envelope.errors[0].code).toBe('device_offline');
  });

  it('--clear-data + unauthorized device → device_unauthorized, exit 3', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL\n' });
    const adbProbe = () => [{ serial: 'UNAUTH1', type: 'physical', model: 'X', state: 'unauthorized' }];

    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--auto-retry', '--clear-data'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    expect(exitCode).toBe(3);
    expect(envelope.errors[0].code).toBe('device_unauthorized');
  });

  it('--clear-data + multiple usable devices, no --device → multiple_adb_devices, exit 3', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL\n' });
    const adbProbe = () => [
      { serial: 'DEV1', type: 'physical', model: 'A', state: 'device' },
      { serial: 'DEV2', type: 'physical', model: 'B', state: 'device' },
    ];

    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--auto-retry', '--clear-data'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    expect(exitCode).toBe(3);
    expect(envelope.errors[0].code).toBe('multiple_adb_devices');
  });

  // wet-audit-v0.9-part2 OBS-7 — `--flavor <name>` against a project where
  // no module declares productFlavors {} now hard-fails as CONFIG_ERROR (2)
  // instead of emitting a soft warning + exit 0. Pre-fix (v0.9 step 1)
  // the misconfiguration produced `warnings[].code:'flavor_unused'` that
  // CI gates routinely missed.
  it('--flavor when no module declares productFlavors → CONFIG_ERROR + flavor_unused error (OBS-7)', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        // Plain AGP (no productFlavors block).
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL\n> Task :app:connectedDebugAndroidTest\n' });
    const adbProbe = () => [{ serial: 'X', type: 'physical', model: 'Y' }];

    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--flavor', 'staging'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    expect(exitCode).toBe(2); // CONFIG_ERROR
    const error = envelope.errors.find(e => e.code === 'flavor_unused');
    expect(error).toBeDefined();
    expect(error.flavor).toBe('staging');
    // Lock that the legacy soft-warning is no longer emitted (single source
    // of truth on errors[]).
    expect(envelope.warnings.find(w => w.code === 'flavor_unused')).toBeUndefined();
  });

  // OBS-B (2026-05-09 wet-audit follow-up) — the comment at
  // parallel-orchestrator.js claims the flavor_unused check "runs before
  // any gradle dispatch so we don't waste a build cycle." Pre-fix the
  // error was pushed to state.errors but execution proceeded to the
  // gradle dispatch (~66s wasted on real PrivAndroidApp run). Lock that the
  // orchestrator now early-returns: zero gradle (or adb) spawns.
  it('flavor_unused early-exits before any gradle dispatch (OBS-B)', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    makeAndroidApp('app');
    const spawnCalls = [];
    const spawn = (cmd, args, opts) => {
      spawnCalls.push({ cmd, args: [...args] });
      // Return a benign success in case the orchestrator does invoke a
      // model-probe spawn upstream (which is allowed; only gradle test
      // dispatch must be skipped).
      return { status: 0, stdout: '', stderr: '', signal: null, error: null };
    };
    const adbProbe = () => [{ serial: 'X', type: 'physical', model: 'Y' }];

    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--flavor', 'nonexistent'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    expect(exitCode).toBe(2);
    expect(envelope.errors.find(e => e.code === 'flavor_unused')).toBeDefined();
    // Lock: zero gradle test-task spawns (anything matching connectedDebugAndroidTest
    // / connectedCheck / *AndroidTest is forbidden post-fix).
    const gradleTestSpawns = spawnCalls.filter(c =>
      c.args.some(a => /connectedDebugAndroidTest|connectedCheck|AndroidTest$/i.test(a))
    );
    expect(gradleTestSpawns).toEqual([]);
    // Lock: parallel.legs[] is empty (no leg dispatched).
    expect((envelope.parallel?.legs || []).length).toBe(0);
  });

  // Finding #2 — flavored project, androidUnit leg, NO --flavor → the umbrella
  // `test` task is dispatched (always-correct default) and a non-fatal
  // flavor_defaulted_umbrella warning announces it (exit 0). The ambiguous
  // testDebugUnitTest is NEVER dispatched.
  it('flavored project + androidUnit + no --flavor → umbrella :app:test + flavor_defaulted_umbrella warning (exit 0)', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['test'],
        build: 'plugins { id("com.android.application") }\nandroid { productFlavors { create("demo") {}\ncreate("prod") {} } }\n' },
    ]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidUnit'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect(exitCode).toBe(0);
    expect(envelope.warnings.find(w => w.code === 'flavor_defaulted_umbrella')).toBeDefined();
    const flat = spawn.calls.filter(isGradleCall).map(effectiveGradleArgs).flat();
    expect(flat).toContain(':app:test');                                // umbrella
    expect(flat.some(a => /testDebugUnitTest/.test(a))).toBe(false);    // not the ambiguous task
  });

  // Finding #2 — flavored project + explicit --flavor → the per-variant unit
  // task is woven; no flavor_unused (the project IS flavored) and no umbrella
  // default warning (a flavor was chosen).
  it('flavored project + androidUnit + --flavor demo → testDemoDebugUnitTest, no flavor_unused / umbrella warning', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['test'],
        build: 'plugins { id("com.android.application") }\nandroid { productFlavors { create("demo") {}\ncreate("prod") {} } }\n' },
    ]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidUnit', '--flavor', 'demo'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect(exitCode).toBe(0);
    expect(envelope.errors.find(e => e.code === 'flavor_unused')).toBeUndefined();
    expect(envelope.warnings.find(w => w.code === 'flavor_defaulted_umbrella')).toBeUndefined();
    const flat = spawn.calls.filter(isGradleCall).map(effectiveGradleArgs).flat();
    expect(flat).toContain(':app:testDemoDebugUnitTest');
  });

  it('--auto-retry skipped when cascade-isolation already retried (mutual exclusion)', async () => {
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    makeAndroidApp('app');
    // Cascade-isolation trigger: leg exit ≠ 0 + every task `no_evidence`.
    // No `Task :app:connectedDebugAndroidTest` mention → no_evidence.
    const calls = [];
    let gradleCallNum = 0;
    const spawn = (cmd, args, opts) => {
      calls.push({ cmd, args: [...args], cwd: opts?.cwd ?? null, env: opts?.env ?? null });
      if (cmd === 'adb') return { status: 0, stdout: '', stderr: '', signal: null, error: null };
      gradleCallNum++;
      // First call: cascade trigger (exit 1, no task mention).
      // Subsequent calls (per-module retries from cascade): same shape so
      // tasks are still classified as failed/no_evidence.
      return {
        status: 1,
        stdout: 'BUILD FAILED\n',
        stderr: '',
        signal: null,
        error: null,
      };
    };
    spawn.calls = calls;
    const adbProbe = () => [{ serial: 'X', type: 'physical', model: 'Y' }];

    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--auto-retry'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    const leg = envelope.parallel.legs.find(l => l.test_type === 'androidInstrumented');
    // Cascade fired (per-module retry), auto-retry was skipped → no
    // retries[] entries on the leg (cascade is exposed via cascade_detected
    // + retry_fired; auto-retry's retries[] is distinct).
    expect(leg.cascade_detected).toBe(true);
    expect(leg.retry_fired).toBe(true);
    expect(leg.retries).toBeUndefined();
  });
});

// ===========================================================================
// v0.9 step 4 — `--isolated` Tier 3 concurrency flag.
// Verifies that --isolated injects --project-cache-dir into every gradle
// spawn, that the envelope surfaces the isolated:{} field, that cleanup
// fires on success, and that --dry-run skips both mkdir and cleanup.
// ===========================================================================
describe('--isolated cache-dir injection (v0.9 step 4)', () => {
  it('--isolated --dry-run emits envelope.isolated with would-be path; no spawn, no mkdir', async () => {
    const dir = makeProject([{ name: 'core' }]);
    const spawn = makeSpawnStub();
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--module-filter', 'core', '--dry-run', '--isolated'],
      spawn,
    });
    expect(exitCode).toBe(0);
    expect(envelope.isolated).toBeDefined();
    expect(envelope.isolated.enabled).toBe(true);
    expect(envelope.isolated.cache_dir).toMatch(/[\\/]\.kmp-test-runner[\\/]cache-isolated[\\/]/);
    expect(envelope.isolated.kept).toBe(false);
    expect(envelope.isolated.locked).toBe(true);
    // No gradle dispatch on dry-run.
    expect(spawn.calls.filter(c => isGradleCall(c.args)).length).toBe(0);
    // The would-be cache_dir must NOT exist (dryRun:true skipped mkdir).
    expect(existsSync(envelope.isolated.cache_dir)).toBe(false);
  });

  it('--isolated injects --project-cache-dir into every gradle spawn and cleans up after', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--module-filter', 'core', '--isolated'],
      spawn,
      runCoverageInjection: stubCoverage,
    });
    expect(exitCode).toBe(0);
    expect(envelope.isolated.enabled).toBe(true);
    const cacheDir = envelope.isolated.cache_dir;
    expect(cacheDir).toBeTruthy();
    // Every gradle invocation receives `--project-cache-dir <cacheDir>`.
    const gradleCalls = spawn.calls.filter(c => isGradleCall(c));
    expect(gradleCalls.length).toBeGreaterThan(0);
    for (const call of gradleCalls) {
      const flat = effectiveGradleArgs(call).join(' ');
      expect(flat).toContain('--project-cache-dir');
      expect(flat).toContain(cacheDir);
    }
    // Cleanup happened: the auto-generated dir was removed (kept:false).
    expect(envelope.isolated.kept).toBe(false);
    expect(existsSync(cacheDir)).toBe(false);
  });

  it('--isolated-cache-dir <path> is preserved (kept:true, dir survives run)', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const userCache = path.join(dir, 'my-cache');
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--module-filter', 'core', '--isolated-cache-dir', userCache],
      spawn,
      runCoverageInjection: stubCoverage,
    });
    expect(exitCode).toBe(0);
    expect(envelope.isolated.enabled).toBe(true);
    expect(envelope.isolated.cache_dir).toBe(userCache);
    expect(envelope.isolated.kept).toBe(true);
    // User-supplied dir survives cleanup.
    expect(existsSync(userCache)).toBe(true);
  });

  it('without --isolated → envelope.isolated reports enabled:false; no --project-cache-dir injected', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--module-filter', 'core'],
      spawn,
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.isolated).toEqual({
      enabled: false, cache_dir: null, kept: false, locked: true,
    });
    const gradleCalls = spawn.calls.filter(c => isGradleCall(c));
    expect(gradleCalls.length).toBeGreaterThan(0);
    for (const call of gradleCalls) {
      expect(effectiveGradleArgs(call).join(' ')).not.toContain('--project-cache-dir');
    }
  });

  it('--isolated-no-lock surfaces locked:false in envelope', async () => {
    const dir = makeProject([{ name: 'core' }]);
    const spawn = makeSpawnStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--module-filter', 'core', '--dry-run', '--isolated', '--isolated-no-lock'],
      spawn,
    });
    expect(envelope.isolated.locked).toBe(false);
  });

  it('KMP_TEST_KEEP_ISOLATED=1 skips cleanup of auto-generated dir', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--module-filter', 'core', '--isolated'],
      env: { ...process.env, KMP_TEST_KEEP_ISOLATED: '1' },
      spawn,
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.isolated.kept).toBe(true);
    expect(existsSync(envelope.isolated.cache_dir)).toBe(true);
    // Test-side cleanup of the auto-generated dir (afterEach removes workDir
    // recursively, so this is technically belt-and-braces).
    rmSync(envelope.isolated.cache_dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// v0.9 step 9.5 (Bug #5) — coverage envelope shape parity. Pre-fix
// parallel-orchestrator's state.coverage was {tool, missed_lines} only,
// missing the kover/jacoco module lists that android + coverage emit. Now
// included + populated from project-model coveragePlugin per discovered module.
// ---------------------------------------------------------------------------
describe('runParallel coverage envelope shape parity (Bug #5)', () => {
  it('coverage block always includes modules_with_kover_plugin + modules_with_jacoco_plugin', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain'] }]);
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--dry-run', '--test-type', 'common'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    // dry-run uses cli.js#buildDryRunReport which already had the fields,
    // but verifying anyway for shape stability.
    expect(envelope.coverage).toHaveProperty('modules_with_kover_plugin');
    expect(envelope.coverage).toHaveProperty('modules_with_jacoco_plugin');
    expect(Array.isArray(envelope.coverage.modules_with_kover_plugin)).toBe(true);
    expect(Array.isArray(envelope.coverage.modules_with_jacoco_plugin)).toBe(true);
  });

  it('populates kover/jacoco lists from coveragePlugin field on real run', async () => {
    const dir = makeProject([
      { name: 'k', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'],
        build: `plugins { kotlin("jvm"); id("org.jetbrains.kotlinx.kover") }\n` },
      { name: 'j', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'],
        build: `plugins { kotlin("jvm"); id("jacoco") }\n` },
      { name: 'plain', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'],
        build: `plugins { kotlin("jvm") }\n` },
    ]);
    const spawn = makeSpawnStub({ stdoutLines: [
      '> Task :k:test',
      '1 tests completed',
      'BUILD SUCCESSFUL',
    ]});
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
    });
    expect(envelope.coverage.modules_with_kover_plugin).toContain('k');
    expect(envelope.coverage.modules_with_jacoco_plugin).toContain('j');
    expect(envelope.coverage.modules_with_kover_plugin).not.toContain('plain');
    expect(envelope.coverage.modules_with_jacoco_plugin).not.toContain('plain');
  });
});

// ---------------------------------------------------------------------------
// v0.9 step 9.8 (Bug #7) — `--list-only` short-circuit. Pre-fix `parallel`
// silently ignored the flag (documented for `android` only) and dispatched
// gradle, exiting with `no_summary`. Post-fix mirrors android: emit the
// post-filter module set on `modules[]`, populate `skipped[]` + coverage,
// exit 0 before any gradle dispatch.
// ---------------------------------------------------------------------------
describe('runParallel --list-only short-circuits before gradle dispatch (Bug #7)', () => {
  it('emits modules[] + skipped[] + coverage, exits 0, no spawn calls', async () => {
    const dir = makeProject([
      { name: 'core',    sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'feature', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const spawn = makeSpawnStub();
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--list-only'],
      spawn,
      log: () => {},
    });
    expect(exitCode).toBe(0);
    expect(envelope.exit_code).toBe(0);
    expect(envelope.modules.length).toBe(2);
    expect(envelope.modules.map(m => m.name).sort()).toEqual(['core', 'feature']);
    expect(envelope.errors).toEqual([]);
    expect(envelope.parallel?.list_only).toBe(true);
    // No gradle dispatch — only model-build spawn calls (project-model probe)
    // are expected; the gradlew test invocations should not happen.
    const gradleCalls = spawn.calls.filter(c => /gradlew/.test(c[0] || c.join(' ')));
    // Allow 0 or 1 gradle calls (project-model probe is OK; test dispatch is not).
    expect(gradleCalls.length).toBeLessThanOrEqual(1);
  });

  it('--list-only respects --module-filter — only filtered modules emitted', async () => {
    const dir = makeProject([
      { name: 'core',           sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'feature',        sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
      { name: 'benchmark-core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--list-only', '--module-filter', 'core'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    // Substring "core" → matches "core" + "benchmark-core" (per Bug #3 contract).
    const names = envelope.modules.map(m => m.name).sort();
    expect(names).toContain('core');
    expect(names).toContain('benchmark-core');
    expect(names).not.toContain('feature');
  });

  it('--list-only with empty filter result still surfaces no_test_modules error (consistent with full run)', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--list-only', '--module-filter', 'nonexistent'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    expect(exitCode).not.toBe(0);
    expect(envelope.errors[0]?.code).toBe('no_test_modules');
  });

  it('--list-only populates coverage.modules_with_kover_plugin (parity with full-run shape)', async () => {
    const dir = makeProject([
      { name: 'k', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'],
        build: `plugins { kotlin("jvm"); id("org.jetbrains.kotlinx.kover") }\n` },
      { name: 'plain', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'],
        build: `plugins { kotlin("jvm") }\n` },
    ]);
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--list-only'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    expect(envelope.coverage.modules_with_kover_plugin).toContain('k');
    expect(envelope.coverage.modules_with_kover_plugin).not.toContain('plain');
  });

  it('--list (alias for --list-only) accepted', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--list'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    expect(exitCode).toBe(0);
    expect(envelope.parallel?.list_only).toBe(true);
  });

  it('--list-only carries top-level isolated:{} field (shape parity)', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--list-only', '--isolated'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    expect(envelope.isolated).toBeDefined();
    expect(envelope.isolated.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v0.9 wet-audit drift #1: legit-skip when --module-filter matches modules
// but every match fails the per-leg test-type target check (no jvm target,
// no commonTest, env SKIP_*_MODULES, etc.). Pre-fix emitted `no_test_modules`
// + exit 3 even though the skipped[] entries already explained the skip.
// Post-fix: skipped[] entries carry the diagnostic, errors[] stays empty,
// exit 0. Filter-actually-matched-nothing still surfaces the error at
// runParallel's top-level (modules.length === 0 guard at line 1348).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// v0.9 wet-audit drift #2: modules[] shape parity between list-only and wet.
// Pre-fix: list-only emitted `[{name, type, coverage_plugin, ...}]` (objects)
// but wet runs emitted `["sample-result"]` (bare strings). Agents reading the
// same `modules[]` field across paths had to branch on shape. Post-fix both
// paths emit canonical objects via `canonicalModuleEntry`.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// v0.9 wet-audit drift #3: parallel --test-type androidInstrumented should
// surface `android:{device_serial, device_task, flavor}` (parity with
// `kmp-test android`'s top-level android:{} block). `individual_total` was
// already tracked via WS-8 — verify it propagates too.
// ---------------------------------------------------------------------------
describe('runParallel androidInstrumented envelope parity (drift #3)', () => {
  it('surfaces top-level android:{device_serial, device_task, flavor} when leg dispatched', async () => {
    const dir = makeProject([
      { name: 'app', sourceSets: ['main', 'androidInstrumentedTest'],
        build: `plugins { id("com.android.library") }\n` },
    ]);
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--module-filter', ':app'],
      adbProbe: () => [{ serial: 'DEVICE_SERIAL_FAKE', type: 'physical', model: 'FakeDevice', state: 'device' }],
      spawn: makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 2s\n' }),
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.android).toBeDefined();
    expect(envelope.android).toHaveProperty('device_serial');
    expect(envelope.android).toHaveProperty('device_task');
    expect(envelope.android).toHaveProperty('flavor');
  });

  it('does NOT surface android:{} when no androidInstrumented leg dispatched', async () => {
    const dir = makeProject([
      { name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn: makeSpawnStub({ stdout: 'BUILD SUCCESSFUL\n' }),
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.android).toBeUndefined();
  });

  it('individual_total tracks even on common-leg path (regression — WS-8 still works)', async () => {
    const dir = makeProject([
      { name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const stubCoverage = makeRunCoverageStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn: makeSpawnStub({ stdout: 'BUILD SUCCESSFUL\n' }),
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    expect(envelope.tests).toHaveProperty('individual_total');
    expect(typeof envelope.tests.individual_total).toBe('number');
  });
});

describe('runParallel modules[] shape parity (drift #2)', () => {
  it('wet-run modules[] has same object shape as --list-only', async () => {
    const dir = makeProject([
      { name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] },
    ]);
    const stubCoverage = makeRunCoverageStub();
    const wetRun = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn: makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' }),
      log: () => {},
      runCoverageInjection: stubCoverage,
    });
    const listOnlyRun = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--list-only'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    // Both paths emit object arrays.
    expect(Array.isArray(wetRun.envelope.modules)).toBe(true);
    expect(Array.isArray(listOnlyRun.envelope.modules)).toBe(true);
    expect(typeof wetRun.envelope.modules[0]).toBe('object');
    expect(typeof listOnlyRun.envelope.modules[0]).toBe('object');
    // Same canonical key set.
    const wetKeys = Object.keys(wetRun.envelope.modules[0]).sort();
    const listKeys = Object.keys(listOnlyRun.envelope.modules[0]).sort();
    expect(wetKeys).toEqual(listKeys);
    // Required keys present.
    expect(wetKeys).toEqual([
      'android_dsl', 'android_dsl_variant', 'coverage_plugin',
      'flavors', 'has_flavor', 'name', 'test_build_type', 'type',
    ]);
  });
});

describe('runParallel legit-skip exit semantics (drift #1)', () => {
  it('exit 0 when filter matches a module but no module supports the test-type leg', async () => {
    const dir = makeProject([
      // Android-only module: no commonMain / jvmMain / jvmTest → no `common` target.
      { name: 'androidonly', sourceSets: ['androidMain', 'androidUnitTest'],
        build: `plugins { id("com.android.library") }\n` },
    ]);
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--module-filter', ':androidonly'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    expect(exitCode).toBe(0);
    expect(envelope.errors).toEqual([]);
    expect(envelope.skipped.length).toBeGreaterThan(0);
    expect(envelope.skipped[0].module).toBe('androidonly');
    expect(envelope.skipped[0].reason).toMatch(/common/);
    expect(envelope.tests).toEqual({
      total: 0, passed: 0, failed: 0, skipped: 0, individual_total: 0,
    });
  });

  // wet-audit-v0.9-part2 OBS-3 — exit-code split: user-supplied filter that
  // matches nothing is now CONFIG_ERROR (2) (usage error). Project-genuinely-
  // empty stays ENV_ERROR (3). Both still discriminated by errors[].code:
  // 'no_test_modules' + new `caused_by_filter:bool` field.
  it('regression: filter actually matches nothing → no_test_modules + CONFIG_ERROR (OBS-3)', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--module-filter', ':nonexistent'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    expect(exitCode).toBe(2); // CONFIG_ERROR — user typed a filter that matched nothing
    expect(envelope.errors[0]?.code).toBe('no_test_modules');
    expect(envelope.errors[0]?.caused_by_filter).toBe(true);
  });

  it('exit 0 with --module-filter=* when matched Android-only modules cannot serve --test-type common', async () => {
    // Two Android-only modules with their own unit-test source sets so they
    // survive the `auto-skip-untested` filter and reach executeLeg's per-leg
    // task pick (which then routes both to skipped[] for the `common` leg).
    // Pre-fix: emitted "No modules support the requested --test-type=common" + exit 3.
    // Post-fix: skipped[] explains both, errors[] empty, exit 0.
    const dir = makeProject([
      { name: 'a', sourceSets: ['androidMain', 'androidUnitTest'],
        build: `plugins { id("com.android.library") }\n` },
      { name: 'b', sourceSets: ['androidMain', 'androidUnitTest'],
        build: `plugins { id("com.android.library") }\n` },
    ]);
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    expect(exitCode).toBe(0);
    expect(envelope.errors).toEqual([]);
    expect(envelope.skipped.length).toBe(2);
  });
});

// ===========================================================================
// wet-audit-v0.9-part2 OBS-3 — `no_test_modules` exit-code split
// ===========================================================================
describe('no_test_modules exit-code split (OBS-3)', () => {
  it('user filter matches nothing → CONFIG_ERROR (2) + caused_by_filter:true', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--module-filter', 'definitely-not-here'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    expect(exitCode).toBe(2); // CONFIG_ERROR
    expect(envelope.errors[0]?.code).toBe('no_test_modules');
    expect(envelope.errors[0]?.caused_by_filter).toBe(true);
  });

  it('--exclude-modules dropping all → CONFIG_ERROR (2) + caused_by_filter:true', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--exclude-modules', '*'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    expect(exitCode).toBe(2);
    expect(envelope.errors[0]?.caused_by_filter).toBe(true);
  });

  it('project genuinely empty (no filter) → ENV_ERROR (3) + caused_by_filter:false', async () => {
    // Project has only modules with no test source sets → empty post-default-filter.
    // No --module-filter supplied; the empty result is environmental, not user error.
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain'] }]); // no *Test* set
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'], // default --module-filter '*'
      spawn: makeSpawnStub(),
      log: () => {},
    });
    expect(exitCode).toBe(3); // ENV_ERROR — project really has nothing testable
    expect(envelope.errors[0]?.code).toBe('no_test_modules');
    expect(envelope.errors[0]?.caused_by_filter).toBe(false);
  });
});

// ===========================================================================
// wet-audit-v0.9-part2 OBS-4 — `--isolated` runtime-race guard
// ===========================================================================
describe('--isolated runtime-race guard (OBS-4)', () => {
  function makeAndroidApp(name = 'app') {
    const modDir = path.join(workDir, name);
    const manifestDir = path.join(modDir, 'src', 'main');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(path.join(manifestDir, 'AndroidManifest.xml'),
      `<manifest package="com.example.${name}"/>`);
  }

  it('rejects --isolated --test-type ios with isolated_runtime_race', async () => {
    const dir = makeProject([{ name: 'shared' }]);
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'ios', '--isolated'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    expect(exitCode).toBe(2); // CONFIG_ERROR
    expect(envelope.errors[0].code).toBe('isolated_runtime_race');
    expect(envelope.errors[0].test_type).toBe('ios');
  });

  it('rejects --isolated --test-type all (expansion includes ios)', async () => {
    const dir = makeProject([{ name: 'shared' }]);
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'all', '--isolated'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    expect(exitCode).toBe(2);
    expect(envelope.errors[0].code).toBe('isolated_runtime_race');
    expect(envelope.errors[0].test_type).toBe('all');
  });

  it('rejects --isolated --test-type androidInstrumented WITHOUT --device', async () => {
    const dir = makeProject([{ name: 'app' }]);
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--isolated'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    expect(exitCode).toBe(2);
    expect(envelope.errors[0].code).toBe('isolated_runtime_race');
    expect(envelope.errors[0].test_type).toBe('androidInstrumented');
  });

  it('ALLOWS --isolated --test-type androidInstrumented WITH --device <serial>', async () => {
    // Caller asserts each concurrent process targets its own device.
    const dir = makeProject([
      { name: 'app',
        sourceSets: ['androidInstrumentedTest'],
        build: 'plugins { id("com.android.application") }\nandroid { namespace = "x" }\n' },
    ]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL\n> Task :app:connectedDebugAndroidTest\n' });
    const adbProbe = () => [{ serial: 'X', type: 'physical', model: 'Y' }];
    const { exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--isolated', '--device', 'X'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect(exitCode).not.toBe(2); // not a CONFIG_ERROR — combo accepted
  });

  it('ALLOWS --isolated --test-type jvm (no shared runtime resources)', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const { exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'jvm', '--isolated'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect(exitCode).not.toBe(2);
  });

  it('ALLOWS --isolated --test-type macos (host-native, gradle handles)', async () => {
    const dir = makeProject([{ name: 'shared' }]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    const { exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'macos', '--isolated'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    // May be 3 if no macOS modules discovered, but NOT a 2 (CONFIG_ERROR).
    expect(exitCode).not.toBe(2);
  });
});

// ===========================================================================
// v0.10 #2 — auto-respect org.gradle.parallel=false from gradle.properties
// ===========================================================================
// The CLI used to inject `--parallel` unconditionally at dispatch.js:589.
// Post-v0.10 #2: when the project has a gradle.properties file AND the
// resolved value of `org.gradle.parallel` is false, the orchestrator drops
// the `--parallel` injection. The user's `--gradle-args` is still appended
// LAST so `--gradle-args "--parallel"` overrides the drop via gradle's
// last-wins flag semantics.
//
// Envelope: optional top-level `gradle_config_applied: { parallel_dropped: true }`
// is emitted ONLY when the drop fires. Absent (no key, not null) otherwise.
describe('v0.10 #2 — respect org.gradle.parallel=false', () => {
  it('project parallel=false → dispatchLeg gradleArgs omits --parallel (keeps --continue)', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    writeFileSync(path.join(dir, 'gradle.properties'), 'org.gradle.parallel=false\n');
    const spawn = makeSpawnStub();
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const gradleCall = spawn.calls.find(isGradleCall);
    expect(gradleCall).toBeTruthy();
    const args = effectiveGradleArgs(gradleCall);
    expect(args).not.toContain('--parallel');
    expect(args).toContain('--continue');
  });

  it('project parallel=true → dispatchLeg gradleArgs contains --parallel', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    writeFileSync(path.join(dir, 'gradle.properties'), 'org.gradle.parallel=true\n');
    const spawn = makeSpawnStub();
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const gradleCall = spawn.calls.find(isGradleCall);
    expect(gradleCall).toBeTruthy();
    const args = effectiveGradleArgs(gradleCall);
    expect(args).toContain('--parallel');
    expect(args).toContain('--continue');
  });

  it('no project gradle.properties → drop is gated off, --parallel kept', async () => {
    // makeProject does NOT write a gradle.properties by default. Verify
    // sources.project=false short-circuits the drop even when the user
    // global merges to parallel=false.
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    expect(existsSync(path.join(dir, 'gradle.properties'))).toBe(false);
    const spawn = makeSpawnStub();
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const gradleCall = spawn.calls.find(isGradleCall);
    expect(gradleCall).toBeTruthy();
    const args = effectiveGradleArgs(gradleCall);
    expect(args).toContain('--parallel');
  });

  it('parallel=false + --gradle-args "--parallel" → last-wins keeps --parallel in final args', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    writeFileSync(path.join(dir, 'gradle.properties'), 'org.gradle.parallel=false\n');
    const spawn = makeSpawnStub();
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--gradle-args', '--parallel'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const gradleCall = spawn.calls.find(isGradleCall);
    expect(gradleCall).toBeTruthy();
    const args = effectiveGradleArgs(gradleCall);
    // Final args must contain --parallel (re-enabled by user) AND --continue.
    expect(args).toContain('--parallel');
    expect(args).toContain('--continue');
    // The user's --parallel must be the LAST occurrence so gradle's last-wins
    // resolves to parallel-on. Only one occurrence is expected after the drop.
    const occurrences = args.filter(a => a === '--parallel').length;
    expect(occurrences).toBe(1);
  });

  it('envelope: parallel=false → gradle_config_applied:{parallel_dropped:true} present', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    writeFileSync(path.join(dir, 'gradle.properties'), 'org.gradle.parallel=false\n');
    const spawn = makeSpawnStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect(envelope.gradle_config_applied).toEqual({ parallel_dropped: true });
  });

  it('envelope: parallel=true → gradle_config_applied key is ABSENT (not null)', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    writeFileSync(path.join(dir, 'gradle.properties'), 'org.gradle.parallel=true\n');
    const spawn = makeSpawnStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect('gradle_config_applied' in envelope).toBe(false);
  });

  it('envelope: --dry-run with parallel=false → gradle_config_applied present (covers dry-run branch)', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    writeFileSync(path.join(dir, 'gradle.properties'), 'org.gradle.parallel=false\n');
    const spawn = makeSpawnStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--dry-run'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect(envelope.dry_run).toBe(true);
    expect(envelope.gradle_config_applied).toEqual({ parallel_dropped: true });
  });

  it('envelope: --list-only with parallel=false → gradle_config_applied present (covers list-only branch)', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    writeFileSync(path.join(dir, 'gradle.properties'), 'org.gradle.parallel=false\n');
    const spawn = makeSpawnStub();
    const { envelope } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--list-only'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect(envelope.gradle_config_applied).toEqual({ parallel_dropped: true });
  });
});

// ===========================================================================
// Bug 1 — probe-backed coverage classification in the parallel envelope
// ===========================================================================
describe('canonicalModuleEntry — probe-backed coverage_plugin (Bug 1)', () => {
  it('uses precomputed effectiveCoveragePlugin when present', () => {
    const mod = { name: 'core-foo', type: 'jvm', coveragePlugin: null, effectiveCoveragePlugin: 'jacoco' };
    expect(canonicalModuleEntry(mod).coverage_plugin).toBe('jacoco');
  });
  it('falls back to raw coveragePlugin for bare stubs (no precompute)', () => {
    expect(canonicalModuleEntry({ name: 'a', type: 'jvm', coveragePlugin: 'kover' }).coverage_plugin).toBe('kover');
    expect(canonicalModuleEntry({ name: 'a', type: 'jvm' }).coverage_plugin).toBeNull();
  });
});

// ===========================================================================
// Fix 2 — coverage report task dispatch
// ===========================================================================
describe('buildCoverageReportTasks (Fix 2)', () => {
  const mods = [
    { name: 'core-foo', resolved: { coverageTask: 'jacocoTestReport' } },
    { name: 'core-bar', resolved: { coverageTask: 'koverXmlReportDebug' } },
    { name: 'app',      resolved: { coverageTask: null } },
    { name: 'util',     resolved: null },
  ];
  it('auto: one :module:reportTask per module that resolved a coverage task', () => {
    expect(buildCoverageReportTasks(mods, parseArgs([]))).toEqual([
      ':core-foo:jacocoTestReport', ':core-bar:koverXmlReportDebug',
    ]);
  });
  it('explicit --coverage-tool jacoco: only jacoco report tasks', () => {
    expect(buildCoverageReportTasks(mods, parseArgs(['--coverage-tool', 'jacoco'])))
      .toEqual([':core-foo:jacocoTestReport']);
  });
  it('explicit --coverage-tool kover: only kover report tasks', () => {
    expect(buildCoverageReportTasks(mods, parseArgs(['--coverage-tool', 'kover'])))
      .toEqual([':core-bar:koverXmlReportDebug']);
  });
  it('--coverage-tool none: empty (caller also gates, but be defensive)', () => {
    expect(buildCoverageReportTasks(mods, parseArgs(['--no-coverage']))).toEqual([]);
  });
  it('--exclude-coverage drops a module from the dispatch list', () => {
    expect(buildCoverageReportTasks(mods, parseArgs(['--exclude-coverage', 'core-foo'])))
      .toEqual([':core-bar:koverXmlReportDebug']);
  });
  it('--coverage-modules limits the dispatch list', () => {
    expect(buildCoverageReportTasks(mods, parseArgs(['--coverage-modules', 'core-foo'])))
      .toEqual([':core-foo:jacocoTestReport']);
  });

  // Finding #2 — flavored coverage: a convention-flavor jacoco module exposes
  // per-variant AGP report tasks (create${Variant}UnitTestCoverageReport), not a
  // plain jacocoTestReport. The chosen flavor (or the first-flavor default)
  // selects the Debug report; coverage is debug-only under enableUnitTestCoverage.
  describe('flavored coverage report tasks (Finding #2)', () => {
    const flavoredCov = {
      name: 'app',
      effectiveHasFlavor: true,
      flavors: ['demo', 'prod'],
      resolved: {
        coverageTask: null,
        flavors: ['demo', 'prod'],
        coverageReportTasks: ['createDemoDebugUnitTestCoverageReport', 'createProdDebugUnitTestCoverageReport'],
      },
    };
    it('--flavor demo → the demoDebug coverage report', () => {
      expect(buildCoverageReportTasks([flavoredCov], parseArgs(['--flavor', 'demo'])))
        .toEqual([':app:createDemoDebugUnitTestCoverageReport']);
    });
    it('--flavor prod → the prodDebug coverage report', () => {
      expect(buildCoverageReportTasks([flavoredCov], parseArgs(['--flavor', 'prod'])))
        .toEqual([':app:createProdDebugUnitTestCoverageReport']);
    });
    it('no --flavor → alphabetically-first flavor (demo) Debug report (deterministic representative)', () => {
      expect(buildCoverageReportTasks([flavoredCov], parseArgs([])))
        .toEqual([':app:createDemoDebugUnitTestCoverageReport']);
    });
    it('classified as jacoco → kept under --coverage-tool jacoco, dropped under kover', () => {
      expect(buildCoverageReportTasks([flavoredCov], parseArgs(['--coverage-tool', 'jacoco'])))
        .toEqual([':app:createDemoDebugUnitTestCoverageReport']);
      expect(buildCoverageReportTasks([flavoredCov], parseArgs(['--coverage-tool', 'kover'])))
        .toEqual([]);
    });
  });
});

describe('runParallel — coverage report dispatch (Fix 2)', () => {
  // A jvm module that applies jacoco in its OWN build file → analyzeModule sets
  // coveragePlugin:'jacoco' → predictCoverageTask fills resolved.coverageTask
  // even though the exit-0 fake gradlew makes the probe return null.
  const jacocoModule = {
    name: 'core',
    build: 'plugins { kotlin("jvm") }\njacoco {}\n',
    sourceSets: ['commonMain', 'jvmMain', 'jvmTest'],
  };

  it('dispatches :module:jacocoTestReport in a SEPARATE leg after the test task', async () => {
    const dir = makeProject([jacocoModule]);
    const spawn = makeSpawnStub({ stdout: 'BUILD SUCCESSFUL in 1s\n' });
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'desktop', '--coverage-tool', 'jacoco'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const gradleArgLists = spawn.calls.filter(isGradleCall).map(effectiveGradleArgs);
    const testLeg = gradleArgLists.find(a => a.includes(':core:jvmTest'));
    const reportLeg = gradleArgLists.find(a => a.includes(':core:jacocoTestReport'));
    expect(testLeg).toBeTruthy();
    expect(reportLeg).toBeTruthy();
    // Report task must NOT be bundled into the classified test leg.
    expect(testLeg).not.toContain(':core:jacocoTestReport');
  });

  it('--coverage-tool none dispatches NO coverage report task', async () => {
    const dir = makeProject([jacocoModule]);
    const spawn = makeSpawnStub();
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'desktop', '--no-coverage'],
      spawn,
      log: () => {},
    });
    const gradleArgLists = spawn.calls.filter(isGradleCall).map(effectiveGradleArgs);
    expect(gradleArgLists.some(a => a.includes(':core:jacocoTestReport'))).toBe(false);
  });

  it('report-task failure → non-fatal coverage_report_dispatch_failed warning, exit unchanged', async () => {
    const dir = makeProject([jacocoModule]);
    // Custom spawn: fail ONLY the report task; the test task passes.
    const spawn = (cmd, args, opts) => {
      spawn.calls.push({ cmd, args: [...args], cwd: opts?.cwd ?? null, env: opts?.env ?? null });
      const flat = args.join(' ');
      if (/jacocoTestReport/.test(flat)) {
        return { status: 1, stdout: '> Task :core:jacocoTestReport FAILED\nBUILD FAILED in 1s\n', stderr: '', signal: null, error: null };
      }
      return { status: 0, stdout: 'BUILD SUCCESSFUL in 1s\n', stderr: '', signal: null, error: null };
    };
    spawn.calls = [];
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'desktop', '--coverage-tool', 'jacoco'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    expect(envelope.warnings.some(w => w.code === 'coverage_report_dispatch_failed')).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('a non-unit leg (js) does NOT dispatch unit-side coverage reports', async () => {
    // jacocoTestReport / koverXmlReport* aggregate the UNIT test task; a js-only
    // run never produced that data, so the report dispatch must be gated off.
    const dir = makeProject([jacocoModule]); // jvm module, no js target
    const spawn = makeSpawnStub();
    await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'js', '--coverage-tool', 'jacoco'],
      spawn,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });
    const gradleArgLists = spawn.calls.filter(isGradleCall).map(effectiveGradleArgs);
    expect(gradleArgLists.some(a => a.includes(':core:jacocoTestReport'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part A — pickGradleTaskFor JS/Wasm guard for explicit common/desktop
// ---------------------------------------------------------------------------
describe('pickGradleTaskFor — JS/Wasm guard for common/desktop (Part A)', () => {
  const jsOnlyModule = {
    name: 'js-lib',
    type: 'kmp',
    androidDsl: false,
    resolved: {
      unitTestTask: 'jsTest',
      deviceTestTask: null,
      iosTestTask: null,
      macosTestTask: null,
      webTestTask: 'jsTest',
    },
  };
  const wasmOnlyModule = {
    name: 'wasm-lib',
    type: 'kmp',
    androidDsl: false,
    resolved: {
      unitTestTask: 'wasmJsTest',
      deviceTestTask: null,
      iosTestTask: null,
      macosTestTask: null,
      webTestTask: 'wasmJsBrowserTest',
    },
  };
  const jvmModule = {
    name: 'shared',
    type: 'kmp',
    androidDsl: false,
    resolved: {
      unitTestTask: 'jvmTest',
      deviceTestTask: null,
      iosTestTask: null,
      macosTestTask: null,
      webTestTask: null,
    },
  };

  it('--test-type common with unitTestTask=jsTest → null + reason (guard)', () => {
    const r = pickGradleTaskFor(jsOnlyModule, 'common');
    expect(r.task).toBeNull();
    expect(r.reason).toMatch(/no common target/);
  });

  it('--test-type desktop with unitTestTask=wasmJsTest → null + reason (guard)', () => {
    const r = pickGradleTaskFor(wasmOnlyModule, 'desktop');
    expect(r.task).toBeNull();
    expect(r.reason).toMatch(/no desktop target/);
  });

  it('non-regression: auto-detect "" with unitTestTask=jsTest → dispatches jsTest', () => {
    const r = pickGradleTaskFor(jsOnlyModule, '');
    expect(r.task).toBe(':js-lib:jsTest');
  });

  it('non-regression: --test-type js with webTestTask → dispatches webTestTask', () => {
    const r = pickGradleTaskFor(jsOnlyModule, 'js');
    expect(r.task).toBe(':js-lib:jsTest');
  });

  it('non-regression: --test-type wasmJs with webTestTask → dispatches webTestTask', () => {
    const r = pickGradleTaskFor(wasmOnlyModule, 'wasmJs');
    expect(r.task).toBe(':wasm-lib:wasmJsBrowserTest');
  });

  it('non-regression: --test-type common with unitTestTask=jvmTest → dispatches jvmTest', () => {
    const r = pickGradleTaskFor(jvmModule, 'common');
    expect(r.task).toBe(':shared:jvmTest');
  });
});

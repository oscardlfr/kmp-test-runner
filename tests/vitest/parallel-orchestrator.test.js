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
function makeRunCoverageStub({ coverage = null, errors = null, exitCode = 0 } = {}) {
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
      '--device', 'R3CT30KAMEH',
      '--device-task', 'androidConnectedCheck',
      '--auto-retry',
      '--clear-data',
      '--flavor', 'staging',
    ]);
    expect(opts.device).toBe('R3CT30KAMEH');
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
    expect(expandNoCoverageAlias(['--module-filter=core-result']))
      .toEqual(['--module-filter', 'core-result']);
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
    const opts = parseArgs(['--module-filter=core-result']);
    expect(opts.moduleFilter).toBe('core-result');
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
  // mod.testBuildType to fix dipatternsdemo :benchmark (testBuildType =
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
  // dipatternsdemo `:benchmark` post commit 058a520
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
      // The exact dipatternsdemo `:benchmark` regression case: probe-populated
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
  // shared-kmp-libs (+66 false positives), DawSync, dipatternsdemo, FileKit-main.
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
        name: 'core-firebase-native', type: 'kmp', androidDsl: 'androidLibrary',
        androidDslVariant: 'kmpAndroidLibrary',
        sourceSets: { androidUnitTest: true, commonTest: true },
        resolved: { unitTestTask: null },
      };
      const r = pickGradleTaskFor(mod, 'androidUnit');
      expect(r.task).toBe(':core-firebase-native:testAndroidHostTest');
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
        name: 'core-firebase-native', type: 'kmp', androidDsl: 'androidLibrary',
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
        name: 'core-firebase-native', type: 'kmp', androidDsl: 'androidLibrary',
        androidDslVariant: 'kmpAndroidLibrary',
        sourceSets: { androidUnitTest: true },
        resolved: { unitTestTask: null },
      };
      // Pass --variant=release: legacy path would emit testReleaseUnitTest;
      // new plugin path emits testAndroidHostTest regardless of the flag.
      const r = pickGradleTaskFor(mod, 'androidUnit', { androidVariant: 'release' });
      expect(r.task).toBe(':core-firebase-native:testAndroidHostTest');
    });

    it('androidInstrumented: kmpAndroidLibrary with androidDeviceTest opt-in → dispatches androidConnectedCheck', () => {
      const mod = {
        name: 'benchmark-network', type: 'kmp', androidDsl: 'androidLibrary',
        androidDslVariant: 'kmpAndroidLibrary',
        sourceSets: { androidDeviceTest: true, commonTest: true },
        resolved: { deviceTestTask: null },
      };
      const r = pickGradleTaskFor(mod, 'androidInstrumented');
      expect(r.task).toBe(':benchmark-network:androidConnectedCheck');
      expect(r.reason).toBe('');
    });

    it('androidInstrumented: kmpAndroidLibrary without opt-in → null with withDeviceTestBuilder reason', () => {
      const mod = {
        name: 'core-firebase-native', type: 'kmp', androidDsl: 'androidLibrary',
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

  // 2026-05-03 — instrumented-only Android module skip (dipatternsdemo
  // :benchmark repro). No `test/`, `androidUnitTest/`, or `commonTest/`
  // source set → orchestrator skips with reason instead of dispatching a
  // hardcoded task name that gradle doesn't have.
  describe('instrumented-only Android module skip', () => {
    it('Android module with only androidTest/ source set → skipped with reason', () => {
      const benchmarkModule = {
        name: 'benchmark',
        type: 'android',
        androidDsl: true,
        sourceSets: { test: false, androidUnitTest: false, commonTest: false, androidTest: true },
        resolved: null,
      };
      const result = pickGradleTaskFor(benchmarkModule, '');
      expect(result.task).toBeNull();
      expect(result.reason).toMatch(/no androidUnit source set/);
    });

    it('Android module with test/ source set → dispatches normally', () => {
      const result = pickGradleTaskFor(androidModule, '');
      expect(result.task).toBe(':app:testDebugUnitTest');
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
  // green incremental builds. Reproduced live on dipatternsdemo:
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
// Repro envelopes: shared-kmp-libs Mac `macos` leg + Win `androidInstrumented`
// leg + dipatternsdemo `androidInstrumented` leg (.smoke/pass-9/).
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
  // retry_fired=true (the dipatternsdemo Win-side bug shape — wasted gradle
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
// filtering (live repro on dipatternsdemo: 14 of 14 DiBenchmark methods
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
// + the live dipatternsdemo run.
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
      { serial: 'R3CT30KAMEH', type: 'physical', model: 'SM-S908B' },
      { serial: 'emulator-5554', type: 'emulator', model: 'sdk' },
    ];

    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'androidInstrumented', '--device', 'R3CT30KAMEH'],
      spawn,
      adbProbe,
      log: () => {},
      runCoverageInjection: makeRunCoverageStub(),
    });

    expect(exitCode).toBe(0);
    // Envelope surfaces resolved device on the androidInstrumented leg.
    const leg = envelope.parallel.legs.find(l => l.test_type === 'androidInstrumented');
    expect(leg).toBeDefined();
    expect(leg.device).toEqual({ serial: 'R3CT30KAMEH' });

    // Gradle spawn env got ANDROID_SERIAL.
    const gradleCalls = spawn.calls.filter(c => isGradleCall(c) && !isStopCall(c));
    expect(gradleCalls.length).toBeGreaterThanOrEqual(1);
    expect(gradleCalls[0].env.ANDROID_SERIAL).toBe('R3CT30KAMEH');
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
      args: ['--test-type', 'common', '--device', 'R3CT30KAMEH'],
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
    makeAndroidApp('app');
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
// but wet runs emitted `["core-result"]` (bare strings). Agents reading the
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
      // Stub adb to return the S22-style serial so resolvedDeviceSerial populates.
      env: { KMP_TEST_FAKE_DEVICES: 'R3CT30KAMEH' },
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
      'has_flavor', 'name', 'test_build_type', 'type',
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

  it('regression: filter actually matches nothing still surfaces no_test_modules + exit 3', async () => {
    const dir = makeProject([{ name: 'core', sourceSets: ['commonMain', 'jvmMain', 'jvmTest'] }]);
    const { envelope, exitCode } = await runParallel({
      projectRoot: dir,
      args: ['--test-type', 'common', '--module-filter', ':nonexistent'],
      spawn: makeSpawnStub(),
      log: () => {},
    });
    expect(exitCode).toBe(3);
    expect(envelope.errors[0]?.code).toBe('no_test_modules');
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

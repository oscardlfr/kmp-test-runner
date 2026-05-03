// Tests for lib/benchmark-orchestrator.js — v0.8 STRATEGIC PIVOT, sub-entry 1.
//
// The orchestrator owns module discovery, per-module gradle dispatch, adb
// probing, and envelope construction for `kmp-test benchmark`. Bash + ps1
// wrappers shrink to ≤50-LOC node-launchers (PRODUCT.md "logic in Node,
// plumbing in shell").
//
// Test surface (acceptance rubric: BACKLOG.md Sub-entry 1):
//   1. --platform jvm dispatches :module:desktopSmokeBenchmark per JVM module
//   2. --platform android adb resolution + instrumented_setup_failed on no device
//   3. Zero benchmark modules → errors[].code:"no_test_modules" (NOT no_summary)
//   4. Empty result sets do not throw (locks WS-2 + Bash-3.2 bug class into JS)
//   5. --test-filter resolution: jvm pass-through; android FQN + # split

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBenchmark } from '../../lib/benchmark-orchestrator.js';
import { isGradleCall, effectiveGradleArgs } from './_spawn-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.join(__dirname, '..', 'fixtures', 'kmp-with-benchmark');

let workDir;

function copyFixture() {
  workDir = mkdtempSync(path.join(tmpdir(), 'kmp-bench-test-'));
  cpSync(FIXTURE_SRC, workDir, { recursive: true });
  // Stub gradlew so the orchestrator doesn't reject the project. The wrappers
  // are never executed — spawn is injected.
  writeFileSync(path.join(workDir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(path.join(workDir, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
  return workDir;
}

function makeEmptyProject() {
  workDir = mkdtempSync(path.join(tmpdir(), 'kmp-bench-empty-'));
  writeFileSync(path.join(workDir, 'settings.gradle.kts'),
    'rootProject.name = "empty"\ninclude(":no-bench")\n');
  mkdirSync(path.join(workDir, 'no-bench'), { recursive: true });
  writeFileSync(path.join(workDir, 'no-bench', 'build.gradle.kts'),
    'plugins { kotlin("jvm") }\n');
  writeFileSync(path.join(workDir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(path.join(workDir, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
  return workDir;
}

afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

// Build a fake spawn that records every invocation and returns configurable status.
// Returned object exposes `calls` for assertions and `setStatus(code)` to control
// per-call exit codes (default 0 = pass).
function makeSpawnStub({ defaultStatus = 0, perCall = [] } = {}) {
  const calls = [];
  let i = 0;
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], cwd: opts?.cwd ?? null });
    const status = perCall[i] !== undefined ? perCall[i] : defaultStatus;
    i++;
    return {
      status,
      stdout: status === 0 ? 'BUILD SUCCESSFUL\n' : 'BUILD FAILED\n',
      stderr: '',
      signal: null,
      error: null,
    };
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// Case 1 — `--platform jvm` task dispatch
// ---------------------------------------------------------------------------
describe('runBenchmark --platform jvm', () => {
  it('dispatches :bench-jvm:desktopSmokeBenchmark, skips bench-android, ignores no-bench', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--config', 'smoke'],
      spawn,
      adbProbe: () => [],
    });

    // Only the JVM module should have been dispatched.
    expect(spawn.calls.length).toBe(1);
    expect(isGradleCall(spawn.calls[0])).toBe(true);
    expect(effectiveGradleArgs(spawn.calls[0])).toContain(':bench-jvm:desktopSmokeBenchmark');
    expect(spawn.calls[0].cwd).toBe(dir);

    expect(envelope.tests.passed).toBe(1);
    expect(envelope.tests.failed).toBe(0);
    expect(envelope.modules).toContain('bench-jvm');
    expect(envelope.benchmark.platforms).toEqual(['jvm']);
    expect(envelope.benchmark.config).toBe('smoke');
    expect(envelope.errors).toEqual([]);
    expect(exitCode).toBe(0);

    // bench-android is skipped because --platform jvm intersects empty.
    const skipModules = envelope.skipped.map(s => s.module);
    expect(skipModules).toContain('bench-android');

    // no-bench has no benchmark plugin → must NOT appear in modules OR skipped[].
    // Locks the discovery contract: the orchestrator never even considers
    // modules that don't declare a benchmark plugin marker.
    expect(envelope.modules).not.toContain('no-bench');
    expect(skipModules).not.toContain('no-bench');
  });

  it('--config stress maps to :module:desktopStressBenchmark', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();
    await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--config', 'stress'],
      spawn,
      adbProbe: () => [],
    });
    expect(effectiveGradleArgs(spawn.calls[0])).toContain(':bench-jvm:desktopStressBenchmark');
  });

  it('--config main maps to :module:desktopBenchmark (no suffix)', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();
    await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--config', 'main'],
      spawn,
      adbProbe: () => [],
    });
    expect(effectiveGradleArgs(spawn.calls[0])).toContain(':bench-jvm:desktopBenchmark');
  });
});

// ---------------------------------------------------------------------------
// Case 2 — `--platform android` adb resolution
// ---------------------------------------------------------------------------
describe('runBenchmark --platform android', () => {
  it('with adb device, dispatches :bench-android:connectedAndroidTest', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'R3CT30KAMEH', type: 'physical', model: 'SM-S908B' }];

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'android'],
      spawn,
      adbProbe,
    });

    expect(spawn.calls.length).toBe(1);
    expect(effectiveGradleArgs(spawn.calls[0])).toContain(':bench-android:connectedAndroidTest');
    expect(envelope.benchmark.platforms).toEqual(['android']);
    expect(envelope.errors).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it('without adb device → errors[].code:"instrumented_setup_failed", exit 3', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'android'],
      spawn,
      adbProbe: () => [],
    });

    expect(spawn.calls.length).toBe(0); // never dispatched
    expect(envelope.errors[0].code).toBe('instrumented_setup_failed');
    expect(exitCode).toBe(3);
  });

  it('KMP_TEST_SKIP_ADB=1 bypasses probe (no error, no dispatch)', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'android'],
      spawn,
      adbProbe: () => { throw new Error('probe must not be called when KMP_TEST_SKIP_ADB=1'); },
      env: { KMP_TEST_SKIP_ADB: '1' },
    });

    expect(spawn.calls.length).toBe(0);
    expect(envelope.errors).toEqual([]);
    // All android-leg modules go to skipped[] with reason mentioning the env override.
    expect(envelope.skipped.some(s => /skip.*adb/i.test(s.reason))).toBe(true);
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — Zero benchmark modules → no_test_modules
// ---------------------------------------------------------------------------
describe('runBenchmark module discovery', () => {
  it('zero benchmark modules → errors[].code:"no_test_modules" (NOT no_summary)', async () => {
    const dir = makeEmptyProject();
    const spawn = makeSpawnStub();

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'all'],
      spawn,
      adbProbe: () => [],
    });

    expect(spawn.calls.length).toBe(0);
    expect(envelope.errors[0].code).toBe('no_test_modules');
    // Locks v0.6.2 Gap 1.1 contract — no_test_modules preempts no_summary fallback.
    expect(envelope.errors.find(e => e.code === 'no_summary')).toBeUndefined();
    expect(exitCode).toBe(3);
  });

  it('build.gradle.kts with comment "no benchmark plugin" is NOT discovered (comment-strip)', async () => {
    // Regression for the comment-strip bug: regex /benchmark[\\s\\S]{0,40}plugin/
    // would match a comment like `// no benchmark plugin — explanation` and
    // falsely register the module as a benchmark candidate, leading to phantom
    // gradle dispatch. stripKotlinComments must run BEFORE moduleHasBenchmarkPlugin.
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-bench-comment-'));
    workDir = dir;
    writeFileSync(path.join(dir, 'settings.gradle.kts'),
      'rootProject.name = "x"\ninclude(":no-bench")\n');
    mkdirSync(path.join(dir, 'no-bench'), { recursive: true });
    writeFileSync(path.join(dir, 'no-bench', 'build.gradle.kts'),
      '// no benchmark plugin — orchestrator should emit no_test_modules\n' +
      'plugins { id("base") }\n');
    writeFileSync(path.join(dir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');

    const spawn = makeSpawnStub();
    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'all'],
      spawn,
      adbProbe: () => [],
    });

    expect(spawn.calls.length).toBe(0);
    expect(envelope.errors[0].code).toBe('no_test_modules');
    expect(envelope.modules).toEqual([]);
    expect(envelope.skipped).toEqual([]);
    expect(exitCode).toBe(3);
  });

  it('--module-filter "no-match-pattern" → no_test_modules', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--module-filter', 'nonexistent'],
      spawn,
      adbProbe: () => [],
    });

    expect(spawn.calls.length).toBe(0);
    expect(envelope.errors[0].code).toBe('no_test_modules');
    expect(exitCode).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — Empty result sets do not throw (regression for WS-2 bug class)
// ---------------------------------------------------------------------------
describe('runBenchmark empty-result regression', () => {
  it('--platform android against jvm-only-fixture does not throw and exits 3', async () => {
    // Fixture with one jvm module + no android modules: --platform android
    // selects 0 dispatches, all skipped. Pre-migration, bash had landmines
    // here under Bash 3.2 + set -u; the JS path can't have the bug class.
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-bench-jvm-only-'));
    workDir = dir;
    writeFileSync(path.join(dir, 'settings.gradle.kts'),
      'rootProject.name = "jvmonly"\ninclude(":mod-a")\n');
    mkdirSync(path.join(dir, 'mod-a'), { recursive: true });
    writeFileSync(path.join(dir, 'mod-a', 'build.gradle.kts'),
      'plugins { id("org.jetbrains.kotlinx.benchmark") }\n');
    writeFileSync(path.join(dir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');

    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'X', type: 'physical', model: 'Y' }];

    // The orchestrator must not throw on empty result sets — JS arrays don't
    // have the bash empty-array landmine class, so this is structurally
    // guaranteed. We still execute the path to lock the contract.
    const result = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'android'],
      spawn,
      adbProbe,
    });
    const { envelope, exitCode } = result;

    expect(spawn.calls.length).toBe(0);
    expect(envelope.tests.passed).toBe(0);
    expect(envelope.tests.failed).toBe(0);
    // mod-a is skipped because jvm-only doesn't support android leg.
    expect(envelope.skipped.some(s => s.module === 'mod-a')).toBe(true);
    // No platform actually ran → exit_code:3 with discriminated error.
    expect(exitCode).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Case 5 — `--test-filter` resolution
// ---------------------------------------------------------------------------
describe('runBenchmark --test-filter', () => {
  it('jvm: passes through to gradle --tests verbatim (gradle handles globs)', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();

    await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--test-filter', '*ScaleBenchmark*'],
      spawn,
      adbProbe: () => [],
    });

    const args = effectiveGradleArgs(spawn.calls[0]);
    expect(args).toContain('--tests');
    expect(args).toContain('*ScaleBenchmark*');
  });

  it('android: emits -Pandroid.testInstrumentationRunnerArguments.class= with FQN', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();

    await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'android', '--test-filter', 'com.example.ScaleBenchmark'],
      spawn,
      adbProbe: () => [{ serial: 'X', type: 'physical', model: 'Y' }],
    });

    const argsStr = effectiveGradleArgs(spawn.calls[0]).join(' ');
    expect(argsStr).toContain(
      '-Pandroid.testInstrumentationRunnerArguments.class=com.example.ScaleBenchmark'
    );
  });

  it('android: # split → emits BOTH .class= AND .method= props', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();

    await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'android', '--test-filter', 'com.example.Bench#testFoo'],
      spawn,
      adbProbe: () => [{ serial: 'X', type: 'physical', model: 'Y' }],
    });

    const argsStr = effectiveGradleArgs(spawn.calls[0]).join(' ');
    expect(argsStr).toContain(
      '-Pandroid.testInstrumentationRunnerArguments.class=com.example.Bench'
    );
    expect(argsStr).toContain(
      '-Pandroid.testInstrumentationRunnerArguments.method=testFoo'
    );
  });
});

// ---------------------------------------------------------------------------
// Banner emission (humans grep these — preserved-by-contract per BACKLOG)
// ---------------------------------------------------------------------------
describe('runBenchmark banner emission', () => {
  it('emits [OK] / [FAIL] / [SKIP] banners with platform-suffix shape', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub({ defaultStatus: 0 });
    const banners = [];

    await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm'],
      spawn,
      adbProbe: () => [],
      log: (line) => banners.push(line),
    });

    // [OK] bench-jvm (jvm) completed successfully.
    expect(banners.some(b => /\[OK\]\s+bench-jvm\s+\(jvm\)\s+completed/.test(b))).toBe(true);
    // [SKIP] bench-android (jvm) — module does not declare jvm benchmark capability
    expect(banners.some(b => /\[SKIP\]\s+bench-android\s+\(jvm\)/.test(b))).toBe(true);
    // Result: 1 passed, 0 failed
    expect(banners.some(b => /Result:\s+1 passed,\s+0 failed/.test(b))).toBe(true);
  });

  it('emits [FAIL] banner when gradle exits non-zero', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub({ defaultStatus: 1 });
    const banners = [];

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm'],
      spawn,
      adbProbe: () => [],
      log: (line) => banners.push(line),
    });

    expect(banners.some(b => /\[FAIL\]\s+bench-jvm\s+\(jvm\)\s+failed/.test(b))).toBe(true);
    expect(envelope.tests.failed).toBe(1);
    expect(envelope.errors.some(e => e.code === 'module_failed')).toBe(true);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// KMP DSL detection — kotlinx.benchmark on a module with an Android target
// must surface BOTH jvm and android legs (the v0.8 sub-entry 1 fix beyond
// bash parity). Today the legacy bash regex only registered jvm for these,
// missing connectedAndroidTest dispatch on KMP+android-library benchmark modules.
// ---------------------------------------------------------------------------
describe('runBenchmark KMP-with-android-target detection', () => {
  it('kotlinx.benchmark + androidLibrary { } → both jvm AND android legs', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-bench-kmp-android-'));
    workDir = dir;
    writeFileSync(path.join(dir, 'settings.gradle.kts'),
      'rootProject.name = "kmpbench"\ninclude(":bench-mod")\n');
    mkdirSync(path.join(dir, 'bench-mod'), { recursive: true });
    writeFileSync(path.join(dir, 'bench-mod', 'build.gradle.kts'),
      'plugins { id("org.jetbrains.kotlinx.benchmark") }\n' +
      'kotlin { androidLibrary { namespace = "x"; compileSdk = 34 } }\n');
    writeFileSync(path.join(dir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');

    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'X', type: 'physical', model: 'Y' }];

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'all'],
      spawn,
      adbProbe,
    });

    // Both legs dispatched; no skip for the android leg.
    expect(spawn.calls.length).toBe(2);
    const tasks = spawn.calls.map(c => effectiveGradleArgs(c)[0]);
    expect(tasks).toContain(':bench-mod:desktopSmokeBenchmark');
    expect(tasks).toContain(':bench-mod:connectedAndroidTest');
    expect(envelope.benchmark.platforms.sort()).toEqual(['android', 'jvm']);
    expect(envelope.tests.passed).toBe(2);
    expect(exitCode).toBe(0);
  });

  it('kotlinx.benchmark + id("com.android.library") → both legs', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-bench-agp-'));
    workDir = dir;
    writeFileSync(path.join(dir, 'settings.gradle.kts'),
      'rootProject.name = "agpbench"\ninclude(":bench-mod")\n');
    mkdirSync(path.join(dir, 'bench-mod'), { recursive: true });
    writeFileSync(path.join(dir, 'bench-mod', 'build.gradle.kts'),
      'plugins {\n  id("com.android.library")\n  id("org.jetbrains.kotlinx.benchmark")\n}\n');
    writeFileSync(path.join(dir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');

    const spawn = makeSpawnStub();
    const { envelope } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'android'],
      spawn,
      adbProbe: () => [{ serial: 'X', type: 'physical', model: 'Y' }],
    });

    expect(spawn.calls.length).toBe(1);
    expect(effectiveGradleArgs(spawn.calls[0])).toContain(':bench-mod:connectedAndroidTest');
    expect(envelope.benchmark.platforms).toEqual(['android']);
  });
});

// ---------------------------------------------------------------------------
// Envelope shape — non-breaking schema additions
// ---------------------------------------------------------------------------
describe('runBenchmark envelope shape', () => {
  it('returns canonical envelope with tool, subcommand, version, exit_code, etc.', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();

    const { envelope } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm'],
      spawn,
      adbProbe: () => [],
    });

    expect(envelope.tool).toBe('kmp-test');
    expect(envelope.subcommand).toBe('benchmark');
    expect(envelope.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(envelope.project_root).toBe(dir);
    expect(envelope).toHaveProperty('exit_code');
    expect(envelope).toHaveProperty('duration_ms');
    expect(envelope).toHaveProperty('tests');
    expect(envelope).toHaveProperty('modules');
    expect(envelope).toHaveProperty('skipped');
    expect(envelope).toHaveProperty('coverage');
    expect(envelope).toHaveProperty('errors');
    expect(envelope).toHaveProperty('warnings');
    expect(envelope).toHaveProperty('benchmark');
    expect(envelope.benchmark).toHaveProperty('config');
    expect(envelope.benchmark).toHaveProperty('platforms');
    expect(envelope.benchmark).toHaveProperty('total');
    expect(envelope.benchmark).toHaveProperty('passed');
    expect(envelope.benchmark).toHaveProperty('failed');
  });
});

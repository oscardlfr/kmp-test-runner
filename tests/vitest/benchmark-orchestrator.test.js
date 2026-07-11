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
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBenchmark, resolveBenchmarkTimeoutMs, BENCHMARK_TIMEOUT_DEFAULTS_MS, parseArgs } from '../../lib/orchestrators/benchmark-orchestrator.js';
import { resolveBenchmarkOuterTimeoutMs, BENCHMARK_OUTER_TIMEOUTS_MS } from '../../lib/cli.js';
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
    const adbProbe = () => [{ serial: 'DEVICE_SERIAL_FAKE', type: 'physical', model: 'SM-S908B' }];

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
  // Premise rewrite (L7, 2026-06-10): this test previously asserted the jvm
  // leg passes `--tests` through to gradle — wet-DISPROVEN on a reference
  // composite: kotlinx-benchmark BenchmarkExec tasks reject `--tests`
  // ("Unknown command-line option '--tests'" → module_failed). The jvm leg
  // now SKIPS filtered cells (never runs the un-narrowed suite, never emits
  // a flag gradle rejects).
  it('jvm: --test-filter skips the leg with skipped[] + test_filter_unsupported warning, no gradle spawn', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--test-filter', '*ScaleBenchmark*'],
      spawn,
      adbProbe: () => [],
    });

    // No gradle dispatched for the filtered jvm leg.
    expect(spawn.calls.length).toBe(0);
    const skips = envelope.skipped.filter(s =>
      s.reason.includes('--test-filter not supported by kotlinx-benchmark'));
    expect(skips.length).toBeGreaterThan(0);
    const w = envelope.warnings.filter(x => x.code === 'test_filter_unsupported');
    expect(w).toHaveLength(1);
    expect(w[0].platform).toBe('jvm');
    expect(w[0].test_filter).toBe('*ScaleBenchmark*');
    expect(w[0].skipped_modules).toBe(skips.length);
    expect(w[0].message).toContain('benchmark { configurations { include(...) } }');
    // Capable modules exist but every cell was an intentional skip → the
    // aggregate path treats it like the KMP_TEST_SKIP_ADB opt-out: exit 0.
    expect(exitCode).toBe(0);
  });

  it('jvm: warning is pushed ONCE even when multiple jvm modules skip', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();

    const { envelope } = await runBenchmark({
      projectRoot: dir,
      args: ['--test-filter', 'X'],  // default platform → jvm cells skip, android cells follow adb
      spawn,
      adbProbe: () => [],
    });

    expect(envelope.warnings.filter(x => x.code === 'test_filter_unsupported')).toHaveLength(1);
  });

  it('jvm: no filter → leg still dispatches (skip is filter-gated only)', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();

    const { envelope } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm'],
      spawn,
      adbProbe: () => [],
    });

    expect(spawn.calls.length).toBeGreaterThan(0);
    expect(envelope.warnings.filter(x => x.code === 'test_filter_unsupported')).toHaveLength(0);
    // And the dispatched args never contain --tests in any shape.
    const allArgs = spawn.calls.flatMap(c => c.args).join(' ');
    expect(allArgs).not.toContain('--tests');
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

  it('android: # split → emits combined .class=FQN#method (v0.9 step 1, flag #6)', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();

    await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'android', '--test-filter', 'com.example.Bench#testFoo'],
      spawn,
      adbProbe: () => [{ serial: 'X', type: 'physical', model: 'Y' }],
    });

    const args = effectiveGradleArgs(spawn.calls[0]);
    const classArg = args.find(a => a.startsWith('-Pandroid.testInstrumentationRunnerArguments.class='));
    expect(classArg).toBe(
      '-Pandroid.testInstrumentationRunnerArguments.class=com.example.Bench#testFoo'
    );
    // Microbenchmark fix: separate `.method=` arg is NOT emitted (the combined
    // shape narrows down to the single method; the separate-args form was
    // silently running every method in the class).
    expect(args.some(a => a.startsWith('-Pandroid.testInstrumentationRunnerArguments.method='))).toBe(false);
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

describe('runBenchmark --dry-run (F1)', () => {
  it('emits dry_run:true plan, no spawn calls', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();
    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--dry-run', '--platform', 'jvm', '--config', 'stress'],
      spawn,
      adbProbe: () => [],
    });
    expect(envelope.dry_run).toBe(true);
    expect(envelope.exit_code).toBe(0);
    expect(envelope.plan.config).toBe('stress');
    expect(envelope.plan.platform).toBe('jvm');
    expect(spawn.calls.length).toBe(0);
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// v0.8.0 — adaptive `KMP_GRADLE_TIMEOUT_MS` per benchmark config (BACKLOG #5)
// ---------------------------------------------------------------------------
// Per-config defaults: smoke=300s, main=1800s, stress=3600s. Env override
// (KMP_GRADLE_TIMEOUT_MS) wins. --timeout flag (seconds) wins over env.
// --ignore-gradle-timeout returns 0 (disabled). On timeout fire,
// errors[].code:"gradle_timeout" + exitCode=3 (ENV_ERROR, not TEST_FAIL).
describe('resolveBenchmarkTimeoutMs (v0.8.0 — adaptive timeout per --config)', () => {
  it('--config smoke + env unset → 300_000 (5 min default)', () => {
    expect(resolveBenchmarkTimeoutMs('smoke', {}, {})).toBe(300_000);
  });

  it('--config main + env unset → 1_800_000 (30 min default)', () => {
    expect(resolveBenchmarkTimeoutMs('main', {}, {})).toBe(1_800_000);
  });

  it('--config stress + env unset → 3_600_000 (60 min default)', () => {
    expect(resolveBenchmarkTimeoutMs('stress', {}, {})).toBe(3_600_000);
  });

  it('KMP_GRADLE_TIMEOUT_MS env override wins over per-config default', () => {
    expect(resolveBenchmarkTimeoutMs('stress', { KMP_GRADLE_TIMEOUT_MS: '999' }, {})).toBe(999);
  });

  it('--ignore-gradle-timeout returns 0 (disabled) regardless of env/config', () => {
    expect(
      resolveBenchmarkTimeoutMs('stress', { KMP_GRADLE_TIMEOUT_MS: '999' }, { ignoreGradleTimeout: true })
    ).toBe(0);
  });

  it('--timeout 60 wins over env and config (returns 60_000 ms)', () => {
    expect(
      resolveBenchmarkTimeoutMs('main', { KMP_GRADLE_TIMEOUT_MS: '999' }, { timeout: 60 })
    ).toBe(60_000);
  });

  it('unknown config falls through to main default', () => {
    expect(resolveBenchmarkTimeoutMs('unknown-config', {}, {})).toBe(BENCHMARK_TIMEOUT_DEFAULTS_MS.main);
  });
});

describe('runBenchmark gradle_timeout fire path (v0.8.0 — BACKLOG #5)', () => {
  it('spawnGradle returns SIGTERM signal (POSIX timeout) → errors[].code:"gradle_timeout", exit 3', async () => {
    const dir = copyFixture();
    // Mock spawn returns POSIX timeout shape: signal SIGTERM, status null.
    const spawn = (cmd, args, opts) => ({
      status: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      error: null,
    });

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--config', 'stress'],
      spawn,
      adbProbe: () => [],
    });

    const timeoutErr = envelope.errors.find(e => e.code === 'gradle_timeout');
    expect(timeoutErr).toBeDefined();
    expect(timeoutErr.module).toBe('bench-jvm');
    expect(envelope.benchmark.timed_out).toBe(1);
    expect(envelope.benchmark.timeout_ms).toBe(3_600_000); // stress default
    expect(exitCode).toBe(3);
  });

  it('spawnGradle returns ETIMEDOUT (Windows timeout) → exit 3 + envelope.benchmark.timeout_ms reflects config', async () => {
    const dir = copyFixture();
    const spawn = (cmd, args, opts) => ({
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: { code: 'ETIMEDOUT' },
    });

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--config', 'main'],
      spawn,
      adbProbe: () => [],
    });

    expect(envelope.errors[0].code).toBe('gradle_timeout');
    expect(envelope.benchmark.timeout_ms).toBe(1_800_000); // main default
    expect(exitCode).toBe(3);
  });

  it('--ignore-gradle-timeout disables inner timeout (spawnOpts.timeout undefined)', async () => {
    const dir = copyFixture();
    const captured = [];
    const spawn = (cmd, args, opts) => {
      captured.push(opts);
      return { status: 0, signal: null, stdout: 'OK', stderr: '', error: null };
    };

    await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--config', 'stress', '--ignore-gradle-timeout'],
      spawn,
      adbProbe: () => [],
    });

    // The first injected spawn call is the gradle benchmark dispatch — when
    // --ignore-gradle-timeout is set, the orchestrator must NOT pass a
    // `timeout` option (gradle runs without a watchdog).
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].timeout).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// v0.8.0 — adaptive cli.js outer-timeout for benchmark (BACKLOG #5 second leg)
// ---------------------------------------------------------------------------
// The wrapper-level `spawnSync` watchdog must be ≥ orchestrator's per-config
// inner timeout, otherwise cli.js SIGTERMs the wrapper before the orchestrator
// can surface gradle_timeout. Per-config defaults add a 30-min safety buffer
// on top of the orchestrator inner default.
describe('resolveBenchmarkOuterTimeoutMs (v0.8.0 — cli.js outer adaptive)', () => {
  it('--config smoke + env unset → 35 min (5 min inner + 30 min buffer)', () => {
    expect(resolveBenchmarkOuterTimeoutMs(['--config', 'smoke'], {}))
      .toBe(BENCHMARK_OUTER_TIMEOUTS_MS.smoke);
  });

  it('--config stress + env unset → 90 min (60 min inner + 30 min buffer)', () => {
    expect(resolveBenchmarkOuterTimeoutMs(['--config', 'stress'], {}))
      .toBe(BENCHMARK_OUTER_TIMEOUTS_MS.stress);
  });

  it('KMP_GRADLE_TIMEOUT_MS env override wins (preserves parseGradleTimeoutMs contract)', () => {
    expect(resolveBenchmarkOuterTimeoutMs(['--config', 'stress'], { KMP_GRADLE_TIMEOUT_MS: '999' }))
      .toBe(999);
  });

  it('--config flag absent → smoke default (matches orchestrator parseArgs default)', () => {
    expect(resolveBenchmarkOuterTimeoutMs([], {}))
      .toBe(BENCHMARK_OUTER_TIMEOUTS_MS.smoke);
  });
});

// ---------------------------------------------------------------------------
// v0.9 step 2 — --gradle-args global escape hatch.
// ---------------------------------------------------------------------------
describe('runBenchmark --gradle-args escape hatch (v0.9 step 2)', () => {
  it('parseArgs accumulates --gradle-args across invocations + whitespace-splits', () => {
    const single = parseArgs(['--gradle-args', '--no-parallel --max-workers 1']);
    expect(single.gradleArgs).toEqual(['--no-parallel', '--max-workers', '1']);

    const multi = parseArgs([
      '--gradle-args', '--no-parallel',
      '--gradle-args', '-Pfoo=bar',
    ]);
    expect(multi.gradleArgs).toEqual(['--no-parallel', '-Pfoo=bar']);

    const empty = parseArgs([]);
    expect(empty.gradleArgs).toEqual([]);
  });

  it('per-platform dispatch appends --gradle-args tokens LAST in gradleArgs', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();

    await runBenchmark({
      projectRoot: dir,
      args: [
        '--platform', 'jvm',
        '--gradle-args', '--no-parallel',
        '--gradle-args', '-Pfoo=bar',
      ],
      spawn,
      adbProbe: () => [],
    });

    const args = effectiveGradleArgs(spawn.calls[0]);
    expect(args).toContain('--no-parallel');
    expect(args).toContain('-Pfoo=bar');
    expect(args).toContain('--continue');
    // User tokens AFTER --continue.
    const idxContinue = args.indexOf('--continue');
    const idxNoParallel = args.indexOf('--no-parallel');
    const idxFoo = args.indexOf('-Pfoo=bar');
    expect(idxNoParallel).toBeGreaterThan(idxContinue);
    expect(idxFoo).toBeGreaterThan(idxNoParallel);
  });
});

// ---------------------------------------------------------------------------
// v0.9 step 3 — --variant Android variant selector for benchmarks
// ---------------------------------------------------------------------------
describe('runBenchmark --variant (v0.9 step 3)', () => {
  it('parseArgs --variant <value> stores lowercased value; default auto', () => {
    expect(parseArgs(['--variant', 'Release']).variant).toBe('release');
    expect(parseArgs(['--variant', 'all']).variant).toBe('all');
    expect(parseArgs(['--android-variant', 'DEBUG']).variant).toBe('debug');
    expect(parseArgs([]).variant).toBe('auto');
  });

  it('--variant release on android dispatches :mod:connectedReleaseAndroidTest', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'DEVICE_SERIAL_FAKE', type: 'physical', model: 'SM-S908B' }];

    await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'android', '--variant', 'release'],
      spawn,
      adbProbe,
    });

    const args = effectiveGradleArgs(spawn.calls[0]);
    expect(args).toContain(':bench-android:connectedReleaseAndroidTest');
    expect(args).not.toContain(':bench-android:connectedAndroidTest');
  });

  it('--variant debug on android dispatches :mod:connectedDebugAndroidTest', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'DEVICE_SERIAL_FAKE', type: 'physical', model: 'SM-S908B' }];

    await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'android', '--variant', 'debug'],
      spawn,
      adbProbe,
    });

    const args = effectiveGradleArgs(spawn.calls[0]);
    expect(args).toContain(':bench-android:connectedDebugAndroidTest');
  });

  it('--variant has no effect on jvm benchmarks (variant-agnostic by design)', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();

    await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--variant', 'release'],
      spawn,
      adbProbe: () => [],
    });

    // JVM benchmarks compose desktopSmokeBenchmark regardless of --variant.
    const args = effectiveGradleArgs(spawn.calls[0]);
    expect(args.some(a => /desktop.*Benchmark/.test(a))).toBe(true);
    expect(args.some(a => /connected.*AndroidTest/.test(a))).toBe(false);
  });

  it('--dry-run echoes variant in plan', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();

    const { envelope } = await runBenchmark({
      projectRoot: dir,
      args: ['--dry-run', '--variant', 'release'],
      spawn,
      adbProbe: () => [],
    });

    expect(envelope.dry_run).toBe(true);
    expect(envelope.plan.variant).toBe('release');
  });
});

// v0.9 step 4 — `--isolated` for `kmp-test benchmark`. JVM benchmarks
// dispatch one gradle spawn per (module, platform) tuple; verify each one
// receives --project-cache-dir + cleanup runs after the loop.
describe('--isolated cache-dir injection (v0.9 step 4)', () => {
  it('--isolated --dry-run emits envelope.isolated; no spawn, no mkdir', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();
    const { envelope } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--config', 'smoke', '--dry-run', '--isolated'],
      spawn,
      adbProbe: () => [],
    });
    expect(envelope.isolated).toBeDefined();
    expect(envelope.isolated.enabled).toBe(true);
    expect(existsSync(envelope.isolated.cache_dir)).toBe(false);
    expect(spawn.calls.length).toBe(0);
  });

  it('--isolated injects --project-cache-dir on jvm benchmark spawn + cleans up', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();
    const { envelope } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--config', 'smoke', '--isolated'],
      spawn,
      adbProbe: () => [],
    });
    expect(envelope.isolated.enabled).toBe(true);
    const cacheDir = envelope.isolated.cache_dir;
    const gradleCalls = spawn.calls.filter(isGradleCall);
    expect(gradleCalls.length).toBe(1);
    const flat = effectiveGradleArgs(gradleCalls[0]).join(' ');
    expect(flat).toContain('--project-cache-dir');
    expect(flat).toContain(cacheDir);
    // Auto-generated dir cleaned up.
    expect(envelope.isolated.kept).toBe(false);
    expect(existsSync(cacheDir)).toBe(false);
  });

  it('--isolated-cache-dir <path> is preserved (kept:true, dir survives)', async () => {
    const dir = copyFixture();
    const userCache = path.join(dir, 'my-bench-cache');
    const spawn = makeSpawnStub();
    const { envelope } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--config', 'smoke', '--isolated-cache-dir', userCache],
      spawn,
      adbProbe: () => [],
    });
    expect(envelope.isolated.cache_dir).toBe(userCache);
    expect(envelope.isolated.kept).toBe(true);
    expect(existsSync(userCache)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PR 3.2 / A9 — per-task gradle logs persisted to disk + surfaced on envelope.
// ---------------------------------------------------------------------------
// Mirrors android-orchestrator's `.kmp-test-runner/logs/<orch>/<runId>/` layout.
// Surface contract (locked 2026-05-17):
//   - `benchmark.log_paths`: map of '<module>:<platform>' → absolute path
//     (success + failure + timeout entries).
//   - `errors[i].log_path`: inline duplicate on `module_failed` + `gradle_timeout`
//     entries for read-time ergonomics.
describe('runBenchmark per-task log persistence (PR 3.2 / A9)', () => {
  it('successful benchmark writes log file under .kmp-test-runner/logs/benchmark/<runId>/ + surfaces path in log_paths map', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();
    const runId = 'fixed-run-id-success';

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--config', 'smoke'],
      spawn,
      adbProbe: () => [],
      runId,
    });

    expect(exitCode).toBe(0);

    const expectedPath = path.join(
      dir, '.kmp-test-runner', 'logs', 'benchmark', runId, 'bench-jvm-jvm.log'
    );
    expect(existsSync(expectedPath)).toBe(true);
    const content = readFileSync(expectedPath, 'utf8');
    expect(content).toContain('BUILD SUCCESSFUL');
    expect(content).toContain('--- STDERR ---');

    // log_paths map covers success modules.
    expect(envelope.benchmark.log_paths).toBeDefined();
    expect(envelope.benchmark.log_paths['bench-jvm:jvm']).toBe(expectedPath);
  });

  it('failing benchmark surfaces log_path BOTH on log_paths map AND inline on errors[].log_path', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub({ defaultStatus: 1 });
    const runId = 'fixed-run-id-fail';

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--config', 'smoke'],
      spawn,
      adbProbe: () => [],
      runId,
    });

    expect(exitCode).toBe(1);
    const expectedPath = path.join(
      dir, '.kmp-test-runner', 'logs', 'benchmark', runId, 'bench-jvm-jvm.log'
    );
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, 'utf8')).toContain('BUILD FAILED');

    // Inline on the errors[] entry (mirrors android-orch precedent).
    const moduleFailed = envelope.errors.find(e => e.code === 'module_failed');
    expect(moduleFailed).toBeDefined();
    expect(moduleFailed.log_path).toBe(expectedPath);

    // Also in the aggregate map.
    expect(envelope.benchmark.log_paths['bench-jvm:jvm']).toBe(expectedPath);
  });

  it('gradle-timeout module surfaces log_path on gradle_timeout errors[] entry + log_paths map', async () => {
    const dir = copyFixture();
    // POSIX timeout shape: signal SIGTERM, status null.
    const spawn = (cmd, args, opts) => ({
      status: null, signal: 'SIGTERM', stdout: 'partial output', stderr: 'stderr partial',
      error: null,
    });
    const runId = 'fixed-run-id-timeout';

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--config', 'stress'],
      spawn,
      adbProbe: () => [],
      runId,
    });

    expect(exitCode).toBe(3); // single module timed out, no passes → unchanged hard fail
    const expectedPath = path.join(
      dir, '.kmp-test-runner', 'logs', 'benchmark', runId, 'bench-jvm-jvm.log'
    );
    expect(existsSync(expectedPath)).toBe(true);
    const content = readFileSync(expectedPath, 'utf8');
    expect(content).toContain('partial output');
    expect(content).toContain('stderr partial');

    const timeoutErr = envelope.errors.find(e => e.code === 'gradle_timeout');
    expect(timeoutErr).toBeDefined();
    expect(timeoutErr.log_path).toBe(expectedPath);
    expect(envelope.benchmark.log_paths['bench-jvm:jvm']).toBe(expectedPath);
  });
});

// ---------------------------------------------------------------------------
// PR 3.2 / A11 — default --no-configuration-cache for benchmark dispatch.
// ---------------------------------------------------------------------------
// Root cause: kotlinx-benchmark caches %TEMP% inside its gradle config cache;
// stale TEMP → silent 2.2s FNFE FAIL on Windows. Default-disabling the cache
// makes the workaround unnecessary. User override via
// --gradle-args "--configuration-cache" wins via gradle last-wins.
describe('runBenchmark default --no-configuration-cache (PR 3.2 / A11)', () => {
  it('default invocation includes --no-configuration-cache in gradle args', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();

    await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--config', 'smoke'],
      spawn,
      adbProbe: () => [],
    });

    const args = effectiveGradleArgs(spawn.calls[0]);
    expect(args).toContain('--no-configuration-cache');
  });

  it('user --gradle-args "--configuration-cache" results in BOTH flags present (orchestrator does NOT dedup; gradle last-wins handles override)', async () => {
    const dir = copyFixture();
    const spawn = makeSpawnStub();

    await runBenchmark({
      projectRoot: dir,
      args: [
        '--platform', 'jvm',
        '--gradle-args', '--configuration-cache',
      ],
      spawn,
      adbProbe: () => [],
    });

    const args = effectiveGradleArgs(spawn.calls[0]);
    expect(args).toContain('--no-configuration-cache');
    expect(args).toContain('--configuration-cache');
    // Order matters: orchestrator-injected first, user override last (gradle wins).
    const idxOrch = args.indexOf('--no-configuration-cache');
    const idxUser = args.indexOf('--configuration-cache');
    expect(idxUser).toBeGreaterThan(idxOrch);
  });
});

// ---------------------------------------------------------------------------
// PR 3.2 / A10 — graded partial-timeout exit code + --strict-timeouts opt-out.
// ---------------------------------------------------------------------------
// Behavior change: with >=1 passing module + >=1 timed-out module, exit
// code becomes 0 (was 3) and a `partial_timeout` warning is surfaced. CI
// matrix users opt in to pre-graded behavior via --strict-timeouts.
describe('runBenchmark graded partial-timeout exit (PR 3.2 / A10)', () => {
  it('1 timeout + 1 pass (no --strict-timeouts) → exit 0 + warnings[].code=partial_timeout', async () => {
    const dir = copyFixture();
    // Two spawns: bench-jvm first (SIGTERM = timeout), bench-android second (pass).
    const adbProbe = () => [{ serial: 'DEVICE_SERIAL_FAKE', type: 'physical', model: 'SM-S908B' }];
    let callIdx = 0;
    const spawn = (cmd, args, opts) => {
      const idx = callIdx++;
      if (idx === 0) {
        return { status: null, signal: 'SIGTERM', stdout: 'timed out', stderr: '', error: null };
      }
      return { status: 0, signal: null, stdout: 'BUILD SUCCESSFUL\n', stderr: '', error: null };
    };

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'all', '--config', 'smoke'],
      spawn,
      adbProbe,
    });

    expect(exitCode).toBe(0); // graded — was 3 pre-PR 3.2
    expect(envelope.benchmark.timed_out).toBe(1);
    expect(envelope.benchmark.passed).toBe(1);

    const warn = envelope.warnings.find(w => w.code === 'partial_timeout');
    expect(warn).toBeDefined();
    expect(warn.timed_out).toBe(1);
    expect(warn.passed).toBe(1);

    // Per-module gradle_timeout errors[] entry is preserved.
    const timeoutErr = envelope.errors.find(e => e.code === 'gradle_timeout');
    expect(timeoutErr).toBeDefined();
  });

  it('1 timeout + 1 pass + --strict-timeouts → exit 3 + NO partial_timeout warning', async () => {
    const dir = copyFixture();
    const adbProbe = () => [{ serial: 'DEVICE_SERIAL_FAKE', type: 'physical', model: 'SM-S908B' }];
    let callIdx = 0;
    const spawn = (cmd, args, opts) => {
      const idx = callIdx++;
      if (idx === 0) {
        return { status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: null };
      }
      return { status: 0, signal: null, stdout: 'BUILD SUCCESSFUL\n', stderr: '', error: null };
    };

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'all', '--config', 'smoke', '--strict-timeouts'],
      spawn,
      adbProbe,
    });

    expect(exitCode).toBe(3); // strict opt-out restores pre-graded hard fail
    expect(envelope.warnings.find(w => w.code === 'partial_timeout')).toBeUndefined();
  });

  it('all modules timed out (zero passes) → exit 3 regardless of --strict-timeouts (everything-hung guard)', async () => {
    const dir = copyFixture();
    const adbProbe = () => [{ serial: 'DEVICE_SERIAL_FAKE', type: 'physical', model: 'SM-S908B' }];
    const spawn = (cmd, args, opts) => ({
      status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: null,
    });

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'all', '--config', 'smoke'], // no --strict-timeouts
      spawn,
      adbProbe,
    });

    expect(exitCode).toBe(3); // graded path requires totalPass >= 1; zero passes → hard fail
    expect(envelope.benchmark.passed).toBe(0);
    expect(envelope.benchmark.timed_out).toBeGreaterThanOrEqual(2);
    expect(envelope.warnings.find(w => w.code === 'partial_timeout')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// spawn_error discrimination (spawn-layer failures vs ordinary module_failed)
// ---------------------------------------------------------------------------
describe('runBenchmark spawn_error discrimination', () => {
  it('surfaces a spawn-layer error as spawn_error with errno + maxBuffer hint', async () => {
    const dir = copyFixture();
    const overflow = Object.assign(new Error('stdout maxBuffer length exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    const spawn = (cmd, args) => {
      spawn.calls.push({ cmd, args: [...args] });
      return { status: null, stdout: 'partial', stderr: '', signal: null, error: overflow };
    };
    spawn.calls = [];

    const { envelope, exitCode } = await runBenchmark({
      projectRoot: dir,
      args: ['--platform', 'jvm', '--config', 'smoke'],
      spawn,
      adbProbe: () => [],
    });

    expect(exitCode).not.toBe(0);
    const err = envelope.errors.find(e => e.code === 'spawn_error');
    expect(err).toBeTruthy();
    expect(err.errno).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    expect(err.message).toContain('KMP_GRADLE_MAXBUFFER_MB');
    expect(envelope.errors.find(e => e.code === 'module_failed')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Convention-plugin benchmark discovery (build-logic descriptors)
// ---------------------------------------------------------------------------
// Wet finding on the reference composite: kotlinx-benchmark applied through a
// build-logic convention plugin (custom id) was invisible to the literal
// markers — `kmp-test benchmark` discovered 0 modules on a project where the
// v0.8-era direct application used to work. Discovery now expands a module's
// convention plugin ids via parseBuildLogicPluginDescriptors.appliedPlugins.
describe('discoverBenchmarkModules via build-logic convention plugin', () => {
  it('discovers + dispatches a module whose benchmark plugin comes from a convention descriptor', async () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-bench-conv-'));
    writeFileSync(path.join(workDir, 'settings.gradle.kts'),
      'rootProject.name = "conv"\ninclude(":bench-mod")\n');
    mkdirSync(path.join(workDir, 'bench-mod'), { recursive: true });
    // The module applies ONLY the custom convention id — no literal
    // kotlinx.benchmark marker anywhere in its build file.
    writeFileSync(path.join(workDir, 'bench-mod', 'build.gradle.kts'),
      'plugins {\n    id("com.acme.kmp.benchmark")\n}\n');
    mkdirSync(path.join(workDir, 'build-logic', 'src', 'main', 'kotlin'), { recursive: true });
    writeFileSync(path.join(workDir, 'build-logic', 'build.gradle.kts'),
      'gradlePlugin {\n    plugins {\n        register("kmpBenchmark") {\n'
      + '            id = "com.acme.kmp.benchmark"\n'
      + '            implementationClass = "AcmeBenchmarkConventionPlugin"\n'
      + '        }\n    }\n}\n');
    writeFileSync(
      path.join(workDir, 'build-logic', 'src', 'main', 'kotlin', 'AcmeBenchmarkConventionPlugin.kt'),
      'class AcmeBenchmarkConventionPlugin : Plugin<Project> {\n'
      + '    override fun apply(target: Project) {\n'
      + '        target.pluginManager.apply("org.jetbrains.kotlinx.benchmark")\n'
      + '    }\n}\n');
    writeFileSync(path.join(workDir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(path.join(workDir, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');

    const spawn = makeSpawnStub();
    const { envelope, exitCode } = await runBenchmark({
      projectRoot: workDir,
      args: ['--platform', 'jvm', '--config', 'smoke'],
      spawn,
      adbProbe: () => [],
    });

    expect(exitCode).toBe(0);
    expect(envelope.modules).toContain('bench-mod');
    expect(envelope.tests.passed).toBe(1);
    expect(envelope.errors).toEqual([]);
    // The dispatched task is the jvm smoke benchmark task.
    const gradleCalls = spawn.calls.filter(c => isGradleCall(c));
    expect(effectiveGradleArgs(gradleCalls[0])).toContain(':bench-mod:desktopSmokeBenchmark');
  });
});

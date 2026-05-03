// SPDX-License-Identifier: MIT
// E2E integration test for lib/orchestrator-utils.js#spawnGradle.
//
// WHY THIS EXISTS — root-cause guard for the 2026-05-03 silent-pass incident.
//
// Before this test, every other vitest case injected a mock `spawn` function;
// the real Node spawnSync code path was never exercised. That left a blind
// spot: Node 18.20.2+ enforces CVE-2024-27980 which returns EINVAL when
// you spawn a `.bat` file directly without `shell:true` or an explicit
// cmd.exe wrapper. On Windows, `spawnSync('gradlew.bat', ...)` returned
// `status:null` instantly, the orchestrator's classifyTaskResults regex
// matched nothing on the empty stdout, and the fallback path silently
// reported every task as `[PASS]`. A 23-project wide-smoke against
// AndroidStudioProjects on 2026-05-03 produced 14/14 false-positive GREEN
// envelopes — gradle was never invoked, but the JSON said all-passed.
//
// This file uses a REAL spawn against a fake gradlew script (gradlew /
// gradlew.bat in tests/fixtures/fake-gradlew/) that echoes synthetic
// gradle output. If spawnGradle works, the orchestrator sees real stdout
// (`> Task :app:test`, `BUILD SUCCESSFUL in 1s`) and reports the result
// honestly. If spawnGradle is broken (e.g. shell-bypass removed), the
// stdout is empty, the defense-in-depth in classifyTaskResults flips
// everything to FAIL — either way the test catches it. The one failure
// mode this guards against is the silent-pass class.
//
// CI matrix: this file MUST run on windows-latest in addition to
// ubuntu-latest. The Windows path is the one the bug lived in.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { spawnGradle } from '../../lib/orchestrator-utils.js';
import { runParallel } from '../../lib/parallel-orchestrator.js';
import { runBenchmark } from '../../lib/benchmark-orchestrator.js';
import { runAndroid } from '../../lib/android-orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.join(__dirname, '..', 'fixtures', 'fake-gradlew');

function copyFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmp-e2e-spawn-'));
  cpSync(FIXTURE_SRC, dir, { recursive: true });
  // mkdtemp + cpSync may not preserve POSIX exec bit on all platforms —
  // re-set it explicitly so the bash gradlew is runnable.
  if (process.platform !== 'win32') {
    spawnSync('chmod', ['+x', path.join(dir, 'gradlew')]);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Tier 1 — spawnGradle direct, no orchestrator. Proves the helper bypasses
// Node 18.20.2+ EINVAL on Windows.
// ---------------------------------------------------------------------------
describe('spawnGradle (direct, real spawnSync)', () => {
  it('invokes gradlew.bat / gradlew successfully — non-EINVAL status, real stdout', () => {
    const dir = copyFixture();
    try {
      const isWin = process.platform === 'win32';
      const gradlewPath = path.join(dir, isWin ? 'gradlew.bat' : 'gradlew');
      const result = spawnGradle(spawnSync, gradlewPath, [':app:test'], {
        cwd: dir,
        encoding: 'utf8',
        env: process.env,
      });
      // The whole point: status MUST be a number (0 here), NOT null.
      // status:null + error:'EINVAL' is the silent-pass bug signature.
      expect(typeof result.status).toBe('number');
      expect(result.status).toBe(0);
      expect(result.error).toBeFalsy();
      // Real gradle output reached us.
      expect(result.stdout).toContain('> Task :app:test');
      expect(result.stdout).toContain('BUILD SUCCESSFUL in 1s');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('propagates non-zero exit — KMP_FAKE_GRADLE_FAIL flips pass→fail', () => {
    const dir = copyFixture();
    try {
      const isWin = process.platform === 'win32';
      const gradlewPath = path.join(dir, isWin ? 'gradlew.bat' : 'gradlew');
      const result = spawnGradle(spawnSync, gradlewPath, [':app:test'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, KMP_FAKE_GRADLE_FAIL: '1' },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('> Task :app:test FAILED');
      expect(result.stdout).toContain('BUILD FAILED in 1s');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles project paths with whitespace (cmd.exe quoting)', () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'kmp-e2e-'));
    const dir = path.join(tmpRoot, 'has space');
    mkdirSync(dir, { recursive: true });
    cpSync(FIXTURE_SRC, dir, { recursive: true });
    if (process.platform !== 'win32') {
      spawnSync('chmod', ['+x', path.join(dir, 'gradlew')]);
    }
    try {
      const isWin = process.platform === 'win32';
      const gradlewPath = path.join(dir, isWin ? 'gradlew.bat' : 'gradlew');
      const result = spawnGradle(spawnSync, gradlewPath, [':app:test'], {
        cwd: dir,
        encoding: 'utf8',
        env: process.env,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('BUILD SUCCESSFUL');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — runParallel end-to-end with REAL spawn. Validates the entire
// dispatch → classify → envelope pipeline, the place where the silent-pass
// bug lived. tests.passed > 0 proves gradle was REALLY invoked.
// ---------------------------------------------------------------------------
describe('runParallel (real spawn — silent-pass guard)', () => {
  it('dispatches gradle for real, reports honest tests.passed when gradle exits 0', async () => {
    const dir = copyFixture();
    try {
      const { envelope, exitCode } = await runParallel({
        projectRoot: dir,
        args: ['--test-type', 'common', '--no-coverage'],
        env: process.env,
        log: () => {},
      });
      // Defense-in-depth + real spawn together: a truly successful gradle
      // run produces BUILD SUCCESSFUL stdout, which classifyTaskResults
      // sees, and tests.passed reflects real classification.
      expect(envelope.parallel.legs[0].exit_code).toBe(0);
      expect(envelope.tests.passed).toBeGreaterThan(0);
      expect(envelope.tests.failed).toBe(0);
      expect(exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports honest tests.failed when gradle exits non-zero (per-task FAILED markers visible)', async () => {
    const dir = copyFixture();
    try {
      const { envelope, exitCode } = await runParallel({
        projectRoot: dir,
        args: ['--test-type', 'common', '--no-coverage'],
        env: { ...process.env, KMP_FAKE_GRADLE_FAIL: '1' },
        log: () => {},
      });
      expect(envelope.parallel.legs[0].exit_code).toBe(1);
      expect(envelope.tests.failed).toBeGreaterThan(0);
      expect(envelope.tests.passed).toBe(0);
      expect(exitCode).toBe(1);
      // Defense-in-depth contract: failing leg MUST produce errors[].
      expect(envelope.errors.some(e => e.code === 'module_failed')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NEVER silent-passes on EINVAL (Tier-1 of defense-in-depth — hypothetical regression)', async () => {
    // This case simulates the original bug class: what if a future code
    // change accidentally re-introduces a code path where spawn returns
    // status:null + empty stdout? We inject a mock to PROVE the new
    // classifyTaskResults logic catches it via legExit + no positive
    // evidence → 'failed'.
    const dir = copyFixture();
    try {
      const fakeSpawn = () => ({
        status: null,            // EINVAL signature
        stdout: '',
        stderr: '',
        signal: null,
        error: { code: 'EINVAL' },
      });
      const { envelope, exitCode } = await runParallel({
        projectRoot: dir,
        args: ['--test-type', 'common', '--no-coverage'],
        env: process.env,
        spawn: fakeSpawn,
        log: () => {},
      });
      // Defense-in-depth: status:null → exit fallback to 1 → no positive
      // evidence in stdout → all tasks marked FAILED, never silent PASS.
      expect(envelope.tests.passed).toBe(0);
      expect(envelope.tests.failed).toBeGreaterThan(0);
      expect(exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Tier 3 — runBenchmark end-to-end with REAL spawn. Same silent-pass guard
// for the benchmark orchestrator (uses spawnGradle internally too).
// ---------------------------------------------------------------------------
describe('runBenchmark (real spawn — silent-pass guard)', () => {
  it('dispatches gradle for real on jvm platform, reports honest pass count', async () => {
    // Build a benchmark-shaped fixture: kotlinx.benchmark plugin + jvm() target.
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-e2e-bench-'));
    try {
      cpSync(FIXTURE_SRC, dir, { recursive: true });
      if (process.platform !== 'win32') {
        spawnSync('chmod', ['+x', path.join(dir, 'gradlew')]);
      }
      writeFileSync(path.join(dir, 'app', 'build.gradle.kts'), `
plugins {
  id("org.jetbrains.kotlin.multiplatform")
  id("org.jetbrains.kotlinx.benchmark")
}
kotlin {
  jvm()
  sourceSets {
    val commonMain by getting
    val jvmMain by getting
  }
}
`);
      const { envelope, exitCode } = await runBenchmark({
        projectRoot: dir,
        args: ['--platform', 'jvm', '--config', 'smoke'],
        env: process.env,
        adbProbe: () => [],
        log: () => {},
      });
      expect(envelope.tests.passed).toBeGreaterThan(0);
      expect(envelope.tests.failed).toBe(0);
      expect(exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Tier 4 — runAndroid end-to-end with REAL spawn for gradle, BYPASSED adb.
//
// Why not provide a synthetic adb device + let the orchestrator spawn `adb`
// for real: the android-orchestrator hardcodes `spawn('adb', ['-s',
// <serial>, 'logcat', ...])` (NOT injectable via the `spawn` opt — that one
// only covers gradle). On macOS GHA runners adb IS present (preinstalled
// with the Android SDK), so a synthetic serial like `emulator-5554` causes
// `adb logcat -d` to BLOCK indefinitely waiting for the device. CI hung 25+
// minutes before we caught it. KMP_TEST_SKIP_ADB=1 short-circuits the entire
// adb path — keeps the test focused on real gradle dispatch (the EINVAL
// regression guard) without dragging adb into the dependency surface.
//
// Real-device validation lives in tests/bats + tests/pester, not vitest.
// ---------------------------------------------------------------------------
describe('runAndroid (real spawn — silent-pass guard, adb bypassed)', () => {
  it('skips with reason when KMP_TEST_SKIP_ADB=1 — proves the orchestrator path runs', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-e2e-android-'));
    try {
      cpSync(FIXTURE_SRC, dir, { recursive: true });
      writeFileSync(path.join(dir, 'app', 'build.gradle.kts'), `
plugins {
  id("com.android.library")
  id("org.jetbrains.kotlin.android")
}
android {
  namespace = "com.example.app"
  compileSdk = 34
}
`);
      mkdirSync(path.join(dir, 'app', 'src', 'androidTest'), { recursive: true });
      const { envelope, exitCode } = await runAndroid({
        projectRoot: dir,
        args: [],
        env: { ...process.env, KMP_TEST_SKIP_ADB: '1' },
        // adbProbe should NOT be called when KMP_TEST_SKIP_ADB=1; throwing
        // here proves the env-var short-circuit fires before probe.
        adbProbe: () => { throw new Error('adb probe must not fire under KMP_TEST_SKIP_ADB=1'); },
        log: () => {},
      });
      // Module discovered via project-model, then skipped with reason.
      expect(envelope.android.instrumented_modules).toContain('app');
      expect(envelope.skipped.some(s => s.module === 'app' && /KMP_TEST_SKIP_ADB/.test(s.reason))).toBe(true);
      expect(exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits instrumented_setup_failed when no device + no skip env (silent-pass guard)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kmp-e2e-android-fail-'));
    try {
      cpSync(FIXTURE_SRC, dir, { recursive: true });
      writeFileSync(path.join(dir, 'app', 'build.gradle.kts'), `
plugins { id("com.android.library") }
android { namespace = "com.example.app"; compileSdk = 34 }
`);
      mkdirSync(path.join(dir, 'app', 'src', 'androidTest'), { recursive: true });
      const { envelope, exitCode } = await runAndroid({
        projectRoot: dir,
        args: [],
        env: process.env,
        // Empty probe → no devices → orchestrator MUST emit instrumented_setup_failed
        // BEFORE attempting any adb logcat call. Defense-in-depth check.
        adbProbe: () => [],
        log: () => {},
      });
      expect(envelope.errors.some(e => e.code === 'instrumented_setup_failed')).toBe(true);
      expect(exitCode).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

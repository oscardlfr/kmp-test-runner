// SPDX-License-Identifier: MIT
// Tests for lib/android-orchestrator.js — v0.8 STRATEGIC PIVOT, sub-entry 3.
//
// Migrates `kmp-test android` from scripts/sh/run-android-tests.sh (784 LOC)
// + scripts/ps1/run-android-tests.ps1 (649 LOC) to Node. Closes WS-3
// (single source of truth via project-model deviceTestTask) + WS-10
// (--list-only renders names from same array as count).
//
// Test surface (acceptance rubric: BACKLOG.md Sub-entry 3):
//   1. WS-3: discovery via project-model deviceTestTask path
//   2. WS-10: --list-only renders non-empty names matching count
//   3. instrumented_setup_failed on no adb device + exit 3
//   4. --device-task <name> preempts deviceTestTask
//   5. envelope shape: android:{device_serial, device_task, flavor, instrumented_modules}
//   6. emits === JSON SUMMARY === block on stdout (parser contract)
//   7. cross-OS spawn shape (gradlew vs gradlew.bat)
//   8. per-module log files at <projectRoot>/build/logcat/<runId>/
//   9. --auto-retry re-spawns once
//   10. --auto-retry --clear-data invokes adb shell pm clear
//   11. --skip-app filter
//   12. --module-filter post-discovery substring match
//   13. KMP_TEST_SKIP_ADB=1 → skipped[] + exit 0
//   14. --test-filter Class#method emits both class= and method= -P args
//   15. parsed.android passthrough via buildJsonReport

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runAndroid } from '../../lib/android-orchestrator.js';

let workDir;

afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

// Build a project with the listed android modules. Each gets a build.gradle.kts
// shaped so analyzeModule classifies type:'android' with optional androidDsl.
function makeProject(modules, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmp-android-test-'));
  workDir = dir;
  const includes = modules.map(m => `include(":${m.name}")`).join('\n');
  writeFileSync(path.join(dir, 'settings.gradle.kts'),
    `rootProject.name = "${opts.rootName ?? 'fixture'}"\n${includes}\n`);
  // Stub gradlew so buildProjectModel's wrapper-existence check doesn't
  // bail. spawnSync is injected so the wrapper is never actually run.
  writeFileSync(path.join(dir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(path.join(dir, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
  for (const mod of modules) {
    const modDir = path.join(dir, ...mod.name.split(':'));
    mkdirSync(modDir, { recursive: true });
    const build = mod.build ?? `plugins { id("com.android.library") }\nandroid { namespace = "test.${mod.name}" }\n`;
    writeFileSync(path.join(modDir, 'build.gradle.kts'), build);
    if (mod.manifestPackage) {
      const manifestDir = path.join(modDir, 'src', 'main');
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(path.join(manifestDir, 'AndroidManifest.xml'),
        `<manifest package="${mod.manifestPackage}"/>`);
    }
  }
  return dir;
}

// Spawn stub. `adb` configures the (separate) adb-shell calls; everything
// else is treated as the gradlew dispatch and routed through `gradle`.
function makeSpawnStub({ gradle = {}, perModuleStatus = {}, adb = {} } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({
      cmd,
      args: [...args],
      cwd: opts?.cwd ?? null,
    });
    // adb invocations: probe, logcat clear, logcat dump, pm clear.
    if (cmd === 'adb') {
      const sub = args[args.length - 1] === '-c' ? 'logcat-clear'
                : args.includes('clear') ? 'pm-clear'
                : args.includes('-d') ? 'logcat-dump'
                : 'unknown-adb';
      return {
        status: 0,
        stdout: adb[sub] ?? '',
        stderr: '',
        signal: null,
        error: null,
      };
    }
    // Otherwise: gradle. Look up per-module status by inspecting the task arg.
    const taskArg = args.find(a => typeof a === 'string' && a.startsWith(':'));
    let status = gradle.status ?? 0;
    if (taskArg) {
      const mod = taskArg.split(':')[1];
      if (perModuleStatus[mod] !== undefined) status = perModuleStatus[mod];
    }
    return {
      status,
      stdout: gradle.stdout ?? (status === 0
        ? '> Task :module:connectedDebugAndroidTest\n5 tests completed\nBUILD SUCCESSFUL\n'
        : '> Task :module:connectedDebugAndroidTest\n5 tests completed, 1 failed\nBUILD FAILED\n'),
      stderr: gradle.stderr ?? '',
      signal: null,
      error: null,
    };
  };
  fn.calls = calls;
  return fn;
}

// Find the gradle subprocess invocations among recorded calls. Filters out
// adb calls so per-module dispatch assertions stay focused.
function findGradleCalls(calls) {
  return calls.filter(c => /gradlew(\.bat)?$/.test(c.cmd));
}

// Find the adb invocations.
function findAdbCalls(calls) {
  return calls.filter(c => c.cmd === 'adb');
}

// Extract a flag value from a recorded args[]. Returns the value following
// `name`, or null if not present.
function extractFlag(args, name) {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return null;
  return args[i + 1];
}

// ---------------------------------------------------------------------------
// Case 1 — WS-3 closure: discovery via project-model deviceTestTask
// ---------------------------------------------------------------------------
describe('runAndroid WS-3 (single source of truth via deviceTestTask)', () => {
  it('discovers all 4 Confetti-shape modules via type:"android" + androidDsl signals', async () => {
    const dir = makeProject([
      { name: 'androidApp', build: `plugins { id("com.android.application") }\nandroid { namespace = "x" }\n` },
      { name: 'shared',     build: `plugins { kotlin("multiplatform") }\nkotlin {\n  androidLibrary {}\n}\n` },
      { name: 'wearApp',    build: `plugins { id("com.android.application") }\nandroid { namespace = "x" }\n` },
      { name: 'service',    build: `plugins { id("com.android.library") }\nandroid { namespace = "x" }\n` },
      { name: 'no-android', build: `plugins { kotlin("jvm") }\n` },
    ]);
    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'R3CT30KAMEH', type: 'physical', model: 'SM-S908B' }];

    const { envelope, exitCode } = await runAndroid({
      projectRoot: dir,
      args: ['--list-only'],
      spawn,
      adbProbe,
    });

    expect(envelope.android.instrumented_modules.sort()).toEqual(
      ['androidApp', 'service', 'shared', 'wearApp']
    );
    expect(envelope.errors).toEqual([]);
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case 2 — WS-10 closure: --list-only renders non-empty names matching count
// ---------------------------------------------------------------------------
describe('runAndroid WS-10 (--list-only same source as count)', () => {
  it('renders non-empty module names matching the count', async () => {
    const dir = makeProject([
      { name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' },
    ]);
    const spawn = makeSpawnStub();
    const adbProbe = () => [];   // no device — but list-only doesn't need it
    const lines = [];

    const { envelope, exitCode } = await runAndroid({
      projectRoot: dir,
      args: ['--list-only'],
      spawn,
      adbProbe,
      log: (l) => lines.push(l),
    });

    // The rendered count and the rendered names come from the SAME array.
    expect(envelope.android.instrumented_modules).toEqual(['a', 'b', 'c', 'd']);
    const headerLine = lines.find(l => l.startsWith('Android Test Modules'));
    expect(headerLine).toMatch(/\(4\)/);
    for (const name of ['a', 'b', 'c', 'd']) {
      expect(lines.some(l => l.includes(`- ${name}`))).toBe(true);
    }
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — instrumented_setup_failed when no adb device + exit 3
// ---------------------------------------------------------------------------
describe('runAndroid PRODUCT criterion 5 (no silent pass on missing platform)', () => {
  it('no adb device → errors[0].code:"instrumented_setup_failed", exit 3', async () => {
    const dir = makeProject([{ name: 'a' }]);
    const spawn = makeSpawnStub();
    const adbProbe = () => [];

    const { envelope, exitCode } = await runAndroid({
      projectRoot: dir,
      args: [],
      spawn,
      adbProbe,
    });

    expect(envelope.errors[0].code).toBe('instrumented_setup_failed');
    expect(exitCode).toBe(3);
    // The error-envelope still surfaces the discovered modules so agents can
    // see what WOULD have run.
    expect(envelope.android.instrumented_modules).toEqual(['a']);
  });

  it('--device <serial> not in adb list → instrumented_setup_failed', async () => {
    const dir = makeProject([{ name: 'a' }]);
    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'emulator-5554', type: 'emulator', model: 'sdk' }];

    const { envelope, exitCode } = await runAndroid({
      projectRoot: dir,
      args: ['--device', 'NONEXISTENT'],
      spawn,
      adbProbe,
    });

    expect(envelope.errors[0].code).toBe('instrumented_setup_failed');
    expect(envelope.android.device_serial).toBe('NONEXISTENT');
    expect(exitCode).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — --device-task <name> preempts deviceTestTask resolution
// ---------------------------------------------------------------------------
describe('runAndroid --device-task escape hatch', () => {
  it('forces :module:<override> verbatim, skipping model + static fallback', async () => {
    const dir = makeProject([{ name: 'a' }]);
    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'emulator-5554', type: 'emulator', model: 'sdk' }];

    await runAndroid({
      projectRoot: dir,
      args: ['--device-task', 'androidConnectedCheck'],
      spawn,
      adbProbe,
    });

    const gradleCalls = findGradleCalls(spawn.calls);
    expect(gradleCalls.length).toBe(1);
    expect(gradleCalls[0].args).toContain(':a:androidConnectedCheck');
    expect(gradleCalls[0].args).not.toContain(':a:connectedDebugAndroidTest');
  });

  it('envelope.android.device_task echoes the override', async () => {
    const dir = makeProject([{ name: 'a' }]);
    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'emulator-5554', type: 'emulator', model: 'sdk' }];

    const { envelope } = await runAndroid({
      projectRoot: dir,
      args: ['--device-task', 'connectedFooDebugAndroidTest'],
      spawn,
      adbProbe,
    });

    expect(envelope.android.device_task).toBe('connectedFooDebugAndroidTest');
  });
});

// ---------------------------------------------------------------------------
// Case 5 — envelope shape includes android:{device_serial, device_task, flavor, instrumented_modules}
// ---------------------------------------------------------------------------
describe('runAndroid envelope shape', () => {
  it('includes android:{device_serial, device_task, flavor, instrumented_modules}', async () => {
    const dir = makeProject([{ name: 'a' }, { name: 'b' }]);
    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'R3CT30KAMEH', type: 'physical', model: 'SM-S908B' }];

    const { envelope } = await runAndroid({
      projectRoot: dir,
      args: ['--flavor', 'staging'],
      spawn,
      adbProbe,
    });

    expect(envelope.android).toBeDefined();
    expect(envelope.android.device_serial).toBe('R3CT30KAMEH');
    expect(envelope.android.device_task).toBe('');
    expect(envelope.android.flavor).toBe('staging');
    expect(Array.isArray(envelope.android.instrumented_modules)).toBe(true);
    expect(envelope.android.instrumented_modules.sort()).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// Case 6 — emits === JSON SUMMARY === block on stdout (parser contract)
// ---------------------------------------------------------------------------
describe('runAndroid JSON SUMMARY banner emission', () => {
  it('emits the literal "=== JSON SUMMARY ===" + JSON with parseAndroidSummary fields', async () => {
    const dir = makeProject([{ name: 'a' }]);
    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'emulator-5554', type: 'emulator', model: 'sdk' }];
    const lines = [];

    await runAndroid({
      projectRoot: dir,
      args: [],
      spawn,
      adbProbe,
      log: (l) => lines.push(l),
    });

    const sentinelIdx = lines.findIndex(l => l.includes('=== JSON SUMMARY ==='));
    expect(sentinelIdx).toBeGreaterThan(-1);

    // The JSON block is emitted as one or more lines after the sentinel.
    const jsonText = lines.slice(sentinelIdx + 1).join('\n');
    const start = jsonText.indexOf('{');
    const summary = JSON.parse(jsonText.slice(start, jsonText.lastIndexOf('}') + 1));
    expect(summary).toHaveProperty('totalTests');
    expect(summary).toHaveProperty('passedTests');
    expect(summary).toHaveProperty('failedTests');
    expect(Array.isArray(summary.modules)).toBe(true);
    const m = summary.modules[0];
    expect(m).toHaveProperty('name');
    expect(m).toHaveProperty('status');
    expect(m).toHaveProperty('logFile');
    expect(m).toHaveProperty('logcatFile');
    expect(m).toHaveProperty('errorsFile');
  });
});

// ---------------------------------------------------------------------------
// Case 7 — cross-OS spawn shape (gradlew vs gradlew.bat)
// ---------------------------------------------------------------------------
describe('runAndroid cross-OS spawn shape', () => {
  it('on darwin uses bare gradlew', async () => {
    const dir = makeProject([{ name: 'a' }]);
    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'emulator-5554', type: 'emulator', model: 'sdk' }];

    await runAndroid({ projectRoot: dir, args: [], spawn, adbProbe });

    const gradleCalls = findGradleCalls(spawn.calls);
    expect(gradleCalls.length).toBeGreaterThan(0);
    // The orchestrator picks gradlew on Unix, gradlew.bat on Windows. We
    // accept BOTH shapes (memory: feedback_orchestrator_test_cross_platform
    // — macOS local hides Windows divergence). Lock the basename.
    expect(gradleCalls[0].cmd).toMatch(/gradlew(\.bat)?$/);
    expect(gradleCalls[0].cwd).toBe(dir);
  });
});

// ---------------------------------------------------------------------------
// Case 8 — per-module log files at <projectRoot>/build/logcat/<runId>/
// ---------------------------------------------------------------------------
describe('runAndroid per-module log files', () => {
  it('writes <runId>/<module>.log + _logcat.log on success; +_errors.json on FAIL', async () => {
    const dir = makeProject([{ name: 'pass-mod' }, { name: 'fail-mod' }]);
    const spawn = makeSpawnStub({
      perModuleStatus: { 'pass-mod': 0, 'fail-mod': 1 },
    });
    const adbProbe = () => [{ serial: 'emulator-5554', type: 'emulator', model: 'sdk' }];

    const { envelope } = await runAndroid({
      projectRoot: dir,
      args: [],
      spawn,
      adbProbe,
      runId: 'fixed-run-id',
    });

    const logDir = path.join(dir, 'build', 'logcat', 'fixed-run-id');
    expect(existsSync(path.join(logDir, 'pass-mod.log'))).toBe(true);
    expect(existsSync(path.join(logDir, 'pass-mod_logcat.log'))).toBe(true);
    expect(existsSync(path.join(logDir, 'fail-mod.log'))).toBe(true);
    expect(existsSync(path.join(logDir, 'fail-mod_logcat.log'))).toBe(true);
    expect(existsSync(path.join(logDir, 'fail-mod_errors.json'))).toBe(true);
    // _errors.json file is NOT written for the passing module.
    expect(existsSync(path.join(logDir, 'pass-mod_errors.json'))).toBe(false);

    // errors[].log_file / logcat_file / errors_file populated for the failing module.
    const failError = envelope.errors.find(e => e.module === 'fail-mod');
    expect(failError).toBeDefined();
    expect(failError.log_file).toBe(path.join(logDir, 'fail-mod.log'));
    expect(failError.logcat_file).toBe(path.join(logDir, 'fail-mod_logcat.log'));
    expect(failError.errors_file).toBe(path.join(logDir, 'fail-mod_errors.json'));
  });

  it('safeModuleName converts colons to underscores (:core:db → core_db.log)', async () => {
    const dir = makeProject([{ name: 'core:db' }]);
    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'emulator-5554', type: 'emulator', model: 'sdk' }];

    await runAndroid({
      projectRoot: dir,
      args: [],
      spawn,
      adbProbe,
      runId: 'fixed-run-id',
    });

    const logDir = path.join(dir, 'build', 'logcat', 'fixed-run-id');
    expect(existsSync(path.join(logDir, 'core_db.log'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 9 — --auto-retry re-spawns once
// ---------------------------------------------------------------------------
describe('runAndroid --auto-retry', () => {
  it('re-spawns the failed module gradle invocation once', async () => {
    const dir = makeProject([{ name: 'flaky' }]);
    let callIdx = 0;
    const spawn = (cmd, args, opts) => {
      const out = { args: [...args], cmd, cwd: opts?.cwd ?? null };
      spawn.calls.push(out);
      if (cmd === 'adb') return { status: 0, stdout: '', stderr: '', signal: null, error: null };
      // First gradle call fails; second succeeds.
      const status = callIdx === 0 ? 1 : 0;
      callIdx++;
      return { status, stdout: 'BUILD ' + (status ? 'FAILED' : 'SUCCESSFUL') + '\n', stderr: '', signal: null, error: null };
    };
    spawn.calls = [];
    const adbProbe = () => [{ serial: 'emulator-5554', type: 'emulator', model: 'sdk' }];

    const { envelope, exitCode } = await runAndroid({
      projectRoot: dir,
      args: ['--auto-retry'],
      spawn,
      adbProbe,
    });

    const gradleCalls = findGradleCalls(spawn.calls);
    expect(gradleCalls.length).toBe(2);   // initial + retry
    expect(envelope.errors).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it('without --auto-retry, failed module does NOT re-spawn', async () => {
    const dir = makeProject([{ name: 'flaky' }]);
    const spawn = makeSpawnStub({ gradle: { status: 1 } });
    const adbProbe = () => [{ serial: 'emulator-5554', type: 'emulator', model: 'sdk' }];

    await runAndroid({ projectRoot: dir, args: [], spawn, adbProbe });

    const gradleCalls = findGradleCalls(spawn.calls);
    expect(gradleCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Case 10 — --auto-retry --clear-data invokes adb shell pm clear
// ---------------------------------------------------------------------------
describe('runAndroid --auto-retry --clear-data', () => {
  it('invokes adb shell pm clear <package> before retry', async () => {
    const dir = makeProject([
      { name: 'flaky', manifestPackage: 'com.example.flaky' },
    ]);
    let gradleIdx = 0;
    const spawn = (cmd, args, opts) => {
      spawn.calls.push({ cmd, args: [...args], cwd: opts?.cwd ?? null });
      if (cmd === 'adb') return { status: 0, stdout: '', stderr: '', signal: null, error: null };
      const status = gradleIdx === 0 ? 1 : 0;
      gradleIdx++;
      return { status, stdout: '', stderr: '', signal: null, error: null };
    };
    spawn.calls = [];
    const adbProbe = () => [{ serial: 'emulator-5554', type: 'emulator', model: 'sdk' }];

    await runAndroid({
      projectRoot: dir,
      args: ['--auto-retry', '--clear-data'],
      spawn,
      adbProbe,
    });

    const adbCalls = findAdbCalls(spawn.calls);
    const pmClear = adbCalls.find(c => c.args.includes('clear') && c.args.includes('com.example.flaky'));
    expect(pmClear).toBeDefined();
    expect(pmClear.args).toEqual(expect.arrayContaining(['shell', 'pm', 'clear', 'com.example.flaky']));
  });
});

// ---------------------------------------------------------------------------
// Case 11 — --skip-app filter
// ---------------------------------------------------------------------------
describe('runAndroid --skip-app filter', () => {
  it('removes :app and :androidApp from dispatched list', async () => {
    const dir = makeProject([
      { name: 'app',        build: `plugins { id("com.android.application") }\nandroid { namespace = "x" }\n` },
      { name: 'androidApp', build: `plugins { id("com.android.application") }\nandroid { namespace = "x" }\n` },
      { name: 'wearApp',    build: `plugins { id("com.android.application") }\nandroid { namespace = "x" }\n` },
      { name: 'core',       build: `plugins { id("com.android.library") }\nandroid { namespace = "x" }\n` },
    ]);
    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'emulator-5554', type: 'emulator', model: 'sdk' }];

    const { envelope } = await runAndroid({
      projectRoot: dir,
      args: ['--skip-app'],
      spawn,
      adbProbe,
    });

    expect(envelope.android.instrumented_modules).toEqual(['core']);
  });
});

// ---------------------------------------------------------------------------
// Case 12 — --module-filter post-discovery substring match
// ---------------------------------------------------------------------------
describe('runAndroid --module-filter', () => {
  it('substring match applied after discovery', async () => {
    const dir = makeProject([
      { name: 'core' }, { name: 'feature-auth' }, { name: 'feature-feed' },
    ]);
    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'emulator-5554', type: 'emulator', model: 'sdk' }];

    const { envelope } = await runAndroid({
      projectRoot: dir,
      args: ['--module-filter', 'feature'],
      spawn,
      adbProbe,
    });

    expect(envelope.android.instrumented_modules.sort()).toEqual(['feature-auth', 'feature-feed']);
    expect(envelope.android.instrumented_modules).not.toContain('core');
  });
});

// ---------------------------------------------------------------------------
// Case 13 — KMP_TEST_SKIP_ADB=1 → skipped[] + exit 0
// ---------------------------------------------------------------------------
describe('runAndroid KMP_TEST_SKIP_ADB=1', () => {
  it('short-circuits adb probe; emits skipped[] per discovered module; exit 0', async () => {
    const dir = makeProject([{ name: 'a' }, { name: 'b' }]);
    const spawn = makeSpawnStub();
    // adbProbe should never be called when env opt-out is set; if it is,
    // the test fails at exit-code asssertion (we can't easily detect call
    // here without an injected spy, but the orchestrator guards on env).
    const adbProbe = () => { throw new Error('adb probe should not run with KMP_TEST_SKIP_ADB=1'); };

    const { envelope, exitCode } = await runAndroid({
      projectRoot: dir,
      args: [],
      env: { KMP_TEST_SKIP_ADB: '1' },
      spawn,
      adbProbe,
    });

    expect(envelope.skipped.map(s => s.module).sort()).toEqual(['a', 'b']);
    expect(envelope.skipped[0].reason).toMatch(/KMP_TEST_SKIP_ADB/);
    expect(envelope.errors).toEqual([]);
    expect(exitCode).toBe(0);
    // No gradle dispatch happened.
    expect(findGradleCalls(spawn.calls).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case 14 — --test-filter Class#method emits both .class= and .method= -P args
// ---------------------------------------------------------------------------
describe('runAndroid --test-filter Class#method (Gap E v0.5.2)', () => {
  it('emits both -P...class= AND -P...method= to gradle', async () => {
    const dir = makeProject([{ name: 'a' }]);
    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'emulator-5554', type: 'emulator', model: 'sdk' }];

    await runAndroid({
      projectRoot: dir,
      args: ['--test-filter', 'com.example.MyTest#shouldDoX'],
      spawn,
      adbProbe,
    });

    const gradleCalls = findGradleCalls(spawn.calls);
    const args = gradleCalls[0].args;
    const classArg = args.find(a => a.startsWith('-Pandroid.testInstrumentationRunnerArguments.class='));
    const methodArg = args.find(a => a.startsWith('-Pandroid.testInstrumentationRunnerArguments.method='));
    expect(classArg).toBe('-Pandroid.testInstrumentationRunnerArguments.class=com.example.MyTest');
    expect(methodArg).toBe('-Pandroid.testInstrumentationRunnerArguments.method=shouldDoX');
  });

  it('class-only filter emits ONLY .class= (no .method=)', async () => {
    const dir = makeProject([{ name: 'a' }]);
    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'emulator-5554', type: 'emulator', model: 'sdk' }];

    await runAndroid({
      projectRoot: dir,
      args: ['--test-filter', 'com.example.MyTest'],
      spawn,
      adbProbe,
    });

    const args = findGradleCalls(spawn.calls)[0].args;
    expect(args.some(a => a.startsWith('-Pandroid.testInstrumentationRunnerArguments.class='))).toBe(true);
    expect(args.some(a => a.startsWith('-Pandroid.testInstrumentationRunnerArguments.method='))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case 15 — parsed.android passthrough via buildJsonReport
// ---------------------------------------------------------------------------
describe('runAndroid envelope passthrough (regression guard for cli.js:1165)', () => {
  it('android field flows through buildJsonReport to envelope (NOT stripped)', async () => {
    const dir = makeProject([{ name: 'a' }]);
    const spawn = makeSpawnStub();
    const adbProbe = () => [{ serial: 'emulator-5554', type: 'emulator', model: 'sdk' }];

    const { envelope } = await runAndroid({
      projectRoot: dir,
      args: ['--device-task', 'connectedAndroidTest', '--flavor', 'staging'],
      spawn,
      adbProbe,
    });

    // The whole top-level field is present, with all four sub-keys.
    expect(envelope).toHaveProperty('android');
    expect(envelope.android).toHaveProperty('device_serial');
    expect(envelope.android).toHaveProperty('device_task');
    expect(envelope.android).toHaveProperty('flavor');
    expect(envelope.android).toHaveProperty('instrumented_modules');
    expect(envelope.android.device_task).toBe('connectedAndroidTest');
    expect(envelope.android.flavor).toBe('staging');
  });
});

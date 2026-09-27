// SPDX-License-Identifier: MIT
// Windows-only e2e. Drives the REAL CLI binary (unmocked spawnSync) against
// a narrow child environment: PSExecutionPolicyPreference=Restricted (the
// Windows PowerShell 5.1 client default when nothing has explicitly
// configured a policy) and no PowerShell 7 directory on PATH, so
// pickWindowsShell() falls back to powershell.exe — the combination that
// silently blocks the wrapper before this fix.
//
// Pre-fix this produced a soft `no_summary` (exit 1, 0 tests, wrapper never
// ran). Post-fix the wrapper actually executes and reports the fake
// gradlew.bat's real failure as `module_failed`.
//
// Reduced child environment: keeps SystemDrive/ProgramData/LOCALAPPDATA/
// APPDATA/USERPROFILE alongside the OS-plumbing vars — dropping SystemDrive
// from a spawned process's env has been observed to make it write a stray
// %SystemDrive%\ProgramData\... tree wherever its cwd happens to be.
//
// Generous spawnSync timeout: on a CI runner (windows-latest) this test has
// been observed taking 30061ms and getting killed right at a previous
// 30_000ms timeout, returning empty stdout — a bare `JSON.parse('')` then
// failed with an unhelpful `SyntaxError: Unexpected end of JSON input`
// instead of a diagnosis. Reproduced consistently under 1s locally on
// multiple runs; the CI-only slowdown wasn't reproduced (most likely a cold
// Windows PowerShell 5.1 module-path cache on an ephemeral runner, or
// resource contention — not confirmed, not asserted as fact). The fix here
// is evidenced, not theorized: a timeout wide enough to absorb that
// CI-observed duration with real margin, plus a diagnosis that captures
// status/signal/error/duration/output instead of assuming a parseable
// envelope.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN_PATH = path.join(REPO_ROOT, 'bin', 'kmp-test.js');

// A minimal fake Gradle project whose gradlew always fails: a plain
// (non-KMP) module with a classic src/test/kotlin source set. Module
// discovery keys on that directory's presence; an empty
// `kotlin("multiplatform")` block without matching src/jvmTest/src/commonTest
// dirs is excluded as untestable (learned by first getting no_test_modules
// here instead of module_failed).
function makeFailingGradlewFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'kmp-execpolicy-e2e-'));
  writeFileSync(path.join(root, 'gradlew'), '#!/usr/bin/env bash\nexit 1\n');
  writeFileSync(path.join(root, 'gradlew.bat'), '@echo off\r\necho fake gradlew.bat %*\r\nexit /b 1\r\n');
  writeFileSync(path.join(root, 'settings.gradle.kts'), 'rootProject.name = "p"\ninclude(":core:domain")\n');
  mkdirSync(path.join(root, 'core', 'domain', 'src', 'test', 'kotlin'), { recursive: true });
  writeFileSync(path.join(root, 'core', 'domain', 'build.gradle.kts'), 'plugins {}\n');
  return root;
}

// OS-required plumbing + the 4 vars a reduced spawn environment must keep
// (see file header). Not identity-bearing — needed for node/powershell.exe
// themselves to start correctly.
const ENV_PASSTHROUGH_KEYS = [
  'SystemRoot', 'ComSpec', 'PATHEXT', 'windir', 'OS', 'PROCESSOR_ARCHITECTURE',
  'TEMP', 'TMP', 'JAVA_HOME', 'SystemDrive', 'ProgramData', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE',
];

// Wide enough to absorb the 30061ms duration observed on a windows-latest CI
// runner with real margin. it()'s own timeout matches so a future refactor
// that makes the spawn awaitable doesn't reintroduce a lower ceiling —
// spawnSync itself is synchronous and blocks the event loop, so today
// vitest's per-test timeout can't actually preempt it before this fires.
const SPAWN_TIMEOUT_MS = 180_000;

describe.skipIf(process.platform !== 'win32')('Windows execution-policy-blocked wrapper (Windows-only e2e)', () => {
  let fixtureRoot = null;
  afterEach(() => {
    if (fixtureRoot) { try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
    fixtureRoot = null;
  });

  it('runs the wrapper (module_failed) instead of the soft no_summary under Restricted + no pwsh 7 on PATH', () => {
    fixtureRoot = makeFailingGradlewFixture();

    // Filter PowerShell 7's directory out of PATH so pickWindowsShell()
    // falls back to powershell.exe — mirrors any host that never installed
    // pwsh 7 (`kmp-test doctor` would report "pwsh: powershell.exe only").
    const filteredPath = (process.env.PATH || '')
      .split(path.delimiter)
      .filter((p) => p && !/PowerShell\\7/i.test(p))
      .join(path.delimiter);

    const env = { PSExecutionPolicyPreference: 'Restricted', PATH: filteredPath };
    for (const k of ENV_PASSTHROUGH_KEYS) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }

    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [
      BIN_PATH, 'parallel', '--module-filter', ':core:domain', '--json', '--project-root', fixtureRoot,
    ], { encoding: 'utf8', cwd: fixtureRoot, env, timeout: SPAWN_TIMEOUT_MS });
    const elapsedMs = Date.now() - startedAt;

    // Diagnose the spawn itself before assuming its stdout is a parseable
    // envelope — a killed/errored child leaves stdout empty or partial, and
    // a bare JSON.parse on that gives an unhelpful "Unexpected end of JSON
    // input" with no way to tell a timeout from a crash from a real product
    // regression. (elapsedMs, result.error/signal/status) is exactly the
    // wrapper_no_output diagnostic this PR adds to the CLI itself — this
    // test should hold itself to the same standard.
    const stdoutTail = (result.stdout || '').slice(-1000);
    const stderrTail = (result.stderr || '').slice(-1000);
    const diagnosis = () =>
      `elapsed=${elapsedMs}ms status=${result.status} signal=${result.signal} ` +
      `error=${result.error ? result.error.code || result.error.message : null}\n` +
      `--- stdout tail ---\n${stdoutTail}\n--- stderr tail ---\n${stderrTail}`;
    if (result.error || result.status === null) {
      throw new Error(`spawnSync did not complete normally (${diagnosis()})`);
    }

    let envelope;
    try {
      envelope = JSON.parse((result.stdout || '').trim());
    } catch (err) {
      throw new Error(`stdout was not valid JSON: ${err.message} (${diagnosis()})`);
    }
    const codes = (envelope.errors || []).map((e) => e.code);
    expect(codes).not.toContain('no_summary');
    expect(codes).toContain('module_failed');
    expect(envelope.tests.total).toBeGreaterThan(0);
    expect(envelope.modules?.[0]?.name).toBe('core:domain');
  }, SPAWN_TIMEOUT_MS + 10_000);
});

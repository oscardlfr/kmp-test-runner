// SPDX-License-Identifier: MIT
// Windows-only e2e. Drives the REAL CLI binary (async spawn, never
// spawnSync) against a narrow child environment: no PowerShell 7 directory
// on PATH, so pickWindowsShell() falls back to Windows PowerShell 5.1 —
// whose default policy on a client Windows edition is Restricted when
// nothing has explicitly configured one — plus
// PSExecutionPolicyPreference=Restricted as a side-effect-free stand-in for
// that condition. The combination that silently blocked the wrapper before
// this fix.
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
// Generous timeout: on a CI runner (windows-latest) this test has been
// observed taking 30061ms, then later 58895ms and 63235ms across separate
// runs — a real, repeatedly-confirmed CI-only slowdown (most likely a cold
// Windows PowerShell 5.1 module-path cache on an ephemeral runner, or
// resource contention — not confirmed as the specific cause, but the
// duration itself is not in doubt). Reproduced consistently under 1s
// locally on multiple runs. A generous timeout absorbs that with real
// margin, and a diagnosis captures status/signal/error/duration/output
// instead of assuming a parseable envelope on a killed/errored child.
//
// Async spawn, never spawnSync: the 63235ms run above blocked this worker's
// event loop past Vitest's ~60s worker-RPC window, producing an unhandled
// `[vitest-worker]: Timeout calling "onTaskUpdate"` error that fails the
// whole run even with every assertion green (job 108663383918) — the same
// class of failure already fixed once in this codebase for the same reason
// (see agentic-eval-cli-integration.test.js's own runCli() and its header
// comment). spawnAsync below mirrors that
// established pattern exactly: resolves to
// {status, signal, error, stdout, stderr, elapsedMs}, with a manual kill()
// + timer standing in for spawnSync's own `timeout` option.

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
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

// Wide enough to absorb the slowest CI duration observed (63235ms) with real
// margin. it()'s own timeout (below) matches so vitest's per-test timeout
// doesn't impose a lower ceiling than this one.
const SPAWN_TIMEOUT_MS = 180_000;

// Async spawn, never spawnSync — see file header. Same external contract as
// the spawnSync-based version it replaces: resolves once the child settles,
// carrying everything the diagnosis below needs.
function spawnAsync(command, args, opts) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, opts);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill();
    }, opts.timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt,
        error: timedOut ? { code: 'ETIMEDOUT', message: `spawnAsync timed out after ${opts.timeout}ms` } : null,
      });
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: null, signal: null, stdout, stderr, elapsedMs: Date.now() - startedAt, error: err });
    });
  });
}

describe.skipIf(process.platform !== 'win32')('Windows execution-policy-blocked wrapper (Windows-only e2e)', () => {
  let fixtureRoot = null;
  afterEach(() => {
    if (fixtureRoot) { try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
    fixtureRoot = null;
  });

  it('runs the wrapper (module_failed) instead of the soft no_summary under Restricted + no pwsh 7 on PATH', async () => {
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

    const result = await spawnAsync(process.execPath, [
      BIN_PATH, 'parallel', '--module-filter', ':core:domain', '--json', '--project-root', fixtureRoot,
    ], { cwd: fixtureRoot, env, timeout: SPAWN_TIMEOUT_MS });

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
      `elapsed=${result.elapsedMs}ms status=${result.status} signal=${result.signal} ` +
      `error=${result.error ? result.error.code || result.error.message : null}\n` +
      `--- stdout tail ---\n${stdoutTail}\n--- stderr tail ---\n${stderrTail}`;
    if (result.error || result.status === null) {
      throw new Error(`spawn did not complete normally (${diagnosis()})`);
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

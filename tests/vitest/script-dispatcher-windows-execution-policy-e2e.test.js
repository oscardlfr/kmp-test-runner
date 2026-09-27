// SPDX-License-Identifier: MIT
// PR-A e2e (audit 2026-09-27, PLAN-B) — Windows-only. Drives the REAL CLI
// binary (unmocked spawnSync) against a narrow child environment shaped
// like the audited guest VM: PSExecutionPolicyPreference=Restricted (the
// Windows 11 client default) and no PowerShell 7 directory on PATH, so
// pickWindowsShell() falls back to powershell.exe exactly as it did there.
//
// Pre-fix this produced a soft `no_summary` (exit 1, 0 tests, wrapper never
// ran). Post-fix the wrapper actually executes and reports the fake
// gradlew.bat's real failure as `module_failed`. Fixture + env shape mirror
// the validated repro at
// C:\kmp-eval\scratch\evidence1-audit-20260927\repro\{proj,run-repro.ps1}.
//
// Reduced child environment: keeps SystemDrive/ProgramData/LOCALAPPDATA/
// USERPROFILE alongside the OS-plumbing vars — a prior run in this same
// audit dropped SystemDrive and a spawned process wrote a stray
// %SystemDrive%\ProgramData\... tree inside the repo.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN_PATH = path.join(REPO_ROOT, 'bin', 'kmp-test.js');

// Mirrors repro/proj/ exactly (C:\kmp-eval\scratch\evidence1-audit-20260927\
// repro\proj\) — a plain (non-KMP) module with a classic src/test/kotlin
// source set. Module discovery keys on that directory's presence; an empty
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

// OS-required plumbing + the 4 vars the audit's reduced-environment incident
// specifically calls out (see file header). Not identity-bearing — needed
// for node/powershell.exe themselves to start correctly.
const ENV_PASSTHROUGH_KEYS = [
  'SystemRoot', 'ComSpec', 'PATHEXT', 'windir', 'OS', 'PROCESSOR_ARCHITECTURE',
  'TEMP', 'TMP', 'JAVA_HOME', 'SystemDrive', 'ProgramData', 'LOCALAPPDATA', 'USERPROFILE',
];

describe.skipIf(process.platform !== 'win32')('PR-A e2e — Windows execution-policy-blocked wrapper (Windows-only)', () => {
  let fixtureRoot = null;
  afterEach(() => {
    if (fixtureRoot) { try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
    fixtureRoot = null;
  });

  it('runs the wrapper (module_failed) instead of the soft no_summary under Restricted + no pwsh 7 on PATH', () => {
    fixtureRoot = makeFailingGradlewFixture();

    // Filter PowerShell 7's directory out of PATH so pickWindowsShell()
    // falls back to powershell.exe — mirrors a guest image that never
    // installed pwsh 7 (the audited VM's `doctor` reported "pwsh:
    // powershell.exe only").
    const filteredPath = (process.env.PATH || '')
      .split(path.delimiter)
      .filter((p) => p && !/PowerShell\\7/i.test(p))
      .join(path.delimiter);

    const env = { PSExecutionPolicyPreference: 'Restricted', PATH: filteredPath };
    for (const k of ENV_PASSTHROUGH_KEYS) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }

    const result = spawnSync(process.execPath, [
      BIN_PATH, 'parallel', '--module-filter', ':core:domain', '--json', '--project-root', fixtureRoot,
    ], { encoding: 'utf8', cwd: fixtureRoot, env, timeout: 30_000 });

    const envelope = JSON.parse((result.stdout || '').trim());
    const codes = (envelope.errors || []).map((e) => e.code);
    expect(codes).not.toContain('no_summary');
    expect(codes).toContain('module_failed');
    expect(envelope.tests.total).toBeGreaterThan(0);
    expect(envelope.modules?.[0]?.name).toBe('core:domain');
  });
});

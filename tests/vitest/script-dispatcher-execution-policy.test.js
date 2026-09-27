// SPDX-License-Identifier: MIT
// PR-A (audit 2026-09-27, PLAN-B) — Windows wrapper spawn must pass
// -ExecutionPolicy Bypass. Pre-fix, script-dispatcher.js spawned
// `powershell.exe -NoLogo -NoProfile -File <ps1> ...` with no policy
// override. On a host whose PSExecutionPolicyPreference is Restricted (the
// Windows 11 client default, inherited verbatim by a narrow/guest process
// environment that never ran `Set-ExecutionPolicy`), that spawn is refused
// by PowerShell before the ps1 body ever executes. kmp-test then falls
// through to the legacy parser against empty stdout and reports a soft
// `no_summary` (exit 1, 0 tests) in under a second — indistinguishable from
// "ran fine but produced nothing parseable". Reproduced live against this
// worktree via repro/run-repro.ps1 + repro/verify-fix.ps1
// (C:\kmp-eval\scratch\evidence1-audit-20260927\repro\).
//
// isWin is a dispatchScriptCommand parameter (not read from process.platform
// internally past the default), so these tests simulate win32 argv assembly
// on any host OS — no need to physically run on Windows to prove the argv
// shape is right. The Windows-only real end-to-end repro lives in
// script-dispatcher-windows-execution-policy-e2e.test.js
// (it.skipIf(process.platform !== 'win32')).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { rmSync, existsSync } from 'node:fs';

const spawnMock = vi.hoisted(() => vi.fn(() => ({ status: 0, stdout: '', stderr: '', error: null })));
vi.mock('node:child_process', () => ({ spawnSync: spawnMock }));

import { dispatchScriptCommand } from '../../lib/runners/script-dispatcher.js';
import { COMMANDS } from '../../lib/cli.js';
import { makeFixtureProject } from './_parity-helpers.js';

function baseCtx(overrides = {}) {
  return {
    sub: 'parallel',
    cmd: COMMANDS.parallel,
    cleanedArgs: [],
    jsonMode: true,
    dryRun: false,
    force: false,
    ignoreJdk: false,
    javaHomeOverride: null,
    noJdkAutoselect: false,
    testFilterPattern: null,
    isolatedFlags: { enabled: false, cacheDir: null, noLock: false },
    isWin: true,
    scriptsDir: 'C:\\fake\\scripts',
    cleanupConfig: null,
    ...overrides,
  };
}

describe('PR-A — Windows wrapper spawn includes -ExecutionPolicy Bypass', () => {
  let fixtureRoot = null;
  let stdoutSpy = null;

  afterEach(() => {
    spawnMock.mockClear();
    if (stdoutSpy) { stdoutSpy.mockRestore(); stdoutSpy = null; }
    if (fixtureRoot && existsSync(fixtureRoot)) {
      try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    fixtureRoot = null;
  });

  it('dry-run plan.spawn_args carries -ExecutionPolicy Bypass on simulated win32', () => {
    fixtureRoot = makeFixtureProject();
    const chunks = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { chunks.push(String(c)); return true; });
    const exitCode = dispatchScriptCommand(baseCtx({ projectRoot: fixtureRoot, dryRun: true }));
    stdoutSpy.mockRestore();
    stdoutSpy = null;

    expect(exitCode).toBe(0);
    const envelope = JSON.parse(chunks.join('').trim());
    expect(envelope.plan.spawn_args.slice(0, 5)).toEqual([
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    ]);
    // dry-run never spawns the wrapper script itself — this is purely an
    // argv-assembly assertion. (pickWindowsShell() DOES still probe `pwsh`
    // via spawnSync before the dry-run short-circuit — a pre-existing,
    // documented, deliberately-unfixed quirk unrelated to PR-A; see
    // BACKLOG.md PR-18. Assert on absence of the wrapper spawn specifically,
    // not on zero spawnSync calls overall.)
    expect(spawnMock.mock.calls.some(([, args]) => Array.isArray(args) && args.includes('-File'))).toBe(false);
  });

  for (const sub of ['parallel', 'changed', 'android', 'benchmark', 'coverage']) {
    it(`real (non-dry-run) spawn for '${sub}' passes -ExecutionPolicy Bypass to spawnSync on simulated win32`, () => {
      fixtureRoot = makeFixtureProject();
      stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      dispatchScriptCommand(baseCtx({ sub, cmd: COMMANDS[sub], projectRoot: fixtureRoot }));

      // pickWindowsShell() probes 'pwsh' through the same mocked spawnSync
      // before the real dispatch spawn, so don't assume position/count —
      // find the call that actually invokes the ps1 wrapper.
      const dispatchCall = spawnMock.mock.calls.find(([, args]) => Array.isArray(args) && args.includes('-File'));
      expect(dispatchCall).toBeTruthy();
      const [, spawnArgs] = dispatchCall;
      expect(spawnArgs.slice(0, 5)).toEqual([
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      ]);
    });
  }
});

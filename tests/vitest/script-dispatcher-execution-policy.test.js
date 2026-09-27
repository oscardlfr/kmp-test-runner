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
//
// The second describe block below covers the companion diagnostic: when the
// wrapper is blocked before it runs (or fails to start for any other
// reason), the dispatcher must report a discriminable `wrapper_no_output`
// environment error (exit 3) instead of silently falling through to the
// unrelated, genuinely-soft `no_summary` fallback (wrapper ran to
// completion but produced nothing parseable).

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

// Captured live 2026-09-27 against this worktree's real wrapper script
// (scripts/ps1/run-parallel-coverage-suite.ps1) under
// PSExecutionPolicyPreference=Restricted, Windows PowerShell 5.1 (not pwsh
// 7), Spanish OS locale — see repro/verify-fix.ps1 in
// C:\kmp-eval\scratch\evidence1-audit-20260927\repro\. Deliberately used
// instead of a guessed translation: this locale's CategoryInfo names
// `ParentContainsErrorRecordException`, NOT `PSSecurityException` as the
// well-known English message does — the detector must not depend on that
// specific token.
const SPANISH_EXECUTION_POLICY_STDERR =
  'No se puede cargar el archivo C:\\kmp-eval\\windows-wrapper-execution-policy\\scripts\\ps1\\run-parallel-coverage-suite.ps1 \n' +
  'porque la ejecución de scripts está deshabilitada en este sistema. Para obtener más información, consulta el tema \n' +
  'about_Execution_Policies en https:/go.microsoft.com/fwlink/?LinkID=135170.\n' +
  '    + CategoryInfo          : SecurityError: (:) [], ParentContainsErrorRecordException\n' +
  '    + FullyQualifiedErrorId : UnauthorizedAccess\n';

// The well-known English-locale PowerShell execution-policy message (widely
// documented) — CategoryInfo names PSSecurityException here.
const ENGLISH_EXECUTION_POLICY_STDERR =
  'File C:\\proj\\scripts\\ps1\\run-parallel-coverage-suite.ps1 cannot be loaded because running scripts is disabled ' +
  'on this system. For more information, see about_Execution_Policies at https:/go.microsoft.com/fwlink/?LinkID=135170.\n' +
  '    + CategoryInfo          : SecurityError: (:) [], PSSecurityException\n' +
  '    + FullyQualifiedErrorId : UnauthorizedAccess\n';

describe('PR-A — wrapper_no_output diagnostic (blocked wrapper vs. soft no_summary)', () => {
  let fixtureRoot = null;
  let stdoutSpy = null;

  afterEach(() => {
    spawnMock.mockClear();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => ({ status: 0, stdout: '', stderr: '', error: null }));
    if (stdoutSpy) { stdoutSpy.mockRestore(); stdoutSpy = null; }
    if (fixtureRoot && existsSync(fixtureRoot)) {
      try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    fixtureRoot = null;
  });

  // Drives dispatchScriptCommand with a crafted result for the WRAPPER spawn
  // specifically (pickWindowsShell's own probe call is left on the default
  // status:0 mock so shell selection doesn't interfere).
  function runWithWrapperResult(wrapperResult, ctxOverrides = {}) {
    fixtureRoot = makeFixtureProject();
    spawnMock.mockImplementation((cmd, args) => {
      if (Array.isArray(args) && args.includes('-File')) return wrapperResult;
      return { status: 0, stdout: '', stderr: '', error: null };
    });
    const outChunks = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { outChunks.push(String(c)); return true; });
    const exitCode = dispatchScriptCommand(baseCtx({ projectRoot: fixtureRoot, ...ctxOverrides }));
    stdoutSpy.mockRestore();
    stdoutSpy = null;
    const joined = outChunks.join('').trim();
    let envelope = null;
    if (joined) { try { envelope = JSON.parse(joined); } catch { /* leave null */ } }
    return { exitCode, envelope };
  }

  it('English execution-policy stderr + empty stdout + status 1 → wrapper_no_output, exit 3', () => {
    const { exitCode, envelope } = runWithWrapperResult({
      status: 1, stdout: '', stderr: ENGLISH_EXECUTION_POLICY_STDERR, error: null,
    });
    expect(exitCode).toBe(3);
    expect(envelope.errors[0].code).toBe('wrapper_no_output');
    expect(envelope.errors[0].message).toContain('PowerShell execution policy blocked the wrapper script');
    expect(envelope.errors[0].message).toContain('about_Execution_Policies');
  });

  it('Spanish execution-policy stderr (captured live) + empty stdout + status 1 → wrapper_no_output, exit 3', () => {
    const { exitCode, envelope } = runWithWrapperResult({
      status: 1, stdout: '', stderr: SPANISH_EXECUTION_POLICY_STDERR, error: null,
    });
    expect(exitCode).toBe(3);
    expect(envelope.errors[0].code).toBe('wrapper_no_output');
    // This locale lacks the PSSecurityException token entirely — the hint
    // must still fire on the other two language-independent tokens.
    expect(envelope.errors[0].message).toContain('PowerShell execution policy blocked the wrapper script');
  });

  it('stderr with none of the 3 tokens still gets wrapper_no_output but WITHOUT the execution-policy hint', () => {
    const { exitCode, envelope } = runWithWrapperResult({
      status: 1, stdout: '', stderr: 'permission denied\n', error: null,
    });
    expect(exitCode).toBe(3);
    expect(envelope.errors[0].code).toBe('wrapper_no_output');
    expect(envelope.errors[0].message).not.toContain('execution policy');
    expect(envelope.errors[0].message).toContain('permission denied');
  });

  it('preservation: status 0 + empty stdout stays the soft no_summary fallback, exit 0', () => {
    const { exitCode, envelope } = runWithWrapperResult({ status: 0, stdout: '', stderr: '', error: null });
    expect(exitCode).toBe(0);
    expect(envelope.errors[0].code).toBe('no_summary');
  });

  it('preservation: status 1 + NON-empty stdout (real legacy output) does not trigger wrapper_no_output', () => {
    const { exitCode, envelope } = runWithWrapperResult({
      status: 1,
      stdout: 'Tests: 3 total | 2 passed | 1 failed | 0 skipped\nBUILD FAILED\n',
      stderr: '',
      error: null,
    });
    expect(exitCode).not.toBe(3);
    expect((envelope.errors || []).some((e) => e.code === 'wrapper_no_output')).toBe(false);
  });

  // Regression guard for a design pitfall caught while implementing this
  // check: in text mode (jsonMode:false) spawnOpts uses stdio:'inherit', so
  // capturedStdout/capturedStderr are NEVER populated by dispatchScriptCommand
  // regardless of how much the wrapper actually printed (output streams
  // straight to the real, uninherited-by-Node terminal). An earlier draft of
  // this check applied unconditionally to both modes, which would have
  // misclassified EVERY non-zero-exit text-mode run as wrapper_no_output —
  // including a genuine test failure whose real output the user already
  // watched scroll by. The check must stay gated on jsonMode.
  it('text mode (jsonMode:false) never triggers wrapper_no_output, even on a non-zero exit', () => {
    const { exitCode, envelope } = runWithWrapperResult(
      { status: 1, stdout: 'irrelevant — stdio is inherited, never captured', stderr: '', error: null },
      { jsonMode: false },
    );
    // Text mode never emits an envelope (nothing printed via emitJson) — the
    // dispatcher just returns the raw script exit code.
    expect(envelope).toBeNull();
    expect(exitCode).toBe(1);
  });
});

// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const modulePath = fileURLToPath(new URL('../../docs/audits/evidence1-validation-ops.psm1', import.meta.url));
const quote = value => `'${value.replaceAll("'", "''")}'`;
const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const idle = 'setInterval(()=>{},1000)';
const grandchild = `const {spawn}=require('node:child_process');const g=spawn(process.execPath,['-e',${JSON.stringify(idle)}],{stdio:'ignore'});console.log(JSON.stringify({child:process.pid,grandchild:g.pid}));${idle}`;
const tree = exit => `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','pipe','ignore']});c.stdout.once('data',b=>{console.log(JSON.stringify({parent:process.pid,...JSON.parse(b)}));${exit ? 'setTimeout(()=>process.exit(7),150)' : ''}});${idle}`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const shellEnv = shell => shell === 'powershell.exe'
  ? { ...process.env, PSModulePath: resolve(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') }
  : process.env;
const scriptArgs = body => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(
  `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'\nImport-Module ${quote(modulePath)} -Force -DisableNameChecking\n${body}`,
  'utf16le').toString('base64')];
async function ps(body, shell = 'powershell.exe') {
  const result = await exec(shell, scriptArgs(body), {
    encoding: 'utf8', timeout: 40_000, windowsHide: true, env: shellEnv(shell),
  }).catch(error => { throw new Error(`PowerShell fixture failed (${error.code}): ${error.stderr || ''}`); });
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}
function invocation(dir, code, seconds) {
  return `${quote(process.execPath)} @('-e',${quote(code)}) ${quote(dir)} ${quote(resolve(dir, 'stdout.json'))} ${quote(resolve(dir, 'stderr.txt'))} ${seconds}`;
}
const waitReady = dir => `
  $deadline=[datetime]::UtcNow.AddSeconds(10)
  while (-not (Test-Path -LiteralPath ${quote(resolve(dir, 'stdout.json'))}) -or
      (Get-Item -LiteralPath ${quote(resolve(dir, 'stdout.json'))}).Length -eq 0) {
    if ($op.Task.IsCompleted -or [datetime]::UtcNow -gt $deadline) {throw 'fixture_not_ready'}
    Start-Sleep -Milliseconds 20
  }
`;
function checkStopped(dir) {
  const ids = JSON.parse(readFileSync(resolve(dir, 'stdout.json'), 'utf8'));
  for (const id of Object.values(ids)) expect(alive(id)).toBe(false);
}

describe.skipIf(process.platform !== 'win32')('async Windows validation job', { timeout: 50_000 }, () => {
  it.each(['powershell.exe', 'pwsh'])('completes and tears down descendants with %s while the caller can poll', async shell => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-async-complete-'));
    try {
      const result = await ps(`
        $op=Start-E1OwnedProcess ${invocation(dir, tree(true), 10)}
        $polls=0
        while (-not $op.Task.IsCompleted) { $polls++; Start-Sleep -Milliseconds 10 }
        $r=Wait-E1OwnedProcess $op
        Stop-E1OwnedProcess $op
        $again=Wait-E1OwnedProcess $op
        @{result=$r;polls=$polls;same=[object]::ReferenceEquals($r,$again)} | ConvertTo-Json -Compress
      `, shell);
      expect(result.result).toMatchObject({ ExitCode: 7, TimedOut: false, Cancelled: false, CleanupOk: true });
      expect(result.result.WallSeconds).toBeGreaterThan(0);
      expect(result.polls).toBeGreaterThan(0);
      expect(result.same).toBe(true);
      checkStopped(dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('times out and kills the owned child and grandchild', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-async-timeout-'));
    try {
      const result = await ps(`$op=Start-E1OwnedProcess ${invocation(dir, tree(false), 2)}
        Wait-E1OwnedProcess $op | ConvertTo-Json -Compress`);
      expect(result).toMatchObject({ ExitCode: 124, TimedOut: true, Cancelled: false, CleanupOk: true });
      expect(result.WallSeconds).toBeGreaterThanOrEqual(1.9);
      expect(result.WallSeconds).toBeLessThan(6);
      checkStopped(dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('cancels idempotently from the caller and leaves an unrelated Node process alive', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-async-cancel-'));
    const unrelated = spawn(process.execPath, ['-e', idle], { stdio: 'ignore', windowsHide: true });
    try {
      const result = await ps(`$op=Start-E1OwnedProcess ${invocation(dir, tree(false), 30)}
        ${waitReady(dir)}
        Stop-E1OwnedProcess $op
        Stop-E1OwnedProcess $op
        $r=Wait-E1OwnedProcess $op
        Stop-E1OwnedProcess $op
        $r | ConvertTo-Json -Compress`);
      expect(result).toMatchObject({ ExitCode: 130, TimedOut: false, Cancelled: true, CleanupOk: true });
      expect(result.WallSeconds).toBeLessThan(10);
      checkStopped(dir);
      expect(alive(unrelated.pid)).toBe(true);
    } finally {
      unrelated.kill();
      await new Promise(resolve => unrelated.once('exit', resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures the startup environment and preserves the synchronous result shape', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-async-env-'));
    const syncDir = resolve(dir, 'sync');
    try {
      const code = `console.log(process.env.E1_ASYNC_SENTINEL);process.exit(0)`;
      const result = await ps(`
        $env:E1_ASYNC_SENTINEL='captured'
        $op=Start-E1OwnedProcess ${invocation(dir, code, 5)}
        $env:E1_ASYNC_SENTINEL='restored'
        $r=Wait-E1OwnedProcess $op
        New-Item -ItemType Directory -Path ${quote(syncDir)} | Out-Null
        $sync=Invoke-E1OwnedProcess ${invocation(syncDir, 'process.exit(3)', 5)}
        @{async=$r;sync=$sync;restored=$env:E1_ASYNC_SENTINEL} | ConvertTo-Json -Compress
      `);
      expect(readFileSync(resolve(dir, 'stdout.json'), 'utf8').trim()).toBe('captured');
      expect(result.async).toMatchObject({ ExitCode: 0, CleanupOk: true, Cancelled: false });
      expect(result.restored).toBe('restored');
      expect(Object.keys(result.sync).sort()).toEqual(['CleanupOk', 'ExitCode', 'TimedOut', 'WallSeconds']);
      expect(result.sync).toMatchObject({ ExitCode: 3, TimedOut: false, CleanupOk: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('tolerates concurrent C# cancellation and cancellation after completion', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-async-race-'));
    try {
      const result = await ps(`
        Add-Type -TypeDefinition @'
using System;
using System.Threading;
using System.Threading.Tasks;
public static class AsyncCancelFixture {
  public static void Race(object operation) {
    var cancel = operation.GetType().GetMethod("Cancel");
    Parallel.For(0, 64, i => {
      Thread.Sleep((i % 8) * 10);
      cancel.Invoke(operation, null);
    });
  }
}
'@
        $op=Start-E1OwnedProcess ${invocation(dir, tree(false), 30)}
        ${waitReady(dir)}
        [AsyncCancelFixture]::Race($op)
        $r=Wait-E1OwnedProcess $op
        [AsyncCancelFixture]::Race($op)
        $r | ConvertTo-Json -Compress
      `);
      expect(result).toMatchObject({ ExitCode: 130, TimedOut: false, Cancelled: true, CleanupOk: true });
      checkStopped(dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('surfaces startup failure through Wait and permits cancellation after failure', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-async-fault-'));
    try {
      const result = await ps(`
        $op=Start-E1OwnedProcess ${quote(resolve(dir, 'absent.exe'))} @() ${quote(dir)} ${quote(resolve(dir, 'out'))} ${quote(resolve(dir, 'err'))} 5
        $caught=$false
        try { $null=Wait-E1OwnedProcess $op } catch { $caught=$true }
        Stop-E1OwnedProcess $op
        @{caught=$caught;faulted=$op.Task.IsFaulted} | ConvertTo-Json -Compress
      `);
      expect(result).toEqual({ caught: true, faulted: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('kills the contained tree when its PowerShell owner dies', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-async-owner-'));
    let owner;
    try {
      owner = spawn('powershell.exe', scriptArgs(`
        $op=Start-E1OwnedProcess ${invocation(dir, tree(false), 30)}
        Start-Sleep -Seconds 35
      `), { stdio: 'ignore', windowsHide: true, env: shellEnv('powershell.exe') });
      const output = resolve(dir, 'stdout.json');
      const deadline = Date.now() + 15_000;
      while (!existsSync(output) || readFileSync(output, 'utf8').trim() === '') {
        if (owner.exitCode !== null || Date.now() > deadline) throw new Error('owner fixture did not start');
        await sleep(25);
      }
      const ids = JSON.parse(readFileSync(output, 'utf8'));
      expect(Object.values(ids).every(alive)).toBe(true);
      const exited = new Promise(resolve => owner.once('exit', resolve));
      owner.kill();
      await exited;
      const stoppedBy = Date.now() + 5_000;
      while (Object.values(ids).some(alive) && Date.now() < stoppedBy) await sleep(25);
      checkStopped(dir);
    } finally {
      if (owner && owner.exitCode === null && owner.signalCode === null) owner.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
const tree = exit => `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','pipe','ignore']});c.stdout.once('data',b=>{console.log(JSON.stringify({parent:process.pid,...JSON.parse(b)}));${exit ? "setInterval(()=>{if(require('node:fs').existsSync('release'))process.exit(7)},20)" : ''}});${idle}`;
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
const captureTree = dir => `
  $deadline=[datetime]::UtcNow.AddSeconds(10)
  $fixture=''
  while (-not "$fixture".EndsWith([string][char]10)) {
    if ([datetime]::UtcNow -gt $deadline) {throw 'fixture_not_ready'}
    if (Test-Path -LiteralPath ${quote(resolve(dir, 'stdout.json'))}) {
      $fixture=[string](Get-Content -LiteralPath ${quote(resolve(dir, 'stdout.json'))} -Raw)
    }
    if ("$fixture".EndsWith([string][char]10)) {break}
    Start-Sleep -Milliseconds 20
  }
  $ids=$fixture | ConvertFrom-Json
  foreach ($role in @('parent','child','grandchild')) {
    $p=[Diagnostics.Process]::GetProcessById($ids.$role)
    $tracked+=@{role=$role;process=$p}
    # Retain the native handle before termination; a later PID lookup can see a different process.
    $null=$p.Handle
    $tracked[-1].id=$p.Id
    $tracked[-1].created=$p.StartTime.ToUniversalTime().Ticks.ToString()
    $tracked[-1].executable=$p.MainModule.FileName
    if ($p.HasExited) {throw 'fixture_exited_before_observation'}
  }
`;
const treeStates = waitMs => `@(
  foreach ($item in $tracked) {
    @{role=$item.role;id=$item.id;created=$item.created;executable=$item.executable;
      stopped=$item.process.WaitForExit(${waitMs})}
  }
)`;
const withTree = (dir, code, seconds, body) => `
  $tracked=@()
  $op=$null
  try {
    $op=Start-E1OwnedProcess ${invocation(dir, code, seconds)}
    ${captureTree(dir)}
    if ($op.Task.IsCompleted) {throw 'fixture_completed_before_observation'}
    ${body}
    @{result=$r;processes=${treeStates(0)};before=$before;polls=$polls;same=$same} | ConvertTo-Json -Depth 5 -Compress
  } finally {
    if ($null -ne $op -and -not $op.Task.IsCompleted) {
      Stop-E1OwnedProcess $op
      $null=Wait-E1OwnedProcess $op
    }
    foreach ($item in $tracked) {$item.process.Dispose()}
  }
`;
function checkStopped(dir, states) {
  const ids = JSON.parse(readFileSync(resolve(dir, 'stdout.json'), 'utf8'));
  expect(states.map(state => state.role).sort()).toEqual(['child', 'grandchild', 'parent']);
  expect(new Set(states.map(state => state.id)).size).toBe(3);
  for (const state of states) {
    expect(state.id).toBe(ids[state.role]);
    expect(state.created).toMatch(/^\d+$/);
    expect(resolve(state.executable).toLowerCase()).toBe(resolve(process.execPath).toLowerCase());
    expect(state.stopped, JSON.stringify(state)).toBe(true);
  }
}
const removeFixture = dir => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

describe.skipIf(process.platform !== 'win32')('async Windows validation job', { timeout: 50_000 }, () => {
  it('observes the same live identities before cancellation and rejects them as stopped', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-async-identity-'));
    try {
      const result = await ps(withTree(dir, tree(false), 30, `
        $before=${treeStates(0)}
        Stop-E1OwnedProcess $op
        $r=Wait-E1OwnedProcess $op
      `));
      expect(result.result).toMatchObject({ ExitCode: 130, TimedOut: false, Cancelled: true, CleanupOk: true });
      expect(result.before).toHaveLength(3);
      expect(result.before.every(state => state.stopped === false)).toBe(true);
      expect(() => checkStopped(dir, result.before)).toThrow();
      expect(result.processes).toEqual(result.before.map(state => ({ ...state, stopped: true })));
      checkStopped(dir, result.processes);
    } finally { removeFixture(dir); }
  });

  it.each(['powershell.exe', 'pwsh'])('completes and tears down descendants with %s while the caller can poll', async shell => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-async-complete-'));
    try {
      const result = await ps(withTree(dir, tree(true), 10, `
        $polls=1
        if ($op.Task.IsCompleted) {throw 'fixture_completed_before_release'}
        [IO.File]::WriteAllText(${quote(resolve(dir, 'release'))},'go')
        while (-not $op.Task.IsCompleted) { $polls++; Start-Sleep -Milliseconds 10 }
        $r=Wait-E1OwnedProcess $op
        Stop-E1OwnedProcess $op
        $again=Wait-E1OwnedProcess $op
        $same=[object]::ReferenceEquals($r,$again)
      `), shell);
      expect(result.result).toMatchObject({ ExitCode: 7, TimedOut: false, Cancelled: false, CleanupOk: true });
      expect(result.result.WallSeconds).toBeGreaterThan(0);
      expect(result.polls).toBeGreaterThan(0);
      expect(result.same).toBe(true);
      checkStopped(dir, result.processes);
    } finally { removeFixture(dir); }
  });

  it('times out and kills the owned child and grandchild', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-async-timeout-'));
    try {
      const result = await ps(withTree(dir, tree(false), 2, '$r=Wait-E1OwnedProcess $op'));
      expect(result.result).toMatchObject({ ExitCode: 124, TimedOut: true, Cancelled: false, CleanupOk: true });
      expect(result.result.WallSeconds).toBeGreaterThanOrEqual(1.9);
      expect(result.result.WallSeconds).toBeLessThan(6);
      checkStopped(dir, result.processes);
    } finally { removeFixture(dir); }
  });

  it('cancels idempotently from the caller and leaves an unrelated Node process alive', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-async-cancel-'));
    const unrelated = spawn(process.execPath, ['-e', idle], { stdio: 'ignore', windowsHide: true });
    const unrelatedClosed = new Promise(resolve => unrelated.once('close', resolve));
    try {
      const result = await ps(withTree(dir, tree(false), 30, `
        Stop-E1OwnedProcess $op
        Stop-E1OwnedProcess $op
        $r=Wait-E1OwnedProcess $op
        Stop-E1OwnedProcess $op
      `));
      expect(result.result).toMatchObject({ ExitCode: 130, TimedOut: false, Cancelled: true, CleanupOk: true });
      expect(result.result.WallSeconds).toBeLessThan(10);
      checkStopped(dir, result.processes);
      expect(alive(unrelated.pid)).toBe(true);
    } finally {
      unrelated.kill();
      await unrelatedClosed;
      removeFixture(dir);
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
      expect(Object.keys(result.async).sort()).toEqual(['Cancelled', 'CleanupOk', 'ExitCode', 'TimedOut', 'WallSeconds']);
      expect(result.restored).toBe('restored');
      expect(Object.keys(result.sync).sort()).toEqual(['CleanupOk', 'ExitCode', 'TimedOut', 'WallSeconds']);
      expect(result.sync).toMatchObject({ ExitCode: 3, TimedOut: false, CleanupOk: true });
    } finally { removeFixture(dir); }
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
        ${withTree(dir, tree(false), 30, `
        [AsyncCancelFixture]::Race($op)
        $r=Wait-E1OwnedProcess $op
        [AsyncCancelFixture]::Race($op)
        `)}
      `);
      expect(result.result).toMatchObject({ ExitCode: 130, TimedOut: false, Cancelled: true, CleanupOk: true });
      checkStopped(dir, result.processes);
    } finally { removeFixture(dir); }
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
    } finally { removeFixture(dir); }
  });

  it('kills the contained tree when its PowerShell owner dies', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-async-owner-'));
    let owner;
    let ownerClosed;
    let observer;
    let observation;
    let failure;
    try {
      owner = spawn('powershell.exe', scriptArgs(`
        $op=Start-E1OwnedProcess ${invocation(dir, tree(false), 30)}
        Start-Sleep -Seconds 35
      `), { stdio: 'ignore', windowsHide: true, env: shellEnv('powershell.exe') });
      ownerClosed = new Promise(resolve => owner.once('close', resolve));
      const ready = resolve(dir, 'observer-ready');
      // The observer is outside the owner's job and keeps the original process identities alive.
      observer = ps(`
        $tracked=@()
        $ownerProcess=$null
        try {
          $ownerProcess=[Diagnostics.Process]::GetProcessById(${owner.pid})
          $null=$ownerProcess.Handle
          ${captureTree(dir)}
          [IO.File]::WriteAllText(${quote(ready)},'ready')
          if (-not $ownerProcess.WaitForExit(20000)) {throw 'owner_did_not_exit'}
          $deadline=[datetime]::UtcNow.AddSeconds(5)
          @{processes=${treeStates('[Math]::Max(0,[int]($deadline-[datetime]::UtcNow).TotalMilliseconds)')}} | ConvertTo-Json -Depth 5 -Compress
        } finally {
          foreach ($item in $tracked) {$item.process.Dispose()}
          if ($null -ne $ownerProcess) {$ownerProcess.Dispose()}
        }
      `).then(value => (observation = { value }), error => (observation = { error }));
      const deadline = Date.now() + 20_000;
      while (!existsSync(ready)) {
        if (observation?.error) throw observation.error;
        if (owner.exitCode !== null || owner.signalCode !== null || Date.now() > deadline) throw new Error('owner fixture did not start');
        await sleep(25);
      }
      owner.kill();
      await ownerClosed;
      const observed = await observer;
      if (observed.error) throw observed.error;
      checkStopped(dir, observed.value.processes);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (owner && owner.exitCode === null && owner.signalCode === null) owner.kill();
      if (ownerClosed) await ownerClosed;
      if (observer) await observer;
      try { removeFixture(dir); }
      catch (cleanupError) { throw new AggregateError([failure, cleanupError].filter(Boolean), 'owner fixture teardown'); }
    }
  });
});

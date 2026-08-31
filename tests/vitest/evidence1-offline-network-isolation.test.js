import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const quote = s => `'${s.replaceAll("'", "''")}'`;
const exec = promisify(execFile);

async function exercise(mode = 'normal') {
  const parent = 'C:/kmp-eval/scratch';
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(resolve(parent, 'e1-nic-fixture-'));
  try {
    const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
      Import-Module ${quote(resolve(root, 'docs/audits/evidence1-validation-ops.psm1'))} -DisableNameChecking
      Import-Module ${quote(resolve(root, 'docs/audits/evidence1-gradle-offline-probe.psm1'))} -DisableNameChecking
      $r=& (Get-Module evidence1-gradle-offline-probe) {
        param($journal,$mode)
        $script:nics=@([pscustomobject]@{Id='nic-a';VMId=[guid]'00000000-0000-0000-0000-000000000001';SwitchId=[guid]'00000000-0000-0000-0000-000000000002';MacAddress='001122334455';Connected=$true})
        $script:events=@();$script:calls=0;$script:quietCalls=0
        function Get-VMNetworkAdapter {param($VM) $script:nics}
        function Get-VMSwitch {param($Id) [pscustomobject]@{Id=$Id;Name='PRIVATE_SWITCH'}}
        function Get-VMAssignableDevice {param($VMName) @()}
        function Disconnect-VMNetworkAdapter {param($VMNetworkAdapter,[switch]$Confirm)
          $script:events+='disconnect';$VMNetworkAdapter.SwitchId=[guid]::Empty;$VMNetworkAdapter.Connected=$false
          if($mode -eq 'disconnect-throws'){throw 'PRIVATE_DISCONNECT_ERROR'}
        }
        function Connect-VMNetworkAdapter {param($VMNetworkAdapter,$VMSwitch,[switch]$Confirm)
          $script:events+='connect'
          if($mode -eq 'restore-throws'){throw 'PRIVATE_CONNECT_ERROR'}
          $VMNetworkAdapter.SwitchId=$VMSwitch.Id;$VMNetworkAdapter.Connected=$true
        }
        $vm=[pscustomobject]@{Id=[guid]'00000000-0000-0000-0000-000000000001';Name='Evidence1-Runner'}
        $action={param($monitor)
          $script:calls++;$script:events+='execute'; & $monitor
          if($mode -eq 'transport-fails'){throw 'PRIVATE_TRANSPORT_ERROR'}
          if($mode -eq 'topology-drift'){$script:nics[0].MacAddress='AABBCCDDEEFF'}
          return @{state='failed';failure_code='offline_cache_miss'}
        }
        $quiet={
          $script:quietCalls++
          if($mode -eq 'busy-before' -or ($mode -eq 'busy-after' -and $script:quietCalls -gt 1)){throw 'cache_busy'}
        }
        if($mode -eq 'existing'){[IO.File]::WriteAllText($journal,'PRESERVED_ATTEMPT')}
        $result=Invoke-E1OfflineDisconnected $vm $journal $action $quiet
        @{result=$result;calls=$script:calls;events=$script:events;connected=$script:nics[0].Connected;
          journal_exists=(Test-Path -LiteralPath $journal)}
      } ${quote(resolve(dir, 'network.json'))} ${quote(mode)}
      $r | ConvertTo-Json -Depth 12 -Compress`;
    const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true,
      env: { ...process.env, PSModulePath: resolve(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/Modules') },
    });
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== 'win32')('offline virtual network transaction', { timeout: 40_000 }, () => {
  it('disconnects before one dispatch and restores the exact original switch after a failed Gradle result', async () => {
    const r = await exercise();
    expect(r.events).toEqual(['disconnect', 'execute', 'connect']);
    expect(r.calls).toBe(1);
    expect(r.connected).toBe(true);
    expect(r.result.network).toMatchObject({ disconnected_verified: true, restored: true, guest_quiescent: true });
    expect(r.result.receipt.failure_code).toBe('offline_cache_miss');
    expect(JSON.stringify(r.result)).not.toMatch(/PRIVATE|nic-a|001122|00000000/);
  });
  it.each(['existing', 'busy-before'])('never changes network or dispatches when %s', async mode => {
    const r = await exercise(mode);
    expect(r.events).toEqual([]);
    expect(r.calls).toBe(0);
    expect(r.connected).toBe(true);
    expect(r.result.failure_code).not.toBe('none');
  });
  it('restores after partial disconnect failure without dispatching', async () => {
    const r = await exercise('disconnect-throws');
    expect(r.events).toEqual(['disconnect', 'connect']);
    expect(r.calls).toBe(0);
    expect(r.connected).toBe(true);
    expect(r.result.failure_code).toBe('network_disconnect_failed');
  });
  it.each(['busy-after', 'topology-drift', 'restore-throws'])('fails closed without claiming restoration when %s', async mode => {
    const r = await exercise(mode);
    expect(r.calls).toBe(1);
    expect(r.connected).toBe(false);
    expect(r.result.network.restored).toBe(false);
    expect(r.result.failure_code).toBe('network_restore_required');
    expect(r.journal_exists).toBe(true);
  });
  it('does not retry a transport failure and restores only after a fresh quiescence check', async () => {
    const r = await exercise('transport-fails');
    expect(r.calls).toBe(1);
    expect(r.events).toEqual(['disconnect', 'execute', 'connect']);
    expect(r.result.failure_code).toBe('transport_failed');
    expect(r.result.network.restored).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const quote = s => `'${s.replaceAll("'", "''")}'`;
const exec = promisify(execFile);

async function runPs(script) {
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: { ...process.env, PSModulePath: resolve(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/Modules') },
  }).catch(error => ({ code: error.code, stderr: error.stderr }));
  expect(result.code || 0, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}

async function exercise(mode = 'normal') {
  const parent = 'C:/kmp-eval/scratch';
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(resolve(parent, 'e1-nic-fixture-'));
  try {
    const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
      Import-Module ${quote(resolve(root, 'docs/audits/evidence1-validation-ops.psm1'))} -DisableNameChecking
      $code=[IO.File]::ReadAllText(${quote(resolve(root, 'docs/audits/evidence1-gradle-offline-probe.psm1'))})
      $code=$code.Replace('Global\\Evidence1OfflineNetwork',('Local\\OfflineFixture-'+[guid]::NewGuid().ToString('N')))
      if($code.Contains('Global\\Evidence1OfflineNetwork')){throw 'fixture_mutex_not_replaced'}
      Import-Module (New-Module -Name evidence1-gradle-offline-probe -ScriptBlock ([scriptblock]::Create($code))) -DisableNameChecking
      $r=& (Get-Module evidence1-gradle-offline-probe) {
        param($journal,$mode)
        $script:nics=@([pscustomobject]@{Id='nic-a';VMId=[guid]'00000000-0000-0000-0000-000000000001';SwitchId=[guid]'00000000-0000-0000-0000-000000000002';MacAddress='001122334455';Connected=$true})
        $script:events=@();$script:calls=0;$script:quietCalls=0
        if($mode -eq 'two-nics') {
          $script:nics+= [pscustomobject]@{Id='nic-b';VMId=$script:nics[0].VMId;SwitchId=$null;MacAddress='001122334456';Connected=$false}
        }
        if($mode -in @('second-switch-missing','second-connect-fails')) {
          $script:nics+= [pscustomobject]@{Id='nic-b';VMId=$script:nics[0].VMId;SwitchId=[guid]'00000000-0000-0000-0000-000000000003';MacAddress='001122334456';Connected=$true}
        }
        function Get-VMNetworkAdapter {param($VM) $script:nics}
        function Get-VMSwitch {param($Id)
          if($mode -eq 'second-switch-missing' -and $Id.ToString().EndsWith('3')){throw 'switch_missing'}
          if($mode -eq 'switch-replaced'){return [pscustomobject]@{Id=[guid]::NewGuid();Name='PRIVATE_SWITCH'}}
          [pscustomobject]@{Id=$Id;Name='PRIVATE_SWITCH_RENAMED'}
        }
        function Get-VMAssignableDevice {param($VMName) @()}
        function Disconnect-VMNetworkAdapter {param($VMNetworkAdapter,[switch]$Confirm)
          $script:events+='disconnect';$VMNetworkAdapter.SwitchId=[guid]::Empty;$VMNetworkAdapter.Connected=$false
          if($mode -eq 'disconnect-throws'){throw 'PRIVATE_DISCONNECT_ERROR'}
        }
        function Connect-VMNetworkAdapter {param($VMNetworkAdapter,$VMSwitch,[switch]$Confirm)
          $script:events+='connect'
          if($mode -eq 'restore-throws'){throw 'PRIVATE_CONNECT_ERROR'}
          if($mode -eq 'second-connect-fails' -and $VMNetworkAdapter.Id -eq 'nic-b'){throw 'PRIVATE_CONNECT_ERROR'}
          $VMNetworkAdapter.SwitchId=$VMSwitch.Id;$VMNetworkAdapter.Connected=$true
        }
        $vm=[pscustomobject]@{Id=[guid]'00000000-0000-0000-0000-000000000001';Name='Evidence1-Runner';State='Running'}
        $action={param($monitor)
          $script:calls++;$script:events+='execute'; & $monitor
          if($mode -eq 'transport-fails' -or $mode -in @('restore-off','restore-running')){throw 'PRIVATE_TRANSPORT_ERROR'}
          if($mode -eq 'topology-drift'){$script:nics[0].MacAddress='AABBCCDDEEFF'}
          return @{state='failed';failure_code='offline_cache_miss';process=@{timed_out=($mode -eq 'guest-timeout');cleanup_ok=$true}}
        }
        $quiet={
          $script:quietCalls++
          if($mode -eq 'busy-before' -or ($mode -eq 'busy-after' -and $script:quietCalls -gt 1)){throw 'cache_busy'}
        }
        if($mode -eq 'existing'){[IO.File]::WriteAllText($journal,'PRESERVED_ATTEMPT')}
        $result=Invoke-E1OfflineDisconnected $vm $journal $action $quiet
        if($mode -like 'restore-*' -and $mode -ne 'restore-throws') {
          if($mode -eq 'restore-off') {$vm.State='Off'}
          $result=Invoke-E1OfflineDisconnected $vm $journal $action $quiet -RestoreOnly
        }
        @{result=$result;calls=$script:calls;events=$script:events;connected=$script:nics[0].Connected;
          journal_exists=(Test-Path -LiteralPath $journal);connected_count=@($script:nics | Where-Object Connected).Count}
      } ${quote(resolve(dir, 'network.json'))} ${quote(mode)}
      $r | ConvertTo-Json -Depth 12 -Compress`;
    return await runPs(script);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== 'win32')('offline virtual network transaction', { timeout: 40_000 }, () => {
  it('restore-only never reads the mutable wet report or creates a guest session', async () => {
    const r = await runPs(`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
      Import-Module ${quote(resolve(root, 'docs/audits/evidence1-validation-ops.psm1'))} -DisableNameChecking
      Import-Module ${quote(resolve(root, 'docs/audits/evidence1-gradle-offline-probe.psm1'))} -DisableNameChecking
      $r=& (Get-Module evidence1-gradle-offline-probe) {
        $script:reads=0;$script:sessions=0
        function Read-E1ForensicArtifact {$script:reads++;throw 'REPORT_READ_FORBIDDEN'}
        function New-PSSession {$script:sessions++;throw 'SESSION_FORBIDDEN'}
        function Get-VM {[pscustomobject]@{Name='Evidence1-Runner';Id=[guid]::Empty;State='Off'}}
        function Invoke-E1OfflineDisconnected {param($VM,$JournalPath,$Action,$GuestQuiescent,[switch]$RestoreOnly,$Binding)
          @{network=@{restored=$true};failure_code='none'}
        }
        $result=Invoke-E1OfflineDirect ('a'*40) ('b'*40) ('c'*64) -RestoreNetwork
        @{reads=$script:reads;sessions=$script:sessions;result=$result}
      };$r | ConvertTo-Json -Depth 8 -Compress`);
    expect(r.reads).toBe(0);
    expect(r.sessions).toBe(0);
    expect(['none', 'host_privilege']).toContain(r.result.failure_code);
    expect(r.result.subject.host_wet_report_sha256).toBe('c'.repeat(64));
  });

  it('retains the existing validation mutex across runspaces and rejects a concurrent preparation with no Java process', async () => {
    const r = await runPs(`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
      Import-Module ${quote(resolve(root, 'docs/audits/evidence1-gradle-offline-probe.psm1'))} -DisableNameChecking
      $name='Global\\E1LeaseFixture-'+[guid]::NewGuid().ToString('N')
      $definition=(Get-Command Initialize-E1OfflineLease).ScriptBlock.ToString()
      if(-not $definition.Contains('Global\\Evidence1ValidationOps')){throw 'wrong_mutex'}
      & ([scriptblock]::Create($definition.Replace('Global\\Evidence1ValidationOps',$name)))
      $mutex=[Threading.Mutex]::new($false,$name);$null=$mutex.WaitOne(0);$blocked=$false
      try {[E1OfflineValidationLease]::Acquire('test-owner')}catch{$blocked=$true}
      $mutex.ReleaseMutex()
      [E1OfflineValidationLease]::Acquire('test-owner')
      $exclusive=-not $mutex.WaitOne(0)
      $ps=[powershell]::Create()
      try {
        $null=$ps.AddScript('[E1OfflineValidationLease]::Owns("test-owner")')
        $crossRunspace=$ps.Invoke()[0]
      } finally {$ps.Dispose()}
      $foreign=$false
      try {[E1OfflineValidationLease]::Release('foreign-owner')}catch{$foreign=$true}
      $stillHeld=[E1OfflineValidationLease]::Owns('test-owner')
      [E1OfflineValidationLease]::Release('test-owner')
      $released=$mutex.WaitOne(0)
      if($released){$mutex.ReleaseMutex()};$mutex.Dispose()
      @($blocked,$exclusive,$crossRunspace,$foreign,$stillHeld,$released) | ConvertTo-Json -Compress`);
    expect(r).toEqual([true, true, true, true, true, true]);
  });

  it.each(['completed', 'failed', 'monitor-fails'])('transport completion is verified and cleanup is unconditional: %s', async mode => {
    const r = await runPs(`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
      Import-Module ${quote(resolve(root, 'docs/audits/evidence1-validation-ops.psm1'))} -DisableNameChecking
      Import-Module ${quote(resolve(root, 'docs/audits/evidence1-gradle-offline-probe.psm1'))} -DisableNameChecking
      $r=& (Get-Module evidence1-gradle-offline-probe) {
        param($mode)
        $script:events=@();$script:waits=0
        function Invoke-Command {param($Session,[switch]$AsJob,$ScriptBlock,$ArgumentList)
          $script:events+='dispatch';[pscustomobject]@{State=$(if($mode -eq 'failed'){'Failed'}else{'Completed'})}
        }
        function Wait-Job {param($Job,$Timeout)
          $script:waits++;if($script:waits -gt 1){$Job}
        }
        function Receive-Job {param($Job) $script:events+='receive';New-E1OfflineReceipt -Disconnected}
        function Stop-Job {param($Job) $script:events+='stop'}
        function Remove-Job {param($Job,[switch]$Force) $script:events+='remove'}
        $monitor={$script:events+='monitor';if($mode -eq 'monitor-fails'){throw 'network_connected'}}
        $code='none';$result=$null
        try {$result=Invoke-E1OfflineTransport @{} '' ('a'*64) @{} $monitor} catch {$code=$_.Exception.Message}
        @{events=$script:events;code=$code;receipt=$result}
      } ${quote(mode)}
      $r | ConvertTo-Json -Depth 8 -Compress`);
    expect(r.events.slice(0, 2)).toEqual(['dispatch', 'monitor']);
    expect(r.events.slice(-2)).toEqual(['stop', 'remove']);
    expect(r.events.filter(e => e === 'dispatch')).toHaveLength(1);
    expect(r.code).toBe({ completed: 'none', failed: 'transport_failed', 'monitor-fails': 'network_connected' }[mode]);
    expect(r.events.includes('receive')).toBe(mode === 'completed');
  });

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
  it.each(['busy-after', 'topology-drift', 'restore-throws', 'switch-replaced'])('fails closed without claiming restoration when %s', async mode => {
    const r = await exercise(mode);
    expect(r.calls).toBe(1);
    expect(r.connected).toBe(false);
    expect(r.result.network.restored).toBe(false);
    expect(r.result.failure_code).toBe('network_restore_required');
    expect(r.journal_exists).toBe(true);
  });
  it.each(['transport-fails', 'guest-timeout'])('holds isolation after %s even if no Java process is visible', async mode => {
    const r = await exercise(mode);
    expect(r.calls).toBe(1);
    expect(r.events).toEqual(['disconnect', 'execute']);
    expect(r.result.failure_code).toBe('network_restore_required');
    expect(r.result.network.restored).toBe(false);
  });
  it.each(['restore-off', 'restore-running'])('restore-only never invokes the probe (%s)', async mode => {
    const r = await exercise(mode);
    expect(r.calls).toBe(1);
    expect(r.result.network.restore_only).toBe(true);
    expect(r.result.network.restored).toBe(mode === 'restore-off');
    expect(r.connected).toBe(mode === 'restore-off');
  });
  it('preserves an originally disconnected second adapter and nullable switch ID', async () => {
    const r = await exercise('two-nics');
    expect(r.calls).toBe(1);
    expect(r.connected_count).toBe(1);
    expect(r.result.network).toMatchObject({ adapter_count: 2, restored: true });
  });
  it.each(['second-switch-missing', 'second-connect-fails'])('does not leave partial network restoration: %s', async mode => {
    const r = await exercise(mode);
    expect(r.calls).toBe(1);
    expect(r.connected_count).toBe(0);
    expect(r.result.failure_code).toBe('network_restore_required');
    if(mode === 'second-switch-missing') expect(r.events).not.toContain('connect');
  });
});

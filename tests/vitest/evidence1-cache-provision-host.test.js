import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const quote = s => `'${s.replaceAll("'", "''")}'`;
const exec = promisify(execFile);
async function exercise(mode) {
  mkdirSync('C:/kmp-eval/scratch', { recursive: true });
  const dir = mkdtempSync('C:/kmp-eval/scratch/provision-host-test-');
  try {
    const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
      Import-Module ${quote(resolve(root, 'docs/audits/evidence1-validation-ops.psm1'))} -DisableNameChecking
      $code=[IO.File]::ReadAllText(${quote(resolve(root, 'docs/audits/evidence1-cache-provision-host.psm1'))})
      $code=$code.Replace('Global\\Evidence1OfflineNetwork',('Local\\ProvisionFixture-'+[guid]::NewGuid().ToString('N')))
      if($code.Contains('Global\\Evidence1OfflineNetwork')){throw 'fixture_mutex_not_replaced'}
      Import-Module (New-Module -Name evidence1-cache-provision-host -ScriptBlock ([scriptblock]::Create($code))) -DisableNameChecking
      $r=& (Get-Module evidence1-cache-provision-host) {
        param($journal,$mode)
        $script:connected=$true;$script:events=@()
        function Get-E1OfflineAdapterSnapshot { ,@(@{id='nic';mac='001122334455';switch_id='00000000-0000-0000-0000-000000000002';connected=$true}) }
        function Assert-E1OfflineAdapterState {param($VM,$Topology,$State)
          if(($State -eq 'disconnected' -and $script:connected) -or ($State -eq 'original' -and -not $script:connected)){throw 'topology'}
        }
        function Get-VMNetworkAdapter {param($VM) [pscustomobject]@{Id='nic';Connected=$script:connected;SwitchId=$(if($script:connected){[guid]'00000000-0000-0000-0000-000000000002'}else{[guid]::Empty})} }
        function Disconnect-VMNetworkAdapter {param($VMNetworkAdapter,[switch]$Confirm) $script:connected=$false;$script:events+='disconnect'}
        function Restore-E1OfflineAdapters {param($VM,$Topology) $script:connected=$true;$script:events+='restore'}
        $warm={
          $script:events+='warm'
          if(-not (Test-Path -LiteralPath $journal)){throw 'journal_missing'}
          if($mode -eq 'transport'){throw 'PRIVATE_DETAIL'}
          @{state=$(if($mode -eq 'warm-failed'){'failed'}else{'passed'});failure_code='gradle_failed';hashes=@{firewall_after_sha256=('a'*64)};checks=@{network_restored=($mode -ne 'cleanup')};process=@{timed_out=$false;cleanup_ok=$true}}
        }
        $certify={param($monitor)
          & $monitor;$script:events+='certify'
          if($script:connected){throw 'certify_online'}
          if($mode -eq 'certify-transport'){throw 'PRIVATE_DETAIL'}
          @{state=$(if($mode -in @('cache-miss','baseline-drift')){'failed'}else{'passed'});failure_code='offline_cache_miss';hashes=@{firewall_before_sha256=$(if($mode -eq 'baseline-drift'){'b'*64}else{'a'*64});firewall_after_sha256=$(if($mode -eq 'baseline-drift'){'b'*64}else{'a'*64})};checks=@{network_restored=$true};process=@{timed_out=$false;cleanup_ok=$true}}
        }
        $quiet={ $script:events+='quiet' }
        if($mode -eq 'existing'){[IO.File]::WriteAllText($journal,'PRESERVED')}
        $r=Invoke-E1ProvisionLifecycle ([pscustomobject]@{Id=[guid]::Empty}) $journal $warm $certify $quiet @{}
        @{result=$r;events=$script:events;connected=$script:connected;journal=[IO.File]::ReadAllText($journal)}
      } ${quote(resolve(dir, 'journal.json'))} ${quote(mode)}
      $r | ConvertTo-Json -Depth 12 -Compress`;
    const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      cwd: root, timeout: 30_000, windowsHide: true, encoding: 'utf8',
      env: { ...process.env, PSModulePath: resolve(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/Modules') },
    });
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe.skipIf(process.platform !== 'win32')('cache provisioning host isolation', { timeout: 40_000 }, () => {
  it('warms once, certifies disconnected, restores exact topology', async () => {
    const r = await exercise('normal');
    expect(r.result.state, JSON.stringify(r)).toBe('passed');
    expect(r.events.filter(x => x === 'warm')).toHaveLength(1);
    expect(r.events.indexOf('disconnect')).toBeLessThan(r.events.indexOf('certify'));
    expect(r.result.network.disconnected_verified).toBe(true);
    expect(r.result.network.restored).toBe(true);
    expect(r.connected).toBe(true);
  });
  it.each(['transport', 'cleanup', 'certify-transport', 'baseline-drift'])('isolates on uncertain completion: %s', async mode => {
    const r = await exercise(mode);
    expect(r.result.state).toBe('failed');
    expect(r.connected).toBe(false);
    expect(r.result.network.isolated_on_return).toBe(true);
    expect(r.events).not.toContain('restore');
    expect(JSON.stringify(r.result)).not.toContain('PRIVATE_DETAIL');
  });
  it('preserves an existing journal without dispatch', async () => {
    const r = await exercise('existing');
    expect(r.result.failure_code).toBe('attempt_exists');
    expect(r.events).not.toContain('warm');
    expect(r.journal).toBe('PRESERVED');
  });
  it('does not certify unsuccessful provisioning', async () => {
    const r = await exercise('warm-failed');
    expect(r.result.state).toBe('failed');
    expect(r.events).not.toContain('certify');
    expect(r.connected).toBe(true);
  });
  it('does not call a cold export ready', async () => {
    const r = await exercise('cache-miss');
    expect(r.result.state).toBe('failed');
    expect(r.result.failure_code).toBe('offline_cache_miss');
    expect(r.result.network.restored).toBe(true);
  });
});

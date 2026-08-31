import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const audits = resolve(root, 'docs/audits');
const quote = value => `'${value.replaceAll("'", "''")}'`;
const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const id = 'a'.repeat(32);
const commit = 'b'.repeat(40);
const tree = 'c'.repeat(40);
const reportHash = 'd'.repeat(64);
const counterKeys = [
  'socket_permission', 'connect_exception', 'ipv4_listed', 'ipv4_unlisted', 'ipv6_listed', 'ipv6_unlisted',
  'google', 'maven', 'plugin_portal', 'plugin_artifacts', 'redirect_google', 'daemon_fork',
  'recorded_addresses', 'remaining_owned_rules', 'explicit_outbound_blocks', 'local_rule_merge_disabled',
  'hosts_listed', 'hosts_unlisted', 'resolver_listed', 'resolver_unlisted',
];
const report = {
  schema: 1, operation: 'wet-v2', state: 'failed', target_commit: commit, target_tree: tree,
  source_commit: '7d45eae4f8720a0c77f507712ba2437ff974b6ed', agent_calls: 0,
  product_invocations: 1, dry_plan_invocations: 0, hashes: { product_stdout_sha256: 'e'.repeat(64) },
};
const diagnostics = Object.fromEntries(counterKeys.map(key => [key, 0]));
diagnostics.firewall_unchanged = true;
const forbidden = [
  'Invoke-E1OwnedProcess', 'Invoke-E1Git', 'Invoke-E1CacheProvisionGuest', 'Invoke-E1ProvisionLifecycle',
  'Invoke-E1CacheProvisionTransport', 'Copy-E1OfflineCache', 'Write-E1CacheProvisionNew',
  'New-NetFirewallRule', 'Set-NetFirewallRule', 'Remove-NetFirewallRule', 'Set-NetFirewallProfile',
  'Connect-VMNetworkAdapter', 'Disconnect-VMNetworkAdapter', 'Restore-E1OfflineAdapters',
  'Start-Process', 'Set-Content', 'Add-Content', 'Remove-Item', 'Copy-Item',
];

async function ps(body) {
  const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
    if($PSVersionTable.PSVersion.ToString() -notlike '5.1.*'){throw 'requires_ps51'}
    ${['evidence1-validation-ops.psm1', 'evidence1-validation-forensics.psm1',
    'evidence1-gradle-offline-probe.psm1', 'evidence1-gradle-cache-provision.psm1',
    'evidence1-cache-provision-host.psm1'].map(name => `Import-Module ${quote(resolve(audits, name))} -DisableNameChecking`).join('\n')}
    ${body}`;
  const { stdout, stderr } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    cwd: root, windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, PSModulePath: resolve(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/Modules') },
  }).catch(error => { throw new Error(error.stderr || `PowerShell exited ${error.code}`); });
  expect(stderr).toBe('');
  return JSON.parse(stdout);
}

function warmReceipt(stdout = '', stderr = '') {
  return {
    schema: 1, operation: 'gradle-cache-provision', provision_id: id, phase: 'warm',
    state: 'failed', failure_code: 'gradle_failed', agent_calls: 0, product_calls: 0, live_records: 0,
    gradle_invocations: 1, process: { exit_code: 1, wall_seconds: 1, timed_out: false, cleanup_ok: true },
    cache: null, gradle_signals: null, offline_signals: null,
    hashes: { context_sha256: 'f'.repeat(64), stdout_sha256: hash(stdout), stderr_sha256: hash(stderr),
      firewall_before_sha256: '1'.repeat(64), firewall_after_sha256: '1'.repeat(64) },
    checks: { guest_identity: true, source_custody: true, records_unchanged: true,
      postflight: true, network_restored: true, network_disconnected: false },
  };
}

function forbiddenFunctions() {
  return forbidden.map(name => `function ${name} {$script:mutations+=${quote(name)};throw 'forbidden_mutation'}`).join('\n');
}

function snapshot(directory) {
  return Object.fromEntries(readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const path = resolve(entry.parentPath || entry.path, entry.name);
      return [path, hash(readFileSync(path))];
    }));
}

async function guest(mode = 'normal') {
  mkdirSync('C:/kmp-eval/scratch', { recursive: true });
  const dir = mkdtempSync('C:/kmp-eval/scratch/provision-read-test-');
  try {
    const stdout = [
      ...Array(6).fill('Could not GET https://dl.google.com/dl/android/maven2/PRIVATE_TOKEN'),
      'java.net.SocketException: Permission denied: connect',
      'java.net.ConnectException: Permission denied: getsockopt',
      'A single-use Daemon process will be forked.',
      ...(mode === 'addresses' ? ['dl.google.com/192.0.2.1 dl.google.com/192.0.2.2',
        'dl.google.com/[2001:db8::1] dl.google.com/[2001:db8::2]'] : []),
    ].join('\n');
    const stderr = 'PRIVATE_STDERR C:\\PRIVATE_HOME\\file';
    const warm = warmReceipt(stdout, stderr);
    const config = { ProvisionId: id, LeaseToken: 'fixture-only', Warm: structuredClone(warm) };
    const journal = { context_sha256: warm.hashes.context_sha256, repositories: [
      { host_name: 'dl.google.com', addresses: ['192.0.2.1', '2001:db8::1'] },
    ] };
    if (mode === 'context') warm.hashes.context_sha256 = '2'.repeat(64);
    if (mode === 'journal') journal.context_sha256 = '2'.repeat(64);
    if (mode === 'id') warm.provision_id = '2'.repeat(32);
    if (mode === 'phase') warm.phase = 'certify';
    if (mode === 'host-stdout') config.Warm.hashes.stdout_sha256 = '2'.repeat(64);
    if (mode === 'host-stderr') config.Warm.hashes.stderr_sha256 = '2'.repeat(64);
    if (mode === 'repository') journal.repositories[0].host_name = 'PRIVATE.invalid';
    let stdoutBytes = Buffer.from(stdout);
    if (mode === 'tampered-stdout') stdoutBytes = Buffer.from('TAMPERED_PRIVATE');
    if (mode === 'oversize') stdoutBytes = Buffer.alloc(1048577, 65);
    if (mode === 'encoding') {
      stdoutBytes = Buffer.from([0xff]);
      warm.hashes.stdout_sha256 = config.Warm.hashes.stdout_sha256 = hash(stdoutBytes);
    }
    mkdirSync(resolve(dir, 'warm'));
    mkdirSync(resolve(dir, 'System32/drivers/etc'), { recursive: true });
    writeFileSync(resolve(dir, 'warm/gradle.stdout.txt'), stdoutBytes);
    writeFileSync(resolve(dir, 'warm/gradle.stderr.txt'), mode === 'tampered-stderr' ? 'TAMPERED_PRIVATE' : stderr);
    writeFileSync(resolve(dir, 'warm.result.json'), JSON.stringify(warm));
    writeFileSync(resolve(dir, 'warm.started.json'), JSON.stringify(journal));
    writeFileSync(resolve(dir, 'System32/drivers/etc/hosts'), [
      '192.0.2.1 alias.invalid dl.google.com # PRIVATE_COMMENT',
      '2001:0db8:0:0:0:0:0:1 dl.google.com',
      '192.0.2.9 dl.google.com',
      '# 192.0.2.8 dl.google.com',
      '192.0.2.7 unrelated.invalid',
      'not-an-ip dl.google.com',
    ].join('\n'));
    const before = snapshot(dir);
    const result = await ps(`$r=& (Get-Module evidence1-gradle-cache-provision) {
      param($base,$mode,$configJson)
      $config=ConvertFrom-E1Json $configJson
      $script:mutations=@();$script:quiet=0;$script:resolverCalls=0
      ${forbiddenFunctions()}
      function Assert-E1CacheProvisionLease {param($Config) if($mode -eq 'lease'){throw 'validation_overlap'}}
      function Assert-E1OfflineQuiescent {param($Source) $script:quiet++;if($mode -eq 'busy' -or ($mode -eq 'post-busy' -and $script:quiet -eq 2)){throw 'cache_busy'}}
      function Resolve-E1Path {param($Path)
        if($Path -eq ('C:\\kmp-eval\\scratch\\gradle-cache-provision-'+$config.ProvisionId)){return $base}
        if(-not [IO.Path]::GetFullPath($Path).StartsWith([IO.Path]::GetFullPath($base)+[IO.Path]::DirectorySeparatorChar)){throw 'fixture_path_escape'}
        $Path
      }
      function Get-E1OfflineFirewallHash {if($mode -eq 'firewall'){return '2'*64};'1'*64}
      function Get-NetFirewallRule {param($PolicyStore)
        if($PolicyStore -ne 'ActiveStore'){throw 'wrong_policy_store'}
        if($mode -eq 'rules') {
          foreach($row in @(@{Name=('E1CacheProvision-'+$config.ProvisionId+'-0');Enabled='True';Direction='Outbound';Action='Allow'},
            @{Name='PRIVATE_OTHER';Enabled='True';Direction='Outbound';Action='Block'},
            @{Name='PRIVATE_DISABLED';Enabled='False';Direction='Outbound';Action='Block'},
            @{Name='PRIVATE_INBOUND';Enabled='True';Direction='Inbound';Action='Block'})){[pscustomobject]$row}
        }
      }
      function Get-NetFirewallProfile {param($PolicyStore)
        foreach($v in @('False','True','NotConfigured')){[pscustomobject]@{AllowLocalFirewallRules=$v}}
      }
      function Get-E1FixtureHostAddresses {param($HostName)
        if($HostName -ne 'dl.google.com'){throw 'unapproved_resolver_name'}
        $script:resolverCalls++;[Net.IPAddress]::Parse('192.0.2.1');[Net.IPAddress]::Parse('2001:db8::2')
      }
      function Get-E1FixtureHosts {[IO.File]::ReadAllLines((Join-Path $base 'System32/drivers/etc/hosts'))}
      # Replace external DNS/hosts inputs only; log hashing and projection stay real.
      $body=(Get-Command Read-E1CacheProvisionGuest).ScriptBlock.ToString()
      $dns='[Net.Dns]::GetHostAddresses($repository.host_name)'
      if(-not $body.Contains($dns)){throw 'fixture_dns_not_replaced'}
      $hosts=${quote("[IO.File]::ReadAllLines((Join-Path $env:SystemRoot 'System32/drivers/etc/hosts'))")}
      if(-not $body.Contains($hosts)){throw 'fixture_hosts_not_replaced'}
      $body=$body.Replace($dns,'(Get-E1FixtureHostAddresses $repository.host_name)').Replace($hosts,'(Get-E1FixtureHosts)')
      $read=[scriptblock]::Create($body)
      $summary=$null;$failure=$null;$failureDetail=$null
      try {$summary=& $read $config}catch{$failure=$_.Exception.Message;$failureDetail=$_.ScriptStackTrace}
      @{summary=$summary;failure=$failure;failure_detail=$failureDetail;mutations=$script:mutations;quiet=$script:quiet;resolver_calls=$script:resolverCalls}
    } ${quote(dir)} ${quote(mode)} ${quote(JSON.stringify(config))}
    $r | ConvertTo-Json -Depth 12 -Compress`);
    expect(snapshot(dir)).toEqual(before);
    expect(result.mutations).toEqual([]);
    return result;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function host({ subject = {}, raw = diagnostics, mutation = '', read = true } = {}) {
  const prior = { schema: 1, operation: 'gradle-cache-provision',
    subject: { target_commit: commit, target_tree: tree, host_wet_report_sha256: reportHash, ...subject }, warm: warmReceipt() };
  const result = await ps(`$r=& (Get-Module evidence1-cache-provision-host) {
    param($priorJson,$rawJson,$reportJson,$mutation,$read)
    $script:prior=ConvertFrom-E1Json $priorJson;$script:raw=ConvertFrom-E1Json $rawJson;$script:report=ConvertFrom-E1Json $reportJson
    $script:events=@();$script:mutations=@();$script:failureDetail=$null
    ${forbiddenFunctions()}
    $failureCode=(Get-Command Get-E1FailureCode).ScriptBlock
    function Get-E1FailureCode {param($Failure,$Fallback) $script:failureDetail=$Failure.ToString()+$Failure.ScriptStackTrace;& $failureCode $Failure $Fallback}
    function Resolve-E1Path {param($Path) $Path}
    function Read-E1ForensicArtifact {param($Path,$ExpectedSha)
      if($ExpectedSha -cne ${quote(reportHash)}){throw 'forensic_hash'}
      @{sha256=$ExpectedSha;value=$script:report}
    }
    function Get-VM {param($Name) $script:events+='vm';[pscustomobject]@{Id=[guid]::Empty;State='Running'}}
    function New-Item {param($ItemType,$Path,[switch]$Force) if($ItemType -ne 'Directory'){throw 'unexpected_write'}}
    function Test-Path {param($LiteralPath) $true}
    function Import-Clixml {param($LiteralPath) $password=[Security.SecureString]::new();$password.AppendChar('x');[pscredential]::new('runner',$password)}
    function New-PSSession {param($VMId,$Credential) $script:events+='session';@{fixture=$true}}
    function Remove-PSSession {param($Session) $script:events+='remove-session'}
    function Read-E1Json {param($Path) $script:events+='prior';@{value=$script:prior}}
    function Invoke-Command {param($Session,$ScriptBlock,$ArgumentList)
      $text=$ScriptBlock.ToString()
      if($text.Contains('Read-E1CacheProvisionGuest')) {
        $script:events+='read'
        if($ArgumentList.ProvisionId -cne ${quote(id)} -or $ArgumentList.Warm.hashes.stdout_sha256 -cne $script:prior.warm.hashes.stdout_sha256){throw 'config_binding'}
        return $script:raw
      }
      if($text.Contains('::Acquire(')){$script:events+='acquire';return}
      if($text.Contains('::Release(')){$script:events+='release';return}
      throw 'unexpected_remote_dispatch'
    }
    if($mutation){& ([scriptblock]::Create($mutation))}
    # Host privilege and script location are fixture inputs, never real VM access.
    $body=(Get-Command Invoke-E1CacheProvisionDirect).ScriptBlock.ToString()
    $admin='([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
    if(-not $body.Contains($admin)){throw 'fixture_admin_not_replaced'}
    $body=$body.Replace($admin,'$true').Replace('$PSScriptRoot',${quote(quote(audits))})
    $invoke=[scriptblock]::Create($body)
    $result=& $invoke ${quote(commit)} ${quote(tree)} ${quote(reportHash)} ${quote(id)} -ReadDiagnostics:$read
    @{result=$result;events=$script:events;mutations=$script:mutations;failure_detail=$script:failureDetail}
  } ${quote(JSON.stringify(prior))} ${quote(JSON.stringify(raw))} ${quote(JSON.stringify(report))} ${quote(mutation)} $${read}
  $r | ConvertTo-Json -Depth 12 -Compress`);
  expect(result.mutations).toEqual([]);
  return result;
}

describe.skipIf(process.platform !== 'win32')('read-only provisioning diagnostics', { timeout: 40_000 }, () => {
  it('routes an existing attempt to diagnostic read without Gradle, NIC or firewall mutations', async () => {
    const r = await host();
    expect(r.result, JSON.stringify(r)).toMatchObject({ state: 'passed', operation: 'gradle-cache-provision-read', failure_code: 'none', warm: null, certify: null, network: null });
    expect(r.result.subject).toEqual({ target_commit: commit, target_tree: tree, host_wet_report_sha256: reportHash });
    expect(r.result.diagnostics).toEqual(diagnostics);
    expect(r.events).toEqual(['vm', 'session', 'acquire', 'prior', 'read', 'release', 'remove-session']);
    expect(r.mutations).toEqual([]);
  });

  it('retains the original attempt guard without ReadDiagnostics', async () => {
    const r = await host({ read: false });
    expect(r.result.failure_code).toBe('attempt_exists');
    expect(r.events).not.toContain('session');
    expect(r.mutations).toEqual([]);
  });

  it('rejects a mismatched current wet subject before any session is opened', async () => {
    const r = await host({ mutation: "$script:report.target_commit='0'*40" });
    expect(r.result.state).toBe('failed');
    expect(r.events).toEqual([]);
  });

  it.each(["$script:prior.schema=2", "$script:prior.operation='gradle-cache-provision-read'"])(
    'rejects a non-provisioning prior receipt: %s', async mutation => {
      const r = await host({ mutation });
      expect(r.result.state).toBe('failed');
      expect(r.events).toContain('prior');
      expect(r.events).not.toContain('read');
      expect(r.events.slice(-2)).toEqual(['release', 'remove-session']);
    });

  it.each(['target_commit', 'target_tree', 'host_wet_report_sha256'])('rejects a prior report with mismatched %s before reading the guest', async key => {
    const r = await host({ subject: { [key]: '0'.repeat(key === 'host_wet_report_sha256' ? 64 : 40) } });
    expect(r.result.state).toBe('failed');
    expect(r.events).not.toContain('read');
    expect(r.events.slice(-2)).toEqual(['release', 'remove-session']);
    expect(r.mutations).toEqual([]);
  });

  it('projects only closed primitive fields, stripping unknown data and remoting metadata', async () => {
    const r = await host({ raw: { ...diagnostics, raw: 'PRIVATE_TOKEN', ip: '192.0.2.9',
      path: 'C:\\PRIVATE', PSComputerName: 'PRIVATE_HOST', nested: { secret: 'PRIVATE' } },
    mutation: "$script:raw.google=([int]6 | Add-Member -NotePropertyName PRIVATE -NotePropertyValue 'PRIVATE_TOKEN' -PassThru)" });
    expect(r.result.state).toBe('passed');
    expect(r.result.diagnostics).toEqual({ ...diagnostics, google: 6 });
    expect(JSON.stringify(r.result)).not.toMatch(/PRIVATE|192\.0\.2|PSComputerName/);
  });

  it('accepts the bounded Int64 count and reconstructs decorated boolean values', async () => {
    const r = await host({ mutation: "$script:raw.google=[long]100000;$script:raw.firewall_unchanged=($true | Add-Member -NotePropertyName PRIVATE -NotePropertyValue 'PRIVATE_TOKEN' -PassThru)" });
    expect(r.result.diagnostics).toEqual({ ...diagnostics, google: 100000 });
    expect(JSON.stringify(r.result)).not.toContain('PRIVATE');
  });

  it.each([
    ['negative', { google: -1 }], ['too large', { google: 100001 }], ['fraction', { google: 1.5 }],
    ['string', { google: '6' }], ['null', { google: null }], ['boolean', { google: true }],
    ['nonboolean firewall', { firewall_unchanged: 'true' }],
  ])('rejects %s diagnostics without exposing raw values', async (_label, change) => {
    const r = await host({ raw: { ...diagnostics, ...change } });
    expect(r.result.state).toBe('failed');
    expect(r.events).toContain('read');
    expect(r.result).not.toHaveProperty('diagnostics');
    expect(r.events.slice(-2)).toEqual(['release', 'remove-session']);
  });

  it('requires every counter, including the resolver and local merge extension', async () => {
    for (const key of ['socket_permission', 'local_rule_merge_disabled', 'resolver_unlisted']) {
      const raw = { ...diagnostics }; delete raw[key];
      const r = await host({ raw });
      expect(r.result.state).toBe('failed');
      expect(r.events).toContain('read');
    }
  });

  it('reads both hash-bound logs and preserves every evidence file byte-for-byte', async () => {
    const r = await guest();
    expect(r.failure, JSON.stringify(r)).toBeNull();
    expect(r.summary).toEqual({ ...diagnostics, google: 6, socket_permission: 2, connect_exception: 1,
      daemon_fork: 1, recorded_addresses: 2, local_rule_merge_disabled: 1,
      hosts_listed: 2, hosts_unlisted: 1, resolver_listed: 1, resolver_unlisted: 1 });
    expect(r.quiet).toBe(2);
    expect(r.resolver_calls).toBe(1);
    expect(JSON.stringify(r.summary)).not.toMatch(/PRIVATE|https|192\.0\.2|2001:|dl\.google/);
  });

  it('counts normalized IPv4 and IPv6 membership without emitting addresses', async () => {
    const r = await guest('addresses');
    expect(r.failure).toBeNull();
    expect(r.summary).toMatchObject({ ipv4_listed: 1, ipv4_unlisted: 1, ipv6_listed: 1, ipv6_unlisted: 1 });
    expect(JSON.stringify(r.summary)).not.toMatch(/192\.0\.2|2001:/);
  });

  it.each(['context', 'journal', 'id', 'phase', 'host-stdout', 'host-stderr'])('rejects %s binding mismatch before resolver inspection', async mode => {
    const r = await guest(mode);
    expect(r.failure).toBe('context_mismatch');
    expect(r.summary).toBeNull();
    expect(r.resolver_calls).toBe(0);
  });

  it.each(['tampered-stdout', 'tampered-stderr'])('rejects %s bytes against the host-bound hash', async mode => {
    const r = await guest(mode);
    expect(r.failure).toBe('evidence_changed');
    expect(r.resolver_calls).toBe(0);
  });

  it.each([['oversize', 'diagnostic_limit'], ['lease', 'validation_overlap'], ['busy', 'cache_busy'],
    ['post-busy', 'cache_busy'], ['repository', 'context_mismatch']])('rejects %s without altering the evidence', async (mode, failure) => {
    expect((await guest(mode)).failure).toBe(failure);
  });

  it('rejects invalid UTF-8 even when its bytes match the recorded hash', async () => {
    const r = await guest('encoding');
    expect(r.failure).not.toBeNull();
    expect(r.summary).toBeNull();
    expect(r.resolver_calls).toBe(0);
  });

  it('reports leftover rules and firewall drift as observations, without repairing either', async () => {
    expect((await guest('rules')).summary).toMatchObject({ remaining_owned_rules: 1, explicit_outbound_blocks: 1 });
    expect((await guest('firewall')).summary.firewall_unchanged).toBe(false);
    const r = await host({ raw: { ...diagnostics, firewall_unchanged: false, remaining_owned_rules: 1 } });
    expect(r.result.operation).toBe('gradle-cache-provision-read');
    expect(r.result.diagnostics.firewall_unchanged).toBe(false);
    expect(r.mutations).toEqual([]);
  });

  it('uses a fresh read report name while keeping the original provisioning report reserved', async () => {
    const r = await ps(`$tokens=$null;$errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile(${quote(resolve(audits, 'evidence1-hyperv-provision-gradle-cache-direct.ps1'))},[ref]$tokens,[ref]$errors)
      $assignment=$ast.Find({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$fileName'},$true)
      $ProvisionId=${quote(id)};$ReadDiagnostics=$true
      Invoke-Expression $assignment.Extent.Text;$first=$fileName
      Invoke-Expression $assignment.Extent.Text;$second=$fileName
      $ReadDiagnostics=$false;Invoke-Expression $assignment.Extent.Text
      $dispatch=$ast.Find({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Invoke-E1CacheProvisionDirect'},$true)
      @{first=$first;second=$second;original=$fileName;forwards_switch=$dispatch.Extent.Text.Contains('-ReadDiagnostics:$ReadDiagnostics');errors=@($errors).Count} | ConvertTo-Json -Compress`);
    expect(r.errors).toBe(0);
    expect(r.first).toMatch(new RegExp(`^${id}\\.read-[a-f0-9]{32}\\.json$`));
    expect(r.second).not.toBe(r.first);
    expect(r.original).toBe(`${id}.json`);
    expect(r.forwards_switch).toBe(true);
  });

  it('limits the guest read entry to reviewed read-only commands', async () => {
    const commands = await ps(`$ast=(Get-Command Read-E1CacheProvisionGuest).ScriptBlock.Ast
      @($ast.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst]},$true) | ForEach-Object {$_.GetCommandName()} | Sort-Object -Unique) | ConvertTo-Json -Compress`);
    expect(commands.sort()).toEqual(['Assert-E1CacheProvisionLease', 'Assert-E1OfflineQuiescent', 'Resolve-E1Path',
      'ConvertTo-E1CacheProvisionReceipt', 'Read-E1Json', 'Join-Path', 'Get-E1Field', 'Get-E1Sha256',
      'Get-E1ProvisionConnectionSummary', 'Get-E1OfflineFirewallHash', 'ForEach-Object', 'Get-NetFirewallRule',
      'Where-Object', 'Get-NetFirewallProfile'].sort());
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
// A missing-path override reproduces the pre-implementation RED without touching production.
const modulePath = process.env.E1_OFFLINE_TEST_MODULE_PATH || resolve(root, 'docs/audits/evidence1-gradle-offline-probe.psm1');
const entryPath = resolve(root, 'docs/audits/evidence1-hyperv-probe-gradle-offline-direct.ps1');
const quote = value => `'${value.replaceAll("'", "''")}'`;
const execFileAsync = promisify(execFile);

async function ps(body, importModule = true) {
  // Import at test execution time: an absent implementation must not abort collection.
  const script = `$ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'requires_windows_powershell_5_1' }
    ${importModule ? `Import-Module ${quote(resolve(root, 'docs/audits/evidence1-validation-ops.psm1'))} -Force -DisableNameChecking
    Import-Module ${quote(resolve(root, 'docs/audits/evidence1-validation-forensics.psm1'))} -Force -DisableNameChecking
    Import-Module ${quote(modulePath)} -Force -DisableNameChecking` : ''}
    ${body}`;
  const result = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: { ...process.env, PSModulePath: resolve(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/Modules') },
  }).then(output => ({ ...output, status: 0 }), error => ({ status: error.code, stderr: error.stderr, error }));
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}

const fixtureRoots = [];
function fixture(parent = tmpdir()) {
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(resolve(parent, 'e1-offline-cache-test-'));
  fixtureRoots.push(dir);
  const source = resolve(dir, 'source');
  const destination = resolve(dir, 'destination');
  mkdirSync(source);
  return { dir, source, destination };
}
function put(rootPath, path, bytes = 'PRIVATE_SYNTHETIC_CONTENT') {
  const file = resolve(rootPath, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}
function sdkFixtureScript(f) {
  return `$tokens=$null; $errors=$null
    $ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(modulePath)},[ref]$tokens,[ref]$errors)
    $fn=$ast.Find({param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Get-E1OfflineSdk'},$true)
    . ([scriptblock]::Create($fn.Extent.Text))
    $realResolver=(Get-Command Resolve-E1Path).ScriptBlock
    function Resolve-E1Path([string]$Path) { & $realResolver $Path ${quote(f.dir)} }`;
}
function snapshot(dir) {
  const out = {};
  function walk(parent, prefix = '') {
    for (const name of readdirSync(parent).sort()) {
      const path = resolve(parent, name);
      const relative = `${prefix}${name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) out[relative] = { link: readlinkSync(path) };
      else if (stat.isDirectory()) { out[`${relative}/`] = {}; walk(path, `${relative}/`); }
      else out[relative] = { sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), size: stat.size, mtime: stat.mtimeMs, links: stat.nlink };
    }
  }
  walk(dir);
  return out;
}
async function copy(source, destination) {
  const result = await ps(`$r=Copy-E1OfflineCache -Source ${quote(source)} -Destination ${quote(destination)}
    @{ receipt=$r; hashtable=($r -is [hashtable]); integers=(($r.file_count -is [int] -or $r.file_count -is [long]) -and ($r.bytes -is [int] -or $r.bytes -is [long])) } | ConvertTo-Json -Depth 5 -Compress`);
  expect(result.hashtable).toBe(true);
  expect(result.integers).toBe(true);
  expect(Object.keys(result.receipt).sort()).toEqual(['bytes', 'file_count', 'sha256']);
  expect(result.receipt.sha256).toMatch(/^[a-fA-F0-9]{64}$/);
  return result.receipt;
}
async function rejectsCopy(source, destination) {
  // Resolve outside catch so a missing export cannot masquerade as a safety rejection.
  return ps(`$null=Get-Command Copy-E1OfflineCache -Module evidence1-gradle-offline-probe -ErrorAction Stop
    $rejected=$false
    try { $null=Copy-E1OfflineCache -Source ${quote(source)} -Destination ${quote(destination)} } catch {
      if ($_.Exception -is [System.Management.Automation.CommandNotFoundException]) { throw }
      $rejected=$true
    }
    $rejected | ConvertTo-Json -Compress`);
}

afterEach(() => {
  for (const dir of fixtureRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('Evidence1 offline cache contract (PowerShell 5.1)', { timeout: 40_000 }, () => {
  it('exports the three proposed functions', async () => {
    const names = ['Get-E1OfflineSignals', 'Test-E1OfflineCacheRelativePath', 'Copy-E1OfflineCache'];
    const result = await ps(`@(${names.map(quote).join(',')}) | ForEach-Object {
      (Get-Command $_ -Module evidence1-gradle-offline-probe -CommandType Function -ErrorAction Stop).Name
    } | ConvertTo-Json -Compress`);
    expect(result).toEqual(names);
  });

  it('loads the exact in-memory transport composition without executing the probe', async () => {
    expect(await ps(`$text=''
      foreach($p in @(${['evidence1-validation-ops.psm1', 'evidence1-validation-forensics.psm1', 'evidence1-gradle-offline-probe.psm1'].map(name => quote(resolve(root, 'docs/audits', name))).join(',')})) {
        $text += [IO.File]::ReadAllText($p) + "\n"
      }
      Import-Module (New-Module -Name OfflineCompositionTest -ScriptBlock ([scriptblock]::Create($text))) -DisableNameChecking
      $r=ConvertTo-E1OfflineReceipt (New-E1OfflineReceipt)
      @($r.agent_calls,$r.product_invocations,$r.gradle_invocations,$r.validation_pass) | ConvertTo-Json -Compress`, false)).toEqual([0, 0, 0, false]);
  });

  it('rejects malformed or private receipt fields before returning them to the host', async () => {
    const mutations = [
      "$r.path='PRIVATE_PATH'", "$r.hashes.raw='PRIVATE_TEXT'", "$r.failure_code='PRIVATE_ERROR'",
      '$r.agent_calls=1', '$r.product_invocations=1', '$r.gradle_invocations=2', '$r.validation_pass=$true',
      '$r.firewall_modified=$true', "$r.checks.postflight='true'",
      '$r.offline_signals=@{offline_cache_miss=-1}', '$r.offline_signals=@{offline_cache_miss=0.5}',
      "$r.cache=@{file_count=1;bytes=10;sha256='PRIVATE'}", "$r.state='passed'",
    ];
    expect(await ps(`$out=@()
      foreach($mutation in @(${mutations.map(quote).join(',')})) {
        $r=New-E1OfflineReceipt; & ([scriptblock]::Create($mutation))
        try {$null=ConvertTo-E1OfflineReceipt $r; $out+=$false} catch {$out+=($_.Exception.Message -ceq 'result_shape')}
      }
      $out | ConvertTo-Json -Compress`)).toEqual(mutations.map(() => true));
  });

  it('keeps an explicit offline miss distinct from a successful task execution', async () => {
    const result = await ps(`$r=New-E1OfflineReceipt; $r.stage='complete'; $r.failure_code='offline_cache_miss'
      $r.conclusion='offline_cache_incomplete'; $r.gradle_invocations=1; $r.live_records_created=0
      $r.offline_signals=Get-E1OfflineSignals 'No cached version of PRIVATE:artifact:1 available for offline mode.'
      $r.process=@{exit_code=1;wall_seconds=0.5;timed_out=$false;cleanup_ok=$true}
      ConvertTo-E1OfflineReceipt $r | ConvertTo-Json -Depth 8 -Compress`);
    expect(result.conclusion).toBe('offline_cache_incomplete');
    expect(result.offline_signals.offline_cache_miss).toBe(1);
    expect(result.validation_pass).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE/);
  });

  it('rejects broad outbound permission and fingerprints effective address/port/application filters', async () => {
    expect(await ps(`$tokens=$null; $errors=$null
      $ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(modulePath)},[ref]$tokens,[ref]$errors)
      $fn=$ast.Find({param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Get-E1OfflineSealHash'},$true)
      . ([scriptblock]::Create($fn.Extent.Text))
      $testPort='443'; $testProtocol='TCP'; $testDynamic='Any'; $testAddress='192.0.2.1'; $testProgram='Any'; $testService='Any'; $testPackage='Any'; $testDefault='Block'
      function Read-E1Json {return @{sha256=('a'*64);value=@{verdict='PASS';network_mode='restricted';allowed_resolved_ips_by_host=@{'api.anthropic.com'=@('192.0.2.1');'platform.claude.com'=@('192.0.2.1');'claude.ai'=@('192.0.2.1');'claude.com'=@('192.0.2.1')}}}}
      function Get-NetFirewallProfile {foreach($n in @('Domain','Private','Public')) {[pscustomobject]@{Name=$n;Enabled=$true;DefaultOutboundAction=$testDefault}}}
      function Get-NetFirewallRule {[pscustomobject]@{Name='PRIVATE_RULE';Enabled=$true;Direction='Outbound';Action='Allow';Profile='Any'}}
      function Get-NetFirewallApplicationFilter {param([Parameter(ValueFromPipeline)]$InputObject) process {[pscustomobject]@{Program=$testProgram;Package=$testPackage}}}
      function Get-NetFirewallPortFilter {param([Parameter(ValueFromPipeline)]$InputObject) process {[pscustomobject]@{Protocol=$testProtocol;DynamicTarget=$testDynamic;LocalPort='Any';RemotePort=$testPort}}}
      function Get-NetFirewallAddressFilter {param([Parameter(ValueFromPipeline)]$InputObject) process {[pscustomobject]@{LocalAddress='Any';RemoteAddress=$testAddress}}}
      function Get-NetFirewallServiceFilter {param([Parameter(ValueFromPipeline)]$InputObject) process {[pscustomobject]@{Service=$testService}}}
      $first=Get-E1OfflineSealHash; $out=@($first -cmatch '^[a-f0-9]{64}$')
      $testService='PRIVATE_SERVICE'; $out+=((Get-E1OfflineSealHash) -cne $first)
      $testPort='Any'; $out+=((Get-E1OfflineSealHash) -cmatch '^[a-f0-9]{64}$')
      $testService='Any'; $testPackage='PRIVATE_PACKAGE'; $out+=((Get-E1OfflineSealHash) -cmatch '^[a-f0-9]{64}$')
      $testPackage='Any'
      $testPort='Any'; try {$null=Get-E1OfflineSealHash;$out+=$false} catch {$out+=($_.Exception.Message -ceq 'network_rule_tcp')}
      $testPort='443';$testAddress='Any'; try {$null=Get-E1OfflineSealHash;$out+=$false} catch {$out+=($_.Exception.Message -ceq 'network_rule_tcp')}
      $testAddress='198.51.100.2'; try {$null=Get-E1OfflineSealHash;$out+=$false} catch {$out+=($_.Exception.Message -ceq 'network_rule_tcp')}
      $testAddress='192.0.2.1';$testDefault='Allow'; try {$null=Get-E1OfflineSealHash;$out+=$false} catch {$out+=($_.Exception.Message -ceq 'network_outbound_default')}
      $testDefault='Block';$testProtocol='UDP';try {$null=Get-E1OfflineSealHash;$out+=$false} catch {$out+=($_.Exception.Message -ceq 'network_rule_udp')}
      $testProtocol='Any';try {$null=Get-E1OfflineSealHash;$out+=$false} catch {$out+=($_.Exception.Message -ceq 'network_rule_any')}
      foreach($case in @(@('ProximityApps','network_rule_proximity_apps'),@('ProximitySharing','network_rule_proximity_sharing'),
        @('WifiDirectPrinting','network_rule_wifi_printing'),@('WifiDirectDisplay','network_rule_wifi_display'),
        @('WifiDirectDevices','network_rule_wifi_devices'),@('PRIVATE_UNKNOWN','network_rule_dynamic_unknown'))) {
        $testDynamic=$case[0];try {$null=Get-E1OfflineSealHash;$out+=$false} catch {$out+=($_.Exception.Message -ceq $case[1])}
      }
      $out | ConvertTo-Json -Compress`)).toEqual(Array(16).fill(true));
  });

  it('identifies the firewall preflight condition without exporting rule names', async () => {
    expect(await ps(`$tokens=$null; $errors=$null
      $ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(modulePath)},[ref]$tokens,[ref]$errors)
      $fn=$ast.Find({param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Get-E1OfflineSealHash'},$true)
      . ([scriptblock]::Create($fn.Extent.Text))
      $profileCount=3; $enabled=$true; $action='Block'
      function Get-NetFirewallProfile {for($i=0;$i -lt $profileCount;$i++) {[pscustomobject]@{Name="profile$i";Enabled=$enabled;DefaultOutboundAction=$action}}}
      function Get-NetFirewallRule {return @()}
      function Read-E1Json {return @{sha256=('a'*64);value=@{verdict='FAIL';network_mode='restricted'}}}
      $out=@()
      $profileCount=2;try {$null=Get-E1OfflineSealHash} catch {$out+=$_.Exception.Message}
      $profileCount=3;$enabled=$false;try {$null=Get-E1OfflineSealHash} catch {$out+=$_.Exception.Message}
      $enabled=$true;$action='Allow';try {$null=Get-E1OfflineSealHash} catch {$out+=$_.Exception.Message}
      $action='Block';try {$null=Get-E1OfflineSealHash} catch {$out+=$_.Exception.Message}
      $out | ConvertTo-Json -Compress`)).toEqual([
      'network_profile_count', 'network_profile_disabled', 'network_outbound_default', 'network_seal_contract',
    ]);
  });

  it.each(['network_outbound_default', 'none', 'evidence_changed', 'evidence_mismatch', 'json_size'])('audits network without dispatch or writes: %s', async failure => {
    const result = await ps(`$null=Get-Command Invoke-E1OfflineNetworkAuditGuest -ErrorAction Stop
      $r=& (Get-Module evidence1-gradle-offline-probe) {
      function Get-CimInstance {return @{Manufacturer='Microsoft Corporation';Model='Virtual Machine'}}
      function Get-ItemPropertyValue {return '00000000-0000-0000-0000-000000000001'}
      function Assert-E1GuestIdentity {}
      function Assert-E1ForensicSubject {}
      function Assert-E1ForensicMarker {}
      function Read-E1ForensicArtifact {return @{sha256=('a'*64);value=@{}}}
      $script:auditReads=0
      function Get-E1OfflineSealHash {
        $script:auditReads++
        if(${quote(failure)} -cnotin @('none','evidence_changed')) {throw ${quote(failure)}}
        if(${quote(failure)} -ceq 'evidence_changed' -and $script:auditReads -gt 1) {return ('d'*64)}
        return ('a'*64)
      }
      function Invoke-E1OwnedProcess {throw 'FORBIDDEN_PROCESS'}
      function Copy-E1OfflineCache {throw 'FORBIDDEN_COPY'}
      function Set-NetFirewallRule {throw 'FORBIDDEN_FIREWALL'}
      function New-Item {throw 'FORBIDDEN_WRITE'}
      function Write-E1Record {throw 'FORBIDDEN_WRITE'}
      Invoke-E1OfflineNetworkAuditGuest @{Report=@{state='failed'};Commit=('b'*40);Tree=('c'*40);HostComputerName='host';VMId='00000000-0000-0000-0000-000000000001';GuestUser='Evidence1'}
      }
      $safe=ConvertTo-E1OfflineReceipt $r
      $safe | ConvertTo-Json -Depth 8 -Compress`);
    expect(result).toMatchObject({ operation: 'gradle-offline-network-audit', failure_code: failure,
      agent_calls: 0, product_invocations: 0, gradle_invocations: 0, process: null, cache: null,
      validation_pass: false, firewall_modified: false, stage: 'preflight', state: failure === 'none' ? 'passed' : 'failed' });
  });

  it('rejects process/copy claims or unknown data in an audit-only receipt', async () => {
    const mutations = ['$r.gradle_invocations=1', "$r.conclusion='offline_tasks_completed'", "$r.stage='copy_cache'",
      '$r.live_records_created=0', '$r.checks.source_custody=$true', "$r.failure_code='PRIVATE_RULE'",
      "$r.rule_name='PRIVATE_RULE'", "$r.state='passed';$r.failure_code='none'"];
    expect(await ps(`$out=@()
      foreach($mutation in @(${mutations.map(quote).join(',')})) {
        $r=New-E1OfflineReceipt;$r.operation='gradle-offline-network-audit'
        & ([scriptblock]::Create($mutation))
        try {$null=ConvertTo-E1OfflineReceipt $r;$out+=$false} catch {$out+=($_.Exception.Message -ceq 'result_shape')}
      };$out | ConvertTo-Json -Compress`)).toEqual(mutations.map(() => true));
  });

  it('restricts the audit guest entry to reviewed read-only helpers', async () => {
    const commands = await ps(`$tokens=$null;$errors=$null
      $ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(modulePath)},[ref]$tokens,[ref]$errors)
      $fn=$ast.Find({param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Invoke-E1OfflineNetworkAuditGuest'},$true)
      @($fn.FindAll({param($a) $a -is [System.Management.Automation.Language.CommandAst]},$true) | ForEach-Object {$_.GetCommandName()} | Sort-Object -Unique) | ConvertTo-Json -Compress`);
    expect(commands.sort()).toEqual(['New-E1OfflineReceipt', 'Get-CimInstance', 'Get-ItemPropertyValue', 'Assert-E1GuestIdentity',
      'Assert-E1ForensicSubject', 'Assert-E1Fields', 'Read-E1ForensicArtifact', 'Assert-E1ForensicMarker', 'Get-E1OfflineSealHash', 'Get-E1FailureCode'].sort());
  });

  it.each([
    ['empty input', '', 0],
    ['artifact miss', '> No cached version of PRIVATE_GROUP:artifact:1.0 available for offline mode.', 1],
    ['resource miss', '> No cached resource https://private.invalid/PRIVATE?token=PRIVATE available for offline mode.', 1],
    ['repeated mixed misses', [
      '> No cached version of PRIVATE:artifact:1 available for offline mode.',
      '> No cached resource C:\\PRIVATE\\artifact.pom available for offline mode.',
      '> No cached version of PRIVATE:artifact:1 available for offline mode.',
      'BUILD FAILED; PRIVATE_PROSE',
    ].join('\r\n'), 3],
    ['unrelated failures', 'BUILD FAILED\nCould not resolve PRIVATE\nConnection refused\noffline mode\nPRIVATE_PATH', 0],
    ['near-miss diagnostic wording', [
      'No cached versions of PRIVATE available for offline mode.',
      'No cached version PRIVATE available for offline mode.',
      'No cached artifact PRIVATE available for offline mode.',
      'No cached resource PRIVATE available for online mode.',
    ].join('\n'), 0],
    ['split diagnostic lines', [
      'No cached version of PRIVATE available', 'for offline mode.',
      'No cached resource PRIVATE', 'available for offline mode.',
    ].join('\n'), 0],
    ['noncanonical diagnostic case', 'NO CACHED VERSION OF PRIVATE AVAILABLE FOR OFFLINE MODE.', 0],
  ])('returns only an integer offline_cache_miss count for %s', async (_label, text, count) => {
    const result = await ps(`$r=Get-E1OfflineSignals -Text ${quote(text)}
      @{ signals=$r; hashtable=($r -is [hashtable]); integer=($r.offline_cache_miss -is [int] -or $r.offline_cache_miss -is [long]) } | ConvertTo-Json -Depth 4 -Compress`);
    expect(result).toEqual({ signals: { offline_cache_miss: count }, hashtable: true, integer: true });
  });

  it('allows only descendants of modules-2 and the pinned binary distribution', async () => {
    const paths = [
      'caches/modules-2/files-2.1/org.example/tool/1.0/hash/tool.jar',
      'caches/modules-2/metadata-2.107/descriptors/org.example/tool/1.0/hash/descriptor.bin',
      'caches/modules-2/empty.bin',
      'wrapper/dists/gradle-9.4.0-bin/hash/gradle-9.4.0/lib/gradle-launcher.jar',
      'wrapper/dists/gradle-9.4.0-bin/hash/gradle-9.4.0-bin.zip.ok',
    ];
    expect(await ps(`@(${paths.map(quote).join(',')}) | ForEach-Object {
      Test-E1OfflineCacheRelativePath -RelativePath $_
    } | ConvertTo-Json -Compress`)).toEqual(paths.map(() => true));
  });

  it('rejects ambiguous paths, lock files and every ambient Gradle area', async () => {
    const paths = [
      '', 'caches', 'caches/modules-2', 'wrapper/dists/gradle-9.4.0-bin',
      'caches/modules-20/file.jar', 'caches/modules-2-evil/file.jar',
      'wrapper/dists/gradle-9.4.0-bin-evil/file.jar',
      'wrapper/dists/gradle-9.4.0-all/hash/file.zip', 'wrapper/dists/gradle-9.3.0-bin/hash/file.zip',
      'caches/modules-2/cache.lock', 'caches/modules-2/deep/cache.lck', 'caches/modules-2/gc.properties',
      'wrapper/dists/gradle-9.4.0-bin/hash/cache.lock', 'wrapper/dists/gradle-9.4.0-bin/hash/cache.lck',
      'wrapper/dists/gradle-9.4.0-bin/hash/gc.properties',
      'caches/modules-2/deep/CACHE.LOCK', 'caches/modules-2/deep/CACHE.LCK', 'caches/modules-2/deep/GC.PROPERTIES',
      '../caches/modules-2/a.jar', 'caches/modules-2/../a.jar', 'caches/modules-2/a/../../a.jar',
      './caches/modules-2/a.jar', 'caches/modules-2/./a.jar', 'caches/modules-2//a.jar',
      'caches//modules-2/a.jar', 'caches/modules-2/a/',
      'wrapper/dists/gradle-9.4.0-bin/../other/a.jar', 'wrapper/dists/gradle-9.4.0-bin//a.jar',
      'caches\\modules-2\\a.jar', 'caches/modules-2/a\\b.jar',
      '/caches/modules-2/a.jar', 'C:/caches/modules-2/a.jar', 'C:caches/modules-2/a.jar',
      '\\\\server\\share\\caches\\modules-2\\a.jar', '//server/share/caches/modules-2/a.jar',
      'init.gradle', 'init.gradle.kts', 'init.d/private.gradle', 'gradle.properties',
      'daemon/9.4.0/registry.bin', 'caches/build-cache-1/private.bin',
      'caches/9.4.0/fileHashes/fileHashes.bin', 'native/private.dll', 'notifications/9.4.0/release-features.rendered',
      'wrapper/dists/gradle-9.4.0-bin/hash/gradle-9.4.0/init.d/private.gradle',
      'wrapper/dists/gradle-9.4.0-bin/hash/gradle-9.4.0/init.d/private.gradle.kts',
    ];
    const results = await ps(`@(${paths.map(quote).join(',')}) | ForEach-Object {
      Test-E1OfflineCacheRelativePath -RelativePath $_
    } | ConvertTo-Json -Compress`);
    expect(results).toHaveLength(paths.length);
    for (let i = 0; i < paths.length; i++) expect(results[i], paths[i]).toBe(false);
  });

  it('copies only allowed bytes from a synthetic temp cache and preserves the original', async () => {
    const f = fixture();
    const allowed = {
      'caches/modules-2/files-2.1/org.example/tool/1.0/hash/tool.jar': Buffer.from([0, 255, 13, 10, 128]),
      'caches/modules-2/metadata-2.107/descriptor.bin': Buffer.from('PRIVATE_METADATA'),
      'caches/modules-2/empty.bin': Buffer.alloc(0),
      'wrapper/dists/gradle-9.4.0-bin/hash/gradle-9.4.0/lib/launcher.jar': Buffer.from('PRIVATE_WRAPPER'),
    };
    for (const [path, bytes] of Object.entries(allowed)) put(f.source, path, bytes);
    for (const path of [
      'init.gradle', 'init.gradle.kts', 'init.d/private.gradle', 'gradle.properties',
      'daemon/9.4.0/registry.bin', 'caches/build-cache-1/private.bin', 'caches/9.4.0/private.bin',
      'caches/modules-2/cache.lock', 'caches/modules-2/deep/cache.lck', 'caches/modules-2/deep/gc.properties',
      'wrapper/dists/gradle-9.4.0-bin/hash/distribution.zip.lck',
      'wrapper/dists/gradle-9.4.0-all/hash/private.zip', 'wrapper/dists/gradle-9.3.0-bin/hash/private.zip',
    ]) put(f.source, path);
    const before = snapshot(f.source);
    const receipt = await copy(f.source, f.destination);
    expect(receipt.file_count).toBe(Object.keys(allowed).length);
    expect(receipt.bytes).toBe(Object.values(allowed).reduce((sum, bytes) => sum + bytes.length, 0));
    const copiedFiles = Object.keys(snapshot(f.destination)).filter(path => !path.endsWith('/'));
    expect(copiedFiles.sort()).toEqual(Object.keys(allowed).sort());
    for (const [path, bytes] of Object.entries(allowed)) expect(readFileSync(resolve(f.destination, path))).toEqual(bytes);
    expect(snapshot(f.source)).toEqual(before);
    expect(await copy(f.source, resolve(f.dir, 'second-destination'))).toEqual(receipt);
    put(f.destination, Object.keys(allowed)[0], 'changed destination');
    expect(snapshot(f.source)).toEqual(before);
  });

  it('changes the receipt hash when allowed file bytes change without changing byte count', async () => {
    const f = fixture();
    put(f.source, 'caches/modules-2/artifact.jar', 'one');
    const first = await copy(f.source, f.destination);
    put(f.source, 'caches/modules-2/artifact.jar', 'two');
    const second = await copy(f.source, resolve(f.dir, 'changed-destination'));
    expect(second.file_count).toBe(first.file_count);
    expect(second.bytes).toBe(first.bytes);
    expect(second.sha256).not.toBe(first.sha256);
  });

  it('requires the exact installed wrapper URL slot and completion marker before dispatch', async () => {
    const f = fixture();
    const slot = 'wrapper/dists/gradle-9.4.0-bin/lcvyxq3t37f6mx9miaydrrgs';
    put(f.source, `${slot}/gradle-9.4.0/lib/gradle-launcher-9.4.0.jar`);
    // No dispatch occurs in these checks: the wrapper is represented by inert bytes.
    expect(await ps(`$rejected=$false; try {Assert-E1OfflineWrapper ${quote(f.source)}} catch {$rejected=($_.Exception.Message -ceq 'wrapper_cache_missing')}; $rejected | ConvertTo-Json`)).toBe(true);
    put(f.source, `${slot}/gradle-9.4.0-bin.zip.ok`, '');
    expect(await ps(`Assert-E1OfflineWrapper ${quote(f.source)}; $true | ConvertTo-Json`)).toBe(true);
    mkdirSync(resolve(f.source, slot, 'unexpected-directory'));
    expect(await ps(`$rejected=$false; try {Assert-E1OfflineWrapper ${quote(f.source)}} catch {$rejected=($_.Exception.Message -ceq 'wrapper_cache_missing')}; $rejected | ConvertTo-Json`)).toBe(true);
  });

  it('binds the installed SDK from the preserved bootstrap property without copying other values', async () => {
    // Match the existing ops fixtures: hosted TEMP may contain RUNNER~1, which
    // the guest's deliberately narrow path contract rejects.
    const f = fixture('C:/kmp-eval/scratch');
    const sdk = resolve(f.dir, 'sdk');
    put(sdk, 'platforms/android-36/android.jar');
    put(sdk, 'build-tools/36.0.0/source.properties', 'Pkg.Revision=36.0.0');
    put(f.source, 'local.properties', `sdk.dir=${sdk.replaceAll('\\', '/')}\nprivate.value=PRIVATE_SENTINEL\n`);
    const before = snapshot(f.dir);
    const result = await ps(`${sdkFixtureScript(f)}
      Get-E1OfflineSdk ${quote(f.source)} | ConvertTo-Json -Compress`);
    expect(result.root).toBe(sdk);
    expect(result.configuration_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.build_tools_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    expect(snapshot(f.dir)).toEqual(before);
  });

  it('rejects duplicate SDK declarations and SDK paths outside the permitted root', async () => {
    const f = fixture('C:/kmp-eval/scratch');
    put(f.source, 'local.properties', 'sdk.dir=C:/outside/sdk\nsdk.dir=C:/another/sdk\n');
    expect(await ps(`${sdkFixtureScript(f)}
      $rejected=$false; try {Get-E1OfflineSdk ${quote(f.source)} | Out-Null} catch {$rejected=($_.Exception.Message -ceq 'sdk_configuration')}
      $rejected | ConvertTo-Json`)).toBe(true);
    put(f.source, 'local.properties', 'sdk.dir=C:/outside/sdk\n');
    expect(await ps(`${sdkFixtureScript(f)}
      $rejected=$false; try {Get-E1OfflineSdk ${quote(f.source)} | Out-Null} catch {$rejected=($_.Exception.Message -ceq 'path_outside_root')}
      $rejected | ConvertTo-Json`)).toBe(true);
  });

  it('does not assign automatic HOME and keeps Gradle captures outside the Java helper scope', async () => {
    const f = fixture();
    const java = put(f.dir, 'java.exe', 'inert-java');
    expect(await ps(`$tokens=$null; $errors=$null
      $ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(modulePath)},[ref]$tokens,[ref]$errors)
      $assignments=@($ast.FindAll({param($a) $a -is [System.Management.Automation.Language.AssignmentStatementAst] -and $a.Left.Extent.Text -ieq '$HOME'},$true))
      $call=@($ast.FindAll({param($a) $a -is [System.Management.Automation.Language.CommandAst] -and $a.GetCommandName() -ceq 'Invoke-E1Java21Environment'},$true))
      $directory=${quote(f.dir)}; $copy=$directory; $wrapperJar=${quote(java)}
      $probeStdout=Join-Path $directory 'gradle.stdout.txt'; $probeStderr=Join-Path $directory 'gradle.stderr.txt'
      $result=New-E1OfflineReceipt
      $stream=[IO.File]::Open((Join-Path $directory 'record.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
      function Invoke-E1Java21Environment($Directory,$Action) {
        $stdout='wrong-java-stdout'; $stderr='wrong-java-stderr'
        & $Action @{executable=${quote(java)}}
      }
      function Invoke-E1OwnedProcess($Exe,$Arguments,$WorkingDirectory,$Stdout,$Stderr,$Timeout) {
        if($Stdout -cne $probeStdout -or $Stderr -cne $probeStderr -or $Timeout -ne 300 -or $Arguments -notcontains '--offline') {throw 'capture_scope'}
        return @{ExitCode=0;WallSeconds=1.5;TimedOut=$false;CleanupOk=$true}
      }
      try { & ([scriptblock]::Create($call[0].Extent.Text)) } finally {$stream.Dispose()}
      @($assignments.Count,$call.Count,$result.gradle_invocations,$result.process.exit_code) | ConvertTo-Json -Compress`)).toEqual([0, 1, 1, 0]);
  });

  it.each(['empty directory', 'populated directory', 'file'])('refuses an existing destination: %s', async kind => {
    const f = fixture();
    put(f.source, 'caches/modules-2/artifact.jar');
    if (kind === 'file') writeFileSync(f.destination, 'PRIVATE_EXISTING_FILE');
    else {
      mkdirSync(f.destination);
      if (kind === 'populated directory') put(f.destination, 'sentinel', 'PRIVATE_EXISTING_DIRECTORY');
    }
    const before = snapshot(f.dir);
    expect(await rejectsCopy(f.source, f.destination)).toBe(true);
    expect(snapshot(f.dir)).toEqual(before);
  });

  it.each(['junction', 'hardlink'])('rejects a %s in an allowed subtree without following it', async kind => {
    const f = fixture();
    const outside = resolve(f.dir, 'outside');
    const target = put(outside, 'PRIVATE_TARGET.jar');
    const link = resolve(f.source, 'caches/modules-2/linked');
    mkdirSync(dirname(link), { recursive: true });
    if (kind === 'junction') symlinkSync(outside, link, 'junction');
    else linkSync(target, link);
    const before = snapshot(f.source);
    const outsideBefore = snapshot(outside);
    expect(await rejectsCopy(f.source, f.destination)).toBe(true);
    expect(snapshot(f.source)).toEqual(before);
    expect(snapshot(outside)).toEqual(outsideBefore);
    if (existsSync(f.destination)) {
      expect(Object.keys(snapshot(f.destination)).filter(path => !path.endsWith('/'))).toEqual([]);
    }
  });

  it('refuses a junction used as the source root', async () => {
    const f = fixture();
    put(f.source, 'caches/modules-2/artifact.jar');
    const alias = resolve(f.dir, 'source-junction');
    symlinkSync(f.source, alias, 'junction');
    const before = snapshot(f.source);
    expect(await rejectsCopy(alias, f.destination)).toBe(true);
    expect(snapshot(f.source)).toEqual(before);
  });

  it('rejects a file symlink without following it when the host permits creating one', async context => {
    const f = fixture();
    const outside = resolve(f.dir, 'outside');
    const target = put(outside, 'PRIVATE_TARGET.jar');
    const link = resolve(f.source, 'caches/modules-2/linked.jar');
    mkdirSync(dirname(link), { recursive: true });
    try { symlinkSync(target, link, 'file'); }
    catch (error) {
      if (error.code !== 'EPERM') throw error;
      context.skip(); return;
    }
    const before = snapshot(f.source);
    const outsideBefore = snapshot(outside);
    expect(await rejectsCopy(f.source, f.destination)).toBe(true);
    expect(snapshot(f.source)).toEqual(before);
    expect(snapshot(outside)).toEqual(outsideBefore);
    if (existsSync(f.destination)) {
      expect(Object.keys(snapshot(f.destination)).filter(path => !path.endsWith('/'))).toEqual([]);
    }
  });

  for (const path of [modulePath, entryPath]) {
    it(`AST parses ${path} in PowerShell 5.1 when present`, async context => {
      if (!existsSync(path)) { context.skip(); return; }
      expect(await ps(`$tokens=$null; $errors=$null
        $null=[System.Management.Automation.Language.Parser]::ParseFile(${quote(path)}, [ref]$tokens, [ref]$errors)
        ConvertTo-Json -InputObject @($errors | ForEach-Object { $_.Message }) -Compress`, false)).toEqual([]);
    });
  }
});

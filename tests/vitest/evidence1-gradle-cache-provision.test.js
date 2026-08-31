import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const quote = value => `'${value.replaceAll("'", "''")}'`;
const exec = promisify(execFile);

async function ps(body) {
  const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
    if($PSVersionTable.PSVersion.ToString() -notlike '5.1.*'){throw 'requires_ps51'}
    ${['evidence1-validation-ops.psm1', 'evidence1-validation-forensics.psm1', 'evidence1-gradle-offline-probe.psm1', 'evidence1-gradle-cache-provision.psm1'].map(name => `Import-Module ${quote(resolve(root, 'docs/audits', name))} -DisableNameChecking`).join('\n')}
    ${body}`;
  const { stdout, stderr } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    cwd: root, windowsHide: true, timeout: 35_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, PSModulePath: resolve(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') },
  }).catch(error => { throw new Error(error.stderr || `PowerShell exited ${error.code}`); });
  expect(stderr).toBe('');
  return JSON.parse(stdout);
}

async function exercise(mode = 'warm') {
  const parent = 'C:/kmp-eval/scratch';
  mkdirSync(parent, { recursive: true });
  const fixture = mkdtempSync(resolve(parent, 'e1-cache-provision-test-'));
  try {
    return await ps(String.raw`Add-Type 'public static class E1OfflineValidationLease { public static bool Held = true; public static bool Owns(string token) { return Held && token == "test-lease"; } }'
      $r=& (Get-Module evidence1-gradle-cache-provision) {
        param($base,$mode)
        $script:events=@();$script:commands=@();$script:rules=@{};$script:connected=$true;$script:quiet=0
        $script:baseline='a'*64;$script:added=0;$script:removed=0
        $env:USERPROFILE=Join-Path $base 'profile'
        $donor=Join-Path $env:USERPROFILE '.gradle'
        $null=New-Item -ItemType Directory -Path (Join-Path $donor 'caches/modules-2/metadata-2.107') -Force
        [IO.File]::WriteAllText((Join-Path $donor 'caches/modules-2/metadata-2.107/module.bin'),'PRIVATE_METADATA')
        $script:javaPath=Join-Path $base 'java.exe';[IO.File]::WriteAllText($script:javaPath,'PRIVATE_JAVA')
        $script:sdk=Join-Path $base 'sdk';$null=New-Item -ItemType Directory -Path $script:sdk
        if($mode -eq 'init') {[IO.File]::WriteAllText((Join-Path $donor 'init.gradle'),'PRIVATE_INIT')}
        if($mode -eq 'distribution-init') {
          $init=Join-Path $donor 'wrapper/dists/gradle-9.4.0-bin/lcvyxq3t37f6mx9miaydrrgs/gradle-9.4.0/init.d'
          $null=New-Item -ItemType Directory -Path $init -Force
          [IO.File]::WriteAllText((Join-Path $init 'inject.gradle'),'PRIVATE_INIT')
        }
        if($mode -eq 'properties') {[IO.File]::WriteAllText((Join-Path $donor 'gradle.properties'),'systemProp.https.proxyHost=PRIVATE_PROXY')}
        if($mode -eq 'donor-preserve') {[IO.File]::WriteAllText((Join-Path $donor 'gradle.properties'),('# benign configuration'+[Environment]::NewLine+'org.gradle.daemon = false'))}
        $donorProperties=Join-Path $donor 'gradle.properties'
        $donorBefore=if(Test-Path -LiteralPath $donorProperties){[IO.File]::ReadAllText($donorProperties)}else{$null}
        if($mode -eq 'lease') {[E1OfflineValidationLease]::Held=$false}
        function Resolve-E1Path {param($Path)
          if($Path -like 'C:\kmp-eval\scratch\gradle-cache-provision-*') {return Join-Path $base ([IO.Path]::GetFileName($Path))}
          return $Path
        }
        function Get-CimInstance {param($ClassName) @{Manufacturer='Microsoft Corporation';Model='Virtual Machine'}}
        function Get-ItemPropertyValue {param($LiteralPath,$Name) '00000000-0000-0000-0000-000000000001'}
        function Assert-E1GuestIdentity {$script:events+='identity'}
        function Assert-E1ForensicSubject {param($Report,$Commit,$Tree) if($mode -eq 'subject'){throw 'forensic_subject'}}
        function Assert-E1ForensicMarker {param($Marker,$Report)}
        function Read-E1ForensicArtifact {param($Path,$ExpectedSha) @{value=@{};sha256=('b'*64)}}
        function Assert-E1Repo {param($Root,$Commit,$Tree,$Directory) 'c'*40}
        function Get-E1SourceSnapshot {param($Root,$Commit,$Tree,$Directory) @{tree=('c'*40);tracked_sha256=('c'*64);index_sha256=('d'*64)}}
        function Assert-E1SourcePostflight {param($Root,$Commit,$Tree,$Directory,$Before,$Operation) if($mode -eq 'source-drift'){throw 'source_tracked_changed'}}
        function Get-E1RecordsSnapshot {param($HarnessDir) @{keys=@();count=0;sha256=$(if($mode -eq 'records-drift' -and $script:commands.Count){'e'*64}else{'f'*64})}}
        function Get-E1OfflineSdk {param($Source) @{root=$script:sdk;configuration_sha256=('1'*64);build_tools_sha256=('2'*64)}}
        function Assert-E1OfflineQuiescent {param($Source)
          $script:quiet++;$script:events+='quiet'
          if($mode -eq 'busy' -or ($mode -eq 'busy-after' -and $script:commands.Count)){throw 'cache_busy'}
        }
        function Assert-E1OfflineWrapper {param($ProbeGradleHome)}
        function Get-E1OfflineFirewallHash {
          if($script:rules.Count -or ($mode -eq 'firewall-drift' -and $script:commands.Count)){return '9'*64}
          return $script:baseline
        }
        function Get-E1OfflineDisconnectedHash {
          if($script:connected){throw 'network_connected'}
          Get-E1OfflineFirewallHash
        }
        function Resolve-DnsName {param($Name,$Type,[switch]$DnsOnly)
          $script:events+='dns'
          if($mode -eq 'dns'){throw 'PRIVATE_DNS'}
          if($Type -eq 'A') { [pscustomobject]@{IPAddress=$(if($mode -eq 'private-ip'){'127.0.0.1'}else{'142.250.74.14'})} }
          else { [pscustomobject]@{IPAddress='2607:f8b0:4004:c07::5e'} }
        }
        function Get-NetFirewallRule {param($Name,$PolicyStore)
          if($script:rules.ContainsKey($Name)) {$script:rules[$Name]}
        }
        function New-NetFirewallRule {param($Name,$DisplayName,$Group,$Direction,$Action,$Enabled,$Profile,$Program,$Protocol,$RemotePort,$RemoteAddress,$PolicyStore)
          $script:added++;$script:events+='add'
          $journal=Join-Path (Join-Path $base ('gradle-cache-provision-'+('a'*32))) 'warm.started.json'
          if(-not (Test-Path -LiteralPath $journal)){throw 'JOURNAL_MISSING'}
          $j=[IO.File]::ReadAllText($journal)
          if(-not $j.Contains($Name) -or -not $j.Contains($script:baseline)){throw 'JOURNAL_INCOMPLETE'}
          if($Program -ne $script:javaPath -or $Protocol -ne 'TCP' -or $RemotePort -ne 443 -or $Direction -ne 'Outbound' -or $Action -ne 'Allow'){throw 'RULE_SCOPE'}
          $script:rules[$Name]=@{Name=$Name}
          if($mode -eq 'partial-add' -and $script:added -eq 2){throw 'PRIVATE_RULE_CREATE'}
        }
        function Remove-NetFirewallRule {param($Name,$PolicyStore)
          $script:removed++;$script:events+='remove'
          if($mode -eq 'partial-remove' -and $script:removed -eq 1){throw 'PRIVATE_RULE_REMOVE'}
          $script:rules.Remove($Name)
        }
        function Invoke-E1Git {param($Root,$Arguments,$Directory)
          if($Arguments -contains 'clone') {
            $copy=$Arguments[-1];$null=New-Item -ItemType Directory -Path (Join-Path $copy 'gradle/wrapper') -Force
            [IO.File]::WriteAllText((Join-Path $copy 'gradle/wrapper/gradle-wrapper.jar'),'PRIVATE_WRAPPER')
            [IO.File]::WriteAllText((Join-Path $copy 'gradle/wrapper/gradle-wrapper.properties'),(@('distributionUrl=https\://services.gradle.org/distributions/gradle-9.4.0-bin.zip','distributionSha256Sum=60ea723356d81263e8002fec0fcf9e2b0eee0c0850c7a3d7ab0a63f2ccc601f3') -join [Environment]::NewLine))
          }
        }
        function Invoke-E1Java21Environment {param($Directory,$Action) & $Action @{executable=$script:javaPath;home=$base}}
        function Invoke-E1OwnedProcess {param($FileName,$Arguments,$WorkingDirectory,$Stdout,$Stderr,$TimeoutSeconds)
          $script:events+='gradle';$script:commands+=@{args=$Arguments;timeout=$TimeoutSeconds;home=$env:GRADLE_USER_HOME;cwd=$WorkingDirectory}
          if($mode -eq 'transport'){throw 'PRIVATE_PROCESS_ERROR'}
          $log=if($mode -eq 'cache-miss'){'No cached version of PRIVATE:module:1 available for offline mode.'}else{'BUILD SUCCESSFUL'}
          [IO.File]::WriteAllText($Stdout,$log);[IO.File]::WriteAllText($Stderr,'')
          foreach($flavor in @('demo','prod')) {
            if($mode -eq 'certify-missing-xml' -and $flavor -eq 'prod'){continue}
            $dir=Join-Path $WorkingDirectory ('core/domain/build/reports/coverage/test/'+$flavor+'/debug')
            $null=New-Item -ItemType Directory -Path $dir -Force
            $xml=if($mode -eq 'certify-malformed-xml'){'<report>'}else{'<!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd"><report name="fixture"><counter type="LINE" missed="1" covered="1"/></report>'}
            [IO.File]::WriteAllText((Join-Path $dir 'report.xml'),$xml)
          }
          @{ExitCode=$(if($mode -eq 'cache-miss'){1}else{0});WallSeconds=0.5;TimedOut=($mode -eq 'timeout');CleanupOk=($mode -ne 'cleanup')}
        }
        $config=@{Phase='warm';ProvisionId=('a'*32);LeaseToken='test-lease';Commit=('d'*40);Tree=('e'*40);
          VMId='00000000-0000-0000-0000-000000000001';HostComputerName='HOST';GuestUser='runner';Report=@{state='failed'}}
        if($mode -eq 'certify-without-warm') {$config.Phase='certify';$script:connected=$false}
        $warm=Invoke-E1CacheProvisionGuest $config
        $warmPath=Join-Path (Join-Path $base ('gradle-cache-provision-'+('a'*32))) 'warm.result.json'
        $warmBytes=if(Test-Path -LiteralPath $warmPath){[IO.File]::ReadAllText($warmPath)}else{''}
        $result=$warm
        if($mode -in @('certify','certify-connected','certify-binding','replay-certify','certify-missing-xml','certify-malformed-xml')) {
          $config.Phase='certify';$script:connected=($mode -eq 'certify-connected')
          if($mode -eq 'certify-binding'){$config.Commit='0'*40}
          $result=Invoke-E1CacheProvisionGuest $config
          if($mode -eq 'replay-certify') {$result=Invoke-E1CacheProvisionGuest $config}
        }
        if($mode -eq 'replay') {$result=Invoke-E1CacheProvisionGuest $config}
        $raw=[Management.Automation.PSSerializer]::Deserialize([Management.Automation.PSSerializer]::Serialize($result,15))
        $safe=ConvertTo-E1CacheProvisionReceipt $raw
        $copy=Join-Path (Join-Path $base ('gradle-cache-provision-'+('a'*32))) 'certify/gradle-home/caches/modules-2/metadata-2.107/module.bin'
        @{result=$safe;warm=$warm;events=$script:events;commands=$script:commands;rules=$script:rules.Count;removed=$script:removed;added=$script:added;
          copied_metadata=(Test-Path -LiteralPath $copy);lease=[E1OfflineValidationLease]::Owns('test-lease');
          donor_preserved=($(if(Test-Path -LiteralPath $donorProperties){[IO.File]::ReadAllText($donorProperties)}else{$null}) -ceq $donorBefore);
          warm_preserved=($(if(Test-Path -LiteralPath $warmPath){[IO.File]::ReadAllText($warmPath)}else{''}) -ceq $warmBytes)}
      } ${quote(fixture)} ${quote(mode)}
      $r | ConvertTo-Json -Depth 15 -Compress`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== 'win32')('guest cache provisioning (mocked PS 5.1)', { timeout: 45_000 }, () => {
  it('exports the guest and strict host receipt APIs', async () => {
    expect(await ps(`@('Invoke-E1CacheProvisionGuest','ConvertTo-E1CacheProvisionReceipt') | ForEach-Object {(Get-Command $_ -Module evidence1-gradle-cache-provision -ErrorAction Stop).Name} | ConvertTo-Json -Compress`)).toEqual(['Invoke-E1CacheProvisionGuest', 'ConvertTo-E1CacheProvisionReceipt']);
  });

  it('keeps shared helpers exported in the exact host in-memory composition', async () => {
    const names = ['evidence1-validation-ops.psm1', 'evidence1-validation-forensics.psm1', 'evidence1-gradle-offline-probe.psm1', 'evidence1-gradle-cache-provision.psm1'];
    const result = await ps(`$text='';foreach($path in @(${names.map(name => quote(resolve(root, 'docs/audits', name))).join(',')})) {$text += [IO.File]::ReadAllText($path)+[Environment]::NewLine}
      Import-Module (New-Module -Name CacheProvisionComposition -ScriptBlock ([scriptblock]::Create($text))) -DisableNameChecking
      @('Invoke-E1CacheProvisionGuest','ConvertTo-E1CacheProvisionReceipt','Initialize-E1OfflineLease','Assert-E1GuestIdentity','Assert-E1OfflineQuiescent','Get-E1OfflineFirewallHash') | ForEach-Object {
        (Get-Command $_ -Module CacheProvisionComposition -ErrorAction Stop).Name
      } | ConvertTo-Json -Compress`);
    expect(result).toHaveLength(6);
  });

  it('the actual host transport accepts the serialized guest receipt and required safety fields', async () => {
    const { result } = await exercise();
    const transported = await ps(`Import-Module ${quote(resolve(root, 'docs/audits/evidence1-cache-provision-host.psm1'))} -DisableNameChecking
      $r=& (Get-Module evidence1-cache-provision-host) {
        param($json)
        $script:raw=ConvertFrom-Json $json
        function Invoke-Command {param($Session,[switch]$AsJob,$ScriptBlock,$ArgumentList) @{State='Completed'}}
        function Wait-Job {param($Job,$Timeout) $Job}
        function Receive-Job {param($Job) $script:raw}
        function Stop-Job {param($Job)}
        function Remove-Job {param($Job,[switch]$Force)}
        Invoke-E1CacheProvisionTransport @{} @{Phase='warm';ProvisionId=$script:raw.provision_id} $null
      } ${quote(JSON.stringify(result))}
      $r | ConvertTo-Json -Depth 15 -Compress`);
    expect(transported).toEqual(result);
    expect(typeof transported.checks.network_restored).toBe('boolean');
    expect(transported.process).toEqual({ exit_code: 0, wall_seconds: 0.5, timed_out: false, cleanup_ok: true });
  });

  it('warms the full fixed task vector under journaled Java-only egress and restores baseline', async () => {
    const r = await exercise();
    expect(r.result).toMatchObject({ schema: 1, operation: 'gradle-cache-provision', phase: 'warm', state: 'passed', failure_code: 'none', agent_calls: 0, product_calls: 0, live_records: 0, gradle_invocations: 1 });
    expect(r.result.checks).toMatchObject({ guest_identity: true, source_custody: true, records_unchanged: true, postflight: true, network_restored: true });
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0].args).toEqual(expect.arrayContaining([':core:domain:test', ':core:domain:createDemoDebugUnitTestCoverageReport', ':core:domain:createProdDebugUnitTestCoverageReport', '--no-build-cache', '--no-configuration-cache']));
    expect(r.commands[0].args).not.toContain('--offline');
    expect(r.commands[0].args).toContain('-Dorg.gradle.java.installations.auto-download=false');
    expect(r.commands[0].timeout).toBe(600);
    expect(r.commands[0].home).toMatch(/profile[\\/]\.gradle$/);
    expect(r.events.indexOf('add')).toBeLessThan(r.events.indexOf('gradle'));
    expect(r.rules).toBe(0);
    expect(r.lease).toBe(true);
    expect(r.donor_preserved).toBe(true);
    expect(JSON.stringify(r.result)).not.toMatch(/PRIVATE|java\.exe|profile|gradle-cache-provision-test/);
  });

  it('preserves existing benign donor properties byte-for-byte', async () => {
    const r = await exercise('donor-preserve');
    expect(r.result.state).toBe('passed');
    expect(r.donor_preserved).toBe(true);
  });

  it.each(['certify-missing-xml', 'certify-malformed-xml'])('rejects successful Gradle exit with %s', async mode => {
    const r = await exercise(mode);
    expect(r.warm.state).toBe('passed');
    expect(r.result).toMatchObject({ state: 'failed', failure_code: 'coverage_artifacts', process: { exit_code: 0 } });
    expect(r.commands).toHaveLength(2);
  });

  it('reconstructs decorated PowerShell enum and hash strings without forwarding metadata', async () => {
    const result = await ps(`$r=& (Get-Module evidence1-gradle-cache-provision) {New-E1CacheProvisionReceipt 'warm' ('a'*32)}
      foreach($key in @('phase','state','failure_code','provision_id')) {$r[$key]=$r[$key] | Add-Member -NotePropertyName PRIVATE -NotePropertyValue 'SYNTHETIC_SECRET' -PassThru}
      $r.hashes.context_sha256=('b'*64) | Add-Member -NotePropertyName PRIVATE -NotePropertyValue 'SYNTHETIC_SECRET' -PassThru
      $safe=ConvertTo-E1CacheProvisionReceipt $r
      $json=$safe | ConvertTo-Json -Depth 15 -Compress
      @{phase=$safe.phase;state=$safe.state;leaked=($json -match 'PRIVATE|SYNTHETIC_SECRET')} | ConvertTo-Json -Compress`);
    expect(result).toEqual({ phase: 'warm', state: 'failed', leaked: false });
  });

  it('certifies a fresh metadata-complete export offline with no additional firewall mutation', async () => {
    const r = await exercise('certify');
    expect(r.warm.state).toBe('passed');
    expect(r.result).toMatchObject({ phase: 'certify', state: 'passed', checks: { network_disconnected: true, network_restored: true }, cache: { file_count: 1 } });
    expect(r.commands).toHaveLength(2);
    expect(r.commands[1].args).toContain('--offline');
    expect(r.commands[1].timeout).toBe(300);
    expect(r.commands[1].cwd).not.toBe(r.commands[0].cwd);
    expect(r.commands[1].home).not.toBe(r.commands[0].home);
    expect(r.copied_metadata).toBe(true);
    expect(r.added).toBe(4);
  });

  it.each(['lease', 'init', 'distribution-init', 'properties', 'busy', 'subject', 'dns', 'private-ip', 'certify-without-warm'])('rejects %s before any build or firewall mutation', async mode => {
    const r = await exercise(mode);
    expect(r.result.state).toBe('failed');
    expect(r.commands).toHaveLength(0);
    expect(r.added).toBe(0);
  });

  it.each(['replay', 'certify-connected', 'certify-binding'])('never redispatches after %s', async mode => {
    const r = await exercise(mode);
    expect(r.result.state).toBe('failed');
    expect(r.commands).toHaveLength(1);
    expect(r.warm_preserved).toBe(true);
  });

  it('reserves certification once independently from warm', async () => {
    const r = await exercise('replay-certify');
    expect(r.result.failure_code).toBe('attempt_exists');
    expect(r.commands).toHaveLength(2);
  });

  it('cleans up rules even when creation throws after a partial side effect', async () => {
    const r = await exercise('partial-add');
    expect(r.result.state).toBe('failed');
    expect(r.commands).toHaveLength(0);
    expect(r.rules).toBe(0);
    expect(r.result.checks.network_restored).toBe(true);
  });

  it('attempts every rule removal independently and exposes failed restoration', async () => {
    const r = await exercise('partial-remove');
    expect(r.removed).toBe(4);
    expect(r.rules).toBe(1);
    expect(r.result).toMatchObject({ state: 'failed', failure_code: 'network_restore_failed', checks: { network_restored: false } });
  });

  it.each(['timeout', 'cleanup', 'transport', 'cache-miss', 'firewall-drift', 'busy-after', 'source-drift', 'records-drift'])('does not certify readiness for %s and removes owned egress', async mode => {
    const r = await exercise(mode);
    expect(r.result.state).toBe('failed');
    expect(r.rules).toBe(0);
    expect(JSON.stringify(r.result)).not.toMatch(/PRIVATE/);
  });

  it('strictly rejects unknown keys, raw strings, nonzero calls, and inconsistent success', async () => {
    const mutations = ["$r.raw='PRIVATE'", "$r.hashes.path='PRIVATE'", "$r.failure_code='PRIVATE'", '$r.agent_calls=1', '$r.product_calls=1', '$r.live_records=1', '$r.gradle_invocations=2', "$r.phase='other'", "$r.checks.postflight='true'", '$r.checks.network_restored=$null', '$r.checks.Remove(\'network_restored\')', "$r.state='passed'", '$r.offline_signals=@{offline_cache_miss=-1}', '$r.cache=@{file_count=0.5;bytes=1;sha256=(\'a\'*64)}'];
    expect(await ps(`$out=@();foreach($mutation in @(${mutations.map(quote).join(',')})) {
      $r=& (Get-Module evidence1-gradle-cache-provision) {New-E1CacheProvisionReceipt 'warm' ('a'*32)}
      & ([scriptblock]::Create($mutation))
      try {$null=ConvertTo-E1CacheProvisionReceipt $r;$out+=$false}catch{$out+=($_.Exception.Message -ceq 'result_shape')}
    };$out | ConvertTo-Json -Compress`)).toEqual(mutations.map(() => true));
  });
});

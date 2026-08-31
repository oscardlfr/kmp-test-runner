import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const q = value => `'${value.replaceAll("'", "''")}'`;
function ps(body) {
  const text = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Import-Module ${q(resolve(root, 'docs/audits/evidence1-validation-ops.psm1'))} -Force -DisableNameChecking; Import-Module ${q(resolve(root, 'docs/audits/evidence1-validation-forensics.psm1'))} -Force -DisableNameChecking; ${body}`;
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}
const available = process.platform === 'win32';
const env = {
  tool: 'kmp-test', subcommand: 'parallel', exit_code: 3,
  tests: { total: 1, passed: 0, failed: 1, individual_total: 0 },
  coverage: { missed_lines: null, modules_contributing: 0, module_buckets: { with_data: [] } },
  errors: [{ code: 'module_failed', setup_failed: true, message: 'PRIVATE_SECRET' }, { code: 'coverage_data_unavailable', reason: 'report-dispatch-failed' }],
  warnings: [{ code: 'coverage_report_dispatch_failed', message: 'PRIVATE_SECRET' }],
  project_root: 'PRIVATE_SECRET', raw: 'PRIVATE_SECRET',
};
const json = value => `ConvertFrom-E1Json ${q(JSON.stringify(value))}`;
const reportFixture = () => ({ schema: 1, operation: 'wet-v2', state: 'failed', target_commit: 'a'.repeat(40), target_tree: 'b'.repeat(40), source_commit: '7d45eae4f8720a0c77f507712ba2437ff974b6ed', agent_calls: 0, product_invocations: 1, dry_plan_invocations: 0, hashes: { product_stdout_sha256: 'c'.repeat(64) }, failure_code: 'product_contract', checks: { postflight: false } });

describe.skipIf(!available)('readonly wet-gate forensics', { timeout: 30000 }, () => {
  it('separates socket permissions from filesystem denial without exporting repository URLs', () => {
    const result = ps(`Get-E1ForensicGradleSummary ${q([
      '> Could not GET \'https://dl.google.com/dl/android/maven2/PRIVATE_PATH?token=PRIVATE\'.',
      '> java.net.SocketException: Permission denied: connect',
      '> Could not HEAD \'https://repo.maven.apache.org/maven2/PRIVATE\'.',
      '> java.nio.file.AccessDeniedException: C:\\PRIVATE_PATH',
    ].join('\n'))} | ConvertTo-Json -Depth 8 -Compress`);
    expect(result.schema).toBe(2);
    expect(result.signals.network_permission_denied).toBe(1);
    expect(result.signals.socket_error).toBe(1);
    expect(result.signals.filesystem_access_denied).toBe(1);
    expect(result.signals.repository_google).toBe(1);
    expect(result.signals.repository_maven_central).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|https|token|google\.com|maven\.apache/i);
  });

  it('rejects spoofed repository domains and unrelated filesystem prose as network permission', () => {
    const result = ps(`Get-E1ForensicGradleSummary ${q([
      'Could not GET https://dl.google.com.evil.invalid/PRIVATE',
      'Could not GET https://repo.maven.apache.org@evil.invalid/PRIVATE',
      'Could not GET https://evil.invalid/dl.google.com/PRIVATE',
      'Access is denied: C:\\PRIVATE',
      'java.io.FileNotFoundException: C:\\PRIVATE (Permission denied)',
    ].join('\n'))} | ConvertTo-Json -Depth 8 -Compress`);
    expect(result.signals.network_permission_denied).toBe(0);
    expect(result.signals.repository_google).toBe(0);
    expect(result.signals.repository_maven_central).toBe(0);
  });

  it('retains exact historical Gradle schema 1 and rejects cross-version fields', () => {
    expect(ps(`$s=Get-E1ForensicGradleSummary 'BUILD FAILED'; $v1=ConvertFrom-E1Json ($s | ConvertTo-Json -Depth 8)
      $v1.schema=1
      foreach($k in @('network_permission_denied','socket_error','filesystem_access_denied','repository_google','repository_maven_central','repository_gradle_plugins','repository_gradle_distribution')) {$v1.signals.PSObject.Properties.Remove($k)}
      Assert-E1ForensicGradleSummary $v1
      $out=@($s.schema -eq 2)
      $v1.signals | Add-Member -NotePropertyName network_permission_denied -NotePropertyValue 0
      try {Assert-E1ForensicGradleSummary $v1; $out+=$false} catch {$out+=($_.Exception.Message -ceq 'forensic_shape')}
      $s.signals.Remove('socket_error')
      try {Assert-E1ForensicGradleSummary $s; $out+=$false} catch {$out+=($_.Exception.Message -ceq 'forensic_shape')}
      $out | ConvertTo-Json -Compress`)).toEqual([true,true,true]);
  });

  it('classifies deterministic Gradle diagnostics using only closed counts, never log prose', () => {
    const lines = [
      'FAILURE: Build failed with an exception.',
      '* What went wrong:',
      '> Could not resolve all files for configuration PRIVATE_CONFIGURATION.',
      '> Could not GET https://private.example/PRIVATE_TOKEN',
      '> javax.net.ssl.SSLHandshakeException: PKIX path building failed',
      '> java.net.UnknownHostException: PRIVATE_HOST',
      '> Received status code 403 from server: PRIVATE_REASON',
      'C:\\PRIVATE_HOME\\PRIVATE_FILE 2026-08-31T00:00:00Z PRIVATE_COMMAND',
      'BUILD FAILED in 15s',
    ].join('\n');
    const result = ps(`Get-E1ForensicGradleSummary ${q(lines)} | ConvertTo-Json -Depth 8 -Compress`);
    expect(result.schema).toBe(2);
    expect(result.signals.dependency_resolution).toBe(1);
    expect(result.signals.repository_transport).toBe(1);
    expect(result.signals.tls_handshake).toBe(1);
    expect(result.signals.tls_certificate).toBe(1);
    expect(result.signals.dns_failure).toBe(1);
    expect(result.signals.http_forbidden).toBe(1);
    expect(result.signals.build_failed).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|https|2026|What went wrong|exception/i);
  });

  it('distinguishes common Gradle failure signatures without inventing a root-cause verdict', () => {
    const cases = {
      sdk_missing: 'SDK location not found. Define sdk.dir in PRIVATE_PATH',
      java_version: 'Android Gradle plugin requires Java 17 to run.',
      compilation: 'Compilation error. See log for more details',
      plugin_resolution: "Plugin [id: 'PRIVATE_PLUGIN'] was not found in any of the following sources:",
      file_permission: 'java.nio.file.AccessDeniedException: PRIVATE_PATH',
      file_lock: 'Timeout waiting to lock build logic queue.',
      daemon_disappeared: 'Gradle build daemon disappeared unexpectedly',
      memory_exhausted: 'java.lang.OutOfMemoryError: Java heap space',
      connection_timeout: 'java.net.SocketTimeoutException: Read timed out',
      connection_refused: 'java.net.ConnectException: Connection refused',
      task_missing: "Cannot locate tasks that match ':PRIVATE:task'",
      invalid_option: "Unknown command-line option '--PRIVATE'.",
      class_version: 'java.lang.UnsupportedClassVersionError: PRIVATE',
    };
    const result = ps(`$cases=${json(cases)}; $out=@{}; foreach($key in (Get-E1ObjectKeys $cases)) {
      $s=Get-E1ForensicGradleSummary (Get-E1Field $cases $key); Assert-E1ForensicGradleSummary $s; $out[$key]=$s.signals[$key]
    }; $out | ConvertTo-Json -Compress`);
    expect(result).toEqual(Object.fromEntries(Object.keys(cases).map(key => [key, 1])));
    const empty = ps(`Get-E1ForensicGradleSummary 'unclassified PRIVATE log' | ConvertTo-Json -Depth 8 -Compress`);
    expect(Object.values(empty.signals).every(count => count === 0)).toBe(true);
    expect(empty).not.toHaveProperty('root_cause');
  });

  it('rejects free-form fields and coerced Gradle counts after remoting', () => {
    expect(ps(`$out=@(); foreach($bad in @('key','string','fraction','negative','decorated-count','decorated-schema')) {
      $s=Get-E1ForensicGradleSummary 'BUILD FAILED'
      switch($bad) {
        key {$s.PRIVATE='PRIVATE'}
        string {$s.signals.build_failed='1'}
        fraction {$s.signals.build_failed=1.5}
        negative {$s.signals.build_failed=-1}
        decorated-count {$s.signals.build_failed=123; $s.signals.build_failed | Add-Member -NotePropertyName PRIVATE -NotePropertyValue SYNTHETIC_SECRET}
        decorated-schema {$s.schema | Add-Member -NotePropertyName PRIVATE -NotePropertyValue SYNTHETIC_SECRET}
      }
      $s=[Management.Automation.PSSerializer]::Deserialize([Management.Automation.PSSerializer]::Serialize($s,10))
      try { Assert-E1ForensicGradleSummary $s; $out+=$false } catch {$out+=($_.Exception.Message -ceq 'forensic_shape')}
    }; $out | ConvertTo-Json -Compress`)).toEqual([true,true,true,true,true,true]);
  });

  it('preserves known stderr-read facts if persisting a completed forensic receipt fails', () => {
    const result = ps(`$entry=[IO.File]::ReadAllText(${q(resolve(root, 'docs/audits/evidence1-hyperv-read-wet-forensics-direct.ps1'))})
      $tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseInput($entry,[ref]$tokens,[ref]$errors)
      $catch=$ast.Find({param($n) $n -is [Management.Automation.Language.TryStatementAst]},$true).CatchClauses[0].Body.Extent.Text
      $result=@{schema=2;state='passed';failure_code='none';stderr_read=$true;gradle_stderr_read_requested=$true;gradle_diagnostics=(Get-E1ForensicGradleSummary 'BUILD FAILED')}
      $phase='report-write'; $stream=$null
      . ([scriptblock]::Create($catch.Substring(1,$catch.Length-2)))
      $result | ConvertTo-Json -Depth 8 -Compress`);
    expect(result.schema).toBe(2);
    expect(result.state).toBe('failed');
    expect(result.failure_code).toBe('report_write_failed');
    expect(result.stderr_read).toBe(true);
    expect(result.gradle_stderr_read_requested).toBe(true);
    expect(result.gradle_diagnostics.signals.build_failed).toBe(1);
  });

  it('reads only a bounded deterministic Gradle log, hashes it and leaves its bytes intact', () => {
    mkdirSync('C:/kmp-eval/scratch', { recursive: true });
    const dir = mkdtempSync('C:/kmp-eval/scratch/e1-gradle-log-');
    const path = resolve(dir, 'existing.stderr.txt');
    const bytes = Buffer.from('BUILD FAILED\n> java.net.UnknownHostException: PRIVATE_HOST');
    writeFileSync(path, bytes);
    const hash = createHash('sha256').update(bytes).digest('hex');
    try {
      const result = ps(`$r=Read-E1ForensicGradleLog ${q(path)} ''; $out=@(($r.sha256 -ceq '${hash}'),($r.summary.signals.dns_failure -eq 1))
        try {$null=Read-E1ForensicGradleLog ${q(path)} ('0'*64);$out+=$false} catch {$out+=($_.Exception.Message -ceq 'forensic_hash')}
        try {$null=Read-E1ForensicGradleLog ${q(path)} '' 2;$out+=$false} catch {$out+=($_.Exception.Message -ceq 'forensic_size')}
        $out | ConvertTo-Json -Compress`);
      expect(result).toEqual([true,true,true,true]);
      expect(readFileSync(path).equals(bytes)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps Gradle reading opt-in and binds it to the deterministic wet artifact, not any supplied path', () => {
    const receiver = ps('Get-E1ForensicReceiverScript | ForEach-Object ToString | ConvertTo-Json -Compress');
    expect(receiver).toContain("Get-E1Field $Config 'IncludeGradleDiagnostics'");
    expect(receiver).toContain("Read-E1ForensicGradleLog ($prefix + '.stderr.txt')");
    expect(receiver).toContain("Assert-E1Fields $Config.Report @{ state='failed' }");
    expect(receiver).not.toMatch(/Config\.(?:LogPath|ScriptBlock|Command)|Start-Process|Invoke-E1OwnedProcess/);
    const entry = readFileSync(resolve(root, 'docs/audits/evidence1-hyperv-read-wet-forensics-direct.ps1'), 'utf8');
    expect(entry).toContain('[switch]$IncludeGradleDiagnostics');
  });

  it('rejects invalid encoding but accepts an empty deterministic log without manufacturing signals', () => {
    mkdirSync('C:/kmp-eval/scratch', { recursive: true });
    const dir = mkdtempSync('C:/kmp-eval/scratch/e1-gradle-encoding-');
    try {
      const invalid = resolve(dir, 'invalid.stderr.txt');
      const empty = resolve(dir, 'empty.stderr.txt');
      writeFileSync(invalid, Buffer.from([0xff]));
      writeFileSync(empty, '');
      expect(ps(`$code=try {$null=Read-E1ForensicGradleLog ${q(invalid)} ''; 'accepted'} catch {$_.Exception.Message}; $code | ConvertTo-Json -Compress`)).toBe('forensic_encoding');
      const result = ps(`Read-E1ForensicGradleLog ${q(empty)} '' | ConvertTo-Json -Depth 8 -Compress`);
      expect(result.sha256).toBe(createHash('sha256').update('').digest('hex'));
      expect(Object.values(result.summary.signals).every(n => n === 0)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('validates the entire opt-in receipt after transport before exporting any Gradle field', () => {
    expect(ps(`$out=@(); foreach($bad in @('extra','hash','summary','count')) {
      $r=@{marker_sha256=('c'*64);product_sha256=('c'*64);summary=(Get-E1ForensicProductSummary (${json(env)}));gradle_sha256=('d'*64);gradle_summary=(Get-E1ForensicGradleSummary 'BUILD FAILED')}
      switch($bad) {
        extra {$r.PRIVATE='PRIVATE'}
        hash {$r.gradle_sha256=@('d'*64)}
        summary {$r.gradle_summary.PRIVATE='PRIVATE'}
        count {$r.gradle_summary.signals.build_failed='1'}
      }
      $r=[Management.Automation.PSSerializer]::Deserialize([Management.Automation.PSSerializer]::Serialize($r,20))
      try {$null=ConvertTo-E1ForensicReceipt $r ('c'*64) -IncludeGradleDiagnostics; $out+=$false} catch {$out+=($_.Exception.Message -cin @('forensic_shape','forensic_hash'))}
    }; $out | ConvertTo-Json -Compress`)).toEqual([true,true,true,true]);
  });

  it('counts source artifact metadata without reading file contents or exposing names', () => {
    mkdirSync('C:/kmp-eval/scratch', { recursive: true });
    const dir = mkdtempSync('C:/kmp-eval/scratch/e1-inventory-');
    try {
      const runtime = resolve(dir, '.kmp-test-runner');
      mkdirSync(resolve(runtime, 'init-scripts'), { recursive: true });
      mkdirSync(resolve(runtime, 'cache'));
      mkdirSync(resolve(runtime, 'PRIVATE_DIRECTORY'));
      writeFileSync(resolve(runtime, 'cache', `model-${'a'.repeat(40)}.json`), 'PRIVATE_CONTENT');
      writeFileSync(resolve(runtime, 'PRIVATE_FILE.txt'), 'PRIVATE_CONTENT');
      const result = ps(`& (Get-Module evidence1-validation-forensics) {
        function Get-Content { throw 'must_not_read_contents' }
        function Read-E1Json { throw 'must_not_parse_contents' }
        Get-E1ForensicSourceInventory ${q(dir)} | ConvertTo-Json -Depth 8 -Compress
      }`);
      expect(result.counts).toEqual({ model: 1, tasks: 0, report: 0, latest: 0,
        init_directory: 1, empty_init_directory: 1, residual_init_files: 0,
        unknown_files: 1, unknown_directories: 1, unsafe_entries: 0 });
      expect(result.metadata_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|kmp-eval|timestamp/);
      expect(readdirSync(resolve(runtime, 'init-scripts'))).toEqual([]);
      expect(readFileSync(resolve(runtime, 'PRIVATE_FILE.txt'), 'utf8')).toBe('PRIVATE_CONTENT');
      const second = ps(`$s=Get-E1ForensicSourceInventory ${q(dir)}; Assert-E1ForensicInventory $s; $s | ConvertTo-Json -Depth 8 -Compress`);
      expect(second).toEqual(result);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects untrusted inventory shape, enum keys, counts and hashes after transport', () => {
    expect(ps(`$out=@(); foreach($bad in @('key','count','hash','schema')) {
      $s=New-E1ForensicInventory
      $s.metadata_sha256='a'*64
      switch($bad) {
        key {$s.counts.PRIVATE_SECRET=1}
        count {$s.counts.model=-1}
        hash {$s.metadata_sha256=@('a'*64)}
        schema {$s.schema='1'}
      }
      try { Assert-E1ForensicInventory $s; $out+=$false } catch { $out+=($_.Exception.Message -ceq 'forensic_shape') }
    }; $out | ConvertTo-Json -Compress`)).toEqual([true, true, true, true]);
  });

  it('refreshes cached enumeration metadata before hashing an unchanged directory', () => {
    mkdirSync('C:/kmp-eval/scratch', { recursive: true });
    const dir = mkdtempSync('C:/kmp-eval/scratch/e1-inventory-refresh-');
    mkdirSync(resolve(dir, '.kmp-test-runner/cache'), { recursive: true });
    try {
      const result = ps(`& (Get-Module evidence1-validation-forensics) {
        param($root)
        $script:cached=Get-Item -LiteralPath (Join-Path $root '.kmp-test-runner/cache')
        $old=$script:cached.LastWriteTimeUtc
        [IO.Directory]::SetLastWriteTimeUtc($script:cached.FullName,$old.AddMinutes(1))
        $wasStale=($script:cached.LastWriteTimeUtc -eq $old)
        function Get-ChildItem { param($LiteralPath)
          if($LiteralPath -eq (Join-Path $root '.kmp-test-runner')) { $script:cached }
        }
        $first=Get-E1ForensicSourceInventory $root
        $script:cached.Refresh()
        $second=Get-E1ForensicSourceInventory $root
        [IO.Directory]::SetLastWriteTimeUtc($script:cached.FullName,$old.AddMinutes(2))
        $changed=Get-E1ForensicSourceInventory $root
        @{was_stale=$wasStale;hashes_equal=($first.metadata_sha256 -ceq $second.metadata_sha256)
          real_change_detected=($changed.metadata_sha256 -cne $second.metadata_sha256)} | ConvertTo-Json -Compress
      } ${q(dir)}`);
      expect(result).toEqual({ was_stale: true, hashes_equal: true, real_change_detected: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('source inventory receiver verifies identity and repository anchors and has no write or executable dispatch', () => {
    const text = ps('Get-E1ForensicSourceReceiver | ForEach-Object ToString | ConvertTo-Json -Compress');
    expect(text).toContain('Assert-E1GuestIdentity');
    expect(text).toContain("'HEAD^{tree}'");
    expect(text).toContain('7d45eae4f8720a0c77f507712ba2437ff974b6ed');
    expect(text).toContain('metadata_sha256 -cne');
    expect(text).not.toMatch(/New-Item|Set-Content|WriteAll|Remove-Item|Start-Process|kmp-test\.js|cli\.mjs/);
  });

  it('accepts the exact remoting inventory but rejects extra keys and coerced scalars', () => {
    expect(ps(`$s=New-E1ForensicInventory; $s.metadata_sha256='a'*64
      $r=[Management.Automation.PSSerializer]::Deserialize([Management.Automation.PSSerializer]::Serialize($s,10))
      $r.PSComputerName='PRIVATE_HOST'
      $safe=ConvertTo-E1ForensicInventoryReceipt $r
      $out=@(($safe.counts.model -eq 0), ($safe.Keys -notcontains 'PSComputerName'))
      $r.extra='PRIVATE'
      try {$null=ConvertTo-E1ForensicInventoryReceipt $r; $out+=$false} catch {$out+=$true}
      foreach($value in @('1',1.5,-1,129,$true,@(1))) {
        $bad=New-E1ForensicInventory; $bad.metadata_sha256='a'*64; $bad.counts.model=$value
        try {Assert-E1ForensicInventory $bad; $out+=$false} catch {$out+=($_.Exception.Message -ceq 'forensic_shape')}
      }; $out | ConvertTo-Json -Compress`)).toEqual(Array(9).fill(true));
  });

  it('does not descend into unknown directories and identifies residual init files without parsing them', () => {
    mkdirSync('C:/kmp-eval/scratch', { recursive: true });
    const dir = mkdtempSync('C:/kmp-eval/scratch/e1-inventory-residual-');
    try {
      const runtime = resolve(dir, '.kmp-test-runner');
      mkdirSync(resolve(runtime, 'init-scripts'), { recursive: true });
      mkdirSync(resolve(runtime, 'UNKNOWN/raw'), { recursive: true });
      writeFileSync(resolve(runtime, 'UNKNOWN/raw/PRIVATE.jsonl'), 'PRIVATE_CONTENT');
      writeFileSync(resolve(runtime, 'init-scripts/PRIVATE.init.gradle'), 'PRIVATE_CONTENT');
      const result = ps(`Get-E1ForensicSourceInventory ${q(dir)} | ConvertTo-Json -Depth 8 -Compress`);
      expect(result.counts.residual_init_files).toBe(1);
      expect(result.counts.empty_init_directory).toBe(0);
      expect(result.counts.unknown_directories).toBe(1);
      expect(result.counts.unknown_files).toBe(0);
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
      writeFileSync(resolve(runtime, 'init-scripts/SECOND.init.gradle'), 'synthetic');
      const changed = ps(`Get-E1ForensicSourceInventory ${q(dir)} | ConvertTo-Json -Depth 8 -Compress`);
      expect(changed.metadata_sha256).not.toBe(result.metadata_sha256);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('limits metadata enumeration and refuses linked files without following them', () => {
    mkdirSync('C:/kmp-eval/scratch', { recursive: true });
    const dir = mkdtempSync('C:/kmp-eval/scratch/e1-inventory-bounds-');
    try {
      const runtime = resolve(dir, '.kmp-test-runner');
      mkdirSync(runtime);
      const result = ps(`$root=${q(dir)}; $runtime=${q(runtime)}
        $outside=Join-Path $root 'PRIVATE.outside'; [IO.File]::WriteAllText($outside,'PRIVATE_CONTENT')
        $link=Join-Path $runtime 'linked.txt'; $null=New-Item -ItemType HardLink -Path $link -Target $outside
        $s=Get-E1ForensicSourceInventory $root
        $out=@($s.counts.unsafe_entries -eq 1)
        Remove-Item -LiteralPath $link
        foreach($i in 1..129){[IO.File]::WriteAllText((Join-Path $runtime "$i.txt"),'synthetic')}
        try {$null=Get-E1ForensicSourceInventory $root;$out+=$false} catch {$out+=($_.Exception.Message -ceq 'source_artifact_limit')}
        $out | ConvertTo-Json -Compress`);
      expect(result).toEqual([true, true]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('stops consuming an unexpected directory at the first excess entry', () => {
    mkdirSync('C:/kmp-eval/scratch', { recursive: true });
    const dir = mkdtempSync('C:/kmp-eval/scratch/e1-inventory-stream-');
    mkdirSync(resolve(dir, '.kmp-test-runner'));
    try {
      const result = ps(`& (Get-Module evidence1-validation-forensics) {
        param($root)
        $script:consumed=0
        function Get-ChildItem { param($LiteralPath)
          foreach($i in 1..10000) {
            $script:consumed++
            $item=[pscustomobject]@{FullName=(Join-Path $LiteralPath "$i.txt");PSIsContainer=$false;Attributes=0;Length=0;LastWriteTimeUtc=[datetime]'2020-01-01'}
            $item | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
            $item
          }
        }
        $code='none'
        try {$null=Get-E1ForensicSourceInventory $root} catch {$code=$_.Exception.Message}
        @{consumed=$script:consumed;code=$code} | ConvertTo-Json -Compress
      } ${q(dir)}`);
      expect(result).toEqual({ consumed: 129, code: 'source_artifact_limit' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps a complete non-validation receipt when source reader imports fail', () => {
    const entry = resolve(root, 'docs/audits/evidence1-hyperv-read-source-inventory-direct.ps1');
    const result = ps(`function Import-Module { throw 'PRIVATE_IMPORT_FAILURE' }
      $text=& ${q(entry)} -TargetCommit '${'a'.repeat(40)}' -TargetTree '${'b'.repeat(40)}'
      $text | ConvertFrom-Json | ConvertTo-Json -Depth 8 -Compress`);
    expect(result).toMatchObject({ schema: 1, operation: 'source-artifact-inventory', state: 'failed',
      failure_code: 'collector_failed', inventory: null, validation_pass: false, agent_calls: 0,
      product_invocations: 0, guest_writes: 0, source_file_contents_read: false });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('cannot retain a passing source reader receipt after its report write fails', () => {
    mkdirSync('C:/kmp-eval/scratch', { recursive: true });
    const dir = mkdtempSync('C:/kmp-eval/scratch/e1-inventory-write-');
    const entry = resolve(root, 'docs/audits/evidence1-hyperv-read-source-inventory-direct.ps1');
    try {
      const result = ps(`function Import-Module {}
        function Resolve-E1Path { param($Path)
          if([IO.Path]::GetFileName($Path) -like 'INVENTORY-*.json'){return Join-Path ${q(dir)} ([IO.Path]::GetFileName($Path))}
          return ${q(dir)}
        }
        $script:writes=0
        function Write-E1Record { param($Stream,$Record)
          $script:writes++
          if($script:writes -eq 2){throw 'PRIVATE_DISK_FAILURE'}
          & (Get-Module evidence1-validation-ops) {param($s,$r) Write-E1Record $s $r} $Stream $Record
        }
        function Invoke-E1ForensicSourceRead {
          return @{schema=1;operation='source-artifact-inventory';state='passed';failure_code='none';target_commit=$null;target_tree=$null;inventory=$null;hashes=@{};agent_calls=0;product_invocations=0;guest_writes=0;source_file_contents_read=$false;validation_pass=$false}
        }
        $text=& ${q(entry)} -TargetCommit '${'a'.repeat(40)}' -TargetTree '${'b'.repeat(40)}'
        $text | ConvertFrom-Json | ConvertTo-Json -Depth 8 -Compress`);
      expect(result).toMatchObject({ state: 'failed', validation_pass: false, failure_code: 'collector_failed', agent_calls: 0 });
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      const saved = JSON.parse(readFileSync(resolve(dir, files[0]), 'utf8'));
      expect(saved).toEqual(result);
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('projects actual values without losing null/missing/invalid distinctions or emitting free text', () => {
    const result = ps(`Get-E1ForensicProductSummary (${json(env)}) | ConvertTo-Json -Depth 12 -Compress`);
    expect(result.metrics.tests_failed).toEqual({ status: 'recorded', value: 1 });
    expect(result.metrics.missed_lines).toEqual({ status: 'null', value: null });
    expect(result.error_codes.counts.module_failed).toBe(1);
    expect(result.error_codes.counts.coverage_data_unavailable).toBe(1);
    expect(result.coverage_reasons.counts['report-dispatch-failed']).toBe(1);
    expect(result.metrics.module_failed_setup_count.value).toBe(1);
    expect(result.warning_codes.counts.coverage_report_dispatch_failed).toBe(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    const changed = structuredClone(env);
    delete changed.tests.individual_total;
    changed.tests.failed = '1';
    changed.errors[0].code = 'PRIVATE_UNKNOWN_CODE';
    const next = ps(`Get-E1ForensicProductSummary (${json(changed)}) | ConvertTo-Json -Depth 12 -Compress`);
    expect(next.metrics.individual_total.status).toBe('missing');
    expect(next.metrics.tests_failed.status).toBe('invalid');
    expect(next.error_codes.counts.unknown).toBe(1);
    expect(JSON.stringify(next)).not.toContain('PRIVATE');
  });

  it('rejects tampered, extra-field and free-text summaries after transport', () => {
    expect(ps(`$s=Get-E1ForensicProductSummary (${json(env)}); $out=@(); Assert-E1ForensicSummary $s; $out+=$true
      $s.metrics.tests_failed.value='SECRET'; try { Assert-E1ForensicSummary $s; $out+=$false } catch { $out+=$true }
      $s=Get-E1ForensicProductSummary (${json(env)}); $s.error_codes.counts.secret='SECRET'; try { Assert-E1ForensicSummary $s; $out+=$false } catch { $out+=$true }
      $s=Get-E1ForensicProductSummary (${json(env)}); $s.metrics.tests_failed.status='SECRET'; try { Assert-E1ForensicSummary $s; $out+=$false } catch { $out+=$true }
      $out | ConvertTo-Json -Compress`)).toEqual([true, true, true, true]);
  });

  it('rejects array-valued statuses after remoting without copying their free text', () => {
    expect(ps(`$out=@(); foreach ($field in @('error_codes','warning_codes','coverage_reasons')) {
      $s=Get-E1ForensicProductSummary (${json(env)}); $s[$field].status=@('recorded','PRIVATE_SECRET')
      $s=[Management.Automation.PSSerializer]::Deserialize([Management.Automation.PSSerializer]::Serialize($s,20))
      try { Assert-E1ForensicSummary $s; $out+=$false } catch { $out+=$true }
    }; $out | ConvertTo-Json -Compress`)).toEqual([true, true, true]);
  });

  it('requires two scalar hash strings on the remote receipt', () => {
    expect(ps(`$out=@(); foreach ($field in @('marker_sha256','product_sha256')) {
      foreach ($bad in @(@(),$false,@('c'*64))) {
        $r=@{marker_sha256=('c'*64);product_sha256=('c'*64);summary=(Get-E1ForensicProductSummary (${json(env)}))}
        $r[$field]=$bad
        try { $null=ConvertTo-E1ForensicReceipt $r ('c'*64); $out+=$false } catch { $out+=($_.Exception.Message -ceq 'forensic_hash') }
      }
    }; $out | ConvertTo-Json -Compress`)).toEqual([true, true, true, true, true, true]);
  });

  it('reads an existing artifact by hash without writes and rejects wrong hash and oversize', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-forensic-'));
    const path = resolve(dir, 'existing.json');
    const bytes = Buffer.from(JSON.stringify(env));
    writeFileSync(path, bytes);
    const hash = createHash('sha256').update(bytes).digest('hex');
    try {
      // The production path guard is replaced only inside this local synthetic module scope.
      const result = ps(`$m=Get-Module evidence1-validation-forensics; & $m {
        param($path,$hash)
        function Resolve-E1Path { param($Path) return $Path }
        $r=Read-E1ForensicArtifact $path $hash 1048576
        $out=@($r.sha256 -ceq $hash)
        try { $null=Read-E1ForensicArtifact $path ('0'*64) 1048576; $out+=$false } catch { $out+=($_.Exception.Message -ceq 'forensic_hash') }
        try { $null=Read-E1ForensicArtifact $path $hash 2; $out+=$false } catch { $out+=($_.Exception.Message -ceq 'forensic_size') }
        $out | ConvertTo-Json -Compress
      } ${q(path)} '${hash}'`);
      expect(result).toEqual([true, true, true]);
      expect(readFileSync(path).equals(bytes)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    { bytes: Buffer.from([0xff]), expected: 'forensic_encoding' },
    { bytes: Buffer.from('PRIVATE_NOT_JSON'), expected: 'forensic_json' },
  ])('reports $expected without exposing parser messages', ({ bytes, expected }) => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-forensic-invalid-'));
    try {
      const path = resolve(dir, `${expected}.json`);
      writeFileSync(path, bytes);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const result = ps(`& (Get-Module evidence1-validation-forensics) {
        function Resolve-E1Path { param($Path) return $Path }
        try { $null=Read-E1ForensicArtifact ${q(path)} '${hash}'; 'accepted' } catch { $_.Exception.Message }
      } | ConvertTo-Json -Compress`);
      expect(result).toBe(expected);
      expect(readFileSync(path).equals(bytes)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('binds a terminal original report and marker without freshness requirements or inferring missing historical process facts', () => {
    const report = reportFixture();
    const result = ps(`$r=${json(report)}; Assert-E1ForensicSubject $r ('a'*40) ('b'*40); $h=Get-E1ForensicHistory $r
      $m=${json(report)}; Assert-E1ForensicMarker $m $r
      $m.hashes.product_stdout_sha256='d'*64; $rejected=$false; try { Assert-E1ForensicMarker $m $r } catch { $rejected=$true }
      @{history=$h; mismatch_rejected=$rejected} | ConvertTo-Json -Depth 8 -Compress`);
    expect(result.history.process.status).toBe('not-recorded');
    expect(result.history.postflight_failure.status).toBe('not-recorded');
    expect(result.mismatch_rejected).toBe(true);
  });

  it('refuses a mismatched remote module before evaluating its body', () => {
    expect(ps(`$receiver=Get-E1ForensicReceiverScript
      $ok=try { & $receiver "throw 'PRIVATE_EXECUTION'" ('0'*64) "throw 'PRIVATE_EXECUTION'" ('1'*64) @{}; $false } catch { $_.Exception.Message -ceq 'forensic_module_hash' }; $ok | ConvertTo-Json -Compress`)).toBe(true);
  });

  it('preserves schema 2 process and secondary failure facts without reconstructing them from checks', () => {
    const result = ps(`$r=New-E1Result 'wet-v2' ('a'*40) ('b'*40)
      $r.stage='postflight'; $r.product_invocations=1
      Set-E1Failure $r 'primary' 'product_contract'; Set-E1Failure $r 'postflight' 'repo_dirty'
      Set-E1ProcessObservation $r 'product' @{ExitCode=3; WallSeconds=12.5; TimedOut=$false; CleanupOk=$true}
      Get-E1ForensicHistory $r | ConvertTo-Json -Depth 10 -Compress`);
    expect(result).toEqual({
      process: { status: 'recorded', value: { exit_code: 3, wall_seconds: 12.5, timed_out: false, cleanup_ok: true } },
      postflight_failure: { status: 'recorded', value: 'repo_dirty' },
    });
  });

  it('rejects coerced subject schema and array-valued subject fields', () => {
    expect(ps(`$out=@(); foreach ($field in @('schema','state','hash')) {
      $r=${json(reportFixture())}
      if ($field -eq 'schema') { $r.schema='1' }
      if ($field -eq 'state') { $r.state=@('failed') }
      if ($field -eq 'hash') { $r.hashes.product_stdout_sha256=@('c'*64) }
      try { Assert-E1ForensicSubject $r ('a'*40) ('b'*40); $out+=$false } catch { $out+=$true }
    }; $out | ConvertTo-Json -Compress`)).toEqual([true, true, true]);
  });

  it.each([false, true])('reads only approved artifacts through the receiver (Gradle opt-in: %s)', (includeGradle) => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-forensic-receiver-'));
    const productPath = resolve(dir, 'existing.stdout.json');
    const markerPath = resolve(dir, 'existing.json');
    const gradlePath = resolve(dir, 'existing.stderr.txt');
    const gradleBytes = Buffer.from('BUILD FAILED\n> javax.net.ssl.SSLHandshakeException: PKIX path building failed PRIVATE');
    const productBytes = Buffer.from(JSON.stringify(env));
    const report = reportFixture();
    report.hashes.product_stdout_sha256 = createHash('sha256').update(productBytes).digest('hex');
    const markerBytes = Buffer.from(JSON.stringify(report));
    writeFileSync(productPath, productBytes);
    writeFileSync(markerPath, markerBytes);
    writeFileSync(gradlePath, gradleBytes);
    try {
      const result = ps(`$utility=[IO.File]::ReadAllText(${q(resolve(root, 'docs/audits/evidence1-validation-ops.psm1'))})
        $mocks=@'

function Resolve-E1Path([string]$Path) {
  if ($Path -ceq ('C:\\kmp-eval\\scratch\\evidence1-validation-ops\\wet-v2-' + ('a'*40) + '.json')) { return ${q(markerPath)} }
  if ($Path -ceq ('C:\\kmp-eval\\scratch\\evidence1-validation-ops\\wet-v2-' + ('a'*40) + '.stdout.json')) { return ${q(productPath)} }
  ${includeGradle ? `if ($Path -ceq ('C:\\kmp-eval\\scratch\\evidence1-validation-ops\\wet-v2-' + ('a'*40) + '.stderr.txt')) { return ${q(gradlePath)} }
  if ($Path -ceq ${q(gradlePath)}) { return $Path }` : ''}
  if ($Path -ceq ${q(markerPath)} -or $Path -ceq ${q(productPath)}) { return $Path }
  throw 'UNEXPECTED_FILE_READ'
}
function Write-E1Record { throw 'UNEXPECTED_WRITE' }
function Start-E1OwnedProcess { throw 'UNEXPECTED_PROCESS' }
'@
        $forensic=[IO.File]::ReadAllText(${q(resolve(root, 'docs/audits/evidence1-validation-forensics.psm1'))})
        $forensic+=$mocks
        function Get-CimInstance { return @{Manufacturer='Microsoft Corporation'; Model='Virtual Machine'} }
        function Get-ItemPropertyValue { return 'aabababa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }
        $env:COMPUTERNAME='Evidence1Runner'; $env:USERNAME='Evidence1'
        $config=@{ Report=(${json(report)}); Commit=('a'*40); Tree=('b'*40); VMId='aabababa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; HostComputerName='HOST'; GuestUser='Evidence1' }
        ${includeGradle ? '$config.IncludeGradleDiagnostics=$true' : ''}
        $r=& (Get-E1ForensicReceiverScript) $utility (Get-E1Sha256 ([Text.Encoding]::UTF8.GetBytes($utility))) $forensic (Get-E1Sha256 ([Text.Encoding]::UTF8.GetBytes($forensic))) $config
        $remote=[Management.Automation.PSSerializer]::Deserialize([Management.Automation.PSSerializer]::Serialize($r,20))
        ConvertTo-E1ForensicReceipt $remote $config.Report.hashes.product_stdout_sha256 ${includeGradle ? '-IncludeGradleDiagnostics' : ''} | ConvertTo-Json -Depth 14 -Compress`);
      expect(result.product_sha256).toBe(report.hashes.product_stdout_sha256);
      expect(result.marker_sha256).toBe(createHash('sha256').update(markerBytes).digest('hex'));
      expect(result.summary.metrics.envelope_exit.value).toBe(3);
      if (includeGradle) {
        expect(result.gradle_sha256).toBe(createHash('sha256').update(gradleBytes).digest('hex'));
        expect(result.gradle_summary.signals.tls_certificate).toBe(1);
      } else { expect(result).not.toHaveProperty('gradle_summary'); }
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
      expect(readFileSync(productPath).equals(productBytes)).toBe(true);
      expect(readFileSync(markerPath).equals(markerBytes)).toBe(true);
      expect(readFileSync(gradlePath).equals(gradleBytes)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

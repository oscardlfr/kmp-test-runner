import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const sourcePath = resolve(root, 'tools/evidence1/provisioning/evidence1-apply-windows-offline.ps1');
const wrapperPath = resolve(root, 'docs/audits/evidence1-host-apply-canonical-windows-offline.ps1');
const snapshotContractPath = resolve(root, 'docs/audits/evidence1-host-snapshot-contract.psm1');
const runnerPath = resolve(root, 'docs/audits/evidence1-host-elevated-runner.ps1');
const profilePath = resolve(root, 'tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json');
const read = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

function powershell(script, env = {}) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
}

const extractFunctions = String.raw`
$tokens=$null
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:E1_SOURCE,[ref]$tokens,[ref]$errors)
if($errors.Count){$errors|ForEach-Object{Write-Error $_.Message};exit 2}
foreach($name in ($env:E1_FUNCTIONS -split ',')){
  $definition=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true))
  if($definition.Count -ne 1){Write-Error "missing function $name";exit 3}
  . ([scriptblock]::Create($definition[0].Extent.Text))
}
`;

describe('Evidence1 canonical Windows offline apply', () => {
  it('makes offline apply the E2E boundary without changing the product profile', () => {
    const profile = JSON.parse(read(profilePath));
    const product = JSON.parse(read(resolve(root, 'tools/evidence1/provisioning/evidence1-windows-hyperv-v1.json')));
    expect(profile).toMatchObject({
      profile_id: 'evidence1-windows-hyperv-e2e-v1',
      os: { edition: 'Windows 11 Pro', architecture: 'x64', installation_boundary: 'offline-apply' },
      network: { create_state: 'disconnected', bootstrap_state: 'disconnected', checkpoint_state: 'disconnected' },
    });
    expect(profile.phases).toContain('apply-os-offline');
    expect(profile.phases).not.toContain('install-os-unattended');
    expect(product.os.installation_boundary).toBe('operator');
  });

  it('eliminates optical boot input and keeps the apply primitives explicit and mockable', () => {
    const source = read(sourcePath);
    expect(source).not.toMatch(/TypeKey|Msvm_Keyboard|vmconnect|boot key/i);
    for (const functionName of [
      'Get-E1OfflineDiskLayout', 'Initialize-E1OfflineWindowsDisk', 'Invoke-E1DismApplyImage',
      'Invoke-E1DismApplyUnattend', 'Invoke-E1BcdBootFromAppliedImage',
      'New-E1OfflineServicingAccountUnattendXml', 'New-E1OfflineApplyUnattendXml',
      'Write-E1OfflineApplyMarkerAtomically', 'Invoke-E1OfflineApplyRecovery',
    ]) expect(source).toContain(`function ${functionName}`);
    expect(source).toContain("'/Apply-Image'");
    expect(source).toContain("'/CheckIntegrity'");
    expect(source).toContain("'/Verify'");
    expect(source).toContain('/Apply-Unattend:');
    expect(source).toContain("'/f', 'UEFI'");
    expect(source).toContain("$imageIndex -ne 6");
    expect(source).toContain('ConvertFrom-E1DismImageInfo');
    expect(source).toContain("$mountRoot = Join-Path 'C:\\kmp-eval\\scratch' ('.e1om-'");
    expect(source).toContain('Invoke-E1OfflineDiskInitialization $disk $layout $mountRoot');
    expect(source).not.toContain('Invoke-E1OfflineDiskInitialization $disk $layout $workRoot');
  });

  it('uses the PowerShell Direct VMId parameter set without unsupported session options', () => {
    const source = read(sourcePath);
    expect(source).toContain('New-PSSession -VMId $vm.Id -Credential $directCredential -ErrorAction Stop');
    expect(source).not.toContain('New-PSSessionOption');
    expect(source).not.toMatch(/New-PSSession -VMId[^\r\n]*-SessionOption/);
  });

  it.skipIf(process.platform !== 'win32')('waits for the VM to reach terminal Off state after stop dispatch', () => {
    const script = `${extractFunctions}
$script:states=@('Stopping','Stopping','Off')
$script:index=0
function Get-VM { param($Id,$ErrorAction);$value=$script:states[[Math]::Min($script:index,$script:states.Count-1)];$script:index++;[pscustomobject]@{Id=$Id;State=$value} }
function Start-Sleep { param($Milliseconds) }
$result=Wait-E1OfflineVmOff '11111111-1111-1111-1111-111111111111' ([DateTime]::UtcNow.AddSeconds(2))
@{state=[string]$result.State;observations=$script:index}|ConvertTo-Json -Compress
`;
    const result = powershell(script, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'Wait-E1OfflineVmOff' });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ observations: 3, state: 'Off' });
  });

  it.skipIf(process.platform !== 'win32')('generates only specialize and oobeSystem passes under Windows PowerShell 5.1', () => {
    const script = `${extractFunctions}
$profile=[pscustomobject]@{guest=[pscustomobject]@{computer_name='Evidence1E2E';local_user='Evidence1E2E'}}
$hidden=ConvertTo-E1OfflineHiddenPassword 'Fixture!123'
$raw=New-E1OfflineApplyUnattendXml $profile $hidden
[xml]$xml=$raw
$passes=@($xml.unattend.settings|ForEach-Object{[string]$_.pass})
@{passes=$passes;hasWindowsPe=[bool]($passes -ccontains 'windowsPE');containsPlain=$raw.Contains('Fixture!123');containsCleanup=$raw.Contains('DefaultPassword')}|ConvertTo-Json -Compress
`;
    const result = powershell(script, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'ConvertTo-E1OfflineHiddenPassword,New-E1OfflineApplyUnattendXml' });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      containsCleanup: false,
      containsPlain: false,
      hasWindowsPe: false,
      passes: ['specialize', 'oobeSystem'],
    });
    const raw = powershell(`${extractFunctions}
$profile=[pscustomobject]@{guest=[pscustomobject]@{computer_name='Evidence1E2E';local_user='Evidence1E2E'}}
New-E1OfflineApplyUnattendXml $profile 'hidden'
`, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'New-E1OfflineApplyUnattendXml' }).stdout;
    expect(raw).toContain('<LogonCount>1</LogonCount>');
    expect(raw).toContain('<Domain>Evidence1E2E</Domain>');
    expect(raw).not.toContain('<LocalAccounts>');
    expect(raw.match(/<SynchronousCommand\b/g)).toHaveLength(1);
    expect(raw.match(/<CommandLine>/g)).toHaveLength(1);
    expect(raw).toMatch(/<Order>1<\/Order>[\s\S]*<CommandLine>[^<]*reg add [^<]*AutoLogonCount[^<]*REG_DWORD[^<]*\/d 0[^<]*offline-apply-complete\.marker<\/CommandLine>/);
    expect(raw).not.toContain('<Order>2</Order>');
    expect(raw).not.toMatch(/reg delete|del \/f \/q C:\\Windows\\Panther\\Unattend\.xml/);
  });

  it.skipIf(process.platform !== 'win32')('creates the local administrator in the offlineServicing pass', () => {
    const script = `${extractFunctions}
$profile=[pscustomobject]@{guest=[pscustomobject]@{computer_name='Evidence1E2E';local_user='Evidence1E2E'}}
$raw=New-E1OfflineServicingAccountUnattendXml $profile (ConvertTo-E1OfflineHiddenPassword 'Fixture!123')
[xml]$xml=$raw
$settings=@($xml.unattend.settings)
@{pass=[string]$settings[0].pass;containsPlain=$raw.Contains('Fixture!123');hasOfflineAccounts=$raw.Contains('<OfflineUserAccounts>');hasOobe=$raw.Contains('oobeSystem')}|ConvertTo-Json -Compress
`;
    const result = powershell(script, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'ConvertTo-E1OfflineHiddenPassword,New-E1OfflineServicingAccountUnattendXml' });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ containsPlain: false, hasOfflineAccounts: true, hasOobe: false, pass: 'offlineServicing' });
  });

  it.skipIf(process.platform !== 'win32')('recursively removes every bounded documented answer-cache XML', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-answer-cache-'));
    try {
      for (const relative of [
        'Windows/Panther/UnattendGC/deep-unattend.xml',
        'Windows/System32/Sysprep/cache/Autounattend.xml',
        '$Windows.~BT/Sources/Panther/nested/setup-unattend-copy.xml',
      ]) {
        const target = resolve(fixture, relative);
        mkdirSync(resolve(target, '..'), { recursive: true });
        writeFileSync(target, '<sensitive/>');
      }
      const script = `${extractFunctions}
Remove-E1OfflineAnswerCacheFiles $env:E1_WINDOWS_ROOT
$remaining=@(
  (Join-Path $env:E1_WINDOWS_ROOT 'Windows\\Panther'),
  (Join-Path $env:E1_WINDOWS_ROOT 'Windows\\System32\\Sysprep'),
  (Join-Path $env:E1_WINDOWS_ROOT '$Windows.~BT\\Sources\\Panther') |
  Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object {
    Get-ChildItem -LiteralPath $_ -Filter '*unattend*.xml' -File -Recurse -Force
  })
if($remaining.Count){exit 4}
`;
      const result = powershell(script, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'Get-E1OfflineAnswerCacheFiles,Remove-E1OfflineAnswerCacheFiles', E1_WINDOWS_ROOT: fixture });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const boundedRoot = resolve(fixture, 'Windows/Panther/bounded');
      mkdirSync(boundedRoot, { recursive: true });
      for (let index = 0; index < 129; index += 1) writeFileSync(resolve(boundedRoot, `unattend-${index}.xml`), 'x');
      const rejected = powershell(`${extractFunctions}
try { Remove-E1OfflineAnswerCacheFiles $env:E1_WINDOWS_ROOT; exit 4 } catch { if($_.Exception.Message -cne 'offline_answer_cache_bounds_exceeded'){throw}; exit 0 }
`, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'Get-E1OfflineAnswerCacheFiles,Remove-E1OfflineAnswerCacheFiles', E1_WINDOWS_ROOT: fixture });
      expect(rejected.status, `${rejected.stdout}${rejected.stderr}`).toBe(0);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('calculates a deterministic GPT ESP/MSR/Windows/Recovery layout', () => {
    const script = `${extractFunctions}
$layout=Get-E1OfflineDiskLayout 137438953472
$layout|ConvertTo-Json -Depth 5 -Compress
`;
    const result = powershell(script, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'Get-E1OfflineDiskLayout' });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const layout = JSON.parse(result.stdout);
    expect(layout.style).toBe('GPT');
    expect(layout.efi).toMatchObject({ size_bytes: 314572800, filesystem: 'FAT32', label: 'System' });
    expect(layout.msr).toMatchObject({ size_bytes: 16777216, filesystem: null });
    expect(layout.recovery).toMatchObject({ size_bytes: 1073741824, filesystem: 'NTFS', label: 'Recovery' });
    expect(layout.windows.size_bytes).toBeGreaterThan(64 * 1024 ** 3);
    expect(new Set([layout.efi.gpt_type, layout.msr.gpt_type, layout.windows.gpt_type, layout.recovery.gpt_type]).size).toBe(4);
  });

  it.skipIf(process.platform !== 'win32')('uses brace-enclosed GPT type GUIDs accepted by New-Partition', () => {
    const script = `${extractFunctions}
$layout=Get-E1OfflineDiskLayout 137438953472
@($layout.efi.gpt_type,$layout.msr.gpt_type,$layout.windows.gpt_type,$layout.recovery.gpt_type)|ConvertTo-Json -Compress
`;
    const result = powershell(script, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'Get-E1OfflineDiskLayout' });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}',
      '{e3c9e316-0b5c-4db8-817d-f92df00215ae}',
      '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}',
      '{de94bba4-06d1-4d40-a16a-bfd50179d6ac}',
    ]);
  });

  it.skipIf(process.platform !== 'win32')('executes the partition contract through mockable storage cmdlets', () => {
    const script = `${extractFunctions}
$script:calls=@();$script:partition=0
function Initialize-Disk { param($Number,$PartitionStyle,$ErrorAction);$script:calls+=("init:{0}:{1}" -f $Number,$PartitionStyle) }
function New-Partition { param($DiskNumber,$Size,$GptType,[switch]$UseMaximumSize,$ErrorAction);$script:partition++;$script:calls+=("part:{0}:{1}:{2}" -f $GptType,$Size,$UseMaximumSize);[pscustomobject]@{PartitionNumber=$script:partition} }
function Format-Volume { param([Parameter(ValueFromPipeline=$true)]$InputObject,$FileSystem,$NewFileSystemLabel,[switch]$Confirm,[switch]$Force,$ErrorAction);process{$script:calls+=("format:{0}:{1}" -f $FileSystem,$NewFileSystemLabel)} }
function New-Item { param($ItemType,[switch]$Force,$Path);$script:calls+=,"mkdir" }
function Add-PartitionAccessPath { param($DiskNumber,$PartitionNumber,$AccessPath,$ErrorAction);$script:calls+=,"mount:$PartitionNumber" }
$layout=[pscustomobject]@{
 efi=[pscustomobject]@{size_bytes=314572800;gpt_type='efi'};msr=[pscustomobject]@{size_bytes=16777216;gpt_type='msr'}
 windows=[pscustomobject]@{size_bytes=100000000000;gpt_type='windows'};recovery=[pscustomobject]@{size_bytes=1073741824;gpt_type='recovery'}
}
$paths=Initialize-E1OfflineWindowsDisk ([pscustomobject]@{Number=7}) $layout 'C:\\fixture'
@{calls=$script:calls;msr=$paths.msr_partition_number;recovery=$paths.recovery_partition_number}|ConvertTo-Json -Depth 5 -Compress
`;
    const result = powershell(script, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'Initialize-E1OfflineWindowsDisk' });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const record = JSON.parse(result.stdout);
    expect(record.calls[0]).toBe('init:7:GPT');
    expect(record.calls.filter(value => value.startsWith('part:'))).toEqual([
      'part:efi:314572800:False', 'part:msr:16777216:False',
      'part:windows:100000000000:False', 'part:recovery::True',
    ]);
    const source = read(sourcePath);
    expect(source).toContain('| Format-Volume -FileSystem FAT32 -NewFileSystemLabel System');
    expect(source.match(/\| Format-Volume -FileSystem NTFS/g)).toHaveLength(2);
    expect(record.calls.filter(value => value.startsWith('mount:'))).toEqual(['mount:1', 'mount:3', 'mount:4']);
    expect(record).toMatchObject({ msr: 2, recovery: 4 });
  });

  it.skipIf(process.platform !== 'win32')('normalizes storage-provider layout failures to a closed reason', () => {
    const script = `${extractFunctions}
function Initialize-E1OfflineWindowsDisk { throw 'provider-specific failure' }
$observed=$null
$inner=$null
try{Invoke-E1OfflineDiskInitialization ([pscustomobject]@{Number=8}) ([pscustomobject]@{}) 'C:\\fixture';exit 4}catch{$observed=$_.Exception.Message;$inner=$_.Exception.InnerException.Message}
@{observed=$observed;inner=$inner}|ConvertTo-Json -Compress
`;
    const result = powershell(script, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'Invoke-E1OfflineDiskInitialization' });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      inner: 'provider-specific failure',
      observed: 'offline_partition_layout_failed',
    });
  });

  it.skipIf(process.platform !== 'win32')('passes exact pinned ADK DISM and applied-image BCDBoot argv through the bounded command seam', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-offline-argv-'));
    try {
      const windows = resolve(fixture, 'windows');
      const system32 = resolve(windows, 'Windows/System32');
      mkdirSync(system32, { recursive: true });
      writeFileSync(resolve(system32, 'bcdboot.exe'), 'fixture');
      const script = `${extractFunctions}
$script:calls=@()
function Invoke-E1OfflineBoundedNativeCommand { param($Executable,$Arguments,$DeadlineUtc,$WorkingDirectory,$LogRoot,$FailureCode); $script:calls+=,[ordered]@{exe=$Executable;argv=@($Arguments);failure=$FailureCode}; return @{exit_code=0} }
$deadline=[DateTime]::UtcNow.AddMinutes(1)
$null=Invoke-E1DismApplyImage 'C:\\verified-adk\\dism.exe' 'D:\\sources\\install.wim' 6 'W:\\' $deadline 'C:\\private'
$null=Invoke-E1DismApplyUnattend 'C:\\verified-adk\\dism.exe' 'W:\\' 'C:\\private\\offline-user-accounts.xml' $deadline 'C:\\private'
$null=Invoke-E1BcdBootFromAppliedImage $env:E1_WINDOWS 'S:\\' $deadline 'C:\\private'
$script:calls|ConvertTo-Json -Depth 5 -Compress
`;
      const result = powershell(script, {
        E1_SOURCE: sourcePath,
        E1_FUNCTIONS: 'Invoke-E1DismApplyImage,Invoke-E1DismApplyUnattend,Invoke-E1BcdBootFromAppliedImage',
        E1_WINDOWS: windows,
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const calls = JSON.parse(result.stdout);
      expect(calls[0]).toMatchObject({ exe: 'C:\\verified-adk\\dism.exe', failure: 'dism_apply_image_failed' });
      expect(calls[0].argv).toEqual([
        '/English', '/Apply-Image', '/ImageFile:D:\\sources\\install.wim', '/Index:6', '/ApplyDir:W:\\',
        '/CheckIntegrity', '/Verify',
      ]);
      expect(calls[1]).toMatchObject({ exe: 'C:\\verified-adk\\dism.exe', failure: 'dism_apply_unattend_failed' });
      expect(calls[1].argv).toEqual(['/English', '/Image:W:\\', '/Apply-Unattend:C:\\private\\offline-user-accounts.xml']);
      expect(calls[2].exe.replaceAll('\\', '/')).toBe(`${windows.replaceAll('\\', '/')}/Windows/System32/bcdboot.exe`);
      expect(calls[2].argv.slice(-4)).toEqual(['/s', 'S:\\', '/f', 'UEFI']);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('preserves bounded native failure telemetry without retaining raw streams', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-native-failure-'));
    try {
      const script = `${extractFunctions}
$deadline=[DateTime]::UtcNow.AddMinutes(1)
$observed=$null
try {
  Invoke-E1OfflineBoundedNativeCommand "$env:SystemRoot\\System32\\where.exe" @('evidence1-command-that-does-not-exist') $deadline $env:E1_LOG_ROOT $env:E1_LOG_ROOT 'fixture_native_failed' | Out-Null
  exit 4
} catch {
  $observed=[ordered]@{
    reason=$_.Exception.Message
    exit_code=$script:E1OfflineNativeFailure.exit_code
    stdout_sha256=$script:E1OfflineNativeFailure.stdout_sha256
    stderr_sha256=$script:E1OfflineNativeFailure.stderr_sha256
    raw_count=@(Get-ChildItem -LiteralPath $env:E1_LOG_ROOT -Filter '.native-*' -File -ErrorAction SilentlyContinue).Count
  }
}
$observed|ConvertTo-Json -Compress
`;
      const result = powershell(script, {
        E1_SOURCE: sourcePath,
        E1_FUNCTIONS: 'Quote-E1OfflineNativeArgument,Get-E1OfflineNativeStreamIdentity,Get-E1OfflineNativeTextIdentity,Assert-E1OfflineDeadline,Invoke-E1OfflineBoundedNativeCommand',
        E1_LOG_ROOT: fixture,
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        exit_code: 1,
        raw_count: 0,
        reason: 'fixture_native_failed',
        stderr_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        stdout_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(result.stdout).not.toContain('bounded failure');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('captures only bounded redacted high-signal failure diagnostics when requested', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-native-diagnostic-'));
    try {
      const script = `${extractFunctions}
$deadline=[DateTime]::UtcNow.AddMinutes(1)
try {
  Invoke-E1OfflineBoundedNativeCommand "$env:SystemRoot\\System32\\cmd.exe" @('/d','/c','echo Error: invalid C:\\private\\answer.xml & echo password=must-not-appear & exit /b 5') $deadline $env:E1_LOG_ROOT $env:E1_LOG_ROOT 'fixture_native_failed' -CaptureFailureDiagnostic | Out-Null
  exit 4
} catch {
  $script:E1OfflineNativeFailure.diagnostic_lines|ConvertTo-Json -Compress
}
`;
      const result = powershell(script, {
        E1_SOURCE: sourcePath,
        E1_FUNCTIONS: 'Quote-E1OfflineNativeArgument,Get-E1OfflineNativeTextIdentity,Get-E1OfflineSanitizedFailureLines,Assert-E1OfflineDeadline,Invoke-E1OfflineBoundedNativeCommand',
        E1_LOG_ROOT: fixture,
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('Error: invalid [REDACTED_PATH]');
      expect(result.stdout).not.toMatch(/private|answer\.xml|password|must-not-appear/i);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('creates the authorization marker once and refuses overwrite', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-offline-marker-'));
    try {
      const marker = resolve(fixture, 'custody/marker.json');
      const script = `${extractFunctions}
Write-E1OfflineApplyMarkerAtomically $env:E1_MARKER ([ordered]@{schema=1;authorized_start_count=1})
try { Write-E1OfflineApplyMarkerAtomically $env:E1_MARKER ([ordered]@{schema=2}); exit 4 } catch { if($_.Exception.Message -cne 'offline_apply_authorization_already_consumed'){throw} }
Get-Content -LiteralPath $env:E1_MARKER -Raw
`;
      const result = powershell(script, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'Write-E1OfflineApplyMarkerAtomically', E1_MARKER: marker });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ schema: 1, authorized_start_count: 1 });
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('enforces the end-to-end deadline as a closed reason', () => {
    const script = `${extractFunctions}
$observed=$null
try { Assert-E1OfflineDeadline ([DateTime]::UtcNow.AddDays(-1)) } catch { $observed=$_.Exception.Message }
if($observed -cne 'offline_apply_deadline_exceeded'){Write-Error "unexpected: $observed";exit 4}
`;
    const result = powershell(script, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'Assert-E1OfflineDeadline' });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('rejects stale or future InspectCreated custody before mutation', () => {
    const script = `${extractFunctions}
function Test-E1StrictJsonInteger { param($Value,$Expected); return $Value -is [int] -and $Value -eq $Expected }
$now=[DateTime]::Parse('2026-09-11T12:00:00Z').ToUniversalTime()
$receipt=[pscustomobject]@{
 schema=1;verdict='PASS';mode='InspectCreated';profile_id='evidence1-windows-hyperv-e2e-v1'
 profile_sha256=('a'*64);input_lock_sha256=('b'*64);vm_id='11111111-1111-1111-1111-111111111111'
 vm_state='Off';vhd_partition_style='RAW';network_state='disconnected';original_iso_is_only_dvd=$true
 drift_fields=@();mutation_performed=$false;inference_sessions_consumed=0;generated_at_utc='2026-09-11T11:59:00.000Z'
}
Assert-E1CreatedInspectionReceipt $receipt ('a'*64) ('b'*64) $receipt.vm_id $now $true
$receipt.generated_at_utc='2026-09-11T11:00:00.000Z'
try{Assert-E1CreatedInspectionReceipt $receipt ('a'*64) ('b'*64) $receipt.vm_id $now $true;exit 4}catch{if($_.Exception.Message -cne 'created_inspection_receipt_stale'){throw}}
$receipt.generated_at_utc='2026-09-11T12:02:00.000Z'
try{Assert-E1CreatedInspectionReceipt $receipt ('a'*64) ('b'*64) $receipt.vm_id $now $true;exit 5}catch{if($_.Exception.Message -cne 'created_inspection_receipt_time_invalid'){throw}}
exit 0
`;
    const result = powershell(script, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'Assert-E1CreatedInspectionReceipt' });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('strictly binds a consumption marker to every custody hash and VM id', () => {
    const script = `${extractFunctions}
function Test-E1StrictJsonInteger { param($Value,$Expected); return $Value -is [int] -and $Value -eq $Expected }
$RequiredProfileId='evidence1-windows-hyperv-e2e-v1'
$marker=[pscustomobject]@{schema=1;profile_id='evidence1-windows-hyperv-e2e-v1';vm_id='11111111-1111-1111-1111-111111111111';profile_sha256=('a'*64);input_lock_sha256=('b'*64);created_inspection_receipt_sha256=('c'*64);guest_credential_sha256=('d'*64);consumed_at_utc='2026-09-11T12:00:00.000Z';authorized_start_count=1}
Assert-E1OfflineApplyMarker $marker ('a'*64) ('b'*64) ('c'*64) ('d'*64) $marker.vm_id ([DateTime]'2026-09-11T12:01:00Z')
$marker.guest_credential_sha256=('e'*64)
try{Assert-E1OfflineApplyMarker $marker ('a'*64) ('b'*64) ('c'*64) ('d'*64) $marker.vm_id ([DateTime]'2026-09-11T12:01:00Z');exit 4}catch{if($_.Exception.Message -cne 'offline_apply_marker_binding_mismatch'){throw}}
exit 0
`;
    const result = powershell(script, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'Assert-E1OfflineApplyMarker' });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('revalidates the complete fixed VM topology and fails on CPU drift', () => {
    const script = `${extractFunctions}
$script:cpu=2
function Get-VMProcessor { param($VM,$ErrorAction);[pscustomobject]@{Count=$script:cpu} }
function Get-VMMemory { param($VM,$ErrorAction);[pscustomobject]@{DynamicMemoryEnabled=$false} }
function Get-VMSecurity { param($VM,$ErrorAction);[pscustomobject]@{TpmEnabled=$true} }
function Get-VMFirmware { param($VM,$ErrorAction);[pscustomobject]@{SecureBoot='On';SecureBootTemplate='MicrosoftWindows'} }
function Get-VMSnapshot { param($VM,$ErrorAction);@() }
function Get-VMHardDiskDrive { param($VM,$ErrorAction);[pscustomobject]@{Path='C:\\fixture\\Evidence1-Runner-E2E\\Evidence1-Runner-E2E.vhdx'} }
function Get-VHD { param($Path,$ErrorAction);[pscustomobject]@{VhdType='Dynamic';Size=137438953472;Attached=$false} }
function Get-VMDvdDrive { param($VM,$ErrorAction);[pscustomobject]@{Path='C:\\fixture\\Evidence1-Runner-E2E\\media\\windows.iso'} }
function Get-VMNetworkAdapter { param($VM,$ErrorAction);[pscustomobject]@{SwitchName=''} }
function Get-E1FileIdentity { param($Path,$Sha,$Bytes,$Label);[pscustomobject]@{sha256=$Sha;bytes=$Bytes} }
$profile=[pscustomobject]@{vm=[pscustomobject]@{name='Evidence1-Runner-E2E';root='C:\\fixture';generation=2;processor_count=2;startup_memory_bytes=4294967296;dynamic_memory=$false;automatic_checkpoints=$false;checkpoint_type='Disabled';secure_boot_template='MicrosoftWindows';v_tpm=$true;vhd_size_bytes=137438953472}}
$plan=[pscustomobject]@{iso=[pscustomobject]@{sha256=('a'*64);bytes=100}}
$vm=[pscustomobject]@{Id='11111111-1111-1111-1111-111111111111';Name='Evidence1-Runner-E2E';State='Off';Generation=2;MemoryStartup=4294967296;AutomaticCheckpointsEnabled=$false;CheckpointType='Disabled'}
$contract=Assert-E1OfflineVmTopology $vm $profile $plan $vm.Id $true $true
if($contract.vhd_path -cnotmatch 'Evidence1-Runner-E2E.vhdx$'){exit 3}
$script:cpu=1
try{Assert-E1OfflineVmTopology $vm $profile $plan $vm.Id $true $true;exit 4}catch{if($_.Exception.Message -cne 'vm_processor_contract_invalid'){throw}}
exit 0
`;
    const result = powershell(script, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'Assert-E1OfflineVmTopology' });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('sets and reads back the exact recovery GPT attributes', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-gpt-attrs-'));
    try {
      const script = `${extractFunctions}
$script:stdout='Attrib: 0X8000000000000001';$script:removed=$false;$script:diskpart=@()
$script:partition=[pscustomobject]@{GptType='{de94bba4-06d1-4d40-a16a-bfd50179d6ac}';IsHidden=$true;NoDefaultDriveLetter=$false;DriveLetter=[char]0;AccessPaths=@('\\\\?\\Volume{11111111-1111-1111-1111-111111111111}\\')}
function Invoke-E1OfflineBoundedNativeCommand { param($Executable,$Arguments,$DeadlineUtc,$WorkingDirectory,$LogRoot,$FailureCode,[switch]$CaptureStdoutText);$script:diskpart=@(Get-Content -LiteralPath $Arguments[1]);[pscustomobject]@{exit_code=0;stdout_text=$script:stdout} }
function Remove-PartitionAccessPath { param($DiskNumber,$PartitionNumber,$AccessPath,$ErrorAction);$script:removed=$true }
function Update-HostStorageCache { param($ErrorAction) }
function Get-Partition { param($DiskNumber,$PartitionNumber,$ErrorAction);$script:partition }
$result=Set-E1OfflineRecoveryGptAttributes 7 4 'R:\\' ([DateTime]::UtcNow.AddMinutes(1)) $env:E1_LOG_ROOT
if(-not $script:removed -or $script:diskpart -cnotcontains 'remove all' -or -not $result.required -or $result.attributes_hex -cne '0x8000000000000001' -or $result.volume_guid_access_path_count -ne 1 -or $result.unexpected_access_path_count -ne 0){exit 3}
$script:partition.DriveLetter='R'
try{Set-E1OfflineRecoveryGptAttributes 7 4 'R:\\' ([DateTime]::UtcNow.AddMinutes(1)) $env:E1_LOG_ROOT;exit 7}catch{if($_.Exception.Message -cne 'recovery_gpt_attributes_mismatch'){throw}}
$script:partition.DriveLetter=[char]0
$script:partition.AccessPaths=@('R:\\')
try{Set-E1OfflineRecoveryGptAttributes 7 4 'R:\\' ([DateTime]::UtcNow.AddMinutes(1)) $env:E1_LOG_ROOT;exit 4}catch{if($_.Exception.Message -cne 'recovery_gpt_attributes_mismatch'){throw}}
$script:partition.AccessPaths=@('C:\\unexpected-mount\\')
try{Set-E1OfflineRecoveryGptAttributes 7 4 'R:\\' ([DateTime]::UtcNow.AddMinutes(1)) $env:E1_LOG_ROOT;exit 5}catch{if($_.Exception.Message -cne 'recovery_gpt_attributes_mismatch'){throw}}
$script:partition.AccessPaths=@('\\\\?\\Volume{11111111-1111-1111-1111-111111111111}\\')
$script:stdout='Attrib: 0X8000000000000000'
try{Set-E1OfflineRecoveryGptAttributes 7 4 'R:\\' ([DateTime]::UtcNow.AddMinutes(1)) $env:E1_LOG_ROOT;exit 6}catch{if($_.Exception.Message -cne 'recovery_gpt_attributes_mismatch'){throw}}
exit 0
`;
      const result = powershell(script, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'Set-E1OfflineRecoveryGptAttributes', E1_LOG_ROOT: fixture });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('uses an isolated registry hive name for each offline recovery', () => {
    const script = `${extractFunctions}
$script:calls=@()
function Remove-E1OfflineAnswerCacheFiles { param($WindowsRoot) }
function Test-Path { param($LiteralPath,$PathType);$true }
function Invoke-E1OfflineBoundedNativeCommand {
  param($Executable,$Arguments,$DeadlineUtc,$WorkingDirectory,$LogRoot,$FailureCode)
  $script:calls+=,[pscustomobject]@{executable=$Executable;arguments=@($Arguments);failure_code=$FailureCode}
  [pscustomobject]@{exit_code=0}
}
function Remove-ItemProperty { param($LiteralPath,$Name,[switch]$Force,$ErrorAction) }
function Get-ItemProperty { param($LiteralPath,$Name,$ErrorAction);$null }
$null=Clear-E1OfflineAnswerState 'C:\fixture' ([DateTime]::UtcNow.AddMinutes(1)) 'C:\logs'
$script:calls|ConvertTo-Json -Depth 5 -Compress
`;
    const result = powershell(script, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'Clear-E1OfflineAnswerState' });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const calls = JSON.parse(result.stdout);
    expect(calls).toHaveLength(3);
    expect(calls[0].arguments).toEqual(['unload', 'HKLM\\E1OfflineRecovery']);
    expect(calls[1].arguments[0]).toBe('load');
    expect(calls[1].arguments[1]).toMatch(/^HKLM\\E1OfflineRecovery-[0-9a-f]{32}$/);
    expect(calls[2].arguments).toEqual(['unload', calls[1].arguments[1]]);
  });

  it.skipIf(process.platform !== 'win32')('accepts only the new exact authorization phrase', () => {
    const script = `${extractFunctions}
$wrong=$null
try { Assert-E1OfflineApplyAuthorization 'wrong' } catch { $wrong=$_.Exception.Message }
if($wrong -cne 'exact_offline_apply_authorization_required'){exit 4}
Assert-E1OfflineApplyAuthorization 'authorize exactly one evidence1 e2e windows offline apply'
`;
    const result = powershell(script, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'Assert-E1OfflineApplyAuthorization' });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const wrapper = read(wrapperPath);
    expect(wrapper.indexOf("if ($AuthorizationPhrase -cne $RequiredPhrase)")).toBeLessThan(wrapper.indexOf('$inputLockFull = Assert-PathInside'));
  });

  it.skipIf(process.platform !== 'win32')('rejects paths outside the canonical scratch root', () => {
    const script = String.raw`
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:E1_WRAPPER,[ref]$tokens,[ref]$errors)
$definition=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-PathInside'},$true))
if($errors.Count -or $definition.Count -ne 1){exit 2}
. ([scriptblock]::Create($definition[0].Extent.Text))
$inside=Assert-PathInside 'C:\kmp-eval\scratch\offline\receipt.json' 'C:\kmp-eval\scratch\'
$outside=$null
try { Assert-PathInside 'C:\kmp-eval\scratch-escape\receipt.json' 'C:\kmp-eval\scratch\' } catch { $outside=$_.Exception.Message }
if($inside -cne 'C:\kmp-eval\scratch\offline\receipt.json' -or $outside -cne 'canonical_offline_apply_private_path_outside_scratch'){exit 4}
`;
    const result = powershell(script, { E1_WRAPPER: wrapperPath });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('performs bounded RecoveryOnly cleanup through mockable seams', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-offline-recovery-'));
    try {
      const credential = resolve(fixture, 'credential.clixml');
      writeFileSync(credential, 'dpapi-fixture');
      const vmRoot = resolve(fixture, 'vm-root');
      const marker = resolve(vmRoot, 'Evidence1-Runner-E2E/custody/windows-offline-apply-1.consumed.json');
      mkdirSync(resolve(marker, '..'), { recursive: true });
      writeFileSync(marker, '{}');
      const script = `${extractFunctions}
$RequiredProfileId='evidence1-windows-hyperv-e2e-v1';$script:calls=@();$script:emptyDisk=$false
function Assert-E1Administrator {}
function Import-Module { param($Name,$ErrorAction) }
function Get-E1ProvisioningPlan { param($ProfilePath,$InputLockPath,[switch]$SkipHostDependencyFileIdentity,[switch]$AllowSealedRuntimeCommitDrift);$script:calls+=,"plan-skip-host:$([bool]$SkipHostDependencyFileIdentity):drift:$([bool]$AllowSealedRuntimeCommitDrift)";[pscustomobject]@{profile=[pscustomobject]@{profile_id=$RequiredProfileId;os=[pscustomobject]@{installation_boundary='offline-apply'};guest=[pscustomobject]@{local_user='Evidence1E2E'};vm=[pscustomobject]@{name='Evidence1-Runner-E2E';root=$env:E1_VM_ROOT}};iso=[pscustomobject]@{sha256=('a'*64);bytes=1};approved_manifest=[pscustomobject]@{git_commit=('a'*40);runtime_source_git_commit=('b'*40);runtime_commit_drift_accepted=$true}} }
function Get-E1Sha256 { param($Path);if($Path -like '*credential*'){return ('d'*64)};if($Path -like '*consumed.json'){return ('m'*64)};if($Path -like '*lock*'){return ('b'*64)};return ('a'*64) }
function Read-E1LockedJsonSnapshot { param($Path,$Label);if($Path -like '*consumed.json'){return [pscustomobject]@{sha256=('m'*64);document=[pscustomobject]@{}}};return [pscustomobject]@{sha256=('c'*64);document=[pscustomobject]@{vm_id='11111111-1111-1111-1111-111111111111'}} }
function Import-Clixml { param($LiteralPath);$secure=[Security.SecureString]::new();$secure.AppendChar('x');[pscredential]::new('Evidence1E2E',$secure) }
function Assert-E1CreatedInspectionReceipt { param($Receipt,$ProfileSha,$LockSha,$VmId,$Now,$Fresh);$script:calls+=,"inspection:$Fresh" }
function Assert-E1OfflineApplyMarker { param($Marker,$ProfileSha,$LockSha,$InspectionSha,$CredentialSha,$VmId,$Now);$script:calls+=,'marker-bound' }
function Get-E1OfflineRecoveryVm { param($Profile,$ExpectedVmId);$script:calls+=,'resolve-recovery-vm';[pscustomobject]@{vm=[pscustomobject]@{Name='Evidence1-Runner-E2E';State='Off';Id='11111111-1111-1111-1111-111111111111'};registration_repaired=$false} }
function Get-VM { param($Id,$ErrorAction);[pscustomobject]@{Name='Evidence1-Runner-E2E';State='Off';Id='11111111-1111-1111-1111-111111111111'} }
function Assert-E1OfflineVmTopology { param($VM,$Profile,$Plan,$VmId,$RequireOff,$RequireDetached);$script:calls+=("topology:{0}:{1}" -f $RequireOff,$RequireDetached);[pscustomobject]@{vhd_path=(Join-Path (Join-Path $env:E1_VM_ROOT 'Evidence1-Runner-E2E') 'Evidence1-Runner-E2E.vhdx');iso_path=(Join-Path (Join-Path (Join-Path $env:E1_VM_ROOT 'Evidence1-Runner-E2E') 'media') 'windows.iso')} }
function Stop-E1OfflineApplyVmBounded { param($VM,$Seconds);$script:calls+=,"stop:$Seconds" }
function Dismount-VHD { param($Path,$ErrorAction);$script:calls+=,'dismount-vhd' }
function Dismount-DiskImage { param($ImagePath,$ErrorAction);$script:calls+=,'dismount-iso' }
function Mount-VHD { param($Path,[switch]$Passthru,$ErrorAction);$script:calls+=,'mount-vhd';[pscustomobject]@{DiskNumber=7} }
function Get-Disk { param($Number,$ErrorAction);[pscustomobject]@{Number=7;PartitionStyle='GPT'} }
function Get-Partition { param($DiskNumber,$ErrorAction);if($script:emptyDisk){return @()};[pscustomobject]@{PartitionNumber=3} }
function Get-Volume { param($InputObject,$ErrorAction);process{[pscustomobject]@{FileSystemLabel='Windows'}} }
function Add-PartitionAccessPath { param($DiskNumber,$PartitionNumber,$AccessPath,$ErrorAction);$script:calls+=,'mount-windows' }
function Clear-E1OfflineAnswerState { param($WindowsRoot,$DeadlineUtc,$LogRoot);$script:calls+=,'clear-answer';[pscustomobject]@{answer_files_absent=$true;autologon_values_absent=$true} }
function Get-DiskImage { param($ImagePath,$ErrorAction);[pscustomobject]@{Attached=$false} }
function Write-E1ReceiptAtomically { param($Path,$Value);$script:calls+=,"receipt:$($Value.reason_code)" }
Invoke-E1OfflineApplyRecovery 'profile.json' 'lock.json' $env:E1_CREDENTIAL 'inspection.json' $env:E1_RECEIPT 'elevated_runner_child_timeout'
$script:emptyDisk=$true
Invoke-E1OfflineApplyRecovery 'profile.json' 'lock.json' $env:E1_CREDENTIAL 'inspection.json' $env:E1_RECEIPT_EMPTY 'elevated_runner_child_failure'
$script:calls|ConvertTo-Json -Compress
`;
      const result = powershell(script, {
        E1_SOURCE: sourcePath,
        E1_FUNCTIONS: 'Invoke-E1OfflineApplyRecovery',
        E1_VM_ROOT: vmRoot,
        E1_CREDENTIAL: credential,
        E1_RECEIPT: resolve(fixture, 'terminal.json'),
        E1_RECEIPT_EMPTY: resolve(fixture, 'terminal-empty.json'),
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const calls = JSON.parse(result.stdout);
      expect(calls).toEqual(expect.arrayContaining([
        'plan-skip-host:True:drift:True',
        'stop:30', 'dismount-vhd', 'dismount-iso', 'mount-vhd', 'mount-windows',
        'clear-answer', 'marker-bound', 'topology:False:False', 'topology:True:True',
        'resolve-recovery-vm',
        'receipt:elevated_runner_child_timeout', 'receipt:elevated_runner_child_failure',
      ]));
      expect(calls.filter(value => value === 'dismount-vhd')).toHaveLength(4);
      expect(calls.filter(value => value === 'mount-windows')).toHaveLength(1);
      expect(calls.filter(value => value === 'clear-answer')).toHaveLength(1);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('re-registers only the canonical existing VM configuration during recovery', () => {
    // Short-name-TEMP-alias root cause -- see publish-harness.mjs's TEST_FIXES comment for
    // evidence1-codex-pilot-describe.test.js. This test already only runs on win32.
    mkdirSync('C:/kmp-eval/scratch', { recursive: true });
    const fixture = mkdtempSync(resolve('C:/kmp-eval/scratch', 'e1-offline-reregister-'));
    try {
      const vmRoot = resolve(fixture, 'vm-root');
      const config = resolve(vmRoot, 'Evidence1-Runner-E2E/Evidence1-Runner-E2E/Virtual Machines/11111111-1111-1111-1111-111111111111.vmcx');
      mkdirSync(resolve(config, '..'), { recursive: true });
      writeFileSync(config, 'fixture');
      const script = `${extractFunctions}
$script:getCalls=0;$script:imported=$null
function Get-VM { param($Id,$ErrorAction);$script:getCalls++;if($script:getCalls -eq 1){throw 'provider-missing-registration'};[pscustomobject]@{Name='Evidence1-Runner-E2E';State='Off';Id='11111111-1111-1111-1111-111111111111'} }
function Import-VM { param($Path,[switch]$Register,$ErrorAction);$script:imported=[pscustomobject]@{path=$Path;register=[bool]$Register};[pscustomobject]@{Name='Evidence1-Runner-E2E';State='Off';Id='11111111-1111-1111-1111-111111111111'} }
$profile=[pscustomobject]@{vm=[pscustomobject]@{name='Evidence1-Runner-E2E';root=$env:E1_VM_ROOT}}
$result=Get-E1OfflineRecoveryVm $profile '11111111-1111-1111-1111-111111111111'
[pscustomobject]@{name=$result.vm.Name;id=[string]$result.vm.Id;registration_repaired=$result.registration_repaired;imported=$script:imported;get_calls=$script:getCalls}|ConvertTo-Json -Depth 5 -Compress
`;
      const result = powershell(script, { E1_SOURCE: sourcePath, E1_FUNCTIONS: 'Get-E1OfflineRecoveryVm', E1_VM_ROOT: vmRoot });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        name: 'Evidence1-Runner-E2E',
        id: '11111111-1111-1111-1111-111111111111',
        registration_repaired: true,
        get_calls: 2,
        imported: { register: true },
      });
      expect(output.imported.path).toBe(config);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it('binds the preflight, one start, recovery, confinement, and privacy invariants in source', () => {
    const source = read(sourcePath);
    const wrapper = read(wrapperPath);
    const snapshotContract = read(snapshotContractPath);
    const creator = read(resolve(root, 'tools/evidence1/provisioning/evidence1-windows-vm.ps1'));
    const marker = source.indexOf('Write-E1OfflineApplyMarkerAtomically $markerPath');
    const start = source.indexOf('Start-VM -VM $vm');
    expect(marker).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(marker);
    expect(source.indexOf('$mutationPerformed = $true')).toBeLessThan(source.indexOf('Invoke-E1OfflineDiskInitialization $disk $layout $mountRoot'));
    expect(source.match(/Start-VM -VM \$vm/g)).toHaveLength(1);
    expect(source).toContain("$rawDisk.PartitionStyle -cne 'RAW'");
    expect(source).toContain('Assert-E1CreatedInspectionReceipt');
    expect(creator).toContain("if ($vhdPartitionStyle -cne 'RAW') { $drift += 'vhd_partition_style' }");
    expect(creator).toContain('vhd_partition_style = $vhdPartitionStyle');
    expect(source).toContain("$Receipt.vhd_partition_style -cne 'RAW'");
    expect(source).toContain("$network[0].SwitchName");
    expect(source).toContain("firmware_first_boot = 'vhd'");
    expect(source).toContain("dism_progress_percent = $null; dism_progress_reason = 'provider_metric_not_exposed'");
    expect(source).toContain('Clear-E1OfflineAnswerState');
    expect(source).toContain('recovery_partition_readback = $script:E1OfflineRecoveryPartitionReadback');
    expect(source).toContain('unexpected_access_path_count = $unexpectedAccessPaths.Count');
    expect(source).not.toContain('@($partition.AccessPaths).Count -ne 0');
    expect(source).toContain("$partitions.Count -eq 0 -and [string]$disk.PartitionStyle -in @('RAW','GPT')");
    expect(source).toContain("throw 'offline_answer_file_cleanup_failed'");
    expect(source).toContain("throw 'offline_registry_hive_missing'");
    expect(source).toContain('Dismount-DiskImage');
    expect(source).toContain('Dismount-VHD');
    expect(source).toContain('Assert-E1OfflineVmTopology $final');
    expect(source).toContain('[bool]$finalHostIso.Attached');
    expect(source).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|auth\.json|transcript/i);
    expect(wrapper).toContain("Assert-PathInside $InputLockPath 'C:\\kmp-eval\\scratch\\'");
    expect(wrapper).toContain('Resolve-E1HostTrustedRuntime');
    expect(snapshotContract).toContain('canonical_host_source_trusted_file_dirty');
    expect(snapshotContract).toContain('canonical_host_snapshot_runtime_hash_mismatch');
    expect(wrapper).toContain('if (-not $RecoveryOnly -and (Test-Path -LiteralPath $receiptFull))');
  });

  it('allowlists supervised recovery and redacts authorization values from runner logs', () => {
    const runner = read(runnerPath);
    expect(runner).toContain("'evidence1-host-apply-canonical-windows-offline.ps1'");
    expect(runner).toContain('Get-E1RedactedDisplayArguments');
    expect(runner).toContain('[REDACTED_AUTHORIZATION]');
    expect(runner).toContain('Invoke-UnattendedRecovery');
    expect(runner).toContain("'elevated_runner_child_timeout'");
  });

  it.skipIf(process.platform !== 'win32')('redacts separate and inline authorization values behaviorally', () => {
    const script = String.raw`
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:E1_RUNNER,[ref]$tokens,[ref]$errors)
$definition=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-E1RedactedDisplayArguments'},$true))
if($errors.Count -or $definition.Count -ne 1){exit 2}
. ([scriptblock]::Create($definition[0].Extent.Text))
$first=@(Get-E1RedactedDisplayArguments @('-AuthorizationPhrase','secret one','-InputLockPath','safe')) -join '|'
$second=@(Get-E1RedactedDisplayArguments @('/AuthorizationPhrase:secret-two','-Mode','Apply')) -join '|'
$third=@(Get-E1RedactedDisplayArguments @('-CreateAuthorizationPhrase','secret-three','-RetryAuthorizationPhrase=secret-four')) -join '|'
@($first,$second,$third)|ConvertTo-Json -Compress
`;
    const result = powershell(script, { E1_RUNNER: runnerPath });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const values = JSON.parse(result.stdout);
    expect(values).toEqual([
      '-AuthorizationPhrase|[REDACTED_AUTHORIZATION]|-InputLockPath|safe',
      '/AuthorizationPhrase:[REDACTED_AUTHORIZATION]|-Mode|Apply',
      '-CreateAuthorizationPhrase|[REDACTED_AUTHORIZATION]|-RetryAuthorizationPhrase=[REDACTED_AUTHORIZATION]',
    ]);
    expect(result.stdout).not.toMatch(/secret one|secret-two|secret-three|secret-four/);
  });

  it.skipIf(process.platform !== 'win32')('parses all canonical scripts under Windows PowerShell 5.1', () => {
    const script = String.raw`
$bad=$false
foreach($file in @($env:E1_SOURCE,$env:E1_WRAPPER,$env:E1_RUNNER)){
  $tokens=$null;$errors=$null
  [void][Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
  if($errors.Count){$bad=$true;$errors|ForEach-Object{Write-Error ($file+': '+$_.Message)}}
}
if($bad){exit 1}
`;
    const result = powershell(script, { E1_SOURCE: sourcePath, E1_WRAPPER: wrapperPath, E1_RUNNER: runnerPath });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });
});
